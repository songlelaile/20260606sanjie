#!/usr/bin/env node
import https from 'node:https';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { ECB_SOURCE_URL, FX_XML_MAX_BYTES, parseEcbXml, validateFxCache } from '../src/lib/model-gateway/exchange-rate-core.mjs';

const SELF = fileURLToPath(import.meta.url);
const TIMEOUT_MS = 10000;
function error(code) { const e = new Error(code); e.code = code; return e; }
function need(condition, code) { if (!condition) throw error(code); }
function safeCode(e) { return typeof e?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(e.code) ? e.code : 'FX_UPDATE_FAILED'; }
function statusError(code, committed, phase) {
  if (committed) return phase === 'status-commit' ? 'FX_STATUS_WRITE_FAILED_AFTER_CACHE_COMMIT' : 'FX_PERSIST_FAILED';
  if (code === 'FX_REFERENCE_DATE_ROLLBACK' || code === 'FX_FETCHED_AT_ROLLBACK') return code;
  if (code.startsWith('FX_FETCH_')) return 'FX_FETCH_FAILED';
  if (code.startsWith('FX_XML_') || code.startsWith('FX_CACHE_') || code.startsWith('FX_REFERENCE_') || code.startsWith('FX_EUR_') || code.startsWith('FX_CROSS_') || code.startsWith('FX_OLD_CACHE_') || code.startsWith('FX_FETCHED_AT_')) return 'FX_CACHE_INVALID';
  return 'FX_PERSIST_FAILED';
}

// Built-in HTTPS performs no automatic redirects or environment proxy lookup.
export function fetchEcbXml({ timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false, req, response;
    const started = performance.now();
    const agent = new https.Agent({ keepAlive: false, proxyEnv: {} });
    const finish = (err, result) => {
      if (settled) return; settled = true; clearTimeout(timer);
      agent.destroy();
      if (err) { response?.destroy(); req?.destroy(); reject(err); } else resolve(result);
    };
    const timer = setTimeout(() => finish(error('FX_FETCH_TIMEOUT')), timeoutMs);
    try { req = https.get(ECB_SOURCE_URL, { agent, rejectUnauthorized: true, headers: { Accept: 'text/xml, application/xml', 'Accept-Encoding': 'identity', 'User-Agent': 'Sanjie-Gateway-FX/1.0' } }, res => {
      response = res;
      if (res.statusCode !== 200) { finish(error(res.statusCode >= 300 && res.statusCode < 400 ? 'FX_FETCH_REDIRECT_REFUSED' : 'FX_FETCH_HTTP_FAILED')); return; }
      const type = (res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!['text/xml', 'application/xml'].includes(type) || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) { finish(error('FX_FETCH_CONTENT_TYPE_INVALID')); return; }
      const announced = res.headers['content-length'];
      if (announced && (!/^\d+$/.test(announced) || Number(announced) > FX_XML_MAX_BYTES)) { finish(error('FX_XML_SIZE_INVALID')); return; }
      const chunks = []; let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > FX_XML_MAX_BYTES) { finish(error('FX_XML_SIZE_INVALID')); return; }
        chunks.push(chunk);
      });
      res.on('aborted', () => finish(error('FX_FETCH_RESPONSE_ABORTED')));
      res.on('error', () => finish(error('FX_FETCH_NETWORK_FAILED')));
      res.on('end', () => {
        if (settled) return;
        if (!res.complete) { finish(error('FX_FETCH_RESPONSE_ABORTED')); return; }
        if (performance.now() - started > timeoutMs) { finish(error('FX_FETCH_TIMEOUT')); return; }
        try {
          const xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
          finish(null, { xml, receipt: { sourceUrl: ECB_SOURCE_URL, status: 200, redirects: 0, contentType: type, bodyBytes: bytes } });
        } catch { finish(error('FX_XML_ENCODING_INVALID')); }
      });
    }); } catch { finish(error('FX_FETCH_NETWORK_FAILED')); return; }
    req.on('error', () => finish(error('FX_FETCH_NETWORK_FAILED')));
  });
}

async function rejectSymlink(filename) {
  try { need(!(await fs.lstat(filename)).isSymbolicLink(), 'FX_PATH_SYMLINK_REFUSED'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
async function readCache(filename, now) {
  await rejectSymlink(filename);
  let handle;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat(); need(stats.isFile() && stats.size <= FX_XML_MAX_BYTES, 'FX_OLD_CACHE_FILE_INVALID');
    return validateFxCache(JSON.parse(await handle.readFile('utf8')), now, { allowExpired: true });
  } catch (e) { if (e.code === 'ENOENT') return null; if (e instanceof SyntaxError) throw error('FX_OLD_CACHE_FILE_INVALID'); throw e; }
  finally { await handle?.close(); }
}
async function prepareJson(filename, value) {
  await rejectSymlink(filename);
  const temporary = filename + '.tmp-' + process.pid + '-' + randomUUID();
  const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  catch (e) { await fs.unlink(temporary).catch(() => {}); throw e; }
  finally { await handle.close(); }
  return temporary;
}
async function commitJson(temporary, filename, renamed = () => {}) {
  await rejectSymlink(filename); await fs.rename(temporary, filename);
  renamed();
  const directory = await fs.open(path.dirname(filename), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function atomicJson(filename, value) {
  const temporary = await prepareJson(filename, value);
  try { await commitJson(temporary, filename); }
  finally { await fs.unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}

// Testable worker; production CLI calls it only under its OS-held flock.
export async function updateGatewayExchangeRate({ cacheFile, now = () => new Date() }, { fetchXml = fetchEcbXml } = {}) {
  need(typeof cacheFile === 'string' && path.isAbsolute(cacheFile), 'FX_CACHE_PATH_INVALID');
  const statusFile = cacheFile + '.status.json';
  await fs.mkdir(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
  let old = null, committed = false, next = null, cacheTemporary, statusTemporary, phase = 'cache-read';
  try {
    old = await readCache(cacheFile, now());
    const result = await fetchXml(); next = parseEcbXml(result.xml, now());
    if (old) {
      need(next.referenceDate >= old.referenceDate, 'FX_REFERENCE_DATE_ROLLBACK');
      need(next.referenceDate !== old.referenceDate || Date.parse(next.fetchedAt) >= Date.parse(old.fetchedAt), 'FX_FETCHED_AT_ROLLBACK');
    }
    const status = { version: 1, cacheId: next.id, fetchedAt: next.fetchedAt, attemptedAt: next.fetchedAt, success: true };
    // Both contents are durable before cache commit. Status binds to cacheId;
    // two independent paths are not a cross-file transaction.
    cacheTemporary = await prepareJson(cacheFile, next);
    statusTemporary = await prepareJson(statusFile, status);
    phase = 'cache-commit';
    await commitJson(cacheTemporary, cacheFile, () => { cacheTemporary = undefined; committed = true; });
    phase = 'status-commit';
    await commitJson(statusTemporary, statusFile); statusTemporary = undefined;
    return { ok: true, source: 'ecb', cacheId: next.id, referenceDate: next.referenceDate, rate: next.rate, fetchedAt: next.fetchedAt, cacheWritten: true, statusWritten: true, providerCalls: 0, paymentCalls: 0 };
  } catch (e) {
    const failure = { ok: false, code: safeCode(e), cachePreserved: !committed, cacheCommitted: committed, cacheId: committed ? next?.id : old?.id ?? null, referenceDate: committed ? next?.referenceDate : old?.referenceDate ?? null, fetchedAt: committed ? next?.fetchedAt : old?.fetchedAt ?? null, attemptedAt: now().toISOString(), providerCalls: 0, paymentCalls: 0 };
    try { await atomicJson(statusFile, { version: 1, cacheId: failure.cacheId, fetchedAt: failure.fetchedAt, attemptedAt: failure.attemptedAt, success: false, errorCode: statusError(failure.code, committed, phase) }); } catch { failure.statusWritten = false; }
    if (failure.statusWritten !== false) failure.statusWritten = true;
    return failure;
  } finally {
    for (const temporary of [cacheTemporary, statusTemporary]) if (temporary) await fs.unlink(temporary).catch(() => {});
  }
}

function cliArgs(argv) {
  let cacheFile, lockHeld = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cache' && !cacheFile && argv[i + 1] && !argv[i + 1].startsWith('--')) cacheFile = argv[++i];
    else if (argv[i] === '--lock-held' && !lockHeld) lockHeld = true;
    else throw error('FX_CLI_ARGUMENT_INVALID');
  }
  cacheFile ??= process.env.MODEL_GATEWAY_FX_CACHE_FILE;
  need(typeof cacheFile === 'string' && path.isAbsolute(cacheFile), 'FX_CACHE_PATH_INVALID');
  return { cacheFile: path.resolve(cacheFile), lockHeld };
}
async function verifyFlockParent(lockFile) {
  const exe = await fs.readlink('/proc/' + process.ppid + '/exe');
  const argv = (await fs.readFile('/proc/' + process.ppid + '/cmdline', 'utf8')).split('\0').filter(Boolean);
  need(path.basename(exe) === 'flock' && argv.includes(lockFile) && argv.includes(SELF), 'FX_OS_LOCK_REQUIRED');
}
async function cli() {
  try {
    const options = cliArgs(process.argv.slice(2));
    need(process.platform === 'linux', 'FX_LINUX_FLOCK_REQUIRED');
    await fs.mkdir(path.dirname(options.cacheFile), { recursive: true, mode: 0o700 });
    const lockFile = path.join(path.dirname(options.cacheFile), 'update.lock'); await rejectSymlink(lockFile);
    if (options.lockHeld) {
      await verifyFlockParent(lockFile);
      const result = await updateGatewayExchangeRate(options); process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.ok ? 0 : 1;
    } else {
      const child = spawn('/usr/bin/flock', ['-n', '-E', '75', lockFile, process.execPath, SELF, '--cache', options.cacheFile, '--lock-held'], { stdio: 'inherit' });
      child.once('error', () => { process.stdout.write(JSON.stringify({ ok: false, code: 'FX_FLOCK_UNAVAILABLE', providerCalls: 0, paymentCalls: 0 }) + '\n'); process.exitCode = 2; });
      child.once('exit', (code, signal) => { process.exitCode = code ?? 1; if (code === 75) process.stdout.write(JSON.stringify({ ok: false, code: 'FX_UPDATE_LOCK_BUSY', cachePreserved: true, providerCalls: 0, paymentCalls: 0 }) + '\n'); if (signal) process.exitCode = 1; });
    }
  } catch (e) { process.stdout.write(JSON.stringify({ ok: false, code: safeCode(e), providerCalls: 0, paymentCalls: 0 }) + '\n'); process.exitCode = 2; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) await cli();
