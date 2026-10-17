import { readFileSync } from "node:fs";
import * as fs from "node:fs";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
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

// Reviewed frozen-pack inventory: exact leaf order with pinned raw and loaded
// SHA-256 per leaf. 19 leaves are byte-identical; 5 reviewed published drifts
// (reference-detail-contract, reference-detail-blueprint, creative-tools-contract,
// background, studio-genesis-ui) keep separate raw and loaded pins. Never derived
// from the code under test; any other difference, order change, duplicate or
// path outside public/creative fails.
const FROZEN_LEAVES: Record<string, Array<{ source: string; raw: string; loaded: string }>> = {
  "studio-prerequisites-20261009-v1.js": [
    { source: "creative/src/local-import.js", raw: "5f2020a015f672a9aa2ad9dcdb33b5551af0b7117d5ac8ccffecfdd2300eed57", loaded: "5f2020a015f672a9aa2ad9dcdb33b5551af0b7117d5ac8ccffecfdd2300eed57" },
    { source: "creative/src/business-knowledge.js", raw: "e5e60f61fb28736752e64ac64bec8b5cbe57aa052aece0623adb3a9e6d6ffa78", loaded: "e5e60f61fb28736752e64ac64bec8b5cbe57aa052aece0623adb3a9e6d6ffa78" },
    { source: "creative/src/subject-orchestration.js", raw: "23dfdf1fbd0cc6fded96678ea53e402225b1f243621b638174ec4b59b026a6f2", loaded: "23dfdf1fbd0cc6fded96678ea53e402225b1f243621b638174ec4b59b026a6f2" },
    { source: "creative/src/subject-assets.js", raw: "75ab6f95c3c087bd4e6ebd84abb8cad96873af4cda207114dbda6bef6d1c40b1", loaded: "75ab6f95c3c087bd4e6ebd84abb8cad96873af4cda207114dbda6bef6d1c40b1" },
    { source: "creative/src/reference-detail-contract.js", raw: "d30bab12b893642d847ae3dac5a69d12c4b9027a38d465e01562ec5dc42deb68", loaded: "e23d4e47f5ca346641772ae41a0e47ef50d0ac89aaed0691688d99a5cddc3a2a" },
    { source: "creative/labs/image-prompt-lab/reference-detail-blueprint.js", raw: "ed194765709b06adbfe7c27dc64d407a31f7ac6c9a7024755591b304a60711b6", loaded: "ef9dedea3027d7a2c9178178780cef05c8071f73025305fc1255da7a783f45c9" },
    { source: "creative/labs/image-prompt-lab/reference-detail-batch.js", raw: "d56a05ec814d96a8fb585414683018a220aad4e4afbb73240e1a9793e9e9122b", loaded: "d56a05ec814d96a8fb585414683018a220aad4e4afbb73240e1a9793e9e9122b" },
    { source: "creative/labs/image-prompt-lab/image-archive-store.js", raw: "097a6e2a51dd82cdb3285ad1b70de62c0b45e03be93eff823710e182eba19542", loaded: "097a6e2a51dd82cdb3285ad1b70de62c0b45e03be93eff823710e182eba19542" },
    { source: "creative/labs/image-prompt-lab/guide-model-profile.js", raw: "7040759b204a896efd07cee8d0edb26a720b794cf041a9e14e122deab5fd9b17", loaded: "7040759b204a896efd07cee8d0edb26a720b794cf041a9e14e122deab5fd9b17" },
  ],
  "studio-runtime-20261010-credit-v3.js": [
    { source: "creative/labs/image-prompt-lab/style-refresh-contract.js", raw: "5d33e00059cf0ce35772e352a54135d4da525edead6e4159cee48b66f8bfd38e", loaded: "5d33e00059cf0ce35772e352a54135d4da525edead6e4159cee48b66f8bfd38e" },
    { source: "creative/labs/image-prompt-lab/creative-tools-contract.js", raw: "ed4d3e37f4af64eb4451230c168587ffbb16683884f76120e1937777b7f06607", loaded: "2ab7031c678f566560d6ef190c26c52d1625c8e02dc975991a0d84115f89d960" },
    { source: "creative/labs/image-prompt-lab/studio-genesis-contract.js", raw: "912f2d35628ae23f87975dba6e36475502ea7803af151219c3698b6a29bb4dc8", loaded: "912f2d35628ae23f87975dba6e36475502ea7803af151219c3698b6a29bb4dc8" },
    { source: "creative/labs/image-prompt-lab/scene-extension-contract.js", raw: "a5c901cd13f318592c2a28020dc966249ad2db7c38e66def00dc783a2b7d3bcb", loaded: "a5c901cd13f318592c2a28020dc966249ad2db7c38e66def00dc783a2b7d3bcb" },
    { source: "creative/src/knowledge-output-contract.js", raw: "17a5bed48816604a3ef17413024d6db48d037e39005c8ed8e128d69f2d087948", loaded: "17a5bed48816604a3ef17413024d6db48d037e39005c8ed8e128d69f2d087948" },
    { source: "creative/labs/image-prompt-lab/background.js", raw: "cd693992b18ec31beabdbc242c087f5e68ed36cd215344a3adf8b6c867df5fd5", loaded: "d2b2de7dae61eaaadb9dfa1be42ce4832d89e4542bed4f7e9baeda2a885949e7" },
    { source: "creative/labs/image-prompt-lab/image-upload.js", raw: "5dffe2fd3e2d24007fe21898201f367cda6d5d3b9d328da3d63da4e8309f4812", loaded: "5dffe2fd3e2d24007fe21898201f367cda6d5d3b9d328da3d63da4e8309f4812" },
    { source: "creative/credit-display.js", raw: "da5199bcd6791d7627ec6c4f9dc14169db973847e16c687a2dc31537ff8784d7", loaded: "da5199bcd6791d7627ec6c4f9dc14169db973847e16c687a2dc31537ff8784d7" },
    { source: "creative/labs/image-prompt-lab/creative-credit-hints.js", raw: "8c5f10a9a61419534401c9fc04919a44579b6b507f97fb84833b03d8cabc741b", loaded: "8c5f10a9a61419534401c9fc04919a44579b6b507f97fb84833b03d8cabc741b" },
  ],
  "studio-views-20261010-credit-v3.js": [
    { source: "creative/labs/image-prompt-lab/creative-tools-ui.js", raw: "8e9a54bd99a7fbdca8321720fe33329d68fd9f2a4d5b39c247279c0ba751bd49", loaded: "8e9a54bd99a7fbdca8321720fe33329d68fd9f2a4d5b39c247279c0ba751bd49" },
    { source: "creative/labs/image-prompt-lab/studio-genesis-ui.js", raw: "87e12c85d31ed3e701b6e97a884ef14042a7658ba31c7a56978ca4b625105c8f", loaded: "2f156614449a3118f6252cb868df127e623675b1bad1c37fb0355572b647b6a7" },
    { source: "creative/labs/image-prompt-lab/scene-extension-ui.js", raw: "268a64b67f7c644dc67ebe0ea271536713d39a09e8b9172a1f1e3255f5ed2263", loaded: "268a64b67f7c644dc67ebe0ea271536713d39a09e8b9172a1f1e3255f5ed2263" },
    { source: "creative/labs/image-prompt-lab/studio-legacy-layout.js", raw: "3681f7afef2193e2444902f075eeb3de4e0fa36474eaec6ff20b9e83c662679a", loaded: "3681f7afef2193e2444902f075eeb3de4e0fa36474eaec6ff20b9e83c662679a" },
    { source: "creative/labs/image-prompt-lab/viral-workflow-layout.js", raw: "8315c049c884dbb8aad8864c0bbd2cb56abfbe13ce1aee744b89960a939bd944", loaded: "8315c049c884dbb8aad8864c0bbd2cb56abfbe13ce1aee744b89960a939bd944" },
    { source: "creative/labs/image-prompt-lab/viral-workflow-bridge.js", raw: "64e160b8d0d5b8314a811875e065c5a06ef52b662c2d6b03e0af0dcfdf75b1ad", loaded: "64e160b8d0d5b8314a811875e065c5a06ef52b662c2d6b03e0af0dcfdf75b1ad" },
  ],
};
const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const FROZEN_MARKER = /\n;\n\/\* Frozen source: (public\/creative\/[^\r\n]+\.js) \*\/\n/g;

// Validate one frozen pack against the pinned inventory and return its raw source files.
function validateFrozenPack(name: string, text: string, readRaw: (file: string) => Buffer): string[] {
  const expected = FROZEN_LEAVES[name];
  if (!expected) throw new Error(`Unreviewed frozen pack: ${name}`);
  const markers = [...text.matchAll(FROZEN_MARKER)];
  if (!markers.length || markers[0].index !== 0) throw new Error(`Frozen pack ${name} has unmarked leading bytes`);
  const leaves = markers.map((marker, index) => ({ source: marker[1].slice("public/".length),
    bytes: text.slice(marker.index! + marker[0].length, index + 1 < markers.length ? markers[index + 1].index! : text.length) }));
  const sources = leaves.map(leaf => leaf.source);
  if (new Set(sources).size !== sources.length) throw new Error(`Duplicate source segment in ${name}`);
  if (JSON.stringify(sources) !== JSON.stringify(expected.map(leaf => leaf.source))) throw new Error(`Frozen leaf order changed in ${name}: ${sources.join(", ")}`);
  return leaves.map((leaf, index) => {
    const pin = expected[index], file = path.resolve(publicRoot, leaf.source);
    if (path.relative(path.join(publicRoot, "creative"), file).startsWith("..")) throw new Error(`Frozen leaf escapes public/creative: ${leaf.source}`);
    const raw = readRaw(file);
    if (sha256(leaf.bytes) !== pin.loaded) throw new Error(`Loaded bytes changed for ${leaf.source} in ${name}`);
    if (sha256(raw) !== pin.raw) throw new Error(`Raw source changed for ${leaf.source}`);
    if (pin.raw === pin.loaded && leaf.bytes !== raw.toString("utf8")) throw new Error(`Identical leaf differs from raw: ${leaf.source}`);
    return file;
  });
}

const expandedScripts = new Map<string, string[]>();
function scriptSources(file: string): string[] {
  const cached = expandedScripts.get(file);
  if (cached) return cached;
  if (!/^studio-(?:prerequisites|runtime|views)-[A-Za-z0-9_-]+\.js$/.test(path.basename(file))) return [file];
  const sources = validateFrozenPack(path.basename(file), readFileSync(file, "utf8"), source => readFileSync(source));
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

describe("frozen pack integrity against the reviewed inventory", () => {
  const packFile = (name: string) => path.join(publicRoot, "creative/labs/image-prompt-lab", name);
  it("pins every loaded leaf and raw source, with 19 identical leaves and 5 reviewed drifts", () => {
    let identical = 0, drift = 0;
    for (const name of Object.keys(FROZEN_LEAVES)) {
      expect(validateFrozenPack(name, readFileSync(packFile(name), "utf8"), file => readFileSync(file))).toHaveLength(FROZEN_LEAVES[name].length);
      for (const leaf of FROZEN_LEAVES[name]) leaf.raw === leaf.loaded ? identical++ : drift++;
    }
    expect([identical, drift]).toEqual([19, 5]);
    expect(Object.values(FROZEN_LEAVES).flat().filter(leaf => leaf.raw !== leaf.loaded).map(leaf => leaf.source)).toEqual([
      "creative/src/reference-detail-contract.js", "creative/labs/image-prompt-lab/reference-detail-blueprint.js",
      "creative/labs/image-prompt-lab/creative-tools-contract.js", "creative/labs/image-prompt-lab/background.js",
      "creative/labs/image-prompt-lab/studio-genesis-ui.js"
    ]);
  });
  it("rejects unknown drift, reordering, duplicates and leaves outside public/creative", () => {
    const name = "studio-views-20261010-credit-v3.js", text = readFileSync(packFile(name), "utf8"), read = (file: string) => readFileSync(file);
    const marker = (source: string) => `\n;\n/* Frozen source: public/${source} */\n`;
    expect(() => validateFrozenPack(name, text.replace("function render", "function renderChanged"), read)).toThrow(/Loaded bytes changed/);
    expect(() => validateFrozenPack(name, text, file => file.endsWith("scene-extension-ui.js") ? Buffer.from("changed") : readFileSync(file))).toThrow(/Raw source changed/);
    const [first, second] = FROZEN_LEAVES[name];
    const firstStart = text.indexOf(marker(first.source)), secondStart = text.indexOf(marker(second.source));
    const swapped = text.slice(secondStart, text.indexOf(marker(FROZEN_LEAVES[name][2].source))) + text.slice(firstStart, secondStart) + text.slice(text.indexOf(marker(FROZEN_LEAVES[name][2].source)));
    expect(() => validateFrozenPack(name, swapped, read)).toThrow(/order changed/);
    expect(() => validateFrozenPack(name, text + marker(first.source) + "dup", read)).toThrow(/Duplicate source segment/);
    expect(() => validateFrozenPack(name, text.replace(marker(first.source), marker("creative/../../etc/escape.js")), read)).toThrow(/order changed|escapes/);
    expect(() => validateFrozenPack("studio-views-unreviewed.js", text, read)).toThrow(/Unreviewed frozen pack/);
  });
});

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
      "creative/src/knowledge-output-contract.js",
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
