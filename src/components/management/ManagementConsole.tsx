"use client";

import clsx from "clsx";
import {
  Ban,
  Bot,
  Copy,
  History,
  KeyRound,
  LineChart,
  LogOut,
  Trash2,
  UserRoundCheck,
  UserRoundPlus,
  UsersRound
} from "lucide-react";
import { useMemo, useState } from "react";
import { AiApiConfigPanel } from "@/components/AiApiConfigPanel";
import { ManagementHistoryPanel } from "@/components/management/ManagementHistoryPanel";
import { ReviewConsole } from "@/components/management/ReviewConsole";
import type {
  Intervention,
  InviteCode,
  ManagementHistoryState,
  ManagedUser,
  User
} from "@/lib/types/domain";

type ManagementTab = "invites" | "users" | "review" | "history" | "ai";

export function ManagementConsole({
  initialInvites,
  initialUsers,
  initialHistory,
  initialInterventions,
  currentUser
}: {
  initialInvites: InviteCode[];
  initialUsers: ManagedUser[];
  initialHistory: ManagementHistoryState;
  initialInterventions: Intervention[];
  currentUser: User;
}) {
  const [activeTab, setActiveTab] = useState<ManagementTab>("history");
  const [invites, setInvites] = useState(initialInvites);
  const [users, setUsers] = useState(initialUsers);
  const [note, setNote] = useState("");
  const [maxUses, setMaxUses] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const loginName =
    currentUser.role === "owner" || currentUser.role === "admin"
      ? "admin"
      : currentUser.email.split("@")[0];

  const inviteRows = useMemo(
    () => [...invites].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [invites]
  );

  async function logout() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", cache: "no-store" });
    } finally {
      window.location.replace("/login");
    }
  }

  async function generateInvite() {
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/invite-codes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note, maxUses })
    });
    const payload = (await response.json()) as { data?: { invite: InviteCode }; error?: string };
    if (payload.data?.invite) {
      setInvites((current) => [payload.data!.invite, ...current]);
      setNote("");
      setMaxUses(1);
      setMessage(`已生成邀请码 ${payload.data.invite.code}`);
    } else {
      setMessage(payload.error ?? "生成失败，请稍后重试");
    }
    setBusy(false);
  }

  async function copyRegistrationLink(invite: InviteCode) {
    const origin = window.location.origin;
    const link = invite.registrationUrl.startsWith("http")
      ? invite.registrationUrl
      : `${origin}${invite.registrationUrl}`;
    await navigator.clipboard.writeText(link);
    setMessage(`已复制 ${invite.code} 注册链接`);
  }

  async function deleteInvite(invite: InviteCode) {
    setBusy(true);
    const response = await fetch(`/api/invite-codes/${invite.id}`, { method: "DELETE" });
    if (response.ok || response.status === 404) {
      setInvites((current) => current.filter((item) => item.id !== invite.id));
      setMessage(`已删除邀请码 ${invite.code}`);
    } else {
      setMessage("删除失败，请刷新后重试");
    }
    setBusy(false);
  }

  async function toggleUserStatus(user: ManagedUser) {
    const nextStatus = user.status === "disabled" ? "active" : "disabled";
    setBusy(true);
    setMessage("");
    const response = await fetch(`/api/managed-users/${user.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: nextStatus })
    });
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    if (response.ok) {
      setUsers((current) =>
        current.map((item) => (item.id === user.id ? { ...item, status: nextStatus } : item))
      );
      setMessage(
        nextStatus === "disabled"
          ? `已禁用 ${user.name}，该账号将无法登录`
          : `已启用 ${user.name}`
      );
    } else {
      setMessage(payload?.error ?? "操作失败，请刷新后重试");
    }
    setBusy(false);
  }

  async function toggleDmpAccess(user: ManagedUser) {
    const enabled = !user.dmpAutomationAccess.allowed;
    const action = enabled ? "开通" : "关闭";
    if (!window.confirm(`确定为「${user.name}（${user.username}）」${action}达摩盘 AI 自动化？`)) {
      return;
    }
    setBusy(true);
    setMessage("");
    const response = await fetch(`/api/managed-users/${user.id}/dmp-access`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled })
    });
    const payload = (await response.json().catch(() => null)) as
      | { data?: { dmpAutomationAccess: ManagedUser["dmpAutomationAccess"] }; error?: string }
      | null;
    if (response.ok && payload?.data?.dmpAutomationAccess) {
      setUsers((current) =>
        current.map((item) =>
          item.id === user.id
            ? { ...item, dmpAutomationAccess: payload.data!.dmpAutomationAccess }
            : item
        )
      );
      setMessage(`已为 ${user.name}${action}达摩盘 AI 自动化`);
    } else {
      setMessage(payload?.error ?? `${action}失败，请刷新后重试`);
    }
    setBusy(false);
  }

  async function resetPassword(user: ManagedUser) {
    if (!window.confirm(`确定重置「${user.name}（${user.username}）」的密码？原密码将立即失效。`)) {
      return;
    }
    setBusy(true);
    setMessage("");
    const response = await fetch(`/api/managed-users/${user.id}/reset-password`, { method: "POST" });
    const payload = (await response.json().catch(() => null)) as
      | { data?: { password: string }; error?: string }
      | null;
    if (response.ok && payload?.data?.password) {
      const newPassword = payload.data.password;
      await navigator.clipboard.writeText(newPassword).catch(() => {});
      setMessage(`已重置 ${user.name} 的密码：${newPassword}（已复制到剪贴板，仅显示这一次，请尽快告知用户）`);
    } else {
      setMessage(payload?.error ?? "重置失败，请刷新后重试");
    }
    setBusy(false);
  }

  async function removeUser(user: ManagedUser) {
    if (!window.confirm(`确定删除用户「${user.name}（${user.username}）」？删除后该账号立即失效，且不可恢复。`)) {
      return;
    }
    setBusy(true);
    setMessage("");
    const response = await fetch(`/api/managed-users/${user.id}`, { method: "DELETE" });
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    if (response.ok) {
      setUsers((current) => current.filter((item) => item.id !== user.id));
      setMessage(`已删除用户 ${user.name}`);
    } else {
      setMessage(payload?.error ?? "删除失败，请刷新后重试");
    }
    setBusy(false);
  }

  return (
    <section className="management-console">
      <h1 className="visually-hidden">管理</h1>
      <header className="management-topbar">
        <div className="management-tabs" role="tablist" aria-label="管理模块">
          <button
            type="button"
            className={clsx("management-tab", activeTab === "invites" && "active")}
            onClick={() => setActiveTab("invites")}
          >
            <UserRoundPlus size={17} />
            邀请码
          </button>
          <button
            type="button"
            className={clsx("management-tab", activeTab === "users" && "active")}
            onClick={() => setActiveTab("users")}
          >
            <UsersRound size={17} />
            用户列表
          </button>
          <button
            type="button"
            className={clsx("management-tab", activeTab === "review" && "active")}
            onClick={() => setActiveTab("review")}
          >
            <LineChart size={17} />
            经营复盘
          </button>
          <button
            type="button"
            className={clsx("management-tab", activeTab === "history" && "active")}
            onClick={() => setActiveTab("history")}
          >
            <History size={17} />
            历史数据
          </button>
          <button
            type="button"
            className={clsx("management-tab", activeTab === "ai" && "active")}
            onClick={() => setActiveTab("ai")}
          >
            <Bot size={17} />
            AI API
          </button>
        </div>
        <div className="login-strip" aria-label="当前登录账号">
          <span>登录：</span>
          <strong>{loginName}</strong>
          <b>{roleLabel(currentUser.role)}</b>
          <button type="button" className="outline-button" onClick={logout} disabled={busy}>
            <LogOut size={15} />
            退出
          </button>
        </div>
      </header>

      {activeTab === "invites" ? (
        <>
          <section className="management-form-panel invite-form-panel">
            <label>
              说明（选填）
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="给谁用 / 备注"
              />
            </label>
            <label>
              可用次数
              <input
                min={1}
                max={99}
                type="number"
                value={maxUses}
                onChange={(event) => setMaxUses(Number(event.target.value))}
              />
            </label>
            <button type="button" onClick={generateInvite} disabled={busy}>
              生成邀请码
            </button>
          </section>

          {message ? <p className="management-message">{message}</p> : null}

          <section className="table-panel management-table-panel">
            <div className="table-wrap">
              <table className="management-table invite-table">
                <thead>
                  <tr>
                    <th>邀请码</th>
                    <th>注册链接</th>
                    <th>用量</th>
                    <th>创建时间</th>
                    <th>说明</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {inviteRows.map((invite) => (
                    <tr key={invite.id}>
                      <td className="invite-code-cell">{invite.code}</td>
                      <td>
                        <button
                          type="button"
                          className="copy-link-button"
                          onClick={() => copyRegistrationLink(invite)}
                        >
                          <Copy size={14} />
                          复制注册链接
                        </button>
                      </td>
                      <td>
                        {invite.usedCount} / {invite.maxUses}
                      </td>
                      <td>{formatFullDateTime(invite.createdAt)}</td>
                      <td>{invite.note}</td>
                      <td>
                        <button
                          type="button"
                          className="danger-outline-button"
                          disabled={busy}
                          onClick={() => deleteInvite(invite)}
                        >
                          <Trash2 size={14} />
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}

      {activeTab === "users" ? (
        <section className="table-panel management-table-panel">
          <div className="panel-toolbar">
            <div>
              <strong>用户列表</strong>
              <span>{users.length} 个租户账号</span>
            </div>
          </div>
          {message ? <p className="management-message">{message}</p> : null}
          <div className="table-wrap">
            <table className="management-table user-table">
              <thead>
                <tr>
                  <th>用户</th>
                  <th>账号</th>
                  <th>角色</th>
                  <th>店铺</th>
                  <th>状态</th>
                  <th>达摩盘工具</th>
                  <th>创建时间</th>
                  <th>最近活跃</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  const isAdminAccount = user.role === "owner" || user.role === "admin";
                  return (
                  <tr key={user.id} className={user.status === "disabled" ? "row-disabled" : undefined}>
                    <td>
                      <strong>{user.name}</strong>
                      <span>{user.email}</span>
                    </td>
                    <td>{user.username}</td>
                    <td>{roleLabel(user.role)}</td>
                    <td>{user.shopName}</td>
                    <td>
                      <span className={clsx("user-status-pill", user.status)}>
                        {statusLabel(user.status)}
                      </span>
                    </td>
                    <td>
                      <span className={clsx("user-status-pill", `dmp-${user.dmpAutomationAccess.status}`)}>
                        {dmpAccessLabel(user.dmpAutomationAccess.status)}
                      </span>
                    </td>
                    <td>{formatFullDateTime(user.createdAt)}</td>
                    <td>{formatFullDateTime(user.lastActiveAt)}</td>
                    <td>
                      <div className="user-actions">
                        <button
                          type="button"
                          className={user.dmpAutomationAccess.allowed ? "danger-outline-button" : "copy-link-button"}
                          disabled={busy}
                          onClick={() => toggleDmpAccess(user)}
                        >
                          <Bot size={14} />
                          {user.dmpAutomationAccess.allowed ? "关闭达摩盘" : "开通达摩盘"}
                        </button>
                        {!isAdminAccount ? (
                          <>
                            <button
                              type="button"
                              className="copy-link-button"
                              disabled={busy}
                              onClick={() => resetPassword(user)}
                            >
                              <KeyRound size={14} />
                              重置密码
                            </button>
                            <button
                              type="button"
                              className={user.status === "disabled" ? "copy-link-button" : "danger-outline-button"}
                              disabled={busy}
                              onClick={() => toggleUserStatus(user)}
                            >
                              {user.status === "disabled" ? (
                                <>
                                  <UserRoundCheck size={14} />
                                  启用
                                </>
                              ) : (
                                <>
                                  <Ban size={14} />
                                  禁用
                                </>
                              )}
                            </button>
                            <button
                              type="button"
                              className="danger-outline-button"
                              disabled={busy}
                              onClick={() => removeUser(user)}
                            >
                              <Trash2 size={14} />
                              删除
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {activeTab === "review" ? <ReviewConsole interventions={initialInterventions} /> : null}

      {activeTab === "history" ? <ManagementHistoryPanel initialHistory={initialHistory} /> : null}

      {activeTab === "ai" ? <AiApiConfigPanel variant="page" /> : null}
    </section>
  );
}

function formatFullDateTime(value: string) {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function roleLabel(role: User["role"]) {
  const labels: Record<User["role"], string> = {
    owner: "admin",
    admin: "admin",
    operator: "运营",
    viewer: "查看"
  };
  return labels[role];
}

function statusLabel(status: ManagedUser["status"]) {
  const labels: Record<ManagedUser["status"], string> = {
    active: "启用",
    pending: "待激活",
    disabled: "停用"
  };
  return labels[status];
}

function dmpAccessLabel(status: ManagedUser["dmpAutomationAccess"]["status"]) {
  const labels: Record<ManagedUser["dmpAutomationAccess"]["status"], string> = {
    active: "已开通",
    expired: "已过期",
    revoked: "已关闭",
    not_granted: "未开通"
  };
  return labels[status];
}
