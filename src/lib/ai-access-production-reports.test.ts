import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ find: vi.fn(), count: vi.fn(), list: vi.fn(), baseline: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { dmpBusinessReport: { findFirst: mocks.find, count: mocks.count, findMany: mocks.list } } }));
vi.mock("@/lib/dmp-report-store", () => ({ getDmpBusinessReport: mocks.baseline }));
import { getDmpBusinessReport, listDmpBusinessReportSummaries } from "./ai-access-production-reports";
const access = { userId: "user-a", tenantId: "tenant-a" };
beforeEach(() => { vi.clearAllMocks(); mocks.find.mockResolvedValue({ id: "report-a" }); mocks.baseline.mockResolvedValue({ id: "report-a", shopId: "shop-a", report: {} }); });
it("checks owner, tenant and exact grant shop before canonical baseline validation", async () => {
  expect(await getDmpBusinessReport(access, "report-a", "shop-a")).toMatchObject({ shopId: "shop-a" });
  expect(mocks.find).toHaveBeenCalledWith({ where: { id: "report-a", userId: "user-a", tenantId: "tenant-a", shopId: "shop-a" }, select: { id: true } });
  expect(mocks.baseline).toHaveBeenCalledExactlyOnceWith(access, "report-a");
});
it("does not invoke old unscoped validation on a grant-shop miss", async () => {
  mocks.find.mockResolvedValue(null); expect(await getDmpBusinessReport(access, "report-a", "shop-b")).toBeNull(); expect(mocks.baseline).not.toHaveBeenCalled();
});
it("rejects a concurrent report shop reassignment", async () => {
  mocks.baseline.mockResolvedValue({ id: "report-a", shopId: "shop-b" }); expect(await getDmpBusinessReport(access, "report-a", "shop-a")).toBeNull();
});
it("lists bounded grant-shop metadata without selecting report JSON", async () => {
  mocks.count.mockResolvedValue(4); mocks.list.mockResolvedValue([{ id: "report-a", shopId: "shop-a", createdAt: new Date("2026-10-02T00:00:00Z") }]);
  const result = await listDmpBusinessReportSummaries(access, { shopId: "shop-a", page: 2, pageSize: 3 });
  expect(mocks.count).toHaveBeenCalledWith({ where: { userId: "user-a", tenantId: "tenant-a", shopId: "shop-a" } });
  expect(mocks.list.mock.calls[0][0]).toMatchObject({ where: { userId: "user-a", tenantId: "tenant-a", shopId: "shop-a" }, skip: 3, take: 3 });
  expect(mocks.list.mock.calls[0][0].select).not.toHaveProperty("report");
  expect(result).toMatchObject({ page: 2, pageSize: 3, total: 4, totalPages: 2, hasNext: false });
});
it("clamps direct adapter calls and never substitutes a shop", async () => {
  mocks.count.mockResolvedValue(0); mocks.list.mockResolvedValue([]);
  const result = await listDmpBusinessReportSummaries(access, { shopId: "shop-exact", page: 0, pageSize: 1000 });
  expect(result).toMatchObject({ page: 1, pageSize: 50 }); expect(mocks.list.mock.calls[0][0].where.shopId).toBe("shop-exact");
});
