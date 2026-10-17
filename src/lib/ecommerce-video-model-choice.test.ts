import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners = new Map<string, () => void>();
  textContent = ""; value = ""; hidden = false; disabled = false;
  style = { setProperty() {} };
  classList = { add() {}, remove() {}, toggle() {} };
  append(...items: Element[]) { this.children.push(...items); }
  appendChild(item: Element) { this.children.push(item); return item; }
  replaceChildren(...items: Element[]) { this.children = items; }
  setAttribute(k: string, v: string) { this.attributes[k] = v; }
  getAttribute(k: string) { return this.attributes[k]; }
  querySelectorAll() { return []; } querySelector() { return null; }
  closest() { return this; }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, listener); }
  remove() {} showModal() {} scrollIntoView() {}
}

type Model = { productKey: string; configured: boolean; providerModelConfigured: boolean; resolutions: string[]; nativePlatform: boolean; allowedDurations: number[] };
type Plan = { aiSeconds: number; options: { budgetProductKey: string }; shots: { kind: string; productKey: string; request?: { productKey: string; resolution: string } }[] };
type Studio = {
  cacheDom(): void; bindProductionEvents(): void; renderProductionModelChoice(): void;
  normalizeModelCatalog(payload: unknown): Model[];
  normalizeSettingsSnapshot(raw: unknown, options?: unknown): { productKey: string; resolution: string };
  normalizeProductionOptions(raw?: unknown): { budgetYuan: number };
  previewProductionPlan(options?: { confirmed: boolean }): Plan; productionValidationErrors(): string[];
  buildRequest(stage: string): { durationSeconds: number; productionTimelineSeconds?: number };
  validateStoryboard(): string[]; analysisFingerprint(): string;
  narrationCapabilityText(capability?: unknown): string;
  draftSnapshot(): { productionOptions: { budgetProductKey: string } };
  productionModelLabel(plan: unknown, fallback: string): string;
  state: { modelCatalog: Model[]; backendConnected: boolean; credentialAvailable: boolean; legacySingle: boolean;
    productionOptions: Record<string, unknown>; settings: Record<string, unknown>; prompt: string; actionPending: boolean;
    mode: string; review: Record<string, unknown> };
};

function harness(fastAvailable = true) {
  const nodes = new Map<string, Element>();
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id)!; };
  const network = vi.fn(() => { throw new Error("No network allowed in model-choice regression"); });
  const send = vi.fn();
  const context = createContext({ console, URL, Blob, Promise, Map, Set, Date, AbortController,
    __SZ_VIDEO_STUDIO_EXPOSE_TESTING__: true, crypto: { randomUUID: () => "offline-model-test" },
    location: { href: "https://fixture.test/" }, setTimeout: () => 0, clearTimeout() {}, fetch: network,
    chrome: { runtime: { sendMessage: send } }, SZEcommerceVideoStore: {},
    document: { readyState: "loading", addEventListener() {}, getElementById: get, createElement: () => new Element(), querySelectorAll: () => [], querySelector: () => null }
  });
  for (const name of ["video-studio-contract.js", "video-production.js", "video-narration.js", "video-studio.js"]) {
    runInContext(readFileSync(resolve("public/creative/labs/ecommerce-video-studio", name), "utf8"), context);
  }
  const api = context.SZEcommerceVideoStudioTesting as Studio; api.cacheDom();
  api.state.modelCatalog = api.normalizeModelCatalog({ provider: "shaozhuang-native", models:
    ["seedance-2.0-mini", "seedance-2.0-fast", "seedance-2.0", "seedance-2.5"].map(productKey => ({
      productKey, providerModel: productKey, nativePlatform: true, configured: productKey !== "seedance-2.0-fast" || fastAvailable,
      limits: { durations: [5], resolutions: ["480p", "720p"], ratios: ["9:16", "16:9"], generateAudio: false }
    })) });
  api.state.backendConnected = true; api.state.credentialAvailable = true; api.state.legacySingle = false;
  api.state.prompt = "为白色陶瓷杯制作简洁的展示视频";
  api.state.productionOptions = { mode: "balanced", totalDurationSeconds: 30, hybridAiSeconds: 5, budgetYuan: 50, maxAttempts: 1, budgetProductKey: "seedance-2.0-mini" };
  return { api, get, send, network, inRealm: (value: unknown) => runInContext('JSON.parse(' + JSON.stringify(JSON.stringify(value)) + ')', context) };
}

describe("dynamic production uses the visible model and resolution", () => {
  it("sets a fresh default budget without changing a saved explicit budget", () => {
    const h = harness();
    expect(h.api.normalizeProductionOptions().budgetYuan).toBe(30);
    expect(h.api.normalizeProductionOptions({ mode: "economic", budgetYuan: 10, totalDurationSeconds: 15 }).budgetYuan).toBe(10);
  });
  it("shows the configured Fish model, exact voice and RMB rate per million UTF-8 bytes", () => {
    const h = harness(), text = h.api.narrationCapabilityText({ available: true, provider: "fish", providerLabel: "Fish Audio", model: "s2-pro", referenceId: "voice-id", rate: { currency: "CNY", unit: "utf8_bytes", perUnits: 1000000, centsPerUnit: 12000 } });
    expect(text).toContain("Fish Audio"); expect(text).toContain("模型 s2-pro"); expect(text).toContain("音色 voice-id");
    expect(text).toContain("¥120 / 100万 UTF-8 字节"); expect(text).not.toContain("字符");
  });
  it("shows missing Fish supply and preserves explicit free pricing without choosing a model or voice", () => {
    const h = harness(), missing = h.api.narrationCapabilityText({ available: false, provider: "fish", model: "", referenceId: "", missing: ["apiKey", "model", "referenceId", "rate"] });
    expect(missing).toContain("模型 未配置"); expect(missing).toContain("音色 未配置"); expect(missing).toContain("待配置：API Key、模型、音色 ID、人民币计价");
    const free = h.api.narrationCapabilityText({ available: true, provider: "fish", model: "s2.1-pro-free", referenceId: "chosen-voice", rate: { currency: "CNY", unit: "utf8_bytes", perUnits: 1000000, centsPerUnit: 0 } });
    expect(free).toContain("¥0 / 100万 UTF-8 字节"); expect(free).not.toContain("计价未配置"); expect(h.send).not.toHaveBeenCalled();
  });
  it("hides the former budget-model override and keeps the visible model enabled", () => {
    const h = harness(false); h.api.renderProductionModelChoice();
    expect(h.get("production-model-wrap").hidden).toBe(true);
    expect(h.get("production-model").disabled).toBe(true);
    expect(h.send).not.toHaveBeenCalled(); expect(h.network).not.toHaveBeenCalled();
  });

  it.each(["economic", "balanced", "quality"])("an old %s draft produces every new shot with the selected 2.0 at 480p", mode => {
    const h = harness(); h.api.state.productionOptions.mode = mode;
    h.api.state.settings.productKey = "seedance-2.0"; h.api.state.settings.resolution = "480p";
    const plan = h.api.previewProductionPlan();
    expect(plan.shots).toHaveLength(6);
    expect(plan.shots.every(x => x.kind === "ai" && x.request?.productKey === "seedance-2.0")).toBe(true);
    expect(plan.shots.every(x => x.request?.resolution === "480p")).toBe(true);
    expect(h.send).not.toHaveBeenCalled(); expect(h.network).not.toHaveBeenCalled();
  });

  it("keeps an unavailable selected model and blocks submission without choosing Mini", () => {
    const h = harness(false); h.api.state.settings.productKey = "seedance-2.0-fast";
    expect(h.api.previewProductionPlan().shots.every(x => x.productKey === "seedance-2.0-fast")).toBe(true);
    expect(h.api.productionValidationErrors().some(x => x.includes("Fast") && x.includes("不可用"))).toBe(true);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("duration and budget changes keep the selected model and resolution", () => {
    const h = harness(); h.api.state.settings.productKey = "seedance-2.0"; h.api.state.settings.resolution = "480p";
    h.api.bindProductionEvents(); h.get("production-duration").value = "45"; h.get("production-ai-seconds").value = "15";
    h.get("production-budget").value = "80"; h.get("production-attempts").value = "1";
    h.get("production-duration").listeners.get("change")!();
    expect(h.api.state.productionOptions).toMatchObject({ mode: "quality", totalDurationSeconds: 45, budgetYuan: 80 });
    expect(h.api.previewProductionPlan().shots.every(x => x.request?.productKey === "seedance-2.0" && x.request?.resolution === "480p")).toBe(true);
  });

  it("preserves independent script narration when the video model itself is silent", () => {
    const h = harness();
    const settings = h.api.normalizeSettingsSnapshot({ ...h.api.state.settings, audioMode: "narration", resolution: "480p" }, { modelCatalog: h.api.state.modelCatalog, productionPlan: true });
    expect(settings).toMatchObject({ audioMode: "narration", resolution: "480p" });
    const legacy = h.api.normalizeSettingsSnapshot({ ...h.api.state.settings, audioMode: "narration" }, { modelCatalog: h.api.state.modelCatalog });
    expect(legacy).toMatchObject({ audioMode: "silent" });
  });

  it.each([30, 60])("keeps a %s-second confirmed storyboard independent from the provider's per-shot duration", totalSeconds => {
    const h = harness(); h.api.state.mode = "assist"; h.api.state.productionOptions.totalDurationSeconds = totalSeconds;
    h.api.state.settings.durationSeconds = 15; h.api.state.settings.audioMode = "narration"; h.api.state.settings.creativeRoute = "free_direct";
    const storyboard = Array.from({ length: totalSeconds / 5 }, (_, index) => ({
      id: "scene-" + index, order: index + 1, durationSeconds: 5, startSecond: index * 5, endSecond: (index + 1) * 5,
      visual: "人物连续走动", motion: "从上一个姿态继续向右迈步", narration: "第" + (index + 1) + "句确认台词"
    }));
    h.api.state.review = h.inRealm({ script: "按确认台词展示商品", storyboard, confirmed: true, confirmedAt: "2026-10-16T12:00:00.000Z" });
    expect(h.api.validateStoryboard()).toEqual([]);
    expect(h.api.buildRequest("draft")).toMatchObject({ durationSeconds: 15, productionTimelineSeconds: totalSeconds });
    const plan = h.api.previewProductionPlan({ confirmed: true });
    expect(plan.shots).toHaveLength(totalSeconds / 5);
    expect(plan.shots.every(x => x.kind === "ai")).toBe(true);
    const fingerprint = h.api.analysisFingerprint(); h.api.state.productionOptions.totalDurationSeconds = totalSeconds === 30 ? 60 : 30;
    expect(h.api.analysisFingerprint()).not.toBe(fingerprint); expect(h.api.validateStoryboard().length).toBe(1);
  });

  it("retains accurate historical Mini labels while v2 labels use its stored selected model", () => {
    const h = harness();
    expect(h.api.productionModelLabel({ aiSeconds: 10, options: { mode: "economic", budgetProductKey: "seedance-2.0-fast" } }, "seedance-2.0")).toBe("素材 + Seedance 2.0 Fast");
    expect(h.api.productionModelLabel({ version: 2, request: { productKey: "seedance-2.0" }, options: { mode: "economic" } }, "seedance-2.0-mini")).toBe("Seedance 2.0");
    expect(h.api.productionModelLabel({ aiSeconds: 0, options: { mode: "economic" } }, "seedance-2.0-fast")).toBe("本地素材合成");
  });
});
