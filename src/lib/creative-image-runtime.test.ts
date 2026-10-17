import { readFileSync } from "node:fs";
import * as fs from "node:fs";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const publicRoot = fileURLToPath(new URL("../../public", import.meta.url));
const htmlPath = path.join(publicRoot, "creative/labs/image-prompt-lab/promptlab.html");
const scripts = [...readFileSync(htmlPath, "utf8").matchAll(/<script[^>]+src="([^"]+)"/g)]
  .map((match) => match[1].split("?")[0])
  .map((src) => src.startsWith("/") ? path.join(publicRoot, src) : path.resolve(path.dirname(htmlPath), src));

const expandedScripts = new Map<string, string[]>();
function scriptSources(file: string): string[] {
  const cached = expandedScripts.get(file);
  if (cached) return cached;
  if (!/^studio-(?:prerequisites|runtime|views)-[A-Za-z0-9_-]+\.js$/.test(path.basename(file))) return [file];
  const raw = readFileSync(file, "utf8");
  const markers = [...raw.matchAll(/\n;\n\/\* Frozen source: (public\/creative\/[^\r\n]+\.js) \*\/\n/g)];
  expect(markers.length, `Missing frozen source segments in ${file}`).toBeGreaterThan(0);
  const sources = markers.map((marker, index) => {
    const relative = marker[1].slice("public/".length);
    const sourceFile = path.resolve(publicRoot, relative);
    expect(path.relative(publicRoot, sourceFile).startsWith(".."), relative).toBe(false);
    const start = marker.index! + marker[0].length;
    const end = index + 1 < markers.length ? markers[index + 1].index! : raw.length;
    expect(raw.slice(start, end), `Frozen source bytes: ${relative}`).toBe(readFileSync(sourceFile, "utf8"));
    return sourceFile;
  });
  expect(new Set(sources).size, `Duplicate source segment in ${file}`).toBe(sources.length);
  expandedScripts.set(file, sources);
  return sources;
}

function storage() {
  const items = new Map<string, string>();
  return {
    get length() { return items.size; },
    key: (index: number) => [...items.keys()][index],
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key)
  };
}

function element() {
  return {
    value: "", textContent: "", innerHTML: "", className: "", hidden: true,
    style: {}, dataset: {}, checked: false,
    focus: vi.fn(), appendChild: vi.fn(), setAttribute: vi.fn(), getAttribute: vi.fn(),
    addEventListener: vi.fn(), querySelectorAll: () => [], querySelector: () => null,
    classList: { toggle: vi.fn(), add: vi.fn(), remove: vi.fn(), contains: () => false }
  };
}

function imageRuntime() {
  const elements = new Map<string, ReturnType<typeof element>>();
  const document = {
    readyState: "loading",
    getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id)!;
    },
    createElement: element,
    querySelectorAll: () => [],
    addEventListener: vi.fn()
  };
  const fetch = vi.fn(async (url: string) => {
    if (url !== "/api/auth/me") throw new Error("Unexpected upstream call in runtime test");
    return Response.json({ data: { tenantId: "tenant-a", username: "alice", creativeEntitlement: { allowed: true } } });
  });
  const context = vm.createContext({
    console, URL, URLSearchParams, Headers, Request, Response, FormData, Blob, ArrayBuffer, Uint8Array,
    AbortController, TextEncoder, TextDecoder, Promise, fetch,
    crypto: webcrypto,
    navigator: { locks: { request(_key: string, _options: unknown, callback: (lock: object) => unknown) { return Promise.resolve(callback({})); } } },
    // Register background startup hooks without running unrelated scheduled cleanup.
    setTimeout: vi.fn(), clearTimeout: vi.fn(), document,
    localStorage: storage(), sessionStorage: storage(),
    location: { href: "https://shaozhuangai.com/creative/labs/image-prompt-lab/promptlab.html?source=web", origin: "https://shaozhuangai.com", search: "?source=web" },
    __SZ_PROMPTLAB_BACKGROUND_TEST_MODE__: true,
    __SZ_PROMPTLAB_TEST_MODE__: true
  });
  context.window = context;
  const exportedContracts = new Map<string, unknown>();
  for (const file of scripts) {
    vm.runInContext(readFileSync(file, "utf8"), context, { filename: file, timeout: 2000 });
    if (scriptSources(file).some(sourceFile => sourceFile.endsWith("/background.js"))) {
      expect(context.openUnifiedApiSettings).toBeUndefined();
      expect(context.buildLinkPrompt).toBeUndefined();
      expect(context.configMutationTail).toBeUndefined();
      for (const key of ["SZ_REFERENCE_DETAIL_CONTRACT", "SZ_REFERENCE_DETAIL_BLUEPRINT", "SZ_REFERENCE_DETAIL_BATCH", "SZ_IMAGE_ARCHIVE", "SZ_CREATIVE_TOOLS_CONTRACT"]) {
        exportedContracts.set(key, context[key]);
      }
    }
  }
  return { context, document, fetch, exportedContracts };
}

function send(context: vm.Context, type: string, payload: object = {}) {
  return new Promise<Record<string, unknown>>((resolve) => {
    context.chrome.runtime.sendMessage({ type, payload }, resolve);
  });
}

describe("image studio background and UI coexistence", () => {
  it("loads all HTML scripts in order and retains explicit shared exports", () => {
    const { context, document, exportedContracts } = imageRuntime();
    expect(scripts.map((file) => path.relative(publicRoot, file).split(path.sep).join("/")
      .replace(/studio-(prerequisites|runtime|views)-[A-Za-z0-9_-]+\.js$/, "studio-$1.bundle.js"))).toEqual([
      "creative/web-chrome.js",
      "creative/labs/image-prompt-lab/studio-prerequisites.bundle.js",
      "creative/labs/image-prompt-lab/viral-series-contract.js",
      "creative/labs/image-prompt-lab/studio-runtime.bundle.js",
      "creative/labs/image-prompt-lab/sku-region-ui.js",
      "creative/labs/image-prompt-lab/sku-delivery-store.js",
      "creative/labs/image-prompt-lab/sku-durable-receipt.js",
      "creative/labs/image-prompt-lab/promptlab.js",
      "creative/labs/image-prompt-lab/studio-views.bundle.js",
      "creative/labs/image-prompt-lab/aesthetic-mirror-contract.js",
      "creative/labs/image-prompt-lab/aesthetic-mirror-ui.js",
      "creative/labs/image-prompt-lab/link-list-import.js",
      "creative/labs/image-prompt-lab/link-image-contract.js",
      "creative/labs/image-prompt-lab/link-image-result-actions.js",
      "creative/labs/image-prompt-lab/link-image-ui.js"
    ]);
    expect(scripts.flatMap(scriptSources).map((file) => path.relative(publicRoot, file).split(path.sep).join("/"))).toEqual([
      "creative/web-chrome.js",
      "creative/src/local-import.js",
      "creative/src/business-knowledge.js",
      "creative/src/subject-orchestration.js",
      "creative/src/subject-assets.js",
      "creative/src/reference-detail-contract.js",
      "creative/labs/image-prompt-lab/reference-detail-blueprint.js",
      "creative/labs/image-prompt-lab/reference-detail-batch.js",
      "creative/labs/image-prompt-lab/image-archive-store.js",
      "creative/labs/image-prompt-lab/guide-model-profile.js",
      "creative/labs/image-prompt-lab/viral-series-contract.js",
      "creative/labs/image-prompt-lab/style-refresh-contract.js",
      "creative/labs/image-prompt-lab/creative-tools-contract.js",
      "creative/labs/image-prompt-lab/studio-genesis-contract.js",
      "creative/labs/image-prompt-lab/scene-extension-contract.js",
      "creative/labs/image-prompt-lab/background.js",
      "creative/labs/image-prompt-lab/image-upload.js",
      "creative/credit-display.js",
      "creative/labs/image-prompt-lab/creative-credit-hints.js",
      "creative/labs/image-prompt-lab/sku-region-ui.js",
      "creative/labs/image-prompt-lab/sku-delivery-store.js",
      "creative/labs/image-prompt-lab/sku-durable-receipt.js",
      "creative/labs/image-prompt-lab/promptlab.js",
      "creative/labs/image-prompt-lab/creative-tools-ui.js",
      "creative/labs/image-prompt-lab/studio-genesis-ui.js",
      "creative/labs/image-prompt-lab/scene-extension-ui.js",
      "creative/labs/image-prompt-lab/studio-legacy-layout.js",
      "creative/labs/image-prompt-lab/viral-workflow-layout.js",
      "creative/labs/image-prompt-lab/viral-workflow-bridge.js",
      "creative/labs/image-prompt-lab/aesthetic-mirror-contract.js",
      "creative/labs/image-prompt-lab/aesthetic-mirror-ui.js",
      "creative/labs/image-prompt-lab/link-list-import.js",
      "creative/labs/image-prompt-lab/link-image-contract.js",
      "creative/labs/image-prompt-lab/link-image-result-actions.js",
      "creative/labs/image-prompt-lab/link-image-ui.js"
    ]);
    expect(document.addEventListener).toHaveBeenCalledWith("DOMContentLoaded", expect.any(Function));
    expect(typeof context.resolveUnifiedConfigReference).toBe("function");
    expect(context.resolveUnifiedConfigReference).toBe(context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.resolveUnifiedConfigReference);
    expect(exportedContracts.size).toBe(5);
    for (const [key, value] of exportedContracts) {
      expect(value).toBeTruthy();
      expect(context[key]).toBe(value);
    }
    expect(context.SZ_CREATIVE_TOOLS_CONTRACT.version).toBe("CREATIVE_TOOLS_V1");
    for (const key of ["createPlan", "createController", "validatePayload", "supportsReferenceConfig"]) {
      expect(typeof context.SZ_CREATIVE_TOOLS_CONTRACT[key]).toBe("function");
    }
    for (const key of ["send", "config", "archive", "getAccountKey", "ready", "listBoundApis", "selectBoundApi"]) {
      expect(typeof context.SZ_CREATIVE_TOOLS_BRIDGE[key]).toBe("function");
    }
    // Loading the additional script on the existing main-image route must not boot the creative workspace.
    expect(context.SZ_CREATIVE_TOOLS_UI).toBeUndefined();
    expect(context.normalizeCfg).not.toBe(context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.normalizeCfg);
    expect(context.saveReferenceDetailBlueprint).not.toBe(context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.saveReferenceDetailBlueprint);
    expect(context.loadReferenceDetailBlueprint).not.toBe(context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__.loadReferenceDetailBlueprint);
  });

  it("opens API settings through one message and the current authenticated UI bridge without recursion", async () => {
    const { context, document, fetch } = imageRuntime();
    const sendMessage = vi.spyOn(context.chrome.runtime, "sendMessage");
    const result = await context.openUnifiedApiSettings();
    expect(result).toMatchObject({ ok: true, centralized: true });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(document.getElementById("configModal").hidden).toBe(false);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
  });

  it("routes link prompt messages to background validation after the UI is loaded", async () => {
    const { context, fetch } = imageRuntime();
    const uiPrompt = vi.spyOn(context, "buildLinkPrompt");
    const result = await send(context, "BUILD_LINK_PROMPT");
    expect(result).toMatchObject({ ok: false, code: "missing_link_record" });
    expect(uiPrompt).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});


describe("website guide model dispatch", () => {
  const png = (() => {
    const bytes = Buffer.alloc(32);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    bytes.writeUInt32BE(1024, 16); bytes.writeUInt32BE(1024, 20); bytes[24] = 8; bytes[25] = 6;
    return `data:image/png;base64,${bytes.toString("base64")}`;
  })();

  for (const model of ["gpt-image-2", "gpt-image-2.5-sunburst"]) {
    for (const labMode of ["main", "detail"]) {
      it(`sends ${model} ${labMode} guide through GENERATE_IMAGE with its own strategy and parent`, async () => {
        const { context, fetch } = imageRuntime();
        context.applyCfg({ provider: "openai", apiKey: "test-only", imageModel: model, imageAdapter: "openai-images" });
        const api = context.__SZ_PROMPTLAB_TEST_API__;
        const item = {
          resultId: "current-result", url: png, labMode, detailMode: labMode === "detail" ? "link" : "main",
          ratio: "1:1", resolution: "1K", productImages: [png],
          prompt: "OLD ADVERTISEMENT DIRECTION", negativePrompt: "OLD NEGATIVE PROMPT",
          promptRecord: { id: "old-record", source: "reference", prompt: "OLD ADVERTISEMENT DIRECTION", data: {
            "主图规划": [{ "主标题": "OLD MAIN COPY" }], "屏幕规划": [{ "主标题": "OLD DETAIL COPY" }]
          } }
        };
        const draft = api.guideDraftForItem(item);
        expect(Object.isFrozen(draft.config)).toBe(true);
        const contract = api.createStructuredGuideContract({
          config: draft.config, scope: "current", mode: "general", guide: "只替换选中文字",
          issues: ["copy-remove-local"], textTarget: "旧文案", replacementText: "新文案",
          annotation: { mustStrokeCount: 1, editMaskDataUrl: png }, parentResultId: draft.parentResultId
        });
        expect(contract.valid).toBe(true);
        type CapturedGuideRequest = {
          config: { imageModel: string };
          payload: {
            guideContract: { modelProfile: { strategy: string }; parentResultId: string };
            sourceResultId: string; editBaseImage: string; productImages: string[];
            negativePrompt: string; prompt: string;
          };
        };
        const dispatched: Array<{ type: string; value: unknown }> = [];
        api.setTestSend(async (type: string, value: unknown) => {
          dispatched.push({ type, value });
          return { ok: false, error: "Synthetic dispatch captured before provider" };
        });
        const generationResult = await context.generateOne("guide", "引导重生", 1, {
          labMode, detailMode: item.detailMode, config: draft.config, generationSettings: draft.generationSettings,
          promptRecord: draft.promptRecord, guideContract: contract, editBaseImage: png, editMaskImage: png,
          sourceResultId: draft.parentResultId, productImages: draft.productImages, parentItem: item,
          negativePrompt: item.negativePrompt, detailTargetScreenIndex: 2, detailTargetScreenTotal: 8,
          detailScreenDirection: "OLD FROZEN DIRECTION", detailScreenPlan: { "主标题": "OLD SCREEN COPY" }
        });
        expect(dispatched.some(entry => entry.type === "GENERATE_IMAGE"), JSON.stringify(generationResult)).toBe(true);
        const request = dispatched.find(entry => entry.type === "GENERATE_IMAGE")!.value as CapturedGuideRequest;
        expect(request.config.imageModel).toBe(model);
        expect(request.payload.guideContract.modelProfile.strategy).toBe(model === "gpt-image-2" ? "image2-structured-edit-v1" : "sunburst-precise-edit-v1");
        expect(request.payload.sourceResultId).toBe("current-result");
        expect(request.payload.guideContract.parentResultId).toBe("current-result");
        expect(request.payload.editBaseImage).toBe(png);
        expect(request.payload.productImages).toEqual([png]);
        expect(request.payload.negativePrompt).toBe("");
        expect(request.payload.prompt).not.toMatch(/OLD|Create a new e-commerce|GENERATION MODE|screen 2 of 8|premium lighting/);
        expect(request.payload.prompt).toContain("旧文案");
        expect(request.payload.prompt).toContain("新文案");
        if (model.includes("sunburst")) expect(request.payload.prompt).not.toMatch(/STRUCTURED GUIDE|repairPath|L2|P1/);
        expect(fetch.mock.calls.every(([url]) => url === "/api/auth/me")).toBe(true);
      });
    }
  }

  it("captures the current configured model on opening and leaves a prior snapshot immutable", () => {
    const { context } = imageRuntime();
    const item = { url: png, resultId: "one", labMode: "main", productImages: [png], ratio: "1:1", resolution: "1K" };
    context.applyCfg({ provider: "openai", apiKey: "test-only", imageModel: "gpt-image-2" });
    const before = context.__SZ_PROMPTLAB_TEST_API__.guideDraftForItem(item);
    context.applyCfg({ provider: "openai", apiKey: "test-only", imageModel: "gpt-image-2.5-sunburst" });
    const after = context.__SZ_PROMPTLAB_TEST_API__.guideDraftForItem(item);
    expect(before.config.imageModel).toBe("gpt-image-2");
    expect(after.config.imageModel).toBe("gpt-image-2.5-sunburst");
    expect(context.SZ_GUIDE_MODEL_PROFILE.resolve(before.config).strategy).not.toBe(context.SZ_GUIDE_MODEL_PROFILE.resolve(after.config).strategy);
  });
});


// Provider calls below are VM mocks; no real provider or account is contacted.
const test = it;
const ROOT = path.join(publicRoot, "creative/labs/image-prompt-lab");
const profiles = createRequire(import.meta.url)(path.join(ROOT, "guide-model-profile.js"));
const event = () => ({ addListener() {} });
const clone = (value: unknown) => JSON.parse(JSON.stringify(value));

class FormDataRecorder {
  items: Array<{ name: string; value: unknown; filename?: string }>;
  constructor() { this.items = []; }
  append(name: string, value: unknown, filename?: string) { this.items.push({ name, value, filename }); }
  values(name: string) { return this.items.filter((item) => item.name === name); }
  value(name: string) { return this.values(name)[0]?.value; }
}

function loadBackground() {
  const requests: Array<{ url: string; options: { body: FormDataRecorder | string } }> = [];
  const chrome = {
    runtime: { lastError: null, getManifest: () => ({}), getURL: (p: string) => `chrome-extension://test/${p}`, onInstalled: event(), onMessage: event() },
    storage: { local: { get(_keys: unknown, cb: (value: object) => void) { cb({}); }, set(_v: unknown, cb?: () => void) { if (cb) cb(); }, remove(_v: unknown, cb?: () => void) { if (cb) cb(); } } },
    contextMenus: { removeAll(cb: () => void) { cb(); }, create() {}, onClicked: event() },
    action: { onClicked: event() }, tabs: { create() {}, sendMessage() {} }, scripting: { executeScript() {} }, downloads: { download() {} }
  };
  const context: vm.Context = {
    __SZ_PROMPTLAB_BACKGROUND_TEST_MODE__: true, chrome, console, URL, Date, Promise, AbortController, Blob,
    FormData: FormDataRecorder, setTimeout, clearTimeout,
    btoa: (v: string) => Buffer.from(v, 'binary').toString('base64'),
    atob: (v: string) => Buffer.from(v, 'base64').toString('binary'),
    fetch: async (url: string, options: { body: FormDataRecorder | string }) => {
      requests.push({ url, options });
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ url: 'https://result.test/repaired.png' }] }) };
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ['guide-model-profile.js', 'viral-series-contract.js', 'style-refresh-contract.js', 'background.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  }
  return { api: context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__, requests };
}

function config(model = 'gpt-image-2.5-sunburst', adapter = 'openai-images') {
  return { provider: 'openai', imageAdapter: adapter, imageModel: model, imageEndpoint: 'https://provider.test/v1/images/generations', apiKey: 'test-only' };
}

function png(width = 1024, height = 1024, marker = 1, length = 32) {
  const bytes = Buffer.alloc(length);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); bytes[24] = 8; bytes[25] = 6; bytes[26] = marker;
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

type GuideBackendPayload = {
  prompt: string; promptSource: string; productImages: string[]; editBaseImage: string; editMaskImage: string;
  strictLocalEdit: boolean; size: string; count: number; clarity: string; sourceResultId: string; negativePrompt?: string;
  guideContract: {
    version: string; scope: string; mode: string; repairPath: string; issue: string; evidenceLevel: string;
    minimumEvidence: string; outputType: string; parentResultId: string; guide: string;
    annotation: { mustStrokeCount: number; hasEditMask?: boolean }; postCompositeOutsideMask: boolean;
    modelProfile?: ReturnType<typeof profiles.resolve>; operation?: string; textTarget?: string; replacementText?: string;
  };
};
function payload(cfg = config()): GuideBackendPayload {
  return {
    prompt: 'Repair the selected product defect only.', promptSource: 'reference',
    productImages: [png(1024, 1024, 2)], editBaseImage: png(), editMaskImage: png(), strictLocalEdit: true,
    size: '1024*1024', count: 1, clarity: '4K', sourceResultId: 'result-1',
    guideContract: {
      version: 'GUIDE_REGEN_TEST_V1', scope: 'current', mode: 'subject', repairPath: 'L2', issue: 'subject-missing',
      evidenceLevel: 'E3', minimumEvidence: 'E2', outputType: 'formal', parentResultId: 'result-1', guide: 'Repair the selected product defect only.',
      annotation: { mustStrokeCount: 1 }, postCompositeOutsideMask: true, modelProfile: profiles.resolve(cfg)
    }
  };
}

test('Sunburst exact IDs, dated snapshots and gateway aliases select edit-first without rewriting model IDs', () => {
  for (const model of ['gpt-image-2.5-sunburst', 'GPT-IMAGE-2.5-SUNBURST-2026-09-22', 'Image-2.5-sunburst', 'image2.5-sunburst']) {
    const profile = profiles.resolve(config(`  ${model}  `));
    assert.equal(profile.model, model);
    assert.equal(profile.family, 'gpt-image-2.5-sunburst');
    assert.equal(profile.promptStyle, 'edit-first');
    assert.equal(profile.capability, 'mask-guided');
    assert.equal(profile.inputFidelity, false);
    assert.doesNotMatch(JSON.stringify(profile), /test-only|provider\.test/);
  }
  for (const model of ['gpt-image-2.50-sunburst', 'Image-2.50-sunburst', 'gpt-image-2.5', 'gpt-image-2.5-sunburst-unverified']) {
    const profile = profiles.resolve(config(model));
    assert.equal(profile.family, 'unknown');
    assert.equal(profile.promptStyle, 'structured-edit');
    assert.match(profile.label, /未验证/);
  }
});

test('model capability and fidelity stay separate from configured adapter transport', () => {
  for (const model of ['gpt-image-2', 'image2', 'gpt-image-2.5-sunburst']) {
    assert.equal(profiles.resolve(config(model, 'generic-json')).capability, 'client-composited-mask');
    for (const adapter of ['dashscope-wan', 'doubao-image', 'gemini-image', 'nano-banana']) {
      assert.equal(profiles.resolve(config(model, adapter)).capability, 'annotation-reference');
    }
  }
  for (const model of ['gemini-2.5-flash-image', 'doubao-seedream-4-5', 'wan2.7-image']) {
    assert.equal(profiles.resolve(config(model)).capability, 'annotation-reference', model);
  }
  for (const model of ['gpt-4o', 'gpt-5.4', 'claude-sonnet-4', 'gemini-2.5-pro', 'dall-e-3', 'cogview-4', 'wan2.2-t2i-plus']) {
    assert.equal(profiles.resolve(config(model)).capability, 'unsupported', model);
    assert.equal(profiles.resolve(config(model, 'generic-json')).capability, 'unsupported', model);
  }
  for (const model of ['gpt-image-1', 'gpt-image-1-2025-04-15', 'gpt-image-1.5']) assert.equal(profiles.resolve(config(model)).inputFidelity, true);
  for (const model of ['gpt-image-1-mini', 'gpt-image-2', 'Image-2.5-sunburst']) assert.equal(profiles.resolve(config(model)).inputFidelity, false);
  assert.equal(profiles.resolve({ imageAdapter: 'openai-images' }).capability, 'mask-guided');
});

test('bindings reject model/adapter/family/capability tampering and stale selection', () => {
  const cfg = config();
  const profile = profiles.resolve(cfg);
  assert.equal(profiles.sameBinding(profile, cfg), true);
  for (const key of ['model', 'adapter', 'family', 'capability', 'version']) {
    assert.equal(profiles.sameBinding({ ...profile, [key]: 'forged' }, cfg), false, key);
  }
  assert.equal(profiles.sameBinding(profile, config('gpt-image-2')), false);
  assert.equal(profiles.sameBinding(profile, config(cfg.imageModel, 'generic-json')), false);
});

test('new guide sizes preserve legal dimensions, never upgrade quality or pixel budget, leave legacy and SKU sizes alone', () => {
  const { api } = loadBackground();
  const cfg = config();
  for (const size of ['1024*1024', '2048*1536', '3840*2160']) {
    assert.equal(api.guideModelSizeForConfig(cfg, { ...payload(cfg), size }).size, size);
  }
  for (const size of ['1000*1000', '2049*1537', '4096*4096']) {
    const result = api.guideModelSizeForConfig(cfg, { ...payload(cfg), size });
    assert.equal(result.ok, true);
    const [w, h] = result.size.split('*').map(Number);
    const [a, b] = size.split('*').map(Number);
    assert.equal(w % 16, 0); assert.equal(h % 16, 0);
    assert.ok(w <= 3840 && h <= 3840 && w * h >= 655360 && w * h <= 8294400 && w * h <= a * b);
    assert.ok(Math.abs(Math.log((a / b) / (w / h))) <= 0.02);
    assert.ok(Math.abs(a / b - w / h) <= 0.019);
  }
  for (const size of ['256*256', '4096*512', '800*820', '1146*590', '1330*503', 'auto']) assert.equal(api.guideModelSizeForConfig(cfg, { ...payload(cfg), size }).ok, false, size);
  const legacy = payload(cfg); delete legacy.guideContract.modelProfile;
  assert.equal(api.guideModelSizeForConfig(cfg, { ...legacy, size: '100*100' }).size, '100*100');
  const sku = { ...payload(cfg), labMode: 'sku', promptSource: 'sku', detailMode: 'sku-guide', skuVisualLock: { version: 'SKU_SUBJECT_REPLACE_V2' }, size: '960*1280' };
  assert.equal(api.guideModelSizeForConfig(cfg, sku).size, '960*1280');
});

test('new guide request sends Sunburst model unchanged, edits+mask, legal size, without fidelity/quality/beautification', async () => {
  const { api, requests } = loadBackground();
  const cfg = config('Image-2.5-sunburst');
  const result = await api.createImageTask(cfg, { ...payload(cfg), size: '1000*1000' });
  assert.equal(result.ok, true, result.error);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://provider.test/v1/images/edits');
  const body = requests[0].options.body as FormDataRecorder;
  assert.equal(body.value('model'), 'Image-2.5-sunburst');
  assert.equal(body.value('size'), '992x992');
  assert.equal(body.value('input_fidelity'), undefined);
  assert.equal(body.value('quality'), undefined);
  assert.equal(body.values('mask').length, 1);
  assert.deepEqual(body.values('image[]').map((entry) => entry.filename), ['guide-edit-base.png', 'product-subject-1.png']);
  assert.doesNotMatch(String(body.value('prompt')), /premium|balanced lighting|high resolution|4K commercial/);
  assert.equal(result.guideModelProfile.family, 'gpt-image-2.5-sunburst');
  assert.equal(result.guideProviderSize, '992*992');
});

test('backend rejects stale profile, text model, oversized mask before network, while legacy guide still runs', async () => {
  const { api, requests } = loadBackground();
  const cfg = config();
  let result = await api.createImageTask(config('gpt-image-2'), payload(cfg));
  assert.equal(result.code, 'guide_model_profile_mismatch');
  const textCfg = config('gpt-4o');
  result = await api.createImageTask(textCfg, payload(textCfg));
  assert.equal(result.ok, false);
  assert.match(result.error, /不支持/);
  result = await api.createImageTask(cfg, { ...payload(cfg), editMaskImage: png(1024, 1024, 1, 4 * 1024 * 1024) });
  assert.equal(result.ok, false); assert.match(result.error, /4MB/);
  assert.equal(requests.length, 0);
  const legacy = payload(cfg); delete legacy.guideContract.modelProfile;
  result = await api.createImageTask(cfg, legacy);
  assert.equal(result.ok, true, result.error);
  assert.equal(requests.length, 1);
});

test('generic gateway receives recomputed safe profile and client-composited capability', async () => {
  const { api, requests } = loadBackground();
  const cfg = config('image2.5-sunburst', 'generic-json');
  const data = payload(cfg);
  data.guideContract.modelProfile.label = 'forged verified native';
  data.guideContract.modelProfile.promptStyle = 'forged';
  data.guideContract.modelProfile.apiKey = 'must-never-forward';
  const result = await api.createImageTask(cfg, data);
  assert.equal(result.ok, true, result.error);
  const body = JSON.parse(requests[0].options.body as string);
  assert.equal(body.model, 'image2.5-sunburst');
  assert.deepEqual(body.guide_contract.modelProfile, profiles.resolve(cfg));
  assert.equal(result.guideCapability, 'client-composited-mask');
  assert.doesNotMatch(JSON.stringify(body), /must-never-forward|forged/);
});

test('recognized non-GPT model on OpenAI transport sends annotation reference without native mask', async () => {
  const { api, requests } = loadBackground();
  const cfg = config('gemini-2.5-flash-image');
  const data = { ...payload(cfg), strictLocalEdit: false, guideAnnotationImage: png(1024, 1024, 3) };
  const result = await api.createImageTask(cfg, data);
  assert.equal(result.ok, true, result.error);
  const body = requests[0].options.body as FormDataRecorder;
  assert.equal(body.value('mask'), undefined);
  assert.ok(body.values('image[]').some((entry) => entry.filename === 'guide-annotation-reference.png'));
  assert.equal(result.guideCapability, 'annotation-reference');
  assert.match(result.guideWarning, /不能保证/);
});

test('SKU guide keeps base then evidence in provider inputs and never reintroduces full subject replacement', async () => {
  const { api, requests } = loadBackground();
  const cfg = config();
  const data = { ...payload(cfg), prompt: 'Repair the single selected missing handle.', labMode: 'sku', promptSource: 'sku', detailMode: 'sku-guide', skuVisualLock: { version: 'SKU_SUBJECT_REPLACE_V2' } };
  assert.deepEqual(clone(api.inputImagesFromPayload(data)), [data.editBaseImage, data.productImages[0]]);
  const result = await api.createOpenAIImage(cfg, data);
  assert.equal(result.ok, true, result.error);
  const body = requests[0].options.body as FormDataRecorder;
  assert.deepEqual(body.values('image[]').map((entry) => entry.filename), ['immutable-sku-base.png', 'replacement-subject.png']);
  const prompt = String(body.value('prompt'));
  assert.match(prompt, /Edit input image 1, the current selected result/);
  assert.match(prompt, /Product photos after image 1 prove product identity/);
  assert.match(prompt, /CHANGE: Repair the selected product defect only/);
  assert.doesNotMatch(prompt, /Replace only the original product subject|STRICT SKU SUBJECT REPLACEMENT CONTRACT|Input image 2 is the IMMUTABLE/);
  const standard = api.skuSubjectReplacePrompt({ ...data, detailMode: 'sku', guideContract: null });
  assert.match(standard, /STRICT SKU SUBJECT REPLACEMENT CONTRACT/);
});

test('guide disables generic clarity suffix and provider prompt extension while ordinary generation retains defaults', () => {
  const { api } = loadBackground();
  const cfg = config();
  const data = payload(cfg);
  assert.equal(api.generationClaritySuffix(data), '');
  assert.equal(api.generationPayload(cfg, data).parameters.prompt_extend, false);
  assert.match(api.generationClaritySuffix({ clarity: '4K' }), /4K/);
  assert.equal(api.generationPayload(cfg, { prompt: 'ordinary', productImages: [png()] }).parameters.prompt_extend, true);
});


test('backend reconstructs Sunburst-only prompt from its contract and rejects incompatible or changed endpoints before network', async () => {
  const { api, requests } = loadBackground();
  const cfg = config();
  const data = payload(cfg);
  data.prompt = 'OLD ENTIRE IMAGE REPLACEMENT WITH OLD COPY';
  data.negativePrompt = 'OLD LIGHTING AND NEGATIVE';
  data.guideContract.operation = 'replace-visible-text';
  data.guideContract.textTarget = '旧文字';
  data.guideContract.replacementText = '新文字';
  data.guideContract.guide = '只替换圈选文字';
  data.guideContract.annotation.hasEditMask = true;
  data.guideContract.modelProfile.strategyLabel = 'FORGED';
  const result = await api.createImageTask(cfg, data);
  assert.equal(result.ok, true, result.error);
  const body = requests[0].options.body as FormDataRecorder;
  assert.match(String(body.value('prompt')), /Replace only the exact visible text “旧文字” with “新文字”/);
  assert.doesNotMatch(String(body.value('prompt')), /OLD|FORGED|STRUCTURED GUIDE|Execution path:/);
  assert.equal(body.values('image[]').length, 0);
  assert.equal(body.values('image').length, 1);
  assert.equal(result.guideModelProfile.strategyLabel, 'Sunburst 精准编辑：修改 / 保留 / 证据');
  const originalRequests = requests.length;
  for (const endpoint of ['https://provider.test/v1/chat/completions', 'javascript:alert(1)', 'file:///tmp/image']) {
    const badCfg = { ...cfg, imageEndpoint: endpoint };
    const rejected = await api.createImageTask(badCfg, payload(badCfg));
    assert.equal(rejected.ok, false, endpoint);
  }
  const changed = await api.createImageTask({ ...cfg, imageEndpoint: 'https://provider.test/v1/chat/completions' }, payload(cfg));
  assert.equal(changed.code, 'guide_model_profile_mismatch');
  assert.equal(requests.length, originalRequests);
});

test('guide edits routing preserves query while replacing generation path and trailing slash', async () => {
  const { api, requests } = loadBackground();
  const cfg = { ...config(), imageEndpoint: 'https://provider.test/v1/images/generations/?route=edit' };
  const result = await api.createImageTask(cfg, payload(cfg));
  assert.equal(result.ok, true, result.error);
  assert.equal(requests[0].url, 'https://provider.test/v1/images/edits?route=edit');
});
