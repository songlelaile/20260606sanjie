'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../public/creative/labs/image-prompt-lab');
const profiles = require(path.join(ROOT, 'guide-model-profile.js'));
const event = () => ({ addListener() {} });
const clone = (value) => JSON.parse(JSON.stringify(value));

class FormDataRecorder {
  constructor() { this.items = []; }
  append(name, value, filename) { this.items.push({ name, value, filename }); }
  values(name) { return this.items.filter((item) => item.name === name); }
  value(name) { return this.values(name)[0]?.value; }
}

function loadBackground() {
  const requests = [];
  const chrome = {
    runtime: { lastError: null, getManifest: () => ({}), getURL: (p) => `chrome-extension://test/${p}`, onInstalled: event(), onMessage: event() },
    storage: { local: { get(_keys, cb) { cb({}); }, set(_v, cb) { if (cb) cb(); }, remove(_v, cb) { if (cb) cb(); } } },
    contextMenus: { removeAll(cb) { cb(); }, create() {}, onClicked: event() },
    action: { onClicked: event() }, tabs: { create() {}, sendMessage() {} }, scripting: { executeScript() {} }, downloads: { download() {} }
  };
  const context = {
    __SZ_PROMPTLAB_BACKGROUND_TEST_MODE__: true, chrome, console, URL, Date, Promise, AbortController, Blob,
    FormData: FormDataRecorder, setTimeout, clearTimeout,
    btoa: (v) => Buffer.from(v, 'binary').toString('base64'),
    atob: (v) => Buffer.from(v, 'base64').toString('binary'),
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ url: 'https://result.test/repaired.png' }] }) };
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ['guide-model-profile.js', 'viral-series-contract.js', 'style-refresh-contract.js', 'background.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  }
  return { api: context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__, requests };
}

function config(model = 'gpt-image-2.5-sunburst', adapter = 'openai-images') {
  return { provider: 'openai', imageAdapter: adapter, imageModel: model, imageEndpoint: 'https://provider.test/v1/images/generations', apiKey: 'test-only' };
}

function png(width = 1024, height = 1024, marker = 1, length = 32) {
  const bytes = Buffer.alloc(length);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); bytes[24] = 8; bytes[25] = 6; bytes[26] = marker;
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

function payload(cfg = config()) {
  return {
    prompt: 'Repair the selected product defect only.', promptSource: 'reference',
    productImages: [png(1024, 1024, 2)], editBaseImage: png(), editMaskImage: png(), strictLocalEdit: true,
    size: '1024*1024', count: 1, clarity: '4K', sourceResultId: 'result-1',
    guideContract: {
      version: 'GUIDE_REGEN_TEST_V1', scope: 'current', mode: 'subject', repairPath: 'L2', issue: 'subject-missing',
      evidenceLevel: 'E3', minimumEvidence: 'E2', outputType: 'formal', parentResultId: 'result-1', guide: 'Repair the selected product defect only.',
      annotation: { mustStrokeCount: 1 }, postCompositeOutsideMask: true, modelProfile: profiles.resolve(cfg)
    }
  };
}

test('Sunburst exact IDs, dated snapshots and gateway aliases select edit-first without rewriting model IDs', () => {
  for (const model of ['gpt-image-2.5-sunburst', 'GPT-IMAGE-2.5-SUNBURST-2026-09-22', 'Image-2.5-sunburst', 'image2.5-sunburst']) {
    const profile = profiles.resolve(config(`  ${model}  `));
    assert.equal(profile.model, model);
    assert.equal(profile.family, 'gpt-image-2.5-sunburst');
    assert.equal(profile.promptStyle, 'edit-first');
    assert.equal(profile.capability, 'mask-guided');
    assert.equal(profile.inputFidelity, false);
    assert.doesNotMatch(JSON.stringify(profile), /test-only|provider\.test/);
  }
  for (const model of ['gpt-image-2.50-sunburst', 'Image-2.50-sunburst', 'gpt-image-2.5', 'gpt-image-2.5-sunburst-unverified']) {
    const profile = profiles.resolve(config(model));
    assert.equal(profile.family, 'unknown');
    assert.equal(profile.promptStyle, 'structured-edit');
    assert.match(profile.label, /未验证/);
  }
});

test('model capability and fidelity stay separate from configured adapter transport', () => {
  for (const model of ['gpt-image-2', 'image2', 'gpt-image-2.5-sunburst']) {
    assert.equal(profiles.resolve(config(model, 'generic-json')).capability, 'client-composited-mask');
    for (const adapter of ['dashscope-wan', 'doubao-image', 'gemini-image', 'nano-banana']) {
      assert.equal(profiles.resolve(config(model, adapter)).capability, 'annotation-reference');
    }
  }
  for (const model of ['gemini-2.5-flash-image', 'doubao-seedream-4-5', 'wan2.7-image']) {
    assert.equal(profiles.resolve(config(model)).capability, 'annotation-reference', model);
  }
  for (const model of ['gpt-4o', 'gpt-5.4', 'claude-sonnet-4', 'gemini-2.5-pro', 'dall-e-3', 'cogview-4', 'wan2.2-t2i-plus']) {
    assert.equal(profiles.resolve(config(model)).capability, 'unsupported', model);
    assert.equal(profiles.resolve(config(model, 'generic-json')).capability, 'unsupported', model);
  }
  for (const model of ['gpt-image-1', 'gpt-image-1-2025-04-15', 'gpt-image-1.5']) assert.equal(profiles.resolve(config(model)).inputFidelity, true);
  for (const model of ['gpt-image-1-mini', 'gpt-image-2', 'Image-2.5-sunburst']) assert.equal(profiles.resolve(config(model)).inputFidelity, false);
  assert.equal(profiles.resolve({ imageAdapter: 'openai-images' }).capability, 'mask-guided');
});

test('bindings reject model/adapter/family/capability tampering and stale selection', () => {
  const cfg = config();
  const profile = profiles.resolve(cfg);
  assert.equal(profiles.sameBinding(profile, cfg), true);
  for (const key of ['model', 'adapter', 'family', 'capability', 'version']) {
    assert.equal(profiles.sameBinding({ ...profile, [key]: 'forged' }, cfg), false, key);
  }
  assert.equal(profiles.sameBinding(profile, config('gpt-image-2')), false);
  assert.equal(profiles.sameBinding(profile, config(cfg.imageModel, 'generic-json')), false);
});

test('new guide sizes preserve legal dimensions, never upgrade quality or pixel budget, leave legacy and SKU sizes alone', () => {
  const { api } = loadBackground();
  const cfg = config();
  for (const size of ['1024*1024', '2048*1536', '3840*2160']) {
    assert.equal(api.guideModelSizeForConfig(cfg, { ...payload(cfg), size }).size, size);
  }
  for (const size of ['1000*1000', '2049*1537', '4096*4096']) {
    const result = api.guideModelSizeForConfig(cfg, { ...payload(cfg), size });
    assert.equal(result.ok, true);
    const [w, h] = result.size.split('*').map(Number);
    const [a, b] = size.split('*').map(Number);
    assert.equal(w % 16, 0); assert.equal(h % 16, 0);
    assert.ok(w <= 3840 && h <= 3840 && w * h >= 655360 && w * h <= 8294400 && w * h <= a * b);
    assert.ok(Math.abs(Math.log((a / b) / (w / h))) <= 0.02);
    assert.ok(Math.abs(a / b - w / h) <= 0.019);
  }
  for (const size of ['256*256', '4096*512', '800*820', '1146*590', '1330*503', 'auto']) assert.equal(api.guideModelSizeForConfig(cfg, { ...payload(cfg), size }).ok, false, size);
  const legacy = payload(cfg); delete legacy.guideContract.modelProfile;
  assert.equal(api.guideModelSizeForConfig(cfg, { ...legacy, size: '100*100' }).size, '100*100');
  const sku = { ...payload(cfg), labMode: 'sku', promptSource: 'sku', detailMode: 'sku-guide', skuVisualLock: { version: 'SKU_SUBJECT_REPLACE_V2' }, size: '960*1280' };
  assert.equal(api.guideModelSizeForConfig(cfg, sku).size, '960*1280');
});

test('new guide request sends Sunburst model unchanged, edits+mask, legal size, without fidelity/quality/beautification', async () => {
  const { api, requests } = loadBackground();
  const cfg = config('Image-2.5-sunburst');
  const result = await api.createImageTask(cfg, { ...payload(cfg), size: '1000*1000' });
  assert.equal(result.ok, true, result.error);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://provider.test/v1/images/edits');
  const body = requests[0].options.body;
  assert.equal(body.value('model'), 'Image-2.5-sunburst');
  assert.equal(body.value('size'), '992x992');
  assert.equal(body.value('input_fidelity'), undefined);
  assert.equal(body.value('quality'), undefined);
  assert.equal(body.values('mask').length, 1);
  assert.deepEqual(body.values('image[]').map((entry) => entry.filename), ['guide-edit-base.png', 'product-subject-1.png']);
  assert.doesNotMatch(body.value('prompt'), /premium|balanced lighting|high resolution|4K commercial/);
  assert.equal(result.guideModelProfile.family, 'gpt-image-2.5-sunburst');
  assert.equal(result.guideProviderSize, '992*992');
});

test('backend rejects stale profile, text model, oversized mask before network, while legacy guide still runs', async () => {
  const { api, requests } = loadBackground();
  const cfg = config();
  let result = await api.createImageTask(config('gpt-image-2'), payload(cfg));
  assert.equal(result.code, 'guide_model_profile_mismatch');
  const textCfg = config('gpt-4o');
  result = await api.createImageTask(textCfg, payload(textCfg));
  assert.equal(result.ok, false);
  assert.match(result.error, /不支持/);
  result = await api.createImageTask(cfg, { ...payload(cfg), editMaskImage: png(1024, 1024, 1, 4 * 1024 * 1024) });
  assert.equal(result.ok, false); assert.match(result.error, /4MB/);
  assert.equal(requests.length, 0);
  const legacy = payload(cfg); delete legacy.guideContract.modelProfile;
  result = await api.createImageTask(cfg, legacy);
  assert.equal(result.ok, true, result.error);
  assert.equal(requests.length, 1);
});

test('generic gateway receives recomputed safe profile and client-composited capability', async () => {
  const { api, requests } = loadBackground();
  const cfg = config('image2.5-sunburst', 'generic-json');
  const data = payload(cfg);
  data.guideContract.modelProfile.label = 'forged verified native';
  data.guideContract.modelProfile.promptStyle = 'forged';
  data.guideContract.modelProfile.apiKey = 'must-never-forward';
  const result = await api.createImageTask(cfg, data);
  assert.equal(result.ok, true, result.error);
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.model, 'image2.5-sunburst');
  assert.deepEqual(body.guide_contract.modelProfile, profiles.resolve(cfg));
  assert.equal(result.guideCapability, 'client-composited-mask');
  assert.doesNotMatch(JSON.stringify(body), /must-never-forward|forged/);
});

test('recognized non-GPT model on OpenAI transport sends annotation reference without native mask', async () => {
  const { api, requests } = loadBackground();
  const cfg = config('gemini-2.5-flash-image');
  const data = { ...payload(cfg), strictLocalEdit: false, guideAnnotationImage: png(1024, 1024, 3) };
  const result = await api.createImageTask(cfg, data);
  assert.equal(result.ok, true, result.error);
  const body = requests[0].options.body;
  assert.equal(body.value('mask'), undefined);
  assert.ok(body.values('image[]').some((entry) => entry.filename === 'guide-annotation-reference.png'));
  assert.equal(result.guideCapability, 'annotation-reference');
  assert.match(result.guideWarning, /不能保证/);
});

test('SKU guide keeps base then evidence in provider inputs and never reintroduces full subject replacement', async () => {
  const { api, requests } = loadBackground();
  const cfg = config();
  const data = { ...payload(cfg), prompt: 'Repair the single selected missing handle.', labMode: 'sku', promptSource: 'sku', detailMode: 'sku-guide', skuVisualLock: { version: 'SKU_SUBJECT_REPLACE_V2' } };
  assert.deepEqual(clone(api.inputImagesFromPayload(data)), [data.editBaseImage, data.productImages[0]]);
  const result = await api.createOpenAIImage(cfg, data);
  assert.equal(result.ok, true, result.error);
  const body = requests[0].options.body;
  assert.deepEqual(body.values('image[]').map((entry) => entry.filename), ['immutable-sku-base.png', 'replacement-subject.png']);
  const prompt = body.value('prompt');
  assert.match(prompt, /Edit input image 1, the current selected result/);
  assert.match(prompt, /Product photos after image 1 prove product identity/);
  assert.match(prompt, /CHANGE: Repair the selected product defect only/);
  assert.doesNotMatch(prompt, /Replace only the original product subject|STRICT SKU SUBJECT REPLACEMENT CONTRACT|Input image 2 is the IMMUTABLE/);
  const standard = api.skuSubjectReplacePrompt({ ...data, detailMode: 'sku', guideContract: null });
  assert.match(standard, /STRICT SKU SUBJECT REPLACEMENT CONTRACT/);
});

test('guide disables generic clarity suffix and provider prompt extension while ordinary generation retains defaults', () => {
  const { api } = loadBackground();
  const cfg = config();
  const data = payload(cfg);
  assert.equal(api.generationClaritySuffix(data), '');
  assert.equal(api.generationPayload(cfg, data).parameters.prompt_extend, false);
  assert.match(api.generationClaritySuffix({ clarity: '4K' }), /4K/);
  assert.equal(api.generationPayload(cfg, { prompt: 'ordinary', productImages: [png()] }).parameters.prompt_extend, true);
});


test('backend reconstructs Sunburst-only prompt from its contract and rejects incompatible or changed endpoints before network', async () => {
  const { api, requests } = loadBackground();
  const cfg = config();
  const data = payload(cfg);
  data.prompt = 'OLD ENTIRE IMAGE REPLACEMENT WITH OLD COPY';
  data.negativePrompt = 'OLD LIGHTING AND NEGATIVE';
  data.guideContract.operation = 'replace-visible-text';
  data.guideContract.textTarget = '旧文字';
  data.guideContract.replacementText = '新文字';
  data.guideContract.guide = '只替换圈选文字';
  data.guideContract.annotation.hasEditMask = true;
  data.guideContract.modelProfile.strategyLabel = 'FORGED';
  const result = await api.createImageTask(cfg, data);
  assert.equal(result.ok, true, result.error);
  const body = requests[0].options.body;
  assert.match(body.value('prompt'), /Replace only the exact visible text “旧文字” with “新文字”/);
  assert.doesNotMatch(body.value('prompt'), /OLD|FORGED|STRUCTURED GUIDE|Execution path:/);
  assert.equal(body.values('image[]').length, 0);
  assert.equal(body.values('image').length, 1);
  assert.equal(result.guideModelProfile.strategyLabel, 'Sunburst 精准编辑：修改 / 保留 / 证据');
  const originalRequests = requests.length;
  for (const endpoint of ['https://provider.test/v1/chat/completions', 'javascript:alert(1)', 'file:///tmp/image']) {
    const badCfg = { ...cfg, imageEndpoint: endpoint };
    const rejected = await api.createImageTask(badCfg, payload(badCfg));
    assert.equal(rejected.ok, false, endpoint);
  }
  const changed = await api.createImageTask({ ...cfg, imageEndpoint: 'https://provider.test/v1/chat/completions' }, payload(cfg));
  assert.equal(changed.code, 'guide_model_profile_mismatch');
  assert.equal(requests.length, originalRequests);
});

test('guide edits routing preserves query while replacing generation path and trailing slash', async () => {
  const { api, requests } = loadBackground();
  const cfg = { ...config(), imageEndpoint: 'https://provider.test/v1/images/generations/?route=edit' };
  const result = await api.createImageTask(cfg, payload(cfg));
  assert.equal(result.ok, true, result.error);
  assert.equal(requests[0].url, 'https://provider.test/v1/images/edits?route=edit');
});
