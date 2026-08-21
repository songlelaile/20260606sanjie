import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  projectDmpReportForViewer,
  sanitizeViewerTable,
  tableHasBusinessData
} from "@/components/tools/DmpGrowthReportViewModel";
import {
  DMP_GROWTH_REPORT_TABLES,
  type DmpBusinessReportRecord,
  type DmpReportTableSnapshot
} from "@/lib/dmp-report-types";

const viewerSource = readFileSync(
  new URL("../components/tools/DmpGrowthReportViewer.tsx", import.meta.url),
  "utf8"
);
const viewerCss = readFileSync(
  new URL("../components/tools/DmpGrowthReportViewer.module.css", import.meta.url),
  "utf8"
);
const viewModelSource = readFileSync(
  new URL("../components/tools/DmpGrowthReportViewModel.ts", import.meta.url),
  "utf8"
);
const workspaceSource = readFileSync(
  new URL("../components/tools/DmpReportWorkspace.tsx", import.meta.url),
  "utf8"
);
const sharedPageSource = readFileSync(
  new URL("../app/shared/dmp-reports/[token]/page.tsx", import.meta.url),
  "utf8"
);

describe("DMP growth report shared viewer contract", () => {
  it("uses one report viewer for both the report-center preview and public share page", () => {
    expect(workspaceSource).toContain('from "@/components/tools/DmpGrowthReportViewer"');
    expect(sharedPageSource).toContain('from "@/components/tools/DmpGrowthReportViewer"');
    expect(workspaceSource).toMatch(/<DmpGrowthReportViewer\b[^>]*record=\{selectedRecord\}[^>]*variant="preview"/s);
    expect(sharedPageSource).toMatch(/<DmpGrowthReportViewer\b[^>]*record=\{record\}[^>]*variant="shared"/s);

    // The public wrapper keeps anonymous propagation tracking while delegating
    // all business-report rendering to the shared viewer.
    expect(sharedPageSource).toContain("DmpSharedReportClient");
    expect(sharedPageSource).toMatch(/<DmpSharedReportClient\s+token=\{token\}\s*\/>/);
    expect(sharedPageSource).toContain('data-track-section="report"');
    expect(sharedPageSource).not.toContain("report.tables.map");
    expect(workspaceSource).not.toContain("dmp-print-disabled");
    expect(sharedPageSource).not.toContain("dmp-print-disabled");
  });

  it("covers the opened-HTML interaction and overview surface", () => {
    expect(viewerSource).toContain('data-testid="dmp-growth-report-viewer"');
    expect(viewerSource).toContain("data-report-section");
    expect(viewerSource).toContain("data-report-table");
    expect(viewerSource).toContain("data-table-filter");
    expect(viewerSource).toContain('data-track-section="hero"');
    expect(viewerSource).toContain('data-track-section="report-nav"');
    expect(viewerSource).toContain('data-track={`nav:${index + 1}`}');
    expect(viewerSource).toContain('data-track={`table-scroll:${index + 1}`}');
    expect(viewerSource).toContain('data-track={`cell:${Math.min(columnIndex, 99)}`}');
    expect(viewerSource).toContain('data-chart="daily-gmv"');
    expect(viewerSource).toContain('data-chart="channel-spend"');
    expect(viewerSource).toContain('data-product-role={role}');
    expect(viewerSource).toContain('<ProductCard product={model.subject} role="subject" />');
    expect(viewerSource).toContain('<ProductCard product={model.competitor} role="competitor" />');
    expect(viewerSource).toContain("data-report-print");
    expect(viewerSource).toContain("window.print()");
    expect(viewerSource).toMatch(/const visibleRows = keyword[\s\S]*table\.rows\.filter/);
    expect(viewerSource).toContain("onChange={(event) => setQuery(event.target.value)}");
    expect(viewerSource).toContain("data-report-watermark");
    expect(viewerSource).toMatch(/Array\.from\(\{\s*length:\s*54\s*\}/);
    expect(viewerSource).toContain("少壮AI · shaozhuangai.com");
    expect(viewerSource).not.toContain("dangerouslySetInnerHTML");
  });

  it("keeps numeric cells right aligned and preserves the watermark in print", () => {
    expect(viewerSource).toMatch(/data-(?:numeric|cell-kind)=/);
    expect(viewerCss).toMatch(/text-align:\s*right/);
    expect(viewerCss).toMatch(/vertical-align:\s*middle/);
    expect(viewerCss).toMatch(/@media\s+print/s);
    expect(viewerCss).toMatch(/@media\s+print[\s\S]*\.watermark/s);
    expect(viewerCss).not.toMatch(/@media\s+print[\s\S]*\.watermark[^}]*display:\s*none/s);
  });

  it("derives navigation and sections from the fixed growth-report contract", () => {
    expect(viewModelSource).toContain("tableHasBusinessData");
    expect(viewModelSource).toMatch(/projected\.filter\(tableHasBusinessData\)/);
    expect(viewerSource.match(/model\.tables\.map/g)?.length).toBeGreaterThanOrEqual(2);
    expect(viewerSource).toMatch(/<nav[\s\S]*model\.tables\.map[\s\S]*href=/);
    expect(viewerSource).toMatch(/<main[\s\S]*model\.tables\.map[\s\S]*data-report-section/);
  });
});

describe("DMP growth report viewer projection", () => {
  it("keeps the fixed 11-table order while omitting optional modules with no business data", () => {
    const record = growthRecord();
    expect(record.report.tables.map((table) => table.name)).toEqual(DMP_GROWTH_REPORT_TABLES);

    const model = projectDmpReportForViewer(record);
    expect(model.tables.map((table) => table.name)).toEqual([
      "报告总览",
      "对标总表",
      "商品与成功品",
      "周期汇总",
      "基础指标对比"
    ]);
    expect(model.subject.pictureUrl).toBe("https://img.alicdn.com/subject.png");
    expect(model.competitor.pictureUrl).toBe("https://img.alicdn.com/competitor.png");
    expect(model.kpis.map((item) => item.label)).toEqual([
      "主体30日GMV",
      "对手30日GMV",
      "主体费比",
      "对手费比"
    ]);
  });

  it("shows daily and channel modules only after their business values exist", () => {
    const record = growthRecord();
    addVisualTables(record);

    const model = projectDmpReportForViewer(record);
    expect(model.tables.map((table) => table.name)).toContain("日GMV与费比");
    expect(model.tables.map((table) => table.name)).toContain("渠道花费");
    expect(model.tables.find((table) => table.name === "日GMV与费比")?.columns[1]).toBe("对手日GMV");
    expect(model.tables.find((table) => table.name === "渠道花费")?.groupedChannel).toBe(true);
  });

  it("removes method, evidence, diagnostic and GMV-index text before either page can render it", () => {
    const sanitized = sanitizeViewerTable({
      name: "基础指标对比",
      columns: ["指标", "主体值", "对手值", "校验状态"],
      rows: [
        ["总GMV", "91539.13", "227027.62", "已闭合"],
        ["GMV指数", "0.8", "1.2", "方法与证据"]
      ]
    });
    expect(sanitized?.columns).toEqual(["指标", "主体值", "对手值"]);
    expect(sanitized?.rows).toEqual([["总GMV", "91539.13", "227027.62"]]);
    expect(JSON.stringify(sanitized)).not.toMatch(/方法与证据|校验状态|GMV指数/);
  });

  it("does not promote unsafe product media into an image or detail link", () => {
    const record = growthRecord();
    const products = record.report.tables.find((table) => table.name === "商品与成功品");
    if (!products) throw new Error("missing product fixture");
    products.rows[0].cells[8] = "javascript:alert(1)";
    const model = projectDmpReportForViewer(record);
    expect(model.subject.pictureUrl).toBe("");
    expect(model.subject.detailUrl).toBe("");
  });

  it("treats zeros as disclosed business values but blanks and em dashes as missing", () => {
    expect(tableHasBusinessData({
      name: "渠道花费",
      columns: ["渠道", "主体30日消耗"],
      rows: [["内容运营", "0"]]
    })).toBe(true);
    expect(tableHasBusinessData({
      name: "渠道花费",
      columns: ["渠道", "主体30日消耗"],
      rows: [["内容运营", "—"]]
    })).toBe(false);
  });
});

function growthRecord(): DmpBusinessReportRecord {
  const tables = DMP_GROWTH_REPORT_TABLES.map((name) => {
    if (name === "报告总览") return snapshot(name, ["项目", "主体", "对手", "范围"], [
      ["商品ID", "768239824008", "563697874317", "2026-07-20 至 2026-08-18"]
    ]);
    if (name === "对标总表") return snapshot(name, ["页面模块", "对标指标", "主体周期值", "对手周期值", "主体相对对手"], [
      ["周期汇总", "总GMV", "91539.13", "227027.62", "-59.68%"]
    ]);
    if (name === "商品与成功品") return snapshot(name, [
      "角色", "商品ID", "商品标题", "类目/成功品描述", "标价/价格带", "上架天数", "生命周期", "30日GMV", "图片/详情"
    ], [
      ["主体", "768239824008", "蜂蜜便携小包装", "蜂蜜", "180", "910", "成长期", "91539.13", "https://img.alicdn.com/subject.png"],
      ["目标对手", "563697874317", "麦卢卡蜂蜜礼盒", "滋补营养品", "197.43~239", "3146", "爆品期", "227027.62", "https://img.alicdn.com/competitor.png"]
    ]);
    if (name === "周期汇总") return snapshot(name, [
      "商品ID", "对象", "周期开始", "周期结束", "天数", "成交笔数", "笔单价", "总GMV", "广告归因GMV", "广告消耗", "费比", "全域ROAS", "广告GMV贡献率", "广告订单贡献率", "日均GMV", "日均消耗", "GMV峰值日", "GMV波动率"
    ], [
      ["768239824008", "主体", "2026-07-20", "2026-08-18", "30", "509", "179.84", "91539.13", "", "25942.88", "28.34%", "3.53", "", "", "3051.3", "864.76", "2026-08-11", "31.2%"],
      ["563697874317", "目标对手", "2026-07-20", "2026-08-18", "30", "950", "238.98", "227027.62", "", "42242.14", "18.61%", "5.37", "", "", "7567.59", "1408.07", "2026-08-11", "28.1%"]
    ]);
    if (name === "基础指标对比") return snapshot(name, ["指标", "主体值", "对手值", "主体相对对手"], [
      ["总GMV", "91539.13", "227027.62", "-59.68%"]
    ]);
    if (name === "日GMV与费比") return snapshot(name, ["日期", "日GMV", "阶段"], [["2026-07-20", "", ""]]);
    if (name === "渠道花费") return snapshot(name, ["渠道", "主体30日消耗"], [["内容运营", ""]]);
    if (name === "成长阶段数据") return snapshot(name, ["阶段", "开始"], []);
    if (name === "关键词样本") return snapshot(name, ["对象", "关键词"], []);
    return snapshot(name, ["对象", "层级", "一级场景", "二级场景", "场景编号", "消耗"], []);
  });
  return {
    id: "report-growth-1",
    reportType: "growth",
    subjectItemId: "768239824008",
    competitorItemId: "563697874317",
    period: "2026-07-20 至 2026-08-18",
    quality: "complete",
    createdAt: "2026-08-20T12:00:00.000Z",
    report: {
      schema_version: "3.0",
      title: "达摩盘商品成长竞品对标报告｜少壮AI自动化",
      item_id: "768239824008",
      period: "2026-07-20 至 2026-08-18",
      tables
    }
  };
}

function snapshot(name: string, columns: string[], rows: string[][]): DmpReportTableSnapshot {
  return { name, columns, rows: rows.map((cells) => ({ cells })) };
}

function replaceTable(record: DmpBusinessReportRecord, next: DmpReportTableSnapshot) {
  const index = record.report.tables.findIndex((table) => table.name === next.name);
  if (index < 0) throw new Error(`missing ${next.name}`);
  record.report.tables[index] = next;
}

function addVisualTables(record: DmpBusinessReportRecord) {
  replaceTable(record, snapshot("日GMV与费比", [
    "日期", "日GMV", "内容运营日消耗", "人群推广日消耗", "货品全站推日消耗",
    "线索推广日消耗", "关键词推广日消耗", "日总消耗", "日费比", "阶段"
  ], [
    ["2026-07-20", "3200", "0", "100", "200", "0", "50", "350", "10.94%", "驱稳爬升期"],
    ["2026-07-21", "3600", "0", "120", "220", "0", "60", "400", "11.11%", "驱稳爬升期"]
  ]));
  replaceTable(record, snapshot("渠道花费", [
    "渠道", "页面指标", "对手30日消耗", "对手30日占比", "主体30日消耗", "主体30日占比"
  ], [
    ["人群推广", "人群推广消耗占比", "11853.73", "28.06%", "3921.86", "15.12%"],
    ["合计", "—", "42242.14", "100%", "25942.88", "100%"]
  ]));
}
