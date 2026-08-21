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
    expect(workspaceCss).toMatch(/\.reportGrid\s*\{[^}]*max-height\s*:/s);
    expect(workspaceCss).toMatch(/\.reportGrid\s*\{[^}]*overflow-y\s*:\s*auto/s);
    expect(workspaceCss).toMatch(/\.reportGrid\s*\{[^}]*grid-template-columns\s*:/s);
    expect(workspaceCss).toMatch(/\.reportMain\s*\{[^}]*text-align\s*:\s*left/s);
    expect(workspaceCss).toMatch(/\.cardActions\s*\{[^}]*display\s*:\s*(?:flex|grid)/s);
  });

  it("retains report selection, refresh, sharing and deletion controls", () => {
    expect(workspaceSource).toContain("onClick={() => selectReport(record)}");
    expect(workspaceSource).toContain("aria-pressed={selectedRecord?.id === record.id}");
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
      /selectedRecord\s*\?\s*<DmpGrowthReportViewer\b[^>]*record=\{selectedRecord\}[^>]*variant="preview"/s
    );
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
