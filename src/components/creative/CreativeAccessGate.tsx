"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import type { CreativeAccess } from "@/lib/creative-access-policy";
import { ScanPaymentDialog } from "./ScanPaymentDialog";
import styles from "./CreativeAccessGate.module.css";

type Plan = { code: string; name: string; priceCents: number; creditCents: number };
const money = (cents: number) => (cents / 100).toFixed(2);

export function CreativeAccessGate({ access, plans, children }: { access: CreativeAccess; plans: Plan[]; children: ReactNode }) {
  const router = useRouter();
  const [paymentPlan, setPaymentPlan] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function refresh() {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/auth/creative-access", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "查询失败");
      if (payload.data.access.allowed) { router.refresh(); return; }
      setMessage("尚未确认到账。扫码付款后请稍后刷新；人工付款请联系管理员核对订单与凭证。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "网络异常，请重试"); }
    finally { setBusy(false); }
  }

  if (access.allowed) return <>
    <div className={styles.status}>
      <span>{access.reason === "invited" ? "受邀客户 · 工作台已开通" : access.reason === "admin" ? "管理员 · 工作台已开通" : "充值客户 · 工作台已开通"}
        {access.expiresAt ? ` · 有效至 ${new Date(access.expiresAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}` : ""}</span>
      <Link href="/models?recharge=1">购买积分</Link>
      {access.reason === "admin" ? <Link href="/management/payments">付款确认</Link> : null}
    </div>{children}
  </>;

  return <section className={styles.panel} aria-label="工作台开通">
    <p className={styles.kicker}>少壮 AI · 作图与视频</p>
    <h1>{access.reason === "unavailable" ? "暂时无法查询开通状态" : access.reason === "expired" ? "工作台已到期，请充值续费" : "充值开通作图与视频工作台"}</h1>
    <p>受邀客户经邀请注册或管理员确认后可访问。自主注册客户在充值到账后开通 30 天；模型调用消耗单独的模型额度。</p>
    <div className={styles.plans}>
      {plans.map(plan => <article key={plan.code}>
        <h2>{plan.name}</h2><strong>¥{money(plan.priceCents)}</strong>
        <p>30 天工作台权限 · ¥{money(plan.creditCents)} 模型额度</p>
        <button type="button" disabled={busy || access.reason === "unavailable"} onClick={() => setPaymentPlan(plan.code)}>购买积分</button>
      </article>)}
    </div>
    <button type="button" onClick={refresh} disabled={busy}>{busy ? "查询中…" : "刷新开通状态"}</button>
    <p role="status">{message}</p>
    <Link href="/models">查看已有订单、模型额度与 API Key</Link>
    <ScanPaymentDialog open={paymentPlan !== null} plans={plans} initialPlanCode={paymentPlan || undefined} onClose={() => setPaymentPlan(null)} onPaid={() => router.refresh()} />
  </section>;
}
