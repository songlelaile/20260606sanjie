'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const moduleDir = path.resolve(__dirname, '../public/creative/labs/ecommerce-video-studio');
const clone = value => JSON.parse(JSON.stringify(value));

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.events = new Map();
    this.textContent = ''; this.value = ''; this.hidden = false; this.disabled = false; this.replacements = 0;
    this.style = { setProperty() {} }; this.attributes = {}; this.pauseCount = 0; this.loadCount = 0;
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  append(...items) { for (const item of items) { item.parentNode = this; this.children.push(item); } }
  appendChild(item) { this.append(item); return item; }
  replaceChildren(...items) { this.children = []; this.replacements++; this.append(...items); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(item => item !== this); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; if (name === 'src') this.src = ''; }
  addEventListener(name, listener) { if (!this.events.has(name)) this.events.set(name, []); this.events.get(name).push(listener); }
  async emit(name, target = this) { await Promise.all((this.events.get(name) || []).map(listener => listener({ target, preventDefault() {} }))); }
  matches(selector) {
    if (selector === '[data-history-action]') return !!this.dataset.historyAction;
    return this.tagName === selector.toUpperCase();
  }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  querySelectorAll(selector) { return this.children.flatMap(item => [item.matches(selector) ? item : null, ...item.querySelectorAll(selector)]).filter(Boolean); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  pause() { this.pauseCount++; }
  load() { this.loadCount++; }
  showModal() { this.open = true; }
  focus() {}
}

function harness(storage = new Map()) {
  const nodes = new Map(), messages = [], writes = [], revoked = [], timers = new Set();
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  node('history-filter').value = 'all';
  node('history-empty').append(new Element('strong'), new Element('p'));
  const store = {
    async saveRun(run) { writes.push(clone(run)); return run; },
    async getAsset(id) { return { id, blob: new Blob(['saved-video'], { type: 'video/mp4' }), mimeType: 'video/mp4' }; }
  };
  let objectId = 0;
  const context = vm.createContext({
    document: { readyState: 'loading', addEventListener() {}, getElementById: node, querySelectorAll: () => [], createElement: tag => new Element(tag) },
    Blob, URL: class extends URL { static createObjectURL() { return 'blob:result-' + (++objectId); } static revokeObjectURL(url) { revoked.push(url); } },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); timers.add(timer); return timer; }, clearTimeout,
    addEventListener() {}, SZEcommerceVideoStore: store, __SZ_VIDEO_STUDIO_EXPOSE_TESTING__: true,
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage(message, callback) {
      messages.push(clone(message)); assert.fail('History view actions must not query providers, submit tasks, or modify billing');
    } } },
    fetch() { assert.fail('History view fixtures must not use the network'); }
  });
  vm.runInContext(fs.readFileSync(path.join(moduleDir, 'video-studio-contract.js'), 'utf8'), context);
  let source = fs.readFileSync(path.join(moduleDir, 'video-studio.js'), 'utf8');
  source = source.replace('safeRemoteAssetUrl: safeRemoteAssetUrl,', 'bindEvents: bindEvents, normalizeStoredRun: normalizeStoredRun, upsertRunFromTask: upsertRunFromTask, safeRemoteAssetUrl: safeRemoteAssetUrl,');
  vm.runInContext(source, context);
  const api = context.SZEcommerceVideoStudioTesting;
  api.cacheDom(); api.bindEvents(); api.state.accountKey = 'account-a';
  const patch = value => vm.runInContext('Object.assign(SZEcommerceVideoStudioTesting.state, ' + JSON.stringify(value) + ')', context);
  return { api, node, messages, writes, revoked, storage, patch,
    dispose() { timers.forEach(clearTimeout); },
    rows: () => node('history-list').children,
    ids: () => node('history-list').children.map(row => row.dataset.runId),
    async action(id, action) {
      const row = node('history-list').children.find(item => item.dataset.runId === id);
      assert.ok(row, 'The target run is rendered');
      const button = row.querySelectorAll('[data-history-action]').find(item => item.dataset.historyAction === action);
      assert.ok(button, 'The requested action is available');
      await node('history-list').emit('click', button);
    }
  };
}

function run(id, status = 'succeeded', extra = {}) {
  return { id, taskId: id, accountKey: 'account-a', purpose: 'generation', mode: 'direct', productKey: 'seedance-2.0',
    prompt: id, status, resultUrls: ['https://fixture.test/' + id + '.mp4'], createdAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T10:00:00Z', ...extra };
}

test('100 completed video tasks render 20 rows, progressively load, and keep identical receipts from rebuilding the list', async t => {
  const h = harness(); t.after(h.dispose);
  h.patch({ history: Array.from({ length: 100 }, (_, index) => run('video-' + index)) });
  h.api.renderHistory();
  assert.equal(h.rows().length, 20); assert.equal(h.node('load-more-history').hidden, false);
  const firstRow = h.rows()[0], replacements = h.node('history-list').replacements;
  h.api.renderHistory(); assert.equal(h.node('history-list').replacements, replacements); assert.equal(h.rows()[0], firstRow);
  await h.node('load-more-history').emit('click'); assert.equal(h.rows().length, 40);
  for (let i = 0; i < 3; i++) await h.node('load-more-history').emit('click');
  assert.equal(h.rows().length, 100); assert.equal(h.node('load-more-history').hidden, true);
  h.node('history-filter').value = 'succeeded'; await h.node('history-filter').emit('change');
  assert.equal(h.rows().length, 20, 'Changing the filter resets the rendering budget');
  assert.equal(h.node('history-list').querySelectorAll('video').length, 0, 'The history list never loads video media');
  assert.equal(h.messages.length, 0); assert.equal(h.writes.length, 0);
});

test('bulk cleanup preserves active, uncertain, cancelling, and unfinished production recovery; ended results can be restored', async t => {
  const h = harness(); t.after(h.dispose);
  const protectedRuns = [run('active', 'processing'), run('unknown', 'unknown'), run('timeout', 'failed', { errorCode: 'RUNTIME_TIMEOUT' }),
    run('uncertain', 'failed', { stateUncertain: true }), run('cancelling', 'cancelled', { cancelPending: true }),
    run('unfinished-plan', 'failed', { purpose: 'production' }),
    run('unknown-shot', 'succeeded', { purpose: 'production', shotRuns: [{ status: 'unknown' }] }),
    run('unknown-narration', 'succeeded', { purpose: 'production', narrationRuns: [{ status: 'unknown' }] })];
  h.patch({ history: [run('completed'), run('failed', 'failed'), run('cancelled', 'cancelled'), run('complete-plan', 'succeeded', { purpose: 'production' }), ...protectedRuns] });
  const original = clone(h.api.state.history);
  h.api.renderHistory();
  assert.equal(h.ids()[0], 'active', 'Protected work is listed before ended rows');
  await h.node('clear-ended-history').emit('click');
  assert.deepEqual(h.ids(), protectedRuns.map(item => item.id));
  assert.deepEqual(clone(h.api.state.history), original, 'Cleanup preserves exact receipts, URLs, and cost fields');
  assert.equal(h.node('toggle-hidden-history').hidden, false); assert.equal(h.node('clear-ended-history').disabled, true);
  await h.node('toggle-hidden-history').emit('click');
  assert.ok(h.ids().includes('completed'));
  await h.action('completed', 'restore');
  await h.node('toggle-hidden-history').emit('click');
  assert.ok(h.ids().includes('completed')); assert.equal(h.ids().includes('failed'), false);
  assert.equal(h.messages.length, 0); assert.equal(h.writes.length, 0);
});

test('hidden rows survive reloads and late receipts, are scoped to the account, and unknown stored statuses retain recovery', async t => {
  const storage = new Map(), h = harness(storage); t.after(h.dispose);
  h.patch({ history: [run('completed')] }); h.api.renderHistory();
  await h.action('completed', 'hide'); assert.deepEqual(h.ids(), []);
  await h.api.upsertRunFromTask({ taskId: 'completed', status: 'succeeded', accountKey: 'account-a', resultUrls: ['https://fixture.test/late.mp4'] }, 'generation');
  assert.deepEqual(h.ids(), [], 'A late completed receipt must not restore a manually cleaned row');
  assert.deepEqual(clone(h.api.state.history[0].resultUrls), ['https://fixture.test/late.mp4']);
  const reloaded = harness(storage); t.after(reloaded.dispose);
  reloaded.patch({ history: [run('completed')] }); reloaded.api.renderHistory(); assert.deepEqual(reloaded.ids(), []);
  reloaded.patch({ accountKey: 'account-b', history: [run('completed', 'succeeded', { accountKey: 'account-b' })] });
  reloaded.api.renderHistory(); assert.deepEqual(reloaded.ids(), ['completed'], 'Cleanup in account A cannot hide account B results');
  const unknown = h.api.normalizeStoredRun(run('unknown-after-reload', 'unknown'));
  assert.equal(unknown.status, 'unknown'); h.api.state.history = [unknown]; h.api.renderHistory();
  assert.ok(h.rows()[0].querySelectorAll('[data-history-action]').some(button => button.dataset.historyAction === 'status'));
});

test('closing or replacing result previews releases video and its blob URL while keeping uploaded assets and saved history', async t => {
  const h = harness(); t.after(h.dispose);
  const original = run('local-result', 'succeeded', { resultAssetId: 'saved-video' });
  h.api.state.previewUrls.add('blob:uploaded-reference');
  await h.api.openResultDialog(original);
  const video = h.node('result-media').querySelector('video'); assert.ok(video);
  assert.equal(h.api.state.resultPreviewUrl, 'blob:result-1');
  await h.node('result-dialog').emit('close');
  assert.equal(video.pauseCount, 1); assert.equal(video.loadCount, 1); assert.equal(video.src, '');
  assert.equal(h.node('result-media').children.length, 0); assert.deepEqual(h.revoked, ['blob:result-1']);
  assert.equal(h.api.state.previewUrls.has('blob:uploaded-reference'), true);
  assert.equal(original.resultAssetId, 'saved-video'); assert.equal(h.writes.length, 0);
  await h.api.openResultDialog(original); await h.api.openResultDialog(run('remote-result'));
  assert.ok(h.revoked.includes('blob:result-2')); assert.equal(h.api.state.previewUrls.has('blob:uploaded-reference'), true);
});
