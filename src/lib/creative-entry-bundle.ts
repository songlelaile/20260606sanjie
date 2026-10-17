import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { Script } from "node:vm";
import { creativeAssetContentType } from "./creative-asset-policy";

export const CREATIVE_ENTRY_HTML = "labs/image-prompt-lab/promptlab.html";
export const CREATIVE_ENTRY_CSS = "labs/image-prompt-lab/studio-entry.css";
export const CREATIVE_ENTRY_JS = "labs/image-prompt-lab/studio-entry.js";
const folder = "labs/image-prompt-lab/";

// A release manifest, not a file discovery mechanism. New dependencies require
// an explicit review of their ordering, script scope and relative URL behavior.
export const CREATIVE_ENTRY_STYLES = Object.freeze([
  "promptlab.css", "reference-detail-blueprint.css", "aesthetic-mirror.css", "link-image.css",
  "creative-tools.css", "studio-genesis.css", "scene-extension.css", "studio-legacy-layout.css",
  "image-upload.css", "viral-workflow-layout.css", "creative-credit-hints.css", "sku-region-ui.css", "workspace-ux.css"
].map(name => folder + name));
export const CREATIVE_ENTRY_SCRIPTS = Object.freeze([
  "src/local-import.js", "src/business-knowledge.js", "src/knowledge-output-contract.js",
  "src/subject-orchestration.js", "src/subject-assets.js", "src/reference-detail-contract.js",
  folder + "reference-detail-blueprint.js", folder + "reference-detail-batch.js", folder + "image-archive-store.js",
  folder + "guide-model-profile.js", folder + "viral-series-contract.js", folder + "style-refresh-contract.js",
  "src/reference-detail-interceptor.js", "src/reference-detail-background.js", "src/taobao-sku-background.js",
  folder + "creative-tools-contract.js", folder + "aesthetic-mirror-contract.js", folder + "studio-genesis-contract.js",
  folder + "scene-extension-contract.js", folder + "background.js", folder + "image-upload.js", "credit-display.js",
  folder + "creative-credit-hints.js", folder + "sku-region-ui.js", folder + "sku-delivery-store.js",
  folder + "sku-durable-receipt.js", folder + "promptlab.js", folder + "aesthetic-mirror-ui.js",
  folder + "link-list-import.js", folder + "link-image-contract.js", folder + "link-image-ui.js",
  folder + "creative-tools-ui.js", folder + "studio-genesis-ui.js", folder + "scene-extension-ui.js",
  folder + "studio-legacy-layout.js", folder + "viral-workflow-layout.js", folder + "viral-workflow-bridge.js"
]);
const files = [CREATIVE_ENTRY_HTML, ...CREATIVE_ENTRY_STYLES, ...CREATIVE_ENTRY_SCRIPTS];
type EntryBundle = { html: string; css: string; js: string; cssVersion: string; jsVersion: string };
let cached: { signature: string; pending: Promise<EntryBundle> } | undefined;

export function isCreativeEntryPath(relative: string) {
  return relative === CREATIVE_ENTRY_HTML || relative === CREATIVE_ENTRY_CSS || relative === CREATIVE_ENTRY_JS;
}

function invalidEntry(): never { throw new Error("Creative entry manifest is unavailable"); }

function referencePath(reference: string) {
  const base = new URL("https://creative-entry.invalid/creative/" + CREATIVE_ENTRY_HTML);
  const target = new URL(reference, base);
  if (target.origin !== base.origin || target.hash || !target.pathname.startsWith("/creative/")) return invalidEntry();
  return target.pathname.slice("/creative/".length);
}

function transform(html: string, css: string, js: string): EntryBundle {
  const body = html.search(/<body\b/i);
  if (body < 0) return invalidEntry();
  const styles = [...html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi)];
  const scripts = [...html.slice(body).matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi)];
  if (styles.length !== CREATIVE_ENTRY_STYLES.length || scripts.length !== CREATIVE_ENTRY_SCRIPTS.length) return invalidEntry();
  const styleReferences = styles.map((tag, index) => {
    const match = /^<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?\s*>$/i.exec(tag[0]);
    if (!match || referencePath(match[1]) !== CREATIVE_ENTRY_STYLES[index] || tag.index! >= body) return invalidEntry();
    return match[1];
  });
  const scriptReferences = scripts.map((tag, index) => {
    const match = /^<script\s+src="([^"]+)"\s*>\s*<\/script\s*>$/i.exec(tag[0]);
    if (!match || referencePath(match[1]) !== CREATIVE_ENTRY_SCRIPTS[index]) return invalidEntry();
    if (index && html.slice(body + scripts[index - 1].index! + scripts[index - 1][0].length, body + tag.index!).trim()) return invalidEntry();
    return match[1];
  });
  // Version queries remain part of each bundle's identity. The hash also covers
  // actual source bytes, so an unchanged public HTML revision cannot stale it.
  const hash = (references: string[], content: string) => createHash("sha256").update(JSON.stringify(references)).update("\0").update(content).digest("hex").slice(0, 24);
  const cssVersion = hash(styleReferences, css), jsVersion = hash(scriptReferences, js);
  const replacements = [
    ...styles.map((tag, index) => ({ at: tag.index!, length: tag[0].length,
      value: index ? "" : `<link rel="stylesheet" href="studio-entry.css?v=${cssVersion}">` })),
    ...scripts.map((tag, index) => ({ at: body + tag.index!, length: tag[0].length,
      value: index ? "" : `<script src="studio-entry.js?v=${jsVersion}"></script>` }))
  ];
  let bundled = html;
  for (const replacement of replacements.sort((left, right) => right.at - left.at)) {
    bundled = bundled.slice(0, replacement.at) + replacement.value + bundled.slice(replacement.at + replacement.length);
  }
  return { html: bundled, css, js, cssVersion, jsVersion };
}

/** Called only after current session and entitlement checks in the asset route. */
export async function loadCreativeEntryBundle(assetRoot: string): Promise<EntryBundle> {
  const root = await realpath(assetRoot);
  const entries = await Promise.all(files.map(async relative => {
    const filename = await realpath(path.join(root, relative));
    const actual = path.relative(root, filename);
    const contentType = creativeAssetContentType(relative.split("/"));
    // Reject symlinks to a different manifest member too: its source order and
    // global exports have not been approved at this slot in the bundle.
    if (!actual || actual !== relative.split("/").join(path.sep) || path.isAbsolute(actual) ||
        actual === ".." || actual.startsWith(`..${path.sep}`) || !contentType ||
        creativeAssetContentType(actual.split(path.sep)) !== contentType) return invalidEntry();
    const info = await stat(filename);
    if (!info.isFile()) return invalidEntry();
    return { relative, filename, signature: [actual, info.size, info.mtimeMs, info.ctimeMs] };
  }));
  const signature = JSON.stringify([root, entries.map(entry => entry.signature)]);
  if (cached?.signature === signature) return cached.pending;
  const pending = (async () => {
    const sources = new Map(await Promise.all(entries.map(async entry => [entry.relative, await readFile(entry.filename, "utf8")] as const)));
    const stylesheet = CREATIVE_ENTRY_STYLES.map(relative => {
      const source = sources.get(relative)!;
      // All current styles live in this directory and have no URL dependencies.
      // A future import/relative URL requires rebasing before it can be bundled.
      if (/@(?:import|charset)\b|\burl\s*\(/i.test(source)) return invalidEntry();
      return `/* Source: ${relative} */\n${source}\n`;
    }).join("\n");
    const scripts = CREATIVE_ENTRY_SCRIPTS.map(relative => {
      const source = sources.get(relative)!;
      if (/\bcurrentScript\b/.test(source)) return invalidEntry();
      return `\n;\n/* Source: ${relative} */\n${source}\n`;
    }).join("");
    // Every dependency is already IIFE/UMD scoped; promptlab.js intentionally
    // exports globals. Its original strict directive must remain effective.
    const javascript = `'use strict';\n${scripts}`;
    // Parse without executing any browser code. A broken release or conflicting
    // top-level declarations must not be served as a partially usable bundle.
    new Script(javascript, { filename: "studio-entry.js" });
    return transform(sources.get(CREATIVE_ENTRY_HTML)!, stylesheet, javascript);
  })();
  cached = { signature, pending };
  pending.catch(() => { if (cached?.pending === pending) cached = undefined; });
  return pending;
}
