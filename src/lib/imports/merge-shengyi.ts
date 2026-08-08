import { isPlaceholderToken, normalizeHeader, stringifyCell } from "@/lib/imports/contracts";
import { normalizeDate } from "@/lib/imports/map-rows";

/**
 * 生意参谋"商品_全部"逐日 .xls 多文件合并（v2）。
 * 生意参谋每天只能导出一个文件（文件名带日期、内部"统计日期"列=当天），运营常有几十个日表。
 * 本模块把它们预检 + 合并成一张"商品维度"源表，再走现有商品分日 upsert。
 */

/** 单个已解析文件：表头 + 数据行（已剥离标题行）。 */
export interface ParsedShengyiFile {
  name: string;
  headers: string[];
  rows: unknown[][];
}

export interface ShengyiFileReport {
  name: string;
  fileDate: string; // 从文件名识别
  internalDates: string[]; // 内部"统计日期"去重
  rows: number;
  columns: number;
  issues: string[];
}

export interface ShengyiMergeReport {
  fileCount: number;
  dateStart: string;
  dateEnd: string;
  totalDataRows: number;
  headerColumnCount: number;
  distinctDates: number;
  ok: boolean; // 无 error 即可合并（warning 不阻断）
  errors: string[];
  warnings: string[];
  perFile: ShengyiFileReport[];
}

export interface ShengyiMergePlan {
  report: ShengyiMergeReport;
  mergedHeaders: string[];
  mergedRows: unknown[][];
}

/** 从文件名里识别日期（取首个 YYYY-MM-DD / YYYY_MM_DD / YYYYMMDD）。 */
export function extractFileDate(name: string): string {
  return normalizeDate((name.match(/\d{4}[-_]?\d{2}[-_]?\d{2}/) || [""])[0].replace(/_/g, "-"));
}

function dateColIndex(headers: string[]): number {
  return headers.findIndex((h) => normalizeHeader(h) === normalizeHeader("统计日期"));
}

function idColIndex(headers: string[]): number {
  return headers.findIndex((h) => normalizeHeader(h) === normalizeHeader("商品ID"));
}

/** 枚举两端之间缺失的日期（含完整性检查）。 */
function missingDates(start: string, end: string, present: Set<string>): string[] {
  const missing: string[] = [];
  const [ys, ms, ds] = start.split("-").map(Number);
  const [ye, me, de] = end.split("-").map(Number);
  const cursor = new Date(Date.UTC(ys, ms - 1, ds));
  const last = new Date(Date.UTC(ye, me - 1, de));
  let guard = 0;
  while (cursor.getTime() <= last.getTime() && guard < 1000) {
    const iso = cursor.toISOString().slice(0, 10);
    if (!present.has(iso)) {
      missing.push(iso);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard += 1;
  }
  return missing;
}

const REQUIRED = ["统计日期", "商品ID", "支付金额", "支付买家数"];

/**
 * 预检 + 合并计划：校验每个文件，拼接所有数据行。
 * 规则：
 *  - error（阻断）：某文件缺少关键列 / 无可用数据行 / 没有任何可识别日期 / 两个文件同一内部日期（重复）。
 *  - warning（不阻断）：文件名日期与内部统计日期不一致 / 单文件含多个内部日期 / 表头列数不一致 / 日期区间有缺口。
 */
export function buildShengyiMergePlan(
  files: ParsedShengyiFile[],
  opts?: { expectedStart?: string; expectedEnd?: string }
): ShengyiMergePlan {
  const errors: string[] = [];
  const warnings: string[] = [];
  const perFile: ShengyiFileReport[] = [];

  if (files.length === 0) {
    return {
      report: {
        fileCount: 0,
        dateStart: "",
        dateEnd: "",
        totalDataRows: 0,
        headerColumnCount: 0,
        distinctDates: 0,
        ok: false,
        errors: ["请选择至少一个生意参谋日表文件"],
        warnings: [],
        perFile: []
      },
      mergedHeaders: [],
      mergedRows: []
    };
  }

  // 以所有文件表头并集作为规范列，避免首文件缺少的后续合法列被静默丢弃。
  const canonicalHeaders: string[] = [];
  const seenCanonical = new Set<string>();
  for (const file of files) {
    for (const header of file.headers) {
      const key = normalizeHeader(header);
      if (key && !seenCanonical.has(key)) {
        seenCanonical.add(key);
        canonicalHeaders.push(header);
      }
    }
  }
  const canonicalColCount = canonicalHeaders.length;
  const canonicalKeys = canonicalHeaders.map(normalizeHeader);
  const dateToFile = new Map<string, string>(); // 内部日期 → 首个文件名（查重）
  const allDates = new Set<string>();
  const mergedRows: unknown[][] = [];

  // 把某文件的一行按表头名重排到"首文件列序"，保证合并后所有行与 canonicalHeaders 对齐
  // （即使个别文件列顺序不同，也不会错列）。
  function remapToCanonical(headers: string[], row: unknown[]): unknown[] {
    const sameOrder =
      headers.length === canonicalColCount &&
      headers.every((h, i) => normalizeHeader(h) === canonicalKeys[i]);
    if (sameOrder) {
      return row;
    }
    const byKey = new Map<string, number>();
    headers.forEach((h, i) => {
      const k = normalizeHeader(h);
      if (k && !byKey.has(k)) byKey.set(k, i);
    });
    return canonicalKeys.map((k) => {
      const idx = byKey.get(k);
      return idx === undefined ? "" : row[idx];
    });
  }

  for (const file of files) {
    const issues: string[] = [];
    const di = dateColIndex(file.headers);
    const ii = idColIndex(file.headers);

    const missingCols = REQUIRED.filter(
      (c) => !file.headers.some((h) => normalizeHeader(h) === normalizeHeader(c))
    );
    if (missingCols.length > 0) {
      const msg = `${file.name}：缺少必要列 ${missingCols.join("、")}`;
      errors.push(msg);
      issues.push(`缺列 ${missingCols.join("、")}`);
    }

    // 数据行：商品ID 非空、非"总计/合计"、非占位符(-、— 等)
    const dataRows =
      ii >= 0
        ? file.rows.filter((r) => {
            const id = stringifyCell(r[ii]).trim();
            return id !== "" && id !== "总计" && id !== "合计" && !isPlaceholderToken(id);
          })
        : [];
    if (dataRows.length === 0) {
      errors.push(`${file.name}：没有可用数据行`);
      issues.push("无数据行");
    }

    // 内部统计日期
    const internalDates =
      di >= 0
        ? [...new Set(dataRows.map((r) => normalizeDate(r[di])).filter(Boolean))].sort()
        : [];
    if (internalDates.length === 0) {
      errors.push(`${file.name}：未识别到统计日期`);
      issues.push("无统计日期");
    } else if (internalDates.length > 1) {
      warnings.push(`${file.name}：含多个统计日期（${internalDates.join("、")}），通常一个日表只应有一天`);
      issues.push("多日期");
    }

    const fileDate = extractFileDate(file.name);
    if (fileDate && internalDates.length === 1 && internalDates[0] !== fileDate) {
      warnings.push(`${file.name}：文件名日期 ${fileDate} 与内部统计日期 ${internalDates[0]} 不一致`);
      issues.push("日期不匹配");
    }

    // 重复日期查重
    for (const d of internalDates) {
      const prev = dateToFile.get(d);
      if (prev) {
        errors.push(`日期 ${d} 在多个文件出现：${prev}、${file.name}（请勿重复导入同一天）`);
        issues.push("重复日期");
      } else {
        dateToFile.set(d, file.name);
      }
      allDates.add(d);
    }

    if (file.headers.length !== canonicalColCount) {
      warnings.push(`${file.name}：表头列数 ${file.headers.length} 与合并规范 ${canonicalColCount} 不一致`);
      issues.push("列数不一致");
    }
    const fileKeys = new Set(file.headers.map(normalizeHeader).filter(Boolean));
    const missingFromFile = canonicalKeys.filter((key) => !fileKeys.has(key));
    if (missingFromFile.length > 0) {
      warnings.push(`${file.name}：缺少合并规范列 ${missingFromFile.join("、")}，对应字段将记为 null`);
      issues.push("列名集合不一致");
    }

    // 重排到首文件列序后再拼接（防止个别文件列顺序不同导致错列）。
    for (const r of dataRows) {
      mergedRows.push(remapToCanonical(file.headers, r));
    }

    perFile.push({
      name: file.name,
      fileDate,
      internalDates,
      rows: dataRows.length,
      columns: file.headers.length,
      issues
    });
  }

  const sortedDates = [...allDates].sort();
  const dateStart = sortedDates[0] ?? "";
  const dateEnd = sortedDates[sortedDates.length - 1] ?? "";

  // 完整性检查：优先用运营填的期望区间，否则用数据自身 min~max。
  const checkStart = normalizeDate(opts?.expectedStart ?? "") || dateStart;
  const checkEnd = normalizeDate(opts?.expectedEnd ?? "") || dateEnd;
  if (checkStart && checkEnd && checkStart !== checkEnd) {
    const gaps = missingDates(checkStart, checkEnd, allDates);
    if (gaps.length > 0) {
      warnings.push(
        `日期不连续，区间 ${checkStart}~${checkEnd} 缺 ${gaps.length} 天${
          gaps.length <= 8 ? "（" + gaps.join("、") + "）" : ""
        }`
      );
    }
  }

  const ok = errors.length === 0;

  return {
    report: {
      fileCount: files.length,
      dateStart,
      dateEnd,
      totalDataRows: mergedRows.length,
      headerColumnCount: canonicalColCount,
      distinctDates: allDates.size,
      ok,
      errors,
      warnings,
      perFile
    },
    mergedHeaders: canonicalHeaders,
    mergedRows
  };
}
