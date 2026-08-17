import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const globalCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

describe("public DMP report table contrast", () => {
  it("uses the official dark-green and warm-gold palette with explicit readable row colors", () => {
    expect(globalCss).toMatch(
      /\.dmp-shared-page\s*\{[^}]*linear-gradient\(145deg, #071006 0%, #0b180a 58%, #101c0c 100%\);[^}]*color:\s*#f3edd7;/s
    );
    expect(globalCss).toMatch(
      /\.dmp-shared-section > header > span\s*\{[^}]*background:\s*#f6c65f;[^}]*color:\s*#182007;/s
    );
    expect(globalCss).toMatch(
      /\.dmp-shared-table-scroll td\s*\{[^}]*background:\s*#0f1708;[^}]*color:\s*#f3edd7;/s
    );
    expect(globalCss).toMatch(
      /\.dmp-shared-table-scroll tbody tr:nth-child\(even\) td\s*\{[^}]*background:\s*#16200d;[^}]*color:\s*#f3edd7;/s
    );
    expect(globalCss).toMatch(
      /\.dmp-shared-table-scroll tbody tr:hover td\s*\{[^}]*background:\s*#24270e;[^}]*color:\s*#fff7df;/s
    );

    expect(contrastRatio("#f3edd7", "#0f1708")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#f3edd7", "#16200d")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#fff7df", "#24270e")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#f5fffb", "#1f6848")).toBeGreaterThanOrEqual(4.5);
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
