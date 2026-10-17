/* eslint-disable @typescript-eslint/no-require-imports -- Server-only CommonJS modules loaded by the Node runtime. */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const path = require('node:path');
const os = require('node:os');

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const SOURCE_ROUTE = '/api/video-assets/source/';
const ID = /^[a-f0-9]{32}$/;
const GROUP_ID = /^group-[A-Za-z0-9-]{1,120}$/;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  error.accepted = false;
  return error;
}

function scopeKey(scope) {
  const fields = ['tenantId', 'userId', 'providerAccountId', 'projectName'];
  if (!scope || fields.some(key => typeof scope[key] !== 'string' || !scope[key].trim() || scope[key].length > 256)) {
    throw failure('SOURCE_SCOPE_INVALID', '素材缺少可信租户、用户、供应商账号或项目身份。');
  }
  return JSON.stringify(fields.map(key => scope[key]));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validateImage(bytes, mimeType) {
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) throw failure('SOURCE_BYTES_REQUIRED', '仅支持直接上传图片字节。');
  const buffer = Buffer.from(bytes);
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw failure('SOURCE_SIZE_INVALID', '图片必须大于 0 字节且不超过 30 MiB。');
  const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  const isWebp = buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  const detected = isPng ? 'image/png' : isJpeg ? 'image/jpeg' : isWebp ? 'image/webp' : null;
  if (!detected || mimeType !== detected) throw failure('SOURCE_MIME_INVALID', '仅支持文件内容与 MIME 一致的 PNG、JPEG 或 WebP 图片。');
  return { bytes: buffer, mimeType: detected, size: buffer.length, sha256: sha256(buffer) };
}

async function createSourceStore(options = {}) {
  const signingKey = Buffer.isBuffer(options.signingKey) ? Buffer.from(options.signingKey) : Buffer.from(options.signingKey || '', 'utf8');
  if (signingKey.length < 32) throw failure('SOURCE_SIGNING_KEY_REQUIRED', '服务端需配置至少 32 字节的素材 URL 签名密钥。');
  const base = new URL(options.publicBaseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw failure('SOURCE_ORIGIN_INVALID', '素材服务地址必须是无路径、无凭据的 HTTPS 来源。');
  }
  const clock = options.now || Date.now;
  const lifetimeMs = options.lifetimeMs ?? 24 * 60 * 60 * 1000;
  const urlTtlSeconds = options.urlTtlSeconds ?? 3600;
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 60000 || lifetimeMs > 7 * 24 * 60 * 60 * 1000 ||
      !Number.isSafeInteger(urlTtlSeconds) || urlTtlSeconds < 1 || urlTtlSeconds > 12 * 60 * 60) {
    throw failure('SOURCE_LIFETIME_INVALID', '素材临时保存或链接有效期配置无效。');
  }
  let directory;
  if (options.directory) {
    if (!path.isAbsolute(options.directory) || path.resolve(options.directory) === path.parse(options.directory).root || /少壮AI成果档案|少壮跨版本档案/.test(options.directory)) {
      throw failure('SOURCE_DIRECTORY_INVALID', '临时素材目录必须独立于永久成果档案。');
    }
    await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(options.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure('SOURCE_DIRECTORY_INVALID', '临时素材目录不可为符号链接。');
    directory = await fs.realpath(options.directory);
    await fs.chmod(directory, 0o700);
  } else {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sz-ark-sources-'));
    await fs.chmod(directory, 0o700);
  }
  const marker = path.join(directory, '.ark-source-store-v1');
  try { await fs.writeFile(marker, 'private temporary source store v1\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }

  const filename = (id, suffix) => {
    if (!ID.test(id)) throw failure('SOURCE_ID_INVALID', '素材标识无效。');
    return path.join(directory, id + suffix);
  };
  async function privateRead(file) {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw failure('SOURCE_FILE_INVALID', '临时素材文件类型无效。');
      return await handle.readFile();
    } finally { await handle.close(); }
  }
  async function metadata(id, scope) {
    let record;
    try { record = JSON.parse(await privateRead(filename(id, '.json'))); }
    catch (error) { if (error.code === 'ENOENT') throw failure('SOURCE_NOT_FOUND', '临时素材已过期或不存在。'); throw error; }
    if (record.id !== id || typeof record.scope !== 'string' || !Number.isSafeInteger(record.expiresAt)) throw failure('SOURCE_METADATA_INVALID', '临时素材元数据无效。');
    if (scope && record.scope !== scopeKey(scope)) throw failure('SOURCE_SCOPE_MISMATCH', '不能访问其他租户或用户的素材。');
    if (!record.managed && record.expiresAt <= clock()) throw failure('SOURCE_EXPIRED', '临时素材已过期，请重新上传。');
    return record;
  }
  function sign(id, expires, key) {
    return crypto.createHmac('sha256', signingKey).update(`source-v1\n${id}\n${expires}\n${key}`).digest('hex');
  }
  async function put({ scope, bytes, mimeType, mime, sha256: expectedHash } = {}) {
    const key = scopeKey(scope);
    const image = validateImage(bytes, mimeType || mime);
    if (expectedHash && expectedHash !== image.sha256) throw failure('SOURCE_HASH_MISMATCH', '素材字节与声明的 SHA256 不一致。');
    const id = crypto.randomBytes(16).toString('hex');
    const createdAt = clock();
    const record = { id, scope: key, sha256: image.sha256, size: image.size, mimeType: image.mimeType, createdAt, expiresAt: createdAt + lifetimeMs };
    await fs.writeFile(filename(id, '.bin'), image.bytes, { flag: 'wx', mode: 0o600 });
    try { await fs.writeFile(filename(id, '.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
    catch (error) { await fs.unlink(filename(id, '.bin')).catch(() => {}); throw error; }
    return { id, sha256: image.sha256, size: image.size, mimeType: image.mimeType, expiresAt: record.expiresAt };
  }
  async function urlFor({ scope, id, ttlSeconds = urlTtlSeconds } = {}) {
    scopeKey(scope);
    const record = await metadata(id, scope);
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 12 * 60 * 60) throw failure('SOURCE_URL_TTL_INVALID', '素材链接有效期无效。');
    const expires = record.managed ? Math.floor(clock() / 1000) + ttlSeconds : Math.min(Math.floor(clock() / 1000) + ttlSeconds, Math.floor(record.expiresAt / 1000));
    const url = new URL(SOURCE_ROUTE + id, base);
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('signature', sign(id, expires, record.scope));
    return url.href;
  }
  async function readSigned(value, { scope } = {}) {
    let url;
    try { url = new URL(value, base); } catch { throw failure('SOURCE_SIGNATURE_INVALID', '素材链接无效。'); }
    if (url.origin !== base.origin || url.username || url.password || url.hash || !url.pathname.startsWith(SOURCE_ROUTE)) throw failure('SOURCE_SIGNATURE_INVALID', '素材链接来源无效。');
    const id = url.pathname.slice(SOURCE_ROUTE.length);
    if (url.searchParams.getAll('expires').length !== 1 || url.searchParams.getAll('signature').length !== 1 || [...url.searchParams.keys()].some(key => !['expires', 'signature'].includes(key))) throw failure('SOURCE_SIGNATURE_INVALID', '素材链接参数无效。');
    const rawExpiry = url.searchParams.get('expires');
    const signature = url.searchParams.get('signature') || '';
    if (!/^\d{1,12}$/.test(rawExpiry || '') || !/^[a-f0-9]{64}$/.test(signature)) throw failure('SOURCE_SIGNATURE_INVALID', '素材链接签名无效。');
    const expires = Number(rawExpiry);
    if (expires <= Math.floor(clock() / 1000)) throw failure('SOURCE_EXPIRED', '素材链接已过期。');
    const record = await metadata(id, scope);
    if (!record.managed && expires > Math.floor(record.expiresAt / 1000)) throw failure('SOURCE_SIGNATURE_INVALID', '素材链接有效期无效。');
    const expected = sign(id, expires, record.scope);
    if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) throw failure('SOURCE_SIGNATURE_INVALID', '素材链接签名无效。');
    const bytes = await privateRead(filename(id, '.bin'));
    if (bytes.length !== record.size || sha256(bytes) !== record.sha256) throw failure('SOURCE_INTEGRITY_FAILED', '临时素材完整性校验失败。');
    return { bytes, mimeType: record.mimeType, size: record.size, sha256: record.sha256 };
  }
  async function serve(req, res) {
    const parsed = new URL(req.url, base);
    if (!parsed.pathname.startsWith(SOURCE_ROUTE)) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' }); res.end(); return true;
    }
    try {
      const file = await readSigned(parsed.href);
      res.writeHead(200, { 'Content-Type': file.mimeType, 'Content-Length': file.size, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(req.method === 'HEAD' ? undefined : file.bytes);
    } catch {
      // Do not reveal tenant identity, signature details or filesystem paths on the public URL route.
      res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end();
    }
    return true;
  }
  async function cleanupExpired() {
    let deleted = 0;
    for (const entry of await fs.readdir(directory)) {
      if (!/^[a-f0-9]{32}\.json$/.test(entry)) continue;
      const id = entry.slice(0, 32);
      let record;
      try { record = JSON.parse(await privateRead(filename(id, '.json'))); } catch { continue; }
      if (record.id !== id || record.managed || !Number.isSafeInteger(record.expiresAt) || record.expiresAt > clock()) continue;
      await fs.unlink(filename(id, '.bin')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.unlink(filename(id, '.json'));
      deleted += 1;
    }
    return { deleted };
  }
  async function writeMetadata(record) {
    const temporary = path.join(directory, `source-write-${crypto.randomBytes(16).toString('hex')}.json`);
    await fs.writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, filename(record.id, '.json'));
  }
  async function markManaged({ scope, id, pinned = false } = {}) {
    scopeKey(scope);
    const record = await metadata(id, scope);
    // API admission succeeded. Pool limits and tenant ownership are controlled by the
    // service DB; these bytes now live until its verified FIFO/manual removal.
    record.managed = true;
    record.pinned = !!pinned;
    await writeMetadata(record);
  }
  async function setPinned({ scope, id, pinned } = {}) {
    scopeKey(scope);
    const record = await metadata(id, scope);
    if (!record.managed || typeof pinned !== 'boolean') throw failure('SOURCE_LIFECYCLE_INVALID', '仅已受管素材可变更绑定状态。');
    record.pinned = pinned;
    await writeMetadata(record);
  }
  async function remove({ scope, id } = {}) {
    const key = scopeKey(scope);
    let record;
    try { record = JSON.parse(await privateRead(filename(id, '.json'))); }
    catch (error) { if (error.code === 'ENOENT') return { removed: true }; throw error; }
    if (record.id !== id || record.scope !== key) throw failure('SOURCE_SCOPE_MISMATCH', '不能清理其他租户或用户的素材。');
    if (record.pinned) throw failure('SOURCE_PINNED', '已绑定素材不能自动清理。');
    await fs.unlink(filename(id, '.bin')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.unlink(filename(id, '.json'));
    return { removed: true };
  }
  async function assertRemovable({ scope, id } = {}) {
    const key = scopeKey(scope);
    let record;
    try { record = JSON.parse(await privateRead(filename(id, '.json'))); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (record.id !== id || record.scope !== key) throw failure('SOURCE_SCOPE_MISMATCH', '不能清理其他租户或用户的素材。');
    if (record.pinned) throw failure('SOURCE_PINNED', '已绑定素材不能自动清理。');
  }
  const groupStore = {
    async get(scope) {
      const key = scopeKey(scope);
      const file = path.join(directory, `group-${sha256(key)}.json`);
      let record;
      try { record = JSON.parse(await privateRead(file)); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (record.scope !== key) throw failure('SOURCE_GROUP_METADATA_INVALID', '素材组元数据无效。');
      if (record.pending === true) return { pending: true, name: record.name };
      if (!GROUP_ID.test(record.id)) throw failure('SOURCE_GROUP_METADATA_INVALID', '素材组元数据无效。');
      return { id: record.id, name: record.name };
    },
    async begin(scope, name) {
      const key = scopeKey(scope);
      const file = path.join(directory, `group-${sha256(key)}.json`);
      try {
        await fs.writeFile(file, JSON.stringify({ scope: key, pending: true, name: String(name || '').slice(0, 64) }), { flag: 'wx', mode: 0o600 });
        return true;
      } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    },
    async clearPending(scope) {
      const key = scopeKey(scope);
      const file = path.join(directory, `group-${sha256(key)}.json`);
      const record = JSON.parse(await privateRead(file));
      if (record.scope !== key || record.pending !== true) throw failure('SOURCE_GROUP_NOT_PENDING', '不能清除已绑定的素材组。');
      await fs.unlink(file);
    },
    async set(scope, group) {
      const key = scopeKey(scope);
      if (!group || !GROUP_ID.test(group.id)) throw failure('SOURCE_GROUP_ID_INVALID', '素材组标识无效。');
      const file = path.join(directory, `group-${sha256(key)}.json`);
      const temporary = path.join(directory, `group-write-${crypto.randomBytes(16).toString('hex')}.json`);
      await fs.writeFile(temporary, JSON.stringify({ scope: key, id: group.id, name: String(group.name || '').slice(0, 64) }), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, file);
    }
  };
  return { put, urlFor, readSigned, serve, cleanupExpired, markManaged, setPinned, remove, assertRemovable, groupStore, routePrefix: SOURCE_ROUTE };
}

module.exports = { createSourceStore, scopeKey, validateImage, MAX_IMAGE_BYTES, SOURCE_ROUTE };
