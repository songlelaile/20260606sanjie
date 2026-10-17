'use strict';

// Isolated, synthetic acceptance of the real website assets. The loopback
// provider is a controlled substitute; this script cannot contact production.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

const root = path.resolve(__dirname, '..');
const publicRoot = path.join(root, 'public');
const staticOverlayRoot = process.env.SKU_STATIC_OVERLAY_ROOT || '';
const productionBaselineRoot = process.env.SKU_PRODUCTION_BASELINE_DIR || '';
for (const [name, directory] of [['SKU_STATIC_OVERLAY_ROOT', staticOverlayRoot], ['SKU_PRODUCTION_BASELINE_DIR', productionBaselineRoot]]) {
  if (directory && (!path.isAbsolute(directory) || !fs.statSync(directory).isDirectory())) throw new Error(name + ' must name an absolute local directory');
}
const runName = process.argv[2] || 'candidate';
if (!/^[a-z0-9-]+$/i.test(runName)) throw new Error('Use a simple evidence run name');
const evidence = path.join(root, 'docs/uat-sku-workflow-20261012', runName);
fs.mkdirSync(evidence, { recursive: true });

function pngWithSixMiBAncillaryChunk(dataUrl) {
  const png = Buffer.from(dataUrl.split(',')[1], 'base64');
  const payload = Buffer.from('Fixture\0' + 'x'.repeat(6 * 1024 * 1024), 'ascii');
  const chunkType = Buffer.from('tEXt');
  const crcBytes = Buffer.concat([chunkType, payload]);
  let crc = 0xffffffff;
  for (const byte of crcBytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(payload.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return 'data:image/png;base64,' + Buffer.concat([png.subarray(0, png.length - 12), length, chunkType, payload, checksum, png.subarray(png.length - 12)]).toString('base64');
}

async function main() {
  const report = { startedAt: new Date().toISOString(), passed: false, syntheticOnly: true, realProviderCalls: 0,
    productionActions: 0, checks: {}, failures: [], pageErrors: [], externalRequests: [], providerCalls: [], messages: [], missingStaticAssets: [],
    assetMode: staticOverlayRoot || productionBaselineRoot ? 'production-static-overlay' : 'normal-local-public',
    staticOverlayRoot: staticOverlayRoot || null, productionBaselineRoot: productionBaselineRoot || null };
  const fixtures = {};
  const servedAssets = new Map();
  // Read a single snapshot so concurrent candidate edits cannot mix versions
  // inside one browser run. Hash exactly the bytes that this server serves.
  const assets = new Map();
  const assetSources = new Map();
  for (const directory of [publicRoot]) {
    function snapshot(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, item.name); if (item.isDirectory()) snapshot(file); else if (/\.(?:html|js|css)$/.test(item.name)) { assets.set(file, fs.readFileSync(file)); assetSources.set(file, { kind: 'local-public', source: file }); } } }
    snapshot(directory);
  }
  // Production downloads may be flat or retain the public/creative path. They
  // override only the Prompt Lab directory; the explicit overlay wins last.
  const labPrefix = 'creative/labs/image-prompt-lab/';
  function supplement(directory, kind) {
    if (!directory) return;
    function walk(dir) {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const source = path.join(dir, item.name);
        if (item.isDirectory()) { walk(source); continue; }
        if (!/\.(?:html|js|css)$/.test(item.name)) continue;
        let relative = path.relative(directory, source).split(path.sep).join('/');
        if (relative.startsWith('public/')) relative = relative.slice(7);
        if (relative.startsWith('labs/image-prompt-lab/')) relative = 'creative/' + relative;
        if (!relative.startsWith('creative/')) relative = labPrefix + relative;
        const knownGlobalCompatibilityLayer = kind === 'production-baseline' && relative === 'creative/web-chrome.js';
        if (!relative.startsWith(labPrefix) && !knownGlobalCompatibilityLayer) throw new Error(kind + ' may only override Prompt Lab static assets or the baseline creative/web-chrome.js: ' + relative);
        const target = path.join(publicRoot, relative);
        assets.set(target, fs.readFileSync(source)); assetSources.set(target, { kind, source });
      }
    }
    walk(directory);
  }
  supplement(productionBaselineRoot, 'production-baseline');
  supplement(staticOverlayRoot, 'static-overlay');
  let active = 0, peak = 0, providerMode = 'success';
  async function bodyOf(request) { let text = ''; for await (const data of request) text += data; return text; }
  const server = http.createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const json = (status, data, headers = {}) => { response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify(data)); };
    if (pathname === '/__sku-fixture') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><html><body style="margin:0"><iframe title="批量 SKU 工作台" style="border:0;width:100vw;height:100vh" src="/creative/labs/image-prompt-lab/promptlab.html?source=web&mode=sku"></iframe></body></html>'); return; }
    if (pathname === '/api/auth/me') return json(200, { data: { tenantId: 'sku-fixture', username: 'synthetic-browser', creativeEntitlement: { allowed: true } } });
    if (pathname === '/api/creative/quote') return json(200, { data: { available: false, reason: 'Synthetic verification' } });
    if (pathname === '/__provider' || pathname === '/api/creative/proxy') {
      const envelope = JSON.parse(await bodyOf(request));
      if (pathname === '/api/creative/proxy' && envelope.url !== 'https://sku-provider.fixture.invalid/images') return json(503, { error: 'No external proxy forwarding in synthetic fixture' });
      const body = pathname === '/api/creative/proxy' ? JSON.parse(envelope.bodyText) : envelope;
      const subjectIndex = Object.keys(fixtures).filter(key => key.startsWith('subject')).findIndex(key => fixtures[key] === body.product_images?.[0]);
      report.providerCalls.push({ index: report.providerCalls.length + 1, mode: providerMode, subjectIndex,
        roleOrder: body.input_role_order, hasBase: !!body.edit_base_image, subjects: body.product_images?.length,
        references: body.reference_images?.length, phase: body.sku_visual_phase,
        contract: body.sku_visual_lock?.version, outputSize: body.output_size, modelSize: body.size,
        titleInPrompt: /蓝色礼盒|紫色礼盒|绿色礼盒|SKU0[123]/.test(body.prompt), baseHash: crypto.createHash('sha256').update(body.edit_base_image || '').digest('hex') });
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 130));
      active--;
      if (providerMode === 'fail' || providerMode === 'mixed' && subjectIndex === 1) return json(400, { ok: false, code: 'CREATIVE_REQUEST_NOT_SUBMITTED', providerSubmitted: false, definitiveFailure: true, stateUncertain: false, error: 'SKU_FIXTURE_DEFINITIVE_FAILURE' }, { 'X-Sanjie-Provider-Submission': 'not-submitted' });
      const image = providerMode === 'bad-candidate' ? fixtures.global : providerMode === 'large-candidate' ? fixtures.largeCandidate : fixtures['candidate' + Math.max(0, subjectIndex)];
      return json(200, { data: [{ url: image }] });
    }
    if (pathname.startsWith('/__image/')) {
      const key = pathname.split('/').pop().replace(/\.png$/, '');
      if (key.startsWith('slow')) await new Promise(resolve => setTimeout(resolve, 180));
      const value = fixtures[key.replace(/^slow-/, '')];
      if (!value) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      response.end(Buffer.from(value.split(',')[1], 'base64')); return;
    }
    // Never proxy onward, even if a future product change tries to do so.
    if (pathname.startsWith('/api/')) return json(503, { ok: false, error: 'Synthetic fixture blocks this API' }, { 'X-Sanjie-Provider-Submission': 'not-submitted' });
    const filename = path.resolve(publicRoot, '.' + pathname);
    if (!filename.startsWith(publicRoot + path.sep)) { response.writeHead(403).end(); return; }
    const snap = assets.get(filename);
    if (snap) { servedAssets.set(path.relative(publicRoot, filename), snap); response.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(filename)], 'cache-control': 'no-store' }); response.end(snap); return; }
    fs.readFile(filename, (error, data) => {
      if (error) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' }[path.extname(filename)] || 'application/octet-stream', 'cache-control': 'no-store' }); response.end(data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sanjie-sku-browser-'));
  let browser, outer, page;
  async function acceptSyntheticCredentialThroughRealEditor() {
    const needsTrustedEditor = await page.evaluate(() => typeof globalThis.acceptedConfigApiKey === 'function');
    if (!needsTrustedEditor) return { required: false };
    await page.evaluate(() => openConfigModal());
    await page.waitForSelector('#configModal:not([hidden])');
    await page.select('#provider', 'openai-compatible');
    await page.waitForFunction(() => !globalThis.pendingProviderProfile && !globalThis.configWalletSwitchPending && configApiKey.provider === document.getElementById('provider').value);
    await page.evaluate(() => {
      document.getElementById('imageAdapter').value = 'generic-json';
      document.getElementById('imageEndpoint').value = 'https://sku-provider.fixture.invalid/images';
      document.getElementById('imageModel').value = 'fixture-image';
    });
    await page.click('#editApiKeyBtn');
    await page.type('#apiKey', 'SYNTHETIC-NOT-A-CREDENTIAL');
    const accepted = await page.evaluate(() => acceptedConfigApiKey(document.getElementById('provider').value) === 'SYNTHETIC-NOT-A-CREDENTIAL');
    assert.equal(accepted, true, 'Production API Key editor must accept actual trusted typing');
    await page.click('#configCloseBtn');
    return { required: true, trustedTypingAccepted: true, syntheticCredentialOnly: true };
  }
  const confirmRegion = async region => {
    return page.evaluate(async region => {
      if (!window.SZ_SKU_REGION) return { available: false };
      document.getElementById('skuRegionEditBtn').click();
      for (const [key, suffix] of [['x', 'X'], ['y', 'Y'], ['w', 'W'], ['h', 'H']]) {
        const input = document.getElementById('skuRegion' + suffix); input.value = String(region[key] * 100); input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.getElementById('skuRegionConfirmBtn').click();
      await new Promise(resolve => requestAnimationFrame(resolve));
      const preview = document.getElementById('skuTemplatePreview'), image = preview.querySelector('img'), overlay = preview.querySelector('.sku-region-overlay');
      const imageRect = image.getBoundingClientRect(), overlayRect = overlay.getBoundingClientRect();
      const rect = value => ({ x: value.x, y: value.y, width: value.width, height: value.height });
      return { available: true, region: window.SZ_SKU_REGION.get(), status: document.getElementById('skuRegionState').textContent,
        previewPosition: getComputedStyle(preview).position, imageRect: rect(imageRect), overlayRect: rect(overlayRect),
        overlayWithinImage: overlayRect.width > 0 && overlayRect.height > 0 && overlayRect.left >= imageRect.left - 1 && overlayRect.top >= imageRect.top - 1 && overlayRect.right <= imageRect.right + 1 && overlayRect.bottom <= imageRect.bottom + 1 };
    }, region);
  };
  const check = async (name, work) => {
    try { report.checks[name] = await work(); report.checks[name].passed = true; }
    catch (error) { report.checks[name] = { ...(report.checks[name] || {}), passed: false, error: error.message }; report.failures.push({ name, error: error.message }); }
  };
  try {
    browser = await puppeteer.launch({ headless: true, userDataDir: profile });
    report.browserVersion = await browser.version(); report.isolatedTemporaryProfile = true;
    outer = await browser.newPage();
    await outer.setViewport({ width: 1440, height: 1180, deviceScaleFactor: 1 });
    outer.on('pageerror', error => report.pageErrors.push(String(error.message || error)));
    outer.on('response', response => { if (response.status() >= 400 && response.url().startsWith(origin + '/creative/')) report.missingStaticAssets.push({ url: response.url(), status: response.status() }); });
    await outer.setRequestInterception(true);
    outer.on('request', request => {
      if (request.url().startsWith(origin + '/') || /^(?:data|blob):/.test(request.url())) return request.continue();
      report.externalRequests.push(request.url()); return request.abort('blockedbyclient');
    });
    await outer.evaluateOnNewDocument(() => {
      globalThis.__SZ_PROMPTLAB_TEST_MODE__ = true;
      globalThis.__SZ_PROMPTLAB_CANVAS_TEST_MODE__ = true;
      globalThis.__SZ_PROMPTLAB_BACKGROUND_TEST_MODE__ = true;
      globalThis.__SANJIE_ENVIRONMENT = 'sku-synthetic-browser';
    });
    await outer.goto(origin + '/__sku-fixture', { waitUntil: 'load' });
    page = await (await outer.$('iframe')).contentFrame();
    try {
      await page.waitForFunction(() => !!globalThis.__SZ_PROMPTLAB_TEST_API__ && !!globalThis.__SZ_PROMPTLAB_BACKGROUND_TEST_API__ && document.body.classList.contains('sku-lab-mode'), { timeout: 10000 });
    } catch (error) {
      report.bootstrap = await page.evaluate(() => ({ promptLabApi: !!globalThis.__SZ_PROMPTLAB_TEST_API__, backgroundApi: !!globalThis.__SZ_PROMPTLAB_BACKGROUND_TEST_API__, bodyClass: document.body.className, startup: document.documentElement.dataset.labStartup, visibleStatus: document.getElementById('labStartupStatus')?.textContent || '' }));
      throw new Error('Candidate bootstrap did not expose both Prompt Lab and background test APIs: ' + JSON.stringify(report.bootstrap));
    }
    await page.waitForFunction(() => document.documentElement.dataset.labStartup === 'ready');
    if (staticOverlayRoot || productionBaselineRoot) {
      const packed = ['studio-prerequisites-20261009-v1.js', 'studio-runtime-20261010-credit-v3.js', 'studio-views-20261010-credit-v3.js', 'studio-workspace-20261009-v1.css'];
      report.packedResourceVerification = Object.fromEntries(packed.map(name => {
        const relative = labPrefix + name;
        return [name, { loaded: servedAssets.has(relative), source: assetSources.get(path.join(publicRoot, relative)) }];
      }));
      for (const name of packed) {
        assert.equal(report.packedResourceVerification[name].loaded, true, 'Production candidate did not load packed asset ' + name);
        assert(['production-baseline', 'static-overlay'].includes(report.packedResourceVerification[name].source?.kind), 'Packed production asset fell back to normal local public: ' + name);
      }
      assert.equal(assetSources.get(path.join(publicRoot, labPrefix + 'promptlab.html'))?.kind, staticOverlayRoot ? 'static-overlay' : 'production-baseline');
      report.productionCompatibilityLayer = assetSources.get(path.join(publicRoot, 'creative/web-chrome.js'));
      assert.equal(report.productionCompatibilityLayer?.kind, 'production-baseline', 'Production candidate must use the downloaded production web-chrome.js compatibility layer');
    }
    // Account/config restoration is asynchronous. Wait for its actual readiness.
    await page.waitForFunction(() => !globalThis.pendingProviderProfile && !globalThis.configWalletSwitchPending);
    Object.assign(fixtures, await page.evaluate(() => {
      const colors = ['#1d4ed8', '#7e22ce', '#15a03d'];
      function png(draw) { const c = document.createElement('canvas'); c.width = c.height = 1024; draw(c.getContext('2d')); return c.toDataURL('image/png'); }
      function base(ctx, color) {
        ctx.fillStyle = '#f5e9d7'; ctx.fillRect(0, 0, 1024, 1024);
        ctx.fillStyle = '#0f766e'; ctx.fillRect(54, 46, 916, 154);
        ctx.fillStyle = '#fff7ed'; ctx.fillRect(76, 68, 620, 110);
        ctx.fillStyle = '#172554'; ctx.font = 'bold 38px sans-serif'; ctx.fillText('LOCKED ORIGINAL COPY', 102, 138);
        ctx.fillStyle = '#d6b98c'; ctx.fillRect(80, 820, 864, 116);
        ctx.fillStyle = '#7c3f1d'; ctx.fillRect(106, 850, 210, 54);
        ctx.fillStyle = '#1d4d42'; ctx.beginPath(); ctx.arc(860, 870, 44, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = color; ctx.fillRect(354, 302, 316, 410);
      }
      const result = { base: png(ctx => base(ctx, '#b91c1c')), global: png(ctx => { ctx.fillStyle = '#111827'; ctx.fillRect(0, 0, 1024, 1024); }) };
      colors.forEach((color, i) => {
        result['subject' + i] = png(ctx => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1024, 1024); ctx.fillStyle = color; ctx.fillRect(270, 190, 484, 644); });
        result['candidate' + i] = png(ctx => base(ctx, color));
      });
      globalThis.__skuFixtures = result; return result;
    }));
    fixtures.largeCandidate = pngWithSixMiBAncillaryChunk(fixtures.candidate0);
    await page.evaluate(endpoint => {
      const api = globalThis.__SZ_PROMPTLAB_TEST_API__;
      api.state.archiveAccountKey = 'user:sku-fixture:synthetic-browser';
      for (const [id, value] of Object.entries({ provider: 'openai-compatible', imageAdapter: 'generic-json', imageModel: 'fixture-image', imageEndpoint: endpoint, apiKey: 'SYNTHETIC-NOT-A-CREDENTIAL', skuConcurrency: '2', skuRatio: '1:1', skuResolution: '1K' })) document.getElementById(id).value = value;
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      globalThis.__skuMessages = [];
      chrome.runtime.sendMessage = (message, callback) => { globalThis.__skuMessages.push({ type: message.type, jobId: message.jobId || '', roles: message.payload?.inputRoleOrder, source: message.payload?.promptSource }); return original(message, callback); };
    }, 'https://sku-provider.fixture.invalid/images');
    report.credentialFixture = await acceptSyntheticCredentialThroughRealEditor();

    await check('importAndPreflight', async () => {
      const files = [];
      for (let i = 0; i < 3; i++) { const filename = path.join(evidence, 'subject-' + (i + 1) + '.png'); fs.writeFileSync(filename, Buffer.from(fixtures['subject' + i].split(',')[1], 'base64')); files.push(filename); }
      const basePath = path.join(evidence, 'template.png'); fs.writeFileSync(basePath, Buffer.from(fixtures.base.split(',')[1], 'base64'));
      await (await page.$('#skuProductFiles')).uploadFile(...files);
      await (await page.$('#skuTemplateFile')).uploadFile(basePath);
      await page.waitForFunction(() => __SZ_PROMPTLAB_TEST_API__.state.skuProducts.length === 3 && !!__SZ_PROMPTLAB_TEST_API__.state.skuTemplate);
      const before = report.providerCalls.length;
      const rights = await page.evaluate(() => __SZ_PROMPTLAB_TEST_API__.generateSkuBatch(false));
      assert.equal(rights.code, 'sku_asset_rights_required');
      const title = await page.evaluate(async () => { document.getElementById('skuBaseRightsConfirmed').checked = true; return __SZ_PROMPTLAB_TEST_API__.generateSkuBatch(false); });
      assert.equal(title.code, 'sku_business_title_required');
      assert.equal(report.providerCalls.length, before);
      const ui = await page.evaluate(() => {
        const field = document.getElementById('skuAttrText'); field.value = '蓝色礼盒\n紫色礼盒\n绿色礼盒'; field.dispatchEvent(new Event('input', { bubbles: true }));
        return { products: __SZ_PROMPTLAB_TEST_API__.state.skuProducts.length, tasks: __SZ_PROMPTLAB_TEST_API__.skuTaskBlueprints().map(task => task.attr), previews: document.querySelectorAll('#skuProductPreview img').length, state: document.getElementById('skuState').textContent };
      });
      assert.deepEqual(ui.tasks, ['蓝色礼盒', '紫色礼盒', '绿色礼盒']); assert.equal(ui.previews, 3);
      const imported = await page.evaluate(() => __SZ_PROMPTLAB_TEST_API__.state.skuProducts.map(item => item.url));
      imported.forEach((url, index) => { fixtures['subject' + index] = url; });
      const region = await confirmRegion({ x: .12, y: .18, w: .76, h: .72 });
      if (region.available) assert.equal(region.overlayWithinImage, true, 'Region overlay must stay on the template image after legacy className rendering');
      await outer.screenshot({ path: path.join(evidence, 'sku-import.png'), fullPage: false });
      return { rightsCode: rights.code, titleCode: title.code, zeroProviderCalls: true, region, ...ui };
    });
    await check('batchThroughRealBackground', async () => {
      const callBefore = report.providerCalls.length;
      const result = await page.evaluate(() => __SZ_PROMPTLAB_TEST_API__.generateSkuBatch(false));
      const statuses = await page.evaluate(() => Object.values(__SZ_PROMPTLAB_TEST_API__.state.skuTaskStatus).map(item => ({ state: item.state, error: item.error })));
      report.checks.batchThroughRealBackground = { result, peakConcurrency: peak, statuses };
      assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.succeeded, 3);
      assert.equal(peak, 2);
      assert.equal(report.providerCalls.length - callBefore, 3);
      for (const call of report.providerCalls.slice(callBefore)) { assert.deepEqual(call.roleOrder, ['IMMUTABLE_SKU_BASE', 'REPLACEMENT_SUBJECT']); assert.equal(call.hasBase, true); assert.equal(call.subjects, 1); assert.equal(call.references, 0); assert.equal(call.contract, 'SKU_SUBJECT_REPLACE_V2'); assert.equal(call.titleInPrompt, false); }
      const state = await page.evaluate(async () => {
        const api = __SZ_PROMPTLAB_TEST_API__; await api.state.archiveWriteQueue;
        const archive = await SZ_IMAGE_ARCHIVE.list(api.state.archiveAccountKey, { skipPurge: true });
        globalThis.__skuOldResults = api.state.skuResults.slice();
        return { results: api.state.skuResults.map(item => ({ title: item.skuTitle, width: item.outputWidth, height: item.outputHeight, mime: item.mimeType, archived: !!item.archiveAssetId, resultId: item.resultId })), archiveCount: archive.reduce((sum, batch) => sum + batch.assets.length, 0), filenames: api.buildDownloadItems(api.state.skuResults, 'sku').map(item => item.filename) };
      });
      assert.equal(state.archiveCount, 3); assert.equal(state.results.length, 3);
      for (const item of state.results) { assert.equal(item.width, 1024); assert.equal(item.height, 1024); assert.equal(item.mime, 'image/jpeg'); }
      assert.deepEqual(state.filenames.map(name => name.split('/').pop()), ['蓝色礼盒.jpg', '紫色礼盒.jpg', '绿色礼盒.jpg']);
      await outer.screenshot({ path: path.join(evidence, 'sku-success.png'), fullPage: false });
      return { result, peakConcurrency: peak, statuses, ...state, actualWebChromeAndBackground: true };
    });
    await check('canvasRestoresTemplatePixelsOutsideSubject', async () => {
      const result = await page.evaluate(async () => {
        const api = __SZ_PROMPTLAB_TEST_API__, item = api.state.skuResults[0];
        async function pixels(url) {
          const im = await new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = url; });
          const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
          const ctx = c.getContext('2d'); ctx.drawImage(im, 0, 0); return { c, ctx, pixels: ctx.getImageData(0, 0, c.width, c.height) };
        }
        const base = await pixels(api.state.skuTemplate), candidate = await pixels(__skuFixtures.candidate0);
        const options = { authorizedRegion: item.skuVisualLock.subject.authorizedRegion };
        const analysis = api.skuAnalyzeLocalizedPixelDifference(base.pixels.data, candidate.pixels.data, 1024, 1024, options);
        const localized = api.skuBuildLocalizedPixelMask(base.pixels.data, candidate.pixels.data, 1024, 1024, analysis, options);
        if (!analysis.ok || !localized.ok) throw new Error('Fixture localized mask rejected');
        let insidePixels = 0, outsidePixels = 0;
        for (let i = 0; i < localized.mask.length; i++) {
          if (!localized.mask[i]) { outsidePixels++; continue; }
          insidePixels++; const offset = i * 4; for (let channel = 0; channel < 4; channel++) base.pixels.data[offset + channel] = candidate.pixels.data[offset + channel];
        }
        base.ctx.putImageData(base.pixels, 0, 0);
        const expected = await new Promise((resolve, reject) => base.c.toBlob(blob => { if (!blob) return reject(new Error('Expected JPEG encoding failed')); const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); }, 'image/jpeg', .94));
        const digest = async url => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url)))].map(value => value.toString(16).padStart(2, '0')).join('');
        return { insidePixels, outsidePixels, maskBounds: localized.bounds, expectedJpegHash: await digest(expected), actualJpegHash: await digest(item.url), matchesReferenceComposition: expected === item.url, width: base.c.width, height: base.c.height };
      });
      assert.equal(result.matchesReferenceComposition, true, 'Final JPEG must equal independently reconstructed base-outside/candidate-inside composition');
      assert(result.outsidePixels > 850000); assert(result.insidePixels > 100000);
      return result;
    });
    await check('downloadViaRealWebChrome', async () => {
      const downloadPath = path.join(evidence, 'downloads'); fs.mkdirSync(downloadPath, { recursive: true });
      const session = await outer.createCDPSession(); await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath });
      const result = await page.evaluate(() => __SZ_PROMPTLAB_TEST_API__.downloadSkuResults(__SZ_PROMPTLAB_TEST_API__.state.skuResults));
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && fs.readdirSync(downloadPath).filter(file => file.endsWith('.jpg')).length < 3) await new Promise(resolve => setTimeout(resolve, 40));
      const files = fs.readdirSync(downloadPath).filter(file => file.endsWith('.jpg')).sort();
      const downloadNames = await page.evaluate(() => __SZ_PROMPTLAB_TEST_API__.buildDownloadItems(__SZ_PROMPTLAB_TEST_API__.state.skuResults, 'sku').map(item => item.filename));
      const expectedFiles = downloadNames.map(name => name.split(/[\\/]/).pop()).sort();
      assert.deepEqual(files, expectedFiles);
      for (const file of files) { const data = fs.readFileSync(path.join(downloadPath, file)); assert.equal(data.readUInt16BE(0), 0xffd8); }
      return { result, files, actualBrowserDownload: true, filenamePolicy: 'business-title leaf only; no flattened extension folder prefix' };
    });
    await check('regenerationFailurePreservesOldResults', async () => {
      providerMode = 'fail'; const before = report.providerCalls.length;
      const state = await page.evaluate(async () => {
        const api = __SZ_PROMPTLAB_TEST_API__, prior = api.state.skuResults.map(item => item.resultId);
        document.getElementById('imageModel').value = 'fixture-regeneration-failure';
        api.state.skuTaskStatus = {}; api.setAllSkuSelections(true);
        const result = await api.generateSkuBatch(false);
        return { result, prior, after: api.state.skuResults.map(item => item.resultId), statuses: Object.values(api.state.skuTaskStatus).map(item => item.state) };
      });
      report.checks.regenerationFailurePreservesOldResults = state;
      assert.deepEqual(state.after, state.prior, 'Failed regeneration must keep every previous successful image');
      assert.equal(state.result.failed, 3); assert.equal(report.providerCalls.length - before, 3);
      return state;
    });
    await check('failedOnlyRetry', async () => {
      providerMode = 'success'; const before = report.providerCalls.length;
      const result = await page.evaluate(() => __SZ_PROMPTLAB_TEST_API__.retryFailedSkuTasks());
      assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(report.providerCalls.length - before, 3);
      return { result, dispatches: report.providerCalls.length - before };
    });
    await check('oneFailureDoesNotBlockConcurrentSiblings', async () => {
      providerMode = 'mixed'; const before = report.providerCalls.length; peak = 0;
      const result = await page.evaluate(async () => { const api = __SZ_PROMPTLAB_TEST_API__; document.getElementById('imageModel').value = 'fixture-mixed-three'; document.getElementById('skuConcurrency').value = '3'; api.state.skuTaskStatus = {}; api.setAllSkuSelections(true); return api.generateSkuBatch(false); });
      assert.equal(result.succeeded, 2); assert.equal(result.failed, 1); assert.equal(report.providerCalls.length - before, 3); assert.equal(peak, 3);
      providerMode = 'success'; const retryBefore = report.providerCalls.length;
      const retry = await page.evaluate(() => __SZ_PROMPTLAB_TEST_API__.retryFailedSkuTasks());
      assert.equal(retry.ok, true); assert.equal(report.providerCalls.length - retryBefore, 1);
      return { result, retry, peakConcurrency: peak, retryDispatches: 1 };
    });
    await check('uncertainReceiptIsVisibleAndNotRetryable', async () => {
      const state = await page.evaluate(async () => {
        const api = __SZ_PROMPTLAB_TEST_API__;
        document.getElementById('imageModel').value = 'fixture-uncertain-receipt';
        api.state.skuTaskStatus = {};
        api.setAllSkuSelections(false); api.state.skuSelections[api.skuTaskBlueprints()[0].skuId] = true;
        let dispatches = 0;
        api.setTestSend(async type => { if (type === 'GENERATE_IMAGE') { dispatches++; return { ok: false, stateUncertain: true, jobId: 'synthetic-uncertain', error: 'Synthetic receipt requires reconciliation' }; } return { ok: true }; });
        const result = await api.generateSkuBatch(false);
        const pill = document.getElementById('skuState');
        const status = api.state.skuTaskStatus[api.skuTaskBlueprints()[0].skuId];
        const receiptDetails = [...document.querySelectorAll('#skuTaskList details')].find(element => /回执/.test(element.textContent));
        const pillText = pill.textContent, pillClass = pill.className;
        const retry = await api.retryFailedSkuTasks();
        api.setTestSend(null);
        return { result, status: { state: status.state, jobId: status.jobId }, pill: pillText, pillClass, receiptDetailsVisible: !!receiptDetails && !receiptDetails.hidden, dispatches, retry };
      });
      report.checks.uncertainReceiptIsVisibleAndNotRetryable = state;
      assert.equal(state.status.state, 'uncertain'); assert.equal(state.dispatches, 1);
      assert(!state.pillClass.split(/\s+/).includes('ok'), 'Uncertain receipt must not use success styling');
      assert.match(state.pill, /待核对|核对|回执/); assert.equal(state.receiptDetailsVisible, true, 'Uncertain SKU needs visible receipt information');
      return state;
    });
    await check('candidateFailurePreservesDeliveredImage', async () => {
      providerMode = 'bad-candidate'; const before = report.providerCalls.length;
      const state = await page.evaluate(async () => {
        const api = __SZ_PROMPTLAB_TEST_API__; api.setAllSkuSelections(false); const task = api.skuTaskBlueprints()[0]; api.state.skuSelections[task.skuId] = true;
        document.getElementById('imageModel').value = 'fixture-candidate-failure';
        // Reset the uncertainty fixture only; production reconciliation is never bypassed.
        api.state.skuTaskStatus[task.skuId] = { state: 'idle' };
        const result = await api.generateSkuBatch(false); const status = api.state.skuTaskStatus[task.skuId];
        return { result, skuId: task.skuId, statusKeys: Object.keys(status), state: status.state, hasCandidate: !!(status.recovery?.response?.images?.length || status.candidateImages?.length || status.deliveredImages?.length || status.images?.length || status.pendingCandidate?.images?.length), providerSubmitted: status.providerSubmitted, error: status.error };
      });
      report.checks.candidateFailurePreservesDeliveredImage = state;
      assert.equal(report.providerCalls.length - before, 1);
      assert.equal(state.hasCandidate, true, 'Delivered provider image must remain available after local composition rejects it');
      assert.equal(state.providerSubmitted, true);
      assert.equal(state.state, 'processing_failed');
      const retry = await page.evaluate(skuId => (__SZ_PROMPTLAB_TEST_API__.retrySkuReturnedImages || globalThis.retrySkuReturnedImages)(skuId), state.skuId);
      assert.equal(report.providerCalls.length - before, 1, 'Local candidate retry must never request another provider image');
      return { ...state, localRetrySucceeded: retry.ok === true, zeroAdditionalProviderCalls: true };
    });
    await check('transientLocalEncoderFailureRecoversWithoutGeneration', async () => {
      providerMode = 'success'; const before = report.providerCalls.length;
      const state = await page.evaluate(async () => {
        const api = __SZ_PROMPTLAB_TEST_API__, task = api.skuTaskBlueprints()[0];
        document.getElementById('imageModel').value = 'fixture-local-encoder-recovery';
        api.state.skuTaskStatus = {}; api.setAllSkuSelections(false); api.state.skuSelections[task.skuId] = true;
        const original = HTMLCanvasElement.prototype.toBlob;
        let failedOnce = false;
        HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
          if (type === 'image/jpeg' && !failedOnce) { failedOnce = true; callback(null); return; }
          return original.call(this, callback, type, quality);
        };
        let first;
        try { first = await api.generateSkuBatch(false); } finally { HTMLCanvasElement.prototype.toBlob = original; }
        const failedState = api.state.skuTaskStatus[task.skuId];
        const status = failedState.state, hasCandidate = !!failedState.recovery?.response?.images?.length;
        const retry = await (api.retrySkuReturnedImages || globalThis.retrySkuReturnedImages)(task.skuId); await api.state.archiveWriteQueue;
        return { first, status, hasCandidate, retry: { ok: retry.ok, archived: retry.archived }, finalStatus: api.state.skuTaskStatus[task.skuId].state };
      });
      report.checks.transientLocalEncoderFailureRecoversWithoutGeneration = state;
      assert.equal(state.status, 'processing_failed'); assert.equal(state.hasCandidate, true);
      assert.equal(state.retry.ok, true); assert.equal(state.finalStatus, 'success');
      assert.equal(state.retry.archived, true); assert.equal(report.providerCalls.length - before, 1);
      return { ...state, totalProviderCalls: 1, zeroRetryProviderCalls: true };
    });
    await check('unknownReceiptSurvivesTaskReorderAndReimport', async () => {
      const result = await page.evaluate(async () => {
        const api = __SZ_PROMPTLAB_TEST_API__, products = api.state.skuProducts.slice(), titles = document.getElementById('skuAttrText').value;
        document.getElementById('imageModel').value = 'fixture-unknown-reorder-reimport';
        document.getElementById('skuResolution').value = '1K';
        api.state.skuTaskStatus = {}; api.setAllSkuSelections(false); api.state.skuSelections[products[0].skuId] = true;
        let dispatches = 0;
        api.setTestSend(async type => { if (type === 'GENERATE_IMAGE') { dispatches++; return { ok: false, stateUncertain: true, taskId: 'fixture-unknown-reorder', error: 'Unknown submission retained for reconciliation' }; } return { ok: true }; });
        try {
          const first = await api.generateSkuBatch(false);
          api.state.skuProducts.reverse(); api.state.skuTaskStatus = {}; api.setAllSkuSelections(false); api.state.skuSelections[products[0].skuId] = true;
          const reorder = await api.generateSkuBatch(false);
          const reorderDispatches = dispatches;
          api.state.skuProducts = api.state.skuProducts.filter(item => item.skuId !== products[0].skuId);
          api.addSkuProducts([{ url: products[0].url, name: products[0].name, source: 'file' }]);
          const newItem = api.state.skuProducts[api.state.skuProducts.length - 1];
          api.state.skuTaskStatus = {}; api.setAllSkuSelections(false); api.state.skuSelections[newItem.skuId] = true;
          const reimport = await api.generateSkuBatch(false);
          return { first, reorder, reimport, firstDispatches: 1, reorderDispatches, totalDispatches: dispatches, oldSkuId: products[0].skuId, newSkuId: newItem.skuId };
        } finally { api.setTestSend(null); api.state.skuProducts = products; api.state.skuTaskStatus = {}; document.getElementById('skuAttrText').value = titles; renderSkuWorkspace(); }
      });
      report.checks.unknownReceiptSurvivesTaskReorderAndReimport = result;
      assert.equal(result.first.uncertain, 1); assert.equal(result.reorder.uncertain, 1); assert.equal(result.reimport.uncertain, 1);
      assert.notEqual(result.oldSkuId, result.newSkuId); assert.equal(result.reorderDispatches, 1); assert.equal(result.totalDispatches, 1);
      return result;
    });
    await check('sharedTemplateRequiresFreshConfirmedRegionBeforeDispatch', async () => {
      const before = report.providerCalls.length;
      let result;
      try {
        result = await page.evaluate(async () => {
          const api = __SZ_PROMPTLAB_TEST_API__, task = api.skuTaskBlueprints()[0];
          document.getElementById('imageModel').value = 'fixture-required-region-gate';
          api.state.skuTaskStatus = {}; api.setAllSkuSelections(false); api.state.skuSelections[task.skuId] = true;
          SZ_SKU_REGION.clear();
          const messageBefore = __skuMessages.filter(message => message.type === 'GENERATE_IMAGE').length;
          const response = await api.generateSkuBatch(false);
          const messageAfter = __skuMessages.filter(message => message.type === 'GENERATE_IMAGE').length;
          const base = api.state.skuTemplate;
          SZ_SKU_REGION.set({ x: .12, y: .18, w: .76, h: .72, confirmed: true });
          api.state.skuTemplate = __skuFixtures.global; renderSkuWorkspace();
          await new Promise(resolve => requestAnimationFrame(resolve));
          const clearedAfterBaseChange = SZ_SKU_REGION.get() === null;
          api.state.skuTemplate = base; renderSkuWorkspace();
          await new Promise(resolve => requestAnimationFrame(resolve));
          return { response, generationMessages: messageAfter - messageBefore, clearedAfterBaseChange };
        });
      } finally { await confirmRegion({ x: .12, y: .18, w: .76, h: .72 }); }
      report.checks.sharedTemplateRequiresFreshConfirmedRegionBeforeDispatch = result;
      assert.equal(result.response.ok, false); assert.match(result.response.error || '', /区域/);
      assert.equal(result.generationMessages, 0); assert.equal(report.providerCalls.length, before); assert.equal(result.clearedAfterBaseChange, true);
      return { ...result, zeroProviderCalls: true };
    });
    await check('deliveredReceiptRecoversAcrossPageWithFrozenOutputIdentity', async () => {
      providerMode = 'large-candidate'; const before = report.providerCalls.length;
      const first = await page.evaluate(async () => {
        const api = __SZ_PROMPTLAB_TEST_API__, task = api.skuTaskBlueprints()[0];
        document.getElementById('imageModel').value = 'fixture-cross-page-delivery';
        document.getElementById('skuResolution').value = 'custom'; document.getElementById('skuCustomWidth').value = '1000'; document.getElementById('skuCustomHeight').value = '1000';
        api.state.skuTaskStatus = {}; api.setAllSkuSelections(false); api.state.skuSelections[task.skuId] = true;
        const original = HTMLCanvasElement.prototype.toBlob;
        let failedOnce = false;
        HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) { if (type === 'image/jpeg' && !failedOnce) { failedOnce = true; callback(null); return; } return original.call(this, callback, type, quality); };
        try {
          const result = await api.generateSkuBatch(false), status = api.state.skuTaskStatus[task.skuId];
          const receipt = status.recovery?.response._skuReceipt;
          const saved = receipt && await SZ_SKU_DELIVERY_STORE.read(receipt.owner, receipt.key);
          const pointer = receipt && JSON.parse(localStorage.getItem(receipt.key));
          const wrongOwner = receipt && await SZ_SKU_DELIVERY_STORE.read('user:other-owner:fixture', receipt.key);
          const wrongJob = receipt && await SZ_SKU_DELIVERY_STORE.remove(receipt.owner, receipt.key, 'wrong-job-id');
          const retained = receipt && await SZ_SKU_DELIVERY_STORE.read(receipt.owner, receipt.key);
          const expectedItem = { archiveBatchId: status.recovery?.settings.archiveBatchId, jobId: status.jobId, resultId: status.jobId + ':1', skuTitle: task.attr, sourceIndex: task.index, url: status.recovery?.response.images[0] };
          const expectedBusiness = archiveBusinessMetaForItem(expectedItem, { surfaceMode: 'sku', batchTitle: status.recovery?.settings.archiveBatchTitle });
          const expectedArchive = SZ_IMAGE_ARCHIVE.sanitizeArchiveInput({ accountKey: api.state.archiveAccountKey, surfaceMode: 'sku', sourceBatchId: expectedBusiness.archiveProjectId, resultId: expectedItem.resultId, url: expectedItem.url });
          return { result, status: status.state, jobId: status.jobId, archiveBatchId: status.recovery?.settings.archiveBatchId,
            expectedArchiveBatchId: expectedArchive.archiveBatchId, expectedArchiveProjectId: expectedBusiness.archiveProjectId,
            receipt, storage: { imageCharacters: saved?.images?.[0]?.length || 0, pointerBytes: JSON.stringify(pointer).length, pointerContainsImages: !!pointer?.images,
              pointerStorage: pointer?.storage, wrongOwnerMissing: wrongOwner === null, wrongJobRetained: wrongJob?.reason === 'job_mismatch' && retained?.jobId === status.jobId },
            contractId: status.recovery?.settings.visualLock.batchLockId, originalSkuId: task.skuId,
            source: { subject: task.item.url, template: api.state.skuTemplate }, title: task.attr };
        } finally { HTMLCanvasElement.prototype.toBlob = original; }
      });
      assert.equal(first.status, 'processing_failed'); assert.equal(report.providerCalls.length - before, 1);
      assert(first.storage.imageCharacters > 6 * 1024 * 1024); assert.equal(first.storage.pointerContainsImages, false); assert(first.storage.pointerBytes < 1000);
      assert.equal(first.storage.pointerStorage, 'indexeddb'); assert.equal(first.storage.wrongOwnerMissing, true); assert.equal(first.storage.wrongJobRetained, true);
      const originalPage = page;
      const recoveryPage = await browser.newPage();
      let second;
      try {
        await recoveryPage.setRequestInterception(true);
        recoveryPage.on('request', request => { if (request.url().startsWith(origin + '/') || /^(?:data|blob):/.test(request.url())) return request.continue(); report.externalRequests.push(request.url()); return request.abort('blockedbyclient'); });
        await recoveryPage.evaluateOnNewDocument(() => { globalThis.__SZ_PROMPTLAB_TEST_MODE__ = true; globalThis.__SZ_PROMPTLAB_CANVAS_TEST_MODE__ = true; globalThis.__SZ_PROMPTLAB_BACKGROUND_TEST_MODE__ = true; globalThis.__SANJIE_ENVIRONMENT = 'sku-synthetic-browser'; });
        await recoveryPage.goto(origin + '/__sku-fixture', { waitUntil: 'load' });
        page = await (await recoveryPage.$('iframe')).contentFrame();
        await page.waitForFunction(() => !!globalThis.__SZ_PROMPTLAB_TEST_API__ && document.documentElement.dataset.labStartup === 'ready' && !globalThis.pendingProviderProfile && !globalThis.configWalletSwitchPending);
        await acceptSyntheticCredentialThroughRealEditor();
        await page.evaluate(first => {
          const api = __SZ_PROMPTLAB_TEST_API__; api.state.archiveAccountKey = 'user:sku-fixture:synthetic-browser';
          for (const [id, value] of Object.entries({ provider: 'openai-compatible', imageAdapter: 'generic-json', imageModel: 'fixture-cross-page-delivery', imageEndpoint: 'https://sku-provider.fixture.invalid/images', apiKey: 'SYNTHETIC-NOT-A-CREDENTIAL', skuResolution: 'custom', skuCustomWidth: '900', skuCustomHeight: '900' })) document.getElementById(id).value = value;
          api.addSkuProducts([{ url: first.source.subject, name: 'Reload subject', source: 'file' }]); api.state.skuTemplate = first.source.template;
          document.getElementById('skuAttrText').value = first.title; document.getElementById('skuBaseRightsConfirmed').checked = true; renderSkuWorkspace();
        }, first);
        await confirmRegion({ x: .12, y: .18, w: .76, h: .72 });
        second = await page.evaluate(async first => {
          const api = __SZ_PROMPTLAB_TEST_API__;
          const result = await api.generateSkuBatch(false); await api.state.archiveWriteQueue;
          const item = api.state.skuResults[0];
          const after = await SZ_SKU_DELIVERY_STORE.read(first.receipt.owner, first.receipt.key);
          return { result, idbDeliveryRemovedAfterArchive: after === null, localReceiptRemovedAfterArchive: localStorage.getItem(first.receipt.key) === null,
            statuses: Object.values(api.state.skuTaskStatus).map(status => ({ state: status.state, error: status.error, jobId: status.jobId })), output: item && { width: item.outputWidth, height: item.outputHeight, jobId: item.jobId, resultId: item.resultId, archiveBatchId: item.archiveBatchId, contractId: item.skuVisualLock.batchLockId, skuId: item.skuId, archived: !!item.archiveAssetId } };
        }, first);
      } finally { page = originalPage; await recoveryPage.close(); }
      report.checks.deliveredReceiptRecoversAcrossPageWithFrozenOutputIdentity = { first: { ...first, source: undefined }, second };
      assert.equal(second.result.ok, true, JSON.stringify(second.result)); assert.equal(report.providerCalls.length - before, 1);
      assert.equal(second.output.width, 1000); assert.equal(second.output.height, 1000);
      assert.equal(second.output.jobId, first.jobId); assert.equal(second.output.resultId, first.jobId + ':1');
      assert.equal(second.output.archiveBatchId, first.expectedArchiveBatchId); assert.equal(second.output.contractId, first.contractId); assert.equal(second.output.archived, true);
      assert.equal(second.idbDeliveryRemovedAfterArchive, true); assert.equal(second.localReceiptRemovedAfterArchive, true);
      return { first: { ...first, source: undefined }, second, totalProviderCalls: 1, zeroRecoveryProviderCalls: true };
    });
    await check('deliveryQuotaFailureRetainsPendingProtection', async () => {
      providerMode = 'success'; const before = report.providerCalls.length;
      const result = await page.evaluate(async () => {
        const api = __SZ_PROMPTLAB_TEST_API__, task = api.skuTaskBlueprints()[0];
        document.getElementById('imageModel').value = 'fixture-delivery-quota-failure'; document.getElementById('skuResolution').value = '1K';
        api.state.skuTaskStatus = {}; api.setAllSkuSelections(false); api.state.skuSelections[task.skuId] = true;
        const save = SZ_SKU_DELIVERY_STORE.save, toBlob = HTMLCanvasElement.prototype.toBlob;
        SZ_SKU_DELIVERY_STORE.save = () => Promise.reject(new DOMException('Synthetic IndexedDB quota exceeded', 'QuotaExceededError'));
        HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) { if (type === 'image/jpeg') { callback(null); return; } return toBlob.call(this, callback, type, quality); };
        let first, status, receipt, pointer;
        try {
          first = await api.generateSkuBatch(false); status = api.state.skuTaskStatus[task.skuId]; receipt = status.recovery?.response._skuReceipt; pointer = receipt && JSON.parse(localStorage.getItem(receipt.key));
        } finally { SZ_SKU_DELIVERY_STORE.save = save; HTMLCanvasElement.prototype.toBlob = toBlob; }
        const outcome = { first, state: status.state, providerSubmitted: status.providerSubmitted, deliveryStorageError: status.recovery?.response.deliveryStorageError,
          memoryCandidateRetained: !!status.recovery?.response.images?.length, pointerState: pointer?.state, pointerContainsImages: !!pointer?.images };
        api.state.skuTaskStatus = {}; api.state.skuSelections[task.skuId] = true;
        const second = await api.generateSkuBatch(false);
        return { ...outcome, second, secondState: api.state.skuTaskStatus[task.skuId]?.state };
      });
      report.checks.deliveryQuotaFailureRetainsPendingProtection = result;
      assert.equal(result.providerSubmitted, true); assert.equal(result.state, 'processing_failed'); assert.equal(result.memoryCandidateRetained, true);
      assert.match(result.deliveryStorageError || '', /quota/i); assert.equal(result.pointerState, 'pending'); assert.equal(result.pointerContainsImages, false);
      assert.equal(result.secondState, 'uncertain'); assert.equal(report.providerCalls.length - before, 1);
      return { ...result, totalProviderCalls: 1, zeroRetryProviderCalls: true };
    });
    await check('stopDuringLocalizationDoesNotDispatch', async () => {
      providerMode = 'success'; const before = report.providerCalls.length;
      const state = await page.evaluate(async origin => {
        const api = __SZ_PROMPTLAB_TEST_API__; api.setAllSkuSelections(false);
        document.getElementById('imageModel').value = 'fixture-stop-localization';
        const item = api.state.skuProducts[0]; item.url = origin + '/__image/slow-subject0.png';
        api.state.skuTaskStatus[item.skuId] = { state: 'idle' }; api.state.skuSelections[item.skuId] = true;
        const pending = api.generateSkuBatch(false);
        await new Promise(resolve => setTimeout(resolve, 25)); api.stopSkuGeneration();
        const result = await pending; return { result, status: api.state.skuTaskStatus[item.skuId]?.state };
      }, origin);
      report.checks.stopDuringLocalizationDoesNotDispatch = { ...state, dispatches: report.providerCalls.length - before };
      assert.equal(report.providerCalls.length - before, 0, 'Stopping while image input is localizing must prevent provider dispatch');
      assert.equal(state.result.stopped, true); return { ...state, dispatches: 0 };
    });
    await check('accountChangeStopsQueuedTasksAndArchiveWrites', async () => {
      providerMode = 'success'; const before = report.providerCalls.length;
      const account = await page.evaluate(async () => {
        const api = __SZ_PROMPTLAB_TEST_API__, owner = api.state.archiveAccountKey;
        document.getElementById('imageModel').value = 'fixture-owner-change'; document.getElementById('skuConcurrency').value = '1'; document.getElementById('skuResolution').value = '1K';
        api.state.skuProducts[0].url = __skuFixtures.subject0; api.state.skuTaskStatus = {}; api.setAllSkuSelections(true);
        const archive = await SZ_IMAGE_ARCHIVE.list(owner, { skipPurge: true });
        globalThis.__skuOwnerPending = api.generateSkuBatch(false);
        return { owner, originalArchiveCount: archive.reduce((sum, batch) => sum + batch.assets.length, 0) };
      });
      const deadline = Date.now() + 5000;
      while (report.providerCalls.length === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(report.providerCalls.length - before, 1, 'First owner-bound task must reach the controlled provider');
      const outcome = await page.evaluate(async original => {
        const api = __SZ_PROMPTLAB_TEST_API__; api.state.archiveAccountKey = 'user:replacement-owner:fixture';
        const response = await __skuOwnerPending; await api.state.archiveWriteQueue;
        const other = await SZ_IMAGE_ARCHIVE.list(api.state.archiveAccountKey, { skipPurge: true }), prior = await SZ_IMAGE_ARCHIVE.list(original.owner, { skipPurge: true });
        const result = { response, busy: api.state.skuActive, newOwnerArchiveCount: other.reduce((sum, batch) => sum + batch.assets.length, 0), originalArchiveCount: prior.reduce((sum, batch) => sum + batch.assets.length, 0) };
        api.state.archiveAccountKey = original.owner; api.state.stopRequested = false; return result;
      }, account);
      report.checks.accountChangeStopsQueuedTasksAndArchiveWrites = { ...outcome, dispatches: report.providerCalls.length - before };
      assert.equal(report.providerCalls.length - before, 1); assert.equal(outcome.newOwnerArchiveCount, 0); assert.equal(outcome.originalArchiveCount, account.originalArchiveCount); assert.equal(outcome.busy, false);
      return { ...outcome, dispatches: 1, zeroQueuedDispatches: true };
    });
    const realMaterialDir = process.env.SKU_REAL_ASSET_DIR || '/Users/shaozhuang/Downloads/SKU测试';
    if (['参考图.jpg', '白底1.jpg', '白底2.jpg'].every(name => fs.existsSync(path.join(realMaterialDir, name)))) {
      await check('realMaterialsImportAndForegroundPreflightOnly', async () => {
        const before = report.providerCalls.length;
        const messageBefore = await page.evaluate(() => __skuMessages.filter(message => message.type === 'GENERATE_IMAGE').length);
        await page.evaluate(() => {
          const api = __SZ_PROMPTLAB_TEST_API__;
          api.state.skuProducts = []; api.state.skuSelections = {}; api.state.skuTaskStatus = {}; api.state.skuResults = []; api.state.skuTemplate = ''; api.state.skuVisualLock = null; api.state.stopRequested = false;
          document.getElementById('skuAttrText').value = ''; document.getElementById('skuResolution').value = '1K'; document.getElementById('skuRatio').value = '1:1'; renderSkuWorkspace();
        });
        await (await page.$('#skuProductFiles')).uploadFile(path.join(realMaterialDir, '白底1.jpg'), path.join(realMaterialDir, '白底2.jpg'));
        await (await page.$('#skuTemplateFile')).uploadFile(path.join(realMaterialDir, '参考图.jpg'));
        await page.waitForFunction(() => __SZ_PROMPTLAB_TEST_API__.state.skuProducts.length === 2 && !!__SZ_PROMPTLAB_TEST_API__.state.skuTemplate);
        const authorizedRegion = await confirmRegion({ x: .032, y: .245, w: .627, h: .541 });
        assert.equal(authorizedRegion.available, true, 'Real template needs a visible region confirmation workflow');
        assert.equal(authorizedRegion.region.confirmed, true);
        assert.equal(authorizedRegion.overlayWithinImage, true, 'Confirmed real-material subject region must be drawn on the template');
        const result = await page.evaluate(async () => {
          const api = __SZ_PROMPTLAB_TEST_API__;
          const title = '90cm主图旗舰款52m³-长灯AI声控-漏气感应-【上门安装】';
          const input = document.getElementById('skuAttrText'); input.value = title + '\n' + title; input.dispatchEvent(new Event('input', { bubbles: true }));
          document.getElementById('skuBaseRightsConfirmed').checked = true; document.getElementById('skuBaseRightsConfirmed').dispatchEvent(new Event('change', { bubbles: true }));
          document.getElementById('skuResolution').value = 'custom'; document.getElementById('skuCustomWidth').value = '1000'; document.getElementById('skuCustomHeight').value = '1000'; document.getElementById('skuResolution').dispatchEvent(new Event('change', { bubbles: true }));
          async function decoded(url) { return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = url; }); }
          const baseImage = await decoded(api.state.skuTemplate);
          const subjects = [];
          const settings = api.skuGenerationSettings();
          for (const task of api.skuTaskBlueprints()) {
            const image = await decoded(task.item.url);
            const features = skuReplacementSubjectFeatureBundle(image);
            const geometry = await skuValidateLocalizedInputGeometry(api.state.skuTemplate, task.item.url, settings);
            const taskSettings = { ...geometry.settings, replicaBaseImage: api.state.skuTemplate, templateImage: api.state.skuTemplate, replacementSubjectImage: task.item.url };
            const contract = api.createSkuVisualLockContract(taskSettings, 'real-material-preflight-only');
            const backgroundGate = __SZ_PROMPTLAB_BACKGROUND_TEST_API__.validateSkuVisualLockPayload({ labMode: 'sku', detailMode: 'sku', assetRightsConfirmed: true,
              skuVisualLock: contract, skuVisualLockSignature: contract.contractFingerprint, skuVisualPhase: 'subject-replace',
              editBaseImage: api.state.skuTemplate, productImage: task.item.url, productImages: [task.item.url], referenceImage: '', referenceImages: [], modelImages: [], visualTemplateImages: [],
              inputRoleOrder: ['IMMUTABLE_SKU_BASE', 'REPLACEMENT_SUBJECT'], size: taskSettings.modelSize, ratio: taskSettings.modelRatio, resolution: taskSettings.modelResolution,
              outputSize: taskSettings.outputSize, outputRatio: taskSettings.outputRatio, outputResolution: taskSettings.outputResolution, count: 1 });
            subjects.push({ title: task.attr, filename: task.item.name, width: image.naturalWidth, height: image.naturalHeight,
              foreground: { width: features.width, height: features.height, pixels: features.mask.reduce((sum, value) => sum + (value ? 1 : 0), 0) }, geometryReady: geometry.ok,
              outputWidth: geometry.settings.outputWidth, outputHeight: geometry.settings.outputHeight, backgroundGateReady: backgroundGate.ok, backgroundGate });
          }
          return { template: { width: baseImage.naturalWidth, height: baseImage.naturalHeight }, subjects,
            tasks: api.skuTaskBlueprints().length, selected: api.selectedSkuTasks(false).length, preflight: document.getElementById('skuPreflight').textContent,
            plannedAuthorizedRegion: { x: .032, y: .245, w: .627, h: .541 }, generationButtonDisabled: document.getElementById('skuGenerateBtn').disabled };
        });
        assert.equal(result.tasks, 2); assert.equal(result.selected, 2);
        assert.equal(result.template.width, 1000); assert.equal(result.template.height, 1000);
        assert(result.subjects.every(item => item.geometryReady && item.backgroundGateReady && item.foreground.pixels > 100000), JSON.stringify(result.subjects));
        assert.equal(report.providerCalls.length, before);
        const messageAfter = await page.evaluate(() => __skuMessages.filter(message => message.type === 'GENERATE_IMAGE').length);
        assert.equal(messageAfter, messageBefore);
        await page.$eval('#skuPanel', element => element.scrollIntoView({ block: 'start' }));
        await outer.screenshot({ path: path.join(evidence, 'real-materials-two-sku-preflight.png'), fullPage: false });
        await page.$eval('#skuPreflight', element => element.scrollIntoView({ block: 'end' }));
        await outer.screenshot({ path: path.join(evidence, 'real-materials-two-sku-task-titles.png'), fullPage: false });
        return { ...result, authorizedRegion, zeroProviderCalls: true, zeroGenerationMessages: true, preflightOnly: true };
      });
    }
    report.messages = await page.evaluate(() => globalThis.__skuMessages || []);
    assert.equal(report.externalRequests.length, 0, 'Unexpected external network request');
    assert.equal(report.missingStaticAssets.length, 0, 'Candidate requested missing static assets');
    assert.equal(report.pageErrors.length, 0, 'Candidate raised browser page errors');
    report.passed = report.failures.length === 0;
  } catch (error) { report.fatalError = error.stack || String(error); }
  finally {
    report.finishedAt = new Date().toISOString();
    report.assetHashes = Object.fromEntries([...servedAssets.entries()].map(([name, bytes]) => [name, crypto.createHash('sha256').update(bytes).digest('hex')]));
    report.assetSources = Object.fromEntries([...servedAssets.keys()].map(name => [name, assetSources.get(path.join(publicRoot, name))]));
    for (const [name, bytes] of servedAssets) { const saved = path.join(evidence, 'assets', name); fs.mkdirSync(path.dirname(saved), { recursive: true }); fs.writeFileSync(saved, bytes); }
    report.resourceSnapshot = path.join(evidence, 'assets');
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ passed: report.passed, checks: Object.fromEntries(Object.entries(report.checks).map(([name, result]) => [name, result.passed])), failures: report.failures, fatalError: report.fatalError, report: path.join(evidence, 'report.json') }, null, 2));
  if (!report.passed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
