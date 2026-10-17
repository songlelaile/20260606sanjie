import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const assetRoot = process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative";
const source = (name: string) => readFileSync(resolve(assetRoot, "labs/image-prompt-lab", name), "utf8");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const accountKey = "account:startup-fixture";
const provider = { provider: "openai-compatible", label: "Fixture API", imageModel: "fixture-catalog-image" };
type Catalog = { ok: boolean; accountKey?: string; providers?: typeof provider[]; error?: string };

function deferred<T>() {
  let complete!: (value: T) => void, fail!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => { complete = resolve; fail = reject; });
  return { promise, complete, fail };
}

type DomEvent = { type: string; target: Element; preventDefault: () => void; dataTransfer?: { files: unknown[] } };
type UnloadEvent = { preventDefault: () => void; returnValue?: string };

// This DOM only supplies the APIs used by the real UI. The actual script builds
// all controls; assertions never substitute a hand-written workspace or boot.
class Element {
  readonly attributes = new Map<string, string>();
  readonly children: Element[] = [];
  readonly listeners = new Map<string, Array<(event: DomEvent) => void>>();
  parentNode: Element | null = null;
  value = "";
  checked = false;
  text = "";
  private markup = "";
  constructor(readonly tagName: string, readonly document: TestDocument) {}
  get id() { return this.attributes.get("id") || ""; }
  set id(value: string) { this.attributes.set("id", value); }
  get dataset() {
    return Object.fromEntries([...this.attributes].filter(([key]) => key.startsWith("data-")).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()), value]));
  }
  get disabled() { return this.attributes.has("disabled"); }
  set disabled(value: boolean) { if (value) this.attributes.set("disabled", ""); else this.attributes.delete("disabled"); }
  get hidden() { return this.attributes.has("hidden"); }
  set hidden(value: boolean) { if (value) this.attributes.set("hidden", ""); else this.attributes.delete("hidden"); }
  get type() { return this.attributes.get("type") || ""; }
  get classList() {
    const contains = (name: string) => (this.attributes.get("class") || "").split(/\s+/).includes(name);
    const toggle = (name: string, force = !contains(name)) => {
      const names = new Set((this.attributes.get("class") || "").split(/\s+/).filter(Boolean));
      if (force) names.add(name); else names.delete(name);
      this.attributes.set("class", [...names].join(" "));
      return force;
    };
    return { contains, toggle, add: (name: string) => toggle(name, true), remove: (name: string) => toggle(name, false) };
  }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.children.splice(0); this.text = value; }
  get innerHTML() { return this.markup; }
  set innerHTML(value: string) {
    this.markup = value;
    this.children.splice(0); this.text = "";
    this.document.renders.push(value);
    const stack: Element[] = [this], voidTags = new Set(["input", "img", "br", "hr"]);
    for (const match of value.matchAll(/<\/?([a-z][a-z0-9-]*)([^>]*?)>|([^<]+)/gi)) {
      if (match[3]) { stack[stack.length - 1].text += match[3]; continue; }
      const tag = match[1].toLowerCase();
      if (match[0].startsWith("</")) {
        while (stack.length > 1) if (stack.pop()?.tagName === tag.toUpperCase()) break;
        continue;
      }
      const child = new Element(tag.toUpperCase(), this.document);
      for (const attribute of match[2].matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) child.attributes.set(attribute[1], attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
      child.value = child.attributes.get("value") || "";
      child.checked = child.attributes.has("checked");
      stack[stack.length - 1].appendChild(child);
      if (!voidTags.has(tag) && !match[0].endsWith("/>")) stack.push(child);
    }
  }
  appendChild(child: Element) { child.parentNode = this; this.children.push(child); return child; }
  prepend(child: Element) { child.parentNode = this; this.children.unshift(child); }
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  matches(selector: string): boolean {
    return selector.split(",").some(part => {
      const simple = part.trim();
      if (simple.startsWith("#")) return this.id === simple.slice(1);
      if (simple.startsWith(".")) return this.classList.contains(simple.slice(1));
      const attribute = /^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\](:checked)?$/.exec(simple);
      if (attribute) return this.attributes.has(attribute[1]) && (!attribute[2] || this.attributes.get(attribute[1]) === attribute[2]) && (!attribute[3] || this.checked);
      return this.tagName === simple.toUpperCase();
    });
  }
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  querySelectorAll(selector: string) { return this.descendants().filter(element => element.matches(selector)); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  addEventListener(name: string, listener: (event: DomEvent) => void) {
    const list = this.listeners.get(name) || []; list.push(listener); this.listeners.set(name, list);
  }
  dispatch(type: string, target: Element, extra: Partial<DomEvent> = {}) {
    const event: DomEvent = { type, target, preventDefault: vi.fn(), ...extra };
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

class TestDocument {
  readonly renders: string[] = [];
  readonly body = new Element("BODY", this);
  readonly app = new Element("DIV", this);
  readonly readyState = "complete";
  readonly visibilityState = "visible";
  constructor() { this.app.attributes.set("class", "app"); this.body.appendChild(this.app); }
  createElement(tag: string) { return new Element(tag.toUpperCase(), this); }
  querySelector(selector: string) { return this.body.querySelector(selector); }
  getElementById(id: string) { return this.querySelector(`#${id}`); }
  addEventListener() {}
  get root() {
    const root = this.getElementById("studioGenesisRoot");
    if (!root) throw new Error("The real UI has not created its root");
    return root;
  }
  control(selector: string) {
    const control = this.root.querySelector(selector);
    if (!control) throw new Error(`The real UI did not render ${selector}`);
    return control;
  }
}

function harness(mode: "main" | "detail", options: { savedMode?: "main" | "detail"; explicit?: boolean; failBackup?: boolean } = {}) {
  const holdRestore = false;
  const uiScript = source("studio-genesis-ui.js");
  const document = new TestDocument(), refresh = deferred<{ ok: boolean; accountKey: string; error?: string }>(), catalog = deferred<Catalog>();
  const read = deferred<unknown>(), restore = deferred<void>();
  const reads: string[] = [], writes: Array<{ key: string; value: unknown }> = [];
  const windowListeners = new Map<string, Array<(event: UnloadEvent) => void>>();
  const bridge = {
    refresh: vi.fn(() => refresh.promise),
    getAccountKey: vi.fn(async () => accountKey),
    listBoundApis: vi.fn(() => catalog.promise),
    modelInfo: vi.fn(() => ({ ready: true, supportsReference: true, provider: provider.provider, model: provider.imageModel })),
    setApiBusy: vi.fn(), openConfig: vi.fn(), analyze: vi.fn(), send: vi.fn()
  };
  const db = {
    transaction: (_store: string, access?: string) => {
      const tx = { oncomplete: undefined as undefined | (() => void), onabort: undefined as undefined | (() => void), error: new Error("fixture backup quota exceeded"), objectStore: () => ({
        get: (key: string) => {
          reads.push(key);
          const request = { result: undefined as unknown, onsuccess: undefined as undefined | (() => void) };
          read.promise.then(value => { request.result = clone(value); request.onsuccess?.(); });
          return request;
        },
        put: (value: unknown, key: string) => { writes.push({ key, value: clone(value) }); queueMicrotask(() => options.failBackup && key.includes(":before-explicit-mode:") ? tx.onabort?.() : tx.oncomplete?.()); }
      }) };
      if (access && access !== "readwrite") throw new Error(`Unexpected access: ${access}`);
      return tx;
    }
  };
  const indexedDB = { open: vi.fn(() => {
    const request = { result: db, onsuccess: undefined as undefined | (() => void) };
    queueMicrotask(() => request.onsuccess?.()); return request;
  }) };
  const context = createContext({ document, indexedDB, URL, URLSearchParams, crypto: { randomUUID }, console, setTimeout, clearTimeout,
    location: { search: options.explicit === false ? "?studio=1" : `?studio=1&mode=${mode}` }, localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
    addEventListener: (name: string, listener: (event: UnloadEvent) => void) => {
      const listeners = windowListeners.get(name) || []; listeners.push(listener); windowListeners.set(name, listeners);
    },
    SZ_CREATIVE_TOOLS_BRIDGE: bridge });
  context.window = context;
  // Use the matching production upload markup when the UI references it,
  // without starting its decoration observer in this focused startup harness.
  if (uiScript.includes("SZ_IMAGE_UPLOAD")) {
    const uploadContext = createContext({ document: { readyState: "loading", addEventListener: vi.fn() } });
    uploadContext.window = uploadContext;
    runInContext(source("image-upload.js"), uploadContext, { filename: "image-upload.js" });
    context.SZ_IMAGE_UPLOAD = uploadContext.SZ_IMAGE_UPLOAD;
  }
  runInContext(source("studio-genesis-contract.js"), context, { filename: "studio-genesis-contract.js" });
  const engine = context.SZ_STUDIO_GENESIS;
  const settings = { ...engine.defaults(options.savedMode || mode), model: "saved-product-image", count: 1 };
  const task = { id: "saved-product", name: "已保存商品", requirements: "已保存的创作要求", products: [{ image: "https://fixture.test/product.png", name: "原产品图" }], overrides: null, confirmed: true, collapsed: false, plan: null as unknown };
  task.plan = engine.createPlan(task, settings);
  const savedController = engine.createController({ bridge });
  savedController.state.accountKey = accountKey;
  savedController.state.tasks = [{ id: task.id, name: task.name, plan: task.plan, slots: (task.plan as { shots: unknown[] }).shots.map(shot => ({ shot, status: "ready", item: null, error: "", archiveOk: false })) }];
  const snapshot = savedController.snapshot();
  const saved = { draft: { settings, tasks: [task] }, snapshot, savedAt: "2026-10-01T23:59:00.000Z" };
  const restoreStarted = vi.fn();
  if (holdRestore) {
    context.SZ_STUDIO_GENESIS = { ...engine, createController: (deps: unknown) => {
      const controller = engine.createController(deps);
      return { ...controller, restore: async (value: unknown) => { restoreStarted(); await restore.promise; return controller.restore(value); } };
    } };
  }
  runInContext(uiScript, context, { filename: "studio-genesis-ui.js" });
  const beforeUnload = () => {
    const event: UnloadEvent = { preventDefault: vi.fn() };
    for (const listener of windowListeners.get("beforeunload") || []) listener(event);
    return event;
  };
  return { document, bridge, refresh, catalog, read, restore, restoreStarted, reads, writes, saved, beforeUnload };
}


async function completeBoot(h: ReturnType<typeof harness>) {
  h.refresh.complete({ ok: true, accountKey }); h.read.complete(h.saved);
  await vi.waitFor(() => expect(h.bridge.listBoundApis, h.document.root.textContent).toHaveBeenCalledOnce());
  h.catalog.complete({ ok: true, accountKey, providers: [provider] });
  await vi.waitFor(() => expect(h.document.control("[data-setting=model]").disabled).toBe(false));
}

describe("explicit official module entries retain account materials and prior work", () => {
  it.each(["main", "detail"] as const)("opens the explicit %s module while retaining the old opposite-mode draft", async mode => {
    const h = harness(mode, { savedMode: mode === "main" ? "detail" : "main" });
    const original = clone(h.saved);
    await completeBoot(h);
    const tab = h.document.root.querySelector(`[data-mode=${mode}]`)!;
    expect(tab.attributes.get("aria-selected")).toBe("true");
    expect(h.document.root.textContent).toContain(mode === "main" ? "主图生图实验室" : "详情生图实验室");
    expect(h.document.control("[data-task-field=name]").value).toBe("已保存商品");
    expect(h.document.control("[data-task-field=requirements]").textContent).toBe("已保存的创作要求");
    expect(h.document.control("[data-setting=model]").value).toBe("saved-product-image");
    expect(h.document.root.querySelector("[data-product-preview]")?.attributes.get("src")).toBe("https://fixture.test/product.png");
    expect(h.document.root.querySelector("[data-confirm]")).toBeNull();
    expect(h.document.control("[data-action=generate]").disabled).toBe(true);
    expect(h.writes).toEqual([{ key: `${accountKey}:single:${mode}:before-explicit-mode:${original.savedAt}`, value: original }]);
    expect(h.saved).toEqual(original);
    expect(h.bridge.send).not.toHaveBeenCalled(); expect(h.bridge.analyze).not.toHaveBeenCalled();
    h.beforeUnload();
    await vi.waitFor(() => expect(h.writes).toHaveLength(2));
    const current = h.writes[1].value as typeof original;
    expect(h.writes[1].key).toBe(`${accountKey}:single:${mode}`);
    expect(current.draft.settings.mode).toBe(mode);
    expect(current.draft.tasks[0].products).toEqual(original.draft.tasks[0].products);
    expect(current.draft.tasks[0].requirements).toBe(original.draft.tasks[0].requirements);
    expect(current.draft.tasks[0].confirmed).toBe(false); expect(current.draft.tasks[0].plan).toBeNull();
    expect(current.snapshot.accountKey).toBe(original.snapshot.accountKey);
    expect(current.snapshot.previousResults).toEqual(original.snapshot.previousResults);
    expect(current.snapshot.tasks.map((entry: { id: string; plan: unknown; slots: Array<{shot: unknown; item: unknown; status: string}> }) => ({id: entry.id, plan: entry.plan, slots: entry.slots.map(({shot,item,status}) => ({shot,item,status}))}))).toEqual(original.snapshot.tasks.map((entry: { id: string; plan: unknown; slots: Array<{shot: unknown; item: unknown; status: string}> }) => ({id: entry.id, plan: entry.plan, slots: entry.slots.map(({shot,item,status}) => ({shot,item,status}))})));
  });

  it("keeps the existing preference for an old bookmark without explicit mode", async () => {
    const h = harness("main", { savedMode: "detail", explicit: false });
    await completeBoot(h);
    expect(h.document.root.querySelector("[data-mode=detail]")?.attributes.get("aria-selected")).toBe("true");
    expect(h.document.root.querySelector("[data-confirm]")?.checked).toBe(true);
    expect(h.writes).toEqual([]); expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("does not rewrite a matching explicit module draft", async () => {
    const h = harness("main"); await completeBoot(h);
    expect(h.document.root.querySelector("[data-mode=main]")?.attributes.get("aria-selected")).toBe("true");
    expect(h.document.root.querySelector("[data-confirm]")?.checked).toBe(true);
    expect(h.writes).toEqual([]);
  });

  it("leaves the original draft untouched when the safety backup cannot be saved", async () => {
    const h = harness("main", { savedMode: "detail", failBackup: true });
    const original = clone(h.saved);
    h.refresh.complete({ ok: true, accountKey }); h.read.complete(h.saved);
    await vi.waitFor(() => expect(h.document.root.textContent).toContain("fixture backup quota exceeded"));
    expect(h.document.root.textContent).toContain("创作工作台暂未就绪");
    expect(h.document.root.querySelector("[data-action=generate]")).toBeNull();
    expect(h.writes).toEqual([{ key: `${accountKey}:single:main:before-explicit-mode:${original.savedAt}`, value: original }]);
    expect(h.saved).toEqual(original);
    expect(h.bridge.listBoundApis).not.toHaveBeenCalled(); expect(h.bridge.send).not.toHaveBeenCalled();
    h.beforeUnload(); await new Promise(resolve => setTimeout(resolve, 1));
    expect(h.writes).toHaveLength(1);
  });
});
