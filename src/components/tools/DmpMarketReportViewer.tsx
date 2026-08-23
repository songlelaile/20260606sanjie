"use client";

import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type { DmpBusinessReportRecord } from "@/lib/dmp-report-types";
import {
  dmpMarketCategoryLabel,
  formatMarketMetric,
  marketKpiMetrics,
  parseBusinessNumber,
  projectDmpMarketReport,
  selectDmpMarketPeriod,
  type DmpMarketPeriodMode
} from "@/components/tools/DmpMarketReportViewModel";
import styles from "./DmpMarketReportViewer.module.css";

const WATERMARKS = Array.from({ length: 54 }, (_, index) => index);

export function DmpMarketReportViewer({
  record,
  variant = "preview",
  actions,
  className = ""
}: {
  record: DmpBusinessReportRecord;
  variant?: "preview" | "shared";
  actions?: ReactNode;
  className?: string;
}) {
  const model = useMemo(() => projectDmpMarketReport(record), [record]);
  const defaultMode: DmpMarketPeriodMode = model.periods.month.length ? "month" : "week";
  const [mode, setMode] = useState<DmpMarketPeriodMode>(defaultMode);
  const [periodKeys, setPeriodKeys] = useState<Record<DmpMarketPeriodMode, string>>({
    month: model.periods.month.at(-1)?.key ?? "",
    week: model.periods.week.at(-1)?.key ?? ""
  });
  const selected = useMemo(
    () => selectDmpMarketPeriod(model, mode, periodKeys[mode]),
    [mode, model, periodKeys]
  );
  const kpis = useMemo(() => marketKpiMetrics(selected.tables), [selected.tables]);
  const periodLabel = selected.selected?.label || model.period;
  const scopePath = dmpMarketCategoryLabel(model.scope, record.subjectItemId);

  return (
    <article
      className={[styles.root, variant === "shared" ? styles.shared : styles.preview, className].filter(Boolean).join(" ")}
      data-testid="dmp-market-report-viewer"
      data-report-kind="market"
      data-report-scroll-root={variant === "shared" ? "shared" : undefined}
    >
      <div className={styles.watermark} data-report-watermark aria-hidden="true">
        {WATERMARKS.map((index) => <span key={index}>少壮AI自动化 · shaozhuangai.com</span>)}
      </div>

      <header className={styles.hero} data-report-hero data-track-section="hero" data-track="header">
        <p>达摩盘 · 类目大盘</p>
        <h1>少壮AI自动化报告</h1>
        <div className={styles.scopeLine}>
          {record.shopName ? <span data-report-shop-signature>店铺署名：{record.shopName}</span> : null}
          <strong>{scopePath}</strong>
          <div className={styles.actions}>
            {actions}
            <button type="button" data-report-print data-track="print" onClick={() => window.print()}>打印 / 保存 PDF</button>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.periodPanel} aria-label="选择自然周期">
          <div className={styles.categoryIdentity}>
            <span>类目</span>
            <strong>{scopePath}</strong>
          </div>
          <div className={styles.periodControls}>
            <label>
              <span>周期类型</span>
              <select value={mode} onChange={(event) => setMode(event.target.value as DmpMarketPeriodMode)}>
                {model.periods.week.length ? <option value="week">自然周</option> : null}
                {model.periods.month.length ? <option value="month">自然月</option> : null}
              </select>
            </label>
            <label>
              <span>选择周期</span>
              <select
                value={periodKeys[mode]}
                onChange={(event) => setPeriodKeys((current) => ({ ...current, [mode]: event.target.value }))}
              >
                {model.periods[mode].map((option) => <option value={option.key} key={option.key}>{option.label}</option>)}
              </select>
            </label>
          </div>
          <div className={styles.periodIdentity}>
            <span>当前周期</span>
            <strong>{periodLabel || "全部可用日期"}</strong>
          </div>
        </section>

        {kpis.length ? (
          <section className={styles.summary} data-track-section="market-summary">
            <header><h2>核心指标</h2></header>
            <div>
              {kpis.map((metric) => (
                <article key={metric.label}>
                  <span>{metric.label.replace(/区间/g, "")}</span>
                  <strong>{formatMarketMetric(metric.value, metric.percent)}</strong>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {selected.tables.map((table, tableIndex) => (
          <section className={styles.reportSection} data-report-section={table.name} data-track-section={`table:${table.name}`} key={`${table.name}-${tableIndex}`}>
            <header><span>{String(tableIndex + 1).padStart(2, "0")}</span><h2>{table.name}</h2><small>{periodLabel}</small></header>
            <div className={styles.tableShell} data-report-table={table.name}>
              <table>
                <thead><tr>{table.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
                <tbody>
                  {table.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {table.columns.map((column, columnIndex) => {
                        const value = row[columnIndex] ?? "";
                        const numeric = parseBusinessNumber(value, column) !== null && column !== "日期";
                        return <td className={numeric ? styles.numeric : ""} data-numeric={numeric ? "true" : undefined} key={`${column}-${columnIndex}`}>{formatTableCell(value, column)}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </main>
      <footer className={styles.footer}>{record.shopName ? `${record.shopName} · ` : ""}少壮AI自动化报告</footer>
    </article>
  );
}

function formatTableCell(value: string, column: string) {
  if (column === "日期" || !/^-?\d+(?:\.\d+)?$/.test(value.replaceAll(",", ""))) return value || "—";
  const numeric = Number(value.replaceAll(",", ""));
  if (!Number.isFinite(numeric)) return value;
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(numeric);
}
