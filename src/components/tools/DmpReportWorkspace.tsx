"use client";

import {
  CheckCircle2,
  Download,
  FileSpreadsheet,
  RefreshCw,
  Search,
  Trash2
} from "lucide-react";
import { useMemo, useState } from "react";
import { canonicalToDmpReport, type DmpCell, type DmpReport, type DmpReportTable } from "@/lib/dmp-report-import";
import { dmpCellSemantic, formatDmpCell } from "@/lib/dmp-report-format";
import type { DmpBusinessReportRecord } from "@/lib/dmp-report-types";

const PREVIEW_ROW_LIMIT = 500;

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

function downloadFilename(response: Response, record: DmpBusinessReportRecord, format: "xlsx" | "csv") {
  const disposition = response.headers.get("content-disposition") ?? "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {}
  }
  return `达摩盘打爆路径报告_${record.subjectItemId}_vs_${record.competitorItemId}.${format}`;
}

export function DmpReportWorkspace({ initialReports }: { initialReports: DmpBusinessReportRecord[] }) {
  const [reports, setReports] = useState(initialReports);
  const [selectedId, setSelectedId] = useState(initialReports[0]?.id ?? "");
  const [selectedTable, setSelectedTable] = useState("对标总表");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState("");
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
  const kpis = useMemo(() => report ? [
    { label: "主体 30 日 GMV", value: tableMetric(report, 0, "总GMV"), tone: "subject" },
    { label: "成功品 30 日 GMV", value: tableMetric(report, 1, "总GMV"), tone: "competitor" },
    { label: "主体广告消耗", value: tableMetric(report, 0, "广告消耗"), tone: "subject" },
    { label: "成功品广告消耗", value: tableMetric(report, 1, "广告消耗"), tone: "competitor" },
    { label: "主体费比", value: tableMetric(report, 0, "费比"), tone: "subject" },
    { label: "成功品费比", value: tableMetric(report, 1, "费比"), tone: "competitor" }
  ] : [], [report]);

  function selectReport(record: DmpBusinessReportRecord) {
    const nextReport = reportFromRecord(record);
    setSelectedId(record.id);
    setSelectedTable(nextReport?.tables.some((table) => table.name === "对标总表") ? "对标总表" : nextReport?.tables[0]?.name ?? "");
    setQuery("");
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
    if (!window.confirm(`确认删除主体商品 ${record.subjectItemId} 的这份报告？`)) return;
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

  async function downloadReport(record: DmpBusinessReportRecord, format: "xlsx" | "csv") {
    const key = `${record.id}:${format}`;
    setDownloading(key);
    try {
      const response = await fetch(`/api/dmp-reports?id=${encodeURIComponent(record.id)}&format=${format}`, {
        cache: "no-store",
        credentials: "same-origin"
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(result?.error ?? "报告下载失败");
      }
      const file = await response.blob();
      if (!file.size) throw new Error("报告文件为空，请刷新后重试");
      const href = URL.createObjectURL(file);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = downloadFilename(response, record, format);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
      setNotice(`${format.toUpperCase()} 报告已开始下载`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "报告下载失败，请稍后重试");
    } finally {
      setDownloading("");
    }
  }

  return (
    <section className="dmp-workspace">
      <div className="dmp-workspace-topbar">
        <div className="dmp-report-path">
          <span>使用路径</span>
          <strong>达摩盘 → 货品 → 打爆路径</strong>
        </div>
        <div className="dmp-workspace-actions">
          <button type="button" onClick={() => void refreshReports()} disabled={busy}>
            <RefreshCw className={busy ? "spin" : ""} size={15} /> 刷新历史
          </button>
          {selectedRecord ? (
            <>
              <button type="button" onClick={() => void downloadReport(selectedRecord, "xlsx")} disabled={Boolean(downloading)}>
                <FileSpreadsheet size={15} /> {downloading === `${selectedRecord.id}:xlsx` ? "生成中…" : "下载 Excel"}
              </button>
              <button type="button" onClick={() => void downloadReport(selectedRecord, "csv")} disabled={Boolean(downloading)}>
                <Download size={15} /> {downloading === `${selectedRecord.id}:csv` ? "生成中…" : "下载 CSV"}
              </button>
            </>
          ) : null}
        </div>
      </div>

      <div className="dmp-business-strip">
        <div><strong>看增长差距</strong><span>同周期对比主体与成功品 GMV、消耗、费比和 ROAS。</span></div>
        <div><strong>看预算结构</strong><span>拆解五渠道与投放场景，快速发现预算偏重和增长机会。</span></div>
        <div><strong>做历史复盘</strong><span>每次生成自动留档，可随时在线查看、下载和删除。</span></div>
      </div>

      <section className="dmp-history-section">
        <header>
          <div>
            <span>REPORT HISTORY</span>
            <h2>历史生成报告</h2>
            <p>{notice} · 点击报告卡片即刻切换预览</p>
          </div>
          <strong>{reports.length} 份</strong>
        </header>
        {reports.length ? (
          <div className="dmp-history-grid">
            {reports.map((record) => (
              <article className={`dmp-history-card${selectedRecord?.id === record.id ? " active" : ""}`} key={record.id}>
                <button className="dmp-history-main" type="button" onClick={() => selectReport(record)} aria-pressed={selectedRecord?.id === record.id}>
                  <span>{createdAtLabel(record.createdAt)}</span>
                  <strong>主体 {record.subjectItemId}</strong>
                  <small>成功品 {record.competitorItemId} · {record.period}</small>
                </button>
                <div className="dmp-history-actions">
                  <button type="button" onClick={() => void downloadReport(record, "xlsx")} disabled={Boolean(downloading)}>
                    <Download size={14} /> {downloading === `${record.id}:xlsx` ? "生成中…" : "下载 Excel"}
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
            <span>在达摩盘打爆路径完成取数后，报告会自动保存到当前账号。</span>
          </div>
        )}
      </section>

      {report && selectedRecord ? (
        <>
          <div className="dmp-report-identity">
            <div>
              <span className="dmp-report-kicker">ONLINE BUSINESS REPORT</span>
              <h2>{report.title}</h2>
              <p>主体商品 <b>{selectedRecord.subjectItemId}</b> · 成功品 <b>{selectedRecord.competitorItemId}</b> · {selectedRecord.period}</p>
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
        <p className="dmp-report-preview-limit">在线预览最多显示 {PREVIEW_ROW_LIMIT} 行，下载 Excel 可查看完整数据。</p>
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
