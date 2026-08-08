import { describe, expect, it } from "vitest";
import {
  buildAudiencePlans,
  buildBreakthroughResults,
  buildInvestmentResults,
  marginMatrix,
  runThreeStageCalculation
} from "@/lib/algorithm/three-stage";
import { getGoldenScenario } from "@/lib/fixtures/golden-scenario";

const scenario = getGoldenScenario();

describe("three-stage calculation", () => {
  it("matches the same-window promotion-cost management KPIs", () => {
    const run = runThreeStageCalculation({
      cycleId: scenario.cycle.id,
      productSourceRows: scenario.productSourceRows,
      damoProductRows: scenario.damoProductRows,
      promotionProductRows: scenario.promotionProductRows,
      audienceSourceRows: scenario.audienceSourceRows,
      prefillItems: scenario.prefillItems
    });

    expect(run.managementDashboard.productCount).toBe(60);
    expect(run.managementDashboard.monthlyNetSales).toBeCloseTo(89825.9, 3);
    expect(run.managementDashboard.monthlyProfitEstimate).toBeCloseTo(35177.36, 3);
    expect(run.managementDashboard.monthlyGsvOpportunity).toBeCloseTo(429225.9, 3);
    expect(run.managementDashboard.availableAdBudget).toBeCloseTo(28641.402, 3);
    expect(run.managementDashboard.marketSalesGap).toBeCloseTo(-339400, 3);
  });

  it("keeps core investment formula behavior explicit", () => {
    const run = runThreeStageCalculation({
      cycleId: scenario.cycle.id,
      productSourceRows: scenario.productSourceRows,
      damoProductRows: scenario.damoProductRows,
      promotionProductRows: scenario.promotionProductRows,
      audienceSourceRows: scenario.audienceSourceRows,
      prefillItems: scenario.prefillItems
    });

    const first = run.investmentResults[0];
    expect(first.lifecycle).toBe("爆品期");
    expect(first.grade).toBe("S");
    expect(first.attackDefenseMarginRate).toBe(0.1);
    expect(first.netSales).toBeCloseTo(47111.02, 2);
    expect(first.historicalGrossProfit).toBeCloseTo(18451.408, 3);
    expect(first.remainingAdBudget).toBeCloseTo(13740.306, 3);
    expect(first.profitEvidenceAvailable).toBe(true);
    expect(first.promotionSpend).toBeCloseTo(393, 3);
  });

  it("links promotion cost by product within a source-complete analysis window", () => {
    const item = scenario.prefillItems[0];
    const product = scenario.productSourceRows.find((row) => row.productId === item.productId)!;
    const promotion = scenario.promotionProductRows.find((row) => row.subjectId === item.productId)!;
    const run = runThreeStageCalculation({
      cycleId: scenario.cycle.id,
      productSourceRows: [{ ...product, observedDays: 3 }],
      damoProductRows: scenario.damoProductRows.filter((row) => row.productId === item.productId),
      // 单品只投放 1 天也不代表推广源缺日；完整性由店铺层源数据证明。
      promotionProductRows: [{ ...promotion, observedDays: 1 }],
      audienceSourceRows: [],
      prefillItems: [item],
      analysisPeriod: { start: "2026-06-01", end: "2026-06-03" },
      promotionSourceWindowComplete: true
    });

    expect(run.investmentResults[0].profitEvidenceAvailable).toBe(true);
    expect(run.investmentResults[0].promotionSpend).toBeCloseTo(promotion.cost!, 6);
  });

  it("treats an absent product promotion row as zero cost when the promotion source window is complete", () => {
    const item = scenario.prefillItems[0];
    const product = scenario.productSourceRows.find((row) => row.productId === item.productId)!;
    const [result] = runThreeStageCalculation({
      cycleId: scenario.cycle.id,
      productSourceRows: [{ ...product, observedDays: 3 }],
      damoProductRows: scenario.damoProductRows.filter((row) => row.productId === item.productId),
      promotionProductRows: [],
      audienceSourceRows: [],
      prefillItems: [item],
      analysisPeriod: { start: "2026-06-01", end: "2026-06-03" },
      promotionSourceWindowComplete: true
    }).investmentResults;

    expect(result.profitEvidenceAvailable).toBe(true);
    expect(result.promotionSpend).toBe(0);
    expect(result.historicalGrossProfit).toBeCloseTo(result.netSales! * item.grossMarginRate, 6);
  });

  it("uses an editable growth profit margin matrix when provided", () => {
    const editableMatrix = {
      ...marginMatrix,
      S: {
        ...marginMatrix.S,
        爆品期: 0.22
      }
    };
    const run = runThreeStageCalculation({
      cycleId: scenario.cycle.id,
      productSourceRows: scenario.productSourceRows,
      damoProductRows: scenario.damoProductRows,
      promotionProductRows: scenario.promotionProductRows,
      audienceSourceRows: scenario.audienceSourceRows,
      prefillItems: scenario.prefillItems,
      marginMatrix: editableMatrix
    });

    const first = run.investmentResults[0];
    expect(first.attackDefenseMarginRate).toBe(0.22);
    expect(first.plannedGrossProfit).toBeCloseTo(14256, 3);
  });

  it("冷启期新品无历史成交时，用同层/全店中位数兜底算出规划流量而不是归零", () => {
    // 新品：商品源里有行（已上架、有访客）但尚未产生成交 → 历史AOV=0、转化率=0。
    const newProductId = "new-product-001";
    const existing = scenario.productSourceRows.filter((row) => (row.paymentBuyers ?? 0) > 0).slice(0, 5);
    const existingItems = scenario.prefillItems.filter((item) =>
      existing.some((row) => row.productId === item.productId)
    );
    const newProductRow = {
      ...existing[0],
      productId: newProductId,
      productName: "冷启新品",
      paymentAmount: 0,
      paymentBuyers: 0,
      productPaymentConversionRate: 0,
      refundAmount: 0
    };
    const newItem = {
      ...existingItems[0],
      id: "prefill-new-001",
      productId: newProductId,
      productName: "冷启新品",
      grade: "S" as const,
      monthlyGsvOpportunity: 120000,
      grossMarginRate: 0.3,
      paidVisitorRatio: 0.5
    };

    const results = buildInvestmentResults({
      cycleId: scenario.cycle.id,
      productSourceRows: [...existing, newProductRow],
      damoProductRows: scenario.damoProductRows,
      promotionProductRows: scenario.promotionProductRows,
      audienceSourceRows: [],
      prefillItems: [...existingItems, newItem]
    });

    const created = results.find((row) => row.productId === newProductId)!;
    expect(created.historicalAov).toBeNull(); // 无买家时客单价无法计算，不伪造成 0
    expect(created.plannedMonthlyOrders).toBeGreaterThan(0); // 但规划测算不再归零
    expect(created.plannedMonthlyTraffic).toBeGreaterThan(0);
    expect(created.monthlyPaidEstimate).toBeGreaterThan(0);
    expect(created.planningBasis).toBe("estimated");
    expect(created.planningBasisNote).toContain("中位数");

    // 有实测成交的商品不受影响，仍标记为 observed。
    const observed = results.find((row) => row.productId === existing[0].productId)!;
    expect(observed.planningBasis).toBe("observed");
    expect(observed.planningBasisNote).toBe(undefined);
  });

  it("新品填了竞品转化预期时优先用它，而不是全店中位数", () => {
    const existing = scenario.productSourceRows.filter((row) => (row.paymentBuyers ?? 0) > 0).slice(0, 5);
    const existingItems = scenario.prefillItems.filter((item) =>
      existing.some((row) => row.productId === item.productId)
    );
    const newProductRow = {
      ...existing[0],
      productId: "new-product-002",
      paymentAmount: 0,
      paymentBuyers: 0,
      productPaymentConversionRate: 0
    };
    const [result] = buildInvestmentResults({
      cycleId: scenario.cycle.id,
      productSourceRows: [...existing, newProductRow],
      damoProductRows: [],
      promotionProductRows: [],
      audienceSourceRows: [],
      prefillItems: [
        {
          ...existingItems[0],
          id: "prefill-new-002",
          productId: "new-product-002",
          monthlyGsvOpportunity: 60000,
          competitorConversionExpectation: 0.05
        },
        ...existingItems
      ]
    });

    // 规划流量 = 规划订单数 / 0.05，用的是竞品预期而非全店中位数。
    expect(result.plannedMonthlyTraffic).toBeCloseTo(result.plannedMonthlyOrders! / 0.05, 6);
    expect(result.planningBasisNote).toContain("竞品预期值");
  });

  it("does not turn a missing promotion cost into zero profit spend", () => {
    const item = scenario.prefillItems[0];
    const product = scenario.productSourceRows.find((row) => row.productId === item.productId)!;
    const promotion = scenario.promotionProductRows.find((row) => row.subjectId === item.productId);
    const [result] = buildInvestmentResults({
      cycleId: scenario.cycle.id,
      productSourceRows: [product],
      damoProductRows: [],
      promotionProductRows: [{
        ...(promotion ?? {
          date: scenario.cycle.endDate,
          subjectId: item.productId,
          subjectName: item.productName,
          impressions: 100,
          clicks: 10,
          ctr: 0.1,
          averageClickCost: null,
          roi: null
        }),
        subjectId: item.productId,
        cost: null
      }],
      audienceSourceRows: [],
      prefillItems: [item],
      promotionSourceWindowComplete: true
    });

    expect(result.promotionSpend).toBeNull();
    expect(result.historicalGrossProfit).toBeNull();
    expect(result.profitEvidenceAvailable).toBe(false);
  });

  it("generates eight-dimension solution codes without spreadsheet errors", () => {
    const items = buildBreakthroughResults({
      cycleId: scenario.cycle.id,
      productSourceRows: scenario.productSourceRows,
      damoProductRows: scenario.damoProductRows,
      promotionProductRows: scenario.promotionProductRows,
      audienceSourceRows: scenario.audienceSourceRows,
      prefillItems: scenario.prefillItems
    });

    expect(items).toHaveLength(60);
    expect(items[0].solutionCode).toMatch(/^[01]{8}$/);
    expect(items[0].dimensions).toHaveLength(8);
    expect(items.every((item) => !item.solution.includes("#DIV/0!"))).toBe(true);
  });

  it("treats a single observed product equal to its median as passing", () => {
    const first = scenario.prefillItems[0];
    const items = buildBreakthroughResults({
      cycleId: scenario.cycle.id,
      productSourceRows: scenario.productSourceRows.filter((item) => item.productId === first.productId),
      damoProductRows: scenario.damoProductRows.filter((item) => item.productId === first.productId),
      promotionProductRows: [],
      audienceSourceRows: [],
      prefillItems: [first]
    });

    expect(items[0].dimensions.every((item) => item.available && item.passed)).toBe(true);
    expect(items[0].score).toBe(8);
  });

  it("marks dimensions unavailable when their source cannot be joined", () => {
    const first = scenario.prefillItems[0];
    const [item] = buildBreakthroughResults({
      cycleId: scenario.cycle.id,
      productSourceRows: scenario.productSourceRows.filter((row) => row.productId === first.productId),
      damoProductRows: [],
      promotionProductRows: [],
      audienceSourceRows: [],
      prefillItems: [first]
    });

    expect(item.dimensions.find((dimension) => dimension.key === "repurchaseRate")?.available).toBe(false);
    expect(item.solution).toContain("缺少关联源数据");
  });

  it("classifies every audience row and keeps uncertain combinations in observation", () => {
    const plans = buildAudiencePlans(scenario.audienceSourceRows);

    expect(plans).toHaveLength(scenario.audienceSourceRows.length);
    expect(plans.slice(0, 3).map((item) => item.type)).toEqual(["拉新", "追投", "收割"]);
    expect(plans.some((item) => item.type === "观察")).toBe(true);
    expect(plans.every((item) => item.subjectId)).toBe(true);
  });

  it("综合看板明细只展示填齐三项（评级+月GSV机会+毛利率）的商品", () => {
    const run = runThreeStageCalculation({
      cycleId: scenario.cycle.id,
      productSourceRows: scenario.productSourceRows,
      damoProductRows: scenario.damoProductRows,
      promotionProductRows: scenario.promotionProductRows,
      audienceSourceRows: scenario.audienceSourceRows,
      prefillItems: scenario.prefillItems
    });

    const top = run.managementDashboard.topProducts;
    expect(top.length).toBeGreaterThan(0);
    // 明细里每个商品都填齐三项
    expect(
      top.every(
        (p) =>
          ["S", "A", "B", "C"].includes(p.grade) &&
          p.monthlyGsvOpportunity > 0 &&
          p.grossMarginRate > 0
      )
    ).toBe(true);
    // 未填月GSV机会的样例 demo 商品不进明细
    expect(top.some((p) => p.productId.startsWith("demo-product"))).toBe(false);
    // 但 KPI 汇总仍按全部商品（productCount 不变）
    expect(run.managementDashboard.productCount).toBe(60);
  });
});
