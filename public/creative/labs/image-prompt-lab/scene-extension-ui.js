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
