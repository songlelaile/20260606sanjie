import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const globalCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

describe("public DMP report table contrast", () => {
  it("uses the shared Sanjie design tokens with readable row colors", () => {
    expect(globalCss).toMatch(
      /\.dmp-shared-page\s*\{[^}]*linear-gradient\(145deg, var\(--bg\)[^}]*color:\s*var\(--ink\);/s
    );
    expect(globalCss).toMatch(
      /\.dmp-shared-section > header > span\s*\{[^}]*background:\s*var\(--brand\);[^}]*color:\s*#182007;/s
    );
    expect(globalCss).toMatch(
      /\.dmp-shared-table-scroll td\s*\{[^}]*background:\s*var\(--surface\);[^}]*color:\s*var\(--ink\);/s
    );
    expect(globalCss).toMatch(
      /\.dmp-shared-table-scroll tbody tr:nth-child\(even\) td\s*\{[^}]*background:\s*var\(--surface-2\);[^}]*color:\s*var\(--ink\);/s
    );
    expect(globalCss).toMatch(
      /\.dmp-shared-table-scroll tbody tr:hover td\s*\{[^}]*background:\s*var\(--surface-3\);[^}]*color:\s*#fff7df;/s
    );

    expect(contrastRatio("#f3edd7", "#0d1708")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#f3edd7", "#16200d")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#fff7df", "#24270e")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#f5fffb", "#1f6848")).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps warm gold for actions and reserves green for business data headers", () => {
    const workspaceCss = globalCss.slice(
      globalCss.indexOf(".dmp-workspace {"),
      globalCss.indexOf("/* ─────────────── 达摩盘官网公开只读报告")
    );
    expect(workspaceCss).toMatch(/\.dmp-workspace-actions \.dmp-action-primary\s*\{[^}]*background:\s*var\(--brand\);/s);
    expect(workspaceCss).toMatch(/\.dmp-table-tabs button\.active\s*\{[^}]*background:\s*var\(--brand\);/s);
    expect(workspaceCss).toMatch(/\.dmp-table-scroll th\s*\{[^}]*background:\s*#1f6848;/s);
    expect(workspaceCss).not.toMatch(/#(?:aed154|a8cd59|acd052|9abd50|c5e56b)/i);
  });
});

function contrastRatio(foreground: string, background: string) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(hex: string) {
  const channels = hex.slice(1).match(/.{2}/g)?.map((value) => Number.parseInt(value, 16) / 255) ?? [];
  const [red, green, blue] = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
