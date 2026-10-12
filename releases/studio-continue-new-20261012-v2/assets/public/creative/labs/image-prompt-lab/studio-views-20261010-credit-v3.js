
;
/* Frozen source: public/creative/labs/image-prompt-lab/creative-tools-ui.js */
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
    renderCreditHints();
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
    renderCreditHints();
  }
  function renderCreditHints() {
    const hints=window.SZCreativeCreditHints;if(!hints||!root||!draft||!bridge)return;
    const config=bridgeConfig()||{}, model=config.imageModel||config.model||'', current=state();
    const pending=current.plan?(current.slots||[]).filter(slot=>!slot.item&&['ready','queued'].includes(slot.status)).map(()=>1):null;
    const failed=(current.slots||[]).filter(slot=>!slot.item&&slot.status==='failed').map(()=>1);
    root.querySelectorAll('[data-action="generate"]').forEach(button=>hints.image(button,model,pending,pending?`本次 ${pending.length} 张待生成图片；已完成原件保留`:'整理并保存方案后确认本次生成张数'));
    root.querySelectorAll('[data-action="retry-failed"]').forEach(button=>hints.image(button,model,failed,`本次 ${failed.length} 张失败项重试；已有成功图片保留`));
    root.querySelectorAll('[data-action="retry-shot"]').forEach(button=>hints.image(button,model,[1],'本次只重新生成此图 1 张；原结果保留'));
    root.querySelectorAll('[data-action="analyze"]').forEach(button=>hints.chat(button,config.visionModel||config.textModel||'','本次 1 项商品素材分析；核对采用与整理方案为本地操作'));
    if(material&&modalGenerationController&&$('ctMaterialGenerate')){
      const next=contract.createMaterialPlan({kind:material.kind,config:clone(material.config)}), run=modalGenerationController.state;
      const same=next.ok&&run.plan&&next.sourceSignature===run.plan.sourceSignature;
      const failures=(run.slots||[]).filter(slot=>!slot.item&&slot.status==='failed'), ready=(run.slots||[]).filter(slot=>!slot.item&&['ready','queued'].includes(slot.status));
      const count=same&&failures.length?failures.length:same&&ready.length?ready.length:next.ok?next.shots.length:null;
      hints.image($('ctMaterialGenerate'),model,count===null?null:Array(count).fill(1),count===null?'确认素材生成参数后报价':`本次 ${count} 张${material.kind==='model'?'模特':'场景'}候选；应用已有素材为本地操作`);
    }
  }
  window.SZCreativeCreditHints?.register('creative-tools',renderCreditHints);
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
  function dismissMaterial() {
    if($('ctMaterialModal'))$('ctMaterialModal').hidden=true;
    material=null;modalGenerationController=null;
    if(modalReturnFocus&&modalReturnFocus.isConnected)modalReturnFocus.focus();
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
  const start=()=>boot().catch((error)=>{startupFailed=true;initializing=false;if(window.SZ_LAB_STARTUP)window.SZ_LAB_STARTUP.fail(error.message||String(error));else if(root)root.innerHTML=`<section class="panel"><h2>创作工具暂未就绪</h2><p class="ct-message error" role="alert">${esc(error.message||error)}</p><p class="ct-note">请检查当前登录状态和统一 API 设置，然后重新打开此页面。</p></section>`;});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();

;
/* Frozen source: public/creative/labs/image-prompt-lab/studio-genesis-ui.js */
/* Product-first workspace. All model requests continue through the account-scoped website bridge. */
(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  if (params.get('studio') !== '1') return;
  const isBatch = params.get('batch') === '1';
  const mode = params.get('mode') === 'detail' ? 'detail' : 'main';
  const initialAd = params.get('type') === 'ad';
  const icons = {
    spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/><path d="m20 2 .8 2.2L23 5l-2.2.8L20 8l-.8-2.2L17 5l2.2-.8Z"/>',
    image:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m4 18 5-5 4 3 4-6 4 5"/>',
    upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
    history:'<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v5l3 2"/>',
    plus:'<path d="M12 5v14M5 12h14"/>', settings:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.spark}</svg>`;
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const uid = () => crypto.randomUUID();
  let root, bridge, engine, controller, draft, workspaceBinding, account, database, apiChoices = [], modelInfo = {}, notice = '', noticeError = false;
  let busy = false, analyzing = false, uploading = false, saveTimer, saveQueue = Promise.resolve(), saveFault = false, restoring = false, initializing = true;
  const draftStorageTimeoutMs = 15 * 1000;
  let saveError = '';
  let startupFailed = false, receiptRecovery = null, bound = false;
  let deactivating = false, deactivationPromise = null;
  let moduleTab = 'official', moduleGroup = '', managingModules = false, selectedResults = new Set(), showPlan = true, briefCandidate = '';
  const displayedPlanChecks = new WeakMap();
  const localOriginals = new Map(), displayFrame = window.frameElement;
  let displayRenderVersion = 0;
  const environment = window.__SANJIE_ENVIRONMENT ? `:${window.__SANJIE_ENVIRONMENT}` : '';
  const task = index => ({ id:uid(), name:`商品任务 ${index}`, requirements:'', products:[], overrides:null, plan:null, confirmed:false, collapsed:false });
  function current() { return controller ? controller.state : { tasks:[],previousResults:[],busy:false,uncertain:null }; }
  function workspaceBusy() {
    const state=current();
    const archiving=(state.tasks||[]).some(entry=>(entry.slots||[]).some(slot=>slot?.archiveSaving))||(state.previousResults||[]).some(slot=>slot?.archiveSaving);
    return (initializing||restoring)&&!startupFailed || busy || analyzing || uploading || !!receiptRecovery || window.SZ_IMAGE_UPLOAD?.isImporting?.() || state.busy || archiving;
  }
  function generationLocked() { return workspaceBusy() || deactivating; }
  function navigationLocked() { return workspaceBusy() || !!current().awaitingReceipt || !!controller?.hasInFlightRequest?.(); }
  function locked() { return navigationLocked() || deactivating; }
  window.SanjieStudioGenesisBridge = {
    async canDeactivate() {
      if(deactivationPromise)return deactivationPromise;
      const activeReason='当前创作任务正在处理，请等待完成或停止后续生成，再切换入口。';
      if(navigationLocked())return {allowed:false,reason:activeReason};
      // Failed startup never exposes editing. Keep its original stored draft
      // intact instead of persisting a partly restored workspace on the way out.
      if(startupFailed)return {allowed:true};
      if(!draft||!controller||!bridge)return {allowed:false,reason:'创作工作台尚未就绪，请稍后再切换入口。'};
      // A pending receipt protects only its original image. An idle workspace can
      // be left once the full draft and receipts reach account-scoped storage.
      // Freeze new mutations while saving; check activity and ownership again
      // after the asynchronous write before the host removes this iframe.
      deactivating=true;if(!startupFailed)render();
      deactivationPromise=(async()=>{
        try {
          const snapshot=controller.snapshot();
          if(snapshot.accountKey&&String(snapshot.accountKey)!==account)throw new Error('任务所属账号与草稿不一致，已停止保存。');
          const savedState=JSON.stringify({draft,snapshot});
          await persist();await ensureAccount();
          if(navigationLocked())return {allowed:false,reason:activeReason};
          if(JSON.stringify({draft,snapshot:controller.snapshot()})!==savedState){saveFault=true;return {allowed:false,reason:'草稿在保存期间发生变化，请稍后再切换入口。'};}
          return {allowed:true};
        } catch(error) {
          saveFault=true;showError(error);return {allowed:false,reason:error.message||'当前草稿保存失败，请先检查浏览器存储空间。'};
        } finally { deactivating=false;deactivationPromise=null;if(!startupFailed)render(); }
      })();
      return deactivationPromise;
    }
  };
  async function ensureAccount() {
    const identity = await bridge.getAccountKey();
    if (String(identity) !== account) throw new Error('登录账号已变化，请重新打开工作台；原账号素材仍保留。');
  }
  async function openDB() {
    if (database) return database;
    database = await new Promise((resolve,reject) => {
      const request = indexedDB.open(`sz_studio_genesis_v1${environment}`,1);
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        try { request.transaction?.abort(); } catch (_) {}
        reject(new Error('本机草稿库打开超时，请稍后重试。'));
      },draftStorageTimeoutMs);
      request.onupgradeneeded = () => { if(expired){try { request.transaction?.abort(); } catch (_) {} return;}request.result.createObjectStore('drafts'); };
      request.onsuccess = () => {
        if(expired){try { request.result.close(); } catch (_) {} return;}
        clearTimeout(timer);resolve(request.result);
      };
      request.onerror = () => { clearTimeout(timer);if(!expired)reject(request.error || new Error('无法打开本机草稿库。')); };
    });
    return database;
  }
  async function draftTransaction(mode,operation) {
    const db = await openDB();
    return new Promise((resolve,reject) => {
      let transaction, settled = false;
      const finish = (error,value) => { if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value); };
      const timer = setTimeout(() => {
        if(settled)return;
        settled=true;
        // Abort before releasing the save queue so a timed out write cannot
        // commit an older snapshot after a later successful save.
        try { transaction?.abort(); } catch (_) {}
        if(database===db)database=null;
        try { db.close(); } catch (_) {}
        reject(new Error(`本机草稿${mode==='readwrite'?'保存':'读取'}超时，请稍后重试。`));
      },draftStorageTimeoutMs);
      try {
        transaction=mode==='readwrite'?db.transaction('drafts',mode):db.transaction('drafts');
        transaction.onerror=()=>finish(transaction.error || new Error('本机草稿事务失败。'));
        transaction.onabort=()=>finish(transaction.error || new Error('本机草稿事务已取消。'));
        if(mode==='readwrite')transaction.oncomplete=()=>finish();
        operation(transaction.objectStore('drafts'),finish,transaction);
      } catch(error) { finish(error); }
    });
  }
  async function dbGet(key) {
    return draftTransaction('readonly',(store,finish)=>{const request=store.get(key);request.onsuccess=()=>finish(null,request.result);request.onerror=()=>finish(request.error || new Error('本机草稿读取失败。'));});
  }
  function draftToken(value) {
    if(value==null)return 'missing';
    if(typeof value.revision==='string'&&value.revision)return `revision:${value.revision}`;
    // Legacy drafts have no revision. Compare their entire stable JSON so two
    // tabs that loaded the same old record cannot both replace it unnoticed.
    return `legacy:${JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.keys(item).sort().reduce((sorted,key)=>(sorted[key]=item[key],sorted),{}):item)}`;
  }
  async function dbPut(key,value,expectedToken='missing') {
    const saved={...value,revision:uid()};
    await draftTransaction('readwrite',(store,finish,transaction)=>{
      const request=store.get(key);
      request.onerror=()=>finish(request.error || new Error('本机草稿读取失败。'));
      request.onsuccess=()=>{
        try {
          if(draftToken(request.result)!==expectedToken)throw Object.assign(new Error('其他页面已更新这份草稿，当前页面已停止保存和生成。请保留当前页面并重新打开工作台读取最新任务；原任务回执仍保留。'),{code:'STUDIO_DRAFT_CONFLICT'});
          store.put(saved,key);
        } catch(error) {finish(error);try{transaction.abort();}catch(_){}}
      };
    });
    // Only advance the expected revision after the transaction commits.
    return draftToken(saved);
  }
  async function installRecoveredDraft(key,recoveryKey,original,next) {
    let installed;
    await draftTransaction('readwrite',(store,finish)=>{
      const request=store.get(recoveryKey);
      request.onerror=()=>finish(request.error||new Error('恢复草稿读取失败，请重试。'));
      request.onsuccess=()=>{
        if(request.result){installed=request.result;return;}
        const source=store.get(key);
        source.onerror=()=>finish(source.error||new Error('原草稿读取失败，请重试。'));
        source.onsuccess=()=>{
          if(JSON.stringify(source.result)!==JSON.stringify(original)){finish(new Error('原草稿已在其他页面更新，请重试读取。'));return;}
          installed={...next,revision:uid()};store.put(installed,recoveryKey);
        };
      };
    });
    return installed;
  }
  const scopeFor = type => `${isBatch?'batch':'single'}:${type==='detail'?'detail':'main'}${type==='ad'?':ad':''}`;
  let workspaceScope = scopeFor(initialAd?'ad':mode);
  const draftKey = (scope=workspaceScope) => `${account}:${scope}`;
  const workspaceType = settings => settings.imageType==='ad'?'ad':settings.mode==='detail'?'detail':'main';
  function journal(scope=workspaceScope) {
    const legacyKey = `sz_studio_genesis_pending_v1${environment}:${account}`;
    const prefix = `sz_studio_genesis_pending_v2${environment}:${account}:${scope}:`;
    function validate(raw) {
      let value;
      try { value=JSON.parse(raw); } catch (_) { throw new Error('本机任务回执无法读取，请核对已有请求。'); }
      if(!value||typeof value.taskId!=='string'||!value.taskId.trim()||typeof value.shotId!=='string'||!value.shotId.trim()||value.accountKey!==account||value.createdAt!==undefined&&(!Number.isFinite(value.createdAt)||value.createdAt<=0)||value.jobId!==undefined&&(typeof value.jobId!=='string'||!value.jobId.trim()))throw new Error('本机任务回执内容损坏或所属账号不一致，请核对已有请求。');
      return value;
    }
    function read(excluded=[]) {
      try {
      const legacy=localStorage.getItem(legacyKey);
      if(legacy!==null)return validate(legacy);
      for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key?.startsWith(prefix)&&!excluded.includes(key.slice(prefix.length)))return validate(localStorage.getItem(key));}
      return null;
      } catch(error) { if(/回执/.test(error.message))throw error;throw new Error('本机任务回执无法读取，请保留草稿并核对已有请求。'); }
    }
    function readAll() {
      try {
        const values=[], legacy=localStorage.getItem(legacyKey);
        if(legacy!==null)values.push(validate(legacy));
        for(let i=0;i<localStorage.length;i++){
          const key=localStorage.key(i);
          if(key?.startsWith(prefix))values.push(validate(localStorage.getItem(key)));
        }
        return values.filter((value,index)=>!values.slice(0,index).some(known=>['jobId','accountKey','taskId','shotId','batchId'].every(field=>known[field]===value[field])));
      } catch(error) { if(/回执/.test(error.message))throw error;throw new Error('本机任务回执无法读取，请保留草稿并重新打开工作台。'); }
    }
    function compareAndClear(receipt) {
      const ownedKey=prefix+receipt.jobId, key=localStorage.getItem(ownedKey)!==null?ownedKey:legacyKey;
      const raw=localStorage.getItem(key);if(raw===null)return false;
      const saved=validate(raw);
      if(!['jobId','accountKey','taskId','shotId','batchId'].every(field=>saved[field]===receipt[field]))return false;
      localStorage.removeItem(key);return true;
    }
    return {concurrent:true,read,readAll,readExcluding:read,readReceipt:receipt=>{const raw=localStorage.getItem(prefix+receipt.jobId)??localStorage.getItem(legacyKey);return raw===null?null:validate(raw);},write:value=>localStorage.setItem(prefix+value.jobId,JSON.stringify(value)),compareAndClear,clear:()=>{const pending=read();if(pending)compareAndClear(pending);}};
  }
  function createWorkspace(nextDraft,scope,storageKey=draftKey(scope),legacy=null,expectedDraftToken='missing') {
    const binding={draft:nextDraft,scope,storageKey,legacy,legacyBackupKey:nextDraft.legacyBackupKey,controller:null,restoring:true,expectedDraftToken};
    binding.controller=engine.createController({bridge,journal:journal(scope),concurrency:100,workspaceKey:scope,withGenerationSlot,async onChange(){
      if(binding.restoring)return;
      if(workspaceBinding===binding)render();
      await persist({fromController:true,source:binding});
    }});
    return binding;
  }
  function installWorkspace(binding) {
    if(workspaceBinding!==binding)releaseLocalOriginals();
    workspaceBinding=binding;workspaceScope=binding.scope;draft=binding.draft;controller=binding.controller;
  }
  function validateWorkspace(saved,type) {
    if(saved.snapshot?.accountKey&&saved.snapshot.accountKey!==account)throw new Error('该图片类型的草稿属于其他账号，原草稿仍保留。');
    if(!saved?.draft||!Array.isArray(saved.draft.tasks)||workspaceType(saved.draft.settings||{})!==type)throw new Error('该图片类型的草稿内容不一致，原草稿仍保留，请先核对本机任务。');
    if(saved.snapshot?.tasks?.some(entry=>workspaceType(entry.plan?.settings||{})!==type))throw new Error('该图片类型的旧任务含有其他图片类型，原任务和回执仍保留，请先核对。');
  }
  const typeLabel = type => ({main:'主图',detail:'详情图',ad:'广告图'})[type];
  async function loadWorkspace(type,scope) {
    const key=draftKey(scope),recoveryKey=`${key}:type-recovery-v1`;
    const recovered=await dbGet(recoveryKey);await ensureAccount();
    if(recovered){
      validateWorkspace(recovered,type);
      const backupKey=recovered.draft.legacyBackupKey;
      if(typeof backupKey!=='string'||!backupKey.startsWith(`${key}:before-explicit-mode:`))throw new Error('保留的旧任务位置暂不能核对，请重试读取。');
      const legacy=await dbGet(backupKey);await ensureAccount();
      if(!legacy?.draft||legacy.snapshot?.accountKey&&legacy.snapshot.accountKey!==account)throw new Error('保留的旧任务暂不能读取，请重试；原数据仍保留。');
      return {saved:recovered,storageKey:recoveryKey,legacy};
    }
    const saved=await dbGet(key);await ensureAccount();
    if(!saved)return {saved:null,storageKey:key,legacy:null};
    if(!saved.draft||!Array.isArray(saved.draft.tasks)||saved.snapshot?.accountKey&&saved.snapshot.accountKey!==account){validateWorkspace(saved,type);}
    const mixed=workspaceType(saved.draft.settings||{})!==type||saved.snapshot?.tasks?.some(entry=>workspaceType(entry.plan?.settings||{})!==type);
    if(!mixed){validateWorkspace(saved,type);return {saved,storageKey:key,legacy:null};}
    // Old versions saved all three types under the entry URL's fixed key.
    // Keep the complete record and its original receipt scope. Fresh task IDs
    // ensure that editable inputs cannot retry or impersonate an old request.
    const backupKey=`${key}:before-explicit-mode:${uid()}`;
    await dbPut(backupKey,saved);await ensureAccount();
    const defaults=engine.defaults(type==='detail'?'detail':'main');
    const oldSettings=workspaceType(saved.draft.settings||{})===type?saved.draft.settings:saved.draft.typeSettings?.[type];
    const config=oldSettings&&workspaceType(oldSettings)===type?clone(oldSettings):{...defaults,model:saved.draft.settings?.model||''};
    config.mode=type==='detail'?'detail':'main';config.imageType=type==='ad'?'ad':'main';
    if(type==='ad'){config.adTemplate=config.adTemplate||engine.adTemplates?.[0]?.id;config.adType=config.adType||'电商广告';}
    const tasks=saved.draft.tasks.map((entry,index)=>{
      const old=workspaceType(saved.draft.settings||{})===type?entry:entry.typeDrafts?.[type];
      const overrides=old?.overrides?{...clone(old.overrides),mode:config.mode,imageType:config.imageType}:null;
      return {...task(index+1),name:entry.name||`商品任务 ${index+1}`,products:clone(entry.products||[]),requirements:old?.requirements||'',analysis:old?.analysis||'',overrides};
    });
    const next={draft:{settings:config,tasks:tasks.length?tasks:[task(1)],legacyBackupKey:backupKey,viewStep:0,userModules:clone(saved.draft.userModules||[]),userModuleGroups:clone(saved.draft.userModuleGroups||[])},savedAt:new Date().toISOString()};
    // Saving the separate recovery row makes reload/switching deterministic;
    // neither the original canonical record nor its receipt journal is changed.
    const installed=await installRecoveredDraft(key,recoveryKey,saved,next);await ensureAccount();
    validateWorkspace(installed,type);
    if(typeof installed.draft.legacyBackupKey!=='string'||!installed.draft.legacyBackupKey.startsWith(`${key}:before-explicit-mode:`))throw new Error('保留的旧任务位置暂不能核对，请重试读取。');
    const retained=installed.draft.legacyBackupKey===backupKey?saved:await dbGet(installed.draft.legacyBackupKey);await ensureAccount();
    if(!retained?.draft||retained.snapshot?.accountKey&&retained.snapshot.accountKey!==account)throw new Error('保留的旧任务暂不能核对，请重试读取。');
    return {saved:installed,storageKey:recoveryKey,legacy:retained};
  }
  function legacyBanner() {
    if(!workspaceBinding?.legacy)return '';
    return `<section class="sg-card" role="status"><strong>已保留旧版混合草稿</strong><p class="sg-note">产品图和当前${typeLabel(workspaceType(draft.settings))}的输入已恢复。旧方案、生成成果和待确认请求完整保留；请重新整理并核对当前类型的方案。</p><button type="button" class="sg-button" data-action="legacy-tasks">查看保留的旧任务</button></section>`;
  }
  function showLegacyTasks() {
    const saved=workspaceBinding?.legacy;if(!saved)return;
    const slots=[...(saved.snapshot?.tasks||[]).flatMap(entry=>entry.slots||[]),...(saved.snapshot?.previousResults||[])];
    const unfinished=slots.filter(slot=>!slot.item&&['generating','uncertain'].includes(slot.status)).length;
    const content=`<p class="sg-note">以下为保留的原草稿和任务记录。待确认请求继续保留原身份，不会自动重新提交。若旧图片预览暂不可用，可在生成记录中查看已归档原件。</p><button type="button" class="sg-button" data-action="history">打开生成记录</button>${(saved.draft.tasks||[]).map(entry=>`<section class="sg-card"><h3>${esc(entry.name||'商品任务')}</h3><p>${esc(entry.requirements||'未填写创作要求')}</p>${(entry.products||[]).filter(asset=>engine.validImage(asset.image)).map(asset=>`<img src="${esc(asset.image)}" alt="${esc(asset.name||'原产品图')}" style="max-width:160px;max-height:200px">`).join('')}</section>`).join('')}<p>${slots.filter(slot=>slot.item).length} 张已有成果 · ${unfinished||saved.snapshot?.uncertain?Math.max(unfinished,1):0} 张结果待确认</p>${slots.filter(slot=>slot.item&&engine.validImage(slot.item.url)).map(slot=>`<figure><img src="${esc(slot.item.url)}" alt="${esc(slot.shot?.label||'原生成成果')}" style="max-width:240px;max-height:280px"><figcaption>${esc(slot.shot?.label||'原生成成果')}</figcaption></figure>`).join('')}`;
    openDialog('保留的旧任务',content);
  }
  async function switchWorkspace(next) {
    if(!['main','detail','ad'].includes(next)||next===workspaceType(draft.settings)||locked())return;
    busy=true;render();
    const previous=workspaceBinding;
    try {
      await persist();await ensureAccount();
      const scope=scopeFor(next),loaded=await loadWorkspace(next,scope),saved=loaded.saved;await ensureAccount();
      let nextDraft;
      if(saved){validateWorkspace(saved,next);nextDraft=clone(saved.draft);}
      else {
        const cfg={...engine.defaults(next==='detail'?'detail':'main'),model:draft.settings.model,imageType:next==='ad'?'ad':'main',expertMode:false};
        if(next==='ad'){cfg.adTemplate=engine.adTemplates?.[0]?.id;cfg.adType='电商广告';}
        nextDraft={settings:cfg,tasks:draft.tasks.map((entry,index)=>({...task(index+1),name:entry.name,products:clone(entry.products)}))};
      }
      nextDraft.userModules=clone(library());nextDraft.userModuleGroups=clone(groups());
      const binding=createWorkspace(nextDraft,scope,loaded.storageKey,loaded.legacy,draftToken(saved));
      if(saved?.snapshot){const result=await binding.controller.restore(saved.snapshot);if(!result?.ok)throw new Error(result?.error||'该图片类型的草稿暂不能安全恢复，原草稿仍保留。');}
      const recovered=await binding.controller.recoverPendingReceipt();
      if(!recovered?.ok)throw new Error(recovered?.error||'该图片类型的回执暂不能安全恢复，原回执仍保留。');
      await ensureAccount();
      if(previous.controller.hasInFlightRequest?.()||previous.controller.state.busy||previous.controller.state.awaitingReceipt)throw new Error('原图片类型的请求尚未结束，请等待后再切换。');
      binding.restoring=false;installWorkspace(binding);
      moduleTab='official';moduleGroup='';selectedResults.clear();showPlan=true;
      await persist();
    } catch(error) {installWorkspace(previous);throw error;}
    finally {busy=false;render();}
  }
  // Shared browser slots cap all studio surfaces at 100 live provider requests.
  function stopQueuedSubmissions() {
    const pacer=window.SZCreativeRequestPacer;
    if(!pacer||pacer.version!==1||typeof pacer.cancelQueued!=='function'||current().accountKey!==account)return;
    for(const task of current().tasks||[])for(const slot of task.slots||[]) {
      const r=slot.pendingReceipt;
      if(slot.status!=='generating'||!r||r.receiptVersion!==1||r.accountKey!==account||r.workspaceKey!==workspaceScope||r.taskId!==task.id||r.shotId!==slot.shot.id)continue;
      pacer.cancelQueued({version:1,receiptId:r.receiptId,jobId:r.jobId,accountKey:r.accountKey,workspaceKey:r.workspaceKey,taskId:r.taskId,shotId:r.shotId,batchId:r.batchId,planSignatureHash:r.planSignatureHash});
    }
  }
  async function withGenerationSlot(owner,send,cancelled) {
    const locks=navigator.locks,prefix=`sz-studio-image-slot${environment}:${owner}:`;
    const notSubmitted=()=>({ok:false,definitiveFailure:true,providerSubmitted:false,error:'已停止排队，尚未提交此图。'});
    // This catch owns only the account check before send, never the provider reply.
    const runInSlot=async()=>{
      if(cancelled())return notSubmitted();
      try {await ensureAccount();} catch(error) {return {ok:false,definitiveFailure:true,providerSubmitted:false,error:error?.message||'登录状态暂不能核对，本图尚未提交。'};}
      if(cancelled())return notSubmitted();
      return send();
    };
    let useQuery=typeof locks.query==='function';
    for(;;){
      if(cancelled())return notSubmitted();
      if(useQuery){
        let admission;
        try {admission=await locks.request(`sz-studio-image-admission${environment}:${owner}`,async()=>{
          if(cancelled())return {cancelled:true};
          let snapshot,timer;
          try {snapshot=await Promise.race([locks.query(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('slot query timeout')),250);})]);}
          catch(_){return {fallback:true};}finally{clearTimeout(timer);}
          if(!snapshot||!Array.isArray(snapshot.held)||snapshot.held.some(lock=>!lock||typeof lock.name!=='string'))return {fallback:true};
          const held=new Set(snapshot.held.map(lock=>lock.name));let index=0;
          while(index<100&&held.has(prefix+index))index++;
          if(index===100)return {wait:true};
          let notify;const handshake=new Promise(resolve=>{notify=resolve;});
          const reply=locks.request(prefix+index,{ifAvailable:true},async lock=>{
            notify(!!lock);if(!lock)return;
            return runInSlot();
          });
          // Handshake ends the FIFO gate once the native slot is held. The slot
          // and its provider promise remain attached until the original settles.
          reply.catch(()=>notify(false));
          return await handshake?{reply}:{fallback:true};
        });} catch(_){admission={fallback:true};}
        if(admission.cancelled)return notSubmitted();
        if(admission.reply)return admission.reply;
        if(admission.fallback)useQuery=false;
        else {if(admission.wait)await new Promise(resolve=>setTimeout(resolve,100));continue;}
      }
      // Older Web Locks implementations keep the existing conservative scan.
      for(let index=0;index<100;index++){
        let acquired=false;
        const result=await locks.request(prefix+index,{ifAvailable:true},async lock=>{
          if(!lock)return;
          acquired=true;return runInSlot();
        });
        if(acquired)return result;
      }
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }
  async function persist({fromController=false,source}={}) {
    clearTimeout(saveTimer);
    const owner=source||workspaceBinding;
    if (startupFailed || !owner?.draft || owner.restoring || owner===workspaceBinding&&restoring) return;
    if(fromController&&saveFault)throw new Error(saveError || '本机草稿尚未保存，请稍后重试。');
    if(fromController){const key=owner.controller.snapshot().accountKey;if(key&&key!==account)throw new Error('任务所属账号与草稿不一致，已停止保存。');}
    else await ensureAccount();
    if(startupFailed)return;
    const key=owner.storageKey||draftKey(owner.scope), value={draft:clone(owner.draft),snapshot:owner.controller.snapshot(),savedAt:new Date().toISOString()};
    if(owner.legacyBackupKey)value.draft.legacyBackupKey=owner.legacyBackupKey;
    saveQueue=saveQueue.catch(()=>{}).then(async()=>{
      if(startupFailed)return;
      // A failed transaction applies to callbacks already queued in this run.
      // A later user action may retry storage through ordinary persist().
      if(fromController&&saveFault)throw new Error(saveError || '本机草稿尚未保存，请稍后重试。');
      owner.expectedDraftToken=await dbPut(key,value,owner.expectedDraftToken);
    });
    try { await saveQueue; saveFault=false;saveError=''; const label=root.querySelector('[data-save-state]');if(label)label.textContent='草稿已保存'; }
    catch (error) { saveFault=true;saveError=error.code==='STUDIO_DRAFT_CONFLICT'||error.message?.startsWith('本机草稿未保存：')?error.message:`本机草稿未保存：${error.message||error}。请检查浏览器存储空间。`;const failure=Object.assign(new Error(saveError),{code:error.code});showError(failure);throw failure; }
  }
  function scheduleSave() { clearTimeout(saveTimer);if(startupFailed)return;saveTimer=setTimeout(()=>persist().catch(showError),300); }
  function showError(error) { notice=error.message||String(error);noticeError=true;renderMessage();const modal=document.getElementById('sgDialog');if(modal&&!modal.hidden){const detail=modal.querySelector('[data-dialog-error]');if(detail)detail.textContent=notice;} }
  function message(text) { notice=text;noticeError=false;renderMessage(); }
  function renderMessage() {
    if(!root)return;
    const element=root.querySelector('[data-message]');
    if(element){element.hidden=!notice;element.textContent=notice;element.classList.toggle('is-error',noticeError);}
  }
  const options = (values,value) => values.map(entry=>{const [key,label]=Array.isArray(entry)?entry:[entry,entry];return `<option value="${esc(key)}"${String(value)===String(key)?' selected':''}>${esc(label)}</option>`;}).join('');
  const settings = entry => engine.resolveSettings(draft.settings,entry);
  // Display checks may reuse an unchanged input version. Copy objects without
  // serializing image strings, and compare every nested value to catch in-place
  // edits from imports as well as ordinary UI edits. Execution still uses the
  // contract's complete validation independently of this render-only cache.
  function validationSnapshot(value) {
    if(!value||typeof value!=='object')return value;
    if(Array.isArray(value))return value.map(validationSnapshot);
    const saved=Object.create(null);Object.keys(value).forEach(key=>{saved[key]=validationSnapshot(value[key]);});return saved;
  }
  function sameValidationInput(saved,value) {
    if(saved===value)return true;
    if(!saved||!value||typeof saved!=='object'||typeof value!=='object'||Array.isArray(saved)!==Array.isArray(value))return false;
    if(Array.isArray(value)&&saved.length!==value.length)return false;
    const keys=Object.keys(value), oldKeys=Object.keys(saved);
    return keys.length===oldKeys.length&&keys.every((key,index)=>key===oldKeys[index]&&sameValidationInput(saved[key],value[key]));
  }
  function displayedPlanCheck(entry) {
    const config=settings(entry), inputs={
      account, binding:typeof bridge.config==='function'?bridge.config():bridge.config||{},
      task:{id:entry.id,name:entry.name,requirements:entry.requirements,analysis:entry.analysis,products:entry.products},
      settings:config, plan:entry.plan
    };
    const saved=displayedPlanChecks.get(entry);
    if(saved&&saved.draft===draft&&sameValidationInput(saved.inputs,inputs))return saved.check;
    const check=engine.validatePlan(entry.plan,entry,config);
    displayedPlanChecks.set(entry,{draft,inputs:validationSnapshot(inputs),check});return check;
  }
  function field(label,key,values,config,target,wide=false) {
    const value=config[key]??'';
    if(value!==''&&!values.some(item=>String(Array.isArray(item)?item[0]:item)===String(value)))values=values.concat([[value,String(value)]]);
    return `<label class="${wide?'sg-wide':''}">${label}<select value="${esc(value)}" data-setting="${key}" data-target="${target}"${locked()?' disabled':''}>${options(values,value)}</select></label>`;
  }
  function settingsForm(config,target) {
    return mainSettingsForm(config,target);
  }
  function apiSelect() {
    const provider=modelInfo.provider||'';
    return `<div class="sg-form" style="margin-bottom:14px"><label class="sg-wide">已配置 API<select data-api${locked()?' disabled':''}>${apiChoices.length?options(apiChoices.map(item=>[item.provider,`${item.label} · ${item.imageModel}`]),provider):`<option value="">${initializing?'正在读取 API 配置…':'请先配置 API'}</option>`}</select></label></div>`;
  }
  const libraryKey = () => `sz_studio_main_modules_v1${environment}:${account}`;
  const groupKey = () => `sz_studio_module_groups_v1${environment}:${account}`;
  const ungrouped = '__ungrouped__';
  function library() { return draft.userModules || []; }
  function groups() {
    return [...new Set([...(Array.isArray(draft.userModuleGroups)?draft.userModuleGroups:[]),...library().map(item=>item.group)].filter(value=>typeof value==='string'&&value.trim()).map(value=>value.trim()))];
  }
  function groupNameError(name) {
    if(!name||name.length>40)return '请填写 1–40 字的分组名称。';
    if(['全部分组','未分组',ungrouped].includes(name))return '请使用不同的分组名称。';
    return '';
  }
  function groupEditor(name='') {
    openDialog(name?'编辑分组':'新建分组',`<p class="sg-note">分组用于整理自建模块；空分组也会保留。</p><div class="sg-form"><label class="sg-wide">分组名称<input data-group-name maxlength="40" value="${esc(name)}" placeholder="例如：商品陈列"></label></div><div class="sg-actions"><button class="sg-button" type="button" data-action="manage-groups">返回分组管理</button><button class="sg-button sg-primary" type="button" data-action="save-group" data-original="${esc(name)}">保存</button></div>`);
  }
  function groupManager() {
    openDialog('管理分组',`<p class="sg-note">删除分组后，其中的模块移到「未分组」，模块内容和已选方案会保留。</p><div class="sg-actions"><button class="sg-button sg-primary" type="button" data-action="group-editor">＋ 新建分组</button>${draft.removedGroup?'<button class="sg-button" type="button" data-action="restore-group">撤销最近删除分组</button>':''}</div><div class="sg-plan-list" style="margin-top:14px">${groups().map(name=>`<article class="sg-shot"><div class="sg-card-head"><div><h3>${esc(name)}</h3><p class="sg-note">${library().filter(item=>item.group===name).length} 个模块</p></div><div class="sg-actions"><button class="sg-button sg-small" type="button" data-action="group-editor" data-group="${esc(name)}">编辑</button><button class="sg-button sg-small" type="button" data-action="delete-group" data-group="${esc(name)}">删除</button></div></div></article>`).join('')||'<p class="sg-note">还没有分组，可创建一个空分组或在模块编辑时指定。</p>'}</div>`);
  }
  async function saveGroup(button) {
    const modal=document.getElementById('sgDialog'), name=modal.querySelector('[data-group-name]').value.trim(), original=button.dataset.original||'', list=groups();
    const error=groupNameError(name)||(list.includes(name)&&name!==original?'该分组名称已存在。':'')||(original&&!list.includes(original)?'该分组已变化，请重新打开分组管理。':'');
    if(error){modal.querySelector('[data-dialog-error]').textContent=error;return;}
    busy=true;render();
    try {
      await ensureAccount();draft.userModuleGroups=original?list.map(value=>value===original?name:value):list.concat(name);
      if(original){draft.userModules=library().map(item=>item.group===original?{...item,group:name}:item);if(moduleGroup===original)moduleGroup=name;}
      await saveLibrary();groupManager();message('分组已保存。');
    } finally { busy=false;render(); }
  }
  async function deleteGroup(name) {
    const list=groups();if(!list.includes(name))throw new Error('该分组已不存在。');
    busy=true;render();
    try {
      await ensureAccount();draft.removedGroup={name,moduleIds:library().filter(item=>item.group===name).map(item=>item.id)};
      draft.userModules=library().map(item=>item.group===name?{...item,group:''}:item);draft.userModuleGroups=list.filter(value=>value!==name);
      if(moduleGroup===name)moduleGroup=ungrouped;
      await saveLibrary();groupManager();message('分组已删除，原模块已移到「未分组」。');
    } finally { busy=false;render(); }
  }
  async function restoreGroup() {
    if(!draft.removedGroup)return;
    busy=true;render();
    try {
      await ensureAccount();const removed=draft.removedGroup;draft.userModuleGroups=[...new Set([...groups(),removed.name])];
      draft.userModules=library().map(item=>removed.moduleIds.includes(item.id)&&!item.group?{...item,group:removed.name}:item);
      draft.removedGroup=null;moduleGroup=removed.name;await saveLibrary();groupManager();message('分组已恢复。');
    } finally { busy=false;render(); }
  }
  function availableModules(config) {
    const type=config.imageType==='ad'?'ad':config.mode;
    return moduleTab==='official' ? config.mode==='detail'?engine.detailModules:engine.mainModules : library().filter(item=>(item.type||'main')===type&&(!moduleGroup||(moduleGroup===ungrouped?!item.group:item.group===moduleGroup))).map(item=>({id:item.id,label:item.name,skill:item.skill,description:item.description}));
  }
  function moduleCount(config,label) { return (config.modules||[]).filter(value=>value===label).length; }
  function moduleForm(config,target) {
    const custom=config.moduleMode==='custom', all=availableModules(config), selected=config.modules||[];
    const allSelected=all.length&&all.every(item=>selected.includes(item.label));
    return `<section class="sg-modules sg-wide"><span class="sg-field-label">${config.mode==='detail'?'详情图':config.imageType==='ad'?'广告图':'主图'}模块</span><div class="sg-module-modes" role="group" aria-label="模块选择方式">${[['smart','智能模块'],['custom','自定义模块']].map(([key,label])=>`<button type="button" data-action="module-mode" data-value="${key}" data-target="${target}" aria-pressed="${config.moduleMode===key}"${locked()?' disabled':''}>${label}${key==='custom'?'<small class="sg-new">新</small>':''}</button>`).join('')}</div>
      ${custom?`<div class="sg-module-tabs" role="tablist" aria-label="模块来源">${[['official','官方模块'],['mine','我的模块']].map(([key,label])=>`<button type="button" role="tab" aria-selected="${moduleTab===key}" data-action="module-tab" data-value="${key}"${locked()?' disabled':''}>${label}</button>`).join('')}</div>${moduleTab==='mine'?`<div class="sg-module-tools"><select data-module-group aria-label="模块分组"${locked()?' disabled':''}>${options([['','全部分组'],[ungrouped,'未分组'],...groups()],moduleGroup)}</select><button type="button" class="sg-text-button" data-action="module-editor"${locked()?' disabled':''}>＋ 自定义模块</button><button type="button" class="sg-text-button" data-action="manage-groups"${locked()?' disabled':''}>管理分组</button><button type="button" class="sg-text-button" data-action="manage-modules"${locked()?' disabled':''}>${managingModules?'完成管理':'去管理'}</button></div>`:''}<div class="sg-module-summary"><span>选择模块 <b>${selected.length}/16</b></span><label><input type="checkbox" data-module-all data-target="${target}"${allSelected?' checked':''}${locked()||!all.length?' disabled':''}>全选</label></div><div class="sg-module-grid">${all.map(item=>{const quantity=moduleCount(config,item.label);return `<div class="sg-module-item${quantity?' is-selected':''}"><label title="${esc(item.description||item.skill)}"><input type="checkbox" data-module="${esc(item.label)}" data-target="${target}"${quantity?' checked':''}${locked()?' disabled':''}><span>${esc(item.label)}</span></label>${quantity?`<div class="sg-module-quantity"><button type="button" aria-label="减少${esc(item.label)}数量" data-action="module-count" data-label="${esc(item.label)}" data-target="${target}" data-delta="-1"${locked()||quantity<=1?' disabled':''}>−</button><span>${quantity}</span><button type="button" aria-label="增加${esc(item.label)}数量" data-action="module-count" data-label="${esc(item.label)}" data-target="${target}" data-delta="1"${locked()||quantity>=5||selected.length>=16?' disabled':''}>＋</button></div>`:''}${moduleTab==='mine'&&managingModules?`<div class="sg-module-edit"><button type="button" data-action="module-editor" data-module-id="${esc(item.id)}"${locked()?' disabled':''}>编辑</button><button type="button" data-action="delete-module" data-module-id="${esc(item.id)}"${locked()?' disabled':''}>移除</button></div>`:''}</div>`;}).join('')}</div>${!all.length?'<p class="sg-note sg-module-empty">暂无可用模块，点击「自定义模块」添加。</p>':''}${draft.removedModule&&moduleTab==='mine'?'<button type="button" class="sg-text-button" data-action="restore-module">撤销最近移除</button>':''}${selected.length?`<p class="sg-note">已选 ${selected.length} 张：${esc([...new Set(selected)].join('、'))}</p>`:''}`:''}</section>`;
  }
  function mainSettingsForm(config,target) {
    const entry=target==='global'?draft.tasks[0]:draft.tasks.find(item=>item.id===target);
    const models=[...new Set([config.model||modelInfo.model||'',...apiChoices.filter(item=>item.provider===(modelInfo.provider||'')).map(item=>item.imageModel)].filter(Boolean))];
    const ratioNames={'1:1':'方图','3:4':'竖版','4:3':'横版','9:16':'竖屏','16:9':'横屏'};
    return `<div class="sg-form sg-main-form">
      ${config.imageType==='ad'?field('广告类型','adType',['电商广告','品牌广告','活动广告','社交广告'],config,target,true):field('目标平台','platform',engine.platforms,config,target,true)}
      ${entry&&!isBatch?`<div class="sg-wide sg-brief-field"><div class="sg-field-heading"><label for="sgBrief">${config.mode==='detail'?'详情图要求':config.imageType==='ad'?'广告诉求':'主图要求'}</label><button type="button" class="sg-text-button" data-action="write-brief" data-id="${entry.id}"${locked()||!entry.products.length||!modelInfo.ready?' disabled':''}>${icon('spark')}AI帮写</button></div><textarea id="sgBrief" data-task-field="requirements" data-id="${entry.id}" maxlength="6000" placeholder="输入产品卖点、目标人群、使用场景和图片风格"${locked()?' disabled':''}>${esc(entry.requirements)}</textarea></div>`:''}
      ${field('目标语言','language',engine.languages.map(value=>[value,value==='无文字纯视觉'?'无文字(纯视觉)':value]),config,target,true)}
      ${field('模型','model',models.length?models:[['','请先配置 API']],config,target,true)}
      ${field('尺寸比例','ratio',engine.ratios.map(value=>[value,`${value}${ratioNames[value]?' '+ratioNames[value]:''}`]),config,target)}
      ${field('清晰度','resolution',engine.resolutions.map(value=>[value,`${value} ${{'0.5K':'标准','1K':'标清','2K':'高清','4K':'超清'}[value]}`]),config,target)}
      ${config.moduleMode!=='custom'||config.imageType==='ad'?field(config.mode==='detail'?'详情屏数':'生成数量','count',Array.from({length:16},(_,i)=>[i+1,`${i+1} ${config.mode==='detail'?'屏':'张'}`]),config,target):''}
      ${config.imageType==='ad'?adQualityForm(config,target)+adTemplatesForm(config,target):moduleForm(config,target)}
    </div>`;
  }
  function adQualityForm(config,target) {
    const supported=modelInfo.qualityOptions||(['openai-images','generic-json'].includes(modelInfo.imageAdapter||modelInfo.adapter)?['auto','low','medium','high']:['auto']);
    const selected=config.quality||'auto', labels={auto:'自动质量',low:'低质量',medium:'标准质量',high:'高质量'};
    const choices=[...new Set([...supported,selected])];
    return `<label>质量<select data-setting="quality" data-target="${target}"${locked()?' disabled':''}>${choices.map(value=>`<option value="${esc(value)}"${selected===value?' selected':''}${!supported.includes(value)?' disabled':''}>${esc(labels[value]||value)}${!supported.includes(value)?'（当前 API 不支持）':''}</option>`).join('')}</select></label><section class="sg-wide sg-ad-speed"><span class="sg-field-label">生成速度</span><div class="sg-module-modes" role="group" aria-label="生成速度"><button type="button" data-action="generation-speed" data-value="standard" data-target="${target}" aria-pressed="${config.generationSpeed!=='fast'}"${locked()?' disabled':''}>标准</button><button type="button" aria-pressed="false" disabled title="当前 API 未提供快速生成能力">快速</button></div><p class="sg-note">当前 API 使用标准生成；快速模式尚未提供。</p></section>`;
  }
  function adTemplatesForm(config,target) {
    return `<section class="sg-wide sg-ad-templates"><div class="sg-field-heading"><span>超现实广告模板</span><span class="sg-meta">可编辑画面方案</span></div><div class="sg-ad-grid">${(engine.adTemplates||[]).map((item,index)=>`<button type="button" class="sg-ad-template sg-ad-${index}" data-action="ad-template" data-value="${item.id}" data-target="${target}" aria-pressed="${config.adTemplate===item.id}"${locked()?' disabled':''}><span class="sg-ad-art" aria-hidden="true"><i></i><b></b></span><strong>${esc(item.label)}</strong><small>${esc(item.description)}</small></button>`).join('')}</div><p class="sg-note">超现实场景与真实商品结合，保持商品外形、颜色和标识。</p></section>`;
  }
  function targetConfig(target) { const entry=draft.tasks.find(item=>item.id===target);return entry?entry.overrides:draft.settings; }
  function changedConfig(target) { (target==='global'?draft.tasks.filter(item=>!item.overrides):draft.tasks.filter(item=>item.id===target)).forEach(invalidate);showPlan=true;render();scheduleSave(); }
  function syncModules(config) {
    const type=config.imageType==='ad'?'ad':config.mode;
    config.moduleSkills=Object.fromEntries(library().filter(item=>(item.type||'main')===type&&(config.modules||[]).includes(item.name)).map(item=>[item.name,item.skill]));
    if(config.moduleMode==='custom')config.count=Math.max(1,(config.modules||[]).length);
  }
  function eachConfig(callback) { [...new Set([draft.settings,...Object.values(draft.typeSettings||{}),...draft.tasks.map(entry=>entry.overrides).filter(Boolean)])].forEach(callback); }
  function moduleEditor(id) {
    const item=library().find(module=>module.id===id)||{name:'',description:'',skill:'',group:''};
    const type=item.type||(draft.settings.mode==='detail'?'detail':draft.settings.imageType==='ad'?'ad':'main');
    openDialog('自定义模块',`<p class="sg-note">设定模块名称、简介和 Skill，作为本模块的画面提示词。</p><div class="sg-form"><label class="sg-wide">图类型<select data-module-type>${options([['main','主图'],['detail','详情图'],['ad','广告图']],type)}</select></label><label class="sg-wide">模块名称<input data-module-name maxlength="80" value="${esc(item.name)}" placeholder="例如：桌面使用场景"></label><label class="sg-wide">所属分组<input data-module-group-name maxlength="40" value="${esc(item.group)}" placeholder="输入已有分组或新建分组"></label><label class="sg-wide">模块简介<input data-module-description maxlength="200" value="${esc(item.description)}"></label><label class="sg-wide">Skill（模块提示词）<textarea data-module-skill maxlength="2000" placeholder="描述构图、光线、背景和需要突出的商品细节">${esc(item.skill)}</textarea></label></div><div class="sg-actions"><button class="sg-button" type="button" data-action="close-dialog">取消</button><button class="sg-button sg-primary" type="button" data-action="save-module" data-module-id="${esc(id||'')}">保存</button></div>`);
  }
  function openDialog(title,body) {
    let modal=document.getElementById('sgDialog');if(!modal){modal=document.createElement('div');modal.id='sgDialog';modal.className='sg-modal';document.body.appendChild(modal);modal.addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(button)action(button).catch(showError);else if(event.target===modal)modal.hidden=true;});}
    modal.innerHTML=`<section class="sg-modal-content" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="sg-card-head"><h2>${esc(title)}</h2><button type="button" class="sg-button sg-small" data-action="close-dialog" aria-label="关闭弹窗">关闭</button></div>${body}<p data-dialog-error role="alert" class="sg-note"></p></section>`;modal.hidden=false;modal.querySelector('input,textarea,button')?.focus();
  }
  function tabs() {
    const active=draft.settings.mode==='detail'?'detail':draft.settings.imageType==='ad'?'ad':'main';
    return `<div class="sg-tabs" role="tablist" aria-label="图片类型">${[['main','主图'],['detail','详情图'],['ad','广告图']].map(([id,label])=>`<button type="button" role="tab" aria-selected="${active===id}" data-action="mode" data-mode="${id}"${locked()?' disabled':''}>${label}${id==='ad'?'<small class="sg-new">新</small>':''}</button>`).join('')}</div>`;
  }
  function products(entry) {
    return `${window.SZ_IMAGE_UPLOAD.markup({title:'产品图',subtitle:'上传清晰的产品图片',count:entry.products.length,max:6,hint:'白底产品图最佳 · 最多 6 张同款商品图',note:'多图用于补充同一商品的必要视角，原图会保留。',input:`<input type="file" accept="image/png,image/jpeg,image/webp" multiple data-files="${entry.id}" aria-label="${esc(entry.name)}产品图"${locked()?' disabled':''}>`,zoneAttributes:`data-drop="${entry.id}"`})}
      <div class="sg-assets">${entry.products.map((asset,index)=>`<div class="sg-asset"><img src="${esc(asset.image)}" alt="${esc(asset.name)}" role="button" tabindex="0" aria-label="预览产品图 ${index+1}" data-product-preview="${entry.id}" data-index="${index}"><button type="button" aria-label="移除产品图 ${index+1}" data-action="remove-image" data-id="${entry.id}" data-index="${index}"${locked()?' disabled':''}>×</button><small>${esc(asset.name)}</small></div>`).join('')}</div><a class="sg-refinement-link" href="/dashboards/operating-network?surface=refinement" target="_top">没有白底图？ 去精修获得白底图</a>`;
  }
  function taskFields(entry) {
    return `<div class="sg-form"><label class="sg-wide">商品名称<input data-task-field="name" data-id="${entry.id}" value="${esc(entry.name)}" maxlength="100" placeholder="为商品任务命名"${locked()?' disabled':''}></label><label class="sg-wide">图片要求<textarea data-task-field="requirements" data-id="${entry.id}" maxlength="6000" placeholder="输入产品卖点、目标人群、使用场景和图片风格"${locked()?' disabled':''}>${esc(entry.requirements)}</textarea></label></div>`;
  }
  function plans(entry) {
    if(!entry.plan)return '';
    return `<div class="sg-plan-list">${entry.plan.shots.map(shot=>`<article class="sg-shot"><h3>${esc(shot.index||'')} ${esc(shot.label)}</h3><textarea data-shot="${shot.id}" data-id="${entry.id}" aria-label="${esc(entry.name)} ${esc(shot.label)}方案"${locked()?' disabled':''}>${esc(shot.prompt)}</textarea></article>`).join('')}</div><label class="sg-confirm"><input type="checkbox" data-confirm="${entry.id}"${entry.confirmed?' checked':''}${locked()?' disabled':''}><span>我已核对商品、内容与画面方案，按此方案生成。</span></label>`;
  }
  function slotsFor(id) { const record=current().tasks.find(entry=>entry.id===id);return (record?.slots||[]).map(slot=>({...slot,taskId:id,taskName:record.name})); }
  function allSlots() {
    const type=draft?.settings.imageType==='ad'?'ad':draft?.settings.mode;
    const sameType=config=>(config.imageType==='ad'?'ad':config.mode)===type;
    return (current().tasks||[]).filter(entry=>entry.plan&&sameType(entry.plan.settings)).flatMap(entry=>{
      const planned=draft.tasks.find(item=>item.id===entry.id)?.plan;
      return (entry.slots||[]).map(slot=>({...slot,taskName:entry.name,taskId:entry.id,previous:!planned||planned.signature!==entry.plan.signature}));
    }).concat((current().previousResults||[]).filter(slot=>slot.item?.studioGenesisPlan?.settings&&sameType(slot.item.studioGenesisPlan.settings)).map(slot=>({...slot,previous:true,taskName:slot.item&&slot.item.productName||''})));
  }
  function activeSlots() {
    return (current().tasks||[]).filter(entry=>{
      const planned=draft.tasks.find(item=>item.id===entry.id)?.plan;
      return planned&&entry.plan&&planned.signature===entry.plan.signature;
    }).flatMap(entry=>entry.slots||[]);
  }
  function pendingImage(taskId,shotId) {
    const state=current();
    return (state.pendingReceipts||[]).concat(state.uncertain||[]).some(receipt=>receipt.accountKey===account&&receipt.taskId===taskId&&receipt.shotId===shotId)||
      (state.tasks||[]).some(entry=>entry.id===taskId&&(entry.slots||[]).some(slot=>slot.shot.id===shotId&&!slot.item&&slot.status==='uncertain'));
  }
  function eligibleShots(entry,retry=false) {
    if(!entry.plan)return [];
    const record=current().tasks.find(item=>item.id===entry.id), compatible=record&&record.plan.signature===entry.plan.signature;
    if(retry)return compatible?record.slots.filter(slot=>slot.status==='failed'&&!pendingImage(entry.id,slot.shot.id)):[];
    return compatible?record.slots.filter(slot=>['ready','queued'].includes(slot.status)&&!pendingImage(entry.id,slot.shot.id)):
      entry.plan.shots.filter(shot=>!pendingImage(entry.id,shot.id));
  }
  function newGenerationTasks() {
    // A revised plan must not replace the plan needed to recover an older
    // receipt. Make that revised plan an explicit, independently priced task.
    const revised=draft.tasks.filter(entry=>{
      const record=current().tasks.find(item=>item.id===entry.id);
      return entry.plan&&record&&record.plan.signature!==entry.plan.signature&&record.slots.some(slot=>pendingImage(entry.id,slot.shot.id));
    });
    if(draft.tasks.some(entry=>!revised.includes(entry)&&(eligibleShots(entry).length||eligibleShots(entry,true).length)))return revised;
    return draft.tasks.filter(entry=>{
      if(revised.includes(entry))return true;
      if(!entry.plan)return false;
      const record=current().tasks.find(item=>item.id===entry.id), compatible=record&&record.plan.signature===entry.plan.signature;
      return entry.plan.shots.some(shot=>pendingImage(entry.id,shot.id)&&(!compatible||!record.slots.find(slot=>slot.shot.id===shot.id)?.item));
    });
  }
  function copyGenerationTasks(entries) {
    const copies=new Map(entries.map(entry=>{
      const next=clone(entry);next.id=uid();
      const copyPlan=plan=>{
        const result=engine.reidentifyPlan(plan,next.id);
        if(result.ok===false)throw new Error(result.error);
        return result;
      };
      next.plan=copyPlan(entry.plan);
      Object.values(next.typeDrafts||{}).forEach(saved=>{if(saved.plan)saved.plan=copyPlan(saved.plan);});
      return [entry,next];
    }));
    // Keep the original controller records and journals for receipt recovery.
    draft.tasks=draft.tasks.map(entry=>copies.get(entry)||entry);
  }
  function statusLabel(status) { return ({ready:'待生成',queued:'排队中',generating:'生成中',done:'已完成',failed:'生成失败',uncertain:'生成结果确认中'})[status]||status; }
  // Display legacy snapshots safely without changing their task or receipt state.
  function historicalSlotError(slot) {
    const original=slot.error, stored=original&&typeof original==='object'&&!Array.isArray(original)?original:null;
    const meta=slot.errorMeta&&typeof slot.errorMeta==='object'&&!Array.isArray(slot.errorMeta)?slot.errorMeta:null;
    let body=stored, raw=typeof original==='string'?original:'';
    if(!body&&raw.length<=16384){
      const start=raw.indexOf('{');
      if(start>=0)try {const parsed=JSON.parse(raw.slice(start));if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))body=parsed;}catch(_){}
    }
    const detail=body&&body.error&&typeof body.error==='object'?body.error:null;
    const codeValue=meta&&meta.code||body&&(body.code||body.errorCode)||detail&&detail.code||'';
    const code=typeof codeValue==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,95}$/.test(codeValue)?codeValue.toUpperCase():'';
    const stateCodes=[meta&&meta.code,body&&body.code,body&&body.errorCode,detail&&detail.code].map(value=>typeof value==='string'?value.slice(0,96).toUpperCase():'').join(' ');
    const hintValue=body&&(body.message||typeof body.error==='string'&&body.error)||detail&&detail.message||raw;
    const hint=typeof hintValue==='string'?hintValue.slice(0,1024):'';
    const check='请先查看原任务记录，避免重复提交。';
    const uncertain=slot.status==='uncertain'||slot.stateUncertain===true||slot.providerSubmitted===true||meta&&(meta.stateUncertain===true||meta.providerSubmitted===true)||body&&(body.stateUncertain===true||body.providerSubmitted===true)||detail&&(detail.stateUncertain===true||detail.providerSubmitted===true)||
      /UNKNOWN|UNCERTAIN|INFLIGHT|IN_FLIGHT|ALREADY_SUBMITTED|ALREADY_DISPATCHED|REQUEST_ACTIVE|HOLD_PENDING|REPLAY|SOURCE_USAGE_UNPROVEN/.test(stateCodes);
    if(uncertain)return '系统正在确认这张图片的结果，其他图片可继续生成。';
    // A historical string or HTTP status is never proof of non-submission.
    const receipt=meta||stored;
    const notSubmitted=receipt&&receipt.proxyNotSubmitted===true&&receipt.providerSubmitted===false&&receipt.definitiveFailure===true&&
      /^(?:CREATIVE_REQUEST_NOT_SUBMITTED|CREATIVE_SUPPLY_NOT_CONFIGURED|CREATIVE_SUPPLY_UNAVAILABLE|CREATIVE_ACCOUNT_CHANGED|INSUFFICIENT_BALANCE|CREATIVE_CREDIT_SERVICE_UNAVAILABLE|CREDIT_SERVICE_UNAVAILABLE|POOL_[A-Z0-9_]+|CREDIT_POOL_[A-Z0-9_]+)$/.test(code);
    const service='生成服务暂时繁忙。'+(notSubmitted?'请稍后再试。':check);
    const balance='可用积分不足，请补充积分。'+(notSubmitted?'补充后可继续。':check);
    const login='请恢复原账号登录后查看任务记录，避免重复提交。';
    const modelAuth='自有生图接口鉴权失败，请重新核对并保存 API 配置。'+check;
    const legacyAuth='接口鉴权未通过，请核对登录状态和 API 配置。'+check;
    const limited='请求较多，服务暂时繁忙。'+(notSubmitted?'请稍后再试。':check);
    if(/^(?:POOL_|CREDIT_POOL_|SHARED_SOURCE_|SOURCE_|FX_RATE_|INVALID_FX_|INSUFFICIENT_POOL_|CREATIVE_SUPPLY_|CREATIVE_CREDIT_SERVICE_|CREDIT_SERVICE_)/.test(code))return service;
    if(/^(?:INSUFFICIENT_BALANCE|INSUFFICIENT_CREDITS)$/.test(code))return balance;
    if(code==='CREATIVE_REQUEST_NOT_SUBMITTED'&&notSubmitted&&(receipt.httpStatus||receipt.status)===401)return login;
    if(/^(?:AUTH_REQUIRED|ACCOUNT_UNAVAILABLE|CREATIVE_ACCOUNT_(?:CHANGED|UNAVAILABLE)|STUDIO_ACCOUNT_(?:CHANGED|REQUIRED))$/.test(code))return login;
    if(code==='MODEL_AUTH_FAILED')return modelAuth;
    // Older snapshots stored the safe auth wording with an ambiguous code.
    if(code==='UNAUTHORIZED')return /模型服务鉴权失败|自有生图接口鉴权失败/.test(hint)?modelAuth:legacyAuth;
    if(/模型服务鉴权失败|自有生图接口鉴权失败/.test(hint))return modelAuth;
    if(/^(?:RATE_LIMITED|TOO_MANY_REQUESTS)$/.test(code))return limited;
    if(/^(?:IMAGE_MODEL_INVALID|MODEL_INVALID|INVALID_MODEL|IMAGE_MODEL_REQUIRED|MODEL_TYPE_MISMATCH)$/.test(code)||/images?\s+endpoint\s+(?:requires?|expects?)\s+(?:an?\s+)?image\s+model/i.test(hint))return '所选模型不适用于生图，请重新选择模型并核对设置。'+check;
    if(/^(?:IMAGE_)?MODEL_NOT_FOUND$/.test(code))return '所选生图模型暂时不可用，请重新选择模型并核对设置。'+check;
    if(/^(?:PRODUCT_IMAGE_FETCH_FAILED|PRODUCT_IMAGE_INVALID|IMAGE_PREPARE_FAILED|IMAGE_PREPARATION_FAILED|IMAGE_INPUT_PREPARATION_FAILED|IMAGE_FETCH_FAILED|IMAGE_DECODE_FAILED|INVALID_IMAGE|INVALID_IMAGE_FORMAT|UNSUPPORTED_IMAGE_FORMAT)$/.test(code))return '产品图或素材暂时无法读取，请检查素材。'+check;
    if(/总(?:积分)?池|积分池|会计|账本|供应|订阅未配置|上游|(?:USD|\bFX\b)|汇率|api[ _-]?key|authorization|secret|upstream|provider|ledger|exchange[_ -]?rate/i.test(hint))return service;
    if(/可用积分不足|余额不足|insufficient (?:balance|credit)/i.test(hint))return balance;
    if(/未登录|请先登录|登录.{0,12}(?:失效|过期)|HTTP\s+401/i.test(hint))return login;
    if(/请求较多|请求过于频繁|rate[_ -]?limit|too many requests|HTTP\s+429/i.test(hint))return limited;
    if(/(?:产品图|商品主体图)(?:读取失败|解码失败)|(?:无法读取|读取失败).{0,12}(?:产品图|商品主体图)|(?:图片格式不支持|图片解码失败)/i.test(hint))return '产品图或素材暂时无法读取，请检查素材。'+check;
    return '这张图片暂时未完成。'+check;
  }
  // Presentation-only cache. Canonical URLs, receipts and drafts stay intact.
  function releaseLocalOriginals() {
    for(const entry of localOriginals.values())if(entry.url)try{URL.revokeObjectURL(entry.url);}catch(_){}
    localOriginals.clear();
  }
  function localDisplayOwner(binding=workspaceBinding) {
    try{return !!account&&binding===workspaceBinding&&!!root&&root.isConnected!==false&&(!displayFrame||displayFrame.isConnected)&&bridge.archiveContext?.().accountKey===account;}catch(_){return false;}
  }
  function localOriginalDescriptor(slot) {
    try {
      const item=slot?.item,r=slot?.generationReceipt;
      if(slot.status!=='done'||!slot.archiveOk||!item||!r||!item.archiveAssetId||item.accountKey!==account||r.accountKey!==account||r.taskId!==item.studioTaskId||r.shotId!==slot.shot?.id||r.jobId!==item.jobId||r.batchId!==item.batchId||item.resultId!==r.jobId+':studio:'+r.shotId)return null;
      if(['accountKey','taskId','shotId','jobId','batchId'].some(key=>typeof r[key]!=='string'||!r[key].trim())||!Number.isFinite(r.createdAt)||r.createdAt<=0)return null;
      const plan=slot.previous?item.studioGenesisPlan:current().tasks.find(task=>task.id===r.taskId)?.plan;
      if(!plan||engine.validatePlan(plan)?.ok!==true||JSON.stringify(plan)!==JSON.stringify(item.studioGenesisPlan)||JSON.stringify(plan.shots.find(shot=>shot.id===r.shotId))!==JSON.stringify(slot.shot))return null;
      let identity;
      if(r.receiptVersion===1){
        identity={version:1,receiptId:r.receiptId,jobId:r.jobId,accountKey:r.accountKey,workspaceKey:r.workspaceKey,taskId:r.taskId,shotId:r.shotId,batchId:r.batchId,planSignatureHash:r.planSignatureHash};
        if(r.workspaceKey!==workspaceScope||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(identity.receiptId||'')||!/^[a-f0-9]{64}$/.test(identity.planSignatureHash||''))return null;
        const url=new URL(item.url,location.origin),query=JSON.parse(url.searchParams.get('identity'));
        if(url.origin!==location.origin||url.username||url.password||url.hash||!new RegExp('^/api/creative/image-receipts/'+identity.receiptId+'/content/(?:0|[1-9][0-9]{0,2})$').test(url.pathname)||Array.from(url.searchParams.keys()).length!==1||Object.keys(query||{}).length!==9||!Object.keys(identity).every(key=>query[key]===identity[key]))return null;
      }else{
        if(['receiptVersion','receiptId','workspaceKey','planSignatureHash'].some(key=>Object.prototype.hasOwnProperty.call(r,key))||!engine.validImage(item.url))return null;
        if(!/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(item.url)){
          const url=new URL(item.url);if(url.protocol!=='https:'||url.username||url.password||url.hash||url.pathname.startsWith('/api/creative/image-receipts/'))return null;
        }
        identity={accountKey:r.accountKey,taskId:r.taskId,shotId:r.shotId,jobId:r.jobId,batchId:r.batchId,createdAt:r.createdAt};
      }
      const expected={archiveAssetId:item.archiveAssetId,resultId:item.resultId,jobId:item.jobId,providerTaskId:String(item.taskId||'')};
      return {key:JSON.stringify({account,scope:workspaceScope,previous:!!slot.previous,expected,identity,createdAt:r.createdAt,url:item.url}),identity,expected,signature:plan.signature,url:item.url};
    }catch(_){return null;}
  }
  function currentLocalDescriptor(descriptor) {
    return allSlots().map(localOriginalDescriptor).find(value=>value?.key===descriptor.key);
  }
  function localResultUrl(slot) {
    const descriptor=localOriginalDescriptor(slot),entry=descriptor&&localOriginals.get(descriptor.key);
    return localDisplayOwner()&&entry?.url||slot.item?.url||'';
  }
  function applyLocalOriginals(version) {
    if(version!==displayRenderVersion||!localDisplayOwner())return;
    for(const slot of allSlots()){
      const descriptor=localOriginalDescriptor(slot),entry=descriptor&&localOriginals.get(descriptor.key);if(!entry?.url)continue;
      root.querySelectorAll('[data-preview]').forEach(image=>{if(image.dataset.preview===slot.item.resultId)image.src=entry.url;});
      const modal=document.getElementById('sgPreview');if(modal&&!modal.hidden&&modal.dataset.localResult===slot.item.resultId){const image=modal.querySelector('img');if(image)image.src=entry.url;}
    }
  }
  function readLocalOriginal(slot,explicit=false) {
    const descriptor=localOriginalDescriptor(slot),binding=workspaceBinding,archive=window.SZ_IMAGE_ARCHIVE;
    if(!descriptor||!localDisplayOwner(binding)||deactivating||typeof archive?.readCommittedResult!=='function')return Promise.resolve(null);
    let entry=localOriginals.get(descriptor.key);
    if(entry?.url)return Promise.resolve(entry.url);
    if(entry?.promise)return entry.promise;
    if(entry&&!explicit)return Promise.resolve(null);
    entry={url:'',promise:null};localOriginals.set(descriptor.key,entry);
    entry.promise=(async()=>{
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(descriptor.signature));
      const hash=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
      if(descriptor.identity.version===1&&hash!==descriptor.identity.planSignatureHash||!localDisplayOwner(binding)||deactivating||localOriginals.get(descriptor.key)!==entry||!currentLocalDescriptor(descriptor))return null;
      const result=await archive.readCommittedResult(account,descriptor.expected);
      if(!result?.ok||result.accountKey!==account||!Object.keys(descriptor.expected).every(key=>result[key]===descriptor.expected[key])||!(result.blob instanceof Blob)||!localDisplayOwner(binding)||deactivating||localOriginals.get(descriptor.key)!==entry||!currentLocalDescriptor(descriptor))return null;
      const url=URL.createObjectURL(result.blob);
      if(!localDisplayOwner(binding)||localOriginals.get(descriptor.key)!==entry||!currentLocalDescriptor(descriptor)){URL.revokeObjectURL(url);return null;}
      entry.url=url;applyLocalOriginals(displayRenderVersion);return url;
    })().catch(()=>null).finally(()=>{entry.promise=null;});
    return entry.promise;
  }
  function refreshLocalOriginals() {
    if(!localDisplayOwner()){releaseLocalOriginals();return;}
    const slots=allSlots(),keys=new Set(slots.map(localOriginalDescriptor).filter(Boolean).map(value=>value.key));
    for(const[key,entry]of localOriginals)if(!keys.has(key)){if(entry.url)try{URL.revokeObjectURL(entry.url);}catch(_){}localOriginals.delete(key);}
    if(!deactivating)for(const slot of slots)void readLocalOriginal(slot);
    applyLocalOriginals(displayRenderVersion);
  }
  window.addEventListener('pagehide',releaseLocalOriginals);
  function resultsMarkup(slots) {
    return `<div class="sg-results">${slots.filter(slot=>slot.item||['failed','generating','uncertain'].includes(slot.status)).map(slot=>{
      const image=slot.item&&localResultUrl(slot);
      const taskId=slot.taskId||slot.item?.studioTaskId;
      return `<article class="sg-result${slot.status==='failed'?' sg-failed':''}">${image?`<label class="sg-result-select"><input type="checkbox" aria-label="选择${esc(slot.shot&&slot.shot.label||'结果图片')}" data-result-select="${esc(slot.item.resultId)}"${selectedResults.has(slot.item.resultId)?' checked':''}></label><img src="${esc(image)}" alt="${esc(slot.shot&&slot.shot.label||'生成图片')}" data-preview="${esc(slot.item.resultId)}">`:''}<div><h3>${esc(slot.taskName||'')} ${esc(slot.shot&&slot.shot.label||'')}${slot.previous?' · 历史版本':''}</h3><p>${statusLabel(slot.status)}</p>${slot.error?`<p>${esc(historicalSlotError(slot))}</p>`:''}${image?`<p>${slot.archiveOk?'已存入本机历史':'原件待补存'}</p><div class="sg-actions"><button type="button" class="sg-button sg-small" data-action="download" data-result="${esc(slot.item.resultId)}">下载</button><button type="button" class="sg-button sg-small" data-action="edit-result" data-result="${esc(slot.item.resultId)}"${locked()?' disabled':''}>编辑图片</button>${!slot.archiveOk?`<button type="button" class="sg-button sg-small" data-action="archive" data-result="${esc(slot.item.resultId)}"${locked()?' disabled':''}>补存原件</button>`:''}</div>`:''}${!slot.previous&&taskId&&!pendingImage(taskId,slot.shot.id)&&['done','failed'].includes(slot.status)?`<button type="button" class="sg-text-button" data-action="retry-slot" data-task-id="${esc(taskId)}" data-shot-id="${esc(slot.shot.id)}"${generationLocked()||!modelInfo.ready?' disabled':''}>${slot.status==='done'?'重新生成此图':'重试此图'}</button>`:''}</div></article>`;
    }).join('')}</div>`;
  }
  function runSummary() {
    const slots=activeSlots(), done=slots.filter(slot=>slot.status==='done').length;
    if(!slots.length)return '';
    return `<div class="sg-run-summary"><span>${done}/${slots.length} 已完成</span><progress value="${done}" max="${slots.length}"></progress><span>${slots.filter(slot=>slot.status==='failed').length} 项失败</span></div>`;
  }
  function renderSingle() {
    const entry=draft.tasks[0];
    const ad=draft.settings.imageType==='ad', kind=ad?'广告图':draft.settings.mode==='detail'?'详情图':'主图';
    return `<div class="sg-hero"><span class="sg-eyebrow">${icon('spark')} AI 主图 · 详情页 · 广告图</span><h1>${ad?'超现实广告图实验室':draft.settings.mode==='detail'?'详情生图实验室':'主图生图实验室'}</h1><p>上传产品图，AI 智能分析并帮写拍摄需求，生成多角度、多场景的电商图片</p></div>
      <div class="sg-top-actions"><div class="sg-actions">${commonActions()}</div></div>${stepper(entry)}
      <div data-message class="sg-message" role="status" aria-live="polite" hidden></div>
      <div class="sg-workspace"><div class="sg-inputs"><section class="sg-card">${products(entry)}</section>
      <section class="sg-card sg-settings-card">${tabs()}${settingsForm(draft.settings,'global')}<details class="sg-advanced"><summary>商品信息</summary><div class="sg-form"><label class="sg-wide">商品名称<input data-task-field="name" data-id="${entry.id}" value="${esc(entry.name)}" maxlength="100"${locked()?' disabled':''}></label></div></details></section><div class="sg-expert"><span>开启后分析更深入，规划质量更高</span><label>专家模式 <input type="checkbox" role="switch" aria-label="专家模式" data-setting="expertMode" data-target="global"${draft.settings.expertMode?' checked':''}${locked()?' disabled':''}></label></div><button class="sg-button sg-primary sg-analyze-submit" type="button" data-action="analyze" data-id="${entry.id}"${!entry.products.length||locked()||!modelInfo.ready?' disabled':''}>${icon('spark')}${analyzing?'正在分析…':'分析产品'}</button><button class="sg-button sg-primary sg-local-plan" type="button" data-action="plan"${!entry.products.length||locked()?' disabled':''}>${icon('settings')}整理创作方案</button><p class="sg-note">核对整理后的画面方案，再点击继续生成。整理方案不调用模型；AI 分析和生成使用已配置 API。</p></div>
      <section class="sg-card sg-result-panel"><div class="sg-card-head"><div class="sg-card-title">${icon('spark')}<div><h2>${entry.plan?'确认规划与生成结果':'生成结果'}</h2><p>${entry.plan?`核对每张${kind}的画面方案后生成`:'上传产品图并点击分析开始'}</p></div></div></div><div data-result-body>${singleResultBody(entry)}</div></section></div>`;
  }
  function singleResultBody(entry) {
    if(!entry.plan&&!allSlots().length&&!current().tasks.length)return `<div class="sg-empty">${icon('spark')}<p>上传产品图并填写要求后<br>点击「分析产品」开始</p>${draft.previousProjectKey?'<button class="sg-text-button" type="button" data-action="restore-project">恢复上一项目</button>':''}</div>${pendingReceiptMarkup(current().uncertain)}`;
    return `${entry.plan?`<div class="sg-plan-toolbar"><button class="sg-text-button" type="button" data-action="back-input"${locked()?' disabled':''}>← 返回输入</button><button class="sg-text-button" type="button" data-action="toggle-plan"${locked()?' disabled':''}>${showPlan?'收起规划':'查看规划'}</button><button class="sg-text-button" type="button" data-action="new-project"${locked()?' disabled':''}>新建项目</button></div>${showPlan?`<details class="sg-design-specs"><summary>整体设计要求</summary><textarea aria-label="整体设计要求" data-task-field="requirements" data-id="${entry.id}"${locked()?' disabled':''}>${esc(entry.requirements)}</textarea><p class="sg-note">修改后重新整理方案，再核对确认。</p></details>${entry.analysis?`<details class="sg-analysis-details"><summary>查看产品分析</summary><pre>${esc(entry.analysis)}</pre></details>`:''}${plans(entry)}`:''}`:''}${generateActions()}${runSummary()}${allSlots().some(slot=>slot.item)?`<div class="sg-actions"><button class="sg-button sg-small" type="button" data-action="select-results">全选结果</button><button class="sg-button sg-small" type="button" data-action="download-selected"${!selectedResults.size?' disabled':''}>下载已选 (${selectedResults.size})</button></div>`:''}${resultsMarkup(allSlots())}${draft.previousProjectKey?'<button class="sg-text-button" type="button" data-action="restore-project">恢复上一项目</button>':''}`;
  }
  function stepper(entry) {
    const slots=activeSlots(), active=analyzing?1:current().busy?3:slots.length&&slots.every(slot=>slot.status==='done')?4:entry.plan?2:0;
    return `<ol class="sg-steps" aria-label="创作进度">${['输入','分析中','确认规划','生成中','完成'].map((label,index)=>`<li class="${index===active?'is-active':index<active?'is-complete':''}"${index===active?' aria-current="step"':''}><b>${index+1}</b><div><small>STEP 0${index+1}</small>${label}</div></li>`).join('')}</ol>`;
  }
  function commonActions() {
    return `<button type="button" class="sg-button" data-action="history">${icon('history')}生成记录</button><button type="button" class="sg-button" data-action="config"${locked()?' disabled':''}>${icon('settings')}配置 API</button>`;
  }
  function pendingReceiptMarkup(receipt) {
    if(!receipt)return '';
    if(current().accountKey!==account||receipt.accountKey&&receipt.accountKey!==account)return '<div class="sg-message is-error" role="alert">任务回执所属账号不一致，请重新打开工作台；原账号素材和回执仍保留。</div>';
    const pending=allSlots().filter(slot=>slot.status==='uncertain'&&!slot.item), count=pending.length||1;
    return `<p class="sg-note sg-pending-receipt" data-pending-receipt role="status" aria-live="polite">${count} 张图片的生成结果正在确认，其他图片可继续生成，无需手动解除。</p>`;
  }
  // Recovery uses the original request's stored success or trusted notSubmitted
  // outcome to update its exact image; there is no supplier polling here.
  async function refreshReceipts() {
    if(startupFailed||!controller||!draft||initializing||restoring||deactivating||navigationLocked())return;
    if(receiptRecovery)return receiptRecovery;
    receiptRecovery=(async()=>{
      const before=JSON.stringify(controller.snapshot());
      await ensureAccount();
      const result=await controller.recoverPendingReceipt();
      if(!result||result.ok!==true)throw new Error(result&&result.error||'生成结果暂时无法同步，请稍后重试。');
      await ensureAccount();
      if(before!==JSON.stringify(controller.snapshot()))await persist();
      render();
    })();
    try { await receiptRecovery; } catch(error) { modelInfo={};throw error; } finally { receiptRecovery=null;if(!startupFailed)render(); }
  }
  function generateActions() {
    const slots=allSlots(), uncertain=current().uncertain;
    const ready=draft.tasks.length&&draft.tasks.every(entry=>entry.plan&&entry.confirmed&&displayedPlanCheck(entry).ok!==false);
    const hasPending=draft.tasks.some(entry=>eligibleShots(entry).length), hasFailed=draft.tasks.some(entry=>eligibleShots(entry,true).length);
    const freshTasks=newGenerationTasks(), freshCount=freshTasks.reduce((sum,entry)=>sum+entry.plan.shots.length,0);
    const imageApiUnavailable=!modelInfo.ready||modelInfo.supportsReference===false;
    const apiReason=!initializing&&imageApiUnavailable?(!modelInfo.ready?'当前自有 API 尚未配置完整，请选择平台积分模式或配置并保存自有 API，再生成已确认的方案。':'当前 API 的生图模型不支持产品参考图。请配置支持产品参考图的生图 API。'):'';
    return `<div class="sg-actions"><button type="button" class="sg-button sg-primary" data-action="generate"${freshCount?' data-new-generation':''}${!ready||generationLocked()||imageApiUnavailable||saveFault||(!hasPending&&!freshCount)?' disabled':''}>${icon('spark')}${current().busy?'正在生成…':freshCount?'按当前方案生成新图':slots.length?'继续未完成任务':isBatch?'提交批量生成':'确认并生成'}</button>${current().busy?'<button type="button" class="sg-button" data-action="stop">停止后续生成</button>':''}${hasFailed?`<button type="button" class="sg-button" data-action="retry"${generationLocked()||imageApiUnavailable?' disabled':''}>只重试失败项</button>`:''}${slots.some(slot=>slot.item)?'<button type="button" class="sg-button" data-action="download-all">下载已完成图片</button>':''}</div>${freshCount?`<p class="sg-note" data-new-generation-note>原请求仍在等待结果。点击将按当前商品方案另生成 ${freshCount} 张新图，按新任务计费；原任务和已有图片继续保留。</p>`:''}<p class="sg-note" data-generation-concurrency>最多 100 张同时生成，超出部分排队</p>${apiReason?`<div class="sg-note" data-generation-api-required role="status"><p>${esc(apiReason)}</p><button type="button" class="sg-button sg-small" data-action="config"${locked()?' disabled':''}>配置 API</button></div>`:''}${pendingReceiptMarkup(uncertain)}`;
  }
  function renderBatch() {
    const total=draft.tasks.reduce((sum,entry)=>sum+Number(settings(entry).count),0);
    return `<div class="sg-batch"><div class="sg-header"><div><h1>批量任务</h1><p>一次创建多个商品任务，按各自方案生成。</p></div><div class="sg-actions">${commonActions()}</div></div><div data-message class="sg-message" role="status" aria-live="polite" hidden></div>${tabs()}
      <section class="sg-card"><div class="sg-card-head"><div><h2>全局批量设置</h2><p>未单独设置的商品任务会继承这些参数。</p></div><span class="sg-meta" data-save-state>本机草稿</span></div>${settingsForm(draft.settings,'global')}</section>
      ${draft.tasks.map((entry,index)=>`<article class="sg-card" data-task="${entry.id}"><div class="sg-task-header"><div class="sg-task-name"><span class="sg-number">${index+1}</span><div><h3>${esc(entry.name)}</h3><span class="sg-meta">${entry.overrides?`${esc(settings(entry).ratio)} · ${esc(settings(entry).resolution)} · ${settings(entry).count} 张`:'跟随全局'}</span></div></div><div class="sg-actions"><button type="button" class="sg-button sg-small" data-action="collapse" data-id="${entry.id}" aria-expanded="${!entry.collapsed}">${entry.collapsed?'展开':'收起'}</button><button type="button" class="sg-button sg-small sg-danger" data-action="remove-task" data-id="${entry.id}"${locked()||draft.tasks.length===1?' disabled':''}>删除</button></div></div>
      <div${entry.collapsed?' hidden':''}><div class="sg-task-content"><div>${products(entry)}</div><div>${taskFields(entry)}<button type="button" class="sg-button sg-small" style="margin-top:10px" data-action="analyze" data-id="${entry.id}"${locked()||!entry.products.length||!modelInfo.ready?' disabled':''}>${icon('spark')}AI 分析产品</button></div></div><div class="sg-override"><span>${entry.overrides?'已启用单独参数':'覆盖全局参数'}</span><button type="button" class="sg-button sg-small" data-action="override" data-id="${entry.id}"${locked()?' disabled':''}>${entry.overrides?'跟随全局':'单独设置'}</button></div>${entry.overrides?`<div class="sg-overrides">${settingsForm(settings(entry),entry.id)}</div>`:''}${entry.plan?`<section class="sg-batch-plan"><div class="sg-card-head"><h2>商品方案</h2><button type="button" class="sg-button sg-small" data-action="plan-task" data-id="${entry.id}"${locked()?' disabled':''}>重新整理</button></div>${plans(entry)}</section>`:''}${resultsMarkup(slotsFor(entry.id))}</div></article>`).join('')}
      <button type="button" class="sg-button sg-add" data-action="add-task"${locked()||draft.tasks.length>=30?' disabled':''}>${icon('plus')}新建商品任务</button>
      <footer class="sg-footer"><div><strong>${draft.tasks.length} 项商品任务 · ${total} 张图片</strong><p>生成费用由所配置服务商计收</p></div><div class="sg-actions"><button type="button" class="sg-button" data-action="plan"${locked()?' disabled':''}>整理全部方案</button>${generateActions()}</div></footer>${runSummary()}</div>`;
  }
  function render() {
    if(startupFailed||!draft)return;
    displayRenderVersion++;
    document.documentElement?.classList.toggle('sg-replica',true);
    root.innerHTML=legacyBanner()+(isBatch?renderBatch():renderSingle());renderMessage();
    bridge.setApiBusy('studio-genesis',locked());
    renderCredits();
    refreshLocalOriginals();
  }
  function renderCredits() {
    const hints=window.SZCreativeCreditHints;if(!hints||!root||!draft||!bridge)return;
    const config=typeof bridge.config==='function'?bridge.config():bridge.config||{};
    root.querySelectorAll('[data-action="analyze"]').forEach(button=>hints.chat(button,config.visionModel,'本次 1 项产品分析；整理方案为本地操作'));
    root.querySelectorAll('[data-action="write-brief"]').forEach(button=>hints.chat(button,config.visionModel,'本次 1 项产品分析并帮写要求；采用与编辑候选内容为本地操作'));
    root.querySelectorAll('[data-action="retry-slot"]').forEach(button=>{
      const record=current().tasks.find(item=>item.id===button.dataset.taskId);
      const entry=draft.tasks.find(item=>item.id===button.dataset.taskId);
      hints.image(button,record?.plan?.settings?.model||entry?.plan?.settings?.model||config.imageModel||modelInfo.model||'',[1],'本次只重新生成此图 1 张；原结果保留');
    });
    function quote(action,retry) {
      let count=0;const models=new Set();
      const freshTasks=retry?[]:newGenerationTasks();
      draft.tasks.forEach(entry=>{
        if(!entry.plan)return;
        const quantity=freshTasks.includes(entry)?entry.plan.shots.length:eligibleShots(entry,retry).length;
        if(quantity){count+=quantity;models.add(entry.plan.settings.model||config.imageModel||modelInfo.model||'');}
      });
      root.querySelectorAll(`[data-action="${action}"]`).forEach(button=>hints.image(button,models.size===1?[...models][0]:'',Array(count).fill(1),`本次 ${count} 张${retry?'失败项重试':freshTasks.length?'新图；原请求继续保留':'待生成图片'}${models.size>1?'；各商品使用不同模型，需分别报价':''}`));
    }
    quote('generate',false);quote('retry',true);
  }
  window.SZCreativeCreditHints?.register('studio-genesis',renderCredits);
  function invalidate(entry) { displayedPlanChecks.delete(entry);entry.plan=null;entry.confirmed=false; }
  async function refreshModels(refreshed) {
    if(startupFailed)return;
    modelInfo = {};
    const catalog=await bridge.listBoundApis(refreshed&&refreshed.boundApis);
    if(startupFailed)return;
    if (!catalog || !catalog.ok) throw new Error(catalog&&catalog.error||'无法读取已配置 API，请重新打开工作台。');
    if (String(catalog.accountKey) !== account) throw new Error('登录账号已变化，请重新打开工作台；原账号素材仍保留。');
    apiChoices=catalog.providers||[];
    modelInfo=bridge.modelInfo();
  }
  async function decode(file) {
    if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('请上传 PNG、JPEG 或 WebP 图片。');
    if(file.size>16*1024*1024)throw new Error('单张产品图不能超过 16 MB。');
    const image=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('图片读取失败。'));reader.readAsDataURL(file);});
    const dimensions=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve({width:img.naturalWidth,height:img.naturalHeight});img.onerror=()=>reject(new Error('图片无法解码，请重新导出后上传。'));img.src=image;});
    return {id:uid(),name:file.name||'产品图',image,bytes:file.size,...dimensions};
  }
  async function upload(id,files) {
    if(locked())throw new Error('请等待当前任务结束后更换素材。');
    if(!files.length)return;
    const sourceDraft=draft;
    uploading=true;render();
    try {
      await ensureAccount();const entry=draft.tasks.find(item=>item.id===id);
      if(!entry)throw new Error('当前商品任务已不存在，请重新选择。');
      if(entry.products.length+files.length>6)throw new Error('每个商品任务最多上传 6 张产品图。');
      if(entry.products.reduce((sum,item)=>sum+(item.bytes||0),0)+files.reduce((sum,file)=>sum+file.size,0)>16*1024*1024)throw new Error('同一商品的产品图合计不能超过 16 MB，请压缩后上传。');
      const images=await Promise.all(files.map(decode));await ensureAccount();
      if(draft!==sourceDraft||!draft.tasks.includes(entry))throw new Error('商品任务已切换，本次图片导入已停止。');
      const unique=images.filter((image,index)=>!entry.products.some(asset=>asset.image===image.image)&&!images.slice(0,index).some(asset=>asset.image===image.image));
      if(unique.length){entry.products.push(...unique);entry.analysis='';invalidate(entry);await persist();}
      message(`已添加 ${unique.length} 张产品图。${unique.length<images.length?'重复图片已跳过。':''}`);
    }
    finally { uploading=false;render(); }
  }
  function buildPlan(entry) {
    const output=engine.createPlan(entry,settings(entry),{analysis:entry.analysis||''});
    if(output.ok===false)throw new Error(`${entry.name}：${output.error}`);
    entry.plan=output;entry.confirmed=false;entry.collapsed=false;
  }
  async function analyze(entry) {
    if(locked())throw new Error('请等待当前任务结束。');
    analyzing=true;render();
    try {
      await ensureAccount();
      const result=await bridge.analyze({products:entry.products,tool:'product',requirements:entry.requirements,settings:settings(entry),purpose:'plan'});
      if(!result||result.ok===false)throw new Error(result&&result.error||'AI 分析未返回可用结果。');
      await ensureAccount();
      const facts=result.data||result.analysis||result.text||result.content||result;
      entry.analysis=typeof facts==='string'?facts:JSON.stringify(facts,null,2);
      buildPlan(entry);showPlan=true;await persist();message('产品分析已返回，请核对并编辑画面方案。');
    } finally { analyzing=false;render(); }
  }
  async function writeBrief(entry) {
    if(locked()||!entry.products.length)throw new Error('请先上传产品图，并等待当前任务结束。');
    analyzing=true;render();
    try {
      await ensureAccount();const result=await bridge.analyze({products:entry.products,tool:'product',requirements:entry.requirements,settings:settings(entry),purpose:'brief'});
      if(!result||result.ok===false)throw new Error(result&&result.error||'AI 帮写未返回可用内容。');await ensureAccount();
      const facts=result.data||result.analysis||result.text||result.content||result;
      const visible=typeof facts==='string'?facts:[facts.productName,facts.category,facts.structure,facts.material,...(facts.colors||facts.primaryColors||[]),...(facts.identityPoints||[])].filter(Boolean).join('；');
      const config=settings(entry), direction=(engine.adTemplates||[]).find(item=>item.id===config.adTemplate);
      briefCandidate=[entry.requirements,`商品可见特点：${visible.slice(0,2200)}。`,`保持原图款式、颜色、材质、轮廓和标识，商品清晰完整，采用自然光影。`,direction?`广告方向：${direction.label}。${direction.skill}`:config.mode==='detail'?'整组详情图统一配色与光线，分别展示整体外观、可见细节和使用场景。':'突出商品主体，背景简洁，画面留有呼吸感。',`面向${config.platform}，${config.language==='无文字纯视觉'?'不添加文字':'文案只使用已确认的商品资料'}。`].filter(Boolean).join('\n');
      openDialog('AI 帮写要求',`<p class="sg-note">根据产品图识别的可见特点整理，修改并采用后才进入创作要求。</p><textarea data-brief-candidate aria-label="AI 帮写候选要求">${esc(briefCandidate)}</textarea><div class="sg-actions"><button class="sg-button" data-action="close-dialog" type="button">取消</button><button class="sg-button sg-primary" data-action="apply-brief" data-id="${entry.id}" type="button">采用并继续编辑</button></div>`);
    } finally { analyzing=false;render(); }
  }
  async function saveLibrary() { await ensureAccount();draft.userModuleGroups=groups();localStorage.setItem(libraryKey(),JSON.stringify(library()));localStorage.setItem(groupKey(),JSON.stringify(draft.userModuleGroups));await persist(); }
  async function saveModule(button) {
    const modal=document.getElementById('sgDialog'), name=modal.querySelector('[data-module-name]').value.trim(), skill=modal.querySelector('[data-module-skill]').value.trim(), type=modal.querySelector('[data-module-type]').value;
    if(!name||!skill){modal.querySelector('[data-dialog-error]').textContent='请填写模块名称和 Skill。';return;}
    const existing=library().find(item=>item.id===button.dataset.moduleId);
    if(library().some(item=>item.name===name&&item.id!==button.dataset.moduleId)||(engine.mainModules||[]).concat(engine.detailModules||[]).some(item=>item.label===name)){modal.querySelector('[data-dialog-error]').textContent='该名称已存在，请使用不同的模块名称。';return;}
    const group=modal.querySelector('[data-module-group-name]').value.trim();
    if(group&&groupNameError(group)){modal.querySelector('[data-dialog-error]').textContent=groupNameError(group);return;}
    const item={id:existing?.id||uid(),name,skill,type,group,description:modal.querySelector('[data-module-description]').value.trim()};
    draft.userModules=existing?library().map(value=>value.id===existing.id?item:value):library().concat(item);
    if(existing){eachConfig(config=>{config.modules=(config.modules||[]).flatMap(value=>value===existing.name?(type===(config.imageType==='ad'?'ad':config.mode)?[name]:[]):[value]);syncModules(config);});draft.tasks.forEach(invalidate);}
    await saveLibrary();modal.hidden=true;moduleTab='mine';moduleGroup='';render();message('模块已保存，可在「我的模块」中选择。');
  }
  async function newProject() {
    busy=true;render();
    try {
      await persist();
      await ensureAccount();const key=`${account}:saved-project:${uid()}`;await dbPut(key,{draft:clone(draft),snapshot:controller.snapshot()});await ensureAccount();
      const prior=workspaceBinding,cfg=clone(draft.settings), userModules=library(), userModuleGroups=groups();draft={settings:cfg,tasks:[task(1)],userModules,userModuleGroups,previousProjectKey:key};
      if(prior.legacyBackupKey)draft.legacyBackupKey=prior.legacyBackupKey;
      const binding=createWorkspace(draft,workspaceScope,prior.storageKey,prior.legacy,prior.expectedDraftToken);binding.restoring=false;installWorkspace(binding);
      selectedResults.clear();showPlan=true;await persist();message('已新建项目，上一项目已保留，可恢复。');
    } finally { busy=false;render(); }
  }
  async function restoreProject() {
    busy=true;render();
    try {
      await persist();
      await ensureAccount();const previous=await dbGet(draft.previousProjectKey);if(!previous)throw new Error('上一项目暂不可读取。');
      validateWorkspace(previous,workspaceType(draft.settings));
      const currentKey=`${account}:saved-project:${uid()}`;await dbPut(currentKey,{draft:clone(draft),snapshot:controller.snapshot()});await ensureAccount();
      const userModuleGroups=groups();
      restoring=true;try { const result=await controller.restore(previous.snapshot);if(result.ok===false)throw new Error(result.error);draft=previous.draft;workspaceBinding.draft=draft;draft.userModuleGroups=[...new Set([...userModuleGroups,...groups()])];draft.previousProjectKey=currentKey; } finally { restoring=false; }
      selectedResults.clear();showPlan=true;await persist();message('已恢复上一项目，切换前的项目也已保留。');
    } finally { busy=false;render(); }
  }
  async function download(resultId) {
    await ensureAccount();const slot=allSlots().find(entry=>entry.item&&entry.item.resultId===resultId);
    if(!slot)throw new Error('结果图片不存在。');
    const binding=workspaceBinding,descriptor=localOriginalDescriptor(slot),url=await readLocalOriginal(slot,true)||slot.item.url;
    await ensureAccount();
    const fresh=allSlots().find(entry=>entry.item?.resultId===resultId);
    if(!localDisplayOwner(binding)||deactivating||!fresh||fresh.item.url!==slot.item.url||descriptor&&localOriginalDescriptor(fresh)?.key!==descriptor.key)throw new Error('结果所属任务已变化，请从当前结果重新下载。');
    const filename=`少壮创作/${String(slot.taskName||slot.item.productName||'商品').replace(/[\\/:*?"<>|]/g,'_')}_${String(slot.shot&&slot.shot.index||1).padStart(2,'0')}.png`;
    await new Promise((resolve,reject)=>chrome.downloads.download({url,filename,saveAs:false},()=>{const error=chrome.runtime.lastError;if(error)reject(new Error(error.message));else resolve();}));
  }
  async function action(button) {
    const name=button.dataset.action,id=button.dataset.id,entry=draft.tasks.find(item=>item.id===id);
    if(name==='legacy-tasks'){await ensureAccount();showLegacyTasks();return;}
    if(button.disabled)return;
    const submitsImage=['generate','retry','retry-slot'].includes(name);
    if((submitsImage?generationLocked():locked())&&!['stop','history','download','download-all','close-dialog','close-preview'].includes(name))return;
    if(name==='close-dialog') { document.getElementById('sgDialog').hidden=true;return; }
    if(name==='manage-groups') { groupManager();return; }
    if(name==='group-editor') { groupEditor(button.dataset.group||'');return; }
    if(name==='save-group') { await saveGroup(button);return; }
    if(name==='delete-group') { await deleteGroup(button.dataset.group);return; }
    if(name==='restore-group') { await restoreGroup();return; }
    if(name==='save-module') { await saveModule(button);return; }
    if(name==='module-editor') { moduleEditor(button.dataset.moduleId);return; }
    if(name==='module-tab') { moduleTab=button.dataset.value;render();return; }
    if(name==='manage-modules') { managingModules=!managingModules;render();return; }
    if(name==='module-mode') {
      const config=targetConfig(button.dataset.target);config.moduleMode=button.dataset.value;if(config.moduleMode==='custom')syncModules(config);changedConfig(button.dataset.target);return;
    }
    if(name==='module-count') {
      const config=targetConfig(button.dataset.target), label=button.dataset.label, quantity=moduleCount(config,label)+Number(button.dataset.delta), total=(config.modules||[]).length+Number(button.dataset.delta);
      if(quantity<1||quantity>5||total>16)return;const first=config.modules.indexOf(label);config.modules=config.modules.filter(value=>value!==label);config.modules.splice(first,0,...Array(quantity).fill(label));syncModules(config);changedConfig(button.dataset.target);return;
    }
    if(name==='ad-template') { const config=targetConfig(button.dataset.target);config.adTemplate=button.dataset.value;changedConfig(button.dataset.target);return; }
    if(name==='generation-speed') { const config=targetConfig(button.dataset.target);config.generationSpeed='standard';changedConfig(button.dataset.target);return; }
    if(name==='delete-module'||name==='restore-module') {
      if(name==='delete-module'){const item=library().find(value=>value.id===button.dataset.moduleId);if(!item)return;draft.removedModule=item;draft.userModules=library().filter(value=>value.id!==item.id);eachConfig(config=>{config.modules=(config.modules||[]).filter(value=>value!==item.name);syncModules(config);});draft.tasks.forEach(invalidate);}
      else if(draft.removedModule){draft.userModules=library().concat(draft.removedModule);draft.removedModule=null;}
      await saveLibrary();render();return;
    }
    if(name==='write-brief') { await writeBrief(entry);return; }
    if(name==='apply-brief') { entry.requirements=document.querySelector('[data-brief-candidate]').value.slice(0,6000);invalidate(entry);document.getElementById('sgDialog').hidden=true;await persist();render();return; }
    if(name==='back-input') { showPlan=false;render();root.querySelector('#sgBrief')?.focus();return; }
    if(name==='toggle-plan') { showPlan=!showPlan;render();return; }
    if(name==='new-project') { await newProject();return; }
    if(name==='restore-project') { await restoreProject();return; }
    if(name==='select-results') { const ids=allSlots().filter(slot=>slot.item).map(slot=>slot.item.resultId);selectedResults=ids.every(value=>selectedResults.has(value))?new Set():new Set(ids);render();return; }
    if(name==='download-selected') { for(const resultId of selectedResults)await download(resultId);return; }
    if(name==='edit-result') { const slot=allSlots().find(item=>item.item?.resultId===button.dataset.result);if(slot){const result=await bridge.openResultAction('edit',slot.item);if(result?.ok===false)throw new Error(result.error);}return; }
    if(name==='retry-slot') { busy=true;render();try{await persist();const result=await controller.retrySlot(button.dataset.taskId,button.dataset.shotId,draft.tasks,draft.settings);if(!result||result.ok===false)throw new Error(result&&typeof result.error==='string'&&result.error.trim()?result.error:'本次图片重试未完成，请查看此图结果。');}finally{busy=false;try{await persist();}finally{render();}}return; }
    if(name==='history') { await ensureAccount();await bridge.openHistory(button); }
    else if(name==='config') { const result=bridge.openConfig();if(result&&result.ok===false)throw new Error(result.error); }
    else if(name==='mode') {
      await switchWorkspace(button.dataset.mode);
    } else if(name==='add-task') { draft.tasks.push(task(draft.tasks.length+1));render();await persist(); }
    else if(name==='remove-task') { draft.tasks=draft.tasks.filter(item=>item.id!==id);render();await persist(); }
    else if(name==='remove-image') { entry.products.splice(Number(button.dataset.index),1);entry.analysis='';invalidate(entry);render();await persist(); }
    else if(name==='collapse') { entry.collapsed=!entry.collapsed;render();scheduleSave(); }
    else if(name==='override') { entry.overrides=entry.overrides?null:clone(draft.settings);invalidate(entry);render();await persist(); }
    else if(name==='plan'||name==='plan-task') {
      const entries=name==='plan-task'?[entry]:draft.tasks;
      // Validate the entire selection before changing any plan.
      entries.forEach(item=>{const valid=engine.validateTask(item,settings(item));if(valid.ok===false)throw new Error(`${item.name}：${valid.error}`);});
      entries.forEach(buildPlan);render();await persist();message('方案已整理，请核对后确认生成。');
    } else if(name==='analyze')await analyze(entry);
    else if(name==='generate'||name==='retry') {
      if(generationLocked())return;
      if(!draft.tasks.every(item=>item.confirmed&&item.plan))throw new Error('请先整理并确认每个商品的方案。');
      const freshTasks=name==='generate'&&button.hasAttribute('data-new-generation')?newGenerationTasks():[];
      if(button.hasAttribute('data-new-generation')&&!freshTasks.length){render();return;}
      busy=true;render();
      try { await ensureAccount();if(freshTasks.length)copyGenerationTasks(freshTasks);await persist();const selected=draft.tasks.filter(item=>eligibleShots(item,name==='retry').length);const result=await(name==='retry'?controller.retryFailed(selected,draft.settings):controller.run(selected,draft.settings));if(result&&result.ok===false)throw new Error(result.error||'任务未全部完成，请查看商品结果。'); }
      finally { busy=false;try{await persist();}finally{render();} }
    } else if(name==='stop') { controller.stop();stopQueuedSubmissions();message('已停止排队任务；当前请求返回后会保留结果。');render(); }
    else if(name==='archive') { await controller.retryArchive(button.dataset.result);await persist();render(); }
    else if(name==='download')await download(button.dataset.result);
    else if(name==='download-all') { for(const slot of allSlots().filter(item=>item.item))await download(slot.item.resultId); }
    else if(name==='close-preview') { document.getElementById('sgPreview').hidden=true; }
  }
  function change(event) {
    const element=event.target;
    if(locked())return;
    if(element.hasAttribute('data-module-group')) { moduleGroup=element.value;render();return; }
    if(element.hasAttribute('data-result-select')) { if(element.checked)selectedResults.add(element.dataset.resultSelect);else selectedResults.delete(element.dataset.resultSelect);render();return; }
    if(element.hasAttribute('data-module')||element.hasAttribute('data-module-all')) {
      const config=targetConfig(element.dataset.target), available=availableModules(config);
      let selected=(config.modules||[]).slice();
      if(element.hasAttribute('data-module-all')){const names=available.map(item=>item.label);selected=selected.filter(value=>!names.includes(value));if(element.checked)selected.push(...names.slice(0,16-selected.length));}
      else {selected=selected.filter(value=>value!==element.dataset.module);if(element.checked){if(selected.length>=16){message('最多选择 16 张图片，请先减少数量。');render();return;}selected.push(element.dataset.module);}}
      config.modules=selected;syncModules(config);changedConfig(element.dataset.target);return;
    }
    if(element.dataset.setting) {
      const entry=draft.tasks.find(item=>item.id===element.dataset.target), key=element.dataset.setting;
      const config=entry?entry.overrides:draft.settings;
      config[key]=key==='expertMode'?element.checked:key==='count'?Number(element.value):key==='modules'?element.value.split('\n').map(item=>item.trim()).filter(Boolean):element.value;
      (entry?[entry]:draft.tasks.filter(item=>!item.overrides)).forEach(invalidate);
      if(event.type==='change')render();scheduleSave();
    } else if(element.dataset.taskField) {
      const entry=draft.tasks.find(item=>item.id===element.dataset.id);entry[element.dataset.taskField]=element.value;invalidate(entry);scheduleSave();
      const generate=root.querySelector('[data-action=generate]');if(generate)generate.disabled=true;
      root.querySelectorAll('[data-confirm]').forEach(control=>{control.checked=false;control.disabled=true;});
    } else if(element.dataset.shot) {
      const entry=draft.tasks.find(item=>item.id===element.dataset.id), updated=engine.editShot(entry.plan,element.dataset.shot,{prompt:element.value});
      if(updated.ok===false){showError(new Error(updated.error));return;}entry.plan=updated;entry.confirmed=false;scheduleSave();
      const generate=root.querySelector('[data-action=generate]');if(generate)generate.disabled=true;root.querySelectorAll('[data-confirm]').forEach(control=>{control.checked=false;});
    } else if(element.dataset.confirm) { draft.tasks.find(item=>item.id===element.dataset.confirm).confirmed=element.checked;render();scheduleSave(); }
  }
  async function preview(resultId) {
    const slot=allSlots().find(item=>item.item&&item.item.resultId===resultId);if(!slot)return;
    const binding=workspaceBinding,descriptor=localOriginalDescriptor(slot),url=await readLocalOriginal(slot,true)||slot.item.url;
    const fresh=allSlots().find(entry=>entry.item?.resultId===resultId);
    if(!localDisplayOwner(binding)||!fresh||fresh.item.url!==slot.item.url||descriptor&&localOriginalDescriptor(fresh)?.key!==descriptor.key)return;
    openPreview(url,slot.shot&&slot.shot.label||'生成图片','生成图片原件',resultId);
  }
  function productPreview(element) {
    const entry=draft.tasks.find(item=>item.id===element.dataset.productPreview),asset=entry&&entry.products[Number(element.dataset.index)];
    if(asset)openPreview(asset.image,asset.name||'产品图','产品图原件');
  }
  function openPreview(image,title,alt,resultId='') {
    let modal=document.getElementById('sgPreview');
    if(!modal){modal=document.createElement('div');modal.id='sgPreview';modal.className='sg-modal';document.body.appendChild(modal);modal.addEventListener('click',event=>{if(event.target===modal||event.target.closest('[data-action=close-preview]'))modal.hidden=true;});}
    modal.dataset.localResult=resultId;
    modal.innerHTML=`<div class="sg-modal-content" role="dialog" aria-modal="true" aria-label="${esc(title)}预览"><div class="sg-card-head"><h2>${esc(title)}</h2><button type="button" class="sg-button" data-action="close-preview">关闭</button></div><img src="${esc(image)}" alt="${esc(alt)}"></div>`;modal.hidden=false;modal.querySelector('button').focus();
  }
  function bind() {
    if(bound)return;
    bound=true;
    document.addEventListener('cu-import-state',event=>{
      if(!root||!draft||!controller)return;
      const detail=event.detail||{};
      if(detail.pending&&detail.scope==='studio'){
        const entry=draft.tasks.find(item=>item.id===detail.inputKey);
        if(entry){invalidate(entry);scheduleSave();}
      }
      render();
    });
    root.addEventListener('click',event=>{
      const button=event.target.closest('[data-action]');if(button)action(button).catch(showError);
      const image=event.target.closest('[data-preview]');if(image)preview(image.dataset.preview).catch(showError);
      const product=event.target.closest('[data-product-preview]');if(product)productPreview(product);
    });
    root.addEventListener('input',event=>{if(event.target.type!=='checkbox')change(event);});
    root.addEventListener('change',event=>{
      if(event.target.dataset.files){const files=Array.from(event.target.files||[]);event.target.value='';upload(event.target.dataset.files,files).catch(showError);return;}
      if(event.target.hasAttribute('data-api')){
        if(locked())return;busy=true;
        Promise.resolve(bridge.selectBoundApi(event.target.value)).then(result=>{if(result.ok===false)throw new Error(result.error);return refreshModels();}).then(()=>{draft.settings.model=modelInfo.model;draft.tasks.forEach(invalidate);return persist();}).catch(showError).finally(()=>{busy=false;render();});return;
      }
      // Text input already updated on input; only selections and checkboxes need change handling.
      if(event.target.tagName==='SELECT'||event.target.type==='checkbox')change(event);
      else if(event.target.dataset.taskField||event.target.dataset.shot||event.target.dataset.setting)render();
    });
    root.addEventListener('dragover',event=>{const drop=event.target.closest('[data-drop]');if(drop){event.preventDefault();drop.classList.add('is-dragging');}});
    root.addEventListener('dragleave',event=>{const drop=event.target.closest('[data-drop]');if(drop)drop.classList.remove('is-dragging');});
    root.addEventListener('drop',event=>{const drop=event.target.closest('[data-drop]');if(drop){event.preventDefault();drop.classList.remove('is-dragging');upload(drop.dataset.drop,Array.from(event.dataTransfer.files||[])).catch(showError);}});
    root.addEventListener('paste',event=>{if(event.defaultPrevented)return;const files=Array.from(event.clipboardData&&event.clipboardData.items||[]).filter(item=>item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);if(!files.length)return;const block=event.target.closest('[data-task],[data-drop]');const id=block&&(block.dataset.task||block.dataset.drop)||(!isBatch&&draft.tasks[0].id);if(!id){showError(new Error('请先选中要添加产品图的商品任务。'));return;}event.preventDefault();upload(id,files).catch(showError);});
    document.addEventListener('keydown',event=>{if(event.defaultPrevented)return;const modal=[document.getElementById('sgDialog'),document.getElementById('sgPreview')].find(value=>value&&!value.hidden);if(event.key==='Escape'&&modal){event.preventDefault();event.stopImmediatePropagation();modal.hidden=true;}if((event.key==='Enter'||event.key===' ')&&event.target.matches('[data-product-preview]')){event.preventDefault();productPreview(event.target);}});
    window.addEventListener('beforeunload',event=>{if(navigationLocked()||!startupFailed&&(deactivating||saveFault)){event.preventDefault();event.returnValue='任务尚未结束或草稿尚未保存';}if(!startupFailed)persist().catch(()=>{});});
    document.addEventListener('visibilitychange',()=>{if(startupFailed)return;if(document.visibilityState==='hidden')persist().catch(()=>{});else if(!locked())refreshReceipts().then(()=>bridge.refresh()).then(refreshModels).then(()=>{render();}).catch(showError);});
    window.addEventListener('focus',()=>{refreshReceipts().catch(showError);});
    window.addEventListener('storage',event=>{if(event.key?.startsWith(`sz_studio_genesis_pending_`))refreshReceipts().catch(showError);});
    // Returning from the existing API dialog refreshes the bound account configuration.
    document.getElementById('configCancelBtn')?.addEventListener('click',()=>{if(startupFailed)return;setTimeout(()=>{if(startupFailed)return;refreshModels().then(()=>{if(!startupFailed)render();}).catch(showError);},0);});
    window.addEventListener('sz-bound-api-changed',()=>{if(startupFailed)return;refreshModels().then(()=>{if(startupFailed)return;draft.settings.model=modelInfo.model;draft.tasks.forEach(invalidate);render();scheduleSave();}).catch(showError);});
  }
  async function boot() {
    document.documentElement?.setAttribute('data-lab-startup','pending');
    document.documentElement?.setAttribute('data-studio-startup','pending');
    if(!root){root=document.createElement('section');root.id='studioGenesisRoot';document.querySelector('.app').prepend(root);}
    root.innerHTML='<div class="sg-hero"><p>正在读取创作工作台…</p></div>';
    bridge=window.SZ_CREATIVE_TOOLS_BRIDGE;engine=window.SZ_STUDIO_GENESIS;
    if(!bridge||!engine)throw new Error('创作模块未完整加载，请重新打开页面。');
    // Refresh initializes account-scoped settings for every route, including main/detail.
    const refreshed=await bridge.refresh({deferArchive:true});if(!refreshed||!refreshed.ok||!refreshed.accountKey)throw new Error(refreshed&&refreshed.error||'统一配置尚未就绪。');
    account=String(refreshed.accountKey);
    draft={settings:engine.defaults(mode),tasks:Array.from({length:isBatch?3:1},(_,i)=>task(i+1))};
    if(initialAd)Object.assign(draft.settings,{imageType:'ad',adType:'电商广告',adTemplate:engine.adTemplates[0].id});
    const loaded=await loadWorkspace(initialAd?'ad':mode,workspaceScope),saved=loaded.saved;
    installWorkspace(createWorkspace(draft,workspaceScope,loaded.storageKey,loaded.legacy,draftToken(saved)));
    if(saved&&saved.draft){
      validateWorkspace(saved,initialAd?'ad':mode);
      restoring=true;
      try { draft=clone(saved.draft);
      workspaceBinding.draft=draft;
      workspaceBinding.legacyBackupKey=draft.legacyBackupKey;
      if(saved.snapshot){const restored=await controller.restore(saved.snapshot);if(restored.ok===false)throw new Error(restored.error||'草稿任务无法安全恢复，请先核对本机历史。');}
      } finally { restoring=false; }
    }
    // Recover the exact pending images before showing controls. Unconfirmed
    // images stay protected while independent images retain their queue slots.
    if(typeof controller.recoverPendingReceipt!=='function')throw new Error('任务回执恢复模块未完整加载，请重新打开页面；核对前无法生成。');
    restoring=true;
    try {
      const recovered=await controller.recoverPendingReceipt();
      if(!recovered||recovered.ok!==true)throw new Error(recovered&&recovered.error||'任务回执无法安全恢复，请核对已有请求后重新打开工作台。');
      if(controller.state.accountKey!==account)throw new Error('登录账号已变化，请重新打开工作台；原账号素材和回执仍保留。');
    } finally { restoring=false;workspaceBinding.restoring=false; }
    try { const savedModules=JSON.parse(localStorage.getItem(libraryKey())||'null');if(Array.isArray(savedModules))draft.userModules=savedModules; } catch (_) { showError(new Error('自建模块库未能读取，当前草稿模块仍保留。')); }
    try { const savedGroups=JSON.parse(localStorage.getItem(groupKey())||'null');if(Array.isArray(savedGroups))draft.userModuleGroups=savedGroups; } catch (_) { showError(new Error('模块分组未能读取，当前草稿分组仍保留。')); }
    if(groups().length||Array.isArray(draft.userModuleGroups))draft.userModuleGroups=groups();
    bind();render();
    // Reveal only this account's restored workspace; config mutations stay locked.
    window.SZ_LAB_FIRST_PAINT?.complete();
    // Restore this account's draft before showing editable controls. API catalog
    // loading may continue after first paint, with all mutations still locked.
    try { await refreshModels(refreshed);if(!draft.settings.model)draft.settings.model=modelInfo.model||''; }
    catch(error) { showError(error); }
    finally { initializing=false;render();document.documentElement?.setAttribute('data-lab-startup','ready');document.documentElement?.setAttribute('data-studio-startup','ready'); }
  }
  const start=()=>boot().catch(error=>{
    startupFailed=true;document.documentElement?.setAttribute('data-lab-startup','error');
    document.documentElement?.setAttribute('data-studio-startup','error');
    if(root){
      root.innerHTML=`<section class="sg-card" style="margin-top:30px"><h2>创作工作台暂未就绪</h2><p class="sg-message is-error" role="alert">${esc(error.message||error)}</p><p class="sg-note">原素材、草稿和任务记录仍保留。可以重试读取，或通过左侧菜单打开其他创作入口。</p><button type="button" class="sg-button" data-action="retry-startup">重试读取工作台</button></section>`;
      root.onclick=event=>{if(!event.target.closest('[data-action="retry-startup"]'))return;root.onclick=null;startupFailed=false;initializing=true;restoring=false;notice='';noticeError=false;start();};
    }
    window.SZ_LAB_FIRST_PAINT?.complete('error');
    // First-paint completion can clear a previous timeout marker. Restore the
    // host's failure signal, while retaining the existing reload screen for
    // missing scripts or styles that an in-place draft retry cannot repair.
    if(document.documentElement?.dataset.labFirstPaintFailure==='fatal'||document.documentElement?.dataset.labStyles==='error')document.documentElement?.setAttribute('data-studio-startup','resource-error');
    document.documentElement?.setAttribute('data-lab-startup','error');
  });
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();

;
/* Frozen source: public/creative/labs/image-prompt-lab/scene-extension-ui.js */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SZ_SCENE_EXTENSION_UI = api;
  if (root && root.document) root.document.addEventListener('DOMContentLoaded', function () { api.mount(root); });
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var shotLabels = { macro: '微观', near: '近观', wide: '远观', ultrawide: '超远观' };
  function countSummary(value, selected) {
    var count = Number(value);
    var kinds = Object.keys(shotLabels).filter(function (kind) { return (selected || []).indexOf(kind) >= 0; });
    var counts = { macro: 0, near: 0, wide: 0, ultrawide: 0 };
    if (!Number.isInteger(count) || count < 1 || count > 20) return { ok: false, counts: counts, message: '总生成数量请填写 1–20 的整数。' };
    if (!kinds.length) return { ok: false, counts: counts, message: '请至少选择一个景别。' };
    if (count < kinds.length) return { ok: false, counts: counts, message: '总数量少于已选景别数量，请增加数量或减少景别后再生成计划。' };
    for (var index = 0; index < count; index++) counts[kinds[index % kinds.length]]++;
    return { ok: true, counts: counts, message: '共 ' + count + ' 张：' + kinds.map(function (kind) { return shotLabels[kind] + ' ' + counts[kind] + ' 张'; }).join(' · ') + '。同一景别的图片会使用不同角度。' };
  }
  function outputDimensions(ratio, resolution) {
    var sizes = { '1:1': [1024, 1024], '3:4': [768, 1024], '16:9': [1792, 1024], '9:16': [1024, 1792], '21:9': [2048, 878] };
    var scale = { '1K': 1, '2K': 2, '4K': 4 }[resolution];
    var size = sizes[ratio];
    return size && scale ? { width: size[0] * scale, height: size[1] * scale } : null;
  }

  // Keep data/blob originals inside the page, like the existing history viewer.
  // A top-level link to a generated data URL is blocked by Chrome.
  function createComparison(root) {
    var doc = root.document;
    var el = function (id) { return doc.getElementById(id); };
    var modal = el('sceneCompareModal'), closeButton = el('sceneCompareClose');
    var previousFocus = null, resolveCurrentFocus = null;
    function close() {
      if (!modal || modal.hidden) return;
      modal.hidden = true;
      ['sceneCompareOriginal', 'sceneCompareResult'].forEach(function (id) { el(id).removeAttribute('src'); });
      if (doc.body) doc.body.classList.remove('scene-compare-open');
      var previous = previousFocus;
      if ((!previous || previous.isConnected === false) && resolveCurrentFocus) previous = resolveCurrentFocus();
      previousFocus = null; resolveCurrentFocus = null;
      try { if (previous && previous.isConnected !== false && previous.focus) previous.focus(); } catch (_) {}
    }
    function open(slot, trigger, resolveTrigger) {
      if (!modal || !slot || !slot.item || !slot.original || !slot.item.url) return false;
      previousFocus = trigger || doc.activeElement;
      resolveCurrentFocus = resolveTrigger || null;
      el('sceneCompareTitle').textContent = slot.item.productName + ' · ' + slot.shot.label;
      modal.hidden = false;
      [['sceneCompareOriginal', 'sceneCompareOriginalState', slot.original, '产品原图'], ['sceneCompareResult', 'sceneCompareResultState', slot.item.url, '生成结果']].forEach(function (entry) {
        var image = el(entry[0]), status = el(entry[1]);
        status.hidden = false; status.textContent = '正在载入' + entry[3] + '…';
        image.onload = function () { status.hidden = true; };
        image.onerror = function () { if (!modal.hidden) { status.hidden = false; status.textContent = entry[3] + '暂时无法载入，请关闭后重试或从本机历史查看。'; } };
        image.alt = entry[3] + '：' + slot.item.productName;
        image.src = entry[2];
      });
      if (doc.body) doc.body.classList.add('scene-compare-open');
      closeButton.focus();
      return true;
    }
    if (modal && closeButton) {
      closeButton.addEventListener('click', close);
      modal.addEventListener('click', function (event) { if (event.target === modal) close(); });
      doc.addEventListener('keydown', function (event) {
        if (modal.hidden) return;
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        // The close action is the only interactive control inside this viewer.
        if (event.key === 'Tab') { event.preventDefault(); closeButton.focus(); }
      });
      doc.addEventListener('scene-extension-route-change', close);
    }
    return { open: open, close: close };
  }

  function create(deps) {
    var model = { plan: null, slots: [], previousResults: [], busy: false, stopped: false, uncertain: null, message: '', kind: '', jobId: '', batchId: '', ownerKey: '', ready: false };
    var running = null;
    var archiveFlights = new WeakMap();
    function changed() { if (deps.onChange) deps.onChange(model); }
    function report(message, kind) { model.message = message; model.kind = kind || ''; changed(); }
    function error(code, message) { var e = new Error(message); e.code = code; return e; }
    function clone(value) { return JSON.parse(JSON.stringify(value)); }
    function freeze(value) { if (value && typeof value === 'object') { Object.keys(value).forEach(function (key) { freeze(value[key]); }); Object.freeze(value); } return value; }
    async function account() {
      if (typeof deps.ready !== 'function' || typeof deps.getAccountKey !== 'function') throw error('SCENE_ACCOUNT_NOT_READY', '账号与配置尚未就绪，请重新打开创作页。');
      var readiness = await deps.ready();
      if (!readiness || !readiness.ok) throw error('SCENE_ACCOUNT_NOT_READY', readiness && readiness.error || '账号与配置尚未就绪。');
      var key = await deps.getAccountKey();
      if (typeof key !== 'string' || !key.trim()) throw error('SCENE_ACCOUNT_NOT_READY', '请先登录并等待账号配置加载。');
      return key;
    }
    async function syncAccount() {
      var owner = await account();
      var pending = deps.journal ? await deps.journal.read(owner) : null;
      if (pending && pending.ownerKey !== owner) throw error('SCENE_JOURNAL_OWNER_INVALID', '任务回执账号不一致，请核对后再继续。');
      if (model.ownerKey !== owner || !model.ready || pending || model.uncertain) {
        model.ownerKey = owner; model.ready = true;
        model.uncertain = pending ? Object.assign({}, pending, { ownerKey: owner }) : null;
        if (model.uncertain) report('此账号上次任务回执尚未确认。请先核对供应商任务和历史，再继续，避免重复提交。', 'uncertain');
        else changed();
      }
      return owner;
    }
    var initialization = syncAccount().catch(function (e) { model.ready = false; report(e.message, 'error'); return ''; });
    function invalidate() {
      if (model.busy) return;
      model.plan = null;
      report(model.uncertain ? '上次任务回执尚未确认，请先核对。' : '产品或场景已变化，请重新生成延展计划。', model.uncertain ? 'uncertain' : '');
    }
    function buildPlan() {
      if (model.busy) return { ok: false, error: '正在生成，请等待或停止后续生成。' };
      var plan = deps.contract.createPlan(deps.readInput());
      if (!plan.ok) { model.plan = null; report(plan.error, 'error'); return plan; }
      if (!model.plan || model.plan.signature !== plan.signature) {
        model.previousResults = model.previousResults.concat(model.slots.filter(function (slot) { return !!slot.item; }));
        model.slots = plan.shots.map(function (shot) { return { shot: shot, status: 'ready', item: null }; });
        model.batchId = 'scene_' + Date.now() + '_' + Math.random().toString(16).slice(2);
      }
      model.plan = freeze(clone(plan));
      var distribution = countSummary(plan.shots.length, plan.shots.map(function (shot) { return shot.kind; }));
      report('延展计划已就绪：' + plan.images.length + ' 张产品原图，' + distribution.message + '确认后点击“按计划生成”。');
      return plan;
    }
    async function storePending(receipt) {
      if (!deps.journal || !deps.journal.write || !deps.journal.read || !deps.journal.clear) throw error('SCENE_JOURNAL_REQUIRED', '无法保存任务回执，尚未提交生图。');
      await deps.journal.write(receipt, receipt.ownerKey);
    }
    async function clearPending(owner, jobId) {
      var pending = deps.journal && await deps.journal.read(owner);
      // A completed older result must never clear another request's receipt.
      if (pending && (!jobId || pending.jobId === jobId)) await deps.journal.clear(owner);
      if (model.ownerKey === owner && model.uncertain && (!jobId || model.uncertain.jobId === jobId)) model.uncertain = null;
    }
    async function resolveUncertain() {
      if (model.busy) return { ok: false };
      try {
        var owner = await syncAccount();
        if (!model.uncertain) return { ok: true };
        if (model.uncertain.ownerKey !== owner) throw error('SCENE_ACCOUNT_CHANGED', '账号已变化，请回到原账号核对任务。');
        await clearPending(owner, model.uncertain.jobId);
        model.slots.forEach(function (slot) { if (slot.status === 'uncertain') slot.status = 'failed'; });
        report('已记录你对上一任务的核对。成功图片会保留，继续时只生成尚未成功的画面。');
        return { ok: true };
      } catch (e) { report('任务回执状态未能保存：' + e.message, 'error'); return { ok: false }; }
    }
    function stop() {
      if (!model.busy) return Promise.resolve({ ok: true });
      model.stopped = true;
      report('已停止排队；正在请求取消当前任务，返回的成功图片仍会保存。');
      return model.jobId ? Promise.resolve(deps.send('CANCEL_GENERATION', { jobId: model.jobId })).catch(function (e) { report('取消回执未确认：' + e.message + '。成功返回仍会保存。', 'uncertain'); return { ok: false, stateUncertain: true }; }) : Promise.resolve({ ok: true });
    }
    function saveSlot(slot, retry) {
      if (archiveFlights.has(slot)) return archiveFlights.get(slot);
      var context = Object.assign({ surfaceMode: 'viral' }, slot.archiveContext, { accountKey: slot.ownerKey });
      slot.archiveSaving = true; slot.archiveError = '';
      var pending = Promise.resolve().then(function () {
        return deps.archive(slot.item, context);
      }).then(async function (saved) {
        slot.archiveOk = !!(saved && saved.ok);
        slot.archiveError = slot.archiveOk ? '' : (saved && saved.error || '历史尚未保存成功');
        if (slot.archiveOk) await clearPending(slot.ownerKey, slot.item.jobId);
        if (retry) report(slot.archiveOk ? '已补存历史。' : '保存未完成，请重试保存或先下载原图。', slot.archiveOk ? '' : 'error');
        return saved || { ok: false, error: slot.archiveError };
      }).catch(function (e) {
        slot.archiveOk = false; slot.archiveError = e.message || String(e);
        if (retry) report('保存未完成，请重试保存或先下载原图。', 'error');
        return { ok: false, error: slot.archiveError };
      }).finally(function () { slot.archiveSaving = false; archiveFlights.delete(slot); changed(); });
      archiveFlights.set(slot, pending); changed(); return pending;
    }
    function retryArchive(slot) {
      if (!slot || !slot.item || model.slots.concat(model.previousResults).indexOf(slot) < 0) return Promise.resolve({ ok: false, code: 'SCENE_ARCHIVE_RESULT_MISSING' });
      if (archiveFlights.has(slot)) return archiveFlights.get(slot);
      if (slot.archiveOk) return Promise.resolve({ ok: true, skipped: true });
      return saveSlot(slot, true);
    }
    function generate() {
      if (running) return running;
      model.busy = true; model.stopped = false; changed();
      running = Promise.resolve().then(async function () {
        await initialization;
        var owner = await syncAccount();
        if (model.uncertain) { report('此账号上一任务回执未确认，请先核对任务状态，避免重复提交。', 'uncertain'); return { ok: false, uncertain: true }; }
        if (typeof deps.withGenerationLock !== 'function') throw error('SCENE_LOCK_REQUIRED', '浏览器无法安全锁定生成任务，请使用支持 Web Locks 的浏览器。');
        var fresh = deps.contract.createPlan(deps.readInput());
        if (!fresh.ok || !model.plan || fresh.signature !== model.plan.signature) {
          model.plan = null; throw error('SCENE_PLAN_STALE', fresh.error || '产品或场景已变化，请重新生成计划。');
        }
        var plan = freeze(clone(model.plan));
        var config = freeze(clone(deps.config()));
        var archiveContext = Object.assign({}, deps.archiveContext ? deps.archiveContext() : {}, { accountKey: owner });
        var batchId = model.batchId;
        return deps.withGenerationLock(owner, async function () {
          if (await account() !== owner) throw error('SCENE_ACCOUNT_CHANGED', '账号已变化，尚未提交生图，请重新确认。');
          for (var index = 0; index < model.slots.length; index++) {
            if (model.stopped || model.uncertain) break;
            var slot = model.slots[index];
            if (slot.item) continue;
            if (await account() !== owner) { model.stopped = true; report('账号已变化，后续任务未提交；已返回图片按原账号保存。', 'error'); break; }
            var payload = deps.contract.createPayload(plan, slot.shot.id);
            var jobId = deps.newJobId();
            var message = { jobId: jobId, config: config, payload: Object.assign({}, payload, { _jobId: jobId, batchId: batchId }) };
            var budget = deps.contract.checkPayloadBudget(Object.assign({ type: 'GENERATE_IMAGE' }, message));
            if (!budget.ok) throw error(budget.code, budget.error);
            var receipt = { ownerKey: owner, jobId: jobId, signature: plan.signature, shotId: slot.shot.id, batchId: batchId, status: 'pending', createdAt: Date.now() };
            try { await storePending(receipt); }
            catch (e) { model.stopped = true; slot.status = 'failed'; report('无法保存任务回执，尚未提交生图，请检查浏览器存储。', 'error'); break; }
            // The fresh profile read is the last asynchronous step before POST.
            if (await account() !== owner || model.stopped) { await clearPending(owner, jobId); model.stopped = true; report('账号或任务状态已变化，当前图片尚未提交。', 'error'); break; }
            model.jobId = jobId;
            if (deps.register) deps.register(jobId);
            slot.status = 'generating';
            report('正在生成 ' + (index + 1) + '/' + model.slots.length + ' · ' + slot.shot.label + '，产品原图已随请求提交。');
            var response;
            try { response = await deps.send('GENERATE_IMAGE', message); }
            catch (e) { response = { ok: false, transport: true, error: e.message || String(e) }; }
            if (deps.unregister) deps.unregister(jobId);
            model.jobId = '';
            var url = response && response.ok && Array.isArray(response.images) && response.images.filter(function (image) { return typeof image === 'string' && /^(?:https?:\/\/|data:image\/|blob:)/i.test(image); })[0];
            if (url) {
              var item = {
                url: url, resultId: jobId + ':scene:' + slot.shot.id, jobId: jobId, taskId: response.taskId || '', batchId: batchId,
                creativeRoute: 'scene-extension', archiveSurfaceMode: 'viral', labMode: 'detail', detailMode: 'reference',
                generationRoute: 'scene-extension', referenceMode: 'scene-extension', promptSource: 'scene-extension',
                productName: plan.config.materialName, skuId: plan.config.sku || '', businessBatchTitle: '场景延展 · ' + plan.config.materialName,
                businessRoleName: slot.shot.label, businessSummary: plan.config.scene, variant: 'scene-' + slot.shot.id, variantName: slot.shot.label,
                detailScreenIndex: index + 1, detailScreenTotal: plan.shots.length, sceneShotId: slot.shot.id,
                sceneShotKind: slot.shot.kind, sceneAngleIndex: slot.shot.angleIndex, sceneAngleLabel: slot.shot.angleLabel,
                scenePlanSignature: plan.signature, sceneExtensionContractVersion: deps.contract.version,
                ratio: plan.config.ratio, resolution: plan.config.resolution, prompt: payload.prompt, negativePrompt: payload.negativePrompt,
                productImages: payload.productImages.slice(), productImageEvidence: payload.productImageEvidence,
                sceneMaterialReview: 'pending', createdAt: Date.now()
              };
              slot.item = item; slot.status = 'done'; slot.original = plan.images[0].image;
              slot.ownerKey = owner; slot.archiveContext = archiveContext;
              var returned = Object.assign({}, receipt, { status: 'returned', result: { url: url, resultId: item.resultId, taskId: item.taskId } });
              try { await storePending(returned); } catch (_) { returned = receipt; }
              await saveSlot(slot, false);
              if (!slot.archiveOk) {
                model.uncertain = returned;
                report('图片已返回，历史保存失败；请先重试保存。此回执保留，刷新后不会自动重复提交。', 'uncertain');
              }
            } else {
              slot.error = response && response.error || '没有收到可用图片';
              var code = String(response && response.code || '');
              var rejected = /^(?:SCENE_|FORMAL_|REFERENCE_ROUTE_|INVALID_|MISSING_|CONFIG_|ACCOUNT_|BOUND_|MODEL_)/.test(code) || response && response.definitiveFailure === true;
              if (rejected && !(response && (response.transport || response.stateUncertain))) { slot.status = 'failed'; await clearPending(owner, jobId); }
              else { slot.status = 'uncertain'; model.uncertain = receipt; }
              report(slot.shot.label + '：' + slot.error + (model.uncertain ? '。回执未确认，已暂停后续请求，请核对后再继续。' : '。已停止后续生成。'), model.uncertain ? 'uncertain' : 'error');
              model.stopped = true;
            }
            changed();
          }
          var completed = model.slots.filter(function (slot) { return !!slot.item; }).length;
          if (!model.uncertain && !model.stopped) report('已生成 ' + completed + '/' + model.slots.length + ' 张。请逐张对照原图核对款式、颜色、纹理与光泽。');
          else if (!model.uncertain && model.stopped && !model.slots.some(function (slot) { return slot.status === 'failed'; })) report('已停止后续生成，保留 ' + completed + ' 张成功图片。');
          return { ok: completed === model.slots.length && !model.uncertain, completed: completed, uncertain: !!model.uncertain };
        });
      }).catch(async function (e) {
        // A failure after journaling (profile read, registration, archive or
        // receipt clear) must not let the next click overwrite that receipt.
        try {
          var pending = model.ownerKey && deps.journal && await deps.journal.read(model.ownerKey);
          if (pending) model.uncertain = Object.assign({}, pending, { ownerKey: model.ownerKey });
        } catch (_) {
          if (model.ownerKey) model.uncertain = model.uncertain || { ownerKey: model.ownerKey, unreadable: true };
        }
        report('场景延展未完成：' + (e.message || String(e)), model.uncertain ? 'uncertain' : 'error');
        return { ok: false, code: e.code || 'SCENE_EXECUTION_FAILED', uncertain: !!model.uncertain };
      }).finally(function () {
        try { if (model.jobId && deps.unregister) deps.unregister(model.jobId); } catch (_) {}
        model.jobId = ''; model.busy = false; running = null; changed();
      });
      return running;
    }
    return { state: model, ready: function () { return initialization; }, syncAccount: syncAccount, buildPlan: buildPlan, invalidate: invalidate, generate: generate, stop: stop, retryArchive: retryArchive, resolveUncertain: resolveUncertain, report: report };
  }

  function mount(root) {
    var doc = root.document;
    var el = function (id) { return doc.getElementById(id); };
    if (!el('sceneMaterialPanel')) return;
    if (!doc.body || !doc.body.classList.contains('viral-lab-mode')) return;
    if (root.SZ_SCENE_EXTENSION_CONTROLLER) return root.SZ_SCENE_EXTENSION_CONTROLLER;
    var bridge = root.SZ_SCENE_EXTENSION_BRIDGE;
    if (!bridge || !root.SZ_SCENE_EXTENSION_CONTRACT) { el('sceneState').textContent = '场景延展组件未完整加载，请刷新测试版。'; return; }
    var images = {}, uploadEpoch = {}, reading = 0;
    var roles = { front: 'Front', detail: 'Detail', section: 'Section', angle: 'Angle' };
    var names = { materialName: 'sceneMaterialName', category: 'sceneCategory', displayNotes: 'sceneDisplayNotes', styleTone: 'sceneStyleTone', count: 'sceneCount', sku: 'sceneSku', dimensions: 'sceneDimensions', colorNotes: 'sceneColorNotes', textureNotes: 'sceneTextureNotes', finishNotes: 'sceneFinishNotes', scene: 'sceneSpace', installation: 'sceneInstallation', lighting: 'sceneLighting', ratio: 'sceneRatio', resolution: 'sceneResolution' };
    function readInput() {
      var config = {};
      Object.keys(names).forEach(function (name) { config[name] = el(names[name]).value; });
      config.count = Number(config.count);
      config.sameMaterialConfirmed = el('sceneSameMaterial').checked;
      config.shots = Object.keys(shotLabels).filter(function (shot) { return el('sceneShot' + shot[0].toUpperCase() + shot.slice(1)).checked; });
      return { config: config, images: Object.keys(roles).filter(function (role) { return !!images[role]; }).map(function (role) { return { role: role, image: images[role] }; }) };
    }
    function node(tag, className, text) { var n = doc.createElement(tag); if (className) n.className = className; if (text) n.textContent = text; return n; }
    var comparison = createComparison(root), comparisonTriggers = new Map();
    var lastPlan = '', lastResults = '';
    function render(model) {
      model.uploadReading = reading;
      var active = doc.body.classList.contains('viral-lab-mode') && doc.body.classList.contains('scene-extension-route');
      var importing = root.SZ_IMAGE_UPLOAD && root.SZ_IMAGE_UPLOAD.isImporting();
      model.importReading = Boolean(importing);
      if (typeof bridge.setApiBusy === 'function') bridge.setApiBusy('scene-extension', model.busy || active && (Boolean(model.uncertain) || reading > 0 || importing));
      var distribution = countSummary(el('sceneCount').value, readInput().config.shots);
      var dimensions = outputDimensions(el('sceneRatio').value, el('sceneResolution').value);
      el('sceneOutputSize').textContent = dimensions ? '当前输出尺寸：' + dimensions.width + ' × ' + dimensions.height + ' px · 与风格焕新使用相同输出规格' : '请选择画面比例和清晰度。';
      el('sceneCountSummary').textContent = distribution.message;
      el('sceneCountSummary').dataset.kind = distribution.ok ? '' : 'error';
      Object.keys(shotLabels).forEach(function (kind) { el('sceneShot' + kind[0].toUpperCase() + kind.slice(1) + 'Count').textContent = distribution.counts[kind] + ' 张'; });
      el('sceneMaterialFields').disabled = model.busy;
      el('sceneConfigFields').disabled = model.busy;
      el('scenePlanBtn').disabled = model.busy || reading > 0 || importing || !distribution.ok;
      el('sceneGenerateBtn').disabled = !model.ready || model.busy || reading > 0 || importing || !distribution.ok || !model.plan || !!model.uncertain || model.slots.length > 0 && model.slots.every(function (slot) { return !!slot.item; });
      var remaining = model.slots.filter(function (slot) { return !slot.item; }).length;
      el('sceneGenerateBtn').textContent = model.busy ? '正在延展…' : '按计划生成' + (remaining ? ' ' + remaining + ' 张' : '');
      if(root.SZCreativeCreditHints){
        var creditConfig=typeof bridge.config==='function'?bridge.config():bridge.config||{};
        root.SZCreativeCreditHints.local(el('scenePlanBtn'),'整理延展计划，不调用模型');
        root.SZCreativeCreditHints.image(el('sceneGenerateBtn'),creditConfig.imageModel||'',model.plan?Array(remaining).fill(1):null,'按已确认计划的剩余张数计算；多角度原图不增加输出张数');
      }
      el('sceneStopBtn').hidden = !model.busy;
      el('sceneStopBtn').disabled = model.stopped;
      el('sceneResolveBtn').hidden = !model.uncertain || model.busy;
      el('sceneState').textContent = model.message || '上传产品正面图，填写产品名称，然后生成延展计划。';
      el('sceneState').dataset.kind = model.uncertain ? 'uncertain' : model.kind;
      var planKey = model.plan && model.plan.signature || '';
      if (lastPlan !== planKey) {
        lastPlan = planKey; el('scenePlanGrid').replaceChildren();
        if (model.plan) model.plan.shots.forEach(function (shot) {
          var card = node('article', 'scene-plan-card'); card.appendChild(node('h3', '', shot.label));
          card.appendChild(node('p', 'scene-note', model.plan.config.materialName + ' · ' + model.plan.images.length + ' 张原图共同约束 · ' + model.plan.config.ratio + ' / ' + model.plan.config.resolution));
          var details = node('details'); details.appendChild(node('summary', '', '查看本张画面要求')); details.appendChild(node('pre', '', shot.prompt)); card.appendChild(details); el('scenePlanGrid').appendChild(card);
        });
      }
      var visibleSlots = model.previousResults.concat(model.slots);
      var resultsKey = visibleSlots.map(function (slot) { return [slot.shot.id, slot.status, slot.item && slot.item.resultId, slot.archiveOk, slot.archiveSaving].join(':'); }).join('|');
      if (resultsKey === lastResults) return;
      lastResults = resultsKey; el('sceneResultGrid').replaceChildren(); comparisonTriggers.clear();
      el('sceneEmptyResults').hidden = visibleSlots.some(function (slot) { return !!slot.item; });
      visibleSlots.forEach(function (slot) {
        if (!slot.item) return;
        var card = node('article', 'scene-result-card'); card.appendChild(node('h3', '', slot.shot.label));
        var compare = node('button', 'scene-compare-thumbnails'); compare.type = 'button';
        compare.setAttribute('aria-label', '放大左右对比：' + slot.item.productName + ' · ' + slot.shot.label);
        [[slot.original, '产品原图'], [slot.item.url, '生成结果']].forEach(function (entry) {
          var side = node('span', 'scene-compare-thumb');
          side.appendChild(node('span', 'scene-compare-label', entry[1]));
          var img = node('img'); img.src = entry[0]; img.alt = entry[1] + '：' + slot.item.productName;
          side.appendChild(img); compare.appendChild(side);
        });
        compare.addEventListener('click', function () { comparison.open(slot, compare, function () { return (comparisonTriggers.get(slot.item.resultId) || {}).thumbnail; }); });
        card.appendChild(compare);
        card.appendChild(node('p', 'scene-note', '左侧产品原图 · 右侧生成结果，点击放大对比。'));
        card.appendChild(node('p', 'scene-result-status', slot.archiveSaving ? '正在保存到本机历史…' : (slot.archiveOk ? '已存本机历史 · 永久档案状态见下方 · 材质待核对' : '图片已返回，本机历史尚未保存成功，请重试保存或先下载保留。')));
        var review = node('label', 'scene-review'); var check = node('input'); check.type = 'checkbox'; check.checked = slot.item.sceneMaterialReview === 'user-reviewed'; review.appendChild(check); review.appendChild(node('span', '', '我已对照原图核对款式、颜色、纹理和光泽')); check.addEventListener('change', function () { slot.item.sceneMaterialReview = check.checked ? 'user-reviewed' : 'pending'; }); card.appendChild(review);
        var actions = node('div', 'scene-result-actions');
        if (!slot.archiveOk) {
          var retry = node('button', 'btn ghost', slot.archiveSaving ? '正在保存…' : '重试保存');
          retry.type = 'button'; retry.disabled = !!slot.archiveSaving;
          retry.addEventListener('click', function () { controller.retryArchive(slot); });
          actions.appendChild(retry);
        }
        var open = node('button', 'btn ghost', '放大对比'); open.type = 'button';
        open.addEventListener('click', function () { comparison.open(slot, open, function () { return (comparisonTriggers.get(slot.item.resultId) || {}).action; }); }); actions.appendChild(open);
        comparisonTriggers.set(slot.item.resultId, { thumbnail: compare, action: open });
        var download = node('button', 'btn ghost', '下载图片'); download.type = 'button'; download.addEventListener('click', async function () {
          download.disabled = true;
          var safeName = slot.item.productName.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 70);
          var extMatch = /^data:image\/(png|jpeg|webp)/i.exec(slot.item.url) || /\.(png|jpe?g|webp)(?:[?#]|$)/i.exec(slot.item.url);
          var extension = extMatch ? '.' + extMatch[1].toLowerCase().replace('jpeg', 'jpg') : '';
          try { var response = await bridge.send('DOWNLOAD_ALL', { items: [{ url: slot.item.url, filename: '少壮AI/场景延展/' + safeName + '-' + slot.shot.id + '-' + slot.item.createdAt + extension }] }); if (!response || !response.ok) controller.report(response && response.error || '下载未完成，请稍后重试或从本机历史下载。', 'error'); }
          catch (error) { controller.report('下载未完成：' + error.message, 'error'); } finally { download.disabled = false; }
        }); actions.appendChild(download); card.appendChild(actions); el('sceneResultGrid').appendChild(card);
      });
    }
    function journalKey(owner) { return 'sz_scene_extension_web_pending_v1:' + encodeURIComponent(owner); }
    var controller = create({ contract: root.SZ_SCENE_EXTENSION_CONTRACT, readInput: readInput, send: bridge.send, config: bridge.config,
      ready: bridge.ready, getAccountKey: bridge.getAccountKey, withGenerationLock: bridge.withGenerationLock,
      archive: bridge.archive, archiveContext: bridge.archiveContext, newJobId: bridge.newJobId, register: bridge.registerGenerationJob, unregister: bridge.unregisterGenerationJob,
      journal: { read: function (owner) { return JSON.parse(root.sessionStorage.getItem(journalKey(owner)) || 'null'); }, write: function (receipt, owner) { root.sessionStorage.setItem(journalKey(owner), JSON.stringify(receipt)); }, clear: function (owner) { root.sessionStorage.removeItem(journalKey(owner)); } }, onChange: render });
    root.SZ_SCENE_EXTENSION_CONTROLLER = controller;
    function drawImage(role) { var preview = el('scene' + roles[role] + 'Preview'); preview.replaceChildren(); if (images[role]) { var img = node('img'); img.src = images[role]; img.alt = '产品原图 ' + role; preview.appendChild(img); } else preview.textContent = '粘贴或拖入图片'; }
    function fileData(file) { return new Promise(function (resolve, reject) { var reader = new root.FileReader(); reader.onload = function () { resolve(reader.result); }; reader.onerror = function () { reject(new Error('读取图片失败')); }; reader.readAsDataURL(file); }); }
    async function normalizeFile(file) {
      if (!file || !/^image\/(?:jpeg|png|webp)$/.test(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片。');
      if (file.size > 20 * 1024 * 1024) throw new Error('单张图片请控制在 20 MB 内。');
      var data = await fileData(file);
      var image = new root.Image();
      await new Promise(function (resolve, reject) { image.onload = resolve; image.onerror = function () { reject(new Error('图片无法解码')); }; image.src = data; });
      async function preserve(result) {
        if (root.SZ_IMAGE_UPLOAD) await root.SZ_IMAGE_UPLOAD.retainOriginal(file, result);
        return result;
      }
      var target = 4 * 1024 * 1024;
      if (Math.max(image.width, image.height) <= 2400 && data.length <= target) return preserve(data);
      var scale = Math.min(1, 2400 / Math.max(image.width, image.height));
      var canvas = doc.createElement('canvas');
      // PNG retains transparency; resize only as much as the encoded budget needs.
      for (var attempt = 0; attempt < 8; attempt++) {
        canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        data = canvas.toDataURL(file.type, Math.max(.74, .94 - attempt * .04));
        if (data.length <= target) return preserve(data);
        scale *= .8;
      }
      if (data.length > target) throw new Error('图片像素数据较大，请压缩后再上传；每张目标不超过 4 MB。');
      return preserve(data);
    }
    async function upload(role, file) {
      if (controller.state.busy || !file) return;
      var epoch = uploadEpoch[role] = (uploadEpoch[role] || 0) + 1;
      reading++; controller.invalidate(); render(controller.state);
      try {
        var data = await normalizeFile(file);
        if (uploadEpoch[role] !== epoch) return;
        var total = Object.keys(images).reduce(function (bytes, key) { return bytes + (key === role ? 0 : images[key].length); }, data.length);
        if (total > root.SZ_SCENE_EXTENSION_CONTRACT.maxImageBytes) throw new Error('产品原图合计超过 16 MB，请减少或压缩后上传。');
        images[role] = data; el('sceneSameMaterial').checked = false; drawImage(role); controller.invalidate();
      } catch (error) { if (uploadEpoch[role] === epoch) controller.report(error.message, 'error'); }
      finally { reading--; render(controller.state); }
    }
    Object.keys(roles).forEach(function (role) {
      var prefix = 'scene' + roles[role], preview = el(prefix + 'Preview');
      el(prefix + 'File').addEventListener('change', function (event) { upload(role, event.target.files[0]); event.target.value = ''; });
      el(prefix + 'Clear').addEventListener('click', function () { if (controller.state.busy) return; uploadEpoch[role] = (uploadEpoch[role] || 0) + 1; delete images[role]; el('sceneSameMaterial').checked = false; drawImage(role); controller.invalidate(); });
      preview.addEventListener('paste', function (event) { var file = Array.from(event.clipboardData && event.clipboardData.files || []).find(function (file) { return /^image\//.test(file.type); }); if (file) { event.preventDefault(); upload(role, file); } });
      preview.addEventListener('dragover', function (event) { event.preventDefault(); preview.classList.add('dragging'); });
      preview.addEventListener('dragleave', function () { preview.classList.remove('dragging'); });
      preview.addEventListener('drop', function (event) { event.preventDefault(); preview.classList.remove('dragging'); upload(role, event.dataTransfer.files[0]); });
    });
    ['sceneMaterialFields', 'sceneConfigFields'].forEach(function (id) { el(id).addEventListener('input', function (event) { if (event.target.type !== 'file') controller.invalidate(); }); });
    el('scenePlanBtn').addEventListener('click', function () { if (!reading) controller.buildPlan(); });
    el('sceneGenerateBtn').addEventListener('click', controller.generate);
    el('sceneStopBtn').addEventListener('click', controller.stop);
    el('sceneResolveBtn').addEventListener('click', controller.resolveUncertain);
    doc.addEventListener('cu-import-state', function (event) { if (event.detail.scope !== 'scene') return; if (event.detail.pending) controller.invalidate(); render(controller.state); });
    doc.addEventListener('scene-extension-route-change', function () { render(controller.state); });
    root.addEventListener('beforeunload', function (event) { if (controller.state.busy) { event.preventDefault(); event.returnValue = ''; } });
    render(controller.state);
    return controller;
  }
  return { create: create, mount: mount, countSummary: countSummary, outputDimensions: outputDimensions, createComparison: createComparison };
});

;
/* Frozen source: public/creative/labs/image-prompt-lab/studio-legacy-layout.js */
/* Presentation only: retain the legacy form nodes, listeners, and route gates. */
(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  if (params.get('layout') !== '1' || params.get('studio') === '1') return;
  const mode = params.get('mode');
  const surface = mode === 'sku' ? 'sku' : mode === 'viral' ? 'viral'
    : mode === 'detail' && params.get('detailMode') === 'reference' ? 'reference'
    : mode === 'main' && params.get('source') === 'web' ? 'main' : '';
  if (!surface) return;

  const paths = {
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m4 18 5-5 4 3 4-6 4 5"/>',
    layers: '<path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 17l10 5 10-5"/>',
    spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
    scan: '<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3M7 8h10M7 12h10M7 16h6"/>',
    history: '<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v5l3 2"/>',
    settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>',
    book: '<path d="M12 7v14M3 3h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3Z"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>'
  };
  const steps = {
    main: ['输入清单', '生成提示词', '确认设置', '生成中', '查看结果'],
    reference: ['输入', '分析结构', '确认规划', '批量生成', '查看结果'],
    sku: ['输入', '检查任务', '确认设置', '生成中', '查看结果'],
    viral: ['输入', '分析', '确认规划', '生成中', '查看结果']
  };
  const decorate = (element, name) => {
    if (!element) return;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.image}</svg>`;
    element.setAttribute('data-sl-icon', name);
    element.style.setProperty('--sl-icon', `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
  };

  function start() {
    const app = document.querySelector('.app');
    const hero = app && app.querySelector('.hero');
    if (!app || !hero || document.getElementById('studioLegacySteps')) return;
    document.documentElement.classList.add('studio-legacy-layout');
    app.classList.add('sl-workspace', `sl-${surface}`);
    hero.classList.add('sl-hero');
    const progress = document.createElement('ol');
    progress.id = 'studioLegacySteps';
    progress.className = 'sl-steps';
    progress.setAttribute('aria-label', '创作步骤');
    // Only the new decorative progress element receives markup. No form is rebuilt.
    progress.innerHTML = steps[surface].map((label, index) => `<li${index ? '' : ' class="is-active"'}><b>${index + 1}</b><div><small>STEP 0${index + 1}</small><span>${label}</span></div></li>`).join('');
    hero.after(progress);
    decorate(document.getElementById('labHeroEyebrow'), surface === 'reference' ? 'scan' : surface === 'sku' ? 'layers' : surface === 'main' ? 'image' : 'spark');

    const icons = {
      openArchiveBtn: 'history', openKnowledgeBtn: 'book', loadSampleBtn: 'spark', openConfigBtn: 'settings',
      referenceSourceTitle: 'image', detailSubjectTitle: 'image', detailPromptStepTitle: 'spark',
      referenceDetailWorkbenchTitle: 'scan', referenceDetailBatchTitle: 'layers',
      referenceDetailBatchResultsTitle: 'image', generationTitle: 'settings', resultsTitle: 'image',
      archivePanelTitle: 'history', referenceDetailBuildBtn: 'spark', referenceDetailApproveBtn: 'check',
      analyzeBtn: 'scan', buildPromptBtn: 'spark', batchLinksBtn: 'layers',
      loadStoredLinksBtn: 'upload', linkTableTemplateBtn: 'download', copyAllPromptBtn: 'copy',
      linkNumberGenerateBtn: 'layers', mainStitchBtn: 'layers',
      referenceDetailBatchAddTargetBtn: 'plus', referenceDetailBatchStartBtn: 'spark',
      detailRefGenerateBtn: 'spark', generateBtn: 'spark', skuGenerateBtn: 'spark',
      downloadAllBtn: 'download', skuDownloadAllBtn: 'download', copyDetailPromptBtn: 'copy'
    };
    Object.entries(icons).forEach(([id, name]) => decorate(document.getElementById(id), name));
    if (surface === 'main') {
      const promptPanel = document.getElementById('cnPrompt')?.closest('.panel');
      if (promptPanel) promptPanel.classList.add('sl-main-prompts');
    }
    app.querySelectorAll('.sku-step-head > div > strong').forEach((heading, index) => decorate(heading, ['image', 'layers', 'settings', 'image'][index]));
    app.querySelectorAll('.detail-empty-icon').forEach(element => {
      // This element is decorative only; the actual inputs and result hosts stay intact.
      element.setAttribute('aria-hidden', 'true');
      decorate(element, 'spark');
      element.classList.add('sl-empty-icon');
    });

    // Show which part is being edited without asserting provider progress or completion.
    app.addEventListener('focusin', event => {
      const target = event.target;
      if (!target || !target.closest) return;
      let index = 0;
      if (surface === 'main') {
        if (target.closest('.results-shell, #resultGrid')) index = 4;
        else if (target.closest('.generation-actions')) index = 3;
        else if (target.closest('#generationPanel')) index = 2;
        else if (target.closest('.link-prompt-actions, .sl-main-prompts, #promptErrorPanel, #analyzeBtn')) index = 1;
      } else if (target.closest('.sku-result-step, #referenceDetailBatchResults, .results-shell, #resultGrid')) index = 4;
      else if (target.closest('.sku-generate-step, #generationPanel, #referenceDetailBatchPanel')) index = 3;
      else if (target.closest('#detailPromptStep, .reference-detail-editor-column')) index = 2;
      else if (target.closest('#referenceDetailModuleList, #skuTaskList')) index = 1;
      progress.querySelectorAll('li').forEach((item, number) => item.classList.toggle('is-active', number === index));
    });
    if (typeof window !== 'undefined' && window.SZ_LAB_STARTUP) window.SZ_LAB_STARTUP.ready();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();

;
/* Frozen source: public/creative/labs/image-prompt-lab/viral-workflow-layout.js */
/* Presentation only. Dedicated routes retain their original controls and gates. */
(() => {
  'use strict';
  const routes = {
    case: ['referenceSourcePanel', 'detailPromptStep', 'generationPanel'],
    'style-refresh': ['detailSubjectStep', 'styleRefreshPanel', 'generationPanel'],
    'scene-extension': ['sceneMaterialPanel', 'sceneConfigPanel', 'sceneResultsPanel']
  };
  const icons = {
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
    settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m4 18 5-5 4 3 4-6 4 5"/>'
  };

  function start() {
    const body = document.body;
    const route = body && body.getAttribute('data-viral-workflow');
    if (!body || !body.classList.contains('viral-dedicated-workspace') || !Object.hasOwn(routes, route)) return;
    const app = document.querySelector('.app');
    const hero = app && app.querySelector('.hero');
    if (!app || !hero || document.getElementById('viralWorkflowSteps')) return;
    app.classList.add('vw-workspace');
    if (route === 'style-refresh') {
      const style = document.getElementById('styleRefreshPanel');
      const plan = document.getElementById('detailPromptStep');
      // Legacy markup/runtime ordering differs across releases. Reorder only
      // the whole sibling section, preserving every control and its parents.
      if (style && plan && style.parentNode === app && plan.parentNode === app) app.insertBefore(style, plan);
    }

    const progress = document.createElement('ol');
    progress.id = 'viralWorkflowSteps';
    progress.className = 'vw-steps';
    progress.setAttribute('aria-label', '创作流程');
    ['上传素材', '创作设置 / 计划', '生成 / 结果'].forEach((label, index) => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      const number = document.createElement('b');
      const text = document.createElement('span');
      const icon = ['upload', 'settings', 'image'][index];
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[icon]}</svg>`;
      item.style.setProperty('--vw-icon', `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
      link.setAttribute('href', '#' + routes[route][index]);
      number.textContent = '0' + (index + 1);
      text.textContent = label;
      link.appendChild(number); link.appendChild(text); item.appendChild(link); progress.appendChild(item);
    });
    hero.after(progress);

    const sections = route === 'scene-extension'
      ? { sceneMaterialPanel: '01 · 上传素材', sceneConfigPanel: '02 · 创作设置 / 计划', sceneResultsPanel: '03 · 生成 / 结果' }
      : { referenceSourcePanel: '01 · 上传素材', detailSubjectStep: '01 · 上传素材', styleRefreshPanel: '02 · 创作设置 / 计划', detailPromptStep: '02 · 创作设置 / 计划', generationPanel: '03 · 生成 / 结果' };
    Object.entries(sections).forEach(([id, label]) => {
      const section = document.getElementById(id);
      if (section) section.setAttribute('data-vw-stage', label);
    });

    // Only optional containers acquire a new parent. Their form controls keep
    // their original parents, IDs, listeners, values and fieldset ancestry.
    function fold(element, label) {
      if (!element || !element.parentNode || element.closest('.vw-optional')) return;
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      details.className = 'vw-optional';
      summary.textContent = label;
      element.parentNode.insertBefore(details, element);
      details.appendChild(summary); details.appendChild(element);
      const sync = () => { details.hidden = element.hidden || element.getAttribute('aria-hidden') === 'true'; };
      sync();
      if (typeof MutationObserver === 'function') {
        new MutationObserver(sync).observe(element, { attributes: true, attributeFilter: ['hidden', 'aria-hidden'] });
      }
    }
    const byId = (id, label) => fold(document.getElementById(id), label);
    const one = (selector, label) => fold(app.querySelector(selector), label);
    function foldGroup(elements, label, kind, gridClass) {
      const originals = elements.filter(Boolean);
      const parent = originals[0] && originals[0].parentNode;
      if (!parent || originals.some(element => element.parentNode !== parent || element.closest('.vw-optional'))) return;
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      const content = document.createElement('div');
      details.className = 'vw-optional vw-extra-' + kind;
      summary.textContent = label;
      content.className = gridClass;
      parent.insertBefore(details, originals[0]);
      details.appendChild(summary); details.appendChild(content);
      originals.forEach(element => content.appendChild(element));
      const sync = () => { details.hidden = originals.every(element => element.hidden || element.getAttribute('aria-hidden') === 'true'); };
      sync();
      if (typeof MutationObserver === 'function') {
        const observer = new MutationObserver(sync);
        originals.forEach(element => observer.observe(element, { attributes: true, attributeFilter: ['hidden', 'aria-hidden'] }));
      }
    }
    if (route === 'scene-extension') {
      ['sceneMaterialPanel', 'sceneConfigPanel', 'sceneResultsPanel'].forEach(id => {
        const section = document.getElementById(id);
        fold(section && section.querySelector('.scene-heading > div > p'), '查看说明');
      });
      one('#sceneMaterialPanel > .scene-note', '图片要求');
      one('#sceneConfigPanel > .scene-note', '生成与保真说明');
      foldGroup(['sceneDetailPreview', 'sceneSectionPreview', 'sceneAnglePreview'].map(id => {
        const preview = document.getElementById(id);
        return preview && preview.closest('.scene-material-card');
      }), '补充角度（可选）', 'angles', 'vw-angle-grid');
      foldGroup(['sceneSku', 'sceneDimensions', 'sceneColorNotes', 'sceneTextureNotes', 'sceneFinishNotes', 'sceneDisplayNotes'].map(id => {
        const input = document.getElementById(id);
        return input && input.closest('label');
      }), '产品细节（可选）', 'fields', 'vw-field-grid');
    } else {
      byId('detailSubjectSubtitle', '素材要求');
      byId('detailPromptStepSubtitle', '计划说明');
      byId('detailGenerationRoute', '生成说明');
      one('#detailPromptStep > .detail-shell > .detail-config > .detail-text-grid', '补充商品信息（可选）');
      if (route === 'case') {
        byId('referenceSourceSubtitle', '参考图要求');
        byId('viralDerivativeBlueprint', '案例学习规则');
        byId('referenceLearningNote', '素材使用说明');
      } else {
        one('.style-refresh-operation-guide', '操作说明');
      }
    }

    // If validation or an existing handler focuses an optional field, make it
    // reachable without submitting, resetting or changing any business state.
    const reveal = event => {
      const target = event.target;
      const details = target && target.closest && target.closest('.vw-optional');
      if (details) details.open = true;
    };
    app.addEventListener('focusin', reveal);
    app.addEventListener('invalid', reveal, true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();

;
/* Frozen source: public/creative/labs/image-prompt-lab/viral-workflow-bridge.js */
/* Same-origin navigation guard for the three dedicated viral workflow frames. */
(function (root) {
  'use strict';
  var params = new URLSearchParams(root.location.search);
  var routes = ['case', 'style-refresh', 'scene-extension'];
  if (params.get('workflow') !== '1' || params.get('mode') !== 'viral' || params.get('source') !== 'web' || params.get('layout') !== '1' || params.get('studio') === '1' || routes.indexOf(params.get('creativeRoute')) < 0) return;
  if (root.SanjieViralWorkflowBridge) return;

  var sends = 0, uploads = 0, activation = null;
  function wrap(target, name, category) {
    if (!target || typeof target[name] !== 'function') return;
    var original = target[name];
    target[name] = function () {
      if (category === 'send') sends++; else uploads++;
      var result;
      function finish() { if (category === 'send') sends--; else uploads--; }
      try { result = original.apply(this, arguments); }
      catch (error) { finish(); throw error; }
      return Promise.resolve(result).then(function (value) { finish(); return value; }, function (error) { finish(); throw error; });
    };
  }
  // Classic-script global bindings read the wrapped function too. Controllers
  // which captured a sender earlier are covered by their full workflow state.
  wrap(root, 'send', 'send');
  wrap(root, 'fileToOptimizedDataUrl', 'upload');
  if (root.SZ_IMAGE_UPLOAD) wrap(root.SZ_IMAGE_UPLOAD, 'retainOriginal', 'upload');

  function blocked(reason) { return { allowed: false, reason: reason }; }
  function status(ignoreActivation) {
    var state = root.state || {};
    if (!ignoreActivation && activation) return blocked('正在刷新当前账号配置，请稍候。');
    if (sends) return blocked('当前工作台还有请求未完成，请等待完成或先停止任务。');
    if (uploads || root.SZ_IMAGE_UPLOAD && typeof root.SZ_IMAGE_UPLOAD.isImporting === 'function' && root.SZ_IMAGE_UPLOAD.isImporting()) return blocked('素材正在读取或导入，请等待完成后切换。');
    if (state.activeJobId || state.activeJobIds && Object.keys(state.activeJobIds).length) return blocked('图片任务正在运行，请等待完成或先停止。');
    var run = state.styleRefresh && state.styleRefresh.run;
    if (run && ['generating', 'qa', 'qa-retry'].indexOf(run.phase) >= 0) return blocked('风格焕新正在生成或检查，请等待完成或先停止。');
    var scene = root.SZ_SCENE_EXTENSION_CONTROLLER && root.SZ_SCENE_EXTENSION_CONTROLLER.state;
    if (scene && scene.busy) return blocked('场景延展正在生成，请等待完成或先停止。');
    if (scene && (Number(scene.uploadReading) > 0 || scene.importReading)) return blocked('场景素材正在读取或导入，请等待完成后切换。');
    return { allowed: true, reason: '' };
  }
  function canDeactivate() {
    try { return status(false); }
    catch (_) { return blocked('暂时无法确认任务状态，请稍候重试。'); }
  }
  function owner() {
    var key = root.state && root.state.archiveAccountKey;
    return typeof key === 'string' && key && key !== 'local' ? key : '';
  }
  function activate() {
    if (activation) return activation;
    var idle = canDeactivate();
    if (!idle.allowed) return Promise.resolve({ ok: false, code: 'WORKFLOW_BUSY', error: idle.reason });
    var capturedOwner = owner();
    if (!capturedOwner || typeof root.send !== 'function' || typeof root.applyCfg !== 'function') return Promise.resolve({ ok: false, code: 'WORKFLOW_NOT_READY', error: '账号配置尚未就绪，请等待加载完成。' });
    activation = Promise.resolve().then(function () {
      // Refresh only saved API fields. No imports, planning, generation, history
      // writes or route changes are performed when a cached frame is activated.
      return root.send('GET_CONFIG_PROFILE', { provider: '' });
    }).then(function (profile) {
      if (!profile || !profile.ok || profile.accountKey !== capturedOwner || owner() !== capturedOwner || !profile.config || typeof profile.config !== 'object' || Array.isArray(profile.config)) {
        return { ok: false, code: 'WORKFLOW_ACCOUNT_CHANGED', error: profile && profile.error || '登录账号已变化，请刷新工作台后继续；原账号草稿仍保留。' };
      }
      var stillIdle = status(true);
      if (!stillIdle.allowed) return { ok: false, code: 'WORKFLOW_BUSY', error: stillIdle.reason };
      root.applyCfg(profile.config);
      return { ok: true, accountKey: capturedOwner };
    }).catch(function (error) {
      return { ok: false, code: 'WORKFLOW_REFRESH_FAILED', error: error && error.message || String(error) };
    }).finally(function () { activation = null; });
    return activation;
  }
  root.SanjieViralWorkflowBridge = Object.freeze({ canDeactivate: canDeactivate, activate: activate });
})(typeof globalThis !== 'undefined' ? globalThis : window);
