import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const assetRoot = process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative";
const IMAGE = "data:image/png;base64,iVBORw0KGgo=";
const OUTPUT = "data:image/png;base64,b3V0cHV0";
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
interface SceneConfig { materialName: string; sameMaterialConfirmed: boolean; shots: string[]; count: number; ratio: string; resolution: string; category?: string; scene?: string; [key: string]: unknown }
interface SceneInput { config: SceneConfig; images: Array<{ role: string; image: string }> }
interface Shot { id: string; kind: string; label: string; prompt: string; angleIndex: number }
interface Plan { ok: boolean; code?: string; error?: string; config: SceneConfig; images: SceneInput["images"]; signature: string; shots: Shot[] }
interface Evidence { index: number; angle: string; label: string; image?: string }
interface Payload { productImages: string[]; productImage: string; productImageEvidence: Evidence[]; prompt: string; sceneConfig: SceneConfig; sceneShotId: string; scenePlanSignature: string; sceneTransportVersion: string; count: number; [key: string]: unknown }
interface Check { ok: boolean; code?: string; error?: string; payload?: Payload }
interface Contract { version: string; maxImageBytes: number; maxRequestBytes: number; createPlan(input: SceneInput): Plan; createPayload(plan: Plan, shotId: string): Payload; validatePayload(payload: unknown): Check; payloadBytes(payload: unknown): number; checkPayloadBudget(payload: unknown): Check }
interface Config { imageEndpoint: string; imageModel: string; nested: { setting: string }; [key: string]: unknown }
interface Message { jobId?: string; config?: Config; payload?: Payload }
interface ProviderResponse { ok: boolean; images?: string[]; code?: string; error?: string; definitiveFailure?: boolean; stateUncertain?: boolean }
interface Receipt { ownerKey: string; jobId: string; status: string; result?: { url: string }; [key: string]: unknown }
interface Item { jobId: string; url: string; resultId: string; productImages: string[]; [key: string]: unknown }
interface ArchiveContext { accountKey: string; surfaceMode?: string; [key: string]: unknown }
interface Slot { status: string; item: Item | null; ownerKey?: string; archiveOk?: boolean; archiveError?: string; shot: Shot }
interface State { slots: Slot[]; previousResults: Slot[]; plan: Plan | null; busy: boolean; ready: boolean; stopped: boolean; uncertain: Receipt | null; ownerKey: string; message: string }
interface RunResult { ok: boolean; code?: string; uncertain?: boolean; completed?: number }
interface Journal { read(owner: string): Receipt | null; write(receipt: Receipt, owner: string): void; clear(owner: string): void }
interface Deps { contract: Contract; readInput(): SceneInput; ready(): Promise<{ ok: boolean; error?: string }>; getAccountKey(): Promise<string>; withGenerationLock?: (owner: string, run: () => Promise<RunResult>) => Promise<RunResult>; config(): Config; archiveContext(): ArchiveContext; send(type: string, message: Message): Promise<ProviderResponse>; archive(item: Item, context: ArchiveContext): Promise<{ ok: boolean; error?: string }>; newJobId(): string; journal: Journal; unregister?: (jobId: string) => void }
interface Controller { state: State; ready(): Promise<string>; buildPlan(): Plan; generate(): Promise<RunResult>; stop(): Promise<ProviderResponse>; retryArchive(slot: Slot): Promise<{ ok: boolean }>; resolveUncertain(): Promise<{ ok: boolean }> }
interface UI { create(deps: Deps): Controller; mount(root: unknown): Controller | undefined }
function api() {
  const context = createContext({ URL, TextEncoder, console });
  for (const name of ["scene-extension-contract.js", "scene-extension-ui.js"]) runInContext(readFileSync(resolve(assetRoot, "labs/image-prompt-lab", name), "utf8"), context, { filename: name });
  return { contract: context.SZ_SCENE_EXTENSION_CONTRACT as Contract, ui: context.SZ_SCENE_EXTENSION_UI as UI };
}
function input(count = 2): SceneInput {
  return { config: { materialName: "合成测试产品", sameMaterialConfirmed: true, shots: count === 1 ? ["macro"] : ["macro", "near"], count, ratio: "3:4", resolution: "2K", scene: "中性陈列空间" }, images: [{ role: "front", image: IMAGE }, { role: "detail", image: "https://fixture.invalid/detail.png" }] };
}
function deferred<T>() { let complete!: (value: T) => void; const promise = new Promise<T>((resolvePromise) => { complete = resolvePromise; }); return { promise, complete }; }
function fixture(options: Partial<Deps> = {}, sharedJournal = new Map<string, Receipt>()) {
  const { contract, ui } = api();
  let owner = "account:alice", serial = 0, archiveFails = false;
  const current = input(), config: Config = { imageEndpoint: "https://fixture.invalid/images", imageModel: "fixture-model", nested: { setting: "frozen" } };
  const submitted: Array<{ type: string; message: Message }> = [], archived: Array<{ item: Item; context: ArchiveContext }> = [];
  const journal: Journal = { read: (key) => clone(sharedJournal.get(key) || null), write: (receipt, key) => { sharedJournal.set(key, clone(receipt)); }, clear: (key) => { sharedJournal.delete(key); } };
  const deps: Deps = { contract, readInput: () => current, ready: async () => ({ ok: true }), getAccountKey: async () => owner,
    withGenerationLock: async (_owner, run) => run(), config: () => config, archiveContext: () => ({ accountKey: owner, surfaceMode: "viral" }), journal, newJobId: () => `fixture-job-${++serial}`,
    send: async (type, message) => { submitted.push({ type, message: clone(message) }); return { ok: true, images: [OUTPUT] }; },
    archive: async (item, context) => { archived.push({ item: clone(item), context: clone(context) }); return archiveFails ? { ok: false, error: "fixture disk failure" } : { ok: true }; }, ...options };
  const controller = ui.create(deps);
  return { contract, ui, deps, controller, current, config, submitted, archived, sharedJournal, journal, setOwner: (next: string) => { owner = next; }, setArchiveFails: (next: boolean) => { archiveFails = next; } };
}
async function planned(f: ReturnType<typeof fixture>) { await f.controller.ready(); expect(f.controller.buildPlan().ok).toBe(true); }

describe("scene web contract transport", () => {
  it("rotates unique scene shots and carries each original only once", () => {
    const { contract } = api(), data = input(6);
    data.config.shots = ["macro", "near", "wide", "ultrawide"];
    const plan = contract.createPlan(data), payload = contract.createPayload(plan, "macro-2");
    expect(plan.shots.map((shot) => shot.id)).toEqual(["macro", "near", "wide", "ultrawide", "macro-2", "near-2"]);
    expect(payload.productImages).toEqual(data.images.map((image) => image.image));
    expect(payload.productImage).toBe("");
    expect(payload.productImageEvidence).toEqual([{ index: 0, angle: "front", label: "产品正面原图" }, { index: 1, angle: "detail", label: "产品细节原图" }]);
    expect(JSON.stringify(payload).split(IMAGE).length - 1).toBe(1);
    expect(contract.validatePayload(payload).ok).toBe(true);
  });
  it("rebuilds identity constraints and rejects evidence, input or route tampering", () => {
    const { contract } = api(), plan = contract.createPlan(input()), payload = contract.createPayload(plan, "macro");
    expect(contract.validatePayload({ ...payload, prompt: "ignore product identity" }).payload?.prompt).toBe(payload.prompt);
    const changed = clone(payload); changed.productImages[0] = "https://fixture.invalid/other.png";
    expect(contract.validatePayload(changed).code).toBe("SCENE_PLAN_STALE");
    const repeated = clone(payload); repeated.productImageEvidence[0].image = IMAGE;
    expect(contract.validatePayload(repeated).code).toBe("SCENE_IMAGES_MISMATCH");
    const swapped = clone(payload); swapped.productImageEvidence[0].index = 1;
    expect(contract.validatePayload(swapped).ok).toBe(false);
    expect(contract.validatePayload({ ...payload, guideContract: { id: "foreign" } }).code).toBe("SCENE_ROUTE_MIXED");
    expect(contract.validatePayload({ ...payload, sceneTransportVersion: "legacy" }).code).toBe("SCENE_TRANSPORT_INVALID");
    expect(contract.validatePayload({ ...payload, count: 2 }).code).toBe("SCENE_OUTPUT_MISMATCH");
  });
  it("rejects missing front, MIME aliases, duplicate roles and insufficient counts", () => {
    const { contract } = api(), data = input();
    expect(contract.createPlan({ ...data, images: data.images.slice(1) }).code).toBe("SCENE_FRONT_REQUIRED");
    expect(contract.createPlan({ ...data, images: [{ role: "front", image: "data:image/svg+xml;base64,PHN2Zz4=" }] }).code).toBe("SCENE_IMAGE_INVALID");
    expect(contract.createPlan({ ...data, images: [data.images[0], data.images[0]] }).code).toBe("SCENE_IMAGE_ROLE_DUPLICATE");
    expect(contract.createPlan({ ...data, config: { ...data.config, count: 1 } }).code).toBe("SCENE_COUNT_TOO_SMALL");
    expect(contract.createPlan({ ...data, config: { ...data.config, count: 21 } }).code).toBe("SCENE_COUNT_INVALID");
    expect(contract.createPlan({ ...data, config: { ...data.config, sameMaterialConfirmed: false } }).code).toBe("SCENE_SAME_MATERIAL_REQUIRED");
  });
  it("enforces actual UTF-8 request bytes at the exact 24 MiB boundary", () => {
    const { contract } = api(), overhead = contract.payloadBytes({ text: "" });
    const boundary = { text: "a".repeat(contract.maxRequestBytes - overhead) };
    expect(contract.payloadBytes(boundary)).toBe(contract.maxRequestBytes);
    expect(contract.checkPayloadBudget(boundary).ok).toBe(true);
    expect(contract.checkPayloadBudget({ text: boundary.text + "a" }).code).toBe("SCENE_REQUEST_TOO_LARGE");
    expect(contract.payloadBytes({ text: "中文😀" })).toBe(Buffer.byteLength(JSON.stringify({ text: "中文😀" })));
  });
  it("reserves provider headroom by limiting total encoded references to 16 MiB", () => {
    const { contract } = api(), data = input();
    data.images = [{ role: "front", image: "data:image/png;base64," + "A".repeat(contract.maxImageBytes) }];
    expect(contract.createPlan(data).code).toBe("SCENE_IMAGE_BUDGET");
  });
});

describe("scene account and request controller", () => {
  it("blocks failed readiness, absent account and missing cross-tab lock", async () => {
    for (const options of [{ ready: async () => ({ ok: false, error: "fixture not ready" }) }, { getAccountKey: async () => "" }, { withGenerationLock: undefined }]) {
      const f = fixture(options); await planned(f); expect((await f.controller.generate()).ok).toBe(false);
      expect(f.submitted).toHaveLength(0); expect(f.sharedJournal.size).toBe(0);
    }
  });
  it("checks the account again after acquiring the lock and after saving the receipt", async () => {
    const locked = fixture(); locked.deps.withGenerationLock = async (_owner, run) => { locked.setOwner("account:bob"); return run(); };
    await planned(locked); expect((await locked.controller.generate()).code).toBe("SCENE_ACCOUNT_CHANGED"); expect(locked.submitted).toHaveLength(0);
    const journaled = fixture(); journaled.deps.journal.write = (receipt, key) => { journaled.sharedJournal.set(key, clone(receipt)); journaled.setOwner("account:bob"); };
    await planned(journaled); await journaled.controller.generate(); expect(journaled.submitted).toHaveLength(0); expect(journaled.sharedJournal.size).toBe(0);
  });
  it("freezes config and plan while each next provider request checks the current owner", async () => {
    const f = fixture(); await planned(f);
    let calls = 0;
    f.deps.send = async (type, message) => {
      expect(type).toBe("GENERATE_IMAGE"); expect(Object.isFrozen(message.config)).toBe(true); expect(Object.isFrozen(message.config?.nested)).toBe(true);
      f.submitted.push({ type, message: clone(message) }); calls++;
      f.config.imageModel = "changed-after-submit"; f.current.config.scene = "new scene";
      return { ok: true, images: [OUTPUT] };
    };
    expect((await f.controller.generate()).ok).toBe(true); expect(calls).toBe(2);
    expect(f.submitted.map((entry) => entry.message.config?.imageModel)).toEqual(["fixture-model", "fixture-model"]);
    expect(f.submitted.every((entry) => entry.message.payload?.sceneConfig.scene === "中性陈列空间")).toBe(true);
  });
  it("keeps a late successful result under the original owner then stops for an account change", async () => {
    const f = fixture(); await planned(f);
    f.deps.send = async (type, message) => { f.submitted.push({ type, message: clone(message) }); f.setOwner("account:bob"); return { ok: true, images: [OUTPUT] }; };
    await f.controller.generate(); expect(f.submitted).toHaveLength(1);
    expect(f.archived[0].context.accountKey).toBe("account:alice"); expect(f.controller.state.slots[0].item?.url).toBe(OUTPUT);
    expect(f.controller.state.slots[1].item).toBe(null); expect(f.sharedJournal.size).toBe(0);
  });
  it("refuses POST if journaling fails or the complete request exceeds the proxy limit", async () => {
    const f = fixture({ journal: { read: () => null, clear: () => {}, write: () => { throw new Error("fixture quota"); } } });
    await planned(f); await f.controller.generate(); expect(f.submitted).toHaveLength(0);
    const large = fixture(); await planned(large); large.config.extra = "x".repeat(large.contract.maxRequestBytes);
    expect((await large.controller.generate()).code).toBe("SCENE_REQUEST_TOO_LARGE"); expect(large.submitted).toHaveLength(0); expect(large.sharedJournal.size).toBe(0);
  });
  it("preserves an unknown provider receipt and requires explicit resolution before retry", async () => {
    const f = fixture(); await planned(f);
    f.deps.send = async (type, message) => { f.submitted.push({ type, message: clone(message) }); throw new Error("fixture disconnected after POST"); };
    expect((await f.controller.generate()).uncertain).toBe(true); expect(f.sharedJournal.get("account:alice")?.status).toBe("pending");
    await f.controller.generate(); expect(f.submitted).toHaveLength(1);
    const reopened = fixture({}, f.sharedJournal); await planned(reopened); expect(reopened.controller.state.uncertain?.ownerKey).toBe("account:alice");
    await reopened.controller.generate(); expect(reopened.submitted).toHaveLength(0);
    await f.controller.resolveUncertain(); f.deps.send = async (type, message) => { f.submitted.push({ type, message: clone(message) }); return { ok: true, images: [OUTPUT] }; };
    expect((await f.controller.generate()).ok).toBe(true); expect(f.submitted).toHaveLength(3); expect(f.sharedJournal.size).toBe(0);
  });
  it("isolates pending journals by owner", async () => {
    const journal = new Map<string, Receipt>([["account:alice", { ownerKey: "account:alice", jobId: "old", status: "pending" }]]);
    const f = fixture({ getAccountKey: async () => "account:bob" }, journal); await planned(f);
    expect(f.controller.state.uncertain).toBe(null); expect((await f.controller.generate()).ok).toBe(true);
    expect(journal.get("account:alice")?.jobId).toBe("old"); expect(f.archived.every((entry) => entry.context.accountKey === "account:bob")).toBe(true);
  });
  it("re-reads same-owner pending state before any new run", async () => {
    const f = fixture(); await planned(f);
    f.sharedJournal.set("account:alice", { ownerKey: "account:alice", jobId: "another-pending-job", status: "pending" });
    expect((await f.controller.generate()).uncertain).toBe(true); expect(f.submitted).toHaveLength(0);
    expect(f.sharedJournal.get("account:alice")?.jobId).toBe("another-pending-job");
  });
  it("preserves receipts when a fresh account read fails between journal and POST", async () => {
    const f = fixture(); await planned(f); let failed = false;
    f.deps.getAccountKey = async () => { if (failed) throw new Error("fixture profile offline"); return "account:alice"; };
    f.deps.journal.write = (receipt, owner) => { f.sharedJournal.set(owner, clone(receipt)); failed = true; };
    expect((await f.controller.generate()).uncertain).toBe(true); expect(f.submitted).toHaveLength(0);
    const receipt = clone(f.sharedJournal.get("account:alice")); failed = false;
    expect((await f.controller.generate()).uncertain).toBe(true); expect(f.sharedJournal.get("account:alice")).toEqual(receipt); expect(f.submitted).toHaveLength(0);
  });
  it("does not overwrite a pending receipt after an unexpected post-response exception", async () => {
    const f = fixture({ unregister: () => { throw new Error("fixture UI cleanup failed"); } }); await planned(f);
    expect((await f.controller.generate()).uncertain).toBe(true); expect(f.submitted).toHaveLength(1);
    const receipt = clone(f.sharedJournal.get("account:alice")); await f.controller.generate();
    expect(f.submitted).toHaveLength(1); expect(f.sharedJournal.get("account:alice")).toEqual(receipt);
  });
  it("records definite rejection without turning it into an unknown receipt", async () => {
    const f = fixture(); await planned(f);
    f.deps.send = async (type, message) => { f.submitted.push({ type, message: clone(message) }); return { ok: false, code: "SCENE_BOUND_REFERENCE_REQUIRED", error: "fixture reference not supported", definitiveFailure: true }; };
    const result = await f.controller.generate(); expect(result.uncertain).toBe(false); expect(f.controller.state.slots[0].status).toBe("failed"); expect(f.sharedJournal.size).toBe(0);
  });
  it("cancels only the current job, preserves late success and skips later shots", async () => {
    const f = fixture(), waiting = deferred<ProviderResponse>(), started = deferred<void>(); await planned(f);
    f.deps.send = async (type, message) => { f.submitted.push({ type, message: clone(message) }); if (type === "GENERATE_IMAGE") { started.complete(); return waiting.promise; } return { ok: true }; };
    const run = f.controller.generate(); expect(f.controller.generate()).toBe(run); await started.promise;
    await f.controller.stop(); waiting.complete({ ok: true, images: [OUTPUT] }); await run;
    expect(f.submitted.map((entry) => entry.type)).toEqual(["GENERATE_IMAGE", "CANCEL_GENERATION"]);
    expect(f.submitted[1].message.jobId).toBe(f.submitted[0].message.jobId); expect(f.archived).toHaveLength(1); expect(f.sharedJournal.size).toBe(0);
    const savedId = f.archived[0].item.resultId;
    expect((await f.controller.generate()).ok).toBe(true);
    expect(f.submitted.filter((entry) => entry.type === "GENERATE_IMAGE")).toHaveLength(2);
    expect(f.archived).toHaveLength(2); expect(f.archived[0].item.resultId).toBe(savedId);
  });
  it("holds the shared lock through provider and archive and rejects a second controller", async () => {
    let held = false;
    const lock = async (_owner: string, run: () => Promise<RunResult>) => { if (held) throw new Error("fixture lock occupied"); held = true; try { return await run(); } finally { held = false; } };
    const waiting = deferred<ProviderResponse>(), started = deferred<void>(), f = fixture({ withGenerationLock: lock }), other = fixture({ withGenerationLock: lock });
    await planned(f); await planned(other); f.deps.send = async () => { started.complete(); return waiting.promise; };
    const run = f.controller.generate(); await started.promise; expect((await other.controller.generate()).ok).toBe(false); expect(other.submitted).toHaveLength(0);
    waiting.complete({ ok: true, images: [OUTPUT] }); await run; expect(held).toBe(false);
  });
  it("keeps an archive failure pending and retries only the exact successful original", async () => {
    const f = fixture(); await planned(f); f.setArchiveFails(true);
    expect((await f.controller.generate()).uncertain).toBe(true); expect(f.submitted).toHaveLength(1); expect(f.sharedJournal.get("account:alice")?.status).toBe("returned");
    const slot = f.controller.state.slots[0]; f.setOwner("account:bob"); f.setArchiveFails(false);
    f.sharedJournal.set("account:bob", { ownerKey: "account:bob", jobId: "other-account-job", status: "pending" });
    const one = f.controller.retryArchive(slot), two = f.controller.retryArchive(slot); expect(two).toBe(one); expect((await one).ok).toBe(true);
    expect(f.submitted).toHaveLength(1); expect(f.archived[1].item.resultId).toBe(f.archived[0].item.resultId); expect(f.archived[1].item.url).toBe(OUTPUT);
    expect(f.archived[1].context.accountKey).toBe("account:alice"); expect(f.sharedJournal.has("account:alice")).toBe(false); expect(f.sharedJournal.get("account:bob")?.jobId).toBe("other-account-job");
  });
  it("treats receipt-clear failure as unresolved even after successful archive", async () => {
    const f = fixture(); await planned(f); f.deps.journal.clear = () => { throw new Error("fixture receipt clear denied"); };
    expect((await f.controller.generate()).uncertain).toBe(true); expect(f.submitted).toHaveLength(1);
    expect(f.sharedJournal.get("account:alice")?.status).toBe("returned"); await f.controller.generate(); expect(f.submitted).toHaveLength(1);
    f.deps.journal.clear = (owner) => { f.sharedJournal.delete(owner); };
    expect((await f.controller.retryArchive(f.controller.state.slots[0])).ok).toBe(true); expect(f.sharedJournal.size).toBe(0); expect(f.submitted).toHaveLength(1);
  });
});

describe("scene mount isolation", () => {
  it("does not initialize scene account, journal or bridge on main/detail/SKU surfaces", () => {
    const { ui } = api();
    for (const mode of ["main-lab-mode", "detail-lab-mode", "sku-lab-mode", ""]) {
      const root = { document: { getElementById: () => ({}), body: { classList: { contains: (name: string) => name === mode } } } };
      Object.defineProperty(root, "SZ_SCENE_EXTENSION_BRIDGE", { get: () => { throw new Error("scene bridge must not be touched on other surfaces"); } });
      expect(ui.mount(root)).toBeUndefined();
    }
  });
  it("limits unresolved scene and upload locks to the active route while a running job locks every route", async () => {
    const { contract, ui } = api(), elements = new Map<string, Element>(), handlers = new Map<string, Array<() => void>>(), classes = new Set(["viral-lab-mode", "scene-extension-route"]), busy: boolean[] = [];
    class Element {
      value = ""; checked = false; hidden = false; disabled = false; type = ""; textContent = ""; dataset: Record<string, string> = {}; children: Element[] = []; isConnected = true;
      classList = { add() {}, remove() {} };
      constructor(id: string) { this.hidden = id === "sceneCompareModal"; this.checked = /^sceneShot/.test(id) && !id.includes("Ultrawide"); this.value = ({ sceneCount: "3", sceneRatio: "3:4", sceneResolution: "2K" } as Record<string, string>)[id] || ""; }
      addEventListener() {} removeAttribute() {} setAttribute() {} focus() {}
      replaceChildren(...nodes: Element[]) { this.children = nodes; } appendChild(node: Element) { this.children.push(node); }
    }
    const node = (id: string) => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id)!; };
    const storage = new Map<string, string>([["sz_scene_extension_web_pending_v1:account%3Aalice", JSON.stringify({ ownerKey: "account:alice", jobId: "old", status: "pending" })]]);
    const root = { document: { body: { classList: { contains: (name: string) => classes.has(name), add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) } }, getElementById: node, createElement: (tag: string) => new Element(tag), addEventListener: (name: string, handler: () => void) => { handlers.set(name, [...(handlers.get(name) || []), handler]); } },
      SZ_SCENE_EXTENSION_CONTRACT: contract, SZ_SCENE_EXTENSION_BRIDGE: { ready: async () => ({ ok: true }), getAccountKey: async () => "account:alice", withGenerationLock: async (_owner: string, run: () => Promise<RunResult>) => run(), config: () => ({}), archiveContext: () => ({}), newJobId: () => "never", send: () => { throw new Error("no business calls while mounting"); }, archive: () => { throw new Error("no archive while mounting"); }, setApiBusy: (_route: string, value: boolean) => busy.push(value) },
      sessionStorage: { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }, addEventListener() {} };
    const controller = ui.mount(root)!; await controller.ready(); expect(busy.at(-1)).toBe(true);
    classes.delete("scene-extension-route"); for (const handler of handlers.get("scene-extension-route-change") || []) handler(); expect(busy.at(-1)).toBe(false);
    expect(controller.state.uncertain?.jobId).toBe("old"); controller.state.busy = true;
    for (const handler of handlers.get("scene-extension-route-change") || []) handler(); expect(busy.at(-1)).toBe(true);
    expect(ui.mount(root)).toBe(controller);
  });
});
