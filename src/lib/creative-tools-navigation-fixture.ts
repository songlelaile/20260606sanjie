import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { expect, vi } from "vitest";

const assetRoot = process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative";
const source = (name: string) => readFileSync(resolve(assetRoot, "labs/image-prompt-lab", name), "utf8");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export const ACCOUNT = "account:creative-navigation-fixture";
const IMAGE = "data:image/png;base64,iVBORw0KGgo=";
export const tools = ["refinement", "clothing", "buyer"] as const;
export type Tool = typeof tools[number];
type FixtureEvent = { target: Element; preventDefault: () => void; stopImmediatePropagation: () => void; [key: string]: unknown };
export type NavResult = { allowed: boolean; reason?: string };
// Storage and VM replies are dynamic boundaries. Declare only the fields that
// these fixtures create and the regression assertions inspect.
type ToolsSnapshot = {
  batchId: string;
  slots: Array<{ shot: { id: string; [key: string]: unknown }; [key: string]: unknown }>;
  previousResults: Array<{ item: { resultId: string; [key: string]: unknown }; [key: string]: unknown }>;
  uncertain?: unknown;
  [key: string]: unknown;
};
export type StoredToolDraft = { products: unknown[]; config: { requirements: string }; snapshot: ToolsSnapshot };
export type StoredMaterialDraft = Pick<StoredToolDraft, "config" | "snapshot">;
type GenerationReply = { ok: boolean; definitiveFailure?: boolean; code?: string; error?: string; images?: string[] };

function deferred<T>() {
  let complete!: (value: T) => void;
  const promise = new Promise<T>(resolve => { complete = resolve; });
  return { promise, complete };
}
export async function flushCreativeToolsFixture() { for (let i = 0; i < 80; i++) await Promise.resolve(); }

// A minimal DOM supplies browser APIs only. Every tested control, event handler,
// controller, draft serializer and public navigation bridge is from the real UI.
class Element {
  readonly attributes = new Map<string, string>();
  readonly children: Element[] = [];
  parentNode: Element | null = null;
  value = "";
  checked = false;
  files: unknown[] = [];
  text = "";
  style = {};
  private markup = "";
  constructor(readonly tagName: string, readonly document: TestDocument) {}
  get id() { return this.attributes.get("id") || ""; }
  set id(value: string) { this.attributes.set("id", value); }
  get className() { return this.attributes.get("class") || ""; }
  set className(value: string) { this.attributes.set("class", value); }
  get dataset() {
    return Object.fromEntries([...this.attributes].filter(([key]) => key.startsWith("data-")).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()), value]));
  }
  get disabled() { return this.attributes.has("disabled"); }
  set disabled(value: boolean) { if (value) this.attributes.set("disabled", ""); else this.attributes.delete("disabled"); }
  get hidden() { return this.attributes.has("hidden"); }
  set hidden(value: boolean) { if (value) this.attributes.set("hidden", ""); else this.attributes.delete("hidden"); }
  get type() { return this.attributes.get("type") || ""; }
  get isConnected() { return this.document.body.contains(this); }
  get classList() {
    const contains = (name: string) => this.className.split(/\s+/).includes(name);
    const toggle = (name: string, force = !contains(name)) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      if (force) names.add(name); else names.delete(name);
      this.className = [...names].join(" "); return force;
    };
    return { contains, toggle, add: (name: string) => toggle(name, true), remove: (name: string) => toggle(name, false) };
  }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.children.splice(0); this.text = value; }
  get innerHTML() { return this.markup; }
  set innerHTML(value: string) {
    this.markup = value; this.children.splice(0); this.text = "";
    const stack: Element[] = [this], voidTags = new Set(["input", "img", "br", "hr"]);
    for (const match of value.matchAll(/<\/?([a-z][a-z0-9-]*)([^>]*?)>|([^<]+)/gi)) {
      if (match[3]) { stack[stack.length - 1].text += match[3]; continue; }
      const tag = match[1].toLowerCase();
      if (match[0].startsWith("</")) { while (stack.length > 1) if (stack.pop()?.tagName === tag.toUpperCase()) break; continue; }
      const child = new Element(tag.toUpperCase(), this.document);
      for (const attribute of match[2].matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) child.attributes.set(attribute[1], attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
      child.value = child.attributes.get("value") || ""; child.checked = child.attributes.has("checked");
      stack[stack.length - 1].appendChild(child);
      if (!voidTags.has(tag) && !match[0].endsWith("/>")) stack.push(child);
    }
  }
  appendChild(child: Element) { child.parentNode = this; this.children.push(child); return child; }
  append(child: Element) { return this.appendChild(child); }
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  contains(child: Element) { return this === child || this.descendants().includes(child); }
  matches(selector: string): boolean {
    return selector.split(",").some(part => {
      const simple = part.trim();
      if (simple.startsWith("#")) return this.id === simple.slice(1);
      if (simple.startsWith(".")) return this.classList.contains(simple.slice(1));
      const negative = /^(.*):not\(\[([^\]]+)\]\)$/.exec(simple);
      if (negative) return this.matches(negative[1]) && !this.attributes.has(negative[2]);
      const attributes = /^([a-z]+)?((?:\[[^\]]+\])+)(:checked)?$/i.exec(simple);
      if (attributes) return (!attributes[1] || this.tagName === attributes[1].toUpperCase()) && [...attributes[2].matchAll(/\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]/g)].every(attribute => this.attributes.has(attribute[1]) && (!attribute[2] || this.attributes.get(attribute[1]) === attribute[2])) && (!attributes[3] || this.checked);
      return this.tagName === simple.toUpperCase();
    });
  }
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  querySelectorAll(selector: string) { return this.descendants().filter(element => element.matches(selector)); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  focus() { this.document.activeElement = this; }
  getClientRects() { return this.hidden ? [] : [{}]; }
}

class TestDocument {
  readonly body = new Element("BODY", this);
  readonly readyState = "complete";
  readonly visibilityState = "visible";
  readonly listeners = new Map<string, Array<(event: FixtureEvent) => void>>();
  activeElement: Element | null = null;
  title = "";
  constructor() {
    for (const id of ["creativeToolsRoot", "labHeroTitle", "labHeroEyebrow", "labHeroSubtitle"]) {
      const element = this.createElement("div"); element.id = id; this.body.appendChild(element);
    }
  }
  createElement(tag: string) { return new Element(tag.toUpperCase(), this); }
  querySelector(selector: string) { return this.body.querySelector(selector); }
  getElementById(id: string) { return this.querySelector(`#${id}`); }
  addEventListener(name: string, listener: (event: FixtureEvent) => void) {
    const list = this.listeners.get(name) || []; list.push(listener); this.listeners.set(name, list);
  }
  dispatch(name: string, target: Element, extra: Record<string, unknown> = {}) {
    const event = { target, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...extra };
    for (const listener of this.listeners.get(name) || []) listener(event);
  }
  control(selector: string) {
    const control = this.body.querySelector(selector);
    if (!control) throw new Error(`Real creative UI did not render ${selector}`);
    return control;
  }
}

export function createCreativeToolsFixture(tool: Tool, options: { uncertain?: boolean; modalUncertain?: boolean; pendingReady?: boolean; inFlightInterface?: boolean; seedRecords?: Map<string, unknown>; seedJournals?: Map<string, string> } = {}) {
  let username = ACCOUNT, importing = false, holdWrites = false, failWrites = false, heldReadKey = "", inFlight = false;
  const document = new TestDocument(), apiSwitch = deferred<{ ok: boolean }>(), analysis = deferred<string>(), ready = deferred<{ ok: boolean }>();
  const records = new Map<string, unknown>(), journals = new Map<string, string>();
  const writes: Array<{ key: string; value: unknown }> = [], heldWrites: Array<() => void> = [], heldReads: Array<() => void> = [];
  const sends: Array<{ type: string; message: unknown; response: ReturnType<typeof deferred<GenerationReply>> }> = [];
  const readers: Array<{ complete: () => void }> = [];
  const timers = new Map<number, () => void>(), timerDelays = new Map<number, number>(); let timerId = 0;
  const forbidden = vi.fn(() => { throw new Error("Network and paid requests are forbidden in this VM navigation regression"); });
  const bridge = {
    ready: vi.fn(() => options.pendingReady ? ready.promise : Promise.resolve({ ok: true })),
    getAccountKey: vi.fn(async () => username),
    config: () => ({ provider: "fixture", imageAdapter: "generic-json", imageModel: "fixture-image" }),
    archiveContext: () => ({ accountKey: username }),
    archive: vi.fn(async () => ({ ok: true })),
    listBoundApis: vi.fn(async () => ({ ok: true, accountKey: username, providers: [{ provider: "fixture", imageModel: "fixture-image" }, { provider: "alternate", imageModel: "fixture-alternate" }] })),
    modelInfo: () => ({ ready: true, supportsReference: true, provider: "fixture", model: "fixture-image" }),
    selectBoundApi: vi.fn(() => apiSwitch.promise),
    analyze: vi.fn(() => analysis.promise),
    setApiBusy: vi.fn(), openConfig: vi.fn(),
    send: vi.fn((type: string, message: unknown) => {
      const response = deferred<GenerationReply>(); sends.push({ type, message, response }); return response.promise;
    })
  };
  const db = { transaction: () => {
    const tx = { oncomplete: undefined as undefined | (() => void), onerror: undefined as undefined | (() => void), onabort: undefined as undefined | (() => void), error: new Error("fixture save quota failure"), objectStore: () => ({
      get: (key: string) => {
        const request = { result: undefined as unknown, onsuccess: undefined as undefined | (() => void) };
        const complete = () => { request.result = clone(records.get(key) ?? null); request.onsuccess?.(); };
        if (heldReadKey === key) heldReads.push(complete); else queueMicrotask(complete);
        return request;
      },
      put: (value: unknown, key: string) => {
        writes.push({ key, value: clone(value) });
        const complete = () => { if (failWrites) tx.onabort?.(); else { records.set(key, clone(value)); tx.oncomplete?.(); } };
        if (holdWrites) heldWrites.push(complete); else queueMicrotask(complete);
      }
    }) }; return tx;
  } };
  const context = createContext({ document, URL, URLSearchParams, console, crypto: { randomUUID },
    indexedDB: { open: () => { const request = { result: db, onsuccess: undefined as undefined | (() => void) }; queueMicrotask(() => request.onsuccess?.()); return request; } },
    localStorage: { getItem: (key: string) => journals.get(key) ?? null, setItem: (key: string, value: string) => journals.set(key, value), removeItem: vi.fn((key: string) => journals.delete(key)) },
    navigator: { locks: { request: async (_name: string, _options: unknown, run: (lock: unknown) => unknown) => run({ name: "offline-lock" }) } },
    location: { search: `?mode=creative&tool=${tool}`, href: `https://fixture.test/promptlab.html?mode=creative&tool=${tool}` },
    history: { replaceState: vi.fn() },
    setTimeout: (callback: () => void, delay: number) => { const id = ++timerId; timers.set(id, callback); timerDelays.set(id, delay); return id; }, clearTimeout: (id: number) => { timers.delete(id); timerDelays.delete(id); },
    addEventListener: vi.fn(), fetch: forbidden, XMLHttpRequest: forbidden, WebSocket: forbidden,
    FileReader: class {
      result = IMAGE; onload?: () => void;
      readAsDataURL() { readers.push({ complete: () => this.onload?.() }); }
    },
    Image: class {
      naturalWidth = 64; naturalHeight = 64; onload?: () => void;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    },
    SZ_CREATIVE_TOOLS_BRIDGE: bridge,
    SZ_LAB_STARTUP: { ready: vi.fn(), fail: vi.fn() }
  });
  context.window = context;
  runInContext(source("creative-tools-contract.js"), context, { filename: "creative-tools-contract.js" });
  const engine = context.SZ_CREATIVE_TOOLS_CONTRACT;
  const draft = { schema: 1, tool, mode: "tryon", products: [{ image: IMAGE, name: "保留商品", width: 64, height: 64 }], model: { image: IMAGE, name: "保留模特" }, scene: null,
    config: { name: "保留项目", requirements: "保留要求", count: 1, ratio: tool === "refinement" ? "auto" : "3:4", resolution: "1K", style: "品牌大片", language: "无文字纯视觉", background: "original", analysis: "",
      basic: { white: { enabled: true, front: true, back: false }, threeD: { enabled: false, white: true }, mannequin: { enabled: false, white: true }, detail: { enabled: false, count: 1 }, selling: { enabled: false, count: 1 } } }, savedAt: "2026-10-09T00:00:00.000Z", snapshot: null as ToolsSnapshot | null };
  const prior = engine.createController({ readInput: () => ({ ...draft, modelImage: tool === "refinement" ? "" : draft.model.image }), config: bridge.config, archiveContext: bridge.archiveContext });
  const priorPlan = prior.buildPlan(); expect(priorPlan.ok, priorPlan.error).toBe(true);
  draft.snapshot = prior.snapshot() as ToolsSnapshot;
  // A completed old version checks that saving does not discard existing work.
  draft.snapshot.previousResults = [{ shot: clone(draft.snapshot.slots[0].shot), status: "done", item: { url: IMAGE, resultId: "completed-fixture", businessRoleName: "已完成成果" }, archiveOk: true }];
  records.set(`${ACCOUNT}:tool:${tool}`, clone(draft));
  const receipt = { jobId: "unconfirmed-fixture", shotId: draft.snapshot.slots[0].shot.id, batchId: draft.snapshot.batchId, tool };
  const receiptKey = `sz_creative_pending_v1:${ACCOUNT}:${tool}`;
  if (options.uncertain) journals.set(receiptKey, JSON.stringify(receipt));
  if (options.modalUncertain) journals.set(`sz_creative_pending_v1:${ACCOUNT}:material:model`, JSON.stringify({ ...receipt, tool: "model" }));
  // A reload reads the previously committed data, including its original batch
  // identity, rather than the fresh fixture's synthetic default draft.
  for (const [key, value] of options.seedRecords || []) records.set(key, clone(value));
  for (const [key, value] of options.seedJournals || []) journals.set(key, value);
  if (options.inFlightInterface) context.SZ_CREATIVE_TOOLS_CONTRACT = { ...engine, createController: (deps: unknown) => ({ ...engine.createController(deps), hasInFlightRequest: () => inFlight }) };
  const upload = createContext({ document: { readyState: "loading", addEventListener() {} } }); upload.window = upload;
  runInContext(source("image-upload.js"), upload, { filename: "image-upload.js" });
  context.SZ_IMAGE_UPLOAD = { ...upload.SZ_IMAGE_UPLOAD, isImporting: () => importing };
  runInContext(source("creative-tools-ui.js"), context, { filename: "creative-tools-ui.js" });
  const releaseWrites = async () => { holdWrites = false; for (const complete of heldWrites.splice(0)) complete(); await flushCreativeToolsFixture(); };
  return { context, document, bridge, records, journals, writes, heldWrites, heldReads, sends, readers, timers, timerDelays, ready, receiptKey, receipt, draft, forbidden, apiSwitch, analysis,
    ui: () => context.SZ_CREATIVE_TOOLS_UI,
    click: (selector: string) => document.dispatch("click", document.control(selector)),
    holdWrites: () => { holdWrites = true; }, releaseWrites,
    releaseOneWrite: async () => { const complete = heldWrites.shift(); if (!complete) throw new Error("No IndexedDB write is pending"); complete(); await flushCreativeToolsFixture(); },
    failWrites: () => { failWrites = true; }, recoverWrites: () => { failWrites = false; }, setAccount: (value: string) => { username = value; },
    setImporting: (value: boolean) => { importing = value; document.dispatch("cu-import-state", document.body, { detail: { pending: value, scope: "creative", inputKey: "products" } }); },
    holdRead: (key: string) => { heldReadKey = key; }, releaseReads: async () => { heldReadKey = ""; for (const complete of heldReads.splice(0)) complete(); await flushCreativeToolsFixture(); },
    setInFlight: (value: boolean) => { inFlight = value; },
    fireGenerationTimeout: async () => { const id = [...timerDelays].find(([, delay]) => delay === 12 * 60 * 1000)?.[0]; if (id === undefined) throw new Error("No real controller request timeout is pending"); timers.get(id)!(); await flushCreativeToolsFixture(); },
    finishGeneration: async (response: GenerationReply = { ok: false, definitiveFailure: true, code: "CONFIG_OFFLINE_FIXTURE", error: "离线测试已结束" }) => { for (const send of sends) send.response.complete(response); await flushCreativeToolsFixture(); }
  };
}

export async function bootCreativeToolsFixture(tool: Tool, options: Parameters<typeof createCreativeToolsFixture>[1] = {}) {
  const h = createCreativeToolsFixture(tool, options); await flushCreativeToolsFixture();
  expect(h.context.SZ_LAB_STARTUP.fail).not.toHaveBeenCalled();
  expect(h.ui().getState().ready).toBe(true);
  expect(h.ui().getState().tool).toBe(tool);
  expect(h.forbidden).not.toHaveBeenCalled();
  return h;
}
