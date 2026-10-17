import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createIdentityBroker } from './identity.mjs';

const source = process.env.SOWER_CONTROL_SOURCE;
test('isolates tenant and site identities in the actual cloud ControlStore and revokes internal access', { skip: !source }, async () => {
  const { ControlStore } = await import(path.join(source, 'src/store.ts'));
  const temporary = mkdtempSync(path.join(tmpdir(), 'sower-control-isolation-'));
  const store = new ControlStore(temporary);
  try {
    const broker = createIdentityBroker(store);
    const a = broker.forSite({ userId: 'a', tenantId: 'tenant-1', userName: '管理甲' });
    const again = broker.forSite({ userId: 'a', tenantId: 'tenant-1', userName: '管理甲改名' });
    const b = broker.forSite({ userId: 'b', tenantId: 'tenant-1', userName: '管理乙' });
    const c = broker.forSite({ userId: 'a', tenantId: 'tenant-2', userName: '另一租户甲' });
    assert.deepEqual(a, again);
    assert.equal(new Set([a.userId, b.userId, c.userId]).size, 3);
    assert.equal(new Set([a.workspaceId, b.workspaceId, c.workspaceId]).size, 3);
    assert.equal(store.membership(a.userId, b.workspaceId), null);
    broker.revoke({ userId: 'a', tenantId: 'tenant-1' });
    assert.equal(store.session(a.token), null);
    assert.equal(store.entitlement(a.userId).status, 'revoked');
    const resumed = broker.forSite({ userId: 'a', tenantId: 'tenant-1', userName: '管理甲' });
    assert.equal(resumed.userId, a.userId);
    assert.notEqual(resumed.token, a.token);
    assert.equal(store.entitlement(a.userId).status, 'active');
    assert.ok(store.session(b.token));
  } finally {
    store.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});
