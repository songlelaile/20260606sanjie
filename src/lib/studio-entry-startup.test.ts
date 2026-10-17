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
const studioBootstrapScript = html.match(/<script id="studioBootstrapScript">([\s\S]*?)<\/script>/)?.[1];
const studioBootstrapStyle = html.match(/<style id="studioBootstrapStyle">([\s\S]*?)<\/style>/)?.[1];
const studioRecoveryStyle = html.match(/<style id="studioStartupRecoveryStyle">([\s\S]*?)<\/style>/)?.[1];
if (!startupScript || !startupStyle || !studioBootstrapScript || !studioBootstrapStyle || !studioRecoveryStyle) throw new Error("Missing the real entry startup assets");

type Listener = () => void;
type ResourceListener = (event: { target: unknown; filename?: string; message?: string; error?: unknown }) => void;
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
  prepend(child: Element) { child.parentNode = this; this.children.unshift(child); }
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
  const observers = new Set<{ callback: Listener; connected: boolean }>();
  let timerId = 0;
  const document = {
    documentElement, body, readyState: "loading", title: "", visibilityState: "visible",
    createElement: (tag: string) => new Element(tag.toUpperCase()),
    getElementById: (id: string) => body.querySelector(`#${id}`),
    querySelector: (selector: string) => body.querySelector(selector),
    addEventListener: (name: string, listener: Listener) => listeners.set(name, [...listeners.get(name) || [], listener])
  };
  const reload = vi.fn();
  const context = createContext({ document, URLSearchParams, URL, console, crypto: { randomUUID },
    location: { search, reload, href: "https://site.test/creative/labs/image-prompt-lab/promptlab.html" + search }, localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
    setTimeout: (callback: Listener, delay: number) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    addEventListener: (name: string, listener: ResourceListener) => windowListeners.set(name, [...windowListeners.get(name) || [], listener]),
    MutationObserver: class {
      private entry: { callback: Listener; connected: boolean };
      constructor(callback: Listener) { this.entry = { callback, connected: false }; observers.add(this.entry); }
      observe() { this.entry.connected = true; }
      disconnect() { this.entry.connected = false; }
    }
  });
  context.window = context;
  runInContext(startupScript!, context, { filename: "promptlab.html#labStartupScript" });
  runInContext(studioBootstrapScript!, context, { filename: "promptlab.html#studioBootstrapScript" });
  const parseBody = () => {
    const markup = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)?.[1];
    if (!markup) throw new Error("Missing actual body");
    body.innerHTML = markup.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  };
  const domReady = () => { document.readyState = "complete"; listeners.get("DOMContentLoaded")?.forEach(listener => listener()); };
  const element = (id: string) => { const node = document.getElementById(id); if (!node) throw new Error(`Missing ${id}`); return node; };
  return { context, document, parseBody, domReady, element, timers, reload,
    mutations: () => { for (const observer of observers) if (observer.connected) observer.callback(); },
    resourceError: (tagName = "SCRIPT", url = "promptlab.js", rel = "stylesheet") => windowListeners.get("error")?.forEach(listener => listener({ target: { tagName, src: url, href: url, rel } })),
    runtimeError: (filename = "", error: Error = new Error("Script failure")) => windowListeners.get("error")?.forEach(listener => listener({
      target: runInContext("window", context), filename, error, message: error.message
    })),
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
const linkImageRoute = ["链接成图", "?mode=link-image&source=web"] as const;

describe.each([
  ["studio", "?source=web&studio=1"],
  ["legacy creative", "?mode=creative&tool=buyer&source=web"]
])("%s startup attributes only owned creative resource errors", (_label, search) => {
  it("ignores anonymous third-party CSP rejections and extension errors, then permits genuine readiness", () => {
    const h = harness(search); h.parseBody(); h.domReady();
    h.runtimeError("", new EvalError("Evaluating a string as JavaScript violates Content Security Policy: unsafe-eval"));
    h.runtimeError("chrome-extension://injected-extension/content-script.js");
    h.runtimeError("https://unrelated.test/injected.js");
    h.runtimeError("https://site.test/unrelated/injected.js");
    h.resourceError("SCRIPT", "chrome-extension://injected-extension/content-script.js");
    h.resourceError("SCRIPT", "https://unrelated.test/creative/injected.js");
    h.resourceError("LINK", "https://unrelated.test/creative/injected.css");
    h.resourceError("SCRIPT", "");
    h.resourceError("LINK", "studio-entry.css", "preload");
    expect(h.document.documentElement.dataset.labStartup).toBe("pending");
    expect(h.element("labStartupStatus").getAttribute("role")).toBe("status");
    expect(h.timers.size).toBe(1);
    if (search.includes("studio=1")) {
      h.document.documentElement.setAttribute("data-lab-startup", "ready");
      h.document.documentElement.setAttribute("data-studio-startup", "ready"); h.mutations();
      expect(h.document.documentElement.dataset.studioBootstrap).toBe("ready");
    } else h.context.SZ_LAB_STARTUP.ready();
    expect(h.document.documentElement.dataset.labStartup).toBe("ready"); expect(h.timers.size).toBe(0);
  });

  it.each(["/creative/web-chrome.js?v=owned", "/creative/labs/image-prompt-lab/studio-entry.js?v=owned"])("keeps an actual owned runtime/parser error fatal: %s", filename => {
    const h = harness(search);
    h.runtimeError("https://site.test" + filename, new SyntaxError("Unexpected token in owned bundle"));
    expect(h.document.documentElement.dataset.labStartup).toBe("error");
    h.parseBody(); h.domReady();
    if (search.includes("studio=1")) {
      expect(h.document.documentElement.dataset.studioBootstrap).toBe("resource-error");
      h.document.documentElement.setAttribute("data-lab-startup", "ready");
      h.document.documentElement.setAttribute("data-studio-startup", "ready"); h.mutations();
    } else h.context.SZ_LAB_STARTUP.ready();
    expect(h.document.documentElement.dataset.labStartup).toBe("error");
    expect(h.element("labStartupStatus").textContent).toContain("资源加载失败");
    expect(h.element("labStartupStatus").querySelector("button")).not.toBeNull();
    expect(h.timers.size).toBe(0);
  });
});

describe("image studio entry does not paint the legacy main page", () => {
  it("installs both startup rules and route selection before any external resource", () => {
    const firstResource = html.search(/<(?:script\b[^>]*src=|link\b)/);
    expect(html.indexOf('id="labStartupStyle"')).toBeLessThan(firstResource);
    expect(html.indexOf('id="labStartupScript"')).toBeLessThan(firstResource);
    // Hide the legacy hero and inputs until restoration. The bundled build
    // additionally permits its inert first-paint preview while still pending;
    // errors must hide that preview as well as every legacy body child.
    const pendingPreview = html.includes('id="labFirstPaintShell"') ? ':not(#labFirstPaintShell)' : '';
    expect(startupStyle).toContain(`html[data-lab-startup="pending"] body > :not(#labStartupStatus)${pendingPreview},`);
    expect(startupStyle).toMatch(/html\[data-lab-startup="error"\] body > :not\(#labStartupStatus\)\s*\{\s*display:\s*none\s*!important/);
    expect(startupStyle).toMatch(/#labStartupStatus\s*\{\s*display:\s*none/);
    expect(startupStyle).toMatch(/html\[data-lab-startup="pending"\] #labStartupStatus,\s*html\[data-lab-startup="error"\] #labStartupStatus\s*\{\s*display:\s*flex/);
    expect(startupStyle).not.toContain('data-lab-startup="ready"');
  });

  it.each([...routes, listMainRoute, linkImageRoute])("%s stays covered until the target workspace is ready", (label, search) => {
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

  it.each(["?source=web&studio=1", "?mode=detail&detailMode=link&source=web&studio=1"])("guards a main/detail studio without taking over its legacy startup interface: %s", search => {
    const h = harness(search); h.parseBody(); h.domReady();
    expect(h.document.documentElement.dataset.labStartup).toBe("pending");
    expect(h.document.documentElement.dataset.studioBootstrap).toBe("pending");
    expect(h.context.SZ_LAB_STARTUP).toBeUndefined();
    expect(h.timers.size).toBe(1);
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

  it.each(["resource", "timeout"] as const)("does not let a surviving layout script reveal the old main page after a %s failure", kind => {
    const h = harness(routes[0][1]); h.parseBody();
    // A resource failure may happen during parsing. A restoration timeout
    // starts after DCL; simulate the decorative layout arriving afterwards.
    if (kind === "resource") {
      runInContext(source("studio-legacy-layout.js"), h.context);
      h.resourceError(); h.domReady();
    } else {
      h.domReady(); h.expire();
      runInContext(source("studio-legacy-layout.js"), h.context);
    }
    // For example, promptlab.js failed to load while layout.js survived. Its
    // readiness notification must not expose uninitialized main-image markup.
    expect(h.document.documentElement.classList.contains("studio-legacy-layout")).toBe(true);
    expect(h.document.documentElement.dataset.labStartup).toBe("error");
    expect(h.element("labStartupStatus").querySelector("button")).not.toBeNull();
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

describe("studio head bootstrap survives missing entry resources", () => {
  const studio = "?source=web&studio=1";
  function nativeState(h: ReturnType<typeof harness>, state: "pending" | "ready" | "error") {
    h.document.documentElement.setAttribute("data-lab-startup", state);
    h.document.documentElement.setAttribute("data-studio-startup", state);
    h.mutations();
  }

  it("installs the studio guardian and its independent failure styles before every external resource", () => {
    const firstResource = html.search(/<(?:script\b[^>]*src=|link\b)/);
    expect(html.indexOf('id="studioBootstrapScript"')).toBeLessThan(firstResource);
    expect(html.indexOf('id="studioBootstrapStyle"')).toBeLessThan(firstResource);
    expect(studioBootstrapStyle).toContain('html[data-studio-bootstrap="resource-error"] body > :not(#labStartupStatus)');
    expect(studioBootstrapStyle).toContain('html[data-studio-bootstrap="resource-error"] #labStartupStatus');
    expect(studioBootstrapStyle).toContain('display: flex !important');
    expect(studioBootstrapStyle).toContain('background: #10170b; color: #f4f4ef');
    expect(studioRecoveryStyle?.match(/:not\(\[data-studio-bootstrap="resource-error"\]\)/g)).toHaveLength(2);
    expect(studioRecoveryStyle).not.toContain('data-studio-bootstrap="native-error"');
  });

  it.each(["/creative/web-chrome.js", "studio-entry.js"])("preserves a pre-body %s failure and renders an actionable reload screen", resource => {
    const h = harness(studio);
    expect(h.document.body.children).toHaveLength(0);
    h.resourceError("SCRIPT", resource);
    expect(h.document.documentElement.dataset.studioBootstrap).toBe("resource-error");
    expect(h.document.documentElement.dataset.labStartup).toBe("error");
    h.parseBody();h.domReady();
    expect(h.document.documentElement.dataset.studioStartup).toBe("resource-error");
    expect(h.element("labStartupStatus").getAttribute("role")).toBe("alert");
    expect(h.element("labStartupStatus").textContent).toContain("主图创作暂未就绪");
    expect(h.element("labStartupStatus").textContent).toContain("资源加载失败");
    h.element("labStartupStatus").querySelector("button")!.dispatch("click");
    expect(h.reload).toHaveBeenCalledOnce();
    expect(h.timers.size).toBe(0);
  });

  it.each(["before-body", "after-body"] as const)("shows CSS failure %s using inline styles that do not require the missing bundle", phase => {
    const h = harness(studio);
    if (phase === "after-body") { h.parseBody();h.domReady(); }
    h.resourceError("LINK", "studio-entry.css");
    if (phase === "before-body") { h.parseBody();h.domReady(); }
    expect(h.document.documentElement.dataset.studioBootstrap).toBe("resource-error");
    expect(h.element("labStartupStatus").textContent).toContain("资源加载失败");
    expect(h.element("labStartupStatus").querySelector("button")).not.toBeNull();
    expect(studioBootstrapStyle).toMatch(/resource-error"\] body[\s\S]*display:\s*none\s*!important/);
    expect(h.timers.size).toBe(0);
  });

  it.each([
    ["主图创作", studio], ["详情创作", "?mode=detail&studio=1"],
    ["广告图", "?type=ad&studio=1"], ["批量任务", "?batch=1&studio=1"]
  ])("shows a pending %s status after DCL without pretending restoration finished", (label, search) => {
    const h = harness(search);h.parseBody();h.domReady();
    expect(h.element("labStartupStatus").textContent).toBe(`正在打开${label}…`);
    expect(h.element("labStartupStatus").getAttribute("role")).toBe("status");
    expect(h.document.documentElement.dataset.labStartup).toBe("pending");
    expect(h.document.documentElement.dataset.studioBootstrap).toBe("pending");
    expect(h.timers.size).toBe(1);
    expect(h.context.SZ_LAB_FIRST_PAINT).toBeUndefined();
  });

  it("does not replace a successfully restored studio with later resource or timeout failures", () => {
    const h = harness(studio);h.parseBody();h.domReady();
    nativeState(h, "ready");
    expect(h.document.documentElement.dataset.studioBootstrap).toBe("ready");
    expect(h.timers.size).toBe(0);
    h.resourceError("SCRIPT", "studio-entry.js");h.resourceError("LINK", "studio-entry.css");h.expire();
    expect(h.document.documentElement.dataset.labStartup).toBe("ready");
    expect(h.document.documentElement.dataset.studioBootstrap).toBe("ready");
    expect(h.element("labStartupStatus").querySelector("button")).toBeNull();
  });

  it("bounds a blocked tail script before DCL and accepts the real studio's late completion", () => {
    const h = harness(studio);h.parseBody();
    expect(h.document.readyState).toBe("loading");
    h.expire();
    expect(h.document.documentElement.dataset.studioBootstrap).toBe("timeout");
    expect(h.element("labStartupStatus").textContent).toContain("加载超时");
    expect(h.element("labStartupStatus").querySelector("button")).not.toBeNull();
    h.domReady();
    expect(h.timers.size).toBe(0);
    h.document.documentElement.setAttribute("data-lab-startup", "ready");h.mutations();
    expect(h.document.documentElement.dataset.studioBootstrap).toBe("timeout");
    h.document.documentElement.setAttribute("data-studio-startup", "ready");h.mutations();
    expect(h.document.documentElement.dataset.studioBootstrap).toBe("ready");
    expect(h.document.documentElement.dataset.labStartup).toBe("ready");
  });

  it("keeps a fatal resource failure covered when surviving code later claims readiness", () => {
    const h = harness(studio);h.resourceError("LINK", "studio-entry.css");h.parseBody();h.domReady();
    nativeState(h, "ready");
    expect(h.document.documentElement.dataset.studioBootstrap).toBe("resource-error");
    expect(h.document.documentElement.dataset.labStartup).toBe("error");
    expect(h.document.documentElement.dataset.studioStartup).toBe("resource-error");
    expect(h.element("labStartupStatus").textContent).toContain("资源加载失败");
    expect(h.element("labStartupStatus").querySelector("button")).not.toBeNull();
  });

  it("ignores failed draft images while the studio is loading", () => {
    const h = harness(studio);h.parseBody();h.domReady();h.resourceError("IMG");
    expect(h.document.documentElement.dataset.studioBootstrap).toBe("pending");
    expect(h.element("labStartupStatus").getAttribute("role")).toBe("status");
    expect(h.timers.size).toBe(1);
  });

  it("retains the real studio's startup-error and in-place retry UI after a loading timeout", async () => {
    const h = harness(studio);h.parseBody();h.expire();
    // Execute the production studio with a missing bridge. Its own boot/catch
    // must render the recoverable native error; the guardian must relinquish it.
    runInContext(source("studio-genesis-ui.js"), h.context);h.domReady();
    await vi.waitFor(() => expect(h.document.getElementById("studioGenesisRoot")?.textContent).toContain("创作模块未完整加载"));
    h.mutations();
    expect(h.document.documentElement.dataset.studioBootstrap).toBe("native-error");
    expect(h.document.documentElement.dataset.studioStartup).toBe("error");
    expect(h.timers.size).toBe(0);
    const root = h.element("studioGenesisRoot"), retry = root.querySelector('[data-action="retry-startup"]')!;
    expect(retry).not.toBeNull();
    (root as Element & { onclick: (event: { target: Element }) => void }).onclick({ target: retry });
    h.mutations();
    expect(h.document.documentElement.dataset.studioBootstrap).toBe("pending");
    expect(h.element("labStartupStatus").getAttribute("role")).toBe("status");
    expect(h.element("labStartupStatus").textContent).not.toContain("加载超时");
    expect(h.timers.size).toBe(1);
    await vi.waitFor(() => expect(h.document.documentElement.dataset.studioStartup).toBe("error"));
    h.mutations();expect(h.document.documentElement.dataset.studioBootstrap).toBe("native-error");
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
