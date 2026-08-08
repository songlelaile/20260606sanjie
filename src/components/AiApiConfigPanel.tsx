"use client";

import {
  Bot,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Save,
  ShieldCheck,
  Sparkles,
  X
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  AI_PROVIDER_CATALOG,
  DEFAULT_AI_PROVIDER,
  getAiProviderLabel,
  getAiProviderPreset
} from "@/lib/ai-provider-catalog";
import type { AiApiConfigPublic, AiProvider } from "@/lib/types/domain";

type Variant = "inline" | "page";

interface AiApiConfigForm {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  enabled: boolean;
  apiKey: string;
  clearApiKey: boolean;
}

const DEFAULT_PRESET = getAiProviderPreset(DEFAULT_AI_PROVIDER);
const DEFAULT_CONFIG: AiApiConfigPublic = {
  provider: DEFAULT_AI_PROVIDER,
  baseUrl: DEFAULT_PRESET.baseUrl,
  model: DEFAULT_PRESET.model,
  enabled: false,
  hasApiKey: false,
  apiKeyHint: "",
  updatedAt: "",
  updatedBy: ""
};

export function AiApiConfigPanel({
  variant = "page",
  onConfigChange
}: {
  variant?: Variant;
  onConfigChange?: (config: AiApiConfigPublic) => void;
}) {
  const [config, setConfig] = useState<AiApiConfigPublic>(DEFAULT_CONFIG);
  const [form, setForm] = useState<AiApiConfigForm>(() => formFromConfig(DEFAULT_CONFIG));
  const [open, setOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"success" | "error">("success");
  const canReuseSavedKey =
    config.hasApiKey &&
    form.provider === config.provider &&
    normalizeEndpoint(form.baseUrl) === normalizeEndpoint(config.baseUrl);

  const statusText = config.enabled
    ? config.hasApiKey
      ? `已启用 · ${getAiProviderLabel(config.provider)} · ${config.model}`
      : "已启用，等待填写 Key"
    : config.hasApiKey
      ? "已保存 Key，未启用"
      : "未接入";

  const loadConfig = useCallback(async () => {
    const response = await fetch("/api/ai-api-config", { cache: "no-store" });
    const payload = (await response.json().catch(() => null)) as
      | { data?: { config?: AiApiConfigPublic }; error?: string }
      | null;
    const next = payload?.data?.config ?? DEFAULT_CONFIG;
    setConfig(next);
    onConfigChange?.(next);
    return next;
  }, [onConfigChange]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig, variant]);

  async function openModal() {
    setBusy(true);
    setMessage("");
    const next = await loadConfig().catch(() => config);
    setForm(formFromConfig(next));
    setShowKey(false);
    setOpen(true);
    setBusy(false);
  }

  function changeProvider(provider: AiProvider) {
    const meta = getAiProviderPreset(provider);
    setForm((current) => ({
      ...current,
      provider,
      baseUrl: meta.baseUrl,
      model: meta.model,
      apiKey: "",
      clearApiKey: false
    }));
  }

  async function persistConfig(closeOnSuccess: boolean) {
    const response = await fetch("/api/ai-api-config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form)
    });
    const payload = (await response.json().catch(() => null)) as
      | { data?: { config?: AiApiConfigPublic }; error?: string }
      | null;
    if (response.ok && payload?.data?.config) {
      setConfig(payload.data.config);
      onConfigChange?.(payload.data.config);
      setForm(formFromConfig(payload.data.config));
      if (closeOnSuccess) setOpen(false);
      return payload.data.config;
    } else {
      setMessageTone("error");
      setMessage(payload?.error ?? "AI API 配置保存失败");
      return null;
    }
  }

  async function saveConfig() {
    setBusy(true);
    setMessage("");
    try {
      const saved = await persistConfig(true);
      if (saved) {
        setMessageTone("success");
        setMessage("AI API 配置已按当前店铺加密保存");
      }
    } catch (error) {
      setMessageTone("error");
      setMessage(error instanceof Error ? error.message : "AI API 配置保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function saveAndTestConnection() {
    setBusy(true);
    setMessage("");
    try {
      const saved = await persistConfig(false);
      if (!saved) return;
      const response = await fetch("/api/ai-api-config/test", {
        method: "POST",
        headers: { "content-type": "application/json" }
      });
      const payload = (await response.json().catch(() => null)) as
        | { data?: { ok?: boolean; provider?: AiProvider; model?: string }; error?: string }
        | null;
      if (response.ok && payload?.data?.ok) {
        setMessageTone("success");
        setMessage(`连接成功 · ${getAiProviderLabel(saved.provider)} · ${payload.data.model ?? saved.model}`);
      } else {
        setMessageTone("error");
        setMessage(payload?.error ?? "AI API 连接测试失败");
      }
    } catch (error) {
      setMessageTone("error");
      setMessage(error instanceof Error ? error.message : "AI API 连接测试失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {variant === "inline" ? (
        <div className="ai-api-inline">
          <button type="button" className="outline-button ai-api-inline-button" onClick={openModal} disabled={busy}>
            {busy ? <Loader2 size={15} /> : <KeyRound size={15} />}
            接入 AI API
          </button>
          <span>{statusText}</span>
        </div>
      ) : (
        <section className="ai-api-config-panel panel-shell">
          <div className="ai-api-config-head">
            <div>
              <span className="management-section-label">AI API</span>
              <h2>AI API Key 接入</h2>
              <p>用于业务诊断报告、策略卡片、问卷解读和复盘建议。Key 加密保存在当前店铺工作区，页面不会回显明文。</p>
            </div>
            <button type="button" className="management-primary-button" onClick={openModal} disabled={busy}>
              {busy ? <Loader2 size={15} /> : <KeyRound size={15} />}
              配置 API Key
            </button>
          </div>
          <div className="ai-api-status-grid">
            <article>
              <span>接入状态</span>
              <strong>{statusText}</strong>
            </article>
            <article>
              <span>服务商</span>
              <strong>{getAiProviderLabel(config.provider)}</strong>
            </article>
            <article>
              <span>模型</span>
              <strong>{config.model || "未设置"}</strong>
            </article>
            <article>
              <span>Key</span>
              <strong>{config.hasApiKey ? config.apiKeyHint || "已保存" : "未保存"}</strong>
            </article>
          </div>
          <div className="ai-api-flow">
            <span>
              <ShieldCheck size={15} />
              源数据仍留在本平台，只有用户主动触发 AI 诊断时才会按最小必要摘要发送给你配置的模型服务。
            </span>
            <span>
              <Sparkles size={15} />
              业务诊断与经营网络共用这一套服务端调用配置；连接测试只发送固定探针，不发送经营数据。
            </span>
          </div>
          {message ? <p className="management-message">{message}</p> : null}
        </section>
      )}

      {open ? (
        <div className="ai-api-modal-backdrop" role="presentation" onClick={() => setOpen(false)}>
          <section
            className="ai-api-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-api-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="ai-api-modal-head">
              <div className="ai-api-modal-title">
                <span>
                  <Bot size={18} />
                </span>
                <div>
                  <strong id="ai-api-modal-title">接入 AI API Key</strong>
                  <p>选择服务商、模型和 Key。预设会自动填入 Base URL；保存后不展示明文 Key。</p>
                </div>
              </div>
              <button type="button" className="ai-api-modal-close" onClick={() => setOpen(false)} aria-label="关闭">
                <X size={18} />
              </button>
            </header>

            <div className="ai-api-provider-grid" role="radiogroup" aria-label="AI 服务商">
              {AI_PROVIDER_CATALOG.map((meta) => (
                <button
                  type="button"
                  key={meta.id}
                  className={form.provider === meta.id ? "active" : ""}
                  onClick={() => changeProvider(meta.id)}
                >
                  <strong>{meta.label}</strong>
                  <span>{meta.description}</span>
                </button>
              ))}
            </div>

            <div className="ai-api-modal-grid">
              <label>
                Base URL
                <input
                  value={form.baseUrl}
                  onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
                  placeholder={getAiProviderPreset(form.provider).baseUrl || "https://your-gateway.example/v1"}
                />
              </label>
              <label>
                模型名称
                <input
                  value={form.model}
                  onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}
                  placeholder={getAiProviderPreset(form.provider).model || "your-model-name"}
                />
              </label>
            </div>

            <label className="ai-api-key-field">
              API Key
              <div>
                <input
                  type={showKey ? "text" : "password"}
                  value={form.apiKey}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, apiKey: event.target.value, clearApiKey: false }))
                  }
                  placeholder={canReuseSavedKey ? "留空则继续使用已保存 Key" : "粘贴当前服务商的 API Key"}
                  autoComplete="off"
                />
                <button type="button" onClick={() => setShowKey((current) => !current)} aria-label={showKey ? "隐藏 Key" : "显示 Key"}>
                  {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {canReuseSavedKey ? (
                <small>当前店铺已有加密 Key；留空继续使用，输入新 Key 会覆盖。</small>
              ) : config.hasApiKey ? (
                <small>服务商或 Base URL 已变化；为防止旧 Key 发往新地址，请重新填写对应 Key。</small>
              ) : null}
            </label>

            <div className="ai-api-modal-switches">
              <label>
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
                />
                启用业务诊断 AI 输出
              </label>
              {config.hasApiKey ? (
                <label className="danger">
                  <input
                    type="checkbox"
                    checked={form.clearApiKey}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        clearApiKey: event.target.checked,
                        apiKey: event.target.checked ? "" : current.apiKey
                      }))
                    }
                  />
                  清除已保存 Key
                </label>
              ) : null}
            </div>

            <div className="ai-api-security-note">
              <ShieldCheck size={16} />
              <span>Key 使用 AES-GCM 加密保存；配置页只显示尾号。不要把共享账号的 Key 填到不可信环境。</span>
            </div>

            {message ? <p className={`ai-api-modal-message ${messageTone}`}>{message}</p> : null}

            <footer className="ai-api-modal-footer">
              <button type="button" className="ghost-button" onClick={() => setOpen(false)} disabled={busy}>
                取消
              </button>
              <button type="button" className="outline-button" onClick={saveAndTestConnection} disabled={busy}>
                {busy ? <Loader2 size={16} /> : <CheckCircle2 size={16} />}
                保存并测试
              </button>
              <button type="button" className="button-link" onClick={saveConfig} disabled={busy}>
                {busy ? <Loader2 size={16} /> : <Save size={16} />}
                保存配置
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}

function formFromConfig(config: AiApiConfigPublic): AiApiConfigForm {
  const preset = getAiProviderPreset(config.provider);
  return {
    provider: config.provider,
    baseUrl: config.baseUrl || preset.baseUrl,
    model: config.model || preset.model,
    enabled: config.enabled,
    apiKey: "",
    clearApiKey: false
  };
}

function normalizeEndpoint(value: string) {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}
