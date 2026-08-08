import type {
  AdmissionMode,
  ClaimCapability,
  DiagnosisModelId,
  ModelAdmissionDecision
} from "@/lib/model-admission/evaluate";

export interface AiAdmittedDiagnosisModel {
  modelId: DiagnosisModelId;
  name: string;
  mode: Exclude<AdmissionMode, "disabled">;
  canProve: string[];
  cannotProve: string[];
  allowedClaims: ClaimCapability[];
}

export interface AiDiagnosisModelContext {
  admittedModels: AiAdmittedDiagnosisModel[];
  /** 只提供补数项，不把未准入/退役模型名称或分数交给生成模型。 */
  modelDataGaps: string[];
}

export function buildAiDiagnosisModelContext(
  decisions: ModelAdmissionDecision[]
): AiDiagnosisModelContext {
  const admittedModels = decisions
    .filter(
      (item): item is ModelAdmissionDecision & { mode: Exclude<AdmissionMode, "disabled"> } =>
        item.portfolio !== "retire" && item.mode !== "disabled"
    )
    .map((item) => ({
      modelId: item.modelId,
      name: item.displayName,
      mode: item.mode,
      canProve: item.canProve,
      cannotProve: item.cannotProve,
      allowedClaims: item.allowedClaims
    }));
  const modelDataGaps = uniqueText(
    decisions
      .filter((item) => item.portfolio !== "retire" && item.mode === "disabled")
      .flatMap((item) => item.requiredData)
  );

  return { admittedModels, modelDataGaps };
}

function uniqueText(items: string[]) {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}
