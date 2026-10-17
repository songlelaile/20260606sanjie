export type ShopAttributionSelection = "all" | "2" | "1";
export const SHOP_ATTRIBUTIONS = [
  { scale: "2", label: "广告域归因" },
  { scale: "1", label: "全域归因" }
] as const;

interface AttributionTable {
  name: string;
  columns: string[];
  rows: unknown[][];
}
const CHANNEL_TABLE = "店铺竞争态势·渠道表现";
export function hasShopAttributionTables(tables: AttributionTable[]) {
  return tables.some(table => table.name === CHANNEL_TABLE && table.columns.includes("归因范围"));
}
function isChannelRow(table: AttributionTable, row: unknown[]) {
  return table.name === CHANNEL_TABLE || table.name === "对标总表"
    && table.columns.includes("模块") && row[table.columns.indexOf("模块")] === "渠道表现";
}
export function filterShopAttribution<T extends AttributionTable>(tables: T[], selection: ShopAttributionSelection): T[] {
  const label = SHOP_ATTRIBUTIONS.find(scope => scope.scale === selection)?.label;
  if (!label) return tables;
  return tables.map(table => {
    const index = table.columns.indexOf("归因范围");
    if (index < 0) return table;
    return { ...table, rows: table.rows.filter(row => !isChannelRow(table, row) || row[index] === label) };
  });
}
export function shopAttributionAvailability(tables: AttributionTable[]) {
  const table = tables.find(table => table.name === CHANNEL_TABLE);
  const index = table?.columns.indexOf("归因范围") ?? -1;
  const disclosed = (value: unknown) => value !== null && value !== undefined
    && !["", "—", "--"].includes(String(value).trim());
  return SHOP_ATTRIBUTIONS.map(scope => {
    const rows = table && index >= 0 ? table.rows.filter(row => row[index] === scope.label) : [];
    const periods = (period: string) => table?.columns.flatMap((column, i) => column.endsWith(period) ? [i] : []) ?? [];
    const current = periods("本期"), previous = periods("上期");
    const currentRows = rows.filter(row => current.some(i => disclosed(row[i]))).length;
    const previousRows = rows.filter(row => previous.some(i => disclosed(row[i]))).length;
    return { ...scope, currentRows, previousRows, status: currentRows || previousRows ? "已有数据" : "未取得" };
  });
}
