/* eslint-disable @typescript-eslint/no-require-imports -- Server-only CommonJS modules loaded by the Node runtime. */
'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const { scopeKey, validateImage } = require('./source-store.cjs');

const ENDPOINT = 'https://ark.cn-beijing.volcengineapi.com/';
const VERSION = '2024-01-01';
const VIDEO_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks';
const ASSET_ID = /^asset-[A-Za-z0-9-]{1,120}$/;
const TASK_ID = /^cgt-[A-Za-z0-9-]{1,150}$/;
const GROUP_ID = /^group-[A-Za-z0-9-]{1,120}$/;
const ACTIONS = new Set(['CreateAssetGroup', 'CreateAsset', 'GetAsset', 'ListAssets', 'DeleteAsset']);

function fail(code, message, extras = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extras);
  return error;
}
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function hmac(key, value) { return crypto.createHmac('sha256', key).update(value).digest(); }
function publicHttps(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
    const bare = host.replace(/^\[|\]$/g, '');
    if (net.isIP(bare) === 4) {
      const [a, b] = bare.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a >= 224) return false;
    } else if (net.isIP(bare) === 6 && (/^f[cd]/.test(bare) || /^fe[89ab]/.test(bare) || /^ff/.test(bare) || bare === '::' || bare === '::1' || bare.startsWith('::ffff:'))) return false;
    return true;
  } catch { return false; }
}

// Follows volcengine/volc-sdk-golang/base/sign.go. This is Volcengine V4, not AWS V4.
function signArkRequest({ action, body, accessKeyId, secretAccessKey, sessionToken = '', now = new Date() }) {
  if (!ACTIONS.has(action)) throw fail('ARK_ACTION_INVALID', '不支持的方舟素材接口。', { accepted: false });
  if (!accessKeyId || !secretAccessKey) throw fail('ARK_CREDENTIALS_REQUIRED', '服务端尚未配置方舟素材 API 的 AK/SK。', { accepted: false });
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = date.slice(0, 8);
  const url = new URL(ENDPOINT);
  url.searchParams.set('Action', action);
  url.searchParams.set('Version', VERSION);
  const headers = { 'Content-Type': 'application/json', Host: url.host, 'X-Content-Sha256': hash(text), 'X-Date': date };
  if (sessionToken) headers['X-Security-Token'] = sessionToken;
  const names = Object.keys(headers).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const signedHeaders = names.map(name => name.toLowerCase()).join(';');
  const canonicalHeaders = names.map(name => `${name.toLowerCase()}:${headers[name].trim()}\n`).join('');
  const canonical = ['POST', '/', url.searchParams.toString(), canonicalHeaders, signedHeaders, hash(text)].join('\n');
  const scope = `${day}/cn-beijing/ark/request`;
  const stringToSign = ['HMAC-SHA256', date, scope, hash(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(secretAccessKey, day), 'cn-beijing'), 'ark'), 'request');
  headers.Authorization = `HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hmac(key, stringToSign).toString('hex')}`;
  return { url: url.href, method: 'POST', headers, body: text };
}

function createArkProvider(options = {}) {
  const { accessKeyId, secretAccessKey, sessionToken = '', apiKey = '', providerAccountId, sourceStore } = options;
  const projectName = options.projectName || 'default';
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const groupStore = options.groupStore || sourceStore?.groupStore;
  const managedGroupId = options.managedGroupId || null;
  const now = options.now || (() => new Date());
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!accessKeyId || !secretAccessKey || !providerAccountId || typeof fetchImpl !== 'function' || !sourceStore?.put || !sourceStore?.urlFor ||
      (!managedGroupId && (!groupStore?.get || !groupStore?.set || !groupStore?.begin || !groupStore?.clearPending))) {
    throw fail('ARK_CONFIGURATION_INCOMPLETE', '素材服务缺少服务端凭据、供应商账号、临时图片服务或素材组持久化配置。', { accepted: false });
  }
  if (managedGroupId && !GROUP_ID.test(managedGroupId)) throw fail('ARK_MANAGED_GROUP_INVALID', '管理员配置的托管素材组 ID 无效。', { accepted: false });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw fail('ARK_TIMEOUT_INVALID', '方舟请求超时配置无效。', { accepted: false });
  const groupFlights = new Map();
  const safe = value => {
    let output = String(value || '');
    for (const secret of [accessKeyId, secretAccessKey, sessionToken, apiKey].filter(Boolean)) {
      for (const encoded of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) output = output.split(encoded).join('[已隐藏]');
    }
    return output.replace(/data:[^\s"']+/gi, '[图片已隐藏]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]').replace(/https?:\/\/[^\s"']+/gi, '[链接已隐藏]').slice(0, 500);
  };
  function checkedScope(scope) {
    const key = scopeKey(scope);
    if (scope.providerAccountId !== providerAccountId || scope.projectName !== projectName) throw fail('ARK_SCOPE_MISMATCH', '素材所属供应商账号或项目不匹配。', { accepted: false });
    return key;
  }
  async function request(action, body) {
    const signed = signArkRequest({ action, body, accessKeyId, secretAccessKey, sessionToken, now: now() });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let payload;
    try {
      response = await fetchImpl(signed.url, { method: signed.method, headers: signed.headers, body: signed.body, signal: controller.signal, redirect: 'error' });
      const raw = await response.text();
      if (raw.length > 4 * 1024 * 1024) throw fail('ARK_RESPONSE_INVALID', '方舟返回内容过大。');
      try { payload = JSON.parse(raw); } catch { throw fail('ARK_RESPONSE_INVALID', '方舟没有返回有效 JSON，请核查请求状态。'); }
    } catch (error) {
      if (error.code && error.code.startsWith('ARK_')) throw error;
      throw fail('ARK_REQUEST_UNCERTAIN', '方舟请求连接中断或超时，受理状态未知；不会自动重新提交。');
    } finally { clearTimeout(timer); }
    const metadata = payload?.ResponseMetadata;
    const providerError = metadata?.Error || payload?.error;
    if (response.status !== 200 || providerError) {
      const code = safe(providerError?.Code || providerError?.code || `HTTP_${response.status}`);
      const accepted = [400, 401, 403, 404, 413, 429].includes(response.status) && !!providerError ? false : undefined;
      throw fail(code, safe(providerError?.Message || providerError?.message || '方舟素材请求失败。'), { httpStatus: response.status, requestId: safe(metadata?.RequestId), accepted });
    }
    if (!metadata || metadata.Action !== action || metadata.Version !== VERSION || metadata.Service !== 'ark' || metadata.Region !== 'cn-beijing' || !payload.Result || Array.isArray(payload.Result) || typeof payload.Result !== 'object') {
      throw fail('ARK_RESPONSE_INVALID', '方舟响应结构与请求不一致，不能确认操作结果。');
    }
    return { result: payload.Result, requestId: safe(metadata.RequestId) };
  }
  async function ensureGroup(scope) {
    const key = checkedScope(scope);
    // A platform account must inject its managed group. The authenticated service owns
    // per-tenant asset authorization; sharing this group does not grant tenant access.
    if (managedGroupId) return managedGroupId;
    if (groupFlights.has(key)) return groupFlights.get(key);
    const flight = (async () => {
      const saved = await groupStore.get(scope);
      if (saved) {
        if (saved.pending) throw fail('ARK_GROUP_CREATE_UNCERTAIN', '该素材组创建状态尚未确认，请管理员核对并恢复绑定；不会重复创建。', { accepted: false });
        if (!GROUP_ID.test(saved.id)) throw fail('ARK_GROUP_INVALID', '持久化素材组标识无效。', { accepted: false });
        return saved.id;
      }
      const name = `sz-${hash(key).slice(0, 40)}`;
      if (!await groupStore.begin(scope, name)) throw fail('ARK_GROUP_CREATE_UNCERTAIN', '该素材组已在创建或等待核对，不能重复创建。', { accepted: false });
      let created;
      try {
        created = await request('CreateAssetGroup', { Name: name, Description: '少壮 AI 租户隔离虚拟素材组', GroupType: 'AIGC', ProjectName: projectName });
      } catch (error) {
        if (error.accepted === false) await groupStore.clearPending(scope);
        throw error;
      }
      const { result } = created;
      if (!GROUP_ID.test(result.Id || '')) throw fail('ARK_GROUP_RESPONSE_INVALID', '方舟创建素材组结果不完整，需先核查再继续。');
      try { await groupStore.set(scope, { id: result.Id, name }); }
      catch { throw fail('ARK_GROUP_PERSIST_UNCERTAIN', '素材组已创建但本地索引保存失败，需核对该素材组后恢复。'); }
      return result.Id;
    })();
    groupFlights.set(key, flight);
    try { return await flight; } finally { groupFlights.delete(key); }
  }
  async function create({ scope, assetId, name, mime, bytes, sha256 } = {}) {
    checkedScope(scope);
    // Validate before creating a group or sending any upstream mutation.
    const image = validateImage(bytes, mime);
    if (sha256 && image.sha256 !== sha256) throw fail('ARK_SOURCE_HASH_MISMATCH', '素材 SHA256 校验失败。', { accepted: false });
    const source = await sourceStore.put({ scope, bytes: image.bytes, mimeType: image.mimeType, sha256: image.sha256 });
    const groupId = await ensureGroup(scope);
    const url = await sourceStore.urlFor({ scope, id: source.id });
    // Only a URL produced and verified by our controlled source store can reach CreateAsset.
    if (typeof url !== 'string' || !url.startsWith('https://')) throw fail('ARK_SOURCE_URL_INVALID', '临时素材服务未提供 HTTPS 链接。', { accepted: false });
    if (sourceStore.readSigned) await sourceStore.readSigned(url, { scope });
    const assetName = String(name || assetId || '素材').slice(0, 64);
    const { result, requestId } = await request('CreateAsset', { GroupId: groupId, URL: url, Name: assetName, AssetType: 'Image', ProjectName: projectName });
    if (!ASSET_ID.test(result.Id || '')) throw fail('ARK_CREATE_UNCERTAIN', '方舟未返回有效素材 ID，受理状态未知；不会自动重新提交。', { requestId });
    if (sourceStore.markManaged) {
      try { await sourceStore.markManaged({ scope, id: source.id }); }
      catch { throw fail('ARK_SOURCE_PERSIST_UNCERTAIN', '云端已接收素材，但源文件索引保存失败；请核对后恢复，不能自动重提。', { upstreamId: result.Id, sourceId: source.id, requestId }); }
    }
    return { id: result.Id, status: 'Processing', groupId, sourceId: source.id, requestId };
  }
  async function get({ scope, id } = {}) {
    checkedScope(scope);
    if (!ASSET_ID.test(id || '')) throw fail('ARK_ASSET_ID_INVALID', '素材 ID 无效。', { accepted: false });
    const saved = managedGroupId ? { id: managedGroupId } : await groupStore.get(scope);
    if (!saved || !GROUP_ID.test(saved.id || '')) throw fail('ARK_GROUP_MISSING', '该租户素材组尚未配置或不可用。', { accepted: false });
    const { result, requestId } = await request('GetAsset', { Id: id, ProjectName: projectName });
    if (result.Id !== id || result.ProjectName !== projectName || result.GroupId !== saved.id || !['Active', 'Processing', 'Failed'].includes(result.Status)) {
      throw fail('ARK_ASSET_SCOPE_INVALID', '方舟素材归属或审核状态不符合当前请求。');
    }
    let previewUrl;
    if (typeof result.URL === 'string') {
      try {
        const parsed = new URL(result.URL);
        if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash) previewUrl = parsed.href;
      } catch { /* An absent preview must not change a valid moderation state. */ }
    }
    return { id, status: result.Status, groupId: result.GroupId, previewUrl, error: result.Status === 'Failed' ? safe(result.Error?.Message || result.Error?.Code || '素材审核失败。') : undefined, errorCode: safe(result.Error?.Code), createdAt: result.CreateTime, lastInferenceAt: result.LastInferenceTime, requestId };
  }
  async function deleteAsset({ scope, id, sourceId } = {}) {
    checkedScope(scope);
    if (sourceId && sourceStore.assertRemovable) await sourceStore.assertRemovable({ scope, id: sourceId });
    // Verify existence AND ownership before issuing an irreversible upstream action.
    const before = await get({ scope, id });
    const accepted = await request('DeleteAsset', { Id: id, ProjectName: projectName });
    let nextToken;
    const seen = new Set();
    let remaining = 0;
    try {
      do {
        const { result } = await request('ListAssets', { Filter: { GroupType: 'AIGC', GroupIds: [before.groupId] }, ProjectName: projectName, MaxResults: 100, SortBy: 'CreateTime', SortOrder: 'Asc', ...(nextToken ? { NextToken: nextToken } : {}) });
        if (!Array.isArray(result.Items)) throw fail('ARK_LIST_INVALID', '方舟素材列表结构不完整。');
        for (const item of result.Items) {
          if (!ASSET_ID.test(item.Id || '') || item.GroupId !== before.groupId || item.ProjectName !== projectName) throw fail('ARK_LIST_SCOPE_INVALID', '方舟素材列表归属不一致。');
          if (item.Id === id) return { deleted: false, verified: false, reason: 'ARK_DELETE_STILL_LISTED', requestId: accepted.requestId };
          remaining += 1;
        }
        if (result.NextToken !== undefined && (typeof result.NextToken !== 'string' || !result.NextToken || seen.has(result.NextToken))) throw fail('ARK_LIST_TOKEN_INVALID', '方舟素材翻页凭证无效。');
        nextToken = result.NextToken;
        if (nextToken) seen.add(nextToken);
        if (seen.size > 10000) throw fail('ARK_LIST_TOO_LARGE', '方舟素材列表超过单次核对范围。');
      } while (nextToken);
      let sourceCleanupPending = false;
      if (sourceId && sourceStore.remove) {
        try { await sourceStore.remove({ scope, id: sourceId }); }
        catch { sourceCleanupPending = true; }
      }
      return { deleted: true, verified: true, groupRemaining: remaining, sourceCleanupPending, requestId: accepted.requestId };
    } catch (error) {
      return { deleted: false, verified: false, reason: safe(error.code || 'ARK_DELETE_UNVERIFIED'), requestId: accepted.requestId };
    }
  }
  async function videoRequest(method, id, body) {
    if (!apiKey) throw fail('ARK_VIDEO_API_KEY_REQUIRED', '服务端尚未绑定同项目的视频 API Key。', { accepted: false });
    if (id && !TASK_ID.test(id)) throw fail('ARK_TASK_ID_INVALID', '视频任务 ID 无效。', { accepted: false });
    const url = id ? `${VIDEO_ENDPOINT}/${id}` : VIDEO_ENDPOINT;
    const bodyText = body ? JSON.stringify(body) : undefined;
    if (bodyText && Buffer.byteLength(bodyText) > 64 * 1024 * 1024) throw fail('ARK_VIDEO_BODY_TOO_LARGE', '视频请求体不能超过 64 MiB。', { accepted: false });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let payload;
    try {
      response = await fetchImpl(url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, ...(bodyText ? { body: bodyText } : {}), signal: controller.signal, redirect: 'error' });
      const raw = await response.text();
      if (raw.length > 4 * 1024 * 1024) throw fail('ARK_VIDEO_RESPONSE_INVALID', '方舟视频响应过大，任务状态需核对。');
      try { payload = JSON.parse(raw); } catch { throw fail('ARK_VIDEO_RESPONSE_INVALID', '方舟视频响应不是有效 JSON，任务状态需核对。'); }
    } catch (error) {
      if (error.code?.startsWith('ARK_')) throw error;
      throw fail('ARK_VIDEO_REQUEST_UNCERTAIN', '方舟视频请求中断或超时，受理状态未知；不会自动重新提交。');
    } finally { clearTimeout(timer); }
    if (response.status !== 200 || payload?.error) {
      throw fail(safe(payload?.error?.code || `HTTP_${response.status}`), safe(payload?.error?.message || '方舟视频请求失败。'), {
        httpStatus: response.status,
        accepted: [400, 401, 403, 404, 413, 429].includes(response.status) && !!payload?.error ? false : undefined,
        requestId: safe(payload?.request_id || response.headers?.get?.('x-request-id'))
      });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fail('ARK_VIDEO_RESPONSE_INVALID', '方舟视频响应结构无效。');
    return payload;
  }
  async function videoCreate({ scope, body } = {}) {
    checkedScope(scope);
    if (!body || typeof body.model !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(body.model) || !Array.isArray(body.content) || !body.content.length || body.content.length > 64) {
      throw fail('ARK_VIDEO_BODY_INVALID', '视频模型或输入内容无效。', { accepted: false });
    }
    const allowed = new Set(['model', 'content', 'duration', 'resolution', 'ratio', 'generate_audio', 'watermark', 'output_format', 'omni_reference_task_type']);
    if (Object.keys(body).some(key => !allowed.has(key))) throw fail('ARK_VIDEO_BODY_INVALID', '本次图转视频包含未支持的参数。', { accepted: false });
    for (const item of body.content) {
      if (item?.type === 'text') {
        if (typeof item.text !== 'string' || item.text.length > 20000 || Object.keys(item).some(key => !['type', 'text'].includes(key))) throw fail('ARK_VIDEO_CONTENT_INVALID', '视频提示词内容无效。', { accepted: false });
      } else if (item?.type === 'image_url') {
        if (!/^asset:\/\/asset-[A-Za-z0-9-]{1,120}$/.test(item.image_url?.url || '') || !['first_frame', 'last_frame', 'reference_image'].includes(item.role) || Object.keys(item).some(key => !['type', 'role', 'image_url'].includes(key)) || Object.keys(item.image_url).some(key => key !== 'url')) {
          throw fail('ARK_VIDEO_ASSET_REQUIRED', '本次图转视频只能引用已审核且属于当前用户的资产。', { accepted: false });
        }
      } else if (item?.type === 'video_url') {
        const url = item.video_url?.url;
        if ((!/^asset:\/\/asset-[A-Za-z0-9-]{1,120}$/.test(url || '') && !publicHttps(url)) || item.role !== 'reference_video' || Object.keys(item).some(key => !['type', 'role', 'video_url'].includes(key)) || Object.keys(item.video_url).some(key => key !== 'url')) {
          throw fail('ARK_VIDEO_REFERENCE_INVALID', '参考视频地址或参数无效。', { accepted: false });
        }
      } else if (item?.type === 'audio_url') {
        const url = item.audio_url?.url;
        const data = typeof url === 'string' ? /^data:audio\/(?:mp3|mpeg|wav);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url) : null;
        const audioDataValid = !!data && data[1].length % 4 === 0 && Buffer.byteLength(data[1], 'base64') <= 15 * 1024 * 1024;
        if ((!/^asset:\/\/asset-[A-Za-z0-9-]{1,120}$/.test(url || '') && !publicHttps(url) && !audioDataValid) || item.role !== 'reference_audio' || Object.keys(item).some(key => !['type', 'role', 'audio_url'].includes(key)) || Object.keys(item.audio_url).some(key => key !== 'url')) {
          throw fail('ARK_AUDIO_REFERENCE_INVALID', '参考音频必须是有效 HTTPS、资产引用或不超过 15 MiB 的音频数据。', { accepted: false });
        }
      } else throw fail('ARK_VIDEO_CONTENT_INVALID', '视频输入内容类型无效。', { accepted: false });
    }
    if (body.watermark !== undefined && typeof body.watermark !== 'boolean') throw fail('ARK_VIDEO_WATERMARK_INVALID', '水印参数必须是布尔值。', { accepted: false });
    if (body.omni_reference_task_type !== undefined && body.omni_reference_task_type !== 'reference') throw fail('ARK_VIDEO_BODY_INVALID', '全模态任务类型必须为 reference。', { accepted: false });
    if (body.output_format !== undefined && body.output_format !== 'mp4') throw fail('ARK_VIDEO_BODY_INVALID', '当前插件视频输出格式必须为 mp4。', { accepted: false });
    const payload = await videoRequest('POST', null, { ...body, watermark: body.watermark ?? false });
    if (!TASK_ID.test(payload.id || '')) throw fail('ARK_VIDEO_CREATE_UNCERTAIN', '方舟未返回有效视频任务 ID，受理状态未知；不会自动重提。');
    return { id: payload.id, status: 'queued' };
  }
  async function videoGet({ scope, id } = {}) {
    checkedScope(scope);
    if (!TASK_ID.test(id || '')) throw fail('ARK_TASK_ID_INVALID', '视频任务 ID 无效。', { accepted: false });
    const payload = await videoRequest('GET', id);
    if (payload.id !== id || !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired'].includes(payload.status)) throw fail('ARK_VIDEO_STATUS_INVALID', '方舟视频任务 ID 或状态不匹配。');
    let resultUrls;
    if (payload.status === 'succeeded') {
      let url;
      try { url = new URL(payload.content?.video_url); } catch { throw fail('ARK_VIDEO_RESULT_INVALID', '视频已完成但没有有效结果链接。'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw fail('ARK_VIDEO_RESULT_INVALID', '视频结果链接不符合 HTTPS 要求。');
      resultUrls = [url.href];
    }
    return { id, status: payload.status === 'expired' ? 'failed' : payload.status, providerStatus: payload.status, resultUrls,
      error: payload.status === 'expired' ? '方舟视频任务已超时。' : payload.error ? safe(payload.error.message || payload.error.code) : undefined };
  }
  async function videoCancel({ scope, id } = {}) {
    checkedScope(scope);
    const before = await videoGet({ scope, id });
    if (before.status === 'cancelled') return { cancelled: true, verified: true };
    if (before.status !== 'queued') return { cancelled: false, verified: false, reason: 'ARK_VIDEO_NOT_QUEUED' };
    await videoRequest('DELETE', id);
    try {
      const after = await videoGet({ scope, id });
      return { cancelled: after.status === 'cancelled', verified: after.status === 'cancelled', ...(after.status === 'cancelled' ? {} : { reason: 'ARK_VIDEO_CANCEL_UNVERIFIED' }) };
    } catch { return { cancelled: false, verified: false, reason: 'ARK_VIDEO_CANCEL_UNVERIFIED' }; }
  }
  async function preview({ scope, sourceId } = {}) {
    checkedScope(scope);
    return { previewUrl: await sourceStore.urlFor({ scope, id: sourceId }) };
  }
  async function setPinned({ scope, sourceId, pinned } = {}) {
    checkedScope(scope);
    if (!sourceStore.setPinned) throw fail('ARK_SOURCE_LIFECYCLE_UNSUPPORTED', '素材缓存暂不支持变更绑定状态。', { accepted: false });
    await sourceStore.setPinned({ scope, id: sourceId, pinned });
  }
  async function cleanupSource({ scope, sourceId } = {}) {
    checkedScope(scope);
    if (!sourceStore.remove) throw fail('ARK_SOURCE_LIFECYCLE_UNSUPPORTED', '素材缓存暂不支持清理。', { accepted: false });
    return sourceStore.remove({ scope, id: sourceId });
  }
  return {
    create, get, delete: deleteAsset, preview, setPinned, cleanupSource, videoCreate, videoGet, videoCancel,
    capabilities: () => ({ provider: 'volcengine-ark', configured: true, projectName, providerAccountId, managedGroup: !!managedGroupId, createQpm: 3, deleteVerification: 'accepted-and-fully-listed-absent', usageApiVerified: false, watermark: false }),
  };
}

module.exports = { createArkProvider, signArkRequest, ENDPOINT, VIDEO_ENDPOINT, VERSION };
