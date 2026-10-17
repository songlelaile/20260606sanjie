import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const releaseSource = process.env.SOWER_LIVE_RELEASE;
const engineBundle = process.env.SOWER_LIVE_ENGINE_BUNDLE;
const dependencyRoot = process.env.SOWER_LIVE_DEPENDENCIES;
const evidenceDir = process.env.SOWER_LIVE_EVIDENCE_DIR;
const listen = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });

test('accepts real standalone engine identities, owner provider settings, WS, upload and image bytes without model calls', { skip: !releaseSource || !engineBundle || !dependencyRoot, timeout: 90000 }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'sower-cloud-live-')));
  const release = path.join(root, 'release');
  const data = path.join(root, 'runtime');
  fs.cpSync(releaseSource, release, { recursive: true });
  fs.symlinkSync(dependencyRoot, path.join(release, 'node_modules'));
  let providerCalls = 0, child, output = '', websocket, uploadedFile, otherSocket;
  const otherEvents = [];
  const evidence = { startedAt: new Date().toISOString(), independentRuntime: root, realEngine: true, providerCalls: 0, modelMessageCalls: 0, checks: [] };
  const fakeProvider = createServer((_req, res) => { providerCalls++; res.writeHead(500); res.end('Provider execution is forbidden during this test'); });
  const auth = createServer((req, res) => {
    const account = req.headers.cookie?.includes('fixture-admin-b') ? 'b' : 'a';
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ allowed: true, userId: `fixture-site-admin-${account}`, userName: `隔离管理${account}`, tenantId: 'fixture-cloud-tenant' }));
  });
  await listen(auth, 32161);
  await listen(fakeProvider, 32162);
  t.after(async () => {
    websocket?.destroy();
    otherSocket?.terminate();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      let timer;
      await Promise.race([once(child, 'exit'), new Promise((resolve) => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 7000); })]);
      clearTimeout(timer);
    }
    await close(auth); await close(fakeProvider);
    evidence.providerCalls = providerCalls;
    evidence.finishedAt = new Date().toISOString();
    if (evidenceDir) {
      fs.mkdirSync(evidenceDir, { recursive: true });
      fs.writeFileSync(path.join(evidenceDir, 'actual-engine.json'), JSON.stringify(evidence, null, 2));
      fs.writeFileSync(path.join(evidenceDir, 'runtime-output.log'), output);
      const log = path.join(data, 'engine.log');
      if (fs.existsSync(log)) fs.copyFileSync(log, path.join(evidenceDir, 'engine.log'));
    }
    fs.rmSync(root, { recursive: true, force: true });
    if (uploadedFile && !uploadedFile.startsWith(root) && path.basename(uploadedFile) === 'fixture-original.png') {
      fs.rmSync(uploadedFile, { force: true });
      try { fs.rmdirSync(path.dirname(uploadedFile)); } catch {}
    }
  });
  child = spawn(process.execPath, ['--import', 'tsx', 'runtime/runtime.mjs'], { cwd: release, env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', SOWER_WEB_RUNTIME_DIR: data, SOWER_WEB_PUBLIC_ORIGIN: 'https://shaozhuangai.com', SOWER_WEB_ACCESS_URL: 'http://127.0.0.1:32161/api/sower-work/access', SOWER_WEB_PORT: '32160', SOWER_WEB_ENGINE_BUNDLE: engineBundle }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  const call = (route, { method = 'GET', json, body, headers = {}, account = 'a' } = {}) => new Promise((resolve, reject) => {
    const payload = json === undefined ? body : JSON.stringify(json);
    const req = request({ host: '127.0.0.1', port: 32160, path: `/sower-work/app${route}`, method, headers: { Host: 'shaozhuangai.com', Origin: 'https://shaozhuangai.com', Cookie: `fixture=fixture-admin-${account}`, ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }), ...headers } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => { const bytes = Buffer.concat(chunks); let value; try { value = JSON.parse(bytes); } catch {} resolve({ status: res.statusCode, headers: res.headers, value, bytes }); });
    });
    req.on('error', reject); req.end(payload);
  });
  let started = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`Runtime exited: ${output}`);
    try { const health = await call('/_bridge-status'); if (health.status === 200 && health.value.ready) { started = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(started, output);
  evidence.checks.push('engine health and bridge ready');
  const actor = await call('/api/auth/user');
  assert.equal(actor.status, 200, actor.bytes.toString());
  assert.equal(actor.value.success, true);
  evidence.actor = { userId: actor.value.user?.id, username: actor.value.user?.username, scopeKey: actor.value.scopeKey };
  evidence.checks.push('real external actor session');
  const assistants = await call('/api/assistants');
  assert.equal(assistants.status, 200, assistants.bytes.toString());
  assert.ok(Array.isArray(assistants.value.data) && assistants.value.data.length > 0);
  evidence.assistantCount = assistants.value.data.length;
  evidence.checks.push('builtin assistant list');
  const empty = await call('/api/providers');
  assert.equal(empty.status, 200, empty.bytes.toString());
  assert.deepEqual(empty.value.data, []);
  evidence.checks.push('no imported desktop providers');
  const provider = await call('/api/providers', { method: 'POST', json: { platform: 'custom', name: 'fixture-local-disabled', base_url: 'http://127.0.0.1:32162/v1', api_key: 'fixture-invalid-key', models: ['fixture-model'], enabled: true } });
  assert.equal(provider.status, 201, provider.bytes.toString());
  const providerId = provider.value.data.id;
  const updated = await call(`/api/providers/${providerId}`, { method: 'PUT', json: { name: 'fixture-owner-settings-verified' } });
  assert.equal(updated.status, 200, updated.bytes.toString());
  const list = await call('/api/providers');
  assert.ok(list.value.data.some((row) => row.id === providerId && row.name === 'fixture-owner-settings-verified'));
  const otherProviders = await call('/api/providers', { account: 'b' });
  assert.equal(otherProviders.status, 200, otherProviders.bytes.toString());
  assert.deepEqual(otherProviders.value.data, []);
  const unauthorizedProviderChange = await call(`/api/providers/${providerId}`, { method: 'PUT', account: 'b', json: { name: 'cross-user-attack' } });
  assert.ok([403, 404].includes(unauthorizedProviderChange.status), `Cross-user provider mutation returned ${unauthorizedProviderChange.status}`);
  evidence.checks.push('owner provider create/update and cross-user isolation');
  const Ws = createRequire(import.meta.url)(path.join(dependencyRoot, 'ws'));
  otherSocket = new Ws('ws://127.0.0.1:32160/sower-work/app/ws', { headers: { Host: 'shaozhuangai.com', Origin: 'https://shaozhuangai.com', Cookie: 'fixture=fixture-admin-b' } });
  otherSocket.on('message', (bytes) => otherEvents.push(bytes.toString()));
  await once(otherSocket, 'open');
  websocket = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: 32160, path: '/sower-work/app/ws', headers: { Host: 'shaozhuangai.com', Origin: 'https://shaozhuangai.com', Cookie: 'fixture=fixture-admin-a', Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': Buffer.alloc(16, 3).toString('base64'), 'Sec-WebSocket-Version': '13' } });
    req.on('upgrade', (res, socket) => { evidence.websocketStatus = res.statusCode; socket.on('error', () => undefined); socket.resume(); resolve(socket); });
    req.on('response', (res) => { res.resume(); reject(new Error(`Real WS returned ${res.statusCode}`)); }); req.on('error', reject); req.end();
  });
  assert.equal(evidence.websocketStatus, 101);
  evidence.checks.push('real websocket 101');
  const created = await call('/api/conversations', { method: 'POST', json: { type: 'aionrs', name: 'Fixture upload acceptance; never send a message', model: { provider_id: providerId, model: 'fixture-model' }, extra: {} } });
  assert.ok([200, 201].includes(created.status), created.bytes.toString());
  const conversationId = created.value.data.id;
  const workspace = created.value.data.extra?.workspace;
  assert.equal(typeof workspace, 'string');
  assert.ok(workspace.startsWith(path.join(data, 'workspaces/cloud-users')), workspace);
  evidence.accountWorkspace = workspace;
  evidence.fixtureConversationShape = { keys: Object.keys(created.value.data), extra: created.value.data.extra, project_id: created.value.data.project_id };
  const sidebar = await call('/api/sidebar/items');
  evidence.fixtureSidebar = sidebar.value?.data;
  const db = new DatabaseSync(path.join(data, 'engine/aionui-backend.db'), { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%project%'").all();
    evidence.fixtureProjectTables = Object.fromEntries(tables.map((row) => [row.name, db.prepare(`SELECT * FROM "${row.name}" LIMIT 20`).all()]));
  } finally { db.close(); }
  const crossConversation = await call(`/api/conversations/${conversationId}`, { account: 'b' });
  assert.ok([403, 404].includes(crossConversation.status), `Cross-user conversation returned ${crossConversation.status}`);
  const conversations = await call('/api/conversations');
  assert.equal(conversations.status, 200, conversations.bytes.toString());
  evidence.conversationId = conversationId;
  evidence.checks.push('conversation created and listed without sending');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0d8AAAAASUVORK5CYII=', 'base64');
  const boundary = 'sower-fixture-upload-boundary';
  const multipart = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="conversation_id"\r\n\r\n${conversationId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture-original.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const upload = await call('/api/fs/upload', { method: 'POST', body: multipart, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(upload.status, 200, upload.bytes.toString());
  assert.equal(typeof upload.value.data, 'string');
  uploadedFile = upload.value.data;
  assert.ok(upload.value.data.startsWith(root), upload.value.data);
  const stream = await call(`/api/fs/stream?kind=local&path=${encodeURIComponent(upload.value.data)}`);
  assert.equal(stream.status, 200, stream.bytes.toString());
  assert.deepEqual(stream.bytes, png);
  const crossStream = await call(`/api/fs/stream?kind=local&path=${encodeURIComponent(upload.value.data)}`, { account: 'b' });
  assert.ok([403, 404].includes(crossStream.status), `Cross-user file stream returned ${crossStream.status}`);
  evidence.imageSha256 = createHash('sha256').update(stream.bytes).digest('hex');
  evidence.checks.push('real multipart upload and exact image stream; cross-user denied');
  const content = await call('/api/fs/content', { method: 'POST', json: { file: { kind: 'local', path: uploadedFile }, encoding: 'base64' } });
  assert.equal(content.status, 200, content.bytes.toString());
  assert.equal(content.value.data, png.toString('base64'));
  const otherContent = await call('/api/fs/content', { method: 'POST', account: 'b', json: { file: { kind: 'local', path: uploadedFile }, encoding: 'base64' } });
  assert.equal(otherContent.status, 403);
  const crossUpload = await call('/api/fs/upload', { method: 'POST', account: 'b', body: multipart, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
  assert.ok([403, 404].includes(crossUpload.status));
  const badFilename = Buffer.from(multipart.toString('binary').replace('fixture-original.png', '../../evil.png'), 'binary');
  assert.equal((await call('/api/fs/upload', { method: 'POST', body: badFilename, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } })).status, 403);
  const generated = path.join(workspace, 'generated-fixture.png');
  fs.writeFileSync(generated, png);
  assert.equal((await call(`/api/fs/stream?kind=local&path=${encodeURIComponent(generated)}`)).status, 200);
  assert.equal((await call(`/api/fs/stream?kind=local&path=${encodeURIComponent(generated)}`, { account: 'b' })).status, 403);
  const projectRow = evidence.fixtureProjectTables.projects[0];
  const explorerRow = evidence.fixtureProjectTables.project_explorer[0];
  assert.equal((await call(`/api/projects/${projectRow.project_id}`)).status, 200);
  assert.ok([403, 404].includes((await call(`/api/projects/${projectRow.project_id}`, { account: 'b' })).status));
  const projectStream = `/api/fs/stream?kind=project&pe_id=${explorerRow.pe_id}&relative_path=generated-fixture.png&conversation_id=${conversationId}`;
  const ownProjectFile = await call(projectStream);
  assert.equal(ownProjectFile.status, 200, ownProjectFile.bytes.toString());
  assert.deepEqual(ownProjectFile.bytes, png);
  const otherProjectFile = await call(projectStream, { account: 'b' });
  assert.ok([403, 404].includes(otherProjectFile.status), `Cross-user project stream returned ${otherProjectFile.status}`);
  evidence.checks.push('real own project stream and cross-user project/conversation stream denied by core');
  const otherActor = await call('/api/sower/session', { account: 'b' });
  const otherRoot = path.join(data, 'workspaces/cloud-users', otherActor.value.data.user.id, otherActor.value.data.workspace.id);
  const symlink = path.join(otherRoot, 'cross-account-link.png');
  fs.symlinkSync(generated, symlink);
  assert.equal((await call(`/api/fs/stream?kind=local&path=${encodeURIComponent(symlink)}`, { account: 'b' })).status, 403);
  assert.equal((await call(`/api/fs/stream?kind=local&path=${encodeURIComponent(workspace + '/../secrets')}`)).status, 403);
  assert.equal((await call('/api/conversations', { method: 'POST', account: 'b', json: { type: 'aionrs', extra: { default_files: [generated] } } })).status, 403);
  assert.equal((await call('/api/projects/fixture/folders', { method: 'POST', account: 'b', json: { uri: `file://${workspace}` } })).status, 403);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!otherEvents.some((message) => message.includes(conversationId) || message.includes('fixture-invalid-key') || message.includes(workspace)), 'Account B received account A private WS data');
  evidence.checks.push('content preview, generated file ownership, multipart conversation ownership, traversal/symlink/URI protection, WS data isolation');
  assert.equal(providerCalls, 0, 'Fixture provider must receive no model or discovery calls');
  const removed = await call(`/api/providers/${providerId}`, { method: 'DELETE' });
  assert.ok([200, 204].includes(removed.status), removed.bytes.toString());
  evidence.passed = true;
});
