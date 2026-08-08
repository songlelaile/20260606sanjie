import type {
  AudiencePlanItem,
  BreakthroughDimensionScore,
  CalcRun,
  DashboardShareSnapshot,
  ManagementDashboard,
  ProductBreakthroughResult,
  ProductInvestmentResult
} from "@/lib/types/domain";

export const CALC_RUN_SCHEMA_VERSION = 2;

const nullableNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const numberOr = (value: unknown, fallback = 0) => nullableNumber(value) ?? fallback;

export function normalizeInvestmentResults(value: unknown): ProductInvestmentResult[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.productId !== "string") return [];
    const profitEvidenceAvailable = row.profitEvidenceAvailable === true;
    return [{
      ...(row as unknown as ProductInvestmentResult),
      tagIds: Array.isArray(row.tagIds) ? row.tagIds.filter((item): item is string => typeof item === "string") : [],
      historicalPpc: numberOr(row.historicalPpc) > 0 ? numberOr(row.historicalPpc) : null,
      historicalAov: numberOr(row.historicalAov) > 0 ? numberOr(row.historicalAov) : null,
      plannedMonthlyOrders: nullableNumber(row.plannedMonthlyOrders),
      plannedMonthlyTraffic: nullableNumber(row.plannedMonthlyTraffic),
      monthlyPaidEstimate: nullableNumber(row.monthlyPaidEstimate),
      netSales: nullableNumber(row.netSales),
      historicalGrossProfitWithoutPromotion: nullableNumber(row.historicalGrossProfitWithoutPromotion),
      historicalGrossProfit: profitEvidenceAvailable ? nullableNumber(row.historicalGrossProfit) : null,
      historicalMarginRate: profitEvidenceAvailable ? nullableNumber(row.historicalMarginRate) : null,
      profitEvidenceAvailable,
      promotionSpend: profitEvidenceAvailable ? nullableNumber(row.promotionSpend) : null,
      remainingAdBudget: profitEvidenceAvailable ? nullableNumber(row.remainingAdBudget) : null,
      salesGap: nullableNumber(row.salesGap)
    }];
  });
}

export function normalizeBreakthroughResults(value: unknown): ProductBreakthroughResult[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.productId !== "string" || !Array.isArray(row.dimensions)) return [];
    const dimensions = row.dimensions.flatMap((dimension) => {
      if (!dimension || typeof dimension !== "object") return [];
      const item = dimension as Record<string, unknown>;
      return [{
        ...(item as unknown as BreakthroughDimensionScore),
        value: nullableNumber(item.value),
        threshold: nullableNumber(item.threshold),
        available: item.available === true ? true : item.available === false ? false : undefined,
        passed: item.passed === true
      }];
    });
    return [{ ...(row as unknown as ProductBreakthroughResult), dimensions }];
  });
}

export function normalizeAudiencePlans(value: unknown): AudiencePlanItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.planId !== "string") return [];
    return [{
      ...(row as unknown as AudiencePlanItem),
      clicks: nullableNumber(row.clicks),
      roi: nullableNumber(row.roi),
      guidedPotentialCustomerRatio: validRatio(row.guidedPotentialCustomerRatio),
      newCustomerRatio: validRatio(row.newCustomerRatio)
    }];
  });
}

export function normalizeManagementDashboard(value: unknown): ManagementDashboard {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    productCount: numberOr(row.productCount),
    monthlyNetSales: nullableNumber(row.monthlyNetSales),
    monthlyProfitEstimate: nullableNumber(row.monthlyProfitEstimate),
    monthlyGsvOpportunity: numberOr(row.monthlyGsvOpportunity),
    marketSalesGap: nullableNumber(row.marketSalesGap),
    historicalMarginRate: nullableNumber(row.historicalMarginRate),
    plannedProfit: numberOr(row.plannedProfit),
    availableAdBudget: nullableNumber(row.availableAdBudget),
    plannedMarginRate: numberOr(row.plannedMarginRate),
    profitEvidenceProductCount: numberOr(row.profitEvidenceProductCount),
    profitEvidenceMissingCount: numberOr(row.profitEvidenceMissingCount),
    profitEvidenceNetSales: nullableNumber(row.profitEvidenceNetSales),
    negativeMarginProducts: normalizeInvestmentResults(row.negativeMarginProducts),
    topProducts: normalizeInvestmentResults(row.topProducts),
    ...(isPeriod(row.analysisPeriod) ? { analysisPeriod: row.analysisPeriod } : {})
  };
}

export function normalizeCalcRun(value: unknown): CalcRun {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const managementDashboard = normalizeManagementDashboard(row.managementDashboard);
  return {
    schemaVersion: CALC_RUN_SCHEMA_VERSION,
    id: typeof row.id === "string" ? row.id : "",
    cycleId: typeof row.cycleId === "string" ? row.cycleId : "",
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
    ...(isPeriod(row.analysisPeriod) ? { analysisPeriod: row.analysisPeriod } :
      managementDashboard.analysisPeriod ? { analysisPeriod: managementDashboard.analysisPeriod } : {}),
    investmentResults: normalizeInvestmentResults(row.investmentResults),
    breakthroughResults: normalizeBreakthroughResults(row.breakthroughResults),
    audiencePlans: normalizeAudiencePlans(row.audiencePlans),
    managementDashboard
  };
}

export function normalizeDashboardShareSnapshot(value: unknown): DashboardShareSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!row.calcRun || typeof row.title !== "string") return null;
  return {
    ...(row as unknown as DashboardShareSnapshot),
    calcRun: normalizeCalcRun(row.calcRun)
  };
}

function validRatio(value: unknown) {
  const numeric = nullableNumber(value);
  return numeric !== null && numeric >= 0 && numeric <= 1 ? numeric : null;
}

function isPeriod(value: unknown): value is { start: string; end: string } {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.start === "string" && typeof row.end === "string";
}
