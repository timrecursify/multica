#!/usr/bin/env python3
"""multica-bundle — fold bundled children into their MEGA, then hide them.

A bundled child is not a unit of work: its MEGA parent carries the fix. But a
child holds the actual report -- description, acceptance criteria, and the
reporter's comments -- while the MEGA historically carried only a list of bare
numbers (see MEGA #643). Archiving a child in that state destroys the work;
leaving it open gives a worker two competing canonical tickets. Neither is
acceptable, so the content moves first and the archive is conditional on proof
that it moved.

The proof is an exact comparison against the MEGA description that was actually
read back from the database after the write. Children are archived only when
the complete value matches. Nothing is deleted: the child keeps its row, its
thread and its number, takes the terminal
'Archived' status the archiver already uses, and records where it went in
metadata.bundled_into so the move is reversible.

Idempotent: a child already folded in with an unchanged content hash is skipped,
so a crashed or re-run scoper never doubles a MEGA description.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import urllib.parse

# Existing belt services use this root:gsp-multica environment file.
DATABASE_ENV_FILE = '/etc/gsp/multica/remote-bridge.env'
PSQL = ['/usr/bin/psql', '-X', '-w']
MARK = '## Bundled work (this MEGA is the only unit of work)'
PREAMBLE = (
    'Each section below is a ticket folded into this MEGA. Those tickets are\n'
    'archived and invisible to workers; their work is carried entirely here.\n'
    'Deliver every section as one change set against one shared root cause.\n')


def database_url():
    value = os.environ.get('DATABASE_URL')
    if value:
        return value
    path = os.environ.get('GSP_BELT_SECRETS_ENV_FILE', DATABASE_ENV_FILE)
    try:
        with open(path, encoding='utf-8') as env_file:
            for raw_line in env_file:
                if raw_line.startswith('DATABASE_URL='):
                    value = raw_line.split('=', 1)[1].strip()
                    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                        value = value[1:-1]
                    if value:
                        return value
    except OSError as exc:
        raise RuntimeError('database environment is not readable') from exc
    raise RuntimeError('DATABASE_URL is missing from the database environment')


def postgres_env():
    try:
        parsed = urllib.parse.urlsplit(database_url())
        port = parsed.port or 5432
        user = urllib.parse.unquote(parsed.username or '')
        password = urllib.parse.unquote(parsed.password or '')
        database = urllib.parse.unquote(parsed.path.lstrip('/'))
    except ValueError as exc:
        raise RuntimeError('DATABASE_URL is invalid') from exc
    if parsed.scheme not in ('postgres', 'postgresql') or not all(
            (parsed.hostname, user, password, database)):
        raise RuntimeError('DATABASE_URL is incomplete')
    child_env = os.environ.copy()
    for key in ('DATABASE_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER',
                'PGPASSWORD', 'PGPASSFILE', 'PGSERVICE', 'PGSERVICEFILE', 'PGSSLMODE'):
        child_env.pop(key, None)
    child_env.update(PGHOST=parsed.hostname, PGPORT=str(port), PGDATABASE=database,
                     PGUSER=user, PGPASSWORD=password)
    sslmode = urllib.parse.parse_qs(parsed.query).get('sslmode', [])
    if sslmode:
        child_env['PGSSLMODE'] = sslmode[0]
    return child_env


def q(sql, rows=True):
    # SQL goes in on stdin, never as argv: a folded MEGA description reaches
    # six figures of bytes and `-c` died with E2BIG (Argument list too long).
    try:
        env = postgres_env()
    except RuntimeError as exc:
        sys.exit('psql configuration failed: ' + str(exc))
    args = PSQL + (['-At', '-f', '-'] if rows else ['-q', '-f', '-'])
    r = subprocess.run(args, input=sql, capture_output=True, text=True, env=env)
    if r.returncode:
        sys.exit('psql failed: ' + r.stderr.strip()[:400])
    return r.stdout


def lit(s):
    return '$mbq$' + (s or '') + '$mbq$'


def child_block(c):
    """The child's full content. This text is what the archive is conditional on."""
    out = ['### #%s — %s' % (c['number'], (c['title'] or '').strip())]
    d = (c['descr'] or '').strip()
    out.append(d if d else '_(no description on the source ticket)_')
    ac = c.get('ac') or []
    if isinstance(ac, list) and ac:
        out.append('**Acceptance criteria**')
        out += ['- ' + (a if isinstance(a, str) else json.dumps(a)) for a in ac]
    # The child's thread is deliberately NOT copied. On the live board the
    # comments are agent build/QC transcripts and outweigh the actual report
    # 20:1 (MEGA #23697: 393KB of comments against 19KB of description), which
    # would hand every builder a six-figure-byte prompt to restate work it is
    # about to redo. Archiving preserves the child row, its number and its
    # thread, and metadata.bundled_into links both ways, so the transcript
    # stays one lookup away instead of being duplicated into the paid context.
    n = len(c.get('comments') or [])
    if n:
        out.append('_Source thread: #%s (%d comment%s), preserved on the archived ticket._'
                   % (c['number'], n, '' if n == 1 else 's'))
    return '\n\n'.join(out)


def fetch(mega_filter):
    return json.loads(q("""
SELECT coalesce(json_agg(m),'[]') FROM (
  SELECT p.id AS mega_id, p.number AS mega_number, p.description AS mega_descr,
    (SELECT json_agg(k ORDER BY k->>'number')
       FROM (SELECT json_build_object(
               'id', c.id, 'number', c.number, 'title', c.title,
               'descr', c.description, 'ac', c.acceptance_criteria,
               'meta', c.metadata,
               'comments', (SELECT json_agg(cm.content ORDER BY cm.created_at)
                              FROM comment cm WHERE cm.issue_id = c.id)) AS k
               FROM issue c
              WHERE c.parent_issue_id = p.id
                AND c.title NOT LIKE 'MEGA%%'
                AND c.status NOT IN ('Archived','Cancelled')) s) AS kids
  FROM issue p
  WHERE p.title LIKE 'MEGA%%' AND p.status NOT IN ('Done','Cancelled','Archived')
    %s
) m WHERE m.kids IS NOT NULL;""" % mega_filter).strip())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mega', help='restrict to one MEGA issue number')
    ap.add_argument('--apply', action='store_true', help='write and archive')
    ap.add_argument('--unbundle', metavar='CHILD',
                    help='restore one folded ticket to Registered and detach it')
    a = ap.parse_args()

    # Splitting an over-broad mega needs its members back as real tickets. The
    # fold is reversible precisely so a scoper can regroup by root cause instead
    # of being stuck with whatever cluster created the mega.
    if a.unbundle:
        row = q("SELECT id, metadata->>'bundled_into' FROM issue WHERE number = %d"
                " AND metadata->>'bundled_by' = 'multica-bundle'" % int(a.unbundle)).strip()
        if not row:
            sys.exit('#%s is not a folded ticket' % a.unbundle)
        iid, mega = row.split('|')
        if not a.apply:
            print('DRY unbundle #%s from MEGA #%s' % (a.unbundle, mega)); return
        q("UPDATE issue SET status='Registered', parent_issue_id=NULL, "
          "metadata = (coalesce(metadata,'{}'::jsonb) - 'bundled_into' - 'bundled_into_id' "
          "- 'content_md5' - 'bundled_by') || '{\"unbundled_from\": \"%s\"}'::jsonb, "
          "updated_at=now() WHERE id='%s'" % (mega, iid), rows=False)
        print('unbundled #%s from MEGA #%s -> Registered' % (a.unbundle, mega))
        return

    megas = fetch("AND p.number = %d" % int(a.mega) if a.mega else "")

    folded = archived = skipped = blocked = 0
    for m in megas:
        base = (m['mega_descr'] or '')
        # Drop the earlier stopgap manifest: it listed titles only, and leaving
        # it beside the real content gives the builder two lists to reconcile.
        if '## Bundled tickets' in base:
            base = base.split('## Bundled tickets')[0]
        base = base.split(MARK)[0].rstrip()

        blocks, todo = [], []
        for c in m['kids']:
            h = hashlib.md5(child_block(c).encode()).hexdigest()
            meta = c.get('meta') or {}
            if meta.get('bundled_into') == m['mega_number'] and meta.get('content_md5') == h:
                skipped += 1
                continue
            blocks.append(child_block(c))
            todo.append((c, h))
        if not todo:
            continue

        # Re-fold every live child, not only the new ones: the description is
        # rebuilt from base each run, so a partial list would drop the rest.
        allblocks = [child_block(c) for c in m['kids']]
        newd = base + '\n\n' + MARK + '\n' + PREAMBLE + '\n' + '\n\n'.join(allblocks) + '\n'
        if not a.apply:
            print('DRY mega #%s children=%d bytes=%d' % (m['mega_number'], len(m['kids']), len(newd)))
            continue

        q("UPDATE issue SET description=%s, updated_at=now() WHERE id='%s'"
          % (lit(newd), m['mega_id']), rows=False)
        # Read back what the database actually holds. A write that silently
        # truncated must not be allowed to authorise an archive.
        live = json.loads(q("SELECT to_json(description) FROM issue WHERE id='%s'"
                            % m['mega_id']))
        if live != newd:
            print('BLOCKED MEGA #%s: description read-back mismatch after write'
                  % m['mega_number'])
            blocked += len(todo)
            continue
        folded += 1

        for c, h in todo:
            prov = json.dumps({'bundled_into': m['mega_number'],
                               'bundled_into_id': m['mega_id'],
                               'content_md5': h, 'bundled_by': 'multica-bundle'})
            q("UPDATE issue SET status='Archived', "
              "metadata = coalesce(metadata,'{}'::jsonb) || %s::jsonb, updated_at=now() "
              "WHERE id='%s'" % (lit(prov), c['id']), rows=False)
            archived += 1

    print('megas_folded=%d children_archived=%d skipped_idempotent=%d blocked=%d'
          % (folded, archived, skipped, blocked))


if __name__ == '__main__':
    main()
