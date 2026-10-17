import { createHash, randomBytes } from 'node:crypto';

/** Map only server-verified site identities into this new cloud control database. */
export function createIdentityBroker(store) {
  store.db.exec('CREATE TABLE IF NOT EXISTS website_identities (site_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL)');
  const sessions = new Map();
  return {
    forSite(identity) {
      const key = createHash('sha256').update(JSON.stringify([identity.tenantId, identity.userId])).digest('hex');
      let row = store.db.prepare('SELECT user_id,workspace_id FROM website_identities WHERE site_key=?').get(key);
      if (!row) {
        const username = `${identity.userName.slice(0, 42)}-${key.slice(0, 20)}`;
        const user = store.createUser(username, randomBytes(48).toString('base64url'));
        const workspace = store.createWorkspace(`${identity.userName.slice(0, 60)}的工作区`);
        store.setMembership({ userId: user.id, workspaceId: workspace.id, role: 'owner', status: 'active' });
        store.setEntitlement(user.id, 'active', null);
        store.seedPackagedGrants(user.id, workspace.id);
        store.db.prepare('INSERT INTO website_identities VALUES(?,?,?)').run(key, user.id, workspace.id);
        store.audit(user.id, workspace.id, 'website-admin-provisioned', user.id);
        row = { user_id: user.id, workspace_id: workspace.id };
      }
      const prior = sessions.get(key);
      store.setEntitlement(row.user_id, 'active', null);
      if (prior && store.session(prior.token)) return prior;
      const created = store.createSession(row.user_id, row.workspace_id);
      const value = { token: created.token, csrf: created.session.csrfToken, userId: row.user_id, workspaceId: row.workspace_id };
      sessions.set(key, value);
      return value;
    },
    revoke(identity) {
      const key = createHash('sha256').update(JSON.stringify([identity.tenantId, identity.userId])).digest('hex');
      const current = sessions.get(key);
      const row = store.db.prepare('SELECT user_id FROM website_identities WHERE site_key=?').get(key);
      if (row) store.setEntitlement(row.user_id, 'revoked', null);
      if (current) {
        const session = store.session(current.token);
        if (session) store.removeSession(session.id);
        sessions.delete(key);
      }
    },
  };
}
