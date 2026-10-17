import "server-only";
import ExcelJS from "exceljs";
import { dmpCellSemantic, formatDmpCell } from "@/lib/dmp-report-format";
import { normalizeDmpCanonicalReportForUse } from "@/lib/dmp-report-import";
import { assessDmpEffectiveReportQuality } from "@/lib/dmp-report-quality";
import type { DmpCanonicalReport, DmpReportQuality } from "@/lib/dmp-report-types";

export async function buildDmpReportWorkbook(
  report: DmpCanonicalReport,
  declaredQuality: DmpReportQuality = "complete"
) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "少壮AI";
  workbook.created = new Date();
  const prepared = normalizedReport(report, declaredQuality);

  prepared.tables.forEach((table, index) => {
    const worksheet = workbook.addWorksheet(sheetName(table.name, index));
    const showQualityNotice = index === 0 && prepared.quality.effectiveQuality === "partial";
    if (showQualityNotice) {
      const notice = worksheet.addRow(["数据完整性提示", prepared.quality.notice]);
      notice.font = { bold: true, color: { argb: "FF6F4F0F" } };
      notice.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF3CD" } };
      worksheet.addRow([]);
    }
    const headerRow = showQualityNotice ? 3 : 1;
    worksheet.views = [{ state: "frozen", ySplit: headerRow }];
    const header = worksheet.addRow(table.columns);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF16744A" } };
    header.alignment = { vertical: "middle" };
    table.rows.forEach((row) => worksheet.addRow(row.map((value, columnIndex) => safeSpreadsheetValue(
      formatDmpCell(value, dmpCellSemantic(table.name, table.columns, row, columnIndex))
    ))));
    worksheet.autoFilter = {
      from: { row: headerRow, column: 1 },
      to: { row: Math.max(headerRow, table.rows.length + headerRow), column: table.columns.length }
    };
    worksheet.columns.forEach((column, columnIndex) => {
      const longest = Math.max(
        String(table.columns[columnIndex] ?? "").length,
        ...table.rows.slice(0, 100).map((row) => String(row[columnIndex] ?? "").length)
      );
      column.width = Math.min(42, Math.max(12, longest + 2));
    });
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function buildDmpReportCsv(
  report: DmpCanonicalReport,
  declaredQuality: DmpReportQuality = "complete"
) {
  const lines: string[] = [];
  const prepared = normalizedReport(report, declaredQuality);
  if (prepared.quality.effectiveQuality === "partial") {
    lines.push(csvLine(["数据完整性提示", prepared.quality.notice]), "");
  }
  prepared.tables.forEach((table, index) => {
    if (index) lines.push("");
    lines.push(csvLine([table.name]));
    lines.push(csvLine(table.columns));
    table.rows.forEach((row) => lines.push(csvLine(row.map((value, columnIndex) => (
      formatDmpCell(value, dmpCellSemantic(table.name, table.columns, row, columnIndex))
    )))));
  });
  return `\ufeff${lines.join("\r\n")}`;
}

function normalizedReport(report: DmpCanonicalReport, declaredQuality: DmpReportQuality) {
  const normalized = normalizeDmpCanonicalReportForUse(report);
  const tables = normalized?.tables ?? report.tables.map((table) => ({
    name: table.name,
    columns: table.columns,
    rows: table.rows.map((row) => [...row.cells])
  }));
  return {
    tables,
    quality: assessDmpEffectiveReportQuality(report, declaredQuality, normalized)
  };
}

function sheetName(value: string, index: number) {
  return `${index + 1}-${value}`.replace(/[\\/?*\[\]:]/g, "-").slice(0, 31);
}

function safeSpreadsheetValue(value: string) {
  return /^[=+\-@]/.test(value) ? `\t${value}` : value;
}

function csvLine(values: string[]) {
  return values.map((value) => `"${safeSpreadsheetValue(String(value)).replace(/"/g, '""')}"`).join(",");
}
