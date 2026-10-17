import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createCloudFilesystem } from './filesystem.mjs';

test('portable services can read owned files while rejecting other accounts and symlinked account roots', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'sower-cloud-fs-')));
  const external = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'sower-cloud-fs-external-')));
  const db = new DatabaseSync(':memory:');
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(external, { recursive: true, force: true }); });
  const service = createCloudFilesystem(root, { db });
  const a = { userId: 'user-a', workspaceId: 'workspace-a' }, b = { userId: 'user-b', workspaceId: 'workspace-b' };
  const file = path.join(service.getAccountRoot(a), 'owned.txt'); fs.writeFileSync(file, 'original');
  assert.equal(service.authorizeFile(a, file), file);
  assert.throws(() => service.authorizeFile(b, file), /FILE_SCOPE_FORBIDDEN/);
  const linkedRoot = path.join(root, 'workspaces/cloud-users/linked-user'); fs.symlinkSync(external, linkedRoot);
  assert.throws(() => service.getAccountRoot({ userId: 'linked-user', workspaceId: 'workspace-new' }), /FILE_SCOPE_FORBIDDEN/);
  assert.equal(fs.existsSync(path.join(external, 'workspace-new')), false);
  assert.throws(() => service.getAccountRoot({ userId: '../escape', workspaceId: 'safe' }), /FILE_SCOPE_FORBIDDEN/);
});
