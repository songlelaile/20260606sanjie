"use client";

import clsx from "clsx";
import { RefreshCcw, Save, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  HistoryDataKey,
  ManagementHistoryState
} from "@/lib/types/domain";

const historyColumns: Array<{ key: HistoryDataKey; label: string }> = [
  { key: "product", label: "商品" },
  { key: "promotionProduct", label: "推广商品" },
  { key: "promotionContent", label: "推广内容" },
  { key: "keyword", label: "关键词" },
  { key: "audience", label: "人群" }
];

export function ManagementHistoryPanel({
  initialHistory
}: {
  initialHistory: ManagementHistoryState;
}) {
  const [records, setRecords] = useState(initialHistory.records);
  const [reports, setReports] = useState(initialHistory.reports);
  const [retentionMonths, setRetentionMonths] = useState(initialHistory.retention.months);
  const [beforeDate, setBeforeDate] = useState(initialDate(initialHistory.records[0]?.dataRangeStart));
  const [rangeStart, setRangeStart] = useState(initialDate(initialHistory.records[0]?.dataRangeStart));
  const [rangeEnd, setRangeEnd] = useState(initialDate(initialHistory.records[0]?.dataRangeEnd));
  const [selectedColumns, setSelectedColumns] = useState<HistoryDataKey[]>(
    historyColumns.map((item) => item.key)
  );
  const [reportName, setReportName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const filteredRecords = useMemo(
    () =>
      records.filter((record) => {
        if (!rangeStart || !rangeEnd) {
          return true;
        }
        return (
          record.dataRangeEnd >= rangeStart &&
          record.dataRangeStart <= rangeEnd
        );
      }),
    [rangeEnd, rangeStart, records]
  );

  const summary = useMemo(() => buildSummary(records), [records]);
  const filteredSummary = useMemo(
    () => buildSummary(filteredRecords),
    [filteredRecords]
  );

  const selectedTotal = useMemo(
    () => sumSelectedColumns(filteredSummary, selectedColumns),
    [filteredSummary, selectedColumns]
  );
  const peakValue = useMemo(
    () => Math.max(1, ...historyColumns.map((item) => filteredSummary[item.key])),
    [filteredSummary]
  );

  async function saveRetention() {
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/history-data", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ months: retentionMonths })
    });
    const payload = (await response.json()) as {
      data?: ManagementHistoryState;
      error?: string;
    };
    if (payload.data) {
      syncHistory(payload.data);
      setMessage(retentionMonths === 0 ? "已保存永久留存策略" : `已保存留存 ${retentionMonths} 个月`);
    } else {
      setMessage(payload.error ?? "保存失败，请稍后重试");
    }
    setBusy(false);
  }

  async function clearAll() {
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/history-data", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "all" })
    });
    const payload = (await response.json()) as {
      data?: ManagementHistoryState;
      error?: string;
    };
    if (payload.data) {
      syncHistory(payload.data);
      setMessage("已清空全部历史");
    } else {
      setMessage(payload.error ?? "清空失败，请稍后重试");
    }
    setBusy(false);
  }

  async function deleteBefore() {
    if (!beforeDate) {
      setMessage("请选择开始日期");
      return;
    }
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/history-data", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "before", beforeDate })
    });
    const payload = (await response.json()) as {
      data?: ManagementHistoryState;
      error?: string;
    };
    if (payload.data) {
      syncHistory(payload.data);
      setMessage(`已删除 ${beforeDate} 之前的历史`);
    } else {
      setMessage(payload.error ?? "删除失败，请稍后重试");
    }
    setBusy(false);
  }

  async function deleteRange() {
    if (!rangeStart || !rangeEnd || rangeStart > rangeEnd) {
      setMessage("请选择合法的日期区间");
      return;
    }
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/history-data", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "range", startDate: rangeStart, endDate: rangeEnd })
    });
    const payload = (await response.json()) as {
      data?: ManagementHistoryState;
      error?: string;
    };
    if (payload.data) {
      syncHistory(payload.data);
      setMessage(`已删除 ${rangeStart} ~ ${rangeEnd} 的历史`);
    } else {
      setMessage(payload.error ?? "删除失败，请稍后重试");
    }
    setBusy(false);
  }

  async function saveReport() {
    if (!rangeStart || !rangeEnd || rangeStart > rangeEnd) {
      setMessage("请选择合法的日期区间");
      return;
    }
    setBusy(true);
    setMessage("");
    const name = reportName.trim() || `历史追溯_${rangeStart}_${rangeEnd}`;
    const response = await fetch("/api/history-data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        startDate: rangeStart,
        endDate: rangeEnd,
        categories: selectedColumns
      })
    });
    const payload = (await response.json()) as {
      data?: { report?: ManagementHistoryState["reports"][number]; history?: ManagementHistoryState };
      error?: string;
    };
    if (payload.data?.history) {
      syncHistory(payload.data.history);
      setMessage(`已保存报表 ${payload.data.report?.name ?? name}`);
      setReportName("");
    } else {
      setMessage(payload.error ?? "保存失败，请稍后重试");
    }
    setBusy(false);
  }

  function syncHistory(next: ManagementHistoryState) {
    setRecords(next.records);
    setReports(next.reports);
    setRetentionMonths(next.retention.months);
  }

  return (
    <section className="management-history">
      <section className="management-history-policy panel-shell">
        <div className="management-history-policy-copy">
          <span className="management-section-label">留存策略</span>
          <h2>历史数据</h2>
          <p>
            管理历史库的保留时长和清理动作。租户端默认只保存最新 1 次数据，更新新数据时会自动清理旧数据，避免服务器和磁盘持续膨胀。
          </p>
        </div>
        <label className="management-history-input">
          <span>历史保留月数（0 = 永久）</span>
          <input
            min={0}
            max={120}
            type="number"
            value={retentionMonths}
            onChange={(event) => setRetentionMonths(Number(event.target.value))}
          />
        </label>
        <button type="button" className="management-primary-button" onClick={saveRetention} disabled={busy}>
          <RefreshCcw size={15} />
          保存留存策略
        </button>
      </section>

      <section className="management-history-danger panel-shell">
        <div className="management-history-danger-copy">
          <span className="management-section-label danger">历史清理</span>
          <p>
            删除的是历史库，不影响源文件上传目录。下方的「历史在线浏览」支持按日期区间挑选，再把当前视图保存成报表。
          </p>
        </div>
        <div className="management-history-danger-actions">
          <button type="button" className="danger-outline-button danger-solid" onClick={clearAll} disabled={busy}>
            <Trash2 size={15} />
            清空全部历史
          </button>
          <label className="history-date-field">
            <span>删除「开始」之前</span>
            <input type="date" value={beforeDate} onChange={(event) => setBeforeDate(event.target.value)} />
          </label>
          <button type="button" className="danger-outline-button" onClick={deleteBefore} disabled={busy}>
            删除「开始」之前
          </button>
          <button type="button" className="danger-outline-button" onClick={deleteRange} disabled={busy}>
            删除「开始~结束」区间
          </button>
        </div>
      </section>

      <div className="management-history-strip">
        <span>
          历史库覆盖: 共 <strong>{records.length}</strong> 次上传
        </span>
        <span>商品 {summary.product.toLocaleString()} 行</span>
        <span>推广商品 {summary.promotionProduct.toLocaleString()} 行</span>
        <span>推广内容 {summary.promotionContent.toLocaleString()} 行</span>
        <span>关键词 {summary.keyword.toLocaleString()} 行</span>
        <span>人群 {summary.audience.toLocaleString()} 行</span>
      </div>

      <section className="management-history-preview panel-shell">
        <div className="management-history-preview-top">
          <div>
            <span className="management-section-label">历史在线浏览</span>
            <p>选日期区间 → 点某个视图，按历史库区间的数据重新计算，口径与正常视图完全一致。</p>
          </div>
          <div className="management-history-preview-range">
            <label>
              <span>开始</span>
              <input type="date" value={rangeStart} onChange={(event) => setRangeStart(event.target.value)} />
            </label>
            <label>
              <span>结束</span>
              <input type="date" value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)} />
            </label>
          </div>
        </div>

        <div className="management-history-view-switches">
          {historyColumns.map((item) => {
            const active = selectedColumns.includes(item.key);
            return (
              <button
                key={item.key}
                type="button"
                className={clsx("history-view-pill", active && "active")}
                onClick={() =>
                  setSelectedColumns((current) =>
                    current.includes(item.key)
                      ? current.filter((key) => key !== item.key)
                      : [...current, item.key]
                  )
                }
              >
                {item.label}
              </button>
            );
          })}
        </div>

        <div className="management-history-bars">
          {historyColumns.map((item) => (
            <div key={item.key} className="history-bar-row">
              <span>{item.label}</span>
              <div className="history-bar-track">
                <i
                  style={{
                    width: `${Math.max(6, (filteredSummary[item.key] / peakValue) * 100)}%`
                  }}
                />
              </div>
              <small>{filteredSummary[item.key].toLocaleString()}</small>
            </div>
          ))}
        </div>

        <div className="management-history-report-row">
          <input
            value={reportName}
            onChange={(event) => setReportName(event.target.value)}
            placeholder="报表名(保存当前视图+区间)"
          />
          <button type="button" className="management-primary-button" onClick={saveReport} disabled={busy}>
            <Save size={15} />
            保存为报表
          </button>
          <span className="management-history-hint">
            当前选中 {selectedTotal.toLocaleString()} 行 · 已保存 {reports.length} 个报表
          </span>
        </div>
      </section>

      {message ? <p className="management-message">{message}</p> : null}

      <section className="table-panel management-table-panel">
        <div className="panel-toolbar">
          <div>
            <strong>历史数据清单</strong>
            <span>按上传时间倒序展示；保留策略可在上方直接调整。</span>
          </div>
          <div className="table-count">{records.length} 条</div>
        </div>
        <div className="table-wrap">
          <table className="management-table history-table">
            <thead>
              <tr>
                <th>上传时间</th>
                <th>数据区间</th>
                <th>商品</th>
                <th>推广商品</th>
                <th>推广内容</th>
                <th>关键词</th>
                <th>人群</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td>
                    <strong>{formatDateTime(record.uploadAt)}</strong>
                  </td>
                  <td>{record.dataRangeStart} ~ {record.dataRangeEnd}</td>
                  <td>{record.counts.product.toLocaleString()}</td>
                  <td>{record.counts.promotionProduct.toLocaleString()}</td>
                  <td>{record.counts.promotionContent.toLocaleString()}</td>
                  <td>{record.counts.keyword.toLocaleString()}</td>
                  <td>{record.counts.audience.toLocaleString()}</td>
                  <td>{record.reportName ?? record.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

function buildSummary(records: ManagementHistoryState["records"]) {
  return records.reduce(
    (accumulator, record) => {
      for (const column of historyColumns) {
        accumulator[column.key] += record.counts[column.key] ?? 0;
      }
      return accumulator;
    },
    {
      product: 0,
      promotionProduct: 0,
      promotionContent: 0,
      keyword: 0,
      audience: 0
    }
  );
}

function sumSelectedColumns(
  summary: ReturnType<typeof buildSummary>,
  keys: HistoryDataKey[]
) {
  return keys.reduce((total, key) => total + summary[key], 0);
}

function formatDateTime(value: string) {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function initialDate(value: string | undefined) {
  return value ?? new Date().toISOString().slice(0, 10);
}
