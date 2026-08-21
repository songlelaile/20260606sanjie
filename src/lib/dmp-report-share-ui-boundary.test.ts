import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const reportWorkspaceSource = readFileSync(
  new URL("../components/tools/DmpReportWorkspace.tsx", import.meta.url),
  "utf8"
);
const managementConsoleSource = readFileSync(
  new URL("../components/management/ManagementConsole.tsx", import.meta.url),
  "utf8"
);
const adminAnalyticsPanelSource = readFileSync(
  new URL("../components/management/DmpShareAnalyticsPanel.tsx", import.meta.url),
  "utf8"
);
const sharedReportClientSource = readFileSync(
  new URL("../components/tools/DmpSharedReportClient.tsx", import.meta.url),
  "utf8"
);
const ownerShareRouteSource = readFileSync(
  new URL("../app/api/dmp-report-shares/route.ts", import.meta.url),
  "utf8"
);
const shareStoreSource = readFileSync(
  new URL("./dmp-report-share.ts", import.meta.url),
  "utf8"
);

describe("DMP share analytics UI boundary", () => {
  it("keeps analytics out of the ordinary report workspace", () => {
    expect(reportWorkspaceSource).not.toContain("DmpShareAnalytics");
    expect(reportWorkspaceSource).not.toContain("DmpReportInteractionSummary");
    expect(reportWorkspaceSource).not.toContain("分享行为与点击热区");
    expect(reportWorkspaceSource).not.toContain("/api/dmp-report-shares?reportId=");
  });

  it("keeps report sharing available without exposing analytics", () => {
    expect(reportWorkspaceSource).toContain("/api/dmp-report-shares");
    expect(reportWorkspaceSource).toContain("复制分享链接");
    expect(ownerShareRouteSource).not.toContain("export async function GET");
    expect(ownerShareRouteSource).not.toContain("getDmpReportInteractionSummary");
  });

  it("exposes propagation analytics only through the management console", () => {
    expect(managementConsoleSource).toContain("DmpShareAnalyticsPanel");
    expect(managementConsoleSource).toContain("传播分析");
    expect(adminAnalyticsPanelSource).toContain("/api/management/dmp-report-share-analytics");
    expect(adminAnalyticsPanelSource).toContain("报告传播与关注度分析");
  });

  it("waits for a committed view and preserves cumulative active time across refreshes", () => {
    expect(sharedReportClientSource).toContain("viewGate");
    expect(sharedReportClientSource).toContain("sendAfterView");
    expect(sharedReportClientSource).toContain("if (beacon) return");
    expect(sharedReportClientSource).toContain("dmp-share-active:${token}:${sessionId}");
    expect(sharedReportClientSource).toContain("readPersistedActiveMs");
    expect(sharedReportClientSource).toContain("persistActiveMs");
  });

  it("tracks the fixed shared viewer's own scroll root and keeps a window fallback", () => {
    expect(sharedReportClientSource).toContain("SHARED_SCROLL_ROOT_SELECTOR");
    expect(sharedReportClientSource).toContain("document.querySelector<HTMLElement>(SHARED_SCROLL_ROOT_SELECTOR)");
    expect(sharedReportClientSource).toContain('scrollRoot.addEventListener("scroll", onScroll');
    expect(sharedReportClientSource).toContain('scrollRoot.removeEventListener("scroll", onScroll)');
    expect(sharedReportClientSource).toContain('window.addEventListener("scroll", onScroll');
    expect(sharedReportClientSource).toContain("currentScrollDepth(scrollRoot)");
  });

  it("uses an execute-only advisory lock so Prisma never deserializes PostgreSQL void", () => {
    expect(shareStoreSource).toContain("$executeRaw`SELECT pg_advisory_xact_lock");
    expect(shareStoreSource).not.toContain("$queryRaw`SELECT pg_advisory_xact_lock");
  });
});
