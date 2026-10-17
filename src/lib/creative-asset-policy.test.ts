import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { creativeAssetContentType } from "./creative-asset-policy";

describe("creative workspace asset policy", () => {
  it.each([
    ["labs/image-prompt-lab/promptlab.html", "text/html; charset=utf-8"],
    ["src/reference-detail-contract.js", "text/javascript; charset=utf-8"],
    ["labs/ecommerce-video-studio/video-studio.css", "text/css; charset=utf-8"],
    ["icons/icon48.png", "image/png"],
    ["fonts/workspace.woff2", "font/woff2"]
  ])("permits runtime asset %s with an explicit MIME", (asset, mime) => {
    expect(creativeAssetContentType(asset.split("/"))).toBe(mime);
  });

  it.each([
    ".env", "../secret.js", "src/../../secret.js", "src/%2e%2e/secret.js",
    "src/foo\\secret.js", "src/.hidden.js", "src/runtime.js.map", "src/runtime.ts",
    "labs/image-prompt-lab/README.md", "labs/image-prompt-lab/manifest.json",
    "fixtures/sample.js", "backup/runtime.js", "src/runtime.test.js", "src/runtime.old.js",
    "src/runtime.bak.js", "src/debug.js", "src/vendor/LICENSE", "assets/archive.zip",
    "icons/icon48.png?download=1"
  ])("rejects non-runtime or unsafe asset %s", asset => {
    expect(creativeAssetContentType(asset.split("/"))).toBeNull();
  });

  it("keeps both actual workspace HTML dependency graphs available", () => {
    for (const workspace of ["labs/image-prompt-lab/promptlab.html", "labs/ecommerce-video-studio/video-studio.html"]) {
      const html = readFileSync(path.resolve("public/creative", workspace), "utf8");
      for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)) {
        const url = new URL(match[1], `https://site.test/creative/${workspace}`);
        if (url.origin !== "https://site.test" || !url.pathname.startsWith("/creative/")) continue;
        const parts = url.pathname.slice("/creative/".length).split("/");
        expect(creativeAssetContentType(parts), url.pathname).not.toBeNull();
      }
    }
  });
});
