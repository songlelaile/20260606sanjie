/* eslint-disable @typescript-eslint/no-require-imports -- Server-only CommonJS modules loaded by the Node runtime. */
'use strict';

const { createHash, randomUUID } = require('node:crypto');

const AUTOMATIC_LIMIT = 50;
const BOUND_LIMIT = 50;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const LIVE_STATES = new Set(['creating', 'processing', 'active', 'rejected', 'create_uncertain', 'deleting', 'delete_failed']);

class AssetError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AssetError';
    this.code = code;
    if (details) this.details = details;
  }
}
function fail(code, message, details) { throw new AssetError(code, message, details); }
function clone(value) { return structuredClone(value); }
function text(value, max = 240) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function identifier(value, name) {
  const out = text(value);
  if (!out || /[\u0000-\u001f\u007f]/.test(out)) fail('SCOPE_INVALID', `缺少有效的 ${name}。`);
  return out;
}
function scopeOf(input) {
  if (!input || typeof input !== 'object') fail('SCOPE_REQUIRED', '服务端尚未验证账号身份。');
  return Object.freeze({
    tenantId: identifier(input.tenantId, 'tenantId'),
    userId: identifier(input.userId, 'userId'),
    providerAccountId: identifier(input.providerAccountId, 'providerAccountId'),
    projectName: identifier(input.projectName, 'projectName')
  });
}
function bindingKey(scope) { return JSON.stringify([scope.providerAccountId, scope.projectName]); }
function providerLockKey(scope) { return JSON.stringify([scope.providerAccountId]); }
function ownerKey(scope) { return JSON.stringify([scope.tenantId, scope.userId]); }
function freshState() { return { version: 1, records: {}, tasks: {} }; }
function assertState(state) {
  if (!state || state.version !== 1 || !state.records || !state.tasks) fail('ASSET_STORE_INVALID', '素材数据库版本或结构不兼容。');
  return state;
}
function owned(record, scope) { return record && record.ownerKey === ownerKey(scope) && record.bindingKey === bindingKey(scope); }
function ownedRecord(state, scope, id) {
  const record = state.records[text(id)];
  if (!owned(record, scope) || record.status === 'deleted') fail('ASSET_NOT_FOUND', '素材不存在或不属于当前账号。');
  return record;
}
function live(record) { return LIVE_STATES.has(record.status); }
function usesCloud(record) { return live(record) && record.providerCreationRejected !== true; }
function ownLive(state, scope) { return Object.values(state.records).filter(record => owned(record, scope) && live(record)); }
function leased(state, id) { return Object.values(state.tasks).some(task => !task.terminal && task.assetIds.includes(id)); }
function publicAsset(record, state) {
  return {
    id: record.id, name: record.name, sha256: record.sha256, mime: record.mime, size: record.size,
    bound: record.bound, pool: record.bound ? 'bound' : 'automatic', status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt,
    canUse: record.status === 'active', inUse: leased(state, record.id),
    errorCode: record.errorCode || '', message: record.message || ''
  };
}
function normalizeProviderRecord(value) {
  if (!value || typeof value !== 'object') fail('PROVIDER_RESPONSE_INVALID', '素材供应商返回格式无效。');
  if (value.notFound === true && value.verified === true) return { missing: true };
  const id = text(value.id);
  if (!id) fail('PROVIDER_ASSET_ID_MISSING', '素材供应商未返回稳定素材 ID。');
  const status = { Active: 'active', Processing: 'processing', Failed: 'rejected' }[value.status];
  if (!status) fail('PROVIDER_STATUS_INVALID', '素材供应商返回了未知审核状态。');
  return { id, status, sourceId: text(value.sourceId), message: status === 'rejected' ? '素材审核未通过，请检查图片后重新选择。' : '' };
}
function normalizeImage(input) {
  if (!input || !(Buffer.isBuffer(input.bytes) || input.bytes instanceof Uint8Array)) fail('IMAGE_REQUIRED', '请上传图片字节。');
  const bytes = Buffer.from(input.bytes);
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) fail('IMAGE_SIZE_INVALID', '单张送审图片须大于 0 且不超过 20 MB。');
  const mime = text(input.mime || input.mimeType, 80).toLowerCase();
  const detected = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
    : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : '';
  if (!detected || detected !== mime) fail('IMAGE_MIME_INVALID', '图片文件内容与类型不一致，仅支持 PNG、JPEG、WebP。');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (input.sha256 && text(input.sha256, 64).toLowerCase() !== sha256) fail('IMAGE_HASH_MISMATCH', '上传图片校验不一致，请重新选择原图。');
  return { bytes, mime, sha256, size: bytes.length, name: text(input.name, 64) || '视频参考图片' };
}

/**
 * This core is server-only. The HTTP adapter must derive scope from a verified
 * session and current database rows, never from request JSON or query strings.
 *
 * repository.withLock(providerLockKey, work) holds a cross-process provider account
 * lock. work receives { transaction(fn) }; each transaction atomically commits
 * a mutable state snapshot. Separate commits before external calls are required:
 * an interrupted provider create remains 'creating', so it cannot be retried.
 * In-memory locking is suitable for tests only, not a production deployment.
 */
function createAssetService({ repository, providerResolver, now = Date.now, makeId = randomUUID } = {}) {
  if (!repository || typeof repository.withLock !== 'function') fail('REPOSITORY_REQUIRED', '素材服务需要持久化事务仓储。');
  if (!providerResolver || typeof providerResolver.resolve !== 'function') fail('PROVIDER_BINDING_REQUIRED', '素材服务尚未绑定供应商账号。');

  async function resolve(input) {
    const scope = scopeOf(input);
    const binding = await providerResolver.resolve(scope);
    if (!binding || binding.enabled !== true || !['tenant', 'platform'].includes(binding.mode)) fail('PROVIDER_BINDING_REQUIRED', '当前账号尚未开通素材自动送审服务。');
    if (binding.providerAccountId !== scope.providerAccountId || binding.projectName !== scope.projectName) fail('PROVIDER_BINDING_CHANGED', '素材供应商账号或项目已变化，请刷新后重试。');
    if (!binding.provider || ['create', 'get', 'delete'].some(key => typeof binding.provider[key] !== 'function')) fail('PROVIDER_NOT_READY', '素材供应商适配器尚未配置完成。');
    const limit = Number(binding.quota && binding.quota.limit);
    const externalUsed = Number(binding.quota && binding.quota.externalUsed);
    if (!Number.isSafeInteger(limit) || limit < 1 || !binding.quota || binding.quota.externalUsed == null || !Number.isSafeInteger(externalUsed) || externalUsed < 0) {
      fail('PROVIDER_QUOTA_UNKNOWN', '请先核对并配置云素材总配额及现有外部素材占用。');
    }
    const createQpm = binding.createQpm == null ? 3 : Number(binding.createQpm);
    if (!Number.isSafeInteger(createQpm) || createQpm < 1) fail('PROVIDER_QUOTA_UNKNOWN', '素材创建频率配额配置无效。');
    return { scope, binding, quota: { limit, externalUsed }, createQpm };
  }

  async function locked(input, work) {
    const context = await resolve(input);
    return repository.withLock(providerLockKey(context.scope), async raw => {
      if (!raw || typeof raw.transaction !== 'function') fail('REPOSITORY_TRANSACTION_REQUIRED', '素材仓储不支持持久化事务。');
      const tx = fn => raw.transaction(state => fn(assertState(state)));
      return work({ ...context, tx });
    });
  }

  function firstVictim(state, scope, excludedId) {
    return ownLive(state, scope)
      .filter(record => record.id !== excludedId && record.bound === false && !leased(state, record.id)
        && (record.providerAssetId || record.providerCreationRejected) && ['active', 'processing', 'rejected'].includes(record.status))
      .sort((a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence || a.id.localeCompare(b.id))[0];
  }

  async function deleteRecord(context, id, { allowBound = false } = {}) {
    const { tx, scope, binding } = context;
    const record = await tx(state => {
      const item = ownedRecord(state, scope, id);
      if (item.bound && !allowBound) fail('BOUND_ASSET_PROTECTED', '绑定素材不会自动删除，请先取消绑定。');
      if (leased(state, id)) fail('ASSET_IN_USE', '素材正在被未结束的视频任务使用，暂时不能删除。');
      if (!item.providerAssetId && !item.providerCreationRejected) fail('ASSET_CREATE_UNCERTAIN', '素材创建结果尚未确认，不能清除记录或自动重新送审。');
      item.status = 'deleting'; item.updatedAt = now();
      return clone(item);
    });
    let confirmed = record.providerCreationRejected === true;
    let temporarilyUnpinned = false;
    try { if (!confirmed) {
      if (record.bound && allowBound && record.sourceId && typeof binding.provider.setPinned === 'function') {
        await binding.provider.setPinned({ scope, sourceId: record.sourceId, pinned: false });
        temporarilyUnpinned = true;
      }
      const result = await binding.provider.delete({ scope, id: record.providerAssetId, sourceId: record.sourceId });
      confirmed = !!(result && result.deleted === true && result.verified === true);
      if (confirmed && result.sourceCleanupPending) record.sourceCleanupPending = true;
    } } catch (_) { /* Persist the uncertain deletion below; do not erase history. */ }
    if (!confirmed && temporarilyUnpinned) {
      try { await binding.provider.setPinned({ scope, sourceId: record.sourceId, pinned: true }); }
      catch (_) { record.sourcePinRestorePending = true; }
    }
    const result = await tx(state => {
      const item = ownedRecord(state, scope, id);
      item.status = confirmed ? 'deleted' : 'delete_failed';
      item.sourceCleanupPending = record.sourceCleanupPending === true;
      item.sourcePinRestorePending = record.sourcePinRestorePending === true;
      item.updatedAt = now();
      item.errorCode = confirmed ? '' : 'PROVIDER_DELETE_UNVERIFIED';
      item.message = confirmed ? '' : '云素材删除尚未核验，已保留记录并停止继续上传。';
      return publicAsset(item, state);
    });
    if (!confirmed) fail('PROVIDER_DELETE_UNVERIFIED', result.message, { asset: result });
    return result;
  }

  async function makeRoom(context, { increaseCloud, excludeId } = {}) {
    for (;;) {
      const plan = await context.tx(state => {
        const ownedAutomatic = ownLive(state, context.scope).filter(record => !record.bound && record.id !== excludeId).length;
        const trackedCloud = Object.values(state.records).filter(usesCloud).length;
        const autoFull = ownedAutomatic >= AUTOMATIC_LIMIT;
        const cloudFull = increaseCloud && trackedCloud + context.quota.externalUsed >= context.quota.limit;
        if (!autoFull && !cloudFull) return { ready: true };
        // Prove this scope alone can free enough capacity before deleting anything.
        // A larger external/other-tenant reservation must not drain this user's pool.
        const candidates = ownLive(state, context.scope).filter(record => record.id !== excludeId && !record.bound && !leased(state, record.id)
          && (record.providerAssetId || record.providerCreationRejected) && ['active', 'processing', 'rejected'].includes(record.status));
        const cloudNeeded = increaseCloud ? Math.max(0, trackedCloud + context.quota.externalUsed + 1 - context.quota.limit) : 0;
        if (candidates.filter(usesCloud).length < cloudNeeded) fail('PROVIDER_QUOTA_FULL', '云素材容量不足，当前账号可清理素材也无法释放足够容量，已保留全部素材。');
        const victim = firstVictim(state, context.scope, excludeId);
        if (!victim) fail(cloudFull ? 'PROVIDER_QUOTA_FULL' : 'AUTOMATIC_POOL_FULL', cloudFull
          ? '云素材容量已满，当前账号没有可自动清理的素材；其他账号及绑定素材均已保留。'
          : '自动素材池已满，现有素材仍在使用或送审状态待确认，请稍后重试。');
        return { id: victim.id };
      });
      if (plan.ready) return;
      await deleteRecord(context, plan.id);
    }
  }

  async function ingest(inputScope, input) {
    const image = normalizeImage(input);
    return locked(inputScope, async context => {
      const existing = await context.tx(state => {
        const record = ownLive(state, context.scope).find(item => item.sha256 === image.sha256);
        return record ? publicAsset(record, state) : null;
      });
      if (existing) return { asset: existing, deduplicated: true };
      function checkRate(state, timestamp) {
        const attempts = (state.createAttempts || []).filter(at => Number.isFinite(at) && at > timestamp - 60000);
        if (attempts.length >= context.createQpm) {
          const error = new AssetError('ASSET_RATE_LIMIT', '方舟送审频率已达到限制，请稍后查看审核进度。');
          error.accepted = false;
          error.details = { retryAfterMs: Math.max(1, Math.min(...attempts) + 60000 - timestamp) };
          throw error;
        }
        return attempts;
      }
      // Reject the fourth Entry submission before even planning a FIFO deletion.
      // The provider-account lock also serializes attempts across all projects.
      await context.tx(state => { checkRate(state, now()); });
      await makeRoom(context, { increaseCloud: true });
      const id = 'va_' + makeId();
      await context.tx(state => {
        if (state.records[id]) fail('ASSET_ID_COLLISION', '素材编号冲突，请稍后重试。');
        const timestamp = now();
        state.createAttempts = [...checkRate(state, timestamp), timestamp];
        state.records[id] = {
          id, bindingKey: bindingKey(context.scope), ownerKey: ownerKey(context.scope),
          tenantId: context.scope.tenantId, userId: context.scope.userId,
          name: image.name, mime: image.mime, sha256: image.sha256, size: image.size,
          sequence: Object.keys(state.records).length + 1,
          status: 'creating', bound: false, providerAssetId: '',
          createdAt: timestamp, updatedAt: timestamp, errorCode: '', message: ''
        };
      });
      let result;
      try {
        result = normalizeProviderRecord(await context.binding.provider.create({
          scope: context.scope, assetId: id, name: image.name, mime: image.mime,
          bytes: image.bytes, sha256: image.sha256
        }));
        if (result.missing) fail('PROVIDER_CREATE_INVALID', '素材供应商未确认创建结果。');
      } catch (error) {
        const asset = await context.tx(state => {
          const record = ownedRecord(state, context.scope, id);
          // Only an adapter's authoritative rejection may assert no remote asset.
          // Such records still deduplicate until the user explicitly resolves them.
          record.status = error && error.accepted === false ? 'rejected' : 'create_uncertain';
          record.providerCreationRejected = error && error.accepted === false;
          record.errorCode = record.status === 'rejected' ? 'PROVIDER_CREATE_REJECTED' : 'PROVIDER_CREATE_UNCERTAIN';
          record.message = record.status === 'rejected' ? '素材供应商拒绝了本次上传，未自动重试。' : '素材创建结果尚未确认，已停止自动重试以避免重复上传。';
          record.updatedAt = now();
          return publicAsset(record, state);
        });
        fail(asset.errorCode, asset.message, { asset });
      }
      return context.tx(state => {
        const record = ownedRecord(state, context.scope, id);
        record.providerAssetId = result.id; record.status = result.status; record.sourceId = result.sourceId;
        record.message = result.message; record.updatedAt = now();
        record.errorCode = result.status === 'rejected' ? 'ASSET_REVIEW_FAILED' : '';
        return { asset: publicAsset(record, state), deduplicated: false };
      });
    });
  }

  async function list(inputScope) {
    return locked(inputScope, async context => {
      const pending = await context.tx(state => Object.values(state.records).filter(record => owned(record, context.scope)
        && record.sourceId && (record.sourceCleanupPending || record.sourcePinRestorePending)).map(clone));
      for (const record of pending) {
        try {
          if (record.sourceCleanupPending && record.status === 'deleted' && typeof context.binding.provider.cleanupSource === 'function') {
            await context.binding.provider.cleanupSource({ scope: context.scope, sourceId: record.sourceId });
            await context.tx(state => { state.records[record.id].sourceCleanupPending = false; });
          }
          if (record.sourcePinRestorePending && record.bound && typeof context.binding.provider.setPinned === 'function') {
            await context.binding.provider.setPinned({ scope: context.scope, sourceId: record.sourceId, pinned: true });
            await context.tx(state => { state.records[record.id].sourcePinRestorePending = false; });
          }
        } catch (_) { /* Persist receipts for a later local-only retry. */ }
      }
      return context.tx(state => ({
        assets: ownLive(state, context.scope).sort((a, b) => b.createdAt - a.createdAt || b.sequence - a.sequence).map(record => publicAsset(record, state)),
        limits: { automatic: AUTOMATIC_LIMIT, bound: BOUND_LIMIT, cloudTotal: context.quota.limit,
          automaticUsed: ownLive(state, context.scope).filter(record => !record.bound).length,
          boundUsed: ownLive(state, context.scope).filter(record => record.bound).length }
      }));
    });
  }

  async function refresh(inputScope, id) {
    return locked(inputScope, async context => {
      const record = await context.tx(state => clone(ownedRecord(state, context.scope, id)));
      if (!record.providerAssetId) return context.tx(state => publicAsset(ownedRecord(state, context.scope, id), state));
      let result;
      try { result = normalizeProviderRecord(await context.binding.provider.get({ scope: context.scope, id: record.providerAssetId })); }
      catch (_) { fail('PROVIDER_STATUS_UNAVAILABLE', '暂时无法核验云素材状态，已保留当前记录。'); }
      if (result.id && result.id !== record.providerAssetId) fail('PROVIDER_ASSET_MISMATCH', '供应商返回的素材 ID 不一致。');
      return context.tx(state => {
        const item = ownedRecord(state, context.scope, id);
        if (result.missing) {
          if (item.bound || leased(state, id)) { item.status = 'rejected'; item.errorCode = 'ASSET_REMOTE_MISSING'; item.message = '云素材已不存在，绑定或任务引用记录仍已保留，请检查。'; }
          else { item.status = 'deleted'; item.errorCode = ''; item.message = ''; }
        } else {
          item.status = result.status; item.message = result.message;
          item.errorCode = result.status === 'rejected' ? 'ASSET_REVIEW_FAILED' : '';
        }
        item.updatedAt = now();
        return publicAsset(item, state);
      });
    });
  }

  async function setBound(inputScope, id, bound) {
    if (typeof bound !== 'boolean') fail('BOUND_VALUE_INVALID', '绑定状态必须为布尔值。');
    return locked(inputScope, async context => {
      const current = await context.tx(state => {
        const record = ownedRecord(state, context.scope, id);
        if (record.bound === bound) return { unchanged: true, asset: publicAsset(record, state) };
        if (bound && ownLive(state, context.scope).filter(item => item.bound).length >= BOUND_LIMIT) fail('BOUND_POOL_FULL', '绑定素材最多 50 张，请先取消其他素材的绑定。');
        return { unchanged: false, sourceId: record.sourceId };
      });
      if (current.unchanged) return current.asset;
      if (!bound) await makeRoom(context, { increaseCloud: false, excludeId: id });
      if (current.sourceId && typeof context.binding.provider.setPinned === 'function') {
        // If a source cannot be protected, do not publish a successful binding.
        await context.binding.provider.setPinned({ scope: context.scope, sourceId: current.sourceId, pinned: bound });
      }
      return context.tx(state => {
        const record = ownedRecord(state, context.scope, id);
        record.bound = bound; record.updatedAt = now();
        return publicAsset(record, state);
      });
    });
  }

  async function remove(inputScope, id) {
    return locked(inputScope, context => deleteRecord(context, id, { allowBound: true }));
  }

  async function preview(inputScope, id) {
    return locked(inputScope, async context => {
      const record = await context.tx(state => clone(ownedRecord(state, context.scope, id)));
      if (!record.sourceId || typeof context.binding.provider.preview !== 'function') return { previewUrl: '' };
      const result = await context.binding.provider.preview({ scope: context.scope, sourceId: record.sourceId });
      let url;
      try { url = new URL(result && result.previewUrl); } catch (_) { return { previewUrl: '' }; }
      if (url.protocol !== 'https:' || url.username || url.password) return { previewUrl: '' };
      return { previewUrl: url.href };
    });
  }

  async function acquireLease(inputScope, { taskId, assetIds } = {}) {
    taskId = identifier(taskId, 'taskId');
    if (!Array.isArray(assetIds) || !assetIds.length || assetIds.length > 50 || new Set(assetIds).size !== assetIds.length) fail('LEASE_ASSETS_INVALID', '任务素材引用不能为空或重复。');
    return locked(inputScope, context => context.tx(state => {
      const previous = state.tasks[taskId];
      if (previous) {
        if (previous.ownerKey !== ownerKey(context.scope) || previous.bindingKey !== bindingKey(context.scope) || previous.terminal || JSON.stringify(previous.assetIds) !== JSON.stringify(assetIds)) fail('TASK_LEASE_CONFLICT', '任务编号已绑定其他素材或已结束。');
      }
      const records = assetIds.map(id => ownedRecord(state, context.scope, id));
      if (records.some(record => record.status !== 'active' || !record.providerAssetId)) fail('ASSET_NOT_ACTIVE', '所有图片审核成功后才可生成视频。');
      state.tasks[taskId] = previous || { taskId, ownerKey: ownerKey(context.scope), bindingKey: bindingKey(context.scope), assetIds: [...assetIds], terminal: false, createdAt: now() };
      // This return value is internal to the video service. Do not return raw Ark
      // references to a public list endpoint or accept them back from the client.
      return { taskId, references: records.map(record => ({ id: record.id, url: 'asset://' + record.providerAssetId })) };
    }));
  }

  async function releaseLease(inputScope, { taskId, terminalStatus } = {}) {
    if (!['succeeded', 'failed', 'cancelled', 'rejected_before_submit'].includes(terminalStatus)) fail('TASK_NOT_TERMINAL', '任务未确认结束，素材引用不能释放。');
    return locked(inputScope, context => context.tx(state => {
      const task = state.tasks[text(taskId)];
      if (!task || task.ownerKey !== ownerKey(context.scope) || task.bindingKey !== bindingKey(context.scope)) fail('TASK_NOT_FOUND', '任务不存在或不属于当前账号。');
      task.terminal = true; task.terminalStatus = terminalStatus; task.finishedAt = now();
      return { taskId: task.taskId, released: true };
    }));
  }

  return Object.freeze({ ingest, list, refresh, setBound, remove, preview, acquireLease, releaseLease });
}

module.exports = { createAssetService, AssetError, freshState, bindingKey, providerLockKey, ownerKey, AUTOMATIC_LIMIT, BOUND_LIMIT, MAX_IMAGE_BYTES };
