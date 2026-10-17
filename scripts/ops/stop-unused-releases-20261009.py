#!/usr/bin/env python3
"""One-time, reversible stop of audited unreferenced release processes."""
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

EXPECTED_IDS = {114,119,127,128,129,130,131,132,134,135,136,137,138,139,140,141,142,143,144,145,147,151,152,153,154,155,156,157,158,159,160,161,162,163}
RECORD = Path('/root/sanjie-resource-optimization-20261009')

def run(args):
    return subprocess.check_output(args, text=True)

def main():
    os.umask(0o077)
    RECORD.mkdir(mode=0o700, exist_ok=True)
    nginx = subprocess.run(['nginx', '-T'], capture_output=True, text=True, check=True)
    conf = nginx.stdout + nginx.stderr
    ports = set(map(int, re.findall(r'127\.0\.0\.1:(\d+)', conf)))
    ports.update(map(int, re.findall(r'(?:default|"20261001")\s+(\d+)\s*;', conf)))
    ports.update({32011,32150,44019,44119,5180,8080})
    if 'default 44119;' not in conf or 44019 not in ports:
        raise RuntimeError('Fresh production routing differs from audited baseline')
    raw = run(['pm2','jlist'])
    apps = json.loads(raw)
    targets = [p for p in apps if p['pm_id'] in EXPECTED_IDS and p['pm2_env']['status']=='online'
               and p['name'].startswith('sanjie')
               and str(p['pm2_env'].get('PORT','')).isdigit()
               and int(p['pm2_env']['PORT']) not in ports]
    if {p['pm_id'] for p in targets} != EXPECTED_IDS:
        raise RuntimeError('Process list changed; stop aborted')
    for p in targets:
        cwd = Path(p['pm2_env']['pm_cwd'])
        if cwd.parent != Path('/opt/sanjie-releases') or not cwd.is_dir() or cwd.is_symlink():
            raise RuntimeError('Unexpected release path')
    (RECORD/'pm2-before.private.json').write_text(raw)
    if Path('/root/.pm2/dump.pm2').is_file():
        shutil.copy2('/root/.pm2/dump.pm2',RECORD/'dump-before.private.pm2')
    audit = {'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'protectedPorts':sorted(ports),
             'stopped':[{'id':p['pm_id'],'name':p['name'],'cwd':p['pm2_env']['pm_cwd'],
                         'port':p['pm2_env']['PORT'],'rss':p['monit']['memory']} for p in targets]}
    (RECORD/'stopped-releases.json').write_text(json.dumps(audit,indent=2))
    subprocess.run(['pm2','stop',*[str(p['pm_id']) for p in targets]],check=True,stdout=subprocess.DEVNULL)
    subprocess.run(['pm2','save'],check=True,stdout=subprocess.DEVNULL)
    after = json.loads(run(['pm2','jlist']))
    assert all(p['pm2_env']['status']=='stopped' for p in after if p['pm_id'] in EXPECTED_IDS)
    assert all(p['pm2_env']['status']=='online' for p in after if p['pm_id'] in {133,164,166})
    print('STOPPED',len(targets),'PREVIOUS_RSS_MIB',round(sum(p['monit']['memory'] for p in targets)/1048576))
    print('ROLLBACK: pm2 restart '+' '.join(str(p['pm_id']) for p in targets)+' && pm2 save')
    print(run(['free','-m']))

if __name__ == '__main__':
    main()
