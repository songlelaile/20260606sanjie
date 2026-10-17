// Run the original multi-route regression fixture against the website overlay.
'use strict';

import { it as test, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

interface RouteEvent { type: string; detail: { route: string } }
interface FixtureElement {
  id: string; value: string; textContent: string; dataset: Record<string, string>;
  attributes: Record<string, string>; children: FixtureElement[];
  listeners: Record<string, (...args: unknown[]) => void>; tagName?: string;
  disabled?: boolean; hidden?: boolean;
  classList: { contains(name: string): boolean; add(name: string): void; remove(name: string): void; toggle(name: string, on: boolean): void };
  setAttribute(name: string, value: string): void;
  appendChild(child: FixtureElement): FixtureElement;
  addEventListener(name: string, listener: (...args: unknown[]) => void): void;
}
interface RouteResult { creativeRoute: string; url?: string; batchId?: string; detailScreenIndex?: number; styleRefreshQa?: { status: string } }
interface RouteReply { ok: boolean; code?: string; images?: string[]; promptRecord?: { prompt: string; data: Record<string, unknown> }; assessments?: Array<{ status: string }> }
type Deferred<T> = { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void; reject(reason?: unknown): void };

const root = path.resolve(process.env.CREATIVE_ASSET_TEST_ROOT || 'public/creative');

function loadRoute(search = '') {
  const elements = new Map<string, FixtureElement>();
  const events: RouteEvent[] = [];
  let createdElementCount = 0;
  function element(id: string): FixtureElement {
    const existing = elements.get(id);
    if (existing) return existing;
    const classes = new Set();
    const value: FixtureElement = {
      id, value: '', textContent: '', dataset: {}, attributes: {}, children: [], listeners: {},
      classList: {
        contains: (name) => classes.has(name),
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }
      },
      setAttribute(name, value) { this.attributes[name] = value; },
      appendChild(child) { this.children.push(child); return child; },
      addEventListener(name, listener) { this.listeners[name] = listener; }
    };
    elements.set(id, value);
    return value;
  }
  const document = {
    body: element('body'),
    getElementById: element,
    createElement(tag: string) { const node = element('created-' + (++createdElementCount)); node.tagName = tag.toUpperCase(); return node; },
    addEventListener() {},
    dispatchEvent(event: RouteEvent) { events.push(event); }
  };
  document.body.classList.add('viral-lab-mode');
  const context: vm.Context = {
    document, window: {}, location: { search }, console, URL, URLSearchParams, setTimeout, clearTimeout,
    CustomEvent: class { type: string; detail: RouteEvent['detail']; constructor(type: string, options: { detail: RouteEvent['detail'] }) { this.type = type; this.detail = options.detail; } }
  };
  vm.createContext(context);
  for (const file of ['viral-series-contract.js', 'style-refresh-contract.js', 'promptlab.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'labs/image-prompt-lab', file), 'utf8'), context, { filename: file });
  }
  // Route tests execute the actual transition, settings, archive, and generation
  // entry functions; rendering unrelated panels is outside this fixture.
  context.originalSyncDetailModeControls = context.syncDetailModeControls;
  for (const name of ['renderStyleRefreshControls', 'syncDetailModeControls', 'syncGenerationModeLabels', 'renderResults']) context[name] = () => {};
  element('detailScreenCount').value = '7';
  element('detailRatio').value = '4:5';
  element('detailResolution').value = '4K';
  return { context, element, events };
}

test('三个专属入口在初始化和后续调用中锁定自身路线，计划与历史归属不受旧模式切换影响', () => {
  for (const route of ['case', 'style-refresh', 'scene-extension']) {
    const { context: c, element } = loadRoute('?mode=viral&source=web&layout=1&workflow=1&creativeRoute=' + route);
    c.setViralCoreRoute('case', { silent: true });
    assert.equal(c.state.viralCoreRoute, route);
    assert.equal(element('body').attributes['data-viral-workflow'], route);
    assert.equal(element('body').classList.contains('viral-dedicated-workspace'), true);
    assert.equal(c.document.title, '少壮图片实验室 · ' + c.archiveRouteLabel({ surfaceMode: 'viral', creativeRoute: route }));
    const prompt = { prompt: '当前页独立草稿', data: { route } };
    c.state.activePromptRecord = prompt;
    c.setReferenceDetailMode('story');
    assert.equal(c.state.activePromptRecord, prompt);
    assert.equal(c.state.detailReferenceMode, route === 'case' ? 'viral' : route);
    for (const name of ['syncReferenceDetailStoryRouteClass', 'syncDetailWorkflowUi', 'renderReferenceDetailBatch', 'renderStyleRefreshWorkStatus']) c[name] = () => {};
    c.setDetailMode('link');
    assert.equal(c.state.detailMode, 'reference');
    assert.equal(c.state.activePromptRecord, prompt);
    c.applyViralQueryParams(new URLSearchParams('creativeRoute=case&viralCount=12'));
    assert.equal(c.state.viralCoreRoute, route);
    assert.equal(c.archiveSurfaceForItem({ creativeRoute: route, labMode: 'detail' }), 'viral');
    assert.equal(c.archiveRouteKey({ surfaceMode: 'viral', creativeRoute: route }), route);
  }
});

test('只有完整专属网址锁定路线，旧工作台与插件依旧自由切换三种方式', () => {
  for (const search of [
    '?mode=viral&source=web&layout=1&creativeRoute=case',
    '?mode=viral&source=web&layout=1&workflow=1&creativeRoute=unknown',
    '?mode=viral&source=plugin&layout=1&workflow=1&creativeRoute=case',
    '?mode=viral&source=web&layout=1&workflow=1&creativeRoute=case&studio=1',
    '?mode=detail&source=web&layout=1&workflow=1&creativeRoute=case',
    '?mode=viral&source=web&workflow=1&creativeRoute=case'
  ]) {
    const { context: c, element } = loadRoute(search);
    assert.equal(c.pinnedViralWorkflowRoute(), '');
    c.setViralCoreRoute('style-refresh');
    assert.equal(c.state.viralCoreRoute, 'style-refresh');
    c.setViralCoreRoute('scene-extension');
    assert.equal(c.state.viralCoreRoute, 'scene-extension');
    assert.equal(element('body').classList.contains('viral-dedicated-workspace'), false);
  }
});

test('三个专属入口在任何外部脚本载入前显示对应名称，沿用已有启动遮罩', () => {
  const html = fs.readFileSync(path.join(root, 'labs/image-prompt-lab/promptlab.html'), 'utf8');
  const script = html.match(/<script id="labStartupScript">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  for (const [route, label] of [['case', '案例裂变'], ['style-refresh', '风格焕新'], ['scene-extension', '场景延展']]) {
    const document = { title: '', documentElement: { dataset: {} as Record<string, string> }, addEventListener() {} };
    vm.runInNewContext(script, { document, URLSearchParams,
      location: { search: '?mode=viral&source=web&layout=1&workflow=1&creativeRoute=' + route },
      window: { addEventListener() {} }, setTimeout() { return 1; }, clearTimeout() {}
    });
    assert.equal(document.title, '少壮AI · ' + label);
    assert.equal(document.documentElement.dataset.labStartup, 'pending');
  }
});

test('焕新和场景专属页不把旧单参考图交接写入自身素材，不触发供应商', async () => {
  for (const route of ['style-refresh', 'scene-extension']) {
    const { context: c, element } = loadRoute('?mode=viral&source=web&layout=1&workflow=1&creativeRoute=' + route);
    c.setViralCoreRoute('case', { silent: true });
    let sideEffects = 0;
    for (const name of ['send', 'setRefImage', 'resetSkuVisualLock', 'analyzeCurrentImage']) c[name] = () => { sideEffects++; };
    const before = JSON.stringify(c.state);
    const reply = await c.applyContextImage({ imageUrl: 'https://example.invalid/old-reference.png', importRoute: 'sku' }, true);
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'DEDICATED_VIRAL_PRODUCT_UPLOAD_REQUIRED');
    assert.equal(sideEffects, 0);
    assert.equal(element('refUrl').value, '');
    assert.equal(JSON.stringify(c.state), before);
  }
});

test('第三路线切换保留案例和焕新各自的提示词与输出参数，发出独立路由事件', () => {
  const { context: c, element, events } = loadRoute();
  const casePrompt = { prompt: '案例原提示词', data: { 来源: '案例' } };
  const stylePrompt = { prompt: '焕新原提示词', data: { 来源: '焕新' } };
  c.state.referencePrompts.detail = casePrompt;
  c.state.styleRefresh.promptRecord = stylePrompt;
  c.state.activePromptRecord = casePrompt;
  c.setViralCoreRoute('scene-extension');
  assert.equal(c.state.activePromptRecord, null);
  assert.equal(c.state.detailReferenceMode, 'scene-extension');
  assert.equal(element('detailPrompt').value, '');
  assert.equal(c.document.body.classList.contains('scene-extension-route'), true);
  assert.equal(element('viralSceneModeBtn').attributes['aria-selected'], 'true');
  assert.equal(element('viralCaseModeBtn').attributes['aria-selected'], 'false');
  assert.equal(element('labHeroTitle').textContent, '场景延展工作台');
  assert.match(element('labHeroSubtitle').textContent, /微观.*近观.*远观/);
  assert.match(element('labHeroSubtitle').textContent, /珠宝饰品.*美妆.*服装/);
  // Hidden legacy controls changing while the independent scene UI is active
  // must never be captured into case or style settings.
  element('detailScreenCount').value = '19';
  element('detailRatio').value = '1:1';
  c.setViralCoreRoute('style-refresh');
  assert.equal(c.state.activePromptRecord, stylePrompt);
  assert.equal(element('detailScreenCount').value, '4');
  element('detailScreenCount').value = '11';
  element('detailRatio').value = '16:9';
  element('detailResolution').value = '2K';
  c.setViralCoreRoute('scene-extension');
  c.setViralCoreRoute('case');
  assert.equal(c.state.activePromptRecord, casePrompt);
  assert.equal(element('detailScreenCount').value, '7');
  assert.equal(element('detailRatio').value, '4:5');
  assert.equal(element('detailResolution').value, '4K');
  assert.equal(c.document.body.classList.contains('scene-extension-route'), false);
  c.setViralCoreRoute('style-refresh');
  assert.equal(element('detailScreenCount').value, '11');
  assert.equal(element('detailRatio').value, '16:9');
  assert.equal(c.state.referencePrompts.detail, casePrompt);
  assert.equal(c.state.styleRefresh.promptRecord, stylePrompt);
  assert.deepEqual(events.map((event) => event.detail.route), ['scene-extension', 'style-refresh', 'scene-extension', 'case', 'style-refresh']);
  assert.ok(events.every((event) => event.type === 'scene-extension-route-change'));
});

test('场景 URL 参数和延迟同步不能污染旧路线设置', () => {
  const { context: c, element } = loadRoute();
  const styleBefore = JSON.stringify(c.state.styleRefresh);
  c.applyViralQueryParams(new URLSearchParams('creativeRoute=scene-extension&viralCount=20&viralRatio=1:1&viralResolution=1K&copyMode=rewrite'));
  assert.equal(c.state.viralCoreRoute, 'scene-extension');
  assert.equal(element('detailScreenCount').value, '7');
  assert.equal(element('detailRatio').value, '4:5');
  assert.equal(element('detailResolution').value, '4K');
  assert.equal(JSON.stringify(c.state.styleRefresh), styleBefore);
  assert.equal(c.captureViralRouteSettings('scene-extension'), null);
  assert.equal(c.restoreViralRouteSettings('scene-extension'), null);
  c.originalSyncDetailModeControls();
  assert.equal(element('detailScreenCount').value, '7');
  assert.equal(c.state.viralRouteSettings['scene-extension'], undefined);
  assert.equal(c.window.SZ_SCENE_EXTENSION_BRIDGE.currentRoute(), 'scene-extension');
});

test('场景档案保留路线、材料名称和镜头角色，不能归入案例或焕新', () => {
  const { context: c } = loadRoute();
  const scene = {
    creativeRoute: 'scene-extension', labMode: 'detail', productName: '65012 浅木纹地板',
    businessRoleName: '铺装近景', businessSummary: '暖白客厅，地板大面积铺装', detailScreenIndex: 2, batchId: 'scene-batch'
  };
  assert.equal(c.archiveSurfaceForItem(scene), 'viral');
  assert.equal(c.archiveRouteKey({ surfaceMode: 'viral', creativeRoute: 'scene-extension' }), 'scene-extension');
  assert.equal(c.archiveRouteLabel({ surfaceMode: 'viral', creativeRoute: 'scene-extension' }), '场景延展');
  assert.equal(c.archiveBatchTitleForItem(scene), '场景延展');
  const meta = c.archiveBusinessMetaForItem(scene);
  assert.equal(meta.businessType, '场景延展');
  assert.equal(meta.businessBatchTitle, '场景延展 · 65012 浅木纹地板');
  assert.equal(meta.businessRoleName, '铺装近景');
  assert.equal(meta.businessSummary, '暖白客厅，地板大面积铺装');
  const asset = { surfaceMode: 'viral', creativeRoute: 'scene-extension' };
  for (const route of ['case', 'style-refresh', 'scene-extension']) {
    c.state.viralCoreRoute = route;
    assert.equal(c.archiveItemCompatibleWithCurrentSurface(asset), route === 'scene-extension');
  }
  assert.equal(c.archiveRouteLabel({ surfaceMode: 'viral' }), '案例裂变');
});

test('旧结果面板仅展示自身路线，场景结果由独立控制器展示', () => {
  const { context: c } = loadRoute();
  c.state.results = ['case', 'style-refresh', 'scene-extension'].map((route) => ({
    creativeRoute: route, labMode: 'detail', url: 'https://example.invalid/' + route,
    batchId: route, resultId: route, detailScreenIndex: 1
  }));
  c.state.styleRefresh.run = { batchId: 'style-refresh' };
  for (const route of ['case', 'style-refresh', 'scene-extension']) {
    c.state.viralCoreRoute = route;
    c.state.detailReferenceMode = route === 'case' ? 'viral' : route;
    const actual = Array.from(c.detailPreviewResults() as RouteResult[], item => item.creativeRoute);
    assert.deepEqual(actual, route === 'scene-extension' ? [] : [route]);
  }
  c.document.body.classList.remove('viral-lab-mode');
  c.document.body.classList.add('detail-lab-mode');
  assert.equal(c.detailPreviewResults().some((item: RouteResult) => item.creativeRoute === 'scene-extension'), false);
});

test('场景激活时旧生成和清空入口在任何副作用前停止', async () => {
  const { context: c } = loadRoute();
  c.setViralCoreRoute('scene-extension');
  let sideEffects = 0;
  for (const name of ['send', 'cfgFromForm', 'productImageList', 'showProductSubjectRequired']) {
    c[name] = () => { sideEffects++; throw new Error('不应使用旧入口'); };
  }
  for (const response of await Promise.all([c.generateOne(), c.generateCurrent(), c.ensureReferencePromptForGeneration()])) {
    assert.equal(response.ok, false);
    assert.equal(response.code, 'SCENE_EXTENSION_SEPARATE_GENERATION');
  }
  const scene = { resultId: 'scene-result', labMode: 'detail', creativeRoute: 'scene-extension', url: 'blob:scene' };
  c.state.results = [scene];
  assert.equal(c.clearSelectedResults().code, 'SCENE_EXTENSION_SEPARATE_RESULTS');
  assert.equal(c.state.results[0], scene);
  assert.equal(sideEffects, 0);
  const bridge = c.window.SZ_SCENE_EXTENSION_BRIDGE;
  c.state.archiveAccountKey = 'account-at-start';
  const archiveContext = bridge.archiveContext();
  c.state.archiveAccountKey = 'account-after-switch';
  assert.equal(archiveContext.accountKey, 'account-at-start');
  assert.equal(bridge.archiveContext().accountKey, 'account-after-switch');
  // R52 repaints the R49 bound API selector when job ownership changes. This
  // route-only harness deliberately forbids cfgFromForm above; skip the
  // unrelated selector repaint while preserving the job ownership assertions.
  c.renderBoundApiSelector = () => {};
  bridge.registerGenerationJob('scene-job');
  assert.equal(c.state.activeJobIds['scene-job'], true);
  bridge.unregisterGenerationJob('scene-job');
  assert.equal(c.state.activeJobIds['scene-job'], undefined);
});

test('案例提词等待期间切到场景后，迟到提示词不能覆盖场景或触发旧生图', async () => {
  const { context: c } = loadRoute();
  let completePrompt: (reply: RouteReply) => void = () => { throw new Error("prompt not started"); };
  let legacyActions = 0;
  c.ensureReferencePromptForGeneration = () => new Promise((resolve) => { completePrompt = resolve; });
  c.displayPromptRecord = () => { legacyActions++; };
  c.generateOne = () => { legacyActions++; return Promise.resolve({ ok: true }); };
  const pending = c.generateCurrent();
  c.setViralCoreRoute('scene-extension');
  completePrompt({ ok: true, promptRecord: { prompt: '迟到的案例提示词', data: {} } });
  const response = await pending;
  assert.equal(response.code, 'VIRAL_ROUTE_CHANGED');
  assert.equal(c.state.activePromptRecord, null);
  assert.equal(legacyActions, 0);
});

test('场景档案不显示旧引导重生；案例和焕新保留各自可用入口', () => {
  const { context: c } = loadRoute();
  c.archiveObjectUrl = () => 'blob:test-image';
  function buttons(node: FixtureElement): FixtureElement[] {
    return (node.tagName === 'BUTTON' ? [node] : []).concat(node.children.flatMap(buttons));
  }
  for (const route of ['scene-extension', 'case', 'style-refresh']) {
    c.state.viralCoreRoute = route;
    const card = c.renderArchiveAssetCard({}, {
      surfaceMode: 'viral', creativeRoute: route, archiveAssetId: route,
      businessRoleName: '测试角色', imageIndex: 1
    }, false);
    const actions = buttons(card);
    const preview = actions.find((button) => button.attributes['aria-label'] === '预览原图：测试角色 · V1');
    assert.ok(preview, '历史原件必须具有可访问名称的预览入口');
    assert.equal(preview.disabled, false);
    const download = actions.find((button) => button.textContent === '下载原图');
    assert.ok(download, '历史原件保留明确的下载原图入口');
    assert.equal(download.attributes['aria-label'], '下载原图：测试角色 · V1');
    assert.equal(download.disabled, false);
    const regenerate = actions.filter((button) => /引导重生|重新生成|生成此图/.test(button.textContent));
    assert.equal(regenerate.length, route === 'scene-extension' ? 0 : 1);
    if (route !== 'scene-extension') assert.equal(regenerate[0].disabled, false);
  }
});

test('场景档案即使切回案例或焕新也不能通过旧弹层、执行器或父图入口生图', async () => {
  const { context: c } = loadRoute();
  let sideEffects = 0;
  for (const name of ['guideDraftForItem', 'loadGuideAnnotationBase', 'refreshGuideAnnotationExports', 'cfgFromForm', 'productImageList', 'send']) {
    c[name] = () => { sideEffects++; throw new Error('场景档案不应进入旧引导重生'); };
  }
  const item = { url: 'blob:scene-history', creativeRoute: 'scene-extension', labMode: 'detail' };
  for (const route of ['case', 'style-refresh']) {
    c.state.viralCoreRoute = route;
    assert.equal(c.openGuideRegenerateModal(item).code, 'SCENE_EXTENSION_SEPARATE_GENERATION');
    assert.equal(c.state.guideDraft, null);
    c.state.guideDraft = { item };
    assert.equal((await c.runGuideRegenerate()).code, 'SCENE_EXTENSION_SEPARATE_GENERATION');
    c.state.guideDraft = null;
    assert.equal((await c.generateOne('guide', '引导重生', 1, { parentItem: item })).code, 'SCENE_EXTENSION_SEPARATE_GENERATION');
  }
  assert.equal(sideEffects, 0);
});

test('官网桥接等待素材上下文、每次刷新账号，并在完整任务期间排他及冻结设置入口', async () => {
  const { context: c } = loadRoute();
  const bridge = c.window.SZ_SCENE_EXTENSION_BRIDGE;
  c.sceneReadyResolve({ ok: true });
  assert.equal((await bridge.ready()).ok, true);
  let owner = 'user:preview:alice';
  let profileReads = 0;
  c.send = async (type: string) => { assert.equal(type, 'GET_CONFIG_PROFILE'); profileReads++; return { ok: true, accountKey: owner }; };
  assert.equal(await bridge.getAccountKey(), owner);
  owner = 'user:preview:bob';
  assert.equal(await bridge.getAccountKey(), owner);
  assert.equal(profileReads, 2);
  let callbacks = 0;
  c.navigator = {};
  await assert.rejects(bridge.withGenerationLock(owner, () => { callbacks++; }), /任务保护/);
  let available = false;
  c.navigator.locks = { request: async (name: string, options: { mode: string; ifAvailable: boolean }, callback: (lock: object | null) => unknown) => {
    assert.equal(name, 'sanjie-scene-generation:' + owner);
    assert.deepEqual(JSON.parse(JSON.stringify(options)), { mode: 'exclusive', ifAvailable: true });
    return callback(available ? {} : null);
  } };
  await assert.rejects(bridge.withGenerationLock(owner, () => { callbacks++; }), /已有场景延展任务/);
  assert.equal(callbacks, 0);
  available = true;
  const result = await bridge.withGenerationLock(owner, async () => {
    callbacks++;
    bridge.setApiBusy('scene-extension', true);
    assert.equal(c.creativeWebIsBusy(), true);
    assert.equal(c.openConfigModal().code, 'CONFIG_BUSY');
    bridge.setApiBusy('scene-extension', false);
    return 'archived';
  });
  assert.equal(result, 'archived');
  assert.equal(callbacks, 1);
  assert.equal(c.creativeWebIsBusy(), false);
});


function deferred<T = RouteReply>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Keep actual generateOne/worker/completion code; replace provider I/O and only
// unrelated prompt/bitmap/rendering work with deterministic offline fixtures.
function loadAsyncGeneration() {
  const fixture = loadRoute();
  const c = fixture.context;
  const requests: Array<Deferred<RouteReply> & { type: string; message: Record<string, unknown> }> = [];
  const archives: RouteResult[] = [];
  c.captureGenerationSettings = () => ({ count: 1, ratio: '3:4', resolution: '2K', size: '1536*2048' });
  c.cfgFromForm = () => ({ provider: 'generic', imageModel: 'synthetic-image' });
  c.normalizeCfg = (value: unknown) => value;
  c.productImageList = () => ['data:image/png;base64,cHJvZHVjdA=='];
  c.productImageEvidence = () => [];
  c.modelImageList = () => [];
  c.referenceImageList = () => [];
  c.generationPrompt = () => 'frozen original route prompt';
  c.generationParamPromptLayer = () => '';
  c.generationReferenceRouteIdentity = (_lab: string, _detail: string, _record: unknown, options: { referenceMode?: string }) => ({ referenceMode: options.referenceMode || 'viral' });
  c.replacementNegativePrompt = () => '';
  c.detailSectionNamesForSurface = () => [];
  c.detailScreenSequenceLayer = () => '';
  c.referenceDetailRedrawDirectionPromptLayer = () => '';
  c.detailPlanUsesModel = () => false;
  c.postProcessGuideImageUrls = (images: string[]) => Promise.resolve(images);
  c.queueArchiveResult = (item: RouteResult) => { archives.push(item); return Promise.resolve(); };
  c.renderBoundApiSelector = () => {};
  c.renderStyleRefreshWorkStatus = () => {};
  c.generationImageCount = () => 4;
  c.styleRefreshRunIsCompatible = () => false;
  c.styleRefreshRunSignature = () => 'offline-style-run';
  c.send = (type: string, message: Record<string, unknown>) => {
    const pending = deferred();
    requests.push({ type, message, ...pending });
    return pending.promise;
  };
  return { ...fixture, requests, archives };
}

function freezeCurrentPage(element: (id: string) => FixtureElement) {
  element('generateState').textContent = 'new route status';
  element('generateBtn').disabled = true;
  element('stopGenerateBtn').hidden = false;
  element('stopGenerateBtn').disabled = false;
}

function assertCurrentPagePreserved(element: (id: string) => FixtureElement) {
  assert.equal(element('generateState').textContent, 'new route status');
  assert.equal(element('generateBtn').disabled, true);
  assert.equal(element('stopGenerateBtn').hidden, false);
  assert.equal(element('stopGenerateBtn').disabled, false);
}

for (const nextRoute of ['case', 'scene-extension']) {
  test('风格批次异步切到' + nextRoute + '仅保留两张已发送结果，停止新槽位和自动QA', async () => {
    const { context: c, element, requests, archives } = loadAsyncGeneration();
    c.setViralCoreRoute('style-refresh');
    const pending = c.generateStyleRefreshImages({ id: 'style-original', data: {}, prompt: 'original style plan' });
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.type === 'GENERATE_IMAGE'));
    c.setViralCoreRoute(nextRoute);
    freezeCurrentPage(element);
    for (let index = 0; index < 2; index++) requests[index].resolve({ ok: true, images: ['blob:original-style-' + index] });
    const response = await pending;
    assert.equal(response.code, 'VIRAL_ROUTE_CHANGED');
    assert.equal(requests.length, 2);
    assert.equal(c.state.results.length, 2);
    assert.ok(c.state.results.every((item: RouteResult) => item.creativeRoute === 'style-refresh' && item.styleRefreshQa?.status === 'waiting'));
    assert.deepEqual(archives.map(item => item.creativeRoute), ['style-refresh', 'style-refresh']);
    assert.deepEqual(Array.from(c.state.styleRefresh.run.slots as Array<{ status: string }>, slot => slot.status), ['generated', 'generated', 'stopped', 'stopped']);
    assert.equal(c.state.styleRefresh.run.phase, 'stopped');
    assertCurrentPagePreserved(element);
  });
}

for (const nextRoute of ['style-refresh', 'scene-extension']) {
  test('案例生成迟到完成切到' + nextRoute + '仍归原案例且不覆盖新页面状态', async () => {
    const { context: c, element, requests, archives } = loadAsyncGeneration();
    c.ensureReferencePromptForGeneration = async () => ({ ok: true, promptRecord: { prompt: 'case-original', data: {} } });
    c.displayPromptRecord = () => {};
    c.generationImageCount = () => 1;
    const pending = c.generateCurrent();
    await Promise.resolve();
    assert.equal(requests.length, 1);
    c.setViralCoreRoute(nextRoute);
    freezeCurrentPage(element);
    requests[0].resolve({ ok: true, images: ['blob:original-case'] });
    const response = await pending;
    assert.equal(response.code, 'VIRAL_ROUTE_CHANGED');
    assert.equal(requests.length, 1);
    assert.equal(c.state.results[0].creativeRoute, 'case');
    assert.equal(c.state.results[0].styleRefreshQa, undefined);
    assert.equal(archives[0].creativeRoute, 'case');
    assertCurrentPagePreserved(element);
  });
}

test('案例提词迟到失败不能把焕新已有批次改为partial或改当前按钮状态', async () => {
  const { context: c, element, requests } = loadAsyncGeneration();
  const prompt = deferred();
  c.ensureReferencePromptForGeneration = () => prompt.promise;
  const pending = c.generateCurrent();
  c.setViralCoreRoute('style-refresh');
  c.state.styleRefresh.run = { phase: 'complete', message: 'retained style run' };
  freezeCurrentPage(element);
  prompt.reject(new Error('late case-only failure'));
  const response = await pending;
  assert.equal(response.code, 'VIRAL_ROUTE_CHANGED');
  assert.equal(c.state.styleRefresh.run.phase, 'complete');
  assert.equal(c.state.styleRefresh.run.message, 'retained style run');
  assert.equal(requests.length, 0);
  assertCurrentPagePreserved(element);
});

test('已发送的焕新QA迟到返回后不修改场景页面，场景入口也不能启动旧QA', async () => {
  const { context: c, element, requests } = loadAsyncGeneration();
  c.setViralCoreRoute('style-refresh');
  const item: RouteResult = { url: 'blob:original-style', creativeRoute: 'style-refresh', batchId: 'style-qa', detailScreenIndex: 1 };
  c.state.results = [item];
  const pending = c.runStyleRefreshQaForBatch('style-qa', { data: { '风格焕新配置': { copyMode: 'none' } } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, 'ANALYZE_STYLE_REFRESH_QA');
  c.setViralCoreRoute('scene-extension');
  freezeCurrentPage(element);
  requests[0].resolve({ ok: true, assessments: [{ status: 'passed' }] });
  assert.equal((await pending).code, 'VIRAL_ROUTE_CHANGED');
  assert.equal(item.creativeRoute, 'style-refresh');
  assert.equal(item.styleRefreshQa?.status, 'pending');
  assert.equal((await c.runStyleRefreshQaForBatch('style-qa', {})).code, 'VIRAL_ROUTE_CHANGED');
  assert.equal(requests.length, 1);
  assertCurrentPagePreserved(element);
});

test('风格路线未切换时四槽位与一次自动QA完整保留', async () => {
  const { context: c, requests } = loadAsyncGeneration();
  c.setViralCoreRoute('style-refresh');
  const pending = c.generateStyleRefreshImages({ id: 'style-original', data: { '风格焕新配置': { copyMode: 'none' } }, prompt: 'style-original' });
  requests[0].resolve({ ok: true, images: ['blob:style-1'] });
  requests[1].resolve({ ok: true, images: ['blob:style-2'] });
  await vi.waitFor(() => assert.equal(requests.length, 4));
  requests[2].resolve({ ok: true, images: ['blob:style-3'] });
  requests[3].resolve({ ok: true, images: ['blob:style-4'] });
  await vi.waitFor(() => assert.equal(requests.length, 5));
  assert.equal(requests[4].type, 'ANALYZE_STYLE_REFRESH_QA');
  requests[4].resolve({ ok: true, assessments: [1, 2, 3, 4].map(() => ({ status: 'passed' })) });
  const response = await pending;
  assert.equal(response.ok, true);
  assert.equal(c.state.styleRefresh.run.phase, 'complete');
  assert.equal(c.state.results.length, 4);
  assert.ok(c.state.results.every((item: RouteResult) => item.creativeRoute === 'style-refresh' && item.styleRefreshQa?.status === 'passed'));
});
