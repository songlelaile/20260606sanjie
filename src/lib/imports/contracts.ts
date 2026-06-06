import type { ImportValidationResult, ReportType } from "@/lib/types/domain";

export interface ReportContract {
  reportType: ReportType;
  label: string;
  sourceSystem: string;
  entityHeader: string;
  dateHeader?: string;
  requiredHeaders: string[];
}

export const reportContracts: Record<ReportType, ReportContract> = {
  product_source: {
    reportType: "product_source",
    label: "导入商品源数据",
    sourceSystem: "生意参谋-商品源数据报表",
    entityHeader: "商品ID",
    dateHeader: "统计日期",
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
      "搜索引导支付转化率"
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

export function validateImportRows(
  reportType: ReportType,
  receivedHeaders: string[],
  rows: unknown[][]
): ImportValidationResult {
  const contract = reportContracts[reportType];
  const normalizedHeaders = receivedHeaders.map(normalizeHeader).filter(Boolean);
  const headerSet = new Set(normalizedHeaders);
  const missingHeaders = contract.requiredHeaders.filter(
    (header) => !headerSet.has(normalizeHeader(header))
  );
  const requiredSet = new Set(contract.requiredHeaders.map(normalizeHeader));
  const extraHeaders = normalizedHeaders.filter((header) => !requiredSet.has(header));
  const entityIndex = normalizedHeaders.indexOf(normalizeHeader(contract.entityHeader));
  const dateIndex =
    contract.dateHeader === undefined
      ? findLooseDateHeaderIndex(normalizedHeaders)
      : normalizedHeaders.indexOf(normalizeHeader(contract.dateHeader));
  const entityValues =
    entityIndex >= 0
      ? rows
          .map((row) => stringifyCell(row[entityIndex]))
          .filter((value) => value !== "" && value !== "总计")
      : [];
  const duplicateEntityIds = findDuplicates(entityValues);
  const dateValues =
    dateIndex >= 0
      ? [...new Set(rows.map((row) => stringifyCell(row[dateIndex])).filter(Boolean))].slice(0, 8)
      : [];
  const warnings: string[] = [];
  const errors: string[] = [];

  if (missingHeaders.length > 0) {
    errors.push(`缺少必填字段：${missingHeaders.join("、")}`);
  }

  if (entityIndex < 0) {
    errors.push(`未找到主键字段：${contract.entityHeader}`);
  }

  if (rows.length === 0) {
    errors.push("报表没有可计算的数据行");
  }

  if (duplicateEntityIds.length > 0) {
    warnings.push(`发现重复 ${contract.entityHeader}：${duplicateEntityIds.slice(0, 8).join("、")}`);
  }

  if (dateIndex >= 0 && dateValues.length === 0) {
    warnings.push(`未识别到${contract.dateHeader}，请确认报表周期`);
  }

  return {
    ok: errors.length === 0,
    reportType,
    receivedHeaders: normalizedHeaders,
    requiredHeaders: contract.requiredHeaders,
    missingHeaders,
    extraHeaders,
    rowCount: rows.length,
    uniqueEntityCount: new Set(entityValues).size,
    duplicateEntityIds,
    dateValues,
    warnings,
    errors
  };
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
