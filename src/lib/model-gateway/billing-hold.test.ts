import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const calls = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@/lib/model-gateway/billing", () => ({ lockGatewayBillingWallet: vi.fn() }));
// These unit fixtures represent an uninitialized legacy pool; real coordination/source
// behavior is exercised by credit-pool-accounting.integration.test.ts against PostgreSQL.
vi.mock("./accounting-coordination", () => ({ lockGatewayAccountingIdentities: vi.fn() }));
vi.mock("./credit-pool-accounting", () => ({ assertGatewayPoolNewQuote: vi.fn(), refreshGatewaySharedPoolFromSource: vi.fn(async()=>{}), assertGatewayPoolCredential: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { $transaction: calls.transaction } }));
import { reserveGatewayBillingHold, releaseGatewayBillingHold, settleGatewayBillingHold, markGatewayBillingHoldUnknown, bindGatewayBillingHoldCredential } from "./billing-hold";

const input = () => ({ auth: { userId: "u", username: "user", apiKeyId: null, keyPrefix: "web" },
  billingSnapshot: { userId: "u", tenantId: "t", username: "user", userName: "", planCode: "free", planName: "体验版", multiplierBps: 10000, ruleVersion: 0, quotedAt: new Date().toISOString() },
  eventId: "request-123", quoteCents: 10, requestFingerprint: "a".repeat(64), endpoint: "images.generations", provider: "shaozhuang", model: "image-test" });

beforeEach(() => { calls.transaction.mockReset(); });

describe("billing hold validation before database operations", () => {
  it.each([-1, 1.1, NaN, Infinity, 2147483648])("rejects unsafe monetary quote %s", async quoteCents => {
    await expect(reserveGatewayBillingHold({ ...input(), quoteCents })).rejects.toMatchObject({ code: "INVALID_HOLD_COST" });
  });
  it("rejects plaintext requests instead of storing them as hashes", async () => {
    await expect(reserveGatewayBillingHold({ ...input(), requestFingerprint: "please generate my private product" })).rejects.toMatchObject({ code: "INVALID_REQUEST_FINGERPRINT" });
  });
  it.each(["opening:user-1", "recharge:order-1", "gift:123e4567-e89b-42d3-a456-426614174000"])("rejects accounting event namespace collision %s before the database", async eventId => {
    await expect(reserveGatewayBillingHold({ ...input(), eventId })).rejects.toMatchObject({ code: "INVALID_BILLING_EVENT" });
    expect(calls.transaction).not.toHaveBeenCalled();
  });
  it("rejects a foreign identity snapshot and invalid rule version", async () => {
    const request = input();
    await expect(reserveGatewayBillingHold({ ...request, billingSnapshot: { ...request.billingSnapshot, userId: "foreign" } })).rejects.toMatchObject({ code: "INVALID_BILLING_SNAPSHOT" });
    await expect(reserveGatewayBillingHold({ ...request, billingSnapshot: { ...request.billingSnapshot, ruleVersion: -1 } })).rejects.toMatchObject({ code: "INVALID_BILLING_SNAPSHOT" });
  });
  it("requires no-consumption evidence for a post-dispatch release", async () => {
    await expect(releaseGatewayBillingHold({ userId: "u", eventId: "e", reason: "confirmed_not_consumed" })).rejects.toMatchObject({ code: "INVALID_REQUEST_FINGERPRINT" });
  });
  it("rejects arbitrary unknown reason text and unsafe settlement evidence", async () => {
    await expect(markGatewayBillingHoldUnknown({ userId: "u", eventId: "e", reason: "secret prompt" as "timeout" })).rejects.toMatchObject({ code: "INVALID_HOLD_REASON" });
    await expect(settleGatewayBillingHold({ userId: "u", eventId: "e", finalCostCents: 1, outcomeFingerprint: "raw response", writeUsage: async () => {} })).rejects.toMatchObject({ code: "INVALID_REQUEST_FINGERPRINT" });
    expect(calls.transaction).not.toHaveBeenCalled();
  });
});

describe("durable supply credential binding", () => {
  function database(status = "dispatched", ownsCredential = true, ownsHold = true) {
    const frozen = { ...input().billingSnapshot, fxSnapshot: { rate: 7.2, source: "ecb", referenceDate: "2026-10-02", fetchedAt: "2026-10-02T16:05:00.000Z", id: "f".repeat(64) } };
    const row = { ...input(), userId: "u", tenantId: "t", apiKeyId: null, status, heldCents: 10, settledCents: null, billingSnapshot: frozen, credentialId: "u-primary" };
    const tx = {
      $queryRaw: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
        const sql = parts.join("?");
        if (sql.includes('FROM "GatewaySupplyCredential"')) {
          expect(values).toEqual(["u-backup", "u"]);return ownsCredential ? [{ id: "u-backup" }] : [];
        }
        expect(values).toEqual(["request-123", "u"]);return ownsHold ? [row] : [];
      }),
      $executeRaw: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
        expect(parts.join("?")).toContain('AND "status" = \'dispatched\'');
        expect(values).toEqual(["u-backup", null, "request-123", "u"]);row.credentialId = "u-backup";return 1;
      })
    };
    calls.transaction.mockImplementation(async callback => callback(tx));
    return { row, tx, frozen };
  }
  it("persists the own credential before dispatch while preserving hold state, money and FX snapshot", async () => {
    const { row, tx, frozen } = database();
    const result = await bindGatewayBillingHoldCredential({ userId: "u", eventId: "request-123", credentialId: "u-backup" });
    expect(result.hold).toMatchObject({ credentialId: "u-backup", status: "dispatched", heldCents: 10, quoteCents: 10, settledCents: null, billingSnapshot: frozen });
    expect(row.billingSnapshot).toBe(frozen);expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
  it.each(["reserved", "unknown", "settled", "released"])("rejects credential changes for %s holds", async status => {
    const { tx } = database(status);
    await expect(bindGatewayBillingHoldCredential({ userId: "u", eventId: "request-123", credentialId: "u-backup" })).rejects.toMatchObject({ code: "HOLD_NOT_DISPATCHED" });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
  it("rejects a credential owned by another user or not ready", async () => {
    const { tx } = database("dispatched", false);
    await expect(bindGatewayBillingHoldCredential({ userId: "u", eventId: "request-123", credentialId: "u-backup" })).rejects.toMatchObject({ code: "SUPPLY_CREDENTIAL_MISMATCH" });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
  it("does not bind a foreign user/event hold", async () => {
    const { tx } = database("dispatched", true, false);
    await expect(bindGatewayBillingHoldCredential({ userId: "u", eventId: "request-123", credentialId: "u-backup" })).rejects.toMatchObject({ code: "BILLING_HOLD_NOT_FOUND" });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
  it.each(["", "../key", "secret:key", "x".repeat(201)])("validates credential id before any database write: %s", async credentialId => {
    await expect(bindGatewayBillingHoldCredential({ userId: "u", eventId: "request-123", credentialId })).rejects.toMatchObject({ code: "INVALID_SUPPLY_CREDENTIAL" });
    expect(calls.transaction).not.toHaveBeenCalled();
  });
});


describe("FX snapshot persistence whitelist", () => {
  const fx={rate:7.2,source:"ecb" as const,referenceDate:"2026-10-02",fetchedAt:"2026-10-02T16:05:00.000Z",id:"e".repeat(64)};
  it.each([{...fx,rate:0},{...fx,rate:NaN},{...fx,id:"provider-secret"},{...fx,referenceDate:"2026-02-30"},{...fx,fetchedAt:"not-date"},{...fx,source:"other"},{...fx,rate:7.1234567}])("rejects malformed frozen provenance before database writes (%j)",async bad=>{
    const request=input();await expect(reserveGatewayBillingHold({...request,billingSnapshot:{...request.billingSnapshot,fxSnapshot:bad as typeof fx}})).rejects.toMatchObject({code:"INVALID_FX_SNAPSHOT"});expect(calls.transaction).not.toHaveBeenCalled();
  });
  it.each([true,false])("stores only whitelist FX fields and supports legacy no-FX snapshots: %s",async withFx=>{
    const request=input();let stored:Record<string,unknown>|undefined;
    const tx={user:{findUnique:vi.fn().mockResolvedValue({id:"u",username:"user",tenantId:"t",status:"active"})},
      $queryRaw:vi.fn(async (parts:TemplateStringsArray)=>{const sql=parts.join("?");if(sql.includes('COALESCE'))return[{balanceCents:1000,reservedCents:0n}];if(sql.includes('OR ('))return[];return[{eventId:request.eventId,userId:"u",tenantId:"t",apiKeyId:null,billingSnapshot:stored,status:"reserved",heldCents:10,quoteCents:10}];}),
      $executeRaw:vi.fn(async (parts:TemplateStringsArray,...values:unknown[])=>{if(parts.join("?").includes('INSERT INTO "GatewayBillingHold"'))stored=JSON.parse(values.at(-1) as string);return 1;})};
    calls.transaction.mockImplementation(async callback=>callback(tx));
    const billingSnapshot={...request.billingSnapshot,...(withFx?{fxSnapshot:{...fx,apiKey:"test-secret",prompt:"private"}}:{})};
    const result=await reserveGatewayBillingHold({...request,billingSnapshot});
    expect(result.shouldDispatch).toBe(true);expect(result.hold.billingSnapshot).toEqual(stored);
    expect(stored?.fxSnapshot).toEqual(withFx?fx:undefined);expect(JSON.stringify(stored)).not.toContain("test-secret");expect(JSON.stringify(stored)).not.toContain("private");
  });
});
