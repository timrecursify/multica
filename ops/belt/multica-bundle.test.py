#!/usr/bin/env python3
"""Focused tests for the bundle helper's database boundary."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).with_name('multica-bundle.py')
SPEC = importlib.util.spec_from_file_location('multica_bundle', MODULE_PATH)
BUNDLE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUNDLE)


class DatabaseBoundaryTest(unittest.TestCase):
    def test_q_uses_child_environment_and_keeps_secret_out_of_argv(self):
        dotenv = 'DATABASE_URL=postgresql://dbuser:fake-secret@localhost:25432/dbname?sslmode=disable\n'
        completed = subprocess.CompletedProcess([], 0, stdout='1\n', stderr='')
        with mock.patch.dict(os.environ, {'GSP_BELT_SECRETS_ENV_FILE': '/test/db.env'},
                             clear=True), \
                mock.patch('builtins.open', mock.mock_open(read_data=dotenv)), \
                mock.patch.object(BUNDLE.subprocess, 'run', return_value=completed) as run:
            self.assertEqual(BUNDLE.q('SELECT 1'), '1\n')

        args = run.call_args.args[0]
        child_env = run.call_args.kwargs['env']
        self.assertEqual(args, ['/usr/bin/psql', '-X', '-w', '-At', '-f', '-'])
        self.assertNotIn('fake-secret', ' '.join(args))
        self.assertNotIn('DATABASE_URL', child_env)
        self.assertEqual(child_env['PGPASSWORD'], 'fake-secret')
        self.assertEqual(child_env['PGPORT'], '25432')
        self.assertEqual(run.call_args.kwargs['input'], 'SELECT 1')

    def test_process_database_url_takes_precedence_over_file(self):
        url = 'postgres://dbuser:fake-secret@127.0.0.1:25432/dbname'
        with mock.patch.dict(os.environ, {'DATABASE_URL': url}, clear=True), \
                mock.patch('builtins.open') as open_file:
            child_env = BUNDLE.postgres_env()

        open_file.assert_not_called()
        self.assertEqual(child_env['PGHOST'], '127.0.0.1')
        self.assertEqual(child_env['PGUSER'], 'dbuser')
        self.assertNotIn('DATABASE_URL', child_env)

    def test_missing_password_fails_without_echoing_url(self):
        url = 'postgresql://dbuser@localhost:25432/dbname'
        with mock.patch.dict(os.environ, {'DATABASE_URL': url}, clear=True):
            with self.assertRaisesRegex(RuntimeError, '^DATABASE_URL is incomplete$'):
                BUNDLE.postgres_env()

    def test_readback_mismatch_never_archives_child(self):
        child = {'id': 'child-id', 'number': 9, 'title': 'child', 'descr': 'work',
                 'ac': [], 'meta': {}, 'comments': []}
        mega = {'mega_id': 'mega-id', 'mega_number': 8, 'mega_descr': 'base',
                'kids': [child]}
        with mock.patch.object(BUNDLE, 'fetch', return_value=[mega]), \
                mock.patch.object(BUNDLE, 'q', side_effect=['', json.dumps('mismatch')]) as query, \
                mock.patch.object(sys, 'argv', ['multica-bundle.py', '--apply']), \
                mock.patch('builtins.print') as output:
            BUNDLE.main()

        self.assertEqual(query.call_count, 2)
        rendered = [' '.join(str(value) for value in call.args)
                    for call in output.call_args_list]
        self.assertTrue(any('description read-back mismatch' in line for line in rendered))
        self.assertTrue(any('children_archived=0' in line for line in rendered))


if __name__ == '__main__':
    unittest.main()
