import { describe, expect, it } from "vitest";
import { estimateCreativeCreditRequests, type CreativeCreditModel, type CreativeCreditPlan } from "./creative-credit-contract";

const plan: CreativeCreditPlan = { code: "starter", name: "体验版", multiplierBps: 1234, ruleVersion: 2 };
const image: CreativeCreditModel = { id: "image-custom", label: "测试模型", provider: "shaozhuang", upstreamModel: "image-custom", kind: "image", endpoint: "images.generations", imageCents: 50, unitCents: 7, unitPoints: 0.7, promptPointsPer1K: null, completionPointsPer1K: null, pricingStatus: "priced", unit: "image" };
const video: CreativeCreditModel = { ...image, kind: "video", endpoint: "videos", imageCents: undefined, videoCents: 321, unit: "accepted_task" };
const chat: CreativeCreditModel = { ...image, kind: "chat", endpoint: "chat.completions", imageCents: undefined, promptCentsPer1K: 2, completionCentsPer1K: 6, unit: "tokens" };

describe("creative credit display channels", () => {
  it("labels external keys as zero platform credits even without a priced model", () => {
    expect(estimateCreativeCreditRequests("external_key", undefined, [{}], plan)).toMatchObject({ points: 0, platformPoints: 0, charged: false, priceStatus: "exact" });
  });
  it("labels local actions as zero without consulting model pricing", () => {
    expect(estimateCreativeCreditRequests("local", undefined, [], plan)).toMatchObject({ points: 0, platformPoints: 0, charged: false });
  });
  it("separates demonstration estimates from prospective platform debit", () => {
    expect(estimateCreativeCreditRequests("preview", image, [{ imageCount: 1 }], plan)).toMatchObject({ points: 0.7, platformPoints: 0, charged: false, priceStatus: "estimated" });
    expect(estimateCreativeCreditRequests("platform_wallet", image, [{ imageCount: 1 }], plan)).toMatchObject({ points: 0.7, platformPoints: 0.7, charged: false, priceStatus: "exact" });
  });
  it("rounds each actual request before summing instead of repricing a batch", () => {
    const perShot = estimateCreativeCreditRequests("preview", image, Array.from({ length: 10 }, () => ({ imageCount: 1 })), plan);
    const oneCall = estimateCreativeCreditRequests("preview", image, [{ imageCount: 10 }], plan);
    expect(perShot.points).toBe(7);
    expect(oneCall.points).toBe(6.2);
  });
  it("uses returned prices dynamically instead of a hardcoded image fee", () => {
    expect(estimateCreativeCreditRequests("preview", { ...image, imageCents: 83 }, [{ imageCount: 1 }, { imageCount: 1 }], { ...plan, multiplierBps: 10000 }).points).toBe(16.6);
  });
  it("does not invent a price for missing, unpriced or invalid image rates", () => {
    for (const model of [undefined, { ...image, pricingStatus: "unpriced" as const }, { ...image, imageCents: undefined }, { ...image, imageCents: Number.NaN }]) {
      expect(estimateCreativeCreditRequests("preview", model, [{}], plan)).toMatchObject({ points: null, platformPoints: 0, priceStatus: "unknown" });
    }
  });
  it.each([0, -1, 1.1, 11])("does not quote unsupported image count %s", (imageCount) => {
    expect(estimateCreativeCreditRequests("preview", image, [{ imageCount }], plan).points).toBeNull();
  });
  it("uses per-task video pricing without applying a duration multiplier", () => {
    expect(estimateCreativeCreditRequests("preview", video, [{}, {}], { ...plan, multiplierBps: 10000 }).points).toBe(64.2);
  });
  it("marks unknown token usage as unknown instead of a fixed analysis cost", () => {
    expect(estimateCreativeCreditRequests("preview", chat, [{}], plan)).toMatchObject({ points: null, priceStatus: "unknown" });
  });
  it("rounds input/output components and applies a plan once to each chat call", () => {
    expect(estimateCreativeCreditRequests("platform_wallet", chat, [{ promptTokens: 100, completionTokens: 150 }], { ...plan, multiplierBps: 15000 })).toMatchObject({ points: 0.3, priceStatus: "estimated" });
  });
  it("rejects invalid plan arithmetic without displaying a fabricated cost", () => {
    expect(estimateCreativeCreditRequests("preview", image, [{}], { ...plan, multiplierBps: 0 }).points).toBeNull();
  });
  it("distinguishes explicit zero fees from missing fees and preserves per-call minimums", () => {
    expect(estimateCreativeCreditRequests("preview", { ...image, imageCents: 0 }, [{ imageCount: 10 }, { imageCount: 1 }], { ...plan, multiplierBps: 10000 }).points).toBe(0.2);
    expect(estimateCreativeCreditRequests("preview", { ...chat, promptCentsPer1K: 0, completionCentsPer1K: 0 }, [{ promptTokens: 1000, completionTokens: 1000 }], { ...plan, multiplierBps: 10000 }).points).toBe(0.1);
    expect(estimateCreativeCreditRequests("preview", { ...video, videoCents: 0 }, [{}], plan).points).toBeNull();
  });
});
