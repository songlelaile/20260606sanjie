import json
from pathlib import Path

ROOT = Path('/opt/sanjie-releases/20261017-image-studio-optimize-v1')
baseline = json.loads(Path('/tmp/sanjie-image-baseline-test-result-20261017.json').read_text())
candidate = json.loads(Path('/tmp/sanjie-image-production-final-tests-20261017.json').read_text())

def failures(report):
    result = {}
    for suite in report['testResults']:
        path = 'src/' + suite['name'].split('/src/', 1)[1]
        failed = [case for case in suite.get('assertionResults', []) if case['status'] == 'failed']
        for case in failed:
            result[path + ' :: ' + case['fullName']] = case.get('failureMessages', [])
        if suite['status'] == 'failed' and not failed:
            result[path + ' :: SUITE_LOAD_ERROR'] = [suite.get('message', '')]
    return result

b, c = failures(baseline), failures(candidate)
renamed = {
    'src/lib/creative-image-runtime.test.ts :: image studio background and UI coexistence opens API settings through one message and the current authenticated UI bridge without recursion':
    'src/lib/creative-image-runtime.test.ts :: image studio background and UI coexistence opens API settings through one message and the real UI fallback without recursion'
}
# One fixture title was updated to describe its new bridge assertion. Both runs
# stop at the identical, unchanged frozen-leaf precondition before that assertion.
for new, old in renamed.items():
    assert new in c and old in b
    marker = 'Frozen source bytes: creative/src/reference-detail-contract.js'
    assert marker in '\n'.join(c[new]) and marker in '\n'.join(b[old])
    c[old] = c.pop(new)
keys = ['numPassedTests', 'numFailedTests', 'numPendingTests', 'numPassedTestSuites', 'numFailedTestSuites']
result = {
    'baseline': {k: baseline.get(k) for k in keys},
    'candidate': {k: candidate.get(k) for k in keys},
    'baselineFailureIdentities': sorted(b),
    'candidateFailureIdentities': sorted(c),
    'newFailures': sorted(set(c) - set(b)),
    'resolvedBaselineFailures': sorted(set(b) - set(c)),
    'renamedExistingFailures': renamed,
    'boundary': 'A failure-identity comparison against the untouched current production source. Existing failures remain failures; this is not a claim that the production test suite is green.'
}
(ROOT / 'production-test-comparison.json').write_text(json.dumps(result, indent=2))
print('PRODUCTION_COMPARISON', json.dumps({k: result[k] for k in ['baseline', 'candidate', 'newFailures', 'resolvedBaselineFailures']}))
assert result['newFailures'] == [], 'Do not switch traffic with new test failures'
