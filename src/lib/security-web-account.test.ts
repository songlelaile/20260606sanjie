import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: mocks.findUnique } } }));
import { isActiveSecurityAccount, securityAccountIdentity } from "./security-web-account";
const session = { username: "test", tenantId: "tenant", role: "tenant" as const, name: "name" };
beforeEach(() => vi.clearAllMocks());
it("revokes old signed sessions when status, tenant or role changes", async () => {
  for (const user of [null, { status: "disabled", tenantId: "tenant", authRole: "tenant" }, { status: "active", tenantId: "other", authRole: "tenant" }, { status: "active", tenantId: "tenant", authRole: "admin" }]) {
    mocks.findUnique.mockResolvedValueOnce(user);
    expect(await isActiveSecurityAccount(session)).toBe(false);
  }
  mocks.findUnique.mockResolvedValueOnce({ status: "active", tenantId: "tenant", authRole: "tenant" });
  expect(await isActiveSecurityAccount(session)).toBe(true);
});
it("keeps account quotas stable across display-name or role changes", () => {
  expect(securityAccountIdentity(session)).toBe(securityAccountIdentity({ ...session, name: "renamed", role: "admin" }));
  expect(securityAccountIdentity(session)).not.toBe(securityAccountIdentity({ ...session, tenantId: "other" }));
});
