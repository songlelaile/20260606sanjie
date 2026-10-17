#!/usr/bin/env node
// Offline regression: evaluate only verify() and its constants, with catalog mocks.
// No Prisma import, migration IIFE, database connection, or deployment is executed.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerPath = path.join(root, 'scripts/deploy-security-channel-20261002.py');
const reportPath = path.join(root, '.codex-deploy/anti-clone-20261002/migration-shape-review.json');
const source = await readFile(runnerPath, 'utf8');
const marker = 'MIGRATE_OWNED_JS = r"""';
const markerAt = source.indexOf(marker);
assert(markerAt >= 0, 'Migration validator source missing');
const bodyAt = markerAt + marker.length;
const bodyEnd = source.indexOf('"""', bodyAt);
assert(bodyEnd > bodyAt, 'Migration validator source incomplete');
const body = source.slice(bodyAt, bodyEnd);
const start = body.indexOf('const columns=');
const end = body.indexOf('(async()=>');
assert(start >= 0 && end > start, 'Offline validator extraction boundary missing');
const validatorOnly = body.slice(start, end);
assert(!/require\s*\(|new\s+PrismaClient|db\.\$transaction/.test(validatorOnly), 'Offline extraction includes runtime execution');
const sandbox = { require: () => { throw Error('Runtime imports forbidden in offline regression'); } };
vm.runInNewContext(validatorOnly + '\nglobalThis.offlineVerify = verify;', sandbox, { timeout: 1000 });
assert.equal(typeof sandbox.offlineVerify, 'function');

const columns = {
  SecurityRateBucket: {
    bucketKey: ['bpchar', false, 64], windowStart: ['timestamptz', false],
    expiresAt: ['timestamptz', false], hits: ['int4', false],
  },
  AIAccessGrant: {
    id: ['uuid', false], userId: ['text', false], username: ['text', false], tenantId: ['text', false],
    name: ['varchar', false, 80], scope: ['text', false], tokenHash: ['bpchar', false, 64],
    activeShopId: ['text', true], createdAt: ['timestamptz', false], expiresAt: ['timestamptz', false],
    revokedAt: ['timestamptz', true], lastUsedAt: ['timestamptz', true],
  },
  AIAccessEvent: {
    id: ['uuid', false], userId: ['text', false], grantId: ['uuid', true], type: ['text', false],
    method: ['varchar', true, 10], path: ['text', true], status: ['int4', true], createdAt: ['timestamptz', false],
  },
};
const constraints = {
  SecurityRateBucket: {
    SecurityRateBucket_pkey: 'PRIMARY KEY ("bucketKey", "windowStart")',
    SecurityRateBucket_key_check: `CHECK (("bucketKey" ~ '^[0-9a-f]{64}$'::text))`,
    SecurityRateBucket_hits_check: 'CHECK ((hits > 0))',
    SecurityRateBucket_window_check: 'CHECK (("expiresAt" > "windowStart"))',
  },
  AIAccessGrant: {
    AIAccessGrant_pkey: 'PRIMARY KEY (id)',
    AIAccessGrant_userId_fkey: 'FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE CASCADE',
    AIAccessGrant_scope_check: `CHECK ((scope = ANY (ARRAY['read'::text, 'action'::text])))`,
    AIAccessGrant_tokenHash_key: 'UNIQUE ("tokenHash")',
    AIAccessGrant_tokenHash_check: `CHECK (("tokenHash" ~ '^[0-9a-f]{64}$'::text))`,
    AIAccessGrant_lifetime_check: `CHECK ((("expiresAt" > "createdAt") AND ("expiresAt" <= ("createdAt" + '01:00:00'::interval))))`,
  },
  AIAccessEvent: {
    AIAccessEvent_pkey: 'PRIMARY KEY (id)',
    AIAccessEvent_grantId_fkey: 'FOREIGN KEY ("grantId") REFERENCES "AIAccessGrant"(id) ON DELETE SET NULL',
    AIAccessEvent_type_check: `CHECK ((type = ANY (ARRAY['create'::text, 'list'::text, 'revoke'::text, 'authorize'::text, 'context'::text, 'request'::text, 'events'::text])))`,
    AIAccessEvent_status_check: 'CHECK (((status IS NULL) OR ((status >= 100) AND (status <= 599))))',
    AIAccessEvent_path_check: `CHECK (((path IS NULL) OR ((path ~~ '/%'::text) AND (path !~~ '%?%'::text) AND (path !~~ '%#%'::text) AND (length(path) <= 200))))`,
  },
};
const indexes = {
  SecurityRateBucket: {
    SecurityRateBucket_pkey: ['("bucketKey", "windowStart")', true],
    SecurityRateBucket_expiresAt_idx: ['("expiresAt")', false],
  },
  AIAccessGrant: {
    AIAccessGrant_pkey: ['(id)', true], AIAccessGrant_tokenHash_key: ['("tokenHash")', true],
    AIAccessGrant_userId_createdAt_idx: ['("userId", "createdAt" DESC)', false],
    AIAccessGrant_expiresAt_idx: ['("expiresAt")', false],
  },
  AIAccessEvent: {
    AIAccessEvent_pkey: ['(id)', true], AIAccessEvent_userId_createdAt_idx: ['("userId", "createdAt" DESC)', false],
    AIAccessEvent_grantId_createdAt_idx: ['("grantId", "createdAt" DESC)', false],
  },
};

function fixture(table, mutate) {
  const found = Object.entries(columns[table]).map(([column_name, [udt_name, nullable, length]]) => ({
    column_name, udt_name, is_nullable: nullable ? 'YES' : 'NO', character_maximum_length: length ?? null,
    column_default: column_name === 'hits' ? '1' : column_name === 'id' ? 'gen_random_uuid()' : column_name === 'createdAt' ? 'CURRENT_TIMESTAMP' : null,
  }));
  const constraintRows = Object.entries(constraints[table]).map(([conname, definition]) => ({
    conname, definition, convalidated: true, condeferrable: false, condeferred: false,
  }));
  const indexRows = Object.entries(indexes[table]).map(([indexname, [suffix, unique]]) => ({
    indexname, indexdef: `CREATE ${unique ? 'UNIQUE ' : ''}INDEX "${indexname}" ON public."${table}" USING btree ${suffix}`,
    indisunique: unique, indisvalid: true, indisready: true, amname: 'btree',
  }));
  mutate?.({ found, constraints: constraintRows, indexes: indexRows });
  return {
    $queryRawUnsafe: async (query, requestedTable) => {
      assert.equal(requestedTable, table, 'Unexpected mock table access');
      if (query.includes('information_schema.columns')) return found;
      if (query.includes('pg_constraint')) return constraintRows;
      if (query.includes('pg_indexes')) return indexRows;
      throw Error('Unexpected offline catalog query');
    },
    $executeRawUnsafe: async () => { throw Error('Database mutation forbidden in offline regression'); },
  };
}

async function accepted(table, mutate) {
  try { await sandbox.offlineVerify(fixture(table, mutate), table); return true; }
  catch { return false; }
}
const baselineAccepted = (await accepted('SecurityRateBucket')) && (await accepted('AIAccessGrant')) && (await accepted('AIAccessEvent'));
const weakenedCHECKAccepted = await accepted('SecurityRateBucket', rows => {
  rows.constraints.find(row => row.conname === 'SecurityRateBucket_hits_check').definition = 'CHECK (((hits > 0) OR true))';
});
const compositeFKAccepted = await accepted('AIAccessGrant', rows => {
  rows.constraints.find(row => row.conname === 'AIAccessGrant_userId_fkey').definition = 'FOREIGN KEY ("userId", "tenantId") REFERENCES "User"(id, "tenantId") ON DELETE CASCADE';
});
const hashIndexAccepted = await accepted('SecurityRateBucket', rows => {
  const index = rows.indexes.find(row => row.indexname === 'SecurityRateBucket_expiresAt_idx');
  index.indexdef = 'CREATE INDEX "SecurityRateBucket_expiresAt_idx" ON public."SecurityRateBucket" USING hash ("expiresAt")';
  index.amname = 'hash';
});
const unexpectedUniqueIndexAccepted = await accepted('SecurityRateBucket', rows => {
  const index = rows.indexes.find(row => row.indexname === 'SecurityRateBucket_expiresAt_idx');
  index.indexdef = 'CREATE UNIQUE INDEX "SecurityRateBucket_expiresAt_idx" ON public."SecurityRateBucket" USING btree ("expiresAt")';
  index.indisunique = true;
});
const unvalidatedCHECKAccepted = await accepted('SecurityRateBucket', rows => {
  const constraint = rows.constraints.find(row => row.conname === 'SecurityRateBucket_hits_check');
  constraint.definition += ' NOT VALID';
  constraint.convalidated = false;
});
const invalidIndexAccepted = await accepted('SecurityRateBucket', rows => {
  rows.indexes.find(row => row.indexname === 'SecurityRateBucket_pkey').indisvalid = false;
});
const unexpectedDefaultAccepted = await accepted('AIAccessGrant', rows => {
  rows.found.find(row => row.column_name === 'userId').column_default = "'unexpected-account'::text";
});
const alteredRegexLiteralAccepted = await accepted('SecurityRateBucket', rows => {
  rows.constraints.find(row => row.conname === 'SecurityRateBucket_key_check').definition = `CHECK (("bucketKey" ~ '^[0-9A-F]{64}$'::text))`;
});
const result = {
  schema: 'SANJIE_OFFLINE_MIGRATION_SHAPE_REVIEW_V1', offline: true,
  baselineAccepted, weakenedCHECKAccepted, compositeFKAccepted, hashIndexAccepted,
  unexpectedUniqueIndexAccepted, unvalidatedCHECKAccepted,
  invalidIndexAccepted, unexpectedDefaultAccepted, alteredRegexLiteralAccepted,
};
const failures = Object.entries(result).filter(([key, value]) => key.endsWith('Accepted') && (key === 'baselineAccepted' ? !value : value)).map(([key]) => key);
result.passed = failures.length === 0;
result.failedAssertions = failures;
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify(result) + '\n');
process.exitCode = result.passed ? 0 : 1;
