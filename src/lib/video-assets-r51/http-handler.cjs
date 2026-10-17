/* eslint-disable @typescript-eslint/no-require-imports -- Server-only CommonJS modules loaded by the Node runtime. */
'use strict';

const { AssetError, MAX_IMAGE_BYTES } = require('./asset-service.cjs');
const MAX_JSON_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 32 * 1024;
const DEFAULT_ORIGINS = ['https://shaozhuangai.com', 'https://www.shaozhuangai.com', 'chrome-extension://dkmjnjgldlbggiobpaogbhegfnbkomnj'];
const ERROR_ALIASES = {
  PROVIDER_QUOTA_FULL: 'ASSET_QUOTA_FULL', AUTOMATIC_POOL_FULL: 'AUTO_POOL_FULL',
  PROVIDER_CREATE_UNCERTAIN: 'ASSET_CREATE_UNCERTAIN', PROVIDER_BINDING_CHANGED: 'PROVIDER_BINDING_MISMATCH',
  PROVIDER_BINDING_REQUIRED: 'ASSET_SERVICE_NOT_CONFIGURED', PROVIDER_NOT_READY: 'ASSET_SERVICE_NOT_CONFIGURED',
  PROVIDER_QUOTA_UNKNOWN: 'ASSET_SERVICE_NOT_CONFIGURED'
};
const SAFE_MESSAGES = {
  AUTH_REQUIRED: '请重新登录少壮AI。', ACCOUNT_CHANGED: '账号已切换，请刷新素材库。',
  ASSET_SERVICE_NOT_CONFIGURED: '当前账号尚未配置同一方舟账号的自动送审服务。',
  PROVIDER_BINDING_MISMATCH: '方舟 API 绑定已变更，请同步素材权限后重试。',
  ASSET_NOT_FOUND: '当前账号下找不到该素材。', TASK_NOT_FOUND: '当前账号下找不到该视频任务。',
  ASSET_QUOTA_FULL: '云素材额度已满，没有足够的可自动清理素材。',
  AUTO_POOL_FULL: '自动素材区已满，素材正在审核或生成中。', BOUND_POOL_FULL: '绑定素材最多保留 50 张，请先取消其他素材的绑定。',
  ASSET_IN_USE: '素材正在被未结束的视频任务使用。', ASSET_CREATE_UNCERTAIN: '素材入库结果未确认，已保留记录，不会重复送审。',
  VIDEO_CREATE_UNCERTAIN: '视频提交结果未确认，系统不会自动重新提交。',
  ASSET_NOT_ACTIVE: '图片审核成功后才可生成视频。', ASSET_REVIEW_FAILED: '素材审核未通过。',
  PROVIDER_DELETE_UNVERIFIED: '云素材删除尚未核验，已保留记录并停止上传。',
  PROVIDER_STATUS_UNAVAILABLE: '暂时无法核验素材状态，请稍后刷新。',
  IMAGE_HASH_MISMATCH: '图片校验不一致，请重新选择原图。', IMAGE_MIME_INVALID: '图片内容或格式无效。',
  IMAGE_SIZE_INVALID: '单张送审图片不超过 20 MB。', REQUEST_INVALID: '请求格式无效。',
  REQUEST_TOO_LARGE: '图片请求超过大小限制。', METHOD_NOT_ALLOWED: '该地址不支持此操作。',
  ASSET_RATE_LIMIT: '素材供应商请求频率已达限制，请稍后查看状态。',
  MATERIAL_TYPE_REQUIRED: '请选择普通商品、虚拟人像或真人人像素材。',
  HUMAN_VALIDATION_REQUIRED: '请由素材中的本人完成供应商活体核验与授权。',
  HUMAN_VALIDATION_UNAVAILABLE: '当前账号尚未配置真人核验服务。',
  HUMAN_VALIDATION_UNVERIFIED: '真人核验结果尚未由供应商确认。',
  HUMAN_GROUP_UNVERIFIED: '真人素材组所属项目或类型未通过供应商核验。',
  VALIDATION_NOT_FOUND: '当前账号下找不到真人核验会话。'
};
function fail(code) { throw new AssetError(code, SAFE_MESSAGES[code] || '素材服务请求失败。'); }
function decodeHeader(request, name, max) {
  const raw = request.headers.get(name);
  if (!raw || raw.length > max) fail('REQUEST_INVALID');
  try { return decodeURIComponent(raw); } catch (_) { fail('REQUEST_INVALID'); }
}
async function jsonBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) fail('REQUEST_INVALID');
  if (Number(request.headers.get('content-length') || 0) > MAX_JSON_BYTES) fail('REQUEST_TOO_LARGE');
  const reader = request.body && request.body.getReader();
  if (!reader) fail('REQUEST_INVALID');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_JSON_BYTES) { await reader.cancel(); fail('REQUEST_TOO_LARGE'); }
    chunks.push(Buffer.from(value));
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('REQUEST_INVALID');
    return body;
  } catch (_) { fail('REQUEST_INVALID'); }
}
function imageInput(body) {
  if (body.groupId || body.providerGroupId || body.bytedToken || body.certified === true) fail('REQUEST_INVALID');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(body.dataUrl || '');
  if (!match || match[2].length % 4 !== 0 || body.mime && body.mime !== match[1]) fail('IMAGE_MIME_INVALID');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.toString('base64') !== match[2]) fail('IMAGE_MIME_INVALID');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) fail('IMAGE_SIZE_INVALID');
  return { bytes, mime: match[1], name: body.name, sha256: body.sha256, materialType: body.materialType, validationId: body.validationId };
}
function publicAsset(row) {
  const status = { creating: 'processing', create_uncertain: 'uncertain', rejected: 'failed' }[row.status] || row.status;
  return {
    id: row.id, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256,
    bound: row.bound === true, pool: row.bound === true ? 'bound' : 'auto', status, materialType: row.materialType || 'virtual',
    canUse: row.status === 'active', inUse: row.inUse === true,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
    errorCode: ERROR_ALIASES[row.errorCode] || row.errorCode || '',
    message: row.status === 'rejected' ? SAFE_MESSAGES.ASSET_REVIEW_FAILED : row.status === 'create_uncertain' ? SAFE_MESSAGES.ASSET_CREATE_UNCERTAIN : ''
  };
}
function publicLimits(value) {
  return { auto: value.automatic, bound: value.bound, cloud: value.cloudTotal, autoUsed: value.automaticUsed, boundUsed: value.boundUsed };
}
function errorStatus(code) {
  if (code === 'AUTH_REQUIRED') return 401;
  if (code === 'ASSET_SERVICE_NOT_CONFIGURED') return 503;
  if (code === 'ASSET_NOT_FOUND' || code === 'TASK_NOT_FOUND' || code === 'VALIDATION_NOT_FOUND') return 404;
  if (code === 'METHOD_NOT_ALLOWED') return 405;
  if (code === 'REQUEST_TOO_LARGE') return 413;
  if (code === 'ASSET_RATE_LIMIT') return 429;
  if (['REQUEST_INVALID', 'IMAGE_HASH_MISMATCH', 'IMAGE_MIME_INVALID', 'IMAGE_SIZE_INVALID'].includes(code)) return 400;
  if (code === 'SERVICE_ERROR') return 500;
  return 409;
}

/** A Web Request -> Response adapter. Authentication and provider lookup are injected. */
function createHttpHandler({ assetService, taskService, sourceStore, authenticate, providerResolver, allowedOrigins = DEFAULT_ORIGINS } = {}) {
  if (!assetService || typeof authenticate !== 'function' || !providerResolver || typeof providerResolver.resolve !== 'function') throw new TypeError('Asset service, fresh authentication and request provider resolver are required.');
  return async function handle(request) {
    const headers = new Headers({ 'Cache-Control': 'private, no-store', Vary: 'Origin, x-sanjie-session, x-video-account, x-video-binding, x-video-platform-binding', 'X-Content-Type-Options': 'nosniff' });
    const origin = request.headers.get('origin');
    if (origin && allowedOrigins.includes(origin)) headers.set('Access-Control-Allow-Origin', origin);
    function response(value, status = 200) { headers.set('Content-Type', 'application/json; charset=utf-8'); return new Response(JSON.stringify(value), { status, headers }); }
    let unconfiguredCapability = null;
    try {
      if (origin && !allowedOrigins.includes(origin)) return response({ ok: false, error: { code: 'ORIGIN_REJECTED', message: '请求来源未获准。' } }, 403);
      const path = new URL(request.url).pathname;
      // Ark fetches a short-lived HMAC URL without the user's website session.
      // readSigned independently enforces origin/path, HMAC, expiry, and byte hash.
      if (path.startsWith('/api/video-assets/source/')) {
        if (!['GET', 'HEAD'].includes(request.method)) return response({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: SAFE_MESSAGES.METHOD_NOT_ALLOWED } }, 405);
        try {
          if (!sourceStore || typeof sourceStore.readSigned !== 'function') throw new Error('unavailable');
          const file = await sourceStore.readSigned(request.url);
          headers.set('Content-Type', file.mimeType); headers.set('Content-Length', String(file.size));
          headers.set('Referrer-Policy', 'no-referrer');
          return new Response(request.method === 'HEAD' ? null : file.bytes, { status: 200, headers });
        } catch (_) { return new Response(null, { status: 404, headers }); }
      }
      const match = /^\/api\/(video-assets|video-tasks)(?:\/(by-key)\/([A-Za-z0-9_-]{8,120})|\/([A-Za-z0-9_-]{8,120}))?$/.exec(path);
      const validation = /^\/api\/video-assets\/validation-sessions(?:\/(vv_[A-Za-z0-9_-]{1,180})(?:\/(verify))?)?$/.exec(path);
      if (!match && !validation) return response({ ok: false, error: { code: 'NOT_FOUND', message: '接口不存在。' } }, 404);
      if (request.method === 'OPTIONS') {
        headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
        headers.set('Access-Control-Allow-Headers', 'content-type, x-sanjie-session, x-video-account, x-video-binding, x-video-platform-binding');
        return new Response(null, { status: 204, headers });
      }
      const identity = await authenticate(request);
      if (!identity || !identity.tenantId || !identity.userId || !identity.accountKey) fail('AUTH_REQUIRED');
      const expected = decodeHeader(request, 'x-video-account', 1024);
      const accountKeys = Array.isArray(identity.accountKeys) ? identity.accountKeys : [identity.accountKey];
      if (!accountKeys.includes(expected)) fail('ACCOUNT_CHANGED');
      let selected;
      try { selected = JSON.parse(decodeHeader(request, 'x-video-binding', 4096)); } catch (_) { fail('REQUEST_INVALID'); }
      let scope;
      try { scope = await providerResolver.resolve(identity, selected, { requirePlatform: request.headers.get('x-video-platform-binding') === '1' }); }
      catch (error) {
        // Only this authenticated, pre-submit capability read may explicitly
        // preserve the legacy provider route. A 503 from a proxy, quota error,
        // asset operation, or POST can never authorize a second submission.
        if (request.method === 'GET' && path === '/api/video-assets' && request.headers.get('x-video-platform-binding') !== '1' &&
            error && error.code === 'ASSET_SERVICE_NOT_CONFIGURED' &&
            selected && typeof selected.provider === 'string' && selected.provider.trim() && selected.provider.length <= 80 &&
            /^[a-f0-9]{64}$/.test(String(selected.credentialFingerprint))) {
          try {
            const origin = new URL(selected.apiOrigin);
            if (origin.protocol === 'https:' && origin.origin === selected.apiOrigin && !origin.username && !origin.password && !origin.search && !origin.hash) {
              unconfiguredCapability = { accountKey: expected, capability: 'video-assets-v1',
                providerBinding: { provider: selected.provider, apiOrigin: selected.apiOrigin, credentialFingerprint: selected.credentialFingerprint } };
            }
          } catch (_) {}
        }
        throw error;
      }
      // Even a faulty injected resolver cannot redirect an authenticated user.
      if (!scope || scope.tenantId !== identity.tenantId || scope.userId !== identity.userId) fail('PROVIDER_BINDING_MISMATCH');
      const accountKey = expected;
      if (validation) {
        let record;
        if (!validation[1] && request.method === 'POST') record = await assetService.createValidation(scope, { idempotencyKey: (await jsonBody(request)).idempotencyKey });
        else if (validation[1] && !validation[2] && request.method === 'GET') record = await assetService.getValidation(scope, validation[1]);
        else if (validation[1] && validation[2] === 'verify' && request.method === 'POST') record = await assetService.verifyValidation(scope, validation[1]);
        else fail('METHOD_NOT_ALLOWED');
        return response({ ok: true, data: { accountKey, validation: record } });
      }
      const id = match[4];
      const isAssets = match[1] === 'video-assets';
      async function decorate(asset) {
        const result = publicAsset(asset);
        if (asset.status !== 'deleted' && typeof assetService.preview === 'function') {
          try { const preview = await assetService.preview(scope, asset.id); if (preview && preview.previewUrl) result.previewUrl = preview.previewUrl; } catch (_) {}
        }
        return result;
      }
      if (isAssets) {
        if (match[2]) fail('METHOD_NOT_ALLOWED');
        if (!id && request.method === 'GET') {
          let listed = await assetService.list(scope);
          const processing = listed.assets.filter(asset => asset.status === 'processing').sort((a, b) => a.updatedAt - b.updatedAt).slice(0, 3);
          for (const asset of processing) { try { await assetService.refresh(scope, asset.id); } catch (_) {} }
          if (processing.length) listed = await assetService.list(scope);
          const assets = [];
          for (const asset of listed.assets) assets.push(await decorate(asset));
          const capabilities = typeof assetService.capabilities === 'function' ? await assetService.capabilities(scope) : { portraitAvailable: false };
          return response({ ok: true, data: { accountKey, available: true, reason: '', assets, limits: publicLimits(listed.limits), capabilities } });
        }
        if (!id && request.method === 'POST') {
          const result = await assetService.ingest(scope, imageInput(await jsonBody(request)));
          if (result.requiresRegistration === false) return response({ ok: true, data: { accountKey, requiresRegistration: false, materialType: 'ordinary' } });
          return response({ ok: true, data: { accountKey, asset: await decorate(result.asset), deduplicated: result.deduplicated } });
        }
        if (id && request.method === 'GET') return response({ ok: true, data: { accountKey, asset: await decorate(await assetService.refresh(scope, id)) } });
        if (id && request.method === 'PATCH') {
          const body = await jsonBody(request);
          if (typeof body.bound !== 'boolean') fail('REQUEST_INVALID');
          return response({ ok: true, data: { accountKey, asset: await decorate(await assetService.setBound(scope, id, body.bound)) } });
        }
        if (id && request.method === 'DELETE') return response({ ok: true, data: { accountKey, asset: publicAsset(await assetService.remove(scope, id)) } });
      } else {
        if (!taskService) fail('ASSET_SERVICE_NOT_CONFIGURED');
        let result;
        if (match[2] && request.method === 'GET') result = await taskService.findByKey(scope, { idempotencyKey: match[3] });
        else if (!id && !match[2] && request.method === 'POST') {
          const body = await jsonBody(request);
          result = await taskService.create(scope, { idempotencyKey: body.idempotencyKey, body: body.body });
        } else if (id && request.method === 'GET') result = await taskService.get(scope, { id });
        else if (id && request.method === 'DELETE') result = await taskService.cancel(scope, { id });
        else fail('METHOD_NOT_ALLOWED');
        return response({ ok: true, data: { ...result, accountKey } });
      }
      fail('METHOD_NOT_ALLOWED');
    } catch (error) {
      const rawCode = error && error.code;
      let code = ERROR_ALIASES[rawCode] || rawCode;
      if (!Object.prototype.hasOwnProperty.call(SAFE_MESSAGES, code)) code = 'SERVICE_ERROR';
      const message = SAFE_MESSAGES[code] || '素材服务暂时不可用，请稍后重试。';
      return response({ ok: false, error: { code, message }, ...(unconfiguredCapability || {}) }, errorStatus(code));
    }
  };
}

module.exports = { createHttpHandler, publicAsset, publicLimits, imageInput, MAX_JSON_BYTES };
