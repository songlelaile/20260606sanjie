import "server-only";
import QRCode from "qrcode";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { findGatewayPlan } from "./catalog";
import { GatewayPaymentError } from "./payment";
import { resumeGatewayOrderAllocation, settleVerifiedScanPayment } from "./store";
import { isGatewayOrderAwaitingCapacity } from "./scan-payment-contract";
import {
  createScanPayment, getScanProviderAvailability, getAlipayPageCheckout, queryScanPayment,
  verifyScanNotification, type ScanProvider
} from "./scan-payment-providers";

export const SCAN_PAYMENT_LIFETIME_MS = 15 * 60 * 1000;
type Order = Prisma.GatewayOrderGetPayload<object>;
export type CheckoutOrder = {
  id: string; planCode: string; planName: string; amountCents: number; creditCents: number;
  paymentProvider: string; status: string; creditAllocationState: string; paymentUrl: string; qrCodeDataUrl: string | null;
  checkoutMode: "qr" | "alipay_page"; cashierUrl?: string; fallbackCashierUrl?: string;
  expiresAt: string | null; paidAt: string | null; createdAt: string;
};

export function isScanProvider(value: unknown): value is ScanProvider {
  return value === "alipay" || value === "wechat";
}

function expiration(order: Order) { return new Date(order.createdAt.getTime() + SCAN_PAYMENT_LIFETIME_MS); }

function validPaymentUrl(provider: ScanProvider, url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.hash) return false;
    return provider === "wechat"
      ? parsed.protocol === "weixin:" && parsed.hostname === "wxpay" && !parsed.port &&
        ["/bizpayurl", "/bizpayurl/up"].includes(parsed.pathname) && !!parsed.searchParams.get("pr")
      : parsed.protocol === "https:" && parsed.hostname === "qr.alipay.com" && !parsed.port;
  } catch { return false; }
}

export async function checkoutOrderView(order: Order, now = new Date()): Promise<CheckoutOrder> {
  if (isGatewayOrderAwaitingCapacity(order)) return {
    id: order.id, planCode: order.planCode, planName: order.planName, amountCents: order.amountCents,
    creditCents: order.creditCents, paymentProvider: order.paymentProvider, status: "awaiting_capacity",
    creditAllocationState: "awaiting_capacity", paymentUrl: "", qrCodeDataUrl: null,
    checkoutMode: "qr", expiresAt: null, paidAt: null, createdAt: order.createdAt.toISOString()
  };
  const expiresAt = isScanProvider(order.paymentProvider) ? expiration(order) : null;
  const expired = order.status === "pending" && !!expiresAt && expiresAt <= now;
  const page = order.paymentProvider === "alipay" && order.paymentUrl ? getAlipayPageCheckout({
    paymentUrl: order.paymentUrl, orderId: order.id, amountCents: order.amountCents, expiresAt: expiration(order)
  }) : null;
  const payable = order.status === "pending" && !expired && isScanProvider(order.paymentProvider) &&
    validPaymentUrl(order.paymentProvider, order.paymentUrl);
  return {
    id: order.id, planCode: order.planCode, planName: order.planName,
    amountCents: order.amountCents, creditCents: order.creditCents, paymentProvider: order.paymentProvider,
    status: expired ? "expired" : order.status, creditAllocationState: order.creditAllocationState,
    paymentUrl: payable ? order.paymentUrl : "",
    qrCodeDataUrl: payable ? await QRCode.toDataURL(order.paymentUrl, { errorCorrectionLevel: "M", margin: 4, width: 280 }) : null,
    checkoutMode: page ? "alipay_page" : "qr",
    ...(page && order.status === "pending" && !expired ? page : {}),
    expiresAt: expiresAt?.toISOString() ?? null, paidAt: order.paidAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString()
  };
}

export function getCheckoutProviders() { return getScanProviderAvailability(); }

export async function createCheckout(userId: string, planCode: string, provider: ScanProvider): Promise<CheckoutOrder> {
  if (!isScanProvider(provider)) throw new GatewayPaymentError("INVALID_PROVIDER", "请选择支付宝或微信支付", 400);
  const plan = findGatewayPlan(planCode);
  if (!plan || !Number.isSafeInteger(plan.priceCents) || plan.priceCents <= 0 ||
      !Number.isSafeInteger(plan.creditCents) || plan.creditCents <= 0) {
    throw new GatewayPaymentError("INVALID_PLAN", "套餐不存在或不可购买", 400);
  }
  // A database lock also serializes retries across application instances.
  const order = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`scan-checkout:${userId}`}))::text`;
    const funded = await tx.gatewayOrder.findFirst({ where: {
      userId, planCode, paymentProvider: provider, status: "pending", creditAllocationState: "awaiting_capacity"
    }, orderBy: { createdAt: "asc" } });
    if (funded) return funded;
    if (!getScanProviderAvailability().some(item => item.provider === provider && item.available)) {
      throw new GatewayPaymentError("PAYMENT_PROVIDER_UNAVAILABLE", "该支付方式暂未开通，请联系管理员", 503);
    }
    const existing = await tx.gatewayOrder.findFirst({ where: {
      userId, planCode, paymentProvider: provider, status: "pending",
      createdAt: { gt: new Date(Date.now() - SCAN_PAYMENT_LIFETIME_MS) }
    }, orderBy: { createdAt: "desc" } });
    return existing || tx.gatewayOrder.create({ data: {
      userId, planCode: plan.code, planName: plan.name, amountCents: plan.priceCents,
      creditCents: plan.creditCents, paymentProvider: provider, paymentUrl: ""
    } });
  }, { maxWait: 15_000, timeout: 25_000 });
  if (isGatewayOrderAwaitingCapacity(order)) return checkoutOrderView(await resumeGatewayOrderAllocation(userId, order.id));
  // Commit the order BEFORE calling the provider. A timeout must leave a known,
  // queryable order, and a retry always uses the same merchant order number.
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`scan-checkout:${userId}`}))::text`;
    let current = await tx.gatewayOrder.findUniqueOrThrow({ where: { id: order.id } });
    if (isGatewayOrderAwaitingCapacity(current) || current.status !== "pending" || current.paymentUrl || expiration(current) <= new Date()) return { order: current };
    try {
      const payment = await createScanPayment({ provider, orderId: current.id,
        description: `少壮 AI · ${current.planName}`, amountCents: current.amountCents, expiresAt: expiration(current) });
      if (!validPaymentUrl(provider, payment.paymentUrl) && !(provider === "alipay" && getAlipayPageCheckout({
        paymentUrl: payment.paymentUrl, orderId: current.id, amountCents: current.amountCents, expiresAt: expiration(current)
      }))) {
        throw new GatewayPaymentError("INVALID_PAYMENT_URL", "支付渠道未返回有效收款码，请稍后重试", 503);
      }
      // A notify may have settled this order while the upstream request ran.
      await tx.gatewayOrder.updateMany({ where: { id: current.id, status: "pending", creditAllocationState: { not: "awaiting_capacity" } }, data: { paymentUrl: payment.paymentUrl } });
      current = await tx.gatewayOrder.findUniqueOrThrow({ where: { id: current.id } });
      return { order: current };
    } catch (error) {
      // Do not mark failed: an ambiguous upstream response is not proof of nonpayment.
      return { error };
    }
  }, { maxWait: 15_000, timeout: 25_000 });
  if ("error" in result) throw result.error;
  if (isGatewayOrderAwaitingCapacity(result.order)) return checkoutOrderView(await resumeGatewayOrderAllocation(userId, result.order.id));
  return checkoutOrderView(result.order);
}

export async function getCheckout(userId: string, id: string): Promise<CheckoutOrder> {
  let order = await prisma.gatewayOrder.findFirst({ where: { id, userId, paymentProvider: { in: ["alipay", "wechat"] } } });
  if (!order) throw new GatewayPaymentError("ORDER_NOT_FOUND", "订单不存在", 404);
  if (isGatewayOrderAwaitingCapacity(order)) return checkoutOrderView(await resumeGatewayOrderAllocation(userId, order.id));
  if (order.status === "pending" && isScanProvider(order.paymentProvider)) {
    const verified = await queryScanPayment(order.paymentProvider, order.id);
    if (verified) {
      if (verified.orderId !== order.id || verified.provider !== order.paymentProvider) {
        throw new GatewayPaymentError("PAYMENT_ORDER_MISMATCH", "支付核验结果与订单不一致", 409);
      }
      order = await settleVerifiedScanPayment(verified);
    }
  }
  return checkoutOrderView(order);
}

export async function receiveScanNotification(provider: ScanProvider, request: Request) {
  const verified = await verifyScanNotification(provider, request);
  if (!verified) return;
  if (verified.provider !== provider) throw new GatewayPaymentError("PAYMENT_PROVIDER_MISMATCH", "支付通知渠道不一致", 400);
  await settleVerifiedScanPayment(verified);
}
