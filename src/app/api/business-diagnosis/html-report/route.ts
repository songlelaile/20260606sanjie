import { buildBusinessDiagnosisSnapshot } from "@/lib/business-diagnosis";
import { buildCustomerReportHtml } from "@/lib/customer-report";
import { diagnosisJson, requireDiagnosisApiAccess } from "@/lib/diagnosis-route-security";
import { getBusinessDiagnosisWorkspaceSource } from "@/lib/store/runtime-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Downloads the current shop's deterministic customer report without exposing source data cross-tenant. */
export async function GET() {
  const unauthorized = await requireDiagnosisApiAccess("read");
  if (unauthorized) return unauthorized;

  const source = await getBusinessDiagnosisWorkspaceSource();
  if (!source || !hasDiagnosisData(source)) {
    return diagnosisJson({ error: "请先导入业务诊断源表后再生成 HTML 报告" }, { status: 400 });
  }

  const snapshot = buildBusinessDiagnosisSnapshot(source);
  const period = snapshot.summary.latestStoreMonth || "待补数据";
  return new Response(buildCustomerReportHtml(snapshot), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`店铺经营数据沟通报告-${period}.html`)}`,
      "Cache-Control": "private, no-store",
      Vary: "Cookie"
    }
  });
}

function hasDiagnosisData(source: NonNullable<Awaited<ReturnType<typeof getBusinessDiagnosisWorkspaceSource>>>) {
  return (
    source.storeCategoryRows.length > 0 ||
    source.market.overview.length > 0 ||
    source.market.priceBands.length > 0 ||
    source.market.attributeSignals.length > 0 ||
    source.market.searchSignals.length > 0
  );
}
