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
// The production release already has reviewed frozen bundles and paid-SKU,
// mirror and link-result additions. Preserve their execution boundaries instead
// of mixing them with the granular development manifest above.
export const CREATIVE_ENTRY_PRODUCTION_STYLES = Object.freeze([
  "studio-workspace-20261009-v1.css", "sku-region-ui.css", "aesthetic-mirror.css", "link-image.css", "workspace-ux.css"
].map(name => folder + name));
export const CREATIVE_ENTRY_PRODUCTION_SCRIPTS = Object.freeze([
  "studio-prerequisites-20261009-v1.js", "viral-series-contract.js", "studio-runtime-20261010-credit-v3.js",
  "sku-region-ui.js", "sku-delivery-store.js", "sku-durable-receipt.js", "promptlab.js", "studio-views-20261010-credit-v3.js",
  "aesthetic-mirror-contract.js", "aesthetic-mirror-ui.js", "link-list-import.js", "link-image-contract.js",
  "link-image-result-actions.js", "link-image-ui.js"
].map(name => folder + name));
const productionBridge = "web-chrome.js";
const productionPreloads = [productionBridge, ...[0, 1, 2, 6, 7].map(index => CREATIVE_ENTRY_PRODUCTION_SCRIPTS[index])];
export type CreativeEntry = { bundled: true; html: string; css: string; js: string; cssVersion: string; jsVersion: string }
  | { bundled: false; html: string };
type EntryBundle = Extract<CreativeEntry, { bundled: true }>;
let cached: { signature: string; pending: Promise<CreativeEntry> } | undefined;

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

function productionReferencePath(reference: string) {
  const base = new URL("https://creative-entry.invalid/creative/" + CREATIVE_ENTRY_HTML);
  const target = new URL(reference, base);
  if (target.origin !== base.origin || target.username || target.password || target.hash) return invalidEntry();
  const prefix = ["/creative/", "/api/creative/assets/"].find(value => target.pathname.startsWith(value));
  if (!prefix) return invalidEntry();
  return target.pathname.slice(prefix.length);
}

function validateProductionMarkup(html: string) {
  const body = html.search(/<body\b/i), main = html.indexOf('<main class="app">');
  const mainEnd = html.lastIndexOf("</main>");
  if (body < 0 || main < body || mainEnd < main) return invalidEntry();
  const links = [...html.matchAll(/<link\b[^>]*>/gi)];
  const styles = links.filter(tag => /\brel="stylesheet"/i.test(tag[0]));
  const preloads = links.filter(tag => /\brel="preload"/i.test(tag[0]));
  if (styles.length !== CREATIVE_ENTRY_PRODUCTION_STYLES.length + 1 || preloads.length !== productionPreloads.length ||
      links.length !== styles.length + preloads.length) return invalidEntry();
  const stylePaths = [CREATIVE_ENTRY_PRODUCTION_STYLES[0], ...CREATIVE_ENTRY_PRODUCTION_STYLES];
  const styleReferences = styles.map((tag, index) => {
    const match = index === 0
      ? /^<link\s+id="labWorkspaceStyles"\s+rel="stylesheet"\s+href="([^"]+)"\s+media="print"\s+fetchpriority="high"\s+onload="window\.SZ_LAB_STYLES\.loaded\(this\)"\s+onerror="window\.SZ_LAB_STYLES\.failed\(this\)"\s*\/?\s*>$/i.exec(tag[0])
      : /^<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?\s*>$/i.exec(tag[0]);
    if (!match || productionReferencePath(match[1]) !== stylePaths[index] || tag.index! >= body) return invalidEntry();
    return match[1];
  });
  const fallback = styles[1];
  if (styleReferences[0] !== styleReferences[1] || !/<noscript>\s*$/i.test(html.slice(0, fallback.index)) ||
      !/^\s*<\/noscript>/i.test(html.slice(fallback.index! + fallback[0].length))) return invalidEntry();
  preloads.forEach((tag, index) => {
    const match = /^<link\s+rel="preload"\s+as="script"\s+href="([^"]+)"(?:\s+fetchpriority="high")?\s*\/?\s*>$/i.exec(tag[0]);
    if (!match || productionReferencePath(match[1]) !== productionPreloads[index] || tag.index! >= body) return invalidEntry();
  });
  const allScripts = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi)];
  if (allScripts.some(tag => tag.index! < body && /\bsrc\s*=/i.test(tag[0].slice(0, tag[0].indexOf(">"))))) return invalidEntry();
  const scripts = allScripts.filter(tag => tag.index! > body);
  if (scripts.length !== CREATIVE_ENTRY_PRODUCTION_SCRIPTS.length + 2) return invalidEntry();
  const measurement = /^<script\s+id="labFirstPaintMeasure"\s*>([\s\S]*?)<\/script\s*>$/i.exec(scripts[0][0]);
  const measureSource = "if (window.SZ_LAB_STYLES) window.SZ_LAB_STYLES.bodyReady(); if (window.SZ_LAB_FIRST_PAINT) window.SZ_LAB_FIRST_PAINT.bodyReady();";
  if (!measurement || measurement[1].trim() !== measureSource || scripts[0].index! >= main) return invalidEntry();
  const scriptPaths = [productionBridge, ...CREATIVE_ENTRY_PRODUCTION_SCRIPTS];
  scripts.slice(1).forEach((tag, index) => {
    const match = /^<script\s+src="([^"]+)"\s*>\s*<\/script\s*>$/i.exec(tag[0]);
    if (!match || productionReferencePath(match[1]) !== scriptPaths[index]) return invalidEntry();
    if (index === 0) {
      if (tag.index! >= main || html.slice(scripts[0].index! + scripts[0][0].length, tag.index).trim()) return invalidEntry();
    } else {
      if (tag.index! <= mainEnd) return invalidEntry();
      if (index > 1 && html.slice(scripts[index].index! + scripts[index][0].length, tag.index).trim()) return invalidEntry();
    }
  });
  for (const tag of allScripts) {
    if (!/\bsrc\s*=/i.test(tag[0].slice(0, tag[0].indexOf(">")))) {
      new Script(tag[0].slice(tag[0].indexOf(">") + 1, tag[0].lastIndexOf("</")), { filename: "studio-entry-inline.js" });
    }
  }
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
  return { bundled: true, html: bundled, css, js, cssVersion, jsVersion };
}

/** Called only after current session and entitlement checks in the asset route. */
export async function loadCreativeEntryBundle(assetRoot: string): Promise<CreativeEntry> {
  const root = await realpath(assetRoot);
  const member = async (relative: string) => {
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
  };
  const entry = await member(CREATIVE_ENTRY_HTML);
  const html = await readFile(entry.filename, "utf8");
  const production = /<link\b[^>]*\bid="labWorkspaceStyles"/i.test(html);
  if (production) validateProductionMarkup(html);
  const files = production
    ? [productionBridge, ...CREATIVE_ENTRY_PRODUCTION_STYLES, ...CREATIVE_ENTRY_PRODUCTION_SCRIPTS]
    : [...CREATIVE_ENTRY_STYLES, ...CREATIVE_ENTRY_SCRIPTS];
  // Revalidate every member before consulting the shared code cache. Replacing
  // a previously valid member with a symlink or directory must fail closed.
  const entries = [entry, ...await Promise.all(files.map(member))];
  const signature = JSON.stringify([root, production, entries.map(entry => entry.signature)]);
  if (cached?.signature === signature) return cached.pending;
  const pending: Promise<CreativeEntry> = (async () => {
    if (production) return { bundled: false, html };
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
