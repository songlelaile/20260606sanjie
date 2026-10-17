#!/usr/bin/env python3
"""Restore one inactive release's deduplicated public software ZIPs.

Python 3.6+, Linux, root. A fixed private manifest is the only allowlist. The
default is dry-run; --apply copies verified canonical bytes back to regular
files, retaining original owner, permissions and times. No service is restarted.
The canonical store and deduplication manifest are never removed or rewritten.
"""
import argparse
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import stat
import sys

BASE = '/opt/sanjie-releases'
# A checksum-verified copy of the completed dedupe manifest belongs here.
# Every ancestor is required to be root-owned, including this 0700 directory.
OUT = '/var/lib/sanjie-resource-watch/download-restore-20261009'
STORE = '/var/lib/sanjie-release-assets/sha256'
MANIFEST = OUT + '/download-dedupe-manifest.jsonl'
RESULT_NAME = 'download-restore-result.json'
LOCK = '/var/lib/sanjie-resource-watch/build-retention.lock'
GUARD_SOURCE = '/usr/local/libexec/sanjie-release-build-retention.py'
GIB = 1024 ** 3
RESERVE = 2 * GIB
ROOT_UID = 0
MAX_MANIFEST_BYTES = 32 * 1024 * 1024
MAX_TARGETS = 12000
NAMES = re.compile(r'^(?:shaozhuang-ai-v\d+\.\d+\.\d+-macos-full|sycm-keyword-collector-v\d+\.\d+\.\d+)\.zip$')
guard = None


class RestoreError(Exception):
    pass


class ReplacedError(RestoreError):
    """Atomic replacement happened, but its final verification did not finish."""
    pass


def ident(m):
    return [m.st_dev, m.st_ino]


def valid_release(path):
    return (isinstance(path, str) and os.path.isabs(path)
            and os.path.normpath(path) == path and os.path.dirname(path) == BASE
            and os.path.basename(path) not in ('', '.', '..'))


def root_directory(m):
    if not stat.S_ISDIR(m.st_mode) or m.st_uid != ROOT_UID or m.st_mode & 0o022:
        raise RestoreError('unsafe_directory_owner_or_mode')


def open_directory(path):
    """Walk every absolute component through held no-follow directory fds."""
    if not isinstance(path, str) or not path.startswith('/') or os.path.normpath(path) != path:
        raise RestoreError('directory_path_invalid')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        root_directory(os.fstat(fd))
        for part in path.split('/')[1:]:
            if not part:
                continue
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                root_directory(os.fstat(child))
            except Exception:
                os.close(child)
                raise
            os.close(fd)
            fd = child
        return fd
    except Exception:
        os.close(fd)
        raise


def nonnegative(value):
    return type(value) is int and value >= 0


def validate_row(row, canonical):
    if not isinstance(row, dict) or not valid_release(row.get('root')):
        raise RestoreError('manifest_release_invalid')
    path, digest = row.get('path'), row.get('sha256')
    if (not isinstance(path, str) or os.path.normpath(path) != path
            or os.path.dirname(path) != row['root'] + '/public/downloads'
            or not NAMES.fullmatch(os.path.basename(path))):
        raise RestoreError('manifest_path_outside_exact_software_allowlist')
    if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
        raise RestoreError('manifest_digest_invalid')
    if canonical != STORE + '/' + digest + '.zip':
        raise RestoreError('manifest_canonical_outside_exact_store')
    directories = row.get('directories')
    if (not isinstance(directories, list) or len(directories) != 3
            or any(not isinstance(d, list) or len(d) != 2
                   or not all(nonnegative(v) for v in d) for d in directories)
            or any(d[0] != directories[0][0] for d in directories)):
        raise RestoreError('manifest_directory_identity_invalid')
    metadata = row.get('metadata')
    if not isinstance(metadata, dict):
        raise RestoreError('manifest_original_metadata_invalid')
    for key in ('size', 'mtime_ns', 'ctime_ns', 'blocks', 'mode', 'uid', 'gid', 'atime_ns', 'nlink'):
        if not nonnegative(metadata.get(key)):
            raise RestoreError('manifest_original_metadata_invalid')
    if (not isinstance(metadata.get('identity'), list) or len(metadata['identity']) != 2
            or not all(nonnegative(v) for v in metadata['identity'])
            or metadata['identity'][0] != directories[0][0]
            or metadata['uid'] != ROOT_UID or metadata['nlink'] != 1
            or metadata['mode'] > 0o777 or metadata['mode'] & 0o022):
        raise RestoreError('manifest_original_owner_mode_or_links_invalid')


def read_manifest(release):
    out_fd = open_directory(OUT)
    try:
        if stat.S_IMODE(os.fstat(out_fd).st_mode) != 0o700:
            raise RestoreError('manifest_directory_not_private')
        fd = os.open(os.path.basename(MANIFEST), os.O_RDONLY | os.O_NOFOLLOW, dir_fd=out_fd)
        with os.fdopen(fd, 'rb') as source:
            before = os.fstat(source.fileno())
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != ROOT_UID
                    or stat.S_IMODE(before.st_mode) != 0o600 or before.st_nlink != 1
                    or before.st_size > MAX_MANIFEST_BYTES):
                raise RestoreError('manifest_not_private_regular_file_or_too_large')
            data = source.read(MAX_MANIFEST_BYTES + 1)
            after = os.fstat(source.fileno())
            if (ident(before), before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (ident(after), after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise RestoreError('manifest_changed_while_reading')
        if len(data) > MAX_MANIFEST_BYTES:
            raise RestoreError('manifest_too_large')
        prepared, committed = {}, set()
        # The writer appends one newline-terminated record and fsyncs it before
        # replacing an asset. A crash can leave only the last append partial.
        # Discard that undelimited suffix (including invalid UTF-8), but parse
        # every newline-complete record strictly. In particular a durable
        # prepared row remains recoverable when its committed append is torn.
        complete_lines = data.split(b'\n')[:-1]
        for raw_line in complete_lines:
            line = raw_line.decode('utf-8')
            event = json.loads(line)
            if not isinstance(event, dict):
                raise RestoreError('manifest_event_invalid')
            if event.get('event') == 'prepared':
                row, canonical = event.get('row'), event.get('canonical')
                validate_row(row, canonical)
                if row['path'] in prepared or len(prepared) >= MAX_TARGETS:
                    raise RestoreError('manifest_duplicate_or_target_count_invalid')
                prepared[row['path']] = {'row': row, 'canonical': canonical, 'committed': False}
            elif event.get('event') == 'committed':
                path = event.get('path')
                if (not isinstance(path, str) or path not in prepared or path in committed
                        or event.get('sha256') != prepared[path]['row']['sha256']):
                    raise RestoreError('manifest_commit_without_matching_prepare')
                committed.add(path)
                prepared[path]['committed'] = True
            else:
                raise RestoreError('manifest_event_unknown')
        return [v for _, v in sorted(prepared.items()) if v['row']['root'] == release]
    finally:
        os.close(out_fd)


def open_parents(row):
    held = []
    try:
        for path, expected in zip((row['root'], row['root'] + '/public', row['root'] + '/public/downloads'), row['directories']):
            fd = open_directory(path)
            held.append(fd)
            if ident(os.fstat(fd)) != expected:
                raise RestoreError('original_parent_identity_or_device_changed')
        return held
    except Exception:
        for fd in held:
            os.close(fd)
        raise


def hash_fd(fd):
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode):
        raise RestoreError('hash_source_not_regular')
    os.lseek(fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    while True:
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
    after = os.fstat(fd)
    if (ident(before), before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (ident(after), after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise RestoreError('hash_source_changed')
    return digest.hexdigest(), after


def open_canonical(entry):
    fd_dir = open_directory(STORE)
    try:
        fd = os.open(os.path.basename(entry['canonical']), os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd_dir)
        try:
            digest, metadata = hash_fd(fd)
            row = entry['row']
            if (digest != row['sha256'] or metadata.st_size != row['metadata']['size']
                    or metadata.st_uid != ROOT_UID or stat.S_IMODE(metadata.st_mode) != 0o444
                    or metadata.st_nlink != 1 or metadata.st_dev != row['directories'][0][0]):
                raise RestoreError('canonical_digest_size_owner_mode_or_device_invalid')
            return fd
        except Exception:
            os.close(fd)
            raise
    finally:
        os.close(fd_dir)


def current_state(entry, parent_fd):
    row = entry['row']
    name = os.path.basename(row['path'])
    metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if metadata.st_dev != row['directories'][0][0] or metadata.st_uid != ROOT_UID or metadata.st_nlink != 1:
        raise RestoreError('current_asset_owner_links_or_device_invalid')
    if stat.S_ISLNK(metadata.st_mode):
        if os.readlink(name, dir_fd=parent_fd) != entry['canonical']:
            raise RestoreError('current_link_not_exact_canonical')
        return 'deduplicated', (ident(metadata), metadata.st_mtime_ns, metadata.st_ctime_ns)
    if stat.S_ISREG(metadata.st_mode):
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            digest, actual = hash_fd(fd)
            if digest != row['sha256'] or actual.st_size != row['metadata']['size']:
                raise RestoreError('current_regular_asset_content_differs')
        finally:
            os.close(fd)
        return 'already_regular', None
    raise RestoreError('current_asset_is_not_link_or_regular_file')


def ensure_inactive(release):
    snapshot = guard.probe_snapshot()
    if any(release in snapshot[k] for k in ('pinned', 'latest', 'symlink_referenced')):
        raise RestoreError('release_is_pinned_latest_or_dependency')
    if release in snapshot['nginx'] or any(guard.beneath(p, release) for k in ('online', 'port_referenced', 'processes') for p in snapshot[k]):
        raise RestoreError('release_is_referenced_by_running_service')
    paths = (release, release + '/public', release + '/public/downloads')
    if any(guard.beneath(mount, path) for mount in snapshot['mounts'] for path in paths):
        raise RestoreError('release_has_nested_mount')
    ids = guard.command(['docker', 'ps', '-q', '--no-trunc']).stdout.split()
    containers = json.loads(guard.command(['docker', 'inspect'] + ids).stdout) if ids else []
    if not isinstance(containers, list):
        raise RestoreError('docker_inventory_invalid')
    for container in containers:
        if not isinstance(container, dict) or not isinstance(container.get('Mounts'), list):
            raise RestoreError('docker_mount_inventory_invalid')
        for mount in container['Mounts']:
            if not isinstance(mount, dict):
                raise RestoreError('docker_mount_invalid')
            if mount.get('Type') != 'bind':
                continue
            source = mount.get('Source')
            if not isinstance(source, str) or not source.startswith('/'):
                raise RestoreError('docker_bind_source_invalid')
            for source_path in (os.path.normpath(source), os.path.realpath(source)):
                if guard.beneath(source_path, release) or guard.beneath(release, source_path):
                    raise RestoreError('release_is_docker_bind_referenced')
    return snapshot


def reserve_space(parent_fd, size, file_count=1):
    fs = os.fstatvfs(parent_fd)
    # Reserve data-block rounding for every temporary output, in addition to
    # the logical byte count and the required two GiB remaining free.
    allocation = ((size + fs.f_frsize - 1) // fs.f_frsize + file_count) * fs.f_frsize
    if fs.f_bavail * fs.f_frsize < allocation + RESERVE:
        raise RestoreError('insufficient_disk_for_copy_plus_two_gib_reserve')


def write_bytes(fd, data):
    while data:
        written = os.write(fd, data)
        if written <= 0:
            raise RestoreError('copy_write_failed')
        data = data[written:]


def copy_canonical(fd, temporary_fd, expected_digest, expected_size):
    before = os.fstat(fd)
    os.lseek(fd, 0, os.SEEK_SET)
    digest, copied = hashlib.sha256(), 0
    while True:
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            break
        copied += len(chunk)
        if copied > expected_size:
            raise RestoreError('canonical_exceeds_original_size')
        digest.update(chunk)
        write_bytes(temporary_fd, chunk)
    after = os.fstat(fd)
    if (ident(before), before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (ident(after), after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise RestoreError('canonical_changed_while_copying')
    if copied != expected_size or digest.hexdigest() != expected_digest:
        raise RestoreError('restored_copy_digest_or_size_mismatch')


def restore_entry(entry):
    row = entry['row']
    held = open_parents(row)
    canonical_fd, temporary_fd, temporary = None, None, None
    replaced = False
    try:
        parent_fd = held[-1]
        state, initial = current_state(entry, parent_fd)
        if state == 'already_regular':
            return False
        canonical_fd = open_canonical(entry)
        reserve_space(parent_fd, row['metadata']['size'])
        temporary = '.restore-' + os.urandom(12).hex()
        temporary_fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent_fd)
        copy_canonical(canonical_fd, temporary_fd, row['sha256'], row['metadata']['size'])
        os.fchown(temporary_fd, row['metadata']['uid'], row['metadata']['gid'])
        os.fchmod(temporary_fd, row['metadata']['mode'])
        os.utime(temporary_fd, ns=(row['metadata']['atime_ns'], row['metadata']['mtime_ns']))
        os.fsync(temporary_fd)
        ensure_inactive(row['root'])
        rechecked = open_parents(row)
        for fd in rechecked:
            os.close(fd)
        state, observed = current_state(entry, parent_fd)
        if state != 'deduplicated' or observed != initial:
            raise RestoreError('current_link_changed_before_replace')
        os.replace(temporary, os.path.basename(row['path']), src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        replaced = True
        temporary = None
        os.fsync(parent_fd)
        verified_fd = os.open(os.path.basename(row['path']), os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            digest, metadata = hash_fd(verified_fd)
            if (digest != row['sha256'] or metadata.st_size != row['metadata']['size']
                    or metadata.st_uid != row['metadata']['uid'] or metadata.st_gid != row['metadata']['gid']
                    or stat.S_IMODE(metadata.st_mode) != row['metadata']['mode']
                    or metadata.st_mtime_ns != row['metadata']['mtime_ns'] or metadata.st_nlink != 1):
                raise RestoreError('restored_asset_verification_failed')
            os.utime(verified_fd, ns=(row['metadata']['atime_ns'], row['metadata']['mtime_ns']))
            os.fsync(verified_fd)
        finally:
            os.close(verified_fd)
        return True
    except Exception as error:
        if replaced:
            raise ReplacedError(str(error) if isinstance(error, RestoreError) else 'required_filesystem_error_after_replace')
        raise
    finally:
        if temporary_fd is not None:
            os.close(temporary_fd)
        if temporary is not None:
            try:
                os.unlink(temporary, dir_fd=held[-1])
            except FileNotFoundError:
                pass
        if canonical_fd is not None:
            os.close(canonical_fd)
        for fd in held:
            os.close(fd)


def report(value):
    fd_dir = open_directory(OUT)
    temporary = '.restore-result-' + os.urandom(12).hex()
    try:
        if stat.S_IMODE(os.fstat(fd_dir).st_mode) != 0o700:
            raise RestoreError('result_directory_not_private')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd_dir)
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output, indent=2, sort_keys=True)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, RESULT_NAME, src_dir_fd=fd_dir, dst_dir_fd=fd_dir)
        os.fsync(fd_dir)
    finally:
        try:
            os.unlink(temporary, dir_fd=fd_dir)
        except FileNotFoundError:
            pass
        os.close(fd_dir)


def run(release, apply, max_gib):
    ensure_inactive(release)
    entries = read_manifest(release)
    if not entries:
        raise RestoreError('release_has_no_prepared_manifest_assets')
    selected, already_regular, bytes_required = [], 0, 0
    for entry in entries:
        held = open_parents(entry['row'])
        canonical_fd = None
        try:
            canonical_fd = open_canonical(entry)
            state, _ = current_state(entry, held[-1])
            if state == 'already_regular':
                already_regular += 1
            else:
                selected.append(entry)
                bytes_required += entry['row']['metadata']['size']
        finally:
            if canonical_fd is not None:
                os.close(canonical_fd)
            for fd in held:
                os.close(fd)
    if bytes_required > max_gib * GIB:
        raise RestoreError('selected_assets_exceed_eight_gib_restore_budget')
    if selected:
        held = open_parents(selected[0]['row'])
        try:
            reserve_space(held[-1], bytes_required, len(selected))
        finally:
            for fd in held:
                os.close(fd)
    result = {'status': 'dry_run', 'apply': apply, 'release': release,
              'selected_files': len(selected), 'already_regular_files': already_regular,
              'bytes_required': bytes_required, 'restored_files': 0, 'restored_bytes': 0,
              'reserve_bytes': RESERVE, 'manifest': MANIFEST, 'canonical_store': STORE,
              'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    if apply:
        try:
            for entry in selected:
                ensure_inactive(release)
                if restore_entry(entry):
                    result['restored_files'] += 1
                    result['restored_bytes'] += entry['row']['metadata']['size']
            result['status'] = 'completed'
        except Exception as error:
            result['unverified_replacements'] = int(isinstance(error, ReplacedError))
            result['status'] = 'partial' if result['restored_files'] or result['unverified_replacements'] else 'failed_closed'
            report(result)
            raise
    report(result)
    print(json.dumps(result, sort_keys=True))
    return result


def load_guard():
    parent_fd = open_directory(os.path.dirname(GUARD_SOURCE))
    try:
        m = os.stat(os.path.basename(GUARD_SOURCE), dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISREG(m.st_mode) or m.st_uid != ROOT_UID or m.st_mode & 0o022:
            raise RestoreError('owning_guard_source_invalid')
    finally:
        os.close(parent_fd)
    spec = importlib.util.spec_from_file_location('sanjie_retention_guard', GUARD_SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    global guard
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True, help='one exact /opt/sanjie-releases/<name> directory')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--max-gib', type=int, default=8, choices=range(1, 9))
    args = parser.parse_args()
    if os.geteuid() != ROOT_UID:
        parser.error('root is required for complete protective process inventory')
    if not valid_release(args.release):
        parser.error('--release must be one exact immediate release directory')
    os.umask(0o077)
    lock_fd, lock_directory = None, None
    try:
        guard = load_guard()
        lock_directory = open_directory(os.path.dirname(LOCK))
        lock_fd = os.open(os.path.basename(LOCK), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=lock_directory)
        metadata = os.fstat(lock_fd)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != ROOT_UID
                or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) != 0o600):
            raise RestoreError('global_retention_lock_invalid')
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        run(args.release, args.apply, args.max_gib)
        return 0
    except Exception as error:
        reason = str(error) if isinstance(error, (RestoreError, getattr(guard, 'GuardError', RestoreError))) else 'required_probe_or_filesystem_error'
        print(json.dumps({'status': 'failed_closed', 'apply': args.apply, 'reason': reason}, sort_keys=True))
        return 1
    finally:
        if lock_fd is not None:
            os.close(lock_fd)
        if lock_directory is not None:
            os.close(lock_directory)


if __name__ == '__main__':
    sys.exit(main())
