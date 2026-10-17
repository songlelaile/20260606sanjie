import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createCloudDetailService } from './index.mjs';
import { createCloudFilesystem } from '../filesystem.mjs';

const source = process.env.SOWER_DETAIL_SOURCE;
if (!source || !path.isAbsolute(source)) throw new Error('Set absolute SOWER_DETAIL_SOURCE to the read-only control source');
const { DetailPageService } = await import(path.join(source, 'multimodal/detailPages/service.ts'));
const { readOwnedFile, inspectOwnedImage } = await import(path.join(source, 'multimodal/production/files.ts'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const evidence = { tier: 'independent authenticated HTTP + actual portable DetailPageService + actual cloud filesystem + isolated SQLite; fixture actors and upload transport; no engine/model/provider calls', startedAt: new Date().toISOString(), checks: [], providerCalls: 0, artifacts: [] };
const evidenceDir = process.env.SOWER_DETAIL_EVIDENCE_DIR;
after(async () => {
  evidence.finishedAt = new Date().toISOString();
  if (evidenceDir) { await fs.mkdir(evidenceDir, { recursive: true }); await fs.writeFile(path.join(evidenceDir, 'cloud-detail-http.json'), JSON.stringify(evidence, null, 2)); }
});

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'cloud-detail-http-')));
  const db = new DatabaseSync(':memory:');
  const store = { db };
  const filesystem = createCloudFilesystem(root, store);
  const actors = { a: { userId: 'fixture-user-a', workspaceId: 'fixture-tenant' }, b: { userId: 'fixture-user-b', workspaceId: 'fixture-tenant' } };
  const conversations = new Map();
  for (const [name, actor] of Object.entries(actors)) {
    const workspace = path.join(filesystem.getAccountRoot(actor), 'conversations', `conversation-${name}`);
    await fs.mkdir(workspace, { recursive: true });
    conversations.set(`conversation-${name}`, { id: `conversation-${name}`, owner: name, extra: { workspace } });
  }
  const service = await createCloudDetailService({ runtimeDir: root, store, filesystem, DetailPageService, readFileSnapshot: readOwnedFile, inspectImage: inspectOwnedImage, readConversation: async (identity, id) => {
    const conversation = conversations.get(id);
    return conversation?.owner === (identity.userId === actors.a.userId ? 'a' : 'b') ? conversation : null;
  } });
  const server = createServer(async (req, res) => {
    const identity = actors[req.headers['x-fixture-account'] || 'a'];
    try {
      if (!identity) throw Object.assign(new Error('LOGIN_REQUIRED'), { status: 401 });
      if (await service.servePage(req, res, { path: req.url, identity })) return;
      const chunks = []; for await (const bytes of req) chunks.push(bytes);
      const body = Buffer.concat(chunks);
      let data;
      if (req.url === '/upload') {
        const directory = path.join(root, 'tmp', identity.userId);
        await fs.mkdir(directory, { recursive: true });
        const file = path.join(directory, `${digest(body)}.png`);
        await fs.writeFile(file, body); filesystem.registerUpload(identity, file); data = { path: file, sha256: digest(body) };
      } else if (req.url === '/detail') data = await service.handle(identity, JSON.parse(body));
      else throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, data }));
    } catch (error) { res.writeHead(error.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: { code: error.code || error.message } })); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, body, account = 'a') => {
    const response = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-account': account }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  const upload = async (bytes, account = 'a') => {
    const response = await fetch(url + '/upload', { method: 'POST', headers: { 'x-fixture-account': account }, body: bytes });
    assert.equal(response.status, 200);
    return (await response.json()).data;
  };
  t.after(async () => {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); db.close(); await fs.rm(root, { recursive: true, force: true });
    assert.equal(await fs.stat(root).then(() => true, () => false), false);
  });
  return { root, call, upload, service, actors, conversations, url };
}

const projectFor = (assets) => ({ id: 'fixture-detail', conversationId: 'conversation-a', title: 'Fixture detail', revision: 0, width: 750, sections: assets.map((asset, index) => ({ id: `section-${index}`, title: `Section ${index}`, selectedVersionId: asset.id, versions: [asset], editDraft: '' })), updatedAt: 0 });
function zipEntries(bytes) {
  const entries = []; let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    entries.push({ name: bytes.subarray(offset + 30, offset + 30 + nameLength).toString(), bytes: bytes.subarray(start, start + size) }); offset = start + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  return entries;
}

test('uploaded originals become immutable editable assets and proportional whole/ZIP exports', async (t) => {
  const f = await fixture(t);
  const red = await sharp({ create: { width: 300, height: 400, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const blue = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#0000ff' } }).png().toBuffer();
  const original = [await f.upload(red), await f.upload(blue)];
  const imported = await f.call('/detail', { action: 'import', conversationId: 'conversation-a', files: original });
  assert.equal(imported.status, 200);
  const assets = imported.value.data.imported.map((item) => imported.value.data.assets.find((asset) => asset.path === item.path));
  assert.deepEqual(assets.map((asset) => asset.sha256), original.map((item) => item.sha256));
  const saved = await f.call('/detail', { action: 'save', conversationId: 'conversation-a', expectedRevision: null, project: projectFor(assets) });
  assert.equal(saved.status, 200); assert.equal(saved.value.data.project.revision, 0);
  const edited = structuredClone(saved.value.data.project); edited.title = 'Saved through HTTP'; edited.sections.reverse();
  const changed = await f.call('/detail', { action: 'save', conversationId: 'conversation-a', expectedRevision: 0, project: edited });
  assert.equal(changed.status, 200);
  const loaded = await f.call('/detail', { action: 'load', conversationId: 'conversation-a' });
  assert.equal(loaded.value.data.project.title, 'Saved through HTTP'); assert.equal(loaded.value.data.project.revision, 1);
  for (const format of ['whole', 'slices']) {
    const exported = await f.call('/detail', { action: 'export', conversationId: 'conversation-a', projectId: 'fixture-detail', expectedRevision: 1, format });
    assert.equal(exported.status, 200);
    const file = exported.value.data.files[0], bytes = await fs.readFile(file.path);
    assert.equal(digest(bytes), file.sha256);
    const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(file.path), 'manifest.json'), 'utf8'));
    assert.equal(manifest.projectRevision, 1); assert.equal(manifest.height, 2000);
    if (format === 'whole') {
      const meta = await sharp(bytes).metadata(); assert.equal(meta.width, 750); assert.equal(meta.height, 2000);
      const first = await sharp(bytes).extract({ left: 0, top: 0, width: 1, height: 1 }).removeAlpha().raw().toBuffer(); assert.deepEqual([...first], [0, 0, 255]);
    } else {
      const entries = zipEntries(bytes); assert.deepEqual(entries.map((entry) => entry.name), ['01.png', '02.png']);
      for (const entry of entries) { const meta = await sharp(entry.bytes).metadata(); assert.equal(meta.width, 750); assert.equal(meta.height, 1000); }
    }
    if (evidenceDir) { await fs.mkdir(evidenceDir, { recursive: true }); await fs.writeFile(path.join(evidenceDir, file.name), bytes); await fs.writeFile(path.join(evidenceDir, `${format}-manifest.json`), JSON.stringify(manifest, null, 2)); }
    evidence.artifacts.push({ format, name: file.name, sha256: file.sha256, width: 750, height: 2000, sources: original.map((item) => item.sha256) });
  }
  for (const [index, file] of original.entries()) assert.equal(digest(await fs.readFile(file.path)), digest([red, blue][index]));
  const invalidExport = await f.call('/detail', { action: 'export', conversationId: 'conversation-a', projectId: 'fixture-detail', expectedRevision: 0, format: 'whole' });
  assert.equal(invalidExport.status, 409);
  evidence.checks.push('HTTP upload/import/edit/save/readback; exact original hashes; 750x2000 whole PNG; ZIP numbered two 750x1000 slices; stale export rejected');
});

test('foreign uploads, foreign projects, traversal, URI and symlink sources cannot enter a project', async (t) => {
  const f = await fixture(t); const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const own = await f.upload(png), foreign = await f.upload(png, 'b');
  const link = path.join(f.conversations.get('conversation-a').extra.workspace, 'same-scope-link.png'); await fs.symlink(own.path, link);
  const cases = [foreign.path, link, `${path.dirname(own.path)}/../${path.basename(own.path)}`, `file://${own.path}`, '/etc/passwd'];
  for (const file of cases) {
    const result = await f.call('/detail', { action: 'import', conversationId: 'conversation-a', files: [{ path: file }] });
    assert.ok([400, 403, 404].includes(result.status), `${file} returned ${result.status}`);
  }
  const foreignConversation = await f.call('/detail', { action: 'load', conversationId: 'conversation-a' }, 'b'); assert.equal(foreignConversation.status, 404);
  const wrongHash = await f.call('/detail', { action: 'import', conversationId: 'conversation-a', files: [{ path: own.path, sha256: '0'.repeat(64) }] }); assert.equal(wrongHash.status, 409);
  evidence.checks.push('foreign actor upload/conversation and same-scope symlink/traversal/URI/external/hash-mismatch sources rejected');
});

test('save revisions are single-winner and generation/native actions are unavailable', async (t) => {
  const f = await fixture(t); const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const uploaded = await f.upload(png); const imported = await f.call('/detail', { action: 'import', conversationId: 'conversation-a', files: [uploaded] });
  const project = projectFor(imported.value.data.assets); const first = await f.call('/detail', { action: 'save', conversationId: 'conversation-a', expectedRevision: null, project }); assert.equal(first.status, 200);
  const results = await Promise.all([1, 2].map((index) => f.call('/detail', { action: 'save', conversationId: 'conversation-a', expectedRevision: 0, project: { ...project, title: `Concurrent ${index}` } })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  for (const action of ['revise', 'reconcile']) { const denied = await f.call('/detail', { action, conversationId: 'conversation-a' }); assert.equal(denied.status, 400); }
  const malformed = await f.call('/detail', { action: 'save', conversationId: 'conversation-a', project: { sections: {} } }); assert.equal(malformed.status, 400);
  const nullSection = await f.call('/detail', { action: 'save', conversationId: 'conversation-a', project: { ...project, sections: [null] } }); assert.equal(nullSection.status, 400);
  evidence.checks.push('concurrent CAS saves have one winner; model/native actions and malformed saves rejected');
});

test('the authenticated editor page has usable inputs and refuses non-GET static mutations', async (t) => {
  const f = await fixture(t); const response = await fetch(f.url + '/cloud-detail');
  const html = await response.text(); assert.equal(response.status, 200); assert.ok(html.includes('id="pictures"')); assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'self'"));
  const script = await fetch(f.url + '/cloud-detail/page.mjs'); assert.equal(script.status, 200);
  const denied = await f.call('/cloud-detail', {}); assert.equal(denied.status, 405);
  evidence.checks.push('authenticated HTTP HTML/JS editor served with same-origin CSP; static mutations rejected');
});
