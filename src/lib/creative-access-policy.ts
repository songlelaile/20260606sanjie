export const CREATIVE_TOOL_CODE = "creative_studio";
export const REGISTRATION_SOURCE_TOOL_CODE = "registration_source";
export const CREATIVE_ACCESS_DAYS = 30;

export type CreativeAccess = {
  allowed: boolean;
  reason: "admin" | "invited" | "paid" | "expired" | "payment_required" | "invalid_account" | "unavailable";
  expiresAt: string | null;
};

export function resolveCreativeAccess(input: {
  valid: boolean;
  admin: boolean;
  invitation: { status: string; expiresAt: Date | null } | null;
  paidAt: Date | null;
}, now = new Date()): CreativeAccess {
  if (!input.valid) return { allowed: false, reason: "invalid_account", expiresAt: null };
  if (input.admin) return { allowed: true, reason: "admin", expiresAt: null };
  if (input.invitation?.status === "active" && (!input.invitation.expiresAt || input.invitation.expiresAt > now)) {
    return { allowed: true, reason: "invited", expiresAt: input.invitation.expiresAt?.toISOString() ?? null };
  }
  if (input.paidAt && Number.isFinite(input.paidAt.getTime()) && input.paidAt <= now) {
    const expiresAt = new Date(input.paidAt.getTime() + CREATIVE_ACCESS_DAYS * 86400000);
    return { allowed: expiresAt > now, reason: expiresAt > now ? "paid" : "expired", expiresAt: expiresAt.toISOString() };
  }
  return { allowed: false, reason: "payment_required", expiresAt: null };
}
