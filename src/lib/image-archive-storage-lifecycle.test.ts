import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(resolve("public/creative/labs/image-prompt-lab/image-archive-store.js"), "utf8");
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
type RecordValue = { [field: string]: unknown };
type RequestValue = { result?: unknown; error?: Error; onsuccess?: () => void; onerror?: () => void; onblocked?: () => void };

// Run the shipped archive store against transactional in-memory IndexedDB.
// Writes become visible only on commit; no browser, network or provider runs.
function harness(web = false, storageKey?: (id: string) => string) {
  const records: Record<string, Map<string, RecordValue>> = { batches: new Map(), assets: new Map(), referenceProvisionalTombstones: new Map() };
  const reads: Array<{ store: string; index: string; operation: string }> = [];
  const requests: RequestValue[] = [];
  let account = "alice", holdOpen = false, blockOpen = false, holdTransactions = false, transactionError = false;
  let opens = 0, closes = 0, aborts = 0, transactions = 0;
  const connection = () => ({
    close() { closes++; },
    transaction(names: string[], mode: string) {
      transactions++;
      if (transactionError) throw new Error("fixture transaction unavailable");
      const working = Object.fromEntries(names.map(name => [name, new Map([...records[name]].map(([id, record]) => [id, structuredClone(record)]))]));
      let pending = 0, finished = false;
      const tx = {
        oncomplete: undefined as (() => void) | undefined,
        onabort: undefined as (() => void) | undefined,
        onerror: undefined as (() => void) | undefined,
        abort() { if (finished) return; finished = true; aborts++; tx.onabort?.(); },
        objectStore(name: string) {
          const request = (operation: () => unknown) => {
            const result: RequestValue = {}; pending++;
            queueMicrotask(() => {
              if (finished) return;
              result.result = operation(); result.onsuccess?.(); pending--;
              queueMicrotask(() => {
                if (finished || pending || holdTransactions) return;
                finished = true;
                if (mode === "readwrite") for (const store of names) records[store] = working[store];
                tx.oncomplete?.();
              });
            });
            return result;
          };
          return {
            get(id: string) { return request(() => working[name].get(id)); },
            put(record: RecordValue) { return request(() => {
              const key = String(record[name === "batches" ? "archiveBatchId" : "archiveAssetId"]);
              working[name].set(key, structuredClone(record)); return key;
            }); },
            delete(id: string) { return request(() => working[name].delete(id)); },
            index(index: string) {
              const matches = (value: unknown) => [...working[name].values()].filter(record => record[index] === value);
              return {
                getAll(value: unknown) { reads.push({ store: name, index, operation: "getAll" }); return request(() => matches(value)); },
                count(value: unknown) { reads.push({ store: name, index, operation: "count" }); return request(() => matches(value).length); },
                openCursor() { reads.push({ store: name, index, operation: "openCursor" }); return request(() => null); }
              };
            }
          };
        }
      };
      return tx;
    }
  });
  const indexedDB = { open: vi.fn(() => {
    opens++;
    const request: RequestValue = { result: connection() }; requests.push(request);
    if (!holdOpen) queueMicrotask(() => blockOpen ? request.onblocked?.() : request.onsuccess?.());
    return request;
  }) };
  const context = createContext({ Blob, indexedDB, setTimeout, clearTimeout, console, IDBKeyRange: { bound: (...values: unknown[]) => values },
    ...(web ? { SZ_WEB_ACCOUNT: { require: vi.fn(async () => account), ...(storageKey ? { storageKey } : {}) } } : {}) });
  runInContext(source, context);
  const store = context.SZ_IMAGE_ARCHIVE;
  return { store, records, reads, requests, indexedDB,
    setAccount: (value: string) => { account = value; },
    holdOpen: (value: boolean) => { holdOpen = value; },
    blockOpen: (value: boolean) => { blockOpen = value; },
    holdTransactions: (value: boolean) => { holdTransactions = value; },
    transactionError: (value: boolean) => { transactionError = value; },
    get opens() { return opens; }, get closes() { return closes; }, get aborts() { return aborts; }, get transactions() { return transactions; }
  };
}

function asset(id: string, accountKey = "user:alice", extra: RecordValue = {}) {
  return { archiveAssetId: id, archiveBatchId: "batch-" + id, resultId: id, accountKey,
    createdAt: 1, updatedAt: 1, imageIndex: 1, size: 4, blob: new Blob(["test"], { type: "image/png" }), ...extra };
}
afterEach(() => vi.useRealTimers());

describe("bounded account-scoped image archive storage", () => {
  it.each([undefined, "", "local", "   "])("reports an unbound hosted account %s without opening storage", async accountKey => {
    vi.useFakeTimers(); const h = harness(true);
    await expect(h.store.list(accountKey, { skipPurge: true })).rejects.toMatchObject({ code: "ARCHIVE_ACCOUNT_NOT_READY", message: expect.stringContaining("等待工作台加载完成后重试") });
    await expect(h.store.saveResult({ accountKey, blob: asset("unbound").blob })).rejects.toMatchObject({ code: "ARCHIVE_ACCOUNT_NOT_READY" });
    expect(h.indexedDB.open).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["alice", "tenant:alice+test@example.com", "租户/账户 #1", "long:" + "account".repeat(30)])("matches the shared key and legacy fallback for %s", async id => {
    const canonical = (value: string) => "user:" + String(value).replace(/[^\w@.+:-]/g, "_").slice(0, 120);
    const storageKey = vi.fn(canonical), shared = harness(true, storageKey), legacy = harness(true);
    shared.setAccount(id); legacy.setAccount(id);
    expect(await shared.store.list(canonical(id), { skipPurge: true })).toEqual([]);
    expect(await legacy.store.list(canonical(id), { skipPurge: true })).toEqual([]);
    expect(storageKey).toHaveBeenCalledExactlyOnceWith(id);
  });

  it("uses the shared account key for cleanup as well as ordinary archive reads", async () => {
    const storageKey = vi.fn((id: string) => "shared:" + id), h = harness(true, storageKey);
    expect(await h.store.list("shared:alice", { skipPurge: true })).toEqual([]);
    expect(await h.store.purgeAllExpired()).toEqual({ removed: 0 });
    expect(h.reads.every(read => read.index === "accountKey")).toBe(true);
    expect(storageKey).toHaveBeenCalledTimes(3); expect(h.opens).toBe(2);
  });

  it("rejects another account before opening the shared archive", async () => {
    const h = harness(true);
    await expect(h.store.list("user:bob", { skipPurge: true })).rejects.toThrow("登录账号已变化");
    await expect(h.store.moveToTrash("user:bob", ["private"])).rejects.toThrow("登录账号已变化");
    await expect(h.store.saveResult({ accountKey: "user:bob", blob: asset("x").blob })).rejects.toThrow("登录账号已变化");
    expect(h.indexedDB.open).not.toHaveBeenCalled();
  });

  it("revalidates ownership after image retrieval and preserves the original account on a switch", async () => {
    const h = harness(true);
    const fetcher = vi.fn(async () => { h.setAccount("bob"); return { ok: true, blob: async () => asset("x").blob }; });
    await expect(h.store.saveResult({ accountKey: "user:alice", resultId: "late", url: "https://fixture.test/result.png" }, { fetch: fetcher })).rejects.toThrow("登录账号已变化");
    expect(fetcher).toHaveBeenCalledOnce(); expect(h.records.assets.size).toBe(0);
    expect(h.opens).toBe(1); expect(h.closes).toBe(1);
  });

  it("limits hosted recovery scans to the current account while preserving extension discovery", async () => {
    const hosted = harness(true);
    expect(await hosted.store.scanExpiredReferenceProvisionals()).toMatchObject({ ok: true, accountKey: "user:alice", items: [] });
    expect(hosted.reads).toEqual([{ store: "assets", index: "accountReferenceProvisionalScanKey", operation: "openCursor" }]);
    await expect(hosted.store.scanExpiredReferenceProvisionals({ accountKey: "user:bob" })).rejects.toThrow("登录账号已变化");
    const extension = harness();
    expect(await extension.store.scanExpiredReferenceProvisionals()).toMatchObject({ ok: true, accountKey: "", items: [] });
    expect(extension.reads).toEqual([{ store: "assets", index: "referenceProvisionalScanKey", operation: "openCursor" }]);
  });

  it("closes a late open connection after the deadline and allows a fresh read", async () => {
    vi.useFakeTimers(); const h = harness(); h.holdOpen(true);
    const rejected = expect(h.store.list("user:alice", { skipPurge: true })).rejects.toThrow("打开超时");
    await flush(); await vi.advanceTimersByTimeAsync(15000); await rejected;
    h.requests[0].onsuccess?.(); expect(h.closes).toBe(1); expect(h.transactions).toBe(0);
    h.holdOpen(false); expect(await h.store.list("user:alice", { skipPurge: true })).toEqual([]);
    expect(h.opens).toBe(2); expect(h.closes).toBe(2); expect(vi.getTimerCount()).toBe(0);
  });

  it("reports blocked upgrades promptly and closes their late connection", async () => {
    vi.useFakeTimers(); const h = harness(); h.blockOpen(true);
    await expect(h.store.list("user:alice", { skipPurge: true })).rejects.toThrow("旧工作台占用");
    h.requests[0].onsuccess?.(); expect(h.closes).toBe(1); expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a hung write without applying it, releases its connection and permits retry", async () => {
    vi.useFakeTimers(); const h = harness(); h.records.assets.set("image", asset("image")); h.holdTransactions(true);
    const rejected = expect(h.store.moveToTrash("user:alice", ["image"])).rejects.toThrow("读写超时");
    await flush(); await vi.advanceTimersByTimeAsync(15000); await rejected;
    expect(h.aborts).toBe(1); expect(h.closes).toBe(1); expect(h.records.assets.get("image")?.deletedAt).toBeUndefined();
    h.holdTransactions(false); expect(await h.store.moveToTrash("user:alice", ["image"])).toMatchObject({ changed: 1 });
    expect(Number(h.records.assets.get("image")?.deletedAt)).toBeGreaterThan(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a connection when transaction setup throws and supports a later retry", async () => {
    vi.useFakeTimers(); const h = harness(); h.transactionError(true);
    await expect(h.store.list("user:alice", { skipPurge: true })).rejects.toThrow("fixture transaction unavailable");
    expect(h.closes).toBe(1); expect(vi.getTimerCount()).toBe(0);
    h.transactionError(false); expect(await h.store.list("user:alice", { skipPurge: true })).toEqual([]);
  });

  it("summarizes one account from one post-purge snapshot without duplicate Blob reads", async () => {
    const h = harness(true), now = Date.now();
    const values = [asset("active"), asset("trash", "user:alice", { deletedAt: now, purgeAt: now + 10000 }),
      asset("provisional", "user:alice", { archiveState: "provisional" }), asset("foreign", "user:bob")];
    for (const value of values) {
      h.records.assets.set(value.archiveAssetId, value);
      h.records.batches.set(value.archiveBatchId, { archiveBatchId: value.archiveBatchId, accountKey: value.accountKey });
    }
    expect(await h.store.summary("user:alice")).toEqual({ activeBatches: 1, activeAssets: 1, trashAssets: 1, bytes: 8 });
    expect(h.reads.filter(read => read.store === "assets" && read.operation === "getAll")).toHaveLength(2); // purge + shared summary
    expect(h.records.assets.size).toBe(4); expect(h.opens).toBe(h.closes);
  });

  it("removes an empty batch atomically while retaining occupied and other-account batches", async () => {
    const h = harness(true);
    h.records.assets.set("removed", asset("removed", "user:alice", { archiveBatchId: "empty" }));
    h.records.assets.set("retained", asset("retained", "user:alice", { archiveBatchId: "occupied" }));
    for (const id of ["empty", "occupied"]) h.records.batches.set(id, { archiveBatchId: id, accountKey: "user:alice" });
    h.records.batches.set("foreign", { archiveBatchId: "foreign", accountKey: "user:bob" });
    expect(await h.store.permanentlyRemove("user:alice", ["removed", "retained-from-bob"])).toEqual({ removed: 1 });
    expect([...h.records.batches.keys()]).toEqual(["occupied", "foreign"]);
    expect(h.reads.filter(read => read.operation === "count")).toHaveLength(2);
    expect(h.reads.some(read => read.store === "assets" && read.operation === "getAll")).toBe(false);
  });
});
