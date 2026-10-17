import { assertGatewayAllocationBudget } from "./credit-allocation-window";
import "server-only";
import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { findGatewayPlan } from "@/lib/model-gateway/catalog";
import {
  applyGatewayBillingCost, getGatewayBillingSnapshot, lockGatewayBillingWallet,
  ensureGatewayBillingOpening, safeGatewayBillingMetadata, safeGatewayBillingError,
  GatewayBillingError
} from "@/lib/model-gateway/billing";
import type { GatewayBillingSnapshot, GatewayBillingAudit } from "@/lib/model-gateway/billing-contract";
import { getGatewayAvailableBalance, isGatewayBillingHoldSettlement } from "@/lib/model-gateway/billing-hold";
import type { VerifiedScanPayment } from "@/lib/model-gateway/scan-payment-providers";
import { lockGatewayAccountingIdentities, lockGatewayAccountingPool } from "./accounting-coordination";
import { assertGatewayPoolReady, assertGatewayPoolNewQuote, assertGatewayPoolUsageEvidence, moveGatewayPool, recordGatewaySourceUsage, refreshGatewaySharedPoolFromSource } from "./credit-pool-accounting";
import {
  GatewayPaymentError,
  getGatewayManualPaymentConfig,
  parseManualPaymentConfirmation,
  type ManualPaymentConfirmation
} from "@/lib/model-gateway/payment";

export type GatewayAuth = {
  userId: string;
  username: string;
  apiKeyId: string | null;
  keyPrefix: string;
  shopName?: string;
};

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function newPlainApiKey() {
  return `sk-sz-${crypto.randomBytes(30).toString("base64url")}`;
}

export function hashGatewayKey(key: string) {
  return sha256(key.trim());
}

export async function ensureGatewayWallet(userId: string) {
  return prisma.$transaction(tx => lockGatewayBillingWallet(tx, userId));
}

export async function getGatewayOverview(userId: string) {
  await ensureGatewayWallet(userId);
  const [wallet, keys, orders, usages] = await Promise.all([
    prisma.$transaction(async (tx) => {
      const wallet = await tx.gatewayWallet.findUniqueOrThrow({ where: { userId } });
      const balance = await getGatewayAvailableBalance(tx, userId);
      return { ...wallet, ...balance };
    }, { isolationLevel: "RepeatableRead" }),
    prisma.gatewayApiKey.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, keyPrefix: true, status: true, createdAt: true, lastUsedAt: true }
    }),
    prisma.gatewayOrder.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { id: true, userId: true, planCode: true, planName: true, amountCents: true, creditCents: true, status: true,
        paymentProvider: true, paymentUrl: true, paidAt: true, createdAt: true, creditAllocationState: true }
    }),
    prisma.gatewayUsage.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 12
    })
  ]);
  return { wallet, keys, orders, usages };
}

export async function createGatewayApiKey(userId: string, name: string) {
  await ensureGatewayWallet(userId);
  const activeCount = await prisma.gatewayApiKey.count({ where: { userId, status: "active" } });
  if (activeCount >= 20) {
    throw new Error("API Key 数量已达上限");
  }
  const plainKey = newPlainApiKey();
  const keyPrefix = `${plainKey.slice(0, 11)}...${plainKey.slice(-4)}`;
  const record = await prisma.gatewayApiKey.create({
    data: {
      userId,
      name: name.trim() || "默认 Key",
      keyHash: hashGatewayKey(plainKey),
      keyPrefix
    },
    select: { id: true, name: true, keyPrefix: true, status: true, createdAt: true, lastUsedAt: true }
  });
  return { key: plainKey, record };
}

export async function disableGatewayApiKey(userId: string, id: string) {
  const result = await prisma.gatewayApiKey.updateMany({
    where: { id, userId },
    data: { status: "disabled" }
  });
  return result.count > 0;
}

export async function authenticateGatewayKey(rawAuth: string | null): Promise<GatewayAuth | null> {
  const token = (rawAuth || "").replace(/^Bearer\s+/i, "").trim();
  if (!token || !token.startsWith("sk-sz-")) {
    return null;
  }
  const row = await prisma.gatewayApiKey.findUnique({
    where: { keyHash: hashGatewayKey(token) },
    include: { user: { include: { tenant: { select: { name: true } } } } }
  });
  if (!row || row.status !== "active" || row.user.status === "disabled") {
    return null;
  }
  await prisma.gatewayApiKey.update({
    where: { id: row.id },
    data: { lastUsedAt: new Date() }
  });
  return {
    userId: row.userId,
    username: row.user.username,
    apiKeyId: row.id,
    keyPrefix: row.keyPrefix,
    shopName: row.user.shopName.trim() || row.user.tenant.name
  };
}

export async function createGatewayOrder(userId: string, planCode: string) {
  const plan = findGatewayPlan(planCode);
  if (!plan || !Number.isSafeInteger(plan.priceCents) || plan.priceCents <= 0 ||
      !Number.isSafeInteger(plan.creditCents) || plan.creditCents <= 0) {
    throw new GatewayPaymentError("INVALID_PLAN", "套餐不存在或不可购买", 400);
  }
  const payment = getGatewayManualPaymentConfig();
  return prisma.$transaction(async tx => {
    await lockGatewayAccountingIdentities(tx, [userId]);
    const awaiting = await tx.gatewayOrder.findFirst({ where: { userId, planCode, paymentProvider: payment.paymentProvider,
      status: "pending", creditAllocationState: "awaiting_capacity" }, orderBy: { createdAt: "desc" } });
    if (awaiting) return { ...awaiting, paymentUrl: "" };
    return tx.gatewayOrder.create({
    data: {
      userId,
      planCode: plan.code,
      planName: plan.name,
      amountCents: plan.priceCents,
      creditCents: plan.creditCents,
      paymentProvider: payment.paymentProvider,
      paymentUrl: payment.paymentUrl
    }
    });
  });
}

type GatewayOrderRow = Prisma.GatewayOrderGetPayload<object>;

export async function getGatewayOrder(userId: string, orderId: string, allowAdmin = false) {
  return prisma.gatewayOrder.findFirst({
    where: { id: orderId, ...(allowAdmin ? {} : { userId }) }
  });
}

async function creditGatewayOrder(
  tx: Prisma.TransactionClient,
  order: GatewayOrderRow,
  confirmation: {
    provider: string; receipt: string; receivedAmountCents: number; note: string;
    actor: { id: string; username: string; name: string } | null;
  }
) {
  await lockGatewayAccountingIdentities(tx, [order.userId, ...(confirmation.actor ? [confirmation.actor.id] : [])]);
  const pool = await lockGatewayAccountingPool(tx);
  // Refresh under the global fence: a row read before waiting may already have been credited.
  order = await tx.gatewayOrder.findUniqueOrThrow({ where: { id: order.id } });
  if (order.paymentProvider !== confirmation.provider) {
    throw new GatewayPaymentError("PAYMENT_PROVIDER_MISMATCH", "付款渠道与订单不一致，不能确认入账", 409);
  }
  if (!Number.isSafeInteger(order.amountCents) || order.amountCents <= 0 ||
      !Number.isSafeInteger(order.creditCents) || order.creditCents <= 0) {
    throw new GatewayPaymentError("INVALID_ORDER_AMOUNT", "订单金额异常，不能确认入账", 409);
  }
  if (confirmation.receivedAmountCents !== order.amountCents) {
    throw new GatewayPaymentError("PAYMENT_AMOUNT_MISMATCH", "实收金额与订单金额不一致，不能开通", 409);
  }
  if (order.status === "paid") {
    if (order.paymentReceipt !== confirmation.receipt) {
      throw new GatewayPaymentError("ORDER_ALREADY_PAID", "订单已凭其他付款凭证确认，请勿重复确认", 409);
    }
    return order;
  }
  if (order.status !== "pending") {
    throw new GatewayPaymentError("ORDER_NOT_PAYABLE", "订单已关闭或失败，不能确认入账", 409);
  }
  const evidence = await tx.gatewayCreditFundingEvidence.findUnique({ where: { orderId: order.id } });
  if (evidence && (evidence.receipt !== confirmation.receipt || evidence.provider !== confirmation.provider ||
    evidence.receivedAmountCents !== confirmation.receivedAmountCents || evidence.creditCents !== order.creditCents || evidence.userId !== order.userId)) {
    throw new GatewayPaymentError("ORDER_CONFIRMATION_CONFLICT", "已核验付款证据不一致，请核对收款流水", 409);
  }
  if (evidence) confirmation = { provider: evidence.provider, receipt: evidence.receipt, receivedAmountCents: evidence.receivedAmountCents,
    note: evidence.note, actor: evidence.actorId ? { id: evidence.actorId, username: evidence.actorUsername ?? "", name: evidence.actorName ?? "" } : null };
  const user = await tx.user.findUniqueOrThrow({ where: { id: order.userId }, include: { tenant: { select: { name: true } } } });
  const before = await lockGatewayBillingWallet(tx, order.userId);
  await tx.$queryRaw`SELECT "id" FROM "GatewayOrder" WHERE "id" = ${order.id} FOR UPDATE`;
  if (!evidence) await tx.gatewayCreditFundingEvidence.create({ data: {
    orderId: order.id, userId: order.userId, provider: confirmation.provider, receipt: confirmation.receipt,
    receivedAmountCents: confirmation.receivedAmountCents, creditCents: order.creditCents,
    actorId: confirmation.actor?.id, actorUsername: confirmation.actor?.username, actorName: confirmation.actor?.name, note: confirmation.note
  } });
  // Verified money is acknowledged durably even if capacity/source is not currently allocatable.
  // Missing/uninitialized pool preserves legacy recharge; it is adopted later in full W.
  let waiting = false;
  if (pool && (pool.accountingVersion !== 0 || pool.status !== "pending")) {
    try {
      await assertGatewayPoolReady(tx, pool);
      await assertGatewayAllocationBudget(tx, pool, order.creditCents);
      waiting = pool.balanceCents < order.creditCents;
    }
    catch (error) { if (!(error instanceof GatewayBillingError)) throw error; waiting = true; }
  }
  if (before.balanceCents > 2_147_483_647 - order.creditCents) waiting = true;
  if (waiting) return tx.gatewayOrder.update({ where: { id: order.id }, data: {
    creditAllocationState: "awaiting_capacity", paymentReceipt: confirmation.receipt,
    receivedAmountCents: confirmation.receivedAmountCents, confirmedBy: evidence?.actorId ?? confirmation.actor?.id ?? null,
    confirmationNote: evidence?.note ?? confirmation.note
  } });
  const now = new Date();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  // Locks are held in coordination -> identity -> pool -> wallet -> order order.
  const claim = await tx.gatewayOrder.updateMany({
    where: { id: order.id, status: "pending" },
    data: {
      status: "paid",
      paidAt: now,
      paymentReceipt: confirmation.receipt,
      confirmedBy: confirmation.actor?.id ?? null,
      confirmationNote: confirmation.note,
      receivedAmountCents: confirmation.receivedAmountCents,
      creditAllocationState: "credited"
    }
  });
  if (claim.count !== 1) {
    const current = await tx.gatewayOrder.findUnique({ where: { id: order.id } });
    if (current?.status === "paid" && current.paymentReceipt === confirmation.receipt) return current;
    throw new GatewayPaymentError("ORDER_CONFIRMATION_CONFLICT", "订单状态已变化，请刷新后再确认", 409);
  }
  await ensureGatewayBillingOpening(tx, user, before);
  await moveGatewayPool(tx, { eventId: `recharge:${order.id}`, kind: "recharge", userId: user.id,
    actorId: evidence?.actorId ?? confirmation.actor?.id, amountCents: order.creditCents });
  const wallet = await tx.gatewayWallet.upsert({
    where: { userId: order.userId },
    update: {
      balanceCents: { increment: order.creditCents },
      monthlyQuotaCents: order.creditCents,
      planCode: order.planCode,
      planName: order.planName,
      periodStart: now,
      periodEnd
    },
    create: {
      userId: order.userId,
      balanceCents: order.creditCents,
      monthlyQuotaCents: order.creditCents,
      planCode: order.planCode,
      planName: order.planName,
      periodStart: now,
      periodEnd
    }
  });
  const rule = await tx.gatewayBillingRule.findUnique({ where: { planCode: order.planCode } });
  await tx.gatewayBillingLedger.create({ data: {
    billingEventId: `recharge:${order.id}`, kind: "recharge", userId: user.id, tenantId: user.tenantId, tenantName: user.tenant.name,
    username: user.username, userName: user.name, planCode: order.planCode, planName: order.planName,
    multiplierBps: rule?.multiplierBps ?? 10_000, ruleVersion: rule?.version ?? 0,
    deltaCents: order.creditCents, balanceBeforeCents: before.balanceCents, balanceAfterCents: wallet.balanceCents,
    orderId: order.id, status: "ok", provider: confirmation.provider,
    actorId: confirmation.actor?.id ?? null, actorUsername: confirmation.actor?.username ?? null,
    actorName: confirmation.actor?.name ?? null, reason: confirmation.note
  } });
  // Check deferred allocation constraints before COMMIT so the API cannot
  // report credited if an older Prisma engine swallows a commit-time failure.
  await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
  return tx.gatewayOrder.findUniqueOrThrow({ where: { id: order.id } });
}

async function confirmGatewayOrder(where: { id: string; userId?: string }, input: ManualPaymentConfirmation) {
  const confirmation = parseManualPaymentConfirmation(input, input?.confirmedBy);
  await refreshGatewaySharedPoolFromSource();
  try {
    return await prisma.$transaction(async (tx) => {
      await lockGatewayAccountingIdentities(tx, [confirmation.confirmedBy]);
      // Defense in depth: callers cannot credit an order merely by passing an
      // arbitrary confirmedBy value, even if they bypass the HTTP route.
      const admin = await tx.user.findUnique({ where: { id: confirmation.confirmedBy } });
      if (!admin || admin.authRole !== "admin" || admin.status !== "active") {
        throw new GatewayPaymentError("ADMIN_REQUIRED", "仅有效管理员可确认人工收款", 403);
      }
      const order = await tx.gatewayOrder.findFirst({ where });
      if (!order) {
        throw new GatewayPaymentError("ORDER_NOT_FOUND", "订单不存在", 404);
      }
      if (order.paymentProvider !== "manual") {
        throw new GatewayPaymentError("MANUAL_CONFIRMATION_NOT_ALLOWED", "此订单必须通过对应支付供应商核验到账", 409);
      }
      return creditGatewayOrder(tx, order, { ...confirmation, provider: "manual", actor: admin,
        note: confirmation.note || "管理员确认真实收款入账" });
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      throw new GatewayPaymentError("RECEIPT_ALREADY_USED", "付款凭证已用于其他订单，请核对收款流水", 409);
    }
    throw error;
  }
}

export async function markGatewayOrderPaid(userId: string, orderId: string, confirmation: ManualPaymentConfirmation) {
  return confirmGatewayOrder({ id: orderId, userId }, confirmation);
}

export async function markGatewayOrderPaidByOrderId(orderId: string, confirmation: ManualPaymentConfirmation) {
  return confirmGatewayOrder({ id: orderId }, confirmation);
}

/** Server-only entry point. Call only after provider signature/merchant/status verification. */
export async function settleVerifiedScanPayment(payment: VerifiedScanPayment) {
  if (!payment || !["alipay", "wechat"].includes(payment.provider) ||
      typeof payment.orderId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(payment.orderId) ||
      typeof payment.receipt !== "string" || !/^[A-Za-z0-9_-]{1,140}$/.test(payment.receipt) ||
      !Number.isSafeInteger(payment.amountCents) || payment.amountCents <= 0) {
    throw new GatewayPaymentError("INVALID_PAYMENT_EVIDENCE", "支付核验结果无效", 400);
  }
  await refreshGatewaySharedPoolFromSource();
  try {
    return await prisma.$transaction(async tx => {
      await lockGatewayAccountingIdentities(tx, []);
      const order = await tx.gatewayOrder.findUnique({ where: { id: payment.orderId } });
      if (!order) throw new GatewayPaymentError("ORDER_NOT_FOUND", "订单不存在", 404);
      return creditGatewayOrder(tx, order, {
        provider: payment.provider, receipt: `${payment.provider}:${payment.receipt}`,
        receivedAmountCents: payment.amountCents, actor: null,
        note: `${payment.provider === "alipay" ? "支付宝" : "微信支付"}验签核验到账`
      });
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      throw new GatewayPaymentError("RECEIPT_ALREADY_USED", "付款凭证已用于其他订单，请核对收款流水", 409);
    }
    throw error;
  }
}

/** Server-side reconciliation of a previously verified receipt; no second provider call/payment. */
export async function retryGatewayPendingCredit(adminId: string, orderId: string) {
  await refreshGatewaySharedPoolFromSource();
  return prisma.$transaction(async tx => {
    await lockGatewayAccountingIdentities(tx, [adminId]);
    const admin = await tx.user.findUnique({ where: { id: adminId } });
    if (!admin || admin.status !== "active" || admin.authRole !== "admin") throw new GatewayPaymentError("ADMIN_REQUIRED", "仅有效管理员可核对待入账付款", 403);
    const order = await tx.gatewayOrder.findUnique({ where: { id: orderId } });
    const evidence = await tx.gatewayCreditFundingEvidence.findUnique({ where: { orderId } });
    if (!order || !evidence || (order.status !== "paid" && order.creditAllocationState !== "awaiting_capacity")) throw new GatewayPaymentError("PAYMENT_EVIDENCE_MISSING", "没有可核对的已验真付款", 409);
    return creditGatewayOrder(tx, order, { provider: evidence.provider, receipt: evidence.receipt, receivedAmountCents: evidence.receivedAmountCents,
      note: evidence.note, actor: evidence.actorId ? { id: evidence.actorId, username: evidence.actorUsername ?? "", name: evidence.actorName ?? "" } : null });
  });
}

/** Authenticated owner can resume only the database's exact already-verified payment. */
export async function resumeGatewayOrderAllocation(userId: string, orderId: string) {
  await refreshGatewaySharedPoolFromSource();
  return prisma.$transaction(async tx => {
    await lockGatewayAccountingIdentities(tx, [userId]);
    const user = await tx.user.findUnique({ where: { id: userId } });
    const order = await tx.gatewayOrder.findFirst({ where: { id: orderId, userId } });
    if (!user || user.status !== "active" || !order) throw new GatewayPaymentError("ORDER_NOT_FOUND", "订单不存在或账号不可用", 404);
    if (order.status === "paid") return order;
    const evidence = await tx.gatewayCreditFundingEvidence.findUnique({ where: { orderId: order.id } });
    if (order.creditAllocationState !== "awaiting_capacity" || !evidence || evidence.userId !== userId ||
      evidence.provider !== order.paymentProvider || evidence.receipt !== order.paymentReceipt ||
      evidence.creditCents !== order.creditCents || evidence.receivedAmountCents !== order.amountCents ||
      order.receivedAmountCents !== evidence.receivedAmountCents) throw new GatewayPaymentError("PAYMENT_EVIDENCE_MISSING", "没有可核对的已验真付款", 409);
    return creditGatewayOrder(tx, order, { provider: evidence.provider, receipt: evidence.receipt,
      receivedAmountCents: evidence.receivedAmountCents, note: evidence.note,
      actor: evidence.actorId ? { id: evidence.actorId, username: evidence.actorUsername ?? "", name: evidence.actorName ?? "" } : null });
  });
}

export async function assertGatewayBalance(userId: string, minCents = 1) {
  await ensureGatewayWallet(userId);
  return prisma.$transaction(async (tx) => {
    await lockGatewayBillingWallet(tx, userId);
    return (await getGatewayAvailableBalance(tx, userId)).availableCents >= minCents;
  });
}

export async function recordGatewayUsage(input: {
  auth: GatewayAuth;
  endpoint: string;
  provider: string;
  model: string;
  requestId?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  imageCount?: number;
  costCents: number;
  status: "ok" | "error";
  error?: string;
  metadata?: Prisma.InputJsonValue;
  billingSnapshot?: GatewayBillingSnapshot;
  baseCostCents?: number;
  billingEventId?: string;
  audit?: GatewayBillingAudit;
}, transaction?: Prisma.TransactionClient) {
  const billingEventId = input.billingEventId || crypto.randomUUID();
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(billingEventId) || ["opening:", "recharge:", "gift:"].some((prefix) => billingEventId.startsWith(prefix))) {
    throw new GatewayBillingError("INVALID_BILLING_EVENT", "调用计费事件标识无效");
  }
  const snapshot = input.billingSnapshot || await getGatewayBillingSnapshot(input.auth.userId);
  if (snapshot.userId !== input.auth.userId || !Number.isSafeInteger(snapshot.ruleVersion) || snapshot.ruleVersion < 0) {
    throw new GatewayBillingError("INVALID_BILLING_SNAPSHOT", "计费快照不属于当前账号");
  }
  const baseCostCents = input.baseCostCents ?? input.costCents;
  const quotedCost = applyGatewayBillingCost(baseCostCents, snapshot);
  const metadata = safeGatewayBillingMetadata({ ...((input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)) ? input.metadata : {}), outcome: input.audit?.outcome || "" });
  const count = (value: number | undefined) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647 ? Number(value) : 0;
  const shortId = (value: string | undefined) => value && /^[A-Za-z0-9_.:-]{1,256}$/.test(value) && !/sk-|bearer/i.test(value) ? value : "";
  const stableMetadata = (value: unknown) => JSON.stringify(Object.entries(safeGatewayBillingMetadata(value)).filter(([key]) => key !== "outcome").sort(([left], [right]) => left.localeCompare(right)));
  const write = async (tx: Prisma.TransactionClient) => {
    await lockGatewayAccountingIdentities(tx, [input.auth.userId]);
    const user = await tx.user.findUnique({ where: { id: input.auth.userId }, include: { tenant: { select: { name: true } } } });
    const hold = await tx.gatewayBillingHold.findUnique({where:{eventId:billingEventId}});
    if (hold?.billingMode === "prepaid_quote" && !isGatewayBillingHoldSettlement(tx,billingEventId)) throw new GatewayBillingError("HOLD_SETTLEMENT_REQUIRED", "提交收费请求的用量需在原结算事务核对", 409);
    const prepaid = hold?.billingMode === "prepaid_quote";
    if (!user || (!prepaid && user.status !== "active") || user.tenantId !== snapshot.tenantId) throw new GatewayBillingError("ACCOUNT_UNAVAILABLE", "当前计费账号已失效", 401);
    const before = await lockGatewayBillingWallet(tx, user.id);
    const existing = await tx.gatewayUsage.findUnique({ where: { billingEventId } });
    if (existing) {
      const entry = await tx.gatewayBillingLedger.findUnique({ where: { billingEventId } });
      if (!entry || existing.userId !== user.id || existing.apiKeyId !== input.auth.apiKeyId || existing.endpoint !== input.endpoint || existing.model !== input.model || existing.provider !== input.provider || entry.baseCostCents !== baseCostCents ||
        entry.planCode !== snapshot.planCode || entry.multiplierBps !== snapshot.multiplierBps || entry.ruleVersion !== snapshot.ruleVersion ||
        existing.requestId !== shortId(input.requestId) || existing.promptTokens !== count(input.promptTokens) || existing.completionTokens !== count(input.completionTokens) ||
        existing.totalTokens !== count(input.totalTokens) || existing.imageCount !== count(input.imageCount) || stableMetadata(entry.metadata) !== stableMetadata(metadata) ||
        (existing.status !== input.status && !(entry.status === "settlement_rejected" && input.status === "ok"))) {
        throw new GatewayBillingError("BILLING_EVENT_CONFLICT", "计费事件已用于其他调用", 409);
      }
      return { usage: existing, insufficient: entry.status === "settlement_rejected" };
    }
    if (!prepaid && input.status === "ok" && quotedCost > 0 && !isGatewayBillingHoldSettlement(tx, billingEventId)) await assertGatewayPoolNewQuote(tx, snapshot);
    if ((prepaid || input.status === "ok") && quotedCost > 0) await assertGatewayPoolUsageEvidence(tx, snapshot, { eventId: billingEventId, baseCostCents, chargedCostCents: quotedCost, metadata });
    await ensureGatewayBillingOpening(tx, user, before);
    let costCents = !prepaid && input.status === "ok" ? quotedCost : 0;
    let insufficient = false;
    if (costCents > 0) {
      const available = await getGatewayAvailableBalance(tx, user.id, isGatewayBillingHoldSettlement(tx, billingEventId) ? billingEventId : undefined);
      const debit = available.availableCents < costCents ? { count: 0 } : await tx.gatewayWallet.updateMany({
        where: { userId: user.id, balanceCents: { gte: costCents } },
        data: { balanceCents: { decrement: costCents } }
      });
      if (debit.count !== 1) { insufficient = true; costCents = 0; }
      if (costCents > 0) await moveGatewayPool(tx, { eventId: billingEventId, kind: "debit", userId: user.id,
        actorId: user.id, amountCents: costCents });
    }
    const status = insufficient ? "error" : input.status;
    const error = insufficient ? "INSUFFICIENT_BALANCE" : safeGatewayBillingError(input.error);
    const usage = await tx.gatewayUsage.create({
      data: {
        userId: input.auth.userId,
        apiKeyId: input.auth.apiKeyId,
        requestId: shortId(input.requestId), billingEventId,
        endpoint: input.endpoint,
        provider: input.provider,
        model: input.model,
        promptTokens: count(input.promptTokens), completionTokens: count(input.completionTokens),
        totalTokens: count(input.totalTokens), imageCount: count(input.imageCount),
        costCents, status, error, metadata
      }
    });
    await tx.gatewayBillingLedger.create({ data: {
      billingEventId, kind: prepaid ? "usage" : status === "ok" ? "debit" : "error", usageId: usage.id,
      userId: user.id, tenantId: snapshot.tenantId, tenantName: snapshot.tenantName || user.tenant.name, username: snapshot.username, userName: snapshot.userName,
      planCode: snapshot.planCode, planName: snapshot.planName, multiplierBps: snapshot.multiplierBps, ruleVersion: snapshot.ruleVersion,
      deltaCents: -costCents, balanceBeforeCents: before.balanceCents, balanceAfterCents: before.balanceCents - costCents,
      baseCostCents, chargedCostCents: costCents, endpoint: usage.endpoint, provider: usage.provider, model: usage.model,
      requestId: usage.requestId, apiKeyId: usage.apiKeyId, keyPrefix: input.auth.keyPrefix.slice(0, 80),
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens, imageCount: usage.imageCount,
      durationMs: input.audit?.durationMs === undefined ? null : count(input.audit.durationMs),
      upstreamStatus: input.audit?.upstreamStatus === undefined ? null : count(input.audit.upstreamStatus),
      status: insufficient ? "settlement_rejected" : status === "error" && input.audit?.outcome === "settlement_failed" ? "settlement_failed"
        : status === "error" && input.audit?.outcome === "balance_rejected" ? "preflight_rejected" : status, error, metadata,
      actorId: user.id, actorUsername: snapshot.username, actorName: snapshot.userName
    } });
    if (costCents > 0 || (prepaid && quotedCost > 0)) await recordGatewaySourceUsage(tx, billingEventId, user.id, metadata);
    return { usage, insufficient };
  };
  const outcome = transaction ? await write(transaction) : await prisma.$transaction(write);
  if (outcome.insufficient) throw new GatewayBillingError("INSUFFICIENT_BALANCE", "余额不足，当前调用未扣费，请充值后再操作", 402);
  return outcome.usage;
}
