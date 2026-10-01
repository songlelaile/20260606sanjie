/* 生成视频合同 V2：保持 V1 线协议兼容，跨 popup / workbench / service worker 共享纯数据边界。 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SZEcommerceVideoContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CONTRACT_VERSION = 'ECOMMERCE_VIDEO_STUDIO_V1';
  var TASK_SCHEMA_VERSION = 1;
  var ASSET_DB_NAME = 'sz_ecommerce_video_studio';
  var ASSET_STORE_NAME = 'assets';

  function freeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.keys(value).forEach(function (key) { freeze(value[key]); });
    return Object.freeze(value);
  }

  var MODES = freeze({
    direct: {
      id: 'direct', label: '脚本直出', legacyAliases: ['omni'],
      requiresAnalysis: false, requiresConfirmation: false,
      imageMin: 0, imageMax: 30, videoMin: 0, videoMax: 10, audioMax: 10
    },
    assist: {
      id: 'assist', label: '脚本帮写', legacyAliases: ['storyboard'],
      requiresAnalysis: true, requiresConfirmation: true,
      imageMin: 0, imageMax: 30, videoMin: 0, videoMax: 10, audioMax: 10
    },
    remix: {
      id: 'remix', label: '爆款复刻', legacyAliases: ['remake'],
      requiresAnalysis: true, requiresConfirmation: true,
      imageMin: 1, imageMax: 30, videoMin: 0, videoMax: 0, audioMax: 3,
      referenceFrameMin: 1, referenceFrameMax: 6
    }
  });
  var MODE_ALIASES = freeze({
    direct: 'direct', omni: 'direct', script: 'direct',
    assist: 'assist', storyboard: 'assist', assisted: 'assist',
    remix: 'remix', remake: 'remix', replicate: 'remix'
  });

  var AUDIO_MODES = freeze({
    silent: { id: 'silent', label: '无声音', generateSound: false, narration: false },
    sound_only: { id: 'sound_only', label: '生成声音 · 无口播', generateSound: true, narration: false },
    narration: { id: 'narration', label: '生成声音 · 有口播', generateSound: true, narration: true }
  });
  var AUDIO_ALIASES = freeze({
    silent: 'silent', mute: 'silent', muted: 'silent', no_audio: 'silent',
    sound_only: 'sound_only', sound: 'sound_only', audio: 'sound_only',
    narration: 'narration', voiceover: 'narration', voice_over: 'narration'
  });

  // 产品键/显示名与供应商模型 ID 有意拆成两张表。UI 名称永远不能进入 model 字段。
  var MODEL_DISPLAY_NAMES = freeze({
    'seedance-2.0': 'Seedance 2.0',
    'seedance-2.5': 'Seedance 2.5'
  });
  var DEFAULT_PROVIDER_MODELS = freeze({
    'seedance-2.0': 'doubao-seedance-2-0-260128',
    'seedance-2.5': 'doubao-seedance-2-5-260628'
  });
  var MODEL_ALIASES = freeze({
    'seedance-2.0': 'seedance-2.0', 'seedance_2_0': 'seedance-2.0', '2.0': 'seedance-2.0',
    'seedance-2.5': 'seedance-2.5', 'seedance_2_5': 'seedance-2.5', '2.5': 'seedance-2.5'
  });

  var RESOLUTIONS = freeze(['480p', '720p', '1080p', '4k']);
  var RATIOS = freeze(['9:16', '16:9', '1:1', '3:4', '4:3', '21:9', 'adaptive']);
  var ASSET_ROLES = freeze(['product', 'person', 'scene', 'style', 'motion', 'rhythm', 'asset']);
  var ASSET_ROLE_LABELS = freeze({
    product: '目标商品', person: '人物主体', scene: '场景', style: '视觉风格',
    motion: '动作/运镜', rhythm: '节奏/声音', asset: '通用素材'
  });
  var CREATIVE_ROUTES = freeze({
    free_direct: {
      id: 'free_direct', label: '自由直出', description: '纯文本或多模态自由生成，严格执行用户脚本。',
      supportedModes: ['direct', 'assist'],
      promptInstruction: '以用户脚本为最高优先级组织主体、动作、场景和镜头；无参考素材时不虚构具体商品事实，有参考素材时只按明确角色使用。'
    },
    hero_product: {
      id: 'hero_product', label: '商品主角', description: '围绕一件目标商品完成稳定、清晰的商业展示。',
      supportedModes: ['direct', 'assist'],
      promptInstruction: '目标商品始终是画面主角；保持外形、比例、包装版式、颜色、材质、Logo 与可见文字稳定，镜头运动服务于卖点展示。'
    },
    elements_compose: {
      id: 'elements_compose', label: '多元素编排', description: '把商品、人物、场景或风格素材按角色组合。',
      supportedModes: ['direct', 'assist'],
      promptInstruction: '逐一遵守每个素材的角色绑定，明确元素的空间关系与出场顺序；禁止把不同主体错误融合、换脸、串色或互换身份。'
    },
    storyboard_direct: {
      id: 'storyboard_direct', label: '分镜叙事', description: '按时间轴组织连续镜头、动作和节奏。',
      supportedModes: ['direct', 'assist'],
      promptInstruction: '按时间顺序规划镜头，每镜只承担一个清晰叙事目标；保持主体、方向、空间和动作连续，以已确认分镜时长作为编排目标。'
    },
    reference_rebuild: {
      id: 'reference_rebuild', label: '参考重构', description: '用获授权参考的关键帧重构静态视觉结构与镜头顺序。',
      supportedModes: ['remix'],
      promptInstruction: '参考内容仅通过按时间排序的关键帧提供静态视觉结构、构图与镜头顺序线索；运镜、连续动作和声音必须围绕目标商品重新设计，不得声称从关键帧提取；必须替换第三方品牌、人物身份、原文案和商品事实。'
    },
    audio_visual: {
      id: 'audio_visual', label: '音画共创', description: '以音乐、音效或口播节奏驱动画面变化。',
      supportedModes: ['direct', 'assist'],
      promptInstruction: '按音频节拍、重音与语义安排动作和转场；不得承诺逐帧精确口型。无口播仅作为提示词软约束，不宣称绝对无人声。'
    }
  });
  var STYLE_PROFILES = freeze({
    commerce_studio: {
      id: 'commerce_studio', label: '商业棚拍', description: '干净布光、清晰材质与转化导向的商品画面。',
      promptInstruction: '使用克制的商业棚拍布光、干净背景和可读细节，优先呈现商品质感与卖点，不堆叠无关装饰。'
    },
    lifestyle_social: {
      id: 'lifestyle_social', label: '生活方式', description: '自然生活场景中的社交媒体原生表达。',
      promptInstruction: '使用可信的日常场景、自然光与轻量手持感，让商品真实融入使用情境，避免过度广告腔。'
    },
    ugc_mobile: {
      id: 'ugc_mobile', label: 'UGC 手机感', description: '近距离、自然、未经重度包装的移动端内容。',
      promptInstruction: '采用手机竖屏原生质感、近距离构图和轻微自然手持，保留真实生活细节，同时保证主体清楚稳定。'
    },
    cinematic_brand: {
      id: 'cinematic_brand', label: '电影品牌片', description: '克制运镜、戏剧光影与品牌氛围。',
      promptInstruction: '采用电影化光影、明确景深与有动机的镜头运动，建立品牌氛围但不牺牲商品可辨识度。'
    },
    viral_fastcut: {
      id: 'viral_fastcut', label: '爆款快切', description: '首镜钩子、快速信息节奏与动作匹配转场。',
      promptInstruction: '首镜建立强钩子，以清晰重音组织快切和动作匹配转场；每镜只突出一个信息点，避免拥挤和无意义闪切。'
    },
    animation_ip: {
      id: 'animation_ip', label: '动画 IP', description: '风格化动画并保持角色与商品特征一致。',
      promptInstruction: '采用统一动画语言，保持角色轮廓、服饰、商品结构和主色稳定；动作需可读，避免形体漂移和额外肢体。'
    },
    mixed_motion: {
      id: 'mixed_motion', label: '实拍动效融合', description: '实拍主体与图形、文字感动效的分层融合。',
      promptInstruction: '保持实拍主体与动效层级清楚，让图形运动响应动作和节奏；动效不得遮挡、改写或扭曲商品关键特征。'
    },
    surreal_vfx: {
      id: 'surreal_vfx', label: '超现实特效', description: '用不可能转场和视觉奇观强化记忆点。',
      promptInstruction: '使用有因果的超现实变化与视觉特效制造记忆点，但目标商品核心结构、品牌信息和材质必须真实稳定。'
    }
  });
  var MODEL_CAPABILITIES = freeze({
    'seedance-2.0': {
      productKey: 'seedance-2.0', providerModel: 'doubao-seedance-2-0-260128',
      minDuration: 4, maxDuration: 15, resolutions: ['480p', '720p', '1080p', '4k'],
      ratios: ['9:16', '16:9', '1:1', '3:4', '4:3', '21:9', 'adaptive'],
      imageMax: 9, videoMax: 3, audioMax: 3, maxAssets: 15,
      maxVideoDuration: 15, maxAudioDuration: 15
    },
    'seedance-2.5': {
      productKey: 'seedance-2.5', providerModel: 'doubao-seedance-2-5-260628',
      minDuration: 4, maxDuration: 30, resolutions: ['480p', '720p', '1080p'],
      ratios: ['9:16', '16:9', '1:1', '3:4', '4:3', '21:9', 'adaptive'],
      imageMax: 30, videoMax: 10, audioMax: 10, maxAssets: 50,
      maxVideoDuration: 30, maxAudioDuration: 30
    }
  });
  var ADAPTERS = freeze(['ark', 'generic-multipart']);
  var TASK_STATES = freeze([
    'draft', 'analyzing', 'needs_confirmation', 'queued', 'submitting', 'processing',
    'succeeded', 'failed', 'cancelled'
  ]);
  var TERMINAL_STATES = freeze(['succeeded', 'failed', 'cancelled']);
  var TRANSITIONS = freeze({
    draft: ['analyzing', 'queued', 'cancelled'],
    analyzing: ['needs_confirmation', 'failed', 'cancelled'],
    needs_confirmation: ['analyzing', 'queued', 'cancelled'],
    queued: ['submitting', 'failed', 'cancelled'],
    submitting: ['processing', 'succeeded', 'failed', 'cancelled'],
    processing: ['succeeded', 'failed', 'cancelled'],
    succeeded: [],
    failed: ['queued'],
    cancelled: ['queued']
  });

  function contractError(code, message, details) {
    var error = new Error(message || code || '视频合同校验失败');
    error.name = 'VideoStudioContractError';
    error.code = code || 'CONTRACT_INVALID';
    if (details !== undefined) error.details = details;
    return error;
  }

  function text(value, max) {
    var output = String(value == null ? '' : value).trim();
    return max ? output.slice(0, max) : output;
  }

  function plainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function safeInteger(value, min, max, fallback) {
    var number = Number(value);
    return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
  }

  function normalizeMode(value) {
    var key = text(value, 40).toLowerCase().replace(/\s+/g, '_');
    return MODE_ALIASES[key] || '';
  }

  function normalizeModelKey(value) {
    var key = text(value, 80).toLowerCase().replace(/\s+/g, '_');
    return MODEL_ALIASES[key] || '';
  }

  function normalizeCreativeRoute(value, mode) {
    var key = text(value, 80).toLowerCase().replace(/[\s-]+/g, '_');
    if (!key) key = mode === 'remix' ? 'reference_rebuild' : 'hero_product';
    if (!CREATIVE_ROUTES[key]) throw contractError('CREATIVE_ROUTE_INVALID', '不支持的生成视频创意路线。');
    return key;
  }

  function normalizeStyleProfile(value) {
    var key = text(value, 80).toLowerCase().replace(/[\s-]+/g, '_') || 'commerce_studio';
    if (!STYLE_PROFILES[key]) throw contractError('STYLE_PROFILE_INVALID', '不支持的生成视频风格路线。');
    return key;
  }

  function effectiveLimits(mode, productKey) {
    mode = normalizeMode(mode);
    productKey = normalizeModelKey(productKey);
    if (!mode) throw contractError('MODE_INVALID', '视频模式必须是 direct、assist 或 remix。');
    var capability = MODEL_CAPABILITIES[productKey];
    if (!capability) throw contractError('MODEL_UNKNOWN', '请选择 Seedance 产品模型。');
    return freeze({
      imageMin: mode === 'remix' ? 1 : 0,
      imageMax: capability.imageMax,
      videoMin: 0,
      videoMax: mode === 'remix' ? 0 : capability.videoMax,
      audioMin: 0,
      audioMax: mode === 'remix' ? Math.min(3, capability.audioMax) : capability.audioMax,
      maxAssets: capability.maxAssets,
      maxVideoDuration: capability.maxVideoDuration,
      maxAudioDuration: capability.maxAudioDuration,
      minDuration: capability.minDuration,
      maxDuration: capability.maxDuration,
      resolutions: capability.resolutions.slice(),
      ratios: capability.ratios.slice()
    });
  }

  function normalizeAdapter(value) {
    value = text(value, 80).toLowerCase();
    return ADAPTERS.indexOf(value) >= 0 ? value : '';
  }

  function validProviderModel(value) {
    value = text(value, 220);
    return !value || /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,219}$/.test(value);
  }

  function providerModelMap(raw) {
    raw = plainObject(raw) ? raw : {};
    var output = {};
    Object.keys(MODEL_DISPLAY_NAMES).forEach(function (productKey) {
      var candidate = Object.prototype.hasOwnProperty.call(raw, productKey)
        ? text(raw[productKey], 220)
        : DEFAULT_PROVIDER_MODELS[productKey];
      output[productKey] = validProviderModel(candidate) ? candidate : '';
    });
    return output;
  }

  function modelCatalog(rawMappings, options) {
    var mappings = providerModelMap(rawMappings);
    options = plainObject(options) ? options : {};
    var credentialKnown = Object.prototype.hasOwnProperty.call(options, 'credentialAvailable');
    var credentialAvailable = options.credentialAvailable === true;
    return Object.keys(MODEL_DISPLAY_NAMES).map(function (productKey) {
      var mappingConfigured = !!mappings[productKey];
      var ready = mappingConfigured && (!credentialKnown || credentialAvailable);
      return freeze({
        productKey: productKey,
        displayName: MODEL_DISPLAY_NAMES[productKey],
        providerModel: mappings[productKey],
        providerModelConfigured: mappingConfigured,
        credentialAvailable: credentialKnown ? credentialAvailable : null,
        configured: ready,
        available: ready,
        limits: MODEL_CAPABILITIES[productKey]
      });
    });
  }

  function resolveModel(productKey, rawMappings) {
    productKey = normalizeModelKey(productKey);
    if (!productKey) throw contractError('MODEL_UNKNOWN', '不支持的视频模型产品键。');
    if (plainObject(rawMappings) && Object.prototype.hasOwnProperty.call(rawMappings, productKey)) {
      var explicit = text(rawMappings[productKey], 220);
      if (explicit && (explicit === MODEL_DISPLAY_NAMES[productKey] || !validProviderModel(explicit))) {
        throw contractError('PROVIDER_MODEL_INVALID', '供应商模型 ID 无效；显示名不能作为 providerModel。');
      }
    }
    var mappings = providerModelMap(rawMappings);
    var providerModel = mappings[productKey];
    if (!providerModel) {
      throw contractError('MODEL_UNAVAILABLE', MODEL_DISPLAY_NAMES[productKey] + ' 尚未配置可信供应商模型 ID，禁止提交或静默降级。', {
        productKey: productKey
      });
    }
    if (providerModel === MODEL_DISPLAY_NAMES[productKey] || !validProviderModel(providerModel)) {
      throw contractError('PROVIDER_MODEL_INVALID', '供应商模型 ID 无效；显示名不能作为 providerModel。');
    }
    return freeze({
      productKey: productKey,
      displayName: MODEL_DISPLAY_NAMES[productKey],
      providerModel: providerModel
    });
  }

  function boolField(raw, names) {
    for (var i = 0; i < names.length; i++) {
      if (Object.prototype.hasOwnProperty.call(raw, names[i])) return { present: true, value: raw[names[i]] === true };
    }
    return { present: false, value: false };
  }

  function normalizeAudioState(raw) {
    raw = typeof raw === 'string' ? { audioMode: raw } : (plainObject(raw) ? raw : {});
    var explicit = text(raw.audioMode || raw.mode, 40).toLowerCase().replace(/[\s-]+/g, '_');
    var mode = AUDIO_ALIASES[explicit] || '';
    var sound = boolField(raw, ['generateSound', 'generateAudio', 'withAudio', 'sound']);
    var narration = boolField(raw, ['narration', 'hasNarration', 'narrationEnabled', 'withNarration']);

    if (explicit && !mode) throw contractError('AUDIO_MODE_INVALID', '声音模式必须是 silent、sound_only 或 narration。');
    if (!mode && (sound.present || narration.present)) {
      if (narration.value && sound.present && !sound.value) {
        throw contractError('AUDIO_STATE_INVALID', '“无声音 + 有口播”是非法声音状态。');
      }
      mode = narration.value ? 'narration' : (sound.value ? 'sound_only' : 'silent');
    }
    if (!mode) mode = 'silent';

    var canonical = AUDIO_MODES[mode];
    if (sound.present && sound.value !== canonical.generateSound) {
      throw contractError('AUDIO_STATE_CONFLICT', 'audioMode 与生成声音开关冲突。');
    }
    if (narration.present && narration.value !== canonical.narration) {
      throw contractError('AUDIO_STATE_CONFLICT', 'audioMode 与口播开关冲突。');
    }
    var language = text(raw.narrationLanguage || raw.language, 40);
    if (mode === 'narration' && !language) {
      throw contractError('NARRATION_LANGUAGE_REQUIRED', '口播模式必须指定语言。');
    }
    if (mode !== 'narration') language = '';
    return freeze({
      audioMode: mode,
      generateSound: canonical.generateSound,
      narration: canonical.narration,
      narrationLanguage: language
    });
  }

  function normalizeStorageRef(raw) {
    if (!plainObject(raw)) return null;
    var value = {
      dbName: text(raw.dbName, 100),
      storeName: text(raw.storeName, 100),
      id: text(raw.id, 260)
    };
    if (value.dbName !== ASSET_DB_NAME || value.storeName !== ASSET_STORE_NAME || !value.id) {
      throw contractError('ASSET_REFERENCE_INVALID', '本地素材引用必须指向视频工作台 assets store。');
    }
    return freeze(value);
  }

  function validRemoteAssetUrl(value) {
    value = text(value, 4096);
    if (!value) return '';
    try {
      var parsed = new URL(value);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'asset:') return '';
      if (parsed.username || parsed.password) return '';
      return parsed.href;
    } catch (_) { return ''; }
  }

  function normalizeAsset(raw, kind, index) {
    if (!plainObject(raw)) throw contractError('ASSET_INVALID', '素材必须是普通对象。', { kind: kind, index: index });
    if (raw.selected === false) return null;
    if (raw.blob || raw.file || (typeof Blob !== 'undefined' && raw instanceof Blob)) {
      throw contractError('ASSET_INLINE_BINARY_FORBIDDEN', '任务消息不得内嵌 File/Blob，请使用 storageRef。');
    }
    var remoteCandidate = raw.remoteUrl || raw.url || raw.assetUrl || '';
    var remoteUrl = validRemoteAssetUrl(remoteCandidate);
    if (remoteCandidate && !remoteUrl) {
      throw contractError('ASSET_REMOTE_URL_INVALID', '远程素材只允许无凭据的 https:// 或 asset:// URL。', { kind: kind, index: index });
    }
    var storageRef = raw.storageRef ? normalizeStorageRef(raw.storageRef) : null;
    if (remoteUrl && storageRef) {
      throw contractError('ASSET_REFERENCE_AMBIGUOUS', '单个素材不能同时声明 remoteUrl 与 storageRef。', { kind: kind, index: index });
    }
    if (!remoteUrl && !storageRef) {
      throw contractError('ASSET_REFERENCE_REQUIRED', '素材缺少 remoteUrl 或合法 storageRef。', { kind: kind, index: index });
    }
    var duration = raw.durationSeconds == null ? 0 : Number(raw.durationSeconds);
    if (duration && (!Number.isFinite(duration) || duration <= 0 || duration > 3600)) {
      throw contractError('ASSET_DURATION_INVALID', '素材时长无效。', { kind: kind, index: index });
    }
    var defaultRole = kind === 'image' ? 'product'
      : (kind === 'audio' ? 'rhythm' : ((kind === 'video' || kind === 'reference_video' || kind === 'reference_frame') ? 'motion' : 'asset'));
    var role = text(raw.role || raw.assetRole, 40).toLowerCase().replace(/[\s-]+/g, '_') || defaultRole;
    if (ASSET_ROLES.indexOf(role) < 0) {
      throw contractError('ASSET_ROLE_INVALID', '素材角色必须是 product、person、scene、style、motion、rhythm 或 asset。', {
        kind: kind, index: index, role: role
      });
    }
    return freeze({
      id: text(raw.id || (storageRef && storageRef.id) || (kind + '_' + (index + 1)), 260),
      kind: kind,
      name: text(raw.name || raw.fileName, 260),
      mimeType: text(raw.mimeType || raw.type, 120).toLowerCase(),
      size: Math.max(0, safeInteger(raw.size, 0, Number.MAX_SAFE_INTEGER, 0)),
      durationSeconds: duration || 0,
      role: role,
      rightsConfirmed: raw.rightsConfirmed === true || raw.authorized === true,
      remoteUrl: remoteUrl,
      storageRef: storageRef
    });
  }

  function normalizeAssets(values, kind) {
    if (values == null) return [];
    if (!Array.isArray(values)) throw contractError('ASSET_LIST_INVALID', kind + ' 素材必须是数组。');
    return values.map(function (item, index) { return normalizeAsset(item, kind, index); }).filter(Boolean);
  }

  function assetIdentity(raw, kind, index) {
    if (!plainObject(raw) || raw.selected === false) return null;
    var storageRef = plainObject(raw.storageRef) ? {
      dbName: text(raw.storageRef.dbName, 100),
      storeName: text(raw.storageRef.storeName, 100),
      id: text(raw.storageRef.id, 260)
    } : null;
    var remoteUrl = validRemoteAssetUrl(raw.remoteUrl || raw.url || raw.assetUrl || '');
    var defaultRole = kind === 'image' ? 'product'
      : (kind === 'audio' ? 'rhythm' : ((kind === 'video' || kind === 'reference_video' || kind === 'reference_frame') ? 'motion' : 'asset'));
    var role = text(raw.role || raw.assetRole, 40).toLowerCase().replace(/[\s-]+/g, '_') || defaultRole;
    return {
      slot: kind + '_' + (index + 1),
      kind: kind,
      id: text(raw.id || (storageRef && storageRef.id) || (kind + '_' + (index + 1)), 260),
      role: role,
      source: remoteUrl ? { remoteUrl: remoteUrl } : { storageRef: storageRef },
      durationSeconds: Number(raw.durationSeconds || 0) || 0
    };
  }

  function assetRightsManifest(request) {
    request = plainObject(request) ? request : {};
    var mode = normalizeMode(request.mode);
    function list(values, kind) {
      return (Array.isArray(values) ? values : []).map(function (item, index) {
        return assetIdentity(item, kind, index);
      }).filter(Boolean);
    }
    var referenceVideo = request.referenceVideo ? assetIdentity(request.referenceVideo, 'reference_video', 0) : null;
    var legacyReference = !referenceVideo && mode === 'remix' && Array.isArray(request.referenceVideos) && request.referenceVideos.length
      ? assetIdentity(request.referenceVideos[0], 'reference_video', 0)
      : null;
    var generationVideos = request.videos || request.generationVideos || (mode === 'remix' ? [] : request.referenceVideos);
    return {
      images: list(request.images || request.productImages, 'image'),
      videos: list(generationVideos, 'video'),
      audios: list(request.audios || request.referenceAudios, 'audio'),
      referenceVideo: referenceVideo || legacyReference,
      referenceFrames: list(request.referenceFrames, 'reference_frame')
    };
  }

  function assetRightsFingerprint(request) {
    request = plainObject(request) ? request : {};
    var manifest = assetRightsManifest(request);
    function ids(values) { return values.map(function (item) { return item.id; }).sort(); }
    return fingerprint({
      mode: normalizeMode(request.mode),
      images: ids(manifest.images),
      videos: ids(manifest.videos),
      audios: ids(manifest.audios),
      reference: manifest.referenceVideo ? manifest.referenceVideo.id : '',
      referenceFrames: ids(manifest.referenceFrames)
    }, 'rights_');
  }

  function assetCountFromManifest(manifest) {
    return manifest.images.length + manifest.videos.length + manifest.audios.length
      + (manifest.referenceVideo ? 1 : 0) + manifest.referenceFrames.length;
  }

  function validateCount(name, values, min, max) {
    if (values.length < min || values.length > max) {
      throw contractError('ASSET_COUNT_INVALID', name + '素材数量必须为 ' + min + '–' + max + '。', {
        field: name, count: values.length, min: min, max: max
      });
    }
  }

  function decimal(value, field, index) {
    var number = Number(value);
    if (!Number.isFinite(number)) throw contractError('STORYBOARD_TIME_INVALID', '分镜时间字段无效。', { field: field, index: index });
    return Math.round(number * 1000) / 1000;
  }

  function normalizeStoryboard(raw, options) {
    options = options || {};
    if (raw == null) return [];
    if (!Array.isArray(raw)) throw contractError('STORYBOARD_INVALID', 'storyboard 必须是数组。');
    if (raw.length > 30) throw contractError('STORYBOARD_COUNT_INVALID', '分镜数量不能超过 30。');
    var requestedMaxShotDuration = Number(options.maxShotDuration);
    var inferredDuration = Number(options.durationSeconds);
    var maxShotDuration = Number.isFinite(requestedMaxShotDuration) && requestedMaxShotDuration > 0
      ? requestedMaxShotDuration
      : (Number.isFinite(inferredDuration) && inferredDuration > 15 ? 30 : 15);
    var cursor = 0;
    var shots = raw.map(function (item, index) {
      if (!plainObject(item)) throw contractError('STORYBOARD_SHOT_INVALID', '每个分镜必须是普通对象。', { index: index });
      var order = item.order == null ? index + 1 : safeInteger(item.order, 1, 30, 0);
      if (order !== index + 1) throw contractError('STORYBOARD_ORDER_INVALID', '分镜 order 必须从 1 开始连续递增。', { index: index, order: order });
      var duration = decimal(item.durationSeconds == null ? item.duration : item.durationSeconds, 'durationSeconds', index);
      if (duration <= 0 || duration > maxShotDuration) {
        throw contractError('STORYBOARD_DURATION_INVALID', '单个分镜时长必须大于 0 且不超过 ' + maxShotDuration + ' 秒。', { index: index });
      }
      var start = item.startSecond == null ? cursor : decimal(item.startSecond, 'startSecond', index);
      var end = item.endSecond == null ? start + duration : decimal(item.endSecond, 'endSecond', index);
      if (Math.abs(start - cursor) > 0.01 || Math.abs(end - (start + duration)) > 0.01) {
        throw contractError('STORYBOARD_TIMELINE_INVALID', '分镜时间轴必须无重叠、无空洞且与 durationSeconds 一致。', {
          index: index, expectedStart: cursor, startSecond: start, endSecond: end, durationSeconds: duration
        });
      }
      start = Math.round(cursor * 1000) / 1000;
      end = Math.round((start + duration) * 1000) / 1000;
      cursor = end;
      var visual = text(item.visual || item.visualDescription || item.scene, 4000);
      if (!visual) throw contractError('STORYBOARD_VISUAL_REQUIRED', '每个分镜都必须有画面描述。', { index: index });
      return freeze({
        id: text(item.id || item.shotId || ('shot-' + (index + 1)), 160),
        order: order,
        startSecond: start,
        endSecond: end,
        durationSeconds: duration,
        visual: visual,
        narration: text(item.narration || item.voiceover || item.voiceOver, 3000),
        composition: text(item.composition, 1200),
        camera: text(item.camera, 1200),
        motion: text(item.motion, 1200),
        rhythm: text(item.rhythm, 1200),
        audioRole: text(item.audioRole, 1200),
        reconstructionIntent: text(item.reconstructionIntent, 2000)
      });
    });
    var expectedDuration = inferredDuration;
    if (shots.length && Number.isFinite(expectedDuration) && Math.abs(cursor - expectedDuration) > 0.01) {
      throw contractError('STORYBOARD_TOTAL_DURATION_INVALID', '分镜总时长必须与视频设置时长完全一致。', {
        storyboardDurationSeconds: cursor, durationSeconds: expectedDuration
      });
    }
    return shots;
  }

  function normalizedReviewFingerprint(script, storyboard) {
    return fingerprint({ script: text(script, 30000), storyboard: storyboard || [] }, 'review_');
  }

  function normalizeRequest(raw, options) {
    raw = plainObject(raw) ? raw : {};
    options = options || {};
    var stage = options.stage || 'draft';
    var mode = normalizeMode(raw.mode);
    if (!mode) throw contractError('MODE_INVALID', '视频模式必须是 direct、assist 或 remix。');
    var definition = MODES[mode];
    var creativeRoute = normalizeCreativeRoute(raw.creativeRoute || raw.route, mode);
    var routeDefinition = CREATIVE_ROUTES[creativeRoute];
    if (routeDefinition.supportedModes.indexOf(mode) < 0) {
      throw contractError('CREATIVE_ROUTE_MODE_INVALID', routeDefinition.label + ' 不支持当前生成模式。', {
        creativeRoute: creativeRoute, mode: mode, supportedModes: routeDefinition.supportedModes
      });
    }
    var styleProfile = normalizeStyleProfile(raw.styleProfile || raw.visualStyle);
    var images = normalizeAssets(raw.images || raw.productImages, 'image');
    var generationVideos = raw.videos || raw.generationVideos || (mode === 'remix' ? [] : raw.referenceVideos);
    var videos = normalizeAssets(generationVideos, 'video');
    var audios = normalizeAssets(raw.audios || raw.referenceAudios, 'audio');
    var legacyReferenceVideos = mode === 'remix' && Array.isArray(raw.referenceVideos) ? raw.referenceVideos : [];
    if (legacyReferenceVideos.length > 1) throw contractError('REFERENCE_VIDEO_COUNT_INVALID', '爆款复刻只能有 1 个 analysis-only 参考视频。');
    var referenceRaw = raw.referenceVideo || legacyReferenceVideos[0] || null;
    var referenceVideo = referenceRaw ? normalizeAsset(referenceRaw, 'reference_video', 0) : null;
    var referenceFrames = normalizeAssets(raw.referenceFrames, 'reference_frame');
    var productKey = normalizeModelKey(raw.productKey || raw.modelKey || raw.model);
    if (!productKey) throw contractError('MODEL_UNKNOWN', '请选择 Seedance 产品模型。');
    var limits = effectiveLimits(mode, productKey);
    validateCount('图片', images, limits.imageMin, limits.imageMax);
    validateCount('视频', videos, limits.videoMin, limits.videoMax);
    validateCount('音频', audios, limits.audioMin, limits.audioMax);
    var totalAssets = images.length + videos.length + audios.length;
    if (totalAssets > limits.maxAssets) {
      throw contractError('ASSET_TOTAL_COUNT_INVALID', '生成素材总数不能超过 ' + limits.maxAssets + ' 个。', {
        count: totalAssets, max: limits.maxAssets, productKey: productKey
      });
    }
    function totalDuration(values) {
      return Math.round(values.reduce(function (sum, asset) { return sum + (Number(asset.durationSeconds) || 0); }, 0) * 1000) / 1000;
    }
    var totalVideoDuration = totalDuration(videos);
    var totalAudioDuration = totalDuration(audios);
    if (totalVideoDuration > limits.maxVideoDuration) {
      throw contractError('ASSET_DURATION_TOTAL_INVALID', '视频素材总时长不能超过 ' + limits.maxVideoDuration + ' 秒。', {
        kind: 'video', durationSeconds: totalVideoDuration, maxDurationSeconds: limits.maxVideoDuration
      });
    }
    if (totalAudioDuration > limits.maxAudioDuration) {
      throw contractError('ASSET_DURATION_TOTAL_INVALID', '音频素材总时长不能超过 ' + limits.maxAudioDuration + ' 秒。', {
        kind: 'audio', durationSeconds: totalAudioDuration, maxDurationSeconds: limits.maxAudioDuration
      });
    }

    var durationSeconds = safeInteger(raw.durationSeconds || raw.duration, limits.minDuration, limits.maxDuration, 0);
    if (!durationSeconds) {
      throw contractError('DURATION_INVALID', '当前模型视频时长必须是 ' + limits.minDuration + '–' + limits.maxDuration + ' 秒整数。');
    }
    var resolution = text(raw.resolution, 20).toLowerCase();
    if (limits.resolutions.indexOf(resolution) < 0) {
      throw contractError('RESOLUTION_INVALID', '当前模型分辨率仅支持 ' + limits.resolutions.join('、') + '。');
    }
    var ratio = text(raw.ratio || raw.aspectRatio, 20).toLowerCase();
    if (limits.ratios.indexOf(ratio) < 0) throw contractError('RATIO_INVALID', '当前模型视频比例不受支持。');
    var audio = normalizeAudioState(raw.audio || raw);
    var script = text(raw.script || raw.confirmedScript, 30000);
    var goal = text(raw.goal || raw.creativeGoal, 5000);
    var confirmed = raw.scriptConfirmed === true || raw.confirmed === true;
    var storyboard = normalizeStoryboard(raw.storyboard, { durationSeconds: durationSeconds });
    var reviewFingerprint = text(raw.reviewFingerprint, 120);
    var reviewConfirmedAt = text(raw.reviewConfirmedAt, 80);

    var visualAssetCount = images.length + videos.length;
    if (creativeRoute === 'hero_product' && images.length < 1) {
      throw contractError('CREATIVE_ROUTE_INPUT_INVALID', '商品主角路线至少需要 1 张目标商品图片。');
    }
    if (creativeRoute === 'elements_compose' && visualAssetCount < 2) {
      throw contractError('CREATIVE_ROUTE_INPUT_INVALID', '多元素编排路线至少需要 2 个图片或视频视觉素材。');
    }
    if (creativeRoute === 'audio_visual') {
      if (audios.length < 1 || (productKey === 'seedance-2.0' && visualAssetCount < 1)) {
        throw contractError('CREATIVE_ROUTE_INPUT_INVALID', productKey === 'seedance-2.0'
          ? 'Seedance 2.0 音画共创至少需要 1 个视觉素材和 1 个音频素材。'
          : 'Seedance 2.5 音画共创至少需要 1 个音频素材。');
      }
    }

    if (mode === 'direct' && !script) throw contractError('SCRIPT_REQUIRED', '脚本直出必须提供非空脚本。');
    if (mode === 'assist' && !goal) throw contractError('GOAL_REQUIRED', '脚本帮写必须提供创作目标。');
    if (mode === 'remix') {
      var reference = referenceVideo;
      var rights = raw.referenceRightsConfirmed === true || (reference && reference.rightsConfirmed === true);
      if (!rights) throw contractError('REFERENCE_RIGHTS_REQUIRED', '爆款复刻必须确认参考视频使用授权。');
      if (!reference || reference.durationSeconds < 4 || reference.durationSeconds > 15) {
        throw contractError('REFERENCE_VIDEO_DURATION_INVALID', '爆款复刻参考视频时长必须为 4–15 秒。');
      }
      validateCount('参考帧', referenceFrames, definition.referenceFrameMin, definition.referenceFrameMax);
    } else if (referenceVideo || referenceFrames.length) {
      throw contractError('REFERENCE_ANALYSIS_ASSET_MODE_INVALID', 'referenceVideo/referenceFrames 只能用于 remix 分析。');
    }
    if (stage === 'submit' && definition.requiresConfirmation && (!confirmed || !script)) {
      throw contractError('SCRIPT_CONFIRMATION_REQUIRED', '脚本帮写和爆款复刻必须确认重构脚本后才能提交。');
    }
    if (stage === 'submit' && definition.requiresConfirmation) {
      if (!storyboard.length) throw contractError('STORYBOARD_REQUIRED', '脚本帮写和爆款复刻提交时必须包含最终确认分镜。');
      if (!reviewFingerprint) throw contractError('REVIEW_FINGERPRINT_REQUIRED', '缺少最终脚本/分镜确认指纹。');
      var expectedReviewFingerprint = normalizedReviewFingerprint(script, storyboard);
      if (reviewFingerprint !== expectedReviewFingerprint) {
        throw contractError('REVIEW_FINGERPRINT_MISMATCH', '脚本或分镜已在确认后变更，请重新确认。');
      }
      var confirmedTime = Date.parse(reviewConfirmedAt);
      if (!reviewConfirmedAt || !Number.isFinite(confirmedTime) || confirmedTime <= 0) {
        throw contractError('REVIEW_CONFIRMED_AT_INVALID', '缺少有效的分镜确认时间。');
      }
      reviewConfirmedAt = new Date(confirmedTime).toISOString();
    } else if (!definition.requiresConfirmation) {
      storyboard = [];
      reviewFingerprint = '';
      reviewConfirmedAt = '';
    }

    var normalizedAssetRequest = {
      mode: mode,
      images: images,
      videos: videos,
      audios: audios,
      referenceVideo: referenceVideo,
      referenceFrames: referenceFrames
    };
    var rightsManifest = assetRightsManifest(normalizedAssetRequest);
    var hasAssets = assetCountFromManifest(rightsManifest) > 0;
    var rawRights = plainObject(raw.rights) ? raw.rights : (plainObject(raw.assetRights) ? raw.assetRights : {});
    var rights = {
      confirmed: rawRights.confirmed === true,
      confirmedAt: text(rawRights.confirmedAt, 80),
      fingerprint: text(rawRights.fingerprint || rawRights.assetFingerprint, 120)
    };
    if (stage === 'submit' && hasAssets) {
      if (!rights.confirmed) throw contractError('ASSET_RIGHTS_REQUIRED', '提交生成前必须确认对全部所选素材拥有合法使用权。');
      var rightsTime = Date.parse(rights.confirmedAt);
      if (!rights.confirmedAt || !Number.isFinite(rightsTime) || rightsTime <= 0) {
        throw contractError('ASSET_RIGHTS_CONFIRMED_AT_INVALID', '素材权利确认时间无效，请重新确认。');
      }
      var expectedRightsFingerprint = assetRightsFingerprint(normalizedAssetRequest);
      if (!rights.fingerprint) throw contractError('ASSET_RIGHTS_FINGERPRINT_REQUIRED', '缺少与当前素材绑定的权利确认指纹。');
      if (rights.fingerprint !== expectedRightsFingerprint) {
        throw contractError('ASSET_RIGHTS_FINGERPRINT_MISMATCH', '所选素材已在权利确认后发生变化，请重新确认。');
      }
      rights.confirmedAt = new Date(rightsTime).toISOString();
    }

    return freeze({
      contractVersion: CONTRACT_VERSION,
      mode: mode,
      creativeRoute: creativeRoute,
      styleProfile: styleProfile,
      productKey: productKey,
      durationSeconds: durationSeconds,
      resolution: resolution,
      ratio: ratio,
      audioMode: audio.audioMode,
      generateSound: audio.generateSound,
      narration: audio.narration,
      narrationLanguage: audio.narrationLanguage,
      script: script,
      goal: goal,
      scriptConfirmed: confirmed,
      storyboard: storyboard,
      reviewFingerprint: reviewFingerprint,
      reviewConfirmedAt: reviewConfirmedAt,
      supplementalRequirements: text(raw.supplementalRequirements || raw.requirements, 8000),
      images: images,
      videos: videos,
      audios: audios,
      referenceVideo: referenceVideo,
      referenceFrames: referenceFrames,
      referenceRightsConfirmed: mode === 'remix'
        ? (raw.referenceRightsConfirmed === true || referenceVideo.rightsConfirmed === true)
        : false,
      rights: freeze(rights)
    });
  }

  function transitionAllowed(from, to, context) {
    context = context || {};
    var mode = normalizeMode(context.mode || (context.task && context.task.mode));
    if (TASK_STATES.indexOf(from) < 0 || TASK_STATES.indexOf(to) < 0) return false;
    if (TRANSITIONS[from].indexOf(to) < 0) return false;
    if (from === 'draft' && to === 'queued') return mode === 'direct';
    if (from === 'draft' && to === 'analyzing') return mode === 'assist' || mode === 'remix';
    if (from === 'needs_confirmation' && to === 'queued') return context.confirmed === true;
    if ((from === 'failed' || from === 'cancelled') && to === 'queued') return context.retry === true;
    return true;
  }

  function assertTransition(from, to, context) {
    if (!transitionAllowed(from, to, context)) {
      throw contractError('STATE_TRANSITION_INVALID', '非法视频任务状态转换：' + from + ' → ' + to + '。', {
        from: from, to: to, mode: normalizeMode(context && context.mode)
      });
    }
    return true;
  }

  function transitionTask(task, nextState, context) {
    if (!plainObject(task)) throw contractError('TASK_INVALID', '视频任务必须是普通对象。');
    assertTransition(task.status, nextState, Object.assign({ mode: task.mode, task: task }, context || {}));
    var output = Object.assign({}, task, {
      status: nextState,
      updatedAt: Number(context && context.now) || Date.now()
    });
    return output;
  }

  function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!plainObject(value)) return value;
    var output = {};
    Object.keys(value).sort().forEach(function (key) {
      if (value[key] !== undefined) output[key] = stableValue(value[key]);
    });
    return output;
  }

  function stableStringify(value) {
    return JSON.stringify(stableValue(value));
  }

  function fingerprint(value, prefix) {
    var source = stableStringify(value);
    var hash = 2166136261;
    for (var i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
    return (prefix || 'vidfp_') + ('00000000' + (hash >>> 0).toString(16)).slice(-8);
  }

  function publicTask(task) {
    if (!task) return null;
    var allowed = [
      'schemaVersion', 'contractVersion', 'taskId', 'mode', 'accountKey', 'generation', 'attempt',
      'status', 'phase', 'creativeRoute', 'styleProfile', 'productKey', 'displayName', 'providerModel', 'adapter', 'provider',
      'requestFingerprint', 'idempotencyFingerprint', 'providerTaskId', 'providerState', 'progress', 'message',
      'errorCode', 'error', 'createdAt', 'updatedAt', 'submittedAt', 'finishedAt', 'cancelledAt',
      'resultUrls', 'scriptConfirmed', 'cancelPending'
    ];
    var output = {};
    allowed.forEach(function (key) {
      if (task[key] !== undefined) output[key] = task[key];
    });
    if (output.resultUrls) output.resultUrls = output.resultUrls.slice();
    return output;
  }

  return freeze({
    CONTRACT_VERSION: CONTRACT_VERSION,
    TASK_SCHEMA_VERSION: TASK_SCHEMA_VERSION,
    ASSET_DB_NAME: ASSET_DB_NAME,
    ASSET_STORE_NAME: ASSET_STORE_NAME,
    MODES: MODES,
    MODE_ALIASES: MODE_ALIASES,
    AUDIO_MODES: AUDIO_MODES,
    ASSET_ROLES: ASSET_ROLES,
    ASSET_ROLE_LABELS: ASSET_ROLE_LABELS,
    CREATIVE_ROUTES: CREATIVE_ROUTES,
    STYLE_PROFILES: STYLE_PROFILES,
    MODEL_DISPLAY_NAMES: MODEL_DISPLAY_NAMES,
    DEFAULT_PROVIDER_MODELS: DEFAULT_PROVIDER_MODELS,
    MODEL_CAPABILITIES: MODEL_CAPABILITIES,
    RESOLUTIONS: RESOLUTIONS,
    RATIOS: RATIOS,
    ADAPTERS: ADAPTERS,
    TASK_STATES: TASK_STATES,
    TERMINAL_STATES: TERMINAL_STATES,
    TRANSITIONS: TRANSITIONS,
    contractError: contractError,
    normalizeMode: normalizeMode,
    normalizeModelKey: normalizeModelKey,
    normalizeCreativeRoute: normalizeCreativeRoute,
    normalizeStyleProfile: normalizeStyleProfile,
    effectiveLimits: effectiveLimits,
    normalizeAdapter: normalizeAdapter,
    providerModelMap: providerModelMap,
    modelCatalog: modelCatalog,
    resolveModel: resolveModel,
    normalizeAudioState: normalizeAudioState,
    normalizeStorageRef: normalizeStorageRef,
    validRemoteAssetUrl: validRemoteAssetUrl,
    normalizeAsset: normalizeAsset,
    assetRightsFingerprint: assetRightsFingerprint,
    normalizeStoryboard: normalizeStoryboard,
    reviewFingerprint: normalizedReviewFingerprint,
    normalizeRequest: normalizeRequest,
    transitionAllowed: transitionAllowed,
    assertTransition: assertTransition,
    transitionTask: transitionTask,
    stableStringify: stableStringify,
    fingerprint: fingerprint,
    publicTask: publicTask,
    isTerminal: function (state) { return TERMINAL_STATES.indexOf(state) >= 0; }
  });
});
