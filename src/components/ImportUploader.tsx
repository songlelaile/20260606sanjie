"use client";

import { AlertTriangle, CheckCircle2, UploadCloud, X } from "lucide-react";
import { useState } from "react";
import { reportContracts } from "@/lib/imports/contracts";
import { validateTenantDatasetSize } from "@/lib/retention-policy";
import type { ImportBatch, ReportType } from "@/lib/types/domain";

const types = Object.values(reportContracts);

export function ImportUploader() {
  const [reportType, setReportType] = useState<ReportType>("product_source");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<{
    title: string;
    fileName?: string;
    lines: string[];
    tone: "warn" | "bad";
  } | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const file = formData.get("file");
    if (file instanceof File) {
      const sizeError = validateTenantDatasetSize(file.size);
      if (sizeError) {
        setDialog({
          title: "数据集超过保存上限",
          lines: [sizeError],
          tone: "bad"
        });
        return;
      }
      const datasetId = createDatasetId();
      formData.set("datasetId", datasetId);
      formData.set("datasetTotalBytes", String(file.size));
      formData.set("fileSizeBytes", String(file.size));
    }
    setBusy(true);
    setMessage("");
    formData.set("reportType", reportType);
    const response = await fetch("/api/import-batches", {
      method: "POST",
      body: formData
    });
    const payload = (await response.json()) as { data?: { batch: ImportBatch }; error?: string };
    setBusy(false);
    if (payload.data?.batch) {
      const batch = payload.data.batch;
      const lines = [...batch.validation.errors, ...batch.validation.warnings];
      if (!batch.validation.ok || lines.length > 0) {
        setDialog({
          title: batch.validation.ok ? "导入校验提醒" : "导入校验未通过",
          fileName: batch.fileName,
          lines: lines.length > 0 ? lines : ["请检查报表字段、日期周期和主体 ID 后重新上传。"],
          tone: batch.validation.ok ? "warn" : "bad"
        });
        setMessage("");
        return;
      }
      setMessage(`${batch.fileName}：校验通过，识别 ${batch.rowCount} 行`);
      return;
    }
    setDialog({
      title: "上传失败",
      lines: [payload.error ?? "请重新选择报表后上传。"],
      tone: "bad"
    });
  }

  return (
    <>
      <form onSubmit={submit} className="uploader">
        <label>
          报表类型
          <select value={reportType} onChange={(event) => setReportType(event.target.value as ReportType)}>
            {types.map((contract) => (
              <option key={contract.reportType} value={contract.reportType}>
                {contract.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          XLSX 文件
          <input name="file" type="file" accept=".xlsx,.xls,.csv" required />
        </label>
        <button type="submit" disabled={busy}>
          <UploadCloud size={17} />
          {busy ? "校验中" : "上传校验"}
        </button>
        {message ? (
          <p className="form-message success">
            <CheckCircle2 size={16} />
            {message}
          </p>
        ) : null}
      </form>
      {dialog ? (
        <div className="modal-backdrop" role="presentation">
          <section className="validation-modal" role="dialog" aria-modal="true" aria-labelledby="validation-title">
            <header>
              <span className={`modal-icon ${dialog.tone}`}>
                <AlertTriangle size={21} />
              </span>
              <div>
                <h2 id="validation-title">{dialog.title}</h2>
                {dialog.fileName ? <p>{dialog.fileName}</p> : null}
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
