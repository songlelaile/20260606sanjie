import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Request = { result: unknown; error?: Error; onsuccess: (() => void) | null; onerror: (() => void) | null };
type Options = { expectedAccountKey: string; isCurrent?: () => boolean; memoryRuns?: () => Row[];
  assetAliases?: Array<{ storageId: string; assetId: string }> };
type Store = { productionRetainedAssetIds(runs: unknown): Set<string>;
  deleteAssetsIfUnreferenced(ids: string[], options: Options): Promise<{ deleted: string[]; retained: string[] }>;
  saveRun(run: Row): Promise<Row>; saveDraft(mode: string, value: unknown, options?: Options): Promise<unknown>;
  deleteDraft(mode: string, options?: Options): Promise<unknown>; deleteAsset(id: string): Promise<unknown>;
  saveAsset(blob: Blob, metadata: Row): Promise<unknown> };
type Asset = Row & { id: string; kind: string; storageRef: { id: string }; previewUrl?: string };
type State = { accountKey: string; mode: string; draftEpoch: number; prompt: string; assets: Record<string, Asset[]>;
  reference: Asset | null; referenceFrames: Asset[]; history: Row[]; productionRun: Row | null; activeRun: Row | null;
  booted: boolean; draftTimer: number | null; settings: Row; rightsConfirmed: boolean; review: Row; sourceMutationPending: boolean;
  modelCatalog: Array<{ productKey: string; configured: boolean }> };
type Api = { state: State; cacheDom(): void; draftSnapshot(): unknown; removeAsset(kind: string, id: string): Promise<void>;
  removeReference(): Promise<void>; resetCurrentDraft(): Promise<void>; deleteReferenceFrames(frames: Asset[]): Promise<boolean>;
  restoreDraft(mode: string): Promise<boolean>; scheduleDraftSave(): void; saveCurrentDraft(): Promise<unknown>;
  setReferenceVideo(file: Blob & { name: string }): Promise<void>; assetRightsFingerprint(): string;
  startProductionGeneration(): Promise<void>; startGeneration(): Promise<void> };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function source(name: string) { return readFileSync(new URL(`../../public/creative/labs/ecommerce-video-studio/${name}`, import.meta.url), "utf8"); }

class Element {
  hidden = false; disabled = false; textContent = ""; className = ""; value = ""; checked = false;
  dataset: Record<string, string> = {}; style: Record<string, unknown> = { setProperty: vi.fn() }; children: unknown[] = [];
  classList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() };
  appendChild(child: unknown) { this.children.push(child); return child; }
  append(...children: unknown[]) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  querySelector() { return null; } querySelectorAll() { return []; } closest() { return new Element(); }
  setAttribute() {} removeAttribute() {} addEventListener() {} remove() {}
}

class Media extends Element {
  duration = 6; videoWidth = 640; videoHeight = 360;
  onloadedmetadata: (() => void) | null = null; onerror: (() => void) | null = null;
  events = new Map<string, () => void>();
  set src(_value: string) { queueMicrotask(() => this.onloadedmetadata?.()); }
  set currentTime(_value: number) { queueMicrotask(() => this.events.get("seeked")?.()); }
  load() {}
  addEventListener(name?: string, callback?: () => void) { if (name && callback) this.events.set(name, callback); }
  removeEventListener(name: string) { this.events.delete(name); }
}

// Transactional IDB model: staged writes commit together; abort discards them.
// The scope assertion below additionally checks that the real Store locks runs and assets together.
function harness(ui = false, oldStore = false) {
  const tables = { assets: new Map<string, Row>(), runs: new Map<string, Row>(), drafts: new Map<string, Row>() };
  type Table = keyof typeof tables;
  const transactions: Array<{ names: string[]; mode: string }> = [], deletes: string[] = [];
  let queue = Promise.resolve(), account = "tenant:alice", allOverride: unknown = undefined;
  let beforeRead: undefined | ((table: Table, operation: string, key?: string) => Promise<void> | void);
  const db = { close() {}, transaction(names: string | string[], mode: string) {
    const scope = Array.isArray(names) ? names : [names]; transactions.push({ names: scope, mode });
    const prior = queue; let release!: () => void; queue = new Promise<void>(resolve => { release = resolve; });
    const staged: Array<{ table: Table; key: string; value?: Row }> = []; let pending = 0;
    const tx = { finished: false, error: undefined as Error | undefined,
      oncomplete: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined,
      onabort: undefined as (() => void) | undefined, abort: () => finish(false), objectStore(table: Table) {
        if (!scope.includes(table)) throw new Error("NotFoundError: table is outside transaction scope");
        function request(operation: string, key?: string, value?: Row): Request {
          const result: Request = { result: undefined, onsuccess: null, onerror: null }; pending++;
          prior.then(() => beforeRead?.(table, operation, key)).then(() => {
            pending--; if (tx.finished) return;
            if (operation === "getAll") result.result = table === "runs" && allOverride !== undefined ? allOverride : structuredClone([...tables[table].values()]);
            if (operation === "get") result.result = structuredClone(tables[table].get(key!));
            if (operation === "put" || operation === "delete") {
              if (mode !== "readwrite") throw new Error("ReadOnlyError");
              staged.push({ table, key: key!, value: operation === "put" ? structuredClone(value) : undefined });
              result.result = key;
            }
            result.onsuccess?.(); idle();
          }).catch((error: Error) => { pending--; if (!tx.finished) { result.error = error; tx.error = error; result.onerror?.(); finish(false); } });
          return result;
        }
        return { get: (key: string) => request("get", key), getAll: () => request("getAll"),
          put: (value: Row) => request("put", String(value.id ?? value.mode), value), delete: (key: string) => request("delete", key),
          index: () => ({ getAll: () => request("getAll") }) };
      } };
    function finish(commit: boolean) {
      if (tx.finished) return; tx.finished = true;
      if (commit) for (const write of staged) {
        if (write.value) tables[write.table].set(write.key, write.value);
        else { tables[write.table].delete(write.key); if (write.table === "assets") deletes.push(write.key); }
      }
      release(); queueMicrotask(() => commit ? tx.oncomplete?.() : tx.onabort?.());
    }
    function idle() { queueMicrotask(() => { if (!pending && !tx.finished) finish(true); }); }
    prior.then(idle); return tx;
  } };
  const auth = { require: vi.fn(async () => account) };
  const nodes = new Map([...source("video-studio.html").matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const timers = new Map<number, { callback: () => void; ms: number }>(); let nextTimer = 0;
  const runtime = vi.fn();
  const context = vm.createContext({ console, Blob, structuredClone, CSS: { escape: (value: string) => value }, URL: { revokeObjectURL: vi.fn(), createObjectURL: () => "blob:restored" }, AbortController,
    indexedDB: { open() { const request = { result: db, onsuccess: undefined as ((event: { target: { result: typeof db } }) => void) | undefined };
      queueMicrotask(() => request.onsuccess?.({ target: { result: db } })); return request; } }, SZ_WEB_ACCOUNT: auth,
    setTimeout(callback: () => void, ms: number) { timers.set(++nextTimer, { callback, ms }); return nextTimer; }, clearTimeout(id: number) { timers.delete(id); },
    confirm: () => true, document: { readyState: "loading", addEventListener() {}, getElementById: (id: string) => nodes.get(id) ?? null,
      createElement: (tag: string) => tag === "video" || tag === "audio" ? new Media() : tag === "canvas" ?
        { getContext: () => ({ drawImage() {} }), toBlob: (done: (blob: Blob) => void) => done(new Blob(["frame"], { type: "image/jpeg" })) } : new Element(),
      querySelector: () => new Element(), querySelectorAll: () => [] }, chrome: { runtime: { sendMessage: runtime } }, __SZ_VIDEO_STUDIO_EXPOSE_TESTING__: true });
  vm.runInContext(source("video-studio-store.js"), context);
  const store = context.SZEcommerceVideoStore as Store;
  if (oldStore) context.SZEcommerceVideoStore = { ...store, deleteAssetsIfUnreferenced: undefined };
  if (ui) for (const file of ["video-studio-contract.js", "video-production.js", "video-studio.js"]) vm.runInContext(source(file), context);
  const api = context.SZEcommerceVideoStudioTesting as Api;
  if (ui) { api.cacheDom(); Object.assign(api.state, { accountKey: account, booted: true, prompt: "original", backendConnected: true }); }
  function asset(id = "local-image", extra: Row = {}): Asset {
    tables.assets.set(id, { id, accountKey: "tenant:alice", kind: "image", ...extra });
    return { id, kind: "image", name: id, mimeType: "image/png", storageRef: { id }, previewUrl: `blob:${id}` };
  }
  function flushDraftTimer() { for (const [id, timer] of timers) if (timer.ms === 320) { timers.delete(id); timer.callback(); } }
  return { tables, store, api, context, auth, runtime, nodes, transactions, deletes, timers, asset, flushDraftTimer,
    setAccount(value: string) { account = value; }, overrideRuns(value: unknown) { allOverride = value; },
    onRead(callback: typeof beforeRead) { beforeRead = callback; } };
}
function production(extra: Row = {}): Row { return { id: "old", purpose: "production", status: "failed", accountKey: "tenant:alice", ...extra }; }

describe("complete production asset retention through the real Store", () => {
  it.each(["images", "videos", "audios", "referenceFrames", "productImages", "generationVideos", "referenceVideos", "referenceAudios"])("protects every per-shot %s local reference", async key => {
    const h = harness(); h.asset(); h.tables.runs.set("old", production({ plan: { shots: [{ request: { [key]: [{ id: "local-image" }] } }] } }));
    await h.store.deleteAssetsIfUnreferenced(["local-image"], { expectedAccountKey: "tenant:alice" });
    expect(h.tables.assets.has("local-image")).toBe(true); expect(h.deletes).toEqual([]);
  });
  it.each([
    { plan: { shots: [{ request: { referenceVideo: { id: "local-image" } } }] } },
    { plan: { request: { images: [{ id: "other", storageRef: { id: "local-image" } }] } } },
    { plan: { shots: [{ sourceAssetId: "local-image" }] } },
    { plan: { musicAssetIds: ["local-image"] } },
    { plan: { finalAudio: { assets: [{ id: "local-image" }], tracks: [] } } },
    { plan: { finalAudio: { tracks: [{ assetId: "local-image" }] } } },
    { resultAssetId: "local-image" },
    { shotRuns: [{ resultAssetId: "local-image" }] },
    { narrationRuns: [{ attempts: [{ receipt: { resultAssetId: "local-image" } }] }] }
  ])("protects legacy, source, audio and nested result references %#", async reference => {
    const h = harness(); h.asset(); h.tables.runs.set("old", production(reference));
    await h.store.deleteAssetsIfUnreferenced(["local-image"], { expectedAccountKey: "tenant:alice" });
    expect(h.deletes).toEqual([]);
  });
  it("scans all records including old, hidden, released and other-account plans", async () => {
    const h = harness(); h.asset();
    for (let i = 0; i < 105; i++) h.tables.runs.set(String(i), production({ id: String(i), accountKey: "other:owner", newPlanRequestedAt: "saved", hidden: true,
      resultAssetId: i === 104 ? "local-image" : undefined }));
    await h.store.deleteAssetsIfUnreferenced(["local-image"], { expectedAccountKey: "tenant:alice" });
    expect(h.deletes).toEqual([]);
  });
  it.each([null, {}, [null], [production({ plan: "broken" })], [production({ plan: { shots: "broken" } })], [production({ plan: { shots: ["broken"] } })],
    [production({ plan: { request: { images: "broken" } } })], [production({ plan: { request: { images: [null] } } })],
    [production({ plan: { request: { images: [{ storageRef: {} }] } } })]])("retains blobs when history is malformed %#", async value => {
    const h = harness(); h.asset(); h.overrideRuns(value);
    await expect(h.store.deleteAssetsIfUnreferenced(["local-image"], { expectedAccountKey: "tenant:alice" })).rejects.toThrow();
    expect(h.deletes).toEqual([]); expect(h.tables.assets.has("local-image")).toBe(true);
  });
  it("locks assets and runs together and sees a plan saved before deletion", async () => {
    const h = harness(); h.asset();
    await h.store.saveRun(production({ resultAssetId: "local-image" }));
    await h.store.deleteAssetsIfUnreferenced(["local-image"], { expectedAccountKey: "tenant:alice" });
    expect(h.transactions.some(tx => tx.mode === "readwrite" && tx.names.includes("assets") && tx.names.includes("runs"))).toBe(true);
    expect(h.deletes).toEqual([]);
  });
  it("deletes only owned unreferenced records; legacy and other-owner records remain", async () => {
    const h = harness(); h.asset("owned"); h.asset("legacy", { accountKey: undefined }); h.asset("other", { accountKey: "tenant:bob" });
    await h.store.deleteAssetsIfUnreferenced(["owned", "legacy", "other"], { expectedAccountKey: "tenant:alice" });
    expect(h.deletes).toEqual(["owned"]); expect([...h.tables.assets.keys()]).toEqual(["legacy", "other"]);
  });
  it.each(["missing", "changed", "failed", "empty"])("does not delete when identity is %s", async kind => {
    const h = harness(); h.asset();
    if (kind === "missing") h.context.SZ_WEB_ACCOUNT = undefined;
    if (kind === "changed") h.setAccount("tenant:bob");
    if (kind === "failed") h.auth.require.mockRejectedValueOnce(new Error("offline"));
    await expect(h.store.deleteAssetsIfUnreferenced(["local-image"], { expectedAccountKey: kind === "empty" ? "" : "tenant:alice" })).rejects.toThrow();
    expect(h.deletes).toEqual([]);
  });
  it("aborts the entire batch if the draft becomes stale between asset reads", async () => {
    const h = harness(); h.asset("first"); h.asset("second"); let current = true;
    h.onRead((table, op, id) => { if (table === "assets" && op === "get" && id === "second") current = false; });
    await expect(h.store.deleteAssetsIfUnreferenced(["first", "second"], { expectedAccountKey: "tenant:alice", isCurrent: () => current })).rejects.toThrow();
    expect(h.deletes).toEqual([]); expect(h.tables.assets.size).toBe(2);
  });
  it.each(["context", "new-reference"])("aborts a queued physical delete after a %s change", async change => {
    const h = harness(); h.asset(); let current = true; const memory: Row[] = [];
    h.onRead((table, op) => { if (table === "assets" && op === "delete") {
      if (change === "context") current = false; else memory.push(production({ resultAssetId: "local-image" }));
    } });
    await expect(h.store.deleteAssetsIfUnreferenced(["local-image"], { expectedAccountKey: "tenant:alice", isCurrent: () => current, memoryRuns: () => memory })).rejects.toThrow();
    expect(h.tables.assets.has("local-image")).toBe(true); expect(h.deletes).toEqual([]);
  });
  it.each(["save", "delete"])("aborts an already queued draft %s after its context changes", async operation => {
    const h = harness(); h.tables.drafts.set("direct", { mode: "direct", data: { prompt: "old" } }); let current = true;
    h.onRead((table, op) => { if (table === "drafts" && op === (operation === "save" ? "put" : "delete")) current = false; });
    const options = { expectedAccountKey: "tenant:alice", isCurrent: () => current };
    await expect(operation === "save" ? h.store.saveDraft("direct", { prompt: "new" }, options) : h.store.deleteDraft("direct", options)).rejects.toThrow("草稿");
    expect(h.tables.drafts.get("direct")).toEqual({ mode: "direct", data: { prompt: "old" } });
  });
  it("aborts a queued reference upload when its draft changes", async () => {
    const h = harness(); let current = true;
    h.onRead((table, op) => { if (table === "assets" && op === "put") current = false; });
    await expect(h.store.saveAsset(new Blob(["video"]), { id: "new-reference", expectedAccountKey: "tenant:alice", isCurrent: () => current })).rejects.toThrow("草稿");
    expect(h.tables.assets.size).toBe(0);
  });
});

describe("draft removal uses production retention and captured context", () => {
  it("keeps a per-shot request source when removing it from the draft", async () => {
    const h = harness(true); h.api.state.assets.image = [h.asset()];
    h.tables.runs.set("old", production({ plan: { shots: [{ request: { images: [{ id: "local-image" }] } }] } }));
    await h.api.removeAsset("image", "local-image");
    expect(h.api.state.assets.image).toEqual([]); expect(h.tables.assets.has("local-image")).toBe(true); expect(h.runtime).not.toHaveBeenCalled();
  });
  it.each(["history", "productionRun", "activeRun"] as const)("protects references present only in memory %s", async location => {
    const h = harness(true); h.api.state.assets.image = [h.asset()]; const run = production({ resultAssetId: "local-image" });
    if (location === "history") h.api.state.history = [run]; else h.api.state[location] = run;
    await h.api.removeAsset("image", "local-image"); expect(h.deletes).toEqual([]);
  });
  it("uses both a draft asset alias and its local storage id", async () => {
    const h = harness(true); const asset = h.asset("stored-blob"); asset.id = "draft-alias"; h.api.state.assets.image = [asset];
    h.tables.runs.set("old", production({ resultAssetId: "draft-alias" }));
    await h.api.removeAsset("image", "draft-alias"); expect(h.tables.assets.has("stored-blob")).toBe(true);
  });
  it.each(["remove", "frames", "reset"])("protects reference videos and frames through %s", async method => {
    const h = harness(true); const video = h.asset("reference"), frame = h.asset("frame");
    h.api.state.reference = video; h.api.state.referenceFrames = [frame];
    h.tables.runs.set("old", production({ plan: { shots: [{ request: { referenceVideo: { id: "reference" }, referenceFrames: [{ id: "frame" }] } }] } }));
    if (method === "remove") await h.api.removeReference();
    else if (method === "frames") await h.api.deleteReferenceFrames([frame]);
    else await h.api.resetCurrentDraft();
    expect(h.deletes).toEqual([]); expect(h.tables.assets.size).toBe(2);
  });
  it.each(["failed", "malformed"])("removes only the draft entry when stored history is %s", async kind => {
    const h = harness(true); h.api.state.assets.image = [h.asset()];
    if (kind === "failed") h.onRead((table, op) => { if (table === "runs" && op === "getAll") throw new Error("unreadable"); });
    else h.overrideRuns({ malformed: true });
    await h.api.removeAsset("image", "local-image"); expect(h.api.state.assets.image).toEqual([]); expect(h.deletes).toEqual([]);
  });
  it.each(["account", "mode", "draft", "edit", "starting", "busy", "pending"])("stops deletion and follow-up draft writes after a %s change", async change => {
    const h = harness(true); const asset = h.asset(); h.api.state.assets.image = [asset]; const gate = deferred<void>(); let started = false;
    h.onRead((table, op) => { if (table === "runs" && op === "getAll") { started = true; return gate.promise; } });
    const removing = h.api.removeAsset("image", asset.id); await vi.waitFor(() => expect(started).toBe(true));
    if (change === "account") { h.setAccount("tenant:bob"); h.api.state.accountKey = "tenant:bob"; }
    if (change === "mode") h.api.state.mode = "remix";
    if (change === "draft") h.api.state.assets = { image: [asset], video: [], audio: [] };
    if (change === "edit") h.api.state.prompt = "new draft edit";
    if (change === "starting") Object.assign(h.api.state, { productionStarting: true });
    if (change === "busy") Object.assign(h.api.state, { productionBusy: true });
    if (change === "pending") Object.assign(h.api.state, { actionPending: true });
    const afterChange = JSON.stringify(h.api.draftSnapshot()); gate.resolve(); await removing; h.flushDraftTimer();
    expect(h.deletes).toEqual([]); expect(JSON.stringify(h.api.draftSnapshot())).toBe(afterChange); expect(h.tables.drafts.size).toBe(0);
  });
  it("stops reset after account changes without deleting the current draft", async () => {
    const h = harness(true); h.api.state.assets.image = [h.asset()]; h.tables.drafts.set("direct", { mode: "direct", data: { prompt: "saved" } });
    const gate = deferred<void>(); let started = false;
    h.onRead((table, op) => { if (table === "runs" && op === "getAll") { started = true; return gate.promise; } });
    const resetting = h.api.resetCurrentDraft(); await vi.waitFor(() => expect(started).toBe(true));
    h.api.state.accountKey = "tenant:bob"; h.setAccount("tenant:bob"); gate.resolve(); await resetting;
    expect(h.tables.drafts.get("direct")).toEqual({ mode: "direct", data: { prompt: "saved" } }); expect(h.api.state.assets.image).toHaveLength(1);
  });
  it("does not write a queued draft snapshot after the context changes", async () => {
    const h = harness(true); h.api.scheduleDraftSave(); h.api.state.mode = "remix"; h.flushDraftTimer();
    await Promise.resolve(); expect(h.tables.drafts.size).toBe(0);
  });
  it("checks draft identity again after authentication before saving", async () => {
    const h = harness(true); const auth = deferred<string>(); h.auth.require.mockImplementationOnce(() => auth.promise);
    const saving = h.api.saveCurrentDraft(); await vi.waitFor(() => expect(h.auth.require).toHaveBeenCalled());
    h.api.state.prompt = "new value"; auth.resolve("tenant:alice"); await expect(saving).rejects.toThrow("草稿");
    expect(h.tables.drafts.size).toBe(0);
  });
  it("keeps blobs with an old cached Store rather than using unguarded deletion", async () => {
    const h = harness(true, true); h.api.state.assets.image = [h.asset()];
    await h.api.removeAsset("image", "local-image"); expect(h.deletes).toEqual([]); expect(h.api.state.assets.image).toEqual([]);
  });
  it("replaces a reference while retaining its saved-plan video and frames", async () => {
    const h = harness(true); h.api.state.reference = h.asset("old-reference"); h.api.state.referenceFrames = [h.asset("old-frame")];
    h.tables.runs.set("old", production({ plan: { shots: [{ request: { referenceVideo: { id: "old-reference" }, referenceFrames: [{ id: "old-frame" }] } }] } }));
    await h.api.setReferenceVideo(Object.assign(new Blob(["video"], { type: "video/mp4" }), { name: "replacement.mp4" }));
    expect(h.api.state.reference?.id).not.toBe("old-reference"); expect(h.api.state.referenceFrames).toHaveLength(5);
    expect(h.tables.assets.has("old-reference")).toBe(true); expect(h.tables.assets.has("old-frame")).toBe(true); expect(h.deletes).toEqual([]);
  });
  it("protects a newly referenced video and frame during failed extraction cleanup", async () => {
    const h = harness(true); let puts = 0;
    h.onRead((table, op) => {
      if (table !== "assets" || op !== "put" || ++puts !== 3) return;
      const uploaded = [...h.tables.assets.keys()];
      h.tables.runs.set("old", production({ plan: { request: { images: uploaded.map(id => ({ id })) } } }));
      throw new Error("fixture frame write failure");
    });
    await h.api.setReferenceVideo(Object.assign(new Blob(["video"], { type: "video/mp4" }), { name: "replacement.mp4" }));
    expect(h.api.state.reference).toBeNull(); expect(h.tables.assets.size).toBe(2); expect(h.deletes).toEqual([]);
  });
  it("blocks generation through the post-commit identity check until the source mutation finishes", async () => {
    const h = harness(true); h.api.state.assets.image = [h.asset()];
    Object.assign(h.api.state, { rightsConfirmed: true, rightsConfirmedAt: "2026-10-18T00:00:00Z",
      productionOptions: { mode: "quality", totalDurationSeconds: 15, hybridAiSeconds: 0, budgetYuan: 17, maxAttempts: 1 } });
    Object.assign(h.api.state, { rightsFingerprint: h.api.assetRightsFingerprint() });
    h.api.state.modelCatalog.find(model => model.productKey === "seedance-2.0")!.configured = true;
    const postCommit = deferred<string>(); let calls = 0, waiting = false;
    h.auth.require.mockImplementation(async () => { if (++calls === 3) { waiting = true; return postCommit.promise; } return "tenant:alice"; });
    const removing = h.api.removeAsset("image", "local-image"); await vi.waitFor(() => expect(waiting).toBe(true));
    expect(h.tables.assets.has("local-image")).toBe(false); expect(h.api.state.assets.image).toHaveLength(1);
    expect(h.api.state.sourceMutationPending).toBe(true); expect(h.nodes.get("primary-action")!.disabled).toBe(true);
    await h.api.startProductionGeneration(); await h.api.startGeneration();
    expect(h.runtime).not.toHaveBeenCalled(); expect(h.tables.runs.size).toBe(0);
    postCommit.resolve("tenant:alice"); await removing;
    expect(h.api.state.assets.image).toEqual([]); expect(h.api.state.sourceMutationPending).toBe(false); expect(h.runtime).not.toHaveBeenCalled();
  });
});
