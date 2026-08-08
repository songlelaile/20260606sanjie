"use client";

import { FileSpreadsheet, Layers } from "lucide-react";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { locateHeaderRow, validateImportRows } from "@/lib/imports/contracts";
import { mapProductDailyRows } from "@/lib/imports/map-rows";
import {
  buildShengyiMergePlan,
  type ParsedShengyiFile,
  type ShengyiMergePlan,
  type ShengyiMergeReport
} from "@/lib/imports/merge-shengyi";
import { parseWorkbookUpload } from "@/lib/imports/parse-workbook";
import type { ImportBatch, ImportValidationResult } from "@/lib/types/domain";

interface CachedPlan {
  key: string;
  totalBytes: number;
  plan: ShengyiMergePlan;
}

export function ShengyiMergePanel() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const planRef = useRef<CachedPlan | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [shopName, setShopName] = useState("");
  const [expectedStart, setExpectedStart] = useState("");
  const [expectedEnd, setExpectedEnd] = useState("");
  const [report, setReport] = useState<ShengyiMergeReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  function resetPlan() {
    planRef.current = null;
    setReport(null);
    setMessage("");
  }

  function pickFiles(selected: FileList | null) {
    setFiles(selected ? Array.from(selected) : []);
    resetPlan();
  }

  async function run(dryRun: boolean) {
    if (files.length === 0) {
      setMessage("请先选择生意参谋日表文件");
      return;
    }
    setBusy(true);
    setMessage(dryRun ? "正在解析并预检…" : "正在合并并分批写入…");
    try {
      const cached = await getMergePlan();
      const rep = cached.plan.report;
      setReport(rep);
      if (dryRun || !rep.ok) {
        setMessage(rep.ok ? "校验通过，可直接合并。" : "预检发现问题，请修正后再合并。");
        return;
      }

      const validation = validateImportRows("product_source", cached.plan.mergedHeaders, cached.plan.mergedRows);
      if (!validation.ok) {
        setMessage(validation.errors.join("；") || "合并数据校验未通过");
        return;
      }

      const mapped = mapProductDailyRows(cached.plan.mergedHeaders, cached.plan.mergedRows);
      if (mapped.length === 0) {
        setMessage("合并后没有可识别统计日期的有效数据行，请确认统计日期列格式。");
        return;
      }

      const fileName = `生意参谋合并_${rep.dateStart}~${rep.dateEnd}_${rep.fileCount}日.xlsx`;
      await ingestProductRows({
        fileName,
        fileSizeBytes: cached.totalBytes,
        datasetTotalBytes: cached.totalBytes,
        rows: mapped,
        validation
      });
      setMessage(`已合并 ${rep.fileCount} 个日表（${rep.totalDataRows} 行）并应用为商品维度源表。`);
      clearSelectedFiles();
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "处理失败");
    } finally {
      setBusy(false);
    }
  }

  async function getMergePlan(): Promise<CachedPlan> {
    const key = buildPlanKey(files, expectedStart, expectedEnd);
    if (planRef.current?.key === key) {
      return planRef.current;
    }
    const parsed: ParsedShengyiFile[] = [];
    let totalBytes = 0;
    for (const file of files) {
      totalBytes += file.size;
      const result = await parseWorkbookUpload(file);
      const { headers, rows } = locateHeaderRow(result.matrix, "product_source");
      parsed.push({ name: file.name, headers, rows });
    }
    const plan = buildShengyiMergePlan(parsed, { expectedStart, expectedEnd });
    const cached = { key, totalBytes, plan };
    planRef.current = cached;
    return cached;
  }

  function clearSelectedFiles() {
    setFiles([]);
    planRef.current = null;
    if (inputRef.current) inputRef.current.value = "";
  }

  function clearAll() {
    clearSelectedFiles();
    setReport(null);
    setMessage("");
  }

  return (
    <section className="merge-panel">
      <div className="merge-head">
        <span className="merge-eyebrow">
          <Layers size={14} /> 数据接入 · 自动合并
        </span>
        <strong>生意参谋多日表合并</strong>
        <span className="merge-desc">
          选择一批 <b>【生意参谋平台】商品_全部_YYYY-MM-DD_.xls</b> 日表，先预检（日期完整性 / 表头一致 /
          统计日期匹配 / 重复日期），确认无误后合并成单个源表并应用为「商品维度」分日源。
        </span>
      </div>

      <label className="merge-dropzone">
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".xls,.xlsx"
          onChange={(event) => pickFiles(event.target.files)}
        />
        <FileSpreadsheet size={22} />
        <span className="merge-dropzone-title">
          {files.length > 0 ? `已选 ${files.length} 个文件` : "点击选择生意参谋日表（可多选）"}
        </span>
        <span className="merge-dropzone-hint">.xls / .xlsx</span>
      </label>

      <div className="merge-fields">
        <label>
          店铺 / 品牌名（可选）
          <input value={shopName} onChange={(e) => setShopName(e.target.value)} placeholder="如 whc" />
        </label>
        <label>
          开始日期（可选，校验缺失）
          <input
            type="date"
            value={expectedStart}
            onChange={(e) => {
              setExpectedStart(e.target.value);
              resetPlan();
            }}
          />
        </label>
        <label>
          结束日期（可选，校验缺失）
          <input
            type="date"
            value={expectedEnd}
            onChange={(e) => {
              setExpectedEnd(e.target.value);
              resetPlan();
            }}
          />
        </label>
      </div>

      <div className="merge-actions">
        <button type="button" className="outline-button" onClick={() => run(true)} disabled={busy}>
          {busy ? "处理中…" : "预检"}
        </button>
        {/* 合并按钮预检通过后才跳出，强制先预检 */}
        {report?.ok ? (
          <button type="button" onClick={() => run(false)} disabled={busy}>
            执行合并并应用为商品维度源表
          </button>
        ) : null}
        <button type="button" className="outline-button" onClick={clearAll} disabled={busy}>
          清除
        </button>
      </div>

      {report ? (
        <div className="merge-report">
          <div className="merge-summary">
            文件数 <b>{report.fileCount}</b>　·　识别日期{" "}
            <b>
              {report.dateStart || "—"} ~ {report.dateEnd || "—"}
            </b>
            　·　合计数据行 <b>{report.totalDataRows.toLocaleString()}</b>　·　表头列数{" "}
            <b>{report.headerColumnCount}</b>　·　不同日期 <b>{report.distinctDates}</b>
          </div>
          {report.errors.map((e, i) => (
            <p key={`e${i}`} className="merge-line error">
              ✕ {e}
            </p>
          ))}
          {report.warnings.map((w, i) => (
            <p key={`w${i}`} className="merge-line warn">
              ⚠ {w}
            </p>
          ))}
        </div>
      ) : null}

      {message ? (
        <p className={report && !report.ok ? "merge-line error" : "merge-ok"}>{message}</p>
      ) : null}
    </section>
  );
}

function buildPlanKey(files: File[], expectedStart: string, expectedEnd: string) {
  const fileKey = files.map((file) => `${file.name}:${file.size}:${file.lastModified}`).join("|");
  return `${expectedStart}~${expectedEnd}::${fileKey}`;
}

function createDatasetId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `dataset-${crypto.randomUUID()}`;
  }
  return `dataset-${Date.now()}`;
}

const INGEST_CHUNK = 5000;

async function ingestProductRows(input: {
  fileName: string;
  fileSizeBytes: number;
  datasetTotalBytes: number;
  rows: unknown[];
  validation: ImportValidationResult;
}): Promise<ImportBatch | null> {
  const sessionId = createDatasetId();
  const total = Math.max(1, Math.ceil(input.rows.length / INGEST_CHUNK));
  let batch: ImportBatch | null = null;

  for (let i = 0; i < total; i += 1) {
    const chunk = input.rows.slice(i * INGEST_CHUNK, (i + 1) * INGEST_CHUNK);
    const isLast = i === total - 1;
    const body = JSON.stringify({
      sessionId,
      reportType: "product_source",
      fileName: input.fileName,
      fileSizeBytes: input.fileSizeBytes,
      datasetTotalBytes: input.datasetTotalBytes,
      rows: chunk,
      index: i,
      total,
      validation: isLast ? input.validation : undefined,
      ingestedRowCount: isLast ? input.rows.length : undefined
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
        if (res.status >= 400 && res.status < 500) break;
      } catch (error) {
        lastErr = error instanceof Error ? error.message : "网络错误";
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
    if (lastErr) throw new Error(lastErr);
    if (json?.data?.batch) batch = json.data.batch;
  }

  return batch;
}
