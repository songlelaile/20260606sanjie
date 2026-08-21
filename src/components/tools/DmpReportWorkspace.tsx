"use client";

import {
  FileSpreadsheet,
  RefreshCw,
  Share2,
  Trash2
} from "lucide-react";
import { useMemo, useState } from "react";
import type { DmpBusinessReportRecord } from "@/lib/dmp-report-types";
import { DmpGrowthReportViewer } from "@/components/tools/DmpGrowthReportViewer";

function createdAtLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(date);
}

function isCompetitionReport(record: DmpBusinessReportRecord | null) {
  return record?.reportType === "competition" || record?.report.report_type === "competition";
}

function reportTypeLabel(record: DmpBusinessReportRecord) {
  return isCompetitionReport(record) ? "竞争态势" : "打爆路径";
}

function objectLabels(record: DmpBusinessReportRecord) {
  return isCompetitionReport(record)
    ? { subject: "本店", competitor: "竞店" }
    : { subject: "主体商品", competitor: "成功品" };
}

export function DmpReportWorkspace({
  initialReports,
  initialSelectedId = "",
  focusReport = false
}: {
  initialReports: DmpBusinessReportRecord[];
  initialSelectedId?: string;
  focusReport?: boolean;
}) {
  const initialId = initialReports.some((record) => record.id === initialSelectedId)
    ? initialSelectedId
    : initialReports[0]?.id ?? "";
  const [reports, setReports] = useState(initialReports);
  const [selectedId, setSelectedId] = useState(initialId);
  const [busy, setBusy] = useState(false);
  const [sharingId, setSharingId] = useState("");
  const [notice, setNotice] = useState(
    initialReports.length ? `已保存 ${initialReports.length} 份历史报告` : "插件生成报告后会自动保存到这里"
  );

  const selectedRecord = useMemo(
    () => reports.find((record) => record.id === selectedId) ?? reports[0] ?? null,
    [reports, selectedId]
  );

  function selectReport(record: DmpBusinessReportRecord) {
    setSelectedId(record.id);
  }

  async function createShare(record: DmpBusinessReportRecord) {
    setSharingId(record.id);
    try {
      const response = await fetch("/api/dmp-report-shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId: record.id })
      });
      const result = await response.json().catch(() => null) as { data?: { share?: { url?: string } }; error?: string } | null;
      if (!response.ok || !result?.data?.share?.url) throw new Error(result?.error ?? "分享链接生成失败");
      await copyText(result.data.share.url);
      setNotice("公开只读报告链接已复制；任何拿到链接的人均可直接打开");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "分享链接生成失败");
    } finally {
      setSharingId("");
    }
  }

  async function refreshReports() {
    setBusy(true);
    try {
      const response = await fetch("/api/dmp-reports", { cache: "no-store" });
      const result = await response.json().catch(() => null) as { data?: { reports?: DmpBusinessReportRecord[] }; error?: string } | null;
      if (!response.ok) throw new Error(result?.error ?? "刷新失败");
      const nextReports = result?.data?.reports ?? [];
      setReports(nextReports);
      setSelectedId((current) => nextReports.some((record) => record.id === current) ? current : nextReports[0]?.id ?? "");
      setNotice(nextReports.length ? `已同步 ${nextReports.length} 份历史报告` : "暂时没有历史报告");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "刷新失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  async function deleteReport(record: DmpBusinessReportRecord) {
    const labels = objectLabels(record);
    if (!window.confirm(`确认删除${labels.subject} ${record.subjectItemId} 的这份报告？`)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/dmp-reports?id=${encodeURIComponent(record.id)}`, { method: "DELETE" });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error ?? "删除失败");
      const nextReports = reports.filter((candidate) => candidate.id !== record.id);
      setReports(nextReports);
      if (selectedId === record.id) setSelectedId(nextReports[0]?.id ?? "");
      setNotice("报告已删除");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`dmp-workspace${focusReport ? " dmp-focus-report" : ""}`}>
      <div className="dmp-workspace-topbar">
        <div className="dmp-report-path">
          <span>使用路径</span>
          <strong>达摩盘 → 打爆路径 / 竞争态势分析</strong>
        </div>
        <div className="dmp-workspace-actions">
          <button type="button" onClick={() => void refreshReports()} disabled={busy}>
            <RefreshCw className={busy ? "spin" : ""} size={15} /> 刷新历史
          </button>
          {focusReport ? <a href="/tools/dmp-report">浏览全部报告</a> : null}
          {selectedRecord ? (
            <button className="dmp-action-primary" type="button" onClick={() => void createShare(selectedRecord)} disabled={Boolean(sharingId)}>
              <Share2 size={15} /> {sharingId === selectedRecord.id ? "生成中…" : "复制分享链接"}
            </button>
          ) : null}
        </div>
      </div>

      <div className="dmp-business-strip">
        <div><strong>双报告归档</strong><span>统一保存打爆路径与竞争态势分析结果。</span></div>
        <div><strong>公开只读分享</strong><span>任何拿到链接的人无需登录即可在官网查看。</span></div>
        <div><strong>管理员传播分析</strong><span>传播来源、阅读深度与关注度仅在管理员后台查看。</span></div>
      </div>

      <section className="dmp-history-section">
        <header>
          <div>
            <span>REPORT HISTORY</span>
            <h2>历史生成报告</h2>
            <p>{notice} · 点击报告卡片切换在线预览</p>
          </div>
          <strong>{reports.length} 份</strong>
        </header>
        {reports.length ? (
          <div className="dmp-history-grid">
            {reports.map((record) => (
              <article className={`dmp-history-card${selectedRecord?.id === record.id ? " active" : ""}`} key={record.id}>
                <button className="dmp-history-main" type="button" onClick={() => selectReport(record)} aria-pressed={selectedRecord?.id === record.id}>
                  <span>{reportTypeLabel(record)} · {createdAtLabel(record.createdAt)}</span>
                  <strong>{objectLabels(record).subject} {record.subjectItemId}</strong>
                  <small>{objectLabels(record).competitor} {record.competitorItemId.replaceAll(",", "、")} · {record.period}</small>
                </button>
                <div className="dmp-history-actions">
                  <button type="button" onClick={() => void createShare(record)} disabled={Boolean(sharingId)}>
                    <Share2 size={14} /> {sharingId === record.id ? "生成中" : "分享"}
                  </button>
                  <button className="danger" type="button" onClick={() => void deleteReport(record)} disabled={busy} aria-label="删除报告"><Trash2 size={14} /></button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="dmp-history-empty">
            <FileSpreadsheet size={36} />
            <strong>还没有历史报告</strong>
            <span>达摩盘一体化插件完成任一模式取数后，报告会自动保存到当前账号。</span>
          </div>
        )}
      </section>

      {selectedRecord ? <DmpGrowthReportViewer record={selectedRecord} variant="preview" /> : null}
    </section>
  );
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
}
