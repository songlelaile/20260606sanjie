/* Isolated local Chrome acceptance. Auth/model responses are local fixtures; all live provider/business requests are blocked. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { chromium } = require('/Users/shaozhuang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const defaultAssets = path.join(root, 'public');
const assets = process.env.CREATIVE_PUBLIC_TEST_ROOT ? path.resolve(process.env.CREATIVE_PUBLIC_TEST_ROOT) : defaultAssets;
const output = process.env.CREATIVE_BROWSER_TEST_OUTPUT ? path.resolve(process.env.CREATIVE_BROWSER_TEST_OUTPUT) : path.join(root, '.codex-deploy/list-image-workspace-20261002/browser');
const candidate = assets !== defaultAssets;
const environment = 'list-image-workspace-20261002';
const checks = [], errors = [], requests = [], blockedExternal = [], resourceFailures = [], dialogs = [];
const mockModelRequests = [], mockModelResponses = [];
let server, context, page, profile;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (name, passed, detail) => {
  checks.push({ name, passed: Boolean(passed), detail });
  if (!passed) throw new Error(name + ': ' + JSON.stringify(detail));
};
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

async function ready() {
  await page.waitForFunction(() => window.SZ_IMAGE_UPLOAD && window.SZ_CREATIVE_TOOLS_BRIDGE && document.querySelector('.sl-workspace'));
  await page.waitForFunction(() => document.documentElement.dataset.labStartup === 'ready');
}
async function screenshot(name) {
  await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true });
}
async function checkOverflow(name) {
  const geometry = await page.evaluate(() => ({
    width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll('body *')].filter(node => node.getClientRects().length).map(node => {
      const rect = node.getBoundingClientRect();
      return { id: node.id, tag: node.tagName, className: String(node.className), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
    }).filter(item => item.left < -1 || item.right > innerWidth + 1).slice(0, 20)
  }));
  check(name + ' has no horizontal overflow', geometry.scrollWidth <= geometry.width, geometry);
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/auth/me') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { id: 'list-image-local-fixture', tenantId: 'list-image-uat', username: 'fixture', creativeEntitlement: { allowed: true } } }));
      return;
    }
    if (url.pathname === '/api/creative/credits' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { centsPerPoint: 10, plan: { code: 'local-fixture', name: '本地验证', multiplierBps: 10000, ruleVersion: 1 }, models: [], observedAt: new Date().toISOString() } }));
      return;
    }
    if (url.pathname === '/api/creative/proxy' && req.method === 'POST' && mockModelResponses.length) {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const proxy = JSON.parse(Buffer.concat(chunks).toString());
        const upstream = new URL(proxy.url);
        if (upstream.origin !== 'https://mock-model.invalid' || upstream.pathname !== '/v1/chat/completions' || proxy.method !== 'POST') throw new Error('Unexpected model fixture route');
        const body = JSON.parse(proxy.bodyText);
        mockModelRequests.push({ route: upstream.origin + upstream.pathname, model: body.model, messages: body.messages });
        const fixture = mockModelResponses.shift();
        res.writeHead(fixture.status || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(fixture.status ? { error: fixture.error } : { choices: [{ message: { content: JSON.stringify(fixture.data) } }] }));
      } catch (error) {
        requests.push({ path: url.pathname, method: req.method, error: error.message });
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end('{"error":"Model fixture rejected the request"}');
      }
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      requests.push({ path: url.pathname, method: req.method });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{"error":"Provider and business endpoints are blocked in local acceptance"}');
      return;
    }
    let file;
    try { file = path.resolve(assets, '.' + decodeURIComponent(url.pathname)); }
    catch { res.writeHead(400); res.end('Bad path'); return; }
    if (!file.startsWith(assets + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end('Not found'); return;
    }
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const base = origin + '/creative/labs/image-prompt-lab/promptlab.html';
  const mainUrl = base + '?mode=main&source=web&layout=1';
  const referenceUrl = base + '?mode=detail&detailMode=reference&source=detail-reference&layout=1';
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sanjie-list-image-uat-'));
  context = await chromium.launchPersistentContext(profile, {
    headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    viewport: { width: 1440, height: 1100 }
  });
  context.setDefaultTimeout(15000);
  await context.addInitScript(value => { window.__SANJIE_ENVIRONMENT = value; }, environment);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    blockedExternal.push({ origin: url.origin, pathname: url.pathname, method: route.request().method() });
    return route.abort();
  });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.status() >= 400) resourceFailures.push({ url: response.url(), status: response.status() });
  });
  page.on('requestfailed', request => resourceFailures.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on('dialog', async dialog => { dialogs.push({ type: dialog.type(), message: dialog.message() }); await dialog.accept(); });

  await page.goto(mainUrl);
  await ready();
  check('list image route has the new title', await page.locator('#labHeroTitle').textContent() === '清单成图');
  check('generic knowledge output contract is loaded without the removed connector', await page.evaluate(() => Boolean(window.SZKnowledgeOutputContract) && !window.SZObsidianKnowledge));
  check('list image page exposes no removed knowledge connector entry', await page.evaluate(() => !document.querySelector('[id*="obsidian" i], [id*="Obsidian"]')));
  check('list image visible text has no removed knowledge connector', !/obsidian/i.test(await page.locator('body').innerText()));
  check('list image route uses the real main form', await page.locator('.sl-main').count() === 1 && await page.locator('#studioGenesisRoot').count() === 0);
  const required = ['#linkJson', '#linkTableFile', '#batchLinkStart', '#batchLinkEnd', '#buildPromptBtn', '#batchLinksBtn', '#refFile', '#productFrontFile', '#cnPrompt', '#generateBtn', '#linkNumberGenerateBtn', '#imageRatio', '#imageResolution', '#imageCount', '#downloadAllBtn', '#mainStitchBtn'];
  const controls = [];
  for (const selector of required) {
    // Native file inputs live inside the visible shared upload or file-picker component.
    const locator = page.locator(selector);
    const visible = selector.endsWith('File') ? await locator.locator('..').isVisible() : await locator.isVisible();
    controls.push({ selector, visible });
  }
  check('all list image inputs and generation controls are visible', controls.every(item => item.visible), controls);
  check('main progress lists the complete flow', (await page.locator('#studioLegacySteps').textContent()).includes('生成提示词'));

  const rows = [
    { '链接编号': 'L001', '链接定位': '家庭日常收纳', '主推关键词': '收纳盒', '用户场景需求': '桌面整理', '差异化定位逻辑': '展示清楚分类', '主图核心文案': '有序收纳', '详情页定位': '家庭日常收纳', '详情页文案': '有序收纳', '详情文案逻辑': '先展示用途再展示细节', category: '收纳用品' },
    { '链接编号': 'L002', '链接定位': '办公桌收纳', '主推关键词': '桌面收纳', '用户场景需求': '办公整理', '差异化定位逻辑': '展示分区', '主图核心文案': '桌面清爽', '详情页定位': '办公桌收纳', '详情页文案': '桌面清爽', '详情文案逻辑': '先场景再规格', category: '收纳用品' }
  ];
  const headers = Object.keys(rows[0]);
  const csv = '\ufeff' + headers.join(',') + '\n' + rows.map(row => headers.map(key => row[key]).join(',')).join('\n');
  await page.locator('#linkTableFile').setInputFiles({ name: 'local-two-links.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.waitForFunction(() => document.getElementById('linkState').textContent.includes('2 条 JSON'));
  const csvResult = await page.locator('#linkJson').inputValue().then(JSON.parse);
  check('CSV imports two exact link rows locally', csvResult.rows.length === 2 && csvResult.rows[0]['链接编号'] === 'L001' && csvResult.rows[1]['链接编号'] === 'L002', csvResult.rows.map(row => row['链接编号']));
  check('CSV import projects positioning and copy', await page.locator('#positioning').inputValue() === rows[0]['链接定位'] && await page.locator('#imageCopy').inputValue() === rows[0]['主图核心文案']);
  check('CSV import sets L range correctly', await page.locator('#batchLinkStart').inputValue() === 'L001' && await page.locator('#batchLinkEnd').inputValue() === 'L002');
  await page.locator('#linkTableFile').setInputFiles({ name: 'local-two-links.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ category: '收纳用品', rows })) });
  await page.waitForFunction(() => document.getElementById('linkTableImportState').textContent.includes('local-two-links.json') && !document.getElementById('linkTableImportState').textContent.includes('正在'));
  const jsonResult = await page.locator('#linkJson').inputValue().then(JSON.parse);
  check('JSON file import preserves two links and category', jsonResult.rows.length === 2 && jsonResult.category === '收纳用品', { ids: jsonResult.rows.map(row => row['链接编号']), category: jsonResult.category });
  await page.locator('#batchLinkStart').fill('L002');
  await page.locator('#batchLinkEnd').fill('L002');
  const selection = await page.evaluate(() => selectRowsByLinkRange(state.linkList));
  check('L range selects only the requested second link', selection.rows.length === 1 && selection.rows[0]['链接编号'] === 'L002' && selection.missing.length === 0, selection);
  await page.locator('#batchLinkStart').fill('L001');

  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 200;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#e8dcc7'; ctx.fillRect(0, 0, 300, 200); ctx.fillStyle = '#64755a'; ctx.fillRect(65, 35, 170, 130);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  const referencePng = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 200;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#dddddd'; ctx.fillRect(0, 0, 300, 200); ctx.fillStyle = '#445976'; ctx.fillRect(30, 65, 240, 100);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  fs.writeFileSync(path.join(output, 'local-upload-fixture.png'), png);
  fs.writeFileSync(path.join(output, 'local-reference-fixture.png'), referencePng);
  await page.locator('#refFile').setInputFiles({ name: 'local-reference.png', mimeType: 'image/png', buffer: referencePng });
  await page.locator('#refPreview img').first().waitFor();
  check('reference upload is retained in the main route', await page.locator('#refPreview img').count() === 1);
  const missingSubject = await page.evaluate(() => analyzeCurrentImage());
  check('reference analysis requires product evidence before any model request', !missingSubject.ok && /主体图/.test(missingSubject.error) && mockModelRequests.length === 0, missingSubject);
  await page.locator('#productSubjectClose').click();
  await page.locator('#productSubjectModal').waitFor({ state: 'hidden' });
  await page.locator('#productFrontFile').setInputFiles({ name: 'local-product.png', mimeType: 'image/png', buffer: png });
  await page.locator('#productFrontPreview img').waitFor();
  await page.waitForFunction(() => !SZ_IMAGE_UPLOAD.isImporting());
  check('product upload supplies the main product identity', await page.locator('#productFrontPreview img').count() === 1 && await page.evaluate(() => productImageList().length === 1));
  const originals = await page.evaluate(async () => {
    const databases = await indexedDB.databases(), result = [];
    for (const descriptor of databases.filter(item => item.name.startsWith('sz_image_upload_originals_v1'))) {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open(descriptor.name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const items = await new Promise((resolve, reject) => { const request = db.transaction('originals').objectStore('originals').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      for (const item of items) result.push({ name: item.name, owner: item.accountKey, bytes: Array.from(new Uint8Array(await item.blob.arrayBuffer())) });
      db.close();
    }
    return result;
  });
  check('reference and product original bytes remain unchanged', [['local-reference.png', referencePng], ['local-product.png', png]].every(([name, bytes]) => originals.some(item => item.name === name && sha(Buffer.from(item.bytes)) === sha(bytes))), originals.map(item => ({ name: item.name, owner: item.owner, bytes: item.bytes.length, sha256: sha(Buffer.from(item.bytes)) })));
  await page.locator('#productFrontPreview img').click();
  await page.locator('.cu-dialog').waitFor({ state: 'visible' });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载原图', exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs(path.join(output, 'downloaded-product-original.png'));
  check('downloaded original matches upload bytes', sha(fs.readFileSync(path.join(output, 'downloaded-product-original.png'))) === sha(png));
  await page.keyboard.press('Escape');

  // The website shell now owns the visible settings entry; exercise its shared modal in this isolated iframe.
  await page.evaluate(() => openConfigModal());
  await page.locator('#configModal').waitFor({ state: 'visible' });
  check('API settings expose local configuration controls', await page.locator('#apiKey').isVisible() && await page.locator('#provider').isVisible() && await page.locator('#apiKey').inputValue() === '');
  await screenshot('main-api-settings');
  await page.locator('#configCloseBtn').click();
  await page.locator('#configModal').waitFor({ state: 'hidden' });
  check('API settings close and return to main workspace', await page.locator('#generateBtn').isVisible());
  await page.evaluate(() => applyCfg(normalizeCfg({ provider: 'openai-compatible', apiKey: '', visionBaseUrl: 'https://mock-model.invalid/v1', imageEndpoint: 'https://mock-model.invalid/v1/images/generations' })));
  await page.locator('#generateBtn').click();
  await page.waitForFunction(() => !document.getElementById('generateBtn').disabled && /API|Key|配置|失败|Obsidian|未加载/.test(document.getElementById('generateState').textContent));
  const failedState = await page.locator('#generateState').textContent();
  check('generation fails visibly and unlocks controls', Boolean(failedState) && await page.locator('#generateState').isVisible(), failedState);
  check('missing API leaves results empty', await page.locator('#resultGrid .result-card').count() === 0);

  // Run the actual button/background/proxy/validation/save path with a local response only.
  // Obsolete connector preferences remain present to verify they cannot gate this request.
  await page.evaluate(async () => {
    await chrome.storage.local.set({ sz_obsidian_connection_v1: { enabled: true, endpoint: 'https://removed-connector.invalid', scopes: { main: true, detail: true, link: true } } });
    applyCfg(normalizeCfg({ provider: 'openai-compatible', apiKey: 'SYNTHETIC_LOCAL_FIXTURE_KEY', visionBaseUrl: 'https://mock-model.invalid/v1', visionModel: 'local-vision-fixture' }));
  });
  const expectedPrompt = '保持商品主体的矩形轮廓与原有颜色，参考平视构图和柔和光影，置于简洁桌面。';
  const displayedPrompt = await page.evaluate(prompt => ensurePromptSubjectRule(prompt, 'zh'), expectedPrompt);
  const fixtureData = { '中文提示词': expectedPrompt, '生图逻辑': '只借鉴参考图片的构图，商品主体保持输入图片所示结构。', '画面布局': '主体居中，桌面留白', '负面提示词': '不要变形、不要改色', '4方向': ['主图转化版', '场景种草版', '视觉锤版', '差异化表达版'] };
  mockModelResponses.push({ data: fixtureData });
  await page.locator('#analyzeBtn').click();
  await page.waitForFunction(() => !document.getElementById('analyzeBtn').disabled && document.getElementById('runState').textContent === '提词完成');
  check('reference analysis returns and displays the validated local model prompt', await page.locator('#cnPrompt').inputValue() === displayedPrompt && mockModelRequests.length === 1);
  const requestEvidence = mockModelRequests[0].messages.flatMap(item => Array.isArray(item.content) ? item.content : []).filter(item => item.type === 'image_url');
  check('reference analysis sends both reference and original product evidence', requestEvidence.length === 2 && requestEvidence.every(item => /^data:image\//.test(item.image_url.url)), { imageCount: requestEvidence.length });
  const analyzedRecord = await page.evaluate(() => ({ reference: state.referenceAnalysis, record: state.referencePrompts.main }));
  check('reference analysis saves its image identity and prompt record', analyzedRecord.reference?.data?.['中文提示词'] === expectedPrompt && Boolean(analyzedRecord.reference.productFingerprint) && analyzedRecord.record?.prompt === displayedPrompt && analyzedRecord.record.source === 'reference', { referenceAnalysis: analyzedRecord.reference, promptRecordId: analyzedRecord.record?.id });
  await screenshot('main-reference-analysis');

  mockModelResponses.push({ status: 401, error: { code: 'invalid_api_key', message: 'Local model fixture rejected the synthetic key' } });
  await page.locator('#analyzeBtn').click();
  await page.waitForFunction(() => !document.getElementById('analyzeBtn').disabled && /API|Key|鉴权|401|key/.test(document.getElementById('runState').textContent));
  const modelFailure = await page.locator('#runState').textContent();
  check('reference model authentication failure is visible and unlocks the button', Boolean(modelFailure) && mockModelRequests.length === 2, modelFailure);
  check('failed reference analysis preserves the previous valid prompt and product uploads', await page.locator('#cnPrompt').inputValue() === displayedPrompt && await page.locator('#productFrontPreview img').count() === 1);
  mockModelResponses.push({ data: fixtureData });
  await page.locator('#analyzeBtn').click();
  await page.waitForFunction(() => !document.getElementById('analyzeBtn').disabled && document.getElementById('runState').textContent === '提词完成');
  check('reference analysis can retry after a model error', mockModelRequests.length === 3 && await page.locator('#cnPrompt').inputValue() === displayedPrompt);
  await page.evaluate(() => applyCfg(normalizeCfg({ provider: 'openai-compatible', apiKey: '', visionBaseUrl: 'https://mock-model.invalid/v1', imageEndpoint: 'https://mock-model.invalid/v1/images/generations' })));

  // A local result fixture verifies the existing copy/share UI only; this is not a generated image.
  await page.evaluate(data => {
    state.results = [{ id: 'local-result-fixture', url: data.url, variantName: '本地 UI 验证素材', prompt: '仅用于分享卡界面验证', createdAt: Date.now() }];
    renderResults();
  }, { url: 'data:image/png;base64,' + png.toString('base64') });
  await page.getByRole('button', { name: '复制图片', exact: true }).click();
  await page.locator('#imageActionModal').waitFor({ state: 'visible' });
  check('result copy modal includes original and share-card actions', await page.locator('#copyOriginalImageBtn').isVisible() && await page.locator('#copyShareCardBtn').isVisible());
  check('share-card style controls remain available', await page.locator('#imageActionModal [data-share-card="position"]').isVisible() && await page.locator('#imageActionModal [data-share-card="border"]').isVisible() && await page.locator('#imageActionModal [data-share-card="ratio"]').isVisible());
  await screenshot('main-share-card-settings');
  await page.locator('#imageActionClose').click();
  await page.locator('#clearResultsBtn').click();
  check('local fixture clears without removing uploaded inputs', await page.locator('#resultGrid .result-card').count() === 0 && await page.locator('#productFrontPreview img').count() === 1);
  await checkOverflow('1440px main');
  await screenshot('main-1440');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'main-1440-upper.png') });
  await page.setViewportSize({ width: 375, height: 900 });
  await checkOverflow('375px main');
  await screenshot('main-375');

  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(referenceUrl);
  await ready();
  check('reference route uses the new title', await page.locator('#labHeroTitle').textContent() === '清单成详');
  check('reference route retains formal source workflow', await page.locator('#referenceDetailSourceFile').locator('..').isVisible() && await page.locator('#referenceDetailBuildBtn').isVisible());
  const visibleText = await page.locator('body').innerText();
  check('reference route visible text has no old name', !visibleText.includes('参考成详'));
  check('reference route still requires a formal source', await page.locator('#referenceDetailBuildBtn').isDisabled());
  await checkOverflow('1440px reference');
  await screenshot('reference-1440');
  await page.setViewportSize({ width: 375, height: 900 });
  await checkOverflow('375px reference');
  await screenshot('reference-375');

  check('no live provider or unrelated business API request was attempted', requests.length === 0, requests);
  check('all model requests ended at the local fixture', mockModelResponses.length === 0 && mockModelRequests.length === 3, mockModelRequests.map(item => ({ route: item.route, model: item.model })));
  check('removed connector was never requested', !resourceFailures.some(item => /obsidian|removed-connector/i.test(item.url)) && !blockedExternal.some(item => /obsidian|removed-connector/i.test(item.pathname)), resourceFailures);
  check('no external network request was attempted', blockedExternal.length === 0, blockedExternal);
  check('all page assets load; only the intentional local authentication fixture is rejected', resourceFailures.length === 1 && resourceFailures.every(item => item.status === 401 && new URL(item.url).pathname === '/api/creative/proxy'), resourceFailures);
  check('browser page errors absent', errors.length === 0, errors);
  // Keep this assertion last so independent layout and share-card evidence survives prerequisite failures.
  check('generation without API reaches visible missing-API validation', /API|Key|配置/.test(failedState), { clicked: '#generateBtn', state: failedState });
}

main().catch(async error => {
  errors.push(error.stack || error.message);
  if (page) {
    await screenshot('failure').catch(() => {});
    const debug = await page.evaluate(() => ({ url: location.href, startup: document.documentElement.dataset.labStartup, bodyClass: document.body.className, title: document.getElementById('labHeroTitle')?.textContent, generateState: document.getElementById('generateState')?.textContent, linkState: document.getElementById('linkState')?.textContent, importState: document.getElementById('linkTableImportState')?.textContent })).catch(() => null);
    errors.push(JSON.stringify(debug));
  }
  process.exitCode = 1;
}).finally(async () => {
  if (context) await context.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  const result = { passed: checks.filter(item => item.passed).length, total: checks.length, checks, errors, requests, mockModelRequests: mockModelRequests.map(item => ({ route: item.route, model: item.model, imageCount: item.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'image_url').length })), blockedExternal, resourceFailures, dialogs, sourceAssetRoot: assets, candidate, realProvider: false, mockAuth: true, mockModel: true, isolatedProfile: true };
  if (!errors.length && result.passed === result.total) fs.rmSync(path.join(output, 'failure.png'), { force: true });
  fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, total: result.total, failed: checks.filter(item => !item.passed), errors, requests, blockedExternal, resourceFailures, sourceAssetRoot: assets, candidate, realProvider: false, mockAuth: true, isolatedProfile: true }, null, 2));
});
