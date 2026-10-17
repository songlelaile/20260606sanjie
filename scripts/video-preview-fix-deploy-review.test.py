"""Independent offline review of preview overlay ancestry, scope and write-before guards."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

PATH = Path(__file__).resolve().parents[1] / '.codex-deploy/video-preview-fix-20261010/deploy/deploy-video-preview-fix.py'
SPEC = importlib.util.spec_from_file_location('preview_overlay_independent_review', PATH)
r = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(r)


def encoded(value):
    return json.dumps(value, sort_keys=True).encode()


def row(sha='a' * 64, inode=1):
    return dict(device=24, inode=inode, uid=0, gid=0, mode=0o644, nlink=1, size=10, sha256=sha)


def ancestry():
    original = {path: row(inode=index + 1) for index, path in enumerate(r.OBSERVE_FILES)}
    cost = dict(snapshot={'files': original, 'process': {'pid': r.PID, 'port': r.PORT}, 'pm2': {'socket': 1}},
                sourceFiles={path: {'size': value['size'], 'sha256': value['sha256']} for path, value in original.items()},
                sourcePermissions={path: {key: value[key] for key in ('mode', 'uid', 'gid')} for path, value in original.items()},
                buildFiles={'build': 'sealed'}, dependencies={'link': 'sealed'}, prisma={'link': 'sealed'},
                environmentReferences={'link': 'sealed'}, runtimeReferences={'link': 'sealed'},
                originalNativeConfig={'sha256': 'b' * 64}, activeNativeConfig={'sha256': 'c' * 64},
                applicationEnvironmentSha256='d' * 64, nginxDescriptor={'inode': 20}, otherNginxSha256='e' * 64,
                nodeExecutable={'inode': 21}, retainedProcesses={'other': 22}, acceptedParentReceiptDescriptor={'inode': 23})
    audio_rows = {path: row(r.ACCEPTED_AUDIO[path], index + 101) for index, path in enumerate(r.OBSERVE_FILES)}
    audio = {'seal': {'baseline': copy.deepcopy(cost)}, 'appliedDescriptors': audio_rows}
    current = copy.deepcopy(cost)
    for path, value in audio_rows.items():
        current['snapshot']['files'][path] = copy.deepcopy(value)
        current['sourceFiles'][path] = {'size': value['size'], 'sha256': value['sha256']}
    audio_descriptor = dict(inode=24, mode=0o600, sha256=r.AUDIO_RECEIPT_SHA)
    current['acceptedAudioReceiptDescriptor'] = audio_descriptor
    return audio, audio_descriptor, current


def observation(before=None):
    audio, descriptor, current = ancestry()
    release = r.Release.__new__(r.Release)
    release.files = r.APPLY_ORDER
    release.args = types.SimpleNamespace(runner_sha256='f' * 64, manifest_sha256='0' * 64)
    release.payload_descriptors = {}
    release.baseline = lambda: copy.deepcopy(before if before is not None else current)
    release.audio_parent = lambda: (copy.deepcopy(audio), copy.deepcopy(descriptor))
    writes = []
    release.n = types.SimpleNamespace(stamp=lambda: 'now', encoded=encoded,
                                    exclusive_file=lambda path, raw: writes.append((path, raw)),
                                    read_file=lambda _path, _limit: (writes[-1][1], {'sha256': r.digest(writes[-1][1])}))
    return release, writes, current


def manifest():
    return dict(schema='SANJIE_VIDEO_PREVIEW_FIX_MANIFEST_V1', backendChanged=False, providerCalls=0, paidCalls=0,
                files={path: {'beforeSha256': r.BEFORE[path], 'after': {'size': 20, 'sha256': 'f' * 64}} for path in r.FILES})


class ParentAndScopeReview(unittest.TestCase):
    def test_three_mutations_four_observations_and_parent_projection_keeps_cost_ancestry(self):
        self.assertEqual(len(r.FILES), 3); self.assertEqual(len(r.OBSERVE_FILES), 4)
        self.assertNotIn(r.VIDEO + 'video-production.js', r.FILES)
        release, writes, current = observation()
        with mock.patch.object(r.os.path, 'lexists', return_value=False):
            result = release.observe()
        self.assertEqual(result['changedFeatureFiles'], 3)
        saved = json.loads(writes[0][1])['baseline']
        self.assertEqual(saved, current)
        self.assertIn('acceptedParentReceiptDescriptor', saved)
        self.assertIn('acceptedAudioReceiptDescriptor', saved)

    def test_immediate_audio_parent_full_baseline_drift_rejected_before_any_write(self):
        _, _, current = ancestry()
        for key in current:
            with self.subTest(field=key):
                changed = copy.deepcopy(current); changed[key] = {'unexpected': True}
                release, writes, _ = observation(changed)
                with mock.patch.object(r.os.path, 'lexists', return_value=False), self.assertRaisesRegex(RuntimeError, 'ACCEPTED_AUDIO_FULL_BASELINE_DRIFT'):
                    release.observe()
                self.assertEqual(writes, [])

    def test_second_observation_drift_rejected_before_seal_is_written(self):
        release, writes, current = observation()
        changed = copy.deepcopy(current); changed['acceptedAudioReceiptDescriptor']['inode'] += 1
        release.baseline = mock.Mock(side_effect=[current, changed])
        with mock.patch.object(r.os.path, 'lexists', return_value=False), self.assertRaisesRegex(RuntimeError, 'DOUBLE_OBSERVATION_DRIFT'):
            release.observe()
        self.assertEqual(writes, [])

    def test_fourth_module_cannot_enter_manifest_or_live_mutation_projection(self):
        module = r.VIDEO + 'video-production.js'
        value = manifest(); value['files'][module] = next(iter(value['files'].values()))
        with self.assertRaisesRegex(RuntimeError, 'MANIFEST_SCOPE_REJECTED'): r.check_manifest(value)
        _, _, current = ancestry()
        with self.assertRaisesRegex(RuntimeError, 'APPLIED_SCOPE_REJECTED'): r.projected_snapshot(current, {module: current['snapshot']['files'][module]})

    def test_state_cannot_expand_backups_or_mutations_to_observation_only_module(self):
        release, writes, current = observation()
        release.stable_inputs = lambda: None
        module = r.VIDEO + 'video-production.js'
        for field in ('backups', 'appliedDescriptors'):
            state = {'seal': {'baseline': current}, 'backups': {}, 'appliedDescriptors': {}}
            state[field][module] = current['snapshot']['files'][module]
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'STATE_MUTATION_SCOPE_REJECTED'):
                release.verify(state)
        self.assertEqual(writes, [])

    def test_exact_audio_receipt_hash_and_accepted_state_are_required(self):
        audio, _, _ = ancestry()
        audio.update(schema='SANJIE_VIDEO_AUDIO_MIX_STATE_V1', phase='accepted', accepted=True, published=True,
                     runnerSha256=r.AUDIO_RUNNER_SHA, manifestSha256=r.AUDIO_MANIFEST_SHA, providerCalls=0,
                     paidCalls=0, backendChanged=False, processRestarted=False, nginxChanged=False)
        release = r.Release.__new__(r.Release)
        for key, value in [('hash', 'f' * 64), ('phase', 'rolled_back'), ('accepted', False), ('runnerSha256', 'f' * 64)]:
            changed = copy.deepcopy(audio); descriptor = {'mode': 0o600, 'sha256': r.AUDIO_RECEIPT_SHA}
            if key == 'hash': descriptor['sha256'] = value
            else: changed[key] = value
            release.n = types.SimpleNamespace(read_file=lambda _p, _l: (encoded(changed), descriptor))
            with self.subTest(field=key), self.assertRaisesRegex(RuntimeError, 'ACCEPTED_AUDIO_PARENT_REJECTED'): release.audio_parent()


class FailClosedWriteReview(unittest.TestCase):
    def test_wrong_runner_manifest_or_payload_hash_never_reaches_a_write(self):
        good_manifest = encoded(manifest()); writes = mock.Mock(); runner_raw = b'runner'
        for bad in ('runner', 'manifest', 'payload'):
            args = types.SimpleNamespace(runner_sha256=r.digest(runner_raw), manifest_sha256=r.digest(good_manifest))
            if bad == 'runner': args.runner_sha256 = '0' * 64
            if bad == 'manifest': args.manifest_sha256 = '0' * 64
            def read(path, _limit):
                raw = runner_raw if path == Path(r.__file__) else good_manifest if path == r.STAGE / 'overlay-manifest.json' else b'wrong-payload'
                return raw, {'mode': 0o600, 'size': len(raw), 'sha256': r.digest(raw)}
            helper = types.SimpleNamespace(read_file=read, load_helper=lambda: None, exclusive_file=writes, atomic_file=writes, save_state=writes)
            with self.subTest(guard=bad), mock.patch.object(r, 'load', side_effect=[helper, object(), object(), object()]), self.assertRaisesRegex(RuntimeError, 'RUNNER_SHA_REJECTED|MANIFEST_SHA_OR_MODE_REJECTED|PAYLOAD_MANIFEST_REJECTED'):
                r.Release(args)
        writes.assert_not_called()

    def test_wrong_baseline_or_browser_proof_hash_never_reaches_a_write(self):
        release = r.Release.__new__(r.Release); writes = mock.Mock()
        release.args = types.SimpleNamespace(baseline_sha256='a' * 64, browser_proof_sha256='a' * 64)
        release.n = types.SimpleNamespace(read_file=lambda _p, _l: (b'{}', {'mode': 0o600, 'sha256': 'b' * 64}), exclusive_file=writes, atomic_file=writes, save_state=writes)
        with self.assertRaisesRegex(RuntimeError, 'BASELINE_SHA_REJECTED'): release.seal()
        release.files = r.APPLY_ORDER
        release.state = lambda: {'phase': 'applied_pending_browser_validation', 'pendingPath': None, 'appliedDescriptors': {path: {} for path in release.files}}
        with self.assertRaisesRegex(RuntimeError, 'BROWSER_PROOF_SHA_OR_MODE_REJECTED'): release.accept()
        writes.assert_not_called()

    def test_large_baseline_state_and_rollback_receipt_reject_before_writing(self):
        release, writes, _ = observation(); release.n.encoded = lambda _value: b'12345678901'
        release.n.save_state = mock.Mock(); release.verify = lambda _state: None
        with mock.patch.object(r, 'STATE_LIMIT', 10):
            with mock.patch.object(r.os.path, 'lexists', return_value=False), self.assertRaisesRegex(RuntimeError, 'BASELINE_TOO_LARGE'): release.observe()
            with self.assertRaisesRegex(RuntimeError, 'STATE_TOO_LARGE'): release.save({})
            with self.assertRaisesRegex(RuntimeError, 'ROLLBACK_RECEIPT_TOO_LARGE'): release.finish_rollback({})
        release.n.save_state.assert_not_called(); self.assertEqual(writes, [])

    def test_root_private_reader_rejects_wrong_mode_uid_hardlink_or_oversize_before_read(self):
        for field, value in [('st_uid', 501), ('st_gid', 501), ('st_mode', 0o100644), ('st_nlink', 2), ('st_size', 201)]:
            values = dict(st_mode=0o100600, st_uid=0, st_gid=0, st_nlink=1, st_size=1)
            values[field] = value; first = types.SimpleNamespace(**values)
            path = mock.Mock(); path.parents = ()
            with self.subTest(field=field), mock.patch.object(r.os, 'open', return_value=123), mock.patch.object(r.os, 'fstat', return_value=first), mock.patch.object(r.os, 'close'), mock.patch.object(r.os, 'read') as read, self.assertRaisesRegex(RuntimeError, 'UNSAFE_PRIVATE_FILE'):
                r.root_read(path, 200)
            read.assert_not_called()


class ReceiptFaultReview(unittest.TestCase):
    def fixture(self, directory):
        # Reuse only the in-memory IO double; exercise different receipt failures.
        spec = importlib.util.spec_from_file_location('preview_io_fixture', PATH.with_name('test_video_preview_fix.py'))
        fixture_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture_module)
        fixture_module.r = r
        fixture = fixture_module.Fixture(Path(directory) / 'app', Path(directory) / 'stage')
        fixture.stage.mkdir()
        proof = fixture_module.PreviewDeployTests().good_proof()
        fixture.n.add(fixture.stage / 'browser-proof.json', fixture.n.encoded(proof), 0o600)
        fixture.rel.args.browser_proof_sha256 = fixture.n.descriptor(fixture.stage / 'browser-proof.json')['sha256']
        return fixture

    def patches(self, fixture):
        return (mock.patch.object(r, 'ROOT', fixture.root), mock.patch.object(r, 'STAGE', fixture.stage),
                mock.patch.dict(r.BEFORE, {path: r.digest(raw) for path, raw in fixture.original.items() if path in r.FILES}, clear=True),
                mock.patch.object(r.os.path, 'lexists', lambda path: str(path) in fixture.n.files))

    def test_unknown_primary_receipt_after_accept_cas_crash_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            f = self.fixture(directory)
            a, b, c, d = self.patches(f)
            with a, b, c, d:
                f.rel.apply(); f.n.fail_save_if = lambda state: state['phase'] == 'accepted'
                with self.assertRaisesRegex(RuntimeError, 'INJECTED_BEFORE_STATE_SAVE'): f.rel.accept()
                self.assertEqual(f.n.saved['phase'], 'accepting')
                f.n.add(f.stage / 'receipt.json', b'unknown-primary-receipt', 0o600)
                with self.assertRaisesRegex(RuntimeError, 'ACCEPT_PRIMARY_RECEIPT_DRIFT'): f.rel.accept()
                self.assertEqual(f.n.read_file(f.stage / 'receipt.json')[0], b'unknown-primary-receipt')
                self.assertEqual(f.n.saved['phase'], 'accepting')

    def test_rollback_primary_receipt_cas_crash_resumes_from_rolled_back_state(self):
        with tempfile.TemporaryDirectory() as directory:
            f = self.fixture(directory)
            a, b, c, d = self.patches(f)
            with a, b, c, d:
                f.rel.apply(); f.rel.accept()
                accepted = f.n.read_file(f.stage / 'receipt.json')[0]
                f.n.fail_after = str(f.stage / 'receipt.json')
                with self.assertRaisesRegex(RuntimeError, 'INJECTED_AFTER_REPLACE'): f.rel.rollback()
                self.assertEqual(f.n.saved['phase'], 'rolled_back')
                self.assertEqual(f.rel.rollback()['phase'], 'rolled_back')
                receipt = json.loads(f.n.read_file(f.stage / 'receipt.json')[0])
                self.assertEqual(receipt, f.n.saved)
                self.assertFalse(receipt['accepted']); self.assertFalse(receipt['published'])
                self.assertEqual(f.n.read_file(f.stage / 'pre-rollback-receipt.json')[0], accepted)

    def test_oversize_acceptance_intent_stops_before_intent_or_primary_receipt_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            f = self.fixture(directory)
            a, b, c, d = self.patches(f)
            with a, b, c, d:
                f.rel.apply(); previous = f.n.read_file(f.stage / 'receipt.json')[0]
                with mock.patch.object(r, 'STATE_LIMIT', 1), self.assertRaisesRegex(RuntimeError, 'ACCEPT_INTENT_TOO_LARGE'):
                    f.rel.accept()
                self.assertNotIn(str(f.stage / 'accepted-state.json'), f.n.files)
                self.assertEqual(f.n.read_file(f.stage / 'receipt.json')[0], previous)
                self.assertEqual(f.n.saved['phase'], 'applied_pending_browser_validation')


if __name__ == '__main__': unittest.main()
