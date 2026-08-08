export interface AiReportEvidenceBoundary {
  scope: string;
  fixedRules?: readonly string[];
  cannotProve?: readonly string[];
  requiredData?: readonly string[];
}

export type AiReportViolation = "exact_financial_instruction" | "certainty_or_causality" | "authority_spoof";

export interface GuardedAiReport {
  content: string;
  removedCount: number;
  violations: Record<AiReportViolation, number>;
}

const DRAFT_HEADING = "【AI 草案（需人工审核）】";
const BOUNDARY_HEADING = "【系统证据边界（确定性附录）】";
const FINANCIAL_KEYWORD = /(预算|出价|竞价|cpc|cpa|点击单价|单次点击|单次转化|日限额|每日限额|加价|降价)/i;
const MONEY_OR_RATE = /(?:[¥￥$]\s*\d[\d,.]*|\d[\d,.]*\s*(?:元|万元|块|美元)|[零〇一二两三四五六七八九十百千万亿]+\s*(?:元|万元|块)|\d+(?:\.\d+)?\s*(?:%|％|倍|x))/i;
const KEY_VALUE_NUMBER = /(?:预算|出价|竞价|cpc|cpa|点击单价|单次点击|单次转化|日限额|每日限额)\s*(?:(?:建议|安排|投入|分配|设置|设为|控制在|调整至|提高至|降低至|上限(?:为)?|各(?:为)?|为|=|[:：])\s*)?[¥￥$]?\s*\d+(?:[.,]\d+)?(?!\s*(?:步|阶段|周|天|项|道|层|轮|\/))/i;
const ACTION_AMOUNT = /(?:建议|应当|需要|可以|请|首档|小测|测试)[^。；\n]{0,20}(?:投入|花费|拨付|分配|释放|追加)[^。；\n]{0,12}(?:[¥￥$]\s*\d[\d,.]*|\d[\d,.]*\s*(?:元|万元|块|美元)|[零〇一二两三四五六七八九十百千万亿]+\s*(?:元|万元|块))/i;
const GUARANTEE = /(?:保证|必然|一定(?:能|会|可以)|(?:百分之百|100\s*%)(?:能|会|可以|保证|达成|实现|成功)|绝对(?:会|能|可以)|零风险|稳赚|毫无疑问|确保[^。；]{0,18}(?:增长|提升|达成|盈利|回报|转化|销量|效果))/;
const NEGATED_CERTAINTY = /(?:不|并不|不能|无法|尚不能|不得|未能|没有)(?:保证|证明|证实|确认)|不代表|证据不足|尚待验证|待验证|仅为假设/;
const CAUSAL_CLAIM = /(?:证明|证实|确认|明确说明)[^。；]{0,24}(?:导致|造成|带来)|(?:直接|完全|唯一|必然|一定)[^。；]{0,12}(?:导致|造成|带来)|[^。；]{0,36}(?:导致|造成)[^。；]{0,36}(?:增长|下降|提升|减少|恶化|改善|盈利|亏损)/;
const QUALIFIED_CAUSALITY = /(?:可能|或许|疑似|相关但|不能证明|无法证明|尚不能证明|不代表|待验证|假设|代理指标|相关性)/;
const AUTHORITY_MARKER = /(?:【?系统证据边界|【?AI 草案（需人工审核）|系统(?:已审核|审核通过|后验过滤通过))/;

/**
 * Treats model output as an untrusted draft. Risky lines are removed before an
 * authoritative, deterministic evidence appendix is added by the server.
 */
export function guardAiReportDraft(
  rawContent: string,
  boundary: AiReportEvidenceBoundary
): GuardedAiReport {
  const violations: Record<AiReportViolation, number> = {
    exact_financial_instruction: 0,
    certainty_or_causality: 0,
    authority_spoof: 0
  };
  const safeLines: string[] = [];

  for (const rawLine of normalizeNewlines(rawContent).split("\n")) {
    const line = rawLine.trimEnd();
    const violation = detectViolation(line);
    if (violation) {
      violations[violation] += 1;
      continue;
    }
    safeLines.push(line);
  }

  const removedCount = Object.values(violations).reduce((sum, count) => sum + count, 0);
  const draft = trimBlankLines(safeLines).join("\n").trim() ||
    "AI 草案中的正文已被后验防护全部拦截，请以系统证据边界为准。";
  const appendix = buildBoundaryAppendix(boundary, violations, removedCount);

  return {
    content: [DRAFT_HEADING, draft, "", BOUNDARY_HEADING, ...appendix].join("\n"),
    removedCount,
    violations
  };
}

function detectViolation(line: string): AiReportViolation | null {
  const normalized = line.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (AUTHORITY_MARKER.test(normalized)) return "authority_spoof";
  if (isExactFinancialInstruction(normalized)) return "exact_financial_instruction";

  const hasUnqualifiedGuarantee = GUARANTEE.test(normalized) && !NEGATED_CERTAINTY.test(normalized);
  const hasUnqualifiedCausality = CAUSAL_CLAIM.test(normalized) &&
    !NEGATED_CERTAINTY.test(normalized) &&
    !QUALIFIED_CAUSALITY.test(normalized);
  return hasUnqualifiedGuarantee || hasUnqualifiedCausality ? "certainty_or_causality" : null;
}

function isExactFinancialInstruction(line: string) {
  if (ACTION_AMOUNT.test(line)) return true;
  if (!FINANCIAL_KEYWORD.test(line)) return false;
  const isGateProgressOnly = /预算闸门[^。；]{0,16}\d+\s*\/\s*\d+/.test(line) &&
    !MONEY_OR_RATE.test(line) &&
    !/(?:建议|安排|投入|分配|设置|调整|提高|降低)/.test(line);
  if (isGateProgressOnly) return false;
  return MONEY_OR_RATE.test(line) || KEY_VALUE_NUMBER.test(line);
}

function buildBoundaryAppendix(
  boundary: AiReportEvidenceBoundary,
  violations: Record<AiReportViolation, number>,
  removedCount: number
) {
  const lines = [
    `- 适用范围：${cleanBoundaryText(boundary.scope) || "本次诊断"}。`,
    "- 审核要求：以上内容是 AI 草案，必须由经营负责人审核；不得直接作为预算审批、出价设置或自动执行指令。"
  ];

  for (const rule of normalizeBoundaryItems(boundary.fixedRules, 6)) {
    lines.push(`- 系统规则：${rule}`);
  }
  for (const item of normalizeBoundaryItems(boundary.cannotProve, 8)) {
    lines.push(`- 不能证明：${item}`);
  }
  for (const item of normalizeBoundaryItems(boundary.requiredData, 8)) {
    lines.push(`- 待补数据：${item}`);
  }

  if (removedCount > 0) {
    const reasons = [
      violations.exact_financial_instruction > 0
        ? `精确预算/出价 ${violations.exact_financial_instruction} 行`
        : "",
      violations.certainty_or_causality > 0
        ? `保证性或确定因果 ${violations.certainty_or_causality} 行`
        : "",
      violations.authority_spoof > 0
        ? `冒充系统边界 ${violations.authority_spoof} 行`
        : ""
    ].filter(Boolean);
    lines.push(`- 后验过滤：已移除 ${removedCount} 行越界表述（${reasons.join("；")}）。`);
  } else {
    lines.push("- 后验过滤：未发现精确预算/出价、保证性结论或确定因果越界表述。");
  }
  return lines;
}

function normalizeBoundaryItems(items: readonly string[] | undefined, limit: number) {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of items ?? []) {
    const cleaned = cleanBoundaryText(item);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length >= limit) break;
  }
  return result;
}

function cleanBoundaryText(value: string) {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 280);
}

function normalizeNewlines(value: string) {
  return value.replace(/\r\n?/g, "\n").trim();
}

function trimBlankLines(lines: string[]) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]?.trim()) start += 1;
  while (end > start && !lines[end - 1]?.trim()) end -= 1;
  return lines.slice(start, end);
}
