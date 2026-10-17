import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Element {
  hidden = false; disabled = false; checked = false; textContent = ""; className = ""; value = "";
  dataset: Record<string, string> = {}; children: Element[] = [];
  style = { display: "", setProperty: vi.fn() };
  listeners = new Map<string, (event: unknown) => unknown>();
  classList = { add: vi.fn(), toggle: vi.fn() };
  appendChild(child: Element) { this.children.push(child); return child; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  querySelector() { return null; } querySelectorAll() { return []; }
  closest() { return new Element(); }
  setAttribute() {} addEventListener(event: string, handler: (event: unknown) => unknown) { this.listeners.set(event, handler); }
}
type Request = { resolution: string; ratio: string; productKey: string; durationSeconds: number };
type Plan = { resolution: string; width: number; height: number; estimateYuan: number; reservedEstimateYuan: number; shots: Array<{request: Request}> };
type Run = { id: string; resolution: string; status: string; plan: Plan };
type Model = { productKey: string; configured: boolean; resolutions: string[]; nativePlatform?: boolean; billingMode?: string; submissionQuotes?: unknown[] };
type State = { accountKey: string; backendConnected: boolean; credentialAvailable: boolean; prompt: string; legacySingle: boolean;
  productionOptions: { mode: string; totalDurationSeconds: number; hybridAiSeconds: number; budgetYuan: number; maxAttempts: number };
  settings: { productKey: string; resolution: string; ratio: string; creativeRoute: string; durationSeconds: number }; modelCatalog: Model[];
  productionRun: Run | null };
type Api = { state: State; cacheDom(): void; bindProductionEvents(): void; syncSettingsFromDom(options: object): void; syncParameterControlsForModel(): void;
  productionTemplate(options?: object): Request; normalizeSettingsSnapshot(raw: object, options?: object): Request;
  productionValidationErrors(options?: object): string[]; startProductionGeneration(): Promise<void>; renderProductionOptions(): void; updateEstimate(): void };
function harness(resolution = "480p") {
  const base = "../../public/creative/labs/ecommerce-video-studio/";
  const html = readFileSync(new URL(base + "video-studio.html", import.meta.url), "utf8");
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const radios = new Map(["resolution", "aspect-ratio", "audio-mode"].map(name => [name,
    (name === "resolution" ? ["480p", "720p", "1080p", "4k"] : name === "aspect-ratio" ? ["9:16", "16:9"] : ["silent"]).map(value => Object.assign(new Element(), { value, checked: value === (name === "resolution" ? resolution : name === "aspect-ratio" ? "9:16" : "silent") }))]));
  const saved: Run[] = [];
  const store = { saveRun: vi.fn(async (run: Run) => { saved.push(structuredClone(run)); return run; }), listRuns: vi.fn(async () => []), saveDraft: vi.fn() };
  const messages = vi.fn((message: { type: string; payload: { request?: Request } }, callback: (reply: unknown) => void) => callback({ ok: true, payload: { task: {
    id: "fixture-no-supplier-call", status: "failed", providerSubmitted: false, error: { code: "FIXTURE_STOP", message: "No real provider request" }
  } } }));
  const context = vm.createContext({ console, URL, AbortController, CSS: { escape: (value: string) => value }, setTimeout: () => 1, clearTimeout: () => {},
    document: { readyState: "loading", addEventListener: vi.fn(), getElementById: (id: string) => nodes.get(id) || null, createElement: () => new Element(),
      querySelector: (selector: string) => { const match = /input\[name="([^"]+)"\]:checked/.exec(selector); if (match) return radios.get(match[1])?.find(r => r.checked) || null; const valueMatch = /input\[name="([^"]+)"\]\[value="([^"]+)"\]/.exec(selector); return valueMatch ? radios.get(valueMatch[1])?.find(r => r.value === valueMatch[2]) || null : null; },
      querySelectorAll: (selector: string) => { const match = /input\[name="([^"]+)"\]/.exec(selector); return match ? radios.get(match[1]) || [] : []; } },
    __SZ_VIDEO_STUDIO_EXPOSE_TESTING__: true, SZEcommerceVideoStore: store, chrome: { runtime: { sendMessage: messages } } });
  for (const file of ["video-studio-contract.js", "video-production.js", "video-studio.js"]) vm.runInContext(readFileSync(new URL(base + file, import.meta.url), "utf8"), context);
  const api = context.SZEcommerceVideoStudioTesting as Api;
  api.cacheDom(); Object.assign(api.state, { accountKey: "fixture:alice", backendConnected: true, credentialAvailable: true, prompt: "Fixture product presentation", legacySingle: false,
    productionOptions: { mode: "quality", totalDurationSeconds: 15, hybridAiSeconds: 0, budgetYuan: 200, maxAttempts: 1 } });
  Object.assign(api.state.settings, { productKey: "seedance-2.0", resolution, ratio: "9:16", creativeRoute: "free_direct", durationSeconds: 5 });
  api.state.modelCatalog.forEach(model => { model.configured = true; });
  nodes.get("model-select")!.value = "seedance-2.0"; nodes.get("duration-input")!.value = "5";
  const production = context.SZEcommerceVideoProduction as { buildPlan(request: Request, options: object): Plan };
  return { api, nodes, radios, saved, messages, production };
}

describe("resolution choice through real studio planning and runtime messages", () => {
  it.each([
    { resolution: "480p", width: 480, height: 854, estimate: 6.93 },
    { resolution: "720p", width: 720, height: 1280, estimate: 14.91 },
    { resolution: "1080p", width: 1080, height: 1920, estimate: 37.17 },
    { resolution: "4k", width: 2160, height: 3840, estimate: 75.81 }
  ])("preserves $resolution from the selected radio through shot submission and output metadata", async ({ resolution, width, height, estimate }) => {
    const h = harness(resolution);
    h.api.syncSettingsFromDom({ silent: true });
    expect(h.api.state.settings.resolution).toBe(resolution);
    expect(h.api.productionTemplate().resolution).toBe(resolution);
    await h.api.startProductionGeneration();
    const run = h.saved[0]; expect(run).toMatchObject({ resolution, plan: { resolution, width, height, estimateYuan: estimate } });
    expect(run.plan.shots).toHaveLength(3);
    expect(run.plan.shots.every(shot => shot.request.resolution === resolution)).toBe(true);
    const start = h.messages.mock.calls.find(([message]) => message.type === "VIDEO_STUDIO_START")?.[0];
    expect(start?.payload.request?.resolution).toBe(resolution);
    expect(h.nodes.get("production-note")!.textContent).toContain(resolution);
    expect(h.nodes.get("production-note")!.textContent).toContain(`${width}×${height}`);
  });
  it("switching a cost preset keeps the selected resolution", () => {
    const h = harness("480p"); h.api.bindProductionEvents();
    h.nodes.get("production-modes")!.listeners.get("click")!({ target: { closest: () => ({ dataset: { productionMode: "balanced" } }) } });
    expect(h.api.state.settings.resolution).toBe("480p");
    const plan = h.production.buildPlan(h.api.productionTemplate(), h.api.state.productionOptions);
    expect(plan.shots.every(shot => shot.request.resolution === "480p")).toBe(true);
  });
  it("unsupported resolution survives draft/capability refresh and blocks every submission", async () => {
    const h = harness("4k"); h.api.state.settings.productKey = "seedance-2.0-mini";
    h.api.syncParameterControlsForModel();
    expect(h.api.state.settings.resolution).toBe("4k");
    expect(h.nodes.get("resolution-help")!.textContent).toContain("不支持所选 4k");
    const restored = h.api.normalizeSettingsSnapshot({ productKey: "seedance-2.0-mini", resolution: "4k" }, { modelCatalog: h.api.state.modelCatalog });
    expect(restored.resolution).toBe("4k");
    await h.api.startProductionGeneration();
    expect(h.saved).toHaveLength(0); expect(h.messages).not.toHaveBeenCalled();
  });
  it("a supplier catalog that only permits 720p cannot silently submit a 480p choice", async () => {
    const h = harness("480p"); h.api.state.modelCatalog.find(model => model.productKey === "seedance-2.0")!.resolutions = ["720p"];
    expect(h.api.productionValidationErrors({ requireReview: true }).join(" ")).toContain("不支持 480p");
    await h.api.startProductionGeneration(); expect(h.messages).not.toHaveBeenCalled(); expect(h.saved).toHaveLength(0);
  });
  it("an existing 720p plan retains its original snapshot after the user selects 480p", async () => {
    const h = harness("720p"); const plan = h.production.buildPlan(h.api.productionTemplate(), h.api.state.productionOptions);
    const previous = { id: "fixture-original", status: "processing", resolution: "720p", plan, shotRuns: [] };
    h.api.state.productionRun = previous; h.api.state.settings.resolution = "480p";
    const snapshot = JSON.stringify(previous);
    await h.api.startProductionGeneration();
    expect(JSON.stringify(previous)).toBe(snapshot); expect(h.saved).toHaveLength(0); expect(h.messages).not.toHaveBeenCalled();
  });
});
