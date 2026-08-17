import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  parseSession: vi.fn(),
  transaction: vi.fn(),
  userFindUnique: vi.fn(),
  reportFindFirst: vi.fn(),
  auditCreate: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ parseSession: mocks.parseSession }));
vi.mock("@/lib/db", () => ({
  prisma: { $transaction: mocks.transaction }
}));

import { authorizeAndAuditDmpReportExport } from "@/lib/dmp-report-export-authorization";

const NOW = new Date("2026-08-17T08:30:00.000Z");
const REQUEST = {
  reportId: "report-growth-1",
  reportType: "growth" as const,
  format: "xlsx" as const,
  clientVersion: "2.1.3"
};
const ADMIN_SESSION = {
  username: "platform-admin",
  name: "平台管理员",
  role: "admin" as const,
  tenantId: "tenant-admin"
};

function activeEntitlement() {
  return {
    status: "active",
    grantedAt: new Date("2026-08-01T00:00:00.000Z"),
    expiresAt: new Date("2026-09-01T00:00:00.000Z")
  };
}

function databaseUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "admin-db-id",
    tenantId: "tenant-admin",
    authRole: "admin",
    status: "active",
    toolEntitlements: [activeEntitlement()],
    ...overrides
  };
}

describe("DMP report XLSX export authorization and audit", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.parseSession.mockResolvedValue(ADMIN_SESSION);
    mocks.userFindUnique.mockResolvedValue(databaseUser());
    mocks.reportFindFirst.mockResolvedValue({
      id: REQUEST.reportId,
      report: { schema_version: "3.0", item_id: "593063365092" }
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1", exportedAt: NOW });
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work({
      user: { findUnique: mocks.userFindUnique },
      dmpBusinessReport: { findFirst: mocks.reportFindFirst },
      dmpReportExportAudit: { create: mocks.auditCreate }
    }));
  });

  it("revalidates a database administrator and active DMP entitlement before writing the minimal audit", async () => {
    await expect(authorizeAndAuditDmpReportExport("signed-session", REQUEST, NOW)).resolves.toEqual({
      ok: true,
      authorization: {
        authorized: true,
        auditId: "audit-1",
        authorizedAt: NOW.toISOString()
      }
    });

    expect(mocks.userFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { username: ADMIN_SESSION.username }
    }));
    expect(mocks.reportFindFirst).toHaveBeenCalledWith({
      where: {
        id: REQUEST.reportId,
        tenantId: "tenant-admin",
        userId: "admin-db-id"
      },
      select: { id: true, report: true }
    });
    const audit = mocks.auditCreate.mock.calls[0]?.[0];
    expect(audit.data).toEqual({
      adminId: "admin-db-id",
      reportId: REQUEST.reportId,
      reportType: "growth",
      format: "xlsx",
      clientVersion: "2.1.3",
      exportedAt: NOW
    });
    expect(Object.keys(audit.data).sort()).toEqual([
      "adminId",
      "clientVersion",
      "exportedAt",
      "format",
      "reportId",
      "reportType"
    ]);
    expect(audit.data).not.toHaveProperty("report");
    expect(audit.data).not.toHaveProperty("tables");
    expect(audit.data).not.toHaveProperty("cells");
  });

  it("returns 403 to a database-valid tenant and never reads or audits the report", async () => {
    mocks.parseSession.mockResolvedValueOnce({ ...ADMIN_SESSION, role: "tenant" });
    mocks.userFindUnique.mockResolvedValueOnce(databaseUser({ authRole: "tenant" }));
    await expect(authorizeAndAuditDmpReportExport("signed-session", REQUEST, NOW)).resolves.toMatchObject({
      ok: false,
      status: 403
    });
    expect(mocks.reportFindFirst).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["disabled account", databaseUser({ status: "disabled" })],
    ["stale tenant identity", databaseUser({ tenantId: "tenant-other" })],
    ["stale role", databaseUser({ authRole: "tenant" })]
  ])("returns 401 for a %s before report lookup", async (_label, user) => {
    mocks.userFindUnique.mockResolvedValueOnce(user);
    await expect(authorizeAndAuditDmpReportExport("signed-session", REQUEST, NOW)).resolves.toMatchObject({
      ok: false,
      status: 401
    });
    expect(mocks.reportFindFirst).not.toHaveBeenCalled();
  });

  it("returns 401 when the paid DMP entitlement is missing, revoked, or expired", async () => {
    mocks.userFindUnique.mockResolvedValueOnce(databaseUser({
      toolEntitlements: [{
        status: "active",
        grantedAt: new Date("2026-07-01T00:00:00.000Z"),
        expiresAt: new Date("2026-08-17T08:29:59.000Z")
      }]
    }));
    await expect(authorizeAndAuditDmpReportExport("signed-session", REQUEST, NOW)).resolves.toMatchObject({
      ok: false,
      status: 401
    });
    expect(mocks.reportFindFirst).not.toHaveBeenCalled();
  });

  it("scopes report lookup to the administrator and tenant and returns 404 without an audit", async () => {
    mocks.reportFindFirst.mockResolvedValueOnce(null);
    await expect(authorizeAndAuditDmpReportExport("signed-session", REQUEST, NOW)).resolves.toMatchObject({
      ok: false,
      status: 404
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("returns 409 when the persisted report type differs from the plugin declaration", async () => {
    mocks.reportFindFirst.mockResolvedValueOnce({
      id: REQUEST.reportId,
      report: { schema_version: "3.0", report_type: "competition" }
    });
    await expect(authorizeAndAuditDmpReportExport("signed-session", REQUEST, NOW)).resolves.toMatchObject({
      ok: false,
      status: 409
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("fails before any database query when the signed session is invalid", async () => {
    mocks.parseSession.mockResolvedValue(null);
    await expect(authorizeAndAuditDmpReportExport("invalid-session", REQUEST, NOW)).resolves.toMatchObject({
      ok: false,
      status: 401
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("decodes the raw cookie value supplied by a Chrome extension before revalidating", async () => {
    mocks.parseSession
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ADMIN_SESSION);
    await expect(authorizeAndAuditDmpReportExport("signed%2Eencoded", REQUEST, NOW)).resolves.toMatchObject({
      ok: true,
      authorization: { authorized: true }
    });
    expect(mocks.parseSession).toHaveBeenNthCalledWith(1, "signed%2Eencoded");
    expect(mocks.parseSession).toHaveBeenNthCalledWith(2, "signed.encoded");
  });
});
