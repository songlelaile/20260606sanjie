import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const stage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relative = 'public/creative/labs/image-prompt-lab/studio-genesis-ui.js';
const baselineArg = process.argv.find(value => value.startsWith('--baseline-root='));
const baseline = baselineArg ? path.resolve(baselineArg.slice('--baseline-root='.length)) : path.resolve(stage, '../production-source');
const originalUi = fs.readFileSync(path.join(baseline, relative), 'utf8');
const candidateUi = fs.readFileSync(path.join(stage, relative), 'utf8');
const contract = fs.readFileSync(path.join(baseline, 'public/creative/labs/image-prompt-lab/studio-genesis-contract.js'), 'utf8');
const marker = "  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();";

function harness(source = candidateUi) {
  let dispatches = 0;
  const sandbox = {
    URLSearchParams,
    location: {search: '?studio=1'},
    document: {readyState: 'loading', addEventListener() {}},
    crypto: {randomUUID: () => 'test-id'},
    setTimeout, clearTimeout, console,
    SZ_CREATIVE_TOOLS_BRIDGE: {
      getAccountKey: async () => 'fixture-account',
      send() { dispatches++; throw new Error('Rendering must not dispatch'); },
    },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(contract, context, {filename: 'production-studio-genesis-contract.js'});
  const hook = `
  window.__historyDisplayTest = {
    renderSaved(saved) {
      bridge=window.SZ_CREATIVE_TOOLS_BRIDGE;engine=window.SZ_STUDIO_GENESIS;
      account='fixture-account';draft=clone(saved.draft);controller=engine.createController({bridge});
      const restored=controller.restore(saved.snapshot);if(!restored.ok)throw new Error(restored.error);
      initializing=false;const before=JSON.stringify(controller.snapshot());
      const html=resultsMarkup(allSlots());return {html,before,after:JSON.stringify(controller.snapshot())};
    }
  };
`;
  const ui = source === originalUi ? originalUi : candidateUi;
  assert.equal(ui.split(marker).length, 2, 'test hook must replace only the genesis boot listener');
  assert.equal(source.split(ui).length, 2, 'the exact genesis source must occur once');
  vm.runInContext(source.replace(ui, ui.replace(marker, hook + marker)), context, {filename: 'shipped-studio-genesis-ui.js'});
  return {context, dispatches: () => dispatches};
}

function saved(h, error, status = 'failed', extras = {}) {
  const engine = h.context.SZ_STUDIO_GENESIS;
  const settings = {...engine.defaults('main'), count: 1, model: 'image2'};
  const input = {id: 'original-task', name: '保留的商品任务', requirements: '原画面方案', products: [
    {name: 'original-product.png', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='},
  ]};
  const plan = JSON.parse(JSON.stringify(engine.createPlan(input, settings)));
  assert.equal(plan.ok, true, plan.error);
  const slot = {shot: plan.shots[0], status, item: null, error, archiveOk: false, archiveSaving: false,
    taskId: 'original-task', requestId: 'original-request', jobId: 'original-job', billingEventId: 'original-billing',
    ...extras};
  return {
    draft: {settings, tasks: [{...input, plan, confirmed: true}], marker: 'retain-draft'},
    snapshot: {version: engine.version, tasks: [{id: input.id, name: input.name, plan, slots: [slot]}],
      previousResults: [], busy: false, stopped: false, uncertain: status === 'uncertain' ? {jobId: 'original-job', taskId: 'original-task'} : null,
      accountKey: 'fixture-account', batchId: 'original-batch', jobId: '', message: '原记录', error: ''},
  };
}

function render(h, fixture) {
  const original = JSON.stringify(fixture);
  const result = h.context.__historyDisplayTest.renderSaved(fixture);
  assert.equal(JSON.stringify(fixture), original, 'saved draft and receipt must remain byte-equivalent');
  assert.equal(result.before, result.after, 'rendering must not change restored controller state');
  assert.equal(h.dispatches(), 0);
  if (fixture.snapshot.tasks[0].slots[0].status !== 'uncertain') assert.match(result.html, /data-task-id="original-task"/);
  assert.match(result.after, /original-task/);
  assert.match(result.after, /original-request/);
  assert.match(result.after, /original-billing/);
  return result.html;
}

const noLeak = (html, values) => values.forEach(value => assert.ok(!html.includes(value), `must hide ${value}`));

test('actual saved subscription failure renders safely with the original task and plan retained', () => {
  const h = harness();
  const html = render(h, saved(h, '供应订阅未配置，请联系管理员。本次未提交生图，请在供应配置恢复后重试。'));
  assert.match(html, /生成服务暂时繁忙。请先查看原任务记录，避免重复提交。/);
  noLeak(html, ['供应', '订阅', '配置', '未提交生图', '未扣费']);
});

test('the actual rebuilt views entry renders saved historical failures through the same safe display helper', () => {
  const views = fs.readFileSync(path.join(stage, 'public/creative/labs/image-prompt-lab/studio-views-20261010-credit-v3.js'), 'utf8');
  const h = harness(views);
  const html = render(h, saved(h, 'HTTP 409: {"error":"总积分池来源或会计状态需核对","apiKey":"SECRET_VALUE"}'));
  assert.match(html, /生成服务暂时繁忙。请先查看原任务记录，避免重复提交。/);
  noLeak(html, ['HTTP', '409', '总积分池', '会计', 'apiKey', 'SECRET_VALUE']);
});

test('HTTP 409 and JSON accounting bodies are classified without leaking diagnostics', () => {
  const h = harness();
  for (const error of [
    'HTTP 409: {"error":"总积分池来源或会计状态需核对","usd":0.012,"fx":7.1,"apiKey":"SECRET_KEY"}',
    'HTTP 409: {"error":{"code":"POOL_QUOTE_UNBACKED","message":"ledger mismatch USD FX SECRET_KEY"}}',
    {code: 'SOURCE_TRANSPORT_FAILED', message: 'upstream /private/source SECRET_KEY'},
    {code: 'CREDIT_SERVICE_UNAVAILABLE', message: '会计状态需要核对'},
  ]) {
    const html = render(h, saved(h, error));
    assert.match(html, /生成服务暂时繁忙。请先查看原任务记录，避免重复提交。/);
    noLeak(html, ['HTTP', '409', '总积分池', '会计', 'USD', 'FX', 'SECRET_KEY', 'apiKey', 'POOL_QUOTE', '/private']);
  }
});

test('unproven balance, login and rate-limit codes keep actionable categories and receipt checking', () => {
  const h = harness();
  for (const [error, category] of [
    [{code: 'INSUFFICIENT_BALANCE', message: 'SECRET_BALANCE'}, '可用积分不足，请补充积分。'],
    [{code: 'AUTH_REQUIRED', message: 'SECRET_ACCOUNT'}, '请恢复原账号登录后查看任务记录'],
    [{code: 'RATE_LIMITED', message: 'SECRET_RATE'}, '请求较多，服务暂时繁忙。'],
  ]) {
    const html = render(h, saved(h, error));
    assert.ok(html.includes(category));
    assert.match(html, /避免重复提交/);
    noLeak(html, ['SECRET_', '未扣费', '未提交', '请稍后再试']);
  }
});

test('only typed trusted non-submission metadata permits a retry-oriented display', () => {
  const h = harness();
  const proof = {code: 'CREDIT_SERVICE_UNAVAILABLE', error: 'SECRET_POOL', proxyNotSubmitted: true,
    providerSubmitted: false, definitiveFailure: true};
  const typed = render(h, saved(h, proof));
  assert.match(typed, /生成服务暂时繁忙。请稍后再试。/);
  const historicalString = render(h, saved(h, 'HTTP 409: ' + JSON.stringify(proof)));
  assert.match(historicalString, /查看原任务记录，避免重复提交/);
  noLeak(typed + historicalString, ['SECRET_POOL', '未扣费', '未提交生图']);
  const missingMarker = render(h, saved(h, {...proof, proxyNotSubmitted: false}));
  assert.match(missingMarker, /查看原任务记录/);
  const unknownCode = render(h, saved(h, {...proof, code: 'CUSTOM_ERROR'}));
  assert.match(unknownCode, /查看原任务记录/);
});

test('uncertain or submitted receipts override misleading failure or non-submission details', () => {
  const h = harness();
  for (const [error, status, extras] of [
    ['HTTP 503: SECRET_RECEIPT', 'uncertain', {}],
    [{code: 'REQUEST_ALREADY_SUBMITTED', message: 'SECRET_RECEIPT'}, 'failed', {}],
    [{code: 'INSUFFICIENT_BALANCE', providerSubmitted: true, message: 'SECRET_RECEIPT'}, 'failed', {}],
    [{error: {code: 'CREDIT_SERVICE_UNAVAILABLE', stateUncertain: true, message: 'SECRET_RECEIPT'}}, 'failed', {}],
    [{code: 'CREDIT_SERVICE_UNAVAILABLE', proxyNotSubmitted: true, providerSubmitted: false, definitiveFailure: true, error: {code: 'POOL_SOURCE_USAGE_UNPROVEN', message: 'SECRET_RECEIPT'}}, 'failed', {}],
    [{code: 'CREDIT_SERVICE_UNAVAILABLE', proxyNotSubmitted: true, providerSubmitted: false, definitiveFailure: true, errorCode: 'REQUEST_ALREADY_SUBMITTED'}, 'failed', {}],
    [{code: 'CREDIT_SERVICE_UNAVAILABLE', proxyNotSubmitted: true, providerSubmitted: false, definitiveFailure: true}, 'failed', {stateUncertain: true}],
  ]) {
    const html = render(h, saved(h, error, status, extras));
    assert.match(html, /请求结果尚未确认，请先查看原任务记录，避免重复提交。/);
    noLeak(html, ['SECRET_RECEIPT', '补充积分', '请稍后再试', '未扣费']);
  }
});

test('large, malformed and hostile saved bodies remain bounded and never render raw data', () => {
  const h = harness();
  for (const error of [
    'HTTP 409: {"error":"SECRET_VALUE",',
    'HTTP 503: <img src=x onerror="SECRET_VALUE">',
    'SECRET_VALUE' + 'x'.repeat(20000),
    '[{"message":"SECRET_VALUE"}]',
    {code: '<script>SECRET_VALUE</script>', message: 'SECRET_VALUE'},
  ]) {
    const html = render(h, saved(h, error));
    assert.match(html, /查看原任务记录/);
    noLeak(html, ['SECRET_VALUE', 'HTTP', '<script>', 'onerror=']);
    assert.ok(html.length < 1200);
  }
});

test('patch changes only error display; existing action attributes and empty-error cards are exact', () => {
  const original = harness(originalUi), candidate = harness();
  const fixture = saved(candidate, '供应订阅未配置');
  const baselineHtml = render(original, fixture), candidateHtml = render(candidate, fixture);
  assert.equal(candidateHtml, baselineHtml.replace('供应订阅未配置', '生成服务暂时繁忙。请先查看原任务记录，避免重复提交。'));
  const empty = saved(candidate, '');
  assert.equal(render(original, empty), render(candidate, empty));
  const start = candidateUi.indexOf('  // Display legacy snapshots safely');
  const end = candidateUi.indexOf('  function resultsMarkup(slots) {', start);
  assert.ok(start >= 0 && end > start);
  const removed = candidateUi.slice(0, start) + candidateUi.slice(end);
  assert.equal(removed.replace('esc(historicalSlotError(slot))', 'esc(slot.error.message||slot.error)'), originalUi,
    'all other production UI bytes must remain exact');
});
