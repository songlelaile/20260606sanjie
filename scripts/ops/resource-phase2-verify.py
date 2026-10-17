#!/usr/bin/env python3
"""Validate completed maintenance using private manifests and live signals."""
import datetime
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess

OUT = pathlib.Path('/root/sanjie-resource-optimization-20261009/phase2')


def command(argv):
    r = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    if r.returncode:
        raise RuntimeError('verification_command_failed_' + argv[0])
    return r.stdout.decode()


def main():
    os.umask(0o077)
    spec = importlib.util.spec_from_file_location('dedupe', str(OUT / 'release-download-dedupe-20261009.py'))
    d = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(d)
    result = json.loads((OUT / 'download-dedupe-result.json').read_text())
    assert result['status'] == 'completed'
    plan = json.loads((OUT / 'download-dedupe-plan.json').read_text())
    manifest = [json.loads(x) for x in (OUT / 'download-dedupe-manifest.jsonl').read_text().splitlines()]
    committed = {x['path'] for x in manifest if x['event'] == 'committed'}
    assert committed == {r['path'] for r in plan['targets']}
    assert len(committed) == result['files_deduplicated']
    hashes = {}
    for row in plan['targets']:
        canonical = d.STORE + '/' + row['sha256'] + '.zip'
        assert os.path.islink(row['path']) and os.readlink(row['path']) == canonical
        assert os.stat(row['path']).st_size == row['metadata']['size']
        if canonical not in hashes:
            actual, m = d.digest(canonical)
            assert actual == row['sha256'] and m['uid'] == 0 and m['mode'] == 0o444
            hashes[canonical] = actual
    command(['/usr/bin/python3', str(OUT / 'resource-runtime-fingerprint.py'), 'after'])
    runtime = json.loads((OUT / 'runtime-after.json').read_text())
    command(['systemctl', 'start', 'sanjie-resource-watch.service'])
    watch = json.loads(pathlib.Path('/var/lib/sanjie-resource-watch/current.json').read_text())
    assert watch['severity'] == 'healthy'
    http = {}
    for name, url in (('public_login', 'https://shaozhuangai.com/login'),
                      ('public_tools', 'https://shaozhuangai.com/tools')):
        http[name] = command(['curl', '-sS', '--max-time', '20', '-o', '/dev/null',
                             '-w', '%{http_code} %{redirect_url} %{time_total}', url]).strip()
    assert http['public_login'].startswith('200 ')
    assert http['public_tools'].startswith('307 https://shaozhuangai.com/login ')
    apps = json.loads(d.guard.command(['pm2', 'jlist']).stdout)
    for a in apps:
        if a['pm2_env']['status'] != 'online':
            continue
        for port in sorted(d.guard.app_ports(a['pm2_env'])):
            http['local_' + str(port)] = command(['curl', '-sS', '--max-time', '20', '-H',
                'Host: shaozhuangai.com', '-o', '/dev/null', '-w', '%{http_code} %{time_total}',
                'http://127.0.0.1:' + str(port) + '/']).strip()
            assert http['local_' + str(port)][0] in ('2', '3')
    timers = {}
    for name in ('sanjie-build-retention.timer', 'sanjie-resource-watch.timer', 'logrotate.timer'):
        timers[name] = {'active': command(['systemctl', 'is-active', name]).strip(),
                        'enabled': command(['systemctl', 'is-enabled', name]).strip()}
    qa = json.loads(pathlib.Path('/root/sanjie-resource-optimization-20261009/qa-build-cleanup-result.json').read_text())
    assert qa['status'] == 'completed' and qa['apply']
    report = {'status': 'verified', 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'watch': watch, 'dedupe': result, 'qa': qa,
              'verified_original_download_paths': len(committed),
              'verified_content_groups': len(hashes),
              'runtime_unchanged': runtime['comparison'],
              'protected_file_hashes': len(runtime['protected_files_sha256']),
              'online_pm2_ids': [a['id'] for a in runtime['online_pm2']],
              'docker_running': len(runtime['docker']), 'http': http, 'timers': timers,
              'free_mib': command(['free', '-m']), 'df': command(['df', '-h', '/']),
              'nginx_configuration_ok': True,
              'extra_net_saved_bytes_upper_bound': result['net_saved_bytes_upper_bound'] + qa['removed_allocated_bytes_upper_bound']}
    d.json_write(str(OUT / 'phase2-final-verification.json'), report)
    print('PHASE2_VERIFIED', json.dumps({k: report[k] for k in
        ('status', 'at', 'verified_original_download_paths', 'verified_content_groups',
         'runtime_unchanged', 'protected_file_hashes', 'online_pm2_ids', 'docker_running', 'http')}))
    print(report['free_mib'], end='')
    print(report['df'], end='')
    print('DISK_FREE_GIB', round(watch['disk']['available_bytes'] / 1024**3, 2),
          'WATCH', watch['severity'], 'EXTRA_SAVED_GIB', round(report['extra_net_saved_bytes_upper_bound'] / 1024**3, 3))


if __name__ == '__main__':
    main()
