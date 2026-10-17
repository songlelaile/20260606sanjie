import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  transaction: vi.fn(),
  txUserFindUnique: vi.fn(),
  txTenantCreate: vi.fn(),
  txWorkspaceDeleteMany: vi.fn(),
  txCalcRunDeleteMany: vi.fn(),
  txShopCreate: vi.fn(),
  txShopCalcRunCreate: vi.fn(),
  txUserCreate: vi.fn(),
  txInviteFindUnique: vi.fn(),
  txInviteUpdateMany: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("./db", () => ({
  prisma: {
    user: {
      findUnique: mocks.findUnique
    },
    $transaction: mocks.transaction
  }
}));

import {
  createTenantOperator,
  createTenantOperatorByInvite,
  isSessionAccountValid,
  validateRegistration
} from "./accounts";

function mockTx() {
  return {
    user: {
      findUnique: mocks.txUserFindUnique,
      create: mocks.txUserCreate
    },
    tenant: {
      create: mocks.txTenantCreate
    },
    workspace: {
      deleteMany: mocks.txWorkspaceDeleteMany
    },
    calcRun: {
      deleteMany: mocks.txCalcRunDeleteMany
    },
    shop: {
      create: mocks.txShopCreate
    },
    shopCalcRun: {
      create: mocks.txShopCalcRunCreate
    },
    inviteCode: {
      findUnique: mocks.txInviteFindUnique,
      updateMany: mocks.txInviteUpdateMany
    }
  };
}

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

describe("self-service and invite registration", () => {
  beforeEach(() => {
    mocks.findUnique.mockReset();
    mocks.transaction.mockReset();
    mocks.txUserFindUnique.mockReset();
    mocks.txTenantCreate.mockReset();
    mocks.txWorkspaceDeleteMany.mockReset();
    mocks.txCalcRunDeleteMany.mockReset();
    mocks.txShopCreate.mockReset();
    mocks.txShopCalcRunCreate.mockReset();
    mocks.txUserCreate.mockReset();
    mocks.txInviteFindUnique.mockReset();
    mocks.txInviteUpdateMany.mockReset();

    mocks.transaction.mockImplementation(async (callback: (tx: ReturnType<typeof mockTx>) => unknown) =>
      callback(mockTx())
    );
    mocks.txUserFindUnique.mockResolvedValue(null);
    mocks.txTenantCreate.mockResolvedValue({ id: "tenant-new", name: "阿壮", slug: "tenant-13800138000-abc" });
    mocks.txWorkspaceDeleteMany.mockResolvedValue({ count: 0 });
    mocks.txCalcRunDeleteMany.mockResolvedValue({ count: 0 });
    mocks.txShopCreate.mockResolvedValue({ id: "shop-tenant-new" });
    mocks.txShopCalcRunCreate.mockResolvedValue({ id: "calc-1" });
    mocks.txUserCreate.mockResolvedValue({
      username: "13800138000",
      name: "阿壮",
      tenantId: "tenant-new"
    });
  });

  it("creates an independent tenant without an invite code", async () => {
    const result = await createTenantOperator({
      username: "13800138000",
      password: "secret12",
      name: "阿壮"
    });

    expect(result).toEqual({
      ok: true,
      account: {
        username: "13800138000",
        name: "阿壮",
        role: "tenant",
        tenantId: "tenant-new"
      }
    });
    expect(mocks.txInviteFindUnique).not.toHaveBeenCalled();
    expect(mocks.txTenantCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "阿壮" })
      })
    );
    expect(mocks.txUserCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          username: "13800138000",
          name: "阿壮",
          authRole: "tenant",
          role: "operator",
          tenantId: "tenant-new"
        })
      })
    );
    const createdPassword = mocks.txUserCreate.mock.calls[0][0].data.password as string;
    expect(createdPassword.startsWith("scrypt$")).toBe(true);
    expect(createdPassword).not.toContain("secret12");
  });

  it("rejects duplicate username on self-registration", async () => {
    mocks.txUserFindUnique.mockResolvedValueOnce({ id: "existing", username: "13800138000" });

    await expect(
      createTenantOperator({
        username: "13800138000",
        password: "secret12",
        name: "阿壮"
      })
    ).resolves.toEqual({ ok: false, error: "该手机号已注册" });

    expect(mocks.txTenantCreate).not.toHaveBeenCalled();
    expect(mocks.txUserCreate).not.toHaveBeenCalled();
  });

  it("rejects duplicate username during field validation", async () => {
    mocks.findUnique.mockResolvedValueOnce({ id: "existing", username: "13800138000" });
    await expect(
      validateRegistration({ username: "13800138000", password: "secret12" })
    ).resolves.toBe("该手机号已注册");
  });

  it("still registers with a valid invite code", async () => {
    mocks.txInviteFindUnique.mockResolvedValueOnce({
      id: "invite-1",
      code: "ABCD12",
      usedCount: 0,
      maxUses: 1,
      note: "测试店"
    });
    mocks.txInviteUpdateMany.mockResolvedValueOnce({ count: 1 });
    mocks.txTenantCreate.mockResolvedValueOnce({
      id: "tenant-invite",
      name: "测试店",
      slug: "tenant-13900139000-def"
    });
    mocks.txUserCreate.mockResolvedValueOnce({
      username: "13900139000",
      name: "邀请用户",
      tenantId: "tenant-invite"
    });

    const result = await createTenantOperatorByInvite({
      username: "13900139000",
      password: "secret12",
      name: "邀请用户",
      inviteCode: "abcd12"
    });

    expect(result).toEqual({
      ok: true,
      account: {
        username: "13900139000",
        name: "邀请用户",
        role: "tenant",
        tenantId: "tenant-invite"
      }
    });
    expect(mocks.txInviteUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "invite-1", usedCount: { lt: 1 } },
        data: { usedCount: { increment: 1 } }
      })
    );
    expect(mocks.txTenantCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "测试店" })
      })
    );
  });
});
