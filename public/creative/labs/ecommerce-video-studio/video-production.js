/* 镜头计划与浏览器本地合成；本模块不提交任何模型请求。 */
(function (root, factory) {
  var contract = root && root.SZEcommerceVideoContract;
  if (typeof module === 'object' && module.exports) contract = require('./video-studio-contract.js');
  var api = factory(root, contract);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SZEcommerceVideoProduction = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, Contract) {
  'use strict';

  // Official five-second reference examples, without video input. These are not
  // calculated from the final canvas: the provider may align its raw dimensions.
  // https://docs.volcengine.com/docs/ark/model-pricing?lang=en&redirect=1
  var RESOLUTION_PRICES = Object.freeze({
    'seedance-2.0-mini': Object.freeze({ '480p': 1.16, '720p': 2.48 }),
    'seedance-2.0': Object.freeze({ '480p': 2.31, '720p': 4.97, '1080p': 12.39, '4k': 25.27 }),
    'seedance-2.5': Object.freeze({ '480p': 3.36, '720p': 7.56, '1080p': 18.71 })
  });
  var PRICES = Object.freeze({ 'seedance-2.0-mini': 2.48, 'seedance-2.0': 4.97, 'seedance-2.5': 7.56 });
  // Product export sizes, independent of model-native source alignment/pricing.
  var OUTPUT_SIZES = Object.freeze({ '480p': [854, 480], '720p': [1280, 720], '1080p': [1920, 1080], '4k': [3840, 2160] });
  var OUTPUT_BITRATES = Object.freeze({ '480p': 2000000, '720p': 4000000, '1080p': 8000000, '4k': 24000000 });
  var MODES = Object.freeze(['economic', 'balanced', 'quality']);
  function error(code, message, details) {
    var value = new Error(message); value.code = code; value.name = 'VideoProductionError';
    if (details !== undefined) value.details = details;
    return value;
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.keys(value).forEach(function (key) { freeze(value[key]); }); Object.freeze(value);
    }
    return value;
  }
  function finite(value, fallback) {
    return value !== '' && value != null && Number.isFinite(Number(value)) ? Number(value) : fallback;
  }
  function round(value) { return Math.round((value + Number.EPSILON) * 100) / 100; }
  function outputDimensions(resolution, ratio) {
    var size = Object.prototype.hasOwnProperty.call(OUTPUT_SIZES, resolution) && OUTPUT_SIZES[resolution];
    if (!size) throw error('PRODUCTION_RESOLUTION_UNSUPPORTED', '不支持此成片分辨率，禁止自动降级。');
    if (['16:9', '9:16'].indexOf(ratio) < 0) throw error('PRODUCTION_RATIO_UNSUPPORTED', '成片合成仅支持 16:9 或 9:16，禁止自动更改画幅。');
    return { width: ratio === '9:16' ? size[1] : size[0], height: ratio === '9:16' ? size[0] : size[1] };
  }
  function planOutput(plan) {
    // Historical plans were always composed at 720p, even if an older request
    // snapshot happened to contain another UI selection. Never read current UI.
    var legacy = plan.version == null || plan.version === 1;
    if (!legacy && plan.version !== 2) throw error('PRODUCTION_PLAN_VERSION_UNSUPPORTED', '无法核验此版本的成片尺寸，请保留原计划核对。');
    var resolution = plan.resolution || (legacy ? '720p' : '');
    var dimensions = outputDimensions(resolution, plan.ratio);
    if ((!legacy && (plan.width == null || plan.height == null)) ||
        (plan.width != null && plan.width !== dimensions.width) || (plan.height != null && plan.height !== dimensions.height) ||
        (!legacy && plan.request && (plan.request.resolution !== resolution || plan.request.ratio != null && plan.request.ratio !== plan.ratio)) ||
        (!legacy && plan.shots.some(function (shot) { return shot.kind === 'ai' && (!shot.request || shot.request.resolution !== resolution || shot.request.ratio !== plan.ratio); }))) {
      throw error('PRODUCTION_DIMENSIONS_MISMATCH', '成片尺寸与已保存计划不一致，禁止改写原计划或静默降级。');
    }
    if (!legacy && plan.outputFrameRate != null && plan.outputFrameRate !== 24) throw error('PRODUCTION_FRAME_RATE_UNSUPPORTED', '无法核验此成片计划的输出帧率，请保留原计划核对。');
    return { resolution: resolution, width: dimensions.width, height: dimensions.height, frameRate: legacy ? 30 : 24, videoBitsPerSecond: legacy ? 4000000 : OUTPUT_BITRATES[resolution] };
  }
  function id(prefix) {
    return prefix + '_' + (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10));
  }
  function totalDuration(value) {
    value = Number(value);
    if (!Number.isInteger(value) || value < 15 || value > 60 || value % 5 !== 0) {
      throw error('PRODUCTION_DURATION_INVALID', '成片时长必须为 15–60 秒，按 5 秒镜头设置。');
    }
    return value;
  }
  function normalizeOptions(raw) {
    raw = raw || {};
    var mode = String(raw.mode || raw.preset || 'economic');
    if (MODES.indexOf(mode) < 0) throw error('PRODUCTION_MODE_INVALID', '请选择经济、均衡或品质方案。');
    var budget = finite(raw.budgetYuan, 30);
    var attempts = finite(raw.maxAttempts, 1);
    var ai = finite(raw.hybridAiSeconds, 10);
    if (budget < 0 || budget > 100000) throw error('PRODUCTION_BUDGET_INVALID', '预算必须为 0–100000 元。');
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 2) throw error('PRODUCTION_ATTEMPTS_INVALID', '每镜最多尝试次数必须为 1–2 次。');
    if (!Number.isInteger(ai) || ai < 0 || ai > 15 || ai % 5 !== 0) throw error('PRODUCTION_AI_DURATION_INVALID', '混合方案 AI 时长只能为 0、5、10 或 15 秒。');
    var result = { mode: mode, budgetYuan: round(budget), maxAttempts: attempts, hybridAiSeconds: ai };
    if (raw.totalDurationSeconds != null) result.totalDurationSeconds = totalDuration(raw.totalDurationSeconds);
    return freeze(result);
  }
  function estimateShot(shot) {
    if (shot && shot.kind === 'local') return 0;
    var request = shot && (shot.request || shot) || {};
    var key = shot && shot.productKey || request.productKey;
    var rates = Object.prototype.hasOwnProperty.call(RESOLUTION_PRICES, key) && RESOLUTION_PRICES[key];
    var rate = rates && Object.prototype.hasOwnProperty.call(rates, request.resolution) && rates[request.resolution];
    var duration = finite(shot && shot.durationSeconds, finite(request.durationSeconds, 0));
    if (!rate) throw error('PRODUCTION_PRICE_UNKNOWN', '该模型与分辨率组合没有已核对的镜头参考价格，禁止自动降级。');
    if (['16:9', '9:16'].indexOf(request.ratio) < 0) {
      throw error('PRODUCTION_PRICE_UNKNOWN', '预算仅支持 16:9 或 9:16，不估算其他画幅。');
    }
    if (duration < 4 || duration > 15) throw error('PRODUCTION_SHOT_DURATION_INVALID', 'AI 镜头时长必须为 4–15 秒。');
    if ((request.videos && request.videos.length) || (request.audios && request.audios.length) || request.referenceVideo) {
      throw error('PRODUCTION_REFERENCE_PRICE_UNKNOWN', '参考视频/音频输入费用未计入此估价，禁止据此提交。');
    }
    return round(rate * duration / 5);
  }
  function selected(values) { return (Array.isArray(values) ? values : []).filter(function (asset) { return asset && asset.selected !== false; }); }
  function assetId(asset) { return String(asset.id || asset.storageRef && asset.storageRef.id || ''); }
  function assertRights(request) {
    var count = selected(request.images || request.productImages).length +
      selected(request.videos || request.generationVideos || request.referenceVideos).length +
      selected(request.audios || request.referenceAudios).length + selected(request.referenceFrames).length + (request.referenceVideo ? 1 : 0);
    if (!count) return;
    var rights = request.rights || request.assetRights || {};
    if (rights.confirmed !== true || !Number.isFinite(Date.parse(rights.confirmedAt)) || Date.parse(rights.confirmedAt) <= 0 ||
        (rights.fingerprint || rights.assetFingerprint) !== Contract.assetRightsFingerprint(request)) {
      throw error('PRODUCTION_ASSET_RIGHTS_REQUIRED', '请先确认当前全部素材的使用权；素材变化后需要重新确认。');
    }
  }
  function confirmedStoryboard(request, requireReview) {
    var raw = request.storyboard || [];
    if (!raw.length) {
      if (requireReview && request.mode !== 'direct') throw error('PRODUCTION_REVIEW_REQUIRED', '请先确认脚本和分镜。');
      return [];
    }
    var storyboard = Contract.normalizeStoryboard(raw, { maxShotDuration: 60 });
    if (request.mode !== 'direct') {
      if (request.scriptConfirmed !== true || !Number.isFinite(Date.parse(request.reviewConfirmedAt)) || Date.parse(request.reviewConfirmedAt) <= 0 ||
          request.reviewFingerprint !== Contract.reviewFingerprint(request.script, storyboard)) {
        if (!requireReview) return [];
        throw error('PRODUCTION_REVIEW_REQUIRED', '脚本或分镜已变更，请重新确认。');
      }
    }
    return storyboard;
  }
  function storyForSlot(storyboard, index, count) {
    if (!storyboard.length) return null;
    var duration = storyboard[storyboard.length - 1].endSecond;
    var at = (index + 0.5) / count * duration;
    return storyboard.find(function (shot) { return at >= shot.startSecond && at < shot.endSecond; }) || storyboard[storyboard.length - 1];
  }
  function aiRequest(original, key, story, index, count, images) {
    var route = original.creativeRoute || 'free_direct';
    if (route === 'reference_rebuild' || route === 'audio_visual') route = 'storyboard_direct';
    if (route === 'elements_compose' && images.length < 2) route = images.length ? 'hero_product' : 'free_direct';
    if (route === 'hero_product' && !images.length) route = 'free_direct';
    var details = story ? [story.visual, story.composition, story.camera, story.motion, story.rhythm].filter(Boolean).join('；') : '';
    var supplement = [
      original.supplementalRequirements || '',
      '商品锁定：保持参考商品的轮廓、比例、包装版式、材质、颜色、Logo 与可见文字一致，不虚构卖点。',
      '这是成片的第 ' + (index + 1) + '/' + count + ' 镜，只生成这一镜的 5 秒内容，不重复生成完整视频。',
      details ? '已确认对应分镜：' + details : '按原用户脚本为该镜头安排一个清晰画面与动作。',
      '视频与音频素材仅用于本地剪辑，未作为本次模型参考输入。字幕、Logo 叠加与剪辑在本地完成。'
    ].filter(Boolean).join('\n');
    var raw = Object.assign({}, clone(original), {
      mode: 'direct', creativeRoute: route, productKey: key, durationSeconds: 5,
      resolution: original.resolution, audioMode: 'silent', generateSound: false, narration: false, narrationLanguage: '', images: clone(images), videos: [], audios: [],
      generationVideos: [], referenceAudios: [], referenceVideos: [], referenceVideo: null, referenceFrames: [],
      storyboard: [], scriptConfirmed: false, reviewFingerprint: '', reviewConfirmedAt: '',
      script: String(original.script || original.confirmedScript || original.goal || original.prompt || '').trim(),
      supplementalRequirements: supplement
    });
    if (!raw.script) throw error('PRODUCTION_SCRIPT_REQUIRED', '请先填写或确认用户脚本。');
    var rights = original.rights || original.assetRights || {};
    raw.rights = { confirmed: rights.confirmed === true, confirmedAt: rights.confirmedAt || '', fingerprint: Contract.assetRightsFingerprint(raw) };
    return clone(Contract.normalizeRequest(raw, { stage: 'submit' }));
  }
  function buildPlan(input, rawOptions) {
    if (!Contract) throw error('PRODUCTION_CONTRACT_MISSING', '视频合同尚未加载。');
    if (!input || typeof input !== 'object') throw error('PRODUCTION_REQUEST_INVALID', '缺少原始创作请求。');
    var request = clone(input), options = normalizeOptions(rawOptions);
    var dimensions = outputDimensions(request.resolution, request.ratio);
    var total = totalDuration(options.totalDurationSeconds == null ? request.durationSeconds : options.totalDurationSeconds);
    if (['16:9', '9:16'].indexOf(request.ratio) < 0) throw error('PRODUCTION_PRICE_UNKNOWN', '成本方案仅支持 16:9 或 9:16，请先选择画幅。');
    assertRights(request);
    var count = total / 5, aiCount = options.mode === 'economic' ? options.hybridAiSeconds / 5 : count;
    var storyboard = confirmedStoryboard(request, aiCount > 0);
    var images = selected(request.images || request.productImages);
    var videos = selected(request.videos || request.generationVideos || (request.mode === 'remix' ? [] : request.referenceVideos));
    var sources = images.map(function (asset) { return { id: assetId(asset), kind: 'image', asset: asset }; })
      .concat(videos.map(function (asset) { return { id: assetId(asset), kind: 'video', asset: asset }; })).filter(function (source) { return !!source.id; });
    if (aiCount > count) throw error('PRODUCTION_AI_DURATION_INVALID', '混合 AI 时长不能超过成片时长。');
    if (options.mode === 'economic' && count > aiCount && !sources.length) {
      throw error('PRODUCTION_LOCAL_ASSET_REQUIRED', '经济方案需要已有商品图片或实拍视频；没有素材不能制作本地镜头。');
    }
    var aiPositions = {};
    for (var aiIndex = 0; aiIndex < aiCount; aiIndex++) {
      aiPositions[aiCount === 1 ? 0 : Math.round(aiIndex * (count - 1) / (aiCount - 1))] = true;
    }
    var planId = id('production'), localIndex = 0;
    var shots = Array.from({ length: count }, function (_, index) {
      var isAi = options.mode !== 'economic' || !!aiPositions[index];
      var key = options.mode === 'quality' ? request.productKey : (options.mode === 'balanced' && index % 3 === 2 ? 'seedance-2.0' : 'seedance-2.0-mini');
      var story = storyForSlot(storyboard, index, count);
      var shot = {
        id: planId + '_shot_' + (index + 1), index: index, kind: isAi ? 'ai' : 'local',
        durationSeconds: 5, startSecond: index * 5, endSecond: (index + 1) * 5,
        productKey: isAi ? key : '', estimatedYuan: 0,
        sourceStoryboardId: story ? story.id : '', subtitle: story ? String(story.narration || '') : ''
      };
      if (isAi) {
        shot.request = aiRequest(request, key, story, index, count, images);
        shot.estimatedYuan = estimateShot(shot); shot.reservedYuan = Math.ceil(shot.estimatedYuan * 110) / 100;
      } else {
        var source = sources[localIndex++ % sources.length];
        shot.sourceAssetId = source.id; shot.sourceKind = source.kind; shot.sourceStartSeconds = 0; shot.reservedYuan = 0;
      }
      return shot;
    });
    var estimate = round(shots.reduce(function (sum, shot) { return sum + shot.estimatedYuan; }, 0));
    var reserved = round(shots.reduce(function (sum, shot) { return sum + shot.reservedYuan; }, 0));
    var audios = selected(request.audios || request.referenceAudios);
    var music = audios.find(function (asset) { return asset.role === 'rhythm'; }) || audios[0];
    return freeze({
      id: planId, version: 2, createdAt: new Date().toISOString(), options: options, request: request,
      shots: shots, totalSeconds: total, aiSeconds: aiCount * 5, localSeconds: total - aiCount * 5,
      estimateYuan: estimate, reservedEstimateYuan: reserved, maximumGenerationYuan: round(estimate * options.maxAttempts), maximumReservedYuan: round(reserved * options.maxAttempts), withinBudget: reserved <= options.budgetYuan,
      resolution: request.resolution, ratio: request.ratio, width: dimensions.width, height: dimensions.height,
      outputDimensionPolicy: 'standard-video-v1', outputFrameRate: 24,
      musicAssetIds: music && assetId(music) ? [assetId(music)] : [],
      estimateScope: '首轮 5 秒 AI 镜头的官方无参考视频估价示例，按模型与请求分辨率区分；上游原生尺寸与最终合成画布分别处理。预留不是费用上限，实际费用以供应商用量回执为准；不含生图、素材采购、存储或付费剪辑。',
      adjustments: [request.audioMode && request.audioMode !== 'silent' ? 'AI 镜头使用静音生成，已上传声音仅在本地合成。' : '', audios.length > 1 ? '本地合成使用第一个节奏/声音素材，其余音频未混入。' : ''].filter(Boolean)
    });
  }

  function aborted(signal) {
    if (!signal || !signal.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    var failure = error('PRODUCTION_CANCELLED', '本地视频合成已取消。'); failure.name = 'AbortError'; throw failure;
  }
  function volume(value, fallback) {
    if (value != null && value !== '' && !Number.isFinite(Number(value))) throw error('PRODUCTION_AUDIO_VOLUME_INVALID', '声音音量必须是 0–1 之间的数字。');
    var result = finite(value, fallback);
    if (result < 0 || result > 1) throw error('PRODUCTION_AUDIO_VOLUME_INVALID', '声音音量必须在 0–1 之间。');
    return result;
  }
  function normalizeAudioTracks(raw, total) {
    if (!Array.isArray(raw)) throw error('PRODUCTION_AUDIO_TRACKS_INVALID', '最终声音需要明确的人声或背景音乐轨道。');
    var seen = Object.create(null);
    return raw.filter(function (track) { return !(track && track.selected === false); }).map(function (track) {
      if (!track || typeof track !== 'object' || Array.isArray(track)) throw error('PRODUCTION_AUDIO_TRACKS_INVALID', '声音轨道数据无效。');
      var sourceId = String(track.assetId || track.id || '').trim(), trackId = String(track.id || sourceId).trim();
      var role = String(track.role || ''), start = finite(track.startSeconds, 0);
      if (!sourceId || !trackId || seen[trackId] || ['narration', 'music'].indexOf(role) < 0) {
        throw error('PRODUCTION_AUDIO_TRACKS_INVALID', '声音轨道缺少素材、角色或具有重复标识。');
      }
      if ((track.startSeconds != null && !Number.isFinite(Number(track.startSeconds))) || start < 0 || start >= total) throw error('PRODUCTION_AUDIO_START_INVALID', '声音起点必须位于成片时间轴内。');
      if (role === 'narration' && track.loop === true) throw error('PRODUCTION_NARRATION_LOOP_INVALID', '人声不能循环播放。');
      seen[trackId] = true;
      return { id: trackId, assetId: sourceId, role: role, volume: volume(track.volume, role === 'narration' ? 1 : 0.25),
        startSeconds: start, loop: role === 'music' && track.loop !== false };
    });
  }
  function abortable(promise, signal, timeout) {
    aborted(signal);
    return new Promise(function (resolve, reject) {
      var timer;
      function finish(fn, value) {
        if (timer) root.clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', cancel);
        fn(value);
      }
      function cancel() { try { aborted(signal); } catch (failure) { finish(reject, failure); } }
      if (signal) signal.addEventListener('abort', cancel, { once: true });
      if (timeout) timer = root.setTimeout(function () { finish(reject, error('PRODUCTION_MEDIA_TIMEOUT', '本地媒体读取或播放超时。')); }, timeout);
      Promise.resolve(promise).then(function (value) { finish(resolve, value); }, function (failure) { finish(reject, failure); });
    });
  }
  function sourceBlob(value) {
    var blob = value && (value.blob || value.file) || value;
    if (!(blob instanceof root.Blob) || !blob.size) throw error('PRODUCTION_SOURCE_BLOB_REQUIRED', '合成需要已读取的非空 Blob；远程地址需先由工作台转存。');
    return blob;
  }
  function mediaReady(media, event, signal) {
    return abortable(new Promise(function (resolve, reject) {
      function cleanup() { media.removeEventListener(event, done); media.removeEventListener('error', fail); }
      function done() { cleanup(); resolve(media); }
      function fail() { cleanup(); reject(error('PRODUCTION_MEDIA_INVALID', '素材无法由浏览器解码。')); }
      media.addEventListener(event, done, { once: true }); media.addEventListener('error', fail, { once: true });
    }), signal, 20000);
  }
  function probeFiniteDuration(media, signal) {
    return new Promise(function (resolve, reject) {
      var names = ['durationchange', 'timeupdate', 'seeked', 'ended'], timer;
      function cleanup() { if (timer) root.clearTimeout(timer); names.forEach(function (name) { media.removeEventListener(name, inspect); }); media.removeEventListener('error', fail); signal.removeEventListener('abort', cancel); }
      function finish(fn, value) { cleanup(); fn(value); }
      function inspect() { if (Number.isFinite(media.duration) && media.duration > 0) finish(resolve, media.duration); }
      function fail() { finish(reject, error('PRODUCTION_MEDIA_INVALID', '视频时长探测时解码失败。')); }
      function cancel() { try { aborted(signal); } catch (failure) { finish(reject, failure); } }
      names.forEach(function (name) { media.addEventListener(name, inspect); }); media.addEventListener('error', fail); signal.addEventListener('abort', cancel, { once: true });
      timer = root.setTimeout(function () { finish(reject, error('PRODUCTION_DURATION_PROBE_TIMEOUT', '浏览器无法探测流式视频时长。')); }, 5000);
      try { aborted(signal); media.currentTime = 1000000000; inspect(); } catch (failure) { finish(reject, failure); }
    });
  }
  function recorderMime() {
    var candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    var supported = candidates.find(function (mime) { return !root.MediaRecorder.isTypeSupported || root.MediaRecorder.isTypeSupported(mime); });
    if (!supported) throw error('PRODUCTION_WEBM_UNAVAILABLE', '当前浏览器不支持录制 WebM，请使用支持 MediaRecorder 的 Chrome/Edge。');
    return supported;
  }
  function drawMedia(context, media, width, height, progress, image) {
    var mediaWidth = media.naturalWidth || media.videoWidth, mediaHeight = media.naturalHeight || media.videoHeight;
    if (!mediaWidth || !mediaHeight) throw error('PRODUCTION_MEDIA_DIMENSIONS', '素材没有可解码的画面尺寸。');
    context.fillStyle = '#111111'; context.fillRect(0, 0, width, height);
    var scale = Math.min(width / mediaWidth, height / mediaHeight) * (image ? 0.97 + progress * 0.03 : 1);
    var drawnWidth = mediaWidth * scale, drawnHeight = mediaHeight * scale;
    context.drawImage(media, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
  }
  function drawSubtitle(context, value, width, height) {
    value = String(value || '').trim(); if (!value) return;
    var font = Math.round(Math.min(width, height) * 0.05), padding = font, maxWidth = width - padding * 2;
    context.font = '500 ' + font + 'px sans-serif';
    var lines = [], line = '';
    Array.from(value.replace(/\s+/g, ' ')).forEach(function (char) {
      if (context.measureText(line + char).width > maxWidth && line) { lines.push(line); line = char; } else line += char;
    });
    if (line) lines.push(line);
    if (lines.length > 3) { lines = lines.slice(0, 3); lines[2] = lines[2].slice(0, -1) + '…'; }
    var lineHeight = font * 1.35, boxHeight = lines.length * lineHeight + padding;
    context.fillStyle = 'rgba(0,0,0,0.72)'; context.fillRect(0, height - boxHeight - padding, width, boxHeight);
    context.fillStyle = '#ffffff'; context.textAlign = 'center'; context.textBaseline = 'top';
    lines.forEach(function (text, index) { context.fillText(text, width / 2, height - boxHeight - padding / 2 + index * lineHeight); });
  }
  // Live MediaRecorder WebM 通常缺 Duration；补入标准 EBML Info，保证下载后可读取真实时长。
  function vint(bytes, offset, isId) {
    var first = bytes[offset], mask = 128, length = 1;
    if (!first) throw error('PRODUCTION_WEBM_INVALID', 'WebM 数据头无效。');
    while (!(first & mask)) { mask >>= 1; length++; }
    if (offset + length > bytes.length) throw error('PRODUCTION_WEBM_INVALID', 'WebM 数据头不完整。');
    var value = isId ? first : first & (mask - 1), unknown = !isId && value === mask - 1;
    for (var i = 1; i < length; i++) { value = value * 256 + bytes[offset + i]; unknown = unknown && bytes[offset + i] === 255; }
    return { value: unknown ? Infinity : value, length: length };
  }
  function sizeBytes(value, minLength) {
    var length = minLength || 1;
    while (value >= Math.pow(2, 7 * length) - 1) length++;
    var bytes = new Uint8Array(length), remainder = value;
    for (var i = length - 1; i >= 0; i--) { bytes[i] = remainder % 256; remainder = Math.floor(remainder / 256); }
    bytes[0] |= Math.pow(2, 8 - length); return bytes;
  }
  function elementAt(bytes, at) {
    var tag = vint(bytes, at, true), size = vint(bytes, at + tag.length, false), start = at + tag.length + size.length;
    return { id: tag.value, at: at, idLength: tag.length, sizeLength: size.length, size: size.value, start: start, end: Number.isFinite(size.value) ? start + size.value : bytes.length };
  }
  async function fixWebmDuration(blob, seconds, signal) {
    var bytes = new Uint8Array(await abortable(blob.arrayBuffer(), signal));
    var segment, info, offset = 0;
    while (offset < bytes.length) { var entry = elementAt(bytes, offset); if (entry.id === 0x18538067) { segment = entry; break; } offset = entry.end; }
    if (!segment) throw error('PRODUCTION_WEBM_INVALID', '录制结果不是完整 WebM。');
    offset = segment.start;
    while (offset < segment.end) { var child = elementAt(bytes, offset); if (child.id === 0x1549A966) { info = child; break; } if (!Number.isFinite(child.size)) break; offset = child.end; }
    if (!info || !Number.isFinite(info.size) || info.end > bytes.length) throw error('PRODUCTION_WEBM_INVALID', '录制结果缺少 WebM 媒体信息。');
    var scale = 1000000, duration;
    offset = info.start;
    while (offset < info.end) {
      var field = elementAt(bytes, offset);
      if (field.id === 0x2AD7B1) { scale = 0; for (var s = field.start; s < field.end; s++) scale = scale * 256 + bytes[s]; }
      if (field.id === 0x4489) duration = field;
      offset = field.end;
    }
    if (!Number.isFinite(scale) || scale <= 0) throw error('PRODUCTION_WEBM_INVALID', 'WebM 时间单位无效。');
    var value = seconds * 1000000000 / scale;
    if (duration && (duration.size === 4 || duration.size === 8)) {
      var view = new DataView(bytes.buffer); if (duration.size === 4) view.setFloat32(duration.start, value, false); else view.setFloat64(duration.start, value, false);
      return new root.Blob([bytes], { type: blob.type });
    }
    var appended = new Uint8Array(11); appended.set([0x44, 0x89, 0x88]); new DataView(appended.buffer).setFloat64(3, value, false);
    var replacementSize = sizeBytes(info.size + appended.length, info.sizeLength), delta = appended.length + replacementSize.length - info.sizeLength;
    var result = [bytes.slice(0, info.at + info.idLength), replacementSize, bytes.slice(info.start, info.end), appended, bytes.slice(info.end)];
    var changed = new Uint8Array(await new root.Blob(result).arrayBuffer());
    if (Number.isFinite(segment.size)) {
      var newSegmentSize = sizeBytes(segment.size + delta, segment.sizeLength);
      changed = new Uint8Array(await new root.Blob([changed.slice(0, segment.at + segment.idLength), newSegmentSize, changed.slice(segment.start)]).arrayBuffer());
    }
    aborted(signal); return new root.Blob([changed], { type: blob.type });
  }
  async function renderTimeline(input, settings) {
    settings = settings || {};
    // Snapshot before any await: input/UI changes cannot alter an in-flight render.
    var plan = clone(input), sources = [], urls = [], audioNodes = [], audioBuffers = [], warnings = [], stream, recorder, audioContext, silentClock;
    var audioSelection = settings.audioTracks !== undefined ? settings.audioTracks :
      Array.isArray(plan.audioTracks) ? clone(plan.audioTracks) :
        (plan.musicAssetIds || []).map(function (assetId) { return { id: assetId, assetId: assetId, role: 'music', volume: finite(settings.musicVolume, 0.5), loop: true }; });
    var preserveAudio = settings.preserveAudio !== false, requestedSourceVolume = settings.sourceAudioVolume;
    var resolveAudio = settings.resolveAudio, resolveAsset = settings.resolveAsset;
    var controller = new root.AbortController(), signal = controller.signal, parentSignal = settings.signal;
    function cancel() { controller.abort(parentSignal.reason); }
    if (parentSignal) { if (parentSignal.aborted) cancel(); else parentSignal.addEventListener('abort', cancel, { once: true }); }
    function progress(value) { if (typeof settings.onProgress === 'function') settings.onProgress(value); }
    try {
      aborted(signal);
      if (!root.document || !root.MediaRecorder) throw error('PRODUCTION_RECORDER_UNAVAILABLE', '当前浏览器没有 MediaRecorder，无法本地制作视频。');
      if (!plan || !Array.isArray(plan.shots) || !plan.shots.length || ['16:9', '9:16'].indexOf(plan.ratio) < 0) throw error('PRODUCTION_PLAN_INVALID', '镜头计划无效。');
      var total = plan.shots.reduce(function (sum, shot) {
        if (['local', 'ai'].indexOf(shot.kind) < 0 || !Number.isFinite(shot.durationSeconds) || shot.durationSeconds <= 0) throw error('PRODUCTION_PLAN_INVALID', '镜头类型或时长无效。');
        return sum + shot.durationSeconds;
      }, 0);
      if (Math.abs(total - plan.totalSeconds) > 0.01 || total < 1 || total > 60) throw error('PRODUCTION_PLAN_INVALID', '时间轴与成片时长不一致。');
      var tracks = normalizeAudioTracks(audioSelection, total);
      var sourceAudioVolume = preserveAudio ? volume(requestedSourceVolume, tracks.length ? 0.35 : 1) : 0;
      var output = planOutput(plan), width = output.width, height = output.height;
      var canvas = root.document.createElement('canvas'); canvas.width = width; canvas.height = height;
      if (canvas.width !== width || canvas.height !== height) throw error('PRODUCTION_CAPTURE_DIMENSIONS', '浏览器不支持所选成片尺寸，禁止降低分辨率输出。');
      if (!canvas.captureStream) throw error('PRODUCTION_CAPTURE_UNAVAILABLE', '当前浏览器无法录制 Canvas 视频。');
      var context = canvas.getContext('2d', { alpha: false });
      if (!context) throw error('PRODUCTION_CANVAS_UNAVAILABLE', '无法建立本地视频画布。');
      var hasVideo = plan.shots.some(function (shot) { return shot.kind === 'ai' || shot.sourceKind === 'video'; });
      var Audio = root.AudioContext || root.webkitAudioContext, destination;
      if ((hasVideo && sourceAudioVolume > 0) || tracks.length) {
        if (!Audio) throw error('PRODUCTION_AUDIO_UNAVAILABLE', '浏览器不支持声轨合成；请更换浏览器或明确选择静音合成。');
        audioContext = new Audio(); destination = audioContext.createMediaStreamDestination();
        await abortable(audioContext.resume(), signal, 10000);
        if (audioContext.state !== 'running') throw error('PRODUCTION_AUDIO_START_REQUIRED', '声音未获浏览器播放许可，请点击合成按钮重试。');
      }
      async function prepare(blobValue, kind, shot) {
        var blob = sourceBlob(blobValue), url = root.URL.createObjectURL(blob); urls.push(url);
        var media = root.document.createElement(kind === 'image' ? 'img' : kind === 'audio' ? 'audio' : 'video');
        var source = { kind: kind, media: media, shot: shot, gain: null }; sources.push(source);
        if (kind === 'image') {
          var imageReady = mediaReady(media, 'load', signal); media.src = url; await imageReady;
          if (!media.naturalWidth) throw error('PRODUCTION_MEDIA_INVALID', '图片解码失败。');
        } else {
          media.preload = 'auto'; media.playsInline = true;
          media.muted = !(audioContext && sourceAudioVolume > 0);
          media.loop = shot && shot.kind === 'local';
          var ready = mediaReady(media, 'loadeddata', signal); media.src = url; media.load(); await ready;
          var effectiveDuration = media.duration;
          if (kind === 'video' && effectiveDuration === Infinity && media.videoWidth > 0 && media.videoHeight > 0 && media.readyState >= 2 && !media.error) {
            try { effectiveDuration = await probeFiniteDuration(media, signal); }
            catch (failure) {
              aborted(signal);
              var declared = blobValue && !(blobValue instanceof root.Blob) ? finite(blobValue.durationSec, finite(blobValue.durationSeconds, 0)) : 0;
              if (failure.code !== 'PRODUCTION_DURATION_PROBE_TIMEOUT' || declared <= 0 || !media.videoWidth || !media.videoHeight || media.error) throw failure;
              effectiveDuration = Math.min(declared, shot.durationSeconds);
              warnings.push('流式视频使用已保存的素材时长，每镜播放不超过计划的 5 秒。');
            }
          }
          if (!Number.isFinite(effectiveDuration) || effectiveDuration <= 0) throw error('PRODUCTION_MEDIA_DURATION', '源媒体没有有效时长。');
          if (shot && shot.kind === 'ai' && effectiveDuration < shot.durationSeconds - 0.25) throw error('PRODUCTION_VIDEO_TOO_SHORT', '生成镜头比计划短，请先更换该镜头。');
          var start = shot && finite(shot.sourceStartSeconds, 0) || 0;
          if (start < 0 || start >= effectiveDuration) throw error('PRODUCTION_SOURCE_TIME_INVALID', '本地视频截取起点超出素材时长。');
          if (start || media.seeking || Math.abs(media.currentTime - start) > 0.001) { var seeked = mediaReady(media, 'seeked', signal); media.currentTime = start; await seeked; }
          if (audioContext && sourceAudioVolume > 0) {
            var node = audioContext.createMediaElementSource(media), gain = audioContext.createGain();
            node.connect(gain); gain.connect(destination); gain.gain.value = 0; source.gain = gain; audioNodes.push(node, gain);
          }
        }
        return source;
      }
      var visuals = [];
      for (var i = 0; i < plan.shots.length; i++) {
        aborted(signal); var shot = plan.shots[i], resolved;
        progress({ stage: 'loading', shotIndex: i, totalShots: plan.shots.length, progress: 0 });
        if (shot.kind === 'local') {
          if (typeof settings.resolveAsset !== 'function') throw error('PRODUCTION_RESOLVER_REQUIRED', '缺少本地素材读取器。');
          resolved = await abortable(settings.resolveAsset(shot.sourceAssetId, { signal: signal }), signal);
        } else {
          if (typeof settings.resolveVideo !== 'function') throw error('PRODUCTION_RESOLVER_REQUIRED', '缺少已生成镜头读取器。');
          resolved = await abortable(settings.resolveVideo(shot, { signal: signal }), signal);
        }
        var kind = shot.kind === 'ai' ? 'video' : shot.sourceKind || (sourceBlob(resolved).type.indexOf('image/') === 0 ? 'image' : 'video');
        visuals.push(await prepare(resolved, kind, shot));
      }
      // Uploaded final sounds use decoded sample clocks, independent of five-second visual shots.
      for (var audioIndex = 0; audioIndex < tracks.length; audioIndex++) {
        aborted(signal); var track = tracks[audioIndex], audioValue;
        if (typeof resolveAudio === 'function') audioValue = await abortable(resolveAudio(track, { signal: signal }), signal);
        else if (typeof resolveAsset === 'function') audioValue = await abortable(resolveAsset(track.assetId, { signal: signal }), signal);
        else throw error('PRODUCTION_RESOLVER_REQUIRED', '缺少最终声音素材读取器。');
        var bytes = await abortable(sourceBlob(audioValue).arrayBuffer(), signal), buffer;
        try { buffer = await abortable(audioContext.decodeAudioData(bytes), signal, 20000); }
        catch (failure) { aborted(signal); throw error('PRODUCTION_AUDIO_DECODE_FAILED', '最终声音无法解码，请更换该音频素材。', { assetId: track.assetId }); }
        if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration <= 0) throw error('PRODUCTION_MEDIA_DURATION', '最终声音没有有效的样本时长。');
        if (track.role === 'narration' && track.startSeconds + buffer.duration > total) {
          throw error('PRODUCTION_NARRATION_TOO_LONG', '人声需要 ' + (track.startSeconds + buffer.duration).toFixed(2) + ' 秒，超过 ' + total + ' 秒成片；请延长成片或自行编辑人声，不能自动截断。',
            { assetId: track.assetId, durationSeconds: buffer.duration, startSeconds: track.startSeconds, totalDurationSeconds: total });
        }
        var audioSource = audioContext.createBufferSource(), audioGain = audioContext.createGain();
        audioSource.buffer = buffer; audioSource.loop = track.loop;
        audioGain.gain.value = track.volume; audioSource.connect(audioGain); audioGain.connect(destination);
        audioNodes.push(audioSource, audioGain); audioBuffers.push({ source: audioSource, track: track, durationSeconds: buffer.duration });
      }
      if (audioContext) {
        // Keep the destination active through silence so the encoder flushes the complete final voice packet.
        silentClock = audioContext.createBufferSource(); silentClock.loop = true;
        silentClock.buffer = audioContext.createBuffer(1, audioContext.sampleRate, audioContext.sampleRate);
        var silentGain = audioContext.createGain(); silentGain.gain.value = 0;
        silentClock.connect(silentGain); silentGain.connect(destination); audioNodes.push(silentClock, silentGain);
      }
      aborted(signal);
      drawMedia(context, visuals[0].media, width, height, 0, visuals[0].kind === 'image'); drawSubtitle(context, plan.shots[0].subtitle, width, height);
      stream = canvas.captureStream(output.frameRate);
      var videoTracks = typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks() : [];
      var trackSettings = videoTracks[0] && typeof videoTracks[0].getSettings === 'function' ? videoTracks[0].getSettings() : null;
      if (trackSettings && ((trackSettings.width != null && trackSettings.width !== width) || (trackSettings.height != null && trackSettings.height !== height))) throw error('PRODUCTION_CAPTURE_DIMENSIONS', '浏览器捕获尺寸与所选分辨率不一致，已停止合成，不会降低清晰度。');
      if (destination) destination.stream.getAudioTracks().forEach(function (track) { stream.addTrack(track); });
      try { recorder = new root.MediaRecorder(stream, { mimeType: recorderMime(), videoBitsPerSecond: output.videoBitsPerSecond, audioBitsPerSecond: 128000 }); }
      catch (_) { throw error('PRODUCTION_RECORDER_RESOLUTION_UNSUPPORTED', '浏览器无法按所选分辨率录制成片，请更换浏览器后继续本地合成；已生成镜头保留。'); }
      var chunks = [], recorded = new Promise(function (resolve, reject) {
        recorder.ondataavailable = function (event) { if (event.data && event.data.size) chunks.push(event.data); };
        recorder.onerror = function (event) { var failure = error('PRODUCTION_RECORDING_FAILED', event.error && event.error.message || '浏览器视频录制失败。'); controller.abort(failure); reject(failure); };
        recorder.onstop = function () {
          if (!chunks.length) reject(error('PRODUCTION_RECORDING_EMPTY', '录制没有产出视频，不能交付空文件。'));
          else resolve(new root.Blob(chunks, { type: recorder.mimeType || 'video/webm' }));
        };
      });
      recorded.catch(function () {});
      if (audioContext && audioContext.state !== 'running') throw error('PRODUCTION_AUDIO_START_REQUIRED', '声音播放被浏览器暂停，请保持页面打开后重新合成。');
      recorder.start(250);
      var timelineStarted = root.performance.now(), rendered = 0;
      var audioStarted = audioContext ? audioContext.currentTime : 0;
      if (silentClock) { silentClock.start(audioStarted); silentClock.stop(audioStarted + total); }
      audioBuffers.forEach(function (item) { item.source.start(audioStarted + item.track.startSeconds); item.source.stop(audioStarted + total); });
      for (var index = 0; index < visuals.length; index++) {
        var visual = visuals[index], currentShot = plan.shots[index];
        if (visual.gain) visual.gain.gain.value = sourceAudioVolume;
        if (visual.kind === 'video') await abortable(visual.media.play(), signal, 10000);
        var shotStarted = timelineStarted + rendered * 1000;
        if (root.performance.now() - shotStarted > 750) throw error('PRODUCTION_PLAYBACK_DELAY', '源视频起播过慢，已停止合成；请保持页面打开后重试。');
        await abortable(new Promise(function (resolve, reject) {
          var started = shotStarted, timer;
          function done() { if (timer) root.clearTimeout(timer); signal.removeEventListener('abort', cancelShot); }
          function cancelShot() { done(); try { aborted(signal); } catch (failure) { reject(failure); } }
          function frame() {
            try {
              aborted(signal); if (visual.kind === 'video' && visual.media.error) throw error('PRODUCTION_MEDIA_INVALID', '视频播放中发生解码错误，合成未完成。');
              var elapsed = Math.min(currentShot.durationSeconds, Math.max(0, (root.performance.now() - started) / 1000));
              drawMedia(context, visual.media, width, height, elapsed / currentShot.durationSeconds, visual.kind === 'image');
              drawSubtitle(context, currentShot.subtitle, width, height);
              progress({ stage: 'rendering', shotIndex: index, totalShots: visuals.length, secondsRendered: rendered + elapsed, progress: (rendered + elapsed) / total });
              if (elapsed >= currentShot.durationSeconds) { done(); resolve(); }
              else timer = root.setTimeout(frame, Math.min(1000 / output.frameRate, (currentShot.durationSeconds - elapsed) * 1000));
            } catch (failure) { done(); reject(failure); }
          }
          signal.addEventListener('abort', cancelShot, { once: true }); frame();
        }), signal);
        if (visual.kind === 'video') visual.media.pause(); if (visual.gain) visual.gain.gain.value = 0;
        rendered += currentShot.durationSeconds;
      }
      recorder.stop();
      var blob = await fixWebmDuration(await abortable(recorded, signal, 10000), total, signal);
      if (!blob.size) throw error('PRODUCTION_RECORDING_EMPTY', '合成没有产出有效视频。');
      progress({ stage: 'complete', progress: 1, secondsRendered: total, totalShots: visuals.length });
      var audioMix = { version: 1, totalDurationSeconds: total, sourceAudioVolume: sourceAudioVolume,
        outputAudioTracks: destination ? destination.stream.getAudioTracks().length : 0, narrationComplete: true,
        tracks: audioBuffers.map(function (item) { return Object.assign({}, item.track, { durationSeconds: item.durationSeconds,
          outputDurationSeconds: item.track.role === 'narration' ? item.durationSeconds :
            item.track.loop ? total - item.track.startSeconds : Math.min(item.durationSeconds, total - item.track.startSeconds) }); }) };
      return { blob: blob, resolution: output.resolution, width: width, height: height, frameRate: output.frameRate, durationSeconds: total, mimeType: blob.type, warnings: warnings, audioMix: audioMix };
    } finally {
      if (parentSignal) parentSignal.removeEventListener('abort', cancel);
      if (!signal.aborted) controller.abort();
      if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch (_) {} }
      sources.forEach(function (source) { try { if (source.media.pause) source.media.pause(); source.media.removeAttribute('src'); if (source.media.load) source.media.load(); } catch (_) {} });
      audioBuffers.forEach(function (item) { try { item.source.stop(); } catch (_) {} });
      if (silentClock) { try { silentClock.stop(); } catch (_) {} }
      audioNodes.forEach(function (node) { try { node.disconnect(); } catch (_) {} });
      if (stream) stream.getTracks().forEach(function (track) { track.stop(); });
      if (audioContext && audioContext.state !== 'closed') await audioContext.close().catch(function () {});
      urls.forEach(function (url) { root.URL.revokeObjectURL(url); });
    }
  }
  return Object.freeze({ MODES: MODES, PRICES_PER_FIVE_SECONDS: PRICES, PRICES_PER_FIVE_SECONDS_BY_RESOLUTION: RESOLUTION_PRICES, outputDimensions: outputDimensions, normalizeOptions: normalizeOptions, normalizeAudioTracks: normalizeAudioTracks, estimateShot: estimateShot, buildPlan: buildPlan, renderTimeline: renderTimeline, fixWebmDuration: fixWebmDuration });
});
