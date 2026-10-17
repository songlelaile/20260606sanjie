"use client";

import { Eye, EyeOff } from "lucide-react";
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { safeDmpReportReturnPath } from "@/lib/dmp-report-share-path";
import { BrandIdentity } from "@/components/BrandIdentity";

type Tab = "login" | "register" | "invite";

const FEATURES = [
  { title: "作图", desc: "主图、详情、清单成图、清单成详、批量 SKU 和爆款裂变在同一工作台完成" },
  { title: "做视频", desc: "按创作路线和视觉风格提交真实视频任务" },
  { title: "注册与开通", desc: "手机号自主注册建立独立工作区，充值后开通；受邀客户可凭邀请码访问" }
];

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginView />
    </Suspense>
  );
}

function LoginView() {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>("login");

  // 登录
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  // 自主注册 / 邀请注册共用字段
  const [regName, setRegName] = useState("");
  const [regUsername, setRegUsername] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [showRegPassword, setShowRegPassword] = useState(false);
  const [inviteCode, setInviteCode] = useState("");

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submissionPending = useRef(false);

  // 管理后台「复制注册链接」生成的是 /login?invite=CODE：自动切到邀请注册并回填邀请码。
  useEffect(() => {
    const code = searchParams.get("invite");
    if (code) {
      setInviteCode(code.toUpperCase());
      setTab("invite");
    }
  }, [searchParams]);

  function switchTab(next: Tab) {
    if (submissionPending.current) return;
    setTab(next);
    setError("");
  }

  async function submitLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submissionPending.current) return;
    submissionPending.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
        cache: "no-store"
      });
      const payload = (await response.json().catch(() => null)) as
        | { data?: { home: string }; error?: string }
        | null;
      if (!response.ok || !payload?.data) {
        setError(payload?.error ?? "登录失败，请重试");
        return;
      }
      // 分享报告必须回到官网原链接继续做账号归属校验；只接受固定站内路径，拒绝开放重定向。
      const returnTo = safeDmpReportReturnPath(searchParams.get("returnTo"));
      // 账号切换必须重建整个文档，避免复用上一租户的 Next Router Cache。
      window.location.replace(returnTo || payload.data.home);
    } catch {
      setError("网络连接失败，请检查网络后重试");
    } finally {
      submissionPending.current = false;
      setBusy(false);
    }
  }

  async function submitRegister(event: React.FormEvent<HTMLFormElement>, withInvite: boolean) {
    event.preventDefault();
    if (submissionPending.current) return;
    if (withInvite && !inviteCode.trim()) {
      setError("请输入邀请码，或切换到自主注册后充值开通");
      return;
    }
    submissionPending.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: regName,
          username: regUsername,
          password: regPassword,
          ...(withInvite ? { inviteCode: inviteCode.trim().toUpperCase() } : {})
        }),
        cache: "no-store"
      });
      const payload = (await response.json().catch(() => null)) as
        | { data?: { home: string }; error?: string }
        | null;
      if (!response.ok || !payload?.data) {
        setError(payload?.error ?? "注册失败，请重试");
        return;
      }
      window.location.replace(payload.data.home);
    } catch {
      setError("网络连接失败，请检查网络后重试");
    } finally {
      submissionPending.current = false;
      setBusy(false);
    }
  }

  function renderRegisterForm(withInvite: boolean) {
    return (
      <form className="auth-form" onSubmit={(event) => void submitRegister(event, withInvite)}>
        <label>
          姓名 / 昵称
          <input
            value={regName}
            onChange={(event) => setRegName(event.target.value)}
            autoComplete="name"
            maxLength={50}
            placeholder="如何称呼你"
          />
        </label>
        <label>
          手机号
          <input
            value={regUsername}
            onChange={(event) => setRegUsername(event.target.value.replace(/\D/g, ""))}
            autoComplete="tel"
            inputMode="numeric"
            maxLength={11}
            required
            pattern="1[3-9][0-9]{9}"
            placeholder="请输入 11 位手机号"
          />
          <small className="auth-field-hint">作为登录账号；忘记密码请联系管理员重置</small>
        </label>
        <label>
          密码
          <span className="password-input-wrap">
            <input
              type={showRegPassword ? "text" : "password"}
              value={regPassword}
              onChange={(event) => setRegPassword(event.target.value)}
              autoComplete="new-password"
              required
              minLength={6}
              maxLength={128}
              placeholder="至少 6 个字符"
            />
            <button
              type="button"
              className="password-visibility-button"
              aria-label={showRegPassword ? "隐藏密码" : "显示密码"}
              title={showRegPassword ? "隐藏密码" : "显示密码"}
              onClick={() => setShowRegPassword((current) => !current)}
            >
              {showRegPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </span>
        </label>
        {withInvite ? (
          <label>
            邀请码
            <input
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value.toUpperCase())}
              autoComplete="off"
              required
              minLength={6}
              maxLength={32}
              pattern="[A-Za-z0-9]{6,32}"
              placeholder="请输入邀请码"
            />
          </label>
        ) : null}
        {error ? <p className="auth-error" role="alert">{error}</p> : null}
        <button type="submit" className="auth-submit" disabled={busy}>
          {busy ? "注册中…" : withInvite ? "凭邀请码注册并登录" : "注册独立工作区"}
        </button>
        {withInvite ? (
          <p className="auth-hint">受邀客户注册后可访问作图与视频工作台。没有邀请码？可自主注册独立工作区，充值后开通。达摩盘工具需单独授权。</p>
        ) : (
          <p className="auth-hint">注册后将创建属于你的独立工作区；非受邀客户须充值开通作图与视频工作台。达摩盘工具需单独授权。</p>
        )}
      </form>
    );
  }

  return (
    <div className="auth-shell">
      <aside className="auth-hero">
        <div className="auth-hero-brand">
          <BrandIdentity variant="hero" subtitle="作图 · 视频" />
        </div>
        <div className="auth-hero-headline">
          <h2>把商品素材，变成可发布的主图和视频</h2>
          <p>自主注册建立独立工作区，充值后开通作图与视频；受邀客户可凭邀请码访问。</p>
        </div>
        <ul className="auth-hero-features">
          {FEATURES.map((f) => (
            <li key={f.title}>
              <strong>{f.title}</strong>
              <span>{f.desc}</span>
            </li>
          ))}
        </ul>
      </aside>

      <main className="auth-panel">
        <div className="auth-card">
          <BrandIdentity variant="mobileLogin" subtitle="作图 · 视频" />
          <div className="auth-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              disabled={busy}
              aria-selected={tab === "login"}
              className={tab === "login" ? "is-active" : ""}
              onClick={() => switchTab("login")}
            >
              登录
            </button>
            <button
              type="button"
              role="tab"
              disabled={busy}
              aria-selected={tab === "register"}
              className={tab === "register" ? "is-active" : ""}
              onClick={() => switchTab("register")}
            >
              自主注册
            </button>
            <button
              type="button"
              role="tab"
              disabled={busy}
              aria-selected={tab === "invite"}
              className={tab === "invite" ? "is-active" : ""}
              onClick={() => switchTab("invite")}
            >
              邀请注册
            </button>
          </div>

          {tab === "login" ? (
            <form className="auth-form" onSubmit={submitLogin}>
              <label>
                账号（手机号）
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  required
                  placeholder="请输入账号或手机号"
                />
              </label>
              <label>
                密码
                <span className="password-input-wrap">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    required
                    placeholder="请输入密码"
                  />
                  <button
                    type="button"
                    className="password-visibility-button"
                    aria-label={showPassword ? "隐藏密码" : "显示密码"}
                    title={showPassword ? "隐藏密码" : "显示密码"}
                    onClick={() => setShowPassword((current) => !current)}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </span>
              </label>
              {error ? <p className="auth-error" role="alert">{error}</p> : null}
              <button type="submit" className="auth-submit" disabled={busy}>
                {busy ? "登录中…" : "登录"}
              </button>
            </form>
          ) : tab === "register" ? (
            renderRegisterForm(false)
          ) : (
            renderRegisterForm(true)
          )}
        </div>
      </main>
    </div>
  );
}
