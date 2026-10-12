import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { vi } from "vitest";

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
    for (const child of this.descendants()) {
      if (child.tagName === "TEXTAREA") child.value = child.textContent;
      if (child.tagName === "SELECT" && !child.attributes.has("value")) {
        const option = child.children.find(item => item.hasAttribute("selected")) || child.children[0];
        child.value = option?.value || "";
      }
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
  focus() {}
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
  readonly listeners = new Map<string, Array<(event: DomEvent) => void>>();
  readonly body = new Element("BODY", this);
  readonly app = new Element("DIV", this);
  readonly readyState = "complete";
  visibilityState = "visible";
  constructor() { this.app.attributes.set("class", "app"); this.body.appendChild(this.app); }
  createElement(tag: string) { return new Element(tag.toUpperCase(), this); }
  querySelector(selector: string) { return this.body.querySelector(selector); }
  getElementById(id: string) { return this.querySelector(`#${id}`); }
  addEventListener(name: string, listener: (event: DomEvent) => void) {
    const listeners = this.listeners.get(name) || []; listeners.push(listener); this.listeners.set(name, listeners);
  }
  dispatch(type: string) {
    const event: DomEvent = { type, target: this.body, preventDefault: vi.fn() };
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
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

type StartupEntry = "main" | "detail" | "ad" | "batch";
type StartupOptions = { holdRecovery?: boolean; omitRecovery?: boolean; timeoutMs?: number; apiDialog?: boolean; sharedDrafts?: Map<string, unknown> };
const draftTransactionQueues = new WeakMap<Map<string, unknown>, Promise<void>>();
function harness(entry: StartupEntry, holdRestore = false, storage = new Map<string, string>(), environment = "", startup: StartupOptions = {}) {
  const mode = entry === "detail" ? "detail" : "main";
  const uiScript = source("studio-genesis-ui.js");
  const document = new TestDocument(), refresh = deferred<{ ok: boolean; accountKey: string; error?: string; boundApis?: Catalog }>(), catalog = deferred<Catalog>();
  const read = deferred<unknown>(), restore = deferred<void>(), recovery = deferred<void>();
  const reads: string[] = [], writes: Array<{ key: string; value: unknown }> = [];
  const writeControl: { wait?: Promise<void>; error?: Error } = {};
  const windowListeners = new Map<string, Array<(event: UnloadEvent) => void>>();
  const dispatchWindow = (type: string) => {
    const event: UnloadEvent = { preventDefault: vi.fn() };
    for (const listener of windowListeners.get(type) || []) listener(event);
    return event;
  };
  if (startup.apiDialog) {
    const cancel = document.createElement("button");cancel.id = "configCancelBtn";document.body.appendChild(cancel);
  }
  const bridge = {
    refresh: vi.fn(() => refresh.promise),
    getAccountKey: vi.fn(async () => accountKey),
    listBoundApis: vi.fn((snapshot?: Catalog) => snapshot ? Promise.resolve(snapshot) : catalog.promise),
    modelInfo: vi.fn(() => ({ ready: true, supportsReference: true, provider: provider.provider, model: provider.imageModel })),
    recoverGenerationJob: vi.fn(), setApiBusy: vi.fn(), openConfig: vi.fn(), analyze: vi.fn(), send: vi.fn()
  };
  const persistedDrafts=startup.sharedDrafts||new Map<string,unknown>();let initialDraftSeeded=!!startup.sharedDrafts;
  const initialDraftKey=`${accountKey}:${entry==='batch'?'batch':'single'}:${mode}${entry==='ad'?':ad':''}`;
  const db = {
    transaction: (_store: string, access?: string) => {
      if (access && !["readonly","readwrite"].includes(access)) throw new Error(`Unexpected access: ${access}`);
      const prior=draftTransactionQueues.get(persistedDrafts)||Promise.resolve();let release!:()=>void;
      draftTransactionQueues.set(persistedDrafts,new Promise<void>(resolve=>{release=resolve;}));
      const pendingWrites=new Map<string,unknown>();let pending=0,finished=false;
      const finish=(kind:"complete"|"abort"|"error")=>{
        if(finished)return;finished=true;
        if(kind==="complete")pendingWrites.forEach((value,key)=>persistedDrafts.set(key,clone(value)));
        release();queueMicrotask(()=>{if(kind==="complete")tx.oncomplete?.();else if(kind==="abort")tx.onabort?.();else tx.onerror?.();});
      };
      const idle=()=>queueMicrotask(()=>{if(!pending&&!finished)finish("complete");});
      const tx = { oncomplete: undefined as undefined | (() => void), onerror: undefined as undefined | (() => void), onabort: undefined as undefined | (() => void), error: undefined as undefined | Error,
        abort:()=>finish("abort"),objectStore: () => ({
        get: (key: string) => {
          reads.push(key);
          const request = { result: undefined as unknown, onsuccess: undefined as undefined | (() => void) };
          pending++;
          prior.then(()=>read.promise).then(value=>{
            if(finished)return;
            if(!initialDraftSeeded){initialDraftSeeded=true;if(value!==undefined)persistedDrafts.set(initialDraftKey,clone(value));}
            const saved=pendingWrites.has(key)?pendingWrites.get(key):persistedDrafts.get(key);
            request.result=saved===undefined?undefined:clone(saved);request.onsuccess?.();
          }).finally(()=>{pending--;idle();});
          return request;
        },
        put: (value: unknown, key: string) => {
          const captured=clone(value);writes.push({key,value:captured});pending++;
          prior.then(()=>writeControl.wait).then(()=>{
            if(finished)return;
            if(writeControl.error){tx.error=writeControl.error;finish("error");}
            else pendingWrites.set(key,captured);
          }).finally(()=>{pending--;idle();});
        }
      }) };
      prior.then(idle);
      return tx;
    }
  };
  const indexedDB = { open: vi.fn(() => {
    const request = { result: db, onsuccess: undefined as undefined | (() => void) };
    queueMicrotask(() => request.onsuccess?.()); return request;
  }) };
  const context = createContext({ document, indexedDB, URL, URLSearchParams, crypto: { randomUUID }, console, setTimeout, clearTimeout,
    __SANJIE_ENVIRONMENT: environment,
    navigator: { locks: { request: async (name: string, _options: unknown, callback: (lock: { name: string }) => unknown) => callback({ name }) } },
    location: { search: `?studio=1&mode=${mode}${entry === "ad" ? "&type=ad" : entry === "batch" ? "&batch=1" : ""}` }, localStorage: {
      get length() { return storage.size; },
      key: (index: number) => [...storage.keys()][index] ?? null,
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    },
    addEventListener: (name: string, listener: (event: UnloadEvent) => void) => {
      const listeners = windowListeners.get(name) || []; listeners.push(listener); windowListeners.set(name, listeners);
    },
    SZ_LAB_FIRST_PAINT: { complete: vi.fn() }, SZ_CREATIVE_TOOLS_BRIDGE: bridge });
  context.window = context;
  // Use the matching production upload markup when the UI references it,
  // without starting its decoration observer in this focused startup harness.
  if (uiScript.includes("SZ_IMAGE_UPLOAD")) {
    const uploadContext = createContext({ document: { readyState: "loading", addEventListener: vi.fn() } });
    uploadContext.window = uploadContext;
    runInContext(source("image-upload.js"), uploadContext, { filename: "image-upload.js" });
    context.SZ_IMAGE_UPLOAD = uploadContext.SZ_IMAGE_UPLOAD;
  }
  const contractSource = process.env.STUDIO_CONTRACT_TEST_FILE ? readFileSync(process.env.STUDIO_CONTRACT_TEST_FILE, "utf8") : source("studio-genesis-contract.js");
  runInContext(contractSource, context, { filename: "studio-genesis-contract.js" });
  const engine = context.SZ_STUDIO_GENESIS;
  const settings = { ...engine.defaults(mode), model: "saved-product-image", count: 1 };
  if (entry === "ad") Object.assign(settings, { imageType: "ad", adType: "电商广告", adTemplate: engine.adTemplates[0].id });
  const task = { id: "saved-product", name: "已保存商品", requirements: "已保存的创作要求", products: [{ image: "https://fixture.test/product.png", name: "原产品图" }], overrides: null, confirmed: true, collapsed: false, plan: null as unknown };
  task.plan = engine.createPlan(task, settings);
  const savedController = engine.createController({ bridge });
  savedController.state.accountKey = accountKey;
  savedController.state.tasks = [{ id: task.id, name: task.name, plan: task.plan, slots: (task.plan as { shots: unknown[] }).shots.map(shot => ({ shot, status: "ready", item: null, error: "", archiveOk: false })) }];
  const snapshot = savedController.snapshot();
  const saved = { draft: { settings, tasks: [task] }, snapshot };
  const restoreStarted = vi.fn(), recoveryStarted = vi.fn();
  let uiController: ReturnType<typeof engine.createController>;
  context.SZ_STUDIO_GENESIS = { ...engine, createController: (deps: { journal: { read(): unknown } }) => {
    const controller = engine.createController({ ...deps, ...(startup.timeoutMs === undefined ? {} : { timeoutMs: startup.timeoutMs }) });
    // Candidate 4 depends on candidate 1's mandatory recovery method. This
    // temporary interface fixture is explicitly opt-in while that production
    // method is pending; joint validation also forbids it with REQUIRE_NATIVE.
    const recover = controller.recoverPendingReceipt || (process.env.STUDIO_USE_RECOVERY_FIXTURE !== "1" || process.env.STUDIO_REQUIRE_NATIVE_RECOVERY === "1" ? undefined : async () => {
      const identity = String(await bridge.getAccountKey());
      if (controller.state.accountKey && controller.state.accountKey !== identity) return { ok: false, error: "登录账号已变化，请重新打开工作台。" };
      controller.state.accountKey = identity;
      const pending = await deps.journal.read();
      if (String(await bridge.getAccountKey()) !== identity) return { ok: false, error: "登录账号已变化，请重新打开工作台。" };
      if (pending) controller.state.uncertain = clone(pending);
      return { ok: true };
    });
    uiController = { ...controller,
      ...(holdRestore ? { restore: async (value: unknown) => { restoreStarted(); await restore.promise; return controller.restore(value); } } : {}),
      recoverPendingReceipt: startup.omitRecovery || !recover ? undefined : async () => { recoveryStarted();if (startup.holdRecovery) await recovery.promise;return recover(); }
    };
    return uiController;
  } };
  runInContext(uiScript, context, { filename: "studio-genesis-ui.js" });
  const beforeUnload = () => {
    const event: UnloadEvent = { preventDefault: vi.fn() };
    for (const listener of windowListeners.get("beforeunload") || []) listener(event);
    return event;
  };
  return { document, bridge, refresh, catalog, read, restore, restoreStarted, recovery, recoveryStarted, reads, writes, saved, beforeUnload, storage, engine, context, writeControl,
    controller: () => uiController, dispatchWindow,
    navigationGuard: () => context.SanjieStudioGenesisBridge as { canDeactivate(): Promise<{ allowed: boolean; reason?: string }> } };
}


function ready(h: ReturnType<typeof harness>) {
  h.refresh.complete({ ok: true, accountKey });h.read.complete(h.saved);h.catalog.complete({ ok: true, accountKey, providers: [provider] });
}
const oldReceipt={accountKey,jobId:"old-main-job",taskId:"old-main-task",shotId:"shot-1",batchId:"old-batch",createdAt:Date.UTC(2026,9,11,2,0)};
const pendingKey=`sz_studio_genesis_pending_v1:${accountKey}`;

export { harness, ready, deferred, clone, accountKey, provider, oldReceipt, pendingKey };
