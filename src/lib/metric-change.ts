export type MetricChangeStatus =
  | "increased"
  | "decreased"
  | "unchanged"
  | "new"
  | "disappeared"
  | "unavailable";

export interface MetricChange {
  status: MetricChangeStatus;
  delta: number | null;
  rate: number | null;
}

const EPSILON = 1e-9;

/** “新增/消失”是业务状态，不伪造成 ±100%。 */
export function metricChange(before: number | null, after: number | null): MetricChange {
  if (before === null || after === null || !Number.isFinite(before) || !Number.isFinite(after)) {
    return { status: "unavailable", delta: null, rate: null };
  }
  const delta = after - before;
  if (Math.abs(before) < EPSILON && Math.abs(after) >= EPSILON) {
    return { status: "new", delta, rate: null };
  }
  if (Math.abs(before) >= EPSILON && Math.abs(after) < EPSILON) {
    return { status: "disappeared", delta, rate: null };
  }
  if (Math.abs(delta) < EPSILON) {
    return { status: "unchanged", delta: 0, rate: 0 };
  }
  return {
    status: delta > 0 ? "increased" : "decreased",
    delta,
    rate: delta / Math.abs(before)
  };
}
