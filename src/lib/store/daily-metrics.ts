import "server-only";
import { prisma } from "@/lib/db";
import type { DailyProductMetricInput } from "@/lib/imports/map-rows";
import type { ProductSourceRow } from "@/lib/types/domain";

/**
 * 分日商品指标的写入与聚合（v2 时序底座）。
 * - 写：按 (tenantId, productId, date) upsert，重传同日覆盖、新日追加（累积留存）。
 * - 读：把窗口内分日数据聚合成"每商品一行"的 ProductSourceRow，喂给现有三阶算法。
 */

/** upsert 一批分日商品指标。同一批内按 (productId,date) 已去重。 */
export async function upsertDailyProductMetrics(
  tenantId: string,
  rows: DailyProductMetricInput[]
): Promise<number> {
  for (const row of rows) {
    const data = {
      productName: row.productName,
      visitors: Math.round(row.visitors),
      views: Math.round(row.views),
      averageStaySeconds: row.averageStaySeconds,
      bounceRate: row.bounceRate,
      paymentBuyers: Math.round(row.paymentBuyers),
      paymentAmount: row.paymentAmount,
      productPaymentConversionRate: row.productPaymentConversionRate,
      refundAmount: row.refundAmount,
      searchGuidedPaymentConversionRate: row.searchGuidedPaymentConversionRate,
      searchGuidedVisitors: Math.round(row.searchGuidedVisitors)
    };
    await prisma.dailyProductMetric.upsert({
      where: { tenantId_productId_date: { tenantId, productId: row.productId, date: row.date } },
      create: { tenantId, productId: row.productId, date: row.date, ...data },
      update: data
    });
  }
  return rows.length;
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
