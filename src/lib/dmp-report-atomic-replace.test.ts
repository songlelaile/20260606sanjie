import { beforeEach, describe, expect, it, vi } from "vitest";
import { DMP_GROWTH_REPORT_TABLES, type DmpCanonicalReport } from "@/lib/dmp-report-types";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  shopFindFirst: vi.fn(),
  shopFindMany: vi.fn(),
  reportFindFirst: vi.fn(),
  reportFindMany: vi.fn(),
  reportDeleteMany: vi.fn(),
  reportUpdate: vi.fn(),
  reportUpsert: vi.fn(),
  shareUpdateMany: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  prisma: { $transaction: mocks.transaction }
}));
vi.mock("@/lib/server-session", () => ({ getCurrentSession: vi.fn() }));
vi.mock("@/lib/tool-entitlements", () => ({ getDmpAutomationAccessForSession: vi.fn() }));

import { saveDmpBusinessReport, validateDmpCanonicalReport } from "@/lib/dmp-report-store";

const ACCESS = { tenantId: "tenant-a", userId: "user-a" };
const SUBJECT = "768239824008";
const COMPETITOR = "563697874317";
const SHOP = { id: "shop-a", name: "西西礼" };

describe("DMP latest-pair atomic replacement", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work({
      $executeRaw: mocks.executeRaw,
      shop: {
        findFirst: mocks.shopFindFirst,
        findMany: mocks.shopFindMany
      },
      dmpBusinessReport: {
        findFirst: mocks.reportFindFirst,
        findMany: mocks.reportFindMany,
        deleteMany: mocks.reportDeleteMany,
        update: mocks.reportUpdate,
        upsert: mocks.reportUpsert
      },
      dmpReportShare: { updateMany: mocks.shareUpdateMany }
    }));
    mocks.executeRaw.mockResolvedValue(0);
    mocks.shopFindFirst.mockResolvedValue(SHOP);
    mocks.shareUpdateMany.mockResolvedValue({ count: 2 });
    mocks.reportDeleteMany.mockResolvedValue({ count: 1 });
  });

  it("moves shares, deletes absorbed rows, and updates the target in place after all checks pass", async () => {
    const incoming = completeGrowthReport("2026-08-18", 7);
    const targetReport = completeGrowthReport("2026-08-20", 3);
    const olderReport = completeGrowthReport("2026-08-18", 3);
    const target = storedRow("report-target", targetReport);
    const older = storedRow("report-older", olderReport, { createdAt: new Date("2026-08-21T00:00:00.000Z") });
    arrangeRows(target, [target, older]);
    mocks.reportUpdate.mockImplementation(async (args: {
      data: { report: DmpCanonicalReport; period: string; quality: string; createdAt: Date };
    }) => ({
      ...target,
      period: args.data.period,
      quality: args.data.quality,
      createdAt: args.data.createdAt,
      report: args.data.report
    }));

    const saved = await replace(incoming, {
      replaceReportId: target.id,
      absorbedReportIds: [target.id, older.id]
    });

    expect(mocks.executeRaw).toHaveBeenCalledTimes(2);
    expect(mocks.reportUpsert).not.toHaveBeenCalled();
    expect(mocks.shareUpdateMany).toHaveBeenCalledWith({
      where: { reportId: { in: [older.id] } },
      data: { reportId: target.id }
    });
    expect(mocks.reportDeleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: [older.id] },
        tenantId: ACCESS.tenantId,
        userId: ACCESS.userId,
        shopId: SHOP.id
      }
    });
    expect(mocks.reportUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: target.id },
      data: expect.objectContaining({
        report: incoming,
        period: incoming.period,
        quality: "complete",
        sourceVersion: "2.3.46",
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        createdAt: expect.any(Date)
      })
    }));
    expect(mocks.shareUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(mocks.reportDeleteMany.mock.invocationCallOrder[0]);
    expect(mocks.reportDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(mocks.reportUpdate.mock.invocationCallOrder[0]);
    expect(saved).toMatchObject({
      id: target.id,
      shopId: SHOP.id,
      quality: "complete",
      period: incoming.period,
      retention: {
        mode: "replace-latest-pair",
        confirmed: true,
        replacedReportId: target.id,
        absorbedReportIds: [target.id, older.id]
      }
    });
  });

  it("allows a 200-record window to replace while preserving the 201st older record for the next convergence pass", async () => {
    const incoming = completeGrowthReport("2026-08-18", 7);
    const target = storedRow("report-target", completeGrowthReport("2026-08-20", 3), {
      createdAt: new Date("2026-08-30T12:00:00.000Z")
    });
    const absorbed = [target, ...Array.from({ length: 199 }, (_, index) => storedRow(
      `report-window-${String(index).padStart(3, "0")}`,
      completeGrowthReport("2026-08-20", 3),
      { createdAt: new Date(`2026-08-${String(29 - Math.floor(index / 10)).padStart(2, "0")}T12:00:00.000Z`) }
    ))];
    const olderOutsideWindow = storedRow("report-201-older", completeGrowthReport("2026-08-20", 3), {
      createdAt: new Date("2026-08-01T00:00:00.000Z")
    });
    arrangeRows(target, absorbed, null, olderOutsideWindow);
    mocks.reportDeleteMany.mockResolvedValueOnce({ count: 199 });
    mocks.reportUpdate.mockResolvedValue({ ...target, report: incoming, period: incoming.period });

    await expect(replace(incoming, {
      replaceReportId: target.id,
      absorbedReportIds: absorbed.map((row) => row.id)
    })).resolves.toMatchObject({ id: target.id, retention: { absorbedReportIds: expect.any(Array) } });

    expect(mocks.reportUpdate).toHaveBeenCalled();
    expect(mocks.reportDeleteMany).toHaveBeenCalled();
  });

  it("returns DMP_REPORT_HISTORY_STALE with zero writes for a newer unabsorbed concurrent report", async () => {
    const incoming = completeGrowthReport("2026-08-18", 7);
    const target = storedRow("report-target", completeGrowthReport("2026-08-20", 3), {
      createdAt: new Date("2026-08-22T00:00:00.000Z")
    });
    const concurrent = storedRow("report-concurrent", completeGrowthReport("2026-08-20", 3), {
      createdAt: new Date("2026-08-23T00:00:00.000Z")
    });
    arrangeRows(target, [target], null, concurrent);

    await expect(replace(incoming)).rejects.toMatchObject({
      code: "DMP_REPORT_HISTORY_STALE",
      status: 409
    });
    expect(mocks.shareUpdateMany).not.toHaveBeenCalled();
    expect(mocks.reportDeleteMany).not.toHaveBeenCalled();
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
  });

  it("rejects a fresh effective-partial report before reading or mutating stored reports", async () => {
    const incoming = completeGrowthReport("2026-08-18", 7);
    incoming.tables.find((table) => table.name === "报告总览")!.rows = incoming.tables
      .find((table) => table.name === "报告总览")!.rows.filter((row) => row.cells[0] !== "PPC");

    await expect(replace(incoming)).rejects.toMatchObject({
      code: "DMP_REPORT_REPLACE_CONFLICT",
      status: 409
    });

    expect(mocks.reportFindFirst).not.toHaveBeenCalled();
    expect(mocks.reportUpsert).not.toHaveBeenCalled();
    expect(mocks.shareUpdateMany).not.toHaveBeenCalled();
    expect(mocks.reportDeleteMany).not.toHaveBeenCalled();
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["different shop", (row: ReturnType<typeof storedRow>) => { row.shopId = "shop-b"; row.shop = { id: "shop-b", name: "北北店" }; }],
    ["different competitor", (row: ReturnType<typeof storedRow>) => { row.competitorItemId = "997165076209"; }],
    ["stored partial", (row: ReturnType<typeof storedRow>) => { row.quality = "partial"; }]
  ])("rejects an absorbed record with %s without moving shares or deleting anything", async (_label, mutate) => {
    const incoming = completeGrowthReport("2026-08-18", 7);
    const target = storedRow("report-target", completeGrowthReport("2026-08-20", 3));
    const unsafe = storedRow("report-unsafe", completeGrowthReport("2026-08-18", 3));
    mutate(unsafe);
    arrangeRows(target, [target, unsafe]);

    await expect(replace(incoming, {
      replaceReportId: target.id,
      absorbedReportIds: [target.id, unsafe.id]
    })).rejects.toMatchObject({ code: "DMP_REPORT_REPLACE_CONFLICT", status: 409 });

    expect(mocks.reportUpsert).not.toHaveBeenCalled();
    expect(mocks.shareUpdateMany).not.toHaveBeenCalled();
    expect(mocks.reportDeleteMany).not.toHaveBeenCalled();
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
  });

  it("rejects a gapped or disconnected absorbed daily range", async () => {
    const incoming = completeGrowthReport("2026-08-18", 7);
    const target = storedRow("report-target", completeGrowthReport("2026-08-20", 3));
    const disconnected = completeGrowthReport("2026-08-01", 3);
    const unsafe = storedRow("report-disconnected", disconnected);
    arrangeRows(target, [target, unsafe]);

    await expect(replace(incoming, {
      replaceReportId: target.id,
      absorbedReportIds: [target.id, unsafe.id]
    })).rejects.toMatchObject({ code: "DMP_REPORT_REPLACE_CONFLICT", status: 409 });
    expect(mocks.shareUpdateMany).not.toHaveBeenCalled();
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
  });

  it("rejects a fingerprint collision outside the absorbed set", async () => {
    const incoming = completeGrowthReport("2026-08-18", 7);
    const target = storedRow("report-target", completeGrowthReport("2026-08-20", 3));
    arrangeRows(target, [target], { id: "unabsorbed-collision" });

    await expect(replace(incoming, {
      replaceReportId: target.id,
      absorbedReportIds: [target.id]
    })).rejects.toMatchObject({ code: "DMP_REPORT_REPLACE_CONFLICT", status: 409 });

    expect(mocks.reportUpsert).not.toHaveBeenCalled();
    expect(mocks.shareUpdateMany).not.toHaveBeenCalled();
    expect(mocks.reportDeleteMany).not.toHaveBeenCalled();
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
  });

  it("converts a concurrent unique-fingerprint failure into a conflict and never falls back to INSERT", async () => {
    const incoming = completeGrowthReport("2026-08-18", 7);
    const target = storedRow("report-target", completeGrowthReport("2026-08-20", 3));
    arrangeRows(target, [target]);
    mocks.reportUpdate.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));

    await expect(replace(incoming, {
      replaceReportId: target.id,
      absorbedReportIds: [target.id]
    })).rejects.toMatchObject({ code: "DMP_REPORT_REPLACE_CONFLICT", status: 409 });
    expect(mocks.reportUpsert).not.toHaveBeenCalled();
  });
});

function arrangeRows(
  target: ReturnType<typeof storedRow>,
  rows: Array<ReturnType<typeof storedRow>>,
  collision: { id: string } | null = null,
  newestUnabsorbed: { id: string; createdAt: Date } | null = null
) {
  mocks.reportFindFirst.mockImplementation(async (args: { where: { id?: unknown; fingerprint?: unknown } }) => (
    typeof args.where.id === "string"
      ? target
      : args.where.fingerprint
        ? collision
        : args.where.id && typeof args.where.id === "object"
          ? newestUnabsorbed
          : null
  ));
  mocks.reportFindMany.mockResolvedValue(rows);
}

function replace(
  report: DmpCanonicalReport,
  ids: { replaceReportId: string; absorbedReportIds: string[] } = {
    replaceReportId: "report-target",
    absorbedReportIds: ["report-target"]
  }
) {
  return saveDmpBusinessReport({
    access: ACCESS,
    shopId: SHOP.id,
    report,
    subjectItemId: SUBJECT,
    competitorItemId: COMPETITOR,
    quality: "complete",
    sourceVersion: "2.3.46",
    sourceShop: { shopId: SHOP.id },
    archiveMode: "replace-latest-pair",
    ...ids
  });
}

function storedRow(
  id: string,
  report: DmpCanonicalReport,
  override: Partial<{
    tenantId: string;
    userId: string;
    shopId: string | null;
    shop: { id: string; name: string } | null;
    subjectItemId: string;
    competitorItemId: string;
    quality: string;
    createdAt: Date;
  }> = {}
) {
  return {
    id,
    tenantId: ACCESS.tenantId,
    userId: ACCESS.userId,
    shopId: SHOP.id as string | null,
    shop: SHOP as { id: string; name: string } | null,
    subjectItemId: SUBJECT,
    competitorItemId: COMPETITOR,
    period: report.period,
    quality: "complete",
    sourceVersion: "2.3.45",
    fingerprint: `${id}-fingerprint`,
    createdAt: new Date("2026-08-22T00:00:00.000Z"),
    report,
    ...override
  };
}

function completeGrowthReport(startDate: string, days: number): DmpCanonicalReport {
  const dates = Array.from({ length: days }, (_, index) => addDays(startDate, index));
  const metricRows = [
    ["总GMV", "700", "900"],
    ["付费成交额", "350", "450"],
    ["推广消耗", "100", "120"],
    ["费比", "14.29%", "13.33%"],
    ["ROI", "3.5", "3.75"],
    ["PPC", "2", "2.4"],
    ["付费金额占比", "50%", "50%"],
    ["全域ROAS", "7", "7.5"]
  ];
  const tables = DMP_GROWTH_REPORT_TABLES.map((name) => {
    if (name === "报告总览") {
      return { name, columns: ["项目", "主体", "对手"], rows: metricRows.map((cells) => ({ cells })) };
    }
    if (name === "商品与成功品") {
      return {
        name,
        columns: ["对象", "商品ID"],
        rows: [
          { cells: ["主体", SUBJECT] },
          { cells: ["目标对手", COMPETITOR] }
        ]
      };
    }
    if (name === "周期汇总") {
      return {
        name,
        columns: ["对象", "商品ID", "总GMV"],
        rows: [
          { cells: ["主体", SUBJECT, "700"] },
          { cells: ["目标对手", COMPETITOR, "900"] }
        ]
      };
    }
    if (name === "日GMV与费比") {
      return {
        name,
        columns: ["日期", "主体日GMV", "日GMV", "日总消耗"],
        rows: dates.map((date, index) => ({ cells: [date, String(100 + index), String(120 + index), "10"] }))
      };
    }
    return { name, columns: ["指标"], rows: [{ cells: ["已披露"] }] };
  });
  const report = {
    schema_version: "3.0" as const,
    title: "达摩盘商品成长竞品对标报告｜少壮AI自动化",
    item_id: SUBJECT,
    period: `${dates[0]} 至 ${dates.at(-1)}`,
    tables,
    render_data: {
      version: "1" as const,
      subject_daily_gmv: dates.map((date, index) => ({ date, gmv: String(100 + index) }))
    }
  };
  const checked = validateDmpCanonicalReport(report);
  if (!checked.report || checked.issues?.length) throw new Error(checked.error || checked.issues?.join("；") || "fixture invalid");
  return checked.report;
}

function addDays(startDate: string, offset: number) {
  const time = Date.parse(`${startDate}T00:00:00.000Z`) + offset * 86_400_000;
  return new Date(time).toISOString().slice(0, 10);
}
