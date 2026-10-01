/* reference-detail-batch.js — “参考成详”批量绑定与运行时纯逻辑 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../../src/reference-detail-contract.js'));
  } else {
    root.SZ_REFERENCE_DETAIL_BATCH = factory(root.SZ_REFERENCE_DETAIL_CONTRACT);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CONTRACT) {
  'use strict';

  var EXECUTION_SCHEMA = 'REFERENCE_DETAIL_EXECUTION_BUNDLE_V1';
  var RUNTIME_SCHEMA = 'REFERENCE_DETAIL_BATCH_RUNTIME_V1';
  var PROJECTION_SCHEMA = 'REFERENCE_DETAIL_TARGET_PROJECTION_V1';
  var REPLICA_PLAN_SCHEMA = 'REFERENCE_DETAIL_REPLICA_PLAN_V1';
  var EXECUTION_SCHEMA_V2 = 'REFERENCE_DETAIL_EXECUTION_BUNDLE_V2';
  var RUNTIME_SCHEMA_V2 = 'REFERENCE_DETAIL_BATCH_RUNTIME_V2';
  var PROJECTION_SCHEMA_V2 = 'REFERENCE_DETAIL_TARGET_PROJECTION_V2';
  var REPLICA_PLAN_SCHEMA_V2 = 'REFERENCE_DETAIL_REPLICA_PLAN_V2';
  var VISUAL_STRUCTURE_ONLY = 'visual_structure_only';
  var REPLICA_SET_SCHEMA = 'REFERENCE_DETAIL_REPLICA_SET_V1';
  var REUSE_MODES = Object.freeze(['single_reference', 'batch_reference', 'multi_reference', 'sku_replace']);
  var REPLICA_LIFECYCLE_STATES = Object.freeze([
    'captured', 'segmented', 'analyzed', 'draft', 'user_confirmed',
    'generating', 'generated', 'partial', 'blocked'
  ]);
  var REPLICA_FEATURES = Object.freeze({ multiReferenceUi: false, skuReplaceUi: false });
  var SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
  var AUTHORIZED_RIGHTS = Object.freeze({ authorized: true, self_owned: true });
  var MAX_TARGET_ASSET_REF_LENGTH = 16 * 1024 * 1024;
  var TARGET_ASSET_REF_DIGEST_CHUNK = 32768;
  var TASK_PHASES = Object.freeze([
    'missing_fields', 'blocked', 'pending', 'prompting', 'generating', 'partial',
    'failed', 'completed', 'cancelled', 'interrupted', 'stale'
  ]);
  var SCREEN_STATUSES = Object.freeze(['pending', 'generating', 'completed', 'failed', 'cancelled', 'stale']);
  var SENSITIVE_KEY = /(?:^|_)(?:api_?key|token|secret|password|credential|authorization|cookie|headers?)(?:$|_)/i;
  var FORBIDDEN_GENERATION_KEYS = Object.freeze({
    sourcecopy: true,
    sourcesummary: true,
    sourceassetid: true,
    sourceassetids: true,
    sourceblockid: true,
    sourceblockids: true,
    sourcefactid: true,
    sourcefactids: true
  });

  function BatchError(code, message, path, details) {
    this.name = 'ReferenceDetailBatchError';
    this.code = code || 'BATCH_ERROR';
    this.message = message || '参考成详批量运行时错误';
    this.path = path || '$';
    this.details = details || null;
    if (Error.captureStackTrace) Error.captureStackTrace(this, BatchError);
  }
  BatchError.prototype = Object.create(Error.prototype);
  BatchError.prototype.constructor = BatchError;

  function fail(code, message, path, details) {
    throw new BatchError(code, message, path, details);
  }

  function requireContract() {
    if (!CONTRACT || typeof CONTRACT.createBatchProject !== 'function' ||
        typeof CONTRACT.createRevisionEnvelope !== 'function' || typeof CONTRACT.stableHash !== 'function') {
      fail('CONTRACT_UNAVAILABLE', 'REFERENCE_DETAIL 合同不可用。', '$contract');
    }
    return CONTRACT;
  }

  function requireVisualStructureContract() {
    requireContract();
    if (typeof CONTRACT.createVisualStructureBatchProject !== 'function' ||
        typeof CONTRACT.createVisualStructureRevisionEnvelope !== 'function') {
      fail('CONTRACT_UNAVAILABLE', 'REFERENCE_DETAIL V2 结构合同不可用。', '$contract');
    }
    return CONTRACT;
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function hasOwn(object, key) {
    return !!object && Object.prototype.hasOwnProperty.call(object, key);
  }

  function compareCodeUnits(first, second) {
    first = String(first);
    second = String(second);
    return first < second ? -1 : (first > second ? 1 : 0);
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function deepFreeze(value, seen) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    seen = seen || (typeof WeakSet === 'function' ? new WeakSet() : null);
    if (seen) {
      if (seen.has(value)) return value;
      seen.add(value);
    }
    Object.keys(value).forEach(function (key) { deepFreeze(value[key], seen); });
    return Object.freeze(value);
  }

  function text(value, max) {
    var output = value == null ? '' : String(value);
    output = output.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    max = max || 12000;
    return output.slice(0, max);
  }

  function denseArray(value, path) {
    if (!Array.isArray(value)) fail('INVALID_ARRAY', '字段必须是数组。', path);
    for (var index = 0; index < value.length; index++) {
      var descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); } catch (_) { descriptor = null; }
      if (!descriptor || !hasOwn(descriptor, 'value')) fail('NON_JSON_VALUE', '数组不得包含空洞或访问器。', path + '[' + index + ']');
      var item = descriptor.value;
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
        fail('NON_JSON_VALUE', '数组不得包含 undefined 或非 JSON 值。', path + '[' + index + ']');
      }
      if (typeof item === 'number' && !Number.isFinite(item)) fail('NON_JSON_VALUE', '数组不得包含非有限数字。', path + '[' + index + ']');
    }
    Object.keys(value).forEach(function (key) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) fail('NON_JSON_VALUE', '数组不得包含非 JSON 自定义属性。', path + '.' + key);
    });
    return value;
  }

  function assertDenseJsonContainers(value, path, seen) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))) return;
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' ||
        (typeof value === 'number' && !Number.isFinite(value))) {
      fail('NON_JSON_VALUE', '容器不得包含 undefined 或非 JSON 值。', path);
    }
    if (!value || typeof value !== 'object') fail('NON_JSON_VALUE', '容器只接受普通 JSON。', path);
    seen = seen || (typeof WeakSet === 'function' ? new WeakSet() : null);
    if (seen && seen.has(value)) fail('CYCLIC_REFERENCE', '容器不得包含循环引用。', path);
    if (seen) seen.add(value);
    if (Array.isArray(value)) {
      denseArray(value, path);
      value.forEach(function (item, index) { assertDenseJsonContainers(item, path + '[' + index + ']', seen); });
      if (seen) seen.delete(value);
      return;
    }
    if (!isPlainObject(value)) fail('NON_JSON_VALUE', '容器只接受普通 JSON 对象。', path);
    Object.keys(value).forEach(function (key) {
      var descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch (_) { descriptor = null; }
      if (!descriptor || !hasOwn(descriptor, 'value')) fail('NON_JSON_VALUE', '容器不得包含访问器字段。', path + '.' + key);
      assertDenseJsonContainers(descriptor.value, path + '.' + key, seen);
    });
    if (seen) seen.delete(value);
  }

  function screenCountValue(value, path) {
    if (value === undefined) return 10;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 5 || value > 16) {
      fail('INVALID_SCREEN_COUNT', '参考成详输出屏数必须是 5–16 的整数 number。', path);
    }
    return value;
  }

  function assertSafeId(value, path, required) {
    value = text(value, 500);
    if ((!value && required) || (value && !SAFE_ID.test(value))) {
      fail('INVALID_ID', '字段必须是安全稳定 ID。', path);
    }
    return value;
  }

  function uniqueSortedIds(value, path) {
    if (value == null) return [];
    denseArray(value, path);
    return Array.from(new Set(value.map(function (item, index) {
      return assertSafeId(item, path + '[' + index + ']', true);
    }))).sort(compareCodeUnits);
  }

  function sensitiveSettingKey(key) {
    var normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return SENSITIVE_KEY.test(String(key || '')) ||
      /(?:apikey|accesstoken|refreshtoken|servicetoken|token|secret|password|credentials?|authorization|auth|authkey|cookies?|headers?|sessionid|bearer)$/.test(normalized);
  }

  function normalizedEndpointComponent(value) {
    var output = String(value == null ? '' : value);
    try { if (typeof output.normalize === 'function') output = output.normalize('NFKC'); } catch (_) {}
    for (var index = 0; index < 4; index++) {
      var decoded;
      try { decoded = decodeURIComponent(output.replace(/\+/g, '%20')); }
      catch (_) { return { value: output, unsafe: true }; }
      try { if (typeof decoded.normalize === 'function') decoded = decoded.normalize('NFKC'); } catch (_) {}
      if (decoded === output) break;
      output = decoded;
    }
    return { value: output, unsafe: /[\u0000-\u001f\u007f]/.test(output) || /%[0-9a-f]{2}/i.test(output) };
  }

  function sensitiveEndpointQueryKey(key) {
    var component = normalizedEndpointComponent(key);
    if (component.unsafe) return true;
    var normalized = component.value.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!normalized) return false;
    if (normalized === 'key' || normalized === 'sig' || normalized === 'sign' || normalized === 'signature' ||
        normalized === 'expires' || normalized === 'policy' || normalized === 'x5sec') return true;
    if (sensitiveSettingKey(component.value)) return true;
    if (/^auth(?:key|token|signature|credential)?$/.test(normalized)) return true;
    if (/(?:token|secret|credential|signature|accesskeyid|accesskey|accessid|apikey|authkey|securitytoken|secretkey|consumerkey|signedheaders|password|passwd|sessionid|sessionkey|jwt)$/.test(normalized)) return true;
    return /^(?:xoss|xamz|oss|amz)(?:sign|signature|credential|securitytoken|accesskeyid|expires|policy|algorithm|signedheaders)$/.test(normalized);
  }

  function sensitiveEndpointQueryValue(value) {
    var component = normalizedEndpointComponent(value);
    if (component.unsafe || /\b(?:bearer|basic)\s+\S+/i.test(component.value) ||
        /["']?(?:authorization|cookie|tokens?|api[-_ ]?key|access[-_ ]?key|secret|password|credential)["']?\s*[:=]/i.test(component.value) ||
        /\bAKIA[0-9A-Z]{12,}\b/.test(component.value) ||
        /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(component.value)) return true;
    return component.value.split(/[&;]/).some(function (part) {
      var equalsAt = part.indexOf('=');
      return equalsAt > 0 && sensitiveEndpointQueryKey(part.slice(0, equalsAt).trim());
    });
  }

  function sanitizeEndpointSearch(params) {
    var safePairs = [];
    Array.from(params.entries()).forEach(function (entry) {
      if (!sensitiveEndpointQueryKey(entry[0]) && !sensitiveEndpointQueryValue(entry[1])) safePairs.push(entry);
    });
    safePairs.sort(function (a, b) {
      return compareCodeUnits(a[0], b[0]) || compareCodeUnits(a[1], b[1]);
    });
    return safePairs;
  }

  function safeEndpoint(value) {
    value = text(value, 4096);
    if (!value) return '';
    var normalized = normalizedEndpointComponent(value);
    if (normalized.unsafe || /\\/.test(value) || /\\/.test(normalized.value) ||
        /^\/\//.test(value) || /^\/\//.test(normalized.value)) return '';
    try {
      if (!/^https?:\/\/[^/\\]/i.test(value)) throw new Error('relative endpoint');
      var parsed = new URL(value);
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return '';
      parsed.hash = '';
      var pairs = sanitizeEndpointSearch(parsed.searchParams);
      parsed.search = '';
      pairs.forEach(function (pair) { parsed.searchParams.append(pair[0], pair[1]); });
      return parsed.toString();
    } catch (_) {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || /^[/\\]/.test(value)) return '';
      var hashIndex = value.indexOf('#');
      if (hashIndex >= 0) value = value.slice(0, hashIndex);
      var queryIndex = value.indexOf('?');
      if (queryIndex < 0) return value;
      var base = value.slice(0, queryIndex);
      var params = new URLSearchParams(value.slice(queryIndex + 1));
      var query = sanitizeEndpointSearch(params).map(function (pair) {
        return encodeURIComponent(pair[0]) + '=' + encodeURIComponent(pair[1]);
      }).join('&');
      return base + (query ? '?' + query : '');
    }
  }

  function canonicalJson(value, path, depth) {
    depth = depth || 0;
    if (depth > 20) fail('LIMIT_EXCEEDED', '对象深度超过批量 sidecar 上限。', path);
    if (value == null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return text(value, 100000);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('NON_JSON_VALUE', 'sidecar 不接受非有限数字。', path);
      return value;
    }
    if (Array.isArray(value)) {
      denseArray(value, path);
      return value.map(function (item, index) {
        return canonicalJson(item, path + '[' + index + ']', depth + 1);
      });
    }
    if (!isPlainObject(value)) fail('NON_JSON_VALUE', 'sidecar 只接受普通 JSON。', path);
    var output = {};
    Object.keys(value).sort(compareCodeUnits).forEach(function (key) {
      var normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (key === '__proto__' || key === 'prototype' || key === 'constructor' || sensitiveSettingKey(key)) return;
      var descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch (_) { descriptor = null; }
      if (!descriptor || !hasOwn(descriptor, 'value')) fail('NON_JSON_VALUE', 'sidecar 不接受访问器字段。', path + '.' + key);
      var item = descriptor.value;
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
        fail('NON_JSON_VALUE', 'sidecar 不接受 undefined 或非 JSON 值。', path + '.' + key);
      }
      if (typeof item === 'string' && /(?:baseurl|endpoint|endpointurl|apiurl)$/.test(normalizedKey)) {
        output[key] = safeEndpoint(item);
      } else {
        output[key] = canonicalJson(item, path + '.' + key, depth + 1);
      }
    });
    return output;
  }

  function safeGenerationSettings(input) {
    return deepFreeze(canonicalJson(isPlainObject(input) ? input : {}, '$generationSettings', 0));
  }

  function hash(value, prefix) {
    return requireContract().stableHash(value, prefix);
  }

  // Hash large refs incrementally so confirmation identity covers every code
  // unit without embedding a multi-megabyte data URI in one canonical object.
  function completeTextDigest(value, prefix) {
    var state = hash({ schema: 'REFERENCE_DETAIL_LARGE_TEXT_DIGEST_V1', length: value.length }, 'rdrefseed_');
    var chunkIndex = 0;
    for (var offset = 0; offset < value.length; offset += TARGET_ASSET_REF_DIGEST_CHUNK) {
      state = hash({ state: state, chunkIndex: chunkIndex, chunk: value.slice(offset, offset + TARGET_ASSET_REF_DIGEST_CHUNK) }, 'rdrefchunk_');
      chunkIndex += 1;
    }
    return hash({ state: state, length: value.length, chunkCount: chunkIndex }, prefix);
  }

  function normalizeDraftTarget(input, options) {
    input = isPlainObject(input) ? input : {};
    options = isPlainObject(options) ? options : {};
    var subjectAssetIds = uniqueSortedIds(input.subjectAssetIds, '$target.subjectAssetIds');
    var modelAssetIds = uniqueSortedIds(input.modelAssetIds, '$target.modelAssetIds');
    var skuIds = uniqueSortedIds(input.skuIds, '$target.skuIds');
    var userInput = canonicalJson(isPlainObject(input.userInput) ? input.userInput : {}, '$target.userInput', 0);
    var stableContent = {
      productFactCardId: text(input.productFactCardId, 240),
      internalId: text(input.internalId, 240),
      subjectAssetIds: subjectAssetIds,
      modelAssetIds: modelAssetIds,
      skuIds: skuIds
    };
    var optionIndex = hasOwn(options, 'index') ? 'row_index_' + String(options.index) : '';
    var rowSeed = text(options.rowKey || optionIndex || input.rowKey || input.draftTargetId || input.taskKey || input.internalId, 500) ||
      hash(stableContent, 'rdrowseed_');
    var draftTargetId = input.draftTargetId ? assertSafeId(input.draftTargetId, '$target.draftTargetId', true) :
      hash({ rowSeed: rowSeed, kind: 'draft_target' }, 'rddraft_');
    var targetInputId = input.targetInputId ? assertSafeId(input.targetInputId, '$target.targetInputId', true) :
      hash({ draftTargetId: draftTargetId, kind: 'visual_structure_target_input' }, 'rdtargetinput_');
    var taskKey = input.taskKey ? assertSafeId(input.taskKey, '$target.taskKey', true) :
      hash({ draftTargetId: draftTargetId, rowSeed: rowSeed }, 'rdtaskkey_');
    return deepFreeze({
      draftTargetId: draftTargetId,
      targetInputId: targetInputId,
      taskKey: taskKey,
      selected: input.selected !== false,
      productName: text(input.productName, 1000),
      internalId: text(input.internalId, 240),
      productFactCardId: text(input.productFactCardId, 240),
      subjectAssetIds: subjectAssetIds,
      modelAssetIds: modelAssetIds,
      skuIds: skuIds,
      audience: text(input.audience, 1000),
      language: text(input.language, 240),
      sellingAngle: text(input.sellingAngle, 2000),
      userInput: userInput
    });
  }

  function duplicateDraftTarget(input, options) {
    options = isPlainObject(options) ? options : {};
    var source = normalizeDraftTarget(input);
    var operationKey = text(options.operationKey || options.copyKey || options.copyIndex || 'copy_1', 240);
    if (!operationKey) fail('COPY_OPERATION_KEY_REQUIRED', '复制目标必须提供稳定 operationKey。', '$options.operationKey');
    var raw = clone(source);
    raw.draftTargetId = hash({ sourceDraftTargetId: source.draftTargetId, operationKey: operationKey }, 'rddraft_');
    raw.targetInputId = hash({ draftTargetId: raw.draftTargetId, operationKey: operationKey, kind: 'visual_structure_target_input' }, 'rdtargetinput_');
    raw.taskKey = hash({ sourceTaskKey: source.taskKey, copyDraftTargetId: raw.draftTargetId }, 'rdtaskkey_');
    if (options.productNameSuffix !== false && raw.productName) raw.productName += '（副本）';
    return normalizeDraftTarget(raw);
  }

  function normalizeRegistryFactCard(card, record, index) {
    var path = '$bundle.verifiedProductFactCards[' + index + ']';
    if (!isPlainObject(card)) fail('INVALID_VERIFIED_FACT_CARD', '可信事实卡记录无效。', path);
    var cardId = assertSafeId(card.productFactCardId, path + '.productFactCardId', true);
    var verificationId = assertSafeId(card.verificationId, path + '.verificationId', true);
    if (Array.isArray(card.factKeys)) denseArray(card.factKeys, path + '.factKeys');
    var factKeys = Array.isArray(card.factKeys) ? Array.from(new Set(card.factKeys.map(function (key) {
      key = text(key, 240);
      if (!key) fail('INVALID_FACT_KEY', '可信事实键不能为空。', path + '.factKeys');
      return key;
    }))).sort(compareCodeUnits) : [];
    if (!factKeys.length) fail('FACT_CARD_EMPTY', '可信事实卡不能为空。', path + '.factKeys');
    if (!isPlainObject(record) || record.productFactCardId !== cardId || record.verificationId !== verificationId || !Array.isArray(record.facts)) {
      fail('FACT_CARD_RECORD_MISMATCH', '事实卡 registry 与可执行事实值记录不一致。', '$bundle.factCardsById.' + cardId);
    }
    denseArray(record.facts, '$bundle.factCardsById.' + cardId + '.facts');
    var seen = Object.create(null);
    var facts = record.facts.map(function (fact, factIndex) {
      if (!isPlainObject(fact)) fail('INVALID_FACT_VALUE', '事实值记录必须是普通对象。', '$bundle.factCardsById.' + cardId + '.facts[' + factIndex + ']');
      var factKey = text(fact.factKey, 240);
      if (!factKey || factKeys.indexOf(factKey) < 0 || seen[factKey]) {
        fail('FACT_CARD_RECORD_MISMATCH', '事实值键不在可信事实卡范围内或重复。', '$bundle.factCardsById.' + cardId + '.facts[' + factIndex + '].factKey');
      }
      seen[factKey] = true;
      var value = text(fact.value, 12000);
      if (!value) fail('FACT_VALUE_MISSING', '可信事实值不能为空。', '$bundle.factCardsById.' + cardId + '.facts[' + factIndex + '].value');
      return { factKey: factKey, label: text(fact.label || factKey, 1000), value: value };
    });
    if (factKeys.some(function (key) { return !seen[key]; })) {
      fail('FACT_CARD_RECORD_MISMATCH', '可执行事实值未覆盖可信事实卡全部键。', '$bundle.factCardsById.' + cardId + '.facts');
    }
    facts.sort(function (a, b) { return compareCodeUnits(a.factKey, b.factKey); });
    return {
      registry: { productFactCardId: cardId, verificationId: verificationId, factKeys: factKeys },
      record: { productFactCardId: cardId, verificationId: verificationId, facts: facts }
    };
  }

  function normalizeRegistryAsset(asset, record, index, claimMode) {
    var path = '$bundle.verifiedTargetAssets[' + index + ']';
    if (!isPlainObject(asset)) fail('INVALID_VERIFIED_ASSET', '可信素材记录无效。', path);
    var assetId = assertSafeId(asset.assetId, path + '.assetId', true);
    var rightsStatus = text(asset.rightsStatus, 40);
    if (!AUTHORIZED_RIGHTS[rightsStatus]) fail('UNAUTHORIZED_TARGET_ASSET', '素材未取得 authorized/self_owned 权利。', path + '.rightsStatus');
    var evidenceId = assertSafeId(asset.evidenceId, path + '.evidenceId', true);
    var role = text(asset.role || 'subject', 80);
    if (claimMode === VISUAL_STRUCTURE_ONLY && role !== 'subject' && role !== 'model') {
      fail('TARGET_ASSET_ROLE_MISMATCH', 'V2 资产 registry 只接受 subject/model 严格角色。', path + '.role');
    }
    var refDescriptor = isPlainObject(record) ? Object.getOwnPropertyDescriptor(record, 'ref') : null;
    var ref = refDescriptor && hasOwn(refDescriptor, 'value') ? refDescriptor.value : null;
    if (typeof ref !== 'string' || !ref.length || ref.length > MAX_TARGET_ASSET_REF_LENGTH || /[\u0000-\u001f\u007f]/.test(ref)) {
      fail('ASSET_REF_INVALID', '自有素材引用必须是完整、有界且不含控制字符的字符串。', '$bundle.assetsById.' + assetId + '.ref', {
        maxLength: MAX_TARGET_ASSET_REF_LENGTH
      });
    }
    if (!isPlainObject(record) || record.assetId !== assetId || record.rightsStatus !== rightsStatus ||
        record.evidenceId !== evidenceId || text(record.role || 'subject', 80) !== role) {
      fail('ASSET_RECORD_MISMATCH', '素材 registry 与可执行素材记录不一致。', '$bundle.assetsById.' + assetId);
    }
    return {
      registry: { assetId: assetId, rightsStatus: rightsStatus, evidenceId: evidenceId, role: role },
      record: { assetId: assetId, ref: ref, role: role, rightsStatus: rightsStatus, evidenceId: evidenceId }
    };
  }

  function confirmationFingerprintFor(envelope, verifiedProductFactCards, verifiedTargetAssets, factCardsById, assetsById) {
    return hash({
      schema: 'REFERENCE_DETAIL_CONFIRMATION_V1',
      currentBlueprint: clone(envelope.currentBlueprint),
      immediatePreviousBlueprint: clone(envelope.immediatePreviousBlueprint),
      verifiedProductFactCards: verifiedProductFactCards.map(function (card) {
        return { registry: clone(card), record: clone(factCardsById[card.productFactCardId]) };
      }),
      verifiedTargetAssets: verifiedTargetAssets.map(function (asset) {
        var record = assetsById[asset.assetId];
        return {
          registry: clone(asset),
          record: {
            assetId: record.assetId,
            refDigest: completeTextDigest(record.ref, 'rdassetref_'),
            role: record.role,
            rightsStatus: record.rightsStatus,
            evidenceId: record.evidenceId
          }
        };
      })
    }, 'rdconfirm_');
  }

  function visualStructureConfirmationFingerprintFor(envelope, verifiedTargetAssets, assetsById) {
    return hash({
      schema: 'REFERENCE_DETAIL_CONFIRMATION_V2',
      claimMode: VISUAL_STRUCTURE_ONLY,
      currentBlueprint: clone(envelope.currentBlueprint),
      immediatePreviousBlueprint: clone(envelope.immediatePreviousBlueprint),
      verifiedTargetAssets: verifiedTargetAssets.map(function (asset) {
        var record = assetsById[asset.assetId];
        return {
          registry: clone(asset),
          record: {
            assetId: record.assetId,
            refDigest: completeTextDigest(record.ref, 'rdassetref_'),
            role: record.role,
            rightsStatus: record.rightsStatus,
            evidenceId: record.evidenceId
          }
        };
      })
    }, 'rdconfirm2_');
  }

  function validateVisualStructureExecutionBundle(input) {
    requireVisualStructureContract();
    if (!isPlainObject(input) || input.schema !== EXECUTION_SCHEMA_V2 || Number(input.schemaVersion) !== 2 || input.claimMode !== VISUAL_STRUCTURE_ONLY) {
      fail('INVALID_EXECUTION_BUNDLE', 'V2 execution bundle schema/claimMode 无效。', '$bundle.schema');
    }
    ['verifiedProductFactCards', 'factCardsById', 'productFactCardId', 'facts'].forEach(function (key) {
      if (hasOwn(input, key)) fail('FACTLESS_BUNDLE_POLLUTED', 'visual_structure_only bundle 不得夹带事实卡或事实值字段。', '$bundle.' + key);
    });
    if (!input.sourceSnapshot || !input.currentBlueprint || !input.immediatePreviousBlueprint) {
      fail('EXECUTION_BUNDLE_INCOMPLETE', 'V2 bundle 缺少 snapshot 或完整 revision envelope。', '$bundle');
    }
    if (!Array.isArray(input.verifiedTargetAssets) || !input.verifiedTargetAssets.length || !isPlainObject(input.assetsById)) {
      fail('TRUST_REGISTRY_REQUIRED', 'V2 bundle 必须包含资产-only 可信 registry 与记录。', '$bundle');
    }
    denseArray(input.verifiedTargetAssets, '$bundle.verifiedTargetAssets');
    var sourceSnapshot;
    var envelope;
    try {
      sourceSnapshot = CONTRACT.sanitizeSourceSnapshot(input.sourceSnapshot);
      envelope = CONTRACT.createVisualStructureRevisionEnvelope(
        input.currentBlueprint, input.immediatePreviousBlueprint, sourceSnapshot
      );
    } catch (error) {
      fail(error.code || 'BLUEPRINT_VALIDATION_FAILED', error.message || 'V2 结构 revision 链复核失败。', error.path || '$bundle.currentBlueprint');
    }
    if (envelope.currentBlueprint.approvalStatus !== 'approved') {
      fail('BLUEPRINT_NOT_APPROVED', '只有 approved V2 currentBlueprint 可批量生成。', '$bundle.currentBlueprint.approvalStatus');
    }
    var assetsById = {};
    var verifiedTargetAssets = input.verifiedTargetAssets.map(function (asset, index) {
      var normalized = normalizeRegistryAsset(asset, input.assetsById[asset && asset.assetId], index, VISUAL_STRUCTURE_ONLY);
      if (assetsById[normalized.registry.assetId]) fail('DUPLICATE_TARGET_ASSET', '可信素材 ID 重复。', '$bundle.verifiedTargetAssets');
      assetsById[normalized.registry.assetId] = normalized.record;
      return normalized.registry;
    }).sort(function (a, b) { return compareCodeUnits(a.assetId, b.assetId); });
    Object.keys(input.assetsById).forEach(function (assetId) {
      if (!assetsById[assetId]) fail('UNSCOPED_TARGET_ASSET', 'assetsById 不得含 registry 范围外素材。', '$bundle.assetsById.' + assetId);
    });
    var confirmationFingerprint = visualStructureConfirmationFingerprintFor(envelope, verifiedTargetAssets, assetsById);
    if (input.confirmationFingerprint && input.confirmationFingerprint !== confirmationFingerprint) {
      fail('CONFIRMATION_FINGERPRINT_MISMATCH', 'V2 确认指纹与结构或自有素材不一致。', '$bundle.confirmationFingerprint');
    }
    var bundleId = hash({
      claimMode: VISUAL_STRUCTURE_ONLY,
      confirmationFingerprint: confirmationFingerprint,
      snapshotId: envelope.currentBlueprint.sourceSnapshotId,
      blueprintId: envelope.currentBlueprint.blueprintId,
      revision: envelope.currentBlueprint.revision,
      assets: verifiedTargetAssets
    }, 'rdexec2_');
    if (input.bundleId && input.bundleId !== bundleId) fail('BUNDLE_ID_MISMATCH', 'V2 bundleId 与可信内容不一致。', '$bundle.bundleId');
    return deepFreeze({
      schema: EXECUTION_SCHEMA_V2,
      schemaVersion: 2,
      claimMode: VISUAL_STRUCTURE_ONLY,
      bundleId: bundleId,
      confirmationFingerprint: confirmationFingerprint,
      sourceSnapshot: clone(sourceSnapshot),
      currentBlueprint: clone(envelope.currentBlueprint),
      immediatePreviousBlueprint: clone(envelope.immediatePreviousBlueprint),
      verifiedTargetAssets: verifiedTargetAssets,
      assetsById: assetsById
    });
  }

  function validateExecutionBundle(input) {
    requireContract();
    if (!isPlainObject(input)) fail('INVALID_EXECUTION_BUNDLE', 'execution bundle 必须是普通对象。', '$bundle');
    if (input.schema === EXECUTION_SCHEMA_V2) return validateVisualStructureExecutionBundle(input);
    if (input.schema !== EXECUTION_SCHEMA || Number(input.schemaVersion) !== 1) {
      fail('INVALID_EXECUTION_BUNDLE', 'execution bundle schema 无效。', '$bundle.schema');
    }
    if (!input.sourceSnapshot || !input.currentBlueprint) fail('EXECUTION_BUNDLE_INCOMPLETE', 'execution bundle 缺少 snapshot 或 currentBlueprint。', '$bundle');
    if (input.currentBlueprint.approvalStatus !== 'approved') fail('BLUEPRINT_NOT_APPROVED', '只有 approved currentBlueprint 可批量生成。', '$bundle.currentBlueprint.approvalStatus');
    if (!input.immediatePreviousBlueprint) fail('PREVIOUS_BLUEPRINT_REQUIRED', 'approved revision 必须携带直接前一蓝图。', '$bundle.immediatePreviousBlueprint');
    if (!Array.isArray(input.verifiedProductFactCards) || !input.verifiedProductFactCards.length ||
        !Array.isArray(input.verifiedTargetAssets) || !input.verifiedTargetAssets.length ||
        !isPlainObject(input.factCardsById) || !isPlainObject(input.assetsById)) {
      fail('TRUST_REGISTRY_REQUIRED', 'execution bundle 缺少可信事实或素材 registry。', '$bundle');
    }
    denseArray(input.verifiedProductFactCards, '$bundle.verifiedProductFactCards');
    denseArray(input.verifiedTargetAssets, '$bundle.verifiedTargetAssets');
    var sourceSnapshot;
    var envelope;
    try {
      sourceSnapshot = CONTRACT.sanitizeSourceSnapshot(input.sourceSnapshot);
      envelope = CONTRACT.createRevisionEnvelope(
        input.currentBlueprint,
        input.immediatePreviousBlueprint,
        sourceSnapshot,
        { verifiedProductFactCards: input.verifiedProductFactCards, verifiedTargetAssets: input.verifiedTargetAssets }
      );
    } catch (error) {
      fail(error.code || 'BLUEPRINT_VALIDATION_FAILED', error.message || '蓝图 revision 链复核失败。', error.path || '$bundle.currentBlueprint');
    }
    var factCardsById = {};
    var verifiedProductFactCards = input.verifiedProductFactCards.map(function (card, index) {
      var normalized = normalizeRegistryFactCard(card, input.factCardsById[card && card.productFactCardId], index);
      if (factCardsById[normalized.registry.productFactCardId]) fail('DUPLICATE_FACT_CARD', '可信事实卡 ID 重复。', '$bundle.verifiedProductFactCards');
      factCardsById[normalized.registry.productFactCardId] = normalized.record;
      return normalized.registry;
    }).sort(function (a, b) { return compareCodeUnits(a.productFactCardId, b.productFactCardId); });
    var assetsById = {};
    var verifiedTargetAssets = input.verifiedTargetAssets.map(function (asset, index) {
      var normalized = normalizeRegistryAsset(asset, input.assetsById[asset && asset.assetId], index);
      if (assetsById[normalized.registry.assetId]) fail('DUPLICATE_TARGET_ASSET', '可信素材 ID 重复。', '$bundle.verifiedTargetAssets');
      assetsById[normalized.registry.assetId] = normalized.record;
      return normalized.registry;
    }).sort(function (a, b) { return compareCodeUnits(a.assetId, b.assetId); });
    var approvedCards = envelope.currentBlueprint.approval && envelope.currentBlueprint.approval.productFactCardIds || [];
    approvedCards.forEach(function (cardId) {
      if (!factCardsById[cardId]) fail('UNVERIFIED_FACT_CARD', 'approved 蓝图事实卡不在 execution registry。', '$bundle.currentBlueprint.approval.productFactCardIds');
    });
    var confirmationFingerprint = confirmationFingerprintFor(
      envelope,
      verifiedProductFactCards,
      verifiedTargetAssets,
      factCardsById,
      assetsById
    );
    if (input.confirmationFingerprint && input.confirmationFingerprint !== confirmationFingerprint) {
      fail('CONFIRMATION_FINGERPRINT_MISMATCH', '确认指纹与已确认蓝图、可信事实或自有素材不一致。', '$bundle.confirmationFingerprint');
    }
    var bundleId = hash({
      confirmationFingerprint: confirmationFingerprint,
      snapshotId: envelope.currentBlueprint.sourceSnapshotId,
      blueprintId: envelope.currentBlueprint.blueprintId,
      revision: envelope.currentBlueprint.revision,
      factCards: verifiedProductFactCards,
      assets: verifiedTargetAssets
    }, 'rdexec_');
    if (input.bundleId && input.bundleId !== bundleId) fail('BUNDLE_ID_MISMATCH', 'bundleId 与可信内容不一致。', '$bundle.bundleId');
    return deepFreeze({
      schema: EXECUTION_SCHEMA,
      schemaVersion: 1,
      bundleId: bundleId,
      confirmationFingerprint: confirmationFingerprint,
      sourceSnapshot: clone(sourceSnapshot),
      currentBlueprint: clone(envelope.currentBlueprint),
      immediatePreviousBlueprint: clone(envelope.immediatePreviousBlueprint),
      verifiedProductFactCards: verifiedProductFactCards,
      verifiedTargetAssets: verifiedTargetAssets,
      factCardsById: factCardsById,
      assetsById: assetsById
    });
  }

  function registryMaps(bundle) {
    var cards = Object.create(null);
    var assets = Object.create(null);
    (bundle.verifiedProductFactCards || []).forEach(function (card) { cards[card.productFactCardId] = card; });
    bundle.verifiedTargetAssets.forEach(function (asset) { assets[asset.assetId] = asset; });
    return { cards: cards, assets: assets };
  }

  function createConfirmationFingerprint(bundleInput) {
    return validateExecutionBundle(bundleInput).confirmationFingerprint;
  }

  function requiredTargetFields(blueprint) {
    var fields = [];
    blueprint.modules.forEach(function (module) {
      if (!module.selected) return;
      module.factBindings.forEach(function (binding) {
        if (binding.required && fields.indexOf(binding.targetField) < 0) fields.push(binding.targetField);
      });
    });
    return fields.sort(compareCodeUnits);
  }

  function validateTarget(bundle, input, index) {
    var target = normalizeDraftTarget(input);
    var path = '$targets[' + index + ']';
    var errors = [];
    var maps = registryMaps(bundle);
    function issue(code, message, field) { errors.push({ code: code, message: message, path: path + '.' + field }); }
    if (bundle.claimMode === VISUAL_STRUCTURE_ONLY) {
      if (text(input && input.productFactCardId, 240) || hasOwn(input, 'facts')) {
        issue('FACTLESS_TARGET_POLLUTED', 'visual_structure_only 目标不得绑定事实卡或 facts。', 'productFactCardId');
      }
      if (!target.targetInputId) issue('TARGET_INPUT_ID_REQUIRED', 'V2 目标缺少稳定 targetInputId。', 'targetInputId');
      if (!target.subjectAssetIds.length) issue('SUBJECT_ASSET_REQUIRED', '每个目标至少需要一张自有或授权主体图。', 'subjectAssetIds');
      target.subjectAssetIds.forEach(function (assetId) {
        var verified = maps.assets[assetId];
        var record = bundle.assetsById[assetId];
        if (!verified || !record || !AUTHORIZED_RIGHTS[verified.rightsStatus] ||
            verified.rightsStatus !== record.rightsStatus || verified.role !== 'subject' || record.role !== 'subject') {
          issue(verified && record ? 'TARGET_ASSET_ROLE_MISMATCH' : 'UNAUTHORIZED_TARGET_ASSET', '主体素材必须通过 subject 角色的 authorized/self_owned registry 复核。', 'subjectAssetIds');
        }
      });
      target.modelAssetIds.forEach(function (assetId) {
        var verified = maps.assets[assetId];
        var record = bundle.assetsById[assetId];
        if (!verified || !record || !AUTHORIZED_RIGHTS[verified.rightsStatus] ||
            verified.rightsStatus !== record.rightsStatus || verified.role !== 'model' || record.role !== 'model') {
          issue(verified && record ? 'TARGET_ASSET_ROLE_MISMATCH' : 'UNAUTHORIZED_TARGET_ASSET', '模特素材必须通过 model 角色的 authorized/self_owned registry 复核。', 'modelAssetIds');
        }
      });
      if (target.modelAssetIds.some(function (assetId) { return target.subjectAssetIds.indexOf(assetId) >= 0; })) {
        issue('TARGET_ASSET_ROLE_MISMATCH', '同一素材不得同时作为主体与模特。', 'modelAssetIds');
      }
      return { target: target, errors: errors };
    }
    if (!target.productFactCardId || !SAFE_ID.test(target.productFactCardId)) issue('FACT_CARD_REQUIRED', '请选择可信自家事实卡。', 'productFactCardId');
    else if (bundle.currentBlueprint.approval.productFactCardIds.indexOf(target.productFactCardId) < 0) {
      issue('FACT_CARD_NOT_APPROVED', '事实卡不在当前 approved revision，必须回工作台重新审批。', 'productFactCardId');
    } else if (!maps.cards[target.productFactCardId] || !bundle.factCardsById[target.productFactCardId]) {
      issue('UNVERIFIED_FACT_CARD', '事实卡未通过 execution registry 复核。', 'productFactCardId');
    }
    if (!target.subjectAssetIds.length) issue('SUBJECT_ASSET_REQUIRED', '每个目标至少需要一张自有或授权主体图。', 'subjectAssetIds');
    target.subjectAssetIds.concat(target.modelAssetIds).forEach(function (assetId) {
      var verified = maps.assets[assetId];
      var record = bundle.assetsById[assetId];
      if (!verified || !record || !AUTHORIZED_RIGHTS[verified.rightsStatus] || verified.rightsStatus !== record.rightsStatus) {
        issue('UNAUTHORIZED_TARGET_ASSET', '目标素材未通过 authorized/self_owned registry 复核。', 'subjectAssetIds');
      }
    });
    if (target.productFactCardId && bundle.factCardsById[target.productFactCardId]) {
      var factValues = Object.create(null);
      bundle.factCardsById[target.productFactCardId].facts.forEach(function (fact) { factValues[fact.factKey] = fact.value; });
      requiredTargetFields(bundle.currentBlueprint).forEach(function (field) {
        if (field === '*') {
          if (!Object.keys(factValues).length) issue('FACT_VALUE_MISSING', '事实卡没有可用于必要绑定的事实值。', 'productFactCardId');
        } else if (!text(factValues[field], 12000)) {
          issue('FACT_VALUE_MISSING', '事实卡缺少蓝图必要绑定：' + field, 'productFactCardId');
        }
      });
    }
    return { target: target, errors: errors };
  }

  function selectedTargets(bundle, inputs) {
    denseArray(inputs, '$targets');
    var normalized = [];
    var issues = [];
    var ids = Object.create(null);
    var taskKeys = Object.create(null);
    inputs.forEach(function (input, index) {
      var checked = validateTarget(bundle, input, index);
      if (!checked.target.selected) return;
      if (ids[checked.target.draftTargetId]) checked.errors.push({ code: 'DUPLICATE_DRAFT_TARGET', message: 'draftTargetId 重复。', path: '$targets[' + index + '].draftTargetId' });
      if (taskKeys[checked.target.taskKey]) checked.errors.push({ code: 'DUPLICATE_TASK_KEY', message: 'taskKey 重复；复制行必须生成新 taskKey。', path: '$targets[' + index + '].taskKey' });
      ids[checked.target.draftTargetId] = true;
      taskKeys[checked.target.taskKey] = true;
      normalized.push(checked.target);
      issues = issues.concat(checked.errors);
    });
    if (!normalized.length) issues.push({ code: 'NO_SELECTED_TARGET', message: '至少选择一个可生成目标。', path: '$targets' });
    if (issues.length) fail('TARGETS_BLOCKED', issues[0].message, issues[0].path, { issues: issues });
    return normalized;
  }

  function toContractTargets(inputs, bundleInput) {
    denseArray(inputs, '$targets');
    var visualStructureOnly = bundleInput && bundleInput.claimMode === VISUAL_STRUCTURE_ONLY;
    return deepFreeze(inputs.map(function (input) { return normalizeDraftTarget(input); }).filter(function (target) {
      return target.selected;
    }).map(function (target) {
      if (visualStructureOnly) {
        return {
          taskKey: target.taskKey,
          targetInputId: target.targetInputId,
          subjectAssetIds: target.subjectAssetIds.slice(),
          modelAssetIds: target.modelAssetIds.slice(),
          skuIds: target.skuIds.slice()
        };
      }
      return {
        taskKey: target.taskKey,
        productFactCardId: target.productFactCardId,
        subjectAssetIds: target.subjectAssetIds.slice(),
        skuIds: target.skuIds.slice()
      };
    }));
  }

  function targetAssetRecords(bundle, ids) {
    return ids.map(function (assetId) {
      var record = bundle.assetsById[assetId];
      return {
        assetId: record.assetId,
        ref: record.ref,
        role: record.role,
        rightsStatus: record.rightsStatus,
        evidenceId: record.evidenceId
      };
    });
  }

  function reuseModeValue(value, path) {
    value = text(value || 'single_reference', 80);
    if (REUSE_MODES.indexOf(value) < 0) fail('INVALID_REUSE_MODE', '复制模式无效。', path || '$options.reuseMode');
    return value;
  }

  function positiveVersion(value, path) {
    value = value == null ? 1 : Number(value);
    if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_VERSION', '版本号必须是正整数。', path);
    return value;
  }

  function visualBlueprintForModule(module) {
    var visual = isPlainObject(module && module.visualBrief) ? module.visualBrief : {};
    return {
      description: text(visual.description, 1000),
      layout: text(visual.layout, 1000),
      shotType: text(visual.shotType, 1000),
      subjectPlacement: text(visual.subjectPlacement, 1000),
      background: text(visual.background, 1000),
      lighting: text(visual.lighting, 1000),
      palette: Array.isArray(visual.palette) ? visual.palette.map(function (item) { return text(item, 1000); }).filter(Boolean) : [],
      textZones: Array.isArray(visual.textZones) ? visual.textZones.map(function (item) { return text(item, 1000); }).filter(Boolean) : [],
      density: text(visual.density, 1000),
      transition: text(visual.transition, 1000),
      mood: text(visual.mood, 1000),
      mustKeep: Array.isArray(visual.mustKeep) ? visual.mustKeep.map(function (item) { return text(item, 1000); }).filter(Boolean) : [],
      avoid: Array.isArray(visual.avoid) ? visual.avoid.map(function (item) { return text(item, 1000); }).filter(Boolean) : []
    };
  }

  function comparableDirection(value) {
    return text(value, 1000).toLowerCase().replace(/[\s\u3000,，。！？!?\.:：;；、'"“”‘’()（）\[\]【】{}<>《》—_\-|｜]+/g, '');
  }

  function sourceImageIdsForModule(bundle, module) {
    var blockById = Object.create(null);
    (bundle.sourceSnapshot.orderedBlocks || []).forEach(function (block) {
      if (block && block.blockId) blockById[block.blockId] = block;
    });
    var assetById = Object.create(null);
    (bundle.sourceSnapshot.assets || []).forEach(function (asset) {
      if (asset && asset.assetId) assetById[asset.assetId] = asset;
    });
    var seen = Object.create(null);
    var imageIds = [];
    (module.sourceBlockIds || []).forEach(function (blockId) {
      var block = blockById[blockId];
      (block && block.assetIds || []).forEach(function (assetId) {
        var asset = assetById[assetId];
        if (!asset || seen[assetId]) return;
        if (asset.mediaType === 'image' || /^(?:main|hero|product|subject|detail|option|sku|scene|model|logo|badge|icon|background|decoration|comparison|proof|spec|size|service)$/.test(String(asset.role || ''))) {
          seen[assetId] = true;
          imageIds.push(assetId);
        }
      });
    });
    return imageIds;
  }

  function targetFactsForModule(module, factRecord) {
    var factsByKey = Object.create(null);
    (factRecord.facts || []).forEach(function (fact) { factsByKey[fact.factKey] = fact; });
    var selected = [];
    (module.factBindings || []).forEach(function (binding) {
      if (!binding || binding.required === false) return;
      if (binding.targetField === '*') selected = selected.concat(factRecord.facts || []);
      else if (factsByKey[binding.targetField]) selected.push(factsByKey[binding.targetField]);
    });
    if (!selected.length) selected = (factRecord.facts || []).slice();
    var seen = Object.create(null);
    return selected.filter(function (fact) {
      if (!fact || seen[fact.factKey]) return false;
      seen[fact.factKey] = true;
      return true;
    }).sort(function (a, b) { return compareCodeUnits(a.factKey, b.factKey); });
  }

  function replicaModulesForScreenCount(modules, screenCount, bundle) {
    if (modules.length !== screenCount) {
      fail('CONFIRMED_SCREEN_COUNT_MISMATCH', '生成屏数必须与已确认蓝图的选中模块数一致，确认后不得合并、复制或改序。', '$options.screenCount', {
        confirmedScreenCount: modules.length,
        requestedScreenCount: screenCount,
        blueprintId: bundle.currentBlueprint.blueprintId
      });
    }
    return modules;
  }

  function visualStructureUserInput(target) {
    var output = clone(target.userInput || {});
    if (target.audience && !hasOwn(output, 'audience')) output.audience = target.audience;
    if (target.language && !hasOwn(output, 'language')) output.language = target.language;
    if (target.sellingAngle && !hasOwn(output, 'sellingAngle')) output.sellingAngle = target.sellingAngle;
    return canonicalJson(output, '$target.userInput', 0);
  }

  function createVisualStructureReplicaPlan(bundle, targetInput, options) {
    var checked = validateTarget(bundle, targetInput, 0);
    if (checked.errors.length) fail(checked.errors[0].code, checked.errors[0].message, checked.errors[0].path, { issues: checked.errors });
    var target = checked.target;
    var mode = reuseModeValue(options.reuseMode, '$options.reuseMode');
    var selectedModules = bundle.currentBlueprint.modules.filter(function (module) { return module.selected; })
      .slice().sort(function (a, b) { return a.order - b.order || compareCodeUnits(a.moduleId, b.moduleId); });
    if (!selectedModules.length) fail('REPLICA_SCREEN_REQUIRED', '结构复刻计划至少需要一个已选模块。', '$bundle.currentBlueprint.modules');
    var screenCount = options.screenCount === undefined
      ? screenCountValue(selectedModules.length, '$bundle.currentBlueprint.modules')
      : screenCountValue(options.screenCount, '$options.screenCount');
    selectedModules = replicaModulesForScreenCount(selectedModules, screenCount, bundle);
    var referenceScopeId = options.referenceScopeId
      ? assertSafeId(options.referenceScopeId, '$options.referenceScopeId', true)
      : hash({ bundleId: bundle.bundleId, sourceSnapshotId: bundle.currentBlueprint.sourceSnapshotId, claimMode: VISUAL_STRUCTURE_ONLY }, 'rdrefscope2_');
    var skuScopeId = options.skuScopeId
      ? assertSafeId(options.skuScopeId, '$options.skuScopeId', true)
      : (target.skuIds.length === 1 ? target.skuIds[0] : hash({ targetInputId: target.targetInputId }, 'rdtargetscope2_'));
    if (mode === 'sku_replace') {
      if (target.skuIds.length !== 1 || target.skuIds[0] !== skuScopeId) {
        fail('SKU_SCOPE_REQUIRED', 'SKU 替换模式必须一个任务只绑定一个一致 SKU。', '$target.skuIds');
      }
      var skuScope = options.skuScope;
      if (!isPlainObject(skuScope) || skuScope.skuId !== skuScopeId ||
          (skuScope.targetInputId && skuScope.targetInputId !== target.targetInputId)) {
        fail('SKU_SCOPE_MISMATCH', 'V2 SKU scope 必须绑定当前 targetInputId。', '$options.skuScope');
      }
      var scopedAssetIds = uniqueSortedIds(skuScope.assetIds || [], '$options.skuScope.assetIds');
      var scopedTargetAssets = target.subjectAssetIds.concat(target.modelAssetIds).slice().sort(compareCodeUnits);
      if (!scopedAssetIds.length || CONTRACT.stableSerialize(scopedAssetIds) !== CONTRACT.stableSerialize(scopedTargetAssets)) {
        fail('SKU_ASSET_SCOPE_MISMATCH', 'SKU 素材必须与当前 V2 目标精确一致。', '$options.skuScope.assetIds');
      }
    }
    var generationVersion = positiveVersion(options.generationVersion, '$options.generationVersion');
    var allTargetAssetIds = target.subjectAssetIds.concat(target.modelAssetIds);
    var allTargetAssetSet = Object.create(null);
    allTargetAssetIds.forEach(function (assetId) { allTargetAssetSet[assetId] = true; });
    var screenAssetBindings = options.screenAssetBindings;
    if (screenAssetBindings != null && !isPlainObject(screenAssetBindings)) fail('INVALID_SCREEN_ASSET_BINDINGS', '逐屏素材绑定必须是普通对象。', '$options.screenAssetBindings');
    screenAssetBindings = screenAssetBindings == null ? null : canonicalJson(screenAssetBindings, '$options.screenAssetBindings', 0);
    var directionOwners = Object.create(null);
    var screens = selectedModules.map(function (module, index) {
      var direction = text(module.visualBrief && module.visualBrief.description, 1000);
      var comparable = comparableDirection(direction);
      if (!comparable) fail('SCREEN_DIRECTION_REQUIRED', '每屏必须有结构视觉方向。', '$bundle.currentBlueprint.modules[' + index + '].visualBrief.description');
      if (directionOwners[comparable] != null) fail('SCREEN_DIRECTION_DUPLICATE', '每屏结构视觉方向必须唯一。', '$bundle.currentBlueprint.modules[' + index + '].visualBrief.description');
      directionOwners[comparable] = index;
      var bindingKey = String(index + 1);
      var explicitBindingKey = screenAssetBindings && hasOwn(screenAssetBindings, module.moduleId)
        ? module.moduleId
        : (screenAssetBindings && hasOwn(screenAssetBindings, bindingKey) ? bindingKey : '');
      var explicitBinding = explicitBindingKey ? screenAssetBindings[explicitBindingKey] : null;
      var assetIds = explicitBinding == null ? allTargetAssetIds.slice() : uniqueSortedIds(explicitBinding, '$options.screenAssetBindings.' + explicitBindingKey);
      if (assetIds.some(function (assetId) { return !allTargetAssetSet[assetId]; })) {
        fail('SCREEN_ASSET_SCOPE_MISMATCH', '逐屏素材引用超出当前目标。', '$options.screenAssetBindings.' + explicitBindingKey);
      }
      return {
        screenIndex: index + 1,
        moduleId: module.moduleId,
        moduleOrder: module.order,
        moduleType: module.type,
        locked: module.locked === true,
        commercialRole: module.salesRole,
        visualBlueprint: visualBlueprintForModule(module),
        targetDirection: direction,
        assetIds: Array.from(new Set(assetIds)).sort(compareCodeUnits),
        safetyFlags: (module.riskFlags || []).slice().sort(compareCodeUnits),
        blueprintVersion: bundle.currentBlueprint.revision,
        generationVersion: generationVersion
      };
    });
    var referenceBlueprint = {
      blueprintId: bundle.currentBlueprint.blueprintId,
      blueprintVersion: bundle.currentBlueprint.revision,
      referenceScopeId: referenceScopeId,
      screens: screens.map(function (screen) {
        return {
          screenIndex: screen.screenIndex,
          moduleId: screen.moduleId,
          moduleOrder: screen.moduleOrder,
          moduleType: screen.moduleType,
          locked: screen.locked,
          commercialRole: screen.commercialRole,
          visualBlueprint: clone(screen.visualBlueprint),
          safetyFlags: screen.safetyFlags.slice()
        };
      })
    };
    var targetAssetScope = {
      targetInputId: target.targetInputId,
      skuIds: target.skuIds.slice(),
      subjectAssetIds: target.subjectAssetIds.slice(),
      modelAssetIds: target.modelAssetIds.slice(),
      assets: runtimeAssetMetadata(targetAssetRecords(bundle, allTargetAssetIds))
    };
    var targetContext = {
      targetInputId: target.targetInputId,
      draftTargetId: target.draftTargetId,
      productName: target.productName,
      internalId: target.internalId,
      userInput: visualStructureUserInput(target)
    };
    var identity = {
      claimMode: VISUAL_STRUCTURE_ONLY,
      confirmationFingerprint: bundle.confirmationFingerprint,
      reuseMode: mode,
      referenceScopeId: referenceScopeId,
      skuScopeId: skuScopeId,
      referenceBlueprint: referenceBlueprint,
      targetAssetScope: targetAssetScope,
      targetContext: targetContext,
      screens: screens
    };
    return deepFreeze({
      schema: REPLICA_PLAN_SCHEMA_V2,
      schemaVersion: 2,
      claimMode: VISUAL_STRUCTURE_ONLY,
      replicaPlanId: hash(identity, 'rdreplica2_'),
      confirmationFingerprint: bundle.confirmationFingerprint,
      reuseMode: mode,
      referenceScopeId: referenceScopeId,
      skuScopeId: skuScopeId,
      sourceSnapshotId: bundle.currentBlueprint.sourceSnapshotId,
      blueprintId: bundle.currentBlueprint.blueprintId,
      blueprintVersion: bundle.currentBlueprint.revision,
      targetInputId: target.targetInputId,
      referenceBlueprint: referenceBlueprint,
      targetAssetScope: targetAssetScope,
      targetContext: targetContext,
      screens: screens
    });
  }

  function createReplicaPlan(bundleInput, targetInput, options) {
    options = isPlainObject(options) ? options : {};
    var bundle = validateExecutionBundle(bundleInput);
    if (bundle.claimMode === VISUAL_STRUCTURE_ONLY) return createVisualStructureReplicaPlan(bundle, targetInput, options);
    var checked = validateTarget(bundle, targetInput, 0);
    if (checked.errors.length) fail(checked.errors[0].code, checked.errors[0].message, checked.errors[0].path, { issues: checked.errors });
    var target = checked.target;
    var mode = reuseModeValue(options.reuseMode, '$options.reuseMode');
    var selectedModules = bundle.currentBlueprint.modules.filter(function (module) { return module.selected; })
      .slice().sort(function (a, b) { return a.order - b.order || compareCodeUnits(a.moduleId, b.moduleId); });
    if (!selectedModules.length) fail('REPLICA_SCREEN_REQUIRED', '复刻计划至少需要一个已选蓝图模块。', '$bundle.currentBlueprint.modules');
    var screenCount = options.screenCount === undefined
      ? screenCountValue(selectedModules.length, '$bundle.currentBlueprint.modules')
      : screenCountValue(options.screenCount, '$options.screenCount');
    selectedModules = replicaModulesForScreenCount(selectedModules, screenCount, bundle);
    var referenceScopeId = options.referenceScopeId
      ? assertSafeId(options.referenceScopeId, '$options.referenceScopeId', true)
      : hash({ bundleId: bundle.bundleId, sourceSnapshotId: bundle.currentBlueprint.sourceSnapshotId }, 'rdrefscope_');
    var skuScopeId = options.skuScopeId
      ? assertSafeId(options.skuScopeId, '$options.skuScopeId', true)
      : (target.skuIds.length === 1 ? target.skuIds[0] : hash({ draftTargetId: target.draftTargetId }, 'rdtargetscope_'));
    if (mode === 'sku_replace') {
      if (target.skuIds.length !== 1 || target.skuIds[0] !== skuScopeId) {
        fail('SKU_SCOPE_REQUIRED', 'SKU 替换模式必须一个任务只绑定一个与 skuScopeId 一致的 SKU。', '$target.skuIds');
      }
      var skuScope = options.skuScope;
      if (!isPlainObject(skuScope) || skuScope.skuId !== skuScopeId || skuScope.productFactCardId !== target.productFactCardId) {
        fail('SKU_TRUTH_SCOPE_MISMATCH', 'SKU 替换必须显式绑定当前 SKU 的事实卡。', '$options.skuScope');
      }
      var scopedAssetIds = uniqueSortedIds(skuScope.assetIds || [], '$options.skuScope.assetIds');
      var targetAssetIds = target.subjectAssetIds.concat(target.modelAssetIds).slice().sort(compareCodeUnits);
      if (!scopedAssetIds.length || CONTRACT.stableSerialize(scopedAssetIds) !== CONTRACT.stableSerialize(targetAssetIds)) {
        fail('SKU_ASSET_SCOPE_MISMATCH', 'SKU 替换的素材必须与当前任务精确一致，不得共用其他 SKU 素材。', '$options.skuScope.assetIds');
      }
    }
    var generationVersion = positiveVersion(options.generationVersion, '$options.generationVersion');
    var factRecord = bundle.factCardsById[target.productFactCardId];
    var verificationId = factRecord.verificationId;
    var allTargetAssetIds = target.subjectAssetIds.concat(target.modelAssetIds);
    var allTargetAssetSet = Object.create(null);
    allTargetAssetIds.forEach(function (assetId) { allTargetAssetSet[assetId] = true; });
    var truthFacts = factRecord.facts.map(function (fact) {
      return {
        targetFactId: hash({ productFactCardId: target.productFactCardId, factKey: fact.factKey }, 'rdtruthfact_'),
        factKey: fact.factKey,
        label: fact.label,
        value: fact.value,
        verificationId: verificationId
      };
    });
    var truthFactByKey = Object.create(null);
    truthFacts.forEach(function (fact) { truthFactByKey[fact.factKey] = fact; });
    var truthAssets = targetAssetRecords(bundle, allTargetAssetIds).map(function (asset) {
      return { assetId: asset.assetId, role: asset.role, rightsStatus: asset.rightsStatus, evidenceId: asset.evidenceId };
    });
    var screenAssetBindings = options.screenAssetBindings;
    if (screenAssetBindings != null && !isPlainObject(screenAssetBindings)) {
      fail('INVALID_SCREEN_ASSET_BINDINGS', '逐屏素材绑定必须是普通对象。', '$options.screenAssetBindings');
    }
    screenAssetBindings = screenAssetBindings == null ? null : canonicalJson(screenAssetBindings, '$options.screenAssetBindings', 0);
    var directionOwners = Object.create(null);
    var screens = selectedModules.map(function (module, index) {
      var direction = text(module.visualBrief && module.visualBrief.description, 1000);
      var comparable = comparableDirection(direction);
      if (!comparable) fail('SCREEN_DIRECTION_REQUIRED', '每屏必须有一句面向目标商品的核心内容方向。', '$bundle.currentBlueprint.modules[' + index + '].visualBrief.description');
      if (directionOwners[comparable] != null) fail('SCREEN_DIRECTION_DUPLICATE', '复刻计划的每屏方向必须唯一，不得重复。', '$bundle.currentBlueprint.modules[' + index + '].visualBrief.description');
      directionOwners[comparable] = index;
      var allowedFacts = targetFactsForModule(module, factRecord).map(function (fact) { return truthFactByKey[fact.factKey]; }).filter(Boolean);
      // Formal blueprint targetAssetSlots prove the blueprint approval that happened at the
      // time; they are not a reusable target's runtime bindings. A reused plan defaults to
      // the current target's own assets, or accepts an explicit per-screen subset.
      var bindingKey = String(index + 1);
      var explicitBindingKey = screenAssetBindings && hasOwn(screenAssetBindings, module.moduleId)
        ? module.moduleId
        : (screenAssetBindings && hasOwn(screenAssetBindings, bindingKey) ? bindingKey : '');
      var explicitBinding = explicitBindingKey ? screenAssetBindings[explicitBindingKey] : null;
      var moduleAssetIds = explicitBinding == null
        ? allTargetAssetIds.slice()
        : uniqueSortedIds(explicitBinding, '$options.screenAssetBindings.' + explicitBindingKey);
      if (moduleAssetIds.some(function (assetId) { return !allTargetAssetSet[assetId]; })) {
        fail('SCREEN_ASSET_SCOPE_MISMATCH', '逐屏素材绑定引用了当前目标任务之外的素材。', '$options.screenAssetBindings.' + explicitBindingKey);
      }
      moduleAssetIds = Array.from(new Set(moduleAssetIds)).sort(compareCodeUnits);
      return {
        screenIndex: index + 1,
        moduleId: module.moduleId,
        moduleOrder: module.order,
        moduleType: module.type,
        locked: module.locked === true,
        publishableCopy: clone(module.editableCopy),
        sourceBlockIds: module.sourceBlockIds.slice(),
        sourceImageIds: sourceImageIdsForModule(bundle, module),
        commercialRole: module.salesRole,
        visualBlueprint: visualBlueprintForModule(module),
        targetDirection: direction,
        targetFacts: allowedFacts.map(function (fact) { return clone(fact); }),
        assetIds: moduleAssetIds,
        safetyFlags: (module.riskFlags || []).slice().sort(compareCodeUnits),
        blueprintVersion: bundle.currentBlueprint.revision,
        generationVersion: generationVersion
      };
    });
    var targetProductTruth = {
      truthId: hash({ confirmationFingerprint: bundle.confirmationFingerprint, productFactCardId: target.productFactCardId, facts: truthFacts, assets: truthAssets, skuScopeId: skuScopeId }, 'rdtruth_'),
      confirmationFingerprint: bundle.confirmationFingerprint,
      productFactCardId: target.productFactCardId,
      verificationId: verificationId,
      skuIds: target.skuIds.slice(),
      skuScopeId: skuScopeId,
      facts: truthFacts,
      assets: truthAssets
    };
    var targetContext = {
      draftTargetId: target.draftTargetId,
      audience: target.audience,
      language: target.language,
      sellingAngle: target.sellingAngle
    };
    var referenceBlueprint = {
      sourceSnapshotId: bundle.currentBlueprint.sourceSnapshotId,
      blueprintId: bundle.currentBlueprint.blueprintId,
      blueprintVersion: bundle.currentBlueprint.revision,
      referenceScopeId: referenceScopeId,
      screens: screens.map(function (screen) {
        return {
          screenIndex: screen.screenIndex,
          moduleId: screen.moduleId,
          moduleOrder: screen.moduleOrder,
          moduleType: screen.moduleType,
          locked: screen.locked,
          sourceBlockIds: screen.sourceBlockIds.slice(),
          sourceImageIds: screen.sourceImageIds.slice(),
          commercialRole: screen.commercialRole,
          visualBlueprint: clone(screen.visualBlueprint),
          safetyFlags: screen.safetyFlags.slice()
        };
      })
    };
    var identity = {
      confirmationFingerprint: bundle.confirmationFingerprint,
      reuseMode: mode,
      referenceScopeId: referenceScopeId,
      skuScopeId: skuScopeId,
      referenceBlueprint: referenceBlueprint,
      targetTruthId: targetProductTruth.truthId,
      targetContext: targetContext,
      screens: screens.map(function (screen) {
        return {
          screenIndex: screen.screenIndex,
          moduleId: screen.moduleId,
          targetDirection: screen.targetDirection,
          targetFactIds: screen.targetFacts.map(function (fact) { return fact.targetFactId; }),
          assetIds: screen.assetIds,
          blueprintVersion: screen.blueprintVersion,
          generationVersion: screen.generationVersion
        };
      })
    };
    return deepFreeze({
      schema: REPLICA_PLAN_SCHEMA,
      schemaVersion: 1,
      replicaPlanId: hash(identity, 'rdreplica_'),
      confirmationFingerprint: bundle.confirmationFingerprint,
      reuseMode: mode,
      referenceScopeId: referenceScopeId,
      skuScopeId: skuScopeId,
      sourceSnapshotId: bundle.currentBlueprint.sourceSnapshotId,
      blueprintId: bundle.currentBlueprint.blueprintId,
      blueprintVersion: bundle.currentBlueprint.revision,
      referenceBlueprint: referenceBlueprint,
      targetProductTruth: targetProductTruth,
      targetContext: targetContext,
      screens: screens
    });
  }

  function createReplicaSet(entries, options) {
    options = isPlainObject(options) ? options : {};
    denseArray(entries, '$entries');
    if (!entries.length) fail('REPLICA_SET_EMPTY', '复刻集至少需要一个独立参考计划。', '$entries');
    var scopes = Object.create(null);
    var plans = entries.map(function (entry, index) {
      if (!isPlainObject(entry)) fail('INVALID_REPLICA_SET_ENTRY', '复刻集条目必须是普通对象。', '$entries[' + index + ']');
      var plan = createReplicaPlan(entry.bundle, entry.target, Object.assign({}, entry.options || {}, {
        reuseMode: entry.reuseMode || entry.options && entry.options.reuseMode || options.reuseMode || 'multi_reference'
      }));
      var scopeKey = plan.referenceScopeId + '\u0000' + plan.skuScopeId;
      if (scopes[scopeKey]) fail('REPLICA_SCOPE_DUPLICATE', '同一参考 scope 与 SKU scope 不得重复登记。', '$entries[' + index + ']');
      scopes[scopeKey] = true;
      return plan;
    });
    return deepFreeze({
      schema: REPLICA_SET_SCHEMA,
      schemaVersion: 1,
      replicaSetId: hash(plans.map(function (plan) { return plan.replicaPlanId; }), 'rdreplicaset_'),
      plans: plans
    });
  }

  function deriveReplicaLifecycle(input) {
    input = isPlainObject(input) ? input : {};
    if ((input.schema === REPLICA_PLAN_SCHEMA || input.schema === REPLICA_PLAN_SCHEMA_V2) && Array.isArray(input.screens) && input.screens.length) return 'user_confirmed';
    var runtime = input.runtime;
    if (runtime && Array.isArray(runtime.tasks)) {
      var phases = runtime.tasks.map(function (task) { return task && task.phase || ''; });
      if (phases.some(function (phase) { return phase === 'prompting' || phase === 'generating'; })) return 'generating';
      if (phases.length && phases.every(function (phase) { return phase === 'completed'; })) return 'generated';
      if (phases.some(function (phase) { return phase === 'completed' || phase === 'partial'; }) &&
          phases.some(function (phase) { return phase === 'failed' || phase === 'partial' || phase === 'cancelled' || phase === 'interrupted'; })) return 'partial';
      if (phases.some(function (phase) { return phase === 'blocked' || phase === 'failed' || phase === 'stale'; })) return 'blocked';
    }
    var blueprint = input.currentBlueprint || input.blueprint;
    if (blueprint && blueprint.approvalStatus === 'approved') return 'user_confirmed';
    var working = input.workingBlueprint || input.working;
    if (working && Array.isArray(working.modules) && working.modules.length) {
      if (working.approvalStatus === 'approved') return 'user_confirmed';
      if (working.buildStatus === 'complete' || working.buildStatus === 'partial' || working.buildStatus === 'fallback') return 'draft';
      return 'analyzed';
    }
    if (input.segmented === true || (Array.isArray(input.chunks) && input.chunks.length)) return 'segmented';
    if (input.sourceSnapshot || input.source) return 'captured';
    return 'blocked';
  }

  function runtimeAssetMetadata(assets) {
    return (assets || []).map(function (asset) {
      return {
        assetId: asset.assetId,
        role: asset.role,
        rightsStatus: asset.rightsStatus,
        evidenceId: asset.evidenceId
      };
    });
  }

  function createInputFingerprint(bundleInput, targetInput, generationSettings) {
    var bundle = validateExecutionBundle(bundleInput);
    var target = normalizeDraftTarget(targetInput);
    if (bundle.claimMode === VISUAL_STRUCTURE_ONLY) {
      var checked = validateTarget(bundle, targetInput, 0);
      if (checked.errors.length) fail(checked.errors[0].code, checked.errors[0].message, checked.errors[0].path, { issues: checked.errors });
      target = checked.target;
      var safeV2Settings = safeGenerationSettings(generationSettings);
      return hash({
        claimMode: VISUAL_STRUCTURE_ONLY,
        bundleId: bundle.bundleId,
        confirmationFingerprint: bundle.confirmationFingerprint,
        blueprintId: bundle.currentBlueprint.blueprintId,
        blueprintRevision: bundle.currentBlueprint.revision,
        targetInputId: target.targetInputId,
        productName: target.productName,
        internalId: target.internalId,
        userInput: visualStructureUserInput(target),
        subjectAssets: targetAssetRecords(bundle, target.subjectAssetIds).map(function (asset) {
          return { assetId: asset.assetId, refDigest: completeTextDigest(asset.ref, 'rdassetref_'), role: asset.role, rightsStatus: asset.rightsStatus };
        }),
        modelAssets: targetAssetRecords(bundle, target.modelAssetIds).map(function (asset) {
          return { assetId: asset.assetId, refDigest: completeTextDigest(asset.ref, 'rdassetref_'), role: asset.role, rightsStatus: asset.rightsStatus };
        }),
        skuIds: target.skuIds,
        generationSettings: safeV2Settings
      }, 'rdinput2_');
    }
    var factRecord = bundle.factCardsById[target.productFactCardId];
    if (!factRecord) fail('UNVERIFIED_FACT_CARD', '目标事实卡不在 execution bundle。', '$target.productFactCardId');
    var allAssets = target.subjectAssetIds.concat(target.modelAssetIds);
    allAssets.forEach(function (assetId) {
      if (!bundle.assetsById[assetId]) fail('UNAUTHORIZED_TARGET_ASSET', '目标素材不在 execution bundle。', '$target.subjectAssetIds');
    });
    var safeSettings = safeGenerationSettings(generationSettings);
    return hash({
      bundleId: bundle.bundleId,
      confirmationFingerprint: bundle.confirmationFingerprint,
      blueprintId: bundle.currentBlueprint.blueprintId,
      blueprintRevision: bundle.currentBlueprint.revision,
      productName: target.productName,
      internalId: target.internalId,
      productFactCardId: target.productFactCardId,
      factsDigest: hash(factRecord.facts, 'rdfacts_'),
      subjectAssets: targetAssetRecords(bundle, target.subjectAssetIds).map(function (asset) {
        return { assetId: asset.assetId, refDigest: hash(asset.ref, 'rdassetref_'), role: asset.role, rightsStatus: asset.rightsStatus };
      }),
      modelAssets: targetAssetRecords(bundle, target.modelAssetIds).map(function (asset) {
        return { assetId: asset.assetId, refDigest: hash(asset.ref, 'rdassetref_'), role: asset.role, rightsStatus: asset.rightsStatus };
      }),
      skuIds: target.skuIds,
      audience: target.audience,
      language: target.language,
      sellingAngle: target.sellingAngle,
      generationSettings: safeSettings
    }, 'rdinput_');
  }

  function assertGenerationPayloadSafe(payload, bundleInput) {
    var bundle = validateExecutionBundle(bundleInput);
    var sourceAssetRefs = Object.create(null);
    var sourceAssetIds = Object.create(null);
    (bundle.sourceSnapshot.assets || []).forEach(function (asset) {
      if (asset && asset.assetId) sourceAssetIds[String(asset.assetId)] = true;
      if (asset && asset.url) sourceAssetRefs[String(asset.url)] = true;
    });
    function visit(value, path, keyName, seen) {
      if (value == null || typeof value === 'boolean' || typeof value === 'number') return;
      if (typeof value === 'string') {
        if (/^reference_only$/i.test(value)) fail('REFERENCE_ONLY_LEAK', '最终生成载荷含 reference_only 标记。', path);
        if (sourceAssetIds[value] || sourceAssetRefs[value]) fail('REFERENCE_ASSET_LEAK', '最终生成载荷含来源素材 ID 或原图引用。', path);
        return;
      }
      if (typeof value !== 'object') fail('NON_JSON_VALUE', '最终生成载荷只允许普通 JSON。', path);
      if (seen && seen.has(value)) fail('CYCLIC_REFERENCE', '最终生成载荷不得包含循环引用。', path);
      if (seen) seen.add(value);
      if (Array.isArray(value)) {
        denseArray(value, path);
        value.forEach(function (item, index) { visit(item, path + '[' + index + ']', '', seen); });
        return;
      }
      if (!isPlainObject(value)) fail('NON_JSON_VALUE', '最终生成载荷只允许普通对象。', path);
      Object.keys(value).forEach(function (key) {
        var normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
        var item = value[key];
        if (FORBIDDEN_GENERATION_KEYS[normalized]) fail('REFERENCE_CONTENT_LEAK', '最终生成载荷不得包含来源字段 ' + key + '。', path + '.' + key);
        if (normalized === 'referenceimage' && text(item, 100000)) fail('REFERENCE_IMAGE_LEAK', 'referenceImage 必须为空。', path + '.' + key);
        if ((normalized === 'referenceimages' || normalized === 'visualtemplateimages') && (!Array.isArray(item) || item.length)) {
          fail('REFERENCE_IMAGE_LEAK', key + ' 必须是空数组。', path + '.' + key);
        }
        visit(item, path + '.' + key, key, seen);
      });
    }
    visit(payload, '$payload', '', typeof WeakSet === 'function' ? new WeakSet() : null);
    return true;
  }

  function createVisualStructureGenerationProjection(bundle, targetInput, options) {
    var checked = validateTarget(bundle, targetInput, 0);
    if (checked.errors.length) fail(checked.errors[0].code, checked.errors[0].message, checked.errors[0].path, { issues: checked.errors });
    var target = checked.target;
    var replicaPlan = createVisualStructureReplicaPlan(bundle, target, options);
    var inputFingerprint = createInputFingerprint(bundle, target, options.generationSettings);
    var modules = bundle.currentBlueprint.modules.filter(function (module) { return module.selected; })
      .slice().sort(function (a, b) { return a.order - b.order || compareCodeUnits(a.moduleId, b.moduleId); })
      .map(function (module) {
        return {
          moduleId: module.moduleId,
          order: module.order,
          type: module.type,
          salesRole: module.salesRole,
          locked: module.locked === true,
          visualBrief: clone(module.visualBrief)
        };
      });
    var projection = {
      schema: PROJECTION_SCHEMA_V2,
      schemaVersion: 2,
      claimMode: VISUAL_STRUCTURE_ONLY,
      bundleId: bundle.bundleId,
      confirmationFingerprint: bundle.confirmationFingerprint,
      replicaPlanId: replicaPlan.replicaPlanId,
      reuseMode: replicaPlan.reuseMode,
      referenceScopeId: replicaPlan.referenceScopeId,
      skuScopeId: replicaPlan.skuScopeId,
      blueprintId: bundle.currentBlueprint.blueprintId,
      blueprintRevision: bundle.currentBlueprint.revision,
      draftTargetId: target.draftTargetId,
      targetInputId: target.targetInputId,
      taskKey: target.taskKey,
      inputFingerprint: inputFingerprint,
      screenCount: replicaPlan.screens.length,
      product: {
        productName: target.productName,
        internalId: target.internalId,
        userInput: visualStructureUserInput(target)
      },
      skuIds: target.skuIds.slice(),
      subjectAssets: targetAssetRecords(bundle, target.subjectAssetIds),
      modelAssets: targetAssetRecords(bundle, target.modelAssetIds),
      modules: modules,
      screens: replicaPlan.screens.map(function (screen) {
        return {
          screenIndex: screen.screenIndex,
          moduleId: screen.moduleId,
          moduleOrder: screen.moduleOrder,
          moduleType: screen.moduleType,
          locked: screen.locked,
          commercialRole: screen.commercialRole,
          visualBlueprint: clone(screen.visualBlueprint),
          targetDirection: screen.targetDirection,
          assetIds: screen.assetIds.slice(),
          safetyFlags: screen.safetyFlags.slice(),
          blueprintVersion: screen.blueprintVersion,
          generationVersion: screen.generationVersion
        };
      }),
      generationSettings: clone(safeGenerationSettings(options.generationSettings)),
      referenceImage: '',
      referenceImages: [],
      visualTemplateImages: []
    };
    assertGenerationPayloadSafe(projection, bundle);
    return deepFreeze(projection);
  }

  function createGenerationProjection(bundleInput, targetInput, options) {
    options = isPlainObject(options) ? options : {};
    var bundle = validateExecutionBundle(bundleInput);
    if (bundle.claimMode === VISUAL_STRUCTURE_ONLY) return createVisualStructureGenerationProjection(bundle, targetInput, options);
    var checked = validateTarget(bundle, targetInput, 0);
    if (checked.errors.length) fail(checked.errors[0].code, checked.errors[0].message, checked.errors[0].path, { issues: checked.errors });
    var target = checked.target;
    var replicaPlan = createReplicaPlan(bundle, target, options);
    var inputFingerprint = createInputFingerprint(bundle, target, options.generationSettings);
    var factRecord = bundle.factCardsById[target.productFactCardId];
    var factsByKey = Object.create(null);
    factRecord.facts.forEach(function (fact) { factsByKey[fact.factKey] = fact; });
    var modules = bundle.currentBlueprint.modules.filter(function (module) { return module.selected; })
      .slice().sort(function (a, b) { return a.order - b.order || compareCodeUnits(a.moduleId, b.moduleId); })
      .map(function (module) {
        return {
          moduleId: module.moduleId,
          order: module.order,
          type: module.type,
          salesRole: module.salesRole,
          locked: module.locked === true,
          copy: clone(module.editableCopy),
          visualBrief: clone(module.visualBrief),
          facts: module.factBindings.filter(function (binding) { return binding.required; }).map(function (binding) {
            var resolved = binding.targetField === '*' ? factRecord.facts : [factsByKey[binding.targetField]];
            return {
              bindingId: binding.bindingId,
              targetField: binding.targetField,
              required: true,
              values: resolved.filter(Boolean).map(function (fact) {
                return { factKey: fact.factKey, label: fact.label, value: fact.value };
              })
            };
          })
        };
      });
    var projection = {
      schema: PROJECTION_SCHEMA,
      schemaVersion: 1,
      bundleId: bundle.bundleId,
      confirmationFingerprint: bundle.confirmationFingerprint,
      replicaPlanId: replicaPlan.replicaPlanId,
      reuseMode: replicaPlan.reuseMode,
      referenceScopeId: replicaPlan.referenceScopeId,
      skuScopeId: replicaPlan.skuScopeId,
      blueprintId: bundle.currentBlueprint.blueprintId,
      blueprintRevision: bundle.currentBlueprint.revision,
      draftTargetId: target.draftTargetId,
      taskKey: target.taskKey,
      inputFingerprint: inputFingerprint,
      screenCount: replicaPlan.screens.length,
      product: {
        confirmationFingerprint: bundle.confirmationFingerprint,
        productName: target.productName,
        internalId: target.internalId,
        productFactCardId: target.productFactCardId,
        facts: clone(factRecord.facts),
        skuIds: target.skuIds.slice(),
        audience: target.audience,
        language: target.language,
        sellingAngle: target.sellingAngle
      },
      subjectAssets: targetAssetRecords(bundle, target.subjectAssetIds),
      modelAssets: targetAssetRecords(bundle, target.modelAssetIds),
      modules: modules,
      screens: replicaPlan.screens.map(function (screen) {
        return {
          screenIndex: screen.screenIndex,
          moduleId: screen.moduleId,
          moduleOrder: screen.moduleOrder,
          moduleType: screen.moduleType,
          locked: screen.locked,
          publishableCopy: clone(screen.publishableCopy),
          commercialRole: screen.commercialRole,
          visualBlueprint: clone(screen.visualBlueprint),
          targetDirection: screen.targetDirection,
          targetFacts: screen.targetFacts.map(function (fact) { return clone(fact); }),
          assetIds: screen.assetIds.slice(),
          safetyFlags: screen.safetyFlags.slice(),
          blueprintVersion: screen.blueprintVersion,
          generationVersion: screen.generationVersion
        };
      }),
      generationSettings: clone(safeGenerationSettings(options.generationSettings)),
      referenceImage: '',
      referenceImages: [],
      visualTemplateImages: []
    };
    assertGenerationPayloadSafe(projection, bundle);
    return deepFreeze(projection);
  }

  function logicalJobId(batchId, taskId, inputFingerprint, screenIndex) {
    return hash({ batchId: batchId, taskId: taskId, inputFingerprint: inputFingerprint, screenIndex: screenIndex }, 'rdjob_');
  }

  function requestJobId(logicalId, generation, attempt, stage) {
    return hash({ logicalJobId: logicalId, generation: generation, attempt: attempt, stage: stage || 'image' }, 'rdrequest_');
  }

  function createRuntime(batch, bundle, targets, projections, options) {
    options = isPlainObject(options) ? options : {};
    var visualStructureOnly = bundle.claimMode === VISUAL_STRUCTURE_ONLY;
    var createdAt = text(options.createdAt || batch.createdAt, 80);
    var byTaskKey = Object.create(null);
    targets.forEach(function (target) { byTaskKey[target.taskKey] = target; });
    var byDraftId = Object.create(null);
    projections.forEach(function (projection) { byDraftId[projection.draftTargetId] = projection; });
    var tasks = batch.tasks.map(function (contractTask) {
      var target = byTaskKey[contractTask.taskKey];
      var projection = byDraftId[target.draftTargetId];
      var generation = 1;
      var runtimeTask = {
        taskId: contractTask.taskId,
        taskKey: contractTask.taskKey,
        draftTargetId: target.draftTargetId,
        inputFingerprint: projection.inputFingerprint,
        generation: generation,
        phase: contractTask.status === 'blocked' ? 'blocked' : 'pending',
        target: visualStructureOnly ? {
          confirmationFingerprint: bundle.confirmationFingerprint,
          claimMode: VISUAL_STRUCTURE_ONLY,
          targetInputId: target.targetInputId,
          productName: target.productName,
          internalId: target.internalId,
          userInput: visualStructureUserInput(target),
          skuIds: target.skuIds.slice(),
          subjectAssets: runtimeAssetMetadata(projection.subjectAssets),
          modelAssets: runtimeAssetMetadata(projection.modelAssets)
        } : {
          confirmationFingerprint: bundle.confirmationFingerprint,
          productName: target.productName,
          internalId: target.internalId,
          productFactCardId: target.productFactCardId,
          skuIds: target.skuIds.slice(),
          audience: target.audience,
          language: target.language,
          sellingAngle: target.sellingAngle,
          facts: clone(projection.product.facts),
          subjectAssets: runtimeAssetMetadata(projection.subjectAssets),
          modelAssets: runtimeAssetMetadata(projection.modelAssets)
        },
        prompt: {
          logicalJobId: hash({ batchId: batch.batchId, taskId: contractTask.taskId, inputFingerprint: projection.inputFingerprint }, 'rdprompt_'),
          attempt: 0,
          generation: generation,
          requestJobId: '',
          status: 'pending',
          screenPrompts: [],
          negativePrompt: '',
          error: null
        },
        errors: clone(contractTask.errors || []),
        screens: Array.from({ length: batch.screenCount }, function (_, screenIndex) {
          return {
            screenIndex: screenIndex,
            screenNumber: screenIndex + 1,
            logicalJobId: logicalJobId(batch.batchId, contractTask.taskId, projection.inputFingerprint, screenIndex),
            attempt: 0,
            generation: generation,
            requestJobId: '',
            status: contractTask.status === 'blocked' ? 'cancelled' : 'pending',
            resultRef: null,
            artifactRef: '',
            error: null
          };
        })
      };
      if (visualStructureOnly) runtimeTask.targetInputId = target.targetInputId;
      return runtimeTask;
    });
    var runtime = {
      schema: visualStructureOnly ? RUNTIME_SCHEMA_V2 : RUNTIME_SCHEMA,
      schemaVersion: visualStructureOnly ? 2 : 1,
      batchId: batch.batchId,
      bundleId: bundle.bundleId,
      confirmationFingerprint: bundle.confirmationFingerprint,
      blueprintId: batch.blueprintId,
      blueprintRevision: batch.blueprintRevision,
      screenCount: batch.screenCount,
      settingsFingerprint: hash(safeGenerationSettings(options.generationSettings), 'rdsettings_'),
      generationSettings: clone(safeGenerationSettings(options.generationSettings)),
      createdAt: createdAt,
      updatedAt: createdAt,
      tasks: tasks
    };
    if (visualStructureOnly) runtime.claimMode = VISUAL_STRUCTURE_ONLY;
    return deepFreeze(runtime);
  }

  function createBatchContext(bundleInput, targetInputs, options) {
    options = isPlainObject(options) ? options : {};
    var bundle = validateExecutionBundle(bundleInput);
    var selectedModuleCount = bundle.currentBlueprint.modules.filter(function (module) { return module.selected; }).length;
    var screenCount = options.screenCount === undefined
      ? screenCountValue(selectedModuleCount, '$bundle.currentBlueprint.modules')
      : screenCountValue(options.screenCount, '$options.screenCount');
    if (screenCount !== selectedModuleCount) {
      fail('CONFIRMED_SCREEN_COUNT_MISMATCH', '生成屏数必须与已确认蓝图的选中模块数一致。', '$options.screenCount');
    }
    var targets = selectedTargets(bundle, targetInputs);
    var generationSettings = safeGenerationSettings(options.generationSettings);
    function replicaOptions(target) {
      var scoped = isPlainObject(options.targetScopes) && isPlainObject(options.targetScopes[target.draftTargetId])
        ? options.targetScopes[target.draftTargetId] : {};
      return Object.assign({}, scoped, {
        screenCount: screenCount,
        generationSettings: generationSettings,
        reuseMode: scoped.reuseMode || options.reuseMode || 'single_reference',
        referenceScopeId: scoped.referenceScopeId || options.referenceScopeId,
        skuScopeId: scoped.skuScopeId,
        skuScope: scoped.skuScope,
        screenAssetBindings: scoped.screenAssetBindings,
        generationVersion: 1
      });
    }
    var replicaPlans = targets.map(function (target) {
      return createReplicaPlan(bundle, target, replicaOptions(target));
    });
    var projections = targets.map(function (target) {
      return createGenerationProjection(bundle, target, replicaOptions(target));
    });
    var batchKey = options.batchKey ? assertSafeId(options.batchKey, '$options.batchKey', true) : hash({
      bundleId: bundle.bundleId,
      screenCount: screenCount,
      targetInputs: projections.map(function (projection) {
        return { draftTargetId: projection.draftTargetId, taskKey: projection.taskKey, inputFingerprint: projection.inputFingerprint };
      }),
      generationSettings: generationSettings
    }, 'rdbatchkey_');
    var contractOptions = {
      sourceSnapshot: bundle.sourceSnapshot,
      previousBlueprint: bundle.immediatePreviousBlueprint,
      verifiedTargetAssets: bundle.verifiedTargetAssets,
      screenCount: screenCount,
      batchKey: batchKey,
      createdAt: options.createdAt || bundle.currentBlueprint.updatedAt
    };
    if (bundle.claimMode !== VISUAL_STRUCTURE_ONLY) contractOptions.verifiedProductFactCards = bundle.verifiedProductFactCards;
    var contractTargets = toContractTargets(targets, bundle);
    var batch;
    try {
      batch = bundle.claimMode === VISUAL_STRUCTURE_ONLY
        ? CONTRACT.createVisualStructureBatchProject(bundle.currentBlueprint, contractTargets, contractOptions)
        : CONTRACT.createBatchProject(bundle.currentBlueprint, contractTargets, contractOptions);
    }
    catch (error) { fail(error.code || 'BATCH_CONTRACT_REJECTED', error.message || '合同拒绝批次。', error.path || '$batch'); }
    var runtime = createRuntime(batch, bundle, targets, projections, {
      createdAt: contractOptions.createdAt,
      generationSettings: generationSettings
    });
    return deepFreeze({
      batch: batch,
      runtime: runtime,
      projections: projections,
      replicaPlans: replicaPlans,
      bundleId: bundle.bundleId,
      confirmationFingerprint: bundle.confirmationFingerprint
    });
  }

  function runtimeClone(runtime) {
    var v1 = isPlainObject(runtime) && runtime.schema === RUNTIME_SCHEMA && Number(runtime.schemaVersion) === 1;
    var v2 = isPlainObject(runtime) && runtime.schema === RUNTIME_SCHEMA_V2 && Number(runtime.schemaVersion) === 2 && runtime.claimMode === VISUAL_STRUCTURE_ONLY;
    if ((!v1 && !v2) || !Array.isArray(runtime.tasks)) {
      fail('INVALID_RUNTIME', '批量运行时 sidecar 无效。', '$runtime');
    }
    assertDenseJsonContainers(runtime, '$runtime');
    return clone(runtime);
  }

  function findTask(runtime, taskId) {
    var index = runtime.tasks.findIndex(function (task) { return task.taskId === taskId; });
    if (index < 0) fail('UNKNOWN_TASK', 'taskId 不存在。', '$runtime.tasks');
    return { index: index, task: runtime.tasks[index] };
  }

  function timestamp(runtime, options) {
    return text(options && options.updatedAt || runtime.updatedAt, 80);
  }

  function beginPrompting(runtimeInput, taskId, options) {
    var runtime = runtimeClone(runtimeInput);
    var found = findTask(runtime, taskId);
    var task = found.task;
    if (task.phase === 'prompting' || task.phase === 'generating' || taskHasInFlight(task)) {
      fail('TASK_IN_FLIGHT', '当前目标仍有提词或生图请求在途，不能重复开始提词。', '$runtime.tasks[' + found.index + '].phase');
    }
    if (task.prompt.status === 'completed') fail('PROMPT_ALREADY_COMPLETED', '当前输入的提词已经完成，不得重复提词。', '$runtime.tasks[' + found.index + '].prompt.status');
    if (task.prompt.status === 'failed') fail('RETRY_REQUIRED', '提词失败后必须先执行失败重试。', '$runtime.tasks[' + found.index + '].prompt.status');
    if (['pending', 'interrupted'].indexOf(task.phase) < 0 || task.prompt.status !== 'pending') {
      fail('INVALID_TASK_TRANSITION', '当前任务状态不能开始提词。', '$runtime.tasks[' + found.index + '].phase');
    }
    task.prompt.attempt += 1;
    task.prompt.generation = task.generation;
    task.prompt.requestJobId = requestJobId(task.prompt.logicalJobId, task.generation, task.prompt.attempt, 'prompt');
    task.prompt.status = 'prompting';
    task.prompt.error = null;
    task.phase = 'prompting';
    runtime.updatedAt = timestamp(runtime, options);
    return deepFreeze({
      runtime: runtime,
      request: {
        batchId: runtime.batchId,
        taskId: task.taskId,
        confirmationFingerprint: runtime.confirmationFingerprint,
        inputFingerprint: task.inputFingerprint,
        logicalJobId: task.prompt.logicalJobId,
        requestJobId: task.prompt.requestJobId,
        generation: task.generation,
        attempt: task.prompt.attempt,
        stage: 'prompt'
      }
    });
  }

  function responseMatches(runtime, task, slot, response) {
    return response && response.batchId === runtime.batchId && response.taskId === task.taskId &&
      response.confirmationFingerprint === runtime.confirmationFingerprint &&
      response.inputFingerprint === task.inputFingerprint && response.logicalJobId === slot.logicalJobId &&
      response.requestJobId === slot.requestJobId && Number(response.generation) === Number(task.generation) &&
      Number(response.attempt) === Number(slot.attempt);
  }

  function normalizeError(input, fallbackCode, stage) {
    input = isPlainObject(input) ? input : {};
    var code = text(input.code || fallbackCode || 'GENERATION_FAILED', 80).replace(/[^A-Za-z0-9_.:-]/g, '_');
    if (!SAFE_ID.test(code)) code = fallbackCode || 'GENERATION_FAILED';
    return {
      code: code,
      stage: text(input.stage || stage || 'generation', 80).replace(/[^A-Za-z0-9_.:-]/g, '_') || 'generation',
      message: text(input.message || '生成失败。', 1000),
      retryable: input.retryable !== false
    };
  }

  function acceptPromptResponse(runtimeInput, response, options) {
    var runtime = runtimeClone(runtimeInput);
    var found;
    try { found = findTask(runtime, response && response.taskId); }
    catch (_) { return deepFreeze({ runtime: runtimeInput, accepted: false, reason: 'unknown_task' }); }
    var task = found.task;
    if (task.phase !== 'prompting' || task.prompt.status !== 'prompting' || !responseMatches(runtime, task, task.prompt, response)) {
      return deepFreeze({ runtime: runtimeInput, accepted: false, reason: 'stale_or_mismatched' });
    }
    if (response.ok === false) {
      task.prompt.status = 'failed';
      task.prompt.screenPrompts = [];
      task.prompt.negativePrompt = '';
      task.prompt.error = normalizeError(response.error, 'PROMPT_FAILED', 'prompt');
      task.errors.push(task.prompt.error);
      task.phase = 'failed';
    } else {
      if (Array.isArray(response.screenPrompts)) denseArray(response.screenPrompts, '$response.screenPrompts');
      var prompts = Array.isArray(response.screenPrompts) ? response.screenPrompts.map(function (prompt) { return text(prompt, 50000); }) : [];
      var negativePromptTypeSafe = response.negativePrompt == null || typeof response.negativePrompt === 'string';
      var negativePrompt = negativePromptTypeSafe ? text(response.negativePrompt, 50000) : '';
      var negativePromptUnsafe = !negativePromptTypeSafe || promptIntrinsicLeakReason(negativePrompt);
      if (prompts.length !== runtime.screenCount || prompts.some(function (prompt) { return !prompt; }) || negativePromptUnsafe) {
        task.prompt.status = 'failed';
        task.prompt.screenPrompts = [];
        task.prompt.negativePrompt = '';
        task.prompt.error = normalizeError(negativePromptUnsafe
          ? { code: 'PROMPT_UNSAFE_NEGATIVE', message: '负面提示词包含不安全来源引用或非法类型。', retryable: true }
          : { code: 'PROMPT_SCREEN_COUNT_MISMATCH', message: '提词结果必须与批次屏数一致。', retryable: true }, 'PROMPT_FAILED', 'prompt');
        task.errors.push(task.prompt.error);
        task.phase = 'failed';
      } else {
        task.prompt.status = 'completed';
        task.prompt.screenPrompts = prompts;
        task.prompt.negativePrompt = negativePrompt;
        task.prompt.error = null;
        task.phase = 'pending';
      }
    }
    runtime.updatedAt = timestamp(runtime, options);
    return deepFreeze({ runtime: runtime, accepted: true, reason: task.prompt.status });
  }

  function beginScreenAttempt(runtimeInput, taskId, screenIndex, options) {
    var runtime = runtimeClone(runtimeInput);
    var found = findTask(runtime, taskId);
    var task = found.task;
    screenIndex = Number(screenIndex);
    if (!Number.isSafeInteger(screenIndex) || screenIndex < 0 || screenIndex >= task.screens.length) fail('INVALID_SCREEN_INDEX', 'screenIndex 超出范围。', '$screenIndex');
    var screen = task.screens[screenIndex];
    if (task.prompt.status !== 'completed' && !(options && options.allowWithoutPrompt === true)) fail('PROMPT_REQUIRED', '必须先完成当前目标提词。', '$runtime.tasks[' + found.index + '].prompt');
    if (['blocked', 'completed', 'cancelled', 'stale'].indexOf(task.phase) >= 0 || ['completed', 'generating', 'cancelled', 'stale'].indexOf(screen.status) >= 0) {
      fail('INVALID_SCREEN_TRANSITION', '当前分屏状态不能开始生成。', '$runtime.tasks[' + found.index + '].screens[' + screenIndex + '].status');
    }
    screen.attempt += 1;
    screen.generation = task.generation;
    screen.requestJobId = requestJobId(screen.logicalJobId, task.generation, screen.attempt, 'image');
    screen.status = 'generating';
    screen.error = null;
    task.phase = 'generating';
    runtime.updatedAt = timestamp(runtime, options);
    return deepFreeze({
      runtime: runtime,
      request: {
        batchId: runtime.batchId,
        taskId: task.taskId,
        confirmationFingerprint: runtime.confirmationFingerprint,
        inputFingerprint: task.inputFingerprint,
        logicalJobId: screen.logicalJobId,
        requestJobId: screen.requestJobId,
        generation: task.generation,
        attempt: screen.attempt,
        screenIndex: screen.screenIndex,
        screenNumber: screen.screenNumber,
        stage: 'image'
      }
    });
  }

  function safeOpaqueRef(value, path) {
    value = assertSafeId(value, path, true);
    if (/^(?:https?|data|blob|file):/i.test(value)) fail('UNSAFE_RESULT_REF', '合同 resultRefs 只允许安全不透明 ID。', path);
    return value;
  }

  function createSafeResultRef(input) {
    input = isPlainObject(input) ? input : {};
    var batchId = assertSafeId(input.batchId, '$result.batchId', true);
    var taskId = assertSafeId(input.taskId, '$result.taskId', true);
    var inputFingerprint = assertSafeId(input.inputFingerprint, '$result.inputFingerprint', true);
    var generation = Number(input.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) fail('INVALID_GENERATION', '结果 generation 必须是正整数。', '$result.generation');
    var screenIndex = Number(input.screenIndex);
    if (!Number.isSafeInteger(screenIndex) || screenIndex < 0 || screenIndex > 15) fail('INVALID_SCREEN_INDEX', '结果屏序无效。', '$result.screenIndex');
    var kind = ['page', 'image', 'archive', 'manifest', 'unknown'].indexOf(input.kind) >= 0 ? input.kind : 'image';
    var binding = { batchId: batchId, taskId: taskId, screenIndex: screenIndex, generation: generation, inputFingerprint: inputFingerprint };
    var ref = safeOpaqueRef(input.ref || hash(Object.assign({ kind: kind }, binding), 'rdartifact_'), '$result.ref');
    var expectedResultId = hash(Object.assign({ kind: kind, ref: ref }, binding), 'rdresult_');
    if (input.resultId && safeOpaqueRef(input.resultId, '$result.resultId') !== expectedResultId) {
      fail('RESULT_ID_MISMATCH', 'resultId 未绑定当前 task/screen/generation/input。', '$result.resultId');
    }
    var resultId = expectedResultId;
    return deepFreeze({ resultId: resultId, kind: kind, ref: ref });
  }

  function verifyIssuedResultRef(input, binding, path) {
    path = path || '$resultRef';
    if (!isPlainObject(input)) fail('RESULT_REF_REQUIRED', '成功响应必须携带后台签发的完整 resultRef。', path);
    var keys = Object.keys(input).sort(compareCodeUnits);
    if (keys.length !== 3 || keys[0] !== 'kind' || keys[1] !== 'ref' || keys[2] !== 'resultId') {
      fail('RESULT_REF_INVALID', 'resultRef 只能且必须包含 resultId、kind、ref。', path);
    }
    ['resultId', 'kind', 'ref'].forEach(function (key) {
      var descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(input, key); } catch (_) { descriptor = null; }
      if (!descriptor || !hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || !descriptor.value) {
        fail('RESULT_REF_INVALID', 'resultRef.' + key + ' 必须是后台签发的非空字符串。', path + '.' + key);
      }
    });
    if (input.kind !== 'image') fail('RESULT_REF_INVALID', '分屏生图 resultRef.kind 必须为 image。', path + '.kind');
    var checked = createSafeResultRef(Object.assign({}, input, binding));
    if (checked.resultId !== input.resultId || checked.kind !== input.kind || checked.ref !== input.ref) {
      fail('RESULT_REF_INVALID', 'resultRef 与当前 task/screen/generation/input 绑定不一致。', path);
    }
    return checked;
  }

  function assertUniqueResultRef(runtime, candidate, taskId, screenIndex) {
    runtime.tasks.forEach(function (task) {
      task.screens.forEach(function (screen) {
        if (task.taskId === taskId && Number(screen.screenIndex) === Number(screenIndex)) return;
        if (!screen.resultRef) return;
        if (screen.resultRef.resultId === candidate.resultId) {
          fail('DUPLICATE_RESULT_ID', 'resultId 已被批次内其他目标或分屏占用。', '$runtime.tasks');
        }
        if (screen.resultRef.ref === candidate.ref) {
          fail('DUPLICATE_RESULT_REF', '结果不透明 ref 已被批次内其他目标或分屏占用。', '$runtime.tasks');
        }
      });
    });
  }

  function recomputeTaskPhase(task) {
    var statuses = task.screens.map(function (screen) { return screen.status; });
    if (statuses.every(function (status) { return status === 'completed'; })) return 'completed';
    if (statuses.indexOf('generating') >= 0) return 'generating';
    var completed = statuses.filter(function (status) { return status === 'completed'; }).length;
    var failed = statuses.filter(function (status) { return status === 'failed'; }).length;
    var pending = statuses.filter(function (status) { return status === 'pending'; }).length;
    if (failed && completed) return 'partial';
    if (pending) return 'generating';
    if (failed) return 'failed';
    return 'pending';
  }

  function getTaskProjection(context, taskId) {
    if (!context || !context.runtime || !Array.isArray(context.runtime.tasks) || !Array.isArray(context.projections)) {
      fail('INVALID_BATCH_CONTEXT', '批量上下文无效。', '$context');
    }
    denseArray(context.runtime.tasks, '$context.runtime.tasks');
    denseArray(context.projections, '$context.projections');
    var task = context.runtime.tasks.find(function (item) { return item.taskId === taskId; });
    if (!task) fail('UNKNOWN_TASK', 'taskId 不存在。', '$context.runtime.tasks');
    var projection = context.projections.find(function (item) { return item.draftTargetId === task.draftTargetId; });
    if (!projection) fail('PROJECTION_NOT_FOUND', '目标安全投影不存在。', '$context.projections');
    return projection;
  }

  function getTaskReplicaPlan(context, taskId) {
    if (!context || !Array.isArray(context.replicaPlans)) fail('REPLICA_PLAN_NOT_FOUND', '批量上下文缺少可追溯复刻计划。', '$context.replicaPlans');
    var projection = getTaskProjection(context, taskId);
    var runtimeTask = context.runtime.tasks.find(function (task) { return task.taskId === taskId; });
    var plan = context.replicaPlans.find(function (item) { return item.replicaPlanId === projection.replicaPlanId; });
    if (!plan || !runtimeTask) fail('REPLICA_PLAN_NOT_FOUND', '当前任务的复刻计划不存在。', '$context.replicaPlans');
    var output = clone(plan);
    output.screens.forEach(function (screen, index) {
      if (runtimeTask.screens[index]) screen.generationVersion = runtimeTask.screens[index].generation;
    });
    return deepFreeze(output);
  }

  function acceptScreenResponse(runtimeInput, response, options) {
    var runtime = runtimeClone(runtimeInput);
    var found;
    try { found = findTask(runtime, response && response.taskId); }
    catch (_) { return deepFreeze({ runtime: runtimeInput, accepted: false, reason: 'unknown_task' }); }
    var task = found.task;
    var screenIndex = Number(response && response.screenIndex);
    if (!Number.isSafeInteger(screenIndex) || !task.screens[screenIndex]) return deepFreeze({ runtime: runtimeInput, accepted: false, reason: 'unknown_screen' });
    var screen = task.screens[screenIndex];
    if (screen.status !== 'generating' || !responseMatches(runtime, task, screen, response)) {
      return deepFreeze({ runtime: runtimeInput, accepted: false, reason: 'stale_or_mismatched' });
    }
    if (response.ok === false) {
      screen.status = 'failed';
      screen.error = normalizeError(response.error, 'IMAGE_FAILED', 'image');
      task.errors.push(screen.error);
    } else {
      var resultRef = verifyIssuedResultRef(response.resultRef, {
        batchId: runtime.batchId,
        taskId: task.taskId,
        screenIndex: screenIndex,
        generation: screen.generation,
        inputFingerprint: task.inputFingerprint
      }, '$response.resultRef');
      assertUniqueResultRef(runtime, resultRef, task.taskId, screenIndex);
      screen.resultRef = resultRef;
      screen.artifactRef = text(response.artifactRef, 100000);
      screen.error = null;
      screen.status = 'completed';
    }
    task.phase = recomputeTaskPhase(task);
    runtime.updatedAt = timestamp(runtime, options);
    return deepFreeze({ runtime: runtime, accepted: true, reason: screen.status });
  }

  function activeRequestIds(task) {
    var ids = [];
    if (task.prompt.status === 'prompting' && task.prompt.requestJobId) ids.push(task.prompt.requestJobId);
    task.screens.forEach(function (screen) {
      if (screen.status === 'generating' && screen.requestJobId) ids.push(screen.requestJobId);
    });
    return ids;
  }

  function taskHasInFlight(task) {
    return task.prompt.status === 'prompting' || task.screens.some(function (screen) { return screen.status === 'generating'; });
  }

  function taskIsCancellable(task) {
    return ['pending', 'prompting', 'generating', 'interrupted'].indexOf(task.phase) >= 0;
  }

  function cancelTask(runtimeInput, taskId, options) {
    var runtime = runtimeClone(runtimeInput);
    var found = findTask(runtime, taskId);
    var task = found.task;
    if (!taskIsCancellable(task)) {
      return deepFreeze({ runtime: runtimeInput, cancelledRequestJobIds: [] });
    }
    var cancelledRequestJobIds = activeRequestIds(task);
    task.generation += 1;
    task.phase = 'cancelled';
    if (task.prompt.status === 'prompting' || task.prompt.status === 'pending') task.prompt.status = 'cancelled';
    task.screens.forEach(function (screen) {
      if (screen.status !== 'completed') screen.status = 'cancelled';
    });
    runtime.updatedAt = timestamp(runtime, options);
    return deepFreeze({ runtime: runtime, cancelledRequestJobIds: cancelledRequestJobIds });
  }

  function cancelAll(runtimeInput, options) {
    var runtime = runtimeClone(runtimeInput);
    var ids = [];
    runtime.tasks.slice().forEach(function (task) {
      if (!taskIsCancellable(task)) return;
      var cancelled = cancelTask(runtime, task.taskId, options);
      runtime = cancelled.runtime;
      ids = ids.concat(cancelled.cancelledRequestJobIds);
    });
    return deepFreeze({ runtime: runtime, cancelledRequestJobIds: Array.from(new Set(ids)) });
  }

  function restartTask(runtimeInput, taskId, options) {
    var runtime = runtimeClone(runtimeInput);
    var found = findTask(runtime, taskId);
    var task = found.task;
    if (taskHasInFlight(task)) {
      fail('TASK_IN_FLIGHT', '当前目标仍有请求在途，请先取消后再重启。', '$runtime.tasks[' + found.index + '].phase');
    }
    if (task.phase === 'blocked') fail('BLOCKED_TASK', '硬门禁任务不能在运行层重启。', '$runtime.tasks[' + found.index + '].phase');
    task.generation += 1;
    task.phase = 'pending';
    task.errors = [];
    task.prompt.attempt = 0;
    task.prompt.generation = task.generation;
    task.prompt.requestJobId = '';
    task.prompt.status = 'pending';
    task.prompt.screenPrompts = [];
    task.prompt.negativePrompt = '';
    task.prompt.error = null;
    task.screens.forEach(function (screen) {
      screen.attempt = 0;
      screen.generation = task.generation;
      screen.requestJobId = '';
      screen.status = 'pending';
      screen.resultRef = null;
      screen.artifactRef = '';
      screen.error = null;
    });
    runtime.updatedAt = timestamp(runtime, options);
    return deepFreeze(runtime);
  }

  function retryFailedScreens(runtimeInput, taskId, options) {
    var runtime = runtimeClone(runtimeInput);
    var found = findTask(runtime, taskId);
    var task = found.task;
    if (taskHasInFlight(task)) {
      fail('TASK_IN_FLIGHT', '当前目标仍有请求在途，不能并发重试。', '$runtime.tasks[' + found.index + '].phase');
    }
    var failed = task.screens.filter(function (screen) { return screen.status === 'failed'; });
    if (!failed.length && task.prompt.status !== 'failed') fail('NOTHING_TO_RETRY', '当前任务没有失败的 prompt 或分屏。', '$runtime.tasks[' + found.index + ']');
    task.generation += 1;
    task.errors = [];
    if (task.prompt.status === 'failed') {
      task.prompt.status = 'pending';
      task.prompt.requestJobId = '';
      task.prompt.error = null;
      task.prompt.screenPrompts = [];
      task.prompt.negativePrompt = '';
      task.screens.forEach(function (screen) {
        if (screen.status !== 'completed') {
          screen.status = 'pending';
          screen.requestJobId = '';
          screen.error = null;
        }
      });
    } else {
      failed.forEach(function (screen) {
        screen.status = 'pending';
        screen.generation = task.generation;
        screen.requestJobId = '';
        screen.error = null;
      });
    }
    task.phase = task.prompt.status === 'completed' && task.screens.some(function (screen) { return screen.status === 'completed'; })
      ? 'generating' : 'pending';
    runtime.updatedAt = timestamp(runtime, options);
    return deepFreeze(runtime);
  }

  function retryUnavailableScreens(runtimeInput, taskId, screenIndexes, options) {
    var runtime = runtimeClone(runtimeInput);
    var found = findTask(runtime, taskId);
    var task = found.task;
    if (taskHasInFlight(task)) fail('TASK_IN_FLIGHT', '当前目标仍有请求在途，不能重试缺失档案。', '$runtime.tasks[' + found.index + '].phase');
    denseArray(screenIndexes, '$screenIndexes');
    if (!screenIndexes.length) fail('NOTHING_TO_RETRY', '没有需要重试的缺失档案分屏。', '$screenIndexes');
    var selected = Object.create(null);
    screenIndexes.forEach(function (screenIndex, index) {
      if (typeof screenIndex !== 'number' || !Number.isSafeInteger(screenIndex) || screenIndex < 0 || screenIndex >= task.screens.length || selected[screenIndex]) {
        fail('INVALID_SCREEN_INDEX', '缺失档案分屏索引无效或重复。', '$screenIndexes[' + index + ']');
      }
      var screen = task.screens[screenIndex];
      if (screen.status !== 'completed' || !screen.resultRef) fail('RESULT_NOT_UNAVAILABLE', '只能重试原为 completed 且带 resultRef 的缺失档案分屏。', '$screenIndexes[' + index + ']');
      selected[screenIndex] = true;
    });
    task.generation += 1;
    task.errors = [];
    screenIndexes.forEach(function (screenIndex) {
      var screen = task.screens[screenIndex];
      screen.status = 'pending';
      screen.generation = task.generation;
      screen.requestJobId = '';
      screen.resultRef = null;
      screen.artifactRef = '';
      screen.error = null;
    });
    task.phase = 'generating';
    runtime.updatedAt = timestamp(runtime, options);
    return deepFreeze(runtime);
  }

  function positiveRuntimeInteger(value, path, allowZero) {
    value = Number(value);
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) fail('INVALID_RUNTIME', '运行时整数无效。', path);
    return value;
  }

  function runtimeContainsSensitiveKey(value, seen) {
    if (!value || typeof value !== 'object') return false;
    seen = seen || (typeof WeakSet === 'function' ? new WeakSet() : null);
    if (seen) {
      if (seen.has(value)) return true;
      seen.add(value);
    }
    if (Array.isArray(value)) return value.some(function (item) { return runtimeContainsSensitiveKey(item, seen); });
    return Object.keys(value).some(function (key) {
      return sensitiveSettingKey(key) || runtimeContainsSensitiveKey(value[key], seen);
    });
  }

  function runtimeForbiddenFieldPath(value, path, seen) {
    if (!value || typeof value !== 'object') return '';
    seen = seen || (typeof WeakSet === 'function' ? new WeakSet() : null);
    if (seen) {
      if (seen.has(value)) return path;
      seen.add(value);
    }
    if (Array.isArray(value)) {
      for (var index = 0; index < value.length; index++) {
        var arrayPath = runtimeForbiddenFieldPath(value[index], path + '[' + index + ']', seen);
        if (arrayPath) return arrayPath;
      }
      return '';
    }
    var keys = Object.keys(value);
    for (var keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      var key = keys[keyIndex];
      var normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (FORBIDDEN_GENERATION_KEYS[normalized] || normalized === 'referenceimage' || normalized === 'referenceimages' || normalized === 'visualtemplateimages') {
        return path + '.' + key;
      }
      var nested = runtimeForbiddenFieldPath(value[key], path + '.' + key, seen);
      if (nested) return nested;
    }
    return '';
  }

  function assertRuntimeAssetMetadata(value, path, expectedRole) {
    if (!Array.isArray(value)) fail('INVALID_RUNTIME', '运行时素材元数据必须是数组。', path);
    var seen = Object.create(null);
    value.forEach(function (asset, index) {
      var itemPath = path + '[' + index + ']';
      if (!isPlainObject(asset)) fail('INVALID_RUNTIME', '运行时素材元数据必须是普通对象。', itemPath);
      Object.keys(asset).forEach(function (key) {
        if (['assetId', 'role', 'rightsStatus', 'evidenceId'].indexOf(key) < 0) {
          fail('RUNTIME_ASSET_REF_FORBIDDEN', '持久化 runtime 不得包含素材 ref/url/data。', itemPath + '.' + key);
        }
      });
      var assetId = assertSafeId(asset.assetId, itemPath + '.assetId', true);
      if (seen[assetId]) fail('INVALID_RUNTIME', '运行时素材 ID 重复。', itemPath + '.assetId');
      seen[assetId] = true;
      assertSafeId(asset.evidenceId, itemPath + '.evidenceId', true);
      if (!AUTHORIZED_RIGHTS[asset.rightsStatus]) fail('RUNTIME_ASSET_REF_FORBIDDEN', '运行时只允许 authorized/self_owned 素材元数据。', itemPath + '.rightsStatus');
      if (!text(asset.role, 80)) fail('INVALID_RUNTIME', '运行时素材角色不能为空。', itemPath + '.role');
      if (expectedRole && asset.role !== expectedRole) fail('TARGET_ASSET_ROLE_MISMATCH', '运行时素材角色与 subject/model 槽位不一致。', itemPath + '.role');
    });
  }

  function promptIntrinsicLeakReason(value) {
    value = text(value, 50000);
    if (!value) return '';
    if (/(?:https?|data|blob|file):\/\//i.test(value) || /data:[^\s;,]+[;,]/i.test(value) || /reference_only/i.test(value)) return 'URL/data/reference_only';
    return '';
  }

  function promptLeakReason(value, bundle) {
    value = text(value, 50000);
    if (!value) return '';
    var intrinsicReason = promptIntrinsicLeakReason(value);
    if (intrinsicReason) return intrinsicReason;
    var sourceTokens = [];
    (bundle.sourceSnapshot.orderedBlocks || []).forEach(function (block) {
      [block && block.text, block && block.sourceSummary].forEach(function (item) {
        item = text(item, 12000);
        if (item.length >= 4) sourceTokens.push(item);
      });
    });
    (bundle.sourceSnapshot.assets || []).forEach(function (asset) {
      [asset && asset.assetId, asset && asset.url].forEach(function (item) {
        item = text(item, 4096);
        if (item) sourceTokens.push(item);
      });
    });
    for (var index = 0; index < sourceTokens.length; index++) {
      if (value.indexOf(sourceTokens[index]) >= 0) return 'source_content';
    }
    return '';
  }

  function validateSavedRuntimeShape(savedInput, bundle) {
    var visualStructureOnly = bundle.claimMode === VISUAL_STRUCTURE_ONLY;
    var expectedSchema = visualStructureOnly ? RUNTIME_SCHEMA_V2 : RUNTIME_SCHEMA;
    var expectedVersion = visualStructureOnly ? 2 : 1;
    if (!isPlainObject(savedInput) || savedInput.schema !== expectedSchema || Number(savedInput.schemaVersion) !== expectedVersion ||
        (visualStructureOnly && savedInput.claimMode !== VISUAL_STRUCTURE_ONLY) || !Array.isArray(savedInput.tasks)) {
      fail('INVALID_RUNTIME', '批量运行时 sidecar shape 无效。', '$runtime');
    }
    assertDenseJsonContainers(savedInput, '$runtime');
    var saved;
    try { saved = clone(savedInput); }
    catch (_) { fail('INVALID_RUNTIME', '批量运行时必须是无循环的普通 JSON。', '$runtime'); }
    var forbiddenPath = runtimeForbiddenFieldPath(saved, '$runtime');
    if (forbiddenPath) fail('RUNTIME_SOURCE_FIELD_FORBIDDEN', '持久化 runtime 含来源或参考图字段。', forbiddenPath);
    assertSafeId(saved.batchId, '$runtime.batchId', true);
    assertSafeId(saved.bundleId, '$runtime.bundleId', true);
    assertSafeId(saved.confirmationFingerprint, '$runtime.confirmationFingerprint', true);
    assertSafeId(saved.blueprintId, '$runtime.blueprintId', true);
    positiveRuntimeInteger(saved.blueprintRevision, '$runtime.blueprintRevision', false);
    var savedScreenCount = positiveRuntimeInteger(saved.screenCount, '$runtime.screenCount', false);
    if (savedScreenCount < 5 || savedScreenCount > 16) fail('INVALID_RUNTIME', '持久化 screenCount 必须在 5–16。', '$runtime.screenCount');
    assertSafeId(saved.settingsFingerprint, '$runtime.settingsFingerprint', true);
    if (!isPlainObject(saved.generationSettings) || runtimeContainsSensitiveKey(saved.generationSettings)) {
      fail('RUNTIME_SECRET_FORBIDDEN', '持久化生成设置包含敏感凭据字段。', '$runtime.generationSettings');
    }
    var safeSettings = safeGenerationSettings(saved.generationSettings);
    if (hash(safeSettings, 'rdsettings_') !== saved.settingsFingerprint || CONTRACT.stableSerialize(safeSettings) !== CONTRACT.stableSerialize(saved.generationSettings)) {
      fail('RUNTIME_SETTINGS_MISMATCH', '持久化生成设置未安全规范化或指纹不匹配。', '$runtime.generationSettings');
    }
    var taskIds = Object.create(null);
    var draftIds = Object.create(null);
    var targetInputIds = Object.create(null);
    var resultIds = Object.create(null);
    var resultRefs = Object.create(null);
    saved.tasks.forEach(function (task, taskIndex) {
      var taskPath = '$runtime.tasks[' + taskIndex + ']';
      if (!isPlainObject(task)) fail('INVALID_RUNTIME', '运行时任务必须是普通对象。', taskPath);
      ['taskId', 'taskKey', 'draftTargetId', 'inputFingerprint'].forEach(function (key) { assertSafeId(task[key], taskPath + '.' + key, true); });
      if (visualStructureOnly) assertSafeId(task.targetInputId, taskPath + '.targetInputId', true);
      if (taskIds[task.taskId] || draftIds[task.draftTargetId]) fail('RUNTIME_TASK_MAPPING_MISMATCH', '运行时任务身份或草稿身份重复。', taskPath);
      if (visualStructureOnly && targetInputIds[task.targetInputId]) fail('RUNTIME_TASK_MAPPING_MISMATCH', 'V2 targetInputId 重复。', taskPath + '.targetInputId');
      taskIds[task.taskId] = true;
      draftIds[task.draftTargetId] = true;
      if (visualStructureOnly) targetInputIds[task.targetInputId] = true;
      task.generation = positiveRuntimeInteger(task.generation, taskPath + '.generation', false);
      if (TASK_PHASES.indexOf(task.phase) < 0) fail('INVALID_RUNTIME_STATUS', '任务 phase 无效。', taskPath + '.phase');
      if (!isPlainObject(task.target)) fail('INVALID_RUNTIME', '运行时目标 sidecar 无效。', taskPath + '.target');
      var allowedTargetKeys = visualStructureOnly
        ? ['confirmationFingerprint', 'claimMode', 'targetInputId', 'productName', 'internalId', 'userInput', 'skuIds', 'subjectAssets', 'modelAssets']
        : ['confirmationFingerprint', 'productName', 'internalId', 'productFactCardId', 'skuIds', 'audience', 'language', 'sellingAngle', 'facts', 'subjectAssets', 'modelAssets'];
      Object.keys(task.target).forEach(function (key) {
        if (allowedTargetKeys.indexOf(key) < 0) {
          fail('RUNTIME_TARGET_MAPPING_MISMATCH', '运行时目标 sidecar 含未知或不可持久化字段。', taskPath + '.target.' + key);
        }
      });
      if (visualStructureOnly) {
        if (task.target.claimMode !== VISUAL_STRUCTURE_ONLY || task.target.targetInputId !== task.targetInputId) {
          fail('RUNTIME_TARGET_MAPPING_MISMATCH', 'V2 runtime targetInputId/claimMode 与任务不一致。', taskPath + '.target');
        }
        if (!isPlainObject(task.target.userInput) || runtimeContainsSensitiveKey(task.target.userInput)) {
          fail('RUNTIME_SECRET_FORBIDDEN', 'V2 userInput 必须是无敏感字段的普通 JSON。', taskPath + '.target.userInput');
        }
      }
      if (task.target.confirmationFingerprint !== saved.confirmationFingerprint) {
        fail('CONFIRMATION_FINGERPRINT_MISMATCH', '运行时目标的确认指纹与批次不一致。', taskPath + '.target.confirmationFingerprint');
      }
      assertRuntimeAssetMetadata(task.target.subjectAssets, taskPath + '.target.subjectAssets', visualStructureOnly ? 'subject' : '');
      assertRuntimeAssetMetadata(task.target.modelAssets, taskPath + '.target.modelAssets', visualStructureOnly ? 'model' : '');
      if (!Array.isArray(task.errors)) fail('INVALID_RUNTIME', '运行时任务 errors 必须是数组。', taskPath + '.errors');
      task.errors = task.errors.map(function (error, errorIndex) {
        var normalized = normalizeError(error, 'TASK_FAILED', 'generation');
        if (promptLeakReason(normalized.message, bundle)) fail('RUNTIME_ERROR_LEAK', '持久化错误信息含来源字段、URL 或 data URI。', taskPath + '.errors[' + errorIndex + '].message');
        return normalized;
      });
      if (!isPlainObject(task.prompt)) fail('INVALID_RUNTIME', '运行时 prompt shape 无效。', taskPath + '.prompt');
      assertSafeId(task.prompt.logicalJobId, taskPath + '.prompt.logicalJobId', true);
      task.prompt.attempt = positiveRuntimeInteger(task.prompt.attempt, taskPath + '.prompt.attempt', true);
      task.prompt.generation = positiveRuntimeInteger(task.prompt.generation, taskPath + '.prompt.generation', false);
      if (['pending', 'prompting', 'completed', 'failed', 'cancelled'].indexOf(task.prompt.status) < 0) fail('INVALID_RUNTIME_STATUS', 'prompt status 无效。', taskPath + '.prompt.status');
      task.prompt.requestJobId = assertSafeId(task.prompt.requestJobId, taskPath + '.prompt.requestJobId', false);
      if (task.prompt.status === 'prompting' && (!task.prompt.requestJobId || task.prompt.attempt < 1)) fail('INVALID_RUNTIME_STATUS', '在途 prompt 缺少 requestJobId/attempt。', taskPath + '.prompt');
      if (!Array.isArray(task.prompt.screenPrompts)) fail('INVALID_RUNTIME', 'screenPrompts 必须是数组。', taskPath + '.prompt.screenPrompts');
      task.prompt.screenPrompts = task.prompt.screenPrompts.map(function (prompt, index) {
        prompt = text(prompt, 50000);
        if (!prompt || promptLeakReason(prompt, bundle)) fail('RUNTIME_PROMPT_LEAK', '持久化 prompt 含来源字段、URL 或 data URI。', taskPath + '.prompt.screenPrompts[' + index + ']');
        return prompt;
      });
      if (!hasOwn(task.prompt, 'negativePrompt') || typeof task.prompt.negativePrompt !== 'string') {
        fail('INVALID_RUNTIME', '持久化 negativePrompt 必须是字符串。', taskPath + '.prompt.negativePrompt');
      }
      var normalizedNegativePrompt = text(task.prompt.negativePrompt, 50000);
      if (normalizedNegativePrompt !== task.prompt.negativePrompt) {
        fail('INVALID_RUNTIME', '持久化 negativePrompt 未安全规范化。', taskPath + '.prompt.negativePrompt');
      }
      if (promptLeakReason(normalizedNegativePrompt, bundle)) {
        fail('RUNTIME_PROMPT_LEAK', '持久化 negativePrompt 含来源字段、URL 或 data URI。', taskPath + '.prompt.negativePrompt');
      }
      task.prompt.negativePrompt = normalizedNegativePrompt;
      if (task.prompt.status === 'completed' && task.prompt.screenPrompts.length !== savedScreenCount) {
        fail('INVALID_RUNTIME_STATUS', 'completed prompt 必须完整覆盖全部分屏。', taskPath + '.prompt.screenPrompts');
      }
      if (task.prompt.status !== 'completed' && task.prompt.negativePrompt) {
        fail('INVALID_RUNTIME_STATUS', '未完成的 prompt 不得保留 negativePrompt。', taskPath + '.prompt.negativePrompt');
      }
      task.prompt.error = task.prompt.error ? normalizeError(task.prompt.error, 'PROMPT_FAILED', 'prompt') : null;
      if (task.prompt.error && promptLeakReason(task.prompt.error.message, bundle)) fail('RUNTIME_ERROR_LEAK', '持久化 prompt 错误含来源字段、URL 或 data URI。', taskPath + '.prompt.error.message');
      if (task.prompt.status === 'failed' && !task.prompt.error) fail('INVALID_RUNTIME_STATUS', 'failed prompt 必须包含错误。', taskPath + '.prompt.error');
      if (!Array.isArray(task.screens) || task.screens.length !== savedScreenCount) fail('INVALID_RUNTIME', '运行时 screens 数量与 screenCount 不一致。', taskPath + '.screens');
      var counts = { pending: 0, generating: 0, completed: 0, failed: 0, cancelled: 0, stale: 0 };
      task.screens.forEach(function (screen, screenIndex) {
        var screenPath = taskPath + '.screens[' + screenIndex + ']';
        if (!isPlainObject(screen) || Number(screen.screenIndex) !== screenIndex || Number(screen.screenNumber) !== screenIndex + 1) {
          fail('RUNTIME_SCREEN_MAPPING_MISMATCH', '分屏身份或顺序无效。', screenPath);
        }
        assertSafeId(screen.logicalJobId, screenPath + '.logicalJobId', true);
        screen.attempt = positiveRuntimeInteger(screen.attempt, screenPath + '.attempt', true);
        screen.generation = positiveRuntimeInteger(screen.generation, screenPath + '.generation', false);
        screen.requestJobId = assertSafeId(screen.requestJobId, screenPath + '.requestJobId', false);
        if (SCREEN_STATUSES.indexOf(screen.status) < 0) fail('INVALID_RUNTIME_STATUS', '分屏 status 无效。', screenPath + '.status');
        counts[screen.status] += 1;
        if (screen.status === 'generating' && (!screen.requestJobId || screen.attempt < 1)) fail('INVALID_RUNTIME_STATUS', '在途分屏缺少 requestJobId/attempt。', screenPath);
        if (screen.status === 'failed' && !screen.error) fail('INVALID_RUNTIME_STATUS', 'failed 分屏必须包含错误。', screenPath + '.error');
        screen.error = screen.error ? normalizeError(screen.error, 'IMAGE_FAILED', 'image') : null;
        if (screen.error && promptLeakReason(screen.error.message, bundle)) fail('RUNTIME_ERROR_LEAK', '持久化分屏错误含来源字段、URL 或 data URI。', screenPath + '.error.message');
        if (screen.status === 'completed') {
          if (!screen.resultRef) fail('INVALID_RUNTIME_STATUS', 'completed 分屏必须包含安全 resultRef。', screenPath + '.resultRef');
          screen.resultRef = verifyIssuedResultRef(screen.resultRef, {
            batchId: saved.batchId,
            taskId: task.taskId,
            screenIndex: screenIndex,
            generation: screen.generation,
            inputFingerprint: task.inputFingerprint
          }, screenPath + '.resultRef');
          if (resultIds[screen.resultRef.resultId] || resultRefs[screen.resultRef.ref]) {
            fail('DUPLICATE_RESULT_REF', '持久化结果在批次内跨任务或跨屏重复。', screenPath + '.resultRef');
          }
          resultIds[screen.resultRef.resultId] = true;
          resultRefs[screen.resultRef.ref] = true;
        } else if (screen.resultRef) {
          fail('INVALID_RUNTIME_STATUS', '非 completed 分屏不得携带 resultRef。', screenPath + '.resultRef');
        }
        screen.artifactRef = '';
      });
      if (task.phase === 'completed' && counts.completed !== savedScreenCount) fail('INVALID_RUNTIME_STATUS', 'completed 任务必须全部分屏完成。', taskPath + '.phase');
      if (task.phase === 'partial' && (!(counts.completed > 0 && counts.failed > 0) || counts.generating > 0)) fail('INVALID_RUNTIME_STATUS', 'partial 只允许无在途的成功与失败混合。', taskPath + '.phase');
      if (task.phase === 'failed' && ((task.prompt.status === 'failed' && counts.pending !== savedScreenCount) ||
          (task.prompt.status !== 'failed' && counts.failed !== savedScreenCount))) fail('INVALID_RUNTIME_STATUS', 'failed 任务必须为提词失败或全部分屏失败。', taskPath + '.phase');
      if (task.phase === 'prompting' && task.prompt.status !== 'prompting') fail('INVALID_RUNTIME_STATUS', 'prompting phase 与 prompt 状态不一致。', taskPath + '.phase');
      if (task.phase === 'generating' && (task.prompt.status !== 'completed' || (!counts.generating && !counts.pending))) fail('INVALID_RUNTIME_STATUS', 'generating phase 必须已有完整 prompt 和待处理/在途分屏。', taskPath + '.phase');
      if (task.phase === 'pending' && (counts.pending !== savedScreenCount || (task.prompt.status !== 'pending' && task.prompt.status !== 'completed'))) fail('INVALID_RUNTIME_STATUS', 'pending phase 与 prompt/分屏状态不一致。', taskPath + '.phase');
      if (task.phase === 'interrupted' && (counts.generating || task.prompt.status === 'prompting')) fail('INVALID_RUNTIME_STATUS', 'interrupted 任务不得保留在途状态。', taskPath + '.phase');
      if (task.phase === 'blocked' && counts.cancelled !== savedScreenCount) fail('INVALID_RUNTIME_STATUS', 'blocked 任务必须禁用全部分屏。', taskPath + '.phase');
      if (task.phase === 'stale' && counts.stale !== savedScreenCount) fail('INVALID_RUNTIME_STATUS', 'stale 任务必须标记全部分屏失效。', taskPath + '.phase');
      if (task.phase === 'cancelled' && (counts.pending || counts.generating)) fail('INVALID_RUNTIME_STATUS', 'cancelled 任务不得保留 pending/generating 分屏。', taskPath + '.phase');
    });
    return saved;
  }

  function restoreRuntime(savedInput, bundleInput, targetInputs, options) {
    options = isPlainObject(options) ? options : {};
    var bundle = validateExecutionBundle(bundleInput);
    var fresh = createBatchContext(bundle, targetInputs, options);
    if (savedInput == null) return fresh;
    var savedRuntime = validateSavedRuntimeShape(savedInput, bundle);
    var runtime = clone(fresh.runtime);
    var savedByDraft = Object.create(null);
    savedRuntime.tasks.forEach(function (task) { savedByDraft[task.draftTargetId] = task; });
    runtime.tasks.forEach(function (task, taskIndex) {
      var saved = savedByDraft[task.draftTargetId];
      if (!saved) return;
      var sameBatch = savedRuntime.batchId === runtime.batchId && savedRuntime.bundleId === runtime.bundleId &&
        savedRuntime.confirmationFingerprint === runtime.confirmationFingerprint &&
        Number(savedRuntime.screenCount) === Number(runtime.screenCount);
      if (sameBatch && saved.taskId !== task.taskId) {
        fail('RUNTIME_TASK_MAPPING_MISMATCH', '相同批次中的 taskId 映射被篡改。', '$runtime.tasks[' + taskIndex + '].taskId');
      }
      if (!sameBatch || saved.taskId !== task.taskId || saved.inputFingerprint !== task.inputFingerprint) {
        task.phase = 'stale';
        task.errors = [{ code: 'INPUT_STALE', stage: 'restore', message: '蓝图 revision、事实、素材、屏数或生成设置已变化，旧结果不可复用。', retryable: false }];
        task.screens.forEach(function (screen) { screen.status = 'stale'; });
        return;
      }
      if (saved.prompt.logicalJobId !== task.prompt.logicalJobId || saved.screens.some(function (screen, index) {
        return screen.logicalJobId !== task.screens[index].logicalJobId;
      })) {
        fail('RUNTIME_JOB_MAPPING_MISMATCH', '相同输入的 prompt/screen logicalJobId 映射被篡改。', '$runtime.tasks[' + taskIndex + ']');
      }
      if (CONTRACT.stableSerialize(saved.target) !== CONTRACT.stableSerialize(task.target)) {
        fail('RUNTIME_TARGET_MAPPING_MISMATCH', '相同输入的目标事实或素材元数据映射被篡改。', '$runtime.tasks[' + taskIndex + '].target');
      }
      task.generation = saved.generation;
      task.errors = clone(saved.errors);
      task.prompt = clone(saved.prompt);
      saved.screens.forEach(function (oldScreen, index) {
        task.screens[index] = clone(oldScreen);
        task.screens[index].artifactRef = '';
      });
      if (saved.phase === 'prompting' || saved.phase === 'generating') {
        task.generation += 1;
        task.phase = 'interrupted';
        if (task.prompt.status === 'prompting') {
          task.prompt.status = 'pending';
          task.prompt.generation = task.generation;
          task.prompt.requestJobId = '';
        }
        task.screens.forEach(function (screen) {
          if (screen.status === 'generating') {
            screen.status = 'pending';
            screen.generation = task.generation;
            screen.requestJobId = '';
          }
        });
      } else {
        task.phase = saved.phase;
      }
    });
    runtime.updatedAt = text(options.updatedAt || savedRuntime.updatedAt || runtime.updatedAt, 80);
    return deepFreeze({
      batch: fresh.batch,
      runtime: runtime,
      projections: fresh.projections,
      replicaPlans: fresh.replicaPlans,
      bundleId: fresh.bundleId,
      confirmationFingerprint: bundle.confirmationFingerprint
    });
  }

  function toContractTaskUpdate(runtimeInput, taskId) {
    var runtime = runtimeClone(runtimeInput);
    var seenResultIds = Object.create(null);
    var seenResultRefs = Object.create(null);
    runtime.tasks.forEach(function (runtimeTask, taskIndex) {
      runtimeTask.screens.forEach(function (screen, screenIndex) {
        if (screen.status === 'completed') {
          if (!screen.resultRef) fail('INVALID_RUNTIME_STATUS', 'completed 分屏缺少 resultRef。', '$runtime.tasks[' + taskIndex + '].screens[' + screenIndex + '].resultRef');
          var checked = verifyIssuedResultRef(screen.resultRef, {
            batchId: runtime.batchId,
            taskId: runtimeTask.taskId,
            screenIndex: screenIndex,
            generation: screen.generation,
            inputFingerprint: runtimeTask.inputFingerprint
          }, '$runtime.tasks[' + taskIndex + '].screens[' + screenIndex + '].resultRef');
          if (seenResultIds[checked.resultId] || seenResultRefs[checked.ref]) fail('DUPLICATE_RESULT_REF', '批次 resultId/ref 跨任务或跨屏重复。', '$runtime.tasks[' + taskIndex + '].screens[' + screenIndex + '].resultRef');
          seenResultIds[checked.resultId] = true;
          seenResultRefs[checked.ref] = true;
        } else if (screen.resultRef) {
          fail('INVALID_RUNTIME_STATUS', '非 completed 分屏不得携带 resultRef。', '$runtime.tasks[' + taskIndex + '].screens[' + screenIndex + '].resultRef');
        }
      });
    });
    var task = findTask(runtime, taskId).task;
    var status = 'pending';
    if (task.phase === 'prompting' || task.phase === 'generating') status = 'running';
    else if (task.phase === 'completed') status = 'completed';
    else if (task.phase === 'cancelled') status = 'cancelled';
    else if (task.phase === 'blocked') status = 'blocked';
    else if (task.phase === 'failed' || task.phase === 'partial' || task.phase === 'interrupted' || task.phase === 'stale') status = 'failed';
    var errors = clone(task.errors || []);
    if ((status === 'failed' || status === 'blocked') && !errors.length) {
      errors.push(normalizeError({
        code: task.phase === 'partial' ? 'PARTIAL_FAILURE' : task.phase === 'stale' ? 'INPUT_STALE' : 'TASK_FAILED',
        stage: task.phase === 'stale' ? 'restore' : 'generation',
        message: task.phase === 'partial' ? '部分分屏生成失败。' : task.phase === 'stale' ? '旧输入已失效。' : '任务未完成。',
        retryable: task.phase !== 'stale'
      }));
    }
    var resultRefs = task.screens.filter(function (screen) { return screen.status === 'completed' && screen.resultRef; })
      .sort(function (a, b) { return a.screenIndex - b.screenIndex; })
      .map(function (screen) { return clone(screen.resultRef); });
    return deepFreeze({ taskId: task.taskId, status: status, errors: errors, resultRefs: resultRefs });
  }

  function syncContractBatch(batchInput, runtimeInput, bundleInput, options) {
    options = isPlainObject(options) ? options : {};
    var bundle = validateExecutionBundle(bundleInput);
    var runtime = runtimeClone(runtimeInput);
    var updates = runtime.tasks.map(function (task) { return toContractTaskUpdate(runtime, task.taskId); });
    try {
      var contractOptions = {
        sourceSnapshot: bundle.sourceSnapshot,
        previousBlueprint: bundle.immediatePreviousBlueprint,
        verifiedTargetAssets: bundle.verifiedTargetAssets,
        updatedAt: options.updatedAt || batchInput.updatedAt
      };
      if (bundle.claimMode !== VISUAL_STRUCTURE_ONLY) contractOptions.verifiedProductFactCards = bundle.verifiedProductFactCards;
      return bundle.claimMode === VISUAL_STRUCTURE_ONLY
        ? CONTRACT.updateVisualStructureBatchProject(batchInput, { taskUpdates: updates }, bundle.currentBlueprint, contractOptions)
        : CONTRACT.updateBatchProject(batchInput, { taskUpdates: updates }, bundle.currentBlueprint, contractOptions);
    } catch (error) {
      fail(error.code || 'BATCH_CONTRACT_REJECTED', error.message || '合同批次同步失败。', error.path || '$batch');
    }
  }

  return deepFreeze({
    EXECUTION_SCHEMA: EXECUTION_SCHEMA,
    EXECUTION_SCHEMA_V2: EXECUTION_SCHEMA_V2,
    RUNTIME_SCHEMA: RUNTIME_SCHEMA,
    RUNTIME_SCHEMA_V2: RUNTIME_SCHEMA_V2,
    PROJECTION_SCHEMA: PROJECTION_SCHEMA,
    PROJECTION_SCHEMA_V2: PROJECTION_SCHEMA_V2,
    REPLICA_PLAN_SCHEMA: REPLICA_PLAN_SCHEMA,
    REPLICA_PLAN_SCHEMA_V2: REPLICA_PLAN_SCHEMA_V2,
    VISUAL_STRUCTURE_ONLY: VISUAL_STRUCTURE_ONLY,
    REPLICA_SET_SCHEMA: REPLICA_SET_SCHEMA,
    REUSE_MODES: REUSE_MODES,
    REPLICA_LIFECYCLE_STATES: REPLICA_LIFECYCLE_STATES,
    REPLICA_FEATURES: REPLICA_FEATURES,
    TASK_PHASES: TASK_PHASES,
    BatchError: BatchError,
    safeGenerationSettings: safeGenerationSettings,
    normalizeDraftTarget: normalizeDraftTarget,
    duplicateDraftTarget: duplicateDraftTarget,
    toContractTargets: toContractTargets,
    validateExecutionBundle: validateExecutionBundle,
    createConfirmationFingerprint: createConfirmationFingerprint,
    createInputFingerprint: createInputFingerprint,
    createReplicaPlan: createReplicaPlan,
    createReplicaSet: createReplicaSet,
    deriveReplicaLifecycle: deriveReplicaLifecycle,
    createGenerationProjection: createGenerationProjection,
    getTaskProjection: getTaskProjection,
    getTaskReplicaPlan: getTaskReplicaPlan,
    assertGenerationPayloadSafe: assertGenerationPayloadSafe,
    createBatchContext: createBatchContext,
    beginPrompting: beginPrompting,
    acceptPromptResponse: acceptPromptResponse,
    beginScreenAttempt: beginScreenAttempt,
    acceptScreenResponse: acceptScreenResponse,
    createSafeResultRef: createSafeResultRef,
    cancelTask: cancelTask,
    cancelAll: cancelAll,
    restartTask: restartTask,
    retryFailedScreens: retryFailedScreens,
    retryUnavailableScreens: retryUnavailableScreens,
    restoreRuntime: restoreRuntime,
    toContractTaskUpdate: toContractTaskUpdate,
    syncContractBatch: syncContractBatch
  });
});
