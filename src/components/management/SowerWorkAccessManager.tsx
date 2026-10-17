"use client";
import { useEffect, useState } from "react";
import type { ToolEntitlementAccess } from "@/lib/types/domain";

type UserRow = {
  id: string; username: string; name: string; tenantId: string;
  status: string; authRole: string; entitlement: ToolEntitlementAccess;
};
const statusNames: Record<string, string> = {
  not_granted: "未开通", active: "已开通", expired: "已到期", revoked: "已撤销"
};
export function SowerWorkAccessManager() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setMessage("");
    const params = new URLSearchParams({ search: query, page: String(page) });
    fetch("/api/admin/sower-work/users?" + params, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const payload = await response.json() as { error?: string; data?: { users: UserRow[]; hasMore: boolean } };
        if (!response.ok || !payload.data) throw new Error(payload.error ?? "读取账号失败");
        if (!controller.signal.aborted) { setUsers(payload.data.users); setHasMore(payload.data.hasMore); }
      })
      .catch((error: Error) => { if (!controller.signal.aborted) { setUsers([]); setHasMore(false); setMessage(error.message); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, page]);
  async function update(user: UserRow, enabled: boolean) {
    setBusyId(user.id);
    setMessage("");
    try {
      const response = await fetch("/api/managed-users/" + encodeURIComponent(user.id) + "/sower-work-access", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ enabled })
      });
      const payload = await response.json() as { error?: string; data?: { entitlement: ToolEntitlementAccess } };
      if (!response.ok || !payload.data) throw new Error(payload.error ?? "授权操作失败");
      const entitlement = payload.data.entitlement;
      setUsers(current => current.map(row => row.id === user.id ? { ...row, entitlement } : row));
      setMessage(enabled ? user.username + " 已开通，自本次操作起有效 30 天" : user.username + " 的 Sower Work 授权已撤销");
    } catch (error) { setMessage(error instanceof Error ? error.message : "授权操作失败"); }
    finally { setBusyId(null); }
  }
  return <section className="tool-card">
    <h2>账号授权</h2>
    <p className="tool-hint">只管理 Sower Work 独立采集插件。开通和续期均从当前时间起重新计算 30 天；撤销立即阻断后续下载、更新和采集核验。管理员本人也需要显式开通使用权。</p>
    <form onSubmit={event => { event.preventDefault(); setPage(1); setQuery(search.trim()); }} style={{ display: "flex", gap: 12, marginBottom: 16 }}>
      <label>账号或姓名 <input value={search} maxLength={80} onChange={event => setSearch(event.target.value)} /></label>
      <button type="submit" disabled={loading || busyId !== null}>查询</button>
    </form>
    <p role="status" aria-live="polite">{loading ? "正在读取账号…" : message}</p>
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
        <thead><tr><th>账号</th><th>官网角色</th><th>账号状态</th><th>Sower Work</th><th>到期时间</th><th>操作</th></tr></thead>
        <tbody>{users.map(user => <tr key={user.id}>
          <td style={{ padding: "12px 8px" }}><strong>{user.username}</strong><br />{user.name}</td>
          <td>{user.authRole === "admin" ? "管理员" : "普通账号"}</td>
          <td>{user.status === "active" ? "正常" : "已停用"}</td>
          <td>{statusNames[user.entitlement.status] ?? "未开通"}</td>
          <td>{user.entitlement.expiresAt ? new Date(user.entitlement.expiresAt).toLocaleString("zh-CN") : "—"}</td>
          <td><div style={{ display: "flex", gap: 8 }}>
            <button type="button" disabled={loading || busyId !== null || user.status !== "active"} onClick={() => update(user, true)}>
              {busyId === user.id ? "处理中…" : user.entitlement.allowed ? "续期 30 天" : "开通 30 天"}
            </button>
            <button type="button" disabled={loading || busyId !== null || !user.entitlement.allowed} onClick={() => update(user, false)}>撤销</button>
          </div></td>
        </tr>)}</tbody>
      </table>
    </div>
    {!loading && users.length === 0 ? <p>未找到符合条件的账号。</p> : null}
    <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
      <button type="button" disabled={loading || busyId !== null || page === 1} onClick={() => setPage(current => current - 1)}>上一页</button>
      <span>第 {page} 页</span>
      <button type="button" disabled={loading || busyId !== null || !hasMore} onClick={() => setPage(current => current + 1)}>下一页</button>
    </div>
  </section>;
}
