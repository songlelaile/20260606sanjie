"use client";

import { Plus, RefreshCw, Save, Server, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { RelayModel, RelaySettingsView, RelayShopKeyView } from "@/lib/model-gateway/relay-config";
import { prepareRelaySettingsUpdate, type RelayShopKeyDraft } from "./relay-form";
import styles from "./RelaySettingsPanel.module.css";

type ConnectionResult = { ok: boolean; modelCount: number; latencyMs: number; message: string };
type RelayAction = "load" | "save" | "test" | "sync" | "";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...options });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof json?.error === "string" ? json.error : `操作失败（HTTP ${response.status}），请重试。`);
  if (!json?.data) throw new Error("服务器返回了无法识别的数据，请重试。");
  return json.data as T;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "网络连接失败，请重试。";
}

export function RelaySettingsPanel({ onCatalogChange }: { onCatalogChange: () => Promise<void> }) {
  const [settings, setSettings] = useState<RelaySettingsView | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [models, setModels] = useState<RelayModel[]>([]);
  const [shopDrafts, setShopDrafts] = useState<RelayShopKeyDraft[]>([]);
  const [usdRate, setUsdRate] = useState("");
  const [busy, setBusy] = useState<RelayAction>("load");
  const [message, setMessage] = useState("正在读取中转站配置...");
  const [failed, setFailed] = useState(false);

  function applySettings(view: RelaySettingsView) {
    setSettings(view);
    setBaseUrl(view.baseUrl);
    setModels(view.models);
    setShopDrafts((view.shopKeys || []).map((item: RelayShopKeyView) => ({ shopName: item.shopName, purpose: item.purpose, apiKey: "", clear: false })));
    setUsdRate(view.usdCnyRate == null ? "" : String(view.usdCnyRate));
    setApiKey("");
    setClearKey(false);
  }

  useEffect(() => {
    const controller = new AbortController();
    request<RelaySettingsView>("/api/model-gateway/relay", { signal: controller.signal })
      .then((view) => {
        if (controller.signal.aborted) return;
        applySettings(view);
        setMessage("配置已读取。修改后先保存，再测试连接或同步上游模型。");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setMessage(errorText(error));
        setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy("");
      });
    return () => controller.abort();
  }, []);

  const dirty = useMemo(() => !!settings && (
    baseUrl !== settings.baseUrl || !!apiKey.trim() || clearKey || JSON.stringify(models) !== JSON.stringify(settings.models) ||
    usdRate !== (settings.usdCnyRate == null ? "" : String(settings.usdCnyRate)) ||
    shopDrafts.some((item) => item.clear || !!item.apiKey.trim()) ||
    JSON.stringify(shopDrafts.map((item) => ({ shopName: item.shopName, purpose: item.purpose }))) !== JSON.stringify(settings.shopKeys || [])
  ), [settings, baseUrl, apiKey, clearKey, models, usdRate, shopDrafts]);

  function updateModel(index: number, patch: Partial<RelayModel>) {
    setModels((current) => current.map((model, row) => row === index ? {
      ...model,
      ...patch,
      ...(patch.kind === "unknown" ? { enabled: false } : {})
    } : model));
  }

  async function load() {
    setBusy("load");
    setFailed(false);
    try {
      applySettings(await request<RelaySettingsView>("/api/model-gateway/relay"));
      setMessage("配置已重新读取。");
    } catch (error) {
      setFailed(true);
      setMessage(errorText(error));
    } finally {
      setBusy("");
    }
  }

  async function save() {
    const prepared = prepareRelaySettingsUpdate({ baseUrl, apiKey, clearKey, models, usdCnyRate: usdRate, shopKeys: shopDrafts });
    if (prepared.error) {
      setFailed(true);
      setMessage(prepared.error);
      return;
    }
    setBusy("save");
    setFailed(false);
    setMessage("正在保存中转站配置...");
    try {
      const view = await request<RelaySettingsView>("/api/model-gateway/relay", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prepared.input)
      });
      applySettings(view);
      setMessage("中转站配置已保存；输入的 API Key 已从表单清空。");
      try { await onCatalogChange(); } catch (error) {
        setFailed(true);
        setMessage(`配置已保存，页面目录刷新失败：${errorText(error)}`);
      }
    } catch (error) {
      setFailed(true);
      setMessage(errorText(error));
    } finally {
      setBusy("");
    }
  }

  async function testConnection() {
    setBusy("test");
    setFailed(false);
    setMessage("正在读取已保存中转站的模型目录以验证连接...");
    try {
      const result = await request<ConnectionResult>("/api/model-gateway/relay/test", { method: "POST" });
      setFailed(!result.ok);
      setMessage(`${result.message} · ${result.modelCount} 个上游模型 · ${result.latencyMs} ms。连接测试只读取目录，不生成图片或视频。`);
    } catch (error) {
      setFailed(true);
      setMessage(errorText(error));
    } finally {
      setBusy("");
    }
  }

  async function syncModels() {
    setBusy("sync");
    setFailed(false);
    setMessage("正在同步已保存中转站的模型目录...");
    try {
      const view = await request<RelaySettingsView & { syncedCount?: number }>("/api/model-gateway/relay/sync", { method: "POST" });
      applySettings(view);
      setMessage(`模型目录已同步${view.syncedCount === undefined ? "" : `，上游返回 ${view.syncedCount} 个模型`}。新发现的模型保持停用，请确认类型和费率后启用并保存。`);
      try { await onCatalogChange(); } catch (error) {
        setFailed(true);
        setMessage(`模型已同步，页面目录刷新失败：${errorText(error)}`);
      }
    } catch (error) {
      setFailed(true);
      setMessage(errorText(error));
    } finally {
      setBusy("");
    }
  }

  function rateInput(model: RelayModel, index: number, field: "promptCentsPer1K" | "completionCentsPer1K" | "imageCents" | "videoCents", label: string) {
    return (
      <label className={styles.rateField}>
        <span>{label}</span>
        <input
          className={styles.input}
          type="number"
          min={field === "videoCents" || field === "imageCents" ? "1" : "0"}
          step={field === "videoCents" || field === "imageCents" ? "1" : "any"}
          value={model[field] ?? ""}
          aria-label={`第 ${index + 1} 行 ${label}`}
          onChange={(event) => updateModel(index, { [field]: event.target.value === "" ? undefined : Number(event.target.value) })}
          disabled={!!busy}
        />
      </label>
    );
  }

  return (
    <section className="modelgw-panel" aria-labelledby="relay-settings-heading">
      <div className="modelgw-panel-head compact">
        <div>
          <h2 id="relay-settings-heading">中转站管理</h2>
          <p>设置平台上游地址、凭据和模型路由。仅管理员可管理，保存的凭据只在服务端使用。</p>
        </div>
      </div>
      <div className={styles.form}>
        <div className={`${styles.status} ${failed ? styles.error : ""}`} role={failed ? "alert" : "status"} aria-live="polite">{message}</div>
        {settings ? (
          <>
            <div className={styles.fields}>
              <label className={styles.field}>
                <span>中转站 Base URL</span>
                <input className={styles.input} type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://sub.shaozhuangai.com/v1" disabled={!!busy} autoComplete="off" />
                <small className={styles.hint}>填写兼容 API 的根地址，包含需要的 /v1 路径。</small>
              </label>
              <div className={styles.field}>
                <label className={styles.field}>
                  <span>上游 API Key</span>
                  <input className={styles.input} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settings.keyConfigured ? "已配置，留空保留当前 Key" : "尚未配置，请输入上游 Key"} disabled={!!busy || clearKey} autoComplete="new-password" spellCheck={false} />
                  <small className={styles.hint}>状态：{settings.keyConfigured ? "已配置" : "未配置"} · 来源：{settings.keySource === "file" ? "服务端配置" : settings.keySource === "env" ? "环境变量" : "无"}。留空保留；成功保存后清空输入。</small>
                </label>
                <label className={styles.checkbox}>
                  <input type="checkbox" checked={clearKey} onChange={(event) => { setClearKey(event.target.checked); if (event.target.checked) setApiKey(""); }} disabled={!!busy} />
                  清除当前 Key，同时停用环境变量 Key 回退
                </label>
              </div>
            </div>
            <div className={styles.fields}>
              <label className={styles.field}>
                <span>美元结算汇率</span>
                <input className={styles.input} inputMode="decimal" value={usdRate} onChange={(event) => setUsdRate(event.target.value)} placeholder="例如 7.2" disabled={!!busy} />
                <small className={styles.hint}>1 美元换算的人民币。中转站返回 actual_cost 时，网站积分按这笔美元费用乘汇率，再乘套餐倍率。没有这笔费用时仍按模型目录费率。留空表示不启用美元换算。网站余额不会充进中转站。</small>
              </label>
            </div>
            <div>
              <p className={styles.hint}>所有租户的模型调用都使用上方平台 Key，对应中转站的供应订阅。店铺 Key 不参与调用。Key 只保存在服务端，页面不回显。</p>
              {shopDrafts.length ? shopDrafts.map((item, index) => (
                <div className={styles.fields} key={`${item.purpose}-${index}`}>
                  <label className={styles.field}>
                    <span>店铺名</span>
                    <input className={styles.input} value={item.shopName} aria-label={`第 ${index + 1} 个店铺名`} onChange={(event) => setShopDrafts((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, shopName: event.target.value } : row))} disabled={!!busy || item.clear} />
                  </label>
                  <label className={styles.field}>
                    <span>用途</span>
                    <select className={styles.select} value={item.purpose} aria-label={`第 ${index + 1} 个店铺用途`} onChange={(event) => setShopDrafts((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, purpose: event.target.value as RelayShopKeyDraft["purpose"] } : row))} disabled={!!busy || item.clear}>
                      <option value="default">默认</option>
                      <option value="image">仅生图</option>
                    </select>
                  </label>
                  <label className={styles.field}>
                    <span>中转站 Key</span>
                    <input className={styles.input} type="password" value={item.apiKey} aria-label={`第 ${index + 1} 个店铺 Key`} placeholder="已配置，留空保留" onChange={(event) => setShopDrafts((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, apiKey: event.target.value } : row))} disabled={!!busy || item.clear} autoComplete="new-password" spellCheck={false} />
                  </label>
                  <label className={styles.checkbox}>
                    <input type="checkbox" checked={item.clear} onChange={(event) => setShopDrafts((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, clear: event.target.checked, apiKey: event.target.checked ? "" : row.apiKey } : row))} disabled={!!busy} />
                    移除这个店铺 Key
                  </label>
                </div>
              )) : <div className={styles.empty}>尚未按店铺保存 Key。</div>}
              <button type="button" onClick={() => setShopDrafts((current) => [...current, { shopName: "", purpose: "default", apiKey: "", clear: false }])} disabled={!!busy}><Plus size={15} />添加店铺 Key</button>
            </div>
            <div>
              <p className={styles.hint}>调用模型名由本网关客户端使用；上游模型名需与中转站目录一致。同步条目不自动推测类型或开通。费率单位为分；图片、视频填写整数分。视频在上游成功接受任务时计费，任务随后失败暂不自动退款；变更上游 Key 可能影响已有视频任务的查询或下载。</p>
              <div className={styles.tableWrap}>
                {models.length ? (
                  <table className={styles.table}>
                    <thead><tr><th>调用模型名</th><th>上游模型名</th><th>显示名称</th><th>类型</th><th>费率（分）</th><th>启用</th><th>操作</th></tr></thead>
                    <tbody>{models.map((model, index) => (
                      <tr key={index}>
                        <td className={styles.modelName}><input className={styles.input} value={model.id} aria-label={`第 ${index + 1} 行调用模型名`} onChange={(event) => updateModel(index, { id: event.target.value })} disabled={!!busy} /></td>
                        <td className={styles.modelName}><input className={styles.input} value={model.upstreamModel} aria-label={`第 ${index + 1} 行上游模型名`} onChange={(event) => updateModel(index, { upstreamModel: event.target.value })} disabled={!!busy} /></td>
                        <td className={styles.modelName}><input className={styles.input} value={model.label} aria-label={`第 ${index + 1} 行显示名称`} onChange={(event) => updateModel(index, { label: event.target.value })} disabled={!!busy} /></td>
                        <td className={styles.type}><select className={styles.select} value={model.kind} aria-label={`第 ${index + 1} 行模型类型`} onChange={(event) => updateModel(index, { kind: event.target.value as RelayModel["kind"] })} disabled={!!busy}><option value="unknown">待分类</option><option value="chat">聊天</option><option value="image">图片</option><option value="video">视频</option></select></td>
                        <td><div className={styles.rates}>{model.kind === "chat" ? <>{rateInput(model, index, "promptCentsPer1K", "输入 / 千 Token")}{rateInput(model, index, "completionCentsPer1K", "输出 / 千 Token")}</> : model.kind === "image" ? rateInput(model, index, "imageCents", "每张图片") : model.kind === "video" ? rateInput(model, index, "videoCents", "每次视频任务") : <span className={styles.hint}>选择类型后填写</span>}</div></td>
                        <td><label className={styles.checkbox}><input type="checkbox" checked={model.enabled} aria-label={`第 ${index + 1} 行启用`} onChange={(event) => updateModel(index, { enabled: event.target.checked })} disabled={!!busy || model.kind === "unknown"} />{model.enabled ? "启用" : "停用"}</label></td>
                        <td><button type="button" onClick={() => setModels((current) => current.filter((_, row) => row !== index))} disabled={!!busy} aria-label={`移除第 ${index + 1} 行模型`}><Trash2 size={14} />移除</button></td>
                      </tr>
                    ))}</tbody>
                  </table>
                ) : <div className={styles.empty}>尚无中转站模型，可同步目录或手动添加。</div>}
              </div>
            </div>
            <div className={styles.actions}>
              <button type="button" onClick={() => setModels((current) => [...current, { id: "", upstreamModel: "", label: "", kind: "unknown", enabled: false }])} disabled={!!busy}><Plus size={15} />添加模型</button>
              <button type="button" onClick={save} disabled={!!busy || !dirty}><Save size={15} />{busy === "save" ? "保存中..." : "保存配置"}</button>
              <button type="button" onClick={testConnection} disabled={!!busy || dirty}><Server size={15} />{busy === "test" ? "测试中..." : "测试已保存连接"}</button>
              <button type="button" onClick={syncModels} disabled={!!busy || dirty}><RefreshCw size={15} />{busy === "sync" ? "同步中..." : "同步上游模型"}</button>
            </div>
            <small className={styles.hint}>{dirty ? "有未保存修改；保存后可测试和同步。" : `上次保存：${settings.updatedAt ? new Date(settings.updatedAt).toLocaleString("zh-CN", { hour12: false }) : "尚未保存，使用默认或环境变量配置"}。`}</small>
          </>
        ) : <button type="button" onClick={load} disabled={!!busy}><RefreshCw size={15} />{busy ? "读取中..." : "重新读取配置"}</button>}
      </div>
    </section>
  );
}
