import { beforeEach, describe, expect, it, vi } from "vitest";
import { DMP_GROWTH_REPORT_TABLES, type DmpCanonicalReport } from "@/lib/dmp-report-types";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  shopFindFirst: vi.fn(),
  reportFindFirst: vi.fn(),
  reportFindMany: vi.fn(),
  reportDeleteMany: vi.fn(),
  reportUpdate: vi.fn(),
  reportUpsert: vi.fn(),
  shareUpdateMany: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("@/lib/server-session", () => ({ getCurrentSession: vi.fn() }));
vi.mock("@/lib/tool-entitlements", () => ({ getDmpAutomationAccessForSession: vi.fn() }));

import {
  deleteDmpBusinessReport,
  saveDmpBusinessReport,
  validateDmpCanonicalReport
} from "@/lib/dmp-report-store";

const ACCESS = { tenantId: "tenant-a", userId: "user-a" };
const SUBJECT = "768239824008";
const COMPETITOR = "563697874317";
const SHOP = { id: "shop-a", name: "西西礼" };

describe("DMP latest-pair atomic replacement", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work({
      $executeRaw: mocks.executeRaw,
      shop: { findFirst: mocks.shopFindFirst, findMany: vi.fn() },
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
    mocks.shareUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("preserves share state, removes older rows, and updates the newest target in place", async () => {
    const incoming = growth("2026-08-18", 7);
    const target = row("target", growth("2026-08-20", 3), "2026-08-24T00:00:00.000Z");
    const older = row("older", growth("2026-08-18", 3), "2026-08-23T00:00:00.000Z");
    arrange(target, [target, older]);
    mocks.reportDeleteMany.mockResolvedValue({ count: 1 });
    mocks.reportUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...target,
      ...data,
      shop: SHOP,
      report: data.report as DmpCanonicalReport,
      createdAt: data.createdAt as Date
    }));

    const saved = await replace(incoming, [target.id, older.id], target.id);

    expect(mocks.executeRaw).toHaveBeenCalledTimes(3);
    expect(mocks.executeRaw.mock.calls.map((call) => call[1])).toEqual([
      `dmp-report-target:${ACCESS.tenantId}:${ACCESS.userId}:older`,
      `dmp-report-target:${ACCESS.tenantId}:${ACCESS.userId}:target`,
      `dmp-report-pair:${ACCESS.tenantId}:${ACCESS.userId}:${SHOP.id}:${SUBJECT}:${COMPETITOR}`
    ]);
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
      retention: {
        mode: "replace-latest-pair",
        confirmed: true,
        replacedReportId: target.id,
        absorbedReportIds: [target.id, older.id]
      }
    });
  });

  it("accepts a chain of adjacent historical windows when the final report covers the full union", async () => {
    const incoming = growth("2026-08-01", 30);
    const target = row("target", growth("2026-08-20", 10), "2026-08-31T03:00:00.000Z");
    const middle = row("middle", growth("2026-08-10", 10), "2026-08-30T03:00:00.000Z");
    const oldest = row("oldest", growth("2026-08-01", 9), "2026-08-29T03:00:00.000Z");
    arrange(target, [target, middle, oldest]);
    mocks.reportDeleteMany.mockResolvedValue({ count: 2 });
    mocks.reportUpdate.mockResolvedValue({ ...target, report: incoming, period: incoming.period, createdAt: new Date(), shop: SHOP });

    await expect(replace(incoming, [target.id, middle.id, oldest.id], target.id)).resolves.toMatchObject({ id: target.id });
    expect(mocks.reportDeleteMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: [middle.id, oldest.id] } })
    }));
  });

  it("rejects an absorbed range that extends beyond the final incoming report", async () => {
    const incoming = growth("2026-08-01", 30);
    const target = row("target", growth("2026-08-20", 10), "2026-08-31T03:00:00.000Z");
    const outside = row("outside", growth("2026-08-31", 3), "2026-08-30T03:00:00.000Z");
    arrange(target, [target, outside]);

    await expect(replace(incoming, [target.id, outside.id], target.id)).rejects.toMatchObject({
      code: "DMP_REPORT_REPLACE_CONFLICT",
      status: 409
    });
    expectNoMutation();
  });

  it("rejects a replace target older than another absorbed report", async () => {
    const incoming = growth("2026-08-01", 10);
    const staleTarget = row("stale-target", growth("2026-08-01", 5), "2026-08-10T00:00:00.000Z");
    const latest = row("latest", growth("2026-08-05", 5), "2026-08-11T00:00:00.000Z");
    arrange(staleTarget, [staleTarget, latest]);

    await expect(replace(incoming, [staleTarget.id, latest.id], staleTarget.id)).rejects.toMatchObject({
      code: "DMP_REPORT_REPLACE_CONFLICT",
      status: 409
    });
    expectNoMutation();
  });

  it("uses end date and then report ID as stable tie-breaks when createdAt is identical", async () => {
    const incoming = growth("2026-08-01", 14);
    const createdAt = "2026-08-20T00:00:00.000Z";
    const target = row("a-target", growth("2026-08-10", 5), createdAt);
    const sameEndLargerId = row("z-same-end", growth("2026-08-10", 5), createdAt);
    const earlierEnd = row("m-earlier-end", growth("2026-08-01", 5), createdAt);
    arrange(target, [sameEndLargerId, earlierEnd, target]);
    mocks.reportDeleteMany.mockResolvedValue({ count: 2 });
    mocks.reportUpdate.mockResolvedValue({
      ...target,
      report: incoming,
      period: incoming.period,
      createdAt: new Date(),
      shop: SHOP
    });

    await expect(replace(
      incoming,
      [sameEndLargerId.id, earlierEnd.id, target.id],
      target.id
    )).resolves.toMatchObject({ id: target.id });
  });

  it("returns HISTORY_STALE when a connected complete candidate appeared outside the absorbed snapshot", async () => {
    const incoming = growth("2026-08-01", 7);
    const target = row("target", growth("2026-08-01", 3), "2026-08-08T00:00:00.000Z");
    const concurrent = row("concurrent", growth("2026-08-04", 3), "2026-08-09T00:00:00.000Z");
    arrange(target, [target]);
    mocks.reportFindMany.mockImplementation(async ({ where }: { where: { id?: unknown } }) => (
      where.id ? [target] : [target, concurrent]
    ));

    await expect(replace(incoming, [target.id], target.id)).rejects.toMatchObject({
      code: "DMP_REPORT_HISTORY_STALE",
      status: 409
    });
    expectNoMutation();
  });

  it("does not block replacement for a newer but disconnected complete candidate", async () => {
    const incoming = growth("2026-08-01", 7);
    const target = row("target", growth("2026-08-01", 3), "2026-08-08T00:00:00.000Z");
    const disconnected = row("newer-gap", growth("2026-09-01", 3), "2026-09-02T00:00:00.000Z");
    arrange(target, [target]);
    mocks.reportFindMany.mockImplementation(async ({ where }: { where: { id?: unknown } }) => (
      where.id ? [target] : [target, disconnected]
    ));
    mocks.reportUpdate.mockResolvedValue({
      ...target,
      report: incoming,
      period: incoming.period,
      createdAt: new Date(),
      shop: SHOP
    });

    await expect(replace(incoming, [target.id], target.id)).resolves.toMatchObject({ id: target.id });
  });

  it.each([
    ["missing official shop", null],
    ["name-only shop", { shopName: "西西礼" }],
    ["different official shop", { shopId: "shop-b" }]
  ])("fails closed for %s", async (_label, sourceShop) => {
    const incoming = growth("2026-08-01", 3);
    const target = row("target", incoming, "2026-08-04T00:00:00.000Z");
    arrange(target, [target]);
    if (sourceShop && "shopId" in sourceShop && sourceShop.shopId === "shop-b") {
      mocks.shopFindFirst.mockResolvedValue({ id: "shop-b", name: "北北店" });
    }

    await expect(replace(incoming, [target.id], target.id, sourceShop)).rejects.toMatchObject({
      code: "DMP_REPORT_REPLACE_CONFLICT",
      status: 409
    });
    expectNoMutation();
  });

  it.each([
    ["fresh effective partial", (incoming: DmpCanonicalReport) => {
      incoming.tables.find((table) => table.name === "报告总览")!.rows = incoming.tables
        .find((table) => table.name === "报告总览")!.rows.filter((metric) => metric.cells[0] !== "PPC");
    }],
    ["stored partial", (_incoming: DmpCanonicalReport, stored: ReturnType<typeof row>) => { stored.quality = "partial"; }],
    ["different competitor", (_incoming: DmpCanonicalReport, stored: ReturnType<typeof row>) => { stored.competitorItemId = "997165076209"; }]
  ])("refuses %s without inserting or deleting", async (_label, mutate) => {
    const incoming = growth("2026-08-01", 3);
    const target = row("target", growth("2026-08-01", 3), "2026-08-04T00:00:00.000Z");
    mutate(incoming, target);
    arrange(target, [target]);

    await expect(replace(incoming, [target.id], target.id)).rejects.toMatchObject({
      code: "DMP_REPORT_REPLACE_CONFLICT",
      status: 409
    });
    expectNoMutation();
  });

  it("rejects both an unabsorbed fingerprint collision and a concurrent P2002 without falling back to upsert", async () => {
    const incoming = growth("2026-08-01", 3);
    const target = row("target", incoming, "2026-08-04T00:00:00.000Z");
    arrange(target, [target], { id: "collision" });
    await expect(replace(incoming, [target.id], target.id)).rejects.toMatchObject({ status: 409 });
    expectNoMutation();

    arrange(target, [target]);
    mocks.reportUpdate.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    await expect(replace(incoming, [target.id], target.id)).rejects.toMatchObject({ status: 409 });
    expect(mocks.reportUpsert).not.toHaveBeenCalled();
  });

  it("serializes a normal exact retry on the pair lock and still upserts idempotently", async () => {
    const incoming = growth("2026-08-01", 3);
    arrangeNormal(incoming, [row("existing", incoming, "2026-08-04T00:00:00.000Z")]);

    await expect(saveNormally(incoming)).resolves.toMatchObject({ id: "saved" });
    expect(mocks.executeRaw.mock.calls.map((call) => call[1])).toEqual([
      `dmp-report-pair:${ACCESS.tenantId}:${ACCESS.userId}:${SHOP.id}:${SUBJECT}:${COMPETITOR}`
    ]);
    expect(mocks.reportUpsert).toHaveBeenCalledTimes(1);
  });

  it("returns HISTORY_STALE for a connected different-fingerprint normal save", async () => {
    const incoming = growth("2026-08-04", 3);
    arrangeNormal(incoming, [row("existing", growth("2026-08-01", 3), "2026-08-04T00:00:00.000Z")]);

    await expect(saveNormally(incoming)).rejects.toMatchObject({
      code: "DMP_REPORT_HISTORY_STALE",
      status: 409
    });
    expect(mocks.reportUpsert).not.toHaveBeenCalled();
  });

  it("allows a disconnected complete normal save and keeps partial saves outside the stale gate", async () => {
    const disconnected = growth("2026-08-10", 3);
    arrangeNormal(disconnected, [row("existing", growth("2026-08-01", 3), "2026-08-04T00:00:00.000Z")]);
    await expect(saveNormally(disconnected)).resolves.toMatchObject({ id: "saved" });

    mocks.reportFindMany.mockClear();
    mocks.reportUpsert.mockClear();
    const partial = growth("2026-08-04", 3);
    arrangeNormal(partial, [row("connected", growth("2026-08-01", 3), "2026-08-04T00:00:00.000Z")]);
    await expect(saveNormally(partial, "partial")).resolves.toMatchObject({ id: "saved" });
    expect(mocks.reportFindMany).not.toHaveBeenCalled();
    expect(mocks.reportUpsert).toHaveBeenCalledTimes(1);
  });

  it("locks, rechecks, and deletes an owned report in the same transaction", async () => {
    const owned = row("report-delete", growth("2026-08-01", 3), "2026-08-04T00:00:00.000Z");
    arrange(owned, [owned]);
    mocks.reportDeleteMany.mockResolvedValue({ count: 1 });

    await expect(deleteDmpBusinessReport(ACCESS, owned.id)).resolves.toBe(true);
    expect(mocks.executeRaw.mock.calls.map((call) => call[1])).toEqual([
      `dmp-report-target:${ACCESS.tenantId}:${ACCESS.userId}:${owned.id}`
    ]);
    expect(mocks.reportFindFirst).toHaveBeenCalledWith({
      where: { id: owned.id, tenantId: ACCESS.tenantId, userId: ACCESS.userId },
      select: { id: true }
    });
    expect(mocks.reportDeleteMany).toHaveBeenCalledWith({
      where: { id: owned.id, tenantId: ACCESS.tenantId, userId: ACCESS.userId }
    });
  });
});

function arrange(
  target: ReturnType<typeof row>,
  rows: Array<ReturnType<typeof row>>,
  collision: { id: string } | null = null
) {
  mocks.reportFindFirst.mockImplementation(async ({ where }: { where: { id?: unknown; fingerprint?: unknown } }) => (
    typeof where.id === "string" ? target : where.fingerprint ? collision : null
  ));
  mocks.reportFindMany.mockResolvedValue(rows);
}

function replace(
  report: DmpCanonicalReport,
  absorbedReportIds: string[],
  replaceReportId: string,
  sourceShop: { shopId?: string; shopName?: string } | null = { shopId: SHOP.id }
) {
  return saveDmpBusinessReport({
    access: ACCESS,
    report,
    subjectItemId: SUBJECT,
    competitorItemId: COMPETITOR,
    quality: "complete",
    sourceVersion: "2.3.46",
    ...(sourceShop ? { sourceShop } : {}),
    archiveMode: "replace-latest-pair",
    replaceReportId,
    absorbedReportIds
  });
}

function arrangeNormal(report: DmpCanonicalReport, candidates: Array<ReturnType<typeof row>>) {
  mocks.reportFindFirst.mockResolvedValue(null);
  mocks.reportFindMany.mockResolvedValue(candidates);
  mocks.reportUpsert.mockResolvedValue({
    ...row("saved", report, "2026-08-30T00:00:00.000Z"),
    shop: SHOP
  });
}

function saveNormally(report: DmpCanonicalReport, quality: "complete" | "partial" = "complete") {
  return saveDmpBusinessReport({
    access: ACCESS,
    report,
    subjectItemId: SUBJECT,
    competitorItemId: COMPETITOR,
    quality,
    sourceVersion: "2.3.46",
    sourceShop: { shopId: SHOP.id }
  });
}

function expectNoMutation() {
  expect(mocks.reportUpsert).not.toHaveBeenCalled();
  expect(mocks.shareUpdateMany).not.toHaveBeenCalled();
  expect(mocks.reportDeleteMany).not.toHaveBeenCalled();
  expect(mocks.reportUpdate).not.toHaveBeenCalled();
}

function row(id: string, report: DmpCanonicalReport, createdAt: string) {
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
    createdAt: new Date(createdAt),
    report
  };
}

function growth(startDate: string, days: number): DmpCanonicalReport {
  const dates = Array.from({ length: days }, (_, index) => addDays(startDate, index));
  const metrics = [
    ["总GMV", "700", "900"], ["付费成交额", "350", "450"],
    ["推广消耗", "100", "120"], ["费比", "14.29%", "13.33%"],
    ["ROI", "3.5", "3.75"], ["PPC", "2", "2.4"],
    ["付费金额占比", "50%", "50%"], ["全域ROAS", "7", "7.5"]
  ];
  const tables = DMP_GROWTH_REPORT_TABLES.map((name) => {
    if (name === "报告总览") return { name, columns: ["项目", "主体", "对手"], rows: metrics.map((cells) => ({ cells })) };
    if (name === "商品与成功品") return {
      name, columns: ["对象", "商品ID"], rows: [
        { cells: ["主体", SUBJECT] }, { cells: ["目标对手", COMPETITOR] }
      ]
    };
    if (name === "周期汇总") return {
      name, columns: ["对象", "商品ID", "总GMV"], rows: [
        { cells: ["主体", SUBJECT, "700"] }, { cells: ["目标对手", COMPETITOR, "900"] }
      ]
    };
    if (name === "日GMV与费比") return {
      name,
      columns: ["日期", "主体日GMV", "日GMV", "日总消耗"],
      rows: dates.map((date, index) => ({ cells: [date, String(100 + index), String(120 + index), "10"] }))
    };
    return { name, columns: ["指标"], rows: [{ cells: ["已披露"] }] };
  });
  const checked = validateDmpCanonicalReport({
    schema_version: "3.0",
    title: "达摩盘商品成长竞品对标报告｜少壮AI自动化",
    item_id: SUBJECT,
    period: `${dates[0]} 至 ${dates.at(-1)}`,
    tables,
    render_data: {
      version: "1",
      subject_daily_gmv: dates.map((date, index) => ({ date, gmv: String(100 + index) }))
    }
  });
  if (!checked.report || checked.issues?.length) throw new Error(checked.error || checked.issues?.join("；") || "fixture invalid");
  return checked.report;
}

function addDays(startDate: string, offset: number) {
  return new Date(Date.parse(`${startDate}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}
