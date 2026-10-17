import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CREATIVE_ENTRY_CSS, CREATIVE_ENTRY_HTML, CREATIVE_ENTRY_JS, CREATIVE_ENTRY_SCRIPTS, CREATIVE_ENTRY_STYLES,
  CREATIVE_ENTRY_PRODUCTION_SCRIPTS, CREATIVE_ENTRY_PRODUCTION_STYLES,
  isCreativeEntryPath, loadCreativeEntryBundle } from "./creative-entry-bundle";

const publicRoot = path.resolve("public/creative");
let fixture: string, originalHtml: string;
async function loadBundledEntry(root: string) {
  const result = await loadCreativeEntryBundle(root);
  if (!result.bundled) throw new Error("Expected a granular entry bundle");
  return result;
}
async function fixtureRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "creative-entry-member-"));
  for (const relative of [CREATIVE_ENTRY_HTML, ...CREATIVE_ENTRY_STYLES, ...CREATIVE_ENTRY_SCRIPTS]) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    const content = relative === CREATIVE_ENTRY_HTML ? originalHtml : relative.endsWith(".css")
      ? `.asset${CREATIVE_ENTRY_STYLES.indexOf(relative)} { color: red; }`
      : `globalThis.assetOrder.push(${CREATIVE_ENTRY_SCRIPTS.indexOf(relative)});`;
    await writeFile(path.join(root, relative), content);
  }
  return root;
}
beforeAll(async () => { originalHtml = await readFile(path.join(publicRoot, CREATIVE_ENTRY_HTML), "utf8"); fixture = await fixtureRoot(); });
afterAll(async () => { await rm(fixture, { recursive: true, force: true }); });

describe("allowlisted protected image studio entry bundles", () => {
  it("replaces 13 styles and 37 tail scripts with two requests while retaining the head bridge and mode scripts", async () => {
    const result = await loadBundledEntry(fixture);
    const headBridge = originalHtml.match(/<script src="\/creative\/web-chrome\.js[^\"]*"><\/script>/)![0];
    expect(result.html).toContain(headBridge);
    expect([...result.html.matchAll(/<link\b[^>]+rel="stylesheet"/g)]).toHaveLength(1);
    expect([...result.html.matchAll(/<script\b[^>]+src=/g)]).toHaveLength(2);
    expect(result.html).toContain(`studio-entry.css?v=${result.cssVersion}`);
    expect(result.html).toContain(`studio-entry.js?v=${result.jsVersion}`);
    expect(result.html.indexOf("studio-entry.js")).toBeGreaterThan(result.html.lastIndexOf("</main>"));
    const inline = (value: string) => [...value.matchAll(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g)].map(match => match[0]);
    expect(inline(result.html)).toEqual(inline(originalHtml));
    expect(await readFile(path.join(fixture, CREATIVE_ENTRY_HTML), "utf8")).toBe(originalHtml);
  });

  it("preserves source execution and stylesheet order with safe statement boundaries", async () => {
    const result = await loadBundledEntry(fixture), context = vm.createContext({ assetOrder: [] });
    new vm.Script(result.js).runInContext(context);
    expect(context.assetOrder).toEqual(CREATIVE_ENTRY_SCRIPTS.map((_, index) => index));
    const positions = CREATIVE_ENTRY_STYLES.map((_, index) => result.css.indexOf(`.asset${index} `));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it("hashes source contents and the original version queries without losing unrelated entry query handling", async () => {
    const root = await fixtureRoot();
    try {
      const original = await loadBundledEntry(root);
      await writeFile(path.join(root, CREATIVE_ENTRY_SCRIPTS[0]), "globalThis.assetOrder.push('changed');");
      const changed = await loadBundledEntry(root);
      expect(changed.jsVersion).not.toBe(original.jsVersion); expect(changed.cssVersion).toBe(original.cssVersion);
      await writeFile(path.join(root, CREATIVE_ENTRY_HTML), originalHtml.replace("local-import.js", "local-import.js?v=version-query-change"));
      const queryChanged = await loadBundledEntry(root);
      expect(queryChanged.jsVersion).not.toBe(changed.jsVersion);
      expect(queryChanged.html).toContain("new URLSearchParams(location.search)");
      expect(queryChanged.html).toContain("get('mode')==='mirror'");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["../studio-entry.js", "labs/image-prompt-lab/../studio-entry.js", "labs/image-prompt-lab/studio-entry.js/extra", "labs/other/studio-entry.js"])("does not recognize a bundle path outside the exact allowlist: %s", relative => {
    expect(isCreativeEntryPath(relative)).toBe(false);
  });

  it("recognizes only the entry and its two synthetic assets", () => {
    expect([CREATIVE_ENTRY_HTML, CREATIVE_ENTRY_CSS, CREATIVE_ENTRY_JS].every(isCreativeEntryPath)).toBe(true);
  });

  it.each(["outside", "member", "wrong-type"])("fails closed on a %s source symlink", async target => {
    const root = await fixtureRoot(), member = path.join(root, CREATIVE_ENTRY_SCRIPTS[0]);
    try {
      const destination = target === "outside" ? path.join(root, "..", path.basename(root) + "-outside.js")
        : path.join(root, target === "member" ? CREATIVE_ENTRY_SCRIPTS[1] : CREATIVE_ENTRY_STYLES[0]);
      if (target === "outside") await writeFile(destination, "private outside source");
      await rm(member); await symlink(destination, member);
      await expect(loadCreativeEntryBundle(root)).rejects.toThrow("manifest is unavailable");
      if (target === "outside") await rm(destination);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["order", "extra-script", "async", "relative-css", "current-script", "syntax"])("rejects an unreviewed %s dependency change", async change => {
    const root = await fixtureRoot();
    try {
      if (change === "order") await writeFile(path.join(root, CREATIVE_ENTRY_HTML), originalHtml.replace("../../src/local-import.js", "../../src/business-knowledge.js"));
      if (change === "extra-script") await writeFile(path.join(root, CREATIVE_ENTRY_HTML), originalHtml.replace("</body>", "<script>window.extra=true</script></body>"));
      if (change === "async") await writeFile(path.join(root, CREATIVE_ENTRY_HTML), originalHtml.replace('src="../../src/local-import.js"', 'async src="../../src/local-import.js"'));
      if (change === "relative-css") await writeFile(path.join(root, CREATIVE_ENTRY_STYLES[0]), 'body{background:url("relative.png")}');
      if (change === "current-script") await writeFile(path.join(root, CREATIVE_ENTRY_SCRIPTS[0]), "globalThis.assetOrder.push(document.currentScript.src);");
      if (change === "syntax") await writeFile(path.join(root, CREATIVE_ENTRY_SCRIPTS[0]), "function broken( {");
      await expect(loadCreativeEntryBundle(root)).rejects.toThrow(change === "syntax" ? /Unexpected|expected/ : "manifest is unavailable");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("parses the actual combined release and verifies all other source files keep their own scope", async () => {
    const result = await loadBundledEntry(publicRoot);
    expect(() => new vm.Script(result.js)).not.toThrow();
    for (const relative of CREATIVE_ENTRY_SCRIPTS) {
      const source = await readFile(path.join(publicRoot, relative), "utf8");
      const parsed = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      if (relative.endsWith("/promptlab.js")) {
        expect(parsed.statements[0].getText(parsed)).toBe("'use strict';");
        expect(parsed.statements.some(statement => ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.BlockScoped))).toBe(false);
      } else {
        expect(parsed.statements.every(statement => ts.isExpressionStatement(statement))).toBe(true);
      }
      expect(source).not.toMatch(/\bcurrentScript\b/);
    }
  });
});

function productionHtml(revision = "release-1") {
  const reference = (relative: string) => relative.replace("labs/image-prompt-lab/", "") + `?v=${revision}`;
  const preloadPaths = ["/creative/web-chrome.js", ...[0, 1, 2, 6, 7].map(index => CREATIVE_ENTRY_PRODUCTION_SCRIPTS[index])];
  const workspace = reference(CREATIVE_ENTRY_PRODUCTION_STYLES[0]);
  return `<!doctype html><html><head>
<script id="labStyleReadyScript">window.fixtureHead = true;</script>
${preloadPaths.map(relative => `<link rel="preload" as="script" href="${reference(relative)}">`).join("\n")}
<link id="labWorkspaceStyles" rel="stylesheet" href="${workspace}" media="print" fetchpriority="high" onload="window.SZ_LAB_STYLES.loaded(this)" onerror="window.SZ_LAB_STYLES.failed(this)">
<noscript><link rel="stylesheet" href="${workspace}"></noscript>
${CREATIVE_ENTRY_PRODUCTION_STYLES.slice(1).map(relative => `<link rel="stylesheet" href="${reference(relative)}">`).join("\n")}
</head><body><section id="labFirstPaintShell" inert aria-busy="true">正在恢复工作台</section>
<script id="labFirstPaintMeasure">if (window.SZ_LAB_STYLES) window.SZ_LAB_STYLES.bodyReady(); if (window.SZ_LAB_FIRST_PAINT) window.SZ_LAB_FIRST_PAINT.bodyReady();</script>
<script src="${reference("/creative/web-chrome.js")}"></script>
<main class="app"><button id="editApiKeyBtn">修改 API Key</button><div id="archivePageStatus" role="status"></div></main>
${CREATIVE_ENTRY_PRODUCTION_SCRIPTS.map(relative => `<script src="${reference(relative)}"></script>`).join("\n")}
</body></html>`;
}

async function productionFixtureRoot(html = productionHtml()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "creative-entry-production-"));
  for (const relative of [CREATIVE_ENTRY_HTML, "web-chrome.js", ...CREATIVE_ENTRY_PRODUCTION_STYLES, ...CREATIVE_ENTRY_PRODUCTION_SCRIPTS]) {
    const filename = path.join(root, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, relative === CREATIVE_ENTRY_HTML ? html : relative.endsWith(".css") ? "body { color: red; }" : "void 0;");
  }
  return root;
}

describe("reviewed production image studio packaging", () => {
  it("passes through original CSS gates, noscript, preloads, inline body measurement and script boundaries", async () => {
    const html = productionHtml(), root = await productionFixtureRoot(html);
    try {
      const result = await loadCreativeEntryBundle(root);
      expect(result).toEqual({ bundled: false, html });
      expect(result).not.toHaveProperty("js"); expect(result).not.toHaveProperty("css");
      expect(await readFile(path.join(root, CREATIVE_ENTRY_HTML), "utf8")).toBe(html);
      expect([...result.html.matchAll(/<script\b[^>]+src=/g)]).toHaveLength(15);
      expect([...result.html.matchAll(/<link\b[^>]+rel="stylesheet"/g)]).toHaveLength(6);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("accepts coherent cache-busting revisions and the existing protected CSS URL without changing markup", async () => {
    const root = await productionFixtureRoot();
    try {
      await loadCreativeEntryBundle(root);
      const html = productionHtml("next-release&boot=transient")
        .replace('href="workspace-ux.css', 'href="/api/creative/assets/labs/image-prompt-lab/workspace-ux.css')
        .replace('src="promptlab.js?v=next-release&boot=transient"', 'src="promptlab.js?v=next-release&boot=standalone"');
      await writeFile(path.join(root, CREATIVE_ENTRY_HTML), html);
      expect(await loadCreativeEntryBundle(root)).toEqual({ bundled: false, html });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps production script and stylesheet URL semantics instead of concatenating frozen sources", async () => {
    const html = productionHtml(), root = await productionFixtureRoot(html);
    try {
      await writeFile(path.join(root, CREATIVE_ENTRY_PRODUCTION_SCRIPTS[0]), "window.frozenSource = document.currentScript.src;");
      await writeFile(path.join(root, CREATIVE_ENTRY_PRODUCTION_STYLES[0]), 'body { background: url("./icon.png"); }');
      expect(await loadCreativeEntryBundle(root)).toEqual({ bundled: false, html });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["script-order", "extra-script", "async", "head-external", "extra-inline-body", "changed-measurement", "style-order", "cross-origin", "fragment", "css-onload", "fallback", "preload", "inline-syntax"])("rejects an unreviewed production %s change", async change => {
    let html = productionHtml();
    if (change === "script-order") html = html.replace('src="sku-region-ui.js', 'src="sku-delivery-store.js');
    if (change === "extra-script") html = html.replace("</body>", '<script src="extra.js"></script></body>');
    if (change === "async") html = html.replace('src="studio-runtime-20261010-credit-v3.js', 'async src="studio-runtime-20261010-credit-v3.js');
    if (change === "head-external") html = html.replace("</head>", '<script src="/creative/web-chrome.js"></script></head>');
    if (change === "extra-inline-body") html = html.replace("</body>", '<script>window.unreviewed = true;</script></body>');
    if (change === "changed-measurement") html = html.replace("window.SZ_LAB_STYLES.bodyReady();", "window.SZ_LAB_STYLES.reset();");
    if (change === "style-order") html = html.replace('href="sku-region-ui.css', 'href="aesthetic-mirror.css');
    if (change === "cross-origin") html = html.replace('src="aesthetic-mirror-ui.js', 'src="https://unreviewed.invalid/creative/labs/image-prompt-lab/aesthetic-mirror-ui.js');
    if (change === "fragment") html = html.replace('src="aesthetic-mirror-ui.js?v=release-1"', 'src="aesthetic-mirror-ui.js?v=release-1#unreviewed"');
    if (change === "css-onload") html = html.replace("window.SZ_LAB_STYLES.loaded(this)", "window.unreviewed(this)");
    if (change === "fallback") html = html.replace("<noscript>", "<div>").replace("</noscript>", "</div>");
    if (change === "preload") html = html.replace('href="promptlab.js?v=release-1"', 'href="unreviewed.js?v=release-1"');
    if (change === "inline-syntax") html = html.replace("window.fixtureHead = true;", "function broken( {");
    const root = await productionFixtureRoot(html);
    try {
      await expect(loadCreativeEntryBundle(root)).rejects.toThrow(change === "inline-syntax" ? /Unexpected|expected/ : "manifest is unavailable");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["missing", "directory", "outside-symlink", "member-symlink"])("revalidates a production %s member before returning cached HTML", async change => {
    const root = await productionFixtureRoot(), target = path.join(root, CREATIVE_ENTRY_PRODUCTION_SCRIPTS[0]);
    const outside = path.join(root, "..", path.basename(root) + "-outside.js");
    try {
      expect((await loadCreativeEntryBundle(root)).bundled).toBe(false);
      await rm(target);
      if (change === "directory") await mkdir(target);
      if (change === "outside-symlink") { await writeFile(outside, "private outside source"); await symlink(outside, target); }
      if (change === "member-symlink") await symlink(path.join(root, CREATIVE_ENTRY_PRODUCTION_SCRIPTS[1]), target);
      await expect(loadCreativeEntryBundle(root)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { force: true }); }
  });
});
