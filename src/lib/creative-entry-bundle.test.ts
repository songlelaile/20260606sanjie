import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CREATIVE_ENTRY_CSS, CREATIVE_ENTRY_HTML, CREATIVE_ENTRY_JS, CREATIVE_ENTRY_SCRIPTS, CREATIVE_ENTRY_STYLES,
  isCreativeEntryPath, loadCreativeEntryBundle } from "./creative-entry-bundle";

const publicRoot = path.resolve("public/creative");
let fixture: string, originalHtml: string;
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
    const result = await loadCreativeEntryBundle(fixture);
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
    const result = await loadCreativeEntryBundle(fixture), context = vm.createContext({ assetOrder: [] });
    new vm.Script(result.js).runInContext(context);
    expect(context.assetOrder).toEqual(CREATIVE_ENTRY_SCRIPTS.map((_, index) => index));
    const positions = CREATIVE_ENTRY_STYLES.map((_, index) => result.css.indexOf(`.asset${index} `));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it("hashes source contents and the original version queries without losing unrelated entry query handling", async () => {
    const root = await fixtureRoot();
    try {
      const original = await loadCreativeEntryBundle(root);
      await writeFile(path.join(root, CREATIVE_ENTRY_SCRIPTS[0]), "globalThis.assetOrder.push('changed');");
      const changed = await loadCreativeEntryBundle(root);
      expect(changed.jsVersion).not.toBe(original.jsVersion); expect(changed.cssVersion).toBe(original.cssVersion);
      await writeFile(path.join(root, CREATIVE_ENTRY_HTML), originalHtml.replace("local-import.js", "local-import.js?v=version-query-change"));
      const queryChanged = await loadCreativeEntryBundle(root);
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
    const result = await loadCreativeEntryBundle(publicRoot);
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
