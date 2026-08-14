"use client";

import {
  CheckCircle2,
  CircleAlert,
  ClipboardCopy,
  Cloud,
  CloudOff,
  Download,
  FileJson,
  FileSpreadsheet,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldCheck,
  Upload
} from "lucide-react";
import Script from "next/script";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  canonicalToDmpReport,
  inferDmpCaptureMeta,
  isFullDmpReport,
  type DmpCell,
  type DmpCaptureMeta,
  type DmpReport,
  type DmpReportTable,
  unwrapDmpRecords
} from "@/lib/dmp-report-import";

interface BrowserReportEngine {
  buildReport(records: Record<string, unknown>[], itemId: string, meta: DmpCaptureMeta): DmpReport;
  buildCsv(report: DmpReport): string;
  formatMetricValue(semantic: string, value: DmpCell): string;
  safeFilename(value: string): string;
  toCanonicalReport(report: DmpReport): unknown;
}

type OnlineState = "checking" | "online" | "offline" | "denied";

function browserEngine(): BrowserReportEngine | null {
  return ((globalThis as unknown as { DmpReportEngine?: BrowserReportEngine }).DmpReportEngine) ?? null;
}

function cellSemantic(table: DmpReportTable, row: DmpCell[], columnIndex: number): string {
  if (table.name === "对标总表") return `${table.columns[columnIndex]} ${row[1] ?? ""}`;
  if (table.name === "基础指标对比") return `${table.columns[columnIndex]} ${row[0] ?? ""}`;
  return table.columns[columnIndex] ?? "";
}

function formatFallback(value: DmpCell): string {
  if (value == null || value === "") return "—";
  if (typeof value === "number") return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 }).format(value);
  return String(value);
}

function formatCell(table: DmpReportTable, row: DmpCell[], columnIndex: number): string {
  const value = row[columnIndex];
  const engine = browserEngine();
  if (engine) return engine.formatMetricValue(cellSemantic(table, row, columnIndex), value);
  return formatFallback(value);
}

function tableMetric(report: DmpReport, rowIndex: number, column: string): DmpCell {
  const table = report.tables.find((candidate) => candidate.name === "周期汇总");
  const columnIndex = table?.columns.indexOf(column) ?? -1;
  return columnIndex >= 0 ? table?.rows[rowIndex]?.[columnIndex] ?? "" : "";
}

function reportFilename(report: DmpReport, extension: string): string {
  const base = `达摩盘_商品成长竞品对标报告_${report.item.id}_vs_${report.item.competitorId}`;
  return `${browserEngine()?.safeFilename(base) ?? base}${extension}`;
}

function downloadBlob(content: BlobPart, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_500);
}

function buildCsvFallback(report: DmpReport): string {
  const escape = (value: DmpCell) => {
    let text = value == null ? "" : String(value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const lines: DmpCell[][] = [];
  report.tables.forEach((table, index) => {
    if (index) lines.push([]);
    lines.push([table.name], table.columns);
    lines.push(...table.rows);
  });
  return `\ufeff${lines.map((row) => row.map(escape).join(",")).join("\r\n")}`;
}

export function DmpReportWorkspace() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [completenessReady, setCompletenessReady] = useState(false);
  const [engineReady, setEngineReady] = useState(false);
  const [onlineState, setOnlineState] = useState<OnlineState>("checking");
  const [onlineMessage, setOnlineMessage] = useState("正在连接 shaozhuangai.com");
  const [report, setReport] = useState<DmpReport | null>(null);
  const [fileName, setFileName] = useState("");
  const [selectedTable, setSelectedTable] = useState("对标总表");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("等待导入达摩盘监听 JSON 工程文件");

  const checkOnline = useCallback(async () => {
    setOnlineState((current) => current === "online" ? current : "checking");
    try {
      const response = await fetch("/api/auth/me", { method: "GET", cache: "no-store" });
      const result = await response.json().catch(() => null) as {
        data?: {
          role?: string;
          service?: { online?: boolean };
          capabilities?: { dmpJsonImport?: boolean };
        };
      } | null;
      if (!response.ok || !result?.data) {
        setOnlineState(response.status === 401 ? "denied" : "offline");
        setOnlineMessage(response.status === 401 ? "登录或管理员权限已失效" : `官网状态异常（${response.status}）`);
        return;
      }
      if (result.data.role !== "admin" || result.data.capabilities?.dmpJsonImport !== true) {
        setOnlineState("denied");
        setOnlineMessage("当前账号没有 JSON 工程文件权限");
        return;
      }
      setOnlineState("online");
      setOnlineMessage("官网在线 · 平台管理员权限有效");
    } catch {
      setOnlineState("offline");
      setOnlineMessage("官网暂时不可达，已停止新的 JSON 导入");
    }
  }, []);

  useEffect(() => {
    void checkOnline();
    const timer = window.setInterval(() => void checkOnline(), 30_000);
    return () => window.clearInterval(timer);
  }, [checkOnline]);

  const activeTable = useMemo(() => {
    if (!report) return null;
    return report.tables.find((table) => table.name === selectedTable) ?? report.tables[0] ?? null;
  }, [report, selectedTable]);

  const visibleRows = useMemo(() => {
    if (!activeTable) return [];
    const keyword = query.trim().toLowerCase();
    if (!keyword) return activeTable.rows;
    return activeTable.rows.filter((row) => row.some((value) => String(value ?? "").toLowerCase().includes(keyword)));
  }, [activeTable, query]);

  const kpis = useMemo(() => report ? [
    { label: "主体 30 日 GMV", value: tableMetric(report, 0, "总GMV"), tone: "subject" },
    { label: "对手 30 日 GMV", value: tableMetric(report, 1, "总GMV"), tone: "competitor" },
    { label: "主体广告消耗", value: tableMetric(report, 0, "广告消耗"), tone: "subject" },
    { label: "对手广告消耗", value: tableMetric(report, 1, "广告消耗"), tone: "competitor" },
    { label: "主体费比", value: tableMetric(report, 0, "费比"), tone: "subject" },
    { label: "对手费比", value: tableMetric(report, 1, "费比"), tone: "competitor" }
  ] : [], [report]);

  async function loadFile(file: File) {
    setError("");
    if (onlineState !== "online") {
      setError("官网在线状态或平台管理员权限无效，不能导入 JSON 工程文件");
      return;
    }
    if (!engineReady) {
      setError("解析引擎仍在加载，请稍后重试");
      return;
    }
    if (!file.name.toLowerCase().endsWith(".json")) {
      setError("请选择插件导出的 .json 工程文件");
      return;
    }
    if (file.size > 120 * 1024 * 1024) {
      setError("JSON 文件超过 120 MB，请先在插件内按本次任务重新导出");
      return;
    }

    setBusy(true);
    setNotice("正在本机解析 JSON 与 11 张业务表…");
    try {
      const parsed: unknown = JSON.parse(await file.text());
      let nextReport: DmpReport | null = null;
      if (isFullDmpReport(parsed)) {
        nextReport = parsed;
      } else {
        nextReport = canonicalToDmpReport(parsed);
      }
      if (!nextReport) {
        const records = unwrapDmpRecords(parsed);
        if (!records.length) throw new Error("JSON 中没有找到插件监听记录");
        const meta = inferDmpCaptureMeta(records, file.name);
        const engine = browserEngine();
        if (!engine) throw new Error("达摩盘解析引擎加载失败，请刷新页面重试");
        nextReport = engine.buildReport(records, meta.subjectItemId, meta);
      }

      setReport(nextReport);
      setFileName(file.name);
      setSelectedTable(nextReport.tables.some((table) => table.name === "对标总表") ? "对标总表" : nextReport.tables[0]?.name ?? "");
      setQuery("");
      const totalRows = nextReport.tables.reduce((sum, table) => sum + table.rows.length, 0);
      setNotice(nextReport.quality.complete
        ? `解析完成 · ${nextReport.tables.length} 张表 · ${totalRows} 行`
        : `已解析局部数据 · ${nextReport.tables.length} 张表 · 完整性门禁未通过`);
    } catch (caught) {
      setReport(null);
      setFileName("");
      setError(caught instanceof Error ? caught.message : String(caught));
      setNotice("解析失败，请核对 JSON 是否由当前达摩盘插件导出");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function downloadXlsx() {
    if (!report) return;
    setBusy(true);
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.utils.book_new();
      for (const table of report.tables) {
        const sheet = XLSX.utils.aoa_to_sheet([table.columns, ...table.rows]);
        sheet["!freeze"] = { xSplit: 0, ySplit: 1 };
        sheet["!cols"] = table.columns.map((column) => ({ wch: Math.max(12, Math.min(36, column.length * 2 + 4)) }));
        XLSX.utils.book_append_sheet(workbook, sheet, table.name.slice(0, 31));
      }
      XLSX.writeFile(workbook, reportFilename(report, ".xlsx"), { compression: true });
    } catch (caught) {
      setError(`XLSX 导出失败：${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setBusy(false);
    }
  }

  function downloadCsv() {
    if (!report) return;
    const csv = browserEngine()?.buildCsv(report) ?? buildCsvFallback(report);
    downloadBlob(csv, reportFilename(report, ".csv"), "text/csv;charset=utf-8");
  }

  async function copyBusinessJson() {
    if (!report) return;
    const output = browserEngine()?.toCanonicalReport(report) ?? report;
    try {
      await navigator.clipboard.writeText(JSON.stringify(output, null, 2));
      setNotice("业务数据 JSON 已复制");
    } catch {
      setError("浏览器剪贴板不可用，请改用 CSV 或 XLSX 下载");
    }
  }

  const statusIcon = onlineState === "online" ? <Cloud size={15} /> : onlineState === "checking" ? <RefreshCw className="spin" size={15} /> : <CloudOff size={15} />;
  const gateIssues = report?.quality.blockingIssues ?? report?.quality.missing ?? [];

  return (
    <>
      <Script
        src="/tools/dmp-report-engine/completeness-engine.js"
        strategy="afterInteractive"
        onLoad={() => setCompletenessReady(true)}
      />
      {completenessReady ? (
        <Script
          src="/tools/dmp-report-engine/report-engine.js"
          strategy="afterInteractive"
          onLoad={() => setEngineReady(Boolean(browserEngine()))}
        />
      ) : null}

      <section className="dmp-workspace" aria-busy={busy}>
        <div className="dmp-workspace-topbar">
          <div className={`dmp-online-state ${onlineState}`}>
            {statusIcon}
            <span>{onlineMessage}</span>
          </div>
          <div className="dmp-workspace-actions">
            <input
              ref={inputRef}
              className="dmp-file-input"
              type="file"
              accept=".json,application/json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void loadFile(file);
              }}
            />
            <button
              type="button"
              className="dmp-action-primary"
              disabled={busy || !engineReady || onlineState !== "online"}
              onClick={() => inputRef.current?.click()}
            >
              <Upload size={17} />
              {busy ? "正在解析" : "导入 JSON 工程文件"}
            </button>
            <button type="button" disabled={!report || busy} onClick={() => void downloadXlsx()}>
              <FileSpreadsheet size={17} /> 下载 XLSX
            </button>
            <button type="button" disabled={!report || busy} onClick={downloadCsv}>
              <Download size={17} /> 下载 CSV
            </button>
            <button type="button" disabled={!report || busy} onClick={() => void copyBusinessJson()}>
              <ClipboardCopy size={17} /> 复制业务 JSON
            </button>
          </div>
        </div>

        <div className="dmp-security-strip">
          <LockKeyhole size={16} />
          <span><strong>管理员专属入口</strong> · 每 30 秒重新校验官网在线状态与角色；文件只在当前浏览器内存解析，不上传服务器。</span>
        </div>

        {error ? (
          <div className="dmp-alert bad"><CircleAlert size={17} /><span>{error}</span></div>
        ) : null}

        {!report ? (
          <button
            type="button"
            className="dmp-dropzone"
            disabled={busy || !engineReady || onlineState !== "online"}
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const file = event.dataTransfer.files?.[0];
              if (file) void loadFile(file);
            }}
          >
            <span className="dmp-dropzone-icon"><FileJson size={32} /></span>
            <strong>打开达摩盘 JSON 工程文件</strong>
            <span>支持插件原始监听 JSON、标准业务 JSON 和 v3 完整报告 JSON</span>
            <small>{engineReady ? notice : "正在加载确定性解析引擎…"}</small>
          </button>
        ) : (
          <>
            <div className="dmp-report-identity">
              <div>
                <span className="dmp-report-kicker">DMP GROWTH BENCHMARK</span>
                <h2>{report.title}</h2>
                <p>主体 <b>{report.item.id}</b> vs 成功品 <b>{report.item.competitorId}</b> · {report.periodLabel}</p>
              </div>
              <div className={`dmp-quality-badge ${report.quality.complete ? "complete" : "blocked"}`}>
                {report.quality.complete ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}
                <span>{report.quality.complete ? "完整性门禁通过" : "完整性门禁未通过"}</span>
              </div>
            </div>

            <div className="dmp-kpi-grid">
              {kpis.map((kpi) => (
                <article key={kpi.label} className={`dmp-kpi ${kpi.tone}`}>
                  <span>{kpi.label}</span>
                  <strong>{formatFallback(kpi.value)}</strong>
                </article>
              ))}
            </div>

            <div className="dmp-report-meta">
              <span><ShieldCheck size={15} /> {notice}</span>
              <span>{fileName}</span>
              <span>业务响应 {report.recordCount ?? report.quality.parsedRecords ?? "—"}</span>
              <button type="button" onClick={() => inputRef.current?.click()} disabled={busy || onlineState !== "online"}>更换 JSON</button>
            </div>

            {gateIssues.length ? (
              <details className="dmp-gate-issues">
                <summary>查看 {gateIssues.length} 项数据缺口</summary>
                <ul>{gateIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
              </details>
            ) : null}

            <div className="dmp-table-tabs" role="tablist" aria-label="报告业务表">
              {report.tables.map((table) => (
                <button
                  key={table.name}
                  type="button"
                  role="tab"
                  aria-selected={activeTable?.name === table.name}
                  className={activeTable?.name === table.name ? "active" : ""}
                  onClick={() => { setSelectedTable(table.name); setQuery(""); }}
                >
                  <span>{table.name}</span>
                  <small>{table.rows.length}</small>
                </button>
              ))}
            </div>

            {activeTable ? (
              <section className="dmp-table-card">
                <header>
                  <div>
                    <span>BUSINESS TABLE</span>
                    <h3>{activeTable.name}</h3>
                    <p>{activeTable.subtitle || `${activeTable.columns.length} 列 · ${activeTable.rows.length} 行`}</p>
                  </div>
                  <label className="dmp-table-search">
                    <Search size={16} />
                    <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选当前表" />
                  </label>
                </header>
                <div className="dmp-table-scroll">
                  <table>
                    <thead>
                      <tr>{activeTable.columns.map((column) => <th key={column}>{column}</th>)}</tr>
                    </thead>
                    <tbody>
                      {visibleRows.map((row, rowIndex) => (
                        <tr key={`${activeTable.name}-${rowIndex}`}>
                          {activeTable.columns.map((column, columnIndex) => (
                            <td key={`${column}-${columnIndex}`} title={formatCell(activeTable, row, columnIndex)}>
                              {formatCell(activeTable, row, columnIndex)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!visibleRows.length ? <div className="dmp-table-empty">没有匹配的数据行</div> : null}
                </div>
              </section>
            ) : null}
          </>
        )}
      </section>
    </>
  );
}
