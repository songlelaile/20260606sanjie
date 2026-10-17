/* Link results reuse existing editors in a separate window; the source receipt
 * and workspace remain mounted. The handoff is memory-only, single-use, bound
 * to the exact child window, logged-in account and deployment environment. */
(function (root) {
  'use strict';
  if (root.SZ_LINK_RESULT_HANDOFF) return;
  var PATH = '/creative/labs/image-prompt-lab/promptlab.html';
  var SHELL_PATH = '/dashboards/operating-network';
  // These are the existing host-owned iframe routes. The shell selects its
  // normal surface; the receiver reads the one-use token from its parent.
  var TARGETS = {
    'guided-regenerate': { surface: 'list-legacy', query: '?mode=main&source=web&layout=1' },
    'case-fission': { surface: 'viral-case', query: '?mode=viral&source=web&layout=1&workflow=1&creativeRoute=case' },
    'style-refresh': { surface: 'viral-style', query: '?mode=viral&source=web&layout=1&workflow=1&creativeRoute=style-refresh' }
  };
  var query = new URLSearchParams(root.location.search);
  var sourceMode = query.get('mode') === 'link-image' && query.get('source') === 'web';
  var creativeSourceMode = query.get('mode') === 'creative' && query.get('source') === 'web';
  var initialShell = shellContext(root);
  var tokenInUrl = query.get('linkResultToken') || initialShell && initialShell.token || '';
  if (!sourceMode && !creativeSourceMode && !tokenInUrl) return;
  var records = new Map(), receiving = null;
  var receiverDocument = root.document;
  var TIMEOUT = 60000;
  var ACTIONS = { 'guided-regenerate': '引导重生', 'case-fission': '同步裂变', 'style-refresh': '风格焕新' };
  function frameDestination(action) {
    var target = TARGETS[action];
    if (!target) throw new Error('不支持的图片操作。');
    return new URL(PATH + target.query, root.location.origin);
  }
  function shellDestination(action, token) {
    var url = new URL(SHELL_PATH, root.location.origin);
    url.searchParams.set('surface', TARGETS[action].surface);
    url.searchParams.set('linkResultToken', token);
    return url;
  }
  function shellContext(receiver) {
    try {
      var popup = receiver.parent;
      if (!popup || popup === receiver || popup.parent !== popup || popup.closed) return null;
      var shell = new URL(popup.location.href), frame = new URL(receiver.location.href);
      if (shell.origin !== root.location.origin || shell.pathname !== SHELL_PATH || frame.origin !== shell.origin) return null;
      var surface = shell.searchParams.get('surface'), action = Object.keys(TARGETS).filter(function (key) { return TARGETS[key].surface === surface; })[0];
      var token = shell.searchParams.get('linkResultToken') || '';
      if (!action || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(token) || shell.href !== shellDestination(action, token).href || frame.href !== frameDestination(action).href) return null;
      // Reject sibling/imposter frames and ambiguous duplicate destinations.
      // This reads host DOM identity without writing React-owned iframe state.
      var elements = popup.document.querySelectorAll('iframe'), matches = [];
      for (var index = 0; index < elements.length; index++) {
        var element = elements[index];
        if (element.ownerDocument === popup.document && element.isConnected !== false && new URL(element.src, shell.origin).href === frame.href) matches.push(element);
      }
      if (matches.length !== 1 || matches[0].contentWindow !== receiver || receiver.frameElement !== matches[0]) return null;
      return { popup: popup, opener: popup.opener, action: action, token: token, shellUrl: shell.href, frameUrl: frame.href };
    } catch (_) { return null; }
  }
  function currentShell() {
    var current = initialShell && shellContext(root);
    if (!current || current.popup !== initialShell.popup || current.opener !== initialShell.opener || current.shellUrl !== initialShell.shellUrl || current.frameUrl !== initialShell.frameUrl || root.document !== receiverDocument) return null;
    return current;
  }
  function fail(message) { throw new Error(message); }
  function owner() { return String(root.state && root.state.archiveAccountKey || ''); }
  function environment(win) { return String(win.__SANJIE_ENVIRONMENT || ''); }
  function copy(value) {
    // Structured clone avoids constructing one giant JSON string for originals.
    if (typeof root.structuredClone === 'function') return root.structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }
  function text(value) { return typeof value === 'string' ? value : ''; }
  function image(value) {
    if (typeof value !== 'string' || !value) return false;
    if (/^data:image\/(?:png|jpeg|webp|avif|gif);base64,[A-Za-z0-9+/=\r\n]+$/.test(value)) return true;
    try { var url = new URL(value, root.location.origin); return url.protocol === 'https:' || url.protocol === 'blob:' && url.origin === root.location.origin; }
    catch (_) { return false; }
  }
  function safeClose(child) { try { if (child && !child.closed) child.close(); } catch (_) {} }
  function accountCheck(expected) {
    var bridge = root.SZ_CREATIVE_TOOLS_BRIDGE;
    if (!expected || expected === 'local' || owner() !== expected || !bridge || typeof bridge.getAccountKey !== 'function') return Promise.reject(new Error('账号尚未就绪，请重新打开工作台。'));
    return Promise.resolve(bridge.getAccountKey()).then(function (current) {
      if (String(current) !== expected || owner() !== expected) fail('登录账号已变化，本次没有导入图片。');
      return expected;
    });
  }
  function hydratePlan(input) {
    var item = input.item || {}, plan = copy(input.plan || {}), snapshot = item.linkPlanSnapshot || {};
    if (!plan.images || !Array.isArray(plan.images.products) || !Array.isArray(plan.images.models)) fail('原结果缺少商品素材快照，请从保留原图的清单重新打开。');
    ['products', 'models'].forEach(function (kind) {
      var refs = kind === 'products' ? item.productImages : item.modelImages;
      refs = Array.isArray(refs) ? refs : [];
      plan.images[kind].forEach(function (asset, index) {
        var prefix = kind === 'products' ? '@product:' : '@model:';
        if (asset.image === prefix + index) asset.image = refs[index];
        if (!image(asset.image) || refs[index] && refs[index] !== asset.image) fail('原结果的商品或模特素材绑定已经变化。');
      });
    });
    var workflow = root.SZ_LINK_IMAGE_WORKFLOW;
    if (!workflow || typeof workflow.verifyPlan !== 'function' || !workflow.verifyPlan(plan).ok) fail('原结果的完整方案无法核验，请重新打开已保存的结果。');
    if (plan.linkId !== input.linkId || plan.bundleId !== input.bundleId || plan.mode !== input.mode ||
        item.linkId !== plan.linkId || item.linkBundleId !== plan.bundleId || item.linkMode !== plan.mode ||
        item.linkPlanSignature !== plan.signature || snapshot.plan && snapshot.plan.signature !== plan.signature) fail('这张图片与当前链接、类型或方案不一致。');
    var shot = plan.shots.filter(function (entry) { return entry.id === item.linkShotId; })[0];
    if (!shot || !input.shot || JSON.stringify(shot) !== JSON.stringify(input.shot)) fail('该图片坑位的方案已经变化，请重新打开。');
    if (!image(item.url)) fail('该坑位尚无可复用的图片，请等待原图返回。');
    if (!plan.images.products.length) fail('该结果缺少商品原图，不能用生成图替代商品身份。');
    return plan;
  }
  function payloadFor(input) {
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, input.action)) fail('不支持的图片操作。');
    var plan = hydratePlan(input), item = input.item;
    // Copy only the legacy editor's business evidence. API credentials, old
    // execution contracts and receipt mutation handles never cross the window.
    var result = {};
    ['url', 'resultId', 'jobId', 'taskId', 'archiveAssetId', 'variant', 'variantName', 'businessRoleName',
      'prompt', 'negativePrompt', 'ratio', 'resolution', 'detailScreenIndex', 'detailScreenTotal'].forEach(function (key) {
      if (item[key] !== undefined) result[key] = copy(item[key]);
    });
    result.linkId = plan.linkId;
    result.labMode = 'main'; result.detailMode = 'main';
    result.productImages = plan.images.products.map(function (asset) { return asset.image; });
    result.productImageEvidence = result.productImages.map(function (url, index) { return { image: url, angle: 'product-' + (index + 1), label: '商品原图 ' + (index + 1) }; });
    result.modelImages = plan.images.models.map(function (asset) { return asset.image; });
    var provenance = {
      schema: 'LINK_RESULT_REUSE_V1', accountKey: input.accountKey, environment: environment(root),
      bundleId: plan.bundleId, linkId: plan.linkId, mode: plan.mode, shotId: input.shot.id,
      planSignature: plan.signature, resultId: text(item.resultId), sourceJobId: text(item.jobId),
      action: input.action, sourceLink: copy(plan.input.link), sourceShot: copy(input.shot)
    };
    result.creativeGuideOrigin = { tool: 'link-image', mode: plan.mode, shotId: input.shot.id, provenance: provenance };
    return { action: input.action, accountKey: input.accountKey, environment: environment(root), item: result,
      category: text(plan.category), input: copy(plan.input.link), provenance: provenance,
      products: result.productImages, models: result.modelImages };
  }
  function legacyDestination(action, token) {
    var url = new URL(PATH, root.location.origin);
    url.searchParams.set('source', 'web');
    if (action === 'guided-regenerate') url.searchParams.set('mode', 'main');
    else {
      url.searchParams.set('mode', 'viral'); url.searchParams.set('layout', '1'); url.searchParams.set('workflow', '1');
      url.searchParams.set('creativeRoute', action === 'style-refresh' ? 'style-refresh' : 'case');
    }
    url.searchParams.set('linkResultToken', token);
    return url;
  }
  function bound(record, child) {
    try {
      var context = shellContext(child);
      return !!context && record.child === context.popup && !record.child.closed &&
        context.shellUrl === record.url && context.frameUrl === record.frameUrl && context.opener === root &&
        (!record.receiver || record.receiver === child && record.receiverDocument === child.document) &&
        environment(child) === record.payload.environment && owner() === record.payload.accountKey;
    } catch (_) { return false; }
  }
  function open(input) {
    try {
      if (!sourceMode) fail('请从链接成图的原结果打开。');
      return openPayload(payloadFor(input || {}));
    } catch (error) { return Promise.resolve({ ok: false, error: error.message || String(error) }); }
  }
  function sameImages(left, right) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every(function (value, index) { return typeof value === 'string' && value === right[index]; });
  }
  function creativePayloadFor(item, expectedOwner) {
    if (!creativeSourceMode || !item || typeof expectedOwner !== 'string' || !expectedOwner || expectedOwner === 'local' || owner() !== expectedOwner) fail('请从当前账号的创作工具原结果打开。');
    var ui = root.SZ_CREATIVE_TOOLS_UI;
    if (!ui || typeof ui.getState !== 'function') fail('创作工具尚未就绪，请从原结果重试。');
    // The UI already returns a cloned snapshot. Read it once per explicit click;
    // neither polling nor the source's current configuration enters the payload.
    var current = ui.getState(), controller = current && current.controller;
    if (!current || !current.ready || current.startupFailed || !controller || controller.accountKey !== expectedOwner || ['clothing', 'buyer', 'refinement'].indexOf(current.tool) < 0) fail('结果所属工作台或账号已变化，本次没有导入图片。');
    var matches = (controller.slots || []).concat(controller.previousResults || []).filter(function (slot) { return slot.item && slot.item.resultId === item.resultId; });
    if (matches.length !== 1) fail('原结果暂不可核对，请从保留的创作结果重新打开。');
    var slot = matches[0], saved = slot.item, snapshot = saved.creativePlanSnapshot;
    var fields = ['resultId','jobId','creativeShotId','creativePlanSignature','creativeContractVersion','creativeTool','creativeMode','url'];
    if (fields.some(function (key) { return typeof saved[key] !== 'string' || !saved[key] || saved[key] !== item[key]; }) || saved.creativeTool !== current.tool || saved.resultId !== saved.jobId + ':creative:' + saved.creativeShotId || !slot.shot || slot.shot.id !== saved.creativeShotId || !['done','outdated'].includes(slot.status)) fail('结果身份已变化，请从原结果重新打开。');
    if (saved.accountKey && saved.accountKey !== expectedOwner || item.accountKey && item.accountKey !== expectedOwner || slot.archiveContext && (slot.archiveContext.accountKey || slot.archiveContext.accountId) && (slot.archiveContext.accountKey || slot.archiveContext.accountId) !== expectedOwner) fail('原结果所属账号不一致。');
    if (!snapshot || snapshot.version !== saved.creativeContractVersion || snapshot.version !== 'CREATIVE_TOOLS_V1' || snapshot.tool !== saved.creativeTool || snapshot.mode !== saved.creativeMode || snapshot.planSignature !== saved.creativePlanSignature || !snapshot.shot || snapshot.shot.id !== saved.creativeShotId || !snapshot.images || !Array.isArray(snapshot.images.products)) fail('原结果缺少可核对的素材快照，请保留原图后重新打开。');
    var products = saved.productImages, models = saved.modelImages || [];
    var plannedProducts = snapshot.images.products.map(function (asset) { return asset.image; });
    var plannedModels = snapshot.images.modelImage ? [snapshot.images.modelImage] : [];
    if (!image(saved.url) || !Array.isArray(products) || !products.length || products.length > 6 || products.some(function (value) { return !image(value); }) || !Array.isArray(models) || models.length > 1 || models.some(function (value) { return !image(value); }) || !sameImages(products, item.productImages) || !sameImages(models, item.modelImages || []) || !sameImages(products, plannedProducts) || !sameImages(models, plannedModels)) fail('原结果的商品或模特原图绑定已经变化。');
    var result = {};
    ['url','resultId','jobId','taskId','archiveAssetId','variant','variantName','businessRoleName','productName','businessBatchTitle','prompt','negativePrompt','ratio','resolution','detailScreenIndex','detailScreenTotal'].forEach(function (key) {
      if (typeof saved[key] === 'string' || typeof saved[key] === 'number') result[key] = saved[key];
    });
    var provenance = { schema: 'CREATIVE_RESULT_REUSE_V1', accountKey: expectedOwner, environment: environment(root), action: 'case-fission', tool: saved.creativeTool, mode: saved.creativeMode, shotId: saved.creativeShotId, planSignature: saved.creativePlanSignature, resultId: saved.resultId, sourceJobId: saved.jobId, sourceShot: copy(snapshot.shot) };
    result.labMode = 'main'; result.detailMode = 'main';
    result.productImages = products.slice(); result.modelImages = models.slice();
    result.productImageEvidence = products.map(function (url, index) { return { image: url, angle: 'product-' + (index + 1), label: '商品原图 ' + (index + 1) }; });
    result.creativeGuideOrigin = { tool: saved.creativeTool, mode: saved.creativeMode, shotId: saved.creativeShotId, provenance: provenance };
    return { action: 'case-fission', accountKey: expectedOwner, environment: environment(root), item: result, category: '', input: {}, provenance: provenance, products: products.slice(), models: models.slice() };
  }
  function openCreativeFission(item, expectedOwner) {
    try { return openPayload(creativePayloadFor(item, expectedOwner)); }
    catch (error) { return Promise.resolve({ ok: false, error: error.message || String(error) }); }
  }
  function openPayload(payload) {
    var child, token, url, frameUrl;
    try {
      if (owner() !== payload.accountKey || !payload.accountKey || payload.accountKey === 'local') fail('结果所属账号与当前账号不一致。');
      token = root.crypto.randomUUID(); url = shellDestination(payload.action, token).href; frameUrl = frameDestination(payload.action).href;
      // Keep the popup gesture before the first account-check await.
      child = root.open('about:blank', 'sz-link-result-' + token);
      if (!child) fail('浏览器拦截了新工作台，请允许本站打开弹出窗口后重试。');
    } catch (error) { return Promise.resolve({ ok: false, error: error.message || String(error) }); }
    return accountCheck(payload.accountKey).then(function () {
      if (child.closed) fail('新工作台已关闭，原结果仍保留。');
      return new Promise(function (resolve) {
        var record = { payload: payload, child: child, url: url, frameUrl: frameUrl, claimed: false, receiver: null, receiverDocument: null, resolve: resolve };
        record.timer = root.setTimeout(function () {
          records.delete(token); record.resolve({ ok: false, error: '图片导入未完成，请关闭新页后从原结果重试；原任务仍保留。' });
        }, TIMEOUT);
        records.set(token, record);
        try { child.location.replace(url); }
        catch (_) { root.clearTimeout(record.timer); records.delete(token); safeClose(child); resolve({ ok: false, error: '新工作台打开失败，原结果仍保留。' }); }
      });
    }).catch(function (error) { safeClose(child); return { ok: false, error: error.message || String(error) }; });
  }
  function claim(token, child, expected) {
    var record = records.get(token);
    if (!record || record.claimed || !bound(record, child) || expected !== record.payload.accountKey) return Promise.reject(new Error('本次图片交接已失效或不属于此工作台。'));
    // Lock before the asynchronous check so duplicate receivers cannot replay.
    record.claimed = true; record.receiver = child; record.receiverDocument = child.document;
    return accountCheck(expected).then(function () {
      if (!records.has(token) || !bound(record, child) || String(child.state && child.state.archiveAccountKey) !== expected) fail('导入期间账号或工作台已变化。');
      return copy(record.payload);
    });
  }
  function complete(token, child, response) {
    var record = records.get(token);
    if (!record || !record.claimed || !bound(record, child)) return false;
    root.clearTimeout(record.timer); records.delete(token);
    record.resolve(response && response.ok ? { ok: true, opened: true, imported: true, action: record.payload.action } : { ok: false, error: response && response.error || '图片导入失败，原结果仍保留。' });
    return true;
  }
  function materializeLocalImages(payload) {
    // Blob URLs belong to the document that created them. Read only those local
    // blobs before detaching the opener, so closing the source cannot break the
    // independent editor. HTTPS/data inputs remain byte-for-byte references;
    // this helper never fetches a provider URL or submits any generation call.
    var decoded = new Map();
    function retain(url) {
      if (url.indexOf('blob:') !== 0) return Promise.resolve(url);
      if (decoded.has(url)) return decoded.get(url);
      var work = Promise.resolve().then(function () {
        if (typeof root.fetch !== 'function' || typeof root.FileReader !== 'function') fail('浏览器无法保留本机结果图，请返回原结果重试。');
        return root.fetch(url);
      }).then(function (response) {
        if (!response || !response.ok) fail('本机结果图已经失效，请从保留的原图重新打开。');
        return response.blob();
      }).then(function (blob) {
        if (!blob || blob.size > 24 * 1024 * 1024) fail('本机结果图过大，无法导入当前编辑器；原图仍保留。');
        return new Promise(function (resolve, reject) {
          var reader = new root.FileReader();
          reader.onerror = function () { reject(new Error('本机原图读取失败，请从原结果重试。')); };
          reader.onload = function () { if (image(reader.result)) resolve(reader.result); else reject(new Error('本机原图格式无法导入，请保留原件后重新选择。')); };
          reader.readAsDataURL(blob);
        });
      });
      decoded.set(url, work); return work;
    }
    return Promise.all([retain(payload.item.url), Promise.all(payload.products.map(retain)), Promise.all(payload.models.map(retain))]).then(function (parts) {
      payload.item.url = parts[0]; payload.products = parts[1]; payload.models = parts[2];
      payload.item.productImages = parts[1].slice(); payload.item.modelImages = parts[2].slice();
      payload.item.productImageEvidence = parts[1].map(function (url, index) { return { image: url, angle: 'product-' + (index + 1), label: '商品原图 ' + (index + 1) }; });
      return payload;
    });
  }
  function show(message, error) {
    var document = root.document, notice = document.getElementById('linkResultImportNotice');
    if (!notice) {
      notice = document.createElement('p'); notice.id = 'linkResultImportNotice'; notice.setAttribute('role', error ? 'alert' : 'status');
      notice.style.cssText = 'margin:12px 0;padding:12px 16px;border:1px solid var(--border,#424b24);border-radius:10px;color:var(--text,#eeeedd);background:var(--panel,#19200f);font:14px/1.6 system-ui,sans-serif';
      var hero = document.querySelector('.hero'), app = document.querySelector('.app');
      if (hero && hero.parentNode) hero.parentNode.insertBefore(notice, hero.nextSibling);
      else if (app) app.insertBefore(notice, app.firstChild);
      else document.body.appendChild(notice);
    }
    notice.textContent = message;
  }
  function ensureFresh() {
    var state = root.state || {}, references = state.refImages || [], products = state.productImages || {}, models = state.modelImages || {};
    var promptRecords = state.referencePrompts || {};
    var toolBridge = root.SanjiePromptLabTaskBridge;
    var taskState = toolBridge && typeof toolBridge.getState === 'function' ? toolBridge.getState() : null;
    var occupied = state.refImage || references.length || Object.keys(products).some(function (key) { return !!products[key]; }) ||
      Object.keys(models).some(function (key) { return !!models[key]; }) || Object.keys(promptRecords).some(function (key) { return !!promptRecords[key]; }) ||
      (state.linkList || []).length || state.linkBundle || taskState && taskState.busy ||
      state.referenceDetail && state.referenceDetail.currentBlueprint ||
      (state.results || []).length || state.activePromptRecord || state.activeJobId || Object.keys(state.activeJobIds || {}).length ||
      state.guideDraft || state.styleRefresh && (state.styleRefresh.promptRecord || state.styleRefresh.run) || state.linkResultDraftId;
    if (occupied) fail('这个工作台已有素材、草稿或任务，本次没有覆盖；请保留当前页面并从原结果重新打开新工作台。');
  }
  function apply(payload) {
    ensureFresh();
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, payload.action) || payload.accountKey !== owner() || payload.environment !== environment(root)) fail('图片交接与当前账号或环境不一致。');
    var accepted = initialShell ? currentShell() : null;
    if (initialShell ? !accepted || accepted.action !== payload.action : legacyDestination(payload.action, tokenInUrl).href !== root.location.href || root.parent && root.parent !== root) fail('图片交接的目标工具已变化。');
    if (typeof root.setProductAngle !== 'function' || typeof root.setModelAngle !== 'function' || !root.SZ_CREATIVE_TOOLS_BRIDGE || typeof root.SZ_CREATIVE_TOOLS_BRIDGE.openResultAction !== 'function') fail('图片编辑入口尚未就绪，请从原结果重试。');
    if (payload.action === 'case-fission' && typeof root.setRefImage !== 'function') fail('案例裂变入口尚未就绪。');
    // These legacy routes use a fresh in-memory workspace: they do not load or
    // write the product-first/creative/link IndexedDB draft stores. A unique ID
    // keeps this draft's provenance distinct even if another tool tab is open.
    root.state.linkResultDraftId = root.crypto.randomUUID();
    root.state.linkResultProvenance = copy(payload.provenance);
    root.state.linkResultSourceEvidence = { products: payload.products.slice(), models: payload.models.slice() };
    ['front', 'side', 'back'].forEach(function (angle, index) {
      if (payload.products[index]) root.setProductAngle(angle, payload.products[index], /^https:\/\//.test(payload.products[index]) ? payload.products[index] : '');
      if (payload.models[index]) root.setModelAngle(angle, payload.models[index], /^https:\/\//.test(payload.models[index]) ? payload.models[index] : '');
    });
    var fields = { linkCategory: payload.category, styleRefreshCategory: payload.category,
      positioning: payload.input['链接定位'] || '', imageCopy: payload.input[payload.action === 'guided-regenerate' ? '主图核心文案' : '详情页文案'] || '' };
    Object.keys(fields).forEach(function (key) { var field = root.document.getElementById(key); if (field) field.value = fields[key]; });
    var opened;
    if (payload.action === 'guided-regenerate') opened = root.SZ_CREATIVE_TOOLS_BRIDGE.openResultAction('edit', payload.item);
    else if (payload.action === 'case-fission') {
      root.setRefImage(payload.item.url, /^https:\/\//.test(payload.item.url) ? payload.item.url : '');
    }
    return Promise.resolve(opened).then(function () {
      var limit = payload.action === 'guided-regenerate' || payload.products.length <= 3 ? '' : ' 当前工具有 3 个主体位，已载入前 3 张；其余 ' + (payload.products.length - 3) + ' 张仍保留在源清单，请核对素材后继续。';
      show('已从原结果创建独立' + ACTIONS[payload.action] + '草稿，原图和原清单任务保留。请核对素材与方案后手动生成。' + limit, false);
      return { ok: true, imported: true, action: payload.action };
    });
  }
  function receive() {
    if (receiving) return receiving;
    var accepted = initialShell ? currentShell() : null;
    var opener = accepted ? accepted.opener : initialShell ? null : root.parent && root.parent !== root ? null : root.opener;
    if (!tokenInUrl || !opener) return Promise.resolve({ ok: false, error: '本次图片交接已失效，请从原结果重新打开。' });
    var expected;
    receiving = Promise.resolve().then(function () {
      var ready = root.SZ_SCENE_EXTENSION_BRIDGE;
      if (!ready || typeof ready.ready !== 'function') fail('目标工具尚未就绪，请返回原结果重试。');
      return ready.ready();
    }).then(function (ready) {
      if (!ready || !ready.ok) fail(ready && ready.error || '目标工具配置尚未就绪。');
      expected = owner(); return accountCheck(expected);
    }).then(function () {
      if (opener.location.origin !== root.location.origin || environment(opener) !== environment(root) || !opener.SZ_LINK_RESULT_HANDOFF) fail('图片交接来源或环境已变化。');
      return opener.SZ_LINK_RESULT_HANDOFF.claim(tokenInUrl, root, expected);
    }).then(materializeLocalImages).then(function (payload) {
      return accountCheck(expected).then(function () {
        if (environment(opener) !== environment(root) || String(opener.state && opener.state.archiveAccountKey) !== expected) fail('导入前账号已经变化，本次没有导入图片。');
        return apply(payload);
      });
    }).then(function (response) {
      if (!opener.SZ_LINK_RESULT_HANDOFF.complete(tokenInUrl, root, response)) fail('图片已导入，但交接回执已失效；请勿重复点击。');
      // The imported draft no longer depends on the source tab. Clearing opener
      // prevents subsequent navigation in the new tool from touching the source.
      try { if (initialShell) initialShell.popup.opener = null; else root.opener = null; } catch (_) {}
      return response;
    }).catch(function (error) {
      var response = { ok: false, error: error.message || String(error) };
      try { opener.SZ_LINK_RESULT_HANDOFF.complete(tokenInUrl, root, response); } catch (_) {}
      show(response.error + ' 原结果与任务仍保留。', true); return response;
    });
    return receiving;
  }
  root.SZ_LINK_RESULT_HANDOFF = Object.freeze({ open: open, openCreativeFission: openCreativeFission, claim: claim, complete: complete, receive: receive });
  if (tokenInUrl && root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', receive, { once: true });
    else receive();
  }
})(typeof window !== 'undefined' ? window : globalThis);
