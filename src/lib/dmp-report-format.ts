export type DmpDisplayCell = string | number | boolean | null | undefined;

export function isDmpMultipleMetric(metric: string) {
  return /投入产出比|投产比|ROI|ROAS/i.test(metric);
}

export function isDmpPercentMetric(metric: string) {
  return !isDmpMultipleMetric(metric) && !/排名变化/.test(metric) && /比|率|变化|相对|CTR|贡献|百分位/i.test(metric);
}

function fixedTwo(value: number | string) {
  const numeric = Number(value);
  const absolute = Math.abs(numeric);
  const rounded = Math.round((absolute + Number.EPSILON * Math.max(1, absolute)) * 100) / 100;
  return (numeric < 0 ? -rounded : rounded).toFixed(2);
}

export function dmpCellSemantic(tableName: string, columns: string[], row: DmpDisplayCell[], columnIndex: number) {
  const column = columns[columnIndex] ?? "";
  // 投产比本身是倍数，但“本店变化 / 主体相对对手”等派生列仍是百分比。
  // 对这些列只使用列头语义，避免行指标中的 ROI/投产比覆盖变化率格式。
  if (/变化|变动|相对|环比|同比|差异|提升|下降/.test(column)) return column;
  if (tableName === "报告总览") return `${column} ${row[0] ?? ""} ${row[1] ?? ""}`;
  if (tableName === "对标总表") return `${column} ${row[1] ?? ""}`;
  if (tableName === "基础指标对比") return `${column} ${row[0] ?? ""}`;
  return column;
}

export function formatDmpCell(value: DmpDisplayCell, semantic = "") {
  if (value == null || value === "") return "—";
  const text = String(value).trim();
  if (/商品ID|sceneId|关键词ID/i.test(semantic)) return text;
  if (
    isDmpMultipleMetric(semantic) &&
    /^[<>]?\s*[+-]?\d+(?:\.\d+)?%(?:\s*[~～]\s*[<>]?\s*[+-]?\d+(?:\.\d+)?%)?$/.test(text)
  ) {
    return text.replace(/([+-]?\d+(?:\.\d+)?)%/g, (_, token: string) => fixedTwo(Number(token) / 100));
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    if (!Number.isFinite(numeric)) return text;
    if (isDmpPercentMetric(semantic)) return `${fixedTwo(numeric * 100)}%`;
    return Number.isInteger(numeric) && !text.includes(".") ? String(numeric) : fixedTwo(numeric);
  }
  if (isDmpPercentMetric(semantic) && !text.includes("%") && /^[<>]?\s*[+-]?\d+(?:\.\d+)?(?:\s*[~～]\s*[<>]?\s*[+-]?\d+(?:\.\d+)?)?$/.test(text)) {
    return text.replace(/[+-]?\d+(?:\.\d+)?/g, token => `${fixedTwo(Number(token) * 100)}%`);
  }
  if (/^[<>]?\s*[\d.,]+(?:\.\d+)?[万千%]?(?:\s*[~～]\s*[<>]?\s*[\d.,]+(?:\.\d+)?[万千%]?)?$/.test(text)) {
    return text.replace(/-?\d+\.\d+/g, token => fixedTwo(token));
  }
  return text;
}
