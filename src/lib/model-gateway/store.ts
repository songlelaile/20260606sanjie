import "server-only";
import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { findGatewayPlan } from "@/lib/model-gateway/catalog";

export type GatewayAuth = {
  userId: string;
  username: string;
  apiKeyId: string;
  keyPrefix: string;
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
  return prisma.gatewayWallet.upsert({
    where: { userId },
    update: {},
    create: {
      userId,
      balanceCents: 0,
      monthlyQuotaCents: 0,
      planCode: "free",
      planName: "体验版",
      periodStart: new Date(),
      periodEnd: new Date()
    }
  });
}

export async function getGatewayOverview(userId: string) {
  const [wallet, keys, orders, usages] = await Promise.all([
    ensureGatewayWallet(userId),
    prisma.gatewayApiKey.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, keyPrefix: true, status: true, createdAt: true, lastUsedAt: true }
    }),
    prisma.gatewayOrder.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 8
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
    include: { user: true }
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
    keyPrefix: row.keyPrefix
  };
}

export async function createGatewayOrder(userId: string, planCode: string) {
  const plan = findGatewayPlan(planCode);
  if (!plan) {
    throw new Error("套餐不存在");
  }
  const order = await prisma.gatewayOrder.create({
    data: {
      userId,
      planCode: plan.code,
      planName: plan.name,
      amountCents: plan.priceCents,
      creditCents: plan.creditCents,
      paymentProvider: process.env.MODEL_GATEWAY_PAYMENT_PROVIDER || "manual",
      paymentUrl: process.env.MODEL_GATEWAY_MANUAL_PAY_URL || ""
    }
  });
  if (process.env.MODEL_GATEWAY_AUTO_PAY === "1") {
    return markGatewayOrderPaid(userId, order.id);
  }
  return order;
}

type GatewayOrderRow = Prisma.GatewayOrderGetPayload<object>;

async function creditGatewayOrder(tx: Prisma.TransactionClient, order: GatewayOrderRow) {
  if (order.status === "paid") {
    return order;
  }
  const now = new Date();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  await tx.gatewayWallet.upsert({
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
  return tx.gatewayOrder.update({
    where: { id: order.id },
    data: { status: "paid", paidAt: now }
  });
}

export async function markGatewayOrderPaid(userId: string, orderId: string) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.gatewayOrder.findFirst({ where: { id: orderId, userId } });
    if (!order) {
      throw new Error("订单不存在");
    }
    return creditGatewayOrder(tx, order);
  });
}

export async function markGatewayOrderPaidByOrderId(orderId: string) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.gatewayOrder.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new Error("订单不存在");
    }
    return creditGatewayOrder(tx, order);
  });
}

export async function assertGatewayBalance(userId: string, minCents = 1) {
  const wallet = await ensureGatewayWallet(userId);
  return wallet.balanceCents >= minCents;
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
}) {
  return prisma.$transaction(async (tx) => {
    if (input.status === "ok" && input.costCents > 0) {
      await tx.gatewayWallet.upsert({
        where: { userId: input.auth.userId },
        update: { balanceCents: { decrement: input.costCents } },
        create: {
          userId: input.auth.userId,
          balanceCents: -input.costCents,
          monthlyQuotaCents: 0,
          planCode: "free",
          planName: "体验版",
          periodStart: new Date(),
          periodEnd: new Date()
        }
      });
    }
    return tx.gatewayUsage.create({
      data: {
        userId: input.auth.userId,
        apiKeyId: input.auth.apiKeyId,
        requestId: input.requestId || "",
        endpoint: input.endpoint,
        provider: input.provider,
        model: input.model,
        promptTokens: input.promptTokens || 0,
        completionTokens: input.completionTokens || 0,
        totalTokens: input.totalTokens || 0,
        imageCount: input.imageCount || 0,
        costCents: input.status === "ok" ? input.costCents : 0,
        status: input.status,
        error: input.error || "",
        metadata: input.metadata || {}
      }
    });
  });
}
