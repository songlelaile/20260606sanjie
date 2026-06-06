"use client";

import clsx from "clsx";
import { Copy, LogOut, Trash2, UserRoundPlus, UsersRound } from "lucide-react";
import { useMemo, useState } from "react";
import type { InviteCode, ManagedUser, User } from "@/lib/types/domain";

type ManagementTab = "invites" | "users";

export function ManagementConsole({
  initialInvites,
  initialUsers,
  currentUser
}: {
  initialInvites: InviteCode[];
  initialUsers: ManagedUser[];
  currentUser: User;
}) {
  const [activeTab, setActiveTab] = useState<ManagementTab>("invites");
  const [invites, setInvites] = useState(initialInvites);
  const [users] = useState(initialUsers);
  const [note, setNote] = useState("");
  const [maxUses, setMaxUses] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const loginName = currentUser.role === "owner" || currentUser.role === "admin"
    ? "admin"
    : currentUser.email.split("@")[0];

  const inviteRows = useMemo(
    () => [...invites].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [invites]
  );

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
        </div>
        <div className="login-strip" aria-label="当前登录账号">
          <span>登录：</span>
          <strong>{loginName}</strong>
          <b>{roleLabel(currentUser.role)}</b>
          <button type="button" className="outline-button">
            <LogOut size={15} />
            退出
          </button>
        </div>
      </header>

      {activeTab === "invites" ? (
        <>
          <section className="management-form-panel">
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
              <table className="management-table">
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
      ) : (
        <section className="table-panel management-table-panel">
          <div className="panel-toolbar">
            <div>
              <strong>用户列表</strong>
              <span>{users.length} 个账号可访问当前租户</span>
            </div>
          </div>
          <div className="table-wrap">
            <table className="management-table">
              <thead>
                <tr>
                  <th>用户</th>
                  <th>账号</th>
                  <th>角色</th>
                  <th>店铺</th>
                  <th>状态</th>
                  <th>创建时间</th>
                  <th>最近活跃</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <strong>{user.name}</strong>
                      <span>{user.email}</span>
                    </td>
                    <td>{user.username}</td>
                    <td>{roleLabel(user.role)}</td>
                    <td>{user.shopName}</td>
                    <td>{statusLabel(user.status)}</td>
                    <td>{formatFullDateTime(user.createdAt)}</td>
                    <td>{formatFullDateTime(user.lastActiveAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
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
