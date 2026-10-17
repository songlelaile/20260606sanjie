import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('static_patch', Path(__file__).with_name('patch-creative-uat-static-20261001.py'))
patch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(patch)


class StaticPatchSafetyTests(unittest.TestCase):
    def inventories(self):
        old = {name: {'sha256': 'old', 'bytes': 1} for name in patch.ALLOWED}
        old.update({f'src/file-{i}.ts': {'sha256': 'same', 'bytes': 2} for i in range(491)})
        new = {name: dict(value) for name, value in old.items()}
        for name in patch.ALLOWED:
            new[name] = {'sha256': 'new', 'bytes': 3}
        return old, new

    def test_only_sealed_three_files_can_change(self):
        old, new = self.inventories()
        self.assertEqual(set(patch.changed_files(old, new)), patch.ALLOWED)

    def test_business_ts_change_is_rejected(self):
        old, new = self.inventories()
        new['src/file-0.ts']['sha256'] = 'extra'
        with self.assertRaisesRegex(RuntimeError, 'exactly the three'):
            patch.changed_files(old, new)

    def test_added_or_deleted_source_is_rejected(self):
        old, new = self.inventories()
        del new['src/file-0.ts']
        new['src/new.ts'] = {'sha256': 'extra', 'bytes': 2}
        with self.assertRaisesRegex(RuntimeError, 'inventory changed'):
            patch.changed_files(old, new)

    def test_successful_cas_preserves_mode_and_supports_own_write_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / 'asset.js'
            path.write_bytes(b'old')
            path.chmod(0o640)
            patch.replace_if_expected(path, b'old', b'new')
            self.assertEqual(path.read_bytes(), b'new')
            self.assertEqual(path.stat().st_mode & 0o777, 0o640)
            patch.replace_if_expected(path, b'new', b'old')
            self.assertEqual(path.read_bytes(), b'old')

    def test_concurrent_write_blocks_apply_and_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / 'asset.js'
            path.write_bytes(b'concurrent')
            for expected, content in ((b'old', b'new'), (b'new', b'old')):
                with self.assertRaisesRegex(RuntimeError, 'Concurrent target'):
                    patch.replace_if_expected(path, expected, content)
                self.assertEqual(path.read_bytes(), b'concurrent')

    def test_existing_temporary_is_not_followed_or_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / 'asset.js'
            path.write_bytes(b'old')
            staged = path.with_name(path.name + '.creative-static-tmp')
            staged.write_bytes(b'other')
            patch.replace_if_expected(path, b'old', b'new')
            self.assertEqual(staged.read_bytes(), b'other')
            self.assertEqual(path.read_bytes(), b'new')

    def test_symlink_target_and_parent_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            real = root / 'real'
            real.mkdir()
            target = real / 'asset.js'
            target.write_bytes(b'old')
            file_link = root / 'file-link.js'
            file_link.symlink_to(target)
            parent_link = root / 'parent-link'
            parent_link.symlink_to(real, target_is_directory=True)
            for path in (file_link, parent_link / 'asset.js'):
                with self.assertRaisesRegex(RuntimeError, 'symlink'):
                    patch.replace_if_expected(path, b'old', b'new')
            self.assertEqual(target.read_bytes(), b'old')

    def test_cas_detects_change_during_staging(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / 'asset.js'
            path.write_bytes(b'old')
            original_fsync = patch.os.fsync
            def fsync_and_race(descriptor):
                original_fsync(descriptor)
                path.write_bytes(b'concurrent')
            with mock.patch.object(patch.os, 'fsync', fsync_and_race):
                with self.assertRaisesRegex(RuntimeError, 'changed during'):
                    patch.replace_if_expected(path, b'old', b'new')
            self.assertEqual(path.read_bytes(), b'concurrent')
            self.assertEqual(list(path.parent.glob('*.creative-static-*')), [])

    def test_new_proof_is_private_and_only_own_bytes_can_be_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / 'proof.json'
            patch.replace_if_expected(path, None, b'proof')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            patch.restore_if_own_write(path, None, b'proof')
            self.assertFalse(path.exists())

    def test_dangling_proof_and_parent_symlinks_never_write_outside(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            outside = root / 'outside.json'
            path = root / 'proof.json'
            path.symlink_to(outside)
            with self.assertRaisesRegex(RuntimeError, 'symlink'):
                patch.replace_if_expected(path, None, b'proof')
            self.assertFalse(outside.exists())
            self.assertTrue(path.is_symlink())

    def test_new_proof_concurrent_bytes_block_creation_and_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / 'proof.json'
            path.write_bytes(b'concurrent')
            with self.assertRaisesRegex(RuntimeError, 'Concurrent new proof'):
                patch.replace_if_expected(path, None, b'proof')
            with self.assertRaisesRegex(RuntimeError, 'Concurrent new proof'):
                patch.restore_if_own_write(path, None, b'proof')
            self.assertEqual(path.read_bytes(), b'concurrent')



if __name__ == '__main__':
    unittest.main()
