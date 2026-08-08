import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type {
  DailyAudienceMetricInput,
  DailyProductMetricInput,
  DailyPromotionMetricInput
} from "@/lib/imports/map-rows";
import type {
  AudienceSourceRow,
  DailyTrendPoint,
  ProductSourceRow,
  PromotionProductRow,
  ReportType
} from "@/lib/types/domain";

/** 复用的 where 片段：租户 + 可选日期区间 + 可选商品集（下推到 SQL）。 */
function dailyWhere(
  tenantId: string,
  shopId: string,
  opts?: { start?: string; end?: string; productIds?: string[] | null }
): Prisma.DailyProductMetricWhereInput {
  const where: Prisma.DailyProductMetricWhereInput = { tenantId, shopId };
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

// 单条 INSERT...ON CONFLICT 的批大小。无 OR 上限约束，受 Postgres 65535 bind 参数限制：
// 每行 bind = 列数-1（updatedAt 用字面量 now() 不占 bind）→ 商品 15/行(上限 4369)、人群 14/行(4681)、
// 推广 9/行(7281)。取 2000 留 ~2× 余量；DB 执行成本与 chunk 无关，调大只为减少远端 RDS 往返。
const UPSERT_CHUNK = 2000;

function roundNullable(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

function divideNullable(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  const value = numerator / denominator;
  return Number.isFinite(value) ? value : null;
}

// 进 chunk 前按唯一键去重（保最后一条，与 ON CONFLICT 覆盖语义一致）。正常路径客户端 mapper 已去重，
// 此处给单条 INSERT...ON CONFLICT 兜底：同一批出现重复唯一键会触发 PG "cannot affect row a second
// time" 致整批失败。用 \0 分隔避免值含空格时的拼接碰撞。O(n) Map，对 12 万行可忽略。
function dedupeByKey<T>(rows: T[], keyOf: (r: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const r of rows) {
    byKey.set(keyOf(r), r);
  }
  return [...byKey.values()];
}

/**
 * upsert 一批分日商品指标（同一批内按 (productId,date) 已去重，与 @@unique 对齐）。
 * 单条 INSERT ... ON CONFLICT (tenantId,productId,date) DO UPDATE：冲突即覆盖，新键追加。
 */
export async function upsertDailyProductMetrics(
  tenantId: string,
  shopId: string,
  rows: DailyProductMetricInput[]
): Promise<number> {
  const deduped = dedupeByKey(rows, (r) => `${r.productId} ${r.date}`);
  for (let i = 0; i < deduped.length; i += UPSERT_CHUNK) {
    const chunk = deduped.slice(i, i + UPSERT_CHUNK);
    const values = chunk.map(
      (r) => Prisma.sql`(${randomUUID()}, ${tenantId}, ${shopId}, ${r.productId}, ${r.date}, ${r.productName},
        ${roundNullable(r.visitors)}, ${roundNullable(r.views)}, ${r.averageStaySeconds}, ${r.bounceRate},
        ${roundNullable(r.paymentBuyers)}, ${r.paymentAmount}, ${r.productPaymentConversionRate},
        ${r.refundAmount}, ${r.searchGuidedPaymentConversionRate}, ${roundNullable(r.searchGuidedVisitors)}, (now() AT TIME ZONE 'UTC'))`
    );
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "DailyProductMetric"
        ("id","tenantId","shopId","productId","date","productName","visitors","views","averageStaySeconds",
         "bounceRate","paymentBuyers","paymentAmount","productPaymentConversionRate","refundAmount",
         "searchGuidedPaymentConversionRate","searchGuidedVisitors","updatedAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("tenantId","shopId","productId","date") DO UPDATE SET
        "productName" = EXCLUDED."productName",
        "visitors" = EXCLUDED."visitors",
        "views" = EXCLUDED."views",
        "averageStaySeconds" = EXCLUDED."averageStaySeconds",
        "bounceRate" = EXCLUDED."bounceRate",
        "paymentBuyers" = EXCLUDED."paymentBuyers",
        "paymentAmount" = EXCLUDED."paymentAmount",
        "productPaymentConversionRate" = EXCLUDED."productPaymentConversionRate",
        "refundAmount" = EXCLUDED."refundAmount",
        "searchGuidedPaymentConversionRate" = EXCLUDED."searchGuidedPaymentConversionRate",
        "searchGuidedVisitors" = EXCLUDED."searchGuidedVisitors",
        "updatedAt" = (now() AT TIME ZONE 'UTC')
    `);
  }
  return rows.length;
}

/**
 * 保留最近 keepDays 天（相对该租户已有数据的最新日期），清掉更早的分日明细。
 * keepDays<=0 表示永久保留。返回删除行数。
 */
export async function pruneDailyProductMetrics(tenantId: string, shopId: string, keepDays: number): Promise<number> {
  if (!keepDays || keepDays <= 0) {
    return 0;
  }
  // prune 只需 min/max，避免 getProductDailyDateRange 的 groupBy(distinct 天数) 多一次全扫。
  const bounds = await prisma.dailyProductMetric.aggregate({
    where: { tenantId, shopId },
    _min: { date: true },
    _max: { date: true }
  });
  if (!bounds._max.date || !bounds._min.date) {
    return 0;
  }
  const cutoff = addDays(bounds._max.date, -(keepDays - 1)); // 保留 [end-keepDays+1, end]
  if (cutoff <= bounds._min.date) {
    return 0; // 保留期≥数据跨度，无可删，跳过空 deleteMany
  }
  const result = await prisma.dailyProductMetric.deleteMany({
    where: { tenantId, shopId, date: { lt: cutoff } }
  });
  return result.count;
}

/** 清空某租户全部分日商品指标（主动「清空源数据」时调用）。 */
export async function clearDailyProductMetrics(tenantId: string, shopId: string): Promise<void> {
  await prisma.dailyProductMetric.deleteMany({ where: { tenantId, shopId } });
}

/** 某租户分日数据的日期范围与天数（用于展示"数据区间"）——下推 DB min/max + 分组计数。 */
export async function getProductDailyDateRange(
  tenantId: string,
  shopId: string
): Promise<{ start: string; end: string; days: number } | null> {
  // 单条 SQL 同时取 min/max/不同日期数（覆盖索引 (tenantId,date)），
  // 替代原先 aggregate + groupBy(date) 两次往返（后者对全表做 DISTINCT 扫描）。
  const rows = await prisma.$queryRaw<{ start: string | null; end: string | null; days: bigint }[]>(Prisma.sql`
    SELECT MIN("date") AS "start", MAX("date") AS "end", COUNT(DISTINCT "date") AS "days"
    FROM "DailyProductMetric"
    WHERE "tenantId" = ${tenantId} AND "shopId" = ${shopId}
  `);
  const row = rows[0];
  if (!row || !row.start || !row.end) {
    return null;
  }
  return { start: row.start, end: row.end, days: Number(row.days) };
}

/**
 * 把窗口内分日数据聚合成每商品一行 ProductSourceRow。
 * 可加和项（访客/浏览/买家/金额/退款）求和；费率项按访客加权平均（保留报表口径）。
 * range 省略则聚合该租户全部已有分日数据（= 当前周期）。
 */
interface AggRawRow {
  productId: string;
  productName: string | null;
  visitors: number | null;
  views: number | null;
  paymentBuyers: number | null;
  paymentAmount: number | null;
  refundAmount: number | null;
  searchGuidedVisitors: number | null;
  stayW: number | null;
  stayWeight: number | null;
  bounceW: number | null;
  bounceWeight: number | null;
  convW: number | null;
  convWeight: number | null;
  searchConvW: number | null;
  searchConvWeight: number | null;
  lastDate: string;
  observedDays: number;
}

export async function aggregateProductForCycle(
  tenantId: string,
  shopId: string,
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
      (MAX(ARRAY["date", "productName"]))[2] AS "productName",
      MAX("date") AS "lastDate",
      COUNT(DISTINCT "date")::int AS "observedDays",
      SUM("visitors")::float8 AS "visitors",
      SUM("views")::float8 AS "views",
      SUM("paymentBuyers")::float8 AS "paymentBuyers",
      SUM("paymentAmount")::float8 AS "paymentAmount",
      SUM("refundAmount")::float8 AS "refundAmount",
      SUM("searchGuidedVisitors")::float8 AS "searchGuidedVisitors",
      SUM("averageStaySeconds" * "visitors")::float8 AS "stayW",
      SUM("visitors") FILTER (WHERE "averageStaySeconds" IS NOT NULL)::float8 AS "stayWeight",
      SUM("bounceRate" * "visitors")::float8 AS "bounceW",
      SUM("visitors") FILTER (WHERE "bounceRate" IS NOT NULL)::float8 AS "bounceWeight",
      SUM("productPaymentConversionRate" * "visitors")::float8 AS "convW",
      SUM("visitors") FILTER (WHERE "productPaymentConversionRate" IS NOT NULL)::float8 AS "convWeight",
      SUM("searchGuidedPaymentConversionRate" * "searchGuidedVisitors")::float8 AS "searchConvW",
      SUM("searchGuidedVisitors") FILTER (WHERE "searchGuidedPaymentConversionRate" IS NOT NULL)::float8 AS "searchConvWeight"
    FROM "DailyProductMetric"
    WHERE "tenantId" = ${tenantId} AND "shopId" = ${shopId} ${dateClause}
    GROUP BY "productId"
  `);

  return rows.map((a) => {
    return {
      date: a.lastDate,
      productId: a.productId,
      productName: a.productName ?? a.productId,
      visitors: a.visitors,
      views: a.views,
      averageStaySeconds: divideNullable(a.stayW, a.stayWeight),
      bounceRate: divideNullable(a.bounceW, a.bounceWeight),
      orderBuyers: null,
      paymentBuyers: a.paymentBuyers,
      paymentAmount: a.paymentAmount,
      productPaymentConversionRate: divideNullable(a.convW, a.convWeight),
      refundAmount: a.refundAmount,
      visitorValue: null,
      searchGuidedPaymentConversionRate: divideNullable(a.searchConvW, a.searchConvWeight),
      searchGuidedVisitors: a.searchGuidedVisitors,
      observedDays: a.observedDays
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
  paymentAmount: number | null;
  refundAmount: number | null;
  visitors: number | null;
  views: number | null;
  paymentBuyers: number | null;
}

const SUM_SELECT = {
  paymentAmount: true,
  refundAmount: true,
  visitors: true,
  views: true,
  paymentBuyers: true
} as const;

type SumAgg = {
  paymentAmount: number | null;
  refundAmount: number | null;
  visitors: number | null;
  views: number | null;
  paymentBuyers: number | null;
};

function toWindowSum(s: SumAgg | null | undefined): WindowSum {
  return {
    paymentAmount: s?.paymentAmount ?? null,
    refundAmount: s?.refundAmount ?? null,
    visitors: s?.visitors ?? null,
    views: s?.views ?? null,
    paymentBuyers: s?.paymentBuyers ?? null
  };
}

/** 窗口内（商品集为空=整店）求和——下推 DB aggregate。 */
export async function sumProductWindow(
  tenantId: string,
  shopId: string,
  productIds: string[] | null,
  start: string,
  end: string
): Promise<WindowSum> {
  const agg = await prisma.dailyProductMetric.aggregate({
    where: dailyWhere(tenantId, shopId, { start, end, productIds }),
    _sum: SUM_SELECT
  });
  return toWindowSum(agg._sum);
}

/** 商品主数据源在窗口内实际覆盖的自然日数。缺日不能等同于经营值为 0。 */
export async function countProductWindowDays(
  tenantId: string,
  shopId: string,
  productIds: string[] | null,
  start: string,
  end: string
): Promise<number> {
  const groups = await prisma.dailyProductMetric.groupBy({
    by: ["date"],
    where: dailyWhere(tenantId, shopId, { start, end, productIds })
  });
  return groups.length;
}

/**
 * 窗口内**逐商品**实际覆盖的自然日数——下推 DB groupBy。
 *
 * 整店口径的 countProductWindowDays 只要当天有任一商品有数据就记 1 天，用它当作
 * 单商品日均值的分母，会把新品上架、中途下架、缺货商品按全窗口天数摊薄，系统性
 * 低估其真实表现。(tenantId, shopId, productId, date) 唯一，故行数即不同日期数。
 */
export async function countProductWindowDaysByProduct(
  tenantId: string,
  shopId: string,
  productIds: string[] | null,
  start: string,
  end: string
): Promise<Map<string, number>> {
  const groups = await prisma.dailyProductMetric.groupBy({
    by: ["productId"],
    where: dailyWhere(tenantId, shopId, { start, end, productIds }),
    _count: { date: true }
  });
  return new Map(groups.map((g) => [g.productId, g._count.date]));
}

/** 窗口内按商品分组求和（lens B 用）——下推 DB groupBy。 */
export async function sumProductWindowByProduct(
  tenantId: string,
  shopId: string,
  productIds: string[] | null,
  start: string,
  end: string
): Promise<Map<string, WindowSum>> {
  const groups = await prisma.dailyProductMetric.groupBy({
    by: ["productId"],
    where: dailyWhere(tenantId, shopId, { start, end, productIds }),
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
  netSales: number | null;
  paymentAmount: number | null;
  refundAmount: number | null;
  visitors: number | null;
  views: number | null;
  paymentBuyers: number | null;
}

/** 整店按天趋势（商品集为空=整店；否则限定商品集），日期升序——下推 DB groupBy。 */
export async function storeDailyTrend(
  tenantId: string,
  shopId: string,
  start: string,
  end: string,
  productIds?: string[] | null
): Promise<StoreTrendPoint[]> {
  const groups = await prisma.dailyProductMetric.groupBy({
    by: ["date"],
    where: dailyWhere(tenantId, shopId, { start, end, productIds }),
    _sum: SUM_SELECT,
    orderBy: { date: "asc" }
  });
  return groups.map((g) => {
    const paymentAmount = g._sum.paymentAmount ?? null;
    const refundAmount = g._sum.refundAmount ?? null;
    return {
      date: g.date,
      paymentAmount,
      refundAmount,
      visitors: g._sum.visitors ?? null,
      views: g._sum.views ?? null,
      paymentBuyers: g._sum.paymentBuyers ?? null,
      netSales: paymentAmount !== null && refundAmount !== null ? paymentAmount - refundAmount : null
    };
  });
}

export interface PromoTrendPoint {
  date: string;
  cost: number | null;
  clicks: number | null;
  impressions: number | null;
  roiCost: number | null; // Σ(roi×cost)，当日花费加权 ROI 用
}

/** 推广按天趋势（subjectIds 为空=全部主体），日期升序——加权 ROI 需 Σ(roi×cost)，用 raw。 */
export async function promotionDailyTrend(
  tenantId: string,
  shopId: string,
  start: string,
  end: string,
  subjectIds?: string[] | null
): Promise<PromoTrendPoint[]> {
  const subjectClause =
    subjectIds && subjectIds.length > 0
      ? Prisma.sql`AND "subjectId" IN (${Prisma.join(subjectIds)})`
      : Prisma.empty;
  return prisma.$queryRaw<PromoTrendPoint[]>(Prisma.sql`
    SELECT
      "date",
      SUM("cost")::float8 AS "cost",
      SUM("clicks")::float8 AS "clicks",
      SUM("impressions")::float8 AS "impressions",
      SUM("roi" * "cost")::float8 AS "roiCost"
    FROM "DailyPromotionMetric"
    WHERE "tenantId" = ${tenantId} AND "shopId" = ${shopId} AND "date" >= ${start} AND "date" <= ${end} ${subjectClause}
    GROUP BY "date"
    ORDER BY "date" ASC
  `);
}

/**
 * 构造分日趋势序列（商品派生 + 推广按日 join，覆盖 [start,end]，scopeIds 为空=整店）。
 * 取两侧日期并集；强度项（转化率/客单价/退款率/访客价值/CPC/ROI）分母为 0 → null（断点）。
 * 供"优化动作前后对比"与"KPI 分日趋势"共用。
 */
export async function buildDailyTrendSeries(
  tenantId: string,
  shopId: string,
  start: string,
  end: string,
  scopeIds?: string[] | null
): Promise<DailyTrendPoint[]> {
  const [trend, promoTrend] = await Promise.all([
    storeDailyTrend(tenantId, shopId, start, end, scopeIds),
    promotionDailyTrend(tenantId, shopId, start, end, scopeIds)
  ]);
  const productByDate = new Map(trend.map((p) => [p.date, p]));
  const promoByDate = new Map(promoTrend.map((p) => [p.date, p]));
  const allDates = [...new Set([...trend.map((p) => p.date), ...promoTrend.map((p) => p.date)])].sort();
  return allDates.map((date) => {
    const p = productByDate.get(date);
    const q = promoByDate.get(date);
    const paymentAmount = p?.paymentAmount ?? null;
    const refundAmount = p?.refundAmount ?? null;
    const visitors = p?.visitors ?? null;
    const paymentBuyers = p?.paymentBuyers ?? null;
    const cost = q?.cost ?? null;
    const clicks = q?.clicks ?? null;
    const impressions = q?.impressions ?? null;
    const roiCost = q?.roiCost ?? null;
    return {
      date,
      netSales: paymentAmount !== null && refundAmount !== null ? paymentAmount - refundAmount : null,
      paymentAmount,
      visitors,
      views: p?.views ?? null,
      paymentBuyers,
      conversion: visitors !== null && visitors > 0 && paymentBuyers !== null ? paymentBuyers / visitors : null,
      aov: paymentBuyers !== null && paymentBuyers > 0 && paymentAmount !== null ? paymentAmount / paymentBuyers : null,
      refundRate: paymentAmount !== null && paymentAmount > 0 && refundAmount !== null ? refundAmount / paymentAmount : null,
      uvValue: visitors !== null && visitors > 0 && paymentAmount !== null ? paymentAmount / visitors : null,
      adCost: cost,
      impressions,
      adClicks: clicks,
      cpc: clicks !== null && clicks > 0 && cost !== null ? cost / clicks : null,
      adRoi: cost !== null && cost > 0 && roiCost !== null ? roiCost / cost : null
    };
  });
}

// ——————————————————————————————————————————————————————————————
// 分日推广宝贝（v2）：写入 + 聚合（SQL 下推）+ 保留/清理
// ——————————————————————————————————————————————————————————————

export async function upsertDailyPromotionMetrics(
  tenantId: string,
  shopId: string,
  rows: DailyPromotionMetricInput[]
): Promise<number> {
  const deduped = dedupeByKey(rows, (r) => `${r.subjectId} ${r.date}`);
  for (let i = 0; i < deduped.length; i += UPSERT_CHUNK) {
    const chunk = deduped.slice(i, i + UPSERT_CHUNK);
    const values = chunk.map(
      (r) => Prisma.sql`(${randomUUID()}, ${tenantId}, ${shopId}, ${r.subjectId}, ${r.date}, ${r.subjectName},
        ${roundNullable(r.impressions)}, ${roundNullable(r.clicks)}, ${r.cost}, ${r.roi}, (now() AT TIME ZONE 'UTC'))`
    );
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "DailyPromotionMetric"
        ("id","tenantId","shopId","subjectId","date","subjectName","impressions","clicks","cost","roi","updatedAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("tenantId","shopId","subjectId","date") DO UPDATE SET
        "subjectName" = EXCLUDED."subjectName",
        "impressions" = EXCLUDED."impressions",
        "clicks" = EXCLUDED."clicks",
        "cost" = EXCLUDED."cost",
        "roi" = EXCLUDED."roi",
        "updatedAt" = (now() AT TIME ZONE 'UTC')
    `);
  }
  return rows.length;
}

export interface PromotionWindowSum {
  cost: number | null;
  clicks: number | null;
  impressions: number | null;
  roiCost: number | null; // Σ(roi×cost)，用于花费加权 ROI
}

/** 窗口内推广汇总（subjectIds 为空=全部主体）——加权 ROI 需 Σ(roi×cost)，用 raw。 */
export async function sumPromotionWindow(
  tenantId: string,
  shopId: string,
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
      SUM("cost")::float8 AS "cost",
      SUM("clicks")::float8 AS "clicks",
      SUM("impressions")::float8 AS "impressions",
      SUM("roi" * "cost")::float8 AS "roiCost"
    FROM "DailyPromotionMetric"
    WHERE "tenantId" = ${tenantId} AND "shopId" = ${shopId} AND "date" >= ${start} AND "date" <= ${end} ${subjectClause}
  `);
  return rows[0] ?? { cost: null, clicks: null, impressions: null, roiCost: null };
}

/** 推广源在窗口内实际覆盖的自然日数；存在推广数据时用于防止缺日低估成本。 */
export async function countPromotionWindowDays(
  tenantId: string,
  shopId: string,
  subjectIds: string[] | null,
  start: string,
  end: string
): Promise<number> {
  const subjectClause =
    subjectIds && subjectIds.length > 0
      ? Prisma.sql`AND "subjectId" IN (${Prisma.join(subjectIds)})`
      : Prisma.empty;
  const rows = await prisma.$queryRaw<{ days: bigint }[]>(Prisma.sql`
    SELECT COUNT(DISTINCT "date") AS "days"
    FROM "DailyPromotionMetric"
    WHERE "tenantId" = ${tenantId} AND "shopId" = ${shopId} AND "date" >= ${start} AND "date" <= ${end} ${subjectClause}
  `);
  return Number(rows[0]?.days ?? 0);
}

/** 窗口内按推广主体(=商品)聚合（subjectIds 为空=全部）——单品突破对比的投放列用。 */
export async function sumPromotionWindowByProduct(
  tenantId: string,
  shopId: string,
  subjectIds: string[] | null,
  start: string,
  end: string
): Promise<Map<string, PromotionWindowSum>> {
  const subjectClause =
    subjectIds && subjectIds.length > 0
      ? Prisma.sql`AND "subjectId" IN (${Prisma.join(subjectIds)})`
      : Prisma.empty;
  const rows = await prisma.$queryRaw<(PromotionWindowSum & { subjectId: string })[]>(Prisma.sql`
    SELECT
      "subjectId",
      SUM("cost")::float8 AS "cost",
      SUM("clicks")::float8 AS "clicks",
      SUM("impressions")::float8 AS "impressions",
      SUM("roi" * "cost")::float8 AS "roiCost"
    FROM "DailyPromotionMetric"
    WHERE "tenantId" = ${tenantId} AND "shopId" = ${shopId} AND "date" >= ${start} AND "date" <= ${end} ${subjectClause}
    GROUP BY "subjectId"
  `);
  const byId = new Map<string, PromotionWindowSum>();
  for (const r of rows) {
    byId.set(r.subjectId, { cost: r.cost, clicks: r.clicks, impressions: r.impressions, roiCost: r.roiCost });
  }
  return byId;
}

interface PromoRawRow {
  subjectId: string;
  subjectName: string | null;
  lastDate: string;
  impressions: number | null;
  clicks: number | null;
  cost: number | null;
  roiCost: number | null;
  roiCostWeight: number | null;
  observedDays: number;
}

/** 按主体聚合推广：展现/点击/花费 SUM；ctr/客单点击/ROI 重算（ROI 花费加权）。 */
export async function aggregatePromotionForCycle(
  tenantId: string,
  shopId: string,
  range?: { start: string; end: string }
): Promise<PromotionProductRow[]> {
  const dateClause =
    range !== undefined
      ? Prisma.sql`AND "date" >= ${range.start} AND "date" <= ${range.end}`
      : Prisma.empty;
  const rows = await prisma.$queryRaw<PromoRawRow[]>(Prisma.sql`
    SELECT
      "subjectId",
      (MAX(ARRAY["date", "subjectName"]))[2] AS "subjectName",
      MAX("date") AS "lastDate",
      COUNT(DISTINCT "date")::int AS "observedDays",
      SUM("impressions")::float8 AS "impressions",
      SUM("clicks")::float8 AS "clicks",
      SUM("cost")::float8 AS "cost",
      SUM("roi" * "cost")::float8 AS "roiCost",
      SUM("cost") FILTER (WHERE "roi" IS NOT NULL)::float8 AS "roiCostWeight"
    FROM "DailyPromotionMetric"
    WHERE "tenantId" = ${tenantId} AND "shopId" = ${shopId} ${dateClause}
    GROUP BY "subjectId"
  `);
  return rows.map((r) => ({
    date: r.lastDate,
    subjectId: r.subjectId,
    subjectName: r.subjectName ?? r.subjectId,
    impressions: r.impressions,
    clicks: r.clicks,
    cost: r.cost,
    ctr: divideNullable(r.clicks, r.impressions),
    averageClickCost: divideNullable(r.cost, r.clicks),
    roi: divideNullable(r.roiCost, r.roiCostWeight),
    observedDays: r.observedDays
  }));
}

// ——————————————————————————————————————————————————————————————
// 分日人群（v2）：写入 + 聚合（SQL 下推）+ 保留/清理
// ——————————————————————————————————————————————————————————————

export async function upsertDailyAudienceMetrics(
  tenantId: string,
  shopId: string,
  rows: DailyAudienceMetricInput[]
): Promise<number> {
  // 12 万行热路径：单条 INSERT ... ON CONFLICT(唯一键)。键 (date,planId,audienceName,subjectId) 与
  // mapAudienceDailyRows 去重键一致，批内不会有重复冲突键。
  const deduped = dedupeByKey(rows, (r) => [r.date, r.planId, r.audienceName, r.subjectId].join("\u0000"));
  for (let i = 0; i < deduped.length; i += UPSERT_CHUNK) {
    const chunk = deduped.slice(i, i + UPSERT_CHUNK);
    const values = chunk.map(
      (r) => Prisma.sql`(${randomUUID()}, ${tenantId}, ${shopId}, ${r.date}, ${r.sceneId}, ${r.sceneName}, ${r.planId},
        ${r.planName}, ${r.audienceName}, ${r.subjectId}, ${r.subjectName}, ${roundNullable(r.clicks)},
        ${r.roi}, ${r.guidedPotentialCustomerRatio}, ${r.newCustomerRatio}, (now() AT TIME ZONE 'UTC'))`
    );
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "DailyAudienceMetric"
        ("id","tenantId","shopId","date","sceneId","sceneName","planId","planName","audienceName","subjectId",
         "subjectName","clicks","roi","guidedPotentialCustomerRatio","newCustomerRatio","updatedAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("tenantId","shopId","date","planId","audienceName","subjectId") DO UPDATE SET
        "sceneId" = EXCLUDED."sceneId",
        "sceneName" = EXCLUDED."sceneName",
        "planName" = EXCLUDED."planName",
        "subjectName" = EXCLUDED."subjectName",
        "clicks" = EXCLUDED."clicks",
        "roi" = EXCLUDED."roi",
        "guidedPotentialCustomerRatio" = EXCLUDED."guidedPotentialCustomerRatio",
        "newCustomerRatio" = EXCLUDED."newCustomerRatio",
        "updatedAt" = (now() AT TIME ZONE 'UTC')
    `);
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
  clicks: number | null;
  roiClicks: number | null;
  roiWeight: number | null;
  guidedW: number | null;
  guidedWeight: number | null;
  newW: number | null;
  newWeight: number | null;
  observedDays: number;
}

/** 按 (计划,人群,主体) 聚合人群：点击 SUM；ROI/各比率按点击加权；dateRange=最小~最大日。 */
export async function aggregateAudienceForCycle(
  tenantId: string,
  shopId: string,
  range?: { start: string; end: string }
): Promise<AudienceSourceRow[]> {
  const dateClause =
    range !== undefined
      ? Prisma.sql`AND "date" >= ${range.start} AND "date" <= ${range.end}`
      : Prisma.empty;
  const rows = await prisma.$queryRaw<AudienceRawRow[]>(Prisma.sql`
    SELECT
      "planId", "audienceName", "subjectId",
      (MAX(ARRAY["date", "sceneId"]))[2] AS "sceneId",
      (MAX(ARRAY["date", "sceneName"]))[2] AS "sceneName",
      (MAX(ARRAY["date", "planName"]))[2] AS "planName",
      (MAX(ARRAY["date", "subjectName"]))[2] AS "subjectName",
      MIN("date") AS "minDate", MAX("date") AS "maxDate",
      COUNT(DISTINCT "date")::int AS "observedDays",
      SUM("clicks")::float8 AS "clicks",
      SUM("roi" * "clicks")::float8 AS "roiClicks",
      SUM("clicks") FILTER (WHERE "roi" IS NOT NULL)::float8 AS "roiWeight",
      SUM("guidedPotentialCustomerRatio" * "clicks")::float8 AS "guidedW",
      SUM("clicks") FILTER (WHERE "guidedPotentialCustomerRatio" IS NOT NULL)::float8 AS "guidedWeight",
      SUM("newCustomerRatio" * "clicks")::float8 AS "newW",
      SUM("clicks") FILTER (WHERE "newCustomerRatio" IS NOT NULL)::float8 AS "newWeight"
    FROM "DailyAudienceMetric"
    WHERE "tenantId" = ${tenantId} AND "shopId" = ${shopId} ${dateClause}
    GROUP BY "planId", "audienceName", "subjectId"
  `);
  return rows.map((r) => {
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
      roi: divideNullable(r.roiClicks, r.roiWeight),
      guidedVisitorCount: null,
      guidedPotentialCustomerRatio: divideNullable(r.guidedW, r.guidedWeight),
      newCustomerCount: null,
      newCustomerRatio: divideNullable(r.newW, r.newWeight),
      observedDays: r.observedDays
    };
  });
}

export interface AudienceWindowGroup {
  planId: string;
  planName: string | null;
  audienceName: string;
  subjectId: string;
  subjectName: string | null;
  clicks: number | null;
  roiClicks: number | null; // Σ(roi×clicks)，点击加权 ROI
  guidedW: number | null; // Σ(引导访问潜客占比×clicks)，点击加权
  newW: number | null; // Σ(成交新客占比×clicks)，点击加权
}

/**
 * 窗口内按 (计划,人群,主体) 聚合（subjectIds 为空=全部主体）——点击加权 ROI 需 Σ(roi×clicks)，用 raw。
 * 必须含 subjectId：分日唯一键含 subjectId，不分会把不同主体的同名人群错并。
 */
export async function sumAudienceWindowByGroup(
  tenantId: string,
  shopId: string,
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
      "planId", "audienceName", "subjectId",
      (MAX(ARRAY["date", "planName"]))[2] AS "planName",
      (MAX(ARRAY["date", "subjectName"]))[2] AS "subjectName",
      SUM("clicks")::float8 AS "clicks",
      SUM("roi" * "clicks")::float8 AS "roiClicks",
      SUM("guidedPotentialCustomerRatio" * "clicks")::float8 AS "guidedW",
      SUM("newCustomerRatio" * "clicks")::float8 AS "newW"
    FROM "DailyAudienceMetric"
    WHERE "tenantId" = ${tenantId} AND "shopId" = ${shopId} AND "date" >= ${start} AND "date" <= ${end} ${subjectClause}
    GROUP BY "planId", "audienceName", "subjectId"
  `);
}

/** 人群主数据源在窗口内实际覆盖的自然日数。 */
export async function countAudienceWindowDays(
  tenantId: string,
  shopId: string,
  subjectIds: string[] | null,
  start: string,
  end: string
): Promise<number> {
  const subjectClause =
    subjectIds && subjectIds.length > 0
      ? Prisma.sql`AND "subjectId" IN (${Prisma.join(subjectIds)})`
      : Prisma.empty;
  const rows = await prisma.$queryRaw<{ days: bigint }[]>(Prisma.sql`
    SELECT COUNT(DISTINCT "date") AS "days"
    FROM "DailyAudienceMetric"
    WHERE "tenantId" = ${tenantId} AND "shopId" = ${shopId} AND "date" >= ${start} AND "date" <= ${end} ${subjectClause}
  `);
  return Number(rows[0]?.days ?? 0);
}

// ——————————————————————————————————————————————————————————————
// 全部分日表统一的清理/保留
// ——————————————————————————————————————————————————————————————

/** 主动「清空源数据」：清掉该租户三张分日表。 */
export async function clearAllDailyMetrics(tenantId: string, shopId: string): Promise<void> {
  await prisma.$transaction([
    prisma.dailyProductMetric.deleteMany({ where: { tenantId, shopId } }),
    prisma.dailyPromotionMetric.deleteMany({ where: { tenantId, shopId } }),
    prisma.dailyAudienceMetric.deleteMany({ where: { tenantId, shopId } })
  ]);
}

/** 按保留天数清理三张分日表（各自相对自己的最新日期）。 */
export async function pruneAllDailyMetrics(tenantId: string, shopId: string, keepDays: number): Promise<void> {
  if (!keepDays || keepDays <= 0) {
    return;
  }
  await pruneDailyProductMetrics(tenantId, shopId, keepDays);
  await prunePromotion(tenantId, shopId, keepDays);
  await pruneAudience(tenantId, shopId, keepDays);
}

/** reportType → 对应分日表名（达摩盘走 blob 快照，无分日表）。 */
const DAILY_TABLE_BY_REPORT: Partial<Record<ReportType, string>> = {
  product_source: "DailyProductMetric",
  promotion_product_source: "DailyPromotionMetric",
  audience_source: "DailyAudienceMetric"
};

/**
 * 大批量 upsert/prune 后刷新该分日表统计信息：避免 planner 用过期统计选灾难性计划
 * （导入 12 万行后管理看板渲染从 22s 退化即此问题，手动 VACUUM ANALYZE 后恢复 1.5s）。
 * best-effort：失败只告警、绝不阻断导入。表名取自内部常量映射（非用户输入），故 $executeRawUnsafe 安全。
 */
export async function analyzeDailyTable(reportType: ReportType): Promise<void> {
  const table = DAILY_TABLE_BY_REPORT[reportType];
  if (!table) {
    return;
  }
  try {
    await prisma.$executeRawUnsafe(`ANALYZE "${table}"`);
  } catch (error) {
    console.warn(`[import] ANALYZE "${table}" 失败（不影响导入，仅本次统计信息未刷新）：`, error);
  }
}

async function prunePromotion(tenantId: string, shopId: string, keepDays: number): Promise<void> {
  const bounds = await prisma.dailyPromotionMetric.aggregate({
    where: { tenantId, shopId },
    _min: { date: true },
    _max: { date: true }
  });
  if (!bounds._max.date || !bounds._min.date) return;
  const cutoff = addDays(bounds._max.date, -(keepDays - 1));
  if (cutoff <= bounds._min.date) return; // 保留期≥数据跨度，跳过空删
  await prisma.dailyPromotionMetric.deleteMany({ where: { tenantId, shopId, date: { lt: cutoff } } });
}

async function pruneAudience(tenantId: string, shopId: string, keepDays: number): Promise<void> {
  const bounds = await prisma.dailyAudienceMetric.aggregate({
    where: { tenantId, shopId },
    _min: { date: true },
    _max: { date: true }
  });
  if (!bounds._max.date || !bounds._min.date) return;
  const cutoff = addDays(bounds._max.date, -(keepDays - 1));
  if (cutoff <= bounds._min.date) return; // 保留期≥数据跨度，跳过空删
  await prisma.dailyAudienceMetric.deleteMany({ where: { tenantId, shopId, date: { lt: cutoff } } });
}
