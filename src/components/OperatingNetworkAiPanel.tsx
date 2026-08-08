"use client";

import { AlertTriangle, Bot, CheckCircle2, Loader2, Play, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { AiApiConfigPanel } from "@/components/AiApiConfigPanel";
import { getAiProviderLabel } from "@/lib/ai-provider-catalog";
import type { AiApiConfigPublic } from "@/lib/types/domain";

interface GeneratedNetworkReport {
  title: string;
  content: string;
  generatedAt: string;
  provider: AiApiConfigPublic["provider"];
  model: string;
  filteredLineCount?: number;
}

export function OperatingNetworkAiPanel({ initialConfig }: { initialConfig: AiApiConfigPublic }) {
  const [config, setConfig] = useState(initialConfig);
  const [report, setReport] = useState<GeneratedNetworkReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const canStart = config.enabled && config.hasApiKey && Boolean(config.baseUrl) && Boolean(config.model);
  const status = useMemo(() => {
    if (canStart) return `${getAiProviderLabel(config.provider)} · ${config.model}`;
    if (config.hasApiKey) return "Key 已保存，待启用";
    return "未接入 API";
  }, [canStart, config]);

  async function startDiagnosis() {
    setBusy(true);
    setMessage("");
    setReport(null);
    try {
      const response = await fetch("/api/operating-network/ai-report", {
        method: "POST",
        headers: { "content-type": "application/json" }
      });
      const payload = (await response.json().catch(() => null)) as
        | { data?: { report?: GeneratedNetworkReport }; error?: string }
        | null;
      if (response.ok && payload?.data?.report) {
        setReport(payload.data.report);
        setMessage("AI 草案已生成并完成越界过滤，请人工审核后再采用");
      } else {
        setMessage(payload?.error ?? "AI 深度方案生成失败");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "网络异常，AI 深度方案生成失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="business-panel business-ai-report-panel operating-network-ai-panel">
      <div className="panel-toolbar business-ai-report-toolbar">
        <div>
          <strong>
            <Sparkles size={16} /> AI 深度共创
          </strong>
          <span>确定性引擎提供证据边界；AI 内容会经过越界过滤，但仍是需人工审核的草案。</span>
        </div>
        <button
          type="button"
          className="management-primary-button business-ai-start-button"
          disabled={busy || !canStart}
          onClick={startDiagnosis}
        >
          {busy ? <Loader2 size={16} /> : <Play size={16} />}
          {busy ? "诊断中" : report ? "重新共创" : "生成深度方案"}
        </button>
      </div>

      <div className="business-ai-runbar">
        <div className={canStart ? "business-ai-run-status ready" : "business-ai-run-status"}>
          {canStart ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
          <span>{status}</span>
        </div>
        <AiApiConfigPanel variant="inline" onConfigChange={setConfig} />
      </div>

      {message ? (
        <p className={report ? "business-ai-message success" : "business-ai-message"}>
          {report ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
          {message}
        </p>
      ) : null}

      {report ? (
        <div className="business-ai-generated-report">
          <header>
            <div>
              <strong>{report.title}</strong>
              <span>
                {getAiProviderLabel(report.provider)} · {report.model} · {new Date(report.generatedAt).toLocaleString("zh-CN")}
                {report.filteredLineCount ? ` · 已过滤 ${report.filteredLineCount} 行越界表述` : " · 未发现越界行"}
              </span>
            </div>
            <Bot size={18} />
          </header>
          <pre>{report.content}</pre>
        </div>
      ) : (
        <p className="operating-network-ai-note">
          不配置 AI 也不影响上方确定性诊断；AI 草案用于辅助共创，不直接构成预算审批、出价或执行指令。
        </p>
      )}
    </section>
  );
}
