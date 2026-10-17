/* reference-detail-contract.js — “参考成详”V1 领域合同与无副作用纯函数 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SZ_REFERENCE_DETAIL_CONTRACT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SOURCE_SCHEMA = 'REFERENCE_DETAIL_SOURCE_V1';
  var BLUEPRINT_SCHEMA = 'REFERENCE_DETAIL_BLUEPRINT_V1';
  var BATCH_SCHEMA = 'REFERENCE_DETAIL_BATCH_V1';
  var SCHEMA_VERSION = 1;
  var VISUAL_STRUCTURE_BLUEPRINT_SCHEMA = 'REFERENCE_DETAIL_BLUEPRINT_V2';
  var VISUAL_STRUCTURE_BATCH_SCHEMA = 'REFERENCE_DETAIL_BATCH_V2';
  var VISUAL_STRUCTURE_SCHEMA_VERSION = 2;
  var VISUAL_STRUCTURE_ONLY = 'visual_structure_only';

  var COMPLETENESS_STATUSES = Object.freeze(['complete', 'partial', 'unknown', 'blocked']);
  var SOURCE_MODES = Object.freeze(['pasted_url', 'current_page']);
  var SALES_ROLES = Object.freeze([
    'hero', 'pain', 'benefit', 'feature', 'scene', 'detail', 'comparison', 'proof',
    'spec', 'size', 'usage', 'faq', 'service', 'cta', 'unknown'
  ]);
  var BLOCK_TYPES = Object.freeze(['image', 'text', 'image_text', 'video', 'table', 'divider', 'mixed', 'unknown']);
  var ASSET_ROLES = Object.freeze([
    'main', 'hero', 'product', 'subject', 'detail', 'option', 'sku', 'scene', 'model',
    'logo', 'badge', 'icon', 'background', 'decoration', 'comparison', 'proof', 'spec',
    'size', 'service', 'video', 'video_poster', 'unknown'
  ]);
  var RIGHTS_STATUSES = Object.freeze(['reference_only', 'authorized', 'self_owned', 'unknown', 'blocked']);
  var BLUEPRINT_APPROVAL_STATUSES = Object.freeze(['draft', 'in_review', 'approved', 'rejected']);
  var MODULE_DERIVATION_KINDS = Object.freeze(['source', 'duplicate', 'merge', 'split']);
  var BATCH_STATUSES = Object.freeze(['ready', 'running', 'partial', 'completed', 'failed', 'blocked', 'cancelled']);
  var TASK_STATUSES = Object.freeze(['pending', 'running', 'completed', 'failed', 'blocked', 'cancelled']);
  var EVIDENCE_KINDS = Object.freeze(['dom', 'json', 'network', 'metadata', 'user', 'unknown']);
  var RESULT_KINDS = Object.freeze(['page', 'image', 'archive', 'manifest', 'unknown']);
  var DETAIL_IMAGE_BLOCK_TYPES = Object.freeze({ image: true, image_text: true, mixed: true });
  var DETAIL_RANGE_PATH_PREFIX = 'detail-range:graphic-detail-to-shop-recommend:';
  var DETAIL_IMAGE_ASSET_ROLE_DENY = Object.freeze({
    main: true, option: true, sku: true, logo: true, badge: true, icon: true,
    video: true, video_poster: true
  });

  var DEFAULT_LIMITS = Object.freeze({
    maxDepth: 16,
    maxNodes: 50000,
    maxObjectKeys: 1000,
    maxJsonArrayLength: 2000,
    maxTextLength: 12000,
    maxShortTextLength: 1000,
    maxUrlLength: 4096,
    maxFacts: 2000,
    maxBlocks: 5000,
    maxAssets: 10000,
    maxEvidence: 5000,
    maxWarnings: 500,
    maxRefsPerBlock: 500,
    maxCopyBullets: 100,
    maxRiskFlags: 100,
    maxBatchTasks: 1000,
    maxSubjectAssetsPerTask: 100,
    maxSkuIdsPerTask: 2000,
    maxErrorsPerTask: 100,
    maxResultsPerTask: 500
  });
  var HARD_LIMITS = Object.freeze({
    maxDepth: 32,
    maxNodes: 100000,
    maxObjectKeys: 5000,
    maxJsonArrayLength: 10000,
    maxTextLength: 100000,
    maxShortTextLength: 10000,
    maxUrlLength: 8192,
    maxFacts: 10000,
    maxBlocks: 20000,
    maxAssets: 30000,
    maxEvidence: 20000,
    maxWarnings: 2000,
    maxRefsPerBlock: 5000,
    maxCopyBullets: 500,
    maxRiskFlags: 500,
    maxBatchTasks: 5000,
    maxSubjectAssetsPerTask: 1000,
    maxSkuIdsPerTask: 10000,
    maxErrorsPerTask: 1000,
    maxResultsPerTask: 5000
  });

  var DEFAULT_URL_POLICY = deepFreeze({
    sourceRules: [
      { platform: 'taobao', host: 'item.taobao.com', paths: ['/item.htm'], itemIdParam: 'id' },
      { platform: 'tmall', host: 'detail.tmall.com', paths: ['/item.htm'], itemIdParam: 'id' },
      { platform: 'tmall', host: 'chaoshi.detail.tmall.com', paths: ['/item.htm'], itemIdParam: 'id' },
      { platform: 'tmall', host: 'detail.tmall.hk', paths: ['/item.htm', '/hk/item.htm'], itemIdParam: 'id' }
    ],
    assetHostRules: [
      { host: 'alicdn.com', includeSubdomains: true },
      { host: 'alicdn.cn', includeSubdomains: true },
      { host: 'taobaocdn.com', includeSubdomains: true },
      { host: 'tbcdn.cn', includeSubdomains: true },
      { host: 'tmallcdn.com', includeSubdomains: true }
    ]
  });

  var DANGEROUS_KEYS = Object.freeze({ '__proto__': true, prototype: true, constructor: true });
  var SENSITIVE_KEYS = Object.freeze({
    cookie: true, cookies: true, setcookie: true, token: true, accesstoken: true,
    refreshtoken: true, authorization: true, proxyauthorization: true, apikey: true,
    secret: true, password: true, credential: true, credentials: true, headers: true,
    requestheaders: true, responseheaders: true, sessionid: true
  });
  var SENSITIVE_URL_QUERY_KEYS = Object.freeze({
    sign: true, signature: true, x5sec: true, expires: true, policy: true,
    credential: true, securitytoken: true, accesskeyid: true, keypairid: true,
    algorithm: true, signedheaders: true, auth: true, authkey: true, authtoken: true,
    ossaccesskeyid: true, xosscredential: true, xosssecuritytoken: true, xosssignature: true,
    xamzcredential: true, xamzsecuritytoken: true, xamzsignature: true,
    xamzexpires: true, xamzalgorithm: true, xamzsignedheaders: true
  });
  var SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
  var SAFE_PLATFORM = /^[a-z][a-z0-9_-]{1,31}$/;
  var SAFE_RISK_FLAG = /^[A-Z][A-Z0-9_]{1,79}$/;
  var RIGHTS_RESTRICTIVENESS = Object.freeze({ self_owned: 0, authorized: 1, reference_only: 2, unknown: 3, blocked: 4 });

  function ContractError(code, message, path) {
    this.name = 'ReferenceDetailContractError';
    this.code = code || 'CONTRACT_ERROR';
    this.message = message || '参考成详合同错误';
    this.path = path || '$';
    if (Error.captureStackTrace) Error.captureStackTrace(this, ContractError);
  }
  ContractError.prototype = Object.create(Error.prototype);
  ContractError.prototype.constructor = ContractError;

  function fail(code, message, path) {
    throw new ContractError(code, message, path);
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    try {
      var proto = Object.getPrototypeOf(value);
      return proto === Object.prototype || proto === null;
    } catch (_) {
      return false;
    }
  }

  function isCrossRealmPlainObject(value) {
    if (isPlainObject(value)) return true;
    try {
      var proto = Object.getPrototypeOf(value);
      return Object.prototype.toString.call(value) === '[object Object]' && !!proto && Object.getPrototypeOf(proto) === null;
    } catch (_) {
      return false;
    }
  }

  function ownDescriptor(object, key) {
    if (!object || typeof object !== 'object') return null;
    try {
      if (!Object.prototype.hasOwnProperty.call(object, key)) return null;
      return Object.getOwnPropertyDescriptor(object, key) || null;
    } catch (_) {
      return null;
    }
  }

  function ownValue(object, key, context, path) {
    var descriptor = ownDescriptor(object, key);
    if (!descriptor) return undefined;
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      if (context) addIssue(context, 'NON_JSON_ACCESSOR_DROPPED', '访问器字段不属于普通 JSON，已忽略。', path || '$', 'warning');
      return undefined;
    }
    return descriptor.value;
  }

  function normalizedUrlComponent(value) {
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

  function normalizedSensitiveKey(key) {
    var normalizedComponent = normalizedUrlComponent(key);
    if (normalizedComponent.unsafe) return '__unsafe_url_component__';
    return normalizedComponent.value.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function isSensitiveKey(key) {
    return !!SENSITIVE_KEYS[normalizedSensitiveKey(key)];
  }

  function isSensitiveUrlQueryKey(key) {
    var normalized = normalizedSensitiveKey(key);
    if (!normalized) return false;
    if (normalized === '__unsafe_url_component__') return true;
    if (SENSITIVE_KEYS[normalized] || SENSITIVE_URL_QUERY_KEYS[normalized]) return true;
    if (normalized === 'sig' || /^auth(?:key|token|signature|credential)?$/.test(normalized)) return true;
    if (/(?:token|secret|credential|signature|accesskeyid|accesskey|accessid|apikey|authkey|securitytoken|secretkey|consumerkey|signedheaders|password|passwd|sessionid|sessionkey|jwt)$/.test(normalized)) return true;
    if (/^(?:expires|policy|x5sec)$/.test(normalized)) return true;
    var signingMatch = normalized.match(/^(xoss|xamz|oss|amz)(sign|signature|credential|securitytoken|accesskeyid|expires|policy|algorithm|signedheaders)$/);
    return !!signingMatch;
  }

  function hasSensitiveUrlQuery(parsed) {
    return Array.from(parsed.searchParams.entries()).some(function (entry) {
      if (isSensitiveUrlQueryKey(entry[0])) return true;
      var normalizedValue = normalizedUrlComponent(entry[1]);
      if (normalizedValue.unsafe || /\b(?:bearer|basic)\s+\S+/i.test(normalizedValue.value) ||
          /["']?(?:authorization|cookie|tokens?|api[-_ ]?key|access[-_ ]?key|secret|password|credential)["']?\s*[:=]/i.test(normalizedValue.value) ||
          /\bAKIA[0-9A-Z]{12,}\b/.test(normalizedValue.value) ||
          /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(normalizedValue.value)) return true;
      var embedded = normalizedValue.value.split(/[&;]/);
      return embedded.some(function (part) {
        var equalsAt = part.indexOf('=');
        return equalsAt > 0 && isSensitiveUrlQueryKey(part.slice(0, equalsAt).trim());
      });
    });
  }

  function cleanNumber(value, fallback) {
    if (value == null || value === '') return fallback;
    var number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
  }

  function compareCodeUnits(first, second) {
    first = String(first);
    second = String(second);
    return first < second ? -1 : (first > second ? 1 : 0);
  }

  function screenCountValue(value, path) {
    if (value === undefined) return 10;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 5 || value > 16) {
      fail('INVALID_SCREEN_COUNT', '参考成详输出屏数必须是 5–16 的整数 number。', path);
    }
    return value;
  }

  function normalizedLimits(options) {
    var source = isPlainObject(options) && isPlainObject(ownValue(options, 'limits')) ? ownValue(options, 'limits') : options;
    source = isPlainObject(source) ? source : {};
    var output = {};
    Object.keys(DEFAULT_LIMITS).forEach(function (key) {
      var requested = cleanNumber(ownValue(source, key), null);
      var value = requested == null ? DEFAULT_LIMITS[key] : requested;
      output[key] = Math.max(1, Math.min(value, HARD_LIMITS[key]));
    });
    return output;
  }

  function createContext(options) {
    return {
      limits: normalizedLimits(options),
      issues: [],
      issueKeys: Object.create(null),
      nodes: 0,
      seen: typeof WeakSet === 'function' ? new WeakSet() : null
    };
  }

  function addIssue(context, code, message, path, severity) {
    var issue = {
      code: String(code || 'WARNING').slice(0, 80),
      message: String(message || '').slice(0, 1000),
      path: String(path || '$').slice(0, 1000),
      severity: severity === 'error' ? 'error' : 'warning'
    };
    var key = issue.code + '\u0000' + issue.path + '\u0000' + issue.message;
    if (context.issueKeys[key]) return;
    if (context.issues.length >= context.limits.maxWarnings) fail('LIMIT_EXCEEDED', '合同诊断数量超过上限。', '$.warnings');
    context.issueKeys[key] = true;
    context.issues.push(issue);
  }

  function sortedIssues(context) {
    return context.issues.slice().sort(function (a, b) {
      return compareCodeUnits(a.severity, b.severity) || compareCodeUnits(a.code, b.code) ||
        compareCodeUnits(a.path, b.path) || compareCodeUnits(a.message, b.message);
    });
  }

  function textValue(value, path, context, options) {
    options = options || {};
    if (value == null) value = '';
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      fail('INVALID_TEXT', '字段必须是文本或可安全转为文本的原始值。', path);
    }
    var output = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    var max = options.max || context.limits.maxTextLength;
    if (output.length > max) fail('LIMIT_EXCEEDED', '文本长度超过上限 ' + max + '。', path);
    if (options.required && !output) fail('REQUIRED_FIELD', '缺少必填文本。', path);
    return output;
  }

  function idValue(value, path, context, options) {
    options = options || {};
    var output = textValue(value, path, context, { required: options.required, max: options.max || 240 });
    if (!output) return '';
    if (!SAFE_ID.test(output)) fail('INVALID_ID', 'ID 只能包含字母、数字、点、下划线、冒号或短横线。', path);
    return output;
  }

  function enumValue(value, allowed, fallback, path) {
    var output = String(value == null ? '' : value);
    if (allowed.indexOf(output) >= 0) return output;
    if (fallback != null) return fallback;
    fail('INVALID_ENUM', '字段值不属于允许枚举。', path);
  }

  function booleanValue(value, fallback) {
    return value === true ? true : value === false ? false : fallback;
  }

  function positiveIntegerValue(value, path) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      fail('INVALID_REVISION', 'revision 必须是正整数 number。', path);
    }
    return value;
  }

  function nonNegativeIntegerValue(value, path) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      fail('INVALID_INTEGER', '字段必须是非负整数 number。', path);
    }
    return value;
  }

  function timestampValue(value, path, context, fallback) {
    var raw = value == null || value === '' ? fallback : value;
    raw = textValue(raw, path, context, { required: true, max: 80 });
    var parsed = new Date(raw);
    if (!Number.isFinite(parsed.getTime())) fail('INVALID_TIMESTAMP', '时间必须是有效 ISO 日期。', path);
    return parsed.toISOString();
  }

  function arrayValue(value, path, max, required) {
    if (value == null && !required) return [];
    if (!Array.isArray(value)) fail('INVALID_ARRAY', '字段必须是数组。', path);
    if (value.length > max) fail('LIMIT_EXCEEDED', '数组数量超过上限 ' + max + '。', path);
    for (var index = 0; index < value.length; index++) {
      var descriptor = ownDescriptor(value, String(index));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.value === undefined) {
        fail('NON_JSON_VALUE', '合同数组不接受空洞、访问器或 undefined 项。', path + '[' + index + ']');
      }
    }
    return value;
  }

  function arrayEntry(array, index, context, path) {
    var descriptor = ownDescriptor(array, String(index));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      addIssue(context, 'NON_JSON_ACCESSOR_DROPPED', '访问器或空洞数组项不属于普通 JSON，已忽略。', path, 'warning');
      return undefined;
    }
    return descriptor.value;
  }

  function sanitizeJsonValue(value, path, context, depth) {
    context.nodes += 1;
    if (context.nodes > context.limits.maxNodes) fail('LIMIT_EXCEEDED', '普通 JSON 节点数量超过上限。', path);
    if (depth > context.limits.maxDepth) fail('LIMIT_EXCEEDED', '普通 JSON 深度超过上限。', path);
    if (value === null || typeof value === 'boolean') return value;
    if (value === undefined) fail('NON_JSON_VALUE', '普通 JSON 不接受 undefined。', path);
    if (typeof value === 'string') return textValue(value, path, context, { max: context.limits.maxTextLength });
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('NON_JSON_VALUE', '普通 JSON 不接受非有限数字。', path);
      return value;
    }
    if (typeof value !== 'object') fail('NON_JSON_VALUE', '字段只允许普通 JSON 值。', path);
    if (context.seen) {
      if (context.seen.has(value)) fail('CYCLIC_REFERENCE', '普通 JSON 不接受循环或重复对象引用。', path);
      context.seen.add(value);
    }
    if (Array.isArray(value)) {
      var input = arrayValue(value, path, context.limits.maxJsonArrayLength, true);
      var outputArray = [];
      for (var index = 0; index < input.length; index++) {
        var descriptor = ownDescriptor(input, String(index));
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          fail('NON_JSON_VALUE', '普通 JSON 不接受稀疏数组或访问器数组项。', path + '[' + index + ']');
        }
        outputArray.push(sanitizeJsonValue(descriptor.value, path + '[' + index + ']', context, depth + 1));
      }
      return outputArray;
    }
    if (!isPlainObject(value)) fail('NON_JSON_VALUE', '字段只允许普通对象。', path);
    var keys = Object.keys(value).sort(compareCodeUnits);
    if (keys.length > context.limits.maxObjectKeys) fail('LIMIT_EXCEEDED', '对象字段数量超过上限。', path);
    var outputObject = {};
    keys.forEach(function (key) {
      if (DANGEROUS_KEYS[key]) {
        addIssue(context, 'DANGEROUS_KEY_DROPPED', '危险对象键已过滤。', path + '.[FILTERED_KEY]', 'warning');
        return;
      }
      if (isSensitiveKey(key)) {
        addIssue(context, 'SENSITIVE_FIELD_DROPPED', '敏感字段已过滤，未读取或持久化其值。', path + '.[FILTERED_SENSITIVE_FIELD]', 'warning');
        return;
      }
      var descriptor = ownDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        addIssue(context, 'NON_JSON_ACCESSOR_DROPPED', '访问器字段不属于普通 JSON，已忽略。', path + '.' + key, 'warning');
        return;
      }
      outputObject[key] = sanitizeJsonValue(descriptor.value, path + '.' + key, context, depth + 1);
    });
    return outputObject;
  }

  function stableSerializable(value, seen, path) {
    path = path || '$';
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (value === undefined) fail('NON_JSON_VALUE', '稳定序列化不接受 undefined。', path);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('NON_JSON_VALUE', '稳定序列化不接受非有限数字。', path);
      return value;
    }
    if (typeof value !== 'object') fail('NON_JSON_VALUE', '稳定序列化只接受普通 JSON 值。', path);
    seen = seen || (typeof WeakSet === 'function' ? new WeakSet() : null);
    if (seen) {
      if (seen.has(value)) fail('CYCLIC_REFERENCE', '稳定序列化不接受循环或重复对象引用。', path);
      seen.add(value);
    }
    if (Array.isArray(value)) {
      var outputArray = [];
      for (var index = 0; index < value.length; index++) {
        var descriptor = ownDescriptor(value, String(index));
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.value === undefined) {
          fail('NON_JSON_VALUE', '稳定序列化不接受稀疏、访问器或 undefined 数组项。', path + '[' + index + ']');
        }
        outputArray.push(stableSerializable(descriptor.value, seen, path + '[' + index + ']'));
      }
      return outputArray;
    }
    if (!isCrossRealmPlainObject(value)) fail('NON_JSON_VALUE', '稳定序列化只接受普通对象。', path);
    var output = {};
    Object.keys(value).filter(function (key) { return !DANGEROUS_KEYS[key] && !isSensitiveKey(key); })
      .sort(compareCodeUnits).forEach(function (key) {
        var descriptor = ownDescriptor(value, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.value === undefined) {
          fail('NON_JSON_VALUE', '稳定序列化不接受访问器或 undefined 对象字段。', path + '.' + key);
        }
        output[key] = stableSerializable(descriptor.value, seen, path + '.' + key);
      });
    return output;
  }

  function stableSerialize(value) {
    return JSON.stringify(stableSerializable(value));
  }

  function hashHex(value) {
    var raw = typeof value === 'string' ? value : stableSerialize(value);
    var h1 = 0x811c9dc5;
    var h2 = 0x9e3779b9;
    for (var index = 0; index < raw.length; index++) {
      var code = raw.charCodeAt(index);
      h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ (code + index), 0x85ebca6b) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  function stableHash(value, prefix) {
    return (prefix || 'hash_') + hashHex(value);
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

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function createUrlPolicy(input) {
    if (input == null) return DEFAULT_URL_POLICY;
    if (!isPlainObject(input)) fail('INVALID_URL_POLICY', 'URL 策略必须是普通对象。', '$urlPolicy');
    var sourceInput = ownValue(input, 'sourceRules');
    var assetInput = ownValue(input, 'assetHostRules');
    sourceInput = arrayValue(sourceInput, '$urlPolicy.sourceRules', 100, true);
    assetInput = arrayValue(assetInput, '$urlPolicy.assetHostRules', 100, true);
    var sourceRules = sourceInput.map(function (rule, index) {
      if (!isPlainObject(rule)) fail('INVALID_URL_POLICY', '来源 URL 规则必须是普通对象。', '$urlPolicy.sourceRules[' + index + ']');
      var platform = String(ownValue(rule, 'platform') || '').toLowerCase();
      var host = String(ownValue(rule, 'host') || '').toLowerCase().replace(/\.$/, '');
      var paths = arrayValue(ownValue(rule, 'paths'), '$urlPolicy.sourceRules[' + index + '].paths', 20, true)
        .map(function (path) { return String(path || ''); });
      var itemIdParam = String(ownValue(rule, 'itemIdParam') || 'id');
      if (!SAFE_PLATFORM.test(platform) || !/^[a-z0-9.-]+$/.test(host) || !paths.length ||
          paths.some(function (path) { return path[0] !== '/'; }) || !/^[A-Za-z0-9_-]{1,40}$/.test(itemIdParam)) {
        fail('INVALID_URL_POLICY', '来源 URL 规则字段无效。', '$urlPolicy.sourceRules[' + index + ']');
      }
      return { platform: platform, host: host, paths: paths.slice(), itemIdParam: itemIdParam };
    });
    var assetHostRules = assetInput.map(function (rule, index) {
      if (!isPlainObject(rule)) fail('INVALID_URL_POLICY', '素材 URL 规则必须是普通对象。', '$urlPolicy.assetHostRules[' + index + ']');
      var host = String(ownValue(rule, 'host') || '').toLowerCase().replace(/\.$/, '');
      if (!/^[a-z0-9.-]+$/.test(host)) fail('INVALID_URL_POLICY', '素材 host 规则无效。', '$urlPolicy.assetHostRules[' + index + '].host');
      return { host: host, includeSubdomains: ownValue(rule, 'includeSubdomains') === true };
    });
    return deepFreeze({ sourceRules: sourceRules, assetHostRules: assetHostRules });
  }

  function explicitPort(raw) {
    var match = String(raw || '').match(/^https:\/\/([^/?#]+)/i);
    if (!match) return false;
    var authority = match[1].replace(/^.*@/, '');
    return /:\d+$/.test(authority);
  }

  function hostMatches(hostname, rule) {
    return hostname === rule.host || (rule.includeSubdomains && hostname.endsWith('.' + rule.host));
  }

  function validateUrl(value, kind, options) {
    kind = kind === 'source' ? 'source' : 'asset';
    var policyInput = null;
    if (isPlainObject(options) && ownValue(options, 'urlPolicy')) policyInput = ownValue(options, 'urlPolicy');
    else if (isPlainObject(options) && (ownValue(options, 'sourceRules') || ownValue(options, 'assetHostRules'))) policyInput = options;
    var policy;
    try { policy = policyInput ? createUrlPolicy(policyInput) : DEFAULT_URL_POLICY; }
    catch (error) { return { ok: false, code: error.code || 'INVALID_URL_POLICY', reason: error.message }; }
    var raw = typeof value === 'string' ? value.trim() : '';
    var maxLength = isPlainObject(options) && cleanNumber(ownValue(options, 'maxUrlLength'), null) || DEFAULT_LIMITS.maxUrlLength;
    if (!raw || raw.length > maxLength || /[\u0000-\u001f\u007f\\]/.test(raw)) return { ok: false, code: 'INVALID_URL', reason: 'URL 为空、含反斜杠或超过长度上限。' };
    if (!/^https:\/\//i.test(raw) || explicitPort(raw)) return { ok: false, code: 'URL_NOT_ALLOWED', reason: '只允许无显式端口的 HTTPS URL。' };
    var parsed;
    try { parsed = new URL(raw); } catch (_) { return { ok: false, code: 'INVALID_URL', reason: 'URL 无法解析。' }; }
    var hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
      return { ok: false, code: 'URL_NOT_ALLOWED', reason: 'URL 协议、用户信息或端口不被允许。' };
    }
    if (hasSensitiveUrlQuery(parsed)) return { ok: false, code: 'SENSITIVE_URL_QUERY', reason: 'URL 含敏感鉴权或签名 query，禁止持久化。' };
    if (kind === 'source') {
      var platform = isPlainObject(options) ? String(ownValue(options, 'platform') || '') : '';
      var itemId = isPlainObject(options) ? String(ownValue(options, 'itemId') || '') : '';
      var rule = policy.sourceRules.find(function (candidate) {
        return candidate.host === hostname && candidate.paths.indexOf(parsed.pathname) >= 0 && (!platform || candidate.platform === platform);
      });
      if (!rule) return { ok: false, code: 'URL_NOT_ALLOWED', reason: '来源 host/path 不在平台白名单。' };
      var ids = parsed.searchParams.getAll(rule.itemIdParam);
      if (ids.length !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(ids[0]) || (itemId && ids[0] !== itemId)) {
        return { ok: false, code: 'ITEM_ID_MISMATCH', reason: '来源 URL 商品 ID 缺失、重复或不匹配。' };
      }
      var canonical = 'https://' + hostname + parsed.pathname + '?' + encodeURIComponent(rule.itemIdParam) + '=' + encodeURIComponent(ids[0]);
      return { ok: true, url: canonical, platform: rule.platform, itemId: ids[0] };
    }
    if (!policy.assetHostRules.some(function (rule) { return hostMatches(hostname, rule); })) {
      return { ok: false, code: 'URL_NOT_ALLOWED', reason: '素材 host 不在白名单。' };
    }
    parsed.hostname = hostname;
    parsed.hash = '';
    if (parsed.search) {
      var pairs = Array.from(parsed.searchParams.entries()).sort(function (a, b) {
        return compareCodeUnits(a[0], b[0]) || compareCodeUnits(a[1], b[1]);
      });
      parsed.search = '';
      pairs.forEach(function (pair) { parsed.searchParams.append(pair[0], pair[1]); });
    }
    return { ok: true, url: parsed.toString() };
  }

  function sanitizeEndpointPath(value, path, context) {
    var raw = textValue(value, path, context, { max: context.limits.maxShortTextLength });
    if (!raw) return '';
    var normalizedRaw = normalizedUrlComponent(raw);
    if (normalizedRaw.unsafe || normalizedRaw.value.indexOf('\\') >= 0) fail('INVALID_ENDPOINT_PATH', 'endpointPath 不允许原始或编码反斜杠。', path);
    if (/(?:bearer\s+|\btoken\b|access[_-]?token|refresh[_-]?token|authorization|cookie|api[_-]?key|secret|password)/i.test(normalizedRaw.value)) {
      fail('SENSITIVE_ENDPOINT_PATH', 'endpointPath 含可能的凭据正文，禁止持久化。', path);
    }
    if (raw[0] === '/') {
      if (raw.slice(0, 2) === '//' || raw.indexOf('\\') >= 0) {
        fail('INVALID_ENDPOINT_PATH', 'endpointPath 相对路径必须以单斜杠开头，不得是 scheme-relative 或含反斜杠。', path);
      }
      var relativeParsed;
      try { relativeParsed = new URL(raw, 'https://reference-detail.invalid'); }
      catch (_) { fail('INVALID_ENDPOINT_PATH', 'endpointPath 无法解析。', path); }
      if (hasSensitiveUrlQuery(relativeParsed)) fail('SENSITIVE_URL_QUERY', 'endpointPath 含敏感鉴权或签名 query，禁止持久化。', path);
      return relativeParsed.pathname;
    }
    if (!/^https:\/\//i.test(raw) || explicitPort(raw)) fail('INVALID_ENDPOINT_PATH', 'endpointPath 只允许 HTTPS URL 或以 / 开头的路径。', path);
    var parsed;
    try { parsed = new URL(raw); } catch (_) { fail('INVALID_ENDPOINT_PATH', 'endpointPath 无法解析。', path); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
      fail('INVALID_ENDPOINT_PATH', 'endpointPath 不允许用户信息或端口。', path);
    }
    if (hasSensitiveUrlQuery(parsed)) fail('SENSITIVE_URL_QUERY', 'endpointPath 含敏感鉴权或签名 query，禁止持久化。', path);
    return String(parsed.pathname || '/').slice(0, context.limits.maxShortTextLength);
  }

  function sourceIdentity(source) {
    return source.platform + ':' + source.itemId + ':' + source.canonicalUrl;
  }

  function sanitizeSource(input, context, options) {
    if (!isPlainObject(input)) fail('INVALID_SOURCE', 'source 必须是普通对象。', '$.source');
    var platform = textValue(ownValue(input, 'platform', context, '$.source.platform'), '$.source.platform', context, { required: true, max: 32 }).toLowerCase();
    if (!SAFE_PLATFORM.test(platform)) fail('INVALID_PLATFORM', 'platform 标识无效。', '$.source.platform');
    var itemId = textValue(ownValue(input, 'itemId', context, '$.source.itemId'), '$.source.itemId', context, { required: true, max: 128 });
    if ((platform === 'taobao' || platform === 'tmall') && !/^\d{1,30}$/.test(itemId)) {
      fail('INVALID_ITEM_ID', '淘宝/天猫商品 ID 必须是数字字符串。', '$.source.itemId');
    }
    var sourceMode = enumValue(ownValue(input, 'sourceMode', context, '$.source.sourceMode'), SOURCE_MODES, null, '$.source.sourceMode');
    var validatedUrl = validateUrl(ownValue(input, 'canonicalUrl', context, '$.source.canonicalUrl'), 'source', {
      platform: platform,
      itemId: itemId,
      urlPolicy: isPlainObject(options) && ownValue(options, 'urlPolicy') ? ownValue(options, 'urlPolicy') : DEFAULT_URL_POLICY,
      maxUrlLength: context.limits.maxUrlLength
    });
    if (!validatedUrl.ok) fail(validatedUrl.code, validatedUrl.reason, '$.source.canonicalUrl');
    return {
      platform: platform,
      itemId: itemId,
      canonicalUrl: validatedUrl.url,
      capturedAt: timestampValue(ownValue(input, 'capturedAt', context, '$.source.capturedAt'), '$.source.capturedAt', context),
      sourceMode: sourceMode
    };
  }

  function derivedOverallCompleteness(parts) {
    var values = ['source', 'facts', 'orderedBlocks', 'assets', 'evidence'].map(function (key) { return parts[key]; });
    if (values.indexOf('blocked') >= 0) return 'blocked';
    if (values.indexOf('partial') >= 0) return 'partial';
    if (values.indexOf('unknown') >= 0) return 'unknown';
    return 'complete';
  }

  function sanitizeCompleteness(input, context) {
    input = isPlainObject(input) ? input : {};
    var output = {};
    ['source', 'facts', 'orderedBlocks', 'assets', 'evidence'].forEach(function (key) {
      output[key] = enumValue(ownValue(input, key, context, '$.completeness.' + key), COMPLETENESS_STATUSES, 'unknown', '$.completeness.' + key);
    });
    output.overall = derivedOverallCompleteness(output);
    var requestedOverall = ownValue(input, 'overall', context, '$.completeness.overall');
    if (requestedOverall != null && COMPLETENESS_STATUSES.indexOf(String(requestedOverall)) >= 0 && requestedOverall !== output.overall) {
      addIssue(context, 'COMPLETENESS_RECALCULATED', 'overall 已按分项完整度重新计算，不能被“扫描成功”提升。', '$.completeness.overall', 'warning');
    }
    return output;
  }

  function sanitizeInputWarnings(value, context) {
    var list = arrayValue(value, '$.warnings', context.limits.maxWarnings, false);
    list.forEach(function (warning, index) {
      if (!isPlainObject(warning)) return;
      var code = idValue(ownValue(warning, 'code', context, '$.warnings[' + index + '].code') || 'SOURCE_WARNING', '$.warnings[' + index + '].code', context, { max: 80 });
      var message = textValue(ownValue(warning, 'message', context, '$.warnings[' + index + '].message'), '$.warnings[' + index + '].message', context, { max: context.limits.maxShortTextLength });
      var issuePath = textValue(ownValue(warning, 'path', context, '$.warnings[' + index + '].path') || '$', '$.warnings[' + index + '].path', context, { max: context.limits.maxShortTextLength });
      addIssue(context, code, message, issuePath, ownValue(warning, 'severity') === 'error' ? 'error' : 'warning');
    });
  }

  function sanitizeEvidence(value, sourceKey, context) {
    var list = arrayValue(value, '$.evidence', context.limits.maxEvidence, false);
    var output = [];
    var inputIdMap = Object.create(null);
    var outputIds = Object.create(null);
    for (var index = 0; index < list.length; index++) {
      var item = arrayEntry(list, index, context, '$.evidence[' + index + ']');
      if (item === undefined) continue;
      if (!isPlainObject(item)) fail('INVALID_EVIDENCE', 'evidence 项必须是普通对象。', '$.evidence[' + index + ']');
      var kind = enumValue(ownValue(item, 'kind', context, '$.evidence[' + index + '].kind'), EVIDENCE_KINDS, 'unknown', '$.evidence[' + index + '].kind');
      var sourcePath = textValue(ownValue(item, 'sourcePath', context, '$.evidence[' + index + '].sourcePath'), '$.evidence[' + index + '].sourcePath', context, { max: context.limits.maxShortTextLength });
      var endpointPath = sanitizeEndpointPath(ownValue(item, 'endpointPath', context, '$.evidence[' + index + '].endpointPath'), '$.evidence[' + index + '].endpointPath', context);
      var locator = textValue(ownValue(item, 'locator', context, '$.evidence[' + index + '].locator'), '$.evidence[' + index + '].locator', context, { max: context.limits.maxShortTextLength });
      var note = textValue(ownValue(item, 'note', context, '$.evidence[' + index + '].note'), '$.evidence[' + index + '].note', context, { max: context.limits.maxShortTextLength });
      var completeness = enumValue(ownValue(item, 'completeness', context, '$.evidence[' + index + '].completeness'), COMPLETENESS_STATUSES, 'unknown', '$.evidence[' + index + '].completeness');
      var evidenceId = stableHash({ source: sourceKey, index: index, kind: kind, sourcePath: sourcePath, endpointPath: endpointPath, locator: locator }, 'rde_');
      if (outputIds[evidenceId]) fail('DUPLICATE_ID', 'evidence 稳定 ID 冲突。', '$.evidence[' + index + ']');
      outputIds[evidenceId] = true;
      var rawId = textValue(ownValue(item, 'evidenceId', context, '$.evidence[' + index + '].evidenceId'), '$.evidence[' + index + '].evidenceId', context, { max: 240 });
      if (rawId) {
        if (inputIdMap[rawId]) fail('DUPLICATE_INPUT_ID', '输入 evidenceId 重复。', '$.evidence[' + index + '].evidenceId');
        inputIdMap[rawId] = evidenceId;
      }
      inputIdMap[evidenceId] = evidenceId;
      output.push({ evidenceId: evidenceId, kind: kind, sourcePath: sourcePath, endpointPath: endpointPath, locator: locator, note: note, completeness: completeness });
    }
    return { items: output, idMap: inputIdMap };
  }

  function restrictiveRights(first, second) {
    return RIGHTS_RESTRICTIVENESS[first] >= RIGHTS_RESTRICTIVENESS[second] ? first : second;
  }

  function sanitizeAssets(value, sourceKey, context, options, defaultRights) {
    var list = arrayValue(value, '$.assets', context.limits.maxAssets, false);
    var output = [];
    var byUrl = Object.create(null);
    var inputIdMap = Object.create(null);
    for (var index = 0; index < list.length; index++) {
      var item = arrayEntry(list, index, context, '$.assets[' + index + ']');
      if (item === undefined) continue;
      if (!isPlainObject(item)) fail('INVALID_ASSET', 'asset 项必须是普通对象。', '$.assets[' + index + ']');
      var validatedUrl = validateUrl(ownValue(item, 'url', context, '$.assets[' + index + '].url'), 'asset', {
        urlPolicy: isPlainObject(options) && ownValue(options, 'urlPolicy') ? ownValue(options, 'urlPolicy') : DEFAULT_URL_POLICY,
        maxUrlLength: context.limits.maxUrlLength
      });
      if (!validatedUrl.ok) fail(validatedUrl.code, validatedUrl.reason, '$.assets[' + index + '].url');
      var rawId = textValue(ownValue(item, 'assetId', context, '$.assets[' + index + '].assetId'), '$.assets[' + index + '].assetId', context, { max: 240 });
      var role = enumValue(ownValue(item, 'role', context, '$.assets[' + index + '].role'), ASSET_ROLES, 'unknown', '$.assets[' + index + '].role');
      var mediaType = enumValue(ownValue(item, 'mediaType', context, '$.assets[' + index + '].mediaType'), ['image', 'video'], role === 'video' ? 'video' : 'image', '$.assets[' + index + '].mediaType');
      var claimedRights = enumValue(ownValue(item, 'rightsStatus', context, '$.assets[' + index + '].rightsStatus'), RIGHTS_STATUSES, defaultRights, '$.assets[' + index + '].rightsStatus');
      if (claimedRights !== 'reference_only') {
        addIssue(context, 'SOURCE_RIGHTS_DOWNGRADED', '来源页素材不信任采集输入自报授权，已强制归一为 reference_only。', '$.assets[' + index + '].rightsStatus', 'warning');
      }
      var rightsStatus = 'reference_only';
      var existing = byUrl[validatedUrl.url];
      if (existing) {
        if (rawId) {
          if (inputIdMap[rawId] && inputIdMap[rawId] !== existing.assetId) fail('DUPLICATE_INPUT_ID', '输入 assetId 指向多个素材。', '$.assets[' + index + '].assetId');
          inputIdMap[rawId] = existing.assetId;
        }
        addIssue(context, 'DUPLICATE_ASSET', '相同规范 URL 的素材已在 registry 去重；详情出现顺序仍由 orderedBlocks 保留。', '$.assets[' + index + ']', 'warning');
        continue;
      }
      var assetId = stableHash(validatedUrl.url, 'rda_');
      var outputItem = {
        assetId: assetId,
        url: validatedUrl.url,
        mediaType: mediaType,
        role: role,
        originalIndex: cleanNumber(ownValue(item, 'originalIndex', context, '$.assets[' + index + '].originalIndex'), index),
        width: cleanNumber(ownValue(item, 'width', context, '$.assets[' + index + '].width'), null),
        height: cleanNumber(ownValue(item, 'height', context, '$.assets[' + index + '].height'), null),
        altText: textValue(ownValue(item, 'altText', context, '$.assets[' + index + '].altText'), '$.assets[' + index + '].altText', context, { max: context.limits.maxShortTextLength }),
        sourcePath: textValue(ownValue(item, 'sourcePath', context, '$.assets[' + index + '].sourcePath'), '$.assets[' + index + '].sourcePath', context, { max: context.limits.maxShortTextLength }),
        rightsStatus: rightsStatus,
        completeness: enumValue(ownValue(item, 'completeness', context, '$.assets[' + index + '].completeness'), COMPLETENESS_STATUSES, 'unknown', '$.assets[' + index + '].completeness')
      };
      byUrl[validatedUrl.url] = outputItem;
      if (rawId) {
        if (inputIdMap[rawId] && inputIdMap[rawId] !== assetId) fail('DUPLICATE_INPUT_ID', '输入 assetId 重复。', '$.assets[' + index + '].assetId');
        inputIdMap[rawId] = assetId;
      }
      inputIdMap[assetId] = assetId;
      output.push(outputItem);
    }
    return { items: output, idMap: inputIdMap };
  }

  function mappedIdList(value, path, context, idMap) {
    var list = arrayValue(value, path, context.limits.maxRefsPerBlock, false);
    var output = [];
    var seen = Object.create(null);
    for (var index = 0; index < list.length; index++) {
      var raw = arrayEntry(list, index, context, path + '[' + index + ']');
      if (raw === undefined) continue;
      raw = textValue(raw, path + '[' + index + ']', context, { required: true, max: 240 });
      var mapped = idMap[raw];
      if (!mapped) {
        addIssue(context, 'UNKNOWN_REFERENCE_DROPPED', '引用未指向当前快照内的稳定对象，已忽略。', path + '[' + index + ']', 'warning');
        continue;
      }
      if (!seen[mapped]) {
        seen[mapped] = true;
        output.push(mapped);
      }
    }
    return output;
  }

  function pixelInteger(value, path, allowZero) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
      fail('INVALID_ASSET_SLICE', '素材裁切坐标和尺寸必须是安全整数。', path);
    }
    return value;
  }

  function sanitizeAssetSlices(value, path, context, assetMap, assetItems, blockAssetIds) {
    var list = arrayValue(value, path, context.limits.maxRefsPerBlock, false);
    var allowed = Object.create(null);
    blockAssetIds.forEach(function (assetId) { allowed[assetId] = true; });
    var seen = Object.create(null);
    var output = [];
    for (var index = 0; index < list.length; index++) {
      var item = arrayEntry(list, index, context, path + '[' + index + ']');
      if (item === undefined) continue;
      if (!isPlainObject(item)) fail('INVALID_ASSET_SLICE', 'assetSlices 项必须是普通对象。', path + '[' + index + ']');
      var rawAssetId = textValue(ownValue(item, 'assetId', context, path + '[' + index + '].assetId'), path + '[' + index + '].assetId', context, { required: true, max: 240 });
      var assetId = assetMap[rawAssetId];
      if (!assetId || !allowed[assetId]) {
        addIssue(context, 'UNKNOWN_ASSET_SLICE_DROPPED', '裁切引用未指向当前详情块内的素材，已忽略。', path + '[' + index + ']', 'warning');
        continue;
      }
      var asset = assetItems && assetItems[assetId];
      if (!asset || asset.mediaType !== 'image') {
        fail('INVALID_ASSET_SLICE', '只有当前详情块内的图片素材可以声明裁切范围。', path + '[' + index + '].assetId');
      }
      var cropX = pixelInteger(ownValue(item, 'cropX', context, path + '[' + index + '].cropX'), path + '[' + index + '].cropX', true);
      var cropY = pixelInteger(ownValue(item, 'cropY', context, path + '[' + index + '].cropY'), path + '[' + index + '].cropY', true);
      var cropWidth = pixelInteger(ownValue(item, 'cropWidth', context, path + '[' + index + '].cropWidth'), path + '[' + index + '].cropWidth', false);
      var cropHeight = pixelInteger(ownValue(item, 'cropHeight', context, path + '[' + index + '].cropHeight'), path + '[' + index + '].cropHeight', false);
      var sourceWidth = pixelInteger(ownValue(item, 'sourceWidth', context, path + '[' + index + '].sourceWidth'), path + '[' + index + '].sourceWidth', false);
      var sourceHeight = pixelInteger(ownValue(item, 'sourceHeight', context, path + '[' + index + '].sourceHeight'), path + '[' + index + '].sourceHeight', false);
      // Long Tmall detail strips can legitimately exceed 16,384 px while
      // remaining modest in decoded area (for example 750x30,000). Keep a
      // defensive per-axis ceiling for browser decoders, but let the pixel
      // budget be the primary bound for tall source material.
      if (sourceWidth > 8192 || sourceHeight > 65535 || sourceWidth * sourceHeight > 40000000) {
        fail('INVALID_ASSET_SLICE', '素材裁切原图尺寸超过有界上限。', path + '[' + index + ']');
      }
      if ((Number(asset.width) > 0 && Number(asset.width) !== sourceWidth) ||
          (Number(asset.height) > 0 && Number(asset.height) !== sourceHeight)) {
        fail('INVALID_ASSET_SLICE', '素材裁切原图尺寸必须与素材 registry 一致。', path + '[' + index + ']');
      }
      if (cropX + cropWidth > sourceWidth || cropY + cropHeight > sourceHeight) {
        fail('INVALID_ASSET_SLICE', '素材裁切范围不得超出原图边界。', path + '[' + index + ']');
      }
      if (cropX !== 0 || cropWidth !== sourceWidth) {
        fail('INVALID_ASSET_SLICE', '详情长图只允许全宽纵向分片。', path + '[' + index + ']');
      }
      if (cropHeight / cropWidth > 2.001) {
        fail('INVALID_ASSET_SLICE', '单个详情分片高度不得超过分片宽度的 2 倍。', path + '[' + index + ']');
      }
      var signature = [assetId, cropX, cropY, cropWidth, cropHeight, sourceWidth, sourceHeight].join(':');
      if (seen[signature]) continue;
      seen[signature] = true;
      output.push({
        assetId: assetId,
        cropX: cropX, cropY: cropY,
        cropWidth: cropWidth, cropHeight: cropHeight,
        sourceWidth: sourceWidth, sourceHeight: sourceHeight
      });
    }
    return output;
  }

  function sanitizeFacts(value, sourceKey, evidenceMap, context) {
    var list = arrayValue(value, '$.facts', context.limits.maxFacts, false);
    var output = [];
    var inputIdMap = Object.create(null);
    for (var index = 0; index < list.length; index++) {
      var item = arrayEntry(list, index, context, '$.facts[' + index + ']');
      if (item === undefined) continue;
      if (!isPlainObject(item)) fail('INVALID_FACT', 'fact 项必须是普通对象。', '$.facts[' + index + ']');
      var key = textValue(ownValue(item, 'key', context, '$.facts[' + index + '].key'), '$.facts[' + index + '].key', context, { required: true, max: 240 });
      var label = textValue(ownValue(item, 'label', context, '$.facts[' + index + '].label'), '$.facts[' + index + '].label', context, { max: context.limits.maxShortTextLength });
      var category = textValue(ownValue(item, 'category', context, '$.facts[' + index + '].category'), '$.facts[' + index + '].category', context, { max: 120 });
      var unit = textValue(ownValue(item, 'unit', context, '$.facts[' + index + '].unit'), '$.facts[' + index + '].unit', context, { max: 120 });
      var factValue = sanitizeJsonValue(ownValue(item, 'value', context, '$.facts[' + index + '].value'), '$.facts[' + index + '].value', context, 0);
      var factId = stableHash({ source: sourceKey, index: index, key: key, value: factValue, unit: unit }, 'rdf_');
      var rawId = textValue(ownValue(item, 'factId', context, '$.facts[' + index + '].factId'), '$.facts[' + index + '].factId', context, { max: 240 });
      if (rawId) {
        if (inputIdMap[rawId]) fail('DUPLICATE_INPUT_ID', '输入 factId 重复。', '$.facts[' + index + '].factId');
        inputIdMap[rawId] = factId;
      }
      inputIdMap[factId] = factId;
      output.push({
        factId: factId,
        key: key,
        label: label,
        category: category,
        value: factValue,
        unit: unit,
        sourcePath: textValue(ownValue(item, 'sourcePath', context, '$.facts[' + index + '].sourcePath'), '$.facts[' + index + '].sourcePath', context, { max: context.limits.maxShortTextLength }),
        evidenceIds: mappedIdList(ownValue(item, 'evidenceIds', context, '$.facts[' + index + '].evidenceIds'), '$.facts[' + index + '].evidenceIds', context, evidenceMap),
        completeness: enumValue(ownValue(item, 'completeness', context, '$.facts[' + index + '].completeness'), COMPLETENESS_STATUSES, 'unknown', '$.facts[' + index + '].completeness')
      });
    }
    return { items: output, idMap: inputIdMap };
  }

  function sanitizeBlocks(value, sourceKey, maps, context) {
    var list = arrayValue(value, '$.orderedBlocks', context.limits.maxBlocks, false);
    var output = [];
    for (var index = 0; index < list.length; index++) {
      var item = arrayEntry(list, index, context, '$.orderedBlocks[' + index + ']');
      if (item === undefined) continue;
      if (!isPlainObject(item)) fail('INVALID_BLOCK', 'orderedBlocks 项必须是普通对象。', '$.orderedBlocks[' + index + ']');
      var type = enumValue(ownValue(item, 'type', context, '$.orderedBlocks[' + index + '].type'), BLOCK_TYPES, 'unknown', '$.orderedBlocks[' + index + '].type');
      var salesRole = enumValue(ownValue(item, 'salesRole', context, '$.orderedBlocks[' + index + '].salesRole'), SALES_ROLES, 'unknown', '$.orderedBlocks[' + index + '].salesRole');
      var assetIds = mappedIdList(ownValue(item, 'assetIds', context, '$.orderedBlocks[' + index + '].assetIds'), '$.orderedBlocks[' + index + '].assetIds', context, maps.assets);
      var assetSlices = sanitizeAssetSlices(ownValue(item, 'assetSlices', context, '$.orderedBlocks[' + index + '].assetSlices'), '$.orderedBlocks[' + index + '].assetSlices', context, maps.assets, maps.assetItems, assetIds);
      var factIds = mappedIdList(ownValue(item, 'factIds', context, '$.orderedBlocks[' + index + '].factIds'), '$.orderedBlocks[' + index + '].factIds', context, maps.facts);
      var evidenceIds = mappedIdList(ownValue(item, 'evidenceIds', context, '$.orderedBlocks[' + index + '].evidenceIds'), '$.orderedBlocks[' + index + '].evidenceIds', context, maps.evidence);
      var outputBlock = {
        blockId: stableHash({ source: sourceKey, originalIndex: index }, 'rdb_'),
        originalIndex: index,
        type: type,
        salesRole: salesRole,
        sourceSummary: textValue(ownValue(item, 'sourceSummary', context, '$.orderedBlocks[' + index + '].sourceSummary'), '$.orderedBlocks[' + index + '].sourceSummary', context, { max: context.limits.maxShortTextLength }),
        text: textValue(ownValue(item, 'text', context, '$.orderedBlocks[' + index + '].text'), '$.orderedBlocks[' + index + '].text', context, { max: context.limits.maxTextLength }),
        assetIds: assetIds,
        factIds: factIds,
        evidenceIds: evidenceIds,
        completeness: enumValue(ownValue(item, 'completeness', context, '$.orderedBlocks[' + index + '].completeness'), COMPLETENESS_STATUSES, 'unknown', '$.orderedBlocks[' + index + '].completeness')
      };
      // Preserve byte-for-byte canonical compatibility for stored V1 blocks:
      // old snapshots without slice metadata must not acquire an empty key and
      // therefore must retain their historical snapshotId/sourceDigest.
      if (assetSlices.length) outputBlock.assetSlices = assetSlices;
      output.push(outputBlock);
    }
    return output;
  }

  function sanitizeSourceSnapshot(input, options) {
    var context = createContext(options);
    if (!isPlainObject(input)) fail('INVALID_CONTRACT', '来源快照必须是普通对象。', '$');
    var schema = ownValue(input, 'schema', context, '$.schema');
    if (schema !== SOURCE_SCHEMA) fail('INVALID_SCHEMA', '来源快照 schema 必须为 ' + SOURCE_SCHEMA + '。', '$.schema');
    if (Number(ownValue(input, 'schemaVersion', context, '$.schemaVersion')) !== SCHEMA_VERSION) fail('INVALID_SCHEMA_VERSION', 'schemaVersion 必须为 1。', '$.schemaVersion');
    var source = sanitizeSource(ownValue(input, 'source', context, '$.source'), context, options);
    var sourceKey = sourceIdentity(source);
    var completeness = sanitizeCompleteness(ownValue(input, 'completeness', context, '$.completeness'), context);
    sanitizeInputWarnings(ownValue(input, 'warnings', context, '$.warnings'), context);
    var evidence = sanitizeEvidence(ownValue(input, 'evidence', context, '$.evidence'), sourceKey, context);
    var rightsInput = ownValue(input, 'rights', context, '$.rights');
    rightsInput = isPlainObject(rightsInput) ? rightsInput : {};
    var claimedDefaultRights = enumValue(ownValue(rightsInput, 'defaultStatus', context, '$.rights.defaultStatus'), RIGHTS_STATUSES, 'reference_only', '$.rights.defaultStatus');
    if (claimedDefaultRights !== 'reference_only') {
      addIssue(context, 'SOURCE_RIGHTS_DOWNGRADED', '来源快照的默认权利不信任输入自报，已强制归一为 reference_only。', '$.rights.defaultStatus', 'warning');
    }
    var defaultRights = 'reference_only';
    var assets = sanitizeAssets(ownValue(input, 'assets', context, '$.assets'), sourceKey, context, options, defaultRights);
    var assetItemsById = Object.create(null);
    assets.items.forEach(function (asset) { assetItemsById[asset.assetId] = asset; });
    var facts = sanitizeFacts(ownValue(input, 'facts', context, '$.facts'), sourceKey, evidence.idMap, context);
    var orderedBlocks = sanitizeBlocks(ownValue(input, 'orderedBlocks', context, '$.orderedBlocks'), sourceKey, {
      assets: assets.idMap,
      assetItems: assetItemsById,
      facts: facts.idMap,
      evidence: evidence.idMap
    }, context);
    var reusableAssetIds = [];
    var restrictedAssetIds = assets.items.map(function (asset) { return asset.assetId; });
    var outputCore = {
      schema: SOURCE_SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      source: source,
      completeness: completeness,
      facts: facts.items,
      orderedBlocks: orderedBlocks,
      assets: assets.items,
      evidence: evidence.items,
      rights: {
        defaultStatus: defaultRights,
        notice: textValue(ownValue(rightsInput, 'notice', context, '$.rights.notice'), '$.rights.notice', context, { max: context.limits.maxShortTextLength }),
        reusableAssetIds: reusableAssetIds,
        restrictedAssetIds: restrictedAssetIds
      },
      warnings: sortedIssues(context)
    };
    var output = Object.assign({ snapshotId: stableHash(outputCore, 'rds_') }, outputCore);
    return deepFreeze(output);
  }

  function detailSemanticPath(value) {
    var output = String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    try { output = decodeURIComponent(output); } catch (_) {}
    return output.replace(/\\/g, '/');
  }

  function detailPathHasToken(path, tokens) {
    path = detailSemanticPath(path);
    if (!path) return false;
    var normalized = path.replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ');
    var padded = ' ' + normalized + ' ';
    for (var index = 0; index < tokens.length; index++) {
      if (padded.indexOf(' ' + tokens[index] + ' ') >= 0) return true;
    }
    return false;
  }

  function isRejectedDetailSurfacePath(path) {
    path = detailSemanticPath(path);
    if (!path) return false;
    if (/(?:用户评价|商品评价|累计评价|买家秀|问大家|相关推荐|相似商品|猜你喜欢|本店推荐|店铺推荐|看了又看|大家还买|热销推荐|为你推荐|底部工具)/.test(path)) return true;
    return detailPathHasToken(path, [
      'review', 'reviews', 'reviewer', 'comment', 'comments', 'rating', 'feedback',
      'question', 'questions', 'ask', 'qanda', 'qa', 'buyer', 'buyershow',
      'recommend', 'recommended', 'recommendation', 'related', 'similar', 'guess',
      'youmaylike', 'maylike', 'also-buy', 'alsobuy', 'shop-recommend', 'shoprecommend',
      'hot-sale', 'hotsale', 'footer', 'bottom-bar', 'bottombar', 'toolbar', 'tabbar',
      'sidebar', 'floatbar', 'floating', 'navigation', 'nav', 'menu', 'popup', 'modal',
      'drawer', 'promptlab', 'workbench', 'extension-ui', 'sz-workbench',
      'parameter-nav', 'param-nav', 'attribute-nav', 'spec-nav', 'parameter-tab',
      'attribute-tab', 'spec-tab'
    ]);
  }

  function isMainGalleryPath(path) {
    path = detailSemanticPath(path);
    if (!path) return false;
    if (path.indexOf('metadata:') === 0) return true;
    return detailPathHasToken(path, [
      'gallery', 'mainpic', 'main-pic', 'mainpicture', 'main-picture', 'picgallery',
      'preview', 'thumbnail', 'thumbnails', 'carousel', 'sku-gallery', 'skugallery'
    ]);
  }

  function isPositiveDetailPath(path) {
    path = detailSemanticPath(path);
    if (!path) return false;
    if (path.indexOf('detail-dom:') === 0 || path.indexOf('network-detail:') === 0) return true;
    if (path.indexOf('network:') === 0) {
      if (isRejectedDetailSurfacePath(path)) return false;
      return detailPathHasToken(path, ['detail', 'details', 'desc', 'description', 'itemdesc', 'item-detail', 'detail-content']);
    }
    return detailPathHasToken(path, [
      'description', 'j-divitemdesc', 'j-detail', 'detail-content', 'detailcontent',
      'itemdetail', 'item-detail', 'itemdesc'
    ]);
  }

  function isClearlyNonScreenImage(asset) {
    var width = Number(asset && asset.width);
    var height = Number(asset && asset.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 &&
        (width < 96 || height < 72 || width * height < 16384)) return true;
    var hint = detailSemanticPath((asset && asset.url || '') + ' ' + (asset && asset.altText || ''));
    return /(?:^|[\s/_.-])(?:blank|spacer|pixel|1x1|transparent|placeholder|loading|avatar|qrcode|qr-code|sprite)(?:[\s/_.?-]|$)/.test(hint) &&
      (!Number.isFinite(width) || !Number.isFinite(height) || width < 320 || height < 180);
  }

  function classifyDetailImageAsset(asset, block) {
    if (!asset || asset.mediaType !== 'image') return 'not_image';
    if (asset.completeness === 'blocked' || block.completeness === 'blocked') return 'blocked';
    if (DETAIL_IMAGE_ASSET_ROLE_DENY[asset.role]) return asset.role === 'main' ? 'main_gallery' : 'non_detail_role';
    if (isClearlyNonScreenImage(asset)) return 'non_screen_image';
    var path = asset.sourcePath || '';
    if (isRejectedDetailSurfacePath(path)) return 'outside_detail_boundary';
    if (isMainGalleryPath(path)) return 'main_gallery';
    if (isPositiveDetailPath(path)) return '';
    if (detailSemanticPath(path).indexOf('network:') === 0) return 'network_unproven';
    // Legacy V1 snapshots did not mark the detail DOM scope explicitly. Keep a
    // conservative compatibility path only for image assets whose path is not a
    // known main-gallery or semantic boundary surface.
    if (!path || detailSemanticPath(path).indexOf('dom:') === 0) return '';
    return 'scope_unproven';
  }

  function isAnchoredDetailRangePath(path) {
    return detailSemanticPath(path).indexOf(DETAIL_RANGE_PATH_PREFIX) === 0;
  }

  function detailRangeEvidencePathsForBlock(block, evidenceById) {
    var paths = [];
    (block.evidenceIds || []).forEach(function (evidenceId) {
      var evidence = evidenceById[evidenceId];
      if (evidence && evidence.kind === 'dom' && evidence.sourcePath) paths.push(evidence.sourcePath);
    });
    return paths;
  }

  function projectDetailImageSource(input, options) {
    var snapshot = sanitizeSourceSnapshot(input, options);
    var assetById = Object.create(null);
    var evidenceById = Object.create(null);
    var factById = Object.create(null);
    snapshot.assets.forEach(function (asset) { assetById[asset.assetId] = asset; });
    snapshot.evidence.forEach(function (evidence) { evidenceById[evidence.evidenceId] = evidence; });
    snapshot.facts.forEach(function (fact) { factById[fact.factId] = fact; });
    var accepted = [];
    var rejected = [];
    var keptAssetIds = Object.create(null);
    var keptEvidenceIds = Object.create(null);
    var keptFactIds = Object.create(null);

    snapshot.orderedBlocks.slice().sort(function (first, second) {
      return first.originalIndex - second.originalIndex || compareCodeUnits(first.blockId, second.blockId);
    }).forEach(function (block) {
      // Range membership belongs to this ordered occurrence, not to the
      // URL-deduplicated asset registry.  Requiring block-local DOM evidence
      // both preserves a main-image URL when it visibly repeats in the detail
      // interval and prevents an unrelated block from borrowing an anchored
      // asset sourcePath as proof.
      var proofPaths = detailRangeEvidencePathsForBlock(block, evidenceById);
      if (!proofPaths.some(isAnchoredDetailRangePath)) {
        rejected.push({ blockId: block.blockId, originalIndex: block.originalIndex, reason: 'outside_anchored_detail_range' });
        return;
      }
      var keptBlockAssetIds = [];
      block.assetIds.forEach(function (assetId) {
        var asset = assetById[assetId];
        // The block's anchored DOM evidence proves the occurrence is inside
        // the detail range. The asset registry is URL-deduplicated, so the same
        // image may retain an earlier metadata/main sourcePath even when it is
        // visibly repeated inside the anchored range.
        if (!asset) return;
        if (asset.mediaType === 'image' && isClearlyNonScreenImage(asset)) return;
        keptBlockAssetIds.push(assetId);
      });
      var keptBlockFactIds = block.factIds.filter(function (factId) {
        return !!factById[factId];
      });
      var keptBlockEvidenceIds = block.evidenceIds.filter(function (evidenceId) {
        return !!evidenceById[evidenceId];
      });
      if (!block.text && !keptBlockAssetIds.length && !keptBlockFactIds.length) {
        rejected.push({ blockId: block.blockId, originalIndex: block.originalIndex, reason: 'empty_after_range_sanitization' });
        return;
      }
      keptBlockAssetIds.forEach(function (assetId) { keptAssetIds[assetId] = true; });
      keptBlockFactIds.forEach(function (factId) { keptFactIds[factId] = true; });
      keptBlockEvidenceIds.forEach(function (evidenceId) { keptEvidenceIds[evidenceId] = true; });
      accepted.push({
        block: block,
        assetIds: keptBlockAssetIds,
        factIds: keptBlockFactIds,
        evidenceIds: keptBlockEvidenceIds
      });
    });

    var raw = {
      schema: SOURCE_SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      source: cloneJson(snapshot.source),
      completeness: cloneJson(snapshot.completeness),
      facts: snapshot.facts.filter(function (fact) {
        return !!keptFactIds[fact.factId] || isAnchoredDetailRangePath(fact.sourcePath);
      }).map(cloneJson),
      orderedBlocks: accepted.map(function (entry) {
        var block = cloneJson(entry.block);
        block.assetIds = entry.assetIds.slice();
        block.assetSlices = (block.assetSlices || []).filter(function (slice) {
          return slice && entry.assetIds.indexOf(slice.assetId) >= 0;
        });
        block.factIds = entry.factIds.slice();
        block.evidenceIds = entry.evidenceIds.slice();
        var hasImage = block.assetIds.some(function (assetId) { return assetById[assetId] && assetById[assetId].mediaType === 'image'; });
        var hasVideo = block.assetIds.some(function (assetId) { return assetById[assetId] && assetById[assetId].mediaType === 'video'; });
        if (block.text && block.assetIds.length) block.type = hasImage && !hasVideo ? 'image_text' : 'mixed';
        else if (block.assetIds.length) block.type = hasImage && !hasVideo ? 'image' : (hasVideo && !hasImage ? 'video' : 'mixed');
        else if (block.type === 'image' || block.type === 'image_text' || block.type === 'video' || block.type === 'mixed') block.type = 'text';
        return block;
      }),
      assets: snapshot.assets.filter(function (asset) { return !!keptAssetIds[asset.assetId]; }).map(cloneJson),
      evidence: snapshot.evidence.filter(function (evidence) {
        return !!keptEvidenceIds[evidence.evidenceId] || isAnchoredDetailRangePath(evidence.sourcePath);
      }).map(cloneJson),
      rights: cloneJson(snapshot.rights),
      warnings: cloneJson(snapshot.warnings)
    };
    var projected = sanitizeSourceSnapshot(raw, options);
    var projectedAssetById = Object.create(null);
    projected.assets.forEach(function (asset) { projectedAssetById[asset.assetId] = asset; });
    var detailImageScreenCount = 0;
    var detailVideoScreenCount = 0;
    var detailTextScreenCount = 0;
    projected.orderedBlocks.forEach(function (block) {
      var hasImage = block.assetIds.some(function (assetId) { return projectedAssetById[assetId] && projectedAssetById[assetId].mediaType === 'image'; });
      var hasVideo = block.assetIds.some(function (assetId) { return projectedAssetById[assetId] && projectedAssetById[assetId].mediaType === 'video'; });
      if (hasImage) detailImageScreenCount += 1;
      if (hasVideo) detailVideoScreenCount += 1;
      if (block.text) detailTextScreenCount += 1;
    });
    var report = {
      boundaryContract: 'GRAPHIC_DETAIL_TO_SHOP_RECOMMEND_V1',
      detailScreenCount: projected.orderedBlocks.length,
      detailImageScreenCount: detailImageScreenCount,
      detailVideoScreenCount: detailVideoScreenCount,
      detailTextScreenCount: detailTextScreenCount,
      rawBlockCount: snapshot.orderedBlocks.length,
      rawAssetCount: snapshot.assets.length,
      filteredBlockCount: snapshot.orderedBlocks.length - projected.orderedBlocks.length,
      filteredAssetCount: snapshot.assets.length - projected.assets.length,
      acceptedBlockIds: accepted.map(function (entry) { return entry.block.blockId; }),
      rejectedBlocks: rejected
    };
    return deepFreeze({
      ok: projected.orderedBlocks.length > 0,
      code: projected.orderedBlocks.length > 0 ? 'DETAIL_RANGE_SOURCE_READY' : 'NO_ANCHORED_DETAIL_BLOCKS',
      snapshot: projected,
      report: report
    });
  }

  function classifyDetailImageBlocks(input, options) {
    var projected = projectDetailImageSource(input, options);
    return deepFreeze({ ok: projected.ok, code: projected.code, report: projected.report });
  }

  function riskFlagsForBlock(block, assetById) {
    var flags = [];
    if (block.completeness === 'partial') flags.push('SOURCE_PARTIAL');
    if (block.completeness === 'unknown') flags.push('SOURCE_UNKNOWN');
    if (block.completeness === 'blocked') flags.push('SOURCE_BLOCKED');
    block.assetIds.forEach(function (assetId) {
      var asset = assetById[assetId];
      if (!asset) return;
      if (asset.rightsStatus === 'reference_only') flags.push('REFERENCE_ONLY_ASSET');
      if (asset.rightsStatus === 'unknown') flags.push('UNKNOWN_ASSET_RIGHTS');
      if (asset.rightsStatus === 'blocked') flags.push('BLOCKED_ASSET');
    });
    return Array.from(new Set(flags)).sort(compareCodeUnits);
  }

  function emptyEditableCopy() {
    return { headline: '', body: '', bullets: [], cta: '' };
  }

  function sanitizeEditableCopy(input, path, context) {
    input = isPlainObject(input) ? input : {};
    return {
      headline: textValue(ownValue(input, 'headline', context, path + '.headline'), path + '.headline', context, { max: context.limits.maxShortTextLength }),
      body: textValue(ownValue(input, 'body', context, path + '.body'), path + '.body', context, { max: context.limits.maxTextLength }),
      bullets: arrayValue(ownValue(input, 'bullets', context, path + '.bullets'), path + '.bullets', context.limits.maxCopyBullets, false).map(function (item, index) {
        return textValue(item, path + '.bullets[' + index + ']', context, { max: context.limits.maxShortTextLength });
      }),
      cta: textValue(ownValue(input, 'cta', context, path + '.cta'), path + '.cta', context, { max: context.limits.maxShortTextLength })
    };
  }

  function sanitizeVisualBrief(input, path, context) {
    input = isPlainObject(input) ? input : {};
    return {
      description: textValue(ownValue(input, 'description', context, path + '.description'), path + '.description', context, { max: context.limits.maxTextLength }),
      layout: textValue(ownValue(input, 'layout', context, path + '.layout'), path + '.layout', context, { max: context.limits.maxShortTextLength }),
      mood: textValue(ownValue(input, 'mood', context, path + '.mood'), path + '.mood', context, { max: context.limits.maxShortTextLength }),
      shotType: textValue(ownValue(input, 'shotType', context, path + '.shotType'), path + '.shotType', context, { max: context.limits.maxShortTextLength }),
      subjectPlacement: textValue(ownValue(input, 'subjectPlacement', context, path + '.subjectPlacement'), path + '.subjectPlacement', context, { max: context.limits.maxShortTextLength }),
      background: textValue(ownValue(input, 'background', context, path + '.background'), path + '.background', context, { max: context.limits.maxShortTextLength }),
      lighting: textValue(ownValue(input, 'lighting', context, path + '.lighting'), path + '.lighting', context, { max: context.limits.maxShortTextLength }),
      palette: arrayValue(ownValue(input, 'palette', context, path + '.palette'), path + '.palette', context.limits.maxCopyBullets, false).map(function (item, index) {
        return textValue(item, path + '.palette[' + index + ']', context, { max: context.limits.maxShortTextLength });
      }),
      textZones: arrayValue(ownValue(input, 'textZones', context, path + '.textZones'), path + '.textZones', context.limits.maxCopyBullets, false).map(function (item, index) {
        return textValue(item, path + '.textZones[' + index + ']', context, { max: context.limits.maxShortTextLength });
      }),
      density: textValue(ownValue(input, 'density', context, path + '.density'), path + '.density', context, { max: context.limits.maxShortTextLength }),
      transition: textValue(ownValue(input, 'transition', context, path + '.transition'), path + '.transition', context, { max: context.limits.maxShortTextLength }),
      mustKeep: arrayValue(ownValue(input, 'mustKeep', context, path + '.mustKeep'), path + '.mustKeep', context.limits.maxCopyBullets, false).map(function (item, index) {
        return textValue(item, path + '.mustKeep[' + index + ']', context, { max: context.limits.maxShortTextLength });
      }),
      avoid: arrayValue(ownValue(input, 'avoid', context, path + '.avoid'), path + '.avoid', context.limits.maxCopyBullets, false).map(function (item, index) {
        return textValue(item, path + '.avoid[' + index + ']', context, { max: context.limits.maxShortTextLength });
      })
    };
  }

  function moduleIdentity(blueprintId, sourceBlockIds, derivation) {
    return {
      blueprintId: blueprintId,
      kind: derivation.kind,
      sourceBlockIds: sourceBlockIds.slice(),
      parentModuleIds: derivation.parentModuleIds.slice(),
      createdRevision: derivation.createdRevision,
      operationKey: derivation.operationKey
    };
  }

  function deriveBlueprintModuleId(blueprintId, sourceBlockIds, derivation) {
    return stableHash(moduleIdentity(blueprintId, sourceBlockIds, derivation), 'rdm_');
  }

  function sanitizeModuleDerivation(value, path, context) {
    if (!isPlainObject(value)) fail('INVALID_MODULE_DERIVATION', '模块 derivation 必须是普通对象。', path);
    var kind = enumValue(ownValue(value, 'kind', context, path + '.kind'), MODULE_DERIVATION_KINDS, null, path + '.kind');
    var parentModuleIds = arrayValue(ownValue(value, 'parentModuleIds', context, path + '.parentModuleIds'), path + '.parentModuleIds', context.limits.maxRefsPerBlock, false)
      .map(function (id, index) { return idValue(id, path + '.parentModuleIds[' + index + ']', context, { required: true }); });
    if (new Set(parentModuleIds).size !== parentModuleIds.length) fail('DUPLICATE_ID', '模块派生父 ID 不得重复。', path + '.parentModuleIds');
    var createdRevision = positiveIntegerValue(ownValue(value, 'createdRevision', context, path + '.createdRevision'), path + '.createdRevision');
    var operationKey = idValue(ownValue(value, 'operationKey', context, path + '.operationKey'), path + '.operationKey', context, { required: true, max: 120 });
    if (kind === 'source' && (parentModuleIds.length || createdRevision !== 1)) fail('INVALID_MODULE_DERIVATION', 'source 模块必须出生于 revision 1 且无父模块。', path);
    if (kind === 'duplicate' && parentModuleIds.length !== 1) fail('INVALID_MODULE_DERIVATION', 'duplicate 模块必须且只能有一个父模块。', path + '.parentModuleIds');
    if (kind === 'merge' && parentModuleIds.length < 2) fail('INVALID_MODULE_DERIVATION', 'merge 模块至少需要两个父模块。', path + '.parentModuleIds');
    if (kind === 'split' && parentModuleIds.length !== 1) fail('INVALID_MODULE_DERIVATION', 'split 子模块必须且只能有一个父模块。', path + '.parentModuleIds');
    return { kind: kind, parentModuleIds: parentModuleIds, createdRevision: createdRevision, operationKey: operationKey };
  }

  function sanitizeFactBindings(value, path, context, moduleId) {
    var list = arrayValue(value, path, context.limits.maxRefsPerBlock, false);
    var output = [];
    var ids = Object.create(null);
    list.forEach(function (item, index) {
      if (!isPlainObject(item)) fail('INVALID_FACT_BINDING', 'factBinding 必须是普通对象。', path + '[' + index + ']');
      var sourceFactId = idValue(ownValue(item, 'sourceFactId', context, path + '[' + index + '].sourceFactId'), path + '[' + index + '].sourceFactId', context, { required: true });
      var targetField = textValue(ownValue(item, 'targetField', context, path + '[' + index + '].targetField'), path + '[' + index + '].targetField', context, { max: 240 });
      var expectedId = stableHash({ moduleId: moduleId, sourceFactId: sourceFactId, index: index }, 'rdbind_');
      var bindingId = idValue(ownValue(item, 'bindingId', context, path + '[' + index + '].bindingId'), path + '[' + index + '].bindingId', context) || expectedId;
      if (bindingId !== expectedId) fail('ID_MISMATCH', 'bindingId 与模块的来源事实引用不匹配。', path + '[' + index + '].bindingId');
      if (ids[bindingId]) fail('DUPLICATE_ID', 'factBinding ID 重复。', path + '[' + index + '].bindingId');
      ids[bindingId] = true;
      output.push({ bindingId: bindingId, sourceFactId: sourceFactId, targetField: targetField, required: booleanValue(ownValue(item, 'required'), true) });
    });
    return output;
  }

  function sanitizeAssetSlots(value, path, context, moduleId) {
    var list = arrayValue(value, path, context.limits.maxRefsPerBlock, false);
    var output = [];
    var ids = Object.create(null);
    list.forEach(function (item, index) {
      if (!isPlainObject(item)) fail('INVALID_ASSET_SLOT', 'assetSlot 必须是普通对象。', path + '[' + index + ']');
      var sourceAssetId = idValue(ownValue(item, 'sourceAssetId', context, path + '[' + index + '].sourceAssetId'), path + '[' + index + '].sourceAssetId', context, { required: true });
      var role = enumValue(ownValue(item, 'role', context, path + '[' + index + '].role'), ASSET_ROLES, 'unknown', path + '[' + index + '].role');
      var claimedRights = enumValue(ownValue(item, 'rightsStatus', context, path + '[' + index + '].rightsStatus'), RIGHTS_STATUSES, 'reference_only', path + '[' + index + '].rightsStatus');
      if (claimedRights !== 'reference_only' || ownValue(item, 'directUseAllowed') === true || ownValue(item, 'replacementRequired') === false) {
        fail('SOURCE_DERIVATION_MISMATCH', '蓝图来源槽必须保持 reference_only、禁止直接使用且必须替换。', path + '[' + index + ']');
      }
      var rightsStatus = 'reference_only';
      var expectedId = stableHash({ moduleId: moduleId, sourceAssetId: sourceAssetId, index: index }, 'rdslot_');
      var slotId = idValue(ownValue(item, 'slotId', context, path + '[' + index + '].slotId'), path + '[' + index + '].slotId', context) || expectedId;
      if (slotId !== expectedId) fail('ID_MISMATCH', 'slotId 与模块的来源素材引用不匹配。', path + '[' + index + '].slotId');
      if (ids[slotId]) fail('DUPLICATE_ID', 'assetSlot ID 重复。', path + '[' + index + '].slotId');
      ids[slotId] = true;
      output.push({
        slotId: slotId,
        role: role,
        sourceAssetId: sourceAssetId,
        rightsStatus: rightsStatus,
        directUseAllowed: false,
        replacementRequired: true,
        required: booleanValue(ownValue(item, 'required'), true)
      });
    });
    return output;
  }

  function sanitizeTargetAssetSlots(value, path, context, moduleId) {
    var list = arrayValue(value, path, context.limits.maxRefsPerBlock, false);
    var output = [];
    var ids = Object.create(null);
    list.forEach(function (item, index) {
      if (!isPlainObject(item)) fail('INVALID_TARGET_ASSET_SLOT', 'targetAssetSlot 必须是普通对象。', path + '[' + index + ']');
      var sourceSlotId = idValue(ownValue(item, 'sourceSlotId', context, path + '[' + index + '].sourceSlotId'), path + '[' + index + '].sourceSlotId', context, { required: true });
      var targetAssetId = idValue(ownValue(item, 'targetAssetId', context, path + '[' + index + '].targetAssetId'), path + '[' + index + '].targetAssetId', context, { required: true });
      var rightsStatus = enumValue(ownValue(item, 'rightsStatus', context, path + '[' + index + '].rightsStatus'), ['authorized', 'self_owned'], null, path + '[' + index + '].rightsStatus');
      var rightsEvidenceId = idValue(ownValue(item, 'rightsEvidenceId', context, path + '[' + index + '].rightsEvidenceId'), path + '[' + index + '].rightsEvidenceId', context, { required: true });
      var role = enumValue(ownValue(item, 'role', context, path + '[' + index + '].role'), ASSET_ROLES, 'unknown', path + '[' + index + '].role');
      var expectedId = stableHash({ moduleId: moduleId, sourceSlotId: sourceSlotId, targetAssetId: targetAssetId }, 'rdtarget_');
      var targetSlotId = idValue(ownValue(item, 'targetSlotId', context, path + '[' + index + '].targetSlotId'), path + '[' + index + '].targetSlotId', context) || expectedId;
      if (targetSlotId !== expectedId) fail('ID_MISMATCH', 'targetSlotId 与目标素材绑定不匹配。', path + '[' + index + '].targetSlotId');
      if (ids[targetSlotId]) fail('DUPLICATE_ID', 'targetAssetSlot ID 重复。', path + '[' + index + '].targetSlotId');
      ids[targetSlotId] = true;
      output.push({
        targetSlotId: targetSlotId,
        sourceSlotId: sourceSlotId,
        targetAssetId: targetAssetId,
        role: role,
        rightsStatus: rightsStatus,
        rightsEvidenceId: rightsEvidenceId,
        directUseAllowed: true
      });
    });
    return output.sort(function (a, b) {
      return compareCodeUnits(a.sourceSlotId, b.sourceSlotId) || compareCodeUnits(a.targetAssetId, b.targetAssetId) || compareCodeUnits(a.targetSlotId, b.targetSlotId);
    });
  }

  function copyContent(editableCopy) {
    return [editableCopy.headline, editableCopy.body].concat(editableCopy.bullets || [], [editableCopy.cta])
      .join('\n').replace(/\s+/g, ' ').trim();
  }

  var CORE_DIRECTION_URL = /(?:https?:\/\/|www\.|(?:^|[^a-z0-9.-])(?:[a-z0-9-]+\.)+[a-z]{2,24}(?:[\/?#:]|$|[^a-z0-9-]))/i;
  var CORE_DIRECTION_FORBIDDEN = /(?:竞品|对手商品|同行商品|价格|售价|到手价|券后价|原价|现价|优惠价|折扣|满减|销量|月销|已售|成交量|销售量|评价|评论|好评|买家秀|评分|五星|检测|检验|质检|测试报告|认证|证书|资质|专利|品牌|商标|logo|人物|真人|人像|肖像|模特|明星|代言|\b(?:price|sales?|reviews?|ratings?|tested|testing|certification|certificate|patent|brand|logo|person|people|model|celebrity)\b)/i;
  var CORE_DIRECTION_PRICE_VALUE = /(?:[￥¥$]\s*\d|\d+(?:\.\d+)?\s*(?:元|块钱|人民币|rmb|cny|usd))/i;
  var CORE_DIRECTION_SCREEN_ORDINAL = /第\s*(?:\d{1,4}|[零〇一二两三四五六七八九十百千]{1,8})\s*屏/gi;
  var CORE_DIRECTION_VISUAL_COUNT = /(?:(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千半]+)\s*(?:个|组|张|层|段|步|处|种|类|套|份)\s*(?:(?:清晰|温馨|自然|简洁|高级|现代|完整|连贯|统一|独立|主要|核心|重点|日常|家庭|生活|户外|室内|真实|直观|自家|的)\s*){0,8}(?:画面|镜头|视觉|场景|模块|分屏|层级|信息|重点|核心|方向|内容|方式|氛围|风格|结构|节奏|布局|构图|步骤)|(?:一|1)\s*(?:件|个|只|支|枚|片|袋|包|盒|瓶|罐|套|份|颗|粒|双|对|条|台|箱|杯)\s*(?:(?:清晰|完整|主要|核心|重点|真实|自家|的)\s*){0,6}(?:商品|产品|主体))/gi;
  var CORE_DIRECTION_QUANTIFIED_FACT = /(?:^|[^统])(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万亿半]+)\s*(?:%|％|件|个|只|支|枚|片|袋|包|盒|瓶|罐|套|份|颗|粒|双|对|条|台|箱|杯|毫升|升|克|千克|吨|毫米|厘米|米|公里|英寸|寸|毫秒|秒|分钟|小时|天|月|年|伏|瓦|安|毫安|赫兹|分贝|ml|cl|dl|l|mg|kg|g|mm|cm|km|m|mah|wh|kw|w|v|a|hz|db)(?:\b|(?=[^a-z]))/i;
  var CORE_DIRECTION_GENERIC_TERMS = /(?:参考|自家|本屏|第屏|商品|产品|主体|主图|首屏|详情|页面|画面|镜头|视觉|内容|核心|重点|焦点|主题|方向|卖点|利益点|优势|体验|价值|用途|功能|性能|特性|特点|场景|日常|生活|家庭|户外|室内|使用|操作|细节|结构|层级|节奏|布局|构图|角度|光线|色彩|氛围|质感|风格|信息|说明|步骤|流程|组合|关系|展示|呈现|突出|聚焦|表达|传达|强调|强化|营造|建立|介绍|演示|承接|引导|适用|选择|感受|效果|支持|采用|适合|满足|具备|拥有|包含|提供|用于|带来|实现|清晰|直观|真实|温馨|简洁|高级|现代|自然|舒适|便捷|便携|可信|专业|材质|规格|参数|数量|型号|尺寸|成分|容量|包装|工艺|中的|以及|同时|更加|重复|回扣|show|present|highlight|focus|visual|content|product|scene|detail|benefit|feature|layout|mood|experience|direction|screen|module|and|with|for|the|a|an|of|to|in|on|at|by|from|or|as|is|are)/gi;

  function directionOnlyModule(module) {
    return !copyContent(module.editableCopy || emptyEditableCopy());
  }

  function normalizedComparableText(value) {
    return String(value || '').toLowerCase()
      .replace(/[\s\u3000,，。！？!?\.:：;；、'"“”‘’()（）\[\]【】{}<>《》—_\-|\uff5c]+/g, '');
  }

  function assertRawSingleLineDirection(visualBrief, path, context) {
    if (!isPlainObject(visualBrief)) return;
    var raw = ownValue(visualBrief, 'description', context, path + '.description');
    if (raw != null && /[\r\n\u2028\u2029]/.test(String(raw))) {
      fail('INVALID_CORE_DIRECTION', '每屏核心方向必须是单行单句文本。', path + '.description');
    }
  }

  function coreDirectionFactScanText(direction) {
    return String(direction || '')
      .replace(CORE_DIRECTION_SCREEN_ORDINAL, '')
      .replace(CORE_DIRECTION_VISUAL_COUNT, '');
  }

  function appendComparableFactValues(value, output, depth) {
    if (depth > 8 || value == null || typeof value === 'boolean') return;
    if (typeof value === 'string' || typeof value === 'number') {
      var normalized = normalizedComparableText(value);
      if (normalized) output.push(normalized);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(function (item) { appendComparableFactValues(item, output, depth + 1); });
      return;
    }
    if (!isPlainObject(value)) return;
    Object.keys(value).sort(compareCodeUnits).forEach(function (key) {
      appendComparableFactValues(ownValue(value, key), output, depth + 1);
    });
  }

  function sourceFactNeedles(snapshot) {
    var output = [];
    (snapshot && snapshot.facts || []).forEach(function (fact) {
      var values = [];
      appendComparableFactValues(fact.value, values, 0);
      values.forEach(function (value) {
        if (value.length >= 2 && specificSourceFragment(value)) output.push(value);
        var valueWithUnit = normalizedComparableText(value + String(fact.unit || ''));
        if (valueWithUnit.length >= 2 && specificSourceFragment(valueWithUnit)) output.push(valueWithUnit);
      });
    });
    return Array.from(new Set(output)).sort(compareCodeUnits);
  }

  function specificSourceFragment(value) {
    var remaining = String(value || '').replace(CORE_DIRECTION_GENERIC_TERMS, '')
      .replace(/[的与和及在中内为以于并将从把让更又可能对由或向前后上下作]/g, '');
    return remaining.length >= 2;
  }

  function directionContainsSourceFragment(normalizedDirection, sourceCopy) {
    var clauses = String(sourceCopy || '').split(/[\s　,，。！？!?：:;；、|]+/);
    for (var clauseIndex = 0; clauseIndex < clauses.length; clauseIndex++) {
      var clause = normalizedComparableText(clauses[clauseIndex]);
      if (!clause) continue;
      if (clause.length >= 2 && normalizedDirection.indexOf(clause) >= 0 && specificSourceFragment(clause)) return true;
      if (clause.length < 4) continue;
      for (var directionIndex = 0; directionIndex + 4 <= normalizedDirection.length; directionIndex++) {
        var fragment = normalizedDirection.slice(directionIndex, directionIndex + 4);
        if (specificSourceFragment(fragment) && clause.indexOf(fragment) >= 0) return true;
      }
    }
    return false;
  }

  function assertSafeCoreDirection(module, path, snapshot) {
    var direction = String(module.visualBrief && module.visualBrief.description || '').trim();
    if (!direction) {
      fail('CORE_DIRECTION_REQUIRED', 'editableCopy 全空时，必须填写一句本屏核心描述方向。', path + '.visualBrief.description');
    }
    if (direction.length > 160 || /[\r\n\u2028\u2029]/.test(direction)) {
      fail('INVALID_CORE_DIRECTION', '每屏核心方向必须为 1–160 字的单行单句文本。', path + '.visualBrief.description');
    }
    if (CORE_DIRECTION_URL.test(direction) || CORE_DIRECTION_FORBIDDEN.test(direction) || CORE_DIRECTION_PRICE_VALUE.test(direction)) {
      fail('UNSAFE_CORE_DIRECTION', '每屏核心方向不得包含 URL、竞品、价格、销量、评价、检测认证、品牌 Logo 或人物信息。', path + '.visualBrief.description');
    }
    var withoutTerminal = direction.replace(/[。！？!?；;\.]+$/g, '');
    if (/[。！？!?；;\.]/.test(withoutTerminal)) {
      fail('INVALID_CORE_DIRECTION', '每屏核心方向必须为 1–160 字的单行单句文本。', path + '.visualBrief.description');
    }
    var normalizedDirection = normalizedComparableText(direction);
    [module.sourceSummary, module.sourceCopy].forEach(function (sourceText) {
      var normalizedSource = normalizedComparableText(sourceText);
      if (normalizedSource && (normalizedDirection === normalizedSource || normalizedDirection.indexOf(normalizedSource) >= 0)) {
        fail('COPY_REWRITE_REQUIRED', '每屏核心方向不得等同或包含来源摘要、原文。', path + '.visualBrief.description');
      }
    });
    var factScanText = coreDirectionFactScanText(direction);
    var normalizedFactScanText = normalizedComparableText(factScanText);
    if (CORE_DIRECTION_QUANTIFIED_FACT.test(factScanText) || sourceFactNeedles(snapshot).some(function (needle) {
      return normalizedFactScanText.indexOf(needle) >= 0;
    }) || directionContainsSourceFragment(normalizedFactScanText, module.sourceCopy)) {
      fail('HARD_CODED_CORE_FACT', '每屏核心方向只能描述传播意图；数量、规格、品牌、认证等具体事实必须由各目标事实卡注入，不得写死来源或某一张卡的事实。', path + '.visualBrief.description');
    }
    return direction;
  }

  function assertUniqueSelectedCoreDirections(blueprint) {
    var owners = Object.create(null);
    blueprint.modules.forEach(function (module, moduleIndex) {
      if (!module.selected || !directionOnlyModule(module)) return;
      var path = '$.modules[' + moduleIndex + ']';
      var comparable = normalizedComparableText(module.visualBrief && module.visualBrief.description);
      if (!comparable) return;
      if (owners[comparable] != null) {
        fail('SCREEN_DIRECTION_DUPLICATE', '每个最终分屏必须有独立的一句话定位，不得与其他屏重复。', path + '.visualBrief.description');
      }
      owners[comparable] = moduleIndex;
    });
  }

  function hasReusableTargetAsset(assetRegistry) {
    return Object.keys(assetRegistry).some(function (assetId) {
      var asset = assetRegistry[assetId];
      return asset.rightsStatus === 'authorized' || asset.rightsStatus === 'self_owned';
    });
  }

  function sourceSecurityRiskFlags(assetSlots, sourceCopy, editableCopy) {
    var flags = [];
    (assetSlots || []).forEach(function (slot) {
      if (slot.rightsStatus === 'reference_only') flags.push('REFERENCE_ONLY_ASSET');
      if (slot.rightsStatus === 'unknown') flags.push('UNKNOWN_ASSET_RIGHTS');
      if (slot.rightsStatus === 'blocked') flags.push('BLOCKED_ASSET');
    });
    var normalizedSource = String(sourceCopy || '').replace(/\s+/g, ' ').trim();
    var normalizedTarget = copyContent(editableCopy || emptyEditableCopy());
    if (normalizedSource && (!normalizedTarget || normalizedTarget === normalizedSource)) flags.push('COPY_REWRITE_REQUIRED');
    return Array.from(new Set(flags)).sort(compareCodeUnits);
  }

  function sanitizeModule(item, index, context, blueprintId, approvalStatus) {
    var path = '$.modules[' + index + ']';
    if (!isPlainObject(item)) fail('INVALID_MODULE', '蓝图模块必须是普通对象。', path);
    var rawModuleId = ownValue(item, 'moduleId', context, path + '.moduleId');
    var rawBlockAlias = ownValue(item, 'blockId', context, path + '.blockId');
    var moduleId = idValue(rawModuleId == null ? rawBlockAlias : rawModuleId, path + '.moduleId', context, { required: true });
    if (rawBlockAlias != null && idValue(rawBlockAlias, path + '.blockId', context, { required: true }) !== moduleId) {
      fail('ID_MISMATCH', '兼容 blockId 必须与 moduleId 一致。', path + '.blockId');
    }
    var sourceBlockIds = arrayValue(ownValue(item, 'sourceBlockIds', context, path + '.sourceBlockIds'), path + '.sourceBlockIds', context.limits.maxRefsPerBlock, true)
      .map(function (id, sourceIndex) { return idValue(id, path + '.sourceBlockIds[' + sourceIndex + ']', context, { required: true }); });
    if (!sourceBlockIds.length) fail('REQUIRED_FIELD', '模块 sourceBlockIds 不得为空。', path + '.sourceBlockIds');
    if (new Set(sourceBlockIds).size !== sourceBlockIds.length) fail('DUPLICATE_ID', 'sourceBlockIds 不得重复。', path + '.sourceBlockIds');
    var derivation = sanitizeModuleDerivation(ownValue(item, 'derivation', context, path + '.derivation'), path + '.derivation', context);
    var expectedModuleId = deriveBlueprintModuleId(blueprintId, sourceBlockIds, derivation);
    if (moduleId !== expectedModuleId) fail('ID_MISMATCH', 'moduleId 与模块派生载荷不匹配。', path + '.moduleId');
    var sourceBlockId = idValue(ownValue(item, 'sourceBlockId', context, path + '.sourceBlockId'), path + '.sourceBlockId', context);
    var expectedLegacySource = sourceBlockIds.length === 1 ? sourceBlockIds[0] : '';
    if (sourceBlockId && sourceBlockId !== expectedLegacySource) fail('SOURCE_DERIVATION_MISMATCH', 'sourceBlockId 兼容字段与 sourceBlockIds 不一致。', path + '.sourceBlockId');
    var riskFlags = arrayValue(ownValue(item, 'riskFlags', context, path + '.riskFlags'), path + '.riskFlags', context.limits.maxRiskFlags, false)
      .map(function (flag, flagIndex) {
        flag = textValue(flag, path + '.riskFlags[' + flagIndex + ']', context, { required: true, max: 80 });
        if (!SAFE_RISK_FLAG.test(flag)) fail('INVALID_RISK_FLAG', 'riskFlag 必须是大写下划线标识。', path + '.riskFlags[' + flagIndex + ']');
        return flag;
      });
    var editableCopy = sanitizeEditableCopy(ownValue(item, 'editableCopy', context, path + '.editableCopy'), path + '.editableCopy', context);
    var visualBriefInput = ownValue(item, 'visualBrief', context, path + '.visualBrief');
    if (approvalStatus === 'approved' && !copyContent(editableCopy)) {
      assertRawSingleLineDirection(visualBriefInput, path + '.visualBrief', context);
    }
    var sourceCopy = textValue(ownValue(item, 'sourceCopy', context, path + '.sourceCopy'), path + '.sourceCopy', context, { max: context.limits.maxTextLength });
    var assetSlots = sanitizeAssetSlots(ownValue(item, 'assetSlots', context, path + '.assetSlots'), path + '.assetSlots', context, moduleId);
    var targetAssetSlots = sanitizeTargetAssetSlots(ownValue(item, 'targetAssetSlots', context, path + '.targetAssetSlots'), path + '.targetAssetSlots', context, moduleId);
    var sourceSlotIds = Object.create(null);
    assetSlots.forEach(function (slot) { sourceSlotIds[slot.slotId] = true; });
    targetAssetSlots.forEach(function (slot, slotIndex) {
      if (!sourceSlotIds[slot.sourceSlotId]) fail('UNKNOWN_SOURCE_SLOT', '目标素材槽必须关联当前模块的来源槽。', path + '.targetAssetSlots[' + slotIndex + '].sourceSlotId');
    });
    return {
      moduleId: moduleId,
      blockId: moduleId,
      sourceBlockIds: sourceBlockIds,
      sourceBlockId: expectedLegacySource,
      derivation: derivation,
      originalIndex: nonNegativeIntegerValue(ownValue(item, 'originalIndex', context, path + '.originalIndex'), path + '.originalIndex'),
      order: nonNegativeIntegerValue(ownValue(item, 'order', context, path + '.order'), path + '.order'),
      type: enumValue(ownValue(item, 'type', context, path + '.type'), BLOCK_TYPES, 'unknown', path + '.type'),
      salesRole: enumValue(ownValue(item, 'salesRole', context, path + '.salesRole'), SALES_ROLES, 'unknown', path + '.salesRole'),
      sourceSummary: textValue(ownValue(item, 'sourceSummary', context, path + '.sourceSummary'), path + '.sourceSummary', context, { max: context.limits.maxShortTextLength }),
      sourceCopy: sourceCopy,
      editableCopy: editableCopy,
      visualBrief: sanitizeVisualBrief(visualBriefInput, path + '.visualBrief', context),
      factBindings: sanitizeFactBindings(ownValue(item, 'factBindings', context, path + '.factBindings'), path + '.factBindings', context, moduleId),
      assetSlots: assetSlots,
      targetAssetSlots: targetAssetSlots,
      selected: booleanValue(ownValue(item, 'selected'), true),
      locked: booleanValue(ownValue(item, 'locked'), false),
      riskFlags: Array.from(new Set(riskFlags)).sort(compareCodeUnits)
    };
  }

  function sanitizeBlueprintApproval(input, approvalStatus, context) {
    input = isPlainObject(input) ? input : {};
    if (approvalStatus !== 'approved') {
      return { approvedAt: '', verificationId: '', productFactCardIds: [] };
    }
    var approvedAt = timestampValue(ownValue(input, 'approvedAt', context, '$.approval.approvedAt'), '$.approval.approvedAt', context);
    var verificationId = idValue(ownValue(input, 'verificationId', context, '$.approval.verificationId'), '$.approval.verificationId', context, { required: true });
    var cards = arrayValue(ownValue(input, 'productFactCardIds', context, '$.approval.productFactCardIds'), '$.approval.productFactCardIds', context.limits.maxBatchTasks, true)
      .map(function (id, index) { return idValue(id, '$.approval.productFactCardIds[' + index + ']', context, { required: true }); });
    cards = Array.from(new Set(cards)).sort(compareCodeUnits);
    if (!cards.length) fail('FACT_CARD_REQUIRED', '审核通过的蓝图必须绑定至少一个经核验的目标事实卡。', '$.approval.productFactCardIds');
    return { approvedAt: approvedAt, verificationId: verificationId, productFactCardIds: cards };
  }

  function sanitizeBlueprint(input, options) {
    var context = createContext(options);
    if (!isPlainObject(input)) fail('INVALID_CONTRACT', '蓝图必须是普通对象。', '$');
    if (ownValue(input, 'schema', context, '$.schema') !== BLUEPRINT_SCHEMA) fail('INVALID_SCHEMA', '蓝图 schema 无效。', '$.schema');
    if (Number(ownValue(input, 'schemaVersion', context, '$.schemaVersion')) !== SCHEMA_VERSION) fail('INVALID_SCHEMA_VERSION', 'schemaVersion 必须为 1。', '$.schemaVersion');
    var sourceSnapshotId = idValue(ownValue(input, 'sourceSnapshotId', context, '$.sourceSnapshotId'), '$.sourceSnapshotId', context, { required: true });
    var blueprintId = idValue(ownValue(input, 'blueprintId', context, '$.blueprintId'), '$.blueprintId', context) || stableHash(sourceSnapshotId, 'rdp_');
    var revision = positiveIntegerValue(ownValue(input, 'revision', context, '$.revision'), '$.revision');
    var expectedBlueprintId = stableHash(sourceSnapshotId, 'rdp_');
    if (blueprintId !== expectedBlueprintId) fail('ID_MISMATCH', 'blueprintId 与 sourceSnapshotId 的稳定身份不匹配。', '$.blueprintId');
    var createdAt = timestampValue(ownValue(input, 'createdAt', context, '$.createdAt'), '$.createdAt', context);
    var updatedAt = timestampValue(ownValue(input, 'updatedAt', context, '$.updatedAt'), '$.updatedAt', context, createdAt);
    var approvalStatus = enumValue(ownValue(input, 'approvalStatus', context, '$.approvalStatus'), BLUEPRINT_APPROVAL_STATUSES, 'draft', '$.approvalStatus');
    var modulesInput = arrayValue(ownValue(input, 'modules', context, '$.modules'), '$.modules', context.limits.maxBlocks, true);
    var modules = [];
    var blockIds = Object.create(null);
    modulesInput.forEach(function (item, index) {
      var module = sanitizeModule(item, index, context, blueprintId, approvalStatus);
      if (blockIds[module.moduleId]) fail('DUPLICATE_ID', '蓝图 moduleId 重复。', '$.modules[' + index + '].moduleId');
      if (module.order >= modulesInput.length || modules.some(function (candidate) { return candidate.order === module.order; })) {
        fail('INVALID_MODULE_ORDER', '模块 order 必须是 0..n-1 的唯一整数。', '$.modules[' + index + '].order');
      }
      blockIds[module.moduleId] = true;
      modules.push(module);
    });
    if (!modules.length) fail('REQUIRED_FIELD', '蓝图至少需要一个模块。', '$.modules');
    modules.sort(function (a, b) { return a.order - b.order; });
    sanitizeInputWarnings(ownValue(input, 'warnings', context, '$.warnings'), context);
    var approval = sanitizeBlueprintApproval(ownValue(input, 'approval', context, '$.approval'), approvalStatus, context);
    return deepFreeze({
      schema: BLUEPRINT_SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      blueprintId: blueprintId,
      sourceSnapshotId: sourceSnapshotId,
      revision: revision,
      approvalStatus: approvalStatus,
      approval: approval,
      createdAt: createdAt,
      updatedAt: updatedAt,
      modules: modules,
      warnings: sortedIssues(context)
    });
  }

  function snapshotLookup(snapshot) {
    var blocks = Object.create(null);
    var assets = Object.create(null);
    snapshot.orderedBlocks.forEach(function (block) { blocks[block.blockId] = block; });
    snapshot.assets.forEach(function (asset) { assets[asset.assetId] = asset; });
    return { blocks: blocks, assets: assets };
  }

  function canonicalSourceBlockIds(sourceBlockIds, snapshot, path) {
    var lookup = snapshotLookup(snapshot).blocks;
    var seen = Object.create(null);
    var output = sourceBlockIds.map(function (sourceBlockId, index) {
      if (!lookup[sourceBlockId]) fail('UNKNOWN_SOURCE_BLOCK', 'sourceBlockIds 引用了不存在的来源块。', path + '[' + index + ']');
      if (seen[sourceBlockId]) fail('DUPLICATE_ID', 'sourceBlockIds 不得重复。', path + '[' + index + ']');
      seen[sourceBlockId] = true;
      return sourceBlockId;
    });
    return output.sort(function (a, b) {
      return lookup[a].originalIndex - lookup[b].originalIndex || compareCodeUnits(a, b);
    });
  }

  function targetFieldMap(module) {
    var output = Object.create(null);
    (module && module.factBindings || []).forEach(function (binding) { output[binding.sourceFactId] = binding.targetField || ''; });
    return output;
  }

  function deriveModuleSourceBundle(snapshot, moduleId, sourceBlockIds, editableCopy) {
    var lookup = snapshotLookup(snapshot);
    var summaries = [];
    var copies = [];
    var factIds = [];
    var assetIds = [];
    var factSeen = Object.create(null);
    var assetSeen = Object.create(null);
    var riskFlags = [];
    sourceBlockIds.forEach(function (sourceBlockId) {
      var block = lookup.blocks[sourceBlockId];
      var summary = block.sourceSummary || block.text.slice(0, 240) || (block.assetIds.length ? ('素材模块（' + block.assetIds.length + ' 项）') : '未识别模块');
      if (summary && summaries.indexOf(summary) < 0) summaries.push(summary);
      if (block.text) copies.push(block.text);
      block.factIds.forEach(function (factId) {
        if (!factSeen[factId]) { factSeen[factId] = true; factIds.push(factId); }
      });
      block.assetIds.forEach(function (assetId) {
        if (!assetSeen[assetId]) { assetSeen[assetId] = true; assetIds.push(assetId); }
      });
      riskFlags = riskFlags.concat(riskFlagsForBlock(block, lookup.assets));
    });
    var sourceSummary = summaries.join(' | ');
    var sourceCopy = copies.join(' ');
    var assetSlots = assetIds.map(function (assetId, index) {
      var asset = lookup.assets[assetId];
      return {
        slotId: stableHash({ moduleId: moduleId, sourceAssetId: assetId, index: index }, 'rdslot_'),
        role: asset ? asset.role : 'unknown',
        sourceAssetId: assetId,
        rightsStatus: 'reference_only',
        directUseAllowed: false,
        replacementRequired: true,
        required: true
      };
    });
    riskFlags = riskFlags.concat(sourceSecurityRiskFlags(assetSlots, sourceCopy, editableCopy || emptyEditableCopy()));
    return {
      sourceSummary: sourceSummary,
      sourceCopy: sourceCopy,
      originalIndex: lookup.blocks[sourceBlockIds[0]].originalIndex,
      factIds: factIds,
      assetSlots: assetSlots,
      riskFlags: Array.from(new Set(riskFlags)).sort(compareCodeUnits)
    };
  }

  function buildDerivedModule(snapshot, blueprintId, sourceBlockIds, derivation, seed) {
    seed = isPlainObject(seed) ? seed : {};
    sourceBlockIds = canonicalSourceBlockIds(sourceBlockIds, snapshot, '$derived.sourceBlockIds');
    var moduleId = deriveBlueprintModuleId(blueprintId, sourceBlockIds, derivation);
    var editableCopy = ownValue(seed, 'editableCopy') || emptyEditableCopy();
    var bundle = deriveModuleSourceBundle(snapshot, moduleId, sourceBlockIds, editableCopy);
    var fields = ownValue(seed, 'targetFieldByFact') || targetFieldMap(seed);
    var firstBlock = snapshotLookup(snapshot).blocks[sourceBlockIds[0]];
    return {
      moduleId: moduleId,
      blockId: moduleId,
      sourceBlockIds: sourceBlockIds,
      sourceBlockId: sourceBlockIds.length === 1 ? sourceBlockIds[0] : '',
      derivation: cloneJson(derivation),
      originalIndex: bundle.originalIndex,
      order: ownValue(seed, 'order') == null ? 0 : ownValue(seed, 'order'),
      type: ownValue(seed, 'type') || (sourceBlockIds.length === 1 ? firstBlock.type : 'mixed'),
      salesRole: ownValue(seed, 'salesRole') || (sourceBlockIds.length === 1 ? firstBlock.salesRole : 'unknown'),
      sourceSummary: bundle.sourceSummary,
      sourceCopy: bundle.sourceCopy,
      editableCopy: cloneJson(editableCopy),
      visualBrief: cloneJson(ownValue(seed, 'visualBrief') || { description: bundle.sourceSummary, layout: '', mood: '', mustKeep: [], avoid: [] }),
      factBindings: bundle.factIds.map(function (factId, index) {
        return {
          bindingId: stableHash({ moduleId: moduleId, sourceFactId: factId, index: index }, 'rdbind_'),
          sourceFactId: factId,
          targetField: fields[factId] || '',
          required: true
        };
      }),
      assetSlots: bundle.assetSlots,
      targetAssetSlots: [],
      selected: ownValue(seed, 'selected') === false ? false : true,
      locked: ownValue(seed, 'locked') === true,
      riskFlags: bundle.riskFlags
    };
  }

  function mergeSeedFromParents(parents) {
    var mergedTargetFields = Object.create(null);
    var conflictingFacts = Object.create(null);
    parents.forEach(function (parent) {
      parent.factBindings.forEach(function (binding) {
        if (!binding.targetField) return;
        if (mergedTargetFields[binding.sourceFactId] && mergedTargetFields[binding.sourceFactId] !== binding.targetField) {
          conflictingFacts[binding.sourceFactId] = true;
        } else {
          mergedTargetFields[binding.sourceFactId] = binding.targetField;
        }
      });
    });
    Object.keys(conflictingFacts).forEach(function (factId) { mergedTargetFields[factId] = ''; });
    return {
      editableCopy: emptyEditableCopy(),
      visualBrief: null,
      type: 'mixed',
      salesRole: 'unknown',
      selected: parents.some(function (parent) { return parent.selected; }),
      locked: false,
      targetFieldByFact: mergedTargetFields
    };
  }

  function createBlueprintFromSnapshot(snapshotInput, options) {
    options = isPlainObject(options) ? options : {};
    var snapshot = sanitizeSourceSnapshot(snapshotInput, options);
    var createdAt = timestampValue(ownValue(options, 'createdAt'), '$options.createdAt', createContext(options), snapshot.source.capturedAt);
    var requestedApprovalStatus = ownValue(options, 'approvalStatus');
    if (requestedApprovalStatus != null && requestedApprovalStatus !== 'draft') {
      fail('APPROVAL_REQUIRES_TRUSTED_TRANSITION', '首次蓝图只能是 draft；审核必须调用显式可信迁移。', '$options.approvalStatus');
    }
    var raw = {
      schema: BLUEPRINT_SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      blueprintId: stableHash(snapshot.snapshotId, 'rdp_'),
      sourceSnapshotId: snapshot.snapshotId,
      revision: 1,
      approvalStatus: 'draft',
      approval: { approvedAt: '', verificationId: '', productFactCardIds: [] },
      createdAt: createdAt,
      updatedAt: createdAt,
      modules: snapshot.orderedBlocks.map(function (block, index) {
        return buildDerivedModule(snapshot, stableHash(snapshot.snapshotId, 'rdp_'), [block.blockId], {
          kind: 'source', parentModuleIds: [], createdRevision: 1, operationKey: 'source_' + index
        }, {
          order: index,
          type: block.type,
          salesRole: block.salesRole,
          selected: block.completeness !== 'blocked'
        });
      })
    };
    return sanitizeBlueprint(raw, options);
  }

  function reviseBlueprint(blueprintInput, changes, options) {
    changes = isPlainObject(changes) ? changes : {};
    options = isPlainObject(options) ? options : {};
    var sourceSnapshotInput = ownValue(options, 'sourceSnapshot');
    if (!sourceSnapshotInput) fail('SOURCE_SNAPSHOT_REQUIRED', '修订蓝图必须提供可信不可变来源快照。', '$options.sourceSnapshot');
    var checked = assertBlueprintAgainstSource(blueprintInput, sourceSnapshotInput, options);
    var blueprint = checked.blueprint;
    var snapshot = checked.snapshot;
    var raw = cloneJson(blueprint);
    var edits = arrayValue(ownValue(changes, 'moduleEdits'), '$changes.moduleEdits', normalizedLimits(options).maxBlocks, false);
    var byId = Object.create(null);
    raw.modules.forEach(function (module) { byId[module.moduleId] = module; });
    var seenEdits = Object.create(null);
    edits.forEach(function (edit, index) {
      if (!isPlainObject(edit)) fail('INVALID_MODULE_EDIT', 'moduleEdit 必须是普通对象。', '$changes.moduleEdits[' + index + ']');
      var moduleId = String(ownValue(edit, 'moduleId') || ownValue(edit, 'blockId') || '');
      if (!byId[moduleId] || seenEdits[moduleId]) fail('UNKNOWN_OR_DUPLICATE_MODULE', 'moduleEdit moduleId 不存在或重复。', '$changes.moduleEdits[' + index + '].moduleId');
      seenEdits[moduleId] = true;
      if (ownValue(edit, 'moduleId') != null && ownValue(edit, 'blockId') != null && String(ownValue(edit, 'moduleId')) !== String(ownValue(edit, 'blockId'))) {
        fail('ID_MISMATCH', 'moduleEdit blockId 兼容值必须与 moduleId 一致。', '$changes.moduleEdits[' + index + '].blockId');
      }
      ['sourceBlockIds', 'sourceBlockId', 'derivation', 'originalIndex', 'sourceSummary', 'sourceCopy', 'factBindings', 'assetSlots', 'targetAssetSlots', 'riskFlags'].forEach(function (key) {
        if (ownDescriptor(edit, key)) fail('IMMUTABLE_DERIVED_FIELD', '来源派生字段不能通过普通修订覆盖。', '$changes.moduleEdits[' + index + '].' + key);
      });
      ['type', 'salesRole', 'editableCopy', 'visualBrief', 'selected', 'locked'].forEach(function (key) {
        var descriptor = ownDescriptor(edit, key);
        if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) byId[moduleId][key] = descriptor.value;
      });
      if (ownDescriptor(edit, 'visualBrief')) {
        var pendingCopy = sanitizeEditableCopy(byId[moduleId].editableCopy, '$changes.moduleEdits[' + index + '].editableCopy', createContext(options));
        if (!copyContent(pendingCopy)) {
          assertRawSingleLineDirection(byId[moduleId].visualBrief, '$changes.moduleEdits[' + index + '].visualBrief', createContext(options));
        }
      }
      var bindingEdits = arrayValue(ownValue(edit, 'factBindingEdits'), '$changes.moduleEdits[' + index + '].factBindingEdits', normalizedLimits(options).maxRefsPerBlock, false);
      var bindingById = Object.create(null);
      byId[moduleId].factBindings.forEach(function (binding) { bindingById[binding.bindingId] = binding; });
      var seenBindings = Object.create(null);
      bindingEdits.forEach(function (bindingEdit, bindingIndex) {
        if (!isPlainObject(bindingEdit)) fail('INVALID_FACT_BINDING_EDIT', 'factBindingEdit 必须是普通对象。', '$changes.moduleEdits[' + index + '].factBindingEdits[' + bindingIndex + ']');
        var bindingId = String(ownValue(bindingEdit, 'bindingId') || '');
        if (!bindingById[bindingId] || seenBindings[bindingId]) fail('UNKNOWN_OR_DUPLICATE_BINDING', 'bindingId 不存在或重复。', '$changes.moduleEdits[' + index + '].factBindingEdits[' + bindingIndex + '].bindingId');
        if (ownDescriptor(bindingEdit, 'sourceFactId') || ownDescriptor(bindingEdit, 'required')) {
          fail('IMMUTABLE_DERIVED_FIELD', '来源事实身份与 required 不能通过普通修订覆盖。', '$changes.moduleEdits[' + index + '].factBindingEdits[' + bindingIndex + ']');
        }
        seenBindings[bindingId] = true;
        bindingById[bindingId].targetField = ownValue(bindingEdit, 'targetField');
      });
    });
    var operationsValue = ownValue(changes, 'operations');
    var planValue = ownValue(changes, 'modulePlan');
    if (operationsValue != null && planValue != null) fail('INVALID_MODULE_OPERATION', 'operations 与 modulePlan 不得同时提供。', '$changes.operations');
    var operations = arrayValue(operationsValue != null ? operationsValue : planValue, '$changes.operations', normalizedLimits(options).maxBlocks, false);
    if (operations.length) {
      if (ownDescriptor(changes, 'moduleOrder')) fail('INVALID_MODULE_ORDER', '结构 operations 的顺序就是最终顺序，不得再提交 moduleOrder。', '$changes.moduleOrder');
      var previousById = Object.create(null);
      raw.modules.forEach(function (module) { previousById[module.moduleId] = module; });
      var trustedPreviousById = Object.create(null);
      blueprint.modules.forEach(function (module) { trustedPreviousById[module.moduleId] = module; });
      var accounted = Object.create(null);
      var operationKeys = Object.create(null);
      var duplicatedParents = Object.create(null);
      var splitConsumedParents = Object.create(null);
      var nextModules = [];
      operations.forEach(function (operation, operationIndex) {
        var path = '$changes.operations[' + operationIndex + ']';
        if (!isPlainObject(operation)) fail('INVALID_MODULE_OPERATION', '模块操作必须是普通对象。', path);
        var op = String(ownValue(operation, 'op') || '');
        if (op === 'keep' || op === 'delete') {
          var existingId = idValue(ownValue(operation, 'moduleId'), path + '.moduleId', createContext(options), { required: true });
          if (!previousById[existingId] || accounted[existingId]) fail('UNKNOWN_OR_DUPLICATE_MODULE', '模块不存在或已被其他结构操作消费。', path + '.moduleId');
          if (op === 'delete' && trustedPreviousById[existingId].locked) {
            fail('MODULE_LOCKED', '已锁定模块不得被直接删除；请先单独解锁。', path + '.moduleId');
          }
          accounted[existingId] = true;
          if (op === 'keep') nextModules.push(previousById[existingId]);
          return;
        }
        if (op === 'split') {
          var splitParentId = idValue(ownValue(operation, 'sourceModuleId') || ownValue(operation, 'moduleId'), path + '.sourceModuleId', createContext(options), { required: true });
          var splitParent = previousById[splitParentId];
          var trustedSplitParent = trustedPreviousById[splitParentId];
          if (!splitParent) fail('UNKNOWN_SOURCE_MODULE', 'split 只能引用可信上一 revision 模块。', path + '.sourceModuleId');
          if (accounted[splitParentId]) fail('UNKNOWN_OR_DUPLICATE_MODULE', 'split 父模块已被其他结构操作消费。', path + '.sourceModuleId');
          if (splitParent.locked || trustedSplitParent.locked) fail('MODULE_LOCKED', '已锁定模块不得拆分。', path + '.sourceModuleId');
          if (seenEdits[splitParentId]) fail('INVALID_MODULE_OPERATION', 'split 父模块不得在同一 revision 同时普通编辑；请先提交编辑 revision。', path + '.sourceModuleId');
          if (duplicatedParents[splitParentId]) fail('INVALID_MODULE_OPERATION', 'split 对父模块独占结构消费，同一 revision 不得同时 duplicate。', path + '.sourceModuleId');
          var splitParts = arrayValue(ownValue(operation, 'parts'), path + '.parts', normalizedLimits(options).maxRefsPerBlock, true);
          if (splitParts.length < 2) fail('INVALID_MODULE_SPLIT', 'split 必须包含至少两个非空分组。', path + '.parts');
          var splitParentSources = Object.create(null);
          splitParent.sourceBlockIds.forEach(function (sourceBlockId) { splitParentSources[sourceBlockId] = true; });
          var splitCoveredSources = Object.create(null);
          splitParts.forEach(function (part, partIndex) {
            var partPath = path + '.parts[' + partIndex + ']';
            if (!isPlainObject(part)) fail('INVALID_MODULE_SPLIT', 'split part 必须是普通对象。', partPath);
            var partSourceIds = arrayValue(ownValue(part, 'sourceBlockIds'), partPath + '.sourceBlockIds', normalizedLimits(options).maxRefsPerBlock, true)
              .map(function (id, sourceIndex) { return idValue(id, partPath + '.sourceBlockIds[' + sourceIndex + ']', createContext(options), { required: true }); });
            if (!partSourceIds.length) fail('INVALID_MODULE_SPLIT', 'split 每个分组的 sourceBlockIds 不得为空。', partPath + '.sourceBlockIds');
            partSourceIds = canonicalSourceBlockIds(partSourceIds, snapshot, partPath + '.sourceBlockIds');
            partSourceIds.forEach(function (sourceBlockId) {
              if (!splitParentSources[sourceBlockId]) fail('INVALID_MODULE_SPLIT', 'split 分组不得包含父模块 lineage 之外的来源块。', partPath + '.sourceBlockIds');
              if (splitCoveredSources[sourceBlockId]) fail('INVALID_MODULE_SPLIT', 'split 分组必须互斥，不得重叠消费来源块。', partPath + '.sourceBlockIds');
              splitCoveredSources[sourceBlockId] = true;
            });
            var splitOperationKey = idValue(ownValue(part, 'operationKey'), partPath + '.operationKey', createContext(options), { required: true, max: 120 });
            if (operationKeys[splitOperationKey]) fail('DUPLICATE_OPERATION_KEY', '同一 revision 的派生 operationKey 必须唯一。', partPath + '.operationKey');
            operationKeys[splitOperationKey] = true;
            nextModules.push(buildDerivedModule(snapshot, blueprint.blueprintId, partSourceIds, {
              kind: 'split',
              parentModuleIds: [splitParentId],
              createdRevision: blueprint.revision + 1,
              operationKey: splitOperationKey
            }, trustedSplitParent));
          });
          if (Object.keys(splitCoveredSources).length !== splitParent.sourceBlockIds.length ||
              splitParent.sourceBlockIds.some(function (sourceBlockId) { return !splitCoveredSources[sourceBlockId]; })) {
            fail('INVALID_MODULE_SPLIT', 'split 分组必须精确覆盖父模块的全部 sourceBlockIds。', path + '.parts');
          }
          accounted[splitParentId] = true;
          splitConsumedParents[splitParentId] = true;
          return;
        }
        if (op !== 'duplicate' && op !== 'merge') fail('INVALID_MODULE_OPERATION', '只支持 keep/delete/duplicate/merge/split 模块操作。', path + '.op');
        var parentIds;
        if (op === 'duplicate') {
          parentIds = [idValue(ownValue(operation, 'sourceModuleId') || ownValue(operation, 'moduleId'), path + '.sourceModuleId', createContext(options), { required: true })];
        } else {
          parentIds = arrayValue(ownValue(operation, 'sourceModuleIds'), path + '.sourceModuleIds', normalizedLimits(options).maxRefsPerBlock, true)
            .map(function (id, index) { return idValue(id, path + '.sourceModuleIds[' + index + ']', createContext(options), { required: true }); });
          if (parentIds.length < 2 || new Set(parentIds).size !== parentIds.length) fail('INVALID_MODULE_OPERATION', 'merge 需要至少两个不重复父模块。', path + '.sourceModuleIds');
        }
        parentIds.forEach(function (parentId) {
          if (!previousById[parentId]) fail('UNKNOWN_SOURCE_MODULE', '派生操作只能引用可信上一 revision 模块。', path);
        });
        parentIds.sort(function (a, b) { return previousById[a].order - previousById[b].order || compareCodeUnits(a, b); });
        if (op === 'duplicate') {
          if (splitConsumedParents[parentIds[0]]) {
            fail('INVALID_MODULE_OPERATION', 'split 对父模块独占结构消费，同一 revision 不得同时 duplicate。', path + '.sourceModuleId');
          }
          if (seenEdits[parentIds[0]]) {
            fail('INVALID_MODULE_OPERATION', 'duplicate 必须从可信上一 revision 父模块派生，不得在同 revision 同时编辑父模块。', path + '.sourceModuleId');
          }
          duplicatedParents[parentIds[0]] = true;
        }
        if (op === 'merge') {
          parentIds.forEach(function (parentId) {
            if (previousById[parentId].locked || trustedPreviousById[parentId].locked) {
              fail('MODULE_LOCKED', '已锁定模块不得被 merge 消费。', path + '.sourceModuleIds');
            }
            if (seenEdits[parentId]) {
              fail('INVALID_MODULE_OPERATION', 'merge 必须从可信上一 revision 父模块派生，不得在同 revision 同时编辑父模块。', path + '.sourceModuleIds');
            }
            if (accounted[parentId]) fail('UNKNOWN_OR_DUPLICATE_MODULE', 'merge 父模块已被其他 keep/delete/merge 操作消费。', path);
            accounted[parentId] = true;
          });
        }
        var operationKey = idValue(ownValue(operation, 'operationKey'), path + '.operationKey', createContext(options), { required: true, max: 120 });
        if (operationKeys[operationKey]) fail('DUPLICATE_OPERATION_KEY', '同一 revision 的派生 operationKey 必须唯一。', path + '.operationKey');
        operationKeys[operationKey] = true;
        var sourceIds = [];
        parentIds.forEach(function (parentId) { sourceIds = sourceIds.concat(previousById[parentId].sourceBlockIds); });
        sourceIds = canonicalSourceBlockIds(Array.from(new Set(sourceIds)), snapshot, path + '.sourceBlockIds');
        var derivation = { kind: op, parentModuleIds: parentIds, createdRevision: blueprint.revision + 1, operationKey: operationKey };
        var seed;
        if (op === 'duplicate') {
          seed = trustedPreviousById[parentIds[0]];
        } else {
          seed = mergeSeedFromParents(parentIds.map(function (parentId) { return trustedPreviousById[parentId]; }));
        }
        nextModules.push(buildDerivedModule(snapshot, blueprint.blueprintId, sourceIds, derivation, seed));
      });
      Object.keys(previousById).forEach(function (moduleId) {
        if (!accounted[moduleId]) fail('INCOMPLETE_MODULE_PLAN', 'operations 必须用 keep/delete/merge/split 明确处理每个上一 revision 模块。', '$changes.operations');
      });
      if (!nextModules.length) fail('REQUIRED_FIELD', '蓝图不得删除全部模块。', '$changes.operations');
      raw.modules = nextModules;
    } else {
      var moduleOrder = arrayValue(ownValue(changes, 'moduleOrder'), '$changes.moduleOrder', raw.modules.length || 1, false);
      if (moduleOrder.length) {
        if (moduleOrder.length !== raw.modules.length || new Set(moduleOrder).size !== raw.modules.length || moduleOrder.some(function (id) { return !byId[id]; })) {
          fail('INVALID_MODULE_ORDER', 'moduleOrder 必须且只能包含全部现有 moduleId。', '$changes.moduleOrder');
        }
        raw.modules = moduleOrder.map(function (moduleId) { return byId[moduleId]; });
      }
    }
    raw.modules = raw.modules.map(function (module, index) {
      var seed = cloneJson(module);
      seed.order = index;
      var rebuilt = buildDerivedModule(snapshot, blueprint.blueprintId, module.sourceBlockIds, module.derivation, seed);
      rebuilt.order = index;
      return rebuilt;
    });
    raw.revision = blueprint.revision + 1;
    raw.updatedAt = ownValue(options, 'updatedAt') || blueprint.updatedAt;
    raw.approvalStatus = 'draft';
    raw.approval = { approvedAt: '', verificationId: '', productFactCardIds: [] };
    if (ownDescriptor(changes, 'approvalStatus') || ownDescriptor(changes, 'approval')) {
      fail('APPROVAL_REQUIRES_TRUSTED_TRANSITION', '审批状态不能通过普通修订设置，必须调用显式可信审批迁移。', '$changes.approvalStatus');
    }
    var revised = sanitizeBlueprint(raw, options);
    assertBlueprintAgainstSource(revised, snapshot, options, blueprint);
    return revised;
  }

  function verifiedTargetAssetRegistry(options, context) {
    var list = arrayValue(isPlainObject(options) ? ownValue(options, 'verifiedTargetAssets') : undefined,
      '$options.verifiedTargetAssets', context.limits.maxAssets, false);
    var registry = Object.create(null);
    list.forEach(function (item, index) {
      var path = '$options.verifiedTargetAssets[' + index + ']';
      if (!isPlainObject(item)) fail('INVALID_VERIFIED_ASSET', '可信素材记录必须是普通对象。', path);
      var assetId = idValue(ownValue(item, 'assetId', context, path + '.assetId'), path + '.assetId', context, { required: true });
      var rightsStatus = enumValue(ownValue(item, 'rightsStatus', context, path + '.rightsStatus'), RIGHTS_STATUSES, null, path + '.rightsStatus');
      var evidenceId = idValue(ownValue(item, 'evidenceId', context, path + '.evidenceId'), path + '.evidenceId', context, { required: true });
      var role = enumValue(ownValue(item, 'role', context, path + '.role'), ASSET_ROLES, 'subject', path + '.role');
      if (registry[assetId]) {
        if (registry[assetId].rightsStatus !== rightsStatus || registry[assetId].evidenceId !== evidenceId || registry[assetId].role !== role) {
          fail('CONFLICTING_VERIFIED_ASSET', '同一可信素材 ID 存在冲突记录。', path + '.assetId');
        }
        return;
      }
      registry[assetId] = { assetId: assetId, rightsStatus: rightsStatus, evidenceId: evidenceId, role: role };
    });
    return registry;
  }

  function verifiedFactCardRegistry(options, context) {
    var list = arrayValue(isPlainObject(options) ? ownValue(options, 'verifiedProductFactCards') : undefined,
      '$options.verifiedProductFactCards', context.limits.maxBatchTasks, false);
    var registry = Object.create(null);
    list.forEach(function (item, index) {
      var path = '$options.verifiedProductFactCards[' + index + ']';
      if (!isPlainObject(item)) fail('INVALID_VERIFIED_FACT_CARD', '可信事实卡记录必须是普通对象。', path);
      var cardId = idValue(ownValue(item, 'productFactCardId', context, path + '.productFactCardId'), path + '.productFactCardId', context, { required: true });
      var verificationId = idValue(ownValue(item, 'verificationId', context, path + '.verificationId'), path + '.verificationId', context, { required: true });
      var factKeys = arrayValue(ownValue(item, 'factKeys', context, path + '.factKeys'), path + '.factKeys', context.limits.maxFacts, true)
        .map(function (key, keyIndex) { return textValue(key, path + '.factKeys[' + keyIndex + ']', context, { required: true, max: 240 }); });
      factKeys = Array.from(new Set(factKeys)).sort(compareCodeUnits);
      if (registry[cardId]) {
        if (registry[cardId].verificationId !== verificationId || stableSerialize(registry[cardId].factKeys) !== stableSerialize(factKeys)) {
          fail('CONFLICTING_VERIFIED_FACT_CARD', '同一可信事实卡 ID 存在冲突记录。', path + '.productFactCardId');
        }
        return;
      }
      registry[cardId] = { productFactCardId: cardId, verificationId: verificationId, factKeys: factKeys };
    });
    return registry;
  }

  function assertModuleDerivedFromSnapshot(module, snapshot, path) {
    var canonical = canonicalSourceBlockIds(module.sourceBlockIds, snapshot, path + '.sourceBlockIds');
    if (stableSerialize(canonical) !== stableSerialize(module.sourceBlockIds)) {
      fail('SOURCE_DERIVATION_MISMATCH', 'sourceBlockIds 必须去重并按原详情顺序排列。', path + '.sourceBlockIds');
    }
    var bundle = deriveModuleSourceBundle(snapshot, module.moduleId, canonical, module.editableCopy);
    var expectedLegacy = canonical.length === 1 ? canonical[0] : '';
    if (module.sourceBlockId !== expectedLegacy || module.originalIndex !== bundle.originalIndex ||
        module.sourceSummary !== bundle.sourceSummary || module.sourceCopy !== bundle.sourceCopy) {
      fail('SOURCE_DERIVATION_MISMATCH', '模块来源文案、摘要或原始位置未由 lineage 正确派生。', path);
    }
    if (stableSerialize(module.assetSlots) !== stableSerialize(bundle.assetSlots)) {
      fail('SOURCE_DERIVATION_MISMATCH', '来源素材槽必须由 snapshot 中 lineage 的严格并集派生。', path + '.assetSlots');
    }
    if (module.factBindings.length !== bundle.factIds.length) fail('SOURCE_DERIVATION_MISMATCH', '来源事实绑定数量不一致。', path + '.factBindings');
    module.factBindings.forEach(function (binding, index) {
      var expectedId = stableHash({ moduleId: module.moduleId, sourceFactId: bundle.factIds[index], index: index }, 'rdbind_');
      if (binding.bindingId !== expectedId || binding.sourceFactId !== bundle.factIds[index] || binding.required !== true) {
        fail('SOURCE_DERIVATION_MISMATCH', '来源事实绑定身份必须由 lineage 并集派生。', path + '.factBindings[' + index + ']');
      }
    });
    if (stableSerialize(module.riskFlags) !== stableSerialize(bundle.riskFlags)) {
      fail('SOURCE_DERIVATION_MISMATCH', '强制风险必须是 lineage 权利、完整度与文案门禁的最严格并集。', path + '.riskFlags');
    }
  }

  function moduleWithoutTargets(module) {
    var output = cloneJson(module);
    output.targetAssetSlots = [];
    return output;
  }

  function assertApprovedBlueprintGates(blueprint, options, snapshot) {
    var context = createContext(options);
    var assetRegistry = verifiedTargetAssetRegistry(options, context);
    var factRegistry = verifiedFactCardRegistry(options, context);
    var cardIds = blueprint.approval.productFactCardIds;
    if (!blueprint.modules.some(function (module) { return module.selected; })) {
      fail('NO_SELECTED_MODULE', 'approved 蓝图至少需要一个选中模块。', '$.modules');
    }
    var hasDirectionOnlyModule = blueprint.modules.some(function (module) {
      return module.selected && directionOnlyModule(module);
    });
    if (hasDirectionOnlyModule && !hasReusableTargetAsset(assetRegistry)) {
      fail('UNVERIFIED_TARGET_ASSET', 'direction-only 审批至少需要一张 authorized/self_owned 可复用目标素材。', '$options.verifiedTargetAssets');
    }
    cardIds.forEach(function (cardId, cardIndex) {
      if (!factRegistry[cardId]) {
        fail('UNVERIFIED_FACT_CARD', 'approved 蓝图引用了未在可信 registry 中核验的事实卡。', '$.approval.productFactCardIds[' + cardIndex + ']');
      }
    });
    blueprint.modules.forEach(function (module, moduleIndex) {
      var modulePath = '$.modules[' + moduleIndex + ']';
      if (!module.selected) {
        if (module.targetAssetSlots.length) {
          fail('UNKNOWN_TARGET_BINDING', '未选中模块不得持久化审批目标素材槽。', modulePath + '.targetAssetSlots');
        }
        return;
      }
      if (module.riskFlags.indexOf('SOURCE_BLOCKED') >= 0 || module.riskFlags.indexOf('BLOCKED_ASSET') >= 0) {
        fail('SOURCE_BLOCKED', '含 blocked 来源的选中模块不能处于 approved。', modulePath);
      }
      if (directionOnlyModule(module)) {
        assertSafeCoreDirection(module, modulePath, snapshot);
        if (module.targetAssetSlots.length) {
          fail('UNKNOWN_TARGET_BINDING', 'direction-only 模块不得持久化逐来源槽目标绑定。', modulePath + '.targetAssetSlots');
        }
        return;
      }
      var normalizedSource = String(module.sourceCopy || '').replace(/\s+/g, ' ').trim();
      var normalizedTarget = copyContent(module.editableCopy || emptyEditableCopy());
      if (normalizedSource && (!normalizedTarget || normalizedTarget === normalizedSource || module.riskFlags.indexOf('COPY_REWRITE_REQUIRED') >= 0)) {
        fail('COPY_REWRITE_REQUIRED', 'approved 蓝图的来源文案必须已重写为非空目标文案。', modulePath + '.editableCopy');
      }
      module.factBindings.forEach(function (binding, bindingIndex) {
        if (!binding.required) return;
        if (!binding.targetField) {
          fail('FACT_BINDING_REQUIRED', 'approved 蓝图的必要来源事实必须映射到目标事实卡字段。', modulePath + '.factBindings[' + bindingIndex + '].targetField');
        }
        cardIds.forEach(function (cardId) {
          if (factRegistry[cardId].factKeys.indexOf(binding.targetField) < 0) {
            fail('FACT_BINDING_REQUIRED', 'approved 蓝图的目标事实卡缺少必要映射字段。', modulePath + '.factBindings[' + bindingIndex + '].targetField');
          }
        });
      });
      var sourceSlots = Object.create(null);
      module.assetSlots.forEach(function (sourceSlot) { sourceSlots[sourceSlot.slotId] = sourceSlot; });
      var targetBySourceSlot = Object.create(null);
      module.targetAssetSlots.forEach(function (slot, slotIndex) {
        var slotPath = modulePath + '.targetAssetSlots[' + slotIndex + ']';
        var sourceSlot = sourceSlots[slot.sourceSlotId];
        if (!sourceSlot || targetBySourceSlot[slot.sourceSlotId]) {
          fail('UNKNOWN_TARGET_BINDING', 'approved 目标素材槽必须与当前模块必要来源槽一一对应。', slotPath + '.sourceSlotId');
        }
        if (!sourceSlot.required || !sourceSlot.replacementRequired || slot.role !== sourceSlot.role || slot.directUseAllowed !== true) {
          fail('SOURCE_DERIVATION_MISMATCH', 'approved 目标素材槽不得改写来源槽语义。', slotPath);
        }
        var verified = assetRegistry[slot.targetAssetId];
        if (!verified || (verified.rightsStatus !== 'authorized' && verified.rightsStatus !== 'self_owned') ||
            verified.rightsStatus !== slot.rightsStatus || verified.evidenceId !== slot.rightsEvidenceId) {
          fail('UNVERIFIED_TARGET_ASSET', 'approved 蓝图目标素材槽未通过 authorized/self_owned 可信 registry 复核。', slotPath);
        }
        targetBySourceSlot[slot.sourceSlotId] = true;
      });
      module.assetSlots.forEach(function (sourceSlot, slotIndex) {
        if (sourceSlot.required && sourceSlot.replacementRequired && !targetBySourceSlot[sourceSlot.slotId]) {
          fail('ASSET_REPLACEMENT_REQUIRED', 'approved 蓝图的每个必要来源素材槽都必须绑定可信目标素材。', modulePath + '.assetSlots[' + slotIndex + ']');
        }
      });
    });
    assertUniqueSelectedCoreDirections(blueprint);
  }

  function assertBlueprintAgainstSource(blueprintInput, snapshotInput, options, previousOverride) {
    options = isPlainObject(options) ? options : {};
    var snapshot = sanitizeSourceSnapshot(snapshotInput, options);
    var blueprint = sanitizeBlueprint(blueprintInput, options);
    if (blueprint.sourceSnapshotId !== snapshot.snapshotId) fail('LINKAGE_MISMATCH', '蓝图 sourceSnapshotId 与来源快照不匹配。', '$.sourceSnapshotId');
    blueprint.modules.forEach(function (module, index) {
      if (module.derivation.createdRevision > blueprint.revision) fail('UNPROVEN_MODULE_DERIVATION', '模块不得出生于未来 revision。', '$.modules[' + index + '].derivation.createdRevision');
      assertModuleDerivedFromSnapshot(module, snapshot, '$.modules[' + index + ']');
    });
    var expectedDraft = createBlueprintFromSnapshot(snapshot, options);
    var previousInput = previousOverride || ownValue(options, 'previousBlueprint');
    if (blueprint.revision === 1) {
      if (previousInput) fail('INVALID_REVISION_CHAIN', 'revision 1 不应提供 previousBlueprint。', '$options.previousBlueprint');
      if (blueprint.approvalStatus !== 'draft') fail('INVALID_APPROVAL_TRANSITION', 'revision 1 只能是 draft。', '$.approvalStatus');
      if (stableSerialize(blueprint.modules) !== stableSerialize(expectedDraft.modules)) {
        fail('UNPROVEN_REVISION', 'revision 1 必须是来源快照的一块一模块初始蓝图。', '$.modules');
      }
    } else {
      if (!previousInput) fail('PREVIOUS_BLUEPRINT_REQUIRED', 'revision > 1 必须提供可信上一 revision。', '$options.previousBlueprint');
      var previous = sanitizeBlueprint(previousInput, options);
      if (previous.blueprintId !== blueprint.blueprintId || previous.sourceSnapshotId !== blueprint.sourceSnapshotId ||
          blueprint.revision !== previous.revision + 1 || previous.createdAt !== blueprint.createdAt) {
        fail('INVALID_REVISION_CHAIN', '蓝图 revision 必须沿同一来源恰好递增 1。', '$.revision');
      }
      previous.modules.forEach(function (module, index) { assertModuleDerivedFromSnapshot(module, snapshot, '$previous.modules[' + index + ']'); });
      var previousById = Object.create(null);
      previous.modules.forEach(function (module) { previousById[module.moduleId] = module; });
      var currentById = Object.create(null);
      blueprint.modules.forEach(function (module) { currentById[module.moduleId] = module; });
      previous.modules.forEach(function (module, index) {
        if (module.locked && !currentById[module.moduleId]) {
          fail('MODULE_LOCKED', '已锁定模块不得在下一 revision 中消失；请先单独解锁。', '$previous.modules[' + index + '].moduleId');
        }
      });
      var newOperationKeys = Object.create(null);
      var mergeConsumedParents = Object.create(null);
      var duplicatedParents = Object.create(null);
      var splitChildrenByParent = Object.create(null);
      blueprint.modules.forEach(function (module, index) {
        var prior = previousById[module.moduleId];
        var path = '$.modules[' + index + ']';
        if (prior) {
          if (stableSerialize(module.sourceBlockIds) !== stableSerialize(prior.sourceBlockIds) ||
              stableSerialize(module.derivation) !== stableSerialize(prior.derivation)) {
            fail('IMMUTABLE_DERIVED_FIELD', '存续 moduleId 不得替换 lineage 或 derivation。', path);
          }
          if (prior.locked) {
            var expectedLockedModule = cloneJson(prior);
            expectedLockedModule.order = module.order;
            expectedLockedModule.locked = module.locked;
            if (blueprint.approvalStatus === 'approved' && previous.approvalStatus === 'draft') {
              expectedLockedModule.targetAssetSlots = cloneJson(module.targetAssetSlots);
            }
            if (stableSerialize(expectedLockedModule) !== stableSerialize(module)) {
              fail('MODULE_LOCKED', '已锁定模块只能保持不变或纯解锁；不得在同 revision 解锁并篡改其他字段。', path);
            }
          }
          return;
        }
        if (module.derivation.kind === 'source' || module.derivation.createdRevision !== blueprint.revision) {
          fail('UNPROVEN_MODULE_DERIVATION', '新模块必须由当前 revision 的 duplicate/merge/split 操作产生。', path + '.derivation');
        }
        if (newOperationKeys[module.derivation.operationKey]) fail('DUPLICATE_OPERATION_KEY', '同 revision 新模块 operationKey 重复。', path + '.derivation.operationKey');
        newOperationKeys[module.derivation.operationKey] = true;
        var parents = module.derivation.parentModuleIds.map(function (parentId) {
          if (!previousById[parentId]) fail('UNPROVEN_MODULE_DERIVATION', '派生模块父级必须存在于可信上一 revision。', path + '.derivation.parentModuleIds');
          return previousById[parentId];
        });
        var canonicalParentIds = parents.slice().sort(function (a, b) { return a.order - b.order || compareCodeUnits(a.moduleId, b.moduleId); })
          .map(function (parent) { return parent.moduleId; });
        if (stableSerialize(canonicalParentIds) !== stableSerialize(module.derivation.parentModuleIds)) {
          fail('UNPROVEN_MODULE_DERIVATION', '父模块 ID 必须按上一 revision 顺序规范化。', path + '.derivation.parentModuleIds');
        }
        if (module.derivation.kind === 'split') {
          var splitParent = parents[0];
          if (splitParent.locked) fail('MODULE_LOCKED', '已锁定模块不得拆分。', path + '.derivation.parentModuleIds');
          if (currentById[splitParent.moduleId]) {
            fail('UNPROVEN_MODULE_DERIVATION', 'split 必须消费父模块，同一 revision 不得同时保留父模块与 split 子模块。', path + '.derivation.parentModuleIds');
          }
          var splitParentSources = Object.create(null);
          splitParent.sourceBlockIds.forEach(function (sourceBlockId) { splitParentSources[sourceBlockId] = true; });
          if (!module.sourceBlockIds.length || module.sourceBlockIds.some(function (sourceBlockId) { return !splitParentSources[sourceBlockId]; })) {
            fail('UNPROVEN_MODULE_DERIVATION', 'split 子模块 lineage 必须是父模块 lineage 的非空子集。', path + '.sourceBlockIds');
          }
          var expectedSplitModule = buildDerivedModule(snapshot, blueprint.blueprintId, module.sourceBlockIds, module.derivation, splitParent);
          expectedSplitModule.order = module.order;
          expectedSplitModule = sanitizeModule(expectedSplitModule, module.order, createContext(options), blueprint.blueprintId, blueprint.approvalStatus);
          if (stableSerialize(expectedSplitModule) !== stableSerialize(module)) {
            fail('UNPROVEN_MODULE_DERIVATION', 'split 子模块必须完整继承可信父模块的可编辑种子字段，不得在同 revision 伪造。', path);
          }
          if (!splitChildrenByParent[splitParent.moduleId]) {
            splitChildrenByParent[splitParent.moduleId] = { parent: splitParent, children: [] };
          }
          splitChildrenByParent[splitParent.moduleId].children.push({ module: module, path: path });
        } else {
          var expectedSources = [];
          parents.forEach(function (parent) { expectedSources = expectedSources.concat(parent.sourceBlockIds); });
          expectedSources = canonicalSourceBlockIds(Array.from(new Set(expectedSources)), snapshot, path + '.sourceBlockIds');
          if (stableSerialize(expectedSources) !== stableSerialize(module.sourceBlockIds)) {
            fail('UNPROVEN_MODULE_DERIVATION', 'sourceBlockIds 不是父模块 lineage 的规范并集。', path + '.sourceBlockIds');
          }
          var expectedDerivedModule = buildDerivedModule(
            snapshot,
            blueprint.blueprintId,
            module.sourceBlockIds,
            module.derivation,
            module.derivation.kind === 'duplicate' ? parents[0] : mergeSeedFromParents(parents)
          );
          expectedDerivedModule.order = module.order;
          expectedDerivedModule = sanitizeModule(expectedDerivedModule, module.order, createContext(options), blueprint.blueprintId, blueprint.approvalStatus);
          if (stableSerialize(expectedDerivedModule) !== stableSerialize(module)) {
            fail('UNPROVEN_MODULE_DERIVATION', module.derivation.kind + ' 派生模块必须由可信父模块的规范 seed 完整重建，不得在同 revision 伪造。', path);
          }
        }
        if (module.derivation.kind === 'duplicate') {
          duplicatedParents[module.derivation.parentModuleIds[0]] = true;
        }
        if (module.derivation.kind === 'merge') {
          module.derivation.parentModuleIds.forEach(function (parentId) {
            if (previousById[parentId].locked) {
              fail('MODULE_LOCKED', '已锁定模块不得被 merge 消费。', path + '.derivation.parentModuleIds');
            }
            if (currentById[parentId]) {
              fail('UNPROVEN_MODULE_DERIVATION', 'merge 必须消费父模块，同一 revision 不得同时保留父模块与 merge 子模块。', path + '.derivation.parentModuleIds');
            }
            if (mergeConsumedParents[parentId]) {
              fail('UNPROVEN_MODULE_DERIVATION', '同一父模块在一个 revision 中只能被一个 merge 子模块消费。', path + '.derivation.parentModuleIds');
            }
            mergeConsumedParents[parentId] = module.moduleId;
          });
        }
      });
      Object.keys(splitChildrenByParent).forEach(function (parentId) {
        var splitFamily = splitChildrenByParent[parentId];
        if (mergeConsumedParents[parentId]) {
          fail('UNPROVEN_MODULE_DERIVATION', '同一父模块在一个 revision 中不得同时被 merge 与 split 消费。', '$.modules');
        }
        if (duplicatedParents[parentId]) {
          fail('UNPROVEN_MODULE_DERIVATION', 'split 对父模块独占结构消费，同一 revision 不得同时 duplicate。', '$.modules');
        }
        if (splitFamily.children.length < 2) {
          fail('UNPROVEN_MODULE_DERIVATION', 'split 必须由至少两个子模块共同完成。', splitFamily.children[0].path + '.derivation');
        }
        var coveredSources = Object.create(null);
        splitFamily.children.forEach(function (child) {
          child.module.sourceBlockIds.forEach(function (sourceBlockId) {
            if (coveredSources[sourceBlockId]) {
              fail('UNPROVEN_MODULE_DERIVATION', 'split 子模块 lineage 必须互斥，不得重叠消费来源块。', child.path + '.sourceBlockIds');
            }
            coveredSources[sourceBlockId] = true;
          });
        });
        if (Object.keys(coveredSources).length !== splitFamily.parent.sourceBlockIds.length ||
            splitFamily.parent.sourceBlockIds.some(function (sourceBlockId) { return !coveredSources[sourceBlockId]; })) {
          fail('UNPROVEN_MODULE_DERIVATION', 'split 子模块 lineage 必须精确分区并覆盖父模块的全部来源块。', '$.modules');
        }
      });
      if (blueprint.approvalStatus === 'approved') {
        if (previous.approvalStatus !== 'draft' || blueprint.modules.length !== previous.modules.length) {
          fail('INVALID_APPROVAL_TRANSITION', '审批 revision 只能由相同结构的 draft 单独迁移。', '$.approvalStatus');
        }
        blueprint.modules.forEach(function (module, index) {
          if (!previous.modules[index] || previous.modules[index].moduleId !== module.moduleId ||
              stableSerialize(moduleWithoutTargets(module)) !== stableSerialize(moduleWithoutTargets(previous.modules[index]))) {
            fail('INVALID_APPROVAL_TRANSITION', '审批 revision 不得夹带结构、文案或映射修改。', '$.modules[' + index + ']');
          }
        });
      } else {
        if (blueprint.approvalStatus !== 'draft') fail('UNPROVEN_APPROVAL_STATE', '除显式可信审批外，修订蓝图只能是 draft。', '$.approvalStatus');
        blueprint.modules.forEach(function (module, index) {
          if (module.targetAssetSlots.length) fail('UNVERIFIED_TARGET_ASSET', 'draft 不得持久化未经审批的目标素材槽。', '$.modules[' + index + '].targetAssetSlots');
        });
      }
    }
    if (blueprint.approvalStatus === 'approved') {
      assertApprovedBlueprintGates(blueprint, options, snapshot);
    }
    return { blueprint: blueprint, snapshot: snapshot };
  }

  function validateBlueprintAgainstSource(blueprintInput, snapshotInput, options) {
    try {
      var checked = assertBlueprintAgainstSource(blueprintInput, snapshotInput, options);
      return deepFreeze({ ok: true, value: checked.blueprint, errors: [], warnings: checked.blueprint.warnings || [] });
    } catch (error) {
      return deepFreeze({ ok: false, value: null, errors: [{ code: error.code || 'CONTRACT_ERROR', message: String(error.message || error), path: error.path || '$', severity: 'error' }], warnings: [] });
    }
  }

  function validateBlueprintAgainstSnapshot(blueprintInput, snapshotInput, options) {
    return validateBlueprintAgainstSource(blueprintInput, snapshotInput, options);
  }

  function optionsWithoutPrevious(options) {
    var output = {};
    if (!isPlainObject(options)) return output;
    Object.keys(options).forEach(function (key) {
      if (key === 'previousBlueprint') return;
      var descriptor = ownDescriptor(options, key);
      if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) output[key] = descriptor.value;
    });
    return output;
  }

  function createRevisionEnvelope(currentBlueprintInput, immediatePreviousInput, snapshotInput, options) {
    var currentShape = sanitizeBlueprint(currentBlueprintInput, options);
    if (currentShape.revision === 1 && immediatePreviousInput != null) {
      fail('INVALID_REVISION_CHAIN', 'revision 1 的 envelope 不得包含 immediatePreviousBlueprint。', '$envelope.immediatePreviousBlueprint');
    }
    if (currentShape.revision > 1 && immediatePreviousInput == null) {
      fail('PREVIOUS_BLUEPRINT_REQUIRED', 'revision > 1 的 envelope 必须持久化直接前一 revision。', '$envelope.immediatePreviousBlueprint');
    }
    var validationOptions = optionsWithoutPrevious(options);
    if (immediatePreviousInput != null) validationOptions.previousBlueprint = immediatePreviousInput;
    var checked = assertBlueprintAgainstSource(currentShape, snapshotInput, validationOptions);
    return deepFreeze({
      currentBlueprint: checked.blueprint,
      immediatePreviousBlueprint: immediatePreviousInput == null ? null : sanitizeBlueprint(immediatePreviousInput, options)
    });
  }

  function advanceRevisionEnvelope(envelopeInput, nextBlueprintInput, snapshotInput, options) {
    if (!isPlainObject(envelopeInput)) fail('INVALID_REVISION_ENVELOPE', 'revision envelope 必须是普通对象。', '$envelope');
    var currentInput = ownValue(envelopeInput, 'currentBlueprint');
    var previousInput = ownValue(envelopeInput, 'immediatePreviousBlueprint');
    var restored = createRevisionEnvelope(currentInput, previousInput == null ? null : previousInput, snapshotInput, options);
    var validationOptions = optionsWithoutPrevious(options);
    validationOptions.previousBlueprint = restored.currentBlueprint;
    var nextChecked = assertBlueprintAgainstSource(nextBlueprintInput, snapshotInput, validationOptions);
    return deepFreeze({
      currentBlueprint: nextChecked.blueprint,
      immediatePreviousBlueprint: restored.currentBlueprint
    });
  }

  function approveBlueprint(blueprintInput, snapshotInput, approvalContext, options) {
    approvalContext = isPlainObject(approvalContext) ? approvalContext : {};
    options = isPlainObject(options) ? options : {};
    var checked = assertBlueprintAgainstSource(blueprintInput, snapshotInput, options);
    var blueprint = checked.blueprint;
    if (blueprint.approvalStatus === 'approved') fail('INVALID_APPROVAL_TRANSITION', '蓝图已经 approved，内容变化必须先产生新的 draft revision。', '$.approvalStatus');
    if (!blueprint.modules.some(function (module) { return module.selected; })) fail('NO_SELECTED_MODULE', '审批至少需要一个选中模块。', '$.modules');
    var context = createContext(options);
    var assetRegistry = verifiedTargetAssetRegistry(options, context);
    var factRegistry = verifiedFactCardRegistry(options, context);
    var cardIds = arrayValue(ownValue(approvalContext, 'productFactCardIds'), '$approval.productFactCardIds', context.limits.maxBatchTasks, true)
      .map(function (id, index) { return idValue(id, '$approval.productFactCardIds[' + index + ']', context, { required: true }); });
    cardIds = Array.from(new Set(cardIds)).sort(compareCodeUnits);
    if (!cardIds.length) fail('FACT_CARD_REQUIRED', '审批必须绑定至少一个可信目标事实卡。', '$approval.productFactCardIds');
    cardIds.forEach(function (cardId) {
      if (!factRegistry[cardId]) fail('UNVERIFIED_FACT_CARD', '目标事实卡未出现在独立可信 registry。', '$approval.productFactCardIds');
    });
    var hasDirectionOnlyModule = blueprint.modules.some(function (module) {
      return module.selected && directionOnlyModule(module);
    });
    if (hasDirectionOnlyModule && !hasReusableTargetAsset(assetRegistry)) {
      fail('UNVERIFIED_TARGET_ASSET', 'direction-only 审批至少需要一张 authorized/self_owned 可复用目标素材。', '$options.verifiedTargetAssets');
    }
    var bindings = arrayValue(ownValue(approvalContext, 'slotBindings'), '$approval.slotBindings', context.limits.maxAssets, false);
    var bindingBySourceSlot = Object.create(null);
    bindings.forEach(function (binding, index) {
      var path = '$approval.slotBindings[' + index + ']';
      if (!isPlainObject(binding)) fail('INVALID_TARGET_BINDING', '目标素材绑定必须是普通对象。', path);
      if (ownDescriptor(binding, 'rightsStatus') || ownDescriptor(binding, 'directUseAllowed') || ownDescriptor(binding, 'replacementRequired')) {
        fail('UNTRUSTED_RIGHTS_ASSERTION', '目标绑定不得自报授权状态，授权只能来自可信 registry。', path);
      }
      var rawModuleId = ownValue(binding, 'moduleId');
      var rawBlockAlias = ownValue(binding, 'blockId');
      var moduleId = idValue(rawModuleId == null ? rawBlockAlias : rawModuleId, path + '.moduleId', context, { required: true });
      if (rawBlockAlias != null && idValue(rawBlockAlias, path + '.blockId', context, { required: true }) !== moduleId) fail('ID_MISMATCH', 'slotBinding blockId 兼容值必须与 moduleId 一致。', path + '.blockId');
      var sourceSlotId = idValue(ownValue(binding, 'sourceSlotId'), path + '.sourceSlotId', context, { required: true });
      var targetAssetId = idValue(ownValue(binding, 'targetAssetId'), path + '.targetAssetId', context, { required: true });
      var key = moduleId + '\u0000' + sourceSlotId;
      if (bindingBySourceSlot[key]) fail('DUPLICATE_TARGET_BINDING', '同一来源槽只能绑定一个目标素材。', path);
      bindingBySourceSlot[key] = { moduleId: moduleId, sourceSlotId: sourceSlotId, targetAssetId: targetAssetId };
    });
    var raw = cloneJson(blueprint);
    var consumedBindings = Object.create(null);
    raw.modules.forEach(function (module, moduleIndex) {
      if (!module.selected) return;
      if (module.riskFlags.indexOf('SOURCE_BLOCKED') >= 0 || module.riskFlags.indexOf('BLOCKED_ASSET') >= 0) {
        fail('SOURCE_BLOCKED', '含 blocked 来源的选中模块不能审批。', '$.modules[' + moduleIndex + ']');
      }
      module.targetAssetSlots = [];
      if (directionOnlyModule(module)) {
        assertSafeCoreDirection(module, '$.modules[' + moduleIndex + ']', checked.snapshot);
        return;
      }
      if (module.sourceCopy && module.riskFlags.indexOf('COPY_REWRITE_REQUIRED') >= 0) {
        fail('COPY_REWRITE_REQUIRED', '来源文案必须重写为非空目标文案后才能审批。', '$.modules[' + moduleIndex + '].editableCopy');
      }
      module.factBindings.forEach(function (binding, bindingIndex) {
        if (!binding.required) return;
        if (!binding.targetField) fail('FACT_BINDING_REQUIRED', '必要来源事实必须映射到目标事实卡字段。', '$.modules[' + moduleIndex + '].factBindings[' + bindingIndex + '].targetField');
        cardIds.forEach(function (cardId) {
          if (factRegistry[cardId].factKeys.indexOf(binding.targetField) < 0) {
            fail('FACT_BINDING_REQUIRED', '目标事实卡缺少必要映射字段。', '$.modules[' + moduleIndex + '].factBindings[' + bindingIndex + '].targetField');
          }
        });
      });
      module.assetSlots.forEach(function (sourceSlot, slotIndex) {
        if (!sourceSlot.required || !sourceSlot.replacementRequired) return;
        var key = module.moduleId + '\u0000' + sourceSlot.slotId;
        var binding = bindingBySourceSlot[key];
        if (!binding) fail('ASSET_REPLACEMENT_REQUIRED', '受限来源素材槽必须绑定可信目标素材。', '$.modules[' + moduleIndex + '].assetSlots[' + slotIndex + ']');
        var verified = assetRegistry[binding.targetAssetId];
        if (!verified || (verified.rightsStatus !== 'authorized' && verified.rightsStatus !== 'self_owned')) {
          fail('UNVERIFIED_TARGET_ASSET', '目标素材未获得 authorized/self_owned 可信验证。', '$approval.slotBindings');
        }
        consumedBindings[key] = true;
        module.targetAssetSlots.push({
          targetSlotId: stableHash({ moduleId: module.moduleId, sourceSlotId: sourceSlot.slotId, targetAssetId: verified.assetId }, 'rdtarget_'),
          sourceSlotId: sourceSlot.slotId,
          targetAssetId: verified.assetId,
          role: sourceSlot.role,
          rightsStatus: verified.rightsStatus,
          rightsEvidenceId: verified.evidenceId,
          directUseAllowed: true
        });
      });
    });
    assertUniqueSelectedCoreDirections(raw);
    Object.keys(bindingBySourceSlot).forEach(function (key) {
      if (!consumedBindings[key]) fail('UNKNOWN_TARGET_BINDING', '审批包含未对应必要来源槽的目标素材绑定。', '$approval.slotBindings');
    });
    var approvedAt = timestampValue(ownValue(approvalContext, 'approvedAt'), '$approval.approvedAt', context);
    var verificationId = idValue(ownValue(approvalContext, 'verificationId'), '$approval.verificationId', context, { required: true });
    raw.revision = blueprint.revision + 1;
    raw.approvalStatus = 'approved';
    raw.approval = { approvedAt: approvedAt, verificationId: verificationId, productFactCardIds: cardIds };
    raw.updatedAt = approvedAt;
    var approved = sanitizeBlueprint(raw, options);
    assertBlueprintAgainstSource(approved, checked.snapshot, options, blueprint);
    return approved;
  }

  var VISUAL_STRUCTURE_FORBIDDEN_KEYS = Object.freeze({
    productFactCardId: true,
    productFactCardIds: true,
    verifiedProductFactCards: true,
    factCardsById: true,
    facts: true,
    factBindings: true,
    sourceCopy: true,
    sourceSummary: true,
    editableCopy: true,
    assetSlots: true,
    targetAssetSlots: true,
    publishableCopy: true,
    targetFacts: true
  });

  function assertNoVisualStructureFactFields(input, path) {
    if (!isPlainObject(input)) return;
    Object.keys(VISUAL_STRUCTURE_FORBIDDEN_KEYS).forEach(function (key) {
      if (ownDescriptor(input, key)) {
        fail('VISUAL_STRUCTURE_FACT_FIELD_FORBIDDEN', '结构专用合同不得携带事实卡、来源文案或目标事实字段。', path + '.' + key);
      }
    });
  }

  function sanitizeVisualStructureModule(item, index, context, blueprintId) {
    var path = '$.modules[' + index + ']';
    if (!isPlainObject(item)) fail('INVALID_MODULE', '结构蓝图模块必须是普通对象。', path);
    assertNoVisualStructureFactFields(item, path);
    var moduleId = idValue(ownValue(item, 'moduleId', context, path + '.moduleId'), path + '.moduleId', context, { required: true });
    var blockAlias = ownValue(item, 'blockId', context, path + '.blockId');
    if (blockAlias != null && idValue(blockAlias, path + '.blockId', context, { required: true }) !== moduleId) {
      fail('ID_MISMATCH', '兼容 blockId 必须与 moduleId 一致。', path + '.blockId');
    }
    var sourceBlockIds = arrayValue(ownValue(item, 'sourceBlockIds', context, path + '.sourceBlockIds'), path + '.sourceBlockIds', context.limits.maxRefsPerBlock, true)
      .map(function (id, sourceIndex) { return idValue(id, path + '.sourceBlockIds[' + sourceIndex + ']', context, { required: true }); });
    if (!sourceBlockIds.length) fail('REQUIRED_FIELD', '结构模块 sourceBlockIds 不得为空。', path + '.sourceBlockIds');
    if (new Set(sourceBlockIds).size !== sourceBlockIds.length) fail('DUPLICATE_ID', 'sourceBlockIds 不得重复。', path + '.sourceBlockIds');
    var derivation = sanitizeModuleDerivation(ownValue(item, 'derivation', context, path + '.derivation'), path + '.derivation', context);
    if (moduleId !== deriveBlueprintModuleId(blueprintId, sourceBlockIds, derivation)) {
      fail('ID_MISMATCH', 'moduleId 与结构 lineage 不匹配。', path + '.moduleId');
    }
    var riskFlags = arrayValue(ownValue(item, 'riskFlags', context, path + '.riskFlags'), path + '.riskFlags', context.limits.maxRiskFlags, false)
      .map(function (flag, flagIndex) {
        flag = textValue(flag, path + '.riskFlags[' + flagIndex + ']', context, { required: true, max: 80 });
        if (!SAFE_RISK_FLAG.test(flag)) fail('INVALID_RISK_FLAG', 'riskFlag 必须是大写下划线标识。', path + '.riskFlags[' + flagIndex + ']');
        return flag;
      });
    return {
      moduleId: moduleId,
      blockId: moduleId,
      sourceBlockIds: sourceBlockIds,
      derivation: derivation,
      originalIndex: nonNegativeIntegerValue(ownValue(item, 'originalIndex', context, path + '.originalIndex'), path + '.originalIndex'),
      order: nonNegativeIntegerValue(ownValue(item, 'order', context, path + '.order'), path + '.order'),
      type: enumValue(ownValue(item, 'type', context, path + '.type'), BLOCK_TYPES, 'unknown', path + '.type'),
      salesRole: enumValue(ownValue(item, 'salesRole', context, path + '.salesRole'), SALES_ROLES, 'unknown', path + '.salesRole'),
      visualBrief: sanitizeVisualBrief(ownValue(item, 'visualBrief', context, path + '.visualBrief'), path + '.visualBrief', context),
      selected: booleanValue(ownValue(item, 'selected'), true),
      locked: booleanValue(ownValue(item, 'locked'), false),
      riskFlags: Array.from(new Set(riskFlags)).sort(compareCodeUnits)
    };
  }

  function sanitizeVisualStructureApproval(input, approvalStatus, context) {
    input = isPlainObject(input) ? input : {};
    assertNoVisualStructureFactFields(input, '$.approval');
    var claimMode = ownValue(input, 'claimMode', context, '$.approval.claimMode') || VISUAL_STRUCTURE_ONLY;
    if (claimMode !== VISUAL_STRUCTURE_ONLY) fail('INVALID_CLAIM_MODE', '结构蓝图 claimMode 无效。', '$.approval.claimMode');
    if (approvalStatus !== 'approved') {
      return { approvedAt: '', verificationId: '', claimMode: VISUAL_STRUCTURE_ONLY };
    }
    return {
      approvedAt: timestampValue(ownValue(input, 'approvedAt', context, '$.approval.approvedAt'), '$.approval.approvedAt', context),
      verificationId: idValue(ownValue(input, 'verificationId', context, '$.approval.verificationId'), '$.approval.verificationId', context, { required: true }),
      claimMode: VISUAL_STRUCTURE_ONLY
    };
  }

  function sanitizeVisualStructureBlueprint(input, options) {
    var context = createContext(options);
    if (!isPlainObject(input)) fail('INVALID_CONTRACT', '结构蓝图必须是普通对象。', '$');
    assertNoVisualStructureFactFields(input, '$');
    if (ownValue(input, 'schema', context, '$.schema') !== VISUAL_STRUCTURE_BLUEPRINT_SCHEMA) fail('INVALID_SCHEMA', '结构蓝图 schema 无效。', '$.schema');
    if (Number(ownValue(input, 'schemaVersion', context, '$.schemaVersion')) !== VISUAL_STRUCTURE_SCHEMA_VERSION) fail('INVALID_SCHEMA_VERSION', '结构蓝图 schemaVersion 必须为 2。', '$.schemaVersion');
    if (ownValue(input, 'claimMode', context, '$.claimMode') !== VISUAL_STRUCTURE_ONLY) fail('INVALID_CLAIM_MODE', '结构蓝图必须声明 visual_structure_only。', '$.claimMode');
    var sourceSnapshotId = idValue(ownValue(input, 'sourceSnapshotId', context, '$.sourceSnapshotId'), '$.sourceSnapshotId', context, { required: true });
    var blueprintId = idValue(ownValue(input, 'blueprintId', context, '$.blueprintId'), '$.blueprintId', context, { required: true });
    if (blueprintId !== stableHash(sourceSnapshotId, 'rdp_')) fail('ID_MISMATCH', '结构 blueprintId 与来源快照不匹配。', '$.blueprintId');
    var revision = positiveIntegerValue(ownValue(input, 'revision', context, '$.revision'), '$.revision');
    var createdAt = timestampValue(ownValue(input, 'createdAt', context, '$.createdAt'), '$.createdAt', context);
    var updatedAt = timestampValue(ownValue(input, 'updatedAt', context, '$.updatedAt'), '$.updatedAt', context, createdAt);
    var approvalStatus = enumValue(ownValue(input, 'approvalStatus', context, '$.approvalStatus'), BLUEPRINT_APPROVAL_STATUSES, 'draft', '$.approvalStatus');
    if (approvalStatus !== 'draft' && approvalStatus !== 'approved') fail('INVALID_APPROVAL_STATE', '结构蓝图只接受 draft/approved。', '$.approvalStatus');
    var analysisFingerprint = idValue(ownValue(input, 'analysisFingerprint', context, '$.analysisFingerprint'), '$.analysisFingerprint', context, { required: true });
    var modulesInput = arrayValue(ownValue(input, 'modules', context, '$.modules'), '$.modules', context.limits.maxBlocks, true);
    if (!modulesInput.length) fail('REQUIRED_FIELD', '结构蓝图至少需要一个模块。', '$.modules');
    var moduleIds = Object.create(null);
    var moduleOrders = Object.create(null);
    var modules = modulesInput.map(function (item, index) {
      var module = sanitizeVisualStructureModule(item, index, context, blueprintId);
      if (moduleIds[module.moduleId]) fail('DUPLICATE_ID', '结构蓝图 moduleId 重复。', '$.modules[' + index + '].moduleId');
      if (module.order >= modulesInput.length || moduleOrders[module.order]) fail('INVALID_MODULE_ORDER', '结构模块 order 必须是 0..n-1 的唯一整数。', '$.modules[' + index + '].order');
      moduleIds[module.moduleId] = true;
      moduleOrders[module.order] = true;
      return module;
    }).sort(function (a, b) { return a.order - b.order; });
    sanitizeInputWarnings(ownValue(input, 'warnings', context, '$.warnings'), context);
    return deepFreeze({
      schema: VISUAL_STRUCTURE_BLUEPRINT_SCHEMA,
      schemaVersion: VISUAL_STRUCTURE_SCHEMA_VERSION,
      claimMode: VISUAL_STRUCTURE_ONLY,
      blueprintId: blueprintId,
      sourceSnapshotId: sourceSnapshotId,
      analysisFingerprint: analysisFingerprint,
      revision: revision,
      approvalStatus: approvalStatus,
      approval: sanitizeVisualStructureApproval(ownValue(input, 'approval', context, '$.approval'), approvalStatus, context),
      createdAt: createdAt,
      updatedAt: updatedAt,
      modules: modules,
      warnings: sortedIssues(context)
    });
  }

  var VISUAL_STRUCTURE_DIRECTION_FORBIDDEN = /(?:https?:\/\/|www\.|价格|售价|到手价|券后价|原价|现价|优惠价|折扣|满减|销量|月销|已售|成交量|评价|评论|好评|评分|检测|检验|质检|测试报告|认证|证书|资质|专利|品牌|商标|logo)/i;

  function expectedVisualStructureRiskFlags(module, snapshot) {
    var lookup = snapshotLookup(snapshot);
    var flags = [];
    module.sourceBlockIds.forEach(function (blockId) {
      flags = flags.concat(riskFlagsForBlock(lookup.blocks[blockId], lookup.assets));
    });
    return Array.from(new Set(flags)).sort(compareCodeUnits);
  }

  function assertSafeVisualStructureDirection(module, path, snapshot) {
    var direction = String(module.visualBrief && module.visualBrief.description || '').trim();
    if (!direction) fail('CORE_DIRECTION_REQUIRED', '结构专用蓝图每个选中模块都必须有视觉方向。', path + '.visualBrief.description');
    if (direction.length > 160 || /[\r\n\u2028\u2029]/.test(direction)) fail('INVALID_CORE_DIRECTION', '视觉方向必须为 1–160 字单行文本。', path + '.visualBrief.description');
    var lookup = snapshotLookup(snapshot).blocks;
    var brief = module.visualBrief || {};
    var entries = [
      ['description', brief.description], ['layout', brief.layout], ['mood', brief.mood],
      ['shotType', brief.shotType], ['subjectPlacement', brief.subjectPlacement],
      ['background', brief.background], ['lighting', brief.lighting], ['density', brief.density],
      ['transition', brief.transition]
    ];
    ['palette', 'textZones', 'mustKeep', 'avoid'].forEach(function (key) {
      (brief[key] || []).forEach(function (value, index) { entries.push([key + '[' + index + ']', value]); });
    });
    entries.forEach(function (entry) {
      var fieldPath = path + '.visualBrief.' + entry[0];
      var value = String(entry[1] || '').trim();
      if (!value) return;
      var isAvoid = entry[0].indexOf('avoid[') === 0;
      if (!isAvoid && (VISUAL_STRUCTURE_DIRECTION_FORBIDDEN.test(value) || CORE_DIRECTION_PRICE_VALUE.test(value) ||
          CORE_DIRECTION_QUANTIFIED_FACT.test(coreDirectionFactScanText(value)))) {
        fail('UNSAFE_CORE_DIRECTION', '视觉结构字段不得固化价格、销量、认证、品牌或具体参数事实。', fieldPath);
      }
      var normalized = normalizedComparableText(value);
      module.sourceBlockIds.forEach(function (blockId) {
        var block = lookup[blockId];
        [block && block.sourceSummary, block && block.text].forEach(function (sourceText) {
          var sourceNormalized = normalizedComparableText(sourceText);
          if (sourceNormalized && (normalized === sourceNormalized || normalized.indexOf(sourceNormalized) >= 0 || directionContainsSourceFragment(normalized, sourceText))) {
            fail('SOURCE_CONTENT_LEAK', '视觉结构字段不得复制来源摘要或来源文案。', fieldPath);
          }
        });
      });
      if (sourceFactNeedles(snapshot).some(function (needle) { return normalized.indexOf(needle) >= 0; })) {
        fail('SOURCE_FACT_LEAK', '视觉结构字段不得复制来源商品事实。', fieldPath);
      }
    });
  }

  function assertVisualStructureBlueprintAgainstSource(blueprintInput, snapshotInput, options, immediatePreviousInput) {
    options = isPlainObject(options) ? options : {};
    var blueprint = sanitizeVisualStructureBlueprint(blueprintInput, options);
    var snapshot = sanitizeSourceSnapshot(snapshotInput, options);
    if (blueprint.sourceSnapshotId !== snapshot.snapshotId) fail('SOURCE_SNAPSHOT_MISMATCH', '结构蓝图与来源快照不匹配。', '$.sourceSnapshotId');
    var blockLookup = snapshotLookup(snapshot).blocks;
    blueprint.modules.forEach(function (module, index) {
      var path = '$.modules[' + index + ']';
      var canonical = canonicalSourceBlockIds(module.sourceBlockIds, snapshot, path + '.sourceBlockIds');
      if (stableSerialize(canonical) !== stableSerialize(module.sourceBlockIds)) fail('SOURCE_DERIVATION_MISMATCH', '结构 lineage 必须按来源顺序规范化。', path + '.sourceBlockIds');
      var expectedOriginalIndex = Math.min.apply(Math, canonical.map(function (blockId) { return blockLookup[blockId].originalIndex; }));
      if (module.originalIndex !== expectedOriginalIndex) fail('SOURCE_DERIVATION_MISMATCH', '结构模块原始位置与来源 lineage 不匹配。', path + '.originalIndex');
      if (stableSerialize(module.riskFlags) !== stableSerialize(expectedVisualStructureRiskFlags(module, snapshot))) {
        fail('SOURCE_DERIVATION_MISMATCH', '结构模块风险必须由来源 lineage 严格派生。', path + '.riskFlags');
      }
      if (blueprint.approvalStatus === 'approved' && module.selected) {
        if (module.riskFlags.indexOf('SOURCE_BLOCKED') >= 0 || module.riskFlags.indexOf('BLOCKED_ASSET') >= 0) fail('SOURCE_BLOCKED', 'blocked 来源模块不可批准。', path);
        assertSafeVisualStructureDirection(module, path, snapshot);
      }
    });
    var previousInput = immediatePreviousInput == null ? ownValue(options, 'previousBlueprint') : immediatePreviousInput;
    if (blueprint.revision === 1 && previousInput != null) fail('INVALID_REVISION_CHAIN', '结构蓝图 revision 1 不得携带上一 revision。', '$options.previousBlueprint');
    if (blueprint.revision > 1 && previousInput == null) fail('PREVIOUS_BLUEPRINT_REQUIRED', '结构蓝图 revision > 1 必须携带直接前一 revision。', '$options.previousBlueprint');
    var previous = previousInput == null ? null : sanitizeVisualStructureBlueprint(previousInput, options);
    if (previous) {
      if (previous.blueprintId !== blueprint.blueprintId || previous.sourceSnapshotId !== blueprint.sourceSnapshotId ||
          previous.revision + 1 !== blueprint.revision) {
        fail('INVALID_REVISION_CHAIN', '结构蓝图 revision 链身份或序号不连续。', '$options.previousBlueprint');
      }
      if (blueprint.approvalStatus === 'approved') {
        if (previous.approvalStatus !== 'draft' || previous.analysisFingerprint !== blueprint.analysisFingerprint ||
            stableSerialize(previous.modules) !== stableSerialize(blueprint.modules)) {
          fail('INVALID_APPROVAL_TRANSITION', '结构审批只能从相同结构的直接前一 draft 单独迁移。', '$.approvalStatus');
        }
      } else if (blueprint.approvalStatus !== 'draft') {
        fail('UNPROVEN_APPROVAL_STATE', '结构修订只能保持 draft。', '$.approvalStatus');
      }
    }
    return { blueprint: blueprint, snapshot: snapshot, previous: previous };
  }

  function validateVisualStructureBlueprintAgainstSource(blueprintInput, snapshotInput, options) {
    try {
      var checked = assertVisualStructureBlueprintAgainstSource(blueprintInput, snapshotInput, options);
      return deepFreeze({ ok: true, value: checked.blueprint, errors: [], warnings: checked.blueprint.warnings || [] });
    } catch (error) {
      return deepFreeze({ ok: false, value: null, errors: [{ code: error.code || 'CONTRACT_ERROR', message: String(error.message || error), path: error.path || '$', severity: 'error' }], warnings: [] });
    }
  }

  function projectVisualStructureBlueprint(blueprintInput, snapshotInput, options) {
    options = isPlainObject(options) ? options : {};
    var checked = assertBlueprintAgainstSource(blueprintInput, snapshotInput, options);
    var blueprint = checked.blueprint;
    var previousVisualInput = ownValue(options, 'previousVisualBlueprint');
    var previousVisual = null;
    if (previousVisualInput != null) {
      var previousVisualImmediate = ownValue(options, 'previousVisualImmediatePreviousBlueprint');
      if (Number(previousVisualInput && previousVisualInput.revision) > 1 && previousVisualImmediate == null) {
        fail('PREVIOUS_BLUEPRINT_REQUIRED', '连续结构投影必须同时提供上一 V2 envelope 的 immediatePreviousBlueprint。', '$options.previousVisualImmediatePreviousBlueprint');
      }
      previousVisual = createVisualStructureRevisionEnvelope(
        previousVisualInput, previousVisualImmediate == null ? null : previousVisualImmediate, checked.snapshot, optionsWithoutPrevious(options)
      ).currentBlueprint;
    }
    var createdAt = ownValue(options, 'createdAt') || blueprint.updatedAt;
    var raw = {
      schema: VISUAL_STRUCTURE_BLUEPRINT_SCHEMA,
      schemaVersion: VISUAL_STRUCTURE_SCHEMA_VERSION,
      claimMode: VISUAL_STRUCTURE_ONLY,
      blueprintId: blueprint.blueprintId,
      sourceSnapshotId: blueprint.sourceSnapshotId,
      analysisFingerprint: stableHash({ schema: blueprint.schema, revision: blueprint.revision, modules: blueprint.modules }, 'rdanalysis_'),
      revision: previousVisual ? previousVisual.revision + 1 : 1,
      approvalStatus: 'draft',
      approval: { approvedAt: '', verificationId: '', claimMode: VISUAL_STRUCTURE_ONLY },
      createdAt: previousVisual ? previousVisual.createdAt : createdAt,
      updatedAt: createdAt,
      modules: blueprint.modules.map(function (module) {
        return {
          moduleId: module.moduleId,
          blockId: module.moduleId,
          sourceBlockIds: module.sourceBlockIds.slice(),
          derivation: cloneJson(module.derivation),
          originalIndex: module.originalIndex,
          order: module.order,
          type: module.type,
          salesRole: module.salesRole,
          visualBrief: cloneJson(module.visualBrief),
          selected: module.selected,
          locked: module.locked,
          riskFlags: expectedVisualStructureRiskFlags(module, checked.snapshot)
        };
      })
    };
    return assertVisualStructureBlueprintAgainstSource(raw, checked.snapshot, optionsWithoutPrevious(options), previousVisual).blueprint;
  }

  function approveVisualStructureBlueprint(blueprintInput, snapshotInput, approvalContext, options) {
    approvalContext = isPlainObject(approvalContext) ? approvalContext : {};
    options = isPlainObject(options) ? options : {};
    var baseOptions = optionsWithoutPrevious(options);
    var checked = assertVisualStructureBlueprintAgainstSource(blueprintInput, snapshotInput, options);
    var blueprint = checked.blueprint;
    if (blueprint.approvalStatus !== 'draft') fail('INVALID_APPROVAL_TRANSITION', '只有结构 draft 可执行确认。', '$.approvalStatus');
    if (!blueprint.modules.some(function (module) { return module.selected; })) fail('NO_SELECTED_MODULE', '结构确认至少需要一个选中模块。', '$.modules');
    var directionOwners = Object.create(null);
    blueprint.modules.forEach(function (module, index) {
      if (!module.selected) return;
      assertSafeVisualStructureDirection(module, '$.modules[' + index + ']', checked.snapshot);
      var comparable = normalizedComparableText(module.visualBrief.description);
      if (directionOwners[comparable] != null) fail('SCREEN_DIRECTION_DUPLICATE', '每个结构分屏必须有独立视觉方向。', '$.modules[' + index + '].visualBrief.description');
      directionOwners[comparable] = index;
    });
    var context = createContext(options);
    assertNoVisualStructureFactFields(approvalContext, '$approval');
    var approvedAt = timestampValue(ownValue(approvalContext, 'approvedAt'), '$approval.approvedAt', context);
    var verificationId = idValue(ownValue(approvalContext, 'verificationId'), '$approval.verificationId', context, { required: true });
    var raw = cloneJson(blueprint);
    raw.revision = blueprint.revision + 1;
    raw.approvalStatus = 'approved';
    raw.approval = { approvedAt: approvedAt, verificationId: verificationId, claimMode: VISUAL_STRUCTURE_ONLY };
    raw.updatedAt = approvedAt;
    return assertVisualStructureBlueprintAgainstSource(raw, checked.snapshot, baseOptions, blueprint).blueprint;
  }

  function createVisualStructureRevisionEnvelope(currentBlueprintInput, immediatePreviousInput, snapshotInput, options) {
    var current = sanitizeVisualStructureBlueprint(currentBlueprintInput, options);
    if (current.revision === 1 && immediatePreviousInput != null) fail('INVALID_REVISION_CHAIN', '结构 revision 1 envelope 不得含前一版本。', '$envelope.immediatePreviousBlueprint');
    if (current.revision > 1 && immediatePreviousInput == null) fail('PREVIOUS_BLUEPRINT_REQUIRED', '结构 revision > 1 envelope 必须含直接前一版本。', '$envelope.immediatePreviousBlueprint');
    var checked = assertVisualStructureBlueprintAgainstSource(current, snapshotInput, optionsWithoutPrevious(options), immediatePreviousInput);
    return deepFreeze({ currentBlueprint: checked.blueprint, immediatePreviousBlueprint: checked.previous });
  }

  function advanceVisualStructureRevisionEnvelope(envelopeInput, nextBlueprintInput, snapshotInput, options) {
    if (!isPlainObject(envelopeInput)) fail('INVALID_REVISION_ENVELOPE', '结构 revision envelope 必须是普通对象。', '$envelope');
    var restored = createVisualStructureRevisionEnvelope(
      ownValue(envelopeInput, 'currentBlueprint'), ownValue(envelopeInput, 'immediatePreviousBlueprint'), snapshotInput, options
    );
    var checked = assertVisualStructureBlueprintAgainstSource(nextBlueprintInput, snapshotInput, optionsWithoutPrevious(options), restored.currentBlueprint);
    return deepFreeze({ currentBlueprint: checked.blueprint, immediatePreviousBlueprint: restored.currentBlueprint });
  }

  function sanitizeVisualStructureBatchTask(item, index, context, blueprintId, blueprintRevision) {
    var path = '$.tasks[' + index + ']';
    if (!isPlainObject(item)) fail('INVALID_BATCH_TASK', '结构批量任务必须是普通对象。', path);
    assertNoVisualStructureFactFields(item, path);
    var subjectAssetIds = arrayValue(ownValue(item, 'subjectAssetIds', context, path + '.subjectAssetIds'), path + '.subjectAssetIds', context.limits.maxSubjectAssetsPerTask, true)
      .map(function (id, assetIndex) { return idValue(id, path + '.subjectAssetIds[' + assetIndex + ']', context, { required: true }); });
    var modelAssetIds = arrayValue(ownValue(item, 'modelAssetIds', context, path + '.modelAssetIds'), path + '.modelAssetIds', context.limits.maxSubjectAssetsPerTask, false)
      .map(function (id, assetIndex) { return idValue(id, path + '.modelAssetIds[' + assetIndex + ']', context, { required: true }); });
    subjectAssetIds = Array.from(new Set(subjectAssetIds)).sort(compareCodeUnits);
    modelAssetIds = Array.from(new Set(modelAssetIds)).sort(compareCodeUnits);
    if (!subjectAssetIds.length) fail('SUBJECT_ASSET_REQUIRED', '结构批量目标至少需要一张主体素材。', path + '.subjectAssetIds');
    if (modelAssetIds.some(function (assetId) { return subjectAssetIds.indexOf(assetId) >= 0; })) fail('TARGET_ASSET_ROLE_MISMATCH', '同一素材不得同时声明 subject 与 model。', path + '.modelAssetIds');
    var skuIds = arrayValue(ownValue(item, 'skuIds', context, path + '.skuIds'), path + '.skuIds', context.limits.maxSkuIdsPerTask, false)
      .map(function (id, skuIndex) { return idValue(id, path + '.skuIds[' + skuIndex + ']', context, { required: true }); });
    var errors = arrayValue(ownValue(item, 'errors', context, path + '.errors'), path + '.errors', context.limits.maxErrorsPerTask, false)
      .map(function (error, errorIndex) { return sanitizeTaskError(error, path + '.errors[' + errorIndex + ']', context); });
    var resultRefs = arrayValue(ownValue(item, 'resultRefs', context, path + '.resultRefs'), path + '.resultRefs', context.limits.maxResultsPerTask, false)
      .map(function (result, resultIndex) { return sanitizeResultRef(result, path + '.resultRefs[' + resultIndex + ']', context); });
    var task = {
      taskId: idValue(ownValue(item, 'taskId', context, path + '.taskId'), path + '.taskId', context, { required: true }),
      taskKey: idValue(ownValue(item, 'taskKey', context, path + '.taskKey'), path + '.taskKey', context),
      targetInputId: idValue(ownValue(item, 'targetInputId', context, path + '.targetInputId'), path + '.targetInputId', context, { required: true }),
      subjectAssetIds: subjectAssetIds,
      modelAssetIds: modelAssetIds,
      skuIds: Array.from(new Set(skuIds)).sort(compareCodeUnits),
      status: enumValue(ownValue(item, 'status', context, path + '.status'), TASK_STATUSES, 'pending', path + '.status'),
      errors: errors,
      resultRefs: resultRefs
    };
    var expectedId = stableHash({
      claimMode: VISUAL_STRUCTURE_ONLY,
      blueprintId: blueprintId,
      revision: blueprintRevision,
      targetInputId: task.targetInputId,
      taskKey: task.taskKey,
      subjectAssetIds: task.subjectAssetIds,
      modelAssetIds: task.modelAssetIds,
      skuIds: task.skuIds
    }, 'rdt2_');
    if (task.taskId !== expectedId) fail('ID_MISMATCH', 'V2 taskId 与主体/模特完整身份不匹配。', path + '.taskId');
    return task;
  }

  function visualStructureBatchIdentity(blueprintId, revision, batchKey, screenCount, tasks) {
    return {
      claimMode: VISUAL_STRUCTURE_ONLY,
      blueprintId: blueprintId,
      blueprintRevision: revision,
      batchKey: batchKey,
      screenCount: screenCount,
      taskIds: tasks.map(function (task) { return task.taskId; })
    };
  }

  function sanitizeVisualStructureBatchProject(input, options) {
    var context = createContext(options);
    if (!isPlainObject(input)) fail('INVALID_CONTRACT', '结构批量项目必须是普通对象。', '$');
    assertNoVisualStructureFactFields(input, '$');
    if (ownValue(input, 'schema', context, '$.schema') !== VISUAL_STRUCTURE_BATCH_SCHEMA ||
        Number(ownValue(input, 'schemaVersion', context, '$.schemaVersion')) !== VISUAL_STRUCTURE_SCHEMA_VERSION) {
      fail('INVALID_SCHEMA', '结构批量项目 schema 无效。', '$.schema');
    }
    if (ownValue(input, 'claimMode', context, '$.claimMode') !== VISUAL_STRUCTURE_ONLY) fail('INVALID_CLAIM_MODE', '结构批次 claimMode 无效。', '$.claimMode');
    var blueprintId = idValue(ownValue(input, 'blueprintId', context, '$.blueprintId'), '$.blueprintId', context, { required: true });
    var blueprintRevision = positiveIntegerValue(ownValue(input, 'blueprintRevision', context, '$.blueprintRevision'), '$.blueprintRevision');
    var batchKey = idValue(ownValue(input, 'batchKey', context, '$.batchKey'), '$.batchKey', context);
    var screenCount = screenCountValue(ownValue(input, 'screenCount', context, '$.screenCount'), '$.screenCount');
    var tasksInput = arrayValue(ownValue(input, 'tasks', context, '$.tasks'), '$.tasks', context.limits.maxBatchTasks, true);
    if (!tasksInput.length) fail('REQUIRED_FIELD', '结构批量项目至少需要一个任务。', '$.tasks');
    var ids = Object.create(null);
    var targetIds = Object.create(null);
    var tasks = tasksInput.map(function (item, index) {
      var task = sanitizeVisualStructureBatchTask(item, index, context, blueprintId, blueprintRevision);
      if (ids[task.taskId] || targetIds[task.targetInputId]) fail('DUPLICATE_ID', '结构批次任务或 targetInputId 重复。', '$.tasks[' + index + ']');
      ids[task.taskId] = true;
      targetIds[task.targetInputId] = true;
      if ((task.status === 'failed' || task.status === 'blocked') && !task.errors.length) fail('TASK_STATE_MISMATCH', 'failed/blocked 任务必须带错误。', '$.tasks[' + index + '].errors');
      return task;
    });
    var expectedBatchId = stableHash(visualStructureBatchIdentity(blueprintId, blueprintRevision, batchKey, screenCount, tasks), 'rdbatch2_');
    var batchId = idValue(ownValue(input, 'batchId', context, '$.batchId'), '$.batchId', context, { required: true });
    if (batchId !== expectedBatchId) fail('ID_MISMATCH', 'V2 batchId 与完整任务身份不匹配。', '$.batchId');
    var status = derivedBatchStatus(tasks);
    if (enumValue(ownValue(input, 'status', context, '$.status'), BATCH_STATUSES, status, '$.status') !== status) fail('BATCH_STATUS_MISMATCH', '结构批次状态与任务汇总不一致。', '$.status');
    var createdAt = timestampValue(ownValue(input, 'createdAt', context, '$.createdAt'), '$.createdAt', context);
    var updatedAt = timestampValue(ownValue(input, 'updatedAt', context, '$.updatedAt'), '$.updatedAt', context, createdAt);
    return deepFreeze({
      schema: VISUAL_STRUCTURE_BATCH_SCHEMA,
      schemaVersion: VISUAL_STRUCTURE_SCHEMA_VERSION,
      claimMode: VISUAL_STRUCTURE_ONLY,
      batchId: batchId,
      batchKey: batchKey,
      blueprintId: blueprintId,
      blueprintRevision: blueprintRevision,
      sourceSnapshotId: idValue(ownValue(input, 'sourceSnapshotId', context, '$.sourceSnapshotId'), '$.sourceSnapshotId', context, { required: true }),
      createdAt: createdAt,
      updatedAt: updatedAt,
      status: status,
      screenCount: screenCount,
      maxReferenceImagesPerCall: 0,
      tasks: tasks,
      warnings: sortedIssues(context)
    });
  }

  function assertVisualStructureTargetAsset(assetRegistry, assetId, role, path) {
    var verified = assetRegistry[assetId];
    if (!verified || (verified.rightsStatus !== 'authorized' && verified.rightsStatus !== 'self_owned')) {
      fail('UNVERIFIED_TARGET_ASSET', '目标素材未通过可信授权 registry。', path);
    }
    if (verified.role !== role) fail('TARGET_ASSET_ROLE_MISMATCH', '目标素材角色与 subject/model 槽位不一致。', path);
  }

  function createVisualStructureBatchProject(blueprintInput, targets, options) {
    options = isPlainObject(options) ? options : {};
    var snapshotInput = ownValue(options, 'sourceSnapshot');
    if (!snapshotInput) fail('SOURCE_SNAPSHOT_REQUIRED', '创建结构批次必须提供来源快照。', '$options.sourceSnapshot');
    var checked = assertVisualStructureBlueprintAgainstSource(blueprintInput, snapshotInput, options);
    var blueprint = checked.blueprint;
    if (blueprint.approvalStatus !== 'approved') fail('BLUEPRINT_NOT_APPROVED', '只有 approved 结构蓝图可创建批次。', '$.approvalStatus');
    var context = createContext(options);
    var assetRegistry = verifiedTargetAssetRegistry(options, context);
    var limits = normalizedLimits(options);
    targets = arrayValue(targets, '$targets', limits.maxBatchTasks, true);
    if (!targets.length) fail('REQUIRED_FIELD', '结构批次至少需要一个目标。', '$targets');
    var tasks = targets.map(function (target, index) {
      var path = '$targets[' + index + ']';
      if (!isPlainObject(target)) fail('INVALID_BATCH_TARGET', '结构批次目标必须是普通对象。', path);
      assertNoVisualStructureFactFields(target, path);
      var targetInputId = idValue(ownValue(target, 'targetInputId'), path + '.targetInputId', context, { required: true });
      var taskKey = idValue(ownValue(target, 'taskKey'), path + '.taskKey', context);
      var subjectAssetIds = arrayValue(ownValue(target, 'subjectAssetIds'), path + '.subjectAssetIds', limits.maxSubjectAssetsPerTask, true)
        .map(function (id, assetIndex) { return idValue(id, path + '.subjectAssetIds[' + assetIndex + ']', context, { required: true }); });
      var modelAssetIds = arrayValue(ownValue(target, 'modelAssetIds'), path + '.modelAssetIds', limits.maxSubjectAssetsPerTask, false)
        .map(function (id, assetIndex) { return idValue(id, path + '.modelAssetIds[' + assetIndex + ']', context, { required: true }); });
      subjectAssetIds = Array.from(new Set(subjectAssetIds)).sort(compareCodeUnits);
      modelAssetIds = Array.from(new Set(modelAssetIds)).sort(compareCodeUnits);
      if (!subjectAssetIds.length) fail('SUBJECT_ASSET_REQUIRED', '每个结构目标至少需要一张主体素材。', path + '.subjectAssetIds');
      subjectAssetIds.forEach(function (assetId, assetIndex) { assertVisualStructureTargetAsset(assetRegistry, assetId, 'subject', path + '.subjectAssetIds[' + assetIndex + ']'); });
      modelAssetIds.forEach(function (assetId, assetIndex) { assertVisualStructureTargetAsset(assetRegistry, assetId, 'model', path + '.modelAssetIds[' + assetIndex + ']'); });
      if (modelAssetIds.some(function (assetId) { return subjectAssetIds.indexOf(assetId) >= 0; })) fail('TARGET_ASSET_ROLE_MISMATCH', '同一素材不得同时作为主体与模特。', path + '.modelAssetIds');
      var skuIds = arrayValue(ownValue(target, 'skuIds'), path + '.skuIds', limits.maxSkuIdsPerTask, false)
        .map(function (id, skuIndex) { return idValue(id, path + '.skuIds[' + skuIndex + ']', context, { required: true }); });
      var task = {
        taskId: '', taskKey: taskKey, targetInputId: targetInputId,
        subjectAssetIds: subjectAssetIds, modelAssetIds: modelAssetIds,
        skuIds: Array.from(new Set(skuIds)).sort(compareCodeUnits),
        status: 'pending', errors: [], resultRefs: []
      };
      task.taskId = stableHash({
        claimMode: VISUAL_STRUCTURE_ONLY, blueprintId: blueprint.blueprintId, revision: blueprint.revision,
        targetInputId: task.targetInputId, taskKey: task.taskKey,
        subjectAssetIds: task.subjectAssetIds, modelAssetIds: task.modelAssetIds, skuIds: task.skuIds
      }, 'rdt2_');
      return task;
    });
    var screenCount = screenCountValue(ownValue(options, 'screenCount'), '$options.screenCount');
    var batchKey = idValue(ownValue(options, 'batchKey'), '$options.batchKey', context);
    var createdAt = ownValue(options, 'createdAt') || blueprint.updatedAt;
    var raw = {
      schema: VISUAL_STRUCTURE_BATCH_SCHEMA, schemaVersion: VISUAL_STRUCTURE_SCHEMA_VERSION, claimMode: VISUAL_STRUCTURE_ONLY,
      batchId: stableHash(visualStructureBatchIdentity(blueprint.blueprintId, blueprint.revision, batchKey, screenCount, tasks), 'rdbatch2_'),
      batchKey: batchKey, blueprintId: blueprint.blueprintId, blueprintRevision: blueprint.revision,
      sourceSnapshotId: blueprint.sourceSnapshotId, createdAt: createdAt, updatedAt: createdAt,
      status: derivedBatchStatus(tasks), screenCount: screenCount, tasks: tasks
    };
    var batch = sanitizeVisualStructureBatchProject(raw, options);
    assertVisualStructureBatchAgainstBlueprint(batch, blueprint, options);
    return batch;
  }

  function assertVisualStructureBatchAgainstBlueprint(batchInput, blueprintInput, options) {
    options = isPlainObject(options) ? options : {};
    var batch = sanitizeVisualStructureBatchProject(batchInput, options);
    var snapshotInput = ownValue(options, 'sourceSnapshot');
    if (!snapshotInput) fail('SOURCE_SNAPSHOT_REQUIRED', '结构批次校验必须提供来源快照。', '$options.sourceSnapshot');
    var checked = assertVisualStructureBlueprintAgainstSource(blueprintInput, snapshotInput, options);
    var blueprint = checked.blueprint;
    if (blueprint.approvalStatus !== 'approved') fail('BLUEPRINT_NOT_APPROVED', '结构批次只能关联 approved 蓝图。', '$blueprint.approvalStatus');
    if (batch.blueprintId !== blueprint.blueprintId || batch.blueprintRevision !== blueprint.revision || batch.sourceSnapshotId !== blueprint.sourceSnapshotId) {
      fail('LINKAGE_MISMATCH', '结构批次与蓝图身份、revision 或快照不匹配。', '$.blueprintId');
    }
    var registry = verifiedTargetAssetRegistry(options, createContext(options));
    batch.tasks.forEach(function (task, taskIndex) {
      task.subjectAssetIds.forEach(function (assetId, assetIndex) { assertVisualStructureTargetAsset(registry, assetId, 'subject', '$.tasks[' + taskIndex + '].subjectAssetIds[' + assetIndex + ']'); });
      task.modelAssetIds.forEach(function (assetId, assetIndex) { assertVisualStructureTargetAsset(registry, assetId, 'model', '$.tasks[' + taskIndex + '].modelAssetIds[' + assetIndex + ']'); });
    });
    return { batch: batch, blueprint: blueprint };
  }

  function validateVisualStructureBatchAgainstBlueprint(batchInput, blueprintInput, options) {
    try {
      var checked = assertVisualStructureBatchAgainstBlueprint(batchInput, blueprintInput, options);
      return deepFreeze({ ok: true, value: checked.batch, errors: [], warnings: checked.batch.warnings || [] });
    } catch (error) {
      return deepFreeze({ ok: false, value: null, errors: [{ code: error.code || 'CONTRACT_ERROR', message: String(error.message || error), path: error.path || '$', severity: 'error' }], warnings: [] });
    }
  }

  function updateVisualStructureBatchProject(batchInput, changes, blueprintInput, options) {
    changes = isPlainObject(changes) ? changes : {};
    options = isPlainObject(options) ? options : {};
    var checked = assertVisualStructureBatchAgainstBlueprint(batchInput, blueprintInput, options);
    var raw = cloneJson(checked.batch);
    ['batchId', 'batchKey', 'blueprintId', 'blueprintRevision', 'sourceSnapshotId', 'screenCount', 'tasks', 'status', 'claimMode'].forEach(function (key) {
      if (ownDescriptor(changes, key)) fail('IMMUTABLE_BATCH_FIELD', '结构批次身份字段不能直接修改。', '$changes.' + key);
    });
    var updates = arrayValue(ownValue(changes, 'taskUpdates'), '$changes.taskUpdates', normalizedLimits(options).maxBatchTasks, false);
    var byId = Object.create(null);
    raw.tasks.forEach(function (task) { byId[task.taskId] = task; });
    var seen = Object.create(null);
    updates.forEach(function (update, index) {
      var path = '$changes.taskUpdates[' + index + ']';
      if (!isPlainObject(update)) fail('INVALID_TASK_UPDATE', 'taskUpdate 必须是普通对象。', path);
      ['taskKey', 'targetInputId', 'subjectAssetIds', 'modelAssetIds', 'skuIds'].forEach(function (key) {
        if (ownDescriptor(update, key)) fail('IMMUTABLE_TASK_FIELD', 'V2 任务身份字段不可修改。', path + '.' + key);
      });
      var taskId = String(ownValue(update, 'taskId') || '');
      if (!byId[taskId] || seen[taskId]) fail('UNKNOWN_OR_DUPLICATE_TASK', 'taskId 不存在或重复。', path + '.taskId');
      seen[taskId] = true;
      ['status', 'errors', 'resultRefs'].forEach(function (key) {
        var descriptor = ownDescriptor(update, key);
        if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) byId[taskId][key] = descriptor.value;
      });
    });
    raw.status = derivedBatchStatus(raw.tasks);
    raw.updatedAt = ownValue(options, 'updatedAt') || checked.batch.updatedAt;
    var updated = sanitizeVisualStructureBatchProject(raw, options);
    assertVisualStructureBatchAgainstBlueprint(updated, checked.blueprint, options);
    return updated;
  }

  function sanitizeTaskError(item, path, context) {
    if (!isPlainObject(item)) fail('INVALID_TASK_ERROR', '任务错误必须是普通对象。', path);
    return {
      code: idValue(ownValue(item, 'code', context, path + '.code'), path + '.code', context, { required: true, max: 80 }),
      stage: idValue(ownValue(item, 'stage', context, path + '.stage') || 'unknown', path + '.stage', context, { required: true, max: 80 }),
      message: textValue(ownValue(item, 'message', context, path + '.message'), path + '.message', context, { required: true, max: context.limits.maxShortTextLength }),
      retryable: booleanValue(ownValue(item, 'retryable'), false)
    };
  }

  function sanitizeResultRef(item, path, context) {
    if (!isPlainObject(item)) fail('INVALID_RESULT_REF', '结果引用必须是普通对象。', path);
    return {
      resultId: idValue(ownValue(item, 'resultId', context, path + '.resultId'), path + '.resultId', context, { required: true }),
      kind: enumValue(ownValue(item, 'kind', context, path + '.kind'), RESULT_KINDS, 'unknown', path + '.kind'),
      ref: idValue(ownValue(item, 'ref', context, path + '.ref'), path + '.ref', context, { required: true, max: 500 })
    };
  }

  function sanitizeBatchTask(item, index, context) {
    var path = '$.tasks[' + index + ']';
    if (!isPlainObject(item)) fail('INVALID_BATCH_TASK', '批量任务必须是普通对象。', path);
    var subjectAssetIds = arrayValue(ownValue(item, 'subjectAssetIds', context, path + '.subjectAssetIds'), path + '.subjectAssetIds', context.limits.maxSubjectAssetsPerTask, false)
      .map(function (id, assetIndex) { return idValue(id, path + '.subjectAssetIds[' + assetIndex + ']', context, { required: true }); });
    var skuIds = arrayValue(ownValue(item, 'skuIds', context, path + '.skuIds'), path + '.skuIds', context.limits.maxSkuIdsPerTask, false)
      .map(function (id, skuIndex) { return idValue(id, path + '.skuIds[' + skuIndex + ']', context, { required: true }); });
    var errors = arrayValue(ownValue(item, 'errors', context, path + '.errors'), path + '.errors', context.limits.maxErrorsPerTask, false)
      .map(function (error, errorIndex) { return sanitizeTaskError(error, path + '.errors[' + errorIndex + ']', context); });
    var resultRefs = arrayValue(ownValue(item, 'resultRefs', context, path + '.resultRefs'), path + '.resultRefs', context.limits.maxResultsPerTask, false)
      .map(function (result, resultIndex) { return sanitizeResultRef(result, path + '.resultRefs[' + resultIndex + ']', context); });
    return {
      taskId: idValue(ownValue(item, 'taskId', context, path + '.taskId'), path + '.taskId', context, { required: true }),
      taskKey: idValue(ownValue(item, 'taskKey', context, path + '.taskKey'), path + '.taskKey', context),
      productFactCardId: idValue(ownValue(item, 'productFactCardId', context, path + '.productFactCardId'), path + '.productFactCardId', context, { required: true }),
      subjectAssetIds: Array.from(new Set(subjectAssetIds)).sort(compareCodeUnits),
      skuIds: Array.from(new Set(skuIds)).sort(compareCodeUnits),
      status: enumValue(ownValue(item, 'status', context, path + '.status'), TASK_STATUSES, 'pending', path + '.status'),
      errors: errors,
      resultRefs: resultRefs
    };
  }

  function taskIdentity(blueprintId, blueprintRevision, task) {
    return {
      blueprintId: blueprintId,
      revision: blueprintRevision,
      taskKey: task.taskKey,
      productFactCardId: task.productFactCardId,
      subjectAssetIds: task.subjectAssetIds.slice(),
      skuIds: task.skuIds.slice()
    };
  }

  function batchIdentity(blueprintId, blueprintRevision, batchKey, screenCount, tasks) {
    return {
      blueprintId: blueprintId,
      blueprintRevision: blueprintRevision,
      batchKey: batchKey,
      screenCount: screenCount,
      taskIds: tasks.map(function (task) { return task.taskId; })
    };
  }

  function derivedBatchStatus(tasks) {
    var statuses = tasks.map(function (task) { return task.status; });
    if (statuses.indexOf('running') >= 0) return 'running';
    if (statuses.every(function (status) { return status === 'completed'; })) return 'completed';
    if (statuses.indexOf('failed') >= 0) {
      return statuses.some(function (status) { return status === 'completed' || status === 'cancelled' || status === 'blocked'; }) ? 'partial' : 'failed';
    }
    if (statuses.indexOf('blocked') >= 0) return 'blocked';
    if (statuses.every(function (status) { return status === 'cancelled'; })) return 'cancelled';
    if (statuses.some(function (status) { return status === 'completed' || status === 'cancelled'; })) return 'partial';
    return 'ready';
  }

  function sanitizeBatchProject(input, options) {
    var context = createContext(options);
    if (!isPlainObject(input)) fail('INVALID_CONTRACT', '批量项目必须是普通对象。', '$');
    if (ownValue(input, 'schema', context, '$.schema') !== BATCH_SCHEMA) fail('INVALID_SCHEMA', '批量项目 schema 无效。', '$.schema');
    if (Number(ownValue(input, 'schemaVersion', context, '$.schemaVersion')) !== SCHEMA_VERSION) fail('INVALID_SCHEMA_VERSION', 'schemaVersion 必须为 1。', '$.schemaVersion');
    var blueprintId = idValue(ownValue(input, 'blueprintId', context, '$.blueprintId'), '$.blueprintId', context, { required: true });
    var blueprintRevision = positiveIntegerValue(ownValue(input, 'blueprintRevision', context, '$.blueprintRevision'), '$.blueprintRevision');
    var batchKey = idValue(ownValue(input, 'batchKey', context, '$.batchKey'), '$.batchKey', context);
    var screenCount = screenCountValue(ownValue(input, 'screenCount', context, '$.screenCount'), '$.screenCount');
    var tasksInput = arrayValue(ownValue(input, 'tasks', context, '$.tasks'), '$.tasks', context.limits.maxBatchTasks, true);
    if (!tasksInput.length) fail('REQUIRED_FIELD', '批量项目至少需要一个任务。', '$.tasks');
    var tasks = [];
    var ids = Object.create(null);
    tasksInput.forEach(function (item, index) {
      var task = sanitizeBatchTask(item, index, context);
      if (ids[task.taskId]) fail('DUPLICATE_ID', '批量 taskId 重复。', '$.tasks[' + index + '].taskId');
      var expectedTaskId = stableHash(taskIdentity(blueprintId, blueprintRevision, task), 'rdt_');
      if (task.taskId !== expectedTaskId) fail('ID_MISMATCH', 'taskId 与规范化任务载荷不匹配。', '$.tasks[' + index + '].taskId');
      if ((task.status === 'failed' || task.status === 'blocked') && !task.errors.length) {
        fail('TASK_STATE_MISMATCH', 'failed/blocked 任务必须包含结构化错误。', '$.tasks[' + index + '].errors');
      }
      ids[task.taskId] = true;
      tasks.push(task);
    });
    var expectedBatchId = stableHash(batchIdentity(blueprintId, blueprintRevision, batchKey, screenCount, tasks), 'rdbatch_');
    var batchId = idValue(ownValue(input, 'batchId', context, '$.batchId'), '$.batchId', context, { required: true });
    if (batchId !== expectedBatchId) fail('ID_MISMATCH', 'batchId 与规范化批次载荷不匹配。', '$.batchId');
    var expectedStatus = derivedBatchStatus(tasks);
    var requestedStatus = enumValue(ownValue(input, 'status', context, '$.status'), BATCH_STATUSES, expectedStatus, '$.status');
    if (requestedStatus !== expectedStatus) fail('BATCH_STATUS_MISMATCH', '批次 status 与任务汇总状态不一致。', '$.status');
    var createdAt = timestampValue(ownValue(input, 'createdAt', context, '$.createdAt'), '$.createdAt', context);
    var updatedAt = timestampValue(ownValue(input, 'updatedAt', context, '$.updatedAt'), '$.updatedAt', context, createdAt);
    sanitizeInputWarnings(ownValue(input, 'warnings', context, '$.warnings'), context);
    return deepFreeze({
      schema: BATCH_SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      batchId: batchId,
      batchKey: batchKey,
      blueprintId: blueprintId,
      blueprintRevision: blueprintRevision,
      sourceSnapshotId: idValue(ownValue(input, 'sourceSnapshotId', context, '$.sourceSnapshotId'), '$.sourceSnapshotId', context, { required: true }),
      createdAt: createdAt,
      updatedAt: updatedAt,
      status: expectedStatus,
      screenCount: screenCount,
      maxReferenceImagesPerCall: 6,
      tasks: tasks,
      warnings: sortedIssues(context)
    });
  }

  function createBatchProject(blueprintInput, targets, options) {
    options = isPlainObject(options) ? options : {};
    var sourceSnapshot = ownValue(options, 'sourceSnapshot');
    if (!sourceSnapshot) fail('SOURCE_SNAPSHOT_REQUIRED', '创建批次必须提供可信不可变来源快照用于交叉校验。', '$options.sourceSnapshot');
    var checkedBlueprint = assertBlueprintAgainstSource(blueprintInput, sourceSnapshot, options);
    var blueprint = checkedBlueprint.blueprint;
    if (blueprint.approvalStatus !== 'approved') fail('BLUEPRINT_NOT_APPROVED', '只有审核通过的蓝图才能创建批量项目。', '$.approvalStatus');
    var limits = normalizedLimits(options);
    var trustContext = createContext(options);
    var assetRegistry = verifiedTargetAssetRegistry(options, trustContext);
    var factRegistry = verifiedFactCardRegistry(options, trustContext);
    var screenCount = screenCountValue(ownValue(options, 'screenCount'), '$options.screenCount');
    var batchKey = idValue(ownValue(options, 'batchKey'), '$options.batchKey', trustContext);
    targets = arrayValue(targets, '$targets', limits.maxBatchTasks, true);
    if (!targets.length) fail('REQUIRED_FIELD', '批量项目至少需要一个商品绑定。', '$targets');
    var rawTasks = targets.map(function (target, index) {
      var path = '$targets[' + index + ']';
      if (!isPlainObject(target)) fail('INVALID_BATCH_TARGET', '批量绑定必须是普通对象。', path);
      var productFactCardId = String(ownValue(target, 'productFactCardId') || '');
      if (!SAFE_ID.test(productFactCardId)) fail('INVALID_ID', 'productFactCardId 无效。', path + '.productFactCardId');
      if (blueprint.approval.productFactCardIds.indexOf(productFactCardId) < 0 || !factRegistry[productFactCardId]) {
        fail('UNVERIFIED_FACT_CARD', '批量任务事实卡未包含在蓝图可信审批范围。', path + '.productFactCardId');
      }
      var taskKey = String(ownValue(target, 'taskKey') || '');
      if (taskKey && !SAFE_ID.test(taskKey)) fail('INVALID_ID', 'taskKey 无效。', path + '.taskKey');
      if (ownDescriptor(target, 'subjectAssets')) {
        fail('UNTRUSTED_RIGHTS_ASSERTION', '批量目标不得在 subjectAssets 中自报 rightsStatus；只提交 subjectAssetIds 并由可信 registry 复核。', path + '.subjectAssets');
      }
      var requestedSubjectIds = arrayValue(ownValue(target, 'subjectAssetIds'), path + '.subjectAssetIds', limits.maxSubjectAssetsPerTask, false)
        .map(function (id, assetIndex) { return idValue(id, path + '.subjectAssetIds[' + assetIndex + ']', trustContext, { required: true }); });
      var authorizedIds = [];
      var rejectedCount = 0;
      requestedSubjectIds.forEach(function (assetId) {
        var verified = assetRegistry[assetId];
        if (verified && (verified.rightsStatus === 'authorized' || verified.rightsStatus === 'self_owned')) authorizedIds.push(assetId);
        else rejectedCount += 1;
      });
      authorizedIds = Array.from(new Set(authorizedIds)).sort(compareCodeUnits);
      var errors = [];
      if (!authorizedIds.length) errors.push({
        code: 'SUBJECT_ASSET_NOT_AUTHORIZED',
        stage: 'binding',
        message: rejectedCount ? '主体素材均未获得可复用授权，任务已阻断。' : '缺少已授权或自有主体素材，任务已阻断。',
        retryable: false
      });
      var skuIds = arrayValue(ownValue(target, 'skuIds'), path + '.skuIds', limits.maxSkuIdsPerTask, false)
        .map(function (id, skuIndex) { return idValue(id, path + '.skuIds[' + skuIndex + ']', trustContext, { required: true }); });
      skuIds = Array.from(new Set(skuIds)).sort(compareCodeUnits);
      var task = {
        taskId: '',
        taskKey: taskKey,
        productFactCardId: productFactCardId,
        subjectAssetIds: authorizedIds,
        skuIds: skuIds,
        status: errors.length ? 'blocked' : 'pending',
        errors: errors,
        resultRefs: []
      };
      task.taskId = stableHash(taskIdentity(blueprint.blueprintId, blueprint.revision, task), 'rdt_');
      return task;
    });
    var stableBatchIdentity = batchIdentity(blueprint.blueprintId, blueprint.revision, batchKey, screenCount, rawTasks);
    var createdAt = ownValue(options, 'createdAt') || blueprint.updatedAt;
    var raw = {
      schema: BATCH_SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      batchId: stableHash(stableBatchIdentity, 'rdbatch_'),
      batchKey: batchKey,
      blueprintId: blueprint.blueprintId,
      blueprintRevision: blueprint.revision,
      sourceSnapshotId: blueprint.sourceSnapshotId,
      createdAt: createdAt,
      updatedAt: createdAt,
      status: derivedBatchStatus(rawTasks),
      screenCount: screenCount,
      maxReferenceImagesPerCall: 6,
      tasks: rawTasks
    };
    var batch = sanitizeBatchProject(raw, options);
    assertBatchAgainstBlueprint(batch, blueprint, options);
    return batch;
  }

  function assertBatchAgainstBlueprint(batchInput, blueprintInput, options) {
    options = isPlainObject(options) ? options : {};
    var blueprint = sanitizeBlueprint(blueprintInput, options);
    var batch = sanitizeBatchProject(batchInput, options);
    if (blueprint.approvalStatus !== 'approved') fail('BLUEPRINT_NOT_APPROVED', '批次只能关联可信 approved 蓝图。', '$blueprint.approvalStatus');
    if (batch.blueprintId !== blueprint.blueprintId || batch.blueprintRevision !== blueprint.revision ||
        batch.sourceSnapshotId !== blueprint.sourceSnapshotId) {
      fail('LINKAGE_MISMATCH', '批次与蓝图 ID、revision 或来源快照不匹配。', '$.blueprintId');
    }
    var sourceSnapshot = ownValue(options, 'sourceSnapshot');
    if (!sourceSnapshot) fail('SOURCE_SNAPSHOT_REQUIRED', '可信批次校验必须提供来源快照。', '$options.sourceSnapshot');
    assertBlueprintAgainstSource(blueprint, sourceSnapshot, options);
    var context = createContext(options);
    var assetRegistry = verifiedTargetAssetRegistry(options, context);
    var factRegistry = verifiedFactCardRegistry(options, context);
    batch.tasks.forEach(function (task, index) {
      if (blueprint.approval.productFactCardIds.indexOf(task.productFactCardId) < 0 || !factRegistry[task.productFactCardId]) {
        fail('UNVERIFIED_FACT_CARD', '批次任务事实卡不在可信审批范围。', '$.tasks[' + index + '].productFactCardId');
      }
      task.subjectAssetIds.forEach(function (assetId, assetIndex) {
        var verified = assetRegistry[assetId];
        if (!verified || (verified.rightsStatus !== 'authorized' && verified.rightsStatus !== 'self_owned')) {
          fail('UNVERIFIED_TARGET_ASSET', '批次主体素材未通过可信 registry 复核。', '$.tasks[' + index + '].subjectAssetIds[' + assetIndex + ']');
        }
      });
    });
    return { batch: batch, blueprint: blueprint };
  }

  function validateBatchAgainstBlueprint(batchInput, blueprintInput, options) {
    try {
      var checked = assertBatchAgainstBlueprint(batchInput, blueprintInput, options);
      return deepFreeze({ ok: true, value: checked.batch, errors: [], warnings: checked.batch.warnings || [] });
    } catch (error) {
      return deepFreeze({ ok: false, value: null, errors: [{ code: error.code || 'CONTRACT_ERROR', message: String(error.message || error), path: error.path || '$', severity: 'error' }], warnings: [] });
    }
  }

  function updateBatchProject(batchInput, changes, blueprintInput, options) {
    changes = isPlainObject(changes) ? changes : {};
    options = isPlainObject(options) ? options : {};
    var checked = assertBatchAgainstBlueprint(batchInput, blueprintInput, options);
    var raw = cloneJson(checked.batch);
    ['batchId', 'batchKey', 'blueprintId', 'blueprintRevision', 'sourceSnapshotId', 'screenCount', 'tasks', 'status'].forEach(function (key) {
      if (ownDescriptor(changes, key)) fail('IMMUTABLE_BATCH_FIELD', '批次身份或汇总字段不能直接修改。', '$changes.' + key);
    });
    var updates = arrayValue(ownValue(changes, 'taskUpdates'), '$changes.taskUpdates', normalizedLimits(options).maxBatchTasks, false);
    var byId = Object.create(null);
    raw.tasks.forEach(function (task) { byId[task.taskId] = task; });
    var seen = Object.create(null);
    updates.forEach(function (update, index) {
      var path = '$changes.taskUpdates[' + index + ']';
      if (!isPlainObject(update)) fail('INVALID_TASK_UPDATE', 'taskUpdate 必须是普通对象。', path);
      ['taskKey', 'productFactCardId', 'subjectAssetIds', 'skuIds'].forEach(function (key) {
        if (ownDescriptor(update, key)) fail('IMMUTABLE_TASK_FIELD', '任务身份字段不能通过状态更新修改。', path + '.' + key);
      });
      var taskId = String(ownValue(update, 'taskId') || '');
      if (!byId[taskId] || seen[taskId]) fail('UNKNOWN_OR_DUPLICATE_TASK', 'taskId 不存在或重复。', path + '.taskId');
      seen[taskId] = true;
      ['status', 'errors', 'resultRefs'].forEach(function (key) {
        var descriptor = ownDescriptor(update, key);
        if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) byId[taskId][key] = descriptor.value;
      });
    });
    raw.status = derivedBatchStatus(raw.tasks);
    raw.updatedAt = ownValue(options, 'updatedAt') || checked.batch.updatedAt;
    var updated = sanitizeBatchProject(raw, options);
    assertBatchAgainstBlueprint(updated, checked.blueprint, options);
    return updated;
  }

  function validationResult(factory, input, options) {
    try {
      var value = factory(input, options);
      return deepFreeze({ ok: true, value: value, errors: [], warnings: value.warnings || [] });
    } catch (error) {
      return deepFreeze({
        ok: false,
        value: null,
        errors: [{ code: error.code || 'CONTRACT_ERROR', message: String(error.message || error), path: error.path || '$', severity: 'error' }],
        warnings: []
      });
    }
  }

  function validateSourceSnapshot(input, options) { return validationResult(sanitizeSourceSnapshot, input, options); }
  function validateBlueprint(input, options) { return validationResult(sanitizeBlueprint, input, options); }
  function validateBatchProject(input, options) { return validationResult(sanitizeBatchProject, input, options); }
  function validateVisualStructureBlueprint(input, options) { return validationResult(sanitizeVisualStructureBlueprint, input, options); }
  function validateVisualStructureBatchProject(input, options) { return validationResult(sanitizeVisualStructureBatchProject, input, options); }

  function validateBatchProjectAgainstBlueprint(batchInput, blueprintInput, options) {
    return validateBatchAgainstBlueprint(batchInput, blueprintInput, options);
  }

  function sanitize(input, expectedSchema, options) {
    if (isPlainObject(expectedSchema)) { options = expectedSchema; expectedSchema = ''; }
    var schema = expectedSchema || ownValue(input, 'schema');
    if (schema === SOURCE_SCHEMA) return sanitizeSourceSnapshot(input, options);
    if (schema === BLUEPRINT_SCHEMA) return sanitizeBlueprint(input, options);
    if (schema === BATCH_SCHEMA) return sanitizeBatchProject(input, options);
    if (schema === VISUAL_STRUCTURE_BLUEPRINT_SCHEMA) return sanitizeVisualStructureBlueprint(input, options);
    if (schema === VISUAL_STRUCTURE_BATCH_SCHEMA) return sanitizeVisualStructureBatchProject(input, options);
    fail('INVALID_SCHEMA', '无法识别参考成详合同 schema。', '$.schema');
  }

  function validate(input, expectedSchema, options) {
    try {
      var value = sanitize(input, expectedSchema, options);
      return deepFreeze({ ok: true, value: value, errors: [], warnings: value.warnings || [] });
    } catch (error) {
      return deepFreeze({ ok: false, value: null, errors: [{ code: error.code || 'CONTRACT_ERROR', message: String(error.message || error), path: error.path || '$', severity: 'error' }], warnings: [] });
    }
  }

  return deepFreeze({
    REFERENCE_DETAIL_SOURCE_V1: SOURCE_SCHEMA,
    REFERENCE_DETAIL_BLUEPRINT_V1: BLUEPRINT_SCHEMA,
    REFERENCE_DETAIL_BATCH_V1: BATCH_SCHEMA,
    REFERENCE_DETAIL_BLUEPRINT_V2: VISUAL_STRUCTURE_BLUEPRINT_SCHEMA,
    REFERENCE_DETAIL_BATCH_V2: VISUAL_STRUCTURE_BATCH_SCHEMA,
    VISUAL_STRUCTURE_ONLY: VISUAL_STRUCTURE_ONLY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    schemas: { source: SOURCE_SCHEMA, blueprint: BLUEPRINT_SCHEMA, batch: BATCH_SCHEMA },
    enums: {
      completeness: COMPLETENESS_STATUSES,
      sourceModes: SOURCE_MODES,
      salesRoles: SALES_ROLES,
      blockTypes: BLOCK_TYPES,
      assetRoles: ASSET_ROLES,
      rightsStatuses: RIGHTS_STATUSES,
      blueprintApprovalStatuses: BLUEPRINT_APPROVAL_STATUSES,
      moduleDerivationKinds: MODULE_DERIVATION_KINDS,
      batchStatuses: BATCH_STATUSES,
      taskStatuses: TASK_STATUSES
    },
    DEFAULT_LIMITS: DEFAULT_LIMITS,
    HARD_LIMITS: HARD_LIMITS,
    DEFAULT_URL_POLICY: DEFAULT_URL_POLICY,
    ContractError: ContractError,
    createUrlPolicy: createUrlPolicy,
    validateUrl: validateUrl,
    stableSerialize: stableSerialize,
    stableHash: stableHash,
    sanitize: sanitize,
    validate: validate,
    sanitizeSourceSnapshot: sanitizeSourceSnapshot,
    validateSourceSnapshot: validateSourceSnapshot,
    DETAIL_RANGE_PATH_PREFIX: DETAIL_RANGE_PATH_PREFIX,
    classifyDetailImageBlocks: classifyDetailImageBlocks,
    projectAnchoredDetailSource: projectDetailImageSource,
    projectDetailImageSource: projectDetailImageSource,
    createBlueprintFromSnapshot: createBlueprintFromSnapshot,
    sanitizeBlueprint: sanitizeBlueprint,
    validateBlueprint: validateBlueprint,
    reviseBlueprint: reviseBlueprint,
    approveBlueprint: approveBlueprint,
    validateBlueprintAgainstSource: validateBlueprintAgainstSource,
    validateBlueprintAgainstSnapshot: validateBlueprintAgainstSnapshot,
    createRevisionEnvelope: createRevisionEnvelope,
    advanceRevisionEnvelope: advanceRevisionEnvelope,
    projectVisualStructureBlueprint: projectVisualStructureBlueprint,
    sanitizeVisualStructureBlueprint: sanitizeVisualStructureBlueprint,
    validateVisualStructureBlueprint: validateVisualStructureBlueprint,
    validateVisualStructureBlueprintAgainstSource: validateVisualStructureBlueprintAgainstSource,
    approveVisualStructureBlueprint: approveVisualStructureBlueprint,
    createVisualStructureRevisionEnvelope: createVisualStructureRevisionEnvelope,
    advanceVisualStructureRevisionEnvelope: advanceVisualStructureRevisionEnvelope,
    createBatchProject: createBatchProject,
    sanitizeBatchProject: sanitizeBatchProject,
    validateBatchProject: validateBatchProject,
    validateBatchAgainstBlueprint: validateBatchAgainstBlueprint,
    validateBatchProjectAgainstBlueprint: validateBatchProjectAgainstBlueprint,
    updateBatchProject: updateBatchProject,
    createVisualStructureBatchProject: createVisualStructureBatchProject,
    sanitizeVisualStructureBatchProject: sanitizeVisualStructureBatchProject,
    validateVisualStructureBatchProject: validateVisualStructureBatchProject,
    validateVisualStructureBatchAgainstBlueprint: validateVisualStructureBatchAgainstBlueprint,
    updateVisualStructureBatchProject: updateVisualStructureBatchProject
  });
});
