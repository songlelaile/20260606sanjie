import { describe, expect, it } from "vitest";
import { buildBusinessDiagnosisSnapshot, getBusinessDiagnosisSource } from "@/lib/business-diagnosis";
import { buildCustomerCommunicationReport, buildCustomerReportHtml } from "@/lib/customer-report";

describe("customer HTML report", () => {
  it("makes a deterministic, customer-facing conclusion from imported diagnosis data", () => {
    const snapshot = buildBusinessDiagnosisSnapshot(getBusinessDiagnosisSource());
    const report = buildCustomerCommunicationReport(snapshot);
    const html = buildCustomerReportHtml(snapshot);

    expect(report.title).toContain("可支持店内诊断");
    expect(report.conclusion).toContain("支付额");
    expect(report.conclusion).toContain("净销售");
    expect(report.customerTalkTrack).toHaveLength(3);
    expect(report.actions.length).toBeGreaterThan(0);
    expect(report.boundaries.join(" ")).toContain("月份");
    expect(html).toContain("店铺经营数据沟通报告");
    expect(html).toContain("核心结论");
    expect(html).toContain("建议与客户直接沟通");
  });

  it("refuses a store-wide conclusion when the reliable total row is missing", () => {
    const source = structuredClone(getBusinessDiagnosisSource());
    source.storeCategoryRows = source.storeCategoryRows.filter(
      (row) => !(row.categoryName === row.level1Category && row.categoryName === row.level2Category)
    );
    const report = buildCustomerCommunicationReport(buildBusinessDiagnosisSnapshot(source));

    expect(report.readiness).toBe("partial");
    expect(report.title).toContain("不足");
    expect(report.conclusion).toContain("不能把叶子类目访客、买家直接相加");
  });
});
