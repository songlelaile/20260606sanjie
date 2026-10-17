import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayModel } from "./model-gateway/catalog";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), wallet: vi.fn(), snapshot: vi.fn(), catalog: vi.fn(), ledger: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("@/lib/model-gateway/billing", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/model-gateway/billing")>();
  return { getGatewayBillingSnapshot: mocks.snapshot, listGatewayBillingLedger: mocks.ledger, safeGatewayBillingError: original.safeGatewayBillingError };
});
vi.mock("@/lib/model-gateway/runtime-catalog", () => ({ listAvailableGatewayModels: mocks.catalog }));
import { creativeCreditModelView, getCreativeCredits, getCreativeCreditLedger } from "./creative-credit";

const plan = { code: "growth", name: "增长版", multiplierBps: 12500, ruleVersion: 3 };
const model: GatewayModel = { id: "configured-model", label: "已配置模型", provider: "shaozhuang", upstreamModel: "upstream-configured", kind: "image", endpoint: "images.generations", imageCents: 51,
  defaultBaseUrl: "https://private-provider.example/v1?key=secret", baseUrlEnv: "PRIVATE_URL_ENV", apiKeyEnv: "PRIVATE_KEY_ENV" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation((work) => work({ gatewayWallet: { findUnique: mocks.wallet } }));
  mocks.snapshot.mockResolvedValue({ userId: "owner", tenantId: "tenant", username: "owner", userName: "用户", planCode: "growth", planName: "增长版", multiplierBps: 12500, ruleVersion: 3, quotedAt: new Date().toISOString() });
  mocks.wallet.mockResolvedValue({ balanceCents: 1003 });
  mocks.catalog.mockResolvedValue([model]);
});

describe("read-only creative credit account DTO", () => {
  it("returns precise balance/current rule and only whitelisted model fields", async () => {
    const result = await getCreativeCredits("owner");
    expect(result).toMatchObject({ wallet: { balanceCents: 1003, balancePoints: 100.3, exists: true }, plan, catalogError: null, centsPerPoint: 10 });
    expect(result.models[0]).toMatchObject({ id: model.id, upstreamModel: model.upstreamModel, imageCents: 51, unitCents: 64, unitPoints: 6.4, pricingStatus: "priced" });
    expect(mocks.wallet).toHaveBeenCalledWith({ where: { userId: "owner" }, select: { balanceCents: true } });
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "RepeatableRead" });
    const json = JSON.stringify(result);
    for (const privateValue of [model.defaultBaseUrl, model.baseUrlEnv, model.apiKeyEnv, "secret"]) expect(json).not.toContain(privateValue);
  });
  it("reports absent wallet with zero precise balance without opening it", async () => {
    mocks.wallet.mockResolvedValue(null);
    expect((await getCreativeCredits("owner")).wallet).toEqual({ balanceCents: 0, balancePoints: 0, exists: false });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });
  it("keeps account balance/rule and an explicit error when runtime catalog fails", async () => {
    mocks.catalog.mockRejectedValue(new Error("private upstream URL and key"));
    const result = await getCreativeCredits("owner");
    expect(result.wallet.balanceCents).toBe(1003);
    expect(result.models).toEqual([]);
    expect(result.catalogError).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain("private upstream");
  });
  it("never supplies a default image price when the runtime model has no fee", () => {
    expect(creativeCreditModelView({ ...model, imageCents: undefined }, plan)).toMatchObject({ pricingStatus: "unpriced", unitCents: null, unitPoints: null });
  });
  it("preserves per-task video semantics and safely renders chat per-1000 rates", () => {
    expect(creativeCreditModelView({ ...model, kind: "video", endpoint: "videos", videoCents: 321 }, plan)).toMatchObject({ unit: "accepted_task", unitCents: 402, unitPoints: 40.2 });
    expect(creativeCreditModelView({ ...model, kind: "chat", endpoint: "chat.completions", promptCentsPer1K: 0.2, completionCentsPer1K: 6 }, plan)).toMatchObject({ unit: "tokens", unitPoints: null, promptPointsPer1K: 0.2, completionPointsPer1K: 0.8, pricingStatus: "priced" });
  });
  it("never invents a fee for malformed or overflowing model rates", () => {
    for (const imageCents of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.1, 2_147_483_647]) expect(creativeCreditModelView({ ...model, imageCents }, plan).unitPoints).toBeNull();
  });
  it("distinguishes an explicit zero image rate and follows the gateway's one-cent floor", () => {
    expect(creativeCreditModelView({ ...model, imageCents: 0 }, { ...plan, multiplierBps: 10000 })).toMatchObject({ imageCents: 0, unitCents: 1, unitPoints: 0.1, pricingStatus: "priced" });
    expect(creativeCreditModelView({ ...model, kind: "video", endpoint: "videos", videoCents: 0 }, plan)).toMatchObject({ pricingStatus: "unpriced", unitPoints: null });
  });
});

describe("own-account ledger DTO", () => {
  it("uses the fixed current account and whitelist without exposing keys, URLs or internal notes", async () => {
    mocks.ledger.mockResolvedValue({ total: 1, page: 2, pageSize: 20, items: [{
      id: "row", billingEventId: "event", kind: "debit", status: "ok", error: "private upstream response body", createdAt: "2026-10-02T00:00:00.000Z",
      planCode: "growth", planName: "增长版", multiplierBps: 12500, ruleVersion: 3, endpoint: "images.generations", provider: "shaozhuang", model: "configured-model", requestId: "upstream-id",
      deltaCents: -64, baseCostCents: 51, chargedCostCents: 64, balanceBeforeCents: 1003, balanceAfterCents: 939,
      promptTokens: 0, completionTokens: 0, totalTokens: 0, imageCount: 1, durationMs: 123, upstreamStatus: 200,
      apiKeyId: "private-key-id", keyPrefix: "private-key-prefix", actorId: "private-admin-id", reason: "private-internal-note", metadata: { baseUrl: "private-url" }
    }] });
    const result = await getCreativeCreditLedger("owner", 2);
    expect(mocks.ledger).toHaveBeenCalledWith({ userId: "owner", page: 2, pageSize: 20 });
    expect(result.items[0]).toMatchObject({ error: "upstream_error", deltaPoints: -6.4, chargedPoints: 6.4, balanceBeforePoints: 100.3, balanceAfterPoints: 93.9 });
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
