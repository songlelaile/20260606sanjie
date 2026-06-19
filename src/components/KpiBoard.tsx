"use client";

import clsx from "clsx";
import { useMemo, useState } from "react";
import { DailyTrendChart } from "@/components/DailyTrendChart";
import { formatNumber, formatPercent } from "@/lib/format";
import type {
  DailyTrendPoint,
  Lifecycle,
  ManagementDashboard,
  ProductGrade,
  ProductInvestmentResult
} from "@/lib/types/domain";

type Unit = "money" | "rate" | "int";
type ViewMode = "rank" | "waterfall" | "pivot" | "plan" | "trend";

interface KpiDef {
  key: string;
  label: (d: ManagementDashboard) => string;
  unit: Unit;
  value: (d: ManagementDashboard) => number;
  tone?: (d: ManagementDashboard) => "good" | "warn" | undefined;
  /** 该 KPI 在每个商品上的贡献值（可加和项）。费率/计数无此项。 */
  perProduct?: (r: ProductInvestmentResult) => number;
  /** 费率型 KPI：由分子/分母加权重算。 */
  rate?: { num: (r: ProductInvestmentResult) => number; den: (r: ProductInvestmentResult) => number };
  formula: string;
}

const KPIS: KpiDef[] = [
  {
    key: "productCount",
    label: () => "商品总数",
    unit: "int",
    value: (d) => d.productCount,
    formula: "纳入三阶计算（评级+毛利率+月GSV机会齐全）的商品数。"
  },
  {
    key: "monthlyNetSales",
    label: () => "月去退销售额",
    unit: "money",
    value: (d) => d.monthlyNetSales,
    perProduct: (r) => r.netSales,
    formula: "Σ 各商品（支付金额 − 退款金额）。"
  },
  {
    key: "monthlyProfitEstimate",
    label: () => "月利润预估",
    unit: "money",
    value: (d) => d.monthlyProfitEstimate,
    perProduct: (r) => r.historicalGrossProfit,
    formula: "Σ 各商品历史毛利（去退销售额 × 毛利率 − 营销消耗）。"
  },
  {
    key: "historicalMarginRate",
    label: () => "历史利润率",
    unit: "rate",
    value: (d) => d.historicalMarginRate,
    rate: { num: (r) => r.historicalGrossProfit, den: (r) => r.netSales },
    formula: "月利润预估 ÷ 月去退销售额。"
  },
  {
    key: "monthlyGsvOpportunity",
    label: () => "月GSV机会",
    unit: "money",
    value: (d) => d.monthlyGsvOpportunity,
    perProduct: (r) => r.monthlyGsvOpportunity,
    formula: "Σ 各商品月GSV机会（运营预填的增长目标）。"
  },
  {
    key: "marketSalesGap",
    label: (d) => (d.marketSalesGap < 0 ? "市场销售盈余" : "市场销售缺口"),
    unit: "money",
    value: (d) => Math.abs(d.marketSalesGap),
    tone: (d) => (d.marketSalesGap < 0 ? "good" : "warn"),
    perProduct: (r) => r.salesGap,
    formula: "月去退销售额 − 月GSV机会（逐商品 salesGap 求和；负=实际低于目标）。"
  },
  {
    key: "availableAdBudget",
    label: () => "全店可投费用",
    unit: "money",
    value: (d) => d.availableAdBudget,
    tone: () => "good",
    perProduct: (r) => r.remainingAdBudget,
    formula: "Σ 各商品（历史毛利率 − 攻防毛利率）× 历史毛利 ÷ 历史毛利率。"
  },
  {
    key: "plannedProfit",
    label: () => "增长预留毛利",
    unit: "money",
    value: (d) => d.plannedProfit,
    perProduct: (r) => r.plannedGrossProfit,
    formula: "Σ 攻防毛利率 × 月GSV机会（攻防阶段可为负=愿让利打爆）。"
  },
  {
    key: "plannedMarginRate",
    label: () => "预留毛利率",
    unit: "rate",
    value: (d) => d.plannedMarginRate,
    rate: { num: (r) => r.plannedGrossProfit, den: (r) => r.monthlyGsvOpportunity },
    formula: "增长预留毛利 ÷ 月GSV机会。"
  }
];

const KPI_BY_KEY = new Map(KPIS.map((k) => [k.key, k]));
const GRADES: ProductGrade[] = ["S", "A", "B", "C"];
const LIFECYCLES: Lifecycle[] = ["冷启期", "新品成长期", "成长期", "新品打爆期", "爆品期", "平销期"];

/** 金额紧凑：亿/万。 */
function money(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e8) return `${sign}¥${(abs / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${sign}¥${(abs / 1e4).toFixed(1)}万`;
  return `${sign}¥${Math.round(abs).toLocaleString()}`;
}
function fmtVal(v: number, unit: Unit): string {
  if (unit === "rate") return formatPercent(v, 1);
  if (unit === "int") return formatNumber(v);
  return money(v);
}

function HBar({
  label,
  sub,
  value,
  pct,
  fill,
  negative
}: {
  label: string;
  sub?: string;
  value: string;
  pct: number;
  fill: string;
  negative?: boolean;
}) {
  return (
    <div className="kpi-bar-row">
      <span className="kpi-bar-label" title={label}>
        {label}
        {sub ? <em>{sub}</em> : null}
      </span>
      <div className={clsx("kpi-bar-track", negative && "neg")}>
        <div className="kpi-bar-fill" style={{ width: `${Math.max(1.5, Math.min(100, pct))}%`, background: fill }} />
      </div>
      <span className="kpi-bar-val">{value}</span>
    </div>
  );
}

export function KpiBoard({
  dashboard,
  results,
  trendSeries
}: {
  dashboard: ManagementDashboard;
  results: ProductInvestmentResult[];
  trendSeries: DailyTrendPoint[];
}) {
  const [selected, setSelected] = useState<string>("monthlyNetSales");
  const [view, setView] = useState<ViewMode>("rank");
  const [pivotBy, setPivotBy] = useState<"grade" | "lifecycle">("grade");
  const def = KPI_BY_KEY.get(selected) ?? KPIS[1];
  const empty = results.length === 0;

  // 选 KPI；计数型不适合「贡献排行」，自动切到「评级/周期透视」。
  const selectKpi = (key: string) => {
    setSelected(key);
    if (key === "productCount" && view === "rank") setView("pivot");
  };

  // 瀑布/规划两视图与选中 KPI 无关，标题/说明随视图走，避免「标题是某 KPI、内容却与它无关」的误导。
  const head =
    view === "waterfall"
      ? { title: "盈利构成推导", desc: "把销售→利润→可投费用、目标→缺口串成一条链（与选中 KPI 无关）。" }
      : view === "plan"
        ? { title: "规划 vs 实际达成", desc: "逐商品 月GSV机会(规划) vs 去退销售额(实际) 及达成率（与选中 KPI 无关）。" }
        : view === "trend"
          ? { title: "分日趋势", desc: "整店实际经营指标按天走势（多指标多轴对比），与上方规划 KPI 互为印证。" }
          : { title: def.label(dashboard), desc: def.formula };

  return (
    <section className="kpi-board" aria-label="关键指标与下钻分析">
      <div className="kpi-grid" aria-label="关键指标">
        {KPIS.map((k) => {
          const tone = k.tone?.(dashboard);
          const active = k.key === selected;
          return (
            <button
              key={k.key}
              type="button"
              aria-pressed={active}
              className={clsx("kpi", tone, active && "is-selected")}
              onClick={() => selectKpi(k.key)}
            >
              <span>{k.label(dashboard)}</span>
              <strong>{fmtVal(k.value(dashboard), k.unit)}</strong>
            </button>
          );
        })}
      </div>

      {empty ? (
        <p className="kpi-drill-empty">暂无三阶计算结果，请到「预填写表」填好评级/毛利率/月GSV机会后运行算法。</p>
      ) : (
        <div className="kpi-drill">
          <div className="kpi-drill-head">
            <div>
              <strong>下钻分析 · {head.title}</strong>
              <span>{head.desc}</span>
            </div>
            <div className="kpi-view-tabs">
              {([
                ["rank", "贡献排行"],
                ["waterfall", "盈利构成"],
                ["pivot", "评级/周期透视"],
                ["plan", "规划 vs 实际"],
                ["trend", "分日趋势"]
              ] as [ViewMode, string][]).map(([v, label]) => (
                <button key={v} type="button" className={clsx(view === v && "is-active")} onClick={() => setView(v)}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {view === "rank" ? <RankView def={def} results={results} dashboard={dashboard} /> : null}
          {view === "waterfall" ? <WaterfallView dashboard={dashboard} /> : null}
          {view === "pivot" ? (
            <PivotView def={def} results={results} pivotBy={pivotBy} setPivotBy={setPivotBy} />
          ) : null}
          {view === "plan" ? <PlanView results={results} /> : null}
          {view === "trend" ? (
            trendSeries.length > 0 ? (
              <DailyTrendChart series={trendSeries} />
            ) : (
              <p className="kpi-drill-note">暂无分日数据。</p>
            )
          ) : null}
        </div>
      )}
    </section>
  );
}

/** ① 贡献排行：选中 KPI 的逐商品贡献（可加和取占比；费率/计数特殊处理）。 */
function RankView({
  def,
  results,
  dashboard
}: {
  def: KpiDef;
  results: ProductInvestmentResult[];
  dashboard: ManagementDashboard;
}) {
  if (def.key === "productCount") {
    return <p className="kpi-drill-note">商品总数为计数指标，按评级/周期分布请看「评级/周期透视」。</p>;
  }
  if (def.rate) {
    // 费率：逐商品该费率，按值排序，条宽 ∝ 费率。
    const rows = results
      .map((r) => ({ r, v: def.rate!.den(r) !== 0 ? def.rate!.num(r) / def.rate!.den(r) : 0 }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 15);
    const max = Math.max(...rows.map((x) => Math.abs(x.v)), 1e-9);
    return (
      <div className="kpi-bar-list">
        <p className="kpi-drill-note">逐商品「{def.label(dashboard)}」（整店为加权值 {formatPercent(def.value(dashboard), 1)}），取前 15。</p>
        {rows.map(({ r, v }) => (
          <HBar
            key={r.productId}
            label={r.productName || r.productId}
            sub={`${r.grade} · ${r.lifecycle}`}
            value={formatPercent(v, 1)}
            pct={(Math.abs(v) / max) * 100}
            fill={v < 0 ? "#ef4d4d" : "#7ad17a"}
            negative={v < 0}
          />
        ))}
      </div>
    );
  }
  const get = def.perProduct!;
  const signedTotal = results.reduce((s, r) => s + get(r), 0);
  // 贡献度分母用 Σ|各商品|：避免 total 带符号/正负混合（如 salesGap）时算出反号占比。
  const absTotal = results.reduce((s, r) => s + Math.abs(get(r)), 0);
  const rows = results
    .map((r) => ({ r, v: get(r) }))
    .filter((x) => Math.abs(x.v) > 0)
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
    .slice(0, 15);
  const max = Math.max(...rows.map((x) => Math.abs(x.v)), 1e-9);
  return (
    <div className="kpi-bar-list">
      <p className="kpi-drill-note">
        逐商品贡献（合计 {money(signedTotal)}，取绝对值前 15；占比 = |该商品| ÷ Σ|各商品| 的贡献度）。
      </p>
      {rows.map(({ r, v }) => (
        <HBar
          key={r.productId}
          label={r.productName || r.productId}
          sub={`${r.grade} · ${r.lifecycle}`}
          value={`${money(v)}　${absTotal > 0 ? formatPercent(Math.abs(v) / absTotal, 0) : "—"}`}
          pct={(Math.abs(v) / max) * 100}
          fill={v < 0 ? "#ef4d4d" : "#f6c65f"}
          negative={v < 0}
        />
      ))}
    </div>
  );
}

/** ② 盈利构成：把孤立 KPI 串成 销售→利润→可投费用 与 目标→缺口 的推导链。 */
function WaterfallView({ dashboard }: { dashboard: ManagementDashboard }) {
  const d = dashboard;
  const cost = d.monthlyNetSales - d.monthlyProfitEstimate; // 成本+营销
  const scale = Math.max(d.monthlyGsvOpportunity, d.monthlyNetSales, 1);
  const bar = (label: string, value: number, fill: string, sub?: string) => (
    <HBar key={label} label={label} sub={sub} value={money(value)} pct={(Math.abs(value) / scale) * 100} fill={fill} negative={value < 0} />
  );
  const attain = d.monthlyGsvOpportunity !== 0 ? d.monthlyNetSales / d.monthlyGsvOpportunity : 0;
  return (
    <div className="kpi-waterfall">
      <p className="kpi-drill-note">盈利推导链：销售如何变成利润与可投费用；目标(GSV机会)与实际的缺口。</p>
      <div className="kpi-bar-list">
        {bar("月GSV机会（目标）", d.monthlyGsvOpportunity, "#6f8bdf")}
        {bar("月去退销售额（实际）", d.monthlyNetSales, "#f6c65f", `达成 ${formatPercent(attain, 0)}`)}
        {bar(d.marketSalesGap < 0 ? "↳ 距目标缺口" : "↳ 超目标盈余", Math.abs(d.marketSalesGap), d.marketSalesGap < 0 ? "#ef7c67" : "#7ad17a")}
        {bar("月利润预估", d.monthlyProfitEstimate, "#7ad17a", `毛利率 ${formatPercent(d.historicalMarginRate, 1)}`)}
        {bar("↳ 成本 + 营销", cost, "#9aa0a6")}
        {bar("全店可投费用", d.availableAdBudget, "#36c9b0", "历史毛利率高于攻防线的预算空间")}
        {bar("增长预留毛利", d.plannedProfit, d.plannedProfit < 0 ? "#ef4d4d" : "#a3e635", `预留毛利率 ${formatPercent(d.plannedMarginRate, 1)}`)}
      </div>
    </div>
  );
}

/** ③ 评级/生命周期透视：按分层或阶段聚合选中 KPI。 */
function PivotView({
  def,
  results,
  pivotBy,
  setPivotBy
}: {
  def: KpiDef;
  results: ProductInvestmentResult[];
  pivotBy: "grade" | "lifecycle";
  setPivotBy: (v: "grade" | "lifecycle") => void;
}) {
  const groups = pivotBy === "grade" ? GRADES : LIFECYCLES;
  const isCount = def.key === "productCount";
  const rows = groups.map((g) => {
    const items = results.filter((r) => (pivotBy === "grade" ? r.grade : r.lifecycle) === g);
    let v: number;
    if (isCount) v = items.length;
    else if (def.rate) {
      const num = items.reduce((s, r) => s + def.rate!.num(r), 0);
      const den = items.reduce((s, r) => s + def.rate!.den(r), 0);
      v = den !== 0 ? num / den : 0;
    } else v = items.reduce((s, r) => s + def.perProduct!(r), 0);
    return { g, v, n: items.length };
  });
  const max = Math.max(...rows.map((x) => Math.abs(x.v)), 1e-9);
  const unit: Unit = isCount ? "int" : def.unit;
  return (
    <div className="kpi-pivot">
      <div className="kpi-pivot-toggle">
        <button type="button" className={clsx(pivotBy === "grade" && "is-active")} onClick={() => setPivotBy("grade")}>
          按评级
        </button>
        <button type="button" className={clsx(pivotBy === "lifecycle" && "is-active")} onClick={() => setPivotBy("lifecycle")}>
          按生命周期
        </button>
      </div>
      <div className="kpi-bar-list">
        {rows.map(({ g, v, n }) => (
          <HBar
            key={g}
            label={g}
            sub={`${n} 个商品`}
            value={fmtVal(v, unit)}
            pct={(Math.abs(v) / max) * 100}
            fill={v < 0 ? "#ef4d4d" : pivotBy === "grade" ? "#f4a43e" : "#6f8bdf"}
            negative={v < 0}
          />
        ))}
      </div>
    </div>
  );
}

/** ④ 规划 vs 实际：逐商品 月GSV机会(规划) vs 月去退销售额(实际) 与达成率。 */
function PlanView({ results }: { results: ProductInvestmentResult[] }) {
  const { sorted, planTotal, actualTotal, max } = useMemo(() => {
    const s = [...results].sort((a, b) => b.monthlyGsvOpportunity - a.monthlyGsvOpportunity).slice(0, 15);
    return {
      sorted: s,
      planTotal: results.reduce((acc, r) => acc + r.monthlyGsvOpportunity, 0),
      actualTotal: results.reduce((acc, r) => acc + r.netSales, 0),
      // 分母只取正向值，避免某行规划/实际皆负或 GSV 全 0 时 1e-9 兜底导致条宽爆量。
      max: Math.max(...s.map((r) => Math.max(r.monthlyGsvOpportunity, r.netSales, 0)), 1e-9)
    };
  }, [results]);
  const barPct = (v: number) => Math.max(0, Math.min(100, (Math.max(v, 0) / max) * 100));
  return (
    <div className="kpi-plan">
      <p className="kpi-drill-note">
        规划（月GSV机会）vs 实际（月去退销售额）。整店达成率{" "}
        <strong>{planTotal !== 0 ? formatPercent(actualTotal / planTotal, 0) : "—"}</strong>（实际 {money(actualTotal)} / 规划 {money(planTotal)}）。
      </p>
      <div className="kpi-plan-list">
        {sorted.map((r) => {
          const attain = r.monthlyGsvOpportunity !== 0 ? r.netSales / r.monthlyGsvOpportunity : 0;
          const loss = r.netSales < 0;
          return (
            <div className="kpi-plan-row" key={r.productId}>
              <span className="kpi-bar-label" title={r.productName}>
                {r.productName || r.productId}
                <em>{r.grade} · {r.lifecycle}{loss ? " · 去退后为负" : ""}</em>
              </span>
              <div className="kpi-plan-bars">
                <div className="kpi-plan-track">
                  <div className="kpi-plan-fill plan" style={{ width: `${barPct(r.monthlyGsvOpportunity)}%` }} />
                </div>
                <div className="kpi-plan-track">
                  <div
                    className={clsx("kpi-plan-fill actual", loss && "loss")}
                    style={{ width: `${loss ? 100 : barPct(r.netSales)}%` }}
                  />
                </div>
              </div>
              <span
                className={clsx("kpi-plan-attain", attain >= 1 ? "good" : attain >= 0.8 ? "warn" : "bad")}
              >
                {formatPercent(attain, 0)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="kpi-plan-legend">
        <span><i className="plan" /> 规划GSV</span>
        <span><i className="actual" /> 实际净销额</span>
      </div>
    </div>
  );
}
