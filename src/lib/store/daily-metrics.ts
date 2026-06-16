import "server-only";
import { prisma } from "@/lib/db";
import type { DailyProductMetricInput } from "@/lib/imports/map-rows";
import type { ProductSourceRow } from "@/lib/types/domain";

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

/** 某租户分日数据的日期范围与天数（用于展示"数据区间"）。 */
export async function getProductDailyDateRange(
  tenantId: string
): Promise<{ start: string; end: string; days: number } | null> {
  const dates = await prisma.dailyProductMetric.findMany({
    where: { tenantId },
    distinct: ["date"],
    select: { date: true },
    orderBy: { date: "asc" }
  });
  if (dates.length === 0) {
    return null;
  }
  return { start: dates[0].date, end: dates[dates.length - 1].date, days: dates.length };
}

/**
 * 把窗口内分日数据聚合成每商品一行 ProductSourceRow。
 * 可加和项（访客/浏览/买家/金额/退款）求和；费率项按访客加权平均（保留报表口径）。
 * range 省略则聚合该租户全部已有分日数据（= 当前周期）。
 */
export async function aggregateProductForCycle(
  tenantId: string,
  range?: { start: string; end: string }
): Promise<ProductSourceRow[]> {
  const rows = await prisma.dailyProductMetric.findMany({
    where: {
      tenantId,
      ...(range ? { date: { gte: range.start, lte: range.end } } : {})
    },
    orderBy: { date: "asc" }
  });

  interface Acc {
    productId: string;
    productName: string;
    lastDate: string;
    visitors: number;
    views: number;
    paymentBuyers: number;
    paymentAmount: number;
    refundAmount: number;
    searchGuidedVisitors: number;
    stayWeighted: number; // Σ(停留×访客)
    bounceWeighted: number; // Σ(跳出率×访客)
    convWeighted: number; // Σ(支付转化率×访客)
    searchConvWeighted: number; // Σ(搜索引导转化率×访客)
  }

  const byProduct = new Map<string, Acc>();
  for (const r of rows) {
    let acc = byProduct.get(r.productId);
    if (!acc) {
      acc = {
        productId: r.productId,
        productName: r.productName,
        lastDate: r.date,
        visitors: 0,
        views: 0,
        paymentBuyers: 0,
        paymentAmount: 0,
        refundAmount: 0,
        searchGuidedVisitors: 0,
        stayWeighted: 0,
        bounceWeighted: 0,
        convWeighted: 0,
        searchConvWeighted: 0
      };
      byProduct.set(r.productId, acc);
    }
    // 行按日期升序遍历：商品名取最新一天
    acc.productName = r.productName || acc.productName;
    acc.lastDate = r.date;
    acc.visitors += r.visitors;
    acc.views += r.views;
    acc.paymentBuyers += r.paymentBuyers;
    acc.paymentAmount += r.paymentAmount;
    acc.refundAmount += r.refundAmount;
    acc.searchGuidedVisitors += r.searchGuidedVisitors;
    acc.stayWeighted += r.averageStaySeconds * r.visitors;
    acc.bounceWeighted += r.bounceRate * r.visitors;
    acc.convWeighted += r.productPaymentConversionRate * r.visitors;
    acc.searchConvWeighted += r.searchGuidedPaymentConversionRate * r.visitors;
  }

  return [...byProduct.values()].map((a) => {
    const w = a.visitors > 0 ? a.visitors : 1;
    return {
      date: a.lastDate,
      productId: a.productId,
      productName: a.productName,
      visitors: a.visitors,
      views: a.views,
      averageStaySeconds: a.stayWeighted / w,
      bounceRate: a.bounceWeighted / w,
      orderBuyers: 0,
      paymentBuyers: a.paymentBuyers,
      paymentAmount: a.paymentAmount,
      productPaymentConversionRate: a.convWeighted / w,
      refundAmount: a.refundAmount,
      visitorValue: 0,
      searchGuidedPaymentConversionRate: a.searchConvWeighted / w,
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

const EMPTY_SUM: WindowSum = { paymentAmount: 0, refundAmount: 0, visitors: 0, paymentBuyers: 0 };

function accumulate(target: WindowSum, r: { paymentAmount: number; refundAmount: number; visitors: number; paymentBuyers: number }) {
  target.paymentAmount += r.paymentAmount;
  target.refundAmount += r.refundAmount;
  target.visitors += r.visitors;
  target.paymentBuyers += r.paymentBuyers;
}

/** 窗口内（商品集为空=整店）求和。 */
export async function sumProductWindow(
  tenantId: string,
  productIds: string[] | null,
  start: string,
  end: string
): Promise<WindowSum> {
  const rows = await prisma.dailyProductMetric.findMany({
    where: {
      tenantId,
      date: { gte: start, lte: end },
      ...(productIds && productIds.length > 0 ? { productId: { in: productIds } } : {})
    },
    select: { paymentAmount: true, refundAmount: true, visitors: true, paymentBuyers: true }
  });
  const sum = { ...EMPTY_SUM };
  for (const r of rows) accumulate(sum, r);
  return sum;
}

/** 窗口内按商品分组求和（lens B 用）。 */
export async function sumProductWindowByProduct(
  tenantId: string,
  productIds: string[] | null,
  start: string,
  end: string
): Promise<Map<string, WindowSum>> {
  const rows = await prisma.dailyProductMetric.findMany({
    where: {
      tenantId,
      date: { gte: start, lte: end },
      ...(productIds && productIds.length > 0 ? { productId: { in: productIds } } : {})
    },
    select: { productId: true, paymentAmount: true, refundAmount: true, visitors: true, paymentBuyers: true }
  });
  const byId = new Map<string, WindowSum>();
  for (const r of rows) {
    let acc = byId.get(r.productId);
    if (!acc) {
      acc = { ...EMPTY_SUM };
      byId.set(r.productId, acc);
    }
    accumulate(acc, r);
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

/** 整店按天趋势（商品集为空=整店；否则限定商品集），日期升序。 */
export async function storeDailyTrend(
  tenantId: string,
  start: string,
  end: string,
  productIds?: string[] | null
): Promise<StoreTrendPoint[]> {
  const rows = await prisma.dailyProductMetric.findMany({
    where: {
      tenantId,
      date: { gte: start, lte: end },
      ...(productIds && productIds.length > 0 ? { productId: { in: productIds } } : {})
    },
    select: { date: true, paymentAmount: true, refundAmount: true, visitors: true, paymentBuyers: true },
    orderBy: { date: "asc" }
  });
  const byDate = new Map<string, StoreTrendPoint>();
  for (const r of rows) {
    let p = byDate.get(r.date);
    if (!p) {
      p = { date: r.date, netSales: 0, paymentAmount: 0, refundAmount: 0, visitors: 0, paymentBuyers: 0 };
      byDate.set(r.date, p);
    }
    p.paymentAmount += r.paymentAmount;
    p.refundAmount += r.refundAmount;
    p.visitors += r.visitors;
    p.paymentBuyers += r.paymentBuyers;
    p.netSales = p.paymentAmount - p.refundAmount;
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
