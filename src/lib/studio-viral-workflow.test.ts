import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import postcss from "postcss";

const assetRoot = process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative";
const readAsset = (name: string) => readFileSync(resolve(assetRoot, "labs/image-prompt-lab", name), "utf8");
const legacyHtml = readAsset("promptlab.html");
const layoutScript = readAsset("viral-workflow-layout.js");
const layoutCss = readAsset("viral-workflow-layout.css");
type Listener = (event: { target: DomElement | null }) => void;

// Parse the real legacy HTML so parent/child and ID assertions use the deployed
// forms, rather than a hand-written replacement that could conceal a regression.
class DomElement {
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
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
  get open() { return this.attributes.has("open"); }
  set open(value: boolean) { if (value) this.setAttribute("open", ""); else this.attributes.delete("open"); }
  get nextElementSibling(): DomElement | null {
    const siblings = this.parentNode?.children;
    return siblings ? siblings[siblings.indexOf(this) + 1] || null : null;
  }
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
  append(...elements: DomElement[]) { elements.forEach(element => this.appendChild(element)); }
  replaceChildren(...elements: DomElement[]) {
    for (const child of this.children) child.parentNode = null;
    this.children.splice(0); this.text = ""; this.append(...elements);
  }
  insertBefore(element: DomElement, before: DomElement) {
    if (element.parentNode) {
      element.parentNode.children.splice(element.parentNode.children.indexOf(element), 1);
      this.document.reparented.push(element);
    }
    element.parentNode = this;
    this.children.splice(this.children.indexOf(before), 0, element);
    return element;
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
  get body() { return this.require("body"); }
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

function harness(route = "case", dedicated = true, readyState = "complete") {
  const document = new TestDocument(readyState);
  if (dedicated) document.body.classList.add("viral-dedicated-workspace");
  document.body.setAttribute("data-viral-workflow", route);
  const fetch = vi.fn(() => { throw new Error("Presentation invoked network"); });
  const send = vi.fn(() => { throw new Error("Presentation invoked a provider"); });
  const storageWrite = vi.fn(() => { throw new Error("Presentation changed persistence"); });
  const mutations: Array<() => void> = [];
  class MutationObserver {
    constructor(private readonly callback: () => void) { mutations.push(callback); }
    observe() {}
  }
  const context = createContext({ document, MutationObserver, window: {}, location: { search: "?mode=viral&source=web&layout=1&workflow=1&creativeRoute=" + route }, URL, URLSearchParams, console, fetch, send,
    chrome: { runtime: { sendMessage: send } }, localStorage: { setItem: storageWrite },
    SZ_CREATIVE_WEB: { send, analyze: send, archive: send }, setTimeout: vi.fn() });
  const execute = () => runInContext(layoutScript, context, { filename: "viral-workflow-layout.js" });
  return { document, context, execute, fetch, send, storageWrite, flushMutations: () => mutations.forEach(callback => callback()) };
}

const routes = ["case", "style-refresh", "scene-extension"] as const;
function originals(document: TestDocument) {
  return document.root.descendants().map(node => ({ node, parent: node.parentNode, children: [...node.children],
    hidden: node.hidden, disabled: node.disabled, value: node.value, checked: node.checked, id: node.id,
    fieldset: node.closest("fieldset") }));
}
const formTags = new Set(["input", "textarea", "select", "button", "fieldset"]);

describe("dedicated viral workflow keeps the live business forms", () => {
  it.each(routes)("preserves controls, fieldset gates, listeners and edits in %s", route => {
    const h = harness(route), doc = h.document;
    doc.require("#detailPrompt").value = "手动编辑计划，不得重置";
    doc.require("#sceneMaterialName").value = "原木色地板";
    doc.require("#sceneSameMaterial").checked = true;
    doc.require("#sceneMaterialFields").disabled = true;
    doc.require("#sceneStopBtn").hidden = false;
    doc.require("#sceneGenerateBtn").disabled = true;
    doc.require("#stopGenerateBtn").hidden = false;
    doc.require("#generateBtn").disabled = true;
    doc.require("#styleRefreshCustomPanel").hidden = true;
    const before = originals(doc), handler = vi.fn();
    doc.require("#sceneFrontFile").addEventListener("change", handler);
    h.execute();
    expect(before.length).toBeGreaterThan(500);
    expect(doc.require(".app").classList.contains("vw-workspace")).toBe(true);
    expect(doc.require("#viralWorkflowSteps").querySelectorAll("li")).toHaveLength(3);
    for (const previous of before) {
      expect(previous.node.hidden).toBe(previous.hidden);
      expect(previous.node.disabled).toBe(previous.disabled);
      expect(previous.node.value).toBe(previous.value);
      expect(previous.node.checked).toBe(previous.checked);
      if (previous.id) expect(doc.getElementById(previous.id)).toBe(previous.node);
      if (formTags.has(previous.node.tagName)) {
        expect(previous.node.parentNode).toBe(previous.parent);
        expect(previous.node.closest("fieldset")).toBe(previous.fieldset);
        expect(previous.node.children).toEqual(previous.children);
      }
    }
    for (const id of ["generateBtn", "stopGenerateBtn", "downloadAllBtn", "resultGrid", "styleRefreshWorkStatus", "scenePlanBtn", "sceneState", "scenePlanGrid", "sceneGenerateBtn", "sceneStopBtn", "sceneResolveBtn", "sceneResultGrid", "sceneMaterialName", "sceneCategory", "sceneSameMaterial", "sceneFrontFile"]) {
      expect(doc.require("#" + id).closest(".vw-optional")).toBeNull();
    }
    doc.require("#sceneFrontFile").dispatch("change"); expect(handler).toHaveBeenCalledOnce();
    expect(doc.originalMarkupWrites).toEqual([]);
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled(); expect(h.storageWrite).not.toHaveBeenCalled();
  });

  it.each(routes)("does not run for ordinary legacy %s pages without the dedicated class", route => {
    const h = harness(route, false), before = originals(h.document); h.execute();
    expect(h.document.getElementById("viralWorkflowSteps")).toBeNull();
    expect(h.document.reparented).toEqual([]);
    expect(h.document.require(".app").classList.contains("vw-workspace")).toBe(false);
    for (const entry of before) expect(entry.node.parentNode).toBe(entry.parent);
  });

  it.each(["", "viral", "reference", "sku", "toString", "__proto__"])("rejects unknown dedicated route %s", route => {
    const h = harness(route); h.execute();
    expect(h.document.getElementById("viralWorkflowSteps")).toBeNull();
    expect(h.document.reparented).toEqual([]);
    expect(h.document.require(".app").listeners.size).toBe(0);
  });

  it.each(routes)("waits for DOM and decorates %s once", route => {
    const h = harness(route, true, "loading"); h.execute(); h.execute();
    expect(h.document.getElementById("viralWorkflowSteps")).toBeNull();
    h.document.ready(); h.execute(); h.document.ready();
    expect(h.document.root.querySelectorAll("#viralWorkflowSteps")).toHaveLength(1);
    expect(h.document.require(".app").listeners.get("focusin")).toHaveLength(1);
    expect(h.document.require(".app").listeners.get("invalid")).toHaveLength(1);
    expect(h.document.root.querySelectorAll(".vw-optional").every(node => !node.open)).toBe(true);
  });

  it("folds optional scene cards intact without cloning uploads or losing busy fieldsets", () => {
    const h = harness("scene-extension"), doc = h.document;
    const card = doc.require("#sceneDetailPreview").closest(".scene-material-card")!;
    const file = doc.require("#sceneDetailFile"), preview = doc.require("#sceneDetailPreview");
    const upload = doc.createElement("div"); upload.className = "cu-upload"; upload.setAttribute("data-upload-decorated", "1");
    card.insertBefore(upload, file); upload.appendChild(file);
    const cardChildren = [...card.children];
    doc.require("#sceneMaterialFields").disabled = true;
    h.execute();
    expect(doc.root.querySelectorAll(".cu-upload")).toEqual([upload]);
    expect(file.parentNode).toBe(upload);
    expect(preview.parentNode).toBe(card);
    expect(card.children).toEqual(cardChildren);
    expect(file.closest("fieldset")).toBe(doc.require("#sceneMaterialFields"));
    expect(doc.require("#sceneMaterialFields").disabled).toBe(true);
    expect(doc.require(".vw-extra-angles").querySelectorAll(".scene-material-card")).toHaveLength(3);
    expect(doc.require(".vw-extra-fields").querySelectorAll("label")).toHaveLength(6);
    expect(doc.require("#sceneFrontPreview").closest(".vw-optional")).toBeNull();
    expect(doc.require("#sceneMaterialName").closest(".vw-optional")).toBeNull();
    expect(doc.require("#sceneColorNotes").closest(".vw-extra-fields")).not.toBeNull();
  });

  it("reveals optional fields on existing focus or native validation without submitting", () => {
    const h = harness("scene-extension"), doc = h.document; h.execute();
    const field = doc.require("#sceneColorNotes"), details = field.closest(".vw-optional")!;
    expect(details.open).toBe(false);
    doc.require(".app").dispatch("invalid", field); expect(details.open).toBe(true);
    details.open = false;
    doc.require(".app").dispatch("focusin", field); expect(details.open).toBe(true);
    expect(h.send).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
  });

  it("mirrors a folded explanation hidden gate without changing the original", () => {
    const h = harness("case"), doc = h.document; doc.require("#viralDerivativeBlueprint").hidden = true; h.execute();
    const original = doc.require("#viralDerivativeBlueprint"), details = original.closest(".vw-optional")!;
    expect(original.hidden).toBe(true); expect(details.hidden).toBe(true);
    original.hidden = false; h.flushMutations(); expect(details.hidden).toBe(false);
    original.setAttribute("aria-hidden", "true"); h.flushMutations(); expect(details.hidden).toBe(true);
    expect(original.hidden).toBe(false);
  });

  it("uses the correct existing section anchors for each independent workflow", () => {
    const expected = { case: ["referenceSourcePanel", "detailPromptStep", "generationPanel"], "style-refresh": ["detailSubjectStep", "styleRefreshPanel", "generationPanel"], "scene-extension": ["sceneMaterialPanel", "sceneConfigPanel", "sceneResultsPanel"] };
    for (const route of routes) {
      const h = harness(route); h.execute();
      expect(h.document.require("#viralWorkflowSteps").querySelectorAll("a").map(node => node.getAttribute("href"))).toEqual(expected[route].map(id => "#" + id));
      for (const id of expected[route]) expect(h.document.getElementById(id)).not.toBeNull();
    }
  });

  it("orders the full style section before the plan while keeping inner form parents and values", () => {
    const h = harness("style-refresh"), doc = h.document, app = doc.require(".app");
    const style = doc.require("#styleRefreshPanel"), plan = doc.require("#detailPromptStep");
    // Represent the deployed legacy order, which can be changed by its layout.
    app.insertBefore(plan, style);
    const input = doc.require("#styleRefreshCustomVisual"), parent = input.parentNode;
    input.value = "保留自定义视觉描述";
    const click = vi.fn(); doc.require("#styleRefreshRecommendBtn").addEventListener("click", click);
    h.execute();
    expect(app.children.indexOf(style)).toBeLessThan(app.children.indexOf(plan));
    expect(style.parentNode).toBe(app); expect(plan.parentNode).toBe(app);
    expect(input.parentNode).toBe(parent); expect(input.value).toBe("保留自定义视觉描述");
    doc.require("#styleRefreshRecommendBtn").dispatch("click"); expect(click).toHaveBeenCalledOnce();
  });

  it("keeps material, style and output order after repeated real core late-stage synchronization", () => {
    const h = harness("style-refresh"), doc = h.document, app = doc.require(".app");
    h.execute();
    const controls = originals(doc).filter(entry => formTags.has(entry.node.tagName));
    const input = doc.require("#styleRefreshCustomVisual"), prompt = doc.require("#detailPrompt");
    input.value = "自由共创草稿与纹理要求"; prompt.value = "已确认的六张焕新计划";
    doc.require("#generateBtn").disabled = true;
    const handler = vi.fn(); input.addEventListener("input", handler);
    // Load the complete real engine and its own route function, then execute
    // the exact synchronizer used by late loadContext / field updates.
    for (const name of ["viral-series-contract.js", "style-refresh-contract.js", "promptlab.js"]) {
      runInContext(readAsset(name), h.context, { filename: name });
    }
    for (let repeat = 0; repeat < 4; repeat++) {
      runInContext("syncReferenceDetailStageDomOrder(false)", h.context);
      expect(app.children.indexOf(doc.require("#detailSubjectStep"))).toBeLessThan(app.children.indexOf(doc.require("#styleRefreshPanel")));
      expect(app.children.indexOf(doc.require("#styleRefreshPanel"))).toBeLessThan(app.children.indexOf(doc.require("#detailPromptStep")));
      for (const previous of controls) {
        expect(previous.node.parentNode).toBe(previous.parent);
        expect(previous.node.closest("fieldset")).toBe(previous.fieldset);
      }
    }
    expect(input.value).toBe("自由共创草稿与纹理要求"); expect(prompt.value).toBe("已确认的六张焕新计划");
    expect(doc.require("#generateBtn").disabled).toBe(true);
    input.dispatch("input"); expect(handler).toHaveBeenCalledOnce();
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled(); expect(h.storageWrite).not.toHaveBeenCalled();
  });

  it("reflects the live upload SDK import state in the real scene renderer and its plan gate", () => {
    const h = harness("scene-extension"), doc = h.document;
    doc.body.classList.add("viral-lab-mode", "scene-extension-route");
    // Execute the renderer from the shipped scene asset. Its controller/model
    // is supplied directly so this regression never imports an image or sends.
    const renderSource = readAsset("scene-extension-ui.js").match(/    function render\(model\) \{[\s\S]*?\n    \}\n    function journalKey/)?.[0].replace(/\n    function journalKey$/, "");
    expect(renderSource).toBeTruthy();
    let importing = true;
    const isImporting = vi.fn(() => importing), setApiBusy = vi.fn();
    const model: {
      busy: boolean; ready: boolean; stopped: boolean; uncertain: boolean;
      plan: null; slots: []; previousResults: []; kind: string;
      importReading?: boolean; uploadReading?: number;
    } = { busy: false, ready: true, stopped: false, uncertain: false, plan: null, slots: [], previousResults: [], kind: "" };
    Object.assign(h.context, {
      doc, root: { SZ_IMAGE_UPLOAD: { isImporting } }, bridge: { setApiBusy },
      reading: 0, shotLabels: {}, lastPlan: "", lastResults: "", model,
      el: (id: string) => doc.require("#" + id),
      readInput: () => ({ config: { shots: [] } }),
      countSummary: () => ({ ok: true, message: "就绪", counts: {} }),
      outputDimensions: () => null
    });
    runInContext(renderSource! + "\nrender(model);", h.context, { filename: "scene-extension-ui.js#render" });
    expect(model.importReading).toBe(true);
    expect(model.uploadReading).toBe(0);
    expect(doc.require("#scenePlanBtn").disabled).toBe(true);
    expect(setApiBusy).toHaveBeenLastCalledWith("scene-extension", true);
    importing = false;
    runInContext("render(model)", h.context);
    expect(model.importReading).toBe(false);
    expect(doc.require("#scenePlanBtn").disabled).toBe(false);
    expect(setApiBusy).toHaveBeenLastCalledWith("scene-extension", false);
    expect(isImporting).toHaveBeenCalledTimes(2);
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled(); expect(h.storageWrite).not.toHaveBeenCalled();
  });

  it.each(routes)("keeps the real dedicated startup gate pending until %s configuration and restoration finish", async route => {
    const h = harness(route), doc = h.document;
    let resolve!: (reply: { ok: boolean }) => void;
    const waiting = new Promise<{ ok: boolean }>(yes => { resolve = yes; });
    const ready = vi.fn(() => waiting);
    h.context.window = { addEventListener() {}, SZ_SCENE_EXTENSION_BRIDGE: { ready } };
    h.context.clearTimeout = vi.fn();
    const inline = legacyHtml.match(/<script id="labStartupScript">([\s\S]*?)<\/script>/)?.[1];
    expect(inline).toBeTruthy();
    runInContext(inline!, h.context, { filename: "promptlab.html#labStartupScript" });
    expect(doc.documentElement.dataset.labStartup).toBe("pending");
    runInContext("window.SZ_LAB_STARTUP.ready(); window.SZ_LAB_STARTUP.ready()", h.context);
    expect(ready).toHaveBeenCalledOnce(); expect(doc.documentElement.dataset.labStartup).toBe("pending");
    resolve({ ok: true });
    for (let tick = 0; tick < 4; tick++) await Promise.resolve();
    expect(doc.documentElement.dataset.labStartup).toBe("ready");
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  });

  it.each(["failure", "rejection"])("shows the real dedicated startup error instead of releasing unfinished configuration: %s", async outcome => {
    const h = harness("style-refresh"), doc = h.document;
    let resolve!: (reply: { ok: boolean; error: string }) => void, reject!: (reason: Error) => void;
    const waiting = new Promise<{ ok: boolean; error: string }>((yes, no) => { resolve = yes; reject = no; });
    h.context.window = { addEventListener() {}, SZ_SCENE_EXTENSION_BRIDGE: { ready: () => waiting } };
    h.context.clearTimeout = vi.fn();
    const inline = legacyHtml.match(/<script id="labStartupScript">([\s\S]*?)<\/script>/)?.[1];
    runInContext(inline!, h.context, { filename: "promptlab.html#labStartupScript" });
    runInContext("window.SZ_LAB_STARTUP.ready()", h.context);
    expect(doc.documentElement.dataset.labStartup).toBe("pending");
    if (outcome === "failure") resolve({ ok: false, error: "配置恢复失败" });
    else reject(new Error("配置加载异常"));
    for (let tick = 0; tick < 4; tick++) await Promise.resolve();
    expect(doc.documentElement.dataset.labStartup).toBe("error");
    expect(doc.require("#labStartupStatus").getAttribute("role")).toBe("alert");
    expect(doc.require("#labStartupStatus").querySelector("button")?.textContent).toBe("重新加载");
  });

  it("retains the original hub's synchronous ready behavior without requesting dedicated restoration", () => {
    const h = harness("case", false), doc = h.document, ready = vi.fn();
    h.context.location = { search: "?mode=viral&source=web&layout=1" };
    h.context.window = { addEventListener() {}, SZ_SCENE_EXTENSION_BRIDGE: { ready } };
    h.context.clearTimeout = vi.fn();
    const inline = legacyHtml.match(/<script id="labStartupScript">([\s\S]*?)<\/script>/)?.[1];
    runInContext(inline!, h.context, { filename: "promptlab.html#labStartupScript" });
    expect(doc.documentElement.dataset.labStartup).toBe("pending");
    runInContext("window.SZ_LAB_STARTUP.ready()", h.context);
    expect(doc.documentElement.dataset.labStartup).toBe("ready"); expect(ready).not.toHaveBeenCalled();
  });

  it("scopes all CSS and never forces business hidden or inactive panels visible", () => {
    const css = postcss.parse(layoutCss); let count = 0;
    css.walkRules(rule => {
      expect(rule.selector.startsWith("body.viral-dedicated-workspace[data-viral-workflow]")).toBe(true);
      rule.walkDecls("display", declaration => {
        expect(declaration.important).toBeFalsy();
        if (declaration.value !== "none") {
          expect(rule.selector.includes(".app.vw-workspace:not([hidden])") || rule.selector.includes(".vw-steps") || rule.selector.includes(".vw-angle-grid") || rule.selector.includes(".vw-field-grid") || rule.selector.includes("::before")).toBe(true);
        }
      });
      count++;
    });
    expect(count).toBeGreaterThan(30);
    const workspaceRule = css.nodes.find(node => node.type === "rule" && node.selector.includes(".app.vw-workspace:not([hidden])"));
    expect(workspaceRule?.type).toBe("rule");
    if (workspaceRule?.type === "rule") expect(workspaceRule.nodes.some(node => node.type === "decl" && node.prop === "align-items" && node.value === "stretch")).toBe(true);
    expect(layoutCss).toContain("max-width: 1100px");
    expect(layoutCss).toContain("@media (max-width: 540px)");
    expect(layoutCss).not.toMatch(/overflow-x:\s*hidden|#(?:generateBtn|sceneGenerateBtn|resultGrid|sceneResultGrid)[^{]*\{[^}]*display:\s*none/);
  });
});
