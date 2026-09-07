#!/usr/bin/env python3
"""Regression suite for multica-bundle.

The bundler folds a source ticket into its MEGA and then archives the source,
so anything the fold drops becomes invisible. Bundling on 2026-09-07 copied
title, body and body hash but never read the pull-request tables: 122 sources
of live MEGAs held an issue_pull_request row and the MEGAs cited almost none of
them, orphaning ~123 in-flight pull requests behind archived tickets. These
tests fix that contract: a source carrying a linked pull request must not be
able to produce a MEGA body that lacks the reference.

Hermetic -- no database, no network. Run: python3 ops/belt/multica-bundle.test.py
"""
import importlib.util, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('multica_bundle',
                                              os.path.join(HERE, 'multica-bundle.py'))
mb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mb)


def child(**kw):
    c = {'id': 'c-1', 'number': 2390, 'title': 'Radio say unavailable: missing mumble-say.sh',
         'descr': 'sk radio say fails because mumble-say.sh is absent.',
         'ac': [], 'meta': {}, 'comments': [], 'prs': []}
    c.update(kw)
    return c


OPEN_PR = {'repo_owner': 'timrecursify', 'repo_name': 'sk-cli', 'pr_number': 1686,
           'state': 'open', 'html_url': 'https://github.com/timrecursify/sk-cli/pull/1686',
           'merged_at': None, 'pr_created_at': '2026-09-06T22:00:00+00:00',
           'verdict': None, 'verdict_at': None}


class PullRequestTrail(unittest.TestCase):
    def test_mega_body_carries_the_pr_of_a_linked_source(self):
        """The contract. Fails against any bundler that does not read issue_pull_request."""
        body = mb.mega_body('# MEGA: radio delivery', [child(prs=[OPEN_PR])])
        self.assertIn('sk-cli#1686', body)
        self.assertIn('https://github.com/timrecursify/sk-cli/pull/1686', body)

    def test_pr_state_is_stated(self):
        body = mb.mega_body('# MEGA', [child(prs=[OPEN_PR])])
        self.assertIn('state: **open**', body)

    def test_merged_pr_is_labelled_merged_with_its_date(self):
        pr = dict(OPEN_PR, state='closed', merged_at='2026-09-07T01:34:17+00:00')
        body = mb.mega_body('# MEGA', [child(prs=[pr])])
        self.assertIn('state: **merged**', body)
        self.assertIn('merged 2026-09-07T01:34Z', body)

    def test_qc_verdict_is_reported_beside_the_state(self):
        """Merged is not accepted: 4 of 9 merged PRs in the 2026-09-07 bundle took a QC FAIL
        after the merge, so the verdict has to travel with the link."""
        pr = dict(OPEN_PR, merged_at='2026-09-07T01:34:17+00:00',
                  verdict='FAIL', verdict_at='2026-09-07T03:36:44+00:00')
        body = mb.mega_body('# MEGA', [child(prs=[pr])])
        self.assertIn('QC FAIL', body)
        self.assertIn('2026-09-07T03:36Z', body)

    def test_missing_verdict_is_stated_not_omitted(self):
        body = mb.mega_body('# MEGA', [child(prs=[OPEN_PR])])
        self.assertIn('QC verdict: none recorded', body)

    def test_several_prs_all_survive(self):
        second = dict(OPEN_PR, pr_number=1550, repo_name='sk-cli',
                      html_url='https://github.com/timrecursify/sk-cli/pull/1550',
                      pr_created_at='2026-09-04T10:00:00+00:00')
        body = mb.mega_body('# MEGA', [child(prs=[OPEN_PR, second])])
        self.assertIn('sk-cli#1686', body)
        self.assertIn('sk-cli#1550', body)

    def test_source_without_a_pr_gets_no_pr_section(self):
        body = mb.mega_body('# MEGA', [child(prs=[])])
        self.assertNotIn('Pull requests already open', body)

    def test_child_body_and_title_still_survive(self):
        """The fold must not regress what it already preserved."""
        body = mb.mega_body('# MEGA', [child(prs=[OPEN_PR], ac=['radio say returns 0'])])
        self.assertIn('mumble-say.sh is absent', body)
        self.assertIn('Radio say unavailable', body)
        self.assertIn('radio say returns 0', body)

    def test_archive_gate_covers_the_pr_trail(self):
        """A child is archived only when child_block(c) reads back out of the MEGA.
        The PR list must be inside that block, or the trail is written without being proven."""
        c = child(prs=[OPEN_PR])
        self.assertIn('sk-cli#1686', mb.child_block(c))

    def test_fetch_query_reads_both_pull_request_link_tables(self):
        """Guards the SQL itself: the 2026-09-07 bundler had zero references to these tables."""
        with open(os.path.join(HERE, 'multica-bundle.py')) as fh:
            src = fh.read()
        for table in ('issue_pull_request', 'github_pull_request',
                      'issue_vcs_pull_request', 'vcs_pull_request', 'qc_verdict'):
            self.assertIn(table, src, '%s is never read; the PR trail cannot be copied' % table)


if __name__ == '__main__':
    unittest.main(verbosity=2)
