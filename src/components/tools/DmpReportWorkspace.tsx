"use client";

import {
  FileSpreadsheet,
  RefreshCw,
  Search,
  Share2,
  Trash2
} from "lucide-react";
import { useMemo, useState } from "react";
import type { DmpBusinessReportRecord } from "@/lib/dmp-report-types";
import { DmpGrowthReportViewer } from "@/components/tools/DmpGrowthReportViewer";
import styles from "./DmpReportWorkspace.module.css";

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
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");

  const selectedRecord = useMemo(
    () => reports.find((record) => record.id === selectedId) ?? reports[0] ?? null,
    [reports, selectedId]
  );
  const visibleReports = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("zh-CN");
    if (!keyword) return reports;
    return reports.filter((record) => [
      reportTypeLabel(record),
      record.subjectItemId,
      record.competitorItemId,
      record.period,
      createdAtLabel(record.createdAt),
      record.createdAt
    ].some((value) => value.toLocaleLowerCase("zh-CN").includes(keyword)));
  }, [query, reports]);

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
    <section className={`dmp-workspace ${styles.workspace}`}>
      {focusReport ? (
        <div className={styles.focusToolbar}>
          <div className={styles.focusIdentity}>
            <span>当前报告</span>
            <strong>{selectedRecord ? `${objectLabels(selectedRecord).subject} ${selectedRecord.subjectItemId}` : "暂无报告"}</strong>
          </div>
          <div className={styles.toolbar}>
            <button type="button" onClick={() => void refreshReports()} disabled={busy}>
              <RefreshCw className={busy ? "spin" : ""} size={15} /> 刷新
            </button>
            <a href="/tools/dmp-report">浏览全部报告</a>
            {selectedRecord ? (
              <button className={styles.primaryAction} type="button" onClick={() => void createShare(selectedRecord)} disabled={Boolean(sharingId)}>
                <Share2 size={15} /> {sharingId === selectedRecord.id ? "生成中…" : "复制分享链接"}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <section className={styles.library}>
          <header className={styles.libraryHeader}>
            <div className={styles.headerCopy}>
              <div className={styles.headingRow}>
                <h2>历史报告</h2>
                <span className={styles.count}>{query ? `${visibleReports.length} / ${reports.length}` : reports.length} 份</span>
              </div>
              {notice ? <p aria-live="polite">{notice}</p> : null}
            </div>
            <div className={styles.toolbar}>
              <label className={styles.searchField}>
                <Search size={14} aria-hidden="true" />
                <span className={styles.srOnly}>搜索历史报告</span>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索商品 ID、日期或类型"
                />
              </label>
              <button type="button" onClick={() => void refreshReports()} disabled={busy}>
                <RefreshCw className={busy ? "spin" : ""} size={15} /> 刷新
              </button>
              {selectedRecord ? (
                <button className={styles.primaryAction} type="button" onClick={() => void createShare(selectedRecord)} disabled={Boolean(sharingId)}>
                  <Share2 size={15} /> {sharingId === selectedRecord.id ? "生成中…" : "分享当前报告"}
                </button>
              ) : null}
            </div>
          </header>
          {visibleReports.length ? (
            <div className={styles.reportGrid}>
              {visibleReports.map((record) => (
                <article className={`${styles.reportCard}${selectedRecord?.id === record.id ? ` ${styles.active}` : ""}`} key={record.id}>
                  <button className={styles.reportMain} type="button" onClick={() => selectReport(record)} aria-pressed={selectedRecord?.id === record.id}>
                    <span className={styles.cardMeta}>
                      <span className={styles.typeBadge}>{reportTypeLabel(record)}</span>
                      <time>{createdAtLabel(record.createdAt)}</time>
                    </span>
                    <strong>{objectLabels(record).subject} {record.subjectItemId}</strong>
                    <small>{objectLabels(record).competitor} {record.competitorItemId.replaceAll(",", "、")}</small>
                    <span className={styles.period}>{record.period}</span>
                  </button>
                  <div className={styles.cardActions}>
                    <button type="button" onClick={() => void createShare(record)} disabled={Boolean(sharingId)} title="复制分享链接">
                      <Share2 size={15} /> <span>{sharingId === record.id ? "生成中" : "分享"}</span>
                    </button>
                    <button className={styles.dangerAction} type="button" onClick={() => void deleteReport(record)} disabled={busy} aria-label="删除报告" title="删除报告"><Trash2 size={15} /></button>
                  </div>
                </article>
              ))}
            </div>
          ) : reports.length ? (
            <div className={styles.noMatches}>
              <Search size={24} />
              <strong>没有匹配的报告</strong>
              <button type="button" onClick={() => setQuery("")}>清除搜索</button>
            </div>
          ) : (
            <div className={styles.emptyState}>
              <FileSpreadsheet size={36} />
              <strong>还没有历史报告</strong>
              <span>达摩盘一体化插件完成任一模式取数后，报告会自动保存到当前账号。</span>
            </div>
          )}
        </section>
      )}

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
