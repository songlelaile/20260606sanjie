#!/usr/bin/env python3
"""Local fixtures only: no production probes, privileged paths or services."""
import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
import os
import stat
import sys
import tempfile
import types
import unittest
from unittest import mock

SOURCE = os.path.join(os.path.dirname(__file__), 'release-download-restore-20261009.py')


class RestoreTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('restore_fixture', SOURCE)
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)
        # Workspace-contained fixtures avoid macOS's symlinked /var/tmp path.
        self.temp = tempfile.TemporaryDirectory(prefix='.restore-fixture-', dir=os.path.realpath(os.getcwd()))
        self.addCleanup(self.temp.cleanup)
        self.m.BASE = self.temp.name + '/releases'
        self.m.OUT = self.temp.name + '/private'
        self.m.STORE = self.temp.name + '/store'
        self.m.MANIFEST = self.m.OUT + '/download-dedupe-manifest.jsonl'
        self.m.LOCK = self.temp.name + '/lock/build-retention.lock'
        self.m.ROOT_UID = os.geteuid()
        self.m.RESERVE = 4096
        # Production requires uid 0 at every ancestor; local fixtures permit the
        # actual test user and uid 0 ancestors, retaining type/mode checks.
        def local_directory(metadata):
            if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid not in (0, os.geteuid())
                    or metadata.st_mode & 0o022):
                raise self.m.RestoreError('unsafe_directory_owner_or_mode')
        self.m.root_directory = local_directory
        for path in (self.m.BASE, self.m.OUT, self.m.STORE, os.path.dirname(self.m.LOCK)):
            os.makedirs(path, mode=0o700)
        self.release = self.m.BASE + '/20261001-restore-fixture'
        os.makedirs(self.release + '/public/downloads', mode=0o755)
        self.path = self.release + '/public/downloads/shaozhuang-ai-v1.9.83-macos-full.zip'
        self.content = b'byte-identical software ZIP fixture\x00' * 97
        with open(self.path, 'wb') as target:
            target.write(self.content)
        os.chmod(self.path, 0o640)
        os.utime(self.path, ns=(1570000000000000000, 1570000001000000000))
        metadata = os.stat(self.path)
        self.row = {'root': self.release, 'path': self.path,
                    'sha256': hashlib.sha256(self.content).hexdigest(),
                    'directories': [self.m.ident(os.stat(p)) for p in
                                    (self.release, self.release + '/public', self.release + '/public/downloads')],
                    'metadata': {'identity': self.m.ident(metadata), 'size': metadata.st_size,
                                 'mtime_ns': metadata.st_mtime_ns, 'ctime_ns': metadata.st_ctime_ns,
                                 'blocks': metadata.st_blocks * 512, 'mode': stat.S_IMODE(metadata.st_mode),
                                 'uid': metadata.st_uid, 'gid': metadata.st_gid,
                                 'atime_ns': metadata.st_atime_ns, 'nlink': metadata.st_nlink}}
        self.canonical = self.m.STORE + '/' + self.row['sha256'] + '.zip'
        with open(self.canonical, 'wb') as target:
            target.write(self.content)
        os.chmod(self.canonical, 0o444)
        os.unlink(self.path)
        os.symlink(self.canonical, self.path)
        self.snapshot = {'pinned': set(), 'latest': set(), 'symlink_referenced': set(),
                         'nginx': '', 'online': set(), 'port_referenced': set(),
                         'processes': set(), 'mounts': {'/'},
                         'base_device': os.stat(self.m.BASE).st_dev}
        class GuardError(Exception):
            pass
        self.m.guard = types.SimpleNamespace(
            GuardError=GuardError, probe_snapshot=lambda: self.snapshot,
            beneath=lambda path, parent: path == parent or path.startswith(parent + '/'),
            command=lambda args: types.SimpleNamespace(stdout=''))
        self.write_manifest()

    def write_manifest(self, committed=True, row=None, canonical=None):
        row = self.row if row is None else row
        canonical = self.canonical if canonical is None else canonical
        events = [{'event': 'prepared', 'row': row, 'canonical': canonical}]
        if committed:
            events.append({'event': 'committed', 'path': row['path'], 'sha256': row['sha256']})
        with open(self.m.MANIFEST, 'w') as target:
            for event in events:
                target.write(json.dumps(event) + '\n')
        os.chmod(self.m.MANIFEST, 0o600)

    def run_restore(self, apply=False):
        with contextlib.redirect_stdout(io.StringIO()):
            return self.m.run(self.release, apply, 8)

    def test_dry_run_does_not_replace_link(self):
        result = self.run_restore()
        self.assertEqual(result['status'], 'dry_run')
        self.assertEqual(result['selected_files'], 1)
        self.assertTrue(os.path.islink(self.path))

    def test_restore_original_bytes_owner_mode_and_mtime(self):
        result = self.run_restore(True)
        self.assertEqual(result['restored_files'], 1)
        self.assertFalse(os.path.islink(self.path))
        with open(self.path, 'rb') as source:
            self.assertEqual(source.read(), self.content)
        metadata = os.stat(self.path)
        self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o640)
        self.assertEqual(metadata.st_uid, self.row['metadata']['uid'])
        self.assertEqual(metadata.st_gid, self.row['metadata']['gid'])
        self.assertEqual(metadata.st_mtime_ns, self.row['metadata']['mtime_ns'])
        self.assertTrue(os.path.exists(self.canonical))
        self.assertEqual(self.run_restore(True)['already_regular_files'], 1)

    def test_prepared_without_commit_after_replace_is_recoverable(self):
        self.write_manifest(committed=False)
        self.assertEqual(self.run_restore(True)['restored_files'], 1)

    def test_torn_final_commit_retains_complete_prepared_restore(self):
        self.write_manifest(committed=False)
        with open(self.m.MANIFEST, 'ab') as target:
            target.write(b'{"event": "committed", "path": "')
        self.assertEqual(self.run_restore(True)['restored_files'], 1)
        self.assertFalse(os.path.islink(self.path))

    def test_torn_final_prepare_is_ignored_without_mutating_its_original(self):
        untouched = self.release + '/public/downloads/shaozhuang-ai-v1.9.80-macos-full.zip'
        with open(untouched, 'wb') as target:
            target.write(self.content)
        before = os.stat(untouched)
        incomplete_row = dict(self.row, path=untouched)
        incomplete = json.dumps({'event': 'prepared', 'row': incomplete_row,
                                 'canonical': self.canonical}).encode('utf-8')
        with open(self.m.MANIFEST, 'ab') as target:
            target.write(incomplete[:len(incomplete) // 2])
        self.assertEqual(self.run_restore(True)['restored_files'], 1)
        self.assertFalse(os.path.islink(untouched))
        after = os.stat(untouched)
        self.assertEqual((before.st_ino, before.st_size, before.st_mtime_ns),
                         (after.st_ino, after.st_size, after.st_mtime_ns))

    def test_malformed_newline_complete_record_remains_strict(self):
        with open(self.m.MANIFEST, 'ab') as target:
            target.write(b'{"event": "committed", "path": "\n')
        with self.assertRaises(ValueError):
            self.run_restore(True)
        self.assertTrue(os.path.islink(self.path))

    def test_prepared_without_replace_retains_original_regular_file(self):
        self.write_manifest(committed=False)
        os.unlink(self.path)
        with open(self.path, 'wb') as target:
            target.write(self.content)
        self.assertEqual(self.run_restore(True)['already_regular_files'], 1)

    def test_pinned_online_dependency_and_process_references_fail_closed(self):
        for field in ('pinned', 'latest', 'symlink_referenced', 'online', 'port_referenced', 'processes'):
            with self.subTest(field=field):
                self.snapshot[field] = {self.release}
                with self.assertRaises(self.m.RestoreError):
                    self.run_restore(True)
                self.snapshot[field] = set()
                self.assertTrue(os.path.islink(self.path))

    def test_probe_failure_fails_closed(self):
        def unavailable():
            raise self.m.guard.GuardError('test_unavailable')
        self.m.guard.probe_snapshot = unavailable
        with self.assertRaises(self.m.guard.GuardError):
            self.run_restore(True)
        self.assertTrue(os.path.islink(self.path))

    def test_docker_ancestor_mount_protects_release(self):
        def command(args):
            return types.SimpleNamespace(stdout='container' if args[1] == 'ps' else json.dumps([
                {'Mounts': [{'Type': 'bind', 'Source': self.m.BASE}]}]))
        self.m.guard.command = command
        with self.assertRaises(self.m.RestoreError):
            self.run_restore(True)

    def test_nested_mount_fails_closed(self):
        self.snapshot['mounts'].add(self.release + '/public/downloads')
        with self.assertRaises(self.m.RestoreError):
            self.run_restore(True)

    def test_unrecognized_asset_is_not_manifest_allowlisted(self):
        row = dict(self.row, path=self.release + '/public/downloads/customer-upload.zip')
        self.write_manifest(row=row)
        with self.assertRaises(self.m.RestoreError):
            self.run_restore(True)

    def test_noncanonical_link_fails_closed(self):
        os.unlink(self.path)
        os.symlink('/etc/passwd', self.path)
        with self.assertRaises(self.m.RestoreError):
            self.run_restore(True)
        self.assertEqual(os.readlink(self.path), '/etc/passwd')

    def test_corrupt_canonical_fails_closed(self):
        os.chmod(self.canonical, 0o644)
        with open(self.canonical, 'wb') as target:
            target.write(b'corrupted')
        os.chmod(self.canonical, 0o444)
        with self.assertRaises(self.m.RestoreError):
            self.run_restore(True)
        self.assertTrue(os.path.islink(self.path))

    def test_canonical_symlink_fails_closed(self):
        os.unlink(self.canonical)
        os.symlink(self.path, self.canonical)
        with self.assertRaises(OSError):
            self.run_restore(True)

    def test_parent_identity_changed_fails_closed(self):
        downloads = self.release + '/public/downloads'
        os.rename(downloads, downloads + '-original')
        os.mkdir(downloads)
        with self.assertRaises(self.m.RestoreError):
            self.run_restore(True)

    def test_parent_symlink_fails_closed(self):
        downloads = self.release + '/public/downloads'
        os.rename(downloads, downloads + '-original')
        os.symlink(downloads + '-original', downloads)
        with self.assertRaises(OSError):
            self.run_restore(True)

    def test_manifest_permissions_must_be_0600(self):
        os.chmod(self.m.MANIFEST, 0o644)
        with self.assertRaises(self.m.RestoreError):
            self.run_restore(True)

    def test_unknown_commit_and_duplicate_prepare_fail_closed(self):
        for extra in ({'event': 'committed', 'path': '/unexpected', 'sha256': self.row['sha256']},
                      {'event': 'prepared', 'row': self.row, 'canonical': self.canonical}):
            with self.subTest(event=extra['event']):
                self.write_manifest()
                with open(self.m.MANIFEST, 'a') as target:
                    target.write(json.dumps(extra) + '\n')
                with self.assertRaises(self.m.RestoreError):
                    self.run_restore(True)

    def test_space_reserve_and_budget_fail_closed(self):
        with mock.patch.object(self.m.os, 'fstatvfs', return_value=types.SimpleNamespace(f_bavail=0, f_frsize=4096)):
            with self.assertRaises(self.m.RestoreError):
                self.run_restore(True)
        with mock.patch.object(self.m, 'GIB', 1):
            with self.assertRaises(self.m.RestoreError):
                self.run_restore(True)
        self.assertTrue(os.path.islink(self.path))

    def test_failure_after_replace_is_reported_partial(self):
        original = self.m.hash_fd
        def fail_restored(fd):
            if stat.S_IMODE(os.fstat(fd).st_mode) == 0o640:
                raise self.m.RestoreError('test_final_verification_failed')
            return original(fd)
        with mock.patch.object(self.m, 'hash_fd', side_effect=fail_restored):
            with self.assertRaises(self.m.ReplacedError):
                self.run_restore(True)
        with open(self.m.OUT + '/' + self.m.RESULT_NAME) as source:
            result = json.load(source)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['unverified_replacements'], 1)

    def test_global_lock_contention_blocks_main(self):
        fd = os.open(self.m.LOCK, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with mock.patch.object(self.m, 'load_guard', return_value=self.m.guard), mock.patch.object(
                    sys, 'argv', ['restore', '--release', self.release, '--apply']), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(self.m.main(), 1)
            self.assertTrue(os.path.islink(self.path))
        finally:
            os.close(fd)


if __name__ == '__main__':
    unittest.main(verbosity=2)
