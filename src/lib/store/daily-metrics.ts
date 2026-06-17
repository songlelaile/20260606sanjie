import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { DailyProductMetricInput } from "@/lib/imports/map-rows";
import type { ProductSourceRow } from "@/lib/types/domain";

/** 复用的 where 片段：租户 + 可选日期区间 + 可选商品集（下推到 SQL）。 */
function dailyWhere(
  tenantId: string,
  opts?: { start?: string; end?: string; productIds?: string[] | null }
): Prisma.DailyProductMetricWhereInput {
  const where: Prisma.DailyProductMetricWhereInput = { tenantId };
  if (opts?.start && opts?.end) {
    where.date = { gte: opts.start, lte: opts.end };
  }
  if (opts?.productIds && opts.productIds.length > 0) {
    where.productId = { in: opts.productIds };
  }
  return where;
}

/**
 * 分日商品指标的写入与聚合（v2 时序底座）。
 * - 写：按 (tenantId, productId, date) upsert，重传同日覆盖、新日追加（累积留存）。
 * - 读：把窗口内分日数据聚合成"每商品一行"的 ProductSourceRow，喂给现有三阶算法。
 */

const UPSERT_CHUNK = 800;

/**
 * upsert 一批分日商品指标（同一批内按 (productId,date) 已去重）。
 * 批量化：分块用事务 deleteMany(按精确键集) + createMany，避免逐行 N 次往返。
 */
export async function upsertDailyProductMetrics(
  tenantId: string,
  rows: DailyProductMetricInput[]
): Promise<number> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    await prisma.$transaction([
      prisma.dailyProductMetric.deleteMany({
        where: {
          tenantId,
          OR: chunk.map((r) => ({ productId: r.productId, date: r.date }))
        }
      }),
      prisma.dailyProductMetric.createMany({
        data: chunk.map((r) => ({
          tenantId,
          productId: r.productId,
          date: r.date,
          productName: r.productName,
          visitors: Math.round(r.visitors),
          views: Math.round(r.views),
          averageStaySeconds: r.averageStaySeconds,
          bounceRate: r.bounceRate,
          paymentBuyers: Math.round(r.paymentBuyers),
          paymentAmount: r.paymentAmount,
          productPaymentConversionRate: r.productPaymentConversionRate,
          refundAmount: r.refundAmount,
          searchGuidedPaymentConversionRate: r.searchGuidedPaymentConversionRate,
          searchGuidedVisitors: Math.round(r.searchGuidedVisitors)
        }))
      })
    ]);
  }
  return rows.length;
}

/**
 * 保留最近 keepDays 天（相对该租户已有数据的最新日期），清掉更早的分日明细。
 * keepDays<=0 表示永久保留。返回删除行数。
 */
export async function pruneDailyProductMetrics(tenantId: string, keepDays: number): Promise<number> {
  if (!keepDays || keepDays <= 0) {
    return 0;
  }
  const range = await getProductDailyDateRange(tenantId);
  if (!range) {
    return 0;
  }
  const cutoff = addDays(range.end, -(keepDays - 1)); // 保留 [end-keepDays+1, end]
  const result = await prisma.dailyProductMetric.deleteMany({
    where: { tenantId, date: { lt: cutoff } }
  });
  return result.count;
}

/** 清空某租户全部分日商品指标（主动「清空源数据」时调用）。 */
export async function clearDailyProductMetrics(tenantId: string): Promise<void> {
  await prisma.dailyProductMetric.deleteMany({ where: { tenantId } });
}

/** 某租户分日数据的日期范围与天数（用于展示"数据区间"）——下推 DB min/max + 分组计数。 */
export async function getProductDailyDateRange(
  tenantId: string
): Promise<{ start: string; end: string; days: number } | null> {
  const bounds = await prisma.dailyProductMetric.aggregate({
    where: { tenantId },
    _min: { date: true },
    _max: { date: true }
  });
  if (!bounds._min.date || !bounds._max.date) {
    return null;
  }
  // 不同日期数（≤保留天数）：DB 端按 date 分组取行数。
  const distinctDays = await prisma.dailyProductMetric.groupBy({
    by: ["date"],
    where: { tenantId }
  });
  return { start: bounds._min.date, end: bounds._max.date, days: distinctDays.length };
}

/**
 * 把窗口内分日数据聚合成每商品一行 ProductSourceRow。
 * 可加和项（访客/浏览/买家/金额/退款）求和；费率项按访客加权平均（保留报表口径）。
 * range 省略则聚合该租户全部已有分日数据（= 当前周期）。
 */
interface AggRawRow {
  productId: string;
  productName: string | null;
  visitors: number;
  views: number;
  paymentBuyers: number;
  paymentAmount: number;
  refundAmount: number;
  searchGuidedVisitors: number;
  stayW: number;
  bounceW: number;
  convW: number;
  searchConvW: number;
  lastDate: string;
}

export async function aggregateProductForCycle(
  tenantId: string,
  range?: { start: string; end: string }
): Promise<ProductSourceRow[]> {
  // 下推到 SQL：按 productId 分组，可加和项 SUM，费率项 SUM(费率×访客) 做访客加权（表达式聚合 Prisma 内置做不了，用 raw）。
  // 全部 ::float8 转双精度，避免 BigInt；商品名取窗口内最新一天。
  const dateClause =
    range !== undefined
      ? Prisma.sql`AND "date" >= ${range.start} AND "date" <= ${range.end}`
      : Prisma.empty;
  const rows = await prisma.$queryRaw<AggRawRow[]>(Prisma.sql`
    SELECT
      "productId",
      (array_agg("productName" ORDER BY "date" DESC))[1] AS "productName",
      MAX("date") AS "lastDate",
      SUM("visitors")::float8 AS "visitors",
      SUM("views")::float8 AS "views",
      SUM("paymentBuyers")::float8 AS "paymentBuyers",
      SUM("paymentAmount")::float8 AS "paymentAmount",
      SUM("refundAmount")::float8 AS "refundAmount",
      SUM("searchGuidedVisitors")::float8 AS "searchGuidedVisitors",
      SUM("averageStaySeconds" * "visitors")::float8 AS "stayW",
      SUM("bounceRate" * "visitors")::float8 AS "bounceW",
      SUM("productPaymentConversionRate" * "visitors")::float8 AS "convW",
      SUM("searchGuidedPaymentConversionRate" * "visitors")::float8 AS "searchConvW"
    FROM "DailyProductMetric"
    WHERE "tenantId" = ${tenantId} ${dateClause}
    GROUP BY "productId"
  `);

  return rows.map((a) => {
    const w = a.visitors > 0 ? a.visitors : 1;
    return {
      date: a.lastDate,
      productId: a.productId,
      productName: a.productName ?? a.productId,
      visitors: a.visitors,
      views: a.views,
      averageStaySeconds: a.stayW / w,
      bounceRate: a.bounceW / w,
      orderBuyers: 0,
      paymentBuyers: a.paymentBuyers,
      paymentAmount: a.paymentAmount,
      productPaymentConversionRate: a.convW / w,
      refundAmount: a.refundAmount,
      visitorValue: 0,
      searchGuidedPaymentConversionRate: a.searchConvW / w,
      searchGuidedVisitors: a.searchGuidedVisitors
    };
  });
}

// ——————————————————————————————————————————————————————————————
// 前后对比用聚合（v2 阶段3）
// ——————————————————————————————————————————————————————————————

/** ISO 日期加减天数。 */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export interface WindowSum {
  paymentAmount: number;
  refundAmount: number;
  visitors: number;
  paymentBuyers: number;
}

const SUM_SELECT = {
  paymentAmount: true,
  refundAmount: true,
  visitors: true,
  paymentBuyers: true
} as const;

type SumAgg = {
  paymentAmount: number | null;
  refundAmount: number | null;
  visitors: number | null;
  paymentBuyers: number | null;
};

function toWindowSum(s: SumAgg | null | undefined): WindowSum {
  return {
    paymentAmount: s?.paymentAmount ?? 0,
    refundAmount: s?.refundAmount ?? 0,
    visitors: s?.visitors ?? 0,
    paymentBuyers: s?.paymentBuyers ?? 0
  };
}

/** 窗口内（商品集为空=整店）求和——下推 DB aggregate。 */
export async function sumProductWindow(
  tenantId: string,
  productIds: string[] | null,
  start: string,
  end: string
): Promise<WindowSum> {
  const agg = await prisma.dailyProductMetric.aggregate({
    where: dailyWhere(tenantId, { start, end, productIds }),
    _sum: SUM_SELECT
  });
  return toWindowSum(agg._sum);
}

/** 窗口内按商品分组求和（lens B 用）——下推 DB groupBy。 */
export async function sumProductWindowByProduct(
  tenantId: string,
  productIds: string[] | null,
  start: string,
  end: string
): Promise<Map<string, WindowSum>> {
  const groups = await prisma.dailyProductMetric.groupBy({
    by: ["productId"],
    where: dailyWhere(tenantId, { start, end, productIds }),
    _sum: SUM_SELECT
  });
  const byId = new Map<string, WindowSum>();
  for (const g of groups) {
    byId.set(g.productId, toWindowSum(g._sum));
  }
  return byId;
}

export interface StoreTrendPoint {
  date: string;
  netSales: number;
  paymentAmount: number;
  refundAmount: number;
  visitors: number;
  paymentBuyers: number;
}

/** 整店按天趋势（商品集为空=整店；否则限定商品集），日期升序——下推 DB groupBy。 */
export async function storeDailyTrend(
  tenantId: string,
  start: string,
  end: string,
  productIds?: string[] | null
): Promise<StoreTrendPoint[]> {
  const groups = await prisma.dailyProductMetric.groupBy({
    by: ["date"],
    where: dailyWhere(tenantId, { start, end, productIds }),
    _sum: SUM_SELECT,
    orderBy: { date: "asc" }
  });
  return groups.map((g) => {
    const paymentAmount = g._sum.paymentAmount ?? 0;
    const refundAmount = g._sum.refundAmount ?? 0;
    return {
      date: g.date,
      paymentAmount,
      refundAmount,
      visitors: g._sum.visitors ?? 0,
      paymentBuyers: g._sum.paymentBuyers ?? 0,
      netSales: paymentAmount - refundAmount
    };
  });
}
