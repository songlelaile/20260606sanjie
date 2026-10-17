'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.resolve(__dirname, '..');
const root = process.env.ECOMMERCE_VIDEO_TEST_ROOT || repo;
const moduleDir = path.join(root, 'public/creative/labs/ecommerce-video-studio');
const Contract = require(path.join(moduleDir, 'video-studio-contract.js'));
const clone = value => JSON.parse(JSON.stringify(value));

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.events = new Map();
    this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false;
    this.style = { setProperty() {} };
    this.attributes = new Map(); this.classes = new Set();
    this.classList = { add: value => this.classes.add(value), remove: value => this.classes.delete(value),
      toggle: (value, active) => { if (active) this.classes.add(value); else this.classes.delete(value); }, contains: value => this.classes.has(value) };
  }
  addEventListener(name, fn) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(fn); }
  removeEventListener(name, fn) { this.events.get(name)?.delete(fn); }
  async emit(name, event = {}) { await Promise.all([...this.events.get(name) || []].map(fn => fn({ target: this, preventDefault() {}, ...event }))); }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  appendChild(child) { if (typeof child === 'object') child.parentNode = this; this.children.push(child); return child; }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  removeChild(child) { this.children = this.children.filter(value => value !== child); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this._src = ''; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  closest() { return this.parentNode || new Element(); }
  scrollIntoView() {}
  focus() {}
  load() {}
  get options() { return this.children; }
  get lastChild() { return this.children.at(-1); }
  get parentElement() { return this.parentNode || new Element(); }
}

function harness() {
  const nodes = new Map(), assets = new Map(), drafts = new Map(), saved = [], messages = [], timers = new Set();
  let nextAsset = 0, nextUrl = 0;
  const node = id => { if (!nodes.has(id)) { const item = new Element(); item.id = id; nodes.set(id, item); } return nodes.get(id); };
  const checks = Object.fromEntries(['backend', 'model', 'input', 'rights'].map(key => {
    const item = new Element('li'), symbol = new Element('span');
    item.append(symbol, { nodeType: 3, textContent: '' }); item.querySelector = () => symbol;
    return [key, item];
  }));
  node('readiness-list').querySelector = selector => checks[selector.match(/data-check="(.*?)"/)?.[1]] || null;
  class Media extends Element {
    constructor(tag) { super(tag); this.duration = 14.9; this.videoWidth = 720; this.videoHeight = 1280; }
    set src(value) { this._src = value; if (value) queueMicrotask(() => this.onloadedmetadata?.()); }
    get src() { return this._src; }
    set currentTime(value) { this._time = value; queueMicrotask(() => this.emit('seeked')); }
    get currentTime() { return this._time || 0; }
  }
  const document = {
    readyState: 'loading', getElementById: node, querySelectorAll: () => [], querySelector: () => null, addEventListener() {},
    createElement(tag) {
      if (tag === 'video' || tag === 'audio') return new Media(tag);
      const item = new Element(tag);
      if (tag === 'canvas') { item.getContext = () => ({ drawImage() {} }); item.toBlob = callback => callback(new Blob(['jpeg-frame-fixture'], { type: 'image/jpeg' })); }
      return item;
    }
  };
  const store = {
    DB_NAME: Contract.ASSET_DB_NAME, ASSET_STORE: Contract.ASSET_STORE_NAME,
    async saveAsset(blob, metadata) {
      const record = { ...metadata, id: 'fixture-asset-' + (++nextAsset), size: blob.size, blob };
      assets.set(record.id, record); saved.push(record); return record;
    },
    async getAsset(id) {
      const record = assets.get(id); if (!record) return null;
      const result = vm.runInContext('(' + JSON.stringify({ ...record, blob: undefined }) + ')', context);
      result.blob = record.blob; return result;
    }, async deleteAsset(id) { assets.delete(id); },
    async getDraft(mode) { return drafts.has(mode) ? { data: drafts.get(mode) } : null; },
    async saveDraft(mode, value) { drafts.set(mode, clone(value)); }
  };
  const env = {
    document, Blob, CSS: { escape: value => value }, URL: class extends URL { static createObjectURL() { return 'blob:fixture-' + (++nextUrl); } static revokeObjectURL() {} },
    SZEcommerceVideoStore: store, __SZ_VIDEO_STUDIO_EXPOSE_TESTING__: true,
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); timers.add(timer); return timer; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); }, addEventListener() {},
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage(message, callback) {
      messages.push(clone(message));
      assert.equal(message.type, 'VIDEO_STUDIO_ANALYZE', 'fixtures prohibit generation, billing, and every non-analysis operation');
      callback({ ok: true, payload: { script: '仅展示自有商品及细节。', storyboard: [{ id: 'shot-1', visual: '自有商品近景', durationSeconds: 15 }] } });
    } } },
    fetch() { throw new Error('Network access is forbidden in reference role regression tests'); }
  };
  const context = vm.createContext(env);
  vm.runInContext(fs.readFileSync(path.join(moduleDir, 'video-studio-contract.js'), 'utf8'), context);
  const productionFile = fs.existsSync(path.join(moduleDir, 'video-production.js'))
    ? path.join(moduleDir, 'video-production.js') : path.join(repo, 'public/creative/labs/ecommerce-video-studio/video-production.js');
  vm.runInContext(fs.readFileSync(productionFile, 'utf8'), context);
  let source = fs.readFileSync(path.join(moduleDir, 'video-studio.js'), 'utf8');
  // Expose existing closure functions only inside this isolated test VM; shipping code gains no API.
  source = source.replace('safeRemoteAssetUrl: safeRemoteAssetUrl,', 'bindEvents: bindEvents, baseChecks: baseChecks, confirmRights: confirmRights, analyzeDraft: analyzeDraft, previewProductionPlan: previewProductionPlan, safeRemoteAssetUrl: safeRemoteAssetUrl,');
  vm.runInContext(source, context);
  const api = context.SZEcommerceVideoStudioTesting;
  api.cacheDom(); api.bindEvents();
  const patch = value => vm.runInContext('Object.assign(SZEcommerceVideoStudioTesting.state, ' + JSON.stringify(value) + ')', context);
  patch({ mode: 'remix', prompt: '用自有商品复刻参考视频的镜头结构。', backendConnected: true, analysisAvailable: true,
    legacySingle: false, productionOptions: { mode: 'economic', totalDurationSeconds: 15, hybridAiSeconds: 5, budgetYuan: 50, maxAttempts: 1, budgetProductKey: 'seedance-2.0-mini' },
    settings: { productKey: 'seedance-2.0', creativeRoute: 'reference_rebuild', styleProfile: 'commerce_studio', durationSeconds: 15, resolution: '480p', ratio: '9:16', audioMode: 'silent', narrationLanguage: '' } });
  for (const model of api.state.modelCatalog) model.configured = true;
  return { api, node, saved, messages, drafts, assets, patch, checks,
    dispose() { for (const timer of timers) clearTimeout(timer); },
    fixture(value) { return vm.runInContext('(' + JSON.stringify(value) + ')', context); } };
}

function image(id = 'own-product') {
  return { id, kind: 'image', role: 'product', name: id + '.png', mimeType: 'image/png', width: 720, height: 1280, durationSec: 0,
    storageRef: { dbName: Contract.ASSET_DB_NAME, storeName: Contract.ASSET_STORE_NAME, id }, previewUrl: 'blob:' + id };
}
function fillReference(h, { legacy = false, count = 5 } = {}) {
  const reference = { ...image('authorized-reference'), kind: 'video', mimeType: 'video/mp4', name: 'reference.mp4', durationSec: 14.9, role: legacy ? 'reference' : 'asset' };
  const frames = Array.from({ length: count }, (_, index) => ({ ...image('frame-' + (index + 1)), kind: 'reference_frame', mimeType: 'image/jpeg',
    role: legacy ? 'reference_frame' : 'asset', referenceVideoId: reference.id, timeSec: (index + 1) * 2.48 }));
  h.patch({ reference, referenceFrames: frames, assets: { image: [image()], video: [], audio: [] } });
  h.api.confirmRights(true);
}
async function settled(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('UI fixture did not settle');
}

test('real reference upload stores one video and five JPEG frames with canonical roles, then mocked analysis succeeds', async t => {
  const h = harness(); t.after(h.dispose);
  h.patch({ assets: { image: [image()], video: [], audio: [] } });
  const file = new Blob(['fixture-video-decoded-by-browser-double'], { type: 'video/mp4' }); file.name = '10月14日.mp4';
  h.node('reference-video-input').files = [file];
  await h.node('reference-video-input').emit('change');
  await settled(() => h.api.state.referenceFrames.length === 5 || h.node('toast-region').children.length);
  assert.equal(h.saved.length, 6); assert.equal(h.api.state.referenceFrames.length, 5);
  assert.equal(h.saved[0].kind, 'video'); assert.equal(h.saved.every(asset => asset.role === 'asset'), true);
  assert.equal(h.saved.slice(1).every(asset => asset.kind === 'reference_frame' && asset.referenceVideoId === h.saved[0].id), true);
  h.api.confirmRights(true);
  const draft = h.api.buildRequest('draft');
  assert.equal(draft.referenceVideo.role, 'asset'); assert.equal(draft.referenceFrames.length, 5);
  assert.equal(draft.referenceFrames.every(frame => frame.role === 'asset'), true);
  assert.deepEqual(clone(h.api.productionValidationErrors({ requireReview: false })), []);
  assert.equal(h.node('readiness-count').textContent, '4 / 4'); assert.equal(h.node('primary-action').disabled, false);
  await h.node('primary-action').emit('click');
  assert.equal(h.messages.length, 1); assert.equal(h.messages[0].payload.request.referenceFrames.length, 5);
  assert.equal(h.api.state.review.state, 'editing'); assert.match(h.api.state.review.script, /自有商品/);
});

test('old role aliases restore with asset IDs, source bindings, rights confirmation, and draft analysis intact', async t => {
  const h = harness(); t.after(h.dispose); fillReference(h, { legacy: true });
  const savedDraft = clone(h.api.draftSnapshot()), before = JSON.stringify(savedDraft);
  const originalFingerprint = savedDraft.rightsFingerprint;
  for (const asset of [savedDraft.reference, ...savedDraft.referenceFrames, ...savedDraft.assets.image]) {
    h.assets.set(asset.id, { ...asset, blob: new Blob(['stored-fixture'], { type: asset.mimeType }) });
  }
  h.drafts.set('remix', savedDraft);
  await h.api.restoreDraft('remix');
  assert.equal(JSON.stringify(savedDraft), before, 'restoration cannot rewrite the stored draft');
  assert.equal(h.api.state.rightsConfirmed, true); assert.equal(h.api.state.rightsFingerprint, originalFingerprint);
  const result = h.api.buildRequest('draft');
  assert.equal(result.rights.fingerprint, originalFingerprint);
  assert.equal(result.referenceVideo.id, savedDraft.reference.id); assert.equal(result.referenceVideo.role, 'asset');
  assert.deepEqual(clone(result.referenceFrames.map(frame => frame.id)), savedDraft.referenceFrames.map(frame => frame.id));
  assert.equal(result.referenceFrames.every(frame => frame.role === 'asset'), true);
  assert.equal(h.api.state.reference.role, 'reference'); assert.equal(h.api.state.referenceFrames[0].role, 'reference_frame');
  assert.deepEqual(clone(h.api.productionValidationErrors({ requireReview: false })), []);
  await h.api.analyzeDraft(); assert.equal(h.messages.length, 1);
});

test('unknown roles remain invalid in every slot and legacy aliases are accepted only in the matching analysis slot', t => {
  const h = harness(); t.after(h.dispose); fillReference(h);
  for (const [slot, role] of [['reference', 'wrong_role'], ['frame', 'wrong_role'], ['image', 'reference'], ['image', 'reference_frame'], ['reference', 'reference_frame'], ['frame', 'reference']]) {
    fillReference(h);
    const asset = slot === 'reference' ? h.api.state.reference : slot === 'frame' ? h.api.state.referenceFrames[0] : h.api.state.assets.image[0];
    asset.role = role;
    assert.throws(() => h.api.buildRequest('draft'), { code: 'ASSET_ROLE_INVALID' });
    assert.equal(h.api.baseChecks().input, false);
    assert.ok(h.api.productionValidationErrors({ requireReview: false }).some(message => /素材角色/.test(message)));
  }
  for (const kind of ['video', 'audio']) {
    fillReference(h);
    h.api.state.assets[kind].push(h.fixture({ ...image('bad-' + kind), kind, role: 'reference', mimeType: kind + '/mp4', durationSec: 5 }));
    if (kind === 'audio') h.api.state.legacySingle = true; // Final production audio is intentionally omitted from analysis.
    assert.throws(() => h.api.buildRequest('draft'), { code: 'ASSET_ROLE_INVALID' });
  }
  assert.equal(h.messages.length, 0);
});

test('AI production readiness validates the real analysis request, including exactly five frames and message-independent contract errors', async t => {
  const h = harness(); t.after(h.dispose);
  const cases = [
    { setup: () => fillReference(h, { count: 4 }), message: /5 个本地关键帧/ },
    { setup: () => fillReference(h, { count: 6 }), message: /5 个本地关键帧/ },
    { setup: () => { fillReference(h); h.api.state.reference = null; }, message: /独立参考视频/ },
    { setup: () => { fillReference(h); h.api.state.reference.durationSec = 16; }, message: /4–15 秒/ },
    { setup: () => { fillReference(h); h.api.state.settings.ratio = 'not-a-ratio'; }, message: /比例不受支持/ },
    { setup: () => { fillReference(h); h.api.state.settings.resolution = 'garbage'; }, message: /分辨率仅支持/ },
    { setup: () => { fillReference(h); h.api.state.expertEnabled = true; h.api.state.expertRequirements = ''; }, message: /高级约束/ }
  ];
  for (const entry of cases) {
    h.patch({ expertEnabled: false }); h.api.state.settings.ratio = '9:16'; h.api.state.settings.resolution = '480p';
    entry.setup(); h.api.confirmRights(true); h.api.renderReadiness();
    assert.ok(h.api.productionValidationErrors({ requireReview: false }).some(message => entry.message.test(message)), String(entry.message));
    assert.equal(h.api.baseChecks().input, false); assert.notEqual(h.node('readiness-count').textContent, '4 / 4');
    assert.equal(h.node('primary-action').disabled, true);
    await h.api.analyzeDraft(); assert.equal(h.messages.length, 0);
  }
});

test('reference video and analysis frames never enter generation material or a production shot request', async t => {
  const h = harness(); t.after(h.dispose); fillReference(h, { legacy: true });
  await h.api.analyzeDraft();
  assert.equal(h.messages.length, 1, 'the accepted legacy reference must reach mocked analysis');
  assert.equal(h.messages[0].payload.request.referenceVideo.id, 'authorized-reference');
  const template = h.api.productionTemplate();
  assert.equal(template.referenceVideo, undefined); assert.equal(template.referenceFrames, undefined);
  assert.deepEqual(clone(template.images.map(asset => asset.id)), ['own-product']); assert.deepEqual(clone(template.videos), []);
  const plan = h.api.previewProductionPlan();
  for (const shot of plan.shots.filter(shot => shot.kind === 'ai')) {
    assert.equal(shot.request.referenceVideo, null); assert.deepEqual(clone(shot.request.referenceFrames), []);
    assert.deepEqual(clone(shot.request.videos), []); assert.deepEqual(clone(shot.request.audios), []);
    assert.deepEqual(clone(shot.request.images.map(asset => asset.id)), ['own-product']);
  }
  assert.equal(JSON.stringify(plan).includes('authorized-reference'), false);
  assert.equal(JSON.stringify(plan).includes('frame-1'), false);
});

test('legacy zero-AI options retain reference aliases but new plans still require dynamic generation', t => {
  const h = harness(); t.after(h.dispose); fillReference(h, { legacy: true, count: 4 });
  h.api.state.productionOptions.hybridAiSeconds = 0; h.api.state.backendConnected = false; h.api.state.analysisAvailable = false;
  h.api.renderReadiness();
  const errors = clone(h.api.productionValidationErrors({ requireReview: false }));
  assert.ok(errors.some(message => /5 个本地关键帧/.test(message)));
  assert.ok(errors.some(message => /后台生成能力未连接/.test(message)));
  assert.ok(errors.some(message => /脚本分析不可用/.test(message)));
  assert.notEqual(h.node('readiness-count').textContent, '4 / 4');
  assert.equal(h.api.state.reference.role, 'reference');
  assert.equal(h.api.state.referenceFrames.every(frame => frame.role === 'reference_frame'), true);
  const plan = h.api.previewProductionPlan();
  assert.equal(plan.version, 2); assert.equal(plan.aiSeconds, 15); assert.equal(plan.localSeconds, 0);
  assert.ok(plan.estimateYuan > 0);
  assert.equal(plan.shots.every(shot => shot.kind === 'ai' && shot.request && shot.request.productKey === 'seedance-2.0' && shot.request.resolution === '480p'), true);
  assert.deepEqual(clone(plan.shots.map(shot => shot.request.images.map(asset => asset.id))), [['own-product'], ['own-product'], ['own-product']]);
  // Restore all legacy analysis references: they remain readable and never become static output clips.
  fillReference(h, { legacy: true }); h.patch({ backendConnected: true, analysisAvailable: true });
  assert.deepEqual(clone(h.api.productionValidationErrors({ requireReview: false })), []);
  h.patch({ mode: 'direct', reference: null, referenceFrames: [], backendConnected: true, analysisAvailable: false });
  h.api.state.settings.creativeRoute = 'hero_product'; h.api.confirmRights(true);
  assert.deepEqual(clone(h.api.productionValidationErrors({ requireReview: false })), []);
  assert.equal(h.api.previewProductionPlan().shots.every(shot => shot.kind === 'ai'), true);
  assert.equal(h.messages.length, 0, 'preflight never submits analysis or paid generation');
});
