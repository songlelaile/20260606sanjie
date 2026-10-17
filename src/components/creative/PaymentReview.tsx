"use client";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import styles from "./CreativeAccessGate.module.css";
type Order = { id: string; planName: string; amountCents: number; status: string; paymentProvider: string; paymentReceipt: string | null; confirmedBy: string | null; createdAt: string; user: { name: string; username: string } };
export function PaymentReview() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [selected, setSelected] = useState<Order | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/management/creative-orders", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "查询失败");
      setOrders(body.data.orders);
    } catch(error) { setMessage(error instanceof Error ? error.message : "网络异常"); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || busy) return;
    const values = new FormData(event.currentTarget);
    const amount = String(values.get("amount") || "");
    if (!/^\d+(\.\d{1,2})?$/.test(amount)) { setMessage("请输入精确到分的实收金额"); return; }
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/model-gateway/orders/${encodeURIComponent(selected.id)}/mark-paid`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receipt: String(values.get("receipt") || "").trim(), receivedAmountCents: Math.round(Number(amount) * 100), note: String(values.get("note") || "") })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "确认失败");
      setSelected(null); setMessage("已确认到账，模型额度和 30 天工作台权限已生效。"); await load();
    } catch(error) { setMessage(error instanceof Error ? error.message : "网络异常"); }
    finally { setBusy(false); }
  }
  return <section className={styles.panel}>
    <Link href="/management">返回账号管理</Link><h1>充值付款确认</h1>
    <p>核对真实到账记录后填写凭证和实收金额。一个凭证只能确认一个订单。</p>
    <button onClick={load} disabled={busy}>刷新订单</button><p role="status">{message}</p>
    {selected ? <form key={selected.id} onSubmit={confirm} className={styles.order}>
      <h2>确认 {selected.user.name} 的充值订单</h2><p>{selected.id} · 应付 ¥{(selected.amountCents / 100).toFixed(2)}</p>
      <p><label>到账流水号或凭证编号 <input name="receipt" required minLength={4} maxLength={160} /></label></p>
      <p><label>实收金额（元） <input name="amount" required inputMode="decimal" /></label></p>
      <p><label>核对备注 <input name="note" maxLength={500} /></label></p>
      <button disabled={busy}>{busy ? "确认中…" : "已核实到账，确认开通"}</button>{" "}
      <button type="button" onClick={() => setSelected(null)} disabled={busy}>取消</button>
    </form> : null}
    <div style={{ overflowX: "auto", marginTop: 24 }}><table style={{ width: "100%", textAlign: "left", borderCollapse: "collapse" }}>
      <thead><tr>{["客户", "订单", "套餐/应付", "状态", "凭证", "操作"].map(label => <th key={label} style={{ padding: 12 }}>{label}</th>)}</tr></thead>
      <tbody>{orders.map(order => <tr key={order.id}>
        <td style={{ padding: 12 }}>{order.user.name}<br />{order.user.username}</td><td>{order.id}<br />{new Date(order.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</td>
        <td>{order.planName}<br />¥{(order.amountCents / 100).toFixed(2)}</td><td>{order.status === "paid" ? "已到账" : order.status === "pending" ? "待确认" : order.status}</td><td>{order.paymentReceipt || "—"}</td>
        <td>{order.status === "pending" && order.paymentProvider === "manual" ? <button disabled={busy} onClick={() => { setSelected(order); setMessage(""); }}>核对付款</button> : "—"}</td>
      </tr>)}</tbody>
    </table>{orders.length ? <p>最近 {orders.length} 条订单</p> : <p>暂无充值订单</p>}</div>
  </section>;
}
