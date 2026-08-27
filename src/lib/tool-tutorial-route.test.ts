import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const toolsPageSource = readFileSync(
  new URL("../app/tools/page.tsx", import.meta.url),
  "utf8"
);
const tutorialsPageSource = readFileSync(
  new URL("../app/tools/tutorials/page.tsx", import.meta.url),
  "utf8"
);
const subnavSource = readFileSync(
  new URL("../components/tools/ToolsSubnav.tsx", import.meta.url),
  "utf8"
);
const tutorialConfigSource = readFileSync(
  new URL("./tool-tutorials.ts", import.meta.url),
  "utf8"
);
const globalStyles = readFileSync(
  new URL("../app/globals.css", import.meta.url),
  "utf8"
);

describe("tool tutorial route contract", () => {
  it("adds the same authenticated secondary navigation to both tool pages", () => {
    expect(subnavSource).toContain('href: "/tools/tutorials"');
    expect(subnavSource).toContain('aria-label="AI 工具二级导航"');
    expect(subnavSource).toContain('aria-current={current ? "page" : undefined}');
    expect(toolsPageSource).toContain('<ToolsSubnav active="overview" />');
    expect(tutorialsPageSource).toContain('<ToolsSubnav active="tutorials" />');
  });

  it("renders a real video only from the environment-backed tutorial list", () => {
    expect(tutorialsPageSource).toContain("TOOL_TUTORIALS.length > 0");
    expect(tutorialsPageSource).toContain("src={tutorial.videoSrc}");
    expect(tutorialsPageSource).toContain("poster={tutorial.posterSrc}");
    expect(tutorialsPageSource).toContain("playsInline");
    expect(tutorialConfigSource).toContain("NEXT_PUBLIC_TUTORIAL_VIDEO_URL");
    expect(tutorialConfigSource).toContain("POSTER_URL");
    expect(tutorialConfigSource).toContain("if (!videoSrc) return [];");
  });

  it("keeps the player at 3:2 and contains the complete video frame", () => {
    expect(globalStyles).toMatch(
      /\.tool-tutorial-player\s*\{[^}]*aspect-ratio:\s*3\s*\/\s*2/s
    );
    expect(globalStyles).toMatch(
      /\.tool-tutorial-player video\s*\{[^}]*object-fit:\s*contain/s
    );
  });
});
