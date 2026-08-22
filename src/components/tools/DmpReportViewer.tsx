import type { ComponentProps } from "react";
import { DmpGrowthReportViewer } from "@/components/tools/DmpGrowthReportViewer";
import { DmpMarketReportViewer } from "@/components/tools/DmpMarketReportViewer";

export function DmpReportViewer(props: ComponentProps<typeof DmpGrowthReportViewer>) {
  const market = props.record.reportType === "market" || props.record.report.report_type === "market";
  return market ? <DmpMarketReportViewer {...props} /> : <DmpGrowthReportViewer {...props} />;
}
