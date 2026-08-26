import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildDmpReportCsv } from "@/lib/dmp-report-export";
import type { DmpCanonicalReport } from "@/lib/dmp-report-types";

describe("DMP category-market track export", () => {
  it("keeps every archived track period in the shared CSV/XLSX table source", () => {
    const report: DmpCanonicalReport = {
      schema_version: "3.0",
      report_type: "market",
      title: "达摩盘类目大盘报告",
      item_id: "50015382",
      period: "2026-05-01 至 2026-07-31",
      market_scope: {
        category_id: "50015382",
        category_name: "油烟机",
        category_path: ["大家电", "厨房大电", "油烟机"]
      },
      tables: [{
        name: "细分赛道矩阵",
        columns: ["周期", "周期开始", "周期结束", "属性维度", "属性值", "价格带", "指标", "数值"],
        rows: [
          { cells: ["2026-07-01 至 2026-07-31", "2026-07-01", "2026-07-31", "机身材质", "不锈钢", "0~2300", "蓝海指数", "346"] },
          { cells: ["2026-06-01 至 2026-06-30", "2026-06-01", "2026-06-30", "机身材质", "不锈钢", "0~2300", "蓝海指数", "300"] },
          { cells: ["2026-05-01 至 2026-05-31", "2026-05-01", "2026-05-31", "机身材质", "不锈钢", "0~2300", "蓝海指数", "280"] }
        ]
      }]
    };

    const csv = buildDmpReportCsv(report);
    expect(csv).toContain('"细分赛道矩阵"');
    expect(csv).toContain('"周期","周期开始","周期结束","属性维度","属性值","价格带","指标","数值"');
    expect(csv.match(/2026-0[567]-01 至 2026-0[567]-(?:30|31)/g)).toHaveLength(3);
  });
});
