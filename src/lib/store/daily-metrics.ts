import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type {
  DailyAudienceMetricInput,
  DailyProductMetricInput,
  DailyPromotionMetricInput
} from "@/lib/imports/map-rows";
import type { AudienceSourceRow, ProductSourceRow, PromotionProductRow } from "@/lib/types/domain";

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

// ——————————————————————————————————————————————————————————————
// 分日推广宝贝（v2）：写入 + 聚合（SQL 下推）+ 保留/清理
// ——————————————————————————————————————————————————————————————

export async function upsertDailyPromotionMetrics(
  tenantId: string,
  rows: DailyPromotionMetricInput[]
): Promise<number> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    await prisma.$transaction([
      prisma.dailyPromotionMetric.deleteMany({
        where: { tenantId, OR: chunk.map((r) => ({ subjectId: r.subjectId, date: r.date })) }
      }),
      prisma.dailyPromotionMetric.createMany({
        data: chunk.map((r) => ({
          tenantId,
          subjectId: r.subjectId,
          date: r.date,
          subjectName: r.subjectName,
          impressions: Math.round(r.impressions),
          clicks: Math.round(r.clicks),
          cost: r.cost,
          roi: r.roi
        }))
      })
    ]);
  }
  return rows.length;
}

export interface PromotionWindowSum {
  cost: number;
  clicks: number;
  impressions: number;
  roiCost: number; // Σ(roi×cost)，用于花费加权 ROI
}

/** 窗口内推广汇总（subjectIds 为空=全部主体）——加权 ROI 需 Σ(roi×cost)，用 raw。 */
export async function sumPromotionWindow(
  tenantId: string,
  subjectIds: string[] | null,
  start: string,
  end: string
): Promise<PromotionWindowSum> {
  const subjectClause =
    subjectIds && subjectIds.length > 0
      ? Prisma.sql`AND "subjectId" IN (${Prisma.join(subjectIds)})`
      : Prisma.empty;
  const rows = await prisma.$queryRaw<PromotionWindowSum[]>(Prisma.sql`
    SELECT
      COALESCE(SUM("cost"), 0)::float8 AS "cost",
      COALESCE(SUM("clicks"), 0)::float8 AS "clicks",
      COALESCE(SUM("impressions"), 0)::float8 AS "impressions",
      COALESCE(SUM("roi" * "cost"), 0)::float8 AS "roiCost"
    FROM "DailyPromotionMetric"
    WHERE "tenantId" = ${tenantId} AND "date" >= ${start} AND "date" <= ${end} ${subjectClause}
  `);
  return rows[0] ?? { cost: 0, clicks: 0, impressions: 0, roiCost: 0 };
}

interface PromoRawRow {
  subjectId: string;
  subjectName: string | null;
  lastDate: string;
  impressions: number;
  clicks: number;
  cost: number;
  roiCost: number;
}

/** 按主体聚合推广：展现/点击/花费 SUM；ctr/客单点击/ROI 重算（ROI 花费加权）。 */
export async function aggregatePromotionForCycle(
  tenantId: string,
  range?: { start: string; end: string }
): Promise<PromotionProductRow[]> {
  const dateClause =
    range !== undefined
      ? Prisma.sql`AND "date" >= ${range.start} AND "date" <= ${range.end}`
      : Prisma.empty;
  const rows = await prisma.$queryRaw<PromoRawRow[]>(Prisma.sql`
    SELECT
      "subjectId",
      (array_agg("subjectName" ORDER BY "date" DESC))[1] AS "subjectName",
      MAX("date") AS "lastDate",
      SUM("impressions")::float8 AS "impressions",
      SUM("clicks")::float8 AS "clicks",
      SUM("cost")::float8 AS "cost",
      SUM("roi" * "cost")::float8 AS "roiCost"
    FROM "DailyPromotionMetric"
    WHERE "tenantId" = ${tenantId} ${dateClause}
    GROUP BY "subjectId"
  `);
  return rows.map((r) => ({
    date: r.lastDate,
    subjectId: r.subjectId,
    subjectName: r.subjectName ?? r.subjectId,
    impressions: r.impressions,
    clicks: r.clicks,
    cost: r.cost,
    ctr: r.impressions > 0 ? r.clicks / r.impressions : 0,
    averageClickCost: r.clicks > 0 ? r.cost / r.clicks : 0,
    roi: r.cost > 0 ? r.roiCost / r.cost : 0
  }));
}

// ——————————————————————————————————————————————————————————————
// 分日人群（v2）：写入 + 聚合（SQL 下推）+ 保留/清理
// ——————————————————————————————————————————————————————————————

export async function upsertDailyAudienceMetrics(
  tenantId: string,
  rows: DailyAudienceMetricInput[]
): Promise<number> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    await prisma.$transaction([
      prisma.dailyAudienceMetric.deleteMany({
        where: {
          tenantId,
          OR: chunk.map((r) => ({
            date: r.date,
            planId: r.planId,
            audienceName: r.audienceName,
            subjectId: r.subjectId
          }))
        }
      }),
      prisma.dailyAudienceMetric.createMany({
        data: chunk.map((r) => ({
          tenantId,
          date: r.date,
          sceneId: r.sceneId,
          sceneName: r.sceneName,
          planId: r.planId,
          planName: r.planName,
          audienceName: r.audienceName,
          subjectId: r.subjectId,
          subjectName: r.subjectName,
          clicks: Math.round(r.clicks),
          roi: r.roi,
          guidedPotentialCustomerRatio: r.guidedPotentialCustomerRatio,
          newCustomerRatio: r.newCustomerRatio
        }))
      })
    ]);
  }
  return rows.length;
}

interface AudienceRawRow {
  planId: string;
  audienceName: string;
  subjectId: string;
  sceneId: string | null;
  sceneName: string | null;
  planName: string | null;
  subjectName: string | null;
  minDate: string;
  maxDate: string;
  clicks: number;
  roiClicks: number;
  guidedW: number;
  newW: number;
}

/** 按 (计划,人群,主体) 聚合人群：点击 SUM；ROI/各比率按点击加权；dateRange=最小~最大日。 */
export async function aggregateAudienceForCycle(
  tenantId: string,
  range?: { start: string; end: string }
): Promise<AudienceSourceRow[]> {
  const dateClause =
    range !== undefined
      ? Prisma.sql`AND "date" >= ${range.start} AND "date" <= ${range.end}`
      : Prisma.empty;
  const rows = await prisma.$queryRaw<AudienceRawRow[]>(Prisma.sql`
    SELECT
      "planId", "audienceName", "subjectId",
      (array_agg("sceneId" ORDER BY "date" DESC))[1] AS "sceneId",
      (array_agg("sceneName" ORDER BY "date" DESC))[1] AS "sceneName",
      (array_agg("planName" ORDER BY "date" DESC))[1] AS "planName",
      (array_agg("subjectName" ORDER BY "date" DESC))[1] AS "subjectName",
      MIN("date") AS "minDate", MAX("date") AS "maxDate",
      SUM("clicks")::float8 AS "clicks",
      SUM("roi" * "clicks")::float8 AS "roiClicks",
      SUM("guidedPotentialCustomerRatio" * "clicks")::float8 AS "guidedW",
      SUM("newCustomerRatio" * "clicks")::float8 AS "newW"
    FROM "DailyAudienceMetric"
    WHERE "tenantId" = ${tenantId} ${dateClause}
    GROUP BY "planId", "audienceName", "subjectId"
  `);
  return rows.map((r) => {
    const w = r.clicks > 0 ? r.clicks : 1;
    return {
      dateRange: r.minDate === r.maxDate ? r.minDate : `${r.minDate}~${r.maxDate}`,
      sceneId: r.sceneId ?? "",
      sceneName: r.sceneName ?? "",
      planId: r.planId,
      planName: r.planName ?? "",
      audienceName: r.audienceName,
      subjectId: r.subjectId,
      subjectName: r.subjectName ?? r.subjectId,
      clicks: r.clicks,
      roi: r.roiClicks / w,
      guidedVisitorCount: 0,
      guidedPotentialCustomerRatio: r.guidedW / w,
      newCustomerCount: 0,
      newCustomerRatio: r.newW / w
    };
  });
}

export interface AudienceWindowGroup {
  planId: string;
  planName: string | null;
  audienceName: string;
  clicks: number;
  roiClicks: number; // Σ(roi×clicks)，点击加权 ROI
}

/** 窗口内按 (计划,人群) 聚合（subjectIds 为空=全部主体）——点击加权 ROI 需 Σ(roi×clicks)，用 raw。 */
export async function sumAudienceWindowByGroup(
  tenantId: string,
  subjectIds: string[] | null,
  start: string,
  end: string
): Promise<AudienceWindowGroup[]> {
  const subjectClause =
    subjectIds && subjectIds.length > 0
      ? Prisma.sql`AND "subjectId" IN (${Prisma.join(subjectIds)})`
      : Prisma.empty;
  return prisma.$queryRaw<AudienceWindowGroup[]>(Prisma.sql`
    SELECT
      "planId", "audienceName",
      (array_agg("planName" ORDER BY "date" DESC))[1] AS "planName",
      SUM("clicks")::float8 AS "clicks",
      SUM("roi" * "clicks")::float8 AS "roiClicks"
    FROM "DailyAudienceMetric"
    WHERE "tenantId" = ${tenantId} AND "date" >= ${start} AND "date" <= ${end} ${subjectClause}
    GROUP BY "planId", "audienceName"
  `);
}

// ——————————————————————————————————————————————————————————————
// 全部分日表统一的清理/保留
// ——————————————————————————————————————————————————————————————

/** 主动「清空源数据」：清掉该租户三张分日表。 */
export async function clearAllDailyMetrics(tenantId: string): Promise<void> {
  await prisma.$transaction([
    prisma.dailyProductMetric.deleteMany({ where: { tenantId } }),
    prisma.dailyPromotionMetric.deleteMany({ where: { tenantId } }),
    prisma.dailyAudienceMetric.deleteMany({ where: { tenantId } })
  ]);
}

/** 按保留天数清理三张分日表（各自相对自己的最新日期）。 */
export async function pruneAllDailyMetrics(tenantId: string, keepDays: number): Promise<void> {
  if (!keepDays || keepDays <= 0) {
    return;
  }
  await pruneDailyProductMetrics(tenantId, keepDays);
  await prunePromotion(tenantId, keepDays);
  await pruneAudience(tenantId, keepDays);
}

async function prunePromotion(tenantId: string, keepDays: number): Promise<void> {
  const bounds = await prisma.dailyPromotionMetric.aggregate({ where: { tenantId }, _max: { date: true } });
  if (!bounds._max.date) return;
  const cutoff = addDays(bounds._max.date, -(keepDays - 1));
  await prisma.dailyPromotionMetric.deleteMany({ where: { tenantId, date: { lt: cutoff } } });
}

async function pruneAudience(tenantId: string, keepDays: number): Promise<void> {
  const bounds = await prisma.dailyAudienceMetric.aggregate({ where: { tenantId }, _max: { date: true } });
  if (!bounds._max.date) return;
  const cutoff = addDays(bounds._max.date, -(keepDays - 1));
  await prisma.dailyAudienceMetric.deleteMany({ where: { tenantId, date: { lt: cutoff } } });
}
