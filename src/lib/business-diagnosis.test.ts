import { describe, expect, it } from "vitest";
import { buildBusinessDiagnosisSnapshot, getBusinessDiagnosisSource } from "@/lib/business-diagnosis";
import { currentIsoDate } from "@/lib/comparison-window";

describe("business diagnosis", () => {
  it("builds category-market BI snapshot from provided source files", () => {
    const snapshot = buildBusinessDiagnosisSnapshot(getBusinessDiagnosisSource());

    expect(snapshot.summary.latestStoreMonth).toBe("2025-12");
    expect(snapshot.summary.latestMarketMonth).toBe("2026-05");
    expect(snapshot.summary.paymentAmount!).toBeGreaterThan(900000);
    expect(snapshot.categories.length).toBeGreaterThanOrEqual(4);
    expect(snapshot.market.topPriceBands.length).toBeGreaterThan(0);
    expect(snapshot.market.topSearchSignals[0]?.searchUv).toBeGreaterThan(1_000_000);
    expect(snapshot.strategyCards.map((card) => card.model).join(" ")).toContain("市场方向雷达");
    expect(snapshot.strategyCards.map((card) => card.model).join(" ")).not.toMatch(/波士顿|PEST/);
  });

  it("uses top aggregate row for total store summary and leaf rows for category diagnosis", () => {
    const snapshot = buildBusinessDiagnosisSnapshot(getBusinessDiagnosisSource());
    const categoryTotal = snapshot.categories.reduce((total, item) => total + item.paymentAmount, 0);

    expect(snapshot.categories.map((item) => item.categoryName)).not.toContain("大家电");
    expect(snapshot.categories.map((item) => item.categoryName)).not.toContain("厨房大电");
    expect(categoryTotal).toBeGreaterThan(snapshot.summary.paymentAmount! * 0.75);
    expect(categoryTotal).toBeLessThan(snapshot.summary.paymentAmount! * 1.05);
    expect(snapshot.summary.paymentAmount).toBeGreaterThan(0);
    expect(snapshot.summary.storeTotalAvailable).toBe(true);
  });

  it("creates actionable segments and value-chain statuses", () => {
    const snapshot = buildBusinessDiagnosisSnapshot(getBusinessDiagnosisSource());

    expect(Object.values(snapshot.quadrants).flat().length).toBe(snapshot.categories.length);
    expect(snapshot.valueChain).toHaveLength(6);
    expect(snapshot.valueChain.some((stage) => stage.status !== "good")).toBe(true);
    expect(snapshot.marketOpportunities.map((item) => item.title).join("")).toMatch(/价格|搜索|市场|供给/);
  });

  it("builds market directions and the action-validation network", () => {
    const snapshot = buildBusinessDiagnosisSnapshot(getBusinessDiagnosisSource());

    expect(snapshot.marketOpportunities.length).toBeGreaterThanOrEqual(3);
    expect(snapshot.actionReviewLoops.length).toBeGreaterThanOrEqual(3);
    expect(snapshot.roadmap).toHaveLength(8);
    expect(snapshot.roadmap.map((step) => step.title).join("")).toContain("复盘");
  });

  it("keeps unsupported consulting frameworks locked and out of default conclusions", () => {
    const snapshot = buildBusinessDiagnosisSnapshot(getBusinessDiagnosisSource());

    expect(snapshot.pestSignals).toHaveLength(4);
    expect(snapshot.porterForces).toHaveLength(5);
    expect(snapshot.sevenS).toHaveLength(7);
    expect(snapshot.pestSignals.every((item) => !item.available && item.score === null)).toBe(true);
    expect(snapshot.porterForces.every((item) => !item.available && item.intensity === null)).toBe(true);
    expect(snapshot.npsReputation.score).toBeNull();
    expect(snapshot.npsReputation.available).toBe(false);
    expect(snapshot.questionnaire.find((item) => item.id === "q-nps")?.defaultAnswer).toContain("不计算推荐分");
    expect(snapshot.questionnaire.length).toBeGreaterThanOrEqual(5);
    expect(snapshot.aiReport.sections.length).toBeGreaterThanOrEqual(4);
    expect(snapshot.aiReport.prompt).toContain("经营诊断报告");
    expect(snapshot.aiReport.summary).toMatch(/未满足直接数据条件|不参与本次自动结论/);
    expect(snapshot.modelAdmissions.find((item) => item.modelId === "pest")?.mode).toBe("disabled");
    expect(snapshot.modelAdmissions.find((item) => item.modelId === "experience-curve")?.mode).toBe("disabled");
    expect(snapshot.modelAdmissions.filter((item) => item.portfolio === "retire").every((item) => item.mode === "disabled")).toBe(true);
  });

  it.each([
    {
      name: "缺少前月",
      storeMonths: ["2025-12"],
      marketMonths: ["2026-05"]
    },
    {
      name: "历史月不相邻",
      storeMonths: ["2025-10", "2025-12"],
      marketMonths: ["2026-03", "2026-05"]
    }
  ])("$name时不伪造环比或份额变化", ({ storeMonths, marketMonths }) => {
    const source = structuredClone(getBusinessDiagnosisSource());
    source.storeCategoryRows = source.storeCategoryRows.filter((row) => storeMonths.includes(row.month));
    source.market.overview = source.market.overview.filter((row) => marketMonths.includes(row.month));

    const snapshot = buildBusinessDiagnosisSnapshot(source);

    expect(snapshot.summary.revenueGrowth).toBeNull();
    expect(snapshot.summary.visitorGrowth).toBeNull();
    expect(snapshot.summary.marketSalesShareChange).toBeNull();
    expect(snapshot.categories.every((category) => category.revenueGrowth === null)).toBe(true);
    expect(snapshot.categories.every((category) => category.visitorGrowth === null)).toBe(true);
    expect(snapshot.categories.every((category) => category.conversionDelta === null)).toBe(true);
    expect(snapshot.valueChain.find((stage) => stage.key === "traffic")?.evidence).toContain("证据不足");
    expect(snapshot.modelAdmissions.find((item) => item.modelId === "category-portfolio")?.mode).toBe("proxy");
  });

  it("treats a zero prior-month denominator as insufficient instead of plus one hundred percent", () => {
    const source = structuredClone(getBusinessDiagnosisSource());
    source.storeCategoryRows = source.storeCategoryRows
      .filter((row) => ["2025-11", "2025-12"].includes(row.month))
      .map((row) => row.month === "2025-11" ? { ...row, paymentAmount: 0, visitors: 0 } : row);

    const snapshot = buildBusinessDiagnosisSnapshot(source);

    expect(snapshot.summary.revenueGrowth).toBeNull();
    expect(snapshot.summary.visitorGrowth).toBeNull();
    expect(snapshot.categories.every((category) => category.revenueGrowth === null)).toBe(true);
    expect(snapshot.strategyCards.flatMap((card) => card.evidence).join(" ")).not.toContain("+100.0%");
  });

  it("blocks cross-period store-market synthesis and keeps external signals directional", () => {
    const snapshot = buildBusinessDiagnosisSnapshot(getBusinessDiagnosisSource());

    expect(snapshot.market.samePeriod).toBe(false);
    expect(snapshot.market.periodNote).toMatch(/不可合成|需补/);
    expect(snapshot.marketOpportunities.some((item) => item.id === "store-market-fit")).toBe(false);
    expect(snapshot.marketOpportunities.length).toBeGreaterThan(0);
    expect(snapshot.marketOpportunities.every((item) => item.evidenceLevel === "directional")).toBe(true);
    expect(snapshot.marketOpportunities.every((item) => item.score <= 59 && item.status !== "good")).toBe(true);
    expect(snapshot.marketOpportunities.every((item) => item.requiredData.join("").includes("2025-12"))).toBe(true);
    expect(snapshot.strategyCards.find((item) => item.id === "market-context")?.diagnosis).toMatch(/不一致|不能证明/);
    expect(snapshot.aiReport.prompt).toContain("directional");
  });

  it("allows same-period market evidence after both monthly sources align", () => {
    const source = structuredClone(getBusinessDiagnosisSource());
    source.market.overview = source.market.overview.filter((row) => row.month <= "2025-12");

    const snapshot = buildBusinessDiagnosisSnapshot(source);

    expect(snapshot.market.samePeriod).toBe(true);
    expect(snapshot.marketOpportunities.every((item) => item.evidenceLevel === "observed")).toBe(true);
    expect(snapshot.marketOpportunities.every((item) => item.requiredData.length === 0)).toBe(true);
  });

  it("marks policy and organization frameworks unavailable without direct inputs", () => {
    const snapshot = buildBusinessDiagnosisSnapshot(getBusinessDiagnosisSource());
    const policy = snapshot.pestSignals.find((item) => item.dimension === "政策 P");
    const staff = snapshot.sevenS.find((item) => item.dimension === "Staff");
    const style = snapshot.sevenS.find((item) => item.dimension === "Style");

    expect(policy).toMatchObject({ available: false, score: null, status: "warn" });
    expect(policy?.requiredData.join("")).toMatch(/政策|规则|合规/);
    expect(snapshot.sevenS.every((item) => item.available === false && item.score === null)).toBe(true);
    expect(staff?.requiredData.join("")).toMatch(/编制|绩效|访谈/);
    expect(style?.requiredData.join("")).toMatch(/会议|授权|访谈/);
    expect(snapshot.questionnaire.find((item) => item.id === "q-organization")?.defaultAnswer).toContain("待组织访谈");
  });

  it("keeps store results unavailable when only market data is uploaded", () => {
    const source = structuredClone(getBusinessDiagnosisSource());
    source.storeCategoryRows = [];

    const snapshot = buildBusinessDiagnosisSnapshot(source);

    expect(snapshot.summary.storeDataAvailable).toBe(false);
    expect(snapshot.summary.storeTotalAvailable).toBe(false);
    expect(snapshot.summary.paymentAmount).toBeNull();
    expect(snapshot.summary.netSales).toBeNull();
    expect(snapshot.summary.visitors).toBeNull();
    expect(snapshot.summary.paymentConversionRate).toBeNull();
    expect(snapshot.summary.refundRate).toBeNull();
    expect(snapshot.valueChain.filter((stage) => stage.key !== "market").every((stage) => stage.score === null)).toBe(true);
    expect(snapshot.modelAdmissions.find((item) => item.modelId === "experience-curve")?.mode).toBe("disabled");
    expect(snapshot.modelAdmissions.find((item) => item.modelId === "scale-economy")?.mode).toBe("disabled");
    expect(snapshot.valueChain.find((stage) => stage.key === "conversion")?.evidence).toContain("缺少可靠的全店汇总行");
    expect(snapshot.aiReport.summary).toContain("不能输出本店经营结果");
    expect(snapshot.aiReport.summary).not.toMatch(/支付额\s*0|净销售\s*0/);
  });

  it("does not sum leaf-category visitors and buyers into a deduplicated store total", () => {
    const source = structuredClone(getBusinessDiagnosisSource());
    source.storeCategoryRows = source.storeCategoryRows.filter(
      (row) => !(row.categoryName === row.level1Category && row.categoryName === row.level2Category)
    );
    const latestLeafVisitors = source.storeCategoryRows
      .filter((row) => row.month === "2025-12" && row.categoryName !== row.level2Category)
      .reduce((total, row) => total + (row.visitors ?? 0), 0);

    const snapshot = buildBusinessDiagnosisSnapshot(source);

    expect(latestLeafVisitors).toBeGreaterThan(0);
    expect(snapshot.summary.storeDataAvailable).toBe(true);
    expect(snapshot.summary.storeTotalAvailable).toBe(false);
    expect(snapshot.summary.visitors).toBeNull();
    expect(snapshot.summary.paymentConversionRate).toBeNull();
    expect(snapshot.valueChain.find((stage) => stage.key === "traffic")?.evidence).toContain("不可相加");
    expect(snapshot.valueChain.find((stage) => stage.key === "conversion")?.evidence).toContain("不可相加");
  });

  it("does not take the first of multiple top-category aggregates as the whole store", () => {
    const source = structuredClone(getBusinessDiagnosisSource());
    const top = source.storeCategoryRows.find(
      (row) => row.month === "2025-12" && row.categoryName === row.level1Category && row.categoryName === row.level2Category
    )!;
    source.storeCategoryRows.push({
      ...top,
      level1Category: "家居",
      level2Category: "家居",
      categoryName: "家居"
    });

    const snapshot = buildBusinessDiagnosisSnapshot(source);
    expect(snapshot.summary.storeTotalAvailable).toBe(false);
    expect(snapshot.summary.visitors).toBeNull();
    expect(snapshot.summary.paymentConversionRate).toBeNull();
  });

  it("keeps market KPI and Porter forces unavailable when market inputs are absent", () => {
    const source = structuredClone(getBusinessDiagnosisSource());
    source.market = { overview: [], priceBands: [], attributeSignals: [], searchSignals: [] };

    const snapshot = buildBusinessDiagnosisSnapshot(source);
    expect(snapshot.summary.marketSalesShare).toBeNull();
    expect(snapshot.valueChain.find((stage) => stage.key === "market")?.score).toBeNull();
    expect(snapshot.porterForces.every((item) => !item.available && item.intensity === null)).toBe(true);
    expect(snapshot.porterForces.every((item) => item.requiredData.length > 0)).toBe(true);
  });

  it("marks YYYY-MM comparisons as requiring month-end basis verification", () => {
    const snapshot = buildBusinessDiagnosisSnapshot(getBusinessDiagnosisSource());

    expect(snapshot.summary.comparisonBasisNote).toMatch(/YYYY-MM|月末口径/);
    expect(snapshot.market.periodNote).toContain("月末口径");
    expect(snapshot.aiReport.prompt).toContain("月末口径");
    expect(snapshot.valueChain.find((stage) => stage.key === "traffic")?.evidence).toContain("月末口径");
  });

  it("separates an open-month growth value from permission to conclude", () => {
    const today = currentIsoDate();
    const currentMonth = today.slice(0, 7);
    const [year, month] = currentMonth.split("-").map(Number);
    const previousMonth = month === 1
      ? `${year - 1}-12`
      : `${year}-${String(month - 1).padStart(2, "0")}`;
    const source = structuredClone(getBusinessDiagnosisSource());
    source.storeCategoryRows = source.storeCategoryRows
      .filter((row) => ["2025-11", "2025-12"].includes(row.month))
      .map((row) => ({
        ...row,
        month: row.month === "2025-11" ? previousMonth : currentMonth
      }));
    source.market.overview = [];

    const snapshot = buildBusinessDiagnosisSnapshot(source);

    expect(snapshot.summary.revenueGrowth).not.toBeNull();
    expect(snapshot.summary.comparisonConclusionAllowed).toBe(false);
    expect(snapshot.summary.comparisonEvidenceStatus).toBe("observation");
    expect(snapshot.categories.every((category) => !category.comparisonConclusionAllowed)).toBe(true);
    expect(snapshot.valueChain.find((stage) => stage.key === "traffic")?.score).toBeNull();
  });
});
