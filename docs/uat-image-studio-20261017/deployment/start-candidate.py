import hashlib
import json
import os
from pathlib import Path
import resource
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path('/opt/sanjie-releases/20261017-image-studio-optimize-v1')
RECEIPT = ROOT / 'image-studio-release.json'
NAME = 'sanjie-image-studio-optimize-20261017-v1'
PORT = 53450
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
d = json.loads(RECEIPT.read_text())
old_root = Path(d['oldRoot'])
assert Path('/tmp/sanjie-image-production-build-release-20261017.status').read_text().strip() == '0'
assert Path('/tmp/sanjie-image-production-final-lint-20261017.status').read_text().strip() == '0'
assert Path('/tmp/sanjie-image-production-final-typecheck-20261017.status').read_text().strip() == '0'
assert json.loads((ROOT / 'production-test-comparison.json').read_text())['newFailures'] == []
assert not json.loads((ROOT / 'source-parity-review.json').read_text())['unexpected']
assert (ROOT / '.next/static').resolve().is_relative_to(ROOT.resolve())
assert (ROOT / '.next/static').resolve() != (old_root / '.next/static').resolve()

# Keep only the immutable public assets required by already-open old clients.
copied = 0
preserved = 0
for source in (old_root / '.next/static').rglob('*'):
    if not source.is_file():
        continue
    target = ROOT / '.next/static' / source.relative_to(old_root / '.next/static')
    if target.exists():
        assert hashlib.sha256(source.read_bytes()).digest() == hashlib.sha256(target.read_bytes()).digest(), str(target)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        copied += 1
    preserved += 1

processes = json.loads(subprocess.check_output(['pm2', 'jlist'], text=True))
old = next(p for p in processes if p['pm_id'] == d['oldPmId'])
assert old['pid'] == d['oldPid'] and old['pm2_env']['pm_cwd'] == str(old_root)
assert old['pm2_env']['status'] == 'online'
existing = [p for p in processes if p['name'] == NAME]
assert len(existing) <= 1
if existing:
    current = existing[0]
    assert current['pm2_env']['pm_cwd'] == str(ROOT)
    assert current['pm2_env']['pm_exec_path'] == str(ROOT / 'node_modules/next/dist/bin/next')
    assert current['pm2_env']['args'] == ['start', '-H', '127.0.0.1', '-p', str(PORT)]
    assert current['pm2_env']['status'] == 'online'
else:
    sock = socket.socket()
    try:
        assert sock.connect_ex(('127.0.0.1', PORT)) != 0
    finally:
        sock.close()

# Preserve the actual old process startup environment, without importing any
# shell-only application variables. Values remain in memory and are never logged.
def process_env(pid):
    entries = Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
    internal = {'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_UNIQUE_ID', 'PM2_USAGE'}
    return {key.decode(): value.decode() for entry in entries if b'=' in entry
            for key, value in [entry.split(b'=', 1)]
            if key.decode().isupper() and key.decode() not in internal}

old_env = process_env(old['pid'])
env = old_env.copy()
env.update({'NODE_ENV': 'production', 'PORT': str(PORT), 'PWD': str(ROOT)})
env_names = ['.env.production.local', '.env.local', '.env.production', '.env']
for name in env_names:
    original, target = old_root / name, ROOT / name
    assert original.exists() == target.exists(), name
    if original.exists():
        assert hashlib.sha256(original.read_bytes()).digest() == hashlib.sha256(target.read_bytes()).digest(), name

config_probe = r'''
const root=process.argv[1];
require(root+'/node_modules/@next/env').loadEnvConfig(root,false,{info(){},warn(){},error(){}});
const crypto=require('node:crypto');
const names=Object.keys(process.env).filter(k=>/DATABASE|SESSION|COOKIE|STORAGE|BLOB|REDIS|PUBLIC_APP_ORIGIN|OPENAI|DOUBAO|VOLC|CREATIVE|MODEL_GATEWAY/.test(k)).sort();
if(!process.env.SESSION_SECRET||process.env.SESSION_SECRET.length<32||!process.env.DATABASE_URL)process.exit(2);
process.stdout.write(JSON.stringify(Object.fromEntries(names.map(k=>[k,crypto.createHash('sha256').update(process.env[k]).digest('hex')]))));
'''
def config_hashes(root, environment):
    return json.loads(subprocess.check_output(['/usr/bin/node-22', '-e', config_probe, str(root)],
                                             cwd=root, env=environment, text=True))

old_config = config_hashes(old_root, old_env)
assert old_config == config_hashes(ROOT, env), 'Runtime identity/config mismatch before start'
if not existing:
    with open('/tmp/sanjie-image-candidate-pm2-start-20261017.log', 'w') as log:
        subprocess.run(['pm2', 'start', str(ROOT / 'node_modules/next/dist/bin/next'),
                        '--name', NAME, '--interpreter', '/usr/bin/node-22', '--cwd', str(ROOT),
                        '--', 'start', '-H', '127.0.0.1', '-p', str(PORT)],
                       env=env, stdout=log, stderr=subprocess.STDOUT, check=True)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect)
redirects = {}

def status(path):
    req = urllib.request.Request(f'http://127.0.0.1:{PORT}{path}',
                                 headers={'Host': 'www.shaozhuangai.com', 'X-Forwarded-Proto': 'https'})
    try:
        with opener.open(req, timeout=4) as response:
            response.read()
            return response.status
    except urllib.error.HTTPError as error:
        if error.code in [302, 303, 307, 308]:
            location = urllib.parse.urlparse(error.headers.get('location', ''))
            assert location.netloc in ['', 'shaozhuangai.com', 'www.shaozhuangai.com']
            assert location.path == '/login'
            redirects[path] = {'host': location.netloc, 'path': location.path}
        return error.code

for attempt in range(20):
    try:
        if status('/login') == 200:
            break
    except (OSError, TimeoutError):
        pass
    time.sleep(1)
else:
    raise RuntimeError('Candidate login failed readiness')
results = {path: status(path) for path in [
    '/login', '/api/auth/me', '/creative/labs/image-prompt-lab/promptlab.html?source=web&studio=1',
    '/api/creative/assets/web-chrome.js', '/api/creative/assets/labs/image-prompt-lab/studio-entry.js',
    '/api/creative/assets/labs/image-prompt-lab/studio-entry.css']}
assert results['/login'] == 200
assert all(code in [401, 403] for path, code in results.items() if path.startswith('/api/')), results
assert results['/creative/labs/image-prompt-lab/promptlab.html?source=web&studio=1'] == 307
new = next(p for p in json.loads(subprocess.check_output(['pm2', 'jlist'], text=True)) if p['name'] == NAME)
assert old_config == config_hashes(ROOT, process_env(new['pid'])), 'Runtime identity/config mismatch after start'
d.update({'sourceCommit': '00d029668dc4beba9037715fb401213383acd9c8',
          'candidatePmId': new['pm_id'], 'candidatePid': new['pid'], 'candidateName': NAME,
          'candidatePort': PORT, 'candidateBuildId': (ROOT / '.next/BUILD_ID').read_text().strip(),
          'oldClientStaticFilesPreserved': preserved, 'oldClientStaticFilesCopiedThisAttempt': copied,
          'canaryReadOnlyStatus': results,
          'canaryReadOnlyRedirects': redirects,
          'canaryReadyAt': time.time(), 'trafficSwitched': False,
          'runtimeIdentityAndProviderConfigParity': True, 'runtimeConfigKeysCompared': len(old_config)})
RECEIPT.write_text(json.dumps(d, indent=2))
print('CANARY_READY', json.dumps({k: d[k] for k in ['candidatePmId', 'candidatePid', 'candidatePort',
                                                  'candidateBuildId', 'oldClientStaticFilesPreserved']}))
