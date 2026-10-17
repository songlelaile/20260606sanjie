#!/usr/bin/env python3
"""One-time, reversible byte-identical deduplication of inactive software ZIPs.

No app restart, content deletion, active/pinned donor mutation, or store GC.
Defaults to plan; --apply requires the previously written, reviewed plan.
Python 3.6+, root on Linux. The approved retention guard is an owning dependency.
"""
import argparse
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time

BASE = '/opt/sanjie-releases'
OUT = '/root/sanjie-resource-optimization-20261009/phase2'
STORE = '/var/lib/sanjie-release-assets/sha256'
PLAN = OUT + '/download-dedupe-plan.json'
JOURNAL = OUT + '/download-dedupe-manifest.jsonl'
RESULT = OUT + '/download-dedupe-result.json'
GIB = 1024 ** 3
MAX_TARGETS = 12000
MAX_PLAN = 16 * 1024 * 1024
NAMES = re.compile(r'^(?:shaozhuang-ai-v\d+\.\d+\.\d+-macos-full|sycm-keyword-collector-v\d+\.\d+\.\d+)\.zip$')
spec = importlib.util.spec_from_file_location('retention', '/usr/local/libexec/sanjie-release-build-retention.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def ident(m):
    return [m.st_dev, m.st_ino]


def metadata(m):
    return {'identity': ident(m), 'size': m.st_size, 'mtime_ns': m.st_mtime_ns,
            'ctime_ns': m.st_ctime_ns, 'blocks': m.st_blocks * 512,
            'mode': stat.S_IMODE(m.st_mode), 'uid': m.st_uid, 'gid': m.st_gid,
            'atime_ns': m.st_atime_ns, 'nlink': m.st_nlink}


def safe_dir(path):
    m = guard.directory(path)
    if m.st_uid != 0 or m.st_mode & 0o022:
        raise guard.GuardError('directory_owner_or_permissions_unsafe')
    return m


def digest(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            raise guard.GuardError('asset_not_regular')
        h = hashlib.sha256()
        while True:
            b = os.read(fd, 1024 * 1024)
            if not b:
                break
            h.update(b)
        after = os.fstat(fd)
        if (ident(before), before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (ident(after), after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise guard.GuardError('asset_changed_while_hashing')
        return h.hexdigest(), metadata(after)
    finally:
        os.close(fd)


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def fsync_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def json_write(path, value):
    fd, temporary = tempfile.mkstemp(prefix='.dedupe-', dir=OUT)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f, indent=2, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
        fsync_dir(OUT)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def runtime_stamp():
    apps = json.loads(guard.command(['pm2', 'jlist']).stdout)
    pm = sorted((a['pm_id'], a['pid'], a['pm2_env']['pm_cwd'], a['pm2_env'].get('restart_time'))
                for a in apps if a['pm2_env']['status'] == 'online')
    ng = guard.command(['nginx', '-T']).stdout
    ids = guard.command(['docker', 'ps', '-q', '--no-trunc']).stdout.split()
    containers = json.loads(guard.command(['docker', 'inspect'] + ids).stdout) if ids else []
    dc = sorted((c['Id'], c['State']['StartedAt'], c['RestartCount']) for c in containers)
    return {'pm2': pm, 'nginx': hashlib.sha256(ng.encode()).hexdigest(), 'docker': dc}


def docker_protection():
    ids = guard.command(['docker', 'ps', '-q', '--no-trunc']).stdout.split()
    rows = json.loads(guard.command(['docker', 'inspect'] + ids).stdout) if ids else []
    protected = set()
    for c in rows:
        for m in c['Mounts']:
            if m.get('Type') != 'bind':
                continue
            source = os.path.normpath(m['Source'])
            if guard.beneath(BASE, source):
                protected.update(r for _, _, r in guard.probe_snapshot()['roots'])
            root = guard.release_for_path(source)
            if root:
                protected.add(root)
            resolved = guard.release_for_path(os.path.realpath(source))
            if resolved:
                protected.add(resolved)
    return protected


def protected(root, s, extra):
    # The preceding build cleanup legitimately updated release root mtimes.
    # Downloads and individual ZIP mtimes remain independent and must be old.
    if root in extra or any(root in s[k] for k in ('pinned', 'latest', 'symlink_referenced')):
        return True
    if root in s['nginx'] or any(guard.beneath(p, root) for k in ('online', 'port_referenced', 'processes') for p in s[k]):
        return True
    return any(guard.beneath(p, root) for p in s['mounts'])


def validate_path(row, owned_mtimes=None):
    root, path = row['root'], row['path']
    if not guard.valid_release(root) or os.path.dirname(path) != root + '/public/downloads' or not NAMES.fullmatch(os.path.basename(path)):
        raise guard.GuardError('asset_outside_exact_allowlist')
    if not re.fullmatch(r'[0-9a-f]{64}', row['sha256']):
        raise guard.GuardError('asset_digest_invalid')
    for p, expected in zip((root, root + '/public', root + '/public/downloads'), row['directories']):
        if ident(safe_dir(p)) != expected:
            raise guard.GuardError('asset_parent_identity_changed')
    parent = os.path.dirname(path)
    expected_time = (owned_mtimes or {}).get(parent, row['downloads_mtime_ns'])
    if os.stat(parent).st_mtime_ns != expected_time:
        raise guard.GuardError('download_directory_modified_after_plan')
    m = os.lstat(path)
    expected = row['metadata']
    if not stat.S_ISREG(m.st_mode) or m.st_nlink != 1 or m.st_uid != 0 or m.st_mode & 0o022:
        raise guard.GuardError('asset_type_owner_links_or_mode_unsafe')
    if m.st_dev != row['directories'][0][0]:
        raise guard.GuardError('asset_crosses_filesystem')
    if any(metadata(m)[k] != expected[k] for k in ('identity', 'size', 'mtime_ns', 'ctime_ns', 'mode', 'uid', 'gid', 'nlink')):
        raise guard.GuardError('asset_metadata_changed')
    if m.st_mtime > time.time() - 48 * 3600:
        raise guard.GuardError('asset_modified_recently')
    if not 0 < m.st_size <= GIB or m.st_size > m.st_blocks * 512 + 4096:
        raise guard.GuardError('asset_size_limit_or_sparse_file')
    return m


def make_plan():
    s = guard.probe_snapshot()
    extra = docker_protection()
    groups, skipped = {}, 0
    for _, _, root in sorted(s['roots']):
        if protected(root, s, extra):
            skipped += 1
            continue
        paths = (root, root + '/public', root + '/public/downloads')
        try:
            dirs = [safe_dir(p) for p in paths]
        except (OSError, guard.GuardError):
            continue
        if any(m.st_dev != s['base_device'] for m in dirs) or dirs[-1].st_mtime > time.time() - 48 * 3600:
            continue
        for name in sorted(os.listdir(paths[-1])):
            if not NAMES.fullmatch(name):
                continue
            path = paths[-1] + '/' + name
            m = os.lstat(path)
            if not stat.S_ISREG(m.st_mode) or m.st_nlink != 1 or m.st_uid != 0 or m.st_mode & 0o022 or m.st_mtime > time.time() - 48 * 3600:
                continue
            if not 0 < m.st_size <= GIB or m.st_size > m.st_blocks * 512 + 4096:
                continue
            h, meta = digest(path)
            row = {'root': root, 'path': path, 'sha256': h,
                   'directories': [ident(d) for d in dirs],
                   'downloads_mtime_ns': dirs[-1].st_mtime_ns, 'metadata': meta}
            validate_path(row)
            groups.setdefault((h, meta['size']), []).append(row)
            if sum(len(v) for v in groups.values()) > MAX_TARGETS:
                raise guard.GuardError('asset_count_limit')
    selected = [v for _, v in sorted(groups.items()) if len(v) >= 2]
    targets = [r for group in selected for r in group]
    allocated = sum(r['metadata']['blocks'] for r in targets)
    estimate = allocated - sum(group[0]['metadata']['blocks'] for group in selected)
    result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'operation': 'reversible_inactive_public_software_zip_dedupe',
              'targets': targets, 'groups': len(selected), 'skipped_protected_roots': skipped,
              'allocated_bytes': allocated, 'estimated_net_saved_bytes': estimate,
              'runtime_stamp': runtime_stamp()}
    json_write(PLAN, result)
    print('DEDUPE_PLAN', len(targets), 'files', len(selected), 'content_groups',
          'estimated_net_saved_gib', round(estimate / GIB, 3), 'protected_roots', skipped)


def store_file(row):
    path = STORE + '/' + row['sha256'] + '.zip'
    if os.path.lexists(path):
        h, meta = digest(path)
        if h != row['sha256'] or meta['size'] != row['metadata']['size'] or meta['uid'] != 0 or meta['mode'] != 0o444:
            raise guard.GuardError('existing_canonical_invalid')
        fsync_file(path)
        fsync_dir(STORE)
        return path, 0
    fs = os.statvfs(STORE)
    if fs.f_bavail * fs.f_frsize < row['metadata']['size'] + 2 * GIB + 5 * 1024 * 1024:
        raise guard.GuardError('canonical_copy_requires_two_gib_disk_reserve')
    fd, temporary = tempfile.mkstemp(prefix='.asset-', dir=STORE)
    try:
        with os.fdopen(fd, 'wb') as f:
            source_fd = os.open(row['path'], os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(source_fd, 'rb') as source:
                shutil.copyfileobj(source, f, 1024 * 1024)
            f.flush()
            os.fsync(f.fileno())
        h, meta = digest(temporary)
        if h != row['sha256'] or meta['size'] != row['metadata']['size']:
            raise guard.GuardError('canonical_copy_digest_mismatch')
        os.chmod(temporary, 0o444)
        fsync_file(temporary)
        os.replace(temporary, path)
        fsync_dir(STORE)
        return path, os.stat(path).st_blocks * 512
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def append(fd, value):
    b = (json.dumps(value, sort_keys=True) + '\n').encode()
    while b:
        n = os.write(fd, b)
        b = b[n:]
    os.fsync(fd)


def apply_plan(max_gib):
    if os.path.realpath(PLAN) != PLAN or os.stat(PLAN).st_size > MAX_PLAN:
        raise guard.GuardError('plan_path_invalid')
    plan = json.loads(open(PLAN).read())
    if plan['operation'] != 'reversible_inactive_public_software_zip_dedupe' or len(plan['targets']) > MAX_TARGETS:
        raise guard.GuardError('plan_operation_or_count_invalid')
    # JSON converts tuples to lists; compare normalized values.
    if json.loads(json.dumps(runtime_stamp())) != plan['runtime_stamp']:
        raise guard.GuardError('running_application_changed_since_plan')
    budget = int(max_gib * GIB)
    total_blocks = sum(r['metadata']['blocks'] for r in plan['targets'])
    total_size = sum(r['metadata']['size'] for r in plan['targets'])
    if plan['allocated_bytes'] != total_blocks or max(total_blocks, total_size) > budget:
        raise guard.GuardError('reviewed_plan_exceeds_budget')
    if len({r['path'] for r in plan['targets']}) != len(plan['targets']):
        raise guard.GuardError('plan_contains_duplicate_paths')
    for p in ('/var/lib/sanjie-release-assets', STORE):
        os.makedirs(p, mode=0o755, exist_ok=True)
        safe_dir(p)
        # The store contains only public software downloads. Explicit modes
        # survive the private audit umask and allow future restore tooling.
        os.chmod(p, 0o755)
        fsync_dir(p)
        fsync_dir(os.path.dirname(p))
    fd = os.open(JOURNAL, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.fsync(fd)
    fsync_dir(OUT)
    removed, created, count, owned_mtimes = 0, 0, 0, {}
    try:
        for root in sorted({r['root'] for r in plan['targets']}):
            fresh = guard.probe_snapshot()
            if json.loads(json.dumps(runtime_stamp())) != plan['runtime_stamp']:
                raise guard.GuardError('running_application_changed_during_dedupe')
            if protected(root, fresh, docker_protection()):
                raise guard.GuardError('planned_root_became_protected')
            for row in (r for r in plan['targets'] if r['root'] == root):
                validate_path(row, owned_mtimes)
                h, _ = digest(row['path'])
                if h != row['sha256']:
                    raise guard.GuardError('source_digest_changed')
                canonical, new_bytes = store_file(row)
                created += new_bytes
                parent = os.path.dirname(row['path'])
                parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                tmp = '.dedupe-' + os.path.basename(row['path'])
                try:
                    if ident(os.fstat(parent_fd)) != row['directories'][-1]:
                        raise guard.GuardError('held_download_directory_changed')
                    validate_path(row, owned_mtimes)
                    append(fd, {'event': 'prepared', 'row': row, 'canonical': canonical})
                    os.symlink(canonical, tmp, dir_fd=parent_fd)
                    # Our private temporary link intentionally changes this
                    # directory mtime; account for only our own mutation.
                    owned_mtimes[parent] = os.fstat(parent_fd).st_mtime_ns
                    # Large hashing/copying has finished. Recheck every live
                    # dependency, route, pin and process immediately before
                    # changing the original pathname.
                    fresh = guard.probe_snapshot()
                    if protected(root, fresh, docker_protection()) or json.loads(json.dumps(runtime_stamp())) != plan['runtime_stamp']:
                        raise guard.GuardError('runtime_or_dependencies_changed_before_replace')
                    validate_path(row, owned_mtimes)
                    os.replace(tmp, os.path.basename(row['path']), src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
                    os.fsync(parent_fd)
                    owned_mtimes[parent] = os.fstat(parent_fd).st_mtime_ns
                    # Verify via the retained original path, following only our
                    # exact new link to a canonical file whose hash is verified.
                    if os.readlink(row['path']) != canonical or not os.path.isfile(row['path']) or os.stat(row['path']).st_size != row['metadata']['size']:
                        raise guard.GuardError('replacement_link_validation_failed')
                    removed += row['metadata']['blocks']
                    count += 1
                    append(fd, {'event': 'committed', 'path': row['path'], 'sha256': row['sha256']})
                finally:
                    try:
                        os.unlink(tmp, dir_fd=parent_fd)
                    except FileNotFoundError:
                        pass
                    os.close(parent_fd)
        json_write(RESULT, {'status': 'completed', 'files_deduplicated': count,
                           'original_allocated_bytes_released': removed,
                           'canonical_allocated_bytes_created': created,
                           'net_saved_bytes_upper_bound': removed - created,
                           'restore_manifest': JOURNAL, 'canonical_store': STORE,
                           'at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        print('DEDUPE_COMPLETED', count, 'files', 'net_saved_gib', round((removed - created) / GIB, 3))
    except Exception:
        json_write(RESULT, {'status': 'stopped', 'files_deduplicated': count,
                           'original_allocated_bytes_released': removed,
                           'canonical_allocated_bytes_created': created,
                           'restore_manifest': JOURNAL})
        raise
    finally:
        os.close(fd)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--apply', action='store_true')
    p.add_argument('--max-gib', type=int, default=60, choices=range(1, 61))
    args = p.parse_args()
    if os.geteuid() != 0:
        p.error('root required')
    os.umask(0o077)
    safe_dir(OUT)
    fd = os.open('/var/lib/sanjie-resource-watch/build-retention.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.apply:
            apply_plan(args.max_gib)
        else:
            make_plan()
    except (guard.GuardError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as e:
        print('STOPPED_SAFELY', str(e) if isinstance(e, guard.GuardError) else 'required_probe_or_filesystem_error')
        return 1
    finally:
        os.close(fd)
    return 0


if __name__ == '__main__':
    sys.exit(main())
