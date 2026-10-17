import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workspaceSource = readFileSync(
  new URL("../components/tools/DmpReportWorkspace.tsx", import.meta.url),
  "utf8"
);
const workspaceCss = readFileSync(
  new URL("../components/tools/DmpReportWorkspace.module.css", import.meta.url),
  "utf8"
);
const reportPageSource = readFileSync(
  new URL("../app/tools/dmp-report/page.tsx", import.meta.url),
  "utf8"
);

describe("DMP report-center workspace layout", () => {
  it("keeps the existing compact library, card and viewer presentation", () => {
    for (const className of [
      "styles.library",
      "styles.libraryHeader",
      "styles.headerCopy",
      "styles.toolbar",
      "styles.shopManager",
      "styles.shopSection",
      "styles.reportGroup",
      "styles.reportGrid",
      "styles.reportCard",
      "styles.reportMain",
      "styles.cardActions",
      "styles.searchField"
    ]) expect(workspaceSource).toContain(className);
    expect(workspaceSource).toContain('aria-label="店铺档案"');
    expect(workspaceSource).toContain('type="search"');
    expect(workspaceSource).toContain('variant="preview"');
    expect(workspaceSource).toContain("group.subjectThumbnail.url");
    expect(workspaceSource).toContain('referrerPolicy="no-referrer"');

    expect(workspaceCss).toMatch(/\.workspace\s*\{[^}]*max-width\s*:/s);
    expect(workspaceCss).toMatch(/\.reportGroups\s*\{[^}]*max-height\s*:/s);
    expect(workspaceCss).toMatch(/\.reportGroups\s*\{[^}]*overflow-y\s*:\s*auto/s);
    expect(workspaceCss).toMatch(/\.reportGrid\s*\{[^}]*grid-template-columns\s*:/s);
    expect(workspaceCss).toMatch(/\.reportMain\s*\{[^}]*text-align\s*:\s*left/s);
    expect(workspaceCss).toMatch(/\.groupThumbnail\s*\{[^}]*height\s*:\s*32px[^}]*width\s*:\s*32px/s);
  });

  it("loads summary page one on every library visit and never selects the first report implicitly", () => {
    expect(reportPageSource).toContain("listDmpBusinessReportSummaries");
    expect(reportPageSource).toContain("page: 1");
    expect(reportPageSource).toContain("pageSize: REPORT_PAGE_SIZE");
    expect(reportPageSource).toContain("initialReports={listed.summaries}");
    expect(reportPageSource).toMatch(/requestedReportId\s*\?\s*getDmpBusinessReport\(context\.access, requestedReportId, context\.shop\.id\)\s*:\s*Promise\.resolve\(null\)/s);
    expect(reportPageSource).toContain('focusReport={query.view === "report"}');
    expect(reportPageSource).not.toContain("listDmpBusinessReports");
    expect(reportPageSource).not.toContain("resolveDmpReportPageSelection");
    expect(workspaceSource).toContain('useState(initialSelectedReport?.id ?? "")');
    expect(workspaceSource).not.toMatch(/initialReports\[0\]|reports\[0\]/);
  });

  it("loads one selected body with an exact shop header and lets the latest click win", () => {
    expect(workspaceSource).toContain('fetch(`/api/dmp-reports?id=${encodeURIComponent(record.id)}`');
    expect(workspaceSource).toContain('headers: { "x-sanjie-shop": activeShopId }');
    expect(workspaceSource).toContain("detailRequestSequence.current = requestSequence");
    expect(workspaceSource).toContain("detailAbortController.current?.abort()");
    expect(workspaceSource).toContain("signal: controller.signal");
    expect(workspaceSource).toContain("requestSequence !== detailRequestSequence.current || controller.signal.aborted");
    expect(workspaceSource).toContain("result.data.report.shopId !== activeShopId");
    expect(workspaceSource).toContain("正在加载报告正文");
    expect(workspaceSource).toMatch(/selectedRecord\s*\?\s*<DmpReportViewer\b[^>]*record=\{selectedRecord\}/s);
    expect(workspaceSource).not.toContain("mergeDmpReportGroupDaily");
  });

  it("uses an explicit active shop and never falls back to the first shop", () => {
    expect(reportPageSource).toContain("getActiveShopCookie");
    expect(reportPageSource).toContain("resolveDmpReportRequestContext({ shopId: activeShopId })");
    expect(reportPageSource).toContain("activeShopId={context.shop.id}");
    expect(reportPageSource).not.toContain("shopData.activeShopId");
    expect(workspaceSource).toContain("initialShops.find((shop) => shop.id === activeShopId) ?? null");
    expect(workspaceSource).toContain("nextShops.find((shop) => shop.id === activeShopId)");
    expect(workspaceSource).not.toMatch(/initialShops\[0\]|nextShops\[0\]/);
  });

  it("paginates summaries without changing the report-card layout", () => {
    expect(workspaceSource).toContain("initialPagination");
    expect(workspaceSource).toContain("pagination.hasNext");
    expect(workspaceSource).toContain("loadMoreReports");
    expect(workspaceSource).toContain("加载更多");
    expect(workspaceSource).toContain("已加载 ${reports.length} / 共 ${pagination.total} 份");
    expect(workspaceSource).toContain("styles.loadMoreRow");
    expect(workspaceCss).toContain(".loadMoreRow");
    expect(workspaceSource).not.toContain("!nextReports.some((record) => record.id === selectedId)");
  });

  it("keeps refresh, share, delete, search and shop-profile controls", () => {
    expect(workspaceSource).toContain("onClick={() => void refreshReports()}");
    expect(workspaceSource).toContain("onClick={() => void createShare(selectedRecord)}");
    expect(workspaceSource).toContain("onClick={() => void createShare(record)}");
    expect(workspaceSource).toContain("onClick={() => void deleteReport(record)}");
    expect(workspaceSource).toContain('aria-label="删除报告"');
    expect(workspaceSource).toContain("saveShopProfile");
    expect(workspaceSource).toContain("visibleShopGroups.map");
    expect(workspaceSource).toContain("mergedGroupDateRange(group.records)");
  });

  it("moves a whole identity group with the lightweight atomic request", () => {
    expect(workspaceSource).toContain("sourceShopId: activeShopId");
    expect(workspaceSource).toContain("targetShopId");
    expect(workspaceSource).toContain("reportType: group.reportType");
    expect(workspaceSource).toContain("subjectItemId: group.subjectItemId");
    expect(workspaceSource).toContain("competitorItemId: group.competitorItemId");
    expect(workspaceSource).toContain("current.filter((record) => summaryGroupKey(record) !== group.key)");
    expect(workspaceSource).toContain("Math.max(assignedIds.size, Number(assignment.count))");
    expect(workspaceSource).not.toContain("reportIds, shopId");
    expect(workspaceSource).not.toContain("dmpReportGroupIdsByShopAndIdentity");
  });

  it("retains responsive rules for the library, toolbar and cards", () => {
    expect(workspaceCss).toMatch(/@media\s*\(max-width:\s*\d+px\)/);
    expect(workspaceCss).toMatch(/@media\s*\(max-width:[^)]+\)[\s\S]*\.libraryHeader\s*,\s*\.focusToolbar\s*\{[^}]*flex-direction\s*:\s*column/s);
    expect(workspaceCss).toMatch(/@media\s*\(max-width:[^)]+\)[\s\S]*\.reportGrid\s*\{[^}]*grid-template-columns\s*:\s*1fr/s);
    expect(workspaceCss).toMatch(/@media\s*\(max-width:[^)]+\)[\s\S]*\.toolbar\s*\{/s);
  });
});
