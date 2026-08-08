import type { BusinessDiagnosisSnapshot, BusinessStrategyCard, BusinessValueChainStage } from "@/lib/business-diagnosis";
import { formatMoney, formatPercent } from "@/lib/format";

export type CustomerReportReadiness = "ready" | "partial";

export interface CustomerCommunicationReport {
  readiness: CustomerReportReadiness;
  readinessLabel: string;
  title: string;
  conclusion: string;
  supportingEvidence: string[];
  customerTalkTrack: string[];
  actions: Array<{ title: string; action: string; metric: string }>;
  boundaries: string[];
  generatedAt: string;
}

/**
 * A deterministic, customer-facing summary. It intentionally does not depend on
 * an LLM: importing the data is enough to produce a reviewable HTML handoff.
 */
export function buildCustomerCommunicationReport(
  snapshot: BusinessDiagnosisSnapshot
): CustomerCommunicationReport {
  const weakStage = lowestObservedStage(snapshot.valueChain);
  const topCategory = snapshot.categories[0] ?? null;
  const p1Cards = snapshot.strategyCards.filter((card) => card.priority === "P1");
  const primaryCards = (p1Cards.length > 0 ? p1Cards : snapshot.strategyCards).slice(0, 3);
  const boundaries = buildBoundaries(snapshot);
  const hasStoreConclusion = snapshot.summary.storeTotalAvailable;

  if (!hasStoreConclusion) {
    return {
      readiness: "partial",
      readinessLabel: "暂不具备总盘结论条件",
      title: "当前数据不足以形成店铺总盘结论",
      conclusion:
        "本次已识别到局部经营或市场数据，但缺少可靠的全店汇总行。不能把叶子类目访客、买家直接相加为全店数据，因此暂不对店铺规模、转化和净销售作结论。",
      supportingEvidence: [
        "缺少唯一且可靠的全店汇总行，系统未合并叶子类目的访客或买家。",
        `已识别 ${snapshot.categories.length} 个可诊断叶子类目，可先用于局部问题排查。`,
        ...boundaries.slice(0, 2)
      ],
      customerTalkTrack: [
        "这批数据可以帮助我们定位局部类目问题，但还不能代表全店经营结果。",
        "为了给出可对账的店铺结论，请补充同月份、同一统计口径的全店汇总行。",
        "补齐后我们会自动重算，并给出明确的店铺结论与优先动作。"
      ],
      actions: primaryCards.map(toCustomerAction),
      boundaries,
      generatedAt: snapshot.generatedAt
    };
  }

  const conclusionParts = [
    `本期店铺支付额 ${formatMoney(snapshot.summary.paymentAmount ?? Number.NaN)}，净销售 ${formatMoney(snapshot.summary.netSales ?? Number.NaN)}，支付转化 ${formatPercent(snapshot.summary.paymentConversionRate ?? Number.NaN)}。`,
    topCategory
      ? `${topCategory.categoryName} 是当前主力类目，应优先围绕该类目推进验证。`
      : "当前未识别可诊断的叶子类目，需补充分层类目数据。",
    weakStage
      ? `${weakStage.label} 是当前最需要优先处理的经营链路，先修复再扩大动作范围。`
      : "当前链路评分证据不足，先补链路指标后再决定动作优先级。"
  ];

  return {
    readiness: snapshot.market.samePeriod ? "ready" : "partial",
    readinessLabel: snapshot.market.samePeriod ? "可用于店内诊断与同期方向判断" : "可用于店内诊断，市场结论待同期核验",
    title: "本期店铺经营数据可支持店内诊断",
    conclusion: conclusionParts.join(""),
    supportingEvidence: [
      `经营总盘采用 ${snapshot.summary.latestStoreMonth} 的可靠全店汇总口径。`,
      snapshot.summary.revenueGrowth === null
        ? "缺少可比相邻月份或月末口径未核验，报告不对增长趋势作确定判断。"
        : `相邻月销售方向为 ${formatPercent(snapshot.summary.revenueGrowth)}，仍需核验两期月末累计口径。`,
      topCategory
        ? `${topCategory.categoryName} 销售占比 ${formatPercent(topCategory.revenueShare)}，支付转化 ${formatPercent(topCategory.paymentConversionRate)}。`
        : "暂无可用的叶子类目经营证据。",
      weakStage ? `${weakStage.label}：${weakStage.evidence}` : "链路短板尚未形成可观测证据。"
    ],
    customerTalkTrack: [
      "这次我们先只基于已经导入、可追溯的数据下结论，不把推测当成结果。",
      conclusionParts.join(""),
      `建议先执行以下 ${primaryCards.length} 项优先动作，并按报告中的复盘指标验证；验证前不建议直接扩大预算或承诺结果。`
    ],
    actions: primaryCards.map(toCustomerAction),
    boundaries,
    generatedAt: snapshot.generatedAt
  };
}

export function buildCustomerReportHtml(snapshot: BusinessDiagnosisSnapshot): string {
  const report = buildCustomerCommunicationReport(snapshot);
  const createdAt = formatDateTime(report.generatedAt);
  const list = (items: string[]) => items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const actionRows = report.actions
    .map(
      (item, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.action)}</td><td>${escapeHtml(item.metric)}</td></tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(report.title)}｜店铺经营数据沟通报告</title>
<style>
  :root { color-scheme: light; --ink:#152119; --muted:#617066; --line:#dce6de; --brand:#176b4e; --soft:#edf8f1; --warn:#865a14; --warn-bg:#fff8e8; }
  * { box-sizing:border-box } body { margin:0; color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; background:#f4f7f5; line-height:1.65 }
  main { max-width:980px; margin:32px auto; padding:0 24px 40px } header { background:linear-gradient(125deg,#0f533c,#237f5b); border-radius:18px; color:#fff; padding:34px 38px } h1 { margin:6px 0; font-size:30px; line-height:1.25 } h2 { font-size:18px; margin:0 0 12px } .eyebrow,.meta { font-size:13px; opacity:.8 } .card { background:#fff; border:1px solid var(--line); border-radius:14px; margin-top:18px; padding:24px } .badge { display:inline-block; background:var(--soft); color:var(--brand); border-radius:999px; font-weight:700; font-size:13px; padding:4px 10px } .conclusion { color:#174d39; font-size:18px; font-weight:700; margin:13px 0 0 } ul,ol { margin:0; padding-left:22px } li { margin:7px 0 } table { border-collapse:collapse; width:100%; font-size:14px } th,td { border-bottom:1px solid var(--line); padding:11px 9px; text-align:left; vertical-align:top } th { color:var(--muted); font-size:12px } .boundary { background:var(--warn-bg); border-color:#f0d79d; color:#704b10 } footer { color:var(--muted); font-size:12px; margin-top:18px; text-align:center } @media print { body { background:#fff } main { max-width:none; margin:0; padding:0 } .card,header { break-inside:avoid } }
</style></head><body><main>
<header><div class="eyebrow">店铺经营数据沟通报告 · 自动生成</div><h1>${escapeHtml(report.title)}</h1><div class="meta">数据期间：${escapeHtml(snapshot.summary.latestStoreMonth || "待补")} · 生成时间：${escapeHtml(createdAt)}</div></header>
<section class="card"><span class="badge">${escapeHtml(report.readinessLabel)}</span><h2 style="margin-top:14px">核心结论</h2><p class="conclusion">${escapeHtml(report.conclusion)}</p></section>
<section class="card"><h2>结论依据</h2><ul>${list(report.supportingEvidence)}</ul></section>
<section class="card"><h2>建议与客户直接沟通</h2><ol>${list(report.customerTalkTrack)}</ol></section>
<section class="card"><h2>优先动作与复盘</h2><table><thead><tr><th>#</th><th>优先动作</th><th>建议执行</th><th>复盘指标</th></tr></thead><tbody>${actionRows || "<tr><td colspan=\"4\">暂无可执行动作，先补齐经营链路数据。</td></tr>"}</tbody></table></section>
<section class="card boundary"><h2>数据边界与待补项</h2><ul>${list(report.boundaries)}</ul></section>
<footer>本报告由已导入数据自动生成；市场方向与经营动作效果须通过后续复盘验证。</footer>
</main></body></html>`;
}

function lowestObservedStage(stages: BusinessValueChainStage[]) {
  return stages
    .filter((stage): stage is BusinessValueChainStage & { score: number } => stage.score !== null)
    .sort((left, right) => left.score - right.score)[0];
}

function toCustomerAction(card: BusinessStrategyCard) {
  return {
    title: card.title,
    action: card.actions[0] ?? card.diagnosis,
    metric: card.expectedImpact
  };
}

function buildBoundaries(snapshot: BusinessDiagnosisSnapshot) {
  const missing = snapshot.modelAdmissions
    .filter((item) => item.portfolio === "conditional" && item.mode === "disabled")
    .flatMap((item) => item.requiredData);
  const periodBoundary = snapshot.market.samePeriod
    ? "市场数据与本店月份同期，仍只用于方向观察，不能证明某个动作必然带来结果。"
    : `本店与市场数据月份不一致：${snapshot.market.periodNote}`;
  return [
    periodBoundary,
    snapshot.summary.comparisonBasisNote,
    ...[...new Set(missing)].slice(0, 5)
  ];
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "导入数据生成时" : date.toLocaleString("zh-CN", { hour12: false });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}
