#!/usr/bin/env python3
"""Read-only, sanitized ECS inventory. No environment/config values are emitted."""
import datetime
import json
import os
import pathlib
import subprocess

RECORD = pathlib.Path('/root/sanjie-resource-optimization-20261009/phase2')


def command(argv, timeout=180):
    result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            universal_newlines=True, timeout=timeout)
    if result.returncode:
        return {'error': argv[0], 'exit': result.returncode}
    return result.stdout


def size(path):
    if not os.path.isdir(path) or os.path.islink(path):
        return None
    result = command(['nice', '-n', '15', 'ionice', '-c', '3', 'du', '-sx', '-B1', '--', path])
    return int(result.split()[0]) if isinstance(result, str) else result


def processes():
    values, deleted, seen = [], [], set()
    for entry in pathlib.Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = {}
            for line in (entry / 'status').read_text().splitlines():
                key, _, value = line.partition(':')
                if key in ('Name', 'PPid', 'VmRSS'):
                    fields[key] = value.strip()
            rss = int(fields.get('VmRSS', '0 kB').split()[0])
            if rss:
                pss = 0
                rollup = entry / 'smaps_rollup'
                if rollup.exists():
                    for line in rollup.read_text().splitlines():
                        if line.startswith('Pss:'):
                            pss = int(line.split()[1])
                try:
                    cwd = os.readlink(str(entry / 'cwd'))
                except OSError:
                    cwd = None
                values.append({'pid': int(entry.name), 'ppid': fields.get('PPid'),
                               'name': fields.get('Name'), 'rss_kib': rss,
                               'pss_kib': pss, 'cwd': cwd})
            for fd in (entry / 'fd').iterdir():
                try:
                    link = os.readlink(str(fd))
                    if not link.endswith(' (deleted)'):
                        continue
                    metadata = fd.stat()
                    identity = (metadata.st_dev, metadata.st_ino)
                    if identity in seen or metadata.st_size < 1048576:
                        continue
                    seen.add(identity)
                    deleted.append({'pid': int(entry.name), 'path': link,
                                    'bytes': metadata.st_size})
                except OSError:
                    pass
        except (OSError, ValueError):
            continue
    return sorted(values, key=lambda row: row['pss_kib'], reverse=True)[:25], deleted


def main():
    os.umask(0o077)
    RECORD.mkdir(mode=0o700, exist_ok=True)
    apps_raw = command(['pm2', 'jlist'], 45)
    apps = json.loads(apps_raw) if isinstance(apps_raw, str) else []
    online = [{'id': app['pm_id'], 'pid': app['pid'], 'name': app['name'],
               'cwd': app['pm2_env']['pm_cwd'], 'rss': app['monit']['memory']}
              for app in apps if app['pm2_env']['status'] == 'online']
    top, deleted = processes()
    report = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'free': command(['free', '-m']), 'df': command(['df', '-h', '/']),
              'online': online, 'processes_by_pss': top, 'open_deleted_files': deleted,
              'disk_top': {p: command(['nice', '-n', '15', 'ionice', '-c', '3', 'du', '-x', '-B1', '--max-depth=1', p])
                           for p in ['/opt', '/root', '/var']},
              'cache_bytes': {p: size(p) for p in ['/root/.npm/_cacache', '/root/.cache', '/var/cache/dnf', '/var/cache/yum', '/tmp']},
              'docker_usage': command(['docker', 'system', 'df']),
              'docker_memory': command(['docker', 'stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}}']),
              'docker_mounts': [], 'release_builds': []}
    container_ids = command(['docker', 'ps', '-q'])
    if isinstance(container_ids, str) and container_ids.strip():
        inspect_raw = command(['docker', 'inspect'] + container_ids.split())
        if isinstance(inspect_raw, str):
            for container in json.loads(inspect_raw):
                report['docker_mounts'].append({'name': container['Name'],
                    'mounts': [{key: mount.get(key) for key in ('Type', 'Source', 'Destination', 'RW')}
                               for mount in container['Mounts']],
                    'log_driver': container['HostConfig']['LogConfig'],
                    'log_bytes': os.path.getsize(container['LogPath']) if container['LogPath'] and os.path.exists(container['LogPath']) else 0})
    for parent in ['/opt/sanjie-releases', '/opt/sanjie-test-releases', '/opt/sower-work-releases']:
        if not os.path.isdir(parent):
            continue
        for root in pathlib.Path(parent).iterdir():
            if root.is_symlink() or not root.is_dir():
                continue
            leaves = {}
            for leaf in ('node_modules', '.next'):
                path = root / leaf
                if path.is_symlink():
                    leaves[leaf] = {'symlink_target': os.path.realpath(str(path))}
                elif path.is_dir():
                    leaves[leaf] = {'bytes': size(str(path))}
            if leaves:
                report['release_builds'].append({'release': str(root), 'leaves': leaves})
    (RECORD / 'deep-inventory.json').write_text(json.dumps(report, indent=2))
    print('DEEP_INVENTORY_COMPLETE', str(RECORD / 'deep-inventory.json'))
    print(report['free'], end='')
    print(report['df'], end='')
    print('MEMORY_TOP', json.dumps(top[:12]))
    print('CACHE_BYTES', json.dumps(report['cache_bytes']))
    print('OPEN_DELETED_FILES', json.dumps(deleted[:10]))
    print('DOCKER_USAGE', report['docker_usage'].replace('\n', ' | ') if isinstance(report['docker_usage'], str) else report['docker_usage'])


if __name__ == '__main__':
    main()
