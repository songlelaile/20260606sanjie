/* Isolated browser acceptance. No user profile, provider, billing, or production access. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('/Users/shaozhuang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const assets = path.resolve(root, process.env.CREATIVE_VIRAL_ASSET_ROOT || 'public');
const output = path.resolve(root, process.env.CREATIVE_VIRAL_OUTPUT_DIR || 'docs/uat-viral-task-status-20261016/browser');
const checks = [], errors = [], blockedRequests = [], externalRequests = [], missingStaticRequests = [], servedAssets = new Map();
const startedAt = Date.now();
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) });
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
let browser, server, origin;
fs.mkdirSync(output, { recursive: true });

async function initFixture(page, route) {
  return page.evaluate(routeName => {
    if (promptTaskRenderTimer) clearTimeout(promptTaskRenderTimer);
    state.archiveAccountKey = 'offline-task-status-fixture';
    const owner = promptTaskOwner(), now = Date.now();
    const base = (id, status, extra = {}) => Object.assign({ id, jobId: 'offline-' + routeName + '-' + id + '-request-identifier-1792164190610_f61397c3da6e', type: 'GENERATE_IMAGE', label: '图片生成', targetLabel: '', receiptKey: '', status, startedAt: now - 62000, endedAt: now - 17000, receiptState: '', code: '' }, extra);
    promptTaskRecords[owner] = [
      ...Array.from({ length: 8 }, (_, i) => base('done-' + (i + 1), i === 7 ? 'recovered' : 'success', { targetLabel: '第' + (i + 1) + '张', receiptState: i === 7 ? 'received' : '' })),
      base('failed-check', 'failed', { type: 'ANALYZE_STYLE_REFRESH_QA', label: '图片检查', code: 'CREATIVE_REQUEST_NOT_SUBMITTED' }),
      base('pending-image', 'ended', { targetLabel: '待确认原任务', receiptState: 'pending', code: 'TASK_WAIT_ENDED' })
    ];
    window.__taskStatusFixture = { pending: {}, results: [], cancelled: [] };
    promptLabTestSend = function (type, request) {
      if (!/^offline-task-status-/.test(request.jobId || '')) throw new Error('Unexpected offline dispatch: ' + type);
      return new Promise(resolve => { window.__taskStatusFixture.pending[request.jobId] = resolve; });
    };
    const originalSendMessage = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = function (request, callback) {
      if (request.type === 'CANCEL_GENERATION' && /^offline-task-status-/.test(request.jobId || '')) {
        window.__taskStatusFixture.cancelled.push(request.jobId);
        if (callback) callback({ ok: true, cancelled: true, jobId: request.jobId });
        return;
      }
      return originalSendMessage.apply(this, arguments);
    };
    ['a', 'b'].forEach((suffix, index) => {
      const jobId = 'offline-task-status-' + routeName + '-' + suffix;
      sendRuntime(routeName === 'style-refresh' ? 'ANALYZE_STYLE_REFRESH_QA' : 'ANALYZE_IMAGE', { jobId, payload: { linkId: '方案' + (index + 1), offlineFixture: suffix } })
        .then(response => window.__taskStatusFixture.results.push({ jobId, response }));
    });
    promptTaskRender();
    return { owner, key: promptTaskStorageKey(owner), snapshot: promptTaskState() };
  }, route);
}

async function geometry(page) {
  return page.evaluate(() => {
    const entry = document.getElementById('promptTaskOpen'), panel = document.getElementById('promptTaskPanel');
    const dialog = document.getElementById('promptTaskDialog');
    const bounds = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const overflow = element => ({ scroll: element.scrollWidth, client: element.clientWidth, fits: element.scrollWidth <= element.clientWidth + 1 });
    return { viewport: { width: innerWidth, height: innerHeight }, entry: bounds(entry), panel: bounds(panel), dialog: bounds(dialog), entryOverflow: overflow(entry), dialogOverflow: overflow(dialog), documentOverflow: overflow(document.documentElement), current: document.getElementById('promptTaskCurrent')?.textContent, elapsed: document.getElementById('promptTaskCurrentElapsed')?.textContent, summary: document.getElementById('promptTaskSummary').textContent, panelState: panel.dataset.state };
  });
}

async function verifyScenario(page, route, size) {
  const name = `${route}-${size.name}`, fixture = await initFixture(page, route);
  await page.locator('#promptTaskOpen').waitFor({ state: 'visible' });
  await page.locator('#promptTaskOpen').scrollIntoViewIfNeeded();
  const compact = await geometry(page);
  check(name + ' compact entry has responsive compact height', size.name === 'desktop' ? Math.abs(compact.entry.height - 44) < 0.5 : compact.entry.height >= 40 && compact.entry.height <= 64, compact);
  check(name + ' compact entry fits viewport and hides technical identifiers', compact.entry.x >= -1 && compact.entry.right <= size.width + 1 && compact.entryOverflow.fits && !/offline-|CREATIVE_REQUEST|TASK_WAIT/.test(await page.locator('#promptTaskOpen').innerText()), compact);
  check(name + ' compact entry reports running, attention and completion counts', /进行中 2/.test(compact.summary) && /失败 1/.test(compact.summary) && /待确认 1/.test(compact.summary) && /最近完成 8/.test(compact.summary), compact);
  check(name + ' current task and elapsed time are available', Boolean(compact.current?.trim()) && Boolean(compact.elapsed?.trim()), compact);
  await page.screenshot({ path: path.join(output, name + '-compact.png') });
  await page.locator('#promptTaskOpen').click();
  await page.locator('#promptTaskDialog').waitFor({ state: 'visible' });
  check(name + ' real modal opens and entry reflects expansion', await page.locator('#promptTaskDialog').evaluate(el => el.open && el.matches(':modal')) && await page.locator('#promptTaskOpen').getAttribute('aria-expanded') === 'true');
  check(name + ' close control uses the task status accessible name', await page.locator('#promptTaskClose').getAttribute('aria-label') === '关闭任务状态');
  for (const group of ['running', 'attention', 'completed']) check(name + ' drawer includes ' + group + ' group', await page.locator(`[data-task-group="${group}"]`).count() === 1);
  const completed = page.locator('[data-task-group="completed"]');
  check(name + ' completed group is collapsed by default', await completed.evaluate(el => el.tagName === 'DETAILS' && !el.open));
  check(name + ' all retained completed tasks are included', await completed.locator('[data-task-id]').count() === 8, { expected: 8, actual: await completed.locator('[data-task-id]').count() });
  const details = page.locator('[data-task-detail]');
  check(name + ' every technical detail is collapsed by default', await details.count() === 12 && await details.evaluateAll(elements => elements.every(el => el.tagName === 'DETAILS' && !el.open)), { count: await details.count() });
  const pending = page.locator('[data-task-id="pending-image"]');
  check(name + ' ended image with pending receipt is accurately awaiting confirmation', /待确认/.test(await pending.innerText()) && !/失败，可重新跑|已结束，可重新跑/.test(await pending.innerText()), await pending.innerText());
  const drawer = await geometry(page);
  check(name + ' drawer and document have no horizontal overflow', drawer.dialog.x >= -1 && drawer.dialog.right <= size.width + 1 && drawer.dialogOverflow.fits && drawer.documentOverflow.fits, drawer);
  await page.screenshot({ path: path.join(output, name + '-drawer.png') });
  await completed.locator('summary').first().click();
  check(name + ' completed group opens to show original records', await completed.evaluate(el => el.open) && await completed.locator('[data-task-id="done-1"]').isVisible());
  const failedDetail = page.locator('[data-task-detail="failed-check"]');
  await failedDetail.locator('summary').click();
  check(name + ' technical details expand on request', await failedDetail.evaluate(el => el.open) && /CREATIVE_REQUEST_NOT_SUBMITTED/.test(await failedDetail.innerText()));
  const expandedGeometry = await geometry(page);
  check(name + ' expanded request identifiers wrap without horizontal overflow', expandedGeometry.dialogOverflow.fits && expandedGeometry.documentOverflow.fits, expandedGeometry);
  await failedDetail.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, name + '-expanded-details.png') });
  await page.evaluate(routeName => {
    const key = 'offline-task-status-' + routeName + '-a';
    window.__taskStatusFixture.pending[key]({ ok: true, jobId: key, data: { summary: 'Offline acceptance completed' } });
  }, route);
  await page.waitForFunction(() => promptTaskState().activeCount === 1);
  check(name + ' completed and technical expansion survives task state changes', await completed.evaluate(el => el.open) && await failedDetail.evaluate(el => el.open));
  const remaining = await page.evaluate(routeName => promptTaskState().tasks.find(task => task.jobId === 'offline-task-status-' + routeName + '-b'), route);
  const independent = await page.evaluate(routeName => {
    const jobId = 'offline-task-status-' + routeName + '-c';
    sendRuntime('ANALYZE_IMAGE', { jobId, payload: { linkId: '独立任务', offlineFixture: 'c' } }).then(response => window.__taskStatusFixture.results.push({ jobId, response }));
    return promptTaskState().activeCount;
  }, route);
  await page.locator(`[data-task-end="${remaining.id}"]`).click();
  await page.waitForFunction(id => promptTaskState().tasks.find(task => task.id === id)?.status === 'ended', remaining.id);
  const isolation = await page.evaluate(() => ({ state: promptTaskState(), cancelled: window.__taskStatusFixture.cancelled }));
  check(name + ' ending one task leaves another running', independent === 2 && isolation.state.activeCount === 1 && isolation.state.tasks.find(task => task.jobId === 'offline-task-status-' + route + '-c')?.status === 'running' && isolation.cancelled.length === 1, isolation);
  check(name + ' expanded details stay open after ending an independent task', await completed.evaluate(el => el.open) && await failedDetail.evaluate(el => el.open));
  await completed.locator('summary').first().click();
  const finalRunning = isolation.state.tasks.find(task => task.jobId === 'offline-task-status-' + route + '-c');
  await page.locator(`[data-task-end="${finalRunning.id}"]`).focus();
  check(name + ' async completion focus fixture starts on running button with completed group closed', !await completed.evaluate(el => el.open) && await page.locator(`[data-task-end="${finalRunning.id}"]`).evaluate(el => el === document.activeElement));
  await page.evaluate(routeName => {
    const key = 'offline-task-status-' + routeName + '-c';
    window.__taskStatusFixture.pending[key]({ ok: true, jobId: key, data: { summary: 'Offline focus regression completed' } });
  }, route);
  await page.waitForFunction(() => promptTaskState().activeCount === 0);
  const focusAfterCompletion = await completed.evaluate(el => ({ open: el.open, focusedSummary: el.querySelector('summary') === document.activeElement, hiddenRowFocused: !!document.activeElement?.closest('[data-task-id]'), count: el.querySelectorAll('[data-task-id]').length }));
  check(name + ' async completion moves focus to collapsed completed summary', !focusAfterCompletion.open && focusAfterCompletion.focusedSummary && !focusAfterCompletion.hiddenRowFocused && focusAfterCompletion.count === 10, focusAfterCompletion);
  await page.keyboard.press('Escape');
  await page.locator('#promptTaskDialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement === document.getElementById('promptTaskOpen') && document.getElementById('promptTaskOpen').getAttribute('aria-expanded') === 'false');
  check(name + ' Escape closes drawer and returns keyboard focus', await page.locator('#promptTaskOpen').evaluate(el => document.activeElement === el && el.getAttribute('aria-expanded') === 'false'));
  if (size.name === 'desktop') {
    await page.locator('#promptTaskOpen').click();
    const modalBounds = await page.locator('#promptTaskDialog').boundingBox();
    await page.mouse.click(Math.max(1, modalBounds.x / 2), 50);
    await page.locator('#promptTaskDialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement === document.getElementById('promptTaskOpen') && document.getElementById('promptTaskOpen').getAttribute('aria-expanded') === 'false');
    check(name + ' real backdrop click closes drawer and returns keyboard focus', await page.locator('#promptTaskOpen').evaluate(el => document.activeElement === el && el.getAttribute('aria-expanded') === 'false'));
  }
  await page.evaluate(() => { if (promptTaskRenderTimer) clearTimeout(promptTaskRenderTimer); });
  return fixture;
}

async function main() {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/api/auth/me' && request.method === 'GET') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: { id: 'offline-task-status-fixture', tenantId: 'offline-task-status', username: 'fixture', creativeEntitlement: { allowed: true } } })); return; }
    if (url.pathname === '/api/creative/credits' && request.method === 'GET') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: { centsPerPoint: 10, models: [], plan: { code: 'offline', name: '离线验收', multiplierBps: 10000, ruleVersion: 1 } } })); return; }
    if (url.pathname.startsWith('/api/')) { blockedRequests.push({ path: url.pathname, method: request.method }); response.writeHead(403, { 'Content-Type': 'application/json' }); response.end('{"error":"Offline acceptance blocks business APIs"}'); return; }
    let file;
    try { file = path.resolve(assets, '.' + decodeURIComponent(url.pathname)); } catch { response.writeHead(400); response.end(); return; }
    if (!file.startsWith(assets + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { missingStaticRequests.push({ path: url.pathname, method: request.method }); response.writeHead(404); response.end('Not found'); return; }
    const bytes = fs.readFileSync(file); servedAssets.set(path.relative(assets, file), { bytes: bytes.length, sha256: sha256(bytes) });
    response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream'); response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  for (const size of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: size.name === 'mobile', deviceScaleFactor: 1 });
    context.setDefaultTimeout(7000);
    await context.addInitScript(() => { window.__SANJIE_ENVIRONMENT = 'viral-task-status-offline-20261016'; });
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      externalRequests.push({ url: route.request().url(), method: route.request().method() }); return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push({ url: page.url(), message: error.message }));
    let previousFixture;
    for (const route of ['case', 'style-refresh']) {
      try {
        await page.goto(origin + '/creative/labs/image-prompt-lab/promptlab.html?mode=viral&source=web&layout=1&workflow=1&creativeRoute=' + route);
        await page.waitForFunction(() => document.documentElement.dataset.labStartup === 'ready' && typeof promptTaskState === 'function');
        const routeState = await page.evaluate(() => ({ ready: document.documentElement.dataset.labStartup, workflow: document.body.dataset.viralWorkflow, dedicated: document.body.classList.contains('viral-dedicated-workspace'), activeRoute: state.viralCoreRoute }));
        check(`${route}-${size.name} actual dedicated route is ready`, routeState.ready === 'ready' && routeState.workflow === route && routeState.dedicated && routeState.activeRoute === route, routeState);
        if (previousFixture) {
          const fresh = await page.evaluate(owner => { state.archiveAccountKey = owner; return { tasks: promptTaskState().tasks, key: promptTaskStorageKey(owner) }; }, previousFixture.owner);
          check(`${size.name} case and style journals are isolated`, fresh.tasks.length === 0 && fresh.key !== previousFixture.key, { previousKey: previousFixture.key, nextKey: fresh.key, freshCount: fresh.tasks.length });
        }
        previousFixture = await verifyScenario(page, route, size);
      } catch (error) {
        check(`${route}-${size.name} acceptance completes`, false, error.stack || error.message);
        await page.screenshot({ path: path.join(output, `${route}-${size.name}-failure.png`) }).catch(() => {});
      }
    }
    await context.close();
  }
  check('no page JavaScript errors', errors.length === 0, errors);
  check('no missing static resources', missingStaticRequests.length === 0, missingStaticRequests);
  check('no business API or external network attempts', blockedRequests.length === 0 && externalRequests.length === 0, { blockedRequests, externalRequests });
}

main().catch(error => check('acceptance runner completes', false, error.stack || error.message)).finally(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  const assetEvidence = [...servedAssets].map(([file, info]) => ({ path: file, ...info, stable: fs.existsSync(path.join(assets, file)) && sha256(fs.readFileSync(path.join(assets, file))) === info.sha256 }));
  check('served assets remained stable throughout acceptance', assetEvidence.every(item => item.stable));
  const result = { schema: 'SANJIE_VIRAL_TASK_STATUS_BROWSER_ACCEPTANCE_V1', assetRoot: assets, outputRoot: output, origin, passed: checks.filter(item => item.passed).length, total: checks.length, checks, errors, blockedRequests, externalRequests, missingStaticRequests, servedAssets: assetEvidence, userBrowserUsed: false, realProvider: false, billingUsed: false, productionChanged: false, userDraftChanged: false, durationMs: Date.now() - startedAt };
  fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ passed: result.passed, total: result.total, durationMs: result.durationMs, failures: checks.filter(item => !item.passed), outputRoot: output }, null, 2));
  if (result.passed !== result.total) process.exitCode = 1;
});
