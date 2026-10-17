import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function archiveHarness() {
  const source = readFileSync(resolve(process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative", "labs/image-prompt-lab/promptlab.js"), "utf8");
  const start = source.indexOf("function archiveSafeConfigSnapshot("), end = source.indexOf("\nfunction releaseArchiveObjectUrls()", start);
  if (start < 0 || end < 0) throw new Error("Production archive queue was not found");
  const currentConfig = { provider: "later-provider", imageModel: "later-model", apiKey: "later-secret" };
  const saveResult = vi.fn(async (_input: Record<string, unknown>) => ({ archiveAssetId: "asset-original", archiveBatchId: "batch-original" }));
  const context = createContext({
    cfgFromForm: () => currentConfig,
    archiveAvailable: () => true,
    archiveBusinessMetaForItem: () => ({ archiveProjectId: "project-original", businessBatchTitle: "原商品", businessRoleName: "详情图" }),
    archiveImageIndex: () => 12,
    IMAGE_ARCHIVE: { saveResult },
    state: { archiveWriteQueue: Promise.resolve(), archiveAccountKey: "account-original", archiveFailureCount: 0 },
    $: () => null,
    clearTimeout: vi.fn(), setTimeout: vi.fn()
  });
  const routeStart = source.indexOf("function archiveSurfaceForItem("), routeEnd = source.indexOf("\nfunction archiveRouteKey(", routeStart);
  if (routeStart < 0 || routeEnd < 0) throw new Error("Production archive routing was not found");
  runInContext(source.slice(routeStart, routeEnd), context, { filename: "promptlab-production-archive-routing.js" });
  runInContext(source.slice(start, end), context, { filename: "promptlab-production-archive.js" });
  return { queue: context.queueArchiveResult as (item: Record<string, unknown>, options?: Record<string, unknown>) => Promise<{ ok: boolean }>, saveResult };
}

describe("studio receipt archive uses the original request model", () => {
  it("archives a late original with its captured model after the form selects another model", async () => {
    const h = archiveHarness();
    const result = await h.queue({ url: "https://fixture.test/original.png", jobId: "job-original", resultId: "job-original:studio:shot-12",
      generationConfig: { provider: "original-provider", imageModel: "original-model", apiKey: "original-secret", imageEndpoint: "https://private.test" } }, { accountKey: "account-original" });
    expect(result.ok).toBe(true);
    expect(h.saveResult).toHaveBeenCalledOnce();
    expect(h.saveResult.mock.calls[0][0]).toMatchObject({ provider: "original-provider", imageModel: "original-model", jobId: "job-original", accountKey: "account-original", imageIndex: 12 });
    const input = JSON.stringify(h.saveResult.mock.calls[0][0]);
    for (const value of ["later-provider", "later-model", "original-secret", "later-secret", "private.test"]) expect(input).not.toContain(value);
  });

  it("preserves empty captured metadata instead of substituting a later selection", async () => {
    const h = archiveHarness();
    expect((await h.queue({ url: "https://fixture.test/original.png", generationConfig: { provider: "", imageModel: "" } })).ok).toBe(true);
    expect(h.saveResult.mock.calls[0][0]).toMatchObject({ provider: "", imageModel: "" });
  });

  it("keeps the existing archive behavior for older results without a request snapshot", async () => {
    const h = archiveHarness();
    expect((await h.queue({ url: "https://fixture.test/legacy.png" })).ok).toBe(true);
    expect(h.saveResult.mock.calls[0][0]).toMatchObject({ provider: "later-provider", imageModel: "later-model" });
    expect(JSON.stringify(h.saveResult.mock.calls[0][0])).not.toContain("later-secret");
  });

  it("archives the original ad subtype on the existing main storage surface", async () => {
    const h = archiveHarness();
    const result = await h.queue({ url: "https://fixture.test/original.png", jobId: "job-ad", resultId: "job-ad:studio:shot-1",
      archiveSurfaceMode: "main", generationRoute: "studio-genesis",
      studioGenesisPlan: { settings: { mode: "main", imageType: "ad", adTemplate: "floating" } } }, { accountKey: "account-original", surfaceMode: "main" });
    expect(result.ok).toBe(true);
    expect(h.saveResult.mock.calls[0][0]).toMatchObject({
      accountKey: "account-original", surfaceMode: "main", creativeRoute: "ad", jobId: "job-ad", resultId: "job-ad:studio:shot-1"
    });
  });

  it.each([
    {},
    { generationRoute: "studio-genesis" },
    { studioGenesisPlan: { settings: { mode: "main", imageType: "ad" } } },
    { generationRoute: "studio-genesis", studioGenesisPlan: { settings: { mode: "main", imageType: "main" } } },
    { generationRoute: "studio-genesis", studioGenesisPlan: { settings: { mode: "detail", imageType: "ad" } } }
  ])("does not infer an ad archive from a name or free prompt without an owned ad plan: %j", async evidence => {
    const h = archiveHarness();
    expect((await h.queue({ url: "https://fixture.test/legacy.png", productName: "UAT-AD 广告图", prompt: "制作商品广告图", ...evidence })).ok).toBe(true);
    expect(h.saveResult.mock.calls[0][0]).toMatchObject({ surfaceMode: "main", creativeRoute: "" });
  });
});

describe("ad archive compatibility with the published store", () => {
  it.each(["raw", "loaded"])("retains the current database and asset identities in the %s store", kind => {
    const base = resolve(process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative", "labs/image-prompt-lab");
    let source = readFileSync(resolve(base, "image-archive-store.js"), "utf8");
    if (kind === "loaded") {
      const packed = readFileSync(resolve(base, "studio-prerequisites-20261009-v1.js"), "utf8");
      const marker = "/* Frozen source: public/creative/labs/image-prompt-lab/image-archive-store.js */\n";
      const start = packed.indexOf(marker), end = packed.indexOf("\n;\n/* Frozen source:", start + marker.length);
      if (start < 0 || end < 0) throw new Error("Published archive store segment was not found");
      source = packed.slice(start + marker.length, end);
    }
    const indexedDB = { open: vi.fn() }, context = createContext({ Blob, indexedDB });
    runInContext(source, context);
    const store = context.SZ_IMAGE_ARCHIVE;
    const input = { accountKey: "user:tenant-a:alice", surfaceMode: "main", sourceBatchId: "project-original", resultId: "job-ad:studio:shot-1", jobId: "job-ad", createdAt: 123 };
    const main = store.sanitizeArchiveInput(input), ad = store.sanitizeArchiveInput({ ...input, creativeRoute: "ad" });
    expect(store.DB_NAME).toBe("sz_image_archive_v1"); expect(store.DB_VERSION).toBe(2);
    for (const key of ["accountKey", "surfaceMode", "archiveBatchId", "archiveAssetId", "sourceBatchId", "resultId", "jobId", "createdAt"]) expect(ad[key]).toBe(main[key]);
    expect(ad.creativeRoute).toBe("ad");
    const blob = new Blob(["synthetic-ad-original"], { type: "image/png" });
    const projected = store.projectArchiveRecords({ batches: [ad], assets: [{ ...ad, blob, size: blob.size, deletedAt: 0 }] });
    expect(projected.batches).toHaveLength(1);
    expect(projected.batches[0]).toMatchObject({ accountKey: input.accountKey, surfaceMode: "main", creativeRoute: "ad", assetCount: 1 });
    expect(projected.batches[0].assets[0]).toMatchObject({ archiveAssetId: main.archiveAssetId, resultId: input.resultId, creativeRoute: "ad", blob });
    expect(indexedDB.open).not.toHaveBeenCalled();
  });
});
