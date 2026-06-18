"use client";

import { FileSpreadsheet, Layers } from "lucide-react";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface MergeReport {
  fileCount: number;
  dateStart: string;
  dateEnd: string;
  totalDataRows: number;
  headerColumnCount: number;
  distinctDates: number;
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function ShengyiMergePanel() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [shopName, setShopName] = useState("");
  const [expectedStart, setExpectedStart] = useState("");
  const [expectedEnd, setExpectedEnd] = useState("");
  const [report, setReport] = useState<MergeReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  function pickFiles(selected: FileList | null) {
    setFiles(selected ? Array.from(selected) : []);
    setReport(null);
    setMessage("");
  }

  function buildForm(dryRun: boolean): FormData {
    const form = new FormData();
    if (dryRun) form.set("dryRun", "1");
    if (expectedStart) form.set("expectedStart", expectedStart);
    if (expectedEnd) form.set("expectedEnd", expectedEnd);
    if (shopName) form.set("shopName", shopName);
    for (const file of files) form.append("files", file);
    return form;
  }

  async function run(dryRun: boolean) {
    if (files.length === 0) {
      setMessage("请先选择生意参谋日表文件");
      return;
    }
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/import-batches/merge-shengyi", {
      method: "POST",
      body: buildForm(dryRun)
    });
    const payload = (await response.json().catch(() => null)) as
      | { data?: { report: MergeReport }; error?: string; report?: MergeReport }
      | null;
    setBusy(false);
    const rep = payload?.data?.report ?? payload?.report ?? null;
    if (rep) setReport(rep);
    if (!response.ok) {
      setMessage(payload?.error ?? "处理失败");
      return;
    }
    if (dryRun) {
      setMessage(rep?.ok ? "校验通过，可直接合并。" : "预检发现问题，请修正后再合并。");
    } else {
      setMessage(`已合并 ${rep?.fileCount ?? files.length} 个日表（${rep?.totalDataRows ?? 0} 行）并应用为商品维度源表。`);
      setFiles([]);
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    }
  }

  function clearAll() {
    setFiles([]);
    setReport(null);
    setMessage("");
    if (inputRef.current) inputRef.current.value = "";
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
          <input type="date" value={expectedStart} onChange={(e) => setExpectedStart(e.target.value)} />
        </label>
        <label>
          结束日期（可选，校验缺失）
          <input type="date" value={expectedEnd} onChange={(e) => setExpectedEnd(e.target.value)} />
        </label>
      </div>

      <div className="merge-actions">
        <button type="button" className="outline-button" onClick={() => run(true)} disabled={busy}>
          {busy ? "处理中…" : "预检"}
        </button>
        <button type="button" onClick={() => run(false)} disabled={busy || (report !== null && !report.ok)}>
          执行合并并应用为商品维度源表
        </button>
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
