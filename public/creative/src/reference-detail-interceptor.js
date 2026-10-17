/* reference-detail-interceptor.js — 用户显式触发后短时观察公开详情响应（MAIN world） */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SZ_REFERENCE_DETAIL_INTERCEPTOR = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CONSTANTS = Object.freeze({
    ARM_EVENT: 'SZ_REFERENCE_DETAIL_MAIN_ARM_V1',
    DISARM_EVENT: 'SZ_REFERENCE_DETAIL_MAIN_DISARM_V1',
    MESSAGE_SOURCE: 'SZ_REFERENCE_DETAIL_MAIN',
    MESSAGE_TYPE: 'SZ_REFERENCE_DETAIL_MAIN_CANDIDATE_V1',
    MAX_RESPONSE_BYTES: 4 * 1024 * 1024,
    MAX_CANDIDATE_BYTES: 2 * 1024 * 1024,
    MAX_DEPTH: 16,
    MAX_NODES: 50000,
    MAX_ARRAY_LENGTH: 5000,
    MAX_OBJECT_KEYS: 1500,
    MAX_STRING_LENGTH: 120000,
    ACTIVE_TTL_MS: 90000,
    MAX_CANDIDATES: 120
  });

  var PAGE_RULES = Object.freeze([
    { platform: 'taobao', host: 'item.taobao.com', paths: ['/item.htm'] },
    { platform: 'tmall', host: 'detail.tmall.com', paths: ['/item.htm'] },
    { platform: 'tmall', host: 'chaoshi.detail.tmall.com', paths: ['/item.htm'] },
    { platform: 'tmall', host: 'detail.tmall.hk', paths: ['/item.htm', '/hk/item.htm'] }
  ]);
  var RESPONSE_HOSTS = Object.freeze({
    'h5api.m.taobao.com': true,
    'acs.m.taobao.com': true,
    'api.m.taobao.com': true,
    'item.taobao.com': true,
    'detail.tmall.com': true,
    'chaoshi.detail.tmall.com': true,
    'detail.tmall.hk': true
  });
  var RESPONSE_PATHS = Object.freeze([
    /^\/h5\/mtop\.taobao\.pcdetail\.data\.get\/\d+(?:\.\d+)*\/?$/i,
    /^\/h5\/mtop\.taobao\.detail\.getdetail\/\d+(?:\.\d+)*\/?$/i,
    /^\/h5\/mtop\.tmall\.detail\.getdetail\/\d+(?:\.\d+)*\/?$/i,
    /^\/h5\/mtop\.taobao\.detail\.(?:getdesc|desc\.get)\/\d+(?:\.\d+)*\/?$/i,
    /^\/h5\/mtop\.alibaba\.detail\.subpage\.get\/\d+(?:\.\d+)*\/?$/i,
    /^\/(?:item|detail)\/(?:desc|description|module|modules|content)\/?$/i
  ]);
  var DETAIL_KEYS = /^(?:detail|detailinfo|desc|descinfo|description|content|module|modules|moduledata|components|images?|pics?|videos?|props?|properties|parameters?|attributes?|apistack|sku|skubase|skucore)$/i;
  var DETAIL_KEY_HINT = /(?:detail|desc|module|component|image|pic|video|prop|param|attribute|content|sku)/i;
  var PUBLIC_GLOBALS = Object.freeze([
    '__INITIAL_STATE__', '__NEXT_DATA__', '__NUXT__', '__APOLLO_STATE__',
    '__PRELOADED_STATE__', '__INIT_DATA__', '__GLOBAL_DATA__'
  ]);
  var DANGEROUS_KEYS = Object.freeze({ '__proto__': true, prototype: true, constructor: true });
  var SENSITIVE_KEYS = Object.freeze({
    cookie: true, cookies: true, setcookie: true, token: true, accesstoken: true,
    refreshtoken: true, authorization: true, proxyauthorization: true, apikey: true,
    secret: true, password: true, credential: true, credentials: true, headers: true,
    requestheaders: true, responseheaders: true, sessionid: true, sign: true,
    signature: true
  });

  function ownDataValue(object, key) {
    if (!object || (typeof object !== 'object' && typeof object !== 'function')) return undefined;
    try {
      var descriptor = Object.getOwnPropertyDescriptor(object, key);
      return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
    } catch (_) {
      return undefined;
    }
  }

  function normalizedKey(key) {
    return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function isSensitiveKey(key) {
    return !!SENSITIVE_KEYS[normalizedKey(key)];
  }

  function hasExplicitPort(raw) {
    var match = String(raw || '').match(/^https:\/\/([^/?#]+)/i);
    if (!match) return false;
    return /:\d+$/.test(match[1].replace(/^.*@/, ''));
  }

  function parseSourcePage(value) {
    var raw = typeof value === 'string' ? value.trim() : '';
    if (!raw || raw.length > 4096 || !/^https:\/\//i.test(raw) || hasExplicitPort(raw)) return null;
    var parsed;
    try { parsed = new URL(raw); } catch (_) { return null; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null;
    var host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    var rule = PAGE_RULES.find(function (candidate) {
      return candidate.host === host && candidate.paths.indexOf(parsed.pathname) >= 0;
    });
    if (!rule) return null;
    var ids = parsed.searchParams.getAll('id');
    if (ids.length !== 1 || !/^\d{1,30}$/.test(ids[0])) return null;
    return Object.freeze({
      platform: rule.platform,
      itemId: ids[0],
      canonicalUrl: 'https://' + host + parsed.pathname + '?id=' + encodeURIComponent(ids[0]),
      origin: parsed.origin
    });
  }

  function parseResponseEndpoint(value) {
    var raw = typeof value === 'string' ? value.trim() : '';
    if (!raw || raw.length > 8192 || hasExplicitPort(raw)) return null;
    var parsed;
    try { parsed = new URL(raw); } catch (_) { return null; }
    var host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !RESPONSE_HOSTS[host]) return null;
    if (!RESPONSE_PATHS.some(function (pattern) { return pattern.test(parsed.pathname); })) return null;
    return Object.freeze({ host: host, endpointPath: parsed.pathname });
  }

  function allowedContentType(value) {
    var type = String(value || '').split(';')[0].trim().toLowerCase();
    return type === 'application/json' || type === 'text/json' || type === 'application/javascript' ||
      type === 'text/javascript' || type === 'application/x-javascript';
  }

  function clonePlainJson(value, options) {
    options = options || {};
    var limits = {
      maxBytes: Number(options.maxBytes) || CONSTANTS.MAX_CANDIDATE_BYTES,
      maxDepth: Number(options.maxDepth) || CONSTANTS.MAX_DEPTH,
      maxNodes: Number(options.maxNodes) || CONSTANTS.MAX_NODES,
      maxArrayLength: Number(options.maxArrayLength) || CONSTANTS.MAX_ARRAY_LENGTH,
      maxObjectKeys: Number(options.maxObjectKeys) || CONSTANTS.MAX_OBJECT_KEYS,
      maxStringLength: Number(options.maxStringLength) || CONSTANTS.MAX_STRING_LENGTH
    };
    var nodes = 0;
    var bytes = 0;
    var seen = typeof WeakSet === 'function' ? new WeakSet() : null;
    var droppedSensitive = 0;
    var droppedDangerous = 0;

    function addBytes(text) {
      bytes += String(text).length * 2;
      if (bytes > limits.maxBytes) throw new Error('candidate_too_large');
    }

    function visit(input, depth, path) {
      nodes += 1;
      if (nodes > limits.maxNodes) throw new Error('candidate_too_many_nodes');
      if (depth > limits.maxDepth) throw new Error('candidate_too_deep');
      if (input == null || typeof input === 'boolean') return input;
      if (typeof input === 'number') {
        if (!Number.isFinite(input)) throw new Error('candidate_non_json_number');
        return input;
      }
      if (typeof input === 'string') {
        if (input.length > limits.maxStringLength) throw new Error('candidate_string_too_large');
        addBytes(input);
        return input;
      }
      if (typeof input !== 'object') throw new Error('candidate_non_json_value');
      if (seen) {
        if (seen.has(input)) throw new Error('candidate_cycle_or_shared_reference');
        seen.add(input);
      }
      if (Array.isArray(input)) {
        if (input.length > limits.maxArrayLength) throw new Error('candidate_array_too_large');
        var array = [];
        for (var index = 0; index < input.length; index++) {
          var descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error('candidate_sparse_or_accessor_array');
          array.push(visit(descriptor.value, depth + 1, path + '[' + index + ']'));
        }
        return array;
      }
      var proto;
      try { proto = Object.getPrototypeOf(input); } catch (_) { throw new Error('candidate_non_plain_object'); }
      if (proto !== Object.prototype && proto !== null) throw new Error('candidate_non_plain_object');
      var keys = Object.keys(input);
      if (keys.length > limits.maxObjectKeys) throw new Error('candidate_object_too_large');
      var output = {};
      for (var keyIndex = 0; keyIndex < keys.length; keyIndex++) {
        var key = keys[keyIndex];
        if (DANGEROUS_KEYS[key]) { droppedDangerous += 1; continue; }
        if (isSensitiveKey(key)) { droppedSensitive += 1; continue; }
        var own = Object.getOwnPropertyDescriptor(input, key);
        if (!own || !Object.prototype.hasOwnProperty.call(own, 'value')) throw new Error('candidate_accessor');
        addBytes(key);
        output[key] = visit(own.value, depth + 1, path + '.' + key);
      }
      return output;
    }

    try {
      return { ok: true, json: visit(value, 0, '$'), bytes: bytes, nodes: nodes, droppedSensitive: droppedSensitive, droppedDangerous: droppedDangerous };
    } catch (error) {
      return { ok: false, error: String(error && error.message || error), bytes: bytes, nodes: nodes };
    }
  }

  function hasPublicDetailStructure(value) {
    var nodes = 0;
    var sawDetailKey = false;
    var sawPublicLeaf = false;
    var stack = [{ value: value, depth: 0, detailContext: false }];
    while (stack.length) {
      var current = stack.pop();
      nodes += 1;
      if (nodes > 30000 || current.depth > 14) return false;
      var item = current.value;
      if (item == null) continue;
      if (typeof item === 'string') {
        if (current.detailContext && (item.length >= 2 || /^https?:\/\//i.test(item) || /^\/\//.test(item))) sawPublicLeaf = true;
        continue;
      }
      if (typeof item === 'number' || typeof item === 'boolean') {
        if (current.detailContext) sawPublicLeaf = true;
        continue;
      }
      if (typeof item !== 'object') continue;
      if (Array.isArray(item)) {
        for (var index = item.length - 1; index >= 0; index--) stack.push({ value: item[index], depth: current.depth + 1, detailContext: current.detailContext });
        continue;
      }
      var keys = Object.keys(item);
      for (var keyIndex = keys.length - 1; keyIndex >= 0; keyIndex--) {
        var key = keys[keyIndex];
        var isDetail = DETAIL_KEYS.test(key) || DETAIL_KEY_HINT.test(key);
        if (isDetail) sawDetailKey = true;
        stack.push({ value: item[key], depth: current.depth + 1, detailContext: current.detailContext || isDetail });
      }
      if (sawDetailKey && sawPublicLeaf) return true;
    }
    return sawDetailKey && sawPublicLeaf;
  }

  function stableSerialize(value) {
    if (value == null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']';
    return '{' + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ':' + stableSerialize(value[key]);
    }).join(',') + '}';
  }

  function candidateIdForJson(value) {
    var raw = stableSerialize(value);
    var first = 0x811c9dc5;
    var second = 0x9e3779b9;
    for (var index = 0; index < raw.length; index++) {
      var code = raw.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193) >>> 0;
      second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
    }
    return 'rdc_' + first.toString(16).padStart(8, '0') + second.toString(16).padStart(8, '0');
  }

  function parseJsonText(text) {
    var raw = String(text || '').trim();
    if (!raw || raw.length * 2 > CONSTANTS.MAX_RESPONSE_BYTES) return null;
    try { return JSON.parse(raw); } catch (_) {}
    var match = raw.match(/^[A-Za-z_$][\w$\.]*\s*\(([^]*)\)\s*;?$/);
    if (!match) return null;
    try { return JSON.parse(match[1]); } catch (_) { return null; }
  }

  function prepareCandidate(value) {
    var cloned = clonePlainJson(value);
    if (!cloned.ok) return { ok: false, reason: cloned.error };
    if (!hasPublicDetailStructure(cloned.json)) return { ok: false, reason: 'not_public_detail_structure' };
    return {
      ok: true,
      json: cloned.json,
      candidateId: candidateIdForJson(cloned.json),
      bytes: cloned.bytes,
      droppedSensitive: cloned.droppedSensitive,
      droppedDangerous: cloned.droppedDangerous
    };
  }

  function requestUrl(input, baseUrl) {
    try {
      if (typeof input === 'string') return new URL(input, baseUrl).href;
      if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
      if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
    } catch (_) {}
    return '';
  }

  async function readBoundedResponse(response, maxBytes) {
    if (!response) return { ok: false, reason: 'missing_response' };
    var contentType = '';
    var contentLength = '';
    try {
      contentType = response.headers && response.headers.get ? response.headers.get('content-type') || '' : '';
      contentLength = response.headers && response.headers.get ? response.headers.get('content-length') || '' : '';
    } catch (_) {}
    if (!allowedContentType(contentType)) return { ok: false, reason: 'content_type_not_allowed' };
    var hasDeclaredLength = /^\d+$/.test(String(contentLength || '').trim());
    var declared = hasDeclaredLength ? Number(contentLength) : NaN;
    if (hasDeclaredLength && Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: 'declared_size_exceeded' };
    if (!response.body || !response.body.getReader || typeof TextDecoder === 'undefined') {
      if (!hasDeclaredLength || !Number.isFinite(declared) || declared < 0) return { ok: false, reason: 'unbounded_response' };
      try {
        var fallback = await response.text();
        if (fallback.length * 2 > maxBytes) return { ok: false, reason: 'actual_size_exceeded' };
        return { ok: true, text: fallback };
      } catch (_) { return { ok: false, reason: 'response_read_failed' }; }
    }
    var reader;
    try { reader = response.body.getReader(); } catch (_) { return { ok: false, reason: 'response_read_failed' }; }
    var decoder = new TextDecoder('utf-8', { fatal: false });
    var total = 0;
    var text = '';
    try {
      while (true) {
        var result = await reader.read();
        if (result.done) break;
        total += result.value ? result.value.byteLength : 0;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch (_) {}
          return { ok: false, reason: 'actual_size_exceeded' };
        }
        text += decoder.decode(result.value, { stream: true });
      }
      text += decoder.decode();
      return { ok: true, text: text };
    } catch (_) {
      return { ok: false, reason: 'response_read_failed' };
    }
  }

  async function runMainCaptureTask(request) {
    'use strict';

    /* This function is intentionally self-contained: Chrome serializes `func` into MAIN world. */
    var win = typeof window === 'object' && window ? window : null;
    var documentRef = win && win.document ? win.document : null;
    var result = { pageUrl: '', itemId: '', candidates: [], truncated: false, warnings: [] };
    var warningKeys = Object.create(null);
    var MAX_WARNINGS = 40;

    function warn(code, message) {
      code = String(code || 'CAPTURE_WARNING').replace(/[^A-Z0-9_]/g, '').slice(0, 80) || 'CAPTURE_WARNING';
      message = String(message || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240);
      var key = code + '\u0000' + message;
      if (warningKeys[key]) return;
      warningKeys[key] = true;
      if (result.warnings.length >= MAX_WARNINGS) {
        result.truncated = true;
        return;
      }
      result.warnings.push({ code: code, message: message });
    }

    function descriptor(object, key) {
      if (!object || (typeof object !== 'object' && typeof object !== 'function')) return null;
      try {
        if (!Object.prototype.hasOwnProperty.call(object, key)) return null;
        return Object.getOwnPropertyDescriptor(object, key) || null;
      } catch (_) { return null; }
    }

    function ownData(object, key) {
      var item = descriptor(object, key);
      return item && Object.prototype.hasOwnProperty.call(item, 'value') ? item.value : undefined;
    }

    function plainObject(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      try {
        var proto = Object.getPrototypeOf(value);
        return proto === Object.prototype || proto === null;
      } catch (_) { return false; }
    }

    function boundedInteger(value, fallback, minimum, maximum) {
      var number;
      try { number = Number(value); } catch (_) { return fallback; }
      if (!Number.isSafeInteger(number) || number < minimum) return fallback;
      return Math.min(number, maximum);
    }

    function normalizedKey(value) {
      return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    function dangerousKey(value) {
      value = String(value || '');
      return value === '__proto__' || value === 'prototype' || value === 'constructor';
    }

    function sensitiveKey(value) {
      var key = normalizedKey(value);
      if (!key) return false;
      if (/^(?:cookie|cookies|setcookie|authorization|proxyauthorization|auth|authentication|authkey|bearer|bearerkey|token|accesstoken|refreshtoken|idtoken|apikey|appkey|accesskey|privatekey|securitykey|password|passwd|secret|secretkey|appsecret|clientsecret|credential|credentials|session|sessionid|sessiontoken|sid|sign|signature|x5sec|x5token|mh5tk|mh5tkenc|csrftoken|xcsrftoken|xsrftoken|header|headers|requestheaders|responseheaders)$/.test(key)) return true;
      return /(?:cookie|token|authorization|authkey|bearerkey|accesskey|secretkey|privatekey|securitykey|header|headers)$/.test(key);
    }

    function sensitiveString(value) {
      value = String(value || '');
      return /\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s,;"'<>]{6,}/i.test(value) ||
        /\bbearer\s+[A-Za-z0-9._~+\/-]{6,}/i.test(value) ||
        /(?:^|[?&\s,;{])(?:cookie|set-cookie|access[_-]?token|refresh[_-]?token|auth(?:entication)?[_-]?token|id[_-]?token|x5sec|x5token|_?m_h5_tk(?:_enc)?|csrf(?:token)?|xsrf(?:token)?|session(?:id|token)?|api[_-]?key|client[_-]?secret|credential|password|signature)\s*[:=]\s*["']?[^\s,"';}\]&#]{6,}/i.test(value);
    }

    function explicitPort(raw) {
      var match = String(raw || '').match(/^https:\/\/([^/?#]+)/i);
      if (!match) return false;
      return /:\d+$/.test(match[1].replace(/^.*@/, ''));
    }

    var pageRules = [
      { platform: 'taobao', host: 'item.taobao.com', paths: ['/item.htm'] },
      { platform: 'tmall', host: 'detail.tmall.com', paths: ['/item.htm'] },
      { platform: 'tmall', host: 'chaoshi.detail.tmall.com', paths: ['/item.htm'] },
      { platform: 'tmall', host: 'detail.tmall.hk', paths: ['/item.htm', '/hk/item.htm'] }
    ];
    var responseHosts = Object.create(null);
    [
      'h5api.m.taobao.com', 'acs.m.taobao.com', 'item.taobao.com', 'detail.taobao.com',
      'mdskip.taobao.com', 'detail.tmall.com', 'chaoshi.detail.tmall.com', 'detail.tmall.hk',
      'mdskip.tmall.com', 'aldcdn.tmall.com'
    ].forEach(function (host) { responseHosts[host] = true; });
    var responsePaths = [
      /^\/h5\/mtop\.taobao\.pcdetail\.data\.get\/\d+(?:\.\d+)*\/?$/i,
      /^\/h5\/mtop\.taobao\.detail\.getdetail\/\d+(?:\.\d+)*\/?$/i,
      /^\/h5\/mtop\.tmall\.detail\.getdetail\/\d+(?:\.\d+)*\/?$/i,
      /^\/h5\/mtop\.taobao\.detail\.(?:getdesc|desc\.get)\/\d+(?:\.\d+)*\/?$/i,
      /^\/h5\/mtop\.alibaba\.detail\.subpage\.get\/\d+(?:\.\d+)*\/?$/i,
      /^\/(?:item|detail)\/(?:desc|description|module|modules|content)\/?$/i
    ];
    var publicGlobals = [
      '__INITIAL_STATE__', '__NEXT_DATA__', '__NUXT__', '__APOLLO_STATE__',
      '__PRELOADED_STATE__', '__INIT_DATA__', '__GLOBAL_DATA__'
    ];
    var detailKey = /^(?:detail|detailinfo|desc|descinfo|description|content|module|modules|moduledata|components|images?|pics?|videos?|props?|properties|parameters?|attributes?|apistack|sku|skubase|skucore)$/i;
    var detailHint = /(?:detail|desc|module|component|image|pic|video|prop|param|attribute|content|sku)/i;

    function parsePage(value) {
      var raw = typeof value === 'string' ? value.trim() : '';
      if (!raw || raw.length > 4096 || !/^https:\/\//i.test(raw) || explicitPort(raw)) return null;
      var parsed;
      try { parsed = new URL(raw); } catch (_) { return null; }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null;
      var host = parsed.hostname.toLowerCase().replace(/\.$/, '');
      var rule = null;
      for (var index = 0; index < pageRules.length; index++) {
        if (pageRules[index].host === host && pageRules[index].paths.indexOf(parsed.pathname) >= 0) {
          rule = pageRules[index];
          break;
        }
      }
      if (!rule) return null;
      var ids = parsed.searchParams.getAll('id');
      if (ids.length !== 1 || !/^\d{1,30}$/.test(ids[0])) return null;
      return {
        platform: rule.platform,
        itemId: ids[0],
        canonicalUrl: 'https://' + host + parsed.pathname + '?id=' + encodeURIComponent(ids[0]),
        origin: parsed.origin,
        host: host
      };
    }

    function collectItemIds(value, includeRootId) {
      var output = [];
      var seenIds = Object.create(null);
      var stack = [{ value: value, depth: 0, context: '' }];
      var visited = 0;
      function add(candidate) {
        if ((typeof candidate === 'string' || typeof candidate === 'number') && /^\d{1,30}$/.test(String(candidate))) {
          var id = String(candidate);
          if (!seenIds[id] && output.length < 64) { seenIds[id] = true; output.push(id); }
        }
      }
      while (stack.length && visited < 5000 && output.length < 64) {
        var current = stack.pop();
        visited += 1;
        if (!current || current.depth > 10) continue;
        var input = current.value;
        if (!input || typeof input !== 'object') continue;
        if (Array.isArray(input)) {
          for (var arrayIndex = Math.min(input.length, 1000) - 1; arrayIndex >= 0; arrayIndex--) {
            var entry = descriptor(input, String(arrayIndex));
            if (entry && Object.prototype.hasOwnProperty.call(entry, 'value')) {
              stack.push({ value: entry.value, depth: current.depth + 1, context: current.context });
            }
          }
          continue;
        }
        if (!plainObject(input)) continue;
        var keys;
        try { keys = Object.keys(input).slice(0, 1000); } catch (_) { continue; }
        var hasDetailSibling = false;
        for (var hintIndex = 0; hintIndex < keys.length; hintIndex++) {
          if (detailKey.test(keys[hintIndex]) || detailHint.test(keys[hintIndex])) { hasDetailSibling = true; break; }
        }
        for (var keyIndex = keys.length - 1; keyIndex >= 0; keyIndex--) {
          var key = keys[keyIndex];
          var own = descriptor(input, key);
          if (!own || !Object.prototype.hasOwnProperty.call(own, 'value')) continue;
          var normalized = normalizedKey(key);
          var isSpecific = /^(?:itemid|itemnumid|itemidstr|auctionid|auctionnumid|auctionitemid)$/.test(normalized);
          var isBoundGeneric = normalized === 'id' && ((includeRootId && current.depth === 0) ||
            /^(?:item|iteminfo|auction|auctioninfo)$/.test(current.context) ||
            (hasDetailSibling && (current.depth <= 1 || current.context === 'data')));
          if (isSpecific || isBoundGeneric) add(own.value);
          if (own.value && typeof own.value === 'object') {
            stack.push({ value: own.value, depth: current.depth + 1, context: normalized });
          }
        }
      }
      return output;
    }

    function endpointItemIds(parsed) {
      var output = [];
      var seenIds = Object.create(null);
      function add(candidate) {
        if (/^\d{1,30}$/.test(String(candidate || ''))) {
          var id = String(candidate);
          if (!seenIds[id] && output.length < 64) { seenIds[id] = true; output.push(id); }
        }
      }
      try {
        parsed.searchParams.forEach(function (value, key) {
          var normalized = normalizedKey(key);
          if (/^(?:id|itemid|itemnumid|itemidstr|auctionid|auctionnumid|auctionitemid)$/.test(normalized)) add(value);
          if ((normalized === 'data' || normalized === 'params') && value.length <= 8192) {
            var decoded;
            try { decoded = JSON.parse(value); } catch (_) { decoded = null; }
            collectItemIds(decoded, true).forEach(add);
          }
        });
      } catch (_) {}
      return output;
    }

    function parseEndpoint(value) {
      var raw = typeof value === 'string' ? value.trim() : '';
      if (!raw || raw.length > 8192 || !/^https:\/\//i.test(raw) || explicitPort(raw)) return null;
      var parsed;
      try { parsed = new URL(raw); } catch (_) { return null; }
      var host = parsed.hostname.toLowerCase().replace(/\.$/, '');
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
          !Object.prototype.hasOwnProperty.call(responseHosts, host)) return null;
      var pathAllowed = false;
      for (var index = 0; index < responsePaths.length; index++) {
        if (responsePaths[index].test(parsed.pathname)) { pathAllowed = true; break; }
      }
      return pathAllowed ? { host: host, endpointPath: parsed.pathname, itemIds: endpointItemIds(parsed) } : null;
    }

    function requestUrl(input, baseUrl) {
      try {
        if (typeof input === 'string') return new URL(input, baseUrl).href;
        if (win.URL && input instanceof win.URL) return input.href;
        if (win.Request && input instanceof win.Request) return input.url;
        var rawUrl = ownData(input, 'url');
        if (typeof rawUrl === 'string') return new URL(rawUrl, baseUrl).href;
      } catch (_) {}
      return '';
    }

    function contentTypeAllowed(value) {
      var type = String(value || '').split(';')[0].trim().toLowerCase();
      return type === 'application/json' || type === 'text/json' || type === 'application/x-json' ||
        /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(type) ||
        type === 'application/javascript' || type === 'text/javascript' || type === 'application/x-javascript';
    }

    function itemIdState(ids, expected) {
      if (!Array.isArray(ids) || !ids.length) return 'unknown';
      return ids.indexOf(String(expected || '')) >= 0 ? 'match' : 'mismatch';
    }

    function utf8Bytes(value) {
      value = String(value == null ? '' : value);
      try {
        var Encoder = win.TextEncoder || (typeof TextEncoder === 'function' ? TextEncoder : null);
        if (Encoder) return new Encoder().encode(value).byteLength;
      } catch (_) {}
      var bytes = 0;
      for (var index = 0; index < value.length; index++) {
        var code = value.charCodeAt(index);
        if (code < 0x80) bytes += 1;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
            value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
          bytes += 4;
          index += 1;
        } else bytes += 3;
      }
      return bytes;
    }

    if (!win || !documentRef || !win.location) {
      warn('MAIN_RUNTIME_UNAVAILABLE', 'MAIN world 页面运行环境不可用。');
      return result;
    }
    var currentPage = parsePage(String(win.location.href || ''));
    if (!currentPage) {
      warn('UNSUPPORTED_PAGE', '当前页面不是受支持的淘宝/天猫商品详情页。');
      return result;
    }
    result.pageUrl = currentPage.canonicalUrl;
    result.itemId = currentPage.itemId;
    if (!plainObject(request)) {
      warn('INVALID_REQUEST', 'MAIN 私有采集请求必须是普通对象。');
      return result;
    }
    var requestedPageRaw = ownData(request, 'pageUrl');
    if (requestedPageRaw == null) requestedPageRaw = ownData(request, 'canonicalUrl');
    var requestedItemId = ownData(request, 'itemId');
    var requestedPage = parsePage(requestedPageRaw);
    if (!requestedPage || typeof requestedItemId !== 'string' || requestedPageRaw !== requestedPage.canonicalUrl ||
        requestedItemId !== requestedPage.itemId || requestedPage.canonicalUrl !== currentPage.canonicalUrl ||
        requestedPage.itemId !== currentPage.itemId) {
      warn('PAGE_IDENTITY_MISMATCH', '请求商品身份与当前规范商品页不一致，未开始观察。');
      return result;
    }

    var durationMs = boundedInteger(ownData(request, 'durationMs'), 3500, 0, 15000);
    var settleMs = boundedInteger(ownData(request, 'settleMs'), 150, 0, 500);
    var maxResponseBytes = boundedInteger(ownData(request, 'maxResponseBytes'), 4 * 1024 * 1024, 64, 4 * 1024 * 1024);
    var maxCandidateBytes = boundedInteger(ownData(request, 'maxCandidateBytes'), 2 * 1024 * 1024, 64, 2 * 1024 * 1024);
    maxCandidateBytes = Math.min(maxCandidateBytes, maxResponseBytes);
    var requestedResultBytes = boundedInteger(ownData(request, 'maxTotalBytes'), 8 * 1024 * 1024, 1024, 8 * 1024 * 1024);
    var envelopeReserve = Math.min(256 * 1024, Math.max(512, Math.floor(requestedResultBytes / 8)));
    var maxTotalBytes = Math.max(64, requestedResultBytes - envelopeReserve);
    var maxCandidates = boundedInteger(ownData(request, 'maxCandidates'), 120, 1, 120);
    var observeMutations = ownData(request, 'observeMutations') === true;
    var maxMutationScans = boundedInteger(ownData(request, 'maxMutationScans'), 4, 1, 12);
    var totalCandidateBytes = 0;
    var active = true;
    var identityWarningSent = false;
    var seenCandidates = Object.create(null);
    var pending = [];

    function identityMatches() {
      if (!active) return false;
      var live = parsePage(String(win.location && win.location.href || ''));
      var matches = !!live && live.canonicalUrl === currentPage.canonicalUrl && live.itemId === currentPage.itemId;
      if (!matches && !identityWarningSent) {
        identityWarningSent = true;
        result.truncated = true;
        warn('PAGE_IDENTITY_CHANGED', '观察期间商品页面身份发生变化，后续候选已停止接收。');
      }
      if (!matches) active = false;
      return matches;
    }

    function clonePlain(value) {
      var nodes = 0;
      var estimatedBytes = 0;
      var droppedSensitive = 0;
      var droppedDangerous = 0;
      var seen = typeof WeakSet === 'function' ? new WeakSet() : null;

      function spend(amount) {
        estimatedBytes += Number(amount) || 0;
        if (estimatedBytes > maxCandidateBytes) throw new Error('candidate_too_large');
      }

      function visit(input, depth) {
        nodes += 1;
        if (nodes > 50000) throw new Error('candidate_too_many_nodes');
        if (depth > 16) throw new Error('candidate_too_deep');
        if (input === null) { spend(4); return null; }
        var kind = typeof input;
        if (kind === 'boolean') { spend(input ? 4 : 5); return input; }
        if (kind === 'number') {
          if (!Number.isFinite(input)) throw new Error('candidate_non_json_number');
          spend(String(input).length);
          return input;
        }
        if (kind === 'string') {
          if (sensitiveString(input)) throw new Error('candidate_sensitive_value');
          var length = utf8Bytes(input);
          if (length > 256 * 1024) throw new Error('candidate_string_too_large');
          spend(length + 2);
          return input;
        }
        if (kind !== 'object') throw new Error('candidate_non_json_value');
        if (seen) {
          if (seen.has(input)) throw new Error('candidate_cycle_or_shared_reference');
          seen.add(input);
        }
        if (Array.isArray(input)) {
          if (input.length > 5000) throw new Error('candidate_array_too_large');
          var array = [];
          spend(2 + input.length);
          for (var index = 0; index < input.length; index++) {
            var entry = descriptor(input, String(index));
            if (!entry || !Object.prototype.hasOwnProperty.call(entry, 'value')) throw new Error('candidate_sparse_or_accessor_array');
            array.push(visit(entry.value, depth + 1));
          }
          return array;
        }
        if (!plainObject(input)) throw new Error('candidate_non_plain_object');
        var keys;
        try { keys = Object.keys(input).sort(); } catch (_) { throw new Error('candidate_unreadable_object'); }
        if (keys.length > 1500) throw new Error('candidate_object_too_large');
        var output = {};
        spend(2 + keys.length);
        for (var keyIndex = 0; keyIndex < keys.length; keyIndex++) {
          var key = keys[keyIndex];
          if (dangerousKey(key)) { droppedDangerous += 1; continue; }
          if (sensitiveKey(key)) { droppedSensitive += 1; continue; }
          var own = descriptor(input, key);
          if (!own || !Object.prototype.hasOwnProperty.call(own, 'value')) throw new Error('candidate_accessor');
          spend(utf8Bytes(key) + 3);
          output[key] = visit(own.value, depth + 1);
        }
        return output;
      }

      try {
        var json = visit(value, 0);
        var serialized = JSON.stringify(json);
        var exactBytes = utf8Bytes(serialized);
        if (exactBytes > maxCandidateBytes) throw new Error('candidate_too_large');
        return {
          ok: true, json: json, serialized: serialized, bytes: exactBytes,
          droppedSensitive: droppedSensitive, droppedDangerous: droppedDangerous
        };
      } catch (error) {
        return { ok: false, reason: String(error && error.message || error).slice(0, 80) };
      }
    }

    function publicDetailStructure(value) {
      var nodes = 0;
      var sawDetail = false;
      var sawLeaf = false;
      var stack = [{ value: value, depth: 0, detailContext: false }];
      while (stack.length) {
        var current = stack.pop();
        nodes += 1;
        if (nodes > 30000 || current.depth > 14) return false;
        var item = current.value;
        if (item == null) continue;
        if (typeof item === 'string') {
          if (current.detailContext && (item.length >= 2 || /^https?:\/\//i.test(item) || /^\/\//.test(item))) sawLeaf = true;
          continue;
        }
        if (typeof item === 'number' || typeof item === 'boolean') {
          if (current.detailContext) sawLeaf = true;
          continue;
        }
        if (typeof item !== 'object') continue;
        if (Array.isArray(item)) {
          for (var arrayIndex = item.length - 1; arrayIndex >= 0; arrayIndex--) {
            stack.push({ value: item[arrayIndex], depth: current.depth + 1, detailContext: current.detailContext });
          }
          continue;
        }
        var keys = Object.keys(item);
        for (var keyIndex = keys.length - 1; keyIndex >= 0; keyIndex--) {
          var key = keys[keyIndex];
          var isDetail = detailKey.test(key) || detailHint.test(key);
          if (isDetail) sawDetail = true;
          stack.push({ value: item[key], depth: current.depth + 1, detailContext: current.detailContext || isDetail });
        }
        if (sawDetail && sawLeaf) return true;
      }
      return sawDetail && sawLeaf;
    }

    function stableSerialize(value) {
      if (value == null || typeof value !== 'object') return JSON.stringify(value);
      if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']';
      return '{' + Object.keys(value).sort().map(function (key) {
        return JSON.stringify(key) + ':' + stableSerialize(value[key]);
      }).join(',') + '}';
    }

    function candidateId(value) {
      var raw = stableSerialize(value);
      var first = 0x811c9dc5;
      var second = 0x9e3779b9;
      for (var index = 0; index < raw.length; index++) {
        var code = raw.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193) >>> 0;
        second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
      }
      return 'rdc_' + first.toString(16).padStart(8, '0') + second.toString(16).padStart(8, '0');
    }

    function rejectionWarning(reason) {
      if (/sensitive/.test(reason)) {
        warn('CANDIDATE_SENSITIVE_VALUE', '公开详情候选含凭据形态文本，已整体忽略且不导出。');
      } else if (/too_large|too_many|array_too|object_too|string_too|too_deep/.test(reason)) {
        result.truncated = true;
        warn('CANDIDATE_LIMIT_REACHED', '公开详情候选超过有界限制，已忽略。');
      } else if (/accessor|non_plain|cycle|non_json|sparse|unreadable/.test(reason)) {
        warn('CANDIDATE_NOT_PLAIN_JSON', '公开详情候选不是 getter-safe 普通 JSON，已忽略。');
      }
    }

    function addCandidate(payload, endpoint, transport, status) {
      if (!identityMatches()) return;
      var cloned = clonePlain(payload);
      if (!cloned.ok) { rejectionWarning(cloned.reason); return; }
      if (!publicDetailStructure(cloned.json)) return;
      if (transport === 'fetch' || transport === 'xhr') {
        var endpointState = endpoint && endpoint.identityState || itemIdState(endpoint && endpoint.itemIds, currentPage.itemId);
        var payloadState = itemIdState(collectItemIds(cloned.json, false), currentPage.itemId);
        if (endpointState === 'mismatch' || (endpointState !== 'match' && payloadState === 'mismatch')) {
          warn('NETWORK_ITEM_ID_MISMATCH', '公开详情候选所属商品与当前页不一致，已忽略。');
          return;
        }
        if (endpointState !== 'match' && payloadState !== 'match') {
          result.truncated = true;
          warn('NETWORK_ITEM_ID_UNBOUND', '公开详情候选无法与当前商品 ID 严格绑定，已忽略。');
          return;
        }
      }
      var id = candidateId(cloned.json);
      if (seenCandidates[id]) return;
      if (result.candidates.length >= maxCandidates || totalCandidateBytes + cloned.bytes > maxTotalBytes) {
        result.truncated = true;
        warn('CANDIDATE_RESULT_LIMIT_REACHED', '候选数量或总载荷达到上限，后续候选已忽略。');
        return;
      }
      seenCandidates[id] = true;
      totalCandidateBytes += cloned.bytes;
      result.candidates.push({
        candidateId: id,
        endpointHost: String(endpoint && endpoint.host || '').toLowerCase().slice(0, 255),
        endpointPath: String(endpoint && endpoint.endpointPath || '').split(/[?#]/)[0].slice(0, 1000),
        transport: String(transport || 'unknown').slice(0, 40),
        payload: cloned.json,
        bytes: cloned.bytes,
        status: Number.isInteger(status) ? status : null,
        droppedSensitive: cloned.droppedSensitive,
        droppedDangerous: cloned.droppedDangerous
      });
    }

    function parseText(text) {
      var raw = typeof text === 'string' ? text.trim() : '';
      if (!raw || utf8Bytes(raw) > maxResponseBytes) return null;
      try { return JSON.parse(raw); } catch (_) {}
      var match = raw.match(/^[A-Za-z_$][\w$\.]*\s*\(([^]*)\)\s*;?$/);
      if (!match || utf8Bytes(match[1]) > maxResponseBytes) return null;
      try { return JSON.parse(match[1]); } catch (_) { return null; }
    }

    function headerValue(source, name) {
      try { return source && typeof source.get === 'function' ? String(source.get(name) || '') : ''; }
      catch (_) { return ''; }
    }

    function declaredLength(value) {
      var raw = String(value || '').trim();
      if (!raw) return { ok: true, present: false, value: null };
      if (!/^\d+$/.test(raw)) return { ok: false, present: true, value: null };
      var number = Number(raw);
      return { ok: Number.isSafeInteger(number) && number >= 0 && number <= maxResponseBytes, present: true, value: number };
    }

    async function readFetchResponse(response, issuedEndpoint) {
      if (!response || !identityMatches()) return { ok: false, reason: 'inactive' };
      var status;
      try { status = Number(response.status); } catch (_) { return { ok: false, reason: 'invalid_status' }; }
      if (!Number.isInteger(status) || status < 200 || status >= 300) return { ok: false, reason: 'invalid_status' };
      var issuedState = itemIdState(issuedEndpoint && issuedEndpoint.itemIds, currentPage.itemId);
      if (issuedState === 'mismatch') return { ok: false, reason: 'item_identity_mismatch' };
      var actualEndpoint = issuedEndpoint;
      try {
        if (typeof response.url === 'string' && response.url) actualEndpoint = parseEndpoint(response.url);
      } catch (_) { return { ok: false, reason: 'invalid_response_url' }; }
      if (!actualEndpoint) return { ok: false, reason: 'invalid_response_url' };
      var actualState = itemIdState(actualEndpoint.itemIds, currentPage.itemId);
      if (actualState === 'mismatch') return { ok: false, reason: 'item_identity_mismatch' };
      actualEndpoint = {
        host: actualEndpoint.host,
        endpointPath: actualEndpoint.endpointPath,
        itemIds: actualEndpoint.itemIds,
        identityState: actualState === 'match' || issuedState === 'match' ? 'match' : 'unknown'
      };
      var type = headerValue(response.headers, 'content-type');
      if (!contentTypeAllowed(type)) return { ok: false, reason: 'content_type_not_allowed' };
      var declared = declaredLength(headerValue(response.headers, 'content-length'));
      if (!declared.ok) return { ok: false, reason: 'declared_size_not_allowed' };
      var body = null;
      try { body = response.body; } catch (_) {}
      if (body && typeof body.getReader === 'function') {
        var Decoder = win.TextDecoder || (typeof TextDecoder === 'function' ? TextDecoder : null);
        if (!Decoder) return { ok: false, reason: 'decoder_unavailable' };
        var reader;
        try { reader = body.getReader(); } catch (_) { return { ok: false, reason: 'response_read_failed' }; }
        var readerRecord = { reader: reader, cancelled: false, done: false };
        activeReaders.push(readerRecord);
        var decoder = new Decoder('utf-8', { fatal: false });
        var total = 0;
        var chunks = 0;
        var text = '';
        try {
          while (true) {
            var part = await reader.read();
            if (!active || readerRecord.cancelled) return { ok: false, reason: 'inactive' };
            if (part.done) break;
            chunks += 1;
            var byteLength = part.value && Number(part.value.byteLength);
            if (!Number.isSafeInteger(byteLength) || byteLength < 0 || chunks > 4096) throw new Error('invalid_stream_chunk');
            total += byteLength;
            if (total > maxResponseBytes) {
              readerRecord.cancelled = true;
              try {
                var cancelled = reader.cancel();
                if (cancelled && typeof cancelled.catch === 'function') cancelled.catch(function () {});
              } catch (_) {}
              return { ok: false, reason: 'actual_size_exceeded' };
            }
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
          if (utf8Bytes(text) > maxResponseBytes) return { ok: false, reason: 'actual_size_exceeded' };
          return { ok: true, text: text, endpoint: actualEndpoint, status: status };
        } catch (_) {
          if (!readerRecord.cancelled) {
            readerRecord.cancelled = true;
            try {
              var failedCancel = reader.cancel();
              if (failedCancel && typeof failedCancel.catch === 'function') failedCancel.catch(function () {});
            } catch (__) {}
          }
          return { ok: false, reason: active ? 'response_read_failed' : 'inactive' };
        } finally {
          readerRecord.done = true;
          try { if (reader.releaseLock) reader.releaseLock(); } catch (_) {}
        }
      }
      if (!declared.present || typeof response.text !== 'function') return { ok: false, reason: 'unbounded_response' };
      try {
        var fallback = await response.text();
        if (utf8Bytes(fallback) > maxResponseBytes) return { ok: false, reason: 'actual_size_exceeded' };
        return { ok: true, text: fallback, endpoint: actualEndpoint, status: status };
      } catch (_) { return { ok: false, reason: 'response_read_failed' }; }
    }

    async function inspectFetch(response, endpoint) {
      var bounded = await readFetchResponse(response, endpoint);
      if (!bounded.ok) {
        if (/size|unbounded/.test(bounded.reason)) {
          result.truncated = true;
          warn('RESPONSE_SIZE_NOT_ALLOWED', '公开详情响应声明或实际体积未通过有界校验。');
        } else if (/identity/.test(bounded.reason)) {
          warn('NETWORK_ITEM_ID_MISMATCH', '公开详情响应所属商品与当前页不一致，已忽略。');
        }
        return;
      }
      var parsed = parseText(bounded.text);
      if (parsed != null) addCandidate(parsed, bounded.endpoint, 'fetch', bounded.status);
    }

    function xhrHeaders(xhr) {
      var type = '';
      var length = '';
      try {
        type = String(xhr.getResponseHeader('content-type') || '');
        length = String(xhr.getResponseHeader('content-length') || '');
      } catch (_) {}
      return { type: type, length: length };
    }

    async function inspectXhr(xhr, meta) {
      if (!identityMatches()) return;
      var status;
      try { status = Number(xhr.status); } catch (_) { return; }
      if (!Number.isInteger(status) || status < 200 || status >= 300) return;
      var issuedState = itemIdState(meta.endpoint && meta.endpoint.itemIds, currentPage.itemId);
      if (issuedState === 'mismatch') return;
      var actualEndpoint = meta.endpoint;
      try {
        if (typeof xhr.responseURL === 'string' && xhr.responseURL) actualEndpoint = parseEndpoint(xhr.responseURL);
      } catch (_) { return; }
      if (!actualEndpoint) return;
      var actualState = itemIdState(actualEndpoint.itemIds, currentPage.itemId);
      if (actualState === 'mismatch') {
        warn('NETWORK_ITEM_ID_MISMATCH', '公开详情响应所属商品与当前页不一致，已忽略。');
        return;
      }
      actualEndpoint = {
        host: actualEndpoint.host,
        endpointPath: actualEndpoint.endpointPath,
        itemIds: actualEndpoint.itemIds,
        identityState: actualState === 'match' || issuedState === 'match' ? 'match' : 'unknown'
      };
      var headers = xhrHeaders(xhr);
      if (!contentTypeAllowed(headers.type)) return;
      var declared = declaredLength(headers.length);
      if (!declared.ok) {
        result.truncated = true;
        warn('RESPONSE_SIZE_NOT_ALLOWED', '公开详情响应声明或实际体积未通过有界校验。');
        return;
      }
      var responseType = '';
      try { responseType = String(xhr.responseType || ''); } catch (_) { return; }
      var raw = null;
      if (responseType === 'json') {
        try { raw = xhr.response; } catch (_) { return; }
      } else if (!responseType || responseType === 'text') {
        var text = '';
        try { text = String(xhr.responseText || ''); } catch (_) { return; }
        if (utf8Bytes(text) > maxResponseBytes) {
          result.truncated = true;
          warn('RESPONSE_SIZE_NOT_ALLOWED', '公开详情响应声明或实际体积未通过有界校验。');
          return;
        }
        raw = parseText(text);
      }
      if (raw != null) addCandidate(raw, actualEndpoint, 'xhr', status);
    }

    function scanPublicData() {
      if (!identityMatches()) return;
      for (var globalIndex = 0; globalIndex < publicGlobals.length; globalIndex++) {
        var name = publicGlobals[globalIndex];
        var value = ownData(win, name);
        if (value !== undefined) {
          addCandidate(value, { host: currentPage.host, endpointPath: '/document/public-global/' + name }, 'public_global', null);
        }
      }
      var scripts = [];
      try { scripts = Array.prototype.slice.call(documentRef.querySelectorAll('script[type="application/json"],script#__NEXT_DATA__'), 0, 40); }
      catch (_) { scripts = []; }
      for (var scriptIndex = 0; scriptIndex < scripts.length; scriptIndex++) {
        var text = '';
        try { text = String(scripts[scriptIndex].textContent || ''); } catch (_) { text = ''; }
        if (!text) continue;
        if (utf8Bytes(text) > maxResponseBytes) {
          result.truncated = true;
          warn('SCRIPT_JSON_LIMIT_REACHED', '页面公开 JSON script 超过体积上限，已忽略。');
          continue;
        }
        var parsed = parseText(text);
        if (parsed != null) {
          addCandidate(parsed, { host: currentPage.host, endpointPath: '/document/script-json/' + scriptIndex }, 'script_json', null);
        }
      }
    }

    var originalFetch = typeof win.fetch === 'function' ? win.fetch : null;
    var wrappedFetch = null;
    var xhrProto = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
    var originalOpen = xhrProto && typeof xhrProto.open === 'function' ? xhrProto.open : null;
    var originalSend = xhrProto && typeof xhrProto.send === 'function' ? xhrProto.send : null;
    var wrappedOpen = null;
    var wrappedSend = null;
    var xhrMeta = typeof WeakMap === 'function' ? new WeakMap() : null;
    var xhrListeners = [];
    var observer = null;
    var mutationTimer = null;
    var mutationScans = 0;
    var setTimer = typeof win.setTimeout === 'function' ? win.setTimeout.bind(win) : setTimeout;
    var clearTimer = typeof win.clearTimeout === 'function' ? win.clearTimeout.bind(win) : clearTimeout;
    var layerKey = typeof Symbol === 'function' && typeof Symbol.for === 'function' ?
      Symbol.for('SZ_REFERENCE_DETAIL_PRIVATE_MAIN_LAYER_V1') : '__SZ_REFERENCE_DETAIL_PRIVATE_MAIN_LAYER_V1__';
    var fetchLayer = null;
    var xhrLayer = null;
    var activeReaders = [];
    var networkObservations = 0;
    var MAX_NETWORK_OBSERVATIONS = 240;

    function markLayer(wrapper, layer) {
      try {
        Object.defineProperty(wrapper, layerKey, { value: layer, enumerable: false, configurable: false, writable: false });
        return ownData(wrapper, layerKey) === layer;
      } catch (_) { return false; }
    }

    function previousLiveFunction(candidate, kind, previousField) {
      var target = candidate;
      for (var depth = 0; typeof target === 'function' && depth < 32; depth++) {
        var layer = ownData(target, layerKey);
        if (!layer || ownData(layer, 'kind') !== kind || ownData(layer, 'active') !== false) break;
        var previous = ownData(layer, previousField);
        if (typeof previous !== 'function' || previous === target) break;
        target = previous;
      }
      return target;
    }

    function reserveNetworkObservation() {
      if (networkObservations >= MAX_NETWORK_OBSERVATIONS) {
        result.truncated = true;
        warn('NETWORK_OBSERVATION_LIMIT_REACHED', '网络观察数量达到上限，后续响应已忽略。');
        return false;
      }
      networkObservations += 1;
      return true;
    }

    function track(task) {
      pending.push(Promise.resolve(task).catch(function () {}));
    }

    function patchNetwork() {
      if (originalFetch) {
        wrappedFetch = function () {
          var args = arguments;
          var endpoint = parseEndpoint(requestUrl(args[0], String(win.location && win.location.href || '')));
          var issuedPage = parsePage(String(win.location && win.location.href || ''));
          var promise = originalFetch.apply(this, args);
          if (active && endpoint && itemIdState(endpoint.itemIds, currentPage.itemId) !== 'mismatch' &&
              issuedPage && issuedPage.canonicalUrl === currentPage.canonicalUrl && reserveNetworkObservation()) {
            var task = Promise.resolve(promise).then(function (response) {
              if (!identityMatches()) return;
              var copy;
              try { copy = response && typeof response.clone === 'function' ? response.clone() : null; } catch (_) { copy = null; }
              if (!copy) return;
              return inspectFetch(copy, endpoint);
            });
            track(task);
          }
          return promise;
        };
        try {
          fetchLayer = { kind: 'fetch', active: true, previousFetch: originalFetch };
          if (!markLayer(wrappedFetch, fetchLayer)) throw new Error('fetch_layer_mark_rejected');
          win.fetch = wrappedFetch;
          if (win.fetch !== wrappedFetch) throw new Error('fetch_patch_rejected');
        } catch (_) {
          if (fetchLayer) fetchLayer.active = false;
          wrappedFetch = null;
          warn('FETCH_PATCH_UNAVAILABLE', '页面 fetch 无法短时观察，已继续使用其他公开来源。');
        }
      }
      if (xhrProto && originalOpen && originalSend && xhrMeta) {
        wrappedOpen = function (method, url) {
          xhrMeta.set(this, {
            endpoint: parseEndpoint(requestUrl(url, String(win.location && win.location.href || ''))),
            page: parsePage(String(win.location && win.location.href || ''))
          });
          return originalOpen.apply(this, arguments);
        };
        wrappedSend = function () {
          var xhr = this;
          var meta = xhrMeta.get(xhr);
          if (active && meta && meta.endpoint && itemIdState(meta.endpoint.itemIds, currentPage.itemId) !== 'mismatch' &&
              meta.page && meta.page.canonicalUrl === currentPage.canonicalUrl &&
              typeof xhr.addEventListener === 'function' && reserveNetworkObservation()) {
            var record = { xhr: xhr, listener: null, removed: false };
            var onLoad = function () {
              if (!record.removed) {
                record.removed = true;
                try { xhr.removeEventListener('loadend', onLoad); } catch (_) {}
              }
              track(inspectXhr(xhr, meta));
            };
            record.listener = onLoad;
            xhrListeners.push(record);
            try { xhr.addEventListener('loadend', onLoad); }
            catch (_) { record.removed = true; }
          }
          return originalSend.apply(this, arguments);
        };
        try {
          xhrLayer = { kind: 'xhr', active: true, previousOpen: originalOpen, previousSend: originalSend };
          if (!markLayer(wrappedOpen, xhrLayer) || !markLayer(wrappedSend, xhrLayer)) throw new Error('xhr_layer_mark_rejected');
          xhrProto.open = wrappedOpen;
          xhrProto.send = wrappedSend;
          if (xhrProto.open !== wrappedOpen || xhrProto.send !== wrappedSend) throw new Error('xhr_patch_rejected');
        } catch (_) {
          if (xhrLayer) xhrLayer.active = false;
          try { if (xhrProto.open === wrappedOpen) xhrProto.open = originalOpen; } catch (__) {}
          try { if (xhrProto.send === wrappedSend) xhrProto.send = originalSend; } catch (__) {}
          wrappedOpen = wrappedSend = null;
          warn('XHR_PATCH_UNAVAILABLE', '页面 XHR 无法短时观察，已继续使用其他公开来源。');
        }
      }
    }

    function startMutationObserver() {
      if (!observeMutations || typeof win.MutationObserver !== 'function' || !documentRef.documentElement) return;
      try {
        observer = new win.MutationObserver(function () {
          if (!active) return;
          if (mutationScans >= maxMutationScans) {
            result.truncated = true;
            warn('MUTATION_SCAN_LIMIT_REACHED', '页面增量扫描达到上限，后续变化留给末次扫描复核。');
            return;
          }
          if (mutationTimer) return;
          mutationTimer = setTimer(function () {
            mutationTimer = null;
            if (!active) return;
            mutationScans += 1;
            scanPublicData('mutation');
          }, 25);
        });
        observer.observe(documentRef.documentElement, { childList: true, subtree: true, characterData: true });
      } catch (_) {
        observer = null;
        warn('MUTATION_OBSERVER_UNAVAILABLE', '页面增量观察不可用，仍会执行初次与末次扫描。');
      }
    }

    function delay(ms) {
      return new Promise(function (resolve) { setTimer(resolve, ms); });
    }

    async function settlePending(maxWait) {
      if (!pending.length || maxWait <= 0) return;
      var deadline = Date.now() + maxWait;
      var cursor = 0;
      while (cursor < pending.length) {
        var remaining = deadline - Date.now();
        if (remaining <= 0) return;
        var batch = pending.slice(cursor);
        cursor = pending.length;
        var settled = Promise.all(batch.map(function (task) { return Promise.resolve(task).catch(function () {}); }));
        await Promise.race([settled, delay(remaining)]);
        if (Date.now() >= deadline) return;
      }
    }

    function restore() {
      active = false;
      if (fetchLayer) fetchLayer.active = false;
      if (xhrLayer) xhrLayer.active = false;
      if (mutationTimer) { try { clearTimer(mutationTimer); } catch (_) {} mutationTimer = null; }
      if (observer) { try { observer.disconnect(); } catch (_) {} observer = null; }
      for (var readerIndex = 0; readerIndex < activeReaders.length; readerIndex++) {
        var readerRecord = activeReaders[readerIndex];
        if (!readerRecord.done && !readerRecord.cancelled) {
          readerRecord.cancelled = true;
          try {
            var cancellation = readerRecord.reader.cancel();
            if (cancellation && typeof cancellation.catch === 'function') cancellation.catch(function () {});
          } catch (_) {}
        }
      }
      for (var index = 0; index < xhrListeners.length; index++) {
        var record = xhrListeners[index];
        if (!record.removed) {
          record.removed = true;
          try { record.xhr.removeEventListener('loadend', record.listener); } catch (_) {}
        }
      }
      if (wrappedFetch && win.fetch === wrappedFetch) {
        try { win.fetch = previousLiveFunction(originalFetch, 'fetch', 'previousFetch'); }
        catch (_) { warn('FETCH_RESTORE_FAILED', '页面 fetch 恢复失败。'); }
      }
      if (xhrProto && wrappedOpen && xhrProto.open === wrappedOpen) {
        try { xhrProto.open = previousLiveFunction(originalOpen, 'xhr', 'previousOpen'); }
        catch (_) { warn('XHR_RESTORE_FAILED', '页面 XHR.open 恢复失败。'); }
      }
      if (xhrProto && wrappedSend && xhrProto.send === wrappedSend) {
        try { xhrProto.send = previousLiveFunction(originalSend, 'xhr', 'previousSend'); }
        catch (_) { warn('XHR_RESTORE_FAILED', '页面 XHR.send 恢复失败。'); }
      }
    }

    function enforceResultBudget() {
      var size;
      try { size = utf8Bytes(JSON.stringify(result)); } catch (_) { size = Infinity; }
      if (size <= requestedResultBytes) return;
      result.truncated = true;
      warn('MAIN_RESULT_LIMIT_REACHED', 'MAIN 采集结果达到整体体积上限，已从末尾截断候选。');
      while (result.candidates.length) {
        try { size = utf8Bytes(JSON.stringify(result)); } catch (_) { size = Infinity; }
        if (size <= requestedResultBytes) break;
        result.candidates.pop();
      }
      while (result.warnings.length) {
        try { size = utf8Bytes(JSON.stringify(result)); } catch (_) { size = Infinity; }
        if (size <= requestedResultBytes) break;
        result.warnings.pop();
      }
    }

    try {
      patchNetwork();
      startMutationObserver();
      scanPublicData('initial');
      await delay(durationMs);
      if (active) scanPublicData('final');
      await settlePending(settleMs);
    } catch (_) {
      result.truncated = true;
      warn('MAIN_CAPTURE_FAILED', 'MAIN 私有采集运行失败，已保留此前确认的有界候选。');
    } finally {
      restore();
    }
    enforceResultBudget();
    return result;
  }

  /* Kept only as a compatibility export; static MAIN installation is intentionally disabled. */
  function install() { return false; }

  return Object.freeze({
    constants: CONSTANTS,
    parseSourcePage: parseSourcePage,
    parseResponseEndpoint: parseResponseEndpoint,
    allowedContentType: allowedContentType,
    isSensitiveKey: isSensitiveKey,
    clonePlainJson: clonePlainJson,
    hasPublicDetailStructure: hasPublicDetailStructure,
    candidateIdForJson: candidateIdForJson,
    parseJsonText: parseJsonText,
    prepareCandidate: prepareCandidate,
    readBoundedResponse: readBoundedResponse,
    runMainCaptureTask: runMainCaptureTask,
    install: install
  });
});
