import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { Session } from "@/lib/auth";
import { createPaymentUatDatabase } from "../../../scripts/payment-uat-db.mjs";

const isolated = vi.hoisted(() => ({
  prisma: null as PrismaClient | null,
  session: null as Session | null
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ get prisma() { return isolated.prisma; } }));
vi.mock("@/lib/session-server", () => ({ getServerSession: async () => isolated.session }));

/** Opt-in PostgreSQL tests use a fresh local-only schema, never the application's namespace. */
describe.skipIf(process.env.REGISTRATION_MANAGEMENT_INTEGRATION !== "1")("real PostgreSQL registration and management UAT", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let accounts: typeof import("@/lib/accounts");
  let users: typeof import("./user-store");
  let admin: Session;
  let adminId: string;
  let legacyId: string;
  let legacyTenantId: string;
  const legacyShopId = "registration-uat-legacy-shop";

  function db() {
    if (!isolated.prisma) throw new Error("隔离注册管理 UAT 未初始化");
    return isolated.prisma;
  }

  async function counts() {
    const [tenants, userCount, shops, calculations, entitlements] = await Promise.all([
      db().tenant.count(), db().user.count(), db().shop.count(),
      db().shopCalcRun.count(), db().toolEntitlement.count()
    ]);
    return { tenants, users: userCount, shops, calculations, entitlements };
  }

  async function preservedLegacyData() {
    const [workspace, shopWorkspace, calculation, shopCalculation, report, grants, tenant, shop] = await Promise.all([
      db().workspace.findUnique({ where: { tenantId: legacyTenantId } }),
      db().shopWorkspace.findUnique({ where: { shopId: legacyShopId } }),
      db().calcRun.findUnique({ where: { tenantId: legacyTenantId } }),
      db().shopCalcRun.findUnique({ where: { shopId: legacyShopId } }),
      db().dmpBusinessReport.findMany({ where: { userId: legacyId }, orderBy: { id: "asc" } }),
      db().toolEntitlement.findMany({ where: { userId: legacyId }, orderBy: { id: "asc" } }),
      db().tenant.findUnique({ where: { id: legacyTenantId } }),
      db().shop.findUnique({ where: { id: legacyShopId } })
    ]);
    return { workspace, shopWorkspace, calculation, shopCalculation, report, grants, tenant, shop };
  }

  beforeAll(async () => {
    // The helper rejects remote hosts and only creates/drops its new payment_uat_* schema.
    // Catch setup errors without exposing connection strings or Prisma subprocess output.
    try {
      const namespace = await createPaymentUatDatabase();
      cleanup = namespace.cleanup;
      isolated.prisma = new PrismaClient({ datasources: { db: { url: namespace.url } }, log: [] });
      accounts = await import("@/lib/accounts");
      users = await import("./user-store");

      const adminTenant = await db().tenant.create({ data: { name: "注册 UAT 管理", slug: "registration-uat-admin" } });
      const adminRow = await db().user.create({ data: {
        tenantId: adminTenant.id, username: "registration-uat-admin", password: accounts.hashPassword("admin-uat-secret"),
        name: "UAT 管理员", authRole: "admin", role: "admin"
      } });
      adminId = adminRow.id;
      admin = { username: adminRow.username, name: adminRow.name, tenantId: adminTenant.id, role: "admin" };
      isolated.session = admin;

      const legacyTenant = await db().tenant.create({ data: { name: "保留旧租户", slug: "registration-uat-legacy" } });
      legacyTenantId = legacyTenant.id;
      const legacy = await db().user.create({ data: {
        tenantId: legacyTenant.id, username: "13900000000", password: accounts.hashPassword("legacy-uat-secret"),
        name: "旧账号", authRole: "tenant", role: "operator", shopName: "旧店铺"
      } });
      legacyId = legacy.id;
      await db().shop.create({ data: { id: legacyShopId, tenantId: legacyTenantId, name: "旧店铺", createdBy: "旧账号" } });
      const existingConfig = { history: [{ id: "original-history", amount: 2500 }], profitConfig: { marginRate: 0.33 }, products: ["old-product"] };
      await db().workspace.create({ data: { tenantId: legacyTenantId, data: existingConfig } });
      await db().shopWorkspace.create({ data: { tenantId: legacyTenantId, shopId: legacyShopId, data: existingConfig } });
      await db().calcRun.create({ data: { tenantId: legacyTenantId, runId: "legacy-run", cycleId: "legacy-cycle", investmentResults: [{ old: true }] } });
      await db().shopCalcRun.create({ data: { tenantId: legacyTenantId, shopId: legacyShopId, runId: "legacy-shop-run", investmentResults: [{ old: true }] } });
      await db().dmpBusinessReport.create({ data: {
        tenantId: legacyTenantId, userId: legacyId, shopId: legacyShopId,
        subjectItemId: "100001", competitorItemId: "100002", fingerprint: "old-dmp-report", report: { preserved: true }
      } });
      await db().toolEntitlement.create({ data: {
        userId: legacyId, toolCode: "dmp-automation", status: "active", note: "existing DMP authorization", grantedBy: "original-admin",
        expiresAt: new Date(Date.now() + 30 * 86_400_000)
      } });
    } catch {
      throw new Error("本地隔离注册管理 UAT 初始化失败；未操作原有业务命名空间");
    }
  }, 60_000);

  beforeEach(() => { isolated.session = admin; });

  afterAll(async () => {
    isolated.session = null;
    try { await isolated.prisma?.$disconnect(); }
    finally { isolated.prisma = null; await cleanup?.(); }
  }, 30_000);

  it("creates blank independent workspaces, records real sources and keeps self accounts payment-gated", async () => {
    const preserved = await preservedLegacyData();
    const self = await accounts.createTenantOperator({ username: "13830000001", password: "secret12", name: "自主注册" });
    const invite = await users.createInviteCode({ note: "受邀默认店", maxUses: 2 });
    const invited = await accounts.createTenantOperatorByInvite({
      username: "13830000002", password: "secret12", name: "受邀注册", inviteCode: invite.code.toLowerCase()
    });
    expect(self.ok).toBe(true);
    expect(invited.ok).toBe(true);
    if (!self.ok || !invited.ok) throw new Error("隔离 UAT 注册未成功");
    expect(self.account.tenantId).not.toBe(invited.account.tenantId);
    expect(self.account.tenantId).not.toBe(admin.tenantId);
    expect(invited.account.tenantId).not.toBe(invite.tenantId);

    for (const account of [self.account, invited.account]) {
      const shop = await db().shop.findUniqueOrThrow({ where: { id: `shop-${account.tenantId}` } });
      const calc = await db().shopCalcRun.findUniqueOrThrow({ where: { shopId: shop.id } });
      expect(shop.tenantId).toBe(account.tenantId);
      expect(calc).toMatchObject({ tenantId: account.tenantId, runId: "", cycleId: "", createdAt: "", investmentResults: [], breakthroughResults: [], audiencePlans: [] });
      expect(calc.managementDashboard).toMatchObject({ productCount: 0, monthlyNetSales: 0, monthlyProfitEstimate: 0, topProducts: [] });
      expect(await db().workspace.count({ where: { tenantId: account.tenantId } })).toBe(0);
      expect(await db().shopWorkspace.count({ where: { tenantId: account.tenantId } })).toBe(0);
    }

    const managed = await users.getManagedUsers();
    const selfRow = managed.find((row) => row.username === self.account.username)!;
    const invitedRow = managed.find((row) => row.username === invited.account.username)!;
    expect(selfRow).toMatchObject({ registrationSource: "self", inviteCodeId: null, registeredBy: "self", creativeStudioAccess: { allowed: false }, creativeAccess: { allowed: false, reason: "payment_required" } });
    expect(invitedRow).toMatchObject({ registrationSource: "invite", inviteCodeId: invite.id, registeredBy: admin.name, creativeStudioAccess: { allowed: true, expiresAt: null }, creativeAccess: { allowed: true, reason: "invited" } });
    expect(selfRow.registrationSourceRecordedAt).not.toBeNull();
    expect(invitedRow.registrationSourceRecordedAt).not.toBeNull();
    expect(managed.find((row) => row.id === legacyId)).toMatchObject({ registrationSource: "legacy", registeredBy: null, dmpAutomationAccess: { allowed: true } });
    expect(await db().toolEntitlement.count({ where: { userId: selfRow.id, toolCode: "creative_studio" } })).toBe(0);
    expect(await db().toolEntitlement.count({ where: { userId: { in: [selfRow.id, invitedRow.id] }, toolCode: "dmp-automation" } })).toBe(0);
    expect(await preservedLegacyData()).toEqual(preserved);

    isolated.session = self.account;
    expect((await users.getManagedUsers()).map((row) => row.id)).toEqual([selfRow.id]);
    await expect(users.getInviteCodes()).rejects.toMatchObject({ status: 403 });
    await expect(users.setManagedUserStatus(invitedRow.id, "disabled")).resolves.toMatchObject({ ok: false, status: 403 });
    await expect(users.resetManagedUserPassword(invitedRow.id)).resolves.toMatchObject({ ok: false, status: 403 });
    expect((await db().user.findUniqueOrThrow({ where: { id: invitedRow.id } })).status).toBe("active");
    isolated.session = { ...self.account, tenantId: invited.account.tenantId };
    await expect(users.getManagedUsers()).rejects.toMatchObject({ status: 403 });
    isolated.session = { ...self.account, role: "admin" };
    await expect(users.getManagedUsers()).rejects.toMatchObject({ status: 403 });
  });

  it("commits one same-phone concurrent registration without orphan tenants or shops", async () => {
    const before = await counts();
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => accounts.createTenantOperator({
      username: "13810000001", password: "secret12", name: `并发自主 ${index}`
    })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual(Array.from({ length: 11 }, () => ({ ok: false, error: "该手机号已注册" })));
    expect(await counts()).toEqual({ tenants: before.tenants + 1, users: before.users + 1, shops: before.shops + 1, calculations: before.calculations + 1, entitlements: before.entitlements + 1 });
    expect(await db().tenant.count({ where: { users: { none: {} } } })).toBe(0);
    expect(await db().tenant.count({ where: { slug: { startsWith: "tenant-13810000001-" } } })).toBe(1);
  }, 30_000);

  it("lets only one of twelve callers consume the final invite use", async () => {
    const invite = await users.createInviteCode({ note: "并发末次邀请", maxUses: 1 });
    const before = await counts();
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => accounts.createTenantOperatorByInvite({
      username: `138200000${String(index).padStart(2, "0")}`, password: "secret12", name: `并发受邀 ${index}`, inviteCode: invite.code
    })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual(Array.from({ length: 11 }, () => ({ ok: false, error: "邀请码使用次数已用尽" })));
    expect((await db().inviteCode.findUniqueOrThrow({ where: { id: invite.id } })).usedCount).toBe(1);
    expect(await counts()).toEqual({ tenants: before.tenants + 1, users: before.users + 1, shops: before.shops + 1, calculations: before.calculations + 1, entitlements: before.entitlements + 2 });
    expect(await db().tenant.count({ where: { users: { none: {} } } })).toBe(0);
  }, 30_000);

  it("rolls back invite, tenant, user, source and default shop when a database constraint rejects creative access", async () => {
    const invite = await users.createInviteCode({ note: "权限回滚验证", maxUses: 2 });
    const before = await counts();
    const preserved = await preservedLegacyData();
    // Prisma's connection points only to the new disposable schema created above.
    await db().$executeRawUnsafe('ALTER TABLE "ToolEntitlement" ADD CONSTRAINT "uat_registration_reject_creative" CHECK ("toolCode" <> \'creative_studio\') NOT VALID');
    try {
      await expect(accounts.createTenantOperatorByInvite({ username: "13850000001", password: "secret12", name: "应回滚", inviteCode: invite.code })).rejects.toBeTruthy();
      expect(await counts()).toEqual(before);
      expect((await db().inviteCode.findUniqueOrThrow({ where: { id: invite.id } })).usedCount).toBe(0);
      expect(await db().user.findUnique({ where: { username: "13850000001" } })).toBeNull();
      expect(await db().tenant.count({ where: { slug: { startsWith: "tenant-13850000001-" } } })).toBe(0);
      expect(await db().toolEntitlement.count({ where: { note: `invite:${invite.id}` } })).toBe(0);
      expect(await preservedLegacyData()).toEqual(preserved);
    } finally {
      await db().$executeRawUnsafe('ALTER TABLE "ToolEntitlement" DROP CONSTRAINT "uat_registration_reject_creative"');
    }
  });

  it("does not consume a valid invite for an existing phone", async () => {
    const invite = await users.createInviteCode({ note: "重复账号不消耗", maxUses: 2 });
    const before = await counts();
    await expect(accounts.createTenantOperatorByInvite({ username: "13900000000", password: "secret12", name: "重复旧账号", inviteCode: invite.code }))
      .resolves.toEqual({ ok: false, error: "该手机号已注册" });
    expect((await db().inviteCode.findUniqueOrThrow({ where: { id: invite.id } })).usedCount).toBe(0);
    expect(await counts()).toEqual(before);
  });

  it("disables, re-enables and resets an old account while preserving DMP grants, configurations and history", async () => {
    const preserved = await preservedLegacyData();
    const session: Session = { username: "13900000000", name: "旧账号", role: "tenant", tenantId: legacyTenantId };
    await expect(users.setManagedUserStatus(legacyId, "disabled")).resolves.toEqual({ ok: true });
    await expect(accounts.isSessionAccountValid(session)).resolves.toBe(false);
    await expect(accounts.findAccount(session.username, "legacy-uat-secret")).resolves.toBe("disabled");
    await expect(users.setManagedUserStatus(legacyId, "active")).resolves.toEqual({ ok: true });
    await expect(accounts.isSessionAccountValid(session)).resolves.toBe(true);
    const reset = await users.resetManagedUserPassword(legacyId);
    expect(reset.ok).toBe(true);
    if (!reset.ok) throw new Error("隔离 UAT 密码重置未成功");
    const row = await db().user.findUniqueOrThrow({ where: { id: legacyId } });
    expect(reset.password).toHaveLength(10);
    expect(row.password).not.toBe(reset.password);
    expect(accounts.verifyPassword(reset.password, row.password)).toBe(true);
    await expect(accounts.findAccount(session.username, "legacy-uat-secret")).resolves.toBeNull();
    await expect(accounts.findAccount(session.username, reset.password)).resolves.toMatchObject({ tenantId: legacyTenantId, role: "tenant" });
    expect(await preservedLegacyData()).toEqual(preserved);
    expect((await users.getManagedUsers()).find((user) => user.id === legacyId)).toMatchObject({ registrationSource: "legacy", dmpAutomationAccess: { allowed: true } });
    await expect(users.setManagedUserStatus(adminId, "disabled")).resolves.toMatchObject({ ok: false, status: 400 });
    expect((await db().user.findUniqueOrThrow({ where: { id: adminId } })).status).toBe("active");
  });

  it("revokes future invite registration while retaining the existing source and creative grant", async () => {
    const invite = await users.createInviteCode({ note: "撤销保留已注册授权", maxUses: 2 });
    const registered = await accounts.createTenantOperatorByInvite({ username: "13840000001", password: "secret12", name: "已受邀", inviteCode: invite.code });
    expect(registered.ok).toBe(true);
    const row = await db().user.findUniqueOrThrow({ where: { username: "13840000001" } });
    const grants = await db().toolEntitlement.findMany({ where: { userId: row.id }, orderBy: { toolCode: "asc" } });
    await expect(users.deleteInviteCode(invite.id)).resolves.toBe(true);
    expect(await db().inviteCode.findUnique({ where: { id: invite.id } })).toBeNull();
    expect(await db().toolEntitlement.findMany({ where: { userId: row.id }, orderBy: { toolCode: "asc" } })).toEqual(grants);
    expect((await users.getManagedUsers()).find((user) => user.id === row.id)).toMatchObject({ registrationSource: "invite", inviteCodeId: invite.id, creativeAccess: { allowed: true, reason: "invited" } });
    const before = await counts();
    await expect(accounts.createTenantOperatorByInvite({ username: "13840000002", password: "secret12", name: "撤销后新注册", inviteCode: invite.code }))
      .resolves.toEqual({ ok: false, error: "邀请码无效或已失效" });
    expect(await counts()).toEqual(before);
  });

  it("keeps registration and invite-revocation races consistent without partial workspaces", async () => {
    for (let index = 0; index < 6; index += 1) {
      const invite = await users.createInviteCode({ note: `撤销竞争 ${index}`, maxUses: 1 });
      const username = `1386000000${index}`;
      const before = await counts();
      const register = () => accounts.createTenantOperatorByInvite({ username, password: "secret12", name: "撤销竞争", inviteCode: invite.code });
      const revoke = () => users.deleteInviteCode(invite.id);
      const [registered, revoked] = index % 2 === 0
        ? await Promise.all([register(), revoke()])
        : await Promise.all([revoke(), register()]).then(([deleted, result]) => [result, deleted] as const);
      expect(revoked).toBe(true);
      expect(await db().inviteCode.findUnique({ where: { id: invite.id } })).toBeNull();
      if (registered.ok) {
        const user = await db().user.findUniqueOrThrow({ where: { username } });
        expect(await db().toolEntitlement.count({ where: { userId: user.id, note: `invite:${invite.id}` } })).toBe(2);
        expect(await counts()).toEqual({ tenants: before.tenants + 1, users: before.users + 1, shops: before.shops + 1, calculations: before.calculations + 1, entitlements: before.entitlements + 2 });
      } else {
        expect(registered.error).toBe("邀请码无效或已失效");
        expect(await db().user.findUnique({ where: { username } })).toBeNull();
        expect(await counts()).toEqual(before);
      }
      expect(await db().tenant.count({ where: { users: { none: {} } } })).toBe(0);
    }
  }, 30_000);
});
