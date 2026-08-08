"use client";

import { useMemo, useState } from "react";
import { StatusPill } from "@/components/StatusPill";
import { TableHeaderFilter } from "@/components/TableHeaderFilter";
import {
  audiencePlanOrder,
  groupAudiencePlans
} from "@/lib/audience-plan-view";
import { formatNumber, formatPercent } from "@/lib/format";
import type { AudiencePlanItem } from "@/lib/types/domain";

type SortKey = "plan" | "planId" | "audience" | "subject" | "clicks" | "roi" | "guided" | "new";
type SortState = { key: SortKey; direction: "asc" | "desc" };

const textSortKeys = new Set<SortKey>(["plan", "planId", "audience", "subject"]);
const sortLabels: Record<SortKey, string> = {
  plan: "计划",
  planId: "计划ID",
  audience: "人群",
  subject: "主体商品",
  clicks: "点击量",
  roi: "报表ROI代理",
  guided: "引潜占比",
  new: "新客占比"
};

export function AudiencePlanTable({
  items,
  serverMinClicks = 0
}: {
  items: AudiencePlanItem[];
  serverMinClicks?: number;
}) {
  const [filters, setFilters] = useState({
    plan: "",
    planId: "",
    audience: "",
    subject: "",
    minimumClicks: String(serverMinClicks || 100),
    minRoi: "",
    minGuided: "",
    minNew: ""
  });
  const [sort, setSort] = useState<SortState>({ key: "roi", direction: "desc" });
  const [allItems, setAllItems] = useState<AudiencePlanItem[] | null>(null);
  const [loadingAll, setLoadingAll] = useState(false);
  // 首屏只拿到点击≥serverMinClicks 的精简集；需要看低点击计划时一键拉全量。
  const trimmed = serverMinClicks > 0 && allItems === null;
  const effectiveItems = allItems ?? items;
  const grouped = useMemo(() => groupAudiencePlans(effectiveItems), [effectiveItems]);
  const minimumClicks = numericFilterValue(filters.minimumClicks);

  function updateFilter(key: keyof typeof filters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
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

  async function loadAll() {
    setLoadingAll(true);
    try {
      const res = await fetch("/api/dashboards/audience-plan");
      const json = (await res.json().catch(() => null)) as
        | { data?: { items?: AudiencePlanItem[] } }
        | null;
      if (json?.data?.items) {
        setAllItems(json.data.items);
      }
    } finally {
      setLoadingAll(false);
    }
  }

  return (
    <>
      <section className="section-band audience-filter-panel">
        <b>
          排序：{sortLabels[sort.key]} {sort.direction === "asc" ? "升序" : "降序"}
        </b>
        {trimmed ? (
          <span className="audience-trim-hint">
            已精简：仅显示点击 ≥ {serverMinClicks} 的计划
            <button type="button" onClick={loadAll} disabled={loadingAll}>
              {loadingAll ? "加载中…" : "加载全部计划"}
            </button>
          </span>
        ) : null}
      </section>

      <section className="audience-stack">
        {audiencePlanOrder.map((type) => {
          const rawItems = grouped[type] ?? [];
          const visibleItems = rawItems
            .filter(
              (item) =>
                (item.clicks ?? 0) >= minimumClicks &&
                textMatches([item.planName, item.sceneName], filters.plan) &&
                textMatches([item.planId], filters.planId) &&
                textMatches([item.audienceName], filters.audience) &&
                textMatches([item.subjectName], filters.subject) &&
                numberAtLeast(item.roi, filters.minRoi) &&
                percentAtLeast(item.guidedPotentialCustomerRatio, filters.minGuided) &&
                percentAtLeast(item.newCustomerRatio, filters.minNew)
            )
            .sort((left, right) => compareAudiencePlans(left, right, sort));
          return (
            <section className="section-band audience-section" key={type}>
              <div className="section-title">
                <h2>{type}计划</h2>
                <StatusPill tone={type === "拉新" ? "good" : type === "追投" ? "warn" : "neutral"}>
                  {visibleItems.length} / {rawItems.length} 条
                </StatusPill>
              </div>
              <div className="table-wrap audience-table-wrap">
                <table className="audience-plan-table" aria-label={`${type}计划列表`}>
                  <thead>
                    <tr>
                      <th>
                        <TableHeaderFilter
                          label="计划"
                          active={Boolean(filters.plan)}
                          onClear={() => updateFilter("plan", "")}
                          onSort={() => toggleSort("plan")}
                          sortDirection={sortDirection("plan")}
                        >
                          <label>
                            <span>计划/场景关键字</span>
                            <input value={filters.plan} onChange={(event) => updateFilter("plan", event.target.value)} />
                          </label>
                        </TableHeaderFilter>
                      </th>
                      <th>
                        <TableHeaderFilter
                          label="计划ID"
                          active={Boolean(filters.planId)}
                          onClear={() => updateFilter("planId", "")}
                          onSort={() => toggleSort("planId")}
                          sortDirection={sortDirection("planId")}
                        >
                          <label>
                            <span>ID 包含</span>
                            <input value={filters.planId} onChange={(event) => updateFilter("planId", event.target.value)} />
                          </label>
                        </TableHeaderFilter>
                      </th>
                      <th>
                        <TableHeaderFilter
                          label="人群"
                          active={Boolean(filters.audience)}
                          onClear={() => updateFilter("audience", "")}
                          onSort={() => toggleSort("audience")}
                          sortDirection={sortDirection("audience")}
                        >
                          <label>
                            <span>人群关键字</span>
                            <input
                              value={filters.audience}
                              onChange={(event) => updateFilter("audience", event.target.value)}
                            />
                          </label>
                        </TableHeaderFilter>
                      </th>
                      <th>
                        <TableHeaderFilter
                          label="主体商品"
                          active={Boolean(filters.subject)}
                          onClear={() => updateFilter("subject", "")}
                          onSort={() => toggleSort("subject")}
                          sortDirection={sortDirection("subject")}
                        >
                          <label>
                            <span>商品关键字</span>
                            <input
                              value={filters.subject}
                              onChange={(event) => updateFilter("subject", event.target.value)}
                            />
                          </label>
                        </TableHeaderFilter>
                      </th>
                      <th>
                        <TableHeaderFilter
                          label="点击量"
                          active={minimumClicks > 0}
                          onClear={() => updateFilter("minimumClicks", "")}
                          onSort={() => toggleSort("clicks")}
                          sortDirection={sortDirection("clicks")}
                        >
                          <label>
                            <span>最低点击量</span>
                            <input
                              type="number"
                              min={0}
                              step={10}
                              value={filters.minimumClicks}
                              onChange={(event) => updateFilter("minimumClicks", event.target.value)}
                            />
                          </label>
                        </TableHeaderFilter>
                      </th>
                      <th>
                        <TableHeaderFilter
                          label="报表ROI代理"
                          active={Boolean(filters.minRoi)}
                          onClear={() => updateFilter("minRoi", "")}
                          onSort={() => toggleSort("roi")}
                          sortDirection={sortDirection("roi")}
                        >
                          <label>
                            <span>最低报表 ROI 代理</span>
                            <input
                              type="number"
                              value={filters.minRoi}
                              onChange={(event) => updateFilter("minRoi", event.target.value)}
                            />
                          </label>
                        </TableHeaderFilter>
                      </th>
                      <th>
                        <TableHeaderFilter
                          label="引潜占比"
                          active={Boolean(filters.minGuided)}
                          onClear={() => updateFilter("minGuided", "")}
                          onSort={() => toggleSort("guided")}
                          sortDirection={sortDirection("guided")}
                        >
                          <label>
                            <span>最低占比（%）</span>
                            <input
                              type="number"
                              value={filters.minGuided}
                              onChange={(event) => updateFilter("minGuided", event.target.value)}
                            />
                          </label>
                        </TableHeaderFilter>
                      </th>
                      <th>
                        <TableHeaderFilter
                          label="新客占比"
                          active={Boolean(filters.minNew)}
                          onClear={() => updateFilter("minNew", "")}
                          onSort={() => toggleSort("new")}
                          sortDirection={sortDirection("new")}
                          align="right"
                        >
                          <label>
                            <span>最低占比（%）</span>
                            <input
                              type="number"
                              value={filters.minNew}
                              onChange={(event) => updateFilter("minNew", event.target.value)}
                            />
                          </label>
                        </TableHeaderFilter>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleItems.length > 0 ? (
                      visibleItems.map((item, i) => (
                        <tr key={`${type}-${item.planId}-${item.audienceName}-${item.subjectName}-${i}`}>
                          <td>
                            <strong>{item.planName}</strong>
                            <span>{item.sceneName}</span>
                          </td>
                          <td className="code-cell">{item.planId}</td>
                          <td>{item.audienceName}</td>
                          <td>{item.subjectName}</td>
                          <td>{formatNumber(item.clicks)}</td>
                          <td>{formatNumber(item.roi, 2)}</td>
                          <td>{formatPercent(item.guidedPotentialCustomerRatio, 1)}</td>
                          <td>{formatPercent(item.newCustomerRatio, 1)}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={8} className="empty-table-cell">
                          当前点击量门槛下暂无计划
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}
      </section>
    </>
  );
}

function textMatches(values: string[], raw: string) {
  const query = raw.trim().toLowerCase();
  return query.length === 0 || values.some((value) => value.toLowerCase().includes(query));
}

function numericFilterValue(raw: string) {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
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

function compareAudiencePlans(left: AudiencePlanItem, right: AudiencePlanItem, sort: SortState) {
  const direction = sort.direction === "asc" ? 1 : -1;
  if (textSortKeys.has(sort.key)) {
    return direction * String(audienceSortValue(left, sort.key)).localeCompare(String(audienceSortValue(right, sort.key)), "zh-CN");
  }
  const leftValue = audienceSortValue(left, sort.key);
  const rightValue = audienceSortValue(right, sort.key);
  return direction * ((typeof leftValue === "number" ? leftValue : Number.NEGATIVE_INFINITY) -
    (typeof rightValue === "number" ? rightValue : Number.NEGATIVE_INFINITY));
}

function audienceSortValue(item: AudiencePlanItem, key: SortKey) {
  if (key === "plan") return `${item.planName} ${item.sceneName}`;
  if (key === "planId") return item.planId;
  if (key === "audience") return item.audienceName;
  if (key === "subject") return item.subjectName;
  if (key === "guided") return item.guidedPotentialCustomerRatio;
  if (key === "new") return item.newCustomerRatio;
  return item[key];
}
