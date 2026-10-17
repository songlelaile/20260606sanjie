"use client";

import { useEffect, useRef, useState } from "react";
import type { AllocationBudgetView } from "@/lib/model-gateway/credit-allocation-window";
import type { GiftPlanView } from "@/lib/model-gateway/credit-gift-plans-contract";
import styles from "./CreditGiftPanel.module.css";

type GiftUser = { id: string; status: string; name: string; username: string; shopName: string };
type PlanDraft = { userId: string; points: string; reason: string; requestKey: string; expiresAt: string };
type SavedOperation = { kind: "save"; payload: PlanDraft } | { kind: "cancel"; plan: GiftPlanView };
type PlansOverview = { budget: AllocationBudgetView; plans: GiftPlanView[] };
const ENDPOINT = "/api/management/credit-gift-plans";
const MAX_CENTS = 2_147_483_647;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CODE = /^[A-Z][A-Z0-9_]{0,95}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join() === keys.sort().join();
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const cents = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_CENTS;
const validReason = (value: unknown): value is string => typeof value === "string" && value.trim().length >= 2 && value.trim().length <= 500 && !/[\u0000-\u001f\u007f]/.test(value);
const points = (value: number | null) => value === null ? "未知" : `${Math.floor(value / 10)}${value % 10 ? `.${value % 10}` : ""}`;
const time = (value: string | null) => value === null ? "尚无记录" : new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
const stateLabel: Record<GiftPlanView["status"], string> = { pending: "等待核验后赠送", blocked: "条件未满足，等待核验", completed: "赠送已完成", cancelled: "已取消", expired: "已过期" };
const reasons: Record<string, string> = {
  HOLD_PRICE_UNPROVEN: "未完成任务的原始汇率或计价凭证尚未核验，预设暂未执行。",
  ALLOCATION_WINDOW_REQUIRED: "请先完整核验分配额度，建立本次 50% 累计分配上限。",
  ALLOCATION_WINDOW_EXHAUSTED: "本次累计分配上限不足，需重新核验分配额度。",
  INSUFFICIENT_POOL_BALANCE: "当前可分配积分不足。",
  CREDIT_POOL_NOT_READY: "当前来源与积分账本尚未通过分配核验。",
  BACKING_SHORTFALL: "上游余额存在覆盖缺口，预设暂未执行。",
  ACCOUNT_UNAVAILABLE: "目标账号不存在或已停用。",
  GIFT_PLAN_EXPIRY_INVALID: "截止时间需在未来 30 天内。",
  GIFT_PLAN_CONFLICT: "原请求标识对应的预设内容不一致，请先核对原记录。",
  GIFT_PLAN_COMPLETED: "赠送已经完成，不能通过取消预设撤销已赠送积分。",
  AUTH_REQUIRED: "管理员登录已失效，请重新登录后核对原操作。",
  ADMIN_REQUIRED: "当前账号没有管理预设赠送的权限。"
};
function issue(code: unknown, fallback: string) {
  const safe = typeof code === "string" && CODE.test(code) ? code : "GIFT_PLAN_RESULT_UNCONFIRMED";
  return `${reasons[safe] ?? fallback}（诊断标识：${safe}）`;
}
export function parsePlanPoints(value: string): number | null {
  const raw = value.trim();
  if (!/^(0|[1-9]\d{0,8})(?:\.\d)?$/.test(raw)) return null;
  const [whole, fraction = "0"] = raw.split(".");
  const amount = BigInt(whole) * 10n + BigInt(fraction);
  return amount > 0n && amount <= BigInt(MAX_CENTS) ? Number(amount) : null;
}
/** The form explicitly uses Beijing time, independent of browser timezone. */
export function planDeadlineIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}+08:00`);
  if (!Number.isFinite(date.getTime()) || new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 16) !== value) return null;
  return date.toISOString();
}
function draftView(value: unknown): value is PlanDraft {
  return isRecord(value) && exact(value, ["userId", "points", "reason", "requestKey", "expiresAt"]) && typeof value.userId === "string" && ID.test(value.userId)
    && typeof value.points === "string" && parsePlanPoints(value.points) !== null && validReason(value.reason)
    && typeof value.requestKey === "string" && UUID.test(value.requestKey) && instant(value.expiresAt);
}
function planView(value: unknown, adminId: string): value is GiftPlanView {
  if (!isRecord(value) || !exact(value, ["id", "requestKey", "adminId", "userId", "amountCents", "reason", "status", "lastCode", "expiresAt", "executedAt", "cancelledAt", "createdAt"]) ||
    value.adminId !== adminId || typeof value.id !== "string" || !ID.test(value.id) || typeof value.userId !== "string" || !ID.test(value.userId) ||
    typeof value.requestKey !== "string" || !UUID.test(value.requestKey) || !cents(value.amountCents) || value.amountCents <= 0 || !validReason(value.reason) ||
    typeof value.status !== "string" || !Object.prototype.hasOwnProperty.call(stateLabel, value.status) || value.lastCode !== null && (typeof value.lastCode !== "string" || !CODE.test(value.lastCode)) ||
    !instant(value.expiresAt) || !instant(value.createdAt) || value.executedAt !== null && !instant(value.executedAt) || value.cancelledAt !== null && !instant(value.cancelledAt)) return false;
  return (value.status === "completed") === (value.executedAt !== null) && (value.status === "cancelled") === (value.cancelledAt !== null);
}
function budgetView(value: unknown): value is AllocationBudgetView {
  if (!isRecord(value) || !exact(value, ["state", "windowId", "verifiedAt", "baselineCents", "limitCents", "allocatedCents", "remainingCents", "ratioBps"]) ||
    typeof value.state !== "string" || !["not_applicable", "required", "ready", "changed"].includes(value.state) || value.ratioBps !== 5000) return false;
  if (["not_applicable", "required"].includes(value.state)) return [value.windowId, value.verifiedAt, value.baselineCents, value.limitCents, value.allocatedCents, value.remainingCents].every(item => item === null);
  return typeof value.windowId === "string" && ID.test(value.windowId) && instant(value.verifiedAt) && cents(value.baselineCents) && cents(value.limitCents) && cents(value.allocatedCents)
    && cents(value.remainingCents) && value.limitCents === Math.floor(value.baselineCents / 2) && value.allocatedCents + value.remainingCents === value.limitCents;
}
function overviewView(value: unknown, adminId: string): value is PlansOverview {
  if (!isRecord(value) || !budgetView(value.budget) || !Array.isArray(value.plans) || value.plans.length > 100 || !value.plans.every(row => planView(row, adminId))) return false;
  return new Set(value.plans.map(row => row.id)).size === value.plans.length && new Set(value.plans.map(row => row.requestKey)).size === value.plans.length;
}
function savedView(value: unknown, adminId: string): value is SavedOperation {
  return isRecord(value) && (value.kind === "save" ? exact(value, ["kind", "payload"]) && draftView(value.payload)
    : value.kind === "cancel" && exact(value, ["kind", "plan"]) && planView(value.plan, adminId));
}
function matches(plan: GiftPlanView, operation: SavedOperation, adminId: string) {
  if (plan.adminId !== adminId) return false;
  if (operation.kind === "cancel") return plan.id === operation.plan.id && plan.requestKey === operation.plan.requestKey && plan.userId === operation.plan.userId
    && plan.amountCents === operation.plan.amountCents && plan.reason === operation.plan.reason && plan.expiresAt === operation.plan.expiresAt;
  const draft = operation.payload;
  return plan.requestKey === draft.requestKey && plan.userId === draft.userId && plan.amountCents === parsePlanPoints(draft.points)
    && plan.reason === draft.reason.trim() && plan.expiresAt === draft.expiresAt;
}

export function CreditGiftPlansPanel({ users, initialUserId, adminId }: { users: GiftUser[]; initialUserId?: string; adminId: string }) {
  const [overview, setOverview] = useState<PlansOverview | null>(null), [loading, setLoading] = useState(true), [overviewError, setOverviewError] = useState("");
  const [userId, setUserId] = useState(initialUserId ?? ""), [quantity, setQuantity] = useState(""), [reason, setReason] = useState(""), [deadline, setDeadline] = useState("");
  const [saved, setSaved] = useState<SavedOperation | null>(null), [storageError, setStorageError] = useState("");
  const [initialized, setInitialized] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [receipt, setReceipt] = useState<GiftPlanView | null>(null);
  const savedRef = useRef<SavedOperation | null>(null), pending = useRef(false), mounted = useRef(false), refreshVersion = useRef(0);
  const storageKey = `sanjie-credit-gift-plan-v1:${encodeURIComponent(adminId)}`;
  const target = users.find(user => user.id === userId), amount = parsePlanPoints(quantity), expiresAt = planDeadlineIso(deadline);
  const validDeadline = expiresAt !== null && Date.parse(expiresAt) > Date.now() && Date.parse(expiresAt) <= Date.now() + 30 * 86400_000;
  const readOnly = !initialized || busy || !!saved || !!storageError;
  const canSave = !readOnly && target?.status === "active" && amount !== null && validReason(reason) && validDeadline;

  function accept(plan: GiftPlanView, operation: SavedOperation) {
    setReceipt(plan);
    setOverview(current => current ? { ...current, plans: [plan, ...current.plans.filter(row => row.id !== plan.id)].slice(0, 100) } : current);
    const terminalCancel = operation.kind === "cancel" && ["cancelled", "completed", "expired"].includes(plan.status);
    if (operation.kind === "cancel" && !terminalCancel) return;
    setNotice(plan.status === "completed" ? operation.kind === "cancel" ? "原赠送已完成，取消未撤销已赠送积分。" : "预设赠送已完成，请核对赠送记录。"
      : plan.status === "cancelled" ? "预设已取消，不再尝试赠送。" : plan.status === "expired" ? "预设已过期，不再尝试赠送。" : "预设已保存，尚未赠送；后续完整核验成功时会再次尝试。" );
    try { window.sessionStorage.removeItem(storageKey); }
    catch { setStorageError("原操作已查到记录，但浏览器记录未能清除；请继续核对原操作，暂不新建预设。"); return; }
    savedRef.current = null; setSaved(null); setStorageError("");
    if (operation.kind === "save") { setQuantity(""); setReason(""); setDeadline(""); }
  }
  async function refresh() {
    const version = ++refreshVersion.current; setLoading(true); setOverviewError("");
    try {
      const response = await fetch(ENDPOINT, { method: "GET", cache: "no-store", credentials: "same-origin" }); const body: unknown = await response.json();
      if (!response.ok || !isRecord(body) || !overviewView(body.data, adminId)) throw new Error("invalid plan overview");
      if (!mounted.current || version !== refreshVersion.current) return;
      setOverview(body.data);
      const original = savedRef.current;
      const found = original && body.data.plans.find(plan => matches(plan, original, adminId));
      if (original && found) accept(found, original);
      else if (original) setNotice("当前记录列表尚未查到原操作结果；保留原请求，可再次核对或原样重试。列表未出现不代表操作失败。");
    } catch { if (mounted.current && version === refreshVersion.current) setOverviewError("预设与累计分配额度读取失败；已有读值保留为历史记录。"); }
    finally { if (mounted.current && version === refreshVersion.current) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true;
    try {
      const raw = window.sessionStorage.getItem(storageKey);
      if (raw !== null) {
        const value: unknown = JSON.parse(raw);
        if (!savedView(value, adminId)) throw new Error("invalid saved plan");
        savedRef.current = value; setSaved(value);
        if (value.kind === "save") { setUserId(value.payload.userId); setQuantity(value.payload.points); setReason(value.payload.reason); setDeadline(new Date(Date.parse(value.payload.expiresAt) + 8 * 3600_000).toISOString().slice(0, 16)); }
        setNotice("已恢复一笔待核对的预设操作；只会重试原请求，不创建另一笔授权。");
      }
    } catch { setStorageError("浏览器中的原预设操作无法读取，请先核对原记录；当前不能创建或取消其他预设。"); }
    setInitialized(true); void refresh();
    const changed = () => { if (!pending.current) void refresh(); }; window.addEventListener?.("sanjie-credit-pool-updated", changed);
    // The latest counter must be advanced to invalidate every outstanding read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { mounted.current = false; ++refreshVersion.current; window.removeEventListener?.("sanjie-credit-pool-updated", changed); };
  // The enclosing management console isolates the administrator storage scope.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  async function send(operation: SavedOperation, previouslyUncertain = true) {
    if (pending.current || storageError) return;
    pending.current = true; setBusy(true); setNotice(""); setReceipt(null); ++refreshVersion.current;
    try { window.sessionStorage.setItem(storageKey, JSON.stringify(operation)); }
    catch { setStorageError("浏览器无法保存原请求，本次未提交；请恢复浏览器存储后再操作。"); pending.current = false; setBusy(false); return; }
    savedRef.current = operation; setSaved(operation);
    try {
      const response = await fetch(operation.kind === "save" ? ENDPOINT : `${ENDPOINT}/${encodeURIComponent(operation.plan.id)}/cancel`, {
        method: "POST", cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(operation.kind === "save" ? operation.payload : {})
      });
      const body: unknown = await response.json();
      if (response.ok && isRecord(body) && planView(body.data, adminId) && matches(body.data, operation, adminId)
        && (operation.kind === "save" || ["cancelled", "completed", "expired"].includes(body.data.status))) {
        accept(body.data, operation);
        if (body.data.status === "completed") window.dispatchEvent(new Event("sanjie-credit-pool-updated"));
        await refresh();
      } else {
        const code = isRecord(body) ? body.code : null;
        const rejectedBeforeSave = !previouslyUncertain && operation.kind === "save" && response.status >= 400 && response.status < 500 && typeof code === "string"
          && ["INVALID_GIFT_INPUT", "INVALID_GIFT_POINTS", "INVALID_GIFT_REASON", "INVALID_GIFT_REQUEST_KEY", "GIFT_PLAN_EXPIRY_INVALID", "ACCOUNT_UNAVAILABLE", "AUTH_REQUIRED", "ADMIN_REQUIRED"].includes(code);
        if (rejectedBeforeSave) {
          try { window.sessionStorage.removeItem(storageKey); }
          catch { setStorageError("本次预设未保存，但原请求记录未能清除；请先核对浏览器记录。"); return; }
          savedRef.current = null; setSaved(null); setNotice(`本次预设未保存。${issue(code, "请核对填写内容后重新保存。")}`);
        } else setNotice(`${issue(code, "原预设操作结果尚未确认。")}请核对原操作或原样重试，原请求与内容已保留。`);
      }
    } catch { setNotice("原预设操作结果尚未确认，请核对原操作或原样重试；原请求与内容已保留。"); }
    finally { pending.current = false; setBusy(false); }
  }
  async function submit() {
    if (!canSave || pending.current || savedRef.current || amount === null || expiresAt === null) return;
    let requestKey: string;
    try { requestKey = crypto.randomUUID(); }
    catch { setNotice("无法生成原请求标识，本次未提交。"); return; }
    await send({ kind: "save", payload: { userId, points: points(amount), reason: reason.trim(), requestKey, expiresAt } }, false);
  }
  const budget = overview?.budget;
  return <section className={styles.panel} aria-label="预设赠送与累计分配上限">
    <header className={styles.header}><div><h2>预设赠送与累计分配上限</h2><p>只查看预设不会执行赠送；所有赠送仍须通过当前来源、账本和累计分配上限核验。</p></div>
      <button type="button" className={styles.secondary} disabled={loading} onClick={() => refresh()}>{loading ? "读取预设中…" : "查看预设与额度"}</button></header>
    {overviewError ? <p className={styles.error} role="alert">{overviewError}</p> : null}
    <div className={styles.pool}><span>自上次成功核验后的累计新增分配上限</span><strong>{budget?.limitCents !== null && budget?.limitCents !== undefined ? `${points(budget.limitCents)} 积分` : "待核验"}</strong></div>
    {budget && budget.baselineCents !== null ? <p className={styles.hint}>{overviewError || loading ? "历史读值。" : ""}基准核验时间：{time(budget.verifiedAt)}；当时可分配 {points(budget.baselineCents)} 积分 × 50% = {points(budget.limitCents)} 积分。累计新增分配 {points(budget.allocatedCents)} 积分，剩余上限 {points(budget.remainingCents)} 积分。赠送和充值分配共同累计，消费或退款不恢复此上限。</p>
      : <p className={styles.hint}>{budget?.state === "not_applicable" ? "当前积分池尚不适用共用来源分配上限，请先核对积分池来源。" : "尚无有效的累计分配基准，请在上方完整核验分配额度。"}</p>}
    {budget?.state === "changed" ? <p className={styles.error} role="status">来源或计价规则已经变化，上次分配上限不能直接采用，请重新完整核验。</p> : null}
    <p className={styles.hint}>50% 是额外的累计分配上限，不能代替当前来源核验。账务异常会阻止赠送，不影响查看余额与记录。</p>
    {storageError ? <p className={styles.error} role="alert">{storageError}</p> : null}
    {notice ? <p className={saved ? styles.pending : styles.hint} role="status">{notice}</p> : null}
    {receipt ? <p className={receipt.status === "completed" ? styles.success : styles.hint}>原预设记录：{stateLabel[receipt.status]} · {points(receipt.amountCents)} 积分 · 编号 {receipt.requestKey}</p> : null}
    <div className={styles.form}>
      <label className={styles.field}><span>预设赠送账号</span><select aria-label="预设赠送账号" value={userId} disabled={readOnly} onChange={event => setUserId(event.target.value)}><option value="">请选择启用中的账号</option>
        {saved?.kind === "save" && !users.some(user => user.id === saved.payload.userId) ? <option value={saved.payload.userId}>{saved.payload.userId} · 当前账号信息未取得</option> : null}
        {users.filter(user => user.status === "active" || saved?.kind === "save" && user.id === saved.payload.userId).map(user => <option key={user.id} value={user.id}>{user.name}（{user.username}）{user.status === "active" ? "" : " · 已停用"}</option>)}
      </select></label>
      <label className={styles.field}><span>预设积分</span><input aria-label="预设积分" inputMode="decimal" value={quantity} disabled={readOnly} placeholder="例如 100.5" onChange={event => setQuantity(event.target.value)} /></label>
      <label className={`${styles.field} ${styles.reason}`}><span>预设赠送理由</span><textarea aria-label="预设赠送理由" value={reason} disabled={readOnly} rows={2} maxLength={500} onChange={event => setReason(event.target.value)} /></label>
      <label className={styles.field}><span>截止时间（北京时间，未来 30 天内）</span><input aria-label="预设截止时间" type="datetime-local" value={deadline} disabled={readOnly} onChange={event => setDeadline(event.target.value)} /></label>
    </div>
    <p className={styles.preview}>保存即授权此账号、数量、理由和截止时间：条件满足时可能立即赠送；未执行的预设会保留，后续完整核验成功会继续检查。截止后不再执行。</p>
    {!saved && target && amount !== null && expiresAt ? <p className={styles.hint}>将向 {target.name}（{target.username}）赠送 {points(amount)} 积分；截止 {time(expiresAt)}；理由：{reason.trim() || "尚未填写"}。</p> : null}
    <div className={styles.actions}>{saved ? <button type="button" className={styles.primary} disabled={busy || !!storageError} onClick={() => send(saved)}>{busy ? "处理原预设中…" : "原样重试预设操作"}</button>
      : <button type="button" className={styles.primary} disabled={!canSave} onClick={submit}>{busy ? "保存预设中…" : "保存预设并尝试赠送"}</button>}</div>
    {!saved && !canSave && !readOnly ? <p className={styles.hint}>请填写启用中的目标账号、大于 0 且最多 1 位小数的积分、2 至 500 字理由及未来 30 天内的截止时间。</p> : null}
    {saved ? <p className={styles.pending}>原操作待核对，当前不会创建另一笔授权。{saved.kind === "save" ? `保存预设：${saved.payload.userId}，${saved.payload.points} 积分，截止 ${time(saved.payload.expiresAt)}；理由：${saved.payload.reason}。` : `取消预设：${saved.plan.userId}，${points(saved.plan.amountCents)} 积分。`}原编号：{saved.kind === "save" ? saved.payload.requestKey : saved.plan.requestKey}。</p> : null}
    <section className={styles.history} aria-label="我的预设赠送记录"><h3>我的预设赠送记录</h3>
      {overview?.plans.length ? <div className={styles.tableWrap}><table><thead><tr><th>账号 / 积分</th><th>状态</th><th>截止时间</th><th>理由 / 编号</th><th>操作</th></tr></thead><tbody>{overview.plans.map(plan => {
        const user = users.find(row => row.id === plan.userId);
        return <tr key={plan.id}><td>{user ? `${user.name}（${user.username}）` : plan.userId}<small>{points(plan.amountCents)} 积分</small></td>
          <td>{stateLabel[plan.status]}{plan.lastCode ? <small>{issue(plan.lastCode, "执行条件暂未满足。")}</small> : null}{plan.executedAt ? <small>完成：{time(plan.executedAt)}</small> : null}</td>
          <td>{time(plan.expiresAt)}</td><td>{plan.reason}<small>{plan.requestKey}</small></td><td>{["pending", "blocked"].includes(plan.status) ? <button type="button" className={styles.secondary} disabled={readOnly} onClick={() => send({ kind: "cancel", plan })}>取消预设</button> : "—"}</td></tr>;
      })}</tbody></table></div> : <p className={styles.hint}>{overview ? "暂无预设赠送；填写并保存后才会创建。" : "预设记录尚未读取。"}</p>}
    </section>
  </section>;
}
