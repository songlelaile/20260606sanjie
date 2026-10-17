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
const overlay = process.env.SKU_STATIC_OVERLAY_ROOT || path.join(root, 'docs/uat-sku-workflow-20261012/production-overlay-v8/overlay/public');
const baseline = process.env.SKU_PRODUCTION_BASELINE_DIR || path.join(root, 'docs/uat-sku-workflow-20261012/production-baseline');
for (const directory of [overlay, baseline]) assert.ok(path.isAbsolute(directory) && fs.statSync(directory).isDirectory());
const runName = process.argv[2] || 'sku-paid-workspace-browser-v8';
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
  const report = { schema: 'SKU_PAID_WORKSPACE_BROWSER_OFFLINE_V1', startedAt: new Date().toISOString(), passed: false,
    liveProviderSubmissions: 0, productionWrites: 0, checks: {}, failures: [], pageErrors: [], blockedExternalAttempts: [],
    proxyPosts: [], receiptGets: [], contentGets: [], apiRejects: [], servedAssets: {}, messages: [], dialogs: [] };
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
    result.on('dialog', async dialog => { report.dialogs.push({ type: dialog.type(), message: dialog.message() }); await dialog.accept(); });
    await result.setRequestInterception(true);
    result.on('request', request => {
      if (request.url().startsWith(origin + '/') || /^(data|blob):/.test(request.url())) return request.continue();
      report.blockedExternalAttempts.push(request.url()); return request.abort('blockedbyclient');
    });
    await result.evaluateOnNewDocument(() => { globalThis.__SANJIE_ENVIRONMENT = 'sku-paid-workspace-browser-offline'; });
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
        subject2: png(800, (ctx, size) => { ctx.scale(size / 1024, size / 1024); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1024, 1024); ctx.fillStyle = '#1d4ed8'; ctx.fillRect(274, 190, 484, 644); }),
        subject: png(800, (ctx, size) => { ctx.scale(size / 1024, size / 1024); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1024, 1024); ctx.fillStyle = '#1d4ed8'; ctx.fillRect(270, 190, 484, 644); }),
        candidate: png(1024, (ctx, size) => base(ctx, size, '#1d4ed8')) };
    });
    candidate = fixtures.candidate;
    const fixtureDirectory = path.join(evidence, 'fixtures'); fs.mkdirSync(fixtureDirectory, { recursive: true });
    const baseFile = path.join(fixtureDirectory, '模板.png'), subjectFile = path.join(fixtureDirectory, '白底.png'), subject2File = path.join(fixtureDirectory, '白底2.png');
    fs.writeFileSync(baseFile, Buffer.from(fixtures.base.split(',')[1], 'base64')); fs.writeFileSync(subjectFile, Buffer.from(fixtures.subject.split(',')[1], 'base64')); fs.writeFileSync(subject2File, Buffer.from(fixtures.subject2.split(',')[1], 'base64'));
    await (await page.$('#skuTemplateFile')).uploadFile(baseFile); await (await page.$('#skuProductFiles')).uploadFile(subjectFile, subject2File);
    await page.waitForFunction(() => state.skuProducts.length === 2 && !!state.skuTemplate && imageUploadReads === 0);
    await page.select('#skuResolution', 'custom');
    await page.evaluate(title => {
      for (const [id, value] of [['skuCustomWidth', '1000'], ['skuCustomHeight', '1000'], ['skuAttrText', title + '\n' + title]]) {
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
        const db = await new Promise((resolve, reject) => { const q = indexedDB.open('sz_image_upload_originals_v1:environment:sku-paid-workspace-browser-offline'); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
        const originals = await new Promise((resolve, reject) => { const q = db.transaction('originals').objectStore('originals').getAll(); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); }); db.close();
        return { count: originals.length, originals: await Promise.all(originals.map(async raw => ({ owner: raw.accountKey, hash: raw.hash,
          actualBlobSha: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await raw.blob.arrayBuffer()))).map(b => b.toString(16).padStart(2, '0')).join(''), bytes: raw.bytes }))),
          preflight: document.getElementById('skuPreflight').textContent, region: SZ_SKU_REGION.get(), title: skuTaskBlueprints()[0].attr };
      });
      assert.equal(value.count, 3); assert.ok(value.originals.every(item => item.owner === owner && item.hash === item.actualBlobSha));
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
    let parents, paidAuth, paidIdentities;
    await check('defaultOldLegacyProtection', async () => {
      // Storage fixture only: canonical keys are derived by the actual product
      // descriptor from real imported/localized files, not fabricated requests.
      parents = await page.evaluate(async () => {
        const prefix = 'sz.legacy-image-receipt.v1:' + encodeURIComponent(state.archiveAccountKey) + ':';
        const get = Storage.prototype.getItem, seeded = [], jobs = ['job_1791824581525_774923246bf7e','job_1791824581874_8095a58ffa5c3'];
        Storage.prototype.getItem = function (key) {
          let value = get.call(this, key);
          if (this === localStorage && value === null && key.startsWith(prefix) && /^[a-f0-9]{64}$/.test(key.slice(prefix.length)) && seeded.length < 2) {
            value = JSON.stringify({ version: 1, state: 'uncertain', jobId: jobs[seeded.length], createdAt: 1791824581525 + seeded.length, code: 'IMAGE_RECEIPT_UNCONFIRMED', taskId: '' });
            localStorage.setItem(key, value); seeded.push({ key, raw: value, jobId: jobs[seeded.length] });
          }
          return value;
        };
        try {
          const settings = skuGenerationSettings();
          const descriptions = await Promise.all(skuTaskBlueprints().map(task => skuPaidTaskDescriptor(task, settings)));
          return descriptions.map(description => ({ ...description.parent, sourceSkuId: description.task.metadata.skuId }));
        } finally { Storage.prototype.getItem = get; }
      });
      assert.equal(parents.length, 2); assert.equal(new Set(parents.map(parent => parent.key)).size, 2);
      await page.click('#skuGenerateBtn');
      await page.waitForFunction(() => !state.skuActive && Object.values(state.skuTaskStatus).filter(row => row.state === 'uncertain').length === 2, { timeout: 30000 });
      assert.equal(report.proxyPosts.length, 0); assert.equal(report.receiptGets.length, 0);
      const value = await page.evaluate(async parents => ({ oldRows: parents.map(parent => ({ skuId: parent.sourceSkuId, status: state.skuTaskStatus[parent.sourceSkuId] })),
        markersUnchanged: parents.every(parent => localStorage.getItem(parent.key) === parent.raw),
        active: await SZ_SKU_DURABLE_RECEIPT.readActivePaidWorkspace(state.archiveAccountKey) }), parents);
      assert.equal(value.markersUnchanged, true); assert.equal(value.active, null);
      assert.ok(value.oldRows.every(row => row.status.state === 'uncertain' && parents.some(parent => parent.jobId === row.status.jobId)));
      return { ...value, canonicalLegacyMarkerFixture: true, providerPosts: 0, fabricatedOldDtos: 0 };
    });
    await check('explicitTrustedPaidWorkspaceOnly', async () => {
      await page.evaluate(() => document.getElementById('skuNewPaidBatchBtn').click());
      await page.waitForFunction(() => !state._skuPaidAuthorizing);
      assert.equal(await page.evaluate(() => SZ_SKU_DURABLE_RECEIPT.readActivePaidWorkspace(state.archiveAccountKey)), null);
      await page.click('#skuNewPaidBatchBtn');
      await page.waitForFunction(() => !state._skuPaidAuthorizing && state._skuPaidWorkspace && state.skuProducts.filter(item => item.source === 'sku-paid-workspace').length === 2, { timeout: 15000 });
      paidAuth = await page.evaluate(() => SZ_SKU_DURABLE_RECEIPT.readActivePaidWorkspace(state.archiveAccountKey));
      assert.equal(paidAuth.tasks.length, 2); assert.match(paidAuth.workspaceKey, /^sku_paid_workspace_/);
      const rows = await page.evaluate(parents => ({ count: state.skuProducts.length, info: document.getElementById('skuPaidBatchInfo').textContent,
        old: parents.map(parent => ({ skuId: parent.sourceSkuId, state: state.skuTaskStatus[parent.sourceSkuId].state, jobId: state.skuTaskStatus[parent.sourceSkuId].jobId, selected: !!state.skuSelections[parent.sourceSkuId] })),
        paid: state.skuProducts.filter(item => item.source === 'sku-paid-workspace').map(item => ({ skuId: item.skuId, state: state.skuTaskStatus[item.skuId].state, selected: !!state.skuSelections[item.skuId] })),
        unchanged: parents.every(parent => localStorage.getItem(parent.key) === parent.raw) }), parents);
      assert.equal(rows.count, 4); assert.ok(rows.old.every(row => row.state === 'uncertain' && !row.selected));
      assert.ok(rows.paid.every(row => row.state === 'ready' && row.selected && paidAuth.tasks.some(task => task.taskId === row.skuId)));
      assert.equal(rows.unchanged, true); assert.equal(report.proxyPosts.length, 0);
      await page.click('#skuNewPaidBatchBtn'); await page.waitForFunction(() => !state._skuPaidAuthorizing);
      assert.equal((await page.evaluate(() => SZ_SKU_DURABLE_RECEIPT.readActivePaidWorkspace(state.archiveAccountKey))).workspaceKey, paidAuth.workspaceKey);
      assert.equal(report.proxyPosts.length, 0); assert.ok(report.dialogs.every(dialog => dialog.type === 'confirm' && /另外扣费/.test(dialog.message)));
      report.authorization = { workspaceKey: paidAuth.workspaceKey, authorizationSha256: paidAuth.authorizationSha256, taskCount: paidAuth.tasks.length,
        oldJobs: paidAuth.parents.map(parent => parent.jobId) };
      await outer.screenshot({ path: path.join(evidence, 'authorized-new-paid-rows-old-unknown.png'), fullPage: true });
      return { rows, workspaceKey: paidAuth.workspaceKey, authorizationPosts: 0, repeatedClickDidNotRotate: true };
    });
    await check('newWorkspaceUnknownReloadAndGetOnlyRecovery', async () => {
      providerMode = 'unknown'; await page.click('#skuGenerateBtn');
      await page.waitForFunction(taskIds => !state.skuActive && taskIds.every(id => state.skuTaskStatus[id]?.state === 'uncertain'), { timeout: 30000 }, paidAuth.tasks.map(task => task.taskId));
      assert.equal(report.proxyPosts.length, 2); paidIdentities = report.proxyPosts.map(post => post.identity);
      assert.ok(paidIdentities.every(identity => identity.workspaceKey === paidAuth.workspaceKey));
      assert.equal(new Set(paidIdentities.map(identity => identity.receiptId)).size, 2);
      const journals = await page.evaluate(async identities => {
        const api = SZ_SKU_DURABLE_RECEIPT, auth = await api.readActivePaidWorkspace(state.archiveAccountKey);
        return Promise.all(auth.parents.map(async parent => {
          const entry = await api.read(state.archiveAccountKey, parent.key + ':workspace:' + auth.workspaceKey);
          return { identity: entry.identity, plan: entry.plan, state: entry.state };
        }));
      }, paidIdentities);
      for (const journal of journals) {
        const post = report.proxyPosts.find(post => exactIdentity(post.identity, journal.identity)); assert.ok(post);
        assert.equal(hash(canonical(journal.plan)), journal.identity.planSignatureHash);
        assert.equal(journal.plan.providerInputs.baseSha256, post.imageParts[0].sha256); assert.equal(journal.plan.providerInputs.subjectSha256, post.imageParts[1].sha256);
        assert.equal(journal.plan.output.size, '1000*1000'); assert.equal(journal.state, 'dispatched');
      }
      await page.click('#skuNewPaidBatchBtn'); await page.waitForFunction(() => !state._skuPaidAuthorizing);
      assert.equal((await page.evaluate(() => SZ_SKU_DURABLE_RECEIPT.readActivePaidWorkspace(state.archiveAccountKey))).workspaceKey, paidAuth.workspaceKey);
      assert.equal(report.proxyPosts.length, 2);
      const beforeReload = await page.evaluate(taskIds => taskIds.map(id => ({ state: state.skuTaskStatus[id].state, selected: !!state.skuSelections[id] })), paidAuth.tasks.map(task => task.taskId));
      assert.ok(beforeReload.every(row => row.state === 'uncertain'));
      await outer.close(); ({ outer, page } = await openPage());
      await page.waitForFunction(taskIds => taskIds.every(id => state.skuTaskStatus[id]?.state === 'uncertain' && state.skuTaskStatus[id]?._skuRecovery?.receiptId), { timeout: 20000 }, paidAuth.tasks.map(task => task.taskId));
      await page.waitForFunction(taskIds => !state._skuPaidProductsRestoring && !state._skuDurableRestoring && taskIds.every(id =>
        Array.from(document.querySelectorAll('#skuTaskList [data-sku-id]')).some(row => row.dataset.skuId === id)), { timeout: 5000 }, paidAuth.tasks.map(task => task.taskId));
      assert.equal(report.proxyPosts.length, 2); assert.equal(report.receiptGets.length, 0);
      const reloaded = await page.evaluate(taskIds => ({ products: state.skuProducts.map(item => ({ skuId: item.skuId, source: item.source })),
        rows: taskIds.map(id => ({ skuId: id, selected: !!state.skuSelections[id], recovery: state.skuTaskStatus[id]._skuRecovery })) }), paidAuth.tasks.map(task => task.taskId));
      assert.equal(reloaded.products.length, 2, 'reload must not duplicate receipt rows'); assert.ok(reloaded.rows.every(row => !row.selected));
      for (const identity of paidIdentities) {
        const row = await page.$('[data-sku-id="' + identity.taskId + '"]'); assert.ok(row);
        let button; for (const item of await row.$$('button')) if (await item.evaluate(element => element.textContent.trim() === '核对原回执')) { button = item; break; }
        assert.ok(button); await button.click();
        await page.waitForFunction(jobId => !state.skuActive && state.skuResults.some(item => item.jobId === jobId && item.archiveAssetId), { timeout: 30000 }, identity.jobId);
      }
      await page.evaluate(async () => { await state.archiveWriteQueue; });
      assert.equal(report.proxyPosts.length, 2); assert.equal(report.receiptGets.length, 2);
      assert.ok(report.receiptGets.every(get => paidIdentities.some(identity => exactIdentity(identity, get.identity))));
      const exported = await page.evaluate(() => SZ_SKU_DURABLE_RECEIPT.exportPaidWorkspaceMetadata(state.archiveAccountKey));
      assert.ok(exported.receipts.every(row => row.localAcknowledged && row.journalState === 'acknowledged' && row.nativeArchiveIds.length === 1));
      assert.ok(exported.receipts.every(row => row.serverResponseMetadata.captureStatus === 'captured-from-server-response' && row.serverResponseMetadata.dispatchId && row.serverResponseMetadata.resultSha256));
      assert.equal(await page.evaluate(parents => parents.every(parent => localStorage.getItem(parent.key) === parent.raw), parents), true);
      await outer.screenshot({ path: path.join(evidence, 'new-workspace-get-recovered-archived.png'), fullPage: true });
      return { originalNewIdentities: paidIdentities, journals, reloaded, exportAfterAck: exported, recoveryPosts: 0, oldMarkersUnchanged: true };
    });
    await check('actualJpgAndSafeMetadataDownload', async () => {
      const pixelResults = await page.evaluate(async identities => {
        const auth = await SZ_SKU_DURABLE_RECEIPT.readActivePaidWorkspace(state.archiveAccountKey), points = [[40,40],[850,100],[100,870],[930,850]];
        return Promise.all(identities.map(async identity => {
          const parent = auth.tasks.find(task => task.taskId === identity.taskId).parentLegacyKey;
          const entry = await SZ_SKU_DURABLE_RECEIPT.read(state.archiveAccountKey, parent + ':workspace:' + auth.workspaceKey);
          const result = state.skuResults.find(item => item.jobId === identity.jobId), output = await skuCanvasImage(result.url), base = await skuCanvasImage(entry.snapshot.baseImage);
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1000; const ctx = canvas.getContext('2d');
          function samples(image) { ctx.clearRect(0,0,1000,1000); ctx.drawImage(image,0,0,1000,1000); return points.map(([x,y]) => [...ctx.getImageData(x,y,1,1).data]); }
          const a = samples(output), b = samples(base), region = entry.plan.contract.subject.authorizedRegion;
          return { jobId: identity.jobId, width: output.naturalWidth, height: output.naturalHeight,
            allPointsOutside: points.every(([x,y]) => x/1000 < region.x || x/1000 > region.x+region.w || y/1000 < region.y || y/1000 > region.y+region.h),
            maxDifference: Math.max(...a.flatMap((row,index) => row.slice(0,3).map((v,ch) => Math.abs(v-b[index][ch])))) };
        }));
      }, paidIdentities);
      assert.ok(pixelResults.every(row => row.width === 1000 && row.height === 1000 && row.allPointsOutside && row.maxDifference <= 7));
      const directory = path.join(evidence, 'downloads'); fs.mkdirSync(directory, { recursive: true });
      const cdp = await outer.createCDPSession(); await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: directory });
      await page.click('#skuExportPaidReceiptBtn'); await page.click('#skuDownloadAllBtn');
      const deadline = Date.now() + 15000; let names = [];
      while (Date.now() < deadline) { names = fs.readdirSync(directory); if (names.filter(n => n.endsWith('.jpg')).length === 2 && names.some(n => n.endsWith('.json'))) break; await new Promise(resolve => setTimeout(resolve, 100)); }
      const jpgs = names.filter(n => n.endsWith('.jpg')); assert.equal(jpgs.length, 2);
      const downloads = [];
      for (const name of jpgs) {
        assert.ok(name === title + '.jpg' || new RegExp('^' + title + '-[0-9]+\\.jpg$').test(name), name);
        const bytes = fs.readFileSync(path.join(directory, name)), metadata = await require('sharp')(bytes).metadata();
        assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.width, 1000); assert.equal(metadata.height, 1000);
        downloads.push({ name, bytes: bytes.length, sha256: hash(bytes), width: 1000, height: 1000 });
      }
      const jsonFile = names.find(name => name.endsWith('.json')); assert.ok(jsonFile);
      const bytes = fs.readFileSync(path.join(directory, jsonFile)), exported = JSON.parse(bytes.toString('utf8'));
      assert.equal(exported.workspaceKey, paidAuth.workspaceKey); assert.equal(exported.receipts.length, 2);
      assert.ok(exported.receipts.every(row => paidIdentities.some(identity => exactIdentity(identity, row.receiptIdentity))));
      assert.doesNotMatch(bytes.toString('utf8'), /data:image|https:\/\/|SYNTHETIC|Authorization|apiKey|imageEndpoint|"raw"/);
      const originalsProtected = await page.evaluate(parents => parents.every(parent => localStorage.getItem(parent.key) === parent.raw), parents);
      assert.equal(originalsProtected, true);
      return { pixelResults, jpgs: downloads, metadataDownload: { name: jsonFile, sha256: hash(bytes), export: exported },
        oldLegacyMarkersUnchanged: true, evidenceScope: 'Synthetic BYOK server metadata + real browser storage/canvas/files; no provider or financial settlement proof.' };
    });
  } catch (error) {
    report.failures.push({ layer: 'browser-run', error: error.message });
    if (page) { try { report.lastState = await page.evaluate(() => ({ owner: typeof state !== 'undefined' && state.archiveAccountKey,
      startup: document.documentElement.dataset.labStartup, status: typeof state !== 'undefined' && state.skuTaskStatus,
      preflight: document.getElementById('skuPreflight')?.textContent, messages: globalThis.__durableMessages || [],
      archiveState: document.getElementById('archiveState')?.textContent, archiveFailureCount: state.archiveFailureCount,
      products: state.skuProducts.map(item => ({ skuId: item.skuId, source: item.source, paidWorkspace: item._skuPaidWorkspace })),
      domRows: Array.from(document.querySelectorAll('#skuTaskList [data-sku-id]')).map(row => ({ skuId: row.dataset.skuId,
        buttons: Array.from(row.querySelectorAll('button')).map(button => button.textContent.trim()) })),
      paidProductsRestoring: state._skuPaidProductsRestoring,
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
