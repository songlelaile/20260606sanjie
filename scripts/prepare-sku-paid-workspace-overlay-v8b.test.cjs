'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const builder = require('./prepare-sku-paid-workspace-overlay-v8b.cjs');
const ROOT = path.resolve(__dirname, '..');
const PREFIX = 'public/creative/labs/image-prompt-lab/';
const BASE = path.join(ROOT, 'docs/uat-sku-workflow-20261012/production-overlay-v7');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function replay(before, after, proof) {
  const chunks = proof.chunks.map(chunk => {
    const text = before.slice(chunk.baselineStart, chunk.baselineEnd);
    assert.equal(text, after.slice(chunk.outputStart, chunk.outputEnd));
    assert.equal(Buffer.byteLength(text), chunk.bytes);
    assert.equal(hash(text), chunk.sha256);
    return text;
  });
  assert.equal(Buffer.byteLength(chunks.join('')), proof.preservedBytes);
  assert.equal(hash(chunks.join('')), proof.preservedChunksSha256);
}
test('AST transplant changes only authorized globals and preserves excluded local drift', () => {
  const old = '/* preserve 中文 */\nfunction keep(){ return 1; }\nfunction change(){ return 2; }\nfunction anchor(){ return 3; }\n';
  const local = old.replace('return 1', 'return 99').replace('return 2', 'return 22') + '\nfunction added(){ return 4; }\nfunction unrelated(){ return 5; }\n';
  const result = builder.selectivePromptlab(old, local, ['change'], [{ before: 'anchor', names: ['added'] }]);
  assert.ok(result.text.includes('function keep(){ return 1; }'));
  assert.ok(result.text.includes('function change(){ return 22; }'));
  assert.ok(result.text.includes('function added(){ return 4; }'));
  assert.equal(result.text.includes('function unrelated'), false);
  assert.equal(result.audit.excludedLocalFunctionChanges[0].name, 'keep');
  replay(old, result.text, result.audit);
});
test('AST transplant rejects duplicate selections, ambiguous/missing globals and unsupported additions', () => {
  const old = 'function a(){return 1;}\nfunction anchor(){return 1;}';
  const local = 'function a(){return 2;}\nfunction anchor(){return 1;}\nfunction extra(){return 3;}';
  assert.throws(() => builder.selectivePromptlab(old, local, ['a', 'a'], []), /Duplicate/);
  assert.throws(() => builder.selectivePromptlab(old, local, ['absent'], []), /missing/);
  assert.throws(() => builder.selectivePromptlab(old, local, ['anchor'], []), /unchanged/);
  assert.throws(() => builder.selectivePromptlab(old, local, ['a'], [{ before: 'anchor', names: ['a'] }]), /Duplicate/);
  assert.throws(() => builder.selectivePromptlab(old, local, ['a'], [{ before: 'absent', names: ['extra'] }]), /anchor/);
  assert.throws(() => builder.selectivePromptlab(old, local + '\nfunction a(){return 4;}', ['a'], []), /Ambiguous/);
});
test('paid-controls owner hook retains the published counter while preserving the checkout omission', () => {
  const old = "function setArchiveAccountKey(){\n  state.archiveAccountKey = next;\n  state.archiveIdentityVersion++;\n  try { Promise.resolve(restoreSkuDurableReceipts()).catch(function () {}); } catch (_) {}\n}";
  const local = old.replace('  state.archiveIdentityVersion++;\n', '').replace('try { Promise.resolve', 'try { renderSkuPaidWorkspaceControls();Promise.resolve');
  const result = builder.selectivePromptlab(old, local, ['setArchiveAccountKey'], []);
  assert.equal(result.text, old.replace('try { Promise.resolve', 'try { renderSkuPaidWorkspaceControls();Promise.resolve'));
  assert.equal(local.includes('state.archiveIdentityVersion++'), false);
  assert.equal(result.audit.ownerReadyHook.publishedCounterPreserved, true);
  assert.equal(result.audit.ownerReadyHook.checkoutCounterOmissionPreserved, true);
  assert.throws(() => builder.selectivePromptlab(old, local.replace('next;', 'changed;'), ['setArchiveAccountKey'], []), /Owner function differs/);
});
test('batch transplant permits only the paid-authorization early guard', () => {
  const old = 'function generateSkuBatch(onlyFailed) {\n  return existingBatch(onlyFailed);\n}';
  const guard = "  if (state._skuPaidAuthorizing) return Promise.resolve({ok:false,error:'请等待新付费批次授权保存完成。'});\n";
  const local = old.replace('  return', guard + '  return');
  const result = builder.selectivePromptlab(old, local, ['generateSkuBatch'], []);
  assert.equal(result.text, local);
  assert.throws(() => builder.selectivePromptlab(old, local.replace('existingBatch', 'foreignBatch'), ['generateSkuBatch'], []), /Batch changed beyond/);
});
test('HTML transplant inserts only exact reviewed spans and updates promptlab/durable cache references', () => {
  const old = '<link href="promptlab.js?v=old">\n<div id="anchor"></div>\n<script src="studio-runtime-20261010-credit-v3.js?v=retain"></script>\n<script src="sku-durable-receipt.js?v=old"></script>\n<script src="promptlab.js?v=old"></script>\n';
  const inserted = '\n<button id="new">查询</button>';
  const local = old.replace('<div id="anchor"></div>', '<div id="anchor"></div>' + inserted) + '<div>unrelated local drift</div>';
  const result = builder.htmlOverlay(old, local, [{ anchor: '<div id="anchor"></div>', position: 'after', text: inserted, label: 'reviewed control' }], 'v8');
  assert.ok(result.text.includes(inserted));
  assert.ok(result.text.includes('studio-runtime-20261010-credit-v3.js?v=retain'));
  assert.equal(result.text.includes('unrelated local drift'), false);
  assert.equal((result.text.match(/\?v=v8/g) || []).length, 3);
  replay(old, result.text, result.proof);
});
test('HTML transplant rejects duplicated/absent anchors and cache references', () => {
  assert.throws(() => builder.htmlOverlay('anchor anchor', 'inserted', [{ anchor: 'anchor', position: 'after', text: 'inserted', label: 'duplicate' }], 'v8'), /ambiguous/);
  assert.throws(() => builder.htmlOverlay('anchor', 'inserted inserted', [{ anchor: 'anchor', position: 'after', text: 'inserted', label: 'duplicate source' }], 'v8'), /ambiguous/);
  assert.throws(() => builder.htmlOverlay('', '', [], 'v8'), /cache references/);
  assert.throws(() => builder.htmlOverlay('', '', [], '../bad'), /cachebuster/);
});
test('builder rejects unfrozen inputs or proves the frozen three-write/five-protected candidate', () => {
  if (!builder.SOURCE_PINS) {
    assert.throws(() => builder.build({ reviewOnly: true }), /V8B_SOURCE_FREEZE_REQUIRED/);
    return;
  }
  const review = builder.build({ reviewOnly: true });
  assert.deepEqual(review.manifest.files.map(file => file.file), builder.SCOPE);
  assert.deepEqual(review.manifest.protectedPayloads.map(file => file.file), builder.PROTECTED);
  assert.equal(review.manifest.inventory.length, 8);
  assert.equal(review.manifest.files.some(file => file.newFile), false);
  assert.equal(review.manifest.baseline.installedOverlay, 'production-overlay-v7');
  assert.equal(review.manifest.untouchedStyles.length, 2);
  for (const file of review.manifest.protectedPayloads) {
    assert.equal(file.newSha256, file.baselineSha256);
    assert.equal(review.compiled[file.file], fs.readFileSync(path.join(BASE, 'overlay', file.path), 'utf8'));
  }
  assert.equal(hash(review.compiled['sku-durable-receipt.js']), builder.SOURCE_PINS['sku-durable-receipt.js']);
  for (const [name, proof] of [['promptlab.js', review.audit.promptlab], ['promptlab.html', review.audit.html]])
    replay(fs.readFileSync(path.join(BASE, 'overlay', PREFIX, name), 'utf8'), review.compiled[name], proof);
  assert.ok(review.compiled['promptlab.html'].includes('studio-runtime-20261010-credit-v3.js?v=20261013-sku-durable-v7'));
  const durableReferences = [...review.compiled['promptlab.html'].matchAll(/<script src="sku-durable-receipt\.js\?v=([^"\s]+)"/g)];
  assert.equal(durableReferences.length, 1);
  assert.equal(durableReferences[0][1], '20261013-sku-paid-workspace-v8b');
  const promptlabReferences = [...review.compiled['promptlab.html'].matchAll(/(?:src|href)="promptlab\.js\?v=([^"\s]+)"/g)];
  assert.equal(promptlabReferences.length, 2);
  assert.ok(promptlabReferences.every(reference => reference[1] === '20261013-sku-paid-workspace-v8b'));
});
test('frozen installed-v7 document inputs match their captured pins', () => {
  for (const [name, digest] of Object.entries(builder.V7_PINS))
    assert.equal(hash(fs.readFileSync(path.join(BASE, name))), digest);
});
