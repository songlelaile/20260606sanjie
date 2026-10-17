/* Standalone creative tools. Credentials remain in the existing API bridge only. */
(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  if (params.get('mode') !== 'creative') return;
  const TOOLS = { clothing: 'DIY成图', buyer: '买家秀', refinement: '产品精修' };
  const RATIOS = ['1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9','4:1','1:4','8:1','1:8'];
  const LANGUAGES = ['无文字纯视觉','中文简体','中文繁体','英语','日语','韩语','德语','荷兰语','法语','意大利语','阿拉伯语','俄语','泰语','印尼语','越南语','马来语','西班牙语','墨西哥西班牙语','葡萄牙语','巴西葡萄牙语','罗马尼亚语'];
  const VENUES = ['咖啡店窗边','服装店试衣镜','客厅沙发','公园长椅','商场试衣间','樱花步道','地铁站台','便利店门口','海边步道','书店一角'];
  const MAX_FILE_BYTES = 20 * 1024 * 1024;
  const environment = window.__SANJIE_ENVIRONMENT ? ':environment:' + encodeURIComponent(String(window.__SANJIE_ENVIRONMENT)) : '';
  let bridge, contract, root, controller, draft, accountKey, tool, database, saveTimer, saveQueue = Promise.resolve(), restoring = false;
  let notice = '', noticeKind = '', analysisBusy = false, uploadBusy = false, navigationBusy = false, modelReady = false, material = null, previewReturnFocus = null, modalReturnFocus = null;
  let apiSwitchBusy = false, apiRefreshSeq = 0, boundApis = [], currentModelInfo = {};
  let materialHistories = { model: [], scene: [] }, modalGenerationController = null, selectedPasteTarget = 'products';
  let initializing = true, startupFailed = false, deactivationBusy = false, identityChecks = 0, generationStarting = 0, modelRefreshes = 0, pendingSendRequests = 0;
  let saveFault = false;
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
  const uid = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const controllerActive = (value) => Boolean(value && (value.state.busy || value.state.awaitingReceipt || value.hasInFlightRequest?.() || [...(value.state.slots || []), ...(value.state.previousResults || [])].some((slot) => slot.archiveSaving)));
  const activeWork = () => identityChecks > 0 || generationStarting > 0 || modelRefreshes > 0 || pendingSendRequests > 0 || apiSwitchBusy || navigationBusy || uploadBusy || analysisBusy || Boolean(window.SZ_IMAGE_UPLOAD?.isImporting?.()) || controllerActive(controller) || controllerActive(modalGenerationController);
  const operationBusy = () => ((initializing || restoring) && !startupFailed) || activeWork();
  const isBusy = () => deactivationBusy || operationBusy();
  async function canDeactivate() {
    // A failed startup never exposed editable work. Preserve the original
    // stored draft rather than overwriting it with a partially restored one.
    if (startupFailed && !activeWork()) return { allowed: true };
    if (isBusy() || !draft || !controller) return { allowed: false, reason: '当前创作工具正在处理，请等待完成或停止后续生成，再切换入口。' };
    deactivationBusy = true;
    try {
      renderStatus(); renderMaterialStatus();
      await ensureAccount();
      if (operationBusy()) return { allowed: false, reason: '当前任务或图片导入正在执行，请稍后再切换。' };
      const savedState = JSON.stringify({ tool, draft, controller: controller.snapshot(), material, materialController: modalGenerationController?.snapshot() });
      await persist();
      await ensureAccount();
      if (operationBusy()) return { allowed: false, reason: '当前任务或图片导入正在执行，请稍后再切换。' };
      if (JSON.stringify({ tool, draft, controller: controller.snapshot(), material, materialController: modalGenerationController?.snapshot() }) !== savedState) {
        saveFault = true;
        return { allowed: false, reason: '草稿在保存期间发生变化，请稍后再切换入口。' };
      }
      // An idle uncertain receipt is retained by the snapshot and journal. It
      // still locks generation, but does not prevent browsing another tool.
      return { allowed: true };
    } catch (error) {
      saveFault = true;
      showError(error);
      return { allowed: false, reason: error.message || '当前草稿保存失败，请先检查浏览器存储空间。' };
    } finally {
      deactivationBusy = false;
      renderStatus(); renderMaterialStatus();
    }
  }
  window.SZ_CREATIVE_TOOLS_UI = {
    getState: () => ({ tool, ready: !initializing && !startupFailed, initializing, startupFailed, busy: isBusy(), saveFault, awaitingReceipt: pendingSendRequests > 0, draft: clone(draft), controller: controller ? controller.snapshot() : null, materialController: modalGenerationController ? modalGenerationController.snapshot() : null }),
    canDeactivate, persist, refreshModelInfo
  };
  const activeAccount = async () => String(await bridge.getAccountKey());
  function defaultDraft(which) {
    return { schema: 1, tool: which, mode: 'tryon', products: [], model: null, scene: null, config: { name: '', requirements: '', ratio: which === 'refinement' ? 'auto' : '3:4', resolution: '1K', language: '无文字纯视觉', count: 1, style: '品牌大片', background: 'original', analysis: '', basic: { white: { enabled: true, front: true, back: false }, threeD: { enabled: false, white: true }, mannequin: { enabled: false, white: true }, detail: { enabled: false, count: 1 }, selling: { enabled: false, count: 1 } } }, savedAt: null, snapshot: null };
  }
  async function openDB() {
    if (database) return database;
    database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('sz_creative_tools_drafts_v1' + environment, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('drafts');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('无法打开素材草稿库'));
    });
    return database;
  }
  async function dbGet(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => { const request = db.transaction('drafts').objectStore('drafts').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  }
  async function dbPut(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => { const tx = db.transaction('drafts','readwrite'); tx.objectStore('drafts').put(value,key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('保存草稿已取消')); });
  }
  async function mergeMaterialHistories(key,incoming) {
    const db=await openDB();
    return new Promise((resolve,reject)=>{const tx=db.transaction('drafts','readwrite'),store=tx.objectStore('drafts'),request=store.get(key);request.onsuccess=()=>{const saved=request.result||{},merged={};for(const kind of ['model','scene']){const seen=new Set();merged[kind]=[...(incoming[kind]||[]),...(saved[kind]||[])].filter((item)=>{const identity=`${item.source||'uploaded'}:${item.image||item.id}`;if(seen.has(identity))return false;seen.add(identity);return true;});}store.put(merged,key);};tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('素材历史保存失败'));});
  }
  function draftKey(which = tool) { return `${accountKey}:tool:${which}`; }
  function historyKey() { return `${accountKey}:material-history`; }
  function journal(suffix) {
    const key = `sz_creative_pending_v1${environment}:${accountKey}:${suffix}`;
    return { read() { return JSON.parse(localStorage.getItem(key) || 'null'); }, write(receipt) { localStorage.setItem(key, JSON.stringify(receipt)); }, clear() { localStorage.removeItem(key); } };
  }
  function snapshotDraft() {
    if (!draft) return null;
    const snapshot = clone(draft);
    snapshot.savedAt = new Date().toISOString();
    snapshot.snapshot = controller ? controller.snapshot() : null;
    return snapshot;
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { persist().catch(showError); }, 350);
  }
  async function persist() {
    clearTimeout(saveTimer);
    if (!draft || restoring) throw new Error('素材草稿尚未恢复完成，请稍后再保存。');
    const key = draftKey(), value = snapshotDraft(), histories = clone(materialHistories), hKey = historyKey();
    const materialKey = material && modalGenerationController ? `${accountKey}:material-draft:${material.kind}` : null;
    const materialValue = materialKey ? { config: clone(material.config), snapshot: modalGenerationController.snapshot() } : null;
    saveQueue = saveQueue.catch(() => {}).then(async () => { await dbPut(key,value); await mergeMaterialHistories(hKey,histories); if (materialKey) await dbPut(materialKey,materialValue); });
    try { await saveQueue; saveFault = false; } catch (error) { saveFault = true; throw error; }
    if ($('ctDraftState')) $('ctDraftState').textContent = '素材与方案已保存至当前账号草稿';
  }
  function setNotice(text, kind = '') { notice = text; noticeKind = kind; renderStatus(); }
  function showError(error) { setNotice(error && error.message || String(error), 'error'); }
  async function ensureAccount() {
    if (await activeAccount() === accountKey) return true;
    setNotice('当前账号已切换。请刷新页面载入该账号的草稿，原账号素材仍保留。', 'error');
    throw new Error('账号已切换，当前操作已停止');
  }
  function readInput() {
    // Keep references in the draft for tab restoration; only eligible routes submit them.
    const usesReferences = tool === 'buyer' || (tool === 'clothing' && draft.mode === 'tryon');
    return { tool, mode: draft.mode, config: clone(draft.config), products: draft.products.map((item) => ({ image: item.image, name: item.name, width: item.width, height: item.height })), modelImage: usesReferences && draft.model && draft.model.image || '', sceneImage: usesReferences && draft.scene && draft.scene.image || '' };
  }
  async function withGenerationLock(suffix,run) {
    generationStarting++; renderStatus(); renderMaterialStatus();
    try {
      await ensureAccount();
      if(!navigator.locks || typeof navigator.locks.request!=='function')throw new Error('当前浏览器不支持任务防重锁，请使用新版 Chrome 浏览器。');
      return await navigator.locks.request(`sz-creative-generation${environment}:${accountKey}:${suffix}`,{ifAvailable:true},async(lock)=>{if(!lock)throw new Error('当前账号已在另一个页面执行这项生成，请等待该任务结束。');await ensureAccount();return run();});
    } finally { generationStarting--; renderStatus(); renderMaterialStatus(); }
  }
  function bridgeConfig() { return typeof bridge.config === 'function' ? bridge.config() : bridge.config; }
  async function trackedSend(...args) {
    // The creative controller's timeout can finish before bridge.send settles.
    // Keep this iframe alive for the original transport, including modal work.
    pendingSendRequests++; renderStatus(); renderMaterialStatus();
    try { return await bridge.send(...args); }
    finally { pendingSendRequests--; renderStatus(); renderMaterialStatus(); }
  }
  function makeController(options = {}) {
    return contract.createController({ readInput, config: bridgeConfig, send: trackedSend, archive: bridge.archive, archiveContext: bridge.archiveContext, newJobId: bridge.newJobId, register: bridge.registerGenerationJob, unregister: bridge.unregisterGenerationJob, journal: journal(tool), onChange() { if (!restoring) { renderStatus(); renderResults(); scheduleSave(); } }, ...options });
  }
  async function loadTool(which, options = {}) {
    const previous = { tool, draft, controller, restoring };
    restoring = true;
    try {
      tool = Object.hasOwn(TOOLS,which) ? which : 'clothing';
      let saved;
      try { saved = await dbGet(draftKey()); } catch (error) { notice = `草稿恢复失败：${error.message}。新素材仍可使用，请关注保存状态。`; noticeKind = 'error'; }
      draft = saved && saved.schema === 1 && saved.tool === tool ? saved : defaultDraft(tool);
      // Only allow fields from this tool's schema into the UI. No provider credentials are stored here.
      draft.products = Array.isArray(draft.products) ? draft.products.slice(0,tool === 'refinement' ? 50 : 6) : [];
      draft.config = { ...defaultDraft(tool).config, ...draft.config };
      draft.config.basic = { ...defaultDraft(tool).config.basic, ...draft.config.basic };
      controller = makeController();
      if (draft.snapshot) { const restored=controller.restore(draft.snapshot);if(restored&&restored.ok===false)throw new Error(restored.error||'草稿方案无法安全恢复，原稿仍保留。'); }
    } catch (error) {
      ({ tool, draft, controller, restoring } = previous);
      throw error;
    }
    restoring = false;
    render(options);
  }
  function options(values, selected) { return values.map((value) => `<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}>${esc(value === 'auto' ? '自动 · 保持原图比例' : value)}</option>`).join(''); }
  function fieldSelect(label,key,values,value) { return `<label>${esc(label)}<select data-field="${esc(key)}">${options(values,value)}</select></label>`; }
  function checked(value) { return value ? ' checked' : ''; }
  function basicOptions() {
    const basic = draft.config.basic;
    return `<div class="ct-basic-grid">${[
      ['white','白底精修',`<label><input type="checkbox" data-field="basic.white.front"${checked(basic.white.front)}>正面</label><label><input type="checkbox" data-field="basic.white.back"${checked(basic.white.back)}>背面</label>`],
      ['threeD','3D 立体展示',`<label><input type="checkbox" data-field="basic.threeD.white"${checked(basic.threeD.white)}>白色背景</label>`],
      ['mannequin','人台展示',`<label><input type="checkbox" data-field="basic.mannequin.white"${checked(basic.mannequin.white)}>白色背景</label>`],
      ['detail','细节特写',`<label>数量 <input type="number" min="1" max="15" step="1" data-field="basic.detail.count" value="${esc(basic.detail.count)}"></label>`],
      ['selling','卖点图',`<label>数量 <input type="number" min="1" max="15" step="1" data-field="basic.selling.count" value="${esc(basic.selling.count)}"></label>`]
    ].map(([key,label,inner]) => `<div class="ct-type"><label><input type="checkbox" data-field="basic.${key}.enabled"${checked(basic[key].enabled)}>${label}</label><div class="ct-type-options"${basic[key].enabled ? '' : ' hidden'}>${inner}</div></div>`).join('')}</div><p class="ct-note">整组最多 15 张。正背面、3D、人台各 1 张；细节和卖点按所选数量整理方案。</p>`;
  }
  function dropzone(kind, caption, multiple = false) {
    const product = kind === 'products', refinement = tool === 'refinement' && product;
    const formats = refinement ? 'image/png,image/jpeg' : 'image/png,image/jpeg,image/webp';
    const title = product ? '产品图' : kind === 'model' ? '模特图' : '场景图';
    const required = tool === 'clothing' && draft.mode === 'tryon' && kind === 'model';
    const max = product ? (refinement ? 50 : 6) : 1;
    return window.SZ_IMAGE_UPLOAD.markup({title,subtitle:product ? '上传清晰的产品图片' : `上传清晰的${title} · ${required ? '必填' : '可选'}`,count:product ? draft.products.length : Number(Boolean(draft[kind])),max,hint:product ? (refinement ? 'JPG / PNG · 最多 50 张待精修产品图' : '白底产品图最佳 · 最多 6 张同款商品图') : `JPG / PNG / WebP · 应用 1 张${title}`,note:product ? (refinement ? '每张原图单独精修，按顺序提交，原图会保留。单张不超过 20 MB；停止后续任务不重发已提交图片。' : '多图用于补充同一商品的必要视角，原图会保留。') : `${kind === 'model' ? '仅用于人物外观与姿态参考' : '仅用于环境与构图参考'}，原图会保留。单张不超过 20 MB。`,input:`<input type="file" data-upload="${kind}" accept="${formats}"${multiple ? ' multiple' : ''} aria-label="${esc(caption)}"${isBusy() ? ' disabled' : ''}>`,zoneAttributes:`data-drop="${kind}"`});
  }
  function referencePanel(kind) {
    const item = draft[kind], title = kind === 'model' ? '模特' : '场景';
    return `<section class="panel">${dropzone(kind,`上传${title}图`)}<div class="ct-actions" style="justify-content:flex-end;margin-top:10px"><button class="btn ghost" type="button" data-action="material-open" data-kind="${kind}">素材库 / AI 生成</button></div>${item ? `<div class="ct-ref-selected"><img src="${esc(item.image)}" alt="${title}参考图" data-action="preview-reference" data-kind="${kind}" tabindex="0"><div><strong>${esc(item.name)}</strong><p class="ct-note">只应用素材，不会再次生成</p></div><button type="button" class="btn ghost" data-action="remove-reference" data-kind="${kind}">移除引用</button></div>` : ''}</section>`;
  }
  function render(options = {}) {
    const isClothing = tool === 'clothing', isBasic = isClothing && draft.mode === 'basic', cfg = draft.config;
    document.title = `少壮AI · ${TOOLS[tool]}`;
    if ($('labHeroTitle')) $('labHeroTitle').textContent = TOOLS[tool];
    if ($('labHeroEyebrow')) $('labHeroEyebrow').textContent = 'CREATIVE STUDIO';
    if ($('labHeroSubtitle')) $('labHeroSubtitle').textContent = tool === 'clothing' ? '从服装原图到试穿与详情套图，逐张确认方案后生成。' : tool === 'buyer' ? '参考真实商品、模特和场景，制作自然的买家秀图片。' : '批量整理产品画面，保留款式、颜色、结构与细节。';
    root.innerHTML = `<div class="ct-topbar"><nav class="ct-tabs" aria-label="创作工具">${Object.entries(TOOLS).map(([key,label]) => `<button type="button" data-action="switch-tool" data-tool="${key}" role="tab" aria-selected="${key === tool}">${label}</button>`).join('')}</nav><div id="ctModelNote" class="ct-model-note">正在读取统一 API 配置…</div></div>
      <ol class="ct-steps" aria-label="创作步骤"><li data-step="upload"><b>1</b>上传素材</li><li data-step="plan"><b>2</b>整理方案</li><li data-step="review"><b>3</b>确认方案</li><li data-step="generate"><b>4</b>生成中</li><li data-step="done"><b>5</b>查看结果</li></ol>
      <div class="ct-workspace"><div><fieldset id="ctInputFields" style="border:0;padding:0;margin:0;min-width:0">
        ${isClothing ? `<section class="panel"><div class="ct-tabs" role="tablist" aria-label="DIY成图模式"><button type="button" data-action="switch-mode" data-mode="tryon" role="tab" aria-selected="${draft.mode === 'tryon'}">模特试穿</button><button type="button" data-action="switch-mode" data-mode="basic" role="tab" aria-selected="${draft.mode === 'basic'}">基础套图</button></div></section>` : ''}
        ${tool === 'buyer' ? `<section class="panel"><div class="ct-tabs" role="tablist" aria-label="买家秀类型"><button type="button" role="tab" aria-selected="true">买家秀</button><button type="button" role="tab" aria-selected="false" disabled title="参考功能尚未上线">种草图 · 即将上线</button></div></section>` : ''}
        <section class="panel">${dropzone('products',tool === 'refinement' ? '上传待精修产品图' : '上传同款产品多角度图',true)}<div class="ct-actions" style="justify-content:flex-end;margin-top:10px"><button class="btn ghost" type="button" data-action="clear-products"${draft.products.length ? '' : ' disabled'}>清空素材</button></div><div id="ctProductGrid" class="ct-assets"></div></section>
        ${tool !== 'refinement' && !isBasic ? referencePanel('model') + referencePanel('scene') : ''}
        ${isBasic ? `<section class="panel"><div class="ct-section-title"><h2>套图类型</h2></div>${basicOptions()}</section>` : ''}
        <section class="panel"><div class="ct-section-title"><h2>生成设置</h2></div><div class="ct-form">
          <label class="ct-wide">项目名称<input data-field="name" maxlength="120" value="${esc(cfg.name)}" placeholder="便于在本机历史中查找"></label>
          <label class="ct-wide">${isClothing ? '组图要求' : '生成要求'}<textarea data-field="requirements" maxlength="6000" placeholder="描述展示重点、构图或已知卖点；未提供的性能与规格不会作为事实补写">${esc(cfg.requirements)}</textarea></label>
          ${fieldSelect('画面比例','ratio',tool === 'refinement' ? ['auto',...RATIOS] : tool === 'buyer' ? RATIOS.slice(0,10) : RATIOS,cfg.ratio)}
          ${fieldSelect('清晰度','resolution',['1K','2K','4K'],cfg.resolution)}
          ${!isBasic && tool !== 'refinement' ? `<label>生成数量<input type="number" data-field="count" min="1" max="${tool === 'buyer' ? 8 : 15}" step="1" value="${esc(cfg.count)}"></label>` : ''}
          ${isClothing ? fieldSelect('目标语言','language',LANGUAGES,cfg.language) : ''}
          ${isClothing && !isBasic ? fieldSelect('画面风格','style',['品牌大片','手机网感'],cfg.style) : ''}
          ${tool === 'refinement' ? `<label>背景处理<select data-field="background"><option value="original"${cfg.background === 'original' ? ' selected' : ''}>保留原背景</option><option value="white"${cfg.background === 'white' ? ' selected' : ''}>纯白背景</option></select></label>` : ''}
        </div><p class="ct-note" id="ctParameterNote">沿用统一 API 的生图模型和计费方式，默认 1 张 / 1K。清晰度由现有模型适配器转换为实际请求。</p>
        <div class="ct-actions ct-main-actions"><button class="btn primary" type="button" data-action="build-plan">整理可编辑方案</button>${typeof bridge.analyze === 'function' ? '<button class="btn ghost" type="button" data-action="analyze">AI 分析素材</button>' : ''}</div><p class="ct-note">整理方案仅在本机执行，不调用模型。${typeof bridge.analyze === 'function' ? 'AI 分析会单独调用已配置的视觉模型。' : ''}</p>
        ${draft.analysisCandidate ? `<details class="ct-plan" open><summary>AI 分析待确认</summary><div class="ct-plan-body"><p class="ct-note">请核对可见信息，编辑保存后才用于生成。</p><textarea id="ctAnalysisCandidate" maxlength="12000">${esc(draft.analysisCandidate)}</textarea><div class="ct-actions"><button class="btn primary" type="button" data-action="save-analysis">保存并采用分析</button><button class="btn ghost" type="button" data-action="discard-analysis">弃用分析</button></div></div></details>` : ''}
        ${cfg.analysis ? `<details class="ct-plan"><summary>已保存的 AI 分析</summary><div class="ct-plan-body"><p class="ct-plan-prompt">${esc(cfg.analysis)}</p><button class="btn ghost" type="button" data-action="clear-analysis">移除分析</button></div></details>` : ''}
        </section></fieldset><p id="ctDraftState" class="ct-note">${draft.savedAt ? '已恢复当前账号草稿' : '素材与方案仅保存在当前账号的本机草稿中'}</p></div>
      <div><section class="panel"><div class="ct-section-title"><h2>生成方案</h2><button class="btn ghost" type="button" data-action="reset">重新开始</button></div><div id="ctStatus" class="ct-message" role="status" aria-live="polite"></div><div id="ctUncertain" class="ct-uncertain" hidden><p>上一任务的提供方状态尚未确认。请先核对提供方任务或用量记录，避免重复扣费。</p><label class="ct-note"><input id="ctUncertainConfirmed" type="checkbox">我已核对上一任务状态，可继续操作</label><div class="ct-actions"><button class="btn ghost" type="button" data-action="resolve-uncertain" disabled>解除等待</button></div></div><div id="ctPlanGrid"></div><div id="ctGenerateActions" class="ct-actions ct-main-actions"><button id="ctGenerateBtn" class="btn primary" type="button" data-action="generate" disabled>按方案生成</button><button id="ctStopBtn" class="btn ghost" type="button" data-action="stop" hidden>停止后续生成</button><button id="ctRetryFailedBtn" class="btn ghost" type="button" data-action="retry-failed" hidden>重试失败项</button></div><p class="ct-note">点击生成才会调用模型；失败重试会发起新的请求，补存仅保存已有原件。</p></section>
      <section class="panel"><div class="ct-section-title"><h2>生成结果 <span id="ctResultCount" class="pill">0</span></h2><button id="ctDownloadAll" class="btn ghost" type="button" data-action="download-all" disabled>下载全部</button></div><progress id="ctProgress" class="ct-progress" max="1" value="0" hidden aria-label="生成进度"></progress><div id="ctResultGrid" class="ct-results"></div><div id="ctEmptyResult" class="ct-empty"><strong>从一张产品图开始</strong>确认方案后，生成结果会按顺序出现在这里。</div><p class="ct-note">成功结果沿用既有本机档案。素材草稿与正式成果分开保留，原件保存状态请在本机历史查看。</p></section></div></div>`;
    renderProducts(); renderPlans(); renderStatus(); renderResults(); refreshModelInfo(options.configSnapshot);
  }
  function renderProducts() {
    const target = $('ctProductGrid'); if (!target) return;
    target.innerHTML = draft.products.map((item,index) => `<div class="ct-asset"><button class="ct-asset-preview" type="button" data-action="preview-product" data-index="${index}" aria-label="预览产品图 ${index+1}"><img src="${esc(item.image)}" alt="产品图 ${index+1}"></button><button class="ct-remove" type="button" data-action="remove-product" data-index="${index}" aria-label="移除产品图 ${index+1}">×</button><div class="ct-asset-name" title="${esc(item.name)}">${index+1}. ${esc(item.name)}</div></div>`).join('');
    const count = root.querySelector('[data-drop="products"]')?.closest('.cu-upload')?.querySelector('[data-cu-count]');
    if (count) count.textContent = `${draft.products.length}/${tool === 'refinement' ? 50 : 6}`;
    const clear = root.querySelector('[data-action="clear-products"]'); if (clear) clear.disabled = !draft.products.length || isBusy();
  }
  function state() { return controller && controller.state || { slots: [] }; }
  function renderCredits() {
    const hints=window.SZCreativeCreditHints;if(!hints||!root||!bridge||!draft)return;
    const config=bridgeConfig()||{},slots=state().slots||[];
    const model=config.imageModel||currentModelInfo.model||'';
    root.querySelectorAll('[data-action="analyze"]').forEach(button=>hints.chat(button,config.visionModel,'本次 1 项素材分析；整理方案为本地操作'));
    hints.image($('ctGenerateBtn'),model,state().plan?Array(slots.filter(slot=>['ready','queued'].includes(slot.status)).length).fill(1):null,state().plan?'按已确认方案的待生成张数计算':'先整理并确认方案，按实际待生成张数估算');
    hints.image($('ctRetryFailedBtn'),model,Array(slots.filter(slot=>slot.status==='failed').length).fill(1),'只重新请求失败项，成功图片保留');
    root.querySelectorAll('[data-action="retry-shot"]').forEach(button=>hints.image(button,model,[1],'本次重新生成 1 张图片'));
    if(material&&modalGenerationController){
      const current=modalGenerationController.state,pending=contract.createMaterialPlan({kind:material.kind,config:clone(material.config)});
      const same=pending.ok&&current.plan&&pending.sourceSignature===current.plan.sourceSignature;
      const failed=(current.slots||[]).filter(slot=>slot.status==='failed').length,ready=(current.slots||[]).filter(slot=>['ready','queued'].includes(slot.status)).length;
      const count=same&&failed?failed:same&&ready?ready:pending.ok?pending.shots.length:null;
      hints.image($('ctMaterialGenerate'),model,count===null?null:Array(count).fill(1),`本次 ${count===null?'待确认':count} 张${material.kind==='model'?'模特':'场景'}素材；应用已有素材不再生成`);
    }
  }
  window.SZCreativeCreditHints?.register('creative-tools',renderCredits);
  function renderPlans() {
    const target = $('ctPlanGrid'); if (!target) return;
    const plan = state().plan;
    if (!plan || !plan.shots || !plan.shots.length) { target.innerHTML = '<div class="ct-empty"><strong>先整理方案，再确认生图</strong>上传素材并选择参数，点击「整理可编辑方案」。</div>'; return; }
    target.innerHTML = `<p class="ct-note">共 ${plan.shots.length} 张 · ${esc((plan.config && plan.config.ratio || draft.config.ratio) === 'auto' ? '原图比例' : plan.config && plan.config.ratio || draft.config.ratio)} · ${esc(plan.config && plan.config.resolution || draft.config.resolution)}。编辑保存后的文字会用于实际提交与档案记录。</p>` + plan.shots.map((shot,index) => `<details class="ct-plan" data-shot="${esc(shot.id)}"${index === 0 ? ' open' : ''}><summary>${index+1}. ${esc(shot.label)}</summary><div class="ct-plan-body"><div data-plan-read="${esc(shot.id)}"><p class="ct-plan-prompt">${esc(shot.prompt)}</p><button class="btn ghost" type="button" data-action="edit-plan" data-id="${esc(shot.id)}"${isBusy() ? ' disabled' : ''}>编辑方案</button></div><div data-plan-edit="${esc(shot.id)}" hidden><label class="ct-field">图片名称<input data-plan-label="${esc(shot.id)}" maxlength="120" value="${esc(shot.label)}"></label><label class="ct-field">生成方案<textarea data-plan-prompt="${esc(shot.id)}" maxlength="20000">${esc(shot.prompt)}</textarea></label><div class="ct-actions"><button class="btn primary" type="button" data-action="save-plan" data-id="${esc(shot.id)}">保存方案</button><button class="btn ghost" type="button" data-action="cancel-plan" data-id="${esc(shot.id)}">取消编辑</button></div></div></div></details>`).join('');
  }
  function renderStatus() {
    if (!root || !$('ctStatus')) return;
    const current = state(), slots = current.slots || [], busy = isBusy();
    if (bridge && typeof bridge.setApiBusy === 'function') bridge.setApiBusy('creative', Boolean(busy || current.uncertain || modalGenerationController && modalGenerationController.state.uncertain));
    const status = window.SZ_IMAGE_UPLOAD?.isImporting?.() ? '正在下载并校验图片 URL，请稍候…' : uploadBusy ? '正在读取并校验图片，请稍候…' : notice || current.message || '上传素材后整理方案；确认内容再调用已配置的生图模型。';
    $('ctStatus').textContent = analysisBusy ? '正在分析素材，模型返回后会保存分析结果…' : status;
    $('ctStatus').className = `ct-message ${noticeKind || (current.kind === 'error' ? 'error' : '')}`;
    $('ctInputFields').disabled = busy;
    root.querySelectorAll('[data-upload]').forEach((input) => { input.disabled = busy; });
    const clearProducts = root.querySelector('[data-action="clear-products"]'); if (clearProducts) clearProducts.disabled = busy || !draft.products.length;
    updateApiControls();
    const editable = Boolean(current.plan && current.plan.shots && current.plan.shots.length);
    const readyCount = slots.filter((slot) => ['ready','queued'].includes(slot.status)).length;
    $('ctGenerateBtn').disabled = busy || !editable || current.uncertain || !modelReady || !readyCount;
    $('ctGenerateBtn').textContent = current.busy ? '生成中…' : editable && !readyCount ? (slots.length && slots.every((slot)=>slot.status==='done') ? '本组已完成' : '本组无待生成图片') : current.stopped && readyCount ? `继续生成 ${readyCount} 张` : `按方案生成${editable ? ` · ${readyCount} 张` : ''}`;
    $('ctStopBtn').hidden = !current.busy;
    $('ctRetryFailedBtn').hidden = !slots.some((slot) => slot.status === 'failed');
    $('ctRetryFailedBtn').disabled = busy || current.uncertain || !modelReady;
    $('ctUncertain').hidden = !current.uncertain;
    root.querySelector('[data-action="resolve-uncertain"]').disabled = busy || !$('ctUncertainConfirmed').checked;
    root.querySelectorAll('[data-action="switch-tool"],[data-action="reset"],[data-action="edit-plan"],[data-action="save-plan"]').forEach((button) => { button.disabled = busy; });
    const done = slots.filter((slot) => slot.status === 'done').length;
    let step = current.busy ? 'generate' : slots.length && done === slots.length ? 'done' : editable ? 'review' : draft.products.length ? 'plan' : 'upload';
    const stages = ['upload','plan','review','generate','done'], activeIndex = stages.indexOf(step);
    root.querySelectorAll('[data-step]').forEach((item) => { const index = stages.indexOf(item.dataset.step); item.classList.toggle('active',index === activeIndex); item.classList.toggle('complete',index < activeIndex); });
    renderCredits();
  }
  function resultSlots() { const current=state(); return (current.slots||[]).concat((current.previousResults||[]).filter((slot)=>slot.item)); }
  function itemImage(item) { return item && (item.url || item.image || item.dataUrl || item.imageUrl) || ''; }
  function renderResults() {
    if (!$('ctResultGrid')) return;
    const current = state(), slots = resultSlots();
    const completed = slots.filter((slot) => ['done','outdated'].includes(slot.status) && itemImage(slot.item));
    $('ctResultCount').textContent = `${completed.length}${slots.length ? ` / ${slots.length}` : ''}`;
    $('ctDownloadAll').disabled = !completed.length;
    $('ctEmptyResult').hidden = Boolean(slots.length);
    $('ctProgress').hidden = !slots.length;
    $('ctProgress').max = slots.length || 1;
    $('ctProgress').value = slots.filter((slot) => ['done','outdated','failed','stopped','uncertain'].includes(slot.status)).length;
    const labels = { ready:'待生成',queued:'排队中',generating:'生成中…',done:'已生成',outdated:'方案已改，旧图待明确重生',failed:'生成失败',stopped:'已停止',uncertain:'等待核对提供方任务' };
    $('ctResultGrid').innerHTML = slots.map((slot,index) => {
      const image = itemImage(slot.item), title = slot.item && (slot.item.variantName || slot.item.businessRoleName) || slot.shot && slot.shot.label || `结果 ${index+1}`;
      const previous = !(current.slots || []).includes(slot);
      const archived = slot.archiveOk === true;
      return `<article class="ct-result"><button class="ct-result-image" type="button" data-action="preview-result" data-index="${index}"${image ? '' : ' disabled'} aria-label="${esc(image ? `预览${title}` : labels[slot.status] || slot.status)}">${image ? `<img src="${esc(image)}" alt="${esc(title)}">` : esc(labels[slot.status] || slot.status || '待生成')}</button><div class="ct-result-content"><h3>${esc(title)}${previous ? ' · 历史版本' : ''}</h3><p>${esc(labels[slot.status] || slot.status || '')}</p>${image ? `<p class="ct-note">${esc([slot.item.ratio,slot.item.resolution,slot.item.model].filter(Boolean).join(' · '))}</p>` : ''}${slot.error ? `<p class="ct-error">${esc(slot.error.message || slot.error)}</p>` : ''}${image ? `<p class="${archived ? 'ct-note success' : 'ct-error'}">${archived ? '已保存至本机历史' : '原件待补存'}${slot.archiveError ? `：${esc(slot.archiveError.message || slot.archiveError)}` : ''}</p>` : ''}<div class="ct-card-actions">${image ? `<button class="btn ghost" type="button" data-action="download-result" data-index="${index}">下载</button><button class="btn ghost" type="button" data-action="preview-result" data-index="${index}">对照预览</button>${!archived ? `<button class="btn ghost" type="button" data-action="retry-archive" data-index="${index}"${current.busy ? ' disabled' : ''}>补存原件</button>` : ''}${typeof bridge.openResultAction === 'function' ? (bridge.resultActions || []).map((action) => `<button class="btn ghost" type="button" data-action="result-${esc(action)}" data-index="${index}">${esc({edit:'编辑 / 引导重生',video:'生成视频',fission:'裂变衍生'}[action] || action)}</button>`).join('') : ''}` : ''}${!previous && ['failed','done','outdated'].includes(slot.status) ? `<button class="btn ghost" type="button" data-action="retry-shot" data-id="${esc(slot.shot && slot.shot.id || '')}"${current.busy || current.uncertain || !modelReady ? ' disabled' : ''}>${['done','outdated'].includes(slot.status) ? '重新生成' : '重试生成'}</button>` : ''}</div></div></article>`;
    }).join('');
    renderCredits();
  }
  function apiSwitchLocked() {
    return isBusy() || Boolean(controller && controller.state.uncertain) || Boolean(modalGenerationController && modalGenerationController.state.uncertain);
  }
  function apiSelectorMarkup(id) {
    const selected = currentModelInfo.provider || '';
    const available = boundApis.some((entry) => entry.provider === selected);
    const empty = !boundApis.length ? '暂无已绑定的可用生图 API' : '请选择已绑定 API';
    return `<label class="ct-api-label" for="${id}">生图 API</label><select id="${id}" data-bound-image-api aria-label="已绑定生图 API"${apiSwitchLocked() || !boundApis.length ? ' disabled' : ''}>${available ? '' : `<option value="" selected disabled>${esc(empty)}</option>`}${boundApis.map((entry) => `<option value="${esc(entry.provider)}"${entry.provider === selected ? ' selected' : ''}>${esc(entry.label || entry.provider)} · ${esc(entry.imageModel || '')}</option>`).join('')}</select><button class="btn ghost" type="button" data-action="open-config"${isBusy() ? ' disabled' : ''}>配置 API</button>`;
  }
  function renderApiSelectors() {
    if ($('ctModelNote')) $('ctModelNote').innerHTML = apiSelectorMarkup('ctBoundApi');
    if ($('ctMaterialApi')) $('ctMaterialApi').innerHTML = apiSelectorMarkup('ctMaterialBoundApi');
  }
  function updateApiControls() {
    for (const id of ['ctBoundApi', 'ctMaterialBoundApi']) if ($(id)) $(id).disabled = apiSwitchLocked() || !boundApis.length;
    for (const id of ['ctModelNote', 'ctMaterialApi']) if ($(id)) $(id).querySelectorAll('[data-action="open-config"]').forEach((button) => { button.disabled = isBusy(); });
  }
  async function refreshModelInfo(refreshed) {
    const seq = ++apiRefreshSeq;
    modelRefreshes++; renderStatus(); renderMaterialStatus();
    try {
      const catalog = typeof bridge.listBoundApis === 'function' ? await bridge.listBoundApis(refreshed&&refreshed.boundApis) : { ok: false, error: '请重新打开工作台后选择已配置 API。' };
      if (seq !== apiRefreshSeq) return;
      if (!catalog || !catalog.ok) throw new Error(catalog && catalog.error || '读取已绑定 API 失败');
      if (catalog.accountKey && catalog.accountKey !== accountKey) throw new Error('当前账号已切换，请刷新页面。');
      const info = typeof bridge.modelInfo === 'function' ? await bridge.modelInfo() : bridge.modelInfo || {};
      if (seq !== apiRefreshSeq) return;
      boundApis = catalog.providers || catalog.catalog || [];
      currentModelInfo = typeof info === 'string' ? { model: info } : info;
      modelReady = info.ready !== false && info.supportsReference !== false && boundApis.some((entry) => entry.provider === info.provider);
      if ($('ctParameterNote')) $('ctParameterNote').textContent = !modelReady ? '请选择已绑定且支持参考图的生图 API，或打开统一 API 设置完成配置。' : (info.specificationHint || '沿用所选 API 的生图模型和计费方式，默认 1 张 / 1K；实际尺寸由模型适配器处理。');
      renderApiSelectors();
      if (info.resolutions && Array.isArray(info.resolutions) && info.resolutions.length) {
        const select = root.querySelector('[data-field="resolution"]');
        if (select) { const value = info.resolutions.includes(draft.config.resolution) ? draft.config.resolution : info.resolutions[0]; select.innerHTML = options(info.resolutions,value); if (value !== draft.config.resolution) { draft.config.resolution = value; invalidate('模型规格已更新，请重新整理方案。'); } }
      }
      renderStatus();renderResults();renderMaterialStatus();
    } catch (error) {
      if (seq !== apiRefreshSeq) return;
      modelReady = false; boundApis = []; renderApiSelectors(); renderStatus();renderResults();renderMaterialStatus();
      if ($('ctParameterNote')) $('ctParameterNote').textContent = error.message || '模型配置暂不可用，请打开统一 API 设置。';
    } finally {
      modelRefreshes--; renderStatus(); renderMaterialStatus();
    }
  }
  async function switchBoundApi(provider) {
    if (apiSwitchLocked()) { renderApiSelectors(); throw new Error('请等待当前任务结束或先核对未确认的任务，再切换 API。'); }
    if (!provider || provider === currentModelInfo.provider) { renderApiSelectors(); return; }
    if (!boundApis.some((entry) => entry.provider === provider)) { renderApiSelectors(); throw new Error('该 API 尚未绑定或不支持参考图。'); }
    apiSwitchBusy = true; renderStatus(); renderMaterialStatus();
    try {
      await ensureAccount();
      const response = await bridge.selectBoundApi(provider);
      if (!response || !response.ok) throw new Error(response && response.error || 'API 切换失败，请重试。');
      await ensureAccount();
      await refreshModelInfo();
      setNotice('已切换生图 API，后续生成将使用所选模型。素材、方案与已有结果已保留。', 'success');
    } finally {
      await refreshModelInfo();
      apiSwitchBusy = false;
      renderStatus();renderMaterialStatus();
    }
  }
  function invalidate(message) {
    notice = message || '素材或设置已变更，请重新整理方案。'; noticeKind = '';
    controller.invalidate(); renderPlans(); renderStatus(); scheduleSave();
  }
  function getFieldPath(path) { return path.split('.'); }
  function updateField(path,value) {
    let target = draft.config; const parts = getFieldPath(path);
    for (let i=0;i<parts.length-1;i++) target = target[parts[i]];
    if (target[parts[parts.length-1]] === value) return;
    target[parts[parts.length-1]] = value;
    invalidate();
  }
  function decodeFile(file) {
    return new Promise((resolve,reject) => {
      if (!file || !['image/png','image/jpeg','image/webp'].includes(file.type)) return reject(new Error('仅支持 JPG、PNG、WebP 图片。'));
      if (file.size > MAX_FILE_BYTES) return reject(new Error(`${file.name} 超过 20 MB，请先缩小图片。`));
      if (!file.size) return reject(new Error(`${file.name} 是空文件。`));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
      reader.onload = () => { const image = new Image(); image.onerror = () => reject(new Error(`${file.name} 无法解码，请使用正常的图片文件。`)); image.onload = () => { if (!image.naturalWidth || !image.naturalHeight) return reject(new Error('图片尺寸无效')); resolve({ id:uid(), name:file.name || '粘贴的图片', image:String(reader.result), width:image.naturalWidth, height:image.naturalHeight, source:'uploaded', createdAt:new Date().toISOString() }); }; image.src = String(reader.result); };
      reader.readAsDataURL(file);
    });
  }
  async function addFiles(files,kind) {
    const list = Array.from(files || []);
    if (isBusy()) throw new Error('当前任务或图片导入正在执行，请稍后再操作。');
    if (!list.length) return;
    const sourceDraft=draft,sourceTool=tool;
    uploadBusy=true;renderStatus();renderMaterialStatus();
    try {
      await ensureAccount();
      const max = kind === 'products' ? (tool === 'refinement' ? 50 : 6) : 1;
      const room = kind === 'products' ? max-draft.products.length : 1;
      if (room <= 0) throw new Error(`最多上传 ${max} 张产品图，请先移除已有素材。`);
      const errors = [];
      for (const file of list.slice(0,room)) {
        try {
          if (tool === 'refinement' && kind === 'products' && !['image/jpeg','image/png'].includes(file.type)) throw new Error('产品精修仅支持 JPG、PNG。');
          const asset = await decodeFile(file);
          await ensureAccount();
          if(draft!==sourceDraft||tool!==sourceTool)throw new Error('页面已切换，本次图片导入已停止。');
          if (kind === 'products') {
            if (draft.products.some((item) => item.image === asset.image)) { errors.push(`${asset.name} 已在当前素材中，已跳过。`); continue; }
            draft.products.push(asset);
          } else { draft[kind] = asset; addMaterialHistory(kind,asset); }
        } catch (error) { errors.push(error.message); }
      }
      if (list.length > room) errors.push(`超出的 ${list.length-room} 张未导入；${kind === 'products' ? `上限 ${max} 张` : '每次应用 1 张参考图'}。`);
      invalidate('素材已更新，请整理方案。'); render();
      if (errors.length) setNotice(errors.join('\n'),'error');
      await persist();
      if (material) renderMaterialHistory();
    } finally { uploadBusy=false;renderStatus();renderProducts();renderMaterialStatus(); }
  }
  function addMaterialHistory(kind,asset) {
    if (!materialHistories[kind]) materialHistories[kind] = [];
    const existing = materialHistories[kind].find((item) => item.image === asset.image && item.source === asset.source);
    if (existing) return existing;
    const stored = clone(asset);materialHistories[kind].unshift(stored);return stored;
  }
  function openPreview(image,title,original) {
    previewReturnFocus = document.activeElement;
    let modal = $('ctPreviewModal');
    if (!modal) { modal = document.createElement('div'); modal.id = 'ctPreviewModal'; modal.className = 'ct-modal ct-preview-modal'; document.body.append(modal); }
    modal.hidden = false;
    modal.innerHTML = `<section class="ct-dialog" role="dialog" aria-modal="true" aria-labelledby="ctPreviewTitle"><header class="ct-dialog-header"><h2 id="ctPreviewTitle">${esc(title || '图片预览')}</h2><button class="btn ghost" type="button" data-action="close-preview">关闭 ×</button></header><div class="ct-preview-panes">${original ? `<figure><figcaption>产品原图</figcaption><img src="${esc(original)}" alt="产品原图"></figure>` : ''}<figure>${original ? '<figcaption>生成结果</figcaption>' : ''}<img src="${esc(image)}" alt="${esc(title || '图片预览')}"></figure></div></section>`;
    modal.querySelector('button').focus();
  }
  function closePreview() { if ($('ctPreviewModal')) $('ctPreviewModal').hidden = true; if (previewReturnFocus && previewReturnFocus.isConnected) previewReturnFocus.focus(); }
  async function downloadSlot(slot,index) {
    const image = itemImage(slot.item); if (!image) throw new Error('没有可下载的原件');
    const label = String(slot.item && (slot.item.variantName || slot.item.businessRoleName) || slot.shot && slot.shot.label || '结果').replace(/\.(?:png|jpe?g|webp)$/i,'');
    const name = `${slot.item.productName || draft.config.name || TOOLS[tool]}-${label}-${index+1}`.replace(/[\\/:*?"<>|]/g,'_');
    if (typeof bridge.download === 'function') return bridge.download(slot.item,`${name}.png`);
    // The archived/data URL is preferred. Download never submits a new generation request.
    let url = image, revoke = false, mime = /^data:([^;,]+)/.exec(image)?.[1] || '';
    if (!/^data:|^blob:/.test(image)) { const response = await fetch(image,{credentials:'omit'}); if (!response.ok) throw new Error(`下载失败 (${response.status})`); const blob=await response.blob();mime=blob.type;url = URL.createObjectURL(blob); revoke = true; }
    const extension=mime==='image/jpeg'?'jpg':mime==='image/webp'?'webp':'png';
    const link = document.createElement('a'); link.href=url; link.download=`${name}.${extension}`; document.body.append(link); link.click(); link.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(url),30000);
  }
  function planElement(attribute,id) { return Array.from(root.querySelectorAll(`[${attribute}]`)).find((item) => item.getAttribute(attribute) === id); }
  async function handleAction(button) {
    const action = button.dataset.action, index = Number(button.dataset.index), kind = button.dataset.kind, id = button.dataset.id;
    if (button.disabled) return;
    const passive = ['close-preview','preview-product','preview-reference','preview-result','material-preview','stop','material-stop'];
    if (isBusy() && !passive.includes(action)) return;
    if (!['close-preview','close-material','preview-product','preview-reference','preview-result','material-preview','open-config'].includes(action)) {
      identityChecks++; renderStatus(); renderMaterialStatus();
      try { await ensureAccount(); } finally { identityChecks--; renderStatus(); renderMaterialStatus(); }
      if (isBusy() && !passive.includes(action)) return;
    }
    if (action === 'switch-tool') {
      if (isBusy()) return;
      navigationBusy=true;renderStatus();
      try { await persist(); await ensureAccount(); notice='';noticeKind='';
        if(uploadBusy||analysisBusy||window.SZ_IMAGE_UPLOAD?.isImporting?.()||controllerActive(controller)||controllerActive(modalGenerationController))throw new Error('当前任务或图片导入正在执行，请稍后再切换。');
        dismissMaterial();
        const url=new URL(location.href);url.searchParams.set('tool',button.dataset.tool);history.replaceState(null,'',url);
        await loadTool(button.dataset.tool);
      } finally { navigationBusy=false;renderStatus();renderResults(); }
    } else if (action === 'switch-mode') { draft.mode=button.dataset.mode;invalidate();render(); }
    else if (action === 'clear-products') { draft.products=[];invalidate();renderProducts(); }
    else if (action === 'remove-product') { draft.products.splice(index,1);invalidate();renderProducts(); }
    else if (action === 'preview-product') { const item=draft.products[index];if(item)openPreview(item.image,item.name); }
    else if (action === 'preview-reference') { const item=draft[kind];if(item)openPreview(item.image,item.name); }
    else if (action === 'remove-reference') { draft[kind]=null;invalidate();render(); }
    else if (action === 'build-plan') { notice='';noticeKind=''; const plan=controller.buildPlan(); if (plan && plan.ok === false) setNotice(plan.error || '方案校验失败','error'); renderPlans();renderStatus();await persist(); }
    else if (action === 'analyze') {
      if (!draft.products.length) throw new Error('请先上传产品图再分析。');
      analysisBusy=true;notice='';renderStatus();
      try { const output=await bridge.analyze(readInput()); if (output && output.ok === false) throw new Error(output.error || '分析失败'); draft.analysisCandidate=typeof output === 'string' ? output : output.text || output.analysis || output.content || (output.data ? JSON.stringify(output.data,null,2) : ''); if (!draft.analysisCandidate) throw new Error('视觉模型未返回可用分析内容。'); setNotice('AI 分析已返回，核对并保存后才用于方案。'); render();await persist(); } finally { analysisBusy=false;renderStatus(); }
    }
    else if (action === 'save-analysis') { const text=$('ctAnalysisCandidate').value.trim();if(!text)throw new Error('请填写需要采用的分析内容。');draft.config.analysis=text;draft.analysisCandidate='';invalidate('分析已保存，请重新整理方案。');render();await persist(); }
    else if (action === 'discard-analysis') { draft.analysisCandidate='';render();await persist(); }
    else if (action === 'clear-analysis') { draft.config.analysis='';invalidate();render(); }
    else if (action === 'edit-plan') { planElement('data-plan-read',id).hidden=true;planElement('data-plan-edit',id).hidden=false;planElement('data-plan-prompt',id).focus(); }
    else if (action === 'cancel-plan') { renderPlans(); }
    else if (action === 'save-plan') { const label=planElement('data-plan-label',id).value.trim(),prompt=planElement('data-plan-prompt',id).value.trim(); if(!label||!prompt)throw new Error('图片名称和方案都不能为空。'); const edited=controller.editShot(id,{label,prompt});if(edited&&edited.ok===false)throw new Error(edited.error);notice='编辑方案已保存，实际生成与历史记录使用这一版本。';noticeKind='';renderPlans();renderStatus();await persist(); }
    else if (action === 'generate') { if(root.querySelector('[data-plan-edit]:not([hidden])'))throw new Error('请先保存或取消正在编辑的方案。'); notice='';noticeKind='';generationStarting++;renderStatus();renderMaterialStatus();try { await persist();const result=await withGenerationLock(tool,()=>controller.generate());if(result&&result.ok===false&&result.error)throw new Error(result.error);renderPlans(); } finally { generationStarting--;renderStatus();renderMaterialStatus(); } }
    else if (action === 'stop') { controller.stop(); }
    else if (action === 'retry-failed') { notice='';noticeKind='';const result=await withGenerationLock(tool,()=>controller.retryFailed());if(result&&result.ok===false&&result.error)throw new Error(result.error); }
    else if (action === 'retry-shot') { notice='';noticeKind='';const result=await withGenerationLock(tool,()=>controller.retryShot(id));if(result&&result.ok===false&&result.error)throw new Error(result.error); }
    else if (action === 'retry-archive') { await controller.retryArchive(resultSlots()[index]); }
    else if (action === 'resolve-uncertain') { if(!$('ctUncertainConfirmed').checked)return;const result=await withGenerationLock(tool,()=>controller.resolveUncertain({confirmed:true}));if(result&&result.ok===false)throw new Error(result.error);$('ctUncertainConfirmed').checked=false;renderStatus();await persist(); }
    else if (action === 'reset') {
      if (isBusy()) throw new Error('请先停止当前队列。');
      if (state().uncertain) throw new Error('上一任务尚未核对，保留现场后才能重新开始。');
      if(resultSlots().some((slot)=>slot.item&&!slot.archiveOk))throw new Error('已有生成原件尚未保存，请先补存成功后再重新开始。');
      const config=clone(draft.config);config.name='';config.requirements='';config.analysis='';
      const mode=draft.mode;draft=defaultDraft(tool);draft.config=config;draft.mode=mode;controller=makeController();notice='已重新开始；生成成果保留在本机历史，上传素材保留在素材库。';noticeKind='';render();await persist();
    }
    else if (action === 'preview-result') { const slot=resultSlots()[index];if(slot&&itemImage(slot.item))openPreview(itemImage(slot.item),slot.item.variantName||slot.item.businessRoleName||slot.shot.label,typeof slot.original === 'string' ? slot.original : slot.original && slot.original.image || draft.products[0] && draft.products[0].image); }
    else if (action === 'download-result') { await downloadSlot(resultSlots()[index],index); }
    else if (action === 'download-all') { const slots=resultSlots();let downloaded=0;for(let i=0;i<slots.length;i++)if(['done','outdated'].includes(slots[i].status)&&itemImage(slots[i].item)){await downloadSlot(slots[i],i);downloaded++;}setNotice(`已发起 ${downloaded} 张原件下载。若浏览器提示，请允许本页下载多个文件。`,'success'); }
    else if (action.startsWith('result-')) { const slot=resultSlots()[index];const result=await bridge.openResultAction(action.slice(7),slot.item);if(result&&result.ok===false)throw new Error(result.error||'无法打开结果工作台。'); }
    else if (action === 'open-config') { bridge.openConfig(); }
    else if (action === 'close-preview') { closePreview(); }
    else if (action === 'material-open') { await openMaterial(kind); }
    else if (action === 'close-material') { await closeMaterial(); }
    else if (action === 'material-tab') { material.tab=button.dataset.tab;renderMaterialHistory(); }
    else if (action === 'material-preview') { const item=materialHistories[material.kind].find((entry)=>entry.id===id);if(item)openPreview(item.image,item.name); }
    else if (action === 'material-choose') { material.selected=id;renderMaterialHistory(); }
    else if (action === 'material-apply-direct' || action === 'material-apply') { const selected=action==='material-apply-direct'?id:material.selected;const item=materialHistories[material.kind].find((entry)=>entry.id===selected);if(!item)throw new Error('请先选中一张素材。');draft[material.kind]=clone(item);invalidate(`已应用${material.kind==='model'?'模特':'场景'}素材。`);await closeMaterial();render();await persist(); }
    else if (action === 'material-generate') { await generateMaterial(); }
    else if (action === 'material-retry-save') { await modalGenerationController.retryArchive(materialResultSlots()[index]); }
    else if (action === 'material-stop') { if(modalGenerationController)modalGenerationController.stop(); }
    else if (action === 'material-resolve') { if(!$('ctMaterialUncertainConfirmed').checked)return;const result=await withGenerationLock(`material:${material.kind}`,()=>modalGenerationController.resolveUncertain({confirmed:true}));if(result&&result.ok===false)throw new Error(result.error);$('ctMaterialUncertainConfirmed').checked=false;renderMaterialStatus(); }
    else if (action === 'venue') { material.config.venue=button.dataset.venue;renderVenueButtons();renderMaterialStatus(); }
    else if (action === 'refresh-venues') { material.venueOffset=(material.venueOffset+4)%VENUES.length;renderVenueButtons(); }
  }
  async function imageAsDataUrl(url) {
    if (/^data:image\//.test(url)) return url;
    const response=await fetch(url);if(!response.ok)throw new Error(`素材原件下载失败 (${response.status})`);
    const blob=await response.blob();if(!blob.type.startsWith('image/'))throw new Error('提供方返回的素材不是图片');
    return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('无法保存素材原件'));reader.readAsDataURL(blob);});
  }
  async function materialArchive(item) {
    const image=await imageAsDataUrl(itemImage(item));
    const asset={id:item.resultId || uid(),name:item.businessRoleName || (material.kind==='model'?'AI 模特素材':'AI 场景素材'),image,source:'generated',createdAt:new Date().toISOString(),prompt:item.prompt || ''};
    const stored=addMaterialHistory(material.kind,asset);
    material.tab='generated';material.selected=stored.id;
    await persist();renderMaterialHistory();return {ok:true,temporaryMaterial:true};
  }
  async function openMaterial(kind) {
    if(isBusy())throw new Error('当前任务执行中，请完成或停止后再操作素材库。');
    navigationBusy=true;renderStatus();
    try {
    await ensureAccount();
    modalReturnFocus=document.activeElement;
    const latestHistory=await dbGet(historyKey()).catch(()=>null);if(latestHistory)materialHistories={model:latestHistory.model||[],scene:latestHistory.scene||[]};
    material={kind,tab:'uploaded',selected:null,venueOffset:0,config:{name:kind==='model'?'模特素材':'场景素材',requirements:'',ratio:'3:4',resolution:'1K',language:'无文字纯视觉',count:1,style:kind==='model'?'日常感':'自然日常',gender:'不限',age:'不限',skin:'不限',body:'不限',venue:VENUES[0]}};
    const previous=await dbGet(`${accountKey}:material-draft:${kind}`).catch(()=>null);
    if(previous&&previous.config)material.config={...material.config,...previous.config};
    modalGenerationController=makeController({readInput:null,journal:journal(`material:${kind}`),archive:materialArchive,onChange(){renderMaterialStatus();scheduleMaterialSave();}});
    if(previous&&previous.snapshot){const restored=modalGenerationController.restore(previous.snapshot);if(restored&&restored.ok===false){material=null;modalGenerationController=null;throw new Error(restored.error||'素材草稿无法安全恢复，原稿仍保留。');}}
    let modal=$('ctMaterialModal');if(!modal){modal=document.createElement('div');modal.id='ctMaterialModal';modal.className='ct-modal';document.body.append(modal);}
    const name=kind==='model'?'模特':'场景',cfg=material.config;
    modal.hidden=false;
    modal.innerHTML=`<section class="ct-dialog" role="dialog" aria-modal="true" aria-labelledby="ctMaterialTitle"><header class="ct-dialog-header"><div><h2 id="ctMaterialTitle">${name}素材库</h2><p class="ct-note">应用已有素材不调用 API；AI 生成使用统一生图模型。</p></div><button class="btn ghost" type="button" data-action="close-material">关闭 ×</button></header><div id="ctMaterialApi" class="ct-model-note ct-material-api"></div><div class="ct-material-layout"><div><fieldset id="ctMaterialFields" style="border:0;padding:0;margin:0;min-width:0"><h3>AI 生成${name}</h3><div class="ct-form">${kind==='model'?[['性别','gender',['不限','女','男']],['年龄','age',['不限','0–6 岁','7–12 岁','13–17 岁','18–25 岁','26–35 岁','36–50 岁','50 岁以上']],['肤色 / 外观','skin',['不限','白人','亚洲人','黑人','拉丁裔']],['体型','body',['不限','苗条','中等','微胖','偏胖']],['风格','style',['日常感','大片感']]].map(([label,key,values])=>`<label>${label}<select data-material-field="${key}">${options(values,cfg[key])}</select></label>`).join(''):`<label class="ct-wide">风格<select data-material-field="style">${options(['自然日常','品牌大片','简约影棚','温暖生活'],cfg.style)}</select></label><div class="ct-wide"><div class="ct-section-title"><span class="ct-note">推荐场地</span><button class="btn ghost" type="button" data-action="refresh-venues">换一组</button></div><div id="ctVenueList" class="ct-venue-list"></div></div>`}<label class="ct-wide">补充要求<textarea data-material-field="requirements" maxlength="3000" placeholder="描述人物外观、拍摄姿态或场景环境">${esc(cfg.requirements)}</textarea></label><label>生成数量<input type="number" data-material-field="count" min="1" max="8" step="1" value="${esc(cfg.count)}"></label><label>画面比例<select data-material-field="ratio">${options(RATIOS,cfg.ratio)}</select></label><label>清晰度<select data-material-field="resolution">${options(['1K','2K','4K'],cfg.resolution)}</select></label></div><p class="ct-note">费用由已配置的 API 提供方计收；默认 1 张 / 1K。</p><button id="ctMaterialGenerate" class="btn primary" type="button" data-action="material-generate">生成${name}素材</button></fieldset><button id="ctMaterialStop" class="btn ghost" type="button" data-action="material-stop" hidden>停止后续生成</button><div id="ctMaterialStatus" class="ct-message" role="status" aria-live="polite" style="margin-top:12px">选择上传素材可直接使用。</div><div id="ctMaterialUncertain" class="ct-uncertain" hidden><p>素材生成的上一任务尚未确认，请先核对提供方任务状态。</p><label class="ct-note"><input id="ctMaterialUncertainConfirmed" type="checkbox">我已核对上一任务</label><button class="btn ghost" type="button" data-action="material-resolve" disabled>解除等待</button></div><div id="ctMaterialSaveFailures"></div></div><div><div class="ct-tabs" role="tablist" aria-label="素材历史来源"><button type="button" data-action="material-tab" data-tab="uploaded" role="tab">上传历史</button><button type="button" data-action="material-tab" data-tab="generated" role="tab">AI 生成历史</button></div><div style="margin-top:12px">${dropzone(kind,`上传${name}图`)}</div><div id="ctMaterialHistory" class="ct-material-history"></div><p id="ctMaterialEmpty" class="ct-note">暂无素材。上传图片，或使用已配置模型生成候选。</p></div></div><footer class="ct-modal-footer"><p class="ct-note">上传与 AI 候选仅存为当前账号素材，未进入正式成果档案。</p><button id="ctMaterialApply" class="btn primary" type="button" data-action="material-apply" disabled>应用选中${name}</button></footer></section>`;
    renderApiSelectors();
    renderVenueButtons();renderMaterialHistory();renderMaterialStatus();modal.querySelector('[data-action="close-material"]').focus();
    } finally { navigationBusy=false;renderStatus();renderMaterialStatus(); }
  }
  function scheduleMaterialSave() {
    if(!material||!modalGenerationController)return;
    const key=`${accountKey}:material-draft:${material.kind}`,value={config:clone(material.config),snapshot:modalGenerationController.snapshot()};
    saveQueue = saveQueue.catch(() => {}).then(() => dbPut(key,value));
    saveQueue.catch((error) => { saveFault = true; showError(error); });
  }
  function renderVenueButtons() {
    if(!$('ctVenueList')||!material)return;
    const list=Array.from({length:4},(_,index)=>VENUES[(material.venueOffset+index)%VENUES.length]);
    $('ctVenueList').innerHTML=list.map((venue)=>`<button type="button" data-action="venue" data-venue="${esc(venue)}" aria-pressed="${material.config.venue===venue}">${esc(venue)}</button>`).join('');
    scheduleMaterialSave();
  }
  function selectedMaterial() { return material && (materialHistories[material.kind]||[]).find((item)=>item.id===material.selected&&item.source===material.tab); }
  function renderMaterialHistory() {
    if(!material||!$('ctMaterialHistory'))return;
    const uploadCount=$('ctMaterialModal').querySelector('[data-cu-count]');
    if(uploadCount)uploadCount.textContent=`${Number(Boolean(draft[material.kind]))}/1`;
    const items=(materialHistories[material.kind]||[]).filter((item)=>item.source===material.tab);
    $('ctMaterialHistory').innerHTML=items.map((item)=>`<article class="ct-material-card${material.selected===item.id?' selected':''}"><img src="${esc(item.image)}" alt="${esc(item.name)}" tabindex="0" data-action="material-preview" data-id="${esc(item.id)}"><span title="${esc(item.name)}">${esc(item.name)}</span><button class="btn ghost" type="button" data-action="${material.tab==='uploaded'?'material-apply-direct':'material-choose'}" data-id="${esc(item.id)}">${material.tab==='uploaded'?'直接应用此素材':material.selected===item.id?'已选中':'选择此素材'}</button></article>`).join('');
    $('ctMaterialEmpty').hidden=Boolean(items.length);
    $('ctMaterialApply').disabled=!selectedMaterial()||isBusy();
    $('ctMaterialHistory').querySelectorAll('[data-action="material-apply-direct"]').forEach(button=>{button.disabled=isBusy();});
    $('ctMaterialModal').querySelectorAll('[data-action="material-tab"]').forEach((button)=>{const count=(materialHistories[material.kind]||[]).filter((item)=>item.source===button.dataset.tab).length;button.setAttribute('aria-selected',String(button.dataset.tab===material.tab));button.textContent=`${button.dataset.tab==='uploaded'?'上传历史':'AI 生成历史'} · ${count}`;});
  }
  function materialResultSlots() { if(!modalGenerationController)return [];const current=modalGenerationController.state;return (current.slots||[]).concat((current.previousResults||[]).filter((slot)=>slot.item)); }
  function renderMaterialStatus() {
    if(!material||!$('ctMaterialStatus')||!modalGenerationController)return;
    const current=modalGenerationController.state;
    $('ctMaterialStatus').textContent=current.message||'选择上传素材可直接使用。';
    $('ctMaterialStatus').className=`ct-message${current.kind==='error'?' error':''}`;
    $('ctMaterialFields').disabled=isBusy();
    $('ctMaterialModal').querySelectorAll('[data-upload]').forEach(input=>{input.disabled=isBusy();});
    updateApiControls();
    $('ctMaterialGenerate').disabled=isBusy()||Boolean(current.uncertain)||!modelReady;
    $('ctMaterialStop').hidden=!current.busy;
    $('ctMaterialUncertain').hidden=!current.uncertain;
    $('ctMaterialModal').querySelector('[data-action="material-resolve"]').disabled=current.busy||!$('ctMaterialUncertainConfirmed').checked;
    const pendingPlan=contract.createMaterialPlan({kind:material.kind,config:clone(material.config)});
    const samePlan=pendingPlan.ok&&current.plan&&pendingPlan.sourceSignature===current.plan.sourceSignature;
    const ready=(current.slots||[]).filter((slot)=>['ready','queued'].includes(slot.status)).length;
    const failed=(current.slots||[]).filter((slot)=>slot.status==='failed').length;
    $('ctMaterialGenerate').textContent=current.busy?'生成素材中…':samePlan&&failed?`重试失败素材 · ${failed} 张`:samePlan&&ready?`继续生成素材 · ${ready} 张`:samePlan&&(current.slots||[]).some((slot)=>slot.item)?`再生成 ${pendingPlan.shots.length} 张素材`:`生成${material.kind==='model'?'模特':'场景'}素材`;
    $('ctMaterialApply').disabled=!selectedMaterial()||isBusy();
    $('ctMaterialHistory').querySelectorAll('[data-action="material-apply-direct"]').forEach(button=>{button.disabled=isBusy();});
    $('ctMaterialSaveFailures').innerHTML=materialResultSlots().map((slot,index)=>slot.item&&!slot.archiveOk?`<div class="ct-uncertain"><p>${esc(slot.archiveError||'素材原件仍待保存')}</p><button class="btn ghost" type="button" data-action="material-retry-save" data-index="${index}"${current.busy?' disabled':''}>保存已有素材原件</button></div>`:'').join('');
    renderStatus();
  }
  async function generateMaterial() {
    if(!material||!modalGenerationController||modalGenerationController.state.busy)return;
    if(isBusy())throw new Error('图片导入或其他任务正在执行，请稍后再生成素材。');
    generationStarting++;renderStatus();renderMaterialStatus();
    try {
    await ensureAccount();
    if(materialResultSlots().some((slot)=>slot.item&&!slot.archiveOk))throw new Error('已有素材原件尚未保存，请先保存已有素材后再生成新候选。');
    const plan=contract.createMaterialPlan({kind:material.kind,config:clone(material.config)});
    if(!plan.ok)throw new Error(plan.error);
    const result=await withGenerationLock(`material:${material.kind}`,async()=>{
      const current=modalGenerationController.state;
      if(current.uncertain)throw new Error('请先核对上一次素材任务，再解除等待。');
      const samePlan=current.plan&&current.plan.sourceSignature===plan.sourceSignature;
      if(samePlan&&current.slots.some((slot)=>slot.status==='failed'))return modalGenerationController.retryFailed();
      if(samePlan&&current.slots.some((slot)=>['ready','queued'].includes(slot.status)))return modalGenerationController.generate();
      // The button explicitly says “再生成” after a completed batch. Preserve old candidates in history.
      if(samePlan)modalGenerationController.invalidate();
      const set=modalGenerationController.setPlan(plan);if(set&&set.ok===false)throw new Error(set.error);
      scheduleMaterialSave();
      return modalGenerationController.generate();
    });
    if(result&&result.ok===false&&result.error)throw new Error(result.error);
    renderMaterialHistory();
    } finally { generationStarting--;renderStatus();renderMaterialStatus(); }
  }
  function dismissMaterial() {
    if($('ctMaterialModal'))$('ctMaterialModal').hidden=true;
    material=null;modalGenerationController=null;
    if(modalReturnFocus&&modalReturnFocus.isConnected)modalReturnFocus.focus();
  }
  async function closeMaterial() {
    if(!material)return;
    if(isBusy()){if($('ctMaterialStatus'))$('ctMaterialStatus').textContent='素材任务仍在执行，请等待返回或停止后续生成。';return;}
    navigationBusy=true;renderStatus();renderMaterialStatus();
    try {
      const savedState=JSON.stringify({draft,controller:controller.snapshot(),material,materialController:modalGenerationController.snapshot()});
      await ensureAccount();await persist();await ensureAccount();
      if(uploadBusy||analysisBusy||pendingSendRequests||window.SZ_IMAGE_UPLOAD?.isImporting?.()||controllerActive(controller)||controllerActive(modalGenerationController))throw new Error('当前任务或图片导入正在执行，请稍后再关闭素材库。');
      if(JSON.stringify({draft,controller:controller.snapshot(),material,materialController:modalGenerationController.snapshot()})!==savedState)throw new Error('素材草稿在保存期间发生变化，请稍后再关闭素材库。');
      dismissMaterial();
    } catch(error) { saveFault=true;throw error; }
    finally { navigationBusy=false;renderStatus();renderMaterialStatus(); }
  }
  function handleInput(event) {
    const input=event.target;
    if(input.id==='ctUncertainConfirmed'){const button=root.querySelector('[data-action="resolve-uncertain"]');if(button)button.disabled=!input.checked;return;}
    if(input.id==='ctMaterialUncertainConfirmed'){const button=$('ctMaterialModal').querySelector('[data-action="material-resolve"]');if(button)button.disabled=!input.checked;return;}
    if(isBusy())return;
    if(input.dataset.materialField&&material){material.config[input.dataset.materialField]=input.type==='number'?Number(input.value):input.value;scheduleMaterialSave();renderMaterialStatus();return;}
    if(!input.dataset.field)return;
    const value=input.type==='checkbox'?input.checked:input.type==='number'?Number(input.value):input.value;
    updateField(input.dataset.field,value);
    if(input.dataset.field.startsWith('basic.')&&input.dataset.field.endsWith('.enabled')) { const box=input.closest('.ct-type').querySelector('.ct-type-options');if(box)box.hidden=!input.checked; }
  }
  function bindEvents() {
    document.addEventListener('cu-import-state',(event)=>{
      if(!root||!draft||!controller)return;
      const detail=event.detail||{};
      if(detail.pending&&detail.scope==='creative'&&['products','model','scene'].includes(detail.inputKey))invalidate('正在导入图片 URL，素材更新后请重新整理方案。');
      renderStatus();renderMaterialStatus();
    });
    window.addEventListener('sz-bound-api-changed', () => { if (!isBusy()) refreshModelInfo().catch(showError); });
    document.addEventListener('click',(event)=>{if(event.target.closest('#openArchiveBtn')){event.preventDefault();event.stopImmediatePropagation();Promise.resolve(bridge.openHistory()).catch(showError);}},true);
    document.addEventListener('click',(event)=>{
      const button=event.target.closest('[data-action]');
      if(button&&(root.contains(button)||button.closest('#ctMaterialModal,#ctPreviewModal'))) {
        handleAction(button).catch((error)=>{if(material&&$('ctMaterialStatus')){$('ctMaterialStatus').textContent=error.message||String(error);$('ctMaterialStatus').className='ct-message error';}else showError(error);});
      }
      if(event.target===$('ctPreviewModal'))closePreview();
      if(event.target===$('ctMaterialModal'))closeMaterial().catch(showError);
    });
    document.addEventListener('input',handleInput);
    document.addEventListener('change',(event)=>{
      const input=event.target;
      if(input.hasAttribute('data-bound-image-api')){switchBoundApi(input.value).catch(showError);return;}
      if(input.dataset.upload){addFiles(Array.from(input.files || []),input.dataset.upload).catch(showError);input.value='';}
      else if(input.type==='checkbox'||input.tagName==='SELECT')handleInput(event);
    });
    document.addEventListener('focusin',(event)=>{const zone=event.target.closest('[data-drop]');if(zone)selectedPasteTarget=zone.dataset.drop;});
    document.addEventListener('dragover',(event)=>{const zone=event.target.closest('[data-drop]');if(zone){event.preventDefault();zone.classList.add('drag-over');}});
    document.addEventListener('dragleave',(event)=>{const zone=event.target.closest('[data-drop]');if(zone&&!zone.contains(event.relatedTarget))zone.classList.remove('drag-over');});
    document.addEventListener('drop',(event)=>{const zone=event.target.closest('[data-drop]');if(zone){event.preventDefault();zone.classList.remove('drag-over');const files=Array.from(event.dataTransfer.files||[]);if(files.length)addFiles(files,zone.dataset.drop).catch(showError);}});
    document.addEventListener('paste',(event)=>{
      if(event.defaultPrevented)return;
      const files=Array.from(event.clipboardData&&event.clipboardData.items||[]).filter((item)=>item.kind==='file'&&item.type.startsWith('image/')).map((item)=>item.getAsFile()).filter(Boolean);
      if(!files.length)return;
      const zone=event.target.closest('[data-drop]');
      if(!zone&&/TEXTAREA|INPUT/.test(event.target.tagName))return;
      if($('ctPreviewModal')&&!$('ctPreviewModal').hidden)return;
      event.preventDefault();addFiles(files,zone?zone.dataset.drop:material?material.kind:selectedPasteTarget).catch(showError);
    });
    document.addEventListener('keydown',(event)=>{
      if(event.key==='Escape') { if($('ctPreviewModal')&&!$('ctPreviewModal').hidden){event.preventDefault();closePreview();}else if($('ctMaterialModal')&&!$('ctMaterialModal').hidden){event.preventDefault();closeMaterial().catch(showError);} }
      if((event.key==='Enter'||event.key===' ')&&event.target.matches('img[data-action]')){event.preventDefault();handleAction(event.target).catch(showError);}
      if(event.key==='Tab') {
        const modal=[$('ctPreviewModal'),$('ctMaterialModal')].find((entry)=>entry&&!entry.hidden);if(!modal)return;
        const focusable=Array.from(modal.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')).filter((entry)=>entry.getClientRects().length);
        const first=focusable[0],last=focusable[focusable.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
      }
    });
    window.addEventListener('beforeunload',(event)=>{if(isBusy()||saveFault){event.preventDefault();event.returnValue='当前任务仍在处理或草稿尚未保存，请稍后再离开。';}if(!startupFailed)persist().catch(()=>{});});
    document.addEventListener('visibilitychange',()=>{if(startupFailed)return;if(document.visibilityState==='hidden')persist().catch(()=>{});else if(!isBusy())Promise.resolve(typeof bridge.refresh==='function'?bridge.refresh():null).then(ensureAccount).then(refreshModelInfo).catch((error)=>{modelReady=false;showError(error);renderResults();});});
  }
  async function boot() {
    document.body.classList.add('creative-tools-mode');
    root=$('creativeToolsRoot');if(!root){root=document.createElement('div');root.id='creativeToolsRoot';const hero=document.querySelector('.app > .hero');hero.insertAdjacentElement('afterend',root);}root.hidden=false;
    root.innerHTML='<section class="panel"><p class="ct-message" role="status">正在读取当前账号与统一 API 配置…</p></section>';
    for(let count=0;count<60&&!window.SZ_CREATIVE_TOOLS_BRIDGE;count++)await new Promise((resolve)=>setTimeout(resolve,100));
    bridge=window.SZ_CREATIVE_TOOLS_BRIDGE;contract=window.SZ_CREATIVE_TOOLS_CONTRACT;
    if(!bridge||!contract)throw new Error('创作模块未完整加载，请重新打开工作台页面。');
    let ready;
    if(typeof bridge.ready==='function'){ready=await bridge.ready();if(ready&&ready.ok===false)throw new Error(ready.error||'统一 API 尚未准备好，请先完成账号登录与配置。');}
    if(typeof bridge.getAccountKey!=='function')throw new Error('无法确认当前账号，已停止读取素材草稿。');
    // This fresh startup reply belongs only to this document's boot chain. Keep
    // every later action's ensureAccount() check; no identity TTL is introduced.
    if(ready!=null&&(typeof ready!=='object'||Array.isArray(ready)||ready.ok!==true))throw new Error('当前账号配置回执无效，已停止读取素材草稿。');
    const startupSnapshot=ready&&(Object.hasOwn(ready,'accountKey')||Object.hasOwn(ready,'boundApis'));
    if(startupSnapshot){
      if(ready.ok!==true||typeof ready.accountKey!=='string'||!ready.accountKey.trim()||ready.accountKey.trim()==='local'||!ready.boundApis||typeof ready.boundApis!=='object'||Array.isArray(ready.boundApis)||ready.boundApis.ok!==true||ready.boundApis.accountKey!==ready.accountKey)throw new Error('当前账号配置回执不一致，已停止读取素材草稿。');
      accountKey=ready.accountKey;
    }else{
      accountKey=await activeAccount();if(!accountKey)throw new Error('请先登录账号，再打开创作工具。');
    }
    const history=await dbGet(historyKey()).catch(()=>null);if(history)materialHistories={model:Array.isArray(history.model)?history.model:[],scene:Array.isArray(history.scene)?history.scene:[]};
    bindEvents();await loadTool(params.get('tool')||'clothing',{configSnapshot:ready});
    initializing=false;renderStatus();renderMaterialStatus();
    if(window.SZ_LAB_STARTUP)window.SZ_LAB_STARTUP.ready();
  }
  const start=()=>boot().catch((error)=>{startupFailed=true;if(window.SZ_LAB_STARTUP)window.SZ_LAB_STARTUP.fail(error.message||String(error));else if(root)root.innerHTML=`<section class="panel"><h2>创作工具暂未就绪</h2><p class="ct-message error" role="alert">${esc(error.message||error)}</p><p class="ct-note">请检查当前登录状态和统一 API 设置，然后重新打开此页面。</p></section>`;});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
