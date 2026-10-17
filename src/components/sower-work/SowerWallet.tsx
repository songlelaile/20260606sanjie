"use client";

import { useEffect, useState } from "react";
import { SOWER_WORK_CREDITS_URL, SOWER_WORK_CREDIT_LEDGER_URL, SOWER_WORK_PACKAGE_URL, type SowerWorkCreditsResponse, type SowerWorkCreditLedgerResponse } from "@/lib/sower-work-credit-contract";
import styles from "./SowerWorkStudio.module.css";

const points = (value: number) => value.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
const labels: Record<string, string> = { opening: "期初余额", recharge: "充值", debit: "模型消费", error: "请求异常" };

export function SowerWallet() {
  const [wallet, setWallet] = useState<SowerWorkCreditsResponse["data"] | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [ledger, setLedger] = useState<SowerWorkCreditLedgerResponse["data"] | null>(null);
  const [ledgerError, setLedgerError] = useState("");

  useEffect(() => {
    const abort = new AbortController();
    setWallet(null); setError("");
    void fetch(SOWER_WORK_CREDITS_URL, { cache: "no-store", credentials: "same-origin", signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const result = await response.json() as SowerWorkCreditsResponse;
        if (result.meta?.source !== "sanjie_gateway" || !Number.isSafeInteger(result.data?.wallet?.balanceCents)) throw new Error();
        if (!abort.signal.aborted) setWallet(result.data);
      }).catch(() => { if (!abort.signal.aborted) setError("套餐积分暂不可用，请刷新重试"); });
    return () => abort.abort();
  }, [revision]);

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setLedger(null); setLedgerError("");
    void fetch(`${SOWER_WORK_CREDIT_LEDGER_URL}?page=${page}`, { cache: "no-store", credentials: "same-origin", signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const result = await response.json() as SowerWorkCreditLedgerResponse;
        if (result.meta?.source !== "sanjie_gateway" || !Array.isArray(result.data?.items)) throw new Error();
        if (!abort.signal.aborted) setLedger(result.data);
      }).catch(() => { if (!abort.signal.aborted) setLedgerError("积分记录读取失败，请刷新重试"); });
    return () => abort.abort();
  }, [open, page, revision]);

  return (
    <div className={styles.wallet} aria-label="套餐积分">
      <div className={styles.walletBar}>
        <strong>套餐积分</strong>
        <span role="status">{error || (wallet ? wallet.wallet.exists ? `${points(wallet.wallet.balancePoints)} 积分 · ${wallet.plan.name}` : "尚未开通积分账户" : "正在读取…")}</span>
        <button type="button" className={styles.retry} onClick={() => setRevision((value) => value + 1)}>刷新积分</button>
        <a className={styles.open} href={SOWER_WORK_PACKAGE_URL}>套餐与充值</a>
      </div>
      <p className={styles.walletNote}>整理与导出不扣积分。对话按你配置的模型服务商计费，当前套餐积分仅展示，不自动用于对话。</p>
      <details className={styles.ledger} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>查看套餐积分账本</summary>
        {open ? <>
          {ledgerError ? <p role="alert">{ledgerError}</p> : !ledger ? <p role="status">正在读取积分记录…</p> : <>
            <div className={styles.ledgerScroll}><table>
              <thead><tr><th>时间</th><th>类型</th><th>模型 / 用途</th><th>积分变化</th><th>余额</th></tr></thead>
              <tbody>{ledger.items.length ? ledger.items.map((row) => <tr key={row.id}>
                <td>{new Date(row.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</td>
                <td>{labels[row.kind] || row.kind}</td><td>{row.model || row.endpoint || "—"}</td>
                <td>{row.deltaPoints > 0 ? "+" : ""}{points(row.deltaPoints)}</td><td>{points(row.balanceAfterPoints)}</td>
              </tr>) : <tr><td colSpan={5}>暂无积分记录</td></tr>}</tbody>
            </table></div>
            <div className={styles.walletBar}>
              <button type="button" className={styles.retry} disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button>
              <span>第 {ledger.page} 页 · 共 {ledger.total} 条</span>
              <button type="button" className={styles.retry} disabled={ledger.page * ledger.pageSize >= ledger.total} onClick={() => setPage((value) => value + 1)}>下一页</button>
            </div>
          </>}
        </> : null}
      </details>
    </div>
  );
}
