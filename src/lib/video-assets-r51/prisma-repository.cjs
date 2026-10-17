/* eslint-disable @typescript-eslint/no-require-imports -- Server-only CommonJS modules loaded by the Node runtime. */
'use strict';

const { freshState } = require('./asset-service.cjs');

/**
 * Reuses the website's existing Prisma/PostgreSQL dependency. The outer
 * transaction owns only the advisory lock; independent inner transactions commit
 * operation checkpoints. The DB pool must have at least two available connections
 * per concurrent provider account workflow (bounded by the owning application).
 */
function createPrismaRepository({ prisma, lockTimeoutMs = 300000, maxWaitMs = 10000 } = {}) {
  if (!prisma || typeof prisma.$transaction !== 'function') throw new TypeError('The existing Prisma client is required.');
  return Object.freeze({
    withLock(key, work) {
      return prisma.$transaction(async lockTx => {
        await lockTx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 510079))', key);
        return work({
          transaction(fn) {
            return prisma.$transaction(async tx => {
              const rows = await tx.$queryRawUnsafe('SELECT state FROM video_asset_binding_state WHERE binding_key = $1 FOR UPDATE', key);
              const state = rows.length ? structuredClone(rows[0].state) : freshState();
              const result = await fn(state);
              await tx.$executeRawUnsafe(
                'INSERT INTO video_asset_binding_state (binding_key, state, revision, updated_at) VALUES ($1, $2::jsonb, 1, NOW()) ON CONFLICT (binding_key) DO UPDATE SET state = EXCLUDED.state, revision = video_asset_binding_state.revision + 1, updated_at = NOW()',
                key, JSON.stringify(state)
              );
              return result;
            }, { maxWait: maxWaitMs, timeout: Math.min(lockTimeoutMs, 30000) });
          }
        });
      }, { maxWait: maxWaitMs, timeout: lockTimeoutMs });
    }
  });
}

module.exports = { createPrismaRepository };
