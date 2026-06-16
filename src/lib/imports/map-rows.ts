import { normalizeHeader, stringifyCell } from "@/lib/imports/contracts";
import type {
  AudienceSourceRow,
  DamoProductRow,
  Lifecycle,
  ProductSourceRow,
  PromotionProductRow,
  ReportType
} from "@/lib/types/domain";

export interface MappedSourceRows {
  product_source?: ProductSourceRow[];
  damo_product_source?: DamoProductRow[];
  promotion_product_source?: PromotionProductRow[];
  audience_source?: AudienceSourceRow[];
}

const LIFECYCLES: Lifecycle[] = [
  "冷启期",
  "新品成长期",
  "成长期",
  "新品打爆期",
  "爆品期",
  "平销期"
];

/** 分日商品指标（落 DailyProductMetric 表的输入）。 */
export interface DailyProductMetricInput {
  productId: string;
  date: string; // 归一化 ISO YYYY-MM-DD
  productName: string;
  visitors: number;
  views: number;
  averageStaySeconds: number;
  bounceRate: number;
  paymentBuyers: number;
  paymentAmount: number;
  productPaymentConversionRate: number;
  refundAmount: number;
  searchGuidedPaymentConversionRate: number;
  searchGuidedVisitors: number;
}

/** 把各种日期写法（2026-05-01 / 2026/5/1 / 2026.05.01 / 20260501 / 带时分秒）归一化为 ISO。无法识别返回 ""。 */
export function normalizeDate(value: unknown): string {
  const text = stringifyCell(value).trim();
  if (!text) {
    return "";
  }
  const datePart = text.split(/[\sT]/)[0];
  const sep = datePart.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (sep) {
    return `${sep[1]}-${sep[2].padStart(2, "0")}-${sep[3].padStart(2, "0")}`;
  }
  const compact = datePart.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    return `${compact[1]}-${compact[2]}-${compact[3]}`;
  }
  return "";
}

export function parseNumericCell(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  const text = stringifyCell(value).replace(/[,¥$\s]/g, "");
  if (text === "") {
    return 0;
  }
  if (text.endsWith("%")) {
    const numeric = Number(text.slice(0, -1));
    return Number.isFinite(numeric) ? numeric / 100 : 0;
  }
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : 0;
}

function asLifecycle(value: string): Lifecycle {
  return (LIFECYCLES as string[]).includes(value) ? (value as Lifecycle) : "冷启期";
}

function columnReaders(headers: string[]) {
  const index = new Map<string, number>();
  headers.forEach((header, position) => {
    const key = normalizeHeader(header);
    if (key && !index.has(key)) {
      index.set(key, position);
    }
  });
  const text = (row: unknown[], header: string) => {
    const position = index.get(normalizeHeader(header));
    return position === undefined ? "" : stringifyCell(row[position]);
  };
  const num = (row: unknown[], header: string) => {
    const position = index.get(normalizeHeader(header));
    return position === undefined ? 0 : parseNumericCell(row[position]);
  };
  return { text, num };
}

function isDataRow(idValue: string) {
  return idValue !== "" && idValue !== "总计" && idValue !== "合计";
}

/** 按主键去重,自上而下保留首次出现的一行(重复行丢弃)。 */
function dedupeByFirst<T>(rows: T[], keyOf: (row: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(row);
  }
  return result;
}

function lifecycleRank(stage: Lifecycle): number {
  const index = LIFECYCLES.indexOf(stage);
  return index < 0 ? 0 : index;
}

/**
 * 合并同一宝贝ID的多行（货品成长阶段跨越会被拆成多行，如成长期→爆品期各一行）：
 * 数量/金额类累加求和；ROI、各种率、笔单价、类目宽度等不可累加项取最高值；
 * 成长阶段取生命周期最靠后（最成熟）的那个。
 */
function mergeDamoRows(rows: DamoProductRow[]): DamoProductRow[] {
  const byId = new Map<string, DamoProductRow>();
  const order: string[] = [];
  for (const row of rows) {
    const existing = byId.get(row.productId);
    if (!existing) {
      byId.set(row.productId, { ...row });
      order.push(row.productId);
      continue;
    }
    // 可累加：金额、流量、消耗、连带量
    existing.paymentAmount += row.paymentAmount;
    existing.ipv += row.ipv;
    existing.marketingIpv += row.marketingIpv;
    existing.marketingSpend += row.marketingSpend;
    existing.attachPurchaseCount += row.attachPurchaseCount;
    // 不可累加：取最高值
    existing.marketingRoi = Math.max(existing.marketingRoi, row.marketingRoi);
    existing.paymentConversionRate = Math.max(existing.paymentConversionRate, row.paymentConversionRate);
    existing.repurchaseRate = Math.max(existing.repurchaseRate, row.repurchaseRate);
    existing.freeSearchClickRate = Math.max(existing.freeSearchClickRate, row.freeSearchClickRate);
    existing.unitPrice = Math.max(existing.unitPrice, row.unitPrice);
    existing.attachPurchaseRate = Math.max(existing.attachPurchaseRate, row.attachPurchaseRate);
    existing.attachCategoryWidth = Math.max(existing.attachCategoryWidth, row.attachCategoryWidth);
    // 成长阶段取最靠后（最成熟）
    if (lifecycleRank(row.growthStage) > lifecycleRank(existing.growthStage)) {
      existing.growthStage = row.growthStage;
    }
  }
  return order.map((id) => byId.get(id)!);
}

/**
 * 合并同一主体ID(商品)的多个推广计划行：
 * 展现量/点击量/花费累加求和；点击率=Σ点击÷Σ展现、平均点击花费=Σ花费÷Σ点击、
 * ROI=Σ(各计划ROI×各计划花费)÷Σ花费（花费加权，等价于总成交额÷总花费）。
 */
function mergePromotionRows(rows: PromotionProductRow[]): PromotionProductRow[] {
  const byId = new Map<string, { row: PromotionProductRow; roiCostSum: number }>();
  const order: string[] = [];
  for (const row of rows) {
    const existing = byId.get(row.subjectId);
    if (!existing) {
      byId.set(row.subjectId, { row: { ...row }, roiCostSum: row.roi * row.cost });
      order.push(row.subjectId);
      continue;
    }
    existing.row.impressions += row.impressions;
    existing.row.clicks += row.clicks;
    existing.row.cost += row.cost;
    existing.roiCostSum += row.roi * row.cost;
  }
  return order.map((id) => {
    const { row, roiCostSum } = byId.get(id)!;
    return {
      ...row,
      ctr: row.impressions > 0 ? row.clicks / row.impressions : 0,
      averageClickCost: row.clicks > 0 ? row.cost / row.clicks : 0,
      roi: row.cost > 0 ? roiCostSum / row.cost : 0
    };
  });
}

export function mapProductSourceRows(headers: string[], rows: unknown[][]): ProductSourceRow[] {
  const { text, num } = columnReaders(headers);
  const mapped = rows
    .filter((row) => isDataRow(text(row, "商品ID")))
    .map((row) => ({
      date: text(row, "统计日期"),
      productId: text(row, "商品ID"),
      productName: text(row, "商品名称"),
      visitors: num(row, "商品访客数"),
      views: num(row, "商品浏览量"),
      averageStaySeconds: num(row, "平均停留时长"),
      bounceRate: num(row, "商品详情页跳出率"),
      orderBuyers: 0,
      paymentBuyers: num(row, "支付买家数"),
      paymentAmount: num(row, "支付金额"),
      productPaymentConversionRate: num(row, "商品支付转化率"),
      refundAmount: num(row, "成功退款金额"),
      visitorValue: 0,
      searchGuidedPaymentConversionRate: num(row, "搜索引导支付转化率"),
      searchGuidedVisitors: 0
    }));
  return dedupeByFirst(mapped, (item) => item.productId);
}

/**
 * 分日商品源映射：保留每商品每日一行（按 productId+date 去重保首行），不再压成每商品一行。
 * 无法识别统计日期的行丢弃（分日表必须有日期）。
 */
export function mapProductDailyRows(headers: string[], rows: unknown[][]): DailyProductMetricInput[] {
  const { text, num } = columnReaders(headers);
  const mapped = rows
    .filter((row) => isDataRow(text(row, "商品ID")))
    .map((row) => ({
      productId: text(row, "商品ID"),
      date: normalizeDate(text(row, "统计日期")),
      productName: text(row, "商品名称"),
      visitors: num(row, "商品访客数"),
      views: num(row, "商品浏览量"),
      averageStaySeconds: num(row, "平均停留时长"),
      bounceRate: num(row, "商品详情页跳出率"),
      paymentBuyers: num(row, "支付买家数"),
      paymentAmount: num(row, "支付金额"),
      productPaymentConversionRate: num(row, "商品支付转化率"),
      refundAmount: num(row, "成功退款金额"),
      searchGuidedPaymentConversionRate: num(row, "搜索引导支付转化率"),
      searchGuidedVisitors: num(row, "搜索引导访客数")
    }))
    .filter((item) => item.date !== "");
  return dedupeByFirst(mapped, (item) => `${item.productId} ${item.date}`);
}

export function mapDamoProductRows(headers: string[], rows: unknown[][]): DamoProductRow[] {
  const { text, num } = columnReaders(headers);
  const mapped = rows
    .filter((row) => isDataRow(text(row, "宝贝ID")))
    .map((row) => ({
      productId: text(row, "宝贝ID"),
      productName: text(row, "宝贝名称"),
      growthStage: asLifecycle(text(row, "货品成长阶段")),
      paymentAmount: num(row, "支付金额"),
      ipv: num(row, "IPV"),
      marketingIpv: 0,
      marketingSpend: num(row, "营销推广消耗"),
      marketingRoi: num(row, "营销推广ROI"),
      paymentConversionRate: num(row, "支付转化率"),
      repurchaseRate: num(row, "复购率"),
      freeSearchClickRate: num(row, "免费搜索点击率"),
      unitPrice: 0,
      attachPurchaseCount: 0,
      attachPurchaseRate: num(row, "连带购买率"),
      attachCategoryWidth: num(row, "连带购买叶子类目宽度")
    }));
  return mergeDamoRows(mapped);
}

export function mapPromotionRows(headers: string[], rows: unknown[][]): PromotionProductRow[] {
  const { text, num } = columnReaders(headers);
  const mapped = rows
    .filter((row) => isDataRow(text(row, "主体ID")))
    .map((row) => {
      const impressions = num(row, "展现量");
      const clicks = num(row, "点击量");
      return {
        date: text(row, "日期"),
        subjectId: text(row, "主体ID"),
        subjectName: text(row, "主体名称"),
        impressions,
        clicks,
        cost: num(row, "花费"),
        ctr: impressions > 0 ? clicks / impressions : 0,
        averageClickCost: num(row, "平均点击花费"),
        roi: num(row, "投入产出比")
      };
    });
  return mergePromotionRows(mapped);
}

export function mapAudienceRows(headers: string[], rows: unknown[][]): AudienceSourceRow[] {
  const { text, num } = columnReaders(headers);
  return rows
    .filter((row) => isDataRow(text(row, "计划ID")))
    .map((row) => ({
      dateRange: text(row, "日期"),
      sceneId: text(row, "场景ID"),
      sceneName: text(row, "场景名字"),
      planId: text(row, "计划ID"),
      planName: text(row, "计划名字"),
      audienceName: text(row, "人群名字"),
      subjectId: text(row, "主体ID"),
      subjectName: text(row, "主体名称"),
      clicks: num(row, "点击量"),
      roi: num(row, "投入产出比"),
      guidedVisitorCount: 0,
      guidedPotentialCustomerRatio: num(row, "引导访问潜客占比"),
      newCustomerCount: 0,
      newCustomerRatio: num(row, "成交新客占比")
    }));
}

export function mapImportedRows(
  reportType: ReportType,
  headers: string[],
  rows: unknown[][]
): MappedSourceRows {
  switch (reportType) {
    case "product_source":
      return { product_source: mapProductSourceRows(headers, rows) };
    case "damo_product_source":
      return { damo_product_source: mapDamoProductRows(headers, rows) };
    case "promotion_product_source":
      return { promotion_product_source: mapPromotionRows(headers, rows) };
    case "audience_source":
      return { audience_source: mapAudienceRows(headers, rows) };
    default:
      return {};
  }
}
