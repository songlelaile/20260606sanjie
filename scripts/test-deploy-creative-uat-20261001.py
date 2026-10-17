import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('uat_runner', Path(__file__).with_name('deploy-creative-uat-20261001.py'))
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)

CONFIG = '''server {
    listen 80;
    server_name shaozhuangai.com;
    return 301 https://shaozhuangai.com$request_uri;
}
server {
    listen 443 ssl;
    server_name shaozhuangai.com www.shaozhuangai.com;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header Content-Security-Policy "default-src 'self'; img-src * data:" always;
    location /api/ {
        proxy_pass http://127.0.0.1:31918;
        proxy_redirect ~^https?://(?:localhost|127[.]0[.]0[.]1):[0-9]+(/.*)$ https://shaozhuangai.com$1;
    }
    location / {
        proxy_pass http://127.0.0.1:31918;
    }
}
server {
    listen 443 ssl;
    server_name example.com;
    location / { proxy_pass http://127.0.0.1:9999; }
}
'''


class RoutingTests(unittest.TestCase):
    def test_login_redirect_accepts_relative_and_same_https_origin(self):
        self.assertTrue(runner.login_redirect('/login'))
        self.assertTrue(runner.login_redirect('https://shaozhuangai.com/login'))

    def test_login_redirect_rejects_changed_origin_path_query_and_protocol(self):
        for location in (None, '', 'https://outside.example/login', 'http://shaozhuangai.com/login',
                         '/other', '/login?next=outside', '//outside.example/login'):
            self.assertFalse(runner.login_redirect(location), location)

    def test_default_stays_production_and_all_selected_proxies_change(self):
        changed, count = runner.routing_configuration(CONFIG)
        self.assertEqual(count, 2)
        self.assertIn('default 31918;', changed)
        self.assertIn('"20261001" 32011;', changed)
        self.assertEqual(changed.count('proxy_pass http://127.0.0.1:$sanjie_app_port;'), 2)
        self.assertIn('proxy_pass http://127.0.0.1:9999;', changed)

    def test_uri_and_concrete_proxy_redirect_are_preserved(self):
        changed, _ = runner.routing_configuration(CONFIG)
        self.assertIn('https://shaozhuangai.com$request_uri;', changed)
        self.assertIn('https://shaozhuangai.com$1;', changed)
        self.assertNotIn('$sanjie_app_port/;', changed)

    def test_marker_mismatch_block_and_exact_entry_exemptions(self):
        changed, _ = runner.routing_configuration(CONFIG)
        self.assertIn('"20261001:creative-20261001" 0;', changed)
        self.assertIn('~:creative-20261001$ 1;', changed)
        self.assertIn('if ($sanjie_uat_block) { return 409; }', changed)
        self.assertIn('"/uat/creative-20261001:1" 0;', changed)
        self.assertIn('"/uat/creative-exit:1" 0;', changed)

    def test_entry_and_exit_keep_inherited_security_headers(self):
        changed, _ = runner.routing_configuration(CONFIG)
        self.assertEqual(changed.count('add_header X-Frame-Options SAMEORIGIN always;'), 3)
        self.assertEqual(changed.count('add_header Content-Security-Policy'), 3)
        self.assertIn('Max-Age=86400', changed)
        self.assertIn('sanjie_session_creative_uat=;', changed)
        self.assertNotIn('Set-Cookie "sanjie_session=;', changed)

    def test_http_inherited_headers_are_copied_when_server_has_none(self):
        source = CONFIG.replace('    add_header X-Frame-Options SAMEORIGIN always;\n', '').replace(
            '    add_header Content-Security-Policy "default-src \'self\'; img-src * data:" always;\n', '')
        changed, _ = runner.routing_configuration(source, ['add_header X-Content-Type-Options nosniff always;'])
        self.assertEqual(changed.count('X-Content-Type-Options nosniff'), 2)

    def test_existing_route_or_default_redirect_fails_closed(self):
        for source in (runner.MARKER + CONFIG, CONFIG + '\nproxy_redirect default;'):
            with self.assertRaises(RuntimeError):
                runner.routing_configuration(source)

    def test_unexpected_virtual_host_is_not_modified(self):
        with self.assertRaises(RuntimeError):
            runner.routing_configuration(CONFIG.replace('shaozhuangai.com', 'unrelated.example'))

    def test_quotes_comments_and_nested_locations_do_not_break_headers(self):
        block = '''server {
          # comment with } and {
          add_header Content-Security-Policy "default-src 'self'; script-src 'none'" always;
          location / { add_header X-Only-This-Location yes; }
        }'''
        headers = runner.direct_add_headers(block)
        self.assertEqual(len(headers), 1)
        self.assertIn("script-src 'none'", headers[0])


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.bundle = self.root / 'candidate.tar.gz'

    def tearDown(self):
        self.directory.cleanup()

    def make_bundle(self, additional=()):
        with tarfile.open(self.bundle, 'w:gz') as archive:
            for name in ('./prisma/schema.prisma', './package.json', './src/lib/auth.ts',
                         './src/app/dashboards/operating-network/page.tsx', *additional):
                item = tarfile.TarInfo(name)
                item.size = 2
                archive.addfile(item, io.BytesIO(b'{}'))
        return runner.digest(self.bundle.read_bytes())

    def test_dot_paths_and_apple_metadata_do_not_change_sealed_bundle(self):
        sha = self.make_bundle(('./._src', './src/._index.ts', './.eslintrc.json'))
        archive, members = runner.bundle_members(self.bundle, sha)
        self.assertIn('src/lib/auth.ts', [item.name for item in members])
        self.assertFalse(any('._' in item.name for item in members))
        archive.close()
        self.assertEqual(runner.digest(self.bundle.read_bytes()), sha)

    def test_traversal_and_private_state_are_rejected(self):
        for path in ('../secret', './.env', './src/.env.local', './node_modules/index.js',
                     './public/server.key', '/root/secret'):
            sha = self.make_bundle((path,))
            with self.assertRaises(RuntimeError, msg=path):
                runner.bundle_members(self.bundle, sha)

    def test_wrong_sha_is_rejected_before_extraction(self):
        self.make_bundle()
        with self.assertRaises(RuntimeError):
            runner.bundle_members(self.bundle, '0' * 64)

    def test_archive_symlinks_are_rejected(self):
        with tarfile.open(self.bundle, 'w:gz') as archive:
            item = tarfile.TarInfo('src/external')
            item.type = tarfile.SYMTYPE
            item.linkname = '/etc'
            archive.addfile(item)
        with self.assertRaises(RuntimeError):
            runner.bundle_members(self.bundle, runner.digest(self.bundle.read_bytes()))

    def test_existing_destination_symlink_cannot_escape_release(self):
        sha = self.make_bundle()
        archive, members = runner.bundle_members(self.bundle, sha)
        output = self.root / 'output'
        outside = self.root / 'outside'
        output.mkdir()
        outside.mkdir()
        (output / 'src').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(RuntimeError):
            runner.safe_extract(archive, members, output)
        self.assertEqual(list(outside.iterdir()), [])
        archive.close()


class RedactionTests(unittest.TestCase):
    def test_connection_url_and_password_hash_are_never_logged(self):
        result = runner.scrub('postgresql://role:private@localhost/db scrypt$16384$8$1$salt$hash')
        self.assertNotIn('private', result)
        self.assertNotIn('$hash', result)
        self.assertIn('redacted', result)


class SupplementTests(unittest.TestCase):
    def test_only_missing_historical_assets_are_copied(self):
        with tempfile.TemporaryDirectory() as directory:
            origin, target = Path(directory) / 'origin', Path(directory) / 'target'
            origin.mkdir();target.mkdir()
            (origin / 'same').write_text('historical')
            (target / 'same').write_text('current')
            (origin / 'missing').mkdir()
            (origin / 'missing' / 'asset').write_text('old asset')
            self.assertEqual(runner.copy_missing_assets(origin, target), 2)
            self.assertEqual((target / 'same').read_text(), 'current')
            self.assertEqual((target / 'missing' / 'asset').read_text(), 'old asset')
            self.assertEqual(runner.copy_missing_assets(origin, target), 0)


class RollbackTests(unittest.TestCase):
    def test_historical_backup_cannot_replace_new_concurrent_formal_release(self):
        with mock.patch.object(runner, 'state', return_value={'rollback_requires_fresh_review': True}), \
                mock.patch.object(runner, 'atomic_config') as replace:
            with self.assertRaisesRegex(RuntimeError, 'fresh reviewed rollback'):
                runner.rollback(None)
            replace.assert_not_called()

    def test_validation_failure_restores_only_our_baseline(self):
        self.check_rollback_validation_failure(concurrent_edit=False)

    def test_concurrent_edit_is_not_overwritten_after_validation_failure(self):
        self.check_rollback_validation_failure(concurrent_edit=True)

    def check_rollback_validation_failure(self, concurrent_edit):
        with tempfile.TemporaryDirectory() as directory:
            config, backup = Path(directory) / 'sanjie.conf', Path(directory) / 'backup'
            config.write_bytes(b'routed')
            backup.write_bytes(b'baseline')
            deployment = {'nginx_backup': str(backup),
                          'nginx_routed_sha256': runner.digest(b'routed'),
                          'nginx_sha256': runner.digest(b'baseline')}
            def reject_validation(_argv):
                if concurrent_edit:
                    config.write_bytes(b'concurrent')
                raise RuntimeError('nginx validation failed')
            with mock.patch.object(runner, 'CONF', config), \
                    mock.patch.object(runner, 'state', return_value=deployment), \
                    mock.patch.object(runner, 'run', side_effect=reject_validation):
                with self.assertRaises(RuntimeError):
                    runner.rollback(None)
            self.assertEqual(config.read_bytes(), b'concurrent' if concurrent_edit else b'routed')


if __name__ == '__main__':
    unittest.main()
