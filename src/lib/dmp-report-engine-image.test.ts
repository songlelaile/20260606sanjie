import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { canonicalToDmpReport } from "@/lib/dmp-report-import";
import type { DmpCanonicalReport } from "@/lib/dmp-report-types";

const engineSource = readFileSync(
  new URL("../../public/tools/dmp-report-engine/report-engine.js", import.meta.url),
  "utf8"
);
const completenessSource = readFileSync(
  new URL("../../public/tools/dmp-report-engine/completeness-engine.js", import.meta.url),
  "utf8"
);

function reportEngineForModel(model: unknown) {
  const context: Record<string, unknown> = { URL, URLSearchParams };
  runInNewContext(completenessSource, context, { filename: "completeness-engine.js" });
  const completeness = context.DmpCompletenessEngine as { deriveGrowth: () => unknown };
  completeness.deriveGrowth = () => model;
  runInNewContext(engineSource, context, { filename: "report-engine.js" });
  return context.DmpReportEngine;
}

const CHANNELS = [
  ["content", "内容运营"],
  ["crowd", "人群推广"],
  ["goods", "货品全站推"],
  ["lead", "线索推广"],
  ["keyword", "关键词推广"]
] as const;

describe("DMP subject promotion minimum contract", () => {
  it("freezes spend, fee ratio, ROI and PPC for both archive and report generation", () => {
    const context: Record<string, unknown> = { URL };
    runInNewContext(completenessSource, context, { filename: "completeness-engine.js" });
    runInNewContext(engineSource, context, { filename: "report-engine.js" });
    const completeness = context.DmpCompletenessEngine as {
      SUBJECT_MINIMUM_PROMOTION_CONTRACT: ReadonlyArray<{ key: string; label: string }>;
      missingSubjectMinimumPromotionMetrics: (metrics: Record<string, unknown>) => Array<{ key: string }>;
    };
    const report = context.DmpReportEngine as {
      SUBJECT_MINIMUM_PROMOTION_CONTRACT: ReadonlyArray<{ key: string; label: string }>;
    };

    expect(Object.isFrozen(completeness.SUBJECT_MINIMUM_PROMOTION_CONTRACT)).toBe(true);
    expect(completeness.SUBJECT_MINIMUM_PROMOTION_CONTRACT.map(({ key, label }) => [key, label])).toEqual([
      ["spend", "推广消耗"],
      ["feeRatio", "费比"],
      ["roi", "ROI"],
      ["ppc", "PPC"]
    ]);
    expect(report.SUBJECT_MINIMUM_PROMOTION_CONTRACT).toBe(completeness.SUBJECT_MINIMUM_PROMOTION_CONTRACT);
    expect(completeness.missingSubjectMinimumPromotionMetrics({
      spend: 100,
      feeRatio: 0.1,
      roi: null,
      ppc: 2,
      marketingClicks: 50
    }).map(({ key }) => key)).toEqual(["roi"]);
  });
});

describe("DMP report product-image upload contract", () => {
  it("keeps the captured subject and competitor pictures from report generation through viewer projection", () => {
    const subjectPicture = "https://img.alicdn.com/subject-main.jpg";
    const competitorPicture = "//img.alicdn.com/competitor-main.jpg";
    const model = growthModel(subjectPicture, competitorPicture);
    const engine = reportEngineForModel(model) as {
      buildReport: (records: unknown[], itemId: string, meta: Record<string, unknown>) => {
        title: string;
        item: Record<string, string>;
        tables: Array<{ name: string; columns: string[]; rows: unknown[][] }>;
      };
      toCanonicalReport: (report: unknown) => DmpCanonicalReport;
    };

    const report = engine.buildReport([], "41564682336", {
      successItemId: "568167762679",
      periodPrecision: "exact",
      finishedAt: "2026-08-21T09:30:00.000Z"
    });
    const canonical = engine.toCanonicalReport(report);
    const productTable = canonical.tables.find((table) => table.name === "商品与成功品");
    const mediaIndex = productTable?.columns.indexOf("图片/详情") ?? -1;

    expect(report.title).toBe("达摩盘商品成长竞品对标报告｜少壮AI自动化");
    expect(report.item).toMatchObject({
      pictureUrl: subjectPicture,
      detailUrl: "https://detail.tmall.com/item.htm?id=41564682336",
      competitorPictureUrl: competitorPicture
    });
    expect(mediaIndex).toBeGreaterThanOrEqual(0);
    expect(productTable?.rows[0]?.cells[mediaIndex]).toBe(subjectPicture);
    expect(canonical.render_data?.products).toEqual({
      subject: {
        picture_url: subjectPicture,
        detail_url: "https://detail.tmall.com/item.htm?id=41564682336"
      },
      competitor: {
        picture_url: "https://img.alicdn.com/competitor-main.jpg"
      }
    });
    expect(canonical.render_data?.subject_daily_gmv).toEqual([
      { date: "2026-08-20", gmv: "200" }
    ]);

    const viewerReport = canonicalToDmpReport(canonical);
    expect(viewerReport?.item).toMatchObject({
      pictureUrl: subjectPicture,
      detailUrl: "https://detail.tmall.com/item.htm?id=41564682336",
      competitorPictureUrl: "https://img.alicdn.com/competitor-main.jpg"
    });
  });
});

describe("DMP report overview ROI disclosure contract", () => {
  it("keeps an exact subject ROI and removes an unvalidated competitor ROI from every output table", () => {
    const baseModel = growthModel("https://img.alicdn.com/subject-main.jpg", "//img.alicdn.com/competitor-main.jpg");
    const model = {
      ...baseModel,
      metrics: {
        subject: {
          ...baseModel.metrics.subject,
          paidGmv: 2560.69,
          spend: 1254.78,
          roi: 2.04
        },
        competitor: {
          ...baseModel.metrics.competitor,
          paidGmv: "50000.00~60000.00",
          spend: 16766.52,
          roi: "比本品高"
        }
      }
    };
    const engine = reportEngineForModel(model) as {
      buildReport: (records: unknown[], itemId: string, meta: Record<string, unknown>) => {
        tables: Array<{
          name: string;
          rows: unknown[][];
          overviewMetrics?: Array<{ key: string; subject: unknown; competitor: unknown }>;
          kpis?: Array<{ label: string; value: unknown }>;
        }>;
      };
      toCanonicalReport: (report: unknown) => DmpCanonicalReport;
    };
    const report = engine.buildReport([], "41564682336", {
      successItemId: "568167762679",
      periodPrecision: "exact",
      finishedAt: "2026-08-21T09:30:00.000Z"
    });
    const overview = report.tables.find((table) => table.name === "报告总览");
    const benchmark = report.tables.find((table) => table.name === "对标总表");
    const base = report.tables.find((table) => table.name === "基础指标对比");

    expect(overview?.rows.find((row) => row[0] === "ROI")?.slice(1, 3)).toEqual([2.04, ""]);
    expect(overview?.overviewMetrics?.find((metric) => metric.key === "roi")).toMatchObject({
      subject: 2.04,
      competitor: ""
    });
    expect(overview?.kpis?.filter((kpi) => kpi.label.endsWith("ROI")).map((kpi) => kpi.value)).toEqual([
      2.04,
      ""
    ]);
    expect(benchmark?.rows.find((row) => row[1] === "ROI")?.slice(2, 4)).toEqual([2.04, ""]);
    expect(base?.rows.find((row) => row[0] === "ROI")?.slice(1, 3)).toEqual([2.04, ""]);

    const canonicalOverview = engine.toCanonicalReport(report).tables.find((table) => table.name === "报告总览");
    expect(canonicalOverview?.rows.find((row) => row.cells[0] === "ROI")?.cells.slice(1, 3)).toEqual([
      "2.04",
      ""
    ]);
  });
});

function growthModel(subjectPicture: string, competitorPicture: string) {
  const channelSpend = Object.fromEntries(CHANNELS.map(([, label]) => [label, 0]));
  const metric = {
    orders: 10,
    aov: 20,
    totalGmv: 200,
    visitors: 100,
    spend: 20,
    feeRatio: 0.1,
    roas: 10,
    paidGmv: 20,
    roi: 1,
    ppc: 1,
    conversion: 0.1,
    keywordShare: 0,
    channelHhi: 0,
    paidGmvContribution: 0.1,
    paidOrderContribution: 0.1,
    marketingClicks: 20,
    naturalClicks: 80,
    cartRate: 0.2
  };
  const targetSuccess = {
    itemId: "568167762679",
    title: "目标商品",
    pictureUrl: competitorPicture,
    description: "",
    labels: [],
    source: "selected"
  };
  return {
    period: { days: 1, startDate: "2026-08-20", endDate: "2026-08-20" },
    item: {
      itemId: "41564682336",
      title: "主体商品",
      pictureUrl: subjectPicture,
      detailUrl: "https://detail.tmall.com/item.htm?id=41564682336"
    },
    targetSuccess,
    successItems: [targetSuccess],
    metrics: { subject: { ...metric }, competitor: { ...metric } },
    daily: {
      rows: [{
        date: "2026-08-20",
        dailyGmv: 200,
        channelSpend,
        totalSpend: 20,
        feeRatio: 0.1,
        stage: "成长期"
      }],
      totalSpend: 20,
      channelSpend,
      spendCoverageDays: 1,
      spendExpectedDays: 1,
      spendMissingDates: [],
      spendPartial: false
    },
    subjectDaily: {
      complete: true,
      rows: [{ date: "2026-08-20", orders: 10, aov: 20, gmv: 200 }]
    },
    sceneRows: { level1: [], level2: [] },
    stages: [],
    keywords: [],
    completeness: {
      status: "ready",
      businessRecords: 1,
      endpointCoverage: [],
      blockingIssues: [],
      warnings: [],
      parsedRecords: 1,
      failedRecords: 0
    }
  };
}
