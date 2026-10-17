#!/usr/bin/env python3
"""Offline deployment failure/race fixtures. No server, PM2, Nginx, or DB calls."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('reviewed_security_runner', Path(__file__).with_name('deploy-security-channel-20261002.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='security-runner-review-')
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def file(self, path, body=b'fixture'):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        return path

    def test_symlinked_baseline_prisma_is_copied_before_overlay_schema_write(self):
        baseline = self.root / 'baseline'
        schema = self.file(self.root / 'shared-prisma/schema.prisma', b'original-immutable-schema')
        database = self.file(self.root / 'shared-prisma/dev.db', b'customer-db')
        self.file(self.root / 'shared-prisma/migrations/old/migration.sql')
        baseline.mkdir()
        (baseline / 'prisma').symlink_to(schema.parent, target_is_directory=True)
        self.file(baseline / 'package.json', b'{}')
        self.file(baseline / 'node_modules/placeholder')
        self.file(baseline / '.env', b'PRIVATE_FIXTURE=not-a-real-secret')
        deployment = object.__new__(m.Deployment)
        deployment.new = self.root / 'candidate'
        deployment.logs = deployment.new / 'deployment-logs/security-channel-20261002'
        with patch.object(m, 'BASE', baseline), patch.object(m.shutil, 'disk_usage', return_value=SimpleNamespace(free=12 * 1024**3)):
            deployment.clone()
        target = deployment.new / 'prisma/schema.prisma'
        m.no_symlinks(target, deployment.new)
        target.write_bytes(b'new-candidate-schema')
        self.assertFalse((deployment.new / 'prisma').is_symlink())
        self.assertEqual(schema.read_bytes(), b'original-immutable-schema')
        self.assertTrue((deployment.new / 'prisma/dev.db').is_symlink())
        self.assertEqual((deployment.new / 'prisma/dev.db').resolve(), database.resolve())

    def test_candidate_source_mutation_rejected_before_build_check(self):
        deployment = object.__new__(m.Deployment)
        deployment.new = self.root / 'candidate'
        state = {'candidateFiles': {'src/security.ts': {'size': 1, 'sha256': 'a' * 64}}}
        with patch.object(m, 'inventory', return_value={'src/security.ts': {'size': 2, 'sha256': 'b' * 64}}), self.assertRaisesRegex(RuntimeError, 'Candidate source CAS'):
            deployment.candidate(state)

    def test_candidate_build_mutation_rejected_with_unchanged_source(self):
        deployment = object.__new__(m.Deployment)
        deployment.new = self.root / 'candidate'
        deployment.new.mkdir()
        (deployment.new / 'node_modules').symlink_to(self.root / 'dependencies')
        state = {'candidateFiles': {'source': 1}, 'environment': {'identity': 1}, 'runtime': {}, 'dependencies': {'identity': 2}, 'buildFiles': {'BUILD_ID': 3}}
        with patch.object(m, 'inventory', return_value=state['candidateFiles']), patch.object(m, 'environment_identity', return_value=state['environment']), patch.object(m, 'runtime_identity', return_value={}), patch.object(m, 'dependency_identity', return_value=state['dependencies']), patch.object(m, 'build_inventory', return_value={'BUILD_ID': 4}), self.assertRaisesRegex(RuntimeError, 'Candidate build seal'):
            deployment.candidate(state)

    def test_publish_rolls_back_when_atomic_replace_succeeds_but_directory_fsync_fails(self):
        original = b'map $cookie_sanjie_creative_uat $sanjie_app_port { default 31948; }\nserver { location / { proxy_pass http://127.0.0.1:$sanjie_app_port; } }\n'
        config = self.file(self.root / 'sanjie.conf', original)
        original_sha = hashlib.sha256(original).hexdigest()
        process = {'fixture': 'unchanged-process'}
        state = {'phase': 'prepared', 'candidateProcess': process, 'applicationEnvironmentSha256': m.environment_fingerprint({}), 'baseFiles': {m.LATEST: {'size': 0, 'sha256': 'a' * 64}}, 'candidateFiles': {}}
        deployment = object.__new__(m.Deployment)
        deployment.new = self.root / 'candidate'
        deployment.new.mkdir()
        deployment.logs = self.root / 'logs'
        deployment.logs.mkdir()
        deployment.args = SimpleNamespace(nginx_target_string=None)
        deployment.manifest = {'downloadPolicy': 'public'}
        deployment.load = lambda: state
        deployment.baseline = Mock()
        deployment.candidate = Mock()
        deployment.apply_migrations = Mock(return_value=[])
        deployment.signed_cookie = Mock(return_value='fixture-read-only-cookie')
        deployment.logged = Mock(return_value='offline-log')
        phases = []
        deployment.save = lambda value, phase: (value.update(phase=phase), phases.append(phase))
        real_atomic = m.atomic_bytes
        failed_once = False
        def fail_after_replace(path, data, expected_sha=None):
            nonlocal failed_once
            if Path(path) == config and not failed_once:
                failed_once = True
                real_atomic(path, data, expected_sha)
                raise OSError('offline directory fsync failure after replace')
            return real_atomic(path, data, expected_sha)
        with patch.object(m, 'CONF', config), patch.object(m, 'EXPECTED_NGINX', original_sha), patch.object(m, 'process', return_value=process), patch.object(m, 'application_environment', return_value={}), patch.object(m, 'smoke', return_value=[]), patch.object(m, 'atomic_bytes', side_effect=fail_after_replace):
            with self.assertRaisesRegex(OSError, 'fsync failure after replace'):
                deployment.publish()
        self.assertEqual(config.read_bytes(), original, 'publish failure left changed Nginx configuration on disk')
        self.assertIn('rolled-back', phases)

if __name__ == '__main__':
    unittest.main(verbosity=2)
