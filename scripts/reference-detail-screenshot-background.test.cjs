'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../public/creative');
const CAPTURED_AT = '2026-10-12T02:00:00.000Z';
const clone = value => JSON.parse(JSON.stringify(value));
const directions = ['展示主体的完整轮廓与画面重心', '呈现局部结构与视觉层次', '安排场景中的主体位置关系', '组织使用动作与镜头衔接', '收束整体画面与留白节奏'];
const config = {
  provider: 'openai-compatible', imageAdapter: 'generic-json', apiKey: 'test-only',
  visionModel: 'fixture-vision', textModel: 'fixture-vision', imageModel: 'fixture-image',
  visionBaseUrl: 'https://provider.test/v1', imageEndpoint: 'https://provider.test/v1/images/generations'
};

function png(marker = 1) {
  const bytes = Buffer.alloc(32);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(750, 16); bytes.writeUInt32BE(1000, 20); bytes[26] = marker;
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

function background() {
  const state = {}, requests = [], listeners = [];
  const event = () => ({ addListener() {} });
  const chrome = {
    runtime: { lastError: null, getManifest: () => ({}), getURL: value => `chrome-extension://test/${value}`, onInstalled: event(),
      onMessage: { addListener(listener) { listeners.push(listener); } } },
    storage: { local: {
      get(keys, callback) {
        const result = {}; const list = keys == null ? Object.keys(state) : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        for (const key of list) if (Object.hasOwn(state, key)) result[key] = clone(state[key]);
        callback(vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(result))})`, context));
      },
      set(values, callback) { Object.assign(state, clone(values)); callback?.(); },
      remove(keys, callback) { for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key]; callback?.(); }
    } },
    contextMenus: { removeAll(callback) { callback(); }, create() {}, onClicked: event() },
    action: { onClicked: event() }, tabs: { create() {}, sendMessage() {} }, scripting: { executeScript() {} }, downloads: { download() {} }
  };
  const context = vm.createContext({ chrome, URL, URLSearchParams, Date, Promise, AbortController, Blob, FormData, Response,
    Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, setTimeout, clearTimeout, console,
    __SZ_PROMPTLAB_BACKGROUND_TEST_MODE__: true, btoa, atob,
    authCheck: async () => ({ ok: true, user: { id: 'offline:alice' } }),
    fetch: async (url, options = {}) => {
      if (String(url).startsWith('data:image/')) return new Response(Buffer.from(String(url).split(',')[1], 'base64'), { headers: { 'Content-Type': 'image/png' } });
      const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
      requests.push({ url: String(url), body });
      if (/images\/generations$/.test(String(url))) return Response.json({ data: [{ url: png(99) }] });
      const prompt = JSON.stringify(body?.messages || []);
      const data = prompt.includes('CLAIM_MODE=visual_structure_only')
        ? { '详情页方向': '保持主体一致并学习视觉结构', '详情文案逻辑': '文案留空只表达视觉结构', '生图逻辑': '按独立画面呈现', '中文详情提示词': '只输出当前主体的视觉结构', '负面提示词': '避免文字和画面错乱',
          '屏幕规划': directions.map((direction, index) => ({ '屏幕': index + 1, '名称': direction, '承接关系': '按结构顺序承接', '主体图使用': '保持当前主体一致', '模特使用': '', '画面方向': direction, '文案方向': '', '生图提示词': direction + '，保持当前绑定主体外观一致' })) }
        : { modules: [], warnings: [] };
      return Response.json({ choices: [{ message: { content: JSON.stringify(data) } }] });
    }
  });
  for (const file of ['src/reference-detail-contract.js', 'labs/image-prompt-lab/reference-detail-blueprint.js', 'labs/image-prompt-lab/reference-detail-batch.js',
    'labs/image-prompt-lab/viral-series-contract.js', 'labs/image-prompt-lab/style-refresh-contract.js', 'labs/image-prompt-lab/background.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  }
  // Make fixtures in the contract's realm, matching actual JSON message decoding.
  const inRealm = value => vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`, context);
  const send = message => new Promise(resolve => {
    for (const listener of listeners) {
      const active = listener(inRealm(message), {}, resolve);
      if (active === true) return;
    }
  });
  const stateView = new Proxy(state, { get(target, key) {
    if (Object.hasOwn(target, key)) return target[key];
    const ownedKey = Object.keys(target).find(name => name.startsWith('sz_reference_detail_screenshot_owned_v1:default:offline%3Aalice:') && name.endsWith(':' + String(key)));
    const envelope = ownedKey && target[ownedKey];
    return envelope && envelope.schema === 'REFERENCE_DETAIL_SCREENSHOT_OWNED_RECORD_V1' && envelope.ownerAccountKey === 'offline:alice' ? envelope.value : undefined;
  } });
  return { api: context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__, contract: context.SZ_REFERENCE_DETAIL_CONTRACT,
    core: context.SZ_REFERENCE_DETAIL_BATCH, state: stateView, rawState: state, requests, send, inRealm,
    source(count = 5) { return context.SZ_REFERENCE_DETAIL_CONTRACT.createScreenshotSource(inRealm(Array.from({ length: count }, (_, index) => ({ url: png(index + 1), width: 750, height: 1000 }))), inRealm({ capturedAt: CAPTURED_AT })); } };
}

async function approved(h) {
  const source = h.source();
  const raw = h.contract.createBlueprintFromSnapshot(source, h.inRealm({ createdAt: CAPTURED_AT }));
  const changed = h.contract.reviseBlueprint(raw, h.inRealm({ moduleEdits: raw.modules.map((module, index) => ({ moduleId: module.moduleId, visualBrief: { ...clone(module.visualBrief), description: directions[index] } })) }), h.inRealm({ sourceSnapshot: source, updatedAt: CAPTURED_AT }));
  const draft = h.contract.projectVisualStructureBlueprint(changed, source, h.inRealm({ previousBlueprint: raw, createdAt: CAPTURED_AT }));
  const base = { detailMode: 'reference', claimMode: 'visual_structure_only', source, sourceDigest: source.snapshotId, blueprintId: draft.blueprintId };
  const saved = await h.api.saveReferenceDetailBlueprint(h.inRealm({ ...base, currentBlueprint: draft, immediatePreviousBlueprint: null }));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const unapproved = await h.api.getReferenceDetailExecutionBundle(h.inRealm(base));
  assert.equal(unapproved.code, 'blueprint_not_approved');
  const trusted = await h.api.verifyReferenceDetailTrust(h.inRealm({ detailMode: 'reference', claimMode: 'visual_structure_only', blueprintId: draft.blueprintId,
    sourceDigest: source.snapshotId, blueprintRevision: draft.revision, targetAssetClaims: [{ assetId: 'owned-product', ref: png(50), role: 'subject' }], attestations: { assetRightsConfirmed: true } }));
  assert.equal(trusted.ok, true, JSON.stringify(trusted));
  const blueprint = h.contract.approveVisualStructureBlueprint(draft, source, h.inRealm({ approvedAt: trusted.verifiedAt, verificationId: trusted.approvalVerificationId }), h.inRealm({ verifiedTargetAssets: trusted.verifiedTargetAssets }));
  const approvalSaved = await h.api.saveReferenceDetailBlueprint(h.inRealm({ ...base, currentBlueprint: blueprint, immediatePreviousBlueprint: draft }));
  assert.equal(approvalSaved.ok, true, JSON.stringify(approvalSaved));
  const result = await h.api.getReferenceDetailExecutionBundle(h.inRealm(base));
  assert.equal(result.ok, true, JSON.stringify(result));
  return { source, base, draft, blueprint, bundle: result.executionBundle };
}

test('ordered screenshots enter BUILD as reference-only images with honest source metadata', async () => {
  const h = background(), source = h.source(3);
  const checked = h.api.referenceDetailValidatedSource(h.inRealm({ detailMode: 'reference', source, targetScreenCount: 5 }));
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.equal(checked.snapshot.schema, 'REFERENCE_DETAIL_SCREENSHOT_SOURCE_V1');
  assert.equal(checked.filterReport.sourceKind, 'screenshots');
  assert.deepEqual(clone(checked.snapshot.facts), []);
  assert.deepEqual(clone(checked.snapshot.source), { sourceMode: 'screenshots', capturedAt: CAPTURED_AT });
  const chunk = h.api.referenceDetailChunks(checked.snapshot)[0];
  assert.deepEqual(clone(h.api.referenceDetailChunkImages(checked.snapshot, chunk)), [png(1), png(2), png(3)]);
  const prepared = await h.api.referenceDetailPrepareChunkMessages(checked.snapshot, chunk, [], new AbortController().signal, {});
  assert.equal(prepared.ok, true);
  const text = prepared.messages[1].content[0].text;
  assert.match(text, /按用户顺序导入的参考详情截图/);
  assert.match(text, /不代表已采集商品 URL 或完整详情页/);
  const built = await h.send({ type: 'BUILD_REFERENCE_DETAIL_BLUEPRINT', jobId: 'screenshot-build', config, payload: { detailMode: 'reference', source, targetScreenCount: 5 } });
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.ok(h.requests.some(request => JSON.stringify(request.body).includes(png(1))));
});

test('legacy upload aliases and upload_fallback cannot impersonate screenshots', async () => {
  const h = background(), source = h.source(1);
  for (const payload of [{ source: { ...clone(source), source: { sourceMode: 'upload_fallback' } } }, { source, referenceImages: [png(1)] },
    { source: { ...clone(source), images: [png(1)] } }, { source: { ...clone(source), extra: { referenceImage: png(1) } } }]) {
    const result = await h.send({ type: 'BUILD_REFERENCE_DETAIL_BLUEPRINT', jobId: 'legacy-build', config, payload });
    assert.equal(result.ok, false);
    assert.ok(['LEGACY_REFERENCE_UPLOAD_REMOVED', 'FORMAL_SOURCE_REQUIRED', 'source_contract_invalid'].includes(result.code));
  }
  assert.equal(h.requests.length, 0);
});

test('screenshots persist through explicit target trust, approval and execution bundle', async () => {
  const h = background(), fixture = await approved(h);
  assert.equal(fixture.bundle.sourceSnapshot.schema, 'REFERENCE_DETAIL_SCREENSHOT_SOURCE_V1');
  assert.equal(fixture.bundle.claimMode, 'visual_structure_only');
  assert.deepEqual(clone(fixture.bundle.verifiedTargetAssets.map(asset => asset.assetId)), ['owned-product']);
  assert.equal(fixture.bundle.assetsById['owned-product'].ref, png(50));
  const loaded = await h.api.loadReferenceDetailBlueprint(h.inRealm(fixture.base));
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.currentBlueprint.approvalStatus, 'approved');
  assert.equal(h.requests.length, 0);
  const stale = await h.api.getReferenceDetailExecutionBundle(h.inRealm({ ...fixture.base, source: h.source(1) }));
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'source_digest_mismatch');
});

test('registered screenshot learning executes against owned material and prevents duplicate image dispatch', async () => {
  const h = background(), fixture = await approved(h);
  const liveConfig = h.api.normalizeCfg(h.inRealm(config));
  const settings = h.core.safeGenerationSettings(h.inRealm({ ...clone(liveConfig), ratio: '3:4', resolution: '2K', size: '1536*2048', screenCount: 5 }));
  const rows = [h.core.normalizeDraftTarget(h.inRealm({ draftTargetId: 'target-one', targetInputId: 'input-one', taskKey: 'task-one', subjectAssetIds: ['owned-product'], modelAssetIds: [], skuIds: [] }))];
  const batch = h.core.createBatchContext(h.inRealm(fixture.bundle), h.inRealm(rows), h.inRealm({ generationSettings: settings, screenCount: 5, createdAt: CAPTURED_AT }));
  const registered = await h.send({ type: 'REGISTER_REFERENCE_DETAIL_BATCH', payload: { detailMode: 'reference', claimMode: 'visual_structure_only',
    blueprintId: fixture.blueprint.blueprintId, batch: batch.batch, runtime: batch.runtime, rows, generationSettings: settings, archiveAccountKey: 'account-alice' } });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const accountMismatch = await h.send({ type: 'REGISTER_REFERENCE_DETAIL_BATCH', payload: { detailMode: 'reference', claimMode: 'visual_structure_only',
    blueprintId: fixture.blueprint.blueprintId, batch: batch.batch, runtime: batch.runtime, rows, generationSettings: settings, archiveAccountKey: 'account-bob' } });
  assert.equal(accountMismatch.code, 'batch_archive_account_mismatch');
  const task = batch.runtime.tasks[0];
  const projection = h.core.getTaskProjection(batch, task.taskId);
  const replica = h.core.getTaskReplicaPlan(batch, task.taskId);
  async function saveRuntime(runtime) {
    const synced = h.core.syncContractBatch(batch.batch, runtime, h.inRealm(fixture.bundle), h.inRealm({ updatedAt: runtime.updatedAt }));
    const saved = await h.api.saveReferenceDetailBatchRuntime(h.inRealm({ detailMode: 'reference', record: { schema: 'REFERENCE_DETAIL_BATCH_RUNTIME_V1', schemaVersion: 1,
      batchId: batch.batch.batchId, blueprintId: fixture.blueprint.blueprintId, blueprintRevision: fixture.blueprint.revision, confirmationFingerprint: batch.confirmationFingerprint,
      batch: synced, rows, runtime, generationSettings: settings, archiveAccountKey: 'account-alice',
      archiveAuthorityRevision: h.state[h.api.referenceDetailBatchRuntimeStorageKey(batch.batch.batchId)].archiveAuthorityRevision, savedAt: runtime.updatedAt } }));
    assert.equal(saved.ok, true, JSON.stringify(saved));
  }
  function marker(request) {
    return { schema: 'REFERENCE_DETAIL_BATCH_MARKER_V2', schemaVersion: 2, claimMode: 'visual_structure_only', ...clone(request),
      blueprintId: fixture.blueprint.blueprintId, blueprintRevision: fixture.blueprint.revision, sourceSnapshotId: fixture.source.snapshotId,
      targetInputId: rows[0].targetInputId, draftTargetId: rows[0].draftTargetId, taskKey: task.taskKey,
      subjectAssetIds: ['owned-product'], modelAssetIds: [], skuIds: [], screenCount: 5,
      replicaPlanId: replica.replicaPlanId, referenceScopeId: replica.referenceScopeId, skuScopeId: replica.skuScopeId, reuseMode: replica.reuseMode,
      userIntentDigest: projection.userIntentDigest, targetOptions: { audience: '', language: '', sellingPointAngle: '', modelPrompt: '' } };
  }
  const prompt = h.core.beginPrompting(batch.runtime, task.taskId, h.inRealm({ updatedAt: CAPTURED_AT }));
  await saveRuntime(prompt.runtime);
  const promptPayload = { labMode: 'detail', detailMode: 'reference', mode: 'reference', promptSource: 'reference', claimMode: 'visual_structure_only',
    referenceDetailBatch: marker(prompt.request), _jobId: prompt.request.requestJobId, productImages: [png(50)], ratio: settings.ratio, resolution: settings.resolution };
  const gate = await h.api.validateReferenceDetailBatchPayload(h.inRealm(promptPayload), 'prompt');
  assert.equal(gate.ok, true, JSON.stringify(gate));
  assert.equal(gate.payload.referenceDetailSourceSchema, 'REFERENCE_DETAIL_SCREENSHOT_SOURCE_V1');
  assert.deepEqual(clone(gate.payload.productImages), [png(50)]);
  assert.deepEqual(clone(gate.payload.referenceImages), []);
  assert.doesNotMatch(JSON.stringify(gate.payload.referenceDetailPlan), /data:image/);
  for (const extra of [{ productImages: [png(1)] }, { referenceImages: [png(1)] }, { source: fixture.source }, { referenceDetailSourceSchema: 'REFERENCE_DETAIL_SOURCE_V1' }]) {
    const rejected = await h.api.validateReferenceDetailBatchPayload(h.inRealm({ ...promptPayload, ...extra }), 'prompt');
    assert.equal(rejected.ok, false, JSON.stringify(extra));
  }
  const built = await h.send({ type: 'BUILD_DETAIL_PROMPT', jobId: prompt.request.requestJobId, config: liveConfig, payload: promptPayload });
  assert.equal(built.ok, true, JSON.stringify(built));
  const savedRecord = h.state[h.api.referenceDetailBatchRuntimeStorageKey(batch.batch.batchId)];
  const imageAttempt = h.core.beginScreenAttempt(h.inRealm(savedRecord.runtime), task.taskId, 0, h.inRealm({ updatedAt: CAPTURED_AT }));
  await saveRuntime(imageAttempt.runtime);
  const screen = built.data['屏幕规划'][0];
  const imagePayload = { ...promptPayload, referenceDetailBatch: marker(imageAttempt.request), _jobId: imageAttempt.request.requestJobId,
    prompt: screen['生图提示词'], negativePrompt: built.data['负面提示词'], size: settings.size, count: 1, detailScreenIndex: 1, detailScreenTotal: 5 };
  const result = await h.send({ type: 'GENERATE_IMAGE', jobId: imageAttempt.request.requestJobId, config: liveConfig, payload: imagePayload });
  assert.equal(result.ok, true, JSON.stringify(result));
  const ledger = h.state[h.api.referenceDetailBatchCompletionAuthorityStorageKey(batch.batch.batchId)];
  assert.equal(ledger.schema, 'REFERENCE_DETAIL_COMPLETION_AUTHORITY_LEDGER_V1');
  assert.equal(Object.keys(ledger.authorities).length, 1);
  const recovered = await h.api.loadReferenceDetailBatchRuntime(h.inRealm({ detailMode: 'reference', blueprintId: fixture.blueprint.blueprintId }));
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.completionAuthorityApplied, true);
  assert.equal(recovered.record.runtime.tasks[0].screens[0].status, 'completed');
  assert.deepEqual(clone(recovered.record.runtime.tasks[0].screens[0].resultRef), clone(result.resultRef));
  const imageRequests = h.requests.filter(request => /images\/generations$/.test(request.url));
  assert.equal(imageRequests.length, 1);
  assert.ok(JSON.stringify(imageRequests[0].body).includes(png(50)));
  for (let index = 1; index <= 5; index++) assert.ok(!JSON.stringify(imageRequests[0].body).includes(png(index)));
  const duplicate = await h.send({ type: 'GENERATE_IMAGE', jobId: imageAttempt.request.requestJobId, config: liveConfig, payload: imagePayload });
  assert.equal(duplicate.ok, false);
  assert.equal(h.requests.filter(request => /images\/generations$/.test(request.url)).length, 1);
});
