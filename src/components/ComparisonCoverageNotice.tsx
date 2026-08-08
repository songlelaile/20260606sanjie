import clsx from "clsx";
import type { ComparisonWindow } from "@/lib/types/domain";

const STATUS_LABEL = {
  ready: "窗口完整",
  observation: "观察中",
  insufficient: "证据不足"
} as const;

/** 动作前后窗的证据门控；非 ready 时 UI 不展示任何涨跌结论。 */
export function ComparisonCoverageNotice({ window }: { window: ComparisonWindow }) {
  const { coverage } = window;
  return (
    <div className={clsx("comparison-coverage", `comparison-coverage-${coverage.status}`)} role="status">
      <strong>{STATUS_LABEL[coverage.status]}</strong>
      <span>
        前窗实际 {coverage.before.observedDays}/{coverage.before.expectedDays} 天　·　后窗实际{" "}
        {coverage.after.observedDays}/{coverage.after.expectedDays} 天
      </span>
      <small>{coverage.message}</small>
    </div>
  );
}
