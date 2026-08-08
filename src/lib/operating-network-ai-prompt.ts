import { buildAiDiagnosisModelContext } from "@/lib/diagnosis-ai-model-context";
import type { NetworkFinding, OperatingNetworkSnapshot } from "@/lib/operating-network";

export function buildOperatingNetworkAiPrompt(snapshot: OperatingNetworkSnapshot) {
  return [
    "请按以下结构输出：",
    "1. 一句话经营判断：必须包含利润健康与当前最重要约束",
    "2. 预算总安排：区分经济上限、建议释放、保留预算；缺数据就写待确认，不得补造数字",
    "3. 投资对象：按商品列出候选、先修复后测、观察/停止；只有闸门和人工审批通过才可写获准加码",
    "4. 商品优化：指出八维短板、动作、负责人、验证指标",
    "5. 人群计划：分别给拉新、追投、收割的对象、出价边界或测试区间；证据不足时只能给测试方法",
    "6. 预算推进：按小测—验证—加码—稳定列出解锁条件与止损线",
    "7. 本周动作清单：P1/P2/P3、依赖关系、负责人、里程碑",
    "8. 不能证明与待补数据",
    "本次直接诊断不以同月类目市场数据为前置条件；缺失时不要把它列为阻断项。",
    "",
    "经营网络证据 JSON：",
    JSON.stringify(compactOperatingNetworkSnapshotForAi(snapshot))
  ].join("\n");
}

export function compactOperatingNetworkSnapshotForAi(snapshot: OperatingNetworkSnapshot) {
  // 类目/市场模型在已有证据时仍可使用；没有证据时不把可选市场数据包装成直接诊断的待补前置项。
  const directDiagnosisDecisions = snapshot.modelAdmissions.filter(
    (item) => item.mode !== "disabled" || !["category-portfolio", "market-opportunity-radar"].includes(item.modelId)
  );
  const { admittedModels, modelDataGaps } = buildAiDiagnosisModelContext(directDiagnosisDecisions);
  return {
    generatedAt: snapshot.generatedAt,
    analysisPeriod: snapshot.analysisPeriod,
    finding: compactFinding(snapshot.finding),
    readiness: {
      score: snapshot.readiness.score,
      readyPrefillCount: snapshot.readiness.readyPrefillCount,
      totalPrefillCount: snapshot.readiness.totalPrefillCount,
      checksPassed: snapshot.readiness.checksPassed,
      checksTotal: snapshot.readiness.checksTotal,
      requiredSourcesComplete: snapshot.readiness.requiredSourcesComplete,
      sourcePeriodsAligned: snapshot.readiness.sourcePeriodsAligned,
      profitEvidenceCoverage: snapshot.readiness.profitEvidenceCoverage,
      audienceProductMatchRate: snapshot.readiness.audienceProductMatchRate,
      finding: compactFinding(snapshot.readiness.finding)
    },
    outcome: {
      health: snapshot.outcome.health,
      netSales: snapshot.outcome.netSales,
      contributionProfit: snapshot.outcome.contributionProfit,
      marginRate: snapshot.outcome.marginRate,
      targetMarginRate: snapshot.outcome.targetMarginRate,
      profitBuffer: snapshot.outcome.profitBuffer,
      netSalesTrend: snapshot.outcome.netSalesTrend,
      profitTrend: snapshot.outcome.profitTrend,
      analysisDays: snapshot.outcome.analysisDays,
      finding: compactFinding(snapshot.outcome.finding)
    },
    profitDrivers: snapshot.profitDrivers.slice(0, 8).map((item) => ({
      title: item.title,
      key: item.key,
      contribution: item.contribution,
      contributionRate: item.contributionRate,
      direction: item.direction,
      finding: compactFinding(item.finding)
    })),
    investmentSpace: {
      economicCeiling: snapshot.investmentSpace.economicCeiling,
      approvedBudget: snapshot.investmentSpace.approvedBudget,
      suggestedTestBudget: snapshot.investmentSpace.suggestedTestBudget,
      reserveBudget: snapshot.investmentSpace.reserveBudget,
      eligibleProductCount: snapshot.investmentSpace.eligibleProductCount,
      medianRoiFloor: snapshot.investmentSpace.medianRoiFloor,
      scenarios: snapshot.investmentSpace.scenarios,
      finding: compactFinding(snapshot.investmentSpace.finding)
    },
    potentialProducts: snapshot.potentialProducts.slice(0, 8).map((item) => ({
      productId: item.productId,
      productName: item.productName,
      pool: item.pool,
      efficiencyBadge: item.efficiencyBadge,
      profitBadge: item.profitBadge,
      opportunityBadge: item.opportunityBadge,
      opportunityConfidence: item.opportunityConfidence,
      netSales: item.netSales,
      historicalGrossProfit: item.historicalGrossProfit,
      historicalMarginRate: item.historicalMarginRate,
      monthlyGsvOpportunity: item.monthlyGsvOpportunity,
      opportunityAmount: item.opportunityAmount,
      staticProfitBuffer: item.staticProfitBuffer,
      finding: compactFinding(item.finding)
    })),
    dimensionShortfalls: snapshot.dimensionShortfalls.slice(0, 8).map((item) => ({
      productId: item.productId,
      productName: item.productName,
      dimensionKey: item.dimensionKey,
      actualDisplay: item.actualDisplay,
      benchmarkDisplay: item.benchmarkDisplay,
      gapRate: item.gapRate,
      action: item.action,
      finding: compactFinding(item.finding)
    })),
    audienceRecommendations: snapshot.audienceRecommendations.slice(0, 8).map((item) => ({
      role: item.role,
      productId: item.productId,
      productName: item.productName,
      audienceName: item.audienceName,
      clicks: item.clicks,
      roi: item.roi,
      roiFloor: item.roiFloor,
      maxCpaEstimate: item.maxCpaEstimate,
      maxCpcProxy: item.maxCpcProxy,
      startingBidSuggestion: item.startingBidSuggestion,
      budgetStep: item.budgetStep,
      finding: compactFinding(item.finding)
    })),
    actions: snapshot.actions.slice(0, 12).map((item) => ({
      title: item.title,
      owner: item.owner,
      priority: item.priority,
      status: item.status,
      targetId: item.targetId,
      category: item.category,
      budget: item.budget,
      dependsOn: item.dependsOn,
      gateIds: item.gateIds,
      metric: item.metric,
      stopCondition: item.stopCondition,
      finding: compactFinding(item.finding)
    })),
    budgetGates: snapshot.budgetGates.map((item) => ({
      title: item.title,
      status: item.status,
      criterion: item.criterion,
      finding: compactFinding(item.finding)
    })),
    milestones: snapshot.milestones.map((item) => ({
      title: item.title,
      horizon: item.horizon,
      objective: item.objective,
      successCriteria: item.successCriteria,
      stopConditions: item.stopConditions,
      finding: compactFinding(item.finding)
    })),
    admittedModels,
    modelDataGaps
  };
}

function compactFinding(finding: NetworkFinding) {
  return {
    conclusion: finding.conclusion,
    status: finding.status,
    proof: finding.proof.slice(0, 4),
    cannotProve: finding.cannotProve,
    requiredData: finding.requiredData,
    confidence: finding.confidence
  };
}
