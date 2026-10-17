#!/usr/bin/env python3
"""Bounded one-time follow-up after the authorized ZIP dedupe completes."""
import datetime
import json
import os
import pathlib
import subprocess
import time

OUT = pathlib.Path('/root/sanjie-resource-optimization-20261009/phase2')
ROOT = OUT.parent


def run(argv, timeout=1800):
    r = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    # Only our own maintenance scripts are executed; they emit no credentials.
    if r.returncode:
        print('FOLLOWUP_COMMAND_FAILED', pathlib.Path(argv[1]).name if len(argv) > 1 else argv[0], r.returncode)
        print(r.stdout.decode()[-1200:])
        raise RuntimeError('maintenance_followup_stopped')
    return r.stdout.decode()


def main():
    os.umask(0o077)
    deadline = time.monotonic() + 7200
    while time.monotonic() < deadline:
        state = subprocess.run(['systemctl', 'is-active', 'sanjie-download-dedupe-apply.service'],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        if state.returncode != 0:
            break
        time.sleep(10)
    else:
        raise RuntimeError('dedupe_completion_timeout')
    result = json.loads((OUT / 'download-dedupe-result.json').read_text())
    assert result['status'] == 'completed' and result['files_deduplicated'] == 1252
    print('DEDUPE_COMPLETION_CONFIRMED', flush=True)
    qa = OUT / 'qa-build-cleanup-20261009.py'
    print(run(['/usr/bin/python3', str(qa), '--max-gib', '1']), flush=True)
    preview = json.loads((ROOT / 'qa-build-cleanup-result.json').read_text())
    assert preview['status'] == 'completed' and preview['counts'] == {'would_remove': 3}
    (OUT / 'qa-final-dry-run.json').write_text(json.dumps(preview, indent=2))
    print(run(['/usr/bin/python3', str(qa), '--apply', '--max-gib', '1']), flush=True)
    applied = json.loads((ROOT / 'qa-build-cleanup-result.json').read_text())
    assert applied['status'] == 'completed' and applied['counts'] == {'removed': 3}
    print(run(['/usr/bin/python3', str(OUT / 'resource-phase2-verify.py')]), flush=True)
    # Verify real manifests and canonical bytes on one historical release,
    # without putting duplicates back onto the disk.
    plan = json.loads((OUT / 'download-dedupe-plan.json').read_text())
    release = sorted({r['root'] for r in plan['targets']})[0]
    print(run(['/usr/bin/python3', str(OUT / 'release-download-restore-20261009.py'),
               '--release', release]), flush=True)
    marker = {'status': 'completed', 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'qa_dry_run_and_apply': True, 'verification': True, 'server_restore_dry_run': True}
    (OUT / 'phase2-finish-result.json').write_text(json.dumps(marker, indent=2))
    print('ALL_PHASE2_WORK_COMPLETE', flush=True)


if __name__ == '__main__':
    main()
