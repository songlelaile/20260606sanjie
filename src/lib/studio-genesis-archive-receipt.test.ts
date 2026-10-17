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
    archiveSurfaceForItem: () => "detail",
    archiveBusinessMetaForItem: () => ({ archiveProjectId: "project-original", businessBatchTitle: "原商品", businessRoleName: "详情图" }),
    archiveImageIndex: () => 12,
    IMAGE_ARCHIVE: { saveResult },
    state: { archiveWriteQueue: Promise.resolve(), archiveAccountKey: "account-original", archiveFailureCount: 0 },
    $: () => null,
    clearTimeout: vi.fn(), setTimeout: vi.fn()
  });
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
});
