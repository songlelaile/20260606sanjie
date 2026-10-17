"use client";

import { Coins, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import styles from "./CreditGiftPanel.module.css";
import { CreditGiftPlansPanel } from "./CreditGiftPlansPanel";

type GiftUser = { id: string; status: string; name: string; username: string; shopName: string };
export type CreditGiftView = {
  id: string; requestKey: string; billingEventId: string;
  adminId: string; adminUsername: string; adminName: string;
  userId: string; username: string; userName: string;
  amountCents: number; poolBeforeCents: number; poolAfterCents: number;
  walletBeforeCents: number; walletAfterCents: number; reason: string; createdAt: string;
};
type PoolState = "uninitialized" | "pending" | "invalid" | "ready";
type GiftOverview = { pool: { state?: PoolState; ready: boolean; balanceCents: number | null; balancePoints: number | null; refreshOnSubmitAvailable?: boolean }; gifts: CreditGiftView[] };
type GiftDraft = { userId: string; points: string; reason: string; requestKey: string };
const ENDPOINT = "/api/management/credit-gifts";
const MAX_CENTS = 2_147_483_647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NO_CONTROLS = /^[^\u0000-\u001f\u007f]*$/u;

export function parseCreditGiftPoints(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d)?$/.test(trimmed) || trimmed.length > 20) return null;
  const [whole, fraction = "0"] = trimmed.split(".");
  const cents = BigInt(whole) * 10n + BigInt(fraction);
  return cents > 0n && cents <= BigInt(MAX_CENTS) ? Number(cents) : null;
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function amount(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_CENTS; }
function giftView(value: unknown): value is CreditGiftView {
  if (!record(value) || !["id", "requestKey", "billingEventId", "adminId", "adminUsername", "adminName", "userId", "username", "userName", "reason", "createdAt"].every((key) => typeof value[key] === "string")) return false;
  if (!value.id || !UUID.test(String(value.requestKey)) || value.billingEventId !== `gift:${value.requestKey}` || !Number.isFinite(Date.parse(String(value.createdAt)))) return false;
  const fields = ["amountCents", "poolBeforeCents", "poolAfterCents", "walletBeforeCents", "walletAfterCents"];
  if (!fields.every((key) => amount(value[key])) || Number(value.amountCents) <= 0) return false;
  return Number(value.poolBeforeCents) - Number(value.poolAfterCents) === value.amountCents
    && Number(value.walletAfterCents) - Number(value.walletBeforeCents) === value.amountCents;
}
function overviewView(value: unknown): value is GiftOverview {
  if (!record(value) || !record(value.pool) || typeof value.pool.ready !== "boolean" || !Array.isArray(value.gifts) || !value.gifts.every(giftView)) return false;
  if (value.pool.state !== undefined && (typeof value.pool.state !== "string" || !["uninitialized", "pending", "invalid", "ready"].includes(value.pool.state) || (value.pool.state === "ready") !== value.pool.ready)) return false;
  if (value.pool.refreshOnSubmitAvailable !== undefined && (typeof value.pool.refreshOnSubmitAvailable !== "boolean"
    || value.pool.refreshOnSubmitAvailable && (value.pool.state !== "pending" || value.pool.ready))) return false;
  return value.pool.ready
    ? amount(value.pool.balanceCents) && value.pool.balancePoints === value.pool.balanceCents / 10
    : value.pool.balanceCents === null && value.pool.balancePoints === null;
}
function draftView(value: unknown): value is GiftDraft {
  return record(value) && typeof value.userId === "string" && value.userId.length > 0 && value.userId.length <= 120
    && typeof value.points === "string" && parseCreditGiftPoints(value.points) !== null
    && typeof value.reason === "string" && value.reason.trim().length >= 2 && value.reason.trim().length <= 500 && NO_CONTROLS.test(value.reason)
    && typeof value.requestKey === "string" && UUID.test(value.requestKey);
}
function matchingGift(gift: CreditGiftView, draft: GiftDraft, adminId: string) {
  return gift.requestKey === draft.requestKey && gift.userId === draft.userId && gift.adminId === adminId
    && gift.amountCents === parseCreditGiftPoints(draft.points) && gift.reason === draft.reason.trim();
}
function points(cents: number | null) { return cents === null ? "未知" : (cents / 10).toLocaleString("zh-CN", { maximumFractionDigits: 1 }); }
function time(value: string) { return new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }); }

export function CreditGiftPanel({ users, initialUserId, adminId }: { users: GiftUser[]; initialUserId?: string; adminId: string }) {
  const [overview, setOverview] = useState<GiftOverview | null>(null);
  const [userId, setUserId] = useState(initialUserId || "");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState<GiftDraft | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [overviewError, setOverviewError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [success, setSuccess] = useState<CreditGiftView | null>(null);
  const pending = useRef(false);
  const savedDraft = useRef<GiftDraft | null>(null);
  const mounted = useRef(false);
  const refreshVersion = useRef(0);
  const storageKey = `sanjie-credit-gift-v1:${encodeURIComponent(adminId)}`;
  const activeUsers = users.filter((user) => user.status === "active");
  const target = users.find((user) => user.id === userId);
  const cents = parseCreditGiftPoints(quantity);
  const validReason = reason.trim().length >= 2 && reason.trim().length <= 500 && NO_CONTROLS.test(reason);
  const readOnly = !initialized || busy || !!draft || !!storageError;
  const poolReadState = loading ? "loading" : overviewError || !overview ? "error"
    : overview.pool.state ?? (overview.pool.ready ? "ready" : "uninitialized");
  const ready = poolReadState === "ready";
  const refreshOnSubmit = poolReadState === "pending" && overview?.pool.refreshOnSubmitAvailable === true;
  const canSubmit = !readOnly && target?.status === "active" && cents !== null && validReason
    && (refreshOnSubmit || ready && cents <= overview!.pool.balanceCents!);
  const poolLabel = poolReadState === "loading" ? "读取中…" : poolReadState === "error" ? "读取失败"
    : poolReadState === "uninitialized" ? "未配置" : poolReadState === "pending" ? "待核对"
      : poolReadState === "invalid" ? "异常" : points(overview!.pool.balanceCents);
  const poolHint = poolReadState === "loading" ? "正在读取总积分池余额与赠送记录。"
    : poolReadState === "error" ? "尚未取得有效的总积分池状态，请刷新核对；读取失败不能判断是否已配置。"
      : poolReadState === "uninitialized" ? "总积分池尚未初始化，无法确认可赠送余额。请先在上方读取来源余额并审阅采用方案；填写赠送表单不会初始化总池。"
        : poolReadState === "pending" ? refreshOnSubmit
          ? "总积分池已建立，余额需重新核对。确认赠送时会先读取最新上游余额并核对账本，余额足够且校验通过后才赠送。"
          : "总积分池已建立，当前暂不可分配。请在上方来源核对中读取最新余额并完成账本核对后刷新。"
          : poolReadState === "invalid" ? "总积分池状态或余额异常，暂不能赠送。请先核对积分账本，再刷新核对。" : "";
  const submissionBlocker = busy ? "正在处理赠送，请等待结果。" : !initialized ? "正在恢复浏览器中的赠送记录。"
    : storageError ? storageError : poolReadState === "loading" ? "正在读取总积分池，请等待核对完成。"
      : poolReadState === "error" ? "总积分池读取失败，请先刷新核对。"
        : poolReadState === "uninitialized" ? "总积分池尚未初始化，当前不能赠送。"
          : poolReadState === "pending" && !refreshOnSubmit ? "来源余额需重新核对，当前不能赠送。"
            : poolReadState === "invalid" ? "总积分池状态异常，当前不能赠送。"
              : target?.status !== "active" ? "请选择启用中的赠送账号。"
                : cents === null ? "请填写大于 0、最多 1 位小数的积分数量。"
                  : !validReason ? "请填写 2 至 500 字的赠送理由，不能包含换行或控制字符。"
                    : ready && cents > overview!.pool.balanceCents! ? "总积分池可赠送余额不足，请调整积分数量。" : "";

  function finishGift(gift: CreditGiftView) {
    setSuccess(gift);
    setNotice("");
    setOverview((current) => ({
      pool: { state: current?.pool.state ?? (current?.pool.ready === false ? "uninitialized" : "ready"), ready: current?.pool.ready ?? true, balanceCents: current?.pool.ready === false ? null : gift.poolAfterCents, balancePoints: current?.pool.ready === false ? null : gift.poolAfterCents / 10 },
      gifts: [gift, ...(current?.gifts || []).filter((row) => row.id !== gift.id)].slice(0, 50)
    }));
    try { window.sessionStorage.removeItem(storageKey); }
    catch {
      setStorageError("赠送已成功，但浏览器未能清除待核对记录；请刷新核对后再发起下一笔。");
      return;
    }
    savedDraft.current = null;
    setDraft(null);
    setStorageError("");
    setQuantity("");
    setReason("");
  }

  async function refresh(checkDraft = savedDraft.current) {
    const version = ++refreshVersion.current;
    setLoading(true);
    setOverviewError("");
    try {
      const response = await fetch(ENDPOINT, { cache: "no-store", credentials: "same-origin" });
      const body: unknown = await response.json();
      if (!response.ok || !record(body) || !overviewView(body.data)) throw new Error("overview unavailable");
      if (!mounted.current || version !== refreshVersion.current) return;
      // A missing recent record does not establish that a pending operation failed.
      const found = checkDraft && body.data.gifts.find((gift) => matchingGift(gift, checkDraft, adminId));
      if (found) finishGift(found);
      setOverview(body.data);
    } catch {
      if (mounted.current && version === refreshVersion.current) setOverviewError("总积分池与赠送记录读取失败，请刷新核对。");
    } finally {
      if (mounted.current && version === refreshVersion.current) setLoading(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    let restored: GiftDraft | null = null;
    try {
      const raw = window.sessionStorage.getItem(storageKey);
      if (raw !== null) {
        const value: unknown = JSON.parse(raw);
        if (!draftView(value)) throw new Error("invalid draft");
        restored = value;
        savedDraft.current = value;
        setDraft(value);
        setUserId(value.userId);
        setQuantity(value.points);
        setReason(value.reason);
        setNotice("已恢复一笔结果待核对的赠送；请核对记录或重试同一笔赠送。");
      }
    } catch { setStorageError("浏览器中的待核对赠送记录无法读取，请先核对原赠送结果；当前不能发起新赠送。"); }
    setInitialized(true);
    void refresh(restored);
    const sourceChanged = () => { if (!pending.current) void refresh(); };
    window.addEventListener?.("sanjie-credit-pool-updated", sourceChanged);
    return () => { window.removeEventListener?.("sanjie-credit-pool-updated", sourceChanged); mounted.current = false; ++refreshVersion.current; };
  // Each administrator receives an isolated panel and storage scope from ManagementConsole.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  async function sendGift(payload: GiftDraft, previouslyUncertain: boolean) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    setSuccess(null);
    // Persist before sending: interruption or reload must retain the original idempotency key.
    try { window.sessionStorage.setItem(storageKey, JSON.stringify(payload)); }
    catch {
      setStorageError("浏览器无法保存待核对赠送记录，本次未提交；请恢复浏览器存储后再操作。");
      pending.current = false;
      setBusy(false);
      return;
    }
    savedDraft.current = payload;
    setDraft(payload);
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST", cache: "no-store", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
      });
      const body: unknown = await response.json();
      if (response.ok && record(body) && giftView(body.data) && matchingGift(body.data, payload, adminId)) {
        finishGift(body.data);
        window.dispatchEvent(new Event("sanjie-credit-pool-updated"));
        await refresh(null);
      } else if (response.status >= 400 && response.status < 500 && record(body) && typeof body.error === "string" && body.error.trim()) {
        if (previouslyUncertain) {
          setNotice(`原赠送结果仍待核对：${body.error}。请保留此笔记录并刷新核对，或重试同一笔赠送。`);
        } else {
          try { window.sessionStorage.removeItem(storageKey); }
          catch {
            setStorageError("本次赠送已被拒绝，但浏览器未能清除待核对记录；请刷新核对。");
            return;
          }
          savedDraft.current = null;
          setDraft(null);
          setNotice(`本次赠送未成功：${body.error}`);
        }
      } else {
        setNotice("赠送结果待核对，请刷新核对记录，或重试同一笔赠送；原账号、数量和理由已锁定。");
      }
    } catch { setNotice("赠送结果待核对，请刷新核对记录，或重试同一笔赠送；原账号、数量和理由已锁定。"); }
    finally { pending.current = false; setBusy(false); }
  }

  async function submit() {
    if (!canSubmit || pending.current || savedDraft.current || !target || cents === null) return;
    const balanceNotice = refreshOnSubmit
      ? `服务端会先读取最新上游余额并核对账本，余额足够且校验通过后才赠送，并从总积分池扣减 ${points(cents)} 积分。`
      : `总积分池将扣减 ${points(cents)} 积分，预计余额 ${points(overview!.pool.balanceCents! - cents)} 积分。`;
    if (!window.confirm(`向 ${target.name}（${target.username}）赠送 ${points(cents)} 积分？\n${balanceNotice}\n理由：${reason.trim()}`)) return;
    let requestKey: string;
    try { requestKey = crypto.randomUUID(); }
    catch { setNotice("浏览器无法生成赠送编号，本次未提交，请刷新后重试。"); return; }
    await sendGift({ userId, points: String(cents / 10), reason: reason.trim(), requestKey }, false);
  }

  return <section className={styles.panel} aria-label="赠送积分管理">
    <header className={styles.header}><div><h2><Coins size={20} />赠送积分</h2><p>向启用中的账号赠送自定义积分，数量从总积分池中扣减。</p></div>
      <button type="button" className={styles.secondary} disabled={loading || busy} onClick={() => refresh()}><RefreshCw size={15} />{loading ? "核对中…" : "刷新核对"}</button></header>
    <div className={styles.pool}><span>总积分池可赠送余额</span><strong>{poolLabel}{ready ? <small> 积分</small> : null}</strong></div>
    {poolHint ? <p className={styles.hint} role="status">{poolHint}</p> : null}
    {overviewError ? <p className={styles.error} role="alert">{overviewError}{success ? "已确认的赠送成功记录保留。" : ""}</p> : null}
    {storageError ? <p className={styles.error} role="alert">{storageError}</p> : null}
    {success ? <div className={styles.success} role="status"><strong>赠送成功：{success.userName}（{success.username}）收到 {points(success.amountCents)} 积分</strong>
      <p>总积分池：{points(success.poolBeforeCents)} → {points(success.poolAfterCents)} 积分；账号余额：{points(success.walletBeforeCents)} → {points(success.walletAfterCents)} 积分。</p>
      <small>赠送编号：{success.requestKey}</small></div> : null}
    {notice ? <p className={draft ? styles.pending : styles.hint} role="status">{notice}</p> : null}
    <div className={styles.form}>
      <label className={styles.field}><span>赠送账号</span><select aria-label="赠送账号" value={userId} disabled={readOnly} onChange={(event) => { setUserId(event.target.value); setSuccess(null); }}>
        <option value="">请选择启用中的账号</option>
        {draft && !activeUsers.some((user) => user.id === draft.userId) ? <option value={draft.userId}>{target?.name || draft.userId} · 原赠送账号（待核对）</option> : null}
        {activeUsers.map((user) => <option key={user.id} value={user.id}>{user.name}（{user.username}）{user.shopName ? ` · ${user.shopName}` : ""}</option>)}</select></label>
      <label className={styles.field}><span>自定义积分</span><input aria-label="自定义积分" type="text" inputMode="decimal" placeholder="如 100 或 100.5" value={quantity} disabled={readOnly} onChange={(event) => { setQuantity(event.target.value); setSuccess(null); }} /></label>
      <label className={`${styles.field} ${styles.reason}`}><span>赠送理由（2 至 500 字）</span><textarea aria-label="赠送理由" minLength={2} maxLength={500} rows={3} placeholder="填写 2 至 500 字的赠送理由" value={reason} disabled={readOnly} onChange={(event) => { setReason(event.target.value); setSuccess(null); }} /></label>
    </div>
    {draft ? <div className={styles.pending}><p>{success ? "已确认成功，浏览器记录待恢复" : "待核对"}：{target?.name || draft.userId}（{target?.username || draft.userId}） · {draft.points} 积分 · {draft.reason}</p><small>原赠送编号：{draft.requestKey}</small></div> : <p className={styles.hint}>积分必须大于 0，最多 1 位小数。{cents !== null && ready && cents > overview!.pool.balanceCents! ? "总积分池余额不足。" : ""}</p>}
    {!draft && target && cents !== null ? <p className={styles.preview}>确认向 {target.name}（{target.username}）赠送 <strong>{points(cents)}</strong> 积分；总积分池预计扣减 <strong>{points(cents)}</strong> 积分{ready ? `，预计余额 ${points(overview!.pool.balanceCents! - cents)} 积分` : ""}。</p> : null}
    <div className={styles.actions}>{draft ? <button type="button" className={styles.primary} disabled={!initialized || busy || !!storageError || !!success} onClick={() => sendGift(draft, true)}>{busy ? "核对赠送中…" : "重试同一笔赠送"}</button>
      : <button type="button" className={styles.primary} disabled={!canSubmit} aria-describedby={!canSubmit ? "credit-gift-submit-blocker" : undefined} onClick={submit}>{busy ? "赠送中…" : refreshOnSubmit ? "核对最新余额并赠送" : "确认赠送积分"}</button>}</div>
    {!draft && !canSubmit ? <p id="credit-gift-submit-blocker" className={styles.hint} role="status">{submissionBlocker}</p> : null}
    <section className={styles.history} aria-labelledby="credit-gifts-history"><h3 id="credit-gifts-history">最近 50 笔赠送记录</h3>
      {overview ? overview.gifts.length ? <div className={styles.tableWrap}><table><thead><tr><th>赠送时间</th><th>账号</th><th>赠送积分</th><th>池余额前 → 后</th><th>账号余额前 → 后</th><th>操作人 / 理由</th></tr></thead><tbody>{overview.gifts.map((gift) => <tr key={gift.id}>
        <td>{time(gift.createdAt)}<small>{gift.requestKey}</small></td><td>{gift.userName}<small>{gift.username}</small></td><td>+{points(gift.amountCents)}</td><td>{points(gift.poolBeforeCents)} → {points(gift.poolAfterCents)}</td><td>{points(gift.walletBeforeCents)} → {points(gift.walletAfterCents)}</td><td>{gift.adminName || gift.adminUsername}<small>{gift.reason}</small></td>
      </tr>)}</tbody></table></div> : <p className={styles.hint}>暂无赠送记录。</p> : <p className={styles.hint}>{loading ? "正在读取赠送记录…" : "赠送记录暂不可用。"}</p>}
    </section>
    <CreditGiftPlansPanel users={users} initialUserId={initialUserId} adminId={adminId} />
  </section>;
}
