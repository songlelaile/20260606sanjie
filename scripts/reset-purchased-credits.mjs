#!/usr/bin/env node
/** One-off audited balance reset. Raw SQL only; no application/schema migration tools. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = 'sanjie_credit_reset_ops';
const TABLE = 'balance_reset_batches';
const MARKER = 'SANJIE_PURCHASED_CREDIT_RESET_V1';
const AUTHORIZED_BY = 'human user in task';
const EXECUTED_BY = 'server root operator via Codex';
const REQUEST = '所有用户的购买积分余额归零，保留付款、购买和调用记录';
const IMMUTABLE_BODY = "BEGIN RAISE EXCEPTION 'Credit reset audit is append-only'; END";
const WALLET_COLUMNS = {
  userId: 'text', balanceCents: 'integer', monthlyQuotaCents: 'integer', planCode: 'text', planName: 'text',
  periodStart: 'timestamp without time zone', periodEnd: 'timestamp without time zone', updatedAt: 'timestamp without time zone'
};
const AUDIT_COLUMNS = { operation_id: 'text', snapshot_sha256: 'text', payload: 'jsonb', created_at: 'timestamp with time zone' };

export class CreditResetError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function need(value, code) { if (!value) throw new CreditResetError(code); }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function sha(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function options(input) {
  need(input && /^[A-Za-z0-9][A-Za-z0-9_.:-]{5,119}$/.test(input.operationId || ''), 'INVALID_OPERATION_ID');
  if (input.apply) need(/^[a-f0-9]{64}$/.test(input.snapshotSha256 || ''), 'SNAPSHOT_SHA256_REQUIRED');
  return { operationId: input.operationId, apply: input.apply === true, snapshotSha256: input.snapshotSha256 };
}

async function columns(tx, schema, table) {
  const rows = await tx.$queryRawUnsafe('SELECT column_name, data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position', schema, table);
  return Object.fromEntries(rows.map(row => [row.column_name, row.data_type]));
}
async function validateBusinessSchema(tx) {
  need(canonical(await columns(tx, 'public', 'GatewayWallet')) === canonical(WALLET_COLUMNS), 'UNEXPECTED_WALLET_SCHEMA');
  const [{ ledger }] = await tx.$queryRawUnsafe(`SELECT to_regclass('public."GatewayBillingLedger"')::text AS ledger`);
  need(ledger === null, 'BILLING_LEDGER_REQUIRES_SEPARATE_ADJUSTMENT_FLOW');
}
async function readSnapshot(tx, operationId) {
  await validateBusinessSchema(tx);
  const [identity] = await tx.$queryRawUnsafe('SELECT current_database() AS database_name, current_user AS database_role, inet_server_addr()::text AS server_address, inet_server_port() AS server_port');
  const wallets = await tx.$queryRawUnsafe(`SELECT w."userId" AS "userId", to_jsonb(w) AS wallet,
    u."tenantId" AS "tenantId", u.username, u.name AS "userName", u."authRole" AS "authRole", u.status AS "userStatus",
    t.name AS "tenantName" FROM public."GatewayWallet" w
    LEFT JOIN public."User" u ON u.id=w."userId" LEFT JOIN public."Tenant" t ON t.id=u."tenantId" ORDER BY w."userId" COLLATE "C"`);
  need(wallets.every(row => row.tenantId && row.username && Number.isSafeInteger(row.wallet.balanceCents)), 'WALLET_IDENTITY_INVALID');
  const total = wallets.reduce((sum, row) => sum + BigInt(row.wallet.balanceCents), 0n);
  const summary = { wallets: wallets.length, nonzeroWallets: wallets.filter(row => row.wallet.balanceCents !== 0).length,
    negativeWallets: wallets.filter(row => row.wallet.balanceCents < 0).length, balanceCents: total.toString() };
  const snapshot = { format: MARKER, operationId, databaseIdentitySha256: sha(identity), wallets };
  return { snapshot, snapshotSha256: sha(snapshot), summary };
}

async function preservation(tx) {
  const result = {};
  // Hashes only: payment URL, account identity and usage metadata never leave the transaction as plain text.
  for (const name of ['GatewayOrder', 'GatewayUsage']) {
    const [row] = await tx.$queryRawUnsafe(`SELECT count(*)::text AS count,
      md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t.id COLLATE "C"), '')) AS checksum
      FROM public."${name}" t`);
    result[name] = row;
  }
  const states = await tx.$queryRawUnsafe('SELECT status, count(*)::text AS count FROM public."GatewayOrder" GROUP BY status ORDER BY status');
  result.orderStates = states;
  return result;
}

async function auditExists(tx) {
  const [row] = await tx.$queryRawUnsafe('SELECT to_regclass($1)::text AS name', `${SCHEMA}.${TABLE}`);
  return row.name !== null;
}
async function validateAudit(tx) {
  need(canonical(await columns(tx, SCHEMA, TABLE)) === canonical(AUDIT_COLUMNS), 'UNEXPECTED_AUDIT_SCHEMA');
  const [row] = await tx.$queryRawUnsafe(`SELECT obj_description($1::regclass) AS marker,
    (SELECT count(*)::int FROM pg_constraint WHERE conrelid=$1::regclass AND contype='p'
      AND pg_get_constraintdef(oid)='PRIMARY KEY (operation_id)') AS primary_keys`, `${SCHEMA}.${TABLE}`);
  need(row.marker === MARKER && row.primary_keys === 1, 'UNEXPECTED_AUDIT_CONSTRAINTS');
  const triggers = await tx.$queryRawUnsafe(`SELECT t.tgenabled, p.prosrc FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid=$1::regclass AND NOT t.tgisinternal ORDER BY t.tgname`, `${SCHEMA}.${TABLE}`);
  need(triggers.length === 2 && triggers.every(row => row.tgenabled === 'O' && row.prosrc === IMMUTABLE_BODY), 'AUDIT_IMMUTABILITY_CHANGED');
}
async function createAudit(tx) {
  if (await auditExists(tx)) { await validateAudit(tx); return; }
  const [{ exists }] = await tx.$queryRawUnsafe('SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS exists', SCHEMA);
  // An unexpected preexisting namespace is not adopted or modified.
  need(!exists, 'UNEXPECTED_EXISTING_AUDIT_NAMESPACE');
  await tx.$executeRawUnsafe(`CREATE SCHEMA ${SCHEMA}`);
  await tx.$executeRawUnsafe(`REVOKE ALL ON SCHEMA ${SCHEMA} FROM PUBLIC`);
  await tx.$executeRawUnsafe(`CREATE TABLE ${SCHEMA}.${TABLE} (
    operation_id TEXT PRIMARY KEY, snapshot_sha256 TEXT NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),
    payload JSONB NOT NULL CHECK(payload->>'format'='${MARKER}'), created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`);
  await tx.$executeRawUnsafe(`COMMENT ON TABLE ${SCHEMA}.${TABLE} IS '${MARKER}'`);
  await tx.$executeRawUnsafe(`CREATE FUNCTION ${SCHEMA}.reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$${IMMUTABLE_BODY}$$`);
  await tx.$executeRawUnsafe(`CREATE TRIGGER preserve_audit_rows BEFORE UPDATE OR DELETE ON ${SCHEMA}.${TABLE} FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.reject_audit_mutation()`);
  await tx.$executeRawUnsafe(`CREATE TRIGGER preserve_audit_batches BEFORE TRUNCATE ON ${SCHEMA}.${TABLE} FOR EACH STATEMENT EXECUTE FUNCTION ${SCHEMA}.reject_audit_mutation()`);
  await validateAudit(tx);
}
async function previous(tx, config) {
  if (!await auditExists(tx)) return null;
  await validateAudit(tx);
  const rows = await tx.$queryRawUnsafe(`SELECT snapshot_sha256, payload FROM ${SCHEMA}.${TABLE} WHERE operation_id=$1`, config.operationId);
  if (!rows.length) return null;
  const row = rows[0];
  need(row.payload.format === MARKER && row.payload.operationId === config.operationId, 'AUDIT_IDENTITY_MISMATCH');
  if (config.apply) need(row.snapshot_sha256 === config.snapshotSha256, 'OPERATION_ID_ALREADY_USED_WITH_DIFFERENT_SNAPSHOT');
  return { ...row.payload.receipt, applied: false, alreadyApplied: true };
}

/** The supplied Prisma-compatible client owns the connection. This function never logs or disconnects it. */
export async function resetPurchasedCredits(client, input) {
  const config = options(input);
  return client.$transaction(async tx => {
    if (!config.apply) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='5s'");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='30s'");
    if (config.apply) {
      // Serializes all operations from this tool; the wallet table lock also covers legacy callers.
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(20261002, 7001)::text');
    }
    const completed = await previous(tx, config);
    if (completed) return completed; // Do not inspect or reset any subsequent recharge.
    if (config.apply) {
      await createAudit(tx);
      await tx.$executeRawUnsafe('LOCK TABLE public."GatewayWallet" IN EXCLUSIVE MODE');
    }
    const { snapshot, snapshotSha256, summary } = await readSnapshot(tx, config.operationId);
    const beforeRecords = await preservation(tx);
    if (!config.apply) return { format: MARKER, operationId: config.operationId, dryRun: true,
      snapshotSha256, summary, existingRecords: beforeRecords, authorizedBy: AUTHORIZED_BY,
      executedBy: EXECUTED_BY, request: REQUEST, sourceChanged: false };
    need(snapshotSha256 === config.snapshotSha256, 'SNAPSHOT_CHANGED_NO_BALANCES_UPDATED');
    const adjustments = snapshot.wallets.filter(row => row.wallet.balanceCents !== 0).map(row => ({
      userId: row.userId, tenantId: row.tenantId, username: row.username, userName: row.userName,
      beforeCents: row.wallet.balanceCents, afterCents: 0, deltaCents: (-BigInt(row.wallet.balanceCents)).toString()
    }));
    const changed = await tx.$executeRawUnsafe('UPDATE public."GatewayWallet" SET "balanceCents"=0, "updatedAt"=CURRENT_TIMESTAMP WHERE "balanceCents"<>0');
    need(changed === adjustments.length, 'WALLET_UPDATE_COUNT_MISMATCH');
    const after = await readSnapshot(tx, config.operationId);
    need(after.summary.nonzeroWallets === 0 && after.summary.wallets === summary.wallets, 'WALLET_RESET_POSTCONDITION_FAILED');
    const retainedFields = rows => rows.map(row => {
      const result = structuredClone(row); delete result.wallet.balanceCents; delete result.wallet.updatedAt; return result;
    });
    need(canonical(retainedFields(snapshot.wallets)) === canonical(retainedFields(after.snapshot.wallets)), 'NON_BALANCE_FIELDS_CHANGED');
    const afterRecords = await preservation(tx);
    const receipt = { format: MARKER, operationId: config.operationId, snapshotSha256, applied: true, alreadyApplied: false,
      summary, adjustedWallets: changed, balanceCentsAfter: '0', deltaCents: (-BigInt(summary.balanceCents)).toString(),
      recordChecksumsBefore: beforeRecords, recordChecksumsAfter: afterRecords,
      concurrentRecordChangeObserved: canonical(beforeRecords) !== canonical(afterRecords),
      authorizedBy: AUTHORIZED_BY, executedBy: EXECUTED_BY, request: REQUEST,
      auditTable: `${SCHEMA}.${TABLE}`, zeroAtTransactionCommit: true, futureTransactionsRemainEnabled: true };
    const payload = { format: MARKER, operationId: config.operationId, snapshot, adjustments, receipt };
    await tx.$executeRawUnsafe(`INSERT INTO ${SCHEMA}.${TABLE}(operation_id,snapshot_sha256,payload) VALUES($1,$2,$3::jsonb)`,
      config.operationId, snapshotSha256, JSON.stringify(payload));
    return receipt;
  }, { isolationLevel: config.apply ? 'ReadCommitted' : 'RepeatableRead', maxWait: 10_000, timeout: 60_000 });
}

function parseArguments(argv) {
  const config = { apply: false }; const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]; need(!seen.has(flag), 'DUPLICATE_ARGUMENT'); seen.add(flag);
    if (flag === '--apply') { config.apply = true; continue; }
    const key = { '--operation-id': 'operationId', '--expected-snapshot-sha': 'snapshotSha256', '--client-root': 'clientRoot', '--receipt-file': 'receiptFile' }[flag];
    need(key && argv[index + 1] && !argv[index + 1].startsWith('--'), 'INVALID_ARGUMENT'); config[key] = argv[++index];
  }
  need(config.clientRoot && path.isAbsolute(config.clientRoot), 'ABSOLUTE_CLIENT_ROOT_REQUIRED');
  if (config.receiptFile) need(path.isAbsolute(config.receiptFile), 'ABSOLUTE_RECEIPT_FILE_REQUIRED');
  options(config); return config;
}
async function main() {
  const config = parseArguments(process.argv.slice(2));
  need(process.env.DATABASE_URL, 'DATABASE_URL_ENV_REQUIRED');
  let url;
  try { url = new URL(process.env.DATABASE_URL); } catch { throw new CreditResetError('INVALID_DATABASE_URL'); }
  need(['postgres:', 'postgresql:'].includes(url.protocol), 'POSTGRESQL_REQUIRED');
  url.searchParams.set('connection_limit', '1');
  const require = createRequire(path.join(config.clientRoot, 'package.json'));
  const { PrismaClient } = require('@prisma/client');
  const client = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] });
  let result;
  try { result = await resetPurchasedCredits(client, config); } finally { await client.$disconnect(); }
  // Only aggregated data. No DSN, payment material or wallet identity in console/receipt output.
  // Audit has already committed; if local receipt writing fails, replay the SAME operation ID and SHA.
  if (config.receiptFile) await writeFile(config.receiptFile, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = error instanceof CreditResetError ? error.code : 'CREDIT_RESET_FAILED_CHECK_STATE_WITH_SAME_OPERATION_ID';
    process.stderr.write(JSON.stringify({ ok: false, code, secretValuesOmitted: true }) + '\n'); process.exitCode = 1;
  });
}
