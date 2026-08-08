import { describe, expect, it } from "vitest";
import { buildOperatingNetworkSnapshot, type OperatingNetworkInput } from "@/lib/operating-network";
import type {
  AudiencePlanItem,
  BreakthroughDimensionScore,
  DailyTrendPoint,
  ProductBreakthroughResult,
  ProductInvestmentResult
} from "@/lib/types/domain";

describe("operating network", () => {
  it("keeps an empty upload in evidence-collection mode without fake zero budgets", () => {
    const snapshot = buildOperatingNetworkSnapshot({
      investmentResults: [],
      breakthroughResults: [],
      audiencePlans: []
    });

    expect(snapshot.finding.status).toBe("insufficient");
    expect(snapshot.outcome.netSales).toBeNull();
    expect(snapshot.investmentSpace.economicCeiling).toBeNull();
    expect(snapshot.budgetGates.find((item) => item.id === "gate-data")?.status).toBe("fail");
    expect(snapshot.actions.map((item) => item.id)).toEqual(["action-data"]);
    expect(snapshot.modelAdmissions.find((item) => item.modelId === "operating-result")?.mode).toBe("disabled");
    expect(snapshot.modelAdmissions.filter((item) => item.portfolio === "retire").every((item) => item.mode === "disabled")).toBe(true);
  });

  it.each([
    { cp: 200, targetRate: 0.1, expected: "健康盈利" },
    { cp: -100, targetRate: -0.2, expected: "策略性投入" },
    { cp: 50, targetRate: 0.1, expected: "有利润但不达标" },
    { cp: -50, targetRate: 0.1, expected: "亏损失控" },
    { cp: 0, targetRate: -0.1, expected: "策略性投入" },
    { cp: 0, targetRate: 0.1, expected: "亏损失控" }
  ])("classifies profit health at boundary %#", ({ cp, targetRate, expected }) => {
    const snapshot = buildOperatingNetworkSnapshot(
      baseInput({ investmentResults: [investment({ historicalGrossProfit: cp, attackDefenseMarginRate: targetRate })] })
    );
    expect(snapshot.outcome.health).toBe(expected);
  });

  it("treats observed non-positive net sales as critical and leaves margin undefined", () => {
    const snapshot = buildOperatingNetworkSnapshot(
      baseInput({ investmentResults: [investment({ netSales: -10, historicalGrossProfit: -5 })] })
    );
    expect(snapshot.outcome.health).toBe("亏损失控");
    expect(snapshot.outcome.marginRate).toBeNull();
    expect(snapshot.outcome.finding.status).toBe("critical");
  });

  it("states the contribution-profit formula and cost boundary in its evidence", () => {
    const snapshot = buildOperatingNetworkSnapshot(baseInput());
    const proof = snapshot.outcome.finding.proof.join(" ");
    const limitations = snapshot.outcome.finding.cannotProve.join(" ");

    expect(proof).toContain("净销售额 × 预填商品毛利率 − 同窗推广花费");
    expect(limitations).toContain("取决于用户预填毛利率口径");
    expect(limitations).toContain("不等于财务净利润");
  });

  it("sums only positive product buffers into the static economic ceiling", () => {
    const snapshot = buildOperatingNetworkSnapshot(
      baseInput({
        investmentResults: [
          investment({ productId: "p1", historicalGrossProfit: 200, attackDefenseMarginRate: 0.1 }),
          investment({ productId: "p2", historicalGrossProfit: 20, attackDefenseMarginRate: 0.1 })
        ]
      })
    );
    expect(snapshot.investmentSpace.economicCeiling).toBe(100);
    expect(snapshot.investmentSpace.approvedBudget).toBeNull();
    expect(snapshot.investmentSpace.suggestedTestBudget).toBeNull();
    expect(snapshot.investmentSpace.scenarios.every((item) => item.incrementalContribution === null)).toBe(true);
    expect(snapshot.modelAdmissions.find((item) => item.modelId === "investment-action-network")?.canUnlockGate).toBe(false);
  });

  it("recomputes equal-to-median dimensions as passing instead of trusting legacy strict flags", () => {
    const equalDimensions = dimensions().map((item) => ({
      ...item,
      value: item.threshold,
      passed: false,
      available: true
    }));
    const snapshot = buildOperatingNetworkSnapshot(
      baseInput({ breakthroughResults: [breakthrough({ dimensions: equalDimensions })] })
    );
    expect(snapshot.dimensionShortfalls).toHaveLength(0);
    expect(snapshot.potentialProducts[0]?.efficiencyBadge).toBe("高效率");
  });

  it("lists every unavailable S-product dimension as data evidence, while ignoring non-S", () => {
    const missing = dimensions().map((item) => ({
      ...item,
      value: 0,
      threshold: 0,
      available: false,
      passed: false
    }));
    const snapshot = buildOperatingNetworkSnapshot({
      ...baseInput(),
      investmentResults: [investment({ productId: "s", grade: "S" }), investment({ productId: "a", grade: "A" })],
      breakthroughResults: [
        breakthrough({ productId: "s", grade: "S", dimensions: missing }),
        breakthrough({ productId: "a", grade: "A", dimensions: missing })
      ]
    });
    expect(snapshot.dimensionShortfalls).toHaveLength(8);
    expect(snapshot.dimensionShortfalls.every((item) => item.productId === "s")).toBe(true);
    expect(snapshot.dimensionShortfalls.every((item) => item.finding.status === "insufficient")).toBe(true);
  });

  it("uses only subjectId for audience economics, never emits an exact CPC, and keeps G4 conditional", () => {
    const plans = [
      audience({ subjectId: "p1", clicks: 100, roi: 5 }),
      audience({ planId: "name-only", subjectId: undefined, subjectName: "商品一", clicks: 100, roi: 5 })
    ];
    const snapshot = buildOperatingNetworkSnapshot(baseInput({ audiencePlans: plans }));
    const matched = snapshot.audienceRecommendations.find((item) => item.planId === "plan-1")!;
    const nameOnly = snapshot.audienceRecommendations.find((item) => item.planId === "name-only")!;

    expect(matched.maxCpaEstimate).toBeGreaterThan(0);
    expect(matched.maxCpcProxy).toBeNull();
    expect(matched.startingBidSuggestion).toContain("相对当前平台出价");
    expect(nameOnly.finding.status).toBe("insufficient");
    expect(nameOnly.finding.requiredData.join(" ")).toContain("映射");
    expect(snapshot.budgetGates.find((item) => item.id === "gate-audience")?.status).toBe("conditional");
  });

  it("withholds bid and budget suggestions when an audience does not cover the full analysis window", () => {
    const snapshot = buildOperatingNetworkSnapshot(baseInput({
      audiencePlans: [audience({ observedDays: 29 })],
      readinessContext: {
        readyPrefillCount: 1,
        totalPrefillCount: 1,
        sourceCoverage: { product: true, damo: true, promotion: true, audience: true, business: false },
        sourcePeriodAlignment: { aligned: true, issues: [] },
        sourceObservedDays: { product: 30, promotion: 30, audience: 29 }
      }
    }));
    const recommendation = snapshot.audienceRecommendations[0]!;

    expect(recommendation.finding.status).toBe("insufficient");
    expect(recommendation.startingBidSuggestion).toContain("覆盖不完整");
    expect(recommendation.startingBidSuggestion).not.toContain("倍");
    expect(recommendation.finding.requiredData.join(" ")).toContain("30 个自然日");
  });

  it("aggregates duplicate audience keys and enforces 49/50/100 click evidence tiers", () => {
    const snapshot = buildOperatingNetworkSnapshot(
      baseInput({
        audiencePlans: [
          audience({ planId: "p49", clicks: 49 }),
          audience({ planId: "p50", clicks: 50 }),
          audience({ planId: "p100", clicks: 100 }),
          audience({ planId: "p100", clicks: 90 })
        ]
      })
    );
    expect(snapshot.audienceRecommendations).toHaveLength(3);
    expect(snapshot.audienceRecommendations.find((item) => item.planId === "p49")?.finding.status).toBe("insufficient");
    expect(snapshot.audienceRecommendations.find((item) => item.planId === "p50")?.finding.status).toBe("warning");
    expect(snapshot.audienceRecommendations.find((item) => item.planId === "p100")?.finding.status).toBe("positive");
    expect(snapshot.audienceRecommendations.find((item) => item.planId === "p100")?.clicks).toBe(190);
  });

  it("requires fourteen daily points before producing an equal-window trend", () => {
    const thirteen = trend(13);
    const fourteen = trend(14);
    const withoutTrend = buildOperatingNetworkSnapshot(baseInput({ trendSeries: thirteen }));
    const withTrend = buildOperatingNetworkSnapshot(baseInput({ trendSeries: fourteen }));
    expect(withoutTrend.outcome.analysisDays).toBe(0);
    expect(withoutTrend.outcome.netSalesTrend).toBeNull();
    expect(withTrend.outcome.analysisDays).toBe(7);
    expect(withTrend.outcome.netSalesTrend).toBeCloseTo(1);
    expect(withTrend.profitDrivers.some((item) => item.key === "unavailable")).toBe(false);
  });

  it("runs a direct diagnosis without same-month category market evidence", () => {
    const snapshot = buildOperatingNetworkSnapshot(baseInput({ businessDiagnosis: undefined }));

    expect(snapshot.readiness.finding.conclusion).toContain("已达到直接诊断条件");
    expect(snapshot.readiness.finding.requiredData.join(" ")).not.toContain("同月类目市场证据");
    expect(snapshot.readiness.finding.confidence.reasons).toContain("已启用现有数据直接诊断");
  });

  it("keeps source limitations local instead of blocking the whole diagnosis", () => {
    const snapshot = buildOperatingNetworkSnapshot(baseInput({
      investmentResults: [investment({ profitEvidenceAvailable: false })],
      readinessContext: {
        readyPrefillCount: 1,
        totalPrefillCount: 1,
        sourceCoverage: { product: true, damo: true, promotion: true, audience: true, business: false },
        sourcePeriodAlignment: { aligned: false, issues: ["推广源周期较短"] },
        sourceObservedDays: { product: 30, promotion: 29, audience: 30 }
      }
    }));

    expect(snapshot.readiness.finding.conclusion).toContain("不阻断本次诊断");
    expect(snapshot.outcome.health).toBe("无法判断");
    expect(snapshot.investmentSpace.economicCeiling).toBeNull();
  });

  it("rejects equal-size trend windows when dates are not consecutive", () => {
    const gapped = trend(14).map((item, index) => index === 7 ? { ...item, date: "2026-07-01" } : item);
    const snapshot = buildOperatingNetworkSnapshot(baseInput({ trendSeries: gapped }));
    expect(snapshot.outcome.analysisDays).toBe(0);
    expect(snapshot.outcome.netSalesTrend).toBeNull();
  });

  it("never promotes manually entered GSV opportunity to a verified product gate", () => {
    const snapshot = buildOperatingNetworkSnapshot(baseInput());
    expect(snapshot.potentialProducts[0]?.pool).toBe("核心潜力池");
    expect(snapshot.potentialProducts[0]?.opportunityConfidence).toBe("C");
    expect(snapshot.potentialProducts[0]?.finding.status).toBe("warning");
    expect(snapshot.budgetGates.find((item) => item.id === "gate-product")?.status).toBe("conditional");
  });

  it("does not classify a short analysis window as a large monthly opportunity", () => {
    const snapshot = buildOperatingNetworkSnapshot(baseInput({
      analysisPeriod: { start: "2026-06-01", end: "2026-06-14" }
    }));
    expect(snapshot.potentialProducts[0]?.opportunityBadge).toBe("待核验");
    expect(snapshot.potentialProducts[0]?.opportunityConfidence).toBe("D");
    expect(snapshot.potentialProducts[0]?.pool).not.toBe("核心潜力池");
  });

  it("treats observed ROI zero as a critical zero-return signal", () => {
    const snapshot = buildOperatingNetworkSnapshot(baseInput({
      audiencePlans: [audience({ clicks: 100, roi: 0 })]
    }));
    expect(snapshot.audienceRecommendations[0]?.roi).toBe(0);
    expect(snapshot.audienceRecommendations[0]?.finding.status).toBe("critical");
    expect(snapshot.audienceRecommendations[0]?.startingBidSuggestion).toContain("暂停");
  });

  it("withholds profit and investment space when product promotion cost is not linked", () => {
    const snapshot = buildOperatingNetworkSnapshot(baseInput({
      investmentResults: [investment({ profitEvidenceAvailable: false })]
    }));
    expect(snapshot.outcome.health).toBe("无法判断");
    expect(snapshot.outcome.contributionProfit).toBeNull();
    expect(snapshot.investmentSpace.economicCeiling).toBeNull();
    expect(snapshot.budgetGates.find((item) => item.id === "gate-profit")?.status).toBe("fail");
    expect(snapshot.potentialProducts[0]?.profitBadge).toBe("证据不足");
  });

  it("never lets a negative-net-sales product create economic headroom", () => {
    const snapshot = buildOperatingNetworkSnapshot(baseInput({
      investmentResults: [investment({ netSales: -100, historicalGrossProfit: 0 })]
    }));
    expect(snapshot.investmentSpace.economicCeiling).toBe(0);
    expect(snapshot.outcome.finding.status).toBe("critical");
  });

  it("builds a valid acyclic action graph with resolvable gate references", () => {
    const failed = dimensions();
    failed[0] = { ...failed[0], value: 8, passed: false };
    const snapshot = buildOperatingNetworkSnapshot(baseInput({
      breakthroughResults: [breakthrough({ dimensions: failed })]
    }));
    const actionIds = new Set(snapshot.actions.map((item) => item.id));
    const gateIds = new Set(snapshot.budgetGates.map((item) => item.id));
    expect(actionIds.size).toBe(snapshot.actions.length);
    for (const action of snapshot.actions) {
      expect(action.dependsOn.every((id) => actionIds.has(id))).toBe(true);
      expect(action.gateIds.every((id) => gateIds.has(id))).toBe(true);
    }
    expect(hasCycle(snapshot.actions.map((item) => ({ id: item.id, dependsOn: item.dependsOn })))).toBe(false);
    expect(snapshot.actions.find((item) => item.id === "action-budget-release")?.status).toBe("blocked");
    const budgetDependencies = snapshot.actions.find((item) => item.id === "action-budget-release")?.dependsOn ?? [];
    expect(budgetDependencies.some((id) => id.startsWith("action-shortfall-"))).toBe(true);
    expect(budgetDependencies.some((id) => id.startsWith("action-audience-"))).toBe(true);
  });

  it("does not emit NaN or Infinity anywhere in the snapshot", () => {
    const snapshot = buildOperatingNetworkSnapshot(
      baseInput({
        investmentResults: [investment({ historicalAov: 0, netSales: 0, historicalGrossProfit: 0 })],
        audiencePlans: [audience({ roi: Number.POSITIVE_INFINITY })]
      })
    );
    walk(snapshot, (value) => {
      if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
    });
  });
});

function baseInput(patch: Partial<OperatingNetworkInput> = {}): OperatingNetworkInput {
  return {
    investmentResults: [investment()],
    breakthroughResults: [breakthrough()],
    audiencePlans: [audience()],
    trendSeries: trend(14),
    analysisPeriod: { start: "2026-06-01", end: "2026-06-30" },
    readinessContext: {
      readyPrefillCount: 1,
      totalPrefillCount: 1,
      sourceCoverage: { product: true, damo: true, promotion: true, audience: true, business: false },
      sourcePeriodAlignment: { aligned: true, issues: [] },
      sourceObservedDays: { product: 30, promotion: 30, audience: 30 }
    },
    ...patch
  };
}

function investment(patch: Partial<ProductInvestmentResult> = {}): ProductInvestmentResult {
  return {
    productId: "p1",
    productName: "商品一",
    lifecycle: "成长期",
    grade: "S",
    grossMarginRate: 0.4,
    attackDefenseMarginRate: 0.1,
    monthlyGsvOpportunity: 1600,
    plannedGrossProfit: 160,
    historicalPpc: 1,
    historicalAov: 100,
    plannedMonthlyOrders: 16,
    plannedMonthlyTraffic: 160,
    monthlyPaidEstimate: 50,
    netSales: 1000,
    historicalGrossProfitWithoutPromotion: 400,
    historicalGrossProfit: 200,
    historicalMarginRate: 0.2,
    profitEvidenceAvailable: true,
    promotionSpend: 200,
    remainingAdBudget: 100,
    salesGap: -600,
    ...patch
  };
}

function breakthrough(patch: Partial<ProductBreakthroughResult> = {}): ProductBreakthroughResult {
  const dims = patch.dimensions ?? dimensions();
  return {
    productId: "p1",
    productCode: "p1",
    productName: "商品一",
    lifecycle: "成长期",
    grade: "S",
    dimensions: dims,
    score: dims.filter((item) => item.passed).length,
    solutionCode: dims.map((item) => (item.passed ? "1" : "0")).join(""),
    solution: "",
    ...patch
  };
}

function dimensions(): BreakthroughDimensionScore[] {
  return [
    dim("searchDisplayValue", "搜索展现价值", 12, 10, true),
    dim("searchPaymentConversionRate", "搜索支付转化率", 0.12, 0.1, true),
    dim("averageStaySeconds", "平均停留时长", 60, 50, true),
    dim("bounceRate", "跳失率", 0.4, 0.5, false),
    dim("refundRate", "退款率", 0.05, 0.1, false),
    dim("attachPurchaseRate", "连带购买率", 0.12, 0.1, true),
    dim("attachCategoryWidth", "连带类目宽度", 3, 2, true),
    dim("repurchaseRate", "复购率", 0.12, 0.1, true)
  ];
}

function dim(
  key: BreakthroughDimensionScore["key"],
  label: string,
  value: number,
  threshold: number,
  higherIsBetter: boolean
): BreakthroughDimensionScore {
  return { key, label, value, threshold, higherIsBetter, available: true, passed: true };
}

function audience(patch: Partial<AudiencePlanItem> = {}): AudiencePlanItem {
  return {
    type: "拉新",
    sceneName: "拉新场景",
    planId: "plan-1",
    planName: "计划一",
    audienceName: "高潜新客",
    clicks: 100,
    roi: 5,
    guidedPotentialCustomerRatio: 0.85,
    newCustomerRatio: 0.9,
    subjectId: "p1",
    subjectName: "商品一",
    observedDays: 30,
    ...patch
  };
}

function trend(days: number): DailyTrendPoint[] {
  return Array.from({ length: days }, (_, index) => {
    const currentHalf = index >= Math.floor(days / 2);
    const paymentAmount = currentHalf ? 200 : 100;
    return {
      date: `2026-06-${String(index + 1).padStart(2, "0")}`,
      paymentAmount,
      netSales: paymentAmount,
      visitors: 100,
      views: 200,
      paymentBuyers: currentHalf ? 20 : 10,
      conversion: currentHalf ? 0.2 : 0.1,
      aov: 10,
      refundRate: 0,
      uvValue: paymentAmount / 100,
      adCost: 10,
      impressions: 1000,
      adClicks: 20,
      cpc: 0.5,
      adRoi: paymentAmount / 10
    };
  });
}

function hasCycle(nodes: Array<{ id: string; dependsOn: string[] }>) {
  const byId = new Map(nodes.map((item) => [item.id, item.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of byId.get(id) ?? []) if (visit(dependency)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  return nodes.some((item) => visit(item.id));
}

function walk(value: unknown, visit: (value: unknown) => void) {
  visit(value);
  if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => walk(item, visit));
}
