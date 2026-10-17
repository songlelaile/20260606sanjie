/* reference-detail-background.js — “参考成详”采集 intent 与一次性交接 */
(function (root, factory) {
  'use strict';
  var contract = root && root.SZ_REFERENCE_DETAIL_CONTRACT;
  var interceptor = root && root.SZ_REFERENCE_DETAIL_INTERCEPTOR;
  if (!contract && typeof module === 'object' && module.exports) {
    contract = require('./reference-detail-contract.js');
  }
  if (!interceptor && typeof module === 'object' && module.exports) {
    interceptor = require('./reference-detail-interceptor.js');
  }
  var api = factory(contract, interceptor);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SZ_REFERENCE_DETAIL_BACKGROUND = api;
  if (root && root.chrome && root.chrome.runtime && root.chrome.runtime.onMessage && contract) {
    api.install(root.chrome);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (defaultContract, defaultInterceptor) {
  'use strict';

  var MESSAGES = Object.freeze({
    OPEN_URL: 'SZ_REFERENCE_DETAIL_OPEN_URL',
    CAPTURE_CURRENT: 'SZ_REFERENCE_DETAIL_CAPTURE_CURRENT',
    GET_STATUS: 'SZ_REFERENCE_DETAIL_GET_STATUS',
    CLAIM_INTENT: 'SZ_REFERENCE_DETAIL_CLAIM_INTENT',
    PROGRESS: 'SZ_REFERENCE_DETAIL_PROGRESS',
    COMMIT: 'SZ_REFERENCE_DETAIL_COMMIT',
    HANDOFF_CLAIM: 'SZ_REFERENCE_DETAIL_HANDOFF_CLAIM',
    HANDOFF_CONSUME: 'SZ_REFERENCE_DETAIL_HANDOFF_CONSUME',
    CANCEL: 'SZ_REFERENCE_DETAIL_CANCEL',
    ABORT: 'SZ_REFERENCE_DETAIL_ABORT',
    CLAIM_AND_RUN: 'SZ_REFERENCE_DETAIL_CLAIM_AND_RUN',
    MAIN_CAPTURE: 'SZ_REFERENCE_DETAIL_MAIN_CAPTURE',
    VISUAL_LAB_CAPTURE_DETAIL: 'SZ_VISUAL_LAB_CAPTURE_DETAIL'
  });

  var INTENT_SCHEMA = 'REFERENCE_DETAIL_CAPTURE_INTENT_V1';
  var HANDOFF_SCHEMA = 'REFERENCE_DETAIL_HANDOFF_V1';
  var SNAPSHOT_RECORD_SCHEMA = 'REFERENCE_DETAIL_SNAPSHOT_RECORD_V1';
  var INTENT_KEY_PREFIX = 'sz_reference_detail_intent_v1:';
  var STATUS_KEY_PREFIX = 'sz_reference_detail_status_v1:';
  var HANDOFF_KEY_PREFIX = 'sz_reference_detail_handoff_v1:';
  var SNAPSHOT_KEY_PREFIX = 'sz_reference_detail_snapshot_v1:';
  var LAST_STATUS_KEY = 'sz_reference_detail_last_status_v1';
  var INTENT_TTL_MS = 2 * 60 * 1000;
  var HANDOFF_TTL_MS = 10 * 60 * 1000;
  var HANDOFF_CLAIM_TTL_MS = 2 * 60 * 1000;
  var SCAVENGE_ALARM = 'szReferenceDetailScavengeV1';
  var SCAVENGE_PERIOD_MINUTES = 5;
  var SCAVENGE_MAX_PAIRS = 48;
  var MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
  var MAX_MAIN_RESULT_BYTES = 8 * 1024 * 1024;
  var MAIN_CAPTURE_DURATION_MS = 9000;
  var WORKBENCH_PATH = 'labs/image-prompt-lab/promptlab.html';
  var PHASES = Object.freeze([
    'pending', 'navigating', 'capturing', 'stabilizing', 'normalizing',
    'partial', 'blocked', 'ready', 'error', 'cancelled'
  ]);
  var COMPLETENESS_VALUES = Object.freeze(['complete', 'partial', 'unknown', 'blocked']);
  var COMPLETENESS_KEYS = Object.freeze([
    'overall', 'basicFields', 'detailMedia', 'detailOrder', 'detailText', 'video', 'sku'
  ]);
  var COUNT_KEYS = Object.freeze(['assetCount', 'blockCount', 'factCount', 'evidenceCount']);
  var OPTIONAL_COUNT_KEYS = Object.freeze([
    'detailScreenCount', 'detailImageScreenCount', 'detailTextScreenCount', 'detailVideoScreenCount',
    'filteredBlockCount', 'rawBlockCount'
  ]);
  var CAPTURE_ID_PATTERN = /^rdcap_[A-Za-z0-9_-]{24,128}$/;
  var HANDOFF_TOKEN_PATTERN = /^rdh_[A-Za-z0-9_-]{24,128}$/;
  var CLAIM_NONCE_PATTERN = /^rdn_[A-Za-z0-9_-]{16,128}$/;
  var CLAIM_CLIENT_PATTERN = /^rdci_[A-Za-z0-9_-]{16,128}$/;
  var DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
  var mutationTail = Promise.resolve();

  function plainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    try {
      var proto = Object.getPrototypeOf(value);
      return proto === Object.prototype || proto === null;
    } catch (_) {
      return false;
    }
  }

  function ownData(object, key) {
    if (!object || typeof object !== 'object') return undefined;
    try {
      if (!Object.prototype.hasOwnProperty.call(object, key)) return undefined;
      var descriptor = Object.getOwnPropertyDescriptor(object, key);
      return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
    } catch (_) {
      return undefined;
    }
  }

  function primitiveText(value, max) {
    if (value == null) return '';
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return '';
    return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max || 240);
  }

  function safeStatusText(value, max) {
    var output = primitiveText(value, max);
    if (!output) return '';
    if (/(?:bearer\s+|authorization|cookie|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password|credential)/i.test(output)) {
      return '采集器报告了已隐藏的敏感诊断。';
    }
    return output;
  }

  function safeCode(value, fallback) {
    var output = primitiveText(value, 80);
    return /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(output) ? output : (fallback || 'status');
  }

  function finiteInteger(value, fallback, max) {
    var number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) return fallback;
    return Math.min(number, max == null ? 1000000 : max);
  }

  function nowValue(options) {
    var value = options && typeof options.now === 'function' ? Number(options.now()) : Date.now();
    return Number.isFinite(value) ? value : Date.now();
  }

  function isoTime(value) {
    return new Date(value).toISOString();
  }

  function randomToken(bytes) {
    var cryptoApi = typeof globalThis !== 'undefined' && globalThis.crypto;
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
      throw new Error('浏览器安全随机数不可用，无法建立清单成详上下文');
    }
    var values = new Uint8Array(bytes || 24);
    cryptoApi.getRandomValues(values);
    var binary = '';
    for (var index = 0; index < values.length; index++) binary += String.fromCharCode(values[index]);
    var encoded;
    if (typeof btoa === 'function') encoded = btoa(binary);
    else if (typeof Buffer !== 'undefined') encoded = Buffer.from(binary, 'binary').toString('base64');
    else throw new Error('安全随机令牌编码不可用');
    return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function issueId(prefix, bytes, options) {
    if (options && typeof options.issueId === 'function') {
      var injected = primitiveText(options.issueId(prefix, bytes), 160);
      if (injected.indexOf(prefix) === 0) return injected;
      return prefix + injected;
    }
    return prefix + randomToken(bytes);
  }

  function queueMutation(task) {
    var run = mutationTail.then(task, task);
    mutationTail = run.catch(function () {});
    return run;
  }

  function failure(code, error, path) {
    var output = {
      ok: false,
      code: safeCode(code, 'reference_detail_error'),
      error: safeStatusText(error, 500) || '清单成详后台处理失败'
    };
    var safePath = primitiveText(path, 500);
    if (safePath) output.path = safePath;
    return output;
  }

  function runtimeFailure(error) {
    return failure(error && error.code || 'reference_detail_error', error && error.message || error, error && error.path);
  }

  function chromeLastError(chromeApi) {
    try {
      return chromeApi && chromeApi.runtime && chromeApi.runtime.lastError || null;
    } catch (_) {
      return null;
    }
  }

  function storageArea(chromeApi) {
    var area = chromeApi && chromeApi.storage && chromeApi.storage.session;
    if (!area) throw new Error('storage.session 不可用');
    return area;
  }

  function storageGet(chromeApi, keys) {
    return new Promise(function (resolve, reject) {
      try {
        storageArea(chromeApi).get(keys, function (result) {
          var error = chromeLastError(chromeApi);
          if (error) reject(new Error(error.message || 'storage.session 读取失败'));
          else resolve(result || {});
        });
      } catch (error) { reject(error); }
    });
  }

  function storageSet(chromeApi, values) {
    return new Promise(function (resolve, reject) {
      try {
        storageArea(chromeApi).set(values, function () {
          var error = chromeLastError(chromeApi);
          if (error) reject(new Error(error.message || 'storage.session 写入失败'));
          else resolve();
        });
      } catch (error) { reject(error); }
    });
  }

  function storageRemove(chromeApi, keys) {
    return new Promise(function (resolve, reject) {
      try {
        storageArea(chromeApi).remove(keys, function () {
          var error = chromeLastError(chromeApi);
          if (error) reject(new Error(error.message || 'storage.session 清理失败'));
          else resolve();
        });
      } catch (error) { reject(error); }
    });
  }

  function localStorageArea(chromeApi) {
    var area = chromeApi && chromeApi.storage && chromeApi.storage.local;
    if (!area) throw new Error('storage.local 不可用');
    return area;
  }

  function localGet(chromeApi, keys) {
    return new Promise(function (resolve, reject) {
      try {
        localStorageArea(chromeApi).get(keys, function (result) {
          var error = chromeLastError(chromeApi);
          if (error) reject(new Error(error.message || 'storage.local 读取失败'));
          else resolve(result || {});
        });
      } catch (error) { reject(error); }
    });
  }

  function storageKeys(chromeApi, local) {
    var area = local ? localStorageArea(chromeApi) : storageArea(chromeApi);
    if (typeof area.getKeys !== 'function') {
      return (local ? localGet(chromeApi, null) : storageGet(chromeApi, null)).then(Object.keys);
    }
    return new Promise(function (resolve, reject) {
      try {
        area.getKeys(function (keys) {
          var error = chromeLastError(chromeApi);
          if (error) reject(new Error(error.message || (local ? 'storage.local 索引读取失败' : 'storage.session 索引读取失败')));
          else resolve(Array.isArray(keys) ? keys : []);
        });
      } catch (error) { reject(error); }
    });
  }

  function localSet(chromeApi, values) {
    return new Promise(function (resolve, reject) {
      try {
        localStorageArea(chromeApi).set(values, function () {
          var error = chromeLastError(chromeApi);
          if (error) reject(new Error(error.message || 'storage.local 写入失败'));
          else resolve();
        });
      } catch (error) { reject(error); }
    });
  }

  function localRemove(chromeApi, keys) {
    return new Promise(function (resolve, reject) {
      try {
        localStorageArea(chromeApi).remove(keys, function () {
          var error = chromeLastError(chromeApi);
          if (error) reject(new Error(error.message || 'storage.local 清理失败'));
          else resolve();
        });
      } catch (error) { reject(error); }
    });
  }

  function jsonByteLength(value) {
    var json = JSON.stringify(value);
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(json).length;
    if (typeof Buffer !== 'undefined') return Buffer.byteLength(json, 'utf8');
    return unescape(encodeURIComponent(json)).length;
  }

  function tabsCreate(chromeApi, options) {
    return new Promise(function (resolve, reject) {
      try {
        chromeApi.tabs.create(options, function (tab) {
          var error = chromeLastError(chromeApi);
          if (error) reject(new Error(error.message || '标签页创建失败'));
          else if (!tab || !Number.isInteger(tab.id)) reject(new Error('标签页创建未返回有效 tabId'));
          else resolve(tab);
        });
      } catch (error) { reject(error); }
    });
  }

  function tabsUpdate(chromeApi, tabId, options) {
    return new Promise(function (resolve, reject) {
      try {
        chromeApi.tabs.update(tabId, options, function (tab) {
          var error = chromeLastError(chromeApi);
          if (error) reject(new Error(error.message || '标签页导航失败'));
          else resolve(tab || { id: tabId });
        });
      } catch (error) { reject(error); }
    });
  }

  function tabsQuery(chromeApi, options) {
    return new Promise(function (resolve, reject) {
      try {
        chromeApi.tabs.query(options, function (tabs) {
          var error = chromeLastError(chromeApi);
          if (error) reject(new Error(error.message || '当前标签页查询失败'));
          else resolve(Array.isArray(tabs) ? tabs : []);
        });
      } catch (error) { reject(error); }
    });
  }

  function tabsSendMessage(chromeApi, tabId, message) {
    return new Promise(function (resolve, reject) {
      try {
        chromeApi.tabs.sendMessage(tabId, message, function (response) {
          var error = chromeLastError(chromeApi);
          if (error) reject(new Error(error.message || '商品页采集器不可用'));
          else resolve(response);
        });
      } catch (error) { reject(error); }
    });
  }

  function scriptingExecuteMain(chromeApi, tabId, runner, request) {
    return new Promise(function (resolve, reject) {
      if (!chromeApi.scripting || typeof chromeApi.scripting.executeScript !== 'function' || typeof runner !== 'function') {
        reject(new Error('MAIN world 私有采集器不可用'));
        return;
      }
      try {
        chromeApi.scripting.executeScript({
          target: { tabId: tabId, frameIds: [0] },
          world: 'MAIN',
          func: runner,
          args: [request]
        }, function (results) {
          var error = chromeLastError(chromeApi);
          if (error) reject(new Error(error.message || 'MAIN world 采集失败'));
          else if (!Array.isArray(results) || results.length !== 1 || !plainObject(results[0])) reject(new Error('MAIN world 采集未返回唯一顶层结果'));
          else resolve(ownData(results[0], 'result'));
        });
      } catch (error) { reject(error); }
    });
  }

  function bestEffortRemoveTab(chromeApi, tabId) {
    if (!chromeApi.tabs || typeof chromeApi.tabs.remove !== 'function' || !Number.isInteger(tabId)) return Promise.resolve();
    return new Promise(function (resolve) {
      try { chromeApi.tabs.remove(tabId, function () { chromeLastError(chromeApi); resolve(); }); }
      catch (_) { resolve(); }
    });
  }

  function parseProductPage(value, contract) {
    if (!contract || typeof contract.validateUrl !== 'function') return null;
    var parsed = contract.validateUrl(typeof value === 'string' ? value : '', 'source');
    if (!parsed || !parsed.ok) return null;
    if (parsed.platform !== 'taobao' && parsed.platform !== 'tmall') return null;
    if (!/^\d{1,30}$/.test(parsed.itemId)) return null;
    return {
      platform: parsed.platform,
      itemId: parsed.itemId,
      canonicalUrl: parsed.url
    };
  }

  function sameSource(first, second) {
    return !!first && !!second && first.platform === second.platform && first.itemId === second.itemId &&
      first.canonicalUrl === second.canonicalUrl;
  }

  function sameRuntime(chromeApi, sender) {
    return !!sender && sender.id === chromeApi.runtime.id;
  }

  function exactPopupSender(chromeApi, sender) {
    if (!sameRuntime(chromeApi, sender)) return false;
    var senderUrl = primitiveText(ownData(sender, 'url'), 4096).split(/[?#]/)[0];
    return senderUrl === chromeApi.runtime.getURL('src/popup.html');
  }

  function senderDocumentId(sender) {
    var value = primitiveText(ownData(sender, 'documentId'), 256);
    return DOCUMENT_ID_PATTERN.test(value) ? value : '';
  }

  function productSender(chromeApi, sender, contract) {
    if (!sameRuntime(chromeApi, sender) || sender.frameId !== 0 || !sender.tab || !Number.isInteger(sender.tab.id)) return null;
    var tabPage = parseProductPage(ownData(sender.tab, 'url'), contract);
    if (!tabPage) return null;
    var documentUrl = ownData(sender, 'url');
    if (documentUrl != null) {
      var documentPage = parseProductPage(documentUrl, contract);
      if (!documentPage || !sameSource(tabPage, documentPage)) return null;
    }
    return { tabId: sender.tab.id, page: tabPage, documentId: senderDocumentId(sender) };
  }

  function topTabSender(chromeApi, sender, contract) {
    if (!sameRuntime(chromeApi, sender) || sender.frameId !== 0 || !sender.tab || !Number.isInteger(sender.tab.id)) return null;
    return {
      tabId: sender.tab.id,
      page: parseProductPage(ownData(sender.tab, 'url'), contract),
      documentId: senderDocumentId(sender)
    };
  }

  function messageClaimClientId(message) {
    var value = primitiveText(ownData(message, 'claimClientId'), 160);
    return CLAIM_CLIENT_PATTERN.test(value) ? value : '';
  }

  function requestedCaptureOwner(senderInfo, message) {
    var documentId = senderInfo && senderInfo.documentId || '';
    var clientId = messageClaimClientId(message);
    if (!documentId && !clientId) return null;
    return { documentId: documentId, clientId: clientId };
  }

  function hasCaptureOwner(record) {
    if (!plainObject(record)) return false;
    return !!primitiveText(ownData(record, 'captureOwnerDocumentId'), 256) ||
      !!primitiveText(ownData(record, 'captureOwnerClientId'), 160);
  }

  function captureOwnerMatches(record, senderInfo, message) {
    if (!plainObject(record) || !senderInfo) return false;
    var expectedDocumentId = primitiveText(ownData(record, 'captureOwnerDocumentId'), 256);
    if (expectedDocumentId) return !!senderInfo.documentId && senderInfo.documentId === expectedDocumentId;
    var expectedClientId = primitiveText(ownData(record, 'captureOwnerClientId'), 160);
    return CLAIM_CLIENT_PATTERN.test(expectedClientId) && messageClaimClientId(message) === expectedClientId;
  }

  function assignCaptureOwner(intent, owner, now) {
    intent.captureOwnerDocumentId = owner.documentId || '';
    intent.captureOwnerClientId = owner.clientId || '';
    intent.claimGeneration = finiteInteger(ownData(intent, 'claimGeneration'), 0, 1000000) + 1;
    intent.claimedAt = isoTime(now);
    intent.claimedAtMs = now;
  }

  function captureOwnerFailure() {
    return failure('capture_owner_mismatch', '采集所有权已由新页面接管，旧页面迟到消息已拒绝');
  }

  function exactWorkbenchSender(chromeApi, sender, expectedToken) {
    if (!sameRuntime(chromeApi, sender) || sender.frameId !== 0 || !sender.tab || !Number.isInteger(sender.tab.id)) return null;
    var raw = primitiveText(ownData(sender, 'url'), 8192);
    if (!raw) return null;
    var parsed;
    try { parsed = new URL(raw); } catch (_) { return null; }
    var exact = new URL(chromeApi.runtime.getURL(WORKBENCH_PATH));
    if (parsed.protocol !== exact.protocol || parsed.host !== exact.host || parsed.pathname !== exact.pathname || parsed.username || parsed.password || parsed.hash) return null;
    var tokenValues = parsed.searchParams.getAll('handoffToken');
    if (parsed.searchParams.getAll('mode').length !== 1 || parsed.searchParams.get('mode') !== 'detail' ||
        parsed.searchParams.getAll('detailMode').length !== 1 || parsed.searchParams.get('detailMode') !== 'reference' ||
        parsed.searchParams.getAll('source').length !== 1 || parsed.searchParams.get('source') !== 'reference-detail' ||
        tokenValues.length !== 1 || tokenValues[0] !== expectedToken) return null;
    var tabUrl = ownData(sender.tab, 'url');
    if (typeof tabUrl === 'string' && tabUrl !== raw) return null;
    return { tabId: sender.tab.id, url: raw };
  }

  function intentKey(tabId) { return INTENT_KEY_PREFIX + String(tabId); }
  function statusKey(captureId) { return STATUS_KEY_PREFIX + captureId; }
  function handoffKey(token) { return HANDOFF_KEY_PREFIX + token; }
  function snapshotKey(token) { return SNAPSHOT_KEY_PREFIX + token; }

  function uniqueStorageKeys(keys, prefix) {
    var seen = Object.create(null);
    return (Array.isArray(keys) ? keys : [keys]).map(function (key) {
      return primitiveText(key, 512);
    }).filter(function (key) {
      if (!key || (prefix && key.indexOf(prefix) !== 0) || seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  async function removeWithRetry(remove, chromeApi, keys) {
    try {
      await remove(chromeApi, keys);
    } catch (_) {
      await remove(chromeApi, keys);
    }
  }

  async function cleanupHandoffStorage(chromeApi, sessionKeys, snapshotRefs) {
    var localKeys = uniqueStorageKeys(snapshotRefs, SNAPSHOT_KEY_PREFIX);
    var handoffKeys = uniqueStorageKeys(sessionKeys, HANDOFF_KEY_PREFIX);
    // Cross-area deletion cannot be atomic. Remove the large local payload first:
    // if that fails twice, the session reference remains available for a retry and
    // the snapshot never becomes an unaddressable local orphan.
    if (localKeys.length) await removeWithRetry(localRemove, chromeApi, localKeys);
    if (handoffKeys.length) await removeWithRetry(storageRemove, chromeApi, handoffKeys);
  }

  function cleanupHandoffToken(chromeApi, token) {
    return cleanupHandoffStorage(chromeApi, [handoffKey(token)], [snapshotKey(token)]);
  }

  function normalizeCompleteness(input) {
    input = plainObject(input) ? input : {};
    var output = {};
    COMPLETENESS_KEYS.forEach(function (key) {
      var raw = ownData(input, key);
      output[key] = COMPLETENESS_VALUES.indexOf(raw) >= 0 ? raw : 'unknown';
    });
    return output;
  }

  function normalizeWarnings(input) {
    if (!Array.isArray(input)) return [];
    return input.slice(0, 50).map(function (item) {
      if (!plainObject(item)) return null;
      var warning = {
        code: safeCode(ownData(item, 'code'), 'SOURCE_WARNING'),
        message: safeStatusText(ownData(item, 'message'), 500),
        path: safeStatusText(ownData(item, 'path'), 500) || '$'
      };
      return warning;
    }).filter(Boolean);
  }

  function normalizeCounts(input) {
    input = plainObject(input) ? input : {};
    var output = {};
    COUNT_KEYS.forEach(function (key) { output[key] = finiteInteger(ownData(input, key), 0); });
    OPTIONAL_COUNT_KEYS.forEach(function (key) {
      if (ownData(input, key) !== undefined) output[key] = finiteInteger(ownData(input, key), 0);
    });
    return output;
  }

  function createStatus(intent, phase, code, message, previous) {
    previous = plainObject(previous) ? previous : {};
    phase = PHASES.indexOf(phase) >= 0 ? phase : 'pending';
    return {
      captureId: intent.captureId,
      tabId: intent.tabId,
      itemId: intent.itemId,
      platform: intent.platform,
      canonicalUrl: intent.canonicalUrl,
      sourceMode: intent.sourceMode,
      phase: phase,
      status: phase,
      code: safeCode(code, phase),
      message: safeStatusText(message, 500),
      completeness: normalizeCompleteness(ownData(previous, 'completeness')),
      warnings: normalizeWarnings(ownData(previous, 'warnings')),
      counts: normalizeCounts(ownData(previous, 'counts')),
      createdAt: intent.createdAt,
      updatedAt: isoTime(Date.now()),
      // Internal ownership fields are deliberately omitted by publicStatus.
      captureOwnerDocumentId: primitiveText(ownData(intent, 'captureOwnerDocumentId') !== undefined ? ownData(intent, 'captureOwnerDocumentId') : ownData(previous, 'captureOwnerDocumentId'), 256),
      captureOwnerClientId: primitiveText(ownData(intent, 'captureOwnerClientId') !== undefined ? ownData(intent, 'captureOwnerClientId') : ownData(previous, 'captureOwnerClientId'), 160),
      claimGeneration: finiteInteger(ownData(intent, 'claimGeneration'), finiteInteger(ownData(previous, 'claimGeneration'), 0, 1000000), 1000000)
    };
  }

  function publicStatus(value) {
    if (!plainObject(value) || !CAPTURE_ID_PATTERN.test(primitiveText(ownData(value, 'captureId'), 160))) return null;
    var phase = primitiveText(ownData(value, 'phase'), 40);
    phase = PHASES.indexOf(phase) >= 0 ? phase : 'error';
    return {
      captureId: primitiveText(ownData(value, 'captureId'), 160),
      tabId: finiteInteger(ownData(value, 'tabId'), null, Number.MAX_SAFE_INTEGER),
      itemId: primitiveText(ownData(value, 'itemId'), 128),
      platform: primitiveText(ownData(value, 'platform'), 32),
      canonicalUrl: primitiveText(ownData(value, 'canonicalUrl'), 4096),
      sourceMode: primitiveText(ownData(value, 'sourceMode'), 40),
      phase: phase,
      status: phase,
      code: safeCode(ownData(value, 'code'), phase),
      message: safeStatusText(ownData(value, 'message'), 500),
      completeness: normalizeCompleteness(ownData(value, 'completeness')),
      warnings: normalizeWarnings(ownData(value, 'warnings')),
      counts: normalizeCounts(ownData(value, 'counts')),
      createdAt: primitiveText(ownData(value, 'createdAt'), 80),
      updatedAt: primitiveText(ownData(value, 'updatedAt'), 80)
    };
  }

  function statusValues(status) {
    var values = {};
    values[statusKey(status.captureId)] = status;
    values[LAST_STATUS_KEY] = status;
    return values;
  }

  function storeStatus(chromeApi, status) {
    return storageSet(chromeApi, statusValues(status));
  }

  function createIntent(page, sourceMode, tabId, options) {
    var now = nowValue(options);
    var captureId = issueId('rdcap_', 24, options);
    if (!CAPTURE_ID_PATTERN.test(captureId)) throw new Error('captureId 生成失败');
    return {
      schema: INTENT_SCHEMA,
      schemaVersion: 1,
      captureId: captureId,
      tabId: tabId,
      itemId: page.itemId,
      platform: page.platform,
      canonicalUrl: page.canonicalUrl,
      sourceMode: sourceMode,
      state: 'pending',
      createdAt: isoTime(now),
      createdAtMs: now,
      expiresAt: now + INTENT_TTL_MS,
      claimedAt: null,
      claimedAtMs: null,
      captureOwnerDocumentId: '',
      captureOwnerClientId: '',
      claimGeneration: 0
    };
  }

  function persistIntent(chromeApi, intent, phase) {
    var status = createStatus(intent, phase || 'pending', phase || 'pending', '', null);
    var values = statusValues(status);
    values[intentKey(intent.tabId)] = intent;
    return storageSet(chromeApi, values).then(function () { return status; });
  }

  function publicCapture(intent, status) {
    return {
      ok: true,
      captureId: intent.captureId,
      tabId: intent.tabId,
      itemId: intent.itemId,
      platform: intent.platform,
      canonicalUrl: intent.canonicalUrl,
      sourceMode: intent.sourceMode,
      status: publicStatus(status)
    };
  }

  function validIntent(intent, tabId) {
    return plainObject(intent) && ownData(intent, 'schema') === INTENT_SCHEMA && Number(ownData(intent, 'schemaVersion')) === 1 &&
      ownData(intent, 'tabId') === tabId && CAPTURE_ID_PATTERN.test(primitiveText(ownData(intent, 'captureId'), 160));
  }

  function intentSource(intent) {
    return {
      platform: primitiveText(ownData(intent, 'platform'), 32),
      itemId: primitiveText(ownData(intent, 'itemId'), 128),
      canonicalUrl: primitiveText(ownData(intent, 'canonicalUrl'), 4096)
    };
  }

  async function getBoundIntent(chromeApi, senderInfo, captureId, options, requireClaimed) {
    var key = intentKey(senderInfo.tabId);
    var stored = await storageGet(chromeApi, key);
    var intent = stored[key];
    if (!validIntent(intent, senderInfo.tabId)) return { error: failure('intent_not_found', '没有可用的清单成详采集 intent') };
    if (captureId && ownData(intent, 'captureId') !== captureId) return { error: failure('capture_mismatch', 'captureId 与当前商品页 intent 不匹配') };
    if (!sameSource(intentSource(intent), senderInfo.page)) return { error: failure('source_mismatch', '商品页来源身份与 intent 不匹配') };
    if (Number(ownData(intent, 'expiresAt')) <= nowValue(options)) {
      await storageRemove(chromeApi, key);
      var expiredStatus = createStatus(intent, 'error', 'intent_expired', '采集 intent 已过期，请重新提取。', null);
      await storeStatus(chromeApi, expiredStatus);
      return { error: failure('intent_expired', '采集 intent 已过期，请重新提取') };
    }
    if (requireClaimed && ownData(intent, 'state') !== 'claimed') return { error: failure('intent_not_claimed', '采集 intent 尚未由商品页领取') };
    return { intent: intent, key: key };
  }

  async function handleOpenUrl(chromeApi, message, sender, options) {
    var contract = options.contract;
    if (!exactPopupSender(chromeApi, sender)) return failure('forbidden_sender', '仅插件 popup 可打开参考商品 URL');
    var rawUrl = ownData(message, 'url');
    if (rawUrl == null) rawUrl = ownData(message, 'rawUrl');
    if (rawUrl == null) rawUrl = ownData(message, 'input');
    var page = parseProductPage(rawUrl, contract);
    if (!page) return failure('invalid_product_url', '请输入受支持的淘宝或天猫商品详情 URL');

    var blankTab;
    try {
      blankTab = await tabsCreate(chromeApi, { url: 'about:blank', active: false });
      var intent = createIntent(page, 'pasted_url', blankTab.id, options);
      var status = await persistIntent(chromeApi, intent, 'pending');
      try {
        await tabsUpdate(chromeApi, blankTab.id, { url: page.canonicalUrl, active: true });
      } catch (navigationError) {
        await storageRemove(chromeApi, intentKey(blankTab.id)).catch(function () {});
        var errorStatus = createStatus(intent, 'error', 'navigation_failed', '商品页导航失败，请重试。', status);
        await storeStatus(chromeApi, errorStatus).catch(function () {});
        await bestEffortRemoveTab(chromeApi, blankTab.id);
        return failure('navigation_failed', navigationError.message || '商品页导航失败');
      }
      return publicCapture(intent, status);
    } catch (error) {
      if (blankTab) await bestEffortRemoveTab(chromeApi, blankTab.id);
      return failure('open_failed', error.message || '无法建立商品页采集上下文');
    }
  }

  async function handleCaptureCurrent(chromeApi, sender, options) {
    if (!exactPopupSender(chromeApi, sender)) return Promise.resolve(failure('forbidden_sender', '仅插件 popup 可提取当前商品页'));
    var tabs;
    try { tabs = await tabsQuery(chromeApi, { active: true, lastFocusedWindow: true }); }
    catch (error) { return failure('active_tab_failed', error.message || '无法读取当前标签页'); }
    var tab = tabs[0];
    var page = tab && Number.isInteger(tab.id) ? parseProductPage(tab.url, options.contract) : null;
    if (!page) return failure('unsupported_current_page', '当前标签页不是受支持的淘宝或天猫商品详情页');
    var intent = createIntent(page, 'current_page', tab.id, options);
    var status;
    try {
      status = await queueMutation(function () { return persistIntent(chromeApi, intent, 'pending'); });
      var contentResponse;
      var sendError = null;
      try {
        // Do not hold mutationTail here: content immediately re-enters CLAIM_INTENT,
        // which is intentionally serialized by the same queue.
        contentResponse = await tabsSendMessage(chromeApi, tab.id, { type: MESSAGES.CLAIM_AND_RUN, captureId: intent.captureId });
      } catch (error) {
        sendError = error;
      }
      var latestStored = await storageGet(chromeApi, statusKey(intent.captureId));
      var latestStatus = publicStatus(latestStored[statusKey(intent.captureId)]) || publicStatus(status);
      if ((!contentResponse || contentResponse.ok === false || sendError) && latestStatus && latestStatus.phase === 'pending') {
        throw sendError || new Error('商品页采集器未领取 intent');
      }
      return publicCapture(intent, latestStatus || status);
    } catch (error) {
      await queueMutation(async function () {
        var key = intentKey(tab.id);
        var stored = await storageGet(chromeApi, key);
        var current = stored[key];
        if (validIntent(current, tab.id) && current.captureId === intent.captureId && current.state === 'pending') {
          await storageRemove(chromeApi, key);
          var errorStatus = createStatus(intent, 'error', 'capture_start_failed', '当前商品页采集器无法启动，请刷新后重试。', status);
          await storeStatus(chromeApi, errorStatus);
        }
      }).catch(function () {});
      return failure('capture_start_failed', error.message || '当前商品页采集器无法启动');
    }
  }

  function pageCaptureResponse(intent, status, busy) {
    var output = publicCapture(intent, status);
    output.busy = busy === true;
    output.code = busy ? 'capture_busy' : safeCode(output.status && output.status.code, 'pending');
    output.counts = normalizeCounts(output.status && output.status.counts);
    return output;
  }

  async function handleVisualLabCaptureDetail(chromeApi, message, sender, options) {
    // This entry is intentionally sender-bound. Page-provided URL/item fields are
    // never read: only Chrome's authenticated top-frame sender establishes scope.
    var senderInfo = productSender(chromeApi, sender, options.contract);
    if (!senderInfo) return failure('forbidden_sender', '仅插件自有的淘宝或天猫商品详情页顶层文档可发起清单成详采集');

    var launch;
    try {
      launch = await queueMutation(async function () {
        var key = intentKey(senderInfo.tabId);
        var stored = await storageGet(chromeApi, key);
        var existing = stored[key];
        if (validIntent(existing, senderInfo.tabId)) {
          var statusStorageKey = statusKey(primitiveText(ownData(existing, 'captureId'), 160));
          var statusStored = await storageGet(chromeApi, statusStorageKey);
          var existingStatus = statusStored[statusStorageKey];
          var expired = Number(ownData(existing, 'expiresAt')) <= nowValue(options);
          var hasStatus = !!publicStatus(existingStatus);
          var busy = hasStatus ? statusIsBusy(existingStatus) :
            (ownData(existing, 'state') === 'pending' || ownData(existing, 'state') === 'claimed');
          if (!expired && busy) {
            if (!hasStatus) {
              existingStatus = createStatus(
                existing,
                ownData(existing, 'state') === 'claimed' ? 'capturing' : 'pending',
                'capture_busy',
                '当前商品页已有采集任务进行中。',
                null
              );
            }
            return { busy: true, intent: existing, status: existingStatus };
          }
          if (expired) {
            await storageRemove(chromeApi, key);
            var expiredStatus = createStatus(existing, 'error', 'intent_expired', '采集上下文已超时，已为当前页重新建立。', existingStatus);
            expiredStatus.updatedAt = isoTime(nowValue(options));
            await storeStatus(chromeApi, expiredStatus);
          }
        }
        var intent = createIntent(senderInfo.page, 'current_page', senderInfo.tabId, options);
        var status = await persistIntent(chromeApi, intent, 'pending');
        return { busy: false, intent: intent, status: status };
      });
    } catch (error) {
      return failure('capture_start_failed', error.message || '无法建立当前商品页采集上下文');
    }

    if (launch.busy) return pageCaptureResponse(launch.intent, launch.status, true);

    var intent = launch.intent;
    var status = launch.status;
    try {
      var contentResponse;
      var sendError = null;
      try {
        // Do not hold mutationTail: CLAIM_AND_RUN synchronously re-enters the
        // existing CLAIM_INTENT owner/document/TTL pipeline.
        contentResponse = await tabsSendMessage(chromeApi, senderInfo.tabId, {
          type: MESSAGES.CLAIM_AND_RUN,
          captureId: intent.captureId
        });
      } catch (error) {
        sendError = error;
      }
      var latestStored = await storageGet(chromeApi, statusKey(intent.captureId));
      var latestStatus = publicStatus(latestStored[statusKey(intent.captureId)]) || publicStatus(status);
      if ((!contentResponse || contentResponse.ok === false || sendError) && latestStatus && latestStatus.phase === 'pending') {
        throw sendError || new Error('商品页采集器未领取 intent');
      }
      return pageCaptureResponse(intent, latestStatus || status, false);
    } catch (error) {
      var compensatedStatus = null;
      await queueMutation(async function () {
        var key = intentKey(senderInfo.tabId);
        var stored = await storageGet(chromeApi, key);
        var current = stored[key];
        if (validIntent(current, senderInfo.tabId) && current.captureId === intent.captureId && current.state === 'pending') {
          await storageRemove(chromeApi, key);
          compensatedStatus = createStatus(intent, 'error', 'capture_start_failed', '当前商品页采集器无法启动，请刷新后重试。', status);
          compensatedStatus.updatedAt = isoTime(nowValue(options));
          await storeStatus(chromeApi, compensatedStatus);
        }
      }).catch(function () {});
      var output = failure('capture_start_failed', error.message || '当前商品页采集器无法启动');
      output.captureId = intent.captureId;
      output.status = publicStatus(compensatedStatus);
      output.counts = normalizeCounts(output.status && output.status.counts);
      return output;
    }
  }

  function handleClaimIntent(chromeApi, message, sender, options) {
    var senderInfo = productSender(chromeApi, sender, options.contract);
    if (!senderInfo) return Promise.resolve(failure('forbidden_sender', '仅受支持商品页顶层采集器可领取 intent'));
    var captureId = primitiveText(ownData(message, 'captureId'), 160);
    if (captureId && !CAPTURE_ID_PATTERN.test(captureId)) return Promise.resolve(failure('invalid_capture_id', 'captureId 无效'));
    return queueMutation(async function () {
      var bound = await getBoundIntent(chromeApi, senderInfo, captureId, options, false);
      if (bound.error) return bound.error;
      var intent = bound.intent;
      var owner = requestedCaptureOwner(senderInfo, message);
      if (!owner) return failure('capture_owner_unavailable', '浏览器未提供可绑定的顶层文档标识');
      var state = ownData(intent, 'state');
      var resumed = false;
      if (state === 'claimed') {
        if (captureOwnerMatches(intent, senderInfo, message)) return failure('intent_already_claimed', '当前文档已领取采集 intent');
        resumed = true;
      } else if (state !== 'pending') {
        return failure('intent_not_pending', '采集 intent 不可领取');
      }
      var now = nowValue(options);
      intent.state = 'claimed';
      assignCaptureOwner(intent, owner, now);
      var storedStatus = await storageGet(chromeApi, statusKey(intent.captureId));
      var status = createStatus(
        intent,
        'capturing',
        resumed ? 'capture_resumed' : 'capturing',
        resumed ? '页面已重载，新文档已安全接管采集。' : '正在采集商品详情。',
        storedStatus[statusKey(intent.captureId)]
      );
      status.updatedAt = isoTime(now);
      var values = statusValues(status);
      values[bound.key] = intent;
      await storageSet(chromeApi, values);
      return {
        ok: true,
        resumed: resumed,
        captureId: intent.captureId,
        sourceMode: intent.sourceMode,
        source: {
          platform: intent.platform,
          itemId: intent.itemId,
          canonicalUrl: intent.canonicalUrl,
          sourceMode: intent.sourceMode
        },
        expiresAt: intent.expiresAt,
        status: publicStatus(status)
      };
    });
  }

  async function handleMainCapture(chromeApi, message, sender, options) {
    var senderInfo = productSender(chromeApi, sender, options.contract);
    if (!senderInfo) return failure('forbidden_sender', '仅已领取 intent 的受支持商品页可启动 MAIN world 采集');
    var captureId = primitiveText(ownData(message, 'captureId'), 160);
    if (!CAPTURE_ID_PATTERN.test(captureId)) return failure('invalid_capture_id', 'captureId 无效');
    var bound = await getBoundIntent(chromeApi, senderInfo, captureId, options, true);
    if (bound.error) return bound.error;
    if (!captureOwnerMatches(bound.intent, senderInfo, message)) return captureOwnerFailure();
    var runner = options.interceptor && options.interceptor.runMainCaptureTask;
    if (typeof runner !== 'function') return failure('main_capture_unavailable', 'MAIN world 私有采集器未加载');
    var request = {
      pageUrl: bound.intent.canonicalUrl,
      itemId: bound.intent.itemId,
      platform: bound.intent.platform,
      durationMs: MAIN_CAPTURE_DURATION_MS,
      observeMutations: true,
      maxCandidates: 120,
      maxTotalBytes: MAX_MAIN_RESULT_BYTES
    };
    var result;
    try { result = await scriptingExecuteMain(chromeApi, senderInfo.tabId, runner, request); }
    catch (error) { return failure('main_capture_failed', error.message || 'MAIN world 采集失败'); }
    var latest = await getBoundIntent(chromeApi, senderInfo, captureId, options, true);
    if (latest.error) return latest.error;
    if (!captureOwnerMatches(latest.intent, senderInfo, message)) return captureOwnerFailure();
    var resultBytes;
    try { resultBytes = jsonByteLength(result); } catch (_) { return failure('main_capture_invalid', 'MAIN world 采集结果无法序列化'); }
    if (!plainObject(result) || resultBytes > MAX_MAIN_RESULT_BYTES) return failure('main_capture_too_large', 'MAIN world 采集结果超过有界上限');
    return { ok: true, captureId: captureId, result: result };
  }

  function handleProgress(chromeApi, message, sender, options) {
    var senderInfo = productSender(chromeApi, sender, options.contract);
    if (!senderInfo) return Promise.resolve(failure('forbidden_sender', '仅受支持商品页顶层采集器可更新进度'));
    var captureId = primitiveText(ownData(message, 'captureId'), 160);
    if (!CAPTURE_ID_PATTERN.test(captureId)) return Promise.resolve(failure('invalid_capture_id', 'captureId 无效'));
    return queueMutation(async function () {
      var bound = await getBoundIntent(chromeApi, senderInfo, captureId, options, true);
      if (bound.error) return bound.error;
      if (!captureOwnerMatches(bound.intent, senderInfo, message)) return captureOwnerFailure();
      var progress = ownData(message, 'progress');
      progress = plainObject(progress) ? progress : message;
      var phase = primitiveText(ownData(progress, 'phase'), 40);
      if (PHASES.indexOf(phase) < 0 || phase === 'ready' || phase === 'cancelled') phase = 'capturing';
      var stored = await storageGet(chromeApi, statusKey(captureId));
      var previous = stored[statusKey(captureId)];
      var status = createStatus(bound.intent, phase, ownData(progress, 'code') || phase, ownData(progress, 'message'), previous);
      status.completeness = normalizeCompleteness(ownData(progress, 'completeness') || ownData(previous, 'completeness'));
      status.warnings = normalizeWarnings(ownData(progress, 'warnings') || ownData(previous, 'warnings'));
      status.counts = normalizeCounts(ownData(progress, 'counts') || ownData(previous, 'counts'));
      status.updatedAt = isoTime(nowValue(options));
      await storeStatus(chromeApi, status);
      return { ok: true, captureId: captureId, status: publicStatus(status) };
    });
  }

  function referenceOnlyInput(input) {
    if (!plainObject(input)) return input;
    var assetsInput = ownData(input, 'assets');
    var assets = assetsInput;
    if (Array.isArray(assetsInput) && assetsInput.length <= 30000) {
      assets = [];
      for (var index = 0; index < assetsInput.length; index++) {
        var descriptor;
        try { descriptor = Object.getOwnPropertyDescriptor(assetsInput, String(index)); } catch (_) { descriptor = null; }
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !plainObject(descriptor.value)) {
          assets.push(descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined);
          continue;
        }
        var item = descriptor.value;
        var output = {};
        ['assetId', 'url', 'mediaType', 'role', 'originalIndex', 'width', 'height', 'altText', 'sourcePath', 'completeness'].forEach(function (key) {
          var value = ownData(item, key);
          if (value !== undefined) output[key] = value;
        });
        output.rightsStatus = 'reference_only';
        assets.push(output);
      }
    }
    var rightsInput = ownData(input, 'rights');
    var notice = plainObject(rightsInput) ? ownData(rightsInput, 'notice') : '';
    return {
      schema: ownData(input, 'schema'),
      schemaVersion: ownData(input, 'schemaVersion'),
      source: ownData(input, 'source'),
      completeness: ownData(input, 'completeness'),
      facts: ownData(input, 'facts'),
      orderedBlocks: ownData(input, 'orderedBlocks'),
      assets: assets,
      evidence: ownData(input, 'evidence'),
      rights: { defaultStatus: 'reference_only', notice: notice },
      warnings: ownData(input, 'warnings')
    };
  }

  function contractCompleteness(snapshot, previous) {
    var source = snapshot && snapshot.completeness || {};
    var output = normalizeCompleteness(previous);
    function value(key) { return COMPLETENESS_VALUES.indexOf(source[key]) >= 0 ? source[key] : 'unknown'; }
    function restrictive(first, second) {
      var rank = { complete: 0, partial: 1, unknown: 2, blocked: 3 };
      return rank[first] >= rank[second] ? first : second;
    }
    output.basicFields = restrictive(value('source'), value('facts'));
    output.detailMedia = value('assets');
    output.detailOrder = value('orderedBlocks');
    output.detailText = restrictive(value('facts'), value('orderedBlocks'));
    var overall = 'complete';
    ['basicFields', 'detailMedia', 'detailOrder', 'detailText', 'video', 'sku'].forEach(function (key) {
      overall = restrictive(overall, output[key]);
    });
    output.overall = overall;
    return output;
  }

  function workbenchUrl(chromeApi, token) {
    return chromeApi.runtime.getURL(WORKBENCH_PATH) + '?mode=detail&detailMode=reference&source=reference-detail&handoffToken=' + encodeURIComponent(token);
  }

  function handleCommit(chromeApi, message, sender, options) {
    var senderInfo = productSender(chromeApi, sender, options.contract);
    if (!senderInfo) return Promise.resolve(failure('forbidden_sender', '仅受支持商品页顶层采集器可提交快照'));
    var captureId = primitiveText(ownData(message, 'captureId'), 160);
    if (!CAPTURE_ID_PATTERN.test(captureId)) return Promise.resolve(failure('invalid_capture_id', 'captureId 无效'));
    return queueMutation(async function () {
      var bound = await getBoundIntent(chromeApi, senderInfo, captureId, options, true);
      if (bound.error) return bound.error;
      if (!captureOwnerMatches(bound.intent, senderInfo, message)) return captureOwnerFailure();
      var snapshotInput = ownData(message, 'snapshot');
      var snapshot;
      try {
        snapshot = options.contract.sanitizeSourceSnapshot(referenceOnlyInput(snapshotInput));
        var validation = options.contract.validateSourceSnapshot(snapshot);
        if (!plainObject(validation) || ownData(validation, 'ok') !== true || !plainObject(ownData(validation, 'value'))) {
          var errors = plainObject(validation) && Array.isArray(ownData(validation, 'errors')) ? ownData(validation, 'errors') : [];
          var firstError = errors.length && plainObject(errors[0]) ? errors[0] : null;
          var validationError = new Error(safeStatusText(ownData(firstError, 'message'), 500) || '来源快照未通过最终合同校验');
          validationError.code = safeCode(ownData(firstError, 'code'), 'source_snapshot_invalid');
          validationError.path = primitiveText(ownData(firstError, 'path'), 500) || '$';
          throw validationError;
        }
        snapshot = ownData(validation, 'value');
      } catch (error) {
        return runtimeFailure(error);
      }
      var sanitizedSource = snapshot && snapshot.source;
      if (!sameSource(intentSource(bound.intent), sanitizedSource) || sanitizedSource.sourceMode !== bound.intent.sourceMode) {
        return failure('snapshot_source_mismatch', '快照商品身份或来源模式与 intent 不匹配');
      }
      if (snapshot.assets.some(function (asset) { return asset.rightsStatus !== 'reference_only'; }) ||
          snapshot.rights.defaultStatus !== 'reference_only' || snapshot.rights.reusableAssetIds.length) {
        return failure('rights_invariant_failed', '来源素材必须保持 reference_only');
      }

      if (snapshot.completeness.overall === 'blocked') {
        var blockedStored = await storageGet(chromeApi, statusKey(captureId));
        var blockedPrevious = blockedStored[statusKey(captureId)];
        var blockedStatus = createStatus(
          bound.intent,
          'blocked',
          'capture_blocked',
          '商品页处于登录、验证或受限状态，本次采集已停止。',
          blockedPrevious
        );
        blockedStatus.completeness = {
          overall: 'blocked',
          basicFields: 'blocked',
          detailMedia: 'blocked',
          detailOrder: 'blocked',
          detailText: 'blocked',
          video: 'blocked',
          sku: 'blocked'
        };
        blockedStatus.warnings = normalizeWarnings(snapshot.warnings);
        blockedStatus.counts = {
          assetCount: snapshot.assets.length,
          blockCount: snapshot.orderedBlocks.length,
          factCount: snapshot.facts.length,
          evidenceCount: snapshot.evidence.length
        };
        blockedStatus.updatedAt = isoTime(nowValue(options));
        await storeStatus(chromeApi, blockedStatus);
        await storageRemove(chromeApi, bound.key);
        return {
          ok: true,
          blocked: true,
          captureId: captureId,
          snapshotId: snapshot.snapshotId,
          status: publicStatus(blockedStatus)
        };
      }

      var detailProjection;
      try {
        if (!options.contract || typeof options.contract.projectDetailImageSource !== 'function') {
          var projectionUnavailable = new Error('详情区间识别模块不可用，请重新载入插件后重试。');
          projectionUnavailable.code = 'detail_image_classifier_unavailable';
          throw projectionUnavailable;
        }
        detailProjection = options.contract.projectDetailImageSource(snapshot);
      } catch (error) {
        return runtimeFailure(error);
      }
      var detailReport = detailProjection.report || {};
      if (!detailProjection.ok || !detailProjection.snapshot || !detailReport.detailScreenCount) {
        var emptyStored = await storageGet(chromeApi, statusKey(captureId));
        var emptyStatus = createStatus(
          bound.intent,
          'blocked',
          'no_anchored_detail_screens',
          '未识别到“图文详情”之后、“本店推荐”之前的连续详情内容；没有回退到参数、首图或推荐区。',
          emptyStored[statusKey(captureId)]
        );
        emptyStatus.completeness = contractCompleteness(snapshot, ownData(emptyStored[statusKey(captureId)], 'completeness'));
        emptyStatus.warnings = normalizeWarnings(snapshot.warnings);
        emptyStatus.counts = {
          assetCount: 0,
          blockCount: 0,
          factCount: snapshot.facts.length,
          evidenceCount: snapshot.evidence.length,
          detailScreenCount: 0,
          detailImageScreenCount: 0,
          detailTextScreenCount: 0,
          detailVideoScreenCount: 0,
          filteredBlockCount: finiteInteger(detailReport.filteredBlockCount, snapshot.orderedBlocks.length),
          rawBlockCount: finiteInteger(detailReport.rawBlockCount, snapshot.orderedBlocks.length)
        };
        emptyStatus.updatedAt = isoTime(nowValue(options));
        await storeStatus(chromeApi, emptyStatus);
        await storageRemove(chromeApi, bound.key);
        var emptyFailure = failure('no_anchored_detail_screens', emptyStatus.message);
        emptyFailure.blocked = true;
        emptyFailure.captureId = captureId;
        emptyFailure.status = publicStatus(emptyStatus);
        return emptyFailure;
      }
      snapshot = detailProjection.snapshot;

      var token = issueId('rdh_', 32, options);
      if (!HANDOFF_TOKEN_PATTERN.test(token)) return failure('handoff_token_failed', '一次性交接 token 生成失败');
      var now = nowValue(options);
      var snapshotBytes = jsonByteLength(snapshot);
      if (!Number.isFinite(snapshotBytes) || snapshotBytes > MAX_SNAPSHOT_BYTES) {
        var sizeStatus = createStatus(bound.intent, 'error', 'snapshot_too_large', '采集快照超过本机交接上限，未创建工作台交接。', null);
        await storeStatus(chromeApi, sizeStatus);
        await storageRemove(chromeApi, bound.key);
        var sizeFailure = failure('snapshot_too_large', '采集快照超过本机交接上限');
        sizeFailure.status = publicStatus(sizeStatus);
        return sizeFailure;
      }
      var snapshotRef = snapshotKey(token);
      var snapshotRecord = {
        schema: SNAPSHOT_RECORD_SCHEMA,
        schemaVersion: 1,
        token: token,
        captureId: captureId,
        snapshot: snapshot,
        bytes: snapshotBytes,
        createdAtMs: now,
        expiresAt: now + HANDOFF_TTL_MS
      };
      var handoff = {
        schema: HANDOFF_SCHEMA,
        schemaVersion: 1,
        token: token,
        captureId: captureId,
        sourceTabId: senderInfo.tabId,
        workbenchTabId: null,
        itemId: bound.intent.itemId,
        platform: bound.intent.platform,
        canonicalUrl: bound.intent.canonicalUrl,
        sourceMode: bound.intent.sourceMode,
        captureOwnerDocumentId: primitiveText(ownData(bound.intent, 'captureOwnerDocumentId'), 256),
        captureOwnerClientId: primitiveText(ownData(bound.intent, 'captureOwnerClientId'), 160),
        claimGeneration: finiteInteger(ownData(bound.intent, 'claimGeneration'), 0, 1000000),
        snapshotRef: snapshotRef,
        snapshotBytes: snapshotBytes,
        createdAt: isoTime(now),
        createdAtMs: now,
        expiresAt: now + HANDOFF_TTL_MS,
        claimedTabId: null,
        claimedAt: null,
        claimedAtMs: null,
        claimNonce: null
      };
      var key = handoffKey(token);
      var workbenchTab = null;
      try {
        // Bind the one-time context to a known tab before the workbench can run
        // its claim code. This mirrors the product-page about:blank intent flow.
        workbenchTab = await tabsCreate(chromeApi, { url: 'about:blank', active: false });
        handoff.workbenchTabId = workbenchTab.id;
        var stored = await storageGet(chromeApi, statusKey(captureId));
        var previous = stored[statusKey(captureId)];
        var isComplete = snapshot.completeness && snapshot.completeness.overall === 'complete';
        var finalPhase = isComplete ? 'ready' : 'partial';
        var status = createStatus(
          bound.intent,
          finalPhase,
          isComplete ? 'detail_range_ready' : 'detail_range_partial',
          isComplete
            ? ('已识别“图文详情”至“本店推荐”之间的 ' + detailReport.detailScreenCount + ' 个详情屏' +
              (detailReport.detailImageScreenCount ? ('（含图 ' + detailReport.detailImageScreenCount + ' 屏）') : '') + '，正在进入清单成详工作台。')
            : ('商品详情区间已部分提取并拆为 ' + detailReport.detailScreenCount + ' 个详情屏' +
              (detailReport.detailImageScreenCount ? ('（含图 ' + detailReport.detailImageScreenCount + ' 屏）') : '') + '；来源仍有缺失项或警告，正在进入工作台。'),
          previous
        );
        status.completeness = contractCompleteness(snapshot, ownData(previous, 'completeness'));
        status.warnings = normalizeWarnings(snapshot.warnings);
        status.counts = {
          assetCount: snapshot.assets.length,
          blockCount: snapshot.orderedBlocks.length,
          factCount: snapshot.facts.length,
          evidenceCount: snapshot.evidence.length,
          detailScreenCount: finiteInteger(detailReport.detailScreenCount, snapshot.orderedBlocks.length),
          detailImageScreenCount: finiteInteger(detailReport.detailImageScreenCount, snapshot.orderedBlocks.length),
          detailTextScreenCount: finiteInteger(detailReport.detailTextScreenCount, 0),
          detailVideoScreenCount: finiteInteger(detailReport.detailVideoScreenCount, 0),
          filteredBlockCount: finiteInteger(detailReport.filteredBlockCount, 0),
          rawBlockCount: finiteInteger(detailReport.rawBlockCount, snapshot.orderedBlocks.length)
        };
        status.updatedAt = isoTime(nowValue(options));
        var values = statusValues(status);
        values[key] = handoff;
        var localValues = {};
        localValues[snapshotRef] = snapshotRecord;
        await localSet(chromeApi, localValues);
        await storageSet(chromeApi, values);
        await tabsUpdate(chromeApi, workbenchTab.id, { url: workbenchUrl(chromeApi, token), active: true });
        await storageRemove(chromeApi, bound.key);
        return {
          ok: true,
          captureId: captureId,
          snapshotId: snapshot.snapshotId,
          handoffToken: token,
          tabId: workbenchTab.id,
          status: publicStatus(status)
        };
      } catch (error) {
        await cleanupHandoffToken(chromeApi, token).catch(function () {});
        if (workbenchTab) await bestEffortRemoveTab(chromeApi, workbenchTab.id);
        var errorStatus = createStatus(bound.intent, 'error', 'handoff_open_failed', '清单成详工作台无法打开，请重试。', null);
        await storeStatus(chromeApi, errorStatus).catch(function () {});
        return failure('handoff_open_failed', error.message || '清单成详工作台无法打开');
      }
    });
  }

  function validHandoff(value, token) {
    return plainObject(value) && ownData(value, 'schema') === HANDOFF_SCHEMA && Number(ownData(value, 'schemaVersion')) === 1 &&
      ownData(value, 'token') === token && ownData(value, 'snapshotRef') === snapshotKey(token) && ownData(value, 'captureId');
  }

  function validSnapshotRecord(value, handoff, token, now) {
    return plainObject(value) && ownData(value, 'schema') === SNAPSHOT_RECORD_SCHEMA && Number(ownData(value, 'schemaVersion')) === 1 &&
      ownData(value, 'token') === token && ownData(value, 'captureId') === ownData(handoff, 'captureId') &&
      Number(ownData(value, 'expiresAt')) > now && plainObject(ownData(value, 'snapshot'));
  }

  function validClaimShape(handoff) {
    var tabId = ownData(handoff, 'claimedTabId');
    var claimedAtMs = ownData(handoff, 'claimedAtMs');
    var nonce = ownData(handoff, 'claimNonce');
    if (tabId == null && claimedAtMs == null && nonce == null) return true;
    return Number.isInteger(tabId) && Number.isFinite(Number(claimedAtMs)) &&
      CLAIM_NONCE_PATTERN.test(primitiveText(nonce, 180));
  }

  function matchingSnapshotPair(handoff, snapshotRecord, token, now) {
    if (!HANDOFF_TOKEN_PATTERN.test(token) || !validHandoff(handoff, token) || Number(ownData(handoff, 'expiresAt')) <= now ||
        !validSnapshotRecord(snapshotRecord, handoff, token, now) || !validClaimShape(handoff)) return false;
    if (Number(ownData(snapshotRecord, 'bytes')) !== Number(ownData(handoff, 'snapshotBytes')) ||
        Number(ownData(snapshotRecord, 'createdAtMs')) !== Number(ownData(handoff, 'createdAtMs')) ||
        Number(ownData(snapshotRecord, 'expiresAt')) !== Number(ownData(handoff, 'expiresAt'))) return false;
    var snapshot = ownData(snapshotRecord, 'snapshot');
    var source = plainObject(snapshot) ? ownData(snapshot, 'source') : null;
    return plainObject(source) && ownData(source, 'platform') === ownData(handoff, 'platform') &&
      ownData(source, 'itemId') === ownData(handoff, 'itemId') &&
      ownData(source, 'canonicalUrl') === ownData(handoff, 'canonicalUrl') &&
      ownData(source, 'sourceMode') === ownData(handoff, 'sourceMode');
  }

  async function scavengeHandoffs(chromeApi, options) {
    options = options || {};
    var keyLists = await Promise.all([storageKeys(chromeApi, false), storageKeys(chromeApi, true)]);
    var suffixes = Object.create(null);
    keyLists[0].forEach(function (key) {
      if (typeof key === 'string' && key.indexOf(HANDOFF_KEY_PREFIX) === 0) suffixes[key.slice(HANDOFF_KEY_PREFIX.length)] = true;
    });
    keyLists[1].forEach(function (key) {
      if (typeof key === 'string' && key.indexOf(SNAPSHOT_KEY_PREFIX) === 0) suffixes[key.slice(SNAPSHOT_KEY_PREFIX.length)] = true;
    });
    var all = Object.keys(suffixes).sort();
    if (!all.length) {
      options.scavengeCursor = '';
      return { scanned: 0, cleaned: 0, remaining: false };
    }
    var cursor = primitiveText(options.scavengeCursor, 180);
    var start = cursor ? all.findIndex(function (suffix) { return suffix > cursor; }) : 0;
    if (start < 0) start = 0;
    var rotated = all.slice(start).concat(all.slice(0, start));
    var selected = rotated.slice(0, SCAVENGE_MAX_PAIRS);
    options.scavengeCursor = all.length > selected.length ? selected[selected.length - 1] : '';
    var sessionKeys = selected.map(function (suffix) { return HANDOFF_KEY_PREFIX + suffix; });
    var snapshotRefs = selected.map(function (suffix) { return SNAPSHOT_KEY_PREFIX + suffix; });
    var values = await Promise.all([storageGet(chromeApi, sessionKeys), localGet(chromeApi, snapshotRefs)]);
    var now = nowValue(options);
    var staleSession = [];
    var staleLocal = [];
    selected.forEach(function (suffix, index) {
      var sessionKey = sessionKeys[index];
      var snapshotRef = snapshotRefs[index];
      var handoff = values[0][sessionKey];
      var snapshotRecord = values[1][snapshotRef];
      if (matchingSnapshotPair(handoff, snapshotRecord, suffix, now)) return;
      if (Object.prototype.hasOwnProperty.call(values[0], sessionKey)) staleSession.push(sessionKey);
      if (Object.prototype.hasOwnProperty.call(values[1], snapshotRef)) staleLocal.push(snapshotRef);
    });
    if (staleSession.length || staleLocal.length) {
      await cleanupHandoffStorage(chromeApi, staleSession, staleLocal);
    }
    return { scanned: selected.length, cleaned: new Set(staleSession.concat(staleLocal)).size, remaining: all.length > selected.length };
  }

  function handleHandoffClaim(chromeApi, message, sender, options) {
    var token = primitiveText(ownData(message, 'handoffToken') || ownData(message, 'token'), 180);
    if (!HANDOFF_TOKEN_PATTERN.test(token)) return Promise.resolve(failure('invalid_handoff_token', 'handoff token 无效'));
    var workbench = exactWorkbenchSender(chromeApi, sender, token);
    if (!workbench) return Promise.resolve(failure('forbidden_sender', '仅精确清单成详工作台可领取交接'));
    return queueMutation(async function () {
      var key = handoffKey(token);
      var stored = await storageGet(chromeApi, key);
      var handoff = stored[key];
      if (!validHandoff(handoff, token)) {
        await cleanupHandoffToken(chromeApi, token);
        return failure('handoff_not_found', '一次性交接不存在或已消费');
      }
      var now = nowValue(options);
      if (Number(ownData(handoff, 'expiresAt')) <= now) {
        await cleanupHandoffToken(chromeApi, token);
        return failure('handoff_expired', '一次性交接已过期');
      }
      if (ownData(handoff, 'workbenchTabId') !== workbench.tabId) return failure('handoff_tab_mismatch', '一次性交接不属于当前工作台标签页');
      var snapshotRef = ownData(handoff, 'snapshotRef');
      var localStored = await localGet(chromeApi, snapshotRef);
      var snapshotRecord = localStored[snapshotRef];
      if (!validSnapshotRecord(snapshotRecord, handoff, token, now)) {
        await cleanupHandoffToken(chromeApi, token);
        return failure('handoff_snapshot_not_found', '一次性交接快照不存在或已过期');
      }
      var snapshot = ownData(snapshotRecord, 'snapshot');
      try {
        if (!options.contract || typeof options.contract.projectDetailImageSource !== 'function') {
          await cleanupHandoffToken(chromeApi, token);
          return failure('detail_image_classifier_unavailable', '详情区间识别模块不可用，请重新摘取。');
        }
        var claimProjection = options.contract.projectDetailImageSource(snapshot);
        if (!claimProjection.ok || !claimProjection.snapshot || !claimProjection.report || !claimProjection.report.detailScreenCount) {
          await cleanupHandoffToken(chromeApi, token);
          return failure('no_anchored_detail_screens', '旧交接没有“图文详情”至“本店推荐”双锚点范围，请重新摘取商品详情。');
        }
        snapshot = claimProjection.snapshot;
      } catch (error) {
        await cleanupHandoffToken(chromeApi, token);
        return runtimeFailure(error);
      }
      var claimedTabId = ownData(handoff, 'claimedTabId');
      var claimedAtMs = Number(ownData(handoff, 'claimedAtMs'));
      if (Number.isInteger(claimedTabId) && claimedAtMs + HANDOFF_CLAIM_TTL_MS > now) {
        if (claimedTabId !== workbench.tabId) return failure('handoff_already_claimed', '一次性交接已被其他工作台领取');
        return {
          ok: true,
          captureId: handoff.captureId,
          handoffToken: token,
          claimNonce: handoff.claimNonce,
          snapshot: snapshot
        };
      }
      handoff.claimedTabId = workbench.tabId;
      handoff.claimedAt = isoTime(now);
      handoff.claimedAtMs = now;
      handoff.claimNonce = issueId('rdn_', 18, options);
      if (!CLAIM_NONCE_PATTERN.test(handoff.claimNonce)) return failure('claim_nonce_failed', '交接 claim nonce 生成失败');
      var values = {};
      values[key] = handoff;
      await storageSet(chromeApi, values);
      return {
        ok: true,
        captureId: handoff.captureId,
        handoffToken: token,
        claimNonce: handoff.claimNonce,
        snapshot: snapshot
      };
    });
  }

  function handleHandoffConsume(chromeApi, message, sender, options) {
    var token = primitiveText(ownData(message, 'handoffToken') || ownData(message, 'token'), 180);
    var nonce = primitiveText(ownData(message, 'claimNonce'), 180);
    if (!HANDOFF_TOKEN_PATTERN.test(token) || !CLAIM_NONCE_PATTERN.test(nonce)) {
      return Promise.resolve(failure('invalid_handoff_claim', 'handoff token 或 claim nonce 无效'));
    }
    var workbench = exactWorkbenchSender(chromeApi, sender, token);
    if (!workbench) return Promise.resolve(failure('forbidden_sender', '仅精确清单成详工作台可消费交接'));
    return queueMutation(async function () {
      var key = handoffKey(token);
      var stored = await storageGet(chromeApi, key);
      var handoff = stored[key];
      if (!validHandoff(handoff, token)) {
        await cleanupHandoffToken(chromeApi, token);
        return failure('handoff_not_found', '一次性交接不存在或已消费');
      }
      if (Number(ownData(handoff, 'expiresAt')) <= nowValue(options)) {
        await cleanupHandoffToken(chromeApi, token);
        return failure('handoff_expired', '一次性交接已过期');
      }
      if (ownData(handoff, 'workbenchTabId') !== workbench.tabId || ownData(handoff, 'claimedTabId') !== workbench.tabId ||
          ownData(handoff, 'claimNonce') !== nonce) return failure('handoff_claim_mismatch', '一次性交接 claim 与当前工作台不匹配');
      await cleanupHandoffToken(chromeApi, token);
      return { ok: true, consumed: true, captureId: handoff.captureId };
    });
  }

  function statusIsBusy(value) {
    var phase = primitiveText(ownData(value, 'phase'), 40);
    return phase === 'pending' || phase === 'navigating' || phase === 'capturing' ||
      phase === 'stabilizing' || phase === 'normalizing';
  }

  function statusIntentFromRecord(value, fallbackIntent, now) {
    fallbackIntent = plainObject(fallbackIntent) ? fallbackIntent : {};
    return {
      captureId: primitiveText(ownData(value, 'captureId') || ownData(fallbackIntent, 'captureId'), 160),
      tabId: finiteInteger(ownData(value, 'tabId'), finiteInteger(ownData(fallbackIntent, 'tabId'), null, Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER),
      itemId: primitiveText(ownData(value, 'itemId') || ownData(fallbackIntent, 'itemId'), 128),
      platform: primitiveText(ownData(value, 'platform') || ownData(fallbackIntent, 'platform'), 32),
      canonicalUrl: primitiveText(ownData(value, 'canonicalUrl') || ownData(fallbackIntent, 'canonicalUrl'), 4096),
      sourceMode: primitiveText(ownData(value, 'sourceMode') || ownData(fallbackIntent, 'sourceMode'), 40) || 'current_page',
      createdAt: primitiveText(ownData(value, 'createdAt') || ownData(fallbackIntent, 'createdAt'), 80) || isoTime(now),
      captureOwnerDocumentId: primitiveText(ownData(fallbackIntent, 'captureOwnerDocumentId') !== undefined ? ownData(fallbackIntent, 'captureOwnerDocumentId') : ownData(value, 'captureOwnerDocumentId'), 256),
      captureOwnerClientId: primitiveText(ownData(fallbackIntent, 'captureOwnerClientId') !== undefined ? ownData(fallbackIntent, 'captureOwnerClientId') : ownData(value, 'captureOwnerClientId'), 160),
      claimGeneration: finiteInteger(ownData(fallbackIntent, 'claimGeneration'), finiteInteger(ownData(value, 'claimGeneration'), 0, 1000000), 1000000)
    };
  }

  async function handleGetStatus(chromeApi, message, sender, options) {
    if (!exactPopupSender(chromeApi, sender)) return failure('forbidden_sender', '仅插件 popup 可查询清单成详状态');
    var captureId = primitiveText(ownData(message, 'captureId'), 160);
    if (captureId && !CAPTURE_ID_PATTERN.test(captureId)) return failure('invalid_capture_id', 'captureId 无效');
    return queueMutation(async function () {
      var key = captureId ? statusKey(captureId) : LAST_STATUS_KEY;
      var stored = await storageGet(chromeApi, key);
      var current = stored[key];
      if (!plainObject(current) || !statusIsBusy(current)) return { ok: true, status: publicStatus(current) };
      var currentCaptureId = primitiveText(ownData(current, 'captureId'), 160);
      var tabId = finiteInteger(ownData(current, 'tabId'), null, Number.MAX_SAFE_INTEGER);
      var intentStorageKey = Number.isInteger(tabId) ? intentKey(tabId) : '';
      var intentStored = intentStorageKey ? await storageGet(chromeApi, intentStorageKey) : {};
      var intent = intentStorageKey ? intentStored[intentStorageKey] : null;
      var matchingIntent = validIntent(intent, tabId) && ownData(intent, 'captureId') === currentCaptureId;
      var now = nowValue(options);
      var code = '';
      var messageText = '';
      if (matchingIntent && Number(ownData(intent, 'expiresAt')) <= now) {
        await storageRemove(chromeApi, intentStorageKey);
        code = 'intent_expired';
        messageText = '采集上下文已超时，请重新提取。';
      } else if (!matchingIntent) {
        code = 'capture_context_lost';
        messageText = '采集页面上下文已丢失，请重新提取。';
      }
      if (!code) return { ok: true, status: publicStatus(current) };
      var terminal = createStatus(statusIntentFromRecord(current, matchingIntent ? intent : null, now), 'error', code, messageText, current);
      terminal.updatedAt = isoTime(now);
      await storeStatus(chromeApi, terminal);
      return { ok: true, status: publicStatus(terminal) };
    });
  }

  function handleTermination(chromeApi, message, sender, options, aborting) {
    var captureId = primitiveText(ownData(message, 'captureId'), 160);
    if (!CAPTURE_ID_PATTERN.test(captureId)) return Promise.resolve(failure('invalid_capture_id', 'captureId 无效'));
    var topTab = topTabSender(chromeApi, sender, options.contract);
    var popup = !aborting && exactPopupSender(chromeApi, sender);
    if (!topTab && !popup) return Promise.resolve(failure('forbidden_sender', '当前发送方不能终止清单成详采集'));
    var terminalPhase = aborting ? primitiveText(ownData(message, 'terminalPhase'), 40) : 'cancelled';
    if (aborting && terminalPhase !== 'blocked' && terminalPhase !== 'error') {
      return Promise.resolve(failure('invalid_terminal_phase', '终止状态只能为 blocked 或 error'));
    }
    return queueMutation(async function () {
      var tabId = topTab ? topTab.tabId : null;
      var allStored = await storageGet(chromeApi, null);
      var storedStatus = allStored[statusKey(captureId)];
      if (!Number.isInteger(tabId)) tabId = finiteInteger(ownData(storedStatus, 'tabId'), null, Number.MAX_SAFE_INTEGER);
      var key = Number.isInteger(tabId) ? intentKey(tabId) : '';
      var intent = key ? allStored[key] : null;
      if (!validIntent(intent, tabId) || ownData(intent, 'captureId') !== captureId) intent = null;
      var handoffs = Object.keys(allStored).filter(function (candidateKey) {
        return candidateKey.indexOf(HANDOFF_KEY_PREFIX) === 0 && plainObject(allStored[candidateKey]) &&
          ownData(allStored[candidateKey], 'captureId') === captureId;
      }).map(function (candidateKey) { return { key: candidateKey, value: allStored[candidateKey] }; });
      var localKeys = (await storageKeys(chromeApi, true)).filter(function (candidateKey) {
        return typeof candidateKey === 'string' && candidateKey.indexOf(SNAPSHOT_KEY_PREFIX) === 0;
      });
      var allLocal = localKeys.length ? await localGet(chromeApi, localKeys) : {};
      var snapshotRecords = localKeys.filter(function (candidateKey) {
        var value = allLocal[candidateKey];
        return plainObject(value) && ownData(value, 'schema') === SNAPSHOT_RECORD_SCHEMA &&
          ownData(value, 'captureId') === captureId;
      }).map(function (candidateKey) { return { key: candidateKey, value: allLocal[candidateKey] }; });
      var terminalStatus = plainObject(storedStatus) && ownData(storedStatus, 'captureId') === captureId &&
        (ownData(storedStatus, 'phase') === 'blocked' || ownData(storedStatus, 'phase') === 'error');
      if (!intent && !handoffs.length && !snapshotRecords.length && !terminalStatus) {
        return failure('intent_not_found', '没有可终止的清单成详采集或交接');
      }
      var handoffValue = handoffs.length ? handoffs[0].value : null;
      if (topTab) {
        var tabBound = !!intent || handoffs.some(function (entry) {
          return ownData(entry.value, 'sourceTabId') === topTab.tabId;
        }) || (plainObject(storedStatus) && ownData(storedStatus, 'captureId') === captureId && ownData(storedStatus, 'tabId') === topTab.tabId);
        if (!tabBound) return failure('capture_tab_mismatch', 'captureId 不属于当前顶层标签页');
        var ownerRecord = intent || handoffValue || storedStatus;
        if (hasCaptureOwner(ownerRecord) && !captureOwnerMatches(ownerRecord, topTab, message)) return captureOwnerFailure();
      }
      var localSnapshot = snapshotRecords.length ? ownData(snapshotRecords[0].value, 'snapshot') : null;
      var localSource = plainObject(localSnapshot) ? ownData(localSnapshot, 'source') : null;
      var source = intent ? intentSource(intent) : {
        platform: primitiveText(ownData(handoffValue, 'platform') || ownData(storedStatus, 'platform') || ownData(localSource, 'platform'), 32),
        itemId: primitiveText(ownData(handoffValue, 'itemId') || ownData(storedStatus, 'itemId') || ownData(localSource, 'itemId'), 128),
        canonicalUrl: primitiveText(ownData(handoffValue, 'canonicalUrl') || ownData(storedStatus, 'canonicalUrl') || ownData(localSource, 'canonicalUrl'), 4096)
      };
      if (!source.platform && topTab && topTab.page) source = topTab.page;
      var sourceTabId = intent ? ownData(intent, 'tabId') : finiteInteger(
        ownData(handoffValue, 'sourceTabId') || ownData(storedStatus, 'tabId') || (topTab && topTab.tabId),
        null,
        Number.MAX_SAFE_INTEGER
      );
      if (popup && Number.isInteger(sourceTabId)) {
        await tabsSendMessage(chromeApi, sourceTabId, { type: MESSAGES.CANCEL, captureId: captureId }).catch(function () {});
      }
      var sessionKeys = handoffs.map(function (entry) { return entry.key; });
      var snapshotRefs = snapshotRecords.map(function (entry) { return entry.key; });
      handoffs.forEach(function (entry) {
        var token = entry.key.slice(HANDOFF_KEY_PREFIX.length);
        if (HANDOFF_TOKEN_PATTERN.test(token)) snapshotRefs.push(snapshotKey(token));
      });
      await cleanupHandoffStorage(chromeApi, sessionKeys, snapshotRefs);
      if (intent && key) await removeWithRetry(storageRemove, chromeApi, key);
      if (!aborting && terminalStatus) {
        return { ok: true, cancelled: true, preservedTerminal: true, captureId: captureId, status: publicStatus(storedStatus) };
      }
      var statusIntent = intent || {
        captureId: captureId,
        tabId: sourceTabId,
        itemId: source.itemId,
        platform: source.platform,
        canonicalUrl: source.canonicalUrl,
        sourceMode: ownData(handoffValue, 'sourceMode') || ownData(storedStatus, 'sourceMode') || ownData(localSource, 'sourceMode') || 'current_page',
        createdAt: primitiveText(ownData(storedStatus, 'createdAt'), 80) || isoTime(nowValue(options))
      };
      var code = aborting ? safeCode(ownData(message, 'code'), terminalPhase) : 'cancelled';
      var statusMessage = aborting ? safeStatusText(ownData(message, 'message'), 500) : '本次清单成详采集及未消费交接已取消。';
      var status = createStatus(statusIntent, terminalPhase, code, statusMessage, storedStatus);
      if (terminalPhase === 'blocked') {
        COMPLETENESS_KEYS.forEach(function (completenessKey) { status.completeness[completenessKey] = 'blocked'; });
      }
      await storeStatus(chromeApi, status);
      return { ok: true, cancelled: !aborting, aborted: aborting, captureId: captureId, status: publicStatus(status) };
    });
  }

  function handleCancel(chromeApi, message, sender, options) {
    return handleTermination(chromeApi, message, sender, options, false);
  }

  function handleAbort(chromeApi, message, sender, options) {
    return handleTermination(chromeApi, message, sender, options, true);
  }

  function dispatch(chromeApi, message, sender, options) {
    var type = primitiveText(ownData(message, 'type'), 100);
    if (type === MESSAGES.OPEN_URL) return handleOpenUrl(chromeApi, message, sender, options);
    if (type === MESSAGES.CAPTURE_CURRENT) return handleCaptureCurrent(chromeApi, sender, options);
    if (type === MESSAGES.VISUAL_LAB_CAPTURE_DETAIL) return handleVisualLabCaptureDetail(chromeApi, message, sender, options);
    if (type === MESSAGES.GET_STATUS) return handleGetStatus(chromeApi, message, sender, options);
    if (type === MESSAGES.CLAIM_INTENT) return handleClaimIntent(chromeApi, message, sender, options);
    if (type === MESSAGES.MAIN_CAPTURE) return handleMainCapture(chromeApi, message, sender, options);
    if (type === MESSAGES.PROGRESS) return handleProgress(chromeApi, message, sender, options);
    if (type === MESSAGES.COMMIT) return handleCommit(chromeApi, message, sender, options);
    if (type === MESSAGES.HANDOFF_CLAIM) return handleHandoffClaim(chromeApi, message, sender, options);
    if (type === MESSAGES.HANDOFF_CONSUME) return handleHandoffConsume(chromeApi, message, sender, options);
    if (type === MESSAGES.CANCEL) return handleCancel(chromeApi, message, sender, options);
    if (type === MESSAGES.ABORT) return handleAbort(chromeApi, message, sender, options);
    return null;
  }

  function install(chromeApi, installOptions) {
    if (install.installed) return false;
    if (!chromeApi || !chromeApi.runtime || !chromeApi.runtime.onMessage || !chromeApi.tabs ||
        !chromeApi.storage || !chromeApi.storage.session || !chromeApi.storage.local ||
        !chromeApi.scripting || typeof chromeApi.scripting.executeScript !== 'function') return false;
    var contract = installOptions && installOptions.contract || defaultContract;
    if (!contract || typeof contract.validateUrl !== 'function' || typeof contract.sanitizeSourceSnapshot !== 'function' ||
        typeof contract.validateSourceSnapshot !== 'function' || typeof contract.projectDetailImageSource !== 'function') return false;
    var options = {
      contract: contract,
      interceptor: installOptions && installOptions.interceptor || defaultInterceptor,
      now: installOptions && installOptions.now,
      issueId: installOptions && installOptions.issueId,
      scavengeCursor: ''
    };
    function triggerScavenge() {
      return queueMutation(function () { return scavengeHandoffs(chromeApi, options); }).catch(function () {});
    }
    chromeApi.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      var result;
      try { result = dispatch(chromeApi, message, sender || {}, options); }
      catch (error) {
        sendResponse(runtimeFailure(error));
        return false;
      }
      if (!result) return false;
      Promise.resolve(result).then(sendResponse, function (error) { sendResponse(runtimeFailure(error)); });
      return true;
    });
    if (chromeApi.runtime.onStartup && typeof chromeApi.runtime.onStartup.addListener === 'function') {
      chromeApi.runtime.onStartup.addListener(function () { return triggerScavenge(); });
    }
    if (chromeApi.alarms && chromeApi.alarms.onAlarm && typeof chromeApi.alarms.onAlarm.addListener === 'function') {
      chromeApi.alarms.onAlarm.addListener(function (alarm) {
        if (alarm && alarm.name === SCAVENGE_ALARM) return triggerScavenge();
      });
      try { chromeApi.alarms.create(SCAVENGE_ALARM, { periodInMinutes: SCAVENGE_PERIOD_MINUTES }); } catch (_) {}
    }
    install.installed = true;
    triggerScavenge();
    return true;
  }
  install.installed = false;

  return Object.freeze({
    MESSAGES: MESSAGES,
    INTENT_SCHEMA: INTENT_SCHEMA,
    HANDOFF_SCHEMA: HANDOFF_SCHEMA,
    SNAPSHOT_RECORD_SCHEMA: SNAPSHOT_RECORD_SCHEMA,
    INTENT_KEY_PREFIX: INTENT_KEY_PREFIX,
    STATUS_KEY_PREFIX: STATUS_KEY_PREFIX,
    HANDOFF_KEY_PREFIX: HANDOFF_KEY_PREFIX,
    SNAPSHOT_KEY_PREFIX: SNAPSHOT_KEY_PREFIX,
    LAST_STATUS_KEY: LAST_STATUS_KEY,
    INTENT_TTL_MS: INTENT_TTL_MS,
    HANDOFF_TTL_MS: HANDOFF_TTL_MS,
    HANDOFF_CLAIM_TTL_MS: HANDOFF_CLAIM_TTL_MS,
    SCAVENGE_ALARM: SCAVENGE_ALARM,
    SCAVENGE_PERIOD_MINUTES: SCAVENGE_PERIOD_MINUTES,
    SCAVENGE_MAX_PAIRS: SCAVENGE_MAX_PAIRS,
    MAX_SNAPSHOT_BYTES: MAX_SNAPSHOT_BYTES,
    MAX_MAIN_RESULT_BYTES: MAX_MAIN_RESULT_BYTES,
    MAIN_CAPTURE_DURATION_MS: MAIN_CAPTURE_DURATION_MS,
    WORKBENCH_PATH: WORKBENCH_PATH,
    parseProductPage: function (value, contract) { return parseProductPage(value, contract || defaultContract); },
    referenceOnlyInput: referenceOnlyInput,
    scavengeHandoffs: scavengeHandoffs,
    install: install
  });
});
