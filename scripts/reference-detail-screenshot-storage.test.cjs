'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../public/creative/web-chrome.js'), 'utf8');
const clone = value => structuredClone(value);

function memoryStorage(quota = 5 * 1024 * 1024) {
  const values = new Map();
  return { values, failWrite: false,
    get length() { return values.size; }, key(index) { return [...values.keys()][index] || null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) {
      if (this.failWrite) { this.failWrite = false; throw new Error('QuotaExceededError fixture'); }
      value = String(value);
      const size = [...values].reduce((sum, [name, item]) => sum + (name === key ? 0 : item.length), value.length);
      if (size > quota) throw new Error('QuotaExceededError fixture');
      values.set(key, value);
    },
    removeItem(key) { values.delete(key); }
  };
}

// Model asynchronous IndexedDB requests and atomic transaction commits so error
// tests distinguish a request result from a successfully committed write.
function indexedDatabase() {
  const records = new Map(), faults = { open: false, read: false, write: false, remove: false, holdOpen: false, holdTransaction: false, holdCompletion: false }, calls = [], held = [];
  let beforeCommit;
  let exists = false;
  const database = {
    objectStoreNames: { contains: () => exists }, createObjectStore() { exists = true; }, close() { calls.push('close'); },
    transaction(_name, mode) {
      const transaction = { oncomplete: null, onerror: null, onabort: null, abort() { if (committed) throw new Error('InvalidStateError'); aborted = true; queueMicrotask(() => transaction.onabort?.()); } };
      const pending = [], requests = [];
      let aborted = false, committed = false;
      transaction.objectStore = () => ({
        get(id) { const request = {}; requests.push({ kind: 'get', id, request }); return request; },
        put(value, id) { const request = {}; requests.push({ kind: 'put', id, value: clone(value), request }); return request; },
        delete(id) { const request = {}; requests.push({ kind: 'delete', id, request }); return request; }
      });
      const commit = () => {
        if (aborted) return;
        for (const item of requests) {
          calls.push(item.kind);
          if ((item.kind === 'get' && faults.read) || (item.kind === 'put' && faults.write) || (item.kind === 'delete' && faults.remove)) {
            transaction.onerror?.(); return;
          }
          if (item.kind === 'get') { item.request.result = clone(records.get(item.id)); item.request.onsuccess?.(); }
          else pending.push(item);
        }
        if (mode === 'readwrite') {
          const notify = beforeCommit; beforeCommit = undefined; notify?.();
        }
        if (mode === 'readwrite') for (const item of pending) {
          if (item.kind === 'put') records.set(item.id, item.value);
          else records.delete(item.id);
        }
        committed = true;
        if (faults.holdCompletion) held.push(() => transaction.oncomplete?.());
        else transaction.oncomplete?.();
      };
      if (faults.holdTransaction) held.push(commit);
      else queueMicrotask(commit);
      return transaction;
    }
  };
  return { records, faults, calls, beforeCommit(work) { beforeCommit = work; }, release() { for (const work of held.splice(0)) work(); }, api: { open() {
    const request = {};
    const opened = () => {
      calls.push('open');
      if (faults.open) { request.onerror?.(); return; }
      request.result = database;
      if (!exists) request.onupgradeneeded?.();
      request.onsuccess?.();
    };
    if (faults.holdOpen) held.push(opened);
    else queueMicrotask(opened);
    return request;
  } } };
}

function harness(options = {}) {
  const storage = options.storage || memoryStorage(), idb = options.idb || indexedDatabase();
  let username = options.username || 'alice';
  const context = vm.createContext({ URL, URLSearchParams, Request, Headers, Response, Blob, FormData, TextEncoder, ArrayBuffer, Uint8Array,
    btoa, atob, console, AbortController, navigator: options.locks ? { locks: options.locks } : undefined,
    setTimeout: (callback, delay) => setTimeout(callback, options.fastTimeout && delay === 10000 ? 20 : delay), clearTimeout,
    localStorage: storage, sessionStorage: memoryStorage(),
    indexedDB: options.unavailable ? undefined : idb.api, __SANJIE_ENVIRONMENT: options.environment,
    location: { href: 'https://site.test/creative/labs/image-prompt-lab/promptlab.html', origin: 'https://site.test' },
    fetch: async () => Response.json({ data: { tenantId: 'shop', username, creativeEntitlement: { allowed: true } } }) });
  vm.runInContext(source, context, { filename: 'web-chrome.js' });
  return { context, local: context.chrome.storage.local, storage, idb, setUser(value) { username = value; } };
}

function screenshots(marker = 'a', chars = 6 * 1024 * 1024) {
  return { schema: 'REFERENCE_DETAIL_SCREENSHOT_SOURCE_V1', source: { sourceMode: 'screenshots' }, assets: [
    { assetId: 'learning-only', url: 'data:image/png;base64,' + marker.repeat(chars) }
  ] };
}

test('large screenshot sources roundtrip through IndexedDB without moving existing config or legacy values', async () => {
  const h = harness(), original = { apiKey: 'unchanged-original', model: 'original-model' };
  await h.local.set({ config: original });
  const sourceValue = screenshots();
  await h.local.set({ executionCache: { sourceSnapshot: sourceValue }, registration: { nested: { source: sourceValue } } });
  const value = await h.local.get(['executionCache', 'registration', 'config']);
  assert.deepEqual(clone(value.executionCache.sourceSnapshot), sourceValue);
  assert.deepEqual(clone(value.registration.nested.source), sourceValue);
  assert.deepEqual(clone(value.config), original);
  assert.equal(h.idb.records.size, 2);
  assert.ok([...h.storage.values.values()].every(raw => raw.length < 500));
  assert.ok([...h.storage.values.values()].some(raw => raw === JSON.stringify(original)));
  const reopened = harness({ storage: h.storage, idb: h.idb });
  assert.deepEqual(clone((await reopened.local.get('executionCache')).executionCache.sourceSnapshot), sourceValue);
  const all = await reopened.local.get(null);
  assert.deepEqual(Object.keys(all).sort(), ['config', 'executionCache', 'registration']);
  const key = [...h.storage.values.keys()].find(name => name.endsWith('config'));
  h.storage.setItem(key.replace(/config$/, 'old-small-screenshot'), JSON.stringify({ sourceSnapshot: screenshots('b', 32) }));
  assert.equal((await reopened.local.get('old-small-screenshot'))['old-small-screenshot'].sourceSnapshot.assets[0].url, 'data:image/png;base64,' + 'b'.repeat(32));
});

test('account and environment scope isolate reads, removals and clear', async () => {
  const storage = memoryStorage(), idb = indexedDatabase();
  const alice = harness({ storage, idb }), bob = harness({ storage, idb, username: 'bob' }), testEnvironment = harness({ storage, idb, environment: 'test' });
  await alice.local.set({ cache: { source: screenshots('a') }, config: 'alice-config' });
  await bob.local.set({ cache: { source: screenshots('b') }, config: 'bob-config' });
  await testEnvironment.local.set({ cache: { source: screenshots('c') }, config: 'test-config' });
  assert.ok((await alice.local.get('cache')).cache.source.assets[0].url.endsWith('aaaa'));
  assert.ok((await bob.local.get('cache')).cache.source.assets[0].url.endsWith('bbbb'));
  await alice.local.remove('cache');
  assert.deepEqual(clone(await alice.local.get('cache')), {});
  assert.equal(idb.records.size, 2);
  await bob.local.clear();
  assert.deepEqual(clone(await bob.local.get(null)), {});
  assert.equal((await alice.local.get('config')).config, 'alice-config');
  assert.equal((await testEnvironment.local.get('config')).config, 'test-config');
  assert.equal(idb.records.size, 1);
  alice.setUser('bob');
  await assert.rejects(alice.local.set({ cache: { source: screenshots() } }), /身份已失效/);
});

test('failed IndexedDB commit never creates a pointer or replaces existing normal records', async () => {
  const h = harness();
  await h.local.set({ cache: 'original-value', config: 'preserved-config' });
  h.idb.faults.write = true;
  await assert.rejects(h.local.set({ cache: { source: screenshots() }, config: 'new-config' }), /参考详情截图读写失败/);
  assert.equal((await h.local.get('cache')).cache, 'original-value');
  assert.equal((await h.local.get('config')).config, 'preserved-config');
  assert.equal(h.idb.records.size, 0);
});

test('failed pointer write removes only the new value and retains the old screenshot', async () => {
  const h = harness();
  await h.local.set({ cache: { source: screenshots('a') } });
  const before = [...h.storage.values.values()][0];
  h.storage.failWrite = true;
  await assert.rejects(h.local.set({ cache: { source: screenshots('b') } }), /QuotaExceededError/);
  assert.equal([...h.storage.values.values()][0], before);
  assert.equal(h.idb.records.size, 1);
  assert.ok((await h.local.get('cache')).cache.source.assets[0].url.endsWith('aaaa'));
  await h.local.set({ cache: { source: screenshots('c') } });
  assert.equal(h.idb.records.size, 1);
  assert.ok((await h.local.get('cache')).cache.source.assets[0].url.endsWith('cccc'));
});

test('missing or unreadable IndexedDB values fail explicitly for Promise and callback reads', async () => {
  const h = harness();
  await h.local.set({ cache: { source: screenshots() } });
  h.idb.faults.read = true;
  await assert.rejects(h.local.get({ cache: 'unsafe-empty-default' }), /参考详情截图读写失败/);
  let callbackValue = 'unread', callbackError;
  await h.local.get('cache', value => { callbackValue = value; callbackError = h.context.chrome.runtime.lastError?.message; });
  assert.equal(callbackValue, undefined);
  assert.match(callbackError, /参考详情截图读写失败/);
  h.idb.faults.read = false;
  h.idb.records.clear();
  await assert.rejects(h.local.get('cache'), /存储内容缺失/);
  assert.equal(h.storage.values.size, 1);
});

test('unavailable IndexedDB preserves ordinary config and rejects screenshot writes without fallback', async () => {
  const h = harness({ unavailable: true });
  await h.local.set({ config: { model: 'kept' } });
  assert.deepEqual(clone((await h.local.get('config')).config), { model: 'kept' });
  await assert.rejects(h.local.set({ cache: { source: screenshots() } }), /支持 IndexedDB/);
  assert.equal(h.storage.values.size, 1);
  assert.equal(h.idb.records.size, 0);
});

test('blocked IndexedDB is bounded while normal config reads remain available and late writes are ignored', async () => {
  for (const fault of ['holdOpen', 'holdTransaction']) {
    const h = harness({ fastTimeout: true });
    await h.local.set({ config: 'original-config' });
    h.idb.faults[fault] = true;
    const failed = assert.rejects(h.local.set({ cache: { source: screenshots() } }), /超时/);
    assert.equal((await h.local.get('config')).config, 'original-config');
    await failed;
    h.idb.release();
    assert.equal(h.idb.records.size, 0);
    assert.deepEqual(clone(await h.local.get('cache')), {});
    if (fault === 'holdOpen') assert.ok(h.idb.calls.includes('close'));
  }
});

test('a competing workspace change during IndexedDB write wins without resurrection or leftover records', async () => {
  for (const removed of [false, true]) {
    const h = harness();
    await h.local.set({ cache: 'old-value' });
    const key = [...h.storage.values.keys()][0];
    h.idb.beforeCommit(() => { if (removed) h.storage.removeItem(key); else h.storage.setItem(key, JSON.stringify('other-workspace-new-value')); });
    await assert.rejects(h.local.set({ cache: { source: screenshots() } }), /其他工作台变更/);
    assert.equal(h.storage.getItem(key), removed ? null : JSON.stringify('other-workspace-new-value'));
    assert.equal(h.idb.records.size, 0);
  }
});

test('multi-key quota failure reverses changes before restoring a large existing screenshot', async () => {
  const h = harness(), oldA = { source: screenshots('a', 4 * 1024 * 1024) };
  await h.local.set({ A: 'temporary', B: 'original-small-B' });
  const keyA = [...h.storage.values.keys()].find(key => key.endsWith(':A'));
  h.storage.setItem(keyA, JSON.stringify(oldA));
  const originals = [...h.storage.values.entries()];
  await assert.rejects(h.local.set({ A: { source: screenshots('b', 32) }, B: 'b'.repeat(3 * 1024 * 1024), C: 'c'.repeat(3 * 1024 * 1024) }), /QuotaExceededError/);
  assert.deepEqual([...h.storage.values.entries()], originals);
  assert.deepEqual(clone((await h.local.get('A')).A), oldA);
  assert.equal(h.idb.records.size, 0);
});

test('remove ignores duplicate keys and never recreates a pointer after uncertain cleanup', async () => {
  const h = harness();
  await h.local.set({ cache: { source: screenshots() }, config: 'preserved-config' });
  await h.local.remove(['cache', 'cache']);
  assert.deepEqual(clone(await h.local.get('cache')), {});
  assert.equal(h.idb.records.size, 0);
  await h.local.set({ cache: { source: screenshots() } });
  h.idb.faults.remove = true;
  await h.local.remove('cache');
  assert.deepEqual(clone(await h.local.get('cache')), {});
  assert.equal((await h.local.get('config')).config, 'preserved-config');
  assert.equal(h.idb.records.size, 1);
});

test('delete committed before a late completion event never restores a dangling pointer', async () => {
  const h = harness({ fastTimeout: true });
  await h.local.set({ cache: { source: screenshots() }, config: 'preserved-config' });
  h.idb.faults.holdCompletion = true;
  await h.local.remove('cache');
  assert.equal(h.idb.records.size, 0);
  assert.deepEqual(clone(await h.local.get('cache')), {});
  h.idb.release();
  assert.deepEqual(clone(await h.local.get('cache')), {});
  assert.equal((await h.local.get('config')).config, 'preserved-config');
});

test('Web Locks serialize screenshot mutations while ordinary config does not wait for the lock', async () => {
  const calls = [], locks = { async request(name, options, work) { calls.push({ name, mode: options.mode }); return work(); } };
  const h = harness({ locks });
  await h.local.set({ config: 'ordinary-config' });
  assert.equal(calls.length, 0);
  await h.local.set({ cache: { source: screenshots() } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, 'exclusive');
  await h.local.get('config');
  assert.equal(calls.length, 1);
  await h.local.remove('cache');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, calls[1].name);
  const heldLocks = { request(_name, options) { return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('AbortError')))); } };
  const held = harness({ locks: heldLocks, fastTimeout: true });
  await held.local.set({ config: 'kept' });
  const rejected = assert.rejects(held.local.set({ cache: { source: screenshots() } }), /存储锁等待超时/);
  assert.equal((await held.local.get('config')).config, 'kept');
  await rejected;
  assert.equal(held.idb.records.size, 0);
});
