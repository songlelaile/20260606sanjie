import * as XLSX from "xlsx";

export interface ParsedWorkbookRows {
  matrix: unknown[][];
  warnings: string[];
}

const ALLOWED_EXTENSIONS = [".csv", ".xlsx", ".xls"];

export async function parseWorkbookUpload(file: File): Promise<ParsedWorkbookRows> {
  const lowerName = file.name.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((ext) => lowerName.endsWith(ext))) {
    throw new Error("不支持的文件类型，请上传 .xlsx、.xls 或 .csv 文件");
  }

  if (lowerName.endsWith(".csv")) {
    const csvText = decodeCsvText(await file.arrayBuffer());
    const matrix = parseCsv(csvText);
    const warnings: string[] = [];
    if ((csvText.match(/"/g)?.length ?? 0) % 2 !== 0) {
      warnings.push("检测到未闭合的引号，部分数据行可能被合并或丢失，请检查报表内容");
    }
    return { matrix, warnings };
  }

  // .xls / .xlsx / 网页表格（生意参谋·达摩盘·万相台导出常见）→ SheetJS 自动识别格式
  const bytes = new Uint8Array(await file.arrayBuffer());
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: "array" });
  } catch {
    throw new Error(
      "无法解析该表格文件，请确认是有效的 Excel 文件，或在 Excel/WPS 中另存为 .xlsx 后重试。"
    );
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error("文件中没有可用的工作表");
  }
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
    header: 1,
    blankrows: false,
    defval: ""
  });
  return { matrix, warnings: [] };
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * 自动识别 CSV 编码:优先按 UTF-8 严格解码,失败则回退 GBK/GB18030
 * （生意参谋/万相台等中文平台导出的 CSV 多为 GBK 编码）。
 */
function decodeCsvText(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("gb18030").decode(buffer);
  }
}
