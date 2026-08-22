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
  it("removes the explanatory path and three-column introduction completely", () => {
    expect(workspaceSource).not.toMatch(/dmp-report-path|dmp-business-strip/);
    expect(workspaceSource).not.toMatch(/使用路径|达摩盘\s*→\s*打爆路径/);
    expect(workspaceSource).not.toMatch(/双报告归档|统一保存打爆路径与竞争态势分析结果/);
    expect(workspaceSource).not.toMatch(/公开只读分享|任何拿到链接的人无需登录/);
    expect(workspaceSource).not.toMatch(/管理员传播分析|传播来源、阅读深度与关注度/);
    expect(reportPageSource).not.toContain(
      "统一沉淀打爆路径与竞争态势分析结果"
    );
  });

  it("keeps a compact, bounded and scrollable report library", () => {
    expect(workspaceSource).toContain("styles.library");
    expect(workspaceSource).toContain("styles.libraryHeader");
    expect(workspaceSource).toContain("styles.headerCopy");
    expect(workspaceSource).toContain("styles.toolbar");
    expect(workspaceSource).toContain("styles.reportGrid");
    expect(workspaceSource).toContain("styles.reportCard");
    expect(workspaceSource).toContain("styles.reportMain");
    expect(workspaceSource).toContain("styles.cardActions");
    expect(workspaceSource).toContain("styles.searchField");
    expect(workspaceSource).toMatch(/const \[query, setQuery\] = useState\(""\)/);
    expect(workspaceSource).toMatch(/const visibleReports = useMemo[\s\S]*reports\.filter/);
    expect(workspaceSource).toContain('type="search"');
    expect(workspaceSource).toContain("onChange={(event) => setQuery(event.target.value)}");

    expect(workspaceCss).toMatch(/\.workspace\s*\{[^}]*max-width\s*:/s);
    expect(workspaceCss).toMatch(/\.reportGroups\s*\{[^}]*max-height\s*:/s);
    expect(workspaceCss).toMatch(/\.reportGroups\s*\{[^}]*overflow-y\s*:\s*auto/s);
    expect(workspaceCss).toMatch(/\.reportGrid\s*\{[^}]*grid-template-columns\s*:/s);
    expect(workspaceCss).toMatch(/\.reportMain\s*\{[^}]*text-align\s*:\s*left/s);
    expect(workspaceCss).toMatch(/\.cardActions\s*\{[^}]*display\s*:\s*(?:flex|grid)/s);
  });

  it("retains report selection, refresh, sharing and deletion controls", () => {
    expect(workspaceSource).toContain("onClick={() => selectReport(record)}");
    expect(workspaceSource).toContain("aria-pressed={activeRecord?.id === record.id}");
    expect(workspaceSource).toContain("onClick={() => void refreshReports()}");
    expect(workspaceSource).toMatch(/刷新(?:历史)?/);
    expect(workspaceSource).toContain("onClick={() => void createShare(selectedRecord)}");
    expect(workspaceSource).toContain("onClick={() => void createShare(record)}");
    expect(workspaceSource).toContain("复制分享链接");
    expect(workspaceSource).toContain("onClick={() => void deleteReport(record)}");
    expect(workspaceSource).toContain('aria-label="删除报告"');
  });

  it("keeps the unified latest viewer below the compact library", () => {
    expect(workspaceSource).toContain(
      'from "@/components/tools/DmpGrowthReportViewer"'
    );
    expect(workspaceSource).toMatch(
      /selectedViewRecord\s*\?\s*<DmpGrowthReportViewer\b[^>]*record=\{selectedViewRecord\}[^>]*variant="preview"/s
    );
  });

  it("loads an explicit reportId exactly and uses the not-found boundary instead of latest fallback", () => {
    expect(reportPageSource).toContain("getDmpBusinessReport");
    expect(reportPageSource).toContain("resolveDmpReportPageSelection");
    expect(reportPageSource).toContain("requestedReportId && !listedRequestedReport");
    expect(reportPageSource).toContain("if (!selection) notFound()");
    expect(reportPageSource).toContain("initialReports={selection.reports}");
    expect(reportPageSource).toContain("initialSelectedId={selection.selectedReportId}");
    expect(workspaceSource).toContain("reports.find((record) => record.id === selectedId) ?? null");
    expect(workspaceSource).not.toContain("reports.find((record) => record.id === selectedId) ?? reports[0]");
  });

  it("shows the persisted subject thumbnail in both each report card and its canonical group card", () => {
    expect(workspaceSource).toContain("group.subjectThumbnail.url");
    expect(workspaceSource).toContain("group.subjectThumbnail.title");
    expect(workspaceSource).toContain("dmpReportSubjectThumbnail(record)");
    expect(workspaceSource).toContain("styles.groupThumbnail");
    expect(workspaceSource).toContain('referrerPolicy="no-referrer"');
    expect(workspaceCss).toMatch(/\.groupThumbnail\s*\{[^}]*height\s*:\s*32px[^}]*width\s*:\s*32px/s);
  });

  it("maintains shop profiles, partitions history by shop and lets a canonical group change ownership", () => {
    expect(workspaceSource).toContain("groupDmpBusinessReportsByShop");
    expect(workspaceSource).toContain("visibleShopGroups.map");
    expect(workspaceSource).toContain('aria-label="店铺档案"');
    expect(workspaceSource).toContain("saveShopProfile");
    expect(workspaceSource).toContain('fetch("/api/dmp-reports"');
    expect(workspaceSource).toContain('method: "PATCH"');
    expect(workspaceSource).toContain("dmpReportGroupIdsByShopAndIdentity");
    expect(workspaceSource).toContain("assignGroupToShop(completeReportIds");
    expect(workspaceSource).not.toContain("assignGroupToShop(group.records.map");
    expect(workspaceSource).toContain("shopGroup.shopName");
    expect(workspaceSource).toContain("styles.groupAssignment");
    expect(workspaceCss).toMatch(/\.shopManager\s*\{[^}]*grid-template-columns/s);
    expect(workspaceCss).toMatch(/\.shopSectionHeader\s*\{[^}]*display\s*:\s*flex/s);
  });

  it("has explicit responsive rules for the library, toolbar and report grid", () => {
    expect(workspaceCss).toMatch(/@media\s*\(max-width:\s*\d+px\)/);
    expect(workspaceCss).toMatch(
      /@media\s*\(max-width:[^)]+\)[\s\S]*\.libraryHeader\s*,\s*\.focusToolbar\s*\{[^}]*flex-direction\s*:\s*column/s
    );
    expect(workspaceCss).toMatch(
      /@media\s*\(max-width:[^)]+\)[\s\S]*\.reportGrid\s*\{[^}]*grid-template-columns\s*:\s*1fr/s
    );
    expect(workspaceCss).toMatch(
      /@media\s*\(max-width:[^)]+\)[\s\S]*\.toolbar\s*\{/s
    );
  });
});
