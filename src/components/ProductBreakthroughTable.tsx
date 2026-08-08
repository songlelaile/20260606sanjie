"use client";

import { useMemo, useState } from "react";
import { CopyIdentifier } from "@/components/CopyIdentifier";
import { StatusPill } from "@/components/StatusPill";
import { TableHeaderFilter } from "@/components/TableHeaderFilter";
import { formatNumber } from "@/lib/format";
import type { ProductBreakthroughResult } from "@/lib/types/domain";

interface Filters {
  query: string;
  lifecycle: string;
  grade: string;
  minScore: string;
  solutionCode: string;
  failedDimension: string;
  solution: string;
}

const emptyFilters: Filters = {
  query: "",
  lifecycle: "",
  grade: "",
  minScore: "",
  solutionCode: "",
  failedDimension: "",
  solution: ""
};

type SortKey = "product" | "lifecycle" | "grade" | "score" | "solutionCode" | "failedDimension" | "solution";
type SortState = { key: SortKey; direction: "asc" | "desc" };

const textSortKeys = new Set<SortKey>(["product", "lifecycle", "grade", "solutionCode", "failedDimension", "solution"]);

export function ProductBreakthroughTable({ items }: { items: ProductBreakthroughResult[] }) {
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [sort, setSort] = useState<SortState>({ key: "score", direction: "desc" });
  const lifecycles = useMemo(() => unique(items.map((item) => item.lifecycle)), [items]);
  const grades = useMemo(() => unique(items.map((item) => item.grade)), [items]);
  const failedDimensions = useMemo(
    () =>
      unique(
        items.flatMap((item) =>
          item.dimensions
            .filter((dimension) => dimension.available !== false && !dimension.passed)
            .map((dimension) => dimension.label)
        )
      ),
    [items]
  );
  const visibleItems = useMemo(
    () =>
      items
        .filter((item) => {
          const failed = item.dimensions
            .filter((dimension) => dimension.available !== false && !dimension.passed)
            .map((dimension) => dimension.label);
          return (
            textMatches([item.productId, item.productCode, item.productName], filters.query) &&
            optionMatches(item.lifecycle, filters.lifecycle) &&
            optionMatches(item.grade, filters.grade) &&
            numberAtLeast(item.score, filters.minScore) &&
            textMatches([item.solutionCode], filters.solutionCode) &&
            (!filters.failedDimension || failed.includes(filters.failedDimension)) &&
            textMatches([item.solution, failed.join("、")], filters.solution)
          );
        })
        .sort((left, right) => compareBreakthroughItems(left, right, sort)),
    [filters, items, sort]
  );

  function update<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function clear<K extends keyof Filters>(key: K) {
    update(key, "");
  }

  function toggleSort(key: SortKey) {
    setSort((current) => {
      if (current.key === key) {
        return { key, direction: current.direction === "asc" ? "desc" : "asc" };
      }
      return { key, direction: textSortKeys.has(key) ? "asc" : "desc" };
    });
  }

  function sortDirection(key: SortKey) {
    return sort.key === key ? sort.direction : null;
  }

  return (
    <section className="table-panel">
      <div className="panel-toolbar">
        <div>
          <strong>商品诊断结果</strong>
          <span>1 为达到样本中位线，0 为未达，— 为缺源；评分只在可用维度内计算，不代表行业绝对健康</span>
        </div>
        <span className="table-count">
          筛选后 {visibleItems.length} / {items.length} 个商品
        </span>
      </div>
      <div className="table-wrap">
        <table className="breakthrough-table">
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
                    <span>商品ID/编码/名称</span>
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
                <TableHeaderFilter
                  label="通过数"
                  active={Boolean(filters.minScore)}
                  onClear={() => clear("minScore")}
                  onSort={() => toggleSort("score")}
                  sortDirection={sortDirection("score")}
                >
                  <label>
                    <span>最低评分</span>
                    <input
                      type="number"
                      min={0}
                      max={8}
                      value={filters.minScore}
                      onChange={(event) => update("minScore", event.target.value)}
                    />
                  </label>
                </TableHeaderFilter>
              </th>
              <th>
                <TableHeaderFilter
                  label="证据编码"
                  active={Boolean(filters.solutionCode)}
                  onClear={() => clear("solutionCode")}
                  onSort={() => toggleSort("solutionCode")}
                  sortDirection={sortDirection("solutionCode")}
                >
                  <label>
                    <span>编码包含</span>
                    <input value={filters.solutionCode} onChange={(event) => update("solutionCode", event.target.value)} />
                  </label>
                </TableHeaderFilter>
              </th>
              <th>
                <TableHeaderFilter
                  label="待优化项"
                  active={Boolean(filters.failedDimension)}
                  onClear={() => clear("failedDimension")}
                  onSort={() => toggleSort("failedDimension")}
                  sortDirection={sortDirection("failedDimension")}
                >
                  <label>
                    <span>待优化项</span>
                    <select
                      value={filters.failedDimension}
                      onChange={(event) => update("failedDimension", event.target.value)}
                    >
                      <option value="">全部</option>
                      {failedDimensions.map((dimension) => (
                        <option key={dimension} value={dimension}>
                          {dimension}
                        </option>
                      ))}
                    </select>
                  </label>
                </TableHeaderFilter>
              </th>
              <th>
                <TableHeaderFilter
                  label="解决方案"
                  active={Boolean(filters.solution)}
                  onClear={() => clear("solution")}
                  onSort={() => toggleSort("solution")}
                  sortDirection={sortDirection("solution")}
                  align="right"
                >
                  <label>
                    <span>方案关键字</span>
                    <input value={filters.solution} onChange={(event) => update("solution", event.target.value)} />
                  </label>
                </TableHeaderFilter>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty-table-cell">
                  暂无诊断数据，请先导入源数据并运行算法。
                </td>
              </tr>
            ) : visibleItems.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty-table-cell">
                  当前筛选条件下暂无商品。
                </td>
              </tr>
            ) : (
              visibleItems.map((item) => {
                const failedDimensionsForItem = item.dimensions
                  .filter((dimension) => dimension.available !== false && !dimension.passed)
                  .map((dimension) => dimension.label);
                const unavailableDimensions = item.dimensions
                  .filter((dimension) => dimension.available === false)
                  .map((dimension) => dimension.label);
                const availableCount = item.dimensions.length - unavailableDimensions.length;
                const passRate = availableCount > 0 ? item.score / availableCount : null;
                return (
                  <tr key={item.productId}>
                    <td>
                      <CopyIdentifier label="商品ID" value={item.productId} />
                      <span>{item.productName}</span>
                    </td>
                    <td>{item.lifecycle}</td>
                    <td>{item.grade}</td>
                    <td>
                      <StatusPill tone={passRate === null ? "neutral" : passRate >= 0.7 ? "good" : passRate >= 0.4 ? "warn" : "bad"}>
                        {passRate === null ? "待补数据" : `${formatNumber(item.score)} / ${availableCount}`}
                      </StatusPill>
                    </td>
                    <td className="code-cell">{displaySolutionCode(item)}</td>
                    <td>
                      {failedDimensionsForItem.length > 0 ? failedDimensionsForItem.join("、") : "无已证实短板"}
                      {unavailableDimensions.length > 0 ? `；待补：${unavailableDimensions.join("、")}` : ""}
                    </td>
                    <td>{item.solution}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function textMatches(values: string[], raw: string) {
  const query = raw.trim().toLowerCase();
  return query.length === 0 || values.some((value) => value.toLowerCase().includes(query));
}

function optionMatches(actual: string, expected: string) {
  return !expected || actual === expected;
}

function numberAtLeast(actual: number, raw: string) {
  if (!raw.trim()) return true;
  const value = Number(raw);
  return !Number.isFinite(value) || actual >= value;
}

function compareBreakthroughItems(left: ProductBreakthroughResult, right: ProductBreakthroughResult, sort: SortState) {
  const direction = sort.direction === "asc" ? 1 : -1;
  if (textSortKeys.has(sort.key)) {
    return (
      direction *
      String(breakthroughSortValue(left, sort.key)).localeCompare(String(breakthroughSortValue(right, sort.key)), "zh-CN")
    );
  }
  return direction * (Number(breakthroughSortValue(left, sort.key)) - Number(breakthroughSortValue(right, sort.key)));
}

function breakthroughSortValue(item: ProductBreakthroughResult, key: SortKey) {
  if (key === "product") return `${item.productName} ${item.productId}`;
  if (key === "failedDimension") {
    return item.dimensions
      .filter((dimension) => dimension.available !== false && !dimension.passed)
      .map((dimension) => dimension.label)
      .join("、");
  }
  return item[key];
}

function displaySolutionCode(item: ProductBreakthroughResult) {
  return item.dimensions
    .map((dimension) => dimension.available === false ? "—" : dimension.passed ? "1" : "0")
    .join("");
}
