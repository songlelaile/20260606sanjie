#!/usr/bin/env node
'use strict';

// Actual public studio HTML/CSS/JS, isolated browser storage and explicit local
// analysis/generation fixtures. Every external browser request is denied.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('/Users/shaozhuang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { createDemoServer } = require('./studio-main-demo.cjs');

const root = path.resolve(__dirname, '..');
const output = path.resolve(root, process.env.STUDIO_NAVIGATION_OUTPUT || 'docs/uat-studio-navigation-20261010/browser');
const port = Number(process.env.STUDIO_NAVIGATION_PORT || 18838);
const sourceFiles = ['public/creative/labs/image-prompt-lab/promptlab.html', 'public/creative/labs/image-prompt-lab/studio-genesis-ui.js', 'public/creative/labs/image-prompt-lab/studio-genesis-contract.js', 'public/creative/labs/image-prompt-lab/studio-genesis.css', 'public/creative/labs/image-prompt-lab/creative-credit-hints.js', 'scripts/verify-studio-step-navigation.cjs'];
const report = { startedAt: new Date().toISOString(), scope: 'Actual local public studio UI; explicit fixture analysis and generation; no paid provider', checks: [], screenshots: [], browserErrors: [], externalRequests: [] };
let demo, browser, context, page;
fs.mkdirSync(output, { recursive: true });

function check(name, passed, detail) {
  const item = { name, passed: Boolean(passed) };
  if (detail !== undefined) item.detail = detail;
  report.checks.push(item);
  if (!passed) throw new Error(`${name}: ${JSON.stringify(detail)}`);
}
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const action = name => page.locator(`#studioGenesisRoot [data-action="${name}"]`).first();
const step = index => page.locator(`#studioGenesisRoot .sg-steps [data-action="navigate-step"][data-step="${index}"]`);
async function activeStep() {
  return page.locator('#studioGenesisRoot .sg-steps').evaluate(element => {
    const active = element.querySelector('[aria-current="step"]');
    const button = active?.matches('[data-action="navigate-step"]') ? active : active?.querySelector('[data-action="navigate-step"]');
    return button ? Number(button.dataset.step) : -1;
  });
}
async function waitStep(index) {
  await page.waitForFunction(index => {
    const active = document.querySelector('#studioGenesisRoot .sg-steps [aria-current="step"]');
    const button = active?.matches('[data-action="navigate-step"]') ? active : active?.querySelector('[data-action="navigate-step"]');
    return button && Number(button.dataset.step) === index;
  }, index);
}
async function ready() {
  await page.waitForFunction(() => {
    const tabs = document.querySelectorAll('#studioGenesisRoot [data-action="mode"]');
    return tabs.length === 3 && [...tabs].every(button => !button.disabled);
  });
}
async function screenshot(name) {
  const file = `${name}.png`;
  await page.screenshot({ path: path.join(output, file), fullPage: true });
  report.screenshots.push(file);
}
async function planValues() {
  return page.locator('#studioGenesisRoot [data-shot]').evaluateAll(elements => elements.map(element => element.value));
}
async function changeMode(mode) {
  await page.locator(`#studioGenesisRoot [data-action="mode"][data-mode="${mode}"]`).click();
  await page.waitForFunction(mode => document.querySelector(`#studioGenesisRoot [data-action="mode"][data-mode="${mode}"]`)?.getAttribute('aria-selected') === 'true', mode);
  await ready();
}
async function editFirstPlan(marker) {
  const first = page.locator('#studioGenesisRoot [data-shot]').first();
  const original = await first.inputValue();
  await first.fill(`${marker}\n${original}`);
  await first.press('Tab');
  return planValues();
}
async function assertPlans(name, expected) {
  const actual = await planValues();
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { expectedHashes: expected.map(hash), actualHashes: actual.map(hash) });
}
async function waitSavedPlans(expected) {
  // Text edits use the actual UI's debounced save. Confirm that durable state
  // exists before testing how an explicit URL restores it on reload.
  for (let attempt = 0; attempt < 240; attempt++) {
    const persisted = await page.evaluate(async expected => {
      const suffix = window.__SANJIE_ENVIRONMENT ? `:${window.__SANJIE_ENVIRONMENT}` : '';
      const database = await new Promise((resolve, reject) => { const request = indexedDB.open(`sz_studio_genesis_v1${suffix}`, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const records = await new Promise((resolve, reject) => { const request = database.transaction('drafts').objectStore('drafts').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      database.close();
      return records.some(record => JSON.stringify(record.draft?.tasks[0]?.plan?.shots.map(shot => shot.prompt)) === JSON.stringify(expected));
    }, expected);
    if (persisted) return;
    await page.waitForTimeout(50);
  }
  throw new Error('Edited plan was not saved in IndexedDB within 12 seconds.');
}
async function savedDraftSummary() {
  return page.evaluate(async () => {
    const suffix = window.__SANJIE_ENVIRONMENT ? `:${window.__SANJIE_ENVIRONMENT}` : '';
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open(`sz_studio_genesis_v1${suffix}`, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const records = await new Promise((resolve, reject) => { const request = database.transaction('drafts').objectStore('drafts').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    database.close();
    const taskSummary = task => ({ requirements: task.requirements, confirmed: task.confirmed, signature: task.plan?.signature, prompts: task.plan?.shots.map(shot => shot.prompt), typeDrafts: Object.fromEntries(Object.entries(task.typeDrafts || {}).map(([type, saved]) => [type, { requirements: saved.requirements, confirmed: saved.confirmed, signature: saved.plan?.signature, prompts: saved.plan?.shots.map(shot => shot.prompt) }])) });
    return records.map(record => ({ savedAt: record.savedAt, settings: record.draft?.settings, tasks: record.draft?.tasks.map(taskSummary) }));
  });
}
async function requireInitialInput() {
  await waitStep(0);
  check('five focusable step controls exist', await page.locator('#studioGenesisRoot .sg-steps [data-action="navigate-step"]').count() === 5);
  check('unvisited analysis, plan, generation and results cannot be entered', await Promise.all([1, 2, 3, 4].map(index => step(index).isDisabled())).then(values => values.every(Boolean)));
  check('generation requires confirmed plan', await action('generate').isDisabled());
}
async function geometry(label) {
  const detail = await page.evaluate(() => {
    const root = document.querySelector('#studioGenesisRoot');
    const viewport = window.innerWidth;
    const overflow = [...root.querySelectorAll('*')].filter(element => {
      if (!element.getClientRects().length) return false;
      const box = element.getBoundingClientRect();
      return box.left < -1 || box.right > viewport + 1;
    }).slice(0, 12).map(element => ({ tag: element.tagName, class: element.className, right: Math.round(element.getBoundingClientRect().right) }));
    return { viewport, documentWidth: document.documentElement.scrollWidth, rootWidth: Math.round(root.getBoundingClientRect().width), overflow };
  });
  check(label, detail.documentWidth <= detail.viewport + 1 && detail.overflow.length === 0, detail);
}
async function captureFixturePayloads() {
  await page.evaluate(() => {
    const bridge = window.SZ_CREATIVE_TOOLS_BRIDGE;
    const original = bridge.send.bind(bridge);
    window.__NAVIGATION_CAPTURED_PAYLOADS = [];
    window.__NAVIGATION_INJECTED_FAILURES = 0;
    bridge.send = async (type, message) => {
      if (type === 'GENERATE_IMAGE') {
        const payload = message.payload || {};
        const plan = payload.studioGenesisPlan?.plan;
        window.__NAVIGATION_CAPTURED_PAYLOADS.push({ imageType: payload.imageType, labMode: payload.labMode, detailScreenIndex: payload.detailScreenIndex, detailScreenTotal: payload.detailScreenTotal, prompt: payload.prompt, modules: plan?.settings.modules, labels: plan?.shots.map(shot => shot.label), signature: plan?.signature });
        if (window.__NAVIGATION_FAIL_NEXT_GENERATION) {
          window.__NAVIGATION_FAIL_NEXT_GENERATION = false;
          window.__NAVIGATION_INJECTED_FAILURES++;
          return { ok: false, definitiveFailure: true, error: 'NAV_LOCAL_FAILURE_FIXTURE：新方案生成失败。' };
        }
      }
      return original(type, message);
    };
  });
}

async function main() {
  report.sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
  demo = createDemoServer({ port });
  await new Promise((resolve, reject) => { demo.server.once('error', reject); demo.server.listen(port, '127.0.0.1', resolve); });
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addInitScript(() => {
    let observed;
    window.__NAVIGATION_ENGINE_EVENTS = [];
    Object.defineProperty(window, 'SZ_STUDIO_GENESIS', { configurable: true, get: () => observed, set: api => {
      const record = (name, output) => { window.__NAVIGATION_ENGINE_EVENTS.push({ name, ok: output?.ok, code: output?.code, error: output?.error, signature: output?.signature, firstPrompt: output?.shots?.[0]?.prompt.slice(0, 100) }); return output; };
      observed = Object.freeze({ ...api, createPlan: (...args) => record('createPlan', api.createPlan(...args)), editShot: (...args) => record('editShot', api.editShot(...args)) });
    } });
  });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === demo.origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    report.externalRequests.push({ url: route.request().url(), method: route.request().method() });
    return route.abort();
  });
  page = await context.newPage();
  page.on('pageerror', error => report.browserErrors.push(error.message));
  page.setDefaultTimeout(12000);
  const url = `${demo.origin}/creative/labs/image-prompt-lab/promptlab.html?source=web&studio=1&mode=main&demo=1`;
  await page.goto(url);
  await ready();
  await requireInitialInput();
  await screenshot('desktop-initial-input');

  await page.locator('#studioGenesisRoot [data-files]').setInputFiles(demo.productPath);
  await page.locator('#studioGenesisRoot .sg-asset').waitFor();
  await ready();
  check('actual product file uploaded once', await page.locator('#studioGenesisRoot .sg-asset').count() === 1);
  await page.locator('#sgBrief').fill('NAV_MAIN_REQUIREMENTS：突出商品主体，简洁方图，展示提手。');
  await page.locator('#sgBrief').press('Tab');
  const mainRequirements = await page.locator('#sgBrief').inputValue();

  await action('plan').click();
  await waitStep(2);
  const mainLocalPlan = await planValues();
  check('local plan reaches review without a fixture model call', mainLocalPlan.length === 1 && demo.metrics.fixtureAnalysis === 0 && demo.metrics.fixtureGeneration === 0);
  check('generate remains disabled before confirmation', await action('generate').isDisabled());
  await action('back-input').click();
  await waitStep(0);
  check('return to input shows entered main requirements', await page.locator('#sgBrief').inputValue() === mainRequirements);
  await step(2).click();
  await waitStep(2);
  await assertPlans('returning to the existing review preserves the full plan', mainLocalPlan);
  check('unfinished generation and result steps remain locked', await step(3).isDisabled() && await step(4).isDisabled());

  await action('back-input').click();
  await action('analyze').click();
  await waitStep(1);
  check('analysis in flight blocks step navigation and type switching', await page.locator('#studioGenesisRoot .sg-steps [data-action="navigate-step"]').evaluateAll(elements => elements.every(element => element.disabled)) && await page.locator('#studioGenesisRoot [data-action="mode"]').evaluateAll(elements => elements.every(element => element.disabled)));
  await waitStep(2);
  check('fixture analysis invoked exactly once', demo.metrics.fixtureAnalysis === 1, demo.metrics.fixtureAnalysis);
  check('completed analysis is reachable', !(await step(1).isDisabled()));
  await step(1).click();
  await waitStep(1);
  check('saved product analysis is visible when visiting analysis step', await page.locator('#studioGenesisRoot').innerText().then(text => text.includes('本地交互演示 · 分析示例')));
  await step(2).click();
  await waitStep(2);
  const mainPlan = await editFirstPlan('NAV_MAIN_PLAN_EDIT');
  await page.locator('#studioGenesisRoot [data-confirm]').check();
  check('main plan becomes generateable after confirmation', !(await action('generate').isDisabled()));
  await screenshot('desktop-main-plan');

  await changeMode('detail');
  await waitStep(0);
  check('detail starts with its own empty requirements', await page.locator('#sgBrief').inputValue() === '');
  check('detail has its own default ratio and screen count', await page.locator('[data-setting="ratio"]').inputValue() === '3:4' && await page.locator('[data-setting="count"]').inputValue() === '5');
  check('detail does not inherit main analysis or review availability', await step(1).isDisabled() && await step(2).isDisabled());
  check('product input is shared across creative types', await page.locator('#studioGenesisRoot .sg-asset').count() === 1);
  await page.locator('#sgBrief').fill('NAV_DETAIL_REQUIREMENTS：整组两屏，展示结构细节和使用场景，按阅读顺序。');
  await page.locator('#sgBrief').press('Tab');
  await page.locator('[data-setting="count"]').selectOption('2');
  const detailRequirements = await page.locator('#sgBrief').inputValue();
  await page.locator('[data-action="module-mode"][data-value="custom"]').click();
  const selectedModules = await page.locator('#studioGenesisRoot [data-module]').evaluateAll(elements => elements.slice(0, 2).map(element => element.dataset.module));
  for (let index = 0; index < selectedModules.length; index++) await page.locator('#studioGenesisRoot [data-module]').nth(index).check();
  await page.locator('[data-action="module-move"][data-index="1"][data-delta="-1"]').click();
  const detailModuleOrder = selectedModules.slice().reverse();
  const screenOrderText = await page.locator('.sg-screen-order li > span').allTextContents();
  check('custom detail screens move into the requested reading order', screenOrderText.length === 2 && screenOrderText.every((text, index) => text.includes(detailModuleOrder[index])), screenOrderText);
  await action('analyze').click();
  await waitStep(2);
  const detailPlan = await editFirstPlan('NAV_DETAIL_PLAN_EDIT');
  check('detail produces the selected two screen sequence', detailPlan.length === 2);
  check('detail review follows the reordered module sequence', await page.locator('.sg-plan-list .sg-shot h3').allTextContents().then(headings => headings.length === 2 && headings.every((text, index) => text.includes(detailModuleOrder[index]))));
  await page.locator('#studioGenesisRoot [data-confirm]').check();
  await assertPlans('detail edits survive confirmation render', detailPlan);
  await screenshot('desktop-detail-plan');
  await waitSavedPlans(detailPlan);
  report.beforeExplicitReload = await savedDraftSummary();
  report.beforeReloadEngineEvents = await page.evaluate(() => window.__NAVIGATION_ENGINE_EVENTS);
  await assertPlans('detail edit remains in UI after its durable save', detailPlan);

  await page.reload();
  await ready();
  check('explicit main URL restores main after reloading an active detail draft', await page.locator('[data-action="mode"][data-mode="main"]').getAttribute('aria-selected') === 'true' && await page.locator('#sgBrief').inputValue() === mainRequirements);
  await waitStep(2);
  await assertPlans('explicit main reload restores its original edited plan', mainPlan);
  await assertPlans('switching back restores main plan edits', mainPlan);
  check('switching back restores main confirmation', await page.locator('#studioGenesisRoot [data-confirm]').isChecked());
  await action('back-input').click();
  await waitStep(0);
  check('main requirements and ratio are isolated from detail', await page.locator('#sgBrief').inputValue() === mainRequirements && await page.locator('[data-setting="ratio"]').inputValue() === '1:1');
  await changeMode('detail');
  await waitStep(2);
  await assertPlans('switching back restores detail plan edits', detailPlan);
  await action('back-input').click();
  await waitStep(0);
  check('detail requirements and reordered screen count survive a mode round trip', await page.locator('#sgBrief').inputValue() === detailRequirements && await page.locator('.sg-screen-order li').count() === 2 && await page.locator('.sg-screen-order li > span').allTextContents().then(values => values.every((text, index) => text.includes(detailModuleOrder[index]))));

  await changeMode('ad');
  await waitStep(0);
  check('advertising starts with independent requirements and plan', await page.locator('#sgBrief').inputValue() === '' && await step(2).isDisabled());
  await page.locator('#sgBrief').fill('NAV_AD_REQUIREMENTS：投放广告诉求，保留真实商品外观。');
  await page.locator('#sgBrief').press('Tab');
  const adRequirements = await page.locator('#sgBrief').inputValue();
  await action('plan').click();
  await waitStep(2);
  const adPlan = await editFirstPlan('NAV_AD_PLAN_EDIT');
  await changeMode('main');
  // Main was left at input; visiting its review must restore the existing plan.
  await step(2).click();
  await waitStep(2);
  await assertPlans('advertising work preserves the main plan', mainPlan);
  await changeMode('ad');
  await waitStep(2);
  await assertPlans('advertising restores its own plan', adPlan);
  await action('back-input').click();
  check('advertising restores its own requirements', await page.locator('#sgBrief').inputValue() === adRequirements);
  await changeMode('main');
  await step(2).click();
  await waitStep(2);
  await page.locator('#studioGenesisRoot [data-confirm]').check();
  await captureFixturePayloads();

  await action('generate').click();
  await waitStep(3);
  const blockedWhileGenerating = await page.locator('#studioGenesisRoot .sg-steps [data-action="navigate-step"]').evaluateAll(elements => elements.every(element => element.disabled));
  check('generation in flight disables all step navigation', blockedWhileGenerating);
  check('generation in flight blocks type switching and returning to input', await page.locator('#studioGenesisRoot [data-action="mode"]').evaluateAll(elements => elements.every(element => element.disabled)) && await action('back-input').isDisabled());
  await screenshot('desktop-generating');
  await waitStep(4);
  await ready();
  await page.locator('#studioGenesisRoot .sg-result img').first().waitFor();
  const resultUrl = await page.locator('#studioGenesisRoot .sg-result img').first().getAttribute('src');
  check('one fixture generation completes and archives once', demo.metrics.fixtureGeneration === 1 && demo.metrics.localArchives === 1, { generated: demo.metrics.fixtureGeneration, archives: demo.metrics.localArchives });
  check('result confirms it is stored in local history', await page.locator('#studioGenesisRoot .sg-result').innerText().then(text => text.includes('已存入本机历史')));
  await screenshot('desktop-completed-result');
  await action('back-input').click();
  await waitStep(0);
  check('completed work can return to input', await page.locator('#sgBrief').inputValue() === mainRequirements);
  await step(2).click();
  await waitStep(2);
  await assertPlans('completed generation retains the editable plan on review', mainPlan);
  await step(4).click();
  await waitStep(4);
  check('completed original survives input and plan navigation', await page.locator('#studioGenesisRoot .sg-result img').first().getAttribute('src') === resultUrl);
  check('navigation does not submit another analysis or generation', demo.metrics.fixtureAnalysis === 2 && demo.metrics.fixtureGeneration === 1, { analysis: demo.metrics.fixtureAnalysis, generation: demo.metrics.fixtureGeneration });
  report.submittedPayloads = await page.evaluate(() => window.__NAVIGATION_CAPTURED_PAYLOADS);
  await action('back-input').click();
  await page.reload();
  await ready();
  check('refresh keeps uploaded product and main input', await page.locator('#studioGenesisRoot .sg-asset').count() === 1 && await page.locator('#sgBrief').inputValue() === mainRequirements);
  await step(2).click();
  await waitStep(2);
  await assertPlans('local draft restores main plan after refresh', mainPlan);
  await step(4).click();
  await waitStep(4);
  check('local draft restores the completed original after refresh', await page.locator('#studioGenesisRoot .sg-result img').first().getAttribute('src') === resultUrl);
  await captureFixturePayloads();
  await changeMode('detail');
  await step(2).click();
  await waitStep(2);
  await assertPlans('detail plan and reading order survive explicit main reloads', detailPlan);
  await page.locator('#studioGenesisRoot [data-confirm]').check();
  await action('generate').click();
  await waitStep(4);
  await ready();
  check('both detail screens complete and archive exactly once', demo.metrics.fixtureGeneration === 3 && demo.metrics.localArchives === 3 && await page.locator('#studioGenesisRoot .sg-result img').count() === 2, { generated: demo.metrics.fixtureGeneration, archives: demo.metrics.localArchives });
  const detailPayloads = await page.evaluate(() => window.__NAVIGATION_CAPTURED_PAYLOADS.filter(payload => payload.imageType === 'detail'));
  check('reordered detail modules reach both actual fixture generation payloads', detailPayloads.length === 2 && detailPayloads.every((payload, index) => payload.labMode === 'detail' && payload.detailScreenIndex === index + 1 && payload.detailScreenTotal === 2 && JSON.stringify(payload.modules) === JSON.stringify(detailModuleOrder) && JSON.stringify(payload.labels) === JSON.stringify(detailModuleOrder) && payload.prompt.includes(detailModuleOrder[index])), detailPayloads.map(payload => ({ imageType: payload.imageType, detailScreenIndex: payload.detailScreenIndex, detailScreenTotal: payload.detailScreenTotal, modules: payload.modules, labels: payload.labels })));
  await screenshot('desktop-detail-completed-result');
  await changeMode('main');
  await waitStep(4);
  check('switching back to completed main does not enable another generation', await action('generate').isDisabled());
  check('completed main keeps its one of one progress after detail generation', await page.locator('.sg-run-summary').innerText().then(text => text.includes('1/1') && text.includes('已完成')));
  check('completed main restores the same original after both types have generated', await page.locator('#studioGenesisRoot .sg-result img').count() === 1 && await page.locator('#studioGenesisRoot .sg-result img').first().getAttribute('src') === resultUrl);
  check('returning to completed main does not submit or archive extra images', demo.metrics.fixtureGeneration === 3 && demo.metrics.localArchives === 3);
  await action('back-input').click();
  await waitStep(0);
  await page.locator('#sgBrief').fill(`${mainRequirements}\nNAV_CHANGED_AFTER_GENERATION：重新规划画面背景。`);
  await page.locator('#sgBrief').press('Tab');
  check('editing input invalidates the old review and confirmation', await step(2).isDisabled() && await action('generate').isDisabled());
  check('editing input keeps the previous generated original reachable', !(await step(4).isDisabled()));
  await step(4).click();
  await waitStep(4);
  check('previous result becomes a historical version without being deleted', await page.locator('#studioGenesisRoot .sg-result img').first().getAttribute('src') === resultUrl && await page.locator('#studioGenesisRoot .sg-result').innerText().then(text => text.includes('历史版本')));
  check('editing and revisiting history do not generate or archive again', demo.metrics.fixtureGeneration === 3 && demo.metrics.localArchives === 3);
  await screenshot('desktop-result-history-after-edit');
  await action('back-input').click();
  await action('plan').click();
  await waitStep(2);
  await page.locator('#studioGenesisRoot [data-confirm]').check();
  await page.evaluate(() => { window.__NAVIGATION_FAIL_NEXT_GENERATION = true; });
  await action('generate').click();
  await waitStep(3);
  await ready();
  check('a failed new plan remains in generation progress despite older successful originals', await activeStep() === 3 && await page.locator('.sg-run-summary').innerText().then(text => text.includes('0/1') && text.includes('1 项失败')));
  check('failed new plan keeps the previous original labeled as history', await page.locator('#studioGenesisRoot .sg-result img').first().getAttribute('src') === resultUrl && await page.locator('#studioGenesisRoot .sg-result').filter({ hasText: '历史版本' }).count() === 1);
  check('failure fixture does not create a new successful generation or archive', demo.metrics.fixtureGeneration === 3 && demo.metrics.localArchives === 3 && await page.evaluate(() => window.__NAVIGATION_INJECTED_FAILURES) === 1);
  report.submittedPayloads.push(...await page.evaluate(() => window.__NAVIGATION_CAPTURED_PAYLOADS));
  report.injectedFailureAttempts = await page.evaluate(() => window.__NAVIGATION_INJECTED_FAILURES);
  await screenshot('desktop-failed-new-plan-with-history');
  await changeMode('detail');
  check('switching types clears the previous type failure message', !(await page.locator('#studioGenesisRoot [data-message]').isVisible()));
  await step(2).click();
  await waitStep(2);
  await assertPlans('local draft retains independent detail plan after refresh', detailPlan);
  check('detail shows only its own two completed originals', await page.locator('#studioGenesisRoot .sg-result img').count() === 2 && await page.locator('#studioGenesisRoot .sg-result img').evaluateAll((images, mainUrl) => images.every(image => image.getAttribute('src') !== mainUrl), resultUrl));
  await geometry('desktop review has no horizontal overflow');

  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('mobile-detail-plan');
  await geometry('mobile review has no horizontal overflow');
  await action('back-input').click();
  await waitStep(0);
  await screenshot('mobile-detail-input');
  await geometry('mobile input has no horizontal overflow');
  await step(2).click();
  await waitStep(2);
  await assertPlans('mobile backward and forward navigation retains detail plan', detailPlan);

  check('no browser JavaScript errors', report.browserErrors.length === 0, report.browserErrors);
  check('no external provider request was made', report.externalRequests.length === 0 && demo.metrics.outboundProviderRequests === 0 && demo.metrics.blockedProxyRequests === 0, { externalRequests: report.externalRequests, outboundProviderRequests: demo.metrics.outboundProviderRequests, blockedProxyRequests: demo.metrics.blockedProxyRequests });
}

main().catch(async error => {
  report.failure = { message: error.message, stack: error.stack };
  if (page) {
    try { await screenshot('failure'); report.failure.visibleText = (await page.locator('#studioGenesisRoot').innerText()).slice(0, 12000); report.failure.activeStep = await activeStep(); report.failure.savedDrafts = await savedDraftSummary(); report.failure.engineEvents = await page.evaluate(() => window.__NAVIGATION_ENGINE_EVENTS); } catch (_) { /* report the original failure */ }
  }
  process.exitCode = 1;
}).finally(async () => {
  report.finishedAt = new Date().toISOString();
  const finalHashes = Object.fromEntries(sourceFiles.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
  const unchanged = JSON.stringify(finalHashes) === JSON.stringify(report.sourceHashes);
  report.checks.push({ name: 'tested source files remain unchanged throughout browser acceptance', passed: unchanged });
  if (!unchanged) report.finalSourceHashes = finalHashes;
  report.passed = !report.failure && report.checks.every(item => item.passed);
  report.metrics = demo?.metrics;
  if (report.failure) {
    fs.writeFileSync(path.join(output, 'debug.json'), `${JSON.stringify({ beforeExplicitReload: report.beforeExplicitReload, beforeReloadEngineEvents: report.beforeReloadEngineEvents, failure: report.failure }, null, 2)}\n`);
    report.failure = { message: report.failure.message, activeStep: report.failure.activeStep, debug: 'debug.json' };
  }
  if (report.beforeExplicitReload) report.durableDraftBeforeExplicitReload = report.beforeExplicitReload.map(record => ({ savedAt: record.savedAt, mode: record.settings?.mode, imageType: record.settings?.imageType, modules: record.settings?.modules, tasks: record.tasks?.map(task => ({ signature: task.signature, confirmed: task.confirmed, promptHashes: task.prompts?.map(hash), typeDrafts: Object.fromEntries(Object.entries(task.typeDrafts || {}).map(([type, saved]) => [type, { signature: saved.signature, confirmed: saved.confirmed, promptHashes: saved.prompts?.map(hash) }])) })) }));
  delete report.beforeExplicitReload;
  delete report.beforeReloadEngineEvents;
  if (report.submittedPayloads) report.submittedPayloads = report.submittedPayloads.map(({ prompt, ...payload }) => ({ ...payload, promptSha256: hash(prompt) }));
  if (report.passed) for (const file of ['failure.png', 'debug.json']) fs.rmSync(path.join(output, file), { force: true });
  fs.writeFileSync(path.join(output, 'acceptance.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (browser) await browser.close();
  if (demo) await new Promise(resolve => demo.server.close(resolve));
  process.stdout.write(`${JSON.stringify({ passed: report.passed, checks: report.checks.length, failure: report.failure?.message, output: path.join(output, 'acceptance.json') })}\n`);
});
