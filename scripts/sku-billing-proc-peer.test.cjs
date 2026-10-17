'use strict';

// Independent offline review of the fixed SQL contract. Importing the worker
// only exposes pure functions; no --proc-read/--guarded-read flag is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'docs/uat-sku-workflow-20261012');
const sqlPath = path.join(directory, 'read-sku-billing-candidates.cjs');
const sql = require(sqlPath);
const proc = require(path.join(directory, 'read-sku-billing-proc-pinned.cjs'));
const schemaPath = path.join(root, '.codex-deploy/image-deep-tests-20261012/ledger/project/prisma/schema.prisma');
const schema = fs.readFileSync(schemaPath, 'utf8');
const columns = [];
for (const table of ['User', 'GatewayBillingHold', 'GatewayBillingHoldEvent']) {
  const body = new RegExp('model ' + table + ' \\{([\\s\\S]*?)\\n\\}').exec(schema)?.[1];
  assert.ok(body, 'frozen production source contains model ' + table);
  for (const line of body.split('\n')) {
    const field = /^\s*(\w+)\s+[A-Za-z]\w*(?:\?|\[\])?(?:\s|$)/.exec(line);
    if (field) columns.push({ table_name: table, column_name: field[1] });
  }
}
const USER = Object.freeze({ id: 'peer-user', tenantId: 'peer-tenant', username: 'admin@demo.local', email: 'admin@demo.local', status: 'active' });
function harness(options = {}) {
  const events = [], queries = [];
  const tx = {
    async $executeRawUnsafe(statement) {
      events.push({ type: 'execute', statement });
      assert.ok(['SET TRANSACTION READ ONLY', "SET LOCAL statement_timeout = '5s'", "SET LOCAL TIME ZONE 'UTC'"].includes(statement),
        'only transaction-scoped read-only settings are permitted');
    },
    async $queryRawUnsafe(statement, ...params) {
      queries.push({ statement, params });
      if (statement === 'SHOW transaction_read_only') return [{ transaction_read_only: options.readOnly ?? 'on' }];
      if (statement.includes('information_schema.columns')) return options.columns ?? columns;
      if (statement.includes('FROM "User"')) {
        assert.deepEqual(params, ['admin@demo.local']);
        return options.users ?? [{ ...USER }];
      }
      assert.equal(statement, sql.CANDIDATE_SQL);
      assert.deepEqual(params, [USER.id, USER.tenantId, '2026-10-12T17:03:00.000', '2026-10-12T17:04:00.000']);
      return options.rows ?? [];
    }
  };
  return { events, queries, client: { async $transaction(callback, options) {
    assert.deepEqual(options, { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 15000 });
    return callback(tx);
  } } };
}
const candidate = (number = 1) => ({ record: { kind: 'hold', userId: USER.id, tenantId: USER.tenantId, eventId: 'event-' + number } });
const candidateCalls = h => h.queries.filter(item => item.statement === sql.CANDIDATE_SQL).length;

test('immutable SQL bytes and every required or selected financial column match the frozen production schema', () => {
  assert.equal(createHash('sha256').update(fs.readFileSync(sqlPath)).digest('hex'), proc.SQL_SHA);
  for (const [table, fields] of Object.entries(sql.SCHEMA_COLUMNS)) {
    const actual = new Set(columns.filter(column => column.table_name === table).map(column => column.column_name));
    for (const field of fields) assert.ok(actual.has(field), table + '.' + field);
  }
  for (const [alias, table] of [['h', 'GatewayBillingHold'], ['e', 'GatewayBillingHoldEvent']]) {
    const actual = new Set(columns.filter(column => column.table_name === table).map(column => column.column_name));
    for (const match of sql.CANDIDATE_SQL.matchAll(new RegExp('\\b' + alias + '\\."([^"]+)"', 'g'))) {
      assert.ok(actual.has(match[1]), 'SQL references a source-confirmed column: ' + table + '.' + match[1]);
    }
  }
  assert.equal(sql.EMAIL, 'admin@demo.local'); assert.equal(sql.START, '2026-10-12T17:03:00.000');
  assert.equal(sql.END, '2026-10-12T17:04:00.000'); assert.equal(sql.LIMIT, 10);
  assert.equal(sql.CANDIDATE_SQL.includes('h."userId"=$1 AND h."tenantId"=$2'), true);
  assert.equal(sql.CANDIDATE_SQL.includes("h.\"endpoint\" IN ('images.generations','images.edits')"), true);
  assert.match(sql.CANDIDATE_SQL.trim(), /LIMIT 10$/);
});

test('fixed account/minute SELECT runs only after read-only confirmation and carries no exact-job claim', async () => {
  const h = harness({ rows: [candidate()] }), result = await sql.queryCandidates(h.client);
  assert.equal(h.events[0].statement, 'SET TRANSACTION READ ONLY');
  assert.equal(h.queries[0].statement, 'SHOW transaction_read_only'); assert.equal(candidateCalls(h), 1);
  assert.equal(result.timeWindowOnly, true); assert.equal(result.exactJobAssociation, false);
  assert.equal(result.providerRequests, 0); assert.equal(result.databaseWrite, false); assert.equal(result.cancelOrRefund, false);
  assert.deepEqual(result.windowUtc, { fromInclusive: '2026-10-12T17:03:00.000Z', toExclusive: '2026-10-12T17:04:00.000Z' });
});

test('read-only off aborts before schema, user or financial SELECT', async () => {
  const h = harness({ readOnly: 'off' });
  await assert.rejects(sql.queryCandidates(h.client), /TRANSACTION_NOT_READ_ONLY/);
  assert.equal(h.queries.length, 1); assert.equal(candidateCalls(h), 0);
});

test('missing source-confirmed column aborts before account or financial data', async () => {
  const h = harness({ columns: columns.filter(column => !(column.table_name === 'GatewayBillingHold' && column.column_name === 'settledCents')) });
  await assert.rejects(sql.queryCandidates(h.client), /BASELINE_SCHEMA_MISMATCH/);
  assert.equal(h.queries.filter(item => item.statement.includes('FROM "User"')).length, 0);
  assert.equal(candidateCalls(h), 0);
});

test('absent, ambiguous, inactive or nonmatching admin identity cannot query financial candidates', async () => {
  for (const users of [[], [{ ...USER }, { ...USER, id: 'other-user' }], [{ ...USER, status: 'disabled' }],
    [{ ...USER, username: 'foreign', email: 'foreign' }]]) {
    const h = harness({ users });
    await assert.rejects(sql.queryCandidates(h.client), /EXACT_ACTIVE_USER_NOT_UNIQUE/);
    assert.equal(candidateCalls(h), 0);
  }
});

test('over-limit, foreign-user or unknown-kind candidate rows are rejected', async () => {
  for (const rows of [Array.from({ length: 11 }, (_, index) => candidate(index)),
    [{ record: { ...candidate().record, userId: 'foreign-user' } }], [{ record: { ...candidate().record, kind: 'unknown' } }]]) {
    const h = harness({ rows }); await assert.rejects(sql.queryCandidates(h.client), /CANDIDATE_SCOPE_MISMATCH/);
  }
});

test('exactly ten rows explicitly retain truncation and unassociated-job caveats', async () => {
  const h = harness({ rows: Array.from({ length: 10 }, (_, index) => candidate(index)) });
  const result = await sql.queryCandidates(h.client);
  assert.equal(result.mayBeTruncated, true); assert.equal(result.records.length, 10); assert.equal(result.exactJobAssociation, false);
});
