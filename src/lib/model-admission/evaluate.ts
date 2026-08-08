import {
  DEFAULT_FORBIDDEN_CLAIMS,
  DIAGNOSIS_MODEL_REGISTRY
} from "@/lib/model-admission/registry";
import type {
  AdmissionMode,
  ClaimCapability,
  DiagnosisEvidenceProfile,
  ModelAdmissionDecision
} from "@/lib/model-admission/types";

export function evaluateDiagnosisModels(
  profile: DiagnosisEvidenceProfile
): ModelAdmissionDecision[] {
  return DIAGNOSIS_MODEL_REGISTRY.map((model) => {
    const checks = model.requirements.map((requirement) => {
      const passed = profile[requirement.key] === true;
      return {
        id: `${model.modelId}:${requirement.key}`,
        hard: true,
        passed,
        expected: requirement.label,
        reason: passed ? `已满足：${requirement.label}` : `待补：${requirement.label}`
      };
    });
    const failed = checks.filter((check) => !check.passed);
    const mode = resolveMode(model.modelId, model.portfolio, model.readyMode, profile, failed.length);
    const score = confidenceScore(mode, checks.length, failed.length, profile, model.modelId);
    const allowedClaims = mode === "disabled" ? [] : model.allowedClaims;
    const forbiddenClaims = unique([
      ...DEFAULT_FORBIDDEN_CLAIMS,
      ...(["proxy", "qualitative", "disabled"].includes(mode) ? ["unlock_financial_gate"] : []),
      ...(mode !== "direct" ? ["claim_causality"] : [])
    ] as ClaimCapability[]).filter((claim) => !allowedClaims.includes(claim));

    return {
      modelId: model.modelId,
      portfolio: model.portfolio,
      mode,
      displayName: model.displayName,
      summary: model.summary,
      confidence: {
        score,
        level: score >= 80 ? "high" : score >= 55 ? "medium" : score > 0 ? "low" : "none",
        reasons: model.portfolio === "retire"
          ? ["当前实现已退出默认诊断"]
          : checks.map((check) => check.reason)
      },
      checks,
      canProve: mode === "disabled" ? [] : model.canProve,
      cannotProve: model.cannotProve,
      requiredData: mode === "disabled" ? unique([...failed.map((item) => item.expected), ...model.requiredData]) : [],
      allowedClaims,
      forbiddenClaims,
      canUnlockGate: false
    } satisfies ModelAdmissionDecision;
  });
}

function resolveMode(
  modelId: ModelAdmissionDecision["modelId"],
  portfolio: ModelAdmissionDecision["portfolio"],
  readyMode: AdmissionMode,
  profile: DiagnosisEvidenceProfile,
  failedCount: number
): AdmissionMode {
  if (portfolio === "retire") return "disabled";
  if (modelId === "category-portfolio" && profile.hasCategoryData && !profile.hasComparableCategoryPeriods) {
    return "proxy";
  }
  if (modelId === "market-opportunity-radar" && profile.hasMarketSignals) {
    return "proxy";
  }
  if (modelId === "audience-plan" && profile.hasAudienceEconomics) {
    return "direct";
  }
  return failedCount === 0 ? readyMode : "disabled";
}

function confidenceScore(
  mode: AdmissionMode,
  checkCount: number,
  failedCount: number,
  profile: DiagnosisEvidenceProfile,
  modelId: ModelAdmissionDecision["modelId"]
) {
  if (mode === "disabled") return 0;
  const passedRate = checkCount === 0 ? 1 : (checkCount - failedCount) / checkCount;
  const base = mode === "direct" ? 88 : mode === "proxy" ? 58 : 45;
  const alignmentPenalty = modelId === "market-opportunity-radar" && !profile.hasAlignedMarketPeriod ? 15 : 0;
  return Math.max(0, Math.round(base * passedRate - alignmentPenalty));
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export type {
  AdmissionCheck,
  AdmissionMode,
  ClaimCapability,
  DiagnosisEvidenceProfile,
  DiagnosisModelId,
  ModelAdmissionDecision,
  ModelPortfolio
} from "@/lib/model-admission/types";

