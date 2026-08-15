export type DmpDisplayCell = string | number | boolean | null | undefined;

export function isDmpPercentMetric(metric: string) {
  return !/排名变化/.test(metric) && /比|率|变化|相对|CTR|贡献|百分位/i.test(metric);
}

function fixedTwo(value: number | string) {
  const numeric = Number(value);
  const absolute = Math.abs(numeric);
  const rounded = Math.round((absolute + Number.EPSILON * Math.max(1, absolute)) * 100) / 100;
  return (numeric < 0 ? -rounded : rounded).toFixed(2);
}

export function dmpCellSemantic(tableName: string, columns: string[], row: DmpDisplayCell[], columnIndex: number) {
  if (tableName === "对标总表") return `${columns[columnIndex] ?? ""} ${row[1] ?? ""}`;
  if (tableName === "基础指标对比") return `${columns[columnIndex] ?? ""} ${row[0] ?? ""}`;
  return columns[columnIndex] ?? "";
}

export function formatDmpCell(value: DmpDisplayCell, semantic = "") {
  if (value == null || value === "") return "—";
  const text = String(value).trim();
  if (/商品ID|sceneId|关键词ID/i.test(semantic)) return text;
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
