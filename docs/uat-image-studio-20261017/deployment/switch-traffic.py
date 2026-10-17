import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

ROOT = Path('/opt/sanjie-releases/20261017-image-studio-optimize-v1')
RECEIPT = ROOT / 'image-studio-release.json'
CONF = Path('/etc/nginx/conf.d/sanjie.conf')

def digest(data):
    return hashlib.sha256(data).hexdigest()

def atomic_write(data, stat):
    pending = CONF.with_name('.sanjie-image-studio-20261017.pending')
    with pending.open('wb') as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    os.chmod(pending, stat.st_mode & 0o777)
    os.chown(pending, stat.st_uid, stat.st_gid)
    pending.replace(CONF)

def curl(path):
    return subprocess.check_output([
        'curl', '--noproxy', '*', '--resolve', 'www.shaozhuangai.com:443:127.0.0.1',
        '--max-time', '8', '--fail', '--silent', '--show-error',
        'https://www.shaozhuangai.com' + path
    ])

with open('/var/lock/sanjie-site-deploy.lock', 'a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    d = json.loads(RECEIPT.read_text())
    assert d['trafficSwitched'] is False
    assert d['candidatePort'] == 53450 and d.get('canaryReadyAt')
    assert d['runtimeIdentityAndProviderConfigParity'] is True
    assert Path('/tmp/sanjie-image-production-build-release-20261017.status').read_text().strip() == '0'
    assert json.loads((ROOT / 'production-test-comparison.json').read_text())['newFailures'] == []
    for name, record in d['assetHashes'].items():
        expected = record if isinstance(record, str) else record['sha256']
        assert digest((ROOT / name).read_bytes()) == expected, name
    for name, record in d['protected'].items():
        p = ROOT / name
        assert digest(p.read_bytes()) == record['sha256'], name
        assert (str(p.readlink()) if p.is_symlink() else None) == record['link'], name
    processes = json.loads(subprocess.check_output(['pm2', 'jlist'], text=True))
    for pm_id, pid, cwd in [(d['oldPmId'], d['oldPid'], d['oldRoot']),
                            (d['candidatePmId'], d['candidatePid'], str(ROOT))]:
        proc = next(p for p in processes if p['pm_id'] == pm_id)
        assert proc['pid'] == pid and proc['pm2_env']['status'] == 'online'
        assert proc['pm2_env']['pm_cwd'] == cwd
    gate = next(p for p in processes if p['pm_id'] == 89)
    assert gate['pm2_env']['status'] == 'online'
    assert gate['pm2_env']['pm_cwd'] == '/opt/sanjie-platform-modules-pause-20261016-tools-r1'
    assert gate['pid'] == d['pauseGateBaseline']['pid']
    for name, expected in d['pauseGateBaseline']['fileHashes'].items():
        assert digest((Path(d['pauseGateBaseline']['root']) / name).read_bytes()) == expected, name
    assert CONF.is_file() and not CONF.is_symlink()
    old = CONF.read_bytes()
    assert digest(old) == d['nginxSha256'], 'Nginx changed since baseline; do not overwrite it'
    stat = CONF.stat()
    text = old.decode()
    pattern = r'map\s+\$cookie_sanjie_creative_uat\s+\$sanjie_app_port\s*\{[^}]+\}'
    blocks = list(re.finditer(pattern, text))
    assert len(blocks) == 1
    block = blocks[0].group(0)
    changed, count = re.subn(r'\bdefault\s+53448\s*;', 'default 53450;', block)
    assert count == 1
    assert '$sanjie_pause_upstream_port' not in text
    pause_map = '\n\nmap $sanjie_app_port $sanjie_pause_upstream_port {\n    default $sanjie_app_port;\n    53450 53448;\n}'
    text = text[:blocks[0].start()] + changed + pause_map + text[blocks[0].end():]
    text, count = re.subn(r'(proxy_set_header\s+X-Sanjie-Pause-Upstream-Port\s+)\$sanjie_app_port(\s*;)',
                         r'\1$sanjie_pause_upstream_port\2', text)
    assert count == 4
    new = text.encode()
    (ROOT / 'nginx-before.conf').write_bytes(old)
    (ROOT / 'nginx-after.conf').write_bytes(new)
    try:
        assert digest(CONF.read_bytes()) == d['nginxSha256']
        atomic_write(new, stat)
        subprocess.run(['nginx', '-t'], check=True)
        subprocess.run(['nginx', '-s', 'reload'], check=True)
        # This immutable URL exists only in this exact candidate build.
        for attempt in range(8):
            try:
                manifest = curl('/_next/static/' + d['candidateBuildId'] + '/_buildManifest.js')
                assert b'__BUILD_MANIFEST' in manifest
                break
            except (subprocess.CalledProcessError, AssertionError):
                if attempt == 7:
                    raise
                time.sleep(1)
        login = curl('/login')
        assert b'<html' in login
        assert digest(CONF.read_bytes()) == digest(new)
    except Exception:
        assert digest(CONF.read_bytes()) == digest(new), 'Concurrent Nginx change; preserve it for manual review'
        atomic_write(old, stat)
        subprocess.run(['nginx', '-t'], check=True)
        subprocess.run(['nginx', '-s', 'reload'], check=True)
        d['trafficSwitched'] = False
        d['rollbackAt'] = time.time()
        RECEIPT.write_text(json.dumps(d, indent=2))
        raise
    d.update({'trafficSwitched': True, 'trafficSwitchedAt': time.time(),
              'nginxAfterSha256': digest(new), 'publicBuildManifestSha256': digest(manifest),
              'pauseGatePmId': gate['pm_id'], 'pauseGatePid': gate['pid'],
              'proxyBackendPortPreserved': 53448, 'pauseGatePortPreserved': 53449,
              'uatPortPreserved': 44119, 'databaseMigrationsRun': False,
              'seedOrResetRun': False})
    RECEIPT.write_text(json.dumps(d, indent=2))
    with open('/tmp/sanjie-image-pm2-save-20261017.log', 'w') as output:
        subprocess.run(['pm2', 'save'], stdout=output, stderr=subprocess.STDOUT, check=True)
    print('TRAFFIC_SWITCHED', json.dumps({k: d[k] for k in [
        'sourceCommit', 'candidatePort', 'candidateBuildId', 'nginxAfterSha256',
        'proxyBackendPortPreserved', 'pauseGatePortPreserved', 'uatPortPreserved']}))
