import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const fixture = vi.hoisted(() => ({ context: vi.fn(), resolve: vi.fn(), lease: vi.fn(), release: vi.fn() }));
vi.mock("@/lib/video-assets-server", () => ({ nativeAssetContext: fixture.context }));
import { nativeVideoAssets, releaseNativeVideoAssets } from "./native-video-assets";
import type { NativeVideoSupply } from "./native-video-supply";
const owner = { id: "alice", tenantId: "tenant-a", username: "alice" };
const supply = { kind: "ark" } as NativeVideoSupply;
const image = (url: string) => ({ type: "image_url", role: "reference_image", image_url: { url } });
describe("native wallet material ownership boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.context.mockResolvedValue({ scope: { tenantId: "tenant-a", userId: "alice" }, service: { resolveReferences: fixture.resolve, acquireLease: fixture.lease, releaseLease: fixture.release } });
    fixture.resolve.mockResolvedValue([{ id: "va_fixture", url: "asset://asset-fixture" }]);
    fixture.lease.mockResolvedValue({ references: [{ id: "va_fixture", url: "asset://asset-fixture" }] });
  });
  it("ordinary-only requests preserve the old wallet route without touching the asset service", async () => {
    const body = { content: [image("https://public.example/product.png")] };
    expect(await nativeVideoAssets(owner, supply, body)).toEqual({ body, trustedUris: new Set() });
    expect(fixture.context).not.toHaveBeenCalled();
  });
  it("quote resolves only the authenticated owner without acquiring a lease", async () => {
    const body = { content: [image("library://va_fixture"), image("https://public.example/product.png")] };
    const result = await nativeVideoAssets(owner, supply, body);
    expect(fixture.context).toHaveBeenCalledWith(owner, supply);
    expect(fixture.resolve).toHaveBeenCalledWith(expect.objectContaining({ userId: "alice", tenantId: "tenant-a" }), ["va_fixture"]);
    expect(result.body.content).toEqual([image("asset://asset-fixture"), image("https://public.example/product.png")]);
    expect(result.trustedUris.has("asset://asset-fixture")).toBe(true);
    expect(fixture.lease).not.toHaveBeenCalled();
  });
  it("dispatch acquires durable protection under the native job ID and deduplicates IDs", async () => {
    await nativeVideoAssets(owner, supply, { content: [image("library://va_fixture"), image("library://va_fixture")] }, "nv_fixture");
    expect(fixture.lease).toHaveBeenCalledWith(expect.anything(), { taskId: "nv_fixture", assetIds: ["va_fixture"] });
    expect(fixture.resolve).not.toHaveBeenCalled();
  });
  it("revoked, sibling tenant and unavailable moderation results block dispatch without exposing provider errors", async () => {
    fixture.context.mockRejectedValue(new Error("fixture-secret-provider-error"));
    await expect(nativeVideoAssets(owner, supply, { content: [image("library://va_fixture")] }, "nv_fixture")).rejects.toMatchObject({ code: "NATIVE_VIDEO_ASSET_UNSUPPORTED" });
    expect(fixture.lease).not.toHaveBeenCalled();
  });
  it.each([{ refs: [] }, { refs: [{ id: "va_other", url: "asset://asset-other" }] }, { refs: [{ id: "va_fixture", url: "https://evil.example/private" }] }])("rejects an incomplete or inconsistent internal mapping %j", async ({ refs }) => {
    fixture.resolve.mockResolvedValue(refs);
    await expect(nativeVideoAssets(owner, supply, { content: [image("library://va_fixture")] })).rejects.toMatchObject({ code: "NATIVE_VIDEO_ASSET_UNSUPPORTED" });
  });
  it("cleans confirmed terminal protection while unavailable cleanup preserves the video result", async () => {
    await releaseNativeVideoAssets(owner, supply, "nv_fixture", "succeeded");
    expect(fixture.release).toHaveBeenCalledWith(expect.anything(), { taskId: "nv_fixture", terminalStatus: "succeeded" });
    fixture.release.mockRejectedValue(new Error("unavailable"));
    await expect(releaseNativeVideoAssets(owner, supply, "nv_fixture", "failed")).resolves.toBeUndefined();
  });
});
