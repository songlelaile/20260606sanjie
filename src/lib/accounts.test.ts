import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("./db", () => ({
  prisma: {
    user: {
      findUnique: mocks.findUnique
    }
  }
}));

import { isSessionAccountValid } from "./accounts";

describe("isSessionAccountValid", () => {
  beforeEach(() => {
    mocks.findUnique.mockReset();
    mocks.findUnique.mockResolvedValue({
      tenantId: "tenant-a",
      authRole: "tenant",
      status: "active"
    });
  });

  it("accepts an active account whose tenant and role match", async () => {
    await expect(
      isSessionAccountValid({ username: "user-a", tenantId: "tenant-a", role: "tenant" })
    ).resolves.toBe(true);
  });

  it("rejects deleted and disabled accounts", async () => {
    mocks.findUnique.mockResolvedValueOnce(null);
    await expect(
      isSessionAccountValid({ username: "user-a", tenantId: "tenant-a", role: "tenant" })
    ).resolves.toBe(false);

    mocks.findUnique.mockResolvedValueOnce({
      tenantId: "tenant-a",
      authRole: "tenant",
      status: "disabled"
    });
    await expect(
      isSessionAccountValid({ username: "user-a", tenantId: "tenant-a", role: "tenant" })
    ).resolves.toBe(false);
  });

  it("rejects a session after the account moves to another tenant", async () => {
    mocks.findUnique.mockResolvedValueOnce({
      tenantId: "tenant-b",
      authRole: "tenant",
      status: "active"
    });
    await expect(
      isSessionAccountValid({ username: "user-a", tenantId: "tenant-a", role: "tenant" })
    ).resolves.toBe(false);
  });

  it("rejects a session after its login role changes", async () => {
    mocks.findUnique.mockResolvedValueOnce({
      tenantId: "tenant-a",
      authRole: "admin",
      status: "active"
    });
    await expect(
      isSessionAccountValid({ username: "user-a", tenantId: "tenant-a", role: "tenant" })
    ).resolves.toBe(false);
  });
});
