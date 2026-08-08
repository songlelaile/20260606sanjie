import type {
  CalcRun,
  DashboardShareSection,
  ManagementDashboard
} from "@/lib/types/domain";

export const DASHBOARD_SHARE_SECTIONS: DashboardShareSection[] = [
  "management",
  "breakthrough",
  "audience",
  "prefill"
];

export const DASHBOARD_SHARE_SECTION_LABELS: Record<DashboardShareSection, string> = {
  management: "综合看板",
  breakthrough: "单品突破",
  audience: "人群计划",
  prefill: "预填写表"
};

export function parseDashboardShareSections(value: unknown): DashboardShareSection[] | null {
  if (!Array.isArray(value)) return null;
  const result: DashboardShareSection[] = [];
  for (const section of value) {
    if (!DASHBOARD_SHARE_SECTIONS.includes(section as DashboardShareSection)) {
      return null;
    }
    if (!result.includes(section as DashboardShareSection)) {
      result.push(section as DashboardShareSection);
    }
  }
  return result.length > 0 ? result : null;
}

export function normalizeDashboardShareSections(input?: DashboardShareSection[]): DashboardShareSection[] {
  return parseDashboardShareSections(input) ?? ["management"];
}

export function emptyManagementDashboard(): ManagementDashboard {
  return {
    productCount: 0,
    monthlyNetSales: 0,
    monthlyProfitEstimate: 0,
    monthlyGsvOpportunity: 0,
    marketSalesGap: 0,
    // 空看板没有任何商品 → 毛利率无从计算，是 null 而不是 0%。
    historicalMarginRate: null,
    plannedProfit: 0,
    availableAdBudget: 0,
    plannedMarginRate: 0,
    profitEvidenceProductCount: 0,
    profitEvidenceMissingCount: 0,
    profitEvidenceNetSales: 0,
    negativeMarginProducts: [],
    topProducts: []
  };
}

export function buildDashboardShareCalcRun(run: CalcRun, sections: DashboardShareSection[]): CalcRun {
  const includeManagement = sections.includes("management");
  return {
    id: run.id,
    cycleId: run.cycleId,
    createdAt: run.createdAt,
    investmentResults: [],
    breakthroughResults: sections.includes("breakthrough") ? run.breakthroughResults : [],
    audiencePlans: sections.includes("audience") ? run.audiencePlans : [],
    managementDashboard: includeManagement ? run.managementDashboard : emptyManagementDashboard()
  };
}
