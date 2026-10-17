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
  readonly documentElement = new Element("HTML", this);
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

const liveIntervals = new Set<ReturnType<typeof globalThis.setInterval>>();
afterEach(() => { liveIntervals.forEach(handle => globalThis.clearInterval(handle)); liveIntervals.clear(); });
interface HarnessOptions { savedMode?: "main" | "detail"; explicit?: boolean; failBackup?: boolean;
  failPut?: (key: string) => Error | undefined; afterRead?: (key: string) => void }
function harness(mode: "main" | "detail", options: HarnessOptions = {}) {
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
  // Keyed, serialized model of the production draft store (see studio-genesis-startup):
  // absent keys read undefined, puts stage until complete, failures discard staged writes.
  const persistedDrafts = new Map<string, unknown>(), canonicalKey = `${accountKey}:single:${mode}`;
  let seeded = false, queue = Promise.resolve();
  const backupFailure = (key: string) => options.failBackup && key.includes(":before-explicit-mode:") ? new Error("fixture backup quota exceeded") : options.failPut?.(key);
  const db = {
    close: vi.fn(),
    transaction: (_store: string, access?: string) => {
      if (access !== undefined && access !== "readwrite") throw new Error(`Unexpected access: ${access}`);
      const prior = queue; let release!: () => void; queue = new Promise<void>(resolve => { release = resolve; });
      const staged = new Map<string, unknown>(); let pending = 0;
      const tx = { finished: false, oncomplete: undefined as undefined | (() => void), onerror: undefined as undefined | (() => void), onabort: undefined as undefined | (() => void), error: undefined as undefined | Error,
        abort: () => finish("abort"), objectStore: () => ({
          get: (key: string) => {
            reads.push(key);
            const request = { result: undefined as unknown, error: undefined as undefined | Error, onsuccess: undefined as undefined | (() => void), onerror: undefined as undefined | (() => void) };
            pending++;
            prior.then(() => read.promise).then(value => {
              pending--; if (tx.finished) return;
              if (!seeded) { seeded = true; if (value !== undefined) persistedDrafts.set(canonicalKey, clone(value)); }
              const stored = staged.has(key) ? staged.get(key) : persistedDrafts.get(key);
              request.result = stored === undefined ? undefined : clone(stored); request.onsuccess?.(); options.afterRead?.(key); idle();
            }, (error: Error) => { pending--; if (tx.finished) return; request.error = error; tx.error = error; request.onerror?.(); finish("error"); });
            return request;
          },
          put: (value: unknown, key: string) => {
            if (access !== "readwrite") throw new Error("ReadOnlyError");
            writes.push({ key, value: clone(value) }); const stagedValue = clone(value); pending++;
            prior.then(() => {
              pending--; if (tx.finished) return;
              const failure = backupFailure(key);
              if (failure) { tx.error = failure; finish("error"); return; }
              staged.set(key, stagedValue); idle();
            });
          }
        }) };
      function finish(kind: "complete" | "abort" | "error") {
        if (tx.finished) return; tx.finished = true;
        if (kind === "complete") staged.forEach((value, key) => persistedDrafts.set(key, clone(value)));
        staged.clear(); release();
        queueMicrotask(() => { if (kind === "complete") tx.oncomplete?.(); else if (kind === "abort") tx.onabort?.(); else tx.onerror?.(); });
      }
      const idle = () => queueMicrotask(() => { if (!pending && !tx.finished) finish("complete"); });
      prior.then(idle);
      return tx;
    }
  };
  const indexedDB = { open: vi.fn(() => {
    const request = { result: db, onsuccess: undefined as undefined | (() => void) };
    queueMicrotask(() => request.onsuccess?.()); return request;
  }) };
  const context = createContext({ document, indexedDB, URL, URLSearchParams, crypto: { randomUUID }, console, setTimeout, clearTimeout,
    location: { search: options.explicit === false ? "?studio=1" : `?studio=1&mode=${mode}` }, localStorage: { length: 0, key: () => null, getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
    setInterval: (callback: () => void, ms: number) => { const handle = globalThis.setInterval(callback, ms); liveIntervals.add(handle); return handle; },
    clearInterval: (handle: ReturnType<typeof globalThis.setInterval>) => { liveIntervals.delete(handle); globalThis.clearInterval(handle); },
    SZ_LAB_FIRST_PAINT: { complete: vi.fn() },
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
  return { document, bridge, refresh, catalog, read, restore, restoreStarted, reads, writes, saved, beforeUnload, persistedDrafts, canonicalKey, engine };
}


async function completeBoot(h: ReturnType<typeof harness>) {
  h.refresh.complete({ ok: true, accountKey }); h.read.complete(h.saved);
  await vi.waitFor(() => expect(h.bridge.listBoundApis, h.document.root.textContent).toHaveBeenCalledOnce());
  h.catalog.complete({ ok: true, accountKey, providers: [provider] });
  await vi.waitFor(() => expect(h.document.control("[data-setting=model]").disabled).toBe(false));
}

describe("explicit official module entries retain account materials and prior work", () => {
  // Migration contract: the canonical opposite-type row is never rewritten. One
  // UUID backup row and one separate type-recovery row are committed; the recovery
  // row owns fresh task IDs with unconfirmed plans, so no paid receipt moves.
  function migrationRows(h: ReturnType<typeof harness>) {
    const backups = [...h.persistedDrafts.keys()].filter(key => key.startsWith(`${h.canonicalKey}:before-explicit-mode:`));
    return { backups, recoveryKey: `${h.canonicalKey}:type-recovery-v1` };
  }
  const withoutRevision = (value: unknown) => ({ ...(value as Record<string, unknown>), revision: undefined });

  it.each(["main", "detail"] as const)("opens the explicit %s module while retaining the old opposite-mode draft", async mode => {
    const h = harness(mode, { savedMode: mode === "main" ? "detail" : "main" });
    const original = clone(h.saved);
    await completeBoot(h);
    const tab = h.document.root.querySelector(`[data-mode=${mode}]`)!;
    expect(tab.attributes.get("aria-selected")).toBe("true");
    expect(h.document.root.textContent).toContain(mode === "main" ? "主图生图实验室" : "详情生图实验室");
    expect(h.document.root.textContent).toContain("已保留旧版混合草稿");
    expect(h.document.control("[data-task-field=name]").value).toBe("已保存商品");
    expect(h.document.control("[data-task-field=requirements]").textContent).toBe("");
    expect(h.document.root.querySelector("[data-product-preview]")?.attributes.get("src")).toBe("https://fixture.test/product.png");
    // The migrated task has no plan yet: nothing can be generated until it is re-planned.
    expect(h.document.root.querySelector("[data-confirm]")).toBeNull();
    expect(h.document.root.querySelector("[data-action=generate]")).toBeNull();
    expect(h.document.control("[data-action=plan]")).toBeTruthy();
    const { backups, recoveryKey } = migrationRows(h);
    expect(backups).toHaveLength(1); expect(backups[0]).toMatch(/:before-explicit-mode:[0-9a-f-]{36}$/);
    expect(h.writes.map(write => write.key)).toEqual([backups[0], recoveryKey]);
    // Canonical row untouched; backup is exactly the original record.
    expect(h.persistedDrafts.get(h.canonicalKey)).toEqual(original);
    expect(withoutRevision(h.persistedDrafts.get(backups[0]))).toEqual(withoutRevision(original));
    const recovered = h.persistedDrafts.get(recoveryKey) as { draft: { settings: { mode: string }; legacyBackupKey: string; tasks: Array<{ id: string; plan: unknown; confirmed: boolean; products: unknown; requirements: string }> } };
    expect(recovered.draft.settings.mode).toBe(mode); expect(recovered.draft.legacyBackupKey).toBe(backups[0]);
    expect(recovered.draft.tasks[0].id).not.toBe(original.draft.tasks[0].id);
    expect(recovered.draft.tasks[0].plan).toBeNull(); expect(recovered.draft.tasks[0].confirmed).toBe(false);
    expect(recovered.draft.tasks[0].products).toEqual(original.draft.tasks[0].products);
    expect(h.saved).toEqual(original);
    expect(h.bridge.send).not.toHaveBeenCalled(); expect(h.bridge.analyze).not.toHaveBeenCalled();
    // Later saves go to the recovery row; the canonical row and backup never change.
    h.beforeUnload();
    await vi.waitFor(() => expect(h.writes).toHaveLength(3));
    expect(h.writes[2].key).toBe(recoveryKey);
    expect(h.persistedDrafts.get(h.canonicalKey)).toEqual(original);
    expect(withoutRevision(h.persistedDrafts.get(backups[0]))).toEqual(withoutRevision(original));
    const saved = h.persistedDrafts.get(recoveryKey) as { snapshot: { accountKey: string; tasks: unknown[] } };
    expect(saved.snapshot.accountKey).toBe(accountKey); expect(saved.snapshot.tasks).toEqual([]);
  });

  it("opens an old bookmark without an explicit mode as main while retaining its detail draft", async () => {
    const h = harness("main", { savedMode: "detail", explicit: false }), original = clone(h.saved);
    await completeBoot(h);
    expect(h.document.root.querySelector("[data-mode=main]")?.attributes.get("aria-selected")).toBe("true");
    expect(h.document.root.textContent).toContain("已保留旧版混合草稿");
    const { backups, recoveryKey } = migrationRows(h);
    expect(h.writes.map(write => write.key)).toEqual([backups[0], recoveryKey]);
    expect(h.persistedDrafts.get(h.canonicalKey)).toEqual(original);
    expect(withoutRevision(h.persistedDrafts.get(backups[0]))).toEqual(withoutRevision(original));
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("does not rewrite a matching explicit module draft", async () => {
    const h = harness("main"); await completeBoot(h);
    expect(h.document.root.querySelector("[data-mode=main]")?.attributes.get("aria-selected")).toBe("true");
    expect(h.document.root.querySelector("[data-confirm]")?.checked).toBe(true);
    expect(h.writes).toEqual([]);
    expect([...h.persistedDrafts.keys()]).toEqual([h.canonicalKey]);
  });

  it("leaves the original draft untouched when the safety backup cannot be saved", async () => {
    const h = harness("main", { savedMode: "detail", failBackup: true });
    const original = clone(h.saved);
    h.refresh.complete({ ok: true, accountKey }); h.read.complete(h.saved);
    await vi.waitFor(() => expect(h.document.root.textContent).toContain("fixture backup quota exceeded"));
    expect(h.document.root.textContent).toContain("创作工作台暂未就绪");
    expect(h.document.root.querySelector("[data-action=generate]")).toBeNull();
    expect(h.writes).toHaveLength(1); expect(h.writes[0].key).toMatch(new RegExp(`^${h.canonicalKey}:before-explicit-mode:`));
    expect(withoutRevision(h.writes[0].value)).toEqual(withoutRevision(original));
    // Nothing was committed: no backup, no recovery row, canonical row unchanged.
    expect([...h.persistedDrafts.keys()]).toEqual([h.canonicalKey]); expect(h.persistedDrafts.get(h.canonicalKey)).toEqual(original);
    expect(h.saved).toEqual(original);
    expect(h.bridge.listBoundApis).not.toHaveBeenCalled(); expect(h.bridge.send).not.toHaveBeenCalled();
    h.beforeUnload(); await new Promise(resolve => setTimeout(resolve, 1));
    expect(h.writes).toHaveLength(1);
  });
});

describe("workspace switch reads overlap the current save without weakening its guards", () => {
  const targetKey = `${accountKey}:single:detail`, targetRecovery = `${targetKey}:type-recovery-v1`;
  const switchTo = (h: ReturnType<typeof harness>, mode: string) => {
    const tab = h.document.control(`[data-mode=${mode}]`);
    h.document.root.dispatch("click", tab);
  };
  const targetWrites = (h: ReturnType<typeof harness>) => h.writes.filter(write => write.key.startsWith(targetKey));
  const mixedTargetDraft = (h: ReturnType<typeof harness>) => ({ ...clone(h.saved), revision: "target-mixed" });

  async function bootMain(options: HarnessOptions = {}) {
    const h = harness("main", options); await completeBoot(h); return h;
  }

  it("switches with the target read overlapping a successful source save", async () => {
    const h = await bootMain();
    switchTo(h, "detail");
    await vi.waitFor(() => expect(h.document.root.querySelector("[data-mode=detail]")?.attributes.get("aria-selected")).toBe("true"));
    // Source save first, then the switch commits the newly installed workspace.
    expect(h.writes.map(write => write.key)).toEqual([h.canonicalKey, targetKey]);
    expect(h.reads).toEqual(expect.arrayContaining([targetRecovery, targetKey]));
    expect(h.document.control("[data-mode=main]").disabled).toBe(false);
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it.each([
    ["quota", () => new Error("fixture source quota exceeded"), "fixture source quota exceeded"],
  ] as const)("unlocks at once when the source save fails (%s) while the target identity check is held, and never migrates the target", async (_name, failure, message) => {
    let failSource = false, holdTargetIdentity = false;
    const held = deferred<string>();
    const h = await bootMain({ failPut: key => failSource && key === `${accountKey}:single:main` ? failure() : undefined,
      afterRead: key => { if (holdTargetIdentity && key === targetRecovery) { holdTargetIdentity = false; hRef.bridge.getAccountKey.mockImplementationOnce(() => held.promise); } } });
    const hRef = h, nameBefore = h.document.control("[data-task-field=name]").value;
    h.persistedDrafts.set(targetKey, mixedTargetDraft(h)); const targetBefore = clone(h.persistedDrafts.get(targetKey));
    failSource = true; holdTargetIdentity = true;
    switchTo(h, "detail");
    // The failed source save is reported and the workspace unlocks while the target check is still pending.
    await vi.waitFor(() => expect(h.document.root.textContent).toContain(message));
    await vi.waitFor(() => expect(h.document.control("[data-mode=detail]").disabled).toBe(false));
    expect(h.document.root.querySelector("[data-mode=main]")?.attributes.get("aria-selected")).toBe("true");
    expect(h.document.control("[data-task-field=name]").value).toBe(nameBefore);
    // Releasing the abandoned target chain cannot migrate, install or write the target.
    held.complete(accountKey); await new Promise(resolve => setTimeout(resolve, 20));
    expect(targetWrites(h)).toEqual([]);
    expect(h.persistedDrafts.get(targetKey)).toEqual(targetBefore);
    expect([...h.persistedDrafts.keys()].filter(key => key.startsWith(targetKey))).toEqual([targetKey]);
    expect(h.document.root.querySelector("[data-mode=main]")?.attributes.get("aria-selected")).toBe("true");
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("reports another tab's canonical update as a save conflict, keeps that row and never migrates the target", async () => {
    const h = await bootMain();
    h.persistedDrafts.set(targetKey, mixedTargetDraft(h));
    const external = { ...clone(h.persistedDrafts.get(h.canonicalKey) as Record<string, unknown>), revision: "other-tab-revision" };
    h.persistedDrafts.set(h.canonicalKey, external);
    switchTo(h, "detail");
    await vi.waitFor(() => expect(h.document.root.textContent).toContain("其他页面已更新这份草稿"));
    await vi.waitFor(() => expect(h.document.control("[data-mode=detail]").disabled).toBe(false));
    expect(h.persistedDrafts.get(h.canonicalKey)).toEqual(external);
    expect(h.document.root.querySelector("[data-mode=main]")?.attributes.get("aria-selected")).toBe("true");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(targetWrites(h)).toEqual([]); expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it.each(["source", "target"] as const)("refuses to install the target when identity changes in the %s chain", async chain => {
    let flip = false;
    const h = await bootMain({ afterRead: key => { if (flip && chain === "target" && key === targetRecovery) { flip = false; hRef.bridge.getAccountKey.mockResolvedValue("account:foreign"); } } });
    const hRef = h;
    h.persistedDrafts.set(targetKey, mixedTargetDraft(h));
    if (chain === "source") h.bridge.getAccountKey.mockResolvedValue("account:foreign"); else flip = true;
    switchTo(h, "detail");
    await vi.waitFor(() => expect(h.document.root.textContent).toMatch(/账号已变化|账号.*(?:变化|切换)/));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.document.root.querySelector("[data-mode=main]")?.attributes.get("aria-selected")).toBe("true");
    expect(targetWrites(h)).toEqual([]); expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("installs another tab's newer target draft read during the overlap with its own save token", async () => {
    let replace = true;
    const h = await bootMain({ afterRead: key => {
      if (replace && key === targetRecovery) { replace = false; const next = clone(hRef.saved); next.draft.settings = { ...next.draft.settings, mode: "detail" }; next.draft.tasks[0].plan = null; next.draft.tasks[0].confirmed = false; next.snapshot.tasks = []; hRef.persistedDrafts.set(targetKey, { ...next, revision: "other-tab-target" }); }
    } });
    const hRef = h;
    switchTo(h, "detail");
    await vi.waitFor(() => expect(h.document.root.querySelector("[data-mode=detail]")?.attributes.get("aria-selected")).toBe("true"));
    expect(h.document.control("[data-task-field=name]").value).toBe("已保存商品");
    h.beforeUnload();
    await vi.waitFor(() => expect(h.writes.some(write => write.key === targetKey)).toBe(true));
    await vi.waitFor(() => expect((h.persistedDrafts.get(targetKey) as { revision: string }).revision).not.toBe("other-tab-target"));
    expect(h.document.root.textContent).not.toContain("其他页面已更新这份草稿");
  });
});
