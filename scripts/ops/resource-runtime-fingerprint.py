#!/usr/bin/env python3
"""Private, sanitized before/after fingerprint; no secrets or writes to apps."""
import datetime
import glob
import hashlib
import json
import os
import pathlib
import stat
import subprocess
import sys

OUT = pathlib.Path('/root/sanjie-resource-optimization-20261009/phase2')


def cmd(argv):
    r = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    if r.returncode:
        raise RuntimeError('required_probe_failed_' + argv[0])
    return r.stdout


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def capture():
    apps = json.loads(cmd(['pm2', 'jlist']))
    online = sorted([{'id': a['pm_id'], 'pid': a['pid'], 'name': a['name'],
                      'cwd': a['pm2_env']['pm_cwd'],
                      'restarts': a['pm2_env'].get('restart_time'),
                      'started': a['pm2_env'].get('pm_uptime')}
                     for a in apps if a['pm2_env']['status'] == 'online'], key=lambda a: a['id'])
    ids = cmd(['docker', 'ps', '-q', '--no-trunc']).decode().split()
    containers = json.loads(cmd(['docker', 'inspect'] + ids)) if ids else []
    docker = sorted([{'id': c['Id'], 'name': c['Name'], 'started': c['State']['StartedAt'],
                      'restarts': c['RestartCount'], 'running': c['State']['Running']}
                     for c in containers], key=lambda c: c['id'])
    nginx = cmd(['nginx', '-T'])
    roots = {a['cwd'] for a in online}
    roots.update(line.strip() for line in pathlib.Path('/etc/sanjie-resource-watch/pinned-releases.txt').read_text().splitlines()
                 if line.strip() and not line.startswith('#'))
    files, links = {}, {}
    for root in sorted(roots):
        for relative in ('.next/BUILD_ID', 'package.json', 'ecosystem.config.js'):
            path = root + '/' + relative
            if os.path.isfile(path):
                files[path] = digest(path)
        for path in sorted(glob.glob(root + '/public/downloads/*')):
            if os.path.isfile(path):
                files[path] = digest(path)
        for parent, dirs, names in os.walk(root, followlinks=False):
            # Inspect application links without hashing dependencies or data.
            for name in dirs + names:
                path = parent + '/' + name
                if os.path.islink(path):
                    target = os.path.realpath(path)
                    links[path] = {'target': target, 'exists': os.path.exists(path)}
            dirs[:] = [d for d in dirs if d not in ('node_modules', '.git', '.next') and not os.path.islink(parent + '/' + d)]
    return {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'online_pm2': online, 'docker': docker,
            'nginx_sha256': hashlib.sha256(nginx).hexdigest(),
            'protected_files_sha256': files, 'protected_links': links}


def main():
    os.umask(0o077)
    mode = sys.argv[1]
    assert mode in ('before', 'after')
    OUT.mkdir(mode=0o700, exist_ok=True)
    result = capture()
    if mode == 'after':
        before = json.loads((OUT / 'runtime-before.json').read_text())
        result['comparison'] = {k: before[k] == result[k] for k in
                                ('online_pm2', 'docker', 'nginx_sha256', 'protected_files_sha256', 'protected_links')}
    (OUT / ('runtime-' + mode + '.json')).write_text(json.dumps(result, indent=2))
    print('FINGERPRINT', mode, 'online_pm2', len(result['online_pm2']), 'docker', len(result['docker']),
          'protected_file_hashes', len(result['protected_files_sha256']), 'symlinks', len(result['protected_links']))
    if mode == 'after':
        print('UNCHANGED', json.dumps(result['comparison'], sort_keys=True))
        if not all(result['comparison'].values()):
            sys.exit(1)


if __name__ == '__main__':
    main()
