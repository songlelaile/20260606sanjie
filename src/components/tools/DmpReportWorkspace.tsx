"use client";

import {
  CheckCircle2,
  Copy,
  FileSpreadsheet,
  RefreshCw,
  Search,
  Share2,
  Trash2
} from "lucide-react";
import { useMemo, useState } from "react";
import { canonicalToDmpReport, type DmpCell, type DmpReport, type DmpReportTable } from "@/lib/dmp-report-import";
import { dmpCellSemantic, formatDmpCell } from "@/lib/dmp-report-format";
import type { DmpBusinessReportRecord } from "@/lib/dmp-report-types";
import { DmpBrandWatermark } from "@/components/tools/DmpBrandWatermark";

const PREVIEW_ROW_LIMIT = 5_000;

function tableMetric(report: DmpReport, rowIndex: number, column: string): DmpCell {
  const table = report.tables.find((candidate) => candidate.name === "周期汇总");
  const columnIndex = table?.columns.indexOf(column) ?? -1;
  return columnIndex >= 0 ? table?.rows[rowIndex]?.[columnIndex] ?? "" : "";
}

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

function reportFromRecord(record: DmpBusinessReportRecord | null): DmpReport | null {
  return record ? canonicalToDmpReport(record.report) : null;
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
  const [selectedTable, setSelectedTable] = useState("对标总表");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [sharingId, setSharingId] = useState("");
  const [notice, setNotice] = useState(
    initialReports.length ? `已保存 ${initialReports.length} 份历史报告` : "插件生成报告后会自动保存到这里"
  );

  const selectedRecord = useMemo(
    () => reports.find((record) => record.id === selectedId) ?? reports[0] ?? null,
    [reports, selectedId]
  );
  const report = useMemo(() => reportFromRecord(selectedRecord), [selectedRecord]);
  const activeTable = useMemo(() => {
    if (!report) return null;
    return report.tables.find((table) => table.name === selectedTable) ?? report.tables[0] ?? null;
  }, [report, selectedTable]);
  const visibleRows = useMemo(() => {
    if (!activeTable) return [];
    const keyword = query.trim().toLowerCase();
    const filtered = keyword
      ? activeTable.rows.filter((row) => row.some((value) => String(value ?? "").toLowerCase().includes(keyword)))
      : activeTable.rows;
    return filtered.slice(0, PREVIEW_ROW_LIMIT);
  }, [activeTable, query]);
  const kpis = useMemo(() => {
    if (!report || !selectedRecord) return [];
    if (!isCompetitionReport(selectedRecord)) return [
      { label: "主体 30 日 GMV", value: tableMetric(report, 0, "总GMV"), tone: "subject" },
      { label: "成功品 30 日 GMV", value: tableMetric(report, 1, "总GMV"), tone: "competitor" },
      { label: "主体广告消耗", value: tableMetric(report, 0, "广告消耗"), tone: "subject" },
      { label: "成功品广告消耗", value: tableMetric(report, 1, "广告消耗"), tone: "competitor" },
      { label: "主体费比", value: tableMetric(report, 0, "费比"), tone: "subject" },
      { label: "成功品费比", value: tableMetric(report, 1, "费比"), tone: "competitor" }
    ];
    const overview = report.tables.find((table) => table.name === "报告总览");
    if (!overview) return [];
    const currentColumns = overview.columns
      .map((column, index) => ({ column, index }))
      .filter(({ column }) => /当前(?:值)?$/.test(column));
    if (currentColumns.length < 2) return [];
    return overview.rows.slice(0, 3).flatMap((row) => currentColumns.map(({ column, index }, objectIndex) => ({
      label: `${row[0]} ${row[1]} · ${column.replace(/当前(?:值)?$/, "") || (objectIndex === 0 ? "本店" : `竞店${objectIndex}`)}`,
      value: row[index],
      tone: objectIndex === 0 ? "subject" : "competitor"
    })));
  }, [report, selectedRecord]);

  function selectReport(record: DmpBusinessReportRecord) {
    const nextReport = reportFromRecord(record);
    setSelectedId(record.id);
    setSelectedTable(nextReport?.tables.some((table) => table.name === "对标总表") ? "对标总表" : nextReport?.tables[0]?.name ?? "");
    setQuery("");
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
      <DmpBrandWatermark />
      <div className="dmp-print-disabled">当前版本仅支持官网在线查看，暂不支持打印或导出。</div>
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

      {report && selectedRecord ? (
        <>
          <div className="dmp-report-identity">
            <div>
              <span className="dmp-report-kicker">ONLINE BUSINESS REPORT</span>
              <h2>{report.title}</h2>
              <p>{objectLabels(selectedRecord).subject} <b>{selectedRecord.subjectItemId}</b> · {objectLabels(selectedRecord).competitor} <b>{selectedRecord.competitorItemId.replaceAll(",", "、")}</b> · {selectedRecord.period}</p>
            </div>
            <span className={`dmp-quality-badge ${selectedRecord.quality === "complete" ? "complete" : "blocked"}`}>
              <CheckCircle2 size={15} /> {selectedRecord.quality === "complete" ? "数据完整" : "局部数据"}
            </span>
          </div>

          <div className="dmp-kpi-grid">
            {kpis.map((kpi) => (
              <div className={`dmp-kpi ${kpi.tone}`} key={kpi.label}>
                <span>{kpi.label}</span>
                <strong>{formatDmpCell(kpi.value, kpi.label)}</strong>
              </div>
            ))}
          </div>

          <div className="dmp-report-meta">
            <span><CheckCircle2 size={14} /> 在线报告已保存</span>
            <span>{report.tables.length} 张业务表</span>
            <span>生成时间 {createdAtLabel(selectedRecord.createdAt)}</span>
            <button type="button" onClick={() => void createShare(selectedRecord)} disabled={Boolean(sharingId)}><Copy size={14} /> 复制只读链接</button>
          </div>

          <div className="dmp-table-tabs">
            {report.tables.map((table) => (
              <button
                className={activeTable?.name === table.name ? "active" : ""}
                key={table.name}
                type="button"
                onClick={() => { setSelectedTable(table.name); setQuery(""); }}
              >
                <span>{table.name}</span><small>{table.rows.length}</small>
              </button>
            ))}
          </div>

          {activeTable ? <ReportTable table={activeTable} query={query} setQuery={setQuery} visibleRows={visibleRows} /> : null}
        </>
      ) : null}
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

function ReportTable({
  table,
  query,
  setQuery,
  visibleRows
}: {
  table: DmpReportTable;
  query: string;
  setQuery: (value: string) => void;
  visibleRows: DmpCell[][];
}) {
  return (
    <section className="dmp-table-card">
      <header>
        <div>
          <span>BUSINESS TABLE</span>
          <h3>{table.name}</h3>
          <p>共 {table.rows.length} 行，长内容以省略号预览，悬停可查看全部</p>
        </div>
        <label className="dmp-table-search">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选当前业务表…" />
        </label>
      </header>
      {table.rows.length > PREVIEW_ROW_LIMIT ? (
        <p className="dmp-report-preview-limit">在线页面最多显示前 {PREVIEW_ROW_LIMIT} 行，请使用上方筛选定位数据。</p>
      ) : null}
      <div className="dmp-table-scroll">
        <table>
          <thead><tr>{table.columns.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead>
          <tbody>
            {visibleRows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {table.columns.map((_, columnIndex) => {
                  const displayValue = formatDmpCell(row[columnIndex], dmpCellSemantic(table.name, table.columns, row, columnIndex));
                  return (
                    <td key={columnIndex} title={displayValue === "—" ? undefined : displayValue}>
                      <span className="dmp-table-cell-preview">{displayValue}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!visibleRows.length ? <div className="dmp-table-empty">没有匹配的数据</div> : null}
      </div>
    </section>
  );
}
