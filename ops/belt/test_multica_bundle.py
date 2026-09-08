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
        self.assertIn('exec /usr/bin/sudo -n -u gsp-multica --preserve-env', command)
        self.assertIn('"$@"', command)
        self.assertEqual(argv[6:], ['--mega', '42', '--apply'])

    def test_existing_credentials_do_not_reexec(self):
        with mock.patch.dict(os.environ, {
                'MULTICA_POSTGRES_USER': 'u', 'MULTICA_POSTGRES_PASSWORD': 'secret',
                'MULTICA_POSTGRES_DB': 'd'}), mock.patch.object(MODULE.os, 'execv') as execv:
            MODULE.ensure_service_identity()
        execv.assert_not_called()

    def test_service_identity_does_not_reexec_without_credentials(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
             mock.patch.object(MODULE.pwd, 'getpwuid', return_value=mock.Mock(pw_name='gsp-multica')), \
             mock.patch.object(MODULE.os, 'execv') as execv:
            MODULE.ensure_service_identity()
        execv.assert_not_called()


if __name__ == '__main__':
    unittest.main()
