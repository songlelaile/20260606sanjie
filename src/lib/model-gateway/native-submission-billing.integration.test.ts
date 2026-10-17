import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { contractHash } from "./source-quote.mjs";
import type { SharedWalletSourceObservation } from "./shared-wallet-source";
vi.mock("server-only", () => ({}));
const supplier = vi.hoisted(() => ({ fetch: vi.fn(), key: "synthetic-native-submission-key", balance: "20", sourceAgeMs: 3_000, failSourceAfterCharge: false }));
vi.mock("./relay-config", () => ({ getRelayRuntime: async () => ({ apiKey: supplier.key, baseUrl: "https://sub.shaozhuangai.com/v1", models: [], shopKeys: [], usdCnyRate: 1 }) }));
vi.mock("./shared-wallet-source", () => ({ getGatewaySharedSourceConfigVersion: async () => "c".repeat(64), readGatewaySharedWalletSourceConfiguration: async () => ({}),
  readGatewaySharedWalletSource: async () => {
    if (supplier.failSourceAfterCharge && await (await import("@/lib/db")).prisma.gatewayBillingHold.count({ where: { userId: "native-submission-user", billingMode: "prepaid_quote", chargedCents: { gt: 0 } } })) {
      throw new (await import("./shared-wallet-usage.mjs")).SharedWalletSourceError("SOURCE_READ_UNAVAILABLE");
    }
    const bindingBase = { origin: "https://sub.shaozhuangai.com" as const, credentialFingerprint: createHash("sha256").update(supplier.key).digest("hex"), ownerSubject: "synthetic-native-owner",
      routeGroupBinding: { groupId: null, groupName: "少壮专属分组", bindingEvidenceHash: "b".repeat(64) }, approvalEvidenceHash: "d".repeat(64),
      approvedExposure: "posted_balance_with_unobservable_external_requests" as const, approvedCredentialFingerprints: [] };
    const binding = { ...bindingBase, authorityHash: contractHash(bindingBase) };
    const facts = { capturedAt: new Date(Date.now() - supplier.sourceAgeMs).toISOString(), responseHash: contractHash(randomUUID()), httpStatus: 200 as const,
      isValid: true as const, mode: "unrestricted" as const, nativeUnit: "USD" as const, balanceUsd: supplier.balance,
      remainingUsd: supplier.balance, balanceRaw: supplier.balance, remainingRaw: supplier.balance };
    return { schema: "SANJIE_SHARED_WALLET_PROOF_V1", scope: "shared_user_lifetime_wallet", binding, epoch: null,
      policy: { configVersion: "c".repeat(64), maxSourceAgeMs: 60_000, maxFxAgeMs: 259_200_000, reserveBps: 0, frozenValuationProduct: null },
      source: { ...facts, evidenceHash: contractHash({ source: facts, binding }) },
      externalCommitments: { state: "unobservable", amountUsd: null, evidenceHash: binding.approvalEvidenceHash } } satisfies SharedWalletSourceObservation;
  } }));
vi.mock("./user-supply", () => ({
  getUserSupplyRuntime: async (userId: string) => ({ baseUrl: "https://sub.shaozhuangai.com/v1", primary: { id: `${userId}-primary`, apiKey: supplier.key }, backup: null, usdCnyRate: null }),
  getUserSupplyCredential: async (userId: string, credentialId: string) => {
    if (credentialId !== `${userId}-primary`) throw new Error("Synthetic unowned credential");
    return { baseUrl: "https://sub.shaozhuangai.com/v1", apiKey: supplier.key };
  }
}));
vi.mock("./relay-network", async original => ({ ...await original<typeof import("./relay-network")>(), relayFetch: supplier.fetch }));
vi.mock("./native-video-supply", async original => ({ ...await original<typeof import("./native-video-supply")>(), readNativeVideoSupplyConfig: async () => null }));
import { prisma } from "@/lib/db";
import * as native from "./native-video";
import { cancelGatewayBillingHold, refundGatewayBillingHold } from "./billing-hold";
import * as accounting from "./credit-pool-accounting";

const database = process.env.SUBMISSION_BILLING_TEST_DATABASE_URL;
if (database) {
  const url = new URL(database);
  if (url.hostname !== "127.0.0.1" || url.username !== "submission_fixture" || url.pathname !== "/native_video_uat" ||
      process.env.DATABASE_URL !== database || process.env.SUBMISSION_BILLING_TEST_DISPOSABLE !== "1") throw new Error("Native prepaid tests require isolated localhost PostgreSQL");
}
const owner = { id: "native-submission-user", tenantId: "native-submission-tenant", username: "native-submission-user" };
const body = () => ({ expectedAccount: "native-submission-tenant:native-submission-user", model: "seedance-2.0",
  content: [{ type: "text", text: "synthetic product video" }], duration: 5, resolution: "720p", ratio: "16:9", generate_audio: false });
const config = () => ({ enabled: true, bindingId: "synthetic-submission-binding", models: [{ id: "seedance-2.0", label: "Synthetic Seedance",
  upstreamModel: "synthetic-seedance", priceVersion: "synthetic-submission-v1", completionCentsPerMillion: 1000, reservationCents: 100,
  durations: [5], resolutions: ["720p"], ratios: ["16:9"], generateAudio: false, mediaHosts: ["media.example.com"] }] });
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
const success = () => ({ id: "native-provider-task", status: "succeeded", usage: { completion_tokens: 250 }, content: { video_url: "https://media.example.com/synthetic.mp4" } });
async function state() {
  return { wallet: await prisma.gatewayWallet.findUniqueOrThrow({ where: { userId: owner.id } }),
    holds: await prisma.gatewayBillingHold.findMany({ where: { userId: owner.id } }), jobs: await prisma.gatewayNativeVideoJob.findMany({ where: { userId: owner.id } }),
    ledger: await prisma.gatewayBillingLedger.findMany({ where: { userId: owner.id } }), usages: await prisma.gatewayUsage.findMany({ where: { userId: owner.id } }) };
}
async function create() { supplier.fetch.mockResolvedValueOnce(response({ id: "native-provider-task" })); return native.createNativeVideo(owner, body(), "synthetic-prepaid-native"); }
async function adoptPool() {
  const adminId = "native-submission-admin";
  await prisma.user.create({ data: { id: adminId, tenantId: owner.tenantId, username: adminId, password: "unused", name: "Admin", authRole: "admin" } });
  const snapshot = await accounting.persistGatewaySharedSourceSnapshot(adminId);
  const proposal = await accounting.prepareGatewayPoolAdoption(adminId, { snapshotId: snapshot.snapshotId, snapshotHash: snapshot.snapshotHash });
  await accounting.initializeGatewayCreditPool(adminId, { proposalId: proposal.proposalId, version: proposal.version, snapshotHash: proposal.snapshotHash, requestKey: randomUUID() });
}
const pool = () => prisma.gatewayCreditPool.findUniqueOrThrow({ where: { id: "total" } });

describe.skipIf(!database)("native generation submission charge on real PostgreSQL", () => {
  beforeEach(async () => {
    supplier.fetch.mockReset(); supplier.balance = "20"; supplier.sourceAgeMs = 3_000; supplier.failSourceAfterCharge = false; process.env.MODEL_GATEWAY_SEEDANCE_CONFIG = JSON.stringify(config());
    await prisma.$executeRawUnsafe('TRUNCATE "GatewayNativeVideoJob", "GatewayCreditSourceUsage", "GatewayCreditPoolLedger", "GatewayCreditPoolProposal", "GatewayCreditSourceSnapshot", "GatewayCreditFundingEvidence", "GatewayCreditPool", "GatewayCreditGift", "GatewayBillingLedger", "GatewayBillingHoldEvent", "GatewayBillingHold", "GatewayUsage", "GatewayOrder", "GatewayWallet", "User", "Tenant" CASCADE');
    await prisma.tenant.create({ data: { id: owner.tenantId, slug: owner.tenantId, name: "Native submission fixture" } });
    await prisma.user.create({ data: { ...owner, password: "unused", name: "Fixture", gatewayWallet: { create: { balanceCents: 1000 } } } });
    await prisma.$executeRaw`INSERT INTO "GatewaySupplyCredential" ("id","userId","slot","name","sealedKey","status") VALUES (${`${owner.id}-primary`},${owner.id},'primary','synthetic','synthetic-sealed','ready')`;
  });
  afterAll(async () => {
    // Shared disposable runs may continue with legacy fixtures that have no adopted pool.
    try {
      await prisma.$executeRawUnsafe('TRUNCATE "GatewayNativeVideoJob", "GatewayCreditSourceUsage", "GatewayCreditPoolLedger", "GatewayCreditPoolProposal", "GatewayCreditSourceSnapshot", "GatewayCreditFundingEvidence", "GatewayCreditPool", "GatewayCreditGift", "GatewayBillingLedger", "GatewayBillingHoldEvent", "GatewayBillingHold", "GatewayUsage", "GatewayOrder", "GatewayWallet", "User", "Tenant" CASCADE');
    } finally {
      await prisma.$disconnect(); delete process.env.MODEL_GATEWAY_SEEDANCE_CONFIG;
    }
  });

  it("charges 108 quoted cents before supplier submission and preserves zero reservation", async () => {
    supplier.fetch.mockImplementationOnce(async () => {
      const snapshot = await state(); expect(snapshot.wallet.balanceCents).toBe(892);
      expect(snapshot.holds[0]).toMatchObject({ billingMode: "prepaid_quote", quoteCents: 108, chargedCents: 108, heldCents: 0, refundedCents: 0 });
      expect(snapshot.ledger.filter(entry => entry.kind === "generation_charge")).toHaveLength(1); expect(snapshot.usages).toHaveLength(0);
      return response({ id: "native-provider-task" });
    });
    expect(await native.createNativeVideo(owner, body(), "synthetic-prepaid-native")).toMatchObject({ status: "running", billing: { quoteCents: 108, chargedCents: 108, settledCents: null } });
    expect(supplier.fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps the 108-cent quote when completion tokens price actual usage at only one cent", async () => {
    const job = await create(); supplier.fetch.mockResolvedValueOnce(response(success()));
    expect(await native.pollNativeVideo(owner, job.id)).toMatchObject({ status: "succeeded", billing: { quoteCents: 108, chargedCents: 108, settledCents: 108, refundedCents: 0 } });
    const snapshot = await state(); expect(snapshot.wallet.balanceCents).toBe(892);
    expect(snapshot.holds[0]).toMatchObject({ chargedCents: 108, refundedCents: 0, settledCents: 1, status: "settled" });
    expect(snapshot.ledger.filter(entry => entry.kind === "generation_charge")).toHaveLength(1);
    expect(snapshot.ledger.filter(entry => entry.kind === "usage")).toHaveLength(1);
    expect(snapshot.ledger.filter(entry => entry.kind === "generation_refund" || entry.kind === "debit")).toHaveLength(0);
    expect(snapshot.usages).toHaveLength(1); expect((await native.pollNativeVideo(owner, job.id)).status).toBe("succeeded");
    expect((await state()).wallet.balanceCents).toBe(892);
  });
  it("refunds a supplier-confirmed failure once even when the failure receipt reports supplier usage", async () => {
    const job = await create(); supplier.fetch.mockResolvedValueOnce(response({ id: "native-provider-task", status: "failed", usage: { completion_tokens: 250 }, error: { code: "SYNTHETIC_GENERATION_FAILED" } }));
    expect(await native.pollNativeVideo(owner, job.id)).toMatchObject({ status: "failed", billing: { quoteCents: 108, chargedCents: 108, refundedCents: 108, settledCents: 0 } });
    expect((await native.pollNativeVideo(owner, job.id)).status).toBe("failed");
    const snapshot = await state(); expect(snapshot.wallet.balanceCents).toBe(1000);
    expect(snapshot.holds[0]).toMatchObject({ chargedCents: 108, refundedCents: 108 });
    expect(snapshot.ledger.filter(entry => entry.kind === "generation_refund")).toHaveLength(1);
    expect(snapshot.usages).toHaveLength(1); expect(snapshot.usages[0].completionTokens).toBe(250);
    expect(snapshot.ledger.filter(entry => entry.kind === "usage")).toHaveLength(1);
  });
  it("retains the charge after user cancellation and an eventual supplier failure", async () => {
    const job = await create(), snapshot = await state();
    await cancelGatewayBillingHold({ userId: owner.id, eventId: snapshot.holds[0].eventId });
    supplier.fetch.mockResolvedValueOnce(response({ id: "native-provider-task", status: "failed", usage: { completion_tokens: 0 } }));
    expect((await native.pollNativeVideo(owner, job.id)).status).toBe("cancelled");
    const cancelled = await state(); expect(cancelled.wallet.balanceCents).toBe(892); expect(cancelled.holds[0].cancelledAt).not.toBeNull();
    expect(cancelled.holds[0].refundedCents).toBe(0); expect(cancelled.ledger.filter(entry => entry.kind === "generation_refund")).toHaveLength(0);
  });
  it("rejects a wallet below the submitted quote before a supplier request", async () => {
    await prisma.gatewayWallet.update({ where: { userId: owner.id }, data: { balanceCents: 107 } });
    await expect(native.createNativeVideo(owner, body(), "synthetic-prepaid-native")).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    expect(supplier.fetch).not.toHaveBeenCalled(); const snapshot = await state(); expect(snapshot.wallet.balanceCents).toBe(107);
    expect(snapshot.holds).toHaveLength(0); expect(snapshot.ledger.filter(entry => entry.kind === "generation_charge")).toHaveLength(0);
  });
  it("replays a submission without a second charge or a second create request", async () => {
    const job = await create(); expect((await native.createNativeVideo(owner, body(), "synthetic-prepaid-native")).id).toBe(job.id);
    expect((await native.createNativeVideo(owner, body(), "another-key")).id).toBe(job.id);
    const snapshot = await state(); expect(snapshot.wallet.balanceCents).toBe(892); expect(supplier.fetch).toHaveBeenCalledTimes(1);
    expect(snapshot.ledger.filter(entry => entry.kind === "generation_charge")).toHaveLength(1);
  });
  it("links native prepaid usage to the real pool before media delivery without charging or observing twice", async () => {
    await adoptPool(); const job = await create();
    supplier.fetch.mockResolvedValueOnce(response({ id: "native-provider-task", status: "succeeded", usage: { completion_tokens: 250 } }));
    expect(await native.pollNativeVideo(owner, job.id)).toMatchObject({ status: "running", billing: { settledCents: 108 } });
    const snapshot = await state(), observed = await prisma.gatewayCreditSourceUsage.findUniqueOrThrow({ where: { billingEventId: snapshot.holds[0].eventId } });
    expect(snapshot.wallet.balanceCents).toBe(892); expect(snapshot.holds[0]).toMatchObject({ chargedCents: 108, settledCents: 1, status: "settled" });
    expect(observed).toMatchObject({ billingProvenance: "local_catalog", actualUsdUnits: null, eligibleUsdUnits: 0n, localPricingHash: contractHash(snapshot.jobs[0].tariff) });
    expect(await pool()).toMatchObject({ allocatedCents: 892n, consumedCents: 108n, balanceCents: 1000 });
    supplier.balance = "19.99"; supplier.sourceAgeMs = 0; await accounting.refreshGatewaySharedPoolFromSource();
    expect(await pool()).toMatchObject({ capacityCents: 1999n, balanceCents: 999 });
    supplier.fetch.mockResolvedValueOnce(response(success()));
    expect((await native.pollNativeVideo(owner, job.id)).status).toBe("succeeded");
    expect((await state()).wallet.balanceCents).toBe(892);
    expect(await prisma.gatewayCreditSourceUsage.findUniqueOrThrow({ where: { billingEventId: snapshot.holds[0].eventId } })).toEqual(observed);
    expect(await prisma.gatewayUsage.count()).toBe(1); expect(await prisma.gatewayBillingLedger.count({ where: { kind: "generation_charge" } })).toBe(1);
    expect(await prisma.gatewayCreditPoolLedger.count({ where: { kind: "debit" } })).toBe(0);
  });
  it("refunds native failure once while preserving positive supplier evidence and its physical source decrease", async () => {
    await adoptPool(); const job = await create();
    supplier.fetch.mockResolvedValueOnce(response({ id: "native-provider-task", status: "failed", usage: { completion_tokens: 250 } }));
    expect(await native.pollNativeVideo(owner, job.id)).toMatchObject({ status: "failed", billing: { refundedCents: 108, settledCents: 0 } });
    const snapshot = await state(); expect(snapshot.wallet.balanceCents).toBe(1000);
    expect(snapshot.holds[0]).toMatchObject({ status: "released", chargedCents: 108, refundedCents: 108, settledCents: 1 });
    expect(snapshot.usages).toHaveLength(1); expect(snapshot.usages[0]).toMatchObject({ status: "error", completionTokens: 250 });
    expect(await prisma.gatewayCreditSourceUsage.findUniqueOrThrow({ where: { billingEventId: snapshot.holds[0].eventId } })).toMatchObject({ actualUsdUnits: null, eligibleUsdUnits: 0n, billingProvenance: "local_catalog", localPricingHash: contractHash(snapshot.jobs[0].tariff) });
    supplier.balance = "19.99"; supplier.sourceAgeMs = 0; await accounting.refreshGatewaySharedPoolFromSource();
    expect(await pool()).toMatchObject({ status: "ready", allocatedCents: 1000n, consumedCents: 0n, capacityCents: 1999n, balanceCents: 999 });
    expect((await native.pollNativeVideo(owner, job.id)).status).toBe("failed");
    expect(await prisma.gatewayBillingLedger.count({ where: { kind: "generation_refund" } })).toBe(1);
    expect(await prisma.gatewayCreditPoolLedger.count({ where: { kind: "generation_refund" } })).toBe(1);
    expect(await prisma.gatewayCreditSourceUsage.count()).toBe(1);
  });
  it("recovers positive failed-task supplier evidence after a late source journal fault without refunding twice", async () => {
    await adoptPool(); const job = await create();
    const failed = { id: "native-provider-task", status: "failed", usage: { completion_tokens: 250 } };
    await prisma.$executeRawUnsafe('ALTER TABLE "GatewayCreditSourceUsage" ADD CONSTRAINT "native_prepaid_source_fault" CHECK ("actualUsdUnits" IS NOT NULL) NOT VALID');
    try {
      supplier.fetch.mockResolvedValueOnce(response(failed));
      await expect(native.pollNativeVideo(owner, job.id)).rejects.toBeTruthy();
      const rolledBack = await state(); expect(rolledBack.wallet.balanceCents).toBe(1000); expect(rolledBack.usages).toHaveLength(0);
      expect(rolledBack.holds[0]).toMatchObject({ refundedCents: 108, settledCents: null, usageId: null });
      expect(await prisma.gatewayCreditSourceUsage.count()).toBe(0); expect(await prisma.gatewayBillingLedger.count({ where: { kind: "usage" } })).toBe(0);
    } finally { await prisma.$executeRawUnsafe('ALTER TABLE "GatewayCreditSourceUsage" DROP CONSTRAINT "native_prepaid_source_fault"'); }
    supplier.fetch.mockResolvedValueOnce(response(failed));
    expect((await native.pollNativeVideo(owner, job.id)).status).toBe("failed");
    const recovered = await state(); expect(recovered.wallet.balanceCents).toBe(1000); expect(recovered.usages).toHaveLength(1);
    expect(recovered.holds[0]).toMatchObject({ refundedCents: 108, settledCents: 1, status: "released" });
    expect(await prisma.gatewayCreditSourceUsage.count()).toBe(1); expect(await prisma.gatewayBillingLedger.count({ where: { kind: "generation_refund" } })).toBe(1);
    await accounting.refreshGatewaySharedPoolFromSource(); expect((await pool()).status).toBe("ready");
  });
  it("keeps the successful native charge when media is pending and a contradictory failure requests a refund", async () => {
    await adoptPool(); const job = await create();
    supplier.fetch.mockResolvedValueOnce(response({ id: "native-provider-task", status: "succeeded", usage: { completion_tokens: 250 } }));
    expect(await native.pollNativeVideo(owner, job.id)).toMatchObject({ status: "running", billing: { settledCents: 108 } });
    const snapshot = await state();
    await expect(refundGatewayBillingHold({ userId: owner.id, eventId: snapshot.holds[0].eventId, reason: "confirmed_failed", evidenceFingerprint: contractHash({ taskId: "native-provider-task", status: "failed" }) })).rejects.toMatchObject({ code: "VIDEO_RECEIPT_MISMATCH" });
    supplier.fetch.mockResolvedValueOnce(response({ id: "native-provider-task", status: "failed", usage: { completion_tokens: 250 } }));
    await expect(native.pollNativeVideo(owner, job.id)).rejects.toMatchObject({ code: "VIDEO_RECEIPT_MISMATCH" });
    const preserved = await state(); expect(preserved.wallet.balanceCents).toBe(892);
    expect(preserved.holds[0]).toMatchObject({ status: "settled", settledCents: 1, chargedCents: 108, refundedCents: 0 });
    expect(preserved.jobs[0]).toMatchObject({ state: "processing", completionTokens: 250, resultUrl: null });
    expect(preserved.usages).toHaveLength(1); expect(preserved.usages[0].status).toBe("ok");
    expect(await prisma.gatewayCreditSourceUsage.count()).toBe(1); expect(await prisma.gatewayBillingLedger.count({ where: { kind: "generation_refund" } })).toBe(0);
  });
  it("rejects native success after a committed failure refund before the task state update", async () => {
    await adoptPool(); const job = await create(), snapshot = await state();
    await refundGatewayBillingHold({ userId: owner.id, eventId: snapshot.holds[0].eventId, reason: "confirmed_failed", evidenceFingerprint: contractHash({ taskId: "native-provider-task", status: "failed" }) });
    expect((await state()).jobs[0].state).toBe("processing");
    supplier.fetch.mockResolvedValueOnce(response(success()));
    await expect(native.pollNativeVideo(owner, job.id)).rejects.toBeTruthy();
    const preserved = await state(); expect(preserved.wallet.balanceCents).toBe(1000);
    expect(preserved.holds[0]).toMatchObject({ status: "released", refundedCents: 108, settledCents: null, usageId: null });
    expect(preserved.jobs[0].resultUrl).toBeNull(); expect(preserved.jobs[0].state).not.toBe("succeeded"); expect(preserved.usages).toHaveLength(0);
    expect(await prisma.gatewayCreditSourceUsage.count()).toBe(0); expect(await prisma.gatewayBillingLedger.count({ where: { kind: "generation_refund" } })).toBe(1);
  });
  it("allows only one consistent native financial outcome when completion and failure refund race", async () => {
    await adoptPool(); const job = await create(), original = await state();
    supplier.fetch.mockResolvedValueOnce(response(success()));
    const outcomes = await Promise.allSettled([
      native.pollNativeVideo(owner, job.id),
      refundGatewayBillingHold({ userId: owner.id, eventId: original.holds[0].eventId, reason: "confirmed_failed", evidenceFingerprint: contractHash({ taskId: "native-provider-task", status: "failed" }) })
    ]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const terminal = await state(), refunded = terminal.holds[0].refundedCents === 108;
    expect(terminal.wallet.balanceCents).toBe(refunded ? 1000 : 892);
    expect(terminal.usages).toHaveLength(refunded ? 0 : 1); expect(await prisma.gatewayCreditSourceUsage.count()).toBe(refunded ? 0 : 1);
    expect(terminal.jobs[0].state === "succeeded").toBe(!refunded); expect(terminal.jobs[0].resultUrl !== null).toBe(!refunded);
    expect(await prisma.gatewayBillingLedger.count({ where: { kind: "generation_refund" } })).toBe(refunded ? 1 : 0);
    expect(await pool()).toMatchObject({ allocatedCents: BigInt(refunded ? 1000 : 892), consumedCents: BigInt(refunded ? 0 : 108), balanceCents: 1000 });
  });
  it("refunds the prepaid quote if source readiness fails after registration but before dispatch", async () => {
    await adoptPool(); supplier.failSourceAfterCharge = true;
    supplier.fetch.mockResolvedValue(response({ id: "must-never-submit" }));
    await expect(native.createNativeVideo(owner, body(), "source-lost-before-dispatch")).rejects.toBeTruthy();
    expect(supplier.fetch).not.toHaveBeenCalled();
    const failed = await state(); expect(failed.wallet.balanceCents).toBe(1000);
    expect(failed.holds).toHaveLength(1); expect(failed.holds[0]).toMatchObject({ status: "released", chargedCents: 108, refundedCents: 108, dispatchedAt: null });
    expect(failed.jobs[0]).toMatchObject({ state: "failed", providerTaskId: null }); expect(failed.usages).toHaveLength(0);
    expect(await prisma.gatewayCreditSourceUsage.count()).toBe(0);
    expect(await prisma.gatewayBillingLedger.count({ where: { kind: "generation_charge" } })).toBe(1);
    expect(await prisma.gatewayBillingLedger.count({ where: { kind: "generation_refund" } })).toBe(1);
    expect(await prisma.gatewayCreditPoolLedger.count({ where: { kind: "generation_refund" } })).toBe(1);
    expect(await native.createNativeVideo(owner, body(), "source-lost-before-dispatch")).toMatchObject({ status: "failed", billing: { refundedCents: 108 } });
    expect(supplier.fetch).not.toHaveBeenCalled(); expect(await prisma.gatewayBillingLedger.count({ where: { kind: "generation_refund" } })).toBe(1);
  });
});
