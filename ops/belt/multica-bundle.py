#!/usr/bin/env python3
"""multica-bundle — fold bundled children into their MEGA, then hide them.

A bundled child is not a unit of work: its MEGA parent carries the fix. But a
child holds the actual report -- description, acceptance criteria, and the
reporter's comments -- while the MEGA historically carried only a list of bare
numbers (see MEGA #643). Archiving a child in that state destroys the work;
leaving it open gives a worker two competing canonical tickets. Neither is
acceptable, so the content moves first and the archive is conditional on proof
that it moved.

The proof is a substring check per child against the MEGA description that was
actually read back from the database after the write. A child is archived only
when its own content is demonstrably present in its parent. Nothing is deleted:
the child keeps its row, its thread and its number, takes the terminal
'Archived' status the archiver already uses, and records where it went in
metadata.bundled_into so the move is reversible.

Idempotent: a child already folded in with an unchanged content hash is skipped,
so a crashed or re-run scoper never doubles a MEGA description.
"""
import argparse, hashlib, json, os, pwd, shlex, subprocess, sys

DSN = ['/usr/bin/psql', '-h', '127.0.0.1', '-p', '25432']
GSP_WORKSPACE_ID = 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f'
MARK = '## Bundled work (this MEGA is the only unit of work)'
PREAMBLE = (
    'Each section below is a ticket folded into this MEGA. Those tickets are\n'
    'archived and invisible to workers; their work is carried entirely here.\n'
    'Deliver every section as one change set against one shared root cause.\n')
ENV_FILE = '/etc/gsp/multica/gsp-multica-bridge.env'
SERVICE_USER = 'gsp-multica'
REQUIRED_DB_ENV = ('MULTICA_POSTGRES_USER', 'MULTICA_POSTGRES_PASSWORD',
                   'MULTICA_POSTGRES_DB')


def ensure_service_identity():
    """Re-enter root invocations as the bridge account before using credentials.

    The bridge environment file is readable only through the existing, audited
    sudo shell path.  Keep credentials out of argv and avoid recursion after
    the service account has been selected.
    """
    euid = os.geteuid()
    if euid != 0:
        if pwd.getpwuid(euid).pw_name == SERVICE_USER:
            return
        if all(os.environ.get(name) for name in REQUIRED_DB_ENV):
            return

    helper = os.path.abspath(__file__)
    command = (
        'set -a; source ' + shlex.quote(ENV_FILE) + '; set +a' +
        '; exec /usr/sbin/runuser -u ' + SERVICE_USER +
        ' --preserve-environment -- /usr/bin/python3 ' + shlex.quote(helper) + ' "$@"'
    )
    # bash -c receives the helper arguments after a harmless $0 placeholder.
    os.execv('/usr/bin/sudo', ['sudo', '-n', '/bin/bash', '-c', command,
                               'multica-bundle', *sys.argv[1:]])


def q(sql, rows=True):
    # SQL goes in on stdin, never as argv: a folded MEGA description reaches
    # six figures of bytes and `-c` died with E2BIG (Argument list too long).
    missing = [name for name in ('MULTICA_POSTGRES_USER',
                                 'MULTICA_POSTGRES_PASSWORD',
                                 'MULTICA_POSTGRES_DB') if not os.environ.get(name)]
    if missing:
        sys.exit('missing required environment variable: ' + ', '.join(missing))
    env = os.environ.copy()
    env['PGPASSWORD'] = env['MULTICA_POSTGRES_PASSWORD']
    dsn = DSN + ['-U', env['MULTICA_POSTGRES_USER'], '-d', env['MULTICA_POSTGRES_DB']]
    r = subprocess.run(dsn + ['-v', 'ON_ERROR_STOP=1'] +
                       (['-At', '-f', '-'] if rows else ['-q', '-f', '-']),
                       input=sql, capture_output=True, text=True, env=env)
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
    # A child's open pull requests are the single most expensive thing to lose:
    # archiving the child hides the only link between the requirement and the
    # branch that already implements it, so the next builder reimplements work
    # that is sitting in review. Description text alone does not carry this --
    # the link lives in issue_pull_request, not in the body -- so it is copied
    # here explicitly and, like every other section, the archive is conditional
    # on it being readable back out of the MEGA.
    out += pr_lines(c)
    return '\n\n'.join(out)


def pr_lines(c):
    """Markdown for the child's linked pull requests, newest first. Empty when it has none."""
    prs = c.get('prs') or []
    if not prs:
        return []
    rows = ['**Pull requests already open against this requirement** '
            '(reconcile before writing new code)']
    for p in sorted(prs, key=lambda x: (x.get('pr_created_at') or ''), reverse=True):
        # 'merged' is not 'accepted': a QC FAIL recorded after the merge means
        # the requirement is still open, so the verdict is printed beside the
        # state rather than being collapsed into it.
        state = 'merged' if p.get('merged_at') else (p.get('state') or 'unknown')
        bits = ['`%s/%s#%s`' % (p.get('repo_owner'), p.get('repo_name'), p.get('pr_number')),
                'state: **%s**' % state]
        if p.get('merged_at'):
            bits.append('merged %s' % str(p['merged_at'])[:16] + 'Z')
        # qc_verdict, never qc_attempt: a PASS and its post-gate FAIL share an
        # idem_key and the FAIL is dropped by ON CONFLICT DO NOTHING, so
        # qc_attempt reports a pass for work that was later rejected.
        if p.get('verdict'):
            bits.append('QC %s (%s)' % (p['verdict'], str(p.get('verdict_at'))[:16] + 'Z'))
        else:
            bits.append('QC verdict: none recorded')
        bits.append(p.get('html_url') or '')
        rows.append('- ' + ' — '.join(b for b in bits if b))
    return ['\n'.join(rows)]


def mega_body(base, kids):
    """The MEGA description as written to the database.

    Composition is a named function so the regression suite can assert what the
    MEGA actually ends up holding -- notably that a child carrying an
    issue_pull_request row cannot produce a body without that PR reference.
    """
    return (base + '\n\n' + MARK + '\n' + PREAMBLE + '\n'
            + '\n\n'.join(child_block(c) for c in kids) + '\n')


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
                              FROM comment cm WHERE cm.issue_id = c.id),
               -- The child's PR trail. Both link tables are read: GitHub is the
               -- live provider, vcs_pull_request is the self-hosted one, and a
               -- board can hold either.
               'prs', (SELECT json_agg(pj) FROM (
                   SELECT g.repo_owner, g.repo_name, g.pr_number, g.state,
                          g.html_url, g.merged_at, g.pr_created_at,
                          v.verdict, v.created_at AS verdict_at
                     FROM issue_pull_request ipr
                     JOIN github_pull_request g ON g.id = ipr.pull_request_id
                     LEFT JOIN LATERAL (SELECT qv.verdict, qv.created_at
                                          FROM qc_verdict qv
                                         WHERE qv.issue_id = c.id
                                      ORDER BY qv.created_at DESC LIMIT 1) v ON true
                    WHERE ipr.issue_id = c.id
                   UNION ALL
                   SELECT x.repo_owner, x.repo_name, x.pr_number, x.state,
                          x.html_url, x.merged_at, x.pr_created_at,
                          v.verdict, v.created_at AS verdict_at
                     FROM issue_vcs_pull_request ivpr
                     JOIN vcs_pull_request x ON x.id = ivpr.pull_request_id
                     LEFT JOIN LATERAL (SELECT qv.verdict, qv.created_at
                                          FROM qc_verdict qv
                                         WHERE qv.issue_id = c.id
                                      ORDER BY qv.created_at DESC LIMIT 1) v ON true
                    WHERE ivpr.issue_id = c.id) pj)) AS k
               FROM issue c
              WHERE c.parent_issue_id = p.id
                AND c.workspace_id = '%s'
                AND c.title NOT LIKE 'MEGA%%'
                AND c.status NOT IN ('Archived','Cancelled')) s) AS kids
  FROM issue p
  WHERE p.title LIKE 'MEGA%%' AND p.status NOT IN ('Done','Cancelled','Archived')
    AND p.workspace_id = '%s'
    %s
) m WHERE m.kids IS NOT NULL;""" % (GSP_WORKSPACE_ID, GSP_WORKSPACE_ID, mega_filter)).strip())


def main():
    ensure_service_identity()
    ap = argparse.ArgumentParser()
    ap.add_argument('--mega', help='restrict to one MEGA issue number')
    ap.add_argument('--apply', action='store_true', help='write and archive')
    ap.add_argument('--unbundle', metavar='CHILD',
                    help='restore one folded ticket to Registered and detach it')
    ap.add_argument('--from-mega', metavar='MEGA', type=int,
                    help='required legacy provenance source for --unbundle')
    a = ap.parse_args()

    # Splitting an over-broad mega needs its members back as real tickets. The
    # fold is reversible precisely so a scoper can regroup by root cause instead
    # of being stuck with whatever cluster created the mega.
    if a.unbundle:
        row = q("SELECT id, metadata->>'bundled_into' FROM issue WHERE number = %d"
                " AND workspace_id = '%s'"
                " AND metadata->>'bundled_by' = 'multica-bundle'"
                % (int(a.unbundle), GSP_WORKSPACE_ID)).strip()
        if not row:
            if a.from_mega is None:
                sys.exit('#%s is not a folded ticket; legacy recovery requires --from-mega'
                         % a.unbundle)
            # Older bundles recorded only a gsp:<child> token in the active
            # MEGA description. Require every fact to match before recovery:
            # cancelled source, no current parent, active named MEGA, and an
            # exact token (not a substring such as gsp:21690).
            legacy = q("""
SELECT c.id, m.id, m.number
  FROM issue c
  JOIN issue m ON m.number = %d
 WHERE c.number = %d
   AND c.workspace_id = '%s'
   AND m.workspace_id = '%s'
   AND c.status = 'Cancelled'
   AND c.parent_issue_id IS NULL
   AND m.title LIKE 'MEGA%%'
   AND m.status NOT IN ('Done','Cancelled','Archived')
   AND m.description ~ ('(^|[^[:alnum:]_])gsp:' || c.number::text || '([^[:alnum:]_]|$)')
""" % (a.from_mega, int(a.unbundle), GSP_WORKSPACE_ID, GSP_WORKSPACE_ID)).strip()
            if not legacy:
                sys.exit('#%s is not a verified legacy bundle from MEGA #%s'
                         % (a.unbundle, a.from_mega))
            iid, mega_id, mega_number = legacy.split('|')
            if not a.apply:
                print('DRY legacy unbundle #%s from MEGA #%s' %
                      (a.unbundle, mega_number)); return
            # Migration 297's guard matches the canonical bridge/reconciler:
            # authority is transaction-local and must precede the status write.
            q("BEGIN; SELECT set_config('multica.relay_authorized','on',true); "
              "UPDATE issue SET status='Registered', parent_issue_id=NULL, "
              "metadata = coalesce(metadata,'{}'::jsonb) || %s::jsonb, updated_at=now() "
              "WHERE id='%s' AND workspace_id='%s'" %
              (lit(json.dumps({'unbundled_from': mega_number,
                               'unbundled_from_id': mega_id,
                               'unbundled_by': 'multica-bundle'})), iid, GSP_WORKSPACE_ID) +
              "; COMMIT;", rows=False)
            print('unbundled legacy #%s from MEGA #%s -> Registered' %
                  (a.unbundle, mega_number))
            return
        iid, mega = row.split('|')
        if not a.apply:
            print('DRY unbundle #%s from MEGA #%s' % (a.unbundle, mega)); return
        q("BEGIN; SELECT set_config('multica.relay_authorized','on',true); "
          "UPDATE issue SET status='Registered', parent_issue_id=NULL, "
          "metadata = (coalesce(metadata,'{}'::jsonb) - 'bundled_into' - 'bundled_into_id' "
          "- 'content_md5' - 'bundled_by') || '{\"unbundled_from\": \"%s\"}'::jsonb, "
          "updated_at=now() WHERE id='%s' AND workspace_id='%s'" %
          (mega, iid, GSP_WORKSPACE_ID) + "; COMMIT;", rows=False)
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
        newd = mega_body(base, m['kids'])
        if not a.apply:
            print('DRY mega #%s children=%d bytes=%d' % (m['mega_number'], len(m['kids']), len(newd)))
            continue

        q("UPDATE issue SET description=%s, updated_at=now() WHERE id='%s' AND workspace_id='%s'"
          % (lit(newd), m['mega_id'], GSP_WORKSPACE_ID), rows=False)
        # Read back what the database actually holds. A write that silently
        # truncated must not be allowed to authorise an archive.
        live = q("SELECT description FROM issue WHERE id='%s' AND workspace_id='%s'"
                 % (m['mega_id'], GSP_WORKSPACE_ID))
        folded += 1

        for c, h in todo:
            blk = child_block(c)
            if blk not in live:
                print('BLOCKED #%s: content not present in MEGA #%s after write'
                      % (c['number'], m['mega_number']))
                blocked += 1
                continue
            prov = json.dumps({'bundled_into': m['mega_number'],
                               'bundled_into_id': m['mega_id'],
                               'content_md5': h, 'bundled_by': 'multica-bundle'})
            q("BEGIN; SELECT set_config('multica.relay_authorized','on',true); "
              "UPDATE issue SET status='Archived', "
              "metadata = coalesce(metadata,'{}'::jsonb) || %s::jsonb, updated_at=now() "
              "WHERE id='%s' AND workspace_id='%s'" %
              (lit(prov), c['id'], GSP_WORKSPACE_ID) + "; COMMIT;", rows=False)
            archived += 1

    print('megas_folded=%d children_archived=%d skipped_idempotent=%d blocked=%d'
          % (folded, archived, skipped, blocked))


if __name__ == '__main__':
    main()
