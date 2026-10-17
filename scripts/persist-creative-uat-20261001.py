#!/usr/bin/env python3
"""Verify existing UAT resurrection entry; preserve dump bytes and protect modes.

Does not call pm2 save/resurrect or change any process. The concurrent official
publisher has already saved the correct UAT; this proves that fact and backs up
both private dump files before a guarded chmod to 0600.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import time


def projection(live):
    result = []
    for row in live:
        environment = copy.deepcopy(row['pm2_env'])
        for name in ('instances', 'pm_id', 'prev_restart_delay'):
            environment.pop(name, None)
        if not environment.get('pmx_module'):
            result.append(environment)
    return result


def require_preserved(prior, projected):
    old_names = [row['name'] for row in prior]
    new_names = [row['name'] for row in projected]
    if len(set(old_names)) != len(old_names) or len(set(new_names)) != len(new_names):
        raise RuntimeError('PM2 process names are not unique')
    by_name = {row['name']: row for row in projected}
    for row in prior:
        if row['name'] not in by_name:
            raise RuntimeError('Prior PM2 resurrection entry is absent from current namespace')
        current = by_name[row['name']]
        # axm_monitor contains current heap/event-loop telemetry, not resurrection
        # options; every other key, type, absence and array order must match.
        for name in (set(row) | set(current)) - {'axm_monitor'}:
            if name not in row or name not in current or json.dumps(row[name], sort_keys=True) != json.dumps(current[name], sort_keys=True):
                raise RuntimeError('Prior PM2 resurrection field differs: ' + name)


def main():
    spec = importlib.util.spec_from_file_location('uat', '/var/tmp/deploy-creative-uat-20261001.py')
    uat = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(uat)
    uat.require(os.getuid() == 0 and Path.home() == Path('/root'), 'PM2 namespace user is not root')
    uat.require(os.environ.get('PM2_HOME', '/root/.pm2') == '/root/.pm2', 'PM2_HOME differs')
    executable = Path(shutil.which('pm2')).resolve()
    environment = uat.clean_environment({'PM2_HOME': '/root/.pm2'})
    show = uat.run(['systemctl', 'show', 'pm2-root.service',
                    '--property=User,Environment,ExecStart,UnitFileState,ActiveState'])
    properties = dict(line.split('=', 1) for line in show.splitlines() if '=' in line)
    unit_environment = dict(part.split('=', 1) for part in shlex.split(properties.get('Environment', '')) if '=' in part)
    uat.require(properties.get('UnitFileState') == 'enabled' and properties.get('User') == 'root' and
                unit_environment.get('PM2_HOME') == '/root/.pm2' and
                str(executable) + ' resurrect' in properties.get('ExecStart', ''),
                'Effective PM2 startup namespace/executable differs')
    deployment = uat.state()
    uat.require(deployment['phase'] == 'verified' and deployment.get('routed'), 'UAT is not verified')
    uat.verify_production(deployment, nginx=False)
    uat.require(uat.digest(uat.CONF.read_bytes()) == deployment['nginx_routed_sha256'], 'Nginx changed')
    uat_process = uat.verify_uat_environment()
    dump = Path('/root/.pm2/dump.pm2')
    backup = dump.with_name('dump.pm2.bak')
    uat.require(all(path.is_file() and not path.is_symlink() for path in (dump, backup)), 'Private PM2 dump files are missing/symlinks')
    originals = tuple(path.read_bytes() for path in (dump, backup))
    prior = json.loads(originals[0])
    live = json.loads(uat.run([str(executable), 'jlist'], env=environment))
    require_preserved(prior, projection(live))
    selected = [row for row in prior if row['name'] == uat.PROCESS]
    uat.require(len(selected) == 1, 'UAT is not uniquely persisted; no pm2 save attempted')
    expected_environment = uat.read_env(uat.RELEASE)
    uat.require(all(selected[0].get(key) == value for key, value in expected_environment.items()) and
                selected[0].get('NODE_OPTIONS') == '--dns-result-order=ipv4first' and
                selected[0].get('pm_cwd') == str(uat.RELEASE), 'Persisted UAT environment differs')
    original_summary = [{key: row.get(key) for key in ('name', 'pid', 'pm_id')} |
                        {'restarts': row['pm2_env'].get('restart_time')} for row in live]
    directory = Path('/root/.pm2/creative-uat-private-backups') / str(time.time_ns())
    os.umask(0o077)
    directory.mkdir(mode=0o700, parents=True)
    directory.parent.chmod(0o700)
    for path, original in zip((dump, backup), originals):
        copied = directory / path.name
        copied.write_bytes(original)
        copied.chmod(0o600)
    uat.require(tuple(path.read_bytes() for path in (dump, backup)) == originals, 'PM2 dump changed before permission update')
    for path, original in zip((dump, backup), originals):
        uat.require(path.read_bytes() == original, 'PM2 dump changed immediately before chmod')
        path.chmod(0o600)
    uat.require(tuple(path.read_bytes() for path in (dump, backup)) == originals, 'Concurrent PM2 dump write during chmod; private originals retained')
    uat.require(all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in (dump, backup)), 'Private PM2 dump modes are not 0600')
    current = json.loads(uat.run([str(executable), 'jlist'], env=environment))
    current_summary = [{key: row.get(key) for key in ('name', 'pid', 'pm_id')} |
                       {'restarts': row['pm2_env'].get('restart_time')} for row in current]
    uat.require(current_summary == original_summary, 'PM2 process identity changed during readback')
    require_preserved(prior, projection(current))
    uat.verify_production(deployment, nginx=False)
    uat.verify_uat_environment()
    proof = {'persisted': True, 'alreadySavedByConcurrentPublisher': True, 'pm2SaveExecuted': False,
             'entriesPreserved': len(prior), 'allOriginalDumpAndBackupBytesUnchanged': True,
             'allResurrectionConfigurationMatchesCurrentProcesses': True,
             'livePidsAndRestartCountsUnchanged': True, 'startupUnitEnabled': True,
             'startupUnitActiveState': properties.get('ActiveState'), 'startupUser': 'root',
             'pm2Home': '/root/.pm2', 'pm2Executable': str(executable),
             'dumpSha256': uat.digest(originals[0]), 'backupSha256': uat.digest(originals[1]),
             'privateOriginalBackupDirectory': str(directory), 'dumpMode': '0600', 'backupMode': '0600',
             'uat': uat_process, 'restartSimulationPerformed': False,
             'readTimeUtc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    uat.write_json('/var/tmp/creative-uat-pm2-persistence.json', proof)
    print(json.dumps(proof))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error))
        raise SystemExit(1)
