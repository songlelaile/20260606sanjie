import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { PrismaClient, type Prisma } from "@prisma/client";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createPaymentUatDatabase } from "../../../scripts/payment-uat-db.mjs";
import { GATEWAY_PLANS } from "./catalog";
import { billingRulesHash, contractHash, formatFixed, type SourceQuoteInput } from "./source-quote.mjs";

const sandbox = vi.hoisted(() => ({ client: null as PrismaClient | null, rate: 1, baseUrl: "https://isolated.invalid/v1", apiKey: "synthetic-only-key" }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ get prisma() { return sandbox.client; } }));
vi.mock("./relay-config", () => ({ getRelayRuntime: async () => ({ baseUrl: sandbox.baseUrl, apiKey: sandbox.apiKey, models: [], shopKeys: [], usdCnyRate: sandbox.rate }) }));
const H = (value: string) => createHash("sha256").update(value).digest("hex");

describe.skipIf(process.env.CREDIT_POOL_INTEGRATION !== "1")("isolated PostgreSQL unified credit accounting", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let service: typeof import("./credit-pool-accounting"), billing: typeof import("./billing"), holds: typeof import("./billing-hold"), gifts: typeof import("./credit-gifts"), store: typeof import("./store");
  let tenantId: string, adminId: string, ownerId: string;
  let migrationProof: { completeArchived: number; incompleteArchived: number; incompleteDeleteBlocked: boolean; incompleteUnchanged: boolean; walletUnchanged: boolean; pools: number };
  const db = () => sandbox.client!;
  const gift = (points = "10", requestKey = randomUUID()) => ({ userId: ownerId, points, reason: "隔离总池回归", requestKey });
  const confirmation = (receipt: string = randomUUID(), receivedAmountCents = 100) => ({ receipt, receivedAmountCents, confirmedBy: adminId, note: "本机模拟已核验真实收款" });
  async function user(name: string, balance = 0, active = true) {
    const row = await db().user.create({ data: { tenantId, username: `${name}-${randomUUID()}`, name, password: "unused-test-password", status: active ? "active" : "disabled" } });
    await db().gatewayWallet.create({ data: { userId: row.id, balanceCents: balance } });
    return row;
  }
  async function order(creditCents = 100, provider = "manual", userId = ownerId) {
    return db().gatewayOrder.create({ data: { userId, planCode: "free", planName: "隔离套餐", amountCents: 100, creditCents, paymentProvider: provider } });
  }
  async function frozen(userId = ownerId, eventId = randomUUID()) {
    const who = await db().user.findUniqueOrThrow({ where: { id: userId } });
    const credential = await db().gatewaySupplyCredential.upsert({ where: { userId_slot: { userId, slot: 'primary' } }, update: {}, create: { id: randomUUID(), userId, slot: 'primary', name: 'synthetic', sealedKey: 'synthetic-test-not-a-real-secret', status: 'ready', providerKeyId: 'fixture-key', providerOwnerId: 'fixture-issuer', providerGroupId: 'fixture-group', readyAt: new Date() } });
    const snapshot = { ...await billing.getGatewayBillingSnapshot(userId), fxSnapshot: { rate: sandbox.rate, source: "manual" as const, referenceDate: null, fetchedAt: null, id: null } };
    return { auth: { userId, username: who.username, apiKeyId: null, keyPrefix: "isolated" }, billingSnapshot: snapshot, eventId, baseUrl: sandbox.baseUrl,
      credentialId: credential.id, requestFingerprint: H(eventId), endpoint: "images.generations", provider: "shaozhuang", model: "image2" };
  }
  async function dispatch(f: Awaited<ReturnType<typeof frozen>>) {
    await holds.markGatewayBillingHoldDispatched({ userId: f.auth.userId, eventId: f.eventId });
    await holds.bindGatewayBillingHoldCredential({ userId: f.auth.userId, eventId: f.eventId, credentialId: f.credentialId });
  }
  async function source(capacityCents = 500, consumedUsd = "0") {
    const pool = await db().gatewayCreditPool.findUnique({ where: { id: "total" } });
    const savedRules = await db().gatewayBillingRule.findMany();
    const codes = [...new Set(["free", ...GATEWAY_PLANS.map(p => p.code), ...savedRules.map(r => r.planCode)])].sort();
    const rules = codes.map(planCode => { const r = savedRules.find(r => r.planCode === planCode); return { planCode, version: r?.version ?? 0, multiplierBps: r?.multiplierBps ?? 10_000 }; });
    const wallets = await db().gatewayWallet.findMany({ orderBy: { userId: "asc" } });
    const active = await db().gatewayBillingHold.findMany({ where: { status: { in: ["reserved", "dispatched", "unknown"] } }, orderBy: { eventId: "asc" } });
    const observations = await db().gatewayCreditSourceUsage.findMany();
    const evidenceHash = pool ? contractHash(observations.map(row => ({ billingEventId: row.billingEventId, actualUsdUnits: String(row.actualUsdUnits), userId: row.userId })).sort((a,b) => a.billingEventId.localeCompare(b.billingEventId))) : H("no-cycle-consumption");
    // All authority values below are explicit local synthetic fixtures, never production capacity.
    const now = new Date(), observedAt = new Date(now.getTime() - 5);
    const fx = { rate: String(sandbox.rate), source: "manual" as const, quoteId: null, fetchedAt: null, referenceDate: null };
    const proof: SourceQuoteInput = {
      now: now.toISOString(), expected: { configVersion: H("initial"), upstreamIdentityHash: H("synthetic-identity"), issuerUserId: "fixture-issuer", groupId: "fixture-group",
        capacityPolicy: "balance_only_proven", capacityPolicyEvidenceHash: H("no-independent-capacity-fixture"), billingRulesHash: billingRulesHash(rules, 10_000),
        pricingEnvelopeEvidenceHash: H("actual-usd-all-models-fixture"), fxSnapshotHash: contractHash(fx), fxSource: "manual", cycleId: "fixture-cycle",
        cycleStartedAt: new Date(now.getTime() - 60_000).toISOString(), cycleEndsAt: new Date(now.getTime() + 3600_000).toISOString(),
        poolVersion: pool?.revision ?? 0, maxSourceAgeMs: 300_000, maxFxAgeMs: 300_000, reserveBps: 0 },
      source: { configVersion: H("initial"), upstreamIdentityHash: H("synthetic-identity"), cycleId: "fixture-cycle", capturedAt: observedAt.toISOString(), evidenceHash: H(randomUUID()),
        issuer: { userId: "fixture-issuer", status: "active", dedicated: true, scopeEvidenceHash: H("dedicated"), balanceUnit: "USD", balanceMeaning: "remaining_total",
          balanceUsd: formatFixed(BigInt(capacityCents) * 1_000_000n / BigInt(sandbox.rate) - BigInt(Math.round(Number(consumedUsd) * 100_000_000)), 8), upstreamFrozenUsd: "0", externalCommittedUsd: "0", commitmentEvidenceHash: H("commitments"), cycleAccountedUsd: consumedUsd, accountedEvidenceHash: evidenceHash },
        group: { id: "fixture-group", issuerUserId: "fixture-issuer", status: "active", billingType: "standard_balance", issuerAccess: "proven", costBasis: "actual_cost", evidenceHash: H("group"), effectiveRateEvidenceHash: H("group-rate" ) },
        capacity: { kind: "balance_only_proven", constraintInventoryComplete: true, noIndependentCapacityConstraint: true, policyEvidenceHash: H("no-independent-capacity-fixture") } },
      pricing: { fx, rules, rulesComplete: true, fallbackMultiplierBps: 10_000, costCoverage: "actual_usd_required", envelopeEvidenceHash: H("actual-usd-all-models-fixture") },
      liabilities: { capturedAt: observedAt.toISOString(), evidenceHash: H("fixture-inventory"), complete: true, consistent: true, poolVersion: pool?.revision ?? 0, cycleId: "fixture-cycle", cycleAccountedUsd: consumedUsd,
        accountedEvidenceHash: evidenceHash, consumedCents: Number(pool?.consumedCents ?? 0), wallets: wallets.map(row => ({ userId: row.userId, balanceCents: row.balanceCents, ledgerBalanceCents: row.balanceCents })),
        holds: active.map(row => { const s = row.billingSnapshot as unknown as { fxSnapshot: { rate: number }; multiplierBps: number }; return { eventId: row.eventId, userId: row.userId, status: row.status as "reserved", heldCents: row.heldCents, fxRate: String(s.fxSnapshot.rate), multiplierBps: s.multiplierBps }; }), pendingReservations: [] }
    };
    // Preserve the cycle's immutable window when refreshing.
    if (pool?.sourceSnapshotId) { const previous = await db().gatewayCreditSourceSnapshot.findUniqueOrThrow({ where: { id: pool.sourceSnapshotId } });
      const old = previous.proof as unknown as SourceQuoteInput; proof.expected.cycleStartedAt = old.expected.cycleStartedAt; proof.expected.cycleEndsAt = old.expected.cycleEndsAt; }
    proof.expected.configVersion = await db().$transaction(tx => service.gatewayPoolRuntimeConfigHash(tx, proof));
    proof.source.configVersion = proof.expected.configVersion;
    Object.assign(proof, { gatewayBinding: { baseUrl: sandbox.baseUrl } });
    vi.stubEnv("GATEWAY_CREDIT_SOURCE_CONFIG_HASH", proof.expected.configVersion);
    const snapshot = await db().gatewayCreditSourceSnapshot.create({ data: { status: "verified", snapshotHash: contractHash(proof), identityHash: proof.expected.upstreamIdentityHash,
      conversionPolicyHash: contractHash({ expected: proof.expected, pricing: proof.pricing }), nativeUnit: "USD", providerBaseUrl: sandbox.baseUrl, capacityCents,
      proof: proof as unknown as Prisma.InputJsonValue, observedAt, expiresAt: new Date(now.getTime() + 290_000) } });
    return snapshot;
  }
  async function initialize(capacityCents = 500) {
    const snap = await source(capacityCents);
    const proposal = await service.prepareGatewayPoolAdoption(adminId, { snapshotId: snap.id, snapshotHash: snap.snapshotHash });
    const input = { proposalId: proposal.proposalId, version: proposal.version, snapshotHash: proposal.snapshotHash, requestKey: randomUUID() };
    await service.initializeGatewayCreditPool(adminId, input);
    return { snap, proposal, input };
  }
  async function usage(cost = 100, supplied?: Awaited<ReturnType<typeof frozen>>, actual = true) {
    const f = supplied ?? await frozen();
    if (!f.eventId.startsWith('gift:')) { await holds.reserveGatewayBillingHold({ ...f, quoteCents: cost }); await dispatch(f); }
    const write = (tx?: Prisma.TransactionClient) => store.recordGatewayUsage({ auth: f.auth, billingSnapshot: f.billingSnapshot, billingEventId: f.eventId,
      endpoint: f.endpoint, provider: f.provider, model: f.model, costCents: cost, baseCostCents: cost, status: "ok",
      metadata: actual ? { costSource: "upstream_usd", usdCost: String(cost / (100 * f.billingSnapshot.fxSnapshot.rate)), credentialId: f.credentialId, baseUrl: sandbox.baseUrl } : { costSource: "catalog" } }, tx);
    if (f.eventId.startsWith('gift:')) return write();
    return holds.settleGatewayBillingHold({ userId: f.auth.userId, eventId: f.eventId, finalCostCents: cost, outcomeFingerprint: H(f.eventId), writeUsage: tx => write(tx) });
  }
  async function migration(sql: string) {
    const bodies: string[] = [];
    sql = sql.replace(/\$\$[\s\S]*?\$\$/g, body => { bodies.push(body); return `__BODY_${bodies.length - 1}__`; }).replace(/--[^\n]*/g, "");
    for (const part of sql.split(";").map(x => x.trim()).filter(Boolean)) await db().$executeRawUnsafe(part.replace(/__BODY_(\d+)__/g, (_, n) => bodies[Number(n)]));
  }

  beforeAll(async () => {
    const isolated = await createPaymentUatDatabase(); cleanup = isolated.cleanup;
    sandbox.client = new PrismaClient({ datasources: { db: { url: isolated.url } }, log: [] });
    // Downgrade only this disposable namespace, then run the exact upgrade DDL.
    for (const table of ["GatewayCreditSourceUsage", "GatewayCreditPoolLedger", "GatewayCreditPoolProposal", "GatewayCreditSourceSnapshot", "GatewayCreditFundingEvidence"]) await db().$executeRawUnsafe(`DROP TABLE "${table}" CASCADE`);
    for (const column of ["accountingVersion","capacityCents","allocatedCents","consumedCents","deficitCents","sourceSnapshotId","revision","sourceScope","accountingEpochId","accountingEpochStartedAt","frozenValuationProduct"]) await db().$executeRawUnsafe(`ALTER TABLE "GatewayCreditPool" DROP COLUMN "${column}"`);
    await db().$executeRawUnsafe('ALTER TABLE "GatewayOrder" DROP COLUMN "creditAllocationState"');
    await db().$executeRawUnsafe('ALTER TABLE "GatewayBillingHold" DROP COLUMN "sourceBinding"');
    const tenant = await db().tenant.create({ data: { name: "总池本机隔离", slug: randomUUID() } }); tenantId = tenant.id;
    const old = await db().user.create({ data: { tenantId, username: randomUUID(), password: "unused", name: "不完整历史付款" } });
    const complete = await db().user.create({ data: { tenantId, username: randomUUID(), password: "unused", name: "完整历史付款" } });
    await db().$executeRaw`INSERT INTO "GatewayOrder" ("id","userId","planCode","planName","amountCents","creditCents","status","paidAt") VALUES ('legacy-incomplete',${old.id},'free','legacy',100,100,'paid',CURRENT_TIMESTAMP)`;
    await db().$executeRaw`INSERT INTO "GatewayOrder" ("id","userId","planCode","planName","amountCents","creditCents","status","paidAt","paymentReceipt","receivedAmountCents") VALUES ('legacy-complete',${complete.id},'free','legacy',100,100,'paid',CURRENT_TIMESTAMP,'legacy-proof',100)`;
    await db().gatewayWallet.create({ data: { userId: old.id, balanceCents: 37 } });
    await migration(await readFile("prisma/migrations/20261009090000_gateway_shared_credit_accounting/migration.sql", "utf8"));
    await migration(await readFile("prisma/migrations/20261009120000_shared_lifetime_usd_wallet/migration.sql", "utf8"));
    await migration(await readFile("prisma/migrations/20261009150000_shared_local_catalog_coverage/migration.sql","utf8"));
    let blocked = false; try { await db().user.delete({ where: { id: old.id } }); } catch { blocked = true; }
    migrationProof = { completeArchived: await db().gatewayCreditFundingEvidence.count({ where: { orderId: "legacy-complete" } }), incompleteArchived: await db().gatewayCreditFundingEvidence.count({ where: { orderId: "legacy-incomplete" } }),
      incompleteDeleteBlocked: blocked, incompleteUnchanged: (await db().gatewayOrder.findUniqueOrThrow({ where: { id: "legacy-incomplete" } })).paymentReceipt === null,
      walletUnchanged: (await db().gatewayWallet.findUniqueOrThrow({ where: { userId: old.id } })).balanceCents === 37, pools: await db().gatewayCreditPool.count() };
    vi.stubEnv("MODEL_GATEWAY_FX_AUTOMATIC", "0"); vi.stubEnv("MODEL_GATEWAY_PAYMENT_PROVIDER", "manual"); vi.stubEnv("MODEL_GATEWAY_MANUAL_PAY_URL", "");
    service = await import("./credit-pool-accounting"); billing = await import("./billing"); holds = await import("./billing-hold"); gifts = await import("./credit-gifts"); store = await import("./store");
  }, 60_000);
  beforeEach(async () => {
    await db().$executeRawUnsafe('TRUNCATE "GatewayCreditSourceUsage", "GatewayCreditPoolLedger", "GatewayCreditPoolProposal", "GatewayCreditSourceSnapshot", "GatewayCreditFundingEvidence", "GatewayCreditPool", "GatewayCreditGift", "GatewayBillingLedger", "GatewayBillingHoldEvent", "GatewayBillingHold", "GatewayUsage", "GatewayOrder", "GatewayWallet", "GatewayBillingRuleAudit", "GatewayBillingRule", "User" CASCADE');
    sandbox.rate = 1; sandbox.baseUrl = "https://isolated.invalid/v1"; sandbox.apiKey = "synthetic-only-key";
    vi.stubEnv("GATEWAY_CREDIT_SOURCE_CONFIG_HASH", "");
    const admin = await db().user.create({ data: { tenantId, username: randomUUID(), name: "隔离管理员", password: "unused", authRole: "admin" } }); adminId = admin.id;
    ownerId = (await user("积分用户")).id;
  });
  afterAll(async () => { vi.unstubAllEnvs(); await sandbox.client?.$disconnect(); await cleanup?.(); });

  it("upgrades incomplete historical payments without invented proof or capacity", () => {
    expect(migrationProof).toEqual({ completeArchived: 1, incompleteArchived: 0, incompleteDeleteBlocked: true, incompleteUnchanged: true, walletUnchanged: true, pools: 0 });
  });
  it.each([false,true])("keeps real pre-init recharge usable with pending pool=%s, then adopts it exactly once", async pending => {
    if (pending) await db().gatewayCreditPool.create({ data: { id: "total" } });
    const o = await order(), c = confirmation();
    await Promise.all(Array.from({ length: 6 }, () => store.markGatewayOrderPaidByOrderId(o.id,c)));
    expect((await db().gatewayWallet.findUniqueOrThrow({ where: { userId: ownerId } })).balanceCents).toBe(100);
    expect(await db().gatewayCreditFundingEvidence.count()).toBe(1);
    expect(await db().gatewayCreditPoolLedger.count()).toBe(0);
    const { input } = await initialize(500);
    await service.initializeGatewayCreditPool(adminId,input);
    expect(await db().gatewayCreditPool.findUniqueOrThrow({ where: { id: "total" } })).toMatchObject({ status: "ready", balanceCents: 400, allocatedCents: 100n, consumedCents: 0n });
    expect(await db().gatewayCreditPoolLedger.count({ where: { kind: "adoption" } })).toBe(1);
  });
  it("adopts inactive wallet and held subset once, without re-debit or hold release", async () => {
    await db().gatewayWallet.update({ where: { userId: ownerId }, data: { balanceCents: 100 } });
    await user("停用余额",50,false);
    const f = await frozen(); await holds.reserveGatewayBillingHold({ ...f, quoteCents: 80 });
    const before = await db().gatewayBillingHold.findUniqueOrThrow({ where: { eventId: f.eventId } });
    const { proposal } = await initialize(500);
    expect(proposal).toMatchObject({ walletTotalCents:150,heldSubsetCents:80,allocatableCents:350 });
    expect(await db().gatewayBillingHold.findUniqueOrThrow({ where: { eventId: f.eventId } })).toEqual(before);
    expect((await db().gatewayCreditPool.findUniqueOrThrow({ where: { id:"total" } })).balanceCents).toBe(350);
  });
  it("rejects fabricated client authority, missing source pin, foreign admin and incomplete native source", async () => {
    const snap = await source();
    await expect(service.prepareGatewayPoolAdoption(adminId,{ snapshotId:snap.id,snapshotHash:snap.snapshotHash,verified:true })).rejects.toMatchObject({code:"POOL_INPUT_INVALID"});
    await expect(service.prepareGatewayPoolAdoption(ownerId,{ snapshotId:snap.id,snapshotHash:snap.snapshotHash })).rejects.toMatchObject({code:"ADMIN_REQUIRED"});
    vi.stubEnv("GATEWAY_CREDIT_SOURCE_CONFIG_HASH", "");
    await expect(service.prepareGatewayPoolAdoption(adminId,{ snapshotId:snap.id,snapshotHash:snap.snapshotHash })).rejects.toMatchObject({code:"POOL_SOURCE_UNVERIFIED"});
    expect(await db().gatewayCreditPool.count()).toBe(0);
    await expect(gifts.giftGatewayCredits(adminId,gift())).rejects.toMatchObject({code:"CREDIT_POOL_NOT_READY"});
  });
  it("invalidates a proposal when recharge or zero-wallet creation changes the fenced inventory", async () => {
    const snap = await source(), proposal = await service.prepareGatewayPoolAdoption(adminId,{snapshotId:snap.id,snapshotHash:snap.snapshotHash});
    await store.markGatewayOrderPaidByOrderId((await order()).id,confirmation());
    await expect(service.initializeGatewayCreditPool(adminId,{proposalId:proposal.proposalId,version:proposal.version,snapshotHash:proposal.snapshotHash,requestKey:randomUUID()})).rejects.toMatchObject({code:"POOL_PROPOSAL_STALE"});
    expect(await db().gatewayCreditPool.count()).toBe(0);
  });
  it("serializes last-capacity concurrent recharge and gift, retaining an unallocated real receipt", async () => {
    await initialize(100);
    const o = await order(), c = confirmation();
    const results = await Promise.allSettled([store.markGatewayOrderPaidByOrderId(o.id,c),gifts.giftGatewayCredits(adminId,gift())]);
    expect(results.filter(r=>r.status==="fulfilled").length).toBeGreaterThanOrEqual(1);
    const pool = await db().gatewayCreditPool.findUniqueOrThrow({where:{id:"total"}});
    expect(pool).toMatchObject({balanceCents:0,allocatedCents:100n});
    expect((await db().gatewayWallet.findUniqueOrThrow({where:{userId:ownerId}})).balanceCents).toBe(100);
    const saved = await db().gatewayOrder.findUniqueOrThrow({where:{id:o.id}});
    if(saved.status==="pending") expect(saved).toMatchObject({creditAllocationState:"awaiting_capacity",paymentReceipt:c.receipt,receivedAmountCents:100,paidAt:null});
    expect(await db().gatewayCreditFundingEvidence.count({where:{orderId:o.id}})).toBe(1);
  });
  it("keeps paused/insufficient receipts immutable and prevents arbitrary owner resume", async () => {
    await initialize(50);
    const o=await order(),c=confirmation();
    expect(await store.markGatewayOrderPaidByOrderId(o.id,c)).toMatchObject({status:"pending",creditAllocationState:"awaiting_capacity"});
    const proof=await db().gatewayCreditFundingEvidence.findUniqueOrThrow({where:{orderId:o.id}});
    await expect(store.resumeGatewayOrderAllocation(adminId,o.id)).rejects.toMatchObject({code:"ORDER_NOT_FOUND"});
    expect(await store.retryGatewayPendingCredit(adminId,o.id)).toMatchObject({status:"pending",creditAllocationState:"awaiting_capacity"});
    expect(await db().gatewayCreditFundingEvidence.findUniqueOrThrow({where:{orderId:o.id}})).toEqual(proof);
    await db().gatewayCreditPool.update({where:{id:"total"},data:{status:"pending"}});
    expect(await store.markGatewayOrderPaidByOrderId(o.id,c)).toMatchObject({creditAllocationState:"awaiting_capacity"});
    expect((await db().gatewayWallet.findUniqueOrThrow({where:{userId:ownerId}})).balanceCents).toBe(0);
    await expect(store.markGatewayOrderPaidByOrderId(o.id,confirmation())).rejects.toMatchObject({code:"ORDER_CONFIRMATION_CONFLICT"});
  });
  it("replays gift and hold settlement once; debit moves W to C without reducing A", async () => {
    await db().gatewayWallet.update({where:{userId:ownerId},data:{balanceCents:200}});
    const f=await frozen();await holds.reserveGatewayBillingHold({...f,quoteCents:100});await dispatch(f);
    await initialize(500);const input=gift();
    const settle={userId:ownerId,eventId:f.eventId,finalCostCents:100,outcomeFingerprint:H("outcome"),writeUsage:async(tx:Prisma.TransactionClient)=>{await store.recordGatewayUsage({auth:f.auth,billingSnapshot:f.billingSnapshot,billingEventId:f.eventId,endpoint:f.endpoint,provider:f.provider,model:f.model,baseCostCents:100,costCents:100,status:"ok",metadata:{costSource:"upstream_usd",usdCost:"1",credentialId:f.credentialId,baseUrl:sandbox.baseUrl}},tx);}};
    await Promise.all([gifts.giftGatewayCredits(adminId,input),gifts.giftGatewayCredits(adminId,input),holds.settleGatewayBillingHold(settle),holds.settleGatewayBillingHold(settle)]);
    expect(await db().gatewayCreditPool.findUniqueOrThrow({where:{id:"total"}})).toMatchObject({balanceCents:200,allocatedCents:200n,consumedCents:100n});
    expect(await db().gatewayCreditPoolLedger.count({where:{kind:"gift"}})).toBe(1);expect(await db().gatewayCreditPoolLedger.count({where:{kind:"debit"}})).toBe(1);
    expect(await db().gatewayCreditSourceUsage.count()).toBe(1);
    await expect(gifts.giftGatewayCredits(adminId,{...input,points:"9"})).rejects.toMatchObject({code:"GIFT_REQUEST_CONFLICT"});
  });
  it("retains missing-USD settlement as unknown without a catalog debit",async()=>{
    await db().gatewayWallet.update({where:{userId:ownerId},data:{balanceCents:200}});const f=await frozen();
    await holds.reserveGatewayBillingHold({...f,quoteCents:100});await dispatch(f);await initialize(500);
    await expect(holds.settleGatewayBillingHold({userId:ownerId,eventId:f.eventId,finalCostCents:100,outcomeFingerprint:H("catalog"),writeUsage:tx=>store.recordGatewayUsage({auth:f.auth,billingSnapshot:f.billingSnapshot,billingEventId:f.eventId,endpoint:f.endpoint,provider:f.provider,model:f.model,costCents:100,status:"ok",metadata:{costSource:"catalog"}},tx)})).rejects.toMatchObject({code:"POOL_SOURCE_USAGE_UNPROVEN"});
    expect(await db().gatewayBillingHold.findUniqueOrThrow({where:{eventId:f.eventId}})).toMatchObject({status:"unknown",heldCents:100,settledCents:null});
    expect(await db().gatewayCreditPool.findUniqueOrThrow({where:{id:"total"}})).toMatchObject({balanceCents:300,allocatedCents:200n,consumedCents:0n});
    expect(await db().gatewayUsage.count()).toBe(0);
  });
  it("freezes new pricing but permits already-frozen holds to settle after source expiry",async()=>{
    await db().gatewayWallet.update({where:{userId:ownerId},data:{balanceCents:100}});const f=await frozen();await holds.reserveGatewayBillingHold({...f,quoteCents:100});await dispatch(f);
    await initialize(300);
    await expect(billing.updateGatewayBillingRule(adminId,{planCode:"free",multiplierBps:5000,expectedVersion:0,reason:"降低倍率"})).rejects.toMatchObject({code:"POOL_PRICING_LOCKED"});
    sandbox.rate=2;
    await expect(holds.reserveGatewayBillingHold({...await frozen(),quoteCents:1})).rejects.toMatchObject({code:"POOL_FX_CHANGED"});
    await holds.settleGatewayBillingHold({userId:ownerId,eventId:f.eventId,finalCostCents:100,outcomeFingerprint:H("old-fx"),writeUsage:tx=>store.recordGatewayUsage({auth:f.auth,billingSnapshot:f.billingSnapshot,billingEventId:f.eventId,endpoint:f.endpoint,provider:f.provider,model:f.model,costCents:100,status:"ok",metadata:{costSource:"upstream_usd",usdCost:"1",credentialId:f.credentialId,baseUrl:sandbox.baseUrl}},tx)});
    expect((await db().gatewayCreditPool.findUniqueOrThrow({where:{id:"total"}})).consumedCents).toBe(100n);
  });
  it("rolls back pool, receipt, wallet and both journals on ledger failure",async()=>{
    await initialize(500);const o=await order(),c=confirmation();
    await db().$executeRawUnsafe('ALTER TABLE "GatewayBillingLedger" ADD CONSTRAINT "fixture_ledger_failure" CHECK ("kind" <> \'recharge\') NOT VALID');
    try{await expect(store.markGatewayOrderPaidByOrderId(o.id,c)).rejects.toBeTruthy();}
    finally{await db().$executeRawUnsafe('ALTER TABLE "GatewayBillingLedger" DROP CONSTRAINT "fixture_ledger_failure"');}
    expect(await db().gatewayOrder.findUniqueOrThrow({where:{id:o.id}})).toMatchObject({status:"pending",paymentReceipt:null});
    expect(await db().gatewayCreditFundingEvidence.count()).toBe(0);
    expect(await db().gatewayCreditPool.findUniqueOrThrow({where:{id:"total"}})).toMatchObject({balanceCents:500,allocatedCents:0n});
    expect(await db().gatewayCreditPoolLedger.count()).toBe(1);
  });
  it("refreshes source binding using actual USD observations without charging twice",async()=>{
    await db().gatewayWallet.update({where:{userId:ownerId},data:{balanceCents:200}});await initialize(500);await usage(100);
    const snap=await source(600,"1");
    await expect(gifts.giftGatewayCredits(adminId,gift())).rejects.toMatchObject({code:"POOL_SOURCE_SUPERSEDED"});
    const p=await service.prepareGatewayPoolRefresh(adminId,{snapshotId:snap.id,snapshotHash:snap.snapshotHash});
    const input={proposalId:p.proposalId,version:p.version,snapshotHash:p.snapshotHash,requestKey:randomUUID()};
    await service.refreshGatewayCreditPool(adminId,input);await service.refreshGatewayCreditPool(adminId,input);
    expect(await db().gatewayCreditPool.findUniqueOrThrow({where:{id:"total"}})).toMatchObject({capacityCents:600n,balanceCents:400,allocatedCents:100n,consumedCents:100n,sourceSnapshotId:snap.id});
    expect(await db().gatewayCreditSourceUsage.count()).toBe(1);expect(await db().gatewayCreditPoolLedger.count({where:{kind:"source_refresh"}})).toBe(1);
    expect((await db().gatewayWallet.findUniqueOrThrow({where:{userId:ownerId}})).balanceCents).toBe(100);
    const o=await order(450),c=confirmation();expect(await store.markGatewayOrderPaidByOrderId(o.id,c)).toMatchObject({creditAllocationState:"awaiting_capacity"});
    const larger=await source(700,"1"),q=await service.prepareGatewayPoolRefresh(adminId,{snapshotId:larger.id,snapshotHash:larger.snapshotHash});
    await service.refreshGatewayCreditPool(adminId,{proposalId:q.proposalId,version:q.version,snapshotHash:q.snapshotHash,requestKey:randomUUID()});
    expect(await store.resumeGatewayOrderAllocation(ownerId,o.id)).toMatchObject({status:"paid",creditAllocationState:"credited"});
    await store.resumeGatewayOrderAllocation(ownerId,o.id);expect(await db().gatewayCreditFundingEvidence.count({where:{orderId:o.id}})).toBe(1);
    expect((await db().gatewayWallet.findUniqueOrThrow({where:{userId:ownerId}})).balanceCents).toBe(550);
  });
  it("preserves all liabilities on verified source shortfall and does not use the superseded source",async()=>{
    await db().gatewayWallet.update({where:{userId:ownerId},data:{balanceCents:200}});await initialize(500);
    const snap=await source(100);
    await expect(service.prepareGatewayPoolRefresh(adminId,{snapshotId:snap.id,snapshotHash:snap.snapshotHash})).rejects.toMatchObject({code:"BACKING_SHORTFALL"});
    await expect(gifts.giftGatewayCredits(adminId,gift())).rejects.toMatchObject({code:"POOL_SOURCE_SUPERSEDED"});
    expect((await db().gatewayWallet.findUniqueOrThrow({where:{userId:ownerId}})).balanceCents).toBe(200);
    expect((await gifts.getGatewayCreditGiftOverview()).pool).toMatchObject({state:"pending",ready:false,balanceCents:null});
  });
  it("rejects audit mutation, deletion of adopted liability, active holds and old receipt reuse",async()=>{
    await initialize(500);const o=await order(),c=confirmation("permanent-proof");await store.markGatewayOrderPaidByOrderId(o.id,c);
    await expect(db().gatewayCreditFundingEvidence.update({where:{orderId:o.id},data:{creditCents:1}})).rejects.toBeTruthy();
    await expect(db().gatewayCreditPoolLedger.deleteMany()).rejects.toBeTruthy();
    await expect(db().$transaction(tx=>service.assertGatewayAccountingDeletionSafe(tx,ownerId))).rejects.toMatchObject({code:"ACCOUNTING_DELETION_BLOCKED"});
    await expect(db().user.delete({where:{id:ownerId}})).rejects.toBeTruthy();
    await usage(100);await db().$transaction(async tx=>{await service.assertGatewayAccountingDeletionSafe(tx,ownerId);await tx.user.delete({where:{id:ownerId}});});
    const other=await user("后续用户");const next=await order(100,"manual",other.id);
    await expect(store.markGatewayOrderPaidByOrderId(next.id,c)).rejects.toMatchObject({code:"RECEIPT_ALREADY_USED"});
    expect((await db().gatewayWallet.findUniqueOrThrow({where:{userId:other.id}})).balanceCents).toBe(0);
  });
  it("rejects reserved gift IDs and wrong amount/provider before persisting evidence",async()=>{
    const f=await frozen();await expect(usage(1,{...f,eventId:`gift:${randomUUID()}`})).rejects.toMatchObject({code:"INVALID_BILLING_EVENT"});
    const o=await order();await expect(store.markGatewayOrderPaidByOrderId(o.id,confirmation(randomUUID(),99))).rejects.toMatchObject({code:"PAYMENT_AMOUNT_MISMATCH"});
    await expect(store.settleVerifiedScanPayment({provider:"wechat",orderId:o.id,receipt:randomUUID(),amountCents:100})).rejects.toMatchObject({code:"PAYMENT_PROVIDER_MISMATCH"});
    expect(await db().gatewayCreditFundingEvidence.count()).toBe(0);
  });
  it("retains actual old source endpoint for a dispatched settlement after runtime changes",async()=>{
    await db().gatewayWallet.update({where:{userId:ownerId},data:{balanceCents:100}});const f=await frozen();await holds.reserveGatewayBillingHold({...f,quoteCents:100});await dispatch(f);await initialize(300);
    sandbox.baseUrl="https://other-destination.invalid/v1";
    await expect(gifts.giftGatewayCredits(adminId,gift())).rejects.toMatchObject({code:"POOL_RUNTIME_CONFIG_CHANGED"});
    await holds.settleGatewayBillingHold({userId:ownerId,eventId:f.eventId,finalCostCents:100,outcomeFingerprint:H("old-source-endpoint"),writeUsage:tx=>store.recordGatewayUsage({auth:f.auth,billingSnapshot:f.billingSnapshot,billingEventId:f.eventId,endpoint:f.endpoint,provider:f.provider,model:f.model,costCents:100,status:"ok",metadata:{costSource:"upstream_usd",usdCost:"1",credentialId:f.credentialId,baseUrl:f.baseUrl}},tx)});
    expect((await db().gatewayCreditPool.findUniqueOrThrow({where:{id:"total"}})).consumedCents).toBe(100n);expect(await db().gatewayCreditSourceUsage.count()).toBe(1);
  });
  it("rejects another provider group at actual binding before provider submission",async()=>{
    await db().gatewayWallet.update({where:{userId:ownerId},data:{balanceCents:100}});await initialize(300);const f=await frozen();
    await db().gatewaySupplyCredential.update({where:{id:f.credentialId},data:{providerGroupId:"foreign-group"}});
    await holds.reserveGatewayBillingHold({...f,quoteCents:100});await holds.markGatewayBillingHoldDispatched({userId:ownerId,eventId:f.eventId});
    await expect(holds.bindGatewayBillingHoldCredential({userId:ownerId,eventId:f.eventId,credentialId:f.credentialId})).rejects.toMatchObject({code:"POOL_SOURCE_USAGE_UNPROVEN"});
    expect(await db().gatewayCreditSourceUsage.count()).toBe(0);expect((await db().gatewayWallet.findUniqueOrThrow({where:{userId:ownerId}})).balanceCents).toBe(100);
  });
  it("matches actual USD observations across equivalent decimal representations",async()=>{
    await db().gatewayWallet.update({where:{userId:ownerId},data:{balanceCents:100}});
    const first=await source(300,"0.00000000"),p=await service.prepareGatewayPoolAdoption(adminId,{snapshotId:first.id,snapshotHash:first.snapshotHash});
    await service.initializeGatewayCreditPool(adminId,{proposalId:p.proposalId,version:p.version,snapshotHash:p.snapshotHash,requestKey:randomUUID()});await usage(40);
    const next=await source(400,"0.40000000"),q=await service.prepareGatewayPoolRefresh(adminId,{snapshotId:next.id,snapshotHash:next.snapshotHash});
    await service.refreshGatewayCreditPool(adminId,{proposalId:q.proposalId,version:q.version,snapshotHash:q.snapshotHash,requestKey:randomUUID()});
    expect(await db().gatewayCreditPool.findUniqueOrThrow({where:{id:"total"}})).toMatchObject({capacityCents:400n,allocatedCents:60n,consumedCents:40n,balanceCents:300});
  });
  it("does not recreate capacity by increasing the valuation of previously spent USD",async()=>{
    await db().gatewayWallet.update({where:{userId:ownerId},data:{balanceCents:100}});await initialize(300);await usage(100);sandbox.rate=2;
    const snap=await source(600,"1");
    await expect(service.prepareGatewayPoolRefresh(adminId,{snapshotId:snap.id,snapshotHash:snap.snapshotHash})).rejects.toMatchObject({code:"POOL_REFRESH_VALUATION_CHANGED"});
    expect(await db().gatewayCreditPool.findUniqueOrThrow({where:{id:"total"}})).toMatchObject({capacityCents:300n,allocatedCents:0n,consumedCents:100n,balanceCents:200});
  });
});
