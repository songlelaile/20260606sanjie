const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const privacyCode = 'InputImageSensitiveContentDetected.PrivacyInformation';
const fixtureSecret = 'fixture-never-show-this-secret';
const fixtureDataUrl = 'data:image/png;base64,fixture-private-image';
const fixtureUrl = 'https://fixture.invalid/private?token=fixture-private-token';

function runtime(body, status = 400, headers = {}, native = false) {
  const calls = [];
  const context = vm.createContext({
    URL, Headers, Response, Blob, FormData, AbortController, Uint8Array, ArrayBuffer, setTimeout, clearTimeout,
    location: { origin: 'https://fixture.invalid' },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (native && url.endsWith('/native-video/quote')) return Response.json({ billingMode: 'prepaid_quote', quoteCents: 30, quoteToken: 'fixture-quote-token' });
      return Response.json(body, { status, headers });
    },
    fixtureConfigJSON: JSON.stringify(native ? {
      apiKey: '', provider: 'shaozhuang-native', platformVideo: true, platformModels: [
        { id: 'seedance-2.0', durations: [5], resolutions: ['720p'], ratios: ['16:9'], generateAudio: true }
      ]
    } : { apiKey: fixtureSecret, provider: 'doubao' })
  });
  for (const file of ['labs/ecommerce-video-studio/video-studio-contract.js', 'src/ecommerce-video-background.js']) {
    vm.runInContext(readFileSync(path.join(__dirname, '../public/creative', file), 'utf8'), context, { filename: file });
  }
  vm.runInContext(`
    var records = {};
    var controller = SZEcommerceVideoBackground.createController({
      resolveAccountKey: async function () { return { ok: true, accountKey: 'fixture-alice' }; },
      resolveCredentials: async function () { return { ok: true, accountKey: 'fixture-alice', config: JSON.parse(fixtureConfigJSON) }; },
      storageGet: async function (key) { var result = {}; result[key] = records[key]; return result; },
      storageSet: async function (values) { Object.assign(records, values); }
    });
    var request = { mode: 'direct', creativeRoute: 'hero_product', productKey: 'seedance-2.0', durationSeconds: 5,
      resolution: '720p', ratio: '16:9', audioMode: 'silent', script: '展示商品细节', images: [1, 2, 3].map(function (n) {
        return { id: 'fixture-image-' + n, remoteUrl: 'https://fixture.invalid/product-' + n + '.png', role: 'product' };
      }) };
    request.rights = { confirmed: true, confirmedAt: '2026-10-18T00:00:00.000Z',
      fingerprint: SZEcommerceVideoContract.assetRightsFingerprint(request) };
  `, context);
  const start = (idempotencyKey = 'fixture-create-key') => vm.runInContext(`controller.start({
    idempotencyKey: ${JSON.stringify(idempotencyKey)}, request: request,
    production: { planId: 'fixture-plan', shotId: 'shot-1', attempt: 1, maxAttempts: 2, budgetYuan: 17 }
  })`, context);
  const task = () => vm.runInContext(`Object.values(records[SZEcommerceVideoBackground.TASK_KEY].accounts['fixture-alice'].tasks)[0]`, context);
  return { start, task, calls, context };
}

function assertNoUpstreamSecrets(value) {
  const serialized = JSON.stringify(value);
  for (const secret of [fixtureSecret, fixtureDataUrl, fixtureUrl, 'fixture-private-token']) assert.ok(!serialized.includes(secret));
}

test('privacy HTTP 400 persists actionable Chinese guidance and bounded diagnostics without provider prose', async () => {
  const app = runtime({ error: { code: privacyCode, message: `${fixtureSecret} ${fixtureDataUrl} ${fixtureUrl}`, request_id: 'req-fixture-privacy-001' },
    rawProviderBody: fixtureSecret });
  let rejection;
  await assert.rejects(app.start(), cause => {
    rejection = cause;
    assert.equal(cause.code, 'PROVIDER_HTTP_ERROR');
    assert.equal(cause.details.status, 400);
    assert.equal(cause.details.providerCode, privacyCode);
    assert.equal(cause.details.requestId, 'req-fixture-privacy-001');
    return true;
  });
  const task = app.task();
  assert.equal(task.status, 'failed');
  assert.equal(task.errorCode, 'PROVIDER_HTTP_ERROR');
  assert.match(task.error, /参考素材可能包含真人，当前模型拒绝/);
  assert.match(task.error, /不含真人的商品素材/);
  assert.match(task.error, /供应商认证的可信人像素材/);
  assert.match(task.error, /HTTP 400/);
  assert.ok(task.error.includes(privacyCode));
  assert.match(task.error, /req-fixture-privacy-001/);
  assert.equal(task.production.reservationReleased, true);
  assertNoUpstreamSecrets({ task, details: rejection.details, message: rejection.message });
  assert.equal(app.calls.length, 1);
  assert.equal(new Headers(app.calls[0].init.headers).get('Authorization'), `Bearer ${fixtureSecret}`);
  const posted = JSON.parse(app.calls[0].init.body);
  assert.equal(posted.duration, 5);
  assert.equal(posted.resolution, '720p');
  assert.equal(posted.content.filter(part => part.type === 'image_url').length, 3);
  const repeat = await app.start();
  assert.equal(repeat.task.taskId, task.taskId);
  assert.equal(repeat.idempotent, true);
  assert.equal(app.calls.length, 1);
});

test('HTTP diagnostics accept a safe request ID header and omit unsafe identifier values', async () => {
  const app = runtime({ error: { code: privacyCode, message: fixtureSecret, request_id: fixtureDataUrl } }, 400,
    { 'x-request-id': 'req-header-fixture-002' });
  await assert.rejects(app.start(), cause => {
    assert.equal(cause.details.requestId, 'req-header-fixture-002');
    assertNoUpstreamSecrets(cause.details);
    return true;
  });
  assert.match(app.task().error, /req-header-fixture-002/);
  const unsafe = runtime({ code: fixtureUrl, request_id: fixtureDataUrl, message: fixtureSecret });
  await assert.rejects(unsafe.start(), cause => {
    assert.equal(cause.details.providerCode, '');
    assert.equal(cause.details.requestId, undefined);
    assertNoUpstreamSecrets(cause.details);
    return true;
  });
  assertNoUpstreamSecrets(unsafe.task());
  assert.doesNotMatch(unsafe.task().error, /真人/);
});

test('HTTP 500 with the same provider code remains unknown and blocks repeat submissions', async () => {
  const app = runtime({ error: { code: privacyCode, message: fixtureSecret }, request_id: 'req-fixture-unknown-003' }, 500);
  await assert.rejects(app.start(), cause => {
    assert.equal(cause.code, 'PROVIDER_CREATE_UNCERTAIN');
    assert.equal(cause.details.stateUncertain, true);
    assert.equal(cause.details.status, 500);
    assert.equal(cause.details.providerCode, privacyCode);
    assert.equal(cause.details.requestId, 'req-fixture-unknown-003');
    assertNoUpstreamSecrets(cause.details);
    return true;
  });
  const task = app.task();
  assert.equal(task.status, 'unknown');
  assert.equal(task._submissionUncertain, true);
  assert.equal(task.production.reservationReleased, undefined);
  assert.match(task.error, /勿重复提交/);
  assert.doesNotMatch(task.error, /真人/);
  await assert.rejects(app.start(), { code: 'PROVIDER_CREATE_UNCERTAIN' });
  await assert.rejects(app.start('fixture-different-key'), { code: 'PROVIDER_CREATE_UNCERTAIN' });
  assert.equal(app.calls.length, 1);
});

test('unverified native HTTP 400 keeps its existing unknown-submission state', async () => {
  const app = runtime({ error: { code: privacyCode, message: fixtureSecret } }, 400, {}, true);
  await assert.rejects(app.start(), cause => {
    assert.equal(cause.code, 'PROVIDER_CREATE_UNCERTAIN');
    assert.equal(cause.details.stateUncertain, true);
    assert.equal(cause.details.status, 400);
    return true;
  });
  assert.equal(app.task().status, 'unknown');
  assert.equal(app.task().production.reservationReleased, undefined);
  assert.equal(app.calls.length, 2);
  assertNoUpstreamSecrets(app.task());
});
