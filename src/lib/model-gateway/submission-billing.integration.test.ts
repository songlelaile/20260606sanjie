import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { contractHash } from "./source-quote.mjs";
import type { SharedWalletSourceObservation } from "./shared-wallet-source";
vi.mock("server-only", () => ({}));
const source = vi.hoisted(() => ({ balance: "20", available: true, ageMs: 3_000, config: "c".repeat(64) }));
vi.mock("./relay-config", () => ({ getRelayRuntime: async () => ({ baseUrl: "https://sub.shaozhuangai.com/v1", apiKey: "synthetic-submission-fixture", models: [], shopKeys: [], usdCnyRate: 1 }) }));
// Synthetic owner observations replace only the supplier boundary. Pool adoption,
// wallet/pool journals, evidence guards and source refresh all execute real code.
vi.mock("./shared-wallet-source", () => ({ getGatewaySharedSourceConfigVersion: async () => source.config,
  readGatewaySharedWalletSourceConfiguration: async () => ({}), readGatewaySharedWalletSource: async () => {
    if (!source.available) throw new (await import("./shared-wallet-usage.mjs")).SharedWalletSourceError("SOURCE_READ_UNAVAILABLE");
    const bindingBase = { origin: "https://sub.shaozhuangai.com" as const, credentialFingerprint: "a".repeat(64), ownerSubject: "synthetic-submission-owner",
      routeGroupBinding: { groupId: null, groupName: "少壮专属分组", bindingEvidenceHash: "b".repeat(64) }, approvalEvidenceHash: "d".repeat(64),
      approvedExposure: "posted_balance_with_unobservable_external_requests" as const, approvedCredentialFingerprints: [] };
    const binding = { ...bindingBase, authorityHash: contractHash(bindingBase) };
    const facts = { capturedAt: new Date(Date.now() - source.ageMs).toISOString(), responseHash: contractHash(randomUUID()), httpStatus: 200 as const,
      isValid: true as const, mode: "unrestricted" as const, nativeUnit: "USD" as const, balanceUsd: source.balance,
      remainingUsd: source.balance, balanceRaw: source.balance, remainingRaw: source.balance };
    return { schema: "SANJIE_SHARED_WALLET_PROOF_V1", scope: "shared_user_lifetime_wallet", binding, epoch: null,
      policy: { configVersion: source.config, maxSourceAgeMs: 60_000, maxFxAgeMs: 259_200_000, reserveBps: 0, frozenValuationProduct: null },
      source: { ...facts, evidenceHash: contractHash({ source: facts, binding }) },
      externalCommitments: { state: "unobservable", amountUsd: null, evidenceHash: binding.approvalEvidenceHash } } satisfies SharedWalletSourceObservation;
  } }));
import { prisma } from "@/lib/db";
import { getGatewayBillingSnapshot } from "./billing";
import { GatewayBillingError, type GatewayBillingSnapshot } from "./billing-contract";
import * as holds from "./billing-hold";
import { recordGatewayUsage } from "./store";
import * as accounting from "./credit-pool-accounting";
import { reconcileGatewayVideoTerminal } from "./video-jobs";

const database = process.env.SUBMISSION_BILLING_TEST_DATABASE_URL;
if (database) {
  const url = new URL(database);
  if (url.hostname !== "127.0.0.1" || url.username !== "submission_fixture" || url.pathname !== "/native_video_uat" ||
    process.env.DATABASE_URL !== database || process.env.SUBMISSION_BILLING_TEST_DISPOSABLE !== "1") throw new Error("Submission billing tests require their private disposable PostgreSQL");
}
const owner = { id: "submission-user", tenantId: "submission-tenant", username: "submission-user" }, adminId = "submission-admin";
const H = (value: string) => createHash("sha256").update(value).digest("hex");
const wallet = () => prisma.gatewayWallet.findUniqueOrThrow({ where: { userId: owner.id } });
const pool = () => prisma.gatewayCreditPool.findUniqueOrThrow({ where: { id: "total" } });
const chargeId = (eventId: string) => `charge:${H(eventId)}`, refundId = (eventId: string) => `refund:${H(eventId)}`;
async function quote(amount = 100, endpoint = "images.generations") {
  const eventId = `submission-${randomUUID()}`;
  return { auth: { userId: owner.id, username: owner.username, apiKeyId: null, keyPrefix: "synthetic-submission" },
    billingSnapshot: { ...await getGatewayBillingSnapshot(owner.id), fxSnapshot: { rate: 1, source: "manual" as const, referenceDate: null, fetchedAt: null, id: null } },
    eventId, quoteCents: amount, requestFingerprint: H(eventId), endpoint, provider: "shaozhuang", model: "synthetic-image", idempotencyKey: eventId,
    billingMode: "prepaid_quote" as const };
}
async function registered(amount = 100, dispatch = true, endpoint = "images.generations") {
  const input = await quote(amount, endpoint); await holds.reserveGatewayBillingHold(input);
  await holds.bindGatewayBillingHoldSharedSource({ userId: owner.id, eventId: input.eventId, credentialFingerprint: "a".repeat(64) });
  if (dispatch) await holds.markGatewayBillingHoldDispatched({ userId: owner.id, eventId: input.eventId });
  return input;
}
async function hold(eventId: string) { return prisma.gatewayBillingHold.findUniqueOrThrow({ where: { eventId } }); }
async function financials() {
  const [w, p] = await Promise.all([wallet(), pool()]);
  return { wallet: w.balanceCents, allocated: p.allocatedCents, consumed: p.consumedCents, availablePool: p.balanceCents, deficit: p.deficitCents };
}
async function assertPhysicallyBacked(physicalCents: number) {
  const [w, p, journals] = await Promise.all([wallet(), pool(), prisma.gatewayCreditPoolLedger.findMany({ where: { poolId: "total" } })]);
  expect(p.allocatedCents).toBe(BigInt(w.balanceCents));
  expect(p.balanceCents).toBeLessThanOrEqual(Math.max(0, physicalCents - w.balanceCents));
  expect(p.allocatedCents + p.consumedCents + BigInt(p.balanceCents)).toBe(p.capacityCents + p.deficitCents);
  expect(journals.reduce((sum, row) => sum + row.deltaAllocatedCents, 0n)).toBe(p.allocatedCents);
  expect(journals.reduce((sum, row) => sum + row.deltaConsumedCents, 0n)).toBe(p.consumedCents);
  expect(journals.reduce((sum, row) => sum + row.capacityCents - row.capacityBeforeCents, 0n)).toBe(p.capacityCents);
}
async function noUsage() { expect(await prisma.gatewayUsage.count()).toBe(0); expect(await prisma.gatewayCreditSourceUsage.count()).toBe(0); }
function settlement(input: Awaited<ReturnType<typeof quote>>, actual = 25) {
  const metadata = { baseUrl: "https://sub.shaozhuangai.com/v1", upstreamModel: input.model, costSource: "upstream_usd", usdCost: String(actual / 100),
    usdCostLexical: String(actual / 100), upstreamCostField: "usage.actual_cost" };
  return { userId: owner.id, eventId: input.eventId, finalCostCents: actual, outcomeFingerprint: H(`success:${input.eventId}:${actual}`),
    writeUsage: vi.fn(async (tx: Prisma.TransactionClient, frozen: { billingSnapshot: GatewayBillingSnapshot; eventId: string }) => recordGatewayUsage({
      auth: input.auth, billingSnapshot: frozen.billingSnapshot, billingEventId: frozen.eventId, endpoint: input.endpoint, provider: input.provider,
      model: input.model, requestId: `provider-${H(input.eventId)}`, completionTokens: actual * 10, totalTokens: actual * 10,
      baseCostCents: actual, costCents: actual, status: "ok", metadata
    }, tx)) };
}
async function refund(input: Awaited<ReturnType<typeof quote>>) {
  return holds.refundGatewayBillingHold({ userId: owner.id, eventId: input.eventId, reason: "confirmed_failed", evidenceFingerprint: H(`failed:${input.eventId}`) });
}

describe.skipIf(!database)("submission billing with real PostgreSQL wallet and shared pool", () => {
  beforeEach(async () => {
    source.balance = "20"; source.available = true; source.ageMs = 3_000;
    await prisma.$executeRawUnsafe('TRUNCATE "GatewayNativeVideoJob", "GatewayCreditSourceUsage", "GatewayCreditPoolLedger", "GatewayCreditPoolProposal", "GatewayCreditSourceSnapshot", "GatewayCreditFundingEvidence", "GatewayCreditPool", "GatewayCreditGift", "GatewayBillingLedger", "GatewayBillingHoldEvent", "GatewayBillingHold", "GatewayUsage", "GatewayOrder", "GatewayWallet", "GatewayBillingRuleAudit", "GatewayBillingRule", "User", "Tenant" CASCADE');
    await prisma.tenant.create({ data: { id: owner.tenantId, slug: owner.tenantId, name: "Synthetic submission fixture" } });
    await prisma.user.create({ data: { ...owner, password: "unused", name: "Fixture", gatewayWallet: { create: { balanceCents: 1000 } } } });
    await prisma.user.create({ data: { id: adminId, tenantId: owner.tenantId, username: adminId, password: "unused", name: "Admin", authRole: "admin" } });
    const snapshot = await accounting.persistGatewaySharedSourceSnapshot(adminId);
    const proposal = await accounting.prepareGatewayPoolAdoption(adminId, { snapshotId: snapshot.snapshotId, snapshotHash: snapshot.snapshotHash });
    await accounting.initializeGatewayCreditPool(adminId, { proposalId: proposal.proposalId, version: proposal.version, snapshotHash: proposal.snapshotHash, requestKey: randomUUID() });
  });
  afterAll(async () => {
    // Remove the adopted pool as well as users before another disposable suite starts.
    try {
      await prisma.$executeRawUnsafe('TRUNCATE "GatewayNativeVideoJob", "GatewayCreditSourceUsage", "GatewayCreditPoolLedger", "GatewayCreditPoolProposal", "GatewayCreditSourceSnapshot", "GatewayCreditFundingEvidence", "GatewayCreditPool", "GatewayCreditGift", "GatewayBillingLedger", "GatewayBillingHoldEvent", "GatewayBillingHold", "GatewayUsage", "GatewayOrder", "GatewayWallet", "GatewayBillingRuleAudit", "GatewayBillingRule", "User", "Tenant" CASCADE');
    } finally { await prisma.$disconnect(); }
  });

  it.each(["chat.completions", "images.generations", "images.edits", "videos", "seedance.tasks"])("immediately charges the frozen %s quote without reserving money or fabricating usage", async endpoint => {
    const input = await quote(100, endpoint), result = await holds.reserveGatewayBillingHold(input);
    expect(result.hold).toMatchObject({ billingMode: "prepaid_quote", quoteCents: 100, heldCents: 0, amountDueCents: 0, chargedCents: 100, refundedCents: 0 });
    expect(await financials()).toEqual({ wallet: 900, allocated: 900n, consumed: 100n, availablePool: 1000, deficit: 0n });
    const entry = await prisma.gatewayBillingLedger.findUniqueOrThrow({ where: { billingEventId: chargeId(input.eventId) } });
    expect(entry).toMatchObject({ kind: "generation_charge", deltaCents: -100, balanceBeforeCents: 1000, balanceAfterCents: 900, usageId: null });
    expect(await prisma.gatewayCreditPoolLedger.findUniqueOrThrow({ where: { eventId: chargeId(input.eventId) } })).toMatchObject({ kind: "generation_charge", deltaAllocatedCents: -100n, deltaConsumedCents: 100n });
    expect(await holds.getGatewayAvailableBalance(prisma, owner.id)).toMatchObject({ balanceCents: 900, availableCents: 900, reservedCents: 0, outstandingCents: 0 });
    await noUsage();
    await accounting.refreshGatewaySharedPoolFromSource(); expect((await pool()).status).toBe("ready");
  });
  it("charges concurrent retries once and grants exactly one provider dispatch after the debit commits", async () => {
    const input = await quote(100), provider = vi.fn(async () => { expect((await wallet()).balanceCents).toBe(900); });
    const registrations = await Promise.all(Array.from({ length: 20 }, () => holds.reserveGatewayBillingHold(input)));
    expect(registrations.filter(result => !result.replayed)).toHaveLength(1);
    const dispatches = await Promise.all(Array.from({ length: 20 }, async () => {
      const result = await holds.markGatewayBillingHoldDispatched({ userId: owner.id, eventId: input.eventId }); if (result.shouldDispatch) await provider(); return result;
    }));
    expect(dispatches.filter(result => result.shouldDispatch)).toHaveLength(1); expect(provider).toHaveBeenCalledTimes(1);
    expect(await prisma.gatewayBillingLedger.count({ where: { kind: "generation_charge" } })).toBe(1);
    expect(await prisma.gatewayCreditPoolLedger.count({ where: { kind: "generation_charge" } })).toBe(1); await noUsage();
  });
  it("allows only one of two concurrent 600-cent generations against a 1000-cent wallet", async () => {
    const inputs = await Promise.all([quote(600), quote(600)]), provider = vi.fn();
    const outcomes = await Promise.allSettled(inputs.map(async input => {
      const reserved = await holds.reserveGatewayBillingHold(input);
      const dispatched = await holds.markGatewayBillingHoldDispatched({ userId: owner.id, eventId: reserved.hold.eventId });
      if (dispatched.shouldDispatch) provider();
    }));
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(provider).toHaveBeenCalledTimes(1);
    expect((outcomes.find(result => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    expect(await financials()).toEqual({ wallet: 400, allocated: 400n, consumed: 600n, availablePool: 1000, deficit: 0n });
    expect(await prisma.gatewayBillingHold.count()).toBe(1); await noUsage();
  });
  it("rejects mutated requests but replays the original charged quote after live pricing changes", async () => {
    const input = await quote(100); await holds.reserveGatewayBillingHold(input);
    await expect(holds.reserveGatewayBillingHold({ ...input, requestFingerprint: H("different-request") })).rejects.toMatchObject({ code: "BILLING_EVENT_CONFLICT" });
    const replay = await holds.reserveGatewayBillingHold({ ...input, quoteCents: 900 });
    expect(replay).toMatchObject({ replayed: true, shouldDispatch: false, hold: { quoteCents: 100, chargedCents: 100 } });
    expect((await wallet()).balanceCents).toBe(900); expect(await prisma.gatewayBillingLedger.count({ where: { kind: "generation_charge" } })).toBe(1);
  });
  it.each([0, 25, 150])("records actual supplier cost %s without changing the fixed submitted 100-cent business charge", async actual => {
    const input = await registered(100), confirmed = settlement(input, actual);
    const results = await Promise.all(Array.from({ length: 6 }, () => holds.settleGatewayBillingHold(confirmed)));
    expect(results.filter(result => !result.replayed)).toHaveLength(1); expect(confirmed.writeUsage).toHaveBeenCalledTimes(1);
    expect(await hold(input.eventId)).toMatchObject({ status: "settled", settledCents: actual, chargedCents: 100, refundedCents: 0, heldCents: 0 });
    expect(await financials()).toEqual({ wallet: 900, allocated: 900n, consumed: 100n, availablePool: 1000, deficit: 0n });
    const usageEntry = await prisma.gatewayBillingLedger.findUniqueOrThrow({ where: { billingEventId: input.eventId } });
    expect(usageEntry).toMatchObject({ kind: "usage", deltaCents: 0, balanceBeforeCents: 900, balanceAfterCents: 900 });
    expect(await prisma.gatewayUsage.count({ where: { billingEventId: input.eventId } })).toBe(1);
    expect(await prisma.gatewayBillingLedger.count({ where: { kind: "generation_refund" } })).toBe(0);
    expect(await prisma.gatewayCreditPoolLedger.count({ where: { kind: "debit" } })).toBe(0);
    expect(await prisma.gatewayCreditSourceUsage.count()).toBe(actual > 0 ? 1 : 0);
    await accounting.refreshGatewaySharedPoolFromSource(); expect((await pool()).status).toBe("ready");
    expect(await financials()).toMatchObject({ wallet: 900, consumed: 100n, availablePool: 1000 });
  });
  it("refunds a confirmed generation failure exactly once under concurrent callbacks and later replay", async () => {
    const input = await registered(100); const outcomes = await Promise.all(Array.from({ length: 20 }, () => refund(input)));
    expect(outcomes.filter(result => !result.replayed)).toHaveLength(1); expect((await refund(input)).replayed).toBe(true);
    expect(await hold(input.eventId)).toMatchObject({ chargedCents: 100, refundedCents: 100 });
    expect(await financials()).toEqual({ wallet: 1000, allocated: 1000n, consumed: 0n, availablePool: 1000, deficit: 0n });
    expect(await prisma.gatewayBillingLedger.count({ where: { kind: "generation_refund" } })).toBe(1);
    expect(await prisma.gatewayBillingLedger.findUniqueOrThrow({ where: { billingEventId: refundId(input.eventId) } })).toMatchObject({ deltaCents: 100, balanceBeforeCents: 900, balanceAfterCents: 1000, usageId: null });
    expect(await prisma.gatewayCreditPoolLedger.findUniqueOrThrow({ where: { eventId: refundId(input.eventId) } })).toMatchObject({ deltaAllocatedCents: 100n, deltaConsumedCents: -100n });
    await noUsage(); await accounting.refreshGatewaySharedPoolFromSource(); expect((await pool()).status).toBe("ready");
  });
  it("refunds failed generation even when a later source deficit blocks new allocation", async () => {
    const input = await registered(100); source.balance = "5"; await accounting.refreshGatewaySharedPoolFromSource();
    expect(await pool()).toMatchObject({ status: "blocked", capacityCents: 500n, deficitCents: 500n });
    await refund(input);
    expect(await financials()).toEqual({ wallet: 1000, allocated: 1000n, consumed: 0n, availablePool: 0, deficit: 500n });
    expect((await pool()).status).toBe("blocked");
  });
  it("records proven supplier cost after failure refund without reclaiming refunded customer points", async () => {
    const input = await registered(100); await refund(input);
    const observed = { ...settlement(input, 25), outcomeFingerprint: H(`failed-supplier-cost:${input.eventId}:25`) };
    await holds.settleGatewayBillingHold(observed); await holds.settleGatewayBillingHold(observed);
    expect(await hold(input.eventId)).toMatchObject({ status: "released", chargedCents: 100, refundedCents: 100, settledCents: 25 });
    expect(await financials()).toEqual({ wallet: 1000, allocated: 1000n, consumed: 0n, availablePool: 1000, deficit: 0n });
    expect(await prisma.gatewayUsage.count()).toBe(1); expect(await prisma.gatewayCreditSourceUsage.count()).toBe(1);
    await accounting.refreshGatewaySharedPoolFromSource(); expect((await pool()).status).toBe("ready");
    expect(await financials()).toMatchObject({ wallet: 1000, consumed: 0n, availablePool: 1000 });
  });
  it("keeps a successfully completed legacy video charge when a contradictory failure arrives", async () => {
    const input = await registered(100, true, "videos"); await holds.settleGatewayBillingHold(settlement(input, 25));
    const job = { billingEventId: input.eventId }, taskId = `provider-${H(input.eventId)}`;
    expect(await reconcileGatewayVideoTerminal(owner.id, taskId, job, { id: taskId, status: "completed" })).toBe("succeeded");
    expect(await reconcileGatewayVideoTerminal(owner.id, taskId, job, { id: taskId, status: "completed" })).toBe("succeeded");
    await expect(refund(input)).rejects.toMatchObject({ code: "VIDEO_RECEIPT_MISMATCH" });
    await expect(reconcileGatewayVideoTerminal(owner.id, taskId, job, { id: taskId, status: "failed" })).rejects.toMatchObject({ code: "VIDEO_RECEIPT_MISMATCH" });
    expect(await hold(input.eventId)).toMatchObject({ chargedCents: 100, refundedCents: 0, settledCents: 25 });
    expect(await financials()).toMatchObject({ wallet: 900, consumed: 100n });
    expect(await prisma.gatewayBillingHoldEvent.count({ where: { eventId: input.eventId, reason: "legacy_video_succeeded" } })).toBe(1);
    expect(await prisma.gatewayUsage.count()).toBe(1); expect(await prisma.gatewayCreditSourceUsage.count()).toBe(1);
  });
  it("rejects a contradictory legacy video success after the fixed submission charge was refunded", async () => {
    const input = await registered(100, true, "videos"); await holds.settleGatewayBillingHold(settlement(input, 25)); await refund(input);
    const taskId = `provider-${H(input.eventId)}`;
    await expect(reconcileGatewayVideoTerminal(owner.id, taskId, { billingEventId: input.eventId }, { id: taskId, status: "completed" })).rejects.toMatchObject({ code: "VIDEO_RECEIPT_MISMATCH" });
    expect(await hold(input.eventId)).toMatchObject({ chargedCents: 100, refundedCents: 100, settledCents: 25 });
    expect(await financials()).toMatchObject({ wallet: 1000, consumed: 0n });
    expect(await prisma.gatewayBillingHoldEvent.count({ where: { eventId: input.eventId, reason: "legacy_video_succeeded" } })).toBe(0);
    expect(await prisma.gatewayUsage.count()).toBe(1); expect(await prisma.gatewayCreditSourceUsage.count()).toBe(1);
  });
  it("serializes concurrent legacy video success markers and refunds with exactly one terminal winner", async () => {
    const inputs = [] as Array<Awaited<ReturnType<typeof quote>>>;
    for (let index = 0; index < 6; index++) {
      const input = await registered(100, true, "videos"); await holds.settleGatewayBillingHold(settlement(input, 25)); inputs.push(input);
    }
    const races = await Promise.all(inputs.map(async (input, index) => {
      const taskId = `provider-${H(input.eventId)}`;
      const succeed = () => reconcileGatewayVideoTerminal(owner.id, taskId, { billingEventId: input.eventId }, { id: taskId, status: "completed" });
      const fail = () => refund(input);
      return Promise.allSettled(index % 2 ? [fail(), succeed()] : [succeed(), fail()]);
    }));
    for (const race of races) {
      expect(race.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect((race.find(result => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "VIDEO_RECEIPT_MISMATCH" });
    }
    let refundCount = 0;
    for (const input of inputs) {
      const current = await hold(input.eventId), markers = await prisma.gatewayBillingHoldEvent.count({ where: { eventId: input.eventId, reason: "legacy_video_succeeded" } });
      refundCount += current.refundedCents ? 1 : 0;
      expect(markers).toBe(current.refundedCents ? 0 : 1); expect(current.settledCents).toBe(25);
    }
    expect(await financials()).toMatchObject({ wallet: 400 + refundCount * 100, consumed: BigInt(600 - refundCount * 100) });
    expect(await prisma.gatewayBillingLedger.count({ where: { kind: "generation_refund" } })).toBe(refundCount);
    expect(await prisma.gatewayUsage.count()).toBe(6); expect(await prisma.gatewayCreditSourceUsage.count()).toBe(6);
    source.balance = "18.50"; source.ageMs = 0; await accounting.refreshGatewaySharedPoolFromSource();
    await assertPhysicallyBacked(1850); expect((await pool()).balanceCents).toBe(850);
  });
  it("does not mint pool capacity when supplier cost exceeds the unchanged submission quote", async () => {
    const input = await registered(100), observed = settlement(input, 150);
    await holds.settleGatewayBillingHold(observed);
    source.balance = "18.50"; source.ageMs = 0;
    await accounting.refreshGatewaySharedPoolFromSource();
    expect(await hold(input.eventId)).toMatchObject({ chargedCents: 100, refundedCents: 0, settledCents: 150 });
    expect(await financials()).toEqual({ wallet: 900, allocated: 900n, consumed: 100n, availablePool: 850, deficit: 0n });
    expect(await pool()).toMatchObject({ status: "ready", capacityCents: 1850n });
    await assertPhysicallyBacked(1850);
    const sourceUsage = await prisma.gatewayCreditSourceUsage.findUniqueOrThrow({ where: { billingEventId: input.eventId } });
    expect(sourceUsage).toMatchObject({ actualUsdUnits: 150000000n, eligibleUsdUnits: 0n, ownerDebitPosting: "unproven" });
    await accounting.refreshGatewaySharedPoolFromSource(); await holds.settleGatewayBillingHold(observed);
    await assertPhysicallyBacked(1850);
    expect(await financials()).toMatchObject({ wallet: 900, consumed: 100n, availablePool: 850 });
    expect(await prisma.gatewayBillingLedger.count({ where: { kind: "generation_charge" } })).toBe(1);
    expect(await prisma.gatewayUsage.count()).toBe(1); expect(await prisma.gatewayCreditSourceUsage.count()).toBe(1);
  });
  it.each([false, true])("retains supplier spending in physical backing when the failure refund arrives first=%s", async refundFirst => {
    const input = await registered(100);
    const observed = { ...settlement(input, 25), outcomeFingerprint: H(`failed-physical-cost:${input.eventId}:25`) };
    if (refundFirst) await refund(input);
    await holds.settleGatewayBillingHold(observed);
    source.balance = "19.75"; source.ageMs = 0;
    await accounting.refreshGatewaySharedPoolFromSource();
    if (!refundFirst) await refund(input);
    await accounting.refreshGatewaySharedPoolFromSource();
    expect(await hold(input.eventId)).toMatchObject({ status: "released", chargedCents: 100, refundedCents: 100, settledCents: 25 });
    expect(await financials()).toEqual({ wallet: 1000, allocated: 1000n, consumed: 0n, availablePool: 975, deficit: 0n });
    expect(await pool()).toMatchObject({ status: "ready", capacityCents: 1975n });
    await assertPhysicallyBacked(1975);
    await refund(input); await holds.settleGatewayBillingHold(observed); await accounting.refreshGatewaySharedPoolFromSource();
    await assertPhysicallyBacked(1975);
    expect(await financials()).toMatchObject({ wallet: 1000, consumed: 0n, availablePool: 975 });
    expect(await prisma.gatewayBillingLedger.count({ where: { kind: "generation_refund" } })).toBe(1);
    expect(await prisma.gatewayCreditSourceUsage.count()).toBe(1);
    expect(await prisma.gatewayCreditSourceUsage.findUniqueOrThrow({ where: { billingEventId: input.eventId } })).toMatchObject({ actualUsdUnits: 25000000n, eligibleUsdUnits: 0n });
  });
  it("persists an early cancel by request key and refuses registration without charge or dispatch", async () => {
    const input = await quote(100);
    expect((await holds.cancelGatewayBillingRequest({ userId: owner.id, idempotencyKey: input.idempotencyKey })).replayed).toBe(false);
    expect((await holds.cancelGatewayBillingRequest({ userId: owner.id, idempotencyKey: input.idempotencyKey })).replayed).toBe(true);
    await expect(holds.reserveGatewayBillingHold(input)).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(await prisma.gatewayBillingHold.count()).toBe(0); expect(await financials()).toMatchObject({ wallet: 1000, consumed: 0n });
    await noUsage();
  });
  it("preserves a completed failure refund when a late cancellation arrives", async () => {
    const input = await registered(100); await refund(input);
    expect((await holds.cancelGatewayBillingHold({ userId: owner.id, eventId: input.eventId })).replayed).toBe(true);
    expect(await hold(input.eventId)).toMatchObject({ cancelledAt: null, chargedCents: 100, refundedCents: 100 });
    expect((await wallet()).balanceCents).toBe(1000);
  });
  it.each([false, true])("never refunds an explicitly cancelled request (dispatched=%s), including a later failed receipt", async dispatch => {
    const input = await registered(100, dispatch);
    const cancellations = await Promise.all(Array.from({ length: 6 }, () => holds.cancelGatewayBillingHold({ userId: owner.id, eventId: input.eventId })));
    expect(cancellations.filter(result => !result.replayed)).toHaveLength(1);
    expect((await hold(input.eventId)).cancelledAt).not.toBeNull();
    expect((await hold(input.eventId)).status).toBe(dispatch ? "dispatched" : "released");
    expect((await holds.markGatewayBillingHoldDispatched({ userId: owner.id, eventId: input.eventId })).shouldDispatch).toBe(false);
    await refund(input).catch(() => undefined);
    expect(await financials()).toEqual({ wallet: 900, allocated: 900n, consumed: 100n, availablePool: 1000, deficit: 0n });
    expect(await hold(input.eventId)).toMatchObject({ chargedCents: 100, refundedCents: 0 });
    expect(await prisma.gatewayBillingLedger.count({ where: { kind: "generation_refund" } })).toBe(0); await noUsage();
  });
  it("rejects an unaffordable quote before any dispatch claim and creates no bill or usage", async () => {
    const input = await quote(1001), provider = vi.fn();
    await expect((async () => { const charged = await holds.reserveGatewayBillingHold(input); if (charged.shouldDispatch) provider(); })()).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    expect(provider).not.toHaveBeenCalled(); expect(await prisma.gatewayBillingHold.count()).toBe(0);
    expect(await prisma.gatewayBillingLedger.count({ where: { kind: "generation_charge" } })).toBe(0);
    expect(await financials()).toMatchObject({ wallet: 1000, consumed: 0n }); await noUsage();
  });
  it("rolls back charge, wallet, pool and hold if durable task creation fails", async () => {
    const input = await quote(100), provider = vi.fn();
    await expect(holds.reserveGatewayBillingHold({ ...input, onReserved: async () => { throw new Error("synthetic task write failed"); } })).rejects.toThrow("synthetic task write failed");
    expect(provider).not.toHaveBeenCalled(); expect(await prisma.gatewayBillingHold.count()).toBe(0);
    expect(await financials()).toEqual({ wallet: 1000, allocated: 1000n, consumed: 0n, availablePool: 1000, deficit: 0n });
    expect(await prisma.gatewayBillingLedger.count({ where: { kind: "generation_charge" } })).toBe(0);
    expect(await prisma.gatewayCreditPoolLedger.count({ where: { kind: "generation_charge" } })).toBe(0); await noUsage();
  });
  it("rolls back a late pool charge journal failure and preserves zero provider submission", async () => {
    const input = await quote(100);
    await prisma.$executeRawUnsafe('ALTER TABLE "GatewayCreditPoolLedger" ADD CONSTRAINT "submission_fault" CHECK ("kind" <> \'generation_charge\') NOT VALID');
    try { await expect(holds.reserveGatewayBillingHold(input)).rejects.toBeTruthy(); }
    finally { await prisma.$executeRawUnsafe('ALTER TABLE "GatewayCreditPoolLedger" DROP CONSTRAINT "submission_fault"'); }
    expect(await financials()).toEqual({ wallet: 1000, allocated: 1000n, consumed: 0n, availablePool: 1000, deficit: 0n });
    expect(await prisma.gatewayBillingHold.count()).toBe(0); expect(await prisma.gatewayBillingLedger.count({ where: { kind: "generation_charge" } })).toBe(0);
  });
  it("rolls back a failed refund ledger write so retry credits exactly once", async () => {
    const input = await registered(100);
    await prisma.$executeRawUnsafe('ALTER TABLE "GatewayBillingLedger" ADD CONSTRAINT "submission_refund_fault" CHECK ("kind" <> \'generation_refund\') NOT VALID');
    try { await expect(refund(input)).rejects.toBeTruthy(); }
    finally { await prisma.$executeRawUnsafe('ALTER TABLE "GatewayBillingLedger" DROP CONSTRAINT "submission_refund_fault"'); }
    expect(await financials()).toMatchObject({ wallet: 900, allocated: 900n, consumed: 100n }); expect(await hold(input.eventId)).toMatchObject({ refundedCents: 0 });
    await refund(input); await refund(input); expect(await financials()).toMatchObject({ wallet: 1000, consumed: 0n });
    expect(await prisma.gatewayBillingLedger.count({ where: { kind: "generation_refund" } })).toBe(1);
  });
  it("rolls back late source-proof writes while preserving the already committed business charge", async () => {
    const input = await registered(100), confirmed = settlement(input, 25);
    await expect(holds.settleGatewayBillingHold({ ...confirmed, writeUsage: async (tx, frozen) => {
      await confirmed.writeUsage(tx, frozen); throw new GatewayBillingError("POOL_SOURCE_USAGE_UNPROVEN", "synthetic source failure", 409);
    } })).rejects.toMatchObject({ code: "POOL_SOURCE_USAGE_UNPROVEN" });
    await noUsage(); expect(await financials()).toMatchObject({ wallet: 900, consumed: 100n });
    expect(await prisma.gatewayBillingLedger.count({ where: { kind: "usage" } })).toBe(0);
    await holds.settleGatewayBillingHold(confirmed); expect(await financials()).toMatchObject({ wallet: 900, consumed: 100n });
  });
  it("keeps business journals immutable and rejects forged amounts at the database boundary", async () => {
    const input = await registered(100);
    await expect(prisma.gatewayBillingLedger.update({ where: { billingEventId: chargeId(input.eventId) }, data: { deltaCents: 0 } })).rejects.toBeTruthy();
    await expect(prisma.gatewayCreditPoolLedger.delete({ where: { eventId: chargeId(input.eventId) } })).rejects.toBeTruthy();
    await expect(prisma.$executeRaw`UPDATE "GatewayBillingHold" SET "chargedCents"=99 WHERE "eventId"=${input.eventId}`).rejects.toBeTruthy();
    expect(await financials()).toMatchObject({ wallet: 900, consumed: 100n });
  });
});
