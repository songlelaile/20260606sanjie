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
const pairedDailyColumns = [
  "日期", "主体日GMV", "对手日GMV",
  "主体内容运营日消耗", "对手内容运营日消耗",
  "主体人群推广日消耗", "对手人群推广日消耗",
  "主体货品全站推日消耗", "对手货品全站推日消耗",
  "主体线索推广日消耗", "对手线索推广日消耗",
  "主体关键词推广日消耗", "对手关键词推广日消耗",
  "主体日总消耗", "对手日总消耗", "主体日费比", "对手日费比", "阶段"
];

describe("DMP growth report shared viewer contract", () => {
  it("uses one report viewer for both the report-center preview and public share page", () => {
    expect(workspaceSource).toContain('from "@/components/tools/DmpReportViewer"');
    expect(sharedPageSource).toContain('from "@/components/tools/DmpReportViewer"');
    expect(workspaceSource).toMatch(/<DmpReportViewer\b[^>]*record=\{selectedViewRecord\}[^>]*variant="preview"/s);
    expect(sharedPageSource).toMatch(/<DmpReportViewer\b[^>]*record=\{record\}[^>]*variant="shared"/s);

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
    expect(viewerSource).toContain("data-report-shop-signature");
    expect(viewerSource).toContain("店铺署名：{record.shopName}");
    expect(viewerSource).toContain('record.shopName ? `${record.shopName} · ` : ""');
    expect(viewerSource).toContain("ref={hideAlreadyBrokenImage}");
    expect(viewerSource).toContain("image?.complete && image.naturalWidth === 0");
    expect(viewerSource).toContain("styles.dataNotice");
    expect(viewerSource).toContain("数据说明|花费覆盖|取数时段提示");
    expect(viewerCss).toContain(".dataNotice");
    expect(viewerSource).toContain("data-overview-metric={metric.label}");
    expect(viewerSource).toContain("data-overview-scope");
    expect(viewerSource).toContain("formatViewerCell(metric.subject, metric.label)");
    expect(viewerSource).toContain("formatViewerCell(metric.competitor, metric.label)");
    expect(viewerCss).toContain(".metricScope");
    expect(viewerSource).toContain('data-report-quality="partial"');
    expect(viewerSource).toContain("model.quality.notice");
    expect(viewerSource).toContain("data-report-supplement");
    expect(viewerSource).toContain("继续补采");
    expect(viewerCss).toContain(".qualityBanner");
    expect(viewerSource).not.toContain("dangerouslySetInnerHTML");
    expect(viewerSource).toContain('typeof value === "number" && Number.isFinite(value)');
    expect(viewerSource).not.toContain("isExactNumber(value)");
  });

  it("shows accessible immediate values for every finite growth-report curve point", () => {
    expect(viewerSource).toContain("interface ChartTooltipPayload");
    expect(viewerSource).toContain("function chartTooltipText(payload: ChartTooltipPayload)");
    expect(viewerSource).toContain("function SvgChartTooltip(");
    expect(viewerSource).toContain('data-chart-tooltip="svg"');
    expect(viewerSource).toContain("if (value == null) return null;");
    expect(viewerSource).toContain("data-chart-point={series}");
    expect(viewerSource).toContain('data-chart-point="subject-average"');
    expect(viewerSource).toContain("data-tooltip={tooltip}");
    expect(viewerSource).toContain("data-period={payload.period}");
    expect(viewerSource).toContain("data-metric={payload.metric}");
    expect(viewerSource).toContain("data-role={payload.role}");
    expect(viewerSource).toContain("tabIndex={0}");
    expect(viewerSource).toContain('focusable="true"');
    expect(viewerSource).toContain("aria-label={tooltip}");
    expect(viewerSource).toContain('r="10"');
    expect(viewerSource).toContain("<title>{tooltip}</title>");
    expect(viewerSource).toContain('metric: "平均日GMV"');
    expect(viewerSource).toContain("onPointerEnter");
    expect(viewerSource).toContain("onPointerMove");
    expect(viewerSource).toContain("onPointerLeave");
    expect(viewerSource).toContain("onFocus");
    expect(viewerSource).toContain("onBlur");
    expect(viewerCss).toContain(".chartPointHit");
    expect(viewerCss).toContain(".chartLineHit");
    expect(viewerCss).toContain(".svgTooltip");
    expect(viewerCss).toMatch(/@media print[\s\S]*?\.svgTooltip\s*\{[\s\S]*?display:\s*none\s*!important;/);
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
    expect(viewerCss).toMatch(/\.tableShell tbody\s*>\s*tr\s*>\s*td\.subject\s*\{[^}]*background-color:\s*var\(--dmp-subject\)\s*!important;[^}]*color:\s*var\(--dmp-subject-ink\)\s*!important;/s);
    expect(viewerCss).toMatch(/\.tableShell tbody\s*>\s*tr\s*>\s*td\.competitor\s*\{[^}]*background-color:\s*var\(--dmp-competitor\)\s*!important;[^}]*color:\s*var\(--dmp-competitor-ink\)\s*!important;/s);
    expect(viewerCss).toMatch(/\.tableShell tbody\s*>\s*tr\.subjectRow\s*>\s*td\s*\{[^}]*background-color:\s*var\(--dmp-subject\)\s*!important;/s);
    expect(viewerCss).toMatch(/\.tableShell tbody\s*>\s*tr\.competitorRow\s*>\s*td\s*\{[^}]*background-color:\s*var\(--dmp-competitor\)\s*!important;/s);
  });

  it("isolates every data cell from the dark AppShell table palette", () => {
    expect(viewerCss).toMatch(/\.root\s*\{[^}]*color-scheme:\s*light\s*!important;/s);
    expect(viewerCss).toMatch(/\.tableShell\s*\{[^}]*background:\s*#edf5f3;[^}]*color-scheme:\s*light\s*!important;/s);
    expect(viewerCss).toMatch(/\.tableShell table\s*\{[^}]*background:\s*#edf5f3;/s);
    expect(viewerCss).toMatch(/\.tableShell th,\s*\.tableShell td\s*\{[^}]*border-top:\s*0\s*!important;[^}]*color:\s*var\(--dmp-ink\)\s*!important;/s);
    expect(viewerCss).toMatch(/\.tableShell tbody\s*>\s*tr\s*>\s*td\s*\{[^}]*background-color:\s*#edf5f3\s*!important;/s);
    expect(viewerCss).toMatch(/\.tableShell tbody tr:nth-child\(even\)\s*>\s*td\s*\{[^}]*background-color:\s*#f9fbfb\s*!important;/s);
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
    expect(model.kpis).toEqual([
      { label: "总GMV", subject: "91539.13", competitor: "227027.62", scope: "2026-07-20 至 2026-08-18（30天）" },
      { label: "付费成交额", subject: "", competitor: "", scope: "2026-07-20 至 2026-08-18（30天）" },
      { label: "推广消耗", subject: "25942.88", competitor: "42242.14", scope: "2026-07-20 至 2026-08-18（30天）" },
      { label: "费比", subject: "28.34%", competitor: "18.61%", scope: "2026-07-20 至 2026-08-18（30天）" },
      { label: "ROI", subject: "2.31", competitor: "3.41", scope: "2026-07-20 至 2026-08-18（30天）" },
      { label: "PPC", subject: "1.23", competitor: "1.56", scope: "2026-07-20 至 2026-08-18（30天）" },
      { label: "付费金额占比", subject: "", competitor: "", scope: "2026-07-20 至 2026-08-18（30天）" },
      { label: "全域ROAS", subject: "3.53", competitor: "5.37", scope: "2026-07-20 至 2026-08-18（30天）" }
    ]);
    expect(model.kpis).toHaveLength(8);
    expect(model.quality.effectiveQuality).toBe("partial");
    expect(model.quality.notice).toContain("缺失值未按0计入");
  });

  it("prefers scoped overview rows and falls back one side at a time without replacing explicit zero", () => {
    const record = growthRecord();
    const partialScope = "对手已返回29/30日（2026-07-20 至 2026-08-17）";
    replaceTable(record, snapshot("报告总览", ["项目", "主体", "对手", "范围"], [
      ["商品ID", "768239824008", "563697874317", ""],
      ["总GMV", "100000", "200000", "30日严格同周期"],
      ["推广消耗", "0", "40000", partialScope],
      ["费比", "20%", "", partialScope],
      ["ROI", "0", "4.25", "30日严格同周期"],
      ["PPC", "", "1.75", "30日严格同周期"],
      ["全域ROAS", "5", "6.1", "30日严格同周期"]
    ]));

    const metrics = new Map(projectDmpReportForViewer(record).kpis.map((metric) => [metric.label, metric]));
    expect(metrics.get("总GMV")).toEqual({
      label: "总GMV", subject: "100000", competitor: "200000", scope: "30日严格同周期"
    });
    expect(metrics.get("推广消耗")).toEqual({
      label: "推广消耗", subject: "0", competitor: "40000", scope: partialScope
    });
    expect(metrics.get("费比")).toEqual({
      label: "费比", subject: "20%", competitor: "18.61%", scope: partialScope
    });
    expect(metrics.get("ROI")).toEqual({
      label: "ROI", subject: "0", competitor: "4.25", scope: "30日严格同周期"
    });
    expect(metrics.get("PPC")).toEqual({
      label: "PPC", subject: "1.23", competitor: "1.75", scope: "30日严格同周期"
    });
  });

  it("keeps paid-GMV, ROI and paid-PPC intervals visible without an exact relative difference", () => {
    const record = growthRecord();
    replaceTable(record, snapshot("对标总表", [
      "页面模块", "对标指标", "主体周期值", "对手周期值", "主体相对对手"
    ], [
      ["投放", "付费成交额", "234237.29", "800000.00~900000.00", "-70.72%"],
      ["投放", "ROI", "4.53", "10~11.25", "-59.73%"],
      ["投放", "付费PPC", "1.81", "1.59~2.12", "13.84%"],
      ["投放", "费比", "9.32%", "2.62%~3.10%", "6.22%~6.70%"]
    ]));
    replaceTable(record, snapshot("基础指标对比", [
      "指标", "本品值", "目标对手值", "主体相对对手"
    ], [
      ["付费成交额", "234237.29", "800000.00~900000.00", "-70.72%"]
    ]));

    const model = projectDmpReportForViewer(record);
    const benchmark = model.tables.find((table) => table.name === "对标总表");
    expect(benchmark?.rows).toEqual([
      ["投放", "付费成交额", "234237.29", "800000.00~900000.00", ""],
      ["投放", "ROI", "4.53", "10~11.25", ""],
      ["投放", "付费PPC", "1.81", "1.59~2.12", ""],
      ["投放", "费比", "9.32%", "2.62%~3.10%", "6.22%~6.70%"],
      ["投放", "付费金额占比", 2.558876, "3.5238~3.964275", ""]
    ]);
    expect(model.tables.find((table) => table.name === "基础指标对比")?.rows[0]).toEqual([
      "付费成交额", "234237.29", "800000.00~900000.00", ""
    ]);
    const kpis = new Map(model.kpis.map((metric) => [metric.label, metric]));
    expect(kpis.get("ROI")?.competitor).toBe("10~11.25");
    expect(kpis.get("PPC")?.competitor).toBe("1.59~2.12");
  });

  it("shows a non-empty optional price-band module and treats score columns as numeric", () => {
    const record = growthRecord();
    record.report.tables.splice(3, 0, snapshot("赛道价格带洞察", [
      "价格带区间", "增长潜力得分(dScore)", "蓝海指数原值(eScore)", "规则型指导"
    ], [["0~330", "1.83", "3.20", "依据：1.83；规则：同周期首位"]]));
    const model = projectDmpReportForViewer(record);
    const table = model.tables.find((candidate) => candidate.name === "赛道价格带洞察");
    expect(table?.rows).toHaveLength(1);
    expect(isDmpViewerMetricColumn(table!, 1)).toBe(true);
    expect(isDmpViewerMetricColumn(table!, 2)).toBe(true);
    expect(viewModelSource).toContain('赛道价格带洞察: "price-band"');
  });

  it("shows daily and channel modules only after their business values exist", () => {
    const record = growthRecord();
    addVisualTables(record);

    const model = projectDmpReportForViewer(record);
    expect(model.tables.map((table) => table.name)).toContain("日GMV与费比");
    expect(model.tables.map((table) => table.name)).toContain("渠道花费");
    expect(model.tables.find((table) => table.name === "日GMV与费比")?.columns).toEqual(pairedDailyColumns);
    const channel = model.tables.find((table) => table.name === "渠道花费");
    expect(channel?.columns).toEqual([
      "渠道", "页面指标", "对手30日消耗", "对手30日占比", "主体30日消耗", "主体30日占比"
    ]);
    expect(channel?.groupedChannel).toBe(false);
  });

  it("keeps a subject benchmark in the daily chart when the report has no exact subject-daily column", () => {
    const record = growthRecord();
    addVisualTables(record);
    const model = projectDmpReportForViewer(record);
    const daily = model.tables.find((table) => table.name === "日GMV与费比");
    const period = model.tables.find((table) => table.name === "周期汇总");
    if (!daily) throw new Error("missing daily fixture");

    expect(projectDailyGmvChartSeries(daily, period)).toEqual({
      competitorIndex: 2,
      subjectIndex: 1,
      competitorValues: [3200, 3600],
      subjectValues: [null, null],
      subjectAverage: 3051.3
    });
  });

  it("pairs every disclosed legacy daily dimension when GMV is already paired", () => {
    const record = growthRecord();
    replaceTable(record, snapshot("日GMV与费比", [
      "日期", "主体日GMV", "对手日GMV",
      "对手内容运营日消耗", "对手人群推广日消耗", "对手货品全站推日消耗",
      "对手线索推广日消耗", "对手关键词推广日消耗", "对手日总消耗", "对手日费比", "阶段"
    ], [[
      "2026-07-20", "0", "3200", "0", "100", "200", "—", "50", "350", "10.94%", "驱稳爬升期"
    ]]));

    const daily = projectDmpReportForViewer(record).tables.find((table) => table.name === "日GMV与费比");
    expect(daily?.columns).toEqual(pairedDailyColumns);
    expect(daily?.rows).toEqual([[
      "2026-07-20", "0", "3200",
      "", "0", "", "100", "", "200", "", "—", "", "50",
      "", "350", "", "10.94%", "驱稳爬升期"
    ]]);
  });

  it("adds the opposite-side placeholder whether the disclosed daily dimension is subject or competitor", () => {
    const record = growthRecord();
    replaceTable(record, snapshot("日GMV与费比", [
      "日期", "主体日GMV", "对手日总消耗", "主体日费比", "阶段"
    ], [["2026-07-20", "0", "350", "0%", "驱稳爬升期"]]));

    const daily = projectDmpReportForViewer(record).tables.find((table) => table.name === "日GMV与费比");
    expect(daily?.columns).toEqual([
      "日期", "主体日GMV", "对手日GMV",
      "主体日总消耗", "对手日总消耗", "主体日费比", "对手日费比", "阶段"
    ]);
    expect(daily?.rows).toEqual([[
      "2026-07-20", "0", "", "", "350", "0%", "", "驱稳爬升期"
    ]]);
  });

  it("normalizes an unprefixed legacy competitor column even when its subject counterpart exists", () => {
    const record = growthRecord();
    replaceTable(record, snapshot("日GMV与费比", [
      "日期", "主体日GMV", "日GMV", "阶段"
    ], [["2026-07-20", "1000", "3200", "驱稳爬升期"]]));

    const daily = projectDmpReportForViewer(record).tables.find((table) => table.name === "日GMV与费比");
    expect(daily?.columns).toEqual(["日期", "主体日GMV", "对手日GMV", "阶段"]);
    expect(daily?.rows).toEqual([["2026-07-20", "1000", "3200", "驱稳爬升期"]]);
  });

  it("does not project the complete 18-column daily table a second time", () => {
    const record = growthRecord();
    const row = [
      "2026-07-20", "1000", "3200",
      "0", "10", "20", "100", "30", "200", "0", "0", "40", "50",
      "90", "350", "9%", "10.94%", "驱稳爬升期"
    ];
    replaceTable(record, snapshot("日GMV与费比", pairedDailyColumns, [row]));

    const daily = projectDmpReportForViewer(record).tables.find((table) => table.name === "日GMV与费比");
    expect(daily?.columns).toEqual(pairedDailyColumns);
    expect(daily?.columns).toHaveLength(18);
    expect(daily?.rows).toEqual([row]);
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

  it("pairs subject and competitor rows by the same scene dimension without turning missing values into zero", () => {
    const record = growthRecord();
    replaceTable(record, snapshot("一级场景", [
      "对象", "层级", "一级场景", "二级场景", "场景编号", "消耗", "点击"
    ], [["对手", "1", "人群推广", "", "372", "1200", "400"]]));
    const table = projectDmpReportForViewer(record).tables.find((candidate) => candidate.name === "一级场景");
    expect(table?.rows).toEqual([
      ["主体", "1", "人群推广", "", "372", "", ""],
      ["对手", "1", "人群推广", "", "372", "1200", "400"]
    ]);
  });

  it("pairs legacy scene rows by scene names when only one side discloses a scene id", () => {
    const record = growthRecord();
    replaceTable(record, snapshot("一级场景", [
      "对象", "层级", "一级场景", "二级场景", "场景编号", "消耗", "点击"
    ], [
      ["主体", "1", "人群推广", "", "", "300", "60"],
      ["对手", "1", "人群推广", "", "372", "1200", "400"]
    ]));
    const table = projectDmpReportForViewer(record).tables.find((candidate) => candidate.name === "一级场景");
    expect(table?.rows).toEqual([
      ["主体", "1", "人群推广", "", "", "300", "60"],
      ["对手", "1", "人群推广", "", "372", "1200", "400"]
    ]);
  });

  it("projects legacy keyword role rows into same-dimension subject and competitor columns", () => {
    const record = growthRecord();
    replaceTable(record, snapshot("关键词样本", ["对象", "关键词", "词类型", "展现", "点击", "CTR"], [
      ["对手", "蜂蜜", "趋势机会词", "2000", "80", "4%"],
      ["主体", "蜂蜜", "趋势机会词", "1200", "60", "5%"],
      ["对手", "蜂蜜礼盒", "类目热门词", "900", "30", "3.33%"]
    ]));
    const table = projectDmpReportForViewer(record).tables.find((candidate) => candidate.name === "关键词样本");
    expect(table?.columns).toEqual([
      "关键词", "词类型", "主体展现", "对手展现", "主体点击", "对手点击", "主体CTR", "对手CTR"
    ]);
    expect(table?.rows).toEqual([
      ["蜂蜜", "趋势机会词", "1200", "2000", "60", "80", "5%", "4%"],
      ["蜂蜜礼盒", "类目热门词", "", "900", "", "30", "", "3.33%"]
    ]);
  });
});

function growthRecord(): DmpBusinessReportRecord {
  const tables = DMP_GROWTH_REPORT_TABLES.map((name) => {
    if (name === "报告总览") return snapshot(name, ["项目", "主体", "对手", "范围"], [
      ["商品ID", "768239824008", "563697874317", "2026-07-20 至 2026-08-18"]
    ]);
    if (name === "对标总表") return snapshot(name, ["页面模块", "对标指标", "主体周期值", "对手周期值", "主体相对对手"], [
      ["周期汇总", "总GMV", "91539.13", "227027.62", "-59.68%"],
      ["投放", "ROI", "2.31", "3.41", "-32.26%"],
      ["投放", "PPC", "1.23", "1.56", "-21.15%"]
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
      ["总GMV", "91539.13", "227027.62", "-59.68%"],
      ["ROI", "9.99", "9.99", "0%"],
      ["PPC", "9.99", "9.99", "0%"]
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
