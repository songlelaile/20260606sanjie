import "server-only";
import ExcelJS from "exceljs";
import { dmpCellSemantic, formatDmpCell } from "@/lib/dmp-report-format";
import { canonicalToDmpReport } from "@/lib/dmp-report-import";
import type { DmpCanonicalReport } from "@/lib/dmp-report-types";

export async function buildDmpReportWorkbook(report: DmpCanonicalReport) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "少壮AI";
  workbook.created = new Date();

  reportTables(report).forEach((table, index) => {
    const worksheet = workbook.addWorksheet(sheetName(table.name, index));
    worksheet.views = [{ state: "frozen", ySplit: 1 }];
    const header = worksheet.addRow(table.columns);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF16744A" } };
    header.alignment = { vertical: "middle" };
    table.rows.forEach((row) => worksheet.addRow(row.map((value, columnIndex) => safeSpreadsheetValue(
      formatDmpCell(value, dmpCellSemantic(table.name, table.columns, row, columnIndex))
    ))));
    worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, table.rows.length + 1), column: table.columns.length } };
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

export function buildDmpReportCsv(report: DmpCanonicalReport) {
  const lines: string[] = [];
  reportTables(report).forEach((table, index) => {
    if (index) lines.push("");
    lines.push(csvLine([table.name]));
    lines.push(csvLine(table.columns));
    table.rows.forEach((row) => lines.push(csvLine(row.map((value, columnIndex) => (
      formatDmpCell(value, dmpCellSemantic(table.name, table.columns, row, columnIndex))
    )))));
  });
  return `\ufeff${lines.join("\r\n")}`;
}

function reportTables(report: DmpCanonicalReport) {
  return canonicalToDmpReport(report)?.tables ?? report.tables.map((table) => ({
    name: table.name,
    columns: table.columns,
    rows: table.rows.map((row) => [...row.cells])
  }));
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
