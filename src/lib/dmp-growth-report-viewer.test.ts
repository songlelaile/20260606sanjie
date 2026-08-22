import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isDmpViewerMetricColumn,
  projectDailyGmvChartSeries,
  projectDmpReportForViewer,
  safeViewerHttpsUrl,
  safeViewerImageUrl,
  sanitizeViewerTable,
  tableHasBusinessData,
  type DmpViewerTable
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
    expect(workspaceSource).toMatch(/<DmpGrowthReportViewer\b[^>]*record=\{selectedViewRecord\}[^>]*variant="preview"/s);
    expect(sharedPageSource).toMatch(/<DmpGrowthReportViewer\b[^>]*record=\{record\}[^>]*variant="shared"/s);

    // The public wrapper keeps anonymous propagation tracking while delegating
    // all business-report rendering to the shared viewer.
    expect(sharedPageSource).toContain("DmpSharedReportClient");
    expect(sharedPageSource).toMatch(/<DmpSharedReportClient\s+token=\{token\}\s+showCopyButton=\{false\}\s*\/>/);
    expect(sharedPageSource).not.toContain("actions={<DmpSharedReportClient");
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
    expect(viewerSource).toContain('data-series="subject-average"');
    expect(viewerSource).toContain('tableByName.get("周期汇总")');
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
    expect(viewerSource).toContain("少壮AI自动化 · shaozhuangai.com");
    expect(viewerSource).toContain('const displayTitle = model.kind === "growth"');
    expect(viewerSource).toContain('"达摩盘商品成长竞品对标报告｜少壮AI自动化"');
    expect(viewerSource).toContain('"达摩盘竞争态势分析报告｜少壮AI自动化"');
    expect(viewerSource).toContain('<h1>{displayTitle}</h1>');
    expect(viewerSource).not.toContain('<h1>{model.title}</h1>');
    expect(viewerSource).toContain("ref={hideAlreadyBrokenImage}");
    expect(viewerSource).toContain("image?.complete && image.naturalWidth === 0");
    expect(viewerSource).toContain("styles.dataNotice");
    expect(viewerSource).toContain("数据说明|花费覆盖|取数时段提示");
    expect(viewerCss).toContain(".dataNotice");
    expect(viewerSource).not.toContain("dangerouslySetInnerHTML");
    expect(viewerSource).toContain('typeof value === "number" && Number.isFinite(value)');
    expect(viewerSource).not.toContain("isExactNumber(value)");
  });

  it("keeps exact, percentage and interval metrics right aligned with difference trends", () => {
    expect(viewerSource).toMatch(/data-(?:numeric|cell-kind)=/);
    expect(viewerSource).toContain('role === "difference" ? differenceTrend(value) : ""');
    expect(viewerSource).toMatch(/text\.match\(\/\[\+\-\]\?\\d\+\(\?:\\\.\\d\+\)\?\/g\)/);
    expect(viewerCss).toMatch(/text-align:\s*right/);
    expect(viewerCss).toMatch(/vertical-align:\s*middle/);
  });

  it("uses a uniform green-and-white header while preserving subject and competitor row colors", () => {
    expect(viewerCss).toMatch(/\.tableShell th\s*\{[^}]*background:\s*#0d716b\s*!important;[^}]*color:\s*#fff\s*!important;/s);
    expect(viewerCss).toMatch(/\.tableShell th\s*\{[^}]*print-color-adjust:\s*exact;/s);
    expect(viewerCss).toMatch(/\.tableShell thead \.stickyColumn\s*\{[^}]*background:\s*#0d716b\s*!important;[^}]*color:\s*#fff\s*!important;/s);
    expect(viewerCss).toMatch(/\.tableShell thead th\.subject,[\s\S]*\.tableShell thead th\.competitor,[\s\S]*\.tableShell thead th\.difference[\s\S]*\{[^}]*background:\s*#0d716b\s*!important;[^}]*color:\s*#fff\s*!important;/s);
    expect(viewerCss).toMatch(/\.subjectRow\s*>\s*td\s*\{[^}]*background-color:\s*var\(--dmp-subject\)\s*!important;/s);
    expect(viewerCss).toMatch(/\.competitorRow\s*>\s*td\s*\{[^}]*background-color:\s*var\(--dmp-competitor\)\s*!important;/s);
  });

  it("isolates every data cell from the dark AppShell table palette", () => {
    expect(viewerCss).toMatch(/\.tableShell\s*\{[^}]*background:\s*#fff;[^}]*color-scheme:\s*light;/s);
    expect(viewerCss).toMatch(/\.tableShell table\s*\{[^}]*background:\s*#fff;/s);
    expect(viewerCss).toMatch(/\.tableShell tbody\s*>\s*tr\s*>\s*td\s*\{[^}]*background-color:\s*#fff;/s);
    expect(viewerCss).toMatch(/\.tableShell tbody tr:nth-child\(even\)\s*>\s*td\s*\{[^}]*background-color:\s*#f9fbfb;/s);
  });

  it("does not right-align numeric-string identifiers while keeping business metrics right-aligned", () => {
    const sceneTable: DmpViewerTable = {
      name: "一级场景",
      columns: ["对象", "层级", "场景编号", "消耗", "CPC", "直接ROI"],
      rows: [["主体", "1", "371", "3596.63", "2.85", "0.71"]]
    };
    expect(sceneTable.columns.map((_, index) => isDmpViewerMetricColumn(sceneTable, index))).toEqual([
      false, false, false, true, true, true
    ]);

    const benchmark: DmpViewerTable = {
      name: "对标总表",
      columns: ["页面模块", "对标指标", "主体周期值", "对手周期值", "主体相对对手"],
      rows: []
    };
    expect(benchmark.columns.map((_, index) => isDmpViewerMetricColumn(benchmark, index))).toEqual([
      false, false, true, true, true
    ]);

    const baseMetrics: DmpViewerTable = {
      name: "基础指标对比",
      columns: ["指标", "主体值", "对手值", "主体相对对手"],
      rows: []
    };
    expect(baseMetrics.columns.map((_, index) => isDmpViewerMetricColumn(baseMetrics, index))).toEqual([
      false, true, true, true
    ]);
  });

  it("right-aligns competition-store exact values and masked ranges while keeping period and label columns left", () => {
    const benchmark: DmpViewerTable = {
      name: "对标总表",
      columns: ["分析周期", "对比周期", "对标指标", "本店当前值", "Swisse斯维诗海外旗舰店当前值", "Swisse斯维诗海外旗舰店变化率"],
      rows: []
    };
    expect(benchmark.columns.map((_, index) => isDmpViewerMetricColumn(benchmark, index))).toEqual([
      false, false, false, true, true, true
    ]);

    const channel: DmpViewerTable = {
      name: "渠道指标",
      columns: ["分析周期", "天数", "归因范围", "流量来源", "对象", "展现", "点击", "ROI"],
      rows: []
    };
    expect(channel.columns.map((_, index) => isDmpViewerMetricColumn(channel, index))).toEqual([
      false, true, false, false, false, true, true, true
    ]);

    const portrait: DmpViewerTable = {
      name: "人群画像",
      columns: ["画像周期", "行为", "标签维度", "标签选项", "本店人数", "本店占比", "本店覆盖规模"],
      rows: []
    };
    expect(portrait.columns.map((_, index) => isDmpViewerMetricColumn(portrait, index))).toEqual([
      false, false, false, false, true, true, true
    ]);
  });

  it("uses source report widths and prints only the viewer with its watermark", () => {
    expect(viewerSource).toContain("widths?.[index]");
    expect(viewerSource).toContain("Math.round(declaredWidth * 6.6)");
    expect(viewerSource).toContain("Math.max(88, Math.min(460");
    expect(viewerCss).toMatch(/@media\s+print/s);
    expect(viewerCss).toMatch(/@media\s+print[\s\S]*\.watermark/s);
    expect(viewerCss).not.toMatch(/@media\s+print[\s\S]*\.watermark[^}]*display:\s*none/s);
    expect(viewerCss).toContain('body):has(.root[data-testid="dmp-growth-report-viewer"]) :global(.app-shell > .sidebar');
    expect(viewerCss).toContain('.dmp-workspace) > :not(.root[data-testid="dmp-growth-report-viewer"])');
    expect(viewerCss).toContain("padding: 0 !important");
  });

  it("covers the signed-in AppShell on public share pages without changing the embedded preview", () => {
    expect(viewerSource).toContain('variant === "shared" ? styles.shared : styles.preview');
    expect(viewerSource).toContain('data-report-scroll-root={variant === "shared" ? "shared" : undefined}');
    expect(viewerCss).toMatch(/\.shared\s*\{[^}]*inset:\s*0;[^}]*overflow:\s*auto;[^}]*position:\s*fixed;[^}]*z-index:\s*2147483640;/s);
    expect(viewerCss).toMatch(/@media\s+print[\s\S]*\.shared\s*\{[^}]*position:\s*static;/s);
    expect(viewerCss).not.toMatch(/\.preview\s*\{[^}]*position:\s*fixed/s);
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

  it("keeps a subject benchmark in the daily chart when the report has no exact subject-daily column", () => {
    const record = growthRecord();
    addVisualTables(record);
    const model = projectDmpReportForViewer(record);
    const daily = model.tables.find((table) => table.name === "日GMV与费比");
    const period = model.tables.find((table) => table.name === "周期汇总");
    if (!daily) throw new Error("missing daily fixture");

    expect(projectDailyGmvChartSeries(daily, period)).toEqual({
      competitorIndex: 1,
      subjectIndex: -1,
      competitorValues: [3200, 3600],
      subjectValues: [],
      subjectAverage: 3051.3
    });
  });

  it("uses validated render_data for exact local-HTML product links, generated time, daily series and table presentation", () => {
    const record = growthRecord();
    addVisualTables(record);
    const start = Date.parse("2026-07-20T00:00:00Z");
    const subjectDaily = Array.from({ length: 30 }, (_, index) => ({
      date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
      gmv: index === 29 ? "62539.13" : "1000"
    }));
    const dailyFixture = record.report.tables.find((table) => table.name === "日GMV与费比");
    if (!dailyFixture) throw new Error("missing daily fixture");
    dailyFixture.rows = subjectDaily.map((entry, index) => ({
      cells: [entry.date, String(6000 + index * 100), "0", "100", "200", "0", "50", "350", "5.83%", "成长期"]
    }));
    record.report.render_data = {
      version: "1",
      generated_at: "2026-08-21T09:30:00.000Z",
      products: {
        subject: {
          picture_url: "https://img.alicdn.com/render-subject.png",
          detail_url: "https://item.taobao.com/item.htm?id=768239824008"
        },
        competitor: {
          picture_url: "https://img.alicdn.com/render-competitor.png",
          detail_url: "https://item.taobao.com/item.htm?id=563697874317"
        }
      },
      subject_daily_gmv: subjectDaily,
      tables: [{
        name: "日GMV与费比",
        subtitle: "主体与目标对手真实逐日GMV",
        widths: [13, 16, 18, 18, 18, 18, 18, 18, 16, 14]
      }]
    };

    const model = projectDmpReportForViewer(record);
    expect(model.generatedAt).toBe("2026-08-21T09:30:00.000Z");
    expect(model.subject).toMatchObject({
      pictureUrl: "https://img.alicdn.com/render-subject.png",
      detailUrl: "https://item.taobao.com/item.htm?id=768239824008"
    });
    expect(model.competitor).toMatchObject({
      pictureUrl: "https://img.alicdn.com/render-competitor.png",
      detailUrl: "https://item.taobao.com/item.htm?id=563697874317"
    });
    const daily = model.tables.find((table) => table.name === "日GMV与费比");
    expect(daily?.columns.slice(0, 3)).toEqual(["日期", "主体日GMV", "对手日GMV"]);
    expect(daily ? projectDailyGmvChartSeries(daily, model.tables.find((table) => table.name === "周期汇总")) : null)
      .toMatchObject({
        competitorIndex: 2,
        subjectIndex: 1,
        subjectValues: subjectDaily.map((row) => Number(row.gmv)),
        subjectAverage: 3051.3
      });
    expect(daily?.subtitle).toBe("主体与目标对手真实逐日GMV");
    expect(daily?.widths?.slice(0, 3)).toEqual([13, 16, 16]);
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

  it("keeps the same disclosed data notices as the opened local HTML", () => {
    const sanitized = sanitizeViewerTable({
      name: "报告总览",
      columns: ["项目", "主体", "对手"],
      rows: [["花费覆盖", "已返回29天", "平台少1天"]]
    });
    expect(sanitized?.rows).toEqual([["花费覆盖", "已返回29天", "平台少1天"]]);
  });

  it("does not promote unsafe product media into an image or detail link", () => {
    const record = growthRecord();
    const products = record.report.tables.find((table) => table.name === "商品与成功品");
    if (!products) throw new Error("missing product fixture");
    products.rows[0].cells[8] = "javascript:alert(1)";
    const model = projectDmpReportForViewer(record);
    expect(model.subject.pictureUrl).toBe("");
    expect(model.subject.detailUrl).toBe("");
    expect(safeViewerHttpsUrl("https://user:pass@item.taobao.com/item.htm?id=1")).toBe("");
    expect(safeViewerHttpsUrl("https://item.taobao.com/item.htm?id=1&token=secret&webOpSessionId=private#payload"))
      .toBe("https://item.taobao.com/item.htm?id=1");
  });

  it("sanitizes table-fallback product media with the render_data URL policy", () => {
    const pictureRecord = growthRecord();
    const pictureProducts = pictureRecord.report.tables.find((table) => table.name === "商品与成功品");
    if (!pictureProducts) throw new Error("missing product fixture");
    pictureProducts.rows[0].cells[8] = "https://img.alicdn.com/subject.png?keep=1&token=secret&session=private&sign=signed#payload";
    expect(projectDmpReportForViewer(pictureRecord).subject.pictureUrl)
      .toBe("https://img.alicdn.com/subject.png?keep=1");

    const detailRecord = growthRecord();
    const detailProducts = detailRecord.report.tables.find((table) => table.name === "商品与成功品");
    if (!detailProducts) throw new Error("missing product fixture");
    detailProducts.rows[0].cells[8] = "https://item.taobao.com/item.htm?id=768239824008&webOpSessionId=private&authorization=secret#payload";
    const detailProduct = projectDmpReportForViewer(detailRecord).subject;
    expect(detailProduct.pictureUrl).toBe("");
    expect(detailProduct.detailUrl).toBe("https://item.taobao.com/item.htm?id=768239824008");

    expect(safeViewerImageUrl("https://user:pass@img.alicdn.com/subject.png")).toBe("");
    expect(safeViewerHttpsUrl(`https://item.taobao.com/${"a".repeat(2_048)}`)).toBe("");
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
