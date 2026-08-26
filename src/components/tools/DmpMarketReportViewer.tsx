"use client";

import type { CSSProperties, ReactNode } from "react";
import { useMemo, useState } from "react";
import type { DmpBusinessReportRecord } from "@/lib/dmp-report-types";
import {
  buildDmpMarketTrackMatrix,
  dmpMarketTrackPeriodOptions,
  dmpMarketTrackHeatOpacity,
  dmpMarketCategoryLabel,
  formatDmpMarketTrackScore,
  formatMarketMetric,
  marketKpiMetrics,
  parseBusinessNumber,
  projectDmpMarketReport,
  selectDmpMarketPeriod,
  selectDmpMarketTrackPeriod,
  type DmpMarketTrackMatrix,
  type DmpMarketViewerTable,
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
  const defaultMode: DmpMarketPeriodMode = model.periods.month.length
    ? "month"
    : model.periods.week.length
      ? "week"
      : "day";
  const [mode, setMode] = useState<DmpMarketPeriodMode>(defaultMode);
  const [periodKeys, setPeriodKeys] = useState<Record<DmpMarketPeriodMode, string>>({
    day: model.periods.day.at(-1)?.key ?? "",
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
                {model.periods.day.length ? <option value="day">自然日</option> : null}
                {model.periods.week.length ? <option value="week">自然周</option> : null}
                {model.periods.month.length ? <option value="month">自然月</option> : null}
              </select>
            </label>
            <label>
              <span>{mode === "day" ? "选择日期" : "选择周期"}</span>
              <select
                value={periodKeys[mode]}
                onChange={(event) => setPeriodKeys((current) => ({ ...current, [mode]: event.target.value }))}
              >
                {model.periods[mode].map((option) => <option value={option.key} key={option.key}>{option.label}</option>)}
              </select>
            </label>
          </div>
          <div className={styles.periodIdentity}>
            <span>{mode === "day" ? "当前日期" : "当前周期"}</span>
            <strong>{periodLabel || "全部可用日期"}</strong>
            {model.capturedPeriod ? (
              <small className={styles.capturedPeriod} data-captured-period>
                细分赛道已采全周期：{model.capturedPeriod.start} 至 {model.capturedPeriod.end} · {model.capturedPeriod.count} 个周期
              </small>
            ) : null}
          </div>
        </section>

        {record.quality === "partial" ? (
          <section className={styles.qualityWarning} role="alert" data-report-quality="partial">
            <strong>本次采集存在缺失，正在等待补采</strong>
            <span>当前仅展示已成功获取并归档的数据；缺失项不会按 0 处理，保持达摩盘页面与插件运行后可继续补采。</span>
          </section>
        ) : null}

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
          <DmpMarketTableSection
            table={table}
            tableIndex={tableIndex}
            periodLabel={periodLabel}
            key={`${table.name}-${tableIndex}`}
          />
        ))}

        {!kpis.length && !selected.tables.length ? (
          <section className={styles.emptyState} role="status" data-testid="dmp-market-empty-state">
            <strong>暂无业务数据</strong>
            <span>{periodLabel || "所选日期"} 没有可展示的达摩盘业务数据</span>
          </section>
        ) : null}
      </main>
      <footer className={styles.footer}>{record.shopName ? `${record.shopName} · ` : ""}少壮AI自动化报告</footer>
    </article>
  );
}

function DmpMarketTableSection({
  table,
  tableIndex,
  periodLabel
}: {
  table: DmpMarketViewerTable;
  tableIndex: number;
  periodLabel: string;
}) {
  const trackMatrix = useMemo(() => buildDmpMarketTrackMatrix(table), [table]);
  const trackPeriodOptions = dmpMarketTrackPeriodOptions(table);
  if (trackPeriodOptions.length) {
    const defaultKey = trackPeriodOptions.find((option) => (
      option.start === table.selectedTrackPeriod?.start && option.end === table.selectedTrackPeriod?.end
    ))?.key ?? trackPeriodOptions[0].key;
    return (
      <DmpMarketLongTrackMatrixSection
        table={table}
        tableIndex={tableIndex}
        defaultPeriodKey={defaultKey}
        key={`${table.name}-${defaultKey}`}
      />
    );
  }
  if (trackMatrix) return <DmpMarketTrackMatrixSection matrix={trackMatrix} tableIndex={tableIndex} />;
  return (
    <section className={styles.reportSection} data-report-section={table.name} data-track-section={`table:${table.name}`}>
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
  );
}

function DmpMarketLongTrackMatrixSection({
  table,
  tableIndex,
  defaultPeriodKey
}: {
  table: DmpMarketViewerTable;
  tableIndex: number;
  defaultPeriodKey: string;
}) {
  const periodOptions = useMemo(() => dmpMarketTrackPeriodOptions(table), [table]);
  const [periodKey, setPeriodKey] = useState(defaultPeriodKey);
  const selectedTable = useMemo(
    () => selectDmpMarketTrackPeriod(table, periodKey),
    [periodKey, table]
  );
  const matrix = useMemo(() => buildDmpMarketTrackMatrix(selectedTable), [selectedTable]);
  if (!matrix) return null;
  return (
    <DmpMarketTrackMatrixSection
      matrix={matrix}
      tableIndex={tableIndex}
      periodOptions={periodOptions}
      periodKey={periodKey}
      onPeriodKeyChange={setPeriodKey}
    />
  );
}

function DmpMarketTrackMatrixSection({
  matrix,
  tableIndex,
  periodOptions = [],
  periodKey = "",
  onPeriodKeyChange
}: {
  matrix: DmpMarketTrackMatrix;
  tableIndex: number;
  periodOptions?: ReturnType<typeof dmpMarketTrackPeriodOptions>;
  periodKey?: string;
  onPeriodKeyChange?: (key: string) => void;
}) {
  const [metricLabel, setMetricLabel] = useState(matrix.metrics[0]?.label ?? "");
  const metric = matrix.metrics.find((candidate) => candidate.label === metricLabel) ?? matrix.metrics[0];
  if (!metric) return null;
  return (
    <section
      className={`${styles.reportSection} ${styles.trackSection}`}
      data-report-section={matrix.tableName}
      data-track-section={`table:${matrix.tableName}`}
      data-track-matrix={matrix.tableName}
    >
      <header>
        <span>{String(tableIndex + 1).padStart(2, "0")}</span>
        <h2>细分赛道：价格带 × {matrix.propertyName}</h2>
        <small>本期对比上一周期</small>
      </header>
      <div className={styles.trackToolbar}>
        <label className={styles.trackMetricControl}>
          <span>矩阵指标</span>
          <select value={metric.label} onChange={(event) => setMetricLabel(event.target.value)}>
            {matrix.metrics.map((candidate) => (
              <option value={candidate.label} key={candidate.label}>{candidate.label}</option>
            ))}
          </select>
        </label>
        {periodOptions.length && onPeriodKeyChange ? (
          <label className={styles.trackMetricControl}>
            <span>赛道周期（全部已采周期可选）</span>
            <select
              value={periodKey}
              data-track-period-selector
              onChange={(event) => onPeriodKeyChange(event.target.value)}
            >
              {periodOptions.map((option) => (
                <option value={option.key} key={option.key}>{option.label}</option>
              ))}
            </select>
          </label>
        ) : null}
        <div className={styles.trackPeriodPair} aria-label="赛道对比周期">
          <span><b>本期</b>{matrix.currentLabel}</span>
          <span><b>上一周期</b>{matrix.previousLabel}</span>
        </div>
      </div>
      <div className={styles.trackLegend}>
        <strong>{metric.label}</strong>
        <span>价格带为行、属性值为列；背景深浅仅编码本期赛道分值，环比为本期减上一周期的分值差。</span>
      </div>
      <div className={styles.trackHeatmapShell} data-report-table={matrix.tableName} data-track-visualization="heatmap">
        <table className={styles.trackHeatmapTable}>
          <thead>
            <tr>
              <th scope="col">价格带</th>
              {matrix.propertyValues.map((propertyValue) => <th scope="col" key={propertyValue}>{propertyValue}</th>)}
            </tr>
          </thead>
          <tbody>
            {metric.rows.map((row) => (
              <tr key={row.priceBand}>
                <th scope="row">{row.priceBand}</th>
                {row.cells.map((cell) => {
                  const state = cell.current === null ? "missing" : cell.current === 0 ? "zero" : "value";
                  const changeTone = cell.change === null
                    ? styles.trackDeltaMissing
                    : cell.change > 0
                      ? styles.trackDeltaPositive
                      : cell.change < 0
                        ? styles.trackDeltaNegative
                        : styles.trackDeltaZero;
                  const heat = dmpMarketTrackHeatOpacity(cell.current, metric.scale);
                  const style = { "--market-track-heat": String(heat) } as CSSProperties;
                  return (
                    <td
                      className={[
                        styles.trackHeatCell,
                        state === "missing" ? styles.trackHeatMissing : "",
                        state === "zero" ? styles.trackHeatZero : ""
                      ].filter(Boolean).join(" ")}
                      data-track-state={state}
                      style={style}
                      aria-label={`${row.priceBand}，${cell.propertyValue}：本期 ${formatDmpMarketTrackScore(cell.current)}，上一周期 ${formatDmpMarketTrackScore(cell.previous)}，环比 ${formatDmpMarketTrackScore(cell.change, true)}`}
                      key={cell.propertyValue}
                    >
                      <div className={styles.trackCurrentValue}>
                        <span>本期</span>
                        <strong>{formatDmpMarketTrackScore(cell.current)}</strong>
                      </div>
                      <div className={styles.trackComparisons}>
                        <span>上期 <b>{formatDmpMarketTrackScore(cell.previous)}</b></span>
                        <span className={changeTone}>环比 {formatDmpMarketTrackScore(cell.change, true)}</span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function formatTableCell(value: string, column: string) {
  if (column === "日期" || !/^-?\d+(?:\.\d+)?$/.test(value.replaceAll(",", ""))) return value || "—";
  const numeric = Number(value.replaceAll(",", ""));
  if (!Number.isFinite(numeric)) return value;
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(numeric);
}
