import type {
  AudiencePlanItem,
  AudienceSourceRow,
  BreakthroughDimensionScore,
  CalcRun,
  DamoProductRow,
  Lifecycle,
  ManagementDashboard,
  PrefillItem,
  ProfitMarginMatrix,
  ProductBreakthroughResult,
  ProductGrade,
  ProductInvestmentResult,
  ProductSourceRow,
  PromotionProductRow
} from "@/lib/types/domain";
import { aggregateManagementDashboard } from "@/lib/management-aggregation";
import { assessEvidenceWindow } from "@/lib/analysis-evidence";
import { countInclusiveDays } from "@/lib/analysis-period";
import { currentIsoDate } from "@/lib/comparison-window";
import { divideOrNull } from "@/lib/safe-math";

interface PromotionSummary {
  cost: number | null;
  clicks: number | null;
  averageClickCost: number | null;
  roi: number | null;
  observedDays?: number;
}

export interface ThreeStageInput {
  cycleId: string;
  productSourceRows: ProductSourceRow[];
  damoProductRows: DamoProductRow[];
  promotionProductRows: PromotionProductRow[];
  audienceSourceRows: AudienceSourceRow[];
  prefillItems: PrefillItem[];
  marginMatrix?: ProfitMarginMatrix;
  analysisPeriod?: { start: string; end: string };
  /** 推广分日源是否在店铺层完整覆盖分析窗；完整时，商品无推广行代表该窗推广成本为 0。 */
  promotionSourceWindowComplete?: boolean;
  /** 三张分日源在店铺层的真实覆盖天数；实体没有经营活动不等于源数据缺日。 */
  sourceObservedDays?: Partial<Record<"product" | "promotion" | "audience", number>>;
}

export const lifecycleColumns: Lifecycle[] = [
  "冷启期",
  "新品成长期",
  "成长期",
  "新品打爆期",
  "爆品期",
  "平销期"
];

export const gradeRows: ProductGrade[] = ["S", "A", "B", "C"];

export const marginMatrix: ProfitMarginMatrix = {
  S: {
    冷启期: -0.2,
    新品成长期: -0.15,
    成长期: -0.1,
    新品打爆期: 0.05,
    爆品期: 0.1,
    平销期: 0.15
  },
  A: {
    冷启期: -0.15,
    新品成长期: -0.1,
    成长期: -0.05,
    新品打爆期: 0.05,
    爆品期: 0.1,
    平销期: 0.15
  },
  B: {
    冷启期: -0.05,
    新品成长期: 0,
    成长期: 0.05,
    新品打爆期: 0.1,
    爆品期: 0.15,
    平销期: 0.2
  },
  C: {
    冷启期: 0,
    新品成长期: 0.05,
    成长期: 0.1,
    新品打爆期: 0.1,
    爆品期: 0.15,
    平销期: 0.2
  }
};

const dimensionLabels: Record<BreakthroughDimensionScore["key"], string> = {
  searchDisplayValue: "搜索展现价值",
  searchPaymentConversionRate: "搜索支付转化率",
  averageStaySeconds: "平均停留时长(秒)",
  bounceRate: "跳失率",
  refundRate: "退款率",
  attachPurchaseRate: "连带购买率",
  attachCategoryWidth: "连带购买叶子类目宽度",
  repurchaseRate: "复购率"
};

const higherIsBetter: Record<BreakthroughDimensionScore["key"], boolean> = {
  searchDisplayValue: true,
  searchPaymentConversionRate: true,
  averageStaySeconds: true,
  bounceRate: false,
  refundRate: false,
  attachPurchaseRate: true,
  attachCategoryWidth: true,
  repurchaseRate: true
};

export function runThreeStageCalculation(input: ThreeStageInput): CalcRun {
  const investmentResults = buildInvestmentResults(input);
  const breakthroughResults = buildBreakthroughResults(input);
  const audiencePlans = buildAudiencePlans(input.audienceSourceRows);
  const managementDashboard = {
    ...buildManagementDashboard(investmentResults),
    ...(input.analysisPeriod ? { analysisPeriod: input.analysisPeriod } : {})
  };

  return {
    id: `calc-${input.cycleId}-latest`,
    cycleId: input.cycleId,
    createdAt: new Date().toISOString(),
    ...(input.analysisPeriod ? { analysisPeriod: input.analysisPeriod } : {}),
    investmentResults,
    breakthroughResults,
    audiencePlans,
    managementDashboard
  };
}

export function buildInvestmentResults(input: ThreeStageInput): ProductInvestmentResult[] {
  const productById = new Map(input.productSourceRows.map((row) => [row.productId, row]));
  const damoById = new Map(input.damoProductRows.map((row) => [row.productId, row]));
  const promoById = summarizePromotionRows(input.promotionProductRows);
  const activeMarginMatrix = input.marginMatrix ?? marginMatrix;
  const expectedDays = input.analysisPeriod
    ? countInclusiveDays(input.analysisPeriod.start, input.analysisPeriod.end)
    : null;
  // 冷启期新品没有历史成交，AOV/转化率都是 0。若直接相除，规划月订单数、规划月流量、
  // 月付费预估会全部归零——最需要"目标→流量→预算"测算的商品反而拿不到任何建议。
  // 这里回退到同分层、否则全店的实测中位数作为估算基准，并在结果上标注 estimated。
  const planningBenchmarks = buildPlanningBenchmarks(input.prefillItems, productById, promoById);

  return input.prefillItems.map((item) => {
    const product = productById.get(item.productId);
    const damo = damoById.get(item.productId);
    const promotion = promoById.get(item.productId);
    const lifecycle = damo?.growthStage ?? "冷启期";
    // 进入计算的商品分层一定已填写（runCalculation 已按 isPrefillReady 过滤）。
    const grade = (item.grade || "C") as ProductGrade;
    const attackDefenseMarginRate =
      activeMarginMatrix[grade]?.[lifecycle] ??
      marginMatrix[grade]?.[lifecycle] ??
      marginMatrix.C[lifecycle] ??
      0;
    const paymentAmount = product?.paymentAmount ?? null;
    const refundAmount = product?.refundAmount ?? null;
    const netSales = paymentAmount !== null && refundAmount !== null
      ? paymentAmount - refundAmount
      : null;
    const paymentBuyers = product?.paymentBuyers ?? null;
    const historicalAov = paymentAmount === null || paymentBuyers === null
      ? null
      : divideOrNull(paymentAmount, paymentBuyers);
    const observedConversionRate = product?.productPaymentConversionRate ?? null;
    // 无历史成交时用同分层/全店中位数兜底，让新品也能算出规划流量与付费预估。
    const benchmark = planningBenchmarks.resolve(grade);
    const planningAov = (historicalAov ?? 0) > 0 ? historicalAov : benchmark.aov;
    const planningConversionRate =
      (observedConversionRate ?? 0) > 0
        ? observedConversionRate
        : item.competitorConversionExpectation && item.competitorConversionExpectation > 0
          ? item.competitorConversionExpectation
          : benchmark.conversionRate;
    const estimatedAov = (historicalAov ?? 0) <= 0 && (planningAov ?? 0) > 0;
    const estimatedConversion = (observedConversionRate ?? 0) <= 0 && (planningConversionRate ?? 0) > 0;
    const plannedMonthlyOrders = planningAov === null
      ? null
      : divideOrNull(item.monthlyGsvOpportunity, planningAov);
    const plannedMonthlyTraffic = plannedMonthlyOrders === null || planningConversionRate === null
      ? null
      : divideOrNull(plannedMonthlyOrders, planningConversionRate);
    const historicalPpc = promotion?.averageClickCost ?? null;
    // 新品同样没有历史点击成本；用中位 PPC 兜底，否则月付费预估恒为 0，
    // 运营看到"新品推广要花 0 元"这种明显错误的结论。
    const planningPpc = (historicalPpc ?? 0) > 0 ? historicalPpc : benchmark.ppc;
    const estimatedPpc = (historicalPpc ?? 0) <= 0 && (planningPpc ?? 0) > 0;
    const monthlyPaidEstimate = plannedMonthlyTraffic !== null && planningPpc !== null
      ? plannedMonthlyTraffic * item.paidVisitorRatio * planningPpc
      : null;
    const plannedGrossProfit = attackDefenseMarginRate * item.monthlyGsvOpportunity;
    const historicalGrossProfitWithoutPromotion = netSales === null
      ? null
      : netSales * item.grossMarginRate;
    // 利润必须扣除与商品分析窗一致的推广宝贝花费；达摩盘营销消耗是无日期快照，不能混入本窗。
    const productObservedDays = input.sourceObservedDays?.product ?? product?.observedDays ?? 0;
    const productWindowComplete = expectedDays === null
      ? Boolean(product)
      : productObservedDays >= expectedDays;
    // 推广报表只会出现实际投放的商品/日期，不能要求每个商品每天都有一行。
    // 店铺层推广源完整覆盖分析窗后，按主体ID自动关联；未出现的商品视为该窗推广成本为 0。
    const promotionObservedDays = input.sourceObservedDays?.promotion ??
      (input.promotionSourceWindowComplete && expectedDays !== null ? expectedDays : promotion?.observedDays ?? 0);
    const promotionWindowComplete = input.promotionSourceWindowComplete ?? (
      expectedDays === null ? Boolean(promotion) : promotionObservedDays >= expectedDays
    );
    const missingProfitFields = [
      !product ? "商品经营记录" : "",
      paymentAmount === null ? "支付金额" : "",
      refundAmount === null ? "退款金额" : "",
      promotion && promotion.cost === null ? "推广花费" : ""
    ].filter(Boolean);
    const profitEvidence = input.analysisPeriod
      ? assessEvidenceWindow({
          asOfDate: currentIsoDate(),
          sides: [{
            start: input.analysisPeriod.start,
            end: input.analysisPeriod.end,
            observedDays: Math.min(productObservedDays, promotionObservedDays)
          }],
          missingFields: [
            ...missingProfitFields,
            ...(!productWindowComplete ? ["商品源完整窗口"] : []),
            ...(!promotionWindowComplete ? ["推广源完整窗口"] : [])
          ]
        })
      : null;
    const profitEvidenceAvailable = profitEvidence
      ? profitEvidence.conclusionAllowed
      : productWindowComplete && promotionWindowComplete && missingProfitFields.length === 0;
    // 店铺层推广源完整时，“该商品没有推广行”是真实的未投放 0；源不完整时则是未知 null。
    const promotionSpend = !promotionWindowComplete
      ? null
      : promotion
        ? promotion.cost
        : 0;
    const historicalGrossProfit = profitEvidenceAvailable && historicalGrossProfitWithoutPromotion !== null && promotionSpend !== null
      ? historicalGrossProfitWithoutPromotion - promotionSpend
      : null;
    const historicalMarginRate = historicalGrossProfit === null || netSales === null
      ? null
      : divideOrNull(historicalGrossProfit, netSales);
    const remainingAdBudget = historicalGrossProfit === null || netSales === null
      ? null
      : historicalGrossProfit - netSales * attackDefenseMarginRate;

    return {
      productId: item.productId,
      productName: product?.productName ?? item.productName,
      tagIds: item.tagIds ?? [],
      lifecycle,
      grade,
      grossMarginRate: item.grossMarginRate,
      attackDefenseMarginRate,
      monthlyGsvOpportunity: item.monthlyGsvOpportunity,
      plannedGrossProfit,
      historicalPpc,
      historicalAov,
      planningBasis: estimatedAov || estimatedConversion || estimatedPpc ? "estimated" : "observed",
      ...(estimatedAov || estimatedConversion || estimatedPpc
        ? {
            planningBasisNote: [
              estimatedAov ? `客单价取${benchmark.source}` : "",
              estimatedConversion
                ? (observedConversionRate ?? 0) <= 0 && item.competitorConversionExpectation
                  ? "转化率取竞品预期值"
                  : `转化率取${benchmark.source}`
                : "",
              estimatedPpc ? `点击成本取${benchmark.source}` : ""
            ]
              .filter(Boolean)
              .join("、")
          }
        : {}),
      plannedMonthlyOrders,
      plannedMonthlyTraffic,
      monthlyPaidEstimate,
      netSales,
      historicalGrossProfitWithoutPromotion,
      historicalGrossProfit,
      historicalMarginRate,
      profitEvidenceAvailable,
      promotionSpend,
      remainingAdBudget,
      salesGap: netSales === null ? null : netSales - item.monthlyGsvOpportunity
    };
  });
}

export function buildBreakthroughResults(input: ThreeStageInput): ProductBreakthroughResult[] {
  const productById = new Map(input.productSourceRows.map((row) => [row.productId, row]));
  const damoById = new Map(input.damoProductRows.map((row) => [row.productId, row]));
  const rawRows = input.prefillItems.map((item) => {
    const product = productById.get(item.productId);
    const damo = damoById.get(item.productId);
    const productObservedDays = input.sourceObservedDays?.product ?? product?.observedDays ?? 0;
    const productEvidence = input.analysisPeriod
      ? assessEvidenceWindow({
          asOfDate: currentIsoDate(),
          sides: [{
            start: input.analysisPeriod.start,
            end: input.analysisPeriod.end,
            observedDays: productObservedDays
          }],
          missingFields: product ? [] : ["商品经营记录"]
        })
      : null;
    const productWindowComplete = productEvidence
      ? productEvidence.conclusionAllowed
      : Boolean(product);
    const historicalAov = product?.paymentAmount === null || product?.paymentBuyers === null || !product
      ? null
      : divideOrNull(product.paymentAmount, product.paymentBuyers);
    return {
      item,
      lifecycle: damo?.growthStage ?? "冷启期",
      availability: {
        searchDisplayValue: Boolean(productWindowComplete && product && damo && (product.searchGuidedVisitors ?? 0) > 0 && historicalAov !== null && damo.freeSearchClickRate !== null && product.searchGuidedPaymentConversionRate !== null),
        searchPaymentConversionRate: Boolean(productWindowComplete && product && (product.searchGuidedVisitors ?? 0) > 0 && product.searchGuidedPaymentConversionRate !== null),
        averageStaySeconds: Boolean(productWindowComplete && product?.averageStaySeconds !== null),
        bounceRate: Boolean(productWindowComplete && product?.bounceRate !== null),
        refundRate: Boolean(productWindowComplete && (product?.paymentAmount ?? 0) > 0 && product?.refundAmount !== null),
        attachPurchaseRate: Boolean(damo?.attachPurchaseRate !== null && damo),
        attachCategoryWidth: Boolean(damo?.attachCategoryWidth !== null && damo),
        repurchaseRate: Boolean(damo?.repurchaseRate !== null && damo)
      } satisfies Record<BreakthroughDimensionScore["key"], boolean>,
      searchDisplayValue:
        product?.searchGuidedPaymentConversionRate !== null && product?.searchGuidedPaymentConversionRate !== undefined &&
        damo?.freeSearchClickRate !== null && damo?.freeSearchClickRate !== undefined && historicalAov !== null
          ? product.searchGuidedPaymentConversionRate * damo.freeSearchClickRate * historicalAov
          : null,
      searchPaymentConversionRate: product?.searchGuidedPaymentConversionRate ?? null,
      averageStaySeconds: product?.averageStaySeconds ?? null,
      bounceRate: product?.bounceRate ?? null,
      refundRate: product?.refundAmount !== null && product?.refundAmount !== undefined && product?.paymentAmount !== null && product?.paymentAmount !== undefined
        ? divideOrNull(product.refundAmount, product.paymentAmount)
        : null,
      attachPurchaseRate: damo?.attachPurchaseRate ?? null,
      attachCategoryWidth: damo?.attachCategoryWidth ?? null,
      repurchaseRate: damo?.repurchaseRate ?? null
    };
  });

  const thresholds = {
    searchDisplayValue: availableMedian(rawRows, "searchDisplayValue"),
    searchPaymentConversionRate: availableMedian(rawRows, "searchPaymentConversionRate"),
    averageStaySeconds: availableMedian(rawRows, "averageStaySeconds"),
    bounceRate: availableMedian(rawRows, "bounceRate"),
    refundRate: availableMedian(rawRows, "refundRate"),
    attachPurchaseRate: availableMedian(rawRows, "attachPurchaseRate"),
    attachCategoryWidth: availableMedian(rawRows, "attachCategoryWidth"),
    repurchaseRate: availableMedian(rawRows, "repurchaseRate")
  } satisfies Record<BreakthroughDimensionScore["key"], number | null>;

  return rawRows.map((row) => {
    const dimensions = Object.keys(thresholds).map((key) => {
      const typedKey = key as BreakthroughDimensionScore["key"];
      const value = row[typedKey];
      const threshold = thresholds[typedKey];
      const available = row.availability[typedKey];
      const passed = available && value !== null && threshold !== null &&
        (higherIsBetter[typedKey] ? value >= threshold : value <= threshold);
      return {
        key: typedKey,
        label: dimensionLabels[typedKey],
        value,
        threshold,
        available,
        passed,
        higherIsBetter: higherIsBetter[typedKey]
      };
    });
    const solutionCode = dimensions.map((dimension) => (dimension.passed ? "1" : "0")).join("");
    return {
      productId: row.item.productId,
      productCode: row.item.productCode,
      productName: row.item.productName,
      lifecycle: row.lifecycle,
      grade: (row.item.grade || "C") as ProductGrade,
      dimensions,
      score: dimensions.filter((dimension) => dimension.passed).length,
      solutionCode,
      solution: buildSolutionText(dimensions)
    };
  });
}

export function buildAudiencePlans(rows: AudienceSourceRow[]): AudiencePlanItem[] {
  const plans: AudiencePlanItem[] = [];
  for (const row of rows) {
    const item = {
      sceneName: row.sceneName,
      planId: row.planId,
      planName: row.planName,
      audienceName: row.audienceName,
      clicks: row.clicks,
      roi: row.roi,
      guidedPotentialCustomerRatio: row.guidedPotentialCustomerRatio,
      newCustomerRatio: row.newCustomerRatio,
      subjectId: row.subjectId,
      subjectName: row.subjectName,
      observedDays: row.observedDays
    };

    const guided = validRatio(row.guidedPotentialCustomerRatio);
    const newCustomer = validRatio(row.newCustomerRatio);
    if (guided === null || newCustomer === null) {
      plans.push({ ...item, guidedPotentialCustomerRatio: guided, newCustomerRatio: newCustomer, type: "观察" });
      continue;
    }

    if (guided >= 0.8 && newCustomer >= 0.8) {
      plans.push({ ...item, type: "拉新" });
      continue;
    }

    if (guided <= 0.5 && newCustomer > 0.5) {
      plans.push({ ...item, type: "追投" });
      continue;
    }

    if (guided <= 0.5 && newCustomer <= 0.5) {
      plans.push({ ...item, type: "收割" });
      continue;
    }

    // 中间区间不再静默丢弃：先进入观察池，待补成本、转化与更多样本后再决定计划角色。
    plans.push({ ...item, type: "观察" });
  }
  return plans;
}

export function buildManagementDashboard(
  investmentResults: ProductInvestmentResult[]
): ManagementDashboard {
  return aggregateManagementDashboard(investmentResults);
}

interface PlanningBenchmark {
  aov: number | null;
  conversionRate: number | null;
  ppc: number | null;
  source: string;
}

/**
 * 规划基准：按分层、以及全店，统计"有实测成交"的商品的客单价与支付转化率中位数。
 * 用中位数而非均值，避免个别高客单爆品把新品的规划流量算得过低。
 * 同分层样本不足（<3 个）时退到全店；全店也没有实测样本时返回 null，
 * 规划结果保持“无数据”，不会伪造成 0 订单或 0 推广费。
 */
function buildPlanningBenchmarks(
  prefillItems: PrefillItem[],
  productById: Map<string, ProductSourceRow>,
  promoById: Map<string, PromotionSummary>
) {
  const MIN_SAMPLE = 3;
  interface Bucket {
    aov: number[];
    conv: number[];
    ppc: number[];
  }
  const newBucket = (): Bucket => ({ aov: [], conv: [], ppc: [] });
  const byGrade = new Map<string, Bucket>();
  const overall = newBucket();

  for (const item of prefillItems) {
    const product = productById.get(item.productId);
    if (!product) continue;
    const grade = item.grade || "C";
    let bucket = byGrade.get(grade);
    if (!bucket) {
      bucket = newBucket();
      byGrade.set(grade, bucket);
    }
    const push = (key: keyof Bucket, value: number | null) => {
      if (value !== null && value > 0) {
        bucket![key].push(value);
        overall[key].push(value);
      }
    };
    push(
      "aov",
      product.paymentAmount !== null && product.paymentBuyers !== null
        ? divideOrNull(product.paymentAmount, product.paymentBuyers)
        : null
    );
    push("conv", product.productPaymentConversionRate);
    push("ppc", promoById.get(item.productId)?.averageClickCost ?? null);
  }

  const overallBenchmark: PlanningBenchmark = {
    aov: medianOrNull(overall.aov),
    conversionRate: medianOrNull(overall.conv),
    ppc: medianOrNull(overall.ppc),
    source: `全店 ${overall.aov.length} 个有成交商品的中位数`
  };

  return {
    resolve(grade: ProductGrade): PlanningBenchmark {
      const bucket = byGrade.get(grade);
      // 同层样本不足时退到全店；PPC 单独兜底，避免某一层恰好无人投放就整层失去基准。
      if (!bucket || bucket.aov.length < MIN_SAMPLE || bucket.conv.length < MIN_SAMPLE) {
        return overallBenchmark;
      }
      return {
        aov: medianOrNull(bucket.aov),
        conversionRate: medianOrNull(bucket.conv),
        ppc: bucket.ppc.length > 0 ? medianOrNull(bucket.ppc) : overallBenchmark.ppc,
        source: `同 ${grade} 层 ${bucket.aov.length} 个有成交商品的中位数`
      };
    }
  };
}

function summarizePromotionRows(rows: PromotionProductRow[]) {
  const grouped = new Map<string, {
    cost: number | null;
    clicks: number | null;
    roiCost: number;
    roiWeight: number;
    observedDays?: number;
  }>();
  for (const row of rows) {
    const current = grouped.get(row.subjectId) ?? {
      cost: null,
      clicks: null,
      roiCost: 0,
      roiWeight: 0
    };
    current.cost = addKnown(current.cost, row.cost);
    current.clicks = addKnown(current.clicks, row.clicks);
    if (row.roi !== null && row.cost !== null && row.cost > 0) {
      current.roiCost += row.roi * row.cost;
      current.roiWeight += row.cost;
    }
    if (row.observedDays !== undefined) {
      current.observedDays = Math.max(current.observedDays ?? 0, row.observedDays);
    }
    grouped.set(row.subjectId, current);
  }

  return new Map(
    [...grouped.entries()].map(([subjectId, value]) => [
      subjectId,
      {
        cost: value.cost,
        clicks: value.clicks,
        observedDays: value.observedDays,
        averageClickCost:
          value.cost !== null && value.clicks !== null && value.clicks > 0
            ? value.cost / value.clicks
            : null,
        roi: value.roiWeight > 0 ? value.roiCost / value.roiWeight : null
      }
    ])
  );
}

function addKnown(left: number | null, right: number | null): number | null {
  if (right === null) return left;
  return (left ?? 0) + right;
}

function buildSolutionText(dimensions: BreakthroughDimensionScore[]) {
  const failed = dimensions.filter((dimension) => dimension.available !== false && !dimension.passed);
  const unavailable = dimensions.filter((dimension) => dimension.available === false);
  if (failed.length === 0) {
    return unavailable.length > 0
      ? `可用维度已达到当前周期中位线；${unavailable.map((dimension) => dimension.label).join("、")}缺少关联源数据，补齐后再判断。`
      : "八项指标均达到当前周期样本中位线，可作为候选样板；仍需通过利润、人群与效果闸门后才能安排测试。";
  }

  const lead = failed.slice(0, 3).map((dimension) => dimension.label).join("、");
  const actions = failed
    .slice(0, 3)
    .map((dimension) => solutionByDimension[dimension.key])
    .join(" ");
  return `${lead}未达标。${actions}`;
}

const solutionByDimension: Record<BreakthroughDimensionScore["key"], string> = {
  searchDisplayValue: "优化主图首屏、标题关键词和搜索承接，让搜索点击价值先超过中位线。",
  searchPaymentConversionRate: "重排详情页卖点、客服接待和价格权益，提升搜索流量成交效率。",
  averageStaySeconds: "补强主图视频、首屏证据和评价内容，延长有效停留。",
  bounceRate: "降低首屏跳失，优先处理不清晰卖点、弱信任组件和加载体验。",
  refundRate: "定位退款原因，修正规格表达、售后预期和品控风险。",
  attachPurchaseRate: "增加搭配套装、关联推荐和组合优惠，提升连带购买。",
  attachCategoryWidth: "扩展可连带叶子类目，形成从单品到货盘组合的导购路径。",
  repurchaseRate: "建立复购提醒、会员权益和老客专属组合，降低一次性购买流失。"
};

function medianOrNull(values: number[]) {
  const numeric = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (numeric.length === 0) {
    return null;
  }
  const mid = Math.floor(numeric.length / 2);
  return numeric.length % 2 === 0 ? (numeric[mid - 1] + numeric[mid]) / 2 : numeric[mid];
}

function validRatio(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function availableMedian<
  T extends { availability: Record<BreakthroughDimensionScore["key"], boolean> } &
    Record<BreakthroughDimensionScore["key"], number | null>
>(rows: T[], key: BreakthroughDimensionScore["key"]) {
  return medianOrNull(
    rows
      .filter((row) => row.availability[key])
      .map((row) => row[key])
      .filter((value): value is number => value !== null)
  );
}
