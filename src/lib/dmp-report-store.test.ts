import { beforeEach, describe, expect, it, vi } from "vitest";
import { DMP_COMPETITION_REPORT_TABLES, DMP_GROWTH_REPORT_TABLES } from "@/lib/dmp-report-types";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findMany: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  prisma: {
    dmpBusinessReport: {
      create: mocks.create,
      findMany: mocks.findMany
    }
  }
}));
vi.mock("@/lib/server-session", () => ({ getCurrentSession: vi.fn() }));
vi.mock("@/lib/tool-entitlements", () => ({ getDmpAutomationAccessForSession: vi.fn() }));

import {
  listDmpBusinessReports,
  saveDmpBusinessReport,
  validateDmpCanonicalReport
} from "@/lib/dmp-report-store";

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

function growthReport() {
  const start = Date.parse("2026-07-20T00:00:00Z");
  const daily = Array.from({ length: 30 }, (_, index) => ({
    date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    gmv: index === 29 ? "160" : "100"
  }));
  return {
    schema_version: "3.0",
    title: "达摩盘商品成长竞品对标报告",
    item_id: "768239824008",
    period: "2026-07-20 至 2026-08-18",
    tables: DMP_GROWTH_REPORT_TABLES.map((name) => {
      if (name === "周期汇总") return {
        name,
        columns: ["商品ID", "对象", "总GMV"],
        rows: [
          { cells: ["768239824008", "主体", "3060"] },
          { cells: ["563697874317", "目标对手", "5000"] }
        ]
      };
      return { name, columns: ["指标"], rows: [{ cells: ["—"] }] };
    }),
    render_data: {
      version: "1",
      generated_at: "2026-08-20T20:41:59+08:00",
      products: {
        subject: {
          picture_url: "https://img.alicdn.com/subject.png",
          detail_url: "https://item.taobao.com/item.htm?id=768239824008&token=secret&webOpSessionId=private#payload"
        },
        competitor: {
          picture_url: "javascript:alert(1)",
          detail_url: "http://item.taobao.com/item.htm?id=563697874317"
        }
      },
      subject_daily_gmv: daily,
      tables: [
        { name: "周期汇总", subtitle: "主体与目标对手周期汇总", widths: [30, 20, 24] },
        { name: "报告总览", subtitle: "\u0000报告总览", widths: [3] },
        { name: "未知表", subtitle: "不应保存", widths: [100] }
      ]
    }
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

describe("DMP growth render_data storage contract", () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.findMany.mockReset();
  });

  it("preserves only closed, ordered and HTTPS-safe optional render data", () => {
    const checked = validateDmpCanonicalReport(growthReport());
    expect(checked.error).toBeUndefined();
    expect(checked.report?.render_data).toEqual({
      version: "1",
      generated_at: "2026-08-20T12:41:59.000Z",
      products: {
        subject: {
          picture_url: "https://img.alicdn.com/subject.png",
          detail_url: "https://item.taobao.com/item.htm?id=768239824008"
        }
      },
      subject_daily_gmv: growthReport().render_data.subject_daily_gmv,
      tables: [
        { name: "报告总览", subtitle: "报告总览" },
        { name: "周期汇总", subtitle: "主体与目标对手周期汇总", widths: [30, 20, 24] }
      ]
    });
  });

  it("ignores an unclosed or incomplete subject series without rejecting legacy business tables", () => {
    const report = growthReport();
    report.render_data.subject_daily_gmv[0].gmv = "99";
    report.render_data.subject_daily_gmv.pop();
    const checked = validateDmpCanonicalReport(report);
    expect(checked.error).toBeUndefined();
    expect(checked.report?.render_data?.subject_daily_gmv).toBeUndefined();
    expect(checked.report?.render_data?.products?.subject?.picture_url).toBe("https://img.alicdn.com/subject.png");
  });

  it("ignores subject series with duplicate, out-of-order or negative daily values", () => {
    for (const mutate of [
      (report: ReturnType<typeof growthReport>) => report.render_data.subject_daily_gmv.reverse(),
      (report: ReturnType<typeof growthReport>) => { report.render_data.subject_daily_gmv[1].date = report.render_data.subject_daily_gmv[0].date; },
      (report: ReturnType<typeof growthReport>) => { report.render_data.subject_daily_gmv[0].gmv = "-1"; }
    ]) {
      const report = growthReport();
      mutate(report);
      expect(validateDmpCanonicalReport(report).report?.render_data?.subject_daily_gmv).toBeUndefined();
    }
  });

  it("keeps reports without render_data byte-for-byte compatible at the canonical field level", () => {
    const report = growthReport();
    delete (report as { render_data?: unknown }).render_data;
    const checked = validateDmpCanonicalReport(report);
    expect(checked.error).toBeUndefined();
    expect(checked.report).not.toHaveProperty("render_data");
  });

  it("treats an empty render_data marker as legacy instead of changing calculation behavior", () => {
    const report = growthReport();
    report.render_data = { version: "1" } as typeof report.render_data;
    const checked = validateDmpCanonicalReport(report);
    expect(checked.error).toBeUndefined();
    expect(checked.report).not.toHaveProperty("render_data");
  });

  it("persists and reads both product thumbnails inside the canonical report JSON", async () => {
    const report = growthReport();
    report.render_data.products.competitor.picture_url = "https://img.alicdn.com/competitor.png";
    const checked = validateDmpCanonicalReport(report);
    expect(checked.error).toBeUndefined();
    const canonical = checked.report!;
    const createdAt = new Date("2026-08-22T00:00:00.000Z");
    mocks.create.mockResolvedValue({
      id: "report-with-images",
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      period: canonical.period,
      quality: "complete",
      createdAt
    });

    const saved = await saveDmpBusinessReport({
      access: { tenantId: "tenant-a", userId: "user-a" },
      report: canonical,
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      quality: "complete",
      sourceVersion: "2.1.6"
    });
    const storedReport = mocks.create.mock.calls[0]?.[0]?.data?.report;
    expect(storedReport?.render_data?.products).toEqual({
      subject: {
        picture_url: "https://img.alicdn.com/subject.png",
        detail_url: "https://item.taobao.com/item.htm?id=768239824008"
      },
      competitor: { picture_url: "https://img.alicdn.com/competitor.png" }
    });
    expect(saved.report.render_data?.products).toEqual(storedReport.render_data.products);

    mocks.findMany.mockResolvedValue([{
      id: saved.id,
      subjectItemId: saved.subjectItemId,
      competitorItemId: saved.competitorItemId,
      period: saved.period,
      quality: saved.quality,
      createdAt,
      report: storedReport
    }]);
    await expect(listDmpBusinessReports({ tenantId: "tenant-a", userId: "user-a" }))
      .resolves.toMatchObject([{
        report: {
          render_data: {
            products: {
              subject: { picture_url: "https://img.alicdn.com/subject.png" },
              competitor: { picture_url: "https://img.alicdn.com/competitor.png" }
            }
          }
        }
      }]);
  });
});
