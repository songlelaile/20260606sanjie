import sourceData from "@/lib/fixtures/business-diagnosis-source.json";
import { evaluateDiagnosisModels, type ModelAdmissionDecision } from "@/lib/model-admission/evaluate";
import { assessEvidenceWindow, type EvidenceWindowStatus } from "@/lib/analysis-evidence";
import { countInclusiveDays } from "@/lib/analysis-period";
import { currentIsoDate } from "@/lib/comparison-window";

/**
 * 类目经营分组。
 *
 * 「潜力新星」是后补的一档：份额还小、但增长强劲且转化不差的类目。
 * 早期版本没有这一档，它们会掉进"收缩观察"并被建议"控资源"——对一个正在
 * 爆发的类目给出收缩建议，是与事实直接矛盾、且代价最高的一类误判。
 */
export type BusinessCategoryQuadrant =
  | "增长引擎"
  | "规模守成"
  | "潜力新星"
  | "效率修复"
  | "收缩观察";
export type BusinessStrategyPriority = "P1" | "P2" | "P3";
export type BusinessValueChainStatus = "good" | "warn" | "bad";
export type BusinessEvidenceLevel = "observed" | "directional" | "insufficient";

export interface StoreCategoryMonthlyRow {
  month: string;
  level1Category: string;
  level2Category: string;
  categoryName: string;
  visitors: number | null;
  views: number | null;
  visitorProducts: number | null;
  paidProducts: number | null;
  addCartUsers: number | null;
  addCartItems: number | null;
  favorites: number | null;
  favoriteRate: number | null;
  addCartRate: number | null;
  orderBuyers: number | null;
  orderItems: number | null;
  orderAmount: number | null;
  orderConversionRate: number | null;
  paymentBuyers: number | null;
  paymentItems: number | null;
  paymentAmount: number | null;
  paymentShare: number | null;
  paymentConversionRate: number | null;
  monthlyCumulativePayment: number | null;
  yearlyCumulativePayment: number | null;
  jhsPaymentAmount: number | null;
  newBuyers: number | null;
  oldBuyers: number | null;
  oldBuyerPaymentAmount: number | null;
  customerUnitPrice: number | null;
  visitorValue: number | null;
  refundAmount: number | null;
}

export interface MarketOverviewRow {
  month: string;
  salesShare: number | null;
  salesYoY: number | null;
  volumeShare: number | null;
  volumeYoY: number | null;
  buyerScale: string;
  buyerYoY: number | null;
  unitPrice: number | null;
  unitPriceYoY: number | null;
  supplyIndex: number | null;
  supplyYoY: number | null;
}

export interface MarketPriceBand {
  priceBand: string;
  marketShare: number | null;
  yoy: number | null;
  supplyIndex: number | null;
}

export interface MarketAttributeSignal {
  attribute: string;
  value: string;
  salesIndex: number | null;
  yoy: number | null;
  supplyIndex: number | null;
}

export interface MarketSearchSignal {
  category: string;
  searchUv: number | null;
  avgGrowthRate: number | null;
  clickRate: number | null;
  conversionRate: number | null;
}

type CompleteStoreCategoryMonthlyRow = StoreCategoryMonthlyRow & {
  visitors: number;
  visitorProducts: number;
  paidProducts: number;
  paymentAmount: number;
  paymentConversionRate: number;
  customerUnitPrice: number;
  visitorValue: number;
  refundAmount: number;
};

type CompleteMarketOverviewRow = MarketOverviewRow & {
  salesShare: number;
  salesYoY: number;
  volumeShare: number;
  volumeYoY: number;
  buyerYoY: number;
  unitPrice: number;
  unitPriceYoY: number;
  supplyIndex: number;
  supplyYoY: number;
};

type CompleteMarketPriceBand = MarketPriceBand & {
  marketShare: number;
  yoy: number;
  supplyIndex: number;
};

type CompleteMarketAttributeSignal = MarketAttributeSignal & {
  salesIndex: number;
  yoy: number;
  supplyIndex: number;
};

type CompleteMarketSearchSignal = MarketSearchSignal & {
  searchUv: number;
  avgGrowthRate: number;
  clickRate: number;
  conversionRate: number;
};

export interface BusinessDiagnosisSource {
  generatedAt: string;
  sourceNote: string;
  storeCategoryRows: StoreCategoryMonthlyRow[];
  market: {
    overview: MarketOverviewRow[];
    priceBands: MarketPriceBand[];
    attributeSignals: MarketAttributeSignal[];
    searchSignals: MarketSearchSignal[];
  };
}

export interface BusinessKpiSummary {
  latestStoreMonth: string;
  latestMarketMonth: string;
  storeDataAvailable: boolean;
  storeTotalAvailable: boolean;
  paymentAmount: number | null;
  netSales: number | null;
  visitors: number | null;
  paymentConversionRate: number | null;
  refundRate: number | null;
  revenueGrowth: number | null;
  visitorGrowth: number | null;
  marketSalesShare: number | null;
  marketSalesShareChange: number | null;
  comparisonEvidenceStatus: EvidenceWindowStatus;
  comparisonConclusionAllowed: boolean;
  comparisonBasisNote: string;
}

export interface BusinessCategorySummary {
  categoryName: string;
  level2Category: string;
  latestMonth: string;
  paymentAmount: number;
  netSales: number;
  visitors: number;
  visitorShare: number;
  revenueShare: number;
  revenueGrowth: number | null;
  visitorGrowth: number | null;
  paymentConversionRate: number;
  conversionDelta: number | null;
  comparisonConclusionAllowed: boolean;
  customerUnitPrice: number;
  visitorValue: number;
  refundRate: number;
  paidProductRate: number;
  opportunityAmount: number;
  quadrant: BusinessCategoryQuadrant;
  diagnosis: string;
  action: string;
}

export interface BusinessValueChainStage {
  key: "traffic" | "conversion" | "basket" | "refund" | "categoryMix" | "market";
  label: string;
  score: number | null;
  status: BusinessValueChainStatus;
  evidence: string;
  action: string;
}

export interface BusinessStrategyCard {
  id: string;
  priority: BusinessStrategyPriority;
  model: string;
  title: string;
  target: string;
  diagnosis: string;
  evidence: string[];
  actions: string[];
  expectedImpact: string;
}

export interface BusinessMarketContext {
  latest: CompleteMarketOverviewRow | null;
  previous: CompleteMarketOverviewRow | null;
  trend: CompleteMarketOverviewRow[];
  topPriceBands: CompleteMarketPriceBand[];
  topAttributeSignals: CompleteMarketAttributeSignal[];
  topSearchSignals: CompleteMarketSearchSignal[];
  samePeriod: boolean;
  comparisonEvidenceStatus: EvidenceWindowStatus;
  conclusionAllowed: boolean;
  periodNote: string;
  note: string;
}

export interface BusinessMarketOpportunity {
  id: string;
  title: string;
  model: string;
  score: number;
  status: BusinessValueChainStatus;
  diagnosis: string;
  evidence: string[];
  evidenceLevel: BusinessEvidenceLevel;
  requiredData: string[];
  action: string;
}

export interface BusinessActionReviewLoop {
  id: string;
  title: string;
  owner: string;
  beforeMetric: string;
  afterTarget: string;
  cadence: string;
  closedLoop: string[];
}

export interface BusinessPestSignal {
  dimension: "政策 P" | "经济 E" | "社会 S" | "技术 T";
  score: number | null;
  status: BusinessValueChainStatus;
  available: boolean;
  evidence: string;
  implication: string;
  requiredData: string[];
}

export interface BusinessPorterForce {
  force: "行业竞争" | "买方议价" | "供方压力" | "替代威胁" | "新进入者";
  intensity: number | null;
  status: BusinessValueChainStatus;
  available: boolean;
  evidenceLevel: "directional" | "insufficient";
  evidence: string;
  action: string;
  requiredData: string[];
}

export interface BusinessSevenSItem {
  dimension: "Strategy" | "Structure" | "Systems" | "Shared Values" | "Skills" | "Staff" | "Style";
  label: string;
  score: number | null;
  status: BusinessValueChainStatus;
  available: boolean;
  evidence: string;
  action: string;
  requiredData: string[];
}

export interface BusinessRoadmapStep {
  step: number;
  title: string;
  horizon: string;
  owner: string;
  priority: BusinessStrategyPriority;
  action: string;
  metric: string;
}

export interface BusinessNpsReputation {
  /** 真实 NPS 需要推荐意愿问卷；未采集时必须为 null。 */
  score: number | null;
  available: boolean;
  status: BusinessValueChainStatus;
  detractorRisk: string;
  promoterLever: string;
  signals: string[];
  actions: string[];
  requiredData: string[];
}

export interface BusinessQuestionnaireItem {
  id: string;
  dimension: string;
  question: string;
  defaultAnswer: string;
  evidence: string;
  options: string[];
}

export interface BusinessAiDiagnosisReport {
  title: string;
  summary: string;
  sections: {
    title: string;
    finding: string;
    recommendation: string;
    evidence: string[];
  }[];
  prompt: string;
}

export interface BusinessDiagnosisSnapshot {
  generatedAt: string;
  summary: BusinessKpiSummary;
  categories: BusinessCategorySummary[];
  quadrants: Record<BusinessCategoryQuadrant, BusinessCategorySummary[]>;
  valueChain: BusinessValueChainStage[];
  strategyCards: BusinessStrategyCard[];
  marketOpportunities: BusinessMarketOpportunity[];
  actionReviewLoops: BusinessActionReviewLoop[];
  pestSignals: BusinessPestSignal[];
  porterForces: BusinessPorterForce[];
  sevenS: BusinessSevenSItem[];
  roadmap: BusinessRoadmapStep[];
  npsReputation: BusinessNpsReputation;
  questionnaire: BusinessQuestionnaireItem[];
  aiReport: BusinessAiDiagnosisReport;
  market: BusinessMarketContext;
  modelAdmissions: ModelAdmissionDecision[];
}

const BUSINESS_QUADRANTS: BusinessCategoryQuadrant[] = [
  "增长引擎",
  "规模守成",
  "潜力新星",
  "效率修复",
  "收缩观察"
];
/**
 * 诊断分只用于同一张价值链卡片内排序，不是行业绝对基准。
 * 将标尺集中配置，避免散落的“魔法数字”被误当成外部行业标准。
 */
const BUSINESS_SCORE_POLICY = {
  conversion: { scale: 1800 },
  refund: { penaltyScale: 520 },
  basket: { base: 42, unitPriceScale: 35 },
  traffic: { base: 62, growthScale: 120 },
  categoryMix: { base: 48, growthShareScale: 52 },
  market: { base: 55, momentumScale: 240 }
} as const;
const SOURCE = sourceData as unknown as BusinessDiagnosisSource;

export function getBusinessDiagnosisSource(): BusinessDiagnosisSource {
  return SOURCE;
}

export function buildBusinessDiagnosisSnapshot(source: BusinessDiagnosisSource): BusinessDiagnosisSnapshot {
  const storeRows = source.storeCategoryRows;
  const completeStoreRows = storeRows.filter(isCompleteStoreCategoryRow);
  const latestStoreMonth = maxString(completeStoreRows.map((row) => row.month));
  const previousStoreMonth = previousAdjacentMonth(completeStoreRows.map((row) => row.month), latestStoreMonth);
  const latestTopRow = pickStoreTotalRow(completeStoreRows, latestStoreMonth);
  const previousTopRow = previousStoreMonth ? pickStoreTotalRow(completeStoreRows, previousStoreMonth) : null;
  const leafRows = completeStoreRows.filter(isDiagnosableLeafRow);
  const latestLeafRows = leafRows.filter((row) => row.month === latestStoreMonth);
  const previousLeafRows = previousStoreMonth ? leafRows.filter((row) => row.month === previousStoreMonth) : [];
  const completeMarketOverview = source.market.overview.filter(isCompleteMarketOverviewRow);
  const completePriceBands = source.market.priceBands.filter(isCompleteMarketPriceBand);
  const completeAttributeSignals = source.market.attributeSignals.filter(isCompleteMarketAttributeSignal);
  const completeSearchSignals = source.market.searchSignals.filter(isCompleteMarketSearchSignal);
  const latestMarketMonth = maxString(completeMarketOverview.map((row) => row.month));
  const latestMarketRow = latestMarketMonth
    ? completeMarketOverview.find((row) => row.month === latestMarketMonth) ?? null
    : null;
  const previousMarketMonth = previousAdjacentMonth(completeMarketOverview.map((row) => row.month), latestMarketMonth);
  const previousMarketRow = previousMarketMonth
    ? completeMarketOverview.find((row) => row.month === previousMarketMonth) ?? null
    : null;
  const storeComparisonEvidence = assessMonthlyComparison(latestStoreMonth, previousStoreMonth);
  const marketComparisonEvidence = assessMonthlyComparison(latestMarketMonth, previousMarketMonth);

  const summary = buildSummary({
    latestStoreMonth,
    latestMarketMonth,
    storeDataAvailable: storeRows.length > 0,
    latestTopRow,
    previousTopRow,
    latestMarketRow,
    previousMarketRow,
    comparisonEvidenceStatus: storeComparisonEvidence.status,
    comparisonConclusionAllowed: storeComparisonEvidence.conclusionAllowed,
    marketComparisonConclusionAllowed: marketComparisonEvidence.conclusionAllowed
  });
  const categories = buildCategorySummaries({
    leafRows,
    latestLeafRows,
    previousLeafRows,
    latestStoreMonth,
    comparisonConclusionAllowed: storeComparisonEvidence.conclusionAllowed
  });
  const quadrants = groupByQuadrant(categories);
  const alignmentEvidence = assessMonthlyAlignment(latestStoreMonth, latestMarketMonth);
  const samePeriod = alignmentEvidence.conclusionAllowed;
  const comparisonBasisNote = storeComparisonEvidence.conclusionAllowed
    ? "YYYY-MM 相邻月度窗口均已自然闭合；仍需确认两期采用相同月末口径。"
    : `当前仅展示可读取的数据值，不生成月度涨跌结论：${storeComparisonEvidence.message}`;
  const alignmentNote = samePeriod
    ? `本店与市场均为 ${latestStoreMonth}，可做同期方向判断。`
    : `本店为 ${latestStoreMonth || "缺失"}、市场为 ${latestMarketMonth || "缺失"}，不可合成为同期市场机会；需补 ${latestStoreMonth || "本店同期"} 市场表或对应市场月份的本店表。`;
  const periodNote = `${alignmentNote}${comparisonBasisNote}`;
  const market: BusinessMarketContext = {
    latest: latestMarketRow,
    previous: previousMarketRow,
    trend: completeMarketOverview,
    topPriceBands: completePriceBands.slice(0, 8),
    topAttributeSignals: completeAttributeSignals.slice(0, 10),
    topSearchSignals: completeSearchSignals.slice(0, 8),
    samePeriod,
    comparisonEvidenceStatus: alignmentEvidence.status,
    conclusionAllowed: alignmentEvidence.conclusionAllowed,
    periodNote,
    note: [source.sourceNote, periodNote].filter(Boolean).join("；")
  };
  const valueChain = buildBusinessValueChain({ summary, categories, market });
  const marketOpportunities = buildMarketOpportunities({ summary, categories, market });
  const pestSignals = buildPestSignals({ summary, market });
  const porterForces = buildPorterForces({ summary, categories, market });
  const strategyCards = buildBusinessStrategyCards({ summary, categories, market, valueChain });
  const actionReviewLoops = buildActionReviewLoops({ categories, valueChain, marketOpportunities, strategyCards });
  const sevenS = buildSevenSReadiness({ summary, categories, valueChain, strategyCards, marketOpportunities });
  const roadmap = buildBusinessRoadmap({ summary, categories, marketOpportunities, valueChain });
  const npsReputation = buildNpsReputation({ summary, categories, valueChain });
  const questionnaire = buildQuestionnaire({ summary, categories, market, npsReputation, sevenS });
  const modelAdmissions = evaluateDiagnosisModels({
    hasOperatingResults: summary.storeTotalAvailable,
    hasProfitEvidence: false,
    hasTrendComparison: summary.revenueGrowth !== null && summary.comparisonConclusionAllowed,
    hasOpportunityTargets: categories.length > 0,
    hasProductDimensions: false,
    hasAudienceSignals: false,
    hasAudienceEconomics: false,
    hasInvestmentApproval: false,
    hasClosedComparison: false,
    hasControlGroup: false,
    hasCategoryData: categories.length > 0,
    hasComparableCategoryPeriods: categories.some(
      (category) => category.revenueGrowth !== null && category.comparisonConclusionAllowed
    ),
    hasMarketSignals:
      market.topPriceBands.length > 0 ||
      market.topAttributeSignals.length > 0 ||
      market.topSearchSignals.length > 0,
    hasAlignedMarketPeriod: market.samePeriod,
    hasUnitCostCurve: false,
    hasScaleCostStructure: false,
    hasMacroEvidence: false,
    hasCompetitionEvidence: false,
    hasOrganizationEvidence: false,
    hasNpsSurvey: npsReputation.available
  });
  const aiReport = buildAiDiagnosisReport({
    summary,
    categories,
    market,
    valueChain,
    strategyCards,
    marketOpportunities,
    modelAdmissions
  });

  return {
    generatedAt: source.generatedAt,
    summary,
    categories,
    quadrants,
    valueChain,
    strategyCards,
    marketOpportunities,
    actionReviewLoops,
    pestSignals,
    porterForces,
    sevenS,
    roadmap,
    npsReputation,
    questionnaire,
    aiReport,
    market,
    modelAdmissions
  };
}

function buildSummary(input: {
  latestStoreMonth: string;
  latestMarketMonth: string;
  storeDataAvailable: boolean;
  latestTopRow: CompleteStoreCategoryMonthlyRow | null;
  previousTopRow: CompleteStoreCategoryMonthlyRow | null;
  latestMarketRow: CompleteMarketOverviewRow | null;
  previousMarketRow: CompleteMarketOverviewRow | null;
  comparisonEvidenceStatus: EvidenceWindowStatus;
  comparisonConclusionAllowed: boolean;
  marketComparisonConclusionAllowed: boolean;
}): BusinessKpiSummary {
  const latest = input.latestTopRow;
  const previous = input.previousTopRow;
  const paymentAmount = latest?.paymentAmount ?? null;
  const refundAmount = latest?.refundAmount ?? null;
  const visitors = latest?.visitors ?? null;
  return {
    latestStoreMonth: input.latestStoreMonth,
    latestMarketMonth: input.latestMarketMonth,
    storeDataAvailable: input.storeDataAvailable,
    storeTotalAvailable: latest !== null,
    paymentAmount,
    netSales: paymentAmount === null || refundAmount === null ? null : paymentAmount - refundAmount,
    visitors,
    paymentConversionRate: latest?.paymentConversionRate ?? null,
    refundRate: paymentAmount === null || refundAmount === null ? null : ratio(refundAmount, paymentAmount),
    revenueGrowth: comparableGrowth(paymentAmount, previous?.paymentAmount),
    visitorGrowth: comparableGrowth(visitors, previous?.visitors),
    marketSalesShare: input.latestMarketRow?.salesShare ?? null,
    marketSalesShareChange:
      input.marketComparisonConclusionAllowed && input.latestMarketRow && input.previousMarketRow
        ? input.latestMarketRow.salesShare - input.previousMarketRow.salesShare
        : null,
    comparisonEvidenceStatus: input.comparisonEvidenceStatus,
    comparisonConclusionAllowed: input.comparisonConclusionAllowed,
    comparisonBasisNote: input.comparisonConclusionAllowed
      ? "YYYY-MM 相邻月度窗口均已自然闭合；仍需确认两期采用相同月末口径。"
      : "月度证据窗口未闭合、缺期或口径不可比，现有数值只能观察。"
  };
}

function buildCategorySummaries(input: {
  leafRows: CompleteStoreCategoryMonthlyRow[];
  latestLeafRows: CompleteStoreCategoryMonthlyRow[];
  previousLeafRows: CompleteStoreCategoryMonthlyRow[];
  latestStoreMonth: string;
  comparisonConclusionAllowed: boolean;
}): BusinessCategorySummary[] {
  const latestLeafByCategory = new Map(input.latestLeafRows.map((row) => [row.categoryName, row]));
  const previousLeafByCategory = new Map(input.previousLeafRows.map((row) => [row.categoryName, row]));
  const latestPaymentTotal = sum(input.latestLeafRows.map((row) => row.paymentAmount));
  const latestVisitorTotal = sum(input.latestLeafRows.map((row) => row.visitors));
  const categoryNames = [...new Set(input.leafRows.map((row) => row.categoryName))].sort();
  const preliminary = categoryNames.flatMap((categoryName) => {
    const latest = latestLeafByCategory.get(categoryName);
    if (!latest) return [];
    const previous = previousLeafByCategory.get(categoryName) ?? null;
    const revenueShare = ratio(latest.paymentAmount, latestPaymentTotal);
    const visitorShare = ratio(latest.visitors, latestVisitorTotal);
    const refundRate = ratio(latest.refundAmount, latest.paymentAmount);
    const paidProductRate = ratio(latest.paidProducts, latest.visitorProducts);
    const revenueGrowth = comparableGrowth(latest.paymentAmount, previous?.paymentAmount);
    const visitorGrowth = comparableGrowth(latest.visitors, previous?.visitors);
    const conversionDelta = previous ? latest.paymentConversionRate - previous.paymentConversionRate : null;
    return [
      {
        categoryName,
        level2Category: latest.level2Category,
        latestMonth: input.latestStoreMonth,
        paymentAmount: latest.paymentAmount,
        netSales: latest.paymentAmount - latest.refundAmount,
        visitors: latest.visitors,
        visitorShare,
        revenueShare,
        revenueGrowth,
        visitorGrowth,
        paymentConversionRate: latest.paymentConversionRate,
        conversionDelta,
        comparisonConclusionAllowed: input.comparisonConclusionAllowed,
        customerUnitPrice: latest.customerUnitPrice,
        visitorValue: latest.visitorValue,
        refundRate,
        paidProductRate,
        opportunityAmount: 0,
        quadrant: "收缩观察" as BusinessCategoryQuadrant,
        diagnosis: "",
        action: ""
      }
    ];
  });
  const revenueGrowthMedian = median(preliminary.flatMap((item) => item.revenueGrowth === null ? [] : [item.revenueGrowth]));
  const revenueShareMedian = median(preliminary.map((item) => item.revenueShare));
  const conversionMedian = median(preliminary.map((item) => item.paymentConversionRate));
  const visitorMedian = median(preliminary.map((item) => item.visitors));
  return preliminary
    .map((item) => {
      const highShare = item.revenueShare >= revenueShareMedian || item.revenueShare >= 0.18;
      // “增长”必须是正增长；高于一个负数中位数不能被包装成增长引擎。
      const highGrowth = item.comparisonConclusionAllowed && item.revenueGrowth !== null && item.revenueGrowth > 0 &&
        item.revenueGrowth >= revenueGrowthMedian;
      const lowConversion = item.paymentConversionRate < conversionMedian;
      const highTrafficLowConversion = item.visitors >= visitorMedian && lowConversion;
      const quadrant: BusinessCategoryQuadrant = highShare
        ? highGrowth
          ? "增长引擎"
          : "规模守成"
        : highGrowth && !lowConversion
          ? "潜力新星"
        : highTrafficLowConversion || (highGrowth && lowConversion)
          ? "效率修复"
          : "收缩观察";
      const conversionGapAmount = Math.max(conversionMedian - item.paymentConversionRate, 0) * item.visitors * item.customerUnitPrice;
      const declineGapAmount = !item.comparisonConclusionAllowed || item.revenueGrowth === null
        ? 0
        : Math.max(-item.revenueGrowth, 0) * item.paymentAmount;
      const opportunityAmount = conversionGapAmount + declineGapAmount;
      return {
        ...item,
        quadrant,
        opportunityAmount,
        diagnosis: categoryDiagnosis(item, quadrant, conversionMedian),
        action: categoryAction(quadrant)
      };
    })
    .sort((left, right) => right.paymentAmount - left.paymentAmount);
}

function buildBusinessValueChain(input: {
  summary: BusinessKpiSummary;
  categories: BusinessCategorySummary[];
  market: BusinessMarketContext;
}): BusinessValueChainStage[] {
  const categories = input.categories;
  const avgPaidProductRate = average(categories.map((item) => item.paidProductRate));
  const highRefund = categories.filter((item) => item.refundRate >= 0.12);
  const comparableCategories = categories.filter(
    (item) => item.comparisonConclusionAllowed && item.revenueGrowth !== null
  );
  const growthCategories = comparableCategories.filter((item) => (item.revenueGrowth ?? 0) > 0);
  const hasStoreTotal = input.summary.storeTotalAvailable;
  const hasCategories = categories.length > 0;
  const weightedCustomerUnitPrice = weightedAverage(
    categories.map((item) => ({ value: item.customerUnitPrice, weight: item.paymentAmount }))
  );
  const conversionScore = hasStoreTotal && input.summary.paymentConversionRate !== null
    ? clamp(Math.round(input.summary.paymentConversionRate * BUSINESS_SCORE_POLICY.conversion.scale), 0, 100)
    : 50;
  const refundScore = hasStoreTotal && input.summary.refundRate !== null
    ? clamp(Math.round(100 - input.summary.refundRate * BUSINESS_SCORE_POLICY.refund.penaltyScale), 0, 100)
    : 50;
  const basketScore = hasCategories && weightedCustomerUnitPrice !== null
    ? clamp(Math.round(
        BUSINESS_SCORE_POLICY.basket.base +
        weightedCustomerUnitPrice / BUSINESS_SCORE_POLICY.basket.unitPriceScale
      ), 0, 100)
    : 50;
  const trafficScore = !input.summary.comparisonConclusionAllowed || input.summary.visitorGrowth === null
    ? 50
    : clamp(Math.round(
        BUSINESS_SCORE_POLICY.traffic.base +
        input.summary.visitorGrowth * BUSINESS_SCORE_POLICY.traffic.growthScale
      ), 0, 100);
  const categoryMixScore = comparableCategories.length === 0
    ? 50
    : clamp(Math.round(
        BUSINESS_SCORE_POLICY.categoryMix.base +
        ratio(growthCategories.length, comparableCategories.length) * BUSINESS_SCORE_POLICY.categoryMix.growthShareScale
      ), 0, 100);
  const marketMomentum = input.summary.marketSalesShareChange;
  // 非同期市场数据只能作为方向提示，不得生成可参与短板排序的数值分数。
  const marketScore = marketMomentum === null || !input.market.conclusionAllowed
    ? null
    : clamp(Math.round(
        BUSINESS_SCORE_POLICY.market.base + marketMomentum * BUSINESS_SCORE_POLICY.market.momentumScale
      ), 0, 100);

  return [
    {
      key: "traffic",
      label: "流量规模",
      score: !input.summary.comparisonConclusionAllowed || input.summary.visitorGrowth === null ? null : trafficScore,
      status: !input.summary.comparisonConclusionAllowed || input.summary.visitorGrowth === null ? "warn" : statusFromScore(trafficScore),
      evidence: !hasStoreTotal
        ? "缺少可靠的全店汇总行，叶子类目访客不可相加为全店去重访客，因此不能判断全店访客变化。"
        : !input.summary.comparisonConclusionAllowed || input.summary.visitorGrowth === null
          ? `缺少可比相邻月份，全店访客变化证据不足；最新去重访客 ${Math.round(input.summary.visitors as number).toLocaleString("zh-CN")}；${input.summary.comparisonBasisNote}`
          : `本店访客月累计对比 ${formatSignedRate(input.summary.visitorGrowth)}，最新去重访客 ${Math.round(input.summary.visitors as number).toLocaleString("zh-CN")}；${input.summary.comparisonBasisNote}`,
      action: hasStoreTotal
        ? "围绕高成交类目保留搜索与内容入口，低转化高流量类目先做承接修复。"
        : "补充包含全店去重访客的可靠汇总行，再判断流量规模与变化。"
    },
    {
      key: "conversion",
      label: "成交转化",
      score: hasStoreTotal ? conversionScore : null,
      status: hasStoreTotal ? statusFromScore(conversionScore) : "warn",
      evidence: hasStoreTotal
        ? `全店支付转化 ${formatSignedRate(input.summary.paymentConversionRate, false)}，月累计可比类目 ${categories.filter((item) => item.conversionDelta !== null).length} 个；${input.summary.comparisonBasisNote}`
        : "缺少可靠的全店汇总行，叶子类目买家与访客不可相加为全店去重人数，因此不计算全店支付转化。",
      action: hasStoreTotal
        ? "优先排查主图首屏、价格利益点、评价信任和套装路径，避免直接用预算覆盖转化问题。"
        : "补充全店去重访客、支付买家及支付转化汇总，当前不做全店转化判断。"
    },
    {
      key: "basket",
      label: "客单与组合价值",
      score: hasCategories ? basketScore : null,
      status: hasCategories ? statusFromScore(basketScore) : "warn",
      evidence: hasCategories && weightedCustomerUnitPrice !== null
        ? `按支付额加权客单 ${Math.round(weightedCustomerUnitPrice).toLocaleString("zh-CN")} 元，付费商品覆盖率 ${formatSignedRate(avgPaidProductRate, false)}`
        : "未上传本店类目表，客单与商品覆盖证据不足。",
      action: hasCategories
        ? "用烟灶套装、配件组合和安装服务拉高客单，把单品利润转成组合利润。"
        : "先上传本店类目表，再判断客单与组合机会。"
    },
    {
      key: "refund",
      label: "退款与利润漏损",
      score: hasStoreTotal ? refundScore : null,
      status: hasStoreTotal ? statusFromScore(refundScore) : "warn",
      evidence: hasStoreTotal
        ? `全店退款率 ${formatSignedRate(input.summary.refundRate, false)}，高退款类目 ${highRefund.length} 个`
        : hasCategories
          ? `缺少可靠全店汇总，不能计算全店退款率；仅识别到 ${highRefund.length} 个高退款叶子类目。`
          : "未上传本店类目表，退款与净销售证据不足。",
      action: input.summary.storeDataAvailable
        ? "把退款原因拆到品类和商品，优先治理高销售额且高退款的链路。"
        : "先补本店支付与退款数据，再识别利润漏损。"
    },
    {
      key: "categoryMix",
      label: "品类组合",
      score: comparableCategories.length === 0 ? null : categoryMixScore,
      status: comparableCategories.length === 0 ? "warn" : statusFromScore(categoryMixScore),
      evidence: !hasCategories
        ? "未上传本店类目表，不能判断品类组合。"
        : comparableCategories.length === 0
          ? `缺少可比相邻月份，类目增长结构证据不足；头部类目贡献 ${formatSignedRate(categories[0].revenueShare, false)}；${input.summary.comparisonBasisNote}`
          : `${growthCategories.length}/${comparableCategories.length} 个可比叶子类目月累计增长，头部类目贡献 ${formatSignedRate(categories[0].revenueShare, false)}；${input.summary.comparisonBasisNote}`,
      action: hasCategories
        ? "按增长引擎、规模守成、效率修复、收缩观察四组安排诊断与运营验证，不在本模型内直接分配预算。"
        : "先上传本店叶子类目数据，再进行组合分组。"
    },
    {
      key: "market",
      label: "市场大盘",
      score: marketScore,
      status: marketScore === null || !input.market.conclusionAllowed ? "warn" : statusFromScore(marketScore),
      evidence: input.market.latest && marketMomentum !== null
        ? `市场销售占比 ${formatSignedRate(input.market.latest.salesShare, false)}，较相邻月份 ${formatSignedRate(marketMomentum)}；${input.market.periodNote}`
        : "暂无市场大盘趋势",
      action: "把价格带、卖点属性和搜索词作为当前类目大盘信号，先用于选品、定价和内容方向。"
    }
  ];
}

function buildBusinessStrategyCards(input: {
  summary: BusinessKpiSummary;
  categories: BusinessCategorySummary[];
  market: BusinessMarketContext;
  valueChain: BusinessValueChainStage[];
}): BusinessStrategyCard[] {
  const cards: BusinessStrategyCard[] = [];
  const growthEngine = input.categories.find((item) => item.quadrant === "增长引擎");
  const repair = [...input.categories]
    .filter((item) => item.quadrant === "效率修复")
    .sort((left, right) => right.opportunityAmount - left.opportunityAmount)[0];
  const highRefund = [...input.categories].sort((left, right) => right.refundRate - left.refundRate)[0];
  const decliningCore = input.categories.find(
    (item) => item.quadrant === "规模守成" && item.comparisonConclusionAllowed &&
      item.revenueGrowth !== null && item.revenueGrowth < -0.08
  );
  const topSearch = input.market.topSearchSignals[0];
  const topAttribute = input.market.topAttributeSignals[0];
  const weakestValueChain = [...input.valueChain]
    .filter((stage): stage is BusinessValueChainStage & { score: number } => stage.score !== null)
    .sort((left, right) => left.score - right.score)[0];

  if (growthEngine) {
    cards.push({
      id: "scale-growth-engine",
      priority: "P1",
      model: "类目经营分组",
      title: `验证 ${growthEngine.categoryName} 的增长引擎候选`,
      target: growthEngine.categoryName,
      diagnosis: `${growthEngine.categoryName}同时具备销售贡献和月累计增长信号，可进入内容与商品供给的优先验证；月末口径和利润闸门未确认前不能据此加预算。`,
      evidence: [
        `销售占比 ${formatSignedRate(growthEngine.revenueShare, false)}`,
        `月累计对比 ${formatSignedRate(growthEngine.revenueGrowth)}（月末口径待核验）`,
        `转化 ${formatSignedRate(growthEngine.paymentConversionRate, false)}`
      ],
      actions: [
        "保留主推商品的流量入口，先核验转化、退款和贡献利润，再申请测试预算。",
        "将高成交卖点沉淀成模板，用于同类商品标题、首图和详情页。",
        "补充同价位或套装商品，用受控测试验证组合承接与客单变化。"
      ],
      expectedImpact: "目标是先稳住销售基本盘，再通过同场景商品扩展带动客单。"
    });
  }

  if (repair) {
    cards.push({
      id: "repair-conversion",
      priority: "P1",
      model: "价值链模型",
      title: `修复 ${repair.categoryName} 的流量承接`,
      target: repair.categoryName,
      diagnosis: `${repair.categoryName}已具备一定流量或增长，但成交效率偏低，直接扩投会拉低整体 ROI。`,
      evidence: [
        weakestValueChain ? `价值链最低项：${weakestValueChain.label} ${weakestValueChain.score} 分` : "",
        `访客占比 ${formatSignedRate(repair.visitorShare, false)}`,
        `转化 ${formatSignedRate(repair.paymentConversionRate, false)}`,
        `机会 ${Math.round(repair.opportunityAmount).toLocaleString("zh-CN")}`
      ].filter(Boolean),
      actions: [
        "先做首图/标题/价格利益点 A/B 测试，验证转化提升后再加流量。",
        "检查低转化流量来源，剔除弱意图词和不匹配人群。",
        "用评价、安装、售后保障降低决策阻力。"
      ],
      expectedImpact: "目标是把已有流量转成净销售，减少无效放量。"
    });
  }

  if (highRefund && highRefund.refundRate >= 0.08) {
    cards.push({
      id: "refund-control",
      priority: highRefund.refundRate >= 0.14 ? "P1" : "P2",
      model: "价值链 / 利润漏损",
      title: `治理 ${highRefund.categoryName} 的退款漏损`,
      target: highRefund.categoryName,
      diagnosis: `${highRefund.categoryName}退款率高于健康区间，销售增长会同步放大利润漏损。`,
      evidence: [
        `退款率 ${formatSignedRate(highRefund.refundRate, false)}`,
        `净销售 ${Math.round(highRefund.netSales).toLocaleString("zh-CN")}`,
        `退款额 ${Math.round(highRefund.paymentAmount * highRefund.refundRate).toLocaleString("zh-CN")}`
      ],
      actions: [
        "拆解退款原因：发货、安装、预期不符、质量、价格保护分别看。",
        "在详情页提前暴露安装条件、尺寸、服务范围，降低预期偏差。",
        "对高退款商品先控量，待退款率回落后再恢复投放。"
      ],
      expectedImpact: "目标是提升净销售质量，而不是只提升支付金额。"
    });
  }

  if (decliningCore) {
    cards.push({
      id: "defend-core",
      priority: "P2",
      model: "类目经营分组 / 效率守成",
      title: `守住 ${decliningCore.categoryName} 的规模效率`,
      target: decliningCore.categoryName,
      diagnosis: `${decliningCore.categoryName}仍是重要销售来源，但增长转弱，需要复用已验证的经营动作、控制无效消耗并防止份额流失。`,
      evidence: [
        `销售占比 ${formatSignedRate(decliningCore.revenueShare, false)}`,
        `月累计对比 ${formatSignedRate(decliningCore.revenueGrowth)}（月末口径待核验）`,
        `客单 ${Math.round(decliningCore.customerUnitPrice).toLocaleString("zh-CN")}`
      ],
      actions: [
        "复盘历史高转化素材和价格机制，保留确定性动作。",
        "用组合购、加价购和售后服务提升单客价值。",
        "减少低毛利/低转化 SKU 的运营消耗。"
      ],
      expectedImpact: "目标是在销售承压时保持利润和运营效率。"
    });
  }

  if (topSearch || topAttribute) {
    cards.push({
      id: "market-context",
      priority: "P3",
      model: "市场方向雷达",
      title: input.market.samePeriod ? "把同期大盘信号转成选品和内容方向" : "历史大盘信号仅作方向假设",
      target: input.market.samePeriod ? "同期市场趋势" : "非同期外部方向",
      diagnosis: input.market.samePeriod
        ? "本店与市场月份一致，可把类目大盘信号用于价格带、卖点属性和搜索需求的方向判断。"
        : `本店与市场月份不一致，当前只生成待验证的选品/内容假设，不能证明本期市场机会或与本店表现共振。${input.market.periodNote}`,
      evidence: [
        topSearch ? `搜索：${topSearch.category} UV ${Math.round(topSearch.searchUv).toLocaleString("zh-CN")}` : "",
        topAttribute ? `卖点：${topAttribute.attribute}-${topAttribute.value}` : "",
        input.market.latest ? `市场销售占比 ${formatSignedRate(input.market.latest.salesShare, false)}` : "",
        input.market.samePeriod ? "" : input.market.periodNote
      ].filter(Boolean),
      actions: [
        "把高 UV 搜索分类拆成标题词包、内容结构和投放词包。",
        "把高销售指数属性转成卖点库，后续与本店商品属性做匹配。",
        input.market.samePeriod
          ? "接入更多类目的总量占比后，再输出多类目份额差距和攻守优先级。"
          : `先补 ${input.summary.latestStoreMonth || "本店同期"} 市场表，再判断当期机会、份额差距和攻守优先级。`
      ],
      expectedImpact: input.market.samePeriod
        ? "目标是建立同期外部机会雷达，避免只看店内历史数据。"
        : "仅用于形成小样本验证清单，不作为当期预算放量依据。"
    });
  }

  if (weakestValueChain?.status === "bad" && !cards.some((card) => card.evidence.some((line) => line.includes(`价值链最低项：${weakestValueChain.label}`)))) {
    cards.unshift({
      id: `value-chain-${weakestValueChain.key}`,
      priority: "P1",
      model: "价值链模型",
      title: `优先验证 ${weakestValueChain.label} 短板`,
      target: weakestValueChain.label,
      diagnosis: `${weakestValueChain.label}是当前有数值证据链路中的最低项；该分数仅用于本店链路排序，不代表行业绝对水平。`,
      evidence: [`价值链最低项：${weakestValueChain.label} ${weakestValueChain.score} 分`, weakestValueChain.evidence],
      actions: [weakestValueChain.action, "设定单一验证指标和复盘日期，验证改善后再扩大动作范围。"],
      expectedImpact: "先修复最弱链路，避免上游放量继续放大下游损耗。"
    });
  }

  return cards.slice(0, 5);
}

function buildMarketOpportunities(input: {
  summary: BusinessKpiSummary;
  categories: BusinessCategorySummary[];
  market: BusinessMarketContext;
}): BusinessMarketOpportunity[] {
  const topPrice = input.market.topPriceBands[0];
  const supplyEfficiencies = input.market.topPriceBands.map((item) => ({
    item,
    // 供给指数通常跨多个数量级，用 log1p 降低极端值支配排序的风险。
    value: item.marketShare / Math.log1p(Math.max(item.supplyIndex, 0))
  }));
  const efficientPriceEntry = [...supplyEfficiencies].sort((left, right) => right.value - left.value)[0];
  const efficientPrice = efficientPriceEntry?.item;
  const highIntentSearch = [...input.market.topSearchSignals].sort(
    (left, right) => right.searchUv * right.conversionRate - left.searchUv * left.conversionRate
  )[0];
  const highGrowthSearch = [...input.market.topSearchSignals].sort(
    (left, right) => right.searchUv * Math.max(right.avgGrowthRate, 0) - left.searchUv * Math.max(left.avgGrowthRate, 0)
  )[0];
  const growthEngine = input.categories.find((item) => item.quadrant === "增长引擎");
  const latestMarket = input.market.latest;
  const marketMomentum = input.summary.marketSalesShareChange;
  const evidenceLevel: BusinessEvidenceLevel = input.market.samePeriod ? "observed" : "directional";
  const requiredData = input.market.samePeriod
    ? []
    : [`${input.summary.latestStoreMonth || "本店同期"} 市场概况、价格带、属性与搜索表`];
  const boundaryEvidence = input.market.samePeriod ? [] : [input.market.periodNote];
  const boundedOpportunityScore = (rawScore: number) => input.market.samePeriod ? rawScore : Math.min(rawScore, 59);
  const opportunities: BusinessMarketOpportunity[] = [];

  if (topPrice) {
    const score = boundedOpportunityScore(clamp(Math.round(50 + topPrice.marketShare * 210 + Math.max(topPrice.yoy, 0) * 35), 0, 100));
    opportunities.push({
      id: "price-band-mainstream",
      title: `${topPrice.priceBand} 主流价格带`,
      model: "价格带方向信号",
      score,
      status: statusFromScore(score),
      diagnosis: input.market.samePeriod
        ? "主流价格带占比高，可作为同期大盘方向，但需要避免只跟随低价竞争。"
        : "非同期市场数据只支持“主流价格带”方向假设，不能证明本期店铺存在对应机会。",
      evidence: [
        `市场占比 ${formatSignedRate(topPrice.marketShare, false)}`,
        `同比 ${formatSignedRate(topPrice.yoy)}`,
        `供给指数 ${Math.round(topPrice.supplyIndex).toLocaleString("zh-CN")}`,
        ...boundaryEvidence
      ],
      evidenceLevel,
      requiredData,
      action: "把主推款、套装款和利润款放进不同价格锚点，形成可比较的价格梯度。"
    });
  }

  if (efficientPrice && efficientPrice.priceBand !== topPrice?.priceBand) {
    const efficiencyPercentile = percentileRank(
      supplyEfficiencies.map((entry) => entry.value),
      efficientPriceEntry.value
    );
    const score = boundedOpportunityScore(clamp(Math.round(
      45 + efficiencyPercentile * 35 + Math.min(Math.max(efficientPrice.yoy, 0), 1) * 20
    ), 0, 100));
    opportunities.push({
      id: "price-band-efficient",
      title: `${efficientPrice.priceBand} 供需效率带`,
      model: "供需效率方向信号",
      score,
      status: statusFromScore(score),
      diagnosis: input.market.samePeriod
        ? "该价格带的市场占比相对供给更有效，可做利润款或差异化套装测试。"
        : "该供需效率来自非同期市场表，只能进入小样本假设池，不能作为本期利润款结论。",
      evidence: [
        `市场占比 ${formatSignedRate(efficientPrice.marketShare, false)}`,
        `同比 ${formatSignedRate(efficientPrice.yoy)}`,
        `供给指数 ${Math.round(efficientPrice.supplyIndex).toLocaleString("zh-CN")}`,
        `供需效率相对分位 ${formatSignedRate(efficiencyPercentile, false)}`,
        ...boundaryEvidence
      ],
      evidenceLevel,
      requiredData,
      action: "用小批量商品验证转化和退款，再决定是否扩展供给。"
    });
  }

  if (highIntentSearch) {
    const score = boundedOpportunityScore(clamp(Math.round(highIntentSearch.clickRate * 46 + highIntentSearch.conversionRate * 980 + 24), 0, 100));
    opportunities.push({
      id: "search-high-intent",
      title: `${highIntentSearch.category} 搜索承接`,
      model: "搜索漏斗 / 价值链",
      score,
      status: statusFromScore(score),
      diagnosis: input.market.samePeriod
        ? "高 UV 且具备成交率的搜索分类，可优先沉淀成标题词包、内容结构和投放人群。"
        : "搜索信号与本店月份不一致，只能用于形成待验证词包，不能证明本期人群机会。",
      evidence: [
        `搜索 UV ${Math.round(highIntentSearch.searchUv).toLocaleString("zh-CN")}`,
        `点击率 ${formatSignedRate(highIntentSearch.clickRate, false)}`,
        `成交率 ${formatSignedRate(highIntentSearch.conversionRate, false)}`,
        ...boundaryEvidence
      ],
      evidenceLevel,
      requiredData,
      action: "围绕该搜索分类拆词，建立主图卖点、详情问答和投放关键词的同一套表达。"
    });
  }

  if (highGrowthSearch && highGrowthSearch.category !== highIntentSearch?.category) {
    const score = boundedOpportunityScore(clamp(Math.round(48 + Math.log10(Math.max(highGrowthSearch.searchUv, 10)) * 5 + highGrowthSearch.avgGrowthRate * 8), 0, 100));
    opportunities.push({
      id: "search-growth",
      title: `${highGrowthSearch.category} 增长搜索`,
      model: "搜索需求方向信号",
      score,
      status: statusFromScore(score),
      diagnosis: input.market.samePeriod
        ? "搜索增长明显，可作为消费者关注点迁移的同期方向信号。"
        : "搜索增长来自非同期市场表，只能作为消费者关注点迁移假设，需同期数据验证。",
      evidence: [
        `搜索 UV ${Math.round(highGrowthSearch.searchUv).toLocaleString("zh-CN")}`,
        `平均增长 ${formatSignedRate(highGrowthSearch.avgGrowthRate)}`,
        `点击率 ${formatSignedRate(highGrowthSearch.clickRate, false)}`,
        ...boundaryEvidence
      ],
      evidenceLevel,
      requiredData,
      action: "先做内容页和低预算词包测试，观察点击成本、收藏加购和支付承接。"
    });
  }

  if (growthEngine && latestMarket && input.market.samePeriod && marketMomentum !== null && growthEngine.revenueGrowth !== null) {
    const score = clamp(Math.round(58 + growthEngine.revenueShare * 28 + marketMomentum * 150), 0, 100);
    opportunities.push({
      id: "store-market-fit",
      title: `${growthEngine.categoryName} 与大盘共振`,
      model: "店市同期观察",
      score,
      status: statusFromScore(score),
      diagnosis: "本店增长引擎和大盘热度同时存在，适合先做份额守攻，再接后续多类目份额模型。",
      evidence: [
        `本店销售占比 ${formatSignedRate(growthEngine.revenueShare, false)}`,
        `本店月累计对比 ${formatSignedRate(growthEngine.revenueGrowth)}（月末口径待核验）`,
        `大盘热度 ${formatSignedRate(latestMarket.salesShare, false)}`
      ],
      evidenceLevel: "observed",
      requiredData: [],
      action: "围绕增长引擎候选建立内容、价格和售后治理的周度验证节奏；预算仍由经营网络闸门审批。"
    });
  }

  return opportunities.sort((left, right) => right.score - left.score).slice(0, 5);
}

function buildActionReviewLoops(input: {
  categories: BusinessCategorySummary[];
  valueChain: BusinessValueChainStage[];
  marketOpportunities: BusinessMarketOpportunity[];
  strategyCards: BusinessStrategyCard[];
}): BusinessActionReviewLoop[] {
  const growthEngine = input.categories.find((item) => item.quadrant === "增长引擎");
  const highRefund = [...input.categories].sort((left, right) => right.refundRate - left.refundRate)[0];
  const weakStage = input.valueChain
    .filter((stage): stage is BusinessValueChainStage & { score: number } => stage.score !== null)
    .sort((left, right) => left.score - right.score)[0];
  const marketOpportunity = input.marketOpportunities[0];
  const loops: BusinessActionReviewLoop[] = [
    {
      id: "review-growth-engine",
      title: "增长引擎候选验证复盘",
      owner: "商品运营",
      beforeMetric: growthEngine ? `${growthEngine.categoryName} 销售占比 ${formatSignedRate(growthEngine.revenueShare, false)}` : "增长引擎待确认",
      afterTarget: "销售占比稳定且退款率不升高",
      cadence: "每周",
      closedLoop: ["记录投放/内容/价格动作", "对比支付额、转化、退款率", "保留有效动作并淘汰无效 SKU"]
    },
    {
      id: "review-refund",
      title: "退款漏损治理复盘",
      owner: "客服/履约",
      beforeMetric: highRefund ? `${highRefund.categoryName} 退款率 ${formatSignedRate(highRefund.refundRate, false)}` : "退款原因待归类",
      afterTarget: "退款率下降，净销售不低于治理前",
      cadence: "每周",
      closedLoop: ["标注退款原因", "区分商品/安装/物流/预期问题", "回写到详情页和客服话术"]
    },
    {
      id: "review-market-test",
      title: "市场机会测试复盘",
      owner: "投放/内容",
      beforeMetric: marketOpportunity ? `${marketOpportunity.title} 评分 ${marketOpportunity.score}` : "市场机会待排序",
      afterTarget: "点击、收藏加购、成交至少一项提升",
      cadence: "两周",
      closedLoop: ["设计一组价格带/搜索词/卖点测试", "记录测试样本和预算", "形成可复制的内容与投放模板"]
    },
    {
      id: "review-weak-chain",
      title: "价值链短板复盘",
      owner: "经营负责人",
      beforeMetric: weakStage ? `${weakStage.label} ${weakStage.score} 分` : "短板待识别",
      afterTarget: "最低链路分提升 10 分",
      cadence: "月度",
      closedLoop: ["定位最低分环节", "拆到商品/人群/渠道", "复盘动作前后指标变化"]
    }
  ];
  return loops.filter((loop) => input.strategyCards.length > 0 || loop.id !== "review-growth-engine");
}

function buildPestSignals(input: {
  summary: BusinessKpiSummary;
  market: BusinessMarketContext;
}): BusinessPestSignal[] {
  const latest = input.market.latest;
  const topSearch = input.market.topSearchSignals[0];
  const topAttribute = input.market.topAttributeSignals[0];

  return [
    {
      dimension: "政策 P",
      score: null,
      status: "warn",
      available: false,
      evidence: `当前只有退款率等经营结果，没有政策、平台规则或监管变更输入；退款率 ${formatSignedRate(input.summary.refundRate, false)} 不能证明政策环境健康。`,
      implication: "仅能提出待核实假设，不能给政策维度打健康分或输出绿色结论。",
      requiredData: ["适用监管政策及变更日期", "平台规则/消费者保障规则及处罚记录", "售后、质量与安装合规清单"]
    },
    {
      dimension: "经济 E",
      score: null,
      status: "warn",
      available: false,
      evidence: latest
        ? `市场 ${latest.month} 件单价同比 ${formatSignedRate(latest.unitPriceYoY)}，市场销售占比较相邻月份 ${formatSignedRate(input.summary.marketSalesShareChange)}；${input.market.periodNote}`
        : "暂无市场价格和需求趋势，经济维度证据不足。",
      implication: latest
        ? "该市场信号只用于提示待核实方向，不代表宏观经济全貌，也不能跨期归因本店表现。"
        : "补充同期市场与宏观输入后再判断价格和需求压力。",
      requiredData: ["消费、收入、价格与成本环境的直接资料", "资料来源、发布日期与适用市场范围"]
    },
    {
      dimension: "社会 S",
      score: null,
      status: "warn",
      available: false,
      evidence: topSearch
        ? `${topSearch.category} 搜索 UV ${Math.round(topSearch.searchUv).toLocaleString("zh-CN")}，点击率 ${formatSignedRate(topSearch.clickRate, false)}。`
        : "暂无消费者搜索、调研或趋势输入，社会维度证据不足。",
      implication: topSearch
        ? "当前只支持搜索需求代理判断，仍需消费者调研验证动机与偏好。"
        : "补充消费者需求输入后再形成社会趋势假设。",
      requiredData: ["消费者调研/访谈", "人群偏好与场景变化", "资料时间与适用人群"]
    },
    {
      dimension: "技术 T",
      score: null,
      status: "warn",
      available: false,
      evidence: topAttribute
        ? `${topAttribute.attribute}-${topAttribute.value} 销售指数 ${Math.round(topAttribute.salesIndex).toLocaleString("zh-CN")}。`
        : "暂无产品技术、专利、研发或技术替代输入，技术维度证据不足。",
      implication: topAttribute
        ? "属性销售指数仅是市场接受度代理，不等同技术领先或技术环境健康。"
        : "补充技术与产品路线输入后再判断技术机会和替代风险。",
      requiredData: ["产品技术路线", "研发/专利资料", "替代技术与渗透趋势", "资料来源与日期"]
    }
  ];
}

function buildPorterForces(input: {
  summary: BusinessKpiSummary;
  categories: BusinessCategorySummary[];
  market: BusinessMarketContext;
}): BusinessPorterForce[] {
  const latest = input.market.latest;
  const maxSupply = Math.max(...input.market.trend.map((item) => item.supplyIndex), 1);
  const topPrice = input.market.topPriceBands[0];
  const supplyDensity = latest ? ratio(latest.supplyIndex, maxSupply) : null;
  const topPriceShare = topPrice?.marketShare ?? null;
  const lowPrice = input.market.topPriceBands.find((item) => item.priceBand.startsWith("0-"));
  const specSearch = input.market.topSearchSignals.find((item) => ["规格", "款式", "型号"].includes(item.category));
  const topSearchUv = input.market.topSearchSignals[0]?.searchUv;
  const concentration = input.categories[0]?.revenueShare;
  const force = (
    name: BusinessPorterForce["force"],
    _directionalProxy: number | null,
    evidence: string,
    action: string,
    requiredData: string[]
  ): BusinessPorterForce => ({
    force: name,
    intensity: null,
    available: false,
    evidenceLevel: "insufficient",
    status: "warn",
    evidence: `${evidence} 当前方向代理不满足波特五力的直接证据门槛，因此不输出强度分。`,
    action,
    requiredData
  });

  return [
    force(
      "行业竞争",
      latest && supplyDensity !== null && topPriceShare !== null
        ? clamp(Math.round(42 + supplyDensity * 42 + topPriceShare * 60), 0, 100)
        : null,
      latest && topPrice
        ? `市场供给指数 ${Math.round(latest.supplyIndex).toLocaleString("zh-CN")}，主流价格带占比 ${formatSignedRate(topPrice.marketShare, false)}；仅为竞争代理，不是竞店份额。`
        : "缺少市场供给与价格带数据，不能计算行业竞争代理强度。",
      "补竞店数量、份额、价格与投放数据后，再决定差异化策略。",
      ["同类竞店数量与销售份额", "竞品价格、促销、投放与服务对比"]
    ),
    force(
      "买方议价",
      latest && topPriceShare !== null
        ? clamp(Math.round(52 + Math.max(-latest.unitPriceYoY, 0) * 120 + (1 - topPriceShare) * 18), 0, 100)
        : null,
      latest && topPriceShare !== null
        ? `件单价同比 ${formatSignedRate(latest.unitPriceYoY)}，主流价格带占比 ${formatSignedRate(topPriceShare, false)}；仅反映价格代理。`
        : "缺少件单价趋势或价格带数据，不能计算买方议价代理强度。",
      "用调研与转化实验验证消费者对价格、服务和套装权益的敏感度。",
      ["消费者价格敏感度调研", "优惠/服务 A/B 测试", "询单与流失原因"]
    ),
    force(
      "供方压力",
      latest
        ? clamp(Math.round(44 + Math.max(-latest.supplyYoY, 0) * 160), 0, 100)
        : null,
      latest
        ? `市场供给同比 ${formatSignedRate(latest.supplyYoY)}；只能作为供给压力代理，不能证明供应商议价权。`
        : "缺少市场供给趋势，且没有供应商合同与成本输入，供方压力不可评分。",
      "补供应商集中度、采购价、交期与替代供应数据后再做采购安排。",
      ["供应商集中度与可替代性", "采购成本、账期、交期与缺货记录"]
    ),
    force(
      "替代威胁",
      specSearch && topSearchUv
        ? clamp(Math.round(46 + ratio(specSearch.searchUv, topSearchUv) * 42), 0, 100)
        : null,
      specSearch
        ? `${specSearch.category} 搜索 UV ${Math.round(specSearch.searchUv).toLocaleString("zh-CN")}；只说明比较需求，不能识别具体替代品。`
        : "暂无可识别的规格/款式/型号比较搜索，不能把缺失信号当作低替代威胁。",
      "补替代品清单、用户切换原因与流失路径，再设计对比表达。",
      ["替代品清单及价格/功能对比", "用户流失、搜索跳转与访谈数据"]
    ),
    force(
      "新进入者",
      latest && input.market.topPriceBands.length > 0
        ? clamp(
            Math.round(
              38 + (lowPrice?.marketShare ?? 0) * 180 +
              Math.max(input.summary.marketSalesShareChange ?? 0, 0) * 120 +
              (concentration ?? 0) * 10
            ),
            0,
            100
          )
        : null,
      latest && input.market.topPriceBands.length > 0
        ? `低价带占比 ${lowPrice ? formatSignedRate(lowPrice.marketShare, false) : "未单列"}，市场热度变化 ${formatSignedRate(input.summary.marketSalesShareChange)}；仅为进入压力代理。`
        : "缺少市场趋势或价格带结构，不能计算新进入压力代理强度。",
      "补新增商家、上新速度、份额迁移与进入成本后，再判断进入壁垒。",
      ["新增商家/品牌数量与上新速度", "份额迁移、流量成本与渠道准入门槛"]
    )
  ];
}

function buildSevenSReadiness(input: {
  summary: BusinessKpiSummary;
  categories: BusinessCategorySummary[];
  valueChain: BusinessValueChainStage[];
  strategyCards: BusinessStrategyCard[];
  marketOpportunities: BusinessMarketOpportunity[];
}): BusinessSevenSItem[] {
  const growthEngineCount = input.categories.filter((category) => category.quadrant === "增长引擎").length;
  const weakChainCount = input.valueChain.filter((stage) => stage.score !== null && stage.status !== "good").length;
  const p1Count = input.strategyCards.filter((card) => card.priority === "P1").length;
  const common = {
    score: null,
    status: "warn" as const,
    available: false
  };
  return [
    {
      ...common,
      dimension: "Strategy",
      label: "战略",
      evidence: `经营数据识别出 ${growthEngineCount} 个增长引擎，但未提供战略目标、取舍和资源承诺，不能据此评价战略健康度。`,
      action: "访谈经营负责人，核验增长引擎、利润守成和收缩观察的资源边界。",
      requiredData: ["年度/季度战略目标", "业务取舍与资源配置", "管理层访谈"]
    },
    {
      ...common,
      dimension: "Structure",
      label: "结构",
      evidence: "品类销售结构不等同组织结构；当前没有组织图、岗位边界和协作关系输入。",
      action: "补充组织图和跨职能协作机制，访谈关键岗位后再判断结构是否匹配战略。",
      requiredData: ["组织架构图", "岗位职责/RACI", "跨部门协作与升级机制"]
    },
    {
      ...common,
      dimension: "Systems",
      label: "系统",
      evidence: `${weakChainCount} 个经营链路环节需要关注，但结果指标不能证明流程、制度和数据系统成熟度。`,
      action: "盘点经营例会、预算、投放、商品、客服和复盘流程及其实际执行证据。",
      requiredData: ["关键流程/SOP", "经营例会与复盘记录", "预算审批、数据系统和执行留痕"]
    },
    {
      ...common,
      dimension: "Shared Values",
      label: "共识",
      evidence: `${p1Count} 张 P1 策略卡和净销售结果只能提出“指标是否一致”的假设，不能证明团队价值观与共识。`,
      action: "通过管理层与一线访谈，核验真实决策标准、冲突处理和共同目标。",
      requiredData: ["使命/价值观及行为定义", "管理层与一线访谈", "目标冲突和决策案例"]
    },
    {
      ...common,
      dimension: "Skills",
      label: "能力",
      evidence: `支付转化 ${formatSignedRate(input.summary.paymentConversionRate, false)} 是经营结果，不能单独证明团队具备搜索、商品、投放或内容能力。`,
      action: "建立能力矩阵并用项目案例、质量标准和产出结果逐项验证。",
      requiredData: ["岗位能力矩阵", "项目/作品与质量评审", "培训、认证和绩效记录"]
    },
    {
      ...common,
      dimension: "Staff",
      label: "人员",
      evidence: `${input.strategyCards.length} 张策略卡只说明待办可拆解，未提供编制、胜任度、负荷、流失和激励信息，人员维度不可评分。`,
      action: "访谈负责人并核对编制、能力、负荷、绩效和关键岗位风险，再形成 Staff 判断。",
      requiredData: ["人员编制与岗位清单", "胜任度/绩效与工作负荷", "招聘、流失、激励和关键岗位风险", "负责人访谈"]
    },
    {
      ...common,
      dimension: "Style",
      label: "风格",
      evidence: `月累计销售对比 ${formatSignedRate(input.summary.revenueGrowth)}（月末口径待核验）、退款率 ${formatSignedRate(input.summary.refundRate, false)} 不能证明领导风格、授权方式或复盘文化。`,
      action: "通过会议观察、决策案例和团队访谈判断领导风格，当前只保留“小步测试/复盘纪律”的待验证假设。",
      requiredData: ["管理会议与决策记录", "授权、容错和复盘机制", "管理层/团队匿名访谈"]
    }
  ];
}

function buildBusinessRoadmap(input: {
  summary: BusinessKpiSummary;
  categories: BusinessCategorySummary[];
  marketOpportunities: BusinessMarketOpportunity[];
  valueChain: BusinessValueChainStage[];
}): BusinessRoadmapStep[] {
  const growthEngine = input.categories.find((category) => category.quadrant === "增长引擎");
  const highRefund = [...input.categories].sort((left, right) => right.refundRate - left.refundRate)[0];
  const topOpportunity = input.marketOpportunities[0];
  const weakestChain = input.valueChain
    .filter((stage): stage is BusinessValueChainStage & { score: number } => stage.score !== null)
    .sort((left, right) => left.score - right.score)[0];
  return [
    {
      step: 1,
      title: "统一诊断口径",
      horizon: "本周",
      owner: "经营负责人",
      priority: "P1",
      action: "确认类目大盘、本店品类、退款和净销售口径，先固定复盘模板。",
      metric: "所有模块同一统计周期"
    },
    {
      step: 2,
      title: "排序市场机会",
      horizon: "本周",
      owner: "商品/投放",
      priority: topOpportunity?.evidenceLevel === "observed" ? "P1" : "P2",
      action: topOpportunity
        ? `${topOpportunity.evidenceLevel === "observed" ? "进入同期观察验证" : "仅作方向假设并小样本验证"}“${topOpportunity.title}”，把价格带、搜索词和卖点放到同一测试包。`
        : "补充市场机会数据后排序。",
      metric: topOpportunity?.evidenceLevel === "observed" ? "同期方向 Top3 完成测试方案" : "补齐同期市场表并完成小样本验证"
    },
    {
      step: 3,
      title: "验证主力增长候选",
      horizon: "1-2 周",
      owner: "商品运营",
      priority: "P1",
      action: growthEngine
        ? `围绕 ${growthEngine.categoryName} 固化主推 SKU 和内容模板，先核验利润、退款与测试闸门，不在类目分组模型内直接确定预算。`
        : "先找到具备规模与效率信号的候选类目，再设计受控验证。",
      metric: "候选类目净销售、转化率与贡献利润"
    },
    {
      step: 4,
      title: "治理利润漏损",
      horizon: "1-2 周",
      owner: "客服/履约",
      priority: highRefund && highRefund.refundRate >= 0.12 ? "P1" : "P2",
      action: highRefund ? `拆解 ${highRefund.categoryName} 退款原因，先控高退款 SKU。` : "建立退款原因分类。",
      metric: "退款率与净销售额"
    },
    {
      step: 5,
      title: "修复最弱链路",
      horizon: "2-3 周",
      owner: "运营/投放",
      priority: weakestChain?.status === "bad" ? "P1" : "P2",
      action: weakestChain ? `优先处理“${weakestChain.label}”：${weakestChain.action}` : "补充链路指标。",
      metric: "价值链最低分提升 10 分"
    },
    {
      step: 6,
      title: "建立执行与复盘节奏",
      horizon: "3-4 周",
      owner: "管理者",
      priority: "P2",
      action: "为每个已准入动作明确负责人、前置依赖、验证指标和停止条件；7S 未完成组织访谈前不参与经营动作排序。",
      metric: "动作按期复盘率与证据闭环率"
    },
    {
      step: 7,
      title: "扩展多类目份额",
      horizon: "下一批数据",
      owner: "数据/商品",
      priority: "P3",
      action: "接入更多类目的总量占比，输出本店份额差距、攻守优先级和资源分配。",
      metric: "类目覆盖率与份额差距"
    },
    {
      step: 8,
      title: "复盘迭代模型",
      horizon: "月度",
      owner: "经营负责人",
      priority: "P3",
      action: "把策略动作回写到看板，按支付额、净销售、退款率、转化率四项复盘。",
      metric: input.summary.revenueGrowth === null
        ? "补齐相邻月份并核验两期月末累计口径后再设变化目标"
        : `月末口径核验后，再设置下期净销售目标（当前月累计变化 ${formatSignedRate(input.summary.revenueGrowth)}）`
    }
  ];
}

function buildNpsReputation(input: {
  summary: BusinessKpiSummary;
  categories: BusinessCategorySummary[];
  valueChain: BusinessValueChainStage[];
}): BusinessNpsReputation {
  const highRefund = [...input.categories].sort((left, right) => right.refundRate - left.refundRate)[0];
  const conversionStage = input.valueChain.find((stage) => stage.key === "conversion");
  const refundStage = input.valueChain.find((stage) => stage.key === "refund");
  return {
    score: null,
    available: false,
    status: "warn",
    detractorRisk: highRefund
      ? `${highRefund.categoryName} 退款率 ${formatSignedRate(highRefund.refundRate, false)}，可能形成差评和售后传播风险。`
      : input.summary.storeDataAvailable
        ? "当前叶子类目未出现明显高退款信号，但仍需售后原因与问卷验证。"
        : "未上传本店类目及售后数据，不能判断售后负反馈风险。",
    promoterLever: input.summary.storeTotalAvailable && conversionStage !== undefined && conversionStage.score !== null && conversionStage.score >= 48
      ? "成交承接仍有基础，可通过服务承诺、安装体验和评价运营提升推荐意愿。"
      : input.summary.storeTotalAvailable
        ? "转化承接偏弱，需先改善购买体验再推动推荐。"
        : "全店转化与退款证据待补，当前不生成口碑风险代理分。",
    signals: [
      input.summary.storeTotalAvailable ? `退款率 ${formatSignedRate(input.summary.refundRate, false)}` : "全店退款率待可靠汇总行",
      input.summary.storeTotalAvailable ? `支付转化 ${formatSignedRate(input.summary.paymentConversionRate, false)}` : "全店支付转化待可靠汇总行",
      refundStage !== undefined && refundStage.score !== null ? `退款链路 ${refundStage.score} 分` : "",
      highRefund ? `${highRefund.categoryName} 净销售 ${Math.round(highRefund.netSales).toLocaleString("zh-CN")}` : ""
    ].filter(Boolean),
    actions: [
      "建立 NPS 简版问卷：购买原因、阻碍点、安装/物流体验、是否愿意推荐。",
      "把低分反馈绑定到商品、客服、物流、安装、价格保护五类原因。",
      "将高分用户评价转成首图、详情页和客服话术中的信任素材。"
    ],
    requiredData: ["0–10 分推荐意愿问卷", "推荐者/中立者/贬损者样本量", "问卷时间、商品与订单关联"]
  };
}

function buildQuestionnaire(input: {
  summary: BusinessKpiSummary;
  categories: BusinessCategorySummary[];
  market: BusinessMarketContext;
  npsReputation: BusinessNpsReputation;
  sevenS: BusinessSevenSItem[];
}): BusinessQuestionnaireItem[] {
  const topCategory = input.categories[0];
  const weakS = input.sevenS
    .filter((item): item is BusinessSevenSItem & { score: number } => item.available && item.score !== null)
    .sort((left, right) => left.score - right.score)[0];
  const topSearch = input.market.topSearchSignals[0];
  return [
    {
      id: "q-category-focus",
      dimension: "经营策略",
      question: "本月资源是否已经优先投向增长引擎类目？",
      defaultAnswer: topCategory ? `当前头部类目为 ${topCategory.categoryName}` : "暂未识别",
      evidence: topCategory ? `销售占比 ${formatSignedRate(topCategory.revenueShare, false)}` : "暂无类目数据",
      options: ["已经集中资源", "部分集中但缺负责人", "仍按平均资源分配"]
    },
    {
      id: "q-market-fit",
      dimension: "市场机会",
      question: "价格带、卖点属性和搜索词是否已经转成商品/内容测试？",
      defaultAnswer: topSearch ? `优先搜索分类：${topSearch.category}` : "暂无搜索信号",
      evidence: topSearch ? `搜索 UV ${Math.round(topSearch.searchUv).toLocaleString("zh-CN")}` : "暂无搜索数据",
      options: ["已形成测试包", "只有方向还未测试", "暂未使用市场数据"]
    },
    {
      id: "q-review-loop",
      dimension: "动作闭环",
      question: "每个策略动作是否记录了动作前指标、动作后目标和复盘周期？",
      defaultAnswer: "系统已生成动作前后复盘模板",
      evidence: `月累计销售对比 ${formatSignedRate(input.summary.revenueGrowth)}（月末口径待核验），退款率 ${formatSignedRate(input.summary.refundRate, false)}`,
      options: ["完整记录", "记录了部分动作", "尚未建立复盘"]
    },
    {
      id: "q-nps",
      dimension: "NPS/口碑",
      question: "是否收集用户推荐意愿和不推荐原因？",
      defaultAnswer: "真实 NPS 待问卷；退款与转化仅作为待调查线索，不计算推荐分。",
      evidence: input.npsReputation.detractorRisk,
      options: ["已收集并归因", "只看评价/退款", "暂未收集"]
    },
    {
      id: "q-organization",
      dimension: "7S 组织",
      question: "当前最弱组织项是否有负责人和改善动作？",
      defaultAnswer: weakS ? `最弱项：${weakS.label}` : "7S 待组织访谈，当前不评分",
      evidence: weakS ? `${weakS.dimension} ${weakS.score} 分` : "需补组织架构、制度、人员与管理风格访谈",
      options: ["已明确负责人", "有动作但无负责人", "暂未处理"]
    }
  ];
}

function buildAiDiagnosisReport(input: {
  summary: BusinessKpiSummary;
  categories: BusinessCategorySummary[];
  market: BusinessMarketContext;
  valueChain: BusinessValueChainStage[];
  strategyCards: BusinessStrategyCard[];
  marketOpportunities: BusinessMarketOpportunity[];
  modelAdmissions: ModelAdmissionDecision[];
}): BusinessAiDiagnosisReport {
  const topCategory = input.categories[0];
  const weakStage = input.valueChain
    .filter((stage): stage is BusinessValueChainStage & { score: number } => stage.score !== null)
    .sort((left, right) => left.score - right.score)[0];
  const topOpportunity = input.marketOpportunities[0];
  const p1Cards = input.strategyCards.filter((card) => card.priority === "P1");
  const lockedModels = input.modelAdmissions.filter(
    (item) => item.portfolio === "conditional" && item.mode === "disabled"
  );
  const lockedData = uniqueText(lockedModels.flatMap((item) => item.requiredData));
  const summary = [
    input.summary.storeTotalAvailable
      ? `当前本店最新支付额 ${Math.round(input.summary.paymentAmount as number).toLocaleString("zh-CN")}，净销售 ${Math.round(input.summary.netSales as number).toLocaleString("zh-CN")}。`
      : input.summary.storeDataAvailable
        ? "已识别叶子类目，但缺少可靠全店汇总行；不合计访客/买家，也不输出全店支付额、转化和净销售结论。"
        : "未上传本店类目表；当前仅能读取市场方向信号，不能输出本店经营结果。",
    topCategory ? `${topCategory.categoryName} 是当前主力类目，销售占比 ${formatSignedRate(topCategory.revenueShare, false)}。` : "",
    topOpportunity
      ? topOpportunity.evidenceLevel === "observed"
        ? `同期市场方向优先观察 ${topOpportunity.title}，仍需店内小测。`
        : `${topOpportunity.title} 仅为非同期方向假设，需补同月表验证。`
      : "",
    lockedModels.length > 0
      ? `${lockedModels.map((item) => item.displayName).join("、")}未满足直接数据条件，不参与本次自动结论。`
      : ""
  ].filter(Boolean).join("");
  return {
    title: "AI 诊断报告草稿",
    summary,
    sections: [
      {
        title: "经营策略判断",
        finding: p1Cards.length > 0 ? `当前存在 ${p1Cards.length} 个 P1 经营动作，需要优先闭环。` : "当前暂无红色优先级动作。",
        recommendation: "先处理增长引擎候选验证、退款漏损和市场机会小测，避免动作过多导致资源分散。",
        evidence: p1Cards.map((card) => card.title).slice(0, 3)
      },
      {
        title: "市场机会判断",
        finding: topOpportunity
          ? topOpportunity.evidenceLevel === "observed"
            ? `${topOpportunity.title} 同期方向分 ${topOpportunity.score}，不代表店铺机会已证实。`
            : `${topOpportunity.title} 为方向性假设（${topOpportunity.score} 分不代表本期机会已证实）。`
          : "市场机会需要更多数据。",
        recommendation: topOpportunity?.evidenceLevel === "observed"
          ? "把价格带、卖点属性、搜索词合并为同一个测试包，观察点击、收藏加购和成交。"
          : "先补同月市场表；补齐前只允许小样本验证，不据此放量。",
        evidence: topOpportunity?.evidence ?? []
      },
      {
        title: "价值链短板",
        finding: weakStage ? `${weakStage.label} 是当前最低分链路，得分 ${weakStage.score}。` : "暂无价值链短板。",
        recommendation: weakStage ? weakStage.action : "继续补充链路数据。",
        evidence: weakStage ? [weakStage.evidence] : []
      },
      {
        title: "模型边界与待补证据",
        finding: lockedModels.length > 0
          ? `${lockedModels.length} 个条件模型保持关闭，系统没有使用经营代理指标补造经典模型分数。`
          : "当前没有待解锁的条件模型。",
        recommendation: lockedData.length > 0
          ? `如确需启用对应模型，先补：${lockedData.slice(0, 8).join("、")}。`
          : "继续按当前已准入模型复盘。",
        evidence: lockedModels.map((item) => `${item.displayName}：未准入`).slice(0, 6)
      }
    ],
    prompt: [
      "请基于以下结构生成经营诊断报告：",
      input.summary.storeTotalAvailable
        ? `1. 总盘：支付额 ${Math.round(input.summary.paymentAmount as number)}，净销售 ${Math.round(input.summary.netSales as number)}，转化 ${formatSignedRate(input.summary.paymentConversionRate, false)}，退款率 ${formatSignedRate(input.summary.refundRate, false)}。${input.summary.comparisonBasisNote}`
        : "1. 总盘：可靠全店汇总缺失，支付额、净销售、全店去重访客/买家、转化与退款率均不得填 0 或推断。",
      `2. 主力类目：${topCategory?.categoryName ?? "暂无"}。`,
      `3. 市场机会：${topOpportunity ? `${topOpportunity.title}（${topOpportunity.evidenceLevel}）` : "暂无"}；${input.market.periodNote}`,
      `4. 最弱链路：${weakStage?.label ?? "暂无"}。`,
      `5. 条件模型：${lockedModels.map((item) => `${item.displayName}=disabled`).join("；") || "无"}。`,
      "输出：关键问题、证据、优先动作、预期指标、复盘周期。"
    ].join("\n")
  };
}

function categoryDiagnosis(
  item: Omit<BusinessCategorySummary, "diagnosis" | "action" | "quadrant" | "opportunityAmount">,
  quadrant: BusinessCategoryQuadrant,
  medianConversion: number
) {
  if (!item.comparisonConclusionAllowed || item.revenueGrowth === null) {
    return item.paymentConversionRate < medianConversion
      ? "缺少可比相邻月份，不能判断增长；当前仅能确认转化低于类目中位，暂按效率修复观察。"
      : "缺少可比相邻月份，不能判断增长或衰退；当前仅按销售规模暂分组，补前月表并核验月末口径后重算。";
  }
  if (quadrant === "增长引擎") {
    return "销售贡献和月累计增长都处在相对高位，可进入优先验证；月末口径、利润与市场可获得性未确认前不能直接放量。";
  }
  if (quadrant === "规模守成") {
    return "仍有规模贡献，但增长放缓，需要守效率和利润。";
  }
  if (quadrant === "潜力新星") {
    return "当前销售占比较小，但增长为正且转化不低于类目中位，适合进入小样本验证池，不能直接按成熟增长引擎放量。";
  }
  if (quadrant === "效率修复") {
    return item.paymentConversionRate < medianConversion
      ? "流量或增长已有信号，但成交转化低于中位，需要先修复承接。"
      : "增长有方向信号但规模较小，适合小步测试后再判断是否具备放量条件。";
  }
  return "销售和增长信号都偏弱，适合控资源、看是否保留长尾角色。";
}

function categoryAction(quadrant: BusinessCategoryQuadrant) {
  const map: Record<BusinessCategoryQuadrant, string> = {
    增长引擎: "进入供给与预算候选，先做受控验证",
    规模守成: "守利润提效率",
    潜力新星: "小样本验证增长质量",
    效率修复: "先修转化再小测",
    收缩观察: "控资源做观察"
  };
  return map[quadrant];
}

function groupByQuadrant(categories: BusinessCategorySummary[]) {
  return BUSINESS_QUADRANTS.reduce(
    (acc, quadrant) => {
      acc[quadrant] = categories.filter((item) => item.quadrant === quadrant);
      return acc;
    },
    {} as Record<BusinessCategoryQuadrant, BusinessCategorySummary[]>
  );
}

function pickStoreTotalRow(rows: CompleteStoreCategoryMonthlyRow[], month: string) {
  const monthRows = rows.filter((row) => row.month === month);
  const candidates = monthRows.filter((row) => isTopAggregateRow(row) && !isOperationalNoise(row.categoryName));
  // 多个一级类目汇总行并不等于全店去重汇总，访客/买家不可跨类目相加，也不能任取第一行。
  return candidates.length === 1 ? candidates[0] : null;
}

function isDiagnosableLeafRow(row: CompleteStoreCategoryMonthlyRow) {
  if (isOperationalNoise(row.categoryName)) return false;
  if (isTopAggregateRow(row)) return false;
  if (row.categoryName === row.level2Category) return false;
  return row.paymentAmount > 0 || row.visitors > 0;
}

function isTopAggregateRow(row: StoreCategoryMonthlyRow) {
  return row.categoryName === row.level1Category && row.categoryName === row.level2Category;
}

function isCompleteStoreCategoryRow(row: StoreCategoryMonthlyRow): row is CompleteStoreCategoryMonthlyRow {
  return allKnownNumbers(row, [
    "visitors", "visitorProducts", "paidProducts", "paymentAmount",
    "paymentConversionRate", "customerUnitPrice", "visitorValue", "refundAmount"
  ]);
}

function isCompleteMarketOverviewRow(row: MarketOverviewRow): row is CompleteMarketOverviewRow {
  return allKnownNumbers(row, [
    "salesShare", "salesYoY", "volumeShare", "volumeYoY", "buyerYoY",
    "unitPrice", "unitPriceYoY", "supplyIndex", "supplyYoY"
  ]);
}

function isCompleteMarketPriceBand(row: MarketPriceBand): row is CompleteMarketPriceBand {
  return allKnownNumbers(row, ["marketShare", "yoy", "supplyIndex"]);
}

function isCompleteMarketAttributeSignal(row: MarketAttributeSignal): row is CompleteMarketAttributeSignal {
  return allKnownNumbers(row, ["salesIndex", "yoy", "supplyIndex"]);
}

function isCompleteMarketSearchSignal(row: MarketSearchSignal): row is CompleteMarketSearchSignal {
  return allKnownNumbers(row, ["searchUv", "avgGrowthRate", "clickRate", "conversionRate"]);
}

function allKnownNumbers<T extends object>(row: T, keys: Array<keyof T>): boolean {
  return keys.every((key) => typeof row[key] === "number" && Number.isFinite(row[key]));
}

function isOperationalNoise(categoryName: string) {
  return categoryName.includes("其他") || categoryName.includes("补差价") || categoryName.includes("邮费");
}

function maxString(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right)).at(-1) ?? "";
}

function previousAdjacentMonth(values: string[], current: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(current);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || month < 1 || month > 12) return "";
  const previousYear = month === 1 ? year - 1 : year;
  const previousMonth = month === 1 ? 12 : month - 1;
  const expected = `${previousYear}-${String(previousMonth).padStart(2, "0")}`;
  return new Set(values.filter(Boolean)).has(expected) ? expected : "";
}

function assessMonthlyComparison(currentMonth: string, previousMonth: string) {
  const current = monthBounds(currentMonth);
  const previous = monthBounds(previousMonth);
  const comparable = Boolean(
    current && previous && previousAdjacentMonth([previousMonth, currentMonth], currentMonth) === previousMonth
  );
  return assessEvidenceWindow({
    asOfDate: currentIsoDate(),
    sides: [previous, current]
      .filter((value): value is { start: string; end: string } => value !== null)
      .map((value) => ({
        ...value,
        // 月度源表的一行代表该自然月聚合，不要求底层逐日明细重复出现。
        observedDays: countInclusiveDays(value.start, value.end),
        sampleSize: 1,
        minimumSampleSize: 1
      })),
    comparable,
    comparisonIssue: !previousMonth
      ? "缺少相邻前月数据"
      : !comparable
        ? "前后月份不相邻"
        : undefined,
    missingFields: current && previous ? [] : ["完整的前后月度窗口"]
  });
}

function assessMonthlyAlignment(storeMonth: string, marketMonth: string) {
  const store = monthBounds(storeMonth);
  const market = monthBounds(marketMonth);
  const comparable = Boolean(store && market && storeMonth === marketMonth);
  const side = store ?? market;
  return assessEvidenceWindow({
    asOfDate: currentIsoDate(),
    sides: side
      ? [{
          ...side,
          observedDays: countInclusiveDays(side.start, side.end),
          sampleSize: 2,
          minimumSampleSize: 2
        }]
      : [],
    comparable,
    comparisonIssue: comparable ? undefined : "本店与市场不是同一月份",
    missingFields: store && market ? [] : ["本店月度或市场月度"]
  });
}

function monthBounds(month: string): { start: string; end: string } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (!Number.isInteger(year) || monthNumber < 1 || monthNumber > 12) return null;
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {
    start: `${month}-01`,
    end: `${month}-${String(lastDay).padStart(2, "0")}`
  };
}

function ratio(numerator: number, denominator: number) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  return numerator / denominator;
}

function comparableGrowth(current: number | null | undefined, previous: number | null | undefined) {
  if (current === null || current === undefined || !Number.isFinite(current) || previous === null || previous === undefined || !Number.isFinite(previous) || previous === 0) {
    return null;
  }
  return (current - previous) / Math.abs(previous);
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function uniqueText(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function average(values: number[]) {
  const finite = values.filter(Number.isFinite);
  return finite.length === 0 ? 0 : sum(finite) / finite.length;
}

function weightedAverage(entries: Array<{ value: number; weight: number }>): number | null {
  const valid = entries.filter((entry) => Number.isFinite(entry.value) && Number.isFinite(entry.weight) && entry.weight > 0);
  const totalWeight = sum(valid.map((entry) => entry.weight));
  return totalWeight > 0
    ? sum(valid.map((entry) => entry.value * entry.weight)) / totalWeight
    : null;
}

function percentileRank(values: number[], target: number): number {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length <= 1) return finite.length === 1 ? 1 : 0;
  const atOrBelow = finite.filter((value) => value <= target).length;
  return clamp((atOrBelow - 1) / (finite.length - 1), 0, 1);
}

function median(values: number[]) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return 0;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function statusFromScore(score: number): BusinessValueChainStatus {
  if (score >= 72) return "good";
  if (score >= 48) return "warn";
  return "bad";
}

function formatSignedRate(value: number | null, withSign = true) {
  if (value === null || !Number.isFinite(value)) return "证据不足";
  const formatted = new Intl.NumberFormat("zh-CN", {
    style: "percent",
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
    signDisplay: withSign ? "always" : "auto"
  }).format(value);
  return formatted.replace("+0.0%", "0.0%");
}
