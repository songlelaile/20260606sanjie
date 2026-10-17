import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path('/opt/sanjie-releases/20261017-image-studio-optimize-v1')
d = json.loads((ROOT / 'image-studio-release.json').read_text())
assert d['trafficSwitched'] is True
assert hashlib.sha256(Path('/etc/nginx/conf.d/sanjie.conf').read_bytes()).hexdigest() == d['nginxAfterSha256']

def get(path, headers=()):
    with tempfile.TemporaryDirectory(prefix='sanjie-postdeploy-read-') as temporary:
        response = Path(temporary) / 'body'
        command = ['curl', '--noproxy', '*', '--resolve', 'www.shaozhuangai.com:443:127.0.0.1',
                   '--max-time', '10', '--silent', '--show-error', '-o', str(response), '-w', '%{http_code}']
        for header in headers:
            command += ['-H', header]
        status = int(subprocess.check_output(command + ['https://www.shaozhuangai.com' + path], text=True))
        return status, response.read_bytes()

baseline = json.loads((ROOT / 'precutover-smoke.json').read_text())
after = {path: get(path)[0] for path in baseline}
assert after == baseline, after
anonymous = {}
for path in ['/api/creative/assets/web-chrome.js',
             '/api/creative/assets/labs/image-prompt-lab/studio-entry.js',
             '/api/creative/assets/labs/image-prompt-lab/studio-entry.css']:
    status, _ = get(path, ['If-None-Match: "codex-anonymous-probe"'])
    assert status == 401
    anonymous[path] = status

processes = json.loads(subprocess.check_output(['pm2', 'jlist'], text=True))
uat = next(p for p in processes if p['pm_id'] == 50)
assert uat['pm2_env']['pm_cwd'] == '/opt/sanjie-releases/credit-pool-shared-wallet-20261009-v1'
uat_build = (Path(uat['pm2_env']['pm_cwd']) / '.next/BUILD_ID').read_text().strip()
main_status, main_html = get('/login')
uat_status, uat_html = get('/login', ['Cookie: sanjie_creative_uat=20261001'])
assert main_status == uat_status == 200
assert d['candidateBuildId'].encode() in main_html
assert uat_build.encode() in uat_html
assert d['candidateBuildId'].encode() not in uat_html

gate = next(p for p in processes if p['pm_id'] == d['pauseGatePmId'])
assert gate['pid'] == d['pauseGateBaseline']['pid']
for name, expected in d['pauseGateBaseline']['fileHashes'].items():
    assert hashlib.sha256((Path(d['pauseGateBaseline']['root']) / name).read_bytes()).hexdigest() == expected
assert all(next(p for p in processes if p['pm_id'] == key)['pm2_env']['status'] == 'online'
           for key in [d['oldPmId'], d['candidatePmId'], d['pauseGatePmId'], 50])

result = {'checkedAt': time.time(), 'anonymousHttpStatus': after,
          'anonymousConditionalAssetStatus': anonymous,
          'defaultDynamicLoginBuildMatchesCandidate': True,
          'uatDynamicLoginBuildMatchesExistingUat': True,
          'uatBuildId': uat_build, 'gateProcessAndConfigUnchanged': True,
          'proxyGetStatusMatchesBaseline': after['/api/creative/proxy'] == after['/api/creative/proxy/'] == 405,
          'oldCandidateGateAndUatProcessesOnline': True,
          'accessLogBoundary': 'Existing Nginx access logging is off. Routing is verified by effective configuration, distinct dynamic login build identities, unchanged gate process/config, and existing method-denial responses; no access-log upstream trace is claimed.',
          'paidGenerationOrHistoryCleanupRequested': False}
(ROOT / 'postdeploy-smoke.json').write_text(json.dumps(result, indent=2))
print('POSTDEPLOY_READ_ONLY_SMOKE_PASSED', json.dumps(result))
