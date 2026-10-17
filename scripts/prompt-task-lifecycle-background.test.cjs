'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../public/creative');
const config = { provider: 'openai-compatible', imageAdapter: 'generic-json', apiKey: 'test-only',
  visionModel: 'fixture-vision', textModel: 'fixture-vision', visionBaseUrl: 'https://provider.test/v1' };

function harness() {
  const listeners = [], requests = [], timers = new Map();
  let nextTimer = 0, now = 0;
  const event = () => ({ addListener() {} });
  const chrome = {
    runtime: { lastError: null, getManifest: () => ({}), getURL: value => `chrome-extension://test/${value}`,
      onInstalled: event(), onMessage: { addListener(listener) { listeners.push(listener); } } },
    storage: { local: { get(keys, callback) { callback({}); }, set(values, callback) { callback?.(); }, remove(keys, callback) { callback?.(); } } },
    contextMenus: { removeAll(callback) { callback(); }, create() {}, onClicked: event() },
    action: { onClicked: event() }, tabs: { create() {}, sendMessage() {} }, scripting: { executeScript() {} }, downloads: { download() {} }
  };
  const context = vm.createContext({ chrome, URL, URLSearchParams, Date, Promise, AbortController, Blob, FormData, Response,
    Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, console, btoa, atob, __SZ_PROMPTLAB_BACKGROUND_TEST_MODE__: true,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) { return new Promise(resolve => requests.push({ url, options, resolve })); }
  });
  for (const file of ['src/reference-detail-contract.js', 'labs/image-prompt-lab/reference-detail-blueprint.js',
    'labs/image-prompt-lab/reference-detail-batch.js', 'labs/image-prompt-lab/viral-series-contract.js',
    'labs/image-prompt-lab/style-refresh-contract.js', 'labs/image-prompt-lab/background.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  }
  const inRealm = value => vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`, context);
  const api = context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__;
  return { api, context, requests, timers,
    send(message) { const responses = []; listeners[0](inRealm(message), {}, response => responses.push(response)); return responses; },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now && timers.has(id)) { timers.delete(id); timer.callback(); }
    },
    begin(type, jobId, responses = []) {
      const handle = api.beginLegacyPromptJob(inRealm({ type, jobId, payload: {} }), response => responses.push(response));
      return { handle, responses, controller: api.activeJobs[jobId] };
    }
  };
}

async function flush() { for (let i = 0; i < 25; i++) await Promise.resolve(); }
const success = data => Response.json({ choices: [{ message: { content: JSON.stringify(data) } }] });

test('analysis errors name the text request while image uncertainty preserves no-repeat wording', () => {
  const h = harness();
  for (const code of ['timeout', 'network_error', 'cancelled', 'response_json_invalid']) {
    const chat = h.api.modelRequestFailure(0, '', { kind: 'chat', code });
    assert.equal(chat.stateUncertain, true);
    assert.match(chat.error, /提示词分析请求/);
    assert.match(chat.error, /其他任务可继续/);
    assert.match(chat.error, /失败/);
    assert.match(chat.error, /重新跑/);
    assert.match(chat.error, /原请求记录已保留/);
    assert.equal(chat.definitiveFailure, false);
    assert.doesNotMatch(chat.error, /避免重复生成|生图/);
    const image = h.api.modelRequestFailure(0, '', { kind: 'image', code });
    assert.equal(image.stateUncertain, true);
    assert.match(image.error, /避免重复生成/);
  }
});

test('all legacy text task types have a finite total deadline and finish exactly once', () => {
  const h = harness();
  for (const [type, duration] of Object.entries(h.api.legacyPromptJobTimeouts)) {
    const jobId = `deadline_${type}`;
    const task = h.begin(type, jobId);
    assert.ok(Number.isFinite(duration) && duration > 0);
    h.advance(duration - 1);
    assert.equal(task.responses.length, 0);
    h.advance(1);
    assert.equal(task.responses.length, 1);
    assert.equal(task.responses[0].code, 'PROMPT_JOB_TIMEOUT');
    assert.equal(task.responses[0].timedOut, true);
    assert.match(task.responses[0].error, /超时失败/);
    assert.match(task.responses[0].error, /手动重新跑失败项/);
    assert.equal(task.responses[0].ended, true);
    assert.equal(task.responses[0].providerSubmitted, undefined);
    assert.equal(task.controller.signal.aborted, true);
    assert.equal(h.api.activeJobs[jobId], undefined);
    task.handle.finish({ ok: true, data: { late: true } });
    assert.equal(task.responses.length, 1);
  }
});

test('distinct jobs run concurrently and duplicate or mismatched identities cannot replace a controller', () => {
  const h = harness(), first = h.begin('BUILD_LINK_PROMPT', 'prompt-a'), second = h.begin('BUILD_LINK_PROMPT', 'prompt-b');
  assert.notEqual(first.controller, second.controller);
  const duplicate = h.begin('ANALYZE_IMAGE', 'prompt-a');
  assert.equal(duplicate.handle.blocked, true);
  assert.equal(duplicate.responses[0].code, 'PROMPT_JOB_ACTIVE');
  assert.equal(h.api.activeJobs['prompt-a'], first.controller);
  const mismatch = [];
  const result = h.api.beginLegacyPromptJob({ type: 'BUILD_LINK_PROMPT', jobId: 'outer', payload: { _jobId: 'inner' } }, value => mismatch.push(value));
  assert.equal(result.blocked, true);
  assert.equal(mismatch[0].code, 'PROMPT_JOB_ID_MISMATCH');
  first.handle.finish({ ok: true }); second.handle.finish({ ok: true });
});

test('cancel message ends only the selected text task and late finish cannot delete a replacement', () => {
  const h = harness(), old = h.begin('BUILD_LINK_PROMPT', 'same-id'), other = h.begin('ANALYZE_IMAGE', 'other-id');
  const cancel = h.send({ type: 'CANCEL_GENERATION', jobId: 'same-id' });
  assert.equal(cancel[0].ended, true);
  assert.equal(old.responses[0].code, 'cancelled');
  assert.equal(old.controller.signal.aborted, true);
  assert.equal(other.controller.signal.aborted, false);
  const replacement = h.begin('BUILD_LINK_PROMPT', 'same-id');
  old.handle.finish({ ok: true, data: { obsolete: true } });
  assert.equal(old.responses.length, 1);
  assert.equal(h.api.activeJobs['same-id'], replacement.controller);
  // Even external map changes cannot be cleared by a different task's finish.
  h.api.activeJobs['other-id'] = new AbortController();
  const replacementController = h.api.activeJobs['other-id'];
  other.handle.finish({ ok: true });
  assert.equal(h.api.activeJobs['other-id'], replacementController);
  replacement.handle.finish({ ok: true });
});

test('formal reference batch, blueprints and image jobs keep their existing lifecycle', () => {
  const h = harness();
  assert.equal(h.api.beginLegacyPromptJob({ type: 'BUILD_DETAIL_PROMPT', payload: { referenceDetailBatch: {} } }, () => assert.fail()), null);
  assert.equal(h.api.beginLegacyPromptJob({ type: 'BUILD_REFERENCE_DETAIL_BLUEPRINT' }, () => assert.fail()), null);
  assert.equal(h.api.beginLegacyPromptJob({ type: 'GENERATE_IMAGE' }, () => assert.fail()), null);
  const imageController = new AbortController();
  h.api.activeJobs.image = imageController;
  const conflict = h.begin('BUILD_LINK_PROMPT', 'image');
  assert.equal(conflict.responses[0].code, 'PROMPT_JOB_ACTIVE');
  assert.equal(h.api.activeJobs.image, imageController);
  assert.equal(imageController.signal.aborted, false);
});

test('real link prompt handler propagates cancellation to fetch and ignores an accepted late response', async () => {
  const h = harness();
  const responses = h.send({ type: 'BUILD_LINK_PROMPT', jobId: 'actual-link', config,
    payload: { link: { '链接编号': 'L001', '品类': '信封' }, productImages: ['data:image/png;base64,YQ=='], businessKnowledgeContext: '' } });
  await flush();
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  h.send({ type: 'CANCEL_GENERATION', jobId: 'actual-link' });
  assert.equal(responses.length, 1);
  assert.equal(responses[0].code, 'cancelled');
  assert.equal(request.options.signal.aborted, true);
  request.resolve(success({ malformed: true }));
  await flush();
  assert.equal(responses.length, 1);
  assert.equal(h.requests.length, 1);
});

test('deadline during a response prevents repair and detail retry dispatch', async () => {
  const h = harness(), task = h.begin('ANALYZE_IMAGE', 'repair-deadline');
  const pending = h.api.runPromptWithSingleRepair(config, [], 'fixture-vision', 0.1, 300000,
    () => ({ ok: false, code: 'protocol_mismatch' }), {}, task.controller.signal);
  assert.equal(h.requests.length, 1);
  h.advance(h.api.legacyPromptJobTimeouts.ANALYZE_IMAGE);
  h.requests[0].resolve(success({ malformed: true }));
  assert.equal((await pending).code, 'cancelled');
  assert.equal(h.requests.length, 1);
  const detail = h.begin('BUILD_DETAIL_PROMPT', 'detail-deadline');
  const retry = h.api.runDetailPromptWithServiceRetry(config, [], 'fixture-vision', 0.1, 300000, value => value, {}, detail.controller.signal);
  assert.equal(h.requests.length, 2);
  h.advance(h.api.legacyPromptJobTimeouts.BUILD_DETAIL_PROMPT);
  h.requests[1].resolve(Response.json({ error: 'busy' }, { status: 503 }));
  assert.equal((await retry).code, 'cancelled');
  assert.equal(h.requests.length, 2);
});

test('real image requests cancelled during preflight cannot dispatch after job map release or replacement', async () => {
  for (const imageAdapter of ['generic-json', 'openai-images', 'volcengine-image', 'gemini-image', 'dashscope-wan']) {
    const h = harness();
    const responses = h.send({ type: 'GENERATE_IMAGE', jobId: 'cancel-before-provider',
      config: { ...config, imageAdapter, imageModel: 'fixture-image', imageEndpoint: 'https://provider.test/v1/images/generations' },
      payload: { prompt: 'Preserve the provided envelope.', productImages: ['data:image/png;base64,YQ=='], labMode: 'main', size: '1024x1024', count: 1 } });
    // Enter createImageTask but leave its knowledge preflight continuation queued.
    await Promise.resolve();
    assert.ok(h.api.activeJobs['cancel-before-provider'], imageAdapter);
    h.send({ type: 'CANCEL_GENERATION', jobId: 'cancel-before-provider' });
    const replacement = new AbortController();
    h.api.activeJobs['cancel-before-provider'] = replacement;
    await flush();
    assert.equal(h.requests.length, 0, imageAdapter);
    assert.equal(responses.length, 1, imageAdapter);
    assert.equal(responses[0].code, 'IMAGE_CANCELLED_BEFORE_SUBMISSION', imageAdapter);
    assert.equal(responses[0].providerSubmitted, false, imageAdapter);
    assert.equal(h.api.activeJobs['cancel-before-provider'], replacement, imageAdapter);
    assert.equal(replacement.signal.aborted, false, imageAdapter);
  }
});

test('image cancellation after provider dispatch preserves a late success instead of claiming not submitted', async () => {
  const h = harness();
  const responses = h.send({ type: 'GENERATE_IMAGE', jobId: 'accepted-image',
    config: { ...config, imageModel: 'fixture-image', imageEndpoint: 'https://provider.test/v1/images/generations' },
    payload: { prompt: 'Preserve the provided envelope.', productImages: ['data:image/png;base64,YQ=='], labMode: 'main', size: '1024x1024', count: 1 } });
  await flush();
  assert.equal(h.requests.length, 1);
  h.send({ type: 'CANCEL_GENERATION', jobId: 'accepted-image' });
  assert.equal(h.requests[0].options.signal.aborted, true);
  h.requests[0].resolve(Response.json({ data: [{ url: 'https://assets.test/accepted-image.png' }] }));
  await flush();
  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].images[0], 'https://assets.test/accepted-image.png');
  assert.equal(responses[0].providerSubmitted, undefined);
});
