'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const mirror = require('../public/creative/labs/image-prompt-lab/aesthetic-mirror-contract.js');
const creative = require('../public/creative/labs/image-prompt-lab/creative-tools-contract.js');
const clone = (value) => JSON.parse(JSON.stringify(value));
const asset = (name) => 'https://fixture.invalid/' + name + '.png';
const output = asset('result');
const image = (name, info = '') => ({ image: asset(name), name, info });
function input(mode = 'single', count = 1) {
  return { mode, references: [image('reference')], products: [image('product-a', '300 毫升'), image('product-b', '500 毫升')], config: { name: '绝不能进入图中的文件标题', requirements: '呈现真实商品', count, ratio: '3:4', resolution: '2K', quality: 'high', speed: 'standard' } };
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
const flush = () => new Promise((done) => setTimeout(done, 0));
function fixture(options = {}, contract = mirror) {
  let account = 'account:alice', receipt = null, serial = 0, archiveFails = false;
  const current = input('sku'), requests = [], archives = [];
  const config = { imageAdapter: 'generic-json', imageModel: 'gpt-image-1', provider: 'configured-provider' };
  const deps = { readInput: () => current, config: () => config, archiveContext: () => ({ accountKey: account, surfaceMode: 'main' }), newJobId: () => 'mirror-job-' + (++serial),
    send: async (type, request) => { requests.push({ type, request: clone(request) }); return { ok: true, images: [output], taskId: 'provider-receipt' }; },
    archive: async (item, owner) => { archives.push({ item: clone(item), owner: clone(owner) }); return archiveFails ? { ok: false, error: 'fixture disk failure' } : { ok: true }; },
    journal: { read: () => clone(receipt), write: (next) => { receipt = clone(next); }, clear: () => { receipt = null; }, compareAndClear: (expected) => { if (!receipt || receipt.jobId !== expected.jobId || receipt.signature !== expected.signature || receipt.shotId !== expected.shotId || receipt.batchId !== expected.batchId) return false; receipt = null; return true; } }, ...options };
  const controller = contract.createController(deps);
  return { current, config, deps, controller, requests, archives, readReceipt: () => clone(receipt), setReceipt: (next) => { receipt = clone(next); }, setAccount: (next) => { account = next; }, failArchive: (next) => { archiveFails = next; } };
}

test('single binds all product evidence to one reference for 1–10 independent outputs', () => {
  const plan = mirror.createPlan(input('single', 10));
  assert.equal(plan.ok, true);
  assert.equal(plan.totalOutputs, 10);
  const payload = mirror.createPayload(plan, plan.shots[9].id);
  assert.deepEqual(payload.productImages, [asset('product-a'), asset('product-b')]);
  assert.deepEqual(payload.referenceImages, [asset('reference')]);
  assert.deepEqual(payload.mirrorPlan.binding.productIndices, [0, 1]);
  assert.equal(payload.count, 1);
  assert.equal(payload.size, '1536*2048');
  assert.equal(mirror.validatePayload(payload).ok, true);
  assert.equal(mirror.createPlan(input('single', 11)).code, 'MIRROR_COUNT_INVALID');
});

test('batch produces reference×group-count, preserving one exact reference per output', () => {
  const data = input('batch', 4); data.references = Array.from({ length: 20 }, (_, index) => image('reference-' + index));
  const plan = mirror.createPlan(data);
  assert.equal(plan.totalOutputs, 80);
  plan.shots.forEach((shot, index) => {
    const payload = mirror.createPayload(plan, shot.id);
    assert.equal(shot.groupIndex, Math.floor(index / 4));
    assert.equal(shot.variationIndex, index % 4);
    assert.deepEqual(payload.referenceImages, [data.references[shot.groupIndex].image]);
    assert.deepEqual(payload.productImages, data.products.map((entry) => entry.image));
    assert.equal(mirror.validatePayload(payload).ok, true);
  });
  assert.equal(mirror.createPlan({ ...data, config: { ...data.config, count: 5 } }).code, 'MIRROR_COUNT_INVALID');
});

test('SKU requests contain only current product and full base; filenames are absent from prompt', () => {
  const plan = mirror.createPlan(input('sku', 4)), payload = mirror.createPayload(plan, plan.shots[4].id);
  assert.deepEqual(payload.productImages, [asset('product-b')]);
  assert.deepEqual(payload.mirrorPlan.images.products, [image('product-b', '500 毫升')]);
  assert.equal(JSON.stringify(payload).includes(asset('product-a')), false);
  assert.deepEqual(payload.mirrorPlan.binding.productIndices, [1]);
  assert.equal(payload.prompt.includes('500 毫升'), true);
  assert.equal(payload.prompt.includes('300 毫升'), false);
  assert.equal(payload.prompt.includes('绝不能进入图中的文件标题'), false);
  assert.match(payload.prompt, /完整保留底图的背景、画布、布局、构图/);
  assert.match(payload.prompt, /不得裁剪、重新设计、删除或重写底图文字/);
  assert.match(payload.prompt, /绝不能作为图片标题/);
  assert.equal(mirror.validatePayload(payload).ok, true);
});

test('input limits match each mode and reject malformed or untrusted image URLs', () => {
  for (const mode of ['single', 'batch', 'sku']) {
    const data = input(mode);
    assert.equal(mirror.createPlan({ ...data, references: [] }).code, 'MIRROR_REFERENCE_COUNT');
    assert.equal(mirror.createPlan({ ...data, products: [] }).code, 'MIRROR_PRODUCT_COUNT');
    assert.equal(mirror.createPlan({ ...data, products: [{ image: 'http://fixture.invalid/product.png' }] }).code, 'MIRROR_IMAGE_INVALID');
    assert.equal(mirror.createPlan({ ...data, products: [{ image: 'https://user:secret@fixture.invalid/product.png' }] }).code, 'MIRROR_IMAGE_INVALID');
    assert.equal(mirror.createPlan({ ...data, products: [{ image: 'data:image/svg+xml;base64,PHN2Zz4=' }] }).code, 'MIRROR_IMAGE_INVALID');
  }
  assert.equal(mirror.createPlan({ ...input(), references: [image('a'), image('b')] }).code, 'MIRROR_REFERENCE_COUNT');
  assert.equal(mirror.createPlan({ ...input(), products: Array.from({ length: 7 }, (_, index) => image('p' + index)) }).code, 'MIRROR_PRODUCT_COUNT');
  const sku = { ...input('sku', 4), products: Array.from({ length: 20 }, (_, index) => image('p' + index)) };
  assert.equal(mirror.createPlan(sku).totalOutputs, 80);
  assert.equal(mirror.createPlan({ ...sku, products: sku.products.concat(image('p20')) }).code, 'MIRROR_PRODUCT_COUNT');
});

test('canonical validation rejects attachment/parameter/cross-route tampering and rebuilds prompt', () => {
  const plan = mirror.createPlan(input('sku')), payload = mirror.createPayload(plan, plan.shots[0].id);
  for (const update of [{ productImages: [asset('other')] }, { referenceImages: [asset('other-ref')] }, { visualTemplateImages: [] }, { count: 2 }, { resolution: '4K' }, { ratio: '1:1' }, { speed: 'fast' }, { size: '999*999' }, { productImageEvidence: [] }]) assert.equal(mirror.validatePayload({ ...payload, ...update }).code, 'MIRROR_PAYLOAD_MISMATCH');
  assert.equal(mirror.validatePayload({ ...payload, referenceMode: 'creative-tools' }).code, 'MIRROR_ROUTE_INVALID');
  assert.equal(mirror.validatePayload({ ...payload, creativeContractVersion: 'CREATIVE_TOOLS_V1' }).code, 'MIRROR_ROUTE_MIXED');
  assert.equal(mirror.validatePayload({ ...payload, guideContract: { id: 'foreign' } }).code, 'MIRROR_ROUTE_MIXED');
  assert.equal(mirror.validatePayload({ ...payload, prompt: 'discard base and other binding' }).payload.prompt, payload.prompt);
  const tampered = clone(payload); tampered.mirrorPlan.shot.productIndices = [1];
  assert.equal(mirror.validatePayload(tampered).code, 'MIRROR_PAYLOAD_INVALID');
  const changed = clone(plan); changed.shots[0].referenceIndex = 1;
  assert.equal(mirror.verifyPlan(changed).code, 'MIRROR_PLAN_STALE');
});

test('editable per-output prompt stays saved without removing mandatory identity and base rules', () => {
  const original = mirror.createPlan(input('sku'));
  const edited = mirror.editShot(original, original.shots[0].id, { label: '业务名称', prompt: '突出瓶身质感' });
  assert.equal(mirror.verifyPlan(edited).ok, true);
  const payload = mirror.createPayload(edited, edited.shots[0].id);
  assert.match(payload.prompt, /突出瓶身质感/);
  assert.match(payload.prompt, /严格 SKU 主体替换/);
  assert.equal(original.shots[0].prompt, '');
});

test('mirror controller uses frozen exact payload and archives real configured model under original account', async () => {
  const f = fixture(); assert.equal(f.controller.buildPlan().ok, true);
  const result = await f.controller.generate();
  assert.equal(result.ok, true);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests.map(({ request }) => request.payload.productImages), [[asset('product-a')], [asset('product-b')]]);
  assert.equal(f.archives.length, 2);
  for (const archive of f.archives) {
    assert.equal(archive.owner.accountKey, 'account:alice');
    assert.equal(archive.item.mirrorContractVersion, mirror.version);
    assert.equal(archive.item.generationRoute, mirror.route);
    assert.equal(archive.item.model, 'gpt-image-1');
    assert.equal(archive.item.creativeContractVersion, undefined);
    assert.equal(archive.item.mirrorPlanSnapshot.version, mirror.version);
  }
  await f.controller.generate(); assert.equal(f.requests.length, 2);
  assert.equal(f.readReceipt(), null);
  assert.equal(f.controller.getTaskState().completedCount, 2);
});

test('reviewed input/account changes and journal write failure prevent provider submission', async () => {
  const stale = fixture(); stale.controller.buildPlan(); stale.current.products[0].info = 'changed';
  assert.equal((await stale.controller.generate()).ok, false); assert.equal(stale.requests.length, 0);
  const account = fixture(); account.controller.buildPlan(); account.setAccount('account:bob');
  assert.equal((await account.controller.generate()).code, 'CREATIVE_ACCOUNT_CHANGED'); assert.equal(account.requests.length, 0);
  const journal = fixture({ journal: { read: () => null, clear() {}, write() { throw new Error('quota'); } } }); journal.controller.buildPlan();
  await journal.controller.generate(); assert.equal(journal.requests.length, 0);
  const switched = fixture(); switched.controller.buildPlan(); const write = switched.deps.journal.write;
  switched.deps.journal.write = (receipt) => { write(receipt); switched.setAccount('account:bob'); };
  await switched.controller.generate(); assert.equal(switched.requests.length, 0); assert.equal(switched.readReceipt(), null);
});

test('archive retry saves existing successful image and never generates another charged image', async () => {
  const f = fixture(); f.failArchive(true); f.controller.buildPlan(); await f.controller.generate();
  assert.equal(f.controller.state.slots[0].archiveOk, false);
  assert.equal((await f.controller.retryShot(f.controller.state.slots[0].shot.id)).code, 'CREATIVE_ARCHIVE_PENDING');
  const sent = f.requests.length; f.failArchive(false);
  assert.equal((await f.controller.retryArchive(f.controller.state.slots[0])).ok, true);
  assert.equal(f.requests.length, sent);
});

test('timeout remains pending and late success retains original owner and receipt identity', async () => {
  const late = deferred(), f = fixture({ timeoutMs: 5, send: async () => late.promise });
  f.controller.buildPlan(); const originalShot = f.controller.state.slots[0].shot.id;
  assert.equal((await f.controller.generate()).uncertain, true);
  const receipt = f.readReceipt(); assert.equal(receipt.shotId, originalShot);
  const task = f.controller.getTaskState(); assert.equal(task.activeCount, 0); assert.equal(task.pendingCount, 1); assert.equal(task.jobId, receipt.jobId);
  assert.equal((await f.controller.generate()).ok, false);
  f.setAccount('account:bob'); late.resolve({ ok: true, images: [output] }); await flush(); await flush();
  assert.equal(f.archives.length, 1); assert.equal(f.archives[0].owner.accountKey, 'account:alice');
  assert.equal(f.archives[0].item.jobId, receipt.jobId); assert.equal(f.archives[0].item.mirrorShotId, originalShot);
  assert.equal(f.archives[0].item.batchId, receipt.batchId);
  assert.equal(f.controller.state.slots[0].status, 'done'); assert.equal(f.controller.state.slots[1].status, 'ready');
  assert.equal(f.controller.state.uncertain, null); assert.equal(f.readReceipt(), null);
});

test('late success cannot erase another job receipt or overwrite replacement plan slots', async () => {
  const late = deferred(), f = fixture({ timeoutMs: 5, send: async () => late.promise });
  f.controller.buildPlan(); await f.controller.generate(); const oldReceipt = f.readReceipt();
  f.current.config.name = '下一批'; f.current.config.requirements = '新批次'; f.controller.buildPlan();
  const replacementSlot = f.controller.state.slots[0];
  const foreign = { ...oldReceipt, jobId: 'other-job', batchId: 'other-batch', signature: 'other-signature' }; f.setReceipt(foreign);
  late.resolve({ ok: true, images: [output] }); await flush(); await flush();
  assert.equal(f.readReceipt().jobId, 'other-job'); assert.equal(f.controller.state.uncertain.jobId, 'other-job');
  assert.equal(replacementSlot.item, null); assert.equal(f.controller.state.previousResults.length, 1);
  assert.equal(f.controller.state.previousResults[0].item.jobId, oldReceipt.jobId);
  assert.equal(f.archives[0].item.batchId, oldReceipt.batchId);
  assert.equal(f.archives[0].owner.accountKey, 'account:alice');
  assert.equal(f.archives[0].item.productName, 'product-a');
  assert.equal(f.controller.state.previousResults[0].item.batchId, oldReceipt.batchId);
  assert.equal(f.controller.snapshot().previousResults[0].item.batchId, oldReceipt.batchId);
  assert.equal(f.controller.snapshot().previousResults[0].archiveContext.accountKey, 'account:alice');
});

test('definitive mirror failure can retry only failed output while keeping successful results', async () => {
  let calls = 0; const f = fixture({ send: async () => ++calls === 2 ? { ok: false, code: 'MIRROR_PAYLOAD_MISMATCH', error: 'blocked' } : { ok: true, images: [output] } });
  f.controller.buildPlan(); await f.controller.generate();
  assert.equal(f.controller.state.slots[0].status, 'done'); assert.equal(f.controller.state.slots[1].status, 'failed');
  assert.equal(f.readReceipt(), null); await f.controller.retryFailed();
  assert.equal(calls, 3); assert.equal(f.controller.state.slots[0].item.jobId, 'mirror-job-1');
});

test('generic creative controller remains on its existing default route and snapshot fields', async () => {
  const requests = [], archives = [];
  const controller = creative.createController({ readInput: () => ({ tool: 'buyer', products: [asset('own')], config: { count: 1 } }), config: () => ({ imageModel: 'fixture-model' }), archiveContext: () => ({ accountKey: 'fixture-owner' }), send: async (_, message) => { requests.push(message); return { ok: true, images: [output] }; }, archive: async (item) => { archives.push(item); return { ok: true }; } });
  assert.equal(controller.buildPlan().ok, true); assert.equal((await controller.generate()).ok, true);
  assert.equal(requests[0].payload.generationRoute, 'creative-tools');
  assert.equal(archives[0].creativeContractVersion, creative.version); assert.equal(archives[0].creativePlanSnapshot.tool, 'buyer');
});


test('explicit receipt resolution refuses to clear a newer receipt from another controller', async () => {
  const late = deferred(), f = fixture({ timeoutMs: 5, send: async () => late.promise });
  f.controller.buildPlan(); await f.controller.generate(); const first = f.readReceipt();
  const newer = { ...first, jobId: 'newer-job', signature: 'newer-signature' }; f.setReceipt(newer);
  assert.equal(f.controller.resolveUncertain({ confirmed: true }).code, 'CREATIVE_RECEIPT_CHANGED');
  assert.equal(f.readReceipt().jobId, 'newer-job'); assert.equal(f.controller.state.uncertain.jobId, 'newer-job');
  late.resolve({ ok: false, definitiveFailure: true }); await flush();
});

test('same-turn timeout and late success wait for archive and never revert the success to uncertain', async () => {
  const { readFileSync } = require('node:fs'), { createContext, runInContext } = require('node:vm');
  const timers = [], context = createContext({ URL, setTimeout: (callback) => { timers.push(callback); return timers.length; }, clearTimeout() {} });
  for (const file of ['creative-tools-contract.js', 'aesthetic-mirror-contract.js']) runInContext(readFileSync(require('node:path').resolve(__dirname, '../public/creative/labs/image-prompt-lab', file), 'utf8'), context, { filename: file });
  const provider = deferred(), archive = deferred(), f = fixture({ send: async () => provider.promise, archive: async (item, owner) => { f.archives.push({ item: clone(item), owner: clone(owner) }); return archive.promise; } }, context.SZ_AESTHETIC_MIRROR_CONTRACT);
  f.controller.buildPlan(); let settled = false; const run = f.controller.generate().then((result) => { settled = true; return result; });
  await flush(); assert.equal(timers.length, 1);
  timers[0](); provider.resolve({ ok: true, images: [output] }); await flush();
  assert.equal(f.controller.state.slots[0].status, 'done'); assert.equal(settled, false); assert.equal(f.archives.length, 1);
  archive.resolve({ ok: true }); const result = await run;
  assert.equal(result.uncertain, false); assert.equal(f.controller.state.slots[0].status, 'done');
  assert.equal(f.controller.state.slots[1].status, 'ready'); assert.equal(f.readReceipt(), null);
});

test('budget counts encoded generic provider fields with UTF-8 prompt and reserves metadata at exact boundary', () => {
  const base = { productImages: [''], referenceImages: [''], prompt: '中文😀', negativePrompt: '' };
  const overhead = mirror.payloadBytes(base), additional = Math.floor((mirror.maxRequestBytes - overhead) / 2);
  const boundary = { ...base, productImages: ['A'.repeat(additional)] };
  assert.equal(mirror.payloadBytes(boundary), overhead + 2 * additional);
  assert.equal(mirror.checkPayloadBudget(boundary).ok, true);
  assert.equal(mirror.checkPayloadBudget({ ...boundary, productImages: [boundary.productImages[0] + 'A'] }).code, 'MIRROR_IMAGE_BUDGET');
  const body = { prompt: base.prompt, negative_prompt: '', reference_image: '', reference_images: [''], product_image: '', product_images: [''] };
  assert.equal(overhead, Buffer.byteLength(JSON.stringify(body)) + 64 * 1024);
});

test('oversized source remains draft and fails before receipt or provider call', async () => {
  const f = fixture(); f.current.products = [{ image: 'data:image/png;base64,' + 'A'.repeat(13 * 1024 * 1024), name: 'oversized original', info: '' }];
  const plan = f.controller.buildPlan(); assert.equal(plan.ok, true);
  assert.throws(() => mirror.createPayload(plan, plan.shots[0].id), (error) => error.code === 'MIRROR_IMAGE_BUDGET');
  const result = await f.controller.generate(); assert.equal(result.code, 'MIRROR_IMAGE_BUDGET');
  assert.equal(f.requests.length, 0); assert.equal(f.readReceipt(), null);
  assert.equal(f.controller.state.plan.images.products[0].image, f.current.products[0].image);
});

test('mirror invalidation moves successful results to preserved history and cannot drop a pending receipt slot', async () => {
  const completed = fixture(); completed.controller.buildPlan(); await completed.controller.generate();
  assert.equal(completed.controller.invalidate(), true);
  assert.equal(completed.controller.state.plan, null); assert.equal(completed.controller.state.slots.length, 0);
  assert.equal(completed.controller.state.previousResults.length, 2);
  const late = deferred(), pending = fixture({ timeoutMs: 5, send: async () => late.promise }); pending.controller.buildPlan(); await pending.controller.generate();
  const shotId = pending.controller.state.slots[0].shot.id; pending.controller.invalidate();
  assert.equal(pending.controller.state.slots[0].shot.id, shotId); assert.equal(pending.readReceipt().shotId, shotId);
  late.resolve({ ok: true, images: [output] }); await flush(); await flush();
  assert.equal(pending.controller.state.slots[0].status, 'done'); assert.equal(pending.archives.length, 1);
});

test('restore refuses mismatched saved slot identity and preserves the saved draft without mutating controller', () => {
  const f = fixture(); f.controller.buildPlan(); const saved = f.controller.snapshot();
  const target = fixture(); saved.slots[0].shot.productIndices = [1];
  const originalDraft = JSON.stringify(saved);
  assert.equal(target.controller.restore(saved).code, 'MIRROR_RESTORE_BINDING_INVALID');
  assert.equal(target.controller.state.plan, null); assert.equal(target.controller.state.slots.length, 0);
  assert.equal(JSON.stringify(saved), originalDraft); assert.equal(target.requests.length, 0);
});

test('restore accepts canonically edited slot label and prompt plus retained historical results', async () => {
  const f = fixture(); f.controller.buildPlan(); f.controller.editShot(f.controller.state.slots[0].shot.id, { label: '已编辑名称', prompt: '真实材质' });
  await f.controller.generate(); const saved = f.controller.snapshot(), reopened = fixture();
  assert.equal(reopened.controller.restore(saved).ok, true);
  assert.equal(reopened.controller.state.slots[0].shot.label, '已编辑名称');
  assert.equal(reopened.controller.state.slots[0].item.mirrorPlanSnapshot.shot.prompt, '真实材质');
  assert.equal(reopened.requests.length, 0);
});
