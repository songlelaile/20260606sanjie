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
  txInviteUpdateMany: vi.fn(),
  txToolEntitlementCreate: vi.fn()
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
  validateRegistration,
  verifyPassword
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
    },
    toolEntitlement: {
      create: mocks.txToolEntitlementCreate
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
    mocks.txToolEntitlementCreate.mockReset();

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
      id: "user-new",
      username: "13800138000",
      name: "阿壮",
      tenantId: "tenant-new"
    });
    mocks.txToolEntitlementCreate.mockResolvedValue({ id: "entitlement-new" });
    mocks.txInviteFindUnique.mockResolvedValue({
      id: "invite-1", code: "ABCD12", usedCount: 0, maxUses: 1,
      note: "未备注", createdBy: ""
    });
    mocks.txInviteUpdateMany.mockResolvedValue({ count: 1 });
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
    expect(mocks.txToolEntitlementCreate).toHaveBeenCalledExactlyOnceWith({
      data: {
        userId: "user-new",
        toolCode: "registration_source",
        status: "active",
        note: "self",
        grantedBy: "self"
      }
    });
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
      note: "测试店",
      createdBy: "邀请管理员"
    });
    mocks.txInviteUpdateMany.mockResolvedValueOnce({ count: 1 });
    mocks.txTenantCreate.mockResolvedValueOnce({
      id: "tenant-invite",
      name: "测试店",
      slug: "tenant-13900139000-def"
    });
    mocks.txUserCreate.mockResolvedValueOnce({
      id: "user-invite",
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
        where: { id: "invite-1", code: "ABCD12", maxUses: 1, usedCount: { lt: 1 } },
        data: { usedCount: { increment: 1 } }
      })
    );
    expect(mocks.txTenantCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "测试店" })
      })
    );
    expect(mocks.txToolEntitlementCreate.mock.calls.map(([arg]) => arg.data)).toEqual([
      {
        userId: "user-invite",
        toolCode: "registration_source",
        status: "active",
        note: "invite:invite-1",
        grantedBy: "邀请管理员"
      },
      {
        userId: "user-invite",
        toolCode: "creative_studio",
        status: "active",
        expiresAt: null,
        note: "invite:invite-1",
        grantedBy: "邀请管理员"
      }
    ]);
  });

  it.each([
    [{ username: "12800138000" }, "请输入正确的 11 位手机号"],
    [{ username: "138001380001" }, "请输入正确的 11 位手机号"],
    [{ username: "13800138０００" }, "请输入正确的 11 位手机号"],
    [{ password: "12345" }, "密码至少 6 个字符"],
    [{ password: " 12345\u200B " }, "密码至少 6 个字符"],
    [{ password: "a".repeat(129) }, "密码最多 128 个字符"],
    [{ password: `${" ".repeat(257)}secret12` }, "密码最多 128 个字符"],
    [{ password: "secret\u0000" }, "密码不能包含控制字符"],
    [{ name: "名".repeat(51) }, "姓名 / 昵称最多 50 个字符"],
    [{ name: "用户\n管理员" }, "姓名 / 昵称不能包含控制或不可见字符"],
    [{ name: "用户\u200B" }, "姓名 / 昵称不能包含控制或不可见字符"],
    [{ shopName: "店".repeat(101) }, "店铺名称最多 100 个字符"],
    [{ shopName: "店\n铺" }, "店铺名称不能包含控制或不可见字符"],
    [{ inviteCode: "ABC12" }, "邀请码须为 6 到 32 位字母或数字"],
    [{ inviteCode: "A".repeat(33) }, "邀请码须为 6 到 32 位字母或数字"],
    [{ inviteCode: "ABC;12" }, "邀请码须为 6 到 32 位字母或数字"]
  ])("rejects invalid registration fields before querying accounts: %j", async (fields, error) => {
    await expect(validateRegistration({
      username: "13800138000", password: "secret12", name: "阿壮", ...fields
    })).resolves.toBe(error);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    [{ username: 13800138000 }, "手机号和密码必须是文本"],
    [{ password: null }, "手机号和密码必须是文本"],
    [{ name: {} }, "姓名 / 昵称必须是文本"],
    [{ inviteCode: 123456 }, "邀请码必须是文本"],
    [{ shopName: [] }, "店铺名称必须是文本"]
  ])("rejects non-text fields at the account boundary: %j", async (fields, error) => {
    const input = { username: "13800138000", password: "secret12", ...fields };
    await expect(validateRegistration(input as Parameters<typeof validateRegistration>[0]))
      .resolves.toBe(error);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("accepts the password, name and invite length limits", async () => {
    await expect(validateRegistration({
      username: " 13800138000 ", password: "123456", name: "名".repeat(50),
      inviteCode: "a".repeat(32)
    })).resolves.toBeNull();
    await expect(validateRegistration({ username: "13800138000", password: "a".repeat(128) }))
      .resolves.toBeNull();
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { username: "13800138000" } });
  });

  it("validates both creation entry points even when called without the route", async () => {
    const invalid = { username: "bad", password: "secret12", name: "阿壮" };
    await expect(createTenantOperator(invalid))
      .resolves.toEqual({ ok: false, error: "请输入正确的 11 位手机号" });
    await expect(createTenantOperatorByInvite({ ...invalid, inviteCode: "ABCD12" }))
      .resolves.toEqual({ ok: false, error: "请输入正确的 11 位手机号" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("keeps password normalization compatible and falls back to the phone for an empty name", async () => {
    await createTenantOperator({ username: " 13800138000 ", password: " \u200Bsecret12\uFEFF ", name: " " });
    const userData = mocks.txUserCreate.mock.calls[0][0].data;
    expect(userData).toMatchObject({ username: "13800138000", name: "13800138000", shopName: "13800138000" });
    expect(verifyPassword("secret12", userData.password)).toBe(true);
  });

  it("creates only empty tenant-scoped shop state and preserves other tenant data", async () => {
    await createTenantOperator({ username: "13800138000", password: "secret12", name: "阿壮" });
    expect(mocks.txWorkspaceDeleteMany).toHaveBeenCalledExactlyOnceWith({ where: { tenantId: "tenant-new" } });
    expect(mocks.txCalcRunDeleteMany).toHaveBeenCalledExactlyOnceWith({ where: { tenantId: "tenant-new" } });
    expect(mocks.txShopCreate).toHaveBeenCalledExactlyOnceWith({ data: {
      id: "shop-tenant-new", tenantId: "tenant-new", name: "阿壮", platform: "淘宝", createdBy: "阿壮"
    } });
    expect(mocks.txShopCalcRunCreate).toHaveBeenCalledExactlyOnceWith({ data: {
      tenantId: "tenant-new", shopId: "shop-tenant-new", runId: "", cycleId: "", createdAt: "",
      investmentResults: [], breakthroughResults: [], audiencePlans: [],
      managementDashboard: {
        productCount: 0, monthlyNetSales: 0, monthlyProfitEstimate: 0, monthlyGsvOpportunity: 0,
        marketSalesGap: 0, historicalMarginRate: 0, plannedProfit: 0, availableAdBudget: 0,
        plannedMarginRate: 0, topProducts: []
      }
    } });
    expect(mocks.txToolEntitlementCreate.mock.calls.map(([arg]) => arg.data.toolCode))
      .toEqual(["registration_source"]);
  });

  it("allocates distinct tenants and shops to self and invited registrants", async () => {
    let tenantNumber = 0;
    mocks.txTenantCreate.mockImplementation(async () => ({ id: `tenant-${++tenantNumber}` }));
    mocks.txUserCreate.mockImplementation(async ({ data }) => ({ ...data, id: `user-${data.username}` }));
    const self = await createTenantOperator({ username: "13800138000", password: "secret12", name: "自主" });
    const invited = await createTenantOperatorByInvite({
      username: "13900139000", password: "secret12", name: "受邀", inviteCode: "ABCD12"
    });
    expect(self).toMatchObject({ ok: true, account: { tenantId: "tenant-1" } });
    expect(invited).toMatchObject({ ok: true, account: { tenantId: "tenant-2" } });
    expect(mocks.txShopCreate.mock.calls.map(([arg]) => arg.data))
      .toMatchObject([{ id: "shop-tenant-1", tenantId: "tenant-1" }, { id: "shop-tenant-2", tenantId: "tenant-2" }]);
    expect(mocks.txToolEntitlementCreate.mock.calls.map(([arg]) => arg.data.grantedBy))
      .toEqual(["self", "invite", "invite"]);
  });

  it.each(["self", "invite"])("maps a concurrent username P2002 after the %s transaction rejects", async (source) => {
    const conflict = Object.assign(new Error("unique username"), { code: "P2002", meta: { target: ["username"] } });
    mocks.txUserCreate.mockRejectedValueOnce(conflict);
    const input = { username: "13800138000", password: "secret12", name: "阿壮" };
    const result = source === "invite"
      ? await createTenantOperatorByInvite({ ...input, inviteCode: "ABCD12" })
      : await createTenantOperator(input);
    expect(result).toEqual({ ok: false, error: "该手机号已注册" });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.txToolEntitlementCreate).not.toHaveBeenCalled();
  });

  it("returns one account and one duplicate result for simultaneous self-registration of a phone", async () => {
    let usernameTaken = false;
    mocks.txUserCreate.mockImplementation(async ({ data }) => {
      if (usernameTaken) {
        throw Object.assign(new Error("unique username"), { code: "P2002", meta: { target: ["username"] } });
      }
      usernameTaken = true;
      return { ...data, id: "user-winner" };
    });
    const results = await Promise.all(["用户一", "用户二"].map((name) =>
      createTenantOperator({ username: "13800138000", password: "secret12", name })
    ));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, error: "该手机号已注册" }]);
    expect(mocks.txToolEntitlementCreate).toHaveBeenCalledExactlyOnceWith({ data: {
      userId: "user-winner", toolCode: "registration_source", status: "active", note: "self", grantedBy: "self"
    } });
  });

  it("does not misreport unrelated unique constraint failures as an existing phone", async () => {
    const conflict = Object.assign(new Error("unique entitlement"), { code: "P2002", meta: { target: ["userId", "toolCode"] } });
    mocks.txToolEntitlementCreate.mockRejectedValueOnce(conflict);
    await expect(createTenantOperator({ username: "13800138000", password: "secret12", name: "阿壮" }))
      .rejects.toBe(conflict);
  });

  it("retries the entire registration transaction on a transient write conflict", async () => {
    const conflict = Object.assign(new Error("write conflict"), { code: "P2034" });
    mocks.transaction.mockRejectedValueOnce(conflict);
    await expect(createTenantOperator({ username: "13800138000", password: "secret12", name: "阿壮" }))
      .resolves.toMatchObject({ ok: true });
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
  });

  it("bounds transaction conflict retries", async () => {
    const conflict = Object.assign(new Error("write conflict"), { code: "P2034" });
    mocks.transaction.mockRejectedValue(conflict);
    await expect(createTenantOperator({ username: "13800138000", password: "secret12", name: "阿壮" }))
      .rejects.toBe(conflict);
    expect(mocks.transaction).toHaveBeenCalledTimes(3);
  });

  it.each([
    [null, "邀请码无效或已失效"],
    [{ id: "invite-1", usedCount: 1, maxUses: 1 }, "邀请码使用次数已用尽"]
  ])("rejects absent or exhausted invites before creating a tenant", async (invite, error) => {
    mocks.txInviteFindUnique.mockResolvedValueOnce(invite);
    await expect(createTenantOperatorByInvite({
      username: "13800138000", password: "secret12", name: "阿壮", inviteCode: "ABCD12"
    })).resolves.toEqual({ ok: false, error });
    expect(mocks.txInviteUpdateMany).not.toHaveBeenCalled();
    expect(mocks.txTenantCreate).not.toHaveBeenCalled();
    expect(mocks.txToolEntitlementCreate).not.toHaveBeenCalled();
  });

  it.each([
    [null, "邀请码无效或已失效"],
    [{ code: "ABCD12", usedCount: 1, maxUses: 1 }, "邀请码使用次数已用尽"],
    [{ code: "ABCD12", usedCount: 0, maxUses: 0 }, "邀请码使用次数已用尽"],
    [{ code: "ABCD12", usedCount: 0, maxUses: 2 }, "邀请码已更新，请重新提交"],
    [{ code: "OTHER1", usedCount: 0, maxUses: 1 }, "邀请码无效或已失效"]
  ])("rejects an invite revoked, consumed or changed between read and consumption", async (current, error) => {
    mocks.txInviteFindUnique.mockResolvedValueOnce({
      id: "invite-1", code: "ABCD12", usedCount: 0, maxUses: 1, note: "", createdBy: ""
    }).mockResolvedValueOnce(current);
    mocks.txInviteUpdateMany.mockResolvedValueOnce({ count: 0 });
    await expect(createTenantOperatorByInvite({
      username: "13800138000", password: "secret12", name: "阿壮", inviteCode: "ABCD12"
    })).resolves.toEqual({ ok: false, error });
    expect(mocks.txInviteUpdateMany).toHaveBeenCalledWith({
      where: { id: "invite-1", code: "ABCD12", maxUses: 1, usedCount: { lt: 1 } },
      data: { usedCount: { increment: 1 } }
    });
    expect(mocks.txTenantCreate).not.toHaveBeenCalled();
    expect(mocks.txToolEntitlementCreate).not.toHaveBeenCalled();
  });

  it("allows only one contender to consume the final invite use", async () => {
    const invite = { id: "invite-1", code: "ABCD12", usedCount: 0, maxUses: 1, note: "", createdBy: "" };
    mocks.txInviteFindUnique.mockImplementation(async ({ where }) =>
      where.code ? { ...invite, usedCount: 0 } : { ...invite }
    );
    mocks.txInviteUpdateMany.mockImplementation(async ({ where }) => {
      if (invite.maxUses !== where.maxUses || invite.usedCount >= where.usedCount.lt) return { count: 0 };
      invite.usedCount += 1;
      return { count: 1 };
    });
    mocks.txUserCreate.mockImplementation(async ({ data }) => ({ ...data, id: `user-${data.username}` }));
    const results = await Promise.all(["13800138000", "13900139000"].map((username) =>
      createTenantOperatorByInvite({ username, password: "secret12", name: "受邀", inviteCode: "ABCD12" })
    ));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, error: "邀请码使用次数已用尽" }]);
    expect(invite.usedCount).toBe(1);
    expect(mocks.txTenantCreate).toHaveBeenCalledOnce();
    expect(mocks.txToolEntitlementCreate).toHaveBeenCalledTimes(2);
  });

  it.each(["duplicate", "source", "creative"])("rolls back all new records and invite consumption on %s failure", async (failure) => {
    const initial = {
      tenants: ["old-tenant"], users: ["old-user"], shops: ["old-shop"], calcs: ["old-calc"],
      entitlements: [{ userId: "old-user", toolCode: "dmp", status: "active", note: "existing DMP" }],
      usedCount: 0
    };
    let state = structuredClone(initial);
    const error = failure === "duplicate"
      ? Object.assign(new Error("unique username"), { code: "P2002", meta: { target: ["username"] } })
      : new Error("entitlement write failed");
    mocks.transaction.mockImplementation(async (callback: (tx: ReturnType<typeof mockTx>) => unknown) => {
      const before = structuredClone(state);
      try { return await callback(mockTx()); }
      catch (caught) { state = before; throw caught; }
    });
    mocks.txInviteUpdateMany.mockImplementation(async () => { state.usedCount += 1; return { count: 1 }; });
    mocks.txTenantCreate.mockImplementation(async () => { state.tenants.push("tenant-new"); return { id: "tenant-new" }; });
    mocks.txShopCreate.mockImplementation(async () => { state.shops.push("shop-new"); return {}; });
    mocks.txShopCalcRunCreate.mockImplementation(async () => { state.calcs.push("calc-new"); return {}; });
    mocks.txUserCreate.mockImplementation(async ({ data }) => {
      if (failure === "duplicate") throw error;
      state.users.push("user-new");
      return { ...data, id: "user-new" };
    });
    mocks.txToolEntitlementCreate.mockImplementation(async ({ data }) => {
      if (data.toolCode === (failure === "source" ? "registration_source" : "creative_studio")) throw error;
      state.entitlements.push(data);
      return {};
    });
    const register = createTenantOperatorByInvite({
      username: "13800138000", password: "secret12", name: "阿壮", inviteCode: "ABCD12"
    });
    if (failure === "duplicate") await expect(register).resolves.toEqual({ ok: false, error: "该手机号已注册" });
    else await expect(register).rejects.toBe(error);
    expect(state).toEqual(initial);
  });
});
