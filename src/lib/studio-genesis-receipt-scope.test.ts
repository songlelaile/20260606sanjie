import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const assetRoot = process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative";
const read = (name: string) => readFileSync(resolve(assetRoot, "labs/image-prompt-lab", name), "utf8");
const owner = "user:scope-owner";
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHe";
const prefix = (scope: string) => `sz_studio_genesis_pending_v2:${owner}:${scope}:`;
const legacyKey = `sz_studio_genesis_pending_v1:${owner}`;
const receipt = (jobId: string, scope?: string) => ({
  jobId, taskId: `${jobId}-task`, shotId: "shot-1", batchId: `${jobId}-batch`, accountKey: owner, createdAt: 100,
  ...(scope ? { receiptVersion: 1, receiptId: "11111111-1111-4111-8111-111111111111", workspaceKey: scope, planSignatureHash: "a".repeat(64) } : {})
});

function frozenLeaf(pack: string, name: string) {
  const marker = `\n;\n/* Frozen source: public/creative/labs/image-prompt-lab/${name} */\n`;
  const text = read(pack), start = text.indexOf(marker);
  if (start < 0) throw new Error(`Missing loaded leaf: ${name}`);
  const from = start + marker.length, to = text.indexOf("\n;\n/* Frozen source:", from);
  return text.slice(from, to < 0 ? undefined : to);
}

function fixture(loaded: boolean) {
  const items = new Map<string, string>();
  const localStorage = {
    get length() { return items.size; }, key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); }
  };
  const ui = loaded ? frozenLeaf("studio-views-20261010-credit-v3.js", "studio-genesis-ui.js") : read("studio-genesis-ui.js");
  const start = ui.indexOf("  function journal(scope=workspaceScope) {"), end = ui.indexOf("  function createWorkspace(", start);
  if (start < 0 || end < 0) throw new Error("Missing production journal function");
  // Execute the actual journal implementation; no replacement storage adapter
  // may accidentally hide the main/ad prefix collision from the controller.
  const context = createContext({ URL, URLSearchParams, setTimeout, clearTimeout, localStorage, account: owner, environment: "", workspaceScope: "single:main" });
  context.window = context;
  runInContext(ui.slice(start, end), context);
  runInContext(loaded ? frozenLeaf("studio-runtime-20261010-credit-v3.js", "studio-genesis-contract.js") : read("studio-genesis-contract.js"), context);
  const api = context.SZ_STUDIO_GENESIS;
  const journal = (scope: string) => context.journal(scope);
  let sequence = 0;
  function controller(scope: string) {
    let account = owner;
    const bridge = {
      getAccountKey: vi.fn(async () => account),
      newJobId: () => `job-${++sequence}`,
      config: () => ({ provider: "fixture", imageModel: "fixture-image" }),
      modelInfo: () => ({ ready: true, supportsReference: true }),
      send: vi.fn(async (type: string): Promise<{ ok: boolean; images: string[] }> => {
        if (type !== "GENERATE_IMAGE") throw new Error(`Unexpected model action: ${type}`);
        return { ok: true, images: [image] };
      }),
      archive: vi.fn(async () => ({ ok: true }))
    };
    const changes = vi.fn(async () => {}), stored = journal(scope);
    const value = api.createController({ bridge, journal: stored, workspaceKey: scope, onChange: changes,
      lock: async (_name: string, run: () => unknown) => run() });
    return { value, bridge, changes, journal: stored, setAccount: (next: string) => { account = next; } };
  }
  function task(name: string, ad = false) {
    const settings = { ...api.defaults("main"), count: 1, imageType: ad ? "ad" : "main" };
    if (ad) Object.assign(settings, { adType: "电商广告", adTemplate: api.adTemplates[0].id });
    const value = { id: name, name, requirements: "保持原产品", products: [{ image, name: "合成测试图", width: 64, height: 64 }], overrides: null, analysis: "", plan: null };
    value.plan = api.createPlan(value, settings);
    expect(value.plan).toMatchObject({ ok: true });
    return { value, settings };
  }
  return { items, journal, controller, task };
}

describe.each([false, true])("studio receipt scope isolation (%s: loaded frozen bytes)", loaded => {
  it.each(["single", "batch"])("reads exact %s main/ad keys and preserves all stored receipts", mode => {
    const f = fixture(loaded), mainScope = `${mode}:main`, adScope = `${mode}:main:ad`;
    const main = receipt("main-job"), ad = receipt("ad-job"), detail = receipt("detail-job");
    f.journal(adScope).write(ad); // Put the colliding ad key first, as in the live failure.
    f.journal(mainScope).write(main);
    f.journal(`${mode}:detail`).write(detail);
    const before = [...f.items];
    expect(f.journal(mainScope).read()).toEqual(main);
    expect(f.journal(mainScope).readAll()).toEqual([main]);
    expect(f.journal(mainScope).readExcluding([main.jobId])).toBeNull();
    expect(f.journal(adScope).read()).toEqual(ad);
    expect(f.journal(adScope).readAll()).toEqual([ad]);
    expect([...f.items]).toEqual(before);
  });

  it("does not adopt a deeper scope when it is the only v2 receipt", () => {
    const f = fixture(loaded), ad = receipt("ad-only");
    f.journal("single:main:ad").write(ad);
    expect(f.journal("single:main").read()).toBeNull();
    expect(f.journal("single:main").readAll()).toEqual([]);
    expect(f.journal("single:main").readReceipt(ad)).toBeNull();
    expect(f.journal("single:main").compareAndClear(ad)).toBe(false);
    expect(f.journal("single:main:ad").readReceipt(ad)).toEqual(ad);
  });

  it("uses the stored job identity rather than imposing a new job-name format", () => {
    const f = fixture(loaded), main = receipt("ad:colon-job");
    f.journal("single:main").write(main);
    expect(f.journal("single:main").readAll()).toEqual([main]);
    expect(f.journal("single:main").readExcluding([main.jobId])).toBeNull();
  });

  it("retains ambiguous legacy receipts and fails closed on damaged own-scope storage", () => {
    const f = fixture(loaded), legacy = receipt("legacy-unknown");
    f.items.set(legacyKey, JSON.stringify(legacy));
    expect(f.journal("single:main").read()).toEqual(legacy);
    expect(f.journal("single:main:ad").read()).toEqual(legacy);
    expect(f.journal("single:main").readAll()).toEqual([legacy]);
    expect(f.items.get(legacyKey)).toBe(JSON.stringify(legacy));
    f.items.delete(legacyKey);
    f.items.set(prefix("single:main") + "damaged", "{not-json");
    expect(() => f.journal("single:main").read()).toThrow(/回执/);
    expect(() => f.journal("single:main").readAll()).toThrow(/回执/);
    expect(f.items.get(prefix("single:main") + "damaged")).toBe("{not-json");
  });

  it.each(["missing-job", "mismatched-job"])("keeps %s v2 records fail-closed instead of hiding unknown receipts", kind => {
    const f = fixture(loaded), value = receipt("unknown-job");
    if (kind === "missing-job") Reflect.deleteProperty(value, "jobId");
    const key = prefix("single:main") + "unverified-job", raw = JSON.stringify(value);
    f.items.set(key, raw);
    expect(() => f.journal("single:main").read()).toThrow(/回执/);
    expect(() => f.journal("single:main").readAll()).toThrow(/回执/);
    expect(f.items.get(key)).toBe(raw);
  });

  it("keeps a completed main result stable while the ad request is actually in flight", async () => {
    const f = fixture(loaded), main = f.controller("single:main"), ad = f.controller("single:main:ad");
    const mainTask = f.task("main-product"), adTask = f.task("ad-product", true);
    expect(await main.value.run([mainTask.value], mainTask.settings)).toMatchObject({ ok: true });
    const completed = main.value.snapshot();
    let finish!: (value: { ok: boolean; images: string[] }) => void, started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    ad.bridge.send.mockImplementation(async () => { started(); return new Promise(resolve => { finish = resolve; }); });
    const running = ad.value.run([adTask.value], adTask.settings);
    await began;
    const adReceipt = clone(ad.journal.read()), before = [...f.items];
    expect(adReceipt).toMatchObject({ taskId: adTask.value.id });
    expect(await main.value.recoverPendingReceipt()).toMatchObject({ ok: true, pending: false, uncertain: false });
    expect(main.value.snapshot()).toEqual(completed);
    expect([...f.items]).toEqual(before);
    expect(main.bridge.send).toHaveBeenCalledTimes(1);
    expect(ad.bridge.send).toHaveBeenCalledTimes(1);
    finish({ ok: true, images: [image] });
    expect(await running).toMatchObject({ ok: true });
    expect(ad.journal.read()).toBeNull();
    expect(await main.value.recoverPendingReceipt()).toMatchObject({ ok: true, pending: false, uncertain: false });
    expect(main.value.snapshot()).toEqual(completed);
    expect(main.bridge.send).toHaveBeenCalledTimes(1);
    expect(ad.bridge.send).toHaveBeenCalledTimes(1);
    expect(main.bridge.archive).toHaveBeenCalledTimes(1);
    expect(ad.bridge.archive).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("reconciles a proven foreign orphan from a restored snapshot (original key present: %s)", async present => {
    const f = fixture(loaded), first = f.controller("single:main"), task = f.task("saved-main");
    await first.value.run([task.value], task.settings);
    const completed = clone(first.value.state.tasks), foreign = receipt("foreign-ad", "single:main:ad");
    first.value.state.pendingReceipts = [clone(foreign)]; first.value.state.uncertain = clone(foreign);
    if (present) f.journal("single:main:ad").write(foreign);
    const before = [...f.items], restored = f.controller("single:main");
    expect(restored.value.restore(first.value.snapshot())).toMatchObject({ ok: true });
    await Promise.resolve(); restored.changes.mockClear();
    expect(await restored.value.recoverPendingReceipt()).toMatchObject({ ok: true, pending: false, uncertain: false });
    expect(restored.value.state.pendingReceipts).toEqual([]);
    expect(restored.value.state.uncertain).toBeNull();
    expect(restored.value.state.tasks).toEqual(completed);
    expect(restored.changes).toHaveBeenCalledTimes(1); // Repaired current-workspace snapshot is persisted.
    expect([...f.items]).toEqual(before); // Never clear, relocate or recreate the foreign original key.
    expect(restored.bridge.send).not.toHaveBeenCalled();
    expect(restored.bridge.archive).not.toHaveBeenCalled();
  });

  it("does not adopt or clear a proven foreign legacy receipt while generating its own image", async () => {
    const f = fixture(loaded), main = f.controller("single:main"), task = f.task("own-product");
    const foreign = receipt("legacy-ad", "single:main:ad"), raw = JSON.stringify(foreign);
    f.items.set(legacyKey, raw);
    expect(await main.value.recoverPendingReceipt()).toMatchObject({ ok: true, pending: false, uncertain: false });
    expect(await main.value.run([task.value], task.settings)).toMatchObject({ ok: true });
    expect(main.value.state.uncertain).toBeNull();
    expect(main.value.state.pendingReceipts).toEqual([]);
    expect(f.items.get(legacyKey)).toBe(raw);
    expect(main.bridge.send).toHaveBeenCalledTimes(1);
    expect(main.bridge.archive).toHaveBeenCalledTimes(1);
  });

  it.each(["legacy", "malformed-scope", "same-scope"])("preserves %s uncertainty when the journal is empty", async kind => {
    const f = fixture(loaded), main = f.controller("single:main");
    const unknown = kind === "legacy" ? receipt("unknown") : receipt("unknown", kind === "same-scope" ? "single:main" : "single:main:ad");
    if (kind === "malformed-scope") Object.assign(unknown, { planSignatureHash: "not-a-valid-hash" });
    main.value.state.accountKey = owner; main.value.state.pendingReceipts = [clone(unknown)]; main.value.state.uncertain = clone(unknown);
    expect(await main.value.recoverPendingReceipt()).toMatchObject({ ok: true, pending: false, uncertain: true });
    expect(main.value.state.pendingReceipts).toEqual([unknown]);
    expect(main.value.state.uncertain).toEqual(unknown);
    expect(main.bridge.send).not.toHaveBeenCalled(); expect(main.bridge.archive).not.toHaveBeenCalled();
    expect(f.items.size).toBe(0);
  });

  it("does not reconcile before the fresh account checks complete", async () => {
    const f = fixture(loaded), main = f.controller("single:main"), foreign = receipt("foreign-ad", "single:main:ad");
    main.value.state.accountKey = owner; main.value.state.pendingReceipts = [clone(foreign)]; main.value.state.uncertain = clone(foreign);
    const before = main.value.snapshot(), read = main.journal.readAll;
    main.journal.readAll = () => { const receipts = read(); main.setAccount("user:other"); return receipts; };
    expect(await main.value.recoverPendingReceipt()).toMatchObject({ ok: false, code: "STUDIO_ACCOUNT_CHANGED" });
    expect(main.value.snapshot()).toEqual(before);
    expect(main.bridge.send).not.toHaveBeenCalled(); expect(main.bridge.archive).not.toHaveBeenCalled();
  });

  it("preserves a foreign-account receipt even if it claims another workspace", async () => {
    const f = fixture(loaded), main = f.controller("single:main");
    const foreign = { ...receipt("foreign-owner", "single:main:ad"), accountKey: "user:other" };
    main.value.state.accountKey = owner; main.value.state.pendingReceipts = [clone(foreign)]; main.value.state.uncertain = clone(foreign);
    const before = main.value.snapshot();
    expect(await main.value.recoverPendingReceipt()).toMatchObject({ ok: false, code: "STUDIO_ACCOUNT_CHANGED" });
    expect(main.value.snapshot()).toEqual(before);
    expect(main.bridge.send).not.toHaveBeenCalled();
  });
});
