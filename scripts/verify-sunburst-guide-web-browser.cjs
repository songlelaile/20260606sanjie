'use strict';

// Synthetic browser verification only: isolated temporary profile, no credentials,
// no provider calls, and the candidate's actual HTML/CSS/JavaScript assets.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

const candidate = path.resolve(__dirname, '..');
const source = path.join(candidate, 'public');
const evidence = path.join(candidate, 'docs/uat-sunburst-guide-20261009/browser');
fs.mkdirSync(evidence, { recursive: true });

async function main() {
  const report = { startedAt: new Date().toISOString(), passed: false, syntheticOnly: true, checks: {}, pageErrors: [], externalRequests: [] };
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/__guide-fixture') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><html><body style="margin:0"><iframe title="创作工作台" style="border:0;width:100vw;height:100vh" src="/creative/labs/image-prompt-lab/promptlab.html?source=web"></iframe></body></html>'); return; }
    if (pathname === '/api/auth/me') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: { id: 'synthetic-browser', tenantId: 'fixture', username: 'fixture', creativeEntitlement: { allowed: true } } })); return; }
    const filename = path.resolve(source, '.' + pathname);
    if (!filename.startsWith(source + path.sep)) { response.writeHead(403).end(); return; }
    fs.readFile(filename, (error, data) => {
      if (error) { response.writeHead(404).end(); return; }
      const type = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' }[path.extname(filename)] || 'application/octet-stream';
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sz-r55-guide-browser-'));
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, userDataDir: profile });
    report.browserVersion = await browser.version();
    report.browserExecutable = browser.process().spawnfile;
    report.isolatedTemporaryProfile = true;
    const outerPage = await browser.newPage();
    let page = outerPage;
    await page.setViewport({ width: 1440, height: 1180, deviceScaleFactor: 1 });
    page.on('pageerror', error => report.pageErrors.push(String(error.message || error)));
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.url().startsWith(origin + '/') || /^(?:data|blob):/.test(request.url())) return request.continue();
      report.externalRequests.push(request.url());
      return request.abort('blockedbyclient');
    });
    await page.evaluateOnNewDocument(() => {
      globalThis.__SZ_PROMPTLAB_TEST_MODE__ = true;
      globalThis.__SZ_PROMPTLAB_CANVAS_TEST_MODE__ = true;
      globalThis.__SZ_PROMPTLAB_BACKGROUND_TEST_MODE__ = true;
      // Skip unrelated app startup/storage; explicitly bind the actual guide UI.
      const add = document.addEventListener.bind(document);
      document.addEventListener = (type, listener, options) => {
        if (type !== 'DOMContentLoaded') return add(type, listener, options);
      };
    });
    await outerPage.goto(origin + '/__guide-fixture', { waitUntil: 'load' });
    page = await (await outerPage.$('iframe')).contentFrame();
    report.iframeUrl = page.url();
    report.actualWebsiteCompatibilityLayer = true;
    await page.waitForFunction(() => !!globalThis.__SZ_PROMPTLAB_TEST_API__ && !!globalThis.SZ_GUIDE_MODEL_PROFILE);

    report.checks.initial = await page.evaluate(async () => {
      const api = globalThis.__SZ_PROMPTLAB_TEST_API__;
      const calls = [];
      globalThis.__guideBrowserCalls = calls;
      api.state.archiveAccountKey = 'browser-fixture';
      const configs = {
        'openai': { provider: 'openai', imageAdapter: 'openai-images', imageModel: 'gpt-image-2.5-sunburst', imageEndpoint: 'https://fixture.invalid/v1/images/generations' },
        'openai-compatible': { provider: 'openai-compatible', imageAdapter: 'openai-images', imageModel: 'gpt-image-2', imageEndpoint: 'https://fixture.invalid/v1/images/generations' },
        'doubao': { provider: 'doubao', imageAdapter: 'generic-json', imageModel: 'Image-2.5-sunburst', imageEndpoint: 'https://fixture.invalid/images' }
      };
      api.setTestSend(async (type, payload) => {
        calls.push({ type, url: payload && payload.url || '' });
        if (type === 'GET_CONFIG_CATALOG') return { ok: true, accountKey: 'browser-fixture', providers: Object.values(configs).map(c => ({ ...c, id: c.provider, label: c.imageModel, capabilities: { image: true, referenceImage: true } })) };
        if (type === 'SET_ACTIVE_PROVIDER') return { ok: true, accountKey: 'browser-fixture', provider: payload.provider, config: configs[payload.provider] };
        return { ok: false, error: 'Synthetic browser fixture: image is unreadable' };
      });
      function png(width, height, draw) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        draw(canvas.getContext('2d'), width, height);
        return canvas.toDataURL('image/png');
      }
      const base = png(1024, 1024, (ctx, w, h) => {
        ctx.fillStyle = '#eee7db'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#17365d'; ctx.fillRect(80, 56, 864, 170);
        ctx.fillStyle = '#ffffff'; ctx.font = 'bold 45px sans-serif';
        ctx.fillText('LOCKED ORIGINAL COPY', 125, 150);
        ctx.fillStyle = '#b91c1c'; ctx.fillRect(365, 350, 294, 350);
        ctx.fillStyle = '#fef3c7'; ctx.fillRect(403, 398, 218, 95);
        ctx.fillStyle = '#17365d'; ctx.font = 'bold 28px sans-serif'; ctx.fillText('KEEP LABEL', 420, 458);
        ctx.fillStyle = '#15803d'; ctx.fillRect(86, 836, 852, 84);
      });
      const candidateImage = png(1024, 1024, (ctx, w, h) => {
        ctx.fillStyle = '#0ea5e9'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#fde047'; ctx.fillRect(0, 0, w, 260);
        ctx.fillStyle = '#111827'; ctx.font = 'bold 46px sans-serif'; ctx.fillText('UNWANTED CHANGE', 140, 150);
        ctx.fillStyle = '#1d4ed8'; ctx.fillRect(365, 350, 294, 350);
      });
      const mask = png(1024, 1024, ctx => {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1024, 1024);
        ctx.clearRect(365, 500, 294, 200);
      });
      const mismatch = png(1024, 768, ctx => { ctx.fillStyle = '#e11d48'; ctx.fillRect(0, 0, 1024, 768); });
      const badMask = png(768, 768, ctx => { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 768, 768); });
      globalThis.__guideBrowserFixtures = { base, candidateImage, mask, mismatch, badMask };
      const set = (id, value) => { const element = document.getElementById(id); if (element) element.value = value; };
      set('provider', 'openai');
      set('imageAdapter', 'openai-images');
      set('imageModel', 'gpt-image-2.5-sunburst');
      set('imageEndpoint', 'https://api.openai.com/v1/images/generations');
      globalThis.bindGuideRegenerationUi();
      globalThis.openGuideRegenerateModal({ url: base, resultId: 'synthetic-r43', productImages: [base], labMode: 'main', ratio: '1:1', resolution: '1K', prompt: 'Synthetic result' }, { prompt: '只修复红色标注区域的颜色，保留标题、包装文字和背景。' });
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const poll = () => api.state.guideAnnotation.ready ? resolve() : Date.now() >= deadline ? reject(new Error('Synthetic base did not load')) : setTimeout(poll, 20);
        poll();
      });
      document.querySelector('[data-guide-issue="replace"]').click();
      const markup = document.getElementById('guideMarkupCanvas');
      const rect = markup.getBoundingClientRect();
      const mark = (type, y, buttons) => markup.dispatchEvent(new PointerEvent(type, {
        bubbles: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons,
        clientX: rect.left + rect.width * .5, clientY: rect.top + rect.height * y
      }));
      mark('pointerdown', .56, 1);
      mark('pointermove', .63, 1);
      mark('pointerup', .63, 0);
      const contract = api.collectGuideContract();
      globalThis.__guideBrowserContract = contract;
      return { contract: api.publicGuideContract(contract), modelProfile: contract.modelProfile, prompt: api.modelAdaptiveGuidePrompt(contract), valid: contract.valid, errors: contract.errors, summary: document.getElementById('guidePlanSummary').innerText, canvasWidth: document.getElementById('guideMarkupCanvas').width, canvasHeight: document.getElementById('guideMarkupCanvas').height, ready: api.state.guideAnnotation.ready };
    });
    assert.equal(report.checks.initial.ready, true);
    assert.equal(report.checks.initial.valid, true, report.checks.initial.errors.join('; '));
    assert.equal(report.checks.initial.modelProfile.family, 'gpt-image-2.5-sunburst');
    assert.equal(report.checks.initial.modelProfile.capability, 'mask-guided');
    assert.match(report.checks.initial.summary, /gpt-image-2\.5-sunburst/);
    assert.match(report.checks.initial.summary, /Sunburst 编辑优先/);
    assert.match(report.checks.initial.summary, /方案：Sunburst 精准编辑/);
    assert.doesNotMatch(report.checks.initial.prompt, /STRUCTURED GUIDE|Execution path:/);
    await outerPage.screenshot({ path: path.join(evidence, 'sunburst-guide-plan.png'), fullPage: false });
    await page.$eval('#guidePlanSummary', element => element.scrollIntoView({ block: 'center' }));
    await outerPage.screenshot({ path: path.join(evidence, 'sunburst-guide-plan-summary.png'), fullPage: false });

    report.checks.canvas = await page.evaluate(async () => {
      const api = globalThis.__SZ_PROMPTLAB_TEST_API__;
      const f = globalThis.__guideBrowserFixtures;
      const contract = globalThis.__guideBrowserContract;
      async function pixels(url) {
        const image = await new Promise((resolve, reject) => {
          const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        return { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
      }
      const [url] = await api.postProcessGuideImageUrls([f.candidateImage], contract, f.base, f.mask);
      globalThis.__guideBrowserComposed = url;
      const [base, generated, mask, output] = await Promise.all([f.base, f.candidateImage, f.mask, url].map(pixels));
      let outsidePixels = 0, outsideChangedBytes = 0, insidePixels = 0, insideWrongBytes = 0;
      for (let offset = 0; offset < base.data.length; offset += 4) {
        if (mask.data[offset + 3] === 255) {
          outsidePixels++;
          for (let ch = 0; ch < 4; ch++) if (base.data[offset + ch] !== output.data[offset + ch]) outsideChangedBytes++;
        } else if (mask.data[offset + 3] === 0) {
          insidePixels++;
          for (let ch = 0; ch < 4; ch++) if (generated.data[offset + ch] !== output.data[offset + ch]) insideWrongBytes++;
        }
      }
      async function rejected(url, editBase = f.base, editMask = f.mask) {
        try { await api.postProcessGuideImageUrls([url], contract, editBase, editMask); return { blocked: false }; }
        catch (error) { return { blocked: true, message: error.message }; }
      }
      return {
        outsidePixels, outsideChangedBytes, insidePixels, insideWrongBytes,
        outputWidth: output.width, outputHeight: output.height,
        ratioFailure: await rejected(f.mismatch),
        maskFailure: await rejected(f.candidateImage, f.base, f.badMask),
        decodeFailure: await rejected('data:image/png;base64,not-valid-png'),
        readFailure: await rejected('https://fixture.invalid/unreadable.png'),
        missingMaskFailure: await rejected(f.candidateImage, f.base, '')
      };
    });
    const canvas = report.checks.canvas;
    assert.equal(canvas.outsideChangedBytes, 0);
    assert.equal(canvas.insideWrongBytes, 0);
    assert(canvas.outsidePixels > 900000 && canvas.insidePixels > 50000);
    assert.equal(canvas.outputWidth, 1024); assert.equal(canvas.outputHeight, 1024);
    for (const name of ['ratioFailure', 'maskFailure', 'decodeFailure', 'readFailure', 'missingMaskFailure']) assert.equal(canvas[name].blocked, true, name);
    assert.match(canvas.ratioFailure.message, /比例与原图不一致/);
    assert.match(canvas.maskFailure.message, /遮罩尺寸与原图不一致/);

    report.checks.aliasUi = await page.evaluate(() => {
      const api = globalThis.__SZ_PROMPTLAB_TEST_API__;
      api.state.guideDraft.config = Object.freeze({ provider: 'openai-compatible', imageAdapter: 'generic-json', imageModel: 'Image-2.5-sunburst' });
      globalThis.renderGuidePlanSummary();
      const contract = api.collectGuideContract();
      return { modelProfile: contract.modelProfile, valid: contract.valid, summary: document.getElementById('guidePlanSummary').innerText };
    });
    assert.equal(report.checks.aliasUi.modelProfile.model, 'Image-2.5-sunburst');
    assert.equal(report.checks.aliasUi.modelProfile.capability, 'client-composited-mask');
    assert.match(report.checks.aliasUi.summary, /服务端遮罩不可确认/);
    await page.$eval('#guidePlanSummary', element => element.scrollIntoView({ block: 'center' }));
    await outerPage.screenshot({ path: path.join(evidence, 'sunburst-gateway-plan.png'), fullPage: false });

    report.checks.image2Switch = await page.evaluate(async () => {
      const api = globalThis.__SZ_PROMPTLAB_TEST_API__;
      globalThis.closeGuideRegenerateModal();
      const model = document.getElementById('imageModel'); model.value = 'gpt-image-2';
      globalThis.openGuideRegenerateModal({ url: globalThis.__guideBrowserFixtures.base, resultId: 'synthetic-image2', labMode: 'main', ratio: '1:1', resolution: '1K', productImages: [globalThis.__guideBrowserFixtures.base] }, { prompt: '只修复选定颜色' });
      const deadline = Date.now() + 5000;
      while (!api.state.guideAnnotation.ready && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      const contract = api.collectGuideContract();
      return { model: contract.modelProfile.model, strategy: contract.modelProfile.strategy, summary: document.getElementById('guidePlanSummary').innerText, ready: api.state.guideAnnotation.ready };
    });
    assert.equal(report.checks.image2Switch.model, 'gpt-image-2');
    assert.equal(report.checks.image2Switch.strategy, 'image2-structured-edit-v1');
    assert.match(report.checks.image2Switch.summary, /Image-2 结构化修复/);
    await outerPage.screenshot({ path: path.join(evidence, 'image2-guide-plan.png'), fullPage: false });

    report.checks.generationDispatch = await page.evaluate(async () => {
      const api = globalThis.__SZ_PROMPTLAB_TEST_API__;
      const calls = [];
      api.setTestSend(async (type, request) => {
        if (type === 'GENERATE_IMAGE') calls.push({ type, model: request.config.imageModel, prompt: request.payload.prompt, negativePrompt: request.payload.negativePrompt, sourceResultId: request.payload.sourceResultId, contractParent: request.payload.guideContract.parentResultId, strategy: request.payload.guideContract.modelProfile.strategy, count: request.payload.count, hasBase: !!request.payload.editBaseImage, productCount: request.payload.productImages.length });
        return { ok: false, error: 'Synthetic fixture: intercepted before paid provider' };
      });
      for (const model of ['gpt-image-2', 'gpt-image-2.5-sunburst']) {
        for (const labMode of ['main', 'detail']) {
          document.getElementById('imageModel').value = model;
          const item = { url: globalThis.__guideBrowserFixtures.base, resultId: 'browser-current-result', labMode, detailMode: labMode === 'detail' ? 'link' : 'main', ratio: '1:1', resolution: '1K', productImages: [globalThis.__guideBrowserFixtures.base], prompt: 'OLD FULL IMAGE PROMPT', negativePrompt: 'OLD NEGATIVE', promptRecord: { id: 'old', source: 'reference', prompt: 'OLD FULL IMAGE PROMPT', data: { '主图规划': [{ '主标题': 'OLD AD COPY' }], '屏幕规划': [{ '主标题': 'OLD SCREEN COPY' }] } } };
          const draft = api.guideDraftForItem(item);
          const contract = api.createStructuredGuideContract({ config: draft.config, scope: 'current', mode: 'general', guide: '只替换圈选文字', issues: ['copy-remove-local'], textTarget: '旧文案', replacementText: '新文案', annotation: { mustStrokeCount: 1, editMaskDataUrl: globalThis.__guideBrowserFixtures.mask }, parentResultId: draft.parentResultId });
          await globalThis.generateOne('guide', '引导重生', 1, { labMode, detailMode: item.detailMode, config: draft.config, generationSettings: draft.generationSettings, promptRecord: draft.promptRecord, guideContract: contract, editBaseImage: item.url, editMaskImage: globalThis.__guideBrowserFixtures.mask, sourceResultId: draft.parentResultId, productImages: draft.productImages, parentItem: item, negativePrompt: item.negativePrompt, detailTargetScreenIndex: 2, detailTargetScreenTotal: 8 });
        }
      }
      return calls;
    });
    assert.equal(report.checks.generationDispatch.length, 4);
    for (const request of report.checks.generationDispatch) {
      assert.equal(request.negativePrompt, ''); assert.equal(request.sourceResultId, 'browser-current-result'); assert.equal(request.contractParent, 'browser-current-result'); assert.equal(request.count, 1); assert(request.hasBase); assert.equal(request.productCount, 1);
      assert.doesNotMatch(request.prompt, /OLD|Create a new e-commerce|GENERATION MODE|premium lighting/);
      assert.match(request.prompt, /旧文案/); assert.match(request.prompt, /新文案/);
      assert.equal(request.strategy, request.model.includes('sunburst') ? 'sunburst-precise-edit-v1' : 'image2-structured-edit-v1');
    }

    report.checks.loadFailureUi = await page.evaluate(async () => {
      const api = globalThis.__SZ_PROMPTLAB_TEST_API__;
      api.setTestSend(async (type, payload) => { globalThis.__guideBrowserCalls.push({ type, url: payload && payload.url || '' }); return { ok: false, error: 'Synthetic browser fixture: image is unreadable' }; });
      const response = await globalThis.loadGuideAnnotationBase('https://fixture.invalid/unreadable-base.png');
      const callCountBeforeRun = globalThis.__guideBrowserCalls.length;
      const run = await api.runGuideRegenerate();
      return { response, ready: api.state.guideAnnotation.ready, buttonDisabled: document.getElementById('guideRunBtn').disabled, run, summary: document.getElementById('guidePlanSummary').innerText, generationCallsAfterRun: globalThis.__guideBrowserCalls.slice(callCountBeforeRun) };
    });
    assert.equal(report.checks.loadFailureUi.response.ok, false);
    assert.equal(report.checks.loadFailureUi.ready, false);
    assert.equal(report.checks.loadFailureUi.buttonDisabled, true);
    assert.equal(report.checks.loadFailureUi.run.ok, false);
    assert.equal(report.checks.loadFailureUi.generationCallsAfterRun.length, 0);
    await page.$eval('#guidePlanSummary', element => element.scrollIntoView({ block: 'center' }));
    await outerPage.screenshot({ path: path.join(evidence, 'unreadable-base-blocked.png'), fullPage: false });

    const images = await page.evaluate(() => ({ ...globalThis.__guideBrowserFixtures, composed: globalThis.__guideBrowserComposed }));
    for (const [name, dataUrl] of Object.entries(images)) fs.writeFileSync(path.join(evidence, name + '.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
    report.transportCalls = await page.evaluate(() => globalThis.__guideBrowserCalls);
    assert.equal(report.externalRequests.length, 0, 'No external request may be attempted');
    assert.deepEqual(report.pageErrors, [], 'Candidate page must load without JS errors');
    report.passed = true;
  } catch (error) {
    report.failure = String(error.stack || error);
    throw error;
  } finally {
    report.completedAt = new Date().toISOString();
    report.sourceSha256 = Object.fromEntries(['promptlab.html', 'promptlab.js', 'guide-model-profile.js'].map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(source, 'creative/labs/image-prompt-lab', name))).digest('hex')]));
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
    console.log(JSON.stringify({ passed: report.passed, browser: report.browserVersion, report: path.join(evidence, 'report.json'), failure: report.failure || null }, null, 2));
  }
}

main().catch(() => { process.exitCode = 1; });
