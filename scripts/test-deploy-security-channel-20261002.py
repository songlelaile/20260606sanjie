#!/usr/bin/env python3
"""Offline fixtures only. Never contacts a website, PM2, Nginx or a database."""
import importlib.util
import inspect
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('security_deploy', Path(__file__).with_name('deploy-security-channel-20261002.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.overlay = self.root / 'overlay'
        self.overlay.mkdir()
        self.manifest = self.root / 'manifest.json'

    def tearDown(self):
        self.tmp.cleanup()

    def file(self, filename, data=b'fixture'):
        filename.parent.mkdir(parents=True, exist_ok=True)
        filename.write_bytes(data)
        return m.descriptor(filename)

    def seal(self, policy='protected'):
        files = {}
        for name in m.REQUIRED_OVERLAY | m.REQUIRED_TESTS:
            content = Path(name).read_bytes() if name in m.SQL_FILES else b'fixture'
            files[name] = {'before': None, 'after': self.file(self.overlay / name, content)}
        self.manifest.write_text(json.dumps({'schema': m.MANIFEST_SCHEMA, 'sourceCommit': 'a'*40, 'downloadPolicy': policy, 'sourceInventory': {'count': 1, 'sha256': 'b'*64}, 'files': files}))
        return m.descriptor(self.manifest)['sha256']

    def nginx(self):
        return b'''# fixture
map $cookie_sanjie_creative_uat $sanjie_app_port { default 31948; "20261001" 32011; }
map $http_x_updater $updater_port { default 31911; "special" 31948; }
server { listen 443 ssl; location / { proxy_pass http://127.0.0.1:$sanjie_app_port; }
location ^~ /sower-work/app/ { proxy_pass http://127.0.0.1:32150; }
location /api/tools/updates/ { proxy_pass http://127.0.0.1:$updater_port; }
location /media/tutorials/ { alias /srv/sanjie-media/tutorials/; } }
'''

    def test_defaults_are_exact_current_live_identity(self):
        self.assertEqual((m.OLD_PORT, m.NEW_PORT), (31948, 31953))
        self.assertEqual(str(m.BASE), '/opt/sanjie-releases/20261002-plugin-website-navigation-v4')
        self.assertEqual(m.OLD_NAME, 'sanjie-plugin-website-navigation-20261002-v4')
        self.assertEqual(m.EXPECTED_NGINX, '99d25d31140e85e7bf4e2413c53aecbd3d180990c88d662077acd18338a71f4b')

    def test_exact_bundle_and_download_choice_are_sealed(self):
        for policy in ('protected', 'public'):
            with self.subTest(policy=policy):
                sha = self.seal(policy)
                self.assertEqual(m.verify_bundle(self.overlay, self.manifest, sha)['downloadPolicy'], policy)

    def test_manifest_requires_explicit_download_choice(self):
        self.seal()
        value = m.read_json(self.manifest)
        value.pop('downloadPolicy')
        self.manifest.write_text(json.dumps(value))
        with self.assertRaisesRegex(RuntimeError, 'download policy'):
            m.verify_bundle(self.overlay, self.manifest, m.descriptor(self.manifest)['sha256'])

    def test_missing_critical_file_rejected(self):
        self.seal()
        value = m.read_json(self.manifest)
        value['files'].pop('src/lib/security-rate-limit.ts')
        (self.overlay / 'src/lib/security-rate-limit.ts').unlink()
        self.manifest.write_text(json.dumps(value))
        with self.assertRaisesRegex(RuntimeError, 'scope incomplete'):
            m.verify_bundle(self.overlay, self.manifest, m.descriptor(self.manifest)['sha256'])

    def test_forbids_unrelated_overlay_and_credentials(self):
        for name in ('.env', 'package.json', 'src/components/AppShell.tsx', 'public/downloads/plugin.zip', 'prisma/migrations/unrelated/migration.sql'):
            with self.subTest(name=name):
                self.seal()
                value = m.read_json(self.manifest)
                value['files'][name] = {'before': None, 'after': self.file(self.overlay / name)}
                self.manifest.write_text(json.dumps(value))
                with self.assertRaisesRegex(RuntimeError, 'scope incomplete'):
                    m.verify_bundle(self.overlay, self.manifest, m.descriptor(self.manifest)['sha256'])
                (self.overlay / name).unlink()

    def test_overlay_symlink_mutation_and_unlisted_file_rejected(self):
        sha = self.seal()
        filename = self.overlay / 'src/lib/security-rate-limit.ts'
        filename.write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'bytes differ'):
            m.verify_bundle(self.overlay, self.manifest, sha)
        sha = self.seal()
        filename.unlink()
        filename.symlink_to(self.file_target())
        with self.assertRaisesRegex(RuntimeError, 'Linked'):
            m.verify_bundle(self.overlay, self.manifest, sha)
        filename.unlink()
        sha = self.seal()
        self.file(self.overlay / 'extra.txt')
        with self.assertRaisesRegex(RuntimeError, 'extra or missing'):
            m.verify_bundle(self.overlay, self.manifest, sha)

    def file_target(self):
        target = self.root / 'outside'
        self.file(target)
        return target

    def test_source_compare_and_swap(self):
        old = {'size': 1, 'sha256': 'a'*64}
        new = {'size': 2, 'sha256': 'b'*64}
        self.assertEqual(m.expected_candidate({'x': old}, {'files': {'x': {'before': old, 'after': new}}}), {'x': new})
        with self.assertRaisesRegex(RuntimeError, 'file CAS'):
            m.expected_candidate({'x': old}, {'files': {'x': {'before': None, 'after': new}}})

    def test_migrations_are_exact_create_only_and_support_owned_foreign_keys(self):
        self.assertEqual(len(m.SQL_FILES), 2)
        for name in m.MIGRATIONS:
            statements = m.validate_sql(name, Path('prisma/migrations', name, 'migration.sql').read_text())
            self.assertTrue(all(sql.startswith('CREATE ') for sql in statements))
        source = Path('prisma/migrations/20261002143000_security_rate_bucket/migration.sql').read_text()
        for addition in ('DROP TABLE "User";', 'ALTER TABLE "User" ADD x INT;', 'UPDATE "User" SET name=\'x\';', 'CREATE TABLE "Other" ("id" INT);', 'CREATE INDEX "Bad" ON "User" ("id");'):
            with self.subTest(addition=addition), self.assertRaises(RuntimeError):
                m.validate_sql('20261002143000_security_rate_bucket', source + addition)

    def test_sql_requires_complete_lexical_statements(self):
        for text in ('CREATE TABLE "SecurityRateBucket" ("id" INT)', 'DO $$ BEGIN END $$;', '/* comment */ CREATE TABLE "SecurityRateBucket" ("id" INT);'):
            with self.subTest(text=text), self.assertRaises(RuntimeError):
                m.validate_sql('20261002143000_security_rate_bucket', text)

    def test_migration_before_must_be_null(self):
        self.seal()
        value = m.read_json(self.manifest)
        name = sorted(m.SQL_FILES)[0]
        value['files'][name]['before'] = value['files'][name]['after']
        self.manifest.write_text(json.dumps(value))
        with self.assertRaisesRegex(RuntimeError, 'must be new'):
            m.verify_bundle(self.overlay, self.manifest, m.descriptor(self.manifest)['sha256'])

    def test_nginx_swaps_only_one_default_and_retains_other_ports(self):
        original = self.nginx()
        changed = m.nginx_retarget(original, 31948, 31953, 'default 31948;')
        self.assertEqual(changed, original.replace(b'default 31948;', b'default 31953;', 1))
        self.assertIn(b'"special" 31948;', changed)
        self.assertIn(b'127.0.0.1:32150', changed)
        self.assertIn(b'"20261001" 32011;', changed)

    def test_nginx_rejects_ambiguous_or_wrong_target(self):
        for data in (self.nginx().replace(b'default 31948;', b'default 31949;'), self.nginx() + b'map $cookie_sanjie_creative_uat $sanjie_app_port { default 31948; }', self.nginx() + b'set $sanjie_app_port 31948;'):
            with self.subTest(data=data), self.assertRaises(RuntimeError):
                m.nginx_retarget(data, 31948, 31953)
        for target in ('31948', 'default 31911;', 'default 31948;\nlocation / { deny all; }'):
            with self.subTest(target=target), self.assertRaises(RuntimeError):
                m.nginx_retarget(self.nginx(), 31948, 31953, target)

    def test_nginx_external_cas_never_overwrites_other_deploy(self):
        filename = self.root / 'nginx.conf'
        before = self.file(filename, b'old')
        filename.write_bytes(b'other-deployment')
        with self.assertRaisesRegex(RuntimeError, 'Compare-and-swap'):
            m.atomic_bytes(filename, b'ours', before['sha256'])
        self.assertEqual(filename.read_bytes(), b'other-deployment')

    def test_clone_schema_is_private_but_environment_db_media_and_dependencies_are_references(self):
        baseline = self.root / 'baseline'
        self.file(baseline / 'package.json', b'{}')
        self.file(baseline / 'src/fixture.ts')
        self.file(baseline / 'prisma/schema.prisma')
        self.file(baseline / 'prisma/dev.db')
        self.file(baseline / 'prisma/migrations/old/migration.sql')
        self.file(baseline / 'public/media/customer-original')
        self.file(baseline / 'node_modules/fixture')
        self.file(baseline / '.env', b'PRIVATE_FIXTURE=never-output')
        self.file(baseline / '.next/BUILD_ID')
        d = object.__new__(m.Deployment)
        d.new = self.root / 'candidate'
        d.logs = d.new / 'deployment-logs/security-channel-20261002'
        with patch.object(m, 'BASE', baseline), patch.object(m.shutil, 'disk_usage', return_value=SimpleNamespace(free=12*1024**3)):
            d.clone()
        self.assertFalse((d.new / 'prisma').is_symlink())
        self.assertNotEqual((d.new / 'prisma/schema.prisma').stat().st_ino, (baseline / 'prisma/schema.prisma').stat().st_ino)
        for name in ('.env', 'prisma/dev.db', 'public/media', 'node_modules'):
            self.assertTrue((d.new / name).is_symlink())
            self.assertEqual((d.new / name).resolve(), (baseline / name).resolve())
        self.assertFalse((d.new / '.next').exists())
        self.assertEqual(m.environment_identity(d.new), m.environment_identity(baseline))
        self.assertEqual(m.runtime_identity(d.new), m.runtime_identity(baseline))

    def test_http_acceptance_uses_reads_only_and_keeps_cookie_out_of_receipt(self):
        updater = b'signed-update-fixture'
        latest = {'size': len(updater), 'sha256': m.hashlib.sha256(updater).hexdigest()}
        files = {'public/downloads/plugin.zip': {'size': 99, 'sha256': 'a'*64}}
        seen = []
        def read(origin, route, method='GET', **kwargs):
            seen.append((method, kwargs))
            if route == m.LATEST_ROUTE:
                return 200, updater, {}
            if kwargs.get('extra_headers', {}).get('Cookie'):
                return 200, b'{"data":{"role":"admin"}}', {}
            if route == '/downloads/plugin.zip':
                return 401, b'', {}
            check = next(row for row in m.ANONYMOUS_CHECKS if row['path'] == route and bool(row.get('aiDeclared')) == ('x-sanjie-ai-client' in kwargs.get('extra_headers', {})))
            return check['status'], b'', {'Location': m.PUBLIC + '/login'}
        with patch.object(m, 'request', read):
            rows = m.smoke('http://127.0.0.1:31953', latest, files, 'secret-test-cookie')
        self.assertTrue(all(method in ('GET', 'HEAD') and 'data' not in args for method, args in seen))
        self.assertNotIn('secret-test-cookie', json.dumps(rows))

    def creative_smoke_fixture(self, fail=None):
        updater, script = b'retained-update', b'window.SZ_STUDIO_GENESIS = {}'
        latest = {'size': len(updater), 'sha256': m.hashlib.sha256(updater).hexdigest()}
        script_name = 'public' + m.urllib.parse.urlsplit(m.SIGNED_CREATIVE_CHECKS[1]['path']).path
        files = {script_name: {'size': len(script), 'sha256': m.hashlib.sha256(script).hexdigest()}}
        seen = []
        def read(origin, route, method='GET', **kwargs):
            headers = kwargs.get('extra_headers', {})
            seen.append({'origin': origin, 'path': route, 'method': method, 'headers': headers, 'data': kwargs.get('data')})
            if route == m.LATEST_ROUTE:
                return 200, updater, {}
            if headers.get('Cookie') and route in {row['path'] for row in m.SIGNED_CREATIVE_CHECKS}:
                check = next(row for row in m.SIGNED_CREATIVE_CHECKS if row['path'] == route)
                response_headers = {'Content-Type': check['contentType'] + '; charset=utf-8',
                    'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "frame-ancestors 'self'",
                    'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff',
                    'Cache-Control': 'private, no-store'}
                body = b'<!doctype html><html><script id="labStartupScript"></script></html>' if check['contentType'] == 'text/html' else script
                result = (200, body, response_headers)
                return fail(route, headers, result) if fail else result
            if headers.get('Cookie'):
                return 200, b'{"data":{"role":"admin"}}', {}
            check = next(row for row in m.ANONYMOUS_CHECKS if row['path'] == route and bool(row.get('aiDeclared')) == ('x-sanjie-ai-client' in headers))
            return check['status'], b'', {'Location': m.PUBLIC + '/login'}
        return latest, files, read, seen

    def test_signed_creative_smoke_exercises_real_iframe_query_and_https_proxy_boundary(self):
        for origin, expected_count in (('http://127.0.0.1:31954', 4), (m.PUBLIC, 2)):
            with self.subTest(origin=origin):
                latest, files, read, seen = self.creative_smoke_fixture()
                with patch.object(m, 'request', side_effect=read):
                    rows = m.smoke(origin, latest, files, 'secret-readonly-cookie', after_migration=True)
                creative = [row for row in rows if 'contentType' in row]
                self.assertEqual(len(creative), expected_count)
                self.assertEqual({row['contentType'] for row in creative}, {'text/html', 'text/javascript'})
                proxied = [row for row in seen if row['headers'].get('X-Forwarded-Proto')]
                self.assertEqual(len(proxied), 2 if origin.startswith('http://127.') else 0)
                for row in proxied:
                    self.assertEqual(row['headers']['Host'], 'shaozhuangai.com')
                    self.assertEqual(row['headers']['X-Forwarded-Proto'], 'https')
                    self.assertEqual(row['headers']['X-Forwarded-Host'], 'shaozhuangai.com')
                self.assertIn('?mode=main&source=web&studio=1', creative[0]['path'])
                self.assertTrue(all(row['method'] in ('GET', 'HEAD') and row['data'] is None for row in seen))
                self.assertNotIn('secret-readonly-cookie', json.dumps(rows))

    def test_signed_creative_smoke_fails_when_public_html_is_500(self):
        def fail(route, headers, result):
            return (500, b'', {}) if route.endswith('studio=1') else result
        latest, files, read, _ = self.creative_smoke_fixture(fail)
        with patch.object(m, 'request', side_effect=read), self.assertRaisesRegex(RuntimeError, 'acceptance status differs: .*promptlab.*500'):
            m.smoke(m.PUBLIC, latest, files, 'readonly-cookie', after_migration=True)

    def test_signed_creative_smoke_fails_before_switch_when_https_forwarding_breaks_html(self):
        def fail(route, headers, result):
            return (500, b'', {}) if route.endswith('studio=1') and headers.get('X-Forwarded-Proto') == 'https' else result
        latest, files, read, seen = self.creative_smoke_fixture(fail)
        with patch.object(m, 'request', side_effect=read), self.assertRaisesRegex(RuntimeError, 'acceptance status differs: .*promptlab.*500'):
            m.smoke('http://127.0.0.1:31954', latest, files, 'readonly-cookie', after_migration=True)
        self.assertTrue(any(row['path'].endswith('studio=1') and not row['headers'].get('X-Forwarded-Proto') for row in seen))

    def test_signed_creative_smoke_rejects_wrong_mime_headers_or_runtime_bytes(self):
        for header, wrong in (('Content-Type', 'application/json'), ('X-Frame-Options', 'DENY'),
                ('Content-Security-Policy', "frame-ancestors 'none'"), ('Cross-Origin-Resource-Policy', 'cross-origin'),
                ('X-Content-Type-Options', ''), ('Cache-Control', 'public, max-age=3600'), (None, b'wrong-runtime')):
            with self.subTest(header=header):
                def fail(route, headers, result):
                    status, body, response = result
                    if header is None:
                        return (status, wrong, response) if 'studio-genesis-ui.js' in route else result
                    return status, body, {**response, header: wrong}
                latest, files, read, _ = self.creative_smoke_fixture(fail)
                with patch.object(m, 'request', side_effect=read), self.assertRaises(RuntimeError):
                    m.smoke(m.PUBLIC, latest, files, 'readonly-cookie', after_migration=True)

    def test_prepare_smoke_defers_rate_table_dependent_workspace_reads(self):
        latest, files, read, seen = self.creative_smoke_fixture()
        with patch.object(m, 'request', side_effect=read):
            m.smoke('http://127.0.0.1:31954', latest, files, 'readonly-cookie', after_migration=False)
        self.assertFalse(any(row['headers'].get('Cookie') and row['path'].startswith('/creative/') for row in seen))

    def test_public_compatibility_smoke_keeps_only_four_exact_archives_public(self):
        updater = b'update'
        latest = {'size': len(updater), 'sha256': m.hashlib.sha256(updater).hexdigest()}
        files = {'public' + name: {'size': 99, 'sha256': 'a'*64} for name in m.PUBLIC_DOWNLOAD_PATHS}
        files['public/downloads/sycm-keyword-collector-v1.9.23.zip'] = {'size': 1, 'sha256': 'b'*64}
        seen = {}
        def read(origin, route, method='GET', **kwargs):
            seen[route] = method
            if route == m.LATEST_ROUTE:
                return 200, updater, {}
            if route.endswith('.zip'):
                return (200, b'', {'Content-Length': '99'}) if route in m.PUBLIC_DOWNLOAD_PATHS else (401, b'', {})
            declared = kwargs.get('extra_headers', {}).get('x-sanjie-ai-client')
            check = next(row for row in m.ANONYMOUS_CHECKS if row['path'] == route and bool(row.get('aiDeclared')) == bool(declared))
            headers = {'Location': 'https://shaozhuangai.com/login'} if check.get('loginRedirect') else {}
            return check['status'], b'', headers
        with patch.object(m, 'request', side_effect=read):
            receipt = m.smoke('http://127.0.0.1:31953', latest, files, download_policy='public')
        archives = {row['path']: row['status'] for row in receipt if row['path'].endswith('.zip')}
        self.assertEqual({path: archives[path] for path in m.PUBLIC_DOWNLOAD_PATHS}, {path: 200 for path in m.PUBLIC_DOWNLOAD_PATHS})
        self.assertEqual(archives['/downloads/sycm-keyword-collector-v1.9.23.zip'], 401)
        self.assertTrue(all(seen[path] == 'HEAD' for path in archives))

    def test_public_compatibility_rejects_missing_exact_retained_package(self):
        with self.assertRaisesRegex(RuntimeError, 'exact public packages missing'):
            m.smoke('fixture-origin', {'size': 0, 'sha256': 'a'*64}, {}, download_policy='public')

    def test_prepare_does_not_apply_migrations_or_swap_nginx(self):
        source = inspect.getsource(m.Deployment.prepare)
        self.assertNotIn('apply_migrations', source)
        self.assertNotIn('atomic_bytes(CONF', source)
        self.assertNotIn('nginx_retarget', source)
        self.assertIn("'--hostname', '127.0.0.1'", source)
        self.assertNotIn("'save'", source)

    def test_publish_rejects_unprepared_stage_before_db_changes(self):
        d = object.__new__(m.Deployment)
        d.load = lambda: {'phase': 'prepare-failed'}
        d.apply_migrations = Mock()
        with self.assertRaisesRegex(RuntimeError, 'requires prepared'):
            d.publish()
        d.apply_migrations.assert_not_called()

    def test_database_js_has_only_own_markers_and_syntax_is_valid(self):
        self.assertNotIn('migrate deploy', m.MIGRATE_OWNED_JS)
        self.assertIn('tables.length===0', m.MIGRATE_OWNED_JS)
        self.assertIn('checksum===migration.checksum', m.MIGRATE_OWNED_JS)
        for source in (m.MIGRATE_OWNED_JS, m.SIGN_READ_SESSION_JS):
            result = subprocess.run(['node', '--check'], input=source, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_rollback_rejects_external_nginx_and_does_not_drop_tables(self):
        filename = self.root / 'nginx.conf'
        self.file(filename, b'external')
        d = object.__new__(m.Deployment)
        with patch.object(m, 'CONF', filename), self.assertRaisesRegex(RuntimeError, 'External Nginx change'):
            d.restore({'publishedNginxSha256': 'a'*64})
        self.assertEqual(filename.read_bytes(), b'external')
        self.assertNotIn('DROP', inspect.getsource(m.Deployment.restore))


if __name__ == '__main__':
    unittest.main(verbosity=2)
