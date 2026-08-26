export type DmpDisplayCell = string | number | boolean | null | undefined | Record<string, unknown> | readonly unknown[];

const RANGE_KEY_PAIRS = [
  ["min", "max"],
  ["minimum", "maximum"],
  ["lower", "upper"],
  ["low", "high"],
  ["minValue", "maxValue"],
  ["rangeMin", "rangeMax"],
  ["lowerBound", "upperBound"]
] as const;

function rangeEndpoint(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text && text !== "—" && text !== "-" ? text : "";
}

function percentUnit(value: unknown) {
  const unit = String(value ?? "").trim().toLocaleLowerCase("zh-CN");
  return unit === "%" || unit === "percent" || unit === "percentage" || unit === "百分比";
}

function withRangeUnit(endpoint: string, usePercent: boolean) {
  return usePercent && endpoint && !endpoint.endsWith("%") ? `${endpoint}%` : endpoint;
}

function rangeObjectText(value: unknown, depth = 0, inheritedPercent = false): string | null {
  if (depth > 2 || value == null) return null;
  if (Array.isArray(value)) {
    if (value.length !== 2) return null;
    const lower = withRangeUnit(rangeEndpoint(value[0]), inheritedPercent);
    const upper = withRangeUnit(rangeEndpoint(value[1]), inheritedPercent);
    return lower && upper ? (lower === upper ? lower : `${lower}~${upper}`) : lower ? `>${lower}` : upper ? `<${upper}` : null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const usePercent = inheritedPercent || percentUnit(record.unit ?? record.valueUnit);
  for (const nestedKey of ["range", "valueRange", "interval"]) {
    if (record[nestedKey] != null) {
      const nested = rangeObjectText(record[nestedKey], depth + 1, usePercent);
      if (nested) return nested;
    }
  }
  for (const [lowerKey, upperKey] of RANGE_KEY_PAIRS) {
    if (!(lowerKey in record) && !(upperKey in record)) continue;
    const lower = withRangeUnit(rangeEndpoint(record[lowerKey]), usePercent);
    const upper = withRangeUnit(rangeEndpoint(record[upperKey]), usePercent);
    if (lower && upper) return lower === upper ? lower : `${lower}~${upper}`;
    if (lower) return `>${lower}`;
    if (upper) return `<${upper}`;
  }
  return null;
}

function canonicalRangeText(value: unknown): string | null {
  const objectRange = rangeObjectText(value);
  if (objectRange) return objectRange;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
    try {
      const parsedRange = rangeObjectText(JSON.parse(text));
      if (parsedRange) return parsedRange;
    } catch {
      // 保留原始文本；它仍可能是普通业务字符串。
    }
  }
  const endpoint = "[<>]?\\s*[+-]?[\\d,，]+(?:\\.\\d+)?\\s*(?:亿|万|千|[wWkK]|%|元)?";
  const closed = text.match(new RegExp(`^(${endpoint})\\s*(?:~|～|至|—|–|--)\\s*(${endpoint})$`));
  return closed ? `${closed[1].trim()}~${closed[2].trim()}` : null;
}

export function dmpDisplayCellText(value: DmpDisplayCell) {
  const range = canonicalRangeText(value);
  if (range) return range;
  if (value == null) return "";
  return typeof value === "string" ? value.trim() : String(value);
}

export function isDmpIntervalCell(value: DmpDisplayCell) {
  const text = dmpDisplayCellText(value);
  return /^[<>]/.test(text) || /[~～]/.test(text);
}

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
  const text = dmpDisplayCellText(value);
  if (!text) return "—";
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
