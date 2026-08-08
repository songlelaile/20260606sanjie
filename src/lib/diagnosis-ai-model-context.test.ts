import { describe, expect, it } from "vitest";
import { buildAiDiagnosisModelContext } from "@/lib/diagnosis-ai-model-context";
import { evaluateDiagnosisModels } from "@/lib/model-admission/evaluate";

describe("AI diagnosis model context", () => {
  it("sends only admitted models while retaining anonymous data gaps", () => {
    const decisions = evaluateDiagnosisModels({
      hasOperatingResults: true,
      hasProfitEvidence: false,
      hasTrendComparison: true,
      hasOpportunityTargets: true,
      hasProductDimensions: true,
      hasAudienceSignals: true,
      hasAudienceEconomics: false,
      hasInvestmentApproval: false,
      hasClosedComparison: false,
      hasControlGroup: false,
      hasCategoryData: true,
      hasComparableCategoryPeriods: true,
      hasMarketSignals: true,
      hasAlignedMarketPeriod: false,
      hasUnitCostCurve: false,
      hasScaleCostStructure: false,
      hasMacroEvidence: false,
      hasCompetitionEvidence: false,
      hasOrganizationEvidence: false,
      hasNpsSurvey: false
    });

    const context = buildAiDiagnosisModelContext(decisions);
    const ids = context.admittedModels.map((item) => item.modelId);

    expect(ids).toContain("operating-result");
    expect(ids).toContain("market-opportunity-radar");
    expect(ids).not.toContain("experience-curve");
    expect(ids).not.toContain("scale-economy");
    expect(ids).not.toContain("pest");
    expect(ids).not.toContain("classic-bcg-from-target-gap");
    expect(context.admittedModels.map((item) => item.mode)).not.toContain("disabled");
    expect(context.modelDataGaps).toContain("至少六个可比期的累计产量与单位成本");
    expect(JSON.stringify(context)).not.toMatch(/经典经验曲线|真正规模效应|PEST|人工目标差额伪 BCG/);
  });
});
