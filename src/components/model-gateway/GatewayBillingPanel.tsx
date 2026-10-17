"use client";

import { ChevronDown, Download, RefreshCw, Save, Search, WalletCards } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  applyGatewayBillingCost,
  centsToPoints,
  GATEWAY_MAX_MULTIPLIER_BPS,
  GATEWAY_MIN_MULTIPLIER_BPS,
  type GatewayBillingAccountView,
  type GatewayBillingRuleAuditView,
  type GatewayBillingRuleView
} from "@/lib/model-gateway/billing-contract";
import styles from "./GatewayBillingPanel.module.css";

type RuleAudit = GatewayBillingRuleAuditView;
type RulesView = { rules: GatewayBillingRuleView[]; audits: RuleAudit[] };
type LedgerItem = {
  id: string; billingEventId: string; kind: string; userId: string; tenantId: string; tenantName: string;
  username: string; userName: string; planCode: string; planName: string;
  multiplierBps: number; ruleVersion: number; deltaCents: number;
  balanceBeforeCents: number; balanceAfterCents: number; baseCostCents: number; chargedCostCents: number;
  endpoint: string; provider: string; model: string; requestId: string;
  usageId: string | null; orderId: string | null; promptTokens: number; completionTokens: number;
  totalTokens: number; imageCount: number; durationMs: number | null; upstreamStatus: number | null;
  status: string; error: string; createdAt: string;
  actorUsername?: string | null; actorName?: string | null; reason?: string | null;
  keyPrefix: string; metadata: unknown;
};
type AccountItem = GatewayBillingAccountView;
type PendingHold = { eventId: string; userId: string; tenantId: string; model: string; endpoint: string; heldCents: number; status: "reserved" | "dispatched" | "unknown"; updatedAt: string };
type PageView<T> = { items: T[]; total: number; page: number; pageSize: number };
type Filters = { tenantId: string; search: string; planCode: string; kind: string; from: string; to: string; model: string; endpoint: string };
type RuleEdit = { value: string; reason: string; originalBps: number; version: number };
const EMPTY_FILTERS: Filters = { tenantId: "", search: "", planCode: "", kind: "", from: "", to: "", model: "", endpoint: "" };
const PAGE_SIZE = 20;
const PLAN_NOTES: Record<string, string> = {
  free: "未购买套餐的旧账户",
  starter: "现售 ¥99 · 到账 1,200 积分",
  growth: "现售 ¥299 · 到账 3,800 积分",
  business: "现售 ¥899 · 到账 12,000 积分"
};
const EVENT_LABELS: Record<string, string> = { opening: "历史钱包开账", recharge: "充值到账", gift: "管理员赠送", debit: "调用扣费", error: "调用失败", generation_charge: "生成提交扣分", generation_refund: "生成失败退款", usage: "调用用量记录" };

function ruleEdit(rule: GatewayBillingRuleView): RuleEdit {
  return { value: multiplier(rule.multiplierBps), reason: "", originalBps: rule.multiplierBps, version: rule.version };
}
function planLabel(planCode: string, planName: string) { return planCode === "free" ? "未购买套餐" : planName; }
function isCall(item: LedgerItem) { return ["debit", "error", "generation_charge", "generation_refund", "usage"].includes(item.kind); }
function actor(item: LedgerItem) {
  if (item.actorName && item.actorUsername && item.actorName !== item.actorUsername) return `${item.actorName}（${item.actorUsername}）`;
  return item.actorUsername || item.actorName || (item.kind === "opening" ? "系统" : "未记录");
}
export function gatewayBillingStatusText(status: string) {
  const labels: Record<string, string> = {
    ok: "成功", success: "成功", error: "失败", preflight_rejected: "提交前拒绝",
    settlement_rejected: "余额不足", settlement_failed: "扣费结算失败", paid: "已到账"
  };
  return labels[status] || status || "—";
}
function metadataValue(item: Pick<LedgerItem, "metadata">, key: "requestedImageCount" | "inputImageCount" | "size" | "quality" | "tokenSource" | "reportedTokenFields") {
  if (!item.metadata || typeof item.metadata !== "object" || Array.isArray(item.metadata)) return null;
  const value = (item.metadata as Record<string, unknown>)[key];
  if (key === "requestedImageCount" || key === "inputImageCount") return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  return typeof value === "string" && value ? value.slice(0, 500) : null;
}
function tokenSource(item: LedgerItem) {
  const source = metadataValue(item, "tokenSource");
  return source === "reported" ? "供应商回报" : source === "partial" ? "供应商部分回报" : source === "estimated" ? "估算" : source === "unreported" ? "未提供" : null;
}
export function gatewayBillingTokenCount(item: Pick<LedgerItem, "metadata" | "promptTokens" | "completionTokens" | "totalTokens">, field: "prompt" | "completion" | "total") {
  const source = metadataValue(item, "tokenSource");
  if (source !== "reported" && source !== "estimated" && source !== "partial") return null;
  if (source === "partial" && !String(metadataValue(item, "reportedTokenFields") || "").split(",").includes(field)) return null;
  return field === "prompt" ? item.promptTokens : field === "completion" ? item.completionTokens : item.totalTokens;
}
function keyPrefix(item: LedgerItem) { return item.keyPrefix ? `${item.keyPrefix.slice(0, 16)}…` : "—"; }
function failureText(item: LedgerItem) {
  const known: Record<string, string> = {
    INSUFFICIENT_BALANCE: "余额不足，当前调用未扣费", SETTLEMENT_FAILED: "结算服务异常，当前记录未扣费",
    upstream_timeout: "上游请求超时", gateway_unavailable: "网关服务暂不可用", upstream_task_failed: "上游生成任务失败",
    upstream_error: "上游调用失败", rate_limit_exceeded: "上游请求超过频率限制"
  };
  if (/^upstream_http_\d{3}$/.test(item.error)) return `上游返回 HTTP ${item.error.slice(-3)}`;
  return known[item.error] || item.error || "—";
}

function points(cents: number | null | undefined) {
  return typeof cents === "number" && Number.isFinite(cents)
    ? centsToPoints(cents).toLocaleString("zh-CN", { maximumFractionDigits: 1 })
    : "—";
}
function multiplier(bps: number) {
  const text = (bps / 10_000).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return text.includes(".") ? text : `${text}.0`;
}
function beijingTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).format(date);
}
export function parseGatewayBillingMultiplier(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d{1,4})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const bps = Number(whole) * 10_000 + Number(fraction.padEnd(4, "0"));
  return Number.isSafeInteger(bps) && bps >= GATEWAY_MIN_MULTIPLIER_BPS && bps <= GATEWAY_MAX_MULTIPLIER_BPS ? bps : null;
}
export function escapeGatewayBillingCsvCell(value: string | number | null | undefined) {
  let text = value == null ? "" : String(value);
  if (typeof value !== "number" && (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text))) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...options });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : `读取失败（HTTP ${response.status}），请重试。`);
  if (!payload?.data || typeof payload.data !== "object") throw new Error("服务器返回了无法识别的数据，请重试。");
  return payload.data as T;
}
function errorText(error: unknown) { return error instanceof Error ? error.message : "网络连接失败，请重试。"; }

function useBillingQuery<T>(path: string, refreshKey: number, listKey: "rules" | "items") {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    request<T>(path, { signal: controller.signal }).then((result) => {
      if (!Array.isArray((result as Record<string, unknown>)[listKey])) throw new Error("服务器返回了无法识别的列表，请重试。");
      if (!controller.signal.aborted) setData(result);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(errorText(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [path, refreshKey, listKey]);
  return { data, loading, error };
}
function queryString(filters: Filters, page: number, ledger: boolean) {
  const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  for (const key of ["tenantId", "search", "planCode"] as const) if (filters[key].trim()) query.set(key, filters[key].trim());
  if (ledger) {
    for (const key of ["kind", "model", "endpoint"] as const) if (filters[key].trim()) query.set(key, filters[key].trim());
    if (filters.from) query.set("from", new Date(`${filters.from}:00+08:00`).toISOString());
    if (filters.to) query.set("to", new Date(`${filters.to}:59.999+08:00`).toISOString());
  }
  return query.toString();
}
function PageControls({ data, page, loading, onPage }: {
  data: { total: number; page: number; pageSize: number } | null; page: number; loading: boolean; onPage: (page: number) => void;
}) {
  const lastPage = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return <div className={styles.pagination}>
    <span>{data ? `共 ${data.total.toLocaleString("zh-CN")} 条 · 第 ${data.page} / ${lastPage} 页` : "等待查询结果"}</span>
    <div className={styles.actions}>
      <button type="button" onClick={() => onPage(page - 1)} disabled={loading || !data || page <= 1}>上一页</button>
      <button type="button" onClick={() => onPage(page + 1)} disabled={loading || !data || page >= lastPage}>下一页</button>
    </div>
  </div>;
}
function QueryMessage({ loading, error, hasData }: { loading: boolean; error: string; hasData: boolean }) {
  if (error) return <p className={styles.error} role="alert">{error}{hasData ? " 以下保留上次结果，请刷新后核对。" : ""}</p>;
  if (loading) return <p className={styles.hint} role="status">正在读取…</p>;
  return null;
}

export function GatewayBillingPanel() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [draftFilters, setDraftFilters] = useState<Filters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [accountPage, setAccountPage] = useState(1);
  const [filterError, setFilterError] = useState("");
  const [edits, setEdits] = useState<Record<string, RuleEdit>>({});
  const [savingCode, setSavingCode] = useState("");
  const [message, setMessage] = useState("");
  const [saveError, setSaveError] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const savePending = useRef(false);
  const rules = useBillingQuery<RulesView>("/api/management/gateway-billing/rules", refreshKey, "rules");
  const ledger = useBillingQuery<PageView<LedgerItem>>(`/api/management/gateway-billing/ledger?${queryString(filters, page, true)}`, refreshKey, "items");
  const accounts = useBillingQuery<PageView<AccountItem>>(`/api/management/gateway-billing/accounts?${queryString(filters, accountPage, false)}`, refreshKey, "items");
  const holds = useBillingQuery<{ items: PendingHold[]; limit: number }>("/api/management/gateway-billing/holds", refreshKey, "items");
  useEffect(() => {
    if (rules.data) setEdits((current) => Object.fromEntries(rules.data!.rules.map((rule) => {
      const edit = current[rule.planCode];
      return [rule.planCode, edit && parseGatewayBillingMultiplier(edit.value) !== edit.originalBps ? edit : ruleEdit(rule)];
    })));
  }, [rules.data]);
  const dirty = rules.data?.rules.some((rule) => edits[rule.planCode] && parseGatewayBillingMultiplier(edits[rule.planCode].value) !== rule.multiplierBps) ?? false;
  const currentPageBalance = useMemo(() => accounts.data?.items.reduce((sum, account) => sum + account.balanceCents, 0) ?? null, [accounts.data]);
  const loading = rules.loading || ledger.loading || accounts.loading || holds.loading;

  function setFilter(key: keyof Filters, value: string) { setDraftFilters((current) => ({ ...current, [key]: value })); }
  function applyFilters() {
    if (draftFilters.from && Number.isNaN(new Date(`${draftFilters.from}:00+08:00`).getTime()) || draftFilters.to && Number.isNaN(new Date(`${draftFilters.to}:59.999+08:00`).getTime())) {
      setFilterError("请输入有效的北京时间。"); return;
    }
    if (draftFilters.from && draftFilters.to && draftFilters.from > draftFilters.to) {
      setFilterError("开始时间不能晚于结束时间。"); return;
    }
    setFilterError(""); setFilters({ ...draftFilters }); setPage(1); setAccountPage(1); setExpandedId(null);
  }
  function clearFilters() { setDraftFilters(EMPTY_FILTERS); setFilters(EMPTY_FILTERS); setPage(1); setAccountPage(1); setFilterError(""); setExpandedId(null); }
  async function saveRule(rule: GatewayBillingRuleView) {
    if (savePending.current) return;
    const edit = edits[rule.planCode];
    const bps = edit ? parseGatewayBillingMultiplier(edit.value) : null;
    if (bps == null) { setSaveError(true); setMessage("扣费倍率须在 0.01–100 之间，最多四位小数。"); return; }
    if (edit.reason.trim().length < 2) { setSaveError(true); setMessage("请填写至少两个字的调整理由，保存后会记录到审计日志。"); return; }
    savePending.current = true; setSavingCode(rule.planCode); setSaveError(false); setMessage("");
    try {
      const saved = await request<{ rule: GatewayBillingRuleView; audit: RuleAudit | null }>("/api/management/gateway-billing/rules", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planCode: rule.planCode, multiplierBps: bps, expectedVersion: edit.version, reason: edit.reason.trim() })
      });
      setEdits((current) => ({ ...current, [rule.planCode]: ruleEdit(saved.rule) }));
      setMessage(`${planLabel(rule.planCode, rule.planName)}扣费倍率已保存为 ${multiplier(bps)}；新请求按新规则计费。`);
      setRefreshKey((value) => value + 1);
    } catch (cause) { setSaveError(true); setMessage(errorText(cause)); }
    finally { savePending.current = false; setSavingCode(""); }
  }
  function exportCurrentPage() {
    if (!ledger.data || ledger.loading || ledger.error) return;
    const headers = ["时间（北京时间）", "租户 ID", "租户名称", "账号", "姓名", "套餐", "套餐编号", "事件", "模型", "接口", "请求 ID", "基础积分", "扣费倍率", "实扣积分", "积分变动", "变动前余额", "变动后余额", "输入 Token", "输出 Token", "总 Token", "图片数", "状态", "失败原因", "HTTP 状态", "耗时 ms", "操作人", "规则版本", "账本事件 ID", "请求图片数", "输入参考图数", "图片尺寸", "质量", "Token 计数来源", "调用凭据前缀", "操作说明"];
    const rows = ledger.data.items.map((item) => [
      beijingTime(item.createdAt), item.tenantId, item.tenantName, item.username, item.userName, planLabel(item.planCode, item.planName), item.planCode, EVENT_LABELS[item.kind] || item.kind,
      item.model, item.endpoint, item.requestId, isCall(item) ? centsToPoints(item.baseCostCents) : null, item.multiplierBps / 10_000,
      isCall(item) ? centsToPoints(item.chargedCostCents) : null, centsToPoints(item.deltaCents), centsToPoints(item.balanceBeforeCents), centsToPoints(item.balanceAfterCents),
      isCall(item) ? gatewayBillingTokenCount(item, "prompt") : null, isCall(item) ? gatewayBillingTokenCount(item, "completion") : null, isCall(item) ? gatewayBillingTokenCount(item, "total") : null, isCall(item) ? item.imageCount : null, gatewayBillingStatusText(item.status), item.error ? failureText(item) : "",
      item.upstreamStatus, item.durationMs, actor(item), item.ruleVersion, item.billingEventId,
      isCall(item) ? metadataValue(item, "requestedImageCount") : null, isCall(item) ? metadataValue(item, "inputImageCount") : null,
      isCall(item) ? metadataValue(item, "size") : null, isCall(item) ? metadataValue(item, "quality") : null,
      isCall(item) ? tokenSource(item) : null, isCall(item) && item.keyPrefix ? keyPrefix(item) : null, item.reason
    ]);
    const csv = "\uFEFF" + [headers, ...rows].map((row) => row.map(escapeGatewayBillingCsvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const anchor = document.createElement("a"); anchor.href = url;
    anchor.download = `积分账本-北京时间-${beijingTime(new Date().toISOString()).replace(/[: ]/g, "-")}-第${ledger.data.page}页.csv`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setSaveError(false); setMessage(`已导出当前筛选第 ${ledger.data.page} 页，共 ${ledger.data.items.length} 条账本记录。`);
  }

  return <div className={styles.root}>
    <header className={styles.header}>
      <div><h2><WalletCards size={22} />积分账本</h2><p>管理套餐扣费倍率，查询账号余额和每次调用的积分明细。</p></div>
      <button type="button" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading || !!savingCode || dirty}><RefreshCw size={15} />刷新</button>
    </header>
    {message ? <p className={saveError ? styles.error : styles.notice} role={saveError ? "alert" : "status"}>{message}</p> : null}

    <section className={styles.section} aria-labelledby="gateway-billing-rules-heading">
      <div className={styles.sectionHead}><div><h3 id="gateway-billing-rules-heading">套餐扣费倍率</h3><p>1.0 为原价，0.8 为八折。现有套餐售价与到账额度保持不变。</p></div><span className={styles.badge}>默认 1.0</span></div>
      <QueryMessage loading={rules.loading} error={rules.error} hasData={!!rules.data} />
      {rules.data ? <div className={styles.ruleGrid}>{rules.data.rules.map((rule) => {
        const edit = edits[rule.planCode] ?? ruleEdit(rule);
        const bps = parseGatewayBillingMultiplier(edit.value);
        const changed = bps !== rule.multiplierBps;
        return <div className={styles.ruleCard} key={rule.planCode}>
          <div className={styles.ruleTitle}><strong>{planLabel(rule.planCode, rule.planName)}</strong><span>v{rule.version}</span></div>
          <p className={styles.hint}>{PLAN_NOTES[rule.planCode] || rule.planCode}</p>
          <label className={styles.field}><span>扣费倍率</span><input aria-label={`${planLabel(rule.planCode, rule.planName)}扣费倍率`} inputMode="decimal" value={edit.value} maxLength={12} disabled={rules.loading || !!savingCode || !!rules.error} onChange={(event) => setEdits((current) => ({ ...current, [rule.planCode]: { ...edit, value: event.target.value } }))} /></label>
          <p className={styles.preview}>基础 7 积分 <span>× {edit.value || "—"}</span> <strong>→ {bps == null ? "倍率无效" : `${points(applyGatewayBillingCost(70, { multiplierBps: bps }))} 积分`}</strong></p>
          <label className={styles.field}><span>调整理由</span><input aria-label={`${planLabel(rule.planCode, rule.planName)}调整理由`} value={edit.reason} minLength={2} maxLength={500} placeholder="填写折扣或调价原因（至少 2 字）" disabled={rules.loading || !!savingCode || !!rules.error} onChange={(event) => setEdits((current) => ({ ...current, [rule.planCode]: { ...edit, reason: event.target.value } }))} /></label>
          <div className={styles.actions}><button type="button" className={styles.primary} disabled={!changed || bps == null || edit.reason.trim().length < 2 || edit.version !== rule.version || !!savingCode || rules.loading || !!rules.error} onClick={() => saveRule(rule)}><Save size={14} />{savingCode === rule.planCode ? "保存中…" : "保存倍率"}</button>{changed || edit.version !== rule.version ? <button type="button" disabled={!!savingCode} onClick={() => setEdits((current) => ({ ...current, [rule.planCode]: ruleEdit(rule) }))}>恢复</button> : null}</div>
          {edit.version !== rule.version ? <p className={styles.error}>此套餐规则已更新，请恢复最新规则后重新调整。</p> : null}
          <p className={styles.hint}>{rule.updatedAt ? `更新于 ${beijingTime(rule.updatedAt)}` : "尚未调整，沿用原价规则"}</p>
        </div>;
      })}</div> : null}
      <p className={styles.hint}>实际扣费向上取整到 0.1 积分。已提交请求沿用提交时的倍率与规则版本；修改后保存才生效。</p>
      {dirty ? <p className={styles.hint}>有未保存的倍率，请保存或恢复后刷新。</p> : null}
      {rules.data?.audits?.length ? <details className={styles.audit}><summary>最近倍率调整记录（{rules.data.audits.length} 条）</summary><div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>北京时间</th><th>套餐</th><th>倍率变化</th><th>操作人</th><th>理由</th><th>规则版本</th></tr></thead><tbody>{rules.data.audits.map((audit) => <tr key={audit.id}><td>{beijingTime(audit.createdAt)}</td><td>{planLabel(audit.planCode, audit.planName)}</td><td>{multiplier(audit.previousMultiplierBps)} → {multiplier(audit.multiplierBps)}</td><td>{audit.updatedByName || audit.updatedByUsername || audit.updatedBy}</td><td className={styles.wrap}>{audit.reason}</td><td>v{audit.previousVersion} → v{audit.version}</td></tr>)}</tbody></table></div></details> : null}
    </section>

    <section className={styles.section} aria-labelledby="gateway-billing-filter-heading">
      <div className={styles.sectionHead}><div><h3 id="gateway-billing-filter-heading">查询范围</h3><p>租户、用户名和套餐同时筛选余额与账本；事件、时间、模型及接口仅筛选账本。</p></div></div>
      <form onSubmit={(event) => { event.preventDefault(); applyFilters(); }}>
        <div className={styles.filters}>
          <label className={styles.field}><span>租户 ID</span><input value={draftFilters.tenantId} onChange={(event) => setFilter("tenantId", event.target.value)} placeholder="全部租户" maxLength={200} /></label>
          <label className={styles.field}><span>租户 / 账号 / 请求</span><input value={draftFilters.search} onChange={(event) => setFilter("search", event.target.value)} placeholder="租户名、账号、模型或请求 ID" maxLength={200} /></label>
          <label className={styles.field}><span>套餐</span><select value={draftFilters.planCode} onChange={(event) => setFilter("planCode", event.target.value)}><option value="">全部套餐</option>{(rules.data?.rules ?? []).map((rule) => <option key={rule.planCode} value={rule.planCode}>{planLabel(rule.planCode, rule.planName)}</option>)}</select></label>
          <label className={styles.field}><span>账本事件</span><select value={draftFilters.kind} onChange={(event) => setFilter("kind", event.target.value)}><option value="">全部事件</option>{Object.entries(EVENT_LABELS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
          <label className={styles.field}><span>开始时间（北京时间）</span><input type="datetime-local" value={draftFilters.from} onChange={(event) => setFilter("from", event.target.value)} /></label>
          <label className={styles.field}><span>结束时间（北京时间）</span><input type="datetime-local" value={draftFilters.to} onChange={(event) => setFilter("to", event.target.value)} /></label>
          <label className={styles.field}><span>模型</span><input value={draftFilters.model} onChange={(event) => setFilter("model", event.target.value)} placeholder="全部模型" maxLength={200} /></label>
          <label className={styles.field}><span>接口</span><input value={draftFilters.endpoint} onChange={(event) => setFilter("endpoint", event.target.value)} placeholder="全部接口" maxLength={200} /></label>
        </div>
        <div className={styles.actions}><button className={styles.primary} type="submit" disabled={ledger.loading || accounts.loading}><Search size={14} />查询</button><button type="button" onClick={clearFilters} disabled={ledger.loading || accounts.loading}>重置</button></div>
        {filterError ? <p className={styles.error} role="alert">{filterError}</p> : null}
      </form>
    </section>

    <section className={styles.section} aria-labelledby="gateway-billing-accounts-heading">
      <div className={styles.sectionHead}><div><h3 id="gateway-billing-accounts-heading">账号余额</h3><p>当前套餐倍率适用于之后提交的请求。</p></div><div className={styles.balance}><span>当前页余额合计</span><strong>{points(currentPageBalance)} <small>积分</small></strong></div></div>
      <QueryMessage loading={accounts.loading} error={accounts.error} hasData={!!accounts.data} />
      <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>租户 / 账号</th><th>套餐</th><th>余额（积分）</th><th>套餐额度（积分）</th><th>扣费倍率</th><th>规则版本</th><th>状态 / 更新时间</th></tr></thead><tbody>
        {!accounts.loading && !accounts.error && accounts.data?.items.length === 0 ? <tr><td className={styles.empty} colSpan={7}>当前查询没有账号。</td></tr> : null}
        {accounts.data?.items.map((account) => <tr key={account.userId}><td><strong>{account.username || account.userName}</strong><span>{account.userName} · {account.tenantName || account.tenantId}</span><span className={styles.mono}>{account.tenantId}</span></td><td>{planLabel(account.planCode, account.planName)}</td><td className={styles.amount}>{points(account.balanceCents)}</td><td>{points(account.monthlyQuotaCents)}</td><td>{multiplier(account.multiplierBps)}</td><td>v{account.ruleVersion}</td><td>{account.status === "active" ? "正常" : account.status === "disabled" ? "已停用" : account.status}<span>{beijingTime(account.updatedAt)}</span></td></tr>)}
      </tbody></table></div>
      <PageControls data={accounts.data} page={accountPage} loading={accounts.loading || !!accounts.error} onPage={setAccountPage} />
    </section>

    <section className={styles.section} aria-labelledby="gateway-billing-holds-heading">
      <div className={styles.sectionHead}><div><h3 id="gateway-billing-holds-heading">进行中与待核账调用</h3><p>显示最早更新的前 50 条。供应结果不明确时保留冻结，核对供应记录后再结算或释放。</p></div></div>
      <QueryMessage loading={holds.loading} error={holds.error} hasData={!!holds.data} />
      <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>更新时间</th><th>租户 / 账号</th><th>模型 / 接口</th><th>冻结积分</th><th>状态</th><th>核账事件 ID</th></tr></thead><tbody>
        {!holds.loading && !holds.error && holds.data?.items.length === 0 ? <tr><td className={styles.empty} colSpan={6}>没有进行中或待核账调用。</td></tr> : null}
        {holds.data?.items.map(item => <tr key={item.eventId}><td>{beijingTime(item.updatedAt)}</td><td>{item.tenantId}<span>{item.userId}</span></td><td>{item.model}<span>{item.endpoint}</span></td><td>{points(item.heldCents)}</td><td>{item.status === "unknown" ? "待核账" : item.status === "reserved" ? "待发送" : "进行中"}</td><td className={styles.mono}>{item.eventId}</td></tr>)}
      </tbody></table></div>
    </section>

    <section className={styles.section} aria-labelledby="gateway-billing-ledger-heading">
      <div className={styles.sectionHead}><div><h3 id="gateway-billing-ledger-heading">积分明细</h3><p>时间均为北京时间。展开一条记录查看请求、扣费和执行明细。</p></div><button type="button" onClick={exportCurrentPage} disabled={ledger.loading || !!ledger.error || !ledger.data?.items.length}><Download size={14} />导出当前页 CSV</button></div>
      <QueryMessage loading={ledger.loading} error={ledger.error} hasData={!!ledger.data} />
      <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>北京时间</th><th>租户 / 账号</th><th>事件 / 模型</th><th>套餐 / 倍率</th><th>积分变动</th><th>变动后余额</th><th>状态</th><th>详情</th></tr></thead><tbody>
        {!ledger.loading && !ledger.error && ledger.data?.items.length === 0 ? <tr><td className={styles.empty} colSpan={8}>当前查询没有账本记录。</td></tr> : null}
        {ledger.data?.items.map((item) => <Fragment key={item.id}><tr><td className={styles.nowrap}>{beijingTime(item.createdAt)}</td><td><strong>{item.username || item.userName}</strong><span>{item.tenantName || "未记录租户名"}</span><span className={styles.mono}>{item.tenantId}</span></td><td>{EVENT_LABELS[item.kind] || item.kind}<span>{item.model || "—"}</span></td><td>{planLabel(item.planCode, item.planName)}<span>× {multiplier(item.multiplierBps)} · v{item.ruleVersion}</span></td><td className={`${styles.amount} ${item.deltaCents < 0 ? styles.debit : styles.credit}`}>{item.deltaCents > 0 ? "+" : ""}{points(item.deltaCents)}</td><td>{points(item.balanceAfterCents)}</td><td>{gatewayBillingStatusText(item.status)}</td><td><button type="button" aria-expanded={expandedId === item.id} aria-controls={`billing-detail-${item.id}`} onClick={() => setExpandedId((current) => current === item.id ? null : item.id)} className={styles.detailButton}><ChevronDown size={14} />{expandedId === item.id ? "收起" : "展开"}</button></td></tr>
          {expandedId === item.id ? <tr><td colSpan={8} className={styles.detailCell}><dl id={`billing-detail-${item.id}`} className={styles.details}>
            <div><dt>北京时间</dt><dd>{beijingTime(item.createdAt)}</dd></div><div><dt>租户 / 账号</dt><dd>{item.tenantName || "未记录租户名"}（{item.tenantId}） / {item.username}（{item.userName}）</dd></div>
            <div><dt>执行状态</dt><dd>{gatewayBillingStatusText(item.status)}{item.status.startsWith("settlement_") && item.chargedCostCents === 0 ? " · 上游调用后未完成扣费，本条未扣积分" : ""}</dd></div>
            {isCall(item) ? <><div><dt>型号 / 供应商</dt><dd>{item.model || "—"} / {item.provider || "—"}</dd></div><div><dt>接口 endpoint</dt><dd>{item.endpoint || "—"}</dd></div></> : null}
            <div><dt>请求 ID</dt><dd className={styles.mono}>{item.requestId || "—"}</dd></div><div><dt>账本事件 ID</dt><dd className={styles.mono}>{item.billingEventId}</dd></div>
            {isCall(item) ? <div><dt>基础积分 × 倍率 → 实扣</dt><dd>{points(item.baseCostCents)} × {multiplier(item.multiplierBps)} → {points(item.chargedCostCents)} 积分</dd></div> : null}<div><dt>余额前 → 余额后</dt><dd>{points(item.balanceBeforeCents)} → {points(item.balanceAfterCents)} 积分</dd></div>
            {isCall(item) ? <><div><dt>输入 / 输出 / 总 Token</dt><dd>{`${gatewayBillingTokenCount(item, "prompt") ?? "—"} / ${gatewayBillingTokenCount(item, "completion") ?? "—"} / ${gatewayBillingTokenCount(item, "total") ?? "—"}`}</dd></div><div><dt>图片数</dt><dd>{item.imageCount}</dd></div><div><dt>HTTP 状态 / 耗时</dt><dd>{item.upstreamStatus ?? "—"} / {item.durationMs == null ? "—" : `${item.durationMs} ms`}</dd></div></> : null}<div><dt>操作人 / 规则版本</dt><dd>{actor(item)} / v{item.ruleVersion}</dd></div>
            {isCall(item) ? <><div><dt>请求图片 / 输入参考图</dt><dd>{metadataValue(item, "requestedImageCount") ?? "—"} / {metadataValue(item, "inputImageCount") ?? "—"}</dd></div><div><dt>图片尺寸 / 质量</dt><dd>{metadataValue(item, "size") ?? "—"} / {metadataValue(item, "quality") ?? "—"}</dd></div><div><dt>Token 计数来源</dt><dd>{tokenSource(item) || "未记录"}</dd></div><div><dt>调用凭据前缀</dt><dd className={styles.mono}>{keyPrefix(item)}</dd></div></> : null}
            <div><dt>关联订单 / 调用</dt><dd>{item.orderId || "—"} / {item.usageId || "—"}</dd></div><div><dt>失败原因</dt><dd>{failureText(item)}</dd></div>
            {item.reason ? <div><dt>操作说明</dt><dd>{item.reason}</dd></div> : null}
          </dl></td></tr> : null}
        </Fragment>)}
      </tbody></table></div>
      <PageControls data={ledger.data} page={page} loading={ledger.loading || !!ledger.error} onPage={(next) => { setPage(next); setExpandedId(null); }} />
      <p className={styles.hint}>CSV 仅包含当前筛选的当前页，最多 {PAGE_SIZE} 条；调用凭据仅保留前缀。</p>
    </section>
  </div>;
}
