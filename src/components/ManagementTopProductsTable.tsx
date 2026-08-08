"use client";

import { useMemo, useState } from "react";
import { CopyIdentifier } from "@/components/CopyIdentifier";
import { TableHeaderFilter } from "@/components/TableHeaderFilter";
import { formatMoney, formatPercent } from "@/lib/format";
import type { ProductInvestmentResult } from "@/lib/types/domain";

interface Filters {
  query: string;
  lifecycle: string;
  grade: string;
  minGsv: string;
  minProfit: string;
  minHistoricalMargin: string;
  minReservedMargin: string;
  minPlannedProfit: string;
  minBudget: string;
  minSalesGap: string;
}

const emptyFilters: Filters = {
  query: "",
  lifecycle: "",
  grade: "",
  minGsv: "",
  minProfit: "",
  minHistoricalMargin: "",
  minReservedMargin: "",
  minPlannedProfit: "",
  minBudget: "",
  minSalesGap: ""
};

type SortKey =
  | "product"
  | "lifecycle"
  | "grade"
  | "monthlyGsvOpportunity"
  | "historicalGrossProfit"
  | "historicalMarginRate"
  | "attackDefenseMarginRate"
  | "plannedGrossProfit"
  | "remainingAdBudget"
  | "salesGap";

type SortState = { key: SortKey; direction: "asc" | "desc" } | null;

const textSortKeys = new Set<SortKey>(["product", "lifecycle", "grade"]);

export function ManagementTopProductsTable({ products }: { products: ProductInvestmentResult[] }) {
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [sort, setSort] = useState<SortState>(null);

  const lifecycles = useMemo(() => unique(products.map((product) => product.lifecycle)), [products]);
  const grades = useMemo(() => unique(products.map((product) => product.grade)), [products]);
  const visibleProducts = useMemo(
    () =>
      products
        .filter((product) => {
          const query = filters.query.trim().toLowerCase();
          const matchesQuery =
            query.length === 0 ||
            product.productId.toLowerCase().includes(query) ||
            product.productName.toLowerCase().includes(query);
          return (
            matchesQuery &&
            optionMatches(product.lifecycle, filters.lifecycle) &&
            optionMatches(product.grade, filters.grade) &&
            numberAtLeast(product.monthlyGsvOpportunity, filters.minGsv) &&
            numberAtLeast(product.historicalGrossProfit, filters.minProfit) &&
            percentAtLeast(product.historicalMarginRate, filters.minHistoricalMargin) &&
            percentAtLeast(product.attackDefenseMarginRate, filters.minReservedMargin) &&
            numberAtLeast(product.plannedGrossProfit, filters.minPlannedProfit) &&
            numberAtLeast(product.remainingAdBudget, filters.minBudget) &&
            numberAtLeast(product.salesGap, filters.minSalesGap)
          );
        })
        .sort((left, right) => compareProducts(left, right, sort)),
    [filters, products, sort]
  );

  function update<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function clear<K extends keyof Filters>(key: K) {
    update(key, "");
  }

  function toggleSort(key: SortKey) {
    setSort((current) => {
      if (current?.key === key) {
        return { key, direction: current.direction === "asc" ? "desc" : "asc" };
      }
      return { key, direction: textSortKeys.has(key) ? "asc" : "desc" };
    });
  }

  function sortDirection(key: SortKey) {
    return sort?.key === key ? sort.direction : null;
  }

  return (
    <section className="table-panel management-top-products-panel">
      <div className="panel-toolbar">
        <div>
          <strong>销售 TOP 商品</strong>
          <span>按分析窗去退销售额降序；利润安全垫仅作承压代理，不等于可投预算</span>
        </div>
        <span className="table-count">
          筛选后 {visibleProducts.length} / {products.length} 个商品
        </span>
      </div>
      <div className="table-wrap management-top-products-scroll">
        <table className="management-top-products-table">
          <colgroup>
            <col className="management-product-col" />
            <col className="management-lifecycle-col" />
            <col className="management-grade-col" />
            <col className="management-gsv-col" />
            <col className="management-profit-col" />
            <col className="management-margin-col" />
            <col className="management-reserved-margin-col" />
            <col className="management-planned-profit-col" />
            <col className="management-budget-col" />
            <col className="management-gap-col" />
          </colgroup>
          <thead>
            <tr>
              <th>
                <TableHeaderFilter
                  label="商品"
                  active={Boolean(filters.query)}
                  onClear={() => clear("query")}
                  onSort={() => toggleSort("product")}
                  sortDirection={sortDirection("product")}
                >
                  <label>
                    <span>商品ID/名称</span>
                    <input value={filters.query} onChange={(event) => update("query", event.target.value)} />
                  </label>
                </TableHeaderFilter>
              </th>
              <th>
                <TableHeaderFilter
                  label="生命周期"
                  active={Boolean(filters.lifecycle)}
                  onClear={() => clear("lifecycle")}
                  onSort={() => toggleSort("lifecycle")}
                  sortDirection={sortDirection("lifecycle")}
                >
                  <label>
                    <span>生命周期</span>
                    <select value={filters.lifecycle} onChange={(event) => update("lifecycle", event.target.value)}>
                      <option value="">全部</option>
                      {lifecycles.map((lifecycle) => (
                        <option key={lifecycle} value={lifecycle}>
                          {lifecycle}
                        </option>
                      ))}
                    </select>
                  </label>
                </TableHeaderFilter>
              </th>
              <th>
                <TableHeaderFilter
                  label="评级"
                  active={Boolean(filters.grade)}
                  onClear={() => clear("grade")}
                  onSort={() => toggleSort("grade")}
                  sortDirection={sortDirection("grade")}
                >
                  <label>
                    <span>评级</span>
                    <select value={filters.grade} onChange={(event) => update("grade", event.target.value)}>
                      <option value="">全部</option>
                      {grades.map((grade) => (
                        <option key={grade} value={grade}>
                          {grade}
                        </option>
                      ))}
                    </select>
                  </label>
                </TableHeaderFilter>
              </th>
              <th>
                <MinNumberFilter
                  label="月GSV机会"
                  value={filters.minGsv}
                  onChange={(value) => update("minGsv", value)}
                  onClear={() => clear("minGsv")}
                  onSort={() => toggleSort("monthlyGsvOpportunity")}
                  sortDirection={sortDirection("monthlyGsvOpportunity")}
                />
              </th>
              <th>
                <MinNumberFilter
                  label="分析窗贡献利润估算"
                  value={filters.minProfit}
                  onChange={(value) => update("minProfit", value)}
                  onClear={() => clear("minProfit")}
                  onSort={() => toggleSort("historicalGrossProfit")}
                  sortDirection={sortDirection("historicalGrossProfit")}
                />
              </th>
              <th>
                <MinNumberFilter
                  label="分析窗贡献利润率"
                  value={filters.minHistoricalMargin}
                  onChange={(value) => update("minHistoricalMargin", value)}
                  onClear={() => clear("minHistoricalMargin")}
                  onSort={() => toggleSort("historicalMarginRate")}
                  sortDirection={sortDirection("historicalMarginRate")}
                  suffix="%"
                />
              </th>
              <th>
                <MinNumberFilter
                  label="预留毛利率"
                  value={filters.minReservedMargin}
                  onChange={(value) => update("minReservedMargin", value)}
                  onClear={() => clear("minReservedMargin")}
                  onSort={() => toggleSort("attackDefenseMarginRate")}
                  sortDirection={sortDirection("attackDefenseMarginRate")}
                  suffix="%"
                />
              </th>
              <th>
                <MinNumberFilter
                  label="增长预留毛利"
                  value={filters.minPlannedProfit}
                  onChange={(value) => update("minPlannedProfit", value)}
                  onClear={() => clear("minPlannedProfit")}
                  onSort={() => toggleSort("plannedGrossProfit")}
                  sortDirection={sortDirection("plannedGrossProfit")}
                />
              </th>
              <th>
                <MinNumberFilter
                  label="利润安全垫"
                  value={filters.minBudget}
                  onChange={(value) => update("minBudget", value)}
                  onClear={() => clear("minBudget")}
                  onSort={() => toggleSort("remainingAdBudget")}
                  sortDirection={sortDirection("remainingAdBudget")}
                />
              </th>
              <th>
                <MinNumberFilter
                  label={"分析窗实际−月目标\n（仅完整月可判定）"}
                  value={filters.minSalesGap}
                  onChange={(value) => update("minSalesGap", value)}
                  onClear={() => clear("minSalesGap")}
                  onSort={() => toggleSort("salesGap")}
                  sortDirection={sortDirection("salesGap")}
                  align="right"
                />
              </th>
            </tr>
          </thead>
          <tbody>
            {products.length === 0 ? (
              <tr>
                <td colSpan={10} className="empty-table-cell">
                  暂无商品数据，请先导入源数据并运行算法。
                </td>
              </tr>
            ) : visibleProducts.length === 0 ? (
              <tr>
                <td colSpan={10} className="empty-table-cell">
                  当前筛选条件下暂无商品。
                </td>
              </tr>
            ) : (
              visibleProducts.map((product) => (
                <tr key={product.productId}>
                  <td>
                    <CopyIdentifier label="商品ID" value={product.productId} />
                    <span className="management-product-title" title={product.productName}>
                      {product.productName}
                    </span>
                  </td>
                  <td>{product.lifecycle}</td>
                  <td>{product.grade}</td>
                  <td>{formatMoney(product.monthlyGsvOpportunity, 1)}</td>
                  <td>{product.profitEvidenceAvailable === true ? formatMoney(product.historicalGrossProfit, 1) : "证据不足"}</td>
                  <td>{product.profitEvidenceAvailable === true ? formatPercent(product.historicalMarginRate, 1) : "证据不足"}</td>
                  <td>{formatPercent(product.attackDefenseMarginRate, 1)}</td>
                  <td>{formatMoney(product.plannedGrossProfit, 1)}</td>
                  <td>{product.profitEvidenceAvailable === true && product.remainingAdBudget !== null ? formatMoney(Math.max(product.remainingAdBudget, 0), 1) : "待补同窗成本"}</td>
                  <td>{formatMoney(product.salesGap, 1)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MinNumberFilter({
  label,
  value,
  suffix,
  onChange,
  onClear,
  onSort,
  sortDirection,
  align
}: {
  label: string;
  value: string;
  suffix?: string;
  onChange: (value: string) => void;
  onClear: () => void;
  onSort?: () => void;
  sortDirection?: "asc" | "desc" | null;
  align?: "left" | "right";
}) {
  return (
    <TableHeaderFilter
      label={label}
      active={Boolean(value)}
      onClear={onClear}
      onSort={onSort}
      sortDirection={sortDirection}
      align={align}
    >
      <label>
        <span>最小值{suffix ? `（${suffix}）` : ""}</span>
        <input type="number" value={value} onChange={(event) => onChange(event.target.value)} />
      </label>
    </TableHeaderFilter>
  );
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function optionMatches(actual: string, expected: string) {
  return !expected || actual === expected;
}

function numberAtLeast(actual: number | null, raw: string) {
  if (!raw.trim()) return true;
  const value = Number(raw);
  return !Number.isFinite(value) || (actual !== null && actual >= value);
}

function percentAtLeast(actual: number | null, raw: string) {
  if (!raw.trim()) return true;
  const value = Number(raw);
  return !Number.isFinite(value) || (actual !== null && actual >= value / 100);
}

function compareProducts(left: ProductInvestmentResult, right: ProductInvestmentResult, sort: SortState) {
  if (!sort) return 0;
  const direction = sort.direction === "asc" ? 1 : -1;
  if (textSortKeys.has(sort.key)) {
    return direction * String(productSortValue(left, sort.key)).localeCompare(String(productSortValue(right, sort.key)), "zh-CN");
  }
  const leftValue = productSortValue(left, sort.key);
  const rightValue = productSortValue(right, sort.key);
  return direction * ((typeof leftValue === "number" ? leftValue : Number.NEGATIVE_INFINITY) -
    (typeof rightValue === "number" ? rightValue : Number.NEGATIVE_INFINITY));
}

function productSortValue(product: ProductInvestmentResult, key: SortKey) {
  if (key === "product") return `${product.productName} ${product.productId}`;
  return product[key];
}
