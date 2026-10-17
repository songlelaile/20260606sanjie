'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, webcrypto, randomUUID } = require('node:crypto');
const ts = require('typescript');
const { build, V4_PINS, SOURCE_PINS, SELECTED, ADDED } = require('./prepare-sku-durable-production-overlay-v5.cjs');
const ROOT = path.resolve(__dirname, '..'), PREFIX = 'public/creative/labs/image-prompt-lab/';
const BASE = path.join(ROOT, 'docs/uat-sku-workflow-20261012/production-overlay-v4');
const RUNTIME = 'studio-runtime-20261010-credit-v3.js';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const review = build({ reviewOnly: true });
function findNode(text, predicate) {
  const parsed = ts.createSourceFile('actual-v5.js', text, ts.ScriptTarget.Latest, true);
  const found = [];
  function visit(node) { if (predicate(node, parsed)) found.push(node); ts.forEachChild(node, visit); }
  visit(parsed);
  assert.equal(found.length, 1);
  return text.slice(found[0].getStart(parsed), found[0].end);
}
function message(text, type) {
  return findNode(text, (node, source) => ts.isIfStatement(node) && node.expression.getText(source) === "msg.type === '" + type + "'");
}
function runtimeHarness() {
  const calls = [];
  const identitySource = findNode(review.compiled[RUNTIME], (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'normalizeImageReceiptIdentity');
  const sandbox = {
    AbortController, TextEncoder, crypto: webcrypto,
    activeJobs: {}, pendingSkuDurableReceipts: {}, pendingReferenceDetailClaims: {}, referenceDetailCancellationTombstones: {},
    referenceDetailMessageSurfacePreflight: (_type, _config, payload) => ({ ok: true, surface: payload.labMode, payload }),
    imagePreSubmissionFailure: (value) => value,
    normalizeCfg: (value) => value, usesPlatformWallet: () => true,
    skuDurableRuntimeSupported: () => true,
    skuDurableRuntimeValidate: async (_msg, _payload, _job) => { calls.push('sku-validate'); return { ok: true, identity: _msg.receiptIdentity }; },
    createImageTask: async (_cfg, payload) => {
      calls.push({ jobId: payload._jobId, identity: sandbox.activeJobs[payload._jobId]?.szImageReceiptIdentity });
      return { ok: true, images: ['data:image/png;base64,eA=='] };
    }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(identitySource + '\n' +
    'this.generate=function(msg,sender,sendResponse){' + message(review.compiled[RUNTIME], 'GENERATE_IMAGE') + '};\n' +
    'this.cancel=function(msg,sender,sendResponse){' + message(review.compiled[RUNTIME], 'CANCEL_GENERATION') + '};\n' +
    'this.capability=function(msg,sender,sendResponse){' + message(review.compiled[RUNTIME], 'GET_SKU_RECEIPT_CAPABILITY') + '};', context);
  return { sandbox, calls, context };
}
function identity(jobId, signature = 'plan-signature') {
  return { version: 1, receiptId: randomUUID(), jobId, accountKey: 'owner', workspaceKey: 'workspace', taskId: 'task',
    shotId: 'shot', batchId: 'batch', planSignatureHash: hash(signature) };
}

test('candidate scope is five writes with eight-file inventory; protected v4 assets stay exact', () => {
  assert.equal(review.manifest.files.length, 5);
  assert.equal(review.manifest.inventory.length, 8);
  assert.deepEqual(review.manifest.protectedPayloads.map((file) => file.file), ['sku-region-ui.js', 'sku-region-ui.css', 'sku-delivery-store.js']);
  for (const file of review.manifest.protectedPayloads) assert.equal(file.baselineSha256, file.newSha256);
  assert.equal(review.manifest.files.at(-1).file, 'sku-durable-receipt.js');
  assert.equal(review.manifest.files.at(-1).baselineSha256, null);
  assert.equal(hash(review.compiled['sku-durable-receipt.js']), SOURCE_PINS['sku-durable-receipt.js']);
});
test('independent audit replay verifies every unedited byte chunk and exact selected globals', () => {
  for (const [name, proof] of [['promptlab.js', review.audit.promptlab], ['background.js', review.audit.background],
    [RUNTIME, review.audit.packedRuntime], ['promptlab.html', review.audit.html]]) {
    const before = fs.readFileSync(path.join(BASE, 'overlay', PREFIX, name), 'utf8'), after = review.compiled[name];
    for (const chunk of proof.chunks) {
      const original = before.slice(chunk.baselineStart, chunk.baselineEnd);
      assert.equal(original, after.slice(chunk.outputStart, chunk.outputEnd));
      assert.equal(hash(original), chunk.sha256);
    }
  }
  assert.equal(review.audit.promptlab.preservedGlobalFunctionCount, 899);
  assert.equal(review.audit.packedRuntime.existingReceiptHelpers.length, 9);
  assert.equal(review.audit.packedRuntime.formalGenesisReceiptRoute.byteIdentical, true);
  assert.deepEqual(review.audit.promptlab.selectedGlobals, SELECTED);
  assert.deepEqual(review.audit.promptlab.addedGlobals, ADDED);
  assert.ok(review.audit.promptlab.excludedLocalFunctionChanges.some((item) => item.name === 'cfgFromForm'));
});
test('packed HTML loads durable after delivery and before promptlab while retaining packed runtime/styles', () => {
  const html = review.compiled['promptlab.html'];
  const delivery = html.indexOf('<script src="sku-delivery-store.js');
  const durable = html.indexOf('<script src="sku-durable-receipt.js');
  const promptlab = html.indexOf('<script src="promptlab.js');
  assert.ok(delivery < durable && durable < promptlab);
  assert.equal((html.match(/<script src="sku-durable-receipt\.js/g) || []).length, 1);
  assert.equal((html.match(/<script src="studio-runtime-20261010-credit-v3\.js/g) || []).length, 1);
  assert.equal(html.includes('<script src="background.js'), false);
  assert.equal(review.audit.existingPackedStylesUnchanged, true);
});
test('actual patched packed handler routes SKU DTO before formalGenesis and hands original identity to image task', async () => {
  const harness = runtimeHarness(), dto = identity('sku-job');
  const response = await new Promise((resolve) => harness.context.generate({ type: 'GENERATE_IMAGE', jobId: dto.jobId, config: {},
    receiptIdentity: dto, payload: { labMode: 'sku', detailMode: 'sku', promptSource: 'sku', skuDurablePlan: {} } }, {}, resolve));
  assert.equal(response.ok, true);
  assert.equal(harness.calls[0], 'sku-validate');
  assert.equal(harness.calls[1].identity.receiptId, dto.receiptId);
  assert.equal(harness.calls[1].identity.jobId, dto.jobId);
});
test('unchanged actual formalGenesis handler accepts existing nine-field DTO without entering SKU validator', async () => {
  const harness = runtimeHarness(), dto = identity('formal-job');
  const response = await new Promise((resolve) => harness.context.generate({ type: 'GENERATE_IMAGE', jobId: dto.jobId, config: {},
    receiptIdentity: dto, payload: { labMode: 'studio-genesis', batchId: 'batch',
      studioGenesisPlan: { shotId: 'shot', plan: { taskId: 'task', signature: 'plan-signature', settings: {} } } } }, {}, resolve));
  assert.equal(response.ok, true);
  assert.equal(harness.calls.includes('sku-validate'), false);
  assert.equal(harness.calls[0].identity.receiptId, dto.receiptId);
});
test('packed capability answers synchronously; pending SKU cancellation preserves claim and performs no task', () => {
  const harness = runtimeHarness();
  let capability, cancelled;
  harness.context.capability({ type: 'GET_SKU_RECEIPT_CAPABILITY' }, {}, (value) => { capability = value; });
  assert.equal(capability.supported, true);
  const claim = harness.sandbox.pendingSkuDurableReceipts['sku-pending'] = { cancelled: false };
  harness.context.cancel({ type: 'CANCEL_GENERATION', jobId: 'sku-pending' }, {}, (value) => { cancelled = value; });
  assert.equal(cancelled.noSubmission, true);
  assert.equal(claim.cancelled, true);
  assert.equal(harness.sandbox.pendingSkuDurableReceipts['sku-pending'], claim);
  assert.equal(harness.calls.length, 0);
});
test('frozen source drift and pre-existing output reject before candidate files are written', () => {
  const temporary = fs.mkdtempSync(path.join(ROOT, 'docs/uat-sku-workflow-20261012/.sku-v5-offline-test-'));
  try {
    const local = path.join(temporary, 'local'), output = path.join(temporary, 'candidate');
    fs.mkdirSync(local);
    for (const name of Object.keys(SOURCE_PINS)) fs.copyFileSync(path.join(ROOT, PREFIX, name), path.join(local, name));
    fs.appendFileSync(path.join(local, 'promptlab.js'), '\n// injected drift\n');
    assert.throws(() => build({ local, output }), /Frozen source SHA mismatch/);
    assert.equal(fs.existsSync(output), false);
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, 'foreign.txt'), 'preserve');
    assert.throws(() => build({ output }), /Output already exists/);
    assert.equal(fs.readFileSync(path.join(output, 'foreign.txt'), 'utf8'), 'preserve');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
test('all installed-v4 document and payload hashes still match frozen evidence after review', () => {
  for (const [name, digest] of Object.entries(V4_PINS)) assert.equal(hash(fs.readFileSync(path.join(BASE, name))), digest);
  const old = JSON.parse(fs.readFileSync(path.join(BASE, 'manifest.json'), 'utf8'));
  for (const file of old.files) assert.equal(hash(fs.readFileSync(path.join(BASE, 'overlay', file.path))), file.newSha256);
});
