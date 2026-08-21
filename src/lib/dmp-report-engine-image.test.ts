import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { canonicalToDmpReport } from "@/lib/dmp-report-import";
import type { DmpCanonicalReport } from "@/lib/dmp-report-types";

const engineSource = readFileSync(
  new URL("../../public/tools/dmp-report-engine/report-engine.js", import.meta.url),
  "utf8"
);

const CHANNELS = [
  ["content", "内容运营"],
  ["crowd", "人群推广"],
  ["goods", "货品全站推"],
  ["lead", "线索推广"],
  ["keyword", "关键词推广"]
] as const;

describe("DMP report product-image upload contract", () => {
  it("keeps the captured subject and competitor pictures from report generation through viewer projection", () => {
    const subjectPicture = "https://img.alicdn.com/subject-main.jpg";
    const competitorPicture = "//img.alicdn.com/competitor-main.jpg";
    const model = growthModel(subjectPicture, competitorPicture);
    const context: Record<string, unknown> = {
      URL,
      DmpCompletenessEngine: {
        CHANNELS,
        deriveGrowth: () => model
      }
    };
    runInNewContext(engineSource, context, { filename: "report-engine.js" });
    const engine = context.DmpReportEngine as {
      buildReport: (records: unknown[], itemId: string, meta: Record<string, unknown>) => {
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
