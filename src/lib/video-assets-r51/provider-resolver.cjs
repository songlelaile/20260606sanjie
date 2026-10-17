/* eslint-disable @typescript-eslint/no-require-imports -- Server-only CommonJS modules loaded by the Node runtime. */
'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');
const { AssetError } = require('./asset-service.cjs');

function rejected(code, message) { throw new AssetError(code, message); }
function sameSecretDigest(left, right) {
  if (!/^[a-f0-9]{64}$/.test(String(left)) || !/^[a-f0-9]{64}$/.test(String(right))) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
function apiOrigin(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.origin !== raw) throw new Error('invalid');
    return url.origin;
  } catch (_) { rejected('PROVIDER_BINDING_MISMATCH', '方舟 API 绑定地址无效。'); }
}
function credentialFingerprint(origin, apiKey) { return createHash('sha256').update(origin + '\n' + apiKey).digest('hex'); }

/**
 * findBinding(identity, selector) must query current trusted tenant/user rows.
 * No credential is accepted from the request. The returned scope is safe to pass
 * into the core; the binding record and its secrets never become response data.
 * The owning application's core providerResolver must resolve the exact same
 * tenant/user/providerAccount/project record and reject disabled/drifted bindings.
 */
function createRequestProviderResolver({ findBinding } = {}) {
  if (typeof findBinding !== 'function') throw new TypeError('A current database binding lookup is required.');
  return Object.freeze({
    async resolve(identity, selection, options = {}) {
      if (!identity || !identity.tenantId || !identity.userId || !identity.accountKey) rejected('AUTH_REQUIRED', '请重新登录。');
      if (!selection || typeof selection.provider !== 'string' || selection.provider.length > 80 || !selection.provider.trim()) rejected('PROVIDER_BINDING_MISMATCH', '缺少当前视频 API 绑定。');
      const origin = apiOrigin(selection.apiOrigin);
      if (!/^[a-f0-9]{64}$/.test(String(selection.credentialFingerprint))) rejected('PROVIDER_BINDING_MISMATCH', '当前视频 API 绑定校验无效。');
      const row = await findBinding(identity, { provider: selection.provider, apiOrigin: origin });
      if (!row || row.enabled !== true || !['tenant', 'platform'].includes(row.mode)) rejected('ASSET_SERVICE_NOT_CONFIGURED', '当前账号尚未配置自动送审服务。');
      // The result is checked even when the database adapter accidentally returns
      // a sibling tenant's row. Platform mode still needs an explicit user grant.
      if (row.tenantId !== identity.tenantId || row.userId !== identity.userId || row.provider !== selection.provider || row.apiOrigin !== origin) rejected('PROVIDER_BINDING_MISMATCH', '供应商绑定与当前账号不一致。');
      if (row.mode === 'platform' && row.platformGrantEnabled !== true) rejected('ASSET_SERVICE_NOT_CONFIGURED', '当前账号尚未获准使用平台供应商绑定。');
      if (options.requirePlatform === true && row.mode !== 'platform') rejected('PROVIDER_BINDING_MISMATCH', '当前请求需要平台供应商绑定。');
      if (!row.apiKey || !row.accessKeyId || !row.secretAccessKey || !row.providerAccountId || !row.projectName) rejected('ASSET_SERVICE_NOT_CONFIGURED', '当前账号素材服务配置未完成。');
      if (!sameSecretDigest(credentialFingerprint(origin, row.apiKey), selection.credentialFingerprint)) rejected('PROVIDER_BINDING_MISMATCH', '当前视频 API Key 已变化，请同步服务端绑定后重试。');
      return Object.freeze({
        tenantId: identity.tenantId, userId: identity.userId,
        providerAccountId: row.providerAccountId, projectName: row.projectName
      });
    }
  });
}

/** Adapter around the existing website's signed-session verifier and DB lookup. */
function createSessionAuthenticator({ verifySessionToken, lookupUser } = {}) {
  if (typeof verifySessionToken !== 'function' || typeof lookupUser !== 'function') throw new TypeError('Signed-session and current-user verifiers are required.');
  return async function authenticate(request) {
    let raw = request.headers.get('x-sanjie-session');
    if (!raw) {
      const match = /(?:^|;\s*)sanjie_session=([^;]+)/.exec(request.headers.get('cookie') || '');
      raw = match && match[1];
    }
    if (!raw || raw.length > 8192) rejected('AUTH_REQUIRED', '请重新登录。');
    let session = await verifySessionToken(raw);
    if (!session) {
      try { const decoded = decodeURIComponent(raw); if (decoded !== raw) session = await verifySessionToken(decoded); } catch (_) {}
    }
    if (!session || !session.username || !session.tenantId || !['admin', 'tenant'].includes(session.role)) rejected('AUTH_REQUIRED', '会话已失效。');
    const user = await lookupUser(session.username);
    const role = user && user.authRole === 'admin' ? 'admin' : 'tenant';
    if (!user || !user.id || user.status === 'disabled' || user.tenantId !== session.tenantId || role !== session.role) rejected('AUTH_REQUIRED', '账号或租户归属已变化，请重新登录。');
    // Preserve the extension's established user:<username> account archive key.
    // Do not change auth/me to expose id and silently orphan existing archives.
    const accountKey = 'user:' + String(session.username).replace(/[^\w@.+:-]/g, '_').slice(0, 120);
    const websiteAccountKey = user.tenantId + ':' + session.username;
    const accountKeys = [...new Set([accountKey, websiteAccountKey, 'user:' + websiteAccountKey.replace(/[^\w@.+:-]/g, '_').slice(0, 120)])];
    return Object.freeze({ tenantId: user.tenantId, userId: user.id, accountKey, websiteAccountKey, accountKeys: Object.freeze(accountKeys) });
  };
}

module.exports = { createRequestProviderResolver, createSessionAuthenticator, credentialFingerprint };
