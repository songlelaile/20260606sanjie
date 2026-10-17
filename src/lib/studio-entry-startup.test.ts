import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const assetRoot = process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative";
const source = (name: string) => readFileSync(resolve(assetRoot, "labs/image-prompt-lab", name), "utf8");
const html = source("promptlab.html");
const startupScript = html.match(/<script id="labStartupScript">([\s\S]*?)<\/script>/)?.[1];
const startupStyle = html.match(/<style id="labStartupStyle">([\s\S]*?)<\/style>/)?.[1];
const firstPaintScript = html.match(/<script id="labFirstPaintScript">([\s\S]*?)<\/script>/)?.[1];
const firstPaintStyle = html.match(/<style id="labFirstPaintStyle">([\s\S]*?)<\/style>/)?.[1];
if (!startupScript || !startupStyle || !firstPaintScript || !firstPaintStyle) throw new Error("Missing the real entry startup assets");

type Listener = () => void;
type ResourceErrorEvent = { target: unknown; filename?: string };
type ResourceListener = (event: ResourceErrorEvent) => void;
class Element {
  readonly attributes = new Map<string, string>();
  readonly children: Element[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly dataset: Record<string, string> = {};
  readonly style = { setProperty() {} };
  parentNode: Element | null = null;
  text = "";
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  type = "";
  constructor(readonly tagName: string) {}
  get id() { return this.attributes.get("id") || ""; }
  set id(value: string) { this.setAttribute("id", value); }
  get className() { return this.attributes.get("class") || ""; }
  set className(value: string) { this.setAttribute("class", value); }
  get classList() {
    const contains = (name: string) => this.className.split(/\s+/).includes(name);
    const toggle = (name: string, force = !contains(name)) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      if (force) names.add(name); else names.delete(name);
      this.className = [...names].join(" "); return force;
    };
    return { contains, toggle, add: (...names: string[]) => names.forEach(name => toggle(name, true)) };
  }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.replaceChildren(); this.text = value; }
  set innerHTML(value: string) { this.replaceChildren(); parseMarkup(value, this); }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = String(value);
  }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  append(...children: Element[]) { children.forEach(child => this.appendChild(child)); }
  appendChild(child: Element) { child.parentNode = this; this.children.push(child); return child; }
  replaceChildren() { this.children.forEach(child => { child.parentNode = null; }); this.children.splice(0); this.text = ""; }
  after(child: Element) {
    if (!this.parentNode) throw new Error("Missing insertion parent");
    child.parentNode = this.parentNode;
    this.parentNode.children.splice(this.parentNode.children.indexOf(this) + 1, 0, child);
  }
  insertAdjacentElement(position: string, child: Element) { if (position !== "afterend") throw new Error(position); this.after(child); }
  addEventListener(name: string, listener: Listener) { this.listeners.set(name, [...this.listeners.get(name) || [], listener]); }
  dispatch(name: string) { this.listeners.get(name)?.forEach(listener => listener()); }
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  matches(selector: string): boolean {
    return selector.split(",").some(part => {
      const chain = part.trim().split(/\s*>\s*/);
      const ancestry: Array<Element | null> = [this];
      for (const simple of chain.reverse()) {
        const current = ancestry[ancestry.length - 1];
        if (!current) return false;
        const attribute = /^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(simple);
        if (attribute) {
          if (!current.attributes.has(attribute[1]) || attribute[2] && current.getAttribute(attribute[1]) !== attribute[2]) return false;
        } else if (simple.startsWith("#")) { if (current.id !== simple.slice(1)) return false; }
        else if (simple.startsWith(".")) { if (!current.classList.contains(simple.slice(1))) return false; }
        else if (current.tagName !== simple.toUpperCase()) return false;
        ancestry.push(current.parentNode);
      }
      return true;
    });
  }
  querySelectorAll(selector: string) { return this.descendants().filter(child => child.matches(selector)); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
}

function parseMarkup(markup: string, root: Element) {
  const stack = [root], voidTags = new Set(["input", "img", "link", "meta", "br", "hr"]);
  for (const match of markup.matchAll(/<!--[\s\S]*?-->|<\/?([a-z][a-z0-9-]*)([^>]*?)>|([^<]+)/gi)) {
    if (match[3]) { stack[stack.length - 1].text += match[3]; continue; }
    if (!match[1]) continue;
    const tag = match[1].toLowerCase();
    if (match[0].startsWith("</")) { while (stack.length > 1) if (stack.pop()?.tagName === tag.toUpperCase()) break; continue; }
    const child = new Element(tag.toUpperCase());
    for (const attribute of match[2].matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) child.setAttribute(attribute[1], attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
    child.value = child.getAttribute("value") || ""; child.checked = child.attributes.has("checked");
    stack[stack.length - 1].appendChild(child);
    if (!voidTags.has(tag)) stack.push(child);
  }
}

function deferred<T>() {
  let complete!: (value: T) => void;
  const promise = new Promise<T>(resolve => { complete = resolve; });
  return { promise, complete };
}

// Execute the shipped inline script before parsing any body. The DOM is a small
// API harness; CSS guard assertions below inspect the shipped rules separately.
function harness(search: string) {
  const documentElement = new Element("HTML"), body = new Element("BODY");
  const listeners = new Map<string, Listener[]>(), windowListeners = new Map<string, ResourceListener[]>();
  const timers = new Map<number, { callback: Listener; delay: number }>();
  let timerId = 0;
  const document = {
    documentElement, body, readyState: "loading", title: "", visibilityState: "visible",
    createElement: (tag: string) => new Element(tag.toUpperCase()),
    getElementById: (id: string) => body.querySelector(`#${id}`),
    querySelector: (selector: string) => body.querySelector(selector),
    addEventListener: (name: string, listener: Listener) => listeners.set(name, [...listeners.get(name) || [], listener])
  };
  const reload = vi.fn();
  const href = new URL("/creative/labs/image-prompt-lab/promptlab.html" + search, "https://studio.test").href;
  const context = createContext({ document, URLSearchParams, URL, console, crypto: { randomUUID },
    location: { href, search, reload }, localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
    setTimeout: (callback: Listener, delay: number) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    addEventListener: (name: string, listener: ResourceListener) => windowListeners.set(name, [...windowListeners.get(name) || [], listener])
  });
  context.window = context;
  runInContext(startupScript!, context, { filename: "promptlab.html#labStartupScript" });
  const parseBody = () => {
    const markup = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)?.[1];
    if (!markup) throw new Error("Missing actual body");
    body.innerHTML = markup.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  };
  const domReady = () => { document.readyState = "complete"; listeners.get("DOMContentLoaded")?.forEach(listener => listener()); };
  const element = (id: string) => { const node = document.getElementById(id); if (!node) throw new Error(`Missing ${id}`); return node; };
  const emitError = (event: ResourceErrorEvent) => windowListeners.get("error")?.forEach(listener => listener(event));
  return { context, document, parseBody, domReady, element, timers, reload, emitError,
    resourceError: (tagName = "SCRIPT", reference?: string, rel = "stylesheet") => {
      const url = new URL(reference || (tagName === "LINK" ? "studio-workspace-20261009-v1.css" : tagName === "IMG" ? "draft-product.png" : "promptlab.js"), href).href;
      emitError({ target: { tagName, src: url, href: url, rel } });
    },
    runtimeError: (filename?: string) => emitError({ target: runInContext("window", context), filename }),
    expire: () => [...timers.values()].filter(timer => timer.delay === 30000).forEach(timer => timer.callback()) };
}

const routes = [
  ["清单成详", "?mode=detail&detailMode=reference&source=detail-reference&layout=1"],
  ["批量 SKU", "?mode=sku&source=web&layout=1"],
  ["爆款裂变", "?mode=viral&source=web&layout=1"],
  ["DIY成图", "?mode=creative&tool=clothing&source=web"],
  ["买家秀", "?mode=creative&tool=buyer&source=web"],
  ["产品精修", "?mode=creative&tool=refinement&source=web"]
] as const;

const listMainRoute = ["清单成图", "?mode=main&source=web&layout=1"] as const;

describe("image studio entry does not paint the legacy main page", () => {
  it("installs both startup rules and route selection before any external resource", () => {
    const firstResource = html.search(/<(?:script\b[^>]*src=|link\b)/);
    expect(html.indexOf('id="labStartupStyle"')).toBeLessThan(firstResource);
    expect(html.indexOf('id="labStartupScript"')).toBeLessThan(firstResource);
    expect(html.indexOf('id="labFirstPaintStyle"')).toBeLessThan(firstResource);
    expect(html.indexOf('id="labFirstPaintScript"')).toBeLessThan(firstResource);
    // Pending startup allows the shipped skeleton. A fatal startup error hides
    // every body child except its retry status, including that skeleton.
    expect(startupStyle).toMatch(/html\[data-lab-startup="pending"\] body > :not\(#labStartupStatus\):not\(#labFirstPaintShell\),\s*html\[data-lab-startup="error"\] body > :not\(#labStartupStatus\)\s*\{\s*display:\s*none\s*!important/);
    expect(startupStyle).toMatch(/#labStartupStatus\s*\{\s*display:\s*none/);
    expect(startupStyle).toMatch(/html\[data-lab-startup="pending"\] #labStartupStatus,\s*html\[data-lab-startup="error"\] #labStartupStatus\s*\{\s*display:\s*flex/);
    expect(startupStyle).not.toContain('data-lab-startup="ready"');
    expect(firstPaintStyle).toMatch(/#labFirstPaintShell\s*\{\s*display:\s*none/);
    expect(firstPaintStyle).toMatch(/html\[data-lab-first-paint\] body > \.app,\s*html\[data-lab-first-paint\]\[data-lab-startup="pending"\] #labStartupStatus\s*\{\s*display:\s*none\s*!important/);
    expect(firstPaintStyle).toMatch(/html\[data-lab-first-paint\] #labFirstPaintShell\s*\{\s*display:\s*block/);
  });

  it.each([...routes, listMainRoute])("starts the %s restoration deadline only after DOMContentLoaded", (_label, search) => {
    const h = harness(search);
    expect(h.timers.size).toBe(0);
    h.expire();
    expect(h.document.documentElement.dataset.labStartup).toBe("pending");
    h.parseBody(); h.expire();
    expect(h.timers.size).toBe(0);
    expect(h.document.documentElement.dataset.labStartup).toBe("pending");
    h.domReady();
    expect([...h.timers.values()].map(timer => timer.delay)).toEqual([30000]);
    h.expire();
    expect(h.document.documentElement.dataset.labStartup).toBe("error");
    expect(h.element("labStartupStatus").getAttribute("role")).toBe("alert");
    expect(h.element("labStartupStatus").textContent).toContain("工作台加载超时");
    h.element("labStartupStatus").querySelector("button")!.dispatch("click");
    expect(h.reload).toHaveBeenCalledOnce();
    expect(h.timers.size).toBe(0);
  });

  it.each([...routes, listMainRoute])("%s stays covered until the target workspace is ready", (label, search) => {
    const h = harness(search);
    expect(h.document.body.children).toEqual([]);
    expect(h.document.documentElement.dataset.labStartup).toBe("pending");
    expect(h.document.title).toBe(`少壮AI · ${label}`);
    h.parseBody(); h.domReady();
    expect(h.element("labHeroTitle").textContent).toBe("主图生成实验室");
    expect(h.document.documentElement.dataset.labStartup).toBe("pending");
    expect(h.element("labStartupStatus").textContent).toBe(`正在打开${label}…`);
    h.context.SZ_LAB_STARTUP.ready();
    expect(h.document.documentElement.dataset.labStartup).toBe("ready");
    expect(h.timers.size).toBe(0);
    h.resourceError();
    expect(h.document.documentElement.dataset.labStartup).toBe("ready");
  });

  it.each(["?source=web&studio=1", "?mode=detail&detailMode=link&source=web&studio=1"])("does not gate an existing main/detail studio: %s", search => {
    const h = harness(search); h.parseBody(); h.domReady();
    expect(h.document.documentElement.dataset.labStartup).toBeUndefined();
    expect(h.context.SZ_LAB_STARTUP).toBeUndefined();
    expect(h.timers.size).toBe(0);
  });

  it.each(["resource", "timeout", "explicit"] as const)("keeps the main page hidden after %s failure and provides a working retry", kind => {
    const h = harness(routes[4][1]); h.parseBody(); h.domReady();
    if (kind === "resource") h.resourceError();
    else if (kind === "timeout") h.expire();
    else h.context.SZ_LAB_STARTUP.fail("账号准备失败 <img src=x>");
    expect(h.document.documentElement.dataset.labStartup).toBe("error");
    expect(h.element("labStartupStatus").getAttribute("role")).toBe("alert");
    expect(h.element("labStartupStatus").textContent).toContain("买家秀暂未就绪");
    expect(h.element("labStartupStatus").textContent).not.toContain("主图生成实验室");
    expect(h.timers.size).toBe(0);
    if (kind === "explicit") {
      expect(h.element("labStartupStatus").textContent).toContain("账号准备失败 <img src=x>");
      expect(h.element("labStartupStatus").querySelector("img")).toBeNull();
    }
    h.element("labStartupStatus").querySelector("button")!.dispatch("click");
    expect(h.reload).toHaveBeenCalledOnce();
  });

  it("reports an early resource failure even before its status element has been parsed", () => {
    const h = harness(routes[0][1]); h.resourceError();
    expect(h.document.documentElement.dataset.labStartup).toBe("error");
    h.parseBody(); h.domReady();
    expect(h.document.documentElement.dataset.labStartup).toBe("error");
    expect(h.element("labStartupStatus").textContent).toContain("清单成详暂未就绪");
    expect(h.element("labStartupStatus").querySelector("button")).not.toBeNull();
  });

  it("does not treat a stale draft image as a failed workspace resource", () => {
    const h = harness(routes[4][1]); h.parseBody(); h.domReady();
    h.resourceError("IMG");
    expect(h.document.documentElement.dataset.labStartup).toBe("pending");
    expect(h.element("labStartupStatus").getAttribute("role")).toBe("status");
    expect(h.element("labStartupStatus").textContent).toBe("正在打开买家秀…");
    expect(h.timers.size).toBe(1);
    h.context.SZ_LAB_STARTUP.ready();
    expect(h.document.documentElement.dataset.labStartup).toBe("ready");
    expect(h.timers.size).toBe(0);
  });

  it.each(["resource", "timeout"] as const)("keeps the reference workspace covered after %s failure even when late layout decoration completes", kind => {
    const h = harness(routes[0][1]); h.parseBody();
    if (kind === "resource") {
      runInContext(source("studio-legacy-layout.js"), h.context);
      h.resourceError();
    } else {
      h.domReady(); h.expire();
    }
    expect(h.document.documentElement.dataset.labStartup).toBe("error");
    expect(h.element("labStartupStatus").getAttribute("role")).toBe("alert");
    expect(h.element("labStartupStatus").querySelector("button")).not.toBeNull();
    expect(h.document.getElementById("studioLegacySteps")).toBeNull();
    if (kind === "resource") h.domReady();
    else runInContext(source("studio-legacy-layout.js"), h.context);
    expect(h.document.documentElement.classList.contains("studio-legacy-layout")).toBe(true);
    expect(h.element("studioLegacySteps").querySelectorAll("li")).toHaveLength(5);
    // Reference layout decoration cannot prove that its failed initialization
    // recovered. The shipped gate requires a reload for this route.
    expect(h.document.documentElement.dataset.labStartup).toBe("error");
    expect(h.element("labStartupStatus").querySelector("button")).not.toBeNull();
    expect(h.timers.size).toBe(0);
  });

  it.each([
    ["creative", routes[4][1]],
    ["dedicated viral", "?mode=viral&creativeRoute=case&workflow=1&source=web&layout=1"]
  ])("allows completed %s initialization to recover a timeout", async (route, search) => {
    const h = harness(search); h.parseBody(); h.domReady(); h.expire();
    expect(h.document.documentElement.dataset.labStartup).toBe("error");
    const bridgeReady = vi.fn(async () => ({ ok: true }));
    h.context.SZ_SCENE_EXTENSION_BRIDGE = { ready: bridgeReady };
    h.context.SZ_LAB_STARTUP.ready();
    await vi.waitFor(() => expect(h.document.documentElement.dataset.labStartup).toBe("ready"));
    expect(bridgeReady).toHaveBeenCalledTimes(route === "dedicated viral" ? 1 : 0);
    expect(h.timers.size).toBe(0);
  });

  it.each([...routes.slice(0, 3), listMainRoute])("only releases the %s legacy workspace after layout decoration", (_label, search) => {
    const h = harness(search); h.parseBody();
    runInContext(source("studio-legacy-layout.js"), h.context);
    expect(h.document.documentElement.dataset.labStartup).toBe("pending");
    expect(h.document.getElementById("studioLegacySteps")).toBeNull();
    h.domReady();
    expect(h.document.documentElement.classList.contains("studio-legacy-layout")).toBe(true);
    expect(h.element("studioLegacySteps").querySelectorAll("li")).toHaveLength(5);
    expect(h.document.documentElement.dataset.labStartup).toBe("ready");
  });
});

describe("startup errors belong to the same-origin creative workspace", () => {
  it.each(["script", "stylesheet", "runtime"] as const)("retains a genuine %s failure across a late readiness notification", kind => {
    const h = harness(routes[4][1]); h.parseBody(); h.domReady();
    if (kind === "script") h.resourceError("SCRIPT", "/creative/labs/image-prompt-lab/promptlab.js?v=release&boot=qa");
    else if (kind === "stylesheet") h.resourceError("LINK", "/creative/labs/image-prompt-lab/studio-workspace-20261009-v1.css?v=release&boot=qa");
    else h.runtimeError("https://studio.test/creative/labs/image-prompt-lab/studio-views-20261010-credit-v3.js?v=release&boot=qa");
    expect(h.document.documentElement.dataset.labStartup).toBe("error");
    expect(h.element("labStartupStatus").getAttribute("role")).toBe("alert");
    expect(h.element("labStartupStatus").textContent).toContain("工作台资源加载失败");
    expect(h.timers.size).toBe(0);
    h.context.SZ_LAB_STARTUP.ready();
    expect(h.document.documentElement.dataset.labStartup).toBe("error");
    h.element("labStartupStatus").querySelector("button")!.dispatch("click");
    expect(h.reload).toHaveBeenCalledOnce();
  });

  it.each(["anonymous", "blank-filename", "extension", "cross-origin-runtime", "outside-creative-runtime", "cross-origin-script", "cross-origin-stylesheet", "preload"] as const)("ignores an unrelated %s error without consuming the restoration deadline", kind => {
    const h = harness(routes[4][1]); h.parseBody(); h.domReady();
    if (kind === "anonymous") h.runtimeError();
    if (kind === "blank-filename") h.runtimeError("   ");
    if (kind === "extension") h.runtimeError("chrome-extension://fixture-extension/injected.js");
    if (kind === "cross-origin-runtime") h.runtimeError("https://unrelated.test/creative/injected.js");
    if (kind === "outside-creative-runtime") h.runtimeError("https://studio.test/other-app/runtime.js");
    if (kind === "cross-origin-script") h.resourceError("SCRIPT", "https://unrelated.test/creative/labs/image-prompt-lab/promptlab.js");
    if (kind === "cross-origin-stylesheet") h.resourceError("LINK", "https://unrelated.test/creative/labs/image-prompt-lab/studio-workspace-20261009-v1.css");
    if (kind === "preload") h.resourceError("LINK", "studio-views-20261010-credit-v3.js", "preload");
    expect(h.document.documentElement.dataset.labStartup).toBe("pending");
    expect(h.element("labStartupStatus").getAttribute("role")).toBe("status");
    expect(h.element("labStartupStatus").textContent).toBe("正在打开买家秀…");
    expect([...h.timers.values()].map(timer => timer.delay)).toEqual([30000]);
    h.context.SZ_LAB_STARTUP.ready();
    expect(h.document.documentElement.dataset.labStartup).toBe("ready");
    expect(h.timers.size).toBe(0);
  });
});

describe.each(routes.slice(3))("%s waits for its real creative UI startup", (label, search) => {
  function begin() {
    const h = harness(search); h.parseBody();
    const bridgeReady = deferred<{ ok: boolean; error?: string }>(), history = deferred<unknown>(), draft = deferred<unknown>();
    const reads: string[] = [];
    const db = { transaction: () => ({ objectStore: () => ({ get: (key: string) => {
      reads.push(key);
      const request = { result: undefined as unknown, onsuccess: undefined as undefined | (() => void) };
      (key.endsWith(":material-history") ? history : draft).promise.then(value => { request.result = value; request.onsuccess?.(); });
      return request;
    } }) }) };
    h.context.indexedDB = { open: () => {
      const request = { result: db, onsuccess: undefined as undefined | (() => void) };
      queueMicrotask(() => request.onsuccess?.()); return request;
    } };
    const bridge = { ready: vi.fn(() => bridgeReady.promise), getAccountKey: vi.fn(async () => "fixture:entry"), config: () => ({}),
      listBoundApis: async () => ({ ok: true, accountKey: "fixture:entry", providers: [] }), modelInfo: () => ({ ready: false }),
      send: vi.fn(), archive: vi.fn(), setApiBusy: vi.fn() };
    h.context.SZ_CREATIVE_TOOLS_BRIDGE = bridge;
    const uiScript = source("creative-tools-ui.js");
    // The live baseline still owns its upload markup. Only newer matching UI
    // bundles need the upload helper; neither runtime skips startup assertions.
    if (uiScript.includes("SZ_IMAGE_UPLOAD")) {
      const upload = createContext({ document: { readyState: "loading", addEventListener() {} } }); upload.window = upload;
      runInContext(source("image-upload.js"), upload); h.context.SZ_IMAGE_UPLOAD = upload.SZ_IMAGE_UPLOAD;
    }
    runInContext(source("creative-tools-contract.js"), h.context);
    runInContext(uiScript, h.context); h.domReady();
    return { ...h, bridge, bridgeReady, history, draft, reads };
  }

  it("keeps the old hero covered through API readiness and account draft restoration", async () => {
    const h = begin();
    expect(h.bridge.ready).toHaveBeenCalledOnce();
    expect(h.document.documentElement.dataset.labStartup).toBe("pending");
    expect(h.element("labHeroTitle").textContent).toBe("主图生成实验室");
    expect(h.document.getElementById("ctInputFields")).toBeNull();
    h.bridgeReady.complete({ ok: true });
    await vi.waitFor(() => expect(h.reads).toEqual(["fixture:entry:material-history"]));
    expect(h.document.documentElement.dataset.labStartup).toBe("pending");
    h.history.complete(null);
    await vi.waitFor(() => expect(h.reads).toHaveLength(2));
    expect(h.document.documentElement.dataset.labStartup).toBe("pending");
    h.draft.complete(null);
    await vi.waitFor(() => expect(h.document.documentElement.dataset.labStartup, h.element("labStartupStatus").textContent).toBe("ready"));
    expect(h.element("labHeroTitle").textContent).toBe(label);
    expect(h.document.getElementById("ctInputFields")).not.toBeNull();
    expect(h.bridge.send).not.toHaveBeenCalled();
    expect(h.bridge.archive).not.toHaveBeenCalled();
  });

  it("shows a covered, actionable failure when the real API bridge rejects startup", async () => {
    const h = begin(); h.bridgeReady.complete({ ok: false, error: "当前账号登录失效" });
    await vi.waitFor(() => expect(h.document.documentElement.dataset.labStartup).toBe("error"));
    expect(h.element("labStartupStatus").textContent).toContain("当前账号登录失效");
    expect(h.element("labStartupStatus").textContent).toContain(`${label}暂未就绪`);
    expect(h.bridge.getAccountKey).not.toHaveBeenCalled();
    expect(h.reads).toEqual([]);
    expect(h.document.getElementById("ctInputFields")).toBeNull();
  });
});
