"""Independent local-only checks of the migrated preview release and failure recovery."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

BASE = Path(__file__).resolve().parents[1]
HERE = BASE / '.codex-deploy/video-preview-fix-20261010/deploy-v2'
SPEC = importlib.util.spec_from_file_location('preview_v2_independent', HERE / 'deploy-video-preview-fix.py')
r = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(r)
IO_SPEC = importlib.util.spec_from_file_location('preview_v2_memory_io', HERE / 'test_video_preview_fix.py')
io = importlib.util.module_from_spec(IO_SPEC)
IO_SPEC.loader.exec_module(io)
io.r = r


class CurrentOwnerReview(unittest.TestCase):
    def test_owner_build_and_nginx_match_independent_recovery_and_gzip_evidence(self):
        recovery = json.loads((BASE / '.codex-deploy/studio-iframe-lazy-review-20261009-v1/recovery-review-20261010-v1/release-v1/evidence/applied-public-receipt.json').read_text())
        gzip = json.loads((BASE / '.codex-deploy/studio-html-gzip-review-20261010-v1/deploy/release-v1/plan.json').read_text())
        prepared = json.loads((BASE / '.codex-deploy/studio-iframe-lazy-review-20261009-v1/prepare-review-20261010-v9/evidence/prepared-binding-public-receipt.json').read_text())
        self.assertEqual(r.OWNER, recovery['candidateProcess'])
        self.assertEqual(r.OWNER, gzip['process'])
        self.assertEqual(r.CURRENT_NGINX_SHA, gzip['afterSha256'])
        self.assertEqual(r.GLOBAL_NGINX_SHA, gzip['globalNginxSha256'])
        self.assertEqual(r.CURRENT_BUILD, prepared['candidate']['build'])
        self.assertEqual(r.STATE_PINS[r.PREPARE_STATE], prepared['candidate']['prepareStateSha256'])
        self.assertNotEqual(r.ROOT, r.COST_ROOT)
        self.assertNotEqual(r.STAGE, BASE / '.codex-deploy/video-preview-fix-20261010/frozen-v1')

    def early_baseline(self, snapshot):
        release = object.__new__(r.Release)
        release.stable_inputs = lambda: None
        release.g = object()
        release.n = types.SimpleNamespace(snapshot=lambda *_: copy.deepcopy(snapshot))
        release.parent = mock.Mock(side_effect=AssertionError('private ancestry must not be read after owner rejection'))
        return release

    def test_old_root_replacement_and_each_owner_identity_change_reject_before_reading_ancestry(self):
        for key, value in [('root', str(r.COST_ROOT)), ('pid', r.PID + 1), ('pm_id', 171),
                           ('port', 44309), ('startTicks', '420920120'), ('restarts', 1),
                           ('name', r.COST_NAME), ('status', 'stopped')]:
            snapshot = {'process': dict(r.OWNER, **{key: value}), 'nginxSha256': r.CURRENT_NGINX_SHA}
            release = self.early_baseline(snapshot)
            with self.subTest(field=key), self.assertRaisesRegex(RuntimeError, 'LIVE_PINNED_OWNER_REPLACED'):
                release.baseline()
            release.parent.assert_not_called()

    def test_gzip_route_reversion_rejects_before_reading_private_ancestry(self):
        release = self.early_baseline({'process': r.OWNER, 'nginxSha256': 'fbb3a40b627d62057acafca8e53430fce5574a09cf0893a6447221e3a3391e45'})
        with self.assertRaisesRegex(RuntimeError, 'CURRENT_GZIP_NGINX_DRIFT'):
            release.baseline()
        release.parent.assert_not_called()


class ScopedStateReview(unittest.TestCase):
    def fixture(self, directory):
        fixture = io.Fixture(Path(directory) / 'app', Path(directory) / 'stage')
        fixture.stage.mkdir()
        # These extra fields are the migrated release's complete sealed evidence.
        fixture.before.update(
            releaseSourceRecords={path: dict(size=row['size'], sha256=row['sha256'], mode=0o644, uid=0, gid=0)
                                  for path, row in fixture.before['snapshot']['files'].items()},
            observedReleaseStateDescriptors={'prepare': {'inode': 1}, 'recovery': {'inode': 2}, 'gzip': {'inode': 3}},
            currentBuildSummary=copy.deepcopy(r.CURRENT_BUILD),
            readonlyQueryDescriptor={'sha256': r.QUERY_SHA},
            originalUnknownJob={'id': r.FIXED_JOB, 'status': 'unknown'},
        )
        fixture.seal['baseline'] = fixture.before
        original_baseline = fixture.baseline

        def actual_baseline():
            result = original_baseline()
            for path in r.OBSERVE_FILES:
                row = fixture.n.descriptor(fixture.root / path)
                result['releaseSourceRecords'][path].update(size=row['size'], sha256=row['sha256'])
            return result

        fixture.rel.baseline = actual_baseline
        proof = io.PreviewDeployTests().good_proof()
        fixture.n.add(fixture.stage / 'browser-proof.json', fixture.n.encoded(proof), 0o600)
        fixture.rel.args.browser_proof_sha256 = fixture.n.descriptor(fixture.stage / 'browser-proof.json')['sha256']
        return fixture

    def patches(self, fixture):
        return (mock.patch.object(r, 'ROOT', fixture.root), mock.patch.object(r, 'STAGE', fixture.stage),
                mock.patch.dict(r.BEFORE, {path: r.digest(raw) for path, raw in fixture.original.items() if path in r.FILES}, clear=True),
                mock.patch.object(r.os.path, 'lexists', lambda path: str(path) in fixture.n.files))

    def test_migrated_full_baseline_and_audio_module_survive_three_file_apply_and_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            f = self.fixture(directory)
            a, b, c, d = self.patches(f)
            with a, b, c, d:
                module = r.VIDEO + 'video-production.js'
                original_module = f.n.read_file(f.root / module)
                f.rel.apply()
                f.rel.verify(f.n.saved)
                f.rel.rollback()
                f.rel.verify(f.n.saved)
                self.assertEqual(f.n.read_file(f.root / module), original_module)
                self.assertEqual(f.n.saved['seal']['baseline']['currentBuildSummary'], r.CURRENT_BUILD)
                self.assertEqual(f.n.saved['seal']['baseline']['readonlyQueryDescriptor']['sha256'], r.QUERY_SHA)
                self.assertEqual(f.n.saved['phase'], 'rolled_back')

    def test_ancestor_descriptor_drift_blocks_acceptance_before_intent_is_created(self):
        with tempfile.TemporaryDirectory() as directory:
            f = self.fixture(directory)
            a, b, c, d = self.patches(f)
            with a, b, c, d:
                f.rel.apply()
                baseline = f.rel.baseline
                def changed():
                    result = baseline()
                    result['observedReleaseStateDescriptors']['gzip']['inode'] += 1
                    return result
                f.rel.baseline = changed
                with self.assertRaisesRegex(RuntimeError, 'LIVE_FULL_BASELINE_DRIFT'):
                    f.rel.accept()
                self.assertNotIn(str(f.stage / 'accepted-state.json'), f.n.files)
                self.assertEqual(f.n.saved['phase'], 'applied_pending_browser_validation')

    def test_unknown_primary_receipt_after_accept_cas_crash_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            f = self.fixture(directory)
            a, b, c, d = self.patches(f)
            with a, b, c, d:
                f.rel.apply()
                f.n.fail_save_if = lambda state: state['phase'] == 'accepted'
                with self.assertRaisesRegex(RuntimeError, 'INJECTED_BEFORE_STATE_SAVE'):
                    f.rel.accept()
                self.assertEqual(f.n.saved['phase'], 'accepting')
                f.n.add(f.stage / 'receipt.json', b'unknown receipt bytes', 0o600)
                with self.assertRaisesRegex(RuntimeError, 'ACCEPT_PRIMARY_RECEIPT_DRIFT'):
                    f.rel.accept()
                self.assertEqual(f.n.read_file(f.stage / 'receipt.json')[0], b'unknown receipt bytes')

    def test_rollback_receipt_crash_is_resumable_and_preserves_previous_accepted_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            f = self.fixture(directory)
            a, b, c, d = self.patches(f)
            with a, b, c, d:
                f.rel.apply()
                f.rel.accept()
                accepted = f.n.read_file(f.stage / 'receipt.json')[0]
                f.n.fail_after = str(f.stage / 'receipt.json')
                with self.assertRaisesRegex(RuntimeError, 'INJECTED_AFTER_REPLACE'):
                    f.rel.rollback()
                self.assertEqual(f.n.saved['phase'], 'rolled_back')
                self.assertEqual(f.rel.rollback()['phase'], 'rolled_back')
                self.assertEqual(json.loads(f.n.read_file(f.stage / 'receipt.json')[0]), f.n.saved)
                self.assertEqual(f.n.read_file(f.stage / 'pre-rollback-receipt.json')[0], accepted)

    def test_oversized_acceptance_stops_before_any_receipt_is_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            f = self.fixture(directory)
            a, b, c, d = self.patches(f)
            with a, b, c, d:
                f.rel.apply()
                previous = f.n.read_file(f.stage / 'receipt.json')[0]
                with mock.patch.object(r, 'STATE_LIMIT', 1), self.assertRaisesRegex(RuntimeError, 'ACCEPT_INTENT_TOO_LARGE'):
                    f.rel.accept()
                self.assertNotIn(str(f.stage / 'accepted-state.json'), f.n.files)
                self.assertEqual(f.n.read_file(f.stage / 'receipt.json')[0], previous)


if __name__ == '__main__':
    unittest.main()
