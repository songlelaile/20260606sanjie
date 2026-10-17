'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../public/creative/labs/image-prompt-lab/sku-delivery-store.js'), 'utf8');
const clone = value => structuredClone(value);

// Requests execute asynchronously; writes remain staged until transaction commit.
// Serial readwrite transactions model the CAS guarantee provided by IndexedDB.
function mockIndexedDB() {
  const databases = new Map(), pending = [], calls = [];
  const faults = { open: false, blocked: false, holdOpen: false, holdTransaction: false, holdCompletion: false, read: false, put: false, remove: false };
  function open(name) {
    const request = {};
    const ready = () => {
      if (faults.blocked) { request.onblocked?.(); return; }
      if (faults.open) { request.error = Object.assign(new Error('open fixture'), { name: 'UnknownError' }); request.onerror?.(); return; }
      let state = databases.get(name), upgrade = !state;
      if (!state) { state = { records: new Map(), hasStore: false, busy: false, queue: [] }; databases.set(name, state); }
      const database = {
        objectStoreNames: { contains: () => state.hasStore },
        createObjectStore() { state.hasStore = true; },
        close() { calls.push({ kind: 'close', name }); },
        transaction(_store, mode) {
          const requests = [], staged = new Map();
          let active = false, aborted = false, finished = false, scheduled = false;
          const tx = { error: null, abort() {
            if (finished) throw new Error('InvalidStateError');
            aborted = true; calls.push({ kind: 'abort', name });
            if (active) release();
            queueMicrotask(() => tx.onabort?.());
          } };
          const requestFor = (kind, id, value) => {
            const request = {};
            requests.push({ kind, id, value: value == null ? value : clone(value), request });
            schedule(); return request;
          };
          tx.objectStore = () => ({
            get: id => requestFor('get', id),
            put: value => requestFor('put', value.id, value),
            delete: id => requestFor('remove', id)
          });
          function release() {
            if (!active) return;
            active = false; state.busy = false;
            const next = state.queue.shift(); if (next) queueMicrotask(next);
          }
          function commit() {
            if (finished || aborted) return;
            finished = true;
            for (const [id, value] of staged) value == null ? state.records.delete(id) : state.records.set(id, value);
            calls.push({ kind: 'commit', mode, name }); release();
            tx.oncomplete?.();
          }
          function drain() {
            scheduled = false;
            if (!active || aborted || finished) return;
            while (requests.length) {
              const { kind, id, value, request } = requests.shift();
              calls.push({ kind, name });
              if (faults[kind]) {
                tx.error = Object.assign(new Error('storage fault fixture'), { name: kind === 'put' ? 'QuotaExceededError' : 'UnknownError' });
                request.error = tx.error; request.onerror?.(); tx.onerror?.();
                if (!aborted) tx.abort(); return;
              }
              if (kind === 'get') request.result = clone(staged.has(id) ? staged.get(id) : state.records.get(id));
              else staged.set(id, kind === 'put' ? value : null);
              request.onsuccess?.();
              if (aborted) return;
            }
            if (faults.holdCompletion) pending.push(commit);
            else queueMicrotask(() => requests.length ? drain() : commit());
          }
          function schedule() {
            if (!active || scheduled || finished || aborted) return;
            scheduled = true; queueMicrotask(drain);
          }
          function start() {
            if (aborted) return;
            if (state.busy) { state.queue.push(start); return; }
            state.busy = true; active = true;
            if (faults.holdTransaction) pending.push(schedule); else schedule();
          }
          queueMicrotask(start); return tx;
        }
      };
      request.result = database;
      request.transaction = { abort() { calls.push({ kind: 'upgrade-abort', name }); } };
      if (upgrade) request.onupgradeneeded?.();
      request.onsuccess?.();
    };
    calls.push({ kind: 'open', name });
    if (faults.holdOpen) pending.push(ready); else queueMicrotask(ready);
    return request;
  }
  return { api: { open }, databases, calls, faults, release() { for (const work of pending.splice(0)) work(); } };
}
function harness(database = mockIndexedDB(), environment) {
  const timers = new Map(); let sequence = 0, clock = 0;
  const context = vm.createContext({ indexedDB: database.api, __SANJIE_ENVIRONMENT: environment,
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { at: clock + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    localStorage: { setItem() { throw new Error('localStorage is forbidden'); }, getItem() { throw new Error('localStorage is forbidden'); } },
    fetch() { throw new Error('Network is forbidden'); } });
  vm.runInContext(source, context);
  return { api: context.SZ_SKU_DELIVERY_STORE, database, timers, advance(ms) {
    clock += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.callback(); }
  } };
}
const fixture = () => ({ version: 1, state: 'delivered', createdAt: 1, jobId: 'job-original', taskId: 'provider-task',
  images: ['data:image/png;base64,' + 'A'.repeat(6 * 1024 * 1024)],
  skuProviderGeometry: { version: 'SKU_PROVIDER_GEOMETRY_V1', contractFingerprint: 'frozen-contract', adapter: 'generic-json', requestedSize: '1024*1024', effectiveSize: '1024*1024' },
  skuFrozenDelivery: { contract: { version: 'SKU_SUBJECT_REPLACE_V2', batchLockId: 'lock-original', contractFingerprint: 'frozen-contract',
    coordinateSpace: 'source-image', canvas: { ratio: '1:1', width: 900, height: 900, safeMargin: 40 },
    baseImageFingerprint: 'base', replacementSubjectFingerprint: 'subject', generatedSkuBadge: false,
    typography: { renderMode: 'preserve-base', addText: false, alterText: false },
    subject: { renderMode: 'provider-localized-replacement', replacementOnly: true, preservePlacement: true, preserveScale: true, preservePerspective: true,
      preserveLightingAndShadow: true, authorizedRegion: { x: .12, y: .18, w: .76, h: .72 },
      identityVerification: { required: true, version: 'SKU_SUBJECT_IDENTITY_V2', foregroundExtraction: 'client-fail-closed-v1',
        colorHistogram: 'rgb-4x4x4', edgeHistogram: 'orientation-8', contourDescriptor: 'projection-16', microTextGuard: 'candidate-reference-microtext-v1',
        minColorSimilarity: .34, minEdgeSimilarity: .34, minContourSimilarity: .46 } },
    variableWhitelist: { subjectIdentity: true, backgroundChanges: false, textChanges: false, layoutChanges: false, newProps: false, generatedLabels: false },
    immutableFromBase: ['背景', '文字'] }, outputResolution: 'custom', archiveBatchId: 'original-batch', archiveBatchTitle: '测试 SKU' } });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const small = () => ({ jobId: 'job-original', images: ['data:image/png;base64,AAA='] });

test('large original candidate survives a fresh store instance without localStorage or network', async () => {
  const h = harness(), input = fixture();
  assert.equal((await h.api.save('owner-A', 'receipt-key', input)).ok, true);
  input.images[0] = 'mutated'; input.skuFrozenDelivery.contract.canvas.width = 1000;
  const reread = await harness(h.database).api.read('owner-A', 'receipt-key');
  assert(reread.images[0].length > 6 * 1024 * 1024);
  assert.equal(reread.skuFrozenDelivery.contract.canvas.width, 900);
  reread.images[0] = 'second mutation';
  assert.notEqual((await h.api.read('owner-A', 'receipt-key')).images[0], 'second mutation');
  assert.equal(h.timers.size, 0);
});

test('owners and environment databases remain isolated for identical receipt keys', async () => {
  const db = mockIndexedDB(), prod = harness(db), preview = harness(db, 'sku-test');
  await prod.api.save('owner-A', 'same-key', small());
  assert.equal(await prod.api.read('owner-B', 'same-key'), null);
  assert.equal(await preview.api.read('owner-A', 'same-key'), null);
  await preview.api.save('owner-A', 'same-key', { jobId: 'preview-job', images: ['preview-image'] });
  assert.equal((await prod.api.read('owner-A', 'same-key')).jobId, 'job-original');
  assert.equal((await preview.api.read('owner-A', 'same-key')).jobId, 'preview-job');
  assert.deepEqual([...db.databases.keys()], ['sz_sku_delivery_v1', 'sz_sku_delivery_v1:environment:sku-test']);
});

test('job CAS preserves a newer delivery and returns only after deletion commits', async () => {
  const h = harness(); await h.api.save('owner-A', 'key', small());
  assert.equal((await h.api.remove('owner-A', 'key', 'older-job')).removed, false);
  assert.equal((await h.api.read('owner-A', 'key')).jobId, 'job-original');
  h.database.faults.holdCompletion = true;
  let completed = false;
  const removing = h.api.remove('owner-A', 'key', 'job-original').then(value => { completed = true; return value; });
  await flush(); assert.equal(completed, false);
  assert.equal([...h.database.databases.values()][0].records.size, 1);
  h.database.release(); assert.equal((await removing).removed, true);
  h.database.faults.holdCompletion = false;
  assert.equal(await h.api.read('owner-A', 'key'), null);
});

test('delivery writes are immutable, idempotent, and ordered independently of object property order', async () => {
  const h = harness(), value = small(); await h.api.save('owner-A', 'key', value);
  assert.equal((await h.api.save('owner-A', 'key', { images: value.images, jobId: value.jobId })).alreadySaved, true);
  await assert.rejects(h.api.save('owner-A', 'key', { jobId: 'new-job', images: ['different'] }), { code: 'SKU_DELIVERY_CONFLICT' });
  assert.equal((await h.api.read('owner-A', 'key')).jobId, 'job-original');
});

test('secret/config fields and accessors never enter persisted records', async () => {
  const h = harness(); let reads = 0;
  const value = small(); Object.defineProperty(value, 'apiKey', { enumerable: true, get() { reads++; return 'must-not-be-read'; } });
  await assert.rejects(h.api.save('owner-A', 'key', value), { code: 'SKU_DELIVERY_INVALID' });
  const nested = fixture(); nested.skuFrozenDelivery.contract.config = { apiKey: 'must-not-persist' };
  await assert.rejects(h.api.save('owner-A', 'key', nested), { code: 'SKU_DELIVERY_INVALID' });
  assert.equal(reads, 0); assert.equal(h.database.calls.length, 0);
});

test('confirmed left-side subject region survives delivery recovery and rejects flag accessors or secrets', async () => {
  const h = harness(), value = fixture(); value.images = small().images;
  value.skuFrozenDelivery.contract.subject.authorizedRegion = { x: .02, y: .08, w: .32, h: .68, confirmed: true };
  await h.api.save('owner-A', 'confirmed-region', value);
  const restored = await harness(h.database).api.read('owner-A', 'confirmed-region');
  assert.deepEqual(clone(restored.skuFrozenDelivery.contract.subject.authorizedRegion), { x: .02, y: .08, w: .32, h: .68, confirmed: true });
  const accessor = clone(value); let reads = 0;
  Object.defineProperty(accessor.skuFrozenDelivery.contract.subject.authorizedRegion, 'confirmed', { enumerable: true, get() { reads++; return true; } });
  await assert.rejects(h.api.save('owner-A', 'getter-region', accessor), { code: 'SKU_DELIVERY_INVALID' });
  const secret = clone(value); secret.skuFrozenDelivery.contract.subject.authorizedRegion.apiKey = 'must-not-persist';
  await assert.rejects(h.api.save('owner-A', 'secret-region', secret), { code: 'SKU_DELIVERY_INVALID' });
  const invalidFlag = clone(value); invalidFlag.skuFrozenDelivery.contract.subject.authorizedRegion.confirmed = 'true';
  await assert.rejects(h.api.save('owner-A', 'invalid-region', invalidFlag), { code: 'SKU_DELIVERY_INVALID' });
  assert.equal(reads, 0);
  assert.equal([...h.database.databases.values()][0].records.size, 1);
});

test('read and remove reject forged owner, key, id, or geometry metadata without deleting the record', async () => {
  for (const field of ['owner', 'key', 'id']) {
    const h = harness(); await h.api.save('owner-A', 'key', small());
    const records = [...h.database.databases.values()][0].records, id = JSON.stringify(['owner-A', 'key']);
    records.get(id)[field] = 'forged';
    await assert.rejects(h.api.read('owner-A', 'key'), { code: 'SKU_DELIVERY_IDENTITY_MISMATCH' });
    await assert.rejects(h.api.remove('owner-A', 'key', 'job-original'), { code: 'SKU_DELIVERY_IDENTITY_MISMATCH' });
    assert.equal(records.size, 1);
  }
  const h = harness(); await h.api.save('owner-A', 'key', fixture());
  [...h.database.databases.values()][0].records.values().next().value.delivery.skuProviderGeometry.contractFingerprint = 'wrong-contract';
  await assert.rejects(h.api.read('owner-A', 'key'), { code: 'SKU_DELIVERY_IDENTITY_MISMATCH' });
});

test('quota and removal failures reject atomically and keep existing deliveries', async () => {
  const h = harness(); await h.api.save('owner-A', 'old', small());
  h.database.faults.put = true;
  await assert.rejects(h.api.save('owner-A', 'new', small()), { code: 'SKU_DELIVERY_STORAGE_FAILED', causeName: 'QuotaExceededError' });
  h.database.faults.put = false;
  assert.equal(await h.api.read('owner-A', 'new'), null);
  h.database.faults.remove = true;
  await assert.rejects(h.api.remove('owner-A', 'old', 'job-original'), { code: 'SKU_DELIVERY_STORAGE_FAILED' });
  h.database.faults.remove = false;
  assert.equal((await h.api.read('owner-A', 'old')).jobId, 'job-original');
});

test('open and blocked errors terminate with no delivery write', async () => {
  for (const field of ['open', 'blocked']) {
    const h = harness(); h.database.faults[field] = true;
    await assert.rejects(h.api.save('owner-A', 'key', small()), { code: field === 'blocked' ? 'SKU_DELIVERY_OPEN_BLOCKED' : 'SKU_DELIVERY_STORAGE_FAILED' });
    assert.equal(h.timers.size, 0); assert(!h.database.calls.some(call => call.kind === 'put'));
  }
});

test('the exact ten-second open timeout closes a late connection without starting a transaction', async () => {
  const h = harness(); h.database.faults.holdOpen = true;
  const saving = h.api.save('owner-A', 'key', small());
  h.advance(9999); await flush();
  assert.equal(h.timers.size, 1);
  h.advance(1); await assert.rejects(saving, { code: 'SKU_DELIVERY_TIMEOUT' });
  h.database.release(); await flush();
  assert(!h.database.calls.some(call => call.kind === 'get' || call.kind === 'put'));
  assert(h.database.calls.some(call => call.kind === 'close'));
});

test('a hung write transaction times out, aborts, and cannot commit a late delivery', async () => {
  const h = harness(); h.database.faults.holdCompletion = true;
  const saving = h.api.save('owner-A', 'key', small()); await flush();
  assert(h.database.calls.some(call => call.kind === 'put'));
  assert.equal([...h.database.databases.values()][0].records.size, 0);
  h.advance(10000); await assert.rejects(saving, { code: 'SKU_DELIVERY_TIMEOUT' });
  h.database.release(); await flush();
  assert.equal([...h.database.databases.values()][0].records.size, 0);
  assert(h.database.calls.some(call => call.kind === 'abort'));
});
