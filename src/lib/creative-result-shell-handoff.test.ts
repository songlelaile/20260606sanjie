import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(resolve(process.env.CREATIVE_PROMPTLAB_TEST_PATH ||
  `${process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative"}/labs/image-prompt-lab/promptlab.js`), "utf8");
const bridgeStart = source.indexOf("window.SZ_CREATIVE_TOOLS_BRIDGE = {");
const bridgeEnd = source.indexOf("\n  };", bridgeStart);
if (bridgeStart < 0 || bridgeEnd < bridgeStart) throw new Error("Missing shipped creative bridge");
const bridgeSource = source.slice(bridgeStart, bridgeEnd + "\n  };".length);

type OriginalResult = { url: string; resultId: string; jobId: string; productImages: string[]; modelImages: string[];
  creativeTool: string; creativeShotId: string; creativePlanSignature: string; generationRoute: string };
function original(): OriginalResult {
  return { url: "blob:https://fixture.test/retained-original", resultId: "original-result", jobId: "original-job",
    productImages: ["data:image/png;base64,cHJvZHVjdA=="], modelImages: [], creativeTool: "buyer",
    creativeShotId: "original-shot", creativePlanSignature: "original-plan", generationRoute: "creative-tools" };
}

function harness(runtimeId: string | null = "shaozhuang-web-studio") {
  const send = vi.fn(async () => ({ ok: true, opened: true }));
  const helper = vi.fn<(item: OriginalResult, owner: string) => Promise<{ ok: boolean; error?: string }>>(async () => ({ ok: true }));
  const guide = vi.fn<(item: Record<string, unknown>) => { ok: boolean }>(() => ({ ok: true }));
  const state = { archiveAccountKey: "account:alice", activeJobIds: { "original-job": true }, results: [original()],
    pendingReceipt: { jobId: "original-job", accountKey: "account:alice" } };
  const window: { SZ_LINK_RESULT_HANDOFF?: { openCreativeFission?: typeof helper }; SZ_CREATIVE_TOOLS_BRIDGE?: {
    openResultAction(action: string, item: OriginalResult): Promise<{ ok: boolean; error?: string } | void> } } = {
    SZ_LINK_RESULT_HANDOFF: { openCreativeFission: helper }
  };
  const context = createContext({ window, state, chrome: runtimeId === null ? undefined : { runtime: { id: runtimeId } }, send,
    cfgFromForm: vi.fn(() => { throw new Error("Opening a result must not read or transfer API configuration"); }),
    queueArchiveResult: vi.fn(), creativeWebAccountKey: vi.fn(async () => state.archiveAccountKey), creativeWebRefresh: vi.fn(),
    creativeWebListBoundApis: vi.fn(), creativeWebSelectBoundApi: vi.fn(), creativeWebSetApiBusy: vi.fn(), newJobId: vi.fn(),
    registerGenerationJob: vi.fn(), unregisterGenerationJob: vi.fn(), openArchiveHistory: vi.fn(),
    cloneGuideValue: structuredClone, openGuideRegenerateModal: guide, $: () => null });
  runInContext(bridgeSource, context);
  return { window, state, send, helper, guide, context, bridge: window.SZ_CREATIVE_TOOLS_BRIDGE! };
}

describe("creative result fission uses the website shell handoff", () => {
  it.each(["fission", "viral"])("routes hosted %s through the guarded helper without altering the original", async action => {
    const h = harness(), item = h.state.results[0], before = structuredClone(h.state);
    expect(await h.bridge.openResultAction(action, item)).toMatchObject({ ok: true });
    expect(h.helper).toHaveBeenCalledExactlyOnceWith(item, "account:alice");
    expect(h.send).not.toHaveBeenCalled(); expect(h.guide).not.toHaveBeenCalled();
    expect(h.state).toEqual(before); expect(h.state.results[0]).toBe(item);
  });

  it.each(["missing module", "missing method"])("fails closed for %s instead of opening the bare legacy workbench", async kind => {
    const h = harness(), before = structuredClone(h.state);
    h.window.SZ_LINK_RESULT_HANDOFF = kind === "missing module" ? undefined : {};
    await expect(h.bridge.openResultAction("fission", h.state.results[0])).rejects.toThrow("官网裂变入口尚未就绪");
    expect(h.send).not.toHaveBeenCalled(); expect(h.helper).not.toHaveBeenCalled(); expect(h.state).toEqual(before);
  });

  it("preserves a refused import as an actionable failure without falling back or resubmitting", async () => {
    const h = harness(), before = structuredClone(h.state);
    h.helper.mockResolvedValue({ ok: false, error: "原结果的账号已变化，本次没有导入。" });
    expect(await h.bridge.openResultAction("fission", h.state.results[0])).toEqual({ ok: false, error: "原结果的账号已变化，本次没有导入。" });
    expect(h.helper).toHaveBeenCalledOnce(); expect(h.send).not.toHaveBeenCalled(); expect(h.state).toEqual(before);
  });

  it("keeps a thrown helper error and retained receipts without a legacy fallback", async () => {
    const h = harness(), before = structuredClone(h.state);
    h.helper.mockRejectedValue(new Error("独立工作台尚未准备好"));
    await expect(h.bridge.openResultAction("fission", h.state.results[0])).rejects.toThrow("独立工作台尚未准备好");
    expect(h.send).not.toHaveBeenCalled(); expect(h.state).toEqual(before);
  });

  it.each(["bundled-extension", null])("retains the original context protocol outside hosted web (%s)", async runtimeId => {
    const h = harness(runtimeId), item = h.state.results[0];
    await h.bridge.openResultAction("fission", item);
    expect(h.send).toHaveBeenCalledExactlyOnceWith("OPEN_CONTEXT_WORKBENCH", {
      route: "viral", payload: { imageUrl: item.url, importRoute: "viral", targetMode: "viral" }
    });
    expect(h.helper).not.toHaveBeenCalled();
  });

  it("retains existing inline editing with original products and strips generation contracts", async () => {
    const h = harness(), item = h.state.results[0], before = structuredClone(item);
    expect(await h.bridge.openResultAction("edit", item)).toMatchObject({ ok: true });
    expect(h.guide).toHaveBeenCalledOnce(); expect(h.helper).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
    expect(h.guide.mock.calls[0][0]).toMatchObject({ url: item.url, productImages: item.productImages, labMode: "main", detailMode: "main" });
    expect(h.guide.mock.calls[0][0]).not.toHaveProperty("generationRoute"); expect(item).toEqual(before);
  });

  it("rejects a result without pixels before invoking any navigation path", async () => {
    const h = harness();
    await expect(h.bridge.openResultAction("fission", { ...original(), url: "" })).rejects.toThrow("缺少结果图片");
    expect(h.helper).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled(); expect(h.guide).not.toHaveBeenCalled();
  });
});
