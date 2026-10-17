import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const assetRoot = process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative";
const script = readFileSync(resolve(assetRoot, "labs/image-prompt-lab/viral-workflow-bridge.js"), "utf8");
interface Profile { ok: boolean; accountKey?: string; config?: Record<string, unknown>; error?: string }
interface NavigationStatus { allowed: boolean; reason: string }
interface Activation { ok: boolean; code?: string; error?: string; accountKey?: string }
interface Bridge { canDeactivate(): NavigationStatus; activate(): Promise<Activation> }
interface State { archiveAccountKey: string; activeJobId: string; activeJobIds: Record<string, boolean>; styleRefresh: { run: { phase: string } | null }; draft: { name: string; ratio: string; image: string }; results: string[] }
interface ContextAPI { SanjieViralWorkflowBridge?: Bridge; state: State; send(type: string, payload?: unknown): Promise<Profile>; applyCfg(config: Record<string, unknown>): void; fileToOptimizedDataUrl(file?: unknown): Promise<string>; SZ_IMAGE_UPLOAD?: { retainOriginal(): Promise<string>; isImporting(): boolean }; SZ_SCENE_EXTENSION_CONTROLLER?: { state: { busy: boolean; uncertain?: unknown; uploadReading?: number; importReading?: boolean } } }
function deferred<T>() { let finish!: (value: T) => void; let fail!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { finish = yes; fail = no; }); return { promise, finish, fail }; }
function fixture(search = "?mode=viral&creativeRoute=case&workflow=1&source=web&layout=1", withUploads = true) {
  const calls: Array<{ type: string; payload: unknown }> = [], applied: Record<string, unknown>[] = [];
  let importer = false;
  const state: State = { archiveAccountKey: "account:alice", activeJobId: "", activeJobIds: {}, styleRefresh: { run: null }, draft: { name: "original draft", ratio: "3:4", image: "https://fixture.invalid/product.png" }, results: ["original result"] };
  const context = createContext({ URLSearchParams, location: { search }, state, send: (type: string, payload: unknown) => { calls.push({ type, payload }); return Promise.resolve({ ok: true, accountKey: "account:alice", config: { imageModel: "saved-model" } }); }, applyCfg: (config: Record<string, unknown>) => { applied.push(config); }, fileToOptimizedDataUrl: () => Promise.resolve("fixture derivative"), ...(withUploads ? { SZ_IMAGE_UPLOAD: { retainOriginal: () => Promise.resolve("original retained"), isImporting: () => importer } } : {}) });
  const api = context as unknown as ContextAPI;
  const initialSend = context.send;
  runInContext(script, context, { filename: "viral-workflow-bridge.js" });
  return { context, api, state, calls, applied, bridge: api.SanjieViralWorkflowBridge!, initialSend, setImporter: (value: boolean) => { importer = value; }, reload: () => runInContext(script, context) };
}

describe("dedicated viral workflow navigation bridge", () => {
  it.each(["case", "style-refresh", "scene-extension"])("installs only the exact %s workflow and leaves draft/results untouched", (route) => {
    const f = fixture(`?mode=viral&creativeRoute=${route}&workflow=1&source=web&layout=1`);
    expect(f.bridge.canDeactivate().allowed).toBe(true); expect(f.calls).toEqual([]); expect(f.applied).toEqual([]);
    expect(f.state.draft.name).toBe("original draft"); expect(f.state.results).toEqual(["original result"]);
    const sender = f.api.send; f.reload(); expect(f.api.send).toBe(sender);
  });
  it.each(["?mode=viral&source=web&layout=1", "?mode=viral&creativeRoute=case&workflow=1&source=plugin&layout=1", "?mode=viral&creativeRoute=case&workflow=1&source=web", "?mode=detail&creativeRoute=case&workflow=1&source=web&layout=1", "?mode=viral&creativeRoute=unknown&workflow=1&source=web&layout=1", "?mode=viral&creativeRoute=case&workflow=1&source=web&layout=1&studio=1"])("does not touch the old hub or another entry: %s", (query) => {
    const f = fixture(query); expect(f.api.SanjieViralWorkflowBridge).toBeUndefined(); expect(f.api.send).toBe(f.initialSend); expect(f.calls).toHaveLength(0);
  });
  it("refreshes only a saved, matching-owner API profile without touching any business state", async () => {
    const f = fixture(), original = JSON.stringify(f.state);
    const result = await f.bridge.activate(); expect(result).toEqual({ ok: true, accountKey: "account:alice" });
    expect(f.calls).toEqual([{ type: "GET_CONFIG_PROFILE", payload: { provider: "" } }]); expect(f.applied).toEqual([{ imageModel: "saved-model" }]); expect(JSON.stringify(f.state)).toBe(original);
  });
  it("holds activation single-flight and blocks deactivation until the response finishes", async () => {
    const pending = deferred<Profile>(), f = fixture();
    f.api.send = () => pending.promise;
    const first = f.bridge.activate(); expect(f.bridge.activate()).toBe(first); expect(f.bridge.canDeactivate().allowed).toBe(false);
    pending.finish({ ok: true, accountKey: "account:alice", config: {} }); expect((await first).ok).toBe(true); expect(f.bridge.canDeactivate().allowed).toBe(true);
  });
  it.each(["generating", "qa", "qa-retry"])("blocks a running style workflow phase %s and sends no refresh", async (phase) => {
    const f = fixture(); f.state.styleRefresh.run = { phase }; expect(f.bridge.canDeactivate().allowed).toBe(false);
    expect((await f.bridge.activate()).code).toBe("WORKFLOW_BUSY"); expect(f.calls).toHaveLength(0);
  });
  it("blocks active legacy jobs and scene generation/upload/import, while unresolved receipts may remain idle", async () => {
    const f = fixture(); f.state.activeJobIds.job = true; expect(f.bridge.canDeactivate().allowed).toBe(false); f.state.activeJobIds = {};
    f.state.activeJobId = "job"; expect(f.bridge.canDeactivate().allowed).toBe(false); f.state.activeJobId = "";
    f.api.SZ_SCENE_EXTENSION_CONTROLLER = { state: { busy: true } }; expect(f.bridge.canDeactivate().allowed).toBe(false);
    f.api.SZ_SCENE_EXTENSION_CONTROLLER.state = { busy: false, uploadReading: 1 }; expect(f.bridge.canDeactivate().allowed).toBe(false);
    f.api.SZ_SCENE_EXTENSION_CONTROLLER.state = { busy: false, importReading: true }; expect(f.bridge.canDeactivate().allowed).toBe(false);
    f.api.SZ_SCENE_EXTENSION_CONTROLLER.state = { busy: false, uncertain: { jobId: "unconfirmed" } }; expect(f.bridge.canDeactivate().allowed).toBe(true);
    f.setImporter(true); expect(f.bridge.canDeactivate().allowed).toBe(false); expect((await f.bridge.activate()).ok).toBe(false); expect(f.calls).toHaveLength(0);
  });
  it("tracks the real classic-script send binding and preserves response, rejection and synchronous exception semantics", async () => {
    const waiting = deferred<Profile>(), context = createContext({ URLSearchParams, location: { search: "?mode=viral&creativeRoute=case&workflow=1&source=web&layout=1" }, waiting: waiting.promise, state: { archiveAccountKey: "account:alice" }, applyCfg() {} });
    runInContext("function send() { return waiting; }", context); runInContext(script, context);
    const api = context as unknown as ContextAPI, call = runInContext("send('GENERATE_IMAGE')", context) as Promise<Profile>;
    expect(api.SanjieViralWorkflowBridge!.canDeactivate().allowed).toBe(false); const result = { ok: true }; waiting.finish(result); expect(await call).toBe(result); expect(api.SanjieViralWorkflowBridge!.canDeactivate().allowed).toBe(true);
    const rejected = deferred<Profile>(), other = createContext({ URLSearchParams, location: context.location, send: () => rejected.promise }); runInContext(script, other);
    const second = other as unknown as ContextAPI, error = new Error("fixture transport failed"), promise = second.send("ANALYZE_STYLE_REFRESH_QA"); rejected.fail(error); await expect(promise).rejects.toBe(error); expect(second.SanjieViralWorkflowBridge!.canDeactivate().allowed).toBe(true);
    const throwing = createContext({ URLSearchParams, location: context.location, send: () => { throw error; } }); runInContext(script, throwing);
    const third = throwing as unknown as ContextAPI; expect(() => third.send("BUILD_DETAIL_PROMPT")).toThrow(error); expect(third.SanjieViralWorkflowBridge!.canDeactivate().allowed).toBe(true);
  });
  it("blocks local decoding and original retention until their actual promises settle", async () => {
    const reading = deferred<string>(), retention = deferred<string>(), context = createContext({ URLSearchParams, location: { search: "?mode=viral&creativeRoute=case&workflow=1&source=web&layout=1" }, fileToOptimizedDataUrl: () => reading.promise, SZ_IMAGE_UPLOAD: { retainOriginal: () => retention.promise, isImporting: () => false } }); runInContext(script, context);
    const api = context as unknown as ContextAPI, first = api.fileToOptimizedDataUrl(); expect(api.SanjieViralWorkflowBridge!.canDeactivate().allowed).toBe(false);
    const second = api.SZ_IMAGE_UPLOAD!.retainOriginal(); reading.finish("decoded"); expect(await first).toBe("decoded"); expect(api.SanjieViralWorkflowBridge!.canDeactivate().allowed).toBe(false);
    retention.finish("retained"); expect(await second).toBe("retained"); expect(api.SanjieViralWorkflowBridge!.canDeactivate().allowed).toBe(true);
  });
  it("fails closed for a missing initial owner, wrong profile owner or changed owner during refresh", async () => {
    const local = fixture(); local.state.archiveAccountKey = "local"; expect((await local.bridge.activate()).code).toBe("WORKFLOW_NOT_READY"); expect(local.calls).toHaveLength(0);
    const other = fixture(); other.api.send = async () => ({ ok: true, accountKey: "account:bob", config: {} }); expect((await other.bridge.activate()).code).toBe("WORKFLOW_ACCOUNT_CHANGED"); expect(other.applied).toHaveLength(0);
    const changed = fixture(), pending = deferred<Profile>(); changed.api.send = () => pending.promise; const activation = changed.bridge.activate(); changed.state.archiveAccountKey = "account:bob"; pending.finish({ ok: true, accountKey: "account:alice", config: {} }); expect((await activation).ok).toBe(false); expect(changed.applied).toHaveLength(0);
  });
  it("does not apply a returned profile if business becomes busy during the refresh", async () => {
    const f = fixture(), pending = deferred<Profile>(); f.api.send = () => pending.promise; const activation = f.bridge.activate(); f.state.activeJobId = "new-business-job";
    pending.finish({ ok: true, accountKey: "account:alice", config: {} }); expect((await activation).code).toBe("WORKFLOW_BUSY"); expect(f.applied).toHaveLength(0);
  });
  it("keeps failures actionable and supports the production baseline without newer upload helpers", async () => {
    const f = fixture(undefined, false); f.api.send = async () => { throw new Error("fixture profile unavailable"); };
    expect(await f.bridge.activate()).toMatchObject({ ok: false, code: "WORKFLOW_REFRESH_FAILED", error: "fixture profile unavailable" }); expect(f.bridge.canDeactivate().allowed).toBe(true);
    f.api.send = async () => ({ ok: true, accountKey: "account:alice", config: {} }); expect((await f.bridge.activate()).ok).toBe(true);
  });
  it("keeps independent window send responses and job guards separate", async () => {
    const left = fixture(), right = fixture(); left.state.activeJobId = "left-job"; expect(left.bridge.canDeactivate().allowed).toBe(false); expect(right.bridge.canDeactivate().allowed).toBe(true);
    expect((await right.bridge.activate()).ok).toBe(true); expect(right.calls).toHaveLength(1); expect(left.calls).toHaveLength(0); expect(left.applied).toHaveLength(0);
  });
});
