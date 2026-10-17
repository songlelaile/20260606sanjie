/* Owner-bound SKU receipt journal. No network or provider dispatch occurs here. */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  root.SZ_SKU_DURABLE_RECEIPT = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  var PLAN = 'SKU_SUBJECT_REPLACE_PLAN_V1', JOURNAL = 'SKU_DURABLE_RECEIPT_V1';
  var SHA = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  var FIELDS = ['version','receiptId','jobId','accountKey','workspaceKey','taskId','shotId','batchId','planSignatureHash'];
  function fail(code, message) { var error = new Error(message || 'SKU 原任务回执需核对，请保留原任务。'); error.code = code; return error; }
  function invalid() { throw fail('SKU_RECEIPT_PLAN_INVALID', 'SKU 原件或冻结方案身份不完整，本次未提交生成。'); }
  function plain(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var prototype = Object.getPrototypeOf(value), constructor = prototype && Object.getOwnPropertyDescriptor(prototype,'constructor');
    return prototype === null || Object.getPrototypeOf(prototype) === null && constructor && typeof constructor.value === 'function' && constructor.value.name === 'Object';
  }
  function record(value, fields, required) {
    if (!plain(value)) invalid();
    var out = {};
    Reflect.ownKeys(value).forEach(function (key) {
      var descriptor = Object.getOwnPropertyDescriptor(value,key);
      if (typeof key !== 'string' || fields.indexOf(key) < 0 || !descriptor || !Object.prototype.hasOwnProperty.call(descriptor,'value')) invalid();
      out[key] = descriptor.value;
    });
    (required || fields).forEach(function (key) { if (!Object.prototype.hasOwnProperty.call(out,key)) invalid(); });
    return out;
  }
  function str(value, max, empty) { if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid(); return value; }
  function id(value) { value = str(value,240); if (!/^[A-Za-z0-9_.:@+-]+$/.test(value)) invalid(); return value; }
  function sha(value) { if (!SHA.test(value || '')) invalid(); return value; }
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (plain(value)) return '{' + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ':' + canonical(value[key]); }).join(',') + '}';
    return JSON.stringify(value);
  }
  function digest(bytes) {
    if (!root.crypto || !root.crypto.subtle || typeof TextEncoder !== 'function') return Promise.reject(fail('SKU_RECEIPT_CRYPTO_UNAVAILABLE','当前浏览器无法保存 SKU 回执身份，本次未提交生成。'));
    return root.crypto.subtle.digest('SHA-256',bytes).then(function (value) { return Array.from(new Uint8Array(value)).map(function (byte) { return byte.toString(16).padStart(2,'0'); }).join(''); });
  }
  function textSha(value) { return digest(new TextEncoder().encode(value)); }
  function image(value) { value = str(value,64*1024*1024); if (!/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/i.test(value)) invalid(); return value; }
  function imageSha(value) {
    value = image(value);
    var binary = root.atob(value.slice(value.indexOf(',')+1));
    if (!binary.length || binary.length > 32*1024*1024) invalid();
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return digest(bytes);
  }
  function safeTree(value, fields) {
    var out = record(value,fields,[]);
    Object.keys(out).forEach(function (key) {
      var item = out[key];
      if (typeof item === 'string') out[key] = str(item,512,true);
      else if (typeof item === 'number') { if (!Number.isFinite(item)) invalid(); }
      else if (typeof item !== 'boolean') invalid();
    });
    return out;
  }
  function contract(value) {
    var out = record(value,['version','batchLockId','contractFingerprint','coordinateSpace','canvas','baseImageFingerprint','replacementSubjectFingerprint','generatedSkuBadge','typography','subject','variableWhitelist','immutableFromBase'],['version','batchLockId','contractFingerprint','canvas','subject']);
    ['version','batchLockId','contractFingerprint','coordinateSpace','baseImageFingerprint','replacementSubjectFingerprint'].forEach(function (key) { if (out[key] !== undefined) out[key] = str(out[key],512); });
    if (out.version !== 'SKU_SUBJECT_REPLACE_V2') invalid();
    out.canvas = safeTree(out.canvas,['ratio','width','height','safeMargin']);
    if (!Number.isSafeInteger(out.canvas.width) || !Number.isSafeInteger(out.canvas.height) || out.canvas.width < 256 || out.canvas.height < 256 || out.canvas.width > 4096 || out.canvas.height > 4096 || typeof out.canvas.ratio !== 'string') invalid();
    if (out.generatedSkuBadge !== undefined && out.generatedSkuBadge !== false) invalid();
    if (out.typography !== undefined) out.typography = safeTree(out.typography,['renderMode','addText','alterText']);
    var subject = record(out.subject,['renderMode','replacementOnly','preservePlacement','preserveScale','preservePerspective','preserveLightingAndShadow','authorizedRegion','identityVerification'],['authorizedRegion']);
    var region = record(subject.authorizedRegion,['x','y','w','h','confirmed'],['x','y','w','h']);
    ['x','y','w','h'].forEach(function (key) { if (typeof region[key] !== 'number' || !Number.isFinite(region[key]) || region[key] < 0 || region[key] > 1) invalid(); });
    if (!region.w || !region.h || region.x+region.w > 1 || region.y+region.h > 1 || region.confirmed !== true) invalid();
    subject.authorizedRegion = region;
    if (subject.identityVerification !== undefined) subject.identityVerification = safeTree(subject.identityVerification,['required','version','foregroundExtraction','colorHistogram','edgeHistogram','contourDescriptor','microTextGuard','minColorSimilarity','minEdgeSimilarity','minContourSimilarity']);
    Object.keys(subject).filter(function (key) { return key !== 'authorizedRegion' && key !== 'identityVerification'; }).forEach(function (key) { if (key === 'renderMode') str(subject[key],80); else if (typeof subject[key] !== 'boolean') invalid(); });
    out.subject = subject;
    if (out.variableWhitelist !== undefined) out.variableWhitelist = safeTree(out.variableWhitelist,['subjectIdentity','backgroundChanges','textChanges','layoutChanges','newProps','generatedLabels']);
    if (out.immutableFromBase !== undefined) {
      var immutable = out.immutableFromBase, clean = [];
      if (!Array.isArray(immutable) || immutable.length > 100 || Reflect.ownKeys(immutable).some(function (key) {
        return key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= immutable.length);
      })) invalid();
      for (var index = 0; index < immutable.length; index++) {
        var descriptor = Object.getOwnPropertyDescriptor(immutable,String(index));
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor,'value')) invalid();clean.push(str(descriptor.value,200));
      }
      out.immutableFromBase = clean;
    }
    return out;
  }
  function output(value) {
    var out = record(value,['size','ratio','resolution','width','height']);
    ['size','ratio','resolution'].forEach(function (key) { out[key] = str(out[key],80); });
    if (!Number.isSafeInteger(out.width) || !Number.isSafeInteger(out.height) || out.width < 256 || out.height < 256 || out.width > 4096 || out.height > 4096 || out.size !== out.width+'*'+out.height) invalid();
    return out;
  }
  function geometry(value) {
    var out = record(value,['version','contractFingerprint','adapter','requestedSize','effectiveSize']);
    Object.keys(out).forEach(function (key) { out[key] = str(out[key],512); });
    if (out.version !== 'SKU_PROVIDER_GEOMETRY_V1') invalid();
    ['requestedSize','effectiveSize'].forEach(function (key) { if (!/^\d{3,4}\*\d{3,4}$/.test(out[key])) invalid(); });
    return out;
  }
  function model(value) {
    var out = record(value,['provider','imageModel','imageAdapter','imageEndpoint']);
    Object.keys(out).forEach(function (key) { out[key] = str(out[key],512,key === 'imageEndpoint'); });
    if (out.imageEndpoint) { var url = new URL(out.imageEndpoint); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) invalid(); }
    return out;
  }
  function modelFor(config) { return model({provider:String(config && config.provider || ''),imageModel:String(config && config.imageModel || ''),imageAdapter:String(config && config.imageAdapter || ''),imageEndpoint:String(config && config.imageEndpoint || '')}); }
  function source(value) { var out = record(value,['assetId','originalSha256','derivativeSha256']); out.assetId = str(out.assetId,1024); out.originalSha256 = sha(out.originalSha256); out.derivativeSha256 = sha(out.derivativeSha256); return out; }
  function validatePlan(value) {
    var out = record(value,['schema','version','accountKey','workspaceKey','taskId','shotId','batchId','sources','providerInputs','contract','output','geometry','promptSha256','negativePromptSha256','model','modelSha256']);
    if (out.schema !== PLAN || out.version !== 1) invalid();
    ['accountKey','workspaceKey','taskId','shotId','batchId'].forEach(function (key) { out[key] = id(out[key]); });
    if (out.shotId !== 'subject-replace') invalid();
    out.sources = record(out.sources,['base','subject']); out.sources.base = source(out.sources.base); out.sources.subject = source(out.sources.subject);
    out.providerInputs = record(out.providerInputs,['baseSha256','subjectSha256']); sha(out.providerInputs.baseSha256); sha(out.providerInputs.subjectSha256);
    if (out.sources.base.assetId === out.sources.subject.assetId || out.providerInputs.baseSha256 === out.providerInputs.subjectSha256) invalid();
    out.contract = contract(out.contract); out.output = output(out.output); out.geometry = geometry(out.geometry); out.model = model(out.model);
    ['promptSha256','negativePromptSha256','modelSha256'].forEach(function (key) { out[key] = sha(out[key]); });
    if (out.geometry.adapter !== out.model.imageAdapter || out.geometry.contractFingerprint !== out.contract.contractFingerprint || out.output.width !== out.contract.canvas.width || out.output.height !== out.contract.canvas.height || out.output.ratio !== out.contract.canvas.ratio) invalid();
    return out;
  }
  function compute(plan) { return Promise.resolve().then(function () { return textSha(canonical(validatePlan(plan))); }); }
  function identity(value) {
    var out = record(value,FIELDS);
    if (out.version !== 1 || !UUID.test(out.receiptId || '')) invalid();
    ['jobId','accountKey','workspaceKey','taskId','shotId','batchId'].forEach(function (key) { out[key] = id(out[key]); });
    sha(out.planSignatureHash); return out;
  }
  function env() { return root.__SANJIE_ENVIRONMENT ? ':environment:' + encodeURIComponent(String(root.__SANJIE_ENVIRONMENT)) : ''; }
  function operation(dbName,storeName,mode,create,work) {
    return new Promise(function (resolve,reject) {
      var db, tx, result, finished = false;
      var timer = root.setTimeout(function () { done(fail('SKU_RECEIPT_STORAGE_TIMEOUT','SKU 回执存储超时，本次未提交生成。'),true); },10000);
      function done(error,abort) { if (finished) return; finished = true;root.clearTimeout(timer);if (abort && tx) { try { tx.abort(); } catch (_) {} }if (db) { try { db.close(); } catch (_) {} }error ? reject(error) : resolve(result); }
      function guarded(callback) { return function () { if (finished) return;try { callback(); } catch (error) { done(error,true); } }; }
      if (!root.indexedDB) { done(fail('SKU_RECEIPT_STORAGE_UNAVAILABLE'));return; }
      var open;
      try { open = root.indexedDB.open(dbName+env(),1); } catch (error) { done(error);return; }
      open.onupgradeneeded = function () { if (!create || finished) { try { open.transaction.abort(); } catch (_) {}return; }try { open.result.createObjectStore(storeName,{keyPath:'id'}); } catch (error) { done(error,true); } };
      open.onerror = function () { done(fail('SKU_RECEIPT_STORAGE_UNAVAILABLE','无法读取 SKU 原件或回执存储，本次未提交生成。')); };
      open.onblocked = function () { done(fail('SKU_RECEIPT_STORAGE_BLOCKED')); };
      open.onsuccess = function () {
        db = open.result;if (finished) { db.close();return; }
        db.onversionchange = function () { db.close(); };
        try {
          tx = db.transaction(storeName,mode);tx.oncomplete = function () { done(); };tx.onerror = tx.onabort = function () { done(fail('SKU_RECEIPT_STORAGE_FAILED','SKU 回执存储失败，本次未提交生成。'),true); };
          work(tx.objectStore(storeName),function (value) { result = value; },guarded,function (error) { done(error,true); });
        } catch (error) { done(error,true); }
      };
    });
  }
  function journal(mode,work) { return operation('sz_sku_durable_receipt_v1','entries',mode,true,work); }
  function key(owner,legacyKey) { return JSON.stringify(['receipt',id(owner),str(legacyKey,2048)]); }
  function original(owner,imageValue) {
    return textSha(image(imageValue)).then(function (derivativeSha) {
      var derivative = owner+':'+derivativeSha;
      return operation('sz_image_upload_originals_v1','originals','readonly',false,function (store,result,guard) {
        var get = store.index('derivative').get(derivative);get.onsuccess = guard(function () { result(get.result); });
      }).then(function (raw) {
        if (!raw || raw.accountKey !== owner || raw.derivative !== derivative || !SHA.test(raw.hash || '') || raw.id !== owner+':'+raw.hash+':'+derivative || !raw.blob || typeof raw.blob.arrayBuffer !== 'function' || raw.bytes !== raw.blob.size || raw.bytes < 1 || raw.bytes > 20*1024*1024) throw fail('SKU_RECEIPT_ORIGINAL_REQUIRED','请重新上传并保存当前账号的对象底图和主体原件，本次未提交生成。');
        return raw.blob.arrayBuffer().then(digest).then(function (hash) { if (hash !== raw.hash) throw fail('SKU_RECEIPT_ORIGINAL_MISMATCH');return {assetId:raw.id,originalSha256:hash,derivativeSha256:derivativeSha}; });
      });
    });
  }
  function metadata(value) {
    var out = record(value || {},['skuId','skuCode','title','attribute','index','archiveBatchTitle'],[]);
    ['skuId','skuCode','title','attribute','archiveBatchTitle'].forEach(function (name) { if (out[name] !== undefined) out[name] = str(out[name],1000,true); });
    if (out.index !== undefined && (!Number.isSafeInteger(out.index) || out.index < 0 || out.index > 10000)) invalid();return out;
  }
  function snapshot(value) {
    var out = record(value,['baseImage','subjectImage','providerImages','contract','geometry','output','prompt','negativePrompt','model','metadata']);
    out.baseImage = image(out.baseImage);out.subjectImage = image(out.subjectImage);
    out.providerImages = record(out.providerImages,['base','subject']);out.providerImages.base = image(out.providerImages.base);out.providerImages.subject = image(out.providerImages.subject);
    out.contract = contract(out.contract);out.geometry = geometry(out.geometry);out.output = output(out.output);out.prompt = str(out.prompt,100000);out.negativePrompt = str(out.negativePrompt,100000,true);out.model = model(out.model);out.metadata = metadata(out.metadata);return out;
  }
  function payloadFrom(recordValue) {
    var snap = recordValue.snapshot;
    return {labMode:'sku',detailMode:'sku',promptSource:'sku',skuDurablePlan:recordValue.plan,batchId:recordValue.identity.batchId,
      skuSourceImages:{base:snap.baseImage,subject:snap.subjectImage},editBaseImage:snap.providerImages.base,
      productImage:snap.providerImages.subject,productImages:[snap.providerImages.subject],prompt:snap.prompt,negativePrompt:snap.negativePrompt,
      skuVisualLock:snap.contract,outputSize:snap.output.size,outputRatio:snap.output.ratio,outputResolution:snap.output.resolution,size:snap.geometry.requestedSize};
  }
  function validateContent(payload,config,owner,receiptIdentity,storedReceipt) {
    return Promise.resolve().then(function () {
      owner = id(owner);var plan = validatePlan(payload && payload.skuDurablePlan), dto = identity(receiptIdentity), modelValue = modelFor(config);
      var sourceImages = record(payload && payload.skuSourceImages,['base','subject']);image(sourceImages.base);image(sourceImages.subject);
      if (payload.labMode !== 'sku' || payload.detailMode !== 'sku' || payload.promptSource !== 'sku' || payload.batchId !== dto.batchId || !Array.isArray(payload.productImages) || payload.productImages.length !== 1 || payload.productImage !== payload.productImages[0] || payload.referenceImage || payload.referenceImages && payload.referenceImages.length || payload.modelImages && payload.modelImages.length || payload.visualTemplateImages && payload.visualTemplateImages.length) invalid();
      if (dto.accountKey !== owner || plan.accountKey !== owner || ['workspaceKey','taskId','shotId','batchId'].some(function (field) { return dto[field] !== plan[field]; }) || canonical(plan.model) !== canonical(modelValue) || canonical(plan.contract) !== canonical(contract(payload.skuVisualLock)) || payload.outputSize !== plan.output.size || payload.outputRatio !== plan.output.ratio || payload.outputResolution !== plan.output.resolution || payload.size !== plan.geometry.requestedSize) invalid();
      return Promise.all([compute(plan),imageSha(payload.editBaseImage),imageSha(payload.productImages[0]),textSha(str(payload.prompt,100000)),textSha(str(payload.negativePrompt || '',100000,true)),textSha(canonical(modelValue)),original(owner,sourceImages.base),original(owner,sourceImages.subject)]).then(function (values) {
        if (dto.planSignatureHash !== values[0] || plan.providerInputs.baseSha256 !== values[1] || plan.providerInputs.subjectSha256 !== values[2] || plan.promptSha256 !== values[3] || plan.negativePromptSha256 !== values[4] || plan.modelSha256 !== values[5] || canonical(plan.sources.base) !== canonical(values[6]) || canonical(plan.sources.subject) !== canonical(values[7])) invalid();
        return validatePaidPlan(plan,dto,storedReceipt).then(function () { return {ok:true,identity:dto,plan:plan,geometry:plan.geometry}; });
      });
    }).catch(function (error) { return {ok:false,code:error.code || 'SKU_RECEIPT_PLAN_INVALID',error:error.message || String(error)}; });
  }
  function validate(payload,config,owner,receiptIdentity) { return validateContent(payload,config,owner,receiptIdentity,false); }
  function checked(raw,owner,legacyKey) {
    if (!raw) return Promise.resolve(null);
    return Promise.resolve().then(function () {
      var out = record(raw,['schema','id','owner','key','identity','plan','snapshot','state','createdAt']);
      if (out.schema !== JOURNAL || out.id !== key(owner,legacyKey) || out.owner !== owner || out.key !== legacyKey || ['prepared','dispatched','acknowledged','not-submitted'].indexOf(out.state) < 0 || !Number.isSafeInteger(out.createdAt)) invalid();
      out.identity = identity(out.identity);out.plan = validatePlan(out.plan);out.snapshot = snapshot(out.snapshot);
      return validateContent(payloadFrom(out),out.snapshot.model,owner,out.identity,true).then(function (result) { if (!result.ok) throw fail(result.code,result.error);return out; });
    });
  }
  function read(owner,legacyKey) {
    return Promise.resolve().then(function () { owner = id(owner);legacyKey = str(legacyKey,2048);return journal('readonly',function (store,result,guard) { var get = store.get(key(owner,legacyKey));get.onsuccess = guard(function () { result(get.result || null); }); }); }).then(function (raw) { return checked(raw,owner,legacyKey); });
  }
  function randomId(prefix) { if (!root.crypto || typeof root.crypto.randomUUID !== 'function') throw fail('SKU_RECEIPT_CRYPTO_UNAVAILABLE');return prefix+root.crypto.randomUUID(); }
  var PAID_AUTH = 'SKU_PAID_WORKSPACE_AUTHORIZATION_V1';
  var PAID_NOTICE = '旧任务费用仍待核对，新批次可能另外扣费。仅另建任务，点击生成时才提交。';
  var paidIntentTokens = new WeakMap();
  function paidActiveKey(owner) { return JSON.stringify(['paid-active',id(owner)]); }
  function paidAuthKey(owner,workspaceKey) { return JSON.stringify(['paid-authorization',id(owner),id(workspaceKey)]); }
  function beginPaidWorkspaceIntent(event,owner) {
    try {
      var type = Object.getOwnPropertyDescriptor(root.Event.prototype,'type').get.call(event);
      var target = Object.getOwnPropertyDescriptor(root.Event.prototype,'currentTarget').get.call(event);
      var trusted = Object.getOwnPropertyDescriptor(event,'isTrusted');
      if (!(event instanceof root.Event) || type !== 'click' || !trusted || typeof trusted.get !== 'function' ||
          trusted.get.call(event) !== true || !target || !target.isConnected || target.disabled ||
          !root.document || root.document.getElementById('skuNewPaidBatchBtn') !== target) invalid();
      var token = {};
      paidIntentTokens.set(token,{owner:id(owner),environment:env(),target:target,createdAt:Date.now()});
      return token;
    } catch (_) { throw fail('SKU_PAID_EXPLICIT_ACTION_REQUIRED','请使用“另建付费 SKU 批次”按钮明确授权，原任务不会被解锁。'); }
  }
  function checkPaidParent(parent,owner,unchanged) {
    var out = record(parent,['key','raw','rawSha256','jobId']);
    out.key = str(out.key,2048);out.raw = str(out.raw,8192);out.jobId = id(out.jobId);sha(out.rawSha256);
    var prefix = 'sz.legacy-image-receipt.v1:'+encodeURIComponent(owner)+':';
    if (out.key.indexOf(prefix) !== 0 || !SHA.test(out.key.slice(prefix.length))) invalid();
    var marker;
    try { marker = JSON.parse(out.raw); } catch (_) { invalid(); }
    if (!plain(marker) || Object.keys(marker).some(function (field) { return ['version','state','jobId','createdAt','code','taskId','receiptId','storage'].indexOf(field) < 0; }) || marker.version !== 1 || marker.jobId !== out.jobId ||
        ['pending','uncertain'].indexOf(marker.state) < 0) invalid();
    if (unchanged && (!root.localStorage || root.localStorage.getItem(out.key) !== out.raw))
      throw fail('SKU_PAID_PARENT_CHANGED','原任务标记已变化，新任务尚未提交；请重新核对原任务。');
    return out;
  }
  function checkedPaidAuthorization(raw,owner,workspaceKey) {
    return Promise.resolve().then(function () {
      owner = id(owner);workspaceKey = id(workspaceKey);
      var out = record(raw,['schema','id','owner','environment','workspaceKey','createdAt','notice','parents','tasks','authorizationSha256']);
      if (out.schema !== PAID_AUTH || out.id !== paidAuthKey(owner,workspaceKey) || out.owner !== owner ||
          out.environment !== env() || out.workspaceKey !== workspaceKey || !/^sku_paid_workspace_/.test(workspaceKey) ||
          !Number.isSafeInteger(out.createdAt) || out.notice !== PAID_NOTICE || !Array.isArray(out.parents) ||
          !out.parents.length || out.parents.length > 100 || !Array.isArray(out.tasks) || !out.tasks.length || out.tasks.length > 100) invalid();
      sha(out.authorizationSha256);
      var keys = {},pairs = {},tasks = {};
      out.parents = out.parents.map(function (parent) {
        var clean = checkPaidParent(parent,owner,false);if (keys[clean.key]) invalid();keys[clean.key] = true;return clean;
      });
      out.tasks = out.tasks.map(function (task) {
        var clean = record(task,['taskId','parentLegacyKey','sources','sourceImages','snapshot','metadata','output','model']);
        clean.parentLegacyKey = str(clean.parentLegacyKey,2048);if (!keys[clean.parentLegacyKey]) invalid();
        clean.taskId = id(clean.taskId);if (!/^sku_paid_task_/.test(clean.taskId) || tasks[clean.taskId]) invalid();tasks[clean.taskId] = true;
        clean.sources = record(clean.sources,['base','subject']);
        ['base','subject'].forEach(function (role) {
          var asset = record(clean.sources[role],['assetId','originalSha256','derivativeSha256']);
          asset.assetId = str(asset.assetId,2048);sha(asset.originalSha256);sha(asset.derivativeSha256);
          if (asset.assetId !== owner+':'+asset.originalSha256+':'+owner+':'+asset.derivativeSha256) invalid();clean.sources[role] = asset;
        });
        clean.sourceImages = record(clean.sourceImages,['base','subject']);clean.sourceImages.base = image(clean.sourceImages.base);clean.sourceImages.subject = image(clean.sourceImages.subject);
        var pair = canonical(clean.sources);if (pairs[pair]) invalid();pairs[pair] = true;
        clean.metadata = metadata(clean.metadata);clean.output = output(clean.output);clean.model = model(clean.model);clean.snapshot = snapshot(clean.snapshot);
        if (clean.snapshot.baseImage !== clean.sourceImages.base || clean.snapshot.subjectImage !== clean.sourceImages.subject ||
            canonical(clean.snapshot.output) !== canonical(clean.output) || canonical(clean.snapshot.model) !== canonical(clean.model) ||
            canonical(clean.snapshot.metadata) !== canonical(clean.metadata)) invalid();return clean;
      });
      if (out.tasks.length !== out.parents.length || new Set(out.tasks.map(function (task) { return task.parentLegacyKey; })).size !== out.parents.length) invalid();
      var signature = Object.assign({},out);delete signature.authorizationSha256;
      return Promise.all([textSha(canonical(signature))].concat(out.parents.map(function (parent) { return textSha(parent.raw); }))).then(function (hashes) {
        if (hashes[0] !== out.authorizationSha256 || out.parents.some(function (parent,index) { return parent.rawSha256 !== hashes[index+1]; })) invalid();
        return Promise.all(out.tasks.map(function (task) { return Promise.all([original(owner,task.sourceImages.base),original(owner,task.sourceImages.subject)]).then(function (assets) { if (canonical(task.sources) !== canonical({base:assets[0],subject:assets[1]})) invalid(); }); })).then(function () { return out; });
      });
    });
  }
  function readPaidAuthorization(owner,workspaceKey) {
    return journal('readonly',function (store,result,guard) {
      var get = store.get(paidAuthKey(owner,workspaceKey));get.onsuccess = guard(function () { result(get.result || null); });
    }).then(function (raw) {
      if (!raw) throw fail('SKU_PAID_AUTHORIZATION_REQUIRED','缺少持久的新付费任务授权，本次不会提交生成。');
      return checkedPaidAuthorization(raw,owner,workspaceKey);
    });
  }
  function readActivePaidWorkspace(owner) {
    return Promise.resolve().then(function () {
      owner = id(owner);return journal('readonly',function (store,result,guard) {
        var get = store.get(paidActiveKey(owner));get.onsuccess = guard(function () { result(get.result || null); });
      });
    }).then(function (raw) {
      if (!raw) return null;
      var pointer = record(raw,['schema','id','owner','workspaceKey']);
      if (pointer.schema !== 'SKU_PAID_ACTIVE_WORKSPACE_V1' || pointer.id !== paidActiveKey(owner) || pointer.owner !== owner) invalid();
      return readPaidAuthorization(owner,id(pointer.workspaceKey));
    });
  }
  function authorizePaidWorkspace(params) {
    return Promise.resolve().then(function () {
      var p = record(params,['owner','intent','tasks','parents']);p.owner = id(p.owner);
      var intent = paidIntentTokens.get(p.intent);paidIntentTokens.delete(p.intent);
      if (!intent || intent.owner !== p.owner || intent.environment !== env() || Date.now()-intent.createdAt > 60000 ||
          !intent.target.isConnected || root.document.getElementById('skuNewPaidBatchBtn') !== intent.target)
        throw fail('SKU_PAID_EXPLICIT_ACTION_REQUIRED');
      return readActivePaidWorkspace(p.owner).then(function (existing) {
        if (existing) return existing;
        if (!Array.isArray(p.tasks) || !p.tasks.length || p.tasks.length > 100 || !Array.isArray(p.parents) || !p.parents.length || p.parents.length > 100) invalid();
        var parents = p.parents.map(function (parent) {
          var item = record(parent,['key','raw','jobId']);return textSha(item.raw).then(function (hash) {
            return checkPaidParent(Object.assign({},item,{rawSha256:hash}),p.owner,true);
          });
        });
        var tasks = p.tasks.map(function (task) {
          var item = record(task,['parentLegacyKey','baseImage','subjectImage','snapshot','metadata','output','model']);
          return Promise.all([original(p.owner,item.baseImage),original(p.owner,item.subjectImage)]).then(function (assets) {
            return {taskId:randomId('sku_paid_task_'),parentLegacyKey:str(item.parentLegacyKey,2048),sources:{base:assets[0],subject:assets[1]},sourceImages:{base:image(item.baseImage),subject:image(item.subjectImage)},snapshot:snapshot(item.snapshot),metadata:metadata(item.metadata),
              output:output(item.output),model:model(item.model)};
          });
        });
        return Promise.all([Promise.all(parents),Promise.all(tasks)]).then(function (values) {
          var workspaceKey = randomId('sku_paid_workspace_');
          var auth = {schema:PAID_AUTH,id:paidAuthKey(p.owner,workspaceKey),owner:p.owner,environment:env(),workspaceKey:workspaceKey,
            createdAt:Date.now(),notice:PAID_NOTICE,parents:values[0],tasks:values[1]};
          return textSha(canonical(auth)).then(function (hash) {
            auth.authorizationSha256 = hash;
            return checkedPaidAuthorization(auth,p.owner,workspaceKey).then(function () {
              auth.parents.forEach(function (parent) { checkPaidParent(parent,p.owner,true); });
              return journal('readwrite',function (store,result,guard) {
                var get = store.get(paidActiveKey(p.owner));get.onsuccess = guard(function () {
                  if (get.result) { result(get.result);return; }
                  var pointer = {schema:'SKU_PAID_ACTIVE_WORKSPACE_V1',id:paidActiveKey(p.owner),owner:p.owner,workspaceKey:workspaceKey};
                  store.add(auth);store.add(pointer);result(pointer);
                });
              }).then(function (pointer) { return readPaidAuthorization(p.owner,pointer.workspaceKey); });
            });
          });
        });
      });
    });
  }
  function paidTaskFor(auth,sources,details) {
    var task = auth.tasks.filter(function (item) { return canonical(item.sources) === canonical(sources); })[0];
    if (!task) return null;
    if (details && (canonical(task.output) !== canonical(output(details.output)) || canonical(task.model) !== canonical(model(details.model)) ||
        String(task.metadata.title || '') !== String(details.metadata.title || '') ||
        String(task.metadata.attribute || '') !== String(details.metadata.attribute || ''))) throw fail('SKU_PAID_SCOPE_CHANGED','新任务素材、标题或冻结设置已变化；本次不会另行提交。');
    return task;
  }
  function validatePaidPlan(plan,dto,storedReceipt) {
    if (!/^sku_paid_workspace_/.test(plan.workspaceKey)) return Promise.resolve(true);
    return readPaidAuthorization(plan.accountKey,plan.workspaceKey).then(function (auth) {
      var selected = auth.tasks.filter(function (item) { return item.taskId === plan.taskId; })[0];
      var task = paidTaskFor(auth,plan.sources,{output:plan.output,model:plan.model,metadata:selected && selected.metadata || {}});
      if (!task || task.taskId !== plan.taskId) throw fail('SKU_PAID_AUTHORIZATION_REQUIRED');
      return Promise.all([imageSha(task.snapshot.providerImages.base),imageSha(task.snapshot.providerImages.subject),textSha(task.snapshot.prompt),textSha(task.snapshot.negativePrompt)]).then(function (hashes) {
        if (canonical(plan.contract) !== canonical(task.snapshot.contract) || canonical(plan.geometry) !== canonical(task.snapshot.geometry) ||
            plan.providerInputs.baseSha256 !== hashes[0] || plan.providerInputs.subjectSha256 !== hashes[1] ||
            plan.promptSha256 !== hashes[2] || plan.negativePromptSha256 !== hashes[3]) throw fail('SKU_PAID_SCOPE_CHANGED');
        return true;
      }).then(function () {
      if (storedReceipt) return true;
      return journal('readonly',function (store,result,guard) {
        var ready = 0, parent = null;
        auth.parents.forEach(function (candidate) {
          var get = store.get(key(plan.accountKey,candidate.key+':workspace:'+plan.workspaceKey));
          get.onsuccess = guard(function () {
            var entry = get.result;
            if (candidate.key === task.parentLegacyKey && entry && entry.schema === JOURNAL && entry.owner === plan.accountKey && entry.identity &&
                canonical(entry.identity) === canonical(dto) && canonical(entry.plan) === canonical(plan)) {
              if (parent) invalid();parent = candidate;
            }
            if (++ready === auth.parents.length) result(parent);
          });
        });
      }).then(function (parent) {
        if (!parent) throw fail('SKU_PAID_AUTHORIZATION_REQUIRED');checkPaidParent(parent,plan.accountKey,true);return true;
      });
      });
    });
  }
  function resolvePaidWorkspace(owner,baseKey,preparation) {
    return readActivePaidWorkspace(owner).then(function (auth) {
      if (!auth || !preparation) return null;
      return Promise.all([original(owner,preparation.baseImage),original(owner,preparation.subjectImage)]).then(function (assets) {
        var task = paidTaskFor(auth,{base:assets[0],subject:assets[1]},{output:preparation.output,model:preparation.model,metadata:preparation.snapshot});
        if (!task) return null;
        var parent = auth.parents.filter(function (item) { return item.key === baseKey && item.key === task.parentLegacyKey; })[0];
        if (!parent) throw fail('SKU_PAID_PARENT_MISMATCH','当前请求与明确授权保留的原任务不一致，本次不会另行提交。');
        var childKey = baseKey+':workspace:'+auth.workspaceKey;
        return read(owner,childKey).then(function (existing) {
          if (!existing || existing.state === 'prepared' || existing.state === 'not-submitted') checkPaidParent(parent,owner,true);
          return {key:childKey,workspaceKey:auth.workspaceKey,taskId:task.taskId,authorizationSha256:auth.authorizationSha256,parentLegacyKey:baseKey};
        });
      });
    });
  }
  function verifyPaidWorkspaceDispatch(owner,workspaceKey,parentKey) {
    return readPaidAuthorization(owner,workspaceKey).then(function (auth) {
      var parent = auth.parents.filter(function (item) { return item.key === parentKey; })[0];
      if (!parent) throw fail('SKU_PAID_PARENT_MISMATCH');checkPaidParent(parent,owner,true);return true;
    });
  }
  function recordReceiptEvidence(owner,legacyKey,response) {
    return read(owner,legacyKey).then(function (entry) {
      if (!entry || !response || response.ok !== true || !Array.isArray(response.images) || !response.images.length ||
          canonical(identity(response.receipt)) !== canonical(entry.identity)) throw fail('SKU_RECEIPT_EVIDENCE_MISMATCH');
      var billing = response.billingEventId, dispatch = response.dispatchId, resultSha = response.resultSha256;
      if (billing !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(billing) ||
          dispatch !== undefined && !UUID.test(dispatch) || resultSha !== undefined && !SHA.test(resultSha) || billing && dispatch) throw fail('SKU_RECEIPT_EVIDENCE_MISMATCH');
      var captured = !!(resultSha && (billing || dispatch));
      var evidence = {schema:'SKU_RECEIPT_SERVER_METADATA_V1',id:JSON.stringify(['receipt-evidence',owner,entry.identity.receiptId,captured ? 'complete' : 'not-captured']),
        owner:owner,receiptIdentity:entry.identity,captureStatus:captured ? 'captured-from-server-response' : 'not-captured'};
      if (captured) { evidence.resultSha256 = resultSha;if (billing) evidence.billingEventId = billing;else evidence.dispatchId = dispatch; }
      return journal('readwrite',function (store,result,guard) {
        var get = store.get(evidence.id);get.onsuccess = guard(function () {
          if (get.result) { if (canonical(get.result) !== canonical(evidence)) throw fail('SKU_RECEIPT_EVIDENCE_CONFLICT');result(true);return; }
          store.add(evidence);result(true);
        });
      });
    });
  }
  function readReceiptEvidence(owner,dto) {
    return journal('readonly',function (store,result,guard) {
      var first = store.get(JSON.stringify(['receipt-evidence',owner,dto.receiptId,'complete']));first.onsuccess = guard(function () {
        if (first.result) { result(first.result);return; }
        var missing = store.get(JSON.stringify(['receipt-evidence',owner,dto.receiptId,'not-captured']));missing.onsuccess = guard(function () { result(missing.result || null); });
      });
    }).then(function (raw) {
      if (!raw) return {captureStatus:'not-captured',evidenceRecordPresent:false};
      var clean = record(raw,['schema','id','owner','receiptIdentity','captureStatus','resultSha256','billingEventId','dispatchId'],['schema','id','owner','receiptIdentity','captureStatus']);
      var complete = clean.captureStatus === 'captured-from-server-response';
      if (clean.schema !== 'SKU_RECEIPT_SERVER_METADATA_V1' || clean.owner !== owner || canonical(identity(clean.receiptIdentity)) !== canonical(dto) ||
          clean.id !== JSON.stringify(['receipt-evidence',owner,dto.receiptId,complete ? 'complete' : 'not-captured']) ||
          !complete && (clean.captureStatus !== 'not-captured' || clean.resultSha256 !== undefined || clean.billingEventId !== undefined || clean.dispatchId !== undefined) ||
          complete && (!SHA.test(clean.resultSha256 || '') || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(clean.billingEventId || '') && !UUID.test(clean.dispatchId || '') || clean.billingEventId && clean.dispatchId)) invalid();
      var out = {captureStatus:clean.captureStatus,evidenceRecordPresent:true};
      ['resultSha256','billingEventId','dispatchId'].forEach(function (field) { if (clean[field] !== undefined) out[field] = clean[field]; });return out;
    });
  }
  function recordPaidArchive(owner,legacyKey,receiptId,records) {
    return read(owner,legacyKey).then(function (entry) {
      if (!entry || entry.identity.receiptId !== receiptId || !/^sku_paid_workspace_/.test(entry.identity.workspaceKey)) throw fail('SKU_PAID_AUTHORIZATION_REQUIRED');
      if (!Array.isArray(records) || !records.length || records.length > 20) invalid();
      var assets = records.map(function (raw) {
        var item = record(raw,['archiveAssetId','archiveBatchId','resultId','jobId']);
        Object.keys(item).forEach(function (field) { item[field] = str(item[field],260); });
        if (item.jobId !== entry.identity.jobId) invalid();return item;
      });
      var audit = {schema:'SKU_PAID_NATIVE_ARCHIVE_AUDIT_V1',id:JSON.stringify(['paid-archive',owner,receiptId]),
        owner:owner,receiptIdentity:entry.identity,assets:assets};
      return journal('readwrite',function (store,result,guard) {
        var get = store.get(audit.id);get.onsuccess = guard(function () {
          if (get.result) { if (canonical(get.result) !== canonical(audit)) throw fail('SKU_PAID_ARCHIVE_AUDIT_CONFLICT');result(true);return; }
          store.add(audit);result(true);
        });
      });
    });
  }
  function exportPaidWorkspaceMetadata(owner) {
    return readActivePaidWorkspace(owner).then(function (auth) {
      if (!auth) throw fail('SKU_PAID_AUTHORIZATION_REQUIRED');
      return Promise.all(auth.parents.map(function (parent) {
        var childKey = parent.key+':workspace:'+auth.workspaceKey;
        return read(owner,childKey).then(function (entry) {
          if (!entry) { var approved = auth.tasks.filter(function (task) { return task.parentLegacyKey === parent.key; })[0];
            return {parentLegacyKey:parent.key,authorizedTaskId:approved.taskId,journalState:'not-prepared',sourceOriginals:approved.sources,
              authorizedRegion:approved.snapshot.contract.subject.authorizedRegion,output:approved.output,providerGeometry:approved.snapshot.geometry,
              model:{provider:approved.model.provider,imageModel:approved.model.imageModel,imageAdapter:approved.model.imageAdapter},serverResponseMetadata:{captureStatus:'not-captured'}}; }
          return journal('readonly',function (store,result,guard) {
            var get = store.get(JSON.stringify(['paid-archive',owner,entry.identity.receiptId]));get.onsuccess = guard(function () { result(get.result || null); });
          }).then(function (audit) {
            var archiveIds = [];
            if (audit) {
              var checked = record(audit,['schema','id','owner','receiptIdentity','assets']);
              if (checked.schema !== 'SKU_PAID_NATIVE_ARCHIVE_AUDIT_V1' || checked.owner !== owner ||
                  checked.id !== JSON.stringify(['paid-archive',owner,entry.identity.receiptId]) ||
                  canonical(identity(checked.receiptIdentity)) !== canonical(entry.identity) || !Array.isArray(checked.assets)) invalid();
              archiveIds = checked.assets.map(function (asset) {
                var clean = record(asset,['archiveAssetId','archiveBatchId','resultId','jobId']);
                Object.keys(clean).forEach(function (field) { clean[field] = str(clean[field],260); });
                if (clean.jobId !== entry.identity.jobId) invalid();return clean;
              });
            }
            return readReceiptEvidence(owner,entry.identity).then(function (serverMetadata) { return {parentLegacyKey:parent.key,receiptIdentity:entry.identity,planCanonicalSha256:entry.identity.planSignatureHash,
              serverResponseMetadata:serverMetadata,
              sourceOriginals:entry.plan.sources,providerInputHashes:entry.plan.providerInputs,
              authorizedRegion:entry.plan.contract.subject.authorizedRegion,output:entry.plan.output,providerGeometry:entry.plan.geometry,
              model:{provider:entry.plan.model.provider,imageModel:entry.plan.model.imageModel,imageAdapter:entry.plan.model.imageAdapter},
              journalState:entry.state,localAcknowledged:entry.state === 'acknowledged',nativeArchiveIds:archiveIds}; });
          });
        });
      })).then(function (receipts) {
        return {schema:'SKU_PAID_WORKSPACE_METADATA_EXPORT_V1',evidenceScope:'local browser authorization/journal/native archive; not provider or financial settlement',
          owner:owner,workspaceKey:auth.workspaceKey,authorizationId:auth.id,authorizationSha256:auth.authorizationSha256,createdAt:auth.createdAt,
          oldRequests:auth.parents.map(function (parent) { return {legacyKey:parent.key,jobId:parent.jobId,markerSha256:parent.rawSha256}; }),receipts:receipts};
      });
    });
  }
  function prepare(params) {
    return Promise.resolve().then(function () {
      var p = record(params,['owner','legacyKey','jobId','batchId','baseImage','subjectImage','providerImages','contract','geometry','output','prompt','negativePrompt','model','snapshot','paidWorkspaceKey','parentLegacyKey'],['owner','legacyKey','jobId','batchId','baseImage','subjectImage','providerImages','contract','geometry','output','prompt','negativePrompt','model','snapshot']);
      p.owner = id(p.owner);p.legacyKey = str(p.legacyKey,2048);p.jobId = id(p.jobId);p.batchId = id(p.batchId);
      if (p.legacyKey.indexOf(':workspace:') >= 0 && !p.paidWorkspaceKey || p.paidWorkspaceKey && p.legacyKey.indexOf(':workspace:') < 0) throw fail('SKU_PAID_AUTHORIZATION_REQUIRED');
      var snap = snapshot({baseImage:p.baseImage,subjectImage:p.subjectImage,providerImages:p.providerImages,contract:p.contract,geometry:p.geometry,output:p.output,prompt:p.prompt,negativePrompt:p.negativePrompt,model:p.model,metadata:metadata(p.snapshot)});
      return read(p.owner,p.legacyKey).then(function (existing) {
        if (existing && (['prepared','dispatched'].indexOf(existing.state) >= 0 || p.paidWorkspaceKey && existing.state === 'acknowledged')) return existing;
        return Promise.all([original(p.owner,p.baseImage),original(p.owner,p.subjectImage),imageSha(snap.providerImages.base),imageSha(snap.providerImages.subject),textSha(snap.prompt),textSha(snap.negativePrompt),textSha(canonical(snap.model))]).then(function (values) {
          var paid = p.paidWorkspaceKey ? readPaidAuthorization(p.owner,id(p.paidWorkspaceKey)).then(function (auth) {
            var task = paidTaskFor(auth,{base:values[0],subject:values[1]},{output:snap.output,model:snap.model,metadata:snap.metadata});
            var parent = auth.parents.filter(function (item) { return item.key === p.parentLegacyKey && item.key === task.parentLegacyKey; })[0];
            if (!task || !parent || p.legacyKey !== parent.key+':workspace:'+auth.workspaceKey) throw fail('SKU_PAID_AUTHORIZATION_REQUIRED');
            var approved = Object.assign({},task.snapshot), actual = Object.assign({},snap);delete approved.metadata;delete actual.metadata;
            if (canonical(approved) !== canonical(actual)) throw fail('SKU_PAID_SCOPE_CHANGED');
            checkPaidParent(parent,p.owner,true);return {workspaceKey:auth.workspaceKey,taskId:task.taskId};
          }) : null;
          var taskKey = JSON.stringify(['task',p.owner,values[0].assetId,values[1].assetId]), workspaceKey = JSON.stringify(['workspace',p.owner]);
          return (paid || journal('readwrite',function (store,result,guard) {
            var requests = [store.get(workspaceKey),store.get(taskKey)], ready = 0;
            requests.forEach(function (request) { request.onsuccess = guard(function () {
              if (++ready !== requests.length) return;
              var workspace = requests[0].result || {id:workspaceKey,owner:p.owner,value:randomId('sku_workspace_')};
              var task = requests[1].result || {id:taskKey,owner:p.owner,value:randomId('sku_task_')};
              if (workspace.owner !== p.owner || workspace.id !== workspaceKey || task.owner !== p.owner || task.id !== taskKey) invalid();id(workspace.value);id(task.value);
              store.put(workspace);store.put(task);result({workspaceKey:workspace.value,taskId:task.value});
            }); });
          })).then(function (bindings) {
            var plan = validatePlan({schema:PLAN,version:1,accountKey:p.owner,workspaceKey:bindings.workspaceKey,taskId:bindings.taskId,shotId:'subject-replace',batchId:p.batchId,sources:{base:values[0],subject:values[1]},providerInputs:{baseSha256:values[2],subjectSha256:values[3]},contract:snap.contract,output:snap.output,geometry:snap.geometry,promptSha256:values[4],negativePromptSha256:values[5],model:snap.model,modelSha256:values[6]});
            return compute(plan).then(function (hash) {
              var dto = identity({version:1,receiptId:randomId(''),jobId:p.jobId,accountKey:p.owner,workspaceKey:plan.workspaceKey,taskId:plan.taskId,shotId:'subject-replace',batchId:p.batchId,planSignatureHash:hash});
              var entry = {schema:JOURNAL,id:key(p.owner,p.legacyKey),owner:p.owner,key:p.legacyKey,identity:dto,plan:plan,snapshot:snap,state:'prepared',createdAt:Date.now()};
              // Never await crypto inside a transaction, and never replace an
              // active receipt created by another page between the two reads.
              return journal('readwrite',function (store,result,guard) {
                var get = store.get(entry.id);get.onsuccess = guard(function () {
                  var current = get.result;
                  if (current && ['prepared','dispatched'].indexOf(current.state) >= 0) { result(current);return; }
                  if (current && current.state !== 'acknowledged' && current.state !== 'not-submitted') throw fail('SKU_RECEIPT_CONFLICT');
                  store.put(entry);result(entry);
                });
              }).then(function (saved) { return checked(saved,p.owner,p.legacyKey); });
            });
          });
        });
      });
    });
  }
  function change(owner,legacyKey,receiptId,nextState,proof) {
    return read(owner,legacyKey).then(function (entry) {
      if (!entry || entry.identity.receiptId !== receiptId) return {ok:false,reason:'receipt_mismatch'};
      if (nextState === 'not-submitted') {
        var matched = false;
        try {
          matched = !!(proof && proof.ok === false && proof.noSubmission === true && proof.providerSubmitted === false &&
            proof.definitiveFailure === true && proof.stateUncertain === false && /^SKU_RECEIPT_[A-Z0-9_]+$/.test(proof.code || '') &&
            proof.jobId === entry.identity.jobId && canonical(identity(proof.receiptIdentity)) === canonical(entry.identity));
        } catch (_) {}
        if (!matched) return {ok:false,reason:'no_submission_proof_required'};
      }
      var evidenceGate = nextState === 'acknowledged' && /^sku_paid_workspace_/.test(entry.identity.workspaceKey)
        ? readReceiptEvidence(owner,entry.identity).then(function (evidence) { if (!evidence.evidenceRecordPresent) throw fail('SKU_RECEIPT_EVIDENCE_STORAGE_FAILED'); }) : Promise.resolve();
      return evidenceGate.then(function () { return journal('readwrite',function (store,result,guard) {
        var get = store.get(entry.id);get.onsuccess = guard(function () {
          var current = get.result;
          if (!current || current.schema !== JOURNAL || current.owner !== owner || current.key !== legacyKey || !current.identity || current.identity.receiptId !== receiptId || canonical(current) !== canonical(entry)) { result({ok:false,reason:'receipt_mismatch'});return; }
          if (nextState === 'dispatched' && current.state !== 'prepared') { result({ok:false,reason:'already_dispatched'});return; }
          if (nextState === 'not-submitted') {
            if (current.state === 'not-submitted') { result({ok:true});return; }
            if (current.state !== 'dispatched') { result({ok:false,reason:'receipt_state_mismatch'});return; }
            store.put({schema:'SKU_RECEIPT_NO_SUBMISSION_AUDIT_V1',id:JSON.stringify(['audit',owner,receiptId]),
              owner:owner,identity:current.identity,plan:current.plan,state:'not-submitted',reason:proof.code,createdAt:Date.now()});
          }
          current.state = nextState;store.put(current);result(nextState === 'dispatched' ? {ok:true,dispatched:true} : {ok:true});
        });
      }); });
    });
  }
  function readAudit(owner,receiptId) {
    return Promise.resolve().then(function () {
      owner = id(owner);if (!UUID.test(receiptId || '')) invalid();
      var auditKey = JSON.stringify(['audit',owner,receiptId]);
      return journal('readonly',function (store,result,guard) { var get = store.get(auditKey);get.onsuccess = guard(function () { result(get.result || null); }); }).then(function (raw) {
        if (!raw) return null;
        var out = record(raw,['schema','id','owner','identity','plan','state','reason','createdAt']);
        if (out.schema !== 'SKU_RECEIPT_NO_SUBMISSION_AUDIT_V1' || out.id !== auditKey || out.owner !== owner || out.state !== 'not-submitted' || !/^SKU_RECEIPT_[A-Z0-9_]+$/.test(out.reason || '') || !Number.isSafeInteger(out.createdAt)) invalid();
        out.identity = identity(out.identity);out.plan = validatePlan(out.plan);
        if (out.identity.receiptId !== receiptId || out.identity.accountKey !== owner || out.plan.accountKey !== owner || ['workspaceKey','taskId','shotId','batchId'].some(function (field) { return out.identity[field] !== out.plan[field]; })) invalid();
        return compute(out.plan).then(function (hash) { if (hash !== out.identity.planSignatureHash) invalid();return out; });
      });
    });
  }
  return Object.freeze({validatePlan:validatePlan,compute:compute,validate:validate,prepare:prepare,read:read,
    markDispatched:function (owner,keyValue,receiptId) { return change(owner,keyValue,receiptId,'dispatched'); },
    ack:function (owner,keyValue,receiptId) { return change(owner,keyValue,receiptId,'acknowledged'); },
    releaseNotSubmitted:function (owner,keyValue,receiptId,proof) { return change(owner,keyValue,receiptId,'not-submitted',proof); },
    readAudit:readAudit,paidNotice:PAID_NOTICE,beginPaidWorkspaceIntent:beginPaidWorkspaceIntent,authorizePaidWorkspace:authorizePaidWorkspace,
    readActivePaidWorkspace:readActivePaidWorkspace,resolvePaidWorkspace:resolvePaidWorkspace,verifyPaidWorkspaceDispatch:verifyPaidWorkspaceDispatch,
    recordPaidArchive:recordPaidArchive,exportPaidWorkspaceMetadata:exportPaidWorkspaceMetadata,recordReceiptEvidence:recordReceiptEvidence});
});
