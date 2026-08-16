import { describe, expect, it, vi } from "vitest";
import { DMP_COMPETITION_REPORT_TABLES } from "@/lib/dmp-report-types";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/server-session", () => ({ getCurrentSession: vi.fn() }));
vi.mock("@/lib/tool-entitlements", () => ({ getDmpAutomationAccessForSession: vi.fn() }));

import { validateDmpCanonicalReport } from "@/lib/dmp-report-store";

function competitionReport(competitorIds = ["589538478", "342744019", "279364801"]) {
  return {
    schema_version: "3.0",
    report_type: "competition",
    title: "达摩盘竞争态势分析报告",
    item_id: "254805044",
    competitor_ids: competitorIds,
    period: "近7天 + 近30天",
    tables: DMP_COMPETITION_REPORT_TABLES.map((name) => ({
      name,
      columns: ["指标", "本店当前"],
      rows: [{ cells: ["成交笔数", "13292"] }]
    }))
  };
}

describe("DMP competition report storage contract", () => {
  it("accepts exactly the five selected business tables and one to three competitor IDs", () => {
    const checked = validateDmpCanonicalReport(competitionReport());
    expect(checked.error).toBeUndefined();
    expect(checked.report?.report_type).toBe("competition");
    expect(checked.report?.competitor_ids).toEqual(["589538478", "342744019", "279364801"]);
    expect(checked.report?.title).toBe("达摩盘竞争态势分析报告｜少壮AI自动化");
    expect(checked.report?.tables.map((table) => table.name)).toEqual(DMP_COMPETITION_REPORT_TABLES);
  });

  it("rejects missing competitor identity and any extra or reordered business table", () => {
    expect(validateDmpCanonicalReport(competitionReport([])).error).toMatch(/竞店 ID/);
    const reordered = competitionReport();
    reordered.tables.reverse();
    expect(validateDmpCanonicalReport(reordered).error).toMatch(/业务表不完整/);
  });
});
