/* eslint-disable @typescript-eslint/no-require-imports -- Server-only CommonJS modules loaded by the Node runtime. */
'use strict';

const { freshState } = require('./asset-service.cjs');

/**
 * Inject a pg-compatible Pool. No connection URL or credential is accepted here.
 * The advisory session lock spans separate committed checkpoints and provider
 * calls. A process/connection crash releases the lock but keeps those checkpoints.
 * Configure pool connection/query timeouts in the owning application.
 */
function createPostgresRepository({ pool } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required.');
  return Object.freeze({
    async withLock(key, work) {
      const client = await pool.connect();
      let acquired = false;
      let broken = false;
      let inTransaction = false;
      try {
        await client.query('SELECT pg_advisory_lock(hashtextextended($1, 510079))', [key]);
        acquired = true;
        const locked = {
          async transaction(fn) {
            if (inTransaction) throw new Error('Nested asset transactions are not supported.');
            inTransaction = true;
            try {
              await client.query('BEGIN');
              const rows = await client.query('SELECT state FROM video_asset_binding_state WHERE binding_key = $1 FOR UPDATE', [key]);
              const state = rows.rows.length ? structuredClone(rows.rows[0].state) : freshState();
              const result = await fn(state);
              await client.query(
                'INSERT INTO video_asset_binding_state (binding_key, state, revision, updated_at) VALUES ($1, $2::jsonb, 1, NOW()) ON CONFLICT (binding_key) DO UPDATE SET state = EXCLUDED.state, revision = video_asset_binding_state.revision + 1, updated_at = NOW()',
                [key, JSON.stringify(state)]
              );
              await client.query('COMMIT');
              return result;
            } catch (error) {
              try { await client.query('ROLLBACK'); } catch (_) { broken = true; }
              throw error;
            } finally { inTransaction = false; }
          }
        };
        return await work(locked);
      } finally {
        if (acquired && !broken) {
          try {
            const unlocked = await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 510079)) AS released', [key]);
            if (unlocked.rows[0] && unlocked.rows[0].released === false) broken = true;
          } catch (_) { broken = true; }
        }
        // Never return a pooled session with an uncertain held lock.
        client.release(broken || undefined);
      }
    }
  });
}

module.exports = { createPostgresRepository };
