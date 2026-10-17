import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const PRODUCT = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHe";
const OUTPUT = "https://fixture.invalid/returned-image.png";
type Receipt = { jobId: string; taskId: string; shotId: string; accountKey: string; batchId: string; createdAt: number };
type Reply = { ok: boolean; images?: string[]; providerSubmitted?: boolean; definitiveFailure?: boolean; stateUncertain?: boolean; error?: string };
function deferred<T>() {
  let complete!: (value: T) => void;
  const promise = new Promise<T>(resolve => { complete = resolve; });
  return { promise, complete };
}
async function flush() { for (let index = 0; index < 40; index++) await Promise.resolve(); }

function fixture(count = 4, concurrent = true) {
  const context = createContext({ URL, setTimeout, clearTimeout, console }); context.window = context;
  runInContext(readFileSync(resolve(process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative", "labs/image-prompt-lab/studio-genesis-contract.js"), "utf8"), context);
  const api = context.SZ_STUDIO_GENESIS, settings = { ...api.defaults("main"), count };
  const receipts = new Map<string, Receipt>(), replies = new Map<string, ReturnType<typeof deferred<Reply>>>();
  const sent: Array<{ jobId: string; payload: { batchId: string; studioGenesisPlan: { plan: { taskId: string } } } }> = [];
  const archives: Array<{ jobId: string; studioTaskId: string; batchId: string; accountKey: string; url: string }> = [];
  let job = 0, held = false;
  function product(id: string, quantity = count) {
    const task = { id, name: `商品 ${id}`, requirements: "自然光线，保留原商品细节", products: [{ image: PRODUCT, name: "产品", width: 64, height: 64 }],
      overrides: { count: quantity }, analysis: "", plan: null };
    task.plan = api.createPlan(task, { ...settings, count: quantity }); expect(task.plan).toMatchObject({ ok: true });
    return task;
  }
  const read = (excluded: string[] = []) => [...receipts.values()].find(value => !excluded.includes(value.jobId)) || null;
  const journal = { concurrent, read, readAll: () => [...receipts.values()], readExcluding: read, readReceipt: (receipt: Receipt) => receipts.get(receipt.jobId) || null,
    write: vi.fn((receipt: Receipt): unknown => { receipts.set(receipt.jobId, clone(receipt)); return undefined; }), clear: () => {},
    compareAndClear: (receipt: Receipt) => {
      const stored = receipts.get(receipt.jobId);
      if (!stored || ["jobId", "taskId", "shotId", "batchId", "accountKey"].some(key => stored[key as keyof Receipt] !== receipt[key as keyof Receipt])) return false;
      receipts.delete(receipt.jobId); return true;
    } };
  const bridge = { getAccountKey: vi.fn(async () => "owner:alice"), modelInfo: () => ({ ready: true, supportsReference: true }),
    config: () => ({ provider: "fixture", imageModel: "fixture-image" }), newJobId: () => `wait-${++job}`,
    send: vi.fn(async (type: string, message: typeof sent[number]) => {
      expect(type).toBe("GENERATE_IMAGE"); sent.push(message);
      const response = deferred<Reply>(); replies.set(message.jobId, response); return response.promise;
    }), archive: vi.fn(async (item: typeof archives[number]) => { archives.push(clone(item)); return { ok: true }; }) };
  const lock = async (_name: string, work: () => unknown) => {
    if (held) return { ok: false, code: "STUDIO_ALREADY_RUNNING" };
    held = true; try { return await work(); } finally { held = false; }
  };
  const controller = api.createController({ bridge, journal, lock, concurrency: 2, timeoutMs: 30_000 });
  return { api, settings, product, controller, bridge, journal, receipts, replies, sent, archives, lock, held: () => held };
}

describe("ending only the current studio wait", () => {
  it("releases local waiting and queued images while retaining dispatched receipts and original late results", async () => {
    const f = fixture(), original = f.product("original"), first = f.controller.run([original], f.settings);
    await expect.poll(() => f.sent.length).toBe(2);
    const originals = clone([...f.receipts.values()]);
    expect(await f.controller.endWait()).toMatchObject({ ok: true, waitEnded: true, stopped: true, awaitingReceipt: true });
    expect(await first).toMatchObject({ waitEnded: true, uncertain: true });
    expect(f.held()).toBe(false); expect(f.controller.state.busy).toBe(false);
    expect([...f.receipts.values()]).toEqual(originals); expect(f.controller.hasInFlightRequest()).toBe(true);
    expect(f.controller.state.tasks[0].slots.map((slot: { status: string }) => slot.status)).toEqual(["uncertain", "uncertain", "ready", "ready"]);
    expect((await f.controller.retrySlot("original", "shot-1", [original], f.settings)).code).toBe("STUDIO_RECEIPT_PENDING");

    const next = f.product("new-product", 1), fresh = f.controller.run([next], f.settings);
    await expect.poll(() => f.sent.length).toBe(3);
    const currentBatch = f.controller.state.batchId;
    f.replies.get("wait-1")!.complete({ ok: true, images: [OUTPUT] });
    await expect.poll(() => f.archives.length).toBe(1);
    expect(f.controller.state.busy).toBe(true); expect(f.controller.state.batchId).toBe(currentBatch);
    f.replies.get("wait-3")!.complete({ ok: true, images: [OUTPUT + "?new"] }); expect(await fresh).toMatchObject({ ok: true });
    f.replies.get("wait-2")!.complete({ ok: true, images: [OUTPUT + "?original2"] });
    await expect.poll(() => f.controller.hasInFlightRequest()).toBe(false);
    expect(f.receipts.size).toBe(0); expect(f.sent).toHaveLength(3);
    expect(f.archives.filter(item => item.studioTaskId === "original").map(item => item.batchId)).toEqual(originals.map(receipt => receipt.batchId));
    expect(f.archives.find(item => item.jobId === "wait-3")?.studioTaskId).toBe("new-product");
    expect(f.bridge.send.mock.calls.every(call => call[0] === "GENERATE_IMAGE")).toBe(true);
  });

  it("keeps the workspace locked until a sibling reserved receipt write finishes", async () => {
    const f = fixture(), reserved = deferred<void>(), original = f.product("reserved");
    f.journal.write.mockImplementationOnce(receipt => { f.receipts.set(receipt.jobId, clone(receipt)); });
    f.journal.write.mockImplementationOnce(async receipt => { await reserved.promise; f.receipts.set(receipt.jobId, clone(receipt)); });
    const running = f.controller.run([original], f.settings);
    await expect.poll(() => f.sent.length).toBe(1); expect(f.journal.write).toHaveBeenCalledTimes(2);
    let released = false; const ending = f.controller.endWait().then((value: unknown) => { released = true; return value; });
    await flush(); expect(released).toBe(false); expect(f.held()).toBe(true); expect(f.controller.state.busy).toBe(true);
    const another = f.api.createController({ bridge: f.bridge, journal: f.journal, lock: f.lock });
    expect(await another.run([f.product("other-page", 1)], f.settings)).toMatchObject({ ok: false, code: "STUDIO_ALREADY_RUNNING" });
    expect(f.sent).toHaveLength(1);
    reserved.complete(); expect(await ending).toMatchObject({ ok: true, waitEnded: true }); await running; await flush();
    expect(f.held()).toBe(false); expect(f.sent).toHaveLength(1);
    expect([...f.receipts.keys()]).toEqual(["wait-1"]);
    f.replies.get("wait-1")!.complete({ ok: true, images: [OUTPUT] });
    await expect.poll(() => f.receipts.size).toBe(0); expect(f.archives).toHaveLength(1);
  });

  it("ends preparation without a provider request or a receipt and permits a later explicit run", async () => {
    const f = fixture(1), identity = deferred<string>(), original = f.product("preparing", 1);
    f.bridge.getAccountKey.mockImplementationOnce(() => identity.promise);
    const preparing = f.controller.run([original], f.settings), ending = f.controller.endWait();
    await flush(); expect(f.sent).toHaveLength(0); expect(f.journal.write).not.toHaveBeenCalled();
    identity.complete("owner:alice"); expect(await ending).toMatchObject({ ok: true, waitEnded: true }); await preparing;
    expect(f.receipts.size).toBe(0); expect(f.controller.state.busy).toBe(false);
    const next = f.controller.run([original], f.settings); await expect.poll(() => f.sent.length).toBe(1);
    f.replies.get("wait-1")!.complete({ ok: true, images: [OUTPUT] }); expect(await next).toMatchObject({ ok: true });
  });

  it("keeps repeated end-wait calls idempotent and does not discard a returned unknown receipt", async () => {
    const f = fixture(1), running = f.controller.run([f.product("repeat", 1)], f.settings);
    await expect.poll(() => f.sent.length).toBe(1);
    await Promise.all([f.controller.endWait(), f.controller.endWait()]); await running;
    expect(await f.controller.endWait()).toMatchObject({ ok: true, skipped: true, awaitingReceipt: true });
    f.replies.get("wait-1")!.complete({ ok: false, stateUncertain: true, providerSubmitted: true, error: "result not confirmed" });
    await expect.poll(() => f.controller.hasInFlightRequest()).toBe(false);
    expect([...f.receipts.keys()]).toEqual(["wait-1"]); expect(f.archives).toHaveLength(0); expect(f.sent).toHaveLength(1);
    expect(f.controller.state.tasks[0].slots[0].status).toBe("uncertain");
  });

  it("does not turn an account preparation failure into a successful end-wait result", async () => {
    const f = fixture(1), identity = deferred<string>();
    f.bridge.getAccountKey.mockImplementationOnce(() => identity.promise);
    const running = f.controller.run([f.product("missing-account", 1)], f.settings), ending = f.controller.endWait();
    identity.complete("");
    expect(await ending).toMatchObject({ ok: false, code: "STUDIO_ACCOUNT_REQUIRED" }); await running;
    expect(f.sent).toHaveLength(0); expect(f.receipts.size).toBe(0);
  });

  it("retains the legacy account lock after local waiting ends until the actual reply is consumed", async () => {
    const f = fixture(1, false), original = f.product("legacy", 1), running = f.controller.run([original], f.settings);
    await expect.poll(() => f.sent.length).toBe(1);
    await f.controller.endWait(); await running;
    expect(f.controller.state.busy).toBe(false); expect(f.held()).toBe(true);
    expect((await f.controller.run([f.product("legacy-next", 1)], f.settings)).code).toBe("STUDIO_RECEIPT_PENDING");
    f.replies.get("wait-1")!.complete({ ok: true, images: [OUTPUT] });
    await expect.poll(() => f.held()).toBe(false); expect(f.receipts.size).toBe(0);
  });
});
