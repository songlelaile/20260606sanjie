#!/usr/bin/env python3
"""Focused local safety fixtures; no production/browser/network access."""
import argparse
import importlib.util
import json
import os
import pathlib
import tempfile
import types
import unittest
from unittest import mock


SCRIPT = pathlib.Path(__file__).with_name('qa-build-cleanup-20261009.py')
spec = importlib.util.spec_from_file_location('qa_cleanup', str(SCRIPT))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)
real_scandir = os.scandir


def portable_scandir(path):
    if isinstance(path, str) and path.startswith('/proc/self/fd/'):
        return real_scandir(int(path.rsplit('/', 1)[1]))
    return real_scandir(path)


class SafetyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='qa-cleanup-fixture-')
        self.base = os.path.realpath(self.temporary.name)
        self.parent = self.base + '/qa-parent'
        self.state = self.base + '/state'
        os.mkdir(self.parent)
        os.mkdir(self.state)
        self.roots = tuple(self.parent + '/qa-full-quality-83' + suffix
                           for suffix in ('', '-v2', '-v3', '-v4'))
        for root in self.roots:
            os.mkdir(root)
            os.mkdir(root + '/.next')
            pathlib.Path(root + '/.next/build.dat').write_bytes(b'x' * 4096)
            pathlib.Path(root + '/source.ts').write_text('source')
            pathlib.Path(root + '/.env').write_text('fixture-private')
            os.mkdir(root + '/public')
            pathlib.Path(root + '/public/material.dat').write_text('material')
        self.patches = [mock.patch.object(cleanup, 'PARENT', self.parent),
                        mock.patch.object(cleanup, 'ROOTS', self.roots),
                        mock.patch.object(cleanup, 'STATE', self.state),
                        mock.patch.object(cleanup.os, 'scandir', portable_scandir)]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in reversed(self.patches):
            patch.stop()
        self.temporary.cleanup()

    def guards(self, protected=None, mounts=None):
        return {'protected': set(protected or []), 'mounts': set(mounts or ['/']),
                'parent': cleanup.identity(os.lstat(self.parent))}

    def execute(self, apply=False, protected=None, mounts=None, budget=8):
        with mock.patch.object(cleanup, 'snapshot', side_effect=lambda: self.guards(protected, mounts)):
            return cleanup.run(argparse.Namespace(apply=apply, max_gib=budget))

    def test_dry_run_preserves_everything(self):
        result = self.execute()
        self.assertEqual(result['counts'], {'would_remove': 4})
        self.assertTrue(all(os.path.isdir(root + '/.next') for root in self.roots))

    def test_apply_only_explicit_build_leaves(self):
        other = self.parent + '/qa-full-quality-83-v5'
        os.mkdir(other)
        os.mkdir(other + '/.next')
        result = self.execute(apply=True)
        self.assertEqual(result['counts'], {'removed': 4})
        for root in self.roots:
            self.assertFalse(os.path.lexists(root + '/.next'))
            self.assertEqual(pathlib.Path(root + '/source.ts').read_text(), 'source')
            self.assertEqual(pathlib.Path(root + '/.env').read_text(), 'fixture-private')
            self.assertEqual(pathlib.Path(root + '/public/material.dat').read_text(), 'material')
        self.assertTrue(os.path.isdir(other + '/.next'))

    def test_leaf_symlink_is_preserved(self):
        for root in self.roots:
            os.symlink(self.base, root + '/node_modules')
        result = self.execute(apply=True)
        self.assertEqual(result['counts'], {'removed': 4})
        self.assertEqual(sum(row['status'] == 'preserved_symlink_or_non_directory'
                             for row in result['outcomes']), 4)
        self.assertTrue(all(os.path.islink(root + '/node_modules') for root in self.roots))

    def test_root_symlink_rejected(self):
        os.rename(self.roots[0], self.base + '/root-donor')
        os.symlink(self.base + '/root-donor', self.roots[0])
        with self.assertRaises(cleanup.GuardError):
            self.execute(apply=True)
        self.assertTrue(os.path.isdir(self.base + '/root-donor/.next'))

    def test_runtime_root_preserved(self):
        result = self.execute(apply=True, protected=[self.roots[1]])
        self.assertEqual(result['counts'], {'removed': 3, 'skipped': 1})
        self.assertTrue(os.path.isdir(self.roots[1] + '/.next'))

    def test_same_device_submount_preserved(self):
        result = self.execute(apply=True, mounts=[self.roots[0] + '/.next/cache'])
        self.assertEqual(result['counts'], {'removed': 3, 'skipped': 1})
        self.assertTrue(os.path.isdir(self.roots[0] + '/.next'))

    def test_budget_does_not_delete_over_limit(self):
        result = self.execute(apply=True, budget=1.0 / (1024 ** 3))
        self.assertEqual(result['counts'], {'skipped': 4})
        self.assertTrue(all(os.path.isdir(root + '/.next') for root in self.roots))

    def test_partial_removal_stops_immediately(self):
        real_walk = cleanup.tree_fd
        def failing_walk(fd, device, remove=False, depth=0, counters=None):
            if remove:
                os.unlink('build.dat', dir_fd=fd)
                raise OSError('fixture removal failure')
            return real_walk(fd, device, remove, depth, counters)
        with mock.patch.object(cleanup, 'tree_fd', side_effect=failing_walk):
            result = self.execute(apply=True)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['counts'], {'failed_during_removal': 1})
        self.assertEqual(result['processed_targets'], 1)
        self.assertTrue(os.path.isfile(self.roots[1] + '/.next/build.dat'))

    def test_probe_failure_aborts_dry_run(self):
        with mock.patch.object(cleanup, 'snapshot', side_effect=cleanup.ProbeError('fixture')):
            with self.assertRaises(cleanup.ProbeError):
                cleanup.run(argparse.Namespace(apply=False, max_gib=8))

    def test_reference_appearing_after_tree_scan_preserves_leaf(self):
        calls = [0]
        def changing_snapshot():
            calls[0] += 1
            return self.guards([self.roots[0]] if calls[0] >= 3 else [])
        with mock.patch.object(cleanup, 'snapshot', side_effect=changing_snapshot):
            result = cleanup.run(argparse.Namespace(apply=True, max_gib=8))
        self.assertEqual(result['counts'], {'skipped': 1, 'removed': 3})
        self.assertTrue(os.path.isfile(self.roots[0] + '/.next/build.dat'))

    def test_nested_symlink_unlinked_without_touching_target(self):
        os.symlink(self.roots[1] + '/public', self.roots[0] + '/.next/external')
        result = self.execute(apply=True)
        self.assertEqual(result['counts'], {'removed': 4})
        self.assertTrue(os.path.isfile(self.roots[1] + '/public/material.dat'))

    def test_dependency_closure_protects_indirect_qa_donor(self):
        live = self.base + '/live'
        donor = self.base + '/donor'
        os.mkdir(live)
        os.mkdir(donor)
        os.symlink(donor, live + '/public')
        os.symlink(self.roots[2] + '/.next', donor + '/shared')
        protected = cleanup.symlink_dependencies([live])
        self.assertIn(self.roots[2], protected)

    def test_file_link_chain_protects_intermediate_qa_owner(self):
        live = self.base + '/live'
        os.mkdir(live)
        os.symlink(self.roots[0] + '/.env', live + '/.env')
        os.unlink(self.roots[0] + '/.env')
        os.symlink(self.roots[3] + '/.env', self.roots[0] + '/.env')
        self.assertEqual(cleanup.symlink_dependencies([live]), {self.roots[0], self.roots[3]})

    def test_link_dotdot_semantics_are_not_normalized_early(self):
        live = self.base + '/live'
        os.mkdir(live)
        os.symlink(self.roots[0] + '/.next', live + '/jump')
        resolved, protected = cleanup.resolve_links(live + '/jump/../.env')
        self.assertEqual(resolved, self.roots[0] + '/.env')
        self.assertIn(self.roots[0], protected)

    def test_dependency_memory_cap_fails_closed(self):
        with mock.patch.object(cleanup, 'MAX_DEPENDENCY_MEMORY', 1):
            with self.assertRaises(cleanup.ProbeError):
                cleanup.symlink_dependencies([self.roots[0]])

    def test_dependency_read_error_fails_closed(self):
        with mock.patch.object(cleanup.os, 'readlink', side_effect=PermissionError('fixture')):
            os.symlink(self.roots[0] + '/.env', self.roots[1] + '/public/ref')
            with self.assertRaises(OSError):
                cleanup.symlink_dependencies([self.roots[1]])

    def test_state_log_is_fixed_private_file(self):
        self.execute()
        path = self.state + '/qa-build-cleanup-result.json'
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        self.assertLess(os.stat(path).st_size, cleanup.MAX_JSON)
        self.assertEqual(json.loads(pathlib.Path(path).read_text())['apply'], False)

    def test_state_symlink_rejected(self):
        os.symlink(self.roots[0] + '/.env', self.state + '/qa-build-cleanup-result.json')
        with self.assertRaises(cleanup.GuardError):
            self.execute()
        self.assertEqual(pathlib.Path(self.roots[0] + '/.env').read_text(), 'fixture-private')

    def test_running_docker_bind_sources(self):
        item = 'a' * 64
        rows = [{'State': {'Running': True}, 'Mounts': [
            {'Type': 'bind', 'Source': self.roots[2]},
            {'Type': 'volume', 'Source': self.roots[0]}]}]
        def command(argv):
            return types.SimpleNamespace(stdout=item if argv[1] == 'ps' else json.dumps(rows))
        with mock.patch.object(cleanup, 'command', side_effect=command):
            self.assertEqual(cleanup.docker_binds(), {self.roots[2]})

    def test_required_command_failure_is_probe_error(self):
        process = types.SimpleNamespace(returncode=1, poll=lambda: 1)
        with mock.patch.object(cleanup.subprocess, 'Popen', return_value=process):
            with self.assertRaises(cleanup.ProbeError):
                cleanup.command(['nginx', '-T'])

    def test_command_output_bound_is_checked_without_pipe_buffering(self):
        def launch(argv, stdout, stderr):
            stdout.write(b'x' * 20)
            stdout.flush()
            return types.SimpleNamespace(returncode=0, poll=lambda: 0)
        with mock.patch.object(cleanup, 'MAX_OUTPUT', 10), mock.patch.object(cleanup.subprocess, 'Popen', side_effect=launch):
            with self.assertRaises(cleanup.ProbeError):
                cleanup.command(['fixture'])

    def test_tree_read_error_is_non_success(self):
        with mock.patch.object(cleanup, 'tree_fd', side_effect=PermissionError('fixture')):
            result = self.execute(apply=True)
        self.assertEqual(result['status'], 'failed_closed')
        self.assertEqual(result['counts'], {'guard_probe_failed': 1})
        self.assertTrue(all(os.path.isfile(root + '/.next/build.dat') for root in self.roots))

    def test_late_probe_failure_keeps_audit_of_prior_removal(self):
        calls = [0]
        def changing_snapshot():
            calls[0] += 1
            if calls[0] == 4:
                raise cleanup.ProbeError('fixture_late_probe')
            return self.guards()
        with mock.patch.object(cleanup, 'snapshot', side_effect=changing_snapshot):
            result = cleanup.run(argparse.Namespace(apply=True, max_gib=8))
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['counts'], {'removed': 1, 'guard_probe_failed': 1})
        self.assertGreater(result['removed_allocated_bytes_upper_bound'], 0)
        self.assertTrue(os.path.isfile(self.roots[1] + '/.next/build.dat'))

    def test_configuration_path_inventory_is_bounded(self):
        text = ' '.join('root /fixture/' + str(index) + ';' for index in range(4097))
        with self.assertRaises(cleanup.ProbeError):
            cleanup.nginx_serving_directories(text)

    def test_nginx_only_root_alias_serve_as_directory_seeds(self):
        text = '''# root /ignore-example;
        http { access_log /var/log/nginx/access.log;
            location ~ /\\. { deny all; }
            client_body_temp_path /tmp;
            server { root /srv/live; location /media { alias /srv/media/; } }
        }'''
        self.assertEqual(cleanup.nginx_serving_directories(text), {'/srv/live', '/srv/media/'})

    def test_nginx_quotes_comments_and_inline_blocks(self):
        text = '''server { root "/srv/a space"; # alias /discard;
            location /images { alias '/srv/hash#name'; }
            log_format fmt '$request ; root /discard;';
            root /srv/a\\ space;
        }'''
        self.assertEqual(cleanup.nginx_serving_directories(text), {'/srv/a space', '/srv/hash#name'})

    def test_nginx_real_broad_root_still_rejected(self):
        seeds = cleanup.nginx_serving_directories('server { root /.; }')
        self.assertEqual(seeds, {'/.'})
        with self.assertRaises(cleanup.ProbeError):
            cleanup.symlink_dependencies(seeds)

    def test_nginx_dynamic_or_relative_serving_path_requires_review(self):
        for text in ('root $serving_dir;', 'alias html;', 'root /srv/$host;'):
            with self.assertRaises(cleanup.ProbeError):
                cleanup.nginx_serving_directories(text)

    def test_snapshot_ignores_location_regex_as_seed_but_protects_qa_literal(self):
        live, pin = self.base + '/live', self.base + '/pin'
        os.mkdir(live)
        os.mkdir(pin)
        nginx = 'server { location ~ /\\. { deny all; } root ' + live + '; }\n# old ' + self.roots[2]
        with mock.patch.object(cleanup, 'pm2_online', return_value={live}), \
                mock.patch.object(cleanup, 'pinned_roots', return_value={pin}), \
                mock.patch.object(cleanup, 'docker_binds', return_value=set()), \
                mock.patch.object(cleanup, 'process_references', return_value=set()), \
                mock.patch.object(cleanup, 'mounts', return_value={'/'}), \
                mock.patch.object(cleanup, 'command', return_value=types.SimpleNamespace(stdout=nginx, stderr='')):
            result = cleanup.snapshot()
        # The complete raw dump deliberately overprotects the base root when
        # its literal name is a prefix of the historical -v3 root.
        self.assertEqual(result['protected'], {self.roots[0], self.roots[2]})

    def test_proc_cwd_fd_maps_cmdline_and_no_contents_logged(self):
        proc = self.base + '/proc'
        os.mkdir(proc)
        pid = proc + '/42'
        os.mkdir(pid)
        os.mkdir(pid + '/fd')
        os.symlink(self.roots[0], pid + '/cwd')
        os.symlink(self.roots[1] + '/.next/build.dat', pid + '/fd/8')
        pathlib.Path(pid + '/maps').write_text('0-1 r--p 00000000 00:00 1 ' + self.roots[2] + '/.next/build.dat\n')
        pathlib.Path(pid + '/cmdline').write_bytes(('worker\0--arg=' + self.roots[3] + '/.next\0fixture-secret').encode())
        with mock.patch.object(cleanup, 'PROC', proc):
            self.assertEqual(cleanup.process_references(), set(self.roots))


if __name__ == '__main__':
    unittest.main()
