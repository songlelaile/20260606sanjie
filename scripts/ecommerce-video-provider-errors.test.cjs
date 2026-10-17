'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const B = require('../public/creative/src/ecommerce-video-background.js');

const ACCOUNT = 'offline-error-account';
const SECRET = 'fixture-current-bare-api-credential';
const historical = {
  taskId: 'retained-success', accountKey: ACCOUNT, generation: 1, status: 'succeeded',
  productKey: 'seedance-2.0', resultUrls: ['https://history.fixture.test/retained.mp4'],
  createdAt: 100, scriptConfirmed: true,
  _request: { images: [{ id: 'retained-material', storageRef: { id: 'retained-material' } }] }
};

function fixture(t, options = {}) {
  const previous = global.location;
  if (options.native) global.location = { origin: 'https://offline.fixture.test' };
  t.after(() => { if (previous === undefined) delete global.location; else global.location = previous; });
  const stored = { [B.TASK_KEY]: { version: 1, accounts: {
    [ACCOUNT]: { tasks: { [historical.taskId]: structuredClone(historical) }, idempotency: {} }
  } } };
  const calls = [];
  let sequence = 0;
  let reply = options.reply || (() => Response.json({ error: { code: 'InvalidParameter', message: 'Unsupported resolution.', param: 'resolution' } }, { status: 400 }));
  function controller() {
    return B.createController({
      resolveAccountKey: async () => ACCOUNT,
      resolveCredentials: async () => ({ accountKey: ACCOUNT, config: options.native
        ? { platformVideo: true, provider: 'shaozhuang-native', platformModels: [{
          id: 'seedance-2.0', durations: [5], resolutions: ['480p', '720p'], ratios: ['16:9', '9:16'], generateAudio: false
        }] }
        : { apiKey: SECRET } }),
      storageGet: async key => ({ [key]: structuredClone(stored[key]) }),
      storageSet: async update => Object.assign(stored, structuredClone(update)),
      randomUUID: () => 'error-fixture-' + (++sequence),
      now: () => 1000 + sequence,
      createTimeoutMs: options.createTimeoutMs || 2000,
      statusTimeoutMs: options.statusTimeoutMs || 2000,
      // Every operation is resolved here. This suite never contacts a provider.
      fetch: async (url, init) => { calls.push({ url, init }); return reply(url, init); }
    });
  }
  return { stored, calls, controller, api: controller(), setReply(value) { reply = value; } };
}

function start(overrides = {}) {
  return { type: B.MESSAGE_TYPES.START, requestId: 'offline-request', idempotencyKey: 'offline-idempotency',
    request: { mode: 'direct', creativeRoute: 'free_direct', productKey: 'seedance-2.0',
      script: 'A ceramic product rotates continuously.', durationSeconds: 5, resolution: '720p',
      ratio: '9:16', audioMode: 'silent', images: [], videos: [], audios: [], ...overrides } };
}

function savedTasks(h) { return h.stored[B.TASK_KEY].accounts[ACCOUNT].tasks; }
function createdTask(h) { return Object.values(savedTasks(h)).find(task => task.taskId !== historical.taskId); }
function assertHistoryRetained(h) { assert.deepEqual(savedTasks(h)[historical.taskId], historical); }

test('HTTP 400 exposes exact provider diagnostics and retains them after a controller restart', async t => {
  const h = fixture(t, { reply: () => Response.json({ error: {
    code: 'InvalidParameter.Resolution', message: 'The selected resolution is unavailable for this model.', param: 'resolution'
  } }, { status: 400, headers: { 'x-request-id': 'provider-request-400' } }) });
  const result = await h.api.handleMessage(start());
  assert.equal(result.ok, false);
  assert.equal(result.payload.error.code, 'PROVIDER_HTTP_ERROR');
  for (const expected of ['HTTP 400', 'The selected resolution', 'InvalidParameter.Resolution', 'resolution', 'provider-request-400']) {
    assert.ok(result.payload.error.message.includes(expected), expected);
  }
  const task = createdTask(h);
  assert.equal(task.status, 'failed');
  assert.deepEqual(task.errorDetails, {
    status: 400, providerCode: 'InvalidParameter.Resolution',
    providerMessage: 'The selected resolution is unavailable for this model.',
    providerParam: 'resolution', providerRequestId: 'provider-request-400'
  });
  const restored = await h.controller().handleMessage({ type: B.MESSAGE_TYPES.STATUS, taskId: task.taskId });
  assert.equal(restored.ok, true);
  assert.equal(restored.payload.task.error, task.error);
  assert.deepEqual(restored.payload.task.errorDetails, task.errorDetails);
  assert.equal(h.calls.length, 1);
  assertHistoryRetained(h);
});

test('diagnostics redact echoed credentials, signed URLs and data URLs before display and storage', async t => {
  const unsafe = `${SECRET}; Bearer other-bearer-credential; api_key=labelled-api-credential; token=labelled-token; ` +
    'Cookie=session-cookie-secret; https://signed.fixture.test/material.png?token=signed-token; data:image/png;base64,private-image-bytes';
  const h = fixture(t, { reply: () => Response.json({ error: {
    code: 'InvalidContent', message: '素材不可用 ' + unsafe, param: 'content[1].image_url', request_id: 'redaction-receipt'
  }, debug: { apiKey: SECRET, request: unsafe } }, { status: 400 }) });
  const result = await h.api.handleMessage(start());
  const task = createdTask(h);
  const visibleAndStored = JSON.stringify({ error: result.payload.error, taskError: task.error, errorDetails: task.errorDetails });
  for (const value of [SECRET, 'other-bearer-credential', 'labelled-api-credential', 'labelled-token', 'session-cookie-secret',
    'https://signed.fixture.test', 'signed-token', 'data:image', 'private-image-bytes', '"debug"']) {
    assert.equal(visibleAndStored.includes(value), false, value);
  }
  assert.ok(task.error.includes('素材不可用'));
  assert.ok(task.error.includes('content[1].image_url'));
  assert.equal(task.errorDetails.providerRequestId, 'redaction-receipt');
  assert.equal(task.errorDetails.status, 400);
  assertHistoryRetained(h);
});

for (const status of [408, 409, 500, 503]) test('HTTP ' + status + ' keeps the original creation unknown and never resubmits', async t => {
  const h = fixture(t, { reply: () => Response.json({ error: {
    code: 'UpstreamBusy', message: 'The upstream receipt must be reconciled.', request_id: 'unknown-' + status
  } }, { status }) });
  const first = await h.api.handleMessage(start());
  const task = createdTask(h);
  assert.equal(first.ok, false);
  assert.equal(first.payload.error.code, 'PROVIDER_CREATE_UNCERTAIN');
  assert.equal(task.status, 'unknown');
  assert.equal(task.stateUncertain, true);
  assert.equal(task.errorDetails.status, status);
  assert.equal(task.errorDetails.stateUncertain, true);
  assert.ok(task.error.includes('UpstreamBusy'));
  assert.ok(task.error.includes('unknown-' + status));
  const repeated = await h.api.handleMessage(start());
  assert.equal(repeated.payload.error.code, 'PROVIDER_CREATE_UNCERTAIN');
  const retry = await h.api.handleMessage({ type: B.MESSAGE_TYPES.RETRY, taskId: task.taskId, idempotencyKey: 'never-submit-this' });
  assert.equal(retry.payload.error.code, 'PROVIDER_CREATE_UNCERTAIN');
  assert.equal(h.calls.length, 1);
  assertHistoryRetained(h);
});

test('network interruption and creation deadline preserve unknown tasks and do not retry', async t => {
  for (const scenario of ['network', 'timeout']) {
    const h = fixture(t, { createTimeoutMs: 5, reply: scenario === 'network'
      ? () => { throw new Error('socket dropped ' + SECRET); }
      : () => new Promise(() => {}) });
    const result = await h.api.handleMessage(start());
    const task = createdTask(h);
    assert.equal(task.status, 'unknown');
    assert.equal(task.stateUncertain, true);
    assert.equal(task.errorDetails.stateUncertain, true);
    assert.equal(result.payload.error.code, scenario === 'timeout' ? 'PROVIDER_CREATE_TIMEOUT' : 'PROVIDER_CREATE_UNCERTAIN');
    if (scenario === 'timeout') assert.equal(task.errorDetails.timeoutMs, 5);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    await h.api.handleMessage(start());
    assert.equal(h.calls.length, 1);
    assertHistoryRetained(h);
  }
});

test('native confirmed not-submitted error shows the specific reason and allows a definitive failed receipt', async t => {
  const h = fixture(t, { native: true, reply: () => Response.json({
    code: 'NATIVE_VIDEO_REQUEST_NOT_SUBMITTED', reasonCode: 'INVALID_RESOLUTION',
    error: { code: 'InvalidParameter.Resolution', message: '该模型不支持所选分辨率。', param: 'resolution' },
    request_id: 'native-400', providerSubmitted: false, definitiveFailure: true
  }, { status: 400, headers: { 'X-Sanjie-Provider-Submission': 'not-submitted' } }) });
  const result = await h.api.handleMessage(start());
  const task = createdTask(h);
  assert.equal(result.payload.error.code, 'NATIVE_VIDEO_REQUEST_NOT_SUBMITTED');
  assert.equal(task.status, 'failed');
  assert.equal(task.errorDetails.providerSubmitted, false);
  assert.equal(task.errorDetails.stateUncertain, false);
  assert.equal(task.errorDetails.reasonCode, 'INVALID_RESOLUTION');
  assert.ok(task.error.includes('该模型不支持所选分辨率'));
  assert.ok(task.error.includes('native-400'));
  assertHistoryRetained(h);
});

test('native HTTP 400 without a proven not-submitted marker remains unknown', async t => {
  const h = fixture(t, { native: true });
  const result = await h.api.handleMessage(start());
  assert.equal(result.payload.error.code, 'PROVIDER_CREATE_UNCERTAIN');
  assert.equal(createdTask(h).status, 'unknown');
  assert.equal(createdTask(h).errorDetails.status, 400);
  assert.equal(h.calls.length, 1);
  assertHistoryRetained(h);
});

test('provider asynchronous failure keeps diagnostic parameter and receipt in task history', async t => {
  const h = fixture(t, { reply: () => Response.json({ id: 'provider-task', status: 'queued' }) });
  const result = await h.api.handleMessage(start());
  const taskId = result.payload.task.taskId;
  h.setReply(() => Response.json({ id: 'provider-task', status: 'failed', error: {
    code: 'InvalidContent', message: 'Image could not be decoded.', param: 'content[1].image_url'
  } }, { headers: { 'x-tt-logid': 'failed-poll-receipt' } }));
  const status = await h.api.handleMessage({ type: B.MESSAGE_TYPES.STATUS, taskId });
  assert.equal(status.ok, true);
  assert.equal(status.payload.task.status, 'failed');
  assert.equal(status.payload.task.errorCode, 'InvalidContent');
  assert.ok(status.payload.task.error.includes('Image could not be decoded.'));
  assert.ok(status.payload.task.error.includes('content[1].image_url'));
  assert.ok(status.payload.task.error.includes('failed-poll-receipt'));
  assert.equal(createdTask(h).errorDetails.providerRequestId, 'failed-poll-receipt');
  assert.equal(h.calls.length, 2);
  assertHistoryRetained(h);
});

test('transient status failure persists diagnostics without changing a processing task and clears after recovery', async t => {
  const h = fixture(t, { reply: () => Response.json({ id: 'provider-task', status: 'processing' }) });
  const result = await h.api.handleMessage(start());
  const taskId = result.payload.task.taskId;
  h.setReply(() => Response.json({ error: { code: 'ServiceBusy', message: 'Try querying this task later.', request_id: 'query-503' } }, { status: 503 }));
  const failedQuery = await h.api.handleMessage({ type: B.MESSAGE_TYPES.STATUS, taskId });
  assert.equal(failedQuery.ok, false);
  assert.equal(createdTask(h).status, 'processing');
  assert.equal(createdTask(h).providerTaskId, 'provider-task');
  assert.equal(createdTask(h).errorDetails.providerRequestId, 'query-503');
  h.setReply(() => Response.json({ id: 'provider-task', status: 'processing', progress: 50 }));
  const recovered = await h.api.handleMessage({ type: B.MESSAGE_TYPES.STATUS, taskId });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.payload.task.status, 'processing');
  assert.equal(recovered.payload.task.error, '');
  assert.deepEqual(recovered.payload.task.errorDetails, {});
  assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 1);
  assertHistoryRetained(h);
});

test('shot quote accepts a contract-valid selected ratio and resolution without rewriting either', async t => {
  const h = fixture(t, { reply: () => Response.json({ id: 'provider-task', status: 'processing' }) });
  const message = start({ ratio: '1:1', resolution: '480p' });
  message.production = { planId: 'ratio-plan', shotId: 'ratio-shot', budgetYuan: 10, attempt: 1, maxAttempts: 1 };
  const result = await h.api.handleMessage(message);
  assert.equal(result.ok, true);
  const sent = JSON.parse(h.calls[0].init.body);
  assert.equal(sent.ratio, '1:1');
  assert.equal(sent.resolution, '480p');
  assert.equal(result.payload.task.production.estimatedYuan, 2.31);
  assertHistoryRetained(h);
});
