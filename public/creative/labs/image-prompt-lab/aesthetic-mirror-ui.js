/* A unified reference/SKU workspace. Transport and original-result storage stay in the existing account bridge. */
(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  if (params.get('mode') !== 'mirror') return;
  const MODES = { single: '单图复刻', batch: '批量复刻', sku: 'SKU 替换' };
  const SPEEDS = [['standard', '标准'], ['fast', '快速'], ['turbo', '极速']];
  const RATIOS = ['1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9'];
  const environment = window.__SANJIE_ENVIRONMENT ? ':environment:' + encodeURIComponent(String(window.__SANJIE_ENVIRONMENT)) : '';
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, character => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[character]));
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const icons = {
    spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
    image:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m4 18 5-5 4 3 4-6 4 5"/>',
    layers:'<path d="m12 3 10 5-10 5L2 8l10-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
    history:'<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v5l3 2"/>',
    download:'<path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/>',
    bolt:'<path d="m14 2-9 12h6l-1 8 9-12h-6l1-8Z"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.spark}</svg>`;
  let root, bridge, contract, accountKey, database, activeMode = Object.hasOwn(MODES, params.get('tab')) ? params.get('tab') : 'single';
  let initializing = true, startupFailed = false, restoring = false, deactivating = false, saveFault = false;
  let uploadBusy = false, apiBusy = false, modelRefreshing = false, modelReady = false, previewFocus;
  let modelInfo = {}, boundApis = [], notice = '', noticeError = false, saveQueue = Promise.resolve(), modelSequence = 0;
  const modes = new Map(), pendingSends = new Map(), timers = new Map();
  const $ = id => document.getElementById(id);
  const binding = () => modes.get(activeMode);
  const current = () => binding()?.controller.state || { slots: [], previousResults: [] };
  const limits = mode => ({ references: mode === 'batch' ? 20 : 1, products: mode === 'sku' ? 20 : 6, count: mode === 'single' ? 10 : 4 });
  const draftDefaults = mode => ({ schema: 1, mode, references: [], products: [], config: { requirements: '', ratio: '1:1', resolution: '2K', count: 1, quality: 'auto', speed: 'standard', name: '' }, savedAt: '', snapshot: null });
  const imageOf = item => item && (item.url || item.image || item.dataUrl || item.imageUrl) || '';
  const slotsFor = entry => (entry.controller.state.slots || []).concat((entry.controller.state.previousResults || []).filter(slot => slot.item));
  const hasFlight = entry => Boolean(entry && (entry.controller.state.busy || entry.controller.state.awaitingReceipt || entry.controller.hasInFlightRequest?.() || pendingSends.get(entry.mode) > 0 || slotsFor(entry).some(slot => slot.archiveSaving)));
  const allActive = () => [...modes.values()].some(hasFlight);
  const inputLocked = () => initializing || restoring || deactivating || uploadBusy || apiBusy || modelRefreshing || Boolean(window.SZ_IMAGE_UPLOAD?.isImporting?.()) || hasFlight(binding());
  const apiLocked = () => initializing || deactivating || apiBusy || modelRefreshing || uploadBusy || allActive() || Boolean(window.SZ_IMAGE_UPLOAD?.isImporting?.());
  function showError(error) { notice = error?.message || String(error); noticeError = true; renderStatus(); }
  function setNotice(message) { notice = message; noticeError = false; renderStatus(); }
  async function ensureAccount() {
    if (!bridge?.getAccountKey || String(await bridge.getAccountKey()) !== accountKey) {
      modelReady = false;
      throw new Error('登录账号已变化，请重新打开爆款复刻；原账号素材和任务仍保留。');
    }
  }
  async function openDB() {
    if (database) return database;
    database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('sz_aesthetic_mirror_drafts_v1' + environment, 1);
      let expired = false;
      const timer = setTimeout(() => { expired = true; reject(new Error('素材草稿库读取超时，请重新打开工作台。')); }, 15000);
      request.onupgradeneeded = () => { if (!expired) request.result.createObjectStore('drafts'); };
      request.onsuccess = () => { clearTimeout(timer); if (expired) request.result.close(); else resolve(request.result); };
      request.onerror = () => { clearTimeout(timer); reject(request.error || new Error('无法读取素材草稿库。')); };
    });
    return database;
  }
  async function dbGet(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => { const request = db.transaction('drafts').objectStore('drafts').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  }
  async function dbPut(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => { const transaction = db.transaction('drafts', 'readwrite'); transaction.objectStore('drafts').put(value, key); transaction.oncomplete = resolve; transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('素材草稿保存失败。')); });
  }
  const draftKey = mode => `${accountKey}:mode:${mode}`;
  function journal(mode) {
    const key = `sz_aesthetic_mirror_pending_v1${environment}:${accountKey}:${mode}`;
    return {
      read: () => JSON.parse(localStorage.getItem(key) || 'null'), write: receipt => localStorage.setItem(key, JSON.stringify(receipt)), clear: () => localStorage.removeItem(key),
      compareAndClear(receipt) {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (!saved) return true;
        if (!receipt || !receipt.jobId || ['jobId','signature','shotId','batchId'].some(field => saved[field] !== receipt[field])) return false;
        localStorage.removeItem(key); return true;
      }
    };
  }
  async function persist(entry = binding()) {
    if (!entry || restoring || startupFailed) return;
    const value = clone(entry.draft); value.snapshot = entry.controller.snapshot(); value.savedAt = new Date().toISOString();
    const key = draftKey(entry.mode);
    saveQueue = saveQueue.catch(() => {}).then(() => dbPut(key, value));
    try { await saveQueue; entry.draft.savedAt = value.savedAt; entry.saveFault = false; saveFault = [...modes.values()].some(item => item.saveFault); }
    catch (error) { entry.saveFault = saveFault = true; throw error; }
    if (entry === binding() && $('amDraftState')) $('amDraftState').textContent = '素材和结果已保存至当前账号草稿';
  }
  function scheduleSave(entry) {
    clearTimeout(timers.get(entry.mode));
    timers.set(entry.mode, setTimeout(() => persist(entry).catch(showError), 350));
  }
  const readInput = entry => ({ mode: entry.mode, references: clone(entry.draft.references), products: clone(entry.draft.products), config: clone(entry.draft.config) });
  const bridgeConfig = () => typeof bridge.config === 'function' ? bridge.config() : bridge.config;
  function makeController(entry) {
    return contract.createController({
      readInput: () => readInput(entry), config: bridgeConfig,
      async send(...args) {
        await ensureAccount();
        pendingSends.set(entry.mode, (pendingSends.get(entry.mode) || 0) + 1); renderStatus();
        try { return await bridge.send(...args); }
        finally { pendingSends.set(entry.mode, Math.max(0, (pendingSends.get(entry.mode) || 1) - 1)); renderStatus(); }
      },
      archive: bridge.archive, archiveContext: bridge.archiveContext, newJobId: bridge.newJobId,
      register: bridge.registerGenerationJob, unregister: bridge.unregisterGenerationJob, journal: journal(entry.mode),
      onChange() { if (!restoring && entry.controller) { if (entry === binding()) renderResults(); renderStatus(); scheduleSave(entry); } }
    });
  }
  async function loadModes() {
    restoring = true;
    try {
      for (const mode of Object.keys(MODES)) {
        const saved = await dbGet(draftKey(mode)), defaults = draftDefaults(mode);
        if (saved && (saved.schema !== 1 || saved.mode !== mode)) throw new Error('保存的爆款复刻草稿版本无法安全恢复，原稿仍保留。');
        const draft = saved || defaults;
        draft.references = Array.isArray(draft.references) ? draft.references : [];
        draft.products = Array.isArray(draft.products) ? draft.products : [];
        draft.config = { ...defaults.config, ...draft.config };
        const entry = { mode, draft, controller: null, saveFault: false };
        entry.controller = makeController(entry); modes.set(mode, entry);
        if (draft.snapshot) { const restored = entry.controller.restore(draft.snapshot); if (restored?.ok === false) throw new Error(restored.error || '保存的任务无法安全恢复。'); }
      }
    } finally { restoring = false; }
  }
  function optionMarkup(values, selected) { return values.map(value => `<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}>${esc(value)}</option>`).join(''); }
  function selectField(label, field, values, selected) { return `<label>${esc(label)}<select data-am-field="${field}">${optionMarkup(values, selected)}</select></label>`; }
  function uploadCard(kind) {
    const mode = activeMode, items = binding().draft[kind], max = limits(mode)[kind], isReference = kind === 'references';
    const title = isReference ? mode === 'batch' ? '上传参考设计图' : mode === 'sku' ? '参考图' : '参考设计图' : mode === 'sku' ? 'SKU 产品图' : '产品素材图';
    const subtitle = isReference ? mode === 'sku' ? '上传需要替换 SKU 的原图' : mode === 'batch' ? '每张参考图将被 1:1 复刻成对应的产品详情图' : '上传具有明确风格的参考图' : mode === 'sku' ? '每张图片可单独填写产品信息（如尺码、颜色）' : '上传需要复刻风格的产品素材图';
    const input = `<input id="am${kind}Files" type="file" data-am-upload="${kind}" accept="image/png,image/jpeg,image/webp"${max > 1 ? ' multiple' : ''}${inputLocked() ? ' disabled' : ''}>`;
    const upload = window.SZ_IMAGE_UPLOAD.markup({ title, subtitle, count: items.length, max, hint: '支持 PNG、JPG、WebP · 单张最大 10 MB', note: '', input, zoneAttributes: `data-am-drop="${kind}"` });
    return `<section class="am-card am-upload-card">${upload}<div class="am-assets${kind === 'references' && max === 1 ? ' am-single-asset' : ''}">${items.map((item,index) => `<figure class="am-asset"><button type="button" class="am-asset-preview" data-am-action="preview-asset" data-kind="${kind}" data-index="${index}" aria-label="预览 ${esc(item.name)}"><img src="${esc(item.image)}" alt="${esc(item.name)}"></button><button type="button" class="am-remove" data-am-action="remove-asset" data-kind="${kind}" data-index="${index}" aria-label="移除 ${esc(item.name)}">×</button><figcaption title="${esc(item.name)}">${esc(item.name)}</figcaption>${mode === 'sku' && !isReference ? `<button type="button" class="am-note-button" data-am-action="sku-info" data-index="${index}">特殊需求${item.info ? ' · 已填写' : ''}</button>` : ''}</figure>`).join('')}</div>${mode === 'sku' && !isReference ? '<p class="am-muted am-upload-footer">白底产品图可以提高成功率。</p>' : ''}</section>`;
  }
  function render() {
    if (!root || !binding()) return;
    const draft = binding().draft, cfg = draft.config;
    document.title = '少壮AI · 爆款复刻';
    root.innerHTML = `<header class="am-hero"><span class="am-badge">${icon('spark')}AI 驱动</span><h1>一键复刻爆款详情页风格</h1><p>上传您喜欢的设计参考图和产品素材，AI 将智能融合风格与产品特性，生成专属于您的高转化详情图</p></header>
      <div class="am-workspace"><aside class="am-input-column"><nav class="am-tabs" role="tablist" aria-label="爆款复刻模式">${Object.entries(MODES).map(([mode,label]) => `<button type="button" role="tab" data-am-action="switch-mode" data-mode="${mode}" aria-selected="${activeMode === mode}">${icon(mode === 'single' ? 'image' : 'layers')}<span>${label}</span><small data-am-tab-status="${mode}"></small></button>`).join('')}</nav>
      <fieldset id="amInputFields">${uploadCard('references')}${uploadCard('products')}<section class="am-card am-settings"><label class="am-prompt-label">补充提示词（可选）<textarea data-am-field="requirements" maxlength="6000" placeholder="例如：添加「限时特惠」文字，使用红色主题...">${esc(cfg.requirements)}</textarea></label><div class="am-settings-grid"><label>生图模型<select id="amModel" data-am-api aria-label="已绑定生图模型"></select></label>${selectField('宽高比','ratio',RATIOS,cfg.ratio)}${selectField('清晰度','resolution',['1K','2K','4K'],cfg.resolution)}${selectField(activeMode === 'single' ? '生成数量' : '生成组数','count',Array.from({length:limits(activeMode).count},(_,i)=>i+1),cfg.count)}</div><div id="amQuality"></div><div class="am-api-footer"><span id="amModelNote" class="am-muted">正在读取模型设置…</span><button type="button" class="am-link" data-am-action="open-config">配置 API</button></div></section>
      <section class="am-card am-speed-card"><div class="am-speed-label">${icon('bolt')}生成速度</div><div class="am-speed-options">${SPEEDS.map(([speed,label]) => `<button type="button" data-am-action="speed" data-speed="${speed}" aria-pressed="${cfg.speed === speed}">${label}</button>`).join('')}</div><p id="amSpeedNote" class="am-muted">按当前模型支持的速度生成</p></section></fieldset>
      <div class="am-generate-wrap"><button id="amGenerate" type="button" class="am-generate" data-am-action="generate">${icon('spark')}<span>生成 ${totalCount()} 张${activeMode === 'sku' ? ' SKU 图' : '详情图'}</span></button><p id="amCostNote" class="am-muted">费用按当前账号所选模型报价计算</p></div><p id="amDraftState" class="am-draft-state">${draft.savedAt ? '已恢复当前账号的素材与结果' : '原图和素材按当前账号保留'}</p>${activeMode === 'sku' ? '<p class="am-muted am-tip">提示：每张 SKU 图片将替换参考图中的产品，保留原图的背景、构图和风格。</p>' : ''}</aside>
      <section class="am-card am-result-panel"><header class="am-result-header"><div><h2>${activeMode === 'sku' ? 'SKU 生成结果' : activeMode === 'batch' ? '批量生成结果' : '生成结果'}</h2><p>${activeMode === 'sku' ? '按 SKU 分组展示' : activeMode === 'batch' ? '按参考图分组展示' : 'AI 生成的详情图将显示在这里'}</p></div><div class="am-result-actions"><button type="button" class="am-button" data-am-action="history">${icon('history')}历史记录</button><button id="amDownloadAll" type="button" class="am-button" data-am-action="download-all" hidden>${icon('download')}全部下载</button></div></header>
      <div id="amStatus" class="am-status" role="status" aria-live="polite" hidden></div><div id="amTaskControls" class="am-task-controls"></div><section id="amReceipt" class="am-receipt" hidden><h3>上一张图片的结果待确认</h3><p id="amReceiptDetail"></p><button type="button" class="am-button" data-am-action="history">查看本机历史与回执</button><label><input id="amReceiptConfirmed" type="checkbox">我已核对提供方任务和用量记录</label><button type="button" class="am-button" data-am-action="resolve-receipt" disabled>记录核对并继续</button></section><div id="amResultGrid" class="am-result-grid"></div><div id="amEmptyResult" class="am-empty-result"><span>${icon('image')}</span><strong>${activeMode === 'sku' ? '等待生成' : '上传参考图和产品素材后'}</strong><p>${activeMode === 'sku' ? '上传参考图和 SKU 产品图后，点击生成按钮' : '点击「生成」开始'}</p><small>生成完成后将在此展示结果，可下载或继续编辑。</small></div></section></div>
      <div id="amOtherTasks" class="am-other-tasks" hidden></div>`;
    renderModels(); renderResults(); renderStatus();
  }
  function totalCount() { const draft = binding()?.draft; return draft ? Math.max(1, Number(draft.config.count) || 1) * (activeMode === 'batch' ? draft.references.length : activeMode === 'sku' ? draft.products.length : 1) : 0; }
  function renderModels() {
    if (!$('amModel') || !binding()) return;
    const selected = modelInfo.provider || '', available = boundApis.some(api => api.provider === selected);
    $('amModel').innerHTML = `${available ? '' : '<option value="" disabled selected>请选择已绑定模型</option>'}${boundApis.map(api => `<option value="${esc(api.provider)}"${api.provider === selected ? ' selected' : ''}>${esc(api.imageModel || api.label || api.provider)}${api.label && api.imageModel ? ` · ${esc(api.label)}` : ''}</option>`).join('')}`;
    const cfg = binding().draft.config;
    const resolutions = Array.isArray(modelInfo.resolutions) && modelInfo.resolutions.length ? modelInfo.resolutions : ['1K','2K','4K'];
    const ratios = Array.isArray(modelInfo.ratios) && modelInfo.ratios.length ? modelInfo.ratios : Array.isArray(modelInfo.aspectRatios) && modelInfo.aspectRatios.length ? modelInfo.aspectRatios : contract.ratios || RATIOS;
    for (const [field,values] of [['resolution',resolutions],['ratio',ratios]]) {
      const target = root.querySelector(`[data-am-field="${field}"]`); if (target) target.innerHTML = optionMarkup(values, cfg[field]);
    }
    const qualities = modelInfo.qualityOptions || ['auto'];
    $('amQuality').innerHTML = qualities.length > 1 ? selectField('输出质量','quality',qualities,cfg.quality) : '';
    $('amModelNote').textContent = modelReady ? modelInfo.specificationHint || '规格由当前模型适配器处理，最终尺寸以原件为准。' : '请选择支持参考图的已绑定模型';
    const speeds = modelInfo.generationSpeeds || ['standard'];
    root.querySelectorAll('[data-am-action="speed"]').forEach(button => { const supported = speeds.includes(button.dataset.speed); button.disabled = inputLocked() || !supported; button.title = supported ? '' : '当前模型暂不支持此速度'; button.setAttribute('aria-pressed', String(cfg.speed === button.dataset.speed)); });
    $('amSpeedNote').textContent = speeds.length === 1 ? '当前模型支持标准速度' : '费用和生成耗时按所选模型计算';
  }
  async function refreshModelInfo(startupSnapshot) {
    const sequence = ++modelSequence; modelRefreshing = true; renderStatus();
    try {
      const catalog = await bridge.listBoundApis(startupSnapshot?.boundApis);
      if (sequence !== modelSequence) return;
      if (!catalog?.ok || catalog.accountKey && catalog.accountKey !== accountKey) throw new Error(catalog?.error || '模型配置所属账号不一致。');
      const info = await bridge.modelInfo();
      if (sequence !== modelSequence) return;
      boundApis = catalog.providers || catalog.catalog || []; modelInfo = typeof info === 'string' ? { model: info } : info || {};
      modelReady = modelInfo.ready !== false && modelInfo.supportsReference !== false && boundApis.some(api => api.provider === modelInfo.provider);
      for (const entry of modes.values()) {
        if (hasFlight(entry)) continue;
        let changed = false;
        for (const [field,values] of [['resolution',modelInfo.resolutions],['ratio',modelInfo.ratios || modelInfo.aspectRatios],['quality',modelInfo.qualityOptions],['speed',modelInfo.generationSpeeds || ['standard']]]) {
          if (Array.isArray(values) && values.length && !values.includes(entry.draft.config[field])) { entry.draft.config[field] = values[0]; changed = true; }
        }
        if (changed) { entry.controller.invalidate(); scheduleSave(entry); }
      }
    } catch (error) { if (sequence === modelSequence) { modelReady = false; boundApis = []; showError(error); } }
    finally { if (sequence === modelSequence) { modelRefreshing = false; renderModels(); renderStatus(); } }
  }
  function renderCredits() {
    if (!binding() || !$('amGenerate') || !bridge) return;
    const cfg = bridgeConfig() || {}, draft = binding().draft;
    let count = totalCount();
    const plan = current().plan;
    if (plan) count = (current().slots || []).filter(slot => ['ready','queued'].includes(slot.status)).length;
    window.SZCreativeCreditHints?.image($('amGenerate'), cfg.imageModel || modelInfo.model || '', draft.references.length && draft.products.length ? Array(count).fill(1) : null, `本次 ${count} 张${activeMode === 'sku' ? ' SKU 图' : '复刻图片'}，成功结果保留`);
    root.querySelectorAll('[data-am-action="retry-shot"]').forEach(button => window.SZCreativeCreditHints?.image(button,cfg.imageModel || modelInfo.model || '',[1],'仅重新请求所选图片'));
    const failed = (current().slots || []).filter(slot => slot.status === 'failed').length;
    window.SZCreativeCreditHints?.image(root.querySelector('[data-am-action="retry-failed"]'), cfg.imageModel || modelInfo.model || '', Array(failed).fill(1), '仅重试失败项，保留已成功图片');
    const regenerateCount = (current().slots || []).filter(slot => ['done','outdated'].includes(slot.status)).length;
    window.SZCreativeCreditHints?.image(root.querySelector('[data-am-action="regenerate-all"]'), cfg.imageModel || modelInfo.model || '', Array(regenerateCount).fill(1), '重新请求当前组全部成功图片，原结果保留');
    $('amCostNote').textContent = modelInfo.supplyChannel === 'platform_wallet' ? '积分以当前模型的实时报价及生成记录为准' : '按已绑定 API 的服务商实际计费';
  }
  window.SZCreativeCreditHints?.register('aesthetic-mirror', renderCredits);
  function renderStatus() {
    if (!root || !binding() || !$('amStatus')) return;
    const state = current(), locked = inputLocked();
    bridge?.setApiBusy?.('mirror', allActive() || initializing || modelRefreshing || apiBusy || uploadBusy || deactivating);
    $('amInputFields').disabled = locked;
    root.querySelectorAll('[data-am-upload]').forEach(input => { input.disabled = locked; });
    $('amModel').disabled = apiLocked() || !boundApis.length;
    root.querySelector('[data-am-action="open-config"]').disabled = apiLocked();
    root.querySelectorAll('[data-am-action="remove-asset"]').forEach(button => { button.disabled = locked; });
    root.querySelectorAll('[data-am-action="retry-shot"]').forEach(button => { button.disabled = locked || Boolean(state.uncertain) || !modelReady || !state.plan; });
    root.querySelectorAll('[data-am-action="switch-mode"]').forEach(button => { button.disabled = uploadBusy || apiBusy || modelRefreshing || deactivating || initializing || Boolean(window.SZ_IMAGE_UPLOAD?.isImporting?.()); });
    const status = uploadBusy ? '正在读取并保留图片原件…' : window.SZ_IMAGE_UPLOAD?.isImporting?.() ? '正在导入图片 URL…' : notice || (state.busy || state.uncertain || state.kind || state.slots.length ? state.message : '') || '';
    $('amStatus').hidden = !status; $('amStatus').textContent = status; $('amStatus').classList.toggle('am-error', noticeError || state.kind === 'error');
    const draft = binding().draft, ready = (state.slots || []).filter(slot => ['ready','queued'].includes(slot.status)).length;
    const planSame = Boolean(state.plan);
    const noPending = planSame && !ready;
    $('amGenerate').disabled = locked || !modelReady || !draft.references.length || !draft.products.length || Boolean(state.uncertain) || Boolean(noPending);
    $('amGenerate').querySelector('span').textContent = state.uncertain ? '结果待确认' : hasFlight(binding()) ? '生成中…' : noPending ? (state.slots.every(slot => slot.status === 'done') ? '本组已完成' : '请重试失败项') : `${state.stopped && ready && planSame ? '继续生成' : '生成'} ${planSame ? ready : totalCount()} 张${activeMode === 'sku' ? ' SKU 图' : '详情图'}`;
    $('amTaskControls').innerHTML = `${state.busy ? '<button type="button" class="am-button" data-am-action="stop">停止后续生成</button>' : ''}${state.slots.some(slot => slot.status === 'failed') ? `<button type="button" class="am-button" data-am-action="retry-failed"${locked || state.uncertain || !modelReady || !state.plan ? ' disabled' : ''}>重试失败项</button>` : ''}${state.plan && state.slots.some(slot => ['done','outdated'].includes(slot.status)) && !hasFlight(binding()) && !state.uncertain ? `<button type="button" class="am-link" data-am-action="regenerate-all"${locked || !modelReady ? ' disabled' : ''}>重新生成全部</button>` : ''}`;
    $('amReceipt').hidden = !state.uncertain;
    if (state.uncertain) {
      const receipt = state.uncertain, age = receipt.createdAt ? ` · 等待 ${Math.max(0,Math.floor((Date.now()-receipt.createdAt)/60000))} 分钟` : '';
      $('amReceiptDetail').textContent = `${receipt.jobId ? `任务 ${receipt.jobId}` : '已保留原任务回执'}${age}。核对原任务结果和费用后再重试。`;
      root.querySelector('[data-am-action="resolve-receipt"]').disabled = locked || !$('amReceiptConfirmed').checked;
    }
    for (const entry of modes.values()) {
      const indicator = root.querySelector(`[data-am-tab-status="${entry.mode}"]`); if (!indicator) continue;
      const state = entry.controller.state; indicator.textContent = state.uncertain ? '待确认' : hasFlight(entry) ? '进行中' : ''; indicator.hidden = !indicator.textContent;
    }
    const others = [...modes.values()].filter(entry => entry.mode !== activeMode && (hasFlight(entry) || entry.controller.state.uncertain || entry.saveFault));
    $('amOtherTasks').hidden = !others.length;
    $('amOtherTasks').innerHTML = others.map(entry => `<button type="button" data-am-action="switch-mode" data-mode="${entry.mode}">${esc(MODES[entry.mode])} · ${entry.saveFault ? '草稿待保存' : entry.controller.state.uncertain ? '结果待确认' : '正在生成'} · 查看任务</button>`).join('');
    renderModels(); renderCredits();
  }
  function renderResults() {
    if (!$('amResultGrid') || !binding()) return;
    const slots = slotsFor(binding()), states = { ready:'待生成',queued:'排队中',generating:'生成中…',done:'已生成',outdated:'历史版本',failed:'生成失败',stopped:'已停止',uncertain:'结果待确认' };
    const grouped = new Map();
    slots.forEach((slot,index) => { const previous = !(current().slots || []).includes(slot), group = activeMode === 'single' ? previous ? 'previous' : 'current' : `${previous ? 'previous-' : ''}${slot.shot?.groupIndex ?? 0}`; if (!grouped.has(group)) grouped.set(group, []); grouped.get(group).push({ slot, index, previous }); });
    $('amResultGrid').innerHTML = [...grouped.entries()].map(([group,entries]) => {
      const first = entries[0].slot, groupIndex = first.shot?.groupIndex || 0, productIndex = first.shot?.productIndex ?? groupIndex;
      const title = activeMode === 'single' ? group === 'previous' ? '历史版本' : '' : `${entries[0].previous ? '历史版本 · ' : ''}${activeMode === 'sku' ? first.item?.productName || binding().draft.products[productIndex]?.name || `SKU ${productIndex+1}` : `第 ${groupIndex+1} 组`}`;
      return `<section class="am-result-group">${title ? `<h3>${esc(title)}</h3>` : ''}<div class="am-result-items">${entries.map(({slot,index,previous}) => {
        const image = imageOf(slot.item), label = slot.item?.businessRoleName || slot.item?.variantName || slot.shot?.label || `结果 ${index+1}`;
        return `<article class="am-result-item"><button type="button" class="am-result-image" data-am-action="preview-result" data-index="${index}"${image ? '' : ' disabled'} aria-label="${esc(image ? `预览 ${label}` : states[slot.status] || '待生成')}">${image ? `<img src="${esc(image)}" alt="${esc(label)}">` : `<span class="${slot.status === 'generating' ? 'am-spinner' : ''}">${slot.status === 'generating' ? '' : icon('image')}</span><span>${esc(states[slot.status] || slot.status)}</span>`}</button><div class="am-result-caption"><h4>${esc(label)}</h4><p>${esc(states[slot.status] || slot.status)}${previous ? ' · 历史版本' : ''}</p>${slot.error ? `<p class="am-error">${esc(slot.error.message || slot.error)}</p>` : ''}${image && !slot.archiveOk ? `<p class="am-error">${slot.archiveSaving ? '正在保存原件…' : '原件待补存'}${slot.archiveError ? `：${esc(slot.archiveError.message || slot.archiveError)}` : ''}</p>` : ''}<div class="am-image-actions">${image ? `<button type="button" class="am-button" data-am-action="download" data-index="${index}">下载</button>${typeof bridge.openResultAction === 'function' ? `<button type="button" class="am-button" data-am-action="edit" data-index="${index}">编辑</button>` : ''}${!slot.archiveOk ? `<button type="button" class="am-button" data-am-action="retry-archive" data-index="${index}"${slot.archiveSaving ? ' disabled' : ''}>补存原件</button>` : ''}` : ''}${!previous && ['done','outdated','failed'].includes(slot.status) ? `<button type="button" class="am-button" data-am-action="retry-shot" data-id="${esc(slot.shot.id)}"${inputLocked() || current().uncertain || !modelReady || !current().plan ? ' disabled' : ''}>${image ? '重新生成' : '重试'}</button>` : ''}</div></div></article>`;
      }).join('')}</div></section>`;
    }).join('');
    $('amEmptyResult').hidden = !!slots.length;
    $('amDownloadAll').hidden = !slots.some(slot => imageOf(slot.item));
    renderCredits();
  }
  function invalidate(entry = binding()) { entry.controller.invalidate(); if (!entry.controller.state.uncertain) entry.controller.report(''); scheduleSave(entry); notice = ''; noticeError = false; }
  async function decodeFile(file) {
    if (!file || !['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('仅支持 PNG、JPG、WebP 图片。');
    if (!file.size || file.size > 10 * 1024 * 1024) throw new Error(`${file.name || '图片'} ${file.size ? '超过 10 MB' : '是空文件'}。`);
    const image = await new Promise((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('图片读取失败。')); reader.readAsDataURL(file); });
    const dimensions = await new Promise((resolve,reject) => { const img = new Image(); img.onload = () => img.naturalWidth && img.naturalHeight ? resolve({ width:img.naturalWidth,height:img.naturalHeight }) : reject(new Error('图片尺寸无效。')); img.onerror = () => reject(new Error('图片无法解码。')); img.src = image; });
    await window.SZ_IMAGE_UPLOAD.retainOriginal(file, image);
    return { id:uid(), image, name:file.name || '粘贴的图片', info:'', ...dimensions };
  }
  async function addFiles(files,kind) {
    if (inputLocked() || !binding()) throw new Error('当前图片导入或任务正在处理，请稍后操作。');
    const entry = binding(), max = limits(entry.mode)[kind], room = max - entry.draft[kind].length;
    if (!room) throw new Error(`此位置最多 ${max} 张图片，请先移除已有素材。`);
    uploadBusy = true; renderStatus();
    try {
      await ensureAccount(); const errors = [];
      for (const file of Array.from(files).slice(0,room)) {
        try { const asset = await decodeFile(file); await ensureAccount(); if (entry !== binding()) throw new Error('工作区已切换，图片导入已停止。'); if (entry.draft[kind].some(item => item.image === asset.image)) errors.push(`${asset.name} 已在当前素材中。`); else entry.draft[kind].push(asset); }
        catch (error) { errors.push(error.message); }
      }
      if (files.length > room) errors.push(`超出上限的 ${files.length-room} 张未导入。`);
      invalidate(entry); await persist(entry); render(); if (errors.length) showError(new Error(errors.join('\n')));
    } finally { uploadBusy = false; renderStatus(); }
  }
  async function generationRun(entry, callback) {
    await ensureAccount();
    if (!navigator.locks?.request) throw new Error('当前浏览器不支持任务防重锁，请使用新版 Chrome。');
    return navigator.locks.request(`sz-aesthetic-mirror-generation${environment}:${accountKey}`, { ifAvailable:true }, async lock => {
      if (!lock) throw new Error('当前账号已有爆款复刻任务正在提交；可切换页签准备其他素材。');
      await ensureAccount(); await persist(entry); const result = await callback(); await persist(entry);
      if (result?.ok === false && result.error) throw new Error(result.error);
      return result;
    });
  }
  async function download(slot,index) {
    const image = imageOf(slot?.item); if (!image) throw new Error('没有可下载的原件。');
    const title = `${slot.item.productName || '爆款复刻'}-${slot.item.businessRoleName || slot.shot?.label || `结果 ${index+1}`}`.replace(/[\\/:*?"<>|]/g,'_').replace(/\.(png|jpe?g|webp)$/i,'');
    if (typeof bridge.download === 'function') return bridge.download(slot.item, `${title}.png`);
    let url = image, revoke = false, mime = /^data:([^;,]+)/.exec(image)?.[1] || '';
    if (!/^data:|^blob:/.test(image)) { const response = await fetch(image,{credentials:'omit'}); if (!response.ok) throw new Error(`下载失败 (${response.status})`); const blob = await response.blob(); mime = blob.type; url = URL.createObjectURL(blob); revoke = true; }
    const link = document.createElement('a'); link.href = url; link.download = `${title}.${mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'}`; document.body.append(link); link.click(); link.remove(); if (revoke) setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function openInfo(index) {
    const item = binding().draft.products[index]; if (!item) return;
    previewFocus = document.activeElement;
    const modal = document.createElement('div'); modal.id = 'amInfoModal'; modal.className = 'am-modal';
    modal.innerHTML = `<section class="am-dialog" role="dialog" aria-modal="true" aria-labelledby="amInfoTitle"><header><h2 id="amInfoTitle">SKU ${index+1} 产品信息</h2><button class="am-button" type="button" data-am-action="close-info">关闭 ×</button></header><img src="${esc(item.image)}" alt="${esc(item.name)}"><label>特殊需求<textarea id="amSkuInfo" maxlength="6000" placeholder="在这里输入你的调整要求（调整图片内容或调整图片中的文字等）">${esc(item.info)}</textarea></label><button class="am-generate" type="button" data-am-action="save-info" data-index="${index}">保存</button></section>`;
    document.body.append(modal); $('amSkuInfo').focus();
  }
  function closeInfo() { $('amInfoModal')?.remove(); if (previewFocus?.isConnected) previewFocus.focus(); }
  async function handleAction(button) {
    if (button.disabled) return;
    const action = button.dataset.amAction, index = Number(button.dataset.index), entry = binding();
    if (action === 'close-info') { closeInfo(); return; }
    if (action === 'stop') { await entry.controller.stop(); return; }
    if (action === 'preview-asset') { const item = entry.draft[button.dataset.kind][index]; if (item) await window.SZ_IMAGE_UPLOAD.openPreview(item.image,item.name,true); return; }
    if (action === 'preview-result') { const slot = slotsFor(entry)[index]; if (imageOf(slot?.item)) await window.SZ_IMAGE_UPLOAD.openPreview(imageOf(slot.item),slot.item.businessRoleName || slot.shot.label); return; }
    if (action === 'history') { await bridge.openHistory(); return; }
    if (action === 'open-config') { if (apiLocked()) return; const result = await bridge.openConfig(); if (result?.ok === false) throw new Error(result.error); return; }
    if (action === 'switch-mode') {
      if (uploadBusy || apiBusy || modelRefreshing || deactivating || initializing || window.SZ_IMAGE_UPLOAD?.isImporting?.()) return;
      await ensureAccount(); await persist(entry); activeMode = Object.hasOwn(MODES,button.dataset.mode) ? button.dataset.mode : 'single'; notice = ''; noticeError = false;
      const url = new URL(location.href); url.searchParams.set('tab',activeMode); history.replaceState(null,'',url); render(); return;
    }
    await ensureAccount();
    if (inputLocked() && !['download','download-all','retry-archive','edit'].includes(action)) return;
    if (action === 'remove-asset') { entry.draft[button.dataset.kind].splice(index,1); invalidate(entry); await persist(entry); render(); }
    else if (action === 'speed') { const allowed = modelInfo.generationSpeeds || ['standard']; if (!allowed.includes(button.dataset.speed)) throw new Error('当前模型不支持此生成速度。'); entry.draft.config.speed = button.dataset.speed; invalidate(entry); renderStatus(); }
    else if (action === 'sku-info') { openInfo(index); }
    else if (action === 'save-info') { const item = entry.draft.products[index]; if (!item) throw new Error('SKU 素材已变化。'); item.info = $('amSkuInfo').value.trim(); invalidate(entry); await persist(entry); closeInfo(); render(); }
    else if (action === 'generate') {
      if (!modelReady) throw new Error('请先选择支持参考图的已绑定模型。'); notice = ''; noticeError = false;
      await generationRun(entry,async () => { const plan = entry.controller.buildPlan(); if (plan?.ok === false) throw new Error(plan.error); return entry.controller.generate(); });
    } else if (action === 'retry-failed') { notice = ''; noticeError = false; await generationRun(entry,()=>entry.controller.retryFailed()); }
    else if (action === 'retry-shot') { notice = ''; noticeError = false; await generationRun(entry,()=>entry.controller.retryShot(button.dataset.id)); }
    else if (action === 'retry-archive') { const result = await entry.controller.retryArchive(slotsFor(entry)[index]); if (result?.ok === false) throw new Error(result.error); await persist(entry); }
    else if (action === 'regenerate-all') {
      if (slotsFor(entry).some(slot => slot.item && !slot.archiveOk)) throw new Error('请先补存已有原件，再创建下一组。');
      const ids = entry.controller.state.slots.filter(slot => ['done','outdated'].includes(slot.status)).map(slot => slot.shot.id);
      await generationRun(entry,async () => { for (const id of ids) { const result = await entry.controller.retryShot(id); if (result?.ok === false || entry.controller.state.stopped || entry.controller.state.uncertain) return result; } return {ok:true}; });
    } else if (action === 'resolve-receipt') { if (!$('amReceiptConfirmed').checked) return; const result = entry.controller.resolveUncertain({confirmed:true}); if (result?.ok === false) throw new Error(result.error); await persist(entry); render(); }
    else if (action === 'download') await download(slotsFor(entry)[index],index);
    else if (action === 'download-all') { const slots = slotsFor(entry); let count = 0; for (let i=0;i<slots.length;i++) if (imageOf(slots[i].item)) { await download(slots[i],i); count++; } setNotice(`已发起 ${count} 张原件下载。`); }
    else if (action === 'edit') { const result = await bridge.openResultAction('edit',slotsFor(entry)[index]?.item); if (result?.ok === false) throw new Error(result.error); }
    renderStatus();
  }
  function getTaskState() {
    const rows = [...modes.values()].flatMap(entry => (entry.controller.state.slots || []).map(slot => ({ mode:entry.mode,status:slot.status,jobId:slot.item?.jobId || entry.controller.state.uncertain?.shotId === slot.shot?.id && entry.controller.state.uncertain.jobId || '',label:slot.shot?.label || MODES[entry.mode] })));
    const count = status => rows.filter(row => row.status === status).length;
    const preparing = [...modes.values()].some(entry => hasFlight(entry) && !entry.controller.state.uncertain && !(entry.controller.state.slots || []).some(slot => ['generating','queued'].includes(slot.status)));
    const activeCount = count('generating') + count('queued') + (preparing ? 1 : 0);
    const pendingReceiptCount = [...modes.values()].reduce((sum,entry) => sum + Math.max(entry.controller.state.uncertain ? 1 : 0,(entry.controller.state.slots || []).filter(slot => slot.status === 'uncertain').length),0);
    return { ready:!initializing && !startupFailed,busy:activeCount > 0,activeCount,pendingReceiptCount,failedCount:count('failed'),completedCount:count('done'),summary:`${activeCount} 项进行中 · ${pendingReceiptCount} 项结果待确认 · ${count('failed')} 项失败 · ${count('done')} 项完成`,tasks:rows };
  }
  async function canDeactivate() {
    if (startupFailed && !allActive()) return { allowed:true };
    if (initializing || restoring || uploadBusy || apiBusy || modelRefreshing || allActive() || window.SZ_IMAGE_UPLOAD?.isImporting?.()) return { allowed:false,reason:'当前爆款复刻任务或图片导入仍在处理，已保留现场；可切换复刻页签准备其他素材。' };
    deactivating = true; renderStatus();
    try {
      await ensureAccount(); const before = JSON.stringify([...modes.values()].map(entry => ({draft:entry.draft,snapshot:entry.controller.snapshot()})));
      for (const entry of modes.values()) await persist(entry);
      await ensureAccount();
      // savedAt only reflects a completed write, so compare the substantive state.
      const comparable = entries => entries.map(entry => ({draft:{...entry.draft,savedAt:''},snapshot:entry.controller.snapshot()}));
      const old = JSON.parse(before).map(entry => ({draft:{...entry.draft,savedAt:''},snapshot:entry.snapshot}));
      if (allActive() || JSON.stringify(old) !== JSON.stringify(comparable([...modes.values()]))) throw new Error('素材或任务在保存期间发生变化，请稍后再切换。');
      return { allowed:true };
    } catch (error) { saveFault = true; showError(error); return {allowed:false,reason:error.message}; }
    finally { deactivating = false; renderStatus(); }
  }
  window.SanjieAestheticMirrorBridge = {
    getTaskState, canDeactivate,
    async activate() { if (initializing || startupFailed) return {ok:false,error:'爆款复刻尚未就绪，请重新打开工作台。'}; try { await ensureAccount(); await refreshModelInfo(); return {ok:true}; } catch(error) { showError(error); return {ok:false,error:error.message}; } },
    getState: () => ({ mode:activeMode,ready:!initializing && !startupFailed,initializing,startupFailed,busy:allActive() || uploadBusy || apiBusy,saveFault,drafts:Object.fromEntries([...modes.values()].map(entry => [entry.mode,{draft:clone(entry.draft),controller:entry.controller.snapshot()}])) })
  };
  function bindEvents() {
    document.addEventListener('click',event => { const button = event.target.closest('[data-am-action]'); if (button && (root.contains(button) || button.closest('#amInfoModal'))) handleAction(button).catch(showError); if (event.target === $('amInfoModal')) closeInfo(); });
    document.addEventListener('change',event => {
      const target = event.target; if (!root.contains(target)) return;
      if (target.dataset.amUpload) { const files = Array.from(target.files || []); target.value = ''; addFiles(files,target.dataset.amUpload).catch(showError); }
      else if (target.hasAttribute('data-am-api')) {
        if (apiLocked()) { renderModels(); return; }
        apiBusy = true; renderStatus();
        ensureAccount().then(() => bridge.selectBoundApi(target.value)).then(result => { if (result?.ok === false) throw new Error(result.error); return ensureAccount(); }).then(()=>refreshModelInfo()).catch(showError).finally(()=>{apiBusy=false;renderStatus();});
      } else if (target.id === 'amReceiptConfirmed') renderStatus();
      else if (target.dataset.amField) updateField(target);
    });
    document.addEventListener('input',event => { if (root.contains(event.target) && event.target.dataset.amField && event.target.tagName !== 'SELECT') updateField(event.target); });
    document.addEventListener('dragover',event => { const zone = event.target.closest('[data-am-drop]'); if (zone && root.contains(zone)) event.preventDefault(); });
    document.addEventListener('drop',event => { const zone = event.target.closest('[data-am-drop]'); if (!zone || !root.contains(zone)) return; const files = Array.from(event.dataTransfer?.files || []); if (files.length) { event.preventDefault(); event.stopPropagation(); addFiles(files,zone.dataset.amDrop).catch(showError); } });
    document.addEventListener('paste',event => {
      if (event.defaultPrevented || !root.contains(event.target) || event.target.closest('.cu-upload') || /TEXTAREA|INPUT/.test(event.target.tagName)) return;
      const files = Array.from(event.clipboardData?.items || []).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
      if (files.length) { event.preventDefault(); addFiles(files,binding().draft.references.length ? 'products' : 'references').catch(showError); }
    });
    document.addEventListener('keydown',event => {
      if (event.key === 'Escape' && $('amInfoModal')) { event.preventDefault(); closeInfo(); }
      if (event.key === 'Tab' && $('amInfoModal')) { const controls = [...$('amInfoModal').querySelectorAll('button,input,textarea')].filter(item=>!item.disabled), first = controls[0], last = controls.at(-1); if (event.shiftKey && document.activeElement === first) {event.preventDefault();last.focus();} else if (!event.shiftKey && document.activeElement === last) {event.preventDefault();first.focus();} }
    });
    window.addEventListener('sz-bound-api-changed',()=>{ if (!apiLocked()) refreshModelInfo().catch(showError); });
    document.addEventListener('cu-import-state',()=>renderStatus());
    window.addEventListener('beforeunload',event => { if (allActive() || uploadBusy || saveFault || window.SZ_IMAGE_UPLOAD?.isImporting?.()) { event.preventDefault(); event.returnValue = ''; } if (!startupFailed) for (const entry of modes.values()) persist(entry).catch(()=>{}); });
    document.addEventListener('visibilitychange',()=>{ if (startupFailed || initializing) return; if (document.visibilityState === 'hidden') for (const entry of modes.values()) persist(entry).catch(showError); else if (!apiLocked()) Promise.resolve(bridge.refresh?.()).then(ensureAccount).then(()=>refreshModelInfo()).catch(showError); });
  }
  function updateField(target) {
    if (inputLocked()) return;
    const field = target.dataset.amField, entry = binding();
    const value = field === 'count' ? Math.max(1,Math.min(limits(entry.mode).count,Number(target.value) || 1)) : target.value;
    if (entry.draft.config[field] === value) return;
    entry.draft.config[field] = value; invalidate(entry); renderStatus();
  }
  async function boot() {
    document.body.classList.add('aesthetic-mirror-mode');
    root = $('aestheticMirrorRoot'); if (!root) { root = document.createElement('div'); root.id = 'aestheticMirrorRoot'; document.querySelector('.app').append(root); } root.hidden = false;
    root.innerHTML = '<div class="am-startup" role="status">正在读取当前账号、素材与模型设置…</div>';
    for (let count=0;count<100 && (!window.SZ_CREATIVE_TOOLS_BRIDGE || !window.SZ_AESTHETIC_MIRROR_CONTRACT || !window.SZ_IMAGE_UPLOAD);count++) await new Promise(resolve=>setTimeout(resolve,100));
    bridge = window.SZ_CREATIVE_TOOLS_BRIDGE; contract = window.SZ_AESTHETIC_MIRROR_CONTRACT;
    if (!bridge || !contract || !window.SZ_IMAGE_UPLOAD) throw new Error('爆款复刻模块未完整加载，请重新打开工作台。');
    const ready = await bridge.ready();
    if (ready?.ok === false) throw new Error(ready.error || '统一 API 尚未准备好。');
    accountKey = String(ready?.accountKey || await bridge.getAccountKey());
    if (!accountKey.trim() || accountKey === 'local' || accountKey === 'undefined') throw new Error('请先登录账号，再打开爆款复刻。');
    if (ready?.boundApis && ready.boundApis.accountKey !== accountKey) throw new Error('模型配置和当前账号不一致，已停止读取草稿。');
    await ensureAccount(); await loadModes(); bindEvents(); render(); await refreshModelInfo(ready); initializing = false; renderStatus();
    document.body.dataset.mirrorStartup = 'ready'; window.SZ_LAB_STARTUP?.ready();
  }
  const start = () => boot().catch(error => { startupFailed = true; initializing = false; document.body.dataset.mirrorStartup = 'failed'; root.innerHTML = `<div class="am-startup am-error" role="alert"><h2>爆款复刻暂未就绪</h2><p>${esc(error.message || error)}</p><button id="amReload" class="am-button" type="button">重新读取</button></div>`; $('amReload').addEventListener('click',()=>location.reload()); window.SZ_LAB_STARTUP?.fail(error.message || String(error)); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',start,{once:true}); else start();
})();
