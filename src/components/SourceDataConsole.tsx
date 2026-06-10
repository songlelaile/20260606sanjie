"use client";

import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  Trash2,
  UploadCloud,
  X
} from "lucide-react";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { reportContracts } from "@/lib/imports/contracts";
import { formatNumber } from "@/lib/format";
import {
  formatStorageSize,
  getImportBatchesSize,
  retentionPolicy,
  validateTenantDatasetSize
} from "@/lib/retention-policy";
import type { ImportBatch, ReportType } from "@/lib/types/domain";
import { StatusPill } from "@/components/StatusPill";

const sourceSlots: Array<{
  reportType: ReportType;
  title: string;
  accept: string;
  format: string;
}> = [
  {
    reportType: "product_source",
    title: "商品源数据",
    accept: ".xlsx,.xls",
    format: "XLSX / XLS"
  },
  {
    reportType: "damo_product_source",
    title: "达摩盘货品源",
    accept: ".xlsx,.xls,.csv",
    format: "XLSX / CSV"
  },
  {
    reportType: "promotion_product_source",
    title: "无界推广宝贝",
    accept: ".csv,.xlsx,.xls",
    format: "CSV / XLSX"
  },
  {
    reportType: "audience_source",
    title: "无界人群报表",
    accept: ".csv,.xlsx,.xls",
    format: "CSV / XLSX"
  }
];

export function SourceDataConsole({ initialBatches }: { initialBatches: ImportBatch[] }) {
  const router = useRouter();
  const [batches, setBatches] = useState(initialBatches);
  const [files, setFiles] = useState<Partial<Record<ReportType, File>>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<{
    title: string;
    lines: string[];
    tone: "warn" | "bad";
  } | null>(null);

  const timeline = useMemo(() => buildTimeline(batches), [batches]);
  const savedBytes = useMemo(() => getImportBatchesSize(batches), [batches]);
  const selectedBytes = useMemo(
    () => Object.values(files).reduce((total, file) => total + (file?.size ?? 0), 0),
    [files]
  );

  async function uploadAndRecalculate() {
    const selectedEntries = Object.entries(files) as Array<[ReportType, File]>;
    if (selectedEntries.length === 0) {
      setDialog({
        title: "未选择源表",
        lines: ["请至少选择一份源表后再上传。"],
        tone: "warn"
      });
      return;
    }

    const sizeError = validateTenantDatasetSize(selectedBytes);
    if (sizeError) {
      setDialog({
        title: "数据集超过保存上限",
        lines: [sizeError],
        tone: "bad"
      });
      return;
    }

    setBusy(true);
    setNotice("");
    // 租户端仅保留最新一次源数据：上传前自动清空旧数据，无需用户先手动点“清空源数据”。
    if (batches.length > 0) {
      await fetch("/api/import-batches", { method: "DELETE" });
      setBatches([]);
    }
    const uploaded: ImportBatch[] = [];
    const failures: string[] = [];
    const validationErrors: string[] = [];
    const warnings: string[] = [];
    const datasetId = createDatasetId();

    for (const [reportType, file] of selectedEntries) {
      const formData = new FormData();
      formData.set("reportType", reportType);
      formData.set("datasetId", datasetId);
      formData.set("datasetTotalBytes", String(selectedBytes));
      formData.set("fileSizeBytes", String(file.size));
      formData.set("file", file);
      const response = await fetch("/api/import-batches", {
        method: "POST",
        body: formData
      });
      const payload = (await response.json()) as { data?: { batch: ImportBatch }; error?: string };
      if (payload.data?.batch) {
        const batch = payload.data.batch;
        uploaded.push(batch);
        if (!batch.validation.ok) {
          validationErrors.push(...batch.validation.errors);
        }
        warnings.push(...batch.validation.warnings);
      } else {
        failures.push(payload.error ?? `${file.name} 上传失败`);
      }
    }

    setBatches(uploaded);

    // 仅当上传失败或校验未通过(error)时才阻断重算；
    // “已自动归并、未闭合引号”等提示(warning)不阻断，照常重算。
    const blocking = [...failures, ...validationErrors];
    if (blocking.length > 0) {
      setDialog({
        title: "部分源表未通过校验",
        lines: blocking,
        tone: "bad"
      });
      setBusy(false);
      return;
    }

    await fetch("/api/calc-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cycleId: "cycle-2026-05" })
    });
    setFiles({});
    setBusy(false);
    router.refresh();
    if (warnings.length > 0) {
      setDialog({
        title: "已上传并重算",
        lines: [...warnings, "看板已按新数据重算，切换到看板页即可查看。"],
        tone: "warn"
      });
    } else {
      setNotice(`已上传 ${uploaded.length} 份源表并重算，切换到看板页查看结果。`);
    }
  }

  async function clearSourceData() {
    setBusy(true);
    await fetch("/api/import-batches", { method: "DELETE" });
    setBatches([]);
    setNotice("源数据已清空。");
    setBusy(false);
  }

  return (
    <>
      <section className="source-panel">
        <div className="source-panel-title">
          <div>
            <span>数据接入</span>
            <h2>自定义上传源表</h2>
          </div>
          <small>
            <FolderOpen size={15} />
            上传目录：/app/uploads/source-data/1
          </small>
        </div>
        <div className="retention-strip">
          <b>租户端保留</b>
          <span>仅保存最新 1 次源数据</span>
          <span>单次上限 {retentionPolicy.tenantMaxDatasetMegabytes}MB</span>
          <span>当前已保存 {formatStorageSize(savedBytes)}</span>
          <span>本次待上传 {formatStorageSize(selectedBytes)}</span>
        </div>
        <div className="source-upload-grid">
          {sourceSlots.map((slot) => (
            <label className="source-upload-slot" key={slot.reportType}>
              <span>{slot.title}</span>
              <strong>{files[slot.reportType]?.name ?? "选择文件"}</strong>
              <small>{slot.format}</small>
              <input
                type="file"
                accept={slot.accept}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    setFiles((current) => ({ ...current, [slot.reportType]: file }));
                  }
                }}
              />
            </label>
          ))}
        </div>
        <div className="source-actions">
          <button type="button" onClick={uploadAndRecalculate} disabled={busy}>
            <UploadCloud size={17} />
            {busy ? "处理中" : "上传并重算"}
          </button>
          <button type="button" className="secondary-button" onClick={clearSourceData} disabled={busy || batches.length === 0}>
            <Trash2 size={17} />
            清空源数据
          </button>
          {notice ? (
            <p className="form-message success">
              <CheckCircle2 size={16} />
              {notice}
            </p>
          ) : null}
        </div>
      </section>

      <section className="source-panel">
        <div className="source-panel-title">
          <div>
            <span>数据接入</span>
            <h2>源表状态</h2>
          </div>
          <small>/app/data/source-data</small>
        </div>
        <div className="source-timeline">
          <div className="timeline-summary">
            <StatusPill tone={timeline.aligned ? "good" : "warn"}>
              {timeline.aligned ? "时间线・对齐" : "时间线・待核验"}
            </StatusPill>
            <span>{timeline.summary}</span>
          </div>
          {timeline.rows.map((row) => (
            <div className="timeline-bar-row" key={row.label}>
              <span>{row.label}</span>
              <div>
                <i style={{ width: `${row.coverage}%` }} />
              </div>
              <small>{row.range}</small>
            </div>
          ))}
          <div className="timeline-axis">
            <span>{timeline.start}</span>
            <span>{timeline.end}</span>
          </div>
        </div>
      </section>

      <section className="table-panel source-table-panel">
        <div className="panel-toolbar">
          <div>
            <strong>源表状态清单</strong>
            <span>校验结果会写入版本记录</span>
          </div>
          <span className="table-count">
            {batches.length === 0 ? "0 / 0" : `1-${batches.length} / ${batches.length}`}
          </span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>来源表</th>
                <th>数据模式</th>
                <th>行数</th>
                <th>文件大小</th>
                <th>日期字段</th>
                <th>开始日期</th>
                <th>结束日期</th>
                <th>文件路径</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((batch) => {
                const contract = reportContracts[batch.reportType];
                const range = getBatchDateRange(batch, timeline.inferredPeriod);
                return (
                  <tr key={batch.id}>
                    <td>
                      <strong>{contract.label}</strong>
                      <span>{contract.sourceSystem}</span>
                    </td>
                    <td>自定义</td>
                    <td>{formatNumber(batch.rowCount)}</td>
                    <td>{formatStorageSize(batch.fileSizeBytes)}</td>
                    <td>{contract.dateHeader ?? "无日期字段"}</td>
                    <td>{range.start}</td>
                    <td>{range.end}</td>
                    <td>/app/uploads/source-data/1/{batch.fileName}</td>
                    <td>
                      <StatusPill tone={batch.validation.ok ? "good" : "bad"}>
                        {batch.validation.ok ? "通过" : "失败"}
                      </StatusPill>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {dialog ? (
        <div className="modal-backdrop" role="presentation">
          <section className="validation-modal" role="dialog" aria-modal="true" aria-labelledby="source-dialog-title">
            <header>
              <span className={`modal-icon ${dialog.tone}`}>
                <AlertTriangle size={21} />
              </span>
              <div>
                <h2 id="source-dialog-title">{dialog.title}</h2>
                <p>源表上传校验</p>
              </div>
              <button type="button" className="icon-button" onClick={() => setDialog(null)} aria-label="关闭">
                <X size={18} />
              </button>
            </header>
            <div className="modal-content">
              {dialog.lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
            <footer>
              <button type="button" onClick={() => setDialog(null)}>
                知道了
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}

function createDatasetId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `dataset-${crypto.randomUUID()}`;
  }
  return `dataset-${Date.now()}`;
}

function buildTimeline(batches: ImportBatch[]) {
  const explicitRanges = batches.map(getExplicitBatchDateRange).filter((range) => range !== null);
  const inferredPeriod = getIntersectionRange(explicitRanges) ?? getUnionRange(explicitRanges);
  const rows = sourceSlots.map((slot) => {
    const batch = batches.find((item) => item.reportType === slot.reportType);
    const range = batch ? getBatchDateRange(batch, inferredPeriod) : { start: "待上传", end: "待上传" };
    return {
      label: slot.title,
      range: batch ? `${range.start} ~ ${range.end}` : "待上传",
      coverage: batch?.validation.ok ? 100 : batch ? 42 : 0,
      start: range.start,
      end: range.end
    };
  });
  const uploadedRows = rows.filter((row) => row.start !== "待上传");
  const uploadedRanges = uploadedRows
    .map((row) => parseDateRangeValue(`${row.start} ~ ${row.end}`))
    .filter((range) => range !== null);
  const commonRange = getIntersectionRange(uploadedRanges);
  const unionRange = getUnionRange(uploadedRanges);
  const start = commonRange?.start ?? unionRange?.start ?? "待上传";
  const end = commonRange?.end ?? unionRange?.end ?? "待上传";
  const aligned =
    uploadedRows.length > 0 &&
    commonRange !== null &&
    unionRange !== null &&
    commonRange.start === unionRange.start &&
    commonRange.end === unionRange.end;
  return {
    rows,
    start,
    end,
    aligned,
    inferredPeriod,
    summary:
      uploadedRows.length === 0
        ? "暂无源表"
        : `共同区间 ${start} ~ ${end}（并集 ${unionRange?.start ?? start} ~ ${unionRange?.end ?? end}）`
  };
}

function getBatchDateRange(batch: ImportBatch, fallback?: DateRange | null) {
  return getExplicitBatchDateRange(batch) ?? fallback ?? { start: "待识别", end: "待识别" };
}

interface DateRange {
  start: string;
  end: string;
}

function getExplicitBatchDateRange(batch: ImportBatch): DateRange | null {
  const ranges = [...batch.validation.dateValues, batch.fileName]
    .map(parseDateRangeValue)
    .filter((range) => range !== null);
  return getUnionRange(ranges);
}

function getIntersectionRange(ranges: DateRange[]) {
  if (ranges.length === 0) {
    return null;
  }
  const start = ranges.map((range) => range.start).sort().at(-1)!;
  const end = ranges.map((range) => range.end).sort()[0]!;
  return start <= end ? { start, end } : null;
}

function getUnionRange(ranges: DateRange[]) {
  if (ranges.length === 0) {
    return null;
  }
  const start = ranges.map((range) => range.start).sort()[0]!;
  const end = ranges.map((range) => range.end).sort().at(-1)!;
  return { start, end };
}

function parseDateRangeValue(value: string) {
  const text = value.trim();
  if (text === "") {
    return null;
  }

  const compactRange = text.match(/(\d{8})\s*(?:至|~|－|-|—|–)\s*(\d{8})/);
  if (compactRange) {
    return {
      start: formatCompactDate(compactRange[1]),
      end: formatCompactDate(compactRange[2])
    };
  }

  const dashedDates = text.match(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g);
  if (dashedDates && dashedDates.length > 0) {
    const dates = dashedDates.map(formatLooseDate).sort();
    return {
      start: dates[0],
      end: dates[dates.length - 1]
    };
  }

  const compactDates = text.match(/\b\d{8}\b/g);
  if (compactDates && compactDates.length > 0) {
    const dates = compactDates.map(formatCompactDate).sort();
    return {
      start: dates[0],
      end: dates[dates.length - 1]
    };
  }
  return null;
}

function formatLooseDate(value: string) {
  const [year, month, day] = value.split(/[-/.]/);
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function formatCompactDate(value: string) {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}
