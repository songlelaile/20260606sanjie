import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), user: vi.fn(), users: vi.fn(), transaction: vi.fn(), target: vi.fn(),
  update: vi.fn(), remove: vi.fn(), invites: vi.fn(), createInvite: vi.fn(), revokeInvite: vi.fn(),
  txInvite: vi.fn(), txConsume: vi.fn(), dmp: vi.fn(), hash: vi.fn()
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-server", () => ({ getServerSession: mocks.session }));
vi.mock("@/lib/accounts", () => ({ hashPassword: mocks.hash }));
vi.mock("@/lib/db", () => ({ prisma: {
  user: { findUnique: mocks.user, findMany: mocks.users },
  inviteCode: { findMany: mocks.invites, create: mocks.createInvite, deleteMany: mocks.revokeInvite },
  $transaction: mocks.transaction
} }));
vi.mock("@/lib/tool-entitlements", () => ({
  getDmpAutomationAccessForUserIds: mocks.dmp,
  NO_DMP_AUTOMATION_ACCESS: { allowed: false, status: "not_granted", grantedAt: null, expiresAt: null, remainingDays: 0 }
}));
import {
  getManagedUsers, getInviteCodes, createInviteCode, deleteInviteCode, consumeInviteCode,
  setManagedUserStatus, resetManagedUserPassword, deleteManagedUser, UserManagementInputError,
  UserManagementAccessError
} from "./user-store";

const date = new Date("2026-10-01T00:00:00Z");
const admin = { username: "admin", name: "管理", tenantId: "tenant-admin", role: "admin" };
function member(id: string, records: Array<{ toolCode: string; note?: string; status?: string; grantedBy?: string; expiresAt?: Date | null }> = []) {
  return {
    id, tenantId: `tenant-${id}`, name: id, username: id, email: "", authRole: "tenant", role: "operator",
    shopName: id, status: "active", createdAt: date, lastActiveAt: date,
    gatewayOrders: [],
    toolEntitlements: records.map((r) => ({ status: "active", note: "", grantedBy: "admin", grantedAt: date, expiresAt: null, ...r }))
  };
}
function invite() {
  return { id: "invite-1", tenantId: "tenant-admin", code: "ABCD234567", registrationUrl: "/login?invite=ABCD234567", usedCount: 0, maxUses: 1, note: "测试", createdBy: "管理", createdAt: date };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue(admin);
  mocks.user.mockResolvedValue({ id: "admin-id", username: "admin", tenantId: "tenant-admin", authRole: "admin", status: "active" });
  mocks.target.mockResolvedValue({ id: "user-1", tenantId: "tenant-1", username: "13800138000", authRole: "tenant" });
  mocks.users.mockResolvedValue([]);
  mocks.dmp.mockResolvedValue(new Map());
  mocks.update.mockResolvedValue({ count: 1 });
  mocks.remove.mockResolvedValue({ count: 1 });
  mocks.invites.mockResolvedValue([]);
  mocks.createInvite.mockImplementation(async ({ data }) => ({ id: "invite-new", createdAt: date, ...data }));
  mocks.revokeInvite.mockResolvedValue({ count: 1 });
  mocks.txInvite.mockResolvedValue(invite());
  mocks.txConsume.mockResolvedValue({ count: 1 });
  mocks.hash.mockImplementation((password) => `hashed:${password}`);
  mocks.transaction.mockImplementation(async (callback) => callback({
    user: { findUnique: mocks.target, updateMany: mocks.update, deleteMany: mocks.remove },
    inviteCode: { findUnique: mocks.txInvite, updateMany: mocks.txConsume }
  }));
});

describe("registration management source and access", () => {
  it("separates source from creative and existing DMP grants without exposing passwords", async () => {
    const preservedDmp = { allowed: true, status: "active", grantedAt: date.toISOString(), expiresAt: "2026-10-31T00:00:00.000Z", remainingDays: 30 };
    mocks.dmp.mockResolvedValue(new Map([["invited", preservedDmp]]));
    mocks.users.mockResolvedValue([
      member("self", [{ toolCode: "registration_source", note: "self", grantedBy: "self" }]),
      member("invited", [{ toolCode: "registration_source", note: "invite:invite-1" }, { toolCode: "creative_studio" }]),
      member("legacy", [{ toolCode: "creative_studio" }]),
      member("invalid", [{ toolCode: "registration_source", note: "invite:" }]),
      member("revoked-source", [{ toolCode: "registration_source", note: "self", status: "revoked" }])
    ]);
    const users = await getManagedUsers();
    expect(users.map((u) => u.registrationSource)).toEqual(["self", "invite", "legacy", "legacy", "legacy"]);
    expect(users[0].creativeStudioAccess.allowed).toBe(false);
    expect(users[1]).toMatchObject({ inviteCodeId: "invite-1", registeredBy: "admin", registrationSourceRecordedAt: date.toISOString(), dmpAutomationAccess: preservedDmp });
    expect(users[1].creativeStudioAccess).toMatchObject({ allowed: true, expiresAt: null });
    expect(users[2]).toMatchObject({ registrationSource: "legacy", inviteCodeId: null, registeredBy: null });
    expect(users.every((u) => !("password" in u))).toBe(true);
    expect(mocks.users.mock.calls[0][0].select.password).toBeUndefined();
  });

  it("reports revoked and expired creative access while preserving source", async () => {
    mocks.users.mockResolvedValue([
      member("revoked", [{ toolCode: "registration_source", note: "invite:invite-1" }, { toolCode: "creative_studio", status: "revoked" }]),
      member("expired", [{ toolCode: "creative_studio", expiresAt: new Date(0) }])
    ]);
    const users = await getManagedUsers();
    expect(users[0]).toMatchObject({ registrationSource: "invite", creativeStudioAccess: { allowed: false, status: "revoked" } });
    expect(users[1].creativeStudioAccess).toMatchObject({ allowed: false, status: "expired" });
  });

  it("reports actual paid access without inferring an invitation or changing registration source", async () => {
    const paid = member("paid", [{ toolCode: "registration_source", note: "self" }]);
    const expired = member("expired-paid");
    const disabled = member("disabled-paid");
    disabled.status = "disabled";
    mocks.users.mockResolvedValue([
      { ...paid, gatewayOrders: [{ paidAt: new Date() }] },
      { ...expired, gatewayOrders: [{ paidAt: new Date(0) }] },
      { ...disabled, gatewayOrders: [{ paidAt: new Date() }] }
    ]);
    const users = await getManagedUsers();
    expect(users[0]).toMatchObject({ registrationSource: "self", creativeStudioAccess: { allowed: false }, creativeAccess: { allowed: true, reason: "paid" } });
    expect(users[1]).toMatchObject({ registrationSource: "legacy", creativeAccess: { allowed: false, reason: "expired" } });
    expect(users[2].creativeAccess).toMatchObject({ allowed: false, reason: "invalid_account" });
    const orderQuery = mocks.users.mock.calls[0][0].select.gatewayOrders;
    expect(orderQuery).toMatchObject({ where: { status: "paid", paidAt: { not: null }, amountCents: { gt: 0 } }, orderBy: { paidAt: "desc" }, take: 1 });
  });

  it("limits tenant readers to their own workspace and rejects moved or disabled accounts", async () => {
    mocks.session.mockResolvedValue({ ...admin, role: "tenant", tenantId: "tenant-a" });
    mocks.user.mockResolvedValue({ id: "actor", username: "admin", tenantId: "tenant-a", authRole: "tenant", status: "active" });
    await getManagedUsers();
    expect(mocks.users).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-a" } }));
    mocks.user.mockResolvedValueOnce({ id: "actor", tenantId: "tenant-other", authRole: "tenant", status: "active" });
    await expect(getManagedUsers()).rejects.toBeInstanceOf(UserManagementAccessError);
    mocks.user.mockResolvedValueOnce({ id: "actor", tenantId: "tenant-a", authRole: "tenant", status: "disabled" });
    await expect(getManagedUsers()).rejects.toBeInstanceOf(UserManagementAccessError);
    expect(mocks.users).toHaveBeenCalledTimes(1);
  });
});

describe("managed account actions", () => {
  it("changes only status and preserves configuration, history and grants", async () => {
    await expect(setManagedUserStatus("user-1", "disabled")).resolves.toEqual({ ok: true });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "user-1", tenantId: "tenant-1", username: { equals: "13800138000", not: "admin" }, authRole: { not: "admin" } },
      data: { status: "disabled" }
    });
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.dmp).not.toHaveBeenCalled();
    await expect(setManagedUserStatus("user-1", "active")).resolves.toEqual({ ok: true });
    expect(mocks.update.mock.calls[1][0].data).toEqual({ status: "active" });
  });

  it.each([setManagedUserStatus.bind(null, "user-1", "disabled"), resetManagedUserPassword.bind(null, "user-1"), deleteManagedUser.bind(null, "user-1")])("rejects non-admins before target mutation", async (action) => {
    mocks.session.mockResolvedValue({ ...admin, role: "tenant" });
    mocks.user.mockResolvedValue({ id: "actor", username: "admin", tenantId: "tenant-admin", authRole: "tenant", status: "active" });
    expect(await action()).toMatchObject({ ok: false, status: 403 });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("protects current/admin/missing accounts and detects a concurrent role or tenant change", async () => {
    mocks.target.mockResolvedValueOnce({ id: "admin-id", username: "admin", tenantId: "tenant-admin", authRole: "admin" });
    expect(await setManagedUserStatus("admin-id", "disabled")).toMatchObject({ ok: false, status: 400 });
    mocks.target.mockResolvedValueOnce({ id: "other-admin", username: "other", tenantId: "other", authRole: "admin" });
    expect(await resetManagedUserPassword("other-admin")).toMatchObject({ ok: false, status: 403 });
    mocks.target.mockResolvedValueOnce(null);
    expect(await deleteManagedUser("missing")).toMatchObject({ ok: false, status: 404 });
    expect(mocks.update).not.toHaveBeenCalled();
    mocks.update.mockResolvedValueOnce({ count: 0 });
    expect(await resetManagedUserPassword("user-1")).toMatchObject({ ok: false, status: 409 });
  });

  it("returns a new temporary password only after a successful hash write", async () => {
    const result = await resetManagedUserPassword("user-1");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.password).toMatch(/^[A-HJ-KM-NP-Za-hj-km-np-z2-9]{10}$/);
    expect(mocks.update.mock.calls[0][0].data).toEqual({ password: `hashed:${result.password}` });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("rejects invalid identifiers and status values before any database mutation", async () => {
    expect(await setManagedUserStatus("../user", "disabled")).toMatchObject({ ok: false, status: 400 });
    expect(await setManagedUserStatus("user-1", "invalid" as never)).toMatchObject({ ok: false, status: 400 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe("invite lifecycle and isolation", () => {
  it("scopes reads and revocation to the admin's tenant", async () => {
    await getInviteCodes();
    await deleteInviteCode("invite-1");
    expect(mocks.invites).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-admin" } }));
    expect(mocks.revokeInvite).toHaveBeenCalledWith({ where: { id: "invite-1", tenantId: "tenant-admin" } });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([{ note: "x".repeat(201), maxUses: 1 }, { note: " ".repeat(201), maxUses: 1 }, { note: "", maxUses: 0 }, { note: "", maxUses: 100 }, { note: "", maxUses: 1.5 }, { note: 1, maxUses: 1 }, { note: "", maxUses: "1" }])("rejects invalid invite input %j", async (input) => {
    await expect(createInviteCode(input as never)).rejects.toBeInstanceOf(UserManagementInputError);
    expect(mocks.createInvite).not.toHaveBeenCalled();
  });

  it("creates a cryptographic code and retries a concurrent unique-code collision", async () => {
    mocks.createInvite.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("collision", { code: "P2002", clientVersion: "test", meta: { target: ["code"] } }));
    const created = await createInviteCode({ note: "  商家  ", maxUses: 2 });
    expect(created.code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    expect(created).toMatchObject({ tenantId: "tenant-admin", note: "商家", usedCount: 0, maxUses: 2, createdBy: "管理" });
    expect(created.registrationUrl).toBe(`/login?invite=${created.code}`);
    expect(mocks.createInvite).toHaveBeenCalledTimes(2);
  });

  it("uses an atomic quota predicate and handles a revoked/concurrently consumed code", async () => {
    mocks.txConsume.mockResolvedValueOnce({ count: 0 });
    expect(await consumeInviteCode(" abcd234567 ")).toMatchObject({ ok: false });
    expect(mocks.txConsume).toHaveBeenCalledWith({ where: { id: "invite-1", code: "ABCD234567", maxUses: 1, usedCount: { lt: 1 } }, data: { usedCount: { increment: 1 } } });
    mocks.txInvite.mockResolvedValueOnce(null);
    expect(await consumeInviteCode("ABCD234567")).toMatchObject({ ok: false, error: "邀请码无效或已失效" });
    expect(await consumeInviteCode("wrong<script>")).toMatchObject({ ok: false });
  });

  it("cannot create or revoke codes with a forged admin session", async () => {
    mocks.user.mockResolvedValue({ id: "actor", username: "admin", tenantId: "tenant-admin", authRole: "tenant", status: "active" });
    await expect(createInviteCode({ note: "", maxUses: 1 })).rejects.toBeInstanceOf(UserManagementAccessError);
    await expect(deleteInviteCode("invite-1")).rejects.toBeInstanceOf(UserManagementAccessError);
    expect(mocks.createInvite).not.toHaveBeenCalled();
    expect(mocks.revokeInvite).not.toHaveBeenCalled();
  });
});
