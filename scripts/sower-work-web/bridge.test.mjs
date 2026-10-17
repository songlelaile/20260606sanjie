import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { startBridge, createSiteAuthenticator, stripPrefix } from './bridge.mjs';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
const siteIdentity = { allowed: true, userId: 'admin-1', userName: '管理员', tenantId: 'tenant-1' };

async function fixture(t, { ready = true, authStatus = 200, recheckMs = 30000, cloudDetail, cloudWorkbench, detailBudget } = {}) {
  const temp = await mkdtemp(path.join(tmpdir(), 'sower-bridge-test-'));
  const htmlFile = path.join(temp, 'index.html');
  await writeFile(htmlFile, '<html><head><script type="module" src="./assets/app.js"></script></head></html>');
  const state = { authStatus, authReads: [], forwarded: [], revoked: [] };
  const upgraded = new Set();
  const auth = createServer((req, res) => {
    state.authReads.push(req.headers);
    res.writeHead(state.authStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(siteIdentity));
  });
  const authPort = await listen(auth);
  const control = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    state.forwarded.push({ path: req.url, method: req.method, headers: req.headers, body });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'sower_session=private; Path=/' });
    res.write('{"stream":');
    setImmediate(() => res.end('true}'));
  });
  control.on('upgrade', (req, socket) => {
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    state.forwarded.push({ path: req.url, method: req.method, headers: req.headers });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\n');
    socket.on('error', () => undefined);
  });
  const controlPort = await listen(control);
  const bridge = await startBridge({
    publicOrigin: 'https://shaozhuangai.com', controlPort, indexFile: htmlFile,
    authenticate: createSiteAuthenticator(`http://127.0.0.1:${authPort}/api/sower-work/access`),
    broker: { forSite(identity) { assert.deepEqual(identity, { userId: 'admin-1', userName: '管理员', tenantId: 'tenant-1' }); return { token: 'internal-private-session', csrf: 'internal-private-csrf' }; }, revoke(identity) { state.revoked.push(identity); } },
    engineReady: async () => ready, recheckMs, cloudDetail, cloudWorkbench, detailBudget,
  });
  const call = (route = '/', options = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: bridge.port, path: `/sower-work/app${route}`, method: options.method || 'GET', headers: { Host: 'shaozhuangai.com', Cookie: 'sanjie_session=site-cookie; sower_session=attacker', ...options.headers } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    req.on('error', reject);
    req.end(options.body);
  });
  t.after(async () => { await bridge.stop(); for (const socket of upgraded) socket.destroy(); await close(control); await close(auth); await rm(temp, { recursive: true, force: true }); });
  return { state, bridge, call };
}

test('rejects non-admin and anonymous accounts before serving HTML or contacting control', async (t) => {
  const { state, call } = await fixture(t, { authStatus: 403 });
  assert.equal((await call()).status, 403);
  state.authStatus = 401;
  assert.equal((await call('/api/conversations')).status, 401);
  assert.equal(state.forwarded.length, 0);
});

test('website-managed workbench cannot create independent orders, accept callbacks or change the legacy wallet', async (t) => {
  const { state, call } = await fixture(t);
  for (const route of ['/api/sower/billing/orders', '/api/sower/billing/notify', '/api/sower/billing/admin/orders/fixture-order/settle', '/api/sower/credits/consume', '/api/sower/credits/adjust', '/api/sower/credits/policy']) {
    const response = await call(route, { method: 'POST', headers: { Origin: 'https://shaozhuangai.com' }, body: '{}' });
    assert.equal(response.status, 409, route);
    assert.equal((await response.json()).error.code, 'CREDITS_MANAGED_BY_SANJIE');
  }
  assert.equal(state.forwarded.length, 0);
  assert.equal((await call('/api/sower/billing/orders')).status, 200, 'Legacy order reads remain read-only');
});

test('portable detail endpoints require authenticated site identity and do not enable paid multimodal work', async (t) => {
  const seen = [];
  const detail = { async handle(identity, body) { seen.push({ identity, body }); return { project: { version: 1 } }; } };
  const { state, call } = await fixture(t, { cloudDetail: detail });
  state.authStatus = 403;
  assert.equal((await call('/api/sower/detail-pages', { method: 'POST', headers: { Origin: 'https://shaozhuangai.com', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal(seen.length, 0);
  state.authStatus = 200;
  const health = (await (await call('/api/sower/health')).json()).data;
  assert.equal(health.capabilities.cloudDetailEditor, true);
  assert.equal(health.capabilities.multimodalBridge, false);
  const response = await call('/api/sower/detail-pages', { method: 'POST', headers: { Origin: 'https://shaozhuangai.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'load', userId: 'forged-user' }) });
  assert.equal(response.status, 200);
  assert.equal(seen[0].identity.token, 'internal-private-session');
  assert.deepEqual((await response.json()).data, { project: { version: 1 } });
  assert.equal((await call('/api/sower/detail-pages', { method: 'POST', headers: { Origin: 'https://shaozhuangai.com' }, body: '{}' })).status, 415);
  assert.equal(state.forwarded.length, 0);
});

test('portable UI and workbench handlers run only after authorization and use server-issued identity', async (t) => {
  const seen = [];
  const service = { capabilities: { cloudKeywordWorkbench: true }, async handle(_req, res, context) { seen.push(context); res.writeHead(200); res.end('fixture workbench'); return true; } };
  const { state, call } = await fixture(t, { cloudWorkbench: service });
  state.authStatus = 401;
  assert.equal((await call('/cloud-workbench')).status, 401);
  assert.equal(seen.length, 0);
  state.authStatus = 200;
  assert.equal(await (await call('/cloud-workbench')).text(), 'fixture workbench');
  assert.equal(seen[0].site.userId, 'admin-1');
  assert.equal(seen[0].identity.token, 'internal-private-session');
  assert.equal(state.forwarded.length, 0);
});

test('detail heavy operations reject overlap and excess starts, then release capacity after failure', async (t) => {
  let finish, started;
  const begun = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  const detail = { async handle() { calls++; if (calls === 1) { started(); await new Promise((resolve) => { finish = resolve; }); throw Object.assign(new Error('FIXTURE_IMPORT_FAILED'), { status: 400 }); } return { ok: true }; } };
  const { call } = await fixture(t, { cloudDetail: detail, detailBudget: { concurrent: 1, perMinute: 2 } });
  const request = () => call('/api/sower/detail-pages', { method: 'POST', headers: { Origin: 'https://shaozhuangai.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'export' }) });
  const first = request(); await begun;
  const overlap = await request(); assert.equal(overlap.status, 429); assert.equal((await overlap.json()).error.code, 'DETAIL_CAPACITY_BUSY');
  finish(); assert.equal((await first).status, 400);
  assert.equal((await request()).status, 200, 'Failed operation releases its concurrency slot');
  const excess = await request(); assert.equal(excess.status, 429); assert.equal((await excess.json()).error.code, 'DETAIL_RATE_LIMITED');
  assert.equal(calls, 2);
});

test('iframe readiness requires a real rendered layout and posts only to its same-origin parent', async () => {
  const makeElement = () => class { setAttribute() {} };
  const messages = [];
  const parent = { postMessage(data, origin) { messages.push({ data, origin }); } };
  const window = { parent, location: new URL('https://shaozhuangai.com/sower-work/app/?_frameToken=fixture-frame-token'), fetch: async (input) => input };
  const context = { window, URL, Request, XMLHttpRequest: class { open() {} }, Element: makeElement(), HTMLImageElement: makeElement(), HTMLAnchorElement: makeElement(), HTMLMediaElement: makeElement(), HTMLIFrameElement: makeElement(), HTMLSourceElement: makeElement(), navigator: {}, Promise, Error };
  vm.runInNewContext(await readFile(new URL('./browser-prefix.js', import.meta.url), 'utf8'), context);
  assert.equal(messages.length, 0, 'Backend health or script execution alone never acknowledges rendering');
  window.__sowerCloudNotifyReady(); window.__sowerCloudNotifyReady();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].origin, 'https://shaozhuangai.com');
  assert.equal(messages[0].data.token, 'fixture-frame-token');
});

test('checks live authorization on each request and never forwards client identities or internal cookies', async (t) => {
  const { state, call } = await fixture(t);
  const response = await call('/api/conversations?limit=3', { headers: { 'X-Sower-User': 'someone-else', 'X-User-Id': 'someone-else', Authorization: 'Bearer attacker' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), { stream: true });
  assert.equal(state.forwarded[0].path, '/api/conversations?limit=3');
  assert.equal(state.forwarded[0].headers.cookie, 'sower_session=internal-private-session');
  assert.equal(state.forwarded[0].headers['x-sower-user'], undefined);
  assert.equal(state.forwarded[0].headers['x-user-id'], undefined);
  assert.equal(state.forwarded[0].headers.authorization, undefined);
  assert.equal(state.authReads[0]['x-sower-user'], undefined);
  state.authStatus = 403;
  assert.equal((await call('/api/conversations')).status, 403);
  assert.equal(state.forwarded.length, 1);
  assert.equal(state.authReads.length, 2);
});

test('requires external same-origin Origin for writes before injecting internal CSRF', async (t) => {
  const { state, call } = await fixture(t);
  assert.equal((await call('/api/fs/upload', { method: 'POST', body: 'asset' })).status, 403);
  assert.equal((await call('/api/fs/upload', { method: 'POST', body: 'asset', headers: { Origin: 'https://attacker.example' } })).status, 403);
  const response = await call('/api/fs/upload', { method: 'POST', body: 'asset', headers: { Origin: 'https://shaozhuangai.com', 'X-Sower-Csrf': 'attacker' } });
  assert.equal(response.status, 200);
  assert.equal(state.forwarded[0].body, 'asset');
  assert.equal(state.forwarded[0].headers['x-sower-csrf'], 'internal-private-csrf');
  assert.match(state.forwarded[0].headers.origin, /^http:\/\/127\.0\.0\.1:/);
});

test('injects prefix mapping before renderer and reports current engine availability', async (t) => {
  const { call } = await fixture(t, { ready: false });
  const html = await (await call()).text();
  assert.ok(html.indexOf('_bridge-prefix.js') < html.indexOf('type="module"'));
  const status = await call('/_bridge-status');
  assert.equal(status.status, 503);
  assert.equal((await status.json()).ready, false);
  const health = await call('/api/sower/health');
  assert.equal(health.status, 503);
  assert.equal((await health.json()).data.ready, false);
});

test('does not expose local login, registration or SSO paths and fails closed on authorization failure', async (t) => {
  const { state, call } = await fixture(t);
  assert.equal((await call('/api/sower/sso/start')).status, 403);
  assert.equal((await call('/api/sower/register', { method: 'POST', headers: { Origin: 'https://shaozhuangai.com' } })).status, 403);
  state.authStatus = 500;
  assert.equal((await call()).status, 503);
});

test('rejects ambiguous and traversing paths', () => {
  assert.equal(stripPrefix('/sower-work/app/api/fs/stream?a=1'), '/api/fs/stream?a=1');
  for (const route of ['/api/fs/stream', '/sower-work/app/%2e%2e/config', '/sower-work/app/api%2ffoo', '/sower-work/app//../config']) assert.throws(() => stripPrefix(route));
});

test('upgrades authorized WebSockets with internal identity and closes them when site access is revoked', async (t) => {
  const { state, bridge } = await fixture(t, { recheckMs: 30 });
  const socket = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: bridge.port, path: '/sower-work/app/ws', headers: { Host: 'shaozhuangai.com', Origin: 'https://shaozhuangai.com', Cookie: 'sanjie_session=site-cookie', Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'test', 'Sec-WebSocket-Version': '13' } });
    req.on('upgrade', (_res, connection) => resolve(connection)); req.on('error', reject); req.end();
    req.on('response', (response) => { response.resume(); reject(new Error(`WS returned ${response.statusCode}`)); });
  });
  assert.equal(state.forwarded[0].path, '/ws');
  assert.equal(state.forwarded[0].headers.cookie, 'sower_session=internal-private-session');
  socket.resume();
  const closed = new Promise((resolve, reject) => { socket.on('close', resolve); setTimeout(() => reject(new Error('Authorization revocation did not close WS')), 1000).unref(); });
  state.authStatus = 403;
  await closed;
  assert.equal(state.revoked.length, 1);
});

test('maps same-origin HTTP and WS URLs, uploads and images without changing external URLs', async () => {
  const makeElement = () => class { setAttribute() {} };
  const Element = makeElement();
  const Xhr = class { open(...args) { this.last = args; } };
  const Socket = class { constructor(url) { this.url = url; } };
  const window = { location: new URL('https://shaozhuangai.com/sower-work/app/'), fetch: async (input) => input, WebSocket: Socket, EventSource: Socket };
  const context = { window, URL, Request, XMLHttpRequest: Xhr, Element, HTMLImageElement: makeElement(), HTMLAnchorElement: makeElement(), HTMLMediaElement: makeElement(), HTMLIFrameElement: makeElement(), HTMLSourceElement: makeElement(), navigator: {}, Promise, Error };
  vm.runInNewContext(await readFile(new URL('./browser-prefix.js', import.meta.url), 'utf8'), context);
  assert.equal(window.__sowerCloudPrefix('/api/conversations'), 'https://shaozhuangai.com/sower-work/app/api/conversations');
  assert.equal(new window.WebSocket('wss://shaozhuangai.com/ws').url, 'wss://shaozhuangai.com/sower-work/app/ws');
  const xhr = new Xhr(); xhr.open('POST', '/api/fs/upload');
  assert.equal(xhr.last[1], 'https://shaozhuangai.com/sower-work/app/api/fs/upload');
  assert.equal(window.__sowerCloudPrefix('https://external.example/api/foo'), 'https://external.example/api/foo');
  assert.equal(window.__sowerCloudPrefix('/sower-work/app/api/foo'), '/sower-work/app/api/foo');
});
