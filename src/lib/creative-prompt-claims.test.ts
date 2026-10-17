import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const publicRoot = fileURLToPath(new URL("../../public", import.meta.url));
const htmlPath = path.join(publicRoot, "creative/labs/image-prompt-lab/promptlab.html");

function claimsContract() {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(path.join(publicRoot, "creative/src/knowledge-output-contract.js"), "utf8"), context);
  return context.SZKnowledgeOutputContract;
}

function backgroundRuntime() {
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
  const fetch = vi.fn(() => { throw new Error("Claims validation must remain offline"); });
  const context = vm.createContext({
    console, URL, URLSearchParams, Headers, Request, Response, Blob, FormData,
    AbortController, TextEncoder, TextDecoder, Promise, fetch,
    setTimeout: vi.fn(), clearTimeout: vi.fn(), localStorage: storage(), sessionStorage: storage(),
    document: { readyState: "loading", getElementById: () => null, querySelectorAll: () => [], addEventListener: vi.fn() },
    location: { href: "https://shaozhuangai.com/creative/labs/image-prompt-lab/promptlab.html?source=web", origin: "https://shaozhuangai.com", search: "?source=web" },
    __SZ_PROMPTLAB_BACKGROUND_TEST_MODE__: true
  });
  context.window = context;
  // Load the actual page prerequisites and background, without the unrelated UI.
  for (const match of readFileSync(htmlPath, "utf8").matchAll(/<script[^>]+src="([^"]+)"/g)) {
    const source = match[1].split("?")[0];
    const file = source.startsWith("/") ? path.join(publicRoot, source) : path.resolve(path.dirname(htmlPath), source);
    vm.runInContext(readFileSync(file, "utf8"), context, { filename: file, timeout: 2000 });
    if (file.endsWith("/background.js")) break;
  }
  return { api: context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__, fetch };
}

describe("prompt claim measurement classification", () => {
  it.each([
    { 镜头: "85mm商业人像焦段" },
    { 镜头: "85mm" },
    { 焦距: "50毫米" },
    { 中文提示词: "使用85mm摄影镜头拍摄，商品居中" },
    { 中文提示词: "摄影焦距：50mm，平视构图" },
    { 画面方向: "使用35 mm广角镜头拍摄，保留环境层次" },
    { imagePrompt: "Use an 85mm lens for the photograph" }
  ])("recognizes camera execution parameters without product evidence: %j", (output) => {
    expect(claimsContract().validateGeneratedClaims(output)).toMatchObject({ ok: true, violations: [] });
  });

  it.each([
    { 中文提示词: "商品深度537mm" },
    { 镜头: "商品深度537mm，平视摄影" },
    { 画面布局: "商品居中，厚度5mm" },
    { 镜头: "85mm镜头拍摄；商品厚度85mm" },
    { 镜头: "镜头焦段85mm；产品尺寸537mm" },
    { 主图文案: "85mm镜头" },
    { 中文提示词: "商品容量500L" },
    { 画面布局: "主体占画面70%，除菌率99%" }
  ])("keeps product specifications and claims classified as unverified: %j", (output) => {
    expect(claimsContract().validateGeneratedClaims(output)).toMatchObject({
      ok: false, code: "generated_claim_unverified", violations: expect.arrayContaining([
        expect.objectContaining({ claimType: "unverified_measurement" })
      ])
    });
  });

  it("retains verified measurement and visual percentage behavior", () => {
    const contract = claimsContract();
    expect(contract.validateGeneratedClaims({ 中文提示词: "商品深度537mm" }, {
      facts: [{ factKey: "depth", factValue: "537", unit: "mm", evidenceStatus: "verified" }]
    })).toMatchObject({ ok: true });
    expect(contract.validateGeneratedClaims({ 画面布局: "主体占画面70%" })).toMatchObject({ ok: true });
  });
});

describe("background claim evidence follows the prompt route", () => {
  const link = { 链接编号: "L001", 产品规格: "深度537mm" };
  const response = () => ({ ok: true, data: { 链接编号: "L001", 中文提示词: "商品深度537mm", 生图逻辑: "按当前商品呈现" } });

  it.each([{ promptSource: "reference" }, { mode: "reference" }])("ignores stale link evidence on explicit reference requests: %j", (route) => {
    const { api, fetch } = backgroundRuntime();
    const result = api.validatePromptResponse(response(), "main", 0, "", { ...route, link });
    // Saving currently uses advisory warnings; this test verifies classification,
    // not a hard stop of the accepted model response.
    expect(result).toMatchObject({ ok: true, claimValidation: { ok: false, advisoryOnly: true } });
    expect(result.claimWarnings).toContainEqual(expect.objectContaining({ claim: "537mm", claimType: "unverified_measurement" }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([{ promptSource: "link" }, {}])("retains current-link evidence for explicit and legacy link requests: %j", (route) => {
    const { api, fetch } = backgroundRuntime();
    const result = api.validatePromptResponse(response(), "main", 0, "link-main", { ...route, link, linkId: "L001" });
    expect(result.ok).toBe(true);
    expect(result.claimValidation).toBeUndefined();
    expect(result.claimWarnings).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps link-number validation independent of accepted measurement evidence", () => {
    const { api, fetch } = backgroundRuntime();
    const result = api.validatePromptResponse(response(), "main", 0, "link-main", {
      promptSource: "link", link: { ...link, 链接编号: "L002" }, linkId: "L002"
    });
    expect(result).toMatchObject({ ok: false, code: "protocol_mismatch", error: expect.stringContaining("期望 L002，实际 L001") });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not promote competitor analysis or additional subject fields into product facts", () => {
    const { api, fetch } = backgroundRuntime();
    const result = api.validatePromptResponse(response(), "main", 0, "", {
      promptSource: "reference", analysis: { 产品规格: "深度537mm" }, referenceEvidence: "深度537mm",
      subjectFactsSource: "user_confirmed", subjectFacts: { depth: "537mm" }
    });
    expect(result.claimWarnings).toContainEqual(expect.objectContaining({ claim: "537mm", claimType: "unverified_measurement" }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps photographic parameters warning-free through the actual background validator", () => {
    const { api, fetch } = backgroundRuntime();
    const result = api.validatePromptResponse({ ok: true, data: {
      中文提示词: "使用85mm摄影镜头拍摄，商品居中", 镜头: "85mm商业人像焦段", 生图逻辑: "借鉴构图与光影"
    } }, "main", 0, "", { promptSource: "reference" });
    expect(result.ok).toBe(true);
    expect(result.claimWarnings).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
