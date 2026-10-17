import { beforeEach, describe, expect, it, vi } from "vitest";
import { serializeSession } from "@/lib/auth";
import {
  auditDmpGrowthSubjectMetrics,
  DMP_COMPETITION_REPORT_TABLES,
  DMP_GROWTH_REPORT_TABLES
} from "@/lib/dmp-report-types";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  findMany: vi.fn(),
  reportGetFindFirst: vi.fn(),
  transaction: vi.fn(),
  shopFindFirst: vi.fn(),
  shopFindMany: vi.fn(),
  reportFindFirst: vi.fn(),
  transactionReportFindMany: vi.fn(),
  reportCount: vi.fn(),
  reportUpdateMany: vi.fn(),
  executeRaw: vi.fn(),
  userFindUnique: vi.fn(),
  rootShopFindFirst: vi.fn(),
  getCurrentSession: vi.fn(),
  getDmpAutomationAccessForSession: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  prisma: {
    dmpBusinessReport: {
      findMany: mocks.findMany,
      findFirst: mocks.reportGetFindFirst,
      count: mocks.reportCount
    },
    user: { findUnique: mocks.userFindUnique },
    shop: { findFirst: mocks.rootShopFindFirst },
    $transaction: mocks.transaction
  }
}));
vi.mock("@/lib/server-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/lib/tool-entitlements", () => ({
  getDmpAutomationAccessForSession: mocks.getDmpAutomationAccessForSession
}));

import {
  assignDmpBusinessReportsShop,
  dmpBusinessReportFingerprint,
  getDmpBusinessReport,
  listDmpBusinessReportSummaries,
  listDmpBusinessReports,
  resolveDmpReportRequestContext,
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

function marketReport() {
  return {
    schema_version: "3.0",
    report_type: "market",
    title: "达摩盘类目大盘报告",
    item_id: "350511",
    period: "2026-03-01 至 2026-07-31",
    market_scope: {
      category_id: "350511",
      category_name: "油烟机",
      category_path: ["大家电", "厨房大电", "油烟机"]
    },
    tables: [{
      name: "滚动7天市场数据",
      columns: ["请求截止日", "成交金额", "新客人数"],
      rows: [
        { cells: ["2026-03-31", "3000万~4000万", "1500~1505"] },
        { cells: ["2026-04-01", "3000万~4000万", "1510~1515"] }
      ]
    }]
  };
}

describe("DMP strict request shop context", () => {
  beforeEach(() => {
    mocks.getCurrentSession.mockReset();
    mocks.getDmpAutomationAccessForSession.mockReset();
    mocks.userFindUnique.mockReset();
    mocks.rootShopFindFirst.mockReset();
    mocks.getCurrentSession.mockResolvedValue({
      username: "demo", role: "tenant", name: "演示", tenantId: "tenant-a"
    });
    mocks.getDmpAutomationAccessForSession.mockResolvedValue({ allowed: true });
    mocks.userFindUnique.mockResolvedValue({ id: "user-a", tenantId: "tenant-a" });
    mocks.rootShopFindFirst.mockResolvedValue({ id: "shop-a", name: "店铺 A" });
  });

  it("fails closed when browser header and activity cookie name different shops", async () => {
    await expect(resolveDmpReportRequestContext({
      browserHeaderShopId: "shop-a",
      browserCookieShopId: "shop-b"
    })).resolves.toEqual({
      ok: false,
      status: 409,
      code: "SHOP_MISMATCH",
      error: "页面店铺与当前官网活动店铺不一致，请刷新后重试"
    });
    expect(mocks.rootShopFindFirst).not.toHaveBeenCalled();
  });

  it("accepts one explicit browser shop and verifies it inside the access tenant", async () => {
    await expect(resolveDmpReportRequestContext({ browserCookieShopId: "shop-a" }))
      .resolves.toEqual({
        ok: true,
        access: { userId: "user-a", tenantId: "tenant-a" },
        shop: { id: "shop-a", name: "店铺 A" }
      });
    expect(mocks.rootShopFindFirst).toHaveBeenCalledWith({
      where: { id: "shop-a", tenantId: "tenant-a" },
      select: { id: true, name: true }
    });
  });

  it("uses the authenticated tenant's first-created shop only for the default-shop scope", async () => {
    await expect(resolveDmpReportRequestContext({ allowDefaultShop: true }))
      .resolves.toEqual({
        ok: true,
        access: { userId: "user-a", tenantId: "tenant-a" },
        shop: { id: "shop-a", name: "店铺 A" }
      });
    expect(mocks.rootShopFindFirst).toHaveBeenCalledWith({
      where: { tenantId: "tenant-a" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, name: true }
    });
  });

  it("uses the same tenant default for a valid extension session with no shop header", async () => {
    const extensionToken = await serializeSession({
      username: "demo", role: "tenant", name: "演示", tenantId: "tenant-a"
    });
    await expect(resolveDmpReportRequestContext({ extensionToken, allowDefaultShop: true }))
      .resolves.toMatchObject({
        ok: true,
        access: { userId: "user-a", tenantId: "tenant-a" },
        shop: { id: "shop-a", name: "店铺 A" }
      });
    expect(mocks.rootShopFindFirst).toHaveBeenCalledWith({
      where: { tenantId: "tenant-a" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, name: true }
    });
  });

  it("keeps an unspecified shop closed outside the dedicated default-shop scope", async () => {
    await expect(resolveDmpReportRequestContext({}))
      .resolves.toEqual({
        ok: false,
        status: 400,
        code: "SHOP_REQUIRED",
        error: "当前官网店铺未明确，请先选择店铺"
      });
    expect(mocks.rootShopFindFirst).not.toHaveBeenCalled();
  });

  it("does not fall back when an explicitly supplied shop is invalid for the tenant", async () => {
    mocks.rootShopFindFirst.mockResolvedValueOnce(null);
    await expect(resolveDmpReportRequestContext({ browserHeaderShopId: "foreign-shop" }))
      .resolves.toEqual({
        ok: false,
        status: 404,
        code: "SHOP_INVALID",
        error: "店铺不存在或不属于当前账号"
      });
    expect(mocks.rootShopFindFirst).toHaveBeenCalledWith({
      where: { id: "foreign-shop", tenantId: "tenant-a" },
      select: { id: true, name: true }
    });
  });
});

describe("DMP paginated summary projection", () => {
  it("selects summary JSON instead of the full report body and keeps partial reports visible", async () => {
    const createdAt = new Date("2026-08-30T00:00:00.000Z");
    mocks.reportCount.mockResolvedValueOnce(25);
    mocks.findMany.mockResolvedValueOnce([{
      id: "summary-a",
      shopId: "shop-a",
      shop: { id: "shop-a", name: "店铺 A" },
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      period: "2026-08-01 至 2026-08-30",
      quality: "partial",
      createdAt,
      summary: {
        version: 1,
        reportType: "growth",
        title: "商品报告",
        subjectThumbnail: { url: "", title: "主体" },
        competitorThumbnail: { url: "", title: "竞品" }
      }
    }]);

    await expect(listDmpBusinessReportSummaries(
      { tenantId: "tenant-a", userId: "user-a" },
      { shopId: "shop-a", page: 1, pageSize: 24 }
    )).resolves.toMatchObject({
      total: 25,
      totalPages: 2,
      hasNext: true,
      summaries: [{ id: "summary-a", quality: "partial" }]
    });
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-a", userId: "user-a", shopId: "shop-a" },
      take: 24,
      select: expect.objectContaining({ summary: true })
    }));
    expect(mocks.findMany.mock.calls.at(-1)?.[0]?.select).not.toHaveProperty("report");
  });
});

describe("DMP same-item role contract", () => {
  it("audits the subject role instead of the first matching ID when both sides share one item", () => {
    const itemId = "593063365092";
    const audit = auditDmpGrowthSubjectMetrics({
      item_id: itemId,
      tables: [{
        name: "周期汇总",
        columns: ["商品ID", "对象", "推广消耗", "费比", "ROI", "PPC"],
        rows: [
          { cells: [itemId, "目标对手", "20", "0.1", "4", "2"] },
          { cells: [itemId, "主体", "10", "0.1", "", "2"] }
        ]
      }]
    });

    expect(audit.missing.map((metric) => metric.label)).toEqual(["ROI"]);
  });
});

describe("DMP category market report storage contract", () => {
  it("preserves the market kind and normalized Chinese category scope without competitors", () => {
    const checked = validateDmpCanonicalReport(marketReport());
    expect(checked.error).toBeUndefined();
    expect(checked.report).toMatchObject({
      report_type: "market",
      item_id: "350511",
      title: "达摩盘类目大盘报告｜少壮AI自动化",
      market_scope: {
        category_id: "350511",
        category_name: "油烟机",
        category_path: ["大家电", "厨房大电", "油烟机"]
      }
    });
    expect(checked.report).not.toHaveProperty("competitor_ids");
    expect(checked.report?.tables.map((table) => table.name)).toEqual(["滚动7天市场数据"]);
  });

  it("accepts the plugin category-ID contract without relaxing product item IDs", () => {
    const shortCategory = marketReport();
    shortCategory.item_id = "16";
    shortCategory.market_scope.category_id = "16";
    shortCategory.market_scope.category_name = "女装";
    shortCategory.market_scope.category_path = ["服饰", "女装"];

    const checked = validateDmpCanonicalReport(shortCategory);
    expect(checked.error).toBeUndefined();
    expect(checked.report).toMatchObject({
      report_type: "market",
      item_id: "16",
      market_scope: { category_id: "16", category_name: "女装", category_path: ["服饰", "女装"] }
    });

    const shortProduct = growthReport();
    shortProduct.item_id = "16";
    expect(validateDmpCanonicalReport(shortProduct).error).toBe("主体商品 ID 无效");
  });

  it("rejects a market archive without a complete category scope or business table", () => {
    const missingScope = structuredClone(marketReport()) as Record<string, unknown>;
    delete missingScope.market_scope;
    expect(validateDmpCanonicalReport(missingScope).error).toContain("类目范围无效");
    const empty = marketReport();
    empty.tables = [];
    expect(validateDmpCanonicalReport(empty).error).toContain("缺少业务数据");
  });

  it("includes market scope in retry fingerprints", () => {
    const first = validateDmpCanonicalReport(marketReport()).report!;
    const changed = structuredClone(first);
    changed.market_scope!.category_path = ["家电", "厨房电器", "油烟机"];
    const identity = { subjectItemId: "350511", competitorItemId: "" };
    expect(dmpBusinessReportFingerprint({ ...identity, report: changed }))
      .not.toBe(dmpBusinessReportFingerprint({ ...identity, report: first }));
    expect(dmpBusinessReportFingerprint({ ...identity, report: first, shopId: "shop-a" }))
      .not.toBe(dmpBusinessReportFingerprint({ ...identity, report: first, shopId: "shop-b" }));
  });
});

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
    mocks.transactionReportFindMany.mockReset();
    mocks.reportCount.mockReset();
    mocks.reportUpdateMany.mockReset();
    mocks.executeRaw.mockReset();
    mocks.reportFindFirst.mockResolvedValue(null);
    mocks.shopFindFirst.mockResolvedValue({ id: "shop-a", name: "西西礼" });
    mocks.shopFindMany.mockResolvedValue([]);
    mocks.executeRaw.mockResolvedValue(0);
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work({
      $executeRaw: mocks.executeRaw,
      shop: {
        findFirst: mocks.shopFindFirst,
        findMany: mocks.shopFindMany
      },
      dmpBusinessReport: {
        upsert: mocks.upsert,
        findFirst: mocks.reportFindFirst,
        findMany: mocks.transactionReportFindMany,
        count: mocks.reportCount,
        updateMany: mocks.reportUpdateMany
      }
    }));
  });

  it("uses the normalized tables as the subject minimum-metric contract", () => {
    const report = growthReport();
    const overview = report.tables.find((table) => table.name === "报告总览")!;
    overview.columns = ["项目", "主体", "对手", "范围"];
    overview.rows = [
      { cells: ["推广花费", "100", "200", "30日"] },
      { cells: ["广告费比", "10%", "20%", "30日"] },
      { cells: ["投入产出比", "3", "4", "30日"] },
      { cells: ["点击单价", "2", "2.5", "30日"] }
    ];

    const checked = validateDmpCanonicalReport(report);

    expect(checked.error).toBeUndefined();
    expect(checked.issues).toBeUndefined();
    expect(checked.report?.tables.find((table) => table.name === "报告总览")?.rows.map((row) => row.cells[0]))
      .toEqual(["推广花费", "广告费比", "投入产出比", "点击单价"]);
  });

  it("downgrades a positive-spend archive when a required subject value is missing without rejecting it", () => {
    const report = growthReport();
    const overview = report.tables.find((table) => table.name === "报告总览")!;
    overview.columns = ["项目", "主体", "对手", "范围"];
    overview.rows = [
      { cells: ["推广消耗", "100", "", "30日"] },
      { cells: ["费比", "10%", "", "30日"] },
      { cells: ["ROI", "—", "", "30日"] },
      { cells: ["PPC", "0", "", "30日"] }
    ];

    const checked = validateDmpCanonicalReport(report);

    expect(checked.error).toBeUndefined();
    expect(checked.issues).toContain("主体最低指标缺失：ROI");
    expect(checked.report?.tables.find((table) => table.name === "报告总览")?.rows[3]?.cells[1]).toBe("0");
  });

  it("accepts explicit zero spend and fee ratio without fabricating undefined ROI or PPC", () => {
    const report = growthReport();
    const overview = report.tables.find((table) => table.name === "报告总览")!;
    overview.columns = ["项目", "主体", "对手", "范围"];
    overview.rows = [
      { cells: ["推广消耗", "0", "", "30日"] },
      { cells: ["费比", "0%", "", "30日"] },
      { cells: ["ROI", "", "", "30日"] },
      { cells: ["PPC", "", "", "30日"] }
    ];

    expect(validateDmpCanonicalReport(report).issues).toBeUndefined();
  });

  it("rechecks effective quality on save and read without rewriting the archived report JSON", async () => {
    const canonical = validateDmpCanonicalReport(growthReport()).report!;
    const originalText = JSON.stringify(canonical);
    const createdAt = new Date("2026-08-22T00:00:00.000Z");
    const stored = {
      id: "server-quality-report",
      shopId: "shop-a",
      shop: { id: "shop-a", name: "西西礼" },
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      period: canonical.period,
      // 模拟旧记录和不可信客户端曾把不完整报告写成 complete。
      quality: "complete",
      createdAt,
      report: canonical
    };
    mocks.upsert.mockResolvedValue(stored);
    mocks.findMany.mockResolvedValue([stored]);
    mocks.reportGetFindFirst.mockResolvedValue(stored);

    const saved = await saveDmpBusinessReport({
      access: { tenantId: "tenant-a", userId: "user-a" },
      shopId: "shop-a",
      sourceShop: { shopId: "shop-a" },
      report: canonical,
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      quality: "complete",
      sourceVersion: "2.3.13"
    });

    expect(mocks.upsert.mock.calls[0]?.[0]?.create?.quality).toBe("partial");
    expect(saved.quality).toBe("partial");
    await expect(listDmpBusinessReports({ tenantId: "tenant-a", userId: "user-a" }))
      .resolves.toMatchObject([{ id: stored.id, quality: "partial" }]);
    await expect(getDmpBusinessReport({ tenantId: "tenant-a", userId: "user-a" }, stored.id, "shop-a"))
      .resolves.toMatchObject({ id: stored.id, quality: "partial" });
    expect(JSON.stringify(canonical)).toBe(originalText);
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

  it("keeps the optional price-band module after products without creating it for legacy reports", () => {
    const legacy = validateDmpCanonicalReport(growthReport()).report!;
    expect(legacy.tables.some((table) => table.name === "赛道价格带洞察")).toBe(false);

    const extended = growthReport();
    (extended.tables as Array<{ name: string; columns: string[]; rows: Array<{ cells: string[] }> }>).push({
      name: "赛道价格带洞察",
      columns: ["价格带区间", "增长潜力得分(dScore)", "规则型指导"],
      rows: [{ cells: ["0~330", "1.83", "依据：dScore 1.83；规则：同周期原值首位"] }]
    });
    const checked = validateDmpCanonicalReport(extended);
    expect(checked.error).toBeUndefined();
    expect(checked.report?.tables.map((table) => table.name).slice(0, 5)).toEqual([
      "报告总览", "对标总表", "商品与成功品", "赛道价格带洞察", "周期汇总"
    ]);
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
    await expect(getDmpBusinessReport(access, "legacy-report", "shop-a")).resolves.toMatchObject({
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
      shop: { id: "shop-a", name: "西西礼" },
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      period: canonical.period,
      quality: "complete",
      createdAt,
      report: canonical
    });

    const saved = await saveDmpBusinessReport({
      access: { tenantId: "tenant-a", userId: "user-a" },
      shopId: "shop-a",
      sourceShop: { shopId: "shop-a" },
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
    const fingerprint = dmpBusinessReportFingerprint({ ...identity, report: first, shopId: "shop-a" });

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(dmpBusinessReportFingerprint({ ...identity, report: retry, shopId: "shop-a" })).toBe(fingerprint);
    expect(dmpBusinessReportFingerprint({ ...identity, report: changed, shopId: "shop-a" })).not.toBe(fingerprint);

    const createdAt = new Date("2026-08-22T04:00:00.000Z");
    mocks.upsert.mockResolvedValue({
      id: "one-id-for-both-attempts",
      shop: { id: "shop-a", name: "西西礼" },
      ...identity,
      period: first.period,
      quality: "complete",
      createdAt,
      report: first
    });
    const save = (report: typeof first) => saveDmpBusinessReport({
      access: { tenantId: "tenant-a", userId: "user-a" },
      shopId: "shop-a",
      sourceShop: { shopId: "shop-a" },
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

  it("does not inherit the latest shop now that every archive is explicitly frozen", async () => {
    const canonical = validateDmpCanonicalReport(growthReport()).report!;
    const createdAt = new Date("2026-08-22T01:00:00.000Z");
    mocks.reportFindFirst.mockResolvedValue({ shop: { id: "shop-recent", name: "最近店铺" } });
    mocks.shopFindFirst.mockResolvedValue({ id: "shop-recent", name: "最近店铺" });
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
      shopId: "shop-recent",
      sourceShop: { shopId: "shop-recent" },
      report: canonical,
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      quality: "complete",
      sourceVersion: "2.1.6"
    });

    expect(mocks.reportFindFirst).not.toHaveBeenCalled();
    expect(mocks.shopFindFirst).toHaveBeenCalledWith({
      where: { id: "shop-recent", tenantId: "tenant-a" },
      select: { id: true, name: true }
    });
    expect(mocks.shopFindMany).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ shopId: "shop-recent" })
    }));
    expect(saved).toMatchObject({ shopId: "shop-recent", shopName: "最近店铺" });
  });

  it("uses an explicitly supplied source shop only after tenant-scoped validation", async () => {
    const canonical = validateDmpCanonicalReport(growthReport()).report!;
    const createdAt = new Date("2026-08-22T01:30:00.000Z");
    mocks.shopFindFirst.mockResolvedValue({ id: "shop-source", name: "采集来源店铺" });
    mocks.upsert.mockResolvedValue({
      id: "report-source-shop",
      shop: { id: "shop-source", name: "采集来源店铺" },
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      period: canonical.period,
      quality: "complete",
      createdAt,
      report: canonical
    });

    const saved = await saveDmpBusinessReport({
      access: { tenantId: "tenant-a", userId: "user-a" },
      shopId: "shop-source",
      report: canonical,
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      quality: "complete",
      sourceVersion: "2.2.0",
      sourceShop: { shopId: "shop-source", shopName: "不可信提示名" }
    });

    expect(mocks.shopFindFirst).toHaveBeenCalledWith({
      where: { id: "shop-source", tenantId: "tenant-a" },
      select: { id: true, name: true }
    });
    expect(mocks.reportFindFirst).not.toHaveBeenCalled();
    expect(mocks.shopFindMany).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ shopId: "shop-source" })
    }));
    expect(saved).toMatchObject({ shopId: "shop-source", shopName: "采集来源店铺" });
  });

  it("rejects an explicit source shop outside the current tenant before archiving", async () => {
    const canonical = validateDmpCanonicalReport(growthReport()).report!;
    mocks.shopFindFirst.mockResolvedValue(null);

    await expect(saveDmpBusinessReport({
      access: { tenantId: "tenant-a", userId: "user-a" },
      shopId: "foreign-shop",
      report: canonical,
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      quality: "complete",
      sourceVersion: "2.2.0",
      sourceShop: { shopId: "foreign-shop", shopName: "同名也不能绕过内部 ID 校验" }
    })).rejects.toMatchObject({
      code: "DMP_REPORT_SOURCE_SHOP_INVALID",
      status: 404,
      message: "店铺不存在或不属于当前账号"
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("does not map an external numeric source ID through a shop name", async () => {
    const canonical = validateDmpCanonicalReport(growthReport()).report!;
    const createdAt = new Date("2026-08-22T01:40:00.000Z");
    mocks.shopFindMany.mockResolvedValue([
      { id: "shop-other", name: "其他店铺" },
      { id: "shop-match", name: "西西礼 旗舰店" }
    ]);
    mocks.upsert.mockResolvedValue({
      id: "report-external-source",
      shop: { id: "shop-match", name: "西西礼 旗舰店" },
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      period: canonical.period,
      quality: "complete",
      createdAt,
      report: canonical
    });

    await expect(saveDmpBusinessReport({
      access: { tenantId: "tenant-a", userId: "user-a" },
      shopId: "shop-match",
      report: canonical,
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      quality: "complete",
      sourceVersion: "2.2.0",
      sourceShop: { sourceShopId: "123456789012", shopName: "  西西礼　旗舰店  " }
    })).rejects.toMatchObject({ code: "DMP_REPORT_SOURCE_SHOP_INVALID", status: 400 });

    expect(mocks.shopFindFirst).not.toHaveBeenCalled();
    expect(mocks.shopFindMany).not.toHaveBeenCalled();
    expect(mocks.reportFindFirst).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("does not match a name-only source to an existing tenant shop", async () => {
    const canonical = validateDmpCanonicalReport(growthReport()).report!;
    const createdAt = new Date("2026-08-22T01:45:00.000Z");
    mocks.shopFindMany.mockResolvedValue([
      { id: "shop-match", name: "西西礼" },
      { id: "shop-other", name: "北北店" }
    ]);
    mocks.upsert.mockResolvedValue({
      id: "report-name-source",
      shop: { id: "shop-match", name: "西西礼" },
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      period: canonical.period,
      quality: "complete",
      createdAt,
      report: canonical
    });

    await expect(saveDmpBusinessReport({
      access: { tenantId: "tenant-a", userId: "user-a" },
      shopId: "shop-match",
      report: canonical,
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      quality: "complete",
      sourceVersion: "2.2.0",
      sourceShop: { shopName: " 西西礼 " }
    })).rejects.toMatchObject({ code: "DMP_REPORT_SOURCE_SHOP_INVALID", status: 400 });

    expect(mocks.shopFindMany).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("does not accept an unmatched external source without an explicit shop", async () => {
    const canonical = validateDmpCanonicalReport(growthReport()).report!;
    const createdAt = new Date("2026-08-22T01:50:00.000Z");
    mocks.shopFindMany.mockResolvedValue([
      { id: "shop-a", name: "店铺 A" },
      { id: "shop-b", name: "店铺 B" }
    ]);
    mocks.upsert.mockResolvedValue({
      id: "report-unmatched-source",
      shop: null,
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      period: canonical.period,
      quality: "complete",
      createdAt,
      report: canonical
    });

    await expect(saveDmpBusinessReport({
      access: { tenantId: "tenant-a", userId: "user-a" },
      shopId: "shop-a",
      report: canonical,
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      quality: "complete",
      sourceVersion: "2.2.0",
      sourceShop: { sourceShopId: "123456789012", shopName: "不存在的店铺" }
    })).rejects.toMatchObject({ code: "DMP_REPORT_SOURCE_SHOP_INVALID", status: 400 });

    expect(mocks.reportFindFirst).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("does not create unassigned dedup scopes for unmatched external shops", async () => {
    const canonical = validateDmpCanonicalReport(growthReport()).report!;
    const createdAt = new Date("2026-08-22T01:55:00.000Z");
    mocks.shopFindMany.mockResolvedValue([
      { id: "shop-a", name: "店铺 A" },
      { id: "shop-b", name: "店铺 B" }
    ]);
    mocks.upsert.mockImplementation(async (args: {
      create: { fingerprint: string; shopId: string | null };
    }) => ({
      id: args.create.fingerprint,
      shop: null,
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      period: canonical.period,
      quality: "complete",
      createdAt,
      report: canonical
    }));
    const save = (sourceShopId: string) => saveDmpBusinessReport({
      access: { tenantId: "tenant-a", userId: "user-a" },
      shopId: "shop-a",
      report: canonical,
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      quality: "complete" as const,
      sourceVersion: "2.2.0",
      sourceShop: { sourceShopId, shopName: "未匹配店铺" }
    });

    await expect(save("123456789012"))
      .rejects.toMatchObject({ code: "DMP_REPORT_SOURCE_SHOP_INVALID", status: 400 });
    await expect(save("987654321098"))
      .rejects.toMatchObject({ code: "DMP_REPORT_SOURCE_SHOP_INVALID", status: 400 });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("does not fall back to the tenant's only shop", async () => {
    const canonical = validateDmpCanonicalReport(growthReport()).report!;
    const createdAt = new Date("2026-08-22T02:00:00.000Z");
    mocks.shopFindMany.mockResolvedValue([{ id: "only-shop", name: "唯一店铺" }]);
    mocks.shopFindFirst.mockResolvedValue({ id: "only-shop", name: "唯一店铺" });
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
      shopId: "only-shop",
      sourceShop: { shopId: "only-shop" },
      report: canonical,
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      quality: "complete",
      sourceVersion: "2.1.6"
    });

    expect(mocks.shopFindMany).not.toHaveBeenCalled();
    expect(mocks.shopFindFirst).toHaveBeenCalledWith({
      where: { id: "only-shop", tenantId: "tenant-a" },
      select: { id: true, name: true }
    });
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ shopId: "only-shop" })
    }));
    expect(saved).toMatchObject({ shopId: "only-shop", shopName: "唯一店铺" });
  });

  it("does not leave a new report unassigned when the shop is explicit", async () => {
    const canonical = validateDmpCanonicalReport(growthReport()).report!;
    const createdAt = new Date("2026-08-22T03:00:00.000Z");
    mocks.shopFindMany.mockResolvedValue([
      { id: "shop-a", name: "店铺 A" },
      { id: "shop-b", name: "店铺 B" }
    ]);
    mocks.shopFindFirst.mockResolvedValue({ id: "shop-a", name: "店铺 A" });
    mocks.upsert.mockResolvedValue({
      id: "report-unassigned",
      shop: { id: "shop-a", name: "店铺 A" },
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      period: canonical.period,
      quality: "complete",
      createdAt,
      report: canonical
    });

    const saved = await saveDmpBusinessReport({
      access: { tenantId: "tenant-a", userId: "user-a" },
      shopId: "shop-a",
      sourceShop: { shopId: "shop-a" },
      report: canonical,
      subjectItemId: "768239824008",
      competitorItemId: "563697874317",
      quality: "complete",
      sourceVersion: "2.1.6"
    });

    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ shopId: "shop-a" })
    }));
    expect(saved).toMatchObject({ shopId: "shop-a", shopName: "店铺 A" });
  });

  it("assigns only owned reports to a tenant-scoped shop and supports returning to unassigned", async () => {
    mocks.shopFindFirst.mockResolvedValue({ id: "shop-a", name: "西西礼" });
    mocks.transactionReportFindMany.mockResolvedValue([{ id: "report-a" }, { id: "report-b" }]);
    mocks.reportUpdateMany.mockResolvedValue({ count: 2 });

    await expect(assignDmpBusinessReportsShop({
      access: { tenantId: "tenant-a", userId: "user-a" },
      reportIds: ["report-a", "report-b", "report-a"],
      sourceShopId: "shop-source",
      targetShopId: "shop-a"
    })).resolves.toEqual({
      ok: true,
      reportIds: ["report-a", "report-b"],
      count: 2,
      truncated: false,
      shop: { id: "shop-a", name: "西西礼" }
    });
    expect(mocks.shopFindFirst).toHaveBeenCalledWith({
      where: { id: "shop-a", tenantId: "tenant-a" },
      select: { id: true, name: true }
    });
    expect(mocks.reportUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: "tenant-a", userId: "user-a", shopId: "shop-source" }),
      data: { shopId: "shop-a" }
    }));

    mocks.transactionReportFindMany.mockResolvedValue([{ id: "report-a" }]);
    mocks.reportUpdateMany.mockResolvedValueOnce({ count: 1 });
    await expect(assignDmpBusinessReportsShop({
      access: { tenantId: "tenant-a", userId: "user-a" },
      reportIds: ["report-a"],
      sourceShopId: "shop-a",
      targetShopId: ""
    })).resolves.toEqual({
      ok: true,
      reportIds: ["report-a"],
      count: 1,
      truncated: false,
      shop: null
    });
    expect(mocks.reportUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: { shopId: null } }));
  });

  it("locks both shops and moves an identity group larger than the returned 200-id preview atomically", async () => {
    mocks.shopFindFirst.mockResolvedValue({ id: "shop-b", name: "店铺 B" });
    mocks.transactionReportFindMany.mockResolvedValue(
      Array.from({ length: 200 }, (_, index) => ({ id: `report-${index}` }))
    );
    mocks.reportUpdateMany.mockResolvedValue({ count: 250 });

    await expect(assignDmpBusinessReportsShop({
      access: { tenantId: "tenant-a", userId: "user-a" },
      sourceShopId: "shop-a",
      targetShopId: "shop-b",
      reportType: "growth",
      subjectItemId: "768239824008",
      competitorItemId: "563697874317"
    })).resolves.toMatchObject({
      ok: true,
      count: 250,
      truncated: true,
      reportIds: expect.arrayContaining(["report-0", "report-199"])
    });
    expect(mocks.executeRaw).toHaveBeenCalledTimes(2);
    expect(mocks.reportUpdateMany).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-a",
        userId: "user-a",
        shopId: "shop-a",
        subjectItemId: "768239824008",
        competitorItemId: "563697874317",
        summary: { path: ["reportType"], equals: "growth" }
      },
      data: { shopId: "shop-b" }
    });
  });

  it("rejects foreign shops and mixed-ownership report batches before updating", async () => {
    mocks.shopFindFirst.mockResolvedValue(null);
    await expect(assignDmpBusinessReportsShop({
      access: { tenantId: "tenant-a", userId: "user-a" },
      reportIds: ["report-a"],
      sourceShopId: "shop-source",
      targetShopId: "foreign-shop"
    })).resolves.toMatchObject({ ok: false, status: 404 });
    expect(mocks.reportUpdateMany).not.toHaveBeenCalled();

    mocks.shopFindFirst.mockResolvedValue({ id: "shop-a", name: "西西礼" });
    mocks.transactionReportFindMany.mockResolvedValue([{ id: "report-a" }]);
    await expect(assignDmpBusinessReportsShop({
      access: { tenantId: "tenant-a", userId: "user-a" },
      reportIds: ["report-a", "foreign-report"],
      sourceShopId: "shop-source",
      targetShopId: "shop-a"
    })).resolves.toMatchObject({ ok: false, status: 404 });
    expect(mocks.reportUpdateMany).not.toHaveBeenCalled();
  });
});
