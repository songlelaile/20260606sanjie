"use client";

import clsx from "clsx";
import {
  Ban,
  Bot,
  Coins,
  Copy,
  KeyRound,
  LogOut,
  Share2,
  Trash2,
  UserRoundCheck,
  UserRoundPlus,
  UsersRound,
  WalletCards
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { AiApiConfigPanel } from "@/components/AiApiConfigPanel";
import { DmpShareAnalyticsPanel } from "@/components/management/DmpShareAnalyticsPanel";
import { CreditGiftPanel } from "@/components/management/CreditGiftPanel";
import { GatewayBillingPanel } from "@/components/model-gateway/GatewayBillingPanel";
import { DMP_AUTOMATION_NAME } from "@/lib/dmp-product";
import type { CreativeAccess } from "@/lib/creative-access-policy";
import type {
  InviteCode,
  ManagedUser,
  ToolEntitlementAccess,
  User
} from "@/lib/types/domain";

type ManagementTab = "invites" | "users" | "sharing" | "ai" | "billing" | "gifts";
type RegistrationManagedUser = ManagedUser & {
  authRole?: "admin" | "tenant";
  registrationSource?: "self" | "invite" | "legacy";
  inviteCodeId?: string | null;
  registrationSourceRecordedAt?: string | null;
  registeredBy?: string | null;
  creativeStudioAccess?: ToolEntitlementAccess;
  creativeAccess?: CreativeAccess;
};

export function ManagementConsole({
  initialInvites,
  initialUsers,
  currentUser,
  canManageGatewayBilling = false
}: {
  initialInvites: InviteCode[];
  initialUsers: RegistrationManagedUser[];
  currentUser: User;
  canManageGatewayBilling?: boolean;
}) {
  const [activeTab, setActiveTab] = useState<ManagementTab>("invites");
  const [invites, setInvites] = useState(initialInvites);
  const [users, setUsers] = useState(initialUsers);
  const [note, setNote] = useState("");
  const [maxUses, setMaxUses] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [giftUserId, setGiftUserId] = useState("");
  const operationPending = useRef(false);
  const loginName =
    currentUser.role === "owner" || currentUser.role === "admin"
      ? "admin"
      : currentUser.email.split("@")[0];

  const inviteRows = useMemo(
    () => [...invites].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [invites]
  );

  async function runAction(action: () => Promise<void>) {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch {
      setMessage("网络连接失败，请检查网络后重试");
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  }

  async function logout() {
    await runAction(async () => {
      const response = await fetch("/api/auth/logout", { method: "POST", cache: "no-store" });
      if (response.ok) {
        window.location.replace("/login");
      } else {
        setMessage("退出失败，请重试");
      }
    });
  }

  async function refreshUserList() {
    try {
      const response = await fetch("/api/managed-users", { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as
        | { data?: { users: RegistrationManagedUser[] } }
        | null;
      if (!response.ok || !Array.isArray(payload?.data?.users)) return false;
      setUsers(payload.data.users);
      return true;
    } catch {
      return false;
    }
  }

  async function generateInvite() {
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 99) {
      setMessage("可用次数必须是 1 到 99 的整数");
      return;
    }
    await runAction(async () => {
      const response = await fetch("/api/invite-codes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: note.trim(), maxUses }),
        cache: "no-store"
      });
      const payload = (await response.json().catch(() => null)) as
        | { data?: { invite: InviteCode }; error?: string }
        | null;
      if (response.ok && payload?.data?.invite) {
        setInvites((current) => [payload.data!.invite, ...current]);
        setNote("");
        setMaxUses(1);
        setMessage(`已生成邀请码 ${payload.data.invite.code}`);
      } else {
        setMessage(payload?.error ?? "生成失败，请稍后重试");
      }
    });
  }

  async function copyRegistrationLink(invite: InviteCode) {
    const origin = window.location.origin;
    const link = invite.registrationUrl.startsWith("http")
      ? invite.registrationUrl
      : `${origin}${invite.registrationUrl}`;
    await runAction(async () => {
      try {
        await navigator.clipboard.writeText(link);
        setMessage(`已复制 ${invite.code} 注册链接`);
      } catch {
        setMessage(`复制失败，请手动复制注册链接：${link}`);
      }
    });
  }

  async function revokeInvite(invite: InviteCode) {
    if (!window.confirm(`确定撤销邀请码「${invite.code}」？撤销后不可再用于注册，已注册账号、工作区及历史数据保留。`)) {
      return;
    }
    await runAction(async () => {
      const response = await fetch(`/api/invite-codes/${invite.id}`, { method: "DELETE", cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (response.ok || response.status === 404) {
        setInvites((current) => current.filter((item) => item.id !== invite.id));
        setMessage(`已撤销邀请码 ${invite.code}，既有账号及历史数据保留`);
      } else {
        setMessage(payload?.error ?? "撤销失败，请刷新后重试");
      }
    });
  }

  async function toggleUserStatus(user: RegistrationManagedUser) {
    const nextStatus = user.status === "disabled" ? "active" : "disabled";
    await runAction(async () => {
      const response = await fetch(`/api/managed-users/${user.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
        cache: "no-store"
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (response.ok) {
        setUsers((current) =>
          current.map((item) => (item.id === user.id ? {
            ...item, status: nextStatus,
            creativeAccess: nextStatus === "active" && item.creativeAccess?.reason === "invalid_account" ? undefined : item.creativeAccess
          } : item))
        );
        const refreshed = await refreshUserList();
        setMessage(
          (nextStatus === "disabled"
            ? `已停用 ${user.name}，该账号将无法访问；工作区、配置、历史数据和已有授权保留`
            : `已启用 ${user.name}，原工作区、配置、历史数据和已有授权保留`)
          + (refreshed ? "" : "；列表刷新失败，请刷新页面核对")
        );
      } else {
        setMessage(payload?.error ?? "操作失败，请刷新后重试");
      }
    });
  }

  async function toggleDmpAccess(user: ManagedUser) {
    const enabled = !user.dmpAutomationAccess.allowed;
    const action = enabled
      ? user.dmpAutomationAccess.status === "expired" ? "续费 30 天" : "开通 30 天"
      : "关闭";
    if (!window.confirm(`确定为「${user.name}（${user.username}）」${action}${DMP_AUTOMATION_NAME}？开通或续费后到期将自动关闭。`)) {
      return;
    }
    await runAction(async () => {
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
        setMessage(enabled
          ? `已为 ${user.name}开通${DMP_AUTOMATION_NAME}，有效期 30 天`
          : `已为 ${user.name}关闭${DMP_AUTOMATION_NAME}`);
      } else {
        setMessage(payload?.error ?? `${action}失败，请刷新后重试`);
      }
    });
  }

  async function toggleCreativeAccess(user: RegistrationManagedUser) {
    if (!user.creativeStudioAccess) return;
    const enabled = !user.creativeStudioAccess.allowed;
    const action = enabled ? "开通" : "撤销";
    const confirmation = enabled
      ? `请确认「${user.name}（${user.username}）」是受邀客户，并为其开通作图与视频工作台。此次确认保留原注册来源，达摩盘授权需单独管理。`
      : `确定撤销「${user.name}（${user.username}）」的受邀工作台权限？工作区和历史数据保留，达摩盘授权需单独管理。`;
    if (!window.confirm(confirmation)) {
      return;
    }
    await runAction(async () => {
      const response = await fetch(`/api/managed-users/${user.id}/creative-access`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
        cache: "no-store"
      });
      const payload = (await response.json().catch(() => null)) as
        | { data?: { creativeAccess: { allowed: boolean } }; error?: string }
        | null;
      if (response.ok && payload?.data?.creativeAccess) {
        if (await refreshUserList()) {
          setMessage(`已为 ${user.name}${action}受邀工作台权限，原注册来源、工作区和历史数据保留`);
        } else {
          setMessage(`受邀权限${action}已完成，列表刷新失败，请刷新页面核对`);
        }
      } else {
        setMessage(payload?.error ?? `${action}失败，请刷新后重试`);
      }
    });
  }

  async function resetPassword(user: RegistrationManagedUser) {
    if (!window.confirm(`确定重置「${user.name}（${user.username}）」的密码？原密码将立即失效，工作区与历史数据保留。`)) {
      return;
    }
    await runAction(async () => {
      const response = await fetch(`/api/managed-users/${user.id}/reset-password`, { method: "POST", cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as
        | { data?: { password: string }; error?: string }
        | null;
      if (response.ok && payload?.data?.password) {
        const newPassword = payload.data.password;
        let copied = false;
        try {
          await navigator.clipboard.writeText(newPassword);
          copied = true;
        } catch {
          // 密码已经重置，复制失败时仍展示新密码供管理员手动复制。
        }
        setMessage(`已重置 ${user.name} 的密码：${newPassword}（${copied ? "已复制到剪贴板" : "复制失败，请手动复制"}；仅显示这一次，请妥善保存并告知用户）`);
      } else {
        setMessage(payload?.error ?? "重置失败，请刷新后重试");
      }
    });
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
            className={clsx("management-tab", activeTab === "sharing" && "active")}
            onClick={() => setActiveTab("sharing")}
          >
            <Share2 size={17} />
            传播分析
          </button>
          <button
            type="button"
            className={clsx("management-tab", activeTab === "ai" && "active")}
            onClick={() => setActiveTab("ai")}
          >
            <Bot size={17} />
            AI API
          </button>
          {canManageGatewayBilling ? (
            <button
              type="button"
              className={clsx("management-tab", activeTab === "billing" && "active")}
              onClick={() => setActiveTab("billing")}
            >
              <WalletCards size={17} />
              积分账本
            </button>
          ) : null}
          {canManageGatewayBilling ? (
            <button type="button" className={clsx("management-tab", activeTab === "gifts" && "active")} onClick={() => setActiveTab("gifts")}>
              <Coins size={17} />赠送积分
            </button>
          ) : null}
        </div>
        <div className="login-strip" aria-label="当前登录账号">
          <span>登录：</span>
          <strong>{loginName}</strong>
          <b>{roleLabel(currentUser.role)}</b>
          <a href="/management/payments" className="outline-button">付款核对</a>
          {canManageGatewayBilling ? <a href="/management/ai-access" className="outline-button">AI 授权通道</a> : null}
          <button type="button" className="outline-button" onClick={logout} disabled={busy}>
            <LogOut size={15} />
            退出
          </button>
        </div>
      </header>

      {message ? <p className="management-message" role="status" aria-live="polite">{message}</p> : null}

      {activeTab === "invites" ? (
        <>
          <section className="management-form-panel invite-form-panel">
            <label>
              说明（选填）
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={200}
                disabled={busy}
                placeholder="给谁用 / 备注"
              />
            </label>
            <label>
              可用次数
              <input
                min={1}
                max={99}
                type="number"
                step={1}
                value={maxUses}
                onChange={(event) => setMaxUses(Number(event.target.value))}
                disabled={busy}
              />
            </label>
            <button type="button" onClick={generateInvite} disabled={busy}>
              生成邀请码
            </button>
            <p className="auth-field-hint" style={{ gridColumn: "1 / -1", margin: 0 }}>
              邀请码供受邀客户注册并访问作图与视频；每次注册建立独立工作区。达摩盘工具需单独授权。撤销邀请码不影响已注册账号及历史数据。
            </p>
          </section>

          <section className="table-panel management-table-panel">
            <div className="table-wrap">
              <table className="management-table invite-table">
                <thead>
                  <tr>
                    <th>邀请码</th>
                    <th>注册链接</th>
                    <th>使用 / 剩余</th>
                    <th>创建时间</th>
                    <th>说明</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {inviteRows.length === 0 ? (
                    <tr><td colSpan={6}>暂无邀请码，可在上方生成。自主注册客户须充值开通。</td></tr>
                  ) : null}
                  {inviteRows.map((invite) => (
                    <tr key={invite.id}>
                      <td className="invite-code-cell">
                        <strong>{invite.code}</strong>
                        <span className={clsx("user-status-pill", invite.usedCount < invite.maxUses ? "active" : "disabled")}>
                          {invite.usedCount < invite.maxUses ? "可用" : "用尽"}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="copy-link-button"
                          disabled={busy || invite.usedCount >= invite.maxUses}
                          onClick={() => copyRegistrationLink(invite)}
                        >
                          <Copy size={14} />
                          复制注册链接
                        </button>
                      </td>
                      <td>
                        {invite.usedCount} / {invite.maxUses}
                        <span>剩余 {Math.max(0, invite.maxUses - invite.usedCount)} 次</span>
                      </td>
                      <td>{formatFullDateTime(invite.createdAt)}</td>
                      <td>{invite.note || "—"}</td>
                      <td>
                        <button
                          type="button"
                          className="danger-outline-button"
                          disabled={busy}
                          onClick={() => revokeInvite(invite)}
                        >
                          <Trash2 size={14} />
                          撤销
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
              <span>{users.length} 个账号 · 自主注册须充值开通，受邀客户可访问 · 启停保留工作区、配置和历史数据</span>
            </div>
          </div>
          <p className="auth-field-hint">作图/视频访问列显示实际开通状态；受邀工作台列单独显示受邀权限。旧账号待核对，管理员确认客户受邀后可开通，原注册来源保留。</p>
          <div className="table-wrap">
            <table className="management-table registration-user-table" style={{ minWidth: 2560, width: "100%", tableLayout: "auto" }}>
              <colgroup>
                {[160, 120, 180, 210, 130, 140, 80, 160, 160, 130, 155, 155, 155, 155, 270].map((width, index) => <col key={index} style={{ width }} />)}
              </colgroup>
              <thead>
                <tr>
                  <th>用户</th>
                  <th>账号</th>
                  <th>工作区 ID</th>
                  <th>注册来源</th>
                  <th>账号权限</th>
                  <th>店铺</th>
                  <th>状态</th>
                  <th>作图 / 视频访问</th>
                  <th>受邀工作台</th>
                  <th>达摩盘工具</th>
                  <th>账号注册时间</th>
                  <th>达摩盘开通时间</th>
                  <th>达摩盘到期时间</th>
                  <th>最近活跃</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 ? <tr><td colSpan={15}>暂无账号。新注册账号将在此显示，旧账号来源缺失时需核对。</td></tr> : null}
                {users.map((user) => {
                  const isAdminAccount = user.authRole === "admin" || (!user.authRole && (user.role === "owner" || user.role === "admin"));
                  return (
                  <tr key={user.id} className={user.status === "disabled" ? "row-disabled" : undefined} style={user.status === "disabled" ? { opacity: 0.6 } : undefined}>
                    <td>
                      <strong>{user.name}</strong>
                      <span style={{ display: "block", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.email}</span>
                    </td>
                    <td>{user.username}</td>
                    <td style={{ overflowWrap: "anywhere", wordBreak: "break-word", maxWidth: 180 }}>{user.tenantId}</td>
                    <td style={{ overflowWrap: "anywhere", wordBreak: "break-word", maxWidth: 210 }}>
                      <strong>{registrationSourceLabel(user.registrationSource)}</strong>
                      {user.registrationSource === "invite" && user.inviteCodeId ? <span>邀请码 ID：{user.inviteCodeId}</span> : null}
                      {user.registrationSourceRecordedAt ? <span>记录于 {formatFullDateTime(user.registrationSourceRecordedAt)}</span> : null}
                    </td>
                    <td>{accountRoleLabel(user)}</td>
                    <td>{user.shopName}</td>
                    <td>
                      <span className={clsx("user-status-pill", user.status)}>
                        {statusLabel(user.status)}
                      </span>
                    </td>
                    <td>
                      <span className={clsx("user-status-pill", user.status !== "disabled" && user.creativeAccess?.allowed ? "active" : "disabled")}>
                        {liveCreativeAccessLabel(user)}
                      </span>
                      {user.creativeAccess?.expiresAt ? <span>到期 {formatFullDateTime(user.creativeAccess.expiresAt)}</span> : null}
                    </td>
                    <td>
                      <span className={clsx("user-status-pill", user.creativeStudioAccess?.allowed ? "active" : "disabled")}>
                        {user.authRole === "admin" ? "管理权限" : creativeAccessLabel(user)}
                      </span>
                      {user.creativeStudioAccess?.expiresAt ? <span>到期 {formatFullDateTime(user.creativeStudioAccess.expiresAt)}</span> : null}
                    </td>
                    <td>
                      <span className={clsx("user-status-pill", `dmp-${user.dmpAutomationAccess.status}`)}>
                        {dmpAccessLabel(user.dmpAutomationAccess)}
                      </span>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>{formatFullDateTime(user.createdAt)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{formatNullableDateTime(user.dmpAutomationAccess.grantedAt)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{formatNullableDateTime(user.dmpAutomationAccess.expiresAt)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{formatFullDateTime(user.lastActiveAt)}</td>
                    <td>
                      <div className="user-actions">
                        {canManageGatewayBilling && user.status === "active" ? (
                          <button type="button" className="copy-link-button" disabled={busy} onClick={() => { setGiftUserId(user.id); setActiveTab("gifts"); }}>
                            <Coins size={14} />赠送积分
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={user.dmpAutomationAccess.allowed ? "danger-outline-button" : "copy-link-button"}
                          disabled={busy}
                          onClick={() => toggleDmpAccess(user)}
                        >
                          <Bot size={14} />
                          {user.dmpAutomationAccess.allowed
                            ? "关闭达摩盘"
                            : user.dmpAutomationAccess.status === "expired"
                              ? "续费30天"
                              : "开通30天"}
                        </button>
                        {!isAdminAccount ? (
                          <>
                            {user.creativeStudioAccess ? (
                              <button
                                type="button"
                                className={user.creativeStudioAccess.allowed ? "danger-outline-button" : "copy-link-button"}
                                disabled={busy}
                                onClick={() => toggleCreativeAccess(user)}
                              >
                                <UserRoundCheck size={14} />
                                {user.creativeStudioAccess.allowed ? "撤销受邀权限" : "确认受邀开通"}
                              </button>
                            ) : null}
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
                                  停用
                                </>
                              )}
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

      {activeTab === "sharing" ? <DmpShareAnalyticsPanel /> : null}

      {activeTab === "ai" ? <AiApiConfigPanel variant="page" /> : null}

      {activeTab === "billing" && canManageGatewayBilling ? <GatewayBillingPanel /> : null}
      {activeTab === "gifts" && canManageGatewayBilling ? <CreditGiftPanel key={currentUser.id} users={users} initialUserId={giftUserId || undefined} adminId={currentUser.id} /> : null}
    </section>
  );
}

function formatFullDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).format(date);
}

function formatNullableDateTime(value: string | null) {
  return value ? formatFullDateTime(value) : "—";
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

function accountRoleLabel(user: RegistrationManagedUser) {
  if (user.authRole === "admin") return "平台管理员";
  if (user.authRole !== "tenant") return "账号权限待核对";
  const labels: Record<User["role"], string> = {
    owner: "工作区所有者",
    admin: "工作区管理员",
    operator: "运营",
    viewer: "查看"
  };
  return `客户 · ${labels[user.role]}`;
}

function registrationSourceLabel(source: RegistrationManagedUser["registrationSource"]) {
  if (source === "self") return "自主注册";
  if (source === "invite") return "邀请码注册";
  return "旧账号待核对";
}

function creativeAccessLabel(user: RegistrationManagedUser) {
  const access = user.creativeStudioAccess;
  if (!access) return "授权待核对";
  if (access.allowed) return access.expiresAt ? `受邀剩余 ${access.remainingDays} 天` : "受邀已开通";
  const labels: Record<ToolEntitlementAccess["status"], string> = {
    active: "授权待核对",
    expired: "受邀已过期",
    revoked: "受邀已撤销",
    not_granted: "未授受邀权限"
  };
  return labels[access.status];
}

function liveCreativeAccessLabel(user: RegistrationManagedUser) {
  if (user.status === "disabled") return "账号停用";
  const access = user.creativeAccess;
  if (!access) return "访问待核对";
  const labels: Record<CreativeAccess["reason"], string> = {
    admin: "管理权限",
    invited: "受邀可访问",
    paid: "充值可访问",
    expired: "已过期",
    payment_required: "须充值开通",
    invalid_account: "账号停用或失效",
    unavailable: "暂不可用"
  };
  return labels[access.reason];
}

function statusLabel(status: ManagedUser["status"]) {
  const labels: Record<ManagedUser["status"], string> = {
    active: "启用",
    pending: "待激活",
    disabled: "停用"
  };
  return labels[status];
}

function dmpAccessLabel(access: ManagedUser["dmpAutomationAccess"]) {
  const labels: Record<ManagedUser["dmpAutomationAccess"]["status"], string> = {
    active: `剩余 ${access.remainingDays} 天`,
    expired: "已过期",
    revoked: "已关闭",
    not_granted: "未开通"
  };
  return labels[access.status];
}
