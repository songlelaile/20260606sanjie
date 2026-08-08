import type { ManagementDashboard, ProductInvestmentResult } from "@/lib/types/domain";
import { divideOrNull, divideOrZero } from "@/lib/safe-math";

const PRODUCT_GRADES = ["S", "A", "B", "C"];

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function sumKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return known.length > 0 ? sum(known) : null;
}

/**
 * 是否具备"同分析窗推广成本"证据。旧快照没有该字段（undefined）时按未知处理：
 * 未知不等于 0，不能计入利润口径。
 */
function hasProfitEvidence(row: ProductInvestmentResult): boolean {
  return row.profitEvidenceAvailable === true;
}

export function aggregateManagementDashboard(
  investmentResults: ProductInvestmentResult[],
  topLimit = 10
): ManagementDashboard {
  const monthlyNetSales = sumKnown(investmentResults.map((row) => row.netSales));
  const monthlyGsvOpportunity = sum(investmentResults.map((row) => row.monthlyGsvOpportunity));
  const plannedProfit = sum(investmentResults.map((row) => row.plannedGrossProfit));

  // 利润口径只由证据完整的商品构成。历史上分子被清零、分母仍是全店净销额，
  // 会把全店毛利率系统性稀释成偏低值——"未知"被静默当成了"零利润"。
  const evidenceRows = investmentResults.filter(hasProfitEvidence);
  const monthlyProfitEstimate = sumKnown(evidenceRows.map((row) => row.historicalGrossProfit));
  const profitEvidenceNetSales = sumKnown(evidenceRows.map((row) => row.netSales));

  // 正向静态利润安全垫，不是获批预算；缺同窗成本或负向商品均不计入。
  const availableAdBudget = sumKnown(
    evidenceRows.map((row) => row.remainingAdBudget === null ? null : Math.max(row.remainingAdBudget, 0))
  );

  const ranked = [...investmentResults]
    .filter((row) => PRODUCT_GRADES.includes(row.grade) && row.monthlyGsvOpportunity > 0)
    .sort((a, b) => (b.netSales ?? Number.NEGATIVE_INFINITY) - (a.netSales ?? Number.NEGATIVE_INFINITY));

  return {
    productCount: investmentResults.length,
    monthlyNetSales,
    monthlyProfitEstimate,
    monthlyGsvOpportunity,
    marketSalesGap: monthlyNetSales === null ? null : monthlyNetSales - monthlyGsvOpportunity,
    // 分子分母同口径；无证据完整商品时为 null（无法计算），不是 0%。
    historicalMarginRate:
      monthlyProfitEstimate === null || profitEvidenceNetSales === null
        ? null
        : divideOrNull(monthlyProfitEstimate, profitEvidenceNetSales),
    plannedProfit,
    availableAdBudget,
    plannedMarginRate: divideOrZero(plannedProfit, monthlyGsvOpportunity),
    profitEvidenceProductCount: evidenceRows.length,
    profitEvidenceMissingCount: investmentResults.length - evidenceRows.length,
    profitEvidenceNetSales,
    // 高销售额负毛利商品原先只是被 TopProducts 过滤掉、悄悄消失；它们恰恰最需要被看见。
    negativeMarginProducts: ranked
      .filter((row) => row.grossMarginRate <= 0 && (row.netSales ?? 0) > 0)
      .slice(0, topLimit),
    topProducts: ranked.filter((row) => row.grossMarginRate > 0).slice(0, topLimit)
  };
}
