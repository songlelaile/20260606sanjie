'use strict';

// Real browser interactions against local candidate assets in a disposable profile.
// The only background image reads return local fixture pixels. No model calls run.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
let playwright;
try { playwright = require('playwright'); } catch (_) {
  const packages = process.env.CODEX_BROWSER_NODE_MODULES || '/Users/shaozhuang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
  playwright = require(path.join(packages, 'playwright'));
}

const candidate = path.resolve(__dirname, '..');
const source = process.env.REFERENCE_SCREENSHOT_BROWSER_ASSET_ROOT
  ? path.resolve(process.env.REFERENCE_SCREENSHOT_BROWSER_ASSET_ROOT)
  : path.join(candidate, 'public');
const evidence = process.env.REFERENCE_SCREENSHOT_BROWSER_EVIDENCE_DIR
  ? path.resolve(process.env.REFERENCE_SCREENSHOT_BROWSER_EVIDENCE_DIR)
  : path.join(candidate, 'docs/uat-reference-detail-screenshots-20261012/browser');
const manifestPath = process.env.REFERENCE_SCREENSHOT_BROWSER_MANIFEST_PATH
  ? path.resolve(process.env.REFERENCE_SCREENSHOT_BROWSER_MANIFEST_PATH)
  : '';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function main() {
  fs.mkdirSync(evidence, { recursive: true });
  const report = { startedAt: new Date().toISOString(), syntheticOnly: true, publicationObserved: false, passed: false,
    assetRoot: source, isolatedTemporaryProfile: true, assetFingerprints: {}, checks: {}, pageErrors: [], externalRequests: [], providerRequests: [], backgroundCalls: [] };
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/api/auth/me') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { id: 'screenshot-fixture', tenantId: 'fixture', username: 'fixture', creativeEntitlement: { allowed: true } } }));
      return;
    }
    if (pathname === '/api/creative/credits') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { balance: 0, availableCredits: 0 } }));
      return;
    }
    if (pathname.startsWith('/api/')) {
      report.providerRequests.push({ method: request.method, pathname });
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'Synthetic browser fixture blocks provider APIs' }));
      return;
    }
    const filename = path.resolve(source, '.' + pathname);
    if (!filename.startsWith(source + path.sep)) { response.writeHead(403).end(); return; }
    fs.readFile(filename, (error, data) => {
      if (error) { response.writeHead(404).end(); return; }
      if (/\.(?:html|js|css)$/.test(filename)) report.assetFingerprints[pathname] = { sha256: hash(data), bytes: data.length };
      const type = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' }[path.extname(filename)] || 'application/octet-stream';
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); response.end(data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sz-reference-screenshots-'));
  let browser, page;
  try {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await playwright.chromium.launchPersistentContext(profile, {
      headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}),
      viewport: { width: 1440, height: 1180 }, deviceScaleFactor: 1
    });
    report.browserVersion = browser.browser()?.version() || 'Chrome persistent context';
    await browser.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(origin + '/') || /^(?:data|blob):/.test(url)) return route.continue();
      report.externalRequests.push(url); return route.abort('blockedbyclient');
    });
    await browser.addInitScript(() => {
      globalThis.__SZ_PROMPTLAB_TEST_MODE__ = true;
      globalThis.__SZ_PROMPTLAB_BACKGROUND_TEST_MODE__ = true;
      globalThis.__SANJIE_ENVIRONMENT = 'reference-screenshot-fixture';
    });
    page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.goto(origin + '/creative/labs/image-prompt-lab/promptlab.html?mode=detail&detailMode=reference&source=detail-reference&layout=1', { waitUntil: 'load' });
    await page.waitForFunction(() => !!globalThis.__SZ_PROMPTLAB_TEST_API__ && document.body.classList.contains('reference-detail-story-route'));
    report.loadedScripts = await page.evaluate(() => [...document.scripts].filter(script => script.src).map(script => new URL(script.src).pathname));
    report.loadedStyles = await page.evaluate(() => [...document.querySelectorAll('link[rel="stylesheet"]')].map(link => new URL(link.href).pathname));
    if (process.env.REFERENCE_SCREENSHOT_BROWSER_ASSET_ROOT) {
      const bundles = report.loadedScripts.filter(filename => /\/studio-(?:prerequisites|runtime|views)-[^/]+\.js$/.test(filename));
      assert.equal(bundles.length, 3, 'Candidate HTML must load all three production bundles');
      assert.ok(!report.loadedScripts.some(filename => /\/(?:background|reference-detail-contract|reference-detail-blueprint|reference-detail-batch)\.js$/.test(filename)), 'Candidate must use bundled background runtime and contracts');
      report.checks.actualLoadedBundles = bundles;
    }
    const fixtures = await page.evaluate(() => {
      function png(name, color, width = 600, height = 900) {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
        context.fillStyle = color; context.fillRect(0, 0, width, height * .30);
        context.fillStyle = '#111827'; context.font = 'bold 40px sans-serif'; context.fillText(name, 24, 70);
        context.font = '28px sans-serif'; context.fillText('Screenshot structure fixture', 24, height * .45);
        context.strokeStyle = color; context.lineWidth = 4; context.strokeRect(30, height * .56, width - 60, height * .34);
        return { name: name + '.png', data: canvas.toDataURL('image/png'), width, height };
      }
      const list = [png('Screen A', '#f59e0b'), png('Screen B', '#0ea5e9'), png('Screen C', '#22c55e', 1200, 3200), png('Pasted D', '#e879f9'), png('URL E', '#f87171')];
      globalThis.__screenshotBrowserFixtures = list;
      globalThis.__screenshotBrowserCalls = [];
      const api = globalThis.__SZ_PROMPTLAB_TEST_API__;
      api.state.archiveAccountKey = 'user:fixture:fixture';
      api.setTestSend(async (type, payload) => {
        globalThis.__screenshotBrowserCalls.push({ type, url: payload && payload.url || '' });
        if (type === 'FETCH_IMAGE' && payload.url === 'https://fixture.invalid/url-e.png') return { ok: true, dataUrl: list[4].data };
        if (type === 'GET_CONFIG_PROFILE') return { ok: true, accountKey: 'user:fixture:fixture', config: { provider: 'openai-compatible', imageModel: 'image2' } };
        return { ok: false, error: 'No provider or account mutations are allowed in this browser fixture' };
      });
      return list;
    });
    report.checks.fixtureIdentity = await page.evaluate(async () => {
      const auth = await globalThis.authCheck();
      return { expectedOwner: 'user:fixture:fixture', archiveOwner: globalThis.__SZ_PROMPTLAB_TEST_API__.state.archiveAccountKey,
        resolvedOwner: await globalThis.SZ_CREATIVE_TOOLS_BRIDGE.getAccountKey(),
        archiveIdentityVersion: globalThis.__SZ_PROMPTLAB_TEST_API__.state.archiveIdentityVersion,
        backendAuthUserId: auth?.ok ? auth.user?.id || '' : '' };
    });
    assert.equal(report.checks.fixtureIdentity.archiveOwner, report.checks.fixtureIdentity.expectedOwner);
    assert.equal(report.checks.fixtureIdentity.resolvedOwner, report.checks.fixtureIdentity.expectedOwner);
    assert.equal(report.checks.fixtureIdentity.backendAuthUserId, 'fixture:fixture');
    if (process.env.REFERENCE_SCREENSHOT_BROWSER_EXPECT_NATIVE_EPOCH === '1') {
      assert.ok(Number.isInteger(report.checks.fixtureIdentity.archiveIdentityVersion) && report.checks.fixtureIdentity.archiveIdentityVersion >= 0,
        'Native archive identity epoch must be present and valid');
    }
    const files = fixtures.slice(0, 3).map(fixture => ({ name: fixture.name, mimeType: 'image/png', buffer: Buffer.from(fixture.data.split(',')[1], 'base64') }));
    await page.locator('#refFile').setInputFiles(files);
    await page.waitForFunction(() => globalThis.__SZ_PROMPTLAB_TEST_API__.state.refImages.length === 3 && !!globalThis.__SZ_PROMPTLAB_TEST_API__.state.referenceDetail.source);
    const snapshot = () => page.evaluate(async () => {
      const api = globalThis.__SZ_PROMPTLAB_TEST_API__, source = api.state.referenceDetail.source;
      const refs = [...api.state.refImages];
      const urls = source ? [...source.orderedBlocks].sort((a, b) => a.originalIndex - b.originalIndex).map(block => source.assets.find(asset => asset.assetId === block.assetIds[0])?.url) : [];
      const dimensions = await Promise.all(refs.map(url => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight }); image.onerror = reject; image.src = url; })));
      return { refs, sourceUrls: urls, dimensions, schema: source?.schema || null, snapshotId: source?.snapshotId || '',
        archiveIdentityVersion: api.state.archiveIdentityVersion,
        screenshotInputVisible: !document.getElementById('referenceSourcePanel').hidden && document.getElementById('referenceSourcePanel').getAttribute('aria-hidden') !== 'true',
        sourceKind: document.getElementById('referenceDetailSourceKind').textContent,
        itemId: source?.source?.itemId || '', platform: source?.source?.platform || '',
        analyzeEnabled: !document.getElementById('referenceDetailBuildBtn').disabled,
        buildPhase: api.state.referenceDetail.buildPhase,
        approvalStatus: api.state.referenceDetail.currentBlueprint?.approvalStatus || '',
        prompt: api.state.referencePrompts.detail, batchBundle: api.state.referenceDetailBatch.bundle,
        previewAlts: [...document.querySelectorAll('#refPreview img')].map(image => image.alt),
        sourcePreviewUrls: [...document.querySelectorAll('#referenceDetailSourcePreview img')].map(image => image.src) };
    });
    const initial = await snapshot();
    assert.equal(initial.schema, 'REFERENCE_DETAIL_SCREENSHOT_SOURCE_V1');
    assert.equal(initial.itemId, ''); assert.notEqual(initial.platform, 'taobao'); assert.notEqual(initial.platform, 'tmall');
    assert.match(initial.sourceKind, /截图/); assert.equal(initial.analyzeEnabled, true);
    assert.equal(initial.screenshotInputVisible, true);
    assert.deepEqual(initial.sourceUrls, initial.refs); assert.deepEqual(initial.sourcePreviewUrls, initial.refs);
    assert.deepEqual(initial.previewAlts, ['参考详情截图第 1 张', '参考详情截图第 2 张', '参考详情截图第 3 张']);
    assert.ok(initial.dimensions.every(size => Math.max(size.width, size.height) <= 2400));
    assert.deepEqual(initial.dimensions.slice(0, 2), [{ width: 600, height: 900 }, { width: 600, height: 900 }]);
    report.checks.upload = { schema: initial.schema, count: initial.refs.length, sourceKind: initial.sourceKind, dimensions: initial.dimensions, analyzeEnabled: initial.analyzeEnabled, providerDispatched: false };

    const originals = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open('sz_image_upload_originals_v1:environment:reference-screenshot-fixture', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const rows = await new Promise((resolve, reject) => { const request = db.transaction('originals').objectStore('originals').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      return Promise.all(rows.map(async row => ({ name: row.name, hash: row.hash, bytes: row.bytes, accountKey: row.accountKey,
        actualHash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', await row.blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('') })));
    });
    for (const file of files) {
      const original = originals.find(row => row.name === file.name); assert.ok(original, 'Original PNG retained: ' + file.name);
      assert.equal(original.accountKey, report.checks.fixtureIdentity.expectedOwner);
      assert.equal(original.hash, hash(file.buffer)); assert.equal(original.actualHash, hash(file.buffer)); assert.equal(original.bytes, file.buffer.length);
    }
    report.checks.originals = { retained: files.length, byteHashesVerified: true, records: originals };
    await page.locator('#refPreview img').first().click();
    await page.getByRole('link', { name: '下载原图' }).waitFor();
    await page.locator('[data-cu-close]').click();
    report.checks.originalPreview = true;

    await page.getByRole('button', { name: '第 3 张截图前移', exact: true }).click();
    const moved = await snapshot();
    assert.deepEqual(moved.refs, [initial.refs[0], initial.refs[2], initial.refs[1]]);
    assert.deepEqual(moved.sourceUrls, moved.refs); assert.notEqual(moved.snapshotId, initial.snapshotId);
    await page.locator('#refPreview .reference-preview-remove').nth(1).click();
    const removed = await snapshot(); assert.deepEqual(removed.refs, [initial.refs[0], initial.refs[1]]);
    assert.deepEqual(removed.sourceUrls, removed.refs); report.checks.reorderAndRemove = true;

    await page.evaluate(() => {
      document.activeElement?.blur();
      const item = globalThis.__screenshotBrowserFixtures[3];
      const bytes = Uint8Array.from(atob(item.data.split(',')[1]), char => char.charCodeAt(0));
      const file = new File([bytes], item.name, { type: 'image/png' });
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { items: [{ type: file.type, getAsFile: () => file }] } });
      document.body.dispatchEvent(event);
    });
    await page.waitForFunction(() => globalThis.__SZ_PROMPTLAB_TEST_API__.state.refImages.length === 3);
    const pasted = await snapshot(); assert.deepEqual(pasted.refs.slice(0, 2), removed.refs); assert.deepEqual(pasted.sourceUrls, pasted.refs);
    report.checks.paste = { count: pasted.refs.length, sourceOrderPreserved: true };

    const refUpload = page.locator('.cu-upload').filter({ has: page.locator('#refFile') });
    await refUpload.locator('[data-cu-url]').fill('https://fixture.invalid/url-e.png');
    await refUpload.locator('[data-cu-add-url]').click();
    await page.waitForFunction(() => globalThis.__SZ_PROMPTLAB_TEST_API__.state.refImages.length === 4);
    const withUrl = await snapshot(); assert.deepEqual(withUrl.refs.slice(0, 3), pasted.refs); assert.deepEqual(withUrl.sourceUrls, withUrl.refs);
    report.checks.url = { count: withUrl.refs.length, onlyFixtureImageRead: true };

    await page.evaluate(() => {
      const api = globalThis.__SZ_PROMPTLAB_TEST_API__;
      api.state.referenceDetail.currentBlueprint = { ...api.state.referenceDetail.currentBlueprint, approvalStatus: 'approved' };
      api.state.referencePrompts.detail = { mode: 'detail', source: 'reference', referenceDetailFormal: true, prompt: 'stale approved source prompt' };
      api.state.activePromptRecord = api.state.referencePrompts.detail;
      api.state.referenceDetailBatch.bundle = { bundleId: 'old-source-approved-bundle' };
      api.state.referenceDetailBatch.rows = [{ rowId: 'old-source-target' }];
    });
    await page.getByRole('button', { name: '第 4 张截图前移', exact: true }).click();
    const changed = await snapshot(); assert.notEqual(changed.approvalStatus, 'approved'); assert.equal(changed.prompt, null); assert.equal(changed.batchBundle, null);
    report.checks.approvalInvalidation = true;
    const locked = await page.evaluate(() => {
      const api = globalThis.__SZ_PROMPTLAB_TEST_API__, before = JSON.stringify(api.state.refImages), source = api.state.referenceDetail.source;
      api.state.referenceDetail.confirmationContext = { token: 'synthetic-confirmation-in-progress' };
      let errorCode = ''; try { api.setRefImages([], ''); } catch (error) { errorCode = error.code || ''; }
      const unchanged = before === JSON.stringify(api.state.refImages) && source === api.state.referenceDetail.source;
      api.state.referenceDetail.confirmationContext = null;
      const resumed = api.setRefImages([...api.state.refImages], '');
      api.renderReferenceDetailWorkbench(); return { unchanged, errorCode, unlockedAccepted: resumed?.ok === true };
    });
    assert.equal(locked.unchanged, true); assert.equal(locked.unlockedAccepted, true); report.checks.confirmationLock = locked;
    await page.screenshot({ path: path.join(evidence, 'screenshots-desktop.png'), fullPage: true });
    await page.locator('#referenceSourcePanel').screenshot({ path: path.join(evidence, 'screenshots-input-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#refPreview').scrollIntoViewIfNeeded();
    const mobile = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
      previewWidth: document.getElementById('refPreview').getBoundingClientRect().width,
      screenshots: document.querySelectorAll('#refPreview img').length,
      sourceScreens: document.querySelectorAll('#referenceDetailSourcePreview img').length }));
    assert.ok(mobile.documentWidth <= mobile.viewport + 1, 'Mobile document overflows: ' + JSON.stringify(mobile));
    assert.ok(mobile.previewWidth <= mobile.viewport); report.checks.mobile = mobile;
    await page.screenshot({ path: path.join(evidence, 'screenshots-mobile.png'), fullPage: true });
    await page.locator('#referenceSourcePanel').screenshot({ path: path.join(evidence, 'screenshots-input-mobile.png') });

    await page.locator('#clearRefBtn').click();
    const cleared = await snapshot(); assert.equal(cleared.schema, null); assert.deepEqual(cleared.refs, []); assert.equal(cleared.analyzeEnabled, false);
    if (process.env.REFERENCE_SCREENSHOT_BROWSER_EXPECT_NATIVE_EPOCH === '1') {
      assert.equal(cleared.archiveIdentityVersion, report.checks.fixtureIdentity.archiveIdentityVersion, 'Screenshot operations must preserve the native account identity epoch');
      report.checks.nativeIdentityEpochPreserved = true;
    }
    report.checks.clear = true;
    report.backgroundCalls = await page.evaluate(() => globalThis.__screenshotBrowserCalls);
    assert.ok(report.backgroundCalls.every(call => ['FETCH_IMAGE', 'GET_CONFIG_PROFILE'].includes(call.type)));
    assert.equal(report.providerRequests.length, 0); assert.equal(report.pageErrors.length, 0, report.pageErrors.join('\n'));
    if (manifestPath) {
      const rawManifest = fs.readFileSync(manifestPath), manifest = JSON.parse(rawManifest);
      const checks = Object.entries(manifest.files).map(([file, entry]) => {
        const loaded = report.assetFingerprints[file.replace(/^public/, '')];
        return { file, expectedSha256: entry.afterSha256, actualLoadedSha256: loaded?.sha256 || null,
          bytes: loaded?.bytes || 0, passed: loaded?.sha256 === entry.afterSha256 };
      });
      const match = { passed: checks.every(check => check.passed), manifestSha256: hash(rawManifest),
        assetRoot: source, publicationObserved: false, sourceReviewSha256: manifest.sourceReviewSha256 || null,
        loadedBundleCount: report.checks.actualLoadedBundles?.length || 0, checks };
      fs.writeFileSync(path.join(evidence, 'manifest-match.json'), JSON.stringify(match, null, 2) + '\n');
      assert.equal(match.passed, true, 'Loaded candidate assets must match the frozen manifest');
      report.manifestSha256 = match.manifestSha256;
      if (manifest.sourceReviewSha256) report.sourceReviewSha256 = manifest.sourceReviewSha256;
      if (manifest.captureSource) report.captureSource = manifest.captureSource;
      for (const key of ['parentPublicationObserved', 'screenshotPublicationObserved']) {
        if (typeof manifest[key] === 'boolean') report[key] = manifest[key];
      }
    }
    report.passed = true;
  } finally {
    if (!report.passed && page) {
      report.failureState = await page.evaluate(() => ({
        contextState: document.getElementById('contextState')?.textContent,
        detailSourceState: document.getElementById('detailSourceState')?.textContent,
        detailState: document.getElementById('detailState')?.textContent,
        bodyClasses: document.body.className,
        referenceCount: globalThis.__SZ_PROMPTLAB_TEST_API__?.state.refImages.length,
        sourceSchema: globalThis.__SZ_PROMPTLAB_TEST_API__?.state.referenceDetail.source?.schema,
        calls: globalThis.__screenshotBrowserCalls,
        orderControls: [...document.querySelectorAll('.reference-screenshot-order-controls button')].map(button => ({
          label: button.getAttribute('aria-label'), rect: button.getBoundingClientRect().toJSON(),
          display: getComputedStyle(button).display, visibility: getComputedStyle(button).visibility,
          hiddenAncestor: button.closest('[aria-hidden="true"], [hidden]')?.id || '', disabled: button.disabled
        })),
        errors: [...document.querySelectorAll('.cu-error')].map(element => element.textContent).filter(Boolean)
      })).catch(error => ({ error: String(error) }));
      await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
    }
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks, pageErrors: report.pageErrors, providerRequests: report.providerRequests, failureState: report.failureState, report: path.join(evidence, 'report.json') }, null, 2));
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
