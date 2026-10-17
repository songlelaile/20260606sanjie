import { beforeEach, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: db.user } } }));
import { getCreativeAccessForSession } from "./creative-entitlements";
const session = { username: "customer", tenantId: "tenant-a", role: "tenant" as const, name: "Customer" };
beforeEach(() => { vi.clearAllMocks(); db.user.mockResolvedValue({ status: "active", authRole: "tenant", tenantId: "tenant-a" }); });
it("preserves production signed-in customer access without a payment query", async () => {
  expect(await getCreativeAccessForSession(session)).toEqual({ allowed: true, reason: "authenticated", expiresAt: null });
  expect(db.user).toHaveBeenCalledWith({ where: { username: "customer" }, select: { status: true, tenantId: true, authRole: true } });
});
it("preserves current administrator access", async () => {
  db.user.mockResolvedValue({ status: "active", authRole: "admin", tenantId: "tenant-a" });
  expect(await getCreativeAccessForSession({ ...session, role: "admin" })).toEqual({ allowed: true, reason: "admin", expiresAt: null });
});
it.each([null, { status: "disabled", authRole: "tenant", tenantId: "tenant-a" },
  { status: "active", authRole: "tenant", tenantId: "tenant-b" },
  { status: "active", authRole: "admin", tenantId: "tenant-a" }])("fails closed on stale account: %s", async user => {
  db.user.mockResolvedValue(user);
  expect(await getCreativeAccessForSession(session)).toEqual({ allowed: false, reason: "invalid_account", expiresAt: null });
});
it("rejects anonymous access before querying database", async () => {
  expect((await getCreativeAccessForSession(null)).allowed).toBe(false); expect(db.user).not.toHaveBeenCalled();
});
it("does not turn a database outage into a granted access", async () => {
  db.user.mockRejectedValue(new Error("database unavailable")); await expect(getCreativeAccessForSession(session)).rejects.toThrow();
});
