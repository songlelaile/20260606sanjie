import { normalizeHeader, stringifyCell } from "@/lib/imports/contracts";
import { normalizeDate, parseNumericCellOrNull } from "@/lib/imports/map-rows";
import type {
  BusinessDiagnosisSource,
  MarketAttributeSignal,
  MarketOverviewRow,
  MarketPriceBand,
  MarketSearchSignal,
  StoreCategoryMonthlyRow
} from "@/lib/business-diagnosis";

export type BusinessDiagnosisUploadKind = "store_category" | "market_overview" | "unknown";

export interface ParsedBusinessDiagnosisUpload {
  fileName: string;
  kind: BusinessDiagnosisUploadKind;
  label: string;
  rowCount: number;
  dateRange: string;
  errors: string[];
  warnings: string[];
  storeCategoryRows?: StoreCategoryMonthlyRow[];
  market?: BusinessDiagnosisSource["market"];
}

export interface BusinessDiagnosisSourcePatch {
  storeCategoryRows?: StoreCategoryMonthlyRow[];
  market?: BusinessDiagnosisSource["market"];
}

export interface BusinessDiagnosisMergeReport {
  ok: boolean;
  files: ParsedBusinessDiagnosisUpload[];
  storeRowCount: number;
  marketOverviewCount: number;
  priceBandCount: number;
  attributeSignalCount: number;
  searchSignalCount: number;
  errors: string[];
  warnings: string[];
}

const STORE_NUMERIC_KEYS: Array<keyof StoreCategoryMonthlyRow> = [
  "visitors", "views", "visitorProducts", "paidProducts", "addCartUsers", "addCartItems",
  "favorites", "favoriteRate", "addCartRate", "orderBuyers", "orderItems", "orderAmount",
  "orderConversionRate", "paymentBuyers", "paymentItems", "paymentAmount", "paymentShare",
  "paymentConversionRate", "monthlyCumulativePayment", "yearlyCumulativePayment", "jhsPaymentAmount",
  "newBuyers", "oldBuyers", "oldBuyerPaymentAmount", "customerUnitPrice", "visitorValue", "refundAmount"
];

/** API 持久化前的完整 DTO 校验，防止绕过上传解析器写入损坏的租户工作区。 */
export function validateBusinessDiagnosisSourcePatch(input: unknown): string[] {
  if (!input || typeof input !== "object") return ["业务诊断数据结构不合法"];
  const patch = input as Record<string, unknown>;
  const errors: string[] = [];
  const totalRows =
    (Array.isArray(patch.storeCategoryRows) ? patch.storeCategoryRows.length : 0) +
    (patch.market && typeof patch.market === "object"
      ? ["overview", "priceBands", "attributeSignals", "searchSignals"].reduce((total, key) => {
          const rows = (patch.market as Record<string, unknown>)[key];
          return total + (Array.isArray(rows) ? rows.length : 0);
        }, 0)
      : 0);
  if (totalRows > 100000) errors.push("业务诊断数据总行数超过 100000 行");
  if (patch.storeCategoryRows !== undefined) {
    if (!Array.isArray(patch.storeCategoryRows)) {
      errors.push("storeCategoryRows 必须为数组");
    } else {
      patch.storeCategoryRows.forEach((row, index) => {
        if (errors.length >= 30) return;
        if (!row || typeof row !== "object") {
          errors.push(`本店类目第 ${index + 1} 行结构不合法`);
          return;
        }
        const item = row as Partial<StoreCategoryMonthlyRow>;
        if (!/^\d{4}-\d{2}$/.test(item.month ?? "")) errors.push(`本店类目第 ${index + 1} 行月份不合法`);
        for (const key of ["level1Category", "level2Category", "categoryName"] as const) {
          if (!isBoundedText(item[key], 200)) errors.push(`本店类目第 ${index + 1} 行 ${key} 不合法`);
        }
        for (const key of STORE_NUMERIC_KEYS) {
          const value = item[key];
          if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
            errors.push(`本店类目第 ${index + 1} 行 ${String(key)} 必须为有限数值或 null`);
          }
        }
      });
    }
  }
  if (patch.market !== undefined) {
    if (!patch.market || typeof patch.market !== "object") {
      errors.push("market 必须为对象");
    } else {
      validateMarketPatch(patch.market as Record<string, unknown>, errors);
    }
  }
  return [...new Set(errors)].slice(0, 30);
}

function validateMarketPatch(market: Record<string, unknown>, errors: string[]) {
  for (const key of ["overview", "priceBands", "attributeSignals", "searchSignals"] as const) {
    if (!Array.isArray(market[key])) errors.push(`market.${key} 必须为数组`);
  }
  if (errors.length > 0) return;
  validateRows(market.overview as unknown[], "市场概况", errors, (row) =>
    isBoundedText(row.month, 20) &&
    allFiniteOrNull(row, ["salesShare", "salesYoY", "volumeShare", "volumeYoY", "buyerYoY", "unitPrice", "unitPriceYoY", "supplyIndex", "supplyYoY"])
  );
  validateRows(market.priceBands as unknown[], "价格带", errors, (row) =>
    isBoundedText(row.priceBand, 100) && allFiniteOrNull(row, ["marketShare", "yoy", "supplyIndex"])
  );
  validateRows(market.attributeSignals as unknown[], "属性信号", errors, (row) =>
    isBoundedText(row.attribute, 100) && isBoundedText(row.value, 200) &&
    allFiniteOrNull(row, ["salesIndex", "yoy", "supplyIndex"])
  );
  validateRows(market.searchSignals as unknown[], "搜索信号", errors, (row) =>
    isBoundedText(row.category, 200) &&
    allFiniteOrNull(row, ["searchUv", "avgGrowthRate", "clickRate", "conversionRate"])
  );
}

function validateRows(
  rows: unknown[],
  label: string,
  errors: string[],
  valid: (row: Record<string, unknown>) => boolean
) {
  if (rows.length > 50000) {
    errors.push(`${label}超过 50000 行`);
    return;
  }
  rows.forEach((row, index) => {
    if (errors.length >= 30) return;
    if (!row || typeof row !== "object" || !valid(row as Record<string, unknown>)) {
      errors.push(`${label}第 ${index + 1} 行字段不完整或类型不合法`);
    }
  });
}

function allFiniteOrNull(row: Record<string, unknown>, keys: string[]) {
  return keys.every((key) => {
    const value = row[key];
    return value === null || (typeof value === "number" && Number.isFinite(value));
  });
}

function isBoundedText(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

const STORE_REQUIRED_HEADERS = [
  "统计日期",
  "一级类目名称",
  "二级类目名称",
  "类目名称",
  "商品访客数",
  "支付金额",
  "支付转化率",
  "售中售后成功退款金额",
  "客单价",
  "访客平均价值",
  "有访客商品数",
  "有支付商品数"
];

const STORE_IDENTITY_HEADERS = ["统计日期", "一级类目名称", "二级类目名称", "类目名称"] as const;

const STORE_REQUIRED_NUMERIC_HEADERS = [
  "商品访客数",
  "支付金额",
  "支付转化率",
  "售中售后成功退款金额",
  "客单价",
  "访客平均价值",
  "有访客商品数",
  "有支付商品数"
] as const;

const STORE_RATIO_HEADERS = new Set([
  "访问收藏转化率", "访问加购转化率", "下单转化率", "支付金额占比", "支付转化率"
].map(normalizeHeader));

export function parseBusinessDiagnosisUpload(
  fileName: string,
  matrix: unknown[][]
): ParsedBusinessDiagnosisUpload {
  const kind = recognizeBusinessDiagnosisUpload(matrix);
  if (kind === "store_category") {
    return parseStoreCategoryUpload(fileName, matrix);
  }
  if (kind === "market_overview") {
    return parseMarketOverviewUpload(fileName, matrix);
  }
  return {
    fileName,
    kind: "unknown",
    label: "未知源表",
    rowCount: 0,
    dateRange: "未识别",
    errors: ["未识别到本店类目表或市场大盘表的关键表头"],
    warnings: []
  };
}

export function mergeBusinessDiagnosisUploads(
  files: ParsedBusinessDiagnosisUpload[]
): { patch: BusinessDiagnosisSourcePatch; report: BusinessDiagnosisMergeReport } {
  const errors = files.flatMap((file) => file.errors.map((line) => `${file.fileName}：${line}`));
  const warnings = files.flatMap((file) => file.warnings.map((line) => `${file.fileName}：${line}`));
  const storeRows = dedupeStoreRows(files.flatMap((file) => file.storeCategoryRows ?? []));
  const markets = files.map((file) => file.market).filter((market): market is BusinessDiagnosisSource["market"] => Boolean(market));
  const market = mergeMarkets(markets);

  if (storeRows.length === 0 && !market) {
    errors.push("请至少上传一份本店类目月度源表或市场大盘诊断源。");
  }
  if (storeRows.length === 0 && market) {
    warnings.push("本次未选择本店类目月度源表，保存时将沿用当前业务诊断里的本店类目数据。");
  }
  if (storeRows.length > 0 && !market) {
    warnings.push("本次未选择市场大盘诊断源，保存时将沿用当前业务诊断里的市场大盘数据。");
  }

  const patch: BusinessDiagnosisSourcePatch = {};
  if (storeRows.length > 0) patch.storeCategoryRows = storeRows;
  if (market) patch.market = market;

  return {
    patch,
    report: {
      ok: errors.length === 0,
      files,
      storeRowCount: storeRows.length,
      marketOverviewCount: market?.overview.length ?? 0,
      priceBandCount: market?.priceBands.length ?? 0,
      attributeSignalCount: market?.attributeSignals.length ?? 0,
      searchSignalCount: market?.searchSignals.length ?? 0,
      errors,
      warnings
    }
  };
}

function recognizeBusinessDiagnosisUpload(matrix: unknown[][]): BusinessDiagnosisUploadKind {
  const scanRows = matrix.slice(0, 20).map((row) => row.map(normalizeHeader));
  if (scanRows.some((row) => scoreHeaders(row, STORE_REQUIRED_HEADERS) >= 5)) {
    return "store_category";
  }
  if (
    scanRows.some((row) => row.includes("市场概况") || row.includes("价格带分析") || row.includes("搜索词分类洞察")) ||
    scanRows.some((row) => row.includes("销售额占比") && row.includes("价格带") && row.includes("搜索UV"))
  ) {
    return "market_overview";
  }
  return "unknown";
}

function parseStoreCategoryUpload(fileName: string, matrix: unknown[][]): ParsedBusinessDiagnosisUpload {
  const { headers, rows, headerIndex } = locateStoreHeaderRow(matrix);
  const normalizedHeaders = headers.map(normalizeHeader);
  const missingIdentityHeaders = STORE_IDENTITY_HEADERS.filter(
    (header) => !normalizedHeaders.includes(normalizeHeader(header))
  );
  const missingNumericHeaders = STORE_REQUIRED_NUMERIC_HEADERS.filter(
    (header) => !normalizedHeaders.includes(normalizeHeader(header))
  );
  const warnings: string[] = [];
  const errors: string[] = [];
  if (missingIdentityHeaders.length > 0) {
    errors.push(`本店类目表缺少定位字段：${missingIdentityHeaders.join("、")}。缺少这些字段无法识别行归属。`);
  }
  if (missingNumericHeaders.length > 0) {
    warnings.push(`缺少指标字段：${missingNumericHeaders.join("、")}；对应值将保存为 null，相关诊断保持证据不足。`);
  }
  const parsed: StoreCategoryMonthlyRow[] = [];
  if (missingIdentityHeaders.length === 0) {
    rows.forEach((row, rowIndex) => {
      const validation = validateStoreCategoryRow(headers, row);
      if (validation.skip) return;
      if (validation.structuralErrors.length > 0) {
        warnings.push(`第 ${headerIndex + rowIndex + 2} 行已隔离：${validation.structuralErrors.join("；")}`);
        return;
      }
      const mapped = mapStoreCategoryRow(headers, row);
      if (mapped) parsed.push(mapped);
      if (validation.fieldIssues.length > 0) {
        warnings.push(`第 ${headerIndex + rowIndex + 2} 行：${validation.fieldIssues.join("；")}，已按 null 导入。`);
      }
    });
  }
  if (parsed.length === 0 && rows.some((row) => row.some((cell) => stringifyCell(cell).trim() !== ""))) {
    errors.push("未解析到有效的本店类目数据行。");
  }
  if (headerIndex > 0) {
    warnings.push(`已自动跳过表头前 ${headerIndex} 行说明文本。`);
  }
  const months = [...new Set(parsed.map((row) => row.month))].sort();
  return {
    fileName,
    kind: "store_category",
    label: "本店类目月度源表",
    rowCount: parsed.length,
    dateRange: formatMonthRange(months),
    errors,
    warnings,
    storeCategoryRows: parsed
  };
}

function validateStoreCategoryRow(headers: string[], row: unknown[]) {
  const reader = columnReader(headers);
  const rawMonth = reader.raw(row, "统计日期");
  const rawCategory = reader.text(row, "类目名称");
  const isBlank = row.every((cell) => stringifyCell(cell).trim() === "");
  const isSummary = rawCategory === "总计" || rawCategory === "合计";
  if (isBlank || isSummary) {
    return { skip: true, structuralErrors: [] as string[], fieldIssues: [] as string[] };
  }

  const structuralErrors: string[] = [];
  if (!normalizeMonth(rawMonth)) structuralErrors.push("统计日期为空或无法识别");
  for (const header of ["一级类目名称", "二级类目名称", "类目名称"] as const) {
    if (!reader.text(row, header)) structuralErrors.push(`${header}为空`);
  }
  const fieldIssues: string[] = [];
  for (const header of STORE_REQUIRED_NUMERIC_HEADERS) {
    const parsed = parseNumericCellOrNull(reader.raw(row, header));
    if (parsed === null) {
      fieldIssues.push(`${header}缺失或不是有效数值`);
    } else if (STORE_RATIO_HEADERS.has(normalizeHeader(header)) && ratioOrNull(parsed) === null) {
      fieldIssues.push(`${header}超出 0%~100% 范围`);
    }
  }
  return { skip: false, structuralErrors, fieldIssues };
}

function parseMarketOverviewUpload(fileName: string, matrix: unknown[][]): ParsedBusinessDiagnosisUpload {
  const headerIndex = matrix.findIndex((row) => row.map(normalizeHeader).includes("销售额占比"));
  const warnings: string[] = [];
  const errors: string[] = [];
  if (headerIndex < 0) {
    errors.push("市场大盘表未找到“销售额占比”表头。");
  }
  const dataRows = headerIndex >= 0 ? matrix.slice(headerIndex + 1) : [];
  const market: BusinessDiagnosisSource["market"] = {
    overview: [],
    priceBands: [],
    attributeSignals: [],
    searchSignals: []
  };

  for (const row of dataRows) {
    const overview = mapMarketOverviewRow(row);
    if (overview) market.overview.push(overview);
    const priceBand = mapMarketPriceBand(row);
    if (priceBand) market.priceBands.push(priceBand);
    const attribute = mapMarketAttributeSignal(row);
    if (attribute) market.attributeSignals.push(attribute);
    const search = mapMarketSearchSignal(row);
    if (search) market.searchSignals.push(search);
  }

  market.overview = dedupeByKey(market.overview, (row) => row.month).sort((a, b) => a.month.localeCompare(b.month));
  market.priceBands = dedupeByKey(market.priceBands, (row) => row.priceBand).sort(
    (a, b) => (b.marketShare ?? Number.NEGATIVE_INFINITY) - (a.marketShare ?? Number.NEGATIVE_INFINITY)
  );
  market.attributeSignals = dedupeByKey(market.attributeSignals, (row) => `${row.attribute}|${row.value}`).sort(
    (a, b) => (b.salesIndex ?? Number.NEGATIVE_INFINITY) - (a.salesIndex ?? Number.NEGATIVE_INFINITY)
  );
  market.searchSignals = dedupeByKey(market.searchSignals, (row) => row.category).sort(
    (a, b) => (b.searchUv ?? Number.NEGATIVE_INFINITY) - (a.searchUv ?? Number.NEGATIVE_INFINITY)
  );

  const missingMetricCount = [
    ...market.overview.flatMap((row) => [row.salesShare, row.salesYoY, row.volumeShare, row.volumeYoY, row.buyerYoY, row.unitPrice, row.unitPriceYoY, row.supplyIndex, row.supplyYoY]),
    ...market.priceBands.flatMap((row) => [row.marketShare, row.yoy, row.supplyIndex]),
    ...market.attributeSignals.flatMap((row) => [row.salesIndex, row.yoy, row.supplyIndex]),
    ...market.searchSignals.flatMap((row) => [row.searchUv, row.avgGrowthRate, row.clickRate, row.conversionRate])
  ].filter((value) => value === null).length;
  if (missingMetricCount > 0) {
    warnings.push(`市场表有 ${missingMetricCount} 个指标单元格缺失或无效，已按 null 导入；对应信号不参与数值结论。`);
  }

  if (market.overview.length === 0) {
    errors.push("未解析到市场概况数据。");
  }
  if (market.priceBands.length === 0) {
    warnings.push("未识别到价格带分析数据。");
  }
  if (market.attributeSignals.length === 0) {
    warnings.push("未识别到卖点属性数据。");
  }
  if (market.searchSignals.length === 0) {
    warnings.push("未识别到搜索词分类洞察数据。");
  }

  return {
    fileName,
    kind: "market_overview",
    label: "市场大盘诊断源",
    rowCount:
      market.overview.length + market.priceBands.length + market.attributeSignals.length + market.searchSignals.length,
    dateRange: formatMonthRange(market.overview.map((row) => row.month)),
    errors,
    warnings,
    market
  };
}

function locateStoreHeaderRow(matrix: unknown[][]) {
  let bestIndex = 0;
  let bestScore = -1;
  for (let index = 0; index < Math.min(matrix.length, 20); index += 1) {
    const score = scoreHeaders((matrix[index] ?? []).map(normalizeHeader), STORE_REQUIRED_HEADERS);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return {
    headerIndex: bestIndex,
    headers: (matrix[bestIndex] ?? []).map(stringifyCell),
    rows: matrix.slice(bestIndex + 1).filter((row) => row.some((cell) => stringifyCell(cell) !== ""))
  };
}

function mapStoreCategoryRow(headers: string[], row: unknown[]): StoreCategoryMonthlyRow | null {
  const reader = columnReader(headers);
  const month = normalizeMonth(reader.text(row, "统计日期"));
  const categoryName = reader.text(row, "类目名称");
  if (!month || !categoryName || categoryName === "总计" || categoryName === "合计") {
    return null;
  }
  return {
    month,
    level1Category: reader.text(row, "一级类目名称"),
    level2Category: reader.text(row, "二级类目名称"),
    categoryName,
    visitors: reader.num(row, "商品访客数"),
    views: reader.num(row, "商品浏览量"),
    visitorProducts: reader.num(row, "有访客商品数"),
    paidProducts: reader.num(row, "有支付商品数"),
    addCartUsers: reader.num(row, "商品加购人数"),
    addCartItems: reader.num(row, "商品加购件数"),
    favorites: reader.num(row, "商品收藏人数"),
    favoriteRate: reader.ratio(row, "访问收藏转化率"),
    addCartRate: reader.ratio(row, "访问加购转化率"),
    orderBuyers: reader.num(row, "下单买家数"),
    orderItems: reader.num(row, "下单件数"),
    orderAmount: reader.num(row, "下单金额"),
    orderConversionRate: reader.ratio(row, "下单转化率"),
    paymentBuyers: reader.num(row, "支付买家数"),
    paymentItems: reader.num(row, "支付件数"),
    paymentAmount: reader.num(row, "支付金额"),
    paymentShare: reader.ratio(row, "支付金额占比"),
    paymentConversionRate: reader.ratio(row, "支付转化率"),
    monthlyCumulativePayment: reader.num(row, "月累计支付金额"),
    yearlyCumulativePayment: reader.num(row, "年累计支付金额"),
    jhsPaymentAmount: reader.num(row, "聚划算支付金额"),
    newBuyers: reader.num(row, "支付新买家数"),
    oldBuyers: reader.num(row, "支付老买家数"),
    oldBuyerPaymentAmount: reader.num(row, "老买家支付金额"),
    customerUnitPrice: reader.num(row, "客单价"),
    visitorValue: reader.num(row, "访客平均价值"),
    refundAmount: reader.num(row, "售中售后成功退款金额")
  };
}

function mapMarketOverviewRow(row: unknown[]): MarketOverviewRow | null {
  const month = normalizeMonth(row[0]);
  if (!month) return null;
  return {
    month,
    salesShare: ratioOrNull(parseNumericCellOrNull(row[1])),
    salesYoY: parseMarketRate(row[2]),
    volumeShare: ratioOrNull(parseNumericCellOrNull(row[3])),
    volumeYoY: parseMarketRate(row[4]),
    buyerScale: stringifyCell(row[5]),
    buyerYoY: parseMarketRate(row[6]),
    unitPrice: parseNumericCellOrNull(row[7]),
    unitPriceYoY: parseMarketRate(row[8]),
    supplyIndex: parseNumericCellOrNull(row[9]),
    supplyYoY: parseMarketRate(row[10])
  };
}

function mapMarketPriceBand(row: unknown[]): MarketPriceBand | null {
  const priceBand = stringifyCell(row[12]);
  if (!priceBand) return null;
  return {
    priceBand,
    marketShare: ratioOrNull(parseNumericCellOrNull(row[13])),
    yoy: parseMarketRate(row[14]),
    supplyIndex: parseNumericCellOrNull(row[15])
  };
}

function mapMarketAttributeSignal(row: unknown[]): MarketAttributeSignal | null {
  const attribute = stringifyCell(row[17]);
  const value = stringifyCell(row[18]);
  if (!attribute || !value) return null;
  return {
    attribute,
    value,
    salesIndex: parseNumericCellOrNull(row[19]),
    yoy: parseMarketRate(row[20]),
    supplyIndex: parseNumericCellOrNull(row[21])
  };
}

function mapMarketSearchSignal(row: unknown[]): MarketSearchSignal | null {
  const category = stringifyCell(row[23]);
  if (!category) return null;
  return {
    category,
    searchUv: parseNumericCellOrNull(row[24]),
    avgGrowthRate: parseMarketRate(row[25]),
    clickRate: ratioOrNull(parseNumericCellOrNull(row[26])),
    conversionRate: ratioOrNull(parseNumericCellOrNull(row[27]))
  };
}

function mergeMarkets(markets: BusinessDiagnosisSource["market"][]): BusinessDiagnosisSource["market"] | undefined {
  if (markets.length === 0) return undefined;
  return {
    overview: dedupeByKey(markets.flatMap((market) => market.overview), (row) => row.month).sort((a, b) =>
      a.month.localeCompare(b.month)
    ),
    priceBands: dedupeByKey(markets.flatMap((market) => market.priceBands), (row) => row.priceBand).sort(
      (a, b) => (b.marketShare ?? Number.NEGATIVE_INFINITY) - (a.marketShare ?? Number.NEGATIVE_INFINITY)
    ),
    attributeSignals: dedupeByKey(
      markets.flatMap((market) => market.attributeSignals),
      (row) => `${row.attribute}|${row.value}`
    ).sort((a, b) => (b.salesIndex ?? Number.NEGATIVE_INFINITY) - (a.salesIndex ?? Number.NEGATIVE_INFINITY)),
    searchSignals: dedupeByKey(markets.flatMap((market) => market.searchSignals), (row) => row.category).sort(
      (a, b) => (b.searchUv ?? Number.NEGATIVE_INFINITY) - (a.searchUv ?? Number.NEGATIVE_INFINITY)
    )
  };
}

function columnReader(headers: string[]) {
  const index = new Map<string, number>();
  headers.forEach((header, position) => {
    const key = normalizeHeader(header);
    if (key && !index.has(key)) index.set(key, position);
  });
  const text = (row: unknown[], header: string) => {
    const position = index.get(normalizeHeader(header));
    return position === undefined ? "" : stringifyCell(row[position]);
  };
  const raw = (row: unknown[], header: string) => {
    const position = index.get(normalizeHeader(header));
    return position === undefined ? undefined : row[position];
  };
  const num = (row: unknown[], header: string) => {
    const position = index.get(normalizeHeader(header));
    return position === undefined ? null : parseNumericCellOrNull(row[position]);
  };
  const ratio = (row: unknown[], header: string) => ratioOrNull(num(row, header));
  return { text, raw, num, ratio };
}

function ratioOrNull(value: number | null) {
  return value !== null && value >= 0 && value <= 1 ? value : null;
}

function scoreHeaders(row: string[], requiredHeaders: string[]) {
  const cells = new Set(row.map(normalizeHeader).filter(Boolean));
  return requiredHeaders.reduce((score, header) => score + (cells.has(normalizeHeader(header)) ? 1 : 0), 0);
}

function dedupeStoreRows(rows: StoreCategoryMonthlyRow[]) {
  return dedupeByKey(rows, (row) => `${row.month}|${row.level1Category}|${row.level2Category}|${row.categoryName}`).sort(
    (a, b) =>
      a.month.localeCompare(b.month) ||
      a.level1Category.localeCompare(b.level1Category, "zh-CN") ||
      a.level2Category.localeCompare(b.level2Category, "zh-CN") ||
      a.categoryName.localeCompare(b.categoryName, "zh-CN")
  );
}

function dedupeByKey<T>(rows: T[], keyOf: (row: T) => string) {
  const map = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key) map.set(key, row);
  }
  return [...map.values()];
}

function normalizeMonth(value: unknown) {
  const iso = normalizeDate(value);
  if (iso) return iso.slice(0, 7);
  const text = stringifyCell(value);
  const compact = text.match(/^(\d{4})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}`;
  const loose = text.match(/^(\d{4})[-/.年](\d{1,2})/);
  if (loose) return `${loose[1]}-${loose[2].padStart(2, "0")}`;
  return "";
}

function parseMarketRate(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = stringifyCell(value);
  const percentages = [...text.matchAll(/-?\d+(?:\.\d+)?(?=%)/g)].map((match) => Number(match[0]) / 100);
  if (percentages.length > 0) {
    return percentages.reduce((total, item) => total + item, 0) / percentages.length;
  }
  return parseNumericCellOrNull(value);
}

function formatMonthRange(months: string[]) {
  const values = [...new Set(months.filter(Boolean))].sort();
  if (values.length === 0) return "未识别";
  return values.length === 1 ? values[0] : `${values[0]} ~ ${values[values.length - 1]}`;
}
