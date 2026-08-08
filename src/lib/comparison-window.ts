import type {
  ComparisonWindowCoverage,
  ComparisonWindowStatus
} from "@/lib/types/domain";
import { assessEvidenceWindow } from "@/lib/analysis-evidence";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 返回指定时区的自然日。动作和分日明细都使用 YYYY-MM-DD，不能直接用 UTC 日期代替业务日。
 */
export function currentIsoDate(now = new Date(), timeZone = "Asia/Shanghai"): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const value = new Map(parts.map((part) => [part.type, part.value]));
  return `${value.get("year")}-${value.get("month")}-${value.get("day")}`;
}

export function isFutureInterventionDate(date: string, asOfDate = currentIsoDate()): boolean {
  return ISO_DATE_RE.test(date) && ISO_DATE_RE.test(asOfDate) && date > asOfDate;
}

export interface AssessComparisonWindowInput {
  interventionDate: string;
  beforeEnd: string;
  afterEnd: string;
  beforeExpectedDays: number;
  afterExpectedDays: number;
  beforeObservedDays: number;
  afterObservedDays: number;
  asOfDate?: string;
}

/**
 * 判断动作窗口能否输出涨跌结论。
 * - observation：动作在未来，或后窗自然日尚未走完；
 * - insufficient：自然日已经走完，但任一窗口缺日；
 * - ready：前后窗自然日都闭合，且每天都有主数据源记录。
 */
export function assessComparisonWindow({
  interventionDate,
  beforeEnd,
  afterEnd,
  beforeExpectedDays,
  afterExpectedDays,
  beforeObservedDays,
  afterObservedDays,
  asOfDate = currentIsoDate()
}: AssessComparisonWindowInput): ComparisonWindowCoverage {
  const beforeStart = addDays(beforeEnd, -(Math.max(1, beforeExpectedDays) - 1));
  const afterStart = interventionDate;
  const evidence = assessEvidenceWindow({
    asOfDate,
    anchorDate: interventionDate,
    comparable: beforeExpectedDays === afterExpectedDays,
    comparisonIssue: beforeExpectedDays === afterExpectedDays ? undefined : "动作前后窗口长度不一致",
    sides: [
      { start: beforeStart, end: beforeEnd, observedDays: beforeObservedDays },
      { start: afterStart, end: afterEnd, observedDays: afterObservedDays }
    ]
  });
  const beforeSide = evidence.sides[0];
  const afterSide = evidence.sides[1];
  const before = sideCoverage(beforeSide.expectedDays, beforeSide.observedDays, beforeSide.calendarClosed);
  const after = sideCoverage(afterSide.expectedDays, afterSide.observedDays, afterSide.calendarClosed);
  const status: ComparisonWindowStatus = evidence.status === "not-comparable" ? "insufficient" : evidence.status;

  return {
    status,
    asOfDate,
    message: evidence.message,
    before,
    after
  };
}

export function canConcludeComparison(coverage: ComparisonWindowCoverage): boolean {
  return coverage.status === "ready";
}

function sideCoverage(expectedDays: number, observedDays: number, calendarClosed: boolean) {
  const expected = Math.max(1, Math.round(expectedDays));
  const observed = Math.max(0, Math.round(observedDays));
  return {
    expectedDays: expected,
    observedDays: observed,
    coverageRatio: Math.min(1, observed / expected),
    calendarClosed,
    complete: calendarClosed && observed >= expected
  };
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
