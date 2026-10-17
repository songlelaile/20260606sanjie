/* eslint-disable @typescript-eslint/no-require-imports -- Server-only CommonJS modules loaded by the Node runtime. */
'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { isIP } = require('node:net');
const { ownerKey, bindingKey } = require('./asset-service.cjs');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const RATIOS = new Set(['9:16', '16:9', '1:1', '3:4', '4:3', '21:9', 'adaptive']);
const MODEL_CAPS = Object.freeze({
  'seedance-2.0': { duration: 15, images: 9, videos: 3, audios: 3, total: 15, resolutions: ['480p', '720p', '1080p', '4k'] },
  'seedance-2.5': { duration: 30, images: 30, videos: 10, audios: 10, total: 50, resolutions: ['480p', '720p', '1080p'] }
});
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
class TaskServiceError extends Error {
  constructor(code, message, details) { super(message); this.name = 'TaskServiceError'; this.code = code; if (details) this.details = details; }
}
function fail(code, message, details) { throw new TaskServiceError(code, message, details); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function plain(value) { return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function identifier(value, label = '编号') {
  if (typeof value !== 'string' || !value || value.length > 240 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) fail('IDENTIFIER_INVALID', `${label}无效。`);
  return value;
}
function scopeOf(input) {
  if (!plain(input)) fail('SCOPE_REQUIRED', '服务端尚未验证当前账号身份。');
  return Object.freeze(Object.fromEntries(['tenantId', 'userId', 'providerAccountId', 'projectName'].map(key => [key, identifier(input[key], key)])));
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!plain(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}
function hash(value) { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(stable(value))).digest('hex'); }
function own(record, scope) { return record && record.ownerKey === ownerKey(scope) && record.bindingKey === bindingKey(scope); }
function checkedState(state) {
  if (!state || state.version !== 1 || !plain(state.tasks)) fail('TASK_STORE_INVALID', '视频任务仓储结构不兼容。');
  if (state.idempotency !== undefined && !plain(state.idempotency)) fail('TASK_STORE_INVALID', '视频任务幂等索引结构不兼容。');
  return state;
}
function taskRecord(state, scope, id) {
  const record = Object.hasOwn(state.tasks, id) ? state.tasks[id] : null;
  if (!own(record, scope)) fail('TASK_NOT_FOUND', '任务不存在或不属于当前账号。');
  return record;
}
function publicTask(record) {
  if (!record) return null;
  return {
    id: record.id, taskId: record.id, status: record.status, phase: record.phase,
    providerTaskId: record.providerTaskId || '', providerState: record.providerState || '',
    model: record.model, watermark: false, resultUrls: [...(record.resultUrls || [])],
    createdAt: record.createdAt, updatedAt: record.updatedAt, submittedAt: record.submittedAt || null,
    finishedAt: record.finishedAt || null, errorCode: record.errorCode || '', error: record.message || '',
    message: record.message || '', stateUncertain: record.status === 'uncertain',
    cancelPending: record.cancelPending === true, leaseReleasePending: record.leaseReleasePending === true
  };
}
function assertKeys(value, allowed, code = 'VIDEO_BODY_INVALID') {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(code, '视频参数包含不支持的字段。');
}
function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) return '';
  try {
    const url = new URL(value), host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || /(^|\.)(localhost|local|internal)$/.test(host)) return '';
    return url.href;
  } catch (_) { return ''; }
}
function audioUrl(value) {
  const remote = httpsUrl(value); if (remote) return remote;
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 80) return '';
  const match = /^data:audio\/(mpeg|mp3|wav|x-wav);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) return '';
  const decoded = Buffer.from(match[2], 'base64');
  return decoded.length > 0 && decoded.length <= MAX_AUDIO_BYTES && decoded.toString('base64') === match[2] ? value : '';
}
function modelChoice(binding, model) {
  if (typeof model !== 'string' || !model || model.length > 220 || /\s/.test(model)) fail('VIDEO_MODEL_INVALID', '视频模型标识无效。');
  const map = plain(binding.providerModels) ? binding.providerModels : {};
  const product = Object.keys(MODEL_CAPS).find(key => map[key] === model);
  const explicit = Array.isArray(binding.allowedModels) && binding.allowedModels.includes(model);
  if (!product && !explicit) fail('VIDEO_MODEL_NOT_BOUND', '该视频模型未绑定到当前供应商账号。');
  const inferred = model.includes('seedance-2-5') ? 'seedance-2.5' : model.includes('seedance-2-0') ? 'seedance-2.0' : '';
  const key = product || inferred;
  if (!MODEL_CAPS[key]) fail('VIDEO_MODEL_CAPABILITIES_REQUIRED', '当前绑定模型缺少可验证的参数规格。');
  return { productKey: key, caps: MODEL_CAPS[key] };
}
function normalizeBody(input, binding) {
  assertKeys(input, ['model', 'content', 'duration', 'resolution', 'ratio', 'generate_audio', 'watermark', 'omni_reference_task_type', 'output_format']);
  const { productKey, caps } = modelChoice(binding, input.model);
  if (!Number.isSafeInteger(input.duration) || input.duration < 4 || input.duration > caps.duration) fail('VIDEO_DURATION_INVALID', '视频时长超出当前模型支持范围。');
  if (!caps.resolutions.includes(input.resolution) || !RATIOS.has(input.ratio)) fail('VIDEO_SPECIFICATION_INVALID', '视频清晰度或比例不受当前模型支持。');
  if (typeof input.generate_audio !== 'boolean') fail('VIDEO_AUDIO_MODE_INVALID', '视频音频开关必须明确设置。');
  if (input.watermark !== undefined && typeof input.watermark !== 'boolean') fail('VIDEO_WATERMARK_INVALID', '水印开关格式无效。');
  if (!Array.isArray(input.content) || !input.content.length || input.content.length > caps.total + 8) fail('VIDEO_CONTENT_INVALID', '视频内容数量无效。');
  const assetIds = [], counts = { images: 0, videos: 0, audios: 0, text: 0 };
  const content = input.content.map(entry => {
    if (!plain(entry)) fail('VIDEO_CONTENT_INVALID', '视频内容格式无效。');
    if (entry.type === 'text') {
      assertKeys(entry, ['type', 'text']);
      if (typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > 32000) fail('VIDEO_TEXT_INVALID', '视频提示词为空或过长。');
      counts.text++; return { type: 'text', text: entry.text };
    }
    if (!['image_url', 'video_url', 'audio_url'].includes(entry.type)) fail('VIDEO_CONTENT_TYPE_INVALID', '视频内容类型不受支持。');
    assertKeys(entry, ['type', entry.type, 'role']); assertKeys(entry[entry.type], ['url']);
    const raw = entry[entry.type].url;
    if (entry.type === 'image_url') {
      if (!['reference_image', 'first_frame', 'last_frame'].includes(entry.role)) fail('VIDEO_IMAGE_ROLE_INVALID', '图片用途无效。');
      const match = typeof raw === 'string' && /^library:\/\/([A-Za-z0-9_-]{1,200})$/.exec(raw);
      if (!match) fail('VIDEO_IMAGE_LIBRARY_REQUIRED', '视频图片必须引用当前账号校验成功的素材库编号。');
      if (!assetIds.includes(match[1])) assetIds.push(match[1]);
      counts.images++; return { type: entry.type, image_url: { url: 'library://' + match[1] }, role: entry.role };
    }
    const expectedRole = entry.type === 'video_url' ? 'reference_video' : 'reference_audio';
    if (entry.role !== expectedRole) fail('VIDEO_MEDIA_ROLE_INVALID', '视频或音频素材用途无效。');
    const url = entry.type === 'audio_url' ? audioUrl(raw) : httpsUrl(raw);
    if (!url) fail('VIDEO_MEDIA_URL_INVALID', '视频只接受公共 HTTPS 链接；音频还可使用不超过 15 MB 的合法音频数据。');
    counts[entry.type === 'audio_url' ? 'audios' : 'videos']++;
    return { type: entry.type, [entry.type]: { url }, role: entry.role };
  });
  if (!counts.text || counts.text > 8 || counts.images > caps.images || counts.videos > caps.videos || counts.audios > caps.audios || counts.images + counts.videos + counts.audios > caps.total) fail('VIDEO_CONTENT_LIMIT', '素材数量超出当前模型支持范围。');
  if (input.omni_reference_task_type !== undefined && (productKey !== 'seedance-2.5' || input.omni_reference_task_type !== 'reference')) fail('VIDEO_REFERENCE_MODE_INVALID', '当前模型不支持该参考模式。');
  if (input.output_format !== undefined && input.output_format !== 'mp4') fail('VIDEO_OUTPUT_FORMAT_INVALID', '视频输出格式仅支持 MP4。');
  const body = { model: input.model, content, duration: input.duration, resolution: input.resolution, ratio: input.ratio, generate_audio: input.generate_audio, watermark: false };
  if (productKey === 'seedance-2.5' && counts.images + counts.videos + counts.audios > 0) body.omni_reference_task_type = 'reference';
  if (productKey === 'seedance-2.5' || input.output_format) body.output_format = 'mp4';
  if (Buffer.byteLength(JSON.stringify(body)) >= MAX_BODY_BYTES) fail('VIDEO_BODY_TOO_LARGE', '视频请求体必须小于 64 MB。');
  return { body, assetIds, productKey };
}
function stableProviderId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{1,239}$/.test(value) ? value : ''; }
function providerStatus(result, expectedId) {
  if (!plain(result) || stableProviderId(result.id) !== expectedId) fail('PROVIDER_TASK_MISMATCH', '供应商返回的任务编号不一致。');
  const status = { queued: 'processing', running: 'processing', processing: 'processing', succeeded: 'succeeded', failed: 'failed', expired: 'failed', cancelled: 'cancelled' }[result.status];
  if (!status) fail('PROVIDER_STATUS_INVALID', '供应商返回了无法核验的任务状态。');
  const urls = status === 'succeeded' && Array.isArray(result.resultUrls) ? result.resultUrls.map(httpsUrl) : [];
  if (status === 'succeeded' && (!urls.length || urls.some(url => !url) || urls.length > 20)) fail('PROVIDER_RESULT_MISSING', '供应商未返回可验证的视频结果。');
  return { status, providerState: result.status, resultUrls: urls };
}

function createTaskService({ repository, assetService, providerResolver, now = Date.now, makeId = randomUUID } = {}) {
  if (!repository || typeof repository.withLock !== 'function' || !assetService || typeof assetService.acquireLease !== 'function' || typeof assetService.releaseLease !== 'function' || !providerResolver || typeof providerResolver.resolve !== 'function') fail('TASK_SERVICE_CONFIGURATION_REQUIRED', '视频任务服务缺少持久仓储、素材服务或供应商绑定。');
  async function safe(work) {
    try { return await work(); }
    catch (error) { if (error instanceof TaskServiceError) throw error; fail('TASK_SERVICE_UNAVAILABLE', '视频任务服务暂时不可用；请按原请求编号核对状态，不要重复提交。'); }
  }
  async function resolve(input) {
    const scope = scopeOf(input);
    let binding;
    try { binding = await providerResolver.resolve(scope); } catch (_) { fail('PROVIDER_BINDING_UNAVAILABLE', '无法读取当前账号的视频供应商绑定。'); }
    if (!binding || binding.enabled !== true || !['tenant', 'platform'].includes(binding.mode)) fail('PROVIDER_BINDING_REQUIRED', '当前账号尚未开通视频生成服务。');
    if (binding.providerAccountId !== scope.providerAccountId || binding.projectName !== scope.projectName) fail('PROVIDER_BINDING_CHANGED', '视频供应商账号或项目已变化。');
    if (!binding.provider || ['videoCreate', 'videoGet', 'videoCancel'].some(key => typeof binding.provider[key] !== 'function')) fail('PROVIDER_VIDEO_NOT_READY', '供应商视频接口尚未配置完成。');
    return { scope, binding };
  }
  async function locked(scope, work) {
    // This lock is deliberately disjoint from the asset account lock. A video
    // checkpoint may acquire/release a lease without nesting the same pg lock.
    return repository.withLock('video:' + scope.providerAccountId, raw => work(fn => raw.transaction(state => fn(checkedState(state)))));
  }
  function idemKey(scope, value) { return hash([ownerKey(scope), bindingKey(scope), identifier(value, '幂等请求编号')]); }
  async function release(tx, scope, record) {
    if (!TERMINAL.has(record.status) || !record.assetIds.length || record.leaseState === 'none' || record.leaseState === 'released') return record;
    let released = false;
    try {
      const result = await assetService.releaseLease(scope, { taskId: record.id, terminalStatus: record.status });
      released = !!(result && result.released === true);
    } catch (error) {
      // A checkpoint interrupted before claim may not have acquired any lease.
      // The asset service's owner-scoped lookup can authoritatively confirm that.
      if (error && error.code === 'TASK_NOT_FOUND' && record.submissionState === 'not_started') released = true;
      // Otherwise keep protection until a later terminal read can release it.
    }
    return tx(state => {
      const task = taskRecord(state, scope, record.id);
      task.leaseReleasePending = !released; if (released) task.leaseState = 'released';
      return structuredClone(task);
    });
  }
  async function failBeforeSubmit(tx, scope, id, code) {
    const record = await tx(state => {
      const task = taskRecord(state, scope, id); task.status = 'failed'; task.phase = 'asset_preparing'; task.errorCode = code;
      task.message = '图片素材尚未通过审核或不属于当前账号，视频未提交。'; task.finishedAt = now(); task.updatedAt = now(); task.leaseState = 'none';
      return structuredClone(task);
    });
    return { task: publicTask(record), idempotent: false };
  }
  async function create(inputScope, { idempotencyKey, body: inputBody } = {}) {
    return safe(async () => {
      const { scope, binding } = await resolve(inputScope), normalized = normalizeBody(inputBody, binding);
      const key = idemKey(scope, idempotencyKey), requestHash = hash(normalized.body);
      return locked(scope, async tx => {
        const checkpoint = await tx(state => {
          if (!state.idempotency) state.idempotency = {};
          const previousId = Object.hasOwn(state.idempotency, key) ? state.idempotency[key] : null;
          if (previousId) {
            const record = taskRecord(state, scope, previousId);
            if (record.requestHash !== requestHash) fail('IDEMPOTENCY_CONFLICT', '同一请求编号已绑定不同视频参数。');
            return { existing: true, record: structuredClone(record) };
          }
          const id = 'vt_' + makeId();
          if (!/^vt_[A-Za-z0-9_-]{1,180}$/.test(id) || Object.hasOwn(state.tasks, id)) fail('TASK_ID_INVALID', '视频任务编号生成失败。');
          const timestamp = now();
          const record = { id, ownerKey: ownerKey(scope), bindingKey: bindingKey(scope), model: normalized.body.model,
            productKey: normalized.productKey, requestHash, idempotencyHash: key, status: 'queued', phase: 'asset_preparing',
            assetIds: normalized.assetIds, leaseState: normalized.assetIds.length ? 'acquiring' : 'none', submissionState: 'not_started',
            providerTaskId: '', resultUrls: [], createdAt: timestamp, updatedAt: timestamp, body: normalized.body };
          state.tasks[id] = record; state.idempotency[key] = id;
          return { existing: false, record: structuredClone(record) };
        });
        let record = checkpoint.record;
        if (checkpoint.existing) {
          if (record.status === 'queued' && record.submissionState === 'not_started') record = await interruptBeforeSubmit(tx, scope, record.id);
          if (record.submissionState === 'claimed' && !record.providerTaskId && !TERMINAL.has(record.status)) record = await markUncertain(tx, scope, record.id);
          if (TERMINAL.has(record.status)) record = await release(tx, scope, record);
          return { task: publicTask(record), idempotent: true };
        }
        let references = [];
        if (record.assetIds.length) {
          try {
            const lease = await assetService.acquireLease(scope, { taskId: record.id, assetIds: record.assetIds });
            if (!lease || !Array.isArray(lease.references) || lease.references.length !== record.assetIds.length) fail('ASSET_LEASE_INVALID', '素材引用未完整取得，视频未提交。');
            references = lease.references;
          } catch (error) {
            if (['ASSET_NOT_FOUND', 'ASSET_NOT_ACTIVE', 'LEASE_ASSETS_INVALID', 'TASK_LEASE_CONFLICT'].includes(error && error.code)) return failBeforeSubmit(tx, scope, record.id, error.code);
            record = await markUncertain(tx, scope, record.id, 'ASSET_LEASE_UNCERTAIN', '素材保护状态未确认，视频未提交；请核对后继续。');
            return { task: publicTask(record), idempotent: false };
          }
        }
        const referenceMap = new Map(references.map(reference => [reference.id, reference.url]));
        if (referenceMap.size !== record.assetIds.length || record.assetIds.some(id => !/^asset:\/\/[A-Za-z0-9_-]{1,240}$/.test(referenceMap.get(id) || ''))) {
          record = await tx(state => { const task = taskRecord(state, scope, record.id); task.status = 'failed'; task.errorCode = 'ASSET_LEASE_INVALID'; task.message = '素材引用校验失败，视频未提交。'; task.leaseState = 'acquired'; task.updatedAt = now(); task.finishedAt = now(); return structuredClone(task); });
          return { task: publicTask(await release(tx, scope, record)), idempotent: false };
        }
        const providerBody = structuredClone(normalized.body);
        providerBody.content.forEach(entry => { if (entry.type === 'image_url') entry.image_url.url = referenceMap.get(entry.image_url.url.slice('library://'.length)); });
        // Committed before the only chargeable upstream operation. A restarted
        // process observes 'claimed' and never calls videoCreate again.
        record = await tx(state => {
          const task = taskRecord(state, scope, record.id);
          task.leaseState = task.assetIds.length ? 'acquired' : 'none'; task.references = structuredClone(references);
          task.providerBody = providerBody; task.submissionState = 'claimed'; task.status = 'submitting';
          task.phase = 'provider_create'; task.claimedAt = now(); task.updatedAt = now(); return structuredClone(task);
        });
        try {
          const result = await binding.provider.videoCreate({ scope, body: providerBody, idempotencyKey: record.id });
          const providerTaskId = stableProviderId(result && result.id);
          if (!providerTaskId) fail('PROVIDER_TASK_ID_MISSING', '供应商未返回稳定任务编号。');
          record = await tx(state => {
            const task = taskRecord(state, scope, record.id); task.providerTaskId = providerTaskId; task.status = 'processing';
            task.providerState = ['queued', 'running', 'processing'].includes(result.status) ? result.status : '';
            task.submissionState = 'accepted'; task.phase = 'provider_processing'; task.submittedAt = now(); task.updatedAt = now(); return structuredClone(task);
          });
        } catch (error) {
          if (error && error.accepted === false) {
            record = await tx(state => { const task = taskRecord(state, scope, record.id); task.status = 'failed'; task.phase = 'failed'; task.submissionState = 'rejected'; task.errorCode = 'PROVIDER_CREATE_REJECTED'; task.message = '视频供应商明确拒绝本次请求，未自动重试。'; task.finishedAt = now(); task.updatedAt = now(); return structuredClone(task); });
            record = await release(tx, scope, record);
          } else record = await markUncertain(tx, scope, record.id);
        }
        return { task: publicTask(record), idempotent: false };
      });
    });
  }
  async function markUncertain(tx, scope, id, code = 'PROVIDER_CREATE_UNCERTAIN', message = '视频创建结果尚未确认，已保留素材保护并停止自动重试。') {
    return tx(state => { const task = taskRecord(state, scope, id); task.status = 'uncertain'; task.phase = 'submission_uncertain'; task.errorCode = code; task.message = message; task.updatedAt = now(); return structuredClone(task); });
  }
  async function interruptBeforeSubmit(tx, scope, id) {
    return tx(state => {
      const task = taskRecord(state, scope, id);
      // withLock spans the complete original create. Re-entering this checkpoint
      // proves its process stopped before the committed provider claim.
      if (task.status === 'queued' && task.submissionState === 'not_started' && !task.providerTaskId) {
        task.status = 'failed'; task.phase = 'failed'; task.errorCode = 'TASK_INTERRUPTED_BEFORE_SUBMIT';
        task.message = '任务在向视频供应商提交前中断，视频未提交；可重新生成。'; task.finishedAt = now(); task.updatedAt = now();
      }
      return structuredClone(task);
    });
  }
  async function persistStatus(tx, scope, id, result) {
    return tx(state => {
      const task = taskRecord(state, scope, id), next = providerStatus(result, task.providerTaskId);
      task.status = next.status; task.providerState = next.providerState; task.resultUrls = next.resultUrls;
      task.phase = TERMINAL.has(next.status) ? next.status : 'provider_processing'; task.updatedAt = now();
      task.errorCode = next.status === 'failed' ? 'PROVIDER_TASK_FAILED' : ''; task.message = next.status === 'failed' ? '供应商确认视频生成失败。' : '';
      if (TERMINAL.has(task.status)) { task.finishedAt = now(); task.cancelPending = false; }
      return structuredClone(task);
    });
  }
  async function get(inputScope, { id } = {}) {
    return safe(async () => {
      const { scope, binding } = await resolve(inputScope); identifier(id, '视频任务编号');
      return locked(scope, async tx => {
        let record = await tx(state => structuredClone(taskRecord(state, scope, id)));
        if (TERMINAL.has(record.status)) return { task: publicTask(await release(tx, scope, record)) };
        if (!record.providerTaskId) {
          if (record.status === 'queued' && record.submissionState === 'not_started') record = await interruptBeforeSubmit(tx, scope, id);
          if (record.submissionState === 'claimed') record = await markUncertain(tx, scope, id);
          return { task: publicTask(await release(tx, scope, record)) };
        }
        let result;
        try { result = await binding.provider.videoGet({ scope, id: record.providerTaskId }); }
        catch (_) { fail('PROVIDER_STATUS_UNAVAILABLE', '暂时无法核验视频状态，原任务和素材保护保持不变。', { task: publicTask(record) }); }
        record = await persistStatus(tx, scope, id, result);
        return { task: publicTask(await release(tx, scope, record)) };
      });
    });
  }
  async function findByKey(inputScope, { idempotencyKey } = {}) {
    return safe(async () => {
      const scope = scopeOf(inputScope), key = idemKey(scope, idempotencyKey);
      return locked(scope, tx => tx(state => {
        const index = state.idempotency || {};
        const id = Object.hasOwn(index, key) ? index[key] : null;
        return { task: id ? publicTask(taskRecord(state, scope, id)) : null };
      }));
    });
  }
  async function cancel(inputScope, { id } = {}) {
    return safe(async () => {
      const { scope, binding } = await resolve(inputScope); identifier(id, '视频任务编号');
      return locked(scope, async tx => {
        let record = await tx(state => structuredClone(taskRecord(state, scope, id)));
        if (TERMINAL.has(record.status)) return { task: publicTask(await release(tx, scope, record)), idempotent: true };
        if (!record.providerTaskId) {
          if (record.status !== 'queued' || record.submissionState !== 'not_started') fail('CANCEL_CREATE_UNCERTAIN', '供应商受理状态尚未确认，不能将该任务标记为已取消。', { task: publicTask(record) });
          record = await tx(state => { const task = taskRecord(state, scope, id); task.status = 'cancelled'; task.phase = 'cancelled'; task.finishedAt = now(); task.updatedAt = now(); return structuredClone(task); });
          return { task: publicTask(await release(tx, scope, record)), idempotent: false };
        }
        let current;
        try { current = await binding.provider.videoGet({ scope, id: record.providerTaskId }); }
        catch (_) { fail('PROVIDER_STATUS_UNAVAILABLE', '无法核验供应商排队状态，取消未提交。', { task: publicTask(record) }); }
        record = await persistStatus(tx, scope, id, current);
        if (TERMINAL.has(record.status)) return { task: publicTask(await release(tx, scope, record)), idempotent: true };
        if (current.status !== 'queued') fail('CANCEL_STATE_UNSUPPORTED', '供应商只允许取消排队中的任务；当前任务已开始生成。', { task: publicTask(record) });
        await tx(state => { const task = taskRecord(state, scope, id); task.cancelPending = true; task.phase = 'provider_cancel'; task.updatedAt = now(); });
        let confirmation;
        try { confirmation = await binding.provider.videoCancel({ scope, id: record.providerTaskId }); } catch (_) {}
        if (!confirmation || confirmation.cancelled !== true || confirmation.verified !== true || confirmation.id && confirmation.id !== record.providerTaskId) {
          const retained = await tx(state => structuredClone(taskRecord(state, scope, id)));
          fail('PROVIDER_CANCEL_UNVERIFIED', '供应商尚未确认取消，任务与素材保护保持不变。', { task: publicTask(retained) });
        }
        record = await tx(state => { const task = taskRecord(state, scope, id); task.status = 'cancelled'; task.providerState = 'cancelled'; task.phase = 'cancelled'; task.cancelPending = false; task.finishedAt = now(); task.updatedAt = now(); return structuredClone(task); });
        return { task: publicTask(await release(tx, scope, record)), idempotent: false };
      });
    });
  }
  return Object.freeze({ create, get, findByKey, cancel });
}

module.exports = { createTaskService, TaskServiceError, normalizeBody, publicTask, httpsUrl, MAX_AUDIO_BYTES, MAX_BODY_BYTES };
