import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Model = { productKey: string; nativePlatform?: boolean; billingMode?: string; creditsPerSecond: number | null };
function studio() {
  const nodes = new Map(["credit-estimate", "estimate-note"].map(id => [id, { textContent: "" }]));
  const context = vm.createContext({ console, URL, Number, Set, Object, Array, Math,
    document: { readyState: "loading", addEventListener: vi.fn(), getElementById: (id: string) => nodes.get(id) ?? null },
    __SZ_VIDEO_STUDIO_EXPOSE_TESTING__: true, SZEcommerceVideoStore: {} });
  for (const name of ["video-studio-contract.js", "video-studio.js"]) {
    const source = process.env.DIRECT_VIDEO_STUDIO_SOURCE_ROOT
      ? resolve(process.env.DIRECT_VIDEO_STUDIO_SOURCE_ROOT, name)
      : new URL(`../../public/creative/labs/ecommerce-video-studio/${name}`, import.meta.url);
    vm.runInContext(readFileSync(source, "utf8"), context);
  }
  const api = context.SZEcommerceVideoStudioTesting as {
    normalizeModelCatalog: (payload: unknown) => Model[];
    describeVideoCreditEstimate?: (model: Model, seconds: number) => { text: string; detail: string };
    cacheDom?: () => void;
    updateEstimate?: () => void;
    state?: { modelCatalog: Model[]; backendConnected: boolean; legacySingle: boolean; settings: { productKey: string; durationSeconds: number } };
  };
  function estimate(model: Model, seconds: number) {
    if (api.describeVideoCreditEstimate) return api.describeVideoCreditEstimate(model, seconds);
    // The newer studio renders its quote directly. Exercise that displayed text
    // instead of adding a duplicate pricing function only for this test.
    if (!api.state || !api.cacheDom || !api.updateEstimate) throw new Error("Missing studio estimate behavior");
    api.state.modelCatalog = [Object.assign({ configured: true }, model)];
    api.state.settings.productKey = model.productKey; api.state.settings.durationSeconds = seconds;
    api.state.backendConnected = true; api.state.legacySingle = true;
    api.cacheDom(); api.updateEstimate();
    return { text: nodes.get("credit-estimate")!.textContent, detail: nodes.get("estimate-note")!.textContent };
  }
  return { normalizeModelCatalog: api.normalizeModelCatalog, estimate };
}

describe("native video direct usage labels", () => {
  it("normalizes the browser capability mode and displays actual-usage billing before a legacy zero rate", () => {
    const api = studio();
    const models = api.normalizeModelCatalog({ provider: "shaozhuang-native", billingMode: "direct_usage", models: [{
      id: "seedance-2.0", providerModel: "seedance-2.0", configured: true, nativePlatform: true,
      reservationCents: 0, creditsPerSecond: 0, limits: { durations: [5], resolutions: ["720p"], ratios: ["16:9"] }
    }] });
    const model = models.find(item => item.productKey === "seedance-2.0")!;
    expect(model).toMatchObject({ nativePlatform: true, billingMode: "direct_usage" });
    const quote = api.estimate(model, 5);
    expect(quote).toEqual({ text: "提交时扣报价积分", detail: "提交时扣本次报价积分；生成失败退回，取消不退" });
    expect(JSON.stringify(quote)).not.toMatch(/0 积分|预占|冻结/);
  });

  it("shows the exact requested native submission price instead of the historical 100-point estimate", () => {
    const api = studio();
    const models = api.normalizeModelCatalog({ provider: "shaozhuang-native", billingMode: "prepaid_quote", models: [{
      id:"seedance-2.0",providerModel:"seedance-2.0",configured:true,nativePlatform:true,estimateCents:1000,
      submissionQuotes:[{duration:5,resolution:"720p",ratio:"9:16",hasVideoInput:false,quoteCents:37,quotePoints:3.7}],
      limits:{durations:[5],resolutions:["720p"],ratios:["9:16"]}
    }] });
    const model=models.find(item=>item.productKey==="seedance-2.0")!;
    expect(api.estimate(model,5)).toEqual({text:"生成 · 3.7 积分",detail:"提交时扣本次报价积分；生成失败退回，取消不退"});
    expect(api.estimate(model,10).text).toBe("提交时扣报价积分");
  });

  it("accepts model-specific direct usage without changing personal or legacy capability prices", () => {
    const api = studio();
    const models = api.normalizeModelCatalog({ provider: "shaozhuang-native", models: [{ id: "seedance-2.0",
      providerModel: "seedance-2.0", configured: true, nativePlatform: true, billingMode: "direct_usage" }] });
    expect(models.find(item => item.productKey === "seedance-2.0")?.billingMode).toBe("direct_usage");
    const legacy = api.estimate({ productKey: "seedance-2.0", nativePlatform: true, creditsPerSecond: null }, 5);
    expect(legacy.text).toMatch(/由生成服务返回|本次报价待确认/);
    expect(legacy.text).not.toBe("成功后按实际用量扣积分");
    expect(api.estimate({ productKey: "seedance-2.0", billingMode: "direct_usage", creditsPerSecond: 2 }, 5))
      .toEqual({ text: "10 积分", detail: "2 积分/秒 · 仅按能力回执估算" });
  });
});
