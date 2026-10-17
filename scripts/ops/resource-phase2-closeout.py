#!/usr/bin/env python3
"""Complete the one-time maintenance after a fail-closed restore-path repair."""
import datetime
import hashlib
import json
import os
import pathlib
import subprocess

OUT = pathlib.Path('/root/sanjie-resource-optimization-20261009/phase2')
STATE = pathlib.Path('/var/lib/sanjie-resource-watch')
RESTORE = STATE / 'download-restore-20261009'


def read(path):
    return json.loads(path.read_text())


def command(argv):
    result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    if result.returncode:
        raise RuntimeError('closeout_command_failed_' + argv[0])
    return result.stdout.decode().strip()


def main():
    os.umask(0o077)
    verified = read(OUT / 'phase2-final-verification.json')
    assert verified['status'] == 'verified' and all(verified['runtime_unchanged'].values())
    assert verified['verified_original_download_paths'] == 1252
    assert verified['verified_content_groups'] == 24
    assert verified['dedupe']['status'] == 'completed'
    assert verified['qa']['status'] == 'completed' and verified['qa']['apply']
    assert verified['qa']['counts'] == {'removed': 3}
    restored = read(RESTORE / 'download-restore-result.json')
    assert restored['status'] == 'dry_run' and not restored['apply']
    assert restored['selected_files'] > 0 and restored['restored_files'] == 0
    copy = read(RESTORE / 'manifest-copy-verification.json')
    for path in (OUT / 'download-dedupe-manifest.jsonl', RESTORE / 'download-dedupe-manifest.jsonl'):
        assert hashlib.sha256(path.read_bytes()).hexdigest() == copy['sha256']
    retention_path = STATE / 'build-retention-result.json'
    before_retention = retention_path.stat()
    before_identity = (before_retention.st_dev, before_retention.st_ino,
                       before_retention.st_mtime_ns, before_retention.st_ctime_ns)
    command(['systemctl', 'start', 'sanjie-build-retention.service'])
    after_retention = retention_path.stat()
    after_identity = (after_retention.st_dev, after_retention.st_ino,
                      after_retention.st_mtime_ns, after_retention.st_ctime_ns)
    assert after_identity != before_identity, 'retention_did_not_write_a_fresh_result'
    retention = read(retention_path)
    assert retention['status'] == 'completed' and retention['apply']
    assert retention['planned_targets'] == 0 and retention['removed_bytes'] == 0
    command(['systemctl', 'start', 'sanjie-resource-watch.service'])
    watch = read(STATE / 'current.json')
    assert watch['severity'] == 'healthy'
    timers = {}
    for name in ('sanjie-build-retention.timer', 'sanjie-resource-watch.timer', 'logrotate.timer'):
        timers[name] = {'active': command(['systemctl', 'is-active', name]),
                        'enabled': command(['systemctl', 'is-enabled', name])}
        assert timers[name] == {'active': 'active', 'enabled': 'enabled'}
    http = {}
    for route in ('login', 'tools'):
        http[route] = command(['curl', '-sS', '--max-time', '20', '-o', '/dev/null',
                               '-w', '%{http_code} %{redirect_url} %{time_total}',
                               'https://shaozhuangai.com/' + route])
    assert http['login'].startswith('200 ')
    assert http['tools'].startswith('307 https://shaozhuangai.com/login ')
    receipt = {'status': 'completed', 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'verification': True, 'qa_dry_run_and_apply': True, 'server_restore_dry_run': True,
               'restore_selected_files': restored['selected_files'],
               'restore_manifest_sha256': copy['sha256'], 'restore_record_directory': str(RESTORE),
               'initial_followup_exit': 1, 'resolved_failure': 'strict_restore_rejected_non_root_owned_root_ancestor',
               'repair': 'checksum_verified_manifest_copy_in_root_owned_private_var_lib_directory',
               'original_audit_preserved': True, 'root_directory_unchanged': True,
               'daily_retention_actual_run': retention, 'daily_retention_result_fresh': True,
               'watch': watch, 'timers': timers,
               'http': http, 'free_mib': command(['free', '-m']), 'df': command(['df', '-h', '/']),
               'extra_saved_bytes_upper_bound': verified['extra_net_saved_bytes_upper_bound']}
    target = OUT / 'phase2-finish-result.json'
    temporary = OUT / ('.closeout-' + os.urandom(8).hex())
    with temporary.open('x') as output:
        json.dump(receipt, output, indent=2)
        output.flush()
        os.fsync(output.fileno())
    os.replace(str(temporary), str(target))
    fd = os.open(str(OUT), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    os.fsync(fd)
    os.close(fd)
    print('ALL_PHASE2_WORK_COMPLETE', receipt['at'])
    print('DOWNLOAD_PATHS_VERIFIED', 1252, 'CONTENT_GROUPS', 24,
          'PROTECTED_FILES', verified['protected_file_hashes'], 'RUNTIME_UNCHANGED', True)
    print('RESTORE_DRY_RUN', restored['selected_files'], 'files', 'ACTUAL_DAILY_TARGETS', 0)
    print('HTTP', http)
    print(receipt['free_mib'])
    print(receipt['df'])
    print('DISK_FREE_GIB', round(watch['disk']['available_bytes'] / 1024**3, 2),
          'DISK_USE_PERCENT', watch['disk']['use_percent'], 'WATCH', watch['severity'])


if __name__ == '__main__':
    main()
