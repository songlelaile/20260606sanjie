"use client";

/* 商品主图来自达摩盘返回的动态 HTTPS 地址，不能使用需要预配置远端域名的 next/image。 */
/* eslint-disable @next/next/no-img-element */

import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Fragment, useMemo, useState } from "react";
import { dmpCellSemantic, formatDmpCell } from "@/lib/dmp-report-format";
import type { DmpCell } from "@/lib/dmp-report-import";
import type { DmpBusinessReportRecord } from "@/lib/dmp-report-types";
import {
  DMP_GROWTH_FREEZE_COLUMNS,
  DMP_GROWTH_SECTION_IDS,
  isDmpViewerMetricColumn,
  projectDailyGmvChartSeries,
  abbreviateShopName,
  hideShopSampleWording,
  projectDmpReportForViewer,
  safeViewerHttpsUrl,
  safeViewerImageUrl,
  type DmpGrowthReportViewModel,
  type DmpShopKpiCard,
  type DmpShopNote,
  type DmpShopObjectGroup,
  type DmpShopView,
  type DmpViewerProduct,
  type DmpViewerTable
} from "@/components/tools/DmpGrowthReportViewModel";
import styles from "./DmpGrowthReportViewer.module.css";
import { filterShopAttribution, hasShopAttributionTables, shopAttributionAvailability, type ShopAttributionSelection } from "./DmpShopAttribution";

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
  const sourceModel = useMemo(() => projectDmpReportForViewer(record), [record]);
  const [scopeSelection, setScopeSelection] = useState<{ reportId: string; value: ShopAttributionSelection }>({ reportId: record.id, value: "all" });
  const attribution = scopeSelection.reportId === record.id ? scopeSelection.value : "all";
  const shopAttribution = sourceModel.kind === "competition" && hasShopAttributionTables(sourceModel.tables);
  const availability = useMemo(() => shopAttributionAvailability(sourceModel.tables), [sourceModel.tables]);
  const model = useMemo(() => shopAttribution
    ? { ...sourceModel, tables: filterShopAttribution(sourceModel.tables, attribution) }
    : sourceModel, [sourceModel, shopAttribution, attribution]);
  const tableByName = useMemo(() => new Map(model.tables.map((table) => [table.name, table])), [model.tables]);
  const displayTitle = model.kind === "growth"
    ? "达摩盘商品成长竞品对标报告｜少壮AI自动化"
    : "店铺对标分析报告｜少壮AI自动化";
  const shopShorts = model.kind === "competition"
    ? (model.shopObjects ?? []).map((object) => abbreviateShopName(object.name)).filter(Boolean)
    : [];
  const shopVersus = shopShorts.length >= 2 ? shopShorts.join(" VS ") : "";

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
        <p className={styles.eyebrow}>{model.kind === "growth" ? "DAMOPAN · GROWTH BENCHMARK" : "DAMOPAN · SHOP BENCHMARK"}</p>
        <h1>{shopVersus || displayTitle}</h1>
        <div className={styles.heroMeta}>
          {shopVersus ? <span>{displayTitle}</span> : null}
          {model.kind === "growth" && record.shopName ? <span data-report-shop-signature>店铺署名：{record.shopName}</span> : null}
          {model.kind === "growth" ? <span>主体：{model.subject.title || model.subjectId || "—"}{model.subjectId ? `（${model.subjectId}）` : ""}</span> : null}
          {model.kind === "growth" ? <span>目标对手：{model.competitor.title || model.competitorId || "—"}{model.competitor.title && model.competitorId ? `（${model.competitorId}）` : ""}</span> : null}
          {model.kind !== "growth" ? (model.shopObjects ?? []).map((object) => <span key={`${object.role}-${object.id}`}>{abbreviateShopName(object.name) || object.label} {object.id}</span>) : null}
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
            <a data-track={`nav:${index + 1}`} key={table.name} href={`#${sectionId(table, index)}`}>{shopDisplayText(table.name)}</a>
          ))}
        </nav>
      </div>

      <main className={styles.main}>
        {shopAttribution ? <div className={styles.attributionControls}>
          <label>渠道归因范围
            <select aria-label="渠道归因范围" value={attribution} onChange={event => {
              const value = event.target.value;
              if (value === "all" || value === "1" || value === "2") setScopeSelection({ reportId: record.id, value });
            }}>
              <option value="all">全部归因</option>
              <option value="2">广告域归因</option>
              <option value="1">全域归因</option>
            </select>
          </label>
          <p>切换仅影响渠道表现及对标表中的渠道数据，其他模块保留原口径。</p>
          <div aria-live="polite">{availability.map(scope => <span key={scope.scale}>
            {scope.label}：{scope.status}（本期 {scope.currentRows} 项，上期 {scope.previousRows} 项）
          </span>)}</div>
        </div> : null}
        {model.shopObjects?.length ? <div className={styles.shopObjects} data-shop-objects>
          {model.shopObjects.map((object) => <article className={`${styles.shopObjectCard} ${roleClass(object.role)}`} data-shop-object={object.role} key={`${object.role}-${object.id}`}><span>{abbreviateShopName(object.name) || object.label}</span><strong>{object.name || "—"}</strong><small>ID {object.id}</small></article>)}
        </div> : null}
        {shopLayoutTables(model).map((entry, index) => {
          const number = String(index + 1).padStart(2, "0");
          const code = (value: string) => sectionNumber(model, value, index);
          if (entry.kind === "kpi") return <ShopKpiSection key="shop-kpi" cards={entry.cards} number={code("01")} />;
          if (entry.kind === "spend") return <ShopSpendSection key="shop-spend" view={entry.view} number="02" />;
          if (entry.kind === "channels") return <ShopChannelSection key="shop-channels" view={entry.view} number="03" />;
          if (entry.kind === "traffic") return <ShopTrafficSection key="shop-traffic" view={entry.view} number="04" />;
          if (entry.kind === "samples") return <ShopSampleSection key="shop-samples" view={entry.view} number="05" />;
          if (entry.kind === "daily") return <ShopDailySection key="shop-daily" view={entry.view} number="06" />;
          if (entry.kind === "notes") return <ShopNotesSection key="shop-notes" notes={entry.notes} number={entry.view?.daily.dates.length ? "07" : "06"} />;
          if (entry.kind !== "table") return null;
          const table = entry.table;
          if (table.name === "报告总览" && model.kind === "growth") return <GrowthOverview key={table.name} model={model} tableByName={tableByName} />;
          if (table.shopLayout || table.layoutRole) return <ShopCompetitionSection key={`${table.name}-${index}`} table={table} index={index} numberOverride={model.shopView ? (table.layoutRole === "overview" ? "00" : "全") : undefined} />;
          return <ReportTableSection key={`${table.name}-${index}`} table={table} index={index} kind={model.kind} tableByName={tableByName} />;
        })}
      </main>

      <footer className={styles.footer}>{shopVersus ? `${shopVersus} · ` : (record.shopName ? `${record.shopName} · ` : "")}{displayTitle}</footer>
    </article>
  );
}

function GrowthOverview({
  model,
  tableByName
}: {
  model: DmpGrowthReportViewModel;
  tableByName: Map<string, DmpViewerTable>;
}) {
  const daily = tableByName.get("日GMV与费比");
  const period = tableByName.get("周期汇总");
  const channels = tableByName.get("渠道花费");
  const dailyChart = daily ? <DailyGmvChart table={daily} periodTable={period} /> : null;
  const channelChart = channels ? <ChannelSpendChart table={channels} /> : null;

  return (
    <section
      className={`${styles.reportSection} ${styles.overview}`}
      id="overview"
      data-report-section="报告总览"
      data-track-section="summary"
    >
      <SectionHeading number="01" name="报告总览" total={model.periodLabel || "业务周期"} />
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
            </article>
          ))}
        </div>
      ) : null}
      <div className={styles.periodBand}>
        <span>分析周期</span>
        <strong>{model.startDate || "—"} 至 {model.endDate || "—"}</strong>
      </div>
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
      {dailyPrelude}
      <div className={styles.tableTools}>
        <label>
          筛选本表
          <input
            type="search"
            value={query}
            data-table-filter={table.name}
            aria-label={`筛选${shopDisplayText(table.name)}`}
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

/** Display-only: hide the data-source prefix「店铺竞争态势·」and sample wording. */
export function shopDisplayText(text: string): string {
  return hideShopSampleWording(String(text ?? "").replace(/店铺竞争态势[·・]?/g, ""));
}

function SectionHeading({ number, name, total }: { number: string; name: string; total: string }) {
  return (
    <div className={styles.sectionHeading}>
      <div><p>{number}</p><h2>{shopDisplayText(name)}</h2></div>
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
  return <>{shopDisplayText(formatViewerCell(value, dmpCellSemantic(table.name, table.columns, row, columnIndex)))}</>;
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

// ---- v2.3.100 shop competition layout (R6) + v2.3.103 seven-block order (R14) ---------------
type ShopLayoutEntry =
  | { kind: "kpi"; cards: DmpShopKpiCard[] }
  | { kind: "spend"; view: DmpShopView }
  | { kind: "channels"; view: DmpShopView }
  | { kind: "traffic"; view: DmpShopView }
  | { kind: "samples"; view: DmpShopView }
  | { kind: "daily"; view: DmpShopView }
  | { kind: "notes"; notes: DmpShopNote[]; view?: DmpShopView }
  | { kind: "table"; table: DmpViewerTable };

/** v2.3.103: canonical shop tables folded to the very end (对标总表 / 渠道表现全表 最后). */
const SHOP_ARCHIVE_ORDER = [
  "周期汇总",
  "店铺竞争态势·推广表现",
  "店铺竞争态势·经营表现",
  "店铺竞争态势·对标比例",
  "店铺竞争态势·付费与免费流量",
  "店铺竞争态势·投放结构",
  "店铺竞争态势·购买新老客结构",
  "店铺竞争态势·逐日趋势",
  "对标总表",
  "店铺竞争态势·渠道表现"
];

function sectionNumber(model: DmpGrowthReportViewModel, code: string, index: number) {
  return model.shopView ? code : String(index + 1).padStart(2, "0");
}

function shopLayoutTables(model: DmpGrowthReportViewModel): ShopLayoutEntry[] {
  const isShop = Boolean(model.shopObjects?.length || model.tables.some((table) => table.shopLayout));
  if (!isShop) return model.tables.map((table) => ({ kind: "table", table }));
  const byName = new Map(model.tables.map((table) => [table.name, table]));
  const view = model.shopView;
  if (!view) {
    // Legacy v2.3.100 (R6) three-tier fallback: keep the previous behaviour when the
    // seven-block model could not be derived.
    const entries: ShopLayoutEntry[] = [];
    for (const table of model.tables) {
      if (table.layoutRole === "core" && model.shopKpis?.length) entries.push({ kind: "kpi", cards: model.shopKpis });
      if (table.layoutRole === "benchmark" && model.shopNotes?.length) entries.push({ kind: "notes", notes: model.shopNotes.map((text) => ({ kind: "说明" as const, text })) });
      entries.push({ kind: "table", table });
    }
    if (!entries.some((entry) => entry.kind === "kpi") && model.shopKpis?.length) entries.splice(1, 0, { kind: "kpi", cards: model.shopKpis });
    if (!entries.some((entry) => entry.kind === "notes") && model.shopNotes?.length) entries.push({ kind: "notes", notes: model.shopNotes.map((text) => ({ kind: "说明" as const, text })) });
    return entries;
  }
  const entries: ShopLayoutEntry[] = [];
  const overview = byName.get("报告总览");
  if (overview) entries.push({ kind: "table", table: { ...overview, layoutRole: "overview" } });
  entries.push({ kind: "kpi", cards: view.kpis });
  entries.push({ kind: "spend", view });
  entries.push({ kind: "channels", view });
  entries.push({ kind: "traffic", view });
  entries.push({ kind: "samples", view });
  if (view.daily.dates.length) entries.push({ kind: "daily", view });
  entries.push({ kind: "notes", notes: view.notes, view });
  for (const name of SHOP_ARCHIVE_ORDER) {
    const table = byName.get(name);
    if (!table) continue;
    entries.push({ kind: "table", table: { ...table, layoutRole: name === "对标总表" ? "benchmark" : "archive" } });
  }
  const known = new Set([...SHOP_ARCHIVE_ORDER, "报告总览", "店铺竞争态势·单品样本"]);
  for (const table of model.tables) if (!known.has(table.name)) entries.push({ kind: "table", table });
  return entries;
}

function roleClass(role: DmpShopObjectGroup["role"] | "") {
  if (role === "subject") return styles.subject;
  if (role === "competitor-1") return `${styles.competitor} ${styles.competitor1}`;
  if (role === "competitor-2") return `${styles.competitor} ${styles.competitor2}`;
  if (role === "competitor-3") return `${styles.competitor} ${styles.competitor3}`;
  return "";
}

const PRECISION_KIND: Record<string, string> = { 平台精确: "exact", 平台区间: "interval", 方向值: "text", 样本加权约值: "sample", 公式: "formula" };
function PrecisionBadge({ label }: { label: string }) {
  const kind = PRECISION_KIND[label] ?? "missing";
  if (kind === "sample") return null; // 2026-09-18 user direction: do not surface「样本加权」wording
  return <span className={`${styles.badge} ${styles[`badge_${kind}`] ?? ""}`} data-precision={kind}>{label || "—"}</span>;
}

const DIRECTION_TEXT = /^(?:比(?:本店|本品|主体|竞店|竞品)[^\r\n]{0,30}(?:高|低)|高于本(?:店|品)|低于本(?:店|品)|持平|上升|下降|无变化|数据不足|数据量过小|隐私保护|未展示)$/;
function shopTrend(value: DmpCell): "up" | "down" | "" {
  if (typeof value === "number") return value > 0 ? "up" : value < 0 ? "down" : "";
  const text = String(value ?? "").trim();
  if (!text || text === "—") return "";
  if (DIRECTION_TEXT.test(text)) return /高|上升/.test(text) ? "up" : /低|下降/.test(text) ? "down" : "";
  const lower = text.replace(/^(约|≈)\s*/, "").split(/\s*(?:~|～|至)\s*/)[0].replace(/^[<>]/, "").replace(/,/g, "");
  const match = lower.match(/^([+-]?)(\d+(?:\.\d+)?|\.\d+)/);
  if (!match) return "";
  const numeric = Number(`${match[1]}${match[2]}`);
  return numeric > 0 ? "up" : numeric < 0 ? "down" : "";
}
function isNoteCell(value: DmpCell) {
  if (typeof value === "number") return false;
  const text = String(value ?? "").trim();
  if (!text || text === "—" || DIRECTION_TEXT.test(text)) return false;
  const token = "[<>]?[+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?\\s*(?:千|万|亿|%|个百分点|元|倍)?";
  return !new RegExp(`^[约≈]?\\s*${token}(?:\\s*(?:~|～|至)\\s*${token})?$`).test(text);
}

/** 01 全店经营 KPI：8 卡（含派生的全店费比）。 */
function ShopKpiSection({ cards, number }: { cards: DmpShopKpiCard[]; number: string }) {
  return (
    <section className={`${styles.reportSection} ${styles.kpiSection}`} id="shop-kpi" data-report-section="经营总览" data-shop-block="01" data-track-section="shop-kpi">
      <SectionHeading number={number} name="全店经营 KPI" total={`${cards.length} 项`} />
      <p className={styles.sectionNote}>每张卡：本店 / 竞店 / 相对差；右上角为精度徽标。全店费比为派生公式值，标「公式」。</p>
      <div className={styles.kpiGrid}>
        {cards.map((card) => (
          <article className={styles.kpiCard} data-kpi={card.metric} data-kpi-derived={card.derived ? "true" : undefined} key={card.metric}>
            <h3>{card.title}{card.derived ? <span className={styles.derivedFlag}>公式</span> : null}</h3>
            {card.values.map((entry) => (
              <div className={`${styles.kpiRow} ${roleClass(entry.role)}`} key={entry.role}>
                <span className={styles.kpiLabel}>{entry.label}</span>
                <strong className={styles.kpiValue}>{card.derived
                  ? String(entry.current ?? "") || "—"
                  : isMissingCell(entry.current) ? "—" : formatViewerCell(entry.current, card.metric)}</strong>
                <span className={`${styles.kpiChange} ${shopTrend(entry.change) === "up" ? styles.trendUp : shopTrend(entry.change) === "down" ? styles.trendDown : ""}`}>{card.derived || isNoteCell(entry.change) || isMissingCell(entry.change) ? "" : formatViewerCell(entry.change, `${card.metric} 变化`)}</span>
                <PrecisionBadge label={entry.precision} />
              </div>
            ))}
            {card.derivedNote ? <p className={styles.kpiDerivedNote}>{card.derivedNote}</p> : null}
            {card.relative.some((entry) => !isMissingCell(entry.value)) ? <div className={styles.kpiRelative}>
              {card.relative.filter((entry) => !isMissingCell(entry.value)).map((entry) => <span className={`${styles.pill} ${shopTrend(entry.value) === "up" ? styles.trendUp : shopTrend(entry.value) === "down" ? styles.trendDown : ""}`} key={entry.role}>相对{entry.label} {String(entry.value)}</span>)}
            </div> : null}
          </article>
        ))}
      </div>
    </section>
  );
}

/** 03 全店渠道花费。 */
function ShopSpendSection({ view, number }: { view: DmpShopView; number: string }) {
  const block = view.blocks.find((entry) => entry.code === "03");
  const objects = view.objects;
  return (
    <section className={styles.reportSection} id="shop-spend" data-report-section="全店渠道花费" data-shop-block="03" data-track-section="shop-spend">
      <SectionHeading number={number} name={block?.title ?? "全店渠道花费"} total={`${view.spend.rows.length} 个渠道`} />
      <p className={styles.sectionNote}>{block?.note}</p>
      <div className={`${styles.tableShell} ${styles.shopTable}`}>
        <table>
          <thead>
            <tr>
              <th>渠道</th>
              {objects.map((object) => (
                <Fragment key={object.role}>
                  <th className={`${styles.entityHead} ${roleClass(object.role)}`}>{object.label}占比</th>
                  <th className={`${styles.entityHead} ${roleClass(object.role)}`}>{object.label}消耗</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.spend.rows.map((row) => (
              <tr key={row.channel}>
                <td>{row.channel}</td>
                {row.values.map((value) => (
                  <Fragment key={value.role}>
                    <td className={`${styles.numeric} ${roleClass(value.role)}`}>{value.share}</td>
                    <td className={`${styles.numeric} ${roleClass(value.role)}`}>{value.spend}</td>
                  </Fragment>
                ))}
              </tr>
            ))}
            <tr className={styles.totalRow}>
              <td><b>合计</b></td>
              {view.spend.totals.map((value) => (
                <Fragment key={value.role}>
                  <td className={styles.numeric}>100%</td>
                  <td className={styles.numeric}><b>{value.spend}</b> <PrecisionBadge label={value.precision} /></td>
                </Fragment>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <div className={styles.grid2}>
        <div>
          <h4 className={styles.subTitle}>投放成本结构（占比）</h4>
          {objects.map((object) => {
            const row = view.spend.rows.map((entry) => ({
              channel: entry.channel,
              value: entry.values.find((candidate) => candidate.role === object.role)
            })).filter((entry) => entry.value && entry.value.share !== "—" && entry.value.shareWidth > 0);
            return (
              <div className={styles.bar} key={object.role}>
                <span className={styles.barName}>{object.label}</span>
                <div className={styles.barTrack}>
                  <div className={styles.stack}>
                    {row.map((entry, index) => <span
                      className={index % 2 === 0 ? styles.stackSegment : styles.stackSegmentAlt}
                      style={{ width: `${entry.value!.shareWidth}%` }}
                      key={entry.channel}
                    >{entry.value!.shareWidth >= 12 ? `${entry.channel} ${entry.value!.share}` : ""}</span>)}
                  </div>
                </div>
                <span className={styles.barValue}>{row.map((entry) => `${entry.channel} ${entry.value!.share}`).join(" · ") || "—"}</span>
              </div>
            );
          })}
        </div>
        <div>
          <h4 className={styles.subTitle}>上期 → 本期 结构变化（占比变化 pp）</h4>
          {objects.map((object) => (
            <div key={object.role}>
              <div className={`${styles.barObject} ${roleClass(object.role)}`}>{object.label}</div>
              {view.spend.rows.map((row) => {
                const value = row.values.find((candidate) => candidate.role === object.role);
                if (!value || value.share === "—" || value.shareWidth <= 0) return null;
                return (
                  <div className={styles.bar} key={`${object.role}-${row.channel}`}>
                    <span className={styles.barName}>{row.channel}</span>
                    <div className={styles.barTrack}>
                      <i className={roleClass(object.role)} style={{ width: `${Math.min(100, value.shareWidth)}%` }} />
                    </div>
                    <span className={styles.barValue}>{value.sharePrevious} → {value.share} <b className={value.trend === "up" ? styles.trendUp : value.trend === "down" ? styles.trendDown : ""}>{value.pp}</b></span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <ul className={styles.notes}>{view.spend.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
    </section>
  );
}

const SHOP_CHANNEL_METRIC_LABELS = ["成交笔数", "点击量", "支付转化率", "直接投产比"];

/** 04 渠道表现对标（一级默认展开、二级 <details> 折叠；全域附本店成交结构条）。 */
function ShopChannelSection({ view, number }: { view: DmpShopView; number: string }) {
  const block = view.blocks.find((entry) => entry.code === "04");
  const channelRows = (rows: DmpShopView["channelGroups"][number]["rows"]) => (
    <table>
      <thead>
        <tr>
          <th>渠道</th>
          {SHOP_CHANNEL_METRIC_LABELS.map((label) => <th key={label}>{label}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.channel}>
            <td>{row.channel}</td>
            {row.metrics.map((metric) => (
              <td className={styles.channelCell} key={metric.metric} data-metric={metric.metric}>
                {metric.values.map((value) => (
                  <span className={`${styles.who} ${roleClass(value.role)}`} data-shop-object-cell={value.role} key={value.role}>
                    {value.display}
                  </span>
                ))}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <section className={styles.reportSection} id="shop-channels" data-report-section="渠道表现对标" data-shop-block="04" data-track-section="shop-channels">
      <SectionHeading number={number} name={block?.title ?? "渠道表现对标"} total={`${view.channelGroups.length} 组归因`} />
      <p className={styles.sectionNote}>{block?.note}</p>
      <div className={styles.grid2}>
        {view.channelGroups.map((group) => (
          <div key={group.attribution} data-channel-group={group.attribution}>
            <h4 className={styles.subTitle}>{group.label}</h4>
            <div className={`${styles.tableShell} ${styles.shopTable}`}>{channelRows(group.rows)}</div>
            {group.rows.map((row) => (
              row.subs.length ? <details className={styles.subChannelFold} key={`fold-${row.channel}`}>
                <summary>二级渠道 · {row.channel}（{row.subs.length} 项）</summary>
                <div className={`${styles.tableShell} ${styles.shopTable} ${styles.subChannelTable}`}>{channelRows(row.subs)}</div>
              </details> : null
            ))}
            {group.structure.length ? <div className={styles.structureBlock}>
              <h4 className={styles.subTitle}>{group.label} · 本店成交笔数结构</h4>
              {group.structure.map((bar) => (
                <div className={styles.bar} key={`${group.attribution}-${bar.channel}`}>
                  <span className={styles.barName}>{bar.label}</span>
                  <div className={styles.barTrack}><i className={styles.barSelf} style={{ width: `${bar.width}%` }} /></div>
                  <span className={styles.barValue}>{bar.detail}</span>
                </div>
              ))}
              <ul className={styles.notes}><li>{group.structureNote}</li></ul>
            </div> : null}
            {group.notes.length ? <ul className={styles.notes}>{group.notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

/** 05 付费 / 免费流量结构 + 新老客。 */
function ShopTrafficSection({ view, number }: { view: DmpShopView; number: string }) {
  const block = view.blocks.find((entry) => entry.code === "05");
  const traffic = view.traffic;
  const segmentClass = (index: number) => [styles.stackSegment, styles.stackSegmentAlt, styles.stackSegmentSoft, styles.stackSegmentSofter][index % 4];
  return (
    <section className={styles.reportSection} id="shop-traffic" data-report-section="流量结构与新老客" data-shop-block="05" data-track-section="shop-traffic">
      <SectionHeading number={number} name={block?.title ?? "付费 / 免费流量结构 + 新老客"} total={`${view.objects.length} 个对象`} />
      <p className={styles.sectionNote}>{block?.note}</p>
      <div className={styles.grid2}>
        <div>
          <h4 className={styles.subTitle}>流量占比</h4>
          {traffic.stacks.map((stack) => (
            <div className={styles.bar} key={stack.role} data-traffic-object={stack.role}>
              <span className={styles.barName}>{stack.label}</span>
              <div className={styles.barTrack}>
                <div className={styles.stack}>
                  {stack.bars.filter((bar) => bar.width > 0).map((bar, index) => (
                    <span key={bar.channel} className={segmentClass(index)} style={{ width: `${bar.width}%` }}>{bar.width >= 12 ? `${bar.channel} ${bar.share}` : ""}</span>
                  ))}
                </div>
              </div>
              <span className={styles.barValue}>
                {stack.note}
                {stack.role === "subject" && traffic.paidDerived
                  ? <> 付费占比派生 <b>{traffic.paidDerived}</b> <PrecisionBadge label="公式" /></>
                  : null}
              </span>
            </div>
          ))}
          <ul className={styles.notes}><li>{traffic.paidNote}</li></ul>
        </div>
        <div>
          <div className={`${styles.tableShell} ${styles.shopTable}`}>
            <table>
              <thead>
                <tr>
                  <th>客群</th>
                  <th>指标</th>
                  {view.objects.map((object) => (
                    <Fragment key={object.role}>
                      <th className={`${styles.entityHead} ${roleClass(object.role)}`}>{object.label}</th>
                      <th className={`${styles.entityHead} ${roleClass(object.role)}`}>{object.label}环比</th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {traffic.customers.map((row, rowIndex) => (
                  <tr key={`${row.group}-${row.metric}-${rowIndex}`}>
                    <td>{row.group}</td>
                    <td>{row.metric}</td>
                    {row.values.map((value) => (
                      <Fragment key={value.role}>
                        <td className={`${styles.numeric} ${roleClass(value.role)}`}>{value.current}</td>
                        <td className={`${styles.numeric} ${roleClass(value.role)} ${value.trend === "up" ? styles.trendUp : value.trend === "down" ? styles.trendDown : ""}`}>{value.change || "—"}</td>
                      </Fragment>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className={styles.notes}>{traffic.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
        </div>
      </div>
    </section>
  );
}

const SAMPLE_NUMERIC_COLUMN = /成交笔数|笔单价|总GMV|30日消耗|单品费比/;
const SAMPLE_HIDDEN_COLUMN = new Set(["来源", "精度"]); // 2026-09-18 user direction

function formatSampleCell(value: DmpCell, column: string) {
  if (value == null || value === "" || value === "—" || value === "--") return "—";
  const text = String(value).trim();
  if (!SAMPLE_NUMERIC_COLUMN.test(column)) return shopDisplayText(text);
  if (!/^[+-]?[\d,]+(?:\.\d+)?$/.test(text)) return text;
  const numeric = Number(text.replaceAll(",", ""));
  return Number.isFinite(numeric) ? numeric.toLocaleString("en-US", { maximumFractionDigits: 2 }) : text;
}

/** 05 重点单品：保留 12 列 + 「占全店GMV」；全部商品展开。 */
function ShopSampleSection({ view, number }: { view: DmpShopView; number: string }) {
  const block = view.blocks.find((entry) => entry.code === "06");
  const samples = view.samples;
  const head = (
    <tr>
      {samples.columns.flatMap((column, columnIndex) => {
        if (SAMPLE_HIDDEN_COLUMN.has(column)) return [];
        const cells = [<th className={SAMPLE_NUMERIC_COLUMN.test(column) ? styles.numeric : ""} key={`${column}-${columnIndex}`}>{column}</th>];
        if (column === samples.shareAfterColumn) cells.push(<th className={`${styles.numeric} ${styles.shareHead}`} key="share">占全店GMV</th>);
        return cells;
      })}
    </tr>
  );
  return (
    <section className={styles.reportSection} id="shop-samples" data-report-section="店铺竞争态势·单品样本" data-shop-block="06" data-track-section="shop-samples">
      <SectionHeading number={number} name={block?.title ?? "重点单品对比"} total={`${samples.rows.length} 行`} />
      {block?.note ? <p className={styles.sectionNote}>{block.note}</p> : null}
      <div className={`${styles.tableShell} ${styles.shopTable}`}>
        <table>
          <thead>{head}</thead>
          <tbody>
            {samples.rows.map((row, rowIndex) => (
              <tr
                className={[row.total ? styles.totalRow : "", row.aggregate ? styles.aggregateRow : ""].filter(Boolean).join(" ")}
                data-sample-object={row.role}
                data-sample-aggregate={row.aggregate ? "true" : undefined}
                key={`${row.role}-${rowIndex}`}
              >
                {samples.columns.flatMap((column, columnIndex) => {
                  if (SAMPLE_HIDDEN_COLUMN.has(column)) return [];
                  const value = row.cells[columnIndex];
                  const cells = [column === "对象"
                    ? <td key={`${column}-${columnIndex}`}><span className={`${styles.who} ${roleClass(row.role)}`}>{String(value ?? "")}</span></td>
                    : <td
                      className={[SAMPLE_NUMERIC_COLUMN.test(column) ? styles.numeric : "", column === "商品标题" ? styles.wrap : ""].filter(Boolean).join(" ")}
                      key={`${column}-${columnIndex}`}
                    >{formatSampleCell(value, column)}</td>];
                  if (column === samples.shareAfterColumn) {
                    cells.push(<td className={`${styles.numeric} ${roleClass(row.role)} ${styles.shareCell}`} key="share"><b>{row.share}</b></td>);
                  }
                  return cells;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className={styles.notes}>{samples.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
    </section>
  );
}

function ShopDailyBars({ dates, series }: { dates: string[]; series: { label: string; values: Array<number | null> }[] }) {
  const finite = series.flatMap((item) => item.values.filter((value): value is number => value != null && Number.isFinite(value)));
  if (!finite.length || !dates.length) return null;
  const min = Math.min(0, ...finite);
  const max = Math.max(...finite);
  const span = max - min || 1;
  const width = Math.max(720, dates.length * 36);
  const height = 210;
  const pad = { left: 54, right: 12, top: 16, bottom: 42 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const group = plotW / dates.length;
  const bar = Math.max(3, Math.min(10, (group - 6) / Math.max(1, series.length)));
  const yOf = (value: number) => pad.top + (1 - (value - min) / span) * plotH;
  const colors = ["#1d5f96", "#b8651a", "#37804a", "#6b4c9a"];
  const labelStep = dates.length > 16 ? Math.ceil(dates.length / 12) : 1;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={styles.shopBars} role="img">
      <line x1={pad.left} y1={yOf(0)} x2={width - pad.right} y2={yOf(0)} stroke="#dbe7e5" />
      {[max, min].map((tick) => (
        <text key={tick} x={pad.left - 6} y={yOf(tick) + 4} textAnchor="end" className={styles.shopBarAxis}>{tick >= 1000 ? `${(tick / 10000).toFixed(tick >= 10000 ? 1 : 2)}万` : tick.toFixed(Math.abs(tick) >= 100 ? 0 : 2)}</text>
      ))}
      {dates.map((date, index) => {
        const x0 = pad.left + index * group + 4;
        return (
          <g key={date}>
            {series.map((item, seriesIndex) => {
              const value = item.values[index];
              if (value == null) return null;
              const y = yOf(Math.max(value, 0));
              const base = yOf(Math.min(value, 0));
              return <rect key={item.label} x={x0 + seriesIndex * (bar + 1)} y={Math.min(y, base)} width={bar} height={Math.max(1, Math.abs(base - y))} fill={colors[seriesIndex % colors.length]}><title>{`${date} ${item.label} ${value}`}</title></rect>;
            })}
            {index % labelStep === 0 ? <text x={x0} y={height - 16} className={styles.shopBarDate}>{date.slice(5)}</text> : null}
          </g>
        );
      })}
    </svg>
  );
}

function ShopDailySection({ view, number }: { view: DmpShopView; number: string }) {
  const block = view.blocks.find((entry) => entry.code === "07");
  const daily = view.daily;
  const charts = daily.charts ?? [];
  return (
    <section className={styles.reportSection} id="shop-daily" data-report-section="店铺竞争态势·逐日趋势" data-shop-block="07" data-track-section="shop-daily">
      <SectionHeading number={number} name={block?.title ?? "全店日趋势"} total={`${daily.dates.length} 天`} />
      {block?.note ? <p className={styles.sectionNote}>{block.note}</p> : null}
      {charts.length ? (
        <div className={styles.shopBarGrid}>
          {charts.map((chart) => (
            <figure key={chart.title} className={styles.shopBarCard}>
              <figcaption>
                <span>{chart.title}</span>
                <span className={styles.shopBarLegend}>{chart.series.map((item, index) => <i key={item.label} data-tone={index}>{item.label}</i>)}</span>
              </figcaption>
              <ShopDailyBars dates={daily.dates} series={chart.series} />
            </figure>
          ))}
        </div>
      ) : null}
      <div className={`${styles.tableShell} ${styles.shopTable}`}>
        <table>
          <thead>
            <tr>
              <th>日期</th>
              {view.objects.flatMap((object) => ["日销售额", "日消耗", "日费比", "日引导ROI", "日单量", "日客单价", "日点击单价", "日转化率", "日加购率"].map((name) => (
                <th className={`${styles.numeric} ${roleClass(object.role)}`} key={`${object.role}-${name}`}>{object.label} {name}</th>
              )))}
            </tr>
          </thead>
          <tbody>
            {daily.dates.map((date) => (
              <tr key={date}>
                <td>{date}</td>
                {view.objects.flatMap((object, index) => {
                  const row = daily.byDate[date]?.[index] || { gmv: "", spend: "", fee: "", roi: "", orders: "", aov: "", ppc: "", cvr: "", cart: "" };
                  return [
                    <td className={styles.numeric} key={`${object.role}-gmv`}>{row.gmv || "—"}</td>,
                    <td className={styles.numeric} key={`${object.role}-spend`}>{row.spend || "—"}</td>,
                    <td className={styles.numeric} key={`${object.role}-fee`}>{row.fee || "—"}</td>,
                    <td className={styles.numeric} key={`${object.role}-roi`}>{row.roi || "—"}</td>,
                    <td className={styles.numeric} key={`${object.role}-orders`}>{row.orders || "—"}</td>,
                    <td className={styles.numeric} key={`${object.role}-aov`}>{row.aov || "—"}</td>,
                    <td className={styles.numeric} key={`${object.role}-ppc`}>{row.ppc || "—"}</td>,
                    <td className={styles.numeric} key={`${object.role}-cvr`}>{row.cvr || "—"}</td>,
                    <td className={styles.numeric} key={`${object.role}-cart`}>{row.cart || "—"}</td>
                  ];
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** 数据说明与待补项。 */
function ShopNotesSection({ notes, number }: { notes: DmpShopNote[]; number: string }) {
  const pending = notes.filter((note) => note.kind === "缺").length;
  return (
    <section className={`${styles.reportSection} ${styles.notesSection}`} id="shop-notes" data-report-section="数据说明" data-shop-block="08" data-track-section="shop-notes">
      <SectionHeading number={number} name="数据说明" total={`${notes.length} 条 · 待补 ${pending} 项`} />
      <ul className={styles.notes}>
        {notes.map((note, index) => (
          <li key={index} data-note-kind={note.kind}>
            <span className={`${styles.notePill} ${note.kind === "缺" ? styles.notePillMissing : note.kind === "建议" ? styles.notePillSuggestion : ""}`}>{note.kind}</span>
            {shopDisplayText(note.text)}
          </li>
        ))}
      </ul>
    </section>
  );
}

function isMissingCell(value: DmpCell) {
  return value == null || value === "" || value === "—" || value === "--";
}

function ShopCompetitionSection({ table, index, numberOverride }: { table: DmpViewerTable; index: number; numberOverride?: string }) {
  const [query, setQuery] = useState("");
  const keyword = query.trim().toLocaleLowerCase("zh-CN");
  const visibleRows = keyword
    ? table.rows.filter((row) => row.some((value) => String(value ?? "").toLocaleLowerCase("zh-CN").includes(keyword)))
    : table.rows;
  const layout = table.shopLayout;
  const folded = table.layoutRole === "benchmark" || table.layoutRole === "overview" || table.layoutRole === "archive";
  const channel = table.layoutRole === "channel" && layout;
  const channelIndex = table.columns.indexOf("渠道 / 客群");
  const attributionIndex = table.columns.indexOf("归因范围");
  const groupsOf = (rows: DmpCell[][]) => {
    const map = new Map<string, { parent: string; attribution: string; top: DmpCell[][]; sub: DmpCell[][] }>();
    for (const row of rows) {
      const channelText = String(row[channelIndex] ?? ""), parent = channelText.split(" / ")[0], attribution = String(row[attributionIndex] ?? "");
      const key = `${attribution}|${parent}`;
      if (!map.has(key)) map.set(key, { parent, attribution, top: [], sub: [] });
      (channelText.includes(" / ") ? map.get(key)!.sub : map.get(key)!.top).push(row);
    }
    return [...map.values()];
  };
  const head = (
    <thead>
      {layout ? <>
        <tr>
          {table.columns.slice(0, layout.metaCount).map((column, columnIndex) => <th rowSpan={2} className={columnIndex === layout.metaCount - 1 ? styles.stickyColumn : ""} key={`${column}-${columnIndex}`}>{column}</th>)}
          {layout.groups.map((group) => <th colSpan={3} className={`${styles.entityHead} ${roleClass(group.role)}`} data-object-head={group.role} key={group.role}>{group.label}</th>)}
          {layout.groups.some((group) => group.precisionIndex >= 0) ? <th colSpan={layout.groups.filter((group) => group.precisionIndex >= 0).length} className={styles.groupHead}>精度</th> : null}
          {layout.groups.some((group) => group.relativeIndex >= 0) ? <th colSpan={layout.groups.filter((group) => group.relativeIndex >= 0).length} className={styles.groupHead}>本店相对竞店</th> : null}
        </tr>
        <tr>
          {layout.groups.map((group) => ["本期", "上期", "变化"].map((label) => <th className={styles.periodHead} key={`${group.role}-${label}`}>{label}</th>))}
          {layout.groups.filter((group) => group.precisionIndex >= 0).map((group) => <th className={`${styles.periodHead} ${roleClass(group.role)}`} key={`p-${group.role}`}>{group.label}</th>)}
          {layout.groups.filter((group) => group.relativeIndex >= 0).map((group) => <th className={`${styles.periodHead} ${roleClass(group.role)}`} key={`r-${group.role}`}>{group.label}</th>)}
        </tr>
      </> : <tr>{table.columns.map((column, columnIndex) => <th key={`${column}-${columnIndex}`}>{column}</th>)}</tr>}
    </thead>
  );
  const columnOrder = layout
    ? [...Array.from({ length: layout.metaCount }, (_, i) => i), ...layout.groups.flatMap((group) => [group.start, group.start + 1, group.start + 2]), ...layout.groups.filter((group) => group.precisionIndex >= 0).map((group) => group.precisionIndex), ...layout.groups.filter((group) => group.relativeIndex >= 0).map((group) => group.relativeIndex)]
    : table.columns.map((_, i) => i);
  const cellFor = (row: DmpCell[], columnIndex: number) => {
    const value = row[columnIndex];
    const column = table.columns[columnIndex] ?? "";
    const group = layout?.groups.find((candidate) => columnIndex >= candidate.start && columnIndex < candidate.start + candidate.span);
    const precisionGroup = layout?.groups.find((candidate) => candidate.precisionIndex === columnIndex);
    const relativeGroup = layout?.groups.find((candidate) => candidate.relativeIndex === columnIndex);
    if (precisionGroup) return <td className={styles.precisionCell} key={columnIndex}><PrecisionBadge label={String(value ?? "")} /></td>;
    if (relativeGroup) {
      const trend = shopTrend(value);
      return <td className={`${styles.numeric} ${styles.relative} ${trend === "up" ? styles.trendUp : trend === "down" ? styles.trendDown : ""}`} key={columnIndex}>{isMissingCell(value) ? "—" : String(value)}</td>;
    }
    if (group) {
      const isChange = columnIndex === group.start + 2;
      if (isChange && isNoteCell(value)) return <td className={`${styles.numeric} ${roleClass(group.role)} ${styles.noteCell}`} title={shopDisplayText(String(value))} key={columnIndex}>—<small>{shopDisplayText(String(value))}</small></td>;
      const trend = isChange ? shopTrend(value) : "";
      const semantic = `${String(row[layout!.metaCount - 1] ?? "")} ${column}`;
      return <td className={`${styles.numeric} ${roleClass(group.role)} ${trend === "up" ? styles.trendUp : trend === "down" ? styles.trendDown : ""}`} key={columnIndex}>{isMissingCell(value) ? "—" : formatViewerCell(value, semantic)}</td>;
    }
    const sticky = layout && columnIndex === layout.metaCount - 1;
    const sampleNumeric = table.layoutRole === "samples" && /笔单价|总GMV|30日消耗|成交笔数|费比/.test(column);
    return <td className={[sticky ? styles.stickyColumn : "", sampleNumeric ? styles.numeric : "", /标题/.test(column) ? styles.wrap : ""].filter(Boolean).join(" ")} key={columnIndex}>{isMissingCell(value) ? "—" : /商品ID|店铺 ID/.test(column) ? String(value) : sampleNumeric ? formatViewerCell(value, column) : shopDisplayText(String(value))}</td>;
  };
  const renderRows = (rows: DmpCell[][]) => rows.map((row, rowIndex) => <tr className={table.layoutRole === "samples" && String(row[2] ?? "") === "合计" ? styles.totalRow : ""} key={rowIndex}>{columnOrder.map((columnIndex) => cellFor(row, columnIndex))}</tr>);
  const body = channel
    ? groupsOf(visibleRows).map((group, groupIndex) => <tbody key={groupIndex}>
        {renderRows(group.top)}
        {group.sub.length ? <tr className={styles.foldRow}><td colSpan={table.columns.length}><details><summary>二级渠道 · {group.parent}（{group.sub.length} 项）</summary><table>{head}<tbody>{renderRows(group.sub)}</tbody></table></details></td></tr> : null}
      </tbody>)
    : <tbody>{renderRows(visibleRows)}</tbody>;
  const tableMarkup = (
    <>
      <div className={styles.tableTools}>
        <label>筛选本表<input type="search" value={query} data-table-filter={table.name} aria-label={`筛选${shopDisplayText(table.name)}`} placeholder="输入关键词" onChange={(event) => setQuery(event.target.value)} /></label>
        <span>{visibleRows.length} / {table.rows.length}</span>
      </div>
      <div className={`${styles.tableShell} ${styles.shopTable}`} data-report-table={table.name} data-track={`table-scroll:${index + 1}`}>
        <table>{head}{body}</table>
        {!visibleRows.length ? <div className={styles.empty}>没有匹配的数据</div> : null}
      </div>
    </>
  );
  const heading = <SectionHeading number={numberOverride ?? String(index + 1).padStart(2, "0")} name={table.layoutRole === "core" ? "核心对标" : table.name} total={`${table.rows.length} 行`} />;
  return (
    <section className={`${styles.reportSection} ${folded ? styles.foldedSection : ""}`} id={sectionId(table, index)} data-report-section={table.name} data-layout-role={table.layoutRole ?? ""} data-track-section={`table:${table.name}`}>
      {folded ? <details><summary>{heading}{table.subtitle ? <p className={styles.sectionNote}>{table.subtitle}</p> : null}</summary>{tableMarkup}</details>
        : <>{heading}{table.subtitle ? <p className={styles.sectionNote}>{table.subtitle}</p> : null}{tableMarkup}</>}
    </section>
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
    // v2.3.100: 单次点击成本 / 笔单价 / 金额 are amounts even though their label contains 点击 or 成交.
    const integer = /天数|层级|成交笔数|展现|点击|访客|数量/i.test(semantic) && !/成本|单价|金额|费比|率|ROI|CPC|PPC/i.test(semantic);
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
