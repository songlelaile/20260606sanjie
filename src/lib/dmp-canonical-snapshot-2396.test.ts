import { describe, expect, it } from "vitest";
import { hasAuthoritativeDmpGrowthSnapshot, normalizeDmpCanonicalReportForUse } from "./dmp-report-import";
import { DMP_GROWTH_REPORT_TABLES, DMP_GROWTH_OVERVIEW_METRICS } from "./dmp-report-types";
import { projectDmpReportForViewer } from "../components/tools/DmpGrowthReportViewModel";

function snapshot() {
  const tables = DMP_GROWTH_REPORT_TABLES.map(name => ({ name: String(name), columns: ["对象"], rows: [] as { cells: string[] }[] }));
  const overview = tables.find(table => table.name === "报告总览")!;
  overview.columns = ["项目", "主体", "对手", "范围"];
  overview.rows = [{ cells: ["商品ID", "123456789012", "987654321098", ""] },
    ...DMP_GROWTH_OVERVIEW_METRICS.map(metric => ({ cells: [metric.label, "", "", "30日严格同周期"] }))];
  const set = (label: string, subject: string, competitor: string) => {
    const row = overview.rows.find(row => row.cells[0] === label)!;
    row.cells[1] = subject; row.cells[2] = competitor;
  };
  set("总GMV", "1000", "2000");
  set("付费成交额", "300", "500~700");
  set("推广消耗", "100", "150");
  overview.rows.find(row => row.cells[0] === "推广消耗")!.cells[3] = "主体30日；对手已返回29/30日";
  const scene = tables.find(table => table.name === "一级场景")!;
  scene.columns = ["对象", "一级场景", "消耗", "消耗占比", "直接成交金额", "直接ROI"];
  scene.rows = [{ cells: ["主体", "关键词推广", "100", "100%", "999", "9.99"] }];
  return { schema_version: "3.0", title: "测试", item_id: "123456789012", period: "2026-08-17 至 2026-09-15", tables,
    render_data: { version: "1", tables: tables.map(table => ({ name: table.name, widths: table.columns.map(() => 16) })) } };
}

describe("完整canonical的业务结果与缺失值是官网展示边界", () => {
  it("金额区间原样保留；空白比例不从不同覆盖天数重算", () => {
    const input = snapshot(), before = JSON.stringify(input);
    expect(hasAuthoritativeDmpGrowthSnapshot(input)).toBe(true);
    const report = normalizeDmpCanonicalReportForUse(input)!;
    const rows = report.tables.find(table => table.name === "报告总览")!.rows;
    expect(rows.find(row => row[0] === "付费成交额")!.slice(1, 3)).toEqual(["300", "500~700"]);
    for (const label of ["ROI", "PPC", "费比", "付费金额占比", "全域ROAS"]) {
      expect(rows.find(row => row[0] === label)!.slice(1, 3)).toEqual(["", ""]);
    }
    expect(JSON.stringify(input)).toBe(before);
  });
  it("Viewer不得用一级场景覆盖二级优先金额或补回被门禁清空的指标", () => {
    const input = snapshot();
    const record = { id: "snapshot", reportType: "growth", quality: "partial", report: input,
      subjectItemId: input.item_id, competitorItemId: "987654321098", period: input.period, createdAt: "2026-09-16T00:00:00Z" };
    const view = projectDmpReportForViewer(record as Parameters<typeof projectDmpReportForViewer>[0]);
    expect(view.kpis.find(row => row.label === "付费成交额")?.subject).toBe("300");
    expect(view.kpis.find(row => row.label === "ROI")?.subject).toBe("");
    expect(view.kpis.find(row => row.label === "付费金额占比")?.subject).toBe("");
  });
  it("显式零保留为零；缺少完整结构或合法render_data不冒充完整快照", () => {
    const input = snapshot();
    input.tables[0].rows.find(row => row.cells[0] === "付费成交额")!.cells[1] = "0";
    expect(normalizeDmpCanonicalReportForUse(input)!.tables[0].rows.find(row => row[0] === "付费成交额")![1]).toBe("0");
    expect(hasAuthoritativeDmpGrowthSnapshot({ ...input, render_data: { version: "invalid" } })).toBe(false);
    expect(hasAuthoritativeDmpGrowthSnapshot({ ...input, tables: input.tables.slice(0, 3) })).toBe(false);
  });
});
