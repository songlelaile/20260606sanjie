/* Isolated local acceptance: never connects to user profiles or provider APIs. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('/Users/shaozhuang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const preferred = '.codex-deploy/studio-viral-split-20261002/rebase-work-image-upload-v3/public';
const assets = path.resolve(root, process.env.CREATIVE_VIRAL_ASSET_ROOT || (fs.existsSync(path.join(root, preferred)) ? preferred : 'public'));
const output = path.resolve(root, process.env.CREATIVE_VIRAL_OUTPUT_DIR || '.codex-deploy/image-upload-20261002-viral-proof');
const skipDedicated = process.argv.includes('--skip-dedicated');
fs.mkdirSync(output, { recursive: true });
const checks = [], errors = [], blockedRequests = [], imageRequests = [], externalRequests = [], missingStaticRequests = [], servedAssets = new Map();
const fixtureBytes = new Map();
const startedAt = Date.now();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) });
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const slots = [
  { id: 'refFile', preview: 'refPreview', clear: 'clearRefBtn', key: 'ref', title: '参考图' },
  { id: 'productFrontFile', preview: 'productFrontPreview', clear: 'clearProductFrontBtn', key: 'front', title: '产品正视图' },
  { id: 'productSideFile', preview: 'productSidePreview', clear: 'clearProductSideBtn', key: 'side', title: '产品侧视图' },
  { id: 'productBackFile', preview: 'productBackPreview', clear: 'clearProductBackBtn', key: 'back', title: '产品背视图' }
];
const methods = ['click', 'drop', 'paste-image', 'paste-url'];
let browser, server, base, origin, sequence = 0;

async function snapshot(page) {
  return page.evaluate(() => ({ refs: [...state.refImages], products: { ...state.productImages }, models: { ...state.modelImages } }));
}

async function transfer(page, zone, kind, file, url) {
  await zone.evaluate((element, data) => {
    const transfer = new DataTransfer();
    if (data.kind === 'paste-url') transfer.setData('text/plain', data.url);
    else transfer.items.add(new File([Uint8Array.from(atob(data.base64), char => char.charCodeAt(0))], data.name, { type: 'image/png' }));
    const event = data.kind === 'drop'
      ? new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
      : new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
    element.dispatchEvent(event);
  }, { kind, base64: file.buffer.toString('base64'), name: file.name, url });
}

async function clearSlot(page, slot) {
  await page.locator('#' + slot.clear).click();
  await page.waitForFunction(({ id, key }) => {
    const block = document.getElementById(id)?.closest('.cu-upload');
    const source = key === 'ref' ? state.refImages.length === 0 : !state.productImages[key];
    return source && block && /^0\//.test(block.querySelector('[data-cu-count]').textContent);
  }, { id: slot.id, key: slot.key });
}

async function verifySlot(page, scenario, slot) {
  const prefix = `${scenario}/${slot.key}`;
  const block = page.locator('#' + slot.id).locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," cu-upload ")][1]');
  await block.waitFor({ state: 'visible' });
  const geometry = await block.evaluate(element => {
    const drop = element.querySelector('.cu-drop'), rect = drop.getBoundingClientRect(), style = getComputedStyle(drop);
    const file = drop.querySelector('input[type=file]');
    return { width: rect.width, height: rect.height, radius: style.borderRadius, border: style.borderStyle, visible: !!drop.getClientRects().length, title: element.querySelector('h3').textContent.trim(), count: element.querySelector('[data-cu-count]').textContent.trim(), methods: element.querySelector('.cu-methods').textContent, urlInput: !!element.querySelector('[data-cu-url]'), urlButton: !!element.querySelector('[data-cu-add-url]'), fileHidden: getComputedStyle(file).opacity === '0' && file.getBoundingClientRect().width <= 1 };
  });
  check(prefix + ' unique visible shared component', await block.count() === 1 && geometry.visible && geometry.title === slot.title, geometry);
  check(prefix + ' exact desktop geometry', geometry.width === 308 && geometry.height === 128 && geometry.radius === '12px' && geometry.border === 'dashed', geometry);
  const containment = await block.evaluate(element => {
    const rect = element.getBoundingClientRect(), ancestors = [];
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const bounds = parent.getBoundingClientRect(), style = getComputedStyle(parent);
      if (!bounds.width) continue;
      const left = bounds.left + parseFloat(style.borderLeftWidth || 0) + parseFloat(style.paddingLeft || 0);
      const right = bounds.right - parseFloat(style.borderRightWidth || 0) - parseFloat(style.paddingRight || 0);
      ancestors.push({ id: parent.id, classes: parent.className, contentLeft: left, contentRight: right, overflowX: style.overflowX, contained: rect.left >= left - 1 && rect.right <= right + 1 });
    }
    return { uploadLeft: rect.left, uploadRight: rect.right, viewportWidth: innerWidth, ancestors, contained: ancestors.every(parent => parent.contained) && rect.left >= 0 && rect.right <= innerWidth };
  });
  check(prefix + ' upload fits every parent card column and viewport', containment.contained, containment);
  check(prefix + ' four methods and URL controls', ['拖入', '点击上传', '粘贴图片', '粘贴 URL'].every(text => geometry.methods.includes(text)) && geometry.urlInput && geometry.urlButton, geometry);
  const oldUrlId = slot.id.replace(/File$/, 'Url');
  const oldVisible = await page.locator('#' + oldUrlId).isVisible();
  const emptyVisible = await page.locator('#' + slot.preview + '.empty').isVisible();
  check(prefix + ' replaced native file URL and empty preview are hidden', geometry.fileHidden && !oldVisible && !emptyVisible, { oldUrlVisible: oldVisible, emptyPreviewVisible: emptyVisible });
  for (const method of methods) {
    const name = prefix + '/' + method;
    try {
      const before = await snapshot(page);
      const index = ++sequence;
      const bytes = Buffer.from(await page.evaluate(index => {
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 220;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = `hsl(${index * 43 % 360},70%,55%)`; ctx.fillRect(0, 0, 320, 220);
        ctx.fillStyle = '#182216'; ctx.fillRect(45, 35, 210, 150); ctx.fillStyle = '#fff'; ctx.font = '24px sans-serif'; ctx.fillText(String(index), 80, 100);
        return canvas.toDataURL('image/png').split(',')[1];
      }, index), 'base64');
      const file = { name: `viral-${scenario}-${slot.key}-${method}.png`, mimeType: 'image/png', buffer: bytes };
      const url = `https://img.alicdn.com/viral-upload-uat/${index}.png`; fixtureBytes.set(url, bytes);
      const priorChanges = await page.evaluate(id => window.__viralChanges.filter(value => value === id).length, slot.id);
      if (method === 'click') {
        const chooserPromise = page.waitForEvent('filechooser'); await block.locator('.cu-drop').click(); const chooser = await chooserPromise;
        check(name + ' native chooser targets this input', await chooser.element().getAttribute('id') === slot.id);
        await chooser.setFiles(file);
      } else await transfer(page, block.locator('.cu-drop'), method, file, url);
      await page.waitForFunction(({ id, preview, key }) => {
        const source = key === 'ref' ? state.refImages[0] : state.productImages[key];
        const block = document.getElementById(id)?.closest('.cu-upload');
        return source && document.querySelector('#' + preview + ' img')?.src === source && !legacyImageUploadBusy() && /^1\//.test(block?.querySelector('[data-cu-count]')?.textContent || '');
      }, { id: slot.id, preview: slot.preview, key: slot.key });
      const after = await snapshot(page);
      const stateCheck = await page.evaluate(({ id, preview, key, before, priorChanges }) => {
        const source = key === 'ref' ? state.refImages[0] : state.productImages[key];
        const count = document.getElementById(id).closest('.cu-upload').querySelector('[data-cu-count]').textContent.trim();
        const noCross = Object.keys(state.productImages).filter(angle => angle !== key).every(angle => state.productImages[angle] === before.products[angle]) && JSON.stringify(state.modelImages) === JSON.stringify(before.models) && (key === 'ref' || JSON.stringify(state.refImages) === JSON.stringify(before.refs));
        return { sourceDataImage: /^data:image\//.test(source), previewCount: document.querySelectorAll('#' + preview + ' img').length, previewEqualsState: document.querySelector('#' + preview + ' img')?.src === source, count, expectedCount: '1/' + (key === 'ref' ? referenceImageLimit() : 1), noCross, changes: window.__viralChanges.filter(value => value === id).length - priorChanges, referenceCount: state.refImages.length };
      }, { id: slot.id, preview: slot.preview, key: slot.key, before, priorChanges });
      check(name + ' preview business state count and exactly one change', stateCheck.sourceDataImage && stateCheck.previewCount === 1 && stateCheck.previewEqualsState && stateCheck.count === stateCheck.expectedCount && stateCheck.changes === 1 && (slot.key !== 'ref' || stateCheck.referenceCount === 1), stateCheck);
      check(name + ' no cross-slot mutation', stateCheck.noCross, { refsBefore: before.refs.length, refsAfter: after.refs.length, productSlotsBefore: Object.keys(before.products).filter(key => before.products[key]), productSlotsAfter: Object.keys(after.products).filter(key => after.products[key]) });
      await page.locator('#' + slot.preview + ' img[data-cu-preview]').click();
      await page.locator('.cu-dialog').waitFor({ state: 'visible' });
      const downloadPromise = page.waitForEvent('download'); await page.getByRole('link', { name: '下载原图', exact: true }).click();
      const download = await downloadPromise, destination = path.join(output, `${scenario}-${slot.key}-${method}-original.png`);
      await download.saveAs(destination);
      check(name + ' downloaded original has exact fixture hash', hash(fs.readFileSync(destination)) === hash(bytes), { originalSha256: hash(bytes), downloadSha256: hash(fs.readFileSync(destination)), originalBytes: bytes.length });
      await page.keyboard.press('Escape');
      await clearSlot(page, slot);
      const cleared = await snapshot(page);
      check(name + ' remove restores state without changing other slots', JSON.stringify(cleared) === JSON.stringify(before) && await page.locator('#' + slot.preview + ' img').count() === 0);
    } catch (error) {
      check(name + ' completes interaction', false, { message: error.message, contextState: await page.locator('#contextState').textContent().catch(() => null), localError: await block.locator('.cu-error').textContent().catch(() => null) });
      await page.screenshot({ path: path.join(output, `${scenario}-${slot.key}-${method}-failure.png`), fullPage: true }).catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      await clearSlot(page, slot).catch(() => {});
    }
  }
}

async function runScenario(page, name, style) {
  const relevant = style ? slots.slice(1) : slots;
  await page.waitForFunction(() => window.SZ_IMAGE_UPLOAD && window.SZ_CREATIVE_TOOLS_BRIDGE && document.documentElement.dataset.labStartup === 'ready');
  await page.waitForFunction(ids => ids.every(id => document.getElementById(id)?.closest('.cu-upload')), relevant.map(slot => slot.id));
  const visible = await page.locator('.cu-upload').evaluateAll(elements => elements.filter(element => element.getClientRects().length).length);
  check(name + ' nonempty exact visible slot count', visible === relevant.length, { expected: relevant.length, actual: visible });
  if (style) check(name + ' reference control remains hidden', !(await page.locator('#refFile').locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," cu-upload ")][1]').isVisible()));
  await page.screenshot({ path: path.join(output, name + '-empty-workspace.png'), fullPage: true });
  for (const slot of relevant) {
    try { await verifySlot(page, name, slot); }
    catch (error) { check(name + '/' + slot.key + ' slot is reachable', false, error.message); }
  }
}

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  context.setDefaultTimeout(5000);
  await context.addInitScript(() => {
    window.__SANJIE_ENVIRONMENT = 'viral-upload-uat'; window.__viralChanges = [];
    document.addEventListener('change', event => { if (event.target?.type === 'file') window.__viralChanges.push(event.target.id); }, true);
  });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    externalRequests.push({ url: route.request().url(), method: route.request().method() }); return route.abort();
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push({ url: page.url(), message: error.message }));
  return { context, page };
}

async function main() {
  const htmlPath = path.join(assets, 'creative/labs/image-prompt-lab/promptlab.html');
  const references = [...fs.readFileSync(htmlPath, 'utf8').matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["']/g)].map(match => match[1]).filter(value => /\.(?:css|js)(?:\?|$)/.test(value) && !/^(?:https?:|\/\/)/.test(value));
  const missingDependencies = references.filter(value => { const clean = value.split('?')[0]; const file = clean.startsWith('/') ? path.join(assets, clean) : path.resolve(path.dirname(htmlPath), clean); return !fs.existsSync(file); });
  check('all HTML script stylesheet dependencies exist', missingDependencies.length === 0, { assetRoot: assets, missingDependencies });
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/auth/me' && request.method === 'GET') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: { id: 'viral-image-upload-fixture', tenantId: 'viral-upload-uat', username: 'fixture', creativeEntitlement: { allowed: true } } })); return; }
    if (url.pathname === '/api/creative/proxy' && request.method === 'POST') {
      let body = ''; request.on('data', bytes => { body += bytes; }); request.on('end', () => {
        let payload; try { payload = JSON.parse(body); } catch { response.writeHead(400); response.end(); return; }
        if (payload.method !== 'GET' || !fixtureBytes.has(payload.url)) { blockedRequests.push({ path: url.pathname, method: request.method, imageMethod: payload.method, imageUrl: payload.url }); response.writeHead(403); response.end('Fixture only'); return; }
        const bytes = fixtureBytes.get(payload.url); imageRequests.push({ url: payload.url, method: payload.method, sha256: hash(bytes) }); response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length }); response.end(bytes);
      }); return;
    }
    if (url.pathname.startsWith('/api/')) { blockedRequests.push({ path: url.pathname, method: request.method }); response.writeHead(403, { 'Content-Type': 'application/json' }); response.end('{"error":"Local upload acceptance does not call business APIs"}'); return; }
    const file = path.resolve(assets, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(assets + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { missingStaticRequests.push({ path: url.pathname, method: request.method }); response.writeHead(404); response.end('Not found'); return; }
    const bytes = fs.readFileSync(file); servedAssets.set(path.relative(assets, file), { size: bytes.length, sha256: hash(bytes) }); response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream'); response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`; base = origin + '/creative/labs/image-prompt-lab/promptlab.html';
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const legacy = await newPage();
  await legacy.page.goto(base + '?mode=viral&source=web&layout=1'); await runScenario(legacy.page, 'default-case', false);
  await legacy.page.locator('#viralStyleModeBtn').click(); await legacy.page.waitForFunction(() => document.body.classList.contains('style-refresh-route'));
  await runScenario(legacy.page, 'default-style', true);
  await legacy.context.close();
  for (const [name, route, style] of (skipDedicated ? [] : [['dedicated-case', 'case', false], ['dedicated-style', 'style-refresh', true]])) {
    const isolated = await newPage();
    await isolated.page.goto(base + '?mode=viral&source=web&layout=1&workflow=1&creativeRoute=' + route); await runScenario(isolated.page, name, style); await isolated.context.close();
  }
  check('no page JavaScript errors', errors.length === 0, errors);
  check('no missing requested static resources', missingStaticRequests.length === 0, missingStaticRequests);
  check('no provider or business API attempts', blockedRequests.length === 0 && externalRequests.length === 0, { blockedRequests, externalRequests });
  const expectedUrlImports = skipDedicated ? 7 : 14;
  check('all covered URL imports used controlled image GET fixtures', imageRequests.length === expectedUrlImports && imageRequests.every(request => request.method === 'GET'), { count: imageRequests.length, expected: expectedUrlImports });
}

main().catch(error => { check('acceptance runner completes', false, error.stack || error.message); }).finally(async () => {
  if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve));
  const assetStability = [...servedAssets].map(([file, value]) => ({ path: file, ...value, matchesCurrentFile: fs.existsSync(path.join(assets, file)) && hash(fs.readFileSync(path.join(assets, file))) === value.sha256 }));
  check('served asset hashes remain stable during acceptance', assetStability.every(item => item.matchesCurrentFile));
  const result = { schema: 'SANJIE_VIRAL_IMAGE_UPLOAD_LOCAL_ACCEPTANCE_V1', assetRoot: assets, outputRoot: output, origin, coverage: { defaultCase: true, defaultStyleSwitch: true, dedicatedRoutes: skipDedicated ? 'candidate-only; intentionally skipped for production V3-derived tree' : 'tested locally', slots: skipDedicated ? 7 : 14, fourMethodImports: skipDedicated ? 28 : 56, rootDedicatedEvidence: skipDedicated ? path.join(root, '.codex-deploy/image-upload-20261002-viral-proof/acceptance.json') : null }, passed: checks.filter(check => check.passed).length, total: checks.length, checks, errors, blockedRequests, externalRequests, missingStaticRequests, imageRequests, servedAssets: assetStability, realProvider: false, userBrowserUsed: false, userDraftChanged: false, durationMs: Date.now() - startedAt };
  fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ assetRoot: assets, passed: result.passed, total: result.total, durationMs: result.durationMs, failures: checks.filter(check => !check.passed), outputRoot: output }, null, 2));
  if (result.passed !== result.total) process.exitCode = 1;
});
