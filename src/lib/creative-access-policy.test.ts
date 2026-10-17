import { describe, expect, it } from "vitest";
import { resolveCreativeAccess } from "./creative-access-policy";
const NOW = new Date("2026-10-01T12:00:00Z");
const base = { valid: true, admin: false, invitation: null, paidAt: null };
describe("creative studio invitation and payment access", () => {
  it("requires recharge for self registration and pending orders", () => {
    expect(resolveCreativeAccess(base, NOW)).toMatchObject({ allowed: false, reason: "payment_required" });
  });
  it("opens invited customers without consuming model credits", () => {
    expect(resolveCreativeAccess({ ...base, invitation: { status: "active", expiresAt: null } }, NOW)).toMatchObject({ allowed: true, reason: "invited" });
  });
  it("ends paid access at the exact 30-day boundary", () => {
    const paidAt = new Date(NOW.getTime() - 30 * 86400000);
    expect(resolveCreativeAccess({ ...base, paidAt }, NOW).allowed).toBe(false);
    expect(resolveCreativeAccess({ ...base, paidAt: new Date(paidAt.getTime() + 1) }, NOW).allowed).toBe(true);
  });
  it("denies invalid database identities even with paid or admin claims", () => {
    expect(resolveCreativeAccess({ ...base, valid: false, admin: true, paidAt: NOW }, NOW).allowed).toBe(false);
  });
  it("does not treat revoked invitations or future payment timestamps as paid", () => {
    expect(resolveCreativeAccess({ ...base, invitation: { status: "revoked", expiresAt: null }, paidAt: new Date(NOW.getTime()+1) }, NOW).allowed).toBe(false);
  });
  it("supports a paid customer whose free invitation was revoked", () => {
    expect(resolveCreativeAccess({ ...base, invitation: { status: "revoked", expiresAt: null }, paidAt: NOW }, NOW).reason).toBe("paid");
  });
});
