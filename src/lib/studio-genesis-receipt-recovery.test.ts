import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const assetRoot = process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative";
const source = readFileSync(resolve(assetRoot, "labs/image-prompt-lab/studio-genesis-contract.js"), "utf8");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const owner = "user:receipt-owner";
type ProviderResponse = { ok: boolean; images?: string[]; definitiveFailure?: boolean; error?: string };
const identity = (receipt: Record<string, unknown>) => Object.fromEntries(["jobId", "taskId", "shotId", "batchId", "accountKey"].map(key => [key, receipt[key]]));
const image = (marker: number) => {
  const bytes = Buffer.alloc(32);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(64, 16); bytes.writeUInt32BE(64, 20); bytes[26] = marker;
  return `data:image/png;base64,${bytes.toString("base64")}`;
};
function engine() {
  const context = createContext({ URL, setTimeout, clearTimeout }); context.window = context;
  runInContext(source, context);
  return context.SZ_STUDIO_GENESIS;
}
function fixture(api = engine()) {
  let current: string | undefined = owner, pending: Record<string, unknown> | null = null;
  let reads = 0, clears = 0;
  const submitted: unknown[] = [], archived: unknown[] = [];
  const bridge = {
    getAccountKey: async () => current,
    config: () => ({ provider: "fixture", imageModel: "fixture-image" }),
    modelInfo: () => ({ ready: true, supportsReference: true }),
    send: async (_type: string, message: unknown): Promise<ProviderResponse> => { submitted.push(clone(message)); return { ok: true, images: [image(submitted.length + 10)] }; },
    archive: async (item: unknown) => { archived.push(clone(item)); return { ok: true }; }
  };
  const journal = {
    read: (): Record<string, unknown> | null | Promise<Record<string, unknown> | null> => { reads++; return pending; },
    write: (receipt: Record<string, unknown>) => { pending = clone(receipt); },
    clear: () => { clears++; pending = null; }
  };
  const controller = api.createController({ bridge, journal, lock: async (_name: string, run: () => unknown) => run() });
  const settings = { ...api.defaults("detail"), count: 16 };
  const task = { id: "receipt-product", name: "离线回执商品", requirements: "保持同款产品", products: [{ image: image(1), name: "正面", width: 64, height: 64 }], overrides: null, analysis: "", plan: null };
  task.plan = api.createPlan(task, settings);
  return { api, controller, bridge, journal, task, settings, submitted, archived, pending: () => pending, reads: () => reads, clears: () => clears, setAccount: (key?: string) => { current = key; } };
}
async function interruptedSnapshot() {
  const f = fixture();
  let finish!: (response: { ok: boolean; definitiveFailure: boolean; error: string }) => void;
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const send = f.bridge.send;
  f.bridge.send = async (type, message) => {
    if (f.submitted.length !== 11) return send(type, message);
    f.submitted.push(clone(message)); started();
    return new Promise(resolve => { finish = resolve; });
  };
  const running = f.controller.run([f.task], f.settings);
  await began;
  const saved = f.controller.snapshot(), receipt = clone(f.pending()!);
  await f.controller.stop(); finish({ ok: false, definitiveFailure: true, error: "离线 fixture 清理" }); await running;
  const restored = fixture(f.api);
  restored.journal.write(receipt);
  expect(restored.controller.restore(saved)).toMatchObject({ ok: true });
  return { f: restored, saved, receipt };
}
function localReceipt(f: ReturnType<typeof fixture>) {
  const receipt = { jobId: "original-job", taskId: f.task.id, shotId: "shot-1", batchId: "original-batch", accountKey: owner, createdAt: 100 };
  f.controller.state.accountKey = owner;
  f.controller.state.batchId = receipt.batchId;
  f.controller.state.uncertain = clone(receipt);
  f.journal.write(receipt);
  return receipt;
}

describe("studio restored receipt identity and public recovery API", () => {
  it("restores an in-flight twelfth slot and resolves directly without resubmission or loss of eleven originals", async () => {
    const { f, saved, receipt } = await interruptedSnapshot();
    expect(saved.tasks[0].slots[11].status).toBe("generating");
    expect(f.controller.state.uncertain).toMatchObject(identity(receipt));
    expect(f.controller.state.busy).toBe(false);
    expect(f.controller.state.jobId).toBe("");
    const originals = clone(saved.tasks[0].slots.slice(0, 11));
    expect(await f.controller.resolveUncertain({ confirmed: true })).toMatchObject({ ok: true });
    expect(f.pending()).toBeNull();
    expect(f.controller.state.uncertain).toBeNull();
    expect(f.controller.state.tasks[0].slots.slice(0, 11)).toEqual(originals);
    expect(f.controller.state.tasks[0].slots[11].status).toBe("failed");
    expect(f.controller.state.tasks[0].slots.slice(12).every((slot: { status: string }) => slot.status === "ready")).toBe(true);
    expect(f.submitted).toHaveLength(0); expect(f.archived).toHaveLength(0);
  });

  it("fills an old snapshot's missing job identity from the actual journal before explicit resolution", async () => {
    const { f, saved, receipt } = await interruptedSnapshot();
    saved.jobId = ""; saved.uncertain = null;
    f.controller.restore(saved);
    expect(f.controller.state.uncertain.jobId).toBeUndefined();
    expect(await f.controller.recoverPendingReceipt()).toMatchObject({ ok: true, pending: true, uncertain: true, accountKey: owner, matchesCurrentTask: true, receipt });
    expect(f.pending()).toEqual(receipt); expect(f.clears()).toBe(0);
    expect(f.controller.state.uncertain).toEqual(receipt);
    expect((await f.controller.resolveUncertain({ confirmed: true })).ok).toBe(true);
    expect(f.submitted).toHaveLength(0);
  });

  it.each(["jobId", "taskId", "shotId", "batchId", "accountKey"])("refuses to clear a journal whose %s changed after the displayed receipt", async field => {
    const f = fixture(), receipt = localReceipt(f), replacement = { ...receipt, [field]: "replacement" };
    f.journal.write(replacement);
    expect(await f.controller.resolveUncertain({ confirmed: true })).toMatchObject({ ok: false, code: "STUDIO_RECEIPT_CHANGED" });
    expect(f.pending()).toEqual(replacement); expect(f.clears()).toBe(0);
    expect(f.controller.state.uncertain).toEqual(receipt);
    expect(f.submitted).toHaveLength(0);
  });

  it("rereads immediately before clearing and protects a receipt replaced during reconciliation", async () => {
    const f = fixture(), receipt = localReceipt(f), replacement = { ...receipt, jobId: "newer-job" };
    const read = f.journal.read; let calls = 0;
    f.journal.read = () => { const value = read(); if (++calls === 1) f.journal.write(replacement); return value; };
    expect(await f.controller.resolveUncertain({ confirmed: true })).toMatchObject({ code: "STUDIO_RECEIPT_CHANGED" });
    expect(f.pending()).toEqual(replacement); expect(f.clears()).toBe(0);
  });

  it("keeps both identities intact if the account changes during the final asynchronous journal read", async () => {
    const f = fixture(), receipt = localReceipt(f), read = f.journal.read; let calls = 0;
    f.journal.read = () => {
      const value = read();
      if (++calls !== 2) return value;
      return Promise.resolve(value).then(pending => { f.setAccount("user:another"); return pending; });
    };
    expect(await f.controller.resolveUncertain({ confirmed: true })).toMatchObject({ ok: false, code: "STUDIO_ACCOUNT_CHANGED" });
    expect(f.pending()).toEqual(receipt); expect(f.clears()).toBe(0); expect(f.controller.state.uncertain).toEqual(receipt);
  });

  it("does not read or adopt another account's journal for a restored owner", async () => {
    const f = fixture(), receipt = localReceipt(f), saved = f.controller.snapshot();
    f.controller.restore(saved); f.setAccount("user:another");
    expect(await f.controller.recoverPendingReceipt()).toMatchObject({ ok: false, code: "STUDIO_ACCOUNT_CHANGED" });
    expect(f.reads()).toBe(0); expect(f.pending()).toEqual(receipt);
    expect(f.controller.state.uncertain).toEqual(receipt);
    expect(await f.controller.resolveUncertain({ confirmed: true })).toMatchObject({ code: "STUDIO_ACCOUNT_CHANGED" });
    expect(f.clears()).toBe(0);
  });

  it("checks the account again after the asynchronous journal read", async () => {
    const f = fixture(), receipt = { jobId: "startup-job", accountKey: owner };
    f.journal.write(receipt);
    const read = f.journal.read;
    f.journal.read = () => { const value = read(); f.setAccount("user:another"); return value; };
    expect(await f.controller.recoverPendingReceipt()).toMatchObject({ ok: false, code: "STUDIO_ACCOUNT_CHANGED" });
    expect(f.controller.state.uncertain).toBeNull(); expect(f.controller.state.accountKey).toBe("");
    expect(f.pending()).toEqual(receipt); expect(f.clears()).toBe(0);
  });

  it("refuses a foreign receipt even when the journal adapter returns it to the current account", async () => {
    const f = fixture(), receipt = { jobId: "foreign-job", accountKey: "user:another" };
    f.journal.write(receipt);
    expect(await f.controller.recoverPendingReceipt()).toMatchObject({ code: "STUDIO_ACCOUNT_CHANGED" });
    expect(f.controller.state.uncertain).toBeNull(); expect(f.pending()).toEqual(receipt); expect(f.clears()).toBe(0);
  });

  it("treats undefined account identity as logged out and never reads the journal", async () => {
    const f = fixture(); f.setAccount(undefined);
    expect(await f.controller.recoverPendingReceipt()).toMatchObject({ code: "STUDIO_ACCOUNT_REQUIRED" });
    expect(f.reads()).toBe(0); expect(f.controller.state.accountKey).toBe("");
  });

  it("returns a recovery failure without changing the restored receipt when journal reading fails", async () => {
    const f = fixture(), receipt = localReceipt(f);
    f.journal.read = () => { throw new Error("offline journal fixture unavailable"); };
    expect(await f.controller.recoverPendingReceipt()).toMatchObject({ ok: false, code: "STUDIO_RECEIPT_RECOVERY_FAILED" });
    expect(f.controller.state.uncertain).toEqual(receipt); expect(f.pending()).toEqual(receipt); expect(f.clears()).toBe(0);
  });

  it("rejects recovery if a local generation starts during its asynchronous account checks", async () => {
    const f = fixture(); f.settings.count = 1; f.task.plan = f.api.createPlan(f.task, f.settings);
    let finish!: (response: ProviderResponse) => void, started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    f.bridge.send = async (_type, message) => { f.submitted.push(clone(message)); started(); return new Promise(resolve => { finish = resolve; }); };
    const recovery = f.controller.recoverPendingReceipt(), running = f.controller.run([f.task], f.settings);
    await began;
    expect(await recovery).toMatchObject({ ok: false, code: "STUDIO_ALREADY_RUNNING" });
    expect(f.controller.state.busy).toBe(true); expect(f.controller.state.uncertain).toBeNull();
    expect(f.pending()?.jobId).toBe(f.controller.state.jobId);
    await f.controller.stop(); finish({ ok: false, definitiveFailure: true, error: "离线 fixture 清理" }); await running;
  });

  it("does not dismiss a foreign local uncertainty merely because the journal is empty", async () => {
    const f = fixture(); localReceipt(f); f.journal.clear();
    f.controller.state.uncertain.accountKey = "user:another";
    const foreign = clone(f.controller.state.uncertain);
    expect(await f.controller.resolveUncertain({ confirmed: true })).toMatchObject({ code: "STUDIO_ACCOUNT_CHANGED" });
    expect(f.controller.state.uncertain).toEqual(foreign);
  });

  it.each(["recover", "resolve", "restore"])("blocks %s while a timed-out provider request is still awaiting its receipt", async operation => {
    const f = fixture(), receipt = localReceipt(f), saved = f.controller.snapshot();
    f.controller.state.awaitingReceipt = true;
    const before = f.controller.snapshot();
    const result = operation === "recover" ? await f.controller.recoverPendingReceipt() : operation === "resolve" ? await f.controller.resolveUncertain({ confirmed: true }) : f.controller.restore(saved);
    expect(result).toMatchObject({ ok: false, code: operation === "resolve" ? "STUDIO_CONFIRM_REQUIRED" : "STUDIO_ALREADY_RUNNING" });
    expect(f.controller.snapshot()).toEqual(before); expect(f.pending()).toEqual(receipt); expect(f.clears()).toBe(0);
    expect(f.submitted).toHaveLength(0);
  });

  it("clears the saved transport flag in a refreshed controller while preserving and recovering the receipt", async () => {
    const { f, saved, receipt } = await interruptedSnapshot();
    saved.awaitingReceipt = true; f.controller.state.awaitingReceipt = false;
    expect(f.controller.restore(saved)).toMatchObject({ ok: true });
    expect(f.controller.state.awaitingReceipt).toBe(false);
    expect(f.controller.state.uncertain).toMatchObject(identity(receipt));
    expect(await f.controller.recoverPendingReceipt()).toMatchObject({ ok: true, pending: true, receipt });
    expect(f.pending()).toEqual(receipt); expect(f.clears()).toBe(0);
  });

  it("recovers a same-account receipt from another entry without creating tasks or submitting or clearing", async () => {
    const f = fixture(), receipt = { jobId: "other-entry-job", taskId: "other-product", shotId: "shot-2", batchId: "other-batch", accountKey: owner };
    f.journal.write(receipt);
    expect(await f.controller.recoverPendingReceipt()).toMatchObject({ ok: true, pending: true, uncertain: true, matchesCurrentTask: false, receipt });
    expect(f.controller.state.uncertain).toEqual(receipt); expect(f.controller.state.tasks).toEqual([]);
    expect(f.pending()).toEqual(receipt); expect(f.clears()).toBe(0);
    expect((await f.controller.run([f.task], f.settings)).uncertain).toBe(true);
    expect(f.submitted).toHaveLength(0); expect(f.archived).toHaveLength(0);
  });

  it("preserves completed results while recovering and explicitly resolving their receipt", async () => {
    const f = fixture(); f.settings.count = 1; f.task.plan = f.api.createPlan(f.task, f.settings);
    await f.controller.run([f.task], f.settings);
    const original = clone(f.controller.state.tasks[0].slots[0]), receipt = { jobId: original.item.jobId, taskId: f.task.id, shotId: "shot-1", batchId: original.item.batchId, accountKey: owner };
    const restored = fixture(f.api); restored.controller.restore(f.controller.snapshot()); restored.journal.write(receipt);
    expect(await restored.controller.recoverPendingReceipt()).toMatchObject({ pending: true, matchesCurrentTask: true });
    expect((await restored.controller.resolveUncertain({ confirmed: true })).ok).toBe(true);
    expect(restored.controller.state.tasks[0].slots[0]).toEqual(original);
    expect(restored.submitted).toHaveLength(0); expect(restored.archived).toHaveLength(0);
  });

  it("reports no pending journal without silently removing the restored uncertainty", async () => {
    const { f } = await interruptedSnapshot(); f.journal.clear();
    const local = clone(f.controller.state.uncertain);
    expect(await f.controller.recoverPendingReceipt()).toMatchObject({ ok: true, pending: false, uncertain: true, receipt: null });
    expect(f.controller.state.uncertain).toEqual(local);
    expect((await f.controller.run([f.task], f.settings)).uncertain).toBe(true);
    expect((await f.controller.resolveUncertain({ confirmed: true })).ok).toBe(true);
    expect(f.controller.state.tasks[0].slots[11].status).toBe("failed");
    expect(f.submitted).toHaveLength(0);
  });

  it("reports an empty current journal without producing a receipt or changing completed tasks", async () => {
    const f = fixture();
    expect(await f.controller.recoverPendingReceipt()).toEqual({ ok: true, pending: false, uncertain: false, accountKey: owner, matchesCurrentTask: false, receipt: null });
    expect(f.controller.state.uncertain).toBeNull(); expect(f.clears()).toBe(0); expect(f.submitted).toHaveLength(0);
  });

  it("keeps unrelated restored uncertain slots locked after one receipt is resolved", async () => {
    const { f, saved, receipt } = await interruptedSnapshot();
    saved.tasks[0].slots[12].status = "generating";
    f.controller.restore(saved);
    expect(f.controller.state.uncertain.jobId).toBeUndefined();
    expect(await f.controller.recoverPendingReceipt()).toMatchObject({ pending: true, matchesCurrentTask: true });
    expect((await f.controller.resolveUncertain({ confirmed: true })).ok).toBe(true);
    expect(f.controller.state.tasks[0].slots[11].status).toBe("failed");
    expect(f.controller.state.tasks[0].slots[12].status).toBe("uncertain");
    expect(f.controller.state.uncertain).toMatchObject({ taskId: receipt.taskId, shotId: "shot-13" });
    expect((await f.controller.run([f.task], f.settings)).uncertain).toBe(true);
    expect(f.submitted).toHaveLength(0);
  });

  it("does not bind another entry's replacement job to a local interrupted slot with the same task and shot IDs", async () => {
    const { f, receipt } = await interruptedSnapshot(), replacement = { ...receipt, jobId: "other-entry-job" };
    f.journal.write(replacement);
    expect(await f.controller.recoverPendingReceipt()).toMatchObject({ pending: true, matchesCurrentTask: false });
    expect((await f.controller.resolveUncertain({ confirmed: true })).ok).toBe(true);
    expect(f.controller.state.tasks[0].slots[11].status).toBe("uncertain");
    expect(f.controller.state.uncertain).toMatchObject(identity(receipt));
    expect(f.submitted).toHaveLength(0);
  });
});
