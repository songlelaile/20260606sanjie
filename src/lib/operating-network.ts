import type { BusinessDiagnosisSnapshot } from "@/lib/business-diagnosis";
import { assessEvidenceWindow } from "@/lib/analysis-evidence";
import { currentIsoDate } from "@/lib/comparison-window";
import { evaluateDiagnosisModels, type ModelAdmissionDecision } from "@/lib/model-admission/evaluate";
import { divideOrNull } from "@/lib/safe-math";
import type {
  AudiencePlanItem,
  BreakthroughDimensionScore,
  DailyTrendPoint,
  ProductBreakthroughResult,
  ProductInvestmentResult
} from "@/lib/types/domain";

export type NetworkFindingStatus = "positive" | "warning" | "critical" | "insufficient";
export type NetworkConfidenceLevel = "high" | "medium" | "low";

export interface NetworkConfidence {
  score: number;
  level: NetworkConfidenceLevel;
  reasons: string[];
}

export interface NetworkFinding {
  id: string;
  title: string;
  conclusion: string;
  status: NetworkFindingStatus;
  proof: string[];
  cannotProve: string[];
  requiredData: string[];
  confidence: NetworkConfidence;
}

export interface NetworkReadiness {
  id: string;
  title: string;
  score: number;
  readyPrefillCount: number;
  totalPrefillCount: number;
  checksPassed: number;
  checksTotal: number;
  requiredSourcesComplete: boolean;
  sourcePeriodsAligned: boolean;
  profitEvidenceCoverage: number | null;
  audienceProductMatchRate: number | null;
  finding: NetworkFinding;
}

export interface OperatingOutcome {
  id: string;
  title: string;
  health: "健康盈利" | "策略性投入" | "有利润但不达标" | "亏损失控" | "无法判断";
  netSales: number | null;
  contributionProfit: number | null;
  marginRate: number | null;
  targetMarginRate: number | null;
  profitBuffer: number | null;
  netSalesTrend: number | null;
  profitTrend: number | null;
  analysisDays: number;
  finding: NetworkFinding;
}

export interface ProfitDriver {
  id: string;
  title: string;
  key: "traffic" | "conversion" | "aov" | "refund" | "grossMargin" | "adSpend" | "unavailable";
  contribution: number;
  contributionRate: number;
  direction: "positive" | "negative" | "neutral";
  finding: NetworkFinding;
}

export interface InvestmentScenario {
  label: "保守" | "基准" | "乐观";
  roi: number | null;
  incrementalPayment: number | null;
  incrementalContribution: number | null;
}

export interface InvestmentSpace {
  id: string;
  title: string;
  economicCeiling: number | null;
  approvedBudget: number | null;
  suggestedTestBudget: number | null;
  reserveBudget: number | null;
  eligibleProductCount: number;
  medianRoiFloor: number | null;
  scenarios: InvestmentScenario[];
  finding: NetworkFinding;
}

export type PotentialPool =
  | "核心潜力池"
  | "效率修复池"
  | "利润修复池"
  | "现金流池"
  | "高风险测试池"
  | "观察退出池";

export interface PotentialProduct {
  id: string;
  productId: string;
  productName: string;
  title: string;
  manualGrade: string;
  pool: PotentialPool;
  efficiencyBadge: "高效率" | "待修复" | "证据不足";
  profitBadge: "健康利润" | "薄利" | "亏损" | "证据不足";
  opportunityBadge: "大机会" | "常规机会" | "小机会" | "待核验";
  opportunityConfidence: "A" | "B" | "C" | "D";
  netSales: number | null;
  historicalGrossProfit: number | null;
  historicalMarginRate: number | null;
  monthlyGsvOpportunity: number;
  opportunityAmount: number | null;
  monthlyEquivalentNetSales: number | null;
  staticProfitBuffer: number | null;
  finding: NetworkFinding;
}

export interface ProductDimensionShortfall {
  id: string;
  productId: string;
  productName: string;
  title: string;
  dimensionKey: BreakthroughDimensionScore["key"];
  actualValue: number | null;
  benchmarkValue: number | null;
  actualDisplay: string;
  benchmarkDisplay: string;
  gapRate: number;
  priorityProxy: number;
  action: string;
  finding: NetworkFinding;
}

export interface AudienceRecommendation {
  id: string;
  title: string;
  role: AudiencePlanItem["type"];
  productId?: string;
  productName: string;
  audienceName: string;
  planId: string;
  clicks: number | null;
  roi: number | null;
  roiFloor: number | null;
  maxCpaEstimate: number | null;
  maxCpcProxy: number | null;
  startingBidSuggestion: string;
  budgetStep: string;
  finding: NetworkFinding;
}

export interface NetworkAction {
  id: string;
  title: string;
  owner: string;
  priority: "P1" | "P2" | "P3";
  status: "ready" | "blocked" | "conditional";
  targetId?: string;
  category?: string;
  budget?: number;
  dependsOn: string[];
  gateIds: string[];
  metric: string;
  stopCondition: string;
  finding: NetworkFinding;
}

export interface BudgetGate {
  id: string;
  title: string;
  status: "pass" | "conditional" | "fail";
  criterion: string;
  finding: NetworkFinding;
}

export interface NetworkMilestone {
  id: string;
  title: string;
  horizon: string;
  objective: string;
  successCriteria: string[];
  stopConditions: string[];
  finding: NetworkFinding;
}

export interface OperatingNetworkSnapshot {
  generatedAt: string;
  analysisPeriod?: { start: string; end: string };
  finding: NetworkFinding;
  readiness: NetworkReadiness;
  outcome: OperatingOutcome;
  profitDrivers: ProfitDriver[];
  investmentSpace: InvestmentSpace;
  potentialProducts: PotentialProduct[];
  dimensionShortfalls: ProductDimensionShortfall[];
  audienceRecommendations: AudienceRecommendation[];
  actions: NetworkAction[];
  budgetGates: BudgetGate[];
  milestones: NetworkMilestone[];
  modelAdmissions: ModelAdmissionDecision[];
}

export interface OperatingNetworkInput {
  investmentResults: ProductInvestmentResult[];
  breakthroughResults: ProductBreakthroughResult[];
  audiencePlans: AudiencePlanItem[];
  businessDiagnosis?: BusinessDiagnosisSnapshot;
  trendSeries?: DailyTrendPoint[];
  analysisPeriod?: { start: string; end: string };
  readinessContext?: {
    readyPrefillCount: number;
    totalPrefillCount: number;
    shopName?: string;
    sourceCoverage?: {
      product: boolean;
      damo: boolean;
      promotion: boolean;
      audience: boolean;
      business: boolean;
    };
    sourcePeriodAlignment?: {
      aligned: boolean;
      issues: string[];
    };
    sourceObservedDays?: Partial<Record<"product" | "promotion" | "audience", number>>;
  };
}

const DIMENSION_ACTIONS: Record<BreakthroughDimensionScore["key"], string> = {
  searchDisplayValue: "重做标题关键词、主图首屏和搜索承接，先提升搜索点击价值。",
  searchPaymentConversionRate: "围绕价格权益、规格表达与信任证据做转化 A/B 测试。",
  averageStaySeconds: "补强首屏卖点、视频与评价证据，观察有效停留是否提升。",
  bounceRate: "排查首屏不匹配、加载与卖点表达，降低无效跳失。",
  refundRate: "按退款原因拆分品控、规格、物流与预期管理，先止住利润漏损。",
  attachPurchaseRate: "增加组合购、搭配包与关联推荐，验证连带购买提升。",
  attachCategoryWidth: "补齐同场景货盘与跨类目组合，扩大可连带范围。",
  repurchaseRate: "建立复购周期触达、会员权益与老客专属组合。"
};

const DRIVER_LABELS: Record<Exclude<ProfitDriver["key"], "unavailable">, string> = {
  traffic: "流量变化",
  conversion: "支付转化变化",
  aov: "客单价变化",
  refund: "退款变化",
  grossMargin: "毛利率变化",
  adSpend: "推广花费变化"
};

export function buildOperatingNetworkSnapshot(input: OperatingNetworkInput): OperatingNetworkSnapshot {
  const trend = buildTrendComparison(input.trendSeries ?? []);
  const readiness = buildReadiness(input, trend !== null);
  const outcome = buildOutcome(input.investmentResults, trend);
  const profitDrivers = buildProfitDrivers(input.investmentResults, trend);
  const investmentSpace = buildInvestmentSpace(input, readiness, outcome);
  const potentialProducts = buildPotentialProducts(input);
  const dimensionShortfalls = buildDimensionShortfalls(input);
  const audienceRecommendations = buildAudienceRecommendations(input);
  const budgetGates = buildBudgetGates({
    readiness,
    outcome,
    potentialProducts,
    dimensionShortfalls,
    audienceRecommendations
  });
  const actions = buildActions({
    readiness,
    outcome,
    investmentSpace,
    potentialProducts,
    dimensionShortfalls,
    audienceRecommendations,
    budgetGates
  });
  const milestones = buildMilestones({ readiness, outcome, budgetGates });
  const profitEvidenceComplete = input.investmentResults.length > 0 &&
    input.investmentResults.every((item) => item.profitEvidenceAvailable === true);
  const business = input.businessDiagnosis;
  const modelAdmissions = evaluateDiagnosisModels({
    hasOperatingResults: input.investmentResults.length > 0,
    hasProfitEvidence: profitEvidenceComplete,
    hasTrendComparison: trend !== null,
    hasOpportunityTargets: input.investmentResults.some((item) => Number.isFinite(item.monthlyGsvOpportunity)),
    hasProductDimensions: input.breakthroughResults.some((item) =>
      item.dimensions.some((dimension) => dimension.available !== false)
    ),
    hasAudienceSignals: input.audiencePlans.length > 0,
    hasAudienceEconomics: false,
    hasInvestmentApproval: false,
    hasClosedComparison: false,
    hasControlGroup: false,
    hasCategoryData: Boolean(business?.categories.length),
    hasComparableCategoryPeriods: Boolean(
      business?.categories.some(
        (category) => category.revenueGrowth !== null && category.comparisonConclusionAllowed
      )
    ),
    hasMarketSignals: Boolean(
      business &&
        (business.market.topPriceBands.length > 0 ||
          business.market.topAttributeSignals.length > 0 ||
          business.market.topSearchSignals.length > 0)
    ),
    hasAlignedMarketPeriod: business?.market.samePeriod === true,
    hasUnitCostCurve: false,
    hasScaleCostStructure: false,
    hasMacroEvidence: false,
    hasCompetitionEvidence: false,
    hasOrganizationEvidence: false,
    hasNpsSurvey: business?.npsReputation.available === true
  });
  const rootStatus: NetworkFindingStatus =
    readiness.score < 35
      ? "insufficient"
      : outcome.finding.status === "critical" || budgetGates.some((item) => item.status === "fail")
        ? "critical"
        : readiness.score < 100 || outcome.finding.status !== "positive" || budgetGates.some((item) => item.status === "conditional")
          ? "warning"
          : "positive";
  const shopName = input.readinessContext?.shopName?.trim();
  const rootFinding = finding({
    id: "operating-network-root",
    title: shopName ? `${shopName}经营网络总判断` : "经营网络总判断",
    status: rootStatus,
    conclusion:
      readiness.score < 35
        ? "当前只能输出数据准备方案，尚不足以形成可信的投资与放量结论。"
        : `${outcome.health}；投资/放量状态为${budgetGates.some((item) => item.status === "fail") ? "未通过" : budgetGates.some((item) => item.status === "conditional") ? "有条件待验证" : "已通过"}。当前建议先处理 ${actions.find((item) => item.priority === "P1")?.title ?? "证据补齐"}，再按预算闸门逐级释放。`,
    proof: unique([
      ...outcome.finding.proof,
      ...investmentSpace.finding.proof,
      ...potentialProducts.slice(0, 2).flatMap((item) => item.finding.proof)
    ]).slice(0, 8),
    cannotProve: unique([
      "现有观察数据不能证明投放或优化动作造成了经营结果变化。",
      ...outcome.finding.cannotProve,
      ...investmentSpace.finding.cannotProve
    ]).slice(0, 8),
    requiredData: unique([
      ...readiness.finding.requiredData,
      ...investmentSpace.finding.requiredData,
      ...audienceRecommendations.slice(0, 2).flatMap((item) => item.finding.requiredData)
    ]).slice(0, 10),
    confidenceScore: Math.round(readiness.score * 0.55 + outcome.finding.confidence.score * 0.45),
    reasons: [
      `诊断就绪度 ${Math.round(readiness.score)} 分`,
      trend ? `已形成 ${trend.days} 天等长前后窗` : "缺少可比较的分日窗口",
      `预算闸门：${budgetGates.filter((item) => item.status === "pass").length}/5 通过`,
      input.businessDiagnosis ? "类目与市场证据仅作增强信息" : "本次直接诊断不依赖类目市场证据"
    ]
  });

  return {
    generatedAt: new Date().toISOString(),
    analysisPeriod: input.analysisPeriod,
    finding: rootFinding,
    readiness,
    outcome,
    profitDrivers,
    investmentSpace,
    potentialProducts,
    dimensionShortfalls,
    audienceRecommendations,
    actions,
    budgetGates,
    milestones,
    modelAdmissions
  };
}

function assessOperatingSourceWindow(
  input: OperatingNetworkInput,
  sources: Array<"product" | "promotion" | "audience">
) {
  const period = input.analysisPeriod;
  const coverage = input.readinessContext?.sourceCoverage;
  const missingSources = sources.filter((source) => coverage?.[source] === false);
  const observedDays = sources.map(
    (source) => input.readinessContext?.sourceObservedDays?.[source] ?? 0
  );
  if (!period) {
    return assessEvidenceWindow({
      asOfDate: currentIsoDate(),
      sides: [],
      missingFields: ["明确的分析起止日期", ...missingSources.map((source) => `${source} 源`)]
    });
  }
  const aligned = sources.length <= 1 || (input.readinessContext?.sourcePeriodAlignment?.aligned ?? false);
  return assessEvidenceWindow({
    asOfDate: currentIsoDate(),
    sides: [{
      start: period.start,
      end: period.end,
      observedDays: observedDays.length > 0 ? Math.min(...observedDays) : 0
    }],
    comparable: aligned,
    comparisonIssue: aligned
      ? undefined
      : input.readinessContext?.sourcePeriodAlignment?.issues.join("；") || "核心源统计周期不可比",
    missingFields: missingSources.map((source) => `${source} 源`)
  });
}

function buildReadiness(input: OperatingNetworkInput, hasComparableTrend: boolean): NetworkReadiness {
  const ready = input.readinessContext?.readyPrefillCount ?? input.investmentResults.length;
  const total = input.readinessContext?.totalPrefillCount ?? input.investmentResults.length;
  const prefillRatio = total > 0 ? ready / total : 0;
  const inferredCoverage = {
    product: input.investmentResults.length > 0,
    damo: input.breakthroughResults.some((item) =>
      item.dimensions.some((dimension) =>
        ["attachPurchaseRate", "attachCategoryWidth", "repurchaseRate"].includes(dimension.key) &&
        dimension.available !== false
      )
    ),
    promotion: input.investmentResults.length > 0,
    audience: input.audiencePlans.length > 0,
    business: Boolean(input.businessDiagnosis)
  };
  const coverage = input.readinessContext?.sourceCoverage ?? inferredCoverage;
  const sourcePeriodsAligned = input.readinessContext?.sourcePeriodAlignment?.aligned ?? true;
  const sourcePeriodIssues = input.readinessContext?.sourcePeriodAlignment?.issues ?? [];
  const productWindowEvidence = assessOperatingSourceWindow(input, ["product"]);
  const allSourceWindowEvidence = assessOperatingSourceWindow(input, ["product", "promotion", "audience"]);
  const profitEvidenceCount = input.investmentResults.filter((item) => item.profitEvidenceAvailable === true).length;
  const profitEvidenceCoverage = input.investmentResults.length > 0
    ? profitEvidenceCount / input.investmentResults.length
    : null;
  const requiredSourcesComplete =
    coverage.product && coverage.damo && coverage.promotion && coverage.audience &&
    sourcePeriodsAligned && allSourceWindowEvidence.conclusionAllowed && profitEvidenceCoverage === 1;
  const productIds = new Set(input.investmentResults.map((item) => item.productId));
  const audienceProductMatchRate = input.audiencePlans.length > 0
    ? input.audiencePlans.filter((item) => item.subjectId && productIds.has(item.subjectId)).length / input.audiencePlans.length
    : null;
  const checks = [
    { ok: coverage.product, weight: 15, label: "商品源" },
    { ok: coverage.damo, weight: 10, label: "达摩盘货品源" },
    { ok: coverage.promotion, weight: 10, label: "推广宝贝源" },
    { ok: coverage.audience, weight: 10, label: "人群源" },
    { ok: input.investmentResults.length > 0, weight: 15, label: "盈利投资结果" },
    { ok: input.breakthroughResults.length > 0, weight: 10, label: "商品八维结果" },
    { ok: hasComparableTrend, weight: 10, label: "连续可比分日趋势" },
    { ok: prefillRatio >= 0.8, weight: 10, label: "商品参数填写覆盖" },
    { ok: sourcePeriodsAligned, weight: 10, label: "四源统计周期覆盖一致" },
    { ok: productWindowEvidence.conclusionAllowed, weight: 10, label: "商品源证据窗口" },
    { ok: profitEvidenceCoverage === 1, weight: 10, label: "商品推广成本关联覆盖" }
  ];
  const totalWeight = checks.reduce((sum, item) => sum + item.weight, 0);
  const score = Math.round(checks.reduce((sum, item) => sum + (item.ok ? item.weight : 0), 0) / totalWeight * 100);
  const missing = checks.filter((item) => !item.ok).map((item) => item.label);
  // 直接诊断只要求商品经营结果与必要参数；市场、推广、人群和跨源周期只限制对应分项及预算闸门。
  const directDiagnosisReady = coverage.product && productWindowEvidence.conclusionAllowed &&
    input.investmentResults.length > 0 && prefillRatio >= 0.8;
  return {
    id: "readiness",
    title: "诊断就绪度",
    score,
    readyPrefillCount: ready,
    totalPrefillCount: total,
    checksPassed: checks.filter((item) => item.ok).length,
    checksTotal: checks.length,
    requiredSourcesComplete,
    sourcePeriodsAligned,
    profitEvidenceCoverage,
    audienceProductMatchRate,
    finding: finding({
      id: "readiness-finding",
      title: "诊断就绪度",
      status: directDiagnosisReady ? (missing.length > 0 ? "warning" : "positive") : score >= 50 ? "warning" : score > 0 ? "critical" : "insufficient",
      conclusion:
        directDiagnosisReady
          ? missing.length > 0
            ? `现有经营数据已达到直接诊断条件；${missing.join("、")}仅限制对应分项或预算结论，不阻断本次诊断。`
            : "现有经营数据已达到直接诊断条件，可以进入诊断与有条件验证。"
          : `仍缺 ${missing.join("、") || "关键证据"}，相关结论会自动降级。`,
      proof: [
        ...checks.filter((item) => item.ok).map((item) => `已具备：${item.label}`),
        ...(audienceProductMatchRate !== null ? [`人群—商品精确关联率 ${percent(audienceProductMatchRate)}`] : [])
      ],
      cannotProve: ["数据齐备只代表可以诊断，不代表建议动作一定产生增量效果。"],
      requiredData: [
        ...missing.map((item) => `补充或校验：${item}`),
        ...sourcePeriodIssues,
        ...(!productWindowEvidence.conclusionAllowed ? [productWindowEvidence.message] : []),
        ...(profitEvidenceCoverage !== null && profitEvidenceCoverage < 1
          ? [`补齐 ${input.investmentResults.length - profitEvidenceCount} 个商品在同一分析窗内的推广成本关联`]
          : []),
        ...(audienceProductMatchRate !== null && audienceProductMatchRate < 0.8 ? ["修复人群 subjectId 与商品 ID 映射"] : [])
      ],
      confidenceScore: score,
      reasons: [
        `通过 ${checks.filter((item) => item.ok).length}/${checks.length} 道数据检查`,
        `统一证据窗：${productWindowEvidence.status}`,
        ...(directDiagnosisReady ? ["已启用现有数据直接诊断"] : [])
      ]
    })
  };
}

interface TrendStats {
  days: number;
  current: WindowStats;
  previous: WindowStats;
}

interface WindowStats {
  paymentAmount: number;
  netSales: number;
  visitors: number;
  buyers: number;
  refundAmount: number;
  adCost: number;
  conversion: number | null;
  aov: number | null;
  refundRate: number | null;
}

function buildTrendComparison(series: DailyTrendPoint[]): TrendStats | null {
  const byDate = new Map<string, DailyTrendPoint>();
  for (const row of series) byDate.set(row.date, row);
  const rows = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  if (rows.length < 14) return null;
  for (let days = Math.min(30, Math.floor(rows.length / 2)); days >= 7; days -= 1) {
    const candidate = rows.slice(rows.length - days * 2);
    if (!datesAreConsecutive(candidate.map((item) => item.date))) continue;
    const evidence = assessEvidenceWindow({
      asOfDate: currentIsoDate(),
      sides: [
        { start: candidate[0].date, end: candidate[days - 1].date, observedDays: days },
        { start: candidate[days].date, end: candidate.at(-1)!.date, observedDays: days }
      ]
    });
    if (!evidence.conclusionAllowed) continue;
    const previous = summarizeWindow(candidate.slice(0, days));
    const current = summarizeWindow(candidate.slice(days));
    if (!previous || !current) continue;
    return { days, previous, current };
  }
  return null;
}

function datesAreConsecutive(dates: string[]) {
  for (let index = 1; index < dates.length; index += 1) {
    const previous = Date.parse(`${dates[index - 1]}T00:00:00Z`);
    const current = Date.parse(`${dates[index]}T00:00:00Z`);
    if (!Number.isFinite(previous) || !Number.isFinite(current) || current - previous !== 86_400_000) {
      return false;
    }
  }
  return true;
}

function summarizeWindow(rows: DailyTrendPoint[]): WindowStats | null {
  const paymentAmount = sumKnown(rows.map((item) => item.paymentAmount));
  const netSales = sumKnown(rows.map((item) => item.netSales));
  const visitors = sumKnown(rows.map((item) => item.visitors));
  const buyers = sumKnown(rows.map((item) => item.paymentBuyers));
  const adCost = sumKnown(rows.map((item) => item.adCost));
  if (paymentAmount === null || netSales === null || visitors === null || buyers === null || adCost === null) {
    return null;
  }
  const refundAmount = paymentAmount - netSales;
  return {
    paymentAmount,
    netSales,
    visitors,
    buyers,
    refundAmount,
    adCost,
    conversion: divideOrNull(buyers, visitors),
    aov: divideOrNull(paymentAmount, buyers),
    refundRate: divideOrNull(refundAmount, paymentAmount)
  };
}

function buildOutcome(results: ProductInvestmentResult[], trend: TrendStats | null): OperatingOutcome {
  const hasResults = results.length > 0;
  const observedNetSales = sumKnown(results.map((item) => item.netSales));
  const verifiedResults = results.filter((item) =>
    item.profitEvidenceAvailable === true &&
    item.netSales !== null &&
    item.historicalGrossProfit !== null &&
    item.historicalGrossProfitWithoutPromotion !== null
  );
  const completeProfitEvidence = hasResults && verifiedResults.length === results.length;
  const observedContributionProfit = completeProfitEvidence
    ? sum(verifiedResults.map((item) => item.historicalGrossProfit as number))
    : null;
  // 负净销商品不能用“负目标利润”抵扣其它商品的目标线。
  const targetProfit = completeProfitEvidence
    ? sum(verifiedResults.map((item) => Math.max(item.netSales as number, 0) * item.attackDefenseMarginRate))
    : null;
  const positiveSales = observedNetSales !== null && observedNetSales > 0;
  const marginRate = positiveSales && observedContributionProfit !== null ? observedContributionProfit / (observedNetSales as number) : null;
  const targetMarginRate = positiveSales && targetProfit !== null ? targetProfit / (observedNetSales as number) : null;
  const profitBuffer = observedContributionProfit !== null && targetProfit !== null
    ? observedContributionProfit - targetProfit
    : null;
  const health: OperatingOutcome["health"] = !hasResults
    ? "无法判断"
    : !positiveSales
      ? "亏损失控"
      : !completeProfitEvidence || observedContributionProfit === null || targetProfit === null
        ? "无法判断"
      : observedContributionProfit > 0 && profitBuffer !== null && profitBuffer >= 0
      ? "健康盈利"
      : observedContributionProfit < 0 && profitBuffer !== null && profitBuffer >= 0
        ? "策略性投入"
        : observedContributionProfit > 0
          ? "有利润但不达标"
          : observedContributionProfit === 0 && targetProfit <= 0
            ? "策略性投入"
            : "亏损失控";
  const grossRate = positiveSales && completeProfitEvidence
    ? sum(verifiedResults.map((item) => item.historicalGrossProfitWithoutPromotion as number)) / (observedNetSales as number)
    : null;
  const currentProfitEstimate = trend && grossRate !== null
    ? trend.current.netSales * grossRate - trend.current.adCost
    : null;
  const previousProfitEstimate = trend && grossRate !== null
    ? trend.previous.netSales * grossRate - trend.previous.adCost
    : null;
  const netSalesTrend = trend ? changeRate(trend.current.netSales, trend.previous.netSales) : null;
  const profitTrend =
    currentProfitEstimate !== null && previousProfitEstimate !== null
      ? changeRate(currentProfitEstimate, previousProfitEstimate)
      : null;
  const status: NetworkFindingStatus = !hasResults
    ? "insufficient"
    : health === "无法判断"
      ? "insufficient"
    : health === "健康盈利"
      ? "positive"
      : health === "亏损失控"
        ? "critical"
        : "warning";
  return {
    id: "operating-outcome",
    title: "经营结果与利润健康",
    health,
    netSales: hasResults ? observedNetSales : null,
    contributionProfit: observedContributionProfit,
    marginRate,
    targetMarginRate,
    profitBuffer,
    netSalesTrend,
    profitTrend,
    analysisDays: trend?.days ?? 0,
    finding: finding({
      id: "outcome-finding",
      title: "经营结果与利润健康",
      status,
      conclusion: !hasResults
        ? "尚无纳入计算的商品，无法判断利润健康。"
        : !positiveSales
          ? `${health}：已观察到净销售额 ${money(observedNetSales)}，净销售非正或缺失，利润率与投资空间均不应继续计算。`
          : !completeProfitEvidence || observedContributionProfit === null
            ? `${health}：净销售额 ${money(observedNetSales)} 已观察，但仅 ${verifiedResults.length}/${results.length} 个商品关联到同窗推广成本，暂不能证明整组贡献利润与投资空间。`
          : `${health}：投放后贡献利润估算为 ${money(observedContributionProfit)}，利润率 ${percent(marginRate)}，相对目标缓冲 ${money(profitBuffer)}。${trend ? `最近 ${trend.days} 天较前一等长窗口净销售${trendText(netSalesTrend)}、利润估算${trendText(profitTrend)}。` : "暂无足够连续分日数据判断环比。"}`,
      proof: hasResults
        ? [
            `净销售额 ${money(observedNetSales)}`,
            ...(observedContributionProfit !== null ? [`投放后贡献利润估算 ${money(observedContributionProfit)}`] : []),
            ...(observedContributionProfit !== null
              ? ["贡献利润口径：分析窗净销售额 × 预填商品毛利率 − 同窗推广花费"]
              : []),
            ...(positiveSales && marginRate !== null && targetMarginRate !== null && completeProfitEvidence
              ? [`当前利润率 ${percent(marginRate)}，目标保留利润率 ${percent(targetMarginRate)}`]
              : []),
            ...(trend ? [`最近两个 ${trend.days} 天等长窗口可比`] : [])
          ]
        : [],
      cannotProve: [
        "商品成本、平台扣点、税费、仓储与履约等是否计入，取决于用户预填毛利率口径；系统不会再次重复扣减。",
        "固定人工、组织管理与资金占用成本未单独计入，因此贡献利润估算不等于财务净利润。",
        "环比变化只能证明同期共变，不能单独证明某项投放或运营动作造成变化。",
        ...(trend ? ["分日利润趋势沿用当前商品综合毛利率，未反映分析窗内分期毛利率变化。"] : [])
      ],
      requiredData: [
        ...(!hasResults ? ["商品源、推广源以及商品毛利率/机会填写"] : []),
        ...(!completeProfitEvidence && hasResults ? ["补齐分析窗内缺失的推广分日源数据或修正商品ID映射（系统自动关联）"] : []),
        ...(!trend ? ["至少 14 个可比较日期的商品与推广分日数据"] : [])
      ],
      confidenceScore: !hasResults ? 10 : !completeProfitEvidence ? 28 : positiveSales ? (trend ? 76 : 60) : 45,
      reasons: [completeProfitEvidence ? "逐商品推广成本已按同窗关联" : "商品推广成本关联不完整", positiveSales ? "净销售分母有效" : "净销售非正", trend ? "具有连续等长趋势窗口" : "缺少连续趋势窗口"]
    })
  };
}

function buildProfitDrivers(results: ProductInvestmentResult[], trend: TrendStats | null): ProfitDriver[] {
  const netSales = sumKnown(results.map((item) => item.netSales));
  const completeProfitEvidence = results.length > 0 && results.every((item) =>
    item.profitEvidenceAvailable === true && item.historicalGrossProfitWithoutPromotion !== null
  );
  const grossMargin = completeProfitEvidence && netSales !== null
    ? divideOrNull(
        sum(results.map((item) => item.historicalGrossProfitWithoutPromotion as number)),
        netSales
      )
    : null;
  const trendRatesKnown = Boolean(
    trend && trend.previous.conversion !== null && trend.previous.aov !== null &&
    trend.previous.refundRate !== null && trend.current.conversion !== null &&
    trend.current.aov !== null && trend.current.refundRate !== null
  );
  if (!trend || results.length === 0 || netSales === null || netSales <= 0 ||
      !completeProfitEvidence || grossMargin === null || !trendRatesKnown) {
    return [
      {
        id: "profit-driver-unavailable",
        title: "利润环比归因待补数据",
        key: "unavailable",
        contribution: 0,
        contributionRate: 0,
        direction: "neutral",
        finding: finding({
          id: "profit-driver-unavailable-finding",
          title: "利润环比归因待补数据",
          status: "insufficient",
          conclusion: "当前不能把利润变化拆到流量、转化、客单、退款、毛利和投放花费。",
          proof: [],
          cannotProve: ["单期利润结果不能证明各因素对环比利润的影响金额。"],
          requiredData: ["至少两个连续 7 天等长分日窗口的流量、买家、销售、退款和推广花费", "正向净销售分母", "逐商品同窗推广成本与分期毛利率"],
          confidenceScore: 10,
          reasons: ["缺少可比较窗口"]
        })
      }
    ];
  }

  const factorKeys = ["traffic", "conversion", "aov", "keepRate", "grossMargin"] as const;
  type FactorKey = (typeof factorKeys)[number];
  const previous: Record<FactorKey, number> = {
    traffic: trend.previous.visitors / trend.days,
    conversion: trend.previous.conversion as number,
    aov: trend.previous.aov as number,
    keepRate: 1 - (trend.previous.refundRate as number),
    grossMargin
  };
  const current: Record<FactorKey, number> = {
    traffic: trend.current.visitors / trend.days,
    conversion: trend.current.conversion as number,
    aov: trend.current.aov as number,
    keepRate: 1 - (trend.current.refundRate as number),
    grossMargin
  };
  const contributions = shapleyContributions(factorKeys, previous, current, (values) =>
    values.traffic * values.conversion * values.aov * values.keepRate * values.grossMargin
  );
  const mapped: Array<{ key: Exclude<ProfitDriver["key"], "unavailable">; value: number }> = [
    { key: "traffic", value: contributions.traffic * trend.days },
    { key: "conversion", value: contributions.conversion * trend.days },
    { key: "aov", value: contributions.aov * trend.days },
    { key: "refund", value: contributions.keepRate * trend.days },
    { key: "grossMargin", value: contributions.grossMargin * trend.days },
    { key: "adSpend", value: -(trend.current.adCost - trend.previous.adCost) }
  ];
  const totalAbsolute = sum(mapped.map((item) => Math.abs(item.value))) || 1;
  const totalNegativeAbsolute = sum(mapped.filter((item) => item.value < -0.01).map((item) => Math.abs(item.value))) || 1;
  return mapped
    .map(({ key, value }) => {
      const direction = value > 0.01 ? "positive" : value < -0.01 ? "negative" : "neutral";
      // 负向主因只在负向因素内比较，避免被大量正向贡献稀释后漏报。
      const share = direction === "negative"
        ? Math.abs(value) / totalNegativeAbsolute
        : Math.abs(value) / totalAbsolute;
      const dataLimitation = key === "grossMargin";
      return {
        id: `profit-driver-${key}`,
        title: DRIVER_LABELS[key],
        key,
        contribution: value,
        contributionRate: share,
        direction,
        finding: finding({
          id: `profit-driver-${key}-finding`,
          title: DRIVER_LABELS[key],
          status: dataLimitation ? "insufficient" : direction === "negative" ? (share >= 0.35 ? "critical" : "warning") : "positive",
          conclusion: dataLimitation
            ? "缺少分期毛利率，暂不能判断毛利变化对利润环比的贡献。"
            : `${DRIVER_LABELS[key]}对等长窗口利润变化的模型贡献约 ${money(value)}，${direction === "negative" ? "占全部负向影响" : "占全部绝对影响"} ${percent(share)}。`,
          proof: dataLimitation ? [] : [`基于 ${trend.days} 天等长前后窗进行 Shapley 无顺序分解`],
          cannotProve: [
            "因素分解是经营恒等式的描述性归因，不等同于因果实验结论。",
            "商品成本、平台扣点、税费、仓储与履约等由预填毛利率承载；固定人工、组织管理和资金成本未单独进入模型。",
            "分期商品成本和毛利率缺失时，模型只能把毛利率视为不变。"
          ],
          requiredData: dataLimitation ? ["分期商品成本与真实毛利率"] : [],
          confidenceScore: dataLimitation ? 25 : 72,
          reasons: [dataLimitation ? "当前只具备单期毛利率" : "使用可加总的无顺序贡献分解"]
        })
      } satisfies ProfitDriver;
    })
    .sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution));
}

function buildInvestmentSpace(
  input: OperatingNetworkInput,
  readiness: NetworkReadiness,
  outcome: OperatingOutcome
): InvestmentSpace {
  const byProduct = new Map(input.breakthroughResults.map((item) => [item.productId, item]));
  const completeProfitEvidence = input.investmentResults.length > 0 &&
    input.investmentResults.every((item) =>
      item.profitEvidenceAvailable === true && item.historicalGrossProfit !== null && item.netSales !== null
    );
  const buffers = input.investmentResults.map((item) => ({
    item,
    buffer: item.historicalGrossProfit !== null && item.netSales !== null
      ? item.historicalGrossProfit - item.netSales * item.attackDefenseMarginRate
      : null
  }));
  const eligible = buffers
    .filter((entry) => entry.item.profitEvidenceAvailable === true && (entry.item.netSales ?? 0) > 0 && (entry.buffer ?? 0) > 0)
    .map((entry) => entry.item);
  const economicCeiling = input.investmentResults.length > 0 && completeProfitEvidence && readiness.sourcePeriodsAligned
    ? sum(buffers.map((entry) => (entry.item.netSales ?? 0) > 0 && entry.buffer !== null ? Math.max(entry.buffer, 0) : 0))
    : null;
  const contributionRates = eligible
    .map((item) => effectiveContributionRate(item, byProduct.get(item.productId)))
    .filter((value): value is number => value !== null && value > 0);
  const roiFloors = contributionRates.map((value) => 1 / value).filter(Number.isFinite);
  const medianRoiFloor = roiFloors.length ? median(roiFloors) : null;
  const prefillCoverage = readiness.totalPrefillCount > 0
    ? readiness.readyPrefillCount / readiness.totalPrefillCount
    : 0;
  const canEnterApproval =
    readiness.requiredSourcesComplete && readiness.score >= 80 &&
    (readiness.audienceProductMatchRate ?? 0) >= 0.8 && prefillCoverage >= 0.8 &&
    outcome.health === "健康盈利" && outcome.analysisDays >= 7 && (economicCeiling ?? 0) > 0;
  // 缺管理预算、现金、库存与履约上限时，不生成精确“建议释放金额”。
  const suggestedTestBudget = null;
  const reserveBudget = null;
  // 人群 ROI 缺少花费/支付同口径，不能包装成未来收益情景；保留场景槽位等待真实实验输入。
  const scenarios: InvestmentScenario[] = (["保守", "基准", "乐观"] as const).map((label) => ({
    label,
    roi: null,
    incrementalPayment: null,
    incrementalContribution: null
  }));
  const proof = [
    ...(economicCeiling !== null && economicCeiling > 0 ? [`${eligible.length} 个商品静态利润安全垫合计 ${money(economicCeiling)}`] : []),
    ...(medianRoiFloor !== null ? [`商品经济模型的 ROI 底线中位数约 ${medianRoiFloor.toFixed(2)}`] : []),
  ];
  return {
    id: "investment-space",
    title: "投资空间与预算安排",
    economicCeiling,
    approvedBudget: null,
    suggestedTestBudget,
    reserveBudget,
    eligibleProductCount: eligible.length,
    medianRoiFloor,
    scenarios,
    finding: finding({
      id: "investment-space-finding",
      title: "投资空间与预算安排",
      status: economicCeiling === null ? "insufficient" : economicCeiling <= 0 ? "critical" : "warning",
      conclusion:
        economicCeiling === null
          ? "同窗商品利润、推广成本或周期证据不完整，无法计算投资空间。"
          : economicCeiling <= 0
          ? "当前没有可确认的静态利润安全垫，暂不建议增加预算。"
          : `静态利润安全垫约 ${money(economicCeiling)}；${canEnterApproval ? "可进入预算审批，首档比例由经营负责人结合获批预算确认。" : "先修复前置闸门，暂不释放预算。"}具体获批、释放与保留金额待现金、库存和履约约束确认。`,
      proof,
      cannotProve: [
        "静态利润安全垫是假设新增花费零产出时的承压空间，不是建议花完的预算。",
        "现有数据不能确定公司的现金、库存、履约与团队承载上限。",
        "当前人群 ROI 缺少同口径花费与支付明细，不能生成未来 ROI、增量收入或利润情景。"
      ],
      requiredData: [
        "管理层批准预算与现金上限",
        "库存、补货、履约产能和团队执行上限",
        ...(!completeProfitEvidence ? ["补齐分析窗内缺失的推广分日源数据或修正商品ID映射（系统自动关联）"] : []),
        ...(!readiness.sourcePeriodsAligned ? ["四张核心源表的统计周期范围"] : []),
        "足量的人群级花费、支付、成交与贡献利润实验历史"
      ],
      confidenceScore: economicCeiling === null ? 15 : economicCeiling <= 0 ? 35 : 54,
      reasons: [economicCeiling !== null ? "安全垫来自同窗商品利润结果" : "利润成本或周期证据不完整", "投资预估缺少稳定的同口径实验分布"]
    })
  };
}

function buildPotentialProducts(input: OperatingNetworkInput): PotentialProduct[] {
  const breakthroughById = new Map(input.breakthroughResults.map((item) => [item.productId, item]));
  const periodDays = input.analysisPeriod
    ? inclusiveDays(input.analysisPeriod.start, input.analysisPeriod.end)
    : null;
  const fullNaturalMonth = input.analysisPeriod ? isFullNaturalMonth(input.analysisPeriod) : false;
  const sourcePeriodComparable = input.readinessContext?.sourcePeriodAlignment?.aligned ?? true;
  const productWindowEvidence = assessOperatingSourceWindow(input, ["product"]);
  const monthlyOpportunityComparable = fullNaturalMonth && sourcePeriodComparable &&
    productWindowEvidence.conclusionAllowed;
  const monthlyEquivalent = (netSales: number | null) => netSales === null
    ? null
    : fullNaturalMonth
      ? netSales
      : periodDays && periodDays > 0
        ? netSales * 30 / periodDays
        : netSales;
  const opportunities = input.investmentResults.map((item) =>
    monthlyEquivalent(item.netSales) === null
      ? null
      : Math.max(item.monthlyGsvOpportunity - Math.max(monthlyEquivalent(item.netSales) as number, 0), 0)
  ).filter((value): value is number => value !== null);
  const opportunityLine = median(opportunities.filter((value) => value > 0));
  return input.investmentResults
    .map((item) => {
      const breakthrough = breakthroughById.get(item.productId);
      const usableDimensions = breakthrough?.dimensions.filter((dimension) => !dimensionLooksMissing(dimension)) ?? [];
      const passedDimensions = usableDimensions.filter(dimensionPassedInclusive).length;
      const efficiency = breakthrough && usableDimensions.length === 8 ? passedDimensions / 8 : null;
      const monthlyEquivalentNetSales = monthlyEquivalent(item.netSales);
      const opportunityAmount = monthlyEquivalentNetSales === null
        ? null
        : Math.max(item.monthlyGsvOpportunity - Math.max(monthlyEquivalentNetSales, 0), 0);
      const opportunityRate = monthlyEquivalentNetSales !== null && monthlyEquivalentNetSales > 0 && opportunityAmount !== null
        ? opportunityAmount / monthlyEquivalentNetSales
        : null;
      // 只有完整自然月才能把“月 GSV 目标 - 实际”用于机会分层；短窗月化只展示估算，不发大机会绿灯。
      const largeOpportunity = monthlyOpportunityComparable && opportunityRate !== null && opportunityAmount !== null && opportunityRate >= 0.5 && opportunityAmount >= opportunityLine;
      const mediumOpportunity = monthlyOpportunityComparable && opportunityRate !== null && opportunityRate >= 0.2;
      const profitKnown = item.profitEvidenceAvailable === true && item.netSales !== null && item.historicalGrossProfit !== null;
      const staticProfitBuffer = profitKnown && (item.netSales as number) > 0
        ? (item.historicalGrossProfit as number) - (item.netSales as number) * item.attackDefenseMarginRate
        : null;
      const healthyProfit = staticProfitBuffer !== null && (item.historicalGrossProfit ?? 0) > 0 && staticProfitBuffer >= 0;
      const weakProfit = profitKnown && (item.historicalGrossProfit ?? 0) > 0 && !healthyProfit;
      const highEfficiency = efficiency !== null && passedDimensions >= 6;
      const pool: PotentialPool = highEfficiency && healthyProfit && largeOpportunity
        ? "核心潜力池"
        : healthyProfit && largeOpportunity && !highEfficiency
          ? "效率修复池"
          : highEfficiency && !healthyProfit && largeOpportunity
            ? "利润修复池"
            : highEfficiency && healthyProfit
              ? "现金流池"
              : largeOpportunity && !healthyProfit
                ? "高风险测试池"
                : "观察退出池";
      const status: NetworkFindingStatus = efficiency === null || !profitKnown
        ? "insufficient"
        : pool === "核心潜力池"
          ? "warning"
        : pool === "现金流池"
          ? "positive"
          : pool === "高风险测试池" || pool === "观察退出池"
            ? "critical"
            : "warning";
      const opportunityConfidence: PotentialProduct["opportunityConfidence"] =
        item.monthlyGsvOpportunity > 0 && monthlyOpportunityComparable ? "C" : "D";
      return {
        id: `potential-${item.productId}`,
        productId: item.productId,
        productName: item.productName,
        title: `${item.productName} · ${pool}`,
        manualGrade: item.grade,
        pool,
        efficiencyBadge: efficiency === null ? "证据不足" : highEfficiency ? "高效率" : "待修复",
        profitBadge: !profitKnown ? "证据不足" : healthyProfit ? "健康利润" : weakProfit ? "薄利" : "亏损",
        opportunityBadge: !monthlyOpportunityComparable ? "待核验" : largeOpportunity ? "大机会" : mediumOpportunity ? "常规机会" : "小机会",
        opportunityConfidence,
        netSales: item.netSales,
        historicalGrossProfit: item.historicalGrossProfit,
        historicalMarginRate: item.historicalMarginRate,
        monthlyGsvOpportunity: item.monthlyGsvOpportunity,
        opportunityAmount,
        monthlyEquivalentNetSales,
        staticProfitBuffer,
        finding: finding({
          id: `potential-${item.productId}-finding`,
          title: `${item.productName} · ${pool}`,
          status,
          conclusion: `${item.grade} 级商品进入${pool}${pool === "核心潜力池" ? "（待小测验证）" : ""}：${efficiency === null ? "效率证据不足" : `${passedDimensions}/8 个维度通过`}，${!profitKnown ? "同窗推广成本未关联" : healthyProfit ? "利润健康" : weakProfit ? "有利润但未达标" : "当前亏损"}，${monthlyOpportunityComparable ? "月机会缺口" : "30 天月化估算缺口"} ${money(opportunityAmount)}。`,
          proof: [
            ...(profitKnown ? [`同窗投放后贡献利润估算 ${money(item.historicalGrossProfit)}`] : []),
            ...(profitKnown ? [`利润率 ${percent(item.historicalMarginRate)}，目标 ${percent(item.attackDefenseMarginRate)}`] : []),
            ...(efficiency !== null ? [`按含等号规则重算后八维通过 ${passedDimensions}/8`] : [])
          ],
          cannotProve: [
            "月 GSV 机会目前是人工填写，不能单独证明真实市场可获得空间。",
            "八维相对效率不能证明加预算后的边际效率。"
          ],
          requiredData: [
            ...(!monthlyOpportunityComparable ? ["完整且无缺日的自然月商品/推广/人群数据；月化估算不能直接用于机会分层"] : []),
            ...(!profitKnown ? ["补齐该商品ID映射或分析窗推广源覆盖（系统自动汇总推广花费）"] : []),
            ...(efficiency === null ? ["完整的商品八维源数据与缺失值标记"] : [])
          ],
          confidenceScore: efficiency === null || !profitKnown ? 28 : opportunityConfidence === "C" ? 58 : 42,
          reasons: [profitKnown ? "利润来自同窗商品与推广结果" : "推广成本关联缺失", opportunityConfidence === "C" ? "机会额仍为人工输入" : "月度周期或分日覆盖不完整，仅可月化估算"]
        })
      } satisfies PotentialProduct;
    })
    .sort((left, right) => poolRank(left.pool) - poolRank(right.pool) || (right.staticProfitBuffer ?? -Infinity) - (left.staticProfitBuffer ?? -Infinity))
    .slice(0, 16);
}

function buildDimensionShortfalls(input: OperatingNetworkInput): ProductDimensionShortfall[] {
  const investmentById = new Map(input.investmentResults.map((item) => [item.productId, item]));
  const sProducts = new Set(input.investmentResults.filter((item) => item.grade === "S").map((item) => item.productId));
  const scope = input.breakthroughResults.filter((item) => sProducts.has(item.productId));
  return scope
    .flatMap((product) => {
      const investment = investmentById.get(product.productId);
      const missingDimensions = product.dimensions.filter(dimensionLooksMissing);
      const failedDimensions = product.dimensions
        .filter((dimension) => !dimensionLooksMissing(dimension) && !dimensionPassedInclusive(dimension));
      const buildShortfall = (dimension: BreakthroughDimensionScore) => {
          const missingLike = dimensionLooksMissing(dimension);
          const denominator = missingLike ? 1 : Math.max(Math.abs(dimension.threshold as number), 1e-9);
          const rawGap = missingLike
            ? 0
            : dimension.higherIsBetter
              ? ((dimension.threshold as number) - (dimension.value as number)) / denominator
              : ((dimension.value as number) - (dimension.threshold as number)) / denominator;
          const gapRate = Math.max(rawGap, 0);
          const maxSales = Math.max(...input.investmentResults.map((item) => item.netSales ?? 0), 1);
          const scaleWeight = investment?.netSales === null || investment?.netSales === undefined
            ? 0
            : clamp(investment.netSales / maxSales, 0, 1);
          const priorityProxy = Math.round(clamp(gapRate, 0, 1) * 70 + scaleWeight * 30);
          return {
            id: `shortfall-${product.productId}-${dimension.key}`,
            productId: product.productId,
            productName: product.productName,
            title: `${product.productName} · ${dimension.label}`,
            dimensionKey: dimension.key,
            actualValue: dimension.value,
            benchmarkValue: dimension.threshold,
            actualDisplay: missingLike ? "未提供" : metricValue(dimension),
            benchmarkDisplay: missingLike ? "待建立" : metricThreshold(dimension),
            gapRate,
            priorityProxy,
            action: DIMENSION_ACTIONS[dimension.key],
            finding: finding({
              id: `shortfall-${product.productId}-${dimension.key}-finding`,
              title: `${product.productName} · ${dimension.label}`,
              status: missingLike ? "insufficient" : gapRate >= 0.2 ? "critical" : "warning",
              conclusion: missingLike
                ? `${dimension.label}对应源字段或跨表关联不可用，当前不是“商品短板”结论，需先补数。`
                : `${dimension.label}未达到当前同批商品基准，差距约 ${percent(gapRate)}。建议：${DIMENSION_ACTIONS[dimension.key]}`,
              proof: missingLike ? [] : [`当前值 ${metricValue(dimension)}，样本中位基准 ${metricThreshold(dimension)}`],
              cannotProve: [
                "当前基准是样本中位数，不代表行业绝对健康线。",
                "单个维度落后不能单独证明销售或利润下降的原因。",
                "经营影响代理分只用于排序，不是可实现收益或因果贡献。"
              ],
              requiredData: [
                "同品类、同生命周期、同价格带的绝对健康基准",
                ...(missingLike ? ["源字段完整性与真实零值标记"] : []),
                ...(["attachPurchaseRate", "attachCategoryWidth", "repurchaseRate"].includes(dimension.key)
                  ? ["该维度的分期快照，用于动作前后验证"]
                  : [])
              ],
              confidenceScore: missingLike ? 18 : 58,
              reasons: [missingLike ? "缺失值与真实零值不可区分" : "具备当前值与样本相对基准"]
            })
          } satisfies ProductDimensionShortfall;
        };
      // 缺失维度全部列入数据问题；Top3 只在真实可用且未达标的维度中排序。
      const missing = missingDimensions.map(buildShortfall);
      const topFailures = failedDimensions
        .map(buildShortfall)
        .sort((left, right) => severityRank(right.finding.status) - severityRank(left.finding.status) || right.priorityProxy - left.priorityProxy)
        .slice(0, 3);
      return [...missing, ...topFailures];
    })
    .sort((left, right) => severityRank(right.finding.status) - severityRank(left.finding.status) || right.priorityProxy - left.priorityProxy)
    .slice(0, 32);
}

function buildAudienceRecommendations(input: OperatingNetworkInput): AudienceRecommendation[] {
  const investmentById = new Map(input.investmentResults.map((item) => [item.productId, item]));
  const breakthroughById = new Map(input.breakthroughResults.map((item) => [item.productId, item]));
  const expectedDays = input.analysisPeriod
    ? inclusiveDays(input.analysisPeriod.start, input.analysisPeriod.end)
    : null;
  const audienceEvidence = input.analysisPeriod
    ? assessEvidenceWindow({
        asOfDate: currentIsoDate(),
        sides: [{
          start: input.analysisPeriod.start,
          end: input.analysisPeriod.end,
          observedDays: input.readinessContext?.sourceObservedDays?.audience ??
            Math.max(...input.audiencePlans.map((item) => item.observedDays ?? 0), 0)
        }]
      })
    : null;
  const uniquePlans = new Map<string, {
    base: AudiencePlanItem;
    clicks: number | null;
    roiW: number;
    guidedW: number;
    newW: number;
    roiWeight: number;
    guidedWeight: number;
    newWeight: number;
    observedDays?: number;
  }>();
  for (const item of input.audiencePlans) {
    const key = [item.planId, item.audienceName, item.subjectId ?? "missing-subject"].join("|||");
    const previous = uniquePlans.get(key);
    const clickWeight = item.clicks !== null && item.clicks > 0 ? item.clicks : 0;
    if (!previous) {
      uniquePlans.set(key, {
        base: item,
        clicks: item.clicks,
        roiW: item.roi !== null ? item.roi * clickWeight : 0,
        guidedW: item.guidedPotentialCustomerRatio !== null ? item.guidedPotentialCustomerRatio * clickWeight : 0,
        newW: item.newCustomerRatio !== null ? item.newCustomerRatio * clickWeight : 0,
        roiWeight: item.roi !== null ? clickWeight : 0,
        guidedWeight: item.guidedPotentialCustomerRatio !== null ? clickWeight : 0,
        newWeight: item.newCustomerRatio !== null ? clickWeight : 0,
        observedDays: item.observedDays
      });
    } else {
      previous.clicks = previous.clicks === null && item.clicks === null
        ? null
        : (previous.clicks ?? 0) + (item.clicks ?? 0);
      previous.roiW += item.roi !== null ? item.roi * clickWeight : 0;
      previous.guidedW += item.guidedPotentialCustomerRatio !== null ? item.guidedPotentialCustomerRatio * clickWeight : 0;
      previous.newW += item.newCustomerRatio !== null ? item.newCustomerRatio * clickWeight : 0;
      previous.roiWeight += item.roi !== null ? clickWeight : 0;
      previous.guidedWeight += item.guidedPotentialCustomerRatio !== null ? clickWeight : 0;
      previous.newWeight += item.newCustomerRatio !== null ? clickWeight : 0;
      if (item.observedDays !== undefined) {
        previous.observedDays = Math.max(previous.observedDays ?? 0, item.observedDays);
      }
    }
  }
  const mergedPlans = [...uniquePlans.values()].map((entry) => ({
    ...entry.base,
    clicks: entry.clicks,
    roi: entry.roiWeight > 0 ? entry.roiW / entry.roiWeight : null,
    guidedPotentialCustomerRatio: entry.guidedWeight > 0 ? entry.guidedW / entry.guidedWeight : null,
    newCustomerRatio: entry.newWeight > 0 ? entry.newW / entry.newWeight : null,
    observedDays: entry.observedDays
  }));
  return mergedPlans
    .map((item) => {
      // 名称只用于展示，绝不作为静默关联键；经济边界必须依赖稳定 subjectId。
      const investment = item.subjectId ? investmentById.get(item.subjectId) : undefined;
      const breakthrough = investment ? breakthroughById.get(investment.productId) : undefined;
      const rate = investment ? effectiveContributionRate(investment, breakthrough) : null;
      const roiFloor = rate !== null && rate > 0 ? 1 / rate : null;
      const maxCpaEstimate = investment && rate !== null && rate > 0 && (investment.historicalAov ?? 0) > 0
        ? (investment.historicalAov as number) * rate
        : null;
      // 缺少付费人群真实 CVR，不能把搜索/整店 CVR 冒充为精确 max CPC。
      const maxCpcProxy = null;
      // 有点击时 ROI=0 是真实“零回报”信号，应进入暂停/重测，而不是被当成缺失。
      const validRoi = (item.clicks ?? 0) > 0 && item.roi !== null && Number.isFinite(item.roi) && item.roi >= 0;
      const safety = validRoi && roiFloor !== null ? (item.roi as number) / roiFloor : null;
      const enoughSample = (item.clicks ?? 0) >= 100;
      const testableSample = (item.clicks ?? 0) >= 50;
      const windowComplete = expectedDays === null || audienceEvidence?.conclusionAllowed === true;
      const economicallySafe = safety !== null && safety >= 1;
      const status: NetworkFindingStatus =
        item.type === "观察" || !investment || !testableSample || safety === null || !windowComplete
          ? "insufficient"
          : enoughSample && economicallySafe
            ? "positive"
            : economicallySafe
              ? "warning"
              : "critical";
      const bidText = windowComplete
        ? relativeBidSuggestion(safety, item.clicks ?? 0)
        : "分析窗覆盖不完整：不提供出价或新增预算，先补齐分日数据";
      return {
        id: `audience-${item.planId}-${item.audienceName}-${item.subjectId ?? "missing-subject"}`,
        title: `${item.type} · ${item.audienceName}`,
        role: item.type,
        productId: item.subjectId,
        productName: item.subjectName,
        audienceName: item.audienceName,
        planId: item.planId,
        clicks: item.clicks,
        roi: validRoi ? item.roi : null,
        roiFloor,
        maxCpaEstimate,
        maxCpcProxy,
        startingBidSuggestion: bidText,
        budgetStep: roleBudgetStep(item.type),
        finding: finding({
          id: `audience-${item.planId}-${item.audienceName}-finding`,
          title: `${item.type} · ${item.audienceName}`,
          status,
          conclusion: `${item.audienceName}当前 ${item.clicks ?? "—"} 次点击、ROI ${validRoi ? (item.roi as number).toFixed(2) : "不可用"}。${bidText}；${roleAction(item.type)}`,
          proof: [
            `样本点击 ${item.clicks ?? "—"}${(item.clicks ?? 0) < 50 ? "（不足）" : (item.clicks ?? 0) < 100 ? "（仅小测）" : "（可作方向证据）"}`,
            ...(validRoi ? [`历史 ROI 点击加权代理 ${(item.roi as number).toFixed(2)}`] : []),
            `引潜占比 ${percent(item.guidedPotentialCustomerRatio)}，新客占比 ${percent(item.newCustomerRatio)}`,
            ...(roiFloor !== null ? [`商品经济模型 ROI 底线约 ${roiFloor.toFixed(2)}`] : [])
          ],
          cannotProve: [
            "当前人群表缺少花费、成交与支付金额，不能验证人群级 CPA、CPC 与贡献利润。",
            "缺少付费人群真实转化率，不能给人民币精确 CPC 上限或精确起投价。",
            "历史 ROI 不能证明追投后的边际 ROI。"
          ],
          requiredData: [
            "人群级花费、当前出价/CPC、展现、成交数、支付金额",
            "新买家数、首购贡献利润、复购 Cohort 与 LTV",
            ...(!windowComplete ? [`该人群完整覆盖分析窗 ${expectedDays ?? "待确认"} 个自然日`] : []),
            ...(!investment ? ["人群主体 ID 与商品主数据映射"] : [])
          ],
          confidenceScore: !investment || !windowComplete ? 22 : enoughSample ? 52 : testableSample ? 40 : 28,
          reasons: [investment ? "已用 subjectId 关联商品经济模型" : "缺少稳定商品关联", windowComplete ? "人群分日覆盖完整" : "人群分日覆盖不完整", enoughSample ? "点击样本达到方向门槛" : testableSample ? "仅达到小测门槛" : "点击样本不足"]
        })
      } satisfies AudienceRecommendation;
    })
    .sort((left, right) => severityRank(right.finding.status) - severityRank(left.finding.status) || (right.clicks ?? 0) - (left.clicks ?? 0))
    .slice(0, 18);
}

function buildBudgetGates(input: {
  readiness: NetworkReadiness;
  outcome: OperatingOutcome;
  potentialProducts: PotentialProduct[];
  dimensionShortfalls: ProductDimensionShortfall[];
  audienceRecommendations: AudienceRecommendation[];
}): BudgetGate[] {
  const dataStatus: BudgetGate["status"] =
    input.readiness.requiredSourcesComplete &&
    (input.readiness.audienceProductMatchRate ?? 0) >= 0.8 &&
    input.readiness.score >= 80
      ? "pass"
      : input.readiness.score >= 50
        ? "conditional"
        : "fail";
  const profitStatus: BudgetGate["status"] =
    input.outcome.health === "无法判断" || input.readiness.profitEvidenceCoverage === 0
      ? "fail"
      : !input.readiness.sourcePeriodsAligned || input.readiness.profitEvidenceCoverage !== 1
        ? input.outcome.health === "亏损失控" ? "fail" : "conditional"
      : input.outcome.health === "健康盈利"
        ? "pass"
        : input.outcome.health === "亏损失控"
          ? "fail"
          : "conditional";
  const hasCore = input.potentialProducts.some((item) => item.pool === "核心潜力池" || item.pool === "现金流池");
  const hasVerifiedCore = input.potentialProducts.some(
    (item) =>
      (item.pool === "核心潜力池" || item.pool === "现金流池") &&
      (item.opportunityConfidence === "A" || item.opportunityConfidence === "B")
  );
  const hasTestableProduct = input.potentialProducts.some(
    (item) => item.finding.status !== "critical" && item.finding.status !== "insufficient" && item.pool !== "观察退出池"
  );
  const productStatus: BudgetGate["status"] = hasVerifiedCore && !input.dimensionShortfalls.some((item) => item.finding.status === "critical")
    ? "pass"
    : hasCore || hasTestableProduct
      ? "conditional"
      : "fail";
  const safeAudience = input.audienceRecommendations.some((item) => item.finding.status === "positive");
  const testableAudience = input.audienceRecommendations.some(
    (item) =>
      Boolean(item.productId) && (item.clicks ?? 0) >= 50 && item.roiFloor !== null &&
      (item.finding.status === "positive" || item.finding.status === "warning")
  );
  // 当前人群结果没有花费、成交、支付与真实 CVR，即使方向安全也只能进入补证小测，不能解锁放量。
  const audienceStatus: BudgetGate["status"] = testableAudience ? "conditional" : "fail";
  return [
    gate("gate-data", "G1 数据闸门", dataStatus, "核心源表、参数填写与跨表关联达到可诊断水平", input.readiness.finding),
    gate("gate-profit", "G2 利润闸门", profitStatus, "贡献利润和目标保留利润率允许承担新增测试", input.outcome.finding),
    gate(
      "gate-product",
      "G3 商品闸门",
      productStatus,
      "投资对象进入核心/现金流池，且关键商品短板已修复或有明确验证方案",
      combineFinding("gate-product-finding", "商品闸门", productStatus, input.potentialProducts.map((item) => item.finding))
    ),
    gate(
      "gate-audience",
      "G4 人群闸门",
      audienceStatus,
      safeAudience
        ? "已有方向性安全信号，但需补齐人群成本、成交与真实转化后才能通过"
        : "需有匹配商品且达到经济底线的小样本人群，并补齐成本与转化数据",
      combineFinding("gate-audience-finding", "人群闸门", audienceStatus, input.audienceRecommendations.map((item) => item.finding))
    ),
    gate(
      "gate-scale",
      "G5 放量闸门",
      "conditional",
      "动作后窗贡献利润、退款与 ROI 连续达标后，才释放下一档预算",
      finding({
        id: "gate-scale-finding",
        title: "放量闸门",
        status: "warning",
        conclusion: "请在下方效果验证中选择已登记动作；只有前后窗完整且结果连续达标，才由经营负责人确认解锁。当前经营网络快照不自动放量。",
        proof: [],
        cannotProve: ["历史表现不能替代本轮增量测试结果。"],
        requiredData: ["在下方效果验证中登记动作，并形成完整、连续的等长前后窗结果"],
        confidenceScore: 35,
        reasons: ["缺少本轮动作后窗"]
      })
    )
  ];
}

function buildActions(input: {
  readiness: NetworkReadiness;
  outcome: OperatingOutcome;
  investmentSpace: InvestmentSpace;
  potentialProducts: PotentialProduct[];
  dimensionShortfalls: ProductDimensionShortfall[];
  audienceRecommendations: AudienceRecommendation[];
  budgetGates: BudgetGate[];
}): NetworkAction[] {
  const actions: NetworkAction[] = [];
  if (input.readiness.score < 80) {
    actions.push(action({
      id: "action-data",
      title: "补齐数据与商品参数",
      owner: "数据/运营",
      priority: "P1",
      status: "ready",
      dependsOn: [],
      gateIds: [],
      metric: "诊断就绪度 ≥ 80，商品填写覆盖率 ≥ 80%",
      stopCondition: "时间线错位或跨表关联率未核验时停止下游放量",
      finding: input.readiness.finding
    }));
  }
  if (
    input.readiness.score < 25 &&
    input.potentialProducts.length === 0 &&
    input.dimensionShortfalls.length === 0 &&
    input.audienceRecommendations.length === 0
  ) {
    return actions;
  }
  if (input.outcome.finding.status !== "positive") {
    actions.push(action({
      id: "action-profit",
      title: "修复利润底线与主要漏损",
      owner: "经营负责人",
      priority: "P1",
      status: input.readiness.score >= 50 ? "ready" : "blocked",
      dependsOn: input.readiness.score < 80 ? ["action-data"] : [],
      gateIds: ["gate-profit"],
      metric: "贡献利润 > 0 且利润率达到目标保留线",
      stopCondition: "贡献利润继续为负或退款恶化时停止新增预算",
      finding: input.outcome.finding
    }));
  }
  const productActions = input.dimensionShortfalls.slice(0, 6).map((item, index) =>
    action({
      id: `action-${item.id}`,
      title: `修复 ${item.productName} 的${shortDimensionLabel(item)}`,
      owner: "商品运营",
      priority: index < 2 ? "P1" : "P2",
      status: item.finding.status === "insufficient" ? "blocked" : "ready",
      targetId: item.productId,
      category: shortDimensionLabel(item),
      dependsOn: input.readiness.score < 50 ? ["action-data"] : [],
      gateIds: ["gate-product"],
      metric: `${shortDimensionLabel(item)}越过基准且利润/退款不恶化`,
      stopCondition: "连续一个验证窗无改善，或退款、利润同步恶化",
      finding: item.finding
    })
  );
  actions.push(...productActions);
  const productActionsById = new Map<string, string[]>();
  for (const item of productActions) {
    if (!item.targetId) continue;
    productActionsById.set(item.targetId, [...(productActionsById.get(item.targetId) ?? []), item.id]);
  }
  const audienceActions = [...input.audienceRecommendations]
      .filter((item) => item.role !== "观察")
      // 先保留最危险的暂停动作，再用剩余额度列可扩/待验证人群，避免截断后只剩“加预算”。
      .sort((left, right) => audienceActionRank(left.finding.status) - audienceActionRank(right.finding.status) || (right.clicks ?? 0) - (left.clicks ?? 0))
      .slice(0, 3)
      .map((item) => action({
        id: `action-${item.id}`,
        title: item.finding.status === "critical"
          ? `暂停并重测${item.role}人群：${item.audienceName}`
          : `搭建${item.role}计划：${item.audienceName}`,
        owner: "投放运营",
        priority: item.finding.status === "critical" ? "P1" : "P2",
        status: item.finding.status === "positive" ? "ready" : item.finding.status === "critical" ? "ready" : "conditional",
        targetId: item.productId,
        category: "人群投放",
        dependsOn: item.productId ? (productActionsById.get(item.productId) ?? []) : [],
        gateIds: ["gate-audience"],
        metric: `ROI ≥ ${item.roiFloor?.toFixed(2) ?? "待确认"}，并验证 CPA/CPC 与贡献利润`,
        stopCondition: "ROI 低于经济底线、贡献利润为负或样本不足仍持续消耗",
        finding: item.finding
      }));
  actions.push(...audienceActions);
  const budgetRelease = action({
    id: "action-budget-release",
    title: "释放首档测试预算",
    owner: "经营负责人",
    priority: "P2",
    status: input.budgetGates.slice(0, 4).every((item) => item.status === "pass") ? "ready" : "blocked",
    dependsOn: [...productActions, ...audienceActions].map((item) => item.id),
    gateIds: ["gate-data", "gate-profit", "gate-product", "gate-audience"],
    metric: "首档预算内达到贡献利润、ROI 与退款目标",
    stopCondition: "任一经济指标跌破止损线即暂停下一档释放",
    finding: input.investmentSpace.finding
  });
  actions.push(budgetRelease);
  actions.push(action({
    id: "action-validation",
    title: "登记动作并完成前后窗验证",
    owner: "经营分析",
    priority: "P3",
    status: budgetRelease.status === "ready" ? "ready" : "blocked",
    dependsOn: ["action-budget-release"],
    gateIds: ["gate-scale"],
    metric: "净销售、贡献利润、ROI、退款及关键短板同时复盘",
    stopCondition: "证据不足不进入规模化复用",
    finding: input.budgetGates.find((item) => item.id === "gate-scale")!.finding
  }));
  return actions;
}

function buildMilestones(input: {
  readiness: NetworkReadiness;
  outcome: OperatingOutcome;
  budgetGates: BudgetGate[];
}): NetworkMilestone[] {
  const specs = [
    {
      id: "milestone-m0",
      title: "M0 数据可诊断",
      horizon: "现在",
      objective: "源表、填写项、周期与关联键通过检查",
      success: ["诊断就绪度 ≥ 80", "无静默缺表或跨期混算"],
      stop: ["核心源缺失", "商品与人群主体无法关联"],
      source: input.readiness.finding
    },
    {
      id: "milestone-m1",
      title: "M1 商品可投",
      horizon: "第 1 周",
      objective: "核心 S 商品的优先短板完成小步修复",
      success: ["目标维度越过基准", "贡献利润与退款不恶化"],
      stop: ["短板无改善", "退款或利润显著恶化"],
      source: input.budgetGates[2].finding
    },
    {
      id: "milestone-m2",
      title: "M2 人群小测通过",
      horizon: "第 2 周",
      objective: "拉新、追投、收割分别形成可验证的小样本",
      success: ["ROI 不低于商品经济底线", "具备 CPA/CPC 与成交样本"],
      stop: ["低于 ROI 底线", "样本不足但预算持续消耗"],
      source: input.budgetGates[3].finding
    },
    {
      id: "milestone-m3",
      title: "M3 贡献利润验证",
      horizon: "第 3–4 周",
      objective: "确认动作后窗观察值达到预设目标，并保留非因果边界",
      success: ["贡献利润为正", "目标利润率、ROI 与退款同时达标"],
      stop: ["贡献利润转负", "新增销售不能覆盖新增投入"],
      source: input.outcome.finding
    },
    {
      id: "milestone-m4",
      title: "M4 阶梯放量",
      horizon: "第 2 月",
      objective: "每过一档闸门再释放下一档预算",
      success: ["连续两个验证窗稳定", "边际 ROI 未显著衰减"],
      stop: ["边际 ROI 跌破底线", "库存或履约触顶"],
      source: input.budgetGates[4].finding
    },
    {
      id: "milestone-m5",
      title: "M5 经验复用",
      horizon: "季度复盘",
      objective: "沉淀商品 × 人群 × 动作 × 效果的可复用打法",
      success: ["至少两轮可重复验证", "证据、动作与结果可追溯"],
      stop: ["仅有单次偶然结果", "关键口径发生变化"],
      source: input.budgetGates[4].finding
    }
  ];
  return specs.map((item) => ({
    id: item.id,
    title: item.title,
    horizon: item.horizon,
    objective: item.objective,
    successCriteria: item.success,
    stopConditions: item.stop,
    finding: item.source
  }));
}

function effectiveContributionRate(
  investment: ProductInvestmentResult,
  breakthrough?: ProductBreakthroughResult
) {
  if (investment.profitEvidenceAvailable !== true || (investment.netSales ?? 0) <= 0) return null;
  const refundDimension = breakthrough?.dimensions.find((item) => item.key === "refundRate");
  if (!refundDimension || dimensionLooksMissing(refundDimension)) return null;
  const refundRate = refundDimension.value;
  if (refundRate === null) return null;
  return Math.max((1 - clamp(refundRate, 0, 1)) * (investment.grossMarginRate - investment.attackDefenseMarginRate), 0);
}

function finding(input: {
  id: string;
  title: string;
  conclusion: string;
  status: NetworkFindingStatus;
  proof: string[];
  cannotProve: string[];
  requiredData: string[];
  confidenceScore: number;
  reasons: string[];
}): NetworkFinding {
  const score = clamp(input.confidenceScore, 0, 100);
  return {
    id: input.id,
    title: input.title,
    conclusion: input.conclusion,
    status: input.status,
    proof: unique(input.proof),
    cannotProve: unique(input.cannotProve),
    requiredData: unique(input.requiredData),
    confidence: {
      score,
      level: score >= 75 ? "high" : score >= 48 ? "medium" : "low",
      reasons: unique(input.reasons)
    }
  };
}

function gate(
  id: string,
  title: string,
  status: BudgetGate["status"],
  criterion: string,
  source: NetworkFinding
): BudgetGate {
  return { id, title, status, criterion, finding: { ...source, id: `${id}-finding`, title } };
}

function combineFinding(
  id: string,
  title: string,
  status: BudgetGate["status"],
  findings: NetworkFinding[]
) {
  const confidence = findings.length ? median(findings.map((item) => item.confidence.score)) : 15;
  return finding({
    id,
    title,
    status: status === "pass" ? "positive" : status === "fail" ? "critical" : "warning",
    conclusion: status === "pass" ? `${title}已通过。` : status === "fail" ? `${title}未通过。` : `${title}需有条件验证。`,
    proof: findings.flatMap((item) => item.proof).slice(0, 4),
    cannotProve: findings.flatMap((item) => item.cannotProve).slice(0, 3),
    requiredData: findings.flatMap((item) => item.requiredData).slice(0, 4),
    confidenceScore: confidence,
    reasons: findings.flatMap((item) => item.confidence.reasons).slice(0, 3)
  });
}

function action(input: NetworkAction): NetworkAction {
  return input;
}

function roleAction(role: AudiencePlanItem["type"]) {
  if (role === "拉新") return "先用冷人群小样本验证新客获取成本。";
  if (role === "追投") return "围绕已互动未成交人群缩短追投窗口并控制频次。";
  if (role === "收割") return "优先高意图与老客再营销，守住利润与频控。";
  return "保持观察，补足成本、转化与意图证据后再归类。";
}

function roleBudgetStep(role: AudiencePlanItem["type"]) {
  if (role === "拉新") return "探索小测 → 新客成本验证 → 达标后加码（各档占获批测试预算比例待确认）";
  if (role === "追投") return "追投小测 → 边际 ROI 稳定 → 达标后阶梯加码（各档比例待确认）";
  if (role === "收割") return "高意图小测 → 利润与频控达标 → 优先承接（各档比例待确认）";
  return "不释放新增预算，只补充样本与成本证据";
}

function relativeBidSuggestion(safety: number | null, clicks: number) {
  if (clicks < 50 || safety === null || !Number.isFinite(safety)) {
    return "证据不足：不提供出价或新增预算，先补齐退款、真实成本与转化";
  }
  if (safety >= 1.2) return "相对当前平台出价按 1.0–1.1 倍小测，仍需受商品经济上限约束";
  if (safety >= 1) return "相对当前平台出价按 0.9–1.0 倍守线测试，不直接加价";
  return "相对当前平台出价降至 0.7–0.9 倍重测，或暂停该人群";
}

function audienceActionRank(status: NetworkFindingStatus) {
  return status === "critical" ? 0 : status === "positive" ? 1 : status === "warning" ? 2 : 3;
}

function poolRank(pool: PotentialPool) {
  return ["核心潜力池", "效率修复池", "利润修复池", "现金流池", "高风险测试池", "观察退出池"].indexOf(pool);
}

function severityRank(status: NetworkFindingStatus) {
  return status === "critical" ? 4 : status === "warning" ? 3 : status === "insufficient" ? 2 : 1;
}

function dimensionLooksMissing(dimension: BreakthroughDimensionScore) {
  return dimension.available === false || dimension.value === null || dimension.threshold === null ||
    (dimension.available === undefined && dimension.value === 0 && dimension.threshold === 0);
}

function dimensionPassedInclusive(dimension: BreakthroughDimensionScore) {
  if (dimensionLooksMissing(dimension)) return false;
  return dimension.higherIsBetter
    ? (dimension.value as number) >= (dimension.threshold as number)
    : (dimension.value as number) <= (dimension.threshold as number);
}

function shortDimensionLabel(item: ProductDimensionShortfall) {
  const labels: Record<BreakthroughDimensionScore["key"], string> = {
    searchDisplayValue: "搜索展现价值",
    searchPaymentConversionRate: "搜索支付转化率",
    averageStaySeconds: "平均停留时长",
    bounceRate: "跳失率",
    refundRate: "退款率",
    attachPurchaseRate: "连带购买率",
    attachCategoryWidth: "连带类目宽度",
    repurchaseRate: "复购率"
  };
  return labels[item.dimensionKey];
}

function metricValue(dimension: BreakthroughDimensionScore) {
  if (dimension.value === null) return "—";
  if (dimension.key === "searchDisplayValue") return money(dimension.value);
  if (dimension.key === "averageStaySeconds" || dimension.key === "attachCategoryWidth") return dimension.value.toFixed(2);
  return percent(dimension.value);
}

function metricThreshold(dimension: BreakthroughDimensionScore) {
  if (dimension.threshold === null) return "—";
  if (dimension.key === "searchDisplayValue") return money(dimension.threshold);
  if (dimension.key === "averageStaySeconds" || dimension.key === "attachCategoryWidth") return dimension.threshold.toFixed(2);
  return percent(dimension.threshold);
}

function shapleyContributions<K extends string>(
  keys: readonly K[],
  previous: Record<K, number>,
  current: Record<K, number>,
  evaluate: (values: Record<K, number>) => number
): Record<K, number> {
  const totals = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
  const permutations = permute([...keys]);
  for (const order of permutations) {
    const state = { ...previous };
    let before = evaluate(state);
    for (const key of order) {
      state[key] = current[key];
      const after = evaluate(state);
      totals[key] += after - before;
      before = after;
    }
  }
  for (const key of keys) totals[key] /= permutations.length;
  return totals;
}

function permute<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permute([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest])
  );
}

function median(values: number[]) {
  const rows = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return 0;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[mid] : (rows[mid - 1] + rows[mid]) / 2;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function sumKnown(values: Array<number | null>) {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return known.length > 0 ? sum(known) : null;
}

function changeRate(current: number, previous: number) {
  return previous === 0 ? null : (current - previous) / Math.abs(previous);
}

function inclusiveDays(start: string, end: string) {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  return Number.isFinite(from) && Number.isFinite(to) && to >= from
    ? Math.floor((to - from) / 86_400_000) + 1
    : null;
}

function isFullNaturalMonth(period: { start: string; end: string }) {
  const [startYear, startMonth, startDay] = period.start.split("-").map(Number);
  const [endYear, endMonth, endDay] = period.end.split("-").map(Number);
  if (startYear !== endYear || startMonth !== endMonth || startDay !== 1) return false;
  const lastDay = new Date(Date.UTC(startYear, startMonth, 0)).getUTCDate();
  return endDay === lastDay;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function unique(values: string[]) {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function money(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 0 }).format(value);
}

function percent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 }).format(value);
}

function trendText(value: number | null) {
  if (value === null) return "无法比较";
  return `${value >= 0 ? "上升" : "下降"}${percent(Math.abs(value))}`;
}
