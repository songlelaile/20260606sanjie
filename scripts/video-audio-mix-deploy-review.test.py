"""Offline negative review of the audio overlay runner; no SSH, process, provider or production writes."""
import copy
import importlib.util
import json
from pathlib import Path
import types
import unittest
from unittest import mock

RUNNER = Path(__file__).resolve().parents[1] / '.codex-deploy/video-audio-mix-20261010/deploy/deploy-video-audio-mix.py'
SPEC = importlib.util.spec_from_file_location('audio_overlay_review', RUNNER)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def descriptor(index=0, after=False):
    return dict(device=24, inode=100 + index + (100 if after else 0), uid=0, gid=0, mode=0o644,
                nlink=1, size=20 if after else 10, sha256=('b' if after else 'a') * 64)


def baseline():
    files = {path: descriptor(index) for index, path in enumerate(runner.FILES)}
    return dict(snapshot={'files': files, 'process': {'pid': runner.PID, 'port': runner.PORT}, 'lock': {'inode': 1}},
                sourceFiles={**{path: {'size': row['size'], 'sha256': row['sha256']} for path, row in files.items()},
                             'package.json': {'size': 1, 'sha256': 'c' * 64}},
                sourcePermissions={path: {key: row[key] for key in ('uid', 'gid', 'mode')} for path, row in files.items()},
                buildFiles={'build': 'unchanged'}, dependencies={'reference': 'unchanged'}, prisma={'reference': 'unchanged'},
                environmentReferences={'link': 'unchanged'}, runtimeReferences={'link': 'unchanged'},
                originalNativeConfig={'sha256': 'd' * 64}, activeNativeConfig={'sha256': 'e' * 64},
                applicationEnvironmentSha256='f' * 64, otherNginxSha256='0' * 64,
                nodeExecutable={'inode': 7}, retainedProcesses={'other': 1}, acceptedParentReceiptDescriptor={'inode': 8})


def manifest():
    return dict(schema='SANJIE_VIDEO_AUDIO_MIX_MANIFEST_V1', backendChanged=False, providerCalls=0, paidCalls=0,
                files={path: {'beforeSha256': runner.BEFORE[path], 'after': {'size': 20, 'sha256': 'b' * 64}}
                       for path in runner.FILES})


class OfflineRelease:
    def __init__(self, state, actual):
        self.saved = []
        self.release = runner.Release.__new__(runner.Release)
        self.release.manifest = manifest()
        self.release.save = lambda value: self.saved.append(copy.deepcopy(value))
        self.release.n = types.SimpleNamespace(descriptor=lambda _path: copy.deepcopy(actual))
        self.state = state


class ScopeReview(unittest.TestCase):
    def test_exact_four_files_and_no_backend_or_paid_manifest_claim(self):
        self.assertEqual(len(runner.FILES), 4)
        runner.check_manifest(manifest())
        for mutation in ('extra_file', 'backend', 'paid_bool', 'wrong_parent'):
            with self.subTest(mutation=mutation):
                value = manifest()
                if mutation == 'extra_file': value['files']['src/app/api/creative/native-video/route.ts'] = next(iter(value['files'].values()))
                if mutation == 'backend': value['backendChanged'] = True
                if mutation == 'paid_bool': value['paidCalls'] = False
                if mutation == 'wrong_parent': value['files'][runner.FILES[0]]['beforeSha256'] = '0' * 64
                with self.assertRaises(RuntimeError): runner.check_manifest(value)

    def test_projection_only_changes_the_scoped_asset_and_keeps_other_seals(self):
        before = baseline(); untouched = copy.deepcopy(before); path = runner.FILES[0]; row = descriptor(after=True)
        projected = runner.projected_snapshot(before, {path: row})
        self.assertEqual(before, untouched)
        self.assertEqual(projected['snapshot']['files'][path], row)
        self.assertEqual(projected['sourceFiles'][path], {'size': 20, 'sha256': 'b' * 64})
        for key in before:
            if key not in ('snapshot', 'sourceFiles'): self.assertEqual(projected[key], before[key])
        self.assertEqual(projected['sourceFiles']['package.json'], before['sourceFiles']['package.json'])
        self.assertEqual(projected['snapshot']['process'], before['snapshot']['process'])

    def test_projection_rejects_fifth_asset_owner_mode_or_hardlink_drift(self):
        with self.assertRaisesRegex(RuntimeError, 'APPLIED_SCOPE_REJECTED'):
            runner.projected_snapshot(baseline(), {'../../outside': descriptor(after=True)})
        for key, value in [('uid', 501), ('gid', 501), ('mode', 0o666), ('device', 25), ('nlink', 2)]:
            with self.subTest(field=key):
                row = descriptor(after=True); row[key] = value
                with self.assertRaisesRegex(RuntimeError, 'STATIC_ASSET_OWNER_OR_PERMISSIONS_DRIFT'):
                    runner.projected_snapshot(baseline(), {runner.FILES[0]: row})

    def test_verify_rejects_unrelated_source_build_dependency_database_config_runtime_or_process_drift(self):
        expected = baseline(); state = {'seal': {'baseline': expected}, 'appliedDescriptors': {}, 'backups': {}}
        for key in ('sourceFiles', 'buildFiles', 'dependencies', 'prisma', 'environmentReferences', 'runtimeReferences',
                    'originalNativeConfig', 'activeNativeConfig', 'applicationEnvironmentSha256', 'otherNginxSha256',
                    'nodeExecutable', 'retainedProcesses', 'acceptedParentReceiptDescriptor', 'snapshot'):
            with self.subTest(field=key):
                observed = copy.deepcopy(expected); observed[key] = {'unexpected': True}
                release = runner.Release.__new__(runner.Release); release.stable_inputs = lambda: None
                release.baseline = lambda: observed
                with self.assertRaisesRegex(RuntimeError, 'LIVE_FULL_BASELINE_DRIFT'): release.verify(state)

    def test_audio_acceptance_rejects_truncated_voice_replay_missing_sound_and_wrong_manifest(self):
        proof = dict(schema='SANJIE_VIDEO_AUDIO_MIX_BROWSER_PROOF_V1', observedAt='2026-10-10T00:00:00.000000+00:00',
                     manifestSha256='a' * 64, sameAccount=True, audiblePreview=True, downloadedAudioNonzero=True,
                     voicePlayedOnce=True, voiceDurationSeconds=7.574, voiceStartSeconds=0,
                     finalDurationSeconds=15, threeModesPreserved=True, paidCalls=0)
        runner.check_audio_proof(proof, 'a' * 64)
        for key, value in [('voiceDurationSeconds', 3.2), ('voiceStartSeconds', 8), ('voiceDurationSeconds', float('inf')),
                           ('voicePlayedOnce', False), ('downloadedAudioNonzero', False), ('audiblePreview', False),
                           ('manifestSha256', 'b' * 64), ('paidCalls', False)]:
            with self.subTest(field=key, value=value):
                changed = {**proof, key: value}
                with self.assertRaises(RuntimeError): runner.check_audio_proof(changed, 'a' * 64)


class PendingCasReview(unittest.TestCase):
    def state(self, action):
        path = runner.FILES[0]
        return {'seal': {'baseline': baseline()}, 'appliedDescriptors': {path: descriptor(after=True)} if action == 'restore' else {},
                'pendingPath': path, 'pendingAction': action}

    def test_apply_crash_after_rename_can_recover_only_known_payload(self):
        state = self.state('apply'); h = OfflineRelease(state, descriptor(after=True)); h.release.recover_pending(state)
        self.assertEqual(state['appliedDescriptors'][runner.FILES[0]], descriptor(after=True))
        self.assertIsNone(state['pendingPath']); self.assertEqual(len(h.saved), 1)

    def test_apply_crash_before_rename_does_not_claim_asset_applied(self):
        state = self.state('apply'); h = OfflineRelease(state, descriptor()); h.release.recover_pending(state)
        self.assertEqual(state['appliedDescriptors'], {}); self.assertIsNone(state['pendingPath'])

    def test_apply_unknown_bytes_and_restore_unknown_bytes_never_clear_pending_journal(self):
        for action in ('apply', 'restore'):
            with self.subTest(action=action):
                state = self.state(action); actual = descriptor(after=True); actual['sha256'] = 'c' * 64
                h = OfflineRelease(state, actual)
                with self.assertRaises(RuntimeError): h.release.recover_pending(state)
                self.assertEqual(state['pendingPath'], runner.FILES[0]); self.assertEqual(h.saved, [])

    def test_restore_crash_after_rename_preserves_original_bytes_with_new_inode(self):
        state = self.state('restore'); actual = descriptor(); actual['inode'] = 777
        h = OfflineRelease(state, actual); h.release.recover_pending(state)
        self.assertEqual(state['appliedDescriptors'][runner.FILES[0]], actual); self.assertIsNone(state['pendingPath'])

    def test_unknown_pending_path_or_wrong_action_state_is_rejected(self):
        for mutation in ('path', 'action', 'already_applied', 'restore_without_apply'):
            with self.subTest(mutation=mutation):
                state = self.state('apply')
                if mutation == 'path': state['pendingPath'] = 'public/creative/other.js'
                if mutation == 'action': state['pendingAction'] = 'delete'
                if mutation == 'already_applied': state['appliedDescriptors'][runner.FILES[0]] = descriptor(after=True)
                if mutation == 'restore_without_apply': state['pendingAction'] = 'restore'
                h = OfflineRelease(state, descriptor(after=True))
                with self.assertRaisesRegex(RuntimeError, 'PENDING_ASSET_SCOPE_REJECTED'): h.release.recover_pending(state)

    def test_duplicate_json_cannot_replace_a_protected_manifest_key(self):
        with self.assertRaisesRegex(RuntimeError, 'DUPLICATE_JSON_KEY'):
            json.loads('{"paidCalls":1,"paidCalls":0}', object_pairs_hook=runner.unique)


class ReceiptHarness:
    """In-memory runner state/receipt CAS, with one crash at a durable-write boundary."""
    def __init__(self, crash=None):
        self.files = {}; self.next_inode = 1000; self.crash = crash
        self.release = runner.Release.__new__(runner.Release)
        self.release.args = types.SimpleNamespace(manifest_sha256='a' * 64, browser_proof_sha256='')
        self.release.manifest = manifest()
        self.release.verify = lambda _state: None
        self.release.state = lambda: json.loads(self.read(runner.STAGE / 'state.json')[0])
        self.release.save = self.save
        self.release.n = types.SimpleNamespace(read_file=self.read, descriptor=lambda path: self.read(path)[1],
                                             exclusive_file=self.exclusive, atomic_file=self.atomic,
                                             stamp=lambda: '2026-10-10T00:00:00.000000+00:00', fresh=lambda _value: True,
                                             encoded=self.encoded)
        before = baseline(); applied = {}; backups = {}
        for index, path in enumerate(runner.FILES):
            original = ('old-' + path).encode(); candidate = ('new-' + path).encode()
            self.put(runner.ROOT / path, original, 0o644)
            before['snapshot']['files'][path] = self.read(runner.ROOT / path)[1]
            self.put(runner.STAGE / 'backup' / path, original)
            backups[path] = self.read(runner.STAGE / 'backup' / path)[1]
            self.put(runner.ROOT / path, candidate, 0o644)
            applied[path] = self.read(runner.ROOT / path)[1]
        state = dict(schema='SANJIE_VIDEO_AUDIO_MIX_STATE_V1', phase='applied_pending_browser_validation',
                     seal={'baseline': before}, runnerSha256='b' * 64, manifestSha256='a' * 64,
                     appliedDescriptors=applied, backups=backups, pendingPath=None, pendingAction=None,
                     published=False, accepted=False, productionChanged=True)
        self.put(runner.STAGE / 'state.json', self.encoded(state))
        self.put(runner.STAGE / 'receipt.json', self.encoded(state))
        proof = dict(schema='SANJIE_VIDEO_AUDIO_MIX_BROWSER_PROOF_V1', observedAt='2026-10-10T00:00:00.000000+00:00',
                     manifestSha256='a' * 64, sameAccount=True, audiblePreview=True, downloadedAudioNonzero=True,
                     voicePlayedOnce=True, voiceDurationSeconds=7.574, voiceStartSeconds=0,
                     finalDurationSeconds=15, threeModesPreserved=True, paidCalls=0)
        self.put(runner.STAGE / 'browser-proof.json', self.encoded(proof))
        self.release.args.browser_proof_sha256 = self.read(runner.STAGE / 'browser-proof.json')[1]['sha256']

    @staticmethod
    def encoded(value): return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()

    def put(self, path, raw, mode=0o600):
        self.next_inode += 1
        self.files[str(path)] = (raw, dict(device=24, inode=self.next_inode, uid=0, gid=0, mode=mode, nlink=1,
                                         size=len(raw), sha256=runner.digest(raw)))

    def read(self, path, _limit=None):
        raw, row = self.files[str(path)]; return raw, copy.deepcopy(row)

    def exclusive(self, path, raw, mode=0o600, gid=0):
        if str(path) in self.files: raise FileExistsError(str(path))
        self.put(path, raw, mode)

    def atomic(self, path, raw, expected, mode=None, gid=None):
        actual = self.read(path)[1]
        runner.need(actual == expected, 'TARGET_CAS_FAILED')
        self.put(path, raw, actual['mode'] if mode is None else mode)

    def save(self, state):
        boundary = ('accept_intent_journal' if state['phase'] == 'accepting' else
                    'accept_final_journal' if state['phase'] == 'accepted' else
                    'rollback_previous_journal' if state['phase'] == 'applied_pending_browser_validation' and
                    'preRollbackReceiptDescriptor' in state else None)
        if boundary and boundary == self.crash:
            self.crash = None; raise InterruptedError('simulated crash: ' + boundary)
        self.put(runner.STAGE / 'state.json', self.encoded(state))

    def patch_files(self): return mock.patch.object(runner.os.path, 'lexists', lambda path: str(path) in self.files)


class ReceiptDurabilityReview(unittest.TestCase):
    def test_accept_recovers_receipt_cas_before_final_state_write(self):
        h = ReceiptHarness('accept_final_journal')
        with h.patch_files():
            with self.assertRaises(InterruptedError): h.release.accept()
            self.assertEqual(h.release.state()['phase'], 'accepting')
            h.release.accept()
            self.assertEqual(h.release.state()['phase'], 'accepted')
            self.assertEqual(h.read(runner.STAGE / 'receipt.json')[0], h.read(runner.STAGE / 'state.json')[0])

    def test_accept_recovers_known_orphan_intent_before_journal_write(self):
        h = ReceiptHarness('accept_intent_journal')
        with h.patch_files():
            with self.assertRaises(InterruptedError): h.release.accept()
            self.assertEqual(h.release.state()['phase'], 'applied_pending_browser_validation')
            self.assertIn(str(runner.STAGE / 'accepted-state.json'), h.files)
            h.release.accept()
            self.assertEqual(h.release.state()['phase'], 'accepted')

    def test_unknown_primary_receipt_is_never_replaced_during_accept_recovery(self):
        h = ReceiptHarness('accept_final_journal')
        with h.patch_files():
            with self.assertRaises(InterruptedError): h.release.accept()
            h.put(runner.STAGE / 'receipt.json', b'unknown receipt')
            with self.assertRaisesRegex(RuntimeError, 'ACCEPT_PRIMARY_RECEIPT_DRIFT'): h.release.accept()
            self.assertEqual(h.read(runner.STAGE / 'receipt.json')[0], b'unknown receipt')

    def test_rollback_recovers_previous_receipt_copy_before_journal_and_clears_primary_accepted_flag(self):
        h = ReceiptHarness('rollback_previous_journal')
        with h.patch_files():
            with self.assertRaises(InterruptedError): h.release.rollback()
            self.assertIn(str(runner.STAGE / 'pre-rollback-receipt.json'), h.files)
            h.release.rollback()
            self.assertEqual(h.release.state()['phase'], 'rolled_back')
            primary = json.loads(h.read(runner.STAGE / 'receipt.json')[0])
            self.assertEqual(primary['phase'], 'rolled_back'); self.assertFalse(primary['accepted']); self.assertFalse(primary['published'])


if __name__ == '__main__': unittest.main()
