"use client";

import type { CSSProperties, ReactNode } from "react";
import { useMemo, useState } from "react";
import type { DmpBusinessReportRecord } from "@/lib/dmp-report-types";
import {
  buildDmpMarketGrowthOpportunityGroups,
  buildDmpMarketOpportunityMatrix,
  buildDmpMarketOpportunityWorkspace,
  buildDmpMarketTrackMatrix,
  dmpMarketTrackHeatOpacity,
  dmpMarketCategoryLabel,
  formatDmpMarketTrackScore,
  formatMarketMetric,
  marketKpiMetrics,
  parseBusinessNumber,
  projectDmpMarketReport,
  selectDmpMarketPeriod,
  isDmpMarketOpportunityWorkspaceSource,
  type DmpMarketGrowthOpportunityGroup,
  type DmpMarketOpportunityWorkspace,
  type DmpMarketOpportunityWorkspaceGroup,
  type DmpMarketOpportunityWorkspaceTrack,
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
  const defaultMode: DmpMarketPeriodMode = model.periods.all.length
    ? "all"
    : model.periods.month.length
      ? "month"
      : model.periods.week.length
        ? "week"
        : "day";
  const [mode, setMode] = useState<DmpMarketPeriodMode>(defaultMode);
  const [periodKeys, setPeriodKeys] = useState<Record<DmpMarketPeriodMode, string>>({
    all: model.periods.all.at(-1)?.key ?? "",
    day: model.periods.day.at(-1)?.key ?? "",
    month: model.periods.month.at(-1)?.key ?? "",
    week: model.periods.week.at(-1)?.key ?? ""
  });
  const selected = useMemo(
    () => selectDmpMarketPeriod(model, mode, periodKeys[mode]),
      [mode, model, periodKeys]
  );
  const opportunityWorkspace = useMemo(
    () => buildDmpMarketOpportunityWorkspace(selected.tables),
    [selected.tables]
  );
  const regularTables = useMemo(
    () => selected.tables.filter((table) => !opportunityWorkspace || !isDmpMarketOpportunityWorkspaceSource(table)),
    [opportunityWorkspace, selected.tables]
  );
  const kpis = useMemo(() => marketKpiMetrics(selected.tables), [selected.tables]);
  const periodLabel = selected.selected?.label || model.period;
  const allCollectedCount = model.allCollected?.periodCount ?? 0;
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
        <section className={styles.periodPanel} aria-label="选择统计周期">
          <div className={styles.categoryIdentity}>
            <span>类目</span>
            <strong>{scopePath}</strong>
          </div>
          <div className={styles.periodControls}>
            <label>
              <span>周期类型</span>
              <select value={mode} onChange={(event) => setMode(event.target.value as DmpMarketPeriodMode)}>
                {model.periods.all.length ? <option value="all">全部已采周期</option> : null}
                {model.periods.day.length ? <option value="day">自然日</option> : null}
                {model.periods.week.length ? <option value="week">自然周</option> : null}
                {model.periods.month.length ? <option value="month">自然月</option> : null}
              </select>
            </label>
            <label>
              <span>{mode === "all" ? "实际获取范围" : mode === "day" ? "选择日期" : "选择周期"}</span>
              <select
                value={periodKeys[mode]}
                disabled={mode === "all"}
                onChange={(event) => setPeriodKeys((current) => ({ ...current, [mode]: event.target.value }))}
              >
                {model.periods[mode].map((option) => <option value={option.key} key={option.key}>{option.label}</option>)}
              </select>
            </label>
          </div>
          <div className={styles.periodIdentity}>
            <span>{mode === "all" ? "实际已采周期" : mode === "day" ? "当前日期" : "当前周期"}</span>
            <strong>{periodLabel || "全部可用日期"}</strong>
            {mode === "all" && allCollectedCount ? <small>共 {allCollectedCount} 个成功获取周期，仅展示实际返回值</small> : null}
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

        {opportunityWorkspace ? (
          <DmpMarketOpportunityWorkspaceSection workspace={opportunityWorkspace} tableIndex={0} />
        ) : null}

        {regularTables.map((table, tableIndex) => (
          <DmpMarketTableSection
            table={table}
            tableIndex={tableIndex + (opportunityWorkspace ? 1 : 0)}
            periodLabel={periodLabel}
            key={`${table.name}-${tableIndex}`}
          />
        ))}

        {!kpis.length && !regularTables.length && !opportunityWorkspace ? (
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

function DmpMarketOpportunityWorkspaceSection({
  workspace,
  tableIndex
}: {
  workspace: DmpMarketOpportunityWorkspace;
  tableIndex: number;
}) {
  const [propertySelection, setPropertySelection] = useState(workspace.propertyNames[0] ?? "");
  const [metricSelection, setMetricSelection] = useState(workspace.metricLabels[0] ?? "");
  const propertyName = workspace.propertyNames.includes(propertySelection)
    ? propertySelection
    : workspace.propertyNames[0] ?? "";
  const metricLabel = workspace.metricLabels.includes(metricSelection)
    ? metricSelection
    : workspace.metricLabels[0] ?? "";
  const periods = workspace.periods.filter((period) => (
    workspace.matrixRecords.some((record) => record.periodKey === period.key && record.propertyName === propertyName)
    || workspace.groups.some((group) => group.periodKey === period.key && group.propertyName === propertyName)
  ));

  return (
    <section
      className={`${styles.reportSection} ${styles.opportunityWorkspace}`}
      data-report-section="货品增长机会"
      data-opportunity-workspace="true"
      data-consumed-tables={workspace.sourceTableNames.join(",")}
    >
      <header>
        <span>{String(tableIndex + 1).padStart(2, "0")}</span>
        <h2>货品增长机会</h2>
        <small>{periods.length} 个实际周期</small>
      </header>
      <div className={styles.opportunityWorkspaceControls}>
        <label>
          <span>分析属性</span>
          <select value={propertyName} onChange={(event) => setPropertySelection(event.target.value)}>
            {workspace.propertyNames.map((property) => <option value={property} key={property}>{property}</option>)}
          </select>
        </label>
        {workspace.metricLabels.length ? (
          <div className={styles.opportunityMetricTabs} role="group" aria-label="赛道矩阵指标">
            <span>分析指标</span>
            <div>
              {workspace.metricLabels.map((metric) => (
                <button
                  type="button"
                  className={metric === metricLabel ? styles.opportunityMetricActive : ""}
                  aria-pressed={metric === metricLabel}
                  onClick={() => setMetricSelection(metric)}
                  key={metric}
                >
                  {metric}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className={styles.opportunityPeriods}>
        {periods.map((period) => {
          const matrix = metricLabel
            ? buildDmpMarketOpportunityMatrix(workspace, period.key, propertyName, metricLabel)
            : null;
          const groups = workspace.groups.filter((group) => (
            group.periodKey === period.key && group.propertyName === propertyName
          ));
          return (
            <article className={styles.opportunityPeriod} data-opportunity-period={period.label} key={period.key}>
              <header className={styles.opportunityPeriodHeader}>
                <div>
                  <span>实际周期</span>
                  <strong>{period.label}</strong>
                </div>
                <small>{propertyName}</small>
              </header>
              {matrix ? (
                <DmpMarketOpportunityLongMatrix
                  matrix={matrix}
                  metricLabel={metricLabel}
                  periodLabel={period.label}
                  propertyName={propertyName}
                />
              ) : null}
              {groups.length ? (
                <div className={styles.opportunityWorkspaceGroups}>
                  {groups.map((group) => (
                    <DmpMarketOpportunityWorkspaceGroupCard
                      group={group}
                      periodLabel={period.label}
                      key={`${group.title}-${group.propertyName}`}
                    />
                  ))}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function DmpMarketOpportunityLongMatrix({
  matrix,
  metricLabel,
  periodLabel,
  propertyName
}: {
  matrix: NonNullable<ReturnType<typeof buildDmpMarketOpportunityMatrix>>;
  metricLabel: string;
  periodLabel: string;
  propertyName: string;
}) {
  return (
    <div className={styles.opportunityMatrixBlock} data-opportunity-matrix={`${periodLabel}-${propertyName}-${metricLabel}`}>
      <div className={styles.opportunityMatrixLegend}>
        <strong>{metricLabel}</strong>
        <span>价格带为行，{propertyName}为列</span>
      </div>
      <div className={styles.opportunityMatrixShell}>
        <table>
          <thead>
            <tr>
              <th scope="col">价格带</th>
              {matrix.propertyValues.map((propertyValue) => <th scope="col" key={propertyValue}>{propertyValue}</th>)}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => (
              <tr key={row.priceBand}>
                <th scope="row">{row.priceBand}</th>
                {row.cells.map((cell) => {
                  const state = cell.value === null ? "missing" : cell.value === 0 ? "zero" : "value";
                  const heat = dmpMarketTrackHeatOpacity(cell.value, matrix.scale);
                  return (
                    <td
                      className={styles.opportunityMatrixCell}
                      data-track-state={state}
                      style={{ "--market-track-heat": String(heat) } as CSSProperties}
                      aria-label={`${periodLabel}，${row.priceBand}，${cell.propertyValue}，${metricLabel}：${formatDmpMarketTrackScore(cell.value)}`}
                      key={cell.propertyValue}
                    >
                      {formatDmpMarketTrackScore(cell.value)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DmpMarketOpportunityWorkspaceGroupCard({
  group,
  periodLabel
}: {
  group: DmpMarketOpportunityWorkspaceGroup;
  periodLabel: string;
}) {
  const displayCount = group.declaredTrackCount ?? group.tracks.length;
  return (
    <section className={styles.opportunityWorkspaceGroup} data-opportunity-group={group.title}>
      <header>
        <div>
          <div className={styles.opportunityWorkspaceGroupTitle}>
            <h3>{group.title}</h3>
            {group.tag ? <span>{group.tag}</span> : null}
          </div>
          {group.description ? <p>{group.description}</p> : null}
        </div>
        <strong>{displayCount} 个赛道</strong>
      </header>
      {group.tracks.length ? (
        <div className={styles.opportunityTrackCards}>
          {group.tracks.map((track, trackIndex) => (
            <DmpMarketOpportunityTrackCard
              track={track}
              periodLabel={periodLabel}
              key={`${track.trackName}-${track.propertyValue}-${track.priceBand}-${trackIndex}`}
            />
          ))}
        </div>
      ) : (
        <div className={styles.opportunityZeroGroup}>0 个赛道</div>
      )}
    </section>
  );
}

function DmpMarketOpportunityTrackCard({
  track,
  periodLabel
}: {
  track: DmpMarketOpportunityWorkspaceTrack;
  periodLabel: string;
}) {
  const collected = /^(?:已关注|是|true|1)$/i.test(track.collected);
  return (
    <details className={styles.opportunityTrackCard} data-opportunity-track={track.trackName}>
      <summary>
        <div>
          <strong>{opportunityValue(track.trackName)}</strong>
          <span>{[track.propertyValue, track.priceBand].filter(hasVisibleOpportunityValue).join(" × ") || "—"}</span>
        </div>
        <div className={styles.opportunityTrackFacts}>
          <span>潜力 {opportunityValue(track.score)}</span>
          <span>本店排名 {opportunityValue(track.shopRank)}</span>
          <span className={collected ? styles.opportunityCollected : styles.opportunityUncollected}>{opportunityValue(track.collected)}</span>
        </div>
      </summary>
      <div className={styles.opportunityTrackDetails}>
        <DmpMarketOpportunityDetailTable
          title="赛道整体 vs 本店"
          columns={["指标", "赛道整体", "本店表现"]}
          rows={track.overall.map((row) => [row.metric, row.trackValue, row.shopValue])}
        />
        <DmpMarketOpportunityDetailTable
          title="赛道人群"
          columns={["人群维度", "特征", "数值"]}
          rows={track.crowds.map((row) => [row.dimension, row.feature, row.value])}
        />
        <DmpMarketOpportunityDetailTable
          title="赛道投放结构"
          columns={["口径", "推广场景", "消耗占比", "点击量", "点击量环比", "点击率", "点击率环比", "支付转化率", "支付转化率环比", "ROI", "ROI环比"]}
          rows={track.promotions.map((row) => [
            row.scope,
            row.scene,
            row.spendShare,
            row.clicks,
            row.clicksChange,
            row.clickRate,
            row.clickRateChange,
            row.conversionRate,
            row.conversionRateChange,
            row.roi,
            row.roiChange
          ])}
        />
        <span className={styles.opportunityTrackPeriod}>{periodLabel}</span>
      </div>
    </details>
  );
}

function DmpMarketOpportunityDetailTable({
  title,
  columns,
  rows
}: {
  title: string;
  columns: string[];
  rows: string[][];
}) {
  return (
    <section className={styles.opportunityDetailSection}>
      <h4>{title}</h4>
      {rows.length ? (
        <div className={styles.opportunityDetailTableShell}>
          <table>
            <thead><tr>{columns.map((column) => <th scope="col" key={column}>{column}</th>)}</tr></thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {columns.map((column, columnIndex) => {
                    const value = row[columnIndex] ?? "";
                    const numeric = parseBusinessNumber(value, column) !== null;
                    return <td className={numeric ? styles.numeric : ""} key={`${column}-${columnIndex}`}>{opportunityValue(value)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className={styles.opportunityDetailEmpty}>—</div>}
    </section>
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
  const opportunityGroups = useMemo(() => buildDmpMarketGrowthOpportunityGroups(table), [table]);
  if (trackMatrix) return <DmpMarketTrackMatrixSection matrix={trackMatrix} tableIndex={tableIndex} />;
  if (opportunityGroups) {
    return (
      <DmpMarketGrowthOpportunitySection
        groups={opportunityGroups}
        table={table}
        tableIndex={tableIndex}
        periodLabel={periodLabel}
      />
    );
  }
  return (
    <section className={styles.reportSection} data-report-section={table.name} data-track-section={`table:${table.name}`}>
      <header><span>{String(tableIndex + 1).padStart(2, "0")}</span><h2>{table.name}</h2><small>{periodLabel}</small></header>
      <div className={styles.tableShell} data-report-table={table.name}>
        <table className={table.name === "全部已采周期" ? styles.allPeriodTable : undefined}>
          <thead><tr>{table.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {table.columns.map((column, columnIndex) => {
                  const value = row[columnIndex] ?? "";
                  const numeric = parseBusinessNumber(value, column) !== null && column !== "日期";
                  if (table.name === "全部已采周期" && columnIndex === 0) {
                    return <th scope="row" key={`${column}-${columnIndex}`}>{formatTableCell(value, column)}</th>;
                  }
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

function DmpMarketGrowthOpportunitySection({
  groups,
  table,
  tableIndex,
  periodLabel
}: {
  groups: DmpMarketGrowthOpportunityGroup[];
  table: DmpMarketViewerTable;
  tableIndex: number;
  periodLabel: string;
}) {
  return (
    <section
      className={`${styles.reportSection} ${styles.opportunitySection}`}
      data-report-section={table.name}
      data-track-section={`table:${table.name}`}
      data-growth-opportunity-view={table.name}
    >
      <header>
        <span>{String(tableIndex + 1).padStart(2, "0")}</span>
        <h2>货品增长机会</h2>
        <small>{periodLabel}</small>
      </header>
      <p className={styles.opportunityLead}>按达摩盘返回的机会类型分组，结合价格带与属性赛道查看综合潜力和本店位置。</p>
      <div className={styles.opportunityGroups}>
        {groups.map((group, groupIndex) => (
          <article className={styles.opportunityGroup} data-growth-opportunity-group={group.title} key={`${group.title}-${groupIndex}`}>
            <header className={styles.opportunityGroupHeader}>
              <div>
                <div className={styles.opportunityTitleLine}>
                  <h3>{group.title}</h3>
                  {group.tag ? <span>{group.tag}</span> : null}
                </div>
                {group.description ? <p>{group.description}</p> : null}
              </div>
              <strong>{group.tracks.length} 个赛道</strong>
            </header>
            <div className={styles.opportunityTableShell} data-report-table={table.name} data-growth-opportunity-tracks={group.title}>
              <table>
                <thead>
                  <tr>
                    <th>赛道名称</th>
                    <th>属性维度</th>
                    <th>属性值</th>
                    <th>价格带</th>
                    <th>综合潜力指数</th>
                    <th>本店成交排名</th>
                    <th>关注状态</th>
                  </tr>
                </thead>
                <tbody>
                  {group.tracks.map((track, trackIndex) => {
                    const collected = /^(?:已关注|是|true|1)$/i.test(track.collected);
                    return (
                      <tr key={`${track.trackName}-${trackIndex}`}>
                        <th scope="row">{opportunityValue(track.trackName)}</th>
                        <td>{opportunityValue(track.propertyName)}</td>
                        <td>{opportunityValue(track.propertyValue)}</td>
                        <td>{opportunityValue(track.priceBand)}</td>
                        <td className={styles.numeric} data-numeric="true">{formatTableCell(track.score, "综合潜力指数")}</td>
                        <td className={styles.numeric} data-numeric="true">{formatTableCell(track.shopRank, "本店成交排名")}</td>
                        <td>
                          <span className={collected ? styles.opportunityCollected : styles.opportunityUncollected}>
                            {opportunityValue(track.collected)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function DmpMarketTrackMatrixSection({
  matrix,
  tableIndex
}: {
  matrix: DmpMarketTrackMatrix;
  tableIndex: number;
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

function opportunityValue(value: string) {
  return value && !/^(?:[-–—]|null|undefined)$/i.test(value) ? value : "—";
}

function hasVisibleOpportunityValue(value: string) {
  return opportunityValue(value) !== "—";
}
