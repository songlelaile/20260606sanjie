#!/usr/bin/env python3
"""Fail-closed retention of obsolete release node_modules and .next only.

Python 3.6+, Linux, root. Default is dry-run. --apply is required to remove
anything; the daily budget is 10 GiB. A reviewed --plan may use --max-gib 60.
Source, configuration, evidence and business material outside those two build
directories are never selected. No service is stopped or restarted.
"""
from __future__ import print_function

import argparse
import datetime
import errno
import fcntl
import json
import math
import os
import re
import stat
import subprocess
import sys
import tempfile
import time

BASE = '/opt/sanjie-releases'
PINNED = '/etc/sanjie-resource-watch/pinned-releases.txt'
STATE = '/var/lib/sanjie-resource-watch'
PROC = '/proc'
GIB = 1024 ** 3
LEAVES = ('node_modules', '.next')
OPERATION = 'delete_obsolete_node_modules_and_next_builds_only'
MAX_TARGETS = 2000
MAX_INPUT_BYTES = 2 * 1024 * 1024
MAX_SCAN_DIRECTORIES = 100000
MAX_SCAN_ENTRIES = 1000000
MAX_SCAN_PATH_BYTES = 8 * 1024 * 1024
DATE_NAME = re.compile(r'^(20\d{6})(?:-|$)')


class GuardError(Exception):
    pass


class ProbeError(GuardError):
    """Required protective inventory is unavailable; never treat as a skip."""
    pass


def command(argv):
    # stdout/stderr may contain application environments/configuration. Never log
    # either; return only the required parsed fields from the callers below.
    try:
        result = subprocess.run(argv, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=45,
                                universal_newlines=True, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise GuardError('guard_command_unavailable_' + argv[0])
    if result.returncode != 0:
        raise GuardError('guard_command_failed_' + argv[0])
    if len(result.stdout) + len(result.stderr) > 32 * 1024 * 1024:
        raise GuardError('guard_command_output_too_large_' + argv[0])
    return result


def beneath(path, parent):
    return path == parent or path.startswith(parent + '/')


def regular_json(path):
    if not os.path.isabs(path) or os.path.realpath(path) != path:
        raise GuardError('plan_path_must_be_absolute_and_not_symlinked')
    metadata = os.lstat(path)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_INPUT_BYTES:
        raise GuardError('plan_file_invalid')
    with open(path, 'r', encoding='utf-8') as source:
        raw = source.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise GuardError('plan_file_too_large')
    try:
        return json.loads(raw)
    except ValueError:
        raise GuardError('plan_json_invalid')


def directory(path):
    metadata = os.lstat(path)
    if not stat.S_ISDIR(metadata.st_mode) or os.path.realpath(path) != path:
        raise GuardError('directory_is_symlink_or_invalid')
    return metadata


def valid_release(path):
    return (isinstance(path, str) and os.path.isabs(path)
            and os.path.normpath(path) == path
            and os.path.dirname(path) == BASE
            and os.path.basename(path) not in ('', '.', '..'))


def release_for_path(path):
    if not isinstance(path, str) or not path.startswith(BASE + '/'):
        return None
    root = BASE + '/' + path[len(BASE) + 1:].split('/', 1)[0]
    return root if valid_release(root) else None


def validate_target(row):
    if not isinstance(row, dict):
        raise GuardError('plan_target_invalid')
    path, root = row.get('path'), row.get('release')
    if (not valid_release(root) or not isinstance(path, str)
            or os.path.dirname(path) != root
            or os.path.basename(path) not in LEAVES
            or os.path.normpath(path) != path):
        raise GuardError('plan_target_outside_allowed_build_directories')
    for key in ('inode', 'device', 'bytes'):
        if type(row.get(key)) is not int or row[key] < 0:
            raise GuardError('plan_target_identity_invalid')
    for key in ('release_inode', 'release_device', 'release_mtime_ns'):
        if key in row and (type(row[key]) is not int or row[key] < 0):
            raise GuardError('plan_release_identity_invalid')
    return row


def read_pinned():
    if os.path.realpath(PINNED) != PINNED:
        raise GuardError('pinned_file_must_not_be_symlinked')
    metadata = os.lstat(PINNED)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 64 * 1024:
        raise GuardError('pinned_file_invalid')
    with open(PINNED, 'r', encoding='utf-8') as source:
        lines = source.read(64 * 1024 + 1).splitlines()
    result = set()
    for line in lines:
        value = line.strip()
        if not value or value.startswith('#'):
            continue
        if not valid_release(value):
            raise GuardError('pinned_release_invalid')
        directory(value)
        result.add(value)
    if not result:
        raise GuardError('pinned_file_empty')
    return result


def read_mounts():
    result = set()
    with open('/proc/self/mountinfo', 'r', encoding='utf-8') as source:
        for line in source:
            parts = line.split()
            if len(parts) < 7 or '-' not in parts:
                raise GuardError('mountinfo_invalid')
            mount = re.sub(r'\\([0-7]{3})',
                           lambda match: chr(int(match.group(1), 8)), parts[4])
            if not mount.startswith('/'):
                raise GuardError('mountinfo_path_invalid')
            result.add(os.path.normpath(mount))
    if not result:
        raise GuardError('mountinfo_empty')
    return result


def process_cwds():
    """Protect BASE releases referenced by cwd, open files or memory mappings.

    Read only link destinations and mapping paths, never cmdline or environment.
    Exited processes/closed file descriptors are ordinary races; permission or
    other inventory errors leave an unknown reference and must fail closed.
    """
    result = set()
    with os.scandir(PROC) as entries:
        pids = [entry.name for entry in entries if entry.name.isdigit()]

    def add(path):
        if path.endswith(' (deleted)'):
            path = path[:-10]
        if path.startswith('/'):
            root = release_for_path(os.path.normpath(path))
            if root:
                result.add(root)

    def exited(error):
        return error.errno in (errno.ENOENT, errno.ESRCH, errno.EINVAL)

    for pid in pids:
        # Held candidate fds belong to this maintenance operation, not a
        # running application. Including them would protect our own target.
        if int(pid) == os.getpid():
            continue
        process_root = PROC + '/' + pid
        try:
            add(os.readlink(process_root + '/cwd'))
        except OSError as error:
            if not exited(error):
                raise GuardError('process_cwd_unreadable')
        try:
            with os.scandir(process_root + '/fd') as descriptors:
                for entry in descriptors:
                    try:
                        add(os.readlink(entry.path))
                    except OSError as error:
                        if not exited(error):
                            raise GuardError('process_fd_unreadable')
        except OSError as error:
            if not exited(error):
                raise GuardError('process_fd_inventory_unreadable')
        try:
            with open(process_root + '/maps', 'r', encoding='utf-8', errors='surrogateescape') as mappings:
                for line in mappings:
                    fields = line.rstrip('\n').split(None, 5)
                    if len(fields) == 6 and fields[5].startswith('/'):
                        add(re.sub(r'\\([0-7]{3})',
                                   lambda match: chr(int(match.group(1), 8)), fields[5]))
        except OSError as error:
            if not exited(error):
                raise GuardError('process_maps_unreadable')
    return result


def app_ports(env):
    result = set()
    sources = [env] + [env.get(key, {}) for key in
                      ('env', 'env_production', 'env_development')]
    for source in sources:
        if not isinstance(source, dict):
            continue
        for key in ('PORT', 'port', 'NEXT_PORT', 'NITRO_PORT', 'NODE_PORT'):
            raw = str(source.get(key, ''))
            if raw.isdigit() and 1 <= int(raw) <= 65535:
                result.add(int(raw))
    args = env.get('args', [])
    if isinstance(args, str):
        args = args.split()
    if isinstance(args, list):
        for index, value in enumerate(args):
            value = str(value)
            match = re.match(r'^(?:--port=|-p=)(\d+)$', value)
            raw = match.group(1) if match else None
            if value in ('-p', '--port') and index + 1 < len(args):
                raw = str(args[index + 1])
            if raw and raw.isdigit() and 1 <= int(raw) <= 65535:
                result.add(int(raw))
    return result


def symlink_dependencies(seeds):
    """Stream each unique protected directory once and close over BASE donors.

    Business symlink directories are never traversed. Their resolved target's
    release becomes a separate protected seed. Directory fds prevent following
    a directory replaced by a link. /proc/self/fd is an internal descriptor
    alias for streaming scandir on Python 3.6, which lacks scandir(fd).
    Only directory identities and release names are retained, with hard bounds.
    """
    pending = set(seeds)
    scanned_roots, visited_directories, donors = set(), set(), set()
    counters = {'entries': 0, 'path_bytes': 0}
    broad = {'/', '/root', '/opt', '/var', '/usr', '/home', '/tmp', '/var/tmp',
             '/var/lib', '/etc', '/proc', '/sys', '/dev'}

    def walk(fd, path, depth):
        if depth > 128:
            raise GuardError('symlink_guard_tree_too_deep')
        opened = os.fstat(fd)
        # Bind aliases of one inode can resolve a relative link differently.
        # Deduplicate only the same logical path, with a separate memory cap.
        identity = (opened.st_dev, opened.st_ino, path)
        if identity in visited_directories:
            return
        visited_directories.add(identity)
        counters['path_bytes'] += len(path.encode('utf-8', 'surrogateescape'))
        if counters['path_bytes'] > MAX_SCAN_PATH_BYTES:
            raise GuardError('symlink_guard_path_memory_limit')
        if len(visited_directories) > MAX_SCAN_DIRECTORIES:
            raise GuardError('symlink_guard_directory_limit')
        with os.scandir('/proc/self/fd/' + str(fd)) as entries:
            for entry in entries:
                counters['entries'] += 1
                if counters['entries'] > MAX_SCAN_ENTRIES:
                    raise GuardError('symlink_guard_entry_limit')
                logical_path = path + '/' + entry.name
                if entry.is_symlink():
                    link = os.readlink(entry.name, dir_fd=fd)
                    target = link if os.path.isabs(link) else path + '/' + link
                    resolved = os.path.realpath(target)
                    # Keep both an intermediate link owner and the final donor:
                    # A/link -> B/node_modules/link -> C would break if B's build
                    # vanished even though C's resolved dependency was retained.
                    for candidate in (os.path.normpath(target), resolved):
                        donor = release_for_path(candidate)
                        if donor and donor != release_for_path(path):
                            directory(donor)
                            donors.add(donor)
                            pending.add(donor)
                            if len(donors) > MAX_TARGETS:
                                raise GuardError('symlink_guard_release_limit')
                elif entry.is_dir(follow_symlinks=False):
                    metadata = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                    child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                    dir_fd=fd)
                    try:
                        actual = os.fstat(child)
                        if (actual.st_dev, actual.st_ino) != (metadata.st_dev, metadata.st_ino):
                            raise GuardError('symlink_guard_directory_identity_changed')
                        walk(child, logical_path, depth + 1)
                    finally:
                        os.close(child)

    while pending:
        root = pending.pop()
        if root in scanned_roots:
            continue
        scanned_roots.add(root)
        if root in broad:
            raise GuardError('symlink_guard_external_seed_too_broad')
        metadata = directory(root)
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            actual = os.fstat(fd)
            if (actual.st_dev, actual.st_ino) != (metadata.st_dev, metadata.st_ino):
                raise GuardError('symlink_guard_seed_identity_changed')
            walk(fd, root, 0)
        finally:
            os.close(fd)
    return donors


def snapshot():
    base_stat = directory(BASE)
    pinned = read_pinned()
    nginx_result = command(['nginx', '-T'])
    nginx = nginx_result.stdout + nginx_result.stderr
    nginx_ports = set(int(value) for value in re.findall(r':(\d{1,5})\b', nginx))
    nginx_ports.update(int(value) for value in
                       re.findall(r'\blisten\s+(\d{1,5})\b', nginx))
    # Variable upstreams use bare numbers in map blocks. Conservative numeric
    # tokens can overprotect a release, which is preferable to deleting a donor.
    nginx_ports.update(int(value) for value in
                       re.findall(r'(?<![\w.:-])(\d{1,5})(?![\w.:-])', nginx)
                       if 1 <= int(value) <= 65535)
    try:
        apps = json.loads(command(['pm2', 'jlist']).stdout)
    except ValueError:
        raise GuardError('pm2_json_invalid')
    if not isinstance(apps, list) or not apps:
        raise GuardError('pm2_inventory_invalid')
    online, port_referenced = set(), set()
    for app in apps:
        if not isinstance(app, dict) or not isinstance(app.get('pm2_env'), dict):
            raise GuardError('pm2_app_invalid')
        env = app['pm2_env']
        cwd = env.get('pm_cwd')
        if not isinstance(cwd, str) or not cwd.startswith('/'):
            raise GuardError('pm2_cwd_invalid')
        cwd = os.path.normpath(cwd)
        if env.get('status') == 'online':
            online.add(cwd)
            online.add(os.path.realpath(cwd))
        if app_ports(env) & nginx_ports:
            port_referenced.add(cwd)
            port_referenced.add(os.path.realpath(cwd))
    roots, release_roots = [], set()
    with os.scandir(BASE) as entries:
        for entry in entries:
            if not entry.is_dir(follow_symlinks=False) or entry.is_symlink():
                continue
            release_roots.add(entry.path)
            match = DATE_NAME.match(entry.name)
            if match:
                roots.append((match.group(1), entry.name, entry.path))
    latest = set(row[2] for row in sorted(roots, reverse=True)[:2])
    processes = process_cwds()
    seeds = set(pinned | latest)
    seeds.update(root for root in release_roots if root in nginx)
    for path in online | port_referenced | processes:
        canonical = os.path.realpath(path)
        root = release_for_path(canonical)
        if root:
            seeds.add(root)
        elif path in online:
            # External online PM2 cwd is a bounded explicit application directory,
            # never a cleanup candidate. Arbitrary external /proc cwd is ignored.
            seeds.add(canonical)
    donors = symlink_dependencies(seeds)
    return {'base_device': base_stat.st_dev, 'base_inode': base_stat.st_ino,
            'pinned': pinned, 'nginx': nginx, 'online': online,
            'port_referenced': port_referenced, 'processes': processes,
            'symlink_referenced': donors,
            'mounts': read_mounts(), 'latest': latest, 'roots': roots}


def probe_snapshot():
    try:
        return snapshot()
    except (GuardError, OSError, ValueError, KeyError) as error:
        reason = str(error) if isinstance(error, GuardError) else 'critical_guard_input_unavailable_or_invalid'
        raise ProbeError(reason)


def reasons(root, metadata, guards, owned_mtimes=None):
    result = []
    if metadata.st_dev != guards['base_device']:
        result.append('release_crosses_filesystem')
    if root in guards['pinned']:
        result.append('pinned_release')
    if root in guards['latest']:
        result.append('latest_two_named_releases')
    if root in guards['nginx']:
        result.append('nginx_path_reference')
    if root in guards.get('symlink_referenced', set()):
        result.append('symlink_dependency_reference')
    for label, field in (('pm2_online_cwd', 'online'),
                         ('nginx_port_pm2_cwd', 'port_referenced'),
                         ('running_process_cwd', 'processes')):
        if any(beneath(path, root) for path in guards[field]):
            result.append(label)
    owned = (owned_mtimes or {}).get(root)
    if metadata.st_mtime > time.time() - 48 * 3600:
        if owned is None or metadata.st_mtime_ns != owned:
            result.append('release_modified_within_48_hours')
    if any(beneath(mount, root) for mount in guards['mounts']):
        result.append('release_contains_mountpoint')
    return result


def disk_bytes(path):
    output = command(['du', '-sx', '-B1', '--', path]).stdout.split()
    if not output or not output[0].isdigit():
        raise GuardError('build_size_invalid')
    return int(output[0])


def target_row(path, root, root_stat):
    metadata = directory(path)
    if metadata.st_dev != root_stat.st_dev:
        raise GuardError('build_crosses_filesystem')
    return {'path': path, 'release': root, 'bytes': disk_bytes(path),
            'device': metadata.st_dev, 'inode': metadata.st_ino,
            'release_device': root_stat.st_dev,
            'release_inode': root_stat.st_ino,
            'release_mtime_ns': root_stat.st_mtime_ns}


def automatic_plan(guards):
    targets, preserved = [], []
    cutoff = datetime.datetime.now(datetime.timezone.utc).date() - datetime.timedelta(days=7)
    for date, name, root in sorted(guards['roots']):
        root_stat = directory(root)
        why = reasons(root, root_stat, guards)
        try:
            release_date = datetime.datetime.strptime(date, '%Y%m%d').date()
        except ValueError:
            why.append('invalid_release_date')
            release_date = cutoff
        if release_date > cutoff or root_stat.st_mtime > time.time() - 7 * 86400:
            why.append('release_younger_than_seven_days')
        if why:
            preserved.append({'release': root, 'reasons': why})
            continue
        for leaf in LEAVES:
            path = root + '/' + leaf
            try:
                leaf_stat = os.lstat(path)
            except FileNotFoundError:
                continue
            if not stat.S_ISDIR(leaf_stat.st_mode):
                preserved.append({'release': root, 'path': path,
                                  'reasons': ['build_is_symlink_or_non_directory']})
                continue
            targets.append(target_row(path, root, root_stat))
            if len(targets) > MAX_TARGETS:
                raise GuardError('too_many_build_targets')
    return targets, preserved


def reviewed_plan(path, guards):
    plan = regular_json(path)
    if not isinstance(plan, dict) or plan.get('operation') != OPERATION:
        raise GuardError('reviewed_plan_operation_invalid')
    targets = plan.get('targets')
    if not isinstance(targets, list) or len(targets) > MAX_TARGETS:
        raise GuardError('reviewed_plan_targets_invalid')
    seen = set()
    for row in targets:
        validate_target(row)
        if row['path'] in seen:
            raise GuardError('reviewed_plan_duplicate_target')
        seen.add(row['path'])
    return targets, []


def check_target(row, guards, root_baselines, owned_mtimes):
    validate_target(row)
    root = row['release']
    root_stat = directory(root)
    identity = (root_stat.st_dev, root_stat.st_ino)
    expected = root_baselines[root]
    if identity != expected:
        raise GuardError('release_identity_changed')
    if 'release_inode' in row and identity != (row['release_device'], row['release_inode']):
        raise GuardError('planned_release_identity_changed')
    if ('release_mtime_ns' in row and root not in owned_mtimes
            and root_stat.st_mtime_ns != row['release_mtime_ns']):
        raise GuardError('planned_release_mtime_changed')
    why = reasons(root, root_stat, guards, owned_mtimes)
    if why:
        raise GuardError(','.join(why))
    metadata = directory(row['path'])
    if (metadata.st_dev, metadata.st_ino) != (row['device'], row['inode']):
        raise GuardError('build_identity_changed')
    if metadata.st_dev != root_stat.st_dev:
        raise GuardError('build_crosses_filesystem')
    return metadata


def walk_fd(fd, device, remove=False, depth=0):
    """Open relative to directory fds, unlink links without following them.

    A preflight walk rejects foreign devices before any removal. The removal
    walk repeats device/identity checks and never resolves a child symlink.
    """
    if depth > 128:
        raise GuardError('build_tree_too_deep')
    for name in os.listdir(fd):
        metadata = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if metadata.st_dev != device:
            raise GuardError('nested_entry_crosses_filesystem')
        if stat.S_ISDIR(metadata.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=fd)
            try:
                opened = os.fstat(child)
                if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
                    raise GuardError('nested_directory_identity_changed')
                walk_fd(child, device, remove, depth + 1)
                current = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
                    raise GuardError('nested_directory_identity_changed')
                if remove:
                    os.rmdir(name, dir_fd=fd)
            finally:
                os.close(child)
        elif remove:
            os.unlink(name, dir_fd=fd)


def remove_build(row, guards, root_baselines, owned_mtimes, remaining_bytes,
                 reservation):
    # This final snapshot runs after size measurement, immediately before open.
    fresh = probe_snapshot()
    if (fresh['base_device'], fresh['base_inode']) != (guards['base_device'], guards['base_inode']):
        raise GuardError('base_identity_changed')
    metadata = check_target(row, fresh, root_baselines, owned_mtimes)
    base_fd = os.open(BASE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    root_fd = target_fd = None
    try:
        if (os.fstat(base_fd).st_dev, os.fstat(base_fd).st_ino) != (guards['base_device'], guards['base_inode']):
            raise GuardError('opened_base_identity_changed')
        root_fd = os.open(os.path.basename(row['release']),
                          os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=base_fd)
        opened_root = os.fstat(root_fd)
        if (opened_root.st_dev, opened_root.st_ino) != root_baselines[row['release']]:
            raise GuardError('opened_release_identity_changed')
        target_fd = os.open(os.path.basename(row['path']),
                            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        opened = os.fstat(target_fd)
        if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise GuardError('opened_build_identity_changed')
        walk_fd(target_fd, opened.st_dev)
        # Preflight can take time on large dependencies. Refresh all guards and
        # size again before the destructive walk, including same-device mounts.
        fresh = probe_snapshot()
        if (fresh['base_device'], fresh['base_inode']) != (guards['base_device'], guards['base_inode']):
            raise GuardError('base_identity_changed')
        check_target(row, fresh, root_baselines, owned_mtimes)
        final_size = disk_bytes(row['path'])
        if final_size > remaining_bytes:
            raise GuardError('per_run_byte_budget_after_preflight')
        reservation['bytes'] = final_size
        reservation['destructive_started'] = True
        walk_fd(target_fd, opened.st_dev, remove=True)
        current = os.stat(os.path.basename(row['path']), dir_fd=root_fd, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
            raise GuardError('build_identity_changed_before_rmdir')
        os.rmdir(os.path.basename(row['path']), dir_fd=root_fd)
        owned_mtimes[row['release']] = os.fstat(root_fd).st_mtime_ns
        return final_size
    finally:
        if target_fd is not None:
            os.close(target_fd)
        if root_fd is not None:
            os.close(root_fd)
        os.close(base_fd)


def write_json(name, value):
    path = STATE + '/' + name
    if os.path.lexists(path) and stat.S_ISLNK(os.lstat(path).st_mode):
        raise GuardError('state_file_is_symlink')
    raw = json.dumps(value, sort_keys=True, indent=2) + '\n'
    if len(raw.encode('utf-8')) > MAX_INPUT_BYTES:
        raise GuardError('state_json_too_large')
    fd, temporary = tempfile.mkstemp(prefix='.build-retention-', dir=STATE)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as destination:
            destination.write(raw)
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def run(args):
    guards = probe_snapshot()
    targets, preserved = (reviewed_plan(args.plan, guards) if args.plan
                          else automatic_plan(guards))
    roots = set(row['release'] for row in targets)
    root_baselines = {}
    for root in roots:
        metadata = directory(root)
        root_baselines[root] = (metadata.st_dev, metadata.st_ino)
    plan = {'plannedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'operation': OPERATION, 'sourceAndConfigsPreserved': True,
            'age_days': 7, 'source_plan': args.plan, 'targets': targets,
            'bytes': sum(row['bytes'] for row in targets),
            'pinned': sorted(guards['pinned']), 'preserved_count': len(preserved),
            'preserved': preserved[:200]}
    write_json('build-retention-plan.json', plan)
    outcomes, counts, owned_mtimes = [], {}, {}
    budget = int(args.max_gib * GIB)
    selected_bytes = removed_bytes = 0
    processed = 0
    for row in targets:
        status, reason, current_size = 'eligible', '', row['bytes']
        reservation = {'bytes': current_size, 'destructive_started': False}
        try:
            fresh = probe_snapshot()
            if (fresh['base_device'], fresh['base_inode']) != (guards['base_device'], guards['base_inode']):
                raise GuardError('base_identity_changed')
            check_target(row, fresh, root_baselines, owned_mtimes)
            current_size = disk_bytes(row['path'])
            if selected_bytes + current_size > budget:
                status, reason = 'skipped', 'per_run_byte_budget'
            else:
                if args.apply:
                    # Reserve this size even if removal fails partway, so the
                    # run cannot spend the same budget again on another build.
                    current_size = remove_build(row, fresh, root_baselines,
                                                owned_mtimes, budget - selected_bytes,
                                                reservation)
                    removed_bytes += current_size
                    status = 'removed'
                else:
                    status = 'would_remove'
                selected_bytes += current_size
        except ProbeError as error:
            if not reservation['destructive_started']:
                raise
            status, reason = 'failed_during_removal', str(error)
            selected_bytes += reservation['bytes']
        except (GuardError, OSError) as error:
            status = 'failed_during_removal' if reservation['destructive_started'] else 'skipped'
            reason = str(error) if isinstance(error, GuardError) else 'filesystem_guard_failed'
            if reservation['destructive_started']:
                selected_bytes += reservation['bytes']
        counts[status] = counts.get(status, 0) + 1
        processed += 1
        if len(outcomes) < 200:
            outcomes.append({'path': row['path'], 'status': status,
                             'reason': reason, 'bytes': current_size})
        if status == 'failed_during_removal':
            # A tree may be partly removed; stop rather than reporting success
            # or continuing through other releases after a destructive error.
            break
    result = {'completedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'status': ('partial' if counts.get('failed_during_removal') else 'completed'),
              'apply': args.apply, 'counts': counts, 'budget_bytes': budget,
              'selected_bytes': selected_bytes, 'removed_bytes': removed_bytes,
              'planned_targets': len(targets), 'unprocessed_targets': len(targets) - processed,
              'outcomes': outcomes, 'outcomes_truncated': processed > len(outcomes)}
    write_json('build-retention-result.json', result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='remove eligible builds')
    parser.add_argument('--plan', help='use only this already reviewed JSON target list')
    parser.add_argument('--max-gib', type=float, default=10,
                        help='maximum allocated GiB per invocation; default 10, hard cap 60')
    args = parser.parse_args()
    if not math.isfinite(args.max_gib) or not 0 < args.max_gib <= 60:
        parser.error('--max-gib must be greater than zero and at most 60')
    if os.geteuid() != 0:
        parser.error('root is required to inspect every process cwd')
    os.umask(0o077)
    lock_fd = None
    try:
        os.makedirs(STATE, mode=0o700, exist_ok=True)
        state_stat = directory(STATE)
        if state_stat.st_uid != 0 or state_stat.st_mode & 0o022:
            raise GuardError('state_directory_not_private_root_owned')
        lock_fd = os.open(STATE + '/build-retention.lock',
                          os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        if not stat.S_ISREG(os.fstat(lock_fd).st_mode):
            raise GuardError('lock_file_invalid')
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'status': 'skipped', 'reason': 'already_running'}))
            return 0
        result = run(args)
        summary = {key: result[key] for key in
                   ('apply', 'counts', 'planned_targets', 'removed_bytes')}
        summary['status'] = result['status']
        summary['unprocessed_targets'] = result['unprocessed_targets']
        code = 1 if result['status'] == 'partial' else 0
    except (GuardError, OSError, ValueError, KeyError) as error:
        reason = str(error) if isinstance(error, GuardError) else 'guard_input_unavailable_or_invalid'
        summary = {'status': 'failed_closed', 'apply': args.apply, 'reason': reason}
        # Preserve a fixed error record; never create an append-only history.
        if lock_fd is not None:
            try:
                write_json('build-retention-result.json', summary)
            except (GuardError, OSError):
                pass
        code = 1
    finally:
        if lock_fd is not None:
            os.close(lock_fd)
    line = json.dumps(summary, sort_keys=True)
    print(line)
    try:
        subprocess.run(['logger', '-t', 'sanjie-build-retention', '--', line],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        pass
    return code


if __name__ == '__main__':
    sys.exit(main())
