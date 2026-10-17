#!/usr/bin/env python3
"""Delete only two build leaves in four explicitly named historical QA roots.

Python 3.6+, Linux, root. Default dry-run. Runtime references, pinned/live
application symlink dependencies and mountpoints protect each candidate.
Source, configuration, public assets and database files are never selected.
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
import types


PARENT = '/root/plugin82-release-20261002'
ROOTS = tuple(PARENT + '/qa-full-quality-83' + suffix
              for suffix in ('', '-v2', '-v3', '-v4'))
LEAVES = ('node_modules', '.next')
PINNED = '/etc/sanjie-resource-watch/pinned-releases.txt'
STATE = '/root/sanjie-resource-optimization-20261009'
LOCK_DIR = '/var/lib/sanjie-resource-watch'
PROC = '/proc'
GIB = 1024 ** 3
MAX_OUTPUT = 8 * 1024 * 1024
MAX_ENTRIES = 1500000
MAX_DIRECTORIES = 150000
MAX_PROCESS_ITEMS = 2000000
MAX_PATH_LINKS = 128
MAX_JSON = 128 * 1024
MAX_DEPENDENCY_DIRECTORIES = 40000
MAX_DEPENDENCY_MEMORY = 24 * 1024 * 1024
BROAD = {'/', '/root', '/opt', '/var', '/usr', '/home', '/tmp', '/var/tmp',
         '/var/lib', '/etc', '/proc', '/sys', '/dev'}


class GuardError(Exception):
    pass


class ProbeError(GuardError):
    pass


def beneath(path, root):
    return path == root or path.startswith(root + '/')


def relevant(path):
    return {root for root in ROOTS if beneath(path, root)}


def identity(metadata):
    return metadata.st_dev, metadata.st_ino


def directory(path):
    metadata = os.lstat(path)
    if not stat.S_ISDIR(metadata.st_mode) or os.path.realpath(path) != path:
        raise GuardError('directory_symlink_or_invalid')
    return metadata


def command(argv):
    # Configurations and process environments are consumed privately, never
    # emitted to stdout, JSON or exceptions.
    process = None
    try:
        # Spool to private temporary files and enforce bounds while the command
        # runs; communicate(PIPE) could exhaust memory before its final check.
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
            process = subprocess.Popen(argv, stdout=output, stderr=errors)
            deadline = time.monotonic() + 60
            while process.poll() is None:
                if (os.fstat(output.fileno()).st_size + os.fstat(errors.fileno()).st_size > MAX_OUTPUT):
                    raise ProbeError('required_command_output_limit')
                if time.monotonic() > deadline:
                    raise ProbeError('required_command_timeout')
                time.sleep(0.05)
            if process.returncode != 0:
                raise ProbeError('required_command_failed_' + os.path.basename(argv[0]))
            if os.fstat(output.fileno()).st_size + os.fstat(errors.fileno()).st_size > MAX_OUTPUT:
                raise ProbeError('required_command_output_limit')
            output.seek(0)
            errors.seek(0)
            return types.SimpleNamespace(stdout=output.read(MAX_OUTPUT + 1).decode('utf-8', 'surrogateescape'),
                                         stderr=errors.read(MAX_OUTPUT + 1).decode('utf-8', 'surrogateescape'))
    except OSError:
        raise ProbeError('required_command_unavailable_' + os.path.basename(argv[0]))
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=5)


def nginx_serving_directories(text):
    """Parse root/alias directives, never location patterns or logging paths.

    Nginx -T includes config headers and diagnostics as well as comments and
    quoted strings. Only an explicit root/alias filesystem directory can seed
    the dependency closure. Dynamic/relative serving paths require review;
    QA literal references remain protected by the entire original dump.
    """
    result, characters = set(), 0
    tokens, token = [], []
    quoted, escaped, comment = None, False, False

    def finish_token():
        if token:
            tokens.append(''.join(token))
            del token[:]
            if len(tokens) > 256:
                raise ProbeError('nginx_directive_token_limit')

    def finish_directive():
        nonlocal characters
        if tokens and tokens[0] in ('root', 'alias'):
            if len(tokens) != 2:
                raise ProbeError('nginx_serving_directive_invalid')
            path = tokens[1]
            if not path.startswith('/') or '$' in path:
                raise ProbeError('nginx_serving_directory_not_static_absolute')
            if path not in result:
                result.add(path)
                characters += len(path)
            if len(result) > 4096 or characters > 512 * 1024:
                raise ProbeError('configuration_path_inventory_limit')
        del tokens[:]

    for character in text:
        if comment:
            if character == '\n':
                comment = False
            continue
        if escaped:
            token.append(character)
            escaped = False
        elif character == '\\':
            escaped = True
        elif quoted:
            if character == quoted:
                quoted = None
            else:
                token.append(character)
        elif character in ('"', "'"):
            quoted = character
        elif character == '#':
            finish_token()
            comment = True
        elif character.isspace():
            finish_token()
        elif character == ';':
            finish_token()
            finish_directive()
        elif character in ('{', '}'):
            finish_token()
            del tokens[:]
        else:
            token.append(character)
        if len(token) > 8192:
            raise ProbeError('nginx_directive_token_length_limit')
    if quoted or escaped:
        raise ProbeError('nginx_configuration_quote_invalid')
    return result


def resolve_links(path):
    """Resolve paths with lstat, retaining intermediate dependency owners.

    os.path.realpath on Python 3.6 silently ignores inaccessible components;
    this explicit resolver treats such failures as unknown dependencies.
    Only link destinations/metadata are read, never application file contents.
    """
    if not path.startswith('/'):
        raise ProbeError('dependency_path_not_absolute')
    if len(path) > 4096:
        raise ProbeError('dependency_path_length_limit')
    # Keep '..' until components are resolved: A/link/../file refers to the
    # link destination's parent, not necessarily A/file.
    todo = path.split('/')[1:]
    resolved, references, links = '/', set(), 0
    while todo:
        component = todo.pop(0)
        if component in ('', '.'):
            continue
        if component == '..':
            resolved = os.path.dirname(resolved)
            continue
        candidate = os.path.join(resolved, component)
        references.update(relevant(candidate))
        metadata = os.lstat(candidate)
        if stat.S_ISLNK(metadata.st_mode):
            links += 1
            if links > MAX_PATH_LINKS:
                raise ProbeError('dependency_symlink_cycle_or_limit')
            destination = os.readlink(candidate)
            lexical = (destination if os.path.isabs(destination)
                       else os.path.dirname(candidate) + '/' + destination)
            references.update(relevant(os.path.normpath(lexical)))
            todo = lexical.split('/')[1:] + todo if lexical.startswith('/') else todo
            resolved = '/'
        else:
            resolved = candidate
            if todo and not stat.S_ISDIR(metadata.st_mode):
                raise ProbeError('dependency_component_not_directory')
    return resolved, references


def pinned_roots():
    if os.path.realpath(PINNED) != PINNED:
        raise ProbeError('pinned_file_symlink')
    metadata = os.lstat(PINNED)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 65536:
        raise ProbeError('pinned_file_invalid')
    roots = set()
    with open(PINNED, 'r', encoding='utf-8') as source:
        for line in source:
            path = line.strip()
            if not path or path.startswith('#'):
                continue
            if (not path.startswith('/opt/sanjie-releases/') or
                    os.path.dirname(path) != '/opt/sanjie-releases' or
                    os.path.normpath(path) != path):
                raise ProbeError('pinned_release_invalid')
            directory(path)
            roots.add(path)
    if not roots:
        raise ProbeError('pinned_file_empty')
    return roots


def pm2_online():
    try:
        apps = json.loads(command(['pm2', 'jlist']).stdout)
    except ValueError:
        raise ProbeError('pm2_json_invalid')
    if not isinstance(apps, list) or not apps:
        raise ProbeError('pm2_inventory_invalid')
    roots = set()
    for app in apps:
        if not isinstance(app, dict) or not isinstance(app.get('pm2_env'), dict):
            raise ProbeError('pm2_app_invalid')
        env = app['pm2_env']
        if env.get('status') != 'online':
            continue
        path = env.get('pm_cwd')
        if not isinstance(path, str) or not path.startswith('/'):
            raise ProbeError('pm2_online_cwd_invalid')
        roots.add(os.path.normpath(path))
    if not roots:
        raise ProbeError('pm2_online_inventory_empty')
    return roots


def process_references():
    protected, item_count = set(), 0
    with os.scandir(PROC) as entries:
        pids = [entry.name for entry in entries if entry.name.isdigit()]
    if len(pids) > 100000:
        raise ProbeError('process_inventory_limit')

    def add(path):
        if path.endswith(' (deleted)'):
            path = path[:-10]
        if path.startswith('/'):
            protected.update(relevant(os.path.normpath(path)))
        # cmdline may quote a path or concatenate it with a flag value. An
        # exact-root substring deliberately errs toward preserving the QA root.
        for root in ROOTS:
            if root in path:
                protected.add(root)

    def vanished(error):
        return error.errno in (errno.ENOENT, errno.ESRCH)

    for pid in pids:
        # This process temporarily opens candidate fds for safe deletion;
        # inventorying those fds would falsely mark every candidate in use.
        if int(pid) == os.getpid():
            continue
        base = PROC + '/' + pid
        try:
            add(os.readlink(base + '/cwd'))
        except OSError as error:
            if not vanished(error):
                raise ProbeError('process_cwd_unreadable')
        try:
            with os.scandir(base + '/fd') as descriptors:
                for entry in descriptors:
                    item_count += 1
                    if item_count > MAX_PROCESS_ITEMS:
                        raise ProbeError('process_reference_limit')
                    try:
                        add(os.readlink(entry.path))
                    except OSError as error:
                        if not vanished(error):
                            raise ProbeError('process_fd_unreadable')
        except OSError as error:
            if not vanished(error):
                raise ProbeError('process_fd_inventory_unreadable')
        try:
            with open(base + '/maps', 'r', encoding='utf-8', errors='surrogateescape') as source:
                for line in source:
                    item_count += 1
                    if item_count > MAX_PROCESS_ITEMS:
                        raise ProbeError('process_reference_limit')
                    fields = line.rstrip('\n').split(None, 5)
                    if len(fields) == 6 and fields[5].startswith('/'):
                        add(re.sub(r'\\([0-7]{3})',
                                   lambda match: chr(int(match.group(1), 8)), fields[5]))
        except OSError as error:
            if not vanished(error):
                raise ProbeError('process_maps_unreadable')
        try:
            with open(base + '/cmdline', 'rb') as source:
                raw = source.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ProbeError('process_cmdline_limit')
            add(raw.decode('utf-8', 'surrogateescape'))
        except OSError as error:
            if not vanished(error):
                raise ProbeError('process_cmdline_unreadable')
    return protected


def docker_binds():
    ids = command(['docker', 'ps', '-q', '--no-trunc']).stdout.split()
    if not ids:
        return set()
    if len(ids) > 1000 or any(not re.match(r'^[0-9a-f]{12,64}$', item) for item in ids):
        raise ProbeError('docker_inventory_invalid')
    try:
        rows = json.loads(command(['docker', 'inspect'] + ids).stdout)
    except ValueError:
        raise ProbeError('docker_json_invalid')
    if not isinstance(rows, list) or len(rows) != len(ids):
        raise ProbeError('docker_inspect_inventory_invalid')
    sources = set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('State'), dict):
            raise ProbeError('docker_state_invalid')
        # A race to a stopped container is safe; any new running container is
        # observed by the next mandatory snapshot immediately before deletion.
        if not row['State'].get('Running'):
            continue
        mounts = row.get('Mounts')
        if not isinstance(mounts, list):
            raise ProbeError('docker_mount_inventory_invalid')
        for mount in mounts:
            if not isinstance(mount, dict):
                raise ProbeError('docker_mount_invalid')
            if mount.get('Type') == 'bind':
                source = mount.get('Source')
                if not isinstance(source, str) or not source.startswith('/'):
                    raise ProbeError('docker_bind_source_invalid')
                sources.add(os.path.normpath(source))
    return sources


def mounts():
    result = set()
    with open(PROC + '/self/mountinfo', 'r', encoding='utf-8') as source:
        for line in source:
            fields = line.split()
            if len(fields) < 7 or '-' not in fields:
                raise ProbeError('mountinfo_invalid')
            path = re.sub(r'\\([0-7]{3})',
                          lambda match: chr(int(match.group(1), 8)), fields[4])
            if not path.startswith('/'):
                raise ProbeError('mountinfo_path_invalid')
            result.add(os.path.normpath(path))
    if not result:
        raise ProbeError('mountinfo_empty')
    return result


def symlink_dependencies(seeds):
    """Stream protected directories and their directory-link closure, bounded.

    Child directories are opened relative to fds with O_NOFOLLOW. Directory
    symlinks are never followed by the walker: resolved targets are separately
    queued with identities checked. File bytes are never read.
    """
    protected, pending, seen = set(), [], set()
    counters = {'entries': 0, 'directories': 0, 'memory': 0}

    def path_cost(path):
        # A conservative bound for Python's string, tuple/set/list references
        # and inode integers, including wide Unicode storage.
        return 512 + 4 * len(path)

    def enqueue(path):
        counters['memory'] += path_cost(path)
        if (len(pending) >= MAX_DEPENDENCY_DIRECTORIES or
                counters['memory'] > MAX_DEPENDENCY_MEMORY):
            raise ProbeError('dependency_path_memory_limit')
        pending.append(path)

    for seed in seeds:
        enqueue(seed)

    def walk(fd, path, depth):
        if depth > 128:
            raise ProbeError('dependency_tree_depth_limit')
        opened = os.fstat(fd)
        key = identity(opened) + (path,)
        if key in seen:
            return
        counters['memory'] += path_cost(path)
        if counters['memory'] > MAX_DEPENDENCY_MEMORY:
            raise ProbeError('dependency_path_memory_limit')
        seen.add(key)
        counters['directories'] += 1
        if counters['directories'] > MAX_DEPENDENCY_DIRECTORIES:
            raise ProbeError('dependency_directory_limit')
        with os.scandir(PROC + '/self/fd/' + str(fd)) as entries:
            for entry in entries:
                counters['entries'] += 1
                if counters['entries'] > MAX_ENTRIES:
                    raise ProbeError('dependency_entry_limit')
                child_path = path + '/' + entry.name
                metadata = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISLNK(metadata.st_mode):
                    link = os.readlink(entry.name, dir_fd=fd)
                    target = link if os.path.isabs(link) else path + '/' + link
                    resolved, references = resolve_links(target)
                    protected.update(references)
                    protected.update(relevant(resolved))
                    target_stat = os.lstat(resolved)
                    if stat.S_ISDIR(target_stat.st_mode):
                        enqueue(resolved)
                elif stat.S_ISDIR(metadata.st_mode):
                    child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                    dir_fd=fd)
                    try:
                        if identity(os.fstat(child)) != identity(metadata):
                            raise ProbeError('dependency_directory_identity_changed')
                        walk(child, child_path, depth + 1)
                    finally:
                        os.close(child)

    while pending:
        path = pending.pop()
        counters['memory'] -= path_cost(path)
        resolved, references = resolve_links(path)
        protected.update(references)
        protected.update(relevant(resolved))
        if resolved in BROAD:
            raise ProbeError('dependency_seed_too_broad')
        metadata = directory(resolved)
        fd = os.open(resolved, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            if identity(os.fstat(fd)) != identity(metadata):
                raise ProbeError('dependency_seed_identity_changed')
            walk(fd, resolved, 0)
        finally:
            os.close(fd)
    return protected


def snapshot():
    try:
        directory(PARENT)
        online = pm2_online()
        pinned = pinned_roots()
        nginx_result = command(['nginx', '-T'])
        nginx = nginx_result.stdout + nginx_result.stderr
        binds = docker_binds()
        protected = process_references()
        direct = online | pinned | binds
        for path in direct:
            protected.update(relevant(path))
            resolved, references = resolve_links(path)
            protected.update(references | relevant(resolved))
        for root in ROOTS:
            if root in nginx:
                protected.add(root)
            # Binding an ancestor exposes every contained QA build.
            if any(beneath(root, bind) for bind in binds):
                protected.add(root)
        # Live/pinned roots always seed the closure. Explicit Nginx serving
        # directories and Docker bind directories seed it as well.
        seeds = set(online | pinned)
        for path in binds | nginx_serving_directories(nginx):
            try:
                resolved, references = resolve_links(path)
                protected.update(references | relevant(resolved))
                if stat.S_ISDIR(os.lstat(resolved).st_mode):
                    seeds.add(resolved)
            except FileNotFoundError:
                # A nonexistent configured serving directory cannot currently
                # supply any files. QA literals still protect the named roots.
                if path in binds:
                    raise ProbeError('docker_bind_source_missing')
                continue
        protected.update(symlink_dependencies(seeds))
        return {'protected': protected, 'mounts': mounts(),
                'parent': identity(directory(PARENT))}
    except (GuardError, OSError, ValueError, KeyError) as error:
        reason = str(error) if isinstance(error, GuardError) else 'required_protective_input_unavailable'
        raise ProbeError(reason)


def tree_fd(fd, device, remove=False, depth=0, counters=None):
    """Bounded equivalent of retention.walk_fd: never follows child symlinks."""
    if depth > 128:
        raise GuardError('build_tree_depth_limit')
    if counters is None:
        counters = {'entries': 0, 'directories': 0}
    counters['directories'] += 1
    if counters['directories'] > MAX_DIRECTORIES:
        raise GuardError('build_directory_limit')
    allocated = os.fstat(fd).st_blocks * 512
    with os.scandir(PROC + '/self/fd/' + str(fd)) as entries:
        for entry in entries:
            counters['entries'] += 1
            if counters['entries'] > MAX_ENTRIES:
                raise GuardError('build_entry_limit')
            metadata = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
            if metadata.st_dev != device:
                raise GuardError('build_crosses_filesystem')
            if stat.S_ISDIR(metadata.st_mode):
                child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                dir_fd=fd)
                try:
                    actual = os.fstat(child)
                    if identity(actual) != identity(metadata):
                        raise GuardError('build_directory_identity_changed')
                    allocated += tree_fd(child, device, remove, depth + 1, counters)
                    if identity(os.stat(entry.name, dir_fd=fd, follow_symlinks=False)) != identity(actual):
                        raise GuardError('build_directory_identity_changed')
                    if remove:
                        os.rmdir(entry.name, dir_fd=fd)
                finally:
                    os.close(child)
            else:
                allocated += metadata.st_blocks * 512
                if remove:
                    os.unlink(entry.name, dir_fd=fd)
    return allocated


def check(row, guards, owned):
    if row['root'] not in ROOTS or row['path'] != row['root'] + '/' + row['leaf'] or row['leaf'] not in LEAVES:
        raise GuardError('target_outside_explicit_allowlist')
    if row['root'] in guards['protected']:
        raise GuardError('runtime_or_dependency_reference')
    if any(beneath(mount, row['root']) for mount in guards['mounts']):
        raise GuardError('candidate_contains_mountpoint')
    if identity(directory(PARENT)) != row['parent_identity'] or guards['parent'] != row['parent_identity']:
        raise GuardError('parent_identity_changed')
    root_stat, leaf_stat = directory(row['root']), directory(row['path'])
    if identity(root_stat) != row['root_identity'] or identity(leaf_stat) != row['leaf_identity']:
        raise GuardError('candidate_identity_changed')
    if root_stat.st_mtime_ns != owned.get(row['root'], row['root_mtime_ns']):
        raise GuardError('candidate_root_modified')
    if root_stat.st_dev != row['parent_identity'][0] or leaf_stat.st_dev != root_stat.st_dev:
        raise GuardError('candidate_crosses_filesystem')


def open_target(row):
    parent_fd = os.open(PARENT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    root_fd = target_fd = None
    try:
        if identity(os.fstat(parent_fd)) != row['parent_identity']:
            raise GuardError('opened_parent_identity_changed')
        root_fd = os.open(os.path.basename(row['root']), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                          dir_fd=parent_fd)
        if identity(os.fstat(root_fd)) != row['root_identity']:
            raise GuardError('opened_root_identity_changed')
        target_fd = os.open(row['leaf'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=root_fd)
        if identity(os.fstat(target_fd)) != row['leaf_identity']:
            raise GuardError('opened_leaf_identity_changed')
        return parent_fd, root_fd, target_fd
    except Exception:
        for fd in (target_fd, root_fd, parent_fd):
            if fd is not None:
                os.close(fd)
        raise


def write_json(value):
    path = STATE + '/qa-build-cleanup-result.json'
    if os.path.lexists(path) and stat.S_ISLNK(os.lstat(path).st_mode):
        raise GuardError('state_file_symlink')
    raw = json.dumps(value, sort_keys=True, indent=2) + '\n'
    if len(raw.encode('utf-8')) > MAX_JSON:
        raise GuardError('state_output_limit')
    fd, temporary = tempfile.mkstemp(prefix='.qa-build-cleanup-', dir=STATE)
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
    guards = snapshot()
    if any(beneath(os.getcwd(), root) for root in ROOTS):
        raise GuardError('operator_cwd_inside_candidate')
    targets, outcomes, owned = [], [], {}
    for root in ROOTS:
        try:
            root_stat = directory(root)
        except FileNotFoundError:
            outcomes.append({'root': root, 'status': 'absent'})
            continue
        for leaf in LEAVES:
            path = root + '/' + leaf
            try:
                if not stat.S_ISDIR(os.lstat(path).st_mode):
                    outcomes.append({'path': path, 'status': 'preserved_symlink_or_non_directory'})
                    continue
                metadata = directory(path)
            except FileNotFoundError:
                outcomes.append({'path': path, 'status': 'absent'})
                continue
            targets.append({'root': root, 'path': path, 'leaf': leaf,
                            'parent_identity': guards['parent'],
                            'root_identity': identity(root_stat),
                            'leaf_identity': identity(metadata),
                            'root_mtime_ns': root_stat.st_mtime_ns})
    budget = int(args.max_gib * GIB)
    selected = removed = 0
    counts = {}
    for row in targets:
        fds, started, current_size = (), False, 0
        status, reason = '', ''
        try:
            fresh = snapshot()
            check(row, fresh, owned)
            fds = open_target(row)
            current_size = tree_fd(fds[2], row['leaf_identity'][0])
            # A full tree preflight can take time. Refresh every inventory,
            # then recheck root/leaf identities before any destructive action.
            fresh = snapshot()
            check(row, fresh, owned)
            if identity(os.fstat(fds[2])) != row['leaf_identity']:
                raise GuardError('held_leaf_identity_changed')
            if selected + current_size > budget:
                raise GuardError('eight_gib_per_run_budget')
            if args.apply:
                started = True
                tree_fd(fds[2], row['leaf_identity'][0], remove=True)
                if identity(os.stat(row['leaf'], dir_fd=fds[1], follow_symlinks=False)) != row['leaf_identity']:
                    raise GuardError('leaf_identity_changed_before_rmdir')
                os.rmdir(row['leaf'], dir_fd=fds[1])
                owned[row['root']] = os.fstat(fds[1]).st_mtime_ns
                removed += current_size
                status = 'removed'
            else:
                status = 'would_remove'
            selected += current_size
        except ProbeError as error:
            # Losing any required inventory stops the entire run, including
            # dry-run. Do not turn inaccessible evidence into an eligible skip.
            status, reason = 'guard_probe_failed', str(error)
        except OSError:
            if not started:
                status, reason = 'guard_probe_failed', 'candidate_filesystem_inventory_unavailable'
            else:
                status, reason = 'failed_during_removal', 'filesystem_removal_failed'
                selected += current_size
        except GuardError as error:
            status = 'failed_during_removal' if started else 'skipped'
            reason = str(error)
            if started:
                selected += current_size
        finally:
            for fd in reversed(fds):
                os.close(fd)
        counts[status] = counts.get(status, 0) + 1
        outcomes.append({'path': row['path'], 'status': status, 'reason': reason,
                         'allocated_bytes_upper_bound': current_size})
        if status in ('failed_during_removal', 'guard_probe_failed'):
            break
    failed = counts.get('guard_probe_failed') or counts.get('failed_during_removal')
    final_status = ('partial' if counts.get('failed_during_removal') or removed else 'failed_closed') if failed else 'completed'
    result = {'completedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'operation': 'remove_explicit_historical_qa_build_leaves_only',
              'status': final_status,
              'apply': args.apply, 'budget_bytes': budget,
              'selected_allocated_bytes_upper_bound': selected,
              'removed_allocated_bytes_upper_bound': removed,
              'counts': counts, 'outcomes': outcomes,
              'planned_targets': len(targets), 'processed_targets': sum(counts.values())}
    write_json(result)
    return result


def private_directory(path):
    os.makedirs(path, mode=0o700, exist_ok=True)
    metadata = directory(path)
    if metadata.st_uid != 0 or metadata.st_mode & 0o077:
        raise GuardError('state_directory_not_private_root_owned')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--max-gib', type=float, default=8)
    args = parser.parse_args()
    if not math.isfinite(args.max_gib) or not 0 < args.max_gib <= 8:
        parser.error('--max-gib must be greater than zero and at most 8')
    if os.geteuid() != 0:
        parser.error('root is required for complete runtime reference inventory')
    os.umask(0o077)
    lock_fd = None
    try:
        private_directory(STATE)
        private_directory(LOCK_DIR)
        lock_fd = os.open(LOCK_DIR + '/build-retention.lock',
                          os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        metadata = os.fstat(lock_fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o077:
            raise GuardError('global_lock_invalid')
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'status': 'skipped', 'reason': 'global_cleanup_already_running'}))
            return 0
        result = run(args)
        code = 1 if result['status'] != 'completed' else 0
        summary = {key: result[key] for key in
                   ('status', 'apply', 'counts', 'planned_targets', 'processed_targets',
                    'removed_allocated_bytes_upper_bound')}
    except (GuardError, OSError, ValueError, KeyError) as error:
        reason = str(error) if isinstance(error, GuardError) else 'protective_input_unavailable_or_invalid'
        summary = {'status': 'failed_closed', 'apply': args.apply, 'reason': reason}
        if lock_fd is not None:
            try:
                write_json(summary)
            except (GuardError, OSError):
                pass
        code = 1
    finally:
        if lock_fd is not None:
            os.close(lock_fd)
    print(json.dumps(summary, sort_keys=True))
    return code


if __name__ == '__main__':
    sys.exit(main())
