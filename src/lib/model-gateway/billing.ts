import { validateNativeChargeEvidence } from "./native-credit-coverage";
import { validateGatewayLocalChargeEvidence } from "./local-pricing";
import "server-only";
import { Prisma, type GatewayWallet } from "@prisma/client";
import { prisma } from "@/lib/db";
import { GATEWAY_PLANS } from "@/lib/model-gateway/catalog";
import { lockGatewayAccountingIdentities, lockGatewayAccountingPool } from "./accounting-coordination";
import {
  applyGatewayBillingCost, centsToPoints, GATEWAY_DEFAULT_MULTIPLIER_BPS,
  GatewayBillingError,
  type GatewayBillingSnapshot, type GatewayBillingRuleView, type GatewayBillingRuleAuditView,
  type UpdateGatewayBillingRuleInput, type GatewayBillingQuery, type GatewayBillingLedgerQuery,
  type GatewayBillingAccountView
} from "@/lib/model-gateway/billing-contract";

export { GatewayBillingError, applyGatewayBillingCost, centsToPoints } from "@/lib/model-gateway/billing-contract";
export type { GatewayBillingSnapshot } from "@/lib/model-gateway/billing-contract";

const PLANS = [{ code: "free", name: "体验版" }, ...GATEWAY_PLANS];
type BillingClient = Pick<Prisma.TransactionClient, "user" | "gatewayWallet" | "gatewayBillingRule" | "gatewayBillingLedger">;
type BillingIdentity = { id: string; tenantId: string; username: string; name: string; tenant?: { name: string } };

function ruleView(rule: { planCode: string; planName: string; multiplierBps: number; version: number; updatedAt: Date; updatedBy: string | null }): GatewayBillingRuleView {
  return { ...rule, updatedAt: rule.updatedAt.toISOString() };
}

function auditView(audit: Omit<GatewayBillingRuleAuditView, "createdAt"> & { createdAt: Date }): GatewayBillingRuleAuditView {
  return { ...audit, createdAt: audit.createdAt.toISOString() };
}

export async function getGatewayBillingSnapshot(userId: string, client: BillingClient = prisma): Promise<GatewayBillingSnapshot> {
  const user = await client.user.findUnique({ where: { id: userId }, include: { gatewayWallet: true, tenant: { select: { name: true } } } });
  if (!user || user.status !== "active") throw new GatewayBillingError("ACCOUNT_UNAVAILABLE", "账号不存在或已停用", 401);
  const planCode = user.gatewayWallet?.planCode || "free";
  const planName = user.gatewayWallet?.planName || "体验版";
  const rule = await client.gatewayBillingRule.findUnique({ where: { planCode } });
  return {
    userId: user.id, tenantId: user.tenantId, tenantName: user.tenant.name, username: user.username, userName: user.name,
    planCode, planName, multiplierBps: rule?.multiplierBps ?? GATEWAY_DEFAULT_MULTIPLIER_BPS,
    ruleVersion: rule?.version ?? 0, quotedAt: new Date().toISOString()
  };
}

export async function getGatewayBillingRules() {
  const [saved, audits] = await Promise.all([
    prisma.gatewayBillingRule.findMany({ orderBy: { planCode: "asc" } }),
    prisma.gatewayBillingRuleAudit.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100 })
  ]);
  const rules: GatewayBillingRuleView[] = PLANS.map((plan) => {
    const rule = saved.find((row) => row.planCode === plan.code);
    return rule ? ruleView(rule) : {
      planCode: plan.code, planName: plan.name, multiplierBps: GATEWAY_DEFAULT_MULTIPLIER_BPS,
      version: 0, updatedAt: null, updatedBy: null
    };
  });
  for (const rule of saved) if (!rules.some((row) => row.planCode === rule.planCode)) rules.push(ruleView(rule));
  return { rules, audits: audits.map(auditView) };
}

export async function updateGatewayBillingRule(adminId: string, input: UpdateGatewayBillingRuleInput) {
  if (!input || typeof input !== "object") throw new GatewayBillingError("INVALID_RULE", "请提交套餐扣费设置");
  const plan = PLANS.find((row) => row.code === input.planCode);
  if (!plan) throw new GatewayBillingError("INVALID_PLAN", "套餐不存在");
  applyGatewayBillingCost(0, { multiplierBps: input.multiplierBps });
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 2 || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw new GatewayBillingError("INVALID_REASON", "调整理由需要 2 至 500 个字符");
  }
  if (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 0) {
    throw new GatewayBillingError("INVALID_VERSION", "请提交当前规则版本后再保存");
  }
  return prisma.$transaction(async (tx) => {
    await lockGatewayAccountingIdentities(tx, [adminId]);
    const admin = await tx.user.findUnique({ where: { id: adminId } });
    if (!admin || admin.authRole !== "admin" || admin.status !== "active") {
      throw new GatewayBillingError("ADMIN_REQUIRED", "仅有效管理员可调整扣费规则", 403);
    }
    const pool = await lockGatewayAccountingPool(tx);
    if (pool?.accountingVersion === 1 && pool.status === "ready") {
      throw new GatewayBillingError("POOL_PRICING_LOCKED", "总池定价已冻结，调整前须重新核验来源与定价", 409);
    }
    await tx.gatewayBillingRule.upsert({
      where: { planCode: plan.code }, update: {},
      create: { planCode: plan.code, planName: plan.name, multiplierBps: GATEWAY_DEFAULT_MULTIPLIER_BPS, version: 0 }
    });
    await tx.$queryRaw`SELECT "planCode" FROM "GatewayBillingRule" WHERE "planCode" = ${plan.code} FOR UPDATE`;
    const previous = await tx.gatewayBillingRule.findUniqueOrThrow({ where: { planCode: plan.code } });
    if (previous.version !== input.expectedVersion) {
      throw new GatewayBillingError("RULE_VERSION_CONFLICT", "规则已被其他管理员修改，请刷新后再保存", 409);
    }
    if (previous.multiplierBps === input.multiplierBps) return { rule: ruleView(previous), audit: null };
    const rule = await tx.gatewayBillingRule.update({
      where: { planCode: plan.code },
      data: { multiplierBps: input.multiplierBps, version: { increment: 1 }, updatedBy: admin.id, planName: plan.name }
    });
    const audit = await tx.gatewayBillingRuleAudit.create({ data: {
      planCode: plan.code, planName: plan.name, previousMultiplierBps: previous.multiplierBps,
      multiplierBps: rule.multiplierBps, previousVersion: previous.version, version: rule.version,
      updatedBy: admin.id, updatedByUsername: admin.username, updatedByName: admin.name, reason
    } });
    return { rule: ruleView(rule), audit: auditView(audit) };
  });
}

/** Serializes all new financial events for a user, including their balance snapshots. */
export async function lockGatewayBillingWallet(tx: Prisma.TransactionClient, userId: string) {
  await lockGatewayAccountingIdentities(tx, [userId]);
  await lockGatewayAccountingPool(tx);
  await tx.gatewayWallet.upsert({
    where: { userId }, update: {},
    create: { userId, balanceCents: 0, monthlyQuotaCents: 0, planCode: "free", planName: "体验版", periodStart: new Date(), periodEnd: new Date() }
  });
  await tx.$queryRaw`SELECT "userId" FROM "GatewayWallet" WHERE "userId" = ${userId} FOR UPDATE`;
  return tx.gatewayWallet.findUniqueOrThrow({ where: { userId } });
}

/** Establishes a baseline only; never adjusts or rounds the actual wallet balance. */
export async function ensureGatewayBillingOpening(tx: Prisma.TransactionClient, user: BillingIdentity, wallet: GatewayWallet) {
  const event = `opening:${user.id}`;
  if (await tx.gatewayBillingLedger.findUnique({ where: { billingEventId: event } })) return;
  await tx.gatewayBillingLedger.create({ data: {
    billingEventId: event, kind: "opening", userId: user.id, tenantId: user.tenantId, tenantName: user.tenant?.name || "", username: user.username, userName: user.name,
    planCode: wallet.planCode, planName: wallet.planName, deltaCents: wallet.balanceCents,
    balanceBeforeCents: 0, balanceAfterCents: wallet.balanceCents, status: "ok",
    reason: "账本启用时的历史钱包余额；不重算历史调用"
  } });
}

const SAFE_METADATA_KEYS = new Set(["upstreamModel", "baseUrl", "credentialId", "size", "quality", "billing", "seconds", "imageAdapter", "mode", "scene", "requestedSize", "effectiveSize", "source", "resolution", "outcome", "responseFormat", "requestedImageCount", "inputImageCount", "tokenSource", "reportedTokenFields", "costSource", "usdCost", "usdCostLexical", "upstreamCostField", "localChargeEvidence", "nativeChargeEvidence", "nativeVideoJobId", "priceVersion", "usdCnyRate", "fxSource", "fxQuoteId", "fxReferenceDate", "fxFetchedAt"]);
export function safeGatewayBillingMetadata(value: unknown): Prisma.InputJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const safe: Record<string, Prisma.InputJsonValue | null> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;
    if (key === "nativeChargeEvidence") { try { safe[key] = {...validateNativeChargeEvidence(raw)}; } catch { /* Rejected by native coverage guard. */ } continue; }
    if ((key === "nativeVideoJobId" || key === "priceVersion") && (typeof raw !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(raw))) continue;
    if (key === "localChargeEvidence") { try { safe[key] = {...validateGatewayLocalChargeEvidence(raw)}; } catch { /* Invalid evidence is omitted and rejected by source guard. */ } continue; }
    if (key === "credentialId" && (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(raw))) continue;
    if ((key === "requestedImageCount" || key === "inputImageCount") && (!Number.isSafeInteger(raw) || Number(raw) < 0 || Number(raw) > 10_000)) continue;
    if (key === "tokenSource" && !["reported", "estimated", "unreported", "partial"].includes(String(raw))) continue;
    if (key === "costSource" && !["catalog", "upstream_usd"].includes(String(raw))) continue;
    if (key === "upstreamCostField" && !["usage.actual_cost","actual_cost"].includes(String(raw))) continue;
    if ((key === "usdCost" || key === "usdCostLexical" || key === "usdCnyRate") && (typeof raw !== "string" || !/^\d{1,7}(\.\d{1,8})?$/.test(raw))) continue;
    if (key === "fxSource" && !["ecb", "manual"].includes(String(raw))) continue;
    if (key === "fxQuoteId" && (typeof raw !== "string" || !/^[a-f0-9]{64}$/.test(raw))) continue;
    if (key === "fxReferenceDate" && (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw + "T00:00:00.000Z")) || new Date(raw + "T00:00:00.000Z").toISOString().slice(0, 10) !== raw)) continue;
    if (key === "fxFetchedAt" && (typeof raw !== "string" || !Number.isFinite(Date.parse(raw)) || new Date(raw).toISOString() !== raw)) continue;
    if (key === "reportedTokenFields" && (typeof raw !== "string" || !["", "prompt", "completion", "total", "prompt,completion", "prompt,total", "completion,total", "prompt,completion,total"].includes(raw))) continue;
    if (typeof raw === "number" && Number.isFinite(raw) || typeof raw === "boolean" || raw === null) { safe[key] = raw; continue; }
    if (typeof raw !== "string") continue;
    if (key === "baseUrl") {
      try {
        const url = new URL(raw);
        if (url.username || url.password || !["https:", "http:"].includes(url.protocol)) continue;
        const clean = `${url.origin}${url.pathname}`;
        if (/sk-[A-Za-z0-9_-]+|bearer\s|api[-_]?key|authorization|password/i.test(clean)) continue;
        safe[key] = clean.slice(0, 500);
      } catch { /* Invalid URLs never reach the audit trail. */ }
    } else {
      if (/sk-[A-Za-z0-9_-]+|bearer\s|api[-_]?key|authorization|password/i.test(raw)) continue;
      safe[key] = raw.slice(0, 500).replace(/[\u0000-\u001f\u007f]/g, "");
    }
  }
  return safe;
}

export function safeGatewayBillingError(error: unknown) {
  if (typeof error !== "string" || !error) return "";
  return /^[A-Za-z0-9_.:-]{1,100}$/.test(error) && !/sk-|bearer|api.?key|password/i.test(error) ? error : "upstream_error";
}

function pagination(query: GatewayBillingQuery) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 25;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new GatewayBillingError("INVALID_QUERY", "分页参数无效");
  }
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function queryDate(value: string | undefined) {
  if (!value) return undefined;
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new GatewayBillingError("INVALID_QUERY", "日期筛选无效");
  return result;
}

// Only the exact migration-created opening cohort used the server's Asia/Shanghai
// wall clock. Preserve every stored ledger row and derive its UTC display/read time.
const FOUNDATION_MIGRATION = "20261002120000_gateway_billing_ledger";
const FOUNDATION_CHECKSUM = "44c6867ce5ca19a6e7aeac537ca4317b2039a14b09031d7cbdc7609827d8a2b7";
type LedgerReadClient = Pick<Prisma.TransactionClient, "$queryRaw">;
type LedgerReadRow = Prisma.GatewayBillingLedgerGetPayload<Record<string, never>> & { effectiveCreatedAt: Date };

export async function listGatewayBillingLedger(query: GatewayBillingLedgerQuery = {}, client: LedgerReadClient = prisma) {
  const { page, pageSize, skip } = pagination(query);
  const from = queryDate(query.from), to = queryDate(query.to);
  if (from && to && from > to) throw new GatewayBillingError("INVALID_QUERY", "开始日期不能晚于结束日期");
  if (query.kind && !["opening", "recharge", "gift", "debit", "error", "generation_charge", "generation_refund", "usage"].includes(query.kind)) throw new GatewayBillingError("INVALID_QUERY", "账本类型无效");
  const search = query.search?.trim().slice(0, 200);
  const filters: Prisma.Sql[] = [];
  if (query.tenantId) filters.push(Prisma.sql`"tenantId" = ${query.tenantId}`);
  if (query.userId) filters.push(Prisma.sql`"userId" = ${query.userId}`);
  if (query.planCode) filters.push(Prisma.sql`"planCode" = ${query.planCode}`);
  if (query.kind) filters.push(Prisma.sql`"kind" = ${query.kind}`);
  if (query.excludeSupplierUsage) filters.push(Prisma.sql`"kind" <> 'usage'`);
  if (query.model) filters.push(Prisma.sql`"model" = ${query.model}`);
  if (query.endpoint) filters.push(Prisma.sql`"endpoint" = ${query.endpoint}`);
  // Bind an ISO instant and cast explicitly: a raw Date-to-timestamp cast would
  // otherwise depend on the database session's TimeZone.
  if (from) filters.push(Prisma.sql`"effectiveCreatedAt" >= (CAST(${from.toISOString()} AS TIMESTAMPTZ) AT TIME ZONE 'UTC')`);
  if (to) filters.push(Prisma.sql`"effectiveCreatedAt" <= (CAST(${to.toISOString()} AS TIMESTAMPTZ) AT TIME ZONE 'UTC')`);
  if (search) {
    const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    filters.push(Prisma.sql`("username" ILIKE ${pattern} ESCAPE '\\' OR "userName" ILIKE ${pattern} ESCAPE '\\' OR "tenantId" ILIKE ${pattern} ESCAPE '\\' OR "tenantName" ILIKE ${pattern} ESCAPE '\\' OR "requestId" ILIKE ${pattern} ESCAPE '\\' OR "billingEventId" ILIKE ${pattern} ESCAPE '\\' OR "model" ILIKE ${pattern} ESCAPE '\\')`);
  }
  const where = filters.length ? Prisma.sql`WHERE ${Prisma.join(filters, " AND ")}` : Prisma.empty;
  const effectiveLedger = Prisma.sql`WITH foundation AS (
    SELECT "finished_at" FROM "_prisma_migrations"
    WHERE "migration_name" = ${FOUNDATION_MIGRATION} AND "checksum" = ${FOUNDATION_CHECKSUM}
      AND "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
      AND (SELECT COUNT(*) FROM "_prisma_migrations" WHERE "migration_name" = ${FOUNDATION_MIGRATION}) = 1
  ), effective_ledger AS (
    SELECT ledger.*, CASE WHEN ledger."kind" = 'opening'
      AND ledger."id" = 'opening-' || ledger."userId"
      AND ledger."billingEventId" = 'opening:' || ledger."userId"
      AND ledger."createdAt" = (SELECT CAST("finished_at" AT TIME ZONE 'Asia/Shanghai' AS TIMESTAMP(3)) FROM foundation)
      THEN (ledger."createdAt" AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC'
      ELSE ledger."createdAt" END AS "effectiveCreatedAt"
    FROM "GatewayBillingLedger" ledger
  )`;
  const [rows, totals] = await Promise.all([
    client.$queryRaw<LedgerReadRow[]>(Prisma.sql`${effectiveLedger} SELECT * FROM effective_ledger ${where}
      ORDER BY "effectiveCreatedAt" DESC, "id" DESC LIMIT ${pageSize} OFFSET ${skip}`),
    client.$queryRaw<{ total: bigint }[]>(Prisma.sql`${effectiveLedger} SELECT COUNT(*) AS total FROM effective_ledger ${where}`)
  ]);
  return { items: rows.map(({ effectiveCreatedAt, ...row }) => ({ ...row, createdAt: effectiveCreatedAt.toISOString() })),
    total: Number(totals[0]?.total ?? 0n), page, pageSize };
}

export async function listGatewayBillingAccounts(query: GatewayBillingQuery = {}) {
  const { page, pageSize, skip } = pagination(query);
  const search = query.search?.trim().slice(0, 200);
  const where: Prisma.UserWhereInput = {
    ...(query.tenantId ? { tenantId: query.tenantId } : {}), ...(query.userId ? { id: query.userId } : {}),
    ...(query.planCode ? query.planCode === "free" ? { OR: [{ gatewayWallet: null }, { gatewayWallet: { is: { planCode: "free" } } }] } : { gatewayWallet: { is: { planCode: query.planCode } } } : {}),
    ...(search ? { AND: [{ OR: [{ username: { contains: search, mode: "insensitive" } }, { name: { contains: search, mode: "insensitive" } }, { tenant: { name: { contains: search, mode: "insensitive" } } }] }] } : {})
  };
  const [rows, total, rules] = await Promise.all([
    prisma.user.findMany({ where, skip, take: pageSize, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, tenantId: true, username: true, name: true, status: true, createdAt: true, tenant: { select: { name: true } }, gatewayWallet: true } }),
    prisma.user.count({ where }), prisma.gatewayBillingRule.findMany()
  ]);
  const items: GatewayBillingAccountView[] = rows.map((row) => {
    const wallet = row.gatewayWallet;
    const planCode = wallet?.planCode || "free";
    const rule = rules.find((item) => item.planCode === planCode);
    return {
      userId: row.id, tenantId: row.tenantId, tenantName: row.tenant.name, username: row.username, userName: row.name, status: row.status,
      planCode, planName: wallet?.planName || "体验版", balanceCents: wallet?.balanceCents || 0, balancePoints: centsToPoints(wallet?.balanceCents || 0),
      monthlyQuotaCents: wallet?.monthlyQuotaCents || 0, monthlyQuotaPoints: centsToPoints(wallet?.monthlyQuotaCents || 0),
      multiplierBps: rule?.multiplierBps ?? GATEWAY_DEFAULT_MULTIPLIER_BPS, ruleVersion: rule?.version ?? 0,
      periodStart: (wallet?.periodStart || row.createdAt).toISOString(), periodEnd: (wallet?.periodEnd || row.createdAt).toISOString(),
      updatedAt: (wallet?.updatedAt || row.createdAt).toISOString()
    };
  });
  return { items, total, page, pageSize };
}
