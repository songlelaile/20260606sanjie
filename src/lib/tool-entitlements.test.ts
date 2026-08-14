import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  entitlementFindMany: vi.fn(),
  entitlementUpsert: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    toolEntitlement: {
      findMany: mocks.entitlementFindMany,
      upsert: mocks.entitlementUpsert
    }
  }
}));

import {
  getDmpAutomationAccessForSession,
  resolveToolEntitlementAccess,
  setDmpAutomationEntitlement
} from "./tool-entitlements";

const SESSION = { username: "paid-user", tenantId: "tenant-a", role: "tenant" as const };

describe("DMP paid tool entitlements", () => {
  beforeEach(() => {
    mocks.userFindUnique.mockReset();
    mocks.entitlementFindMany.mockReset();
    mocks.entitlementUpsert.mockReset();
  });

  it("distinguishes active, expired, revoked and missing records", () => {
    const now = new Date("2026-08-15T00:00:00.000Z");
    expect(resolveToolEntitlementAccess(null, now).status).toBe("not_granted");
    expect(
      resolveToolEntitlementAccess(
        { status: "revoked", grantedAt: now, expiresAt: null },
        now
      ).status
    ).toBe("revoked");
    expect(
      resolveToolEntitlementAccess(
        {
          status: "active",
          grantedAt: new Date("2026-08-01T00:00:00.000Z"),
          expiresAt: new Date("2026-08-14T23:59:59.000Z")
        },
        now
      ).status
    ).toBe("expired");
    expect(
      resolveToolEntitlementAccess(
        { status: "active", grantedAt: now, expiresAt: null },
        now
      ).status
    ).toBe("expired");
    expect(
      resolveToolEntitlementAccess(
        {
          status: "active",
          grantedAt: now,
          expiresAt: new Date("2026-09-14T00:00:00.000Z")
        },
        now
      )
    ).toMatchObject({ allowed: true, status: "active", remainingDays: 30 });
  });

  it("requires the signed session to match an enabled database account", async () => {
    mocks.userFindUnique.mockResolvedValueOnce({
      tenantId: "tenant-a",
      authRole: "tenant",
      status: "active",
      toolEntitlements: [
        {
          status: "active",
          grantedAt: new Date(),
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        }
      ]
    });
    await expect(getDmpAutomationAccessForSession(SESSION)).resolves.toMatchObject({
      allowed: true,
      status: "active"
    });

    mocks.userFindUnique.mockResolvedValueOnce({
      tenantId: "tenant-b",
      authRole: "tenant",
      status: "active",
      toolEntitlements: [
        {
          status: "active",
          grantedAt: new Date(),
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        }
      ]
    });
    await expect(getDmpAutomationAccessForSession(SESSION)).resolves.toMatchObject({
      allowed: false,
      status: "not_granted"
    });
  });

  it("upserts a durable per-user grant and preserves revocations", async () => {
    mocks.userFindUnique.mockResolvedValueOnce({ id: "user-1" });
    mocks.entitlementUpsert.mockImplementationOnce(async (args) => ({
      status: args.create.status,
      grantedAt: args.create.grantedAt,
      expiresAt: args.create.expiresAt
    }));
    const result = await setDmpAutomationEntitlement({
      userId: "user-1",
      enabled: true,
      grantedBy: "admin"
    });
    expect(result).toMatchObject({
      ok: true,
      access: { allowed: true, status: "active", remainingDays: 30 }
    });
    expect(mocks.entitlementUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_toolCode: { userId: "user-1", toolCode: "dmp-automation" } }
      })
    );
    const call = mocks.entitlementUpsert.mock.calls[0][0];
    expect(call.create.expiresAt.getTime() - call.create.grantedAt.getTime()).toBe(
      30 * 24 * 60 * 60 * 1000
    );
    expect(call.update.expiresAt).toEqual(call.create.expiresAt);
  });
});
