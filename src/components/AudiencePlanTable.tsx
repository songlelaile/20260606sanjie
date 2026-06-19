"use client";

import { Filter } from "lucide-react";
import { useMemo, useState } from "react";
import { StatusPill } from "@/components/StatusPill";
import {
  audiencePlanOrder,
  filterAndSortAudiencePlans,
  groupAudiencePlans
} from "@/lib/audience-plan-view";
import { formatNumber, formatPercent } from "@/lib/format";
import type { AudiencePlanItem } from "@/lib/types/domain";

export function AudiencePlanTable({ items }: { items: AudiencePlanItem[] }) {
  const [minimumClicks, setMinimumClicks] = useState(100);
  const grouped = useMemo(() => groupAudiencePlans(items), [items]);

  return (
    <>
      <section className="section-band audience-filter-panel">
        <label>
          <span>
            <Filter size={16} />
            点击量门槛
          </span>
          <input
            type="number"
            min={0}
            step={10}
            value={minimumClicks}
            onChange={(event) => setMinimumClicks(Number(event.target.value))}
            aria-label="点击量筛选门槛"
          />
        </label>
        <b>按 ROI 降序</b>
      </section>

      <section className="audience-stack">
        {audiencePlanOrder.map((type) => {
          const rawItems = grouped[type] ?? [];
          const visibleItems = filterAndSortAudiencePlans(rawItems, minimumClicks);
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
                      <th>计划</th>
                      <th>计划ID</th>
                      <th>人群</th>
                      <th>主体商品</th>
                      <th>点击量</th>
                      <th>ROI</th>
                      <th>引潜占比</th>
                      <th>新客占比</th>
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
