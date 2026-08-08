import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBusinessDiagnosisWorkspaceSource: vi.fn(),
  getImportBatches: vi.fn(),
  getLatestCalcRun: vi.fn(),
  getPrefillItems: vi.fn(),
  getStoreDailyTrend: vi.fn(),
  getWorkspaceContext: vi.fn(),
  countProductWindowDays: vi.fn(),
  countPromotionWindowDays: vi.fn(),
  countAudienceWindowDays: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/store/runtime-store", () => mocks);
vi.mock("@/lib/store/daily-metrics", () => ({
  countProductWindowDays: mocks.countProductWindowDays,
  countPromotionWindowDays: mocks.countPromotionWindowDays,
  countAudienceWindowDays: mocks.countAudienceWindowDays
}));

import {
  getScopedOperatingNetwork,
  trendSeriesThroughAnalysisEnd
} from "@/lib/operating-network-server";

describe("scoped operating network loader", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.getLatestCalcRun.mockResolvedValue({
      id: "",
      cycleId: "cycle-shop-a",
      createdAt: "",
      investmentResults: [],
      breakthroughResults: [],
      audiencePlans: [],
      managementDashboard: {},
      analysisPeriod: { start: "2026-06-01", end: "2026-06-30" }
    });
    mocks.getBusinessDiagnosisWorkspaceSource.mockResolvedValue(null);
    mocks.getImportBatches.mockResolvedValue([]);
    mocks.getPrefillItems.mockResolvedValue([]);
    mocks.countProductWindowDays.mockResolvedValue(30);
    mocks.countPromotionWindowDays.mockResolvedValue(30);
    mocks.countAudienceWindowDays.mockResolvedValue(30);
    mocks.getWorkspaceContext.mockResolvedValue({
      shop: { id: "shop-a", tenantId: "tenant-a", name: "A 店", platform: "淘宝" },
      cycle: {
        id: "cycle-shop-a",
        tenantId: "tenant-a",
        shopId: "shop-a",
        name: "当前分析周期",
        startDate: "2026-06-01",
        endDate: "2026-06-30",
        status: "draft"
      }
    });
  });

  it("has no client-selectable tenant or shop parameter", async () => {
    expect(getScopedOperatingNetwork.length).toBe(0);
    const result = await getScopedOperatingNetwork();
    expect(result.hasDiagnosticData).toBe(false);
    expect(mocks.getLatestCalcRun).toHaveBeenCalledWith();
    expect(mocks.getBusinessDiagnosisWorkspaceSource).toHaveBeenCalledWith();
    expect(mocks.getImportBatches).toHaveBeenCalledWith();
    expect(mocks.getWorkspaceContext).toHaveBeenCalledWith();
    expect(mocks.getPrefillItems).toHaveBeenCalledWith();
    expect(mocks.getStoreDailyTrend).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("tenant-a");
  });

  it("keeps existing daily history before a short latest upload window", () => {
    const series = Array.from({ length: 16 }, (_, index) => ({
      date: `2026-06-${String(index + 1).padStart(2, "0")}`,
      value: index
    }));

    expect(trendSeriesThroughAnalysisEnd(series, "2026-06-14")).toEqual(series.slice(0, 14));
  });
});
