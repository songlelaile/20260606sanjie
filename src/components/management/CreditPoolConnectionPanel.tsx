"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { isCreditPoolManagementOverview, isCreditPoolProposalView, isCreditPoolOperationReceipt, parseCreditPoolApplyInput, parseCreditPoolOperation, parseCreditPoolRequestKey,
  type CreditPoolManagementOverview, type CreditPoolProposalView, type CreditPoolApplyInput, type CreditPoolOperation } from "@/lib/model-gateway/credit-pool-management-contract";
import { isCreditPoolObservation, type CreditPoolObservation, type RelaySupplyObservation, type RelayGroupObservation } from "@/lib/model-gateway/credit-pool-observation-contract";
const ENDPOINT = "/api/management/credit-pool";
const localPoints = (cents: string) => { const value = BigInt(cents); return `${value / 10n}${value % 10n ? `.${value % 10n}` : ""}`; };
type ObservedSupply = Omit<RelaySupplyObservation, "groups"> & { groups: (RelayGroupObservation & {
  groupObservedAt: string | null; usageObservedAt: string | null; capacityObservedAt: string | null;
})[] };
function rememberSupply(previous: ObservedSupply | null, current: RelaySupplyObservation): ObservedSupply {
  const before = new Map(previous?.groups.map(group => [group.groupId, group]));
  const groups: ObservedSupply["groups"] = current.groups.map(group => {
    const old = before.get(group.groupId); before.delete(group.groupId);
    return { ...group, groupObservedAt: current.observedAt,
      usage: group.usage ?? old?.usage ?? null, usageObservedAt: group.usage ? current.observedAt : old?.usageObservedAt ?? null,
      capacity: group.capacity ?? old?.capacity ?? null, capacityObservedAt: group.capacity ? current.observedAt : old?.capacityObservedAt ?? null };
  });
  if (current.status === "partial") groups.push(...before.values());
  return { ...current, groups };
}
type SavedOperation = { operation: CreditPoolOperation; input: CreditPoolApplyInput };
function savedOperation(value: unknown): SavedOperation {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "input,operation") throw new Error("invalid saved operation");
  const row = value as Record<string, unknown>; return { operation: parseCreditPoolOperation(row.operation), input: parseCreditPoolApplyInput(row.input) };
}
const data = (body: unknown): unknown => body && typeof body === "object" && "data" in body ? body.data : null;
type SourceReadIssue = { code: string; status: number | null; state: "uncertain"; message: string };
const SOURCE_READ_REASONS: Record<string, string> = {
  AUTH_REQUIRED: "管理员登录已失效，请重新登录。",
  ADMIN_REQUIRED: "当前账号没有来源核对权限，请使用启用中的平台管理员账号。",
  SHARED_SOURCE_NOT_CONFIGURED: "共用钱包额度读取尚未配置，请检查后台来源连接。",
  SHARED_SOURCE_CONFIG_UNAVAILABLE: "共用钱包来源配置暂时无法读取，请检查后台连接配置。",
  SOURCE_TIMEOUT: "上游余额读取超时。",
  SOURCE_TRANSPORT_FAILED: "上游余额连接暂时中断，请检查后台网络连接。",
  SOURCE_UNAVAILABLE: "上游余额服务暂时不可用。",
  SOURCE_RATE_LIMITED: "上游余额读取暂时受到限流，请稍后核对连接状态。",
  RATE_LIMITED: "来源核对请求暂时受到限流，请稍后核对连接状态。",
  SOURCE_AUTH_REQUIRED: "上游来源连接鉴权已失效，请检查后台连接凭据。",
  SOURCE_ACCESS_DENIED: "上游来源连接没有读取权限，请核对后台连接权限。",
  SOURCE_REDIRECT_REJECTED: "上游余额接口发生未批准的跳转，请核对后台来源地址。",
  SOURCE_RESPONSE_STATUS_INVALID: "上游余额接口返回了无法核验的状态。",
  SOURCE_CONTENT_TYPE_INVALID: "上游余额回执格式不符合核验要求。",
  SOURCE_RESPONSE_TOO_LARGE: "上游余额回执超过核验大小上限。",
  SOURCE_JSON_INVALID: "上游余额回执结构无法解析。",
  SOURCE_JSON_DUPLICATE_KEY: "上游余额回执包含重复字段，无法安全核验。",
  SOURCE_USD_INVALID: "上游余额金额格式无法核验。",
  SOURCE_WALLET_SCOPE_CHANGED: "上游钱包的授权范围或状态已变化，请核对来源绑定。",
  SOURCE_BALANCE_INCONSISTENT: "上游余额字段不一致，资金覆盖尚未完成核验。",
  SOURCE_STALE: "上游余额记录已过期，请先核对连接状态。",
  SOURCE_READ_UNAVAILABLE: "上游余额读取暂时不可用，请检查后台来源连接。",
  FX_RATE_STALE: "后台汇率快照已过期，请先更新汇率。",
  FX_RATE_UNAVAILABLE: "后台汇率快照尚未就绪，请先核对汇率配置。",
  INVALID_FX_SNAPSHOT: "后台汇率快照无法核验，请检查汇率配置。",
  POOL_FX_CHANGED: "来源核对使用的汇率依据已变化，请检查后台汇率。",
  POOL_PRICING_CHANGED: "来源核对使用的计价规则已变化，请核对后台定价。",
  POOL_QUOTE_UNBACKED: "当前报价未满足资金覆盖保护条件，请核对来源及后台汇率与定价依据。",
  POOL_SOURCE_UNVERIFIED: "来源记录尚未完成核验，请检查后台来源连接。",
  HOLD_PRICE_UNPROVEN: "有未完成任务的原始汇率或计价凭证尚未通过核验，分配额度暂不可用；仍可查看余额，并按真实任务结果继续对账。",
  CREDIT_POOL_INVALID: "总积分池账本或来源状态异常，请核对后台记录。",
  BACKING_SHORTFALL: "上游余额不足以覆盖已分配积分，请核对覆盖缺口。",
  CREDIT_POOL_SERVICE_UNAVAILABLE: "来源核对服务暂时不可用。",
  SOURCE_RESPONSE_INVALID: "来源核对回执无法读取。",
  SOURCE_NETWORK_UNCONFIRMED: "来源核对请求的网络回执中断。"
};
const diagnosticCode = (value: unknown, fallback: string) => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,95}$/.test(value) ? value : fallback;
const observedTime = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "尚无读取时间";
function observationMessage(code: string | null, fallback: string) {
  return `${code && SOURCE_READ_REASONS[code] ? SOURCE_READ_REASONS[code] : fallback}${code ? `（诊断标识：${diagnosticCode(code, "OBSERVATION_UNAVAILABLE")}）` : ""}`;
}
function sourceReadIssue(body: unknown, status: number | null, fallback = "SOURCE_READ_UNCONFIRMED"): SourceReadIssue {
  const raw = body && typeof body === "object" && "code" in body ? body.code : null;
  const code = diagnosticCode(raw, fallback);
  return { code, status, state: "uncertain", message: `${observationMessage(code, "来源核对暂时无法完成。")}读取结果尚未确认，来源快照或总池状态可能已更新；可查看当前状态，并重试原核验请求。` };
}
/** Explicit administrator reading and adoption; only immutable refs enter financial requests. */
export function CreditPoolConnectionPanel({ initialOverview = null, adminId = "" }: { initialOverview?: CreditPoolManagementOverview | null; adminId?: string }) {
  const [overview, setOverview] = useState(initialOverview), [loading, setLoading] = useState(!initialOverview), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [proposal, setProposal] = useState<CreditPoolProposalView | null>(null);
  const [pending, setPending] = useState<SavedOperation | null>(null), [notice, setNotice] = useState("");
  const [storageError, setStorageError] = useState("");
  const [sourceStorageError, setSourceStorageError] = useState("");
  const [sourceRequestKey, setSourceRequestKey] = useState<string | null>(null);
  const sourceRequestRef = useRef<string | null>(null);
  const [overviewStale, setOverviewStale] = useState(false);
  const [sourceIssue, setSourceIssue] = useState<SourceReadIssue | null>(null);
  const [observation, setObservation] = useState<CreditPoolObservation | null>(null);
  const [lastWallet, setLastWallet] = useState<CreditPoolObservation["wallet"] | null>(null);
  const [lastLedger, setLastLedger] = useState<CreditPoolManagementOverview | null>(null);
  const [lastSupply, setLastSupply] = useState<ObservedSupply | null>(null);
  const [observing, setObserving] = useState(false), [observationError, setObservationError] = useState<string | null>(null);
  const observationInFlight = useRef(false);
  const sourceReadState = useRef<"idle" | "reading" | "uncertain">("idle"), sourceReadRevision = useRef(0);
  const savedRef = useRef<SavedOperation | null>(null);
  const storageKey = `sanjie-pool-operation-v1:${encodeURIComponent(adminId)}`;
  const sourceStorageKey = `sanjie-pool-verification-v1:${encodeURIComponent(adminId)}`;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const revision = sourceReadRevision.current;
    setLoading(true); if (!sourceRequestRef.current) setError("");
    try { const response = await fetch(ENDPOINT, { cache: "no-store", credentials: "same-origin", signal }); const result = data(await response.json());
      if (!response.ok || !isCreditPoolManagementOverview(result)) throw new Error("invalid overview"); if (!signal?.aborted) {
        setOverview(result);
        setOverviewStale(false);
        // A status GET cannot acknowledge a source verification or replenish its
        // allocation window. Only the original POST receipt can release its key.
        if (revision === sourceReadRevision.current && sourceReadState.current !== "reading" && !sourceRequestRef.current) { sourceReadState.current = "idle"; setSourceIssue(null); }
      }
    } catch { if (!signal?.aborted) { setOverviewStale(true); setError("上游额度连接状态读取失败，请重试核对；已有记录保留为历史读值。"); } }
    finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    if (adminId) { try { const raw = window.sessionStorage.getItem(storageKey); if (raw) { const saved = savedOperation(JSON.parse(raw)); savedRef.current = saved; setPending(saved); } }
      catch { setStorageError("浏览器中的原操作记录无法读取，请先核对原操作；当前不能发起新采用。"); } }
    if (adminId) { try {
      const raw = window.sessionStorage.getItem(sourceStorageKey);
      if (raw !== null) {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join() !== "requestKey" || !("requestKey" in value)) throw new Error("invalid verification reference");
        const key = parseCreditPoolRequestKey(value.requestKey); sourceRequestRef.current = key; setSourceRequestKey(key); sourceReadState.current = "uncertain";
      }
    } catch { setSourceStorageError("浏览器中的原核验请求无法读取，当前不能发起新的分配核验；仍可查看余额与对账状态。"); } }
    const abort = new AbortController(); void refresh(abort.signal); return () => abort.abort();
  }, [adminId, storageKey, sourceStorageKey, refresh]);
  async function observe() {
    // Viewing has its own request state: a pending financial operation or broken
    // session storage must never prevent an administrator from reading facts.
    if (observationInFlight.current) return;
    observationInFlight.current = true; setObserving(true); setObservationError(null);
    let failureCode = "OBSERVATION_TRANSPORT_FAILED";
    try {
      const response = await fetch(`${ENDPOINT}/observe`, { method: "GET", cache: "no-store", credentials: "same-origin" });
      failureCode = "OBSERVATION_RESPONSE_INVALID";
      const body: unknown = await response.json();
      if (!response.ok) {
        failureCode = diagnosticCode(body && typeof body === "object" && "code" in body ? body.code : null, "OBSERVATION_UNAVAILABLE");
        throw new Error("observation unavailable");
      }
      const result = data(body);
      if (!isCreditPoolObservation(result)) throw new Error("invalid observation");
      setObservation(result);
      if (result.wallet.status === "ok") setLastWallet(result.wallet);
      if (result.ledger.status === "ok") setLastLedger(result.ledger.overview);
      if (result.supply.status === "ok" || result.supply.status === "partial") setLastSupply(rememberSupply(lastSupply, result.supply));
      // A display observation does not confirm an uncertain source write, select
      // an adoption candidate, or publish a pool-updated event.
    } catch { setObservationError(failureCode); }
    finally { observationInFlight.current = false; setObserving(false); }
  }
  async function readSource(retryOriginal = false) {
    if (busy || savedRef.current || storageError || sourceStorageError || sourceReadState.current === "reading"
      || (retryOriginal ? !sourceRequestRef.current : !!sourceRequestRef.current || sourceReadState.current !== "idle")) return;
    let requestKey: string;
    try {
      requestKey = sourceRequestRef.current ?? parseCreditPoolRequestKey(crypto.randomUUID());
      window.sessionStorage.setItem(sourceStorageKey, JSON.stringify({ requestKey }));
    } catch { setSourceStorageError("无法保存原核验请求，本次未提交；仍可查看余额与对账状态。"); return; }
    sourceRequestRef.current = requestKey; setSourceRequestKey(requestKey);
    sourceReadState.current = "reading"; sourceReadRevision.current += 1; setSourceIssue(null); setBusy(true); setError(""); setNotice(""); setProposal(null);
    let status: number | null = null;
    try { const response = await fetch(`${ENDPOINT}/source`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestKey }) }); status = response.status;
      const body: unknown = await response.json(), result = data(body);
      if (!response.ok || !isCreditPoolManagementOverview(result)) {
        const issue = sourceReadIssue(body, status, response.ok ? "SOURCE_RESPONSE_INVALID" : "SOURCE_READ_UNCONFIRMED");
        sourceReadState.current = issue.state; setSourceIssue(issue); setError(issue.message); return;
      }
      setOverview(result); setOverviewStale(false); window.dispatchEvent(new Event("sanjie-credit-pool-updated")); setNotice("已完成本次来源与分配额度核验。请审阅采用方案；该中转站余额仍可能被其他共用密钥消费。");
      try { window.sessionStorage.removeItem(sourceStorageKey); }
      catch { sourceReadState.current = "uncertain"; setSourceStorageError("核验已成功，但浏览器未能清除原核验请求；请保留原编号核对，暂不发起另一笔核验。"); return; }
      sourceRequestRef.current = null; setSourceRequestKey(null); sourceReadState.current = "idle"; setSourceStorageError("");
    } catch { const issue = sourceReadIssue(null, status, status === null ? "SOURCE_NETWORK_UNCONFIRMED" : "SOURCE_RESPONSE_INVALID");
      sourceReadState.current = issue.state; setSourceIssue(issue); setError(issue.message);
    } finally { setBusy(false); }
  }
  async function prepare() {
    const refs = overview?.source.candidateSnapshot; if (!refs || overviewStale || busy || savedRef.current || storageError || sourceStorageError || sourceRequestRef.current || !adminId || sourceReadState.current !== "idle") return;
    const operation: CreditPoolOperation = overview.pool.accountingVersion === 0 || overview.pool.revision === null ? "adoption" : "source_refresh";
    setBusy(true); setError(""); setNotice("");
    try { const response = await fetch(`${ENDPOINT}/proposals`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, ...refs }) }); const result = data(await response.json());
      if (!response.ok || !isCreditPoolProposalView(result) || result.operation !== operation || result.state !== "reviewable") throw new Error("proposal unavailable"); setProposal(result);
    } catch { setProposal(null); setError("当前来源或账本已变化，方案无法采用；请重新读取余额后审阅。"); } finally { setBusy(false); }
  }
  async function complete() {
    try { window.sessionStorage.removeItem(storageKey); } catch { setStorageError("操作已完成，但原请求记录未能清除；请继续核对原操作，勿发起另一笔。"); return; }
    savedRef.current = null; setStorageError(""); setPending(null); setProposal(null); setNotice("总积分池已完成采用核对，赠送将再次核验最新上游余额。"); window.dispatchEvent(new Event("sanjie-credit-pool-updated")); await refresh();
  }
  async function submitSaved(saved: SavedOperation, previouslyUncertain = true) {
    if (busy) return; setBusy(true); setError("");
    try { const response = await fetch(`${ENDPOINT}/${saved.operation === "adoption" ? "initialize" : "refresh"}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(saved.input) }); const result = data(await response.json());
      if (!previouslyUncertain && response.status >= 400 && response.status < 500) {
        try { window.sessionStorage.removeItem(storageKey); } catch { setStorageError("本次未采用，但原请求记录无法清除，请先核对后恢复浏览器存储。"); return; }
        savedRef.current = null; setPending(null); setProposal(null); setError("本次方案未采用，请重新读取当前上游余额后审阅；现有钱包余额保持不变。"); return;
      }
      if (!response.ok || !result || typeof result !== "object" || !("committed" in result) || result.committed !== true || !("requestKey" in result) || result.requestKey !== saved.input.requestKey ||
          !("operation" in result) || result.operation !== saved.operation || !("eventId" in result) || result.eventId !== `${saved.operation === "adoption" ? "adoption" : "source-refresh"}:${saved.input.requestKey}`) throw new Error("commit uncertain"); await complete();
    } catch { setError("采用结果尚未确认，请核对原操作或重试原请求；不会创建另一笔采用。"); } finally { setBusy(false); }
  }
  async function confirm() {
    if (!proposal || proposal.state !== "reviewable" || savedRef.current || storageError || busy || !adminId) return;
    if (Date.parse(proposal.expiresAt) <= Date.now()) { setProposal(null); setError("方案已过期，请读取当前余额并重新审阅。"); return; }
    const saved = { operation: proposal.operation, input: { proposalId: proposal.id, version: proposal.version, snapshotHash: proposal.snapshotHash, requestKey: crypto.randomUUID() } };
    try { window.sessionStorage.setItem(storageKey, JSON.stringify(saved)); } catch { setError("无法保存原请求标识，当前不能提交采用；请检查浏览器存储后重试。"); return; }
    savedRef.current = saved; setPending(saved); await submitSaved(saved, false);
  }
  async function recover() {
    if (!pending || busy) return; setBusy(true); setError("");
    try { const response = await fetch(`${ENDPOINT}/operations/${pending.input.requestKey}?operation=${pending.operation}`, { cache: "no-store", credentials: "same-origin" }); const result = data(await response.json());
      if (!response.ok || !result || typeof result !== "object" || !("state" in result) || !("requestKey" in result) || result.requestKey !== pending.input.requestKey) throw new Error("recovery unavailable");
      if (result.state === "committed" && "receipt" in result && isCreditPoolOperationReceipt(result.receipt) && result.receipt.requestKey === pending.input.requestKey && result.receipt.proposalId === pending.input.proposalId && result.receipt.operation === pending.operation) await complete();
      else if (result.state === "not_found") setNotice("暂未查到已完成记录；可使用原请求标识重试，勿创建新请求。"); else throw new Error("unknown recovery");
    } catch { setError("原操作暂时无法核对，请稍后重试；原请求标识已保留。"); } finally { setBusy(false); }
  }
  const view = overview && isCreditPoolManagementOverview(overview) ? overview : null;
  const refreshBeforeGift = view?.pool.accountingVersion === 1 && view.source.scope === "shared_user_lifetime_wallet"
    && view.source.readAvailable && view.source.state === "stale" && view.pool.deficitCents === "0";
  const reviewable = proposal?.state === "reviewable" && Date.parse(proposal.expiresAt) > Date.now();
  const ledgerView = lastLedger ?? view;
  const ledgerOld = observing || !!observationError || observation?.ledger.status === "unavailable" || !lastLedger && overviewStale;
  const walletBalance = lastWallet?.balanceUsd ?? (view?.source.nativeUnit === "USD" ? view.source.rawRemaining : null);
  const walletTime = lastWallet?.observedAt ?? view?.source.observedAt ?? null;
  const walletFresh = !observing && !observationError && observation?.wallet.status === "ok";
  const supplyCurrent = !observing && !observationError && (observation?.supply.status === "ok" || observation?.supply.status === "partial");
  return <section className="panel" aria-label="总积分池来源连接状态">
    <div className="section-heading"><div><h2>积分池与供应资源</h2><p>预期来源：少壮专属分组</p></div><button type="button" disabled={observing} onClick={() => void observe()}>{observing ? "正在查看…" : "查看余额与对账状态"}</button></div>
    <p>查看只读取当前信息。各层分别显示读取时间和异常，不会因此采用额度或结算任务。</p>
    {observationError ? <p role="alert" data-error-code={observationError}>{observationMessage(observationError, "本次查看未完成，已有读值保留为历史记录。")}</p> : null}
    <div className="panel" aria-label="本站积分账本">
      <h3>本站积分</h3>
      <p>{ledgerOld ? "历史读值（本次未更新）" : "账本读取时间"}：{observedTime(ledgerView?.observedAt ?? null)}。</p>
      {observation?.ledger.status === "unavailable" ? <p role="alert">{observationMessage(observation.ledger.code, "本站账本本次读取未完成，保留上次读值。")}</p> : null}
      {ledgerView ? <>
        <p>钱包合计：{localPoints(ledgerView.liabilities.walletTotalCents)} 积分；其中冻结：{localPoints(ledgerView.liabilities.heldSubsetCents)} 积分，已包含在钱包合计中。</p>
        <p>{ledgerOld ? "上次读取的可分配积分" : "可分配积分"}：{ledgerView.pool.ready && ledgerView.pool.balanceCents !== null ? localPoints(String(ledgerView.pool.balanceCents)) : "待核对"}。</p>
        {ledgerView.pool.consumedCents !== null ? <p>本站已计价消费：{localPoints(ledgerView.pool.consumedCents)} 积分。</p> : null}
        {ledgerView.liabilities.awaitingOrders > 0 ? <p>已收款待分配：{ledgerView.liabilities.awaitingOrders} 笔，{localPoints(ledgerView.liabilities.awaitingAllocationCents)} 积分。</p> : null}
        {ledgerView.source.blockers.map(blocker => <p key={blocker.code}>{observationMessage(blocker.code, "本站分配额度尚未完成核验。")}</p>)}
      </> : <p>本站积分账本暂未读取，金额未知。</p>}
    </div>
    <div className="panel" aria-label="中转站内部用户余额">
      <h3>中转站内部用户 USD 余额</h3>
      <p>{walletBalance === null ? "读取时间" : walletFresh ? "本次读取时间" : "历史读值（本次未更新）"}：{observedTime(walletTime)}。</p>
      {observation?.wallet.status === "unavailable" ? <p role="alert">{observationMessage(observation.wallet.code, "中转站余额本次读取未完成，保留上次读值。")}</p> : null}
      <p>账面余额：{walletBalance !== null ? `${walletBalance} USD` : "尚未读取"}。</p>
      <p>这是中转站内部用户账面余额，不等同于上游采购余款；其他共用密钥的消费会影响该余额。</p>
      <p>外部尚未入账请求无法观测，余额充足也不能证明未知任务已完成。</p>
    </div>
    <div className="panel" aria-label="供应资源观察">
      <h3>供应资源</h3>
      <p>账号剩余额度和订阅窗口尚未接入；以下为分组统计参考。</p>
      <p>{!lastSupply ? "读取时间" : supplyCurrent ? "本次读取时间" : "历史读值（本次未更新）"}：{observedTime(lastSupply?.observedAt ?? null)}。</p>
      {observation?.supply.status === "not_configured" ? <p>供应资源未接入，分组容量与用量未知。</p>
        : observation?.supply.status === "unavailable" ? <p role="alert">{observationMessage(observation.supply.code, "供应资源本次读取未完成，保留上次读值。")}</p>
        : observation?.supply.status === "partial" ? <p role="status">{observationMessage(observation.supply.code, "供应资源仅部分读取成功，缺失指标保持未知。")}</p>
        : !lastSupply ? <p>供应资源尚未读取，分组容量与用量未知。</p> : null}
      {lastSupply?.groups.map(group => {
        const current = supplyCurrent ? observation?.supply.groups.find(row => row.groupId === group.groupId) : null;
        return <div key={group.groupId} aria-label={`供应分组 ${group.groupId}`}>
          <h4>{group.name ?? `分组 ${group.groupId}`}{group.platform ? ` · ${group.platform}` : ""}{group.status ? ` · ${group.status}` : ""}</h4>
          <p>{current ? "账号统计读取时间" : "账号统计历史读值"}：{observedTime(group.groupObservedAt)}。账号总数：{group.accountCount ?? "未知"}；启用账号数：{group.activeAccountCount ?? "未知"}。启用状态不代表当前可用。</p>
          <p>{current?.capacity ? "容量读取时间" : "容量历史读值（本次未取得）"}：{observedTime(group.capacityObservedAt)}。</p>
          <p>并发：{group.capacity?.concurrencyUsed ?? "未知"} / {group.capacity?.concurrencyMax ?? "未知"}；会话：{group.capacity?.sessionsUsed ?? "未知"} / {group.capacity?.sessionsMax ?? "未知"}；每分钟请求：{group.capacity?.rpmUsed ?? "未知"} / {group.capacity?.rpmMax ?? "未知"}。</p>
          <p>{current?.usage ? "用量读取时间" : "用量历史读值（本次未取得）"}：{observedTime(group.usageObservedAt)}。</p>
          <p>中转站统计费用：今日 {group.usage?.todayCost ?? "未知"}；昨日 {group.usage?.yesterdayCost ?? "未知"}；累计 {group.usage?.totalCost ?? "未知"}。该统计口径尚未证实为采购 USD。</p>
        </div>;
      })}
      <p>供应侧用量窗口和点数不等同于本站积分。未取得真实采购成本与完整消耗记录前，不估算可用天数或采购金额。</p>
    </div>
    <div className="section-heading"><div><h3>分配额度核验</h3><p>核验来源与站内账本后，才能审阅采用方案。</p></div><button type="button" disabled={loading || busy} onClick={() => void refresh()}>{loading ? "正在核对…" : "刷新连接状态"}</button></div>
    <p>“核验分配额度”或“确认采用此方案”成功后，会检查已保存且有效的预设赠送，符合条件时实际赠送积分。“查看余额与对账状态”和“刷新连接状态”只查看，不执行赠送。</p>
    {error ? <p role="alert" data-operation-state={sourceIssue?.state} data-error-code={sourceIssue?.code}>{error}</p> : null}{storageError ? <p role="alert">{storageError}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    {sourceStorageError ? <p role="alert">{sourceStorageError}</p> : null}
    {overviewStale && view ? <p role="status">以下分配核验信息为历史记录，本次连接状态未更新。</p> : null}
    {loading ? <p role="status">正在读取来源连接状态…</p> : null}{!view ? <p role="alert">来源状态未知，请刷新核对。</p> : <>
      <p role="status">{view.pool.ready ? "总积分池已有核验余额" : refreshBeforeGift ? "来源记录已过期，赠送时将重新核对" : "当前不能赠送积分"}</p>
      {!view.source.readAvailable ? <p>{view.pool.ready ? "已保存来源快照；持续读取尚未接通" : "未接通上游额度读取"}</p> : <p>来源：已批准采用的上游共用 USD 钱包。其他共用密钥的消费会影响可分配额度。</p>}
      {view.source.state !== "ready" && !view.source.readAvailable ? <p>原生额度与本站积分尚未核对</p> : null}
      {view.source.rawRemaining !== null ? <p>已保存的来源核验余额：{view.source.rawRemaining} {view.source.nativeUnit}；核验读取时间：{observedTime(view.source.observedAt)}。</p> : null}
      {view.source.externalCommitmentsState === "unobservable" ? <p>外部尚未入账请求无法观测；每次新分配会重新读取，缺口时停止分配并保留现有积分。</p> : null}
      {view.source.scope === "shared_user_lifetime_wallet" ? <>
        {view.pool.consumedCents !== null ? <p>本站已计价消费：{localPoints(view.pool.consumedCents)} 积分。</p> : null}
        {view.source.costCoverage === "local_catalog_or_actual_usd" ? <p>消费按本次已核验的计价依据和真实用量结算；未核验的上游费用待核实。</p> : null}
        <p>采用上游已记账余额；尚未取得上游逐笔入账证明的本站消耗会保守预留，不加回可分配额度。</p>
      </> : null}
      {view.source.blockers.map(blocker => <p key={blocker.code}>{observationMessage(blocker.code, "本站分配额度尚未完成核验。")}</p>)}
      <p>可赠送积分：{view.pool.ready && view.pool.balanceCents !== null ? localPoints(String(view.pool.balanceCents)) : "待核对"}</p>
      <p>已分配站内钱包积分：{localPoints(view.liabilities.walletTotalCents)}；其中冻结：{localPoints(view.liabilities.heldSubsetCents)}。冻结已包含在钱包余额中。</p>
      {view.pool.deficitCents !== null && view.pool.deficitCents !== "0" ? <p role="alert">当前覆盖缺口：{localPoints(view.pool.deficitCents)} 积分。用户余额与冻结保持不变，新的分配已停止。</p> : null}
      {view.liabilities.awaitingOrders > 0 ? <p>已收款待分配：{view.liabilities.awaitingOrders} 笔，{localPoints(view.liabilities.awaitingAllocationCents)} 积分。</p> : null}
      {view.source.readAvailable ? <div><button type="button" disabled={!adminId || busy || !!pending || !!storageError || !!sourceStorageError || !!sourceRequestKey || sourceIssue?.state === "uncertain"} onClick={() => void readSource()}>核验分配额度</button><button type="button" disabled={!adminId || overviewStale || busy || !!pending || !!storageError || !!sourceStorageError || !!sourceRequestKey || sourceIssue?.state === "uncertain" || !view.source.candidateSnapshot} onClick={() => void prepare()}>审阅采用方案</button></div> : null}
    </>}
    {sourceRequestKey ? <div role="status"><p>原核验请求已保留：{sourceRequestKey}。查看状态不会清除该编号；重试只核对原请求，不建立另一笔分配窗口。</p><button type="button" disabled={busy || !!pending || !!storageError || !!sourceStorageError} onClick={() => void readSource(true)}>重试原核验</button></div> : null}
    {proposal ? <div aria-label="总积分池采用方案"><h3>{proposal.operation === "adoption" ? "首次采用方案" : "同一资金来源刷新方案"}</h3><p>核验总量：{localPoints(proposal.capacityCents)}；采用现有钱包：{localPoints(proposal.walletTotalCents)}；其中冻结：{localPoints(proposal.heldSubsetCents)}；已消费：{localPoints(proposal.consumedCents)}；可分配：{localPoints(proposal.allocatableCents)} 积分。</p><p>现有钱包（含冻结）只采用一次；确认时会重新核对来源与账本。方案有效至 {new Date(proposal.expiresAt).toLocaleString("zh-CN")}。</p><button type="button" disabled={!reviewable || busy || !!pending || !!storageError || !adminId} onClick={() => void confirm()}>确认采用此方案</button></div> : null}
    {pending ? <div role="status"><p>上一笔采用需要核对，原请求标识已保留。</p><button type="button" disabled={busy} onClick={() => void recover()}>核对原操作</button><button type="button" disabled={busy} onClick={() => void submitSaved(pending)}>重试原请求</button></div> : null}
  </section>;
}
