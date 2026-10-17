"""Run the established unsafe-tar fixtures against V2, without real /root or /opt IO."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import unittest

SCRIPTS = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('preview_v2_unpacked_memory_review', SCRIPTS / 'video-preview-unpacker-review.test.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
metadata = json.loads((m.BASE / 'frozen-v2-metadata.json').read_text())
m.SOURCE = (m.BASE / 'deploy-v2/unpack-video-preview-v2.py').read_text()
m.ARCHIVE = (m.BASE / 'sanjie-video-preview-fix-20261010-v2.tar.gz').read_bytes()
m.STAGE = Path('/opt/sanjie-video-preview-fix-20261010-v2')
m.METADATA = {'archiveSha256': metadata['archive']['sha256'], 'unpackerSha256': metadata['unpacker']['sha256'],
              'files': {name: {'bytes': row['size'], 'sha256': row['sha256']} for name, row in metadata['files'].items()}}
OriginalHarness = m.Harness


class Harness(OriginalHarness):
    def __init__(self, raw=None, **kwargs):
        super().__init__(m.ARCHIVE if raw is None else raw, **kwargs)

    def open(self, path, flags, mode=None):
        if flags == os.O_RDONLY | os.O_NOFOLLOW:
            if Path(path) != Path('/root/sanjie-video-preview-fix-20261010-v2.tar.gz'):
                raise AssertionError('Unexpected archive read')
            return 10
        return super().open(path, flags, mode)


m.Harness = Harness


class V2UnpackerReview(m.UnpackerBoundaryReview):
    def test_frozen_archive_and_unpacked_member_hashes_match_all_metadata(self):
        self.assertEqual(len(m.ARCHIVE), metadata['archive']['size'])
        self.assertEqual(hashlib.sha256(m.ARCHIVE).hexdigest(), metadata['archive']['sha256'])
        self.assertEqual(hashlib.sha256(m.SOURCE.encode()).hexdigest(), metadata['unpacker']['sha256'])
        h = Harness()
        self.assertIn('6_FILES_NO_PRODUCTION_CHANGE', h.run())
        self.assertEqual({str(path.relative_to(m.STAGE)) for path in h.writes}, set(metadata['files']))
        for name, expected in metadata['files'].items():
            raw = h.outputs[h.writes[m.STAGE / name]].raw
            self.assertEqual(len(raw), expected['size'])
            self.assertEqual(hashlib.sha256(raw).hexdigest(), expected['sha256'])
        self.assertEqual(h.created[0], (m.STAGE, {'mode': 0o700}))

    def test_v2_changes_only_frozen_pins_and_new_archive_stage_literals(self):
        old_source = (m.BASE / 'deploy/unpack-video-preview-v1.py').read_text()
        old = json.loads((m.BASE / 'frozen-v1-metadata.json').read_text())
        replacements = {old['archiveSha256']: metadata['archive']['sha256'],
                        old['files']['deploy-video-preview-fix.py']['sha256']: metadata['files']['deploy-video-preview-fix.py']['sha256'],
                        old['files']['readonly-query.cjs']['sha256']: metadata['files']['readonly-query.cjs']['sha256'],
                        '/root/sanjie-video-preview-fix-20261010-v1.tar.gz': '/root/sanjie-video-preview-fix-20261010-v2.tar.gz',
                        '/opt/sanjie-video-preview-fix-20261010-v1': str(m.STAGE)}
        for before, after in replacements.items():
            old_source = old_source.replace(before, after)
        self.assertEqual(m.SOURCE, old_source)


if __name__ == '__main__':
    unittest.main()
