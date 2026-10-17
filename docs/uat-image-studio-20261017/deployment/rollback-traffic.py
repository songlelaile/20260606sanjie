import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path('/opt/sanjie-releases/20261017-image-studio-optimize-v1')
CONF = Path('/etc/nginx/conf.d/sanjie.conf')
digest = lambda value: hashlib.sha256(value).hexdigest()

with open('/var/lock/sanjie-site-deploy.lock', 'a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    receipt = ROOT / 'image-studio-release.json'
    d = json.loads(receipt.read_text())
    assert d['trafficSwitched'] is True
    assert CONF.is_file() and not CONF.is_symlink()
    current = CONF.read_bytes()
    assert digest(current) == d['nginxAfterSha256'], 'Preserve any later deployment configuration'
    old = (ROOT / 'nginx-before.conf').read_bytes()
    assert digest(old) == d['nginxSha256']
    process = next(p for p in json.loads(subprocess.check_output(['pm2', 'jlist'], text=True))
                   if p['pm_id'] == d['oldPmId'])
    assert process['pm2_env']['status'] == 'online' and process['pm2_env']['pm_cwd'] == d['oldRoot']
    stat = CONF.stat()

    def write(data):
        pending = CONF.with_name('.sanjie-image-studio-rollback-20261017.pending')
        with pending.open('wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(pending, stat.st_mode & 0o777)
        os.chown(pending, stat.st_uid, stat.st_gid)
        pending.replace(CONF)

    try:
        write(old)
        subprocess.run(['nginx', '-t'], check=True)
        subprocess.run(['nginx', '-s', 'reload'], check=True)
    except Exception:
        assert digest(CONF.read_bytes()) == digest(old)
        write(current)
        subprocess.run(['nginx', '-t'], check=True)
        subprocess.run(['nginx', '-s', 'reload'], check=True)
        raise
    d.update({'trafficSwitched': False, 'rollbackAt': time.time()})
    receipt.write_text(json.dumps(d, indent=2))
    print('ROLLED_BACK_TO_PRESERVED_RELEASE')
