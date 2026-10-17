"use client";

import { RefreshCw, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import styles from "./RelaySettingsPanel.module.css";

type SupplySlot = { id: string; status: string; providerKeyId: string | null } | null;
type UserSupplyStatus = {
  userId: string;
  username: string;
  name: string;
  accountStatus: string;
  primary: SupplySlot;
  backup: SupplySlot;
};
type ProvisioningView = { configured: boolean; missing: string[]; emailMasked?: string; groupId?: string; quotaUsd?: number; baseUrl?: string; retryReset?: "ready" | "unavailable" };
type SupplyOverview = { provisioning: ProvisioningView; users: UserSupplyStatus[] };
type BatchResult = { processed: number; ready: number; failed: number; remaining: number; errors?: Array<{ userId: string; code: string }> };

const endpoint = "/api/management/user-supply";

async function request<T>(options?: RequestInit): Promise<T> {
  const response = await fetch(endpoint, { cache: "no-store", credentials: "same-origin", ...options });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof json?.error === "string" ? json.error : `操作失败（HTTP ${response.status}），请重试。`);
  if (!json?.data) throw new Error("服务器返回了无法识别的数据，请重试。");
  return json.data as T;
}

function slotText(slot: SupplySlot) {
  if (!slot) return "待配置";
  const labels: Record<string, string> = { ready: "已就绪", pending: "待发行", provisioning: "发行中", failed: "发行失败", disabled: "已停用" };
  return labels[slot.status] || "状态待确认";
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "网络连接失败，请重试。";
}

export function UserSupplyPanel() {
  const [overview, setOverview] = useState<SupplyOverview | null>(null);
  const [busy, setBusy] = useState<"load" | "backfill" | "save" | "">("load");
  const [message, setMessage] = useState("正在读取注册用户主备 Key 状态...");
  const [failed, setFailed] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [groupId, setGroupId] = useState("");
  const [quotaUsd, setQuotaUsd] = useState("");
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooldownReason, setCooldownReason] = useState<"rate" | "count" | "">("");
  const inFlight = useRef(true);

  function applyConfiguration(view: ProvisioningView) {
    setGroupId(view.groupId || "");
    setQuotaUsd(typeof view.quotaUsd === "number" ? String(view.quotaUsd) : "");
  }

  useEffect(() => {
    const controller = new AbortController();
    void request<SupplyOverview>({ signal: controller.signal }).then((data) => {
      if (controller.signal.aborted) return;
      setOverview(data);
      applyConfiguration(data.provisioning);
      setMessage(`已读取 ${data.users.length} 个注册用户的主备 Key 状态。`);
      if (cooldownUntil <= Date.now()) { setCooldownUntil(0); setCooldownReason(""); }
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setFailed(true);
      setMessage(errorText(error));
    }).finally(() => {
      if (!controller.signal.aborted) { inFlight.current = false; setBusy(""); }
    });
    return () => controller.abort();
  }, []);

  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("load");
    setFailed(false);
    try {
      const data = await request<SupplyOverview>();
      setOverview(data);
      applyConfiguration(data.provisioning);
      setMessage(`已读取 ${data.users.length} 个注册用户的主备 Key 状态。`);
    } catch (error) {
      setFailed(true);
      setMessage(errorText(error));
    } finally {
      inFlight.current = false;
      setBusy("");
    }
  }

  async function saveConfiguration() {
    if (inFlight.current) return;
    if (!groupId.trim() || !quotaUsd.trim() || !Number.isFinite(Number(quotaUsd)) || Number(quotaUsd) < 0) {
      setFailed(true);
      setMessage("请明确填写上游分组和每 Key 额度；额度为 0 表示不另加限额。");
      return;
    }
    inFlight.current = true;
    setBusy("save");
    setFailed(false);
    try {
      const config = { groupId: groupId.trim(), quotaUsd: Number(quotaUsd), ...(email.trim() ? { email: email.trim() } : {}), ...(password ? { password } : {}) };
      const view = await request<ProvisioningView>({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config }) });
      setEmail("");
      setPassword("");
      applyConfiguration(view);
      setOverview((current) => current ? { ...current, provisioning: view } : { provisioning: view, users: [] });
      if (view.retryReset !== "unavailable" && cooldownReason === "count") { setCooldownUntil(0); setCooldownReason(""); }
      setFailed(view.retryReset === "unavailable");
      setMessage(view.retryReset === "unavailable"
        ? "配发账号配置已保存，重试状态暂未恢复，请稍后刷新状态再补齐。"
        : "配发账号配置已保存。可点击补齐主备 Key 开始本批配发。");
    } catch (error) {
      setFailed(true);
      setMessage(errorText(error));
    } finally {
      inFlight.current = false;
      setBusy("");
    }
  }

  async function backfill() {
    if (inFlight.current || !overview?.provisioning.configured || cooldownUntil > Date.now()) return;
    inFlight.current = true;
    setBusy("backfill");
    setFailed(false);
    setMessage("正在补齐本批注册用户的主备 Key...");
    try {
      const result = await request<BatchResult>({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ limit: 10 }) });
      const summary = `本批处理 ${result.processed} 个用户，主备就绪 ${result.ready} 个，失败 ${result.failed} 个，剩余 ${result.remaining} 个待补齐。`;
      const codes = result.errors?.map((entry) => entry.code) || [];
      let delayMessage = "";
      if (codes.includes("supply_provisioning_rate_limited")) {
        setCooldownUntil(Date.now() + 60 * 60 * 1000);
        setCooldownReason("rate");
        delayMessage = "上游配发频率受限，本批已停止，请至少 1 小时后再补齐。";
      } else if (codes.some((code) => ["supply_provisioning_key_count_limit", "supply_provisioning_key_count_exceeded"].includes(code))) {
        setCooldownUntil(Date.now() + 24 * 60 * 60 * 1000);
        setCooldownReason("count");
        delayMessage = "上游 Key 数量已达上限，请调整配发账号配置，或 24 小时后再补齐。";
      }
      setFailed(result.failed > 0 || delayMessage !== "");
      setMessage(summary + delayMessage);
      try {
        setOverview(await request<SupplyOverview>());
      } catch {
        setFailed(true);
        setMessage(`${summary}${delayMessage} 状态刷新失败，请点击刷新。`);
      }
    } catch (error) {
      setFailed(true);
      setMessage(errorText(error));
    } finally {
      inFlight.current = false;
      setBusy("");
    }
  }

  return (
    <section className="modelgw-panel" aria-labelledby="user-supply-heading">
      <div className="modelgw-panel-head compact">
        <div>
          <h2 id="user-supply-heading">注册用户主备 Key</h2>
          <p>每个注册用户分配一个主 Key 和一个备用 Key，凭据保存在服务端。</p>
        </div>
      </div>
      <div className={styles.form}>
        <div className={`${styles.status} ${failed ? styles.error : ""}`} role={failed ? "alert" : "status"} aria-live="polite">{message}</div>
        <div className={styles.fields}>
          <label className={styles.field}>
            <span>配发服务地址</span>
            <input className={styles.input} value="https://sub.shaozhuangai.com" readOnly aria-label="配发服务地址" />
          </label>
          <label className={styles.field}>
            <span>配发账号邮箱</span>
            <input className={styles.input} type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder={overview?.provisioning.emailMasked ? `已保存 ${overview.provisioning.emailMasked}，留空保留` : "填写拥有 Key 配发权限的账号邮箱"} disabled={!!busy} autoComplete="off" aria-label="配发账号邮箱" />
          </label>
          <label className={styles.field}>
            <span>配发账号密码</span>
            <input className={styles.input} type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="留空保留已保存的密码" disabled={!!busy} autoComplete="new-password" aria-label="配发账号密码" />
            <small className={styles.hint}>密码加密保存在服务端，保存成功后清空输入。</small>
          </label>
          <label className={styles.field}>
            <span>上游分组 ID</span>
            <input className={styles.input} value={groupId} onChange={(event) => setGroupId(event.target.value)} disabled={!!busy} placeholder="填写实际分组 ID" aria-label="上游分组 ID" />
          </label>
          <label className={styles.field}>
            <span>每 Key 上游额度（美元）</span>
            <input className={styles.input} type="number" min="0" step="any" value={quotaUsd} onChange={(event) => setQuotaUsd(event.target.value)} disabled={!!busy} placeholder="请明确填写额度，或填 0" aria-label="每 Key 上游额度" />
            <small className={styles.hint}>0 表示不另加限额。模型调用仍受三阶账户积分余额约束。</small>
          </label>
        </div>
        <div className={styles.actions}><button type="button" className="secondary-button" onClick={saveConfiguration} disabled={!!busy}><Save size={15} /> {busy === "save" ? "正在保存..." : "保存配发账号配置"}</button></div>
        <p className={styles.hint}>每次最多补齐 10 个用户，停用账号不配发。已有就绪 Key 原样保留；本批结束后，可再次点击继续补齐。</p>
        {overview && !overview.provisioning.configured ? (
          <div className={styles.status} role="status">Key 发行服务尚未配置{overview.provisioning.missing.length ? `，缺少：${overview.provisioning.missing.join("、")}` : ""}。完成服务端配置后刷新。</div>
        ) : null}
        <div className={styles.actions}>
          <button type="button" className="primary-button" onClick={backfill} disabled={!!busy || !overview?.provisioning.configured || cooldownUntil > Date.now()}>{busy === "backfill" ? "正在补齐..." : "补齐主备 Key"}</button>
          <button type="button" className="secondary-button" onClick={refresh} disabled={!!busy}><RefreshCw size={15} /> {busy === "load" ? "正在刷新..." : "刷新状态"}</button>
        </div>
        {cooldownUntil > Date.now() ? <div className={styles.status} role="status">{cooldownReason === "rate" ? "上游配发频率受限，请至少 1 小时后刷新再补齐。保存配置不会解除频率冷却。" : "上游 Key 数量已达上限，请调整配发账号配置，或 24 小时后刷新再补齐。"}</div> : null}
        {overview ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className={styles.hint}>仅展示配置状态</caption>
              <thead><tr><th scope="col">注册用户</th><th scope="col">账号状态</th><th scope="col">主 Key</th><th scope="col">备用 Key</th></tr></thead>
              <tbody>
                {overview.users.map((user) => (
                  <tr key={user.userId}>
                    <th scope="row">{user.name || user.username}<small className={styles.hint}> · {user.username}</small></th>
                    <td>{user.accountStatus === "active" ? "已启用" : user.accountStatus === "disabled" ? "已停用" : "状态待确认"}</td>
                    <td>{slotText(user.primary)}</td>
                    <td>{slotText(user.backup)}</td>
                  </tr>
                ))}
                {overview.users.length === 0 ? <tr><td colSpan={4} className={styles.empty}>暂无注册用户。</td></tr> : null}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </section>
  );
}
