"use client";

import { Check, Clock3, LoaderCircle, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AWAITING_CREDIT_ALLOCATION_LABEL, isGatewayOrderAwaitingCapacity } from "@/lib/model-gateway/scan-payment-contract";
import styles from "./ScanPaymentDialog.module.css";

export type ScanPaymentPlan = { code: string; name: string; priceCents: number; creditCents: number };
export type ScanPaymentProvider = "alipay" | "wechat";
export type ScanCheckoutOrder = {
  id: string; planCode: string; planName: string; amountCents: number; creditCents: number;
  paymentProvider: string; status: string; paymentUrl: string; qrCodeDataUrl: string | null;
  creditAllocationState?: string;
  expiresAt: string | null; paidAt: string | null; createdAt: string;
  checkoutMode?: "qr" | "alipay_page"; cashierUrl?: string | null; fallbackCashierUrl?: string | null;
};
type ProviderOption = { provider: ScanPaymentProvider; available: boolean };
type Props = {
  open: boolean; plans: ScanPaymentPlan[]; initialPlanCode?: string; resumeOrderId?: string;
  onClose: () => void; onPaid?: (order: ScanCheckoutOrder, signal?: AbortSignal) => void | Promise<void>;
};
const providerNames = { alipay: "支付宝", wechat: "微信支付" };
const providerList: ScanPaymentProvider[] = ["alipay", "wechat"];
const money = (cents: number) => (cents / 100).toFixed(2);
// Display only: wallet and order values continue to use integer RMB cents.
const points = (cents: number) => (cents / 10).toLocaleString("zh-CN", { maximumFractionDigits: 1 });

export function paymentTimeRemaining(expiresAt: string | null, now: number) {
  if (!expiresAt) return null;
  const end = Date.parse(expiresAt);
  return Number.isFinite(end) ? Math.max(0, Math.ceil((end - now) / 1000)) : 0;
}

export function officialAlipayCashierUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value || /[\u0000-\u0020\u007f\\]/.test(value) || value.includes("#")) return null;
  try {
    const url = new URL(value);
    const authority = value.match(/^https:\/\/([^/?#]+)/i)?.[1];
    if (!authority || authority.includes("@") || url.protocol !== "https:" || url.hostname !== "openapi.alipay.com" ||
        url.pathname !== "/gateway.do" || url.username || url.password || url.hash || (url.port && url.port !== "443")) return null;
    return url.href;
  } catch { return null; }
}

function providerName(provider: string) {
  return provider === "alipay" || provider === "wechat" ? providerNames[provider] : "人工确认";
}

function PaymentMark({ provider }: { provider: ScanPaymentProvider }) {
  return <span aria-hidden="true" className={`${styles.paymentMark} ${provider === "wechat" ? styles.wechatMark : styles.alipayMark}`}>
    {provider === "alipay" ? "支" : <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.2 3.6c-4 0-7.2 2.5-7.2 5.6 0 1.7 1 3.3 2.5 4.3L4 15.9l2.9-1.5 1.4.3a5.6 5.6 0 0 1-.5-2.3c0-3.3 3.3-5.9 7.3-5.9h.4a7.5 7.5 0 0 0-6.3-2.9Zm-2.4 3a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Zm4.6 0a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Z"/><path d="M21.9 12.5c0-2.7-2.9-4.9-6.4-4.9s-6.4 2.2-6.4 4.9 2.9 4.9 6.4 4.9l1.9-.2 2.4 1.2-.5-2a4.9 4.9 0 0 0 2.6-3.9Zm-8.6-1.9a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6Zm4.4 0a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6Z"/></svg>}
  </span>;
}

async function paymentDeadline<T>(work: Promise<T>, signal: AbortSignal, cancelWork?: () => void): Promise<T> {
  let timer: number | undefined;
  let cancel = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      cancel = () => { cancelWork?.(); reject(new Error("支付查询已取消。")); };
      signal.addEventListener("abort", cancel, { once: true });
      timer = window.setTimeout(() => {
        cancelWork?.(); reject(new Error("支付结果查询超时，将自动重试，也可再次点击查询。"));
      }, 15000);
      if (signal.aborted) cancel();
    })]);
  } finally { window.clearTimeout(timer); signal.removeEventListener("abort", cancel); }
}

async function readPaymentResponse(url: string, signal: AbortSignal) {
  const request = new AbortController();
  return paymentDeadline((async () => {
    const response = await fetch(url, { cache: "no-store", signal: request.signal });
    const body = response.status === 401 ? null : await response.json().catch(() => null);
    return { response, body };
  })(), signal, () => request.abort());
}

export function ScanPaymentDialog({ open, plans, initialPlanCode, resumeOrderId, onClose, onPaid }: Props) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const requestBusy = useRef(false);
  const queryBusy = useRef(false);
  const returnTimer = useRef<number | null>(null);
  const settledIds = useRef(new Set<string>());
  const orderGeneration = useRef(0);
  const orderTarget = useRef<string | null>(null);
  const callbacks = useRef({ onClose, onPaid });
  callbacks.current = { onClose, onPaid };
  const [planCode, setPlanCode] = useState(initialPlanCode || plans[0]?.code || "");
  const [provider, setProvider] = useState<ScanPaymentProvider | null>(null);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [querying, setQuerying] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [refreshingAccount, setRefreshingAccount] = useState(false);
  const [resumeActive, setResumeActive] = useState(!!resumeOrderId);
  const [order, setOrder] = useState<ScanCheckoutOrder | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [cashierLoad, setCashierLoad] = useState<{ url: string; status: "loading" | "loaded" | "failed" | "slow" } | null>(null);
  const [now, setNow] = useState(Date.now());
  const plan = plans.find(value => value.code === planCode) || plans[0];
  const resumeTarget = resumeActive ? resumeOrderId : undefined;
  const remaining = order ? paymentTimeRemaining(order.expiresAt, now) : null;
  const awaitingCapacity = isGatewayOrderAwaitingCapacity(order);
  const paid = order?.status === "paid" && !awaitingCapacity;
  const expired = !paid && !awaitingCapacity && !!order && (order.status === "expired" || remaining === 0);
  const closed = !paid && !!order && ["closed", "cancelled", "failed"].includes(order.status);
  const manual = !!order && !providerList.includes(order.paymentProvider as ScanPaymentProvider);
  const qrCode = !awaitingCapacity && order?.qrCodeDataUrl && /^data:image\/(?:png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(order.qrCodeDataUrl) ? order.qrCodeDataUrl : null;
  const alipayPage = !awaitingCapacity && order?.paymentProvider === "alipay" && order.checkoutMode === "alipay_page";
  const cashierUrl = alipayPage ? officialAlipayCashierUrl(order?.cashierUrl) : null;
  const fallbackCashierUrl = alipayPage ? officialAlipayCashierUrl(order?.fallbackCashierUrl) || cashierUrl : null;
  const cashierStatus = cashierLoad?.url === cashierUrl ? cashierLoad?.status : "loading";

  useEffect(() => {
    if (!open || !cashierUrl || paid || expired || closed || authRequired) { setCashierLoad(null); return; }
    setCashierLoad({ url: cashierUrl, status: "loading" });
    const timer = window.setTimeout(() => {
      setCashierLoad(previous => previous?.url === cashierUrl && previous.status === "loading" ? { url: cashierUrl, status: "slow" } : previous);
    }, 12000);
    return () => window.clearTimeout(timer);
  }, [open, cashierUrl, paid, expired, closed, authRequired]);

  const refreshPaidAccount = useCallback(async (next: ScanCheckoutOrder) => {
    const session = controllerRef.current;
    if (!session || session.signal.aborted) return;
    setNotice("");
    setRefreshingAccount(true);
    const refresh = new AbortController();
    try {
      await paymentDeadline(Promise.resolve().then(() => callbacks.current.onPaid?.(next, refresh.signal)), session.signal, () => refresh.abort());
      if (!session || session.signal.aborted || controllerRef.current !== session) return;
      if (returnTimer.current !== null) window.clearTimeout(returnTimer.current);
      returnTimer.current = window.setTimeout(() => {
        if (!session.signal.aborted && controllerRef.current === session) callbacks.current.onClose();
      }, 1500);
    } catch {
      if (session && !session.signal.aborted && controllerRef.current === session) {
        setNotice("支付已成功，余额刷新失败，请重试刷新账户。");
      }
    } finally { if (!session.signal.aborted && controllerRef.current === session) setRefreshingAccount(false); }
  }, []);

  const acceptOrder = useCallback((next: ScanCheckoutOrder) => {
    setOrder(next); setNow(Date.now());
    if (next.status !== "paid" || isGatewayOrderAwaitingCapacity(next) || settledIds.current.has(next.id)) return;
    settledIds.current.add(next.id);
    window.dispatchEvent(new CustomEvent("sanjie:payment-paid", { detail: { orderId: next.id } }));
    void refreshPaidAccount(next);
  }, [refreshPaidAccount]);

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    controllerRef.current = abort;
    const generation = ++orderGeneration.current;
    orderTarget.current = resumeOrderId || null;
    requestBusy.current = false; queryBusy.current = false;
    settledIds.current.clear();
    setPlanCode(initialPlanCode || plans[0]?.code || "");
    setProvider(null); setOrder(null); setProviders([]); setError(""); setNotice("");
    setAuthRequired(false); setRefreshingAccount(false); setResumeActive(!!resumeOrderId);
    setLoading(true); setBusy(false); setQuerying(false); setNow(Date.now());
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); callbacks.current.onClose(); return; }
      if (event.key !== "Tab") return;
      const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], select:not([disabled]), iframe, [tabindex="0"]') || []);
      const first = items[0], last = items.at(-1);
      if (!first) { event.preventDefault(); dialogRef.current?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKeyDown);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    (async () => {
      try {
        const response = await fetch("/api/model-gateway/checkout", { cache: "no-store", signal: abort.signal });
        if (response.status === 401) { if (!abort.signal.aborted) setAuthRequired(true); return; }
        const body = await response.json().catch(() => null);
        if (!response.ok || !Array.isArray(body?.data?.providers)) throw new Error(body?.error || "支付方式读取失败，请关闭弹窗后重试。");
        if (!abort.signal.aborted) setProviders(body.data.providers);
      } catch (failure) {
        if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : "支付方式读取失败，请重试。");
      } finally { if (!abort.signal.aborted) setLoading(false); }
    })();
    if (resumeOrderId) {
      queryBusy.current = true; setQuerying(true);
      (async () => {
        try {
          const { response, body } = await readPaymentResponse(`/api/model-gateway/checkout/${encodeURIComponent(resumeOrderId)}`, abort.signal);
          if (abort.signal.aborted || orderGeneration.current !== generation) return;
          if (response.status === 401) { if (!abort.signal.aborted) setAuthRequired(true); return; }
          if (!response.ok || !body?.data?.order) throw new Error(body?.error || "订单读取失败，请重试。");
          if (body.data.order.id !== resumeOrderId) throw new Error("订单信息不一致，请重新查询。");
          if (!abort.signal.aborted) acceptOrder(body.data.order);
        } catch (failure) {
          if (!abort.signal.aborted && orderGeneration.current === generation) setError(failure instanceof Error ? failure.message : "订单读取失败，请重试。");
        } finally { if (controllerRef.current === abort) { queryBusy.current = false; if (!abort.signal.aborted) setQuerying(false); } }
      })();
    }
    return () => {
      abort.abort(); window.clearInterval(timer); document.removeEventListener("keydown", onKeyDown);
      if (returnTimer.current !== null) { window.clearTimeout(returnTimer.current); returnTimer.current = null; }
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
    // Plans are server-provided display data; a parent refresh must not reset an active order.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPlanCode, resumeOrderId, acceptOrder]);

  const queryOrder = useCallback(async (current: Pick<ScanCheckoutOrder, "id" | "paymentProvider">, userInitiated = false) => {
    const abort = controllerRef.current;
    if (!abort || abort.signal.aborted || queryBusy.current) return;
    const generation = orderGeneration.current;
    if (orderTarget.current !== current.id) return;
    queryBusy.current = true; setQuerying(true);
    if (userInitiated) { setError(""); setNotice(""); }
    try {
      const route = providerList.includes(current.paymentProvider as ScanPaymentProvider) ? "checkout" : "orders";
      const { response, body } = await readPaymentResponse(`/api/model-gateway/${route}/${encodeURIComponent(current.id)}`, abort.signal);
      if (abort.signal.aborted || orderGeneration.current !== generation || orderTarget.current !== current.id) return;
      if (response.status === 401) { setAuthRequired(true); setError(""); return; }
      if (!response.ok || !body?.data?.order) throw new Error(body?.error || "支付结果查询失败，请稍后重试。");
      if (body.data.order.id !== current.id) throw new Error("订单信息不一致，请重新查询。");
      setAuthRequired(false); acceptOrder(body.data.order); setError("");
      if (userInitiated && body.data.order.status === "pending" && !isGatewayOrderAwaitingCapacity(body.data.order)) setNotice(route === "orders" ? "尚未确认到账，请联系管理员核对付款凭证。" : "尚未收到支付确认，请稍后重试。");
    } catch (failure) {
      if (!abort.signal.aborted && orderGeneration.current === generation) setError(failure instanceof Error ? failure.message : "支付结果查询失败，请稍后重试。");
    } finally {
      if (controllerRef.current === abort) { queryBusy.current = false; if (!abort.signal.aborted) setQuerying(false); }
    }
  }, [acceptOrder]);

  useEffect(() => {
    const current = order || (resumeTarget ? { id: resumeTarget, paymentProvider: "alipay" } : null);
    if (!open || !current || (order && !["pending", "expired", "awaiting_capacity"].includes(order.status)) || closed || manual || authRequired) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void queryOrder(current);
    }, expired || awaitingCapacity ? 15000 : 5000);
    return () => window.clearInterval(timer);
  }, [open, order?.id, order?.status, order?.paymentProvider, resumeTarget, expired, awaitingCapacity, closed, manual, authRequired, queryOrder]);

  useEffect(() => {
    if (!open || paid || closed || manual) return;
    const current = order || (resumeTarget ? { id: resumeTarget, paymentProvider: "alipay" } : null);
    if (!current) return;
    const resume = () => { if (document.visibilityState !== "hidden") void queryOrder(current); };
    window.addEventListener("focus", resume); document.addEventListener("visibilitychange", resume);
    return () => { window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", resume); };
  }, [open, order?.id, order?.paymentProvider, resumeTarget, paid, closed, manual, queryOrder]);

  function leaveOrder() {
    orderGeneration.current++; orderTarget.current = null;
    setResumeActive(false); setOrder(null); setProvider(null); setError(""); setNotice("");
  }

  async function createOrder(useManual = false) {
    const abort = controllerRef.current;
    if (!plan || !abort || abort.signal.aborted || requestBusy.current || order || resumeTarget || authRequired) return;
    if (!useManual && (!provider || !providers.some(item => item.provider === provider && item.available))) return;
    requestBusy.current = true; setBusy(true); setError(""); setNotice("");
    const generation = orderGeneration.current;
    try {
      const response = await fetch(`/api/model-gateway/${useManual ? "orders" : "checkout"}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: abort.signal,
        body: JSON.stringify(useManual ? { planCode: plan.code } : { planCode: plan.code, provider })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.data?.order) throw new Error(body?.error || "订单创建失败，请重试。");
      if (!abort.signal.aborted && orderGeneration.current === generation) { orderTarget.current = body.data.order.id; acceptOrder(body.data.order); }
    } catch (failure) {
      if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : "网络异常，请稍后重试。");
    } finally {
      if (!abort.signal.aborted) { requestBusy.current = false; setBusy(false); }
    }
  }

  if (!open || typeof document === "undefined") return null;

  return createPortal(<div className={styles.overlay} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={styles.dialog} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <div className={styles.header}><h2 id={titleId}>支持支付宝、微信支付</h2><button ref={closeButtonRef} className={styles.close} type="button" aria-label="关闭收款弹窗" onClick={onClose}><X size={17} /></button></div>
      <div className={styles.content}>
        <p className={styles.planName}>三阶引擎 · {order?.planName || plan?.name || "充值"}</p>
        <p className={styles.amount}><span>¥</span>{money(order?.amountCents ?? plan?.priceCents ?? 0)}</p>
        <p className={styles.credit}>{awaitingCapacity ? "待分配" : "到账"} {points(order?.creditCents ?? plan?.creditCents ?? 0)} 积分</p>
        {authRequired && !paid ? <div className={styles.result} role="status"><Clock3 size={36} /><h3>登录已失效</h3><p>暂时无法核验支付结果，请勿重复付款。在新窗口登录同一网站账号后，返回此页将自动查询。</p>{order || resumeTarget ? <p>订单号 <code>{order?.id || resumeTarget}</code></p> : null}<a className={styles.cashierFallback} href="/login" target="_blank" rel="noopener noreferrer">在新窗口重新登录</a></div> : !order && resumeTarget ? <div className={styles.result} role="status"><Clock3 size={36} /><h3>正在恢复原订单</h3><p>核验订单 <code>{resumeTarget}</code>，请勿重复付款。</p><button type="button" className={styles.primary} disabled={querying} onClick={() => void queryOrder({ id: resumeTarget, paymentProvider: "alipay" }, true)}>{querying ? "查询中…" : "重新查询原订单"}</button><button type="button" className={styles.manual} disabled={querying} onClick={leaveOrder}>退出此订单恢复</button></div> : !order ? <>
          {plans.length > 1 ? <label className={styles.planPicker}>充值套餐<select aria-label="充值套餐" value={plan?.code || ""} disabled={busy || querying} onChange={event => setPlanCode(event.target.value)}>{plans.map(item => <option key={item.code} value={item.code}>{item.name} · ¥{money(item.priceCents)}</option>)}</select></label> : null}
          <div className={styles.channels} aria-label="支付方式">
            {providerList.map(value => {
              const available = providers.some(item => item.provider === value && item.available);
              return <button key={value} type="button" aria-pressed={provider === value} disabled={!available || loading || busy || querying} onClick={() => { setProvider(value); setError(""); }}>
                <PaymentMark provider={value} /><span>{providerNames[value]}<small>{loading ? "读取中" : available ? "扫码支付" : "暂未开通"}</small></span>{provider === value ? <Check className={styles.selected} size={15} /> : null}
              </button>;
            })}
          </div>
          {!loading && !providers.some(item => item.available) ? <p className={styles.hint}>扫码支付暂未开通，可联系管理员人工充值。</p> : <p className={styles.hint}>选择支付方式，使用对应 App 扫码。</p>}
          <button type="button" className={styles.primary} disabled={!provider || busy || querying || loading || !plan} onClick={() => void createOrder()}>{busy ? <><LoaderCircle size={16} className={styles.spinning} />正在生成订单…</> : provider ? `生成${providerNames[provider]}收款码` : "请选择支付方式"}</button>
          <button type="button" className={styles.manual} disabled={busy || querying || !plan} onClick={() => void createOrder(true)}>联系管理员 · 创建人工充值订单</button>
        </> : awaitingCapacity ? <div className={styles.result} role="status"><Clock3 size={36} /><h3>{AWAITING_CREDIT_ALLOCATION_LABEL}</h3><p>此订单已核验收款，积分暂未计入余额。请勿再次付款；可查询原订单的分配状态，或联系管理员核对。</p><p>订单号 <code>{order.id}</code></p><button type="button" className={styles.primary} onClick={onClose}>关闭</button></div> : paid ? <div className={styles.result} role="status"><span className={styles.successIcon}><Check size={28} /></span><h3>支付成功</h3><p>积分已到账，刷新账户后将自动返回。</p>{notice.includes("刷新失败") ? <button type="button" className={styles.primary} disabled={refreshingAccount} onClick={() => void refreshPaidAccount(order)}>重试刷新账户</button> : <button type="button" className={styles.primary} onClick={onClose}>完成</button>}</div> : expired || closed ? <div className={styles.result} role="status"><Clock3 size={36} /><h3>{expired ? "二维码已过期" : "订单已关闭"}</h3><p>{expired ? "付款入口已关闭，仍会自动核验此订单。已付款请勿重复下单。" : "订单已关闭，已付款可查询支付结果。"}</p><button type="button" className={styles.primary} disabled={querying} onClick={leaveOrder}>重新选择支付方式</button></div> : manual ? <div className={styles.manualOrder}><h3>人工充值 · 等待确认</h3><p>请联系管理员获取收款方式，付款后提供订单号和付款凭证。</p>{order.paymentUrl && /^https:\/\//i.test(order.paymentUrl) ? <a href={order.paymentUrl} target="_blank" rel="noopener noreferrer">打开收款页面</a> : null}<p>订单号<code>{order.id}</code></p></div> : <>
          {alipayPage ? <>
            <div className={`${styles.qrFrame} ${styles.cashierFrame}`}>
              {cashierUrl && cashierStatus !== "failed" ? <iframe key={cashierUrl} src={cashierUrl} title="支付宝官方收银台二维码" width={240} height={280}
                className={styles.cashierIframe} sandbox="allow-scripts allow-forms allow-same-origin"
                allow="camera 'none'; microphone 'none'; geolocation 'none'" referrerPolicy="no-referrer"
                onLoad={() => setCashierLoad({ url: cashierUrl, status: "loaded" })}
                onError={() => setCashierLoad({ url: cashierUrl, status: "failed" })} /> : <div className={styles.qrUnavailable}><RefreshCw size={26} /><p>{cashierUrl ? "支付宝收银台加载失败" : "支付宝收银台暂不可用"}</p><small>{fallbackCashierUrl ? "请在新窗口打开官方收银台" : "请稍后重新查询订单"}</small></div>}
            </div>
            {cashierUrl && cashierStatus === "loading" ? <p className={styles.cashierHint} role="status">正在加载支付宝官方收银台…</p> : null}
            {cashierUrl && cashierStatus === "slow" ? <p className={styles.cashierHint} role="status">收银台加载较慢，可在新窗口继续付款。</p> : null}
            {fallbackCashierUrl ? <><a className={styles.cashierFallback} href={fallbackCashierUrl} target="_blank" rel="noopener noreferrer">在新窗口打开支付宝收银台</a><p className={styles.cashierHint}>二维码未显示时，可在新窗口继续付款。</p></> : null}
          </> : <>
            {/* eslint-disable-next-line @next/next/no-img-element -- The server returns an inline payment QR data URL; no image optimization request is needed. */}
            <div className={styles.qrFrame}>{qrCode ? <img src={qrCode} width={200} height={200} alt={`使用${providerName(order.paymentProvider)}扫描此订单二维码付款`} /> : <div className={styles.qrUnavailable}><RefreshCw size={26} /><p>收款码暂不可用</p><small>请点击下方按钮重新查询</small></div>}</div>
          </>}
          <div className={styles.scanHint}><PaymentMark provider={order.paymentProvider as ScanPaymentProvider} /><span>请使用{providerName(order.paymentProvider)}扫一扫</span></div>
          <p className={styles.waiting}><span />正在等待支付结果</p>
        </>}
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        {notice && !paid ? <p className={styles.notice} role="status">{notice}</p> : null}
        {notice && paid && notice.includes("刷新失败") ? <p className={styles.notice} role="status">{notice}</p> : null}
      </div>
      <div className={styles.footer}>{order && !paid ? <><span><Clock3 size={12} />{awaitingCapacity ? "积分待分配" : expired ? "已过期" : closed ? "已关闭" : manual ? "人工确认到账" : remaining == null ? "等待支付" : `${Math.floor(remaining / 60).toString().padStart(2, "0")}:${(remaining % 60).toString().padStart(2, "0")}`}</span><button type="button" onClick={() => void queryOrder(order, true)} disabled={querying}><RefreshCw size={12} className={querying ? styles.spinning : ""} />{querying ? "查询中…" : awaitingCapacity ? "查询分配状态" : "我已完成支付"}</button></> : <span className={styles.secure}><ShieldCheck size={13} />三阶引擎 · 账户充值</span>}</div>
    </div>
  </div>, document.body);
}
