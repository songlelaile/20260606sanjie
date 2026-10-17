import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('persist', Path(__file__).with_name('persist-creative-uat-20261001.py'))
persist = importlib.util.module_from_spec(spec)
spec.loader.exec_module(persist)


class PreserveTests(unittest.TestCase):
    def setUp(self):
        self.old = {'name': 'prior-stopped', 'pm_cwd': '/prior', 'pm_exec_path': '/prior/next',
                    'status': 'stopped', 'args': ['start', '--port', '31918'], 'env': {'PORT': '31918'}, 'PORT': '31918'}
        self.live = [{'name': 'prior-stopped', 'pid': 0,
                      'pm2_env': {**self.old, 'status': 'stopped', 'instances': 1, 'pm_id': 7,
                                  'prev_restart_delay': 0}}]

    def test_serializer_keeps_stopped_entries_and_preserves_configuration(self):
        projected = persist.projection(self.live)
        self.assertEqual(projected[0]['status'], 'stopped')
        persist.require_preserved([self.old], projected)
        self.assertIn('instances', self.live[0]['pm2_env'])

    def test_missing_or_duplicate_prior_entry_fails_closed(self):
        for candidate in ([], [self.old, self.old]):
            with self.assertRaises(RuntimeError):
                persist.require_preserved([self.old], candidate)

    def test_args_environment_type_and_missing_key_are_not_normalized(self):
        for change in ({'args': ['start', '--port', '32011']}, {'env': {'PORT': 31918}},
                       {'PORT': 31918}, {'pm_cwd': '/another'}):
            modified = {**self.old, **change}
            with self.assertRaises(RuntimeError):
                persist.require_preserved([self.old], [modified])
        missing = copy.deepcopy(self.old)
        del missing['PORT']
        with self.assertRaises(RuntimeError):
            persist.require_preserved([self.old], [missing])

    def test_every_extra_configuration_field_is_compared_except_live_telemetry(self):
        for name in ('max_memory_restart', 'uid', 'gid', 'interpreter_args'):
            modified = {**self.old, name: 'changed'}
            with self.assertRaises(RuntimeError):
                persist.require_preserved([self.old], [modified])
        persist.require_preserved([{**self.old, 'axm_monitor': {'heap': 1}}],
                                  [{**self.old, 'axm_monitor': {'heap': 2}}])


if __name__ == '__main__':
    unittest.main()
