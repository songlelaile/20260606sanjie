#!/usr/bin/env node
/** Prepared locally; run only on the production host. Never prints sessions, keys or response bodies. */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ORIGIN = 'https://shaozhuangai.com';
const PREFIX = '/sower-work/app';
const LIFETIME = 300;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0d8AAAAASUVORK5CYII=', 'base64');
const PNG_SHA256 = 'c192371f83da2a29f1d2268819c0687e084bf4e2391072ccf515deb5430551f5';
const APP_KEYS = new Set(['DATABASE_URL', 'DIRECT_URL', 'SESSION_SECRET', 'PUBLIC_APP_ORIGIN', 'LEGACY_SESSION_ACCEPT_UNTIL']);
const appKey = (key) => APP_KEYS.has(key) || /^(?:SANJIE_|NEXT_PUBLIC_)/.test(key);
class SmokeError extends Error { constructor(code) { super(code); this.code = code; } }
const requireCondition = (condition, code) => { if (!condition) throw new SmokeError(code); };

export function parseArguments(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    requireCondition(['--candidate', '--site-name', '--output'].includes(key) && argv[i + 1] && args[key] === undefined, 'INVALID_ARGUMENTS');
    args[key] = argv[i + 1];
  }
  const candidate = args['--candidate'] || '/opt/sanjie-releases/20261002-sower-web-v1';
  const siteName = args['--site-name'] || 'sanjie-sower-web-20261002-v1';
  const output = args['--output'];
  requireCondition(path.isAbsolute(candidate) && path.dirname(candidate) === '/opt/sanjie-releases', 'CANDIDATE_ROOT_REJECTED');
  requireCondition(/^[A-Za-z0-9_-]{1,100}$/.test(siteName), 'PROCESS_NAME_REJECTED');
  if (output) requireCondition(path.isAbsolute(output) && path.dirname(output) === '/var/tmp', 'OUTPUT_PATH_REJECTED');
  return { candidate, siteName, output };
}

// Matches post-cutover-acceptance.mjs; the real candidate auth parser checks this before HTTP.
export function signShortSession(user, secret, now = Math.floor(Date.now() / 1000)) {
  requireCondition(typeof secret === 'string' && secret.length >= 32 && !secret.startsWith('change-me-'), 'SESSION_SECRET_UNAVAILABLE');
  const payload = encodeURIComponent(JSON.stringify({ username: user.username, role: user.authRole, name: user.name, tenantId: user.tenantId, iat: now, exp: now + LIFETIME }));
  return `${createHmac('sha256', secret).update(payload).digest('hex')}.${payload}`;
}

function call(route, cookie, { method = 'GET', json, body, headers = {} } = {}) {
  requireCondition(route.startsWith(PREFIX + '/') || route === '/api/sower-work/access', 'HTTP_ROUTE_REJECTED');
  requireCondition(method === 'GET' || (method === 'POST' && [PREFIX + '/api/conversations', PREFIX + '/api/fs/upload'].includes(route)), 'HTTP_WRITE_REJECTED');
  const bytes = json === undefined ? body : Buffer.from(JSON.stringify(json));
  return new Promise((resolve, reject) => {
    const req = request(new URL(route, ORIGIN), { method, signal: AbortSignal.timeout(15000), headers: { Cookie: cookie, Origin: ORIGIN, Accept: 'application/json', 'User-Agent': 'SowerWorkProductionSmoke/1.0', ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...(bytes === undefined ? {} : { 'Content-Length': bytes.byteLength }), ...headers } }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (chunk) => { size += chunk.byteLength; if (size > 5 * 1024 * 1024) req.destroy(new SmokeError('HTTP_BODY_TOO_LARGE')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        const bytes = Buffer.concat(chunks); let value;
        try { value = JSON.parse(bytes.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, bytes, value });
      });
    });
    req.on('error', reject); req.end(bytes);
  });
}

function websocket(cookie) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const req = request(new URL(PREFIX + '/ws', ORIGIN), { signal: AbortSignal.timeout(15000), headers: { Cookie: cookie, Origin: ORIGIN, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', 'User-Agent': 'SowerWorkProductionSmoke/1.0' } });
    req.on('upgrade', (res, socket) => {
      socket.on('error', () => undefined);
      const pass = res.statusCode === 101 && res.headers['sec-websocket-accept'] === expected && String(res.headers.upgrade).toLowerCase() === 'websocket';
      socket.destroy();
      if (pass) resolve({ status: 101, pass: true });
      else reject(new SmokeError('WEBSOCKET_HANDSHAKE_INVALID'));
    });
    req.on('response', (res) => { res.resume(); reject(new SmokeError('WEBSOCKET_UPGRADE_REJECTED')); });
    req.on('error', reject); req.end();
  });
}

export async function runSmoke(args) {
  let client, cookie, stage = 'production-preflight';
  const result = { schema: 'SOWER_WEB_PRODUCTION_HTTP_SMOKE_V1', origin: ORIGIN, at: new Date().toISOString(), checks: [], websiteDatabaseReadOnly: false, sessionCookiesPrinted: false, databaseCredentialsPrinted: false, loginEndpointCalled: false, modelMessagesSubmitted: 0, externalProviderRequestsSubmitted: 0, providerConfigurationWrites: 0, syntheticSessionLifetimeSeconds: LIFETIME, fixtureConversationCreated: false, fixtureRetainedInCloudOnly: false };
  const checked = (name, response, pass, extras = {}) => {
    result.checks.push({ name, status: response.status, pass, ...extras });
    requireCondition(pass, 'CHECK_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_FAILED');
  };
  try {
    requireCondition(process.platform === 'linux', 'PRODUCTION_LINUX_HOST_REQUIRED');
    const rows = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }));
    const found = rows.filter((row) => row.name === args.siteName);
    requireCondition(found.length === 1 && found[0].pid > 0 && found[0].pm2_env?.status === 'online', 'SITE_PROCESS_NOT_ONLINE');
    const site = found[0];
    requireCondition(site.pm2_env.pm_cwd === args.candidate && String(site.pm2_env.PORT) === '32151', 'SITE_IDENTITY_MISMATCH');
    for (const key of Object.keys(process.env)) if (appKey(key)) delete process.env[key];
    for (const [key, value] of Object.entries(site.pm2_env)) if (appKey(key) && ['string', 'number', 'boolean'].includes(typeof value)) process.env[key] = String(value);
    process.env.NODE_ENV = 'production';
    const candidateRequire = createRequire(path.join(args.candidate, 'package.json'));
    candidateRequire('@next/env').loadEnvConfig(args.candidate, false, { info() {}, error() {} }, true);
    requireCondition(process.env.DATABASE_URL && process.env.SESSION_SECRET?.length >= 32, 'SITE_ENVIRONMENT_UNAVAILABLE');
    const cookieName = process.env.SANJIE_SESSION_COOKIE_NAME || 'sanjie_session';
    requireCondition(/^[A-Za-z0-9_-]+$/.test(cookieName), 'SESSION_COOKIE_NAME_REJECTED');

    stage = 'read-only-admin-selection';
    const { PrismaClient } = candidateRequire('@prisma/client');
    client = new PrismaClient({ log: [], datasources: { db: { url: process.env.DATABASE_URL } } });
    const admin = await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const readOnly = await tx.$queryRawUnsafe('SHOW transaction_read_only');
      requireCondition(readOnly[0]?.transaction_read_only === 'on', 'DATABASE_TRANSACTION_NOT_READ_ONLY');
      const user = await tx.user.findFirst({ where: { status: 'active', authRole: 'admin', tenant: { shops: { some: {} } } }, orderBy: { id: 'asc' }, select: { id: true, username: true, name: true, tenantId: true, authRole: true } });
      requireCondition(user?.authRole === 'admin' && user.tenantId && user.username, 'ACTIVE_ADMIN_UNAVAILABLE');
      return user;
    }, { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 });
    result.websiteDatabaseReadOnly = true;

    stage = 'official-session-validation';
    const authSource = await readFile(path.join(args.candidate, 'src/lib/auth.ts'), 'utf8');
    const ts = candidateRequire('typescript');
    const parsed = ts.createSourceFile('auth.ts', authSource, ts.ScriptTarget.Latest, true);
    requireCondition(!parsed.statements.some((statement) => ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)), 'AUTH_MODULE_IMPORT_SCOPE_CHANGED');
    const emitted = ts.transpileModule(authSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const auth = await import('data:text/javascript;base64,' + Buffer.from(emitted).toString('base64'));
    requireCondition(auth.SESSION_COOKIE === cookieName && auth.SESSION_MAX_AGE_SECONDS >= LIFETIME, 'AUTH_COOKIE_CONTRACT_CHANGED');
    const signed = signShortSession(admin, process.env.SESSION_SECRET);
    const session = await auth.parseSession(signed);
    requireCondition(session?.username === admin.username && session?.role === 'admin' && session?.tenantId === admin.tenantId, 'OFFICIAL_SESSION_VALIDATION_FAILED');
    // NextResponse.cookies.set encodes the complete signed value for the wire.
    // RequestCookies decodes one layer before auth.parseSession verifies HMAC.
    cookie = `${cookieName}=${encodeURIComponent(signed)}`;
    result.officialParserAcceptedShortSession = true;

    stage = 'public-session-and-lists';
    const access = await call('/api/sower-work/access', cookie);
    checked('active-admin-access', access, access.status === 200 && access.value?.allowed === true && access.value.userId === admin.id && access.value.tenantId === admin.tenantId);
    const health = await call(PREFIX + '/api/sower/health', cookie);
    checked('engine-ready', health, health.status === 200 && health.value?.success === true && health.value.data?.ready === true);
    const actor = await call(PREFIX + '/api/auth/user', cookie);
    checked('engine-session', actor, actor.status === 200 && actor.value?.success === true && typeof actor.value.user?.id === 'string');
    const sower = await call(PREFIX + '/api/sower/session', cookie);
    checked('sower-session', sower, sower.status === 200 && sower.value?.success === true && sower.value.data?.user?.id === actor.value.user.id && typeof sower.value.data?.workspace?.id === 'string');
    const assistants = await call(PREFIX + '/api/assistants', cookie);
    const assistantCount = Array.isArray(assistants.value?.data) ? assistants.value.data.length : -1;
    checked('assistant-list', assistants, assistants.status === 200 && assistantCount > 0, { count: assistantCount });
    const providers = await call(PREFIX + '/api/providers', cookie);
    checked('provider-list', providers, providers.status === 200 && Array.isArray(providers.value?.data), { count: Array.isArray(providers.value?.data) ? providers.value.data.length : -1 });

    stage = 'public-websocket';
    const ws = await websocket(cookie);
    checked('websocket-upgrade', ws, ws.pass);

    stage = 'cloud-fixture-conversation';
    const stamp = new Date().toISOString().replace(/[^A-Za-z0-9]/g, '') + '-' + randomBytes(4).toString('hex');
    // The real engine accepts this unused model reference. No provider is created or called.
    const created = await call(PREFIX + '/api/conversations', cookie, { method: 'POST', json: { type: 'aionrs', name: 'Sower Work web upload UAT ' + stamp + '; no model messages', model: { provider_id: 'fixture-never-send', model: 'fixture-never-send' }, extra: {} } });
    checked('fixture-conversation-create', created, [200, 201].includes(created.status) && typeof created.value?.data?.id === 'string');
    const conversationId = created.value.data.id;
    requireCondition(/^[A-Za-z0-9_-]+$/.test(conversationId), 'FIXTURE_CONVERSATION_ID_REJECTED');
    result.fixtureConversationCreated = true;
    result.fixtureRetainedInCloudOnly = true;
    result.fixtureName = 'Sower Work web upload UAT ' + stamp;
    const listed = await call(PREFIX + '/api/conversations?limit=1000', cookie);
    checked('fixture-conversation-list', listed, listed.status === 200 && Array.isArray(listed.value?.data?.items) && listed.value.data.items.some((row) => row.id === conversationId));

    stage = 'public-upload-and-image-stream';
    const boundary = 'sower-uat-' + randomBytes(12).toString('hex');
    const multipart = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="conversation_id"\r\n\r\n${conversationId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sower-uat-1x1.png"\r\nContent-Type: image/png\r\n\r\n`), PNG, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const upload = await call(PREFIX + '/api/fs/upload', cookie, { method: 'POST', body: multipart, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
    checked('png-upload', upload, upload.status === 200 && typeof upload.value?.data === 'string' && path.isAbsolute(upload.value.data));
    const stream = await call(PREFIX + '/api/fs/stream?kind=local&path=' + encodeURIComponent(upload.value.data), cookie);
    const imageHash = createHash('sha256').update(stream.bytes).digest('hex');
    checked('png-stream-exact', stream, stream.status === 200 && stream.bytes.equals(PNG) && imageHash === PNG_SHA256, { bytes: stream.bytes.length, sha256: imageHash });
    result.passed = result.checks.length === 11 && result.checks.every((check) => check.pass);
  } catch (error) {
    result.passed = false;
    result.failureStage = stage;
    result.failureCode = error instanceof SmokeError ? error.code : 'SMOKE_OPERATION_FAILED';
  } finally {
    cookie = null;
    process.env.SESSION_SECRET = '';
    process.env.DATABASE_URL = '';
    process.env.DIRECT_URL = '';
    await client?.$disconnect().catch(() => undefined);
  }
  result.finishedAt = new Date().toISOString();
  if (args.output) await writeFile(args.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runSmoke(parseArguments(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch { console.error('STOP: SMOKE_REPORT_FAILED'); process.exitCode = 1; }
}
