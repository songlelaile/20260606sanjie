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

/** 分日推广宝贝指标（落 DailyPromotionMetric 表的输入）。 */
export interface DailyPromotionMetricInput {
  subjectId: string;
  date: string;
  subjectName: string;
  impressions: number;
  clicks: number;
  cost: number;
  roi: number;
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
  clicks: number;
  roi: number;
  guidedPotentialCustomerRatio: number;
  newCustomerRatio: number;
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

/**
 * 合并同一宝贝ID的多日行（达摩盘「同货品不同时段拆行」）：遵循数据逻辑做汇总——
 * - 量级求和：支付金额、IPV、营销推广消耗。
 * - 营销推广ROI：按消耗加权 Σ(ROI×消耗)/Σ消耗（ROI 的分母就是消耗）。
 * - 其余率（支付转化率/复购率/免费搜索点击率/连带购买率/连带类目宽度）：按订单数加权
 *   Σ(率×订单数)/Σ订单数，订单数=支付金额/笔单价（≈买家数，避开用 IPV 作分母）；Σ订单数=0 回落取最新一期值。
 * - 货品成长阶段 / 宝贝名称：取最大日期那行（最新一期）。笔单价重算为 Σ金额/Σ订单数。
 */
interface DamoAcc {
  paymentAmount: number;
  ipv: number;
  marketingSpend: number;
  roiSpendW: number; // Σ(ROI×消耗)
  orders: number; // Σ订单数
  convW: number;
  repurchaseW: number;
  clickW: number;
  attachW: number;
  widthW: number; // Σ(率×订单数)
  latestDate: string;
  latest: DamoProductRow;
}

function mergeDamoRows(entries: Array<{ date: string; row: DamoProductRow }>): DamoProductRow[] {
  const byId = new Map<string, DamoAcc>();
  const order: string[] = [];
  for (const { date, row } of entries) {
    const orders = row.unitPrice > 0 ? row.paymentAmount / row.unitPrice : 0;
    let acc = byId.get(row.productId);
    if (!acc) {
      acc = {
        paymentAmount: 0,
        ipv: 0,
        marketingSpend: 0,
        roiSpendW: 0,
        orders: 0,
        convW: 0,
        repurchaseW: 0,
        clickW: 0,
        attachW: 0,
        widthW: 0,
        latestDate: "",
        latest: row
      };
      byId.set(row.productId, acc);
      order.push(row.productId);
    }
    acc.paymentAmount += row.paymentAmount;
    acc.ipv += row.ipv;
    acc.marketingSpend += row.marketingSpend;
    acc.roiSpendW += row.marketingRoi * row.marketingSpend;
    acc.orders += orders;
    acc.convW += row.paymentConversionRate * orders;
    acc.repurchaseW += row.repurchaseRate * orders;
    acc.clickW += row.freeSearchClickRate * orders;
    acc.attachW += row.attachPurchaseRate * orders;
    acc.widthW += row.attachCategoryWidth * orders;
    if (acc.latestDate === "" || date > acc.latestDate) {
      acc.latestDate = date;
      acc.latest = row;
    }
  }
  return order.map((id) => {
    const a = byId.get(id)!;
    const w = a.orders > 0 ? a.orders : 0;
    const wavg = (sumW: number, fallback: number) => (w > 0 ? sumW / w : fallback);
    return {
      productId: id,
      productName: a.latest.productName,
      growthStage: a.latest.growthStage,
      paymentAmount: a.paymentAmount,
      ipv: a.ipv,
      marketingIpv: 0,
      marketingSpend: a.marketingSpend,
      marketingRoi: a.marketingSpend > 0 ? a.roiSpendW / a.marketingSpend : 0,
      paymentConversionRate: wavg(a.convW, a.latest.paymentConversionRate),
      repurchaseRate: wavg(a.repurchaseW, a.latest.repurchaseRate),
      freeSearchClickRate: wavg(a.clickW, a.latest.freeSearchClickRate),
      unitPrice: w > 0 ? a.paymentAmount / w : a.latest.unitPrice,
      attachPurchaseCount: 0,
      attachPurchaseRate: wavg(a.attachW, a.latest.attachPurchaseRate),
      attachCategoryWidth: wavg(a.widthW, a.latest.attachCategoryWidth)
    };
  });
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
  // 同 (商品ID, 统计日期) 多行 → 量级求和、率按访客加权（与读侧 aggregateProductForCycle 口径一致）。
  const byKey = new Map<
    string,
    { row: DailyProductMetricInput; visitorsW: number; stayW: number; bounceW: number; convW: number; searchConvW: number }
  >();
  const order: string[] = [];
  for (const row of rows) {
    const productId = text(row, "商品ID");
    if (!isDataRow(productId)) {
      continue;
    }
    const date = normalizeDate(text(row, "统计日期"));
    if (date === "") {
      continue;
    }
    const visitors = num(row, "商品访客数");
    const stay = num(row, "平均停留时长");
    const bounce = num(row, "商品详情页跳出率");
    const conv = num(row, "商品支付转化率");
    const searchConv = num(row, "搜索引导支付转化率");
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
          searchGuidedVisitors: num(row, "搜索引导访客数")
        },
        visitorsW: visitors,
        stayW: stay * visitors,
        bounceW: bounce * visitors,
        convW: conv * visitors,
        searchConvW: searchConv * visitors
      });
      order.push(key);
    } else {
      existing.row.visitors += visitors;
      existing.row.views += num(row, "商品浏览量");
      existing.row.paymentBuyers += num(row, "支付买家数");
      existing.row.paymentAmount += num(row, "支付金额");
      existing.row.refundAmount += num(row, "成功退款金额");
      existing.row.searchGuidedVisitors += num(row, "搜索引导访客数");
      existing.visitorsW += visitors;
      existing.stayW += stay * visitors;
      existing.bounceW += bounce * visitors;
      existing.convW += conv * visitors;
      existing.searchConvW += searchConv * visitors;
      if (!existing.row.productName) {
        existing.row.productName = text(row, "商品名称");
      }
    }
  }
  return order.map((key) => {
    const e = byKey.get(key)!;
    const w = e.visitorsW > 0 ? e.visitorsW : 1;
    return {
      ...e.row,
      averageStaySeconds: e.stayW / w,
      bounceRate: e.bounceW / w,
      productPaymentConversionRate: e.convW / w,
      searchGuidedPaymentConversionRate: e.searchConvW / w
    };
  });
}

export function mapDamoProductRows(headers: string[], rows: unknown[][]): DamoProductRow[] {
  const { text, num } = columnReaders(headers);
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
        marketingIpv: 0,
        marketingSpend: num(row, "营销推广消耗"),
        marketingRoi: num(row, "营销推广ROI"),
        paymentConversionRate: num(row, "支付转化率"),
        repurchaseRate: num(row, "复购率"),
        freeSearchClickRate: num(row, "免费搜索点击率"),
        unitPrice: num(row, "笔单价"),
        attachPurchaseCount: 0,
        attachPurchaseRate: num(row, "连带购买率"),
        attachCategoryWidth: num(row, "连带购买叶子类目宽度")
      } as DamoProductRow
    }));
  return mergeDamoRows(entries);
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

/**
 * 分日推广映射：粒度 (subjectId, date)。真实万相台报表里同一(主体,日期)按场景/计划拆成多行，
 * 必须**累加**展现/点击/花费（保首行会严重少计），ROI 用花费加权 Σ(roi×cost)/Σcost。无日期行丢弃。
 */
export function mapPromotionDailyRows(headers: string[], rows: unknown[][]): DailyPromotionMetricInput[] {
  const { text, num } = columnReaders(headers);
  const byKey = new Map<string, { row: DailyPromotionMetricInput; roiCostSum: number }>();
  const order: string[] = [];
  for (const row of rows) {
    const subjectId = text(row, "主体ID");
    if (!isDataRow(subjectId)) {
      continue;
    }
    const date = normalizeDate(text(row, "日期"));
    if (date === "") {
      continue;
    }
    const key = `${subjectId} ${date}`;
    const impressions = num(row, "展现量");
    const clicks = num(row, "点击量");
    const cost = num(row, "花费");
    const roi = num(row, "投入产出比");
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        row: { subjectId, date, subjectName: text(row, "主体名称"), impressions, clicks, cost, roi },
        roiCostSum: roi * cost
      });
      order.push(key);
    } else {
      existing.row.impressions += impressions;
      existing.row.clicks += clicks;
      existing.row.cost += cost;
      existing.roiCostSum += roi * cost;
      if (!existing.row.subjectName) {
        existing.row.subjectName = text(row, "主体名称");
      }
    }
  }
  return order.map((key) => {
    const { row, roiCostSum } = byKey.get(key)!;
    return { ...row, roi: row.cost > 0 ? roiCostSum / row.cost : 0 };
  });
}

/**
 * 分日人群映射：粒度 (date, planId, audienceName, subjectId)。真实报表里同一键按单元(单元ID)拆多行，
 * 必须**累加**点击；ROI/引导潜客占比/成交新客占比用点击加权 Σ(率×clicks)/Σclicks
 * （与下游 sumAudienceWindowByGroup 的点击加权一致，可层层 telescope 还原真实窗口加权值）。无日期行丢弃。
 */
export function mapAudienceDailyRows(headers: string[], rows: unknown[][]): DailyAudienceMetricInput[] {
  const { text, num } = columnReaders(headers);
  const byKey = new Map<
    string,
    { row: DailyAudienceMetricInput; clicksSum: number; roiW: number; guidedW: number; newW: number }
  >();
  const order: string[] = [];
  for (const row of rows) {
    const planId = text(row, "计划ID");
    if (!isDataRow(planId)) {
      continue;
    }
    const date = normalizeDate(text(row, "日期"));
    if (date === "") {
      continue;
    }
    const audienceName = text(row, "人群名字");
    const subjectId = text(row, "主体ID");
    const key = `${date} ${planId} ${audienceName} ${subjectId}`;
    const clicks = num(row, "点击量");
    const roi = num(row, "投入产出比");
    const guided = num(row, "引导访问潜客占比");
    const newc = num(row, "成交新客占比");
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
        roiW: roi * clicks,
        guidedW: guided * clicks,
        newW: newc * clicks
      });
      order.push(key);
    } else {
      existing.clicksSum += clicks;
      existing.roiW += roi * clicks;
      existing.guidedW += guided * clicks;
      existing.newW += newc * clicks;
      existing.row.clicks += clicks;
      if (!existing.row.subjectName) {
        existing.row.subjectName = text(row, "主体名称");
      }
    }
  }
  return order.map((key) => {
    const e = byKey.get(key)!;
    const w = e.clicksSum;
    return {
      ...e.row,
      clicks: e.clicksSum,
      roi: w > 0 ? e.roiW / w : 0,
      guidedPotentialCustomerRatio: w > 0 ? e.guidedW / w : 0,
      newCustomerRatio: w > 0 ? e.newW / w : 0
    };
  });
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
