"use client";

import { CheckCircle2, Clipboard, Download, FileText } from "lucide-react";
import { useMemo, useState } from "react";
import { buildCustomerCommunicationReport } from "@/lib/customer-report";
import type { BusinessDiagnosisSnapshot } from "@/lib/business-diagnosis";

export function CustomerReportExport({ snapshot }: { snapshot: BusinessDiagnosisSnapshot }) {
  const report = useMemo(() => buildCustomerCommunicationReport(snapshot), [snapshot]);
  const [message, setMessage] = useState("");

  function downloadReport() {
    window.location.assign("/api/business-diagnosis/html-report");
    setMessage("HTML 报告已生成并下载，可直接发给客户或在浏览器中打印为 PDF。");
  }

  async function copyTalkTrack() {
    try {
      await navigator.clipboard.writeText(report.customerTalkTrack.map((line, index) => `${index + 1}. ${line}`).join("\n"));
      setMessage("客户沟通话术已复制。");
    } catch {
      setMessage("复制失败，请在下载的 HTML 报告中复制沟通话术。");
    }
  }

  return (
    <section className="business-panel customer-report-export">
      <div className="panel-toolbar">
        <div>
          <strong><FileText size={16} /> 客户沟通版 HTML 报告</strong>
          <span>每次导入并合并业务诊断源表后，自动按当前数据生成；不依赖 AI。</span>
        </div>
        <span className={report.readiness === "ready" ? "customer-report-badge ready" : "customer-report-badge"}>
          {report.readinessLabel}
        </span>
      </div>
      <div className="customer-report-conclusion">
        <strong>核心结论</strong>
        <p>{report.conclusion}</p>
      </div>
      <div className="customer-report-actions">
        <button type="button" className="management-primary-button" onClick={downloadReport}>
          <Download size={16} /> 下载 HTML 报告
        </button>
        <button type="button" className="secondary-button" onClick={copyTalkTrack}>
          <Clipboard size={16} /> 复制客户话术
        </button>
      </div>
      {message ? <p className="customer-report-message"><CheckCircle2 size={15} /> {message}</p> : null}
    </section>
  );
}
