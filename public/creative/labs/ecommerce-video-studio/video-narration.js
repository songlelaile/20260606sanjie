/* Confirmed script -> new supplier speech. Uploaded audio is never a final track. */
(function (root, factory) {
  var contract = root && root.SZEcommerceVideoContract;
  if (!contract && typeof require === 'function') contract = require('./video-studio-contract.js');
  var api = factory(root || {}, contract);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SZEcommerceVideoNarration = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, Contract) {
  'use strict';
  var ENDPOINT = '/api/creative/narration';
  function failure(code, message, details) { var error = new Error(message); error.code = code; if (details) error.details = details; return error; }
  function text(value) { return String(value == null ? '' : value).trim(); }
  function fingerprint(plan) {
    return Contract.fingerprint([String(plan.request && plan.request.script || ''), (plan.request && plan.request.storyboard || []).map(function (shot) {
      return [shot.id, shot.startSecond, shot.endSecond, shot.narration || ''];
    })], 'narration_');
  }
  function buildPlan(plan) {
    if (!Contract || !plan || !plan.request) throw failure('NARRATION_PLAN_INVALID', '缺少已确认脚本，不能创建配音。');
    var scriptFingerprint = fingerprint(plan);
    var required = plan.narrationRequired != null ? plan.narrationRequired === true : plan.request.audioMode !== 'silent';
    if (!required) return { version: 1, required: false, scriptFingerprint: scriptFingerprint, segments: [] };
    var seen = {}, segments = (plan.request.storyboard || []).filter(function (shot) { return !!text(shot.narration); }).map(function (shot, index) {
      var start = Number(shot.startSecond), end = Number(shot.endSecond), id = text(shot.id || 'narration-' + (index + 1));
      if (seen[id] || !/^[A-Za-z0-9_-]{1,160}$/.test(id) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > plan.totalSeconds + 0.01 || [...text(shot.narration)].length > 1000) throw failure('NARRATION_PLAN_INVALID', '口播分镜的标识、时间或字数无效，请修改后重新确认。');
      seen[id] = true;
      return { id: id, shotId: id, text: text(shot.narration), startSeconds: start, endSeconds: end, durationSeconds: end - start, scriptFingerprint: scriptFingerprint };
    });
    if (!segments.length) throw failure('NARRATION_SCRIPT_REQUIRED', '请选择按脚本配音并在分镜“字幕 / 口播”中确认具体台词；上传原音频不会代替新配音。');
    for (var i = 1; i < segments.length; i++) if (segments[i].startSeconds < segments[i - 1].endSeconds - 0.01) throw failure('NARRATION_PLAN_INVALID', '口播分镜重叠，请修改后重新确认。');
    return { version: 1, required: true, scriptFingerprint: scriptFingerprint, segments: segments };
  }
  function abortCheck(hooks) { if (hooks.signal && hooks.signal.aborted) throw failure('NARRATION_CANCELLED', '配音流程已停止，原回执与已生成音轨保留。'); }
  function assertHooks(run, hooks) {
    if (!run.accountKey || !hooks.store || typeof hooks.store.saveAsset !== 'function' || typeof hooks.store.getAsset !== 'function' || typeof hooks.persist !== 'function' || typeof hooks.assertAccount !== 'function') throw failure('NARRATION_CONTEXT_INVALID', '缺少配音账号、素材库或持久化上下文。');
    hooks.assertAccount(); abortCheck(hooks);
  }
  async function persist(run, hooks) { hooks.assertAccount(); await hooks.persist(run); hooks.assertAccount(); }
  function fetcher(hooks) { return hooks.fetch || root.fetch.bind(root); }
  async function errorFrom(response) {
    var body;
    try { body = await response.json(); } catch (_) {}
    body = body && typeof body === 'object' ? body : {};
    return failure(text(body.code) || 'NARRATION_RESPONSE_UNKNOWN', text(body.error) || '配音服务未返回可核对回执，保留任务后核对。', {
      providerSubmitted: body.providerSubmitted !== false, definitiveFailure: body.definitiveFailure === true,
      stateUncertain: body.stateUncertain !== false || body.definitiveFailure !== true, status: response.status
    });
  }
  async function capabilities(options) {
    options = options || {};
    var response = await fetcher(options)(ENDPOINT + '?expectedAccountKey=' + encodeURIComponent(options.accountKey || ''), { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: options.signal });
    if (!response.ok) throw await errorFrom(response);
    var payload = await response.json();
    if (!payload || !payload.data || typeof payload.data.available !== 'boolean') throw failure('NARRATION_CAPABILITIES_INVALID', '配音能力回执不完整，请刷新后核对。', { providerSubmitted: false, definitiveFailure: true, stateUncertain: false });
    if (payload.data.available !== true && options.requireAvailable !== false) throw failure(payload.data.code || 'NARRATION_NOT_CONFIGURED', payload.data.message || '脚本配音服务或计费未配置。', { providerSubmitted: false, definitiveFailure: true, stateUncertain: false });
    return payload.data;
  }
  function initialize(run) {
    var planned = buildPlan(run.plan);
    if (run.plan.narration && (run.plan.narration.scriptFingerprint !== planned.scriptFingerprint || JSON.stringify(run.plan.narration.segments) !== JSON.stringify(planned.segments))) throw failure('NARRATION_PLAN_CHANGED', '原任务的确认口播已变化，请保留旧任务并新建计划。');
    if (!Array.isArray(run.narrationRuns)) run.narrationRuns = [];
    planned.segments.forEach(function (segment) {
      var saved = run.narrationRuns.find(function (item) { return item.id === segment.id; });
      if (saved && (saved.text !== segment.text || saved.scriptFingerprint !== planned.scriptFingerprint)) throw failure('NARRATION_PLAN_CHANGED', '已保存口播与当前确认脚本不一致，已停止重复调用。');
      if (!saved) run.narrationRuns.push(Object.assign({}, segment, { status: 'pending', attempts: [], resultAssetId: '', requestId: '', definitiveFailure: false, error: '' }));
    });
    return planned;
  }
  function requestBody(run, segment) { return { requestId: segment.requestId, shotId: segment.shotId, text: segment.text, durationSeconds: segment.durationSeconds, expectedAccountKey: run.accountKey }; }
  function requestId() {
    if (!root.crypto || typeof root.crypto.randomUUID !== 'function') throw failure('NARRATION_ID_UNAVAILABLE', '浏览器无法创建稳定配音回执，请更换受支持浏览器。');
    return 'narration_' + root.crypto.randomUUID().replace(/-/g, '');
  }
  function requireVerification() { if (!root.crypto || !root.crypto.subtle || typeof root.crypto.subtle.digest !== 'function') throw failure('NARRATION_VERIFY_UNAVAILABLE', '浏览器无法校验配音回执，请更换受支持浏览器后继续。'); }
  async function contentHash(blob) { requireVerification(); return Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))).map(function (part) { return part.toString(16).padStart(2, '0'); }).join(''); }
  async function saveResult(run, segment, response, hooks) {
    var billingEventId = response.headers.get('X-Narration-Billing-Event') || '', expectedHash = response.headers.get('X-Narration-Content-Hash') || '';
    if (response.headers.get('X-Narration-Origin') !== 'script_narration' || response.headers.get('X-Narration-Request-Id') !== segment.requestId || !/^audio\/(?:wav|x-wav)(?:;|$)/i.test(response.headers.get('content-type') || '') || !/^[A-Za-z0-9_.:-]{1,160}$/.test(billingEventId) || !/^[a-f0-9]{64}$/.test(expectedHash)) throw failure('NARRATION_RESULT_UNCONFIRMED', '新配音来源、计费事件或内容回执不完整，保留原任务后核对。');
    var duration = Number(response.headers.get('X-Narration-Duration'));
    if (!Number.isFinite(duration) || duration <= 0 || duration > segment.durationSeconds + 0.01) throw failure('NARRATION_RESULT_UNCONFIRMED', '新配音时长超出已确认分镜，未替换原音轨。');
    var blob = await response.blob(); hooks.assertAccount();
    if (!blob.size || blob.size > 16 * 1024 * 1024) throw failure('NARRATION_RESULT_UNCONFIRMED', '新配音文件无效，保留原回执后核对。');
    if (await contentHash(blob) !== expectedHash) throw failure('NARRATION_RESULT_UNCONFIRMED', '新配音文件与供应回执不一致，保留原任务后核对。');
    hooks.assertAccount();
    var saved = await hooks.store.saveAsset(blob, { id: segment.requestId + '_audio', expectedAccountKey: run.accountKey, kind: 'audio', name: 'AI配音_' + segment.shotId + '.wav', mimeType: 'audio/wav', durationSec: duration, role: 'script_narration' });
    hooks.assertAccount();
    if (!saved || !saved.id || saved.accountKey && saved.accountKey !== run.accountKey) throw failure('NARRATION_ACCOUNT_CHANGED', '配音保存账号不一致，原回执保留。');
    segment.resultAssetId = saved.id; segment.asset = saved; segment.durationSec = duration; segment.status = 'succeeded'; segment.error = ''; segment.definitiveFailure = false;
    segment.billingEventId = billingEventId; segment.contentHash = expectedHash; segment.completedAt = new Date().toISOString();
    if (segment.attempts.length) segment.attempts[segment.attempts.length - 1].status = 'succeeded';
    await persist(run, hooks);
  }
  async function executeSegment(run, segment, hooks) {
    assertHooks(run, hooks); requireVerification();
    if (segment.status === 'succeeded') {
      var asset = await hooks.store.getAsset(segment.resultAssetId); hooks.assertAccount();
      if (asset && asset.blob && asset.role === 'script_narration' && (!asset.accountKey || asset.accountKey === run.accountKey) && segment.contentHash && await contentHash(asset.blob) === segment.contentHash) return;
      segment.status = 'unknown'; segment.error = '本地配音缺失，正在按原回执恢复。'; await persist(run, hooks);
    }
    if (segment.status === 'failed') throw failure(segment.code || 'NARRATION_FAILED', segment.error || '有配音失败，请单独重试这条音轨。');
    var query = ['unknown', 'submitting'].indexOf(segment.status) >= 0;
    if (!segment.requestId) {
      if (query) throw failure('NARRATION_UNKNOWN', '配音原回执标识缺失，已阻止重新调用。');
      segment.requestId = requestId(); segment.attempts.push({ requestId: segment.requestId, createdAt: new Date().toISOString(), status: 'submitting' });
    }
    segment.status = query ? 'unknown' : 'submitting'; segment.error = ''; await persist(run, hooks); abortCheck(hooks);
    try {
      var response = await fetcher(hooks)(query ? ENDPOINT + '?requestId=' + encodeURIComponent(segment.requestId) + '&expectedAccountKey=' + encodeURIComponent(run.accountKey) : ENDPOINT,
        query ? { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: hooks.signal } : { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody(run, segment)), signal: hooks.signal });
      hooks.assertAccount();
      if (!response.ok) {
        var issue = await errorFrom(response);
        if (query && issue.code === 'NARRATION_SETTLEMENT_PENDING') {
          // This endpoint only settles the saved request; a missing receipt must never fall back to a fresh POST.
          response = await fetcher(hooks)(ENDPOINT, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody(run, segment)), signal: hooks.signal });
          hooks.assertAccount(); if (!response.ok) throw await errorFrom(response);
        } else { if (query && issue.code === 'NARRATION_NOT_FOUND') issue.details = { stateUncertain: true, definitiveFailure: false, providerSubmitted: true }; throw issue; }
      }
      await saveResult(run, segment, response, hooks);
    } catch (error) {
      // A timeout, reload, malformed result, or failed local save may have followed a paid generation.
      segment.definitiveFailure = !!(error.details && error.details.definitiveFailure === true && error.details.stateUncertain === false);
      segment.status = segment.definitiveFailure ? 'failed' : 'unknown'; segment.code = error.code || 'NARRATION_UNKNOWN'; segment.error = error.message || '配音回执未知，请核对后继续。';
      if (segment.attempts.length) segment.attempts[segment.attempts.length - 1].status = segment.status;
      await persist(run, hooks); throw error;
    }
  }
  function finalAudio(run, planned) {
    var tracks = [], assets = [];
    planned.segments.forEach(function (definition) {
      var segment = run.narrationRuns.find(function (item) { return item.id === definition.id; });
      if (!segment || segment.status !== 'succeeded' || !segment.resultAssetId) throw failure('NARRATION_INCOMPLETE', '还有口播未完成，已生成画面和音轨保留。');
      tracks.push({ id: segment.id, assetId: segment.resultAssetId, role: 'narration', volume: 1, startSeconds: segment.startSeconds, endSeconds: segment.endSeconds, maxDurationSeconds: segment.durationSeconds,
        loop: false, origin: 'script_narration', scriptFingerprint: planned.scriptFingerprint, requestId: segment.requestId });
      assets.push(Object.assign({}, segment.asset, { origin: 'script_narration', scriptFingerprint: planned.scriptFingerprint, requestId: segment.requestId }));
    });
    return { version: 2, origin: 'script_narration', scriptFingerprint: planned.scriptFingerprint, tracks: tracks, assets: assets, sourceAudioVolume: 0 };
  }
  async function ensureRun(run, hooks) {
    hooks = hooks || {}; assertHooks(run, hooks); var planned = initialize(run); await persist(run, hooks);
    if (!planned.required) return finalAudio(run, planned);
    requireVerification();
    if (run.narrationRuns.some(function (segment) { return segment.status === 'pending'; })) { await capabilities({ accountKey: run.accountKey, fetch: hooks.fetch, signal: hooks.signal }); hooks.assertAccount(); }
    for (var i = 0; i < planned.segments.length; i++) { var segment = run.narrationRuns.find(function (item) { return item.id === planned.segments[i].id; }); await executeSegment(run, segment, hooks); }
    return finalAudio(run, planned);
  }
  async function retrySegment(run, id, hooks) {
    hooks = hooks || {}; assertHooks(run, hooks); var planned = initialize(run), segment = run.narrationRuns.find(function (item) { return item.id === id; });
    if (!segment || segment.status !== 'failed' || segment.definitiveFailure !== true) throw failure('NARRATION_RETRY_BLOCKED', '只能单独重试已确认失败的音轨；状态未知时请先核对原回执。');
    await capabilities({ accountKey: run.accountKey, fetch: hooks.fetch, signal: hooks.signal }); hooks.assertAccount();
    segment.status = 'pending'; segment.requestId = ''; segment.error = ''; segment.definitiveFailure = false; await persist(run, hooks);
    await executeSegment(run, segment, hooks); return finalAudio(run, planned);
  }
  return Object.freeze({ buildPlan: buildPlan, fingerprint: fingerprint, capabilities: capabilities, ensureRun: ensureRun, retrySegment: retrySegment });
});
