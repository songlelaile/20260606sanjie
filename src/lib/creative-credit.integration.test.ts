import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createPaymentUatDatabase } from "../../scripts/payment-uat-db.mjs";

const sandbox = vi.hoisted(() => ({ client: null as PrismaClient | null, currentUserId: "", catalog: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ get prisma() { return sandbox.client; } }));
vi.mock("@/lib/model-gateway/runtime-catalog", () => ({ listAvailableGatewayModels: sandbox.catalog }));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: async () => sandbox.client!.user.findUnique({ where: { id: sandbox.currentUserId } }) }));

describe.skipIf(process.env.CREATIVE_CREDIT_INTEGRATION !== "1")("isolated read-only creative credit APIs", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let ownerId: string, foreignId: string, emptyId: string;
  let GET: typeof import("../app/api/creative/credits/route").GET;
  let ledgerGET: typeof import("../app/api/creative/credits/ledger/route").GET;
  let walletsBefore: unknown, ledgerBefore: unknown, rulesBefore: unknown;
  const client = () => sandbox.client!;

  beforeAll(async () => {
    const db = await createPaymentUatDatabase(); cleanup = db.cleanup;
    sandbox.client = new PrismaClient({ datasources: { db: { url: db.url } }, log: [] });
    const tenants = await Promise.all(["current", "foreign"].map((name) => client().tenant.create({ data: { name, slug: `creative-credit-${name}-${Date.now()}` } })));
    const users = await Promise.all(["owner", "foreign", "empty"].map((name) => client().user.create({ data: {
      tenantId: tenants[name === "foreign" ? 1 : 0].id, username: `creative-credit-${name}`, password: "unused-test-password", name
    } })));
    [ownerId, foreignId, emptyId] = users.map((user) => user.id);
    sandbox.currentUserId = ownerId;
    await client().gatewayWallet.create({ data: { userId: ownerId, balanceCents: 996, planCode: "starter", planName: "体验版" } });
    await client().gatewayWallet.create({ data: { userId: foreignId, balanceCents: 900, planCode: "starter", planName: "体验版" } });
    await client().gatewayBillingRule.create({ data: { planCode: "starter", planName: "体验版", multiplierBps: 1234, version: 4 } });
    for (const user of users.filter((row) => row.id !== emptyId)) {
      const balance = user.id === ownerId ? 1003 : 900;
      await client().gatewayBillingLedger.create({ data: { billingEventId: `opening:${user.id}`, kind: "opening", userId: user.id, tenantId: user.tenantId,
        tenantName: user.id === ownerId ? "current" : "foreign", username: user.username, userName: user.name, planCode: "starter", planName: "体验版",
        deltaCents: balance, balanceBeforeCents: 0, balanceAfterCents: balance, status: "ok" } });
    }
    await client().gatewayBillingLedger.create({ data: { billingEventId: "isolated-event", kind: "debit", userId: ownerId, tenantId: users[0].tenantId,
      tenantName: "current", username: users[0].username, userName: "owner", planCode: "starter", planName: "体验版", multiplierBps: 1234, ruleVersion: 4,
      deltaCents: -7, balanceBeforeCents: 1003, balanceAfterCents: 996, baseCostCents: 50, chargedCostCents: 7, model: "test-image", provider: "shaozhuang",
      endpoint: "images.generations", imageCount: 1, status: "ok", keyPrefix: "private-prefix", reason: "private-admin-note", metadata: { baseUrl: "private-url" } } });
    sandbox.catalog.mockResolvedValue([{ id: "test-image", label: "测试模型", provider: "shaozhuang", upstreamModel: "test-image", kind: "image", endpoint: "images.generations", imageCents: 50,
      baseUrlEnv: "private-env", apiKeyEnv: "private-key-env", defaultBaseUrl: "https://private.example/v1" }]);
    ({ GET } = await import("../app/api/creative/credits/route"));
    ({ GET: ledgerGET } = await import("../app/api/creative/credits/ledger/route"));
    walletsBefore = await client().gatewayWallet.findMany({ orderBy: { userId: "asc" } });
    ledgerBefore = await client().gatewayBillingLedger.findMany({ orderBy: { id: "asc" } });
    rulesBefore = await client().gatewayBillingRule.findMany({ orderBy: { planCode: "asc" } });
  }, 60_000);

  afterAll(async () => { await sandbox.client?.$disconnect(); await cleanup?.(); });

  it("reads exact active-account balance and database rule with dynamic model prices", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data).toMatchObject({ wallet: { balanceCents: 996, balancePoints: 99.6, exists: true }, plan: { code: "starter", multiplierBps: 1234, ruleVersion: 4 } });
    expect(data.models[0]).toMatchObject({ imageCents: 50, unitCents: 7, unitPoints: 0.7 });
    expect(JSON.stringify(data)).not.toContain("private");
  });

  it("allows only own ledger and never exposes provider credentials or internal notes", async () => {
    const response = await ledgerGET(new Request("https://app.example/api/creative/credits/ledger"));
    const { data } = await response.json();
    expect(data.total).toBe(2); expect(data.pageSize).toBe(20);
    expect(data.items.find((row: { billingEventId: string }) => row.billingEventId === "isolated-event")).toMatchObject({ chargedPoints: 0.7, deltaPoints: -0.7, balanceAfterPoints: 99.6 });
    expect(JSON.stringify(data)).not.toContain("private");
    expect(JSON.stringify(data)).not.toContain(foreignId);
    expect((await ledgerGET(new Request(`https://app.example/api/creative/credits/ledger?userId=${foreignId}`))).status).toBe(400);
  });

  it("keeps missing-wallet users missing and marks free plan as not yet purchased", async () => {
    sandbox.currentUserId = emptyId;
    const { data } = await (await GET()).json();
    expect(data.wallet).toEqual({ balanceCents: 0, balancePoints: 0, exists: false });
    expect(data.plan).toMatchObject({ code: "free", name: "未购买套餐", multiplierBps: 10000, ruleVersion: 0 });
    expect(await client().gatewayWallet.findUnique({ where: { userId: emptyId } })).toBeNull();
    sandbox.currentUserId = ownerId;
  });

  it("fails closed for a genuinely disabled account", async () => {
    await client().user.update({ where: { id: emptyId }, data: { status: "disabled" } });
    sandbox.currentUserId = emptyId;
    expect((await GET()).status).toBe(401);
    expect((await ledgerGET(new Request("https://app.example/api/creative/credits/ledger"))).status).toBe(401);
    sandbox.currentUserId = ownerId;
  });

  it("returns explicit catalog failure without losing wallet information or inventing prices", async () => {
    sandbox.catalog.mockRejectedValueOnce(new Error("private-provider-key"));
    const { data } = await (await GET()).json();
    expect(data.wallet.balanceCents).toBe(996);
    expect(data.models).toEqual([]); expect(data.catalogError).toBeTruthy();
    expect(JSON.stringify(data)).not.toContain("private-provider-key");
  });

  it("leaves every wallet, rule and financial ledger row unchanged after all reads", async () => {
    expect(await client().gatewayWallet.findMany({ orderBy: { userId: "asc" } })).toEqual(walletsBefore);
    expect(await client().gatewayBillingLedger.findMany({ orderBy: { id: "asc" } })).toEqual(ledgerBefore);
    expect(await client().gatewayBillingRule.findMany({ orderBy: { planCode: "asc" } })).toEqual(rulesBefore);
    expect(await client().gatewayUsage.count()).toBe(0);
    expect(await client().gatewayOrder.count()).toBe(0);
  });
});
