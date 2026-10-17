#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The test constructs its own URL. No repository or production DATABASE_URL is
// read, and PostgreSQL is addressed only by our temporary data directory.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDirectory = path.join(root, ".codex-deploy/anti-clone-20261002");
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "sanjie-ai-access-pg-"));
const dataDirectory = path.join(temporaryDirectory, "data");
const socketDirectory = path.join(temporaryDirectory, "socket");
const binaries = "/opt/homebrew/bin";
const logs = [];
const report = { startedAt: new Date().toISOString(), scope: "temporary loopback PostgreSQL only", migrations: [], checks: [], passed: false, postgresStopped: false };
const legacyId = "1ef6bf72-3a94-4bb7-8302-e7ca86dde61a";
const legacyToken = `sja_${legacyId}.${"l".repeat(43)}`;
let port;
let startAttempted = false;

async function command(executable, args, options = {}) {
  const child = spawn(executable, args, { cwd: root, ...options, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(timer);
  logs.push(`${path.basename(executable)} ${args.map(argument => argument.replaceAll(temporaryDirectory, "<temporary>")).join(" ")}\n${output.trim()}\nexit ${code}`);
  if (code !== 0) throw new Error(`${path.basename(executable)} failed with exit ${code}`);
  return output;
}
const psql = (sql, database = "ai_access_test") => command(path.join(binaries, "psql"), [
  "-X", "--host=127.0.0.1", `--port=${port}`, "--username=ai_security_test", `--dbname=${database}`,
  "--set=ON_ERROR_STOP=1", "-At", "-c", sql
]);

try {
  await mkdir(evidenceDirectory, { recursive: true });
  await mkdir(socketDirectory);
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  report.port = port;
  report.postgresVersion = (await command(path.join(binaries, "postgres"), ["--version"])).trim();
  await command(path.join(binaries, "initdb"), ["--pgdata", dataDirectory, "--username=ai_security_test", "--auth=trust", "--no-locale", "--encoding=UTF8"]);
  startAttempted = true;
  await command(path.join(binaries, "pg_ctl"), ["start", "--pgdata", dataDirectory, "--log", path.join(temporaryDirectory, "postgres.log"),
    "--options", `-h 127.0.0.1 -p ${port} -k ${socketDirectory} -F -c lock_timeout=3s -c statement_timeout=10s`, "--wait", "--timeout=20"]);
  await psql("CREATE DATABASE ai_access_test;", "postgres");
  await psql(`CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "username" TEXT UNIQUE NOT NULL, "tenantId" TEXT NOT NULL, "authRole" TEXT NOT NULL, "status" TEXT NOT NULL);
    CREATE TABLE "Shop" ("id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL);
    INSERT INTO "User" VALUES ('admin-a','fixture-admin-a','tenant-a','admin','active'),('admin-b','fixture-admin-b','tenant-b','admin','active'),('tenant-user','fixture-tenant','tenant-a','tenant','active');
    INSERT INTO "Shop" VALUES ('shop-a','tenant-a'),('shop-a2','tenant-a'),('shop-b','tenant-b');`);
  for (const name of ["20261002143000_security_rate_bucket", "20261002150000_ai_access_channel"]) {
    const migration = await readFile(path.join(root, "prisma/migrations", name, "migration.sql"), "utf8");
    await psql(migration);
    report.migrations.push({ name, sha256: createHash("sha256").update(migration).digest("hex") });
  }
  // Insert a genuine old-schema finite grant before applying the additive migration.
  await psql(`INSERT INTO "AIAccessGrant" ("id","userId","username","tenantId","name","scope","tokenHash","expiresAt")
    VALUES ('${legacyId}','admin-a','fixture-admin-a','tenant-a','legacy','read','${createHash("sha256").update(legacyToken).digest("hex")}',CURRENT_TIMESTAMP+INTERVAL '30 minutes');`);
  const manualMigrationName = "20261002170000_ai_access_manual_control";
  const manualMigration = await readFile(path.join(root, "prisma/migrations", manualMigrationName, "migration.sql"), "utf8");
  await psql(manualMigration);
  report.migrations.push({ name: manualMigrationName, sha256: createHash("sha256").update(manualMigration).digest("hex") });
  await writeFile(path.join(temporaryDirectory, "empty.mjs"), "export {};\n");
  await writeFile(path.join(temporaryDirectory, "vitest.config.mjs"), `export default { root: ${JSON.stringify(temporaryDirectory)}, test: { environment: 'node', include: ['integration.test.ts'], testTimeout: 30000 }, resolve: { alias: { '@': ${JSON.stringify(path.join(root, "src"))}, 'server-only': ${JSON.stringify(path.join(temporaryDirectory, "empty.mjs"))} } } };\n`);
  await writeFile(path.join(temporaryDirectory, "integration.test.ts"), `
import { test } from ${JSON.stringify(path.join(root, "node_modules/vitest/dist/index.js"))};
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { prisma } from ${JSON.stringify(path.join(root, "src/lib/db.ts"))};
import { createAIAccessGrant, authorizeAIAccessToken, listAIAccessGrants, revokeAIAccessGrant, setAIAccessGrantEnabled, setAIAccessActiveShop, recordAIAccessEvent, listAIAccessEvents } from ${JSON.stringify(path.join(root, "src/lib/ai-access.ts"))};

test('manual controls run against isolated PostgreSQL with real migrations, transactions and locks', async () => {
  const target = new URL(process.env.DATABASE_URL!);
  assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.username, 'ai_security_test'); assert.equal(target.pathname, '/ai_access_test');
  const checks: Array<{name:string;passed:boolean;rounds?:number}> = [];
  const check = (name:string, extra = {}) => checks.push({name,passed:true,...extra});
  const a = { username:'fixture-admin-a',tenantId:'tenant-a',role:'admin' as const };
  const b = { username:'fixture-admin-b',tenantId:'tenant-b',role:'admin' as const };
  const legacyId = ${JSON.stringify(legacyId)};
  const legacyToken = ${JSON.stringify(legacyToken)};
  const counts = async () => Number((await prisma.$queryRaw<Array<{count:bigint}>>\`SELECT count(*) AS count FROM "AIAccessGrant"\`)[0].count);
  const denied = async (operation:Promise<unknown>, status:number) => {
    let code = 0; try { await operation; } catch(error) { code = (error as {status:number}).status; }
    assert.equal(code,status,'operation must fail with the expected safe status');
  };
  try {
    const migrated = await prisma.$queryRaw<Array<{manualControl:boolean;disabledAt:Date|null;revokedAt:Date|null;expiresAt:Date;createdAt:Date}>>\`SELECT "manualControl","disabledAt","revokedAt","expiresAt","createdAt" FROM "AIAccessGrant" WHERE "id"=\${legacyId}::uuid\`;
    assert.equal(migrated[0].manualControl,false); assert.equal(migrated[0].disabledAt,null); assert.equal(migrated[0].revokedAt,null);
    assert.equal(migrated[0].expiresAt.getTime()-migrated[0].createdAt.getTime(),30*60*1000);
    assert.ok(await authorizeAIAccessToken(legacyToken,'read'));
    for (const enabled of [true,false]) await denied(setAIAccessGrantEnabled(a,legacyId,enabled),409);
    const legacyView = (await listAIAccessGrants(a)).find(grant=>grant.id===legacyId)!;
    assert.equal(legacyView.expiresAt,migrated[0].expiresAt.toISOString());
    check('additive migration preserves old finite grants and neither toggle converts nor extends them');

    await denied(createAIAccessGrant({...a,role:'tenant'}, {scope:'read'}),403);
    assert.equal(await counts(),1); check('tenant account cannot create a grant');
    await denied(createAIAccessGrant(a,{scope:'read',durationMinutes:30} as never),400);
    assert.equal(await counts(),1); check('helper rejects caller-supplied durations');

    const action = await createAIAccessGrant(a,{scope:'action',activeShopId:'shop-a'});
    assert.equal(/^sja_[a-f0-9-]{36}\\.[A-Za-z0-9_-]{43}$/.test(action.token),true,'opaque token has 256-bit secret');
    const actionHash = createHash('sha256').update(action.token).digest('hex');
    const stored = await prisma.$queryRaw<Array<Record<string,unknown>>>\`SELECT * FROM "AIAccessGrant" WHERE "id"=\${action.grant.id}::uuid\`;
    assert.equal(stored[0].tokenHash === actionHash,true,'stored credential is its hash');
    assert.equal(JSON.stringify(stored).includes(action.token),false,'no plaintext token persisted');
    assert.equal(JSON.stringify(stored).includes(action.token.split('.')[1]),false,'no plaintext secret persisted');
    assert.equal(action.grant.enabled,false); assert.equal(action.grant.expiresAt,null); assert.equal(action.grant.revokedAt,null);
    assert.equal(stored[0].manualControl,true); assert.equal(stored[0].disabledAt instanceof Date,true);
    assert.equal((stored[0].disabledAt as Date).getTime(),(stored[0].revokedAt as Date).getTime());
    assert.equal(await authorizeAIAccessToken(action.token,'read'),null);
    const oldClosed = await prisma.$queryRaw<Array<{id:string}>>\`SELECT "id" FROM "AIAccessGrant" WHERE "id"=\${action.grant.id}::uuid AND "revokedAt" IS NULL AND "expiresAt">CURRENT_TIMESTAMP\`;
    assert.equal(oldClosed.length,0); check('new grant is closed, returns no public expiry, hashes secrets and denies both new and rollback predicates');
    const enabledAction = await setAIAccessGrantEnabled(a,action.grant.id,true);
    assert.equal(enabledAction.enabled,true); assert.equal(enabledAction.expiresAt,null);
    assert.equal('token' in enabledAction,false); check('manual enable never rotates or returns a token');

    const read = await createAIAccessGrant(a,{scope:'read',activeShopId:'shop-a'});
    await setAIAccessGrantEnabled(a,read.grant.id,true);
    const readAuth = await authorizeAIAccessToken(read.token,'read'); assert.ok(readAuth,'read authorization exists');
    assert.equal(await authorizeAIAccessToken(read.token,'action'),null);
    const actionAuth = await authorizeAIAccessToken(action.token,'action'); assert.ok(actionAuth,'action authorization exists');
    assert.ok(await authorizeAIAccessToken(action.token,'read'),'action includes read');
    check('read scope cannot act; action includes read');

    const expiring = await createAIAccessGrant(a,{scope:'read'});
    await setAIAccessGrantEnabled(a,expiring.grant.id,true);
    await prisma.$executeRaw\`UPDATE "AIAccessGrant" SET "createdAt"=CURRENT_TIMESTAMP-INTERVAL '60 minutes', "expiresAt"=CURRENT_TIMESTAMP-INTERVAL '30 minutes' WHERE "id"=\${expiring.grant.id}::uuid\`;
    assert.ok(await authorizeAIAccessToken(expiring.token,'read'));
    assert.equal((await listAIAccessGrants(a)).find(grant=>grant.id===expiring.grant.id)!.expiresAt,null);
    const rollbackExpired = await prisma.$queryRaw<Array<{id:string}>>\`SELECT "id" FROM "AIAccessGrant" WHERE "id"=\${expiring.grant.id}::uuid AND "revokedAt" IS NULL AND "expiresAt">CURRENT_TIMESTAMP\`;
    assert.equal(rollbackExpired.length,0); check('enabled manual grant survives physical expiry while old rollback code fails closed after its window');
    await prisma.$executeRaw\`UPDATE "AIAccessGrant" SET "createdAt"=CURRENT_TIMESTAMP-INTERVAL '60 minutes', "expiresAt"=CURRENT_TIMESTAMP-INTERVAL '30 minutes' WHERE "id"=\${legacyId}::uuid\`;
    assert.equal(await authorizeAIAccessToken(legacyToken,'read'),null); check('finite legacy expiry is still enforced without automatic extension');
    const closedPastExpiry = await setAIAccessGrantEnabled(a,expiring.grant.id,false); assert.equal(closedPastExpiry.enabled,false);
    assert.equal(await authorizeAIAccessToken(expiring.token,'read'),null);
    await setAIAccessGrantEnabled(a,expiring.grant.id,true); assert.ok(await authorizeAIAccessToken(expiring.token,'read'));
    check('manual close and same-token reopen work even after the rollback-only deadline');

    const precision = await createAIAccessGrant(a,{scope:'read'});
    await prisma.$executeRaw\`UPDATE "AIAccessGrant" SET "disabledAt"='2026-10-02T02:00:00.123456Z',"revokedAt"='2026-10-02T02:00:00.123456Z' WHERE "id"=\${precision.grant.id}::uuid\`;
    const preciseState = await prisma.$queryRaw<Array<{microseconds:string}>>\`SELECT to_char("disabledAt",'US') AS microseconds FROM "AIAccessGrant" WHERE "id"=\${precision.grant.id}::uuid\`;
    assert.equal(preciseState[0].microseconds,'123456');
    await setAIAccessGrantEnabled(a,precision.grant.id,true); assert.ok(await authorizeAIAccessToken(precision.token,'read'));
    await setAIAccessGrantEnabled(a,precision.grant.id,false);
    const firstClosed = await prisma.$queryRaw<Array<{stamp:string;same:boolean}>>\`SELECT "disabledAt"::text AS stamp,"disabledAt"="revokedAt" AS same FROM "AIAccessGrant" WHERE "id"=\${precision.grant.id}::uuid\`;
    await setAIAccessGrantEnabled(a,precision.grant.id,false);
    const secondClosed = await prisma.$queryRaw<Array<{stamp:string;same:boolean}>>\`SELECT "disabledAt"::text AS stamp,"disabledAt"="revokedAt" AS same FROM "AIAccessGrant" WHERE "id"=\${precision.grant.id}::uuid\`;
    assert.deepEqual(secondClosed,firstClosed); assert.equal(firstClosed[0].same,true);
    let mismatchRejected=false;
    try { await prisma.$executeRaw\`UPDATE "AIAccessGrant" SET "revokedAt"="disabledAt"+INTERVAL '1 microsecond' WHERE "id"=\${precision.grant.id}::uuid\`; } catch { mismatchRejected=true; }
    assert.equal(mismatchRejected,true); check('paused guard and constraint use full PostgreSQL precision; repeated close preserves the pause timestamp');
    const revoked = await createAIAccessGrant(a,{scope:'read'}); await revokeAIAccessGrant(a,revoked.grant.id);
    assert.equal(await authorizeAIAccessToken(revoked.token,'read'),null); check('revoked grant is rejected immediately');
    const permanent = await prisma.$queryRaw<Array<{disabledAt:Date|null;revokedAt:Date|null}>>\`SELECT "disabledAt","revokedAt" FROM "AIAccessGrant" WHERE "id"=\${revoked.grant.id}::uuid\`;
    assert.equal(permanent[0].disabledAt,null); assert.ok(permanent[0].revokedAt);
    for (const enabled of [true,false]) await denied(setAIAccessGrantEnabled(a,revoked.grant.id,enabled),409);
    check('permanent revoke of a closed grant clears its pause marker and cannot be revived');

    for (const [field, changed, original] of [['status','disabled','active'],['authRole','tenant','admin'],['username','fixture-renamed','fixture-admin-a'],['tenantId','tenant-changed','tenant-a']]) {
      if (field==='status') await prisma.$executeRaw\`UPDATE "User" SET "status"=\${changed} WHERE "id"='admin-a'\`;
      if (field==='authRole') await prisma.$executeRaw\`UPDATE "User" SET "authRole"=\${changed} WHERE "id"='admin-a'\`;
      if (field==='username') await prisma.$executeRaw\`UPDATE "User" SET "username"=\${changed} WHERE "id"='admin-a'\`;
      if (field==='tenantId') await prisma.$executeRaw\`UPDATE "User" SET "tenantId"=\${changed} WHERE "id"='admin-a'\`;
      assert.equal(await authorizeAIAccessToken(action.token,'read'),null,'owner identity/state drift closes access');
      const currentActor = { ...a, username: field==='username' ? changed : a.username, tenantId: field==='tenantId' ? changed : a.tenantId };
      await denied(setAIAccessGrantEnabled(currentActor,action.grant.id,true),field==='username'||field==='tenantId' ? 409 : 403);
      if (field==='status') await prisma.$executeRaw\`UPDATE "User" SET "status"=\${original} WHERE "id"='admin-a'\`;
      if (field==='authRole') await prisma.$executeRaw\`UPDATE "User" SET "authRole"=\${original} WHERE "id"='admin-a'\`;
      if (field==='username') await prisma.$executeRaw\`UPDATE "User" SET "username"=\${original} WHERE "id"='admin-a'\`;
      if (field==='tenantId') await prisma.$executeRaw\`UPDATE "User" SET "tenantId"=\${original} WHERE "id"='admin-a'\`;
      check('owner '+field+' changes invalidate token immediately');
    }

    assert.deepEqual(await listAIAccessGrants(b),[]);
    await denied(revokeAIAccessGrant(b,action.grant.id),404);
    await denied(setAIAccessGrantEnabled(b,action.grant.id,true),409);
    await denied(setAIAccessGrantEnabled(b,action.grant.id,false),409);
    assert.equal(await authorizeAIAccessToken(action.token,'read',b),null);
    const visible = await listAIAccessGrants(a);
    assert.equal(JSON.stringify(visible).includes(action.token),false);
    assert.equal(JSON.stringify(visible).includes(actionHash),false);
    check('owner lists contain no credential; other admin cannot list, toggle, revoke or bind it');

    const changed = await setAIAccessActiveShop(actionAuth,'shop-a2'); assert.equal(changed.activeShopId,'shop-a2');
    await denied(setAIAccessActiveShop(changed,'shop-b'),404);
    await denied(setAIAccessActiveShop(readAuth,'shop-a2'),403);
    const context = await prisma.$queryRaw<Array<{activeShopId:string}>>\`SELECT "activeShopId" FROM "AIAccessGrant" WHERE "id"=\${action.grant.id}::uuid\`;
    assert.equal(context[0].activeShopId,'shop-a2'); check('shop context stays in its grant and tenant; read scope cannot switch');

    await recordAIAccessEvent(changed,{method:'GET',path:'/api/shops?token=fixture-private',status:200});
    const audit = await listAIAccessEvents(a);
    assert.equal(JSON.stringify(audit).includes('fixture-private'),false);
    assert.equal(JSON.stringify(audit).includes(action.token),false); check('audit excludes credentials, query strings and request bodies');

    await prisma.$executeRawUnsafe("CREATE FUNCTION reject_ai_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END; $$;");
    await prisma.$executeRawUnsafe('CREATE TRIGGER reject_ai_audit BEFORE INSERT ON "AIAccessEvent" FOR EACH ROW EXECUTE FUNCTION reject_ai_audit();');
    const beforeCount = await counts();
    await denied(createAIAccessGrant(a,{scope:'read'}),503); assert.equal(await counts(),beforeCount); check('audit failure rolls back grant creation');
    await denied(setAIAccessGrantEnabled(a,precision.grant.id,true),503);
    const rollbackEnable = await prisma.$queryRaw<Array<{disabledAt:Date|null;revokedAt:Date|null}>>\`SELECT "disabledAt","revokedAt" FROM "AIAccessGrant" WHERE "id"=\${precision.grant.id}::uuid\`;
    assert.ok(rollbackEnable[0].disabledAt); assert.ok(rollbackEnable[0].revokedAt); check('enable audit failure leaves the channel closed');
    await denied(setAIAccessGrantEnabled(a,action.grant.id,false),503);
    const rollbackDisable = await prisma.$queryRaw<Array<{disabledAt:Date|null;revokedAt:Date|null}>>\`SELECT "disabledAt","revokedAt" FROM "AIAccessGrant" WHERE "id"=\${action.grant.id}::uuid\`;
    assert.equal(rollbackDisable[0].disabledAt,null); assert.equal(rollbackDisable[0].revokedAt,null); check('disable audit failure rolls back the switch and never falsely acknowledges closure');
    await denied(revokeAIAccessGrant(a,precision.grant.id),503);
    const rollbackRevoke = await prisma.$queryRaw<Array<{disabledAt:Date|null;revokedAt:Date|null}>>\`SELECT "disabledAt","revokedAt" FROM "AIAccessGrant" WHERE "id"=\${precision.grant.id}::uuid\`;
    assert.deepEqual(rollbackRevoke,rollbackEnable); check('permanent-revoke audit failure preserves a reversible closed grant');
    await denied(setAIAccessActiveShop(changed,'shop-a'),503);
    const rollbackContext = await prisma.$queryRaw<Array<{activeShopId:string}>>\`SELECT "activeShopId" FROM "AIAccessGrant" WHERE "id"=\${action.grant.id}::uuid\`;
    assert.equal(rollbackContext[0].activeShopId,'shop-a2'); check('audit failure rolls back shop context update');
    await prisma.$executeRaw\`UPDATE "AIAccessGrant" SET "lastUsedAt"='2020-01-01T00:00:00Z' WHERE "id"=\${action.grant.id}::uuid\`;
    await denied(authorizeAIAccessToken(action.token,'read'),503);
    const lastUsed = await prisma.$queryRaw<Array<{lastUsedAt:Date}>>\`SELECT "lastUsedAt" FROM "AIAccessGrant" WHERE "id"=\${action.grant.id}::uuid\`;
    assert.equal(lastUsed[0].lastUsedAt.toISOString(),'2020-01-01T00:00:00.000Z'); check('audit failure rolls back lastUsedAt and closes authorization');
    await denied(listAIAccessGrants(a),503); await denied(listAIAccessEvents(a),503); await denied(recordAIAccessEvent(changed,{method:'GET',path:'/api/shops'}),503);
    check('read, audit-list and request-audit failures close the channel');
    await prisma.$executeRawUnsafe('DROP TRIGGER reject_ai_audit ON "AIAccessEvent";'); await prisma.$executeRawUnsafe('DROP FUNCTION reject_ai_audit();');

    await setAIAccessGrantEnabled(a,action.grant.id,false);
    await denied(setAIAccessActiveShop(changed,'shop-a'),401);
    await denied(recordAIAccessEvent(changed,{method:'GET',path:'/api/shops'}),401);
    assert.equal(await authorizeAIAccessToken(action.token,'read'),null);
    await setAIAccessGrantEnabled(a,action.grant.id,true);
    assert.ok(await authorizeAIAccessToken(action.token,'read'));
    check('closed state invalidates authorization snapshots for further context and audit work; reopening preserves the original token');

    for (let round=0;round<15;round++) {
      const concurrent = await createAIAccessGrant(a,{scope:'read'});
      await setAIAccessGrantEnabled(a,concurrent.grant.id,true);
      const results = await Promise.all([authorizeAIAccessToken(concurrent.token,'read'),setAIAccessGrantEnabled(a,concurrent.grant.id,false)]);
      assert.equal(results[1].enabled,false); assert.equal(await authorizeAIAccessToken(concurrent.token,'read'),null);
      await setAIAccessGrantEnabled(a,concurrent.grant.id,true); assert.ok(await authorizeAIAccessToken(concurrent.token,'read'));
      await setAIAccessGrantEnabled(a,concurrent.grant.id,false); await revokeAIAccessGrant(a,concurrent.grant.id);
      await denied(setAIAccessGrantEnabled(a,concurrent.grant.id,true),409);
      assert.equal(await authorizeAIAccessToken(concurrent.token,'read'),null);
    }
    check('concurrent close and authorize serialize without deadlock; post-commit authorization is denied, same-token reopen works and permanent revoke cannot be revived',{rounds:15});
    const finalEvents = await listAIAccessEvents(a);
    assert.ok(finalEvents.some(event=>event.type==='enable')); assert.ok(finalEvents.some(event=>event.type==='disable'));
    assert.equal(JSON.stringify(finalEvents).includes(action.token),false); check('new enable/disable event types persist as bounded metadata without secrets');

    // Exact old v6 revocation behavior, including its committed audit, must not
    // let a paused manual grant regain access after the new version returns.
    const rollback = await createAIAccessGrant(a,{scope:'read'});
    await prisma.$transaction(async tx=>{
      await tx.$executeRaw\`UPDATE "AIAccessGrant" SET "revokedAt"=COALESCE("revokedAt",CURRENT_TIMESTAMP) WHERE "id"=\${rollback.grant.id}::uuid AND "userId"='admin-a'\`;
      await tx.$executeRaw\`INSERT INTO "AIAccessEvent" ("id","userId","grantId","type") VALUES (\${randomUUID()}::uuid,'admin-a',\${rollback.grant.id}::uuid,'revoke')\`;
    });
    assert.equal(await authorizeAIAccessToken(rollback.token,'read'),null);
    await denied(setAIAccessGrantEnabled(a,rollback.grant.id,true),409);
    await denied(setAIAccessGrantEnabled(a,rollback.grant.id,false),409);
    const rollbackView = (await listAIAccessGrants(a)).find(grant=>grant.id===rollback.grant.id)!;
    assert.equal(rollbackView.enabled,false); assert.ok(rollbackView.revokedAt); assert.equal(rollbackView.expiresAt,null);
    check('committed old-version permanent revocation cannot be mistaken for a resumable pause');

    for (let round=0;round<3;round++) {
      const raced = await createAIAccessGrant(a,{scope:'read'});
      let notifyLocked!:()=>void; let releaseOld!:()=>void;
      const locked = new Promise<void>(resolve=>{notifyLocked=resolve});
      const released = new Promise<void>(resolve=>{releaseOld=resolve});
      const oldRevoke = prisma.$transaction(async tx=>{
        await tx.$executeRaw\`UPDATE "AIAccessGrant" SET "revokedAt"=COALESCE("revokedAt",CURRENT_TIMESTAMP) WHERE "id"=\${raced.grant.id}::uuid AND "userId"='admin-a'\`;
        notifyLocked(); await released;
        await tx.$executeRaw\`INSERT INTO "AIAccessEvent" ("id","userId","grantId","type") VALUES (\${randomUUID()}::uuid,'admin-a',\${raced.grant.id}::uuid,'revoke')\`;
      });
      await Promise.race([locked,oldRevoke.then(()=>{throw new Error('old revoke must hold its transaction until released')})]);
      const newToggle = setAIAccessGrantEnabled(a,raced.grant.id,true).then(value=>({value,error:null}),error=>({value:null,error}));
      let observedWaiting=false;
      try {
        const deadline=Date.now()+1000;
        while (!observedWaiting && Date.now()<deadline) {
          const blockers = await prisma.$queryRaw<Array<{waiting:boolean}>>\`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%"manualControl" = TRUE FOR UPDATE%') AS waiting\`;
          observedWaiting=blockers[0].waiting;
        }
      } finally { releaseOld(); }
      await oldRevoke;
      const outcome = await newToggle;
      assert.equal(observedWaiting,true,'new toggle must really wait for the old revoke row lock');
      assert.equal((outcome.error as {status:number}|null)?.status,409,'fresh statement sees the newly committed revoke audit');
      assert.equal(await authorizeAIAccessToken(raced.token,'read'),null);
    }
    check('new toggle waits for concurrent old-version revoke and uses a fresh snapshot to reject reopening',{rounds:3});
  } finally {
    await writeFile(process.env.SANJIE_AI_SECURITY_RECEIPT!,JSON.stringify({checks}));
    await prisma.$disconnect();
  }
});
`);
  await command(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", path.join(temporaryDirectory, "vitest.config.mjs")], {
    env: { ...process.env, DATABASE_URL: `postgresql://ai_security_test@127.0.0.1:${port}/ai_access_test?connection_limit=10&pool_timeout=10`,
      SANJIE_AI_SECURITY_RECEIPT: path.join(temporaryDirectory, "receipt.json") }
  });
  report.checks = JSON.parse(await readFile(path.join(temporaryDirectory, "receipt.json"), "utf8")).checks;
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : "integration failed";
  try { report.checks = JSON.parse(await readFile(path.join(temporaryDirectory, "receipt.json"), "utf8")).checks; } catch {}
  process.exitCode = 1;
} finally {
  try {
    if (startAttempted) await command(path.join(binaries, "pg_ctl"), ["stop", "--pgdata", dataDirectory, "--mode=fast", "--wait", "--timeout=20"]);
    report.postgresStopped = true;
  } catch (error) {
    report.postgresStopped = false; report.passed = false;
    report.cleanupError = error instanceof Error ? error.message : "cleanup failed";
    process.exitCode = 1;
  }
  try { logs.push(`Own PostgreSQL log:\n${await readFile(path.join(temporaryDirectory, "postgres.log"), "utf8")}`); } catch {}
  report.finishedAt = new Date().toISOString();
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(path.join(evidenceDirectory, "ai-postgres-manual-control-test.log"), logs.join("\n\n"));
  await writeFile(path.join(evidenceDirectory, "ai-postgres-manual-control-test.json"), JSON.stringify(report, null, 2) + "\n");
  if (report.postgresStopped) await rm(temporaryDirectory, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
