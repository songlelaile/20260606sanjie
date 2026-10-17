import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  readonly style = { cssText: "" };
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
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  removeAttribute(name: string) { this.attributes.delete(name); }
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
  readonly documentElement = new Element("HTML", this);
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
const liveIntervals = new Set<ReturnType<typeof globalThis.setInterval>>();
afterEach(() => { liveIntervals.forEach(handle => globalThis.clearInterval(handle)); liveIntervals.clear(); });
type StartupOptions = { holdRecovery?: boolean; omitRecovery?: boolean; timeoutMs?: number; apiDialog?: boolean };
function harness(entry: StartupEntry, holdRestore = false, storage = new Map<string, string>(), environment = "", startup: StartupOptions = {}) {
  const mode = entry === "detail" ? "detail" : "main";
  const uiScript = source("studio-genesis-ui.js");
  const document = new TestDocument(), refresh = deferred<{ ok: boolean; accountKey: string; error?: string }>(), catalog = deferred<Catalog>();
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
    listBoundApis: vi.fn(() => catalog.promise),
    modelInfo: vi.fn(() => ({ ready: true, supportsReference: true, provider: provider.provider, model: provider.imageModel })),
    setApiBusy: vi.fn(), openConfig: vi.fn(), analyze: vi.fn(), send: vi.fn()
  };
  // A keyed, serialized IndexedDB model of the production draft store: each key
  // has its own value and absent keys read as undefined. Readwrite puts are staged
  // and committed only on complete; a rejected read or write fails the request and
  // the transaction (onerror), discarding every staged write.
  const persistedDrafts = new Map<string, unknown>();
  const initialDraftKey = `${accountKey}:${entry === "batch" ? "batch" : "single"}:${mode}${entry === "ad" ? ":ad" : ""}`;
  let initialDraftSeeded = false, transactionQueue = Promise.resolve(), transactionSequence = 0;
  type FakeTransaction = { id: number; access: string; abort(): void; finished: boolean };
  let runningTransaction: FakeTransaction | undefined;
  const db = {
    close: vi.fn(),
    transaction: (_store: string, access?: string) => {
      if (access !== undefined && access !== "readwrite") throw new Error(`Unexpected access: ${access}`);
      const prior = transactionQueue; let release!: () => void;
      transactionQueue = new Promise<void>(resolve => { release = resolve; });
      const staged = new Map<string, unknown>(); let pending = 0;
      const tx = { id: ++transactionSequence, access: access || "readonly", finished: false,
        oncomplete: undefined as undefined | (() => void), onerror: undefined as undefined | (() => void), onabort: undefined as undefined | (() => void), error: undefined as undefined | Error,
        abort: () => finish("abort"), objectStore: () => ({
          get: (key: string) => {
            reads.push(key);
            const request = { result: undefined as unknown, error: undefined as undefined | Error, onsuccess: undefined as undefined | (() => void), onerror: undefined as undefined | (() => void) };
            pending++;
            prior.then(() => read.promise).then(value => {
              pending--;
              if (tx.finished) return;
              if (!initialDraftSeeded) { initialDraftSeeded = true; if (value !== undefined) persistedDrafts.set(initialDraftKey, clone(value)); }
              const saved = staged.has(key) ? staged.get(key) : persistedDrafts.get(key);
              request.result = saved === undefined ? undefined : clone(saved); request.onsuccess?.(); idle();
            }, (error: Error) => {
              pending--;
              if (tx.finished) return;
              request.error = error; tx.error = error; request.onerror?.(); finish("error");
            });
            return request;
          },
          put: (value: unknown, key: string) => {
            if (tx.access !== "readwrite") throw new Error("ReadOnlyError");
            // The invocation log and the staged value are independent copies.
            writes.push({ key, value: clone(value) }); const stagedValue = clone(value); pending++;
            prior.then(() => writeControl.wait).then(() => {
              pending--;
              if (tx.finished) return;
              if (writeControl.error) { tx.error = writeControl.error; finish("error"); return; }
              staged.set(key, stagedValue); idle();
            }, (error: Error) => {
              pending--;
              if (tx.finished) return;
              tx.error = error; finish("error");
            });
          }
        }) };
      function finish(kind: "complete" | "abort" | "error") {
        if (tx.finished) return; tx.finished = true;
        if (kind === "complete") staged.forEach((value, key) => persistedDrafts.set(key, clone(value)));
        staged.clear();
        if (runningTransaction === tx) runningTransaction = undefined;
        release(); queueMicrotask(() => { if (kind === "complete") tx.oncomplete?.(); else if (kind === "abort") tx.onabort?.(); else tx.onerror?.(); });
      }
      const idle = () => queueMicrotask(() => { if (!pending && !tx.finished) finish("complete"); });
      // A transaction runs once every earlier transaction has finished.
      prior.then(() => { if (!tx.finished) runningTransaction = tx; idle(); });
      return tx;
    }
  };
  const indexedDB = { open: vi.fn(() => {
    const request = { result: db, onsuccess: undefined as undefined | (() => void), onerror: undefined as undefined | (() => void), onupgradeneeded: undefined as undefined | (() => void) };
    queueMicrotask(() => request.onsuccess?.()); return request;
  }) };
  // Real timers, tracked so a test never leaks an interval into the next one.
  const setInterval = (callback: () => void, ms: number) => { const handle = globalThis.setInterval(callback, ms); liveIntervals.add(handle); return handle; };
  const clearInterval = (handle: ReturnType<typeof globalThis.setInterval>) => { liveIntervals.delete(handle); globalThis.clearInterval(handle); };
  const firstPaint = { complete: vi.fn() };
  const context = createContext({ document, indexedDB, URL, URLSearchParams, crypto: { randomUUID }, console, setTimeout, clearTimeout, setInterval, clearInterval,
    __SANJIE_ENVIRONMENT: environment,
    navigator: { locks: { request: async (name: string, _options: unknown, callback: (lock: { name: string }) => unknown) => callback({ name }) } },
    location: { search: `?studio=1&mode=${mode}${entry === "ad" ? "&type=ad" : entry === "batch" ? "&batch=1" : ""}` }, localStorage: {
      get length() { return storage.size; }, key: (index: number) => [...storage.keys()][index] ?? null,
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    },
    addEventListener: (name: string, listener: (event: UnloadEvent) => void) => {
      const listeners = windowListeners.get(name) || []; listeners.push(listener); windowListeners.set(name, listeners);
    },
    SZ_LAB_FIRST_PAINT: firstPaint, SZ_CREATIVE_TOOLS_BRIDGE: bridge });
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
    persistedDrafts, firstPaint, liveIntervals,
    // Abort the transaction that is actually running, only if it is a readwrite one.
    abortPendingWrite: () => { const running = runningTransaction; if (!running || running.access !== "readwrite") return false; running.abort(); return true; },
    controller: () => uiController, dispatchWindow,
    navigationGuard: () => context.SanjieStudioGenesisBridge as { canDeactivate(): Promise<{ allowed: boolean; reason?: string }> } };
}

async function begin(mode: "main" | "detail") {
  const h = harness(mode);
  h.refresh.complete({ ok: true, accountKey }); h.read.complete(h.saved);
  await vi.waitFor(() => expect(h.bridge.listBoundApis, h.document.root.textContent).toHaveBeenCalledOnce());
  return h;
}

describe.each(["main", "detail"] as const)("%s studio first paint and safe startup", mode => {
  it("restores the account draft before rendering, without waiting for the API catalog", async () => {
    const h = harness(mode, true);
    expect(h.document.root.textContent).toContain("正在读取创作工作台");
    expect(h.bridge.refresh).toHaveBeenCalledWith({ deferArchive: true });
    h.refresh.complete({ ok: true, accountKey });
    // The separate type-recovery row is read first; the canonical draft row follows.
    await vi.waitFor(() => expect(h.reads).toEqual([`${accountKey}:single:${mode}:type-recovery-v1`]));
    expect(h.document.root.querySelector("[data-files]")).toBeNull();
    expect(h.bridge.listBoundApis).not.toHaveBeenCalled();
    h.read.complete(h.saved);
    await vi.waitFor(() => expect(h.restoreStarted).toHaveBeenCalledOnce());
    expect(h.reads).toEqual([`${accountKey}:single:${mode}:type-recovery-v1`, `${accountKey}:single:${mode}`]);
    expect(h.document.root.querySelector("[data-files]")).toBeNull();
    h.restore.complete();
    await vi.waitFor(() => expect(h.bridge.listBoundApis, h.document.root.textContent).toHaveBeenCalledOnce());
    expect(h.document.control("[data-task-field=name]").value).toBe("已保存商品");
    expect(h.document.control("[data-setting=model]").value).toBe("saved-product-image");
    expect(h.document.root.querySelector("[data-confirm]")?.checked).toBe(true);
    expect(h.document.root.textContent).toContain("0/1 已完成");
    expect(h.recoveryStarted).toHaveBeenCalledOnce();expect(h.bridge.getAccountKey).toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("locks uploads, settings and generation while the rendered workspace loads its catalog", async () => {
    const h = await begin(mode);
    for (const selector of ["[data-files]", "[data-setting=model]", "[data-setting=ratio]", "[data-task-field=name]", "[data-confirm]", "[data-action=config]", "[data-action=generate]"]) expect(h.document.control(selector).disabled, selector).toBe(true);
    expect(h.document.root.querySelector("[data-api]")).toBeNull();
    expect(h.bridge.setApiBusy).toHaveBeenLastCalledWith("studio-genesis", true);
    const name = h.document.control("[data-task-field=name]"); name.value = "启动期间不应覆盖的输入";
    h.document.root.dispatch("input", name);
    h.document.root.dispatch("click", h.document.control("[data-action=config]"));
    h.document.root.dispatch("drop", h.document.control("[data-drop]"), { dataTransfer: { files: [] } });
    await vi.waitFor(() => expect(h.document.control("[data-message]").textContent).toContain("请等待"));
    expect(h.bridge.openConfig).not.toHaveBeenCalled(); expect(h.writes).toEqual([]);
    h.catalog.complete({ ok: true, accountKey, providers: [provider] });
    await vi.waitFor(() => expect(h.document.control("[data-action=generate]").disabled).toBe(false));
    expect(h.document.control("[data-task-field=name]").value).toBe("已保存商品");
    expect(h.document.control("[data-setting=model]").value).toBe("saved-product-image");
    expect(h.document.control("[data-confirm]").checked).toBe(true);
    for (const selector of ["[data-files]", "[data-setting=model]", "[data-action=config]"]) expect(h.document.control(selector).disabled, selector).toBe(false);
    expect(h.bridge.setApiBusy).toHaveBeenLastCalledWith("studio-genesis", false);
    expect(h.recoveryStarted).toHaveBeenCalledOnce();expect(h.bridge.getAccountKey).toHaveBeenCalled(); expect(h.writes).toEqual([]);
  });

  it("shows a catalog failure instead of silently converting it to an empty provider list", async () => {
    const h = await begin(mode);
    h.catalog.complete({ ok: false, accountKey, error: "fixture API catalog unavailable" });
    await vi.waitFor(() => expect(h.document.control("[data-message]").textContent).toContain("fixture API catalog unavailable"));
    expect(h.document.control("[data-message]").classList.contains("is-error")).toBe(true);
    expect(h.document.control("[data-task-field=name]").value).toBe("已保存商品");
    expect(h.document.control("[data-action=generate]").disabled).toBe(true);
    expect(h.bridge.modelInfo).not.toHaveBeenCalled(); expect(h.writes).toEqual([]);
  });

  it("rejects a catalog from another account before accepting its models", async () => {
    const h = await begin(mode);
    h.catalog.complete({ ok: true, accountKey: "account:another-user", providers: [provider] });
    await vi.waitFor(() => expect(h.document.control("[data-message]").textContent).toMatch(/账号.*(?:变化|切换)/));
    expect(h.document.control("[data-action=generate]").disabled).toBe(true);
    expect(h.bridge.modelInfo).not.toHaveBeenCalled(); expect(h.recoveryStarted).toHaveBeenCalledOnce();
    expect(h.writes).toEqual([]);
  });

  it("retains the restored draft and reports a rejected catalog request", async () => {
    const h = await begin(mode);
    h.catalog.fail(new Error("fixture catalog connection lost"));
    await vi.waitFor(() => expect(h.document.control("[data-message]").textContent).toContain("fixture catalog connection lost"));
    expect(h.document.control("[data-task-field=name]").value).toBe("已保存商品");
    expect(h.document.control("[data-action=generate]").disabled).toBe(true);
    expect(h.writes).toEqual([]);
  });

  it("blocks navigation during catalog loading while account checks still protect draft saves", async () => {
    const h = await begin(mode);
    const startupChecks = h.bridge.getAccountKey.mock.calls.length;
    expect(h.document.control("[data-setting=model]").disabled).toBe(true);
    const event = h.beforeUnload();
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.returnValue).toContain("任务尚未结束");
    await vi.waitFor(() => expect(h.writes).toHaveLength(1));
    expect(h.bridge.getAccountKey).toHaveBeenCalledTimes(startupChecks + 1);
    expect(h.writes[0]).toMatchObject({ key: `${accountKey}:single:${mode}`, value: { draft: h.saved.draft, snapshot: { accountKey } } });
    const protectedWrites = clone(h.writes);
    h.bridge.getAccountKey.mockResolvedValueOnce("account:another-user");
    const changedAccountEvent = h.beforeUnload();
    expect(changedAccountEvent.preventDefault).toHaveBeenCalledOnce(); expect(changedAccountEvent.returnValue).toContain("任务尚未结束");
    await vi.waitFor(() => expect(h.bridge.getAccountKey).toHaveBeenCalledTimes(startupChecks + 2));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.writes).toEqual(protectedWrites);
    expect(h.bridge.modelInfo).not.toHaveBeenCalled(); expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("accepts the configured model only after the catalog succeeds for a new draft", async () => {
    const h = harness(mode);
    h.refresh.complete({ ok: true, accountKey }); h.read.complete(null);
    await vi.waitFor(() => expect(h.bridge.listBoundApis, h.document.root.textContent).toHaveBeenCalledOnce());
    expect(h.document.control("[data-setting=model]").value).toBe("");
    expect(h.document.control("[data-setting=model]").disabled).toBe(true);
    h.catalog.complete({ ok: true, accountKey, providers: [provider] });
    await vi.waitFor(() => expect(h.document.control("[data-setting=model]").value).toBe(provider.imageModel));
    expect(h.document.control("[data-setting=model]").disabled).toBe(false);
    expect(h.writes).toEqual([]);
  });

  it("does not read or overwrite local drafts when account configuration fails", async () => {
    const h = harness(mode);
    h.refresh.complete({ ok: false, accountKey, error: "fixture identity unavailable" });
    await vi.waitFor(() => expect(h.document.root.textContent).toContain("fixture identity unavailable"));
    expect(h.document.root.textContent).toContain("创作工作台暂未就绪");
    expect(h.reads).toEqual([]); expect(h.writes).toEqual([]);
    expect(h.bridge.getAccountKey).not.toHaveBeenCalled(); expect(h.bridge.listBoundApis).not.toHaveBeenCalled();
  });
});

const pendingKey = `sz_studio_genesis_pending_v1:${accountKey}`;
const externalReceipt = { accountKey, jobId: "fixture-original-detail-job", taskId: "fixture-original-detail-task", shotId: "shot-12", batchId: "fixture-original-detail-batch", createdAt: Date.UTC(2026, 9, 10, 6, 30, 15) };
function forbidSending(h: ReturnType<typeof harness>) {
  h.bridge.send.mockImplementation(() => { throw new Error("Unexpected provider send in offline startup regression"); });
}
function completeStartup(h: ReturnType<typeof harness>) {
  h.refresh.complete({ ok: true, accountKey });h.read.complete(h.saved);h.catalog.complete({ ok: true, accountKey, providers: [provider] });
}

describe.each(["main", "detail", "ad", "batch"] as const)("%s account-level pending startup UI", entry => {
  it("isolates another entry's pending request while preserving its journal and enabling independent generation", async () => {
    const receipt = { ...externalReceipt, providerTaskId: "private-supplier-task", apiKey: "private-supplier-key", generationRoute: "private-supplier-route" };
    const raw = JSON.stringify(receipt), storage = new Map([[pendingKey, raw]]), h = harness(entry, false, storage);
    forbidSending(h);completeStartup(h);
    await vi.waitFor(() => expect(h.document.root.querySelector("[data-pending-receipt]")).not.toBeNull());
    expect(h.recoveryStarted).toHaveBeenCalledOnce();
    // The original request stays bound to its own task and image; this workspace continues.
    expect(h.document.control("[data-pending-receipt]").textContent).toContain("其他图片可继续生成，无需手动解除");
    expect(h.document.control("[data-action=generate]").disabled).toBe(false);
    expect(h.document.control("[data-setting=model]").disabled).toBe(false);
    expect(h.document.root.querySelector("[data-action=resolve]")).toBeNull();
    expect(h.document.root.querySelector("[data-uncertain-confirm]")).toBeNull();
    const pending = [...(h.controller().state.pendingReceipts || []), ...(h.controller().state.uncertain ? [h.controller().state.uncertain] : [])];
    expect(pending.some((value: { jobId: string; taskId: string; shotId: string }) => value.jobId === receipt.jobId && value.taskId === receipt.taskId && value.shotId === receipt.shotId)).toBe(true);
    // The task row names the original request without supplier secrets.
    const row = h.document.control(`[data-task-row="${receipt.jobId}"]`);
    expect(row.textContent).toContain("结果待确认 · 本次等待已结束"); expect(row.textContent).toContain(receipt.jobId);
    expect(row.textContent).toContain("新生成按新任务计费");
    for (const secret of [receipt.providerTaskId, receipt.apiKey, receipt.generationRoute]) expect(h.document.root.textContent).not.toContain(secret);
    expect(storage.get(pendingKey)).toBe(raw);expect(h.writes).toEqual([]);
    expect(h.bridge.send).not.toHaveBeenCalled();expect(h.bridge.analyze).not.toHaveBeenCalled();
  });

  it("waits for account journal recovery before rendering controls even if the catalog is ready", async () => {
    const h = harness(entry, false, new Map([[pendingKey, JSON.stringify(externalReceipt)]]), "", { holdRecovery: true });
    forbidSending(h);completeStartup(h);
    await vi.waitFor(() => expect(h.recoveryStarted).toHaveBeenCalledOnce());
    expect(h.document.root.querySelector("[data-files]")).toBeNull();
    expect(h.document.root.querySelector("[data-action=generate]")).toBeNull();
    expect(h.bridge.listBoundApis).not.toHaveBeenCalled();expect(h.writes).toEqual([]);
    h.recovery.complete();
    await vi.waitFor(() => expect(h.document.root.querySelector("[data-pending-receipt]")).not.toBeNull());
    // Once recovery has registered the receipt, independent generation is available.
    expect(h.document.control("[data-action=generate]").disabled).toBe(false);
    expect(h.document.root.querySelector("[data-action=resolve]")).toBeNull();
    expect(h.storage.get(pendingKey)).toBe(JSON.stringify(externalReceipt));
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("unlocks the approved local draft when the account journal has no pending receipt", async () => {
    const h = harness(entry);forbidSending(h);completeStartup(h);
    await vi.waitFor(() => expect(h.document.control("[data-action=generate]").disabled).toBe(false));
    expect(h.recoveryStarted).toHaveBeenCalledOnce();
    expect(h.document.root.querySelector("[data-pending-receipt]")).toBeNull();
    expect(h.document.control("[data-task-field=name]").value).toBe("已保存商品");
    expect(h.controller().snapshot().tasks[0].plan).toEqual(h.saved.snapshot.tasks[0].plan);
    expect(h.writes).toEqual([]);expect(h.bridge.send).not.toHaveBeenCalled();
  });
});

describe("pending startup failure and receipt-only resolution", () => {
  it("does not describe an old request with a label from the current edited plan", async () => {
    const h = harness("main"), task = h.saved.draft.tasks[0], receipt = { ...externalReceipt, taskId: task.id, shotId: "shot-1", batchId: "fixture-previous-detail-batch" };
    const currentLabel = (task.plan as { shots: Array<{ label: string }> }).shots[0].label;
    const raw = JSON.stringify(receipt); h.storage.set(pendingKey, raw);forbidSending(h);completeStartup(h);
    await vi.waitFor(() => expect(h.document.root.querySelector("[data-pending-receipt]")).not.toBeNull());
    // The pending notice never repeats the current plan's wording for the old request.
    expect(h.document.root.querySelector("[data-receipt-shot]")).toBeNull();
    expect(h.document.control("[data-pending-receipt]").textContent).not.toContain(currentLabel);
    expect(h.document.control(`[data-task-row="${receipt.jobId}"]`).textContent).toContain(receipt.jobId);
    // The request stays bound to its exact image; that image cannot be retried or resent.
    expect(h.controller().state.uncertain.jobId).toBe(receipt.jobId);
    expect(h.controller().state.tasks[0].slots[0].status).toBe("uncertain");
    expect(h.document.root.querySelector("[data-action=retry-slot]")).toBeNull();
    // A new generation is an explicit, separately billed task.
    expect(h.document.control("[data-action=generate]").disabled).toBe(false);
    expect(h.document.control("[data-new-generation]").textContent).toContain("按当前方案生成新图");
    expect(h.document.control("[data-new-generation-note]").textContent).toContain("另生成 1 张新图，按新任务计费");
    expect(h.storage.get(pendingKey)).toBe(raw);
    expect(h.bridge.send).not.toHaveBeenCalled();expect(h.writes).toEqual([]);
  });
  it("allows leaving a failed corrupt snapshot startup without overwriting the original draft", async () => {
    const h = harness("main");h.saved.snapshot.version = "corrupt-snapshot";
    const original = clone(h.saved);forbidSending(h);completeStartup(h);
    await vi.waitFor(() => expect(h.document.root.textContent).toContain("创作工作台暂未就绪"));
    expect(h.document.root.querySelector("[data-action=generate]")).toBeNull();
    expect((await h.navigationGuard().canDeactivate()).allowed).toBe(true);
    expect(h.beforeUnload().preventDefault).not.toHaveBeenCalled();
    expect(h.saved).toEqual(original);expect(h.writes).toEqual([]);
    expect(h.recoveryStarted).not.toHaveBeenCalled();expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("opposite-type corrupt snapshot preserves the untouched canonical draft and migrates through a backup and recovery row", async () => {
    const h = harness("ad");Object.assign(h.saved.draft.settings, { imageType: "main", mode: "main" });h.saved.snapshot.version = "corrupt-snapshot";
    const original = clone(h.saved);forbidSending(h);completeStartup(h);
    const canonical = `${accountKey}:single:main:ad`, recovery = `${canonical}:type-recovery-v1`;
    await vi.waitFor(() => expect(h.document.root.textContent).toContain("已保留旧版混合草稿"));
    // The canonical row is untouched; exactly one backup and one recovery row are committed.
    expect(h.persistedDrafts.get(canonical)).toEqual(original);
    const backups = [...h.persistedDrafts.keys()].filter(key => key.startsWith(`${canonical}:before-explicit-mode:`));
    expect(backups).toHaveLength(1);
    const backup = h.persistedDrafts.get(backups[0]) as Record<string, unknown>;
    expect({ ...backup, revision: undefined }).toEqual({ ...original, revision: undefined });
    expect(typeof backup.revision).toBe("string");
    expect(h.writes.map(write => write.key)).toEqual([backups[0], recovery]);
    const recovered = h.persistedDrafts.get(recovery) as { draft: { legacyBackupKey: string; settings: { imageType: string }; tasks: Array<{ id: string; plan: unknown; confirmed: boolean; products: unknown }> } };
    expect(recovered.draft.legacyBackupKey).toBe(backups[0]); expect(recovered.draft.settings.imageType).toBe("ad");
    // Fresh task identities and unconfirmed plans: the corrupt snapshot's receipts are never transplanted.
    expect(recovered.draft.tasks.map(entry => entry.id)).not.toContain(original.draft.tasks[0].id);
    expect(recovered.draft.tasks.every(entry => entry.plan === null && entry.confirmed === false)).toBe(true);
    expect(recovered.draft.tasks[0].products).toEqual(original.draft.tasks[0].products);
    expect(h.controller().state.uncertain).toBeFalsy(); expect(h.controller().state.tasks).toEqual([]);
    expect(h.saved).toEqual(original);
    expect((await h.navigationGuard().canDeactivate()).allowed).toBe(true);
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it.each([
    ["empty stored value", "", /回执无法读取/],
    ["invalid JSON", "{private-corrupt-data", /回执无法读取/],
    ["array", "[]", /回执内容损坏/],
    ["primitive", "true", /回执内容损坏/],
    ["invalid timestamp", JSON.stringify({ ...externalReceipt, createdAt: "private-bad-date" }), /回执内容损坏/],
    ["missing task", JSON.stringify({ ...externalReceipt, taskId: "" }), /回执内容损坏/],
    ["foreign owner", JSON.stringify({ ...externalReceipt, accountKey: "account:foreign", jobId: "foreign-private-job" }), /账号不一致/]
  ])("blocks startup for %s without clearing or exposing the raw journal", async (_name, raw, error) => {
    const storage = new Map([[pendingKey, raw as string]]), h = harness("main", false, storage);
    forbidSending(h);completeStartup(h);
    await vi.waitFor(() => expect(h.document.root.textContent).toMatch(error as RegExp));
    expect(h.document.root.textContent).toContain("创作工作台暂未就绪");
    expect(h.document.root.querySelector("[data-action=generate]")).toBeNull();
    expect(h.document.root.textContent).not.toContain("foreign-private-job");
    expect(h.document.root.textContent).not.toContain("private-corrupt-data");
    expect(storage.get(pendingKey)).toBe(raw);expect(h.writes).toEqual([]);
    expect(h.bridge.listBoundApis).not.toHaveBeenCalled();expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("keeps startup blocked when the journal storage read throws", async () => {
    class UnreadableJournal extends Map<string, string> {
      get(key: string) { if (key === pendingKey) throw new Error("private-storage-error");return super.get(key); }
    }
    const storage = new UnreadableJournal([[pendingKey, JSON.stringify(externalReceipt)]]), h = harness("detail", false, storage);
    forbidSending(h);completeStartup(h);
    await vi.waitFor(() => expect(h.document.root.textContent).toContain("回执无法读取"));
    expect(h.document.root.querySelector("[data-action=generate]")).toBeNull();
    expect(h.document.root.textContent).not.toContain("private-storage-error");
    expect(storage.has(pendingKey)).toBe(true);expect(h.writes).toEqual([]);expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("treats a missing recovery module as a startup failure", async () => {
    const h = harness("main", false, new Map([[pendingKey, JSON.stringify(externalReceipt)]]), "", { omitRecovery: true });
    forbidSending(h);completeStartup(h);
    await vi.waitFor(() => expect(h.document.root.textContent).toContain("回执恢复模块未完整加载"));
    expect(h.document.root.querySelector("[data-action=generate]")).toBeNull();
    expect(h.storage.has(pendingKey)).toBe(true);expect(h.writes).toEqual([]);expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("does not show or save another account's receipt after identity changes during startup", async () => {
    const foreignKey = "sz_studio_genesis_pending_v1:account:foreign", foreignRaw = JSON.stringify({ ...externalReceipt, accountKey: "account:foreign", jobId: "foreign-private-job" });
    const storage = new Map([[pendingKey, JSON.stringify(externalReceipt)], [foreignKey, foreignRaw]]), h = harness("ad", false, storage, "", { holdRecovery: true });
    forbidSending(h);completeStartup(h);
    await vi.waitFor(() => expect(h.recoveryStarted).toHaveBeenCalledOnce());
    h.bridge.getAccountKey.mockResolvedValue("account:foreign");h.recovery.complete();
    await vi.waitFor(() => expect(h.document.root.textContent).toMatch(/账号.*(?:变化|切换)|原账号/));
    expect(h.document.root.querySelector("[data-action=generate]")).toBeNull();
    expect(h.document.root.textContent).not.toContain(externalReceipt.jobId);expect(h.document.root.textContent).not.toContain("foreign-private-job");
    expect(storage.get(foreignKey)).toBe(foreignRaw);expect(h.writes).toEqual([]);expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("keeps the journal and UI closed if identity changes while reading the pending record", async () => {
    let changeIdentity = () => {};
    class IdentityChangingStorage extends Map<string, string> {
      get(key: string) { const value = super.get(key);if (key === pendingKey) changeIdentity();return value; }
    }
    const raw = JSON.stringify(externalReceipt), storage = new IdentityChangingStorage([[pendingKey, raw]]), h = harness("main", false, storage);
    changeIdentity = () => h.bridge.getAccountKey.mockResolvedValue("account:foreign");forbidSending(h);completeStartup(h);
    await vi.waitFor(() => expect(h.document.root.textContent).toMatch(/账号.*(?:变化|切换)/));
    expect(h.document.root.querySelector("[data-action=generate]")).toBeNull();
    expect(h.document.root.textContent).not.toContain(externalReceipt.jobId);expect(storage.has(pendingKey)).toBe(true);
    expect(h.writes).toEqual([]);expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("restores eleven completed results and protects only the twelfth pending image without manual release", async () => {
    const h = harness("detail"), settings = { ...h.saved.draft.settings, count: 12 }, task = h.saved.draft.tasks[0];
    task.plan = h.engine.createPlan(task, settings);h.saved.draft.settings = settings;
    const receipt = { ...externalReceipt, taskId: task.id }, originalPlan = clone(task.plan);
    h.saved.snapshot.tasks = [{ id: task.id, name: task.name, plan: clone(task.plan), slots: (task.plan as { shots: Array<{ id: string }> }).shots.map((shot, index) => ({
      shot: clone(shot), status: index < 11 ? "done" : "generating", item: index < 11 ? { url: `https://fixture.test/completed-${index + 1}.png`, resultId: `completed-${index + 1}`, productName: task.name } : null,
      error: "", archiveOk: index < 11, archiveSaving: false
    })) }];
    h.saved.snapshot.uncertain = { accountKey, taskId: task.id, shotId: "shot-12", restored: true };
    const completed = clone(h.saved.snapshot.tasks[0].slots.slice(0, 11)), raw = JSON.stringify(receipt);
    h.storage.set(pendingKey, raw);forbidSending(h);completeStartup(h);
    await vi.waitFor(() => expect(h.document.root.querySelector("[data-pending-receipt]")).not.toBeNull());
    expect(h.document.control("[data-pending-receipt]").textContent).toContain("1 张图片的结果待确认");
    expect(h.document.root.querySelector("[data-action=resolve]")).toBeNull();
    expect(h.document.root.querySelector("[data-uncertain-confirm]")).toBeNull();
    expect(h.document.root.querySelectorAll("[data-action=download]")).toHaveLength(11);
    expect(h.controller().snapshot().tasks[0].slots.slice(0, 11)).toEqual(completed);
    expect(h.controller().snapshot().tasks[0].slots[11].status).toBe("uncertain");
    expect(h.controller().state.uncertain.jobId).toBe(receipt.jobId);
    expect(h.document.root.querySelectorAll("[data-action=retry-slot]").some(button => button.dataset.shotId === "shot-12")).toBe(false);
    // Generating again is an explicit new paid task; the twelfth request stays bound to its image.
    expect(h.document.control("[data-action=generate]").disabled).toBe(false);
    expect(h.document.control("[data-new-generation-note]").textContent).toContain("另生成 12 张新图，按新任务计费");
    // A focus refresh re-runs recovery without clearing or resending anything.
    h.dispatchWindow("focus");
    await vi.waitFor(() => expect(h.recoveryStarted).toHaveBeenCalledTimes(2));
    expect(h.storage.get(pendingKey)).toBe(raw);
    expect(h.controller().snapshot().tasks[0].slots.slice(0, 11)).toEqual(completed);
    expect(h.controller().snapshot().tasks[0].plan).toEqual(originalPlan);
    expect(h.controller().snapshot().tasks[0].slots[11].status).toBe("uncertain");
    expect(h.document.root.querySelectorAll("[data-action=download]")).toHaveLength(11);
    expect(h.bridge.send).not.toHaveBeenCalled();expect(h.bridge.analyze).not.toHaveBeenCalled();
    expect(h.writes.every(write => write.key === `${accountKey}:single:detail`)).toBe(true);
  });
});

type InteractionHarness = ReturnType<typeof harness>;
type InteractionDraft = {
  settings: { mode: string; count: number; moduleMode: string; modules: string[]; moduleSkills?: Record<string, string>; expertMode?: boolean; imageType?: string; adTemplate?: string; adType?: string; quality?: string; generationSpeed?: string };
  tasks: Array<{ id: string; plan: null | { shots: Array<{ label: string; prompt: string }> }; confirmed: boolean }>;
  userModules?: Array<{ id: string; name: string; skill: string; group?: string }>;
  userModuleGroups?: string[];
};
function latestDraft(h: InteractionHarness): InteractionDraft {
  return (h.writes.at(-1)?.value as { draft: InteractionDraft }).draft;
}
async function ready(mode: "main" | "detail") {
  const h = await begin(mode);
  h.catalog.complete({ ok: true, accountKey, providers: [provider] });
  await vi.waitFor(() => expect(h.document.control("[data-action=config]").disabled).toBe(false));
  return h;
}
function click(h: InteractionHarness, action: string, predicate: (element: Element) => boolean = () => true) {
  const button = h.document.root.querySelectorAll(`[data-action=${action}]`).find(predicate);
  if (!button) throw new Error(`The real UI did not render action ${action}`);
  h.document.root.dispatch("click", button);
}
function check(h: InteractionHarness, selector: string, checked: boolean) {
  const control = h.document.control(selector); control.checked = checked;
  h.document.root.dispatch("change", control);
}

describe("real studio deactivation bridge", () => {
  it.each(["main", "detail"] as const)("awaits durable %s storage while retaining idle receipts and protecting the paid image", async mode => {
    const h = await ready(mode), write = deferred<void>(), draftKey = `${accountKey}:single:${mode}`;
    const receipt = { accountKey, jobId: "unconfirmed-local-job", taskId: "saved-product", shotId: "shot-1" };
    const receiptKey = `sz_studio_genesis_pending_v1:${accountKey}`;
    h.storage.set(receiptKey, JSON.stringify(receipt));
    h.controller().state.uncertain = clone(receipt);
    h.controller().state.previousResults.push({ status: "done", item: { resultId: "retained-local-image", url: "https://fixture.test/retained.png" }, archiveOk: true });
    h.document.dispatch("cu-import-state");
    const before = clone(h.persistedDrafts.get(draftKey));
    h.writeControl.wait = write.promise;
    let settled = false;
    const leaving = h.navigationGuard().canDeactivate().then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(h.writes).toHaveLength(1));
    // While the write is held nothing is committed and the workspace is frozen.
    expect(settled).toBe(false); expect(h.persistedDrafts.get(draftKey)).toEqual(before);
    expect(h.document.control("[data-task-field=name]").disabled).toBe(true);
    expect(h.document.control("[data-action=generate]").disabled).toBe(true);
    click(h, "generate");expect(h.bridge.send).not.toHaveBeenCalled();
    write.complete();expect(await leaving).toEqual({ allowed: true });
    const persisted = h.persistedDrafts.get(draftKey) as { draft: unknown; snapshot: { uncertain: unknown; previousResults: unknown[] } };
    expect(persisted.draft).toEqual(h.saved.draft);
    expect(persisted.snapshot.uncertain).toEqual(receipt);
    expect(persisted.snapshot.previousResults).toHaveLength(1);
    expect(h.storage.get(receiptKey)).toBe(JSON.stringify(receipt));
    expect(h.controller().state.uncertain).toEqual(receipt);
    // Idle receipts do not block leaving; only the paid image stays protected from a retry.
    expect(h.document.root.querySelectorAll("[data-action=retry-slot]").some(button => button.dataset.shotId === "shot-1")).toBe(false);
    expect(h.bridge.send).not.toHaveBeenCalled();
    expect(h.beforeUnload().preventDefault).not.toHaveBeenCalled();
  });

  it("blocks startup and incomplete restoration, then preserves original storage on an idle startup failure exit", async () => {
    const h = harness("main", true);
    expect(await h.navigationGuard().canDeactivate()).toMatchObject({ allowed: false });
    h.refresh.complete({ ok: true, accountKey });h.saved.snapshot.version = -1;h.read.complete(h.saved);
    await vi.waitFor(() => expect(h.restoreStarted).toHaveBeenCalledOnce());
    expect(await h.navigationGuard().canDeactivate()).toMatchObject({ allowed: false });
    h.restore.complete();await vi.waitFor(() => expect(h.document.root.textContent).toContain("创作工作台暂未就绪"));
    expect(await h.navigationGuard().canDeactivate()).toEqual({ allowed: true });
    expect(h.writes).toEqual([]);
    h.controller().state.awaitingReceipt = true;
    expect(await h.navigationGuard().canDeactivate()).toMatchObject({ allowed: false });
    h.controller().state.awaitingReceipt = false;
    const failed = harness("detail");failed.refresh.complete({ ok: false, accountKey, error: "fixture startup failure" });
    await vi.waitFor(() => expect(failed.document.root.textContent).toContain("fixture startup failure"));
    expect(await failed.navigationGuard().canDeactivate()).toEqual({ allowed: true });
    expect(failed.writes).toEqual([]);
  });

  it("preserves original storage on native leave and hide after startup fails with bound listeners", async () => {
    const h = harness("main"), saved = clone(h.saved);
    h.bridge.setApiBusy.mockImplementation(() => { if (h.document.root.listeners.has("click")) throw new Error("fixture startup render failed after bind"); });
    h.refresh.complete({ ok: true, accountKey });h.read.complete(h.saved);
    await vi.waitFor(() => expect(h.document.root.textContent).toContain("fixture startup render failed after bind"));
    expect(h.document.root.listeners.has("click")).toBe(true);
    h.bridge.getAccountKey.mockClear(); // Boot recovery already checked the account; only leave/hide must avoid new reads.
    expect(await h.navigationGuard().canDeactivate()).toEqual({ allowed: true });
    expect(h.beforeUnload().preventDefault).not.toHaveBeenCalled();
    h.document.visibilityState = "hidden";h.document.dispatch("visibilitychange");
    h.document.visibilityState = "visible";h.document.dispatch("visibilitychange");
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.writes).toEqual([]);expect(h.saved).toEqual(saved);
    expect(h.bridge.getAccountKey).not.toHaveBeenCalled();expect(h.bridge.refresh).toHaveBeenCalledOnce();
    expect(h.document.root.textContent).toContain("fixture startup render failed after bind");
    h.controller().state.busy = true;
    expect(h.beforeUnload().preventDefault).toHaveBeenCalledOnce();expect(h.writes).toEqual([]);
  });

  it("ignores API dialog and bound-account callbacks after a bound startup render failure", async () => {
    const h = harness("main", false, new Map(), "", { apiDialog: true }), saved = clone(h.saved);
    let failed = false;
    h.bridge.setApiBusy.mockImplementation(() => {
      if (h.document.root.listeners.has("click") && !failed) { failed = true;throw new Error("fixture startup render failure with API callbacks"); }
    });
    h.refresh.complete({ ok: true, accountKey });h.read.complete(h.saved);
    await vi.waitFor(() => expect(h.document.root.textContent).toContain("fixture startup render failure with API callbacks"));
    expect(h.document.root.listeners.has("click")).toBe(true);
    const errorPage = h.document.root.innerHTML;
    h.bridge.refresh.mockClear();h.bridge.getAccountKey.mockClear();h.bridge.listBoundApis.mockClear();h.bridge.modelInfo.mockClear();
    h.catalog.complete({ ok: true, accountKey, providers: [provider] });
    h.dispatchWindow("sz-bound-api-changed");
    const cancel = h.document.getElementById("configCancelBtn")!;expect(cancel.listeners.has("click")).toBe(true);cancel.dispatch("click", cancel);
    // A former callback scheduled a durable save after 300ms. Wait beyond that
    // boundary so merely preventing the immediate render cannot hide a write.
    await new Promise<void>(resolve => setTimeout(resolve, 350));
    expect(h.document.root.innerHTML).toBe(errorPage);
    expect(h.bridge.refresh).not.toHaveBeenCalled();expect(h.bridge.listBoundApis).not.toHaveBeenCalled();expect(h.bridge.modelInfo).not.toHaveBeenCalled();
    expect(h.bridge.getAccountKey).not.toHaveBeenCalled();expect(h.writes).toEqual([]);
    expect(h.saved).toEqual(saved);expect(h.saved.draft.settings.model).toBe("saved-product-image");
    expect(await h.navigationGuard().canDeactivate()).toEqual({ allowed: true });
    expect(h.bridge.getAccountKey).not.toHaveBeenCalled();expect(h.writes).toEqual([]);
  });

  it("drops the awaited tail of an API callback that started before startup render failed", async () => {
    const h = harness("main", false, new Map(), "", { apiDialog: true }), saved = clone(h.saved);
    let failed = false;
    h.bridge.setApiBusy.mockImplementation(() => {
      if (h.document.root.listeners.has("click") && !failed) {
        failed = true;
        // The listener starts a real refreshModels() await while startup is
        // still valid. Its catalog intentionally returns only after failure.
        h.dispatchWindow("sz-bound-api-changed");
        expect(h.bridge.listBoundApis).toHaveBeenCalledOnce();
        throw new Error("fixture startup failed while API callback awaited catalog");
      }
    });
    h.refresh.complete({ ok: true, accountKey });h.read.complete(h.saved);
    await vi.waitFor(() => expect(h.document.root.textContent).toContain("fixture startup failed while API callback awaited catalog"));
    const errorPage = h.document.root.innerHTML;
    expect(h.bridge.listBoundApis).toHaveBeenCalledOnce();
    h.bridge.refresh.mockClear();h.bridge.getAccountKey.mockClear();h.bridge.listBoundApis.mockClear();h.bridge.modelInfo.mockClear();
    h.catalog.complete({ ok: true, accountKey, providers: [provider] });
    await new Promise<void>(resolve => setTimeout(resolve, 350));
    expect(h.document.root.innerHTML).toBe(errorPage);
    expect(h.bridge.refresh).not.toHaveBeenCalled();expect(h.bridge.listBoundApis).not.toHaveBeenCalled();expect(h.bridge.modelInfo).not.toHaveBeenCalled();
    expect(h.bridge.getAccountKey).not.toHaveBeenCalled();expect(h.writes).toEqual([]);
    expect(h.saved).toEqual(saved);expect(h.saved.draft.settings.model).toBe("saved-product-image");
    expect(await h.navigationGuard().canDeactivate()).toEqual({ allowed: true });
    expect(h.bridge.getAccountKey).not.toHaveBeenCalled();expect(h.writes).toEqual([]);
  });

  it("blocks controller activity, awaiting responses and an external import even without busy", async () => {
    const h = await ready("main");
    h.controller().state.busy = true;expect(await h.navigationGuard().canDeactivate()).toMatchObject({ allowed: false });
    h.controller().state.busy = false;h.controller().state.awaitingReceipt = true;
    expect(await h.navigationGuard().canDeactivate()).toMatchObject({ allowed: false });
    h.controller().state.awaitingReceipt = false;h.controller().hasInFlightRequest = () => true;
    expect(await h.navigationGuard().canDeactivate()).toMatchObject({ allowed: false });
    h.controller().hasInFlightRequest = () => false;
    h.context.SZ_IMAGE_UPLOAD = { ...h.context.SZ_IMAGE_UPLOAD, isImporting: () => true };
    expect(await h.navigationGuard().canDeactivate()).toMatchObject({ allowed: false });
    expect(h.beforeUnload().preventDefault).toHaveBeenCalledOnce();expect(h.writes).toEqual([]);
  });

  it("protects an actual analysis request and returns to an idle save after it finishes", async () => {
    const h = await ready("main"), response = deferred<{ ok: boolean; data: string }>();
    h.bridge.analyze.mockImplementation(() => response.promise);
    click(h, "back-input");click(h, "analyze");
    await vi.waitFor(() => expect(h.bridge.analyze).toHaveBeenCalledOnce());
    expect(await h.navigationGuard().canDeactivate()).toMatchObject({ allowed: false });
    response.complete({ ok: true, data: "local analysis fixture" });
    await vi.waitFor(() => expect(h.document.control("[data-action=config]").disabled).toBe(false));
    expect(await h.navigationGuard().canDeactivate()).toEqual({ allowed: true });
    expect((h.writes.at(-1)?.value as { draft: { tasks: Array<{ analysis: string }> } }).draft.tasks[0].analysis).toBe("local analysis fixture");
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it.each(["current", "previous"] as const)("protects actual original-image archiving for a %s result while generation is idle", async location => {
    const h = await ready("main"), response = deferred<{ ok: boolean }>(), resultId = `archive-local-${location}`;
    const currentSlot = h.controller().state.tasks[0].slots[0];
    currentSlot.status = "done";currentSlot.archiveOk = false;currentSlot.archiveContext = { accountKey, surfaceMode: "main" };
    currentSlot.item = { resultId, url: "https://fixture.test/archive-original.png", studioTaskId: "saved-product", productName: "已保存商品", studioGenesisPlan: clone(h.saved.draft.tasks[0].plan) };
    const slot = location === "current" ? currentSlot : clone(currentSlot);
    if (location === "previous") { h.controller().state.previousResults.push(slot);currentSlot.status = "ready";currentSlot.item = null; }
    const archive = vi.fn(() => response.promise);Object.assign(h.bridge, { archive });
    h.document.dispatch("cu-import-state");
    click(h, "archive", button => button.dataset.result === resultId);
    await vi.waitFor(() => expect(archive).toHaveBeenCalledOnce());
    expect(h.controller().state.busy).toBe(false);expect(slot.archiveSaving).toBe(true);
    expect(await h.navigationGuard().canDeactivate()).toMatchObject({ allowed: false });
    expect(h.beforeUnload().preventDefault).toHaveBeenCalledOnce();
    expect(h.document.control("[data-action=config]").disabled).toBe(true);
    expect(h.bridge.send).not.toHaveBeenCalled();
    response.complete({ ok: true });
    await vi.waitFor(() => expect(h.document.control("[data-action=config]").disabled).toBe(false));
    expect(await h.navigationGuard().canDeactivate()).toEqual({ allowed: true });
    const snapshot = (h.writes.at(-1)?.value as { snapshot: { tasks: Array<{ slots: unknown[] }>; previousResults: unknown[] } }).snapshot;
    const stored = location === "current" ? snapshot.tasks[0].slots[0] : snapshot.previousResults[0];
    expect(stored).toMatchObject({ archiveOk: true, archiveSaving: false, item: { resultId, url: "https://fixture.test/archive-original.png" } });
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it.each(["generate", "retry"] as const)("blocks navigation during the account/save preflight of an actual %s click", async action => {
    const h = await ready("main"), identity = deferred<string>(), response = deferred<{ ok: boolean; images: string[] }>();
    if (action === "retry") { h.controller().state.tasks[0].slots[0].status = "failed";h.document.dispatch("cu-import-state"); }
    h.bridge.getAccountKey.mockClear(); // Isolate this action from mandatory startup recovery account reads.
    h.bridge.getAccountKey.mockImplementationOnce(() => identity.promise);
    h.bridge.send.mockImplementation(() => response.promise);
    click(h, action);
    expect(h.bridge.getAccountKey).toHaveBeenCalledOnce();
    expect(h.bridge.send).not.toHaveBeenCalled();expect(h.writes).toEqual([]);
    expect(await h.navigationGuard().canDeactivate()).toMatchObject({ allowed: false });
    expect(h.beforeUnload().preventDefault).toHaveBeenCalledOnce();
    identity.complete(accountKey);
    await vi.waitFor(() => expect(h.bridge.send).toHaveBeenCalledOnce());
    expect(await h.navigationGuard().canDeactivate()).toMatchObject({ allowed: false });
    response.complete({ ok: true, images: ["https://fixture.test/preflight-result.png"] });
    await vi.waitFor(() => expect(h.document.control("[data-action=config]").disabled).toBe(false));
    expect(await h.navigationGuard().canDeactivate()).toEqual({ allowed: true });
  });

  it("retains the real timeout request through navigation guards and accepts its original late success exactly once", async () => {
    const h = harness("main", false, new Map(), "", { timeoutMs: 15 }), response = deferred<{ ok: boolean; images: string[] }>();
    const archive = vi.fn(async () => ({ ok: true }));Object.assign(h.bridge, { archive });
    h.bridge.send.mockImplementation(() => response.promise);
    h.refresh.complete({ ok: true, accountKey });h.read.complete(h.saved);
    await vi.waitFor(() => expect(h.bridge.listBoundApis).toHaveBeenCalledOnce());
    h.catalog.complete({ ok: true, accountKey, providers: [provider] });
    await vi.waitFor(() => expect(h.document.control("[data-action=generate]").disabled).toBe(false));
    click(h, "generate");
    await vi.waitFor(() => expect(h.bridge.send).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(h.controller().state).toMatchObject({ busy: false, awaitingReceipt: true }));
    const before = clone(h.controller().snapshot()), journalKey = `sz_studio_genesis_pending_v2:${accountKey}:single:main:${before.uncertain.jobId}`, pending = h.storage.get(journalKey);
    expect(h.controller().hasInFlightRequest()).toBe(true);expect(pending).toBeTruthy();
    expect(await h.navigationGuard().canDeactivate()).toMatchObject({ allowed: false });
    expect(h.beforeUnload().preventDefault).toHaveBeenCalledOnce();
    expect(await h.controller().resolveUncertain({ confirmed: true })).toMatchObject({ ok: false, code: "STUDIO_CONFIRM_REQUIRED" });
    expect(await h.controller().recoverPendingReceipt()).toMatchObject({ ok: false, code: "STUDIO_ALREADY_RUNNING" });
    expect(h.controller().restore(before)).toMatchObject({ ok: false, code: "STUDIO_ALREADY_RUNNING" });
    expect(h.controller().snapshot()).toEqual(before);expect(h.storage.get(journalKey)).toBe(pending);
    expect(h.bridge.send).toHaveBeenCalledOnce();expect(archive).not.toHaveBeenCalled();
    response.complete({ ok: true, images: ["https://fixture.test/original-late-success.png"] });
    await vi.waitFor(() => expect(h.controller().hasInFlightRequest()).toBe(false));
    expect(h.controller().state).toMatchObject({ busy: false, awaitingReceipt: false, uncertain: null });
    const slot = h.controller().state.tasks[0].slots[0];
    expect(slot).toMatchObject({ status: "done", archiveOk: true, item: { url: "https://fixture.test/original-late-success.png" } });
    expect(archive).toHaveBeenCalledOnce();expect(h.storage.has(journalKey)).toBe(false);
    expect(h.document.root.querySelectorAll("[data-action=download]")).toHaveLength(1);
    const saves = h.writes.length;
    expect(await h.navigationGuard().canDeactivate()).toEqual({ allowed: true });
    expect(h.writes).toHaveLength(saves + 1);
    expect((h.writes.at(-1)?.value as { snapshot: { tasks: Array<{ slots: unknown[] }> } }).snapshot.tasks[0].slots[0]).toMatchObject({ status: "done", archiveOk: true, item: { url: "https://fixture.test/original-late-success.png" } });
    expect(h.bridge.send).toHaveBeenCalledOnce();expect(archive).toHaveBeenCalledOnce();
  });

  it("denies failed writes and account changes before or during saving", async () => {
    const failure = await ready("main");failure.writeControl.error = new Error("fixture disk full");
    expect(await failure.navigationGuard().canDeactivate()).toMatchObject({ allowed: false, reason: expect.stringContaining("fixture disk full") });
    expect(failure.beforeUnload().preventDefault).toHaveBeenCalledOnce();
    expect(failure.document.control("[data-action=generate]").disabled).toBe(true);
    failure.writeControl.error = undefined;
    expect(await failure.navigationGuard().canDeactivate()).toEqual({ allowed: true });
    const before = await ready("detail");before.bridge.getAccountKey.mockResolvedValue("account:changed-before-save");
    expect(await before.navigationGuard().canDeactivate()).toMatchObject({ allowed: false, reason: expect.stringContaining("登录账号已变化") });
    expect(before.writes).toEqual([]);
    const during = await ready("main");during.bridge.getAccountKey.mockResolvedValueOnce(accountKey).mockResolvedValue("account:changed-after-save");
    expect(await during.navigationGuard().canDeactivate()).toMatchObject({ allowed: false, reason: expect.stringContaining("登录账号已变化") });
    expect(during.writes).toHaveLength(1);expect(during.writes[0].key).toBe(`${accountKey}:single:main`);
    expect(during.beforeUnload().preventDefault).toHaveBeenCalledOnce();
    const owner = await ready("main");owner.controller().state.accountKey = "account:wrong-controller-owner";
    expect(await owner.navigationGuard().canDeactivate()).toMatchObject({ allowed: false, reason: expect.stringContaining("任务所属账号") });
    expect(owner.writes).toEqual([]);
  });

  it.each(["active", "changed"] as const)("coalesces rapid requests and rejects %s state that appears during an asynchronous write", async change => {
    const h = await ready("main"), write = deferred<void>();h.writeControl.wait = write.promise;
    const first = h.navigationGuard().canDeactivate(), second = h.navigationGuard().canDeactivate();
    await vi.waitFor(() => expect(h.writes).toHaveLength(1));
    if (change === "active") h.controller().state.awaitingReceipt = true;
    else h.controller().state.message = "receipt updated while saving";
    write.complete();expect(await first).toMatchObject({ allowed: false });expect(await second).toMatchObject({ allowed: false });
    expect(h.writes).toHaveLength(1);expect(h.bridge.send).not.toHaveBeenCalled();
    expect(h.beforeUnload().preventDefault).toHaveBeenCalledOnce();
  });
});
async function flushDraft(h: InteractionHarness) {
  const previous = h.writes.length;
  h.beforeUnload();
  await vi.waitFor(() => expect(h.writes.length).toBeGreaterThan(previous));
  return latestDraft(h);
}
function fillDialog(h: InteractionHarness, values: Record<string, string>) {
  const modal = h.document.getElementById("sgDialog");
  if (!modal || modal.hidden) throw new Error("The real module editor did not open");
  for (const [attribute, value] of Object.entries(values)) {
    const input = modal.querySelector(`[${attribute}]`);
    if (!input) throw new Error(`The real module editor did not render ${attribute}`);
    input.value = value;
  }
  const save = modal.querySelector("[data-action=save-module]");
  if (!save) throw new Error("The real module editor did not render Save");
  modal.dispatch("click", save);
}
function clickDialog(h: InteractionHarness, action: string, predicate: (element: Element) => boolean = () => true) {
  const modal = h.document.getElementById("sgDialog"), button = modal?.querySelectorAll(`[data-action=${action}]`).find(predicate);
  if (!modal || modal.hidden || !button) throw new Error(`The real dialog did not render action ${action}`);
  modal.dispatch("click", button);
}
function saveGroupName(h: InteractionHarness, name: string) {
  const input = h.document.getElementById("sgDialog")?.querySelector("[data-group-name]");
  if (!input) throw new Error("The real group editor did not render its name field");
  input.value = name;clickDialog(h, "save-group");
}

describe("real studio replica control interactions", () => {
  it("persists empty groups and cascades rename/delete/undo without changing module content or approved plans", async () => {
    const storage = new Map([[`sz_studio_main_modules_v1:${accountKey}`, JSON.stringify([{ id: "kept-module", type: "main", name: "桌面陈列", skill: "柔和侧光", group: "原分组" }])]]);
    const h = harness("main", false, storage);
    h.refresh.complete({ ok: true, accountKey });h.read.complete(h.saved);
    await vi.waitFor(() => expect(h.bridge.listBoundApis).toHaveBeenCalledOnce());
    h.catalog.complete({ ok: true, accountKey, providers: [provider] });
    await vi.waitFor(() => expect(h.document.control("[data-action=config]").disabled).toBe(false));
    click(h, "module-mode", button => button.dataset.value === "custom");click(h, "module-tab", button => button.dataset.value === "mine");
    check(h, '[data-module="桌面陈列"]', true);click(h, "plan");
    await vi.waitFor(() => expect(h.document.root.querySelector("[data-confirm]")).not.toBeNull());check(h, "[data-confirm]", true);
    const originalPlan = clone((await flushDraft(h)).tasks[0].plan);
    click(h, "manage-groups");clickDialog(h, "group-editor");saveGroupName(h, "空分组");
    const registryKey = `sz_studio_module_groups_v1:${accountKey}`, libraryKey = `sz_studio_main_modules_v1:${accountKey}`;
    await vi.waitFor(() => expect(JSON.parse(storage.get(registryKey) || "[]")).toEqual(["原分组", "空分组"]));
    await vi.waitFor(() => expect(h.document.getElementById("sgDialog")?.querySelector("[data-action=group-editor]")?.disabled).toBe(false));
    expect(h.document.getElementById("sgDialog")?.textContent).toContain("0 个模块");
    clickDialog(h, "group-editor", button => button.dataset.group === "原分组");saveGroupName(h, "新分组");
    await vi.waitFor(() => expect(JSON.parse(storage.get(libraryKey) || "[]")[0].group).toBe("新分组"));
    expect(JSON.parse(storage.get(registryKey) || "[]")).toEqual(["新分组", "空分组"]);
    clickDialog(h, "delete-group", button => button.dataset.group === "新分组");
    await vi.waitFor(() => expect(JSON.parse(storage.get(libraryKey) || "[]")[0].group).toBe(""));
    expect(JSON.parse(storage.get(libraryKey) || "[]")[0]).toMatchObject({ id: "kept-module", name: "桌面陈列", skill: "柔和侧光" });
    expect(JSON.parse(storage.get(registryKey) || "[]")).toEqual(["空分组"]);
    clickDialog(h, "restore-group");
    await vi.waitFor(() => expect(JSON.parse(storage.get(libraryKey) || "[]")[0].group).toBe("新分组"));
    clickDialog(h, "close-dialog");
    const stored = await flushDraft(h);
    expect(stored.userModuleGroups).toEqual(["空分组", "新分组"]);
    expect(stored.tasks[0].confirmed).toBe(true);
    expect(stored.tasks[0].plan).toEqual(originalPlan);
    expect(h.bridge.send).not.toHaveBeenCalled();expect(h.bridge.analyze).not.toHaveBeenCalled();
  });

  it("restores empty and legacy inferred groups with account and environment isolation", async () => {
    const environment = "fixture-preview", prefix = `:${environment}`;
    const storage = new Map([
      [`sz_studio_module_groups_v1${prefix}:${accountKey}`, JSON.stringify(["已保存空分组"])],
      [`sz_studio_main_modules_v1${prefix}:${accountKey}`, JSON.stringify([{ id: "old-format", type: "detail", name: "已保存模块", skill: "同款可见细节", group: "旧模块自带分组" }])],
      [`sz_studio_module_groups_v1:${accountKey}`, JSON.stringify(["正式环境分组"])]
    ]);
    const own = harness("detail", false, storage, environment);
    own.refresh.complete({ ok: true, accountKey });own.read.complete(own.saved);
    await vi.waitFor(() => expect(own.bridge.listBoundApis).toHaveBeenCalledOnce());
    own.catalog.complete({ ok: true, accountKey, providers: [provider] });
    await vi.waitFor(() => expect(own.document.control("[data-action=config]").disabled).toBe(false));
    click(own, "module-mode", button => button.dataset.value === "custom");click(own, "module-tab", button => button.dataset.value === "mine");
    const groupFilter = own.document.control("[data-module-group]");
    expect(groupFilter.textContent).toContain("已保存空分组");expect(groupFilter.textContent).toContain("旧模块自带分组");expect(groupFilter.textContent).not.toContain("正式环境分组");
    const restored = await flushDraft(own);expect(restored.userModuleGroups).toEqual(["已保存空分组", "旧模块自带分组"]);
    const other = harness("detail", false, storage, environment), otherAccount = "account:group-other-owner";
    other.bridge.getAccountKey.mockResolvedValue(otherAccount);other.refresh.complete({ ok: true, accountKey: otherAccount });other.read.complete(null);
    await vi.waitFor(() => expect(other.bridge.listBoundApis).toHaveBeenCalledOnce());
    other.catalog.complete({ ok: true, accountKey: otherAccount, providers: [provider] });
    await vi.waitFor(() => expect(other.document.control("[data-action=config]").disabled).toBe(false));
    click(other, "module-mode", button => button.dataset.value === "custom");click(other, "module-tab", button => button.dataset.value === "mine");
    expect(other.document.control("[data-module-group]").textContent).not.toContain("已保存空分组");
    expect(other.document.control("[data-module-group]").textContent).not.toContain("旧模块自带分组");
    expect(JSON.parse(storage.get(`sz_studio_module_groups_v1${prefix}:${accountKey}`) || "[]")).toEqual(["已保存空分组"]);
  });

  it("does not call an old completed run current after edits, and excludes retained images from the next run progress", async () => {
    const h = harness("main"), oldSlot = h.saved.snapshot.tasks[0].slots[0];
    oldSlot.status = "done";oldSlot.archiveOk = true;oldSlot.item = { url: "https://fixture.test/old-result.png", resultId: "old-result", studioTaskId: "saved-product", productName: "已保存商品", studioGenesisPlan: clone(h.saved.draft.tasks[0].plan) };
    h.refresh.complete({ ok: true, accountKey });h.read.complete(h.saved);
    await vi.waitFor(() => expect(h.bridge.listBoundApis).toHaveBeenCalledOnce());h.catalog.complete({ ok: true, accountKey, providers: [provider] });
    await vi.waitFor(() => expect(h.document.control("[data-action=config]").disabled).toBe(false));
    expect(h.document.control(".sg-steps").querySelector(".is-active")?.textContent).toContain("完成");
    const requirements = h.document.control("[data-task-field=requirements]");requirements.value = "新的构图要求";h.document.root.dispatch("input", requirements);h.document.root.dispatch("change", requirements);
    expect(h.document.control(".sg-steps").querySelector(".is-active")?.textContent).toContain("输入");
    expect(h.document.root.querySelector("[data-action=retry-slot]")).toBeNull();expect(h.document.root.textContent).toContain("历史版本");
    expect(h.document.root.querySelectorAll("[data-action=download]").some(button => button.dataset.result === "old-result")).toBe(true);
    click(h, "plan");await vi.waitFor(() => expect(h.document.root.querySelector("[data-confirm]")).not.toBeNull());
    expect(h.document.control(".sg-steps").querySelector(".is-active")?.textContent).toContain("确认规划");
    check(h, "[data-confirm]", true);
    const response = deferred<{ ok: boolean; images: string[] }>();h.bridge.send.mockImplementation(() => response.promise);
    click(h, "generate");await vi.waitFor(() => expect(h.bridge.send).toHaveBeenCalledOnce());
    expect(h.document.control(".sg-run-summary").textContent).toContain("0/1 已完成");expect(h.document.control(".sg-run-summary").textContent).not.toContain("1/2");
    response.complete({ ok: true, images: ["https://fixture.test/new-result.png"] });
    await vi.waitFor(() => expect(h.document.control(".sg-run-summary").textContent).toContain("1/1 已完成"));
    expect(h.document.root.querySelectorAll("[data-action=download]")).toHaveLength(2);
    expect(h.document.control(".sg-steps").querySelector(".is-active")?.textContent).toContain("完成");
  });

  it("binds ad quality into its approved plan and keeps unavailable fast generation disabled", async () => {
    const h = harness("main");h.bridge.modelInfo.mockImplementation(() => ({ ready: true, supportsReference: true, provider: provider.provider, model: provider.imageModel, imageAdapter: "openai-images", qualityOptions: ["auto", "low", "medium", "high"] }));
    h.refresh.complete({ ok: true, accountKey });h.read.complete(h.saved);await vi.waitFor(() => expect(h.bridge.listBoundApis).toHaveBeenCalledOnce());
    h.catalog.complete({ ok: true, accountKey, providers: [provider] });await vi.waitFor(() => expect(h.document.control("[data-action=config]").disabled).toBe(false));
    click(h, "mode", button => button.dataset.mode === "ad");await vi.waitFor(() => expect(h.document.root.querySelector("[data-setting=quality]")).not.toBeNull());
    const quality = h.document.control("[data-setting=quality]");quality.value = "high";h.document.root.dispatch("change", quality);click(h, "generation-speed");click(h, "plan");
    await vi.waitFor(() => expect(h.document.root.querySelector("[data-confirm]")).not.toBeNull());
    const stored = await flushDraft(h);expect(stored.settings).toMatchObject({ quality: "high", generationSpeed: "standard" });
    const payload = h.engine.createPayload(stored.tasks[0].plan, "shot-1");expect(payload.quality).toBe("high");expect(h.engine.validateGenerationPayload(payload).ok).toBe(true);
    const fast = h.document.root.querySelectorAll("button").find(button => button.textContent === "快速");expect(fast?.disabled).toBe(true);expect(fast?.attributes.get("title")).toContain("未提供");
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("blocks sidebar navigation during a pending generation and flushes the completed draft when idle", async () => {
    const h = await ready("main"), reply = deferred<{ ok: boolean; images: string[] }>();
    h.bridge.send.mockImplementation(() => reply.promise);click(h, "generate");
    await vi.waitFor(() => expect(h.bridge.send).toHaveBeenCalledOnce());expect(await h.navigationGuard().canDeactivate()).toMatchObject({ allowed: false });
    reply.complete({ ok: true, images: ["https://fixture.test/guard-result.png"] });
    await vi.waitFor(() => expect(h.document.control("[data-action=config]").disabled).toBe(false));
    const writes = h.writes.length;expect(await h.navigationGuard().canDeactivate()).toMatchObject({ allowed: true });expect(h.writes.length).toBeGreaterThan(writes);
    const snapshot = (h.writes.at(-1)?.value as { snapshot: { tasks: Array<{ slots: Array<{ item: { url: string } }> }> } }).snapshot;
    expect(snapshot.tasks[0].slots[0].item.url).toBe("https://fixture.test/guard-result.png");
  });

  it.each(["main", "detail"] as const)("persists every selected %s module and invalidates confirmation when selection is removed", async mode => {
    const h = await ready(mode);
    expect(h.document.control("[data-action=generate]").disabled).toBe(false);
    click(h, "module-mode", button => button.dataset.value === "custom");
    await vi.waitFor(() => expect(h.document.root.querySelector("[data-module-all]")).not.toBeNull());
    check(h, "[data-module-all]", true);
    const modules = mode === "detail" ? h.engine.detailModules : h.engine.mainModules;
    const selected = await flushDraft(h);
    expect(selected.settings.modules).toEqual(modules.map((module: { label: string }) => module.label));
    expect(selected.settings.count).toBe(mode === "detail" ? 16 : 5);
    expect(selected.tasks[0]).toMatchObject({ plan: null, confirmed: false });
    expect(h.document.control("[data-module-all]").checked).toBe(true);
    expect(h.document.control("[data-action=generate]").disabled).toBe(true);
    click(h, "plan");
    await vi.waitFor(() => expect(h.document.root.querySelectorAll("[data-shot]")).toHaveLength(modules.length));
    check(h, "[data-confirm]", true);
    await vi.waitFor(() => expect(h.document.control("[data-action=generate]").disabled).toBe(false));
    const approved = await flushDraft(h);
    expect(approved.tasks[0].plan?.shots.map(shot => shot.label)).toEqual(selected.settings.modules);
    expect(approved.tasks[0].confirmed).toBe(true);
    check(h, `[data-module="${modules[0].label}"]`, false);
    const removed = await flushDraft(h);
    expect(removed.settings.count).toBe(modules.length - 1);
    expect(removed.settings.modules).not.toContain(modules[0].label);
    expect(removed.tasks[0]).toMatchObject({ plan: null, confirmed: false });
    expect(h.document.control("[data-action=generate]").disabled).toBe(true);
    expect(h.bridge.analyze).not.toHaveBeenCalled();
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("keeps module quantities in selection order, respects five-per-module, and persists expert mode as a boolean", async () => {
    const h = await ready("main");
    click(h, "module-mode", button => button.dataset.value === "custom");
    check(h, '[data-module="首页图"]', true);
    check(h, '[data-module="细节图"]', true);
    for (let i = 0; i < 4; i++) click(h, "module-count", button => button.dataset.label === "首页图" && button.dataset.delta === "1");
    const plus = h.document.root.querySelectorAll("[data-action=module-count]").find(button => button.dataset.label === "首页图" && button.dataset.delta === "1");
    expect(plus?.disabled).toBe(true);
    click(h, "module-count", button => button.dataset.label === "首页图" && button.dataset.delta === "1");
    check(h, "[data-setting=expertMode]", true);
    const stored = await flushDraft(h);
    expect(stored.settings.modules).toEqual(["首页图", "首页图", "首页图", "首页图", "首页图", "细节图"]);
    expect(stored.settings.count).toBe(6);
    expect(stored.settings.expertMode).toBe(true);
    click(h, "plan");
    await vi.waitFor(() => expect(h.document.root.querySelectorAll("[data-shot]")).toHaveLength(6));
    const planned = await flushDraft(h);
    expect(planned.tasks[0].plan?.shots.every(shot => shot.prompt.includes("专家模式已开启"))).toBe(true);
    check(h, "[data-setting=expertMode]", false);
    const changed = await flushDraft(h);
    expect(changed.settings.expertMode).toBe(false);
    expect(changed.tasks[0].plan).toBeNull();
    expect(h.document.control("[data-action=generate]").disabled).toBe(true);
  });

  it("persists an ad template and type in the actual plan and bound generation payload", async () => {
    const h = await ready("main");
    click(h, "mode", button => button.dataset.mode === "ad");
    await vi.waitFor(() => expect(h.document.root.textContent).toContain("超现实广告图实验室"));
    click(h, "ad-template", button => button.dataset.value === "neon_future");
    const type = h.document.control("[data-setting=adType]"); type.value = "品牌广告";
    h.document.root.dispatch("change", type);
    click(h, "plan");
    await vi.waitFor(() => expect(h.document.root.querySelectorAll("[data-shot]")).toHaveLength(1));
    const stored = await flushDraft(h);
    expect(stored.settings).toMatchObject({ mode: "main", imageType: "ad", adType: "品牌广告", adTemplate: "neon_future" });
    const payload = h.engine.createPayload(stored.tasks[0].plan, "shot-1");
    expect(payload.prompt).toContain("商品广告图");
    expect(payload.prompt).toContain("广告模板：霓虹未来");
    expect(payload.prompt).toContain("广告类型：品牌广告");
    expect(h.engine.validateGenerationPayload(payload).ok).toBe(true);
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("creates, selects, edits and removes a saved user module without retaining a stale approved plan", async () => {
    const h = await ready("main");
    click(h, "module-mode", button => button.dataset.value === "custom");
    click(h, "module-tab", button => button.dataset.value === "mine");
    click(h, "module-editor");
    fillDialog(h, { "data-module-type": "main", "data-module-name": "桌面展示", "data-module-skill": "单张俯拍，浅色桌面", "data-module-group-name": "商品陈列", "data-module-description": "陈列同款商品" });
    const libraryKey = `sz_studio_main_modules_v1:${accountKey}`;
    await vi.waitFor(() => expect(JSON.parse(h.storage.get(libraryKey) || "[]")).toHaveLength(1));
    await vi.waitFor(() => expect(h.document.root.querySelector('[data-module="桌面展示"]')).not.toBeNull());
    check(h, '[data-module="桌面展示"]', true);
    let stored = await flushDraft(h);
    expect(stored.settings.moduleSkills).toEqual({ "桌面展示": "单张俯拍，浅色桌面" });
    click(h, "plan");
    await vi.waitFor(() => expect(h.document.root.querySelector("[data-confirm]")).not.toBeNull());
    check(h, "[data-confirm]", true);
    expect(h.document.control("[data-action=generate]").disabled).toBe(false);
    click(h, "manage-modules");
    const moduleId = JSON.parse(h.storage.get(libraryKey) || "[]")[0].id as string;
    click(h, "module-editor", button => button.dataset.moduleId === moduleId);
    expect(h.document.getElementById("sgDialog")?.querySelector("[data-module-skill]")?.value).toBe("单张俯拍，浅色桌面");
    fillDialog(h, { "data-module-name": "自然光陈列", "data-module-skill": "柔和侧光，完整展示同款商品" });
    await vi.waitFor(() => expect(JSON.parse(h.storage.get(libraryKey) || "[]")[0].name).toBe("自然光陈列"));
    stored = await flushDraft(h);
    expect(stored.settings.modules).toEqual(["自然光陈列"]);
    expect(stored.settings.moduleSkills).toEqual({ "自然光陈列": "柔和侧光，完整展示同款商品" });
    expect(stored.tasks[0]).toMatchObject({ plan: null, confirmed: false });
    expect(h.document.control("[data-action=generate]").disabled).toBe(true);
    click(h, "delete-module", button => button.dataset.moduleId === moduleId);
    await vi.waitFor(() => expect(JSON.parse(h.storage.get(libraryKey) || "[]")).toEqual([]));
    stored = await flushDraft(h);
    expect(stored.settings.modules).toEqual([]);
    expect(stored.settings.moduleSkills).toEqual({});
    expect(stored.tasks[0].plan).toBeNull();
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("restores the saved module library only for its owner account", async () => {
    const storage = new Map([[`sz_studio_main_modules_v1:${accountKey}`, JSON.stringify([{ id: "saved-module", type: "main", name: "已保存的自建模块", skill: "柔和光线，完整商品", group: "常用" }])]]);
    const own = harness("main", false, storage);
    own.refresh.complete({ ok: true, accountKey }); own.read.complete(own.saved);
    await vi.waitFor(() => expect(own.bridge.listBoundApis).toHaveBeenCalledOnce());
    own.catalog.complete({ ok: true, accountKey, providers: [provider] });
    await vi.waitFor(() => expect(own.document.control("[data-action=config]").disabled).toBe(false));
    click(own, "module-mode", button => button.dataset.value === "custom");
    click(own, "module-tab", button => button.dataset.value === "mine");
    expect(own.document.root.querySelector('[data-module="已保存的自建模块"]')).not.toBeNull();
    const other = harness("main", false, storage), otherAccount = "account:another-owner";
    other.bridge.getAccountKey.mockResolvedValue(otherAccount);
    other.refresh.complete({ ok: true, accountKey: otherAccount }); other.read.complete(null);
    await vi.waitFor(() => expect(other.bridge.listBoundApis).toHaveBeenCalledOnce());
    other.catalog.complete({ ok: true, accountKey: otherAccount, providers: [provider] });
    await vi.waitFor(() => expect(other.document.control("[data-action=config]").disabled).toBe(false));
    click(other, "module-mode", button => button.dataset.value === "custom");
    click(other, "module-tab", button => button.dataset.value === "mine");
    expect(other.document.root.querySelector('[data-module="已保存的自建模块"]')).toBeNull();
    expect(other.document.root.textContent).toContain("暂无可用模块");
    expect(storage.has(`sz_studio_main_modules_v1:${otherAccount}`)).toBe(false);
    expect(JSON.parse(storage.get(`sz_studio_main_modules_v1:${accountKey}`) || "[]")).toHaveLength(1);
  });

  it("keeps an unknown receipt's exact image protected without a manual release while the rest of the workspace continues", async () => {
    const h = harness("main"), receipt = { jobId: "fixture-unknown-job", taskId: "saved-product", shotId: "shot-1", accountKey };
    h.saved.snapshot.uncertain = receipt;
    h.saved.snapshot.tasks[0].slots[0].status = "uncertain";
    const journalKey = `sz_studio_genesis_pending_v1:${accountKey}`, raw = JSON.stringify(receipt);
    h.storage.set(journalKey, raw);
    h.refresh.complete({ ok: true, accountKey }); h.read.complete(h.saved);
    await vi.waitFor(() => expect(h.bridge.listBoundApis).toHaveBeenCalledOnce());
    h.catalog.complete({ ok: true, accountKey, providers: [provider] });
    await vi.waitFor(() => expect(h.document.root.querySelector("[data-pending-receipt]")).not.toBeNull());
    // No manual clear exists: the unknown request can only be settled by its own receipt.
    expect(h.document.root.querySelector("[data-uncertain-confirm]")).toBeNull();
    expect(h.document.root.querySelector("[data-action=resolve]")).toBeNull();
    expect(h.document.root.querySelector("[data-action=retry-slot]")).toBeNull();
    // The rest of the workspace continues; a new image is an explicit new paid task.
    await vi.waitFor(() => expect(h.document.control("[data-setting=model]").disabled).toBe(false));
    expect(h.document.control("[data-action=generate]").disabled).toBe(false);
    expect(h.document.control("[data-new-generation-note]").textContent).toContain("另生成 1 张新图，按新任务计费");
    expect(h.document.control('[data-task-row="fixture-unknown-job"]').textContent).toContain("新生成按新任务计费");
    h.dispatchWindow("focus");
    await vi.waitFor(() => expect(h.recoveryStarted).toHaveBeenCalledTimes(2));
    expect(h.storage.get(journalKey)).toBe(raw);
    const stored = await flushDraft(h), persisted = h.persistedDrafts.get(`${accountKey}:single:main`) as { snapshot: { uncertain: unknown; tasks: Array<{ slots: Array<{ status: string }> }> } };
    expect(persisted.snapshot.uncertain).toMatchObject({ jobId: receipt.jobId, taskId: receipt.taskId, shotId: receipt.shotId });
    expect(persisted.snapshot.tasks[0].slots[0].status).toBe("uncertain");
    expect(stored.tasks[0].id).toBe("saved-product");
    expect(stored.tasks[0].plan).not.toBeNull();
    expect(h.bridge.send).not.toHaveBeenCalled();
  });
});

describe("confirmed plans with unavailable image API feedback", () => {
  it.each(["main", "detail"] as const)("keeps the approved %s plan disabled with a configuration reason, then enables that same plan when its API becomes ready", async mode => {
    const h = harness(mode), model = h.saved.draft.settings.model;
    h.bridge.modelInfo.mockReturnValue({ ready: false, supportsReference: true, provider: provider.provider, model });
    h.refresh.complete({ ok: true, accountKey }); h.read.complete(h.saved);
    await vi.waitFor(() => expect(h.bridge.listBoundApis).toHaveBeenCalledOnce());
    expect(h.document.root.querySelector("[data-generation-api-required]")).toBeNull();
    h.catalog.complete({ ok: true, accountKey, providers: [] });
    await vi.waitFor(() => expect(h.document.control("[data-action=config]").disabled).toBe(false));
    expect(h.document.control("[data-confirm]").checked).toBe(true);
    expect(h.document.control("[data-action=generate]").disabled).toBe(true);
    const hint = h.document.control("[data-generation-api-required]");
    expect(hint.textContent).toContain("当前自有 API 尚未配置完整");
    expect(hint.textContent).toContain("平台积分模式");
    const config = hint.querySelector("[data-action=config]");
    expect(config?.disabled).toBe(false);
    h.document.root.dispatch("click", config!);
    expect(h.bridge.openConfig).toHaveBeenCalledOnce();
    expect(h.writes).toEqual([]);
    h.bridge.modelInfo.mockReturnValue({ ready: true, supportsReference: true, provider: provider.provider, model });
    h.bridge.listBoundApis.mockResolvedValue({ ok: true, accountKey, providers: [{ ...provider, imageModel: model }] });
    h.document.dispatch("visibilitychange");
    await vi.waitFor(() => expect(h.document.control("[data-action=generate]").disabled).toBe(false));
    expect(h.document.root.querySelector("[data-generation-api-required]")).toBeNull();
    expect(h.document.control("[data-confirm]").checked).toBe(true);
    const stored = await flushDraft(h);
    expect(stored.tasks[0].plan).toEqual(h.saved.draft.tasks[0].plan);
    expect(stored.tasks[0].confirmed).toBe(true);
    expect(h.bridge.analyze).not.toHaveBeenCalled();
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("does not unlock or write another account's configuration into the approved draft", async () => {
    const h = harness("detail"), model = h.saved.draft.settings.model;
    h.bridge.modelInfo.mockReturnValue({ ready: false, supportsReference: true, provider: provider.provider, model });
    h.refresh.complete({ ok: true, accountKey }); h.read.complete(h.saved);
    await vi.waitFor(() => expect(h.bridge.listBoundApis).toHaveBeenCalledOnce());
    h.catalog.complete({ ok: true, accountKey, providers: [] });
    await vi.waitFor(() => expect(h.document.root.querySelector("[data-generation-api-required]")).not.toBeNull());
    h.bridge.modelInfo.mockReturnValue({ ready: true, supportsReference: true, provider: provider.provider, model });
    h.bridge.getAccountKey.mockResolvedValue("account:another-owner");
    h.bridge.listBoundApis.mockResolvedValue({ ok: true, accountKey: "account:another-owner", providers: [provider] });
    h.document.dispatch("visibilitychange");
    await vi.waitFor(() => expect(h.document.control("[data-message]").textContent).toContain("登录账号已变化"));
    expect(h.document.control("[data-action=generate]").disabled).toBe(true);
    expect(h.document.control("[data-confirm]").checked).toBe(true);
    const checkedBeforeUnload = h.bridge.getAccountKey.mock.calls.length;
    h.beforeUnload();
    await vi.waitFor(() => expect(h.bridge.getAccountKey).toHaveBeenCalledTimes(checkedBeforeUnload + 1));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.writes).toEqual([]);
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("explains an explicitly unsupported reference model and keeps the approved plan intact", async () => {
    const h = harness("main"), model = h.saved.draft.settings.model;
    h.bridge.modelInfo.mockReturnValue({ ready: true, supportsReference: false, provider: provider.provider, model });
    h.refresh.complete({ ok: true, accountKey }); h.read.complete(h.saved);
    await vi.waitFor(() => expect(h.bridge.listBoundApis).toHaveBeenCalledOnce());
    h.catalog.complete({ ok: true, accountKey, providers: [] });
    await vi.waitFor(() => expect(h.document.root.querySelector("[data-generation-api-required]")).not.toBeNull());
    expect(h.document.control("[data-generation-api-required]").textContent).toContain("不支持产品参考图");
    expect(h.document.control("[data-action=generate]").disabled).toBe(true);
    expect(h.document.control("[data-confirm]").checked).toBe(true);
    expect((await flushDraft(h)).tasks[0].plan).toEqual(h.saved.draft.tasks[0].plan);
    expect(h.bridge.send).not.toHaveBeenCalled();
  });
});
