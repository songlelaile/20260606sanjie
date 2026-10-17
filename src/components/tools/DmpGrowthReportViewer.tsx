"use client";

/* 商品主图来自达摩盘返回的动态 HTTPS 地址，不能使用需要预配置远端域名的 next/image。 */
/* eslint-disable @next/next/no-img-element */

import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useMemo, useState } from "react";
import { dmpCellSemantic, formatDmpCell } from "@/lib/dmp-report-format";
import type { DmpCell } from "@/lib/dmp-report-import";
import type { DmpBusinessReportRecord } from "@/lib/dmp-report-types";
import {
  DMP_GROWTH_FREEZE_COLUMNS,
  DMP_GROWTH_SECTION_IDS,
  isDmpViewerMetricColumn,
  projectDailyGmvChartSeries,
  projectDmpReportForViewer,
  safeViewerHttpsUrl,
  safeViewerImageUrl,
  type DmpGrowthReportViewModel,
  type DmpViewerProduct,
  type DmpViewerTable
} from "@/components/tools/DmpGrowthReportViewModel";
import styles from "./DmpGrowthReportViewer.module.css";

const WATERMARKS = Array.from({ length: 54 }, (_, index) => index);

export interface DmpGrowthReportViewerProps {
  record: DmpBusinessReportRecord;
  variant?: "preview" | "shared";
  actions?: ReactNode;
  className?: string;
}

type CellStyle = CSSProperties & {
  "--dmp-column-width"?: string;
  "--dmp-sticky-left"?: string;
};

interface ChartTooltipPayload {
  x: number;
  y: number;
  period: string;
  metric: string;
  role: "主体" | "目标对手";
  formatted: string;
}

interface ChartTooltipState extends ChartTooltipPayload {
  text: string;
}

export function DmpGrowthReportViewer({
  record,
  variant = "preview",
  actions,
  className = ""
}: DmpGrowthReportViewerProps) {
  const model = useMemo(() => projectDmpReportForViewer(record), [record]);
  const tableByName = useMemo(() => new Map(model.tables.map((table) => [table.name, table])), [model.tables]);
  const displayTitle = model.kind === "growth"
    ? "达摩盘商品成长竞品对标报告｜少壮AI自动化"
    : "达摩盘竞争态势分析报告｜少壮AI自动化";

  return (
    <article
      className={[styles.root, variant === "shared" ? styles.shared : styles.preview, className].filter(Boolean).join(" ")}
      data-testid="dmp-growth-report-viewer"
      data-report-kind={model.kind}
      data-report-scroll-root={variant === "shared" ? "shared" : undefined}
    >
      <div className={styles.watermark} data-report-watermark aria-hidden="true">
        {WATERMARKS.map((index) => <span key={index}>少壮AI自动化 · shaozhuangai.com</span>)}
      </div>

      <header className={styles.hero} data-report-hero data-track-section="hero" data-track="header">
        <p className={styles.eyebrow}>{model.kind === "growth" ? "DAMOPAN · GROWTH BENCHMARK" : "DAMOPAN · COMPETITION SITUATION"}</p>
        <h1>{displayTitle}</h1>
        <div className={styles.heroMeta}>
          {record.shopName ? <span data-report-shop-signature>店铺署名：{record.shopName}</span> : null}
          <span>{model.kind === "growth" ? "主体" : "本店"}：{model.subject.title || model.subjectId || "—"}{model.subjectId ? `（${model.subjectId}）` : ""}</span>
          <span>{model.kind === "growth" ? "目标对手" : "竞店"}：{model.competitor.title || model.competitorId || "—"}{model.competitor.title && model.competitorId ? `（${model.competitorId}）` : ""}</span>
          <span>生成时间：{formatGeneratedAt(model.generatedAt)}</span>
          <div className={styles.actions}>
            {actions ? <div className={styles.actionSlot}>{actions}</div> : null}
            <button type="button" data-report-print data-track="print" onClick={() => window.print()}>打印 / 保存 PDF</button>
          </div>
        </div>
      </header>

      <div className={styles.navWrap} data-track-section="report-nav">
        <nav aria-label="报告目录">
          {model.tables.map((table, index) => (
            <a data-track={`nav:${index + 1}`} key={table.name} href={`#${sectionId(table, index)}`}>{table.name}</a>
          ))}
        </nav>
      </div>

      <main className={styles.main}>
        {model.quality.effectiveQuality === "partial"
          ? <PartialQualityBanner model={model} recordId={record.id} variant={variant} />
          : null}
        {model.tables.map((table, index) => table.name === "报告总览" && model.kind === "growth"
          ? <GrowthOverview key={table.name} model={model} table={table} tableByName={tableByName} />
          : <ReportTableSection key={`${table.name}-${index}`} table={table} index={index} kind={model.kind} tableByName={tableByName} />)}
      </main>

      <footer className={styles.footer}>{record.shopName ? `${record.shopName} · ` : ""}{displayTitle}</footer>
    </article>
  );
}

function PartialQualityBanner({
  model,
  recordId,
  variant
}: {
  model: DmpGrowthReportViewModel;
  recordId: string;
  variant: "preview" | "shared";
}) {
  return (
    <aside className={styles.qualityBanner} data-report-quality="partial" role="status">
      <div>
        <strong>部分数据报告</strong>
        <p>{model.quality.notice}</p>
      </div>
      {variant === "preview" ? (
        <a
          className={styles.qualityAction}
          data-report-supplement
          href={`/tools/dmp-report?source=dmp-extension&retryReportId=${encodeURIComponent(recordId)}`}
        >继续补采</a>
      ) : <span className={styles.qualityOwnerHint}>可由报告创建者继续补采</span>}
    </aside>
  );
}

function GrowthOverview({
  model,
  table,
  tableByName
}: {
  model: DmpGrowthReportViewModel;
  table: DmpViewerTable;
  tableByName: Map<string, DmpViewerTable>;
}) {
  const daily = tableByName.get("日GMV与费比");
  const period = tableByName.get("周期汇总");
  const channels = tableByName.get("渠道花费");
  const dailyChart = daily ? <DailyGmvChart table={daily} periodTable={period} /> : null;
  const channelChart = channels ? <ChannelSpendChart table={channels} /> : null;
  const notices = table.rows.filter((row) => /^(?:数据说明|花费覆盖|取数时段提示)$/.test(String(row[0] ?? "")));

  return (
    <section
      className={`${styles.reportSection} ${styles.overview}`}
      id="overview"
      data-report-section="报告总览"
      data-track-section="summary"
    >
      <SectionHeading number="01" name="报告总览" total={model.periodLabel || "业务周期"} />
      {table.subtitle ? <p className={styles.sectionNote}>{table.subtitle}</p> : null}
      <div className={styles.productGrid}>
        <ProductCard product={model.subject} role="subject" />
        <ProductCard product={model.competitor} role="competitor" />
      </div>
      {model.kpis.length ? (
        <div className={styles.metricGrid}>
          {model.kpis.map((metric) => (
            <article data-overview-metric={metric.label} key={metric.label}>
              <p>{metric.label}</p>
              <div className={styles.metricPair}>
                <span className={styles.subject}>
                  <small>主体</small>
                  <strong>{formatViewerCell(metric.subject, metric.label)}</strong>
                </span>
                <span className={styles.competitor}>
                  <small>目标对手</small>
                  <strong>{formatViewerCell(metric.competitor, metric.label)}</strong>
                </span>
              </div>
              {!isMissing(metric.scope) ? <small className={styles.metricScope} data-overview-scope>{String(metric.scope)}</small> : null}
            </article>
          ))}
        </div>
      ) : null}
      <div className={styles.periodBand}>
        <span>分析周期</span>
        <strong>{model.startDate || "—"} 至 {model.endDate || "—"}</strong>
      </div>
      {notices.length ? (
        <ul className={styles.dataNotice}>
          {notices.map((row, index) => (
            <li key={`${String(row[0])}-${index}`}>
              <strong>{String(row[0])}</strong>
              {row.slice(1).filter((cell) => !isMissing(cell)).map((cell, cellIndex) => (
                <span key={`${index}-${cellIndex}`}>{String(cell)}</span>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
      {dailyChart || channelChart ? (
        <>
          <h3 className={styles.subheading}>数据趋势与结构</h3>
          <div className={styles.visualGrid}>{dailyChart}{channelChart}</div>
        </>
      ) : null}
    </section>
  );
}

function ProductCard({ product, role }: { product: DmpViewerProduct; role: "subject" | "competitor" }) {
  const label = role === "subject" ? "主体商品" : "目标对手";
  const fallback = (product.title || label).trim().slice(0, 1) || "品";
  const facts = [
    ["30日GMV", product.gmv],
    ["生命周期", product.lifecycle],
    ["价格", product.price]
  ].filter(([, value]) => !isMissing(value));

  return (
    <article className={`${styles.productCard} ${role === "subject" ? styles.subject : styles.competitor}`} data-product-role={role}>
      <div className={styles.productMedia}>
        <span aria-hidden="true">{fallback}</span>
        {product.pictureUrl ? (
          <img
            data-product-image
            src={product.pictureUrl}
            alt={`${product.title || label}主图`}
            loading="eager"
            decoding="async"
            referrerPolicy="no-referrer"
            ref={hideAlreadyBrokenImage}
            onLoad={(event) => { event.currentTarget.hidden = false; }}
            onError={hideBrokenImage}
          />
        ) : null}
      </div>
      <div className={styles.productCopy}>
        <p className={styles.productRole}>{label}</p>
        <h3>{product.detailUrl ? <a href={product.detailUrl} target="_blank" rel="noopener noreferrer">{product.title || "未识别商品标题"}</a> : product.title || "未识别商品标题"}</h3>
        <p className={styles.productId}>商品 ID {product.id || "—"}</p>
        {facts.length ? (
          <dl>{facts.map(([factLabel, value]) => (
            <div key={String(factLabel)}><dt>{factLabel}</dt><dd>{formatViewerCell(value, String(factLabel))}</dd></div>
          ))}</dl>
        ) : null}
        {!isMissing(product.category) ? <p className={styles.productCategory}>{String(product.category)}</p> : null}
      </div>
    </article>
  );
}

function ReportTableSection({
  table,
  index,
  kind,
  tableByName
}: {
  table: DmpViewerTable;
  index: number;
  kind: DmpGrowthReportViewModel["kind"];
  tableByName: Map<string, DmpViewerTable>;
}) {
  const [query, setQuery] = useState("");
  const keyword = query.trim().toLocaleLowerCase("zh-CN");
  const visibleRows = keyword
    ? table.rows.filter((row) => row.some((value) => String(value ?? "").toLocaleLowerCase("zh-CN").includes(keyword)))
    : table.rows;
  const offsets = stickyOffsets(table);
  const dailyPrelude = kind === "growth" && table.name === "日GMV与费比"
    ? <DailySummary periodTable={tableByName.get("周期汇总")} />
    : null;

  return (
    <section
      className={styles.reportSection}
      id={sectionId(table, index)}
      data-report-section={table.name}
      data-track-section={`table:${table.name}`}
    >
      <SectionHeading number={String(index + 1).padStart(2, "0")} name={table.name} total={`${table.rows.length} 行`} />
      {table.subtitle ? <p className={styles.sectionNote}>{table.subtitle}</p> : null}
      {dailyPrelude}
      <div className={styles.tableTools}>
        <label>
          筛选本表
          <input
            type="search"
            value={query}
            data-table-filter={table.name}
            aria-label={`筛选${table.name}`}
            placeholder="输入关键词"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <span>{visibleRows.length} / {table.rows.length}</span>
      </div>
      <div className={styles.tableShell} data-report-table={table.name} data-track={`table-scroll:${index + 1}`}>
        <table>
          <thead>{renderTableHead(table, offsets)}</thead>
          <tbody>
            {visibleRows.map((row, rowIndex) => {
              const currentRowRole = rowRole(row);
              return (
                <tr className={currentRowRole === "subject" ? styles.subjectRow : currentRowRole === "competitor" ? styles.competitorRow : ""} key={rowIndex}>
                  {table.columns.map((column, columnIndex) => {
                    const value = row[columnIndex];
                    const role = columnRole(table, columnIndex);
                    const numeric = isDmpViewerMetricColumn(table, columnIndex) || (typeof value === "number" && Number.isFinite(value));
                    const sticky = offsets[columnIndex] != null;
                    return (
                      <td
                        className={cellClasses({ role, numeric, sticky, wrap: wrapColumn(column), value })}
                        data-numeric={numeric ? "true" : undefined}
                        data-track={`cell:${Math.min(columnIndex, 99)}`}
                        style={cellStyle(table, columnIndex, offsets[columnIndex])}
                        key={`${column}-${columnIndex}`}
                      >
                        <TableCell table={table} row={row} column={column} columnIndex={columnIndex} />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!visibleRows.length ? <div className={styles.empty}>没有匹配的数据</div> : null}
      </div>
    </section>
  );
}

function SectionHeading({ number, name, total }: { number: string; name: string; total: string }) {
  return (
    <div className={styles.sectionHeading}>
      <div><p>{number}</p><h2>{name}</h2></div>
      <span>{total}</span>
    </div>
  );
}

function TableCell({
  table,
  row,
  column,
  columnIndex
}: {
  table: DmpViewerTable;
  row: DmpCell[];
  column: string;
  columnIndex: number;
}) {
  const value = row[columnIndex];
  if (table.name === "商品与成功品" && /图片|详情/.test(column)) {
    const imageUrl = safeViewerImageUrl(value);
    if (imageUrl) return <img className={styles.tableProductImage} data-product-image src={imageUrl} alt="商品主图" loading="lazy" decoding="async" referrerPolicy="no-referrer" ref={hideAlreadyBrokenImage} onLoad={(event) => { event.currentTarget.hidden = false; }} onError={hideBrokenImage} />;
    const detailUrl = safeViewerHttpsUrl(value);
    if (detailUrl) return <a className={styles.detailLink} href={detailUrl} target="_blank" rel="noopener noreferrer">打开详情</a>;
  }
  return <>{formatViewerCell(value, dmpCellSemantic(table.name, table.columns, row, columnIndex))}</>;
}

function renderTableHead(table: DmpViewerTable, offsets: Array<number | undefined>) {
  if (table.groupedChannel && table.columns.length === 5) {
    return (
      <>
        <tr>
          <th className={styles.stickyColumn} data-track="header:0" rowSpan={2} style={cellStyle(table, 0, 0)}>渠道</th>
          <th className={styles.metricGroup} data-track="header:1" colSpan={2}>周期消耗</th>
          <th className={styles.metricGroup} data-track="header:3" colSpan={2}>周期占比</th>
        </tr>
        <tr>{table.columns.slice(1).map((column, offsetIndex) => {
          const columnIndex = offsetIndex + 1;
          const role = columnRole(table, columnIndex);
          return <th className={`${styles.metricHead} ${role === "subject" ? styles.subject : styles.competitor}`} data-track={`header:${columnIndex}`} style={cellStyle(table, columnIndex)} key={column}>{role === "subject" ? "主体" : "目标对手"}</th>;
        })}</tr>
      </>
    );
  }
  return (
    <tr>{table.columns.map((column, columnIndex) => {
      const role = columnRole(table, columnIndex);
      const sticky = offsets[columnIndex] != null;
      return (
        <th
          className={[isDmpViewerMetricColumn(table, columnIndex) ? styles.metricHead : "", sticky ? styles.stickyColumn : "", role === "subject" ? styles.subject : role === "competitor" ? styles.competitor : role === "difference" ? styles.difference : ""].filter(Boolean).join(" ")}
          data-track={`header:${Math.min(columnIndex, 99)}`}
          style={cellStyle(table, columnIndex, offsets[columnIndex])}
          key={`${column}-${columnIndex}`}
        >{column}</th>
      );
    })}</tr>
  );
}

function DailySummary({ periodTable }: { periodTable?: DmpViewerTable }) {
  if (!periodTable) return null;
  const metrics = ["总GMV", "日均GMV", "广告消耗", "费比"].map((label) => ({
    label,
    subject: periodValue(periodTable, "subject", label),
    competitor: periodValue(periodTable, "competitor", label)
  })).filter((metric) => !isMissing(metric.subject) || !isMissing(metric.competitor));
  if (!metrics.length) return null;
  return (
    <div className={styles.dailySummary} aria-label="主体与目标对手周期汇总">
      {metrics.map((metric) => (
        <article key={metric.label}>
          <p>{metric.label}</p>
          <div>
            <span className={styles.subject}><small>主体</small><strong>{formatViewerCell(metric.subject, metric.label)}</strong></span>
            <span className={styles.competitor}><small>目标对手</small><strong>{formatViewerCell(metric.competitor, metric.label)}</strong></span>
          </div>
        </article>
      ))}
    </div>
  );
}

function DailyGmvChart({
  table,
  periodTable
}: {
  table: DmpViewerTable;
  periodTable?: DmpViewerTable;
}) {
  const [tooltip, setTooltip] = useState<ChartTooltipState | null>(null);
  const {
    competitorIndex,
    subjectIndex,
    competitorValues,
    subjectValues,
    subjectAverage
  } = projectDailyGmvChartSeries(table, periodTable);
  if (competitorIndex < 0 || table.rows.length < 2) return null;
  const allValues = [
    ...competitorValues,
    ...subjectValues,
    ...(subjectAverage == null ? [] : [subjectAverage])
  ].filter(isFiniteNumber);
  if (allValues.length < 2) return null;

  const width = 780;
  const height = 290;
  const left = 66;
  const right = 18;
  const top = 22;
  const bottom = 48;
  const maximum = Math.max(...allValues, 1);
  const xFor = (index: number) => left + index * (width - left - right) / Math.max(1, table.rows.length - 1);
  const yFor = (value: number) => top + (1 - value / maximum) * (height - top - bottom);
  const competitorPath = seriesPath(competitorValues, xFor, yFor);
  const subjectPath = subjectValues.length ? seriesPath(subjectValues, xFor, yFor) : "";
  const showsSubjectAverage = !subjectPath && subjectAverage != null;
  const step = table.rows.length >= 20 ? 5 : table.rows.length >= 8 ? 2 : 1;
  const xIndexes: number[] = [];
  for (let index = 0; index < table.rows.length; index += step) xIndexes.push(index);
  if (xIndexes.at(-1) !== table.rows.length - 1) xIndexes.push(table.rows.length - 1);
  const showTooltip = (payload: ChartTooltipPayload, event?: ReactPointerEvent<SVGGElement>) => {
    let x = payload.x;
    let y = payload.y;
    const svg = event?.currentTarget.ownerSVGElement;
    if (event && svg) {
      const bounds = svg.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        x = (event.clientX - bounds.left) * width / bounds.width;
        y = (event.clientY - bounds.top) * height / bounds.height;
      }
    }
    setTooltip({ ...payload, x, y, text: chartTooltipText(payload) });
  };
  const hideTooltip = () => setTooltip(null);
  const subjectAveragePayload: ChartTooltipPayload | null = showsSubjectAverage ? {
    x: (left + width - right) / 2,
    y: yFor(subjectAverage),
    period: `${String(table.rows[0]?.[0] ?? "")} 至 ${String(table.rows.at(-1)?.[0] ?? "")}`,
    metric: "平均日GMV",
    role: "主体",
    formatted: formatViewerCell(subjectAverage, "GMV")
  } : null;

  return (
    <article className={`${styles.visualCard} ${styles.dailyVisual}`} data-chart="daily-gmv">
      <div className={styles.visualTitle}><div><strong>分日 GMV 对比</strong><small>{String(table.rows[0]?.[0] ?? "")} 至 {String(table.rows.at(-1)?.[0] ?? "")}</small></div><span>{table.rows.length} 天</span></div>
      <div className={styles.chartLegend}><span className={styles.legendCompetitor}>目标对手日GMV</span>{subjectPath ? <span className={styles.legendSubject}>主体日GMV</span> : showsSubjectAverage ? <span className={`${styles.legendSubject} ${styles.legendBenchmark}`}>主体日均 {formatViewerCell(subjectAverage, "GMV")}</span> : null}</div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={subjectPath ? "主体与目标对手逐日" : showsSubjectAverage ? "目标对手逐日 · 主体日均基准" : "目标对手逐日"}>
        {[0, .25, .5, .75, 1].map((ratio) => {
          const value = maximum * ratio;
          const y = yFor(value);
          return <g key={ratio}><line x1={left} y1={y} x2={width - right} y2={y} /><text x={left - 10} y={y + 4} textAnchor="end">{axisValue(value)}</text></g>;
        })}
        {xIndexes.map((index, tickIndex) => {
          const date = String(table.rows[index]?.[0] ?? "");
          const anchor = tickIndex === 0 ? "start" : tickIndex === xIndexes.length - 1 ? "end" : "middle";
          const x = xFor(index);
          return <g data-x-tick data-date={date} key={`${date}-${index}`}><line x1={x} y1={height - bottom} x2={x} y2={height - bottom + 5} /><text x={x} y={height - 12} textAnchor={anchor}>{date.slice(5)}</text></g>;
        })}
        <path data-series="competitor" d={competitorPath} className={styles.competitorPath} />
        {seriesPoints(table, competitorValues, "competitor", competitorIndex, xFor, yFor, showTooltip, hideTooltip)}
        {subjectPath ? <><path data-series="subject" d={subjectPath} className={styles.subjectPath} />{seriesPoints(table, subjectValues, "subject", subjectIndex, xFor, yFor, showTooltip, hideTooltip)}</> : null}
        {subjectAveragePayload ? (
          <g
            className={styles.chartPoint}
            data-chart-point="subject-average"
            data-tooltip={chartTooltipText(subjectAveragePayload)}
            data-period={subjectAveragePayload.period}
            data-metric={subjectAveragePayload.metric}
            data-role={subjectAveragePayload.role}
            data-value={subjectAverage}
            tabIndex={0}
            focusable="true"
            role="img"
            aria-label={chartTooltipText(subjectAveragePayload)}
            onPointerEnter={(event) => showTooltip(subjectAveragePayload, event)}
            onPointerMove={(event) => showTooltip(subjectAveragePayload, event)}
            onPointerLeave={(event) => {
              if (document.activeElement !== event.currentTarget) hideTooltip();
            }}
            onFocus={() => showTooltip(subjectAveragePayload)}
            onBlur={hideTooltip}
          >
            <line className={styles.chartLineHit} x1={left} y1={subjectAveragePayload.y} x2={width - right} y2={subjectAveragePayload.y} />
            <line data-series="subject-average" className={styles.subjectBaseline} x1={left} y1={subjectAveragePayload.y} x2={width - right} y2={subjectAveragePayload.y} />
            <title>{chartTooltipText(subjectAveragePayload)}</title>
          </g>
        ) : null}
        <SvgChartTooltip tooltip={tooltip} width={width} height={height} left={left} right={right} top={top} bottom={bottom} />
      </svg>
    </article>
  );
}

function ChannelSpendChart({ table }: { table: DmpViewerTable }) {
  const subjectIndex = table.columns.findIndex((column) => /^主体\d+日消耗$/.test(column));
  const competitorIndex = table.columns.findIndex((column) => /^对手\d+日消耗$/.test(column));
  if (subjectIndex < 0 || competitorIndex < 0) return null;
  const rows = table.rows.filter((row) => row[0] !== "合计" && [row[subjectIndex], row[competitorIndex]].some(hasNonZeroBusinessValue)).slice(0, 5);
  const values = rows.flatMap((row) => [numericValue(row[subjectIndex]), numericValue(row[competitorIndex])]).filter(isFiniteNumber);
  if (!values.length) return null;
  const maximum = Math.max(...values, 1);
  return (
    <article className={styles.visualCard} data-chart="channel-spend">
      <div className={styles.visualTitle}><div><strong>渠道花费对比</strong><small>主体与目标对手</small></div><span>{rows.length} 个有效渠道</span></div>
      <div className={styles.channelBars}>
        {rows.map((row) => {
          const subject = numericValue(row[subjectIndex]) ?? 0;
          const competitor = numericValue(row[competitorIndex]) ?? 0;
          return (
            <div className={styles.barRow} key={String(row[0])}>
              <strong>{String(row[0])}</strong>
              <div className={styles.barPair}>
                <div><span>主体</span><i><b className={styles.barSubject} style={{ width: `${Math.max(0, Math.min(100, subject / maximum * 100))}%` }} /></i><em>{formatViewerCell(row[subjectIndex], table.columns[subjectIndex])}</em></div>
                <div><span>对手</span><i><b className={styles.barCompetitor} style={{ width: `${Math.max(0, Math.min(100, competitor / maximum * 100))}%` }} /></i><em>{formatViewerCell(row[competitorIndex], table.columns[competitorIndex])}</em></div>
              </div>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function seriesPoints(
  table: DmpViewerTable,
  values: Array<number | null>,
  series: "subject" | "competitor",
  valueIndex: number,
  xFor: (index: number) => number,
  yFor: (value: number) => number,
  showTooltip: (payload: ChartTooltipPayload, event?: ReactPointerEvent<SVGGElement>) => void,
  hideTooltip: () => void
) {
  return values.map((value, index) => {
    if (value == null) return null;
    const payload: ChartTooltipPayload = {
      x: xFor(index),
      y: yFor(value),
      period: String(table.rows[index]?.[0] ?? ""),
      metric: "日GMV",
      role: series === "subject" ? "主体" : "目标对手",
      formatted: formatViewerCell(table.rows[index]?.[valueIndex], "GMV")
    };
    const tooltip = chartTooltipText(payload);
    return (
      <g
        className={styles.chartPoint}
        data-chart-point={series}
        data-tooltip={tooltip}
        data-period={payload.period}
        data-metric={payload.metric}
        data-role={payload.role}
        data-value={value}
        tabIndex={0}
        focusable="true"
        role="img"
        aria-label={tooltip}
        onPointerEnter={(event) => showTooltip(payload, event)}
        onPointerMove={(event) => showTooltip(payload, event)}
        onPointerLeave={(event) => {
          if (document.activeElement !== event.currentTarget) hideTooltip();
        }}
        onFocus={() => showTooltip(payload)}
        onBlur={hideTooltip}
        key={`${series}-${index}`}
      >
        <circle className={styles.chartPointHit} cx={payload.x} cy={payload.y} r="10" />
        <circle
          data-series-point={series}
          data-date={payload.period}
          data-value={value}
          className={`${styles.chartPointVisible} ${series === "subject" ? styles.subjectPoint : styles.competitorPoint}`}
          cx={payload.x}
          cy={payload.y}
          r="3"
        />
        <title>{tooltip}</title>
      </g>
    );
  });
}

function chartTooltipText(payload: ChartTooltipPayload) {
  return `${payload.period}｜${payload.metric}｜${payload.role}：${payload.formatted}`;
}

function SvgChartTooltip({
  tooltip,
  width,
  height,
  left,
  right,
  top,
  bottom
}: {
  tooltip: ChartTooltipState | null;
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}) {
  if (!tooltip) return null;
  const heading = `${tooltip.period}｜${tooltip.metric}｜${tooltip.role}`;
  const tooltipWidth = Math.min(360, Math.max(180, Math.max(Array.from(heading).length * 7.2, Array.from(tooltip.formatted).length * 8) + 24));
  const tooltipHeight = 48;
  const preferredX = tooltip.x + 12 + tooltipWidth <= width - right ? tooltip.x + 12 : tooltip.x - tooltipWidth - 12;
  const preferredY = tooltip.y - tooltipHeight - 10 >= top ? tooltip.y - tooltipHeight - 10 : tooltip.y + 10;
  const x = Math.max(left, Math.min(preferredX, width - right - tooltipWidth));
  const y = Math.max(top, Math.min(preferredY, height - bottom - tooltipHeight));
  return (
    <g
      className={styles.svgTooltip}
      data-chart-tooltip="svg"
      role="status"
      aria-live="polite"
      transform={`translate(${x} ${y})`}
      pointerEvents="none"
    >
      <rect width={tooltipWidth} height={tooltipHeight} rx="7" />
      <text className={styles.svgTooltipText} x="12" y="18">
        <tspan>{heading}</tspan>
        <tspan className={styles.svgTooltipValue} x="12" dy="18">{tooltip.formatted}</tspan>
      </text>
    </g>
  );
}

function cellClasses({
  role,
  numeric,
  sticky,
  wrap,
  value
}: {
  role: "subject" | "competitor" | "difference" | "";
  numeric: boolean;
  sticky: boolean;
  wrap: boolean;
  value: DmpCell;
}) {
  const trend = role === "difference" ? differenceTrend(value) : "";
  return [
    numeric ? styles.numeric : "",
    sticky ? styles.stickyColumn : "",
    wrap ? styles.wrap : "",
    role === "subject" ? styles.subject : role === "competitor" ? styles.competitor : role === "difference" ? styles.difference : "",
    trend === "up" ? styles.trendUp : "",
    trend === "down" ? styles.trendDown : ""
  ].filter(Boolean).join(" ");
}

function cellStyle(table: DmpViewerTable, columnIndex: number, stickyLeft?: number): CellStyle {
  const width = columnWidth(table, columnIndex);
  return {
    "--dmp-column-width": `${width}px`,
    ...(stickyLeft == null ? {} : { "--dmp-sticky-left": `${stickyLeft}px` })
  };
}

function stickyOffsets(table: DmpViewerTable) {
  const count = Math.max(0, DMP_GROWTH_FREEZE_COLUMNS[table.name] ?? 0);
  const offsets: Array<number | undefined> = [];
  let left = 0;
  for (let index = 0; index < count; index += 1) {
    offsets[index] = left;
    left += columnWidth(table, index);
  }
  return offsets;
}

function columnWidth(table: DmpViewerTable, index: number) {
  const declaredWidth = Number((table as DmpViewerTable & { widths?: number[] }).widths?.[index]);
  if (Number.isFinite(declaredWidth) && declaredWidth > 0) {
    return Math.max(88, Math.min(460, Math.round(declaredWidth * 6.6)));
  }
  const column = table.columns[index] ?? "";
  if (/商品标题|描述|执行细节|运营动作/.test(column)) return 300;
  if (/广告打法|类目|成功品描述/.test(column)) return 250;
  if (/图片|详情/.test(column)) return 108;
  if (/商品ID|场景编号/.test(column)) return 144;
  if (/日期|开始|结束/.test(column)) return 118;
  if (/一级场景|二级场景|关键词|词类型/.test(column)) return 168;
  if (/对象|角色|渠道|层级|阶段/.test(column)) return 112;
  return isDmpViewerMetricColumn(table, index) ? 132 : 138;
}

function columnRole(table: DmpViewerTable, index: number): "subject" | "competitor" | "difference" | "" {
  const column = table.columns[index] ?? "";
  if (table.name === "对标总表") return index === 2 ? "subject" : index === 3 ? "competitor" : index === 4 ? "difference" : "";
  if (table.name === "基础指标对比") return index === 1 ? "subject" : index === 2 ? "competitor" : index === 3 ? "difference" : "";
  if (/^主体/.test(column)) return "subject";
  if (/^(对手|目标对手)/.test(column)) return "competitor";
  if (/相对对手/.test(column)) return "difference";
  return "";
}

function rowRole(row: DmpCell[]): "subject" | "competitor" | "" {
  const first = String(row[0] ?? "");
  const second = String(row[1] ?? "");
  if (/^主体/.test(first) || /^主体/.test(second)) return "subject";
  if (/目标对手|^对手|^竞品/.test(first) || /目标对手|^对手/.test(second)) return "competitor";
  return "";
}

function wrapColumn(column: string) {
  return /标题|描述|打法|细节|动作|标签|图片|详情|指导/.test(column);
}

function periodValue(table: DmpViewerTable, role: "subject" | "competitor", column: string) {
  const index = table.columns.indexOf(column);
  const row = table.rows.find((candidate) => role === "subject"
    ? /主体/.test(String(candidate[1] ?? ""))
    : /目标对手|对手|竞品/.test(String(candidate[1] ?? "")));
  return index >= 0 ? row?.[index] ?? "" : "";
}

function formatViewerCell(value: DmpCell, semantic = "") {
  const formatted = formatDmpCell(value, semantic);
  if (/商品ID|sceneId|场景编号|关键词ID/i.test(semantic)) return formatted;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(formatted)) {
    const numeric = Number(formatted);
    if (!Number.isFinite(numeric)) return formatted;
    const integer = /天数|层级|成交笔数|展现|点击|访客|数量/i.test(semantic);
    return new Intl.NumberFormat("zh-CN", {
      minimumFractionDigits: integer ? 0 : 0,
      maximumFractionDigits: integer ? 0 : 2
    }).format(numeric);
  }
  return formatted;
}

function formatGeneratedAt(value: string) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai"
  }).format(date).replaceAll("/", "-");
}

function sectionId(table: DmpViewerTable, index: number) {
  return DMP_GROWTH_SECTION_IDS[table.name] ?? `dmp-report-section-${index + 1}`;
}

function seriesPath(values: Array<number | null>, xFor: (index: number) => number, yFor: (value: number) => number) {
  let drawing = false;
  return values.map((value, index) => {
    if (value == null) { drawing = false; return ""; }
    const command = drawing ? "L" : "M";
    drawing = true;
    return `${command}${xFor(index).toFixed(1)} ${yFor(value).toFixed(1)}`;
  }).filter(Boolean).join(" ");
}

function axisValue(value: number) {
  if (Math.abs(value) >= 100_000_000) return `${(value / 100_000_000).toFixed(value % 100_000_000 ? 1 : 0)}亿`;
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toFixed(value % 10_000 ? 1 : 0)}万`;
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
}

function numericValue(value: DmpCell): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value ?? "").trim().replaceAll(",", "");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

function differenceTrend(value: DmpCell): "up" | "down" | "" {
  if (typeof value === "number") return value > 0 ? "up" : value < 0 ? "down" : "";
  const text = String(value ?? "").trim().replaceAll(",", "");
  if (!text || text === "—") return "";
  const matches = text.match(/[+-]?\d+(?:\.\d+)?/g);
  if (!matches?.length) return "";
  const values = matches.map(Number).filter(Number.isFinite);
  if (!values.length || values.every((entry) => entry === 0)) return "";
  if (/下降|减少|下滑|低于|落后/.test(text) && values.some((entry) => entry > 0)) return "down";
  if (/上升|增加|增长|提升|高于|领先/.test(text) && values.some((entry) => entry > 0)) return "up";
  if (values.every((entry) => entry >= 0)) return "up";
  if (values.every((entry) => entry <= 0)) return "down";
  return "";
}

function hideAlreadyBrokenImage(image: HTMLImageElement | null) {
  if (image?.complete && image.naturalWidth === 0) image.hidden = true;
}

function hideBrokenImage(event: { currentTarget: HTMLImageElement }) {
  event.currentTarget.hidden = true;
}

function isFiniteNumber(value: number | null): value is number {
  return value != null && Number.isFinite(value);
}

function hasNonZeroBusinessValue(value: DmpCell) {
  const numeric = numericValue(value);
  if (numeric != null) return Math.abs(numeric) > 1e-12;
  const text = String(value ?? "").trim();
  return Boolean(text && text !== "—" && !/^[+-]?0(?:\.0+)?(?:%|万|亿|元|次|笔)?$/.test(text));
}

function isMissing(value: DmpCell) {
  return value == null || value === "" || value === "—";
}
