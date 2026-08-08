import type { ImportValidationResult, ReportType } from "@/lib/types/domain";
import { summarizeDateValues } from "@/lib/analysis-period";

export interface ReportContract {
  reportType: ReportType;
  label: string;
  sourceSystem: string;
  entityHeader: string;
  dateHeader?: string;
  requiredHeaders: string[];
  /** 明细表：同一主键多行属正常（如推广/人群按计划·人群拆行），不报重复提示。 */
  allowDuplicateEntity?: boolean;
}

export const reportContracts: Record<ReportType, ReportContract> = {
  product_source: {
    reportType: "product_source",
    label: "导入商品源数据",
    sourceSystem: "生意参谋-商品源数据报表",
    entityHeader: "商品ID",
    dateHeader: "统计日期",
    // 分日明细：同一商品ID跨不同统计日期本就多行，由 mapper 按(商品ID+日期)求和，不报"重复"。
    allowDuplicateEntity: true,
    requiredHeaders: [
      "统计日期",
      "商品ID",
      "商品名称",
      "商品访客数",
      "商品浏览量",
      "平均停留时长",
      "商品详情页跳出率",
      "支付买家数",
      "支付金额",
      "商品支付转化率",
      "成功退款金额",
      "搜索引导支付转化率",
      "搜索引导访客数"
    ]
  },
  damo_product_source: {
    reportType: "damo_product_source",
    label: "导入达摩盘源数据",
    sourceSystem: "达摩盘-货品源报表",
    entityHeader: "宝贝ID",
    requiredHeaders: [
      "宝贝ID",
      "宝贝名称",
      "货品成长阶段",
      "支付金额",
      "IPV",
      "营销推广消耗",
      "营销推广ROI",
      "支付转化率",
      "复购率",
      "免费搜索点击率",
      "连带购买率",
      "连带购买叶子类目宽度"
    ]
  },
  promotion_product_source: {
    reportType: "promotion_product_source",
    label: "导入推广宝贝报表源数据",
    sourceSystem: "万相台无界-推广宝贝报表",
    entityHeader: "主体ID",
    dateHeader: "日期",
    // 分日明细：同一主体ID跨不同日期本就多行，由 mapper 按(主体ID+日期)求和，不报"重复"。
    allowDuplicateEntity: true,
    requiredHeaders: [
      "日期",
      "主体ID",
      "主体类型",
      "主体名称",
      "展现量",
      "点击量",
      "花费",
      "平均点击花费",
      "投入产出比"
    ]
  },
  audience_source: {
    reportType: "audience_source",
    label: "导入人群报表源数据",
    sourceSystem: "万相台无界-人群报表",
    entityHeader: "主体ID",
    dateHeader: "日期",
    allowDuplicateEntity: true,
    requiredHeaders: [
      "日期",
      "场景ID",
      "场景名字",
      "计划ID",
      "计划名字",
      "人群名字",
      "主体ID",
      "主体名称",
      "点击量",
      "投入产出比",
      "引导访问潜客占比",
      "成交新客占比"
    ]
  }
};

/**
 * 推广报表的主体维度。三阶引擎按「主体ID = 商品ID」把推广花费关联到商品，
 * 因此只有商品/宝贝维度的报表能用。误传关键词、创意、人群等维度时，
 * 所有商品都查不到推广成本、被静默当成 0 元，利润与预算结论会整体失真。
 */
const PROMOTION_SUBJECT_PRODUCT_TYPES = ["宝贝", "商品", "单品", "货品"];
const PROMOTION_SUBJECT_NON_PRODUCT_TYPES = [
  "关键词",
  "词",
  "创意",
  "素材",
  "人群",
  "定向",
  "资源位",
  "单元",
  "计划",
  "场景"
];

function classifyPromotionSubjectTypes(values: string[]) {
  const distinct = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  const product: string[] = [];
  const nonProduct: string[] = [];
  const unknown: string[] = [];
  for (const value of distinct) {
    if (PROMOTION_SUBJECT_PRODUCT_TYPES.some((type) => value.includes(type))) {
      product.push(value);
    } else if (PROMOTION_SUBJECT_NON_PRODUCT_TYPES.some((type) => value.includes(type))) {
      nonProduct.push(value);
    } else {
      unknown.push(value);
    }
  }
  return { distinct, product, nonProduct, unknown };
}

export function validateImportRows(
  reportType: ReportType,
  receivedHeaders: string[],
  rows: unknown[][],
  options?: { fallbackDate?: string }
): ImportValidationResult {
  const contract = reportContracts[reportType];
  const headerKeys = receivedHeaders.map(normalizeHeader);
  const normalizedHeaders = headerKeys.filter(Boolean);
  const headerSet = new Set(normalizedHeaders);
  const missingHeaders = contract.requiredHeaders.filter(
    (header) => !headerSet.has(normalizeHeader(header))
  );
  const requiredSet = new Set(contract.requiredHeaders.map(normalizeHeader));
  const extraHeaders = normalizedHeaders.filter((header) => !requiredSet.has(header));
  const entityIndex = resolveColumnIndex(headerKeys, contract.requiredHeaders, contract.entityHeader);
  const dateIndex =
    contract.dateHeader === undefined
      ? findLooseDateHeaderIndex(headerKeys)
      : resolveColumnIndex(headerKeys, contract.requiredHeaders, contract.dateHeader);
  const entityValues =
    entityIndex >= 0
      ? rows
          .map((row) => stringifyCell(row[entityIndex]))
          .filter((value) => value !== "" && value !== "总计")
      : [];
  const contentRows = entityIndex >= 0
    ? rows.filter((row) => {
        const entity = stringifyCell(row[entityIndex]);
        return entity !== "" && entity !== "总计";
      })
    : rows;
  const duplicateEntityIds = findDuplicates(entityValues);
  const rawDateValues =
    dateIndex >= 0
      ? [...new Set(contentRows.map((row) => stringifyCell(row[dateIndex])).filter(Boolean))]
      : [];
  const parsedDailyDates = contract.dateHeader === undefined
    ? []
    : rawDateValues.flatMap((value) => {
        const range = summarizeDateValues([value]);
        return range.length === 1 ? range : [];
      });
  const normalizedDailyDates = [...new Set(parsedDailyDates)];
  const invalidDailyDateCount = contract.dateHeader === undefined
    ? 0
    : rawDateValues.length - parsedDailyDates.length;
  const dateValues = summarizeDateValues(
    contract.dateHeader === undefined ? rawDateValues : normalizedDailyDates
  );
  const dateExpectedDays = dateValues.length > 0
    ? inclusiveDateCount(dateValues[0], dateValues.at(-1)!)
    : 0;
  const dateObservedDays = contract.dateHeader === undefined ? undefined : normalizedDailyDates.length;
  const warnings: string[] = [];
  const errors: string[] = [];

  const rowQuality = assessRawRowQuality(reportType, contract, headerKeys, rows, options?.fallbackDate);

  if (missingHeaders.length > 0) {
    warnings.push(`缺少表头字段，已尝试按官方固定列序识别；无法可靠识别的字段将记为 null：${missingHeaders.join("、")}`);
  }

  if (entityIndex < 0) {
    warnings.push(`未找到主键字段 ${contract.entityHeader}，无法识别主键的行将被隔离，不生成临时ID`);
  }

  if (rows.length === 0) {
    errors.push("报表没有可计算的数据行");
  }
  if (rows.length > 0 && rowQuality.acceptedRowCount === 0) {
    errors.push("没有可参与计算的有效行；请至少提供可识别的主键和可靠日期");
  }
  if (rowQuality.rejectedRowCount > 0) {
    warnings.push(`已隔离 ${rowQuality.rejectedRowCount} 行结构异常数据，其余 ${rowQuality.acceptedRowCount} 行继续导入`);
  }
  if (rowQuality.fieldIssueCount > 0) {
    warnings.push(`发现 ${rowQuality.fieldIssueCount} 个空白、非法或越界数值，相关字段按 null 处理；不影响同一行其它指标计算`);
  }

  if (duplicateEntityIds.length > 0 && !contract.allowDuplicateEntity) {
    warnings.push(
      `${duplicateEntityIds.length} 个货品有多日数据，已按${contract.entityHeader}汇总为一条（量级求和、率重算、阶段取最新）：${duplicateEntityIds.slice(0, 8).join("、")}`
    );
  }

  if (reportType === "promotion_product_source") {
    const subjectTypeIndex = normalizedHeaders.indexOf(normalizeHeader("主体类型"));
    if (subjectTypeIndex >= 0) {
      const { distinct, product, nonProduct, unknown } = classifyPromotionSubjectTypes(
        contentRows.map((row) => stringifyCell(row[subjectTypeIndex]))
      );
      if (distinct.length > 0 && product.length === 0 && nonProduct.length > 0) {
        errors.push(
          `推广报表主体类型为「${nonProduct.join("、")}」，不是商品/宝贝维度。三阶引擎按主体ID关联商品推广花费，该维度会导致所有商品推广成本被当作 0 元，请改导出“推广宝贝报表”。`
        );
      } else if (nonProduct.length > 0) {
        warnings.push(
          `推广报表混有非商品维度主体（${nonProduct.join("、")}），这些行无法关联到商品，已按主体ID原样汇总，请确认是否需要拆分导出`
        );
      } else if (product.length === 0 && unknown.length > 0) {
        warnings.push(
          `无法识别推广报表主体类型「${unknown.slice(0, 5).join("、")}」，请确认导出的是商品/宝贝维度的推广宝贝报表`
        );
      }
    }
  }

  if (dateIndex >= 0 && dateValues.length === 0) {
    warnings.push(`未识别到${contract.dateHeader}，请确认报表周期`);
  }
  if (invalidDailyDateCount > 0) {
    warnings.push(`${contract.dateHeader}有 ${invalidDailyDateCount} 个无法识别的日期值；仅在文件名日期明确时推导，否则隔离对应行，不使用导入当天兜底`);
  }
  if (
    dateObservedDays !== undefined && dateExpectedDays > 0 && dateObservedDays < dateExpectedDays
  ) {
    warnings.push(`统计日期仅覆盖 ${dateObservedDays}/${dateExpectedDays} 个自然日；投资与效果结论将保持锁定，直至补齐缺日`);
  }

  return {
    ok: errors.length === 0,
    reportType,
    receivedHeaders: normalizedHeaders,
    requiredHeaders: contract.requiredHeaders,
    missingHeaders,
    extraHeaders,
    rowCount: rows.length,
    acceptedRowCount: rowQuality.acceptedRowCount,
    rejectedRowCount: rowQuality.rejectedRowCount,
    fieldIssueCount: rowQuality.fieldIssueCount,
    uniqueEntityCount: new Set(entityValues).size,
    duplicateEntityIds,
    dateValues,
    ...(dateObservedDays !== undefined ? { dateObservedDays, dateExpectedDays } : {}),
    warnings,
    errors
  };
}

const NUMERIC_HEADERS: Record<ReportType, string[]> = {
  product_source: [
    "商品访客数", "商品浏览量", "平均停留时长", "商品详情页跳出率", "支付买家数",
    "支付金额", "商品支付转化率", "成功退款金额", "搜索引导支付转化率", "搜索引导访客数"
  ],
  damo_product_source: [
    "支付金额", "IPV", "营销推广消耗", "营销推广ROI", "支付转化率", "复购率",
    "免费搜索点击率", "笔单价", "连带购买率", "连带购买叶子类目宽度"
  ],
  promotion_product_source: ["展现量", "点击量", "花费", "平均点击花费", "投入产出比"],
  audience_source: ["点击量", "投入产出比", "引导访问潜客占比", "成交新客占比"]
};

const RATIO_HEADERS = new Set([
  "商品详情页跳出率", "商品支付转化率", "搜索引导支付转化率", "支付转化率", "复购率",
  "免费搜索点击率", "连带购买率", "引导访问潜客占比", "成交新客占比"
].map(normalizeHeader));

function assessRawRowQuality(
  reportType: ReportType,
  contract: ReportContract,
  headers: string[],
  rows: unknown[][],
  fallbackDate?: string
) {
  const entityIndex = resolveColumnIndex(headers, contract.requiredHeaders, contract.entityHeader);
  const dateIndex = contract.dateHeader
    ? resolveColumnIndex(headers, contract.requiredHeaders, contract.dateHeader)
    : -1;
  const planIndex = reportType === "audience_source"
    ? resolveColumnIndex(headers, contract.requiredHeaders, "计划ID")
    : -1;
  let acceptedRowCount = 0;
  let rejectedRowCount = 0;
  let fieldIssueCount = 0;

  for (const row of rows) {
    const entity = entityIndex >= 0 ? stringifyCell(row[entityIndex]) : "";
    if (["总计", "合计"].includes(entity)) continue;
    const dateOk = !contract.dateHeader || normalizeDailyDate(dateIndex >= 0 ? row[dateIndex] : "") || normalizeDailyDate(fallbackDate ?? "");
    const planOk = reportType !== "audience_source" || (planIndex >= 0 && isEntityValue(stringifyCell(row[planIndex])));
    if (!isEntityValue(entity) || !dateOk || !planOk) {
      rejectedRowCount += 1;
      continue;
    }
    acceptedRowCount += 1;
    for (const header of NUMERIC_HEADERS[reportType]) {
      const index = resolveColumnIndex(headers, contract.requiredHeaders, header);
      const parsed = index >= 0 ? parseNumericForQuality(row[index]) : null;
      if (parsed === null || (RATIO_HEADERS.has(normalizeHeader(header)) && (parsed < 0 || parsed > 1))) {
        fieldIssueCount += 1;
      }
    }
  }
  return { acceptedRowCount, rejectedRowCount, fieldIssueCount };
}

function resolveColumnIndex(headers: string[], expectedHeaders: string[], header: string) {
  const key = normalizeHeader(header);
  const explicit = headers.indexOf(key);
  if (explicit >= 0) return explicit;
  return expectedHeaders.map(normalizeHeader).indexOf(key);
}

function isEntityValue(value: string) {
  return value !== "" && value !== "总计" && value !== "合计";
}

function normalizeDailyDate(value: unknown) {
  const text = stringifyCell(value).split(/[\sT]/)[0];
  const match = text.match(/^(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})$/);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
    ? `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    : "";
}

function parseNumericForQuality(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = stringifyCell(value).replace(/[,¥$\s]/g, "");
  if (!text || isZeroLikeNumericCell(text)) return null;
  const numeric = text.endsWith("%") ? Number(text.slice(0, -1)) / 100 : Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

function inclusiveDateCount(start: string, end: string) {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  return Number.isFinite(from) && Number.isFinite(to) && to >= from
    ? Math.floor((to - from) / 86_400_000) + 1
    : 0;
}

/** 报表用这些显式占位符表示“本期没有产生数据”，计算时按 0 处理。 */
export function isZeroLikeNumericCell(value: unknown) {
  const text = stringifyCell(value).trim().toUpperCase();
  return ["-", "--", "—", "–", "－", "N/A", "NA", "NULL", "UNDEFINED"].includes(text);
}

export function normalizeHeader(value: unknown) {
  return stringifyCell(value).replace(/\s+/g, "");
}

export function stringifyCell(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value).trim();
}

function findDuplicates(values: string[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates];
}

function findLooseDateHeaderIndex(headers: string[]) {
  return headers.findIndex((header) => /(日期|时间|周期|统计区间|报表区间)/.test(header));
}

/**
 * 在解析出的整张表格(可能含标题、统计周期等前导行)中,定位真正的列表头行。
 * 取与该报表契约必填字段匹配最多、且包含主键字段的那一行,其后为数据行。
 */
export function locateHeaderRow(matrix: unknown[][], reportType: ReportType) {
  const contract = reportContracts[reportType];
  const requiredSet = new Set(contract.requiredHeaders.map(normalizeHeader));
  const entityKey = normalizeHeader(contract.entityHeader);
  const scanLimit = Math.min(matrix.length, 20);
  let bestIndex = 0;
  let bestScore = -1;
  for (let index = 0; index < scanLimit; index += 1) {
    const cells = new Set((matrix[index] ?? []).map(normalizeHeader).filter(Boolean));
    let score = 0;
    for (const cell of cells) {
      if (requiredSet.has(cell)) {
        score += 1;
      }
    }
    if (cells.has(entityKey)) {
      score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  const headers = (matrix[bestIndex] ?? []).map((cell) => stringifyCell(cell));
  const rows = matrix
    .slice(bestIndex + 1)
    .filter((row) => row.some((cell) => stringifyCell(cell) !== ""));
  return { headerIndex: bestIndex, headers, rows };
}
