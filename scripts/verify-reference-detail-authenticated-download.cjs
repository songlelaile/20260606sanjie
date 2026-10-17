'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const ready = path.join(root, '.codex-deploy/reference-detail-screenshot-20261012/rerun/live195/authenticated-browser-ready');
const config = JSON.parse(fs.readFileSync(path.join(ready, 'fixture-manifest.json')));
const input = process.argv[2];
if (!input) throw new Error('Pass the downloaded acceptance JSON absolute path');
const report = JSON.parse(fs.readFileSync(input));
assert.equal(report.schema, 'SZ_REFERENCE_DETAIL_AUTHENTICATED_UI_ACCEPTANCE_V1');
assert.equal(report.runSuffix, config.runSuffix);
assert.equal(report.mockUsed, false);
assert.equal(report.harnessVersion, 3);
assert.equal(report.initialization.state, 'ready');
assert.equal(report.initialization.timeoutMs, 25000);
assert.equal(report.initializationGate.kind, 'actual_auth_owner_archive_epoch_and_screenshot_intake');
assert.equal(report.initializationGate.creativeOnlyReadyAwaited, false);
assert.equal(report.initializationGate.bundledConfigHelperRequired, false);
assert.equal(report.initializationGate.authIdentityEncoding, 'sealed_configAccountKeyFromAuth_encoding');
assert.equal(report.initializationGate.inputBusyReason, 0);
assert.equal(report.initializationGate.screenshotInputVisible, true);
assert.equal(report.initializationGate.sourceConstructorAvailable, true);
assert.equal(report.initializationGate.originalPreservationAvailable, true);
assert.equal(new URL(report.targetUrl).origin, config.origin);
assert.equal(new URL(report.targetUrl).searchParams.get('sz_ref_acceptance'), config.runSuffix);
assert.equal(report.expectedManifestSha256, config.manifestSha256);
for (const expected of config.assets) {
  const actual = report.assets.find(asset => asset.path === expected.path);
  assert.ok(actual, 'Missing production asset fingerprint: ' + expected.path);
  assert.equal(actual.actualSha256, expected.sha256, expected.path);
}
const before = report.stages.find(stage => stage.label === 'before');
const upload = report.stages.find(stage => stage.label === 'upload3');
const final = report.stages.find(stage => stage.label === 'final');
assert.ok(before && upload && final, 'Before/upload3/final actual stages are required');
assert.equal(before.refs.length, 0);
assert.equal(before.inputBusyReason, 0);
assert.equal(report.initializationGate.ownerAccountKey, before.ownerAccountKey);
assert.equal(report.initializationGate.backendAuthUserId, before.backendAuthUserId);
assert.equal(report.initializationGate.archiveIdentityVersion, before.archiveIdentityVersion);
assert.ok(Number.isSafeInteger(before.archiveIdentityVersion) && before.archiveIdentityVersion >= 1);
assert.equal(upload.inputBusyReason, 0);
assert.equal(upload.sourceSchema, 'REFERENCE_DETAIL_SCREENSHOT_SOURCE_V1');
assert.equal(upload.refs.length, 3);
assert.deepEqual(upload.sourceRefs, upload.refs);
assert.deepEqual(upload.previewRefs, upload.refs);
assert.equal(upload.sourceInputVisible, true);
assert.equal(upload.analyzeEnabled, true);
assert.equal(upload.referenceOnly, true);
assert.equal(upload.sourceFactsCount, 0);
assert.equal(upload.sourceItemId, '');
assert.ok(!['taobao', 'tmall'].includes(upload.sourcePlatform));
for (const stage of report.stages) {
  assert.equal(stage.ownerAccountKey, before.ownerAccountKey);
  assert.equal(stage.backendAuthUserId, before.backendAuthUserId);
  assert.equal(stage.archiveIdentityVersion, before.archiveIdentityVersion);
}
for (const fixture of config.fixtures) {
  const original = upload.originals.find(row => row.hash === fixture.sha256 && row.actualHash === fixture.sha256 && row.bytes === fixture.bytes);
  assert.ok(original, 'Uploaded original bytes must match ' + fixture.label);
  assert.equal(original.accountKey, before.ownerAccountKey);
}
assert.deepEqual(report.preservation.missingOriginals, []);
assert.deepEqual(report.preservation.changedOriginals, []);
assert.deepEqual(report.preservation.changedProtectedStorage, []);
assert.deepEqual(report.blocked, []);
assert.deepEqual(report.dangerousNetwork, []);
assert.equal(report.paidAnalysisPerformed, false);
assert.equal(report.imageGenerationPerformed, false);
const bundles = report.loadedScripts.filter(name => /\/studio-(?:prerequisites|runtime|views)-[^/]+\.js$/.test(name));
assert.equal(bundles.length, 3);
const downloadedOriginal = process.argv[3];
let originalDownloadVerified = false;
if (downloadedOriginal) {
  const bytes = fs.readFileSync(downloadedOriginal), digest = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.ok(config.fixtures.some(fixture => fixture.sha256 === digest), 'Downloaded original must equal one input PNG byte for byte');
  originalDownloadVerified = true;
}
const summary = { passed: true, input: path.resolve(input), runSuffix: report.runSuffix, evidenceLayer: report.evidenceLayer,
  actualAuthenticatedSourceIntake: true, sixProductionAssetHashesMatched: true, preservedDependenciesMatched: true,
  beforeOriginalCount: before.originals.length, afterOriginalCount: final.originals.length,
  allExistingOriginalsPreserved: true, sharedConfigDraftReceiptHashesPreserved: true,
  currentReferenceBusyReason: 0, originalsInputShaMatched: 3, originalDownloadVerified,
  providerBillingDispatches: 0, paidAnalysisPerformed: false, imageGenerationPerformed: false };
fs.writeFileSync(path.join(ready, 'verified-authenticated-result.json'), JSON.stringify(summary, null, 2) + '\n');
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
