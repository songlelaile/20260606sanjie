'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const B = require('../public/creative/src/ecommerce-video-background.js');
const C = require('../public/creative/labs/ecommerce-video-studio/video-studio-contract.js');
const ACCOUNT = 'fixture-video-account';
const FAST = 'seedance-2.0-fast';
const MINI = 'seedance-2.0-mini';
const STANDARD = 'seedance-2.0';

function capability(id) {
  return { id, durations: [5], resolutions: ['480p', '720p'], ratios: ['16:9', '9:16'], generateAudio: false, reservationCents: 1000 };
}

function host(models, configured = true) {
  const calls = [];
  const context = vm.createContext({
    authCheck: async () => ({ ok: true, user: { id: ACCOUNT } }),
    chrome: { storage: { local: { get: (_key, done) => done({}), set: (_value, done) => done() } }, runtime: { onMessage: { addListener() {} } } },
    fetch: async (url, options) => {
      assert.equal(url, '/api/creative/native-video'); assert.equal(options.method, 'GET');
      calls.push({ url, options });
      return { ok: true, json: async () => ({ configured, models }) };
    }
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/creative/web-video-host.js'), 'utf8'), context);
  return { calls, resolve: () => context.resolveUnifiedConfigReference({ accountKey: ACCOUNT }) };
}

function controller(t, initialModels = [capability(STANDARD), capability(MINI), capability(FAST)]) {
  const previous = global.location; global.location = { origin: 'https://fixture.example.com' };
  t.after(() => { if (previous === undefined) delete global.location; else global.location = previous; });
  let models = initialModels, sequence = 0;
  const stored = {}, calls = [];
  const instance = B.createController({
    resolveAccountKey: async () => ACCOUNT,
    resolveCredentials: async () => ({ ok: true, accountKey: ACCOUNT, config: { platformVideo: true, provider: 'shaozhuang-native', platformModels: models } }),
    storageGet: async key => ({ [key]: structuredClone(stored[key]) }),
    storageSet: async update => Object.assign(stored, structuredClone(update)),
    randomUUID: () => 'fixture-' + (++sequence), now: () => 1000 + sequence,
    fetch: async (url, options) => {
      // No network access: every provider operation is resolved inside this fixture.
      calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      if (url.endsWith('/resolve')) return new Response('{}', { status: 404 });
      return Response.json({ id: 'nv-fixture-fast', status: 'processing' });
    }
  });
  return { instance, calls, stored, setModels: value => { models = value; } };
}

function start(productKey = FAST, overrides = {}) {
  return { type: B.MESSAGE_TYPES.START, requestId: 'fixture-request', idempotencyKey: 'fixture-idempotency',
    request: { mode: 'direct', creativeRoute: 'free_direct', productKey, script: 'Show a ceramic product.',
      durationSeconds: 5, resolution: '720p', ratio: '16:9', audioMode: 'silent', images: [], videos: [], audios: [], ...overrides },
    production: { planId: 'fixture-plan', shotId: 'fixture-shot', budgetYuan: 10, attempt: 1, maxAttempts: 1 } };
}

test('host exposes Fast only when the platform declares its real capability', async () => {
  const h = host([capability(FAST), capability(MINI), capability('unknown-alias')]);
  const result = await h.resolve();
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.config.platformModels, model => model.id), [FAST, MINI]);
  assert.equal(result.config.platformModels[0].providerModel, FAST);
  assert.equal(result.config.platformModels[0].reservationCents, 1000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.headers['X-Sanjie-Expected-Account'], ACCOUNT);
});

test('unconfigured platform and malformed Fast capabilities are not reported available', async () => {
  assert.equal((await host([capability(FAST)], false).resolve()).ok, false);
  assert.equal((await host([{ ...capability(FAST), durations: [] }]).resolve()).ok, false);
});

for (const productKey of [FAST, MINI]) test('missing ' + productKey + ' stays unavailable and does not become another model before dispatch', async t => {
  const h = controller(t, [capability(STANDARD)]);
  const available = await h.instance.capabilities();
  const unavailable = available.models.find(model => model.productKey === productKey);
  assert.equal(unavailable.configured, false); assert.equal(unavailable.providerModel, '');
  const result = await h.instance.handleMessage(start(productKey));
  assert.equal(result.ok, false); assert.equal(result.payload.error.code, 'MODEL_UNAVAILABLE');
  assert.equal(h.calls.length, 0); assert.equal(h.stored[B.TASK_KEY], undefined);
});

test('Fast keeps its exact native product identity, quote and idempotent shot submission', async t => {
  const h = controller(t);
  const result = await h.instance.handleMessage(start());
  assert.equal(result.ok, true); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.model, FAST);
  assert.equal(h.calls[0].body.generate_audio, false);
  assert.equal(h.calls[0].options.headers.Authorization, undefined);
  assert.equal(result.payload.task.productKey, FAST);
  assert.equal(result.payload.task.production.estimatedYuan, 4);
  assert.equal(result.payload.task.production.reservedYuan, 4.4);
  assert.equal(result.payload.task.production.priceVersion, 'volcengine-list-2026-10-10-fast-no-ref-720p');
  assert.equal((await h.instance.handleMessage(start())).payload.idempotent, true);
  assert.equal(h.calls.length, 1);
});

test('Fast quote budget and unsupported dimensions block before a request or task is created', async t => {
  const h = controller(t);
  for (const kind of ['budget', 'resolution']) {
    const message = start();
    if (kind === 'budget') message.production.budgetYuan = 4.39;
    else message.request.resolution = '1080p';
    const result = await h.instance.handleMessage(message);
    assert.equal(result.ok, false);
    assert.ok(['PRODUCTION_BUDGET_EXCEEDED', 'RESOLUTION_INVALID'].includes(result.payload.error.code));
    assert.equal(h.calls.length, 0); assert.equal(h.stored[B.TASK_KEY], undefined);
  }
});

test('changing current capabilities does not rewrite a submitted Fast dispatch binding', async t => {
  const h = controller(t), result = await h.instance.handleMessage(start());
  assert.equal(result.ok, true);
  const original = await h.instance._readTask(ACCOUNT, result.payload.task.taskId);
  h.setModels([capability(STANDARD)]);
  const status = await h.instance.handleMessage({ type: B.MESSAGE_TYPES.STATUS, taskId: original.taskId });
  assert.equal(status.ok, true);
  const after = await h.instance._readTask(ACCOUNT, original.taskId);
  assert.equal(after.productKey, FAST); assert.equal(after.providerModel, original.providerModel);
  assert.deepEqual(after._dispatchConfig, original._dispatchConfig);
  assert.equal(after._nativeIdempotencyKey, original._nativeIdempotencyKey);
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(h.calls[1].url, 'https://fixture.example.com/api/creative/native-video/' + original.providerTaskId);
});

test('new model capability reads and unknown-task lookup preserve the original unresolved reservation', async t => {
  const h = controller(t);
  const unknown = { taskId: 'original-unknown', accountKey: ACCOUNT, productKey: STANDARD, providerModel: STANDARD,
    status: 'unknown', phase: 'provider_create_unknown', generation: 1, providerTaskId: '',
    _platformVideo: true, _nativeIdempotencyKey: 'original-idempotency', _submissionUncertain: true,
    production: { reservedYuan: 10, reservationPoints: 100 }, resultUrls: [] };
  h.stored[B.TASK_KEY] = { version: 1, accounts: { [ACCOUNT]: { tasks: { [unknown.taskId]: unknown }, idempotency: {} } } };
  await h.instance.capabilities();
  const response = await h.instance.handleMessage({ type: B.MESSAGE_TYPES.STATUS, taskId: unknown.taskId });
  assert.equal(response.ok, true);
  assert.deepEqual(h.stored[B.TASK_KEY].accounts[ACCOUNT].tasks[unknown.taskId], unknown);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].options.method, 'GET');
  assert.equal(h.calls[0].options.headers['Idempotency-Key'], 'original-idempotency');
  assert.ok(h.calls[0].url.endsWith('/resolve'));
  assert.equal(C.resolveModel(FAST).providerModel, 'doubao-seedance-2-0-fast-260128');
});
