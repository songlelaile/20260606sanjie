import "server-only";
import {
  buildBusinessDiagnosisSnapshot,
  type BusinessDiagnosisSource
} from "@/lib/business-diagnosis";
import { resolveAnalysisPeriod, resolveSourcePeriodAlignment } from "@/lib/analysis-period";
import { buildOperatingNetworkSnapshot, type OperatingNetworkSnapshot } from "@/lib/operating-network";
import { isPrefillReady } from "@/lib/prefill-status";
import {
  countAudienceWindowDays,
  countProductWindowDays,
  countPromotionWindowDays
} from "@/lib/store/daily-metrics";
import {
  getBusinessDiagnosisWorkspaceSource,
  getImportBatches,
  getLatestCalcRun,
  getPrefillItems,
  getStoreDailyTrend,
  getWorkspaceContext
} from "@/lib/store/runtime-store";

export interface ScopedOperatingNetworkResult {
  snapshot: OperatingNetworkSnapshot;
  hasDiagnosticData: boolean;
}

/**
 * 只从服务端已验证的当前会话取得 tenant/shop 作用域。
 * 本函数故意不接收 tenantId、shopId、userId，避免诊断调用方引入跨租户选择面。
 */
export async function getScopedOperatingNetwork(): Promise<ScopedOperatingNetworkResult> {
  const calcRun = await getLatestCalcRun();
  const scopedProductIds = calcRun.investmentResults.map((item) => item.productId);
  const [businessSource, trend, context, prefillItems, batches] = await Promise.all([
    getBusinessDiagnosisWorkspaceSource(),
    scopedProductIds.length > 0 ? getStoreDailyTrend(scopedProductIds) : Promise.resolve(null),
    getWorkspaceContext(),
    getPrefillItems(),
    getImportBatches()
  ]);
  const businessDiagnosis = hasBusinessDiagnosisSourceData(businessSource)
    ? buildBusinessDiagnosisSnapshot(businessSource)
    : undefined;
  const analysisRange = calcRun.analysisPeriod ?? resolveAnalysisPeriod(context.cycle, batches);
  const sourcePeriodAlignment = resolveSourcePeriodAlignment(batches, analysisRange);
  const [productObservedDays, promotionObservedDays, audienceObservedDays] = await Promise.all([
    countProductWindowDays(context.shop.tenantId, context.shop.id, null, analysisRange.start, analysisRange.end),
    countPromotionWindowDays(context.shop.tenantId, context.shop.id, null, analysisRange.start, analysisRange.end),
    countAudienceWindowDays(context.shop.tenantId, context.shop.id, null, analysisRange.start, analysisRange.end)
  ]);
  // 最新一次商品上传窗可能只有数天，但分日库仍保留此前连续数据。
  // 诊断趋势使用截至分析窗结束日的全部既有历史，由规则引擎挑选最近两段连续等长窗口。
  const comparableTrend = trendSeriesThroughAnalysisEnd(trend?.series ?? [], analysisRange.end);
  const snapshot = buildOperatingNetworkSnapshot({
    investmentResults: calcRun.investmentResults,
    breakthroughResults: calcRun.breakthroughResults,
    audiencePlans: calcRun.audiencePlans,
    ...(businessDiagnosis ? { businessDiagnosis } : {}),
    ...(comparableTrend.length > 0 ? { trendSeries: comparableTrend } : {}),
    analysisPeriod: { start: analysisRange.start, end: analysisRange.end },
    readinessContext: {
      readyPrefillCount: prefillItems.filter(isPrefillReady).length,
      totalPrefillCount: prefillItems.length,
      shopName: context.shop.name,
      sourceCoverage: {
        product: batches.some((item) => item.reportType === "product_source" && item.validation.ok),
        damo: batches.some((item) => item.reportType === "damo_product_source" && item.validation.ok),
        promotion: batches.some((item) => item.reportType === "promotion_product_source" && item.validation.ok),
        audience: batches.some((item) => item.reportType === "audience_source" && item.validation.ok),
        business: Boolean(businessDiagnosis)
      },
      sourcePeriodAlignment,
      sourceObservedDays: {
        product: productObservedDays,
        promotion: promotionObservedDays,
        audience: audienceObservedDays
      }
    }
  });
  return {
    snapshot,
    hasDiagnosticData: Boolean(
      calcRun.investmentResults.length ||
      calcRun.breakthroughResults.length ||
      calcRun.audiencePlans.length ||
      businessDiagnosis
    )
  };
}

export function trendSeriesThroughAnalysisEnd<T extends { date: string }>(series: T[], analysisEnd: string): T[] {
  return series.filter((item) => item.date <= analysisEnd);
}

function hasBusinessDiagnosisSourceData(
  source: BusinessDiagnosisSource | null
): source is BusinessDiagnosisSource {
  return Boolean(
    source &&
      (source.storeCategoryRows.length > 0 ||
        source.market.overview.length > 0 ||
        source.market.priceBands.length > 0 ||
        source.market.attributeSignals.length > 0 ||
        source.market.searchSignals.length > 0)
  );
}
