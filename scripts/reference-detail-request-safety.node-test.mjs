import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

const stage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineArg = process.argv.find(value => value.startsWith('--baseline-root='));
const baseline = baselineArg ? path.resolve(baselineArg.slice('--baseline-root='.length)) : path.resolve(stage, '../production-source');
const lab = 'public/creative/labs/image-prompt-lab/';
const cfg = {
  provider: 'openai-compatible', imageAdapter: 'generic-json', apiKey: '',
  visionBaseUrl: 'https://sub.shaozhuangai.com/v1', visionModel: 'chatGPT5.5', textModel: 'chatGPT5.5',
  imageEndpoint: 'https://sub.shaozhuangai.com/v1/images/generations', imageModel: 'image2'
};
const ownCfg = { ...cfg, apiKey: 'synthetic-personal-key' };
const customCfg = { ...ownCfg, visionBaseUrl: 'https://provider.test/v1' };
const messages = [{ role: 'user', content: 'fixture' }];
const diagnostics = '总积分池会计来源 USD FX supplier-secret sk-private';
const snapshot = {
  snapshotId: 'snapshot-fixture', source: { capturedAt: '2026-10-10T00:00:00Z' },
  orderedBlocks: [{ blockId: 'blk-1', originalIndex: 0, type: 'unknown', salesRole: 'hero', text: '来源内容', sourceSummary: '来源概要', assetIds: [], completeness: 'complete' }],
  facts: [], assets: [], completeness: { overall: 'complete' }
};
const chunk = { chunkId: 'chunk-1', chunkIndex: 0, sourceBlockIds: ['blk-1'], ownedSourceBlockIds: ['blk-1'], blocks: snapshot.orderedBlocks };
const receipt = { taskId: 'task-fixture', requestId: 'request-fixture', jobId: 'job-fixture', billingEventId: 'billing-fixture' };
function success(content = '{}') { return Response.json({ choices: [{ message: { content } }] }); }
function rejection(status, body = {}, trusted = false) {
  return Response.json(body, { status, headers: trusted ? { 'X-Sanjie-Provider-Submission': 'not-submitted' } : {} });
}
function read(relative) { return fs.readFileSync(path.join(baseline, relative), 'utf8'); }
function harness(responder, runtime = false) {
  const requests = [], saved = new Map();
  const storage = {
    get length() { return saved.size; }, key: index => [...saved.keys()][index] || null,
    getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key)
  };
  const element = () => ({ style: {}, setAttribute() {}, addEventListener() {}, append() {}, showModal() {}, focus() {}, remove() {} });
  const sandbox = {
    URL, URLSearchParams, Request, Response, Headers, Blob, FormData, TextEncoder, TextDecoder,
    ArrayBuffer, Uint8Array, btoa, atob, console, AbortController, crypto: webcrypto,
    setTimeout: (fn, delay) => setTimeout(fn, delay >= 25000 ? 15 : delay < 4000 ? 0 : delay), clearTimeout,
    localStorage: storage, sessionStorage: storage, __SZ_PROMPTLAB_BACKGROUND_TEST_MODE__: true,
    location: { href: 'https://site.test/creative/labs/image-prompt-lab/promptlab.html', origin: 'https://site.test', search: '' },
    document: { readyState: 'loading', querySelectorAll: () => [], getElementById: () => null, createElement: element, addEventListener() {}, body: { appendChild() {}, classList: { contains: () => false, toggle() {} } } },
    addEventListener() {}, dispatchEvent() {}, authCheck: async () => ({ ok: true, user: { id: 'fixture-user' } }),
    fetch: async (input, init) => {
      const url = String(input);
      if (url === '/api/auth/me') return Response.json({ data: { id: 'fixture-user', tenantId: 'fixture-shop', username: 'fixture-user', creativeEntitlement: { allowed: true } } });
      assert.equal(url, '/api/creative/proxy');
      const envelope = JSON.parse(String(init.body));
      const request = { url: envelope.url, method: envelope.method, headers: envelope.headers, body: JSON.parse(envelope.bodyText), signal: init.signal };
      requests.push(request);
      return responder(request, requests.length);
    }
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(read('public/creative/web-chrome.js'), context, { filename: 'actual-web-chrome.js' });
  const prerequisite = read(lab + 'studio-prerequisites-20261009-v1.js');
  const marker = '/* Frozen source: public/creative/src/reference-detail-contract.js */';
  const start = prerequisite.indexOf(marker), end = prerequisite.indexOf('/* Frozen source:', start + marker.length);
  assert.ok(start >= 0 && end > start, 'Use the actual frozen reference contract');
  vm.runInContext(prerequisite.slice(start, end), context, { filename: 'actual-reference-detail-contract.js' });
  vm.runInContext(read(lab + 'viral-series-contract.js'), context, { filename: 'actual-viral-series-contract.js' });
  if (!runtime) vm.runInContext(read(lab + 'style-refresh-contract.js'), context, { filename: 'actual-style-refresh-contract.js' });
  const relative = lab + (runtime ? 'studio-runtime-20261010-credit-v3.js' : 'background.js');
  let source = fs.readFileSync(path.join(stage, relative), 'utf8');
  const hook = '  globalThis.__SZ_PROMPTLAB_BACKGROUND_TEST_API__ = {';
  assert.equal(source.split(hook).length, 2);
  source = source.replace(hook, '  globalThis.__REFERENCE_DETAIL_TEST__ = { referenceDetailModelJson, referenceDetailFetchJson, referenceDetailRetryable };\n' + hook);
  vm.runInContext(source, context, { filename: relative });
  return { api: context.__REFERENCE_DETAIL_TEST__, background: context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__, requests, context };
}
function model(h, config = cfg, signal) {
  return h.api.referenceDetailModelJson(config, messages, signal, { attempts: 0, limit: 4 }, 0);
}
function analyze(h, config = cfg, signal, budget = { attempts: 0, limit: 4 }) {
  return h.background.referenceDetailAnalyzeChunk(config, snapshot, chunk, [], signal, budget, Object.create(null), { effectiveConcurrency: 2, backpressureEvents: 0, cooldownUntil: 0 });
}
function safe(result) {
  const text = result.error || (result.warnings || []).join(' ');
  assert.doesNotMatch(text, /HTTP|\{.*error|总积分池|会计|USD|FX|supplier-secret|sk-private|未扣费|未提交生图/);
}

function sourcePayload(h) {
  const raw = {
    schema: 'REFERENCE_DETAIL_SOURCE_V1', schemaVersion: 1,
    source: { platform: 'taobao', itemId: '123456789', canonicalUrl: 'https://item.taobao.com/item.htm?id=123456789', sourceMode: 'current_page', capturedAt: '2026-10-10T00:00:00Z' },
    completeness: { source: 'complete', facts: 'complete', orderedBlocks: 'complete', assets: 'complete', evidence: 'complete' },
    orderedBlocks: [{ type: 'text', salesRole: 'hero', text: '收纳抽屉的取物动作', sourceSummary: '抽屉取物步骤', assetIds: [], factIds: [], evidenceIds: ['evidence-fixture'], completeness: 'complete' }],
    evidence: [{ evidenceId: 'evidence-fixture', kind: 'dom', sourcePath: 'detail-range:graphic-detail-to-shop-recommend:screen-1', completeness: 'complete' }],
    assets: [], facts: [], warnings: []
  };
  return vm.runInContext(`({ source: SZ_REFERENCE_DETAIL_CONTRACT.sanitizeSourceSnapshot(JSON.parse(${JSON.stringify(JSON.stringify(raw))})), targetScreenCount: 5 })`, h.context);
}
function chunkSuccess(request) {
  const text = request.body.messages[1].content[0].text;
  const projection = JSON.parse(text.split('来源数据：')[1]);
  return success(JSON.stringify({ modules: [{ sourceBlockIds: projection.chunk.ownedSourceBlockIds, type: 'text', salesRole: 'hero', visualBrief: { description: '通过收纳抽屉的取物动作展示操作顺序。' }, editableCopy: {}, productFactIds: [] }], warnings: [] }));
}
function job() { return { jobId: 'local-job-fixture', token: 'local-token-fixture', controller: new AbortController(), detailSliceSourceCache: Object.create(null) }; }

test('actual proxy requests omit empty Authorization and preserve personal keys on hosted/custom endpoints', async () => {
  for (const config of [cfg, ownCfg, customCfg]) {
    const h = harness(() => success());
    assert.equal((await model(h, config)).ok, true);
    assert.equal(h.requests.length, 1); assert.equal(h.requests[0].method, 'POST');
    assert.equal(h.requests[0].url, config.visionBaseUrl + '/chat/completions');
    assert.equal(h.requests[0].headers.Authorization, config.apiKey ? 'Bearer ' + config.apiKey : undefined);
    assert.ok(h.requests[0].headers['idempotency-key'] || config === customCfg);
    assert.equal(h.requests[0].body.response_format.type, 'json_object');
  }
  const missing = harness(() => { throw new Error('No key on custom endpoint must not dispatch'); });
  assert.equal((await model(missing, { ...customCfg, apiKey: '' })).code, 'missing_api_key');
  assert.equal(missing.requests.length, 0);
});

test('ordinary provider 5xx/409 cannot replay chunk POSTs; original machine identity survives safe fallback', async () => {
  for (const [status, body] of [[503, {}], [502, { code: 'upstream_unavailable' }], [409, { code: 'REQUEST_ALREADY_SUBMITTED', providerSubmitted: true, ...receipt }], [503, { code: 'CREDIT_SERVICE_UNAVAILABLE', ...receipt }]]) {
    const h = harness(() => rejection(status, { error: diagnostics, ...body }));
    const result = await analyze(h);
    safe(result); assert.equal(h.requests.length, 1); assert.equal(result.attempts, 1);
    assert.equal(result.stateUncertain, true); assert.equal(result.definitiveFailure, false);
    assert.match(result.warnings.join(' '), /原任务/); assert.equal(h.api.referenceDetailRetryable(result), false);
    if (body.requestId) for (const field of Object.keys(receipt)) assert.equal(result[field], receipt[field]);
  }
});

test('network rejection and abort timeout remain unknown with exactly one real POST', async () => {
  for (const timeout of [false, true]) {
    const h = harness(request => timeout ? new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(Object.assign(new Error(diagnostics), { name: 'AbortError' })), { once: true });
    }) : Promise.reject(new Error(diagnostics)));
    const result = await analyze(h);
    safe(result); assert.equal(h.requests.length, 1); assert.equal(result.attempts, 1);
    assert.equal(result.errorCode, timeout ? 'timeout' : 'network_error');
    assert.equal(result.stateUncertain, true); assert.equal(result.definitiveFailure, false);
    assert.match(result.warnings.join(' '), /原任务/);
  }
});

test('unreadable 200 envelope/content/oversized receipt never triggers a second model POST', async () => {
  for (const response of [() => new Response('{invalid'), () => success('not JSON ' + diagnostics), () => success('x'.repeat(1000001))]) {
    const h = harness(response);
    const result = await analyze(h);
    safe(result); assert.equal(h.requests.length, 1); assert.equal(result.attempts, 1);
    assert.equal(result.stateUncertain, true); assert.equal(result.definitiveFailure, false);
    assert.match(result.warnings.join(' '), /原任务/);
  }
});

test('real cancelled in-flight request preserves uncertainty; pre-aborted signal makes zero POSTs', async () => {
  const signal = new AbortController();
  const h = harness(request => new Promise((resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(Object.assign(new Error(diagnostics), { name: 'AbortError' })), { once: true });
    signal.abort();
  }));
  const result = await analyze(h, cfg, signal.signal);
  safe(result); assert.equal(result.cancelled, true); assert.equal(result.stateUncertain, true);
  assert.equal(result.definitiveFailure, false); assert.equal(h.requests.length, 1);
  const none = harness(() => { throw new Error('Already aborted'); });
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await analyze(none, cfg, aborted.signal)).cancelled, true);
  assert.equal(none.requests.length, 0);
});

test('trusted allowlisted pre-dispatch failure permits just the existing bounded retry and reuses unchanged evidence', async () => {
  for (const [status, code] of [[503, 'CREATIVE_REQUEST_NOT_SUBMITTED'], [429, 'CREATIVE_REQUEST_NOT_SUBMITTED'], [503, 'CREDIT_SERVICE_UNAVAILABLE']]) {
    const h = harness((request, count) => count === 1 ? rejection(status, { code, error: diagnostics, providerSubmitted: false, definitiveFailure: true }, true) : success());
    const result = await analyze(h);
    assert.equal(h.requests.length, 2); assert.equal(result.attempts, 2);
    assert.deepEqual(h.requests[1].body, h.requests[0].body);
    assert.equal(h.requests[1].url, h.requests[0].url);
    assert.equal(JSON.stringify(snapshot), JSON.stringify({ snapshotId: 'snapshot-fixture', source: { capturedAt: '2026-10-10T00:00:00Z' }, orderedBlocks: chunk.blocks, facts: [], assets: [], completeness: { overall: 'complete' } }));
  }
  const h = harness(() => rejection(503, { code: 'CREATIVE_REQUEST_NOT_SUBMITTED', error: diagnostics, providerSubmitted: false, definitiveFailure: true }, true));
  const result = await analyze(h);
  safe(result); assert.equal(h.requests.length, 2); assert.equal(result.attempts, 2);
  assert.equal(result.proxyNotSubmitted, true); assert.equal(result.providerSubmitted, false);
  assert.equal(result.definitiveFailure, true); assert.equal(result.stateUncertain, false);
});

test('forged/missing/contradictory proof and nonallowlisted upstream codes never replay', async () => {
  const proof = { code: 'CREATIVE_REQUEST_NOT_SUBMITTED', providerSubmitted: false, definitiveFailure: true };
  for (const [body, trusted] of [[proof, false], [{ ...proof, stateUncertain: true }, true], [{ ...proof, providerSubmitted: true }, true], [{ ...proof, definitiveFailure: false }, true], [{ ...proof, code: 'upstream_unavailable' }, true], [{ ...proof, code: 'POOL_SOURCE_USAGE_UNPROVEN' }, true], [{ ...proof, code: 'REQUEST_ALREADY_SUBMITTED' }, true]]) {
    const h = harness(() => rejection(503, { ...body, error: diagnostics }, trusted));
    const result = await analyze(h);
    safe(result); assert.equal(h.requests.length, 1); assert.equal(result.attempts, 1);
    assert.equal(result.stateUncertain, true); assert.equal(result.definitiveFailure, false);
  }
  for (const detail of [{ stateUncertain: true }, { code: 'POOL_SOURCE_USAGE_UNPROVEN' }, { code: 'REQUEST_ALREADY_SUBMITTED' }]) {
    const nested = harness(() => rejection(429, { ...proof, error: { ...detail, message: diagnostics } }, true));
    const nestedResult = await analyze(nested);
    safe(nestedResult); assert.equal(nested.requests.length, 1);
    assert.equal(nestedResult.stateUncertain, true); assert.equal(nestedResult.definitiveFailure, false);
    assert.match(nestedResult.warnings.join(' '), /原任务/);
  }
});

test('known ordinary request/config/balance failures do not retry or promise absence of charges', async () => {
  for (const [status, body] of [[400, { error: 'model_not_found ' + diagnostics }], [401, {}], [402, { code: 'INSUFFICIENT_BALANCE', providerSubmitted: false, definitiveFailure: true }], [429, {}]]) {
    const h = harness(() => rejection(status, body, status === 402));
    const result = await analyze(h);
    safe(result); assert.equal(h.requests.length, 1); assert.equal(result.attempts, 1);
    assert.equal(h.api.referenceDetailRetryable(result), false);
  }
});

test('trusted retry still obeys reserve for global synthesis and never exceeds local two-attempt ceiling', async () => {
  const h = harness(() => rejection(503, { code: 'CREATIVE_REQUEST_NOT_SUBMITTED', providerSubmitted: false, definitiveFailure: true }, true));
  const budget = { attempts: 0, limit: 2 };
  const result = await analyze(h, cfg, undefined, budget);
  assert.equal(h.requests.length, 1); assert.equal(budget.attempts, 1);
  assert.equal(result.errorCode, 'request_budget_exhausted'); assert.equal(result.attempts, 1);
});

test('rebuilt runtime executes the same actual no-key and no-replay paths', async () => {
  const h = harness(() => rejection(503, { code: 'CREDIT_SERVICE_UNAVAILABLE', error: diagnostics }), true);
  const result = await analyze(h);
  safe(result); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].headers.Authorization, undefined);
  assert.equal(result.stateUncertain, true); assert.equal(result.attempts, 1);
});

test('actual blueprint global synthesis preserves unknown receipt and editable fallback without replay', async () => {
  const h = harness((request, count) => count === 1 ? chunkSuccess(request) : rejection(503, { code: 'REQUEST_ALREADY_SUBMITTED', providerSubmitted: true, error: diagnostics, ...receipt }));
  const payload = sourcePayload(h), sourceBefore = JSON.stringify(payload.source);
  const result = await h.background.buildReferenceDetailBlueprint(cfg, payload, job());
  assert.equal(result.ok, true); assert.equal(result.buildStatus, 'partial');
  assert.equal(h.requests.length, 2); assert.equal(result.requestBudget.used, 2);
  assert.equal(result.stateUncertain, true); assert.equal(result.globalFailureReceipt.stateUncertain, true);
  assert.equal(result.globalFailureReceipt.definitiveFailure, false);
  for (const field of Object.keys(receipt)) assert.equal(result.globalFailureReceipt[field], receipt[field]);
  assert.equal(result.jobId, 'local-job-fixture');
  assert.match(result.warnings.join(' '), /原任务/); safe(result.globalFailureReceipt);
  assert.equal(JSON.stringify(payload.source), sourceBefore); assert.ok(result.blueprint);
});

test('actual blueprint chunk/global cancellation keeps unknown receipts and never invites rebuild', async () => {
  for (const cancelAt of [1, 2]) {
    const current = job();
    const h = harness((request, count) => count < cancelAt ? chunkSuccess(request) : new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(Object.assign(new Error(diagnostics), { name: 'AbortError' })), { once: true });
      current.controller.abort();
    }));
    const result = await h.background.buildReferenceDetailBlueprint(cfg, sourcePayload(h), current);
    assert.equal(result.ok, false); assert.equal(result.code, 'cancelled');
    assert.equal(result.stateUncertain, true); assert.equal(result.definitiveFailure, false);
    assert.equal(result.errorMeta.action, 'check_original_task'); assert.equal(result.errorMeta.retryable, false);
    assert.equal(result.jobId, 'local-job-fixture'); assert.equal(h.requests.length, cancelAt);
    assert.equal(result.analysisFailureReceipts.length, 1); safe(result);
    assert.equal(result.analysisFailureReceipts[0].stateUncertain, true);
  }
});

test('actual rebuilt chunk cancellation preserves unknown receipt without changing original blueprint identity', async () => {
  const current = job();
  const h = harness(request => new Promise((resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(Object.assign(new Error(diagnostics), { name: 'AbortError' })), { once: true });
    current.controller.abort();
  }));
  const payload = sourcePayload(h);
  const projected = h.context.SZ_REFERENCE_DETAIL_CONTRACT.projectDetailImageSource(payload.source);
  payload.chunkId = h.background.referenceDetailChunks(projected.snapshot)[0].chunkId;
  payload.baseBlueprintId = 'blueprint-fixture'; payload.baseRevisionId = 1;
  const original = JSON.stringify(payload);
  const result = await h.background.rebuildReferenceDetailChunk(cfg, payload, current);
  assert.equal(result.ok, false); assert.equal(result.code, 'cancelled');
  assert.equal(result.stateUncertain, true); assert.equal(result.definitiveFailure, false);
  assert.equal(result.errorMeta.action, 'check_original_task'); assert.equal(h.requests.length, 1);
  assert.equal(result.analysisFailureReceipts[0].code, 'cancelled'); safe(result);
  assert.equal(JSON.stringify(payload), original);
});
