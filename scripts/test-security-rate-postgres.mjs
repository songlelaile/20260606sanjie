#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The database URL is constructed here. Never read a repository DATABASE_URL.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDirectory = path.join(root, ".codex-deploy/anti-clone-20261002");
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "sanjie-security-pg-"));
const dataDirectory = path.join(temporaryDirectory, "data");
const socketDirectory = path.join(temporaryDirectory, "socket");
const binaries = "/opt/homebrew/bin";
const logLines = [];
const report = { startedAt: new Date().toISOString(), scope: "temporary loopback PostgreSQL only", checks: [], passed: false, postgresStopped: false };
let started = false;
let workerId = 0;
let port;

async function command(executable, args, options = {}) {
  const startedAt = Date.now();
  const child = spawn(executable, args, { cwd: root, ...options, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
  const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(timer);
  logLines.push(`${path.basename(executable)} ${args.map(argument => argument.replaceAll(temporaryDirectory, "<temporary>" )).join(" ")}\n${output.trim()}\n${Date.now() - startedAt} ms / exit ${exitCode}`);
  if (exitCode !== 0) throw new Error(`${path.basename(executable)} failed with exit ${exitCode}`);
  return output;
}

async function psql(sql, database = "security_rate_test") {
  return command(path.join(binaries, "psql"), ["-X", "--host=127.0.0.1", `--port=${port}`, "--username=security_test", `--dbname=${database}`, "--set=ON_ERROR_STOP=1", "-At", "-c", sql]);
}

async function worker(specification) {
  const receiptPath = path.join(temporaryDirectory, `receipt-${++workerId}.json`);
  // Vitest transforms the actual TypeScript helper. The only replacement is the
  // Next build marker server-only; Prisma and SQL are never mocked.
  await command(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", path.join(temporaryDirectory, "vitest.config.mjs")], {
    env: {
      ...process.env,
      DATABASE_URL: `postgresql://security_test@127.0.0.1:${port}/security_rate_test?connection_limit=10&pool_timeout=10`,
      SANJIE_SECURITY_TEST_RECEIPT: receiptPath,
      SANJIE_SECURITY_TEST_SPEC: JSON.stringify(specification)
    }
  });
  return JSON.parse(await readFile(receiptPath, "utf8"));
}

function check(name, details) { report.checks.push({ name, passed: true, ...details }); }
const hash = (namespace, identity) => createHash("sha256").update(`${namespace}\0${identity}`).digest("hex");
const allowed = receipts => receipts.flatMap(receipt => receipt.results).filter(result => result.allowed).length;

async function waitForWorkers(barrierName, count) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const ready = (await readdir(temporaryDirectory)).filter(name => name.startsWith(`${barrierName}.ready.`));
    if (ready.length === count) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Worker synchronization timed out");
}

try {
  await mkdir(evidenceDirectory, { recursive: true });
  await mkdir(socketDirectory);
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  report.port = port;
  report.postgresVersion = (await command(path.join(binaries, "postgres"), ["--version"])).trim();
  await command(path.join(binaries, "initdb"), ["--pgdata", dataDirectory, "--username=security_test", "--auth=trust", "--no-locale", "--encoding=UTF8"]);
  started = true;
  await command(path.join(binaries, "pg_ctl"), ["start", "--pgdata", dataDirectory, "--log", path.join(temporaryDirectory, "postgres.log"), "--options", `-h 127.0.0.1 -p ${port} -k ${socketDirectory} -F`, "--wait", "--timeout=20"]);
  await psql('CREATE DATABASE security_rate_test;', "postgres");
  const migration = await readFile(path.join(root, "prisma/migrations/20261002143000_security_rate_bucket/migration.sql"), "utf8");
  await psql(migration);
  check("isolated migration applied", { database: "security_rate_test", migrationSha256: createHash("sha256").update(migration).digest("hex") });

  await writeFile(path.join(temporaryDirectory, "empty.mjs"), "export {};\n");
  await writeFile(path.join(temporaryDirectory, "vitest.config.mjs"), `export default { root: ${JSON.stringify(temporaryDirectory)}, test: { environment: 'node', include: ['worker.test.ts'], testTimeout: 30000 }, resolve: { alias: { '@': ${JSON.stringify(path.join(root, "src"))}, 'server-only': ${JSON.stringify(path.join(temporaryDirectory, "empty.mjs"))} } } };\n`);
  await writeFile(path.join(temporaryDirectory, "worker.test.ts"), `
import { test, expect } from ${JSON.stringify(path.join(root, "node_modules/vitest/dist/index.js"))};
import { access, writeFile } from 'node:fs/promises';
import { consumeSecurityRateLimit } from ${JSON.stringify(path.join(root, "src/lib/security-rate-limit.ts"))};
import { prisma } from ${JSON.stringify(path.join(root, "src/lib/db.ts"))};
test('uses the actual helper and isolated PostgreSQL', async () => {
  const spec = JSON.parse(process.env.SANJIE_SECURITY_TEST_SPEC!);
  const target = new URL(process.env.DATABASE_URL!);
  expect(target.hostname).toBe('127.0.0.1');
  expect(target.username).toBe('security_test');
  expect(target.pathname).toBe('/security_rate_test');
  expect(target.port).not.toBe('');
  try {
    if (spec.barrier) {
      await prisma.$connect();
      await writeFile(spec.barrier + '.ready.' + process.pid, 'ready');
      const deadline = Date.now() + 20000;
      while (true) {
        try { await access(spec.barrier); break; } catch {}
        if (Date.now() >= deadline) throw new Error('Worker synchronization timed out');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    const results = await Promise.all(Array.from({ length: spec.count }, () =>
      consumeSecurityRateLimit(spec.namespace, spec.identity, spec.limit, spec.windowSeconds, spec.now)));
    expect(results.some(result => result.reason === 'unavailable')).toBe(false);
    await writeFile(process.env.SANJIE_SECURITY_TEST_RECEIPT!, JSON.stringify({ pid: process.pid, results }));
  } finally { await prisma.$disconnect(); }
});
`);

  const now = Math.floor(Date.now() / 60_000) * 60_000 + 1_000;
  const baseline = { namespace: "integration.parallel", identity: "fixture-user-203.0.113.9-token", count: 30, limit: 7, windowSeconds: 60, now };
  const single = await worker(baseline);
  assert.equal(allowed([single]), 7);
  const storedHits = Number((await psql(`SELECT "hits" FROM "SecurityRateBucket" WHERE "bucketKey"='${hash(baseline.namespace, baseline.identity)}';`)).trim());
  assert.equal(storedHits, 30);
  check("30 simultaneous requests admit exactly 7", { requests: 30, allowed: 7, denied: 23, storedHits });

  const independent = await worker({ ...baseline, identity: "other-user-198.51.100.2", count: 1 });
  assert.equal(allowed([independent]), 1);
  check("different identities are isolated");

  const persisted = await worker({ ...baseline, count: 1 });
  assert.equal(allowed([persisted]), 0);
  assert.equal(persisted.results[0].reason, "rate_limited");
  assert.notEqual(persisted.pid, single.pid);
  check("a fresh worker and Prisma instance retain the previous counter", { firstPid: single.pid, secondPid: persisted.pid });

  // Race the cleanup CTE itself across three real processes, with old rows
  // present. Repeat to expose deadlocks or lost increments instead of relying
  // on one lucky execution.
  for (let round = 1; round <= 3; round++) {
    await psql(`INSERT INTO "SecurityRateBucket" ("bucketKey", "windowStart", "expiresAt", "hits") SELECT md5('round${round}-' || number::text) || md5('round${round}-' || number::text), to_timestamp(${now - 120_000} / 1000.0), to_timestamp(${now - 60_000} / 1000.0), 1 FROM generate_series(1, 1000) AS number;`);
    const barrierName = `barrier-${round}`;
    const barrier = path.join(temporaryDirectory, barrierName);
    const specification = { ...baseline, namespace: `integration.workers.${round}`, count: 10, barrier };
    const receiptPromise = Promise.all(Array.from({ length: 3 }, () => worker(specification)));
    // All three processes establish a real database connection before one
    // shared release file starts their thirty requests together.
    await Promise.race([receiptPromise, waitForWorkers(barrierName, 3)]);
    await writeFile(barrier, "start");
    const receipts = await receiptPromise;
    assert.equal(new Set(receipts.map(receipt => receipt.pid)).size, 3);
    assert.equal(allowed(receipts), 7);
    const count = Number((await psql(`SELECT "hits" FROM "SecurityRateBucket" WHERE "bucketKey"='${hash(specification.namespace, specification.identity)}';`)).trim());
    assert.equal(count, 30);
    const expired = Number((await psql(`SELECT count(*) FROM "SecurityRateBucket" WHERE "expiresAt" <= to_timestamp(${now} / 1000.0);`)).trim());
    assert.equal(expired, 0);
    check(`3-process concurrent cleanup round ${round}`, { processes: 3, requests: 30, allowed: 7, storedHits: count, expiredRemaining: expired });
  }

  const recovered = await worker({ ...baseline, count: 1, now: now + 60_000 });
  assert.equal(allowed([recovered]), 1);
  const expiredRemaining = Number((await psql(`SELECT count(*) FROM "SecurityRateBucket" WHERE "expiresAt" <= to_timestamp(${now + 60_000} / 1000.0);`)).trim());
  assert.equal(expiredRemaining, 0);
  check("fixed window recovers and expires prior counters", { allowed: 1, expiredRemaining });

  const rows = (await psql('SELECT row_to_json(bucket) FROM "SecurityRateBucket" AS bucket;')).trim();
  for (const fixture of [baseline.identity, "203.0.113.9", "other-user-198.51.100.2", "198.51.100.2", "integration.parallel"]) assert.ok(!rows.includes(fixture));
  const columns = (await psql("SELECT column_name FROM information_schema.columns WHERE table_name='SecurityRateBucket' ORDER BY ordinal_position;")).trim().split("\n");
  assert.deepEqual(columns, ["bucketKey", "windowStart", "expiresAt", "hits"]);
  check("table has no plaintext identity, IP, username, token or namespace", { columns });
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : "integration failed";
  process.exitCode = 1;
} finally {
  // Always address the exact data directory created here. Never stop a shared
  // local PostgreSQL installation or use environment-provided connection URLs.
  try {
    if (started) await command(path.join(binaries, "pg_ctl"), ["stop", "--pgdata", dataDirectory, "--mode=fast", "--wait", "--timeout=20"]);
    report.postgresStopped = true;
  } catch (error) {
    report.postgresStopped = false;
    report.cleanupError = error instanceof Error ? error.message : "cleanup failed";
    report.passed = false;
    process.exitCode = 1;
  }
  try { logLines.push(`PostgreSQL own-instance log:\n${await readFile(path.join(temporaryDirectory, "postgres.log"), "utf8")}`); } catch {}
  report.finishedAt = new Date().toISOString();
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(path.join(evidenceDirectory, "postgres-test.log"), logLines.join("\n\n"));
  await writeFile(path.join(evidenceDirectory, "postgres-test.json"), JSON.stringify(report, null, 2) + "\n");
  if (report.postgresStopped) await rm(temporaryDirectory, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
