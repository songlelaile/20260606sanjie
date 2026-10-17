"""Apply only reviewed video public-asset edits to the verified running release.

No process restart, Nginx change, configuration read or database mutation.
The supplied manifest contains line edits and SHA-256 values, never credentials.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path('/opt/sanjie-releases/20261018-image-studio-online-uat-v3')
BACKUP = Path('/opt/sanjie-private/video-retry-visibility-20261018-r2')
NGINX_HASH = '4cc1d5a6eebb3b93751773bb27ec742fb34691358a0dde24ea72ca9e9b5460e6'
FILES = ['public/creative/labs/ecommerce-video-studio/video-studio.js', 'public/creative/labs/ecommerce-video-studio/video-studio.html']

def sha(data):
    return hashlib.sha256(data).hexdigest()

def processes():
    rows = json.loads(subprocess.check_output(['pm2', 'jlist']))
    return {str(p['pm_id']): {'pid': p.get('pid'), 'status': p['pm2_env'].get('status'),
                            'cwd': p['pm2_env'].get('pm_cwd')}
            for p in rows if p.get('pm_id') in [50, 88, 89, 90, 91, 92]}

def http_status(route):
    return int(subprocess.check_output([
        'curl', '--noproxy', '*', '--resolve', 'www.shaozhuangai.com:443:127.0.0.1',
        '--max-time', '10', '--silent', '--show-error', '-o', '/dev/null', '-w', '%{http_code}',
        'https://www.shaozhuangai.com' + route,
    ]))

def apply(manifest):
    assert [row['path'] for row in manifest['files']] == FILES
    assert sha(Path('/etc/nginx/conf.d/sanjie.conf').read_bytes()) == NGINX_HASH, 'Routing changed; revalidate before applying'
    assert sha((ROOT / 'public/creative/src/ecommerce-video-background.js').read_bytes()) == '19ae4667c05d487b2f8431185ee51888e7c78ce6fa4c0e039986444ee8639971', 'Video background changed; revalidate pricing before applying'
    baseline = processes()
    assert baseline['92']['cwd'] == str(ROOT) and baseline['92']['status'] == 'online'
    routes = {'/login': 200, '/api/creative/proxy': 405,
              '/api/creative/assets/src/ecommerce-video-background.js': 401}
    assert {r: http_status(r) for r in routes} == routes
    prepared = []
    for row in manifest['files']:
        target = ROOT / row['path']
        before = target.read_bytes()
        assert sha(before) == row['before'], 'Source changed: ' + row['path']
        lines = before.decode('utf-8').splitlines(keepends=True)
        for start, stop, replacement in reversed(row['edits']):
            lines[start:stop] = replacement.splitlines(keepends=True)
        after = ''.join(lines).encode('utf-8')
        assert sha(after) == row['after'], 'Patch hash mismatch: ' + row['path']
        prepared.append((row, target, before, after, target.stat()))
    BACKUP.mkdir(mode=0o700)
    changed = []
    try:
        for row, target, before, after, stat in prepared:
            saved = BACKUP / row['path']
            saved.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            saved.write_bytes(before)
            saved.chmod(0o600)
            staged = target.with_name(target.name + '.video-retry-visibility-r2.js')
            with staged.open('xb') as handle:
                handle.write(after)
                handle.flush()
                os.fsync(handle.fileno())
            staged.chmod(stat.st_mode & 0o777)
            os.chown(staged, stat.st_uid, stat.st_gid)
            if target.suffix == '.js':
                subprocess.run(['node', '--check', str(staged)], check=True, capture_output=True)
            assert sha(target.read_bytes()) == row['before'], 'Concurrent change: ' + row['path']
            os.replace(staged, target)
            changed.append((target, before))
        assert processes() == baseline, 'Process state changed'
        assert sha(Path('/etc/nginx/conf.d/sanjie.conf').read_bytes()) == NGINX_HASH
        assert {r: http_status(r) for r in routes} == routes
        receipt = {'appliedAt': time.time(), 'root': str(ROOT), 'backup': str(BACKUP),
                   'files': [{'path': r['path'], 'before': r['before'], 'after': r['after']} for r in manifest['files']],
                   'nginxHashUnchanged': NGINX_HASH, 'processesUnchanged': baseline,
                   'readOnlyHttpStatus': routes, 'processRestarted': False,
                   'databaseOrProviderConfigurationChanged': False}
        (BACKUP / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print('VIDEO_RETRY_VISIBILITY_R2_RECEIPT=' + json.dumps(receipt, separators=(',', ':')))
    except BaseException:
        for target, before in reversed(changed):
            target.write_bytes(before)
        raise

if __name__ == '__main__':
    with open('/var/lock/sanjie-video-http400-repair.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        apply(json.loads(sys.stdin.read()))
