import {
  diagnosisJson,
  requireAiProviderExecutionAccess,
  requireDiagnosisApiAccess
} from "@/lib/diagnosis-route-security";
import { buildAiDiagnosisModelContext } from "@/lib/diagnosis-ai-model-context";
import {
  buildBusinessDiagnosisSnapshot,
  type BusinessDiagnosisSnapshot,
  type BusinessDiagnosisSource
} from "@/lib/business-diagnosis";
import {
  AiChatServiceError,
  isAiChatTimeoutError,
  requestAiChat
} from "@/lib/ai-chat-client";
import {
  AI_REPORT_MAX_RESPONSE_BYTES,
  AI_REPORT_TIMEOUT_MESSAGE,
  AI_REPORT_TIMEOUT_MS
} from "@/lib/ai-report-policy";
import { guardAiReportDraft, type AiReportEvidenceBoundary } from "@/lib/ai-report-guard";
import { getAiApiRuntimeConfig, getBusinessDiagnosisWorkspaceSource } from "@/lib/store/runtime-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 210;

export async function POST() {
  const unauthorized = await requireDiagnosisApiAccess("write");
  if (unauthorized) return unauthorized;
  const startedAt = Date.now();
  try {
    const [source, config] = await Promise.all([
      getBusinessDiagnosisWorkspaceSource(),
      getAiApiRuntimeConfig()
    ]);
    const providerUnauthorized = await requireAiProviderExecutionAccess(config.provider);
    if (providerUnauthorized) return providerUnauthorized;
    if (!hasBusinessDiagnosisSourceData(source)) {
      return diagnosisJson({ error: "请先导入业务诊断源表后再开始诊断" }, { status: 400 });
    }
    if (!config.enabled || !config.hasApiKey || !config.apiKey) {
      return diagnosisJson({ error: "请先接入并启用 AI API Key" }, { status: 409 });
    }

    const snapshot = buildBusinessDiagnosisSnapshot(source);
    const result = await requestAiChat(config, {
      messages: [
        {
          role: "system",
          content:
            "你是电商经营诊断顾问。只能解释 admittedModels 中明确列出的模型；proxy 只能用于排序、提出假设和设计小测。不得推断任何未出现在 admittedModels 的模型或分数。字段为 null 时必须保留证据边界；market evidenceLevel=observed 也只表示同期观察，不是已证实机会。不得创造输入中没有的数值、精确预算或精确出价，不得使用保证性承诺或把观察关系表述为确定因果。"
        },
        {
          role: "user",
          content: buildAiReportPrompt(snapshot)
        }
      ],
      temperature: 0.25,
      maxTokens: 1600,
      timeoutMs: AI_REPORT_TIMEOUT_MS,
      maxResponseBytes: AI_REPORT_MAX_RESPONSE_BYTES
    });
    const guarded = guardAiReportDraft(result.content, buildBusinessEvidenceBoundary(snapshot));

    return diagnosisJson({
      data: {
        report: {
          title: "AI 诊断报告草案",
          content: guarded.content,
          generatedAt: new Date().toISOString(),
          provider: result.provider,
          model: result.model,
          filteredLineCount: guarded.removedCount
        }
      }
    });
  } catch (error) {
    logAiReportFailure("business-diagnosis", error, Date.now() - startedAt);
    return diagnosisJson(
      {
        error: isAiChatTimeoutError(error)
          ? AI_REPORT_TIMEOUT_MESSAGE
          : error instanceof Error
            ? error.message
            : "AI 诊断生成失败"
      },
      {
        status: isAiChatTimeoutError(error) ? 504 : error instanceof AiChatServiceError ? 502 : 500
      }
    );
  }
}

function hasBusinessDiagnosisSourceData(source: BusinessDiagnosisSource | null): source is BusinessDiagnosisSource {
  if (!source) return false;
  return (
    source.storeCategoryRows.length > 0 ||
    source.market.overview.length > 0 ||
    source.market.priceBands.length > 0 ||
    source.market.attributeSignals.length > 0 ||
    source.market.searchSignals.length > 0
  );
}

function buildAiReportPrompt(snapshot: BusinessDiagnosisSnapshot) {
  const categoryRows = snapshot.categories.slice(0, 10).map((item) => ({
    categoryName: item.categoryName,
    quadrant: item.quadrant,
    paymentAmount: Math.round(item.paymentAmount),
    revenueShare: roundRate(item.revenueShare),
    revenueGrowth: roundRate(item.revenueGrowth),
    refundRate: roundRate(item.refundRate),
    conversionRate: roundRate(item.paymentConversionRate),
    action: item.action
  }));
  const strategyRows = snapshot.strategyCards.slice(0, 8).map((item) => ({
    priority: item.priority,
    model: item.model,
    target: item.target,
    diagnosis: item.diagnosis,
    expectedImpact: item.expectedImpact,
    actions: item.actions
  }));
  const valueChainRows = snapshot.valueChain.map((item) => ({
    stage: item.label,
    score: item.score,
    status: item.status,
    evidence: item.evidence,
    action: item.action
  }));
  const marketRows = {
    samePeriod: snapshot.market.samePeriod,
    periodNote: snapshot.market.periodNote,
    opportunities: snapshot.marketOpportunities.slice(0, 6),
    priceBands: snapshot.market.topPriceBands.slice(0, 6),
    attributes: snapshot.market.topAttributeSignals.slice(0, 8),
    searches: snapshot.market.topSearchSignals.slice(0, 8)
  };
  const { admittedModels, modelDataGaps } = buildAiDiagnosisModelContext(snapshot.modelAdmissions);

  return [
    "请仅基于下方 admittedModels 与经营证据生成报告。未准入模型没有进入本次输入。",
    "请输出以下结构：",
    "1. 一句话总诊断",
    "2. 关键问题 3-5 条，每条包含证据",
    "3. 优先动作 3-5 条，每条包含负责人建议、周期、复盘指标",
    "4. 风险提醒",
    "5. 下次复盘要补充的数据",
    "证据纪律：null 表示证据不足；非同期市场信号只能写成待验证假设；只解释 admittedModels；modelDataGaps 只能列为待补数据，不得反推出未准入模型或评分。",
    "",
    "数据摘要 JSON：",
    JSON.stringify(
      {
        summary: snapshot.summary,
        categoryRows,
        valueChainRows,
        strategyRows,
        marketRows,
        admittedModels,
        modelDataGaps
      },
      null,
      2
    )
  ].join("\n");
}

function buildBusinessEvidenceBoundary(snapshot: BusinessDiagnosisSnapshot): AiReportEvidenceBoundary {
  const lockedModels = snapshot.modelAdmissions.filter(
    (item) => item.mode === "disabled" && item.portfolio === "conditional"
  );
  const directionalOpportunities = snapshot.marketOpportunities;

  return {
    scope: snapshot.summary.latestStoreMonth
      ? `业务诊断 ${snapshot.summary.latestStoreMonth}`
      : "本次业务诊断",
    fixedRules: uniqueText([
      "业务诊断没有预算审批与投放出价权限；AI 不得补造精确预算、出价或自动执行指令。",
      snapshot.market.samePeriod
        ? `本店与市场月份同期；市场数据仍是经营证据，不等于动作效果的因果证明。`
        : `本店与市场月份不同期；市场信号只能形成待验证假设。${snapshot.market.periodNote}`,
      lockedModels.length > 0
        ? `未准入模型：${lockedModels.map((item) => item.displayName).join("、")}；不得生成分数、结论或动作授权。`
        : "只允许解释本次已准入模型。"
    ]),
    cannotProve: uniqueText([
      "经营与市场观察数据不能证明某个动作造成了结果变化。",
      ...(snapshot.market.samePeriod ? [] : [snapshot.market.periodNote]),
      ...directionalOpportunities.map(
        (item) => `${item.title} 当前证据级别为 ${item.evidenceLevel}，不能表述为已证实机会。`
      )
    ]),
    requiredData: uniqueText([
      ...directionalOpportunities.flatMap((item) => item.requiredData),
      ...lockedModels.flatMap((item) => item.requiredData)
    ])
  };
}

function uniqueText(items: string[]) {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function roundRate(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 10000) / 10000;
}

function logAiReportFailure(scope: string, error: unknown, durationMs: number) {
  const serviceError = error instanceof AiChatServiceError ? error : null;
  console.warn("[ai-report] generation failed", {
    scope,
    durationMs,
    kind: serviceError?.kind ?? "internal",
    upstreamStatus: serviceError?.upstreamStatus ?? null,
    message: error instanceof Error ? error.message : "unknown"
  });
}
