import { describe, expect, it } from "vitest";
import { evaluateDiagnosisModels } from "@/lib/model-admission/evaluate";

describe("diagnosis model admission", () => {
  it("never runs retired automatic inferences", () => {
    const decisions = evaluateDiagnosisModels({
      hasOperatingResults: true,
      hasProfitEvidence: true,
      hasTrendComparison: true,
      hasOpportunityTargets: true,
      hasProductDimensions: true,
      hasAudienceSignals: true,
      hasAudienceEconomics: true,
      hasInvestmentApproval: true,
      hasClosedComparison: true,
      hasControlGroup: true,
      hasCategoryData: true,
      hasComparableCategoryPeriods: true,
      hasMarketSignals: true,
      hasAlignedMarketPeriod: true,
      hasUnitCostCurve: true,
      hasScaleCostStructure: true,
      hasMacroEvidence: true,
      hasCompetitionEvidence: true,
      hasOrganizationEvidence: true,
      hasNpsSurvey: true
    });

    expect(decisions.filter((item) => item.portfolio === "retire")).not.toHaveLength(0);
    expect(decisions.filter((item) => item.portfolio === "retire").every((item) => item.mode === "disabled")).toBe(true);
  });

  it("locks classic consulting models when only operating and market proxies exist", () => {
    const decisions = evaluateDiagnosisModels({
      hasOperatingResults: true,
      hasCategoryData: true,
      hasComparableCategoryPeriods: true,
      hasMarketSignals: true,
      hasAlignedMarketPeriod: true
    });
    for (const modelId of ["experience-curve", "scale-economy", "pest", "porter-five-forces", "seven-s", "nps"] as const) {
      const decision = decisions.find((item) => item.modelId === modelId);
      expect(decision?.mode).toBe("disabled");
      expect(decision?.requiredData.length).toBeGreaterThan(0);
    }
    expect(decisions.find((item) => item.modelId === "market-opportunity-radar")?.mode).toBe("proxy");
  });

  it("keeps proxy models away from financial and causal authorization", () => {
    const decisions = evaluateDiagnosisModels({
      hasOperatingResults: true,
      hasOpportunityTargets: true,
      hasAudienceSignals: true,
      hasMarketSignals: true
    });
    const proxies = decisions.filter((item) => item.mode === "proxy");
    expect(proxies.length).toBeGreaterThan(0);
    expect(proxies.every((item) => item.canUnlockGate === false)).toBe(true);
    expect(proxies.every((item) => item.forbiddenClaims.includes("unlock_financial_gate"))).toBe(true);
    expect(proxies.every((item) => item.forbiddenClaims.includes("claim_causality"))).toBe(true);
  });

  it("unlocks NPS only with a direct recommendation survey", () => {
    const locked = evaluateDiagnosisModels({ hasOperatingResults: true });
    const unlocked = evaluateDiagnosisModels({ hasOperatingResults: true, hasNpsSurvey: true });
    expect(locked.find((item) => item.modelId === "nps")?.mode).toBe("disabled");
    expect(unlocked.find((item) => item.modelId === "nps")?.mode).toBe("direct");
  });
});

