/* image-archive-store.js — 生图结果本机留档、7天回收站与缺失清理 */
(function (root, factory) {
  var api = factory(root || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SZ_IMAGE_ARCHIVE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var DB_NAME = 'sz_image_archive_v1';
  var DB_VERSION = 2;
  var BATCH_STORE = 'batches';
  var ASSET_STORE = 'assets';
  var TOMBSTONE_STORE = 'referenceProvisionalTombstones';
  var RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  var PROVISIONAL_RETENTION_MS = 24 * 60 * 60 * 1000;
  var MAX_PROVISIONAL_SCAN_LIMIT = 48;
  var MAX_IMAGE_BYTES = 40 * 1024 * 1024;
  var SKU_OUTPUT_MIN_EDGE = 256;
  var SKU_OUTPUT_MAX_EDGE = 4096;
  var SKU_OUTPUT_MAX_PIXELS = 16777216;
  var SKU_OUTPUT_IDENTITY_FIELDS = [
    'outputSize', 'outputWidth', 'outputHeight',
    'providerSize', 'providerRatio', 'providerResolution'
  ];
  var SKU_PROVIDER_RATIO_ORDER = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
  var SKU_PROVIDER_BASE_SIZES = {
    '1:1': [1024, 1024],
    '2:3': [896, 1344],
    '3:2': [1344, 896],
    '3:4': [768, 1024],
    '4:3': [1024, 768],
    '4:5': [1024, 1280],
    '5:4': [1280, 1024],
    '9:16': [1024, 1792],
    '16:9': [1792, 1024],
    '21:9': [2048, 878]
  };

  function text(value, max) {
    var out = String(value == null ? '' : value).trim();
    return max ? out.slice(0, max) : out;
  }

  function normalizeAccountKey(value) {
    return text(value, 140) || 'local';
  }

  function safeInteger(value, min, max, fallback) {
    var number = Number(value);
    return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
  }

  function ownDataValue(raw, key) {
    var descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(raw, key); }
    catch (_) { return { ok: false }; }
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return { ok: false };
    return { ok: true, value: descriptor.value };
  }

  function skuPixelSize(value) {
    if (typeof value !== 'string') return null;
    var match = /^(\d{1,5})\*(\d{1,5})$/.exec(value);
    if (!match) return null;
    var width = Number(match[1]);
    var height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || value !== width + '*' + height) return null;
    return { width: width, height: height, size: value };
  }

  function skuGreatestCommonDivisor(a, b) {
    a = Math.abs(a);
    b = Math.abs(b);
    while (b) {
      var next = a % b;
      a = b;
      b = next;
    }
    return a || 1;
  }

  function skuExactRatio(width, height) {
    var divisor = skuGreatestCommonDivisor(width, height);
    return (width / divisor) + ':' + (height / divisor);
  }

  function skuRoundToEight(value) {
    return Math.max(8, Math.round(value / 8) * 8);
  }

  function skuProviderTuple(ratio, resolution) {
    var base = SKU_PROVIDER_BASE_SIZES[ratio];
    if (!base || ['1K', '2K', '4K'].indexOf(resolution) < 0) return null;
    var width = base[0];
    var height = base[1];
    if (resolution !== '1K') {
      var targetLongest = resolution === '2K' ? 2048 : 4096;
      var scale = targetLongest / Math.max(width, height);
      width = skuRoundToEight(width * scale);
      height = skuRoundToEight(height * scale);
    }
    return { size: width + '*' + height, width: width, height: height, ratio: ratio, resolution: resolution };
  }

  function skuNearestProviderTuple(width, height) {
    var target = width / height;
    var selected = SKU_PROVIDER_RATIO_ORDER[0];
    var distance = Infinity;
    SKU_PROVIDER_RATIO_ORDER.forEach(function (ratio) {
      var parts = ratio.split(':');
      var candidate = Number(parts[0]) / Number(parts[1]);
      var current = Math.abs(Math.log(target / candidate));
      if (current < distance - 1e-12) {
        distance = current;
        selected = ratio;
      }
    });
    var longest = Math.max(width, height);
    return skuProviderTuple(selected, longest <= 1024 ? '1K' : (longest <= 2048 ? '2K' : '4K'));
  }

  function inspectSkuOutputIdentity(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.surfaceMode !== 'sku') {
      return { state: 'none', value: null };
    }
    var present = SKU_OUTPUT_IDENTITY_FIELDS.filter(function (key) {
      try { return Object.prototype.hasOwnProperty.call(raw, key); }
      catch (_) { return false; }
    });
    if (!present.length) return { state: 'none', value: null };
    if (present.length !== SKU_OUTPUT_IDENTITY_FIELDS.length) {
      return { state: 'invalid', error: 'SKU 档案输出尺寸身份字段不完整。' };
    }
    var values = {};
    for (var index = 0; index < SKU_OUTPUT_IDENTITY_FIELDS.length; index++) {
      var key = SKU_OUTPUT_IDENTITY_FIELDS[index];
      var field = ownDataValue(raw, key);
      if (!field.ok) return { state: 'invalid', error: 'SKU 档案输出尺寸身份必须是普通数据字段。' };
      values[key] = field.value;
    }
    var ratioField = ownDataValue(raw, 'ratio');
    var resolutionField = ownDataValue(raw, 'resolution');
    if (!ratioField.ok || !resolutionField.ok || typeof ratioField.value !== 'string' || typeof resolutionField.value !== 'string') {
      return { state: 'invalid', error: 'SKU 档案缺少最终比例或分辨率身份。' };
    }
    if (typeof values.outputSize !== 'string' || typeof values.outputWidth !== 'number' ||
        typeof values.outputHeight !== 'number' || typeof values.providerSize !== 'string' ||
        typeof values.providerRatio !== 'string' || typeof values.providerResolution !== 'string') {
      return { state: 'invalid', error: 'SKU 档案输出尺寸身份字段类型无效。' };
    }
    var output = skuPixelSize(values.outputSize);
    var provider = skuPixelSize(values.providerSize);
    if (!output || !provider || !Number.isSafeInteger(values.outputWidth) || !Number.isSafeInteger(values.outputHeight) ||
        output.width !== values.outputWidth || output.height !== values.outputHeight) {
      return { state: 'invalid', error: 'SKU 档案输出宽高与尺寸标识不一致。' };
    }
    if (output.width < SKU_OUTPUT_MIN_EDGE || output.height < SKU_OUTPUT_MIN_EDGE ||
        output.width > SKU_OUTPUT_MAX_EDGE || output.height > SKU_OUTPUT_MAX_EDGE ||
        output.width * output.height > SKU_OUTPUT_MAX_PIXELS ||
        provider.width < SKU_OUTPUT_MIN_EDGE || provider.height < SKU_OUTPUT_MIN_EDGE ||
        provider.width > SKU_OUTPUT_MAX_EDGE || provider.height > SKU_OUTPUT_MAX_EDGE ||
        provider.width * provider.height > SKU_OUTPUT_MAX_PIXELS) {
      return { state: 'invalid', error: 'SKU 档案输出尺寸超过安全范围。' };
    }
    var ratio = ratioField.value;
    var resolution = resolutionField.value;
    var expectedProvider;
    if (resolution === 'custom') {
      if (ratio !== skuExactRatio(output.width, output.height)) {
        return { state: 'invalid', error: 'SKU 档案自定义输出比例与精确宽高不一致。' };
      }
      expectedProvider = skuNearestProviderTuple(output.width, output.height);
    } else {
      expectedProvider = skuProviderTuple(ratio, resolution);
      // 21:9 的安全像素经过 8px 对齐，不要求 width / height 数学上恰好等于 21 / 9；
      // 只以同一预设算法产生的 canonical 尺寸为准。
      if (!expectedProvider || expectedProvider.size !== output.size) {
        return { state: 'invalid', error: 'SKU 档案预设输出尺寸与比例分辨率不一致。' };
      }
    }
    if (!expectedProvider || values.providerSize !== expectedProvider.size ||
        values.providerRatio !== expectedProvider.ratio || values.providerResolution !== expectedProvider.resolution) {
      return { state: 'invalid', error: 'SKU 档案模型底图身份与最终输出尺寸不一致。' };
    }
    return { state: 'valid', value: values };
  }

  function sanitizeSkuOutputIdentity(raw) {
    var inspected = inspectSkuOutputIdentity(raw);
    if (inspected.state !== 'valid') return null;
    return Object.assign({}, inspected.value);
  }

  function invalidSkuOutputIdentity(message) {
    return Object.assign(new Error(message || 'SKU 档案输出尺寸身份无效。'), {
      code: 'ARCHIVE_SKU_OUTPUT_IDENTITY_INVALID'
    });
  }

  function exactDataValues(raw, allowedKeys) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var keys;
    try { keys = Object.keys(raw).sort(); }
    catch (_) { return null; }
    if (keys.join(',') !== allowedKeys.slice().sort().join(',')) return null;
    var values = {};
    for (var index = 0; index < allowedKeys.length; index++) {
      var key = allowedKeys[index];
      var descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(raw, key); }
      catch (_) { return null; }
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      values[key] = descriptor.value;
    }
    return values;
  }

  function textList(value, limit, max) {
    var out = [];
    (Array.isArray(value) ? value : []).forEach(function (item) {
      item = text(item, max || 40);
      if (item && out.indexOf(item) < 0 && out.length < (limit || 8)) out.push(item);
    });
    return out;
  }

  function hashText(value) {
    var h = 2166136261;
    value = String(value || '');
    for (var i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
    return ('00000000' + (h >>> 0).toString(16)).slice(-8);
  }

  function randomWriteToken() {
    var bytes = new Uint8Array(16);
    try {
      if (root.crypto && typeof root.crypto.getRandomValues === 'function') {
        root.crypto.getRandomValues(bytes);
        return Array.prototype.map.call(bytes, function (value) { return ('0' + value.toString(16)).slice(-2); }).join('');
      }
    } catch (_) {}
    return hashText([Date.now(), Math.random(), Math.random()].join('|')) + hashText([Math.random(), Date.now()].join('|'));
  }

  function canonicalArchiveLinkId(value) {
    var match = /^\s*L?0*(\d+)\s*$/i.exec(String(value || ''));
    if (!match) return '';
    var sequence = Number(match[1]);
    if (!Number.isSafeInteger(sequence) || sequence < 1) return '';
    return 'L' + String(sequence).padStart(3, '0');
  }

  function archiveLinkIds(values) {
    var seen = Object.create(null);
    return (Array.isArray(values) ? values : [values]).map(canonicalArchiveLinkId).filter(function (id) {
      if (!id || seen[id]) return false;
      seen[id] = true;
      return true;
    }).sort(function (a, b) { return Number(a.slice(1)) - Number(b.slice(1)); });
  }

  function archiveLinkRangeLabel(values) {
    var ids = archiveLinkIds(values);
    if (!ids.length) return '';
    var ranges = [];
    var start = ids[0];
    var previous = ids[0];
    function pushRange() { ranges.push(start === previous ? start : (start + '–' + previous)); }
    for (var i = 1; i < ids.length; i++) {
      if (Number(ids[i].slice(1)) === Number(previous.slice(1)) + 1) {
        previous = ids[i];
        continue;
      }
      pushRange();
      start = previous = ids[i];
    }
    pushRange();
    return ranges.join('、');
  }

  function numberedLinkSurface(asset) {
    return !!(asset && (asset.surfaceMode === 'main' || asset.surfaceMode === 'detail') && canonicalArchiveLinkId(asset.linkId));
  }

  function allowedMime(value) {
    value = text(value, 80).toLowerCase().split(';')[0];
    if (value === 'image/jpg') value = 'image/jpeg';
    return /^(image\/png|image\/jpeg|image\/webp|image\/gif)$/.test(value) ? value : '';
  }

  function dataUrlToBlob(dataUrl) {
    var match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(dataUrl || ''));
    if (!match) return Promise.reject(new Error('不是可留档的图片数据'));
    var mime = allowedMime(match[1]);
    if (!mime) return Promise.reject(new Error('不支持的图片格式'));
    try {
      var binary = root.atob ? root.atob(match[2].replace(/\s+/g, '')) : Buffer.from(match[2], 'base64').toString('binary');
      if (binary.length > MAX_IMAGE_BYTES) return Promise.reject(new Error('单张留档图片不能超过40MB'));
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return Promise.resolve(new Blob([bytes], { type: mime }));
    } catch (error) {
      return Promise.reject(new Error('图片数据解码失败'));
    }
  }

  function validBlob(blob) {
    return !!(blob && typeof blob.size === 'number' && blob.size > 0 && blob.size <= MAX_IMAGE_BYTES && allowedMime(blob.type));
  }

  function sourceToBlob(source, fetcher) {
    if (validBlob(source)) return Promise.resolve(source);
    var value = String(source || '');
    if (/^data:image\//i.test(value)) return dataUrlToBlob(value);
    if (!/^(https?:|blob:)/i.test(value)) return Promise.reject(new Error('没有可留档的本机图片来源'));
    fetcher = fetcher || root.fetch;
    if (typeof fetcher !== 'function') return Promise.reject(new Error('当前环境无法读取图片文件'));
    return fetcher(value, { credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (response) {
      if (!response || !response.ok) throw new Error('图片文件读取失败');
      var declared = Number(response.headers && response.headers.get && response.headers.get('content-length')) || 0;
      if (declared > MAX_IMAGE_BYTES) throw new Error('单张留档图片不能超过40MB');
      return response.blob();
    }).then(function (blob) {
      if (!validBlob(blob)) throw new Error('返回内容不是有效图片或超过40MB');
      return blob;
    });
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) { reject(new Error('当前环境不支持本机图片档案')); return; }
      var request = root.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        var batches = db.objectStoreNames.contains(BATCH_STORE)
          ? request.transaction.objectStore(BATCH_STORE)
          : db.createObjectStore(BATCH_STORE, { keyPath: 'archiveBatchId' });
        if (!batches.indexNames.contains('accountKey')) batches.createIndex('accountKey', 'accountKey', { unique: false });
        if (!batches.indexNames.contains('updatedAt')) batches.createIndex('updatedAt', 'updatedAt', { unique: false });
        var assets = db.objectStoreNames.contains(ASSET_STORE)
          ? request.transaction.objectStore(ASSET_STORE)
          : db.createObjectStore(ASSET_STORE, { keyPath: 'archiveAssetId' });
        if (!assets.indexNames.contains('accountKey')) assets.createIndex('accountKey', 'accountKey', { unique: false });
        if (!assets.indexNames.contains('archiveBatchId')) assets.createIndex('archiveBatchId', 'archiveBatchId', { unique: false });
        if (!assets.indexNames.contains('purgeAt')) assets.createIndex('purgeAt', 'purgeAt', { unique: false });
        if (!assets.indexNames.contains('referenceProvisionalScanKey')) {
          assets.createIndex('referenceProvisionalScanKey', ['archiveState', 'surfaceMode', 'detailMode', 'provisionalExpiresAt', 'accountKey', 'archiveAssetId'], { unique: false });
        }
        if (!assets.indexNames.contains('accountReferenceProvisionalScanKey')) {
          assets.createIndex('accountReferenceProvisionalScanKey', ['accountKey', 'archiveState', 'surfaceMode', 'detailMode', 'provisionalExpiresAt', 'archiveAssetId'], { unique: false });
        }
        var tombstones = db.objectStoreNames.contains(TOMBSTONE_STORE)
          ? request.transaction.objectStore(TOMBSTONE_STORE)
          : db.createObjectStore(TOMBSTONE_STORE, { keyPath: 'archiveAssetId' });
        if (!tombstones.indexNames.contains('accountKey')) tombstones.createIndex('accountKey', 'accountKey', { unique: false });
        if (!tombstones.indexNames.contains('savedAt')) tombstones.createIndex('savedAt', 'savedAt', { unique: false });
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('无法打开本机图片档案')); };
    });
  }

  function transaction(storeNames, mode, task) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeNames, mode);
        var stores = {};
        storeNames.forEach(function (name) { stores[name] = tx.objectStore(name); });
        var result;
        var failed = false;
        function fail(error) {
          if (failed) return;
          failed = true;
          try { tx.abort(); } catch (_) {}
          reject(error || new Error('本机图片档案事务失败'));
        }
        try { result = task(stores, fail); }
        catch (error) { fail(error); }
        tx.oncomplete = function () { db.close(); if (!failed) resolve(typeof result === 'function' ? result() : result); };
        tx.onerror = function () { db.close(); fail(tx.error || new Error('本机图片档案事务失败')); };
        tx.onabort = function () { db.close(); if (!failed) fail(tx.error || new Error('本机图片档案事务已取消')); };
      });
    });
  }

  function sanitizeArchiveInput(raw) {
    raw = raw || {};
    var accountKey = normalizeAccountKey(raw.accountKey);
    var surfaceMode = ['main', 'detail', 'sku', 'viral'].indexOf(raw.surfaceMode) >= 0 ? raw.surfaceMode : 'main';
    var skuOutputIdentity = inspectSkuOutputIdentity(raw);
    if (skuOutputIdentity.state === 'invalid') throw invalidSkuOutputIdentity(skuOutputIdentity.error);
    var sourceBatchId = text(raw.sourceBatchId || raw.batchId || raw.jobId || raw.resultId, 220) || ('local_' + Date.now());
    var archiveBatchId = text(raw.archiveBatchId, 260) || ('archive_batch_' + hashText(accountKey + '|' + surfaceMode + '|' + sourceBatchId));
    var resultId = text(raw.resultId || raw.jobId, 260) || ('result_' + Date.now() + '_' + Math.random().toString(16).slice(2));
    var archiveAssetId = text(raw.archiveAssetId, 260) || ('archive_asset_' + hashText(accountKey + '|' + archiveBatchId + '|' + resultId));
    var safe = {
      accountKey: accountKey,
      surfaceMode: surfaceMode,
      creativeRoute: text(raw.creativeRoute, 80),
      detailMode: text(raw.detailMode, 80),
      sourceBatchId: sourceBatchId,
      technicalSourceBatchId: text(raw.technicalSourceBatchId, 260),
      blueprintId: text(raw.blueprintId, 260),
      archiveBatchId: archiveBatchId,
      archiveProjectId: text(raw.archiveProjectId, 260),
      archiveAssetId: archiveAssetId,
      resultId: resultId,
      batchTitle: text(raw.batchTitle, 160) || '本机生图档案',
      businessBatchTitle: text(raw.businessBatchTitle, 180),
      businessType: text(raw.businessType, 60),
      productName: text(raw.productName, 180),
      styleName: text(raw.styleName, 100),
      strengthName: text(raw.strengthName, 80),
      copyModeName: text(raw.copyModeName, 80),
      businessRoleKey: text(raw.businessRoleKey, 180),
      businessRoleName: text(raw.businessRoleName, 180),
      businessSummary: text(raw.businessSummary, 800),
      businessTags: textList(raw.businessTags, 8, 40),
      generationKind: text(raw.generationKind, 40),
      linkId: text(raw.linkId, 40),
      skuId: text(raw.skuId, 120),
      skuCode: text(raw.skuCode, 80),
      skuTitle: text(raw.skuTitle, 300),
      variant: text(raw.variant, 100),
      variantName: text(raw.variantName, 180),
      imageIndex: safeInteger(raw.imageIndex, 1, Number.MAX_SAFE_INTEGER, 1),
      ratio: text(raw.ratio, 20),
      resolution: text(raw.resolution, 20),
      provider: text(raw.provider, 80),
      imageModel: text(raw.imageModel, 120),
      prompt: text(raw.prompt, 30000),
      negativePrompt: text(raw.negativePrompt, 8000),
      promptBatchId: text(raw.promptBatchId, 260),
      parentResultId: text(raw.parentResultId, 260),
      parentBatchId: text(raw.parentBatchId, 260),
      guideOriginBatchId: text(raw.guideOriginBatchId, 260),
      taskId: text(raw.taskId, 180),
      jobId: text(raw.jobId, 260),
      logicalJobId: text(raw.logicalJobId, 260),
      generation: safeInteger(raw.generation, 0, Number.MAX_SAFE_INTEGER, 0),
      attempt: safeInteger(raw.attempt, 0, Number.MAX_SAFE_INTEGER, 0),
      inputFingerprint: text(raw.inputFingerprint, 260),
      screenIndex: safeInteger(raw.screenIndex, 0, Number.MAX_SAFE_INTEGER,
        safeInteger(raw.imageIndex, 1, Number.MAX_SAFE_INTEGER, 1) - 1),
      createdAt: Math.max(1, Number(raw.createdAt) || Date.now())
    };
    if (surfaceMode === 'sku' && skuOutputIdentity.state === 'valid') {
      Object.assign(safe, skuOutputIdentity.value);
    }
    return safe;
  }

  function skuOutputIdentityMatches(left, right) {
    var leftIdentity = inspectSkuOutputIdentity(left);
    var rightIdentity = inspectSkuOutputIdentity(right);
    if (leftIdentity.state === 'none' && rightIdentity.state === 'none') return true;
    if (leftIdentity.state !== 'valid' || rightIdentity.state !== 'valid') return false;
    return left.ratio === right.ratio && left.resolution === right.resolution && SKU_OUTPUT_IDENTITY_FIELDS.every(function (key) {
      return leftIdentity.value[key] === rightIdentity.value[key];
    });
  }

  function provisionalIdentityMatches(left, right) {
    left = left || {};
    right = right || {};
    return normalizeAccountKey(left.accountKey) === normalizeAccountKey(right.accountKey) &&
      text(left.archiveBatchId, 260) === text(right.archiveBatchId, 260) &&
      text(left.archiveAssetId, 260) === text(right.archiveAssetId, 260) &&
      text(left.technicalSourceBatchId, 260) === text(right.technicalSourceBatchId, 260) &&
      text(left.blueprintId, 260) === text(right.blueprintId, 260) &&
      text(left.resultId, 260) === text(right.resultId, 260) &&
      text(left.taskId, 180) === text(right.taskId, 180) &&
      ((left.archiveState !== 'provisional' && !text(left.jobId, 260)) || text(left.jobId, 260) === text(right.jobId, 260)) &&
      text(left.logicalJobId, 260) === text(right.logicalJobId, 260) &&
      safeInteger(left.generation, 0, Number.MAX_SAFE_INTEGER, 0) === safeInteger(right.generation, 0, Number.MAX_SAFE_INTEGER, 0) &&
      safeInteger(left.attempt, 0, Number.MAX_SAFE_INTEGER, 0) === safeInteger(right.attempt, 0, Number.MAX_SAFE_INTEGER, 0) &&
      text(left.inputFingerprint, 260) === text(right.inputFingerprint, 260) &&
      safeInteger(left.screenIndex, 0, Number.MAX_SAFE_INTEGER, 0) === safeInteger(right.screenIndex, 0, Number.MAX_SAFE_INTEGER, 0) &&
      safeInteger(left.imageIndex, 1, Number.MAX_SAFE_INTEGER, 1) === safeInteger(right.imageIndex, 1, Number.MAX_SAFE_INTEGER, 1) &&
      text(left.detailMode, 80) === text(right.detailMode, 80) &&
      text(left.surfaceMode, 40) === text(right.surfaceMode, 40) &&
      skuOutputIdentityMatches(left, right);
  }

  function archiveCollision(message) {
    return Object.assign(new Error(message || '本机档案 assetId 已被其他账号或结果身份占用。'), {
      code: 'ARCHIVE_ASSET_COLLISION'
    });
  }

  function provisionalReceipt(record, meta) {
    record = record || {};
    meta = meta || {};
    var provisional = record.archiveState === 'provisional';
    var output = {
      schema: 'IMAGE_ARCHIVE_PROVISIONAL_RECEIPT_V2',
      schemaVersion: 2,
      accountKey: text(record.accountKey, 140),
      technicalSourceBatchId: text(record.technicalSourceBatchId, 260),
      blueprintId: text(record.blueprintId, 260),
      archiveBatchId: text(record.archiveBatchId, 260),
      archiveAssetId: text(record.archiveAssetId, 260),
      resultId: text(record.resultId, 260),
      taskId: text(record.taskId, 180),
      jobId: text(record.jobId, 260),
      logicalJobId: text(record.logicalJobId, 260),
      generation: safeInteger(record.generation, 0, Number.MAX_SAFE_INTEGER, 0),
      attempt: safeInteger(record.attempt, 0, Number.MAX_SAFE_INTEGER, 0),
      inputFingerprint: text(record.inputFingerprint, 260),
      screenIndex: safeInteger(record.screenIndex, 0, Number.MAX_SAFE_INTEGER, 0),
      imageIndex: safeInteger(record.imageIndex, 1, Number.MAX_SAFE_INTEGER, 1),
      detailMode: text(record.detailMode, 80),
      surfaceMode: text(record.surfaceMode, 40),
      created: meta.created === true,
      provisional: provisional,
      committed: !provisional,
      writeToken: meta.created === true || meta.includeWriteToken === true ? text(record.archiveWriteToken, 260) : '',
      writeRevision: safeInteger(record.archiveWriteRevision, 0, Number.MAX_SAFE_INTEGER, 0),
      provisionalAt: safeInteger(record.provisionalAt, 0, Number.MAX_SAFE_INTEGER, 0),
      provisionalExpiresAt: safeInteger(record.provisionalExpiresAt, 0, Number.MAX_SAFE_INTEGER, 0),
      size: safeInteger(record.size, 0, MAX_IMAGE_BYTES, 0),
      mimeType: text(record.mimeType, 80)
    };
    var skuOutputIdentity = sanitizeSkuOutputIdentity(record);
    if (skuOutputIdentity) {
      output.ratio = text(record.ratio, 20);
      output.resolution = text(record.resolution, 20);
      Object.assign(output, skuOutputIdentity);
    }
    output.identityComplete = referenceProvisionalIdentityComplete(output);
    return output;
  }

  function checkedProvisionalReceipt(raw) {
    raw = raw || {};
    var receipt = {
      accountKey: text(raw.accountKey, 140),
      technicalSourceBatchId: text(raw.technicalSourceBatchId, 260),
      blueprintId: text(raw.blueprintId, 260),
      archiveBatchId: text(raw.archiveBatchId, 260),
      archiveAssetId: text(raw.archiveAssetId, 260),
      resultId: text(raw.resultId, 260),
      taskId: text(raw.taskId, 180),
      jobId: text(raw.jobId, 260),
      logicalJobId: text(raw.logicalJobId, 260),
      generation: safeInteger(raw.generation, 0, Number.MAX_SAFE_INTEGER, 0),
      attempt: safeInteger(raw.attempt, 0, Number.MAX_SAFE_INTEGER, 0),
      inputFingerprint: text(raw.inputFingerprint, 260),
      screenIndex: safeInteger(raw.screenIndex, 0, Number.MAX_SAFE_INTEGER, 0),
      imageIndex: safeInteger(raw.imageIndex, 1, Number.MAX_SAFE_INTEGER, 1),
      detailMode: text(raw.detailMode, 80),
      surfaceMode: text(raw.surfaceMode, 40),
      ratio: text(raw.ratio, 20),
      resolution: text(raw.resolution, 20),
      created: raw.created === true,
      writeToken: text(raw.writeToken, 260),
      writeRevision: safeInteger(raw.writeRevision, 0, Number.MAX_SAFE_INTEGER, 0),
      provisionalAt: safeInteger(raw.provisionalAt, 0, Number.MAX_SAFE_INTEGER, 0),
      provisionalExpiresAt: safeInteger(raw.provisionalExpiresAt, 0, Number.MAX_SAFE_INTEGER, 0)
    };
    var skuOutputIdentity = inspectSkuOutputIdentity(raw);
    if (skuOutputIdentity.state === 'invalid') return null;
    if (skuOutputIdentity.state === 'valid') Object.assign(receipt, skuOutputIdentity.value);
    if (!receipt.accountKey || !receipt.archiveBatchId || !receipt.archiveAssetId || !receipt.resultId) return null;
    return receipt;
  }

  function referenceProvisionalIdentityComplete(value) {
    value = value || {};
    return !!(text(value.accountKey, 140) && text(value.technicalSourceBatchId, 260) &&
      text(value.blueprintId, 260) && text(value.archiveBatchId, 260) && text(value.archiveAssetId, 260) &&
      text(value.resultId, 260) && text(value.taskId, 180) && text(value.jobId, 260) &&
      text(value.logicalJobId, 260) && safeInteger(value.generation, 1, Number.MAX_SAFE_INTEGER, 0) >= 1 &&
      safeInteger(value.attempt, 1, Number.MAX_SAFE_INTEGER, 0) >= 1 && text(value.inputFingerprint, 260) &&
      safeInteger(value.screenIndex, 0, 15, -1) >= 0 &&
      safeInteger(value.imageIndex, 1, 16, -1) === Number(value.screenIndex) + 1 &&
      text(value.detailMode, 80) === 'reference' && text(value.surfaceMode, 40) === 'detail');
  }

  function referenceProvisionalIdentityMatches(left, right) {
    left = left || {};
    right = right || {};
    return text(left.accountKey, 140) === text(right.accountKey, 140) &&
      text(left.technicalSourceBatchId, 260) === text(right.technicalSourceBatchId, 260) &&
      text(left.blueprintId, 260) === text(right.blueprintId, 260) &&
      text(left.archiveBatchId, 260) === text(right.archiveBatchId, 260) &&
      text(left.archiveAssetId, 260) === text(right.archiveAssetId, 260) &&
      text(left.resultId, 260) === text(right.resultId, 260) &&
      text(left.taskId, 180) === text(right.taskId, 180) &&
      text(left.jobId, 260) === text(right.jobId, 260) &&
      text(left.logicalJobId, 260) === text(right.logicalJobId, 260) &&
      safeInteger(left.generation, 0, Number.MAX_SAFE_INTEGER, -1) === safeInteger(right.generation, 0, Number.MAX_SAFE_INTEGER, -2) &&
      safeInteger(left.attempt, 0, Number.MAX_SAFE_INTEGER, -1) === safeInteger(right.attempt, 0, Number.MAX_SAFE_INTEGER, -2) &&
      text(left.inputFingerprint, 260) === text(right.inputFingerprint, 260) &&
      safeInteger(left.screenIndex, 0, Number.MAX_SAFE_INTEGER, -1) === safeInteger(right.screenIndex, 0, Number.MAX_SAFE_INTEGER, -2) &&
      safeInteger(left.imageIndex, 1, Number.MAX_SAFE_INTEGER, -1) === safeInteger(right.imageIndex, 1, Number.MAX_SAFE_INTEGER, -2) &&
      text(left.detailMode, 80) === text(right.detailMode, 80) &&
      text(left.surfaceMode, 40) === text(right.surfaceMode, 40);
  }

  function archiveTombstoned(message) {
    return Object.assign(new Error(message || '该结果引用已被权威终态撤销，拒绝迟到写入。'), {
      code: 'ARCHIVE_RESULT_TOMBSTONED'
    });
  }

  function rejectForTombstone(tombstone, identity) {
    if (!tombstone) return null;
    return referenceProvisionalIdentityMatches(tombstone, identity)
      ? archiveTombstoned()
      : archiveCollision('本机档案 assetId 已被其他账号或结果身份墓碑占用，拒绝覆盖。');
  }

  var TOMBSTONE_REASONS = Object.freeze({
    superseded_request: true,
    terminal_failed: true,
    terminal_cancelled: true,
    terminal_stale: true,
    registration_cleared: true
  });
  var PRESERVE_REASONS = Object.freeze({
    authority_uncertain: true,
    runtime_missing: true,
    runtime_corrupt: true,
    account_mismatch: true,
    registration_active: true,
    not_terminal: true
  });

  function checkedReferenceAuthority(raw) {
    raw = exactDataValues(raw, [
      'schema', 'decision', 'accountKey', 'technicalSourceBatchId', 'blueprintId', 'archiveBatchId',
      'archiveAssetId', 'resultId', 'taskId', 'jobId', 'logicalJobId', 'generation', 'attempt',
      'inputFingerprint', 'screenIndex', 'imageIndex', 'detailMode', 'surfaceMode', 'resultKind',
      'resultRef', 'terminalReason', 'registrationMissing', 'authorityRevision', 'savedAt'
    ]);
    if (!raw) return null;
    var decision = text(raw.decision, 20);
    var authority = {
      schema: text(raw.schema, 80),
      decision: decision,
      accountKey: text(raw.accountKey, 140),
      technicalSourceBatchId: text(raw.technicalSourceBatchId, 260),
      blueprintId: text(raw.blueprintId, 260),
      archiveBatchId: text(raw.archiveBatchId, 260),
      archiveAssetId: text(raw.archiveAssetId, 260),
      resultId: text(raw.resultId, 260),
      taskId: text(raw.taskId, 180),
      jobId: text(raw.jobId, 260),
      logicalJobId: text(raw.logicalJobId, 260),
      generation: safeInteger(raw.generation, 1, Number.MAX_SAFE_INTEGER, 0),
      attempt: safeInteger(raw.attempt, 1, Number.MAX_SAFE_INTEGER, 0),
      inputFingerprint: text(raw.inputFingerprint, 260),
      screenIndex: safeInteger(raw.screenIndex, 0, 15, -1),
      imageIndex: safeInteger(raw.imageIndex, 1, 16, -1),
      detailMode: text(raw.detailMode, 80),
      surfaceMode: text(raw.surfaceMode, 40),
      resultKind: text(raw.resultKind, 20),
      resultRef: raw.resultRef == null ? null : raw.resultRef,
      terminalReason: text(raw.terminalReason, 80),
      registrationMissing: raw.registrationMissing === true,
      authorityRevision: safeInteger(raw.authorityRevision, 1, Number.MAX_SAFE_INTEGER, 0),
      savedAt: safeInteger(raw.savedAt, 1, Number.MAX_SAFE_INTEGER, 0)
    };
    if (authority.schema !== 'REFERENCE_DETAIL_ARCHIVE_AUTHORITY_V1' ||
        ['commit', 'tombstone', 'preserve'].indexOf(decision) < 0 ||
        !referenceProvisionalIdentityComplete(authority) || authority.authorityRevision < 1 || authority.savedAt < 1 ||
        authority.resultKind !== 'image') return null;
    if (decision === 'commit') {
      var ref = exactDataValues(authority.resultRef, ['kind', 'ref', 'resultId']);
      if (!ref ||
          ref.kind !== 'image' || text(ref.resultId, 260) !== authority.resultId || text(ref.ref, 260) !== authority.archiveAssetId ||
          authority.terminalReason) return null;
      authority.resultRef = ref;
    } else if (authority.resultRef != null) {
      return null;
    }
    if (decision === 'tombstone' && (!TOMBSTONE_REASONS[authority.terminalReason] ||
        (authority.terminalReason === 'registration_cleared' && !authority.registrationMissing))) return null;
    if (decision === 'preserve' && !PRESERVE_REASONS[authority.terminalReason]) return null;
    return authority;
  }

  function tombstoneRecord(authority) {
    return {
      schema: 'IMAGE_ARCHIVE_REFERENCE_TOMBSTONE_V1',
      schemaVersion: 1,
      accountKey: authority.accountKey,
      technicalSourceBatchId: authority.technicalSourceBatchId,
      blueprintId: authority.blueprintId,
      archiveBatchId: authority.archiveBatchId,
      archiveAssetId: authority.archiveAssetId,
      resultId: authority.resultId,
      taskId: authority.taskId,
      jobId: authority.jobId,
      logicalJobId: authority.logicalJobId,
      generation: authority.generation,
      attempt: authority.attempt,
      inputFingerprint: authority.inputFingerprint,
      screenIndex: authority.screenIndex,
      imageIndex: authority.imageIndex,
      detailMode: authority.detailMode,
      surfaceMode: authority.surfaceMode,
      resultKind: authority.resultKind,
      terminalReason: authority.terminalReason,
      registrationMissing: authority.registrationMissing,
      authorityRevision: authority.authorityRevision,
      savedAt: authority.savedAt
    };
  }

  function checkedScanCursor(raw, accountKey) {
    if (raw == null) return null;
    raw = exactDataValues(raw, ['schema', 'scope', 'accountKey', 'itemAccountKey', 'provisionalExpiresAt', 'archiveAssetId']);
    if (!raw || raw.schema !== 'IMAGE_ARCHIVE_PROVISIONAL_SCAN_CURSOR_V1') return false;
    var scope = accountKey ? 'account' : 'all';
    var cursor = {
      schema: 'IMAGE_ARCHIVE_PROVISIONAL_SCAN_CURSOR_V1',
      scope: text(raw.scope, 20),
      accountKey: text(raw.accountKey, 140),
      itemAccountKey: text(raw.itemAccountKey, 140),
      provisionalExpiresAt: safeInteger(raw.provisionalExpiresAt, 1, Number.MAX_SAFE_INTEGER, 0),
      archiveAssetId: text(raw.archiveAssetId, 260)
    };
    if (cursor.scope !== scope || !cursor.provisionalExpiresAt || !cursor.archiveAssetId) return false;
    if (scope === 'account' && (cursor.accountKey !== accountKey || cursor.itemAccountKey)) return false;
    if (scope === 'all' && (cursor.accountKey || !cursor.itemAccountKey)) return false;
    return cursor;
  }

  // 只挑出需要权威对账的候选项；过期时间绝不是删除依据。游标每次最多读取
  // limit + 1 条，返回值不含 Blob。accountKey 可省略，供后台发现注册已丢失的账号。
  function scanExpiredReferenceProvisionals(options) {
    options = options || {};
    var accountKey = options.accountKey == null || options.accountKey === '' ? '' : normalizeAccountKey(options.accountKey);
    var now = safeInteger(options.now, 1, Number.MAX_SAFE_INTEGER, Date.now());
    var requestedLimit = Number(options.limit);
    var limit = Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 24;
    limit = Math.max(1, Math.min(MAX_PROVISIONAL_SCAN_LIMIT, limit));
    var cursor = checkedScanCursor(options.cursor, accountKey);
    if (cursor === false) return Promise.resolve({
      ok: false,
      schema: 'IMAGE_ARCHIVE_PROVISIONAL_SCAN_V1',
      items: [],
      nextCursor: null,
      hasMore: false,
      reason: 'invalid_cursor'
    });
    if (cursor && cursor.provisionalExpiresAt > now) return Promise.resolve({
      ok: false,
      schema: 'IMAGE_ARCHIVE_PROVISIONAL_SCAN_V1',
      items: [],
      nextCursor: null,
      hasMore: false,
      reason: 'invalid_cursor'
    });
    var KeyRange = root.IDBKeyRange;
    if (!KeyRange || typeof KeyRange.bound !== 'function') {
      return Promise.reject(new Error('当前环境不支持有界档案游标。'));
    }
    var indexName = accountKey ? 'accountReferenceProvisionalScanKey' : 'referenceProvisionalScanKey';
    var lower = accountKey
      ? [accountKey, 'provisional', 'detail', 'reference', cursor ? cursor.provisionalExpiresAt : 0, cursor ? cursor.archiveAssetId : '']
      : ['provisional', 'detail', 'reference', cursor ? cursor.provisionalExpiresAt : 0, cursor ? cursor.itemAccountKey : '', cursor ? cursor.archiveAssetId : ''];
    var upper = accountKey
      ? [accountKey, 'provisional', 'detail', 'reference', now, '\uffff']
      : ['provisional', 'detail', 'reference', now, '\uffff', '\uffff'];
    var range = KeyRange.bound(lower, upper, !!cursor, false);
    var items = [];
    var sawExtra = false;
    return transaction([ASSET_STORE], 'readonly', function (stores, fail) {
      var request = stores[ASSET_STORE].index(indexName).openCursor(range, 'next');
      request.onerror = function () { fail(request.error || new Error('扫描待对账临时档案失败')); };
      request.onsuccess = function () {
        var recordCursor = request.result;
        if (!recordCursor) return;
        if (items.length >= limit) {
          sawExtra = true;
          return;
        }
        items.push(provisionalReceipt(recordCursor.value, { includeWriteToken: true }));
        recordCursor.continue();
      };
      return function () {
        var last = items.length ? items[items.length - 1] : null;
        var nextCursor = sawExtra && last ? {
          schema: 'IMAGE_ARCHIVE_PROVISIONAL_SCAN_CURSOR_V1',
          scope: accountKey ? 'account' : 'all',
          accountKey: accountKey || '',
          itemAccountKey: accountKey ? '' : last.accountKey,
          provisionalExpiresAt: last.provisionalExpiresAt,
          archiveAssetId: last.archiveAssetId
        } : null;
        return {
          ok: true,
          schema: 'IMAGE_ARCHIVE_PROVISIONAL_SCAN_V1',
          accountKey: accountKey || '',
          items: items,
          nextCursor: nextCursor,
          hasMore: !!nextCursor,
          limit: limit,
          scannedThrough: now
        };
      };
    });
  }

  function reconcileReferenceProvisionalAuthority(rawReceipt, rawAuthority) {
    var receipt = checkedProvisionalReceipt(rawReceipt);
    var authority = checkedReferenceAuthority(rawAuthority);
    if (!receipt || !authority || !referenceProvisionalIdentityComplete(receipt) ||
        !referenceProvisionalIdentityMatches(receipt, authority)) {
      return Promise.resolve({ ok: false, action: 'preserved', reason: !receipt || !authority ? 'invalid_authority' : 'identity_mismatch' });
    }
    if (authority.authorityRevision < Math.max(1, receipt.writeRevision) || authority.savedAt < receipt.provisionalAt) {
      return Promise.resolve({ ok: false, action: 'preserved', reason: 'stale_authority' });
    }
    if (authority.decision === 'preserve') {
      return Promise.resolve({ ok: true, action: 'preserved', reason: authority.terminalReason, archiveAssetId: receipt.archiveAssetId });
    }
    var outcome = { ok: false, action: 'preserved', reason: 'missing', archiveAssetId: receipt.archiveAssetId };
    return transaction([ASSET_STORE, BATCH_STORE, TOMBSTONE_STORE], 'readwrite', function (stores, fail) {
      var assetRequest = stores[ASSET_STORE].get(receipt.archiveAssetId);
      var tombstoneRequest = stores[TOMBSTONE_STORE].get(receipt.archiveAssetId);
      var assetReady = false;
      var tombstoneReady = false;
      var asset;
      var existingTombstone;
      var decided = false;
      var failed = false;

      function stop(error) {
        if (failed) return;
        failed = true;
        fail(error);
      }

      function finish() {
        if (failed || decided || !assetReady || !tombstoneReady) return;
        decided = true;
        if (existingTombstone) {
          if (!referenceProvisionalIdentityMatches(existingTombstone, authority)) {
            outcome = { ok: false, action: 'preserved', reason: 'identity_mismatch', archiveAssetId: receipt.archiveAssetId };
            return;
          }
          outcome = authority.decision === 'tombstone'
            ? { ok: true, action: 'tombstoned', tombstoned: true, removed: 0, alreadyTombstoned: true, archiveAssetId: receipt.archiveAssetId }
            : { ok: false, action: 'blocked', reason: 'tombstoned', archiveAssetId: receipt.archiveAssetId };
          return;
        }
        if (asset && !referenceProvisionalIdentityMatches(asset, authority)) {
          outcome = { ok: false, action: 'preserved', reason: 'identity_mismatch', archiveAssetId: receipt.archiveAssetId };
          return;
        }
        if (authority.decision === 'commit') {
          if (!asset) return;
          if (asset.archiveState !== 'provisional') {
            outcome = { ok: true, action: 'committed', committed: true, alreadyCommitted: true, archiveAssetId: receipt.archiveAssetId, resultId: receipt.resultId };
            return;
          }
          asset.archiveState = 'committed';
          asset.archiveWriteToken = '';
          asset.committedAt = authority.savedAt;
          asset.updatedAt = Math.max(Number(asset.updatedAt) || 0, authority.savedAt);
          asset.archiveAuthorityRevision = authority.authorityRevision;
          stores[ASSET_STORE].put(asset);
          outcome = { ok: true, action: 'committed', committed: true, archiveAssetId: receipt.archiveAssetId, resultId: receipt.resultId };
          return;
        }
        if (asset && asset.archiveState !== 'provisional') {
          outcome = { ok: false, action: 'preserved', reason: 'already_committed', archiveAssetId: receipt.archiveAssetId };
          return;
        }
        // 首次撤销必须与真实的 exact provisional 在同一事务内线性化。
        // 不对缺失 asset 预种全局 archiveAssetId 墓碑，否则伪造收据可以
        // 抢先占用其他批次未来才会写入的 assetId。
        if (!asset) {
          outcome = { ok: false, action: 'preserved', reason: 'missing', archiveAssetId: receipt.archiveAssetId };
          return;
        }
        stores[TOMBSTONE_STORE].put(tombstoneRecord(authority));
        var deleteRequest = stores[ASSET_STORE].delete(receipt.archiveAssetId);
        deleteRequest.onerror = function () { stop(deleteRequest.error || new Error('删除已撤销临时档案失败')); };
        deleteRequest.onsuccess = function () {
          outcome = { ok: true, action: 'tombstoned', tombstoned: true, removed: 1, archiveAssetId: receipt.archiveAssetId };
          var countRequest = stores[ASSET_STORE].index('archiveBatchId').count(receipt.archiveBatchId);
          countRequest.onerror = function () { stop(countRequest.error || new Error('复核撤销档案批次失败')); };
          countRequest.onsuccess = function () {
            if (Number(countRequest.result) !== 0) return;
            var batchRequest = stores[BATCH_STORE].get(receipt.archiveBatchId);
            batchRequest.onerror = function () { stop(batchRequest.error || new Error('读取待清理撤销批次失败')); };
            batchRequest.onsuccess = function () {
              var batch = batchRequest.result;
              if (batch && normalizeAccountKey(batch.accountKey) === receipt.accountKey) stores[BATCH_STORE].delete(receipt.archiveBatchId);
            };
          };
        };
      }

      assetRequest.onerror = function () { stop(assetRequest.error || new Error('读取待对账临时档案失败')); };
      tombstoneRequest.onerror = function () { stop(tombstoneRequest.error || new Error('读取档案墓碑失败')); };
      assetRequest.onsuccess = function () { asset = assetRequest.result; assetReady = true; finish(); };
      tombstoneRequest.onsuccess = function () { existingTombstone = tombstoneRequest.result; tombstoneReady = true; finish(); };
      return function () { return outcome; };
    });
  }

  function saveProvisionalResult(raw, options) {
    options = options || {};
    var safe = sanitizeArchiveInput(raw);
    var writeToken = randomWriteToken();
    return transaction([ASSET_STORE, TOMBSTONE_STORE], 'readonly', function (stores, fail) {
      var checked = {};
      var assetRequest = stores[ASSET_STORE].get(safe.archiveAssetId);
      var tombstoneRequest = stores[TOMBSTONE_STORE].get(safe.archiveAssetId);
      assetRequest.onerror = function () { fail(assetRequest.error || new Error('预检临时档案图片失败')); };
      tombstoneRequest.onerror = function () { fail(tombstoneRequest.error || new Error('预检临时档案墓碑失败')); };
      assetRequest.onsuccess = function () { checked.asset = assetRequest.result; };
      tombstoneRequest.onsuccess = function () { checked.tombstone = tombstoneRequest.result; };
      return function () { return checked; };
    }).then(function (checked) {
      var blocked = rejectForTombstone(checked.tombstone, safe);
      if (blocked) throw blocked;
      if (!checked.asset) return null;
      if (!provisionalIdentityMatches(checked.asset, safe)) throw archiveCollision('本机档案 assetId 已被其他账号或结果身份占用，拒绝覆盖。');
      return provisionalReceipt(checked.asset, { created: false });
    }).then(function (preflight) {
      if (preflight) return preflight;
      return sourceToBlob(raw && (raw.blob || raw.url), options.fetch).then(function (blob) {
      return transaction([BATCH_STORE, ASSET_STORE, TOMBSTONE_STORE], 'readwrite', function (stores, fail) {
        var assetRequest = stores[ASSET_STORE].get(safe.archiveAssetId);
        var batchRequest = stores[BATCH_STORE].get(safe.archiveBatchId);
        var tombstoneRequest = stores[TOMBSTONE_STORE].get(safe.archiveAssetId);
        var assetReady = false;
        var batchReady = false;
        var tombstoneReady = false;
        var existingAsset;
        var existingBatch;
        var existingTombstone;
        var outcome;
        var stopped = false;

        function stop(error) {
          if (stopped) return;
          stopped = true;
          fail(error);
        }

        function finish() {
          if (stopped || !assetReady || !batchReady || !tombstoneReady) return;
          var blocked = rejectForTombstone(existingTombstone, safe);
          if (blocked) {
            stop(blocked);
            return;
          }
          if (existingAsset) {
            if (!provisionalIdentityMatches(existingAsset, safe)) {
              stop(archiveCollision('本机档案 assetId 已被其他账号或结果身份占用，拒绝覆盖。'));
              return;
            }
            outcome = provisionalReceipt(existingAsset, { created: false });
            return;
          }
          if (existingBatch && normalizeAccountKey(existingBatch.accountKey) !== safe.accountKey) {
            stop(archiveCollision('本机档案 batchId 已被其他账号占用，拒绝覆盖。'));
            return;
          }
          var now = Date.now();
          var batch = existingBatch || {};
          stores[BATCH_STORE].put({
            archiveBatchId: safe.archiveBatchId,
            accountKey: safe.accountKey,
            surfaceMode: safe.surfaceMode,
            creativeRoute: safe.creativeRoute,
            detailMode: safe.detailMode,
            sourceBatchId: safe.sourceBatchId,
            technicalSourceBatchId: batch.technicalSourceBatchId || safe.technicalSourceBatchId,
            archiveProjectId: safe.archiveProjectId || batch.archiveProjectId || '',
            batchTitle: safe.businessBatchTitle || batch.businessBatchTitle || batch.batchTitle || safe.batchTitle,
            businessBatchTitle: safe.businessBatchTitle || batch.businessBatchTitle || '',
            businessType: safe.businessType || batch.businessType || '',
            productName: safe.productName || batch.productName || '',
            styleName: safe.styleName || batch.styleName || '',
            strengthName: safe.strengthName || batch.strengthName || '',
            copyModeName: safe.copyModeName || batch.copyModeName || '',
            linkId: batch.linkId || safe.linkId,
            skuId: batch.skuId || safe.skuId,
            provider: batch.provider || safe.provider,
            imageModel: batch.imageModel || safe.imageModel,
            ratio: batch.ratio || safe.ratio,
            resolution: batch.resolution || safe.resolution,
            createdAt: Number(batch.createdAt) || safe.createdAt,
            updatedAt: now
          });
          var record = Object.assign({}, safe, {
            blob: blob,
            mimeType: allowedMime(blob.type),
            size: Number(blob.size) || 0,
            deletedAt: 0,
            purgeAt: 0,
            archiveState: 'provisional',
            archiveWriteToken: writeToken,
            archiveWriteRevision: 1,
            provisionalAt: now,
            provisionalExpiresAt: now + PROVISIONAL_RETENTION_MS,
            updatedAt: now
          });
          stores[ASSET_STORE].put(record);
          outcome = provisionalReceipt(record, { created: true });
        }

        assetRequest.onerror = function () { stop(assetRequest.error || new Error('读取临时档案图片失败')); };
        batchRequest.onerror = function () { stop(batchRequest.error || new Error('读取临时档案批次失败')); };
        tombstoneRequest.onerror = function () { stop(tombstoneRequest.error || new Error('读取临时档案墓碑失败')); };
        assetRequest.onsuccess = function () { existingAsset = assetRequest.result; assetReady = true; finish(); };
        batchRequest.onsuccess = function () { existingBatch = batchRequest.result; batchReady = true; finish(); };
        tombstoneRequest.onsuccess = function () { existingTombstone = tombstoneRequest.result; tombstoneReady = true; finish(); };
        return function () { return outcome; };
      });
      });
    });
  }

  function commitProvisional(rawReceipt, acceptedIdentity) {
    var receipt = checkedProvisionalReceipt(rawReceipt);
    if (!receipt) return Promise.resolve({ ok: false, committed: false, reason: 'invalid_receipt' });
    var outcome = { ok: false, committed: false, reason: 'missing' };
    return transaction([ASSET_STORE, TOMBSTONE_STORE], 'readwrite', function (stores, fail) {
      var assetRequest = stores[ASSET_STORE].get(receipt.archiveAssetId);
      var tombstoneRequest = stores[TOMBSTONE_STORE].get(receipt.archiveAssetId);
      var assetReady = false;
      var tombstoneReady = false;
      var record;
      var tombstone;
      function finish() {
        if (!assetReady || !tombstoneReady) return;
        if (tombstone) {
          outcome = referenceProvisionalIdentityMatches(tombstone, receipt)
            ? { ok: false, committed: false, reason: 'tombstoned', archiveAssetId: receipt.archiveAssetId }
            : { ok: false, committed: false, reason: 'identity_mismatch', archiveAssetId: receipt.archiveAssetId };
          return;
        }
        if (!record) return;
        if (!provisionalIdentityMatches(record, receipt)) {
          outcome = { ok: false, committed: false, reason: 'identity_mismatch' };
          return;
        }
        if (record.archiveState !== 'provisional') {
          outcome = { ok: true, committed: true, alreadyCommitted: true, archiveAssetId: receipt.archiveAssetId };
          return;
        }
        if (!acceptedIdentity && (!receipt.created || !receipt.writeToken || text(record.archiveWriteToken, 260) !== receipt.writeToken)) {
          outcome = { ok: false, committed: false, reason: 'not_owner' };
          return;
        }
        record.archiveState = 'committed';
        record.archiveWriteToken = '';
        record.committedAt = Date.now();
        record.updatedAt = record.committedAt;
        stores[ASSET_STORE].put(record);
        outcome = { ok: true, committed: true, archiveAssetId: receipt.archiveAssetId, resultId: receipt.resultId };
      }
      assetRequest.onerror = function () { fail(assetRequest.error || new Error('读取待提交临时档案失败')); };
      tombstoneRequest.onerror = function () { fail(tombstoneRequest.error || new Error('读取待提交档案墓碑失败')); };
      assetRequest.onsuccess = function () { record = assetRequest.result; assetReady = true; finish(); };
      tombstoneRequest.onsuccess = function () { tombstone = tombstoneRequest.result; tombstoneReady = true; finish(); };
      return function () { return outcome; };
    });
  }

  function commitProvisionalResult(rawReceipt) {
    return commitProvisional(rawReceipt, false);
  }

  // 仅供已经由权威 runtime 精确接纳的 resultRef 使用。它不授予删除权，
  // 只把同账号、同任务/请求/分屏身份的既有 provisional 提升为 committed。
  function commitAcceptedProvisionalResult(rawReceipt) {
    return commitProvisional(rawReceipt, true);
  }

  function rollbackProvisionalResult(rawReceipt) {
    var receipt = checkedProvisionalReceipt(rawReceipt);
    if (!receipt || !receipt.created || !receipt.writeToken) {
      return Promise.resolve({ ok: true, removed: 0, reason: receipt ? 'not_owner' : 'invalid_receipt' });
    }
    var outcome = { ok: true, removed: 0, reason: 'missing' };
    return transaction([ASSET_STORE, BATCH_STORE, TOMBSTONE_STORE], 'readwrite', function (stores, fail) {
      var assetRequest = stores[ASSET_STORE].get(receipt.archiveAssetId);
      var tombstoneRequest = stores[TOMBSTONE_STORE].get(receipt.archiveAssetId);
      var assetReady = false;
      var tombstoneReady = false;
      var record;
      var tombstone;
      function finish() {
        if (!assetReady || !tombstoneReady) return;
        if (tombstone) {
          outcome = referenceProvisionalIdentityMatches(tombstone, receipt)
            ? { ok: true, removed: 0, reason: 'tombstoned', archiveAssetId: receipt.archiveAssetId }
            : { ok: true, removed: 0, reason: 'not_owner' };
          return;
        }
        if (!record) return;
        if (!provisionalIdentityMatches(record, receipt) || record.archiveState !== 'provisional' ||
            text(record.archiveWriteToken, 260) !== receipt.writeToken) {
          outcome = { ok: true, removed: 0, reason: 'not_owner' };
          return;
        }
        stores[ASSET_STORE].delete(receipt.archiveAssetId);
        outcome = { ok: true, removed: 1, archiveAssetId: receipt.archiveAssetId };
        var countRequest = stores[ASSET_STORE].index('archiveBatchId').count(receipt.archiveBatchId);
        countRequest.onerror = function () { fail(countRequest.error || new Error('复核临时档案批次失败')); };
        countRequest.onsuccess = function () {
          if (Number(countRequest.result) !== 0) return;
          var batchRequest = stores[BATCH_STORE].get(receipt.archiveBatchId);
          batchRequest.onerror = function () { fail(batchRequest.error || new Error('读取待清理临时档案批次失败')); };
          batchRequest.onsuccess = function () {
            var batch = batchRequest.result;
            if (batch && normalizeAccountKey(batch.accountKey) === receipt.accountKey) stores[BATCH_STORE].delete(receipt.archiveBatchId);
          };
        };
      }
      assetRequest.onerror = function () { fail(assetRequest.error || new Error('读取待回滚临时档案失败')); };
      tombstoneRequest.onerror = function () { fail(tombstoneRequest.error || new Error('读取待回滚档案墓碑失败')); };
      assetRequest.onsuccess = function () { record = assetRequest.result; assetReady = true; finish(); };
      tombstoneRequest.onsuccess = function () { tombstone = tombstoneRequest.result; tombstoneReady = true; finish(); };
      return function () { return outcome; };
    });
  }

  function saveResult(raw, options) {
    options = options || {};
    var safe = sanitizeArchiveInput(raw);
    return transaction([ASSET_STORE, TOMBSTONE_STORE], 'readonly', function (stores, fail) {
      var checked = {};
      var assetRequest = stores[ASSET_STORE].get(safe.archiveAssetId);
      var tombstoneRequest = stores[TOMBSTONE_STORE].get(safe.archiveAssetId);
      assetRequest.onerror = function () { fail(assetRequest.error || new Error('预检档案图片失败')); };
      tombstoneRequest.onerror = function () { fail(tombstoneRequest.error || new Error('预检档案墓碑失败')); };
      assetRequest.onsuccess = function () { checked.asset = assetRequest.result; };
      tombstoneRequest.onsuccess = function () { checked.tombstone = tombstoneRequest.result; };
      return function () { return checked; };
    }).then(function (checked) {
      var blocked = rejectForTombstone(checked.tombstone, safe);
      if (blocked) throw blocked;
      if (checked.asset) {
        if (!provisionalIdentityMatches(checked.asset, safe)) {
          throw archiveCollision('本机档案 assetId 已被其他账号或结果身份占用，拒绝覆盖。');
        }
        return { existingPreflight: true };
      }
      return sourceToBlob(raw && (raw.blob || raw.url), options.fetch);
    }).then(function (blobOrExisting) {
      var expectedExisting = !!(blobOrExisting && blobOrExisting.existingPreflight);
      var blob = expectedExisting ? null : blobOrExisting;
      var outcome;
      return transaction([BATCH_STORE, ASSET_STORE, TOMBSTONE_STORE], 'readwrite', function (stores, fail) {
        var batchRequest = stores[BATCH_STORE].get(safe.archiveBatchId);
        var assetRequest = stores[ASSET_STORE].get(safe.archiveAssetId);
        var tombstoneRequest = stores[TOMBSTONE_STORE].get(safe.archiveAssetId);
        var batchReady = false;
        var assetReady = false;
        var tombstoneReady = false;
        var existingBatch;
        var existingAsset;
        var existingTombstone;
        var stopped = false;

        function stop(error) {
          if (stopped) return;
          stopped = true;
          fail(error);
        }

        function finish() {
          if (stopped || !batchReady || !assetReady || !tombstoneReady) return;
          var blocked = rejectForTombstone(existingTombstone, safe);
          if (blocked) { stop(blocked); return; }
          if (existingAsset) {
            if (!provisionalIdentityMatches(existingAsset, safe)) {
              stop(archiveCollision('本机档案 assetId 已被其他账号或结果身份占用，拒绝覆盖。'));
              return;
            }
            outcome = Object.assign({}, safe, {
              size: Math.max(0, Number(existingAsset.size) || 0),
              mimeType: text(existingAsset.mimeType, 80),
              archiveState: existingAsset.archiveState || 'committed',
              alreadyExists: true
            });
            return;
          }
          if (expectedExisting) {
            var missing = Object.assign(new Error('幂等档案在二次复核时已不存在。'), { code: 'ARCHIVE_ASSET_MISSING' });
            stop(missing);
            return;
          }
          if (existingBatch && normalizeAccountKey(existingBatch.accountKey) !== safe.accountKey) {
            stop(archiveCollision('本机档案 batchId 已被其他账号占用，拒绝覆盖。'));
            return;
          }
          var existing = existingBatch || {};
          var now = Date.now();
          stores[BATCH_STORE].put({
            archiveBatchId: safe.archiveBatchId,
            accountKey: safe.accountKey,
            surfaceMode: safe.surfaceMode,
            creativeRoute: safe.creativeRoute,
            detailMode: safe.detailMode,
            sourceBatchId: safe.sourceBatchId,
            technicalSourceBatchId: existing.technicalSourceBatchId || safe.technicalSourceBatchId,
            archiveProjectId: safe.archiveProjectId || existing.archiveProjectId || '',
            batchTitle: safe.businessBatchTitle || existing.businessBatchTitle || existing.batchTitle || safe.batchTitle,
            businessBatchTitle: safe.businessBatchTitle || existing.businessBatchTitle || '',
            businessType: safe.businessType || existing.businessType || '',
            productName: safe.productName || existing.productName || '',
            styleName: safe.styleName || existing.styleName || '',
            strengthName: safe.strengthName || existing.strengthName || '',
            copyModeName: safe.copyModeName || existing.copyModeName || '',
            linkId: existing.linkId || safe.linkId,
            skuId: existing.skuId || safe.skuId,
            provider: existing.provider || safe.provider,
            imageModel: existing.imageModel || safe.imageModel,
            ratio: existing.ratio || safe.ratio,
            resolution: existing.resolution || safe.resolution,
            createdAt: Number(existing.createdAt) || safe.createdAt,
            updatedAt: now
          });
          stores[ASSET_STORE].put(Object.assign({}, safe, {
            blob: blob,
            mimeType: allowedMime(blob.type),
            size: Number(blob.size) || 0,
            archiveState: 'committed',
            deletedAt: 0,
            purgeAt: 0,
            updatedAt: now
          }));
          outcome = Object.assign({}, safe, { size: blob.size, mimeType: blob.type, archiveState: 'committed' });
        }

        batchRequest.onerror = function () { fail(batchRequest.error || new Error('读取档案批次失败')); };
        assetRequest.onerror = function () { fail(assetRequest.error || new Error('读取档案图片失败')); };
        tombstoneRequest.onerror = function () { fail(tombstoneRequest.error || new Error('读取档案墓碑失败')); };
        batchRequest.onsuccess = function () { existingBatch = batchRequest.result; batchReady = true; finish(); };
        assetRequest.onsuccess = function () { existingAsset = assetRequest.result; assetReady = true; finish(); };
        tombstoneRequest.onsuccess = function () { existingTombstone = tombstoneRequest.result; tombstoneReady = true; finish(); };
        return function () { return outcome; };
      });
    });
  }

  function recordsForAccount(accountKey) {
    var output = { batches: [], assets: [] };
    return transaction([BATCH_STORE, ASSET_STORE], 'readonly', function (stores, fail) {
      var batchRequest = stores[BATCH_STORE].index('accountKey').getAll(accountKey);
      var assetRequest = stores[ASSET_STORE].index('accountKey').getAll(accountKey);
      batchRequest.onsuccess = function () { output.batches = batchRequest.result || []; };
      assetRequest.onsuccess = function () { output.assets = assetRequest.result || []; };
      batchRequest.onerror = function () { fail(batchRequest.error || new Error('读取档案批次失败')); };
      assetRequest.onerror = function () { fail(assetRequest.error || new Error('读取档案图片失败')); };
      return function () { return output; };
    });
  }

  function permanentlyRemove(accountKey, assetIds) {
    accountKey = normalizeAccountKey(accountKey);
    var selected = {};
    (assetIds || []).forEach(function (id) { if (id) selected[String(id)] = true; });
    if (!Object.keys(selected).length) return Promise.resolve({ removed: 0 });
    var removed = 0;
    return transaction([ASSET_STORE], 'readwrite', function (stores, fail) {
      Object.keys(selected).forEach(function (id) {
        var request = stores[ASSET_STORE].get(id);
        request.onerror = function () { fail(request.error || new Error('读取待删除档案失败')); };
        request.onsuccess = function () {
          var record = request.result;
          if (!record || normalizeAccountKey(record.accountKey) !== accountKey) return;
          stores[ASSET_STORE].delete(id);
          removed++;
        };
      });
      return function () { return { removed: removed }; };
    }).then(function (result) {
      return removeEmptyBatches(accountKey).then(function () { return result; });
    });
  }

  function removeEmptyBatches(accountKey) {
    accountKey = normalizeAccountKey(accountKey);
    return recordsForAccount(accountKey).then(function (records) {
      var occupied = {};
      records.assets.forEach(function (asset) { occupied[asset.archiveBatchId] = true; });
      var empty = records.batches.filter(function (batch) { return !occupied[batch.archiveBatchId]; });
      if (!empty.length) return { removed: 0 };
      return transaction([BATCH_STORE], 'readwrite', function (stores) {
        empty.forEach(function (batch) { stores[BATCH_STORE].delete(batch.archiveBatchId); });
        return { removed: empty.length };
      });
    });
  }

  function mutateTrash(accountKey, assetIds, deleted) {
    accountKey = normalizeAccountKey(accountKey);
    var selected = {};
    (assetIds || []).forEach(function (id) { if (id) selected[String(id)] = true; });
    var changed = 0;
    var now = Date.now();
    return transaction([ASSET_STORE], 'readwrite', function (stores, fail) {
      Object.keys(selected).forEach(function (id) {
        var request = stores[ASSET_STORE].get(id);
        request.onerror = function () { fail(request.error || new Error('读取回收站档案失败')); };
        request.onsuccess = function () {
          var record = request.result;
          if (!record || normalizeAccountKey(record.accountKey) !== accountKey) return;
          record.deletedAt = deleted ? now : 0;
          record.purgeAt = deleted ? (now + RETENTION_MS) : 0;
          record.updatedAt = now;
          stores[ASSET_STORE].put(record);
          changed++;
        };
      });
      return function () { return { changed: changed, deleted: !!deleted, purgeAt: deleted ? now + RETENTION_MS : 0 }; };
    });
  }

  function moveToTrash(accountKey, assetIds) { return mutateTrash(accountKey, assetIds, true); }
  function restore(accountKey, assetIds) { return mutateTrash(accountKey, assetIds, false); }

  function purgeExpired(accountKey, now) {
    accountKey = normalizeAccountKey(accountKey);
    now = Number(now) || Date.now();
    return recordsForAccount(accountKey).then(function (records) {
      var expired = records.assets.filter(function (asset) {
        return Number(asset.deletedAt) > 0 && Number(asset.purgeAt) > 0 && Number(asset.purgeAt) <= now;
      }).map(function (asset) { return asset.archiveAssetId; });
      return permanentlyRemove(accountKey, expired).then(function () { return { removed: expired.length }; });
    });
  }

  function purgeAllExpired(now) {
    now = Number(now) || Date.now();
    var accountKeys = {};
    var removed = 0;
    return transaction([ASSET_STORE], 'readwrite', function (stores, fail) {
      var request = stores[ASSET_STORE].getAll();
      request.onerror = function () { fail(request.error || new Error('读取超期档案失败')); };
      request.onsuccess = function () {
        (request.result || []).forEach(function (asset) {
          if (!(Number(asset.deletedAt) > 0 && Number(asset.purgeAt) > 0 && Number(asset.purgeAt) <= now)) return;
          stores[ASSET_STORE].delete(asset.archiveAssetId);
          accountKeys[normalizeAccountKey(asset.accountKey)] = true;
          removed++;
        });
      };
      return function () { return { removed: removed, accountKeys: Object.keys(accountKeys) }; };
    }).then(function (result) {
      return Promise.all(result.accountKeys.map(removeEmptyBatches)).then(function () { return { removed: result.removed }; });
    });
  }

  function styleMetaFromLegacyPrompt(asset) {
    if (!asset || asset.creativeRoute !== 'style-refresh') return {};
    var prompt = String(asset.prompt || '');
    var styleMatch = /所选风格[:：]\s*([^\/\n。]+)/.exec(prompt);
    var strengthMatch = /创意强度[:：]\s*([^，,\n。]+)/.exec(prompt);
    var planMatch = /Use this image-specific refresh plan exactly:\s*\n([\s\S]*?)\nSTYLE REFRESH CONTRACT/.exec(prompt);
    var lines = planMatch ? planMatch[1].split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean) : [];
    var task = lines[3] || '';
    var colon = task.search(/[:：]/);
    var productName = colon > 0 && colon <= 40 ? text(task.slice(0, colon), 180) : '';
    var direction = text(lines[0], 180);
    var styleName = text(styleMatch && styleMatch[1], 100) || (lines[1] && text(lines[1].split(/[:：]/)[0], 100));
    var strengthName = text(strengthMatch && strengthMatch[1], 80) || text(lines[2], 80);
    var copyModeName = /用户选择不要文案/.test(prompt) ? '不要文案' : (/用户选择修改已有文案/.test(prompt) ? '修改已有文案' : (/用户选择生成新文案/.test(prompt) ? '生成新文案' : ''));
    return {
      productName: productName,
      styleName: styleName,
      strengthName: strengthName,
      copyModeName: copyModeName,
      businessSummary: [direction, task].filter(Boolean).join(' · ')
    };
  }

  function projectArchiveRecords(records, options) {
    records = records || {};
    options = options || {};
    var missing = [];
    var batchById = {};
    var resultById = {};
    var validAssets = [];
    (records.batches || []).forEach(function (batch) {
      if (batch && batch.archiveBatchId) batchById[batch.archiveBatchId] = batch;
    });
    (records.assets || []).forEach(function (asset) {
      if (asset && asset.archiveState === 'provisional' && !options.includeProvisional) return;
      if (!validBlob(asset && asset.blob)) {
        if (asset && asset.archiveAssetId) missing.push(asset.archiveAssetId);
        return;
      }
      validAssets.push(asset);
      if (asset.resultId) resultById[asset.resultId] = asset;
    });

    function rootAsset(asset) {
      var current = asset;
      var seen = {};
      while (current && current.parentResultId && resultById[current.parentResultId] && !seen[current.parentResultId]) {
        seen[current.parentResultId] = true;
        current = resultById[current.parentResultId];
      }
      return current || asset;
    }

    var roleVersions = {};
    validAssets.slice().sort(function (a, b) {
      return Number(a.createdAt) - Number(b.createdAt) || String(a.archiveAssetId || '').localeCompare(String(b.archiveAssetId || ''));
    }).forEach(function (asset) {
      var root = rootAsset(asset);
      var legacy = styleMetaFromLegacyPrompt(root);
      var legacyProjectId = legacy.productName && legacy.styleName
        ? ('legacy_style_project_' + hashText([legacy.productName, legacy.styleName, legacy.strengthName, legacy.copyModeName].join('|')))
        : '';
      var numberedProjectSeed = numberedLinkSurface(root)
        ? (root.technicalSourceBatchId || root.promptBatchId || root.sourceBatchId || root.archiveProjectId || root.archiveBatchId)
        : '';
      // 旧版可能把同一次 L001-L030 批量生产显示成“主图 · L001”。读取时使用
      // 原始生成批次重新投影，不改写 Blob，也不把不同生成批次混在一起。
      var explicitNumberedProjectId = /^numbered_link_project_/.test(String(asset.archiveProjectId || ''))
        ? asset.archiveProjectId
        : (/^numbered_link_project_/.test(String(root.archiveProjectId || '')) ? root.archiveProjectId : '');
      var numberedProjectId = explicitNumberedProjectId || (numberedProjectSeed
        ? ('numbered_link_project_' + hashText([root.accountKey || '', root.surfaceMode || '', numberedProjectSeed].join('|')))
        : '');
      var projectId = numberedProjectId || asset.archiveProjectId || root.archiveProjectId || legacyProjectId || root.archiveBatchId || asset.archiveBatchId;
      var roleName = text(asset.businessRoleName || asset.variantName || asset.skuCode || '生成图', 180).replace(/\s*引导重生.*$/, '') || '生成图';
      var roleKey = asset.businessRoleKey || ((Number(asset.imageIndex) || 1) + '|' + roleName);
      var linkId = canonicalArchiveLinkId(root.linkId || asset.linkId);
      if (numberedProjectId && linkId) roleKey = linkId + '|' + (Number(asset.imageIndex) || 1) + '|' + roleName;
      var versionKey = projectId + '|' + roleKey;
      roleVersions[versionKey] = (roleVersions[versionKey] || 0) + 1;
      asset._archiveProjection = {
        projectId: projectId,
        rootBatchId: root.archiveBatchId || asset.archiveBatchId,
        roleName: roleName,
        roleKey: roleKey,
        versionIndex: roleVersions[versionKey]
      };
    });

    var groups = {};
    validAssets.forEach(function (sourceAsset) {
      var trashed = Number(sourceAsset.deletedAt) > 0;
      if (!!options.trash !== trashed) return;
      var projection = sourceAsset._archiveProjection || {};
      var groupKey = '$' + (projection.projectId || sourceAsset.archiveBatchId);
      if (!groups[groupKey]) {
        var sourceBatch = batchById[projection.rootBatchId] || batchById[sourceAsset.archiveBatchId] || {};
        groups[groupKey] = Object.assign({}, sourceBatch, {
          archiveBatchId: sourceBatch.archiveBatchId || projection.rootBatchId || sourceAsset.archiveBatchId,
          archiveProjectId: projection.projectId || sourceAsset.archiveProjectId || '',
          assets: []
        });
      }
      var asset = Object.assign({}, sourceAsset, {
        archiveProjectId: projection.projectId || sourceAsset.archiveProjectId || '',
        businessRoleKey: projection.roleKey || sourceAsset.businessRoleKey || '',
        businessRoleName: sourceAsset.businessRoleName || projection.roleName || sourceAsset.variantName || '',
        versionIndex: projection.versionIndex || 1,
        generationKind: sourceAsset.generationKind || (sourceAsset.parentResultId ? 'guide' : 'original')
      });
      var displayLinkId = canonicalArchiveLinkId(asset.linkId);
      asset.businessDisplayName = (displayLinkId ? (displayLinkId + (asset.businessRoleName && asset.businessRoleName !== displayLinkId ? ' · ' + asset.businessRoleName : '')) : asset.businessRoleName) + ' · V' + asset.versionIndex;
      groups[groupKey].assets.push(asset);
    });
    validAssets.forEach(function (asset) { try { delete asset._archiveProjection; } catch (_) {} });

    var batches = Object.keys(groups).map(function (key) {
      var batch = groups[key];
      batch.assets.sort(function (a, b) {
        var aLink = canonicalArchiveLinkId(a.linkId);
        var bLink = canonicalArchiveLinkId(b.linkId);
        return Number(aLink && aLink.slice(1)) - Number(bLink && bLink.slice(1)) ||
          Number(a.imageIndex) - Number(b.imageIndex) || Number(a.versionIndex) - Number(b.versionIndex) || Number(a.createdAt) - Number(b.createdAt);
      });
      var businessAsset = batch.assets.find(function (asset) { return asset.businessBatchTitle || asset.productName || asset.styleName; }) || batch.assets[0] || {};
      var inferred = styleMetaFromLegacyPrompt(businessAsset);
      batch.businessType = batch.businessType || businessAsset.businessType || '';
      batch.productName = batch.productName || businessAsset.productName || inferred.productName || '';
      batch.styleName = batch.styleName || businessAsset.styleName || inferred.styleName || '';
      batch.strengthName = batch.strengthName || businessAsset.strengthName || inferred.strengthName || '';
      batch.copyModeName = batch.copyModeName || businessAsset.copyModeName || inferred.copyModeName || '';
      batch.businessBatchTitle = batch.businessBatchTitle || businessAsset.businessBatchTitle || '';
      var numberedIds = archiveLinkIds(batch.assets.filter(numberedLinkSurface).map(function (asset) { return asset.linkId; }));
      if (numberedIds.length && (batch.surfaceMode === 'main' || batch.surfaceMode === 'detail')) {
        batch.linkIds = numberedIds;
        batch.linkRange = archiveLinkRangeLabel(numberedIds);
        batch.businessBatchTitle = (batch.surfaceMode === 'detail' ? '详情页' : '主图') + ' · ' + batch.linkRange;
      }
      if (!batch.businessBatchTitle && batch.creativeRoute === 'style-refresh') {
        batch.businessBatchTitle = ['风格焕新', batch.productName, batch.styleName].filter(Boolean).join(' · ') || '风格焕新 · 共创方案';
      }
      batch.batchTitle = batch.businessBatchTitle || batch.batchTitle || '本机生图档案';
      batch.assets.forEach(function (asset) {
        var assetInferred = styleMetaFromLegacyPrompt(asset);
        if (!asset.businessSummary && assetInferred.businessSummary && asset.creativeRoute === 'style-refresh') asset.businessSummary = assetInferred.businessSummary;
      });
      var roles = {};
      batch.assets.forEach(function (asset) { roles[asset.businessRoleKey || ((asset.imageIndex || 1) + '|' + asset.businessRoleName)] = true; });
      batch.screenCount = Object.keys(roles).length;
      batch.assetCount = batch.assets.length;
      batch.versionCount = batch.assets.length;
      batch.totalBytes = batch.assets.reduce(function (sum, asset) { return sum + (Number(asset.size) || 0); }, 0);
      batch.updatedAt = Math.max(Number(batch.updatedAt) || 0, batch.assets.reduce(function (latest, asset) { return Math.max(latest, Number(asset.updatedAt) || Number(asset.createdAt) || 0); }, 0));
      return batch;
    });
    batches.sort(function (a, b) { return Number(b.updatedAt) - Number(a.updatedAt); });
    return { batches: batches, missing: missing };
  }

  function list(accountKey, options) {
    accountKey = normalizeAccountKey(accountKey);
    options = options || {};
    var ready = options.skipPurge ? Promise.resolve({ removed: 0 }) : purgeExpired(accountKey, options.now);
    return ready.then(function () {
      return recordsForAccount(accountKey);
    }).then(function (records) {
      var projected = projectArchiveRecords(records, options);
      var cleanup = projected.missing.length ? permanentlyRemove(accountKey, projected.missing) : Promise.resolve({ removed: 0 });
      return cleanup.then(function () { return projected.batches; });
    });
  }

  function summary(accountKey) {
    return Promise.all([list(accountKey, { trash: false }), list(accountKey, { trash: true })]).then(function (parts) {
      var active = parts[0], trash = parts[1];
      return {
        activeBatches: active.length,
        activeAssets: active.reduce(function (sum, batch) { return sum + batch.assets.length; }, 0),
        trashAssets: trash.reduce(function (sum, batch) { return sum + batch.assets.length; }, 0),
        bytes: active.concat(trash).reduce(function (sum, batch) { return sum + batch.totalBytes; }, 0)
      };
    });
  }

  return Object.freeze({
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    RETENTION_MS: RETENTION_MS,
    PROVISIONAL_RETENTION_MS: PROVISIONAL_RETENTION_MS,
    MAX_PROVISIONAL_SCAN_LIMIT: MAX_PROVISIONAL_SCAN_LIMIT,
    normalizeAccountKey: normalizeAccountKey,
    sanitizeArchiveInput: sanitizeArchiveInput,
    sanitizeSkuOutputIdentity: sanitizeSkuOutputIdentity,
    projectArchiveRecords: projectArchiveRecords,
    dataUrlToBlob: dataUrlToBlob,
    sourceToBlob: sourceToBlob,
    saveResult: saveResult,
    saveProvisionalResult: saveProvisionalResult,
    commitProvisionalResult: commitProvisionalResult,
    commitAcceptedProvisionalResult: commitAcceptedProvisionalResult,
    rollbackProvisionalResult: rollbackProvisionalResult,
    scanExpiredReferenceProvisionals: scanExpiredReferenceProvisionals,
    reconcileReferenceProvisionalAuthority: reconcileReferenceProvisionalAuthority,
    list: list,
    summary: summary,
    moveToTrash: moveToTrash,
    restore: restore,
    permanentlyRemove: permanentlyRemove,
    purgeExpired: purgeExpired,
    purgeAllExpired: purgeAllExpired
  });
});
