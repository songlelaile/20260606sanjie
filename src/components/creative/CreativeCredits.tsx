"use client";

import { useEffect, useState } from "react";
import { applyGatewayBillingCost, centsToPoints } from "@/lib/model-gateway/billing-contract";
import type { CreativeCreditModel, CreativeCreditsData, CreativeCreditLedgerData } from "@/lib/creative-credit-contract";
import styles from "./CreativeCredits.module.css";

type ModelPrice = Pick<CreativeCreditModel, "id" | "label" | "kind" | "imageCents" | "videoCents">;
type Credits = CreativeCreditsData;
type LedgerPage = CreativeCreditLedgerData;
type DemoRow = { id: string; createdAt: string; model: string; count: number; requests: number[];
  kind: "image" | "video"; chargedCents: number; beforeCents: number; afterCents: number;
  planName: string; multiplierBps: number; ruleVersion: number };

const points = (cents: number) => centsToPoints(cents).toLocaleString("zh-CN", { maximumFractionDigits: 1 });
const time = (date: string) => new Date(date).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
const kindLabels: Record<string, string> = { opening: "期初余额", recharge: "充值", gift: "管理员赠送", debit: "模型消费", error: "请求异常" };
const statusLabels: Record<string, string> = { ok: "完成", error: "失败", preflight_rejected: "余额不足未提交", settlement_rejected: "结算拒绝", settlement_failed: "结算异常" };

export function creativeDemoQuote(model: ModelPrice, count: number, multiplierBps: number, grouping: "single" | "four" = "single") {
  if (!Number.isInteger(count) || count < 1 || count > 100) return null;
  const unit = model.kind === "image" ? model.imageCents : model.kind === "video" ? model.videoCents : undefined;
  if (unit === undefined || !Number.isSafeInteger(unit) || unit < 0 || model.kind === "video" && unit === 0) return null;
  const requests: number[] = [];
  for (let remaining = count; remaining > 0;) {
    const n = model.kind === "image" && grouping === "four" ? Math.min(4, remaining) : 1;
    requests.push(n); remaining -= n;
  }
  try {
    const costCents = requests.reduce((sum, n) => sum + applyGatewayBillingCost(model.kind === "image" ? Math.max(1, unit * n) : unit * n, { multiplierBps }), 0);
    if (!Number.isSafeInteger(costCents) || costCents > 2_147_483_647) return null;
    return { costCents, requests, unitCents: applyGatewayBillingCost(model.kind === "image" ? Math.max(1, unit) : unit, { multiplierBps }) };
  } catch { return null; }
}

export function CreativeCredits() {
  const [data, setData] = useState<Credits | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"actual" | "demo">("actual");
  const [ledger, setLedger] = useState<LedgerPage | null>(null);
  const [ledgerError, setLedgerError] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [modelId, setModelId] = useState("");
  const [count, setCount] = useState(1);
  const [grouping, setGrouping] = useState<"single" | "four">("single");
  const [demos, setDemos] = useState<DemoRow[]>([]);
  const [demoError, setDemoError] = useState("");

  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/creative/credits", { cache: "no-store", signal: abort.signal })
      .then(async response => { if (!response.ok) throw new Error("积分信息暂不可用，请刷新重试"); return response.json(); })
      .then(body => { setData(body.data); setError(""); })
      .catch(() => { if (!abort.signal.aborted) { setData(null); setError("积分信息暂不可用，请刷新重试"); } });
    return () => abort.abort();
  }, [revision]);

  useEffect(() => {
    const refreshCredits = () => setRevision(value => value + 1);
    window.addEventListener("sanjie:payment-paid", refreshCredits);
    return () => window.removeEventListener("sanjie:payment-paid", refreshCredits);
  }, []);

  useEffect(() => {
    if (!data && !error) return;
    document.querySelectorAll<HTMLIFrameElement>('iframe[src^="/creative/"]').forEach(frame => {
      frame.contentWindow?.postMessage({ type: "SZ_CREATIVE_CREDITS_UPDATE", v: 1, data }, window.location.origin);
    });
  }, [data, error]);

  useEffect(() => {
    if (!open || tab !== "actual") return;
    const abort = new AbortController();
    setLoading(true); setLedger(null); setLedgerError("");
    fetch(`/api/creative/credits/ledger?page=${page}`, { cache: "no-store", signal: abort.signal })
      .then(async response => { if (!response.ok) throw new Error(); return response.json(); })
      .then(body => { setLedger(body.data); })
      .catch(() => { if (!abort.signal.aborted) setLedgerError("积分记录读取失败，请刷新重试"); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [open, tab, page, revision]);

  const pricedModels = data?.models.filter(model => model.kind !== "chat" && (model.kind === "image" ? model.imageCents !== undefined : model.videoCents !== undefined)) || [];
  const selected = pricedModels.find(model => model.id === modelId) || pricedModels[0];
  const quote = selected && data ? creativeDemoQuote(selected, count, data.plan.multiplierBps, grouping) : null;
  const demoBalance = demos[0]?.afterCents ?? data?.wallet.balanceCents ?? 0;

  function simulate() {
    if (!quote || !selected || !data || selected.kind === "chat") return;
    if (demoBalance < quote.costCents) { setDemoError("演示余额不足，本次模拟未扣分"); return; }
    setDemoError("");
    const row: DemoRow = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), model: selected.label,
      count, requests: quote.requests, kind: selected.kind, chargedCents: quote.costCents,
      beforeCents: demoBalance, afterCents: demoBalance - quote.costCents, planName: data.plan.name,
      multiplierBps: data.plan.multiplierBps, ruleVersion: data.plan.ruleVersion };
    setDemos(previous => {
      const before = previous[0]?.afterCents ?? data.wallet.balanceCents;
      if (before < row.chargedCents) return previous;
      return [{ ...row, beforeCents: before, afterCents: before - row.chargedCents }, ...previous].slice(0, 100);
    });
  }

  return <div className={styles.container}>
    <div className={styles.summary}>
      <button type="button" className={styles.balanceButton} onClick={() => setOpen(value => !value)} aria-expanded={open} aria-controls="creative-credit-records">
        <span>可用积分</span><strong>{data ? points(data.wallet.balanceCents) : "—"}</strong><span>积分记录</span>
      </button>
      {!data ? <small>{error || "正在读取积分"}</small> : null}
      <a href="/models?recharge=1" className={styles.rechargeLink}>购买积分</a>
    </div>
    {open ? <section id="creative-credit-records" className={styles.panel} aria-label="积分记录与演示">
      <div className={styles.panelHeader}><div><h2>积分记录</h2><p>查看本账号余额变化，或试算一次生成费用。</p></div><button type="button" onClick={() => setOpen(false)}>收起</button></div>
      <div className={styles.tabs}>
        <button type="button" aria-pressed={tab === "actual"} onClick={() => setTab("actual")}>实际记录</button>
        <button type="button" aria-pressed={tab === "demo"} onClick={() => setTab("demo")}>积分演示</button>
        <button type="button" onClick={() => setRevision(value => value + 1)}>刷新积分</button>
      </div>
      {error ? <p role="alert" className={styles.notice}>{error}</p> : null}
      {tab === "actual" ? <>
        <p className={styles.note}>本站托管模型的实际扣分在此记录。自有 API 由服务商计费；生成图片可在工作台的“生成记录”查看。</p>
        {loading ? <p role="status">正在读取记录…</p> : ledgerError ? <p role="alert">{ledgerError}</p> : ledger?.items.length ? <div className={styles.rows}>
          {ledger.items.map(row => <details key={row.id} className={styles.record}>
            <summary><span><b>{kindLabels[row.kind] || row.kind}</b> · {row.model || "余额调整"}<small>{time(row.createdAt)} · {statusLabels[row.status] || row.status}</small></span>
              <span className={styles.amount}>{row.deltaCents > 0 ? "+" : row.deltaCents < 0 ? "−" : ""}{points(Math.abs(row.deltaCents))} 积分<small>余额 {points(row.balanceAfterCents)}</small></span></summary>
            <dl><dt>余额变化</dt><dd>{points(row.balanceBeforeCents)} → {points(row.balanceAfterCents)} 积分</dd><dt>实际扣分</dt><dd>{points(row.chargedCostCents)} 积分{row.imageCount ? ` · ${row.imageCount} 张图片` : ""}</dd><dt>账本编号</dt><dd>{row.billingEventId}</dd><dt>请求编号</dt><dd>{row.requestId || "—"}</dd></dl>
          </details>)}
        </div> : <p>暂无本站积分记录。</p>}
        {ledger && ledger.total > ledger.pageSize ? <div className={styles.pagination}><button type="button" disabled={page === 1 || loading} onClick={() => setPage(value => value - 1)}>上一页</button><span>第 {page} 页 · 共 {ledger.total} 条</span><button type="button" disabled={page * ledger.pageSize >= ledger.total || loading} onClick={() => setPage(value => value + 1)}>下一页</button></div> : null}
      </> : <>
        <p className={styles.note}>按当前计费规则试算生成费用，不调用模型、不改变真实余额。试算结果仅在本次页面保留。</p>
        {data?.catalogError ? <p role="alert">{data.catalogError}</p> : null}
        <div className={styles.form}>
          <label>演示模型<select value={selected?.id || ""} onChange={event => { setModelId(event.target.value); setDemoError(""); }} disabled={!pricedModels.length}>{pricedModels.length ? pricedModels.map(model => <option key={model.id} value={model.id}>{model.label} · {model.kind === "image" ? "图片" : "视频"}</option>) : <option value="">暂无已定价模型</option>}</select></label>
          <label>{selected?.kind === "video" ? "任务数量" : "生成张数"}<input type="number" min={1} max={100} value={count} onChange={event => { setCount(Number(event.target.value)); setDemoError(""); }} /></label>
          {selected?.kind === "image" ? <label>生成方式<select value={grouping} onChange={event => setGrouping(event.target.value as "single" | "four")}><option value="single">主图 / 详情 · 逐张生成</option><option value="four">清单成图 · 每批最多 4 张</option></select></label> : null}
        </div>
        <div className={styles.quote}><span>演示可用 <b>{points(demoBalance)}</b> 积分</span><span>{quote ? `单${selected?.kind === "video" ? "任务" : "张"} ${points(quote.unitCents)} 积分 · 本次预计 ${points(quote.costCents)} 积分` : "请配置模型单价和有效数量"}</span><button type="button" disabled={!quote} onClick={simulate}>模拟扣分并查看记录</button></div>
        <small className={styles.note}>图片按本次请求分别取整后合计；视频按受理任务计费。AI 分析按实际用量另计。</small>
        {demoError ? <p role="alert">{demoError}</p> : null}
        <div className={styles.rows}>{demos.map(row => <details key={row.id} className={styles.record}>
          <summary><span><b>演示记录</b> · {row.model}<small>{time(row.createdAt)} · {row.count} {row.kind === "image" ? "张" : "个任务"}</small></span><span className={styles.amount}>−{points(row.chargedCents)} 积分<small>演示余额 {points(row.afterCents)}</small></span></summary>
          <dl><dt>演示余额变化</dt><dd>{points(row.beforeCents)} → {points(row.afterCents)} 积分</dd><dt>生成数量</dt><dd>{row.count} · 共 {row.requests.length} 次请求</dd><dt>执行情况</dt><dd>仅演示，未发起 API 请求</dd><dt>演示编号</dt><dd>{row.id}</dd></dl>
        </details>)}</div>
        {demos.length ? <button type="button" className={styles.reset} onClick={() => { setDemos([]); setDemoError(""); }}>重置演示</button> : null}
      </>}
    </section> : null}
  </div>;
}
