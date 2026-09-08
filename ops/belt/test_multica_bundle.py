import importlib.util
import os
import pathlib
import unittest
from unittest import mock

HELPER = pathlib.Path(__file__).with_name('multica-bundle.py')
SPEC = importlib.util.spec_from_file_location('multica_bundle', HELPER)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ServiceIdentityTests(unittest.TestCase):
    def test_reexec_sources_env_and_preserves_original_args(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
             mock.patch.object(MODULE.pwd, 'getpwuid', return_value=mock.Mock(pw_name='root')), \
             mock.patch.object(MODULE.os, 'execv') as execv, \
             mock.patch.object(MODULE.sys, 'argv', [str(HELPER), '--mega', '42', '--apply']):
            MODULE.ensure_service_identity()
        argv = execv.call_args.args[1]
        self.assertEqual(argv[:4], ['sudo', '-n', '/bin/bash', '-c'])
        command = argv[4]
        self.assertIn('source /etc/gsp/multica/gsp-multica-bridge.env', command)
        self.assertIn('exec /usr/sbin/runuser -u gsp-multica --preserve-environment --', command)
        self.assertIn('"$@"', command)
        self.assertEqual(argv[6:], ['--mega', '42', '--apply'])

    def test_existing_credentials_do_not_reexec(self):
        with mock.patch.dict(os.environ, {
                'MULTICA_POSTGRES_USER': 'u', 'MULTICA_POSTGRES_PASSWORD': 'secret',
                'MULTICA_POSTGRES_DB': 'd'}), mock.patch.object(MODULE.os, 'execv') as execv:
            MODULE.ensure_service_identity()
        execv.assert_not_called()


class LegacyUnbundleTests(unittest.TestCase):
    def run_main(self, argv, responses):
        calls = []
        def fake_q(sql, rows=True):
            calls.append((sql, rows))
            return responses.pop(0)
        with mock.patch.object(MODULE, 'q', side_effect=fake_q), \
             mock.patch.object(MODULE, 'ensure_service_identity'), \
             mock.patch.object(MODULE.sys, 'argv', argv):
            return calls, MODULE.main()

    def test_preview_requires_exact_legacy_provenance_and_does_not_write(self):
        calls, _ = self.run_main(['helper', '--unbundle', '2169', '--from-mega', '2536'],
                                 ['', 'source-id|mega-id|2536'])
        self.assertEqual(len(calls), 2)
        self.assertFalse(any(not rows for _, rows in calls))
        self.assertIn("gsp:' || c.number::text", calls[1][0])

    def test_apply_uses_update_only_after_verified_legacy_row(self):
        calls, _ = self.run_main(['helper', '--unbundle', '2169', '--from-mega', '2536', '--apply'],
                                 ['', 'source-id|mega-id|2536', ''])
        self.assertEqual(len(calls), 3)
        sql, rows = calls[2]
        self.assertFalse(rows)
        self.assertIn("status='Registered'", sql)
        self.assertIn('unbundled_from', sql)

    def test_unverified_legacy_provenance_fails_closed(self):
        with self.assertRaises(SystemExit):
            self.run_main(['helper', '--unbundle', '2169', '--from-mega', '2536'], ['', ''])

    def test_service_identity_does_not_reexec_without_credentials(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
             mock.patch.object(MODULE.pwd, 'getpwuid', return_value=mock.Mock(pw_name='gsp-multica')), \
             mock.patch.object(MODULE.os, 'execv') as execv:
            MODULE.ensure_service_identity()
        execv.assert_not_called()


if __name__ == '__main__':
    unittest.main()
