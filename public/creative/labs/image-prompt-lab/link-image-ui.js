/* Account-owned link workspaces. Imports never claim legacy plugin storage or global asset caches. */
(() => {
  'use strict';
  if (new URLSearchParams(location.search).get('mode') !== 'link-image') return;
  const MODES = { main: '主图', detail: '详情' };
  const MODULES = {
    main: ['商品主视觉', '核心卖点', '使用场景', '细节证据', '购买理由', '多角度展示', '规格说明', '组合展示'],
    detail: ['首屏价值', '核心卖点', '场景需求', '产品优势', '细节展示', '材质工艺', '使用方法', '规格说明', '适用场景', '决策收口']
  };
  const env = window.__SANJIE_ENVIRONMENT ? ':' + encodeURIComponent(String(window.__SANJIE_ENVIRONMENT)) : '';
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
  // Clone containers without concatenating immutable image strings into JSON.
  function copy(value, seen = new Map()) {
    if (value == null || typeof value !== 'object') return typeof value === 'number' && !Number.isFinite(value) ? null : value;
    if (seen.has(value)) return seen.get(value);
    const next = Array.isArray(value) ? [] : {}; seen.set(value, next);
    if (Array.isArray(value)) for (const item of value) next.push(item === undefined || typeof item === 'function' || typeof item === 'symbol' ? null : copy(item, seen));
    else for (const key of Object.keys(value)) if (value[key] !== undefined && typeof value[key] !== 'function' && typeof value[key] !== 'symbol') Object.defineProperty(next, key, { value: copy(value[key], seen), enumerable: true, writable: true, configurable: true });
    return next;
  }
  const STORAGE_FORMAT = 'LINK_IMAGE_DRAFT_STORAGE_V2';
  function storageError() { return new Error('链接草稿的图片引用或归属无法安全读取，原记录仍保留。'); }
  function checkRecordIdentity(value, bundleId) {
    if (!value || value.accountKey !== account || value.bundleId !== bundleId || !value.revision || typeof value.savedAt !== 'string') throw storageError();
    if (Object.hasOwn(value, 'storageFormat') ? value.storageFormat !== STORAGE_FORMAT : value.schema !== 1) throw storageError();
  }
  function encodeRecord(owner) {
    checkRecordIdentity(owner, owner.bundleId);
    const images = [], imageIds = new Map(), ancestors = new Set();
    let count = 0;
    const visit = (value, depth) => {
      if (++count > 2000000 || depth > 512) throw storageError();
      if (typeof value === 'string' && value.startsWith('data:image/')) {
        if (!imageIds.has(value)) { imageIds.set(value, images.length); images.push(value); }
        return { type: 'image', index: imageIds.get(value) };
      }
      if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
      if (!value || typeof value !== 'object' || ancestors.has(value)) throw storageError();
      ancestors.add(value);
      const next = Array.isArray(value) ? { type: 'array', items: value.map(item => visit(item, depth + 1)) } : { type: 'object', entries: Object.keys(value).map(key => [key, visit(value[key], depth + 1)]) };
      ancestors.delete(value); return next;
    };
    return { storageFormat: STORAGE_FORMAT, accountKey: owner.accountKey, bundleId: owner.bundleId, revision: owner.revision, savedAt: owner.savedAt, images, value: visit(owner, 0) };
  }
  function decodeRecord(record, key) {
    if (record == null || !key.startsWith(`${account}:bundle:`)) return record;
    const bundleId = key.slice(`${account}:bundle:`.length);
    checkRecordIdentity(record, bundleId);
    if (!Object.hasOwn(record, 'storageFormat')) return record;
    const keysAre = (value, keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    if (!keysAre(record, ['storageFormat', 'accountKey', 'bundleId', 'revision', 'savedAt', 'images', 'value']) || !Array.isArray(record.images) || record.images.some(image => typeof image !== 'string' || !image.startsWith('data:image/'))) throw storageError();
    let count = 0;
    const visit = (node, depth) => {
      if (++count > 2000000 || depth > 512) throw storageError();
      if (node === null || typeof node === 'string' || typeof node === 'boolean' || typeof node === 'number' && Number.isFinite(node)) return node;
      if (!node || typeof node !== 'object' || Array.isArray(node)) throw storageError();
      if (node.type === 'image' && keysAre(node, ['type', 'index']) && Number.isSafeInteger(node.index) && node.index >= 0 && node.index < record.images.length) return record.images[node.index];
      if (node.type === 'array' && keysAre(node, ['type', 'items']) && Array.isArray(node.items)) return node.items.map(item => visit(item, depth + 1));
      if (node.type === 'object' && keysAre(node, ['type', 'entries']) && Array.isArray(node.entries)) {
        const value = {}, names = new Set();
        for (const entry of node.entries) {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || names.has(entry[0])) throw storageError();
          names.add(entry[0]); Object.defineProperty(value, entry[0], { value: visit(entry[1], depth + 1), enumerable: true, writable: true, configurable: true });
        }
        return value;
      }
      throw storageError();
    };
    const owner = visit(record.value, 0);
    checkRecordIdentity(owner, bundleId);
    if (owner.schema !== 1 || Object.hasOwn(owner, 'storageFormat') || owner.revision !== record.revision || owner.savedAt !== record.savedAt) throw storageError();
    return owner;
  }
  const uid = () => crypto.randomUUID();
  const $ = id => document.getElementById(id);
  const imageOf = item => item && (item.image || item.dataUrl || item.url || item.imageUrl) || '';
  let root, bridge, importer, contract, account, database, workspace;
  let starting = true, startupFailed = false, importing = false, uploading = false, deactivating = false, modelBusy = false, selectingApi = false, syncing = false, reviewing = false;
  let reviewScope = 'selected';
  // View state stays separate from the account-owned draft and generation queue.
  // Removing mounted cards must never remove a link, receipt or generated asset.
  const LIST_PAGE_SIZE = 20, REVIEW_PAGE_SIZE = 5, workspaceViews = new WeakMap();
  function workspaceView(owner = workspace) {
    if (!owner) return null;
    if (!workspaceViews.has(owner)) workspaceViews.set(owner, { listPage: 0, listCollapsed: false, reviewPage: 0, reviewCollapsed: false, parked: false });
    return workspaceViews.get(owner);
  }
  function pageOf(items, page, size) {
    const pages = Math.max(1, Math.ceil(items.length / size)), current = Math.max(0, Math.min(pages - 1, page));
    return { items: items.slice(current * size, (current + 1) * size), page: current, pages, start: items.length ? current * size + 1 : 0, end: Math.min(items.length, (current + 1) * size), total: items.length };
  }
  function pagerMarkup(kind, page) {
    if (page.total <= (kind === 'list' ? LIST_PAGE_SIZE : REVIEW_PAGE_SIZE)) return '';
    return `<nav class="li-pagination" aria-label="${kind === 'list' ? '链接清单' : '图片方案'}分页"><button type="button" class="li-button" data-li-action="${kind}-page" data-page="${page.page - 1}"${page.page ? '' : ' disabled'}>上一页</button><span role="status">${page.start}–${page.end} / ${page.total} 条</span><button type="button" class="li-button" data-li-action="${kind}-page" data-page="${page.page + 1}"${page.page + 1 < page.pages ? '' : ' disabled'}>下一页</button></nav>`;
  }
  function reviewLinks() { return !workspace ? [] : reviewScope === 'all' ? workspace.links : workspace.links.filter(link => workspace.selected.includes(link.linkId)); }
  function reviewPage() { const view = workspaceView(), page = pageOf(reviewLinks(), view.reviewPage, REVIEW_PAGE_SIZE); view.reviewPage = page.page; return page; }
  function renderLinkList() {
    const target = $('liLinkRows'), footer = $('liLinkPages'), view = workspaceView(); if (!target || !view) return;
    const page = pageOf(workspace.links, view.listPage, LIST_PAGE_SIZE); view.listPage = page.page;
    target.innerHTML = view.listCollapsed ? '<p class="li-empty-note">链接清单已隐藏，选择和任务保持不变。</p>' : page.items.map(row => `<div class="li-link-row${row === selectedLink() ? ' is-active' : ''}"><input type="checkbox" data-li-select="${esc(row.linkId)}" aria-label="选择 ${esc(row.linkId)}"${workspace.selected.includes(row.linkId) ? ' checked' : ''}><button type="button" data-li-action="select-link" data-id="${esc(row.linkId)}"><strong>${esc(row.linkId)}</strong><span>${esc(row.row['链接定位'] || row.row['详情页定位'] || row.row['主推关键词'])}</span><small data-li-link-state="${esc(row.linkId)}"></small></button></div>`).join('');
    if (footer) footer.innerHTML = view.listCollapsed ? '' : pagerMarkup('list', page);
    const toggle = $('liToggleLinks'); if (toggle) { toggle.textContent = view.listCollapsed ? '显示清单' : '隐藏清单'; toggle.setAttribute('aria-expanded', String(!view.listCollapsed)); }
  }
  function renderKeepingImport() {
    const raw = $('liImportRaw')?.value, category = $('liCategory')?.value;
    render(); if (raw != null) $('liImportRaw').value = raw; if (category != null) $('liCategory').value = category;
  }
  let info = {}, apis = [], message = '', messageError = false, messageEntry = '', messageVersion = 0, noticeVersion = 0, queue = Promise.resolve();
  const taskNotices = new Map();
  const workspaces = new Map(), controllers = new Map(), sending = new Map(), running = new Set(), preparing = new Set(), saveTimers = new Map(), runEpochs = new Map();
  const defaults = mode => ({ mode, count: mode === 'main' ? 5 : 10, ratio: mode === 'main' ? '1:1' : '3:4', resolution: '2K', quality: 'auto', speed: 'standard', language: '中文', platform: '淘宝', modules: MODULES[mode].slice(0, mode === 'main' ? 5 : 10), requirements: '', provider: '', model: '' });
  const recordKey = bundleId => `${account}:bundle:${bundleId}`;
  const entryKey = (owner, linkId, mode) => `${owner.bundleId}:${linkId}:${mode}`;
  const selectedLink = () => workspace?.links.find(link => link.linkId === workspace.activeLinkId);
  const entryFor = (link = selectedLink(), mode = workspace?.activeMode || 'main', owner = workspace) => owner && link ? controllers.get(entryKey(owner, link.linkId, mode)) : null;
  const slotsFor = entry => (entry?.controller.state.slots || []).concat((entry?.controller.state.previousResults || []).filter(slot => slot.item));
  const inFlight = entry => !!(entry && (preparing.has(entry.key) || running.has(entry.key) || entry.controller.state.busy || entry.controller.state.awaitingReceipt || entry.controller.hasInFlightRequest?.() || sending.get(entry.key) || slotsFor(entry).some(slot => slot.archiveSaving)));
  const active = except => [...controllers.values()].some(entry => entry !== except && inFlight(entry));
  const mutationBusy = () => starting || importing || uploading || deactivating || modelBusy || selectingApi || syncing || reviewing;
  const linkLocked = link => mutationBusy() || ['main', 'detail'].some(mode => { const entry = entryFor(link, mode); return inFlight(entry) || !!entry?.controller.state.uncertain; });
  const entryLocked = entry => mutationBusy() || inFlight(entry) || !!entry?.controller.state.uncertain;
  const selectedEntries = (owner = workspace, mode = owner?.activeMode || 'main') => owner ? owner.links.filter(link => owner.selected.includes(link.linkId)).map(link => entryFor(link, mode, owner)) : [];
  const plannedFilename = (linkId, mode, index) => `${linkId}-${mode}-${index}.png`.replace(/[\\/:*?"<>|]/g, '_');
  function samePlain(left, right) {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left); return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && samePlain(left[key], right[key]));
  }
  function sourceUnchanged(entry, plan) {
    if (!plan || bindingError(entry.link)) return false;
    const link = entry.link, input = plan.input;
    const row = Object.fromEntries(contract.rowFields.map(key => {
      const value = link.row[key];
      if (key === '链接编号') { const match = typeof value === 'string' && value.trim().match(/^L\s*0*(\d+)$/i), number = match && Number(match[1]); return [key, Number.isSafeInteger(number) && number > 0 ? 'L' + String(number).padStart(3, '0') : '']; }
      return [key, value == null ? '' : typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : value];
    }));
    if (!samePlain(contract.normalizeConfig(link.outputs[entry.mode].config), plan.config) || input.bundleId !== entry.owner.bundleId || input.category !== entry.owner.imported.category || input.mode !== entry.mode || !samePlain(input.link, row) || !samePlain(input.marketingPlan, link.task?.marketingPlan || null) || input.subjectTaskId !== (link.task?.subjectTaskId || '') || !samePlain(input.subjectRequirement, link.task?.subjectRequirement || null) || !samePlain(input.bindingOverride, link.bindingOverride || null)) return false;
    return ['products', 'models'].every(kind => plan.images[kind].length === link[kind].length && link[kind].every((asset, index) => {
      const saved = plan.images[kind][index], role = kind === 'products' ? 'product' : 'model', id = typeof asset.id === 'string' ? asset.id.trim() : '', name = typeof asset.name === 'string' ? asset.name.trim() : '';
      return saved.id === (id || role + '-' + (index + 1)) && saved.name === (name || (kind === 'products' ? '产品图 ' : '模特图 ') + (index + 1)) && saved.image === (asset.image || asset.dataUrl || '');
    }));
  }
  function reviewMatches(owner = workspace, mode = owner?.activeMode || 'main') {
    const saved = owner?.reviewConfirmation, entries = selectedEntries(owner, mode);
    return !!(saved && saved.mode === mode && entries.length && Array.isArray(saved.links) && saved.links.length === entries.length && entries.every((entry, index) => entry?.controller.state.plan && saved.links[index]?.id === entry.link.linkId && saved.links[index]?.signature === entry.controller.state.plan.signature && entry.link.outputs[mode].confirmedSignature === entry.controller.state.plan.signature && sourceUnchanged(entry, entry.controller.state.plan)));
  }
  function invalidateReview(link, mode, owner = workspace) {
    const saved = owner?.reviewConfirmation;
    if (saved && (!mode || saved.mode === mode) && saved.links?.some(item => item.id === link.linkId)) delete owner.reviewConfirmation;
  }
  function notify(value, error = false) { message = value?.message || String(value || ''); messageError = error; messageEntry = entryFor()?.key || ''; messageVersion = ++noticeVersion; renderStatus(); }
  function fail(error) { notify(error, true); }
  function beginTaskNotice(entry) {
    const state = entry.controller.state;
    taskNotices.set(entry.key, { version: ++noticeVersion, signature: state.plan?.signature, message: '正在提交已确认的方案…', error: false, reported: false, controllerMessage: state.message, controllerKind: state.kind });
  }
  function updateTaskNotice(entry) {
    const notice = taskNotices.get(entry.key), state = entry.controller.state;
    // The original receipt can settle after runEntry returns. Keep its notice
    // version so that a later user notice still takes precedence.
    if (notice && notice.signature === state.plan?.signature && (notice.controllerMessage !== state.message || notice.controllerKind !== state.kind)) {
      notice.controllerMessage = state.message; notice.controllerKind = state.kind;
      notice.message = state.message; notice.error = state.kind === 'error' || state.kind === 'uncertain'; notice.reported = true;
    }
  }
  function visibleTaskNotice(entry) {
    if (!entry) return null;
    const state = entry.controller.state, current = taskNotices.get(entry.key);
    if (current && current.signature === state.plan?.signature) return { ...current, message: `${entry.link.linkId} · ${MODES[entry.mode]}：${current.message}` };
    const slots = state.slots || [], completed = slots.filter(slot => slot.item && slot.status === 'done').length, failed = slots.filter(slot => slot.status === 'failed').length;
    const text = state.uncertain ? '原请求回执待核对，请先核对原任务结果。' : inFlight(entry) ? state.message || '正在处理当前任务…' : completed || failed ? `已生成 ${completed}/${slots.length} 张${failed ? `，失败 ${failed} 张` : ''}。` : '';
    return text ? { version: 0, message: `${entry.link.linkId} · ${MODES[entry.mode]}：${text}`, error: !!state.uncertain || failed > 0 } : null;
  }
  async function ensureAccount() {
    const current = String(await bridge.getAccountKey());
    if (!account || current !== account) throw new Error('登录账号已变化，已停止当前操作；原账号清单、素材和任务仍保留。');
  }
  function revision(value) { return value == null ? 'missing' : typeof value.revision === 'string' && value.revision ? value.revision : (() => { throw new Error('保存的清单缺少版本，原记录未改动。'); })(); }
  async function openDB() {
    if (database) return database;
    database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('sz_link_image_workspaces_v1' + env, 1);
      let expired = false;
      const timer = setTimeout(() => { expired = true; reject(new Error('清单草稿库打开超时，请重新读取。')); }, 15000);
      request.onupgradeneeded = () => { if (expired) { request.transaction?.abort(); return; } request.result.createObjectStore('drafts'); };
      request.onsuccess = () => { clearTimeout(timer); if (expired) request.result.close(); else resolve(request.result); };
      request.onerror = () => { clearTimeout(timer); reject(request.error || new Error('清单草稿库无法打开。')); };
    });
    return database;
  }
  async function transaction(mode, operation) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      let tx, result, settled = false;
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(result); };
      const timer = setTimeout(() => { try { tx?.abort(); } catch (_) {} if (database === db) database = null; db.close(); finish(new Error('清单草稿读写超时，原记录仍保留。')); }, 15000);
      try {
        tx = db.transaction('drafts', mode);
        tx.oncomplete = () => finish();
        tx.onerror = tx.onabort = () => finish(tx.error || new Error('清单草稿事务未完成。'));
        operation(tx.objectStore('drafts'), value => { result = value; }, error => { finish(error); try { tx.abort(); } catch (_) {} });
      } catch (error) { finish(error); }
    });
  }
  const dbGet = key => transaction('readonly', (store, done, reject) => { const request = store.get(key); request.onsuccess = () => { try { done(decodeRecord(request.result, key)); } catch (error) { reject(error); } }; request.onerror = () => reject(request.error); });
  async function saveRecord(owner, value, refresh) {
    const next = { ...value, revision: uid(), savedAt: new Date().toISOString() };
    await transaction('readwrite', (store, done, reject) => {
      const request = store.get(recordKey(owner.bundleId));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        try {
          if (request.result != null) decodeRecord(request.result, recordKey(owner.bundleId));
          if (revision(request.result) !== owner.revision) throw new Error('另一页面已更新这份清单，当前页面已停止保存和生成。请重新读取最新草稿；当前素材与原回执仍保留。');
          const indexRequest = store.get(`${account}:index`);
          indexRequest.onerror = () => reject(indexRequest.error);
          indexRequest.onsuccess = () => {
            try {
              const index = indexRequest.result || { accountKey: account, bundles: [] };
              if (index.accountKey !== account || !Array.isArray(index.bundles)) throw new Error('当前账号的清单索引无法安全读取。');
              const bundles = index.bundles.filter(item => item.bundleId !== owner.bundleId);
              bundles.push({ bundleId: owner.bundleId, category: owner.imported.category, rows: owner.links.length, savedAt: next.savedAt });
              if (refresh) {
                const identity = { revision: next.revision, savedAt: next.savedAt };
                Object.assign(next, refresh(), identity);
              }
              store.put(encodeRecord(next), recordKey(owner.bundleId));
              store.put({ accountKey: account, bundles, activeBundleId: workspace?.bundleId || owner.bundleId }, `${account}:index`);
              done(next);
            } catch (error) { reject(error); }
          };
        } catch (error) { reject(error); }
      };
    });
    owner.revision = next.revision; owner.savedAt = next.savedAt;
    return next;
  }
  function snapshot(owner, retainReceipts = new Set()) {
    const next = copy(owner);
    delete next.saveFault;
    for (const link of next.links) for (const mode of Object.keys(MODES)) {
      const entry = entryFor(link, mode, owner);
      if (entry) {
        link.outputs[mode].snapshot = copy(entry.controller.state);
        try { link.outputs[mode].receipt = entry.journal.read(); }
        catch (error) { if (!retainReceipts.has(link.linkId)) throw error; }
      }
    }
    return next;
  }
  async function persist(owner = workspace) {
    if (!owner || starting || startupFailed) return;
    queue = queue.catch(() => {}).then(async () => {
      await ensureAccount();
      await saveRecord(owner, snapshot(owner));
    });
    try { await queue; owner.saveFault = false; renderStatus(); }
    catch (error) { owner.saveFault = true; renderStatus(); throw error; }
  }
  function scheduleSave(owner = workspace) { if (!owner) return; clearTimeout(saveTimers.get(owner.bundleId)); saveTimers.set(owner.bundleId, setTimeout(() => { saveTimers.delete(owner.bundleId); persist(owner).catch(fail); }, 300)); }
  function receiptJournal(entry) {
    const key = `sz_link_image_receipt_v1${env}:${encodeURIComponent(account)}:${encodeURIComponent(entry.key)}`;
    const identity = ['jobId', 'signature', 'shotId', 'batchId'];
    const read = () => {
      const raw = localStorage.getItem(key);
      if (raw == null && !entry.link.outputs[entry.mode].receipt) return null;
      let saved; try { saved = raw == null ? copy(entry.link.outputs[entry.mode].receipt) : JSON.parse(raw); } catch (_) { throw new Error('本链接任务回执无法读取，原记录仍保留。'); }
      if (!saved || saved.accountKey !== account || saved.linkWorkspaceId !== entry.owner.bundleId || saved.linkOutputMode !== entry.mode || saved.linkRecordId !== entry.link.linkId || !saved.jobId) throw new Error('本链接任务回执身份不一致，已停止恢复。');
      return saved;
    };
    return {
      read,
      write(receipt) {
        const old = read();
        if (old && identity.some(field => old[field] !== receipt[field])) throw new Error('本链接已有另一份请求回执，已停止覆盖。');
        const saved = { ...receipt, accountKey: account, linkWorkspaceId: entry.owner.bundleId, linkRecordId: entry.link.linkId, linkOutputMode: entry.mode };
        localStorage.setItem(key, JSON.stringify(saved)); entry.link.outputs[entry.mode].receipt = copy(saved);
        scheduleSave(entry.owner);
      },
      clear() { if (read()) throw new Error('清理回执必须核对原请求身份。'); },
      compareAndClear(receipt) {
        const old = read(); if (!old) return true;
        if (!receipt || identity.some(field => old[field] !== receipt[field])) return false;
        localStorage.removeItem(key); entry.link.outputs[entry.mode].receipt = null; scheduleSave(entry.owner); return true;
      }
    };
  }
  function readInput(entry) {
    const link = entry.link;
    return { bundleId: entry.owner.bundleId, category: entry.owner.imported.category, link: copy(link.row), marketingPlan: copy(link.task?.marketingPlan || null), subjectTaskId: link.task?.subjectTaskId || '', subjectRequirement: copy(link.task?.subjectRequirement || null), bindingOverride: copy(link.bindingOverride || null), products: copy(link.products), models: copy(link.models), config: copy(link.outputs[entry.mode].config) };
  }
  function rememberFailure(entry, response, request) {
    if (!response || response.ok !== false) return;
    const failure = {}, field = (name, value, limit = 200) => { if (typeof value === 'string' && value && value.length <= limit && !/[\u0000-\u001f]/.test(value)) failure[name] = value; };
    if (typeof response.code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/.test(response.code)) field('code', response.code, 96);
    for (const name of ['status', 'httpStatus']) if (Number.isInteger(response[name]) && response[name] >= 100 && response[name] <= 599) failure[name] = response[name];
    for (const name of ['providerSubmitted', 'definitiveFailure', 'stateUncertain']) if (typeof response[name] === 'boolean') failure[name] = response[name];
    field('model', request?.config?.imageModel || request?.config?.model, 160); field('provider', request?.config?.provider, 160);
    for (const name of ['jobId', 'requestId', 'billingEventId']) field(name, response[name] || (name === 'jobId' ? request?.jobId : ''), 200);
    field('shotId', request?.payload?.linkShotId, 200);
    const output = entry.link.outputs[entry.mode]; output.lastFailure = failure;
    if (failure.shotId) { output.failureDiagnostics ||= {}; Object.defineProperty(output.failureDiagnostics, failure.shotId, { value: failure, enumerable: true, configurable: true, writable: true }); }
  }
  function makeController(owner, link, mode) {
    const key = entryKey(owner, link.linkId, mode), entry = { key, owner, link, mode, controller: null, journal: null, installed: false, cancelled: false };
    entry.journal = receiptJournal(entry);
    entry.controller = contract.createController({
      clonePlain: copy,
      readInput: () => readInput(entry), config: () => bridge.config(),
      async send(...args) { await ensureAccount(); if (owner.saveFault) throw new Error('本链接草稿尚未保存，已停止提交。'); sending.set(key, (sending.get(key) || 0) + 1); renderStatus(); try { const response = await bridge.send(...args); if (args[0] === 'GENERATE_IMAGE') rememberFailure(entry, response, args[1]); return response; } finally { sending.set(key, Math.max(0, (sending.get(key) || 1) - 1)); renderStatus(); } },
      archive: bridge.archive, archiveContext: bridge.archiveContext, newJobId: bridge.newJobId,
      register: bridge.registerGenerationJob, unregister: bridge.unregisterGenerationJob, journal: entry.journal,
      onChange() { entry.reviewCache = null; if (!starting && entry.installed && entry.controller) { updateTaskNotice(entry); scheduleSave(owner); renderStatus(); if (workspace === owner && selectedLink() === link && workspace.activeMode === mode) renderResults(); } }
    });
    const saved = link.outputs[mode].snapshot;
    if (saved) { const result = entry.controller.restore(saved); if (result?.ok === false) throw new Error(result.error || '本链接任务无法安全恢复。'); }
    entry.journal.read();
    return entry;
  }
  function install(owner) {
    if (owner.schema !== 1 || owner.accountKey !== account || !owner.bundleId || !Array.isArray(owner.links) || !owner.imported?.bundle || !Array.isArray(owner.imported.rows)) throw new Error('保存的链接工作区身份或内容不完整，原草稿未改动。');
    const parsed = importer.parse(owner.imported.bundle, { category: owner.imported.category });
    if (!parsed.ok || parsed.bundleId !== owner.bundleId || parsed.category !== owner.imported.category || JSON.stringify(parsed.rows) !== JSON.stringify(owner.imported.rows) || JSON.stringify(parsed.tasks) !== JSON.stringify(owner.imported.tasks)) throw new Error('保存的原始清单与链接记录不一致，原草稿未改动。');
    const tasks = new Map((parsed.tasks || []).map(task => [task.linkId, task]));
    for (const link of owner.links) {
      if (!owner.imported.rows.some(row => row['链接编号'] === link.linkId && JSON.stringify(row) === JSON.stringify(link.row)) || !Array.isArray(link.products) || !Array.isArray(link.models) || link.products.length > 6 || link.models.length > 3 || [...link.products, ...link.models].some(asset => !contract.validImage(asset.image))) throw new Error('保存的链接素材或行身份无效，原稿未改动。');
      for (const mode of Object.keys(MODES)) if (!link.outputs?.[mode]?.config || link.outputs[mode].config.mode !== mode) throw new Error('保存的输出设置无法安全恢复。');
      if (JSON.stringify(link.task) !== JSON.stringify(tasks.get(link.linkId) || {})) throw new Error('保存的营销企划或上游素材要求与原始链接不一致，原稿未改动。');
    }
    if (new Set(owner.links.map(link => link.linkId)).size !== owner.links.length || owner.links.length !== owner.imported.rows.length) throw new Error('保存的链接编号重复或缺失。');
    if (!owner.links.some(link => link.linkId === owner.activeLinkId) || !Object.hasOwn(MODES, owner.activeMode) || !Array.isArray(owner.selected) || owner.selected.some(id => !owner.links.some(link => link.linkId === id))) throw new Error('保存的链接选择或输出类型无效。');
    owner.revision = revision(owner); owner.saveFault = false;
    const entries = owner.links.flatMap(link => Object.keys(MODES).map(mode => makeController(owner, link, mode)));
    workspaces.set(owner.bundleId, owner);
    for (const entry of entries) { entry.installed = true; controllers.set(entry.key, entry); }
    workspace = owner;
  }
  async function importRaw(raw, category = '') {
    if (mutationBusy()) throw new Error('清单或素材正在读取，请稍后导入。');
    importing = true; renderStatus();
    try {
      await ensureAccount();
      const parsed = importer.parse(raw, { category: category.trim() });
      if (!parsed.ok) throw new Error(parsed.error || parsed.message || '链接清单无法导入。');
      if (workspace) await persist(workspace);
      let owner = workspaces.get(parsed.bundleId) || await dbGet(recordKey(parsed.bundleId));
      if (owner) { if (!workspaces.has(parsed.bundleId)) install(owner); else workspace = owner; }
      else {
        const tasks = new Map((parsed.tasks || []).map(task => [task.linkId, task]));
        owner = { schema: 1, accountKey: account, bundleId: parsed.bundleId, revision: 'missing', savedAt: '', rawImport: typeof raw === 'string' ? raw : JSON.stringify(raw), imported: { bundle: copy(parsed.bundle), rows: copy(parsed.rows), category: parsed.category, sourceFormat: parsed.sourceFormat, tasks: copy(parsed.tasks || []) }, activeLinkId: parsed.rows[0]['链接编号'], activeMode: 'main', selected: parsed.rows.map(row => row['链接编号']), links: parsed.rows.map(row => ({ linkId: row['链接编号'], row: copy(row), task: copy(tasks.get(row['链接编号']) || {}), products: [], models: [], bindingConfirmed: false, bindingOverride: null, outputs: Object.fromEntries(Object.keys(MODES).map(mode => [mode, { config: { ...defaults(mode), provider: info.provider || '', model: info.model || '' }, confirmedSignature: '', snapshot: null, receipt: null }])) })) };
        const entries = owner.links.flatMap(link => Object.keys(MODES).map(mode => makeController(owner, link, mode)));
        workspaces.set(owner.bundleId, owner); workspace = owner;
        for (const entry of entries) { entry.installed = true; controllers.set(entry.key, entry); }
        await persist(owner);
      }
      workspaceView(owner).parked = false; render(); notify(`已${owner.savedAt ? '读取' : '导入'} ${owner.links.length} 条链接；请逐链接确认主体与模特绑定。`);
      return { ok: true, bundleId: owner.bundleId };
    } finally { importing = false; renderStatus(); }
  }
  function options(values, selected) { return values.map(value => `<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}>${esc(value)}</option>`).join(''); }
  function assetsMarkup(link, kind) {
    const product = kind === 'products', max = product ? 6 : 3, assets = link[kind];
    return `<section class="li-assets-panel"><div class="li-panel-heading"><h3>${product ? '产品主体' : '人物模特'}</h3><span>${assets.length}/${max}</span></div><label class="li-drop" data-li-drop="${kind}"><span>点击上传或拖入${product ? '产品主体图' : '模特图'}</span><small>PNG / JPG / WebP · 每张不超过 10 MB</small><input type="file" data-li-upload="${kind}" accept="image/png,image/jpeg,image/webp" multiple${linkLocked(link) ? ' disabled' : ''}></label><div class="li-assets">${assets.map((asset, index) => `<figure><button type="button" data-li-action="preview-asset" data-kind="${kind}" data-index="${index}" aria-label="查看原图 ${esc(asset.name)}"><img src="${esc(asset.image)}" alt="${esc(asset.name)}"></button><figcaption>${esc(asset.name)}</figcaption><button type="button" data-li-action="remove-asset" data-kind="${kind}" data-index="${index}" aria-label="移除 ${esc(asset.name)}"${linkLocked(link) ? ' disabled' : ''}>×</button></figure>`).join('')}</div></section>`;
  }
  function requirement(link) { const value = link.task?.subjectRequirement || {}; return { products: Number(value.localProductReferenceCount) || value.localReferences?.products?.length || 0, models: Number(value.localModelReferenceCount) || value.localReferences?.models?.length || 0, names: [...(value.localReferences?.products || []), ...(value.localReferences?.models || [])].map(item => item.name || item.assetId).filter(Boolean) }; }
  function bindingError(link) {
    if (!link.products.length || link.products.length > 6 || link.models.length > 3) return '请为本链接上传 1–6 张产品主体图和 0–3 张模特图。';
    const expected = requirement(link);
    if (!link.bindingOverride?.confirmed && (expected.products > link.products.length || expected.models > link.models.length)) return `上游引用了 ${expected.products} 张产品图、${expected.models} 张模特图；请补齐，或明确重新绑定当前素材。`;
    if (!link.bindingConfirmed) return '请确认本链接的主体和模特绑定。';
    return '';
  }
  function focusSection(id) {
    const target = $(id);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target?.focus({ preventScroll: true });
  }
  function render() {
    if (!root) return;
    const link = selectedLink(), mode = workspace?.activeMode || 'main', entry = entryFor(), config = link?.outputs[mode].config, view = workspaceView();
    if (view && !view.parked) view.listPage = Math.floor(workspace.links.indexOf(link) / LIST_PAGE_SIZE);
    root.innerHTML = `<header class="li-hero"><div><span class="li-eyebrow">链接创作工作台</span><h1>链接成图</h1><p>每条链接使用自己的定位与文案，结合已绑定的产品和模特生成主图、详情。</p></div><div class="li-actions"><a class="li-button" href="/dashboards/operating-network?surface=list-legacy" target="_top">查看旧链接任务</a><button type="button" class="li-button" data-li-action="history">生成历史</button>${workspace && !view.parked ? '<button type="button" class="li-button" data-li-action="park-workspace" title="收起当前页面，保留草稿、原请求和生成原件，可随时恢复">清空当前页面</button>' : ''}</div></header>
      <ol class="li-steps" aria-label="链接成图步骤">${['导入 JSON', '绑定主体与模特', '整理并确认方案', '按清单生成', '查看原件结果'].map((label, index) => `<li${index === (!workspace ? 0 : !link?.bindingConfirmed ? 1 : !entry?.controller.state.plan || !link.outputs[mode].confirmedSignature || !reviewMatches() ? 2 : inFlight(entry) ? 3 : slotsFor(entry).some(slot => slot.item) ? 4 : 3) ? ' class="is-current"' : ''}><b>${index + 1}</b><span>${label}</span></li>`).join('')}</ol>
      <section class="li-card li-import"><div class="li-panel-heading"><h2>导入链接 JSON</h2><label class="li-file-button">选择 JSON 文件<input id="liJsonFile" type="file" accept=".json,application/json"${mutationBusy() ? ' disabled' : ''}></label></div><p class="li-muted">从关键词衍生插件复制或导出链接清单。原始 JSON、营销企划和上游素材引用会完整保留；图片需在这里重新上传绑定。</p><textarea id="liImportRaw" rows="3" placeholder="粘贴含 category、rows 的完整 JSON，也支持单条链接或数组"></textarea><div class="li-import-actions"><label>品类（JSON 缺失时填写）<input id="liCategory" type="text" maxlength="120" placeholder="例如：床上用品"></label><button type="button" class="li-button li-primary" data-li-action="import"${mutationBusy() ? ' disabled' : ''}>导入 / 读取清单</button>${workspaces.size ? `<label>当前账号已保存清单<select id="liWorkspace">${[...workspaces.values()].map(owner => `<option value="${esc(owner.bundleId)}"${owner === workspace ? ' selected' : ''}>${esc(owner.imported.category)} · ${owner.links.length} 条链接</option>`).join('')}</select></label>` : ''}</div></section>
      <p id="liStatus" class="li-notice" role="status" aria-live="polite" hidden></p>
      ${workspace && !view.parked ? `<div class="li-workspace"><aside class="li-card li-link-list"><div class="li-panel-heading"><h2>链接清单</h2><span>${workspace.links.length} 条</span></div><button id="liToggleLinks" type="button" class="li-button" data-li-action="toggle-links" aria-controls="liLinkRows" aria-expanded="${!view.listCollapsed}">隐藏清单</button><label class="li-checkbox"><input id="liSelectAll" type="checkbox"${workspace.selected.length === workspace.links.length ? ' checked' : ''}>选择全部链接</label><p id="liSelectionCount" class="li-selection-count" role="status"></p><div id="liLinkRows"></div><div id="liLinkPages"></div><p class="li-muted li-saved" id="liSavedState">${workspace.savedAt ? '已恢复当前账号草稿' : '清单按当前账号保存'}</p></aside><div class="li-editor">
      <section class="li-card li-next" aria-label="当前链接下一步"><div><strong id="liNextState"></strong><p>同步全部会替换各链接素材并沿用当前框架；各自定位、文案和补充要求保留，不提交生图。</p><p id="liSyncSummary" class="li-sync-summary"></p></div><div class="li-next-actions"><button id="liNextAction" type="button" class="li-button li-primary" data-li-action="next-step"></button><button type="button" class="li-button" data-li-action="view-review">查看完整方案与全部坑位</button><button id="liSyncAllAction" type="button" class="li-button" data-li-action="sync-all-confirm" disabled></button></div></section>
      <section id="liBindingSection" class="li-card li-anchor" tabindex="-1"><div class="li-panel-heading"><h2>${esc(link.linkId)} · 素材绑定</h2><span id="liBindingBadge" class="li-pill">${link.bindingConfirmed ? '已确认绑定' : '待绑定'}</span></div><p class="li-muted">${esc(link.row['链接定位'])} · ${esc(link.row['主推关键词'])}</p>${requirement(link).names.length ? `<p class="li-upstream">上游本机引用：${esc(requirement(link).names.join('、'))}。引用记录不等于已上传图片。</p>` : ''}<div class="li-assets-grid">${assetsMarkup(link, 'products')}${assetsMarkup(link, 'models')}</div><label class="li-checkbox"><input id="liRebindOverride" type="checkbox"${link.bindingOverride?.confirmed ? ' checked' : ''}${linkLocked(link) ? ' disabled' : ''}>已用当前上传素材重新绑定本链接（替代上游建议，原始记录保留）</label><div class="li-actions"><button type="button" class="li-button li-primary" data-li-action="confirm-binding"${linkLocked(link) ? ' disabled' : ''}>确认本链接素材绑定</button><button type="button" class="li-button" data-li-action="apply-binding"${linkLocked(link) ? ' disabled' : ''}>将此组素材明确应用到所选 ${workspace.selected.length} 条链接</button></div><p id="liBindingState" class="li-muted">${esc(bindingError(link) || '本链接只使用上方已绑定图片。')}</p></section>
      <section id="liPlanSection" class="li-card li-anchor" tabindex="-1"><div class="li-panel-heading"><h2>输出与提示词</h2><nav class="li-tabs" aria-label="链接输出类型">${Object.entries(MODES).map(([key, label]) => `<button type="button" data-li-action="switch-output" data-mode="${key}" aria-pressed="${mode === key}">${label}</button>`).join('')}</nav></div><div class="li-settings"><label>生图模型<select id="liModel"${active() || modelBusy ? ' disabled' : ''}>${apis.length ? apis.map(api => `<option value="${esc(api.provider)}"${api.provider === config.provider ? ' selected' : ''}>${esc(api.imageModel || api.label || api.provider)}</option>`).join('') : '<option value="">请先配置可用生图模型</option>'}</select></label><label>${mode === 'main' ? '每链接主图张数' : '每链接详情屏数'}<input data-li-config="count" type="number" min="${mode === 'main' ? 1 : 5}" max="${mode === 'main' ? 20 : 16}" value="${config.count}"></label><label>图片比例<select data-li-config="ratio">${options(info.ratios || info.aspectRatios || ['1:1', '3:4', '4:3', '9:16', '16:9'], config.ratio)}</select></label><label>请求清晰度<select data-li-config="resolution">${options(info.resolutions || ['1K', '2K', '4K'], config.resolution)}</select></label><label>输出质量<select data-li-config="quality">${options(info.qualityOptions || ['auto'], config.quality)}</select></label><label>平台<input data-li-config="platform" value="${esc(config.platform)}" maxlength="40"></label></div><label class="li-field">图片模块（按顺序，每行一项）<textarea data-li-config="modules" rows="3">${esc(config.modules.map(module => typeof module === 'string' ? module : module.label || module.id).join('\n'))}</textarea></label><label class="li-field">本链接补充要求<textarea data-li-config="requirements" rows="2" maxlength="6000" placeholder="补充画面表达要求，商品身份与本链接 JSON 仍为约束">${esc(config.requirements)}</textarea></label><div class="li-actions"><button type="button" class="li-button" data-li-action="plan">生成本链接${MODES[mode]}规划</button><button type="button" class="li-button" data-li-action="plan-selected">生成所选链接${MODES[mode]}规划</button><button type="button" class="li-button" data-li-action="open-config">配置 API</button></div><p class="li-muted" id="liModelNote">当前任务模型：${esc(config.model || '未选择')}。核对完整方案后，可一次确认所选链接再提交。</p><div id="liPlanEditor" class="li-anchor" tabindex="-1"></div><div id="liSyncBackup"></div></section>
      <section id="liReviewSection" class="li-card li-anchor li-review" tabindex="-1" aria-label="完整方案与图片坑位"><div class="li-panel-heading"><h2>整理并确认${MODES[mode]}方案</h2><label>查看范围<select id="liReviewScope"><option value="selected"${reviewScope === 'selected' ? ' selected' : ''}>所选链接</option><option value="all"${reviewScope === 'all' ? ' selected' : ''}>全部 ${workspace.links.length} 条链接</option></select></label></div><p id="liReviewSummary" class="li-muted"></p><p class="li-muted">核对每张图片的顺序、模块和文件名，再确认所选链接方案。查看与确认方案均不提交生图。</p><div class="li-review-footer"><p id="liReviewState" role="status"></p><button id="liReviewConfirm" type="button" class="li-button li-primary" data-li-action="confirm-review"></button></div><div class="li-review-controls"><button id="liToggleReview" type="button" class="li-button" data-li-action="toggle-review" aria-controls="liReviewSlots" aria-expanded="${!view.reviewCollapsed}">隐藏图片坑位</button><div id="liReviewPages"></div></div><div id="liReviewSlots"></div></section>
      <section class="li-card"><div class="li-panel-heading"><h2>按清单生成${MODES[mode]}</h2><span id="liProgress"></span></div><div class="li-actions"><button id="liGenerate" type="button" class="li-button li-primary" data-li-action="generate">生成所选链接已确认的${MODES[mode]}</button><button type="button" class="li-button" data-li-action="retry-failed">只重试本链接失败项</button><button type="button" class="li-button" data-li-action="stop">停止本链接后续生成</button><button type="button" class="li-button" data-li-action="stop-list">停止本次清单</button></div><div id="liReceipt" class="li-anchor" tabindex="-1"></div><p class="li-muted">停止等待会保留原请求和已完成结果；其他链接可继续。模型费用按当前账号所选配置计算。</p></section>
      <section class="li-card"><div class="li-panel-heading"><h2>${esc(link.linkId)} · ${MODES[mode]}结果与原件</h2><button type="button" class="li-button" data-li-action="download-all">下载本组原件</button></div><div id="liResults" class="li-results"></div></section></div></div>` : workspace ? '<section class="li-empty"><h2>当前页面已清空</h2><p>链接草稿、原请求和生成原件已保留。恢复后可继续查看与下载。</p><p id="liParkedTaskState" role="status"></p><button type="button" class="li-button li-primary" data-li-action="restore-workspace">恢复当前清单</button><button type="button" class="li-button" data-li-action="stop-list">停止本次清单后续生成</button></section>' : '<section class="li-empty"><h2>导入第一份链接清单</h2><p>导入后按 L 编号绑定素材，为每条链接确认主图与详情提示词。</p></section>'}`;
    renderLinkList(); renderPlan(); renderResults(); renderStatus(); renderSyncBackup();
  }
  function renderPlan() {
    const target = $('liPlanEditor'), entry = entryFor(); if (!target || !entry) return;
    const plan = entry.controller.state.plan;
    target.innerHTML = !plan ? '<p class="li-empty-note">素材绑定完成后生成规划；每条提示词均只服务当前链接。</p>' : `<div class="li-plan-heading"><strong>${esc(plan.linkId)} · ${MODES[entry.mode]} · ${plan.totalOutputs} 张</strong><span>${entry.link.outputs[entry.mode].confirmedSignature === plan.signature ? '已确认' : '待确认'}</span></div>${plan.shots.map(shot => `<details class="li-shot"><summary>${shot.index}. ${esc(shot.label)}</summary><textarea data-li-prompt="${esc(shot.id)}" rows="6" aria-label="${esc(shot.label)}提示词"${entryLocked(entry) ? ' disabled' : ''}>${esc(shot.prompt)}</textarea></details>`).join('')}<button type="button" class="li-button li-primary" data-li-action="confirm-plan"${entryLocked(entry) ? ' disabled' : ''}>确认本链接${MODES[entry.mode]}提示词</button>`;
    renderReview();
  }
  const SLOT_LABELS = { ready: '待生成', queued: '排队中', generating: '生成中', done: '已完成', failed: '失败', stopped: '已停止', uncertain: '结果待确认', outdated: '历史版本' };
  const reviewKey = (entry, shot) => `${entry.link.linkId}:${entry.mode}:${shot.id}`;
  function resultPlan(entry, slot) {
    const item = slot?.item, plan = item?.linkPlanSnapshot?.plan, state = entry?.controller.state;
    if (!item || !plan || typeof item.resultId !== 'string' || !item.resultId || !Array.isArray(plan.shots) || (item.accountKey && item.accountKey !== account) || entry.owner.accountKey !== account || state.accountKey !== account || (slot.archiveContext?.accountKey || slot.archiveContext?.accountId || account) !== account) return null;
    if (item.linkBundleId !== entry.owner.bundleId || item.linkId !== entry.link.linkId || item.linkMode !== entry.mode || item.linkPlanSignature !== plan.signature || plan.bundleId !== entry.owner.bundleId || plan.linkId !== entry.link.linkId || plan.mode !== entry.mode || item.linkShotId !== slot.shot?.id || item.linkPlanSnapshot.shotId !== item.linkShotId) return null;
    const shot = plan.shots?.find(shot => shot.id === item.linkShotId);
    return shot && samePlain(shot, slot.submission?.shot || slot.shot) && (!slot.submission?.planSignature || slot.submission.planSignature === plan.signature) && contract.validImage(imageOf(item)) ? plan : null;
  }
  function reviewResult(entry, shot) {
    const plan = entry?.controller.state.plan;
    if (!plan || !shot || plan.bundleId !== entry.owner.bundleId || plan.linkId !== entry.link.linkId || plan.mode !== entry.mode || entry.owner.accountKey !== account) return { slot: null, result: null, status: 'ready' };
    const slot = entry.controller.state.slots.find(slot => samePlain(slot.shot, shot)) || null;
    const matches = candidate => resultPlan(entry, candidate)?.signature === plan.signature && candidate.item.linkShotId === shot.id && samePlain(candidate.submission?.shot || candidate.shot, shot);
    const result = slot?.item && matches(slot) ? slot : [...(entry.controller.state.previousResults || [])].reverse().find(matches) || null;
    return { slot, result, status: slot?.item && !matches(slot) ? 'outdated' : slot?.status || (result ? 'done' : 'ready') };
  }
  function resultAttributes(entry, slot) {
    return `data-link="${esc(entry.link.linkId)}" data-mode="${esc(entry.mode)}" data-shot="${esc(slot.shot.id)}" data-plan="${esc(slot.item.linkPlanSignature)}" data-result="${esc(slot.item.resultId)}" data-bundle="${esc(entry.owner.bundleId)}"`;
  }
  function resultTools(entry, slot) {
    if (!resultPlan(entry, slot) || typeof window.SZ_LINK_RESULT_HANDOFF?.open !== 'function') return '';
    return [['guided-regenerate', '引导重生'], ['case-fission', '同步裂变'], ['style-refresh', '风格焕新']].map(([tool, label]) => `<button type="button" class="li-button" data-li-action="result-handoff" data-tool="${tool}" ${resultAttributes(entry, slot)}>${label}</button>`).join('');
  }
  function renderReview() {
    const target = $('liReviewSlots'); if (!target || !workspace) return;
    const mode = workspace.activeMode, view = workspaceView(), page = reviewPage(), links = page.items, footer = $('liReviewPages'), toggle = $('liToggleReview');
    if (footer) footer.innerHTML = view.reviewCollapsed ? '' : pagerMarkup('review', page);
    if (toggle) { toggle.textContent = view.reviewCollapsed ? '显示图片坑位' : '隐藏图片坑位'; toggle.setAttribute('aria-expanded', String(!view.reviewCollapsed)); }
    target.innerHTML = view.reviewCollapsed ? '<p class="li-empty-note">图片坑位已隐藏，方案和生成结果仍保留。</p>' : links.length ? links.map(link => {
      const entry = entryFor(link, mode), plan = entry?.controller.state.plan, config = link.outputs[mode].config;
      return `<section class="li-review-link" data-li-review-link="${esc(link.linkId)}"><div class="li-panel-heading"><h3>${esc(link.linkId)} · ${MODES[mode]} · ${plan ? plan.shots.length + ' 张' : '尚未整理方案'}</h3><span>${workspace.selected.includes(link.linkId) ? '已勾选' : '未勾选'}</span></div><p class="li-muted">${esc(link.row['链接定位'] || link.row['详情页定位'] || '')}</p><p class="li-muted">模型 ${esc(config.model || '未选择')} · 提供方 ${esc(config.provider || '未选择')} · ${esc(config.ratio)} · ${esc(config.resolution)}</p>${plan ? `<div class="li-review-grid">${plan.shots.map(shot => {
        const key = reviewKey(entry, shot), attributes = `data-link="${esc(link.linkId)}" data-mode="${mode}" data-shot="${esc(shot.id)}" data-plan="${esc(plan.signature)}" data-bundle="${esc(workspace.bundleId)}"`;
        return `<article class="li-review-slot" data-li-review-slot="${esc(key)}" style="--li-review-ratio:${/^[1-9]\d*:[1-9]\d*$/.test(config.ratio) ? config.ratio.replace(':', '/') : mode === 'detail' ? '3/4' : '1/1'}"><button type="button" class="li-review-image" data-li-action="preview-slot" data-li-review-preview="${esc(key)}" ${attributes} disabled><img data-li-review-image="${esc(key)}" alt="${esc(link.linkId)} · ${MODES[mode]} · ${esc(shot.label)}" loading="lazy" hidden><span class="li-review-placeholder" data-li-review-placeholder="${esc(key)}"><span>第 ${shot.index} / ${plan.shots.length} 张</span><strong>${esc(shot.label)}</strong></span></button><p>${esc(link.linkId)} · ${MODES[mode]} · ${shot.index} · ${esc(shot.label)}</p><code class="li-filename">${esc(plannedFilename(link.linkId, mode, shot.index))}</code><span class="li-pill" data-li-review-state="${esc(key)}">待生成</span><div class="li-actions" data-li-review-actions="${esc(key)}" ${attributes} hidden></div></article>`;
      }).join('')}</div>` : '<p class="li-empty-note">先完成素材绑定并整理本链接方案，即可显示每张图片的坑位与名称。</p>'}</section>`;
    }).join('') : '<p class="li-empty-note">勾选链接后，可在这里核对完整方案；也可切换到全部链接查看。</p>';
    renderReviewStatus();
  }
  function renderReviewStatus() {
    if (!workspace || workspaceView().parked) return;
    const entries = selectedEntries(), total = entries.reduce((count, entry) => count + (entry?.controller.state.plan?.shots.length || 0), 0), confirmed = reviewMatches();
    const state = $('liReviewState'), button = $('liReviewConfirm');
    if (state) state.textContent = reviewing ? '正在确认并保存方案…' : confirmed ? `已确认所选 ${entries.length} 条链接、${total} 张图片的完整方案。` : '请逐页核对图片顺序与命名，再确认所选链接完整方案。选择范围或方案变化后需重新确认。';
    if (button) { button.textContent = `确认所选 ${entries.length} 条链接${MODES[workspace.activeMode]}方案（${total} 张）`; button.disabled = mutationBusy() || !!workspace.saveFault || !entries.length || entries.some(entry => !entry?.controller.state.plan || entryLocked(entry) || !!bindingError(entry.link)); }
    const links = reviewLinks(), visible = new Set(workspaceView().reviewCollapsed ? [] : reviewPage().items), models = new Map(), plans = [], counts = { ready: 0, generating: 0, failed: 0, uncertain: 0, done: 0, outdated: 0 };
    for (const link of links) {
      const entry = entryFor(link), plan = entry?.controller.state.plan; if (!plan) continue; plans.push(plan);
      // Controller notifications invalidate only this link's summary. Offscreen
      // originals reuse summaries; mounted images always recheck their current ownership.
      let cache = entry.reviewCache;
      if (visible.has(link) || !cache || cache.plan !== plan || cache.slots !== entry.controller.state.slots || cache.previous !== entry.controller.state.previousResults) {
        cache = entry.reviewCache = { plan, slots: entry.controller.state.slots, previous: entry.controller.state.previousResults, views: plan.shots.map(shot => ({ shot, ...reviewResult(entry, shot) })) };
      }
      for (const view of cache.views) {
        if (visible.has(link)) models.set(reviewKey(entry, view.shot), { entry, ...view });
        if (view.status === 'done' && view.result) counts.done++;
        else if (view.status === 'generating' || view.status === 'queued') counts.generating++;
        else if (view.status === 'failed') counts.failed++;
        else if (view.status === 'uncertain') counts.uncertain++;
        else if (view.status === 'outdated') counts.outdated++;
        else counts.ready++;
      }
    }
    root.querySelectorAll('[data-li-review-state]').forEach(marker => { const view = models.get(marker.dataset.liReviewState); marker.textContent = SLOT_LABELS[view?.status] || view?.status || '待生成'; });
    // Set image URLs individually rather than concatenating a whole batch of
    // original data URLs into one enormous HTML string. Late receipts update the
    // exact existing card even when a different link is selected.
    root.querySelectorAll('[data-li-review-image]').forEach(image => {
      const result = models.get(image.dataset.liReviewImage)?.result, url = imageOf(result?.item); image.hidden = !url;
      if (image.getAttribute('src') !== url) { if (url) image.setAttribute('src', url); else image.removeAttribute('src'); }
    });
    root.querySelectorAll('[data-li-review-placeholder]').forEach(placeholder => { placeholder.hidden = !!models.get(placeholder.dataset.liReviewPlaceholder)?.result; });
    root.querySelectorAll('[data-li-review-preview]').forEach(preview => { const result = models.get(preview.dataset.liReviewPreview)?.result; preview.disabled = !result; if (result) preview.dataset.result = result.item.resultId; else delete preview.dataset.result; });
    root.querySelectorAll('[data-li-review-actions]').forEach(actions => {
      const view = models.get(actions.dataset.liReviewActions), result = view?.result; actions.hidden = !result;
      const markup = result ? `<button type="button" class="li-button" data-li-action="download-slot" ${resultAttributes(view.entry, result)}>下载原件</button>${resultTools(view.entry, result)}` : '';
      if (actions.innerHTML !== markup) actions.innerHTML = markup;
    });
    if ($('liReviewSummary')) $('liReviewSummary').textContent = `${reviewScope === 'all' ? '全部' : '所选'} ${links.length} 条链接 · 已整理 ${plans.length} 条 · 共 ${plans.reduce((count, plan) => count + plan.shots.length, 0)} 个${MODES[workspace.activeMode]}图片坑位。待生成 ${counts.ready} · 进行中 ${counts.generating} · 失败 ${counts.failed} · 结果待确认 ${counts.uncertain} · 已完成 ${counts.done}${counts.outdated ? ' · 历史版本 ' + counts.outdated : ''}。当前勾选 ${workspace.selected.length} 条，确认仅对勾选链接生效。${workspaceView().reviewCollapsed ? '图片坑位已隐藏。' : `本页显示第 ${reviewPage().start}–${reviewPage().end} 条；翻页查看其余方案。`}`;
  }
  function failureDiagnostic(entry, slot) {
    const output = entry.link.outputs[entry.mode], failure = output.failureDiagnostics?.[slot.shot?.id] || (output.lastFailure?.shotId === slot.shot?.id ? output.lastFailure : null);
    return failure || {};
  }
  function modelMissing(failure, error = '') {
    return /^(?:IMAGE_)?MODEL_NOT_FOUND$/i.test(failure.code || '') || /model_not_found|未开通所选模型|model[^\n]{0,100}(?:not supported|does not exist)|not supported by any configured account/i.test(error);
  }
  function modelConfigurationFailure(failure) {
    return failure?.definitiveFailure === true && failure.stateUncertain !== true && (modelMissing(failure) || /^(?:IMAGE_MODEL_INVALID|MODEL_INVALID|INVALID_MODEL|IMAGE_MODEL_REQUIRED|MODEL_TYPE_MISMATCH|FORBIDDEN)$/i.test(failure.code || '') || (failure.status || failure.httpStatus) === 403);
  }
  function renderSyncBackup() {
    const target = $('liSyncBackup'), link = selectedLink(); if (!target || !link) return;
    const backup = link.syncBackups?.at(-1); if (!backup) { target.innerHTML = ''; return; }
    const assets = [...(backup.products || []), ...(backup.models || [])].filter(asset => contract.validImage(asset.image));
    const plan = backup.outputs?.[workspace.activeMode]?.plan;
    target.innerHTML = `<details class="li-sync-backup"><summary>查看同步前的素材与提示词（保留 ${link.syncBackups.length} 份原稿）</summary><p class="li-muted">同步于 ${esc(backup.at)}，来源 ${esc(backup.sourceLinkId)}。旧结果仍保留在结果区和生成历史。</p><div class="li-backup-assets">${assets.map(asset => `<a href="${esc(asset.image)}" download="${esc(asset.name || '同步前原素材.png')}" title="下载同步前原素材"><img src="${esc(asset.image)}" alt="${esc(asset.name || '同步前原素材')}"></a>`).join('')}</div>${plan?.shots?.map(shot => `<details class="li-shot"><summary>${esc(shot.label)} · 同步前提示词</summary><textarea rows="6" readonly aria-label="同步前${esc(shot.label)}提示词">${esc(shot.prompt)}</textarea></details>`).join('') || '<p class="li-muted">同步前尚无本输出的提示词规划。</p>'}</details>`;
  }
  function renderResults() {
    const target = $('liResults'), entry = entryFor(); if (!target || !entry) return;
    const slots = slotsFor(entry);
    target.innerHTML = slots.length ? slots.map((slot, index) => {
      const label = slot.item?.businessRoleName || slot.shot?.label || `结果 ${index + 1}`, ordinal = slot.shot?.index || index + 1;
      const failure = failureDiagnostic(entry, slot), error = slot.item && slot.status === 'done' ? '' : slot.error?.message || String(slot.error || ''), uncertain = slot.status === 'uncertain' || failure.stateUncertain === true, missing = !uncertain && modelMissing(failure, error), config = slot.submission?.config || entry.link.outputs[entry.mode].config;
      const filename = plannedFilename(slot.item?.linkId || entry.link.linkId, slot.item?.linkMode || entry.mode, ordinal), status = SLOT_LABELS[slot.status] || slot.status;
      const requested = `请求清晰度 ${config.resolution || '未记录'} · 请求比例 ${config.ratio || '未记录'}`;
      const diagnostic = error ? `<div data-li-failure="${esc(slot.shot?.id || '')}"><p class="li-error">${esc(uncertain ? '原请求结果尚未确认，请先核对原任务回执。' : missing ? '所选模型在当前接口不可用，请核对模型名及权限。' : error)}</p><p class="li-failure-context">模型 ${esc(failure.model || config.model || '未记录')} · 提供方 ${esc(failure.provider || config.provider || '未记录')}${failure.code ? ` · 错误码 ${esc(failure.code)}` : ''}${failure.status || failure.httpStatus ? ` · HTTP ${failure.status || failure.httpStatus}` : ''}</p>${missing || uncertain ? `<details class="li-original-error"><summary>原始报错</summary><p>${esc(error)}</p></details>` : ''}</div>` : '';
      return `<article class="li-result"><button type="button" class="li-result-image" data-li-action="preview-result" data-index="${index}"${imageOf(slot.item) ? '' : ' disabled'}>${imageOf(slot.item) ? `<img src="${esc(imageOf(slot.item))}" loading="lazy" decoding="async" alt="${esc(label)}" data-li-result-pixels="${index}">` : `<span class="li-result-placeholder"><small>${esc(entry.link.linkId)} · ${MODES[entry.mode]}第 ${ordinal} 张</small><strong>${esc(label)}</strong><span>${esc(status)}</span></span>`}</button><strong>${esc(label)}</strong><code class="li-filename" data-li-result-filename="${esc(slot.shot?.id || '')}">${esc(filename)}</code><p>${esc(status)}</p>${slot.item ? `<p class="li-muted" data-li-result-size="${index}" data-li-requested-size="${esc(requested)}">实际像素读取中 · ${esc(requested)}</p>` : ''}${diagnostic}${slot.item && !slot.archiveOk ? '<p class="li-error">原件待保存，请补存后继续。</p>' : ''}<div class="li-actions">${slot.item ? `<button type="button" class="li-button" data-li-action="download" data-index="${index}">下载原件</button>${!slot.archiveOk ? `<button type="button" class="li-button" data-li-action="retry-archive" data-index="${index}">补存原件</button>` : ''}` : ''}${error ? '<button type="button" class="li-button" data-li-action="open-config">核对模型配置</button>' : ''}${slot.status === 'failed' ? `<button type="button" class="li-button" data-li-action="retry-shot" data-id="${esc(slot.shot.id)}">重试</button>` : ''}${resultTools(entry, slot)}</div></article>`;
    }).join('') : '<p class="li-empty-note">本链接、本输出类型的结果将在这里按顺序保留。</p>';
    target.querySelectorAll('[data-li-result-pixels]').forEach(image => {
      const size = target.querySelector(`[data-li-result-size="${image.dataset.liResultPixels}"]`);
      if (!size) return;
      const measure = () => {
        if (entryFor() !== entry || $('liResults') !== target) return;
        const width = image.naturalWidth, height = image.naturalHeight;
        size.textContent = `${width > 0 && height > 0 ? `实际 ${width} × ${height} 像素` : '实际像素暂无法读取'} · ${size.dataset.liRequestedSize}`;
      };
      image.addEventListener('load', measure); image.addEventListener('error', measure);
      if (image.complete) measure();
    });
  }
  function getTaskState() {
    const entries = [...controllers.values()], activeCount = entries.reduce((total, entry) => total + (entry.controller.state.uncertain ? 0 : Math.max(preparing.has(entry.key) || running.has(entry.key) || entry.controller.state.busy ? 1 : 0, (entry.controller.state.slots || []).filter(slot => slot.status === 'generating').length)), 0);
    const pendingReceiptCount = entries.filter(entry => entry.controller.state.uncertain).length;
    return { ready: !starting && !startupFailed, accountKey: account || '', busy: activeCount > 0 || importing || uploading || modelBusy || syncing || reviewing, transportPending: active(), activeCount, pendingReceiptCount, summary: reviewing ? '正在确认并保存所选链接完整方案' : syncing ? '正在同步全部链接的素材与提示词' : activeCount ? `${activeCount} 个链接输出正在处理` : pendingReceiptCount ? `${pendingReceiptCount} 个原请求回执待核对` : '当前没有进行中的链接任务' };
  }
  function renderStatus() {
    if (!root) return;
    bridge?.setApiBusy?.('link-image', mutationBusy() || active());
    const currentEntry = entryFor(), taskNotice = visibleTaskNotice(currentEntry), explicitNotice = message && (!messageEntry || messageEntry === currentEntry?.key) ? { message, error: messageError, version: messageVersion } : null;
    const notice = explicitNotice && (!taskNotice || explicitNotice.version > taskNotice.version) ? explicitNotice : taskNotice;
    const status = $('liStatus'); if (status) { status.hidden = !notice?.message; status.textContent = notice?.message || ''; status.classList.toggle('is-error', !!notice?.error); status.setAttribute('role', notice?.error ? 'alert' : 'status'); }
    root.querySelectorAll('[data-li-action="import"], [data-li-action="park-workspace"], [data-li-action="restore-workspace"], #liJsonFile, #liWorkspace').forEach(control => { control.disabled = mutationBusy(); });
    const entry = entryFor(), link = selectedLink();
    if (!workspace || !entry || !link) return;
    const parkedState = $('liParkedTaskState'); if (parkedState) parkedState.textContent = getTaskState().summary;
    const step = !link.bindingConfirmed ? 1 : !entry.controller.state.plan || !link.outputs[entry.mode].confirmedSignature || !reviewMatches() ? 2 : inFlight(entry) ? 3 : slotsFor(entry).some(slot => slot.item) ? 4 : 3;
    root.querySelectorAll('.li-steps li').forEach((item, index) => item.classList.toggle('is-current', index === step));
    if ($('liBindingBadge')) $('liBindingBadge').textContent = link.bindingConfirmed ? '已确认绑定' : '待绑定';
    if ($('liBindingState')) $('liBindingState').textContent = bindingError(link) || '本链接只使用上方已绑定图片。';
    const selected = new Set(workspace.selected), all = $('liSelectAll');
    if (all) {
      all.checked = selected.size === workspace.links.length;
      all.indeterminate = selected.size > 0 && selected.size < workspace.links.length;
    }
    root.querySelectorAll('[data-li-select]').forEach(control => { control.checked = selected.has(control.dataset.liSelect); });
    if ($('liSelectionCount')) $('liSelectionCount').textContent = `已选 ${selected.size} / ${workspace.links.length} 条`;
    root.querySelectorAll('[data-li-action="apply-binding"]').forEach(control => { control.textContent = `将此组素材明确应用到所选 ${selected.size} 条链接`; });
    const plan = entry.controller.state.plan, confirmed = !!plan && link.outputs[entry.mode].confirmedSignature === plan.signature;
    const nextState = $('liNextState'), nextAction = $('liNextAction');
    if (nextState) nextState.textContent = `${link.linkId} · ${MODES[entry.mode]}：${entry.controller.state.uncertain ? '原请求回执待核对' : bindingError(link) ? '待确认素材绑定' : !plan ? '尚未生成规划' : confirmed ? '提示词已确认' : '提示词待确认'}`;
    if (nextAction) {
      nextAction.textContent = entry.controller.state.uncertain ? '查看原请求回执' : bindingError(link) ? '查看素材并确认绑定' : !plan ? `生成本链接${MODES[entry.mode]}规划` : confirmed ? `查看已确认的${MODES[entry.mode]}提示词` : `确认本链接${MODES[entry.mode]}提示词`;
      nextAction.disabled = mutationBusy() || inFlight(entry) || !!workspace.saveFault;
    }
    const syncAction = $('liSyncAllAction');
    if (syncAction) {
      syncAction.textContent = syncing ? '正在同步并保存…' : `同步并确认全部 ${workspace.links.length} 条：素材与${MODES[entry.mode]}提示词`;
      syncAction.disabled = linkLocked(link) || !!workspace.saveFault || !confirmed || !!bindingError(link);
      syncAction.title = confirmed ? '用当前素材与框架同步整份清单，并分别确认各链接提示词；原稿保留' : '请先生成并确认当前链接的提示词';
    }
    if ($('liSyncSummary')) {
      const result = workspace.syncResult;
      $('liSyncSummary').textContent = result ? `上次同步：${result.confirmedIds.length} / ${workspace.links.length} 条${MODES[result.mode]}已确认${result.skipped.length ? `，跳过 ${result.skipped.length} 条（详见提示）` : ''}。` : '先确认当前链接，即可一键同步并确认整份清单。';
    }
    root.querySelectorAll('[data-li-select], #liSelectAll').forEach(control => { control.disabled = syncing || reviewing; });
    for (const marker of root.querySelectorAll('[data-li-link-state]')) {
      const row = workspace.links.find(link => link.linkId === marker.dataset.liLinkState); if (!row) continue;
      const states = Object.keys(MODES).map(mode => {
        const item = entryFor(row, mode), slots = item.controller.state.slots || [], failed = slots.filter(slot => slot.status === 'failed').length, ready = slots.filter(slot => !slot.item && ['ready', 'queued', 'stopped'].includes(slot.status)).length;
        return `${MODES[mode]}${item.controller.state.uncertain ? '结果待确认' : inFlight(item) ? '进行中' : failed ? `失败 ${failed}${ready ? ` / 待生成 ${ready}` : ''}` : slots.some(slot => slot.item) ? '有结果' : row.outputs[mode].confirmedSignature ? '已确认' : item.controller.state.plan ? '待确认' : '待规划'}`;
      });
      marker.textContent = states.join(' · ');
    }
    const saved = $('liSavedState'); if (saved) saved.textContent = workspace.saveFault ? '草稿保存失败，已停止提交' : workspace.savedAt ? '清单、素材与任务已保存' : '清单尚未保存';
    const progress = $('liProgress'); if (progress) progress.textContent = `${(entry.controller.state.slots || []).filter(slot => slot.status === 'done').length}/${entry.controller.state.slots?.length || 0} 已完成`;
    const receipt = $('liReceipt');
    if (receipt) receipt.innerHTML = entry.controller.state.uncertain ? `<div class="li-receipt"><strong>本链接的原请求待核对</strong><p>任务 ${esc(entry.controller.state.uncertain.jobId)}。其他链接可继续，核对提供方记录后再重试本张。</p><label class="li-checkbox"><input id="liReceiptChecked" type="checkbox">已核对原任务结果和用量</label><button type="button" class="li-button" data-li-action="resolve-receipt">记录核对结果</button></div>` : '';
    root.querySelectorAll('[data-li-config], [data-li-prompt]').forEach(control => { control.disabled = entryLocked(entry); });
    root.querySelectorAll('[data-li-action="generate"], [data-li-action="retry-failed"], [data-li-action="retry-shot"], [data-li-action="plan"], [data-li-action="confirm-plan"]').forEach(control => { control.disabled = entryLocked(entry) || !!workspace.saveFault; });
    root.querySelectorAll('[data-li-upload], #liRebindOverride').forEach(control => { control.disabled = linkLocked(link); });
    root.querySelectorAll('[data-li-action="confirm-binding"], [data-li-action="apply-binding"], [data-li-action="remove-asset"]').forEach(control => { control.disabled = linkLocked(link) || !!workspace.saveFault; });
    root.querySelectorAll('[data-li-action="select-link"], [data-li-action="switch-output"], [data-li-action="plan-selected"]').forEach(control => { control.disabled = mutationBusy(); });
    root.querySelectorAll('[data-li-action="open-config"]').forEach(control => { control.disabled = mutationBusy() || active(); });
    root.querySelectorAll('[data-li-action="stop"]').forEach(control => { control.disabled = !inFlight(entry); });
    root.querySelectorAll('[data-li-action="stop-list"]').forEach(control => { control.disabled = ![...controllers.values()].some(item => item.owner === workspace && inFlight(item)); });
    if ($('liModel')) $('liModel').disabled = mutationBusy() || active();
    renderReviewStatus();
  }
  function invalidate(link, mode, owner = workspace) {
    invalidateReview(link, mode, owner);
    for (const type of mode ? [mode] : Object.keys(MODES)) { const entry = entryFor(link, type, owner); entry.controller.invalidate(); link.outputs[type].confirmedSignature = ''; }
    scheduleSave(owner);
  }
  async function refreshModels(snapshot) {
    modelBusy = true; renderStatus();
    try {
      await ensureAccount();
      const catalog = await bridge.listBoundApis(snapshot?.boundApis);
      if (!catalog?.ok || catalog.accountKey && String(catalog.accountKey) !== account) throw new Error(catalog?.error || '模型列表所属账号不一致。');
      const next = await bridge.modelInfo(); await ensureAccount();
      apis = catalog.providers || catalog.apis || []; info = next || {};
    } finally { modelBusy = false; renderStatus(); }
  }
  async function useEntryModel(entry) {
    const config = entry.link.outputs[entry.mode].config;
    if (!config.provider || !config.model) throw new Error('请先为本链接输出选择可用的生图模型。');
    const live = bridge.config();
    if (live.provider !== config.provider || live.imageModel !== config.model) {
      if (active(entry)) throw new Error('其他链接正在使用当前模型，请等待或为本任务选择相同模型。');
      await selectModel(config.provider, entry);
    }
    const actual = bridge.config();
    if (actual.provider !== config.provider || actual.imageModel !== config.model) throw new Error('当前 API 中的模型已变化，请重新选择模型并确认本链接提示词。');
  }
  async function selectModel(provider, except = null) {
    if (syncing || selectingApi || active(except)) throw new Error('当前链接操作尚未结束，已停止切换 API。');
    selectingApi = true; renderStatus();
    try {
      await ensureAccount();
      if (syncing) throw new Error('正在同步链接，已停止切换 API。');
      if (active(except)) throw new Error('其他链接已开始处理，已停止切换 API。');
      let pending;
      bridge.setApiBusy?.('link-image', false);
      try { pending = bridge.selectBoundApi(provider); } finally { renderStatus(); }
      const changed = await pending; if (changed?.ok === false) throw new Error(changed.error); await refreshModels();
    } finally { selectingApi = false; renderStatus(); }
  }
  async function decodeFile(file) {
    if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > 10 * 1024 * 1024) throw new Error('请上传不超过 10 MB 的 PNG、JPG 或 WebP 原图。');
    const image = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('图片原件读取失败。')); reader.readAsDataURL(file); });
    const dimensions = await new Promise((resolve, reject) => { const picture = new Image(); picture.onload = () => picture.naturalWidth && picture.naturalHeight ? resolve({ width: picture.naturalWidth, height: picture.naturalHeight }) : reject(new Error('图片尺寸无效。')); picture.onerror = () => reject(new Error('图片原件无法解码。')); picture.src = image; });
    const bytes = await file.arrayBuffer(), digest = await crypto.subtle.digest('SHA-256', bytes), sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    return { id: uid(), name: file.name || '粘贴图片', image, type: file.type, size: file.size, contentHash: sha256, ...dimensions };
  }
  async function addFiles(files, kind) {
    const owner = workspace, link = selectedLink();
    if (!owner || !link || linkLocked(link)) throw new Error('本链接正在处理或有原回执待核对，请选择其他链接。');
    const cap = kind === 'products' ? 6 : 3;
    if (link[kind].length + files.length > cap) throw new Error(`本链接最多绑定 ${cap} 张${kind === 'products' ? '主体' : '模特'}图，本次未导入。`);
    uploading = true; renderStatus();
    try {
      await ensureAccount(); const assets = [];
      for (const file of Array.from(files)) { assets.push(await decodeFile(file)); await ensureAccount(); }
      if (new Set([...link[kind], ...assets].map(asset => asset.contentHash)).size !== link[kind].length + assets.length) throw new Error('本组存在重复原图，本次未导入。');
      link[kind].push(...assets); link.bindingConfirmed = false; link.bindingOverride = null; invalidate(link, null, owner); await persist(owner); render();
    } finally { uploading = false; renderStatus(); }
  }
  async function confirmBinding(link = selectedLink()) {
    await ensureAccount(); if (linkLocked(link)) throw new Error('本链接原任务仍在处理，请先查看任务结果。');
    link.bindingConfirmed = true;
    const error = bindingError(link); if (error) { link.bindingConfirmed = false; throw new Error(error); }
    await persist(); render(); notify(`${link.linkId} 的素材绑定已确认。`);
  }
  async function buildPlan(entry) {
    const error = bindingError(entry.link); if (error) throw new Error(`${entry.link.linkId}：${error}`);
    if (entryLocked(entry)) throw new Error(`${entry.link.linkId} 的任务尚未结束。`);
    await ensureAccount(); await useEntryModel(entry);
    if (entryLocked(entry)) throw new Error('本链接状态已变化，请等待当前操作完成。');
    const plan = entry.controller.buildPlan(); if (plan?.ok === false) throw new Error(plan.error || '规划无法生成。');
    invalidateReview(entry.link, entry.mode, entry.owner); entry.link.outputs[entry.mode].confirmedSignature = ''; await persist(entry.owner); return plan;
  }
  async function confirmPlan(entry = entryFor()) {
    await ensureAccount(); const plan = entry.controller.state.plan;
    if (entryLocked(entry) || !plan || bindingError(entry.link)) throw new Error('请先完成素材绑定和当前输出规划。');
    const valid = contract.verifyPlan(plan); if (valid?.ok === false) throw new Error(valid.error || '当前规划校验失败。');
    const rebuilt = contract.createPlan(readInput(entry));
    if (!rebuilt.ok || rebuilt.sourceSignature !== plan.sourceSignature) throw new Error('素材、JSON 或设置已变化，请重新生成规划。');
    entry.link.outputs[entry.mode].confirmedSignature = plan.signature; await persist(entry.owner); renderPlan(); notify(`${entry.link.linkId} ${MODES[entry.mode]}提示词已确认。`);
  }
  async function confirmReview() {
    const owner = workspace, mode = owner?.activeMode, entries = selectedEntries(owner, mode);
    if (!owner || !entries.length) throw new Error('请先勾选要确认方案的链接。');
    if (mutationBusy() || owner.saveFault) throw new Error('当前清单尚未保存或正在处理，请稍后确认方案。');
    const identities = entries.map(entry => ({ id: entry.link.linkId, signature: entry.controller.state.plan?.signature || '' }));
    const checkCurrent = () => {
      const current = selectedEntries(owner, mode);
      if (workspace !== owner || owner.activeMode !== mode || current.length !== identities.length || current.some((entry, index) => entry.link.linkId !== identities[index].id)) throw new Error('所选链接或输出类型已变化，请重新核对完整方案。');
      for (const entry of entries) {
        const plan = entry.controller.state.plan, identity = identities.find(item => item.id === entry.link.linkId), error = bindingError(entry.link);
        if (inFlight(entry) || entry.controller.state.uncertain || entry.journal.read()) throw new Error(`${entry.link.linkId} 原任务尚未结束，请先核对任务回执。`);
        if (error || !plan) throw new Error(error ? `${entry.link.linkId}：${error}` : `${entry.link.linkId} 尚未整理${MODES[mode]}方案。`);
        if (plan.signature !== identity.signature || !sourceUnchanged(entry, plan)) throw new Error(`${entry.link.linkId} 的素材、设置或方案已变化，请重新整理后确认。`);
      }
    };
    reviewing = true; renderStatus();
    try {
      queue = queue.catch(() => {}).then(async () => {
        await ensureAccount(); checkCurrent();
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index], plan = entry.controller.state.plan, valid = contract.verifyPlan(plan), rebuilt = contract.createPlan(readInput(entry));
          if (!valid.ok || !rebuilt.ok || rebuilt.sourceSignature !== plan.sourceSignature) throw new Error(`${entry.link.linkId} 的素材、JSON 或方案已变化，请重新整理。`);
          if ((index + 1) % 5 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        }
        await ensureAccount(); checkCurrent();
        const confirmation = { mode, links: identities, at: new Date().toISOString() };
        const candidate = () => {
          checkCurrent(); const next = snapshot(owner); next.reviewConfirmation = copy(confirmation);
          for (const identity of identities) next.links.find(link => link.linkId === identity.id).outputs[mode].confirmedSignature = identity.signature;
          return next;
        };
        try { await saveRecord(owner, candidate(), candidate); }
        catch (error) { owner.saveFault = true; throw error; }
        for (const identity of identities) owner.links.find(link => link.linkId === identity.id).outputs[mode].confirmedSignature = identity.signature;
        owner.reviewConfirmation = confirmation; owner.saveFault = false;
      });
      await queue; renderPlan();
      notify(`已确认所选 ${entries.length} 条链接的${MODES[mode]}完整方案，未提交生图。`);
    } finally { reviewing = false; renderStatus(); }
  }
  function syncLockReason(link, owner) {
    for (const mode of Object.keys(MODES)) {
      const entry = entryFor(link, mode, owner);
      if (inFlight(entry)) return `${MODES[mode]}任务正在处理`;
      if (entry.controller.state.uncertain || entry.journal.read()) return `${MODES[mode]}原请求回执待核对`;
    }
    return '';
  }
  async function withSyncLocks(source, unavailable, work) {
    if (!navigator.locks?.request) throw new Error('当前浏览器不支持同步防重锁，请使用新版 Chrome。');
    const owner = source.owner, links = [source.link, ...owner.links.filter(link => link !== source.link)];
    const visit = index => {
      if (index === links.length * 2) return work();
      const link = links[Math.floor(index / 2)], mode = index % 2 ? 'detail' : 'main';
      if (unavailable.has(link.linkId)) return visit(index + 1);
      return navigator.locks.request(`sz-link-image-generation${env}:${account}:${entryFor(link, mode, owner).key}`, { ifAvailable: true }, lock => {
        if (!lock) {
          if (link === source.link) throw new Error('另一页面正在处理当前链接，请稍后同步。');
          unavailable.set(link.linkId, '另一页面正在处理本链接');
        }
        return visit(index + 1);
      });
    };
    return visit(0);
  }
  async function syncAllConfirmed(source = entryFor()) {
    const owner = source?.owner;
    if (!source || mutationBusy() || owner.saveFault) throw new Error('当前清单正在处理或尚未保存，请稍后同步。');
    syncing = true; renderStatus();
    clearTimeout(saveTimers.get(owner.bundleId)); saveTimers.delete(owner.bundleId);
    try {
      queue = queue.catch(() => {}).then(async () => {
        await ensureAccount();
        const unavailable = new Map();
        await withSyncLocks(source, unavailable, async () => {
        await ensureAccount();
        if (owner.saveFault) throw new Error('本清单草稿尚未保存，当前未同步。');
        const locked = syncLockReason(source.link, owner); if (locked) throw new Error(`${source.link.linkId}：${locked}，当前未同步。`);
        const sourcePlan = source.controller.state.plan, binding = bindingError(source.link);
        if (binding || !sourcePlan || source.link.outputs[source.mode].confirmedSignature !== sourcePlan.signature) throw new Error('请先确认当前链接的素材、框架和提示词，再同步全部链接。');
        const valid = contract.verifyPlan(sourcePlan), rebuilt = contract.createPlan(readInput(source));
        if (!valid.ok || !rebuilt.ok || rebuilt.sourceSignature !== sourcePlan.sourceSignature) throw new Error('当前链接确认后的素材或框架已变化，请重新规划并确认后再同步。');
        const retainedReceipts = new Set(), reasons = new Map(unavailable);
        for (const target of owner.links) if (target !== source.link && !reasons.has(target.linkId)) {
          try { const reason = syncLockReason(target, owner); if (reason) reasons.set(target.linkId, reason); }
          catch (_) { retainedReceipts.add(target.linkId); reasons.set(target.linkId, '原请求回执无法安全读取'); }
        }
        for (const linkId of reasons.keys()) retainedReceipts.add(linkId);
        const candidate = snapshot(owner, retainedReceipts), at = new Date().toISOString(), changed = [], skipped = [];
        const confirmation = { id: uid(), sourceLinkId: source.link.linkId, mode: source.mode, at, confirmedIds: [source.link.linkId], skipped };
        for (const target of owner.links) {
          if (target === source.link) continue;
          const reason = reasons.get(target.linkId);
          if (reason) { skipped.push({ linkId: target.linkId, reason }); continue; }
          const next = candidate.links.find(link => link.linkId === target.linkId), entry = entryFor(target, source.mode, owner);
          const config = { ...copy(source.link.outputs[source.mode].config), requirements: target.outputs[source.mode].config.requirements || '' };
          // This separate, explicit all-link action grants fresh replacement
          // consent per target; it never copies the source link's consent.
          const override = { confirmed: true, reason: 'explicit-rebind', replacesUpstream: true };
          const input = { ...readInput(entry), products: copy(source.link.products), models: copy(source.link.models), config, bindingOverride: override };
          const plan = contract.createPlan(input);
          if (!plan.ok) { skipped.push({ linkId: target.linkId, reason: plan.error || '详情资料不完整' }); continue; }
          const assetsChanged = JSON.stringify([target.products, target.models, target.bindingOverride]) !== JSON.stringify([input.products, input.models, override]);
          const planChanged = entry.controller.state.plan?.sourceSignature !== plan.sourceSignature;
          if ((assetsChanged || planChanged) && (target.products.length || target.models.length || Object.keys(MODES).some(mode => entryFor(target, mode, owner).controller.state.plan))) {
            next.syncBackups = [...(next.syncBackups || []), { at, sourceLinkId: source.link.linkId, mode: source.mode, products: copy(target.products), models: copy(target.models), bindingConfirmed: target.bindingConfirmed, bindingOverride: copy(target.bindingOverride), outputs: Object.fromEntries(Object.keys(MODES).map(mode => [mode, { config: copy(target.outputs[mode].config), confirmedSignature: target.outputs[mode].confirmedSignature, plan: copy(entryFor(target, mode, owner).controller.state.plan) }])) }];
          }
          next.products = input.products; next.models = input.models; next.bindingOverride = override; next.bindingConfirmed = true;
          next.outputs[source.mode].config = config;
          for (const mode of Object.keys(MODES)) {
            if (mode !== source.mode && !assetsChanged) continue;
            const temporary = contract.createController({ clonePlain: copy, archiveContext: () => ({ accountKey: account }) });
            const restored = temporary.restore(next.outputs[mode].snapshot); if (!restored.ok) throw new Error(restored.error);
            if (mode === source.mode) {
              const prepared = temporary.setPlan(plan); if (prepared.ok === false) throw new Error(prepared.error);
              next.outputs[mode].confirmedSignature = temporary.state.plan.signature;
            } else { temporary.invalidate(); next.outputs[mode].confirmedSignature = ''; }
            next.outputs[mode].snapshot = temporary.snapshot();
          }
          next.syncConfirmation = { id: confirmation.id, sourceLinkId: source.link.linkId, mode: source.mode, at };
          confirmation.confirmedIds.push(target.linkId); changed.push({ target, next });
        }
        candidate.syncResult = confirmation;
        try {
          await saveRecord(owner, candidate, () => {
            // Read skipped/live tasks at the actual IndexedDB write, so a
            // result arriving during preflight is never replaced by an old snapshot.
            const latest = snapshot(owner, retainedReceipts), replacements = new Map(changed.map(item => [item.target.linkId, item.next]));
            latest.links = latest.links.map(link => replacements.get(link.linkId) || link);
            latest.syncResult = confirmation;
            return latest;
          });
        } catch (error) { owner.saveFault = true; throw error; }
        // No visible link is changed until the entire candidate CAS commits.
        for (const { target, next } of changed) {
          for (const field of ['products', 'models', 'bindingOverride', 'bindingConfirmed', 'syncBackups', 'syncConfirmation']) if (Object.hasOwn(next, field)) target[field] = next[field];
          for (const mode of Object.keys(MODES)) {
            target.outputs[mode] = next.outputs[mode];
            const entry = entryFor(target, mode, owner);
            // The candidate is already durable. Restore without scheduling a
            // redundant autosave that could disturb a skipped receipt.
            const installed = entry.installed; entry.installed = false;
            try {
              const restored = entry.controller.restore(next.outputs[mode].snapshot);
              if (!restored.ok) throw new Error(restored.error);
            } finally { entry.installed = installed; }
          }
        }
        owner.syncResult = confirmation;
        });
      });
      await queue;
      const raw = $('liImportRaw')?.value, category = $('liCategory')?.value;
      render(); if (raw != null) $('liImportRaw').value = raw; if (category != null) $('liCategory').value = category;
      const result = owner.syncResult;
      notify(`已同步并确认 ${result.confirmedIds.length} / ${owner.links.length} 条链接的素材与${MODES[source.mode]}提示词，未提交生图。${result.skipped.length ? '\n以下链接未改动：' + result.skipped.map(item => `${item.linkId}（${item.reason}）`).join('、') : ''}`);
    } finally { syncing = false; renderStatus(); }
  }
  async function runEntry(entry, method = 'generate', shotId, reviewGuard) {
    await ensureAccount();
    const plan = entry.controller.state.plan;
    if (entryLocked(entry) || entry.owner.saveFault || !plan || entry.link.outputs[entry.mode].confirmedSignature !== plan.signature || bindingError(entry.link)) throw new Error(`${entry.link.linkId} ${MODES[entry.mode]}尚未确认当前提示词。`);
    const signature = plan.signature, sourceSignature = plan.sourceSignature;
    const verifyConfirmation = () => {
      if (reviewGuard && !reviewGuard()) throw new Error('所选链接或完整方案已变化，已停止本次清单后续提交，请重新核对并确认。');
      const now = entry.controller.state.plan, current = contract.createPlan(readInput(entry));
      if (entry.cancelled || entry.owner.saveFault || bindingError(entry.link) || !current.ok || !now || now.signature !== signature || now.sourceSignature !== sourceSignature || current.sourceSignature !== sourceSignature || entry.link.outputs[entry.mode].confirmedSignature !== signature) throw new Error('本链接确认后的素材或提示词已变化，当前未提交。');
    };
    entry.cancelled = false; preparing.add(entry.key); renderStatus();
    try {
    await useEntryModel(entry); await persist(entry.owner); verifyConfirmation();
    if (!navigator.locks?.request) throw new Error('当前浏览器不支持任务防重锁，请使用新版 Chrome。');
    return await navigator.locks.request(`sz-link-image-generation${env}:${account}:${entry.key}`, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('另一页面正在处理本链接输出，当前未重复提交。');
      const latest = await dbGet(recordKey(entry.owner.bundleId));
      if (revision(latest) !== entry.owner.revision) { entry.owner.saveFault = true; throw new Error('另一页面已更新本清单，已停止提交；请重新读取。'); }
      await ensureAccount(); verifyConfirmation(); preparing.delete(entry.key); running.add(entry.key); beginTaskNotice(entry); renderStatus();
      try {
        const result = await entry.controller[method](shotId), notice = taskNotices.get(entry.key);
        if (result?.ok === false && result.error && notice && !notice.reported) { notice.message = result.error; notice.error = true; }
        return result;
      }
      finally { running.delete(entry.key); await persist(entry.owner); renderResults(); renderStatus(); }
    });
    } finally { preparing.delete(entry.key); renderStatus(); }
  }
  async function download(slot, index, resultEntry = entryFor()) {
    if (!slot?.item) return;
    await ensureAccount();
    const filename = plannedFilename(slot.item.linkId || resultEntry.link.linkId, slot.item.linkMode || resultEntry.mode, slot.shot?.index || index + 1);
    if (typeof bridge.download === 'function') { const result = await bridge.download(slot.item, filename); if (result?.ok === false) throw new Error(result.error); return; }
    const image = imageOf(slot.item);
    if (!/^data:image\//.test(image)) throw new Error('原件暂未就绪，请先补存原件或从生成历史下载。');
    const anchor = document.createElement('a'); anchor.href = image; anchor.download = filename; anchor.click();
  }
  function actionResult(button) {
    const data = button.dataset, owner = workspace;
    if (!owner || owner.accountKey !== account || data.bundle !== owner.bundleId || !Object.hasOwn(MODES, data.mode)) throw new Error('图片所属清单已变化，请重新选择当前图片。');
    const link = owner.links.find(link => link.linkId === data.link), entry = link && entryFor(link, data.mode, owner);
    if (!entry) throw new Error('图片所属链接不存在，原图仍保留。');
    const candidates = slotsFor(entry).filter(slot => slot.shot?.id === data.shot && slot.item?.linkPlanSignature === data.plan && (!data.result || slot.item?.resultId === data.result));
    const slot = candidates.find(slot => resultPlan(entry, slot));
    if (!slot) throw new Error('当前图片的归属或方案已变化，请重新打开结果。');
    if (data.liAction === 'preview-slot' && reviewResult(entry, entry.controller.state.plan?.shots.find(shot => shot.id === data.shot)).result !== slot) throw new Error('当前坑位结果已变化，请重新选择图片。');
    return { entry, slot, plan: resultPlan(entry, slot) };
  }
  async function action(button) {
    if (button.disabled) return;
    const name = button.dataset.liAction, link = selectedLink(), entry = entryFor(), owner = workspace;
    if (reviewing && !['history', 'view-review', 'preview-asset', 'preview-result', 'download', 'download-all', 'preview-slot', 'download-slot', 'result-handoff'].includes(name)) return;
    if (name === 'history') { await bridge.openHistory(); return; }
    if (['list-page', 'review-page', 'toggle-links', 'toggle-review'].includes(name)) {
      const view = workspaceView(); if (!view) return;
      if (name === 'list-page' || name === 'review-page') { const page = Number(button.dataset.page); if (!Number.isSafeInteger(page) || page < 0) return; view[name === 'list-page' ? 'listPage' : 'reviewPage'] = page; }
      if (name === 'toggle-links') view.listCollapsed = !view.listCollapsed;
      if (name === 'toggle-review') view.reviewCollapsed = !view.reviewCollapsed;
      if (name === 'list-page' || name === 'toggle-links') renderLinkList(); else renderReview();
      renderStatus(); return;
    }
    if (name === 'park-workspace' || name === 'restore-workspace') {
      if (!owner || mutationBusy()) return;
      await ensureAccount(); await persist(owner); await ensureAccount();
      if (workspace !== owner || mutationBusy()) return;
      workspaceView(owner).parked = name === 'park-workspace';
      renderKeepingImport(); notify(name === 'park-workspace' ? '已清空当前页面。链接草稿、原请求和生成原件仍保留，可随时恢复清单。' : '已恢复当前清单，原任务与生成结果继续保留。'); return;
    }
    if (name === 'view-review') { if (workspace) workspaceView().reviewCollapsed = false; renderReview(); focusSection('liReviewSection'); return; }
    if (name === 'confirm-review') { await confirmReview(); return; }
    if (name === 'import') { await importRaw($('liImportRaw').value, $('liCategory').value); return; }
    if (name === 'sync-all-confirm') { await syncAllConfirmed(entry); return; }
    if (name === 'next-step') {
      if (entry.controller.state.uncertain) { focusSection('liReceipt'); return; }
      if (bindingError(link)) { focusSection('liBindingSection'); return; }
      if (!entry.controller.state.plan) { await buildPlan(entry); renderPlan(); renderStatus(); notify('规划已生成，请检查提示词，再点击确认。'); }
      else if (link.outputs[entry.mode].confirmedSignature !== entry.controller.state.plan.signature) await confirmPlan(entry);
      focusSection('liPlanEditor'); return;
    }
    if (name === 'stop-list') { runEpochs.set(owner.bundleId, (runEpochs.get(owner.bundleId) || 0) + 1); for (const item of controllers.values()) if (item.owner === owner && inFlight(item)) { item.cancelled = true; await item.controller.stop(); } notify('已停止本次清单的后续任务，其他清单与原请求仍保留。'); return; }
    if (name === 'stop') { if (entry) entry.cancelled = true; await entry?.controller.stop(); await persist(owner); return; }
    if (name === 'select-link' || name === 'switch-output') {
      if (mutationBusy()) return; await ensureAccount(); await persist();
      if (syncing) return;
      if (name === 'select-link') workspace.activeLinkId = button.dataset.id;
      else if (Object.hasOwn(MODES, button.dataset.mode)) { if (workspace.activeMode !== button.dataset.mode) delete workspace.reviewConfirmation; workspace.activeMode = button.dataset.mode; }
      render(); scheduleSave(); return;
    }
    if (name === 'preview-slot' || name === 'download-slot' || name === 'result-handoff') {
      const selected = actionResult(button);
      if (name === 'result-handoff') {
        if (typeof window.SZ_LINK_RESULT_HANDOFF?.open !== 'function') throw new Error('图片创作入口尚未加载，请刷新后重试。');
        const plan = selected.plan, shot = plan.shots.find(shot => shot.id === selected.slot.item.linkShotId);
        const result = await window.SZ_LINK_RESULT_HANDOFF.open({ action: button.dataset.tool, item: { ...copy(selected.slot.item), url: imageOf(selected.slot.item) }, shot: copy(shot), plan: copy(plan), accountKey: account, bundleId: owner.bundleId, linkId: selected.entry.link.linkId, mode: selected.entry.mode });
        if (result?.ok === false) throw new Error(result.error || '图片创作入口打开失败。'); return;
      }
      await ensureAccount();
      if (workspace !== owner || actionResult(button).slot !== selected.slot) throw new Error('当前图片或清单已变化，请重新选择。');
      if (name === 'preview-slot') await window.SZ_IMAGE_UPLOAD?.openPreview(imageOf(selected.slot.item), selected.slot.shot.label, false);
      else await download(selected.slot, selected.slot.shot.index - 1, selected.entry);
      return;
    }
    if (name === 'preview-asset') { const asset = link[button.dataset.kind][Number(button.dataset.index)]; await window.SZ_IMAGE_UPLOAD?.openPreview(asset.image, asset.name, false); return; }
    if (name === 'preview-result') { const slot = slotsFor(entry)[Number(button.dataset.index)]; await window.SZ_IMAGE_UPLOAD?.openPreview(imageOf(slot.item), slot.shot.label, false); return; }
    if (name === 'download') { await download(slotsFor(entry)[Number(button.dataset.index)], Number(button.dataset.index)); return; }
    if (name === 'download-all') { const slots = slotsFor(entry); for (let index = 0; index < slots.length; index++) if (slots[index].item) await download(slots[index], index); return; }
    if (name === 'retry-archive') { await ensureAccount(); if (syncing) return; const result = await entry.controller.retryArchive(slotsFor(entry)[Number(button.dataset.index)]); if (result?.ok === false) throw new Error(result.error); await persist(); return; }
    if (name === 'open-config') { if (active()) throw new Error('当前有链接任务正在使用模型配置。'); await ensureAccount(); await bridge.openConfig(); return; }
    await ensureAccount();
    if (syncing) return;
    if (name === 'remove-asset') { if (linkLocked(link)) return; link[button.dataset.kind].splice(Number(button.dataset.index), 1); link.bindingConfirmed = false; link.bindingOverride = null; invalidate(link); await persist(); render(); }
    else if (name === 'confirm-binding') await confirmBinding();
    else if (name === 'apply-binding') {
      if (bindingError(link)) throw new Error(bindingError(link));
      const targets = workspace.links.filter(row => workspace.selected.includes(row.linkId));
      if (!targets.length) throw new Error('请先选择要明确应用同组素材的链接。');
      if (targets.some(linkLocked)) throw new Error('所选链接中存在进行中的原任务，请先取消勾选该链接。');
      for (const target of targets) if (target !== link) { target.products = copy(link.products); target.models = copy(link.models); target.bindingOverride = null; target.bindingConfirmed = true; if (bindingError(target)) target.bindingConfirmed = false; invalidate(target); }
      await persist(); render(); notify(`已将当前素材应用到 ${targets.length} 条所选链接；上游引用不足的链接仍需补齐或明确重新绑定。`);
    } else if (name === 'plan') { await buildPlan(entry); renderPlan(); focusSection('liPlanEditor'); notify('规划已生成，请逐条检查并确认提示词。'); }
    else if (name === 'plan-selected') { const targets = workspace.links.filter(row => workspace.selected.includes(row.linkId)); if (!targets.length) throw new Error('请先选择要生成规划的链接。'); for (const row of targets) await buildPlan(entryFor(row)); renderPlan(); focusSection('liPlanEditor'); notify('所选链接规划已生成，请分别检查并确认。'); }
    else if (name === 'confirm-plan') await confirmPlan(entry);
    else if (name === 'generate') {
      const entries = workspace.links.filter(row => workspace.selected.includes(row.linkId)).map(row => entryFor(row));
      if (!entries.length) throw new Error('请先选择要生成的链接。');
      for (const item of entries) {
        const missingBinding = bindingError(item.link), plan = item.controller.state.plan;
        if (missingBinding || !plan || item.link.outputs[item.mode].confirmedSignature !== plan.signature) {
          const importDraft = $('liImportRaw')?.value, categoryDraft = $('liCategory')?.value;
          owner.activeLinkId = item.link.linkId; render(); scheduleSave(owner);
          if (importDraft != null) $('liImportRaw').value = importDraft;
          if (categoryDraft != null) $('liCategory').value = categoryDraft;
          focusSection(missingBinding ? 'liBindingSection' : !plan ? 'liPlanSection' : 'liPlanEditor');
          throw new Error(missingBinding ? `${item.link.linkId}：${missingBinding}` : !plan ? `${item.link.linkId} 尚未生成${MODES[item.mode]}规划，请点击“生成本链接${MODES[item.mode]}规划”，检查后再确认提示词。` : `${item.link.linkId} ${MODES[item.mode]}提示词待确认，请检查后点击“确认本链接${MODES[item.mode]}提示词”。`);
        }
      }
      const mode = owner.activeMode, confirmation = owner.reviewConfirmation;
      if (!reviewMatches(owner, mode)) { reviewScope = 'selected'; renderReview(); focusSection('liReviewSection'); throw new Error('请先核对全部图片坑位与命名，再点击“确认所选链接方案”。'); }
      const reviewGuard = () => workspace === owner && owner.activeMode === mode && owner.reviewConfirmation === confirmation && reviewMatches(owner, mode);
      const epoch = (runEpochs.get(owner.bundleId) || 0) + 1; runEpochs.set(owner.bundleId, epoch);
      for (const item of entries) {
        if (epoch !== runEpochs.get(owner.bundleId)) break;
        if (!reviewGuard()) { notify('所选链接或完整方案已变化，已停止本次清单后续提交，请重新核对并确认。', true); break; }
        const before = item.link.outputs[item.mode].lastFailure;
        let result;
        try { result = await runEntry(item, 'generate', undefined, reviewGuard); }
        catch (error) { if (!reviewGuard()) { notify('所选链接或完整方案已变化，已停止本次清单后续提交，请重新核对并确认。', true); break; } throw error; }
        const failure = item.link.outputs[item.mode].lastFailure;
        if (result?.ok === false && failure !== before && modelConfigurationFailure(failure)) { notify('所选模型在当前接口不可用，已停止本次清单后续提交，请核对模型名及权限。', true); break; }
      }
    } else if (name === 'retry-failed') await runEntry(entry, 'retryFailed');
    else if (name === 'retry-shot') await runEntry(entry, 'retryShot', button.dataset.id);
    else if (name === 'resolve-receipt') { if (!$('liReceiptChecked')?.checked) throw new Error('请先核对原请求结果和用量记录。'); const result = entry.controller.resolveUncertain({ confirmed: true }); if (result?.ok === false) throw new Error(result.error); await persist(); render(); }
  }
  function bindEvents() {
    root.addEventListener('click', event => { const button = event.target.closest('[data-li-action]'); if (button) action(button).catch(fail); });
    root.addEventListener('change', event => {
      const target = event.target;
      (async () => {
        if (syncing || reviewing) return;
        if (target.id === 'liJsonFile') { const file = target.files?.[0]; if (!file) return; if (file.size > 5 * 1024 * 1024) throw new Error('JSON 文件超过 5 MB。'); await importRaw(await file.text(), $('liCategory').value); return; }
        if (target.dataset.liUpload) { await addFiles(target.files || [], target.dataset.liUpload); return; }
        if (target.id === 'liWorkspace') { await persist(); await ensureAccount(); if (syncing || reviewing) return; workspace = workspaces.get(target.value); workspaceView().parked = false; render(); scheduleSave(); return; }
        if (!workspace) return;
        if (target.id === 'liReviewScope') { reviewScope = target.value === 'all' ? 'all' : 'selected'; workspaceView().reviewPage = 0; renderReview(); return; }
        const link = selectedLink(), entry = entryFor();
        if (target.id === 'liSelectAll' || target.dataset.liSelect) {
          const selected = target.id === 'liSelectAll' ? target.checked ? workspace.links.map(row => row.linkId) : [] : target.checked ? [...new Set([...workspace.selected, target.dataset.liSelect])] : workspace.selected.filter(id => id !== target.dataset.liSelect);
          if (selected.length !== workspace.selected.length || selected.some(id => !workspace.selected.includes(id))) delete workspace.reviewConfirmation;
          workspace.selected = selected; scheduleSave(); renderReview(); renderStatus(); return;
        }
        if (target.id === 'liRebindOverride') { if (linkLocked(link)) return; link.bindingOverride = target.checked ? { confirmed: true, reason: 'explicit-rebind', replacesUpstream: true } : null; link.bindingConfirmed = false; invalidate(link); await persist(); render(); return; }
        if (target.id === 'liModel') {
          if (active() || mutationBusy()) return; await ensureAccount();
          if (syncing || reviewing) return;
          await selectModel(target.value);
          const config = link.outputs[entry.mode].config; config.provider = info.provider; config.model = info.model; invalidate(link, entry.mode); await persist(); render(); return;
        }
        if (entryLocked(entry)) return;
        if (target.dataset.liConfig) { const key = target.dataset.liConfig; const config = link.outputs[entry.mode].config; config[key] = key === 'count' ? Number(target.value) : key === 'modules' ? target.value.split('\n').map(value => value.trim()).filter(Boolean) : target.value; invalidate(link, entry.mode); await persist(); renderPlan(); }
        if (target.dataset.liPrompt) { const result = entry.controller.editShot(target.dataset.liPrompt, { prompt: target.value }); if (result?.ok === false) throw new Error(result.error); invalidateReview(link, entry.mode); link.outputs[entry.mode].confirmedSignature = ''; await persist(); renderPlan(); renderStatus(); }
      })().catch(fail);
    });
    root.addEventListener('dragover', event => { if (event.target.closest('[data-li-drop]')) event.preventDefault(); });
    root.addEventListener('drop', event => { const zone = event.target.closest('[data-li-drop]'); if (!zone) return; event.preventDefault(); addFiles(event.dataTransfer?.files || [], zone.dataset.liDrop).catch(fail); });
    root.addEventListener('paste', event => { const zone = event.target.closest('[data-li-drop]'); if (!zone || !event.clipboardData?.files?.length) return; event.preventDefault(); addFiles(event.clipboardData.files, zone.dataset.liDrop).catch(fail); });
    window.addEventListener('beforeunload', event => { if (active() || mutationBusy() || [...workspaces.values()].some(owner => owner.saveFault)) { event.preventDefault(); event.returnValue = ''; } });
    window.addEventListener('sz-bound-api-changed', () => { if (!active() && !mutationBusy()) refreshModels().then(render).catch(fail); });
  }
  window.SanjieLinkImageBridge = {
    getTaskState,
    async activate() { if (starting || startupFailed) return { ok: false, error: '链接成图尚未准备好，请重新读取。' }; try { await ensureAccount(); if (!active() && !mutationBusy()) await refreshModels(); return { ok: true }; } catch (error) { return { ok: false, error: error.message }; } },
    async canDeactivate() {
      if (startupFailed) return { allowed: true };
      if (starting || active() || importing || uploading || modelBusy || syncing || reviewing) return { allowed: false, reason: '链接清单正在处理；可切换创作入口，离开整个工作台前请停止本次等待并保存。' };
      deactivating = true;
      try { for (const owner of workspaces.values()) await persist(owner); await ensureAccount(); if (active()) return { allowed: false, reason: '原图片请求仍在处理中。' }; return { allowed: true }; }
      catch (error) { return { allowed: false, reason: error.message }; }
      finally { deactivating = false; renderStatus(); }
    }
  };
  async function boot() {
    document.body.classList.add('link-image-mode');
    root = $('linkImageRoot'); if (!root) { root = document.createElement('div'); root.id = 'linkImageRoot'; document.querySelector('.app').append(root); }
    root.innerHTML = '<p class="li-startup" role="status">正在读取当前账号的链接清单、素材和模型设置…</p>';
    for (let count = 0; count < 100 && (!window.SZ_CREATIVE_TOOLS_BRIDGE || !window.SZ_LINK_LIST_IMPORT || !window.SZ_LINK_IMAGE_WORKFLOW); count++) await new Promise(resolve => setTimeout(resolve, 100));
    bridge = window.SZ_CREATIVE_TOOLS_BRIDGE; importer = window.SZ_LINK_LIST_IMPORT; contract = window.SZ_LINK_IMAGE_WORKFLOW;
    if (!bridge || !importer || !contract) throw new Error('链接成图依赖未完整加载，请重新读取。');
    const ready = await bridge.ready(); if (ready?.ok === false) throw new Error(ready.error || '账号工作区未准备好。');
    account = String(ready?.accountKey || await bridge.getAccountKey());
    if (!account || ['local', 'undefined', 'null'].includes(account)) throw new Error('请先登录账号，再打开链接成图。');
    await ensureAccount(); await refreshModels(ready);
    const index = await dbGet(`${account}:index`);
    if (index) {
      if (index.accountKey !== account || !Array.isArray(index.bundles)) throw new Error('当前账号的清单索引无法安全恢复。');
      for (const item of index.bundles) { const saved = await dbGet(recordKey(item.bundleId)); if (!saved) throw new Error('已保存清单缺失，原索引仍保留。'); install(saved); }
      if (index.activeBundleId) workspace = workspaces.get(index.activeBundleId) || workspace;
    }
    bindEvents(); starting = false; render(); document.title = '少壮AI · 链接成图'; document.body.dataset.linkImageStartup = 'ready'; window.SZ_LAB_STARTUP?.ready();
  }
  if (window.__SZ_LINK_IMAGE_UI_TEST_MODE__) window.__SZ_LINK_IMAGE_UI_TEST_API__ = { importRaw, readInput, bindingError, confirmBinding, confirmPlan, confirmReview, reviewMatches, plannedFilename, buildPlan, runEntry, persist, addFiles, action, snapshot, revision, encodeRecord, decodeRecord, get workspace() { return workspace; }, get controllers() { return controllers; }, get workspaces() { return workspaces; }, get queue() { return queue; } };
  const start = () => boot().catch(error => { startupFailed = true; starting = false; bridge?.setApiBusy?.('link-image', false); if (root) { root.innerHTML = `<section class="li-startup li-error" role="alert"><h2>链接成图暂未就绪</h2><p>${esc(error.message || error)}</p><p>当前账号的原清单、素材与请求回执仍保留。</p><button id="liReload" type="button">重新读取</button></section>`; $('liReload')?.addEventListener('click', () => location.reload()); } document.body.dataset.linkImageStartup = 'failed'; window.SZ_LAB_STARTUP?.fail(error.message || String(error)); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
