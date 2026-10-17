#!/usr/bin/env python3
"""Inventory only: propose obsolete build artifacts, preserving source/data."""
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import time

BASE = Path('/opt/sanjie-releases')
RECORD = Path('/root/sanjie-resource-optimization-20261009')
PINNED = {'20261007-image-repair-v1', '20261009-sunburst-guide-plugin84-v4',
          'credit-pool-shared-wallet-20261009-v1'}

def process_directories():
    paths = set()
    for p in Path('/proc').glob('[0-9]*/cwd'):
        try:
            paths.add(str(p.resolve(strict=True)))
        except (OSError, RuntimeError):
            pass
    apps = json.loads(subprocess.check_output(['pm2','jlist'],text=True))
    for p in apps:
        if p['pm2_env']['status'] == 'online':
            paths.add(p['pm2_env']['pm_cwd'])
    return paths

def main():
    os.umask(0o077)
    RECORD.mkdir(mode=0o700,exist_ok=True)
    running = process_directories()
    nginx = subprocess.run(['nginx','-T'],capture_output=True,text=True,check=True)
    conf = nginx.stdout + nginx.stderr
    mounts = subprocess.check_output(['findmnt','-rn','-o','TARGET'],text=True).splitlines()
    targets, preserved = [], []
    for root in sorted(BASE.iterdir()):
        m = re.match(r'^(20\d{6})-',root.name)
        if not m or not root.is_dir() or root.is_symlink():
            continue
        prefix = str(root) + '/'
        protected = (root.name in PINNED or m.group(1) >= '20261007'
                     or root.stat().st_mtime > time.time()-48*3600
                     or str(root) in conf
                     or any(p==str(root) or p.startswith(prefix) for p in running))
        if protected:
            preserved.append(root.name)
            continue
        for leaf in ('node_modules','.next'):
            path = root/leaf
            if not path.is_dir() or path.is_symlink():
                continue
            if any(p==str(path) or p.startswith(str(path)+'/') for p in mounts):
                raise RuntimeError('Nested mount: '+str(path))
            stat = path.stat()
            size = int(subprocess.check_output(['du','-sx','-B1',str(path)],text=True).split()[0])
            targets.append({'path':str(path),'release':str(root),'bytes':size,
                            'device':stat.st_dev,'inode':stat.st_ino})
    result = {'plannedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'operation':'delete_obsolete_node_modules_and_next_builds_only',
              'sourceAndConfigsPreserved':True,'cutoff':'20261007','pinned':sorted(PINNED),
              'preserved':preserved,'targets':targets,'bytes':sum(p['bytes'] for p in targets)}
    (RECORD/'build-cleanup-plan.json').write_text(json.dumps(result,indent=2))
    print('PROPOSED_RELEASES',len({p['release'] for p in targets}))
    print('PROPOSED_BUILD_DIRECTORIES',len(targets))
    print('PROPOSED_RECLAIM_GIB',round(result['bytes']/1073741824,2))
    print('PRESERVED_RELEASES',len(preserved))
    print('PLAN_FILE',str(RECORD/'build-cleanup-plan.json'))
    for p in targets[:3]+targets[-3:]:
        print('SAMPLE',p['path'],round(p['bytes']/1048576),'MiB')

if __name__=='__main__':
    main()
