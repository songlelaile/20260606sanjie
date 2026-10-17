(function initVideoStudio() {
  'use strict';

  var Contract = globalThis.SZEcommerceVideoContract;
  var Store = globalThis.SZEcommerceVideoStore;
  var Production = globalThis.SZEcommerceVideoProduction;

  if (!Contract || !Store) {
    document.addEventListener('DOMContentLoaded', function showBootstrapFailure() {
      var node = document.getElementById('composer-validation');
      if (!node) return;
      node.hidden = false;
      node.className = 'inline-notice is-error';
      node.textContent = '工作台基础模块加载失败。请确认 video-studio-contract.js 与 video-studio-store.js 已按顺序加载。';
    });
    return;
  }

  var MESSAGE = Object.freeze({
    CAPABILITIES: 'VIDEO_STUDIO_CAPABILITIES',
    CONFIG_GET: 'VIDEO_STUDIO_CONFIG_GET',
    OPEN_API_SETTINGS: 'OPEN_UNIFIED_API_SETTINGS',
    IMPORT_MEDIA_CLAIM: 'SZ_VISUAL_LAB_CLAIM_MEDIA_IMPORT',
    ASSET_PREPARE: 'VIDEO_STUDIO_ASSET_PREPARE',
    PORTRAIT_START: 'VIDEO_STUDIO_PORTRAIT_START',
    ANALYZE: 'VIDEO_STUDIO_ANALYZE',
    START: 'VIDEO_STUDIO_START',
    STATUS: 'VIDEO_STUDIO_STATUS',
    CANCEL: 'VIDEO_STUDIO_CANCEL',
    RETRY: 'VIDEO_STUDIO_RETRY',
    RESULT: 'VIDEO_STUDIO_RESULT'
  });

  var FILE_LIMITS = Object.freeze({
    image: Object.freeze({ count: 30, bytes: 20 * 1024 * 1024, accept: /^image\/(png|jpeg|webp)$/i }),
    video: Object.freeze({ count: 10, bytes: 200 * 1024 * 1024, accept: /^video\/(mp4|quicktime)$/i }),
    audio: Object.freeze({ count: 10, bytes: 15 * 1024 * 1024, accept: /^audio\/(mpeg|wav|x-wav)$/i })
  });
  var RUNTIME_TIMEOUT_MS = Object.freeze({
    default: 15000,
    capabilities: 30000,
    settings: 15000,
    importMedia: 15000,
    analysis: 165000,
    start: 120000,
    status: 50000,
    cancel: 50000,
    retry: 120000,
    result: 35000
  });

  var ACTIVE_STATES = Object.freeze(['analyzing', 'queued', 'submitting', 'processing']);
  var TERMINAL_STATES = Object.freeze(['succeeded', 'failed', 'cancelled']);
  var HISTORY_PAGE_SIZE = 20;
  var HISTORY_VIEW_STORAGE_PREFIX = 'sz-video-history-hidden-v1:';
  var STATUS_LABELS = Object.freeze({
    draft: '草稿',
    analyzing: '分析中',
    needs_confirmation: '待确认',
    queued: '排队中',
    submitting: '提交中',
    processing: '生成中',
    unknown: '待核对',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消'
  });
  var MODE_COPY = Object.freeze({
    direct: Object.freeze({ description: '填写一句话或上传参考素材，直接生成视频。', action: '生成视频' }),
    assist: Object.freeze({ description: '先分析创作目标，再编辑并确认脚本和分镜。', action: '分析并帮写脚本' }),
    remix: Object.freeze({ description: '从获授权参考视频的 5 帧画面结构出发，用自有素材重构新分镜。', action: '提取结构并生成脚本' })
  });
  var MAIN_MEDIA_IMPORT_SOURCE = 'taobao-main-media';
  var NEUTRAL_IMPORT_PROMPT = '以商品实拍素材为核心，真实、清晰地展示商品外观、细节与使用场景，镜头自然流畅，不夸大商品效果。';

  var dom = {};
  var state = {
    mode: 'direct',
    prompt: '',
    expertEnabled: false,
    expertRequirements: '',
    assets: { image: [], video: [], audio: [] },
    reference: null,
    referenceFrames: [],
    rightsConfirmed: false,
    rightsConfirmedAt: '',
    rightsFingerprint: '',
    settings: {
      productKey: 'seedance-2.0',
      creativeRoute: 'hero_product',
      styleProfile: 'commerce_studio',
      resolution: '720p',
      ratio: '9:16',
      durationSeconds: 15,
      audioMode: 'sound_only',
      narrationLanguage: 'zh-CN'
    },
    productionOptions: { mode: 'economic', totalDurationSeconds: 15, hybridAiSeconds: 0, budgetYuan: 10, maxAttempts: 1 },
    productionAudio: { sourceAudioVolume: 0 },
    legacySingle: false,
    productionRun: null,
    productionBusy: false,
    productionStarting: false,
    assetPreparing: false,
    portraitAuthorization: null,
    portraitStartRequest: null,
    productionAbortController: null,
    review: freshReview(),
    backendConnected: false,
    accountKey: '',
    capabilityError: '',
    capabilities: null,
    credentialAvailable: null,
    credentialStatus: null,
    analysisAvailable: null,
    analysisBillingChannel: 'external_key', analysisModel: '',
    analysisStatus: null,
    modelCatalog: defaultModelCatalog(),
    actionPending: false,
    configOpenPending: false,
    awaitingConfigRefresh: false,
    draftTimer: null,
    activeRun: null,
    history: [],
    historyViewAccountKey: null,
    hiddenHistoryIds: new Set(),
    showHiddenHistory: false,
    historyVisibleLimit: HISTORY_PAGE_SIZE,
    historyRenderSignature: '',
    pollTimer: null,
    pollFailures: 0,
    previewUrls: new Set(),
    resultPreviewUrl: '',
    resultPreviewSequence: 0,
    booted: false
  };

  function freshReview() {
    return {
      state: 'idle',
      analysis: '',
      script: '',
      storyboard: [],
      analysisFingerprint: '',
      confirmed: false,
      confirmedAt: ''
    };
  }

  function defaultModelCatalog() {
    var catalog = Contract.modelCatalog();
    return catalog.map(function clone(item) {
      var verifiedProviderModel = item.providerModel || '';
      var limits = item.limits || item.capabilities || effectiveLimits('direct', item.productKey);
      return {
        productKey: item.productKey,
        displayName: item.displayName,
        providerModel: verifiedProviderModel,
        providerModelConfigured: !!verifiedProviderModel,
        configured: false,
        resolutions: (limits.resolutions || Contract.RESOLUTIONS).slice(),
        ratios: (limits.ratios || Contract.RATIOS).slice(),
        minDuration: Number(limits.minDuration || 4),
        maxDuration: Number(limits.maxDuration || (item.productKey === 'seedance-2.5' ? 30 : 15)),
        imageMax: Number(limits.imageMax || 0),
        videoMax: Number(limits.videoMax || 0),
        audioMax: Number(limits.audioMax || 0),
        maxAssets: Number(limits.maxAssets || 0),
        creditsPerSecond: null
      };
    });
  }

  function cacheDom() {
    [
      'runtime-status', 'runtime-status-text', 'open-api-settings', 'refresh-capabilities', 'mode-description', 'reset-draft',
      'mode-tabs', 'mode-panel', 'creative-route-help', 'creative-route-grid', 'style-profile-grid',
      'reference-section', 'reference-dropzone', 'reference-video-input',
      'reference-preview', 'asset-help', 'asset-count', 'image-quota', 'video-quota', 'audio-quota',
      'image-input', 'video-input', 'audio-input', 'video-upload-tile', 'asset-list', 'prompt-input',
      'prompt-count', 'expert-mode-block', 'expert-mode-enabled', 'expert-requirements-wrap',
      'expert-requirements', 'expert-count', 'rights-confirmed', 'composer-validation', 'action-summary',
      'primary-action', 'primary-action-label', 'review-panel', 'review-state', 'analysis-summary',
      'script-editor', 'script-count', 'storyboard-list', 'add-shot', 'review-validation', 'reanalyze',
      'confirm-review', 'job-panel', 'job-stage', 'job-title', 'job-message', 'job-status-chip',
      'job-progress', 'job-id', 'job-updated', 'cancel-job', 'retry-job', 'view-result', 'model-select',
      'model-help', 'resolution-help', 'duration-input', 'duration-output', 'duration-presets', 'narration-settings', 'narration-language',
      'audio-constraint-note', 'credit-estimate', 'estimate-note', 'readiness-count', 'readiness-list', 'history-filter',
      'refresh-history', 'history-list', 'history-empty', 'history-summary', 'clear-ended-history',
      'toggle-hidden-history', 'load-more-history', 'result-dialog', 'result-media', 'result-details',
      'toast-region', 'production-modes', 'production-duration', 'production-ai-seconds', 'production-ai-wrap',
      'production-budget', 'production-attempts', 'production-estimate', 'production-note', 'production-panel',
      'production-run-summary', 'production-resume', 'production-stop', 'production-new-plan', 'production-new-plan-help', 'production-shot-list', 'production-run-notice',
      'audio-upload-label', 'production-final-audio', 'production-source-volume', 'production-source-volume-output',
      'production-audio-summary', 'supplier-audio-fieldset'
    ].forEach(function byId(id) {
      dom[toCamel(id)] = document.getElementById(id);
    });
  }

  function toCamel(value) {
    return value.replace(/-([a-z])/g, function replace(_, letter) { return letter.toUpperCase(); });
  }

  function makeId(prefix) {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return prefix + '-' + globalThis.crypto.randomUUID();
    }
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  function cleanText(value) {
    return String(value == null ? '' : value).trim();
  }

  function safeRemoteAssetUrl(value) {
    var input = String(value == null ? '' : value);
    if (!input || input.length > 4096 || input.trim() !== input || /[\u0000-\u001f\u007f]/.test(input)) return '';
    try {
      var url = new URL(input);
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
      url.hash = '';
      return url.href;
    } catch (_) {
      return '';
    }
  }
  function normalizeTrustedPortraitUri(value) {
    if (typeof value !== 'string' || value.trim() !== value) return '';
    var id = value.indexOf('asset://') === 0 ? value.slice(8) : value;
    return /^asset-[A-Za-z0-9-]{1,120}$/.test(id) ? 'asset://' + id : '';
  }
  function personalArkPortraitAvailable() {
    var model = getSelectedModel(), caps = state.capabilities || {};
    return !!(state.accountKey && state.backendConnected && state.credentialAvailable === true && model && model.configured &&
      !model.nativePlatform && caps.provider === 'doubao' && caps.adapter === 'ark');
  }
  function trustedPortraitUri(asset) {
    if (!asset || !asset.trustedPortrait) return '';
    var uri = normalizeTrustedPortraitUri(asset.trustedPortrait.uri);
    if (!uri || asset.kind !== 'image' || !localStorageAssetId(asset)) throw makeStudioError('TRUSTED_PORTRAIT_INVALID', '可信人像引用无效，请恢复原始图片后重新关联。');
    if (!state.accountKey || asset.trustedPortrait.accountKey !== state.accountKey) throw makeStudioError('TRUSTED_PORTRAIT_ACCOUNT', '可信人像引用属于原账号，请切回原账号或恢复原始图片。');
    if (!personalArkPortraitAvailable()) throw makeStudioError('TRUSTED_PORTRAIT_BYOK_REQUIRED', '可信人像引用仅支持个人火山方舟 API；平台视频暂不支持，请切换个人 API 或恢复原始图片。');
    return uri;
  }

  function localStorageAssetId(asset) {
    if (!asset || safeRemoteAssetUrl(asset.remoteUrl) || !asset.storageRef) return '';
    return cleanText(asset.storageRef.id || asset.id);
  }

  function materialKind(asset) {
    return asset && ['ordinary', 'virtual', 'real'].indexOf(asset.materialKind) >= 0 ? asset.materialKind : 'unknown';
  }
  function assetReportingCapability() {
    var reporting = state.capabilities && state.capabilities.assetReporting;
    return reporting && typeof reporting === 'object' ? reporting : {};
  }
  function assetReportingAvailable() {
    return !!(state.accountKey && state.backendConnected && assetReportingCapability().available === true);
  }
  function assetReportingMessage() {
    return cleanText(assetReportingCapability().message) || '当前账号未配置自动报备服务，请由管理员打开素材送审安全配置。普通图片可继续使用。';
  }
  function registrationMetadata(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return { accountKey: cleanText(raw.accountKey).slice(0, 256), libraryId: cleanText(raw.libraryId).slice(0, 160),
      status: ['active', 'preparing', 'needs_authorization', 'failed', 'uncertain'].indexOf(raw.status) >= 0 ? raw.status : 'uncertain',
      registrationKind: raw.registrationKind === 'real' ? 'real' : (raw.registrationKind === 'virtual' ? 'virtual' : ''),
      portraitSessionId: cleanText(raw.portraitSessionId).slice(0, 256), message: cleanText(raw.message).slice(0, 600) };
  }
  function currentRegistration(asset) {
    var registration = registrationMetadata(asset && asset.registration);
    if (!registration) return null;
    if (!state.accountKey || registration.accountKey !== state.accountKey) throw makeStudioError('ASSET_REPORT_ACCOUNT', '素材报备记录属于原账号，请切回原账号后核对。');
    if (registration.registrationKind !== materialKind(asset)) throw makeStudioError('ASSET_REPORT_KIND', '素材类型与报备记录不一致，请重新确认素材类型。');
    return registration;
  }
  function activeLibraryUri(asset) {
    var registration = currentRegistration(asset);
    if (!registration || registration.status !== 'active') return '';
    if (!/^va_[A-Za-z0-9_-]{1,150}$/.test(registration.libraryId)) throw makeStudioError('ASSET_REPORT_ID', '报备服务返回的素材编号无效，请核对原记录。');
    if (!assetReportingAvailable()) throw makeStudioError('ASSET_REPORT_UNAVAILABLE', assetReportingMessage());
    return 'library://' + registration.libraryId;
  }
  function requiresAssetPreparation(asset) {
    // A manually linked, previously authenticated portrait keeps its original BYOK route.
    return ['virtual', 'real'].indexOf(materialKind(asset)) >= 0 && (!asset.trustedPortrait || !!asset.registration);
  }
  function materialValidationErrors() {
    var errors = [];
    if (state.assets.image.some(function (asset) { return materialKind(asset) === 'unknown'; })) errors.push('请为每张图片选择素材类型：普通图片、虚拟人物或真实人物。');
    state.assets.image.forEach(function (asset) {
      try { currentRegistration(asset); } catch (error) { errors.push(safeErrorMessage(error)); }
    });
    return errors;
  }
  function authorizationMetadata(raw, accountKey) {
    if (!raw || !cleanText(raw.sessionId)) return null;
    var url = safeRemoteAssetUrl(raw.url);
    return { accountKey: accountKey, sessionId: cleanText(raw.sessionId).slice(0, 256), url: url, status: cleanText(raw.status).slice(0, 64) };
  }
  function currentPortraitAuthorization() {
    return state.portraitAuthorization && state.portraitAuthorization.accountKey === state.accountKey ? state.portraitAuthorization : null;
  }
  function confirmedNotUploaded(reply, registration) {
    return !!(reply && reply.uploadRequired === true && reply.providerSubmitted === false && !reply.libraryId && registration && !registration.libraryId);
  }
  async function setMaterialKind(id, value) {
    if (state.actionPending || state.productionBusy || state.productionStarting || state.assetPreparing) return false;
    var asset = state.assets.image.find(function (item) { return item.id === id; });
    if (!asset || ['unknown', 'ordinary', 'virtual', 'real'].indexOf(value) < 0 || materialKind(asset) === value) return false;
    if (asset.registration) {
      setNotice(dom.composerValidation, '这张图片已有报备记录。请保留原类型核对，或重新添加原图后选择正确类型；旧记录不会重复上传。', 'error'); renderAssets(); return false;
    }
    asset.materialKind = value;
    if (value !== 'real') delete asset.trustedPortrait;
    invalidateRights(); state.review.confirmed = false; state.review.confirmedAt = '';
    invalidateReviewForSourceChange('素材类型已变化，请重新分析并确认脚本。');
    renderAssets(); renderReadiness(); await saveCurrentDraft(); return true;
  }
  async function startPortraitAuthorization() {
    if (state.actionPending || state.productionBusy || state.productionStarting || state.assetPreparing) return false;
    if (!assetReportingAvailable() || assetReportingCapability().portraitAvailable !== true) { setNotice(dom.composerValidation, assetReportingMessage(), 'error'); return false; }
    var accountKey = state.accountKey;
    state.assetPreparing = true; renderAssets();
    try {
      if (!state.portraitStartRequest || state.portraitStartRequest.accountKey !== accountKey) state.portraitStartRequest = { accountKey: accountKey, idempotencyKey: makeId('portrait') };
      await saveCurrentDraft();
      if (state.accountKey !== accountKey) throw makeStudioError('ASSET_REPORT_ACCOUNT', '账号已变化，未创建新的本人认证。');
      var response = responsePayload(await sendRuntimeMessage(MESSAGE.PORTRAIT_START, { idempotencyKey: state.portraitStartRequest.idempotencyKey }, RUNTIME_TIMEOUT_MS.start));
      if (!accountKey || response.accountKey !== accountKey || state.accountKey !== accountKey) throw makeStudioError('ASSET_REPORT_ACCOUNT', '认证响应账号不一致，未采用认证链接。');
      var authorization = authorizationMetadata(response.authorization, accountKey);
      if (!authorization) throw makeStudioError('PORTRAIT_AUTHORIZATION_MISSING', '认证服务没有返回本人认证记录，请核对配置。');
      state.portraitAuthorization = authorization;
      state.assets.image.forEach(function (asset) {
        if (materialKind(asset) === 'real' && asset.registration && asset.registration.accountKey === accountKey && asset.registration.status !== 'active') asset.registration.portraitSessionId = authorization.sessionId;
      });
      await saveCurrentDraft();
      if (['expired', 'failed'].indexOf(authorization.status) >= 0) { setNotice(dom.composerValidation, '本人认证会话已过期或失败，请点击“重新创建本人认证链接”。', 'info'); return false; }
      if (['verified', 'active'].indexOf(authorization.status) >= 0) { setNotice(dom.composerValidation, '本人认证已核对，请准备素材并等待供应商审核。', 'info'); return true; }
      if (!authorization.url) throw makeStudioError('PORTRAIT_AUTHORIZATION_MISSING', '本人认证回执尚未确认，请核对原认证记录；不会自动创建新会话。');
      setNotice(dom.composerValidation, '请由图片中的本人打开认证链接，亲自确认授权并完成认证；完成后点击“查询报备进度”。', 'info'); return true;
    } catch (error) { setNotice(dom.composerValidation, safeErrorMessage(error), 'error'); return false; }
    finally { state.assetPreparing = false; renderAssets(); renderReadiness(); }
  }
  async function restartPortraitAuthorization() {
    var authorization = currentPortraitAuthorization();
    if (state.actionPending || state.productionBusy || state.productionStarting || state.assetPreparing || !authorization || ['expired', 'failed'].indexOf(authorization.status) < 0) return false;
    // The user explicitly replaces a terminal session. An unknown response keeps this new key for lookup.
    state.portraitStartRequest = { accountKey: state.accountKey, idempotencyKey: makeId('portrait') };
    state.portraitAuthorization = Object.assign({}, authorization, { status: 'uncertain', url: '' });
    return startPortraitAuthorization();
  }
  async function originalImageDataUrl(asset) {
    var storedId = localStorageAssetId(asset);
    if (!storedId) throw makeStudioError('ASSET_REPORT_LOCAL_REQUIRED', '自动报备需要本地原图，请下载并重新添加这张图片。');
    var record = await Store.getAsset(storedId);
    if (!record || !(record.blob instanceof Blob) || !record.blob.size || record.blob.size > FILE_LIMITS.image.bytes) throw makeStudioError('ASSET_REPORT_SOURCE_MISSING', '本地原图缺失或超过 20 MB，请恢复原始图片。');
    var bytes = new Uint8Array(await record.blob.arrayBuffer()), binary = '';
    for (var index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 8192));
    return 'data:' + asset.mimeType + ';base64,' + globalThis.btoa(binary);
  }
  async function prepareVideoAssets(options) {
    if (state.assetPreparing || state.productionBusy || state.productionStarting) return false;
    var errors = materialValidationErrors();
    if (errors.length) { setNotice(dom.composerValidation, errors.join(' '), 'error'); return false; }
    var assets = state.assets.image.filter(requiresAssetPreparation);
    if (!assets.length) return true;
    if (!assetReportingAvailable()) { setNotice(dom.composerValidation, assetReportingMessage(), 'error'); return false; }
    if (!state.rightsConfirmed || state.rightsFingerprint !== assetRightsFingerprint()) { setNotice(dom.composerValidation, '请先确认素材权利及向当前供应商自动送审的授权。', 'error'); return false; }
    try { assets.forEach(function (asset) { activeLibraryUri(asset); }); }
    catch (error) { setNotice(dom.composerValidation, safeErrorMessage(error), 'error'); return false; }
    var authorization = currentPortraitAuthorization();
    if (assets.some(function (asset) { return materialKind(asset) === 'real' && !asset.registration; }) && !authorization) {
      setNotice(dom.composerValidation, '真实人物需要由本人认证和授权。请先点击图片下方“创建本人认证链接”，完成后准备素材。', 'info'); renderAssets(); return false;
    }
    var accountKey = state.accountKey, sourceFingerprint = assetRightsFingerprint(), pending = assets;
    state.assetPreparing = true; setPending(true, '正在准备素材…'); renderAssets();
    try {
      var requests = [];
      for (var asset of pending) {
        var registration = currentRegistration(asset), item = { id: asset.id, name: asset.name, mimeType: asset.mimeType, registrationKind: materialKind(asset) };
        if (registration) { if (registration.libraryId) item.libraryId = registration.libraryId; }
        else item.dataUrl = await originalImageDataUrl(asset);
        var sessionId = registration && registration.portraitSessionId || authorization && authorization.sessionId || '';
        if (item.registrationKind === 'real' && sessionId) item.portraitSessionId = sessionId;
        requests.push(item);
      }
      if (state.accountKey !== accountKey || sourceFingerprint !== assetRightsFingerprint()) throw makeStudioError('ASSET_REPORT_ACCOUNT', '账号或素材已变化，未发送原图，请切回原账号。');
      // Persist intent before crossing the runtime boundary. An uncertain reply is polled without sending bytes again.
      pending.forEach(function (asset, index) {
        if (!asset.registration) asset.registration = registrationMetadata({ accountKey: accountKey, libraryId: '', status: 'preparing', registrationKind: materialKind(asset), portraitSessionId: requests[index].portraitSessionId });
      });
      await saveCurrentDraft();
      if (state.accountKey !== accountKey || sourceFingerprint !== assetRightsFingerprint()) throw makeStudioError('ASSET_REPORT_ACCOUNT', '账号或素材已变化，未发送报备请求，请切回原账号。');
      var payload = { assets: requests, rightsConfirmed: true }; if (authorization) payload.portraitSessionId = authorization.sessionId;
      var automatic = options && options.pollUntilReady === true, deadline = Date.now() + 60000;
      while (true) {
      var result = responsePayload(await sendRuntimeMessage(MESSAGE.ASSET_PREPARE, payload, automatic ? Math.min(20000, Math.max(1, deadline - Date.now())) : RUNTIME_TIMEOUT_MS.start));
      if (state.accountKey !== accountKey || result.accountKey !== accountKey || sourceFingerprint !== assetRightsFingerprint()) throw makeStudioError('ASSET_REPORT_ACCOUNT', '账号或素材已变化，未采用报备结果；请切回原账号核对原记录。');
      if (!Array.isArray(result.assets)) throw makeStudioError('ASSET_REPORT_INVALID', '报备服务返回不完整，请核对原记录。');
      pending.forEach(function (asset) {
        var matches = result.assets.filter(function (item) { return item.id === asset.id; });
        if (matches.length !== 1) { asset.registration.status = 'uncertain'; asset.registration.message = '没有收到唯一的素材状态，请查询原记录。'; return; }
        var reply = matches[0], previous = asset.registration;
        if (confirmedNotUploaded(reply, previous)) { delete asset.registration; return; }
        asset.registration = registrationMetadata({ accountKey: accountKey, libraryId: reply.libraryId || previous.libraryId, status: reply.status,
          registrationKind: materialKind(asset), portraitSessionId: previous.portraitSessionId, message: reply.message });
        if (asset.registration.status === 'active' && !/^va_[A-Za-z0-9_-]{1,150}$/.test(asset.registration.libraryId)) { asset.registration.status = 'uncertain'; asset.registration.message = '素材编号无效，请核对原记录。'; }
      });
      if (result.authorization) state.portraitAuthorization = authorizationMetadata(result.authorization, accountKey) || state.portraitAuthorization;
      await saveCurrentDraft();
      var complete = assets.every(function (asset) { return !!activeLibraryUri(asset); });
      setNotice(dom.composerValidation, complete ? '需报备的素材已由供应商确认可用。' : '素材尚未全部可用。请查看每张图片的报备状态，完成本人认证后查询原记录。', complete ? 'success' : 'info');
      if (complete || !automatic) return complete;
      var waiting = assets.filter(function (asset) { return !activeLibraryUri(asset); });
      if (!waiting.length || waiting.some(function (asset) { return !asset.registration || asset.registration.status !== 'preparing' || !/^va_[A-Za-z0-9_-]{1,150}$/.test(asset.registration.libraryId); })) return false;
      if (Date.now() >= deadline) { setNotice(dom.composerValidation, '素材仍在审核，已保留原报备记录。请稍后查询进度，再次点击生成不会重复上传。', 'info'); return false; }
      renderAssets();
      setNotice(dom.composerValidation, '素材正在审核，工作台正在查询原报备记录；全部可用后继续本次生成。', 'info');
      await new Promise(function (resolve) { globalThis.setTimeout(resolve, Math.min(2000, deadline - Date.now())); });
      if (state.accountKey !== accountKey || sourceFingerprint !== assetRightsFingerprint()) throw makeStudioError('ASSET_REPORT_ACCOUNT', '账号或素材已变化，已停止自动查询；原报备记录仍保留。');
      if (Date.now() >= deadline) { setNotice(dom.composerValidation, '素材仍在审核，已保留原报备记录。请稍后查询进度，再次点击生成不会重复上传。', 'info'); return false; }
      pending = waiting;
      payload.assets = waiting.map(function (asset) { var record = asset.registration, query = { id: asset.id, name: asset.name, mimeType: asset.mimeType, libraryId: record.libraryId, registrationKind: record.registrationKind }; if (record.portraitSessionId) query.portraitSessionId = record.portraitSessionId; return query; });
      }
    } catch (error) {
      if (state.accountKey === accountKey) {
        var details = error && error.details || {}, safeCodes = ['ASSET_SERVICE_NOT_CONFIGURED', 'ASSET_RATE_LIMIT', 'PROVIDER_BINDING_MISMATCH', 'AUTH_REQUIRED', 'VALIDATION_REQUIRED', 'VALIDATION_PENDING', 'HUMAN_VALIDATION_REQUIRED', 'HUMAN_GROUP_UNVERIFIED', 'VALIDATION_NOT_FOUND', 'MATERIAL_TYPE_REQUIRED'];
        pending.forEach(function (asset) {
          var applies = details.assetId === asset.id || details.clientId === asset.id || (!details.assetId && !details.clientId && pending.length === 1);
          if (applies && safeCodes.indexOf(errorCode(error)) >= 0 && confirmedNotUploaded(details, asset.registration)) delete asset.registration;
          else if (asset.registration) { asset.registration.status = 'uncertain'; asset.registration.message = safeErrorMessage(error); }
        });
        await saveCurrentDraft().catch(function () {});
      }
      setNotice(dom.composerValidation, safeErrorMessage(error), 'error'); return false;
    } finally { state.assetPreparing = false; setPending(false); renderAssets(); renderReadiness(); }
  }

  function clamp(value, min, max) {
    var number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, number));
  }

  function formatBytes(bytes) {
    var value = Number(bytes || 0);
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(value < 10240 ? 1 : 0) + ' KB';
    return (value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  }

  function formatDuration(seconds) {
    var value = Number(seconds || 0);
    if (!value) return '';
    return (Math.round(value * 10) / 10) + ' 秒';
  }

  function formatDate(value) {
    if (!value) return '—';
    var date = typeof value === 'number' ? new Date(value) : new Date(String(value));
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).format(date);
  }

  function modeDefinition(mode) {
    return Contract.MODES[mode] || Contract.MODES.direct;
  }

  function defaultRouteForMode(mode) {
    return mode === 'remix' ? 'reference_rebuild' : 'hero_product';
  }

  function routeDefinition(route) {
    return Contract.CREATIVE_ROUTES && Contract.CREATIVE_ROUTES[route] || null;
  }

  function styleDefinition(style) {
    return Contract.STYLE_PROFILES && Contract.STYLE_PROFILES[style] || null;
  }

  function routeSupportsMode(route, mode) {
    var definition = routeDefinition(route);
    return !!definition && (!Array.isArray(definition.supportedModes) || definition.supportedModes.indexOf(mode) >= 0);
  }

  function effectiveLimits(mode, productKey) {
    if (typeof Contract.effectiveLimits === 'function') return Contract.effectiveLimits(mode, productKey);
    var definition = modeDefinition(mode);
    return {
      imageMin: definition.imageMin || 0,
      imageMax: definition.imageMax || 0,
      videoMin: definition.videoMin || 0,
      videoMax: definition.videoMax || 0,
      audioMin: 0,
      audioMax: definition.audioMax || 0,
      minDuration: 4,
      maxDuration: productKey === 'seedance-2.5' ? 30 : 15,
      resolutions: productKey === 'seedance-2.5' ? ['480p', '720p', '1080p'] : ['480p', '720p', '1080p', '4k'],
      ratios: Contract.RATIOS.slice()
    };
  }

  function selectedRadio(name, fallback) {
    var input = document.querySelector('input[name="' + name + '"]:checked');
    return input ? input.value : fallback;
  }

  function setRadio(name, value) {
    var input = document.querySelector('input[name="' + name + '"][value="' + CSS.escape(String(value)) + '"]');
    if (input) input.checked = true;
  }

  function safeErrorMessage(error, fallback) {
    if (!error) return fallback || '发生未知错误。';
    if (typeof error === 'string') return error;
    return cleanText(error.message || (error.error && error.error.message) || fallback || '发生未知错误。');
  }

  function errorCode(error) {
    return cleanText(error && (error.code || (error.error && error.error.code))) || 'VIDEO_STUDIO_ERROR';
  }

  function showToast(message, tone) {
    var toast = document.createElement('div');
    toast.className = 'toast' + (tone ? ' is-' + tone : '');
    toast.textContent = cleanText(message);
    dom.toastRegion.appendChild(toast);
    globalThis.setTimeout(function removeToast() {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 4600);
  }

  function setNotice(node, message, tone) {
    if (!message) {
      node.hidden = true;
      node.textContent = '';
      node.className = 'inline-notice';
      return;
    }
    node.hidden = false;
    node.textContent = message;
    node.className = 'inline-notice' + (tone ? ' is-' + tone : '');
  }

  function setPending(pending, label) {
    state.actionPending = !!pending;
    if (label) dom.primaryActionLabel.textContent = label;
    renderReadiness();
  }

  function isRuntimeAvailable() {
    return typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function';
  }

  function sendRuntimeMessage(type, payload, timeoutMs, options) {
    timeoutMs = Number(timeoutMs || RUNTIME_TIMEOUT_MS.default);
    return new Promise(function runtimePromise(resolve, reject) {
      if (!isRuntimeAvailable()) {
        var missing = new Error('后台生成能力未接入：当前页面没有可用的 chrome.runtime。');
        missing.code = 'RUNTIME_UNAVAILABLE';
        reject(missing);
        return;
      }

      var settled = false;
      var timer = options && options.waitForUser === true ? null : globalThis.setTimeout(function onTimeout() {
        if (settled) return;
        settled = true;
        var message = type === MESSAGE.ANALYZE
          ? '分析响应超时，后台请求可能仍在收尾；本次不会自动重试。'
          : ([MESSAGE.START, MESSAGE.RETRY].indexOf(type) >= 0
            ? '任务提交响应超时，是否已被供应商接收仍不确定；为避免重复计费，本次不会自动重试。'
            : '后台响应超时，当前状态保持不变，请稍后手动刷新。');
        var timeout = new Error(message);
        timeout.code = 'RUNTIME_TIMEOUT';
        timeout.details = { timeoutMs: timeoutMs, stateUncertain: [MESSAGE.START, MESSAGE.RETRY].indexOf(type) >= 0 };
        reject(timeout);
      }, timeoutMs);

      function finish(error, response) {
        if (settled) return;
        settled = true;
        if (timer !== null) globalThis.clearTimeout(timer);
        if (error) {
          reject(error);
          return;
        }
        try {
          resolve(assertOkResponse(response));
        } catch (responseError) {
          reject(responseError);
        }
      }

      try {
        chrome.runtime.sendMessage({ type: type, payload: payload || {} }, function onResponse(response) {
          var lastError = chrome.runtime.lastError;
          if (lastError) {
            var message = cleanText(lastError.message);
            var disconnected = /receiving end|could not establish connection|called from a webpage|must specify an extension id/i.test(message);
            var runtimeError = new Error(disconnected
              ? '后台生成能力未接入：请从插件功能页打开完整工作台。'
              : (message || '后台消息发送失败。'));
            runtimeError.code = disconnected ? 'RECEIVER_MISSING' : 'RUNTIME_MESSAGE_FAILED';
            finish(runtimeError);
            return;
          }
          finish(null, response);
        });
      } catch (error) {
        var thrownMessage = cleanText(error && error.message);
        if (/receiving end|could not establish connection|called from a webpage|must specify an extension id/i.test(thrownMessage)) {
          var unavailable = new Error('后台生成能力未接入：请从插件功能页打开完整工作台。');
          unavailable.code = 'RECEIVER_MISSING';
          finish(unavailable);
        } else {
          finish(error);
        }
      }
    });
  }

  function assertOkResponse(response) {
    if (!response) {
      var emptyError = new Error('后台未返回有效响应。');
      emptyError.code = 'EMPTY_RESPONSE';
      throw emptyError;
    }
    var payload = response.payload && typeof response.payload === 'object' ? response.payload : null;
    if (response.ok === false || (payload && payload.error)) {
      var raw = (payload && payload.error) || response.error || response;
      var rejected = new Error(cleanText(raw.message || response.message) || '后台拒绝了请求。');
      rejected.code = cleanText(raw.code || response.code) || 'BACKEND_REJECTED';
      rejected.details = raw.details || response.details;
      throw rejected;
    }
    return response;
  }

  function responsePayload(response) {
    if (response && response.payload && typeof response.payload === 'object') return response.payload;
    return response || {};
  }

  function payloadForRequest(request, extra) {
    return Object.assign({
      schemaVersion: Contract.TASK_SCHEMA_VERSION,
      contractVersion: Contract.CONTRACT_VERSION,
      requestId: makeId('request'),
      request: request
    }, extra || {});
  }

  function payloadForTask(taskId, extra) {
    return Object.assign({
      schemaVersion: Contract.TASK_SCHEMA_VERSION,
      contractVersion: Contract.CONTRACT_VERSION,
      taskId: String(taskId || '')
    }, extra || {});
  }

  async function refreshCapabilities(options) {
    options = options || {};
    state.backendConnected = false;
    state.capabilityError = '';
    renderRuntimeStatus('checking', '正在检查生成能力');
    renderReadiness();

    try {
      var response = await sendRuntimeMessage(MESSAGE.CAPABILITIES, {
        schemaVersion: Contract.TASK_SCHEMA_VERSION,
        contractVersion: Contract.CONTRACT_VERSION,
        requestId: makeId('capabilities')
      }, RUNTIME_TIMEOUT_MS.capabilities);
      var payload = responsePayload(response);
      var previousAccountKey = state.accountKey;
      state.backendConnected = true;
      state.accountKey = cleanText(payload.accountKey);
      var capabilityDetails = payload.capabilities || payload.data || payload;
      state.capabilities = Object.assign({}, capabilityDetails, {
        provider: cleanText(payload.provider || capabilityDetails.provider),
        adapter: cleanText(payload.adapter || capabilityDetails.adapter)
      });
      state.credentialAvailable = payload.credentialAvailable === true
        ? true
        : (payload.credentialAvailable === false ? false : null);
      state.credentialStatus = payload.credentialStatus && typeof payload.credentialStatus === 'object'
        ? payload.credentialStatus
        : null;
      state.analysisAvailable = payload.analysisAvailable === true;
      state.analysisBillingChannel = payload.analysisBillingChannel === 'platform_wallet' ? 'platform_wallet' : 'external_key';
      state.analysisModel = cleanText(payload.analysisModel || '');
      state.analysisStatus = payload.analysisStatus && typeof payload.analysisStatus === 'object' ? payload.analysisStatus : null;
      state.modelCatalog = normalizeModelCatalog(payload);
      state.capabilityError = '';
      renderRuntimeStatus('connected', '生成能力已连接');
      if (previousAccountKey && previousAccountKey !== state.accountKey) {
        if (state.productionAbortController) state.productionAbortController.abort();
        state.productionRun = null;
        state.activeRun = null;
        if (state.pollTimer) globalThis.clearTimeout(state.pollTimer);
        state.pollTimer = null;
        await restoreHistory();
      }
      if (options.toast) showToast('已刷新后台生成能力。', 'success');
    } catch (error) {
      state.backendConnected = false;
      state.capabilityError = safeErrorMessage(error, '后台生成能力未接入。');
      state.capabilities = null;
      state.credentialAvailable = null;
      state.credentialStatus = null;
      state.analysisAvailable = null;
      state.analysisStatus = null;
      state.modelCatalog = defaultModelCatalog();
      renderRuntimeStatus('disconnected', '生成能力未接入');
      if (options.toast) showToast(state.capabilityError, 'error');
    }

    renderModelCatalog();
    renderMode();
    renderAssets();
    renderReadiness();
    updateEstimate();
  }

  async function openVideoApiSettings() {
    if (state.configOpenPending) return;
    state.configOpenPending = true;
    dom.openApiSettings.disabled = true;
    try {
      var response = await sendRuntimeMessage(MESSAGE.OPEN_API_SETTINGS, {
        source: 'video-studio',
        provider: 'doubao'
      }, RUNTIME_TIMEOUT_MS.settings, {
        // The website responds after its modal closes; the extension responds
        // when its settings page opens and still uses the connection deadline.
        waitForUser: isRuntimeAvailable() && chrome.runtime.id === 'shaozhuang-web-studio'
      });
      var settingsResult = responsePayload(response);
      if (settingsResult.cancelled === true) {
        state.awaitingConfigRefresh = false;
        showToast('已取消视频 API 配置，未保存修改。');
        return;
      }
      if (settingsResult.saved === true) {
        state.awaitingConfigRefresh = false;
        await refreshCapabilities();
        showToast(settingsResult.billingMode === 'platform_wallet'
          ? '已切换为本站积分。' : '已保存视频 API 配置。', 'success');
        return;
      }
      state.awaitingConfigRefresh = true;
      showToast('已打开豆包 / 火山方舟配置。保存后回到本页会自动刷新能力。', 'success');
    } catch (error) {
      showToast('无法打开视频 API 配置：' + safeErrorMessage(error), 'error');
    } finally {
      state.configOpenPending = false;
      dom.openApiSettings.disabled = false;
    }
  }

  function refreshAfterConfigReturn() {
    if (!state.awaitingConfigRefresh || state.configOpenPending) return;
    state.awaitingConfigRefresh = false;
    refreshCapabilities({ toast: true });
  }

  function normalizeModelCatalog(payload) {
    var source = payload || {};
    var capabilities = source.capabilities || source.data || source;
    var rawModels = source.models || capabilities.models || capabilities.modelCatalog || null;
    var mappings = source.providerModels || source.modelMappings || capabilities.providerModels || capabilities.modelMappings || null;
    var defaults = defaultModelCatalog();

    if (!rawModels && mappings && typeof mappings === 'object') {
      rawModels = Object.keys(Contract.MODEL_DISPLAY_NAMES).map(function fromMap(productKey) {
        return {
          productKey: productKey,
          providerModel: cleanText(mappings[productKey]),
          configured: !!cleanText(mappings[productKey])
        };
      });
    }

    if (!rawModels || (!Array.isArray(rawModels) && typeof rawModels !== 'object')) {
      return defaults;
    }

    var normalizedArray = Array.isArray(rawModels)
      ? rawModels
      : Object.keys(rawModels).map(function objectModel(key) {
          var value = rawModels[key];
          if (typeof value === 'string') return { productKey: key, providerModel: value, configured: !!value };
          return Object.assign({ productKey: key }, value || {});
        });

    return defaults.map(function merge(base) {
      var item = normalizedArray.find(function findModel(candidate) {
        var key = Contract.normalizeModelKey(candidate && (candidate.productKey || candidate.modelKey || candidate.id || candidate.key));
        return key === base.productKey;
      });
      if (!item) {
        base.configured = false;
        base.providerModel = '';
        base.providerModelConfigured = false;
        return base;
      }

      var providerModel = cleanText(item.providerModel || item.providerModelId || item.modelId || item.mapping);
      var explicitlyConfigured = item.configured === true || item.available === true || item.enabled === true;
      var explicitlyUnavailable = item.configured === false || item.available === false || item.enabled === false;
      base.providerModel = providerModel;
      base.providerModelConfigured = item.providerModelConfigured === false ? false : !!providerModel;
      base.configured = explicitlyUnavailable ? false : (explicitlyConfigured || !!providerModel);
      var itemLimits = item.limits || item.capabilities || item;
      base.resolutions = normalizeAllowedList(itemLimits.resolutions || itemLimits.supportedResolutions, base.resolutions);
      base.ratios = normalizeAllowedList(itemLimits.ratios || itemLimits.supportedRatios, base.ratios);
      base.minDuration = clamp(itemLimits.minDuration || itemLimits.minDurationSeconds || base.minDuration || 4, 4, 30);
      base.maxDuration = clamp(itemLimits.maxDuration || itemLimits.maxDurationSeconds || base.maxDuration || 15, base.minDuration, 30);
      base.nativePlatform = item.nativePlatform === true && (source.provider || capabilities.provider) === 'shaozhuang-native';
      base.billingMode = base.nativePlatform && (item.billingMode === 'prepaid_quote' || source.billingMode === 'prepaid_quote' || capabilities.billingMode === 'prepaid_quote') ? 'prepaid_quote' : base.nativePlatform && (['prepaid_quote', 'direct_usage'].indexOf(item.billingMode) >= 0 || ['prepaid_quote', 'direct_usage'].indexOf(source.billingMode) >= 0 || ['prepaid_quote', 'direct_usage'].indexOf(capabilities.billingMode) >= 0) ? 'direct_usage' : '';
      base.submissionQuotes = base.nativePlatform && Array.isArray(item.submissionQuotes) ? item.submissionQuotes.slice() : [];
      base.reservationCents = ['prepaid_quote', 'direct_usage'].indexOf(base.billingMode) >= 0 ? 0 : base.nativePlatform && Number.isSafeInteger(item.reservationCents) && item.reservationCents > 0 ? item.reservationCents : null;
      base.allowedDurations = base.nativePlatform && Array.isArray(itemLimits.durations)
        ? Array.from(new Set(itemLimits.durations.filter(function (value) { return Number.isInteger(value) && value >= base.minDuration && value <= base.maxDuration; }))).sort(function (a, b) { return a - b; }) : [];
      base.generateAudio = !base.nativePlatform || itemLimits.generateAudio !== false;
      base.imageMax = Math.max(0, Number(itemLimits.imageMax || base.imageMax || 0));
      base.videoMax = Math.max(0, Number(itemLimits.videoMax || base.videoMax || 0));
      base.audioMax = Math.max(0, Number(itemLimits.audioMax || base.audioMax || 0));
      base.maxAssets = Math.max(0, Number(itemLimits.maxAssets || base.maxAssets || 0));
      var rate = Number(item.creditsPerSecond || item.costPerSecond || item.creditRate);
      base.creditsPerSecond = Number.isFinite(rate) && rate >= 0 ? rate : null;
      return base;
    });
  }

  function normalizeAllowedList(raw, allowed) {
    if (!Array.isArray(raw) || !raw.length) return allowed.slice();
    var values = raw.map(String).filter(function included(value) { return allowed.indexOf(value) >= 0; });
    return values.length ? values : allowed.slice();
  }

  function renderRuntimeStatus(tone, text) {
    dom.runtimeStatus.className = 'runtime-status is-' + tone;
    dom.runtimeStatusText.textContent = text;
  }

  function getSelectedModel() {
    return state.modelCatalog.find(function selected(model) {
      return model.productKey === state.settings.productKey;
    }) || state.modelCatalog[0];
  }

  function credentialIssueMessage() {
    var backendMessage = state.credentialStatus && cleanText(state.credentialStatus.message);
    return backendMessage || '当前账号尚未保存豆包 / 火山方舟 API 配置，请点击“配置视频 API”。';
  }

  function renderModelCatalog() {
    var current = state.settings.productKey;
    dom.modelSelect.replaceChildren();
    state.modelCatalog.forEach(function optionFor(model) {
      var option = document.createElement('option');
      option.value = model.productKey;
      option.textContent = model.displayName + (model.configured ? '' : ' · 需配置');
      dom.modelSelect.appendChild(option);
    });
    if (state.modelCatalog.some(function exists(item) { return item.productKey === current; })) {
      dom.modelSelect.value = current;
    } else {
      state.settings.productKey = state.modelCatalog[0].productKey;
      dom.modelSelect.value = state.settings.productKey;
    }

    syncParameterControlsForModel();

    var selected = getSelectedModel();
    if (!state.backendConnected) {
      dom.modelHelp.textContent = state.capabilityError || '后台能力未接入，禁止真实提交。';
      dom.modelHelp.className = 'field-help is-error';
    } else if (state.credentialAvailable === false) {
      dom.modelHelp.textContent = credentialIssueMessage() + (state.analysisAvailable === true ? ' 可先完成脚本分析。' : '');
      dom.modelHelp.className = 'field-help is-error';
    } else if (selected && selected.providerModelConfigured === false) {
      dom.modelHelp.textContent = selected.displayName + ' 缺少可信供应商模型 ID 映射；不会静默降级。';
      dom.modelHelp.className = 'field-help is-error';
    } else if (!selected || !selected.configured) {
      dom.modelHelp.textContent = (selected ? selected.displayName : '当前模型') + ' 的当前账号配置不可用；不会静默降级。';
      dom.modelHelp.className = 'field-help is-error';
    } else {
      dom.modelHelp.textContent = selected.displayName + ' 已由后台映射；' +
        (selected.nativePlatform ? selected.allowedDurations.join(' / ') : selected.minDuration + '–' + selected.maxDuration) + ' 秒，' + selected.resolutions.join(' / ') +
        '，素材上限 ' + selected.imageMax + ' 图 / ' + selected.videoMax + ' 视频 / ' + selected.audioMax + ' 音频。' +
        (selected.nativePlatform && !selected.generateAudio ? ' 当前供应仅支持无声生成。' : '');
      dom.modelHelp.className = 'field-help is-success';
    }
  }

  function nativeDurations(model) {
    return model && model.nativePlatform && Array.isArray(model.allowedDurations) ? model.allowedDurations : [];
  }
  function snapDuration(value, model, minDuration, maxDuration) {
    value = clamp(Math.round(Number(value)), minDuration, maxDuration);
    var allowed = nativeDurations(model);
    return allowed.length ? allowed.reduce(function (best, duration) {
      return Math.abs(duration - value) < Math.abs(best - value) ? duration : best;
    }, allowed[0]) : value;
  }
  function readDurationControl() {
    var allowed = nativeDurations(getSelectedModel());
    return allowed.length ? allowed[clamp(Math.round(Number(dom.durationInput.value)), 0, allowed.length - 1)] : Number(dom.durationInput.value);
  }
  function writeDurationControl() {
    var model = getSelectedModel(), allowed = nativeDurations(model);
    dom.durationInput.min = String(allowed.length ? 0 : model.minDuration);
    dom.durationInput.max = String(allowed.length ? allowed.length - 1 : model.maxDuration);
    dom.durationInput.step = '1';
    dom.durationInput.value = String(allowed.length ? Math.max(0, allowed.indexOf(state.settings.durationSeconds)) : state.settings.durationSeconds);
    dom.durationInput.setAttribute('aria-valuetext', state.settings.durationSeconds + ' 秒');
  }

  function syncParameterControlsForModel() {
    var model = getSelectedModel();
    if (!model) return;
    var resolutions = Array.isArray(model.resolutions) && model.resolutions.length ? model.resolutions : ['720p'];
    var ratios = Array.isArray(model.ratios) && model.ratios.length ? model.ratios : Contract.RATIOS;
    document.querySelectorAll('input[name="resolution"]').forEach(function resolutionControl(input) {
      input.disabled = resolutions.indexOf(input.value) < 0;
      input.closest('label').classList.toggle('is-disabled', input.disabled);
    });
    if (resolutions.indexOf(state.settings.resolution) < 0) state.settings.resolution = resolutions[0];
    setRadio('resolution', state.settings.resolution);
    if (dom.resolutionHelp) {
      if (model.nativePlatform) {
        dom.resolutionHelp.textContent = '当前平台供应支持 ' + resolutions.join(' / ') + '；以实际生成原件为准。';
      } else if (model.productKey === 'seedance-2.5') {
        dom.resolutionHelp.textContent = 'Seedance 2.5 支持 480P / 720P / 1080P；1080P 为 10-bit H.265，部分浏览器可能无法直接预览。';
      } else {
        dom.resolutionHelp.textContent = 'Seedance 2.0 支持 480P / 720P / 1080P / 4K；4K 为 10-bit H.265，部分浏览器可能无法直接预览。';
      }
    }

    document.querySelectorAll('input[name="aspect-ratio"]').forEach(function ratioControl(input) {
      input.disabled = ratios.indexOf(input.value) < 0;
      input.closest('label').classList.toggle('is-disabled', input.disabled);
    });
    if (ratios.indexOf(state.settings.ratio) < 0) state.settings.ratio = ratios[0];
    setRadio('aspect-ratio', state.settings.ratio);

    var minDuration = clamp(Number(model.minDuration || 4), 4, 30);
    var maxDuration = clamp(Number(model.maxDuration || 15), minDuration, 30);
    state.settings.durationSeconds = snapDuration(state.settings.durationSeconds, model, minDuration, maxDuration);
    writeDurationControl();
    document.querySelectorAll('input[name="audio-mode"]').forEach(function audioControl(input) {
      input.disabled = model.nativePlatform && !model.generateAudio && input.value !== 'silent';
      input.closest('label').classList.toggle('is-disabled', input.disabled);
    });
    if (model.nativePlatform && !model.generateAudio) {
      state.settings.audioMode = 'silent'; state.settings.narrationLanguage = '';
      dom.narrationSettings.hidden = true; dom.audioConstraintNote.hidden = true;
    }
    setRadio('audio-mode', state.settings.audioMode);
    dom.durationOutput.textContent = state.settings.durationSeconds + ' 秒';
    syncDurationRangeVisual(minDuration, maxDuration);
    syncDurationPresetState(minDuration, maxDuration);
    var labels = dom.durationInput.parentElement && dom.durationInput.parentElement.querySelectorAll('.range-labels span');
    if (labels && labels.length >= 2) {
      labels[0].textContent = minDuration + ' 秒';
      labels[1].textContent = maxDuration + ' 秒';
    }
  }

  function syncDurationPresetState(minDuration, maxDuration) {
    if (!dom.durationPresets) return;
    var model = getSelectedModel();
    minDuration = Number(minDuration == null ? model.minDuration : minDuration);
    maxDuration = Number(maxDuration == null ? model.maxDuration : maxDuration);
    dom.durationPresets.querySelectorAll('[data-duration-seconds]').forEach(function presetState(button) {
      var duration = Number(button.dataset.durationSeconds);
      button.disabled = duration < minDuration || duration > maxDuration || (nativeDurations(model).length > 0 && nativeDurations(model).indexOf(duration) < 0);
      button.setAttribute('aria-pressed', String(!button.disabled && duration === state.settings.durationSeconds));
    });
  }

  function syncDurationRangeVisual(minDuration, maxDuration) {
    var model = getSelectedModel();
    minDuration = Number(minDuration == null ? model.minDuration : minDuration);
    maxDuration = Number(maxDuration == null ? model.maxDuration : maxDuration);
    var span = Math.max(1, maxDuration - minDuration);
    var allowed = nativeDurations(model);
    var progress = allowed.length ? Math.max(0, allowed.indexOf(state.settings.durationSeconds)) / Math.max(1, allowed.length - 1) * 100 : ((state.settings.durationSeconds - minDuration) / span) * 100;
    dom.durationInput.style.setProperty('--range-progress', clamp(progress, 0, 100) + '%');
  }

  function localUploadSupported(kind) {
    if (usingProductionPlan() && kind === 'audio') return true;
    if (usingProductionPlan() && state.productionOptions.mode === 'economic') return true;
    if (!state.backendConnected || !state.capabilities || !Array.isArray(state.capabilities.localAssets)) {
      return kind !== 'video';
    }
    var values = state.capabilities.localAssets;
    return values.indexOf(kind) >= 0 || values.indexOf(kind + '-data-url') >= 0;
  }

  function submissionQuote(model, request) {
    if (!model || !model.nativePlatform || !Array.isArray(model.submissionQuotes)) return null;
    request = request || state.settings;
    var hasVideoInput = Array.isArray(request.videos) ? request.videos.length > 0 : state.assets.video.length > 0;
    var matched = model.submissionQuotes.find(function (quote) { return quote && quote.duration === Number(request.durationSeconds) &&
      quote.resolution === request.resolution && quote.ratio === request.ratio && quote.hasVideoInput === hasVideoInput && Number.isSafeInteger(quote.quoteCents) && quote.quoteCents > 0; });
    return matched ? matched.quoteCents : null;
  }

  function updateEstimate() {
    renderProductionOptions();
    updateCreditAnnotations();
    if (usingProductionPlan()) {
      if (state.productionOptions.mode === 'economic' && state.productionOptions.hybridAiSeconds === 0) {
        dom.creditEstimate.textContent = '本地合成';
        dom.estimateNote.textContent = '使用已有素材，在本地剪辑与合成。';
      } else {
        try {
          var productionPlan = previewProductionPlan();
          var holds = productionPlan.shots.filter(function (shot) { return shot.kind === 'ai'; }).map(function (shot) { return state.modelCatalog.find(function (entry) { return entry.productKey === shot.productKey; }); });
          var directUsage = holds.length > 0 && holds.every(function (entry) { return entry && entry.nativePlatform && ['prepaid_quote', 'direct_usage'].indexOf(entry.billingMode) >= 0; });
          var knownHolds = holds.length > 0 && holds.every(function (entry) { return entry && entry.nativePlatform && entry.billingMode === 'reservation' && Number.isSafeInteger(entry.reservationCents) && entry.reservationCents > 0; });
          var quotes = productionPlan.shots.filter(function (shot) { return shot.kind === 'ai'; }).map(function (shot) { return submissionQuote(state.modelCatalog.find(function (entry) { return entry.productKey === shot.productKey; }), shot.request); });
          var totalQuote = quotes.length > 0 && quotes.every(function (quote) { return quote !== null; }) ? quotes.reduce(function (sum, quote) { return sum + quote; }, 0) : null;
          dom.creditEstimate.textContent = directUsage ? totalQuote !== null ? '生成 · ' + (totalQuote / 10) + ' 积分' : '提交时扣报价积分' : knownHolds ? '每个 AI 镜头预占最高 ' + (Math.max.apply(null, holds.map(function (entry) { return entry.reservationCents; })) / 10) + ' 积分' : '每镜平台预占以能力回执为准';
          dom.estimateNote.textContent = directUsage ? '按镜头依次生成，每镜提交时扣其报价积分；失败镜头退回，取消不退。'
            : '按镜头依次生成；每镜完成后按实际用量结算并释放剩余预占，预占不代表最终费用。上游人民币预算另列。';
        } catch (_) {
          var selected = getSelectedModel();
          dom.creditEstimate.textContent = selected && selected.nativePlatform && ['prepaid_quote', 'direct_usage'].indexOf(selected.billingMode) >= 0 ? '提交时扣报价积分' : '成片费用待确认';
          dom.estimateNote.textContent = selected && selected.nativePlatform && ['prepaid_quote', 'direct_usage'].indexOf(selected.billingMode) >= 0 ? '先补齐方案素材与参数，再核对本次报价；提交时扣积分，失败退回，取消不退。' : '先补齐方案素材与参数，再核对每镜预占积分及上游人民币预算。';
        }
      }
      return;
    }
    var model = getSelectedModel();
    if (globalThis.SZCreativeCredits && (!model || !model.nativePlatform)) {
      var legacyQuote = globalThis.SZCreativeCredits.describe(videoCreditSpec(state.mode !== 'direct'));
      dom.creditEstimate.textContent = legacyQuote.text; dom.estimateNote.textContent = legacyQuote.detail;
      return;
    }
    if (!state.backendConnected || !model || !model.configured) {
      dom.creditEstimate.textContent = state.credentialAvailable === false
        ? '账号 API 未配置'
        : (model && !model.configured ? '模型需配置' : '等待能力返回');
      dom.estimateNote.textContent = '后台未确认前不显示推测价格';
      return;
    }
    if (model.nativePlatform) {
      if (['prepaid_quote', 'direct_usage'].indexOf(model.billingMode) >= 0) {
        var quoted = submissionQuote(model);
        dom.creditEstimate.textContent = quoted !== null ? '生成 · ' + (quoted / 10) + ' 积分' : '提交时扣报价积分';
        dom.estimateNote.textContent = '提交时扣本次报价积分；生成失败退回，取消不退';
      } else if (model.billingMode === 'reservation' && Number.isSafeInteger(model.reservationCents) && model.reservationCents > 0) {
        dom.creditEstimate.textContent = '预占 ' + (model.reservationCents / 10) + ' 积分';
        dom.estimateNote.textContent = '提交时预占，完成后按实际用量结算并释放剩余；预占不代表最终费用。';
      } else {
        dom.creditEstimate.textContent = '本次报价待确认';
        dom.estimateNote.textContent = '等待平台返回本次报价，提交时扣积分；生成失败退回，取消不退。';
      }
      return;
    }
    if (!(model.creditsPerSecond > 0)) {
      dom.creditEstimate.textContent = '由生成服务返回';
      dom.estimateNote.textContent = '最终消耗以生成服务回执为准';
      return;
    }
    var estimate = model.creditsPerSecond * state.settings.durationSeconds;
    dom.creditEstimate.textContent = (Math.round(estimate * 100) / 100) + ' 积分';
    dom.estimateNote.textContent = model.creditsPerSecond + ' 积分/秒 · 仅按能力回执估算';
  }

  function videoCreditSpec(extraAnalysis) {
    var model = state.modelCatalog.find(function (item) { return item.productKey === state.settings.productKey; });
    var nativePlatform = !!(model && model.nativePlatform);
    var billingMode = model && model.billingMode;
    return { kind: 'video', model: model && model.providerModelConfigured ? model.providerModel : '',
      count: 1, channel: nativePlatform ? 'platform_wallet' : 'external_key', extraAnalysis: !!extraAnalysis,
      nativePlatform: nativePlatform, billingMode: billingMode, quoteCents: submissionQuote(model),
      reservationPoints: nativePlatform && billingMode === 'reservation' && Number.isSafeInteger(model.reservationCents) && model.reservationCents > 0 ? model.reservationCents / 10 : undefined };
  }

  function retryCreditSpec(run) {
    if (!run) return { kind: 'local' };
    var model = state.modelCatalog.find(function (item) { return item.productKey === run.productKey; });
    var nativePlatform = run.nativePlatform === true || run.provider === 'shaozhuang-native' || run.adapter === 'sanjie-native';
    var billingMode = nativePlatform && model && model.billingMode;
    return { kind: run.purpose === 'analysis' ? 'chat' : 'video', model: cleanText(run.providerModel),
      count: 1, channel: nativePlatform ? 'platform_wallet' : 'external_key',
      nativePlatform: nativePlatform, billingMode: billingMode,
      reservationPoints: nativePlatform && billingMode === 'reservation' && model && model.providerModel === run.providerModel && Number.isSafeInteger(model.reservationCents) && model.reservationCents > 0 ? model.reservationCents / 10 : undefined,
      detail: ['prepaid_quote', 'direct_usage'].indexOf(billingMode) >= 0 ? '重新提交原任务；提交时按新报价扣积分，生成失败退回，取消不退' : '重新提交原任务；最终费用以实际用量结算为准' };
  }

  function productionCreditSpec(plan, shots) {
    var ai = (shots || plan && plan.shots || []).filter(function (shot) { return shot.kind === 'ai'; });
    if (!ai.length) return { kind: 'local' };
    var models = ai.map(function (shot) { return state.modelCatalog.find(function (model) { return model.productKey === shot.productKey; }); });
    var first = models[0];
    var sameModel = first && models.every(function (model) { return model && model.providerModel === first.providerModel; });
    var nativePlatform = models.every(function (model) { return model && model.nativePlatform; });
    var directUsage = nativePlatform && models.every(function (model) { return ['prepaid_quote', 'direct_usage'].indexOf(model.billingMode) >= 0; });
    var hasDirectUsage = models.some(function (model) { return model && model.nativePlatform && ['prepaid_quote', 'direct_usage'].indexOf(model.billingMode) >= 0; });
    var knownReservations = nativePlatform && !hasDirectUsage && models.every(function (model) { return model.billingMode === 'reservation' && Number.isSafeInteger(model.reservationCents) && model.reservationCents > 0; });
    return { kind: 'video', count: ai.length, model: sameModel && first.providerModelConfigured ? first.providerModel : '',
      channel: nativePlatform ? 'platform_wallet' : 'external_key',
      nativePlatform: nativePlatform, billingMode: directUsage ? 'prepaid_quote' : knownReservations ? 'reservation' : '',
      quoteCents: directUsage && ai.every(function (shot, index) { return submissionQuote(models[index], shot.request) !== null; }) ? ai.reduce(function (sum, shot, index) { return sum + submissionQuote(models[index], shot.request); }, 0) : undefined,
      reservationPoints: knownReservations ? Math.max.apply(null, models.map(function (model) { return model.reservationCents; })) / 10 : undefined,
      perRequestReservation: knownReservations && ai.length > 1,
      detail: '将提交 ' + ai.length + ' 个 AI 镜头' + (directUsage ? '，每镜提交时扣其报价积分，生成失败退回，取消不退' : nativePlatform && !hasDirectUsage ? '，逐镜预占并结算；预占不代表最终费用' : '') };
  }

  function productionRunCreditSpec(run, retryShotId) {
    if (!run || !run.plan) return { kind: 'local' };
    var pending = [];
    for (var i = 0; i < run.plan.shots.length; i += 1) {
      var definition = run.plan.shots[i];
      if (definition.kind !== 'ai') continue;
      var shot = run.shotRuns.find(function (item) { return item.id === definition.id; });
      if (!shot) break;
      var status = shot.id === retryShotId ? 'pending' : shot.status;
      if (status === 'failed' || status === 'cancelled') break;
      if (status === 'pending') pending.push(definition);
    }
    return productionCreditSpec(run.plan, pending);
  }

  function updateCreditAnnotations() {
    var credits = globalThis.SZCreativeCredits;
    if (!credits) return;
    var localProduction = usingProductionPlan() && state.productionOptions.mode === 'economic' && state.productionOptions.hybridAiSeconds === 0;
    var goesToReview = state.mode !== 'direct' && (state.review.state === 'editing' || state.review.state === 'confirmed');
    var generationSpec = videoCreditSpec(false);
    if (usingProductionPlan()) {
      try { generationSpec = productionCreditSpec(previewProductionPlan()); }
      catch (_) {
        var selected = getSelectedModel();
        generationSpec = localProduction ? { kind: 'local' } : { kind: 'video',
          channel: selected && selected.nativePlatform ? 'platform_wallet' : 'external_key',
          nativePlatform: !!(selected && selected.nativePlatform), billingMode: selected && selected.billingMode };
      }
    }
    credits.annotate(dom.primaryAction, localProduction || goesToReview ? { kind: 'local' }
      : state.mode === 'direct' ? generationSpec
      : { kind: 'chat', model: state.analysisModel, channel: state.analysisBillingChannel, detail: state.analysisBillingChannel === 'platform_wallet' ? '本次脚本分析提交时按报价扣积分，失败退回，取消不退' : '脚本分析由自有 API 服务计费' });
    credits.annotate(dom.confirmReview, generationSpec);
    credits.annotate(dom.retryJob, retryCreditSpec(state.activeRun));
    credits.annotate(dom.reanalyze, { kind: 'chat', model: state.analysisModel, channel: state.analysisBillingChannel, detail: state.analysisBillingChannel === 'platform_wallet' ? '重新分析提交时按本次报价扣积分，失败退回，取消不退' : '重新分析由自有 API 服务计费' });
    ['resetDraft', 'addShot', 'viewResult', 'openApiSettings', 'refreshCapabilities', 'refreshHistory'].forEach(function (key) {
      credits.annotate(dom[key], { kind: 'local' });
    });
    credits.annotate(dom.cancelJob, { kind: 'local' });
    credits.annotate(dom.productionResume, productionRunCreditSpec(state.productionRun));
    credits.annotate(dom.productionStop, { kind: 'local' });
  }

  function normalizeSettingsSnapshot(raw, options) {
    raw = raw || {};
    options = options || {};
    var mode = Contract.MODES[options.mode] ? options.mode : 'direct';
    var productKey = Contract.normalizeModelKey(raw.productKey) || 'seedance-2.0';
    var catalog = Array.isArray(options.modelCatalog) ? options.modelCatalog : [];
    var model = catalog.find(function matchingModel(item) {
      return item && item.productKey === productKey;
    });
    var limits = (model && (model.limits || model.capabilities)) || model || effectiveLimits(mode, productKey);
    var resolutions = Array.isArray(limits.resolutions) && limits.resolutions.length
      ? limits.resolutions
      : Contract.RESOLUTIONS;
    var ratios = Array.isArray(limits.ratios) && limits.ratios.length
      ? limits.ratios
      : Contract.RATIOS;
    var requestedResolution = cleanText(raw.resolution).toLowerCase();
    var resolution = resolutions.indexOf(requestedResolution) >= 0
      ? requestedResolution
      : (resolutions.indexOf('720p') >= 0 ? '720p' : resolutions[0]);
    var requestedRatio = cleanText(raw.ratio || raw.aspectRatio).toLowerCase();
    var ratio = ratios.indexOf(requestedRatio) >= 0
      ? requestedRatio
      : (ratios.indexOf('9:16') >= 0 ? '9:16' : ratios[0]);
    var minDuration = clamp(Number(limits.minDuration || 4), 4, 30);
    var maxDuration = clamp(Number(limits.maxDuration || 15), minDuration, 30);
    var rawDuration = raw.durationSeconds == null ? 15 : Number(raw.durationSeconds);
    var audioMode = Contract.AUDIO_MODES[raw.audioMode] ? raw.audioMode : 'sound_only';
    if (model && model.nativePlatform && model.generateAudio === false) audioMode = 'silent';
    var creativeRoute = cleanText(raw.creativeRoute || raw.route);
    if (!routeSupportsMode(creativeRoute, mode)) creativeRoute = defaultRouteForMode(mode);
    var styleProfile = cleanText(raw.styleProfile || raw.visualStyle);
    if (!styleDefinition(styleProfile)) styleProfile = 'commerce_studio';
    return {
      productKey: productKey,
      creativeRoute: creativeRoute,
      styleProfile: styleProfile,
      resolution: resolution,
      ratio: ratio,
      durationSeconds: snapDuration(rawDuration, model, minDuration, maxDuration),
      audioMode: audioMode,
      narrationLanguage: audioMode === 'narration' ? cleanText(raw.narrationLanguage || 'zh-CN') : ''
    };
  }

  function syncSettingsFromDom(options) {
    options = options || {};
    var previous = JSON.stringify(state.settings);
    var requested = Object.assign({}, state.settings, {
      productKey: dom.modelSelect.value,
      resolution: selectedRadio('resolution', state.settings.resolution || '720p'),
      ratio: selectedRadio('aspect-ratio', state.settings.ratio || '9:16'),
      durationSeconds: readDurationControl(),
      audioMode: selectedRadio('audio-mode', state.settings.audioMode || 'sound_only'),
      narrationLanguage: dom.narrationLanguage.value
    });
    state.settings = normalizeSettingsSnapshot(requested, {
      mode: state.mode,
      modelCatalog: state.modelCatalog
    });
    dom.durationOutput.textContent = state.settings.durationSeconds + ' 秒';
    dom.narrationSettings.hidden = state.settings.audioMode !== 'narration';
    dom.audioConstraintNote.hidden = state.settings.audioMode !== 'sound_only';
    renderModelCatalog();
    renderCreativeOptions();
    updateEstimate();

    if (!options.silent && previous !== JSON.stringify(state.settings)) {
      invalidateReviewForSourceChange('生成设置已变化，请重新分析后再确认脚本。');
      scheduleDraftSave();
    }
    renderMode();
    renderAssets();
    renderReadiness();
  }

  function syncDurationFromDom() {
    var previousDuration = state.settings.durationSeconds;
    state.settings = normalizeSettingsSnapshot(Object.assign({}, state.settings, {
      durationSeconds: readDurationControl()
    }), {
      mode: state.mode,
      modelCatalog: state.modelCatalog
    });
    writeDurationControl();
    dom.durationOutput.textContent = state.settings.durationSeconds + ' 秒';
    syncDurationRangeVisual();
    syncDurationPresetState();
    updateEstimate();
    if (previousDuration !== state.settings.durationSeconds) {
      invalidateReviewForSourceChange('生成设置已变化，请重新分析后再确认脚本。');
      scheduleDraftSave();
    }
    renderReadiness();
  }

  function applySettingsToDom() {
    dom.modelSelect.value = state.settings.productKey;
    setRadio('resolution', state.settings.resolution);
    setRadio('aspect-ratio', state.settings.ratio);
    dom.durationInput.value = String(state.settings.durationSeconds);
    setRadio('audio-mode', state.settings.audioMode);
    dom.narrationLanguage.value = state.settings.narrationLanguage || 'zh-CN';
    dom.durationOutput.textContent = state.settings.durationSeconds + ' 秒';
    dom.narrationSettings.hidden = state.settings.audioMode !== 'narration';
    dom.audioConstraintNote.hidden = state.settings.audioMode !== 'sound_only';
    renderModelCatalog();
    updateEstimate();
  }

  function serializeAsset(asset) {
    if (!asset) return null;
    var remoteUrl = safeRemoteAssetUrl(asset.remoteUrl);
    var storageRef = remoteUrl ? null : (asset.storageRef || {
      dbName: Store.DB_NAME,
      storeName: Store.ASSET_STORE,
      id: asset.id
    });
    var summary = {
      id: asset.id,
      kind: asset.kind,
      name: asset.name,
      mimeType: asset.mimeType,
      size: asset.size,
      durationSec: asset.durationSec == null ? null : Number(asset.durationSec),
      width: asset.width == null ? null : Number(asset.width),
      height: asset.height == null ? null : Number(asset.height),
      role: asset.role || 'asset',
      finalAudioRole: asset.finalAudioRole,
      finalAudioVolume: asset.finalAudioVolume,
      finalAudioLoop: asset.finalAudioLoop,
      referenceVideoId: asset.referenceVideoId || '',
      timeSec: asset.timeSec == null ? null : Number(asset.timeSec),
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
      remoteUrl: remoteUrl,
      storageRef: storageRef
    };
    if (asset.trustedPortrait) summary.trustedPortrait = { uri: String(asset.trustedPortrait.uri || '').slice(0, 256), accountKey: cleanText(asset.trustedPortrait.accountKey).slice(0, 256) };
    if (asset.kind === 'image') {
      summary.materialKind = materialKind(asset);
      if (asset.registration) summary.registration = registrationMetadata(asset.registration);
    }
    return summary;
  }

  function serializeReview(review) {
    return {
      state: review.state,
      analysis: review.analysis,
      script: review.script,
      storyboard: review.storyboard.map(function cloneShot(shot) {
        return {
          id: shot.id,
          visual: shot.visual,
          narration: shot.narration,
          startSecond: Number(shot.startSecond || 0),
          endSecond: Number(shot.endSecond || 0),
          durationSeconds: Number(shot.durationSeconds),
          composition: shot.composition || '',
          camera: shot.camera || '',
          motion: shot.motion || '',
          rhythm: shot.rhythm || '',
          audioRole: shot.audioRole || '',
          reconstructionIntent: shot.reconstructionIntent || ''
        };
      }),
      analysisFingerprint: review.analysisFingerprint,
      confirmed: review.confirmed,
      confirmedAt: review.confirmedAt
    };
  }

  function draftSnapshot() {
    return {
      schemaVersion: 2,
      productionOptions: Object.assign({}, state.productionOptions),
      productionAudio: Object.assign({}, state.productionAudio),
      legacySingle: state.legacySingle,
      mode: state.mode,
      prompt: state.prompt,
      expertEnabled: state.mode !== 'direct' && state.expertEnabled,
      expertRequirements: state.mode !== 'direct' && state.expertEnabled ? state.expertRequirements : '',
      assets: {
        image: state.assets.image.map(serializeAsset),
        video: state.assets.video.map(serializeAsset),
        audio: state.assets.audio.map(serializeAsset)
      },
      reference: serializeAsset(state.reference),
      referenceFrames: state.referenceFrames.map(serializeAsset),
      rightsConfirmed: state.rightsConfirmed,
      rightsConfirmedAt: state.rightsConfirmedAt,
      rightsFingerprint: state.rightsFingerprint,
      portraitAuthorization: currentPortraitAuthorization(),
      portraitStartRequest: state.portraitStartRequest && state.portraitStartRequest.accountKey === state.accountKey ? Object.assign({}, state.portraitStartRequest) : null,
      settings: Object.assign({}, state.settings),
      review: serializeReview(state.review)
    };
  }

  function scheduleDraftSave() {
    if (!state.booted) return;
    if (state.draftTimer) globalThis.clearTimeout(state.draftTimer);
    state.draftTimer = globalThis.setTimeout(function persistLater() {
      state.draftTimer = null;
      saveCurrentDraft().catch(function onDraftError(error) {
        showToast('草稿保存失败：' + safeErrorMessage(error), 'error');
      });
    }, 320);
  }

  function saveCurrentDraft() {
    if (state.draftTimer) {
      globalThis.clearTimeout(state.draftTimer);
      state.draftTimer = null;
    }
    return Store.saveDraft(state.mode, draftSnapshot());
  }

  function revokePreview(asset) {
    if (!asset || !asset.previewUrl) return;
    if (!asset.remoteUrl) {
      try { URL.revokeObjectURL(asset.previewUrl); } catch (_) { /* noop */ }
      state.previewUrls.delete(asset.previewUrl);
    }
    asset.previewUrl = '';
  }

  function revokeAllPreviews() {
    state.previewUrls.forEach(function revoke(url) {
      try { URL.revokeObjectURL(url); } catch (_) { /* noop */ }
    });
    state.previewUrls.clear();
  }

  async function hydrateAsset(summary) {
    if (!summary || !summary.id) return null;
    var remoteUrl = safeRemoteAssetUrl(summary.remoteUrl);
    if (remoteUrl) {
      var remote = Object.assign({}, serializeAsset(Object.assign({}, summary, {
        remoteUrl: remoteUrl,
        storageRef: null
      })));
      remote.remoteUrl = remoteUrl;
      remote.storageRef = null;
      remote.previewUrl = remoteUrl;
      return remote;
    }
    try {
      var record = await Store.getAsset(summary.id);
      if (!record || !(record.blob instanceof Blob)) return null;
      var hydrated = Object.assign({}, serializeAsset(Object.assign({}, record, {
        finalAudioRole: summary.finalAudioRole, finalAudioVolume: summary.finalAudioVolume, finalAudioLoop: summary.finalAudioLoop,
        trustedPortrait: summary.trustedPortrait, materialKind: summary.materialKind, registration: summary.registration
      })));
      hydrated.previewUrl = URL.createObjectURL(record.blob);
      state.previewUrls.add(hydrated.previewUrl);
      return hydrated;
    } catch (_) {
      return null;
    }
  }

  async function hydrateList(items) {
    var results = await Promise.all((items || []).map(hydrateAsset));
    return results.filter(Boolean);
  }

  async function restoreDraft(mode) {
    revokeAllPreviews();
    state.assets = { image: [], video: [], audio: [] };
    state.reference = null;
    state.referenceFrames = [];
    state.prompt = '';
    state.expertEnabled = false;
    state.expertRequirements = '';
    state.rightsConfirmed = false;
    state.rightsConfirmedAt = '';
    state.rightsFingerprint = '';
    state.portraitAuthorization = null;
    state.portraitStartRequest = null;
    state.review = freshReview();
    state.settings = {
      productKey: 'seedance-2.0',
      creativeRoute: defaultRouteForMode(mode),
      styleProfile: 'commerce_studio',
      resolution: '720p',
      ratio: '9:16',
      durationSeconds: 15,
      audioMode: 'sound_only',
      narrationLanguage: 'zh-CN'
    };

    state.productionOptions = { mode: 'economic', totalDurationSeconds: 15, hybridAiSeconds: 0, budgetYuan: 10, maxAttempts: 1 };
    state.productionAudio = { sourceAudioVolume: 0 };
    state.legacySingle = false;
    var record = null;
    try { record = await Store.getDraft(mode); } catch (error) {
      showToast('读取本地草稿失败：' + safeErrorMessage(error), 'error');
    }
    var draft = record && record.data;
    if (draft && draft.mode === mode) {
      state.prompt = cleanText(draft.prompt);
      state.expertEnabled = draft.expertEnabled === true;
      state.expertRequirements = cleanText(draft.expertRequirements);
      state.settings = normalizeDraftSettings(draft.settings);
      state.legacySingle = draft.productionOptions ? draft.legacySingle === true : true;
      state.productionOptions = normalizeProductionOptions(draft.productionOptions || { mode: 'quality', totalDurationSeconds: 15, budgetYuan: 10, maxAttempts: 1 });
      state.productionAudio = normalizeProductionAudio(draft.productionAudio);
      state.assets.image = await hydrateList(draft.assets && draft.assets.image);
      state.assets.video = await hydrateList(draft.assets && draft.assets.video);
      state.assets.audio = await hydrateList(draft.assets && draft.assets.audio);
      state.reference = await hydrateAsset(draft.reference);
      state.referenceFrames = await hydrateList(draft.referenceFrames);
      state.review = normalizeDraftReview(draft.review);
      if (draft.portraitAuthorization && draft.portraitAuthorization.accountKey === state.accountKey) state.portraitAuthorization = authorizationMetadata(draft.portraitAuthorization, state.accountKey);
      if (draft.portraitStartRequest && draft.portraitStartRequest.accountKey === state.accountKey && /^[a-zA-Z0-9_-]{1,160}$/.test(draft.portraitStartRequest.idempotencyKey || '')) state.portraitStartRequest = { accountKey: state.accountKey, idempotencyKey: draft.portraitStartRequest.idempotencyKey };

      var fingerprint = assetRightsFingerprint();
      if (draft.rightsConfirmed === true && draft.rightsFingerprint === fingerprint) {
        state.rightsConfirmed = true;
        state.rightsConfirmedAt = cleanText(draft.rightsConfirmedAt);
        state.rightsFingerprint = fingerprint;
      }
    }

    trimDisallowedAssetsForMode();
    if (state.rightsConfirmed && state.rightsFingerprint !== assetRightsFingerprint()) {
      state.rightsConfirmed = false;
      state.rightsConfirmedAt = '';
      state.rightsFingerprint = '';
    }
    applyDraftToDom();
    renderProductionOptions();
  }

  function startupImportQuery() {
    try {
      var url = new URL(globalThis.location.href);
      var sourceValues = url.searchParams.getAll('source');
      var tokenValues = url.searchParams.getAll('importToken');
      if (sourceValues.length !== 1 || tokenValues.length !== 1 ||
          sourceValues[0] !== MAIN_MEDIA_IMPORT_SOURCE || !/^[a-f0-9]{48}$/.test(tokenValues[0])) return null;
      return { source: sourceValues[0], importToken: tokenValues[0] };
    } catch (_) {
      return null;
    }
  }

  function normalizeImportedRemoteAsset(raw, kind, index) {
    raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    var remoteUrl = safeRemoteAssetUrl(raw.remoteUrl || raw.url);
    if (!remoteUrl) return null;
    var mimeType = cleanText(raw.mimeType || raw.type).toLowerCase();
    if (kind === 'image' && !/^image\/(?:jpeg|png|webp|avif)$/.test(mimeType)) return null;
    if (kind === 'video' && !/^video\/(?:mp4|webm|quicktime|x-m4v)$/.test(mimeType)) return null;
    var size = Number(raw.size || 0);
    var duration = Number(raw.durationSeconds == null ? raw.durationSec || 0 : raw.durationSeconds);
    return {
      id: makeId('taobao-' + kind),
      kind: kind,
      name: cleanText(raw.name || ('淘宝主图' + (kind === 'video' ? '视频 ' : ' ') + (index + 1))).slice(0, 260),
      mimeType: mimeType,
      size: Number.isSafeInteger(size) && size >= 0 ? size : 0,
      durationSec: Number.isFinite(duration) && duration >= 0 ? duration : 0,
      width: Number.isFinite(Number(raw.width)) && Number(raw.width) > 0 ? Number(raw.width) : null,
      height: Number.isFinite(Number(raw.height)) && Number(raw.height) > 0 ? Number(raw.height) : null,
      role: defaultAssetRole(kind, index),
      referenceVideoId: '',
      timeSec: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      remoteUrl: remoteUrl,
      storageRef: null,
      previewUrl: remoteUrl
    };
  }

  function mergeRemoteAssetLists(existing, incoming, max) {
    var output = Array.isArray(existing) ? existing.slice(0, max) : [];
    var seen = Object.create(null);
    output.forEach(function remember(asset) {
      var url = safeRemoteAssetUrl(asset && asset.remoteUrl);
      if (url) seen[url] = true;
    });
    (incoming || []).forEach(function append(asset) {
      if (!asset || output.length >= max) return;
      var url = safeRemoteAssetUrl(asset.remoteUrl);
      if (!url || seen[url]) return;
      seen[url] = true;
      output.push(asset);
    });
    return output;
  }

  async function claimStartupMediaImport() {
    var query = startupImportQuery();
    if (!query) return { claimed: false, addedImages: 0, addedVideos: 0 };
    var response = await sendRuntimeMessage(MESSAGE.IMPORT_MEDIA_CLAIM, query, RUNTIME_TIMEOUT_MS.importMedia);
    var payload = responsePayload(response);
    var rawImages = Array.isArray(payload.images) ? payload.images.slice(0, 9) : [];
    var rawVideos = Array.isArray(payload.videos) ? payload.videos.slice(0, 3) : [];
    var importedImages = rawImages.map(function imageAsset(item, index) {
      return normalizeImportedRemoteAsset(item, 'image', index);
    }).filter(Boolean);
    var importedVideos = rawVideos.map(function videoAsset(item, index) {
      return normalizeImportedRemoteAsset(item, 'video', index);
    }).filter(Boolean);
    if (!importedImages.length) throw new Error('导入上下文未包含可用的商品主图。');

    var previousImageCount = state.assets.image.length;
    var previousVideoCount = state.assets.video.length;
    var importLimits = effectiveLimits('direct', state.settings.productKey);
    state.assets.image = mergeRemoteAssetLists(state.assets.image, importedImages, importLimits.imageMax);
    state.assets.video = mergeRemoteAssetLists(state.assets.video, importedVideos, importLimits.videoMax);
    var addedImages = state.assets.image.length - previousImageCount;
    var addedVideos = state.assets.video.length - previousVideoCount;

    if (!state.prompt) state.prompt = NEUTRAL_IMPORT_PROMPT;
    state.rightsConfirmed = false;
    state.rightsConfirmedAt = '';
    state.rightsFingerprint = '';
    state.review = freshReview();
    applyDraftToDom();
    await saveCurrentDraft();
    showToast('已导入 ' + addedImages + ' 张主图、' + addedVideos + ' 个主图视频；请检查素材并确认权利后手动生成。', 'success');
    return { claimed: true, addedImages: addedImages, addedVideos: addedVideos };
  }

  function normalizeDraftSettings(raw) {
    return normalizeSettingsSnapshot(raw, {
      mode: state.mode,
      modelCatalog: state.modelCatalog
    });
  }

  function normalizeDraftReview(raw) {
    if (!raw || typeof raw !== 'object') return freshReview();
    return {
      state: ['idle', 'analyzing', 'editing', 'confirmed', 'stale'].indexOf(raw.state) >= 0 ? raw.state : 'idle',
      analysis: cleanText(raw.analysis),
      script: cleanText(raw.script),
      storyboard: normalizeStoryboard(raw.storyboard),
      analysisFingerprint: cleanText(raw.analysisFingerprint),
      confirmed: raw.confirmed === true,
      confirmedAt: cleanText(raw.confirmedAt)
    };
  }

  function trimDisallowedAssetsForMode() {
    if (usingProductionPlan() && state.productionOptions.mode === 'economic') return;
    var limits = effectiveLimits(state.mode, state.settings.productKey);
    state.assets.image = state.assets.image.slice(0, limits.imageMax || 0);
    state.assets.video = state.assets.video.slice(0, limits.videoMax || 0);
    if (!usingProductionPlan()) state.assets.audio = state.assets.audio.slice(0, limits.audioMax || 0);
    if (state.mode !== 'remix') state.reference = null;
    if (state.mode !== 'remix') state.referenceFrames = [];
    if (state.reference) {
      state.referenceFrames = state.referenceFrames.filter(function sameReference(frame) {
        return !frame.referenceVideoId || frame.referenceVideoId === state.reference.id;
      }).slice(0, 5);
    } else {
      state.referenceFrames = [];
    }
  }

  function applyDraftToDom() {
    dom.promptInput.value = state.prompt;
    dom.promptCount.textContent = state.prompt.length + ' / 2000';
    dom.expertModeEnabled.checked = state.expertEnabled;
    dom.expertRequirements.value = state.expertRequirements;
    dom.expertCount.textContent = state.expertRequirements.length + ' / 8000';
    dom.expertRequirementsWrap.hidden = !state.expertEnabled;
    dom.rightsConfirmed.checked = state.rightsConfirmed;
    applySettingsToDom();
    renderMode();
    renderAssets();
    renderReference();
    renderReview();
    renderReadiness();
  }

  function assetRightsFingerprint() {
    var source = {
      mode: state.mode,
      images: state.assets.image,
      videos: state.assets.video,
      audios: state.assets.audio,
      referenceVideo: state.reference,
      referenceFrames: state.referenceFrames
    };
    var base = typeof Contract.assetRightsFingerprint === 'function'
      ? Contract.assetRightsFingerprint(source)
      : Contract.fingerprint(source, 'rights_');
    var portraits = state.assets.image.filter(function (asset) { return !!asset.trustedPortrait; }).map(function (asset) {
      return { id: asset.id, uri: asset.trustedPortrait.uri, accountKey: asset.trustedPortrait.accountKey };
    });
    var materials = state.assets.image.map(function (asset) { return { id: asset.id, materialKind: materialKind(asset) }; });
    return materials.length || portraits.length ? Contract.fingerprint({ base: base, portraits: portraits, materials: materials, reportingConsent: 'AUTO_REPORT_V1' }, 'rights_') : base;
  }

  function analysisFingerprint() {
    return Contract.fingerprint({
      mode: state.mode,
      prompt: state.prompt,
      expertEnabled: state.expertEnabled,
      expertRequirements: state.expertEnabled ? state.expertRequirements : '',
      assets: assetRightsFingerprint(),
      settings: state.settings
    }, 'analysis_');
  }

  function invalidateRights() {
    state.rightsConfirmed = false;
    state.rightsConfirmedAt = '';
    state.rightsFingerprint = '';
    dom.rightsConfirmed.checked = false;
  }

  function invalidateReviewForSourceChange(message) {
    if (state.mode === 'direct' || state.review.state === 'idle') return;
    state.review.confirmed = false;
    state.review.confirmedAt = '';
    state.review.state = 'stale';
    renderReview();
    if (message) setNotice(dom.reviewValidation, message, 'error');
  }

  async function switchMode(mode) {
    mode = Contract.normalizeMode(mode);
    if (!mode || mode === state.mode || state.actionPending) return;
    try { await saveCurrentDraft(); } catch (_) { /* user can still switch */ }
    state.mode = mode;
    if (!routeSupportsMode(state.settings.creativeRoute, mode)) {
      state.settings.creativeRoute = defaultRouteForMode(mode);
    }
    renderMode();
    await restoreDraft(mode);
  }

  function renderCreativeOptions() {
    var selectedRoute = state.settings.creativeRoute;
    if (!routeSupportsMode(selectedRoute, state.mode)) {
      selectedRoute = defaultRouteForMode(state.mode);
      state.settings.creativeRoute = selectedRoute;
    }
    dom.creativeRouteGrid.querySelectorAll('[data-creative-route]').forEach(function routeOption(button) {
      var route = button.dataset.creativeRoute;
      var supported = routeSupportsMode(route, state.mode);
      var active = route === selectedRoute;
      button.disabled = !supported;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      if (!supported) button.title = state.mode === 'remix' ? '参考重构模式只开放参考重构路线。' : '该路线需要切换到爆款复刻模式。';
      else button.removeAttribute('title');
    });
    var route = routeDefinition(selectedRoute);
    dom.creativeRouteHelp.textContent = route && route.description
      ? route.description
      : '路线决定素材门槛和提示词结构；不可用的路线会按当前模式禁用。';

    if (!styleDefinition(state.settings.styleProfile)) state.settings.styleProfile = 'commerce_studio';
    dom.styleProfileGrid.querySelectorAll('[data-style-profile]').forEach(function styleOption(button) {
      var active = button.dataset.styleProfile === state.settings.styleProfile;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function selectCreativeRoute(route) {
    if (!routeSupportsMode(route, state.mode) || route === state.settings.creativeRoute) return;
    state.settings.creativeRoute = route;
    invalidateReviewForSourceChange('创作路线已变化，请重新分析。');
    renderCreativeOptions();
    renderMode();
    renderAssets();
    renderReadiness();
    scheduleDraftSave();
  }

  function selectStyleProfile(style) {
    if (!styleDefinition(style) || style === state.settings.styleProfile) return;
    state.settings.styleProfile = style;
    invalidateReviewForSourceChange('视觉风格已变化，请重新分析。');
    renderCreativeOptions();
    renderReadiness();
    scheduleDraftSave();
  }

  function renderMode() {
    document.querySelectorAll('[data-mode]').forEach(function renderTab(tab) {
      var active = tab.dataset.mode === state.mode;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
      if (active) dom.modePanel.setAttribute('aria-labelledby', tab.id);
    });

    var limits = effectiveLimits(state.mode, state.settings.productKey);
    dom.modeDescription.textContent = MODE_COPY[state.mode].description;
    dom.referenceSection.hidden = state.mode !== 'remix';
    dom.videoUploadTile.hidden = usingProductionPlan() && state.productionOptions.mode === 'economic' ? false : limits.videoMax === 0 || state.mode === 'remix';
    dom.videoUploadTile.classList.toggle('is-disabled', !localUploadSupported('video'));
    dom.videoInput.disabled = dom.videoUploadTile.hidden || !localUploadSupported('video');
    dom.videoUploadTile.title = !dom.videoUploadTile.hidden && !localUploadSupported('video')
      ? (getSelectedModel() && getSelectedModel().nativePlatform
        ? '平台视频的生成参考视频需要可访问的 HTTPS 地址；不支持供应商 asset:// 编号。本地参考视频仍可用于参考重构的关键帧分析。'
        : '当前供应商没有本地视频上传链路；仍可使用已导入的 HTTPS / asset:// 远程视频。')
      : '';
    var audioTile = dom.audioInput.closest('.upload-tile');
    audioTile.hidden = usingProductionPlan() ? false : limits.audioMax === 0;
    audioTile.classList.toggle('is-disabled', !localUploadSupported('audio'));
    dom.audioInput.disabled = audioTile.hidden || !localUploadSupported('audio');
    if (dom.audioUploadLabel) dom.audioUploadLabel.textContent = usingProductionPlan() ? '最终口播 / 背景音乐' : '配乐 / 音效';
    dom.expertModeBlock.hidden = state.mode === 'direct';
    dom.expertRequirementsWrap.hidden = state.mode === 'direct' || !state.expertEnabled;

    dom.assetHelp.textContent = '当前组合最多 ' + limits.imageMax + ' 张图片、' +
      limits.videoMax + ' 个生成参考视频、' + (usingProductionPlan() ? '10 个本地成片音频（可选，不作为供应商参考）' : limits.audioMax + ' 个音频。') +
      (!localUploadSupported('video') && limits.videoMax ? (getSelectedModel() && getSelectedModel().nativePlatform
        ? ' 生成参考视频仅接受可访问的 HTTPS 地址；本地视频可在参考重构中提取关键帧分析。' : ' 本地视频未开放上传，只接受已导入的远程素材。') : '');
    renderCreativeOptions();
    updatePrimaryActionLabel();
  }

  function updatePrimaryActionLabel() {
    var label = MODE_COPY[state.mode].action;
    if (state.mode !== 'direct' && (state.review.state === 'editing' || state.review.state === 'confirmed')) {
      label = '前往确认脚本';
    } else if (state.mode !== 'direct' && state.review.state === 'stale') {
      label = '重新分析脚本';
    }
    if (usingProductionPlan() && state.productionOptions.mode === 'economic' && state.productionOptions.hybridAiSeconds === 0) label = '用已有素材合成';
    if (!state.actionPending) dom.primaryActionLabel.textContent = label;
    updateCreditAnnotations();
  }

  async function resetCurrentDraft() {
    var hasContent = state.prompt || state.assets.image.length || state.assets.video.length ||
      state.assets.audio.length || state.reference || state.review.script;
    if (hasContent && !globalThis.confirm('清空当前模式草稿？本地保存的相关素材也会被删除，此操作不可恢复。')) return;

    var all = state.assets.image.concat(state.assets.video, state.assets.audio, state.referenceFrames);
    if (state.reference) all.push(state.reference);
    await Promise.all(all.map(function remove(item) {
      revokePreview(item);
      var storedId = localStorageAssetId(item);
      var retainedByPlan = state.history.some(function (run) { return run.purpose === 'production' && run.plan && run.plan.shots.some(function (shot) { return shot.sourceAssetId === item.id; }); });
      return storedId && !retainedByPlan
        ? Store.deleteAsset(storedId).catch(function ignore() {})
        : Promise.resolve();
    }));
    await Store.deleteDraft(state.mode).catch(function ignore() {});
    await restoreDraft(state.mode);
    showToast('当前模式草稿已清空。', 'success');
  }

  function maxForKind(kind) {
    if (usingProductionPlan() && kind === 'audio') return 10;
    if (usingProductionPlan() && state.productionOptions.mode === 'economic') return kind === 'image' ? 30 : 10;
    var limits = effectiveLimits(state.mode, state.settings.productKey);
    if (kind === 'image') return limits.imageMax || 0;
    if (kind === 'video') return limits.videoMax || 0;
    if (kind === 'audio') return limits.audioMax || 0;
    return 0;
  }

  async function addFiles(kind, files) {
    var incoming = Array.from(files || []);
    var uploadAccountKey = state.accountKey;
    if (!incoming.length) return;
    if (!localUploadSupported(kind)) {
      showToast('当前供应商未提供可验证的本地' + kindLabel(kind) + '上传链路。', 'error');
      return;
    }
    var max = maxForKind(kind);
    if (!max) {
      showToast('当前模式不接收' + kindLabel(kind) + '素材。', 'error');
      return;
    }

    var remaining = max - state.assets[kind].length;
    if (remaining <= 0) {
      showToast(kindLabel(kind) + '已达到上限 ' + max + ' 个。', 'error');
      return;
    }
    if (incoming.length > remaining) {
      showToast('仅剩 ' + remaining + ' 个' + kindLabel(kind) + '名额，超出的文件不会添加。');
      incoming = incoming.slice(0, remaining);
    }

    var added = 0;
    for (var i = 0; i < incoming.length; i += 1) {
      var file = incoming[i];
      try {
        validateFile(kind, file);
        var metadata = await readFileMetadata(kind, file);
        validateAssetMetadata(kind, metadata);
        var summary = await Store.saveAsset(file, Object.assign(metadata, {
          kind: kind,
          expectedAccountKey: usingProductionPlan() && kind === 'audio' ? uploadAccountKey : undefined,
          role: defaultAssetRole(kind, state.assets[kind].length + added),
          name: file.name,
          mimeType: file.type
        }));
        var hydrated = await hydrateAsset(summary);
        if (!hydrated) throw new Error('素材写入后无法从本地库读取。');
        if (usingProductionPlan() && kind === 'audio') { hydrated.finalAudioRole = 'narration'; hydrated.finalAudioVolume = 1; hydrated.finalAudioLoop = false; }
        state.assets[kind].push(hydrated);
        added += 1;
      } catch (error) {
        showToast(file.name + '：' + safeErrorMessage(error), 'error');
      }
    }

    if (added) {
      invalidateRights();
      invalidateReviewForSourceChange('素材已变化，请重新分析后再确认脚本。');
      renderAssets();
      renderReadiness();
      scheduleDraftSave();
    }
  }

  async function setReferenceVideo(file) {
    if (!file) return;
    try {
      validateFile('video', file);
      var metadata = await readFileMetadata('video', file);
      if (!metadata.durationSec || metadata.durationSec < 4 || metadata.durationSec > 15) {
        throw new Error('参考视频时长必须为 4–15 秒。');
      }
      var summary = await Store.saveAsset(file, Object.assign(metadata, {
        kind: 'video',
        role: 'asset',
        name: file.name,
        mimeType: file.type
      }));
      var hydrated = await hydrateAsset(summary);
      if (!hydrated) throw new Error('参考视频写入后无法从本地库读取。');

      var extractedFrames;
      try {
        extractedFrames = await extractAndStoreReferenceFrames(file, hydrated.id, hydrated.name);
      } catch (frameError) {
        revokePreview(hydrated);
        await Store.deleteAsset(hydrated.id).catch(function ignore() {});
        throw new Error('关键帧提取失败，参考视频未保存：' + safeErrorMessage(frameError));
      }

      if (state.reference) {
        var previous = state.reference;
        revokePreview(previous);
        var previousStoredId = localStorageAssetId(previous);
        if (previousStoredId) {
          Store.deleteAsset(previousStoredId).catch(function ignore() {});
        }
      }
      await deleteReferenceFrames(state.referenceFrames);
      state.reference = hydrated;
      state.referenceFrames = extractedFrames;
      invalidateRights();
      invalidateReviewForSourceChange('参考视频已变化，请重新拆解。');
      renderReference();
      renderReadiness();
      scheduleDraftSave();
    } catch (error) {
      showToast(file.name + '：' + safeErrorMessage(error), 'error');
    } finally {
      dom.referenceVideoInput.value = '';
    }
  }

  async function extractAndStoreReferenceFrames(file, referenceVideoId, sourceName) {
    var frames = await extractReferenceFrameBlobs(file, 5);
    var saved = [];
    try {
      for (var i = 0; i < frames.length; i += 1) {
        var frame = frames[i];
        var summary = await Store.saveAsset(frame.blob, {
          kind: 'reference_frame',
          role: 'asset',
          name: cleanText(sourceName).replace(/\.[^.]+$/, '') + '-关键帧-' + String(i + 1).padStart(2, '0') + '.jpg',
          mimeType: 'image/jpeg',
          width: frame.width,
          height: frame.height,
          referenceVideoId: referenceVideoId,
          timeSec: frame.timeSec
        });
        var hydrated = await hydrateAsset(summary);
        if (!hydrated) throw new Error('关键帧写入后无法读取。');
        saved.push(hydrated);
      }
      if (saved.length !== 5) throw new Error('关键帧数量不足 5 个。');
      return saved;
    } catch (error) {
      await deleteReferenceFrames(saved);
      throw error;
    }
  }

  function extractReferenceFrameBlobs(file, count) {
    return new Promise(function extractionPromise(resolve, reject) {
      var url = URL.createObjectURL(file);
      var video = document.createElement('video');
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      var outerTimer = globalThis.setTimeout(function extractionTimeout() {
        cleanup();
        reject(new Error('提取参考关键帧超时。'));
      }, 45000);

      function cleanup() {
        globalThis.clearTimeout(outerTimer);
        video.onloadedmetadata = null;
        video.onerror = null;
        video.removeAttribute('src');
        try { video.load(); } catch (_) { /* noop */ }
        URL.revokeObjectURL(url);
      }

      video.onerror = function videoError() {
        cleanup();
        reject(new Error('浏览器无法解码参考视频。'));
      };

      video.onloadedmetadata = async function metadataLoaded() {
        try {
          var duration = Number(video.duration);
          if (!Number.isFinite(duration) || duration < 4 || duration > 15) {
            throw new Error('参考视频时长必须为 4–15 秒。');
          }
          var width = Number(video.videoWidth || 0);
          var height = Number(video.videoHeight || 0);
          if (!width || !height) throw new Error('无法读取参考视频画面尺寸。');
          var scale = Math.min(1, 720 / width);
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          var context = canvas.getContext('2d', { alpha: false });
          if (!context) throw new Error('浏览器无法创建关键帧画布。');

          var output = [];
          for (var i = 0; i < count; i += 1) {
            var timeSec = Math.min(duration - 0.08, Math.max(0.08, duration * (i + 1) / (count + 1)));
            await seekVideo(video, timeSec);
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            var blob = await canvasToBlob(canvas, 'image/jpeg', 0.84);
            output.push({
              blob: blob,
              width: canvas.width,
              height: canvas.height,
              timeSec: Math.round(timeSec * 100) / 100
            });
          }
          cleanup();
          resolve(output);
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      video.src = url;
    });
  }

  function seekVideo(video, timeSec) {
    return new Promise(function seekPromise(resolve, reject) {
      var settled = false;
      var timer = globalThis.setTimeout(function seekTimeout() {
        finish(new Error('定位关键帧时间点超时。'));
      }, 6000);

      function finish(error) {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
        if (error) reject(error); else resolve();
      }
      function onSeeked() { finish(); }
      function onError() { finish(new Error('参考视频跳转失败。')); }

      video.addEventListener('seeked', onSeeked, { once: true });
      video.addEventListener('error', onError, { once: true });
      try {
        video.currentTime = timeSec;
      } catch (error) {
        finish(error);
      }
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function blobPromise(resolve, reject) {
      canvas.toBlob(function onBlob(blob) {
        if (blob) resolve(blob); else reject(new Error('关键帧 JPEG 编码失败。'));
      }, type, quality);
    });
  }

  async function deleteReferenceFrames(frames) {
    await Promise.all((frames || []).map(function removeFrame(frame) {
      revokePreview(frame);
      var storedId = localStorageAssetId(frame);
      return storedId
        ? Store.deleteAsset(storedId).catch(function ignore() {})
        : Promise.resolve();
    }));
  }

  function validateFile(kind, file) {
    var limits = FILE_LIMITS[kind];
    if (!limits || !(file instanceof Blob)) throw new Error('无法读取该文件。');
    if (!limits.accept.test(cleanText(file.type))) {
      throw new Error('文件格式不受支持。');
    }
    if (!file.size) throw new Error('文件为空。');
    if (file.size > limits.bytes) {
      throw new Error('文件大小为 ' + formatBytes(file.size) + '，上限为 ' + formatBytes(limits.bytes) + '。');
    }
  }

  function readFileMetadata(kind, file) {
    if (kind === 'image') return readImageMetadata(file);
    return readMediaMetadata(kind, file);
  }

  function validateAssetMetadata(kind, metadata) {
    metadata = metadata || {};
    if ((kind === 'image' || kind === 'video') && metadata.width && metadata.height) {
      var ratio = Number(metadata.width) / Number(metadata.height);
      if (metadata.width < 300 || metadata.width > 6000 || metadata.height < 300 || metadata.height > 6000 || ratio < 0.4 || ratio > 2.5) {
        throw new Error('图片/视频宽高需为 300–6000 px，宽高比需在 0.4–2.5 之间。');
      }
    }
    if (kind === 'video' || kind === 'audio') {
      var model = getSelectedModel();
      if (usingProductionPlan() && kind === 'audio') {
        var audioDuration = Number(metadata.durationSec);
        if (!Number.isFinite(audioDuration) || audioDuration <= 0 || audioDuration > 3600) throw new Error('本地成片音频需有有效时长且不超过 3600 秒；最终口播须完整放入成片。');
        return;
      }
      var maxDuration = usingProductionPlan() && state.productionOptions.mode === 'economic' ? 3600 : Number(model && model.maxDuration || 15);
      var duration = Number(metadata.durationSec || 0);
      if (!duration || duration < 2 || duration > maxDuration) {
        throw new Error(kindLabel(kind) + '单段时长需为 2–' + maxDuration + ' 秒。');
      }
    }
  }

  function readImageMetadata(file) {
    return new Promise(function imagePromise(resolve, reject) {
      var url = URL.createObjectURL(file);
      var image = new Image();
      var timer = globalThis.setTimeout(function imageTimeout() {
        cleanup();
        reject(new Error('读取图片尺寸超时。'));
      }, 12000);

      function cleanup() {
        globalThis.clearTimeout(timer);
        URL.revokeObjectURL(url);
        image.onload = null;
        image.onerror = null;
      }

      image.onload = function loaded() {
        var width = image.naturalWidth;
        var height = image.naturalHeight;
        cleanup();
        if (!width || !height) {
          reject(new Error('无法读取图片尺寸。'));
          return;
        }
        resolve({ width: width, height: height, durationSec: null });
      };
      image.onerror = function failed() {
        cleanup();
        reject(new Error('图片内容损坏或无法解码。'));
      };
      image.src = url;
    });
  }

  function readMediaMetadata(kind, file) {
    return new Promise(function mediaPromise(resolve, reject) {
      var url = URL.createObjectURL(file);
      var media = document.createElement(kind === 'audio' ? 'audio' : 'video');
      media.preload = 'metadata';
      var timer = globalThis.setTimeout(function mediaTimeout() {
        cleanup();
        reject(new Error('读取媒体信息超时。'));
      }, 15000);

      function cleanup() {
        globalThis.clearTimeout(timer);
        URL.revokeObjectURL(url);
        media.removeAttribute('src');
        try { media.load(); } catch (_) { /* noop */ }
      }

      media.onloadedmetadata = function loaded() {
        var duration = Number(media.duration);
        var width = Number(media.videoWidth || 0) || null;
        var height = Number(media.videoHeight || 0) || null;
        cleanup();
        if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) {
          reject(new Error('媒体时长无效或超过 60 分钟。'));
          return;
        }
        resolve({ durationSec: usingProductionPlan() && kind === 'audio' ? duration : Math.round(duration * 10) / 10, width: width, height: height });
      };
      media.onerror = function failed() {
        cleanup();
        reject(new Error('媒体内容损坏或浏览器无法解码。'));
      };
      media.src = url;
    });
  }

  async function removeAsset(kind, id) {
    var list = state.assets[kind] || [];
    var index = list.findIndex(function find(item) { return item.id === id; });
    if (index < 0) return;
    var asset = list[index];
    list.splice(index, 1);
    revokePreview(asset);
    var storedId = localStorageAssetId(asset);
    if (storedId) {
      await Store.deleteAsset(storedId).catch(function onDelete(error) {
        showToast('本地素材删除失败：' + safeErrorMessage(error), 'error');
      });
    }
    invalidateRights();
    invalidateReviewForSourceChange('素材已变化，请重新分析后再确认脚本。');
    renderAssets();
    renderReadiness();
    scheduleDraftSave();
  }

  async function removeReference() {
    if (!state.reference) return;
    var reference = state.reference;
    state.reference = null;
    revokePreview(reference);
    var storedId = localStorageAssetId(reference);
    if (storedId) {
      await Store.deleteAsset(storedId).catch(function ignore() {});
    }
    await deleteReferenceFrames(state.referenceFrames);
    state.referenceFrames = [];
    invalidateRights();
    invalidateReviewForSourceChange('参考视频已移除，请重新拆解。');
    renderReference();
    renderReadiness();
    scheduleDraftSave();
  }

  function kindLabel(kind) {
    return { image: '图片', video: '视频', audio: '音频' }[kind] || '文件';
  }

  function defaultAssetRole(kind, index) {
    if (kind === 'image' && index === 0) return 'product';
    if (kind === 'video') return 'motion';
    if (kind === 'audio') return 'rhythm';
    return 'asset';
  }

  function assetRoleOptions(kind) {
    if (kind === 'image') return [
      ['product', '商品主体'], ['person', '人物主体'], ['scene', '场景参考'], ['style', '风格参考'], ['asset', '普通参考']
    ];
    if (kind === 'video') return [
      ['motion', '动作 / 运镜'], ['scene', '场景参考'], ['style', '风格参考'], ['asset', '普通参考']
    ];
    return [['rhythm', '节奏 / 声音'], ['asset', '普通参考']];
  }

  function renderAssets() {
    var total = state.assets.image.length + state.assets.video.length + state.assets.audio.length;
    dom.assetCount.textContent = total + ' 个素材';
    dom.imageQuota.textContent = state.assets.image.length + ' / ' + maxForKind('image');
    dom.videoQuota.textContent = state.assets.video.length + ' / ' + Math.max(0, maxForKind('video'));
    dom.audioQuota.textContent = state.assets.audio.length + ' / ' + Math.max(0, maxForKind('audio'));
    dom.assetList.replaceChildren();

    ['image', 'video', 'audio'].forEach(function forKind(kind) {
      state.assets[kind].forEach(function render(asset) {
        dom.assetList.appendChild(createAssetCard(asset));
      });
    });
  }
  async function associateTrustedPortrait(id, value) {
    if (state.actionPending || state.productionBusy || state.productionStarting) return false;
    var asset = state.assets.image.find(function (item) { return item.id === id; });
    try {
      if (!asset || !localStorageAssetId(asset)) throw new Error('请先保留本地原始图片，再关联可信人像素材。');
      if (value !== null) {
        if (!personalArkPortraitAvailable()) throw new Error('可信人像引用仅支持个人火山方舟 API；平台视频暂不支持关联。');
        var uri = normalizeTrustedPortraitUri(value);
        if (!uri) throw new Error('请输入完整 Asset ID（asset-…）或 asset://asset-…，不含空格、参数或片段。');
        asset.trustedPortrait = { uri: uri, accountKey: state.accountKey };
        asset.materialKind = 'real';
      } else { delete asset.trustedPortrait; if (!asset.registration) asset.materialKind = 'unknown'; }
      invalidateRights();
      state.review.confirmed = false; state.review.confirmedAt = '';
      invalidateReviewForSourceChange('人像素材引用已变化，请重新分析并确认脚本。');
      renderAssets(); renderReadiness();
      await saveCurrentDraft();
      showToast(value === null ? '已恢复原始图片，请重新确认素材权利。' : '已填写素材引用，实际可用性由火山方舟校验。', 'success');
      return true;
    } catch (error) { setNotice(dom.composerValidation, safeErrorMessage(error), 'error'); return false; }
  }

  function createAssetCard(asset) {
    var card = document.createElement('article');
    card.className = 'asset-card';
    card.dataset.assetId = asset.id;
    card.dataset.assetKind = asset.kind;

    var thumb = document.createElement('div');
    thumb.className = 'asset-thumb';
    if (asset.kind === 'image' && asset.previewUrl) {
      var image = document.createElement('img');
      image.src = asset.previewUrl;
      image.alt = '';
      thumb.appendChild(image);
    } else if (asset.kind === 'video' && asset.previewUrl) {
      var video = document.createElement('video');
      video.src = asset.previewUrl;
      video.muted = true;
      video.preload = 'metadata';
      video.setAttribute('aria-hidden', 'true');
      thumb.appendChild(video);
    } else {
      thumb.textContent = asset.kind === 'audio' ? '♫' : '◫';
    }

    var info = document.createElement('div');
    info.className = 'asset-info';
    var name = document.createElement('strong');
    name.textContent = asset.name;
    name.title = asset.name;
    var details = document.createElement('small');
    details.textContent = kindLabel(asset.kind) + ' · ' + formatBytes(asset.size) +
      (asset.durationSec ? ' · ' + formatDuration(asset.durationSec) : '');
    var role = document.createElement('select');
    role.className = 'asset-role-select';
    role.dataset.assetRole = asset.id;
    role.dataset.kind = asset.kind;
    role.setAttribute('aria-label', '设置素材 ' + asset.name + ' 的用途');
    assetRoleOptions(asset.kind).forEach(function roleOption(pair) {
      var option = document.createElement('option');
      option.value = pair[0];
      option.textContent = pair[1];
      role.appendChild(option);
    });
    role.value = asset.role || defaultAssetRole(asset.kind, 0);
    info.append(name, details);
    if (asset.kind === 'audio' && usingProductionPlan()) {
      card.classList.add('final-audio-card');
      appendFinalAudioControls(info, asset);
    } else info.appendChild(role);
    if (asset.kind === 'image') appendMaterialControls(info, asset);
    if (asset.kind === 'image' && localStorageAssetId(asset)) {
      var portraitActions = document.createElement('div'); portraitActions.className = 'trusted-portrait-actions';
      var associate = document.createElement('button'); associate.type = 'button'; associate.className = 'button button-secondary button-small';
      associate.dataset.trustedPortraitAsset = asset.id; associate.textContent = asset.trustedPortrait ? '更换可信人像引用' : '关联可信人像素材';
      associate.disabled = state.actionPending || state.productionBusy || state.productionStarting || !personalArkPortraitAvailable();
      associate.title = '仅支持个人火山方舟 API；先在方舟完成本人认证、授权和素材入库。平台视频暂不支持。';
      portraitActions.appendChild(associate);
      if (asset.trustedPortrait) {
        var restore = document.createElement('button'); restore.type = 'button'; restore.className = 'button button-secondary button-small';
        restore.dataset.restorePortraitAsset = asset.id; restore.textContent = '恢复原始图片';
        restore.disabled = state.actionPending || state.productionBusy || state.productionStarting; portraitActions.appendChild(restore);
        var portraitNote = document.createElement('small'); portraitNote.textContent = '已填写素材引用，实际可用性由火山方舟校验。原图仅用于预览和脚本分析。'; info.appendChild(portraitNote);
      }
      if (!personalArkPortraitAvailable()) { var unavailable = document.createElement('small'); unavailable.textContent = '可信人像引用仅支持个人火山方舟 API，平台视频暂不支持。'; info.appendChild(unavailable); }
      info.appendChild(portraitActions);
    }

    var remove = document.createElement('button');
    remove.className = 'remove-asset';
    remove.type = 'button';
    remove.dataset.removeAsset = asset.id;
    remove.dataset.kind = asset.kind;
    remove.setAttribute('aria-label', '移除素材 ' + asset.name);
    remove.textContent = '×';
    card.append(thumb, info, remove);
    return card;
  }

  function appendMaterialControls(info, asset) {
    var section = document.createElement('div'); section.className = 'asset-reporting';
    var label = document.createElement('label'); label.textContent = '素材类型（请按实际内容选择）';
    var select = document.createElement('select'); select.className = 'asset-material-select'; select.dataset.assetMaterial = asset.id;
    select.setAttribute('aria-label', '选择素材 ' + asset.name + ' 的真实内容类型');
    [['unknown', '请选择素材类型'], ['ordinary', '普通图片 · 无人物'], ['virtual', '虚拟人物 · 非真实人物'], ['real', '真实人物 · 需本人认证']].forEach(function (pair) {
      var option = document.createElement('option'); option.value = pair[0]; option.textContent = pair[1]; select.appendChild(option);
    });
    select.value = materialKind(asset); select.disabled = state.actionPending || state.productionBusy || state.productionStarting || state.assetPreparing || !!asset.registration;
    label.appendChild(select); section.appendChild(label);
    var kind = materialKind(asset);
    if (kind === 'unknown') { var hint = document.createElement('small'); hint.textContent = '用途不会决定内容类型，请确认是否含真实人物。'; section.appendChild(hint); }
    if (kind === 'virtual' || kind === 'real') {
      var status = document.createElement('small'), registration = asset.registration;
      var labels = { active: '供应商已确认可用', preparing: '报备处理中', needs_authorization: '等待本人认证与授权', failed: '报备失败', uncertain: '报备状态待核对' };
      status.className = 'asset-reporting-status';
      if (registration && registration.accountKey !== state.accountKey) status.textContent = '报备记录属于原账号，请切回后核对。';
      else if (registration) status.textContent = (labels[registration.status] || '报备状态待核对') + (registration.message ? '：' + registration.message : '');
      else status.textContent = asset.trustedPortrait ? '使用手填可信素材引用；实际可用性由火山方舟校验。' : (kind === 'real' ? '需本人认证授权后向当前供应商送审。' : '生成前向当前供应商报备，审核可用后才提交视频。');
      section.appendChild(status);
      var actions = document.createElement('div'); actions.className = 'asset-reporting-actions';
      var busy = state.actionPending || state.productionBusy || state.productionStarting || state.assetPreparing;
      if (kind === 'real' && !asset.trustedPortrait) {
        var start = document.createElement('button'); start.type = 'button'; start.className = 'button button-secondary button-small'; start.dataset.portraitStart = asset.id;
        start.textContent = currentPortraitAuthorization() ? '核对本人认证入口' : '创建本人认证链接';
        start.disabled = busy || !assetReportingAvailable() || assetReportingCapability().portraitAvailable !== true; actions.appendChild(start);
        var authorization = currentPortraitAuthorization();
        if (authorization && ['expired', 'failed'].indexOf(authorization.status) >= 0) { start.dataset.portraitRestart = asset.id; start.textContent = '重新创建本人认证链接'; }
        if (authorization && authorization.url) { var link = document.createElement('a'); link.href = authorization.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.className = 'portrait-authorization-link'; link.textContent = '由图片中的本人打开认证并确认授权'; actions.appendChild(link); }
      }
      if (requiresAssetPreparation(asset)) {
        var prepare = document.createElement('button'); prepare.type = 'button'; prepare.className = 'button button-secondary button-small'; prepare.dataset.prepareAsset = asset.id;
        prepare.textContent = registration ? '查询报备进度' : '准备需报备的素材'; prepare.disabled = busy || !assetReportingAvailable(); actions.appendChild(prepare);
      }
      section.appendChild(actions);
      if (!assetReportingAvailable()) {
        var unavailable = document.createElement('small'); unavailable.className = 'asset-reporting-config'; unavailable.textContent = assetReportingMessage(); section.appendChild(unavailable);
        var configure = document.createElement('a'); configure.href = '/management/video-materials'; configure.target = '_top'; configure.className = 'portrait-authorization-link'; configure.textContent = '管理员：打开素材送审安全配置'; section.appendChild(configure);
      }
    }
    info.appendChild(section);
  }

  function renderReference() {
    dom.referencePreview.replaceChildren();
    dom.referencePreview.hidden = !state.reference;
    dom.referenceDropzone.hidden = !!state.reference;
    if (!state.reference) return;

    var asset = state.reference;
    var thumb = document.createElement('div');
    thumb.className = 'asset-thumb';
    if (asset.previewUrl) {
      var video = document.createElement('video');
      video.src = asset.previewUrl;
      video.muted = true;
      video.preload = 'metadata';
      video.setAttribute('aria-hidden', 'true');
      thumb.appendChild(video);
    } else {
      thumb.textContent = '▷';
    }

    var info = document.createElement('div');
    info.className = 'asset-info';
    var name = document.createElement('strong');
    name.textContent = asset.name;
    var details = document.createElement('small');
    details.textContent = '参考视频 · ' + formatDuration(asset.durationSec) + ' · ' + formatBytes(asset.size);
    info.append(name, details);

    var remove = document.createElement('button');
    remove.className = 'remove-asset';
    remove.type = 'button';
    remove.dataset.removeReference = 'true';
    remove.setAttribute('aria-label', '移除参考视频 ' + asset.name);
    remove.textContent = '×';
    dom.referencePreview.append(thumb, info, remove);

    if (state.referenceFrames.length) {
      var strip = document.createElement('div');
      strip.className = 'reference-frame-strip';
      strip.setAttribute('aria-label', '从参考视频提取的 5 个分析关键帧');
      state.referenceFrames.forEach(function renderFrame(frame, index) {
        var figure = document.createElement('figure');
        var image = document.createElement('img');
        image.src = frame.previewUrl;
        image.alt = '参考关键帧 ' + (index + 1) + '，' + formatDuration(frame.timeSec);
        var caption = document.createElement('figcaption');
        caption.textContent = formatDuration(frame.timeSec);
        figure.append(image, caption);
        strip.appendChild(figure);
      });
      dom.referencePreview.appendChild(strip);
    }
  }

  function assetForRequest(asset, options) {
    var analysis = options && options.analysis === true, libraryUri = analysis ? '' : activeLibraryUri(asset);
    if (!analysis && requiresAssetPreparation(asset) && !libraryUri && !(options && options.allowUnprepared)) throw makeStudioError('ASSET_REPORT_NOT_ACTIVE', '需报备的图片尚未由供应商确认可用，请先准备素材并核对进度。');
    var remoteUrl = analysis ? safeRemoteAssetUrl(asset.remoteUrl) : (libraryUri || trustedPortraitUri(asset) || safeRemoteAssetUrl(asset.remoteUrl));
    var requestAsset = {
      id: asset.id,
      kind: asset.kind,
      role: asset.role || 'asset',
      name: asset.name,
      mimeType: asset.mimeType,
      size: asset.size,
      durationSeconds: Number(asset.durationSec || 0),
      timeSec: asset.timeSec == null ? null : Number(asset.timeSec),
      referenceVideoId: asset.referenceVideoId || '',
      rightsConfirmed: state.rightsConfirmed,
      remoteUrl: remoteUrl,
      storageRef: remoteUrl ? null : (asset.storageRef || {
        dbName: Store.DB_NAME,
        storeName: Store.ASSET_STORE,
        id: asset.id
      })
    };
    if (asset.kind === 'image') requestAsset.materialKind = materialKind(asset);
    if (libraryUri) requestAsset.registration = registrationMetadata(asset.registration);
    return requestAsset;
  }

  function buildRequest(stage, options) {
    var raw = {
      mode: state.mode,
      productKey: state.settings.productKey,
      durationSeconds: state.settings.durationSeconds,
      resolution: state.settings.resolution,
      ratio: state.settings.ratio,
      audioMode: state.settings.audioMode,
      narrationLanguage: state.settings.audioMode === 'narration' ? state.settings.narrationLanguage : '',
      creativeRoute: state.settings.creativeRoute,
      styleProfile: state.settings.styleProfile,
      script: state.mode === 'direct' ? state.prompt : state.review.script,
      goal: state.mode === 'direct' ? '' : state.prompt,
      supplementalRequirements: supplementalRequirementsFor(stage),
      scriptConfirmed: state.mode === 'direct' ? false : state.review.confirmed,
      referenceRightsConfirmed: state.mode === 'remix' && state.rightsConfirmed,
      images: state.assets.image.map(function (asset) { return assetForRequest(asset, { analysis: stage === 'draft', allowUnprepared: !!(options && options.allowUnprepared) }); }),
      videos: state.assets.video.map(assetForRequest),
      audios: state.assets.audio.map(assetForRequest),
      referenceVideo: state.mode === 'remix' && state.reference ? assetForRequest(state.reference) : null,
      referenceFrames: state.mode === 'remix' ? state.referenceFrames.map(assetForRequest) : [],
      rights: {
        confirmed: state.rightsConfirmed,
        confirmedAt: state.rightsConfirmedAt,
        assetFingerprint: state.rightsFingerprint,
        statementVersion: 'ASSET_RIGHTS_V2'
      }
    };
    if (usingProductionPlan()) {
      raw.audios = []; raw.audioMode = 'silent'; raw.narrationLanguage = '';
      if (raw.creativeRoute === 'audio_visual') raw.creativeRoute = 'storyboard_direct';
      raw.rights.assetFingerprint = Contract.assetRightsFingerprint(raw);
    }
    if (state.assets.image.length) raw.rights.assetFingerprint = Contract.assetRightsFingerprint(raw);
    if (stage === 'submit' && state.mode !== 'direct' && state.review.storyboard.length) {
      raw.storyboard = storyboardForRequest();
      var canonicalStoryboard = Contract.normalizeStoryboard(raw.storyboard, {
        durationSeconds: state.settings.durationSeconds
      });
      raw.reviewFingerprint = Contract.reviewFingerprint(raw.script, canonicalStoryboard);
      raw.reviewConfirmedAt = state.review.confirmedAt;
    }
    return Object.assign({}, Contract.normalizeRequest(raw, { stage: stage }));
  }

  function storyboardForRequest() {
    var timelineCursor = 0;
    return state.review.storyboard.map(function shotForRequest(shot, index) {
      parseStructureFromVisual(shot.visual, shot);
      var durationSeconds = Number(shot.durationSeconds);
      var startSecond = Math.round(timelineCursor * 1000) / 1000;
      var endSecond = Math.round((timelineCursor + durationSeconds) * 1000) / 1000;
      timelineCursor = endSecond;
      return {
        id: shot.id || 'shot-' + (index + 1),
        order: index + 1,
        startSecond: startSecond,
        endSecond: endSecond,
        durationSeconds: durationSeconds,
        visual: cleanText(shot.visual),
        narration: cleanText(shot.narration),
        composition: cleanText(shot.composition),
        camera: cleanText(shot.camera),
        motion: cleanText(shot.motion),
        rhythm: cleanText(shot.rhythm),
        audioRole: cleanText(shot.audioRole),
        reconstructionIntent: cleanText(shot.reconstructionIntent)
      };
    });
  }

  function supplementalRequirementsFor(stage) {
    var parts = [];
    if (state.mode !== 'direct' && state.expertEnabled && state.expertRequirements) {
      parts.push('专家模式高级约束：\n' + state.expertRequirements);
    }
    if (stage === 'submit' && state.mode !== 'direct' && state.review.storyboard.length) {
      var shots = state.review.storyboard.map(function confirmedShot(shot, index) {
        var line = '镜头 ' + (index + 1) + '（' + Number(shot.durationSeconds) + ' 秒）：' + cleanText(shot.visual);
        if (cleanText(shot.narration)) line += '；字幕/口播：' + cleanText(shot.narration);
        return line;
      }).join('\n');
      parts.push('用户已确认分镜，生成时必须遵守：\n' + shots);
    }
    return parts.join('\n\n').slice(0, 8000);
  }

  function baseChecks() {
    if (usingProductionPlan()) {
      var errors = productionValidationErrors({ requireReview: false });
      var localOnly = state.productionOptions.mode === 'economic' && state.productionOptions.hybridAiSeconds === 0;
      var analysisError = !localOnly && state.mode !== 'direct' ? analysisRequestError() : '';
      return { backend: localOnly || state.backendConnected, model: localOnly || !errors.some(function (message) { return /模型|API|能力/.test(message); }), input: !analysisError && !errors.some(function (message) { return /素材|创作|预算|方案/.test(message); }), rights: !errors.some(function (message) { return /权利/.test(message); }) };
    }
    var model = getSelectedModel();
    var inputOkay = !!state.prompt;
    if (inputOkay) {
      try { buildRequest('draft'); } catch (_) { inputOkay = false; }
    }
    var modelOkay = !!model && modelSupportsSettings(model) && (state.mode === 'direct' ? model.configured : state.analysisAvailable === true);
    var hasAssets = state.assets.image.length || state.assets.video.length || state.assets.audio.length || state.reference;
    var rightsOkay = !hasAssets || (state.rightsConfirmed && state.rightsFingerprint === assetRightsFingerprint());
    return {
      backend: state.backendConnected,
      model: modelOkay,
      input: inputOkay,
      rights: rightsOkay
    };
  }

  function modelSupportsSettings(model) {
    if (!model) return false;
    return model.resolutions.indexOf(state.settings.resolution) >= 0 &&
      model.ratios.indexOf(state.settings.ratio) >= 0 &&
      state.settings.durationSeconds >= model.minDuration &&
      state.settings.durationSeconds <= model.maxDuration &&
      (!nativeDurations(model).length || nativeDurations(model).indexOf(state.settings.durationSeconds) >= 0) &&
      (!model.nativePlatform || model.generateAudio !== false || state.settings.audioMode === 'silent');
  }

  function validationErrors(options) {
    options = options || {};
    if (usingProductionPlan()) return productionValidationErrors(options);
    var errors = [];
    var limits = effectiveLimits(state.mode, state.settings.productKey);
    var model = getSelectedModel();
    if (state.assets.image.some(function (asset) { return !!asset.trustedPortrait; }) && !personalArkPortraitAvailable()) errors.push('可信人像引用仅支持个人火山方舟 API；平台视频暂不支持，请切换个人 API 或恢复原始图片。');
    if (!state.backendConnected) errors.push(state.capabilityError || '后台生成能力未接入。');
    var analyzing = state.mode !== 'direct' && !options.requireReview;
    if (!analyzing) errors = errors.concat(materialValidationErrors());
    if (analyzing && state.analysisAvailable !== true) {
      errors.push(cleanText(state.analysisStatus && state.analysisStatus.message) || '当前账号的脚本分析配置不可用。');
    }
    if (!analyzing && (!model || !model.configured)) {
      if (state.credentialAvailable === false) {
        errors.push(credentialIssueMessage());
      } else if (model && model.providerModelConfigured === false) {
        errors.push(model.displayName + ' 缺少可信供应商模型 ID 映射，禁止提交或静默降级。');
      } else {
        errors.push((model ? model.displayName : '当前模型') + ' 的当前账号配置不可用，禁止提交或静默降级。');
      }
    } else if (!model || !modelSupportsSettings(model)) {
      errors.push((model ? model.displayName : '当前模型') + ' 不支持当前分辨率、比例或时长组合。');
    }
    if (!state.prompt) errors.push('请填写创作要求。');
    if (!analyzing && model && model.nativePlatform) {
      if (['image', 'video', 'audio'].some(function (kind) { return state.assets[kind].some(function (asset) { return /^asset:/i.test(asset.remoteUrl || ''); }); })) {
        errors.push('平台视频仅支持 HTTPS 素材地址，不支持未绑定当前账号的供应商素材编号。');
      }
      if (state.assets.video.some(function (asset) { return !safeRemoteAssetUrl(asset.remoteUrl); })) {
        errors.push('生成参考视频需要可访问的 HTTPS 地址；本地视频可用于参考重构的关键帧分析。');
      }
    }
    if (state.assets.image.length > limits.imageMax) {
      errors.push('图片不能超过 ' + limits.imageMax + ' 张。');
    }
    if (state.assets.video.length > limits.videoMax) {
      errors.push('视频不能超过 ' + limits.videoMax + ' 个。');
    }
    if (state.assets.audio.length > limits.audioMax) {
      errors.push('音频不能超过 ' + limits.audioMax + ' 个。');
    }
    if (state.mode === 'remix' && !state.reference) {
      errors.push('爆款复刻必须上传 1 个独立参考视频。');
    }
    if (state.mode === 'remix' && state.reference && state.referenceFrames.length !== 5) {
      errors.push('参考视频需成功提取 5 个本地关键帧后才能分析。');
    }
    if (state.mode === 'remix' && state.reference &&
        (!state.reference.durationSec || state.reference.durationSec < 4 || state.reference.durationSec > 15)) {
      errors.push('参考视频时长必须为 4–15 秒。');
    }
    if (state.mode !== 'direct' && state.expertEnabled && !state.expertRequirements) {
      errors.push('专家模式已开启，请填写高级约束或关闭专家模式。');
    }
    if (state.settings.audioMode === 'narration' && !state.settings.narrationLanguage) {
      errors.push('有口播模式必须选择口播语言。');
    }
    var hasAssets = state.assets.image.length || state.assets.video.length || state.assets.audio.length || state.reference;
    if (hasAssets && (!state.rightsConfirmed || state.rightsFingerprint !== assetRightsFingerprint())) {
      errors.push('请确认拥有全部素材的合法使用和改编权限。');
    }

    try {
      buildRequest(options.requireReview && state.mode !== 'direct' ? 'submit' : 'draft', { allowUnprepared: true });
    } catch (contractError) {
      errors.push(safeErrorMessage(contractError, '当前路线或素材不符合生成合同。'));
    }

    if (options.requireReview && state.mode !== 'direct') {
      if (state.review.analysisFingerprint !== analysisFingerprint()) {
        errors.push('输入已变化，请重新分析脚本与分镜。');
      }
      if (!state.review.confirmed) errors.push('请编辑并确认脚本与分镜。');
      if (!cleanText(state.review.script)) errors.push('确认脚本不能为空。');
      if (!state.review.storyboard.length) errors.push('至少需要 1 个分镜。');
      var shotErrors = validateStoryboard();
      errors = errors.concat(shotErrors);
    }
    return Array.from(new Set(errors));
  }

  function validateStoryboard() {
    var errors = [];
    var total = 0;
    state.review.storyboard.forEach(function checkShot(shot, index) {
      var duration = Number(shot.durationSeconds);
      if (!cleanText(shot.visual)) errors.push('镜头 ' + (index + 1) + ' 的画面描述不能为空。');
      if (!Number.isFinite(duration) || duration <= 0 || duration > 15) {
        errors.push('镜头 ' + (index + 1) + ' 的时长必须大于 0 且不超过 15 秒。');
      } else {
        total += duration;
      }
    });
    if (state.review.storyboard.length && Math.abs(total - state.settings.durationSeconds) > 0.15) {
      errors.push('分镜总时长为 ' + (Math.round(total * 10) / 10) + ' 秒，需与设置的 ' + state.settings.durationSeconds + ' 秒一致。');
    }
    return errors;
  }

  function renderReadiness() {
    renderProductionOptions();
    var checks = baseChecks();
    var readyCount = 0;
    Object.keys(checks).forEach(function renderCheck(key) {
      var item = dom.readinessList.querySelector('[data-check="' + key + '"]');
      if (!item) return;
      if (key === 'model' && item.lastChild && item.lastChild.nodeType === 3) {
        item.lastChild.textContent = state.mode === 'direct' ? '模型已配置且支持当前参数' : '脚本分析可用且参数有效';
      }
      item.classList.toggle('is-ready', checks[key]);
      var symbol = item.querySelector('span');
      if (symbol) symbol.textContent = checks[key] ? '●' : '○';
      if (checks[key]) readyCount += 1;
    });
    dom.readinessCount.textContent = readyCount + ' / 4';

    var errors = validationErrors({ requireReview: false });
    dom.actionSummary.textContent = errors.length ? errors[0] : (state.mode === 'direct' ? '校验已通过，可提交真实任务' : '校验已通过，可分析脚本；生成前仍需核对视频供给');

    var needsReviewScroll = state.mode !== 'direct' &&
      (state.review.state === 'editing' || state.review.state === 'confirmed');
    var canPrimary = needsReviewScroll || errors.length === 0;
    dom.primaryAction.disabled = state.actionPending || !canPrimary;
    dom.resetDraft.disabled = state.actionPending;
    dom.refreshCapabilities.disabled = state.actionPending;
    updatePrimaryActionLabel();
  }

  function confirmRights(checked) {
    state.rightsConfirmed = !!checked;
    if (state.rightsConfirmed) {
      state.rightsConfirmedAt = new Date().toISOString();
      state.rightsFingerprint = assetRightsFingerprint();
    } else {
      state.rightsConfirmedAt = '';
      state.rightsFingerprint = '';
    }
    renderReadiness();
    scheduleDraftSave();
  }

  function normalizeStoryboard(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 30).map(function normalizeShot(item, index) {
      if (typeof item === 'string') {
        return {
          id: 'shot-' + (index + 1),
          visual: cleanText(item),
          narration: '',
          startSecond: 0,
          endSecond: 0,
          composition: '',
          camera: '',
          motion: '',
          rhythm: '',
          audioRole: '',
          reconstructionIntent: '',
          durationSeconds: 0
        };
      }
      item = item && typeof item === 'object' ? item : {};
      var duration = Number(item.durationSeconds || item.duration || item.seconds || 0);
      var startSecond = Number(item.startSecond || 0);
      var endSecond = Number(item.endSecond || 0);
      var structure = {
        startSecond: Number.isFinite(startSecond) && startSecond >= 0 ? startSecond : 0,
        endSecond: Number.isFinite(endSecond) && endSecond >= 0 ? endSecond : 0,
        composition: cleanText(item.composition),
        camera: cleanText(item.camera),
        motion: cleanText(item.motion),
        rhythm: cleanText(item.rhythm),
        audioRole: cleanText(item.audioRole),
        reconstructionIntent: cleanText(item.reconstructionIntent)
      };
      return {
        id: cleanText(item.id || item.shotId) || 'shot-' + (index + 1),
        visual: mergeStructureIntoVisual(
          cleanText(item.visual || item.visualDescription || item.scene || item.imagePrompt || item.description),
          structure
        ),
        narration: cleanText(item.narration || item.voiceover || item.voiceOver || item.copy || item.text),
        startSecond: structure.startSecond,
        endSecond: structure.endSecond,
        composition: structure.composition,
        camera: structure.camera,
        motion: structure.motion,
        rhythm: structure.rhythm,
        audioRole: structure.audioRole,
        reconstructionIntent: structure.reconstructionIntent,
        durationSeconds: Number.isFinite(duration) && duration >= 0 ? Math.round(duration * 10) / 10 : 0
      };
    });
  }

  var STRUCTURE_MARKERS = Object.freeze([
    ['composition', '构图'],
    ['camera', '景别/机位'],
    ['motion', '运镜'],
    ['rhythm', '节奏'],
    ['audioRole', '声音职责'],
    ['reconstructionIntent', '重构意图']
  ]);

  function mergeStructureIntoVisual(visual, structure) {
    var output = cleanText(visual);
    var lines = [];
    if (structure.endSecond > structure.startSecond && !/^【时间】/m.test(output)) {
      lines.push('【时间】' + structure.startSecond + '–' + structure.endSecond + ' 秒');
    }
    STRUCTURE_MARKERS.forEach(function marker(pair) {
      var value = cleanText(structure[pair[0]]);
      var escaped = pair[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (value && !(new RegExp('^【' + escaped + '】', 'm')).test(output)) {
        lines.push('【' + pair[1] + '】' + value);
      }
    });
    return [output, lines.join('\n')].filter(Boolean).join('\n');
  }

  function parseStructureFromVisual(visual, shot) {
    var source = String(visual || '');
    var timeMatch = source.match(/^【时间】\s*([0-9]+(?:\.[0-9]+)?)\s*[–—~-]\s*([0-9]+(?:\.[0-9]+)?)\s*秒?/m);
    if (timeMatch) {
      shot.startSecond = Number(timeMatch[1]);
      shot.endSecond = Number(timeMatch[2]);
    }
    STRUCTURE_MARKERS.forEach(function marker(pair) {
      var escaped = pair[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var match = source.match(new RegExp('^【' + escaped + '】\\s*(.*)$', 'm'));
      shot[pair[0]] = match ? cleanText(match[1]) : '';
    });
  }

  function extractTask(payload) {
    payload = payload || {};
    if (payload.task && typeof payload.task === 'object') return payload.task;
    if (payload.data && payload.data.task && typeof payload.data.task === 'object') return payload.data.task;
    if (payload.taskId || payload.jobId || payload.status || payload.state) return payload;
    return null;
  }

  function extractAnalysis(payload, task) {
    payload = payload || {};
    task = task || {};
    var source = payload.analysis || payload.result || task.analysis || task.result || {};
    if (typeof source === 'string') source = { summary: source };
    if (!source || typeof source !== 'object') source = {};
    var script = cleanText(
      payload.script || payload.generatedScript || source.script || source.generatedScript ||
      task.script || task.generatedScript
    );
    var storyboard = payload.storyboard || payload.shots || source.storyboard || source.shots ||
      task.storyboard || task.shots;
    return {
      summary: cleanText(payload.summary || source.summary || source.creativeSummary || source.analysisSummary || task.summary),
      script: script,
      storyboard: normalizeStoryboard(storyboard)
    };
  }

  async function handlePrimaryAction() {
    if (state.actionPending) return;
    if (usingProductionPlan() && state.productionOptions.mode === 'economic' && state.productionOptions.hybridAiSeconds === 0) { await startGeneration(); return; }
    if (state.mode !== 'direct' &&
        (state.review.state === 'editing' || state.review.state === 'confirmed')) {
      dom.reviewPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      dom.scriptEditor.focus({ preventScroll: true });
      return;
    }
    if (state.mode === 'direct') {
      await startGeneration();
    } else {
      await analyzeDraft();
    }
  }

  async function analyzeDraft() {
    var errors = validationErrors({ requireReview: false });
    if (errors.length) {
      setNotice(dom.composerValidation, errors.join(' '), 'error');
      showToast(errors[0], 'error');
      return;
    }

    var request;
    try {
      request = buildRequest('draft');
    } catch (error) {
      setNotice(dom.composerValidation, safeErrorMessage(error), 'error');
      return;
    }

    setNotice(dom.composerValidation, '', '');
    state.review.state = 'analyzing';
    state.review.confirmed = false;
    state.review.confirmedAt = '';
    renderReview();
    renderTransientJob({
      status: 'analyzing',
      phase: state.mode === 'remix' ? '正在拆解参考视频' : '正在分析商品素材',
      message: '等待后台返回真实脚本与分镜…',
      progress: 0,
      id: ''
    });
    setPending(true, state.mode === 'remix' ? '正在拆解…' : '正在分析…');

    try {
      var response = await sendRuntimeMessage(MESSAGE.ANALYZE, payloadForRequest(request), RUNTIME_TIMEOUT_MS.analysis);
      var payload = responsePayload(response);
      var task = extractTask(payload);
      var analysis = extractAnalysis(payload, task);
      if (analysis.script || analysis.storyboard.length) {
        applyAnalysis(analysis);
        if (task && taskIdOf(task)) {
          await upsertRunFromTask(task, 'analysis', request);
        }
      } else if (task && taskIdOf(task) && isActiveStatus(canonicalStatus(task.status || task.state))) {
        await upsertRunFromTask(task, 'analysis', request);
        scheduleStatusPoll();
      } else if (task && canonicalStatus(task.status || task.state) === 'failed') {
        throw taskError(task);
      } else {
        throw makeStudioError('ANALYSIS_RESULT_MISSING', '后台已响应，但未返回脚本、分镜或可查询的分析任务。');
      }
    } catch (error) {
      state.review.state = state.review.script ? 'stale' : 'idle';
      dom.jobPanel.hidden = true;
      setNotice(dom.composerValidation, '分析未完成：' + safeErrorMessage(error), 'error');
      showToast('分析未完成：' + safeErrorMessage(error), 'error');
    } finally {
      setPending(false);
      renderReview();
      scheduleDraftSave();
    }
  }

  function applyAnalysis(analysis) {
    state.review = {
      state: 'editing',
      analysis: cleanText(analysis.summary),
      script: cleanText(analysis.script),
      storyboard: normalizeStoryboard(analysis.storyboard),
      analysisFingerprint: analysisFingerprint(),
      confirmed: false,
      confirmedAt: ''
    };
    dom.jobPanel.hidden = true;
    renderReview();
    scheduleDraftSave();
    showToast('脚本与分镜已返回，请编辑并确认。', 'success');
    globalThis.setTimeout(function scrollReview() {
      dom.reviewPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 20);
  }

  function renderReview() {
    var visible = state.mode !== 'direct' && state.review.state !== 'idle';
    dom.reviewPanel.hidden = !visible;
    if (!visible) return;

    var statusText = {
      analyzing: '分析中', editing: '待确认', confirmed: '已确认', stale: '需重新分析'
    }[state.review.state] || '待确认';
    dom.reviewState.textContent = statusText;
    dom.reviewState.className = 'state-chip' +
      (state.review.state === 'confirmed' ? ' is-success' :
        (state.review.state === 'stale' ? ' is-error' : ' is-active'));
    dom.analysisSummary.hidden = !state.review.analysis;
    dom.analysisSummary.textContent = state.review.analysis;
    dom.scriptEditor.value = state.review.script;
    dom.scriptEditor.disabled = state.review.state === 'analyzing';
    dom.scriptCount.textContent = state.review.script.length + ' / 4000';
    dom.addShot.disabled = state.review.state === 'analyzing';
    dom.reanalyze.disabled = state.actionPending;
    dom.confirmReview.disabled = state.actionPending || state.review.state === 'analyzing' || state.review.state === 'stale';
    dom.confirmReview.textContent = state.review.confirmed ? '已确认，可重新生成' : '确认脚本与分镜并生成';
    renderStoryboard();
    updatePrimaryActionLabel();
  }

  function renderStoryboard() {
    dom.storyboardList.replaceChildren();
    if (!state.review.storyboard.length) {
      var empty = document.createElement('div');
      empty.className = 'inline-notice';
      empty.textContent = '后台尚未返回分镜。请手动添加至少 1 个镜头后再确认。';
      dom.storyboardList.appendChild(empty);
      return;
    }
    state.review.storyboard.forEach(function renderShot(shot, index) {
      dom.storyboardList.appendChild(createShotCard(shot, index));
    });
  }

  function createShotCard(shot, index) {
    var card = document.createElement('article');
    card.className = 'shot-card';
    card.dataset.shotIndex = String(index);

    var number = document.createElement('div');
    number.className = 'shot-index';
    number.textContent = String(index + 1).padStart(2, '0');

    var visualField = shotTextField('画面与结构拆解（可编辑）', 'visual', shot.visual, index);
    var narrationField = shotTextField('字幕 / 口播', 'narration', shot.narration, index);

    var durationField = document.createElement('div');
    durationField.className = 'shot-field';
    var durationLabel = document.createElement('label');
    durationLabel.textContent = '时长';
    var durationWrap = document.createElement('div');
    durationWrap.className = 'shot-duration';
    var durationInput = document.createElement('input');
    durationInput.type = 'text';
    durationInput.inputMode = 'decimal';
    durationInput.value = shot.durationSeconds || '';
    durationInput.dataset.shotIndex = String(index);
    durationInput.dataset.shotField = 'durationSeconds';
    durationInput.setAttribute('aria-label', '镜头 ' + (index + 1) + ' 时长（秒）');
    var seconds = document.createElement('span');
    seconds.textContent = '秒';
    durationWrap.append(durationInput, seconds);
    durationField.append(durationLabel, durationWrap);

    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-shot';
    remove.dataset.removeShot = String(index);
    remove.setAttribute('aria-label', '删除镜头 ' + (index + 1));
    remove.textContent = '×';
    card.append(number, visualField, narrationField, durationField, remove);
    return card;
  }

  function shotTextField(labelText, field, value, index) {
    var wrapper = document.createElement('div');
    wrapper.className = 'shot-field' + (field === 'visual' ? ' is-visual' : '');
    var label = document.createElement('label');
    label.textContent = labelText;
    var textarea = document.createElement('textarea');
    textarea.rows = 2;
    textarea.maxLength = 2000;
    textarea.value = value;
    textarea.dataset.shotIndex = String(index);
    textarea.dataset.shotField = field;
    textarea.setAttribute('aria-label', '镜头 ' + (index + 1) + ' ' + labelText);
    wrapper.append(label, textarea);
    return wrapper;
  }

  function syncReviewFromDom() {
    state.review.script = cleanText(dom.scriptEditor.value);
    dom.scriptCount.textContent = dom.scriptEditor.value.length + ' / 4000';
    state.review.confirmed = false;
    state.review.confirmedAt = '';
    if (state.review.state === 'confirmed') state.review.state = 'editing';
    renderReadiness();
    scheduleDraftSave();
  }

  function updateShot(index, field, rawValue) {
    var shot = state.review.storyboard[index];
    if (!shot) return;
    shot[field] = field === 'durationSeconds'
      ? (Number.isFinite(Number(rawValue)) ? Number(rawValue) : 0)
      : String(rawValue || '');
    if (field === 'visual') parseStructureFromVisual(shot.visual, shot);
    state.review.confirmed = false;
    state.review.confirmedAt = '';
    if (state.review.state === 'confirmed') state.review.state = 'editing';
    setNotice(dom.reviewValidation, '', '');
    renderReadiness();
    scheduleDraftSave();
  }

  function addShot() {
    var total = state.review.storyboard.reduce(function sum(value, shot) {
      return value + (Number(shot.durationSeconds) || 0);
    }, 0);
    var remaining = Math.max(0, state.settings.durationSeconds - total);
    state.review.storyboard.push({
      id: makeId('shot'),
      visual: '',
      narration: '',
      startSecond: total,
      endSecond: total + (remaining || 1),
      composition: '',
      camera: '',
      motion: '',
      rhythm: '',
      audioRole: '',
      reconstructionIntent: '',
      durationSeconds: remaining ? Math.round(remaining * 10) / 10 : 1
    });
    state.review.confirmed = false;
    state.review.confirmedAt = '';
    if (state.review.state === 'confirmed') state.review.state = 'editing';
    renderReview();
    scheduleDraftSave();
  }

  function removeShot(index) {
    if (!state.review.storyboard[index]) return;
    state.review.storyboard.splice(index, 1);
    state.review.confirmed = false;
    state.review.confirmedAt = '';
    if (state.review.state === 'confirmed') state.review.state = 'editing';
    renderReview();
    scheduleDraftSave();
  }

  async function confirmReviewAndGenerate() {
    syncReviewFromDom();
    var fingerprint = analysisFingerprint();
    if (state.review.analysisFingerprint !== fingerprint) {
      state.review.state = 'stale';
      setNotice(dom.reviewValidation, '商品素材、创作要求或生成设置已变化，请重新分析。', 'error');
      renderReview();
      return;
    }
    var storyboardErrors = validateStoryboard();
    if (!state.review.script) storyboardErrors.unshift('确认脚本不能为空。');
    if (storyboardErrors.length) {
      setNotice(dom.reviewValidation, storyboardErrors.join(' '), 'error');
      return;
    }
    state.review.confirmed = true;
    state.review.confirmedAt = new Date().toISOString();
    state.review.state = 'confirmed';
    setNotice(dom.reviewValidation, '脚本与分镜已确认，将按当前版本提交。', 'success');
    renderReview();
    await saveCurrentDraft().catch(function ignore() {});
    await startGeneration();
  }

  function makeStudioError(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
  }

  function taskError(task) {
    var message = cleanText(task.error && task.error.message) || cleanText(task.error) || cleanText(task.message) || '任务失败。';
    return makeStudioError(cleanText(task.errorCode || (task.error && task.error.code)) || 'TASK_FAILED', message);
  }

  function usingProductionPlan() { return !!Production && state.legacySingle !== true; }
  function productionModeLabel(mode) { return { economic: '经济', balanced: '均衡', quality: '质量' }[mode] || '质量'; }
  function normalizeProductionAudio(raw) {
    var volume = raw && raw.sourceAudioVolume != null ? Number(raw.sourceAudioVolume) : 0;
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw makeStudioError('PRODUCTION_AUDIO_VOLUME', '已有视频原声音量必须为 0–100%。');
    return { sourceAudioVolume: volume };
  }
  function finalAudioRole(asset) {
    return ['narration', 'music', 'disabled'].indexOf(asset.finalAudioRole) >= 0 ? asset.finalAudioRole : 'narration';
  }
  function finalAudioVolume(asset, role) {
    var volume = asset.finalAudioVolume == null ? (role === 'music' ? 0.25 : 1) : Number(asset.finalAudioVolume);
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw makeStudioError('PRODUCTION_AUDIO_VOLUME', '最终音轨音量必须为 0–100%。');
    return volume;
  }
  function snapshotProductionAudio(totalSeconds) {
    var tracks = [], assets = [], counts = { narration: 0, music: 0 };
    state.assets.audio.forEach(function (asset) {
      var role = finalAudioRole(asset);
      if (role === 'disabled') return;
      counts[role] += 1;
      if (counts[role] > 1) throw makeStudioError('PRODUCTION_AUDIO_DUPLICATE', '一次成片可选择一条最终口播和一条背景音乐，其余音频请选择“不加入成片”。');
      var duration = Number(asset.durationSec);
      if (!Number.isFinite(duration) || duration <= 0) throw makeStudioError('PRODUCTION_AUDIO_DURATION', '最终音频时长未知，请重新上传完整音频。');
      if (role === 'narration' && duration > totalSeconds) throw makeStudioError('PRODUCTION_NARRATION_TOO_LONG', '最终口播长于 ' + totalSeconds + ' 秒成片，请增加成片时长或上传完整的较短口播；不会自动截断。');
      var track = { id: asset.id, assetId: asset.id, role: role, volume: finalAudioVolume(asset, role), startSeconds: 0, loop: role === 'music' && asset.finalAudioLoop !== false };
      tracks.push(Object.freeze(track)); assets.push(Object.freeze(serializeAsset(asset)));
    });
    return Object.freeze({ version: 1, tracks: Object.freeze(tracks), assets: Object.freeze(assets), sourceAudioVolume: normalizeProductionAudio(state.productionAudio).sourceAudioVolume });
  }
  function appendFinalAudioControls(info, asset) {
    var role = finalAudioRole(asset), select = document.createElement('select');
    select.className = 'asset-role-select'; select.dataset.finalAudioRole = asset.id;
    select.setAttribute('aria-label', '设置 ' + asset.name + ' 的最终成片用途');
    [['narration', '最终口播 · 完整保留'], ['music', '背景音乐'], ['disabled', '不加入成片']].forEach(function (pair) { var option = document.createElement('option'); option.value = pair[0]; option.textContent = pair[1]; select.appendChild(option); });
    select.value = role; select.disabled = state.actionPending; info.appendChild(select);
    var player = document.createElement('audio'); player.controls = true; player.preload = 'metadata'; player.src = asset.previewUrl || '';
    player.className = 'final-audio-preview'; player.setAttribute('aria-label', '试听完整音频 ' + asset.name); info.appendChild(player);
    if (role === 'disabled') return;
    var volume = document.createElement('label'), output = document.createElement('output'), range = document.createElement('input');
    volume.className = 'final-audio-volume'; volume.append('成片音量 '); output.textContent = Math.round(finalAudioVolume(asset, role) * 100) + '%'; output.dataset.finalAudioVolumeOutput = asset.id; volume.appendChild(output);
    range.type = 'range'; range.min = '0'; range.max = '1'; range.step = '0.05'; range.value = String(finalAudioVolume(asset, role)); range.dataset.finalAudioGain = asset.id; range.disabled = state.actionPending; range.setAttribute('aria-label', asset.name + ' 成片音量'); volume.appendChild(range); info.appendChild(volume);
    if (role === 'music') {
      var loopLabel = document.createElement('label'), loop = document.createElement('input'); loop.type = 'checkbox'; loop.checked = asset.finalAudioLoop !== false; loop.dataset.finalAudioLoop = asset.id; loop.disabled = state.actionPending;
      loopLabel.className = 'final-audio-loop'; loopLabel.append(loop, '短音乐循环至成片结束'); info.appendChild(loopLabel);
    }
  }
  function normalizeProductionOptions(raw) {
    raw = raw || {};
    if (raw.maxAttempts != null && (!Number.isInteger(Number(raw.maxAttempts)) || Number(raw.maxAttempts) < 1 || Number(raw.maxAttempts) > 2)) throw makeStudioError('PRODUCTION_ATTEMPTS_INVALID', '每镜最多尝试 1–2 次。');
    if (raw.hybridAiSeconds != null && [0, 5, 10, 15].indexOf(Number(raw.hybridAiSeconds)) < 0) throw makeStudioError('PRODUCTION_AI_DURATION_INVALID', '经济方案 AI 时长只能为 0 / 5 / 10 / 15 秒。');
    if (Production) return Production.normalizeOptions(Object.assign({ totalDurationSeconds: 15, hybridAiSeconds: 0, budgetYuan: 10, maxAttempts: 1 }, raw));
    return Object.assign({ mode: 'quality', totalDurationSeconds: 15, hybridAiSeconds: 0, budgetYuan: 10, maxAttempts: 1 }, raw);
  }
  function productionTemplate(options) {
    options = options || {};
    // The planner owns the long timeline. The legacy request snapshot remains within its model's limit.
    var request = {
      mode: state.mode, productKey: state.settings.productKey, durationSeconds: state.settings.durationSeconds,
      resolution: '720p', ratio: state.settings.ratio, audioMode: state.settings.audioMode,
      narrationLanguage: state.settings.narrationLanguage, creativeRoute: state.settings.creativeRoute,
      styleProfile: state.settings.styleProfile, script: state.mode === 'direct' ? state.prompt : (state.review.script || state.prompt),
      goal: state.prompt, supplementalRequirements: state.expertEnabled ? state.expertRequirements : '',
      scriptConfirmed: state.review.confirmed, storyboard: state.review.storyboard,
      images: state.assets.image.map(function (asset) { return assetForRequest(asset, { allowUnprepared: !options.confirmed || (state.productionOptions.mode === 'economic' && state.productionOptions.hybridAiSeconds === 0) }); }), videos: state.assets.video.map(assetForRequest), audios: [],
      rights: { confirmed: state.rightsConfirmed, confirmedAt: state.rightsConfirmedAt, fingerprint: state.rightsFingerprint }
    };
    if (!options.confirmed || (state.productionOptions.mode === 'economic' && state.productionOptions.hybridAiSeconds === 0)) { request.mode = 'direct'; request.storyboard = []; }
    else if (request.mode !== 'direct') {
      var storyboard = Contract.normalizeStoryboard(request.storyboard);
      request.storyboard = storyboard; request.reviewConfirmedAt = state.review.confirmedAt;
      request.reviewFingerprint = Contract.reviewFingerprint(request.script, storyboard);
    }
    if (typeof Contract.assetRightsFingerprint === 'function') request.rights.fingerprint = Contract.assetRightsFingerprint(request);
    return request;
  }
  function previewProductionPlan(options) {
    if (!Production) throw makeStudioError('PRODUCTION_UNAVAILABLE', '成片方案模块未加载，请刷新工作台。');
    var plan = Production.buildPlan(productionTemplate(options), state.productionOptions);
    return Object.assign({}, plan, { finalAudio: snapshotProductionAudio(plan.totalSeconds) });
  }
  function productionUsesPlatform(plan, run) {
    function native(item) { return !!item && (item.nativePlatform === true || item.provider === 'shaozhuang-native' || item.adapter === 'sanjie-native' || /^nv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.providerTaskId || '')); }
    if (native(run) || run && (run.shotRuns || []).some(function (shot) { return native(shot) || (shot.attempts || []).some(native); })) return true;
    if (!state.backendConnected || state.credentialAvailable !== true || native(state.capabilities)) return true;
    var ai = plan && (plan.shots || []).filter(function (shot) { return shot.kind === 'ai'; });
    if (ai && ai.length) return ai.some(function (shot) { var model = state.modelCatalog.find(function (item) { return item.productKey === shot.productKey; }); return !model || model.nativePlatform === true; });
    var selected = getSelectedModel();
    return !state.backendConnected || !!(selected && selected.nativePlatform);
  }
  function analysisRequestError() {
    if (state.mode === 'remix') {
      if (!state.reference) return '爆款复刻必须上传 1 个独立参考视频。';
      if (state.referenceFrames.length !== 5) return '参考视频需成功提取 5 个本地关键帧后才能分析。';
    }
    if (state.expertEnabled && !state.expertRequirements) return '专家模式已开启，请填写高级约束或关闭专家模式。';
    try { buildRequest('draft'); }
    catch (error) { return safeErrorMessage(error, '当前路线或素材不符合分析合同。'); }
    return '';
  }
  function productionValidationErrors(options) {
    options = options || {};
    var errors = [], plan;
    if (!state.prompt) errors.push('请填写创作要求。');
    var hasAssets = state.assets.image.length || state.assets.video.length || state.assets.audio.length || state.reference;
    if (hasAssets && (!state.rightsConfirmed || state.rightsFingerprint !== assetRightsFingerprint())) errors.push('请确认素材权利，素材变化后需要重新确认。');
    var localOnly = state.productionOptions.mode === 'economic' && state.productionOptions.hybridAiSeconds === 0;
    if (state.mode === 'direct' || options.requireReview || localOnly) errors = errors.concat(materialValidationErrors());
    if (state.mode !== 'direct' && !options.requireReview && !localOnly) {
      var analysisError = analysisRequestError();
      if (analysisError) errors.push(analysisError);
    }
    try { plan = previewProductionPlan(); }
    catch (error) { errors.push(safeErrorMessage(error)); }
    if (plan) {
      var ai = plan.shots.filter(function (shot) { return shot.kind === 'ai'; });
      if (ai.length && !state.backendConnected) errors.push(state.capabilityError || '后台生成能力未连接。');
      var analyzing = state.mode !== 'direct' && !options.requireReview;
      if (ai.length && analyzing && state.analysisAvailable === false) errors.push('脚本分析不可用，请先配置分析 API。');
      if (ai.length && (!analyzing || options.requireReview)) ai.forEach(function (shot) {
        var model = state.modelCatalog.find(function (item) { return item.productKey === shot.productKey; });
        if (!model || !model.configured || model.resolutions.indexOf('720p') < 0 || (nativeDurations(model).length && nativeDurations(model).indexOf(5) < 0)) errors.push('方案使用的 ' + (Contract.MODEL_DISPLAY_NAMES[shot.productKey] || shot.productKey) + ' 模型当前不可用或不支持 720p / 5 秒。');
      });
      var reserve = plan.shots.reduce(function (sum, shot) { return sum + (shot.kind === 'ai' ? Math.ceil(Number(shot.estimatedYuan) * 110) / 100 : 0); }, 0);
      if (reserve > state.productionOptions.budgetYuan + 0.00001) errors.push(productionUsesPlatform(plan) ? '本次生成已达到预算限制，请调整成片方案。' : '首轮参考费用含 10% 预留超出估算预算，请调整方案或预算。');
      if (ai.length && options.requireReview && state.mode !== 'direct' && !state.review.confirmed) errors.push('请确认脚本与分镜后生成。');
    }
    return Array.from(new Set(errors));
  }
  function renderProductionOptions() {
    if (!dom.productionModes) return;
    dom.productionModes.querySelectorAll('[data-production-mode]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.productionMode === state.productionOptions.mode));
      button.disabled = state.actionPending;
    });
    dom.productionDuration.value = String(state.productionOptions.totalDurationSeconds || 15);
    dom.productionAiSeconds.value = String(state.productionOptions.hybridAiSeconds || 0);
    dom.productionAiWrap.hidden = state.productionOptions.mode !== 'economic';
    dom.productionBudget.value = String(state.productionOptions.budgetYuan);
    dom.productionAttempts.value = String(state.productionOptions.maxAttempts);
    [dom.productionDuration, dom.productionAiSeconds, dom.productionBudget, dom.productionAttempts].forEach(function (input) { input.disabled = state.actionPending; });
    var legacy = state.legacySingle;
    if (dom.productionFinalAudio) dom.productionFinalAudio.hidden = legacy || !Production;
    if (dom.supplierAudioFieldset) dom.supplierAudioFieldset.hidden = !legacy && !!Production;
    if (!legacy && Production) { dom.narrationSettings.hidden = true; dom.audioConstraintNote.hidden = true; }
    if (dom.productionSourceVolume) { dom.productionSourceVolume.value = String(state.productionAudio.sourceAudioVolume); dom.productionSourceVolume.disabled = state.actionPending; dom.productionSourceVolumeOutput.textContent = Math.round(state.productionAudio.sourceAudioVolume * 100) + '%'; }
    if (dom.assetList) dom.assetList.querySelectorAll('[data-final-audio-role], [data-final-audio-gain], [data-final-audio-loop]').forEach(function (input) { input.disabled = state.actionPending; });
    if (dom.durationInput && dom.durationInput.closest('.duration-group')) dom.durationInput.closest('.duration-group').hidden = !legacy && !!Production;
    var selected = getSelectedModel();
    var platform = productionUsesPlatform(null);
    var budgetField = dom.productionBudget.closest('label');
    function budgetVisibility(hide) {
      if (budgetField) { budgetField.hidden = hide; budgetField.style.display = hide ? 'none' : ''; }
      dom.productionEstimate.hidden = hide; dom.productionEstimate.style.display = hide ? 'none' : '';
    }
    budgetVisibility(platform);
    if (!legacy && state.productionOptions.mode !== 'quality') dom.modelSelect.disabled = true;
    else dom.modelSelect.disabled = state.actionPending;
    try {
      if (legacy) {
        dom.productionEstimate.textContent = '旧草稿 · 保留原单片参数';
        dom.productionNote.textContent = '原模型、时长、清晰度和声音选择继续使用；点击任一方案后才转为 5 秒镜头合成。';
      } else {
        var plan = previewProductionPlan();
        platform = productionUsesPlatform(plan); budgetVisibility(platform);
        if (dom.productionAudioSummary) dom.productionAudioSummary.textContent = plan.finalAudio.tracks.length ? plan.finalAudio.tracks.map(function (track) { var asset = plan.finalAudio.assets.find(function (item) { return item.id === track.assetId; }); return (track.role === 'narration' ? '完整口播 ' : '背景音乐 ') + formatDuration(asset.durationSec) + ' · 音量 ' + Math.round(track.volume * 100) + '%' + (track.loop ? ' · 循环' : ''); }).join('；') : '未选择最终音轨；按已有视频原声音量输出。';
        var reserve = plan.shots.reduce(function (sum, shot) { return sum + (shot.kind === 'ai' ? Math.ceil(Number(shot.estimatedYuan) * 110) / 100 : 0); }, 0);
        dom.productionEstimate.textContent = '首轮上游估算 ¥' + Number(plan.estimateYuan).toFixed(2) + ' · 含预留 ¥' + reserve.toFixed(2) + ' / 预算 ¥' + Number(state.productionOptions.budgetYuan).toFixed(2);
        dom.productionNote.textContent = plan.aiSeconds + ' 秒 AI + ' + plan.localSeconds + ' 秒素材；统一 720p。' + (platform ? plan.aiSeconds ? '平台每镜提交时按本次固定报价扣积分，成功不调差额，失败退回，取消不退。失败镜头仅手动重试，成功但不采用仍计费。' : '使用已有素材在本地合成。' : '超过估算预算停止后续镜头；自有 API 费用由对应服务计费。失败镜头仅手动重试，成功但不采用仍计成本。');
      }
    } catch (error) {
      dom.productionEstimate.textContent = '先补齐方案素材';
      dom.productionNote.textContent = safeErrorMessage(error);
      if (dom.productionAudioSummary) dom.productionAudioSummary.textContent = safeErrorMessage(error);
    }
  }
  function bindProductionEvents() {
    if (!dom.productionModes) return;
    dom.productionModes.addEventListener('click', function (event) {
      var button = event.target.closest('[data-production-mode]');
      if (!button || state.actionPending) return;
      state.legacySingle = false;
      state.productionOptions = normalizeProductionOptions(Object.assign({}, state.productionOptions, { mode: button.dataset.productionMode }));
      state.settings.resolution = '720p';
      applySettingsToDom(); renderMode(); renderAssets(); updateEstimate(); renderReadiness(); scheduleDraftSave();
    });
    [dom.productionDuration, dom.productionAiSeconds, dom.productionBudget, dom.productionAttempts].forEach(function (input) {
      input.addEventListener('change', function () {
        try {
          state.productionOptions = normalizeProductionOptions({ mode: state.productionOptions.mode,
            totalDurationSeconds: Number(dom.productionDuration.value), hybridAiSeconds: Number(dom.productionAiSeconds.value),
            budgetYuan: Number(dom.productionBudget.value), maxAttempts: Number(dom.productionAttempts.value) });
          updateEstimate(); renderReadiness(); scheduleDraftSave();
        } catch (error) { setNotice(dom.composerValidation, safeErrorMessage(error), 'error'); }
      });
    });
    dom.productionBudget.addEventListener('input', function () {
      var raw = dom.productionBudget.value;
      if (!raw.trim() || !Number.isFinite(Number(raw)) || Number(raw) < 0 || Number(raw) > 100000) return;
      try {
        state.productionOptions = normalizeProductionOptions(Object.assign({}, state.productionOptions, { budgetYuan: Number(raw) }));
        updateEstimate(); renderReadiness(); scheduleDraftSave();
        dom.productionBudget.value = raw;
      } catch (_) { /* Keep incomplete input intact until the user commits it. */ }
    });
    if (dom.productionSourceVolume) dom.productionSourceVolume.addEventListener('input', function () {
      state.productionAudio = normalizeProductionAudio({ sourceAudioVolume: Number(dom.productionSourceVolume.value) });
      renderProductionOptions(); scheduleDraftSave();
    });
    dom.productionResume.addEventListener('click', function () { if (!state.productionStarting && state.productionRun) executeProductionRun(state.productionRun); });
    if (dom.productionNewPlan) dom.productionNewPlan.addEventListener('click', startNewProductionPlan);
    if (dom.productionStop) dom.productionStop.addEventListener('click', function () {
      if (state.productionAbortController) state.productionAbortController.abort();
      setNotice(dom.productionRunNotice, '已请求停止本地合成，已生成镜头和费用记录保留。', 'error');
    });
    dom.productionShotList.addEventListener('click', function (event) {
      var button = event.target.closest('[data-production-shot-action]');
      if (!button || state.productionBusy || state.productionStarting || !state.productionRun) return;
      var shot = state.productionRun.shotRuns.find(function (item) { return item.id === button.dataset.shotId; });
      if (!shot) return;
      if (button.dataset.productionShotAction === 'retry') retryProductionShot(state.productionRun, shot.id);
      if (button.dataset.productionShotAction === 'adopt') {
        shot.adoptionStatus = shot.adoptionStatus === 'rejected' ? 'accepted' : 'rejected';
        state.productionRun.status = 'failed';
        state.productionRun.error = shot.adoptionStatus === 'rejected' ? '成功镜头已标记不采用，费用保留；请完成采用选择后继续合成。' : '采用选择已更新；继续计划可复用成功镜头重新合成。';
        persistProductionRun(state.productionRun).catch(function (error) { showToast(safeErrorMessage(error), 'error'); });
      }
    });
  }
  function productionCostNumber(value) {
    if (value == null || (typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return null;
    var number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }
  function productionCostSummary(run) {
    var summary = { committedYuan: 0, settledYuan: 0, reservedYuan: 0, settledCount: 0, unsettledCount: 0, unknownReservationCount: 0 };
    run.shotRuns.forEach(function (shot) {
      (shot.attempts || []).forEach(function (attempt) {
        var actual = productionCostNumber(attempt.actualCostYuan);
        if (actual !== null) { summary.settledYuan += actual; summary.settledCount += 1; return; }
        if (attempt.released) return;
        var reserve = productionCostNumber(attempt.reservedYuan), estimate = productionCostNumber(attempt.estimatedYuan);
        if (reserve === null && estimate !== null) reserve = Math.ceil(estimate * 110) / 100;
        if (reserve === null) { reserve = Number(run.plan.options.budgetYuan); summary.unknownReservationCount += 1; }
        summary.reservedYuan += reserve; summary.unsettledCount += 1;
      });
    });
    summary.settledYuan = Math.round(summary.settledYuan * 100) / 100;
    summary.reservedYuan = Math.round(summary.reservedYuan * 100) / 100;
    summary.committedYuan = Math.round((summary.settledYuan + summary.reservedYuan) * 100) / 100;
    return summary;
  }
  function productionCommitments(run) {
    return productionCostSummary(run).committedYuan;
  }
  async function persistProductionRun(run) {
    assertProductionAccount(run);
    run.updatedAt = new Date().toISOString();
    run.committedYuan = productionCommitments(run);
    var saved = await Store.saveRun(run);
    if (saved && saved.accountKey) run.accountKey = saved.accountKey;
    assertProductionAccount(run);
    var index = state.history.findIndex(function (item) { return item.id === run.id; });
    if (index < 0) state.history.unshift(run); else state.history[index] = run;
    state.productionRun = run; renderProductionRun(); renderHistory();
    return run;
  }
  function assertProductionAccount(run) {
    if (run.accountKey && run.accountKey !== state.accountKey) throw makeStudioError('PRODUCTION_ACCOUNT_CHANGED', '账号已切换，原计划和已生成镜头保留在原账号，请切回后继续。');
  }
  function assertProductionAssetAccount(run, asset) {
    assertProductionAccount(run);
    if (asset && asset.accountKey && asset.accountKey !== run.accountKey) throw makeStudioError('PRODUCTION_ASSET_ACCOUNT', '镜头素材属于其他账号，请切回原账号后继续。');
  }
  function canStartNewProductionPlan(run) {
    if (!run || run.purpose !== 'production' || run.status !== 'failed' || !state.accountKey || run.accountKey !== state.accountKey ||
        !Array.isArray(run.shotRuns) || !run.shotRuns.length) return false;
    function unresolved(receipt) {
      if (!receipt || typeof receipt !== 'object') return false;
      if (receipt.stateUncertain === true || receipt.cancelPending || submissionStateUncertain(receipt) ||
          ['succeeded', 'submitting', 'processing', 'queued', 'running', 'unknown'].indexOf(receipt.status || receipt.state) >= 0 ||
          receipt.resultAssetId || (Array.isArray(receipt.resultUrls) && receipt.resultUrls.length)) return true;
      return Object.keys(receipt).some(function (key) {
        var value = receipt[key];
        return value && typeof value === 'object' && (Array.isArray(value) ? value.some(unresolved) : unresolved(value));
      });
    }
    var shots = run.shotRuns.concat(run.narrationRuns || []);
    return !unresolved(run) && shots.every(function (shot) { return shot && ['failed', 'pending', 'ready'].indexOf(shot.status) >= 0; });
  }
  function releasedProductionPlan(run) { return !!(run && run.newPlanRequestedAt && canStartNewProductionPlan(run)); }
  async function startNewProductionPlan() {
    var run = state.productionRun;
    if (state.actionPending || state.productionBusy || state.productionStarting || !canStartNewProductionPlan(run) || run.newPlanRequestedAt) return false;
    state.productionStarting = true; renderProductionRun();
    try {
      // Record the user's choice without replacing the original snapshot or its receipts.
      var released = Object.assign({}, run, { newPlanRequestedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await Store.saveRun(released);
      assertProductionAccount(released);
      if (state.productionRun !== run || !canStartNewProductionPlan(run)) return false;
      var index = state.history.findIndex(function (item) { return item.id === run.id; });
      if (index < 0) state.history.unshift(released); else state.history[index] = released;
      state.productionRun = null;
      renderHistory();
      setNotice(dom.composerValidation, '原计划与费用记录已保留。可编辑当前素材和方案，再点击生成创建新计划。', 'success');
      return true;
    } catch (error) {
      setNotice(dom.composerValidation, safeErrorMessage(error), 'error');
      return false;
    } finally { state.productionStarting = false; renderProductionRun(); }
  }
  function renderProductionRun() {
    if (!dom.productionPanel) return;
    var run = state.productionRun;
    dom.productionPanel.hidden = !run;
    if (!run) return;
    dom.productionResume.disabled = state.productionBusy || state.productionStarting || run.status === 'succeeded' || releasedProductionPlan(run);
    if (dom.productionNewPlan) {
      dom.productionNewPlan.hidden = !!run.newPlanRequestedAt || !canStartNewProductionPlan(run);
      dom.productionNewPlan.disabled = state.actionPending || state.productionBusy || state.productionStarting;
    }
    if (dom.productionNewPlanHelp) dom.productionNewPlanHelp.hidden = !dom.productionNewPlan || dom.productionNewPlan.hidden;
    if (globalThis.SZCreativeCredits) globalThis.SZCreativeCredits.annotate(dom.productionResume, productionRunCreditSpec(run));
    if (dom.productionStop) { dom.productionStop.hidden = !state.productionBusy || run.phase !== 'rendering'; dom.productionStop.disabled = !state.productionAbortController; }
    var costs = productionCostSummary(run);
    var platform = productionUsesPlatform(run.plan, run);
    var receipt = costs.unsettledCount ? '实际费用未结算（' + costs.unsettledCount + ' 次提交，暂按含 10% 预留占用 ¥' + costs.reservedYuan.toFixed(2) + '）' : costs.settledCount ? '回执已结算 ¥' + costs.settledYuan.toFixed(2) : run.plan.aiSeconds === 0 ? '本地合成，未调用上游' : '尚无未结算的 AI 提交';
    if (costs.unsettledCount && costs.settledCount) receipt += '；另有回执已结算 ¥' + costs.settledYuan.toFixed(2);
    if (costs.unknownReservationCount) receipt += '；预留金额缺失，预算暂锁待核对';
    dom.productionRunSummary.textContent = productionModeLabel(run.plan.options.mode) + ' · ' + run.durationSeconds + ' 秒 · ' + (run.plan.aiSeconds === 0 ? '本地合成' : platform ? '平台每镜提交时按本次固定报价扣积分，成功不调差额，失败退回，取消不退。' : '预算占用 ¥' + costs.committedYuan.toFixed(2) + ' / 估算预算 ¥' + Number(run.plan.options.budgetYuan).toFixed(2) + ' · ' + receipt);
    dom.productionShotList.replaceChildren();
    run.shotRuns.forEach(function (shot) {
      var definition = run.plan.shots.find(function (item) { return item.id === shot.id; });
      var row = document.createElement('div'); row.className = 'production-shot-row is-' + shot.status;
      var main = document.createElement('div'), title = document.createElement('strong'), note = document.createElement('small');
      title.textContent = '镜头 ' + (definition.index + 1) + ' · ' + definition.durationSeconds + ' 秒 · ' + (definition.kind === 'local' ? '已有素材' : Contract.MODEL_DISPLAY_NAMES[definition.productKey] || definition.productKey);
      note.textContent = ({ pending: '待生成', ready: '素材就绪', submitting: '提交中', processing: '生成中', unknown: '接收状态未知：保留预算，只核对任务', succeeded: '已转存，可复用', failed: '失败，可手动重试' }[shot.status] || shot.status) + ' · 尝试 ' + (shot.attempts || []).length + ' / ' + run.plan.options.maxAttempts + (shot.adoptionStatus === 'rejected' ? ' · 不采用，费用保留' : '') + (shot.error ? ' · ' + shot.error : '');
      main.append(title, note); row.appendChild(main);
      var actions = document.createElement('div'); actions.className = 'production-shot-actions';
      function action(label, type) { var button = document.createElement('button'); button.className = 'button button-secondary button-small'; button.type = 'button'; button.textContent = label; button.dataset.productionShotAction = type; button.dataset.shotId = shot.id; button.disabled = state.productionBusy || state.productionStarting; actions.appendChild(button); return button; }
      var retryButton;
      if (!releasedProductionPlan(run) && shot.status === 'failed' && shot.attempts.length < run.plan.options.maxAttempts) retryButton = action('仅重试此镜', 'retry');
      if (shot.status === 'succeeded') action(shot.adoptionStatus === 'rejected' ? '采用此镜' : '标记不采用', 'adopt');
      row.appendChild(actions); dom.productionShotList.appendChild(row);
      if (retryButton && globalThis.SZCreativeCredits) globalThis.SZCreativeCredits.annotate(retryButton, productionRunCreditSpec(run, shot.id));
    });
    setNotice(dom.productionRunNotice, run.error || (run.status === 'succeeded' ? '成片已保存，可以从生成历史预览与下载。' : ''), run.status === 'succeeded' ? 'success' : 'error');
  }
  async function startProductionGeneration() {
    if (state.productionBusy || state.productionStarting || state.assetPreparing || state.actionPending) return;
    var errors = productionValidationErrors({ requireReview: true });
    if (errors.length) { setNotice(dom.composerValidation, errors.join(' '), 'error'); return; }
    if (state.productionRun && state.productionRun.status !== 'succeeded' &&
        !releasedProductionPlan(state.productionRun)) {
      setNotice(dom.composerValidation, '已有未完成的成片计划，请使用“继续 / 核对已提交镜头”；改方案不会重复提交旧镜头。', 'error');
      renderProductionRun(); return;
    }
    var preparationPlan = previewProductionPlan();
    if (preparationPlan.shots.some(function (shot) { return shot.kind === 'ai'; }) && !await prepareVideoAssets({ pollUntilReady: true })) return;
    state.productionStarting = true; setPending(true, '正在保存成片计划…');
    try {
    var plan = previewProductionPlan({ confirmed: true });
    // A new user-approved plan gets a fresh identity; its shots and attempts remain stable on reload.
    plan = Object.assign({}, plan, { id: makeId('production') });
    var run = { id: plan.id, taskId: plan.id, purpose: 'production', accountKey: state.accountKey,
      mode: state.mode, status: 'queued', phase: 'planned', plan: plan, durationSeconds: plan.totalSeconds,
      resolution: '720p', ratio: plan.ratio, productKey: state.settings.productKey, creativeRoute: state.settings.creativeRoute,
      styleProfile: state.settings.styleProfile, prompt: state.prompt, createdAt: new Date().toISOString(),
      resultUrls: [], shotRuns: plan.shots.map(function (shot) { return { id: shot.id, status: shot.kind === 'local' ? 'ready' : 'pending', adoptionStatus: 'accepted', attempts: [], taskId: '', resultAssetId: '' }; }) };
    await persistProductionRun(run);
    await executeProductionRun(run);
    } finally { state.productionStarting = false; if (!state.productionBusy) setPending(false); }
  }
  async function productionSourceAsset(run, id, options) {
    assertProductionAccount(run);
    var asset = await Store.getAsset(id);
    assertProductionAssetAccount(run, asset);
    if (asset && asset.blob) return asset;
    var request = run.plan.request || {};
    var remote = [].concat(request.images || [], request.videos || [], request.audios || [], run.plan.finalAudio && run.plan.finalAudio.assets || []).find(function (item) { return item.id === id; });
    if (!remote || !/^https:/.test(remote.remoteUrl || '')) throw makeStudioError('PRODUCTION_ASSET_MISSING', '镜头素材无法读取，请恢复原素材：' + id);
    var response = await globalThis.fetch(remote.remoteUrl, { cache: 'no-store', signal: options && options.signal });
    if (!response.ok) throw makeStudioError('PRODUCTION_ASSET_FETCH', '镜头素材下载失败（HTTP ' + response.status + '）。');
    return { blob: await response.blob(), kind: remote.kind, mimeType: remote.mimeType, durationSec: remote.durationSeconds || remote.durationSec };
  }
  function productionAttempt(shot) { return shot.attempts[shot.attempts.length - 1]; }
  async function updateProductionTask(run, shot, task) {
    var attempt = productionAttempt(shot);
    shot.taskId = taskIdOf(task) || shot.taskId;
    shot.providerTaskId = cleanText(task.providerTaskId) || shot.providerTaskId;
    shot.status = task.status === 'unknown' || submissionStateUncertain(task) ? 'unknown' : canonicalStatus(task.status) || 'processing';
    shot.error = cleanText(task.error && task.error.message) || cleanText(typeof task.error === 'string' ? task.error : '') || '';
    shot.resultUrls = resultUrlsOf(task);
    attempt.taskId = shot.taskId; attempt.providerTaskId = shot.providerTaskId;
    var reserve = productionCostNumber(task.production && task.production.reservedYuan);
    if (reserve !== null) attempt.reservedYuan = reserve;
    var actual = productionCostNumber(task.actualCostYuan);
    if (actual === null) actual = productionCostNumber(task.production && task.production.actualCostYuan);
    if (actual !== null) { attempt.actualCostYuan = actual; attempt.costSource = 'provider_receipt'; }
    if (shot.status === 'succeeded') attempt.costSource = attempt.costSource || 'quote_reserved_until_receipt';
    if ((shot.status === 'failed' || shot.status === 'cancelled') && ((task.production && task.production.reservationReleased === true) || task.providerSubmitted === false)) attempt.released = true;
    await persistProductionRun(run);
  }
  async function storeProductionShotResult(run, shot) {
    if (shot.resultAssetId) return;
    var response = await sendRuntimeMessage(MESSAGE.RESULT, payloadForTask(shot.taskId), RUNTIME_TIMEOUT_MS.result);
    var payload = responsePayload(response), task = extractTask(payload);
    if (task) await updateProductionTask(run, shot, task);
    if (shot.status !== 'succeeded') throw makeStudioError('PRODUCTION_RESULT_NOT_COMPLETE', '镜头尚未确认完成，继续保留原任务核对。');
    var urls = resultUrlsOf(payload); if (!urls.length) urls = shot.resultUrls || [];
    var url = urls.map(safeResultUrl).filter(Boolean)[0];
    if (!url) throw makeStudioError('PRODUCTION_RESULT_MISSING', '成功镜头没有可下载结果，保留任务并稍后继续核对。');
    var output = await globalThis.fetch(url, { cache: 'no-store' });
    if (!output.ok) throw makeStudioError('PRODUCTION_RESULT_FETCH', '成功镜头下载失败（HTTP ' + output.status + '），继续计划时仅重新下载。');
    var blob = await output.blob();
    if (!blob.size || !/^video\/|^application\/octet-stream/.test(blob.type)) throw makeStudioError('PRODUCTION_RESULT_INVALID', '结果不是有效视频媒体，保留成功任务等待核对。');
    var asset = await Store.saveAsset(blob, { id: run.id + '_' + shot.id + '_attempt' + shot.attempts.length,
      expectedAccountKey: run.accountKey, kind: 'video', name: '镜头_' + shot.id + '.mp4', mimeType: blob.type, durationSec: 5 });
    shot.resultAssetId = asset.id; shot.status = 'succeeded'; shot.error = '';
    await persistProductionRun(run);
  }
  async function submitProductionShot(run, shot, definition) {
    if (shot.status !== 'pending') return;
    var attemptNumber = shot.attempts.length + 1;
    if (attemptNumber > run.plan.options.maxAttempts) throw makeStudioError('PRODUCTION_ATTEMPTS', '此镜头已达到尝试上限。');
    var reservation = Math.ceil(Number(definition.estimatedYuan) * 110) / 100;
    if (!Number.isFinite(reservation) || reservation < 0) throw makeStudioError('PRODUCTION_PRICE_UNKNOWN', '镜头价格未知，禁止提交。');
    if (productionCommitments(run) + reservation > run.plan.options.budgetYuan + 0.00001) throw makeStudioError('PRODUCTION_BUDGET', productionUsesPlatform(run.plan, run) ? '本次生成已达到预算限制，停止后续镜头；已提交镜头按原报价处理，失败退回，取消不退，成功不调差额。' : '剩余自有 API 估算预算不足，停止后续镜头；已成功或状态未知的镜头预算占用仍保留，费用由对应服务计费。');
    var stableId = run.id + ':' + shot.id + ':' + attemptNumber;
    shot.attempts.push({ requestId: stableId, reservedYuan: reservation, estimatedYuan: Number(definition.estimatedYuan), createdAt: new Date().toISOString() });
    shot.status = 'submitting';
    // Persist the reservation and identity before the first potentially paid network operation.
    await persistProductionRun(run);
    try {
      var response = await sendRuntimeMessage(MESSAGE.START, payloadForRequest(definition.request, { requestId: stableId, idempotencyKey: stableId,
        production: { planId: run.id, shotId: shot.id, budgetYuan: run.plan.options.budgetYuan, maxAttempts: run.plan.options.maxAttempts, attempt: attemptNumber } }), RUNTIME_TIMEOUT_MS.start);
      var task = extractTask(responsePayload(response));
      if (!task || !taskIdOf(task)) throw makeStudioError('PRODUCTION_START_UNKNOWN', '未收到稳定任务编号，保留预算并核对提交状态。');
      await updateProductionTask(run, shot, task);
    } catch (error) {
      var failedTask = error && error.details && error.details.task;
      if (failedTask) await updateProductionTask(run, shot, failedTask);
      else if (error && error.details && error.details.providerSubmitted === false && error.details.definitiveFailure === true) {
        shot.status = 'failed'; shot.attempts.pop();
      } else shot.status = 'unknown';
      shot.error = safeErrorMessage(error); await persistProductionRun(run);
      if (shot.status === 'unknown') throw error;
    }
  }
  async function queryProductionShot(run, shot) {
    var attempt = productionAttempt(shot);
    if (!attempt) return;
    var response = await sendRuntimeMessage(MESSAGE.STATUS, payloadForTask(shot.taskId, { idempotencyKey: attempt.requestId }), RUNTIME_TIMEOUT_MS.status);
    var task = extractTask(responsePayload(response));
    if (!task || !taskIdOf(task)) throw makeStudioError('PRODUCTION_STATUS_UNKNOWN', '提交尚无法核对，预算继续保留，不再次生成。');
    await updateProductionTask(run, shot, task);
  }
  async function retryProductionShot(run, shotId) {
    if (state.productionBusy || state.productionStarting || releasedProductionPlan(run)) return;
    var shot = run.shotRuns.find(function (item) { return item.id === shotId; });
    if (!shot || shot.status !== 'failed' || shot.attempts.length >= run.plan.options.maxAttempts) return;
    state.productionStarting = true; setPending(true, '正在保存镜头重试…');
    try {
      shot.status = 'pending'; shot.taskId = ''; shot.providerTaskId = ''; shot.error = ''; run.status = 'queued'; run.error = '';
      await persistProductionRun(run); return await executeProductionRun(run);
    } finally { state.productionStarting = false; if (!state.productionBusy) setPending(false); }
  }
  async function executeProductionRun(run) {
    if (state.productionBusy || !run || run.purpose !== 'production' || releasedProductionPlan(run)) return;
    state.productionBusy = true; setPending(true, '正在执行镜头计划…');
    var productionController;
    run.error = ''; run.status = 'processing';
    try {
      await persistProductionRun(run);
      for (var i = 0; i < run.plan.shots.length; i += 1) {
        var definition = run.plan.shots[i], shot = run.shotRuns.find(function (item) { return item.id === definition.id; });
        if (definition.kind === 'local') { await productionSourceAsset(run, definition.sourceAssetId); continue; }
        if (shot.status === 'submitting') shot.status = 'unknown'; // A reload never repeats START.
        if (shot.status === 'pending') await submitProductionShot(run, shot, definition);
        if (shot.status === 'unknown') { await queryProductionShot(run, shot); if (shot.status === 'unknown') throw makeStudioError('PRODUCTION_UNKNOWN', '有镜头接收状态未知：预算保留，待核对后再继续。'); }
        while (['processing', 'queued', 'submitting'].indexOf(shot.status) >= 0) {
          await new Promise(function (resolve) { globalThis.setTimeout(resolve, 3200); });
          await queryProductionShot(run, shot);
          if (shot.status === 'unknown') throw makeStudioError('PRODUCTION_UNKNOWN', '有镜头接收状态未知：请核对，禁止重复提交。');
        }
        if (shot.status === 'failed' || shot.status === 'cancelled') throw makeStudioError('PRODUCTION_SHOT_FAILED', '镜头失败，已完成镜头保留；可手动仅重试失败镜头。');
        if (shot.status === 'succeeded') await storeProductionShotResult(run, shot);
      }
      if (run.shotRuns.some(function (shot) { return shot.adoptionStatus === 'rejected'; })) throw makeStudioError('PRODUCTION_NOT_ADOPTED', '有成功镜头被标记不采用，费用仍保留；采用所需镜头后可继续合成。');
      productionController = new AbortController();
      state.productionAbortController = productionController;
      run.phase = 'rendering'; await persistProductionRun(run);
      var rendered = await Production.renderTimeline(run.plan, Object.assign({
        signal: productionController.signal,
        resolveAsset: function (id, options) { return productionSourceAsset(run, id, options); },
        resolveVideo: async function (definition) { var shot = run.shotRuns.find(function (item) { return item.id === definition.id; }); var asset = await Store.getAsset(shot.resultAssetId); assertProductionAssetAccount(run, asset); if (!asset || !asset.blob) throw makeStudioError('PRODUCTION_SHOT_ASSET', '已完成镜头素材缺失，禁止自动重生。'); return asset; },
        onProgress: function (progress) { run.progress = Math.round(Number(progress && progress.progress != null ? progress.progress : progress) * 100); if (dom.productionRunNotice) setNotice(dom.productionRunNotice, '正在本地合成，请保持页面打开。', 'success'); }
      }, productionAudioRenderOptions(run)));
      if (productionController.signal.aborted) throw makeStudioError('PRODUCTION_RENDER_ABORTED', '本地合成已停止，已生成镜头和费用记录保留。');
      if (run.plan.finalAudio && run.plan.finalAudio.tracks.length && !rendered.audioMix) throw makeStudioError('PRODUCTION_AUDIO_MIX_RECEIPT', '最终音轨尚未确认混入成片，请刷新声音模块后继续本地合成；已生成画面不会重生。');
      assertProductionAccount(run);
      run.phase = 'saving'; await persistProductionRun(run);
      var asset = await Store.saveAsset(rendered.blob, { id: run.id + '_final', expectedAccountKey: run.accountKey, kind: 'video', name: productionModeLabel(run.plan.options.mode) + '成片.' + (rendered.mimeType.indexOf('webm') >= 0 ? 'webm' : 'mp4'), mimeType: rendered.mimeType, durationSec: rendered.durationSeconds, width: rendered.width, height: rendered.height });
      run.resultAssetId = asset.id; run.status = 'succeeded'; run.phase = 'succeeded'; run.progress = 100; run.finishedAt = new Date().toISOString(); run.error = '';
      if (rendered.audioMix) run.audioMix = rendered.audioMix;
      await persistProductionRun(run); await openResultDialog(run);
    } catch (error) {
      run.error = safeErrorMessage(error);
      run.status = run.shotRuns.some(function (shot) { return shot.status === 'unknown' || shot.status === 'submitting'; }) ? 'unknown' : 'failed';
      if (!run.accountKey || run.accountKey === state.accountKey) {
        try { await persistProductionRun(run); } catch (saveError) { run.error = safeErrorMessage(saveError); }
      }
      showToast(run.error, 'error');
    } finally { state.productionAbortController = null; state.productionBusy = false; setPending(false); renderProductionRun(); }
    return run;
  }
  function productionAudioRenderOptions(run) {
    if (!run.plan.finalAudio) return {};
    return { audioTracks: run.plan.finalAudio.tracks, sourceAudioVolume: run.plan.finalAudio.sourceAudioVolume,
      resolveAudio: function (track, options) { return productionSourceAsset(run, track.assetId || track.id, options); } };
  }

  async function startGeneration() {
    if (usingProductionPlan()) return startProductionGeneration();
    if (state.actionPending || state.assetPreparing) return;
    var errors = validationErrors({ requireReview: state.mode !== 'direct' });
    if (errors.length) {
      setNotice(state.mode === 'direct' ? dom.composerValidation : dom.reviewValidation, errors.join(' '), 'error');
      showToast(errors[0], 'error');
      return;
    }
    if (!await prepareVideoAssets({ pollUntilReady: true })) return;

    var request;
    try {
      request = buildRequest('submit');
    } catch (error) {
      setNotice(state.mode === 'direct' ? dom.composerValidation : dom.reviewValidation, safeErrorMessage(error), 'error');
      return;
    }

    setPending(true, '正在提交…');
    setNotice(dom.composerValidation, '', '');
    setNotice(dom.reviewValidation, '', '');
    renderTransientJob({
      status: 'submitting',
      phase: '正在提交真实任务',
      message: '等待后台确认接收；页面不会模拟成功。',
      progress: 0,
      id: ''
    });
    dom.jobPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    try {
      var response = await sendRuntimeMessage(MESSAGE.START, payloadForRequest(request), RUNTIME_TIMEOUT_MS.start);
      var payload = responsePayload(response);
      var task = extractTask(payload);
      if (!task || !taskIdOf(task)) {
        throw makeStudioError('START_TASK_MISSING', '后台已响应，但未返回可追踪的 taskId；本次不记为成功。');
      }
      var run = await upsertRunFromTask(task, 'generation', request, { acceptedDefault: true });
      state.activeRun = run;
      renderJob(run);
      if (isActiveStatus(run.status)) {
        scheduleStatusPoll();
        showToast('真实任务已接收，正在查询后台状态。', 'success');
      } else if (run.status === 'succeeded') {
        await fetchResult(run, false);
      } else if (run.status === 'failed') {
        showToast('任务提交后返回失败：' + (run.error || run.message || '未知错误'), 'error');
      }
    } catch (error) {
      var failedTask = error && error.details && error.details.task;
      if (failedTask && taskIdOf(failedTask)) {
        var failedRun = await upsertRunFromTask(failedTask, 'generation', request, { acceptedDefault: true });
        renderJob(failedRun);
      } else {
        dom.jobPanel.hidden = true;
      }
      var failurePrefix = submissionStateUncertain(error) ? '任务提交状态未确认：' : '任务未启动：';
      setNotice(state.mode === 'direct' ? dom.composerValidation : dom.reviewValidation,
        failurePrefix + safeErrorMessage(error), 'error');
      showToast(failurePrefix + safeErrorMessage(error), 'error');
    } finally {
      setPending(false);
      renderReview();
    }
  }

  function canonicalStatus(value) {
    var key = cleanText(value).toLowerCase().replace(/[\s-]+/g, '_');
    var aliases = {
      pending: 'queued', waiting: 'queued', accepted: 'queued',
      submit: 'submitting', submitted: 'submitting',
      running: 'processing', generating: 'processing', in_progress: 'processing',
      completed: 'succeeded', complete: 'succeeded', success: 'succeeded', done: 'succeeded',
      error: 'failed', failure: 'failed',
      canceled: 'cancelled', cancel: 'cancelled',
      script_ready: 'needs_confirmation', storyboard_ready: 'needs_confirmation'
    };
    key = aliases[key] || key;
    return Contract.TASK_STATES.indexOf(key) >= 0 ? key : '';
  }

  function taskIdOf(task) {
    return cleanText(task && (task.taskId || task.jobId || task.id));
  }

  function isActiveStatus(status) {
    return ACTIVE_STATES.indexOf(status) >= 0;
  }

  function submissionStateUncertain(source) {
    if (source && source.status === 'unknown') return true;
    var code = cleanText(source && (source.errorCode || source.code ||
      (source.error && source.error.code)));
    return code === 'RUNTIME_TIMEOUT' || code === 'PROVIDER_CREATE_TIMEOUT' ||
      !!(source && source.details && source.details.stateUncertain === true);
  }

  function resultUrlsOf(source) {
    source = source || {};
    var raw = source.resultUrls || source.urls || source.outputUrls ||
      (source.result && (source.result.urls || source.result.resultUrls)) ||
      (source.output && (source.output.urls || source.output.resultUrls)) || [];
    if (typeof raw === 'string') raw = [raw];
    if (!Array.isArray(raw)) return [];
    return raw.map(cleanText).filter(Boolean).slice(0, 20);
  }

  async function upsertRunFromTask(task, purpose, request, options) {
    options = options || {};
    var id = taskIdOf(task);
    if (!id) throw makeStudioError('TASK_ID_MISSING', '后台任务缺少 taskId。');
    var existing = state.history.find(function find(run) { return run.id === id; });
    var rawStatus = canonicalStatus(task.status || task.state);
    var status = rawStatus || (options.acceptedDefault ? 'queued' : (existing && existing.status) || 'queued');
    var progressValue = Number(task.progress == null ? task.progressPercent : task.progress);
    var progress = Number.isFinite(progressValue) ? clamp(progressValue, 0, 100) : (existing && existing.progress);
    if (!Number.isFinite(progress)) progress = 0;
    var now = new Date().toISOString();
    var run = Object.assign({}, existing || {}, {
      id: id,
      taskId: id,
      accountKey: cleanText(task.accountKey) || (existing && existing.accountKey) || state.accountKey,
      purpose: purpose || (existing && existing.purpose) || 'generation',
      mode: Contract.normalizeMode(task.mode) || (existing && existing.mode) || state.mode,
      status: status,
      phase: cleanText(task.phase) || (existing && existing.phase) || '',
      progress: progress,
      message: cleanText(task.message) || (existing && existing.message) || '',
      errorCode: cleanText(task.errorCode || (task.error && task.error.code)) || '',
      error: cleanText(task.error && task.error.message) || cleanText(typeof task.error === 'string' ? task.error : '') || '',
      resultUrls: resultUrlsOf(task).length ? resultUrlsOf(task) : ((existing && existing.resultUrls) || []),
      providerTaskId: cleanText(task.providerTaskId) || (existing && existing.providerTaskId) || '',
      providerModel: cleanText(task.providerModel) || (existing && existing.providerModel) || '',
      provider: cleanText(task.provider) || (existing && existing.provider) || '',
      adapter: cleanText(task.adapter) || (existing && existing.adapter) || '',
      nativePlatform: task.provider === 'shaozhuang-native' || task.adapter === 'sanjie-native' || !!(existing && existing.nativePlatform),
      productKey: Contract.normalizeModelKey(task.productKey) ||
        (request && request.productKey) || (existing && existing.productKey) || state.settings.productKey,
      resolution: (request && request.resolution) || (existing && existing.resolution) || state.settings.resolution,
      ratio: (request && request.ratio) || (existing && existing.ratio) || state.settings.ratio,
      durationSeconds: (request && request.durationSeconds) || (existing && existing.durationSeconds) || state.settings.durationSeconds,
      audioMode: (request && request.audioMode) || (existing && existing.audioMode) || state.settings.audioMode,
      creativeRoute: (request && request.creativeRoute) || (existing && existing.creativeRoute) || state.settings.creativeRoute,
      styleProfile: (request && request.styleProfile) || (existing && existing.styleProfile) || state.settings.styleProfile,
      prompt: (request && (request.goal || request.script)) || (existing && existing.prompt) || state.prompt,
      request: request || (existing && existing.request) || null,
      createdAt: task.createdAt ? normalizeTimestamp(task.createdAt) : ((existing && existing.createdAt) || now),
      updatedAt: task.updatedAt ? normalizeTimestamp(task.updatedAt) : now,
      finishedAt: task.finishedAt ? normalizeTimestamp(task.finishedAt) : ((existing && existing.finishedAt) || ''),
      cancelPending: task.cancelPending === true
    });

    if (TERMINAL_STATES.indexOf(status) >= 0 && !run.finishedAt) run.finishedAt = now;
    var index = state.history.findIndex(function findIndex(item) { return item.id === id; });
    if (index >= 0) state.history[index] = run; else state.history.unshift(run);
    state.history.sort(function newest(a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
    await Store.saveRun(run);
    renderHistory();

    if (isActiveStatus(status)) state.activeRun = run;
    if (state.activeRun && state.activeRun.id === id) {
      state.activeRun = run;
      renderJob(run);
    }

    if (run.purpose === 'analysis' && (status === 'needs_confirmation' || status === 'succeeded')) {
      var analysis = extractAnalysis({ task: task }, task);
      if (analysis.script || analysis.storyboard.length) applyAnalysis(analysis);
    }
    return run;
  }

  function normalizeTimestamp(value) {
    if (typeof value === 'number') return new Date(value).toISOString();
    var date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }

  function renderTransientJob(run) {
    state.activeRun = null;
    dom.jobPanel.hidden = false;
    dom.jobPanel.className = 'panel job-panel';
    dom.jobStage.textContent = run.phase || STATUS_LABELS[run.status] || '正在处理';
    dom.jobTitle.textContent = run.status === 'analyzing' ? '脚本与分镜分析中' : '视频任务处理中';
    dom.jobMessage.textContent = run.message || '等待后台返回真实状态…';
    dom.jobStatusChip.textContent = STATUS_LABELS[run.status] || '等待中';
    dom.jobStatusChip.className = 'state-chip is-active';
    setProgress(run.progress);
    dom.jobId.textContent = '任务 ID：' + (run.id || '等待后台确认');
    dom.jobUpdated.textContent = '尚未收到状态';
    dom.cancelJob.hidden = true;
    dom.retryJob.hidden = true;
    dom.viewResult.hidden = true;
  }

  function renderJob(run) {
    if (!run) {
      dom.jobPanel.hidden = true;
      return;
    }
    dom.jobPanel.hidden = false;
    var terminal = TERMINAL_STATES.indexOf(run.status) >= 0;
    dom.jobPanel.className = 'panel job-panel' + (terminal ? ' is-terminal' : '') +
      (run.status === 'failed' ? ' is-failed' : '');
    dom.jobStage.textContent = run.phase || STATUS_LABELS[run.status] || '状态未知';
    dom.jobTitle.textContent = run.purpose === 'analysis'
      ? (run.status === 'needs_confirmation' ? '脚本分析完成' : '脚本与分镜分析中')
      : (run.status === 'succeeded' ? '视频生成完成' : (submissionStateUncertain(run)
        ? '视频提交状态未确认'
        : (run.status === 'failed' ? '视频任务失败' : '视频任务处理中')));
    dom.jobMessage.textContent = run.error || run.message || defaultStatusMessage(run.status);
    dom.jobStatusChip.textContent = STATUS_LABELS[run.status] || run.status || '未知';
    dom.jobStatusChip.className = 'state-chip' +
      (run.status === 'succeeded' ? ' is-success' : (run.status === 'failed' ? ' is-error' : ' is-active'));
    setProgress(run.progress);
    dom.jobId.textContent = '任务 ID：' + run.id;
    dom.jobUpdated.textContent = '更新于 ' + formatDate(run.updatedAt);
    var cancelStates = state.capabilities && Array.isArray(state.capabilities.cancelStates)
      ? state.capabilities.cancelStates
      : ['queued'];
    dom.cancelJob.hidden = cancelStates.indexOf(run.status) < 0;
    dom.cancelJob.disabled = run.cancelPending === true || state.actionPending;
    dom.cancelJob.textContent = run.cancelPending ? '正在取消…' : '取消任务';
    dom.retryJob.hidden = submissionStateUncertain(run) || (run.status !== 'failed' && run.status !== 'cancelled');
    dom.retryJob.disabled = state.actionPending;
    dom.viewResult.hidden = run.status !== 'succeeded' || run.purpose !== 'generation';
    dom.viewResult.disabled = state.actionPending;
  }

  function defaultStatusMessage(status) {
    return {
      analyzing: '后台正在分析素材与创作目标。',
      queued: '任务已接收，正在等待处理。',
      submitting: '后台正在向模型供应商提交任务。',
      processing: '供应商正在生成视频，请保持页面打开或稍后从历史记录查询。',
      succeeded: '后台确认任务已完成。',
      failed: '后台返回任务失败，可查看错误后重试。',
      cancelled: '后台确认任务已取消。',
      needs_confirmation: '脚本已返回，等待人工确认。'
    }[status] || '等待后台状态。';
  }

  function setProgress(value) {
    var progress = clamp(Number(value || 0), 0, 100);
    dom.jobProgress.style.width = progress + '%';
    var track = dom.jobProgress.parentElement;
    track.setAttribute('aria-valuenow', String(Math.round(progress)));
  }

  function scheduleStatusPoll(delay) {
    if (state.pollTimer) globalThis.clearTimeout(state.pollTimer);
    if (!state.activeRun || !isActiveStatus(state.activeRun.status)) return;
    state.pollTimer = globalThis.setTimeout(pollActiveRun, Number(delay || 3200));
  }

  async function pollActiveRun() {
    state.pollTimer = null;
    var run = state.activeRun;
    if (!run || !isActiveStatus(run.status)) return;
    try {
      var response = await sendRuntimeMessage(MESSAGE.STATUS, payloadForTask(run.id), RUNTIME_TIMEOUT_MS.status);
      var payload = responsePayload(response);
      var task = extractTask(payload);
      if (!task || !taskIdOf(task)) throw makeStudioError('STATUS_TASK_MISSING', '状态响应缺少 task。');
      state.pollFailures = 0;
      var updated = await upsertRunFromTask(task, run.purpose, run.request);
      if (isActiveStatus(updated.status)) {
        scheduleStatusPoll(3200);
      } else if (updated.status === 'succeeded' && updated.purpose === 'generation') {
        await fetchResult(updated, false);
      }
    } catch (error) {
      state.pollFailures += 1;
      if (state.activeRun && state.activeRun.id === run.id) {
        state.activeRun.message = '暂时无法查询状态：' + safeErrorMessage(error) + '。后台任务状态未被改写。';
        state.activeRun.updatedAt = new Date().toISOString();
        renderJob(state.activeRun);
        Store.saveRun(state.activeRun).catch(function ignore() {});
      }
      scheduleStatusPoll(Math.min(30000, 4000 * state.pollFailures));
    }
  }

  async function cancelRun(run) {
    if (!run || !isActiveStatus(run.status) || state.actionPending) return;
    setPending(true);
    try {
      var response = await sendRuntimeMessage(MESSAGE.CANCEL, payloadForTask(run.id), RUNTIME_TIMEOUT_MS.cancel);
      var payload = responsePayload(response);
      var task = extractTask(payload);
      if (task && taskIdOf(task)) {
        var updated = await upsertRunFromTask(task, run.purpose, run.request);
        if (isActiveStatus(updated.status)) {
          updated.cancelPending = true;
          await Store.saveRun(updated);
          state.activeRun = updated;
          renderJob(updated);
          scheduleStatusPoll(1500);
        }
      } else {
        run.cancelPending = true;
        run.message = '后台已接收取消请求，等待真实状态确认。';
        run.updatedAt = new Date().toISOString();
        await Store.saveRun(run);
        state.activeRun = run;
        renderJob(run);
        scheduleStatusPoll(1500);
      }
    } catch (error) {
      showToast('取消请求失败：' + safeErrorMessage(error), 'error');
    } finally {
      setPending(false);
    }
  }

  async function retryRun(run) {
    if (!run || (run.status !== 'failed' && run.status !== 'cancelled') || state.actionPending) return;
    setPending(true);
    try {
      var response = await sendRuntimeMessage(MESSAGE.RETRY, payloadForTask(run.id, {
        requestId: makeId('retry')
      }), RUNTIME_TIMEOUT_MS.retry);
      var payload = responsePayload(response);
      var task = extractTask(payload);
      if (!task || !taskIdOf(task)) {
        throw makeStudioError('RETRY_TASK_MISSING', '后台未返回可追踪的重试任务。');
      }
      var updated = await upsertRunFromTask(task, run.purpose, run.request, { acceptedDefault: true });
      state.activeRun = updated;
      renderJob(updated);
      if (isActiveStatus(updated.status)) scheduleStatusPoll(1800);
      showToast('后台已接收重试请求。', 'success');
    } catch (error) {
      showToast('重试失败：' + safeErrorMessage(error), 'error');
    } finally {
      setPending(false);
    }
  }

  async function fetchResult(run, openDialog) {
    if (run && run.purpose === 'production') { if (openDialog) await openResultDialog(run); return run; }
    if (!run || run.status !== 'succeeded') return;
    setPending(true);
    try {
      var response = await sendRuntimeMessage(MESSAGE.RESULT, payloadForTask(run.id), RUNTIME_TIMEOUT_MS.result);
      var payload = responsePayload(response);
      var task = extractTask(payload);
      var urls = resultUrlsOf(payload);
      if (task && resultUrlsOf(task).length) urls = resultUrlsOf(task);
      if (task && taskIdOf(task)) run = await upsertRunFromTask(task, run.purpose, run.request);
      if (urls.length) {
        run.resultUrls = urls;
        run.updatedAt = new Date().toISOString();
        await Store.saveRun(run);
        var historyIndex = state.history.findIndex(function same(item) { return item.id === run.id; });
        if (historyIndex >= 0) state.history[historyIndex] = run;
        if (state.activeRun && state.activeRun.id === run.id) state.activeRun = run;
        renderHistory();
      }
      if (openDialog) openResultDialog(run);
    } catch (error) {
      if (openDialog) showToast('读取结果失败：' + safeErrorMessage(error), 'error');
      if (openDialog && run.resultUrls && run.resultUrls.length) openResultDialog(run);
    } finally {
      setPending(false);
    }
  }

  async function restoreHistory() {
    if (!state.accountKey) {
      state.history = [];
      state.activeRun = null;
      renderHistory();
      return;
    }
    try {
      state.history = (await Store.listRuns({ limit: 100 })).map(normalizeStoredRun).filter(function currentAccount(run) {
        return !!run && cleanText(run.accountKey) === state.accountKey;
      });
    } catch (error) {
      state.history = [];
      showToast('读取本地生成历史失败：' + safeErrorMessage(error), 'error');
    }
    renderHistory();
    state.productionRun = state.history.find(function (run) { return run.purpose === 'production' && run.status !== 'succeeded' &&
      !releasedProductionPlan(run); }) || null;
    renderProductionRun();
    var active = state.history.find(function findActive(run) { return run.purpose !== 'production' && isActiveStatus(run.status); });
    if (active) {
      state.activeRun = active;
      renderJob(active);
      scheduleStatusPoll(800);
    }
  }

  function normalizeStoredRun(raw) {
    if (!raw || !raw.id) return null;
    var run = Object.assign({}, raw);
    run.id = String(raw.id);
    run.taskId = cleanText(raw.taskId || raw.id);
    run.accountKey = cleanText(raw.accountKey);
    run.mode = Contract.normalizeMode(raw.mode) || 'direct';
    run.status = raw.purpose === 'production' ? (raw.status || 'queued') : raw.status === 'unknown' ? 'unknown' : canonicalStatus(raw.status) || 'failed';
    run.purpose = raw.purpose === 'production' ? 'production' : raw.purpose === 'analysis' ? 'analysis' : 'generation';
    run.progress = clamp(Number(raw.progress || 0), 0, 100);
    run.resultUrls = resultUrlsOf(raw);
    return run;
  }

  function historyMatchesFilter(run, filter) {
    if (filter === 'all') return true;
    if (filter === 'active') return isActiveStatus(run.status) || submissionStateUncertain(run) || run.stateUncertain === true || run.cancelPending ||
      (run.purpose === 'production' && !canHideHistoryRun(run));
    return run.status === filter;
  }

  function canHideHistoryRun(run) {
    if (!cleanText(state.accountKey) || cleanText(run && run.accountKey) !== cleanText(state.accountKey)) return false;
    if (!run || TERMINAL_STATES.indexOf(run.status) < 0 || submissionStateUncertain(run) || run.stateUncertain === true || run.cancelPending) return false;
    // Unfinished plans retain their recovery entry, including failed/unknown shot receipts.
    if (run.purpose === 'production' && (run.status !== 'succeeded' || (run.shotRuns || []).concat(run.narrationRuns || []).some(function unresolved(shot) {
      return ['submitting', 'processing', 'unknown'].indexOf(shot.status) >= 0 || submissionStateUncertain(shot) || shot.stateUncertain === true;
    }))) return false;
    return true;
  }

  function syncHistoryViewAccount() {
    var accountKey = cleanText(state.accountKey);
    if (state.historyViewAccountKey === accountKey) return;
    state.historyViewAccountKey = accountKey;
    state.hiddenHistoryIds = new Set();
    state.showHiddenHistory = false;
    state.historyVisibleLimit = HISTORY_PAGE_SIZE;
    state.historyRenderSignature = '';
    if (!accountKey) return;
    try {
      var saved = JSON.parse(globalThis.localStorage.getItem(HISTORY_VIEW_STORAGE_PREFIX + encodeURIComponent(accountKey)) || '[]');
      if (Array.isArray(saved)) saved.slice(-1000).forEach(function remember(id) {
        if (typeof id === 'string' && id) state.hiddenHistoryIds.add(id);
      });
    } catch (_) { /* Cleanup remains available for this page when local storage is unavailable. */ }
  }

  function persistHistoryView() {
    if (!state.accountKey) return;
    try {
      globalThis.localStorage.setItem(HISTORY_VIEW_STORAGE_PREFIX + encodeURIComponent(state.accountKey), JSON.stringify(Array.from(state.hiddenHistoryIds).slice(-1000)));
    } catch (_) { /* Run receipts and media are never changed by view cleanup. */ }
  }

  function clearEndedHistory() {
    syncHistoryViewAccount();
    var count = 0;
    state.history.forEach(function hideEnded(run) {
      if (!canHideHistoryRun(run) || state.hiddenHistoryIds.has(run.id)) return;
      state.hiddenHistoryIds.add(run.id);
      count += 1;
    });
    state.showHiddenHistory = false;
    state.historyVisibleLimit = HISTORY_PAGE_SIZE;
    persistHistoryView();
    renderHistory();
    showToast(count ? '已从列表清理 ' + count + ' 个已结束任务，结果与记录保留，可随时恢复。' : '当前没有可清理的已结束任务。', count ? 'success' : '');
  }

  function setHistoryRunHidden(run, hidden) {
    syncHistoryViewAccount();
    if (!canHideHistoryRun(run)) return;
    if (hidden) state.hiddenHistoryIds.add(run.id); else state.hiddenHistoryIds.delete(run.id);
    persistHistoryView();
    renderHistory();
  }

  function loadMoreHistory() {
    state.historyVisibleLimit += HISTORY_PAGE_SIZE;
    renderHistory();
  }

  function toggleHiddenHistory() {
    state.showHiddenHistory = !state.showHiddenHistory;
    state.historyVisibleLimit = HISTORY_PAGE_SIZE;
    renderHistory();
  }

  function renderHistory() {
    syncHistoryViewAccount();
    var filter = dom.historyFilter ? dom.historyFilter.value : 'all';
    var hiddenCount = state.history.filter(function isHidden(run) {
      return canHideHistoryRun(run) && state.hiddenHistoryIds.has(run.id);
    }).length;
    var cleanableCount = state.history.filter(function canClean(run) {
      return canHideHistoryRun(run) && !state.hiddenHistoryIds.has(run.id);
    }).length;
    var rows = state.history.filter(function filterRun(run) {
      return historyMatchesFilter(run, filter) && (state.showHiddenHistory || !canHideHistoryRun(run) || !state.hiddenHistoryIds.has(run.id));
    });
    // Keep work that needs attention ahead of ended rows, even after a bulk cleanup.
    rows = rows.filter(function protectedRun(run) { return !canHideHistoryRun(run); }).concat(rows.filter(canHideHistoryRun));
    var visible = rows.slice(0, state.historyVisibleLimit);
    dom.historyEmpty.hidden = rows.length > 0;
    var emptyTitle = dom.historyEmpty.querySelector('strong');
    var emptyNote = dom.historyEmpty.querySelector('p');
    if (emptyTitle) emptyTitle.textContent = hiddenCount && !state.showHiddenHistory ? '当前列表已清理' : state.history.length ? '没有符合筛选的任务' : '还没有生成任务';
    if (emptyNote) emptyNote.textContent = hiddenCount && !state.showHiddenHistory ? '点击“显示已清理”可查看结果并恢复到列表。' : state.history.length ? '可切换筛选查看其他任务。' : '完成第一次真实提交后，任务会出现在这里。';
    if (dom.historySummary) dom.historySummary.textContent = '已显示 ' + visible.length + ' / ' + rows.length + ' 个任务' + (hiddenCount ? ' · 已清理 ' + hiddenCount + ' 个' : '') + '；清理仅收起列表，生成结果与费用记录保留。';
    if (dom.clearEndedHistory) dom.clearEndedHistory.disabled = cleanableCount === 0;
    if (dom.toggleHiddenHistory) {
      dom.toggleHiddenHistory.hidden = hiddenCount === 0;
      dom.toggleHiddenHistory.textContent = (state.showHiddenHistory ? '收起已清理' : '显示已清理') + '（' + hiddenCount + '）';
      dom.toggleHiddenHistory.setAttribute('aria-pressed', String(state.showHiddenHistory));
    }
    if (dom.loadMoreHistory) {
      dom.loadMoreHistory.hidden = visible.length >= rows.length;
      dom.loadMoreHistory.textContent = '再显示 ' + Math.min(HISTORY_PAGE_SIZE, rows.length - visible.length) + ' 个任务';
    }
    // Polls often return the same receipt; avoid recreating unchanged rows and their actions.
    var signature = JSON.stringify(visible.map(function displayFields(run) {
      return [run.id, run.purpose, run.prompt, run.mode, run.creativeRoute, run.productKey, run.resolution, run.ratio,
        run.status, run.newPlanRequestedAt, isActiveStatus(run.status) && Number.isFinite(Number(run.progress)) ? Math.round(run.progress) : formatDate(run.updatedAt), formatDate(run.createdAt), run.durationSeconds, canHideHistoryRun(run),
        state.hiddenHistoryIds.has(run.id), submissionStateUncertain(run), run.purpose === 'production' ? [run.plan && run.plan.aiSeconds, run.plan && run.plan.options && run.plan.options.mode] : '',
        globalThis.SZCreativeCredits && run.purpose === 'production' && run.status !== 'succeeded' ? productionRunCreditSpec(run) : null,
        globalThis.SZCreativeCredits && run.purpose !== 'production' && (run.status === 'failed' || run.status === 'cancelled') ? retryCreditSpec(run) : null];
    }));
    if (state.historyRenderSignature === signature) return;
    state.historyRenderSignature = signature;
    dom.historyList.replaceChildren();
    visible.forEach(function rowFor(run) {
      var row = createHistoryRow(run);
      dom.historyList.appendChild(row);
      if (globalThis.SZCreativeCredits) row.querySelectorAll('[data-history-action]').forEach(function (button) {
        if (button.dataset.historyAction === 'retry') globalThis.SZCreativeCredits.annotate(button, retryCreditSpec(run));
        else if (run.purpose === 'production' && button.dataset.historyAction === 'status') globalThis.SZCreativeCredits.annotate(button, productionRunCreditSpec(run));
      });
    });
  }

  function createHistoryRow(run) {
    var row = document.createElement('article');
    row.className = 'history-row';
    row.dataset.runId = run.id;

    var main = document.createElement('div');
    main.className = 'history-main';
    var title = document.createElement('strong');
    var route = routeDefinition(run.creativeRoute);
    title.textContent = (run.purpose === 'production' ? productionModeLabel(run.plan && run.plan.options.mode) + '成片 · ' : run.purpose === 'analysis' ? '脚本分析 · ' : '') +
      (route && route.label ? route.label : ((Contract.MODES[run.mode] && Contract.MODES[run.mode].label) || run.mode)) + ' · ' +
      (cleanText(run.prompt).slice(0, 36) || '未命名任务');
    title.title = cleanText(run.prompt) || run.id;
    var id = document.createElement('small');
    id.textContent = run.id;
    main.append(title, id);

    var modelCell = historyCell(
      run.purpose === 'production' ? (run.plan.aiSeconds === 0 ? '本地素材合成' : run.plan.options.mode === 'balanced' ? 'Mini + 标准模型' : run.plan.options.mode === 'economic' ? '素材 + Mini' : Contract.MODEL_DISPLAY_NAMES[run.productKey] || run.productKey) : Contract.MODEL_DISPLAY_NAMES[run.productKey] || run.productKey || '—',
      (run.resolution || '—') + ' · ' + (run.ratio || '—')
    );
    var modeCell = historyCell(
      STATUS_LABELS[run.status] || run.status,
      Number.isFinite(Number(run.progress)) && isActiveStatus(run.status) ? Math.round(run.progress) + '%' : formatDate(run.updatedAt)
    );
    if (run.status === 'succeeded') modeCell.classList.add('is-success');
    if (run.status === 'failed') modeCell.classList.add('is-error');
    var timeCell = historyCell(formatDate(run.createdAt), run.durationSeconds ? run.durationSeconds + ' 秒' : '');

    var actions = document.createElement('div');
    actions.className = 'history-actions';
    if (run.purpose === 'production' && run.status !== 'succeeded') actions.appendChild(historyButton(releasedProductionPlan(run) ? '查看原计划' : '继续计划', 'status', run.id));
    else if (isActiveStatus(run.status) || submissionStateUncertain(run) || run.stateUncertain === true) actions.appendChild(historyButton('查询', 'status', run.id));
    if (run.purpose !== 'production' && !submissionStateUncertain(run) && (run.status === 'failed' || run.status === 'cancelled')) {
      actions.appendChild(historyButton('重试', 'retry', run.id));
    }
    if (run.status === 'succeeded' && (run.purpose === 'generation' || run.purpose === 'production')) actions.appendChild(historyButton('结果', 'result', run.id));
    if (canHideHistoryRun(run)) actions.appendChild(historyButton(state.hiddenHistoryIds.has(run.id) ? '恢复到列表' : '移出列表', state.hiddenHistoryIds.has(run.id) ? 'restore' : 'hide', run.id));
    row.append(main, modelCell, modeCell, timeCell, actions);
    return row;
  }

  function historyCell(primary, secondary) {
    var cell = document.createElement('div');
    cell.className = 'history-cell';
    var text = document.createElement('div');
    text.textContent = primary || '—';
    cell.appendChild(text);
    if (secondary) {
      var small = document.createElement('small');
      small.textContent = secondary;
      cell.appendChild(small);
    }
    return cell;
  }

  function historyButton(label, action, id) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-action';
    button.dataset.historyAction = action;
    button.dataset.runId = id;
    button.textContent = label;
    return button;
  }

  async function refreshRunStatus(run, notify) {
    if (run && run.purpose === 'production') {
      if (state.productionBusy || state.productionStarting) return run;
      state.productionRun = run; renderProductionRun(); return releasedProductionPlan(run) ? run : executeProductionRun(run);
    }
    try {
      var response = await sendRuntimeMessage(MESSAGE.STATUS, payloadForTask(run.id), RUNTIME_TIMEOUT_MS.status);
      var payload = responsePayload(response);
      var task = extractTask(payload);
      if (!task || !taskIdOf(task)) throw makeStudioError('STATUS_TASK_MISSING', '状态响应缺少 task。');
      var updated = await upsertRunFromTask(task, run.purpose, run.request);
      if (updated.status === 'succeeded' && updated.purpose === 'generation') await fetchResult(updated, false);
      if (notify) showToast('任务状态已刷新。', 'success');
      return updated;
    } catch (error) {
      if (notify) showToast('状态查询失败：' + safeErrorMessage(error), 'error');
      throw error;
    }
  }

  async function refreshAllActiveRuns() {
    var active = state.history.filter(function activeOnly(run) { return isActiveStatus(run.status); });
    if (!active.length) {
      showToast('当前没有需要刷新的进行中任务。');
      return;
    }
    dom.refreshHistory.disabled = true;
    var succeeded = 0;
    for (var i = 0; i < active.length; i += 1) {
      try {
        await refreshRunStatus(active[i], false);
        succeeded += 1;
      } catch (_) { /* individual status stays unchanged */ }
    }
    dom.refreshHistory.disabled = false;
    showToast('已刷新 ' + succeeded + ' / ' + active.length + ' 个任务状态。', succeeded ? 'success' : 'error');
  }

  function safeResultUrl(value) {
    if (state.previewUrls.has(String(value))) return String(value);
    try {
      var url = new URL(String(value));
      if (url.protocol === 'https:') return url.href;
      if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return url.href;
    } catch (_) { /* invalid URL */ }
    return '';
  }

  function releaseResultPreview() {
    state.resultPreviewSequence += 1;
    dom.resultMedia.querySelectorAll('video').forEach(function unload(video) {
      video.pause();
      video.removeAttribute('src');
      try { video.load(); } catch (_) { /* Browser media teardown is best effort. */ }
    });
    dom.resultMedia.replaceChildren();
    dom.resultDetails.replaceChildren();
    if (state.resultPreviewUrl) {
      try { URL.revokeObjectURL(state.resultPreviewUrl); } catch (_) { /* noop */ }
      state.previewUrls.delete(state.resultPreviewUrl);
      state.resultPreviewUrl = '';
    }
  }

  async function openResultDialog(run) {
    releaseResultPreview();
    var previewSequence = state.resultPreviewSequence;
    var expiryNote = document.getElementById('result-expiry-note');
    if (expiryNote) expiryNote.textContent = run.resultAssetId ? '成片已保存在当前浏览器的账号素材库，可从历史重新预览与下载；请下载到本机留存。' : '结果地址可能过期；火山方舟当前通常仅保留 24 小时，请立即打开并下载或转存。';
    if (run.resultAssetId) {
      if (run.purpose === 'production') assertProductionAccount(run);
      var savedResult = await Store.getAsset(run.resultAssetId);
      if (previewSequence !== state.resultPreviewSequence) return;
      if (run.purpose === 'production') assertProductionAssetAccount(run, savedResult);
      if (!savedResult || !savedResult.blob) { showToast('本地成片素材不可用，请恢复原浏览器素材库。', 'error'); return; }
      var previewUrl = URL.createObjectURL(savedResult.blob); state.previewUrls.add(previewUrl); state.resultPreviewUrl = previewUrl;
      run = Object.assign({}, run, { resultUrls: [previewUrl] });
    }
    dom.resultMedia.replaceChildren();
    dom.resultDetails.replaceChildren();
    var urls = (run.resultUrls || []).map(safeResultUrl).filter(Boolean);
    if (urls.length) {
      var video = document.createElement('video');
      video.controls = true;
      video.preload = 'metadata';
      video.src = urls[0];
      dom.resultMedia.appendChild(video);
      video.addEventListener('error', function playbackError() {
        if (dom.resultMedia.querySelector('.result-playback-note')) return;
        var note = document.createElement('div');
        note.className = 'result-playback-note';
        note.textContent = '视频任务已完成，但当前浏览器无法直接播放该编码。1080P / 4K 结果可能采用 10-bit H.265；请使用下方新窗口入口下载后，以兼容播放器打开。';
        dom.resultMedia.appendChild(note);
      }, { once: true });
      var link = document.createElement('a');
      link.href = urls[0];
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'button button-secondary';
      link.textContent = '在新窗口打开结果';
      dom.resultDetails.appendChild(link);
      if (run.resultAssetId || (globalThis.SZ_WEB_ACCOUNT && typeof chrome !== 'undefined' && chrome.downloads)) {
        var download = document.createElement('button');
        download.type = 'button';
        download.className = 'button button-secondary';
        download.textContent = '下载视频到本机';
        download.addEventListener('click', function () {
          if (run.resultAssetId) { var localDownload = document.createElement('a'); localDownload.href = urls[0]; localDownload.download = 'video_' + run.id + (savedResult.mimeType.indexOf('webm') >= 0 ? '.webm' : '.mp4'); localDownload.click(); return; }
          download.disabled = true;
          download.textContent = '正在下载…';
          chrome.downloads.download({ url: urls[0], filename: 'video_' + String(run.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '_') + '.mp4' }, function (id) {
            var error = chrome.runtime.lastError;
            download.disabled = false;
            download.textContent = '下载视频到本机';
            if (error || id == null) showToast(error && error.message || '下载未启动，请重试。', 'error');
            else showToast('已启动视频下载。', 'success');
          });
        });
        dom.resultDetails.appendChild(download);
      }
    } else {
      var placeholder = document.createElement('div');
      placeholder.className = 'result-placeholder';
      placeholder.textContent = '后台确认任务完成，但当前未返回可安全预览的 HTTPS 结果地址。工作台不会构造或模拟视频。';
      dom.resultMedia.appendChild(placeholder);
    }
    [
      ['模式', (Contract.MODES[run.mode] && Contract.MODES[run.mode].label) || run.mode],
      ['模型', run.purpose === 'production' && run.plan.aiSeconds === 0 ? '本地素材合成' : run.purpose === 'production' && run.plan.options.mode === 'balanced' ? 'Mini + 标准模型' : Contract.MODEL_DISPLAY_NAMES[run.productKey] || run.productKey],
      ['参数', (run.resolution || '—') + ' · ' + (run.ratio || '—') + ' · ' + (run.durationSeconds || '—') + ' 秒']
    ].concat(run.purpose === 'production' && run.audioMix ? [['最终声音', run.audioMix.tracks.length ? run.audioMix.tracks.map(function (track) { return (track.role === 'narration' ? '完整口播 ' : '背景音乐 ') + formatDuration(track.durationSeconds) + ' · ' + Math.round(track.volume * 100) + '%' + (track.loop ? ' · 循环' : ''); }).join('；') : run.audioMix.outputAudioTracks ? '已有视频原声' : '静音成片']] : []).forEach(function detail(pair) {
      var cell = document.createElement('div');
      cell.className = 'result-detail';
      cell.textContent = pair[0];
      var strong = document.createElement('strong');
      strong.textContent = pair[1] || '—';
      cell.appendChild(strong);
      dom.resultDetails.appendChild(cell);
    });
    if (typeof dom.resultDialog.showModal === 'function') dom.resultDialog.showModal();
    else dom.resultDialog.setAttribute('open', '');
  }

  function bindEvents() {
    bindProductionEvents();
    dom.openApiSettings.addEventListener('click', openVideoApiSettings);
    dom.refreshCapabilities.addEventListener('click', function refresh() {
      refreshCapabilities({ toast: true });
    });
    dom.resetDraft.addEventListener('click', function clearDraft() {
      resetCurrentDraft().catch(function onResetError(error) {
        showToast('清空草稿失败：' + safeErrorMessage(error), 'error');
      });
    });

    dom.modeTabs.addEventListener('click', function modeClick(event) {
      var tab = event.target.closest('[data-mode]');
      if (tab) switchMode(tab.dataset.mode);
    });
    dom.modeTabs.addEventListener('keydown', function modeKeys(event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
      var tabs = Array.from(dom.modeTabs.querySelectorAll('[data-mode]'));
      var current = tabs.indexOf(document.activeElement);
      if (current < 0) current = tabs.findIndex(function currentTab(tab) { return tab.dataset.mode === state.mode; });
      var next = current;
      if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
      if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      event.preventDefault();
      tabs[next].focus();
      switchMode(tabs[next].dataset.mode);
    });

    dom.creativeRouteGrid.addEventListener('click', function routeClick(event) {
      var button = event.target.closest('[data-creative-route]');
      if (button && !button.disabled) selectCreativeRoute(button.dataset.creativeRoute);
    });
    dom.styleProfileGrid.addEventListener('click', function styleClick(event) {
      var button = event.target.closest('[data-style-profile]');
      if (button) selectStyleProfile(button.dataset.styleProfile);
    });

    bindFileInput(dom.imageInput, 'image');
    bindFileInput(dom.videoInput, 'video');
    bindFileInput(dom.audioInput, 'audio');
    dom.referenceVideoInput.addEventListener('change', function referenceChange() {
      setReferenceVideo(dom.referenceVideoInput.files && dom.referenceVideoInput.files[0]);
    });
    bindDropzone(dom.referenceDropzone, function referenceDrop(files) {
      if (files[0]) setReferenceVideo(files[0]);
    });
    document.querySelectorAll('.upload-tile').forEach(function bindTile(tile) {
      var input = tile.querySelector('input[type="file"]');
      if (!input) return;
      var kind = input.id === 'image-input' ? 'image' : (input.id === 'video-input' ? 'video' : 'audio');
      bindDropzone(tile, function assetDrop(files) { addFiles(kind, files); });
    });

    dom.assetList.addEventListener('click', function assetAction(event) {
      var prepareAsset = event.target.closest('[data-prepare-asset]'), portraitStart = event.target.closest('[data-portrait-start]');
      if (prepareAsset || portraitStart) {
        if ((prepareAsset || portraitStart).disabled || state.actionPending || state.assetPreparing) return;
        if (portraitStart) { if (portraitStart.dataset.portraitRestart) restartPortraitAuthorization(); else startPortraitAuthorization(); } else prepareVideoAssets();
        return;
      }
      var portrait = event.target.closest('[data-trusted-portrait-asset]'), restorePortrait = event.target.closest('[data-restore-portrait-asset]');
      if (portrait || restorePortrait) {
        var action = portrait || restorePortrait;
        if (action.disabled || state.actionPending) return;
        if (restorePortrait) { associateTrustedPortrait(action.dataset.restorePortraitAsset, null); return; }
        var current = state.assets.image.find(function (asset) { return asset.id === action.dataset.trustedPortraitAsset; });
        var value = globalThis.prompt('粘贴已完成本人认证、授权并入库的火山方舟 Asset ID。这里只关联生成引用，不执行认证或上传；实际可用性由火山方舟校验。', current && current.trustedPortrait ? current.trustedPortrait.uri : '');
        if (value !== null) associateTrustedPortrait(action.dataset.trustedPortraitAsset, value);
        return;
      }
      var button = event.target.closest('[data-remove-asset]');
      if (button) removeAsset(button.dataset.kind, button.dataset.removeAsset);
    });
    dom.assetList.addEventListener('change', function assetRoleChange(event) {
      var material = event.target.closest('[data-asset-material]');
      if (material) { setMaterialKind(material.dataset.assetMaterial, material.value); return; }
      var finalRole = event.target.closest('[data-final-audio-role]'), finalLoop = event.target.closest('[data-final-audio-loop]');
      if (finalRole || finalLoop) {
        var finalAsset = state.assets.audio.find(function (item) { return item.id === (finalRole ? finalRole.dataset.finalAudioRole : finalLoop.dataset.finalAudioLoop); });
        if (!finalAsset || state.actionPending) return;
        if (finalRole) { finalAsset.finalAudioRole = finalRole.value; finalAsset.finalAudioVolume = finalRole.value === 'music' ? 0.25 : 1; finalAsset.finalAudioLoop = finalRole.value === 'music'; }
        else finalAsset.finalAudioLoop = finalLoop.checked;
        renderAssets(); updateEstimate(); renderReadiness(); scheduleDraftSave(); return;
      }
      var select = event.target.closest('[data-asset-role]');
      if (!select) return;
      var list = state.assets[select.dataset.kind] || [];
      var asset = list.find(function sameAsset(item) { return item.id === select.dataset.assetRole; });
      if (!asset || asset.role === select.value) return;
      asset.role = select.value;
      invalidateReviewForSourceChange('素材用途已变化，请重新分析。');
      renderReadiness();
      scheduleDraftSave();
    });
    dom.assetList.addEventListener('input', function finalAudioGainChange(event) {
      var input = event.target.closest('[data-final-audio-gain]');
      if (!input || state.actionPending) return;
      var asset = state.assets.audio.find(function (item) { return item.id === input.dataset.finalAudioGain; });
      if (!asset) return;
      var gain = Number(input.value); if (!Number.isFinite(gain) || gain < 0 || gain > 1) return;
      asset.finalAudioVolume = gain;
      var output = Array.from(dom.assetList.querySelectorAll('[data-final-audio-volume-output]')).find(function (item) { return item.dataset.finalAudioVolumeOutput === asset.id; });
      if (output) output.textContent = Math.round(gain * 100) + '%';
      updateEstimate(); renderReadiness(); scheduleDraftSave();
    });
    dom.referencePreview.addEventListener('click', function referenceAction(event) {
      if (event.target.closest('[data-remove-reference]')) removeReference();
    });

    dom.promptInput.addEventListener('input', function promptInput() {
      state.prompt = cleanText(dom.promptInput.value);
      dom.promptCount.textContent = dom.promptInput.value.length + ' / 2000';
      invalidateReviewForSourceChange('创作要求已变化，请重新分析。');
      setNotice(dom.composerValidation, '', '');
      renderReadiness();
      scheduleDraftSave();
    });
    document.querySelectorAll('[data-prompt-snippet]').forEach(function snippetButton(button) {
      button.addEventListener('click', function appendSnippet() {
        var separator = dom.promptInput.value && !/\s$/.test(dom.promptInput.value) ? '\n' : '';
        var next = (dom.promptInput.value + separator + button.dataset.promptSnippet).slice(0, 2000);
        dom.promptInput.value = next;
        dom.promptInput.dispatchEvent(new Event('input', { bubbles: true }));
        dom.promptInput.focus();
      });
    });

    dom.expertModeEnabled.addEventListener('change', function toggleExpert() {
      state.expertEnabled = dom.expertModeEnabled.checked;
      dom.expertRequirementsWrap.hidden = !state.expertEnabled;
      invalidateReviewForSourceChange('专家模式约束已变化，请重新分析。');
      renderReadiness();
      scheduleDraftSave();
    });
    dom.expertRequirements.addEventListener('input', function expertInput() {
      state.expertRequirements = cleanText(dom.expertRequirements.value);
      dom.expertCount.textContent = dom.expertRequirements.value.length + ' / 8000';
      invalidateReviewForSourceChange('高级约束已变化，请重新分析。');
      renderReadiness();
      scheduleDraftSave();
    });
    dom.rightsConfirmed.addEventListener('change', function rightsChange() {
      confirmRights(dom.rightsConfirmed.checked);
    });

    dom.modelSelect.addEventListener('change', syncSettingsFromDom);
    document.querySelectorAll('input[name="resolution"], input[name="aspect-ratio"], input[name="audio-mode"]')
      .forEach(function settingsRadio(input) { input.addEventListener('change', syncSettingsFromDom); });
    dom.durationInput.addEventListener('input', syncDurationFromDom);
    dom.durationInput.addEventListener('change', syncDurationFromDom);
    dom.durationPresets.addEventListener('click', function durationPresetClick(event) {
      var button = event.target.closest('[data-duration-seconds]');
      if (!button || button.disabled) return;
      var allowed = nativeDurations(getSelectedModel());
      dom.durationInput.value = allowed.length ? String(allowed.indexOf(Number(button.dataset.durationSeconds))) : button.dataset.durationSeconds;
      syncDurationFromDom();
    });
    dom.narrationLanguage.addEventListener('change', syncSettingsFromDom);
    dom.primaryAction.addEventListener('click', handlePrimaryAction);

    dom.scriptEditor.addEventListener('input', syncReviewFromDom);
    dom.storyboardList.addEventListener('input', function storyboardInput(event) {
      var field = event.target.dataset.shotField;
      var index = Number(event.target.dataset.shotIndex);
      if (field && Number.isInteger(index)) updateShot(index, field, event.target.value);
    });
    dom.storyboardList.addEventListener('click', function storyboardAction(event) {
      var button = event.target.closest('[data-remove-shot]');
      if (button) removeShot(Number(button.dataset.removeShot));
    });
    dom.addShot.addEventListener('click', addShot);
    dom.reanalyze.addEventListener('click', analyzeDraft);
    dom.confirmReview.addEventListener('click', confirmReviewAndGenerate);

    dom.cancelJob.addEventListener('click', function cancelCurrent() { cancelRun(state.activeRun); });
    dom.retryJob.addEventListener('click', function retryCurrent() { retryRun(state.activeRun); });
    dom.viewResult.addEventListener('click', function resultCurrent() { fetchResult(state.activeRun, true); });
    dom.historyFilter.addEventListener('change', function changeHistoryFilter() { state.historyVisibleLimit = HISTORY_PAGE_SIZE; renderHistory(); });
    dom.refreshHistory.addEventListener('click', refreshAllActiveRuns);
    if (dom.clearEndedHistory) dom.clearEndedHistory.addEventListener('click', clearEndedHistory);
    if (dom.toggleHiddenHistory) dom.toggleHiddenHistory.addEventListener('click', toggleHiddenHistory);
    if (dom.loadMoreHistory) dom.loadMoreHistory.addEventListener('click', loadMoreHistory);
    dom.resultDialog.addEventListener('close', releaseResultPreview);
    dom.historyList.addEventListener('click', function historyAction(event) {
      var button = event.target.closest('[data-history-action]');
      if (!button) return;
      var run = state.history.find(function find(item) { return item.id === button.dataset.runId; });
      if (!run) return;
      if (button.dataset.historyAction === 'status') refreshRunStatus(run, true);
      if (button.dataset.historyAction === 'retry') retryRun(run);
      if (button.dataset.historyAction === 'result') fetchResult(run, true);
      if (button.dataset.historyAction === 'hide') setHistoryRunHidden(run, true);
      if (button.dataset.historyAction === 'restore') setHistoryRunHidden(run, false);
    });

    document.addEventListener('visibilitychange', function visibilityChanged() {
      if (document.visibilityState === 'hidden') {
        saveCurrentDraft().catch(function ignore() {});
      } else {
        refreshAfterConfigReturn();
      }
    });
    globalThis.addEventListener('focus', refreshAfterConfigReturn);
    globalThis.addEventListener('beforeunload', function cleanup() {
      if (state.productionAbortController) state.productionAbortController.abort();
      if (state.pollTimer) globalThis.clearTimeout(state.pollTimer);
      releaseResultPreview();
      revokeAllPreviews();
    });
    bindRuntimeEvents();
  }

  function bindFileInput(input, kind) {
    input.addEventListener('change', function fileChange() {
      addFiles(kind, input.files).finally(function clearInput() { input.value = ''; });
    });
  }

  function bindDropzone(node, onFiles) {
    ['dragenter', 'dragover'].forEach(function bindOver(name) {
      node.addEventListener(name, function over(event) {
        event.preventDefault();
        if (!node.hidden) node.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function bindLeave(name) {
      node.addEventListener(name, function leave(event) {
        event.preventDefault();
        node.classList.remove('is-dragover');
      });
    });
    node.addEventListener('drop', function dropped(event) {
      if (node.hidden) return;
      var files = Array.from(event.dataTransfer && event.dataTransfer.files || []);
      if (files.length) onFiles(files);
    });
  }

  function bindRuntimeEvents() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return;
    chrome.runtime.onMessage.addListener(function onRuntimeEvent(message) {
      if (!message || [MESSAGE.STATUS, MESSAGE.RESULT].indexOf(message.type) < 0) return;
      var payload = responsePayload(message);
      if (payload.error) return;
      var task = extractTask(payload);
      var id = taskIdOf(task);
      // The website shim dispatches our own commands to every page listener.
      // A taskId-only STATUS/RESULT request is not a pushed task receipt.
      if (!task || !id || !canonicalStatus(task.status || task.state)) return;
      var existing = state.history.find(function find(run) { return run.id === id; });
      if (!existing) return;
      upsertRunFromTask(task, existing.purpose, existing.request).then(function afterPush(run) {
        if (run.status === 'succeeded' && run.purpose === 'generation') fetchResult(run, false);
      }).catch(function ignore() {});
    });
  }

  async function init() {
    cacheDom();
    bindEvents();
    renderMode();
    renderRuntimeStatus('checking', '正在检查生成能力');
    try {
      if (globalThis.SZ_WEB_ACCOUNT) state.accountKey = cleanText(await globalThis.SZ_WEB_ACCOUNT.require());
      await Store.open();
    } catch (error) {
      setNotice(dom.composerValidation, '本地素材库不可用：' + safeErrorMessage(error), 'error');
    }
    await restoreDraft('direct');
    try {
      await claimStartupMediaImport();
    } catch (error) {
      setNotice(dom.composerValidation, '淘宝主图/视频导入失败：' + safeErrorMessage(error), 'error');
    }
    state.booted = true;
    await refreshCapabilities();
    await restoreHistory();
    renderMode();
    renderAssets();
    renderReference();
    renderReview();
    renderReadiness();
  }

  globalThis.SanjieVideoSettingsBridge = Object.freeze({
    ready: function () { return state.booted === true; },
    openConfig: function () {
      if (!state.booted || !dom.openApiSettings || dom.openApiSettings.disabled) {
        return { ok: false, error: '请等待当前任务结束后配置 API。' };
      }
      // Preserve the original dialog, account checks and save/refresh flow.
      openVideoApiSettings();
      return { ok: true };
    }
  });

  if (globalThis.__SZ_VIDEO_STUDIO_EXPOSE_TESTING__ === true) {
    globalThis.SZEcommerceVideoStudioTesting = Object.freeze({
      safeRemoteAssetUrl: safeRemoteAssetUrl,
      localStorageAssetId: localStorageAssetId,
      serializeAsset: serializeAsset,
      hydrateAsset: hydrateAsset,
      normalizeImportedRemoteAsset: normalizeImportedRemoteAsset,
      mergeRemoteAssetLists: mergeRemoteAssetLists,
      renderHistory: renderHistory, clearEndedHistory: clearEndedHistory, loadMoreHistory: loadMoreHistory, toggleHiddenHistory: toggleHiddenHistory,
      setHistoryRunHidden: setHistoryRunHidden, releaseResultPreview: releaseResultPreview, openResultDialog: openResultDialog,
      assetForRequest: assetForRequest,
      normalizeTrustedPortraitUri: normalizeTrustedPortraitUri, associateTrustedPortrait: associateTrustedPortrait, personalArkPortraitAvailable: personalArkPortraitAvailable,
      materialKind: materialKind, setMaterialKind: setMaterialKind, prepareVideoAssets: prepareVideoAssets, startPortraitAuthorization: startPortraitAuthorization,
      restartPortraitAuthorization: restartPortraitAuthorization,
      assetReportingAvailable: assetReportingAvailable, activeLibraryUri: activeLibraryUri, validationErrors: validationErrors, startGeneration: startGeneration,
      buildRequest: buildRequest,
      claimStartupMediaImport: claimStartupMediaImport,
      normalizeSettingsSnapshot: normalizeSettingsSnapshot,
      normalizeModelCatalog: normalizeModelCatalog, refreshCapabilities: refreshCapabilities, updateEstimate: updateEstimate, submissionQuote: submissionQuote,
      normalizeProductionOptions: normalizeProductionOptions, productionValidationErrors: productionValidationErrors,
      startProductionGeneration: startProductionGeneration, executeProductionRun: executeProductionRun,
      canStartNewProductionPlan: canStartNewProductionPlan, startNewProductionPlan: startNewProductionPlan, restoreHistory: restoreHistory,
      productionCommitments: productionCommitments, productionCostSummary: productionCostSummary, retryProductionShot: retryProductionShot,
      snapshotProductionAudio: snapshotProductionAudio, productionAudioRenderOptions: productionAudioRenderOptions,
      localUploadSupported: localUploadSupported, maxForKind: maxForKind, validateAssetMetadata: validateAssetMetadata,
      productionTemplate: productionTemplate, state: state, renderProductionRun: renderProductionRun,
      productionSourceAsset: productionSourceAsset,
      cacheDom: cacheDom, bindProductionEvents: bindProductionEvents, restoreDraft: restoreDraft, draftSnapshot: draftSnapshot, persistProductionRun: persistProductionRun,
      bindRuntimeEvents: bindRuntimeEvents, fetchResult: fetchResult,
      assetRightsFingerprint: assetRightsFingerprint, renderAssets: renderAssets, renderReadiness: renderReadiness, renderProductionOptions: renderProductionOptions
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
