"use client";

import clsx from "clsx";
import { useMemo, useState } from "react";
import { KpiBoard } from "@/components/KpiBoard";
import { TableHeaderFilter } from "@/components/TableHeaderFilter";
import { aggregateManagementDashboard } from "@/lib/management-aggregation";
import { formatMoney, formatPercent } from "@/lib/format";
import type { ManagementDashboard, ProductInvestmentResult, ProductTag } from "@/lib/types/domain";

interface TagGroup {
  tag: ProductTag;
  results: ProductInvestmentResult[];
  dashboard: ManagementDashboard;
}

type SortKey =
  | "tag"
  | "productCount"
  | "monthlyNetSales"
  | "monthlyProfitEstimate"
  | "monthlyGsvOpportunity"
  | "availableAdBudget"
  | "historicalMarginRate"
  | "plannedMarginRate";

type SortState = { key: SortKey; direction: "asc" | "desc" } | null;

export function ProductTagDashboard({
  tags,
  results,
  analysisPeriod
}: {
  tags: ProductTag[];
  results: ProductInvestmentResult[];
  analysisPeriod?: { start: string; end: string };
}) {
  const [filters, setFilters] = useState({
    tag: "",
    minProducts: "",
    minNetSales: "",
    minGsv: "",
    minBudget: "",
    minMargin: ""
  });
  const [sort, setSort] = useState<SortState>(null);
  const groups = useMemo<TagGroup[]>(
    () =>
      tags.map((tag) => {
        const tagResults = results.filter((item) => (item.tagIds ?? []).includes(tag.id));
        return {
          tag,
          results: tagResults,
          dashboard: { ...aggregateManagementDashboard(tagResults), analysisPeriod }
        };
      }),
    [analysisPeriod, results, tags]
  );
  const filteredGroups = useMemo(
    () =>
      groups.filter(
        (group) =>
          textMatches(group.tag.name, filters.tag) &&
          numberAtLeast(group.dashboard.productCount, filters.minProducts) &&
          numberAtLeast(group.dashboard.monthlyNetSales, filters.minNetSales) &&
          numberAtLeast(group.dashboard.monthlyGsvOpportunity, filters.minGsv) &&
          numberAtLeast(group.dashboard.availableAdBudget, filters.minBudget) &&
          percentAtLeast(group.dashboard.historicalMarginRate, filters.minMargin)
      ).sort((left, right) => compareTagGroups(left, right, sort)),
    [filters, groups, sort]
  );
  const [selectedTagId, setSelectedTagId] = useState<string>(() => groups.find((group) => group.results.length > 0)?.tag.id ?? tags[0]?.id ?? "");
  const selected =
    filteredGroups.find((group) => group.tag.id === selectedTagId) ??
    filteredGroups.find((group) => group.results.length > 0) ??
    filteredGroups[0];

  function updateFilter(key: keyof typeof filters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function toggleSort(key: SortKey) {
    setSort((current) => {
      if (current?.key === key) {
        return { key, direction: current.direction === "asc" ? "desc" : "asc" };
      }
      return { key, direction: key === "tag" ? "asc" : "desc" };
    });
  }

  function sortDirection(key: SortKey) {
    return sort?.key === key ? sort.direction : null;
  }

  if (tags.length === 0) {
    return (
      <section className="table-panel tag-dashboard" aria-label="自定义分类看数">
        <div className="panel-toolbar">
          <div>
            <strong>自定义分类看数</strong>
            <span>预填写表里的看数分类为选填项；未分类商品仍参与整店计算。</span>
          </div>
        </div>
        <p className="kpi-drill-empty">暂无看数分类。</p>
      </section>
    );
  }

  return (
    <section className="tag-dashboard" aria-label="自定义分类看数">
      <div className="panel-toolbar tag-dashboard-head">
        <div>
          <strong>自定义分类看数</strong>
          <span>按预填写表里的看数分类聚合；金额做加总，费率按分子/分母重新加权计算。</span>
        </div>
        <span className="table-count">
          筛选后 {filteredGroups.length} / {groups.length} 个类别
        </span>
      </div>

      <div className="table-wrap tag-summary-wrap">
        <table>
          <thead>
            <tr>
              <th>
                <TableHeaderFilter
                  label="类别"
                  active={Boolean(filters.tag)}
                  onClear={() => updateFilter("tag", "")}
                  onSort={() => toggleSort("tag")}
                  sortDirection={sortDirection("tag")}
                >
                  <label>
                    <span>类别关键字</span>
                    <input value={filters.tag} onChange={(event) => updateFilter("tag", event.target.value)} />
                  </label>
                </TableHeaderFilter>
              </th>
              <th>
                <TableHeaderFilter
                  label="商品数"
                  active={Boolean(filters.minProducts)}
                  onClear={() => updateFilter("minProducts", "")}
                  onSort={() => toggleSort("productCount")}
                  sortDirection={sortDirection("productCount")}
                >
                  <label>
                    <span>最少商品数</span>
                    <input
                      type="number"
                      min={0}
                      value={filters.minProducts}
                      onChange={(event) => updateFilter("minProducts", event.target.value)}
                    />
                  </label>
                </TableHeaderFilter>
              </th>
              <th>
                <TableHeaderFilter
                  label="分析窗去退销售额"
                  active={Boolean(filters.minNetSales)}
                  onClear={() => updateFilter("minNetSales", "")}
                  onSort={() => toggleSort("monthlyNetSales")}
                  sortDirection={sortDirection("monthlyNetSales")}
                >
                  <label>
                    <span>最小值</span>
                    <input
                      type="number"
                      value={filters.minNetSales}
                      onChange={(event) => updateFilter("minNetSales", event.target.value)}
                    />
                  </label>
                </TableHeaderFilter>
              </th>
              <th>
                <TableHeaderFilter
                  label="分析窗贡献利润估算"
                  onSort={() => toggleSort("monthlyProfitEstimate")}
                  sortDirection={sortDirection("monthlyProfitEstimate")}
                />
              </th>
              <th>
                <TableHeaderFilter
                  label="月GSV机会"
                  active={Boolean(filters.minGsv)}
                  onClear={() => updateFilter("minGsv", "")}
                  onSort={() => toggleSort("monthlyGsvOpportunity")}
                  sortDirection={sortDirection("monthlyGsvOpportunity")}
                >
                  <label>
                    <span>最小值</span>
                    <input type="number" value={filters.minGsv} onChange={(event) => updateFilter("minGsv", event.target.value)} />
                  </label>
                </TableHeaderFilter>
              </th>
              <th>
                <TableHeaderFilter
                  label="静态利润安全垫（非预算）"
                  active={Boolean(filters.minBudget)}
                  onClear={() => updateFilter("minBudget", "")}
                  onSort={() => toggleSort("availableAdBudget")}
                  sortDirection={sortDirection("availableAdBudget")}
                >
                  <label>
                    <span>最小值</span>
                    <input
                      type="number"
                      value={filters.minBudget}
                      onChange={(event) => updateFilter("minBudget", event.target.value)}
                    />
                  </label>
                </TableHeaderFilter>
              </th>
              <th>
                <TableHeaderFilter
                  label="历史利润率"
                  active={Boolean(filters.minMargin)}
                  onClear={() => updateFilter("minMargin", "")}
                  onSort={() => toggleSort("historicalMarginRate")}
                  sortDirection={sortDirection("historicalMarginRate")}
                  align="right"
                >
                  <label>
                    <span>最低利润率（%）</span>
                    <input
                      type="number"
                      value={filters.minMargin}
                      onChange={(event) => updateFilter("minMargin", event.target.value)}
                    />
                  </label>
                </TableHeaderFilter>
              </th>
              <th>
                <TableHeaderFilter
                  label="预留毛利率"
                  onSort={() => toggleSort("plannedMarginRate")}
                  sortDirection={sortDirection("plannedMarginRate")}
                  align="right"
                />
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredGroups.length === 0 ? (
              <tr>
                <td colSpan={8} className="empty-table-cell">
                  当前筛选条件下暂无类别。
                </td>
              </tr>
            ) : (
              filteredGroups.map((group) => {
              const dashboard = group.dashboard;
              return (
                <tr
                  key={group.tag.id}
                  className={clsx(selected?.tag.id === group.tag.id && "row-selected")}
                  onClick={() => setSelectedTagId(group.tag.id)}
                >
                  <td>
                    <button type="button" className="tag-row-button" onClick={() => setSelectedTagId(group.tag.id)}>
                      {group.tag.name}
                    </button>
                  </td>
                  <td>{dashboard.productCount}</td>
                  <td>{formatMoney(dashboard.monthlyNetSales, 1)}</td>
                  <td>{formatMoney(dashboard.monthlyProfitEstimate, 1)}</td>
                  <td>{formatMoney(dashboard.monthlyGsvOpportunity, 1)}</td>
                  <td>{formatMoney(dashboard.availableAdBudget, 1)}</td>
                  <td>{formatPercent(dashboard.historicalMarginRate, 1)}</td>
                  <td>{formatPercent(dashboard.plannedMarginRate, 1)}</td>
                </tr>
              );
              })
            )}
          </tbody>
        </table>
      </div>

      {selected ? (
        <div className="tag-kpi-detail">
          <div className="tag-kpi-title">
            <strong>类别「{selected.tag.name}」下钻</strong>
            <span>{selected.results.length} 个已参与计算的商品；使用与整店看板一致的合并口径。</span>
          </div>
          <KpiBoard
            dashboard={selected.dashboard}
            results={selected.results}
            trendSeries={[]}
            scopeName={`类别「${selected.tag.name}」`}
          />
        </div>
      ) : null}
    </section>
  );
}

function textMatches(value: string, raw: string) {
  const query = raw.trim().toLowerCase();
  return query.length === 0 || value.toLowerCase().includes(query);
}

function numberAtLeast(actual: number | null, raw: string) {
  if (!raw.trim()) return true;
  const value = Number(raw);
  return !Number.isFinite(value) || (actual !== null && actual >= value);
}

/** actual 为 null（该标签组下无证据完整商品，利润率无法计算）时不参与"至少"筛选，直接排除。 */
function percentAtLeast(actual: number | null, raw: string) {
  if (!raw.trim()) return true;
  const value = Number(raw);
  if (!Number.isFinite(value)) return true;
  return actual !== null && actual >= value / 100;
}

function compareTagGroups(left: TagGroup, right: TagGroup, sort: SortState) {
  if (!sort) return 0;
  const direction = sort.direction === "asc" ? 1 : -1;
  if (sort.key === "tag") {
    return direction * left.tag.name.localeCompare(right.tag.name, "zh-CN");
  }
  return direction * (tagSortValue(left, sort.key) - tagSortValue(right, sort.key));
}

function tagSortValue(group: TagGroup, key: Exclude<SortKey, "tag">): number {
  if (key === "productCount") return group.dashboard.productCount;
  // 无法计算的利润率（null）排序时沉底，不能当作 0 混进正常值中间。
  return group.dashboard[key] ?? Number.NEGATIVE_INFINITY;
}
