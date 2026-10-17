/* SKU provider deliveries remain available until their final archive is committed. */
(function (root, factory) {
  var api = factory(root || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SZ_SKU_DELIVERY_STORE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var DB_NAME = 'sz_sku_delivery_v1' + (root.__SANJIE_ENVIRONMENT
    ? ':environment:' + encodeURIComponent(String(root.__SANJIE_ENVIRONMENT)) : '');
  var STORE = 'deliveries';
  var SCHEMA = 'SKU_DELIVERY_RECORD_V1';
  var TIMEOUT_MS = 10000;

  function failure(code, message, cause) {
    var error = new Error(message);
    error.code = code;
    if (cause && typeof cause.name === 'string') error.causeName = cause.name;
    return error;
  }
  function invalid() {
    throw failure('SKU_DELIVERY_INVALID', 'SKU 返回图片记录不完整或含有不允许保存的字段。');
  }
  function plain(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var prototype = Object.getPrototypeOf(value);
    if (prototype === null) return true;
    var constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
    return Object.getPrototypeOf(prototype) === null && constructor &&
      typeof constructor.value === 'function' && constructor.value.name === 'Object';
  }
  function record(value, fields, required) {
    if (!plain(value)) invalid();
    var keys = Reflect.ownKeys(value), output = {};
    keys.forEach(function (key) {
      if (typeof key !== 'string' || fields.indexOf(key) < 0) invalid();
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) invalid();
    });
    fields.forEach(function (key) {
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor) output[key] = descriptor.value;
    });
    (required || []).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(output, key)) invalid();
    });
    return output;
  }
  function string(value, maximum, empty) {
    if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value) ||
        (!empty && !value.trim())) invalid();
    return value;
  }
  function number(value, minimum, maximum) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) invalid();
    return value;
  }
  function boolean(value) {
    if (typeof value !== 'boolean') invalid();
    return value;
  }
  function strings(value, count, length) {
    if (!Array.isArray(value) || !value.length || value.length > count) invalid();
    if (Reflect.ownKeys(value).some(function (key) {
      return key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length);
    })) invalid();
    var output = [];
    for (var index = 0; index < value.length; index++) {
      var descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) invalid();
      output.push(string(descriptor.value, length));
    }
    return output;
  }
  function identity(owner, key) {
    owner = string(owner, 240);
    key = string(key, 2048);
    if (owner !== owner.trim() || key !== key.trim()) invalid();
    return { owner: owner, key: key, id: JSON.stringify([owner, key]) };
  }
  function contract(value) {
    var output = record(value, ['version', 'batchLockId', 'contractFingerprint', 'coordinateSpace', 'canvas',
      'baseImageFingerprint', 'replacementSubjectFingerprint', 'generatedSkuBadge', 'typography', 'subject',
      'variableWhitelist', 'immutableFromBase'], ['version', 'batchLockId', 'contractFingerprint', 'canvas']);
    ['version', 'batchLockId', 'contractFingerprint', 'coordinateSpace', 'baseImageFingerprint', 'replacementSubjectFingerprint'].forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(output, key)) output[key] = string(output[key], 512);
    });
    if (output.version !== 'SKU_SUBJECT_REPLACE_V2') invalid();
    var canvas = record(output.canvas, ['ratio', 'width', 'height', 'safeMargin'], ['ratio', 'width', 'height']);
    canvas.ratio = string(canvas.ratio, 32);
    canvas.width = number(canvas.width, 256, 4096);
    canvas.height = number(canvas.height, 256, 4096);
    if (!Number.isSafeInteger(canvas.width) || !Number.isSafeInteger(canvas.height)) invalid();
    if (canvas.safeMargin !== undefined) canvas.safeMargin = number(canvas.safeMargin, 0, 4096);
    output.canvas = canvas;
    if (output.generatedSkuBadge !== undefined) output.generatedSkuBadge = boolean(output.generatedSkuBadge);
    if (output.typography !== undefined) {
      var typography = record(output.typography, ['renderMode', 'addText', 'alterText']);
      if (typography.renderMode !== undefined) typography.renderMode = string(typography.renderMode, 80);
      ['addText', 'alterText'].forEach(function (key) { if (typography[key] !== undefined) typography[key] = boolean(typography[key]); });
      output.typography = typography;
    }
    if (output.subject !== undefined) {
      var subject = record(output.subject, ['renderMode', 'replacementOnly', 'preservePlacement', 'preserveScale',
        'preservePerspective', 'preserveLightingAndShadow', 'authorizedRegion', 'identityVerification']);
      if (subject.renderMode !== undefined) subject.renderMode = string(subject.renderMode, 80);
      ['replacementOnly', 'preservePlacement', 'preserveScale', 'preservePerspective', 'preserveLightingAndShadow'].forEach(function (key) {
        if (subject[key] !== undefined) subject[key] = boolean(subject[key]);
      });
      if (subject.authorizedRegion !== undefined) {
        var region = record(subject.authorizedRegion, ['x', 'y', 'w', 'h', 'confirmed'], ['x', 'y', 'w', 'h']);
        ['x', 'y', 'w', 'h'].forEach(function (key) { region[key] = number(region[key], 0, 1); });
        if (region.confirmed !== undefined) region.confirmed = boolean(region.confirmed);
        if (!region.w || !region.h || region.x + region.w > 1 || region.y + region.h > 1) invalid();
        subject.authorizedRegion = region;
      }
      if (subject.identityVerification !== undefined) {
        var verification = record(subject.identityVerification, ['required', 'version', 'foregroundExtraction', 'colorHistogram',
          'edgeHistogram', 'contourDescriptor', 'microTextGuard', 'minColorSimilarity', 'minEdgeSimilarity', 'minContourSimilarity']);
        if (verification.required !== undefined) verification.required = boolean(verification.required);
        ['version', 'foregroundExtraction', 'colorHistogram', 'edgeHistogram', 'contourDescriptor', 'microTextGuard'].forEach(function (key) {
          if (verification[key] !== undefined) verification[key] = string(verification[key], 100);
        });
        ['minColorSimilarity', 'minEdgeSimilarity', 'minContourSimilarity'].forEach(function (key) {
          if (verification[key] !== undefined) verification[key] = number(verification[key], 0, 1);
        });
        subject.identityVerification = verification;
      }
      output.subject = subject;
    }
    if (output.variableWhitelist !== undefined) {
      var whitelist = record(output.variableWhitelist, ['subjectIdentity', 'backgroundChanges', 'textChanges', 'layoutChanges', 'newProps', 'generatedLabels']);
      Object.keys(whitelist).forEach(function (key) { whitelist[key] = boolean(whitelist[key]); });
      output.variableWhitelist = whitelist;
    }
    if (output.immutableFromBase !== undefined) output.immutableFromBase = strings(output.immutableFromBase, 100, 200);
    return output;
  }
  function delivery(value) {
    var output = record(value, ['version', 'state', 'createdAt', 'jobId', 'taskId', 'images', 'skuProviderGeometry', 'skuFrozenDelivery'], ['jobId', 'images']);
    output.jobId = string(output.jobId, 512);
    if (output.taskId !== undefined) output.taskId = string(output.taskId, 512, true);
    output.images = strings(output.images, 20, 64 * 1024 * 1024);
    if (output.images.reduce(function (total, image) { return total + image.length; }, 0) > 128 * 1024 * 1024) invalid();
    if (output.version !== undefined && output.version !== 1) invalid();
    if (output.state !== undefined && output.state !== 'delivered') invalid();
    if (output.createdAt !== undefined) output.createdAt = number(output.createdAt, 0, Number.MAX_SAFE_INTEGER);
    if (output.skuProviderGeometry !== undefined) {
      var geometry = record(output.skuProviderGeometry, ['version', 'contractFingerprint', 'adapter', 'requestedSize', 'effectiveSize'],
        ['version', 'contractFingerprint', 'adapter', 'requestedSize', 'effectiveSize']);
      Object.keys(geometry).forEach(function (key) { geometry[key] = string(geometry[key], 512); });
      if (geometry.version !== 'SKU_PROVIDER_GEOMETRY_V1') invalid();
      output.skuProviderGeometry = geometry;
    }
    if (output.skuFrozenDelivery !== undefined) {
      var frozen = record(output.skuFrozenDelivery, ['contract', 'outputResolution', 'archiveBatchId', 'archiveBatchTitle'], ['contract']);
      frozen.contract = contract(frozen.contract);
      if (frozen.outputResolution !== undefined) frozen.outputResolution = string(frozen.outputResolution, 32);
      ['archiveBatchId', 'archiveBatchTitle'].forEach(function (key) { if (frozen[key] !== undefined) frozen[key] = string(frozen[key], 512, true); });
      if (output.skuProviderGeometry && output.skuProviderGeometry.contractFingerprint !== frozen.contract.contractFingerprint) invalid();
      output.skuFrozenDelivery = frozen;
    }
    return output;
  }
  function checkedRecord(value, expected) {
    var safe;
    try {
      safe = record(value, ['schema', 'id', 'owner', 'key', 'delivery'], ['schema', 'id', 'owner', 'key', 'delivery']);
      if (safe.schema !== SCHEMA || safe.id !== expected.id || safe.owner !== expected.owner || safe.key !== expected.key) invalid();
      return delivery(safe.delivery);
    } catch (_) {
      throw failure('SKU_DELIVERY_IDENTITY_MISMATCH', '已保存的 SKU 返回图片记录与当前账号或任务不一致。');
    }
  }
  function operation(expected, mode, work) {
    return new Promise(function (resolve, reject) {
      var database = null, transaction = null, result, settled = false;
      var timer = root.setTimeout(function () {
        finish(failure('SKU_DELIVERY_TIMEOUT', 'SKU 返回图片存储超过 10 秒，请稍后重试本地处理。'), true);
      }, TIMEOUT_MS);
      function finish(error, abort) {
        if (settled) return;
        settled = true;
        root.clearTimeout(timer);
        if (abort && transaction) { try { transaction.abort(); } catch (_) {} }
        if (database) { try { database.close(); } catch (_) {} }
        if (error) reject(error); else resolve(result);
      }
      if (!root.indexedDB || typeof root.indexedDB.open !== 'function') {
        finish(failure('SKU_DELIVERY_UNAVAILABLE', '当前浏览器无法保存 SKU 返回图片。'));
        return;
      }
      var request;
      try { request = root.indexedDB.open(DB_NAME, 1); }
      catch (error) { finish(failure('SKU_DELIVERY_STORAGE_FAILED', '无法打开 SKU 返回图片存储。', error)); return; }
      request.onblocked = function () { finish(failure('SKU_DELIVERY_OPEN_BLOCKED', 'SKU 返回图片存储被另一页面阻塞。')); };
      request.onerror = function () { finish(failure('SKU_DELIVERY_STORAGE_FAILED', '无法打开 SKU 返回图片存储。', request.error)); };
      request.onupgradeneeded = function () {
        if (settled) { try { request.transaction.abort(); } catch (_) {} return; }
        try {
          if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' });
        } catch (error) { finish(failure('SKU_DELIVERY_STORAGE_FAILED', '无法建立 SKU 返回图片存储。', error), true); }
      };
      request.onsuccess = function () {
        database = request.result;
        if (settled) { try { database.close(); } catch (_) {} return; }
        database.onversionchange = function () { try { database.close(); } catch (_) {} };
        try {
          transaction = database.transaction(STORE, mode);
          transaction.oncomplete = function () { finish(); };
          transaction.onerror = function () { finish(failure('SKU_DELIVERY_STORAGE_FAILED', 'SKU 返回图片存储事务失败。', transaction.error), true); };
          transaction.onabort = function () { finish(failure('SKU_DELIVERY_STORAGE_FAILED', 'SKU 返回图片存储事务已取消。', transaction.error)); };
          function protect(callback) {
            return function (event) {
              if (settled) return;
              try { callback(event); } catch (error) {
                finish(error && /^SKU_DELIVERY_/.test(error.code || '') ? error
                  : failure('SKU_DELIVERY_STORAGE_FAILED', 'SKU 返回图片存储操作失败。', error), true);
              }
            };
          }
          work(transaction.objectStore(STORE), function (value) { result = value; }, protect, function (error) { finish(error, true); });
        } catch (error) { finish(failure('SKU_DELIVERY_STORAGE_FAILED', '无法建立 SKU 返回图片存储事务。', error), true); }
      };
    });
  }
  function prepare(owner, key, work) {
    try { return work(identity(owner, key)); }
    catch (error) { return Promise.reject(error); }
  }
  return {
    save: function (owner, key, value) {
      return prepare(owner, key, function (expected) {
        var normalized = delivery(value);
        return operation(expected, 'readwrite', function (store, result, protect, reject) {
          var get = store.get(expected.id);
          get.onsuccess = protect(function () {
            if (get.result !== undefined && get.result !== null) {
              var previous = checkedRecord(get.result, expected);
              if (JSON.stringify(previous) !== JSON.stringify(normalized)) {
                reject(failure('SKU_DELIVERY_CONFLICT', '当前任务已有另一份 SKU 返回图片，已保留原记录。'));
                return;
              }
              result({ ok: true, jobId: normalized.jobId, alreadySaved: true });
              return;
            }
            store.put({ schema: SCHEMA, id: expected.id, owner: expected.owner, key: expected.key, delivery: normalized });
            result({ ok: true, jobId: normalized.jobId, alreadySaved: false });
          });
        });
      });
    },
    read: function (owner, key) {
      return prepare(owner, key, function (expected) {
        return operation(expected, 'readonly', function (store, result, protect) {
          var get = store.get(expected.id);
          get.onsuccess = protect(function () { result(get.result == null ? null : checkedRecord(get.result, expected)); });
        });
      });
    },
    remove: function (owner, key, expectedJobId) {
      return prepare(owner, key, function (expected) {
        expectedJobId = string(expectedJobId, 512);
        return operation(expected, 'readwrite', function (store, result, protect) {
          var get = store.get(expected.id);
          get.onsuccess = protect(function () {
            if (get.result == null) { result({ ok: true, removed: false, reason: 'missing' }); return; }
            var saved = checkedRecord(get.result, expected);
            if (saved.jobId !== expectedJobId) { result({ ok: true, removed: false, reason: 'job_mismatch' }); return; }
            store.delete(expected.id);
            result({ ok: true, removed: true });
          });
        });
      });
    }
  };
});
