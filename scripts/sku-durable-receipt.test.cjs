'use strict';

// Offline contract tests: real product functions and WebCrypto; transactions,
// authentication and transport are isolated fixtures. No HTTP is permitted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
function inputPath(variable, fallback, directory = false) {
  const value = process.env[variable] || fallback;
  assert.ok(path.isAbsolute(value), variable + ' must be an absolute local path');
  assert.ok(directory ? fs.statSync(value).isDirectory() : fs.statSync(value).isFile(), variable + ' must exist');
  return value;
}
const LAB = inputPath('SKU_DURABLE_LAB_ROOT', path.resolve(__dirname, '../public/creative/labs/image-prompt-lab'), true);
const selectedRuntime = process.env.SKU_DURABLE_RUNTIME_PATH ? inputPath('SKU_DURABLE_RUNTIME_PATH', process.env.SKU_DURABLE_RUNTIME_PATH) : null;
const DURABLE_SOURCE = fs.readFileSync(path.join(LAB, 'sku-durable-receipt.js'), 'utf8');
const PROMPTLAB_SOURCE = fs.readFileSync(path.join(LAB, 'promptlab.js'), 'utf8');
const DELIVERY_SOURCE = fs.readFileSync(path.join(LAB, 'sku-delivery-store.js'), 'utf8');
const BACKGROUND_SOURCE = fs.readFileSync(selectedRuntime || path.join(LAB, 'background.js'), 'utf8');
const PACKED_SOURCE = fs.readFileSync(selectedRuntime || path.resolve(__dirname,
  '../docs/uat-sku-workflow-20261012/production-overlay-v4/overlay/public/creative/labs/image-prompt-lab/studio-runtime-20261010-credit-v3.js'), 'utf8');
const copy = value => structuredClone(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const OWNER = 'sku-fixture:durable-alice';
const ENV = 'sku-durable-offline';

// Model IndexedDB's asynchronous requests, commit-only writes, index lookups
// and serialized readwrite transactions. A new VM shares only durable records.
function indexedDBFixture() {
  const databases = new Map(), calls = [], held = [];
  const faults = { put: false, add: false, open: false, read: false, holdCommit: false };
  function open(name) {
    const request = {};
    queueMicrotask(() => {
      calls.push({ kind: 'open', name });
      if (faults.open) {
        request.error = Object.assign(new Error('open denied'), { name: 'UnknownError' });
        request.onerror?.(); return;
      }
      let state = databases.get(name);
      const upgrade = !state;
      if (!state) {
        state = { stores: new Map(), busy: false, queue: [] };
        databases.set(name, state);
      }
      const database = {
        objectStoreNames: { contains: store => state.stores.has(store) },
        createObjectStore(store, options = {}) {
          const schema = { records: new Map(), keyPath: options.keyPath, indexes: new Map() };
          state.stores.set(store, schema);
          return { createIndex(index, keyPath) { schema.indexes.set(index, keyPath); } };
        },
        close() {},
        transaction(names, mode = 'readonly') {
          const staged = new Map(), pending = [];
          let active = false, aborted = false, finished = false, scheduled = false;
          const tx = { error: null, abort() {
            if (finished) throw new Error('InvalidStateError');
            if (aborted) return;
            aborted = true; release(); queueMicrotask(() => tx.onabort?.());
          } };
          function release() {
            if (!active) return;
            active = false; state.busy = false;
            const next = state.queue.shift(); if (next) queueMicrotask(next);
          }
          function commit() {
            if (aborted || finished) return;
            finished = true;
            for (const [store, writes] of staged) for (const [key, value] of writes) {
              if (value === null) state.stores.get(store).records.delete(key);
              else state.stores.get(store).records.set(key, value);
            }
            calls.push({ kind: 'commit', name, mode }); release(); tx.oncomplete?.();
          }
          function drain() {
            scheduled = false;
            if (!active || aborted || finished) return;
            while (pending.length) {
              const operation = pending.shift(), { kind, store, key, value, index, request } = operation;
              calls.push({ kind, name, store, key });
              const configuredFault = faults[kind];
              const shouldFail = typeof configuredFault === 'function' ? configuredFault(operation) : configuredFault;
              if (shouldFail || kind === 'get' && faults.read) {
                tx.error = request.error = Object.assign(new Error('storage fixture rejected'), {
                  name: kind === 'put' || kind === 'add' ? 'QuotaExceededError' : 'UnknownError'
                });
                request.onerror?.(); tx.onerror?.(); tx.abort(); return;
              }
              const schema = state.stores.get(store);
              if (!schema) throw new Error('No object store ' + store);
              let writes = staged.get(store);
              if (!writes) { writes = new Map(); staged.set(store, writes); }
              if (kind === 'get') {
                if (index) {
                  const values = new Map([...schema.records, ...writes]);
                  request.result = copy([...values.values()].find(item => item && item[schema.indexes.get(index)] === key));
                } else request.result = copy(writes.has(key) ? writes.get(key) : schema.records.get(key));
              } else {
                const exists = writes.has(key) ? writes.get(key) != null : schema.records.has(key);
                if (kind === 'add' && exists) {
                  tx.error = request.error = Object.assign(new Error('duplicate key'), { name: 'ConstraintError' });
                  request.onerror?.(); tx.onerror?.(); tx.abort(); return;
                }
                writes.set(key, kind === 'delete' ? null : copy(value));
              }
              request.onsuccess?.();
              if (aborted) return;
            }
            if (faults.holdCommit) held.push(commit);
            else queueMicrotask(() => pending.length ? drain() : commit());
          }
          function schedule() {
            if (!active || scheduled || aborted || finished) return;
            scheduled = true; queueMicrotask(drain);
          }
          function enqueue(kind, store, key, value, index) {
            const request = {};
            pending.push({ kind, store, key, value, index, request }); schedule(); return request;
          }
          tx.objectStore = store => {
            const schema = state.stores.get(store);
            if (!schema) throw new Error('No object store ' + store);
            return {
              get: key => enqueue('get', store, key),
              put: (value, key) => enqueue('put', store, key ?? value[schema.keyPath], value),
              add: (value, key) => enqueue('add', store, key ?? value[schema.keyPath], value),
              delete: key => enqueue('delete', store, key),
              index: index => ({ get: key => enqueue('get', store, key, null, index) })
            };
          };
          function start() {
            if (aborted) return;
            if (state.busy) { state.queue.push(start); return; }
            state.busy = active = true; schedule();
          }
          queueMicrotask(start); return tx;
        }
      };
      request.result = database;
      request.transaction = { abort() {} };
      if (upgrade) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  }
  return { api: { open }, databases, calls, faults,
    release() { for (const work of held.splice(0)) work(); },
    seedOriginal(owner, image, bytes, environment = ENV) {
      const name = 'sz_image_upload_originals_v1' + (environment ? ':environment:' + encodeURIComponent(environment) : '');
      let state = databases.get(name);
      if (!state) { state = { stores: new Map(), busy: false, queue: [] }; databases.set(name, state); }
      if (!state.stores.has('originals')) state.stores.set('originals', {
        keyPath: 'id', indexes: new Map([['derivative', 'derivative']]), records: new Map()
      });
      const derivative = owner + ':' + sha(image), hash = sha(bytes);
      const record = { id: owner + ':' + hash + ':' + derivative, accountKey: owner, derivative,
        hash, blob: new Blob([bytes], { type: 'image/jpeg' }), type: 'image/jpeg', bytes: bytes.length,
        name: 'original-offline.jpg', createdAt: 1 };
      state.stores.get('originals').records.set(record.id, record);
      return record;
    }
  };
}

function harness(database = indexedDBFixture(), environment = ENV) {
  const context = vm.createContext({ indexedDB: database.api, __SANJIE_ENVIRONMENT: environment,
    crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Blob, URL,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    setTimeout, clearTimeout,
    localStorage: { getItem() { throw new Error('helper must not use localStorage'); },
      setItem() { throw new Error('helper must not use localStorage'); } },
    fetch() { throw new Error('network is forbidden'); }
  });
  vm.runInContext(DURABLE_SOURCE, context,
    { filename: 'actual sku-durable-receipt.js' });
  assert.ok(context.SZ_SKU_DURABLE_RECEIPT, 'actual durable receipt API must load');
  return { api: context.SZ_SKU_DURABLE_RECEIPT, database, context };
}

function materialFixture(database, owner = OWNER, environment = ENV) {
  const baseBytes = Buffer.from('SKU original base bytes\0contract fixture');
  const subjectBytes = Buffer.from('SKU original subject bytes\0contract fixture');
  const baseImage = 'data:image/jpeg;base64,' + baseBytes.toString('base64');
  const subjectImage = 'data:image/jpeg;base64,' + subjectBytes.toString('base64');
  const baseOriginal = database.seedOriginal(owner, baseImage, baseBytes, environment);
  const subjectOriginal = database.seedOriginal(owner, subjectImage, subjectBytes, environment);
  return { baseImage, subjectImage, baseBytes, subjectBytes, baseOriginal, subjectOriginal };
}

const flush = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };

function paramsFor(database, overrides = {}) {
  const owner = overrides.owner || OWNER, environment = overrides.environment === undefined ? ENV : overrides.environment;
  const materials = materialFixture(database, owner, environment);
  const contract = { version: 'SKU_SUBJECT_REPLACE_V2', batchLockId: 'frozen-lock', contractFingerprint: 'frozen-visual-lock',
    coordinateSpace: 'source-image', canvas: { ratio: '1:1', width: 1000, height: 1000, safeMargin: 40 },
    baseImageFingerprint: 'base-input', replacementSubjectFingerprint: 'subject-input', generatedSkuBadge: false,
    typography: { renderMode: 'preserve-base', addText: false, alterText: false },
    subject: { renderMode: 'provider-localized-replacement', replacementOnly: true, preservePlacement: true,
      preserveScale: true, preservePerspective: true, preserveLightingAndShadow: true,
      authorizedRegion: { x: .032, y: .245, w: .627, h: .541, confirmed: true } },
    variableWhitelist: { subjectIdentity: true, backgroundChanges: false, textChanges: false, layoutChanges: false,
      newProps: false, generatedLabels: false }, immutableFromBase: ['背景', '文字', '图标'] };
  const params = { owner, legacyKey: 'sz.legacy-image-receipt.v1:' + encodeURIComponent(owner) + ':' + 'b'.repeat(64),
    jobId: 'sku-job-original', batchId: 'sku-batch-original', baseImage: materials.baseImage, subjectImage: materials.subjectImage,
    providerImages: { base: materials.baseImage, subject: materials.subjectImage },
    contract, geometry: { version: 'SKU_PROVIDER_GEOMETRY_V1', contractFingerprint: contract.contractFingerprint,
      adapter: 'generic-json', requestedSize: '1024*1024', effectiveSize: '1024*1024' },
    output: { size: '1000*1000', ratio: '1:1', resolution: 'custom', width: 1000, height: 1000 },
    prompt: 'Replace only the subject within the confirmed region; preserve every other template detail.',
    negativePrompt: 'No new text, label, background or props.',
    model: { provider: 'generic', imageAdapter: 'generic-json', imageEndpoint: 'https://fixture.invalid/images', imageModel: 'fixture-model' },
    snapshot: { skuId: 'import-slot-original', skuCode: '90cm', title: '90cm主图旗舰款52m³-长灯AI声控-漏气感应-【上门安装】',
      attribute: '90cm', index: 0, archiveBatchTitle: '真实 SKU 合同离线测试' } };
  return { params, materials };
}

function payloadFor(entry) {
  const snap = entry.snapshot;
  return { labMode: 'sku', detailMode: 'sku', promptSource: 'sku', skuDurablePlan: copy(entry.plan),
    skuSourceImages: { base: snap.baseImage, subject: snap.subjectImage },
    batchId: entry.identity.batchId, editBaseImage: snap.providerImages?.base || snap.baseImage,
    productImage: snap.providerImages?.subject || snap.subjectImage,
    productImages: [snap.providerImages?.subject || snap.subjectImage], prompt: snap.prompt, negativePrompt: snap.negativePrompt,
    skuVisualLock: copy(snap.contract), outputSize: snap.output.size, outputRatio: snap.output.ratio,
    outputResolution: snap.output.resolution, size: snap.geometry.requestedSize };
}
function sortedJson(value) {
  if (Array.isArray(value)) return '[' + value.map(sortedJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + sortedJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function rawEntry(database, owner, key) {
  const state = database.databases.get('sz_sku_durable_receipt_v1:environment:' + encodeURIComponent(ENV));
  return state.stores.get('entries').records.get(JSON.stringify(['receipt', owner, key]));
}

test('nine-field identity and original frozen SKU plan remain stable after reload and reimport', async () => {
  const h = harness(), { params, materials } = paramsFor(h.database);
  const first = await h.api.prepare(params);
  assert.deepEqual(Object.keys(first.identity).sort(), ['version','receiptId','jobId','accountKey','workspaceKey','taskId','shotId','batchId','planSignatureHash'].sort());
  assert.match(first.identity.receiptId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(first.identity.accountKey, OWNER); assert.equal(first.identity.jobId, params.jobId);
  assert.equal(first.identity.shotId, 'subject-replace'); assert.equal(first.state, 'prepared');
  assert.equal(first.identity.planSignatureHash, sha(sortedJson(first.plan)), 'independent canonical SHA must match');
  assert.equal(first.plan.sources.base.originalSha256, sha(materials.baseBytes));
  assert.equal(first.plan.sources.subject.originalSha256, sha(materials.subjectBytes));
  assert.equal(first.plan.sources.base.derivativeSha256, sha(params.baseImage));
  assert.equal(first.plan.providerInputs.subjectSha256, sha(materials.subjectBytes));
  const changed = copy(params); changed.jobId = 'fresh-page-job'; changed.batchId = 'fresh-page-batch';
  changed.snapshot = { ...changed.snapshot, skuId: 'reimported-slot', index: 18, title: 'new visible name' };
  const second = await harness(h.database).api.prepare(changed);
  assert.deepEqual(copy(second.identity), copy(first.identity)); assert.deepEqual(copy(second.snapshot), copy(first.snapshot));
  assert.equal((await h.api.validate(payloadFor(first), params.model, OWNER, first.identity)).ok, true);
  first.identity.jobId = 'caller-mutated'; first.snapshot.prompt = 'caller-mutated';
  const persisted = await harness(h.database).api.read(OWNER, params.legacyKey);
  assert.equal(persisted.identity.jobId, params.jobId); assert.equal(persisted.snapshot.prompt, params.prompt);
});

test('concurrent preparations converge on one committed immutable UUID', async () => {
  const h = harness(), { params } = paramsFor(h.database);
  const outcomes = await Promise.allSettled([h.api.prepare(params), harness(h.database).api.prepare({ ...params, jobId: 'racing-job' })]);
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 0,
    outcomes.map(result => result.status === 'rejected' ? result.reason.code + ':' + result.reason.message : 'ok').join(','));
  const receipts = outcomes.map(result => result.value.identity.receiptId);
  assert.equal(new Set(receipts).size, 1);
  assert.equal((await h.api.read(OWNER, params.legacyKey)).identity.receiptId, receipts[0]);
});

test('dispatch CAS permits one POST across simultaneous callers and reload', async () => {
  const h = harness(), { params } = paramsFor(h.database), entry = await h.api.prepare(params), posts = [];
  async function guardedPost(api) {
    const claim = await api.markDispatched(OWNER, params.legacyKey, entry.identity.receiptId);
    if (claim.ok && claim.dispatched) posts.push(copy(entry.identity));
    return claim;
  }
  const results = await Promise.all([guardedPost(h.api), guardedPost(harness(h.database).api)]);
  assert.equal(results.filter(result => result.ok).length, 1); assert.equal(posts.length, 1);
  assert.equal((await guardedPost(harness(h.database).api)).ok, false); assert.equal(posts.length, 1);
  assert.equal((await h.api.read(OWNER, params.legacyKey)).state, 'dispatched');
});

test('plan rejects changed owner, bytes, region, output, prompt and model before dispatch', async () => {
  const h = harness(), { params } = paramsFor(h.database), entry = await h.api.prepare(params);
  const variants = [
    ['owner', (_payload, _config, variant) => { variant.owner = 'sku-fixture:durable-bob'; }],
    ['source bytes', payload => { payload.productImage = payload.productImages[0] = 'data:image/jpeg;base64,Y2hhbmdlZA=='; }],
    ['swapped roles', payload => { [payload.editBaseImage, payload.productImage] = [payload.productImage, payload.editBaseImage]; payload.productImages = [payload.productImage]; }],
    ['region', payload => { payload.skuVisualLock.subject.authorizedRegion.x = .05; }],
    ['output', payload => { payload.outputSize = '900*900'; }],
    ['prompt', payload => { payload.prompt += ' Add title to the image.'; }],
    ['model', (_payload, config) => { config.imageModel = 'other-model'; }],
    ['endpoint', (_payload, config) => { config.imageEndpoint = 'https://other-fixture.invalid/images'; }],
    ['extra source', payload => { payload.referenceImages = [payload.editBaseImage]; }]
  ];
  for (const [name, mutate] of variants) {
    const payload = payloadFor(entry), config = copy(params.model), variant = { owner: OWNER };
    mutate(payload, config, variant);
    assert.equal((await h.api.validate(payload, config, variant.owner, entry.identity)).ok, false, name);
  }
  assert.equal((await h.api.read(OWNER, params.legacyKey)).state, 'prepared');
});

test('original owner/id/declared SHA and actual blob bytes cannot be forged', async () => {
  for (const field of ['accountKey', 'id', 'hash', 'blob', 'bytes']) {
    const h = harness(), { params, materials } = paramsFor(h.database);
    if (field === 'blob') materials.subjectOriginal.blob = new Blob([Buffer.alloc(materials.subjectBytes.length, 7)]);
    else if (field === 'bytes') materials.subjectOriginal.bytes++;
    else materials.subjectOriginal[field] = field === 'hash' ? 'a'.repeat(64) : 'forged';
    await assert.rejects(h.api.prepare(params), error => ['SKU_RECEIPT_ORIGINAL_REQUIRED','SKU_RECEIPT_ORIGINAL_MISMATCH'].includes(error.code), field);
    const state = h.database.databases.get('sz_sku_durable_receipt_v1:environment:' + ENV);
    assert.ok(!state || state.stores.get('entries').records.size === 0, 'forged original cannot reserve or submit');
  }
});

test('signed forged source metadata still fails when actual originals do not match', async () => {
  const h = harness(), { params } = paramsFor(h.database), entry = await h.api.prepare(params), payload = payloadFor(entry);
  payload.skuDurablePlan.sources.subject.originalSha256 = 'f'.repeat(64);
  const dto = copy(entry.identity); dto.planSignatureHash = sha(sortedJson(payload.skuDurablePlan));
  assert.equal((await h.api.validate(payload, params.model, OWNER, dto)).ok, false);
});

test('different provider carrier bytes stay distinct from retained original sources and cannot replace their owner binding', async () => {
  const h = harness(), { params, materials } = paramsFor(h.database);
  const carrier = Buffer.from('controlled 1024 carrier bytes, distinct from the 1000 original');
  params.providerImages.base = 'data:image/png;base64,' + carrier.toString('base64');
  const entry = await h.api.prepare(params), payload = payloadFor(entry);
  assert.equal(entry.plan.sources.base.originalSha256, sha(materials.baseBytes));
  assert.equal(entry.plan.sources.base.derivativeSha256, sha(params.baseImage));
  assert.equal(entry.plan.providerInputs.baseSha256, sha(carrier));
  assert.notEqual(entry.plan.providerInputs.baseSha256, entry.plan.sources.base.originalSha256);
  assert.equal((await h.api.validate(payload, params.model, OWNER, entry.identity)).ok, true);
  for (const mutation of ['source_replaced_by_carrier', 'provider_replaced_by_source', 'provider_roles_swapped', 'source_roles_swapped']) {
    const value = copy(payload);
    if (mutation === 'source_replaced_by_carrier') value.skuSourceImages.base = params.providerImages.base;
    if (mutation === 'provider_replaced_by_source') value.editBaseImage = params.baseImage;
    if (mutation === 'provider_roles_swapped') {
      [value.editBaseImage, value.productImage] = [value.productImage, value.editBaseImage]; value.productImages = [value.productImage];
    }
    if (mutation === 'source_roles_swapped') [value.skuSourceImages.base, value.skuSourceImages.subject] = [value.skuSourceImages.subject, value.skuSourceImages.base];
    assert.equal((await h.api.validate(value, params.model, OWNER, entry.identity)).ok, false, mutation);
  }
});

test('owner and environment isolate durable receipts even for an identical local key', async () => {
  const h = harness(), { params } = paramsFor(h.database), entry = await h.api.prepare(params);
  assert.equal(await h.api.read('sku-fixture:durable-bob', params.legacyKey), null);
  assert.equal(await harness(h.database, 'other-environment').api.read(OWNER, params.legacyKey), null);
  assert.equal((await harness(h.database).api.read(OWNER, params.legacyKey)).identity.receiptId, entry.identity.receiptId);
});

test('quota failure cannot produce a dispatchable identity or partial journal commit', async () => {
  const h = harness(), { params } = paramsFor(h.database); h.database.faults.put = true;
  await assert.rejects(h.api.prepare(params), { code: 'SKU_RECEIPT_STORAGE_FAILED' });
  h.database.faults.put = false;
  assert.equal(await h.api.read(OWNER, params.legacyKey), null);
  assert.equal((await h.api.markDispatched(OWNER, params.legacyKey, '6f8bc66d-517b-4a2e-a96e-ce1a9a5c218b')).ok, false);
  const state = h.database.databases.get('sz_sku_durable_receipt_v1:environment:' + ENV);
  assert.equal(state.stores.get('entries').records.size, 0);
});

test('journal tampering rejects reads and cannot advance its dispatch state', async () => {
  for (const field of ['owner', 'key', 'id', 'identity', 'snapshot']) {
    const h = harness(), { params } = paramsFor(h.database), entry = await h.api.prepare(params);
    const raw = rawEntry(h.database, OWNER, params.legacyKey);
    if (field === 'identity') raw.identity.planSignatureHash = '0'.repeat(64);
    else if (field === 'snapshot') raw.snapshot.output.size = '900*900';
    else raw[field] = 'forged';
    await assert.rejects(h.api.read(OWNER, params.legacyKey), { code: 'SKU_RECEIPT_PLAN_INVALID' });
    await assert.rejects(h.api.markDispatched(OWNER, params.legacyKey, entry.identity.receiptId));
    assert.equal(raw.state, 'prepared');
  }
});

test('receipt UUID CAS preserves an unacknowledged original against foreign or stale acknowledgments', async () => {
  const h = harness(), { params } = paramsFor(h.database), entry = await h.api.prepare(params);
  await h.api.markDispatched(OWNER, params.legacyKey, entry.identity.receiptId);
  assert.equal((await h.api.ack(OWNER, params.legacyKey, '6f8bc66d-517b-4a2e-a96e-ce1a9a5c218b')).ok, false);
  assert.equal((await h.api.ack('sku-fixture:durable-bob', params.legacyKey, entry.identity.receiptId)).ok, false);
  assert.equal((await h.api.read(OWNER, params.legacyKey)).state, 'dispatched');
  assert.equal((await h.api.ack(OWNER, params.legacyKey, entry.identity.receiptId)).ok, true);
  assert.equal((await h.api.read(OWNER, params.legacyKey)).state, 'acknowledged');
});

function noSubmissionProof(identity) {
  return { ok: false, code: 'SKU_RECEIPT_PLAN_REJECTED', noSubmission: true, providerSubmitted: false,
    definitiveFailure: true, stateUncertain: false, jobId: identity.jobId, receiptIdentity: copy(identity) };
}

test('only exact bound backend no-submission proof can release a dispatched receipt', async () => {
  const h = harness(), { params } = paramsFor(h.database), entry = await h.api.prepare(params);
  await h.api.markDispatched(OWNER, params.legacyKey, entry.identity.receiptId);
  const valid = noSubmissionProof(entry.identity);
  const variants = [undefined, { ...valid, noSubmission: false }, { ...valid, providerSubmitted: true },
    { ...valid, definitiveFailure: false }, { ...valid, stateUncertain: true }, { ...valid, code: 'network_failed' },
    { ...valid, jobId: 'other-job' }, { ...valid, receiptIdentity: { ...valid.receiptIdentity, jobId: 'other-job' } },
    { ...valid, receiptIdentity: { ...valid.receiptIdentity, extra: true } }, { ...valid, receiptIdentity: undefined }];
  for (const proof of variants) {
    assert.equal((await h.api.releaseNotSubmitted(OWNER, params.legacyKey, entry.identity.receiptId, proof)).ok, false);
    assert.equal((await h.api.read(OWNER, params.legacyKey)).state, 'dispatched');
    assert.equal(await h.api.readAudit(OWNER, entry.identity.receiptId), null);
  }
  assert.equal((await h.api.releaseNotSubmitted(OWNER, params.legacyKey, entry.identity.receiptId, valid)).ok, true);
  const audit = await h.api.readAudit(OWNER, entry.identity.receiptId);
  assert.deepEqual(copy(audit.identity), copy(entry.identity)); assert.deepEqual(copy(audit.plan), copy(entry.plan));
  assert.equal(audit.schema, 'SKU_RECEIPT_NO_SUBMISSION_AUDIT_V1'); assert.equal(audit.reason, valid.code);
});

test('second audit-transaction put quota failure preserves active protection and leaves no partial audit', async () => {
  const h = harness(), { params } = paramsFor(h.database), entry = await h.api.prepare(params);
  await h.api.markDispatched(OWNER, params.legacyKey, entry.identity.receiptId);
  let writes = 0; h.database.faults.put = () => ++writes === 2;
  await assert.rejects(h.api.releaseNotSubmitted(OWNER, params.legacyKey, entry.identity.receiptId, noSubmissionProof(entry.identity)),
    { code: 'SKU_RECEIPT_STORAGE_FAILED' });
  h.database.faults.put = false;
  assert.equal(writes, 2); assert.equal((await h.api.read(OWNER, params.legacyKey)).state, 'dispatched');
  assert.equal(await h.api.readAudit(OWNER, entry.identity.receiptId), null);
});

test('audit owner and signed plan validation reject tampering after a no-submission release', async () => {
  const h = harness(), { params } = paramsFor(h.database), entry = await h.api.prepare(params);
  await h.api.markDispatched(OWNER, params.legacyKey, entry.identity.receiptId);
  await h.api.releaseNotSubmitted(OWNER, params.legacyKey, entry.identity.receiptId, noSubmissionProof(entry.identity));
  assert.equal(await h.api.readAudit('sku-fixture:durable-bob', entry.identity.receiptId), null);
  const state = h.database.databases.get('sz_sku_durable_receipt_v1:environment:' + ENV);
  const raw = state.stores.get('entries').records.get(JSON.stringify(['audit', OWNER, entry.identity.receiptId]));
  raw.plan.model.imageModel = 'forged-model';
  await assert.rejects(h.api.readAudit(OWNER, entry.identity.receiptId), { code: 'SKU_RECEIPT_PLAN_INVALID' });
});

test('getter and secret fields fail before storage and never enter the journal', async () => {
  const h = harness(), { params } = paramsFor(h.database); let reads = 0;
  Object.defineProperty(params.model, 'apiKey', { enumerable: true, get() { reads++; return 'do-not-read'; } });
  await assert.rejects(h.api.prepare(params), { code: 'SKU_RECEIPT_PLAN_INVALID' });
  assert.equal(reads, 0); assert.equal(h.database.calls.length, 0);
  const second = paramsFor(h.database).params; second.snapshot.config = { apiKey: 'must-not-store' };
  await assert.rejects(h.api.prepare(second), { code: 'SKU_RECEIPT_PLAN_INVALID' });
  assert.equal(h.database.calls.length, 0);
});

test('new durable SKU preparation requires an explicitly confirmed subject region', async () => {
  for (const confirmation of [false, undefined]) {
    const h = harness(), { params } = paramsFor(h.database);
    if (confirmation === undefined) delete params.contract.subject.authorizedRegion.confirmed;
    else params.contract.subject.authorizedRegion.confirmed = confirmation;
    await assert.rejects(h.api.prepare(params), { code: 'SKU_RECEIPT_PLAN_INVALID' });
    assert.equal(h.database.calls.filter(call => call.kind === 'put').length, 0);
  }
});

test('immutable-base arrays reject getter, holes and extra properties without reading an accessor', async () => {
  for (const variant of ['getter', 'hole', 'extra']) {
    const h = harness(), { params } = paramsFor(h.database); let reads = 0;
    if (variant === 'getter') Object.defineProperty(params.contract.immutableFromBase, '0', {
      enumerable: true, get() { reads++; return 'must-not-read'; }
    });
    if (variant === 'hole') delete params.contract.immutableFromBase[0];
    if (variant === 'extra') params.contract.immutableFromBase.apiKey = 'must-not-persist';
    await assert.rejects(h.api.prepare(params), { code: 'SKU_RECEIPT_PLAN_INVALID' });
    assert.equal(reads, 0); assert.equal(h.database.calls.length, 0);
  }
});

const realDirectory = process.env.SKU_REAL_ASSETS || '/Users/shaozhuang/Downloads/SKU测试';
const realNames = ['参考图.jpg', '白底1.jpg', '白底2.jpg'];
test('actual template and both white-background originals produce owner-bound separate SKU plans',
  { skip: !realNames.every(name => fs.existsSync(path.join(realDirectory, name))) }, async () => {
    const h = harness(), { params } = paramsFor(h.database);
    const originals = realNames.map(name => fs.readFileSync(path.join(realDirectory, name)));
    const images = originals.map(bytes => 'data:image/jpeg;base64,' + bytes.toString('base64'));
    images.forEach((image, index) => h.database.seedOriginal(OWNER, image, originals[index]));
    const entries = [];
    for (let index = 1; index < originals.length; index++) {
      const value = copy(params);
      value.baseImage = images[0]; value.subjectImage = images[index];
      value.providerImages = { base: images[0], subject: images[index] };
      value.legacyKey = params.legacyKey + ':real-' + index; value.jobId = 'offline-real-job-' + index;
      value.snapshot.skuId = 'white-' + index; value.snapshot.index = index - 1;
      const entry = await h.api.prepare(value); entries.push(entry);
      assert.equal(entry.plan.sources.base.originalSha256, sha(originals[0]));
      assert.equal(entry.plan.sources.subject.originalSha256, sha(originals[index]));
      assert.equal(entry.plan.providerInputs.baseSha256, sha(originals[0]));
      assert.equal(entry.plan.providerInputs.subjectSha256, sha(originals[index]));
      assert.equal(entry.plan.sources.subject.derivativeSha256, sha(images[index]));
      assert.equal(entry.identity.planSignatureHash, sha(sortedJson(entry.plan)));
      assert.deepEqual(copy(entry.plan.contract.subject.authorizedRegion), { x: .032, y: .245, w: .627, h: .541, confirmed: true });
      assert.equal(entry.plan.output.size, '1000*1000');
      assert.equal((await h.api.validate(payloadFor(entry), value.model, OWNER, entry.identity)).ok, true);
      assert.equal(entry.snapshot.metadata.title, params.snapshot.title);
      assert.equal(entry.snapshot.prompt.includes(params.snapshot.title), false);
    }
    assert.equal(entries[0].identity.workspaceKey, entries[1].identity.workspaceKey);
    assert.notEqual(entries[0].identity.taskId, entries[1].identity.taskId);
    assert.notEqual(entries[0].identity.receiptId, entries[1].identity.receiptId);
    assert.notEqual(entries[0].identity.planSignatureHash, entries[1].identity.planSignatureHash);
  });

function legacyHarness(markers = new Map(), options = {}) {
  const source = PROMPTLAB_SOURCE;
  const begin = source.indexOf("var LEGACY_IMAGE_RECEIPT_PREFIX =");
  const end = source.indexOf('\nfunction send(type, payload)', begin);
  assert.ok(begin >= 0 && end > begin, 'actual legacy receipt integration must be present');
  const calls = [], state = { archiveAccountKey: OWNER, stopRequested: false, cancelledJobs: {}, skuBatchToken: 1,
    skuActive: false, skuProducts: [], skuMax: 20, skuTaskStatus: {}, skuSelections: {}, skuResults: [], skuActiveJobIds: {} };
  const context = vm.createContext({ state, crypto: webcrypto, TextEncoder, Uint8Array, Blob, URL,
    __SANJIE_ENVIRONMENT: ENV,
    chrome: { runtime: { id: 'shaozhuang-web-studio' } },
    indexedDB: options.database?.api, setTimeout, clearTimeout,
    creativeWebAccountKey: async () => options.liveOwner ? options.liveOwner() : String(state.archiveAccountKey),
    navigator: { locks: { request(key, options, callback) { calls.push({ type: 'lock', key, options }); return Promise.resolve(callback({ name: key })); } } },
    localStorage: { get length() { return markers.size; }, key: index => [...markers.keys()][index] ?? null,
      getItem: key => markers.get(key) ?? null,
      setItem(key, value) { calls.push({ type: 'marker-write', key }); markers.set(key, value); },
      removeItem(key) { calls.push({ type: 'marker-remove', key }); markers.delete(key); } },
    SZ_SKU_DELIVERY_STORE: { async read() { return null; } },
    SZ_SKU_DURABLE_RECEIPT: options.durableAPI || {
      async read(owner, key) { calls.push({ type: 'durable-read', owner, key }); return null; },
      async prepare() { calls.push({ type: 'prepare' }); throw new Error('old unknown must not receive a fabricated identity'); },
      async markDispatched() { calls.push({ type: 'markDispatched' }); throw new Error('old unknown cannot submit'); },
      async ack() { calls.push({ type: 'ack' }); throw new Error('old unknown cannot clear'); },
      async releaseNotSubmitted() { calls.push({ type: 'releaseNotSubmitted' }); throw new Error('old unknown cannot release'); }
    },
    sendRuntime(type, request) {
      calls.push({ type, request: copy(request) });
      if (options.transport) return Promise.resolve(options.transport(type, request));
      throw new Error('original unknown must not submit or recover with invented DTO');
    },
    fetch() { throw new Error('network is forbidden'); }
  });
  if (options.database) vm.runInContext(DELIVERY_SOURCE, context, { filename: 'actual sku-delivery-store.js' });
  vm.runInContext(source.slice(begin, end), context, { filename: 'actual legacy receipt integration' });
  return { context, state, markers, calls,
    key: request => context.legacyImageReceiptKey(OWNER, request),
    run: request => context.sendLegacyImage(request),
    ack: response => context.acknowledgeSkuDelivery(response) };
}

function durableRequest(params) {
  const preparation = copy(params); delete preparation.owner; delete preparation.legacyKey;
  return { jobId: params.jobId, _skuBatchToken: 1, _skuArchiveBatchId: params.batchId,
    _skuArchiveBatchTitle: params.snapshot.archiveBatchTitle, _skuDurablePreparation: preparation,
    config: { ...params.model, apiKey: 'synthetic-key-not-persisted' },
    payload: { labMode: 'sku', detailMode: 'sku', promptSource: 'sku', skuId: 'stable-input-fingerprint',
      skuSourceImages: { base: params.baseImage, subject: params.subjectImage },
      editBaseImage: params.providerImages.base, productImage: params.providerImages.subject, productImages: [params.providerImages.subject],
      prompt: params.prompt, negativePrompt: params.negativePrompt, skuVisualLock: copy(params.contract),
      outputSize: params.output.size, outputRatio: params.output.ratio, outputResolution: params.output.resolution,
      size: params.geometry.requestedSize, ratio: params.output.ratio, resolution: '1K', count: 1 } };
}

test('actual SKU integration sends one POST and recovers the exact original nine-field receipt with GET after reload', async () => {
  const db = indexedDBFixture(), helper = harness(db), { params } = paramsFor(db), markers = new Map();
  const transportCalls = [];
  let submittedIdentity;
  function transport(type, request) {
    transportCalls.push({ type, request: copy(request) });
    if (type === 'GET_SKU_RECEIPT_CAPABILITY') return { ok: true, supported: true };
    if (type === 'GENERATE_IMAGE') {
      submittedIdentity = copy(request.receiptIdentity);
      assert.equal(Object.keys(submittedIdentity).length, 9);
      assert.equal(submittedIdentity.planSignatureHash, sha(sortedJson(request.payload.skuDurablePlan)));
      assert.equal(request.payload.editBaseImage, params.baseImage); assert.equal(request.payload.productImage, params.subjectImage);
      return { ok: false, stateUncertain: true, code: 'fixture-disconnected', jobId: request.jobId };
    }
    if (type === 'GET_IMAGE_RECEIPT') {
      assert.deepEqual(copy(request.receiptIdentity), submittedIdentity);
      return { ok: true, state: 'complete', receipt: copy(submittedIdentity), resultSha256: 'd'.repeat(64),
        billingEventId: '6f8bc66d-517b-4a2e-a96e-ce1a9a5c218b', images: ['data:image/png;base64,aW1hZ2U='] };
    }
    throw new Error('unexpected transport ' + type);
  }
  const first = legacyHarness(markers, { database: db, durableAPI: helper.api, transport });
  const request = durableRequest(params), result = await first.run(request);
  assert.equal(result.stateUncertain, true);
  assert.equal(transportCalls.filter(call => call.type === 'GENERATE_IMAGE').length, 1);
  const key = await first.key(request), marker = JSON.parse(markers.get(key));
  assert.equal(marker.receiptId, submittedIdentity.receiptId); assert.equal(marker.jobId, params.jobId);
  const fresh = legacyHarness(markers, { database: db, durableAPI: harness(db).api, transport });
  const changed = durableRequest(params); changed.jobId = 'new-page-attempt'; changed._skuArchiveBatchId = 'new-page-batch';
  changed._skuDurablePreparation.output = { size: '900*900', ratio: '1:1', resolution: 'custom', width: 900, height: 900 };
  const recovered = await fresh.run(changed);
  assert.equal(recovered.ok, true); assert.equal(recovered.recoveredDelivery, true);
  assert.deepEqual(copy(recovered._skuReceiptIdentity), submittedIdentity);
  assert.equal(recovered._skuFrozenDelivery.contract.canvas.width, 1000);
  assert.equal(recovered._skuFrozenDelivery.archiveBatchId, params.batchId);
  assert.equal(transportCalls.filter(call => call.type === 'GENERATE_IMAGE').length, 1);
  assert.equal(transportCalls.filter(call => call.type === 'GET_IMAGE_RECEIPT').length, 1);
  assert.equal(transportCalls.filter(call => call.type === 'GET_SKU_RECEIPT_CAPABILITY').length, 1);
  assert.equal((await helper.api.read(OWNER, key)).identity.receiptId, submittedIdentity.receiptId);
});

test('actual integration rejects unsupported capability and IDB quota before any POST', async () => {
  for (const quota of [false, true]) {
    const db = indexedDBFixture(), helper = harness(db), { params } = paramsFor(db), markers = new Map();
    if (quota) db.faults.put = true;
    const h = legacyHarness(markers, { database: db, durableAPI: helper.api,
      transport(type) { assert.equal(type, 'GET_SKU_RECEIPT_CAPABILITY'); return { ok: true, supported: quota }; } });
    const result = await h.run(durableRequest(params));
    assert.equal(result.ok, false); assert.equal(result.providerSubmitted, false);
    assert.equal(result.definitiveFailure, true); assert.equal(result.stateUncertain, false);
    assert.equal(h.calls.filter(call => call.type === 'GENERATE_IMAGE').length, 0);
    assert.equal(markers.size, 0);
  }
});

test('exact backend rejection leaves immutable audit and reload retry uses a new UUID with stable workspace and task', async () => {
  const db = indexedDBFixture(), helper = harness(db), { params } = paramsFor(db), markers = new Map(), identities = [];
  let fakeProviderSubmissions = 0;
  const transport = (type, request) => {
    if (type === 'GET_SKU_RECEIPT_CAPABILITY') return { ok: true, supported: true };
    assert.equal(type, 'GENERATE_IMAGE'); identities.push(copy(request.receiptIdentity));
    if (identities.length === 1) return noSubmissionProof(request.receiptIdentity);
    fakeProviderSubmissions++;
    return { ok: true, state: 'complete', receipt: copy(request.receiptIdentity), images: ['data:image/png;base64,aW1hZ2U='] };
  };
  const initial = legacyHarness(markers, { database: db, durableAPI: helper.api, transport }), request = durableRequest(params);
  const key = await initial.key(request), rejected = await initial.run(request);
  assert.equal(rejected.noSubmission, true); assert.equal(rejected.stateUncertain, false);
  assert.equal(fakeProviderSubmissions, 0); assert.equal(identities.length, 1);
  assert.equal((await helper.api.read(OWNER, key)).state, 'not-submitted'); assert.equal(markers.has(key), false);
  const audit = await helper.api.readAudit(OWNER, identities[0].receiptId);
  assert.deepEqual(copy(audit.identity), identities[0]); const auditBytes = JSON.stringify(audit);
  const fresh = legacyHarness(markers, { database: db, durableAPI: harness(db).api, transport });
  const retry = durableRequest(params); retry.jobId = retry._skuDurablePreparation.jobId = 'explicit-new-retry-job';
  const result = await fresh.run(retry);
  assert.equal(result.ok, true); assert.equal(fakeProviderSubmissions, 1); assert.equal(identities.length, 2);
  assert.notEqual(identities[0].receiptId, identities[1].receiptId);
  assert.equal(identities[0].workspaceKey, identities[1].workspaceKey); assert.equal(identities[0].taskId, identities[1].taskId);
  assert.equal(identities[0].shotId, identities[1].shotId);
  assert.equal(JSON.stringify(await helper.api.readAudit(OWNER, identities[0].receiptId)), auditBytes);
  assert.equal((await helper.api.read(OWNER, key)).identity.receiptId, identities[1].receiptId);
  assert.equal((await helper.api.releaseNotSubmitted(OWNER, key, identities[0].receiptId, rejected)).ok, false);
});

test('unbound definitive flags do not release the original lock or claim a trusted no-submission outcome', async () => {
  for (const variant of ['missing_identity', 'wrong_identity', 'network']) {
    const db = indexedDBFixture(), helper = harness(db), { params } = paramsFor(db), markers = new Map();
    const h = legacyHarness(markers, { database: db, durableAPI: helper.api,
      transport(type, request) {
        if (type === 'GET_SKU_RECEIPT_CAPABILITY') return { ok: true, supported: true };
        assert.equal(type, 'GENERATE_IMAGE');
        const proof = noSubmissionProof(request.receiptIdentity);
        if (variant === 'missing_identity') delete proof.receiptIdentity;
        if (variant === 'wrong_identity') proof.receiptIdentity.jobId = 'foreign-job';
        if (variant === 'network') return { ok: false, code: 'network', stateUncertain: true };
        return proof;
      } });
    const request = durableRequest(params), key = await h.key(request), result = await h.run(request);
    assert.equal(result.ok, false); assert.equal(result.stateUncertain, true, variant);
    assert.equal(result.definitiveFailure, false, variant);
    const entry = await helper.api.read(OWNER, key);
    assert.equal(entry.state, 'dispatched', variant); assert.equal(markers.has(key), true, variant);
    assert.equal(await helper.api.readAudit(OWNER, entry.identity.receiptId), null, variant);
  }
});

test('local delivered recovery preserves durable UUID for archive acknowledgement', async () => {
  const db = indexedDBFixture(), helper = harness(db), { params } = paramsFor(db), markers = new Map();
  const transport = (type, request) => {
    if (type === 'GET_SKU_RECEIPT_CAPABILITY') return { ok: true, supported: true };
    assert.equal(type, 'GENERATE_IMAGE');
    return { ok: true, state: 'complete', receipt: copy(request.receiptIdentity), images: ['data:image/png;base64,aW1hZ2U='] };
  };
  const initial = legacyHarness(markers, { database: db, durableAPI: helper.api, transport });
  const request = durableRequest(params), first = await initial.run(request), key = await initial.key(request);
  assert.equal(first.ok, true); assert.equal(first.deliveryStorageError, undefined);
  const fresh = legacyHarness(markers, { database: db, durableAPI: harness(db).api });
  const recovered = await fresh.run(request);
  assert.equal(recovered.ok, true); assert.equal(recovered._skuReceipt.receiptId, first._skuReceipt.receiptId);
  assert.equal(fresh.calls.filter(call => call.type === 'GENERATE_IMAGE' || call.type === 'GET_IMAGE_RECEIPT').length, 0);
  assert.equal(await fresh.ack(recovered), true);
  assert.equal((await helper.api.read(OWNER, key)).state, 'acknowledged');
  assert.equal(markers.has(key), false);
});

test('an account switch during the asynchronous dispatch claim cannot submit under the new owner', async () => {
  const db = indexedDBFixture(), helper = harness(db), { params } = paramsFor(db), markers = new Map();
  let h;
  const api = { ...helper.api, async markDispatched(owner, key, receiptId) {
    const result = await helper.api.markDispatched(owner, key, receiptId);
    h.state.archiveAccountKey = 'sku-fixture:durable-bob'; return result;
  } };
  h = legacyHarness(markers, { database: db, durableAPI: api,
    transport(type) {
      if (type === 'GET_SKU_RECEIPT_CAPABILITY') return { ok: true, supported: true };
      return { ok: false, stateUncertain: true };
    } });
  const request = durableRequest(params), key = await h.key(request), result = await h.run(request);
  assert.equal(result.ok, false); assert.equal(result.stateUncertain, true); assert.equal(result.definitiveFailure, false);
  assert.equal(h.calls.filter(call => call.type === 'GENERATE_IMAGE').length, 0);
  assert.equal((await helper.api.read(OWNER, key)).state, 'dispatched', 'original identity must remain protected for GET reconciliation');
  assert.equal(await helper.api.read('sku-fixture:durable-bob', key), null);
  assert.equal(JSON.parse(markers.get(key)).jobId, params.jobId);
});

test('stop, cancellation and batch-token changes during the claim retain protection and prevent POST', async () => {
  for (const operation of ['stop', 'cancel', 'token']) {
    const db = indexedDBFixture(), helper = harness(db), { params } = paramsFor(db), markers = new Map();
    let h;
    const api = { ...helper.api, async markDispatched(owner, key, receiptId) {
      const result = await helper.api.markDispatched(owner, key, receiptId);
      if (operation === 'stop') h.state.stopRequested = true;
      if (operation === 'cancel') h.state.cancelledJobs[params.jobId] = true;
      if (operation === 'token') h.state.skuBatchToken++;
      return result;
    } };
    h = legacyHarness(markers, { database: db, durableAPI: api,
      transport(type) { assert.equal(type, 'GET_SKU_RECEIPT_CAPABILITY'); return { ok: true, supported: true }; } });
    const request = durableRequest(params), key = await h.key(request), result = await h.run(request);
    assert.equal(result.ok, false, operation); assert.equal(result.stateUncertain, true, operation);
    assert.equal(result.definitiveFailure, false, operation);
    assert.equal(h.calls.filter(call => call.type === 'GENERATE_IMAGE').length, 0, operation);
    assert.equal((await helper.api.read(OWNER, key)).state, 'dispatched', operation);
    assert.equal(JSON.parse(markers.get(key)).jobId, params.jobId, operation);
  }
});

test('GET with a mismatched or expanded receipt DTO preserves the original lock and does not accept returned images', async () => {
  for (const variant of ['wrong_uuid', 'extra_field']) {
    const db = indexedDBFixture(), helper = harness(db), { params } = paramsFor(db), markers = new Map();
    let dto;
    const transport = (type, request) => {
      if (type === 'GET_SKU_RECEIPT_CAPABILITY') return { ok: true, supported: true };
      if (type === 'GENERATE_IMAGE') { dto = copy(request.receiptIdentity); return { ok: false, stateUncertain: true }; }
      assert.equal(type, 'GET_IMAGE_RECEIPT');
      const receipt = copy(dto);
      if (variant === 'wrong_uuid') receipt.receiptId = '6f8bc66d-517b-4a2e-a96e-ce1a9a5c218b';
      else receipt.extra = 'not-in-nine-field-contract';
      return { ok: true, state: 'complete', receipt, images: ['data:image/png;base64,aW1hZ2U='] };
    };
    const initial = legacyHarness(markers, { database: db, durableAPI: helper.api, transport }), request = durableRequest(params);
    await initial.run(request); const key = await initial.key(request), frozen = markers.get(key);
    const fresh = legacyHarness(markers, { database: db, durableAPI: harness(db).api, transport });
    const result = await fresh.run(request);
    assert.equal(result.ok, false, variant); assert.equal(result.stateUncertain, true, variant);
    assert.equal(markers.get(key), frozen, variant);
    assert.equal(await fresh.context.SZ_SKU_DELIVERY_STORE.read(OWNER, key), null);
    assert.equal(fresh.calls.filter(call => call.type === 'GENERATE_IMAGE').length, 0);
  }
});

function extractFunctions(source, names) {
  const tree = require('acorn').parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const declarations = new Map();
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id && names.includes(node.id.name)) {
      assert.equal(declarations.has(node.id.name), false, 'extracted function must be unambiguous: ' + node.id.name);
      declarations.set(node.id.name, node);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(tree);
  return names.map(name => {
    const node = declarations.get(name); assert.ok(node, 'actual function is present: ' + name);
    return source.slice(node.start, node.end);
  }).join('\n');
}
const RUNTIME_VALIDATION = extractFunctions(BACKGROUND_SOURCE,
  ['skuDurableRuntimeSupported','skuDurableRuntimeFailure','skuDurableRuntimeValidate']);
const PACKED_RECEIPT_PREREQUISITES = extractFunctions(PACKED_SOURCE,
  ['normalizeImageReceiptIdentity','getDurableImageReceipt']);
const cancelBegin = BACKGROUND_SOURCE.indexOf('if (pendingSkuDurableReceipts[cancelJobId]) {');
const cancelEnd = BACKGROUND_SOURCE.indexOf('    var pendingFormalClaim', cancelBegin);
assert.ok(cancelBegin > 0 && cancelEnd > cancelBegin, 'actual pending cancellation branch is present');
const RUNTIME_CANCEL = 'function cancelFixture(jobId) { var cancelJobId = String(jobId || "").trim();\n' +
  BACKGROUND_SOURCE.slice(cancelBegin, cancelEnd) + '\nreturn false; }';
function runtimeHarness(options = {}) {
  const calls = [], pending = Object.create(null), active = Object.create(null), cancellations = [];
  let reads = 0;
  const context = vm.createContext({ pendingSkuDurableReceipts: pending, activeJobs: active,
    SZ_SKU_DURABLE_RECEIPT: { async validate(...args) {
      calls.push({ type: 'validate', args: copy(args) });
      return options.validator ? options.validator(...args) : { ok: true };
    } },
    async creativeWebAccountKey() { calls.push({ type: 'owner' }); return options.owners?.[reads++] ?? OWNER; },
    normalizeCfg: config => config,
    usesPlatformWallet: () => true,
    durableByokOpenAIConfig: () => false,
    sendResponse: value => cancellations.push(copy(value)),
    fetch() { throw new Error('runtime gate cannot call HTTP'); }
  });
  if (options.packed !== false) vm.runInContext(PACKED_RECEIPT_PREREQUISITES, context,
    { filename: 'actual frozen packed receipt prerequisites' });
  vm.runInContext(RUNTIME_VALIDATION + '\n' + RUNTIME_CANCEL, context, { filename: 'actual local SKU runtime validation and cancel branch' });
  return { context, calls, pending, active, cancellations,
    async run(msg, payload) {
      const result = await context.skuDurableRuntimeValidate(msg, payload, msg.jobId);
      if (result.ok) calls.push({ type: 'allowed-dispatch', identity: copy(result.identity) });
      return result;
    } };
}
async function runtimeFixture() {
  const helper = harness(), { params } = paramsFor(helper.database), entry = await helper.api.prepare(params);
  return { helper, params, entry, payload: { ...payloadFor(entry), _source: 'sku' },
    msg: { jobId: entry.identity.jobId, receiptIdentity: copy(entry.identity), config: copy(params.model) } };
}
function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve };
}

test('actual runtime gate uses the real helper and two live-owner reads before allowing a valid nine-field SKU', async () => {
  const fixture = await runtimeFixture(), h = runtimeHarness({ validator: (...args) => fixture.helper.api.validate(...args) });
  const result = await h.run(fixture.msg, fixture.payload);
  assert.equal(result.ok, true); assert.deepEqual(copy(result.identity), copy(fixture.entry.identity));
  assert.deepEqual(h.calls.map(call => call.type), ['owner', 'validate', 'owner', 'allowed-dispatch']);
  assert.equal(Object.keys(h.pending).length, 0);
});

test('runtime owner changes and validator rejection terminate as no-submission with zero dispatch', async () => {
  const fixture = await runtimeFixture();
  for (const options of [
    { owners: ['sku-fixture:durable-bob'] },
    { owners: [OWNER, 'sku-fixture:durable-bob'] },
    { validator: () => ({ ok: false, code: 'fixture-plan-rejected', error: 'fixture' }) }
  ]) {
    const h = runtimeHarness(options), result = await h.run(fixture.msg, fixture.payload);
    assert.equal(result.ok, false); assert.equal(result.noSubmission, true);
    assert.equal(result.providerSubmitted, false); assert.equal(result.definitiveFailure, true);
    assert.equal(result.stateUncertain, false); assert.equal(h.calls.filter(call => call.type === 'allowed-dispatch').length, 0);
    assert.deepEqual(copy(result.receiptIdentity), copy(fixture.entry.identity));
    assert.equal(result.jobId, fixture.entry.identity.jobId); assert.match(result.code, /^SKU_RECEIPT_/);
    assert.equal(Object.keys(h.pending).length, 0);
  }
});

test('same-job concurrent validation preserves the original pending claim and returns uncertain for the second caller', async () => {
  const fixture = await runtimeFixture(), gate = deferred(), h = runtimeHarness({ validator: () => gate.promise });
  const first = h.run(fixture.msg, fixture.payload), claim = h.pending[fixture.msg.jobId];
  assert.ok(claim); await flush();
  const second = await h.run(fixture.msg, fixture.payload);
  assert.equal(second.ok, false); assert.equal(second.stateUncertain, true);
  assert.equal(second.noSubmission, undefined, 'second caller cannot make a claim about the original submission');
  assert.equal(h.pending[fixture.msg.jobId], claim, 'second caller must not clear the first claim');
  assert.equal(h.calls.filter(call => call.type === 'validate').length, 1);
  gate.resolve({ ok: true }); assert.equal((await first).ok, true);
  assert.equal(h.calls.filter(call => call.type === 'allowed-dispatch').length, 1);
});

test('actual pending cancellation branch protects the claim until validation returns no-submission', async () => {
  const fixture = await runtimeFixture(), gate = deferred(), h = runtimeHarness({ validator: () => gate.promise });
  const running = h.run(fixture.msg, fixture.payload), claim = h.pending[fixture.msg.jobId]; await flush();
  assert.equal(h.context.cancelFixture(fixture.msg.jobId), true);
  assert.deepEqual(h.cancellations, [{ ok: true, cancelled: true, pending: true, noSubmission: true }]);
  assert.equal(h.pending[fixture.msg.jobId], claim); assert.equal(claim.cancelled, true);
  gate.resolve({ ok: true }); const result = await running;
  assert.equal(result.ok, false); assert.equal(result.noSubmission, true); assert.equal(result.providerSubmitted, false);
  assert.equal(result.code, 'SKU_RECEIPT_CANCELLED_BEFORE_DISPATCH');
  assert.deepEqual(copy(result.receiptIdentity), copy(fixture.entry.identity));
  assert.equal(h.calls.filter(call => call.type === 'allowed-dispatch').length, 0);
  assert.equal(Object.keys(h.pending).length, 0);
});

test('raw-worker capability is false without existing receipt prerequisites and packed prerequisites enable it', async () => {
  const fixture = await runtimeFixture(), raw = runtimeHarness({ packed: false });
  assert.equal(raw.context.skuDurableRuntimeSupported(), false);
  const result = await raw.run(fixture.msg, fixture.payload);
  assert.equal(result.ok, false); assert.equal(result.noSubmission, true);
  assert.equal(result.code, 'SKU_RECEIPT_RUNTIME_UNAVAILABLE'); assert.equal(raw.calls.length, 0);
  assert.equal(runtimeHarness().context.skuDurableRuntimeSupported(), true);
});

test('real runtime rejection proof flows through actual frontend release and produces an immutable no-submission audit', async () => {
  const db = indexedDBFixture(), helper = harness(db), { params } = paramsFor(db), markers = new Map();
  const runtime = runtimeHarness({ validator: () => ({ ok: false, code: 'SKU_RECEIPT_PLAN_REJECTED', error: 'fixture pre-dispatch guard' }) });
  const h = legacyHarness(markers, { database: db, durableAPI: helper.api,
    transport(type, request) {
      if (type === 'GET_SKU_RECEIPT_CAPABILITY') return { ok: true, supported: runtime.context.skuDurableRuntimeSupported() };
      assert.equal(type, 'GENERATE_IMAGE');
      return runtime.run(request, request.payload);
    } });
  const request = durableRequest(params), key = await h.key(request), result = await h.run(request);
  assert.equal(result.noSubmission, true); assert.equal(result.providerSubmitted, false); assert.equal(result.stateUncertain, false);
  assert.equal(runtime.calls.filter(call => call.type === 'allowed-dispatch').length, 0);
  assert.equal(markers.has(key), false);
  const original = await helper.api.read(OWNER, key); assert.equal(original.state, 'not-submitted');
  const audit = await helper.api.readAudit(OWNER, original.identity.receiptId);
  assert.deepEqual(copy(audit.identity), copy(original.identity)); assert.deepEqual(copy(audit.plan), copy(original.plan));
  assert.equal(audit.reason, result.code);
});

const legacyRequest = index => ({ jobId: 'new-attempt-' + index, _skuBatchToken: 1, _skuArchiveBatchId: 'new-batch',
  config: { provider: 'generic', imageAdapter: 'generic-json', imageEndpoint: 'https://fixture.invalid/images', imageModel: 'fixture-model' },
  payload: { labMode: 'sku', detailMode: 'sku', skuId: 'stable-source-slot-' + index,
    productImage: 'data:image/jpeg;base64,YmFzZQ==', modelImages: ['data:image/jpeg;base64,' + Buffer.from('subject-' + index).toString('base64')],
    prompt: 'Replace only subject.', negativePrompt: 'Preserve outside.', size: '1024*1024', ratio: '1:1', resolution: '1K', count: 1 }
});

function installRecoveryUI(h, params) {
  const flow = [];
  Object.assign(h.context, {
    legacyImageUploadBusy: () => false,
    skuTaskStatusFor: skuId => h.state.skuTaskStatus[skuId] || { state: 'idle' },
    ensureSkuProductIdentity(item) { assert.ok(item.skuId); return item; },
    skuAttributes: () => [],
    skuBusinessTitle: item => item.skuTitle || item.skuAttribute || '',
    renderSkuWorkspace() { flow.push({ type: 'render' }); },
    setSkuBusy(value) { h.state.skuActive = value; flow.push({ type: 'busy', value }); },
    createSkuVisualLockContract: settings => settings.visualLock,
    skuPromptFor: () => params.prompt,
    skuSubjectReplaceNegativePrompt: () => params.negativePrompt,
    skuExpectedEffectiveProviderSize: () => params.geometry.effectiveSize,
    skuResultVisualContractValid: contract => contract.version === params.contract.version,
    sourceFingerprint: value => value === params.baseImage ? params.contract.baseImageFingerprint : params.contract.replacementSubjectFingerprint,
    skuCompositionSettingsFromResponse(response, settings) {
      assert.equal(response.skuProviderGeometry.contractFingerprint, settings.visualLock.contractFingerprint);
      return settings;
    },
    async enqueueSkuVisualComposition(url, task, settings, receipt) {
      flow.push({ type: 'composition-boundary', url, task: copy(task), settings: copy(settings), receipt: copy(receipt) });
      return { url: 'data:image/jpeg;base64,bG9jYWwtanBn', layoutAnchorDataUrl: params.baseImage,
        outputSize: '1000*1000', outputWidth: 1000, outputHeight: 1000 };
    },
    stampSkuResultVisualIdentity(item) { flow.push({ type: 'stamp', jobId: item.jobId }); },
    async queueArchiveResult(item, options) { flow.push({ type: 'archive-boundary', item: copy(item), options: copy(options) }); return { ok: true }; },
    send(type) { flow.push({ type }); throw new Error('receipt recovery must not call generation'); },
    newJobId() { throw new Error('recovery must retain the original job ID'); },
    showProductSubjectRequired() { throw new Error('retained source is required'); }
  });
  const constantNames = ['SKU_OUTPUT_MIN_EDGE','SKU_OUTPUT_MAX_EDGE','SKU_OUTPUT_MAX_PIXELS','SKU_PRESET_RATIOS','SKU_PRESET_BASE_SIZES'];
  const constants = require('acorn').parse(PROMPTLAB_SOURCE, { ecmaVersion: 'latest' }).body.filter(node =>
    node.type === 'VariableDeclaration' && node.declarations.some(value => constantNames.includes(value.id?.name)));
  assert.equal(constants.length, constantNames.length, 'actual output resolver constants must be complete');
  vm.runInContext(constants.map(node => PROMPTLAB_SOURCE.slice(node.start, node.end)).join('\n'), h.context);
  const functions = extractFunctions(PROMPTLAB_SOURCE, ['cloneGuideValue','freezeSkuVisualContract','skuReplicaBaseImage',
    'skuSizeParts','skuPresetSize','skuGreatestCommonDivisor','skuRatioFromDimensions','skuCustomSizeValidation',
    'skuOutputSizeValidation','skuProviderSpecForOutput',
    'skuTaskBlueprints','skuRestoreDeliveredSettings','skuSettingsFromDurableEntry','restoreSkuDurableReceipts',
    'recoverSkuDurableReceipt','generateSkuOne']);
  vm.runInContext(functions, h.context, { filename: 'actual SKU recovery UI and generateSkuOne with isolated compositor/archive boundaries' });
  return flow;
}

test('UI restore skips corrupt and both old legacy markers, preserves metadata and does not fabricate identities', async () => {
  const db = indexedDBFixture(), helper = harness(db), { params } = paramsFor(db), markers = new Map();
  const entry = await helper.api.prepare(params); await helper.api.markDispatched(OWNER, params.legacyKey, entry.identity.receiptId);
  const prefix = 'sz.legacy-image-receipt.v1:' + encodeURIComponent(OWNER) + ':';
  markers.set(prefix + 'broken', '{not json');
  markers.set(prefix + 'old-one', JSON.stringify({ version: 1, state: 'uncertain', jobId: 'job_1791824581525_774923246bf7e' }));
  markers.set(prefix + 'old-two', JSON.stringify({ version: 1, state: 'uncertain', jobId: 'job_1791824581874_8095a58ffa5c3' }));
  markers.set(params.legacyKey, JSON.stringify({ version: 1, state: 'uncertain', jobId: entry.identity.jobId, receiptId: entry.identity.receiptId }));
  const frozen = [...markers], h = legacyHarness(markers, { database: db,
    durableAPI: { ...helper.api, async prepare() { throw new Error('UI restoration cannot fabricate a DTO'); } } });
  installRecoveryUI(h, params);
  assert.equal(await h.context.restoreSkuDurableReceipts(), true);
  assert.equal(h.state.skuProducts.length, 1);
  const item = h.state.skuProducts[0], status = h.state.skuTaskStatus[item.skuId];
  assert.equal(item.url, params.subjectImage); assert.equal(item._skuDurableBaseImage, params.baseImage);
  assert.equal(item.name, params.snapshot.title); assert.deepEqual(copy(item._skuDurableMetadata), params.snapshot);
  assert.equal(status._skuRecovery.receiptId, entry.identity.receiptId); assert.equal(status.jobId, params.jobId);
  assert.equal(h.state.skuSelections[item.skuId], false);
  assert.equal(h.context.skuTaskBlueprints()[0].attr, params.snapshot.attribute);
  assert.equal(await h.context.restoreSkuDurableReceipts(), false); assert.equal(h.state.skuProducts.length, 1);
  assert.equal(h.calls.filter(call => call.type === 'GENERATE_IMAGE' || call.type === 'GET_IMAGE_RECEIPT').length, 0);
  assert.deepEqual([...markers], frozen);
});

test('UI reconciliation uses GET and actual generateSkuOne returned-response path with original composition/archive settings', async () => {
  const db = indexedDBFixture(), helper = harness(db), { params } = paramsFor(db), markers = new Map();
  const entry = await helper.api.prepare(params); await helper.api.markDispatched(OWNER, params.legacyKey, entry.identity.receiptId);
  markers.set(params.legacyKey, JSON.stringify({ version: 1, state: 'uncertain', jobId: params.jobId, receiptId: entry.identity.receiptId }));
  const h = legacyHarness(markers, { database: db, durableAPI: helper.api,
    transport(type, request) {
      assert.equal(type, 'GET_IMAGE_RECEIPT'); assert.deepEqual(copy(request.receiptIdentity), copy(entry.identity));
      return { ok: true, state: 'complete', receipt: copy(entry.identity), images: ['data:image/png;base64,aW1hZ2U='] };
    } });
  const flow = installRecoveryUI(h, params);
  assert.equal(await h.context.restoreSkuDurableReceipts(), true);
  const skuId = h.state.skuProducts[0].skuId, result = await h.context.recoverSkuDurableReceipt(skuId);
  assert.equal(result.ok, true); assert.equal(result.archived, true);
  assert.equal(h.calls.filter(call => call.type === 'GET_IMAGE_RECEIPT').length, 1);
  assert.equal(h.calls.filter(call => call.type === 'GENERATE_IMAGE').length, 0);
  const composed = flow.find(call => call.type === 'composition-boundary');
  assert.equal(composed.task._skuReturnedJobId, params.jobId); assert.equal(composed.task._skuReturnedResponse.recoveredDelivery, true);
  assert.equal(composed.settings.outputSize, '1000*1000'); assert.equal(composed.settings.archiveBatchId, params.batchId);
  assert.equal(composed.settings.replicaBaseImage, params.baseImage); assert.equal(composed.settings.replacementSubjectImage, params.subjectImage);
  assert.deepEqual(composed.settings.authorizedRegion, params.contract.subject.authorizedRegion);
  const archived = flow.find(call => call.type === 'archive-boundary');
  assert.equal(archived.item.jobId, params.jobId); assert.equal(archived.item.resultId, params.jobId + ':1');
  assert.equal(archived.item.skuTitle, params.snapshot.title); assert.equal(archived.item.archiveBatchId, params.batchId);
  assert.equal(archived.options.accountKey, OWNER); assert.deepEqual(archived.item.skuDurableReceiptIdentity, copy(entry.identity));
  assert.equal(h.state.skuTaskStatus[skuId].state, 'success'); assert.equal(h.state.skuActive, false);
  assert.equal((await helper.api.read(OWNER, params.legacyKey)).state, 'acknowledged');
  assert.equal(markers.has(params.legacyKey), false);
});

test('recovered custom output retains a valid provider tuple in the actual production archive sanitizer', async () => {
  const db = indexedDBFixture(), helper = harness(db), { params } = paramsFor(db), markers = new Map();
  const entry = await helper.api.prepare(params), h = legacyHarness(markers, { database: db, durableAPI: helper.api });
  installRecoveryUI(h, params);
  const settings = h.context.skuSettingsFromDurableEntry(entry);
  const filename = path.resolve(__dirname, '../docs/uat-sku-workflow-20261012/production-baseline/studio-prerequisites-20261009-v1.js');
  const source = fs.readFileSync(filename, 'utf8'), marker = source.indexOf('/* Frozen source: public/creative/labs/image-prompt-lab/image-archive-store.js */');
  assert.ok(marker >= 0, 'actual production archive module must be present');
  const expression = require('acorn').parse(source, { ecmaVersion: 'latest' }).body.find(node => node.start > marker);
  assert.ok(expression && expression.type === 'ExpressionStatement');
  const archive = vm.createContext({ module: { exports: {} }, Blob, URL, console });
  vm.runInContext(source.slice(expression.start, expression.end), archive, { filename: 'actual frozen production archive sanitizer' });
  const input = { accountKey: OWNER, surfaceMode: 'sku', url: 'data:image/jpeg;base64,dGVzdA==',
    jobId: entry.identity.jobId, resultId: entry.identity.jobId + ':1', skuTitle: params.snapshot.title,
    outputSize: settings.outputSize, outputWidth: settings.outputWidth, outputHeight: settings.outputHeight,
    providerSize: settings.modelSize, providerRatio: settings.modelRatio, providerResolution: settings.modelResolution,
    ratio: settings.outputRatio, resolution: settings.outputResolution };
  assert.equal(settings.outputSize, '1000*1000');
  assert.equal(settings.outputResolution, 'custom');
  const normalized = archive.module.exports.sanitizeArchiveInput(input);
  assert.equal(normalized.outputSize, '1000*1000');
  assert.equal(normalized.providerSize, '1024*1024');
  assert.equal(normalized.providerRatio, '1:1');
  assert.equal(normalized.providerResolution, '1K');
});

test('paid precheck and localization report only their own failure as not submitted and preserve recursive post-dispatch uncertainty', async () => {
  for (const stage of ['precheck-before','precheck-after','localization-before','localization-after']) {
    const db = indexedDBFixture(), helper = harness(db), { params } = paramsFor(db), markers = new Map();
    const h = legacyHarness(markers, { database: db, durableAPI: helper.api });
    installRecoveryUI(h, params);
    const snapshot = { baseImage: params.baseImage, subjectImage: params.subjectImage, providerImages: params.providerImages,
      contract: params.contract, geometry: params.geometry, output: params.output, prompt: params.prompt,
      negativePrompt: params.negativePrompt, model: params.model, metadata: params.snapshot };
    const task = { skuId: 'actual-recursive-slot', skuCode: params.snapshot.skuCode, index: 0, attr: params.snapshot.title,
      item: { url: params.subjectImage, _skuPaidSnapshot: snapshot }, replicaBaseImage: params.baseImage,
      _skuInputsLocalized: !stage.startsWith('localization-'),
      _skuPaidScopeChecked: stage.startsWith('localization-'), _skuOwner: OWNER };
    const settings = h.context.skuSettingsFromDurableEntry({ identity: { batchId: params.batchId }, snapshot });
    let dispatched = 0;
    Object.assign(h.context, {
      skuCheckPaidTaskForGeneration() {
        return stage === 'precheck-before' ? Promise.reject(new Error('controlled precheck rejection')) : Promise.resolve(true);
      },
      skuVisualSourceDataUrl(source) {
        return stage === 'localization-before' ? Promise.reject(new Error('controlled localization rejection')) : Promise.resolve(source);
      },
      skuValidateLocalizedInputGeometry(base, subject, localizedSettings) {
        assert.equal(base, params.baseImage); assert.equal(subject, params.subjectImage);
        return Promise.resolve({ settings: localizedSettings });
      },
      newJobId() { return 'actual-recursive-dispatched-job'; },
      send(type) {
        assert.equal(type, 'GENERATE_IMAGE'); dispatched++;
        return Promise.reject(new Error('controlled generation rejection after dispatch boundary'));
      },
      renderSkuWorkspace() {
        // This makes the actual inner catch reject, testing the outer error
        // routing rather than substituting the recursive generate function.
        if (dispatched) throw new Error('controlled render rejection after dispatch');
      }
    });
    if (stage.endsWith('-before')) {
      const response = await h.context.generateSkuOne(task, h.state.skuBatchToken, settings);
      assert.equal(dispatched, 0); assert.equal(response.ok, false);
      const status = h.state.skuTaskStatus[task.skuId];
      assert.equal(status.state, 'failed'); assert.equal(status.providerSubmitted, false); assert.equal(status.definitiveFailure, true);
      assert.equal(response.code, stage === 'precheck-before' ? 'SKU_PAID_SCOPE_CHANGED' : 'sku_input_localize_failed');
    } else {
      await assert.rejects(h.context.generateSkuOne(task, h.state.skuBatchToken, settings), /controlled render rejection after dispatch/);
      assert.equal(dispatched, 1);
      const status = h.state.skuTaskStatus[task.skuId];
      assert.equal(status.state, 'uncertain'); assert.equal(status.stateUncertain, true);
      assert.notEqual(status.providerSubmitted, false); assert.notEqual(status.definitiveFailure, true);
    }
  }
});

test('both actual legacy unknown job IDs remain protected across reload without fabricated nine-field DTOs', async () => {
  const markers = new Map();
  const jobs = ['job_1791824581525_774923246bf7e', 'job_1791824581874_8095a58ffa5c3'];
  const initial = legacyHarness(markers), keys = [];
  for (let index = 0; index < jobs.length; index++) {
    const key = await initial.key(legacyRequest(index)); keys.push(key);
    markers.set(key, JSON.stringify({ version: 1, state: 'uncertain', jobId: jobs[index], createdAt: 1791824581525 + index,
      code: 'IMAGE_RECEIPT_UNCONFIRMED', taskId: '' }));
  }
  const frozen = [...markers];
  for (let reload = 0; reload < 2; reload++) {
    const h = legacyHarness(markers);
    for (const index of [1, 0]) {
      const request = legacyRequest(index); request.jobId = 'new-reload-' + reload + '-' + index;
      request._skuArchiveBatchId = 'changed-batch-' + reload;
      const result = await h.run(request);
      assert.equal(result.ok, false); assert.equal(result.stateUncertain, true);
      assert.equal(result.retryable, false); assert.equal(result.jobId, jobs[index]);
    }
    assert.deepEqual([...markers], frozen, 'old receipt JSON bytes and locks must remain unchanged');
    assert.equal(h.calls.filter(call => ['prepare', 'markDispatched', 'ack', 'releaseNotSubmitted', 'GENERATE_IMAGE', 'GET_IMAGE_RECEIPT', 'RECONCILE_IMAGE_RECEIPT'].includes(call.type)).length, 0);
    assert.equal(h.calls.filter(call => call.type.startsWith('marker-')).length, 0);
  }
  assert.equal(keys.length, 2); assert.notEqual(keys[0], keys[1]);
});

test('a corrupt legacy marker remains fail-closed and cannot be replaced by a new durable identity', async () => {
  const h = legacyHarness(), request = legacyRequest(9), key = await h.key(request);
  h.markers.set(key, '{broken receipt');
  const result = await h.run(request);
  assert.equal(result.ok, false); assert.equal(result.stateUncertain, true);
  assert.equal(h.markers.get(key), '{broken receipt');
  assert.equal(h.calls.filter(call => call.type !== 'lock').length, 0);
});
