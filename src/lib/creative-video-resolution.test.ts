import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Request = { mode: string; productKey: string; durationSeconds: number; resolution: string; ratio: string; audioMode: string; creativeRoute: string; styleProfile: string; script: string; images: unknown[]; videos: unknown[]; audios: unknown[]; rights?: { confirmed: boolean; confirmedAt: string; fingerprint: string } };
type Plan = { version: number; resolution: string; ratio: string; width: number; height: number; request: Request; estimateYuan: number; reservedEstimateYuan: number; shots: Array<{ request: Request; estimatedYuan: number; reservedYuan: number }>; adjustments: string[] };
type Api = { buildPlan(request: Request, options: object): Plan; estimateShot(shot: object): number; outputDimensions(resolution: string, ratio: string): { width: number; height: number }; renderTimeline(plan: unknown, settings: unknown): Promise<unknown> };
const root = "../../public/creative/labs/ecommerce-video-studio/";
const require = createRequire(import.meta.url);
const api = require(fileURLToPath(new URL(root + "video-production.js", import.meta.url))) as Api;
const contract = require(fileURLToPath(new URL(root + "video-studio-contract.js", import.meta.url))) as { assetRightsFingerprint(request: Request): string };
const options = { mode: "quality", totalDurationSeconds: 15, hybridAiSeconds: 0, budgetYuan: 100, maxAttempts: 1 };
function request(resolution = "720p", productKey = "seedance-2.0", ratio = "9:16"): Request {
  return { mode: "direct", productKey, durationSeconds: 15, resolution, ratio, audioMode: "silent", creativeRoute: "free_direct", styleProfile: "commerce_studio", script: "展示商品外观与材质细节", images: [], videos: [], audios: [] };
}
const sizes = [
  { resolution: "480p", width: 854, height: 480, bitrate: 2000000 },
  { resolution: "720p", width: 1280, height: 720, bitrate: 4000000 },
  { resolution: "1080p", width: 1920, height: 1080, bitrate: 8000000 },
  { resolution: "4k", width: 3840, height: 2160, bitrate: 24000000 },
];

function renderingHarness(trackWidth?: number) {
  const canvases: Array<{ width: number; height: number }> = [], recordingOptions: Array<{ videoBitsPerSecond: number }> = [], captureRates: number[] = [];
  const stop = vi.fn();
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(_stream: unknown, settings: { videoBitsPerSecond: number }) { recordingOptions.push(settings); throw new Error("Fixture stops before encoding; it performs no media or network work"); }
  }
  class Image {
    naturalWidth = 800; naturalHeight = 600;
    listeners = new Map<string, () => void>();
    addEventListener(event: string, callback: () => void) { this.listeners.set(event, callback); }
    removeEventListener(event: string) { this.listeners.delete(event); }
    removeAttribute() {}
    set src(_url: string) { Promise.resolve().then(() => this.listeners.get("load")?.()); }
  }
  const context = vm.createContext({ Blob, AbortController, Uint8Array, DataView, setTimeout, clearTimeout, MediaRecorder: Recorder,
    URL: { createObjectURL: () => "blob:fixture", revokeObjectURL: vi.fn() },
    document: { createElement(tag: string) {
      if (tag !== "canvas") return new Image();
      const canvas = { width: 0, height: 0,
        getContext: () => ({ fillRect: vi.fn(), drawImage: vi.fn() }),
        captureStream: (fps: number) => { captureRates.push(fps); return { getVideoTracks: () => [{ getSettings: () => ({ width: trackWidth ?? canvas.width, height: canvas.height }) }], getTracks: () => [{ stop }] }; } };
      canvases.push(canvas); return canvas;
    } },
  });
  for (const file of ["video-studio-contract.js", "video-production.js"]) vm.runInContext(readFileSync(new URL(root + file, import.meta.url), "utf8"), context);
  return { api: context.SZEcommerceVideoProduction as Api, canvases, recordingOptions, captureRates, stop };
}
function renderPlan(resolution: string, ratio: string, width: number, height: number) {
  return { version: 2, resolution, ratio, width, height, totalSeconds: 1, request: { resolution },
    shots: [{ id: "local-shot", kind: "local", sourceAssetId: "source", sourceKind: "image", durationSeconds: 1 }] };
}
const renderSettings = { preserveAudio: false, resolveAsset: async () => new Blob(["fixture"], { type: "image/png" }) };

describe("resolution preserved through production requests, budget and export", () => {
  it.each(sizes)("preserves $resolution in every AI shot and freezes its own output dimensions", ({ resolution, width, height }) => {
    for (const ratio of ["16:9", "9:16"]) {
      const input = request(resolution, "seedance-2.0", ratio), before = JSON.stringify(input), plan = api.buildPlan(input, options);
      expect(plan).toMatchObject({ version: 2, resolution, width: ratio === "9:16" ? height : width, height: ratio === "9:16" ? width : height });
      expect(plan.shots).toHaveLength(3); expect(plan.shots.every(shot => shot.request.resolution === resolution)).toBe(true);
      expect(plan.adjustments.join(" ")).not.toContain("统一以 720p"); expect(JSON.stringify(input)).toBe(before);
      expect(Object.isFrozen(plan)).toBe(true); expect(Object.isFrozen(plan.shots[0].request)).toBe(true);
    }
  });
  it.each([
    { model: "seedance-2.0-mini", resolution: "480p", rate: 1.16 }, { model: "seedance-2.0-mini", resolution: "720p", rate: 2.48 },
    { model: "seedance-2.0", resolution: "480p", rate: 2.31 }, { model: "seedance-2.0", resolution: "720p", rate: 4.97 },
    { model: "seedance-2.0", resolution: "1080p", rate: 12.39 }, { model: "seedance-2.0", resolution: "4k", rate: 25.27 },
    { model: "seedance-2.5", resolution: "480p", rate: 3.36 }, { model: "seedance-2.5", resolution: "720p", rate: 7.56 },
    { model: "seedance-2.5", resolution: "1080p", rate: 18.71 },
  ])("uses the official $model/$resolution five-second example, independent of canvas pixels", ({ model, resolution, rate }) => {
    const plan = api.buildPlan(request(resolution, model), options);
    expect(plan.shots.map(shot => shot.estimatedYuan)).toEqual([rate, rate, rate]);
    expect(plan.estimateYuan).toBe(Math.round(rate * 300) / 100);
    const reserve = Math.ceil(rate * 110) / 100;
    expect(plan.shots.every(shot => shot.reservedYuan === reserve)).toBe(true);
    expect(plan.reservedEstimateYuan).toBe(Math.round(reserve * 300) / 100);
  });
  it.each(["", "540p", "8k", "toString"])("rejects unknown resolution %s instead of replacing it with 720p", resolution => {
    expect(() => api.buildPlan(request(resolution), options)).toThrow(/不支持.*分辨率/);
    expect(() => api.estimateShot({ productKey: "seedance-2.0", durationSeconds: 5, request: request(resolution) })).toThrow(/没有已核对/);
  });
  it("rejects unsupported model/resolution pairs and does not switch the model to accommodate them", () => {
    expect(() => api.buildPlan(request("1080p", "seedance-2.0-mini"), options)).toThrow(/分辨率/);
    expect(() => api.buildPlan(request("4k", "seedance-2.5"), options)).toThrow(/分辨率/);
    expect(() => api.buildPlan(request("1080p"), { ...options, mode: "balanced" })).toThrow(/分辨率/);
    expect(() => api.estimateShot({ productKey: "seedance-2.5", durationSeconds: 5, request: request("4k", "seedance-2.5") })).toThrow(/没有已核对/);
  });
  it("keeps local-only production at the chosen output size with zero supplier cost", () => {
    const input = request("4k", "seedance-2.0-mini"); input.images = [{ id: "source", remoteUrl: "https://example.test/source.png", kind: "image", role: "product" }];
    input.rights = { confirmed: true, confirmedAt: new Date().toISOString(), fingerprint: contract.assetRightsFingerprint(input) };
    const plan = api.buildPlan(input, { ...options, mode: "economic" });
    expect(plan).toMatchObject({ resolution: "4k", width: 2160, height: 3840, estimateYuan: 0, reservedEstimateYuan: 0 });
  });
  it("does not estimate reference-video costs or change the two supported composition aspect ratios", () => {
    expect(() => api.estimateShot({ productKey: "seedance-2.0", durationSeconds: 5, request: { ...request("480p"), videos: [{}] } })).toThrow(/费用未计入/);
    expect(() => api.buildPlan(request("480p", "seedance-2.0", "1:1"), options)).toThrow(/仅支持 16:9 或 9:16/);
  });
  it.each(sizes)("creates a real $resolution canvas and requests an appropriate recorder bitrate", async ({ resolution, width, height, bitrate }) => {
    for (const ratio of ["16:9", "9:16"]) {
      const h = renderingHarness(), outputWidth = ratio === "9:16" ? height : width, outputHeight = ratio === "9:16" ? width : height;
      await expect(h.api.renderTimeline(renderPlan(resolution, ratio, outputWidth, outputHeight), renderSettings)).rejects.toMatchObject({ code: "PRODUCTION_RECORDER_RESOLUTION_UNSUPPORTED" });
      expect(h.canvases[0]).toMatchObject({ width: outputWidth, height: outputHeight });
      expect(h.recordingOptions).toEqual([expect.objectContaining({ videoBitsPerSecond: bitrate })]);
      expect(h.captureRates).toEqual([24]);
      expect(h.stop).toHaveBeenCalled();
    }
  });
  it("fails closed if a browser captures fewer pixels than the frozen 4k plan", async () => {
    const h = renderingHarness(1280);
    await expect(h.api.renderTimeline(renderPlan("4k", "16:9", 3840, 2160), renderSettings)).rejects.toMatchObject({ code: "PRODUCTION_CAPTURE_DIMENSIONS" });
    expect(h.canvases[0]).toMatchObject({ width: 3840, height: 2160 }); expect(h.recordingOptions).toEqual([]);
  });
  it("rejects inconsistent or future snapshots instead of silently rendering at another size", async () => {
    const h = renderingHarness();
    await expect(h.api.renderTimeline(renderPlan("480p", "16:9", 1280, 720), renderSettings)).rejects.toMatchObject({ code: "PRODUCTION_DIMENSIONS_MISMATCH" });
    await expect(h.api.renderTimeline({ ...renderPlan("720p", "16:9", 1280, 720), request: { resolution: "720p", ratio: "9:16" } }, renderSettings)).rejects.toMatchObject({ code: "PRODUCTION_DIMENSIONS_MISMATCH" });
    await expect(h.api.renderTimeline({ ...renderPlan("720p", "16:9", 1280, 720), version: 99 }, renderSettings)).rejects.toMatchObject({ code: "PRODUCTION_PLAN_VERSION_UNSUPPORTED" });
    expect(h.canvases).toEqual([]);
  });
  it.each([undefined, 1])("preserves historical 720p output for legacy version %s without mutating or rebuilding its request snapshot", async version => {
    const h = renderingHarness(), plan = { ...renderPlan("480p", "9:16", 720, 1280), version, resolution: undefined };
    const before = JSON.stringify(plan);
    await expect(h.api.renderTimeline(plan, renderSettings)).rejects.toMatchObject({ code: "PRODUCTION_RECORDER_RESOLUTION_UNSUPPORTED" });
    expect(h.canvases[0]).toMatchObject({ width: 720, height: 1280 }); expect(JSON.stringify(plan)).toBe(before);
    expect(h.recordingOptions[0].videoBitsPerSecond).toBe(4000000);
    expect(h.captureRates).toEqual([30]);
  });
});
