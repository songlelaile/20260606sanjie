import { GATEWAY_CENTS_PER_POINT, GATEWAY_MAX_COST_CENTS, GatewayBillingError } from "./billing-contract";

/** The pool is the unified accounting system's allocatable balance. This feature cannot activate it. */
export type GatewayCreditGiftInput = {
  userId: string;
  points: string;
  reason: string;
  requestKey: string;
};

export type ParsedGatewayCreditGiftInput = GatewayCreditGiftInput & { amountCents: number };

export type GatewayCreditGiftView = {
  id: string;
  requestKey: string;
  billingEventId: string;
  adminId: string;
  adminUsername: string;
  adminName: string;
  adminTenantId: string;
  adminTenantName: string;
  userId: string;
  username: string;
  userName: string;
  tenantId: string;
  tenantName: string;
  amountCents: number;
  amountPoints: number;
  poolBeforeCents: number;
  poolAfterCents: number;
  poolBeforePoints: number;
  poolAfterPoints: number;
  walletBeforeCents: number;
  walletAfterCents: number;
  walletBeforePoints: number;
  walletAfterPoints: number;
  reason: string;
  createdAt: string;
};

export type GatewayCreditGiftOverview = {
  pool: { ready: boolean; balanceCents: number | null; balancePoints: number | null };
  gifts: GatewayCreditGiftView[];
};

/** Strict decimal parsing keeps the authoritative integer cents free of float rounding. */
export function parseGatewayCreditGiftInput(value: unknown): ParsedGatewayCreditGiftInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayBillingError("INVALID_GIFT_INPUT", "请提交赠送积分信息");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["userId", "points", "reason", "requestKey"].includes(key))) {
    throw new GatewayBillingError("INVALID_GIFT_INPUT", "赠送信息包含不允许的字段");
  }
  const userId = typeof input.userId === "string" ? input.userId.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) {
    throw new GatewayBillingError("INVALID_GIFT_INPUT", "请选择有效的赠送账号");
  }
  const points = typeof input.points === "string" ? input.points.trim() : "";
  if (!/^(0|[1-9]\d{0,8})(\.\d)?$/.test(points)) {
    throw new GatewayBillingError("INVALID_GIFT_POINTS", "赠送积分必须是正数，最多一位小数");
  }
  const [whole, fraction = "0"] = points.split(".");
  const cents = BigInt(whole) * BigInt(GATEWAY_CENTS_PER_POINT) + BigInt(fraction);
  if (cents <= 0n || cents > BigInt(GATEWAY_MAX_COST_CENTS)) {
    throw new GatewayBillingError("INVALID_GIFT_POINTS", "赠送积分超过允许范围");
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 2 || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw new GatewayBillingError("INVALID_GIFT_REASON", "赠送理由需要 2 至 500 个字符");
  }
  const requestKey = typeof input.requestKey === "string" ? input.requestKey.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestKey)) {
    throw new GatewayBillingError("INVALID_GIFT_REQUEST_KEY", "赠送请求标识无效，请重新准备赠送");
  }
  return { userId, points: fraction === "0" ? whole : `${whole}.${fraction}`, amountCents: Number(cents), reason, requestKey };
}
