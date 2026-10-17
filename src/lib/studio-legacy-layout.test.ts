import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const assetRoot = process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative";
const readAsset = (name: string) => readFileSync(resolve(assetRoot, "labs/image-prompt-lab", name), "utf8");
const legacyHtml = readAsset("promptlab.html");
const layoutScript = readAsset("studio-legacy-layout.js");
type Listener = (event: { target: DomElement | null }) => void;

// Parse the real legacy HTML so parent/child and ID assertions use the deployed
// forms, rather than a hand-written replacement that could conceal a regression.
class DomElement {
  readonly attributes = new Map<string, string>();
  readonly children: DomElement[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly style = {
    properties: new Map<string, string>(),
    setProperty: (name: string, value: string) => { this.style.properties.set(name, value); }
  };
  readonly classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
    toggle: (name: string, force?: boolean) => {
      const present = this.classList.contains(name), next = force ?? !present;
      if (next) this.classList.add(name);
      else this.className = this.className.split(/\s+/).filter(item => item !== name).join(" ");
      return next;
    }
  };
  parentNode: DomElement | null = null;
  value = "";
  checked = false;
  text = "";

  constructor(readonly tagName: string, readonly document: TestDocument, readonly original = false) {}
  get id() { return this.getAttribute("id") || ""; }
  set id(value: string) { this.setAttribute("id", value); }
  get className() { return this.getAttribute("class") || ""; }
  set className(value: string) { this.setAttribute("class", value); }
  get hidden() { return this.attributes.has("hidden"); }
  set hidden(value: boolean) { if (value) this.setAttribute("hidden", ""); else this.attributes.delete("hidden"); }
  get disabled() { return this.attributes.has("disabled"); }
  set disabled(value: boolean) { if (value) this.setAttribute("disabled", ""); else this.attributes.delete("disabled"); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) {
    for (const child of this.children) child.parentNode = null;
    this.children.splice(0);
    this.text = value;
  }
  set innerHTML(value: string) {
    if (this.original) this.document.originalMarkupWrites.push(this);
    for (const child of this.children) child.parentNode = null;
    this.children.splice(0);
    this.text = "";
    parseHtml(value, this, false);
  }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  appendChild(child: DomElement) {
    if (child.parentNode) {
      child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1);
      this.document.reparented.push(child);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  after(element: DomElement) {
    const parent = this.parentNode;
    if (!parent) throw new Error("Detached insertion point");
    if (element.parentNode) this.document.reparented.push(element);
    element.parentNode = parent;
    parent.children.splice(parent.children.indexOf(this) + 1, 0, element);
  }
  addEventListener(name: string, listener: Listener) {
    const entries = this.listeners.get(name) || [];
    entries.push(listener);
    this.listeners.set(name, entries);
  }
  dispatch(name: string, target: DomElement | null = this) {
    for (const listener of this.listeners.get(name) || []) listener({ target });
  }
  descendants(): DomElement[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll(selector: string) { return this.descendants().filter(element => matchesSelector(element, selector)); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector: string): DomElement | null {
    if (matchesSelector(this, selector)) return this;
    return this.parentNode?.closest(selector) || null;
  }
}

function matchesSelector(element: DomElement, selector: string): boolean {
  return selector.split(",").some(part => {
    const chain = part.trim().split(/\s*>\s*/);
    let current: DomElement | null = element;
    for (const simple of chain.reverse()) {
      if (!current) return false;
      if (simple.startsWith("#")) { if (current.id !== simple.slice(1)) return false; }
      else if (simple.startsWith(".")) { if (!current.classList.contains(simple.slice(1))) return false; }
      else if (current.tagName !== simple.toLowerCase()) return false;
      current = current.parentNode;
    }
    return true;
  });
}

function parseHtml(html: string, root: DomElement, original: boolean) {
  const stack = [root], voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const token = /<!--[\s\S]*?-->|<![^>]*>|<\/?([a-z][a-z0-9-]*)([^>]*?)>|([^<]+)/gi;
  for (const match of html.matchAll(token)) {
    if (match[3]) { stack[stack.length - 1].text += match[3]; continue; }
    if (!match[1]) continue;
    const tag = match[1].toLowerCase();
    if (match[0].startsWith("</")) {
      while (stack.length > 1) { if (stack.pop()?.tagName === tag) break; }
      continue;
    }
    const element = new DomElement(tag, root.document, original);
    for (const attribute of match[2].matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      element.setAttribute(attribute[1], attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
    }
    element.value = element.getAttribute("value") || "";
    element.checked = element.attributes.has("checked");
    stack[stack.length - 1].appendChild(element);
    if (!voidTags.has(tag) && !match[0].endsWith("/>")) stack.push(element);
  }
}

class TestDocument {
  readonly originalMarkupWrites: DomElement[] = [];
  readonly reparented: DomElement[] = [];
  readonly root = new DomElement("document", this);
  readonly listeners = new Map<string, Array<{ callback: () => void; once: boolean }>>();
  constructor(public readyState = "complete") { parseHtml(legacyHtml, this.root, true); }
  get documentElement() { return this.require("html"); }
  createElement(tag: string) { return new DomElement(tag, this); }
  querySelector(selector: string) { return this.root.querySelector(selector); }
  getElementById(id: string) { return this.root.descendants().find(element => element.id === id) || null; }
  require(selector: string) {
    const element = this.querySelector(selector);
    if (!element) throw new Error(`Legacy fixture missing ${selector}`);
    return element;
  }
  addEventListener(name: string, callback: () => void, options?: { once?: boolean }) {
    const entries = this.listeners.get(name) || [];
    entries.push({ callback, once: !!options?.once });
    this.listeners.set(name, entries);
  }
  ready() {
    this.readyState = "complete";
    const entries = this.listeners.get("DOMContentLoaded") || [];
    this.listeners.set("DOMContentLoaded", entries.filter(entry => !entry.once));
    for (const entry of entries) entry.callback();
  }
}

function harness(search: string, readyState = "complete") {
  const document = new TestDocument(readyState);
  const fetch = vi.fn(() => { throw new Error("Presentation invoked network"); });
  const send = vi.fn(() => { throw new Error("Presentation invoked a provider"); });
  const storageWrite = vi.fn(() => { throw new Error("Presentation changed persistence"); });
  const context = createContext({ document, location: { search }, URLSearchParams, console, fetch, send,
    chrome: { runtime: { sendMessage: send } }, localStorage: { setItem: storageWrite },
    SZ_CREATIVE_WEB: { send, analyze: send, archive: send }, setTimeout: vi.fn() });
  const execute = () => runInContext(layoutScript, context, { filename: "studio-legacy-layout.js" });
  return { document, execute, fetch, send, storageWrite };
}

const routes = [
  ["reference", "?mode=detail&detailMode=reference&source=detail-reference&layout=1"],
  ["sku", "?mode=sku&source=web&layout=1"],
  ["viral", "?mode=viral&source=web&layout=1"]
] as const;

function captureOriginals(document: TestDocument) {
  return document.root.descendants().map(node => ({ node, parent: node.parentNode, children: [...node.children],
    hidden: node.hidden, disabled: node.disabled, value: node.value, checked: node.checked,
    ariaHidden: node.getAttribute("aria-hidden"), id: node.id, text: node.textContent }));
}

function splitSelectors(head: string) {
  const selectors: string[] = [];
  let depth = 0, start = 0, quote = "";
  for (let index = 0; index < head.length; index++) {
    const character = head[index];
    if (character === "\\") { index++; continue; }
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "(" || character === "[") depth++;
    else if (character === ")" || character === "]") depth--;
    else if (character === "," && depth === 0) { selectors.push(head.slice(start, index).trim()); start = index + 1; }
  }
  selectors.push(head.slice(start).trim());
  return selectors;
}

describe("legacy workspace presentation preserves live forms", () => {
  it.each(routes)("decorates %s without replacing, moving or resetting any original node", (surface, query) => {
    const h = harness(query), doc = h.document, originals = captureOriginals(doc);
    // Represent current user edits and in-flight gates, not just HTML defaults.
    doc.require("#detailPrompt").value = "用户编辑后的分屏提示词";
    doc.require("#skuAttrText").value = "SKU 标题甲\nSKU 标题乙";
    doc.require("#imageCount").value = "7";
    doc.require("#skuGenerateBtn").disabled = true;
    doc.require("#referenceDetailBatchResults").hidden = true;
    doc.require("#referenceProductAssetRightsConfirmed").checked = true;
    const edited = captureOriginals(doc);
    const inputHandler = vi.fn(), resultHandler = vi.fn(), editorHandler = vi.fn();
    doc.require("#skuProductFiles").addEventListener("change", inputHandler);
    doc.require("#resultGrid").addEventListener("click", resultHandler);
    doc.require("#referenceDetailEditor").addEventListener("input", editorHandler);
    h.execute();

    expect(doc.require(".app").classList.contains(`sl-${surface}`)).toBe(true);
    expect(doc.documentElement.classList.contains("studio-legacy-layout")).toBe(true);
    for (const previous of edited) {
      expect(previous.node.parentNode).toBe(previous.parent);
      const children = previous.node.children.filter(child => child.id !== "studioLegacySteps");
      expect(children.length).toBe(previous.children.length);
      previous.children.forEach((child, index) => expect(children[index]).toBe(child));
      expect(previous.node.hidden).toBe(previous.hidden);
      expect(previous.node.disabled).toBe(previous.disabled);
      expect(previous.node.value).toBe(previous.value);
      expect(previous.node.checked).toBe(previous.checked);
      expect(previous.node.getAttribute("aria-hidden")).toBe(previous.node.classList.contains("detail-empty-icon") ? "true" : previous.ariaHidden);
      if (previous.id) expect(doc.getElementById(previous.id)).toBe(previous.node);
    }
    expect(originals.length).toBeGreaterThan(500);
    expect(doc.originalMarkupWrites).toEqual([]);
    expect(doc.reparented).toEqual([]);
    doc.require("#skuProductFiles").dispatch("change");
    doc.require("#resultGrid").dispatch("click");
    doc.require("#referenceDetailEditor").dispatch("input");
    expect(inputHandler).toHaveBeenCalledOnce();
    expect(resultHandler).toHaveBeenCalledOnce();
    expect(editorHandler).toHaveBeenCalledOnce();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.storageWrite).not.toHaveBeenCalled();
  });

  it.each(["", "?mode=sku", "?mode=sku&layout=0", "?mode=main&layout=1", "?mode=detail&detailMode=link&layout=1",
    "?mode=creative&tool=buyer&layout=1", "?mode=viral&layout=1&studio=1", "?mode=detail&detailMode=reference&layout=1&studio=1"])(
    "does nothing outside explicit legacy gates: %s", query => {
      const h = harness(query), before = captureOriginals(h.document);
      h.execute();
      expect(h.document.getElementById("studioLegacySteps")).toBeNull();
      expect(h.document.documentElement.classList.contains("studio-legacy-layout")).toBe(false);
      expect(h.document.require(".app").listeners.size).toBe(0);
      expect(h.document.originalMarkupWrites).toEqual([]);
      expect(h.document.reparented).toEqual([]);
      for (const previous of before) {
        expect(previous.node.parentNode).toBe(previous.parent);
        expect(previous.node.children.length).toBe(previous.children.length);
        expect(previous.node.textContent).toBe(previous.text);
        expect(previous.node.getAttribute("data-sl-icon")).toBeNull();
      }
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
    }
  );

  it.each(routes)("waits for DOM readiness and initializes %s only once", (_surface, query) => {
    const h = harness(query, "loading"), app = h.document.require(".app");
    h.execute(); h.execute();
    expect(h.document.getElementById("studioLegacySteps")).toBeNull();
    h.document.ready();
    const steps = h.document.require("#studioLegacySteps");
    expect(steps.querySelectorAll("li")).toHaveLength(5);
    expect(app.children.indexOf(steps)).toBe(app.children.indexOf(h.document.require(".hero")) + 1);
    expect(app.listeners.get("focusin")).toHaveLength(1);
    h.execute(); h.document.ready();
    expect(h.document.root.querySelectorAll("#studioLegacySteps")).toEqual([steps]);
    expect(app.listeners.get("focusin")).toHaveLength(1);
  });

  it("retains icon metadata and listeners through legacy text and result updates", () => {
    const h = harness(routes[2][1]), doc = h.document;
    h.execute();
    for (const id of ["labHeroTitle", "labHeroEyebrow", "generationTitle", "resultsTitle", "generateBtn", "skuGenerateBtn", "referenceDetailBatchAddTargetBtn", "referenceDetailBatchStartBtn"]) {
      const node = doc.require(`#${id}`), icon = node.getAttribute("data-sl-icon"), style = node.style.properties.get("--sl-icon");
      const handler = vi.fn(); node.addEventListener("click", handler);
      node.textContent = "业务渲染更新后的文字";
      expect(doc.getElementById(id)).toBe(node);
      expect(node.getAttribute("data-sl-icon")).toBe(icon);
      expect(node.style.properties.get("--sl-icon")).toBe(style);
      node.dispatch("click"); expect(handler).toHaveBeenCalledOnce();
      if (id !== "labHeroTitle") expect(style).toContain("data:image/svg+xml,");
    }
    // Business renderers can still replace their own dynamic children normally.
    const taskList = doc.require("#skuTaskList"), resultGrid = doc.require("#resultGrid"), editor = doc.require("#referenceDetailModuleList");
    const listeners = [taskList, resultGrid, editor].map(node => { const handler = vi.fn(); node.addEventListener("change", handler); return handler; });
    [taskList, resultGrid, editor].forEach((node, index) => {
      node.innerHTML = '<input class="runtime-child" value="草稿">';
      node.dispatch("change", node.children[0]);
      expect(listeners[index]).toHaveBeenCalledOnce();
    });
    expect(doc.require("#studioLegacySteps").querySelectorAll("li")).toHaveLength(5);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("changes only decorative focus state and keeps business progress/fields intact", () => {
    const h = harness(routes[0][1]), doc = h.document;
    h.execute();
    const app = doc.require(".app"), steps = doc.require("#studioLegacySteps").querySelectorAll("li");
    const before = captureOriginals(doc).filter(entry => entry.node.original);
    for (const [targetId, active] of [["refFile", 0], ["skuTaskList", 1], ["referenceDetailEditor", 2], ["referenceDetailBatchRows", 3], ["referenceDetailBatchResults", 4], ["resultGrid", 4]] as const) {
      app.dispatch("focusin", doc.require(`#${targetId}`));
      expect(steps.map(step => step.classList.contains("is-active"))).toEqual(steps.map((_step, index) => index === active));
    }
    for (const previous of before) {
      expect(previous.node.textContent).toBe(previous.text);
      expect(previous.node.value).toBe(previous.value);
      expect(previous.node.hidden).toBe(previous.hidden);
      expect(previous.node.disabled).toBe(previous.disabled);
    }
    expect(h.send).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.storageWrite).not.toHaveBeenCalled();
  });

  it("scopes stylesheet rules to the opt-in root and does not force hidden gates open", () => {
    const css = readAsset("studio-legacy-layout.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const heads = [...css.matchAll(/([^{}]+)\{/g)].map(match => match[1].trim());
    expect(heads.length).toBeGreaterThan(40);
    for (const head of heads) {
      if (head.startsWith("@media")) continue;
      for (const selector of splitSelectors(head)) expect(selector).toMatch(/^html\.studio-legacy-layout\s/);
    }
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/display\s*:/.test(rule[2]) || /display\s*:\s*none/.test(rule[2])) continue;
      expect(rule[1]).not.toMatch(/\[hidden\](?!\))/);
      if (/button[^,]*\[data-sl-icon\]/.test(rule[1])) expect(rule[1]).toContain(":not([hidden])");
    }
    expect(css).not.toMatch(/pointer-events\s*:\s*none|visibility\s*:\s*visible|display\s*:\s*(?:block|flex|grid|inline[\w-]*)[^;]*!important/);
  });
});
