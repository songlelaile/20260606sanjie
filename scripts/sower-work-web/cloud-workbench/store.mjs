import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fail } from './import.mjs';
export const digest = value => createHash('sha256').update(value).digest('hex');
export const validId = value => { if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) fail('INVALID_ID'); return value; };
export const safeName = value => { if (typeof value !== 'string' || value.length > 200 || !value.trim() || /[\/\\\u0000-\u001f]/.test(value) || value === '.' || value === '..') fail('FILE_NAME_INVALID'); return value; };
function safeTree(directory, create) {
  const resolved = path.resolve(directory); const parts = resolved.split(path.sep).filter(Boolean); let current = path.parse(resolved).root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current) && create) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_STORAGE_PATH', 403);
  }
  return resolved;
}
export function createWorkbenchStore(runtimeDir) {
  if (typeof runtimeDir !== 'string' || !path.isAbsolute(runtimeDir)) throw new Error('Independent absolute runtimeDir required');
  const base = safeTree(path.join(fs.realpathSync(runtimeDir), 'cloud-workbench'), true);
  const root = ({ identity, site }) => {
    if (!identity || !site || ![identity.userId, identity.workspaceId, site.userId, site.tenantId].every(value => typeof value === 'string' && value.trim() && value.length <= 256)) fail('VERIFIED_IDENTITY_REQUIRED', 401);
    return safeTree(path.join(base, digest(JSON.stringify([site.tenantId, site.userId, identity.userId, identity.workspaceId]))), true);
  };
  const dir = (context, kind, id, create = false) => {
    if (!['jobs', 'knowledge'].includes(kind)) fail('INVALID_KIND'); const partition = root(context); const folder = safeTree(path.join(partition, kind), true);
    if (id) { validId(id); const target = path.join(folder, id); if (!fs.existsSync(target) && !create) fail('NOT_FOUND', 404); return safeTree(target, create); }
    return folder;
  };
  const read = (directory, name) => {
    safeTree(directory, false); const target = path.join(directory, name); const stat = fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 12 * 1024 * 1024) fail('UNSAFE_STORAGE_FILE', 403);
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { return fs.readFileSync(descriptor); } finally { fs.closeSync(descriptor); }
  };
  const write = (directory, name, bytes, replace = false) => {
    safeTree(directory, false); if (bytes.length > 12 * 1024 * 1024) fail('OUTPUT_SIZE_LIMIT', 413);
    const destination = path.join(directory, name); if (fs.existsSync(destination)) { const stat = fs.lstatSync(destination); if (!stat.isFile() || stat.isSymbolicLink()) fail('UNSAFE_STORAGE_FILE', 403); if (!replace) fail('ARTIFACT_ALREADY_EXISTS', 409); }
    const partition = path.join(base, path.relative(base, directory).split(path.sep)[0]);
    let files = 0;
    const usage = folder => fs.readdirSync(folder).reduce((total, entry) => { const candidate = path.join(folder, entry); const stat = fs.lstatSync(candidate); if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) fail('UNSAFE_STORAGE_PATH', 403); if (++files > 4000) fail('WORKSPACE_FILE_LIMIT', 413); return total + (stat.isDirectory() ? usage(candidate) : stat.size); }, 0);
    if (usage(partition) - (fs.existsSync(destination) ? fs.statSync(destination).size : 0) + bytes.length > 128 * 1024 * 1024) fail('WORKSPACE_STORAGE_LIMIT', 413);
    const temporary = path.join(directory, `.write-${randomUUID()}`); const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try {
      try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, destination);
    } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  };
  return {
    create(context, kind, original, fileName, record) {
      const folder = dir(context, kind); if (fs.readdirSync(folder).length >= (kind === 'jobs' ? 16 : 50)) fail('WORKSPACE_FILE_LIMIT', 413);
      const id = randomUUID(); const directory = dir(context, kind, id, true); const saved = { ...record, id, fileName: safeName(fileName), originalSha256: digest(original), sizeBytes: original.length, createdAt: new Date().toISOString() };
      try { write(directory, 'original.bin', original); write(directory, 'record.json', Buffer.from(JSON.stringify(saved))); return saved; } catch (error) { fs.rmSync(directory, { recursive: true }); throw error; }
    },
    get(context, kind, id) { return JSON.parse(read(dir(context, kind, id), 'record.json')); },
    update(context, kind, id, record) { const directory = dir(context, kind, id); write(directory, 'record.json', Buffer.from(JSON.stringify(record)), true); return record; },
    putArtifact(context, kind, id, name, bytes) { if (!/^(?:market-original|output-\d+)\.(?:bin|json)$/.test(name)) fail('INVALID_ARTIFACT'); write(dir(context, kind, id), name, bytes); },
    commit(context, kind, id, record, artifact) {
      if (!artifact) return this.update(context, kind, id, record);
      this.putArtifact(context, kind, id, artifact.name, artifact.bytes);
      try { return this.update(context, kind, id, record); }
      catch (error) { fs.unlinkSync(path.join(dir(context, kind, id), artifact.name)); throw error; }
    },
    original(context, kind, id, market = false) { return read(dir(context, kind, id), market ? 'market-original.bin' : 'original.bin'); },
    list(context, kind) { return fs.readdirSync(dir(context, kind)).filter(id => /^[0-9a-f-]{36}$/i.test(id)).map(id => this.get(context, kind, id)).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); },
    partition(context) { return root(context); },
  };
}
