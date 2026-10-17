"""Execute the frozen unpacker with in-memory IO only; never open/write /root or /opt."""
import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import types
import unittest
from unittest import mock

BASE = Path(__file__).resolve().parents[1] / '.codex-deploy/video-preview-fix-20261010'
SOURCE = (BASE / 'deploy/unpack-video-preview-v1.py').read_text()
METADATA = json.loads((BASE / 'frozen-v1-metadata.json').read_text())
ARCHIVE = (BASE / 'sanjie-video-preview-fix-20261010-v1.tar.gz').read_bytes()
STAGE = Path('/opt/sanjie-video-preview-fix-20261010-v1')


def entries():
    with tarfile.open(fileobj=io.BytesIO(ARCHIVE), mode='r:gz') as handle:
        return [(copy.copy(member), handle.extractfile(member).read()) for member in handle.getmembers()]


def archive(items):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as handle:
        for member, raw in items:
            handle.addfile(member, io.BytesIO(raw) if member.isfile() else None)
    return buffer.getvalue()


class Output:
    def __init__(self): self.raw = b''
    def __enter__(self): return self
    def __exit__(self, *_args): return False
    def write(self, raw): self.raw += raw; return len(raw)
    def flush(self): pass


class Harness:
    def __init__(self, raw=ARCHIVE, repin=False, file_overrides=None, parent_overrides=None, stage_exists=False):
        self.raw = raw; self.writes = {}; self.created = []; self.outputs = {}; self.closed = []
        self.file = dict(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_nlink=1, st_size=len(raw))
        self.file.update(file_overrides or {})
        self.parent = dict(st_mode=stat.S_IFDIR | 0o755, st_uid=0)
        self.parent.update(parent_overrides or {})
        self.stage_exists = stage_exists
        source = SOURCE
        if repin: source = source.replace(METADATA['archiveSha256'], hashlib.sha256(raw).hexdigest())
        self.code = compile(source, str(BASE / 'deploy/unpack-video-preview-v1.py'), 'exec')

    def open(self, path, flags, mode=None):
        if flags == os.O_RDONLY | os.O_NOFOLLOW:
            if Path(path) != Path('/root/sanjie-video-preview-fix-20261010-v1.tar.gz'): raise AssertionError('Unexpected archive read')
            return 10
        if flags != os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW or mode != 0o600: raise AssertionError('Unsafe write flags')
        path = Path(path)
        if STAGE not in path.parents: raise AssertionError('Escaped private stage')
        fd = 100 + len(self.writes)
        self.writes[path] = fd; self.outputs[fd] = Output()
        return fd

    def mkdir(self, path, **kwargs):
        path = Path(path); self.created.append((path, kwargs))
        if path == STAGE and self.stage_exists: raise FileExistsError('Existing stage')
        if path != STAGE and STAGE not in path.parents: raise AssertionError('Directory outside new stage')

    def run(self):
        output = io.StringIO()
        with mock.patch.object(os, 'open', self.open), mock.patch.object(os, 'fstat', return_value=types.SimpleNamespace(**self.file)), mock.patch.object(os, 'read', return_value=self.raw), mock.patch.object(os, 'close', side_effect=self.closed.append), mock.patch.object(os, 'fdopen', side_effect=lambda fd, _mode, closefd: self.outputs[fd]), mock.patch.object(os, 'fsync'), mock.patch.object(os, 'umask') as umask, mock.patch.object(Path, 'lstat', return_value=types.SimpleNamespace(**self.parent)), mock.patch.object(Path, 'mkdir', lambda path, **kwargs: self.mkdir(path, **kwargs)), contextlib.redirect_stdout(output):
            exec(self.code, {})
            umask.assert_called_once_with(0o077)
        return output.getvalue()


class UnpackerBoundaryReview(unittest.TestCase):
    def test_frozen_archive_and_unpacked_member_hashes_match_all_metadata(self):
        self.assertEqual(len(ARCHIVE), 73020)
        self.assertEqual(hashlib.sha256(ARCHIVE).hexdigest(), METADATA['archiveSha256'])
        self.assertEqual(hashlib.sha256(SOURCE.encode()).hexdigest(), METADATA['unpackerSha256'])
        h = Harness(); self.assertIn('6_FILES_NO_PRODUCTION_CHANGE', h.run())
        self.assertEqual({str(path.relative_to(STAGE)) for path in h.writes}, set(METADATA['files']))
        for name, expected in METADATA['files'].items():
            raw = h.outputs[h.writes[STAGE / name]].raw
            self.assertEqual(len(raw), expected['bytes']); self.assertEqual(hashlib.sha256(raw).hexdigest(), expected['sha256'])
        self.assertEqual(h.created[0], (STAGE, {'mode': 0o700}))

    def test_unknown_archive_hash_rejected_before_stage_creation_or_writes(self):
        h = Harness(ARCHIVE[:-1] + bytes([ARCHIVE[-1] ^ 1]))
        with self.assertRaises(AssertionError): h.run()
        self.assertEqual(h.created, []); self.assertEqual(h.writes, {})

    def test_traversal_absolute_extra_duplicate_link_mode_and_empty_members_rejected_before_writes(self):
        for kind in ('traversal', 'absolute', 'extra', 'duplicate', 'symlink', 'hardlink', 'mode', 'empty'):
            items = entries(); member, raw = items[-1]
            if kind == 'traversal': member.name = '../outside'
            if kind == 'absolute': member.name = '/opt/production-change'
            if kind == 'extra': items.append((copy.copy(member), raw)); items[-1][0].name = 'unexpected.py'
            if kind == 'duplicate': member.name = items[0][0].name
            if kind == 'symlink': member.type = tarfile.SYMTYPE; member.linkname = '/opt/production'; member.size = 0
            if kind == 'hardlink': member.type = tarfile.LNKTYPE; member.linkname = items[0][0].name; member.size = 0
            if kind == 'mode': member.mode = 0o644
            if kind == 'empty': member.size = 0; items[-1] = (member, b'')
            h = Harness(archive(items), repin=True)
            with self.subTest(kind=kind), self.assertRaises(AssertionError): h.run()
            self.assertEqual(h.created, []); self.assertEqual(h.writes, {})

    def test_runner_manifest_query_pin_mismatch_rejected_before_stage_creation(self):
        for name in ('deploy-video-preview-fix.py', 'overlay-manifest.json', 'readonly-query.cjs'):
            items = entries()
            for index, (member, raw) in enumerate(items):
                if member.name == name: items[index] = (member, bytes([raw[0] ^ 1]) + raw[1:])
            h = Harness(archive(items), repin=True)
            with self.subTest(member=name), self.assertRaises(AssertionError): h.run()
            self.assertEqual(h.created, []); self.assertEqual(h.writes, {})

    def test_archive_must_be_regular_root_owned_single_link_and_bounded(self):
        for field, value in [('st_mode', stat.S_IFLNK | 0o600), ('st_uid', 501), ('st_nlink', 2), ('st_size', 1024 * 1024)]:
            h = Harness(file_overrides={field: value})
            with self.subTest(field=field), self.assertRaises(AssertionError): h.run()
            self.assertEqual(h.created, []); self.assertEqual(h.writes, {})

    def test_non_root_writable_or_link_parent_rejected_before_stage_creation(self):
        for overrides in ({'st_uid': 501}, {'st_mode': stat.S_IFDIR | 0o777}, {'st_mode': stat.S_IFLNK | 0o755}):
            h = Harness(parent_overrides=overrides)
            with self.subTest(parent=overrides), self.assertRaises(AssertionError): h.run()
            self.assertEqual(h.created, []); self.assertEqual(h.writes, {})

    def test_existing_stage_is_not_reused_and_no_member_is_written(self):
        h = Harness(stage_exists=True)
        with self.assertRaises(FileExistsError): h.run()
        self.assertEqual(h.writes, {})


if __name__ == '__main__': unittest.main()
