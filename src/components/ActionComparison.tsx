"use client";

import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { DailyTrendChart } from "@/components/DailyTrendChart";
import { MetricCard, deltaCell, deltaPctLabel } from "@/components/comparison-ui";
import type {
  AudienceComparison,
  Intervention,
  InterventionComparison,
  ProductComparison
} from "@/lib/types/domain";

type View = "overview" | "product" | "audience";

/**
 * 优化动作前后对比（可嵌入综合看板/单品突破/人群计划）。
 * 自带动作选择 + 前后窗调节；view 决定展示哪种视角。
 */
export function ActionComparison({ view }: { view: View }) {
  const [interventions, setInterventions] = useState<Intervention[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [beforeDays, setBeforeDays] = useState(7);
  const [afterDays, setAfterDays] = useState(7);
  const [overview, setOverview] = useState<InterventionComparison | null>(null);
  const [product, setProduct] = useState<ProductComparison | null>(null);
  const [audience, setAudience] = useState<AudienceComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadedList, setLoadedList] = useState(false);
  const reqRef = useRef(0); // 最新请求序号：丢弃过期响应（防快速切换竞态）

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/interventions");
        if (!res.ok) throw new Error(`加载动作列表失败 (${res.status})`);
        const payload = (await res.json()) as { data?: { interventions: Intervention[] } };
        const list = payload.data?.interventions ?? [];
        if (!alive) return;
        setInterventions(list);
        setLoadedList(true);
        if (list[0]) {
          setSelectedId(list[0].id);
          void load(list[0].id, 7, 7);
        }
      } catch (e) {
        if (alive) {
          setLoadedList(true);
          setError(e instanceof Error ? e.message : "加载失败");
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(id: string, before = beforeDays, after = afterDays) {
    if (!id) return;
    const reqId = ++reqRef.current;
    setBusy(true);
    setError("");
    setOverview(null);
    setProduct(null);
    setAudience(null);
    try {
      const res = await fetch(
        `/api/interventions/${id}/comparison?view=${view}&before=${before}&after=${after}`
      );
      const payload = (await res.json().catch(() => null)) as
        | {
            data?: {
              comparison?: InterventionComparison;
              product?: ProductComparison;
              audience?: AudienceComparison;
            };
            error?: string;
          }
        | null;
      if (reqId !== reqRef.current) return; // 已有更新的请求，丢弃本次过期响应
      if (!res.ok) {
        setError(payload?.error ?? `加载对比失败 (${res.status})`);
        return;
      }
      if (payload?.data?.comparison) setOverview(payload.data.comparison);
      if (payload?.data?.product) setProduct(payload.data.product);
      if (payload?.data?.audience) setAudience(payload.data.audience);
    } catch {
      if (reqId === reqRef.current) setError("网络错误，请重试");
    } finally {
      if (reqId === reqRef.current) setBusy(false);
    }
  }

  if (loadedList && interventions.length === 0) {
    return (
      <section className="table-panel action-comparison">
        <div className="panel-toolbar">
          <div>
            <strong>优化动作前后对比</strong>
            <span>到「数据导入」页标记一次调整后，这里就能看到动作前后的数据变化。</span>
          </div>
        </div>
      </section>
    );
  }

  const win = overview?.window ?? product?.window ?? audience?.window ?? null;

  return (
    <section className="table-panel action-comparison">
      <div className="panel-toolbar action-comparison-bar">
        <div>
          <strong>优化动作前后对比</strong>
          <span>选择一个动作，查看它前后的数据变化（动作当天计入后窗）。</span>
        </div>
        <div className="action-comparison-controls">
          <select value={selectedId} onChange={(e) => { setSelectedId(e.target.value); void load(e.target.value); }}>
            {interventions.map((iv) => (
              <option key={iv.id} value={iv.id}>
                {iv.date}　{iv.title}
              </option>
            ))}
          </select>
          <label>
            前
            <input type="number" min={1} max={90} value={beforeDays}
              onChange={(e) => setBeforeDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))} />
          </label>
          <label>
            后
            <input type="number" min={1} max={90} value={afterDays}
              onChange={(e) => setAfterDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))} />
          </label>
          <button type="button" onClick={() => load(selectedId, beforeDays, afterDays)} disabled={busy || !selectedId}>
            {busy ? "计算中…" : "应用"}
          </button>
        </div>
      </div>

      {error ? <p className="merge-line error" style={{ padding: "0 18px" }}>{error}</p> : null}

      {win ? (
        <p className="review-window-note">
          前窗 {win.beforeStart} ~ {win.beforeEnd}　·　后窗 {win.afterStart} ~ {win.afterEnd}
        </p>
      ) : null}

      {view === "overview" && overview ? (
        <div className="action-comparison-body">
          <div className="review-metric-grid">
            {overview.lensA.metrics.map((m) => (
              <MetricCard key={m.key} m={m} />
            ))}
          </div>
          <DailyTrendChart series={overview.lensC.series} interventionDate={overview.lensC.interventionDate} />
        </div>
      ) : null}

      {view === "product" && product ? (
        <ComparisonTable
          empty={product.rows.length === 0 ? "受影响商品在该区间暂无分日数据。" : null}
          head={["商品", "日均净销额", "支付转化率", "客单价"]}
          rows={product.rows.map((r) => ({
            key: r.productId,
            label: r.productId,
            sub: r.productName,
            cells: [
              deltaCell(r.netBefore, r.netAfter, "money", true),
              deltaCell(r.convBefore, r.convAfter, "rate", true),
              deltaCell(r.aovBefore, r.aovAfter, "money", true)
            ],
            deltaLabel: deltaPctLabel(r.netBefore, r.netAfter, r.netDeltaPct),
            deltaUp: r.netAfter >= r.netBefore
          }))}
        />
      ) : null}

      {view === "audience" && audience ? (
        <ComparisonTable
          empty={audience.rows.length === 0 ? "该区间暂无人群分日数据。" : null}
          head={["计划 · 人群", "日均点击", "ROI"]}
          rows={audience.rows.map((r) => ({
            key: r.key,
            label: r.audienceName,
            sub: `${r.planName} · ${r.subjectName}`,
            cells: [
              deltaCell(r.clicksBefore, r.clicksAfter, "int", true),
              deltaCell(r.roiBefore, r.roiAfter, "ratio", true)
            ],
            deltaLabel: deltaPctLabel(r.clicksBefore, r.clicksAfter, r.clicksDeltaPct),
            deltaUp: r.clicksAfter >= r.clicksBefore
          }))}
        />
      ) : null}

      {busy && !overview && !product && !audience ? <p className="review-empty">计算中…</p> : null}
    </section>
  );
}

interface Cell {
  before: string;
  after: string;
  tone: "good" | "bad" | "flat";
}

function ComparisonTable({
  head,
  rows,
  empty
}: {
  head: string[];
  rows: { key: string; label: string; sub: string; cells: Cell[]; deltaLabel: string; deltaUp: boolean }[];
  empty: string | null;
}) {
  if (empty) return <p className="review-empty">{empty}</p>;
  return (
    <div className="table-wrap">
      <table className="comparison-table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
            <th>主指标变化</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>
                <strong>{r.label}</strong>
                <span>{r.sub}</span>
              </td>
              {r.cells.map((c, i) => (
                <td key={i}>
                  <span className="cmp-cell">
                    {c.before} → <strong className={`cmp-${c.tone}`}>{c.after}</strong>
                  </span>
                </td>
              ))}
              <td>
                <span className={clsx("cmp-deltapct", r.deltaUp ? "cmp-good" : "cmp-bad")}>{r.deltaLabel}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
