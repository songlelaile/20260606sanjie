"use client";

import {
  AlertTriangle,
  CheckCircle2,
  FileSearch,
  FolderOpen,
  GitMerge,
  Trash2,
  UploadCloud,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { locateHeaderRow, reportContracts, validateImportRows } from "@/lib/imports/contracts";
import {
  mapAudienceDailyRows,
  mapDamoProductRows,
  inferImportDate,
  mapProductDailyRows,
  mapPromotionDailyRows
} from "@/lib/imports/map-rows";
import {
  mergeBusinessDiagnosisUploads,
  parseBusinessDiagnosisUpload,
  type BusinessDiagnosisMergeReport,
  type BusinessDiagnosisSourcePatch,
  type ParsedBusinessDiagnosisUpload
} from "@/lib/imports/business-diagnosis-source";
import { parseWorkbookUpload } from "@/lib/imports/parse-workbook";
import { formatNumber } from "@/lib/format";
import {
  formatStorageSize,
  validateTenantDatasetSize
} from "@/lib/retention-policy";
import type { ImportBatch, ImportValidationResult, ReportType } from "@/lib/types/domain";
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
  const [diagnosisFiles, setDiagnosisFiles] = useState<{
    storeCategory: File[];
    market: File[];
  }>({ storeCategory: [], market: [] });
  const [diagnosisReport, setDiagnosisReport] = useState<BusinessDiagnosisMergeReport | null>(null);
  const [diagnosisPatch, setDiagnosisPatch] = useState<BusinessDiagnosisSourcePatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [diagnosisBusy, setDiagnosisBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<{
    title: string;
    lines: string[];
    tone: "warn" | "bad";
  } | null>(null);

  // router.refresh()（本组件上传后、或合并面板应用后）会让服务端重新下发 initialBatches → 同步到本地，
  // 使「商品源数据」等槽位在已有数据时变绿。
  useEffect(() => {
    setBatches(initialBatches);
  }, [initialBatches]);

  // 服务端已存在的源表（按 reportType）：用于把对应上传槽标绿，表示"已有数据"。
  const existingByType = useMemo(() => {
    const map = new Map<ReportType, ImportBatch>();
    for (const batch of batches) {
      if (!map.has(batch.reportType)) map.set(batch.reportType, batch);
    }
    return map;
  }, [batches]);

  const timeline = useMemo(() => buildTimeline(batches), [batches]);
  const selectedBytes = useMemo(
    () => Object.values(files).reduce((total, file) => total + (file?.size ?? 0), 0),
    [files]
  );
  const diagnosisFileCount = diagnosisFiles.storeCategory.length + diagnosisFiles.market.length;
  const diagnosisFileNames = useMemo(
    () => [...diagnosisFiles.storeCategory, ...diagnosisFiles.market].map((file) => file.name),
    [diagnosisFiles]
  );

  // 从服务端拉全量源表列表，回填本地 batches（驱动各源槽的"已有数据"绿态）。
  async function refreshBatches() {
    const res = await fetch("/api/import-batches");
    const json = (await res.json().catch(() => null)) as { data?: { batches?: ImportBatch[] } } | null;
    if (json?.data?.batches) {
      setBatches(json.data.batches);
    }
  }

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
    // try/finally 保证无论上传/重算成功或抛错，busy 都会复位，不会一直卡在「处理中」。
    try {
      // 每个源类型各留最新一份：可单独上传任一源、不分先后、不覆盖其它源，上传前无需清空。
      const uploaded: ImportBatch[] = [];
      const failures: string[] = [];
      const validationErrors: string[] = [];
      const warnings: string[] = [];

      for (const [reportType, file] of selectedEntries) {
        try {
          // —— 浏览器端解析+映射：不上传原始大文件，绕开任何 body 上限 ——
          const parsed = await parseWorkbookUpload(file);
          const { headers, rows } = locateHeaderRow(parsed.matrix, reportType);
          const validation = validateImportRows(reportType, headers, rows, {
            fallbackDate: inferImportDate(file.name)
          });
          if (parsed.warnings.length > 0) {
            validation.warnings = [...validation.warnings, ...parsed.warnings];
          }
          warnings.push(...validation.warnings);
          if (!validation.ok) {
            validationErrors.push(...validation.errors);
            continue;
          }
          const mapped = mapRowsForType(reportType, headers, rows, inferImportDate(file.name));
          // 分日源全部日期不可识别 → 映射后 0 行；不建"通过"记录、不入库，明确报错。
          if (reportType !== "damo_product_source" && mapped.length === 0) {
            validationErrors.push(`${file.name}：无可识别统计日期的有效数据行（请确认日期列格式）`);
            continue;
          }
          const batch = await ingestInBatches(reportType, file, mapped, selectedBytes, validation);
          if (batch) {
            uploaded.push(batch);
          } else {
            failures.push(`${file.name} 分批上传失败`);
          }
        } catch (e) {
          failures.push(`${file.name}：${e instanceof Error ? e.message : "处理失败"}`);
        }
      }

      // 拉全量源表列表（旧+新）回填，让所有源槽即时反映，后续上传无需手动刷新页面。
      await refreshBatches();

      // 仅当上传失败或校验未通过(error)时才阻断重算；
      // “已自动归并、未闭合引号”等提示(warning)不阻断，照常重算。
      const blocking = [...failures, ...validationErrors];
      if (blocking.length > 0) {
        // 区分「传输层上传失败(413/500/网络)」与「内容校验未通过」，文案不同更准确。
        setDialog({
          title: failures.length > 0 ? "部分源表上传失败" : "部分源表未通过校验",
          lines: blocking,
          tone: "bad"
        });
        return;
      }

      // 不再写死 cycleId：由服务端按当前租户的分析周期处理（多租户隔离）。
      const calc = await fetch("/api/calc-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      if (!calc.ok) {
        const err = (await calc.json().catch(() => null)) as { error?: string } | null;
        setDialog({
          title: "已上传但重算失败",
          lines: [err?.error ?? `重算接口返回 ${calc.status}`, "源表已保存，可稍后重试或到看板手动重算。"],
          tone: "bad"
        });
        return;
      }
      setFiles({});
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
    } catch (e) {
      setDialog({
        title: "上传失败",
        lines: [e instanceof Error ? e.message : "网络错误，请重试。"],
        tone: "bad"
      });
    } finally {
      setBusy(false);
    }
  }

  function pickDiagnosisFiles(kind: "storeCategory" | "market", selected: FileList | null) {
    setDiagnosisFiles((current) => ({
      ...current,
      [kind]: selected ? Array.from(selected) : []
    }));
    setDiagnosisReport(null);
    setDiagnosisPatch(null);
    setNotice("");
  }

  async function buildDiagnosisMerge() {
    const selected = [...diagnosisFiles.storeCategory, ...diagnosisFiles.market];
    if (selected.length === 0) {
      setDialog({
        title: "未选择业务诊断源表",
        lines: ["请先选择本店类目月度源表或市场大盘诊断源。"],
        tone: "warn"
      });
      return null;
    }
    const parsedFiles: ParsedBusinessDiagnosisUpload[] = [];
    for (const file of selected) {
      try {
        const parsed = await parseWorkbookUpload(file);
        const diagnosis = parseBusinessDiagnosisUpload(file.name, parsed.matrix);
        if (parsed.warnings.length > 0) {
          diagnosis.warnings = [...diagnosis.warnings, ...parsed.warnings];
        }
        parsedFiles.push(diagnosis);
      } catch (error) {
        parsedFiles.push({
          fileName: file.name,
          kind: "unknown",
          label: "解析失败",
          rowCount: 0,
          dateRange: "未识别",
          errors: [error instanceof Error ? error.message : "文件解析失败"],
          warnings: []
        });
      }
    }
    return mergeBusinessDiagnosisUploads(parsedFiles);
  }

  async function previewDiagnosisMerge() {
    setDiagnosisBusy(true);
    setNotice("");
    try {
      const result = await buildDiagnosisMerge();
      if (!result) return;
      setDiagnosisReport(result.report);
      setDiagnosisPatch(result.patch);
      if (result.report.ok) {
        setNotice("业务诊断源表已识别完成，可合并应用到业务诊断看板。");
      }
    } finally {
      setDiagnosisBusy(false);
    }
  }

  async function applyDiagnosisMerge() {
    setDiagnosisBusy(true);
    setNotice("");
    try {
      const result =
        diagnosisReport && diagnosisPatch
          ? { report: diagnosisReport, patch: diagnosisPatch }
          : await buildDiagnosisMerge();
      if (!result) return;
      setDiagnosisReport(result.report);
      setDiagnosisPatch(result.patch);
      if (!result.report.ok) {
        setDialog({
          title: "业务诊断源表未通过识别",
          lines: result.report.errors.length > 0 ? result.report.errors : ["请检查源表格式后再合并。"],
          tone: "bad"
        });
        return;
      }
      const res = await fetch("/api/business-diagnosis/source", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...result.patch,
          fileNames: diagnosisFileNames,
          sourceNote: "由数据导入页自定义上传源表识别合并，供业务诊断看板使用。"
        })
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setDialog({
          title: "业务诊断源表保存失败",
          lines: [json?.error ?? `保存接口返回 ${res.status}`],
          tone: "bad"
        });
        return;
      }
      setNotice("业务诊断源表已合并保存，已自动生成客户沟通版 HTML 报告，可前往业务诊断下载。");
      router.refresh();
    } finally {
      setDiagnosisBusy(false);
    }
  }

  function clearDiagnosisFiles() {
    setDiagnosisFiles({ storeCategory: [], market: [] });
    setDiagnosisReport(null);
    setDiagnosisPatch(null);
    setNotice("");
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
        <div className="source-upload-grid">
          {sourceSlots.map((slot) => {
            const picked = files[slot.reportType];
            const existing = existingByType.get(slot.reportType);
            return (
              <label
                className={existing ? "source-upload-slot has-data" : "source-upload-slot"}
                key={slot.reportType}
              >
                <span>{slot.title}</span>
                <strong>
                  {picked?.name ?? (existing ? `已有数据 · ${existing.fileName}` : "选择文件")}
                </strong>
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
            );
          })}
          <label
            className={
              diagnosisFiles.storeCategory.length > 0
                ? "source-upload-slot has-data diagnosis-source-slot"
                : "source-upload-slot diagnosis-source-slot"
            }
          >
            <span>本店类目月度源表</span>
            <strong>
              {diagnosisFiles.storeCategory.length > 0
                ? `已选 ${diagnosisFiles.storeCategory.length} 个文件`
                : "选择文件"}
            </strong>
            <small>品类-标准类目 XLS / XLSX，可多月合并</small>
            <input
              type="file"
              multiple
              accept=".xlsx,.xls"
              onChange={(event) => pickDiagnosisFiles("storeCategory", event.target.files)}
            />
          </label>
          <label
            className={
              diagnosisFiles.market.length > 0
                ? "source-upload-slot has-data diagnosis-source-slot"
                : "source-upload-slot diagnosis-source-slot"
            }
          >
            <span>市场大盘诊断源</span>
            <strong>
              {diagnosisFiles.market.length > 0 ? `已选 ${diagnosisFiles.market.length} 个文件` : "选择文件"}
            </strong>
            <small>市场概况 / 价格带 / 卖点 / 搜索词</small>
            <input
              type="file"
              multiple
              accept=".xlsx,.xls"
              onChange={(event) => pickDiagnosisFiles("market", event.target.files)}
            />
          </label>
        </div>
        <div className="source-recognition-panel">
          <div className="source-recognition-head">
            <span>
              <FileSearch size={15} />
              源表识别与合并
            </span>
            {diagnosisFileCount > 0 ? <strong>待识别 {diagnosisFileCount} 个业务诊断源表</strong> : null}
          </div>
          <div className="source-recognition-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={previewDiagnosisMerge}
              disabled={busy || diagnosisBusy || diagnosisFileCount === 0}
            >
              <FileSearch size={16} />
              {diagnosisBusy ? "识别中" : "识别预览"}
            </button>
            <button
              type="button"
              onClick={applyDiagnosisMerge}
              disabled={busy || diagnosisBusy || diagnosisFileCount === 0}
            >
              <GitMerge size={16} />
              合并应用到业务诊断
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={clearDiagnosisFiles}
              disabled={busy || diagnosisBusy || diagnosisFileCount === 0}
            >
              清除业务诊断源表
            </button>
          </div>
          {diagnosisReport ? (
            <div className="source-recognition-report">
              <div className="source-recognition-summary">
                <b>{diagnosisReport.ok ? "识别通过" : "识别失败"}</b>
                <span>本店类目 {formatNumber(diagnosisReport.storeRowCount)} 行</span>
                <span>市场概况 {formatNumber(diagnosisReport.marketOverviewCount)} 行</span>
                <span>价格带 {formatNumber(diagnosisReport.priceBandCount)} 条</span>
                <span>卖点 {formatNumber(diagnosisReport.attributeSignalCount)} 条</span>
                <span>搜索词 {formatNumber(diagnosisReport.searchSignalCount)} 条</span>
              </div>
              <div className="source-recognition-files">
                {diagnosisReport.files.map((file) => (
                  <span className={file.errors.length > 0 ? "bad" : "good"} key={file.fileName}>
                    {file.label} · {file.fileName} · {file.dateRange} · {formatNumber(file.rowCount)} 行
                  </span>
                ))}
              </div>
              {[...diagnosisReport.errors, ...diagnosisReport.warnings].slice(0, 8).map((line, index) => (
                <p className={diagnosisReport.errors.includes(line) ? "merge-line error" : "merge-line warn"} key={`${line}-${index}`}>
                  {line}
                </p>
              ))}
            </div>
          ) : null}
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
              <Link href="/dashboards/business-diagnosis">查看诊断与 HTML 报告</Link>
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
          {timeline.hasAny ? (
            <>
              {timeline.rows
                .filter((row) => row.hasData)
                .map((row) => (
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
            </>
          ) : (
            <p className="timeline-empty">暂无已导入的源表，上传后这里显示各源的数据区间。</p>
          )}
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

/** 浏览器端把表头+数据行映射成可入库的行（商品/推广/人群→分日行；达摩盘→货品快照行）。 */
function mapRowsForType(reportType: ReportType, headers: string[], rows: unknown[][], fallbackDate: string): unknown[] {
  if (reportType === "product_source") return mapProductDailyRows(headers, rows, fallbackDate);
  if (reportType === "promotion_product_source") return mapPromotionDailyRows(headers, rows, fallbackDate);
  if (reportType === "audience_source") return mapAudienceDailyRows(headers, rows, fallbackDate);
  if (reportType === "damo_product_source") return mapDamoProductRows(headers, rows);
  return [];
}

const INGEST_CHUNK = 500;

/**
 * 把映射后的行分批 POST 到 /ingest，末批收尾返回 batch。
 * 达摩盘是整批快照(整批落 blob)，不能按行拆批 → 一次传完，避免只存到最后一批。
 * 每批对瞬时错误(网络/5xx)重试 3 次，降低"中途失败留半份数据"的概率。
 */
async function ingestInBatches(
  reportType: ReportType,
  file: File,
  mapped: unknown[],
  datasetTotalBytes: number,
  validation: ImportValidationResult
): Promise<ImportBatch | null> {
  const sessionId = createDatasetId();
  const chunkSize = reportType === "damo_product_source" ? Math.max(1, mapped.length) : INGEST_CHUNK;
  const total = Math.max(1, Math.ceil(mapped.length / chunkSize));
  let batch: ImportBatch | null = null;
  for (let i = 0; i < total; i += 1) {
    const chunk = mapped.slice(i * chunkSize, (i + 1) * chunkSize);
    const isLast = i === total - 1;
    const body = JSON.stringify({
      sessionId,
      reportType,
      fileName: file.name,
      fileSizeBytes: file.size,
      datasetTotalBytes,
      rows: chunk,
      index: i,
      total,
      validation: isLast ? validation : undefined,
      ingestedRowCount: isLast ? mapped.length : undefined
    });
    type IngestResp = { data?: { batch?: ImportBatch }; error?: string } | null;
    let json: IngestResp = null;
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetch("/api/import-batches/ingest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body
        });
        json = (await res.json().catch(() => null)) as IngestResp;
        if (res.ok) {
          lastErr = "";
          break;
        }
        lastErr = json?.error ?? `第 ${i + 1}/${total} 批失败 (${res.status})`;
        // 4xx 是确定性错误（体积/校验/参数），不重试。
        if (res.status >= 400 && res.status < 500) break;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : "网络错误";
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    if (lastErr) throw new Error(lastErr);
    if (json?.data?.batch) batch = json.data.batch;
  }
  return batch;
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
      end: range.end,
      hasData: Boolean(batch)
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
    hasAny: uploadedRows.length > 0,
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
