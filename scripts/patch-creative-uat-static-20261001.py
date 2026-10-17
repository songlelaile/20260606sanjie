#!/usr/bin/env python3
"""Apply an explicitly sealed three-file UAT static correction without restarting."""
from __future__ import annotations

import argparse
import copy
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time

RUNNER_SHA = 'ebf460c8d408245fd53045ebd57a7d52d77ff7f6a8b405e7062f9f45b1240629'
OLD_BUNDLE_SHA = '99d5db3187a5deeb68527d6d9165f514bc0ee8ab662c2db5e5a17fcf75217999'
ALLOWED = frozenset({
    'public/creative/web-video-host.js',
    'public/creative/labs/ecommerce-video-studio/video-studio.js',
    'src/lib/creative-web.test.ts',
})
RELEASE = Path('/opt/sanjie-test-releases/20261001-creative-uat')


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def changed_files(old, new):
    require(len(old) == len(new) == 494 and set(old) == set(new),
            'Frozen bundle source inventory changed')
    changed = {name for name in old if old[name] != new[name]}
    require(changed == ALLOWED, 'Patch must change exactly the three approved files')
    return sorted(changed)


def identity(runner):
    # Hash complete private snapshots in memory; never disclose environment values.
    pm2 = json.loads(runner.run(['pm2', 'jlist']))
    fixed = [{k: row.get(k) for k in ('pm_id', 'name', 'pid')} |
             {k: row['pm2_env'].get(k) for k in
              ('pm_cwd', 'args', 'PORT', 'status', 'restart_time')} for row in pm2]
    return {'processes': fixed, 'nginx': runner.digest(runner.CONF.read_bytes()),
            'dump': runner.digest(Path('/root/.pm2/dump.pm2').read_bytes()),
            'dump_backup': runner.digest(Path('/root/.pm2/dump.pm2.bak').read_bytes()),
            'build_id': (RELEASE / '.next/BUILD_ID').read_text().strip(),
            'environment': runner.digest((RELEASE / '.env').read_bytes())}


def checked_path(relative):
    path = RELEASE / relative
    current = path
    while current != RELEASE:
        require(not current.is_symlink(), 'Patch target has a symlink: ' + relative)
        current = current.parent
    require(path.is_file(), 'Patch target missing: ' + relative)
    return path


def no_symlinks(path):
    current = path
    while current != current.parent:
        require(not current.is_symlink(), 'Patch would follow a symlink: ' + path.name)
        current = current.parent


def replace_if_expected(path, expected, content):
    no_symlinks(path)
    if expected is None:
        require(not path.exists(), 'Concurrent new proof target modification')
        mode = 0o600
    else:
        require(path.is_file(), 'Patch target is not a regular file')
        require(path.read_bytes() == expected, 'Concurrent target modification; no overwrite: ' + path.name)
        mode = path.stat().st_mode & 0o777
    descriptor, temporary_name = tempfile.mkstemp(prefix=path.name + '.creative-static-', dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            opened = os.fstat(output.fileno())
            output.write(content)
            output.flush()
            os.fchmod(output.fileno(), mode)
            os.fsync(output.fileno())
        no_symlinks(path)
        no_symlinks(temporary)
        staged = temporary.stat()
        require((staged.st_dev, staged.st_ino) == (opened.st_dev, opened.st_ino),
                'Staged static patch file changed')
        require((not path.exists()) if expected is None else (path.read_bytes() == expected),
                'Target changed during static patch CAS: ' + path.name)
        temporary.replace(path)
    finally:
        if temporary.exists() or temporary.is_symlink():
            temporary.unlink()


def restore_if_own_write(path, original, own_write):
    if original is not None:
        replace_if_expected(path, own_write, original)
    else:
        no_symlinks(path)
        require(path.is_file() and path.read_bytes() == own_write,
                'Concurrent new proof modification prevents rollback')
        path.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runner', type=Path, required=True)
    parser.add_argument('--old-bundle', type=Path, required=True)
    parser.add_argument('--new-bundle', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    require(re.fullmatch(r'[a-f0-9]{64}', args.sha256) is not None, 'Invalid new frozen SHA')
    require(args.sha256 != OLD_BUNDLE_SHA, 'New static bundle must be distinct')
    import hashlib
    require(hashlib.sha256(args.runner.read_bytes()).hexdigest() == RUNNER_SHA, 'Runner SHA mismatch')
    spec = importlib.util.spec_from_file_location('uat_runner', args.runner)
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    require(runner.RELEASE == RELEASE, 'Unexpected UAT release')

    old_archive, old_members = runner.bundle_members(args.old_bundle, OLD_BUNDLE_SHA)
    new_archive, new_members = runner.bundle_members(args.new_bundle, args.sha256)
    try:
        old_inventory = runner.frozen_inventory(old_archive, old_members)
        new_inventory = runner.frozen_inventory(new_archive, new_members)
        changed = changed_files(old_inventory, new_inventory)
        new_contents = {member.name: new_archive.extractfile(member).read()
                        for member in new_members if member.isfile() and member.name in ALLOWED}
    finally:
        old_archive.close()
        new_archive.close()
    require(set(new_contents) == ALLOWED, 'Missing patch content')
    runner.verify_frozen_source(old_inventory)
    state_path = runner.STATE
    manifest_path = RELEASE / 'uat-frozen-files.json'
    before_state = state_path.read_bytes()
    before_manifest = manifest_path.read_bytes()
    deployment = json.loads(before_state)
    # Reuse exact isolation-map validation, but stage the fresh formal baseline
    # in memory. Its only write joins the same metadata CAS transaction below.
    if runner.digest(runner.CONF.read_bytes()) != deployment['nginx_routed_sha256']:
        runner.save_state = lambda _deployment: None
        deployment = runner.adopt_runtime_baseline(copy.deepcopy(deployment))
    runner.state = lambda: deployment
    runner.verify_production(deployment, nginx=False)
    before = identity(runner)
    require(before['nginx'] == deployment['nginx_routed_sha256'], 'Fresh formal routing drifted')
    require(before['build_id'] == 'Z3paCEiAnyMhDNqoUZ1Gb', 'UAT build identity changed')
    uat = runner.verify_uat_environment()
    require(uat['pm_id'] == 120 and uat['pid'] == 1454541 and uat['restarts'] == 0,
            'UAT process identity changed')
    proof_path = RELEASE / 'static-patch-proof.json'
    no_symlinks(proof_path)
    require(not proof_path.exists() or proof_path.is_file(), 'Unexpected existing proof type')
    before_proof = proof_path.read_bytes() if proof_path.exists() else None
    require(deployment['bundle_sha256'] == OLD_BUNDLE_SHA and deployment['phase'] == 'verified',
            'Static patch requires the verified original frozen release')
    require(json.loads(before_manifest) == old_inventory, 'Current frozen inventory mismatch')
    require(runner.digest(before_manifest) == deployment['frozen_manifest_sha256'], 'Manifest SHA drifted')

    backup = RELEASE / ('static-patch-backups/' + str(time.time_ns()))
    backup.mkdir(parents=True, mode=0o700)
    backup.parent.chmod(0o700)
    original_contents = {relative: checked_path(relative).read_bytes() for relative in changed}
    for relative, content in original_contents.items():
        saved = backup / relative
        saved.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        saved.write_bytes(content)
        saved.chmod(0o600)
    for filename, content in (('state.json', before_state), ('manifest.json', before_manifest)):
        saved = backup / filename
        saved.write_bytes(content)
        saved.chmod(0o600)

    after_manifest = (json.dumps(new_inventory, ensure_ascii=False, indent=2) + '\n').encode()
    proof = {'oldBundleSha256': OLD_BUNDLE_SHA, 'bundleSha256': args.sha256,
             'files': changed, 'unchangedFiles': 491, 'frozenFiles': 494,
             'buildId': before['build_id'], 'uat': uat,
             'nginxSha256': before['nginx'], 'production': deployment['production'],
             'noBuildOrRestart': True,
             'readTimeUtc': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
    deployment.setdefault('static_patch_history', []).append(proof)
    deployment.update({'bundle_sha256': args.sha256,
                       'frozen_manifest_sha256': runner.digest(after_manifest)})
    proof.update({'backup': str(backup), 'all494FilesMatchNewFrozenBundle': True,
                  'runtimeAndFormalProcessesUnchanged': True,
                  'frozenManifestSha256': runner.digest(after_manifest),
                  'oldBundleRetained': args.old_bundle.is_file()})
    after_state = (json.dumps(deployment, ensure_ascii=False, indent=2) + '\n').encode()
    after_proof = (json.dumps(proof, ensure_ascii=False, indent=2) + '\n').encode()
    installed = []
    try:
        # Guard all sources and runtime before the first mutation.
        runner.verify_frozen_source(old_inventory)
        require(identity(runner) == before, 'Runtime changed during preflight')
        require(state_path.read_bytes() == before_state and manifest_path.read_bytes() == before_manifest,
                'Static patch metadata changed during preflight')
        for relative in changed:
            path = checked_path(relative)
            replace_if_expected(path, original_contents[relative], new_contents[relative])
            installed.append((path, original_contents[relative], new_contents[relative]))
        runner.verify_frozen_source(new_inventory)
        require(identity(runner) == before, 'Runtime changed during static patch')
        replace_if_expected(manifest_path, before_manifest, after_manifest)
        installed.append((manifest_path, before_manifest, after_manifest))
        replace_if_expected(state_path, before_state, after_state)
        installed.append((state_path, before_state, after_state))
        replace_if_expected(proof_path, before_proof, after_proof)
        installed.append((proof_path, before_proof, after_proof))
        runner.verify_frozen_source(new_inventory)
        require(identity(runner) == before, 'Runtime changed during final verification')
        require(runner.verify_uat_environment() == uat, 'UAT environment changed during static patch')
    except Exception:
        conflicts = []
        for path, original, own_write in reversed(installed):
            try:
                restore_if_own_write(path, original, own_write)
            except Exception:
                conflicts.append(path.name)
        require(not conflicts, 'Concurrent patch modification prevented rollback: ' + ','.join(conflicts))
        runner.verify_frozen_source(old_inventory)
        require(state_path.read_bytes() == before_state and manifest_path.read_bytes() == before_manifest,
                'Rollback metadata did not return to the original frozen release')
        raise
    print(json.dumps(proof, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
