import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const runFile = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function localDatabaseUrl() {
  const envText = await readFile(path.join(projectRoot, ".env"), "utf8").catch(() => "");
  const entry = envText.match(/^DATABASE_URL\s*=\s*(.*)$/m)?.[1]?.trim() || "";
  const value = process.env.DATABASE_URL || entry.replace(/^(["'])(.*)\1$/, "$2");
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("支付 UAT 仅允许本机 PostgreSQL；未创建测试库");
  }
  return url;
}

/** Creates a disposable namespace only. No existing schema or business rows are changed. Never print the returned URL. */
export async function createPaymentUatDatabase() {
  const baseUrl = await localDatabaseUrl();
  const schemaName = `payment_uat_${Date.now()}_${randomBytes(5).toString("hex")}`;
  const baseClient = new PrismaClient({ datasources: { db: { url: baseUrl.toString() } }, log: [] });
  const testUrl = new URL(baseUrl);
  testUrl.searchParams.set("schema", schemaName);
  let created = false;
  const cleanup = async () => {
    if (created) {
      await baseClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      created = false;
    }
    await baseClient.$disconnect();
  };
  try {
    await baseClient.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
    created = true;
    await runFile(path.join(projectRoot, "node_modules", ".bin", "prisma"), ["db", "push", "--skip-generate"], {
      cwd: projectRoot,
      env: { ...process.env, DATABASE_URL: testUrl.toString() },
      timeout: 60_000,
      maxBuffer: 1024 * 1024
    });
    return { schemaName, url: testUrl.toString(), cleanup };
  } catch {
    await cleanup();
    // Prisma subprocess logs may contain database URLs. Keep them out of UAT output.
    throw new Error("隔离支付 UAT 数据库建立失败，原有业务数据未修改");
  }
}
