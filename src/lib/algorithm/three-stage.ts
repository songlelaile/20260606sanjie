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

export interface ThreeStageInput {
  cycleId: string;
  productSourceRows: ProductSourceRow[];
  damoProductRows: DamoProductRow[];
  promotionProductRows: PromotionProductRow[];
  audienceSourceRows: AudienceSourceRow[];
  prefillItems: PrefillItem[];
  marginMatrix?: ProfitMarginMatrix;
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
  const managementDashboard = buildManagementDashboard(investmentResults);

  return {
    id: `calc-${input.cycleId}-latest`,
    cycleId: input.cycleId,
    createdAt: new Date().toISOString(),
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
    const paymentAmount = product?.paymentAmount ?? 0;
    const refundAmount = product?.refundAmount ?? 0;
    const netSales = paymentAmount - refundAmount;
    const paymentBuyers = product?.paymentBuyers ?? 0;
    const historicalAov = safeDivide(paymentAmount, paymentBuyers);
    const plannedMonthlyOrders = safeDivide(item.monthlyGsvOpportunity, historicalAov);
    const plannedMonthlyTraffic = safeDivide(
      plannedMonthlyOrders,
      product?.productPaymentConversionRate ?? 0
    );
    const historicalPpc = promotion?.averageClickCost ?? 0;
    const monthlyPaidEstimate = plannedMonthlyTraffic * item.paidVisitorRatio * historicalPpc;
    const plannedGrossProfit = attackDefenseMarginRate * item.monthlyGsvOpportunity;
    const historicalGrossProfitWithoutPromotion = netSales * item.grossMarginRate;
    const historicalGrossProfit =
      historicalGrossProfitWithoutPromotion - (damo?.marketingSpend ?? 0);
    const historicalMarginRate = safeDivide(historicalGrossProfit, netSales);
    const remainingAdBudget =
      historicalMarginRate === 0
        ? 0
        : (historicalMarginRate - attackDefenseMarginRate) *
          safeDivide(historicalGrossProfit, historicalMarginRate);

    return {
      productId: item.productId,
      productName: product?.productName ?? item.productName,
      lifecycle,
      grade,
      grossMarginRate: item.grossMarginRate,
      attackDefenseMarginRate,
      monthlyGsvOpportunity: item.monthlyGsvOpportunity,
      plannedGrossProfit,
      historicalPpc,
      historicalAov,
      plannedMonthlyOrders,
      plannedMonthlyTraffic,
      monthlyPaidEstimate,
      netSales,
      historicalGrossProfitWithoutPromotion,
      historicalGrossProfit,
      historicalMarginRate,
      remainingAdBudget,
      salesGap: netSales - item.monthlyGsvOpportunity
    };
  });
}

export function buildBreakthroughResults(input: ThreeStageInput): ProductBreakthroughResult[] {
  const productById = new Map(input.productSourceRows.map((row) => [row.productId, row]));
  const damoById = new Map(input.damoProductRows.map((row) => [row.productId, row]));
  const rawRows = input.prefillItems.map((item) => {
    const product = productById.get(item.productId);
    const damo = damoById.get(item.productId);
    const historicalAov = safeDivide(product?.paymentAmount ?? 0, product?.paymentBuyers ?? 0);
    return {
      item,
      lifecycle: damo?.growthStage ?? "冷启期",
      searchDisplayValue:
        (product?.searchGuidedPaymentConversionRate ?? 0) *
        (damo?.freeSearchClickRate ?? 0) *
        historicalAov,
      searchPaymentConversionRate: product?.searchGuidedPaymentConversionRate ?? 0,
      averageStaySeconds: product?.averageStaySeconds ?? 0,
      bounceRate: product?.bounceRate ?? 0,
      refundRate: safeDivide(product?.refundAmount ?? 0, product?.paymentAmount ?? 0),
      attachPurchaseRate: damo?.attachPurchaseRate ?? 0,
      attachCategoryWidth: damo?.attachCategoryWidth ?? 0,
      repurchaseRate: damo?.repurchaseRate ?? 0
    };
  });

  const thresholds = {
    searchDisplayValue: median(rawRows.map((row) => row.searchDisplayValue)),
    searchPaymentConversionRate: median(rawRows.map((row) => row.searchPaymentConversionRate)),
    averageStaySeconds: median(rawRows.map((row) => row.averageStaySeconds)),
    bounceRate: median(rawRows.map((row) => row.bounceRate)),
    refundRate: median(rawRows.map((row) => row.refundRate)),
    attachPurchaseRate: median(rawRows.map((row) => row.attachPurchaseRate)),
    attachCategoryWidth: median(rawRows.map((row) => row.attachCategoryWidth)),
    repurchaseRate: median(rawRows.map((row) => row.repurchaseRate))
  } satisfies Record<BreakthroughDimensionScore["key"], number>;

  return rawRows.map((row) => {
    const dimensions = Object.keys(thresholds).map((key) => {
      const typedKey = key as BreakthroughDimensionScore["key"];
      const value = row[typedKey];
      const threshold = thresholds[typedKey];
      const passed = higherIsBetter[typedKey] ? value > threshold : value < threshold;
      return {
        key: typedKey,
        label: dimensionLabels[typedKey],
        value,
        threshold,
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
      subjectName: row.subjectName
    };

    if (row.guidedPotentialCustomerRatio > 0.8 && row.newCustomerRatio > 0.8) {
      plans.push({ ...item, type: "拉新" });
      continue;
    }

    if (row.guidedPotentialCustomerRatio < 0.5 && row.newCustomerRatio > 0.5) {
      plans.push({ ...item, type: "追投" });
      continue;
    }

    if (row.guidedPotentialCustomerRatio < 0.5 && row.newCustomerRatio < 0.5) {
      plans.push({ ...item, type: "收割" });
    }
  }
  return plans;
}

export function buildManagementDashboard(
  investmentResults: ProductInvestmentResult[]
): ManagementDashboard {
  const monthlyNetSales = sum(investmentResults.map((row) => row.netSales));
  const monthlyProfitEstimate = sum(investmentResults.map((row) => row.historicalGrossProfit));
  const monthlyGsvOpportunity = sum(investmentResults.map((row) => row.monthlyGsvOpportunity));
  const plannedProfit = sum(investmentResults.map((row) => row.plannedGrossProfit));
  const availableAdBudget = sum(investmentResults.map((row) => row.remainingAdBudget));

  return {
    productCount: investmentResults.length,
    monthlyNetSales,
    monthlyProfitEstimate,
    monthlyGsvOpportunity,
    marketSalesGap: monthlyNetSales - monthlyGsvOpportunity,
    historicalMarginRate: safeDivide(monthlyProfitEstimate, monthlyNetSales),
    plannedProfit,
    availableAdBudget,
    plannedMarginRate: safeDivide(plannedProfit, monthlyGsvOpportunity),
    // 明细只展示「评级 + 月GSV机会 + 毛利率」三项都填齐的商品；未填齐的不进明细。
    topProducts: [...investmentResults]
      .filter(
        (row) =>
          gradeRows.includes(row.grade) &&
          row.monthlyGsvOpportunity > 0 &&
          row.grossMarginRate > 0
      )
      .sort((a, b) => b.netSales - a.netSales)
      .slice(0, 10)
  };
}

function summarizePromotionRows(rows: PromotionProductRow[]) {
  const grouped = new Map<string, { cost: number; clicks: number; roiTotal: number; count: number }>();
  for (const row of rows) {
    const current = grouped.get(row.subjectId) ?? { cost: 0, clicks: 0, roiTotal: 0, count: 0 };
    current.cost += row.cost;
    current.clicks += row.clicks;
    current.roiTotal += row.roi;
    current.count += 1;
    grouped.set(row.subjectId, current);
  }

  return new Map(
    [...grouped.entries()].map(([subjectId, value]) => [
      subjectId,
      {
        averageClickCost: value.clicks > 0 ? value.cost / value.clicks : 0,
        roi: value.count > 0 ? value.roiTotal / value.count : 0
      }
    ])
  );
}

function buildSolutionText(dimensions: BreakthroughDimensionScore[]) {
  const failed = dimensions.filter((dimension) => !dimension.passed);
  if (failed.length === 0) {
    return "八项指标均高于当前周期中位线，可作为放大样板，优先承接预算与人群计划。";
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

function safeDivide(numerator: number, denominator: number) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }
  return numerator / denominator;
}

function median(values: number[]) {
  const numeric = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (numeric.length === 0) {
    return 0;
  }
  const mid = Math.floor(numeric.length / 2);
  return numeric.length % 2 === 0 ? (numeric[mid - 1] + numeric[mid]) / 2 : numeric[mid];
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}
