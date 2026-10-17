#!/usr/bin/env python3
"""Offline reload transition fixtures: no HTTP, database, Nginx, or PM2 calls."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('security_readiness_runner', Path(__file__).with_name('deploy-security-channel-20261002.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class Clock:
    def __init__(self):
        self.elapsed = 0.0
        self.sleeps = []
    def monotonic(self):
        return self.elapsed
    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.elapsed += seconds

class Tests(unittest.TestCase):
    def test_old_workers_transition_requires_three_consecutive_fresh_rounds(self):
        clock, seen = Clock(), []
        # A second old response after a new round must reset the success streak.
        rounds = [(307, 401), (404, 403), (404, 401), (404, 403), (404, 403), (404, 403)]
        def read(origin, route, **kwargs):
            call = len(seen)
            seen.append((route, kwargs))
            return rounds[call // 2][call % 2], b'', {}
        with patch.object(m.time, 'monotonic', clock.monotonic), patch.object(m.time, 'sleep', clock.sleep), patch.object(m, 'request', read):
            receipt = m.wait_for_public_readiness(m.PUBLIC)
        self.assertEqual(receipt['attempts'], 6)
        self.assertEqual(receipt['consecutiveFreshSuccesses'], 3)
        self.assertEqual(receipt['elapsedSeconds'], 2.5)
        self.assertEqual(len({route for route, _ in seen}), len(seen))
        for route, kwargs in seen:
            self.assertIn('?_security_ready=', route)
            self.assertGreater(kwargs['timeout'], 0)
            self.assertLessEqual(kwargs['timeout'], 2)
            self.assertEqual(kwargs['extra_headers']['Connection'], 'close')
            self.assertEqual(kwargs['extra_headers']['Cache-Control'], 'no-cache, no-store')
            self.assertEqual(kwargs['extra_headers']['Pragma'], 'no-cache')
            self.assertEqual('x-sanjie-ai-client' in kwargs['extra_headers'], route.startswith('/api/auth/me?'))
        self.assertTrue(all(0 < wait <= 0.5 for wait in clock.sleeps))

    def test_slow_or_failed_requests_remain_bounded_and_never_pass(self):
        clock, seen = Clock(), []
        def failed_read(origin, route, **kwargs):
            seen.append(kwargs['timeout'])
            clock.elapsed += kwargs['timeout']
            raise TimeoutError('offline transport failure; never serialize this value')
        with patch.object(m.time, 'monotonic', clock.monotonic), patch.object(m.time, 'sleep', clock.sleep), patch.object(m, 'request', failed_read):
            with self.assertRaisesRegex(RuntimeError, 'within 30 seconds'):
                m.wait_for_public_readiness(m.PUBLIC)
        self.assertEqual(clock.elapsed, 30)
        self.assertTrue(all(0 < value <= 2 for value in seen))

    def test_permanently_old_public_backend_fails_and_restores_old_routing(self):
        clock = Clock()
        with tempfile.TemporaryDirectory(prefix='security-readiness-review-') as temporary:
            root = Path(temporary)
            original = b'map $cookie_sanjie_creative_uat $sanjie_app_port { default 31948; }\nserver { location / { proxy_pass http://127.0.0.1:$sanjie_app_port; } }\n'
            config = root / 'nginx.conf'
            config.write_bytes(original)
            original_sha = hashlib.sha256(original).hexdigest()
            process = {'fixture': 'unchanged-process'}
            state = {'phase': 'prepared', 'candidateProcess': process, 'applicationEnvironmentSha256': m.environment_fingerprint({}), 'baseFiles': {m.LATEST: {'size': 0, 'sha256': 'a' * 64}}, 'candidateFiles': {}}
            deployment = object.__new__(m.Deployment)
            deployment.new = root / 'candidate'
            deployment.new.mkdir()
            deployment.logs = root / 'logs'
            deployment.logs.mkdir()
            deployment.args = SimpleNamespace(nginx_target_string=None)
            deployment.manifest = {'downloadPolicy': 'public'}
            deployment.load = lambda: state
            deployment.baseline = Mock()
            deployment.candidate = Mock()
            deployment.apply_migrations = Mock(return_value=[])
            deployment.signed_cookie = Mock(return_value='offline-fixture-cookie')
            deployment.logged = Mock(return_value='offline-log')
            phases = []
            deployment.save = lambda value, phase: (value.update(phase=phase), phases.append(phase))
            full_smoke = Mock(return_value=[])
            def old_worker(origin, route, **kwargs):
                return (307 if route.startswith('/.env?') else 401), b'', {}
            with patch.object(m, 'CONF', config), patch.object(m, 'EXPECTED_NGINX', original_sha), patch.object(m, 'process', return_value=process), patch.object(m, 'application_environment', return_value={}), patch.object(m, 'smoke', full_smoke), patch.object(m, 'request', old_worker), patch.object(m.time, 'monotonic', clock.monotonic), patch.object(m.time, 'sleep', clock.sleep):
                with self.assertRaisesRegex(RuntimeError, 'within 30 seconds'):
                    deployment.publish()
            self.assertEqual(clock.elapsed, 30)
            self.assertEqual(config.read_bytes(), original)
            self.assertIn('rolled-back', phases)
            self.assertEqual(state['databaseMigrationExecuted'], True)
            self.assertEqual(state['databaseTablesRetained'], True)
            self.assertEqual(full_smoke.call_count, 1, 'only the pre-switch canary smoke may run when readiness fails')
            self.assertTrue(full_smoke.call_args.args[0].startswith('http://127.0.0.1:'))

if __name__ == '__main__':
    unittest.main(verbosity=2)
