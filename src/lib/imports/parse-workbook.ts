import ExcelJS from "exceljs";

export interface ParsedWorkbookRows {
  headers: string[];
  rows: unknown[][];
}

export async function parseWorkbookUpload(file: File): Promise<ParsedWorkbookRows> {
  if (file.name.toLowerCase().endsWith(".csv")) {
    const csvText = await file.text();
    const matrix = parseCsv(csvText);
    const [headers = [], ...rows] = matrix;
    return {
      headers: headers.map((header) => String(header ?? "").trim()),
      rows: rows.filter((row) => row.some((cell) => String(cell ?? "").trim() !== ""))
    };
  }

  const bytes = await file.arrayBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const worksheet = workbook.worksheets[0];
  const matrix: unknown[][] = [];
  worksheet.eachRow((row) => {
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    matrix.push(values);
  });
  const [headers = [], ...rows] = matrix;
  const compactRows = rows.filter((row) => row.some((cell) => String(cell ?? "").trim() !== ""));
  return {
    headers: headers.map((header) => String(header ?? "").trim()),
    rows: compactRows
  };
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
