import { GatewayBillingError } from "./billing-contract";
import { parseGatewayCreditGiftInput } from "./credit-gifts-contract";
export type GiftPlanView = { id: string; requestKey: string; adminId: string; userId: string; amountCents: number; reason: string;
  status: "pending" | "blocked" | "completed" | "cancelled" | "expired"; lastCode: string | null;
  expiresAt: string; executedAt: string | null; cancelledAt: string | null; createdAt: string };
export function parseGiftPlanInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayBillingError("INVALID_GIFT_INPUT", "请填写预设赠送内容", 400);
  const { expiresAt, ...gift } = value as Record<string, unknown>;
  const parsed = parseGatewayCreditGiftInput(gift);
  // The validity horizon is rechecked only for a new authorization, so a retry
  // after expiry can still retrieve the existing immutable authorization.
  if (typeof expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiresAt) || !Number.isFinite(Date.parse(expiresAt))) {
    throw new GatewayBillingError("GIFT_PLAN_EXPIRY_INVALID", "请填写有效的赠送截止时间", 400);
  }
  const normalized = new Date(expiresAt).toISOString();
  if (normalized !== (expiresAt.length === 20 ? expiresAt.replace("Z", ".000Z") : expiresAt)) {
    throw new GatewayBillingError("GIFT_PLAN_EXPIRY_INVALID", "请填写有效的赠送截止时间", 400);
  }
  return { ...parsed, expiresAt: normalized };
}
