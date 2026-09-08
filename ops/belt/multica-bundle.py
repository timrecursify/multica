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
actually read back from the API after the write. A child is archived only
when its own content is demonstrably present in its parent. Nothing is deleted:
the child keeps its row, its thread and its number, takes the terminal
'Archived' status the archiver already uses, and records where it went in
metadata.bundled_into so the move is reversible.

Idempotent: a child already folded in with an unchanged content hash is skipped,
so a crashed or re-run scoper never doubles a MEGA description.
"""
import argparse, hashlib, json, os, sys, urllib.error, urllib.parse, urllib.request

MARK = '## Bundled work (this MEGA is the only unit of work)'
PREAMBLE = (
    'Each section below is a ticket folded into this MEGA. Those tickets are\n'
    'archived and invisible to workers; their work is carried entirely here.\n'
    'Deliver every section as one change set against one shared root cause.\n')


class API:
    def __init__(self):
        missing = [n for n in ('MULTICA_SERVER_URL', 'MULTICA_TOKEN') if not os.environ.get(n)]
        if missing:
            sys.exit('missing required environment variable: ' + ', '.join(missing))
        base = os.environ['MULTICA_SERVER_URL'].rstrip('/')
        if base.startswith('ws://'):
            base = 'http://' + base[5:]
        elif base.startswith('wss://'):
            base = 'https://' + base[6:]
        self.base = base[:-3] if base.endswith('/ws') else base
        self.token = os.environ['MULTICA_TOKEN']

    def request(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method,
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors='replace').strip()
            sys.exit('Multica API %s %s failed: HTTP %d: %s' %
                     (method, path, exc.code, detail[:400]))
        except urllib.error.URLError as exc:
            sys.exit('Multica API %s %s failed: %s' % (method, path, exc.reason))

    def get(self, path): return self.request('GET', path)
    def put(self, path, body): return self.request('PUT', path, body)
    def delete(self, path): return self.request('DELETE', path)


def issue_path(issue_id, suffix=''):
    return '/api/issues/' + urllib.parse.quote(str(issue_id), safe='') + suffix


def resolve_number(api, number):
    response = api.get('/api/issues/?number=' + urllib.parse.quote(str(number), safe=''))
    issues = response.get('issues', [])
    if len(issues) != 1:
        sys.exit('#%s was not found in the task token workspace' % number)
    return issues[0]['id']


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


def load_child(api, issue):
    iid = issue['id']
    prs = []
    for source in api.get(issue_path(iid, '/pull-requests')).get('pull_requests', []):
        p = dict(source)
        p.update(pr_number=p.get('number'), verdict=p.get('qc_verdict'),
                 verdict_at=p.get('qc_verdict_created_at'))
        prs.append(p)
    return {'id': iid, 'number': issue['number'], 'title': issue.get('title'),
            'descr': issue.get('description'), 'ac': issue.get('acceptance_criteria') or [],
            'meta': issue.get('metadata') or {},
            'comments': api.get(issue_path(iid, '/comments')) or [], 'prs': prs}


def fetch(api, mega_number):
    if mega_number is None:
        response = api.get('/api/issues/?open_only=true')
        candidates = [row['id'] for row in response.get('issues', [])
                      if (row.get('title') or '').startswith('MEGA')]
    else:
        candidates = [resolve_number(api, mega_number)]
    megas = []
    for mega_id in candidates:
        mega = api.get(issue_path(mega_id))
        if mega.get('status') in ('Done', 'Cancelled', 'Archived'):
            continue
        children = api.get(issue_path(mega['id'], '/children')).get('issues', [])
        kids = [load_child(api, c) for c in children
                if not (c.get('title') or '').startswith('MEGA')
                and c.get('status') not in ('Archived', 'Cancelled')]
        if kids:
            megas.append({'mega_id': mega['id'], 'mega_number': mega['number'],
                          'mega_descr': mega.get('description'), 'kids': kids})
    if mega_number is not None and candidates and not (mega.get('title') or '').startswith('MEGA'):
        sys.exit('#%s is not a MEGA ticket' % mega_number)
    return megas


def set_metadata(api, issue_id, key, value):
    api.put(issue_path(issue_id, '/metadata/' + urllib.parse.quote(key, safe='')), {'value': value})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mega', help='restrict to one MEGA issue number')
    ap.add_argument('--apply', action='store_true', help='write and archive')
    ap.add_argument('--unbundle', metavar='CHILD',
                    help='restore one folded ticket to Registered and detach it')
    a = ap.parse_args()
    api = API()

    # Splitting an over-broad mega needs its members back as real tickets. The
    # fold is reversible precisely so a scoper can regroup by root cause instead
    # of being stuck with whatever cluster created the mega.
    if a.unbundle:
        child = api.get(issue_path(resolve_number(api, a.unbundle)))
        meta = child.get('metadata') or {}
        if meta.get('bundled_by') != 'multica-bundle' or not meta.get('bundled_into'):
            sys.exit('#%s is not a folded ticket' % a.unbundle)
        iid, mega = child['id'], meta['bundled_into']
        if not a.apply:
            print('DRY unbundle #%s from MEGA #%s' % (a.unbundle, mega)); return
        api.put(issue_path(iid), {'status': 'Registered', 'parent_issue_id': None})
        for key in ('bundled_into', 'bundled_into_id', 'content_md5', 'bundled_by'):
            api.delete(issue_path(iid, '/metadata/' + key))
        set_metadata(api, iid, 'unbundled_from', str(mega))
        print('unbundled #%s from MEGA #%s -> Registered' % (a.unbundle, mega))
        return

    megas = fetch(api, int(a.mega) if a.mega else None)

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

        api.put(issue_path(m['mega_id']), {'description': newd})
        # Read back what the API actually holds. A write that silently
        # truncated must not be allowed to authorise an archive.
        live = api.get(issue_path(m['mega_id'])).get('description') or ''
        folded += 1

        for c, h in todo:
            blk = child_block(c)
            if blk not in live:
                print('BLOCKED #%s: content not present in MEGA #%s after write'
                      % (c['number'], m['mega_number']))
                blocked += 1
                continue
            for key, value in {'bundled_into': m['mega_number'],
                               'bundled_into_id': m['mega_id'],
                               'content_md5': h, 'bundled_by': 'multica-bundle'}.items():
                set_metadata(api, c['id'], key, value)
            # Provenance is written first: if archiving fails, the child stays
            # visible and a rerun safely repeats the idempotent metadata writes.
            api.put(issue_path(c['id']), {'status': 'Archived'})
            archived += 1

    print('megas_folded=%d children_archived=%d skipped_idempotent=%d blocked=%d'
          % (folded, archived, skipped, blocked))


if __name__ == '__main__':
    main()
