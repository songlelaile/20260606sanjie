import { beforeEach, describe, expect, it, vi } from "vitest";
import { DMP_COMPETITION_REPORT_TABLES, DMP_GROWTH_REPORT_TABLES } from "@/lib/dmp-report-types";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  findMany: vi.fn(),
  reportGetFindFirst: vi.fn(),
  transaction: vi.fn(),
  shopFindFirst: vi.fn(),
  shopFindMany: vi.fn(),
  reportFindFirst: vi.fn(),
  reportCount: vi.fn(),
  reportUpdateMany: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  prisma: {
    dmpBusinessReport: {
      findMany: mocks.findMany,
      findFirst: mocks.reportGetFindFirst
    },
    $transaction: mocks.transaction
  }
}));
vi.mock("@/lib/server-session", () => ({ getCurrentSession: vi.fn() }));
vi.mock("@/lib/tool-entitlements", () => ({ getDmpAutomationAccessForSession: vi.fn() }));

import {
  assignDmpBusinessReportsShop,
  dmpBusinessReportFingerprint,
  getDmpBusinessReport,
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

  it("keeps identity issues visible but accepts reordered business tables for partial archive", () => {
    expect(validateDmpCanonicalReport(competitionReport([])).issues).toContain("竞店 ID 待补充");
    const reordered = competitionReport();
    reordered.tables.reverse();
    const checked = validateDmpCanonicalReport(reordered);
    expect(checked.error).toBeUndefined();
    expect(checked.issues).toContain("业务表顺序或附加模块已兼容归档");
    expect(checked.report?.tables.map((table) => table.name)).toEqual(DMP_COMPETITION_REPORT_TABLES);
  });

  it("rejects a competition identity with more than three raw or combined competitor IDs", () => {
    expect(validateDmpCanonicalReport(competitionReport([
      "589538478",
      "342744019",
      "279364801",
      "623803508105"
    ])).error).toContain("最多允许 3 个竞店 ID");
    expect(validateDmpCanonicalReport(competitionReport(["589538478", "342744019", "279364801"]), {
      competitorItemId: "623803508105"
    }).error).toContain("最多允许 3 个竞店 ID");
  });
});

describe("DMP growth render_data storage contract", () => {
  beforeEach(() => {
    mocks.upsert.mockReset();
    mocks.findMany.mockReset();
    mocks.reportGetFindFirst.mockReset();
    mocks.transaction.mockReset();
    mocks.shopFindFirst.mockReset();
    mocks.shopFindMany.mockReset();
    mocks.reportFindFirst.mockReset();
    mocks.reportCount.mockReset();
    mocks.reportUpdateMany.mockReset();
    mocks.reportFindFirst.mockResolvedValue(null);
    mocks.shopFindMany.mockResolvedValue([]);
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work({
      shop: {
        findFirst: mocks.shopFindFirst,
        findMany: mocks.shopFindMany
      },
      dmpBusinessReport: {
        upsert: mocks.upsert,
        findFirst: mocks.reportFindFirst,
        count: mocks.reportCount,
        updateMany: mocks.reportUpdateMany
      }
    }));
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

  it("repairs invalid channel-spend row widths and still returns an archivable report", () => {
    const report = growthReport();
    const channel = report.tables.find((table) => table.name === "渠道花费")!;
    channel.columns = ["渠道", "主体30日消耗"];
    channel.rows = [
      { cells: ["人群推广", "3921.86", "15.12%"] },
      { cells: ["货品全站推"] }
    ];

    const checked = validateDmpCanonicalReport(report);

    expect(checked.error).toBeUndefined();
    expect(checked.issues).toContain("业务表「渠道花费」列结构无效，已自动对齐");
    expect(checked.report?.tables.find((table) => table.name === "渠道花费")).toEqual({
      name: "渠道花费",
      columns: ["渠道", "主体30日消耗", "列3"],
      rows: [
        { cells: ["人群推广", "3921.86", "15.12%"] },
        { cells: ["货品全站推", "", ""] }
      ]
    });
  });

  it.each([
    ["table name", (report: ReturnType<typeof growthReport>) => { (report.tables[0] as { name: string }).name = "session"; }],
    ["column name", (report: ReturnType<typeof growthReport>) => { report.tables[0].columns[0] = "authorization"; }],
    ["cell value", (report: ReturnType<typeof growthReport>) => { report.tables[0].rows[0].cells[0] = "https://example.test/?token=private"; }],
    ["signed field", (report: ReturnType<typeof growthReport>) => { report.tables[0].rows[0].cells[0] = "signData=private"; }],
    ["report title", (report: ReturnType<typeof growthReport>) => { report.title = "authorization=Bearer private"; }],
    ["report period", (report: ReturnType<typeof growthReport>) => { report.period = "session=private"; }],
    ["render subtitle", (report: ReturnType<typeof growthReport>) => {
      report.render_data.tables[0].subtitle = "token=private";
    }]
  ])("rejects sensitive authentication material retained in the final %s", (_label, mutate) => {
    const report = growthReport();
    mutate(report);
    expect(validateDmpCanonicalReport(report)).toEqual({ error: "报告包含敏感鉴权字段，禁止归档" });
  });

  it("does not reject sensitive-looking fields that are discarded before archive", () => {
    const report = growthReport() as ReturnType<typeof growthReport> & {
      transport_debug?: { authorization: string };
    };
    report.transport_debug = { authorization: "Bearer private" };

    const checked = validateDmpCanonicalReport(report);

    expect(checked.error).toBeUndefined();
    expect(checked.report).not.toHaveProperty("transport_debug");
  });

  it("rejects normalization amplification beyond the global cell-count limit", () => {
    const report = growthReport();
    const channel = report.tables.find((table) => table.name === "渠道花费")!;
    channel.columns = Array.from({ length: 100 }, (_, index) => `列${index + 1}`);
    channel.rows = Array.from({ length: 3_000 }, () => ({ cells: [""] }));

    expect(validateDmpCanonicalReport(report)).toEqual({ error: "报告单元格总量超过保存上限" });
  });

  it("rechecks the two-megabyte limit after row-width normalization", () => {
    const report = growthReport();
    const channel = report.tables.find((table) => table.name === "渠道花费")!;
    channel.columns = Array.from({ length: 100 }, (_, index) => `列${index + 1}`);
    channel.rows = Array.from({ length: 1_800 }, () => ({ cells: ["x".repeat(900)] }));

    expect(Buffer.byteLength(JSON.stringify(report), "utf8")).toBeLessThan(2 * 1024 * 1024);
    expect(validateDmpCanonicalReport(report)).toEqual({ error: "规范化后的报告内容超过保存上限" });
  });

  it("keeps legacy history rows visible by restoring report identity from scoped database columns", async () => {
    const legacyReport = growthReport();
    delete (legacyReport as { item_id?: unknown }).item_id;
    const createdAt = new Date("2026-08-22T05:00:00.000Z");
    const stored = {
      id: "legacy-report",
      shopId: null,
      shop: null,
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      period: legacyReport.period,
      quality: "partial",
      createdAt,
      report: legacyReport
    };
    mocks.findMany.mockResolvedValue([stored]);
    mocks.reportGetFindFirst.mockResolvedValue(stored);

    const access = { tenantId: "tenant-a", userId: "user-a" };
    await expect(listDmpBusinessReports(access)).resolves.toMatchObject([{
      id: "legacy-report",
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      report: { item_id: "768239824008" }
    }]);
    await expect(getDmpBusinessReport(access, "legacy-report")).resolves.toMatchObject({
      id: "legacy-report",
      report: { item_id: "768239824008" }
    });
  });

  it("persists and reads both product thumbnails inside the canonical report JSON", async () => {
    const report = growthReport();
    report.render_data.products.competitor.picture_url = "https://img.alicdn.com/competitor.png";
    const checked = validateDmpCanonicalReport(report);
    expect(checked.error).toBeUndefined();
    const canonical = checked.report!;
    const createdAt = new Date("2026-08-22T00:00:00.000Z");
    mocks.upsert.mockResolvedValue({
      id: "report-with-images",
      shop: null,
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      period: canonical.period,
      quality: "complete",
      createdAt,
      report: canonical
    });

    const saved = await saveDmpBusinessReport({
      access: { tenantId: "tenant-a", userId: "user-a" },
      report: canonical,
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      quality: "complete",
      sourceVersion: "2.1.6"
    });
    const storedReport = mocks.upsert.mock.calls[0]?.[0]?.create?.report;
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
      shopId: "shop-a",
      shop: { id: "shop-a", name: "西西礼" },
      subjectItemId: saved.subjectItemId,
      competitorItemId: saved.competitorItemId,
      period: saved.period,
      quality: saved.quality,
      createdAt,
      report: storedReport
    }]);
    await expect(listDmpBusinessReports({ tenantId: "tenant-a", userId: "user-a" }))
      .resolves.toMatchObject([{
        shopId: "shop-a",
        shopName: "西西礼",
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

  it("upserts retries by a stable SHA-256 fingerprint that ignores only generated_at", async () => {
    const first = validateDmpCanonicalReport(growthReport()).report!;
    const retry = structuredClone(first);
    retry.render_data!.generated_at = "2026-08-22T03:04:05.000Z";
    const changed = structuredClone(retry);
    changed.tables[0].rows[0].cells[0] = "不同数据";
    const identity = {
      subjectItemId: "768239824008",
      competitorItemId: "563697874317"
    };
    const fingerprint = dmpBusinessReportFingerprint({ ...identity, report: first });

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(dmpBusinessReportFingerprint({ ...identity, report: retry })).toBe(fingerprint);
    expect(dmpBusinessReportFingerprint({ ...identity, report: changed })).not.toBe(fingerprint);

    const createdAt = new Date("2026-08-22T04:00:00.000Z");
    mocks.upsert.mockResolvedValue({
      id: "one-id-for-both-attempts",
      shop: null,
      ...identity,
      period: first.period,
      quality: "complete",
      createdAt,
      report: first
    });
    const save = (report: typeof first) => saveDmpBusinessReport({
      access: { tenantId: "tenant-a", userId: "user-a" },
      report,
      ...identity,
      quality: "complete",
      sourceVersion: "2.1.6"
    });

    const [savedFirst, savedRetry] = await Promise.all([save(first), save(retry)]);

    expect(savedFirst.id).toBe("one-id-for-both-attempts");
    expect(savedRetry.id).toBe(savedFirst.id);
    expect(savedRetry.report.render_data?.generated_at).toBe(first.render_data?.generated_at);
    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    for (const [input] of mocks.upsert.mock.calls) {
      expect(input).toMatchObject({
        where: {
          tenantId_userId_fingerprint: {
            tenantId: "tenant-a",
            userId: "user-a",
            fingerprint
          }
        },
        create: { fingerprint },
        update: {}
      });
    }
  });

  it("inherits the latest shop for the same user and canonical subject/competitor pair", async () => {
    const canonical = validateDmpCanonicalReport(growthReport()).report!;
    const createdAt = new Date("2026-08-22T01:00:00.000Z");
    mocks.reportFindFirst.mockResolvedValue({ shop: { id: "shop-recent", name: "最近店铺" } });
    mocks.upsert.mockResolvedValue({
      id: "report-inherited-shop",
      shop: { id: "shop-recent", name: "最近店铺" },
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      period: canonical.period,
      quality: "complete",
      createdAt,
      report: canonical
    });

    const saved = await saveDmpBusinessReport({
      access: { tenantId: "tenant-a", userId: "user-a" },
      report: canonical,
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      quality: "complete",
      sourceVersion: "2.1.6"
    });

    expect(mocks.reportFindFirst).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-a",
        userId: "user-a",
        subjectItemId: "768239824008",
        competitorItemId: "563697874317"
      },
      orderBy: { createdAt: "desc" },
      select: { shop: { select: { id: true, name: true } } }
    });
    expect(mocks.shopFindMany).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ shopId: "shop-recent" })
    }));
    expect(saved).toMatchObject({ shopId: "shop-recent", shopName: "最近店铺" });
  });

  it("uses the tenant's only shop when the canonical pair has no previous assignment", async () => {
    const canonical = validateDmpCanonicalReport(growthReport()).report!;
    const createdAt = new Date("2026-08-22T02:00:00.000Z");
    mocks.shopFindMany.mockResolvedValue([{ id: "only-shop", name: "唯一店铺" }]);
    mocks.upsert.mockResolvedValue({
      id: "report-only-shop",
      shop: { id: "only-shop", name: "唯一店铺" },
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      period: canonical.period,
      quality: "complete",
      createdAt,
      report: canonical
    });

    const saved = await saveDmpBusinessReport({
      access: { tenantId: "tenant-a", userId: "user-a" },
      report: canonical,
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      quality: "complete",
      sourceVersion: "2.1.6"
    });

    expect(mocks.shopFindMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-a" },
      orderBy: { createdAt: "asc" },
      take: 2,
      select: { id: true, name: true }
    });
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ shopId: "only-shop" })
    }));
    expect(saved).toMatchObject({ shopId: "only-shop", shopName: "唯一店铺" });
  });

  it("leaves a new report unassigned when multiple shops exist and the pair has no history", async () => {
    const canonical = validateDmpCanonicalReport(growthReport()).report!;
    const createdAt = new Date("2026-08-22T03:00:00.000Z");
    mocks.shopFindMany.mockResolvedValue([
      { id: "shop-a", name: "店铺 A" },
      { id: "shop-b", name: "店铺 B" }
    ]);
    mocks.upsert.mockResolvedValue({
      id: "report-unassigned",
      shop: null,
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      period: canonical.period,
      quality: "complete",
      createdAt,
      report: canonical
    });

    const saved = await saveDmpBusinessReport({
      access: { tenantId: "tenant-a", userId: "user-a" },
      report: canonical,
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      quality: "complete",
      sourceVersion: "2.1.6"
    });

    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ shopId: null })
    }));
    expect(saved).not.toHaveProperty("shopId");
    expect(saved).not.toHaveProperty("shopName");
  });

  it("assigns only owned reports to a tenant-scoped shop and supports returning to unassigned", async () => {
    mocks.shopFindFirst.mockResolvedValue({ id: "shop-a", name: "西西礼" });
    mocks.reportCount.mockResolvedValue(2);
    mocks.reportUpdateMany.mockResolvedValue({ count: 2 });

    await expect(assignDmpBusinessReportsShop({
      access: { tenantId: "tenant-a", userId: "user-a" },
      reportIds: ["report-a", "report-b", "report-a"],
      shopId: "shop-a"
    })).resolves.toEqual({
      ok: true,
      reportIds: ["report-a", "report-b"],
      shop: { id: "shop-a", name: "西西礼" }
    });
    expect(mocks.shopFindFirst).toHaveBeenCalledWith({
      where: { id: "shop-a", tenantId: "tenant-a" },
      select: { id: true, name: true }
    });
    expect(mocks.reportUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: "tenant-a", userId: "user-a" }),
      data: { shopId: "shop-a" }
    }));

    mocks.reportCount.mockResolvedValue(1);
    await expect(assignDmpBusinessReportsShop({
      access: { tenantId: "tenant-a", userId: "user-a" },
      reportIds: ["report-a"],
      shopId: ""
    })).resolves.toEqual({ ok: true, reportIds: ["report-a"], shop: null });
    expect(mocks.reportUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: { shopId: null } }));
  });

  it("rejects foreign shops and mixed-ownership report batches before updating", async () => {
    mocks.shopFindFirst.mockResolvedValue(null);
    await expect(assignDmpBusinessReportsShop({
      access: { tenantId: "tenant-a", userId: "user-a" },
      reportIds: ["report-a"],
      shopId: "foreign-shop"
    })).resolves.toMatchObject({ ok: false, status: 404 });
    expect(mocks.reportUpdateMany).not.toHaveBeenCalled();

    mocks.shopFindFirst.mockResolvedValue({ id: "shop-a", name: "西西礼" });
    mocks.reportCount.mockResolvedValue(1);
    await expect(assignDmpBusinessReportsShop({
      access: { tenantId: "tenant-a", userId: "user-a" },
      reportIds: ["report-a", "foreign-report"],
      shopId: "shop-a"
    })).resolves.toMatchObject({ ok: false, status: 404 });
    expect(mocks.reportUpdateMany).not.toHaveBeenCalled();
  });
});
