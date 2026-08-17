import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DmpSharedReportClient } from "@/components/tools/DmpSharedReportClient";
import { DmpBrandWatermark } from "@/components/tools/DmpBrandWatermark";
import { dmpCellSemantic, formatDmpCell } from "@/lib/dmp-report-format";
import { getPublicDmpSharedReport } from "@/lib/dmp-report-share";

export const metadata: Metadata = {
  title: "达摩盘只读分享报告｜少壮AI自动化",
  robots: { index: false, follow: false }
};

export const dynamic = "force-dynamic";

export default async function SharedDmpReportPage({
  params
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const snapshot = await getPublicDmpSharedReport(token);
  if (!snapshot) notFound();
  const record = snapshot.report;
  const report = record.report;
  const competition = record.reportType === "competition";
  const competitors = record.competitorItemId.split(",").map((item) => item.trim()).filter(Boolean);
  const rowCount = report.tables.reduce((sum, table) => sum + table.rows.length, 0);

  return (
    <div className="dmp-shared-page" data-track-section="report">
      <DmpBrandWatermark />
      <div className="dmp-print-disabled">当前版本仅支持官网在线查看，暂不支持打印或导出。</div>
      <header className="dmp-shared-hero" data-track-section="hero">
        <div className="dmp-shared-hero-inner">
          <p>{competition ? "DAMOPAN · COMPETITION SITUATION" : "DAMOPAN · GROWTH BENCHMARK"}</p>
          <h1>{report.title}</h1>
          <div className="dmp-shared-hero-meta">
            <span>{competition ? "本店" : "主体商品"}：{record.subjectItemId}</span>
            <span>{competition ? `竞店 ${competitors.length} 家` : "成功品"}：{competitors.join("、") || "—"}</span>
            <span>{record.period || report.period}</span>
            <span>{report.tables.length} 张表 · {rowCount} 行</span>
            <span>{record.quality === "complete" ? "数据完整" : "局部数据"}</span>
          </div>
          <p className="dmp-shared-access-note">公开只读报告：任何拿到链接的人都可直接打开，无需登录；请仅转发给需要查看的人。</p>
          <DmpSharedReportClient token={token} />
        </div>
      </header>

      <nav className="dmp-shared-nav" aria-label="报告目录" data-track-section="report-nav">
        <div>
          {report.tables.map((table, index) => (
            <a key={`${table.name}-${index}`} href={`#dmp-section-${index + 1}`} data-track={`nav:${index + 1}`}>
              {table.name}
            </a>
          ))}
        </div>
      </nav>

      <main className="dmp-shared-main">
        <section className="dmp-shared-summary" data-track-section="summary">
          <div><span>报告类型</span><strong>{competition ? "竞争态势分析" : "打爆路径对标"}</strong></div>
          <div><span>报告生成</span><strong>{dateTimeLabel(record.createdAt)}</strong></div>
          <div><span>分享快照</span><strong>{dateTimeLabel(snapshot.createdAt)}</strong></div>
          <div><span>访问口径</span><strong>持链接公开只读</strong></div>
        </section>

        {report.tables.map((table, tableIndex) => (
          <section
            className="dmp-shared-section"
            id={`dmp-section-${tableIndex + 1}`}
            key={`${table.name}-${tableIndex}`}
            data-track-section={`table:${table.name}`}
          >
            <header>
              <span>{String(tableIndex + 1).padStart(2, "0")}</span>
              <div><h2>{table.name}</h2><p>{table.rows.length} 行 · 横向滚动查看完整列</p></div>
            </header>
            <div className="dmp-shared-table-scroll" data-track={`table-scroll:${tableIndex + 1}`}>
              <table>
                <thead>
                  <tr>{table.columns.map((column, columnIndex) => <th key={`${column}-${columnIndex}`} data-track={`header:${columnIndex}`}>{column}</th>)}</tr>
                </thead>
                <tbody>
                  {table.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {table.columns.map((_, columnIndex) => {
                        const value = formatDmpCell(row.cells[columnIndex], dmpCellSemantic(table.name, table.columns, row.cells, columnIndex));
                        return <td key={columnIndex} data-track={`cell:${columnIndex}`} title={value === "—" ? undefined : value}>{value}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </main>
      <footer className="dmp-shared-footer">少壮AI自动化 · 达摩盘业务报告官网只读快照</footer>
    </div>
  );
}

function dateTimeLabel(value: string) {
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
