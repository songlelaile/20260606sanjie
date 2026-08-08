import { countInclusiveDays } from "@/lib/analysis-period";

export type EvidenceWindowStatus =
  | "ready"
  | "observation"
  | "insufficient"
  | "not-comparable";

export type EvidenceReasonCode =
  | "ready"
  | "calendar-open"
  | "coverage-gap"
  | "missing-input"
  | "sample-too-small"
  | "period-mismatch"
  | "future-anchor";

export interface EvidenceReason {
  code: EvidenceReasonCode;
  message: string;
}

export interface EvidenceWindowSide {
  start: string;
  end: string;
  expectedDays: number;
  observedDays: number;
  coverageRatio: number;
  calendarClosed: boolean;
  sourceCovered: boolean;
  sampleSize: number;
  minimumSampleSize: number;
}

export interface EvidenceWindowAssessment {
  status: EvidenceWindowStatus;
  conclusionAllowed: boolean;
  asOfDate: string;
  sides: EvidenceWindowSide[];
  missingFields: string[];
  reasons: EvidenceReason[];
  message: string;
}

export interface EvidenceSideInput {
  start: string;
  end: string;
  /** 数据源实际覆盖的不同自然日；不能用实体是否有经营活动代替。 */
  observedDays: number;
  sampleSize?: number;
  minimumSampleSize?: number;
}

export interface AssessEvidenceWindowInput {
  sides: EvidenceSideInput[];
  asOfDate: string;
  anchorDate?: string;
  missingFields?: string[];
  comparable?: boolean;
  comparisonIssue?: string;
}

/**
 * 全项目唯一的证据窗口判定器。
 *
 * 数值是否存在由各指标自身表达；本函数只回答“当前证据是否允许下结论”。
 * 调用方可以继续展示已有事实值，但 conclusionAllowed=false 时不得生成涨跌、
 * 优劣、放量、利润等判断。
 */
export function assessEvidenceWindow(input: AssessEvidenceWindowInput): EvidenceWindowAssessment {
  const reasons: EvidenceReason[] = [];
  const missingFields = [...new Set((input.missingFields ?? []).filter(Boolean))];
  const sides = input.sides.map((side) => normalizeSide(side, input.asOfDate));

  if (input.anchorDate && input.anchorDate > input.asOfDate) {
    reasons.push({
      code: "future-anchor",
      message: `锚点日期 ${input.anchorDate} 晚于当前业务日 ${input.asOfDate}`
    });
  }
  if (input.comparable === false) {
    reasons.push({
      code: "period-mismatch",
      message: input.comparisonIssue || "前后证据口径或统计周期不可比"
    });
  }
  if (missingFields.length > 0) {
    reasons.push({
      code: "missing-input",
      message: `缺少结论所需字段：${missingFields.join("、")}`
    });
  }
  for (const [index, side] of sides.entries()) {
    const label = sides.length === 2 ? (index === 0 ? "前窗" : "后窗") : "分析窗";
    if (!side.calendarClosed) {
      reasons.push({ code: "calendar-open", message: `${label}截至 ${side.end}，自然日尚未闭合` });
    }
    if (!side.sourceCovered) {
      reasons.push({
        code: "coverage-gap",
        message: `${label}数据覆盖不足，${label}实际 ${side.observedDays}/${side.expectedDays} 天`
      });
    }
    if (side.sampleSize < side.minimumSampleSize) {
      reasons.push({
        code: "sample-too-small",
        message: `${label}有效样本 ${side.sampleSize}/${side.minimumSampleSize}`
      });
    }
  }

  let status: EvidenceWindowStatus;
  const closedCoverageGap = sides.some((side) => side.calendarClosed && !side.sourceCovered);
  if (reasons.some((reason) => reason.code === "period-mismatch")) {
    status = "not-comparable";
  } else if (reasons.some((reason) => reason.code === "future-anchor")) {
    status = "observation";
  } else if (closedCoverageGap || missingFields.length > 0 || reasons.some((reason) => reason.code === "sample-too-small")) {
    status = "insufficient";
  } else if (reasons.some((reason) => reason.code === "calendar-open")) {
    status = "observation";
  } else if (reasons.length > 0) {
    status = "insufficient";
  } else {
    status = "ready";
    reasons.push({ code: "ready", message: "统计周期已闭合、数据源覆盖完整且样本满足要求" });
  }

  return {
    status,
    conclusionAllowed: status === "ready",
    asOfDate: input.asOfDate,
    sides,
    missingFields,
    reasons,
    message: reasons.map((reason) => reason.message).join("；")
  };
}

export function canConcludeFromEvidence(assessment: EvidenceWindowAssessment): boolean {
  return assessment.conclusionAllowed;
}

function normalizeSide(side: EvidenceSideInput, asOfDate: string): EvidenceWindowSide {
  const expectedDays = Math.max(1, countInclusiveDays(side.start, side.end));
  const observedDays = Math.max(0, Math.round(side.observedDays));
  const minimumSampleSize = Math.max(0, Math.round(side.minimumSampleSize ?? 0));
  const sampleSize = Math.max(0, Math.round(side.sampleSize ?? observedDays));
  return {
    start: side.start,
    end: side.end,
    expectedDays,
    observedDays,
    coverageRatio: Math.min(1, observedDays / expectedDays),
    calendarClosed: side.end < asOfDate,
    sourceCovered: observedDays >= expectedDays,
    sampleSize,
    minimumSampleSize
  };
}
