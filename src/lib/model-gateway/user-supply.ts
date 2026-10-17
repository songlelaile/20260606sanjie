import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { resolveAiEncryptionKeySource } from "@/lib/ai-encryption-key";
import { getRelayRuntime } from "./relay-config";
import { getSub2ApiProvisioningView, provisionSub2ApiKey, Sub2ApiProvisionError } from "./sub2api-provisioner";

type Slot = "primary" | "backup";
const USER_SUPPLY_BASE_URL = "https://sub.shaozhuangai.com/v1";
type Stored = {
  id: string; userId: string; slot: Slot; name: string; sealedKey: string;
  status: "pending" | "provisioning" | "ready" | "failed";
  providerKeyId: string | null; providerOwnerId: string | null; providerGroupId: string | null;
  leaseToken: string | null; lastErrorCode: string; attempts: number;
};
export type UserSupplyCredentialView = { id: string; status: string; providerKeyId: string | null };
export type UserSupplyStatus = {
  userId: string; username: string; name: string; accountStatus: string;
  primary: UserSupplyCredentialView | null; backup: UserSupplyCredentialView | null;
};
export type UserSupplyRuntime = {
  baseUrl: string; primary: { id: string; apiKey: string };
  backup: { id: string; apiKey: string } | null; usdCnyRate: number | null;
};

export class UserSupplyError extends Error {
  constructor(message: string, readonly status = 503, readonly code = "USER_SUPPLY_UNAVAILABLE") {
    super(message); this.name = "UserSupplyError";
  }
}

function encryptionKey() {
  return createHash("sha256").update("sanjie:user-supply:v1\0").update(resolveAiEncryptionKeySource()).digest();
}
function aad(row: Pick<Stored, "id" | "userId" | "slot">) {
  return Buffer.from(JSON.stringify(["user-supply-v1", row.userId, row.id, row.slot]));
}
/** Authenticated encryption binds a secret to the immutable user and credential. */
export function sealUserSupplyKey(key: string, row: Pick<Stored, "id" | "userId" | "slot">) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(aad(row));
  const data = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}
function openKey(row: Stored) {
  try {
    const [version, iv, tag, ciphertext, extra] = row.sealedKey.split(".");
    if (version !== "v1" || !iv || !tag || !ciphertext || extra !== undefined) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
    decipher.setAAD(aad(row)); decipher.setAuthTag(Buffer.from(tag, "base64"));
    const key = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
    if (!/^sk-sj-[a-f0-9]{64}$/.test(key)) throw new Error();
    return key;
  } catch { throw new UserSupplyError("用户供应凭据无法读取，请管理员检查加密配置", 503, "USER_SUPPLY_DECRYPT_FAILED"); }
}
async function currentUser(userId: string, requireActive = true) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new UserSupplyError("用户标识无效", 400, "USER_SUPPLY_USER_INVALID");
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, status: true } });
  if (!user || (requireActive && user.status !== "active")) throw new UserSupplyError("账号不可用", 403, "USER_SUPPLY_USER_DISABLED");
  return user;
}
async function readRows(userId: string): Promise<Stored[]> {
  try { return await prisma.$queryRaw<Stored[]>`SELECT * FROM "GatewaySupplyCredential" WHERE "userId" = ${userId} ORDER BY CASE WHEN "slot" = 'primary' THEN 0 ELSE 1 END`; }
  catch { throw new UserSupplyError("用户主备供应配置尚未初始化", 503, "USER_SUPPLY_STORE_UNAVAILABLE"); }
}
function view(row: Stored | undefined): UserSupplyCredentialView | null {
  return row ? { id: row.id, status: row.status, providerKeyId: row.providerKeyId } : null;
}

const RATE_LIMIT_CODE = "supply_provisioning_rate_limited";
const COUNT_LIMIT_CODE = "supply_provisioning_key_count_exceeded";
function retryDelay(code: string, attempts: number): number {
  if (code === RATE_LIMIT_CODE) return 3600;
  if (code === COUNT_LIMIT_CODE) return 86400;
  return Math.min(1800, 60 * 2 ** Math.min(5, Math.max(0, attempts - 1)));
}
async function issuerCooldown(): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ lastErrorCode: string }>>`SELECT "lastErrorCode" FROM "GatewaySupplyCredential"
    WHERE "lastErrorCode" IN (${RATE_LIMIT_CODE}, ${COUNT_LIMIT_CODE}) AND "retryAfter" > CURRENT_TIMESTAMP
    ORDER BY "retryAfter" DESC LIMIT 1`;
  return rows[0]?.lastErrorCode || null;
}
async function assertIssuerAvailable() {
  const code = await issuerCooldown();
  if (code) throw new UserSupplyError("上游签发正在冷却，请等待创建窗口恢复或由管理员调整账号", 503, code);
}

/** A deliberate administrator configuration save can unblock repaired identity failures.
 * Creation-rate cooldown is kept: changing settings must not bypass upstream limits. */
export async function resetUserSupplyProvisioningFailures(): Promise<void> {
  await prisma.$executeRaw`UPDATE "GatewaySupplyCredential" SET "retryAfter" = NULL, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "status" = 'failed' AND "lastErrorCode" IN (
      'USER_SUPPLY_PROVISION_NOT_CONFIGURED', 'supply_provisioning_unconfigured', 'supply_provisioning_invalid_config',
      'supply_provisioning_auth_rejected', 'supply_provisioning_2fa_required', 'supply_provisioning_inactive_owner',
      'supply_provisioning_invalid_session', 'supply_provisioning_group_forbidden', 'supply_provisioning_key_count_exceeded')`;
}

/** Commit stable pending secrets before any provider call, so crash recovery never creates a new pair. */
export async function queueUserSupplyKeys(userId: string): Promise<void> {
  await currentUser(userId, false);
  try {
    await prisma.$transaction(async (tx) => {
      for (const slot of ["primary", "backup"] as const) {
        const id = randomUUID();
        const name = `sanjie-${createHash("sha256").update(userId).digest("hex").slice(0, 24)}-${slot}`;
        const sealedKey = sealUserSupplyKey(`sk-sj-${randomBytes(32).toString("hex")}`, { id, userId, slot });
        await tx.$executeRaw`INSERT INTO "GatewaySupplyCredential" ("id", "userId", "slot", "name", "sealedKey")
          VALUES (${id}, ${userId}, ${slot}, ${name}, ${sealedKey}) ON CONFLICT ("userId", "slot") DO NOTHING`;
      }
    });
  } catch (error) {
    if (error instanceof UserSupplyError) throw error;
    throw new UserSupplyError("用户主备供应配置保存失败", 503, "USER_SUPPLY_STORE_UNAVAILABLE");
  }
}

export async function ensureUserSupplyKeys(userId: string): Promise<void> {
  await currentUser(userId);
  await queueUserSupplyKeys(userId);
  let rows = await readRows(userId);
  if (rows.length === 2 && rows.every((row) => row.status === "ready")) return;
  if (!(await getSub2ApiProvisioningView()).configured) throw new UserSupplyError("用户主备 Key 配发服务尚未配置，请联系管理员", 503, "USER_SUPPLY_PROVISION_NOT_CONFIGURED");
  await assertIssuerAvailable();
  for (const row of rows) {
    if (row.status === "ready") continue;
    await assertIssuerAvailable();
    const leaseToken = randomUUID();
    const claimed = await prisma.$queryRaw<Stored[]>`UPDATE "GatewaySupplyCredential"
      SET "status" = 'provisioning', "leaseToken" = ${leaseToken}, "leaseUntil" = CURRENT_TIMESTAMP + INTERVAL '90 seconds',
        "attempts" = "attempts" + 1, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${row.id} AND "userId" = ${userId} AND "status" != 'ready'
        AND ("leaseUntil" IS NULL OR "leaseUntil" < CURRENT_TIMESTAMP)
        AND ("retryAfter" IS NULL OR "retryAfter" <= CURRENT_TIMESTAMP)
      RETURNING *`;
    if (!claimed.length) continue;
    let leaseOwned = true;
    let heartbeatTask: Promise<void> | null = null;
    const heartbeat = setInterval(() => {
      if (heartbeatTask) return;
      heartbeatTask = (async () => {
        const renewed = await prisma.$executeRaw`UPDATE "GatewaySupplyCredential"
          SET "leaseUntil" = CURRENT_TIMESTAMP + INTERVAL '90 seconds'
          WHERE "id" = ${row.id} AND "userId" = ${userId} AND "leaseToken" = ${leaseToken}
            AND "status" = 'provisioning' AND "leaseUntil" > CURRENT_TIMESTAMP`;
        if (renewed !== 1) leaseOwned = false;
      })().catch(() => { leaseOwned = false; }).finally(() => { heartbeatTask = null; });
    }, 30_000);
    try {
      const key = openKey(claimed[0]);
      const issued = await provisionSub2ApiKey({ name: row.name, customKey: key, idempotencyKey: `sanjie-supply-${row.id}` });
      const expected = Buffer.from(key), actual = Buffer.from(issued.key);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || !issued.id || !issued.ownerId || !issued.groupId) {
        throw new UserSupplyError("上游未确认当前用户供应 Key", 503, "USER_SUPPLY_PROVIDER_UNCONFIRMED");
      }
      if (heartbeatTask) await heartbeatTask;
      if (!leaseOwned) throw new UserSupplyError("当前配发租约已失效，请使用原任务恢复", 503, "USER_SUPPLY_LEASE_LOST");
      // A deleted/disabled account is never made ready while an issuance is in flight.
      await currentUser(userId);
      const committed = await prisma.$executeRaw`UPDATE "GatewaySupplyCredential" SET "status" = 'ready', "providerKeyId" = ${issued.id},
        "providerOwnerId" = ${issued.ownerId}, "providerGroupId" = ${issued.groupId}, "lastErrorCode" = '',
        "leaseUntil" = NULL, "leaseToken" = NULL, "retryAfter" = NULL, "readyAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${row.id} AND "userId" = ${userId} AND "leaseToken" = ${leaseToken}
          AND "status" = 'provisioning' AND "leaseUntil" > CURRENT_TIMESTAMP`;
      if (committed !== 1) throw new UserSupplyError("当前配发租约已失效，请使用原任务恢复", 503, "USER_SUPPLY_LEASE_LOST");
    } catch (error) {
      const rawCode = error instanceof Sub2ApiProvisionError || error instanceof UserSupplyError ? error.code : "USER_SUPPLY_PROVISION_FAILED";
      const code = /^[A-Za-z0-9_]{1,80}$/.test(rawCode) ? rawCode : "USER_SUPPLY_PROVISION_FAILED";
      const delay = retryDelay(code, claimed[0].attempts);
      // Raw provider text and both keys must never enter logs, metadata or admin responses.
      await prisma.$executeRaw`UPDATE "GatewaySupplyCredential" SET "status" = 'failed', "lastErrorCode" = ${code},
        "leaseUntil" = NULL, "leaseToken" = NULL, "retryAfter" = CURRENT_TIMESTAMP + ${delay} * INTERVAL '1 second', "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${row.id} AND "userId" = ${userId} AND "leaseToken" = ${leaseToken}`;
      throw new UserSupplyError("用户供应 Key 配发未完成，请稍后重试或联系管理员", 503, code);
    } finally { clearInterval(heartbeat); if (heartbeatTask) await heartbeatTask; }
  }
  rows = await readRows(userId);
  if (!rows.some((row) => row.status === "ready")) throw new UserSupplyError("用户供应 Key 正在配发，请稍后重试", 503, "USER_SUPPLY_PROVISION_PENDING");
}

export async function getUserSupplyRuntime(userId: string): Promise<UserSupplyRuntime> {
  await currentUser(userId);
  let rows = await readRows(userId);
  if (!rows.some((row) => row.status === "ready")) {
    try { await ensureUserSupplyKeys(userId); }
    catch (error) {
      rows = await readRows(userId);
      // The primary may have been confirmed before standby issuance hit a limit.
      if (!rows.some((row) => row.status === "ready")) throw error;
    }
    rows = await readRows(userId);
  }
  else if (rows.length !== 2 || rows.some((row) => row.status !== "ready")) {
    // Retry a missing standby without discarding the already working credential.
    if (!(await issuerCooldown())) await ensureUserSupplyKeys(userId).catch(() => undefined);
    rows = await readRows(userId);
  }
  const main = rows.find((row) => row.slot === "primary" && row.status === "ready");
  const standby = rows.find((row) => row.slot === "backup" && row.status === "ready");
  const primary = main || standby;
  if (!primary) throw new UserSupplyError("当前用户尚无可用供应 Key", 503, "USER_SUPPLY_NOT_CONFIGURED");
  const relay = await getRelayRuntime();
  return { baseUrl: USER_SUPPLY_BASE_URL, usdCnyRate: relay.usdCnyRate,
    primary: { id: primary.id, apiKey: openKey(primary) },
    backup: main && standby ? { id: standby.id, apiKey: openKey(standby) } : null };
}

export async function getUserSupplyCredential(userId: string, credentialId: string): Promise<{ baseUrl: string; apiKey: string }> {
  await currentUser(userId);
  const rows = await readRows(userId);
  const row = rows.find((entry) => entry.id === credentialId && entry.status === "ready");
  if (!row) throw new UserSupplyError("任务供应凭据不属于当前账号或已不可用", 403, "USER_SUPPLY_CREDENTIAL_MISMATCH");
  return { baseUrl: USER_SUPPLY_BASE_URL, apiKey: openKey(row) };
}

export async function listUserSupplyStatus(): Promise<UserSupplyStatus[]> {
  const users = await prisma.user.findMany({ select: { id: true, username: true, name: true, status: true }, orderBy: { createdAt: "asc" } });
  let rows: Stored[];
  try { rows = await prisma.$queryRaw<Stored[]>`SELECT * FROM "GatewaySupplyCredential"`; }
  catch { throw new UserSupplyError("用户主备供应配置尚未初始化", 503, "USER_SUPPLY_STORE_UNAVAILABLE"); }
  return users.map((user) => ({ userId: user.id, username: user.username, name: user.name, accountStatus: user.status,
    primary: view(rows.find((row) => row.userId === user.id && row.slot === "primary")),
    backup: view(rows.find((row) => row.userId === user.id && row.slot === "backup")) }));
}

export async function backfillUserSupplyKeys(limit = 10) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new UserSupplyError("每批最多处理 10 个账号", 400, "USER_SUPPLY_LIMIT_INVALID");
  const all = await listUserSupplyStatus();
  const missing = all.filter((user) => user.accountStatus === "active" && (user.primary?.status !== "ready" || user.backup?.status !== "ready"));
  const errors: Array<{ userId: string; code: string }> = [];
  let ready = 0;
  let processed = 0;
  const cooldown = await issuerCooldown();
  if (cooldown) return { processed: 0, ready: 0, failed: 0, remaining: missing.length, errors: [{ userId: "", code: cooldown }] };
  // Select due work before applying the batch limit. Failed users in backoff and
  // active leases cannot repeatedly consume the first ten positions. New work
  // and users with fewer attempts get priority over repeatedly failing accounts.
  const due = await prisma.$queryRaw<Array<{ id: string }>>`SELECT u."id" FROM "User" u
    LEFT JOIN "GatewaySupplyCredential" c ON c."userId" = u."id"
    WHERE u."status" = 'active'
    GROUP BY u."id", u."createdAt"
    HAVING COUNT(c."id") < 2 OR BOOL_OR(c."status" != 'ready'
      AND (c."leaseUntil" IS NULL OR c."leaseUntil" < CURRENT_TIMESTAMP)
      AND (c."retryAfter" IS NULL OR c."retryAfter" <= CURRENT_TIMESTAMP))
    ORDER BY COALESCE(MAX(c."attempts"), 0) ASC, COALESCE(MAX(c."updatedAt"), u."createdAt") ASC, u."createdAt" ASC, u."id" ASC
    LIMIT ${limit}`;
  for (const user of due) {
    processed++;
    try {
      await ensureUserSupplyKeys(user.id);
      const rows = await readRows(user.id);
      if (rows.length === 2 && rows.every((row) => row.status === "ready")) ready++;
      else errors.push({ userId: user.id, code: "USER_SUPPLY_PROVISION_PENDING" });
    } catch (error) {
      const code = error instanceof UserSupplyError ? error.code : "USER_SUPPLY_PROVISION_FAILED";
      errors.push({ userId: user.id, code });
      if (code === RATE_LIMIT_CODE || code === COUNT_LIMIT_CODE) break;
    }
  }
  return { processed, ready, failed: errors.length, remaining: Math.max(0, missing.length - ready), errors };
}

/** Registration is committed first; supplier outage never turns a created account into a failed registration. */
export async function provisionRegisteredUserSupply(username: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { username }, select: { id: true, status: true } });
  if (!user || user.status !== "active") return;
  await queueUserSupplyKeys(user.id);
  if ((await getSub2ApiProvisioningView()).configured) await ensureUserSupplyKeys(user.id);
}
