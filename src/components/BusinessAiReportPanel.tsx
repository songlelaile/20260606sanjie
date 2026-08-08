"use client";

import { AlertTriangle, Bot, CheckCircle2, Loader2, Play, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { AiApiConfigPanel } from "@/components/AiApiConfigPanel";
import { getAiProviderLabel } from "@/lib/ai-provider-catalog";
import type { BusinessAiDiagnosisReport } from "@/lib/business-diagnosis";
import type { AiApiConfigPublic } from "@/lib/types/domain";

interface GeneratedAiReport {
  title: string;
  content: string;
  generatedAt: string;
  provider: AiApiConfigPublic["provider"];
  model: string;
  filteredLineCount?: number;
}

export function BusinessAiReportPanel({
  initialReport,
  initialConfig
}: {
  initialReport: BusinessAiDiagnosisReport;
  initialConfig: AiApiConfigPublic;
}) {
  const [config, setConfig] = useState(initialConfig);
  const [report, setReport] = useState<GeneratedAiReport | null>(null);
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
      const response = await fetch("/api/business-diagnosis/ai-report", {
        method: "POST",
        headers: { "content-type": "application/json" }
      });
      const payload = (await response.json().catch(() => null)) as
        | { data?: { report?: GeneratedAiReport }; error?: string }
        | null;
      if (response.ok && payload?.data?.report) {
        setReport(payload.data.report);
        setMessage("AI 诊断草案已生成并完成越界过滤，请人工审核后再采用");
      } else {
        setMessage(payload?.error ?? "AI 诊断生成失败");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "网络异常，AI 诊断生成失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="business-panel business-ai-report-panel">
      <div className="panel-toolbar business-ai-report-toolbar">
        <div>
          <strong>
            <Sparkles size={16} /> AI 诊断草案
          </strong>
          <span>必要经营摘要会发送给模型服务；AI 内容经越界过滤后仍需人工审核。</span>
        </div>
        <button
          type="button"
          className="management-primary-button business-ai-start-button"
          disabled={busy || !canStart}
          onClick={startDiagnosis}
        >
          {busy ? <Loader2 size={16} /> : <Play size={16} />}
          {busy ? "诊断中" : report ? "重新诊断" : "开始诊断"}
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
      ) : null}

      <div className="business-ai-report">
        <h3>{initialReport.title}</h3>
        <p>{initialReport.summary}</p>
        {initialReport.sections.map((section) => (
          <article key={section.title}>
            <strong>{section.title}</strong>
            <span>{section.finding}</span>
            <p>{section.recommendation}</p>
            <div className="strategy-evidence">
              {section.evidence.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          </article>
        ))}
        <details>
          <summary>报告生成 Prompt</summary>
          <pre>{initialReport.prompt}</pre>
        </details>
      </div>
    </section>
  );
}
