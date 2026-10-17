#!/usr/bin/env node
'use strict';

// Actual public HTML/CSS/JS in isolated Chrome storage. Pricing, analysis and
// generation use explicit local fixtures. External browser requests are denied.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('/Users/shaozhuang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const workspace = path.resolve(__dirname, '..');
const repository = process.env.STUDIO_CREDITS_ROOT ? path.resolve(process.env.STUDIO_CREDITS_ROOT) : workspace;
const { createDemoServer } = require(path.join(repository, 'scripts/studio-main-demo.cjs'));
const output = path.resolve(workspace, process.env.STUDIO_CREDITS_OUTPUT || 'docs/uat-api-credit-hints-20261010/browser');
const port = Number(process.env.STUDIO_CREDITS_PORT || 18839);
const sourceFiles = ['public/creative/credit-display.js', 'public/creative/labs/image-prompt-lab/promptlab.html', 'public/creative/labs/image-prompt-lab/promptlab.js', 'public/creative/labs/image-prompt-lab/creative-credit-hints.js', 'public/creative/labs/image-prompt-lab/creative-credit-hints.css', 'public/creative/labs/image-prompt-lab/studio-genesis-ui.js', 'public/creative/labs/image-prompt-lab/studio-genesis.css', 'public/creative/labs/image-prompt-lab/creative-tools-ui.js', 'public/creative/labs/image-prompt-lab/scene-extension-ui.js', 'public/creative/labs/ecommerce-video-studio/video-studio.html', 'public/creative/labs/ecommerce-video-studio/video-studio.js', 'scripts/verify-studio-api-credit-hints.cjs'];
if (process.env.STUDIO_CREDITS_EXTRA_SOURCE_FILES) sourceFiles.push(...JSON.parse(process.env.STUDIO_CREDITS_EXTRA_SOURCE_FILES));
const pricingFixture = { centsPerPoint: 10, plan: { code: 'local-browser-acceptance', name: '浏览器积分展示验收', multiplierBps: 11000, ruleVersion: 1 }, observedAt: '2026-10-10T00:00:00.000Z', models: [
  { id: 'demo-image-fixture', kind: 'image', pricingStatus: 'priced', imageCents: 37 },
  { id: 'demo-image-alternate', kind: 'image', pricingStatus: 'priced', imageCents: 23 },
  { id: 'demo-analysis-fixture', kind: 'chat', pricingStatus: 'priced', promptPointsPer1K: 0.2, completionPointsPer1K: 0.6 }
] };
const report = { startedAt: new Date().toISOString(), sourceRoot: repository, scope: 'Actual local public studio UI; display channel and public pricing DTO simulated; explicit local analysis/generation fixtures; no provider or paid calls; no deployment', pricingFixture, checks: [], screenshots: [], browserErrors: [], externalRequests: [] };
let demo, browser, context, page;
fs.mkdirSync(output, { recursive: true });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function check(name, passed, detail) {
  const item = { name, passed: Boolean(passed) };
  if (detail !== undefined) item.detail = detail;
  report.checks.push(item);
  if (!passed) throw new Error(`${name}: ${JSON.stringify(detail)}`);
}
const studioAction = name => page.locator(`#studioGenesisRoot [data-action="${name}"]`).first();
async function screenshot(name) {
  const file = `${name}.png`;
  await page.screenshot({ path: path.join(output, file), fullPage: true });
  report.screenshots.push(file);
}
async function actionScreenshot(name) {
  const file = `${name}.png`;
  await page.locator('.composer-actions').screenshot({ path: path.join(output, file) });
  report.screenshots.push(file);
}
async function hints(selector) {
  return page.locator(selector).first().evaluate(button => {
    const wrapper = button.closest('[data-sz-credit-wrap]');
    return { wrapped: Boolean(wrapper), text: wrapper?.querySelector('[data-sz-credit]')?.textContent || '', title: wrapper?.querySelector('[data-sz-credit]')?.title || '' };
  });
}
async function expectedQuote(name, selector, expected) {
  await page.waitForFunction(({ selector, expected }) => document.querySelector(selector)?.closest('[data-sz-credit-wrap]')?.querySelector('[data-sz-credit]')?.textContent.includes(expected), { selector, expected });
  const value = await hints(selector);
  check(name, value.text.includes(expected), value);
}
async function noCaption(name, selectors, allowAbsent = false) {
  const result = await page.locator(selectors).evaluateAll(buttons => buttons.map(button => ({ id: button.id, action: button.dataset.action, wrapped: Boolean(button.closest('[data-sz-credit-wrap]')) })));
  check(name, (allowAbsent || result.length > 0) && result.every(button => !button.wrapped), result);
}
async function noZeroNoise(name) {
  const texts = await page.locator('[data-sz-credit]:visible').allTextContents();
  check(name, texts.every(value => !/(?:^|[^\d.])0\s*积分|本站扣|按请求计费|本次 0 张/.test(value)), texts);
}
async function geometry(name, rootSelector) {
  const detail = await page.evaluate(selector => {
    const root = document.querySelector(selector), viewport = innerWidth;
    const overflow = [...root.querySelectorAll('*')].filter(element => {
      if (!element.getClientRects().length) return false;
      const box = element.getBoundingClientRect(); return box.left < -1 || box.right > viewport + 1;
    }).slice(0, 8).map(element => ({ tag: element.tagName, class: element.className, right: Math.round(element.getBoundingClientRect().right) }));
    return { viewport, documentWidth: document.documentElement.scrollWidth, overflow };
  }, rootSelector);
  check(name, detail.documentWidth <= detail.viewport + 1 && detail.overflow.length === 0, detail);
}
async function refreshDisplay(channel = 'platform_wallet') {
  await page.evaluate(({ channel, pricing }) => {
    window.SZCreativeCreditChannel = () => channel;
    window.SZCreativeCredits.update(pricing);
    window.SZCreativeCreditHints.refresh();
  }, { channel, pricing: pricingFixture });
  await page.waitForTimeout(75);
}
async function waitStudio() {
  await page.waitForFunction(() => document.querySelectorAll('#studioGenesisRoot [data-action="mode"]').length === 3 && [...document.querySelectorAll('#studioGenesisRoot [data-action="mode"]')].every(button => !button.disabled));
  await refreshDisplay();
}
async function waitReview() {
  if (!(await page.locator('#studioGenesisRoot [data-confirm]').count()) && await page.locator('#studioGenesisRoot [data-action="toggle-plan"]').count()) await studioAction('toggle-plan').click();
  await page.waitForFunction(() => Boolean(document.querySelector('#studioGenesisRoot [data-confirm]')));
  await page.waitForTimeout(75);
}
async function makePlan(count) {
  await page.locator('[data-setting="count"]').selectOption(String(count));
  await studioAction('plan').click();
  await waitReview();
  await page.locator('#studioGenesisRoot [data-confirm]').check();
}
async function openSurface(query, ready) {
  await page.goto(`${demo.origin}/creative/labs/image-prompt-lab/promptlab.html?source=web&demo=1&${query}`);
  await page.waitForFunction(ready);
  await refreshDisplay();
}

async function main() {
  report.sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, hash(fs.readFileSync(path.join(repository, file)))]));
  demo = createDemoServer({ port });
  await new Promise((resolve, reject) => { demo.server.once('error', reject); demo.server.listen(port, '127.0.0.1', resolve); });
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addInitScript(() => { window.__SZ_VIDEO_STUDIO_EXPOSE_TESTING__ = true; });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === demo.origin && url.pathname === '/api/creative/credits') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: pricingFixture }) });
    if (url.origin === demo.origin && url.pathname === '/api/creative/native-video' && route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true, limits: { bodyBytes: 25165824 }, models: ['seedance-2.0-mini', 'seedance-2.0-fast', 'seedance-2.0', 'seedance-2.5'].map(id => ({ id, durations: [5, 10, 15], resolutions: ['720p', '1080p'], ratios: ['9:16', '16:9', '1:1'], generateAudio: false, reservationCents: 50000 })) }) });
    if (url.origin === demo.origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    report.externalRequests.push({ url: route.request().url(), method: route.request().method() });
    return route.abort();
  });
  page = await context.newPage();
  page.on('pageerror', error => report.browserErrors.push(error.message));
  page.setDefaultTimeout(12000);
  await page.goto(`${demo.origin}/creative/labs/image-prompt-lab/promptlab.html?source=web&studio=1&mode=main&demo=1`);
  await waitStudio();
  await noCaption('main navigation, settings, local plan and configuration have no credit decoration', '#studioGenesisRoot [data-action="mode"], #studioGenesisRoot [data-action="navigate-step"], #studioGenesisRoot [data-action="plan"], #studioGenesisRoot [data-action="config"], #studioGenesisRoot [data-action="module-mode"]');
  await noCaption('main generation with no planned requests has no caption', '#studioGenesisRoot [data-action="generate"]', true);
  await expectedQuote('product analysis shows current public token point rates', '#studioGenesisRoot [data-action="analyze"]', '输入 0.2 / 输出 0.6 积分/千 Token');
  await expectedQuote('AI brief helper shows public token point rates', '#studioGenesisRoot [data-action="write-brief"]', '输入 0.2 / 输出 0.6 积分/千 Token');
  check('AI brief helper request caption is visible', await page.locator('#studioGenesisRoot [data-action="write-brief"]').locator('xpath=..').locator('[data-sz-credit]').isVisible());
  await noZeroNoise('main initial page has no zero-credit or local-operation caption noise');
  await screenshot('desktop-main-input');
  await geometry('desktop AI brief helper point caption stays inside viewport', '#studioGenesisRoot');
  await page.locator('#studioGenesisRoot [data-files]').setInputFiles(demo.productPath);
  await page.locator('#studioGenesisRoot .sg-asset').waitFor();
  await page.locator('#sgBrief').fill('积分展示验收：保留商品款式，突出产品主体。');
  await page.locator('#sgBrief').press('Tab');
  await makePlan(3);
  await expectedQuote('main three separate image requests quote per-request rounded credits', '#studioGenesisRoot [data-action="generate"]', '本次预计 12.3 积分');
  await noCaption('review back and step controls retain original layout', '#studioGenesisRoot [data-action="back-input"], #studioGenesisRoot [data-action="navigate-step"]');
  check('local plan did not call analysis or generation fixture', demo.metrics.fixtureAnalysis === 0 && demo.metrics.fixtureGeneration === 0, { analysis: demo.metrics.fixtureAnalysis, generation: demo.metrics.fixtureGeneration });
  await noZeroNoise('review captions have no zero-cost noise');
  await screenshot('desktop-main-three-image-quote');
  await geometry('desktop main review stays inside viewport', '#studioGenesisRoot');

  await studioAction('back-input').click();
  await page.locator('[data-setting="count"]').selectOption('2');
  // A second harmless model option exercises the real model-setting handler.
  await page.locator('[data-setting="model"]').evaluate(select => select.add(new Option('本地备用模型（验收）', 'demo-image-alternate')));
  await page.locator('[data-setting="model"]').selectOption('demo-image-alternate');
  await studioAction('plan').click();
  await waitReview();
  await page.locator('#studioGenesisRoot [data-confirm]').check();
  await expectedQuote('changing model and quantity recalculates the actual plan quote', '#studioGenesisRoot [data-action="generate"]', '本次预计 5.2 积分');
  await refreshDisplay('external_key');
  await expectedQuote('own API submission has clear billing label', '#studioGenesisRoot [data-action="generate"]', '自有 API 计费');
  check('own API label does not show platform zero-credit or estimated debit', (await hints('#studioGenesisRoot [data-action="generate"]')).text === '自有 API 计费；本次 2 张待生成图片');
  await screenshot('desktop-own-api');
  await refreshDisplay();

  await page.evaluate(() => {
    const bridge = window.SZ_CREATIVE_TOOLS_BRIDGE, send = bridge.send.bind(bridge);
    window.__CREDIT_ACCEPTANCE_FAILURES = 0;
    bridge.send = async (type, message) => {
      if (type === 'GENERATE_IMAGE' && !window.__CREDIT_ACCEPTANCE_FAILURES) {
        window.__CREDIT_ACCEPTANCE_FAILURES++;
        return { ok: false, definitiveFailure: true, error: 'LOCAL_CREDIT_ACCEPTANCE_FAILURE：预设失败，仅用于失败项报价验收。' };
      }
      return send(type, message);
    };
  });
  await studioAction('generate').click();
  await page.waitForFunction(() => document.querySelector('#studioGenesisRoot [data-action="retry"]') && !document.querySelector('#studioGenesisRoot [data-action="retry"]').disabled);
  await expectedQuote('only the single failed image is quoted for retry', '#studioGenesisRoot [data-action="retry"]', '本次预计 2.6 积分');
  check('one successful image retained beside one failed fixture', await page.locator('#studioGenesisRoot .sg-result img').count() === 1 && demo.metrics.fixtureGeneration === 1, { images: await page.locator('#studioGenesisRoot .sg-result img').count(), fixtureGeneration: demo.metrics.fixtureGeneration });
  await noCaption('generation with no queued or ready requests loses its cost wrapper', '#studioGenesisRoot [data-action="generate"]');
  await screenshot('desktop-failed-only-retry');
  await studioAction('retry').click();
  await page.waitForFunction(() => document.querySelectorAll('#studioGenesisRoot .sg-result img').length === 2 && !document.querySelector('#studioGenesisRoot [data-action="generate"]').textContent.includes('正在'));
  await noCaption('completed generation has no zero-image caption', '#studioGenesisRoot [data-action="generate"], #studioGenesisRoot [data-action="download-all"]');
  check('retry submits exactly one additional fixture image', demo.metrics.fixtureGeneration === 2, demo.metrics.fixtureGeneration);
  report.injectedDefinitiveFailures = await page.evaluate(() => window.__CREDIT_ACCEPTANCE_FAILURES);
  check('exactly one definitive local failure was injected', report.injectedDefinitiveFailures === 1, report.injectedDefinitiveFailures);

  await page.locator('#studioGenesisRoot [data-action="mode"][data-mode="detail"]').click();
  await waitStudio();
  await noCaption('detail navigation/local controls remain clean', '#studioGenesisRoot [data-action="navigate-step"], #studioGenesisRoot [data-action="module-mode"], #studioGenesisRoot [data-action="plan"]');
  await page.locator('[data-setting="model"]').selectOption('demo-image-fixture');
  await makePlan(2);
  await expectedQuote('two detail screens quote two remaining image requests', '#studioGenesisRoot [data-action="generate"]', '本次预计 8.2 积分');
  await screenshot('desktop-detail-two-screen-quote');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('mobile-detail-two-screen-quote');
  await geometry('mobile detail review stays inside viewport', '#studioGenesisRoot');
  await studioAction('back-input').click();
  await screenshot('mobile-detail-input');
  await geometry('mobile detail input stays inside viewport', '#studioGenesisRoot');
  check('mobile AI brief helper request caption is visible', await page.locator('#studioGenesisRoot [data-action="write-brief"]').locator('xpath=..').locator('[data-sz-credit]').isVisible());
  await noZeroNoise('mobile detail input has no zero-credit captions');
  await page.setViewportSize({ width: 1440, height: 1100 });

  await openSurface('mode=creative&tool=refinement', () => Boolean(window.SZ_CREATIVE_TOOLS_UI));
  await noCaption('refinement tabs, local plan, clearing and downloads have no captions', '#creativeToolsRoot [data-action="switch-tool"], #creativeToolsRoot [data-action="build-plan"], #creativeToolsRoot [data-action="clear-products"], #creativeToolsRoot [data-action="download-all"]');
  await expectedQuote('refinement AI analysis shows point rates', '#creativeToolsRoot [data-action="analyze"]', '输入 0.2 / 输出 0.6 积分/千 Token');
  await page.locator('#creativeToolsRoot input[type="file"]').first().setInputFiles(demo.productPath);
  await page.locator('#ctProductGrid .ct-asset').waitFor();
  await page.locator('#creativeToolsRoot [data-action="build-plan"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#ctPlanGrid [data-shot]').length === 1);
  await expectedQuote('refinement confirmed local plan quotes one output request', '#ctGenerateBtn', '本次预计 4.1 积分');
  await noZeroNoise('refinement visible captions contain no zero-credit noise');
  await screenshot('desktop-refinement-quote');

  await openSurface('mode=viral&layout=1&workflow=1&creativeRoute=scene-extension', () => Boolean(window.SZ_SCENE_EXTENSION_CONTROLLER) && document.body.classList.contains('scene-extension-route'));
  await noCaption('scene navigation, local plan and clearing retain original layout', '#scenePlanBtn, #sceneFrontClear, #sceneDetailClear, #viralSceneModeBtn');
  await page.locator('#sceneFrontFile').setInputFiles(demo.productPath);
  await page.locator('#sceneFrontPreview img').waitFor();
  await page.locator('#sceneMaterialName').fill('本地验收手提袋');
  await page.locator('#sceneCount').fill('4');
  await page.locator('#sceneCount').press('Tab');
  await page.locator('#sceneSameMaterial').check();
  await page.locator('#scenePlanBtn').click();
  await page.waitForFunction(() => document.querySelectorAll('#scenePlanGrid .scene-plan-card').length === 4);
  await expectedQuote('scene plan quotes exactly four outputs', '#sceneGenerateBtn', '本次预计 16.4 积分');
  await noZeroNoise('scene visible captions contain no zero-credit noise');
  await screenshot('desktop-scene-four-output-quote');

  await page.goto(`${demo.origin}/creative/labs/ecommerce-video-studio/video-studio.html`);
  await page.waitForFunction(() => window.SZEcommerceVideoStudioTesting?.state.booted && window.SZEcommerceVideoStudioTesting.state.backendConnected);
  // Feed a public capability shape through the actual capability-refresh handler.
  // This exercises the shipped normalizer without submitting a video.
  await page.evaluate(() => {
    const original = window.chrome.runtime.sendMessage.bind(window.chrome.runtime);
    window.chrome.runtime.sendMessage = (message, callback) => {
      if (message?.type === 'VIDEO_STUDIO_CAPABILITIES') return callback({ ok: true, accountKey: window.SZEcommerceVideoStudioTesting.state.accountKey, credentialAvailable: true, analysisAvailable: true, provider: 'shaozhuang-native', models: ['seedance-2.0-mini', 'seedance-2.0-fast', 'seedance-2.0', 'seedance-2.5'].map(productKey => ({ productKey, providerModel: productKey, configured: true, nativePlatform: true, reservationCents: 50000, limits: { durations: [5, 10, 15], resolutions: ['720p', '1080p'], ratios: ['9:16', '16:9', '1:1'], generateAudio: false } })) });
      return original(message, callback);
    };
  });
  await page.locator('#refresh-capabilities').click();
  await page.waitForFunction(() => window.SZEcommerceVideoStudioTesting.state.modelCatalog.some(model => model.nativePlatform && model.reservationCents === 50000));
  check('video actual HTML loaded shared credit module and normalized native fixture', await page.evaluate(() => Boolean(window.SZCreativeCredits) && window.SZEcommerceVideoStudioTesting.state.modelCatalog.some(model => model.nativePlatform && model.reservationCents === 50000)));
  await noCaption('local video composition and confirmation have no credit wrapper', '#primary-action, #confirm-review');
  await noCaption('video navigation, reset, result and configuration remain clean', '#tab-direct, #tab-assist, #tab-remix, #reset-draft, #open-api-settings, #refresh-capabilities, #view-result');
  await screenshot('desktop-video-local-composition');
  // The shipped testing interface exposes only local state; no video is submitted.
  await page.evaluate(() => {
    const test = window.SZEcommerceVideoStudioTesting;
    test.state.legacySingle = true;
    test.state.mode = 'direct';
    Object.assign(test.state.settings, { resolution: '720p', ratio: '9:16', durationSeconds: 5, audioMode: 'silent' });
  });
  await page.locator('#refresh-capabilities').click();
  await expectedQuote('direct native video submit quotes exact reservation points', '#primary-action', '提交预占 5000 积分');
  check('native video reservation is described as a hold, not final cost', (await hints('#primary-action')).title.includes('预占不代表最终费用'));
  await screenshot('desktop-video-native-reservation');
  await actionScreenshot('desktop-video-native-submit-caption');
  await geometry('desktop native video submit captions stay inside viewport', 'main');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('mobile-video-native-reservation');
  await actionScreenshot('mobile-video-native-submit-caption');
  await geometry('mobile native video submit captions stay inside viewport', 'main');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => {
    const test = window.SZEcommerceVideoStudioTesting;
    test.state.mode = 'assist';
    test.state.review.state = 'editing';
    test.renderReadiness();
  });
  await noCaption('video button that navigates to edited script review has no charge caption', '#primary-action');
  await expectedQuote('video confirm and submit still quotes native reservation', '#confirm-review', '提交预占 5000 积分');
  await noZeroNoise('video submit and review contain no zero-credit captions');

  check('no browser JavaScript error occurred', report.browserErrors.length === 0, report.browserErrors);
  check('no external or provider request was attempted', report.externalRequests.length === 0 && demo.metrics.outboundProviderRequests === 0 && demo.metrics.blockedProxyRequests === 0, { externalRequests: report.externalRequests, outboundProviderRequests: demo.metrics.outboundProviderRequests, blockedProxyRequests: demo.metrics.blockedProxyRequests });
  check('only two successful local generation fixtures and one injected failure ran', demo.metrics.fixtureGeneration === 2 && report.injectedDefinitiveFailures === 1, { fixtureAnalysis: demo.metrics.fixtureAnalysis, fixtureGeneration: demo.metrics.fixtureGeneration, injectedDefinitiveFailures: report.injectedDefinitiveFailures, paidCalls: 0 });
}

main().catch(async error => {
  report.failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
  if (page) try { await screenshot('failure'); report.failure.visibleText = (await page.locator('body').innerText()).slice(0, 14000); } catch (_) {}
}).finally(async () => {
  report.finishedAt = new Date().toISOString();
  const finalHashes = Object.fromEntries(sourceFiles.map(file => [file, hash(fs.readFileSync(path.join(repository, file)))]));
  const unchanged = JSON.stringify(finalHashes) === JSON.stringify(report.sourceHashes);
  report.checks.push({ name: 'tested source files remain unchanged throughout browser acceptance', passed: unchanged });
  if (!unchanged) report.finalSourceHashes = finalHashes;
  report.metrics = demo?.metrics;
  report.passed = !report.failure && report.checks.every(item => item.passed);
  if (report.passed) fs.rmSync(path.join(output, 'failure.png'), { force: true });
  fs.writeFileSync(path.join(output, 'acceptance.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (browser) await browser.close();
  if (demo) await new Promise(resolve => demo.server.close(resolve));
  process.stdout.write(`${JSON.stringify({ passed: report.passed, checks: report.checks.length, failure: report.failure?.message, output: path.join(output, 'acceptance.json') })}\n`);
});
