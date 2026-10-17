import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const fail = (status, code) => { throw Object.assign(new Error(code), { status }); };
const inside = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);
const scopeKey = (identity) => `${identity.workspaceId}:${identity.userId}`;

/** Keep local file APIs inside a server-issued account directory or an owned upload. */
export function createCloudFilesystem(runtime, store) {
  const root = fs.realpathSync(runtime);
  const temporary = path.join(root, 'tmp');
  store.db.exec('CREATE TABLE IF NOT EXISTS website_files (file_path TEXT PRIMARY KEY, scope_key TEXT NOT NULL)');
  const accountRoot = (identity) => {
    if (![identity.userId, identity.workspaceId].every((value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value))) fail(403, 'FILE_SCOPE_FORBIDDEN');
    const directory = path.join(root, 'workspaces/cloud-users', identity.userId, identity.workspaceId);
    let parent = root;
    for (const component of path.relative(root, directory).split(path.sep)) {
      parent = path.join(parent, component);
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
      const info = fs.lstatSync(parent);
      if (info.isSymbolicLink() || !info.isDirectory()) fail(403, 'FILE_SCOPE_FORBIDDEN');
    }
    return directory;
  };
  const canonical = (value, existing = false) => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || value.split(/[\\/]/).includes('..')) fail(403, 'FILE_SCOPE_FORBIDDEN');
    const resolved = path.resolve(value);
    let ancestor = resolved;
    while (!fs.existsSync(ancestor)) {
      if (existing) fail(404, 'FILE_NOT_FOUND');
      const next = path.dirname(ancestor);
      if (next === ancestor) fail(404, 'FILE_NOT_FOUND');
      ancestor = next;
    }
    const actual = path.join(fs.realpathSync(ancestor), path.relative(ancestor, resolved));
    if (!inside(root, actual)) fail(403, 'FILE_SCOPE_FORBIDDEN');
    return actual;
  };
  const authorize = (identity, value, existing = false) => {
    const actual = canonical(value, existing);
    const ownRoot = accountRoot(identity);
    const uploaded = store.db.prepare('SELECT scope_key FROM website_files WHERE file_path=?').get(actual);
    if (!inside(ownRoot, actual) && uploaded?.scope_key !== scopeKey(identity)) fail(403, 'FILE_SCOPE_FORBIDDEN');
    return actual;
  };
  const validateJsonPaths = (identity, value, parentKey = '') => {
    if (Array.isArray(value)) { for (const child of value) validateJsonPaths(identity, child, parentKey); return; }
    if (value && typeof value === 'object') { for (const [key, child] of Object.entries(value)) validateJsonPaths(identity, child, key); return; }
    if (typeof value !== 'string') return;
    if (['workspace', 'path', 'root', 'dir', 'file_path', 'file_paths', 'folder_path', 'source_path', 'source_root', 'output_path', 'target_path', 'default_files', 'input_files'].includes(parentKey)) {
      if (/^https?:\/\//i.test(value)) return;
      if (path.isAbsolute(value)) authorize(identity, value);
      else if (value.split(/[\\/]/).includes('..')) fail(403, 'FILE_SCOPE_FORBIDDEN');
    }
    if (['uri', 'resource_uri'].includes(parentKey) && value.startsWith('file:')) {
      let local;
      try { local = fileURLToPath(value); } catch { fail(403, 'FILE_SCOPE_FORBIDDEN'); }
      authorize(identity, local);
    }
    if (parentKey === 'relative_path' && (path.isAbsolute(value) || value.split(/[\\/]/).includes('..'))) fail(403, 'FILE_SCOPE_FORBIDDEN');
  };
  return {
    authorizeFile(identity, filename, existing = true) { return authorize(identity, filename, existing); },
    getAccountRoot(identity) { return accountRoot(identity); },
    authorizeQuery(identity, route) {
      const url = new URL(route, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/fs/') && url.pathname !== '/api/fs/upload') {
        const kind = url.searchParams.get('kind');
        const file = url.searchParams.get('path');
        if (file) authorize(identity, file, true);
        else if (url.pathname === '/api/fs/stream' && kind !== 'project') fail(403, 'FILE_SCOPE_FORBIDDEN');
        const relative = url.searchParams.get('relative_path');
        if (relative && (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..'))) fail(403, 'FILE_SCOPE_FORBIDDEN');
      }
      for (const key of ['path', 'file_path', 'folder_path']) {
        const value = url.searchParams.get(key);
        if (value && path.isAbsolute(value)) authorize(identity, value, true);
        else if (value && value.split(/[\\/]/).includes('..')) fail(403, 'FILE_SCOPE_FORBIDDEN');
      }
    },
    prepareJson(identity, route, body) {
      if (route.split('?')[0] === '/api/conversations') {
        const folder = path.join(accountRoot(identity), 'conversations', randomBytes(8).toString('hex'));
        fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
        body.extra = { ...(body.extra || {}), workspace: folder, custom_workspace: true };
      }
      validateJsonPaths(identity, body);
      return body;
    },
    async validateUpload(identity, bytes, contentType, readConversation) {
      const boundary = /boundary=(?:"([^"]+)"|([^; ]+))/i.exec(contentType || '');
      if (!boundary) fail(415, 'MULTIPART_REQUIRED');
      const delimiter = Buffer.from(`--${boundary[1] || boundary[2]}`);
      let position = bytes.indexOf(delimiter), conversationId;
      while (position >= 0) {
        const next = bytes.indexOf(delimiter, position + delimiter.length);
        if (next < 0) break;
        const segment = bytes.subarray(position + delimiter.length, next);
        const headerEnd = segment.indexOf(Buffer.from('\r\n\r\n'));
        if (headerEnd >= 0) {
          const headers = segment.subarray(0, headerEnd).toString('utf8');
          const name = /(?:^|;)\s*name="([^"]+)"/i.exec(headers)?.[1];
          const filename = /(?:^|;)\s*filename="([^"]*)"/i.exec(headers)?.[1];
          const content = segment.subarray(headerEnd + 4, segment.length - 2).toString('utf8');
          if (name === 'conversation_id') conversationId = content.trim();
          const candidate = filename ?? (name === 'file_name' ? content.trim() : undefined);
          if (candidate !== undefined && (!candidate || path.basename(candidate) !== candidate || /[\\/\0]/.test(candidate) || candidate === '..' || /%2f|%5c/i.test(candidate))) fail(403, 'INVALID_FILE_NAME');
        }
        position = next;
      }
      if (conversationId) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(conversationId)) fail(403, 'FILE_SCOPE_FORBIDDEN');
        const conversation = await readConversation(conversationId);
        if (!conversation) fail(404, 'CONVERSATION_NOT_FOUND');
        const workspace = conversation.extra?.workspace;
        if (typeof workspace !== 'string') fail(403, 'FILE_SCOPE_FORBIDDEN');
        authorize(identity, workspace, true);
      }
    },
    registerUpload(identity, filename) {
      const actual = canonical(filename, true);
      if (!inside(accountRoot(identity), actual) && !inside(temporary, actual)) fail(403, 'FILE_SCOPE_FORBIDDEN');
      store.db.prepare('INSERT OR IGNORE INTO website_files VALUES(?,?)').run(actual, scopeKey(identity));
      const row = store.db.prepare('SELECT scope_key FROM website_files WHERE file_path=?').get(actual);
      if (row?.scope_key !== scopeKey(identity)) fail(403, 'FILE_SCOPE_FORBIDDEN');
    },
  };
}
