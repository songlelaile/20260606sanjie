import fs from 'node:fs/promises';
import path from 'node:path';

export const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
export const inside = (root, file) => file.startsWith(root + path.sep);
export const scopeKey = (identity) => `${identity.workspaceId}:${identity.userId}`;

/** Reject ambiguous paths and every symbolic link, including links pointing back into the scope. */
export async function ordinaryPath(root, value, { directory = false } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || value.split(/[\\/]/).some((part) => part === '..' || part === '.')) fail(403, 'DETAIL_CLOUD_FILE_FORBIDDEN');
  const file = path.resolve(value);
  if (!inside(root, file)) fail(403, 'DETAIL_CLOUD_FILE_FORBIDDEN');
  let cursor = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    cursor = path.join(cursor, part);
    const info = await fs.lstat(cursor).catch(() => fail(404, 'DETAIL_CLOUD_FILE_NOT_FOUND'));
    if (info.isSymbolicLink()) fail(403, 'DETAIL_CLOUD_SYMLINK_FORBIDDEN');
  }
  const info = await fs.lstat(file);
  if (directory ? !info.isDirectory() : !info.isFile()) fail(403, 'DETAIL_CLOUD_FILE_FORBIDDEN');
  if (await fs.realpath(file) !== file) fail(403, 'DETAIL_CLOUD_SYMLINK_FORBIDDEN');
  return file;
}

/** The source must be an upload receipt for this actor or a file in the current owned project. */
export function createDetailOwnership({ root, store, filesystem, readConversation }) {
  const contextFor = async (identity, conversationId) => {
    if (!/^[\w-]{1,128}$/.test(conversationId || '')) fail(400, 'DETAIL_PAGE_ARGUMENT_INVALID');
    const conversation = await readConversation(identity, conversationId);
    if (!conversation || conversation.id !== conversationId) fail(404, 'DETAIL_CLOUD_CONVERSATION_NOT_FOUND');
    const workspace = conversation.extra?.workspace;
    const accountRoot = filesystem.getAccountRoot(identity);
    if (typeof workspace !== 'string' || !inside(accountRoot, path.resolve(workspace))) fail(403, 'DETAIL_CLOUD_WORKSPACE_FORBIDDEN');
    await ordinaryPath(root, accountRoot, { directory: true });
    await ordinaryPath(root, workspace, { directory: true });
    filesystem.authorizeFile(identity, workspace, true);
    return { workspace, conversationId, scope: scopeKey(identity) };
  };
  return {
    contextFor,
    async source(identity, context, value) {
      const file = await ordinaryPath(root, value);
      const authorized = filesystem.authorizeFile(identity, file, true);
      if (authorized !== file) fail(403, 'DETAIL_CLOUD_FILE_FORBIDDEN');
      const upload = store.db.prepare('SELECT scope_key FROM website_files WHERE file_path=?').get(file);
      if (!inside(context.workspace, file) && upload?.scope_key !== scopeKey(identity)) fail(403, 'DETAIL_CLOUD_SOURCE_NOT_OWNED');
      return file;
    },
  };
}
