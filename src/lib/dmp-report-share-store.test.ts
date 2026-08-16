import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  getDmpBusinessReport: vi.fn(),
  validateDmpCanonicalReport: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  prisma: {
    dmpReportShare: {
      findFirst: mocks.findFirst,
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn()
    },
    dmpReportHeatBucket: { upsert: vi.fn(), groupBy: vi.fn() },
    $transaction: vi.fn()
  }
}));
vi.mock("@/lib/dmp-report-store", () => ({
  getDmpBusinessReport: mocks.getDmpBusinessReport,
  validateDmpCanonicalReport: mocks.validateDmpCanonicalReport
}));

import { getDmpSharedReport, recordDmpSharedReportView } from "@/lib/dmp-report-share";

const ACCESS = { userId: "owner-user", tenantId: "owner-tenant" };
const TOKEN = "b".repeat(64);

describe("DMP report share ownership", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.findFirst.mockResolvedValue(null);
  });

  it("scopes shared report reads to both the tenant and exact report owner", async () => {
    await expect(getDmpSharedReport(ACCESS, TOKEN)).resolves.toBeNull();
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        report: { tenantId: ACCESS.tenantId, userId: ACCESS.userId }
      })
    }));
  });

  it("applies the same owner scope before counting a view", async () => {
    await expect(recordDmpSharedReportView(ACCESS, TOKEN)).resolves.toBe(false);
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        report: { tenantId: ACCESS.tenantId, userId: ACCESS.userId }
      })
    }));
  });
});
