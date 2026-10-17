#!/usr/bin/env node
// Independent, temporary loopback Postgres. Never reads the business DATABASE_URL.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(tmpdir(), "sanjie-user-supply-pg-"));
const data = path.join(temporary, "data"), socket = path.join(temporary, "socket");
const evidence = path.join(root, "docs/uat-user-supply-20261004");
const binaries = "/opt/homebrew/bin";
let started = false;
const report = { startedAt: new Date().toISOString(), isolatedPostgres: true, mockProvider: true, passed: false, stopped: false };
async function run(executable, args, options = {}) {
  const child = spawn(executable, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], ...options });
  let output = "";
  child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
  const timer = setTimeout(() => child.kill("SIGTERM"), 60000);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${path.basename(executable)} failed: ${output.slice(-2000)}`);
  return output;
}
const port = await new Promise((resolve, reject) => {
  const server = createServer(); server.on("error", reject);
  server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => resolve(address.port)); });
});
async function psql(sql) {
  return run(path.join(binaries, "psql"), ["-X", "--host=127.0.0.1", `--port=${port}`, "--username=user_supply_test", "--dbname=postgres", "--set=ON_ERROR_STOP=1", "-At", "-c", sql]);
}
try {
  await mkdir(socket);
  await run(path.join(binaries, "initdb"), ["--pgdata", data, "--username=user_supply_test", "--auth=trust", "--no-locale", "--encoding=UTF8"]);
  await run(path.join(binaries, "pg_ctl"), ["start", "--pgdata", data, "--log", path.join(temporary, "postgres.log"), "--options", `-h 127.0.0.1 -p ${port} -k ${socket} -F`, "--wait", "--timeout=20"]);
  started = true;
  await psql('CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "username" TEXT UNIQUE NOT NULL, "name" TEXT NOT NULL, "status" TEXT NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);');
  await psql('CREATE TABLE "GatewayBillingHold" ("id" TEXT PRIMARY KEY); CREATE TABLE "GatewayNativeVideoJob" ("id" TEXT PRIMARY KEY);');
  const migration = await readFile(path.join(root, "prisma/migrations/20261004160000_user_supply_credentials/migration.sql"), "utf8");
  await psql(migration); await psql(migration);
  await psql(`INSERT INTO "User" ("id","username","name","status") VALUES ('user-a','same-shop-a','同名店铺','active'), ('user-b','same-shop-b','同名店铺','active'), ('user-c','crash-recovery','待重试','active'), ('user-disabled','disabled','停用用户','disabled'), ('user-oldfailed','old-failure','旧失败账号','active'), ('user-fresh','fresh-work','新任务','active');`);
  await writeFile(path.join(temporary, "empty.mjs"), "export {};\n");
  await writeFile(path.join(temporary, "vitest.config.mjs"), `export default { root:${JSON.stringify(temporary)},test:{environment:'node',include:['worker.test.ts'],testTimeout:30000},resolve:{alias:{'vitest':${JSON.stringify(path.join(root,'node_modules/vitest/dist/index.js'))},'@':${JSON.stringify(path.join(root,"src"))},'server-only':${JSON.stringify(path.join(temporary,"empty.mjs"))}}}};`);
  await writeFile(path.join(temporary, "worker.test.ts"), `
import { test, expect, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
const calls = vi.hoisted(() => ({ issued: new Map(), failNext: false }));
vi.mock(${JSON.stringify(path.join(root, "src/lib/model-gateway/sub2api-provisioner.ts"))}, () => ({
  getSub2ApiProvisioningView: async()=>({configured:true,missing:[]}),
  Sub2ApiProvisionError: class extends Error { code='SUB2API_UNAVAILABLE'; },
  provisionSub2ApiKey: async(input)=>{
    const before=calls.issued.get(input.name);
    expect(before?.key || input.customKey).toBe(input.customKey);
    const result=before || {id:'provider-'+calls.issued.size,key:input.customKey,ownerId:'service-account',groupId:'7'};
    calls.issued.set(input.name,result);
    await new Promise(resolve=>setTimeout(resolve,20));
    if(calls.failNext){calls.failNext=false;throw new Error('simulated response lost after provider accepted');}
    return result;
  }
}));
vi.mock(${JSON.stringify(path.join(root, "src/lib/model-gateway/relay-config.ts"))},()=>({getRelayRuntime:async()=>({baseUrl:'https://unrelated.example/v1',apiKey:'must-never-fallback',usdCnyRate:7})}));
import { prisma } from ${JSON.stringify(path.join(root, "src/lib/db.ts"))};
import { queueUserSupplyKeys,ensureUserSupplyKeys,getUserSupplyRuntime,getUserSupplyCredential,listUserSupplyStatus,backfillUserSupplyKeys } from ${JSON.stringify(path.join(root, "src/lib/model-gateway/user-supply.ts"))};
test('real SQL concurrency, durable recovery, ownership, encryption and no global fallback',async()=>{
  const target=new URL(process.env.DATABASE_URL!);expect(target.hostname).toBe('127.0.0.1');expect(target.username).toBe('user_supply_test');
  try {
    await Promise.all(Array.from({length:12},()=>queueUserSupplyKeys('user-a')));
    const queued=await prisma.$queryRawUnsafe('SELECT * FROM "GatewaySupplyCredential" WHERE "userId"=$1','user-a');
    expect(queued).toHaveLength(2);expect(calls.issued.size).toBe(0);
    expect(queued.every(row=>row.status==='pending')).toBe(true);
    await Promise.allSettled(Array.from({length:8},()=>ensureUserSupplyKeys('user-a')));
    const a=await getUserSupplyRuntime('user-a');expect(calls.issued.size).toBe(2);
    expect(a.backup).not.toBeNull();expect(a.primary.apiKey).not.toBe(a.backup!.apiKey);
    expect(a.baseUrl).toBe('https://sub.shaozhuangai.com/v1');expect(a.primary.apiKey).not.toBe('must-never-fallback');
    await prisma.$executeRawUnsafe('UPDATE "User" SET "username"=$1 WHERE "id"=$2','renamed-user','user-a');
    expect((await getUserSupplyRuntime('user-a')).primary).toEqual(a.primary);
    await ensureUserSupplyKeys('user-b');const b=await getUserSupplyRuntime('user-b');expect(b.primary.apiKey).not.toBe(a.primary.apiKey);
    await expect(getUserSupplyCredential('user-b',a.primary.id)).rejects.toMatchObject({status:403,code:'USER_SUPPLY_CREDENTIAL_MISMATCH'});
    const readyRows=await prisma.$queryRawUnsafe('SELECT * FROM "GatewaySupplyCredential" WHERE "userId"=$1','user-a');
    expect(JSON.stringify(readyRows)).not.toContain(a.primary.apiKey);expect(JSON.stringify(readyRows)).not.toContain(a.backup!.apiKey);
    const primary=readyRows.find(row=>row.slot==='primary');const backup=readyRows.find(row=>row.slot==='backup');
    await prisma.$executeRawUnsafe('UPDATE "GatewaySupplyCredential" SET "sealedKey"=$1 WHERE "id"=$2',backup.sealedKey,primary.id);
    await expect(getUserSupplyRuntime('user-a')).rejects.toMatchObject({code:'USER_SUPPLY_DECRYPT_FAILED'});
    await prisma.$executeRawUnsafe('UPDATE "GatewaySupplyCredential" SET "sealedKey"=$1 WHERE "id"=$2',primary.sealedKey,primary.id);
    calls.failNext=true;await expect(ensureUserSupplyKeys('user-c')).rejects.toMatchObject({status:503});
    const issuedAfterCrash=calls.issued.size;
    await prisma.$executeRawUnsafe('UPDATE "GatewaySupplyCredential" SET "retryAfter"=NULL WHERE "userId"=$1','user-c');
    await ensureUserSupplyKeys('user-c');expect(calls.issued.size).toBe(issuedAfterCrash+1);
    await expect(ensureUserSupplyKeys('user-disabled')).rejects.toMatchObject({status:403});
    await queueUserSupplyKeys('user-oldfailed');
    await prisma.$executeRawUnsafe('UPDATE "GatewaySupplyCredential" SET "status"=$1,"attempts"=4,"retryAfter"=CURRENT_TIMESTAMP + 3600 * INTERVAL $$1 second$$ WHERE "userId"=$2','failed','user-oldfailed');
    const batch=await backfillUserSupplyKeys(1);expect(batch).toMatchObject({processed:1,ready:1,failed:0,remaining:1});
    expect((await getUserSupplyRuntime('user-fresh')).backup).not.toBeNull();
    const statuses=await listUserSupplyStatus();expect(JSON.stringify(statuses)).not.toContain('sealedKey');expect(JSON.stringify(statuses)).not.toContain(a.primary.apiKey);
    await writeFile(process.env.SANJIE_SUPPLY_TEST_RECEIPT!,JSON.stringify({checks:12,queuedSlots:2,concurrentWorkers:8,issuedKeys:calls.issued.size,providerCallsAreMock:true,passed:true}));
  } finally {await prisma.$disconnect();}
});
`);
  const output = await run(process.execPath, [path.join(root,"node_modules/vitest/vitest.mjs"), "run", "--config", path.join(temporary,"vitest.config.mjs")], { env: {
    ...process.env, DATABASE_URL:`postgresql://user_supply_test@127.0.0.1:${port}/postgres?connection_limit=12&pool_timeout=10`,
    AI_API_ENCRYPTION_KEY:"test-only-independent-encryption-material-20261004", NODE_ENV:"test", SANJIE_SUPPLY_TEST_RECEIPT:path.join(temporary,"receipt.json")
  }});
  Object.assign(report, JSON.parse(await readFile(path.join(temporary,"receipt.json"),"utf8")));
  await mkdir(evidence,{recursive:true});await writeFile(path.join(evidence,"postgres-tests.log"),output);
  assert.equal(report.passed,true);
} catch(error) {report.error=error.message;throw error;}
finally {
  if(started) {try {await run(path.join(binaries,"pg_ctl"),["stop","--pgdata",data,"--mode=immediate","--wait","--timeout=20"]);report.stopped=true;}catch{report.stopped=false;}}
  await mkdir(evidence,{recursive:true});await writeFile(path.join(evidence,"postgres-acceptance.json"),JSON.stringify(report,null,2)+"\n");
  if(report.stopped || !started) await rm(temporary,{recursive:true,force:true});
  console.log(JSON.stringify(report));
}
