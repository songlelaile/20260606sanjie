/* 生成视频工作台后台：只持久化任务头和账号绑定配置，不持久化密钥或 Blob。 */
(function (root, factory) {
  var contract = root && root.SZEcommerceVideoContract;
  if (!contract && typeof require === 'function') {
    try { contract = require('../labs/ecommerce-video-studio/video-studio-contract.js'); } catch (_) {}
  }
  var api = factory(root || {}, contract);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SZEcommerceVideoBackground = api;
  if (root && root.chrome && root.chrome.runtime && root.chrome.runtime.onMessage && contract) {
    try { api.install(root.chrome); } catch (_) {}
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, C) {
  'use strict';

  var MESSAGE_TYPES = Object.freeze({
    CAPABILITIES: 'VIDEO_STUDIO_CAPABILITIES',
    ANALYZE: 'VIDEO_STUDIO_ANALYZE',
    START: 'VIDEO_STUDIO_START',
    STATUS: 'VIDEO_STUDIO_STATUS',
    CANCEL: 'VIDEO_STUDIO_CANCEL',
    RETRY: 'VIDEO_STUDIO_RETRY',
    RESULT: 'VIDEO_STUDIO_RESULT',
    CONFIG_GET: 'VIDEO_STUDIO_CONFIG_GET',
    CONFIG_SAVE: 'VIDEO_STUDIO_CONFIG_SAVE'
  });
  var KNOWN_MESSAGES = Object.keys(MESSAGE_TYPES).map(function (key) { return MESSAGE_TYPES[key]; });
  var CONFIG_KEY = 'sz_ecommerce_video_config_v1';
  var TASK_KEY = 'sz_ecommerce_video_tasks_v1';
  var ARK_LIMITS = Object.freeze({
    bodyBytes: 64 * 1024 * 1024,
    imageBytes: 30 * 1024 * 1024,
    audioBytes: 15 * 1024 * 1024
  });
  var REQUEST_TIMEOUT_MS = Object.freeze({
    analysis: 120000,
    create: 90000,
    status: 25000,
    cancel: 25000
  });
  var DEFAULT_CONFIG = Object.freeze({
    adapter: 'ark',
    provider: 'doubao',
    createEndpoint: 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
    statusEndpoint: 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{taskId}',
    cancelEndpoint: 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{taskId}',
    uploadEndpoint: '',
    providerModels: C ? C.DEFAULT_PROVIDER_MODELS : {
      'seedance-2.0': 'doubao-seedance-2-0-260128', 'seedance-2.5': 'doubao-seedance-2-5-260628'
    }
  });

  function error(code, message, details) {
    if (C && C.contractError) return C.contractError(code, message, details);
    var err = new Error(message || code); err.code = code;
    if (details !== undefined) err.details = details;
    return err;
  }
  function text(value, max) { var out = String(value == null ? '' : value).trim(); return max ? out.slice(0, max) : out; }
  function plain(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null;
  }
  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function nowFrom(env) { return typeof env.now === 'function' ? Number(env.now()) : Date.now(); }
  function secretField(key) { return /^(api[-_]?key|key|authorization|cookie|token|secret|password)$/i.test(key); }
  function containsSecret(value) {
    if (!value || typeof value !== 'object') return false;
    return Object.keys(value).some(function (key) { return secretField(key) || containsSecret(value[key]); });
  }
  function endpoint(value, field, allowEmpty) {
    value = text(value, 2048);
    if (!value && allowEmpty) return '';
    if (!value) throw error('CONFIG_ENDPOINT_REQUIRED', field + ' 不能为空。');
    var probe = value.replace(/\{taskId\}/g, 'task-id');
    try {
      var parsed = new URL(probe);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('unsafe');
    } catch (_) { throw error('CONFIG_ENDPOINT_INVALID', field + ' 必须是无内嵌凭据的 HTTPS URL。'); }
    return value;
  }
  function sanitizeConfig(raw, base) {
    raw = plain(raw) ? raw : {};
    if (containsSecret(raw)) throw error('SECRET_CONFIG_FORBIDDEN', '视频工作台配置禁止保存 API Key、Cookie 或 Token。');
    base = plain(base) ? base : DEFAULT_CONFIG;
    var adapter = C.normalizeAdapter(raw.adapter || base.adapter) || '';
    if (!adapter) throw error('ADAPTER_INVALID', '适配器必须是 ark 或 generic-multipart。');
    var models = C.providerModelMap(Object.assign({}, base.providerModels || {}, raw.providerModels || {}));
    if (plain(raw.providerModels)) {
      Object.keys(raw.providerModels).forEach(function (productKey) {
        if (text(raw.providerModels[productKey], 220)) C.resolveModel(productKey, raw.providerModels);
      });
    }
    var adapterChanged = adapter !== base.adapter;
    var rawCancel = raw.cancelEndpoint == null
      ? (adapterChanged && adapter === 'generic-multipart' ? '' : base.cancelEndpoint)
      : raw.cancelEndpoint;
    var rawUpload = raw.uploadEndpoint == null
      ? (adapterChanged ? '' : base.uploadEndpoint)
      : raw.uploadEndpoint;
    return {
      adapter: adapter,
      provider: text(raw.provider == null ? base.provider : raw.provider, 80) || (adapter === 'ark' ? 'doubao' : 'generic'),
      createEndpoint: endpoint(raw.createEndpoint == null ? base.createEndpoint : raw.createEndpoint, 'createEndpoint', false),
      statusEndpoint: endpoint(raw.statusEndpoint == null ? base.statusEndpoint : raw.statusEndpoint, 'statusEndpoint', false),
      cancelEndpoint: endpoint(rawCancel, 'cancelEndpoint', true),
      uploadEndpoint: endpoint(rawUpload, 'uploadEndpoint', true),
      providerModels: models
    };
  }
  function publicConfig(config) {
    config = sanitizeConfig(config || {}, DEFAULT_CONFIG);
    return clone(config);
  }
  function makeStorage(env) {
    if (env.storageGet && env.storageSet) return { get: env.storageGet, set: env.storageSet };
    var area = env.storage || (env.chrome && env.chrome.storage && env.chrome.storage.local);
    if (!area) throw error('STORAGE_UNAVAILABLE', 'chrome.storage.local 不可用。');
    function invoke(method, arg) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        function done(value) {
          if (settled) return; settled = true;
          var last = env.chrome && env.chrome.runtime && env.chrome.runtime.lastError;
          if (last) reject(error('STORAGE_ERROR', last.message || String(last))); else resolve(value);
        }
        try {
          area[method](arg, done);
          // Chrome 的 StorageArea 可能在接收 callback 的同时先返回 Promise(undefined)，
          // 且原生绑定的 function.length 常为 0。这里固定走 callback 单通道，避免假返回值
          // 抢先结算并覆盖随后到达的真实读写结果。
        } catch (cause) {
          if (settled) return; settled = true;
          reject(cause);
        }
      });
    }
    return { get: function (key) { return invoke('get', key); }, set: function (value) { return invoke('set', value); } };
  }
  function unwrapStored(result, key) { return result && Object.prototype.hasOwnProperty.call(result, key) ? result[key] : undefined; }
  function accountFrom(value) {
    if (typeof value === 'string') return text(value, 240);
    value = value || {};
    return text(value.accountKey || value.accountId || (value.user && (value.user.id || value.user.userId || value.user.email)), 240);
  }
  function id() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
  }
  function taskId(env) { return 'video_' + (typeof env.randomUUID === 'function' ? env.randomUUID() : id()); }
  function requireIdempotencyKey(message) {
    var value = text(message && (message.idempotencyKey || message.clientRequestId || message.requestId), 240);
    if (!value) throw error('IDEMPOTENCY_KEY_REQUIRED', '启动或重试任务必须提供 idempotencyKey。');
    return value;
  }
  function responseError(cause, type, requestId) {
    return {
      ok: false,
      type: type || '',
      payload: {
        schemaVersion: 1,
        requestId: requestId || '',
        error: { code: cause && cause.code || 'VIDEO_STUDIO_ERROR', message: text(cause && cause.message || cause, 800), details: cause && cause.details }
      }
    };
  }
  function unpackMessage(message) {
    message = plain(message) ? message : {};
    var body = plain(message.payload) ? message.payload : {};
    var merged = Object.assign({}, message, body);
    merged.type = message.type;
    merged.payload = message.payload;
    merged.request = plain(body.request) ? body.request : message.request;
    merged.requestId = text(body.requestId || message.requestId, 240);
    merged.taskId = text(body.taskId || message.taskId, 240);
    merged.idempotencyKey = text(body.idempotencyKey || message.idempotencyKey || merged.requestId, 240);
    merged.config = plain(body.config) ? body.config : message.config;
    return merged;
  }
  function jsonHeaders(apiKey, idempotencyKey) {
    var headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    return headers;
  }
  async function parseResponse(response) {
    var body = null;
    try { body = await response.json(); } catch (_) {
      try { body = { message: text(await response.text(), 500) }; } catch (_) { body = {}; }
    }
    if (!response.ok) {
      throw error('PROVIDER_HTTP_ERROR', '视频供应商请求失败（HTTP ' + response.status + '）。', {
        status: response.status, providerCode: text(body && (body.code || body.error && body.error.code), 100)
      });
    }
    return body || {};
  }
  function requestWithDeadline(env, options, operation) {
    options = options || {};
    var fallbackMs = Number(options.fallbackMs);
    var configuredMs = Number(env && env[options.envKey]);
    var timeoutMs = Number.isFinite(configuredMs) && configuredMs > 0 ? configuredMs : fallbackMs;
    var setTimer = env && typeof env.setTimeout === 'function'
      ? env.setTimeout
      : (typeof root.setTimeout === 'function' ? root.setTimeout.bind(root) : setTimeout);
    var clearTimer = env && typeof env.clearTimeout === 'function'
      ? env.clearTimeout
      : (typeof root.clearTimeout === 'function' ? root.clearTimeout.bind(root) : clearTimeout);
    var AbortControllerCtor = env && env.AbortController || root.AbortController;

    return new Promise(function deadlinePromise(resolve, reject) {
      var settled = false;
      var controller = typeof AbortControllerCtor === 'function' ? new AbortControllerCtor() : null;
      var timer = setTimer(function onDeadline() {
        if (settled) return;
        settled = true;
        if (controller) {
          try { controller.abort(); } catch (_) {}
        }
        reject(error(options.code || 'PROVIDER_TIMEOUT', options.message || '视频供应商响应超时。', {
          timeoutMs: timeoutMs,
          stateUncertain: options.stateUncertain === true
        }));
      }, timeoutMs);

      function finish(handler, value) {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        handler(value);
      }

      Promise.resolve().then(function runOperation() {
        return operation(controller ? controller.signal : undefined);
      }).then(function resolved(value) {
        finish(resolve, value);
      }, function rejected(cause) {
        finish(reject, cause);
      });
    });
  }
  function providerTaskId(body) {
    return text(body && (body.id || body.task_id || body.taskId || body.data && (body.data.id || body.data.task_id || body.data.taskId)), 240);
  }
  function statusValue(body) {
    return text(body && (body.status || body.state || body.data && (body.data.status || body.data.state)), 80).toLowerCase();
  }
  function canonicalProviderStatus(value) {
    if (['succeeded', 'success', 'completed', 'complete', 'done'].indexOf(value) >= 0) return 'succeeded';
    if (['failed', 'error', 'errored', 'expired'].indexOf(value) >= 0) return 'failed';
    if (['cancelled', 'canceled'].indexOf(value) >= 0) return 'cancelled';
    return 'processing';
  }
  function providerProgress(body) {
    var value = body && (body.progress != null ? body.progress
      : (body.data && body.data.progress != null ? body.data.progress : undefined));
    var number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 100 ? Math.round(number * 100) / 100 : null;
  }
  function providerErrorCode(body) {
    return text(body && (body.error_code || body.errorCode || body.code
      || body.error && (body.error.code || body.error.type)
      || body.data && (body.data.error_code || body.data.errorCode || body.data.code)), 160);
  }
  function providerMessage(body) {
    return text(body && (body.message || body.error && (body.error.message || body.error.msg)
      || body.data && (body.data.message || body.data.error && (body.data.error.message || body.data.error.msg))), 500);
  }
  function collectResultUrls(body) {
    var candidates = [];
    function add(value) {
      if (Array.isArray(value)) { value.forEach(add); return; }
      if (typeof value === 'string') candidates.push(value);
      else if (value && typeof value === 'object') add(value.url || value.video_url || value.videoUrl);
    }
    add(body && body.video_url); add(body && body.videoUrl); add(body && body.result_url);
    add(body && body.content); add(body && body.output); add(body && body.result);
    add(body && body.data && (body.data.content || body.data.output || body.data.result || body.data.video_url));
    var seen = Object.create(null);
    return candidates.map(function (value) { return C.validRemoteAssetUrl(value); }).filter(function (value) {
      if (!value || seen[value]) return false; seen[value] = true; return true;
    });
  }
  function assetBindingLines(request, includeAnalysisOnly) {
    var lines = [];
    function append(values, label) {
      (values || []).forEach(function (asset, index) {
        var role = asset.role || 'asset';
        var roleLabel = C.ASSET_ROLE_LABELS && C.ASSET_ROLE_LABELS[role] || '通用素材';
        lines.push(label + (index + 1) + '（角色：' + roleLabel + ' / ' + role + '）：仅用于该角色，不得与其他编号互换身份或用途。');
      });
    }
    append(request.images, '图片');
    append(request.videos, '视频');
    append(request.audios, '音频');
    if (includeAnalysisOnly && request.referenceVideo) append([request.referenceVideo], '分析参考视频');
    if (includeAnalysisOnly) append(request.referenceFrames, '分析参考帧');
    return lines;
  }
  function creativeContext(request, includeAnalysisOnly) {
    var route = C.CREATIVE_ROUTES[request.creativeRoute];
    var style = C.STYLE_PROFILES[request.styleProfile];
    var bindings = assetBindingLines(request, includeAnalysisOnly);
    return [
      '创意路线：' + route.label + '。' + route.promptInstruction,
      '风格路线：' + style.label + '。' + style.promptInstruction,
      bindings.length ? '素材绑定（编号与提交 content 顺序一致）：\n' + bindings.join('\n') : '素材绑定：无；仅依据用户文本生成。',
      '商品保真：凡角色为 product 的参考素材，必须保持商品轮廓、比例、包装版式、主色、材质、Logo 与可见文字稳定，不得凭空改款、换色或增加部件。人物主体保持身份和外观连续；scene/style/motion/rhythm 只影响其标注维度，不得覆盖商品或人物身份。'
    ].join('\n');
  }
  function promptFor(request) {
    var pieces = [
      creativeContext(request, false),
      request.script
    ];
    if (request.supplementalRequirements) pieces.push(request.supplementalRequirements);
    if (request.storyboard && request.storyboard.length) {
      var confirmedShots = request.storyboard.map(function (shot) {
        var timing = request.productKey === 'seedance-2.0'
          ? '约 ' + shot.durationSeconds + ' 秒，保持顺序'
          : '约 ' + Math.round(shot.startSecond) + '–' + Math.round(shot.endSecond) + ' 秒，时长约 ' + Math.round(shot.durationSeconds) + ' 秒';
        return [
          '镜头 ' + shot.order + '（' + timing + '）',
          '画面：' + shot.visual,
          shot.composition ? '构图：' + shot.composition : '',
          shot.camera ? '景别/机位：' + shot.camera : '',
          shot.motion ? '运镜：' + shot.motion : '',
          shot.rhythm ? '节奏：' + shot.rhythm : '',
          shot.audioRole ? '声音职责：' + shot.audioRole : '',
          shot.narration ? '字幕/口播：' + shot.narration : '',
          shot.reconstructionIntent ? '重构意图：' + shot.reconstructionIntent : ''
        ].filter(Boolean).join('；');
      }).join('\n');
      pieces.push(request.productKey === 'seedance-2.0'
        ? '以下是用户最终确认的分镜时间轴：必须保持镜头顺序和目标总时长，尽量贴合各镜目标时长；Seedance 2.0 对精确分秒控制不稳定，不承诺逐秒或帧级一致。\n' + confirmedShots
        : '以下是用户最终确认的分镜时间轴：按整数秒时间段和镜头顺序近似执行，不得自行删改叙事目标；不承诺帧级一致。\n' + confirmedShots);
    }
    if (request.audioMode === 'silent') {
      pieces.push('声音约束：全程无声，不生成人声、对话、音效或背景音乐。');
    } else if (request.audioMode === 'sound_only') {
      pieces.push('声音约束：只生成环境音、动作音效或背景音乐，不得出现人声、口播或对话。这是提示词软约束。');
    } else if (request.audioMode === 'narration') {
      pieces.push('口播约束：使用 ' + request.narrationLanguage + ' 口播，所有可发声的口播或对话必须写在中文双引号“”内。');
    }
    return pieces.filter(Boolean).join('\n\n');
  }
  function arkBody(request, model, assets) {
    var content = [{ type: 'text', text: promptFor(request) }];
    assets.images.forEach(function (asset) { content.push({ type: 'image_url', image_url: { url: asset.remoteUrl }, role: 'reference_image' }); });
    assets.videos.forEach(function (asset) { content.push({ type: 'video_url', video_url: { url: asset.remoteUrl }, role: 'reference_video' }); });
    assets.audios.forEach(function (asset) { content.push({ type: 'audio_url', audio_url: { url: asset.remoteUrl }, role: 'reference_audio' }); });
    var body = {
      model: model.providerModel,
      content: content,
      duration: request.durationSeconds,
      resolution: request.resolution,
      ratio: request.ratio,
      generate_audio: request.generateSound === true
    };
    if (model.productKey === 'seedance-2.5' && content.length > 1) {
      body.omni_reference_task_type = 'reference';
      body.output_format = 'mp4';
    }
    return body;
  }
  function statusUrl(config, providerId) {
    return config.statusEndpoint.indexOf('{taskId}') >= 0
      ? config.statusEndpoint.replace(/\{taskId\}/g, encodeURIComponent(providerId))
      : config.statusEndpoint.replace(/\/$/, '') + '/' + encodeURIComponent(providerId);
  }
  function cancelUrl(config, providerId) {
    return config.cancelEndpoint.indexOf('{taskId}') >= 0
      ? config.cancelEndpoint.replace(/\{taskId\}/g, encodeURIComponent(providerId))
      : config.cancelEndpoint.replace(/\/$/, '') + '/' + encodeURIComponent(providerId);
  }

  function createController(options) {
    if (!C) throw error('VIDEO_CONTRACT_UNAVAILABLE', '生成视频合同脚本未加载。');
    var env = Object.assign({ chrome: root.chrome, fetch: root.fetch && root.fetch.bind(root) }, options || {});
    var storage = makeStorage(env);
    var mutationTail = Promise.resolve();
    var startInflight = new Map();
    var pollInflight = new Map();
    var cancelInflight = new Map();

    function serial(fn) {
      var next = mutationTail.then(fn, fn);
      mutationTail = next.catch(function () {});
      return next;
    }
    async function resolveAccount(sender) {
      var resolved;
      if (typeof env.resolveAccountKey === 'function') resolved = await env.resolveAccountKey({ sender: sender });
      else if (typeof root.resolveUnifiedConfigReference === 'function') resolved = await root.resolveUnifiedConfigReference({});
      else if (typeof root.authCheck === 'function') resolved = await root.authCheck();
      var key = accountFrom(resolved);
      if (!key) throw error('ACCOUNT_UNAVAILABLE', '无法确定当前登录账号，已阻止跨账号读写。');
      return key;
    }
    async function credentials(accountKey, provider) {
      var resolved;
      if (typeof env.resolveCredentials === 'function') resolved = await env.resolveCredentials({ accountKey: accountKey, provider: provider });
      else if (typeof root.resolveUnifiedConfigReference === 'function') resolved = await root.resolveUnifiedConfigReference({ accountKey: accountKey, provider: provider });
      else throw error('CREDENTIAL_RESOLVER_UNAVAILABLE', '统一 API 配置解析器未加载。');
      if (resolved && resolved.ok === false) throw error(resolved.code || 'CREDENTIALS_UNAVAILABLE', resolved.error || '当前账号的 API 配置不可用。');
      var returnedAccount = accountFrom(resolved);
      if (returnedAccount && returnedAccount !== accountKey) throw error('ACCOUNT_CHANGED', '解析 API 配置时账号已变更。');
      var cfg = resolved && resolved.config || resolved || {};
      var apiKey = text(cfg.apiKey || cfg.key, 1000);
      if (!apiKey) throw error('CREDENTIALS_UNAVAILABLE', '当前账号未配置视频供应商 API Key。');
      return { apiKey: apiKey, config: cfg };
    }
    async function readConfigRoot() {
      var raw = unwrapStored(await storage.get(CONFIG_KEY), CONFIG_KEY);
      return plain(raw) && plain(raw.accounts) ? raw : { version: 1, accounts: {} };
    }
    async function getConfigFor(accountKey) {
      var rootConfig = await readConfigRoot();
      return sanitizeConfig(rootConfig.accounts[accountKey] || {}, DEFAULT_CONFIG);
    }
    async function saveConfigFor(accountKey, patch) {
      return serial(async function () {
        var rootConfig = await readConfigRoot();
        var next = sanitizeConfig(patch, rootConfig.accounts[accountKey] || DEFAULT_CONFIG);
        rootConfig.accounts[accountKey] = next;
        await storage.set((function () { var value = {}; value[CONFIG_KEY] = rootConfig; return value; })());
        return publicConfig(next);
      });
    }
    async function readTaskRoot() {
      var raw = unwrapStored(await storage.get(TASK_KEY), TASK_KEY);
      return plain(raw) && plain(raw.accounts) ? raw : { version: 1, accounts: {} };
    }
    function bucket(rootState, accountKey) {
      if (!plain(rootState.accounts[accountKey])) rootState.accounts[accountKey] = { tasks: {}, idempotency: {} };
      var value = rootState.accounts[accountKey];
      if (!plain(value.tasks)) value.tasks = {};
      if (!plain(value.idempotency)) value.idempotency = {};
      return value;
    }
    async function saveTaskRoot(rootState) {
      var update = {}; update[TASK_KEY] = rootState; await storage.set(update);
    }
    async function readTask(accountKey, requestedTaskId) {
      var state = await readTaskRoot();
      var value = bucket(state, accountKey).tasks[text(requestedTaskId, 240)];
      if (!value) throw error('TASK_NOT_FOUND', '当前账号下不存在该视频任务。');
      return clone(value);
    }
    async function mutateTask(accountKey, requestedTaskId, mutator) {
      return serial(async function () {
        var state = await readTaskRoot(); var b = bucket(state, accountKey);
        var current = b.tasks[requestedTaskId];
        if (!current) throw error('TASK_NOT_FOUND', '当前账号下不存在该视频任务。');
        var next = await mutator(clone(current), b);
        b.tasks[requestedTaskId] = next;
        await saveTaskRoot(state);
        return clone(next);
      });
    }
    async function readLocal(asset) {
      var store = env.store || root.SZEcommerceVideoStore;
      if (!store) throw error('ASSET_STORE_UNAVAILABLE', '本地素材引用存在，但 SZEcommerceVideoStore 未加载。');
      var ref = asset.storageRef; var record;
      if (typeof store.getAsset === 'function') record = await store.getAsset(ref.id);
      else if (typeof store.readAsset === 'function') record = await store.readAsset(ref);
      else if (typeof store.get === 'function') record = await store.get(ref);
      else throw error('ASSET_STORE_UNAVAILABLE', '本地素材库未提供可用的只读 API。');
      if (!record) throw error('ASSET_NOT_FOUND', '本地素材不存在或已被删除。', { id: ref.id });
      var blob = record.blob || record.file || record.data || record;
      if (typeof Blob === 'undefined' || !(blob instanceof Blob)) throw error('ASSET_BINARY_INVALID', '本地素材记录不包含有效 Blob。');
      return { asset: asset, blob: blob, name: text(record.name || asset.name || ref.id, 260), mimeType: text(record.mimeType || blob.type, 120) };
    }
    async function blobDataUrl(blob, maxBytes, tooLargeCode, tooLargeMessage) {
      maxBytes = maxBytes || 10 * 1024 * 1024;
      if (blob.size >= maxBytes) throw error(tooLargeCode || 'ANALYSIS_ASSET_TOO_LARGE', tooLargeMessage || '本地素材超过允许的大小。');
      var bytes = new Uint8Array(await blob.arrayBuffer()); var binary = '';
      for (var offset = 0; offset < bytes.length; offset += 32768) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(bytes.length, offset + 32768)));
      }
      var encoded;
      if (typeof btoa === 'function') encoded = btoa(binary);
      else if (typeof Buffer !== 'undefined') encoded = Buffer.from(bytes).toString('base64');
      else throw error('BASE64_UNAVAILABLE', '当前后台无法编码本地图片。');
      return 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + encoded;
    }
    function analysisPrompt(request) {
      return [
        '你是生成视频编导。请根据用户需求与获授权素材，输出可编辑的 ' + request.durationSeconds + ' 秒分镜脚本。',
        '模式：' + request.mode + '；创作目标：' + (request.goal || '无') + '；补充要求：' + (request.supplementalRequirements || '无') + '。',
        creativeContext(request, true),
        request.mode === 'remix' ? '参考视频只用于节奏与结构重构，不得复制第三方品牌、人脸、受保护表达或未授权素材。' : '',
        request.audioMode === 'narration'
          ? '需要口播；把所有可发声的对话/口播句用中文双引号标出。'
          : (request.audioMode === 'sound_only' ? '只需音效/BGM，脚本不得包含口播或对话。' : '全程无声，脚本不得包含口播或对话。'),
        '只输出 JSON 对象：{"creativeSummary":"...","script":"...","storyboard":[{"id":"shot-1","order":1,"startSecond":0,"endSecond":1,"durationSeconds":1,"visual":"...","narration":"","composition":"...","camera":"...","motion":"...","rhythm":"...","audioRole":"...","reconstructionIntent":"..."}]}。',
        'storyboard 编辑时间轴之和必须等于 ' + request.durationSeconds + '；script 必须是可直接确认修改的完整生成提示。时间轴是编排目标，不得承诺供应商逐秒或帧级复现。参考重构只能依据按时间排序的关键帧重构静态视觉结构与镜头顺序；运镜、连续动作和声音必须为目标商品重新设计，不能声称从关键帧提取，也不能照抄参考内容。'
      ].filter(Boolean).join('\n');
    }
    function parseAnalysisJson(value, durationSeconds) {
      var source = value;
      if (Array.isArray(source)) source = source.map(function (part) { return part && (part.text || part.content) || ''; }).join('');
      source = text(source, 100000).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      var parsed;
      try { parsed = JSON.parse(source); } catch (_) { throw error('ANALYSIS_JSON_INVALID', '分析模型未返回合法 JSON。'); }
      if (!plain(parsed) || !text(parsed.script, 30000) || !Array.isArray(parsed.storyboard)) {
        throw error('ANALYSIS_SCHEMA_INVALID', '分析模型缺少 script 或 storyboard。');
      }
      var storyboard;
      try { storyboard = C.normalizeStoryboard(parsed.storyboard, { durationSeconds: durationSeconds }); }
      catch (cause) { throw error('ANALYSIS_SCHEMA_INVALID', '分析模型返回的分镜时间轴或结构无效。', { causeCode: cause && cause.code }); }
      return {
        creativeSummary: text(parsed.creativeSummary, 5000),
        script: text(parsed.script, 30000),
        storyboard: storyboard
      };
    }
    async function defaultAnalyze(request, accountKey, provider) {
      var creds = await credentials(accountKey, provider);
      var cfg = creds.config || {}; var base = text(cfg.visionBaseUrl || cfg.baseURL, 2048).replace(/\/+$/, '');
      var model = text(cfg.visionModel || cfg.textModel, 220);
      if (!base || !model) throw error('ANALYZER_CONFIG_INVALID', '当前账号的统一 API 配置缺少视觉/文本端点或模型。');
      var chatEndpoint = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
      endpoint(chatEndpoint, 'analysisEndpoint', false);
      var parts = [{ type: 'text', text: analysisPrompt(request) }];
      parts.push({ type: 'text', text: '下面 ' + request.images.length + ' 张是目标商品图，只能从中提取目标商品事实、外观与卖点。' });
      for (var asset of request.images) {
        var url = asset.remoteUrl;
        if (!url) url = await blobDataUrl((await readLocal(asset)).blob, 10 * 1024 * 1024, 'ANALYSIS_ASSET_TOO_LARGE', '单张本地分析图片不能达到或超过 10MB。');
        parts.push({ type: 'image_url', image_url: { url: url } });
      }
      if (request.referenceFrames && request.referenceFrames.length) {
        parts.push({ type: 'text', text: '下面 ' + request.referenceFrames.length + ' 张按时间顺序来自获授权参考视频，只能提取静态视觉结构、构图与镜头顺序线索。关键帧不能提供原始运镜、连续动作、剪辑点或声音；这些内容必须围绕目标商品重新设计。不得提取或复用其中的品牌、人物身份、原文案与商品事实。' });
        for (var frame of request.referenceFrames) {
          var frameUrl = frame.remoteUrl;
          if (!frameUrl) frameUrl = await blobDataUrl((await readLocal(frame)).blob, 10 * 1024 * 1024, 'ANALYSIS_ASSET_TOO_LARGE', '单张本地参考帧不能达到或超过 10MB。');
          parts.push({ type: 'image_url', image_url: { url: frameUrl } });
        }
      }
      if (request.referenceVideo) {
        parts[0].text += '\nanalysis-only 参考视频：' + (request.referenceVideo.remoteUrl || ('local:' + request.referenceVideo.id)) + '。该地址不会作为视觉内容发送给分析模型；你只能使用已提供的关键帧理解静态视觉结构和镜头顺序线索。';
      }
      if (typeof env.fetch !== 'function') throw error('FETCH_UNAVAILABLE', '后台 fetch 不可用。');
      var body = await requestWithDeadline(env, {
        envKey: 'analysisTimeoutMs',
        fallbackMs: REQUEST_TIMEOUT_MS.analysis,
        code: 'ANALYSIS_TIMEOUT',
        message: '分析模型响应超时，本次分析状态未确认；系统不会自动重复请求。'
      }, async function analyzeRequest(signal) {
        var response = await env.fetch(chatEndpoint, {
          method: 'POST', headers: jsonHeaders(creds.apiKey), cache: 'no-store', signal: signal,
          body: JSON.stringify({ model: model, messages: [{ role: 'system', content: '只输出符合要求的合法 JSON。' }, { role: 'user', content: parts }], temperature: 0.2 })
        });
        return parseResponse(response);
      });
      var content = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
      return parseAnalysisJson(content, request.durationSeconds);
    }
    async function resolveAssets(request, adapter) {
      var groups = { images: [], videos: [], audios: [] };
      for (var g of ['images', 'videos', 'audios']) {
        for (var asset of request[g]) {
          if (asset.remoteUrl) groups[g].push(asset);
          else {
            var local = await readLocal(asset);
            if (adapter === 'ark') {
              if (g === 'images' || g === 'audios') {
                var expectedMime = g === 'images' ? 'image/' : 'audio/';
                var mime = text(local.mimeType || local.blob.type, 120).toLowerCase();
                if (mime.indexOf(expectedMime) !== 0) throw error('ASSET_MIME_INVALID', 'Ark 本地 ' + g + ' 素材的 MIME 类型无效。');
                var limit = g === 'images' ? ARK_LIMITS.imageBytes : ARK_LIMITS.audioBytes;
                var dataUrl = await blobDataUrl(
                  local.blob,
                  limit,
                  g === 'images' ? 'ARK_IMAGE_TOO_LARGE' : 'ARK_AUDIO_TOO_LARGE',
                  g === 'images' ? 'Ark 单张图片必须小于 30MB。' : 'Ark 单个音频必须小于 15MB。'
                );
                groups[g].push(Object.assign({}, asset, { storageRef: null, remoteUrl: dataUrl }));
                continue;
              }
              throw error('LOCAL_ASSET_UPLOAD_REQUIRED', 'Ark 视频输入只接受公网 HTTPS/asset:// URL；请先通过 Assets/VOD/TOS 上传本地视频。');
            } else groups[g].push(local);
          }
        }
      }
      return groups;
    }
    async function adapterCreate(config, creds, request, model, idemKey) {
      if (typeof env.fetch !== 'function') throw error('FETCH_UNAVAILABLE', '后台 fetch 不可用。');
      var assets = await resolveAssets(request, config.adapter);
      var requestInit;
      if (config.adapter === 'ark') {
        var serializedArkBody = JSON.stringify(arkBody(request, model, assets));
        var arkBytes = typeof TextEncoder !== 'undefined'
          ? new TextEncoder().encode(serializedArkBody).byteLength
          : (typeof Buffer !== 'undefined' ? Buffer.byteLength(serializedArkBody, 'utf8') : serializedArkBody.length * 3);
        if (arkBytes >= ARK_LIMITS.bodyBytes) {
          throw error('ARK_REQUEST_TOO_LARGE', 'Ark 创建请求体必须小于 64MB。', { bodyBytes: arkBytes, limitBytes: ARK_LIMITS.bodyBytes });
        }
        requestInit = {
          method: 'POST', headers: jsonHeaders(creds.apiKey, idemKey),
          body: serializedArkBody, cache: 'no-store'
        };
      } else {
        var form = new FormData();
        var metadata = clone(request);
        // referenceVideo/referenceFrames 仅用于分析和重构脚本，任何生成适配器都不得透传。
        delete metadata.referenceVideo;
        delete metadata.referenceFrames;
        ['images', 'videos', 'audios'].forEach(function (group) {
          metadata[group] = assets[group].map(function (item, index) {
            if (item.remoteUrl) return item;
            return { id: item.asset.id, kind: item.asset.kind, multipartField: group + '_' + index, name: item.name, mimeType: item.mimeType };
          });
        });
        metadata.providerModel = model.providerModel;
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
        ['images', 'videos', 'audios'].forEach(function (group) {
          assets[group].forEach(function (item, index) {
            if (item.blob) form.append(group + '_' + index, item.blob, item.name || (group + '_' + index));
          });
        });
        requestInit = {
          method: 'POST', headers: Object.assign(creds.apiKey ? { Authorization: 'Bearer ' + creds.apiKey } : {}, { 'Idempotency-Key': idemKey }),
          body: form, cache: 'no-store'
        };
      }
      var body = await requestWithDeadline(env, {
        envKey: 'createTimeoutMs',
        fallbackMs: REQUEST_TIMEOUT_MS.create,
        code: 'PROVIDER_CREATE_TIMEOUT',
        message: '视频供应商创建响应超时，任务是否已被接收仍不确定；请勿立即重复提交。',
        stateUncertain: true
      }, async function createRequest(signal) {
        requestInit.signal = signal;
        return parseResponse(await env.fetch(config.createEndpoint, requestInit));
      });
      var remoteId = providerTaskId(body);
      if (!remoteId) throw error('PROVIDER_TASK_ID_MISSING', '供应商未返回稳定任务 ID，不能伪造成功。');
      return { providerTaskId: remoteId, body: body };
    }
    async function adapterStatus(config, creds, task) {
      var body = await requestWithDeadline(env, {
        envKey: 'statusTimeoutMs',
        fallbackMs: REQUEST_TIMEOUT_MS.status,
        code: 'PROVIDER_STATUS_TIMEOUT',
        message: '视频供应商状态查询超时，任务状态保持不变。'
      }, async function statusRequest(signal) {
        return parseResponse(await env.fetch(statusUrl(config, task.providerTaskId), {
          method: 'GET', headers: jsonHeaders(creds.apiKey), cache: 'no-store', signal: signal
        }));
      });
      var providerState = statusValue(body); var state = canonicalProviderStatus(providerState);
      var urls = collectResultUrls(body);
      if (state === 'succeeded' && !urls.length) {
        throw error('PROVIDER_RESULT_MISSING', '供应商报告完成，但未返回可验证的结果 URL。');
      }
      return {
        status: state,
        providerState: providerState,
        resultUrls: urls,
        message: providerMessage(body),
        errorCode: providerErrorCode(body),
        progress: providerProgress(body)
      };
    }
    async function adapterCancel(config, creds, task) {
      if (!config.cancelEndpoint) throw error('CANCEL_UNSUPPORTED', '当前供应商未配置可验证的取消端点，不能伪造已取消。');
      await requestWithDeadline(env, {
        envKey: 'cancelTimeoutMs',
        fallbackMs: REQUEST_TIMEOUT_MS.cancel,
        code: 'PROVIDER_CANCEL_TIMEOUT',
        message: '视频供应商取消响应超时，任务状态保持不变。',
        stateUncertain: true
      }, async function cancelRequest(signal) {
        return parseResponse(await env.fetch(cancelUrl(config, task.providerTaskId), {
          method: config.adapter === 'ark' ? 'DELETE' : 'POST', headers: jsonHeaders(creds.apiKey),
          body: config.adapter === 'ark' ? undefined : '{}', cache: 'no-store', signal: signal
        }));
      });
      return true;
    }
    async function submitExisting(accountKey, localTaskId, idemKey, config, model) {
      var capture = await mutateTask(accountKey, localTaskId, function (task) {
        task = C.transitionTask(task, 'submitting', { now: nowFrom(env) });
        task.phase = 'provider_create'; task.error = ''; task.errorCode = ''; return task;
      });
      try {
        var creds = await credentials(accountKey, config.provider);
        var created = await adapterCreate(config, creds, capture._request, model, idemKey);
        return await mutateTask(accountKey, localTaskId, function (task) {
          if (task.generation !== capture.generation || task.status !== 'submitting') return task;
          task = C.transitionTask(task, 'processing', { now: nowFrom(env) });
          task.providerTaskId = created.providerTaskId; task.phase = 'provider_processing';
          task.providerState = statusValue(created.body);
          var createdProgress = providerProgress(created.body);
          if (createdProgress !== null) task.progress = createdProgress;
          task.message = providerMessage(created.body);
          task.errorCode = providerErrorCode(created.body);
          task.submittedAt = nowFrom(env); return task;
        });
      } catch (cause) {
        var failedTask = await mutateTask(accountKey, localTaskId, function (task) {
          if (task.generation !== capture.generation || task.status !== 'submitting') return task;
          task = C.transitionTask(task, 'failed', { now: nowFrom(env) });
          task.errorCode = cause && cause.code || 'PROVIDER_CREATE_FAILED'; task.error = text(cause && cause.message, 500);
          task.phase = 'failed'; task.finishedAt = nowFrom(env); return task;
        }).catch(function () { return null; });
        if (failedTask && cause && typeof cause === 'object') {
          var causeDetails = plain(cause.details) ? clone(cause.details) : {};
          causeDetails.task = C.publicTask(failedTask);
          try { cause.details = causeDetails; } catch (_) {}
        }
        throw cause;
      }
    }
    async function start(message, sender) {
      var accountKey = await resolveAccount(sender); var idemKey = requireIdempotencyKey(message);
      var inflightKey = accountKey + ':' + C.fingerprint(idemKey, 'idem_');
      if (startInflight.has(inflightKey)) return startInflight.get(inflightKey);
      var promise = (async function () {
        var requestBody = message.request || (plain(message.payload) && !message.payload.schemaVersion ? message.payload : message);
        var request = C.normalizeRequest(requestBody, { stage: 'submit' });
        var config = await getConfigFor(accountKey); var model = C.resolveModel(request.productKey, config.providerModels);
        var requestFingerprint = C.fingerprint(request); var idemFingerprint = C.fingerprint(idemKey, 'idem_');
        var created = await serial(async function () {
          var state = await readTaskRoot(); var b = bucket(state, accountKey); var prior = b.idempotency[idemFingerprint];
          if (prior) {
            if (prior.requestFingerprint !== requestFingerprint) throw error('IDEMPOTENCY_CONFLICT', '同一 idempotencyKey 已绑定不同请求。');
            return { existing: true, task: clone(b.tasks[prior.taskId]) };
          }
          var timestamp = nowFrom(env); var localId = taskId(env);
          var task = {
            schemaVersion: C.TASK_SCHEMA_VERSION, contractVersion: C.CONTRACT_VERSION,
            taskId: localId, accountKey: accountKey, mode: request.mode,
            creativeRoute: request.creativeRoute, styleProfile: request.styleProfile, generation: 1, attempt: 1,
            status: 'queued', phase: 'queued', productKey: model.productKey, displayName: model.displayName,
            providerModel: model.providerModel, adapter: config.adapter, provider: config.provider,
            requestFingerprint: requestFingerprint, idempotencyFingerprint: idemFingerprint,
            providerTaskId: '', resultUrls: [], createdAt: timestamp, updatedAt: timestamp,
            scriptConfirmed: request.scriptConfirmed, _request: request
          };
          b.tasks[localId] = task; b.idempotency[idemFingerprint] = { taskId: localId, requestFingerprint: requestFingerprint };
          await saveTaskRoot(state); return { existing: false, task: clone(task) };
        });
        if (created.existing) return { task: C.publicTask(created.task), idempotent: true };
        var submitted = await submitExisting(accountKey, created.task.taskId, idemKey, config, model);
        return { task: C.publicTask(submitted), idempotent: false };
      })();
      startInflight.set(inflightKey, promise);
      try { return await promise; } finally { startInflight.delete(inflightKey); }
    }
    async function status(message, sender) {
      var accountKey = await resolveAccount(sender); var requestedTaskId = text(message.taskId, 240);
      var key = accountKey + ':' + requestedTaskId;
      if (pollInflight.has(key)) return pollInflight.get(key);
      var promise = (async function () {
        var task = await readTask(accountKey, requestedTaskId);
        if (C.isTerminal(task.status)) return { task: C.publicTask(task), idempotent: true };
        if (!task.providerTaskId) return { task: C.publicTask(task), idempotent: true };
        var captureGeneration = task.generation; var config = await getConfigFor(accountKey); var creds = await credentials(accountKey, config.provider);
        var remote;
        try { remote = await adapterStatus(config, creds, task); }
        catch (cause) {
          if (cause && cause.code === 'PROVIDER_RESULT_MISSING') {
            await mutateTask(accountKey, requestedTaskId, function (current) {
              if (current.generation !== captureGeneration || C.isTerminal(current.status)) return current;
              current = C.transitionTask(current, 'failed', { now: nowFrom(env) });
              current.errorCode = cause.code; current.error = cause.message; current.finishedAt = nowFrom(env); return current;
            });
          }
          throw cause;
        }
        var updated = await mutateTask(accountKey, requestedTaskId, function (current) {
          if (current.generation !== captureGeneration || C.isTerminal(current.status)) return current;
          if (remote.status !== 'processing') current = C.transitionTask(current, remote.status, { now: nowFrom(env) });
          else current.updatedAt = nowFrom(env);
          current.phase = remote.status === 'processing' ? 'provider_processing' : remote.status;
          current.providerState = remote.providerState;
          current.message = remote.message; current.resultUrls = remote.resultUrls;
          if (remote.progress !== null) current.progress = remote.progress;
          if (remote.status === 'failed') {
            current.errorCode = remote.errorCode || 'PROVIDER_FAILED';
            current.error = remote.message || '视频供应商任务失败。';
          }
          if (remote.status === 'succeeded') { current.progress = 100; current.finishedAt = nowFrom(env); }
          if (remote.status === 'failed' || remote.status === 'cancelled') current.finishedAt = nowFrom(env);
          return current;
        });
        return { task: C.publicTask(updated), idempotent: false };
      })();
      pollInflight.set(key, promise);
      try { return await promise; } finally { pollInflight.delete(key); }
    }
    async function cancel(message, sender) {
      var accountKey = await resolveAccount(sender); var requestedTaskId = text(message.taskId, 240);
      var key = accountKey + ':' + requestedTaskId;
      if (cancelInflight.has(key)) return cancelInflight.get(key);
      var promise = (async function () {
        var task = await readTask(accountKey, requestedTaskId);
        if (C.isTerminal(task.status)) return { task: C.publicTask(task), idempotent: true };
        if (!task.providerTaskId) {
          if (task.status === 'queued') {
            var local = await mutateTask(accountKey, requestedTaskId, function (current) {
              current = C.transitionTask(current, 'cancelled', { now: nowFrom(env) });
              current.generation += 1; current.cancelledAt = nowFrom(env); return current;
            });
            return { task: C.publicTask(local), idempotent: false };
          }
          throw error('CANCEL_PENDING_CREATE', '供应商任务 ID 尚未返回，暂时不能安全取消。');
        }
        var config = await getConfigFor(accountKey);
        var cancelStates = config.adapter === 'ark' ? ['queued'] : [];
        if (cancelStates.indexOf(text(task.providerState, 80).toLowerCase()) < 0) {
          throw error('CANCEL_STATE_UNSUPPORTED', '当前供应商仅允许取消 queued 状态任务；运行中的任务不能伪装为已取消。', {
            providerState: text(task.providerState, 80), cancelStates: cancelStates
          });
        }
        var creds = await credentials(accountKey, config.provider);
        await adapterCancel(config, creds, task);
        var cancelled = await mutateTask(accountKey, requestedTaskId, function (current) {
          if (C.isTerminal(current.status)) return current;
          current = C.transitionTask(current, 'cancelled', { now: nowFrom(env) });
          current.generation += 1; current.cancelledAt = nowFrom(env); current.phase = 'cancelled'; return current;
        });
        return { task: C.publicTask(cancelled), idempotent: false };
      })();
      cancelInflight.set(key, promise);
      try { return await promise; } finally { cancelInflight.delete(key); }
    }
    async function retry(message, sender) {
      var accountKey = await resolveAccount(sender); var idemKey = requireIdempotencyKey(message);
      var old = await readTask(accountKey, text(message.taskId, 240));
      if (old.status !== 'failed' && old.status !== 'cancelled') throw error('RETRY_NOT_ALLOWED', '只有 failed/cancelled 任务可重试。');
      return start({ request: old._request, idempotencyKey: idemKey }, sender);
    }
    async function analyze(message, sender) {
      var requestBody = message.request || (plain(message.payload) && !message.payload.schemaVersion ? message.payload : message);
      var accountKey = await resolveAccount(sender); var request = C.normalizeRequest(requestBody, { stage: 'draft' });
      if (request.mode === 'direct') throw error('ANALYSIS_NOT_REQUIRED', 'direct 模式不需要分析阶段。');
      var analyzer = env.analyzer;
      var result;
      if (typeof analyzer === 'function') result = await analyzer(request, { accountKey: accountKey });
      else if (analyzer && typeof analyzer.analyze === 'function') result = await analyzer.analyze(request, { accountKey: accountKey });
      else result = await defaultAnalyze(request, accountKey, (await getConfigFor(accountKey)).provider);
      return { mode: request.mode, status: 'needs_confirmation', analysis: result };
    }
    async function capabilities(sender) {
      var accountKey = await resolveAccount(sender); var config = await getConfigFor(accountKey);
      var credentialAvailable = false;
      var credentialStatus = { state: 'unavailable', code: 'CREDENTIAL_CHECK_UNAVAILABLE', message: '暂时无法验证当前账号的 API 配置。' };
      try {
        await credentials(accountKey, config.provider);
        credentialAvailable = true;
        credentialStatus = {
          state: 'ready',
          code: 'READY',
          message: '已读取当前账号的豆包 / 火山方舟 API 配置；Seedance 模型权限将在提交时由供应商验证。'
        };
      } catch (cause) {
        var code = text(cause && cause.code, 100).toLowerCase();
        if (/config_not_found|credentials_unavailable|missing_api_key|credential_missing/.test(code)) {
          credentialStatus = { state: 'missing', code: 'CREDENTIALS_MISSING', message: '当前账号尚未配置该视频供应商的 API Key。' };
        } else if (/account_changed/.test(code)) {
          credentialStatus = { state: 'account_changed', code: 'ACCOUNT_CHANGED', message: '账号已变更，请重新确认 API 配置。' };
        }
      }
      return {
        contractVersion: C.CONTRACT_VERSION, accountKey: accountKey,
        modes: clone(C.MODES), audioModes: clone(C.AUDIO_MODES),
        creativeRoutes: clone(C.CREATIVE_ROUTES), styleProfiles: clone(C.STYLE_PROFILES),
        resolutions: clone(C.RESOLUTIONS), ratios: clone(C.RATIOS), adapters: clone(C.ADAPTERS),
        modelCapabilities: clone(C.MODEL_CAPABILITIES),
        provider: config.provider, adapter: config.adapter,
        credentialAvailable: credentialAvailable,
        credentialStatus: credentialStatus,
        models: C.modelCatalog(config.providerModels, { credentialAvailable: credentialAvailable }),
        capabilities: {
          remoteAssets: true,
          localAssets: config.adapter === 'generic-multipart' ? ['image', 'video', 'audio'] : ['image-data-url', 'audio-data-url'],
          analysisOnlyReferenceVideo: true,
          soundOnlyVoiceSuppression: 'prompt_soft_constraint',
          arkLimits: config.adapter === 'ark' ? clone(ARK_LIMITS) : null,
          cancelStates: config.adapter === 'ark' && config.cancelEndpoint ? ['queued'] : [],
          cancel: config.adapter === 'ark' && !!config.cancelEndpoint
        }
      };
    }
    async function result(message, sender) {
      var accountKey = await resolveAccount(sender); var task = await readTask(accountKey, text(message.taskId, 240));
      if (task.status !== 'succeeded') throw error('RESULT_NOT_READY', '视频任务尚未成功完成。', { status: task.status });
      return { task: C.publicTask(task), resultUrls: clone(task.resultUrls || []) };
    }
    async function handleMessage(message, sender) {
      message = unpackMessage(message);
      var requestId = message.requestId || ('legacy_' + id());
      try {
        var data;
        if (message.type === MESSAGE_TYPES.CAPABILITIES) data = await capabilities(sender);
        else if (message.type === MESSAGE_TYPES.CONFIG_GET) data = { config: publicConfig(await getConfigFor(await resolveAccount(sender))) };
        else if (message.type === MESSAGE_TYPES.CONFIG_SAVE) data = { config: await saveConfigFor(await resolveAccount(sender), message.config || {}) };
        else if (message.type === MESSAGE_TYPES.ANALYZE) data = await analyze(message, sender);
        else if (message.type === MESSAGE_TYPES.START) data = await start(message, sender);
        else if (message.type === MESSAGE_TYPES.STATUS) data = await status(message, sender);
        else if (message.type === MESSAGE_TYPES.CANCEL) data = await cancel(message, sender);
        else if (message.type === MESSAGE_TYPES.RETRY) data = await retry(message, sender);
        else if (message.type === MESSAGE_TYPES.RESULT) data = await result(message, sender);
        else throw error('MESSAGE_UNSUPPORTED', '不支持的视频工作台消息。');
        return { ok: true, type: message.type, payload: Object.assign({ schemaVersion: 1, requestId: requestId }, data || {}) };
      } catch (cause) { return responseError(cause, message.type, requestId); }
    }
    return Object.freeze({
      handleMessage: handleMessage, start: start, status: status, cancel: cancel, retry: retry,
      analyze: analyze, capabilities: capabilities, getConfigFor: getConfigFor, saveConfigFor: saveConfigFor,
      _readTask: readTask
    });
  }
  function install(chromeObject, options) {
    if (!chromeObject || !chromeObject.runtime || !chromeObject.runtime.onMessage) return null;
    var controller = createController(Object.assign({}, options || {}, { chrome: chromeObject }));
    chromeObject.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || KNOWN_MESSAGES.indexOf(message.type) < 0) return false;
      controller.handleMessage(message, sender).then(sendResponse, function (cause) {
        var unpacked = unpackMessage(message);
        sendResponse(responseError(cause, message.type, unpacked.requestId));
      });
      return true;
    });
    return controller;
  }
  return Object.freeze({
    MESSAGE_TYPES: MESSAGE_TYPES, CONFIG_KEY: CONFIG_KEY, TASK_KEY: TASK_KEY,
    ARK_LIMITS: ARK_LIMITS, REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS,
    DEFAULT_CONFIG: DEFAULT_CONFIG, sanitizeConfig: sanitizeConfig, publicConfig: publicConfig,
    arkBody: arkBody, canonicalProviderStatus: canonicalProviderStatus, collectResultUrls: collectResultUrls,
    createController: createController, install: install
  });
});
