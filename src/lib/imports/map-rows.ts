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
  visitors: number | null;
  views: number | null;
  averageStaySeconds: number | null;
  bounceRate: number | null;
  paymentBuyers: number | null;
  paymentAmount: number | null;
  productPaymentConversionRate: number | null;
  refundAmount: number | null;
  searchGuidedPaymentConversionRate: number | null;
  searchGuidedVisitors: number | null;
}

/** 分日推广宝贝指标（落 DailyPromotionMetric 表的输入）。 */
export interface DailyPromotionMetricInput {
  subjectId: string;
  date: string;
  subjectName: string;
  impressions: number | null;
  clicks: number | null;
  cost: number | null;
  roi: number | null;
}

/** 分日人群指标（落 DailyAudienceMetric 表的输入）。 */
export interface DailyAudienceMetricInput {
  date: string;
  sceneId: string;
  sceneName: string;
  planId: string;
  planName: string;
  audienceName: string;
  subjectId: string;
  subjectName: string;
  clicks: number | null;
  roi: number | null;
  guidedPotentialCustomerRatio: number | null;
  newCustomerRatio: number | null;
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
    return validIso(Number(sep[1]), Number(sep[2]), Number(sep[3]));
  }
  const compact = datePart.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    return validIso(Number(compact[1]), Number(compact[2]), Number(compact[3]));
  }
  return "";
}

/** 校验真实存在的日期（拒绝 13 月、2 月 30 日等），返回 ISO 或 ""。 */
function validIso(y: number, m: number, d: number): string {
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    return "";
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== m || dt.getUTCDate() !== d) {
    return "";
  }
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 空白、占位符和非法数字都表示“未知”，不得在导入层伪造成真实的 0。 */
export function parseNumericCellOrNull(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const text = stringifyCell(value).replace(/[,¥$\s]/g, "");
  if (text === "" || isMissingNumericToken(text)) {
    return null;
  }
  if (text.endsWith("%")) {
    const numeric = Number(text.slice(0, -1));
    return Number.isFinite(numeric) ? numeric / 100 : null;
  }
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

function isMissingNumericToken(text: string) {
  return ["-", "--", "—", "–", "－", "N/A", "NA", "NULL", "UNDEFINED", "无数据", "未投放"]
    .includes(text.toUpperCase());
}

function asLifecycle(value: string): Lifecycle {
  return (LIFECYCLES as string[]).includes(value) ? (value as Lifecycle) : "冷启期";
}

function columnReaders(headers: string[], expectedHeaders: string[] = []) {
  const index = new Map<string, number>();
  headers.forEach((header, position) => {
    const key = normalizeHeader(header);
    if (key && !index.has(key)) {
      index.set(key, position);
    }
  });
  expectedHeaders.forEach((header, position) => {
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
    return position === undefined ? null : parseNumericCellOrNull(row[position]);
  };
  return { text, num };
}

function resolvedDate(value: unknown, fallbackDate?: string) {
  return normalizeDate(value) || normalizeDate(fallbackDate);
}

export function inferImportDate(fileName: string) {
  const match = fileName.match(/(20\d{2})[-_.年]?(\d{2})[-_.月]?(\d{2})/);
  return match ? normalizeDate(`${match[1]}-${match[2]}-${match[3]}`) : "";
}

const PRODUCT_COLUMN_ORDER = [
  "统计日期", "商品ID", "商品名称", "商品访客数", "商品浏览量", "平均停留时长",
  "商品详情页跳出率", "支付买家数", "支付金额", "商品支付转化率", "成功退款金额",
  "搜索引导支付转化率", "搜索引导访客数"
];
const DAMO_COLUMN_ORDER = [
  "宝贝ID", "宝贝名称", "货品成长阶段", "日期", "支付金额", "IPV", "营销推广消耗",
  "营销推广ROI", "支付转化率", "复购率", "免费搜索点击率", "笔单价", "连带购买率",
  "连带购买叶子类目宽度"
];
const PROMOTION_COLUMN_ORDER = [
  "日期", "主体ID", "主体类型", "主体名称", "展现量", "点击量", "花费", "平均点击花费", "投入产出比"
];
const AUDIENCE_COLUMN_ORDER = [
  "日期", "场景ID", "场景名字", "计划ID", "计划名字", "人群名字", "主体ID", "主体名称",
  "点击量", "投入产出比", "引导访问潜客占比", "成交新客占比"
];

function isDataRow(idValue: string) {
  return idValue !== "" && idValue !== "总计" && idValue !== "合计";
}

function addNullable(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

function firstKnown(...values: Array<number | null>): number | null {
  return values.find((value): value is number => value !== null && Number.isFinite(value)) ?? null;
}

function divideKnown(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  const value = numerator / denominator;
  return Number.isFinite(value) ? value : null;
}

function validRatioCell(value: number | null): number | null {
  return value !== null && value >= 0 && value <= 1 ? value : null;
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

/**
 * 合并同一宝贝ID的多日行（达摩盘「同货品不同时段拆行」）：遵循数据逻辑做汇总——
 * - 量级求和：支付金额、IPV、营销推广消耗。
 * - 营销推广ROI：按消耗加权 Σ(ROI×消耗)/Σ消耗（ROI 的分母就是消耗）。
 * - 其余率（支付转化率/复购率/免费搜索点击率/连带购买率/连带类目宽度）：按订单数加权
 *   Σ(率×订单数)/Σ订单数，订单数=支付金额/笔单价（≈买家数，避开用 IPV 作分母）；Σ订单数=0 回落取最新一期值。
 * - 货品成长阶段 / 宝贝名称：取最大日期那行（最新一期）。笔单价重算为 Σ金额/Σ订单数。
 */
interface DamoAcc {
  paymentAmount: number | null;
  ipv: number | null;
  marketingSpend: number | null;
  roiSpendW: number; // Σ(ROI×消耗)
  roiSpendWeight: number;
  orders: number; // Σ订单数
  convW: number;
  convWeight: number;
  repurchaseW: number;
  repurchaseWeight: number;
  clickW: number;
  clickWeight: number;
  attachW: number;
  attachWeight: number;
  widthW: number; // Σ(率×订单数)
  widthWeight: number;
  latestDate: string;
  latest: DamoProductRow;
}

function mergeDamoRows(entries: Array<{ date: string; row: DamoProductRow }>): DamoProductRow[] {
  const byId = new Map<string, DamoAcc>();
  const order: string[] = [];
  for (const { date, row } of entries) {
    const orders = (row.unitPrice ?? 0) > 0 && row.paymentAmount !== null
      ? row.paymentAmount / (row.unitPrice as number)
      : 0;
    let acc = byId.get(row.productId);
    if (!acc) {
      acc = {
        paymentAmount: null,
        ipv: null,
        marketingSpend: null,
        roiSpendW: 0,
        roiSpendWeight: 0,
        orders: 0,
        convW: 0,
        convWeight: 0,
        repurchaseW: 0,
        repurchaseWeight: 0,
        clickW: 0,
        clickWeight: 0,
        attachW: 0,
        attachWeight: 0,
        widthW: 0,
        widthWeight: 0,
        latestDate: "",
        latest: row
      };
      byId.set(row.productId, acc);
      order.push(row.productId);
    }
    acc.paymentAmount = addNullable(acc.paymentAmount, row.paymentAmount);
    acc.ipv = addNullable(acc.ipv, row.ipv);
    acc.marketingSpend = addNullable(acc.marketingSpend, row.marketingSpend);
    if (row.marketingRoi !== null && row.marketingSpend !== null && row.marketingSpend > 0) {
      acc.roiSpendW += row.marketingRoi * row.marketingSpend;
      acc.roiSpendWeight += row.marketingSpend;
    }
    acc.orders += orders;
    if (row.paymentConversionRate !== null) {
      acc.convW += row.paymentConversionRate * orders;
      acc.convWeight += orders;
    }
    if (row.repurchaseRate !== null) {
      acc.repurchaseW += row.repurchaseRate * orders;
      acc.repurchaseWeight += orders;
    }
    if (row.freeSearchClickRate !== null) {
      acc.clickW += row.freeSearchClickRate * orders;
      acc.clickWeight += orders;
    }
    if (row.attachPurchaseRate !== null) {
      acc.attachW += row.attachPurchaseRate * orders;
      acc.attachWeight += orders;
    }
    if (row.attachCategoryWidth !== null) {
      acc.widthW += row.attachCategoryWidth * orders;
      acc.widthWeight += orders;
    }
    if (acc.latestDate === "" || date > acc.latestDate) {
      acc.latestDate = date;
      acc.latest = row;
    }
  }
  return order.map((id) => {
    const a = byId.get(id)!;
    const w = a.orders > 0 ? a.orders : 0;
    const wavg = (sumW: number, weight: number, fallback: number | null) =>
      weight > 0 ? sumW / weight : fallback;
    return {
      productId: id,
      productName: a.latest.productName,
      growthStage: a.latest.growthStage,
      paymentAmount: a.paymentAmount,
      ipv: a.ipv,
      marketingIpv: null,
      marketingSpend: a.marketingSpend,
      marketingRoi: a.roiSpendWeight > 0 ? a.roiSpendW / a.roiSpendWeight : null,
      paymentConversionRate: wavg(a.convW, a.convWeight, a.latest.paymentConversionRate),
      repurchaseRate: wavg(a.repurchaseW, a.repurchaseWeight, a.latest.repurchaseRate),
      freeSearchClickRate: wavg(a.clickW, a.clickWeight, a.latest.freeSearchClickRate),
      unitPrice: w > 0 && a.paymentAmount !== null ? a.paymentAmount / w : a.latest.unitPrice,
      attachPurchaseCount: null,
      attachPurchaseRate: wavg(a.attachW, a.attachWeight, a.latest.attachPurchaseRate),
      attachCategoryWidth: wavg(a.widthW, a.widthWeight, a.latest.attachCategoryWidth)
    };
  });
}

/**
 * 合并同一主体ID(商品)的多个推广计划行：
 * 展现量/点击量/花费累加求和；点击率=Σ点击÷Σ展现、平均点击花费=Σ花费÷Σ点击、
 * ROI=Σ(各计划ROI×各计划花费)÷Σ花费（花费加权，等价于总成交额÷总花费）。
 */
function mergePromotionRows(rows: PromotionProductRow[]): PromotionProductRow[] {
  const byId = new Map<string, { row: PromotionProductRow; roiCostSum: number; roiCostWeight: number }>();
  const order: string[] = [];
  for (const row of rows) {
    const existing = byId.get(row.subjectId);
    if (!existing) {
      const weight = row.roi !== null && row.cost !== null && row.cost > 0 ? row.cost : 0;
      byId.set(row.subjectId, {
        row: { ...row },
        roiCostSum: weight > 0 ? (row.roi as number) * weight : 0,
        roiCostWeight: weight
      });
      order.push(row.subjectId);
      continue;
    }
    existing.row.impressions = addNullable(existing.row.impressions, row.impressions);
    existing.row.clicks = addNullable(existing.row.clicks, row.clicks);
    existing.row.cost = addNullable(existing.row.cost, row.cost);
    if (row.roi !== null && row.cost !== null && row.cost > 0) {
      existing.roiCostSum += row.roi * row.cost;
      existing.roiCostWeight += row.cost;
    }
  }
  return order.map((id) => {
    const { row, roiCostSum, roiCostWeight } = byId.get(id)!;
    return {
      ...row,
      ctr: divideKnown(row.clicks, row.impressions),
      averageClickCost: divideKnown(row.cost, row.clicks),
      roi: roiCostWeight > 0 ? roiCostSum / roiCostWeight : null
    };
  });
}

export function mapProductSourceRows(headers: string[], rows: unknown[][]): ProductSourceRow[] {
  const { text, num } = columnReaders(headers, PRODUCT_COLUMN_ORDER);
  const mapped = rows
    .filter((row) => isDataRow(text(row, "商品ID")))
    .map((row) => ({
      date: text(row, "统计日期"),
      productId: text(row, "商品ID"),
      productName: text(row, "商品名称"),
      visitors: num(row, "商品访客数"),
      views: num(row, "商品浏览量"),
      averageStaySeconds: num(row, "平均停留时长"),
      bounceRate: validRatioCell(num(row, "商品详情页跳出率")),
      orderBuyers: null,
      paymentBuyers: num(row, "支付买家数"),
      paymentAmount: num(row, "支付金额"),
      productPaymentConversionRate: validRatioCell(num(row, "商品支付转化率")),
      refundAmount: num(row, "成功退款金额"),
      visitorValue: null,
      searchGuidedPaymentConversionRate: validRatioCell(num(row, "搜索引导支付转化率")),
      searchGuidedVisitors: num(row, "搜索引导访客数")
    }));
  return dedupeByFirst(mapped, (item) => item.productId);
}

/**
 * 分日商品源映射：保留每商品每日一行（按 productId+date 去重保首行），不再压成每商品一行。
 * 无法识别统计日期的行丢弃（分日表必须有日期）。
 */
export function mapProductDailyRows(headers: string[], rows: unknown[][], fallbackDate?: string): DailyProductMetricInput[] {
  const { text, num } = columnReaders(headers, PRODUCT_COLUMN_ORDER);
  // 同 (商品ID, 统计日期) 多行 → 已知量级求和、率只按有真实权重的单元格加权。
  // 任一字段全部缺失时保持 null；缺主键或可靠日期的行隔离，不生成临时 ID/当天日期。
  type WeightedKey = "stay" | "bounce" | "conv" | "searchConv";
  type WeightedAccumulator = Record<WeightedKey, { sum: number; weight: number; fallback: number | null }>;
  const byKey = new Map<
    string,
    { row: DailyProductMetricInput; weighted: WeightedAccumulator }
  >();
  const order: string[] = [];
  for (const row of rows) {
    const rawProductId = text(row, "商品ID");
    const date = resolvedDate(text(row, "统计日期"), fallbackDate);
    if (!isDataRow(rawProductId) || !date) {
      continue;
    }
    const productId = rawProductId;
    const visitors = num(row, "商品访客数");
    const stay = num(row, "平均停留时长");
    const bounce = validRatioCell(num(row, "商品详情页跳出率"));
    const conv = validRatioCell(num(row, "商品支付转化率"));
    const searchConv = validRatioCell(num(row, "搜索引导支付转化率"));
    const searchVisitors = num(row, "搜索引导访客数");
    const weighted: WeightedAccumulator = {
      stay: weightedCell(stay, visitors),
      bounce: weightedCell(bounce, visitors),
      conv: weightedCell(conv, visitors),
      searchConv: weightedCell(searchConv, searchVisitors)
    };
    const key = `${productId} ${date}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        row: {
          productId,
          date,
          productName: text(row, "商品名称"),
          visitors,
          views: num(row, "商品浏览量"),
          averageStaySeconds: stay,
          bounceRate: bounce,
          paymentBuyers: num(row, "支付买家数"),
          paymentAmount: num(row, "支付金额"),
          productPaymentConversionRate: conv,
          refundAmount: num(row, "成功退款金额"),
          searchGuidedPaymentConversionRate: searchConv,
          searchGuidedVisitors: searchVisitors
        },
        weighted
      });
      order.push(key);
    } else {
      existing.row.visitors = addNullable(existing.row.visitors, visitors);
      existing.row.views = addNullable(existing.row.views, num(row, "商品浏览量"));
      existing.row.paymentBuyers = addNullable(existing.row.paymentBuyers, num(row, "支付买家数"));
      existing.row.paymentAmount = addNullable(existing.row.paymentAmount, num(row, "支付金额"));
      existing.row.refundAmount = addNullable(existing.row.refundAmount, num(row, "成功退款金额"));
      existing.row.searchGuidedVisitors = addNullable(existing.row.searchGuidedVisitors, searchVisitors);
      mergeWeighted(existing.weighted.stay, weighted.stay);
      mergeWeighted(existing.weighted.bounce, weighted.bounce);
      mergeWeighted(existing.weighted.conv, weighted.conv);
      mergeWeighted(existing.weighted.searchConv, weighted.searchConv);
      if (!existing.row.productName) {
        existing.row.productName = text(row, "商品名称");
      }
    }
  }
  return order.map((key) => {
    const e = byKey.get(key)!;
    return {
      ...e.row,
      averageStaySeconds: finishWeighted(e.weighted.stay),
      bounceRate: finishWeighted(e.weighted.bounce),
      productPaymentConversionRate: finishWeighted(e.weighted.conv),
      searchGuidedPaymentConversionRate: finishWeighted(e.weighted.searchConv)
    };
  });
}

function weightedCell(value: number | null, weight: number | null) {
  return {
    sum: value !== null && weight !== null && weight > 0 ? value * weight : 0,
    weight: value !== null && weight !== null && weight > 0 ? weight : 0,
    fallback: value
  };
}

function mergeWeighted(
  target: { sum: number; weight: number; fallback: number | null },
  source: { sum: number; weight: number; fallback: number | null }
) {
  target.sum += source.sum;
  target.weight += source.weight;
  target.fallback = firstKnown(target.fallback, source.fallback);
}

function finishWeighted(value: { sum: number; weight: number; fallback: number | null }) {
  return value.weight > 0 ? value.sum / value.weight : value.fallback;
}

export function mapDamoProductRows(headers: string[], rows: unknown[][]): DamoProductRow[] {
  const { text, num } = columnReaders(headers, DAMO_COLUMN_ORDER);
  // 达摩盘「同货品不同时段拆行」：带上日期（取最新阶段用）+ 笔单价（算订单数=买家代理用）。
  const entries = rows
    .filter((row) => isDataRow(text(row, "宝贝ID")))
    .map((row) => ({
      date: normalizeDate(text(row, "日期")),
      row: {
        productId: text(row, "宝贝ID"),
        productName: text(row, "宝贝名称"),
        growthStage: asLifecycle(text(row, "货品成长阶段")),
        paymentAmount: num(row, "支付金额"),
        ipv: num(row, "IPV"),
        marketingIpv: null,
        marketingSpend: num(row, "营销推广消耗"),
        marketingRoi: num(row, "营销推广ROI"),
        paymentConversionRate: validRatioCell(num(row, "支付转化率")),
        repurchaseRate: validRatioCell(num(row, "复购率")),
        freeSearchClickRate: validRatioCell(num(row, "免费搜索点击率")),
        unitPrice: num(row, "笔单价"),
        attachPurchaseCount: null,
        attachPurchaseRate: validRatioCell(num(row, "连带购买率")),
        attachCategoryWidth: num(row, "连带购买叶子类目宽度")
      } as DamoProductRow
    }));
  return mergeDamoRows(entries);
}

export function mapPromotionRows(headers: string[], rows: unknown[][]): PromotionProductRow[] {
  const { text, num } = columnReaders(headers, PROMOTION_COLUMN_ORDER);
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
        ctr: divideKnown(clicks, impressions),
        averageClickCost: num(row, "平均点击花费"),
        roi: num(row, "投入产出比")
      };
    });
  return mergePromotionRows(mapped);
}

/**
 * 分日推广映射：粒度 (subjectId, date)。真实万相台报表里同一(主体,日期)按场景/计划拆成多行，
 * 必须**累加**展现/点击/花费（保首行会严重少计），ROI 用花费加权 Σ(roi×cost)/Σcost。无日期行丢弃。
 */
export function mapPromotionDailyRows(headers: string[], rows: unknown[][], fallbackDate?: string): DailyPromotionMetricInput[] {
  const { text, num } = columnReaders(headers, PROMOTION_COLUMN_ORDER);
  const byKey = new Map<string, { row: DailyPromotionMetricInput; roiCostSum: number; roiCostWeight: number; roiFallback: number | null }>();
  const order: string[] = [];
  for (const row of rows) {
    const rawSubjectId = text(row, "主体ID");
    const date = resolvedDate(text(row, "日期"), fallbackDate);
    if (!isDataRow(rawSubjectId) || !date) {
      continue;
    }
    const subjectId = rawSubjectId;
    const key = `${subjectId} ${date}`;
    const impressions = num(row, "展现量");
    const clicks = num(row, "点击量");
    const cost = num(row, "花费");
    const roi = num(row, "投入产出比");
    const roiCostWeight = roi !== null && cost !== null && cost > 0 ? cost : 0;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        row: { subjectId, date, subjectName: text(row, "主体名称"), impressions, clicks, cost, roi },
        roiCostSum: roiCostWeight > 0 ? (roi as number) * roiCostWeight : 0,
        roiCostWeight,
        roiFallback: roi
      });
      order.push(key);
    } else {
      existing.row.impressions = addNullable(existing.row.impressions, impressions);
      existing.row.clicks = addNullable(existing.row.clicks, clicks);
      existing.row.cost = addNullable(existing.row.cost, cost);
      if (roiCostWeight > 0) {
        existing.roiCostSum += (roi as number) * roiCostWeight;
        existing.roiCostWeight += roiCostWeight;
      }
      existing.roiFallback = firstKnown(existing.roiFallback, roi);
      if (!existing.row.subjectName) {
        existing.row.subjectName = text(row, "主体名称");
      }
    }
  }
  return order.map((key) => {
    const { row, roiCostSum, roiCostWeight, roiFallback } = byKey.get(key)!;
    return { ...row, roi: roiCostWeight > 0 ? roiCostSum / roiCostWeight : roiFallback };
  });
}

/**
 * 分日人群映射：粒度 (date, planId, audienceName, subjectId)。真实报表里同一键按单元(单元ID)拆多行，
 * 必须**累加**点击；ROI/引导潜客占比/成交新客占比用点击加权 Σ(率×clicks)/Σclicks
 * （与下游 sumAudienceWindowByGroup 的点击加权一致，可层层 telescope 还原真实窗口加权值）。无日期行丢弃。
 */
export function mapAudienceDailyRows(headers: string[], rows: unknown[][], fallbackDate?: string): DailyAudienceMetricInput[] {
  const { text, num } = columnReaders(headers, AUDIENCE_COLUMN_ORDER);
  const byKey = new Map<
    string,
    {
      row: DailyAudienceMetricInput;
      clicksSum: number | null;
      roiW: number;
      guidedW: number;
      newW: number;
      roiWeight: number;
      guidedWeight: number;
      newWeight: number;
    }
  >();
  const order: string[] = [];
  for (const row of rows) {
    const rawPlanId = text(row, "计划ID");
    const rawSubjectId = text(row, "主体ID");
    const date = resolvedDate(text(row, "日期"), fallbackDate);
    if (!isDataRow(rawPlanId) || !isDataRow(rawSubjectId) || !date) {
      continue;
    }
    const planId = rawPlanId;
    const audienceName = text(row, "人群名字") || "未命名人群";
    const subjectId = rawSubjectId;
    const key = `${date} ${planId} ${audienceName} ${subjectId}`;
    const clicks = num(row, "点击量");
    const roi = num(row, "投入产出比");
    const guided = validRatioCell(num(row, "引导访问潜客占比"));
    const newc = validRatioCell(num(row, "成交新客占比"));
    const rateWeight = clicks !== null && clicks > 0 ? clicks : 0;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        row: {
          date,
          sceneId: text(row, "场景ID"),
          sceneName: text(row, "场景名字"),
          planId,
          planName: text(row, "计划名字"),
          audienceName,
          subjectId,
          subjectName: text(row, "主体名称"),
          clicks,
          roi,
          guidedPotentialCustomerRatio: guided,
          newCustomerRatio: newc
        },
        clicksSum: clicks,
        roiW: roi !== null ? roi * rateWeight : 0,
        guidedW: guided !== null ? guided * rateWeight : 0,
        newW: newc !== null ? newc * rateWeight : 0,
        roiWeight: roi !== null ? rateWeight : 0,
        guidedWeight: guided !== null ? rateWeight : 0,
        newWeight: newc !== null ? rateWeight : 0
      });
      order.push(key);
    } else {
      existing.clicksSum = addNullable(existing.clicksSum, clicks);
      existing.roiW += roi !== null ? roi * rateWeight : 0;
      existing.guidedW += guided !== null ? guided * rateWeight : 0;
      existing.newW += newc !== null ? newc * rateWeight : 0;
      existing.roiWeight += roi !== null ? rateWeight : 0;
      existing.guidedWeight += guided !== null ? rateWeight : 0;
      existing.newWeight += newc !== null ? rateWeight : 0;
      existing.row.clicks = addNullable(existing.row.clicks, clicks);
      existing.row.roi = firstKnown(existing.row.roi, roi);
      existing.row.guidedPotentialCustomerRatio = firstKnown(existing.row.guidedPotentialCustomerRatio, guided);
      existing.row.newCustomerRatio = firstKnown(existing.row.newCustomerRatio, newc);
      if (!existing.row.subjectName) {
        existing.row.subjectName = text(row, "主体名称");
      }
    }
  }
  return order.map((key) => {
    const e = byKey.get(key)!;
    return {
      ...e.row,
      clicks: e.clicksSum,
      roi: e.roiWeight > 0 ? e.roiW / e.roiWeight : e.row.roi,
      guidedPotentialCustomerRatio:
        e.guidedWeight > 0 ? e.guidedW / e.guidedWeight : e.row.guidedPotentialCustomerRatio,
      newCustomerRatio: e.newWeight > 0 ? e.newW / e.newWeight : e.row.newCustomerRatio
    };
  });
}

export function mapAudienceRows(headers: string[], rows: unknown[][]): AudienceSourceRow[] {
  const { text, num } = columnReaders(headers, AUDIENCE_COLUMN_ORDER);
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
      guidedVisitorCount: null,
      guidedPotentialCustomerRatio: validRatioCell(num(row, "引导访问潜客占比")),
      newCustomerCount: null,
      newCustomerRatio: validRatioCell(num(row, "成交新客占比"))
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
