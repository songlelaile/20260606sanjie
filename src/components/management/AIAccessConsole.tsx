"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./AIAccessConsole.module.css";

type Scope = "read" | "action";
type Grant = {
  id: string;
  name: string;
  scope: Scope;
  expiresAt: string | null;
  enabled: boolean;
  revokedAt: string | null;
};
type IssuedToken = { id: string; token: string };
type AccessEvent = {
  id: string;
  type: string;
  grantName: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  createdAt: string;
};
type LoadState = "loading" | "ready" | "error";
const ENDPOINT = "/api/ai-access/grants";
const AI_TOOLS = ["Codex", "Cursor", "Claude Code", "通用 AI"] as const;
type AITool = (typeof AI_TOOLS)[number];

function isGrant(value: unknown): value is Grant {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Grant>;
  return typeof item.id === "string" && typeof item.name === "string" &&
    (item.scope === "read" || item.scope === "action") &&
    (item.expiresAt === null || typeof item.expiresAt === "string") && typeof item.enabled === "boolean" &&
    (item.revokedAt === null || typeof item.revokedAt === "string");
}

function expiryText(value: string | null) {
  if (value === null) return "不限时间";
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime())
    ? timestamp.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })
    : "请刷新查看";
}

function isAccessEvent(value: unknown): value is AccessEvent {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<AccessEvent>;
  const nullableString = (field: unknown) => field === null || typeof field === "string";
  return typeof item.id === "string" && typeof item.type === "string" &&
    nullableString(item.grantName) && nullableString(item.method) && nullableString(item.path) &&
    (item.status === null || typeof item.status === "number") && typeof item.createdAt === "string";
}

function eventAction(type: string) {
  const labels: Record<string, string> = {
    list: "查看通道", create: "创建通道", enable: "开启通道", disable: "关闭通道", revoke: "撤销通道", authorize: "验证授权",
    context: "切换店铺", request: "接口调用", events: "查看最近操作"
  };
  return labels[type] ?? "其他操作";
}

function grantStatus(grant: Grant) {
  if (grant.revokedAt) return "已撤销";
  if (grant.expiresAt === null) return grant.enabled ? "已开启" : "已关闭";
  const expires = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expires)) return "待刷新";
  if (expires <= Date.now()) return "已到期";
  return grant.enabled ? "已开启" : "已关闭";
}

export function AIAccessConsole() {
  const [tool, setTool] = useState<AITool>("Codex");
  const [scope, setScope] = useState<Scope>("read");
  const [grants, setGrants] = useState<Grant[]>([]);
  const [notice, setNotice] = useState("");
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [events, setEvents] = useState<AccessEvent[]>([]);
  const [eventState, setEventState] = useState<LoadState>("loading");
  const operationPending = useRef(false);
  const mounted = useRef(false);

  async function loadGrants(signal?: AbortSignal) {
    if (mounted.current) setLoadState("loading");
    try {
      const response = await fetch(ENDPOINT, { cache: "no-store", credentials: "same-origin", signal });
      const payload = await response.json().catch(() => null) as { data?: { grants?: unknown }; error?: unknown } | null;
      if (!response.ok || !Array.isArray(payload?.data?.grants) || !payload.data.grants.every(isGrant)) {
        throw new Error("读取授权通道失败，请刷新后重试");
      }
      if (mounted.current) { setGrants(payload.data.grants); setLoadState("ready"); }
    } catch (error) {
      if (signal?.aborted || !mounted.current) return;
      setLoadState("error");
      setNotice(error instanceof Error && error.message === "读取授权通道失败，请刷新后重试"
        ? error.message : "网络连接失败，请检查网络后重试");
    }
  }

  async function loadEvents(signal?: AbortSignal) {
    if (mounted.current) setEventState("loading");
    try {
      const response = await fetch("/api/ai-access/events", { cache: "no-store", credentials: "same-origin", signal });
      const payload = await response.json().catch(() => null) as { data?: { events?: unknown } } | null;
      if (!response.ok || !Array.isArray(payload?.data?.events) || !payload.data.events.every(isAccessEvent)) {
        throw new Error("读取最近操作失败");
      }
      if (mounted.current) { setEvents(payload.data.events.slice(0, 20)); setEventState("ready"); }
    } catch {
      if (signal?.aborted || !mounted.current) return;
      setEventState("error");
    }
  }

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const clearToken = () => setIssued(null);
    window.addEventListener("pagehide", clearToken);
    void loadGrants(controller.signal);
    void loadEvents(controller.signal);
    return () => {
      mounted.current = false;
      controller.abort();
      window.removeEventListener("pagehide", clearToken);
    };
  }, []);

  async function runAction(action: () => Promise<void>) {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy(true); setNotice("");
    try { await action(); }
    catch { if (mounted.current) setNotice("网络连接失败，请检查网络后重试"); }
    finally {
      operationPending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function createGrant() {
    if (issued || loadState === "loading") return;
    await runAction(async () => {
      const response = await fetch(ENDPOINT, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: tool, scope })
      });
      const payload = await response.json().catch(() => null) as
        { data?: { grant?: unknown; token?: unknown }; error?: unknown } | null;
      if (!mounted.current) return;
      if (!response.ok || !isGrant(payload?.data?.grant) || payload.data.grant.enabled !== false ||
        payload.data.grant.expiresAt !== null || payload.data.grant.revokedAt !== null ||
        payload.data.grant.name !== tool || payload.data.grant.scope !== scope ||
        typeof payload?.data?.token !== "string" || !payload.data.token) {
        setNotice("创建授权通道失败，请刷新后重试");
        return;
      }
      const grant = payload.data.grant;
      setGrants(current => [grant, ...current.filter(item => item.id !== grant.id)]);
      setLoadState("ready");
      setIssued({ id: grant.id, token: payload.data.token });
      setNotice("通道已创建，当前关闭；请保存本次令牌后手动开启");
    });
  }

  async function copyToken() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.token);
      if (mounted.current) setNotice("令牌已复制；请仅交给获准使用通道的 AI 工具");
    } catch {
      if (mounted.current) setNotice("复制失败，请手动选中令牌复制");
    }
  }

  async function revokeGrant(grant: Grant) {
    if (grant.revokedAt) return;
    await runAction(async () => {
      const response = await fetch(`${ENDPOINT}/${encodeURIComponent(grant.id)}`, {
        method: "DELETE", credentials: "same-origin", cache: "no-store"
      });
      const payload = await response.json().catch(() => null) as { data?: { revoked?: unknown } } | null;
      if (!mounted.current) return;
      if (!response.ok || payload?.data?.revoked !== true) { setNotice("撤销失败，请刷新后重试"); return; }
      setGrants(current => current.map(item => item.id === grant.id ? { ...item, enabled: false, revokedAt: new Date().toISOString() } : item));
      if (issued?.id === grant.id) setIssued(null);
      setNotice("通道已永久撤销，令牌立即失效，无法再次开启");
    });
  }

  async function setGrantEnabled(grant: Grant, enabled: boolean) {
    if (grant.revokedAt || grant.expiresAt !== null || grant.enabled === enabled) return;
    await runAction(async () => {
      const response = await fetch(`${ENDPOINT}/${encodeURIComponent(grant.id)}`, {
        method: "PATCH", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled })
      });
      const payload = await response.json().catch(() => null) as { data?: { grant?: unknown } } | null;
      if (!mounted.current) return;
      const updated = payload?.data?.grant;
      if (!response.ok || !isGrant(updated) || updated.id !== grant.id || updated.enabled !== enabled ||
        updated.expiresAt !== null || updated.revokedAt !== null || updated.name !== grant.name || updated.scope !== grant.scope) {
        setNotice(`${enabled ? "开启" : "关闭"}失败，请刷新后重试`);
        return;
      }
      setGrants(current => current.map(item => item.id === updated.id ? updated : item));
      setNotice(enabled ? "通道已开启，不限时间，直到管理员关闭" : "通道已关闭，令牌立即停止访问；需要时可再次开启");
    });
  }

  return (
    <div className={styles.console}>
      <header className={styles.header}>
        <div><p className={styles.eyebrow}>管理员专属</p><h1>AI 授权通道</h1>
          <p>供 Codex、Cursor、Claude Code 等 AI 工具使用，由管理员手动创建、开启或关闭授权，通过统一接口读取信息或执行允许的操作。</p></div>
        <a href="/management" className={styles.back}>返回管理</a>
      </header>

      <section className={styles.card} aria-labelledby="ai-grant-create">
        <h2 id="ai-grant-create">创建通道</h2>
        <div className={styles.createRow}>
          <label className={styles.field} htmlFor="ai-grant-tool"><span>AI 工具</span>
            <select id="ai-grant-tool" value={tool} disabled={busy || !!issued}
              onChange={event => {
                if (operationPending.current || issued) return;
                const selected = event.target.value;
                if (AI_TOOLS.some(option => option === selected)) setTool(selected as AITool);
              }}>
              {AI_TOOLS.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <label className={styles.field} htmlFor="ai-grant-scope"><span>授权范围</span>
            <select id="ai-grant-scope" value={scope} disabled={busy || !!issued}
              onChange={event => setScope(event.target.value === "action" ? "action" : "read")}>
              <option value="read">只读</option><option value="action">允许操作</option>
            </select>
          </label>
          <div><span className={styles.label}>时间控制</span><strong>管理员手动开启 / 关闭</strong></div>
          <button type="button" className={styles.primary} disabled={busy || !!issued || loadState === "loading"} onClick={createGrant}>
            {busy ? "处理中…" : "创建通道"}
          </button>
        </div>
        <p className={styles.help}>不限时间，开启后持续有效，直到管理员关闭。新建通道默认关闭；请先保存令牌，再手动开启。</p>
        <p className={styles.help}>工具名称用于识别授权记录；选择不同工具不会扩大权限。所有工具均须经管理员同意后使用通道。</p>
        <p className={styles.help}>只读可访问身份、授权、店铺列表、模型目录与报告。允许操作目前仅支持切换 AI 使用的店铺，不改变人工浏览器当前店铺。</p>
        <p className={styles.help}>默认只读。付费生图、付款、外部共享、删除和修改用户权限不开放给本通道。</p>
        <p className={styles.help}>只读授权绑定创建时所选店铺；需要换店时，请先切换当前店铺，再创建通道。</p>
      </section>

      {notice && <p className={styles.notice} role="status" aria-live="polite">{notice}</p>}

      {issued && <section className={`${styles.card} ${styles.tokenCard}`} aria-labelledby="ai-grant-token">
        <h2 id="ai-grant-token">请保存本次令牌</h2>
        <p>令牌只在本次创建时显示。收起后无法再次查看；创建通道不会自动启动 AI，也不会自动发送令牌。关闭授权后可用同一令牌再次开启。</p>
        <label className={styles.field} htmlFor="ai-grant-token-value"><span>本次令牌</span>
          <textarea id="ai-grant-token-value" readOnly value={issued.token} rows={3} spellCheck={false} autoComplete="off" />
        </label>
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={copyToken}>复制令牌</button>
          <button type="button" className={styles.secondary} onClick={() => setIssued(null)}>收起并清除令牌</button>
        </div>
      </section>}

      <section className={styles.card} aria-labelledby="ai-grant-list">
        <div className={styles.sectionHeading}><h2 id="ai-grant-list">授权通道</h2>
          <button type="button" className={styles.secondary} disabled={busy || loadState === "loading"}
            onClick={() => { setNotice(""); void loadGrants(); }}>刷新列表</button>
        </div>
        {loadState === "loading" ? <p className={styles.empty}>正在读取通道…</p> :
          loadState === "error" ? <p className={styles.empty}>列表暂不可用，请刷新重试。</p> :
            grants.length === 0 ? <p className={styles.empty}>暂无授权通道。需要使用时再手动创建。</p> :
              <div className={styles.tableWrap}><table className={styles.table}>
                <caption className={styles.srOnly}>管理员 AI 授权通道列表</caption>
                <thead><tr><th>名称</th><th>权限</th><th>时间控制</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>{grants.map(grant => {
                  const status = grantStatus(grant);
                  return <tr key={grant.id}><td>{grant.name}</td><td>{grant.scope === "read" ? "只读" : "允许操作"}</td>
                    <td>{grant.expiresAt === null ? "不限时间" : <span>旧版限时：{expiryText(grant.expiresAt)}<br />请新建通道使用手动开启 / 关闭</span>}</td>
                    <td><span className={status === "已开启" ? styles.active : styles.inactive}>{status}</span></td>
                    <td><div className={styles.grantActions}>
                      {grant.expiresAt === null && <button type="button" className={styles.secondary}
                        disabled={busy || !!grant.revokedAt} onClick={() => setGrantEnabled(grant, !grant.enabled)}>
                        {grant.enabled ? "关闭" : "开启"}</button>}
                      <button type="button" className={styles.revoke} disabled={busy || !!grant.revokedAt}
                        onClick={() => revokeGrant(grant)}>永久撤销</button>
                    </div></td></tr>;
                })}</tbody>
              </table></div>}
      </section>

      <section className={styles.card} aria-labelledby="ai-grant-events">
        <div className={styles.sectionHeading}><h2 id="ai-grant-events">最近操作</h2>
          <button type="button" className={styles.secondary} disabled={busy || eventState === "loading"}
            onClick={() => { void loadEvents(); }}>刷新最近操作</button>
        </div>
        {eventState === "loading" ? <p className={styles.empty}>正在读取最近操作…</p> :
          eventState === "error" ? <p className={styles.empty}>最近操作暂不可用，请刷新重试。</p> :
            events.length === 0 ? <p className={styles.empty}>暂无最近操作。</p> :
              <div className={styles.tableWrap}><table className={styles.table}>
                <caption className={styles.srOnly}>最近 20 条 AI 通道操作</caption>
                <thead><tr><th>名称</th><th>动作</th><th>路径</th><th>结果</th><th>时间（北京时间）</th></tr></thead>
                <tbody>{events.map(event => <tr key={event.id}><td>{event.grantName || "—"}</td>
                  <td>{eventAction(event.type)}</td><td><span className={styles.eventPath}>{[event.method, event.path].filter(Boolean).join(" ") || "—"}</span></td>
                  <td>{event.status === null ? "—" : `${event.status >= 400 ? "失败" : "成功"}（${event.status}）`}</td>
                  <td>{expiryText(event.createdAt)}</td></tr>)}</tbody>
              </table></div>}
      </section>

      <section className={styles.card} aria-labelledby="ai-grant-endpoint">
        <h2 id="ai-grant-endpoint">统一调用接口</h2>
        <p><code>/api/ai-access/execute</code></p>
        <p className={styles.help}>以 <code>Authorization: Bearer &lt;令牌&gt;</code> 明确调用该接口。令牌的范围、开启或关闭状态和永久撤销状态会在每次调用时校验。</p>
        <p className={styles.help}>网页无法识别未声明身份的 AI 视觉点击。本通道授权的是明确的接口请求，页面访问仍受账号权限与网站防护机制约束。</p>
      </section>
    </div>
  );
}
