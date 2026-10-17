'use strict';

// Actual packed page, real DOM imports, original-image IndexedDB and real
// canvas/archive/download code. Only the HTTPS loopback server can be reached.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '..');
const publicRoot = path.join(root, 'public');
const overlay = process.env.SKU_STATIC_OVERLAY_ROOT || path.join(root, 'docs/uat-sku-workflow-20261012/production-overlay-v5/overlay/public');
const baseline = process.env.SKU_PRODUCTION_BASELINE_DIR || path.join(root, 'docs/uat-sku-workflow-20261012/production-baseline');
for (const directory of [overlay, baseline]) assert.ok(path.isAbsolute(directory) && fs.statSync(directory).isDirectory());
const runName = process.argv[2] || 'sku-durable-browser-v5';
assert.match(runName, /^[a-z0-9-]+$/);
const evidence = path.join(root, 'docs/uat-sku-workflow-20261012', runName);
fs.mkdirSync(evidence, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const owner = 'user:sku-fixture:durable-browser';
const title = '蓝色礼盒-离线持久回执验收';
const labPrefix = 'creative/labs/image-prompt-lab/';
const fields = ['version','receiptId','jobId','accountKey','workspaceKey','taskId','shotId','batchId','planSignatureHash'];
const exactIdentity = (a, b) => a && b && Object.keys(a).length === 9 && Object.keys(b).length === 9 && fields.every(key => a[key] === b[key]);
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

async function main() {
  const report = { schema: 'SKU_DURABLE_BROWSER_OFFLINE_V1', startedAt: new Date().toISOString(), passed: false,
    liveProviderSubmissions: 0, productionWrites: 0, checks: {}, failures: [], pageErrors: [], blockedExternalAttempts: [],
    proxyPosts: [], receiptGets: [], contentGets: [], apiRejects: [], servedAssets: {}, messages: [] };
  report.runnerSha256 = hash(fs.readFileSync(__filename));
  report.selectedOverlay = overlay; report.selectedBaseline = baseline;
  const assets = new Map(), sources = new Map(), served = new Set();
  function snapshot(directory, kind) {
    function walk(current) { for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, item.name);
      if (item.isDirectory()) { walk(file); continue; }
      if (!/\.(?:js|css|html)$/.test(item.name)) continue;
      let relative = path.relative(directory, file).split(path.sep).join('/');
      if (kind !== 'local-public') {
        if (relative.startsWith('public/')) relative = relative.slice(7);
        if (!relative.startsWith('creative/')) relative = labPrefix + relative;
        assert.ok(relative.startsWith(labPrefix) || kind === 'production-baseline' && relative === 'creative/web-chrome.js');
      }
      assets.set(relative, fs.readFileSync(file)); sources.set(relative, { kind, path: file });
    } }
    walk(directory);
  }
  snapshot(publicRoot, 'local-public'); snapshot(baseline, 'production-baseline'); snapshot(overlay, 'candidate-overlay');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-durable-browser-'));
  const certificate = path.join(profile, 'localhost.pem'), privateKey = path.join(profile, 'localhost.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', privateKey, '-out', certificate,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const receipts = new Map(); let origin, candidate, providerMode = 'complete';
  async function bytesOf(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return Buffer.concat(chunks); }
  function descriptor(entry, state = 'complete') {
    return { schema: 'SANJIE_IMAGE_RECEIPT_BYOK_V1', receipt: entry.identity, state, dispatchId: entry.dispatchId,
      resultSha256: hash(entry.image), images: state === 'complete'
        ? [origin + '/api/creative/image-receipts/' + entry.identity.receiptId + '/content/0?identity=' + encodeURIComponent(JSON.stringify(entry.identity))] : [] };
  }
  const server = https.createServer({ key: fs.readFileSync(privateKey), cert: fs.readFileSync(certificate) }, async (request, response) => {
    try {
      const url = new URL(request.url, origin || 'https://127.0.0.1');
      const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
      if (url.pathname === '/__sku-fixture') {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end('<!doctype html><iframe style="border:0;width:100vw;height:100vh" title="SKU" src="/creative/labs/image-prompt-lab/promptlab.html?source=web&mode=sku"></iframe>'); return;
      }
      if (url.pathname === '/api/auth/me') return json(200, { data: { tenantId: 'sku-fixture', username: 'durable-browser', creativeEntitlement: { allowed: true } } });
      if (url.pathname === '/api/creative/quote') return json(200, { data: { available: false, reason: 'Offline BYOK fixture' } });
      if (url.pathname === '/api/creative/proxy') {
        assert.equal(request.method, 'POST');
        const raw = await bytesOf(request);
        const webRequest = new Request(origin + request.url, { method: 'POST', headers: request.headers, body: raw });
        const form = await webRequest.formData();
        assert.equal(form.get('__sz_url'), 'https://sku-provider.fixture.invalid/v1/images/edits');
        const identity = JSON.parse(form.get('__sz_image_receipt'));
        assert.equal(Object.keys(identity).length, 9); assert.equal(identity.accountKey, owner);
        assert.match(identity.receiptId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
        const headers = JSON.parse(form.get('__sz_headers'));
        const images = [];
        for (const [name, value] of form.entries()) if (value && typeof value.arrayBuffer === 'function') {
          const bytes = Buffer.from(await value.arrayBuffer()), dimensions = await require('sharp')(bytes).metadata();
          images.push({ field: name, name: value.name, type: value.type, bytes: bytes.length, sha256: hash(bytes), width: dimensions.width, height: dimensions.height });
        }
        const entry = { identity, dispatchId: randomUUID(), image: Buffer.from(candidate.split(',')[1], 'base64') };
        receipts.set(identity.receiptId, entry);
        report.proxyPosts.push({ identity, mode: providerMode, model: form.get('model'), size: form.get('size'), imageParts: images,
          idempotencyKey: headers['Idempotency-Key'] || headers['idempotency-key'], secretHeaderSyntheticOnly: /SYNTHETIC/.test(headers.Authorization || '') });
        return json(200, descriptor(entry, providerMode === 'complete' ? 'complete' : 'pending'));
      }
      const receiptRoute = /^\/api\/creative\/image-receipts\/([a-f0-9-]+)(\/content\/0)?$/.exec(url.pathname);
      if (receiptRoute) {
        const entry = receipts.get(receiptRoute[1]), identity = JSON.parse(url.searchParams.get('identity') || 'null');
        if (!entry || !exactIdentity(identity, entry.identity) || [...url.searchParams.keys()].length !== 1) return json(404, { code: 'FIXTURE_IDENTITY_MISMATCH' });
        assert.equal(request.method, 'GET');
        if (receiptRoute[2]) {
          report.contentGets.push({ identity }); response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); response.end(entry.image); return;
        }
        report.receiptGets.push({ identity }); return json(200, descriptor(entry));
      }
      if (url.pathname.startsWith('/api/')) { report.apiRejects.push({ path: url.pathname, method: request.method }); return json(503, { ok: false, error: 'Offline fixture blocks this API' }); }
      const relative = decodeURIComponent(url.pathname).replace(/^\//, ''), bytes = assets.get(relative);
      if (!bytes) { response.writeHead(404).end(); return; }
      served.add(relative); response.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(relative)], 'Cache-Control': 'no-store' }); response.end(bytes);
    } catch (error) { report.failures.push({ layer: 'loopback-fixture', error: error.message }); response.writeHead(500).end('Offline fixture rejected request'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'https://127.0.0.1:' + server.address().port;
  let browser, outer, page;
  async function openPage() {
    const result = await browser.newPage(); await result.setViewport({ width: 1440, height: 1180, deviceScaleFactor: 1 });
    result.on('pageerror', error => report.pageErrors.push(error.message));
    await result.setRequestInterception(true);
    result.on('request', request => {
      if (request.url().startsWith(origin + '/') || /^(data|blob):/.test(request.url())) return request.continue();
      report.blockedExternalAttempts.push(request.url()); return request.abort('blockedbyclient');
    });
    await result.evaluateOnNewDocument(() => { globalThis.__SANJIE_ENVIRONMENT = 'sku-durable-browser-offline'; });
    await result.goto(origin + '/__sku-fixture', { waitUntil: 'load' });
    const frame = await (await result.$('iframe')).contentFrame();
    await frame.waitForFunction(() => document.documentElement.dataset.labStartup === 'ready' && typeof state !== 'undefined' && !pendingProviderProfile && !configWalletSwitchPending, { timeout: 15000 });
    await frame.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime); globalThis.__durableMessages = [];
      chrome.runtime.sendMessage = (message, callback) => original(message, response => {
        __durableMessages.push({ type: message.type, jobId: message.jobId, receiptIdentity: message.receiptIdentity,
          response: response && { ok: response.ok, code: response.code, noSubmission: response.noSubmission, providerSubmitted: response.providerSubmitted,
            definitiveFailure: response.definitiveFailure, stateUncertain: response.stateUncertain, receiptIdentity: response.receiptIdentity } });
        if (callback) callback(response);
      });
    });
    return { outer: result, page: frame };
  }
  const check = async (name, work) => {
    try { const value = await work(); report.checks[name] = { passed: true, ...value }; }
    catch (error) { report.checks[name] = { passed: false, error: error.message }; report.failures.push({ name, error: error.message }); throw error; }
  };
  try {
    browser = await puppeteer.launch({ headless: true, userDataDir: profile, args: ['--ignore-certificate-errors'] });
    ({ outer, page } = await openPage());
    report.browserVersion = await browser.version(); report.isolatedProfile = true; report.productTestMode = false;
    await check('packedBootstrapAndCapability', async () => {
      const value = await page.evaluate(async () => ({ owner: state.archiveAccountKey, cryptoSecure: isSecureContext,
        helper: !!SZ_SKU_DURABLE_RECEIPT, sendOverrideAbsent: promptLabTestSend === null,
        capability: await sendRuntime('GET_SKU_RECEIPT_CAPABILITY', {}) }));
      assert.equal(value.owner, owner); assert.equal(value.cryptoSecure, true); assert.equal(value.helper, true);
      assert.equal(value.sendOverrideAbsent, true); assert.equal(value.capability.supported, true);
      for (const name of ['promptlab.html', 'promptlab.js', 'studio-runtime-20261010-credit-v3.js', 'sku-durable-receipt.js']) {
        assert.equal(sources.get(labPrefix + name).kind, 'candidate-overlay'); assert.ok(served.has(labPrefix + name));
      }
      assert.equal(sources.get('creative/web-chrome.js').kind, 'production-baseline');
      return value;
    });
    const fixtures = await page.evaluate(() => {
      function png(size, draw) { const c = document.createElement('canvas'); c.width = c.height = size; draw(c.getContext('2d'), size); return c.toDataURL('image/png'); }
      function base(ctx, size, color) {
        ctx.scale(size / 1024, size / 1024); ctx.fillStyle = '#f5e9d7'; ctx.fillRect(0, 0, 1024, 1024);
        ctx.fillStyle = '#0f766e'; ctx.fillRect(54, 46, 916, 154); ctx.fillStyle = '#fff7ed'; ctx.fillRect(76, 68, 620, 110);
        ctx.fillStyle = '#172554'; ctx.font = 'bold 38px sans-serif'; ctx.fillText('LOCKED ORIGINAL COPY', 102, 138);
        ctx.fillStyle = '#d6b98c'; ctx.fillRect(80, 820, 864, 116); ctx.fillStyle = '#7c3f1d'; ctx.fillRect(106, 850, 210, 54);
        ctx.fillStyle = '#1d4d42'; ctx.beginPath(); ctx.arc(860, 870, 44, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = color; ctx.fillRect(354, 302, 316, 410);
      }
      return { base: png(1000, (ctx, size) => base(ctx, size, '#b91c1c')),
        subject: png(800, (ctx, size) => { ctx.scale(size / 1024, size / 1024); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1024, 1024); ctx.fillStyle = '#1d4ed8'; ctx.fillRect(270, 190, 484, 644); }),
        candidate: png(1024, (ctx, size) => base(ctx, size, '#1d4ed8')) };
    });
    candidate = fixtures.candidate;
    const fixtureDirectory = path.join(evidence, 'fixtures'); fs.mkdirSync(fixtureDirectory, { recursive: true });
    const baseFile = path.join(fixtureDirectory, '模板.png'), subjectFile = path.join(fixtureDirectory, '白底.png');
    fs.writeFileSync(baseFile, Buffer.from(fixtures.base.split(',')[1], 'base64')); fs.writeFileSync(subjectFile, Buffer.from(fixtures.subject.split(',')[1], 'base64'));
    await (await page.$('#skuTemplateFile')).uploadFile(baseFile); await (await page.$('#skuProductFiles')).uploadFile(subjectFile);
    await page.waitForFunction(() => state.skuProducts.length === 1 && !!state.skuTemplate && imageUploadReads === 0);
    await page.select('#skuResolution', 'custom');
    await page.evaluate(title => {
      for (const [id, value] of [['skuCustomWidth', '1000'], ['skuCustomHeight', '1000'], ['skuAttrText', title]]) {
        const input = document.getElementById(id); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, title);
    await page.click('#skuBaseRightsConfirmed');
    await page.click('#skuRegionEditBtn');
    await page.evaluate(() => { for (const [suffix, value] of [['X', 12], ['Y', 18], ['W', 76], ['H', 72]]) {
      const input = document.getElementById('skuRegion' + suffix); input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true }));
    } });
    await page.click('#skuRegionConfirmBtn');
    await check('realDomFileImportsAndOriginals', async () => {
      const value = await page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => { const q = indexedDB.open('sz_image_upload_originals_v1:environment:sku-durable-browser-offline'); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
        const originals = await new Promise((resolve, reject) => { const q = db.transaction('originals').objectStore('originals').getAll(); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); }); db.close();
        return { count: originals.length, originals: await Promise.all(originals.map(async raw => ({ owner: raw.accountKey, hash: raw.hash,
          actualBlobSha: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await raw.blob.arrayBuffer()))).map(b => b.toString(16).padStart(2, '0')).join(''), bytes: raw.bytes }))),
          preflight: document.getElementById('skuPreflight').textContent, region: SZ_SKU_REGION.get(), title: skuTaskBlueprints()[0].attr };
      });
      assert.equal(value.count, 2); assert.ok(value.originals.every(item => item.owner === owner && item.hash === item.actualBlobSha));
      assert.equal(value.title, title); assert.equal(value.region.confirmed, true); assert.equal(report.proxyPosts.length, 0);
      assert.match(value.preflight, /预检通过/); return value;
    });
    await page.evaluate(() => openConfigModal()); await page.waitForSelector('#configModal:not([hidden])');
    await page.select('#provider', 'openai-compatible');
    await page.waitForFunction(() => !pendingProviderProfile && !configWalletSwitchPending && configApiKey.provider === document.getElementById('provider').value);
    await page.select('#imageAdapter', 'openai-images');
    await page.evaluate(() => { document.getElementById('imageEndpoint').value = 'https://sku-provider.fixture.invalid/v1/images/edits'; document.getElementById('imageModel').value = 'gpt-image-2'; });
    await page.click('#editApiKeyBtn'); await page.type('#apiKey', 'SYNTHETIC-NOT-A-CREDENTIAL');
    assert.equal(await page.evaluate(() => acceptedConfigApiKey(document.getElementById('provider').value) === 'SYNTHETIC-NOT-A-CREDENTIAL'), true);
    await page.click('#configCloseBtn');
    await page.click('#skuGenerateBtn');
    await page.waitForFunction(() => !state.skuActive && Object.values(state.skuTaskStatus).some(row => ['success','failed','processing_failed','uncertain'].includes(row.state)), { timeout: 30000 });
    await page.evaluate(async () => { await state.archiveWriteQueue; });
    await check('actualOpenAiMultipartReceiptAndArchive', async () => {
      const value = await page.evaluate(async () => ({ statuses: state.skuTaskStatus,
        results: state.skuResults.map(item => ({ width: item.outputWidth, height: item.outputHeight, title: item.skuTitle, jobId: item.jobId,
          resultId: item.resultId, archiveBatchId: item.archiveBatchId, archiveAssetId: item.archiveAssetId, identity: item.skuDurableReceiptIdentity })),
        archive: (await SZ_IMAGE_ARCHIVE.list(state.archiveAccountKey, { skipPurge: true })).map(batch => ({ id: batch.archiveBatchId, assets: batch.assets.length })) }));
      const journal = await page.evaluate(async receiptId => {
        const db = await new Promise(resolve => { const q = indexedDB.open('sz_sku_durable_receipt_v1:environment:sku-durable-browser-offline'); q.onsuccess = () => resolve(q.result); });
        const entries = await new Promise(resolve => { const q = db.transaction('entries').objectStore('entries').getAll(); q.onsuccess = () => resolve(q.result); }); db.close();
        const entry = entries.find(row => row.identity?.receiptId === receiptId);
        return entry && { identity: entry.identity, plan: entry.plan, state: entry.state };
      }, report.proxyPosts[0]?.identity.receiptId);
      assert.equal(report.proxyPosts.length, 1, JSON.stringify(value.statuses)); assert.equal(report.proxyPosts[0].imageParts.length, 2);
      assert.equal(report.proxyPosts[0].idempotencyKey, report.proxyPosts[0].identity.receiptId);
      assert.ok(journal); assert.ok(exactIdentity(journal.identity, report.proxyPosts[0].identity));
      assert.equal(hash(canonical(journal.plan)), journal.identity.planSignatureHash);
      assert.equal(journal.plan.accountKey, owner); assert.equal(journal.plan.model.imageModel, 'gpt-image-2');
      assert.equal(journal.plan.providerInputs.baseSha256, report.proxyPosts[0].imageParts[0].sha256);
      assert.equal(journal.plan.providerInputs.subjectSha256, report.proxyPosts[0].imageParts[1].sha256);
      assert.equal(journal.plan.output.size, '1000*1000'); assert.equal(journal.plan.output.resolution, 'custom');
      assert.deepEqual(journal.plan.contract.subject.authorizedRegion, report.checks.realDomFileImportsAndOriginals.region);
      assert.ok(Object.values(journal.plan.sources).every(source => source.assetId.startsWith(owner + ':') && report.checks.realDomFileImportsAndOriginals.originals.some(original => original.actualBlobSha === source.originalSha256)));
      assert.equal(journal.state, 'acknowledged');
      assert.equal(value.results.length, 1, JSON.stringify(value.statuses)); assert.equal(value.results[0].width, 1000); assert.equal(value.results[0].height, 1000);
      assert.equal(value.results[0].title, title); assert.equal(value.results[0].jobId, report.proxyPosts[0].identity.jobId);
      assert.ok(value.results[0].archiveAssetId); assert.equal(value.archive.reduce((sum, batch) => sum + batch.assets, 0), 1);
      return { ...value, journal };
    });
    await outer.screenshot({ path: path.join(evidence, 'first-result.png'), fullPage: true });
    await check('unknownReloadAndGetOnlyOriginalRecovery', async () => {
      providerMode = 'unknown';
      await page.click('#skuSelectAllBtn'); await page.click('#skuGenerateBtn');
      await page.waitForFunction(() => !state.skuActive && Object.values(state.skuTaskStatus).some(row => row.state === 'uncertain'), { timeout: 30000 });
      assert.equal(report.proxyPosts.length, 2);
      const original = report.proxyPosts[1].identity;
      const frozen = await page.evaluate(async identity => {
        const status = Object.values(state.skuTaskStatus).find(row => row.jobId === identity.jobId), pointer = status._skuRecovery;
        const entry = await SZ_SKU_DURABLE_RECEIPT.read(pointer.owner, pointer.key);
        const prefix = 'sz.legacy-image-receipt.v1:' + encodeURIComponent(state.archiveAccountKey) + ':';
        const old = [
          [prefix + 'legacy-known-one', JSON.stringify({ version: 1, state: 'uncertain', jobId: 'job_1791824581525_774923246bf7e' })],
          [prefix + 'legacy-known-two', JSON.stringify({ version: 1, state: 'uncertain', jobId: 'job_1791824581874_8095a58ffa5c3' })]
        ];
        for (const [key, value] of old) localStorage.setItem(key, value);
        return { pointer, outputSize: entry.snapshot.output.size, title: entry.snapshot.metadata.title, region: entry.snapshot.contract.subject.authorizedRegion,
          baseSource: entry.snapshot.baseImage, subjectSource: entry.snapshot.subjectImage, old, oldResultCount: state.skuResults.length };
      }, original);
      assert.equal(frozen.outputSize, '1000*1000'); assert.equal(frozen.oldResultCount, 1);
      await outer.screenshot({ path: path.join(evidence, 'unknown-original-receipt.png'), fullPage: true });
      await outer.close(); ({ outer, page } = await openPage());
      await page.waitForFunction(receiptId => Object.values(state.skuTaskStatus).some(row => row._skuRecovery?.receiptId === receiptId), { timeout: 15000 }, original.receiptId);
      assert.equal(report.proxyPosts.length, 2, 'normal page reload must not POST');
      const restored = await page.evaluate(identity => ({ rows: skuTaskBlueprints().map(task => ({ title: task.attr, status: skuTaskStatusFor(task.skuId).state,
        receiptId: skuTaskStatusFor(task.skuId)._skuRecovery?.receiptId, selected: !!state.skuSelections[task.skuId] })),
        old: ['legacy-known-one', 'legacy-known-two'].map(suffix => localStorage.getItem('sz.legacy-image-receipt.v1:' + encodeURIComponent(state.archiveAccountKey) + ':' + suffix)) }), original);
      const row = restored.rows.find(row => row.receiptId === original.receiptId);
      assert.ok(row); assert.equal(row.title, title); assert.equal(row.selected, false);
      assert.deepEqual(restored.old, frozen.old.map(item => item[1]));
      const buttons = await page.$$('button'); let reconcile;
      for (const button of buttons) if (await button.evaluate(element => element.textContent.trim() === '核对原回执')) { reconcile = button; break; }
      assert.ok(reconcile, 'actual row must expose the original-receipt button'); await reconcile.click();
      await page.waitForFunction(jobId => !state.skuActive && state.skuResults.some(item => item.jobId === jobId && item.archiveAssetId), { timeout: 30000 }, original.jobId);
      await page.evaluate(async () => { await state.archiveWriteQueue; });
      const recovered = await page.evaluate(async identity => {
        const result = state.skuResults.find(item => item.jobId === identity.jobId), batches = await SZ_IMAGE_ARCHIVE.list(state.archiveAccountKey, { skipPurge: true });
        return { width: result.outputWidth, height: result.outputHeight, title: result.skuTitle, jobId: result.jobId, resultId: result.resultId,
          identity: result.skuDurableReceiptIdentity, region: result.skuVisualLock.subject.authorizedRegion,
          archiveAssetId: result.archiveAssetId, archiveCount: batches.reduce((sum, batch) => sum + batch.assets.length, 0),
          acknowledged: (await SZ_SKU_DURABLE_RECEIPT.read(state.archiveAccountKey, Object.keys(state._skuDurableSeen).find(key => state._skuDurableSeen[key] === identity.receiptId))).state };
      }, original);
      assert.equal(report.proxyPosts.length, 2); assert.equal(report.receiptGets.length, 1);
      assert.ok(exactIdentity(report.receiptGets[0].identity, original)); assert.ok(exactIdentity(recovered.identity, original));
      assert.equal(recovered.width, 1000); assert.equal(recovered.height, 1000); assert.equal(recovered.title, title);
      assert.equal(recovered.resultId, original.jobId + ':1'); assert.deepEqual(recovered.region, frozen.region);
      assert.equal(recovered.acknowledged, 'acknowledged'); assert.equal(recovered.archiveCount, 2);
      report.frozenRecoveredSources = { baseSourceSha256: hash(frozen.baseSource), subjectSourceSha256: hash(frozen.subjectSource) };
      await outer.screenshot({ path: path.join(evidence, 'reloaded-get-recovered.png'), fullPage: true });
      return { originalIdentity: original, restoredRows: restored.rows, recovered, legacyFixtureMarkersUnchanged: true, recoveryProxyPosts: 0 };
    });
    await check('realJpegOutsideTemplateAndBusinessFilename', async () => {
      const identity = report.proxyPosts[1].identity;
      const pixels = await page.evaluate(async identity => {
        const key = Object.keys(state._skuDurableSeen).find(key => state._skuDurableSeen[key] === identity.receiptId);
        const original = await SZ_SKU_DURABLE_RECEIPT.read(state.archiveAccountKey, key);
        const item = state.skuResults.find(row => row.jobId === identity.jobId), current = await skuCanvasImage(item.url), base = await skuCanvasImage(original.snapshot.baseImage);
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1000; const ctx = canvas.getContext('2d');
        const points = [[40, 40], [850, 100], [100, 870], [930, 850]];
        function samples(image) { ctx.clearRect(0, 0, 1000, 1000); ctx.drawImage(image, 0, 0, 1000, 1000); return points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]); }
        const a = samples(current), b = samples(base);
        const region = original.snapshot.contract.subject.authorizedRegion;
        return { width: current.naturalWidth, height: current.naturalHeight, mime: item.url.slice(0, 23), points, region,
          allPointsStrictlyOutside: points.every(([x, y]) => x / 1000 < region.x || x / 1000 > region.x + region.w || y / 1000 < region.y || y / 1000 > region.y + region.h),
          outputPixels: a, templatePixels: b, maxDifference: Math.max(...a.flatMap((row, index) => row.slice(0, 3).map((value, channel) => Math.abs(value - b[index][channel])))) };
      }, identity);
      assert.equal(pixels.width, 1000); assert.equal(pixels.height, 1000); assert.match(pixels.mime, /^data:image\/jpeg/);
      assert.equal(pixels.allPointsStrictlyOutside, true);
      assert.ok(pixels.maxDifference <= 7, 'solid template landmarks outside the subject must survive JPEG encoding: ' + JSON.stringify(pixels));
      const downloadDirectory = path.join(evidence, 'downloads'); fs.mkdirSync(downloadDirectory, { recursive: true });
      const cdp = await outer.createCDPSession(); await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory });
      await page.click('#skuDownloadAllBtn');
      const deadline = Date.now() + 15000;
      let files = [];
      while (Date.now() < deadline) { files = fs.readdirSync(downloadDirectory).filter(name => name.endsWith('.jpg')); if (files.length) break; await new Promise(resolve => setTimeout(resolve, 100)); }
      assert.ok(files.length); assert.ok(files.every(name => name === title + '.jpg' || new RegExp('^' + title + '-[0-9]+\\.jpg$').test(name)), JSON.stringify(files));
      const outputs = [];
      for (const name of files) { const bytes = fs.readFileSync(path.join(downloadDirectory, name)), size = await require('sharp')(bytes).metadata();
        assert.equal(size.format, 'jpeg'); assert.equal(size.width, 1000); assert.equal(size.height, 1000); outputs.push({ name, sha256: hash(bytes), width: size.width, height: size.height, bytes: bytes.length }); }
      return { pixels, downloads: outputs, pixelScope: 'Four solid landmarks strictly outside the confirmed subject rectangle, JPEG channel tolerance <=7; not a claim of every-pixel byte equality.' };
    });
    await check('actualRuntimeNoSubmissionProofAndOldLegacyProtection', async () => {
      const before = report.proxyPosts.length;
      // A recovered row retains the old immutable sources for reconciliation.
      // A new explicit attempt still needs the normal current-page DOM gates.
      await (await page.$('#skuTemplateFile')).uploadFile(baseFile);
      await page.waitForFunction(() => !!state.skuTemplate && imageUploadReads === 0);
      await page.select('#skuResolution', 'custom');
      await page.evaluate(() => {
        for (const [id, value] of [['skuCustomWidth', '1000'], ['skuCustomHeight', '1000']]) {
          const input = document.getElementById(id); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      if (!await page.$eval('#skuBaseRightsConfirmed', element => element.checked)) await page.click('#skuBaseRightsConfirmed');
      await page.click('#skuRegionEditBtn');
      await page.evaluate(() => { for (const [suffix, value] of [['X', 12], ['Y', 18], ['W', 76], ['H', 72]]) {
        const input = document.getElementById('skuRegion' + suffix); input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true }));
      } });
      await page.click('#skuRegionConfirmBtn');
      await page.evaluate(() => openConfigModal()); await page.waitForSelector('#configModal:not([hidden])');
      await page.select('#provider', 'openai-compatible');
      await page.waitForFunction(() => !pendingProviderProfile && !configWalletSwitchPending && configApiKey.provider === document.getElementById('provider').value);
      await page.select('#imageAdapter', 'generic-json');
      await page.evaluate(() => { document.getElementById('imageEndpoint').value = 'https://sku-provider.fixture.invalid/images'; document.getElementById('imageModel').value = 'fixture-unsupported'; });
      await page.click('#editApiKeyBtn'); await page.type('#apiKey', 'SYNTHETIC-NOT-A-CREDENTIAL'); await page.click('#configCloseBtn');
      await page.click('#skuSelectAllBtn'); await page.click('#skuGenerateBtn');
      await page.waitForFunction(() => !state.skuActive && Object.values(state.skuTaskStatus).some(row => row.code === 'SKU_RECEIPT_MODEL_UNSUPPORTED'), { timeout: 30000 });
      const value = await page.evaluate(async () => {
        const failure = Object.values(state.skuTaskStatus).find(row => row.code === 'SKU_RECEIPT_MODEL_UNSUPPORTED'), audit = await SZ_SKU_DURABLE_RECEIPT.readAudit(state.archiveAccountKey, failure.receiptIdentity.receiptId);
        const db = await new Promise(resolve => { const q = indexedDB.open('sz_sku_durable_receipt_v1:environment:sku-durable-browser-offline'); q.onsuccess = () => resolve(q.result); });
        const records = await new Promise(resolve => { const q = db.transaction('entries').objectStore('entries').getAll(); q.onsuccess = () => resolve(q.result); }); db.close();
        const knownJobs = ['job_1791824581525_774923246bf7e', 'job_1791824581874_8095a58ffa5c3'];
        return { failure: { code: failure.code, noSubmission: failure.noSubmission, providerSubmitted: failure.providerSubmitted,
          definitiveFailure: failure.definitiveFailure, stateUncertain: failure.stateUncertain, receiptIdentity: failure.receiptIdentity },
          audit: { state: audit.state, identity: audit.identity, reason: audit.reason },
          legacyReceivedNoDtos: records.every(row => !knownJobs.includes(row.identity?.jobId)),
          oldMarkers: ['legacy-known-one', 'legacy-known-two'].map(suffix => JSON.parse(localStorage.getItem('sz.legacy-image-receipt.v1:' + encodeURIComponent(state.archiveAccountKey) + ':' + suffix))) };
      });
      assert.equal(report.proxyPosts.length, before); assert.equal(value.failure.noSubmission, true); assert.equal(value.failure.providerSubmitted, false);
      assert.equal(value.failure.definitiveFailure, true); assert.equal(value.failure.stateUncertain, false);
      assert.equal(value.audit.state, 'not-submitted'); assert.ok(exactIdentity(value.audit.identity, value.failure.receiptIdentity));
      assert.equal(value.legacyReceivedNoDtos, true); assert.ok(value.oldMarkers.every(marker => !marker.receiptId));
      return { ...value, additionalProxyPosts: 0 };
    });
  } catch (error) {
    report.failures.push({ layer: 'browser-run', error: error.message });
    if (page) { try { report.lastState = await page.evaluate(() => ({ owner: typeof state !== 'undefined' && state.archiveAccountKey,
      startup: document.documentElement.dataset.labStartup, status: typeof state !== 'undefined' && state.skuTaskStatus,
      preflight: document.getElementById('skuPreflight')?.textContent, messages: globalThis.__durableMessages || [],
      archiveState: document.getElementById('archiveState')?.textContent, archiveFailureCount: state.archiveFailureCount,
      results: state.skuResults.map(item => ({ jobId: item.jobId, resultId: item.resultId, archiveAssetId: item.archiveAssetId,
        outputSize: item.outputSize, outputWidth: item.outputWidth, outputHeight: item.outputHeight,
        providerSize: item.providerSize, providerRatio: item.providerRatio, providerResolution: item.providerResolution,
        resolution: item.resolution, title: item.skuTitle, identity: item.skuDurableReceiptIdentity })),
      skuActive: state.skuActive, restoring: state._skuDurableRestoring, seen: state._skuDurableSeen,
      environment: globalThis.__SANJIE_ENVIRONMENT,
      markers: Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter(key => key.startsWith('sz.legacy-image-receipt.v1:')).map(key => ({ key, value: localStorage.getItem(key) })) })); } catch (_) {} }
    if (outer) { try { await outer.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }); } catch (_) {} }
  } finally {
    if (page) { try { report.messages = await page.evaluate(() => globalThis.__durableMessages || []); } catch (_) {} }
    for (const relative of served) report.servedAssets[relative] = { sha256: hash(assets.get(relative)), source: sources.get(relative),
      unchangedOnDiskAfterRun: hash(fs.readFileSync(sources.get(relative).path)) === hash(assets.get(relative)) };
    report.bytesStableDuringRun = Object.values(report.servedAssets).every(asset => asset.unchangedOnDiskAfterRun) && hash(fs.readFileSync(__filename)) === report.runnerSha256;
    if (!report.bytesStableDuringRun) report.failures.push({ layer: 'source-pins', error: 'Served source or runner bytes changed during execution' });
    report.passed = !report.failures.length && !report.pageErrors.length && !report.blockedExternalAttempts.length;
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
    console.log(JSON.stringify({ passed: report.passed, checks: Object.keys(report.checks).length, failures: report.failures,
      pageErrors: report.pageErrors, blockedExternalAttempts: report.blockedExternalAttempts, proxyPosts: report.proxyPosts.length,
      receiptGets: report.receiptGets.length, report: path.join(evidence, 'report.json') }));
    if (!report.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
