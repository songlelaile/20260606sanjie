import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

const assetRoot = process.env.CREATIVE_ASSET_TEST_ROOT || 'public/creative';
const baselineRoot = process.env.CREATIVE_BASELINE_TEST_ROOT || assetRoot;
const customerConfig = {
  provider: 'openai-compatible', imageAdapter: 'generic-json', apiKey: '',
  visionBaseUrl: 'https://sub.shaozhuangai.com/v1', visionModel: 'chatGPT5.5', textModel: 'chatGPT5.5',
  imageEndpoint: 'https://sub.shaozhuangai.com/v1/images/generations', imageModel: 'image2'
};
const ownConfig = { ...customerConfig, apiKey: 'synthetic-key', visionBaseUrl: 'https://provider.test/v1', imageEndpoint: 'https://provider.test/v1/images/generations' };
const privateDiagnostic = '总积分池来源或会计状态需核对；USD supplier-secret FX_RATE_STALE';

function harness(responder) {
  const requests = [], saved = new Map();
  const storage = {
    get length() { return saved.size; }, key: index => [...saved.keys()][index] || null,
    getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key)
  };
  const element = () => ({ style: {}, setAttribute() {}, addEventListener() {}, append() {}, showModal() {}, focus() {}, remove() {} });
  const context = createContext({
    URL, URLSearchParams, Request, Response, Headers, Blob, FormData, TextEncoder, TextDecoder,
    ArrayBuffer, Uint8Array, btoa, atob, console, AbortController, crypto: webcrypto,
    setTimeout: (fn, delay) => setTimeout(fn, delay < 4000 ? 0 : delay), clearTimeout,
    localStorage: storage, sessionStorage: storage, __SZ_PROMPTLAB_BACKGROUND_TEST_MODE__: true,
    location: { href: 'https://site.test/creative/labs/image-prompt-lab/promptlab.html', origin: 'https://site.test', search: '' },
    document: { getElementById: () => null, createElement: element, addEventListener() {}, body: { appendChild() {}, classList: { contains: () => false, toggle() {} } } },
    addEventListener() {}, authCheck: async () => ({ ok: true, user: { id: 'alice' } }),
    fetch: async (input, init) => {
      const url = String(input);
      if (url === '/api/auth/me') return Response.json({ data: { id: 'alice', tenantId: 'shop', username: 'alice', creativeEntitlement: { allowed: true } } });
      assert.equal(url, '/api/creative/proxy');
      const envelope = JSON.parse(String(init.body));
      const request = { url: envelope.url, method: envelope.method, body: envelope.bodyText ? JSON.parse(envelope.bodyText) : null };
      requests.push(request);
      return responder(request, requests.length);
    }
  });
  context.window = context;
  for (const file of ['web-chrome.js', 'labs/image-prompt-lab/viral-series-contract.js', 'labs/image-prompt-lab/style-refresh-contract.js', 'labs/image-prompt-lab/background.js']) {
    const primary = resolve(assetRoot, file);
    runInContext(readFileSync(existsSync(primary) ? primary : resolve(baselineRoot, file), 'utf8'), context, { filename: file });
  }
  return { api: context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__, requests };
}

function rejection(status, body, trusted = false) {
  return Response.json(body, { status, headers: trusted ? { 'X-Sanjie-Provider-Submission': 'not-submitted' } : {} });
}
function assertSafe(result) {
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error, /HTTP|\{.*error|USD|FX_|supplier-secret|总积分池|会计|账本|来源|未扣费/);
}
function chat(h, cfg = customerConfig, model = cfg.visionModel) {
  return h.api.chatJson(cfg, [{ role: 'user', content: 'fixture' }], model, 0.2, 1000);
}
function imageRequest(h, url = customerConfig.imageEndpoint, body = {}) {
  return h.api.fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 1000);
}

test('real chatJson converts the legacy pool 409 and every source diagnostic to safe tenant copy', async () => {
  for (const body of [{ error: privateDiagnostic }, { code: 'POOL_SOURCE_SNAPSHOT_STALE', error: privateDiagnostic }, { code: 'CREDIT_POOL_INVALID', error: privateDiagnostic }]) {
    const h = harness(() => rejection(409, body));
    const result = await chat(h);
    assertSafe(result); assert.equal(result.error, '生成服务暂时繁忙，请稍后查看原任务进度，避免重复生成。');
    assert.equal(result.stateUncertain, true);
    assert.equal(result.status, 409); assert.equal(h.requests.length, 1);
    assert.equal(result.providerSubmitted, undefined);
  }
});

test('trusted pre-dispatch rejection preserves submission proof without leaking diagnostics', async () => {
  const h = harness(() => rejection(503, { code: 'CREATIVE_SUPPLY_UNAVAILABLE', error: privateDiagnostic, providerSubmitted: false, definitiveFailure: true }, true));
  const result = await imageRequest(h);
  assertSafe(result); assert.equal(result.error, '生成服务暂时繁忙，请稍后重试。');
  assert.equal(result.code, 'CREATIVE_SUPPLY_UNAVAILABLE'); assert.equal(result.providerSubmitted, false);
  assert.equal(result.definitiveFailure, true); assert.equal(result.stateUncertain, false); assert.equal(h.requests.length, 1);
});

test('402 distinguishes wallet credit from an API account and never derives no-charge from status', async () => {
  const h = harness(() => rejection(402, { code: 'INSUFFICIENT_BALANCE', error: 'private vendor detail', providerSubmitted: false, definitiveFailure: true, purchaseUrl: '/models' }, true));
  const result = await imageRequest(h);
  assertSafe(result); assert.equal(result.error, '可用积分不足，请补充积分后继续。');
  assert.equal(result.purchaseUrl, '/models'); assert.equal(result.providerSubmitted, false);
  const own = harness(() => rejection(402, { error: 'balance insufficient' }));
  const ownResult = await chat(own, ownConfig);
  assert.equal(ownResult.error, 'API 账户可用余额不足，请补充余额后继续。');
  assert.equal(ownResult.providerSubmitted, undefined); assertSafe(ownResult);
});

test('login, own-key authentication and rate limits have separate safe messages', async () => {
  const checks = [
    [401, customerConfig, '登录已失效，请重新登录后继续。'],
    [401, ownConfig, '模型服务鉴权失败，请检查 API Key。'],
    [429, customerConfig, '请求较多，请稍后再试。']
  ];
  for (const [status, cfg, expected] of checks) {
    const h = harness(() => rejection(status, { error: 'supplier-secret USD private response' }));
    const result = await chat(h, cfg);
    assertSafe(result); assert.equal(result.error, expected); assert.equal(h.requests.length, 1);
  }
});

test('untrusted false flags, pool 409, 5xx and network loss remain uncertain without paid retries', async () => {
  const responses = [
    () => rejection(503, { code: 'CREATIVE_SUPPLY_UNAVAILABLE', error: privateDiagnostic, providerSubmitted: false, definitiveFailure: true }),
    () => rejection(409, { error: privateDiagnostic }),
    () => rejection(402, { code: 'INSUFFICIENT_BALANCE', error: 'post-dispatch settlement failure' }),
    () => rejection(502, { error: 'supplier-secret' }),
    () => { throw new Error('supplier-secret USD config path'); }
  ];
  for (const responder of responses) {
    const h = harness(responder), result = await imageRequest(h);
    assertSafe(result); assert.equal(result.stateUncertain, true); assert.equal(result.definitiveFailure, false);
    assert.equal(result.providerSubmitted, undefined); assert.match(result.error, /原任务进度.*避免重复生成/);
    assert.doesNotMatch(result.error, /重试|补充/); assert.equal(h.requests.length, 1);
  }
});

test('submitted unknown preserves its original identifier, and model errors never cause paid resubmission', async () => {
  const h = harness(() => rejection(409, { code: 'CREATIVE_SUBMISSION_UNKNOWN', error: privateDiagnostic, providerSubmitted: true, stateUncertain: true, taskId: 'original-task-1' }));
  const result = await imageRequest(h);
  assertSafe(result); assert.equal(result.taskId, 'original-task-1'); assert.equal(result.providerSubmitted, true);
  assert.equal(result.stateUncertain, true); assert.equal(result.code, 'CREATIVE_SUBMISSION_UNKNOWN'); assert.equal(h.requests.length, 1);
  const textUnknown = harness(() => rejection(409, { code: 'model_not_found', error: 'model_not_found', providerSubmitted: true, stateUncertain: true }));
  const textResult = await chat(textUnknown, customerConfig, 'unavailable-fixture');
  assertSafe(textResult); assert.equal(textResult.stateUncertain, true); assert.equal(textUnknown.requests.length, 1);
  const retryUnknown = harness(() => rejection(429, { code: 'rate_limited', error: 'supplier-secret', providerSubmitted: true, stateUncertain: true }));
  const detailResult = await retryUnknown.api.runDetailPromptWithServiceRetry(customerConfig, [{ role: 'user', content: 'fixture' }], customerConfig.visionModel, 0.2, 1000);
  assertSafe(detailResult); assert.equal(detailResult.stateUncertain, true); assert.equal(retryUnknown.requests.length, 1);
  assert.equal(detailResult.serviceRetry.retries, 0);
});

test('bounded parsing ignores oversized and malformed provider error bodies', async () => {
  for (const body of ['{"code":"POOL_SOURCE_STALE","error":"' + 'supplier-secret'.repeat(2000) + '"}', '{"error":"supplier-secret"', '<html>supplier-secret USD</html>']) {
    const h = harness(() => new Response(body, { status: 503 }));
    const result = await imageRequest(h); assertSafe(result); assert.equal(result.stateUncertain, true); assert.equal(h.requests.length, 1);
  }
});

test('the real detail retry path never repeats an unproven chat 503, network loss, timeout or malformed paid receipt', async () => {
  const responses = [
    () => rejection(503, { error: 'supplier-secret' }),
    () => rejection(503, { code: 'CREATIVE_REQUEST_NOT_SUBMITTED', providerSubmitted: false, definitiveFailure: true }),
    () => { throw new Error('supplier-secret'); },
    () => { throw new DOMException('supplier-secret timeout', 'AbortError'); },
    () => new Response('<html>supplier-secret</html>', { status: 200 }),
    () => Response.json({ choices: [{ message: { content: 'supplier-secret invalid JSON' } }] })
  ];
  for (const responder of responses) {
    const h = harness(responder);
    const result = await h.api.runDetailPromptWithServiceRetry(customerConfig, [{ role: 'user', content: 'fixture' }], customerConfig.visionModel, 0.2, 1000);
    assertSafe(result); assert.equal(result.stateUncertain, true); assert.equal(result.definitiveFailure, false);
    assert.equal(result.serviceRetry.retries, 0); assert.equal(h.requests.length, 1); assert.doesNotMatch(result.error, /重试/);
  }
});

test('bounded retry is allowed only after a trusted local proxy receipt proves that no provider POST was submitted', async () => {
  const h = harness((_request, count) => count === 1 ? rejection(503, { code: 'CREATIVE_REQUEST_NOT_SUBMITTED', error: 'supplier-secret', providerSubmitted: false, definitiveFailure: true }, true)
    : Response.json({ choices: [{ message: { content: '{"ready":true}' } }] }));
  const result = await h.api.runDetailPromptWithServiceRetry(customerConfig, [{ role: 'user', content: 'fixture' }], customerConfig.visionModel, 0.2, 1000);
  assert.equal(result.ok, true); assert.equal(result.serviceRetry.retries, 1); assert.equal(h.requests.length, 2);
});

test('model_not_found retains the hosted text fallback and the own-API setup error', async () => {
  const h = harness((_req, count) => count === 1 ? rejection(404, { error: { code: 'model_not_found', message: 'model not supported' } })
    : Response.json({ choices: [{ message: { content: '{"ready":true}' } }] }));
  const result = await chat(h, { ...customerConfig, visionModel: 'unavailable-fixture', textModel: 'unavailable-fixture' }, 'unavailable-fixture');
  assert.equal(result.ok, true); assert.equal(h.requests.length, 2); assert.equal(result.modelFallback.to, 'chatGPT5.5');
  const own = harness(() => rejection(404, { error: { code: 'model_not_found', message: 'model not supported' } }));
  const ownResult = await chat(own, ownConfig);
  assertSafe(ownResult); assert.equal(ownResult.code, 'model_not_found'); assert.equal(own.requests.length, 1);
});

test('DashScope create and poll errors preserve uncertainty and the original task without raw bodies', async () => {
  const cfg = { ...ownConfig, provider: 'dashscope', imageAdapter: 'dashscope-wan', imageModel: 'wan2.6-image', imageEndpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation' };
  const create = harness(() => rejection(503, { error: privateDiagnostic }));
  const created = await create.api.createDashScopeImageTask(cfg, { prompt: 'fixture', size: '1024*1024', count: 1 });
  assertSafe(created); assert.equal(created.stateUncertain, true); assert.equal(create.requests.length, 1);
  for (const response of [() => rejection(409, { error: privateDiagnostic }), () => Response.json({ output: { task_status: 'UNKNOWN' }, private: 'supplier-secret' })]) {
    const h = harness(response), result = await h.api.pollImageTask(cfg, cfg.imageEndpoint, 'original-task-1', 0);
    assertSafe(result); assert.equal(result.taskId, 'original-task-1'); assert.equal(result.providerSubmitted, true);
    assert.equal(result.stateUncertain, true); assert.equal(h.requests[0].method, 'GET'); assert.equal(h.requests.length, 1);
    assert.equal(result.raw, undefined); assert.doesNotMatch(result.error, /重试/);
  }
});
