export type ModelPortfolio = "keep_core" | "keep_reworked" | "conditional" | "retire";

export type AdmissionMode = "direct" | "proxy" | "qualitative" | "disabled";

export type ClaimCapability =
  | "describe"
  | "compare"
  | "rank"
  | "propose_test"
  | "unlock_financial_gate"
  | "claim_causality";

export type DiagnosisModelId =
  | "diagnosis-readiness"
  | "operating-result"
  | "profit-identity"
  | "potential-product-pools"
  | "product-bottleneck"
  | "audience-plan"
  | "investment-action-network"
  | "effect-validation"
  | "category-portfolio"
  | "evidence-value-chain"
  | "market-opportunity-radar"
  | "evidence-synthesis"
  | "experience-curve"
  | "scale-economy"
  | "pest"
  | "porter-five-forces"
  | "seven-s"
  | "nps"
  | "incrementality-attribution"
  | "classic-bcg-from-target-gap"
  | "proxy-nps-as-nps"
  | "short-window-monthly-extrapolation"
  | "roi-auto-scale"
  | "profit-buffer-as-budget";

export interface DiagnosisEvidenceProfile {
  hasOperatingResults?: boolean;
  hasProfitEvidence?: boolean;
  hasTrendComparison?: boolean;
  hasOpportunityTargets?: boolean;
  hasProductDimensions?: boolean;
  hasAudienceSignals?: boolean;
  hasAudienceEconomics?: boolean;
  hasInvestmentApproval?: boolean;
  hasClosedComparison?: boolean;
  hasControlGroup?: boolean;
  hasCategoryData?: boolean;
  hasComparableCategoryPeriods?: boolean;
  hasMarketSignals?: boolean;
  hasAlignedMarketPeriod?: boolean;
  hasUnitCostCurve?: boolean;
  hasScaleCostStructure?: boolean;
  hasMacroEvidence?: boolean;
  hasCompetitionEvidence?: boolean;
  hasOrganizationEvidence?: boolean;
  hasNpsSurvey?: boolean;
}

export interface AdmissionCheck {
  id: string;
  hard: boolean;
  passed: boolean;
  expected: string;
  reason: string;
}

export interface ModelAdmissionDecision {
  modelId: DiagnosisModelId;
  portfolio: ModelPortfolio;
  mode: AdmissionMode;
  displayName: string;
  summary: string;
  confidence: {
    score: number;
    level: "high" | "medium" | "low" | "none";
    reasons: string[];
  };
  checks: AdmissionCheck[];
  canProve: string[];
  cannotProve: string[];
  requiredData: string[];
  allowedClaims: ClaimCapability[];
  forbiddenClaims: ClaimCapability[];
  canUnlockGate: boolean;
}

