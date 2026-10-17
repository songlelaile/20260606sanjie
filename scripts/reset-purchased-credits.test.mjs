import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { resetPurchasedCredits } from './reset-purchased-credits.mjs';

const run = promisify(execFile);
let directory, port, admin;
const clients = new Set();
function client(database) {
  const instance = new PrismaClient({ datasources: { db: { url: `postgresql://credit_reset_test@127.0.0.1:${port}/${database}?connection_limit=1` } }, log: [] });
  clients.add(instance); return instance;
}
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'credit-reset-isolated-pg-'));
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port; await new Promise(resolve => server.close(resolve));
  await run('initdb', ['-D', path.join(directory, 'data'), '-U', 'credit_reset_test', '-A', 'trust', '--no-locale', '-E', 'UTF8'], { timeout: 30_000 });
  await run('pg_ctl', ['-D', path.join(directory, 'data'), '-l', path.join(directory, 'server.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${directory} -c max_connections=15`, '-w', 'start'], { timeout: 30_000 });
  admin = client('postgres');
});
after(async () => {
  for (const instance of clients) await instance.$disconnect().catch(() => {});
  if (directory) {
    await run('pg_ctl', ['-D', path.join(directory, 'data'), '-m', 'immediate', '-w', 'stop']).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
async function fixture() {
  const database = 'reset_' + randomUUID().replaceAll('-', '');
  await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
  const db = client(database);
  for (const statement of [
    'CREATE TABLE "Tenant"(id text PRIMARY KEY,name text NOT NULL)',
    'CREATE TABLE "User"(id text PRIMARY KEY,"tenantId" text NOT NULL REFERENCES "Tenant"(id),username text NOT NULL,name text NOT NULL,"authRole" text NOT NULL,status text NOT NULL)',
    'CREATE TABLE "GatewayWallet"("userId" text PRIMARY KEY REFERENCES "User"(id),"balanceCents" integer NOT NULL,"monthlyQuotaCents" integer NOT NULL,"planCode" text NOT NULL,"planName" text NOT NULL,"periodStart" timestamp NOT NULL,"periodEnd" timestamp NOT NULL,"updatedAt" timestamp NOT NULL)',
    'CREATE TABLE "GatewayOrder"(id text PRIMARY KEY,status text NOT NULL,"creditCents" integer NOT NULL,"paymentReceipt" text NOT NULL)',
    'CREATE TABLE "GatewayUsage"(id text PRIMARY KEY,"costCents" integer NOT NULL,metadata jsonb NOT NULL)',
    `INSERT INTO "Tenant" VALUES('t1','synthetic-tenant')`,
    `INSERT INTO "User" VALUES('u1','t1','synthetic-one','one','admin','active'),('u2','t1','synthetic-two','two','tenant','disabled'),('u3','t1','synthetic-three','three','tenant','active')`,
    `INSERT INTO "GatewayWallet" VALUES('u1',414000,12000,'pro','professional','2026-09-01','2026-11-01','2026-09-01'),('u2',482000,5000,'basic','basic','2026-09-02','2026-11-02','2026-09-02'),('u3',0,0,'free','free','2026-09-03','2026-11-03','2026-09-03')`,
    `INSERT INTO "GatewayOrder" VALUES('o1','paid',414000,'synthetic-receipt')`,
    `INSERT INTO "GatewayUsage" VALUES('usage1',100,'{"source":"fixture"}')`
  ]) await db.$executeRawUnsafe(statement);
  return { db, database, operationId: randomUUID() };
}
const wallets = db => db.$queryRawUnsafe('SELECT * FROM "GatewayWallet" ORDER BY "userId"');

test('dry-run is read-only; reset only balances/timestamps; replay never clears a new recharge; audit immutable', async () => {
  const { db, operationId } = await fixture();
  const initial = await wallets(db);
  const dry = await resetPurchasedCredits(db, { operationId });
  assert.deepEqual(dry.summary, { wallets: 3, nonzeroWallets: 2, negativeWallets: 0, balanceCents: '896000' });
  assert.deepEqual(await wallets(db), initial);
  assert.equal((await db.$queryRawUnsafe("SELECT to_regnamespace('sanjie_credit_reset_ops')::text AS name"))[0].name, null);
  const applied = await resetPurchasedCredits(db, { operationId, apply: true, snapshotSha256: dry.snapshotSha256 });
  assert.equal(applied.adjustedWallets, 2);
  assert.deepEqual(applied.recordChecksumsBefore, applied.recordChecksumsAfter);
  const current = await wallets(db);
  for (let index = 0; index < current.length; index++) {
    assert.equal(current[index].balanceCents, 0);
    const { balanceCents: oldBalance, updatedAt: oldTime, ...oldFields } = initial[index];
    const { balanceCents: newBalance, updatedAt: newTime, ...newFields } = current[index];
    assert.deepEqual(newFields, oldFields);
    if (oldBalance === 0) assert.deepEqual(newTime, oldTime);
  }
  const [audit] = await db.$queryRawUnsafe('SELECT payload FROM sanjie_credit_reset_ops.balance_reset_batches');
  assert.equal(audit.payload.snapshot.wallets.length, 3);
  assert.equal(audit.payload.adjustments.length, 2);
  assert.equal(audit.payload.receipt.authorizedBy, 'human user in task');
  await db.$executeRawUnsafe(`UPDATE "GatewayWallet" SET "balanceCents"=900 WHERE "userId"='u1'`);
  const replay = await resetPurchasedCredits(db, { operationId, apply: true, snapshotSha256: dry.snapshotSha256 });
  assert.equal(replay.alreadyApplied, true);
  assert.equal((await wallets(db))[0].balanceCents, 900);
  assert.equal(JSON.stringify(applied).includes('synthetic-'), false);
  await assert.rejects(db.$executeRawUnsafe('DELETE FROM sanjie_credit_reset_ops.balance_reset_batches'));
  await assert.rejects(db.$executeRawUnsafe('TRUNCATE sanjie_credit_reset_ops.balance_reset_batches'));
  await assert.rejects(resetPurchasedCredits(db, { operationId, apply: true, snapshotSha256: '0'.repeat(64) }), /OPERATION_ID_ALREADY_USED/);
});

test('stale snapshot and injected post-update failure roll back all balances and audit DDL', async () => {
  const { db, operationId } = await fixture();
  const dry = await resetPurchasedCredits(db, { operationId });
  const initial = await wallets(db);
  await assert.rejects(resetPurchasedCredits(db, { operationId, apply: true, snapshotSha256: '0'.repeat(64) }), /SNAPSHOT_CHANGED/);
  assert.deepEqual(await wallets(db), initial);
  const failing = { $transaction(callback, opts) { return db.$transaction(tx => callback(new Proxy(tx, {
    get(target, property) {
      if (property === '$executeRawUnsafe') return async (sql, ...params) => {
        if (sql.startsWith('INSERT INTO sanjie_credit_reset_ops.balance_reset_batches')) throw new Error('synthetic-failure-after-wallet-update');
        return target.$executeRawUnsafe(sql, ...params);
      };
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    }
  })), opts); } };
  await assert.rejects(resetPurchasedCredits(failing, { operationId, apply: true, snapshotSha256: dry.snapshotSha256 }), /synthetic-failure/);
  assert.deepEqual(await wallets(db), initial);
  assert.equal((await db.$queryRawUnsafe("SELECT to_regnamespace('sanjie_credit_reset_ops')::text AS name"))[0].name, null);
});

test('wallet EXCLUSIVE lock blocks concurrent recharge, which proceeds after commit without being erased', async () => {
  const { db, database, operationId } = await fixture();
  const writer = client(database), observer = client(database);
  const dry = await resetPurchasedCredits(db, { operationId });
  let resolveLocked, releaseReset;
  const locked = new Promise(resolve => { resolveLocked = resolve; });
  const release = new Promise(resolve => { releaseReset = resolve; });
  const paused = { $transaction(callback, opts) { return db.$transaction(tx => callback(new Proxy(tx, {
    get(target, property) {
      if (property === '$executeRawUnsafe') return async (sql, ...params) => {
        const result = await target.$executeRawUnsafe(sql, ...params);
        if (sql.startsWith('LOCK TABLE public."GatewayWallet"')) { resolveLocked(); await release; }
        return result;
      };
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    }
  })), opts); } };
  const applying = resetPurchasedCredits(paused, { operationId, apply: true, snapshotSha256: dry.snapshotSha256 });
  await locked;
  let writeFinished = false;
  const writing = writer.$executeRawUnsafe(`UPDATE "GatewayWallet" SET "balanceCents"="balanceCents"+777 WHERE "userId"='u1'`).then(() => { writeFinished = true; });
  try {
    let blocked = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const [row] = await observer.$queryRawUnsafe(`SELECT count(*)::int AS count FROM pg_locks WHERE relation='"GatewayWallet"'::regclass AND NOT granted`);
      if (row.count > 0) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(blocked, true); assert.equal(writeFinished, false);
  } finally { releaseReset(); }
  await applying; await writing;
  assert.equal((await wallets(db))[0].balanceCents, 777);
});

test('ledger branch refused; CLI never exposes a supplied database credential on parse failure', async () => {
  const { db, operationId } = await fixture();
  await db.$executeRawUnsafe('CREATE TABLE "GatewayBillingLedger"(id text)');
  await assert.rejects(resetPurchasedCredits(db, { operationId }), /BILLING_LEDGER_REQUIRES/);
  const result = await run(process.execPath, [new URL('./reset-purchased-credits.mjs', import.meta.url).pathname, '--unknown'],
    { env: { PATH: process.env.PATH, DATABASE_URL: 'postgresql://fake:synthetic-private-secret@invalid/never-connect' } }).catch(error => error);
  assert.equal(result.code, 1);
  assert.equal((result.stdout + result.stderr).includes('synthetic-private-secret'), false);
  assert.equal((result.stdout + result.stderr).includes('postgresql://'), false);
});
