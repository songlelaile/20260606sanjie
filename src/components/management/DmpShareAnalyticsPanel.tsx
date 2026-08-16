"use client";

import {
  BarChart3,
  Clock,
  Eye,
  Link2,
  MousePointerClick,
  RefreshCw,
  Share2,
  Users
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DmpReportAnalyticsDays,
  DmpReportAnalyticsRecentShare,
  DmpReportAnalyticsTrendRow,
  DmpReportManagementAnalytics
} from "@/lib/dmp-report-types";

const RANGE_OPTIONS = [7, 30, 90] as const;
const ANALYTICS_ENDPOINT = "/api/management/dmp-report-share-analytics";

interface ModuleRow {
  key: string;
  section: string;
  element: string;
  clicks: number;
}

export function DmpShareAnalyticsPanel() {
  const [days, setDays] = useState<DmpReportAnalyticsDays>(30);
  const [analytics, setAnalytics] = useState<DmpReportManagementAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revokingId, setRevokingId] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${ANALYTICS_ENDPOINT}?days=${days}`, {
        cache: "no-store",
        signal
      });
      const payload = await response.json().catch(() => null) as {
        data?: { analytics?: DmpReportManagementAnalytics };
        error?: string;
      } | null;
      if (!response.ok || !payload?.data?.analytics) throw new Error(payload?.error || "传播分析读取失败");
      setAnalytics(payload.data.analytics);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setAnalytics(null);
      setError(caught instanceof Error ? caught.message : "传播分析读取失败");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function revokeShare(share: DmpReportAnalyticsRecentShare) {
    if (!share.shareId || !window.confirm(`确认撤销主体「${share.subjectItemId || "这份报告"}」的分享链接？撤销后原链接将立即失效。`)) return;
    setRevokingId(share.shareId);
    setError("");
    try {
      const response = await fetch(`${ANALYTICS_ENDPOINT}?shareId=${encodeURIComponent(share.shareId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        cache: "no-store"
      });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error || "撤销分享失败");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "撤销分享失败");
    } finally {
      setRevokingId("");
    }
  }

  const hasData = Boolean(
    analytics && (
      analytics.overview.totalShares || analytics.overview.pageViews || analytics.trend.length ||
      analytics.sources.length || analytics.topElements.length || analytics.sections.length ||
      analytics.topReports.length || analytics.recentShares.length
    )
  );

  return (
    <section className="dmp-admin-analytics" aria-label="达摩盘报告传播分析">
      <header className="dmp-admin-analytics-head">
        <div>
          <span className="management-section-label">DMP REPORT DISTRIBUTION</span>
          <h2>报告传播与关注度分析</h2>
          <p>跨租户汇总公开只读报告的匿名访问、来源、活跃阅读和点击；不记录访客 IP、账号、设备信息或业务单元格内容。</p>
        </div>
        <div className="dmp-admin-range" aria-label="统计时间范围">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              className={days === option ? "active" : ""}
              aria-pressed={days === option}
              onClick={() => setDays(option as DmpReportAnalyticsDays)}
              disabled={loading}
            >
              {option} 天
            </button>
          ))}
          <button type="button" onClick={() => void load()} disabled={loading} aria-label="刷新传播分析">
            <RefreshCw className={loading ? "spin" : ""} size={15} />
            刷新
          </button>
        </div>
      </header>

      {error ? (
        <div className="dmp-admin-analytics-state error" role="alert">
          <strong>传播分析暂时无法读取</strong>
          <span>{error}</span>
          <button type="button" onClick={() => void load()}>重试</button>
        </div>
      ) : null}

      {loading && !analytics ? (
        <div className="dmp-admin-analytics-state"><RefreshCw className="spin" size={22} /><span>正在汇总传播数据…</span></div>
      ) : !error && !hasData ? (
        <div className="dmp-admin-analytics-state">
          <Share2 size={26} />
          <strong>所选时间范围内暂无传播数据</strong>
          <span>公开报告产生访问后，这里会展示 PV、UV、会话、阅读深度、来源和热门报告。</span>
        </div>
      ) : analytics ? (
        <AnalyticsContent analytics={analytics} revokingId={revokingId} onRevoke={revokeShare} />
      ) : null}
    </section>
  );
}

function AnalyticsContent({
  analytics,
  revokingId,
  onRevoke
}: {
  analytics: DmpReportManagementAnalytics;
  revokingId: string;
  onRevoke: (share: DmpReportAnalyticsRecentShare) => void;
}) {
  const modules = moduleRows(analytics);
  const overview = analytics.overview;
  const metrics = [
    { label: "传播中 / 总链接", value: `${integer(overview.activeShares)} / ${integer(overview.totalShares)}`, icon: Link2 },
    { label: "PV · 页面浏览", value: integer(overview.pageViews), icon: Eye },
    { label: "UV · 匿名访客", value: integer(overview.uniqueVisitors), icon: Users },
    { label: "会话", value: integer(overview.sessionCount), icon: BarChart3 },
    { label: "模块点击", value: integer(overview.clickCount), icon: MousePointerClick },
    { label: "平均活跃停留", value: duration(overview.averageActiveSeconds), icon: Clock },
    { label: "平均阅读深度", value: percent(overview.averageScrollDepth), icon: BarChart3 }
  ];
  return (
    <>
      <div className="dmp-admin-kpis">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <div key={metric.label}>
              <span><Icon size={14} />{metric.label}</span>
              <strong>{metric.value}</strong>
            </div>
          );
        })}
      </div>

      {overview.dataTruncated ? (
        <p className="dmp-admin-data-note">所选周期事件超过安全上限，当前指标可能低估；可缩短时间范围查看。</p>
      ) : null}

      <section className="dmp-admin-card">
        <header><div><strong>访问趋势</strong><span>按天对比 PV、UV 与会话</span></div></header>
        <AnalyticsTrend rows={analytics.trend} />
      </section>

      <div className="dmp-admin-analytics-grid">
        <section className="dmp-admin-card">
          <header><div><strong>传播来源</strong><span>仅展示来源域名及 UTM 参数</span></div></header>
          <div className="table-wrap">
            <table className="management-table dmp-admin-table">
              <thead><tr><th>来源 / UTM</th><th>PV</th><th>UV</th><th>会话</th></tr></thead>
              <tbody>
                {analytics.sources.length ? analytics.sources.map((source, index) => (
                  <tr key={`${source.source}\u001f${source.medium}\u001f${source.campaign}\u001f${source.referrerHost}\u001f${index}`}>
                    <td><strong>{source.source || source.referrerHost || "直接访问"}</strong><span>{[source.medium, source.campaign].filter(Boolean).join(" · ") || "无 UTM"}</span></td>
                    <td>{integer(source.pageViews)}</td><td>{integer(source.uniqueVisitors)}</td><td>{integer(source.sessionCount)}</td>
                  </tr>
                )) : <EmptyTable colSpan={4} text="暂无可识别来源" />}
              </tbody>
            </table>
          </div>
        </section>

        <section className="dmp-admin-card">
          <header><div><strong>热门模块点击</strong><span>累计全时段点击，不随上方时间范围变化；不保存业务单元格内容</span></div></header>
          <div className="table-wrap">
            <table className="management-table dmp-admin-table">
              <thead><tr><th>报告模块</th><th>交互元素</th><th>点击</th></tr></thead>
              <tbody>
                {modules.length ? modules.map((module) => (
                  <tr key={module.key}>
                    <td><strong>{moduleLabel(module.section)}</strong></td>
                    <td>{elementLabel(module.element)}</td>
                    <td>{integer(module.clicks)}</td>
                  </tr>
                )) : <EmptyTable colSpan={3} text="暂无模块点击" />}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="dmp-admin-card">
        <header><div><strong>热门报告</strong><span>按页面浏览量排序</span></div></header>
        <div className="table-wrap">
          <table className="management-table dmp-admin-table">
            <thead><tr><th>报告 / 所属账号</th><th>PV</th><th>UV</th><th>会话</th><th>点击</th><th>平均停留</th><th>阅读深度</th><th>最后访问</th></tr></thead>
            <tbody>
              {analytics.topReports.length ? analytics.topReports.map((report) => (
                <tr key={report.reportId}>
                  <td><strong>主体 {report.subjectItemId || "未命名报告"}</strong><span>{[report.tenantName, report.userName || report.username, report.period].filter(Boolean).join(" · ")}</span></td>
                  <td>{integer(report.pageViews)}</td><td>{integer(report.uniqueVisitors)}</td><td>{integer(report.sessionCount)}</td><td>{integer(report.clickCount)}</td>
                  <td>{duration(average(report.activeSeconds, report.sessionCount))}</td><td>{percent(report.averageScrollDepth)}</td><td>{report.lastSeenAt ? dateTime(report.lastSeenAt) : "—"}</td>
                </tr>
              )) : <EmptyTable colSpan={8} text="暂无报告访问" />}
            </tbody>
          </table>
        </div>
      </section>

      <section className="dmp-admin-card">
        <header><div><strong>分享链接明细</strong><span>管理员可撤销不再需要传播的公开链接</span></div></header>
        <div className="table-wrap">
          <table className="management-table dmp-admin-table dmp-share-link-table">
            <thead><tr><th>报告 / 所属账号</th><th>创建时间</th><th>打开</th><th>会话</th><th>点击</th><th>最近查看</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              {analytics.recentShares.length ? analytics.recentShares.map((share) => {
                const revoked = Boolean(share.revokedAt);
                return (
                  <tr key={share.shareId}>
                    <td><strong>主体 {share.subjectItemId || "未命名报告"}</strong><span>{[share.tenantName, share.userName || share.username].filter(Boolean).join(" · ") || "—"}</span></td>
                    <td>{dateTime(share.createdAt)}</td>
                    <td>{integer(share.viewCount)}</td><td>{integer(share.sessionCount)}</td><td>{integer(share.clickCount)}</td>
                    <td>{share.lastViewedAt ? dateTime(share.lastViewedAt) : "—"}</td>
                    <td><span className={`user-status-pill ${revoked ? "disabled" : "active"}`}>{revoked ? "已撤销" : "传播中"}</span></td>
                    <td>
                      <button
                        type="button"
                        className="danger-outline-button"
                        disabled={revoked || Boolean(revokingId)}
                        onClick={() => onRevoke(share)}
                      >
                        {revokingId === share.shareId ? "撤销中…" : "撤销"}
                      </button>
                    </td>
                  </tr>
                );
              }) : <EmptyTable colSpan={8} text="暂无分享链接" />}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function AnalyticsTrend({ rows }: { rows: DmpReportAnalyticsTrendRow[] }) {
  const max = useMemo(
    () => Math.max(1, ...rows.flatMap((row) => [row.pageViews, row.uniqueVisitors, row.sessionCount])),
    [rows]
  );
  if (!rows.length) return <div className="dmp-admin-chart-empty">暂无分日趋势</div>;
  return (
    <div className="dmp-admin-trend-wrap">
      <div className="dmp-admin-trend-legend"><span className="pv">PV</span><span className="uv">UV</span><span className="sessions">会话</span></div>
      <div className="dmp-admin-trend" role="img" aria-label="公开报告 PV、UV 与会话分日趋势">
        {rows.map((row, index) => (
          <div className="dmp-admin-trend-day" key={`${row.date}-${index}`} title={`${row.date} · PV ${row.pageViews} · UV ${row.uniqueVisitors} · 会话 ${row.sessionCount}`}>
            <div className="dmp-admin-trend-bars">
              <i className="pv" style={{ height: `${Math.max(row.pageViews ? 3 : 0, row.pageViews / max * 100)}%` }} />
              <i className="uv" style={{ height: `${Math.max(row.uniqueVisitors ? 3 : 0, row.uniqueVisitors / max * 100)}%` }} />
              <i className="sessions" style={{ height: `${Math.max(row.sessionCount ? 3 : 0, row.sessionCount / max * 100)}%` }} />
            </div>
            <span>{trendDateLabel(row.date, index, rows.length)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyTable({ colSpan, text }: { colSpan: number; text: string }) {
  return <tr><td className="empty-table-cell" colSpan={colSpan}>{text}</td></tr>;
}

function moduleRows(analytics: DmpReportManagementAnalytics): ModuleRow[] {
  if (analytics.topElements.length) {
    return analytics.topElements.map((row, index) => ({
      key: `${row.sectionKey}\u001f${row.elementKey}\u001f${index}`,
      section: row.sectionKey,
      element: row.elementKey,
      clicks: row.count
    }));
  }
  return analytics.sections.map((row, index) => ({
    key: `${row.sectionKey}\u001f${index}`,
    section: row.sectionKey,
    element: "",
    clicks: row.count
  }));
}

function average(total: number, count: number) {
  return count > 0 ? total / count : 0;
}

function integer(value: number) {
  return Math.round(value).toLocaleString("zh-CN");
}

function percent(value: number) {
  return `${Math.max(0, Math.min(100, value)).toFixed(1)}%`;
}

function duration(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分`;
}

function dateTime(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function trendDateLabel(value: string, index: number, length: number) {
  const stride = length > 45 ? 10 : length > 20 ? 5 : length > 10 ? 2 : 1;
  if (index !== 0 && index !== length - 1 && index % stride !== 0) return "";
  return value.length >= 10 ? value.slice(5) : value;
}

function moduleLabel(value: string) {
  if (!value || value === "report") return "报告整体";
  if (value === "hero") return "报告标题区";
  if (value === "hero-actions") return "分享操作区";
  if (value === "report-nav") return "报告目录";
  if (value === "summary") return "报告摘要";
  if (value === "privacy-note") return "匿名统计说明";
  return value.startsWith("table:") ? value.slice(6) : value;
}

function elementLabel(value: string) {
  if (!value) return "模块内点击";
  if (value === "copy-link") return "复制链接";
  if (value.startsWith("nav:")) return `目录第 ${value.slice(4)} 项`;
  if (value.startsWith("table-scroll:")) return "业务表滚动区";
  if (value.startsWith("header:")) return `第 ${Number(value.slice(7)) + 1 || "—"} 列表头`;
  if (value.startsWith("cell:")) return `第 ${Number(value.slice(5)) + 1 || "—"} 列单元格`;
  return value;
}
