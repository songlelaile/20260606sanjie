import "server-only";
import { assertGatewayAllocationBudget, openGatewayAllocationWindow, recordGatewayAllocation, getGatewayVerificationReceipt, recordGatewayVerification } from "./credit-allocation-window";
import { createHash, randomUUID } from "node:crypto";
import { Prisma, type GatewayCreditPool } from "@prisma/client";
import { prisma } from "@/lib/db";
import { GATEWAY_PLANS } from "./catalog";
import { GatewayBillingError, GATEWAY_DEFAULT_MULTIPLIER_BPS, GATEWAY_MAX_COST_CENTS, sanitizeGatewayFxSnapshot, type GatewayBillingSnapshot } from "./billing-contract";
import { getRelayRuntime } from "./relay-config";
import { requireGatewayFxSnapshot } from "./exchange-rate";
import { lockGatewayAccountingIdentities, lockGatewayAccountingPool } from "./accounting-coordination";
import { billingRulesHash, contractHash, evaluateGatewayPoolSource, formatFixed, parseFixed, quoteGatewayCharge, type SourceQuoteInput } from "./source-quote.mjs";
import { evaluateSharedWalletSource, type SharedWalletProof } from "./shared-wallet-quote.mjs";
import { getGatewaySharedSourceConfigVersion, readGatewaySharedWalletSource, type SharedWalletSourceObservation } from "./shared-wallet-source";
import { getUserSupplyCredential } from "./user-supply";
import { localGatewayCharge, validateGatewayLocalChargeEvidence, validateGatewayLocalPricing } from "./local-pricing";
import { gatewayBillingSettlementOutcome } from "./billing-hold";
import { applyGatewayBillingCost } from "./billing-contract";
import { nativeCoverageCost, validateNativeChargeEvidence, type NativeDispatchBinding } from "./native-credit-coverage";
import { digest, stable, NATIVE_VIDEO_ENDPOINT } from "./native-video-contract";
import { assertGatewaySubmissionCharge, submissionLedgerEvent } from "./submission-billing";
import { SharedWalletSourceError } from "./shared-wallet-usage.mjs";

const SHARED_SCOPE = "shared_user_lifetime_wallet";
const shared = (proof: unknown): proof is SharedWalletProof => !!proof && typeof proof === "object" && (proof as { scope?: string }).scope === SHARED_SCOPE;
const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex");
export type SharedHoldBinding = { schema: "SANJIE_SHARED_HOLD_BINDING_V1"; scope: "shared_user_lifetime_wallet";
  epochId: string; sourceIdentityHash: string; credentialFingerprint: string; routingBindingHash: string;
  providerBaseUrl: string; configVersion: string;
  // In this branch the root reference backs site credits; it is not the native request key.
  bindingPurpose?: "native_funding"; nativeDispatch?: NativeDispatchBinding };

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function fail(code: string): never { throw new GatewayBillingError(code, "总积分池来源或会计状态需核对", 409); }
function usdUnits(value: string) { try { return parseFixed(value, 8); } catch { return fail("POOL_ACCOUNTED_USD_MISMATCH"); } }
function exactInput(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.sort().join()) fail("POOL_INPUT_INVALID");
}

async function activeAdmin(tx: Prisma.TransactionClient, adminId: string, adoptAllUsers = false) {
  if (!ID.test(adminId)) fail("POOL_INPUT_INVALID");
  await lockGatewayAccountingIdentities(tx, []);
  const identities = adoptAllUsers ? (await tx.user.findMany({ select: { id: true } })).map(row => row.id) : [adminId];
  await lockGatewayAccountingIdentities(tx, identities);
  const admin = await tx.user.findUnique({ where: { id: adminId } });
  if (!admin || admin.status !== "active" || admin.authRole !== "admin") throw new GatewayBillingError("ADMIN_REQUIRED", "仅有效管理员可核对总积分池", 403);
  return admin;
}

/** Full inventory, including disabled users. H is a subset of W, never a second deduction.
 * Legacy wallets with no ledger are explicitly fingerprinted; opening is added at commit.
 */
async function inventory(tx: Prisma.TransactionClient) {
  const wallets = await tx.gatewayWallet.findMany({ orderBy: { userId: "asc" } });
  const sums = await tx.gatewayBillingLedger.groupBy({ by: ["userId"], _sum: { deltaCents: true }, _count: { _all: true } });
  const byUser = new Map(sums.map(row => [row.userId, row]));
  const holds = await tx.gatewayBillingHold.findMany({ where: { status: { in: ["reserved", "dispatched", "unknown"] } }, orderBy: { eventId: "asc" } });
  const bindings = await tx.gatewaySupplyCredential.findMany({ where: { id: { in: holds.flatMap(row => row.credentialId ? [row.credentialId] : []) } },
    select: { id: true, userId: true, status: true, providerKeyId: true, providerOwnerId: true, providerGroupId: true, readyAt: true } });
  const held = holds.map(row => {
    const frozen = row.billingSnapshot as unknown as { fxSnapshot?: unknown; multiplierBps?: number };
    if (!frozen.fxSnapshot) fail("HOLD_PRICE_UNPROVEN");
    const fx = sanitizeGatewayFxSnapshot(frozen.fxSnapshot);
    return { eventId: row.eventId, userId: row.userId, status: row.status as "reserved" | "dispatched" | "unknown", heldCents: row.heldCents, fxRate: String(fx.rate), multiplierBps: frozen.multiplierBps!,
      provider: row.provider, credentialId: row.credentialId, binding: bindings.find(binding => binding.id === row.credentialId) ?? null };
  });
  const states = wallets.map(row => ({ userId: row.userId, balanceCents: row.balanceCents,
    ledgerBalanceCents: byUser.get(row.userId)?._sum.deltaCents ?? row.balanceCents,
    legacyOpeningRequired: !byUser.has(row.userId) }));
  const waiting = await tx.gatewayOrder.findMany({ where: { creditAllocationState: "awaiting_capacity" }, select: { id: true, userId: true, creditCents: true, paymentReceipt: true }, orderBy: { id: "asc" } });
  // These are verified but unallocated payments. They are approval obligations, not P.
  // No order has a capacity reservation in this minimal candidate.
  const hash = contractHash({ wallets: states, holds: held, awaitingPayments: waiting });
  return { wallets, states, holds: held, waiting, hash };
}

async function effectiveRules(tx: Prisma.TransactionClient) {
  const saved = await tx.gatewayBillingRule.findMany({ orderBy: { planCode: "asc" } });
  const byCode = new Map(saved.map(row => [row.planCode, row]));
  const codes = [...new Set(["free", ...GATEWAY_PLANS.map(plan => plan.code), ...saved.map(rule => rule.planCode)])].sort();
  return codes.map(planCode => ({ planCode, multiplierBps: byCode.get(planCode)?.multiplierBps ?? GATEWAY_DEFAULT_MULTIPLIER_BPS, version: byCode.get(planCode)?.version ?? 0 }));
}

/** Private credentials enter a digest only. Changes of destination/model/key/FX/rules invalidate source approval. */
export async function gatewayPoolRuntimeConfigHash(tx: Prisma.TransactionClient, proof: SourceQuoteInput) {
  const runtime = await getRelayRuntime();
  const sourcePolicy = Object.fromEntries(Object.entries(proof.expected).filter(([key]) => !["configVersion", "poolVersion", "fxSnapshotHash", "billingRulesHash"].includes(key)));
  return contractHash({ sourcePolicy, providerRuntime: { baseUrl: runtime.baseUrl, credentialHash: contractHash(runtime.apiKey),
    models: runtime.models, shopKeysHash: contractHash(runtime.shopKeys) }, rules: await effectiveRules(tx),
    fxMode: requireGatewayFxSnapshot(runtime)?.source, pricingCoverage: { costCoverage: proof.pricing.costCoverage, envelopeEvidenceHash: proof.pricing.envelopeEvidenceHash } });
}

/** A server config pin is required independently of the persisted source assertion.
 * This is a hash only, never a capacity ENV. There is no HTTP snapshot insertion API.
 */
async function sourceProof(tx: Prisma.TransactionClient, snapshotId: string, snapshotHash?: string) {
  const snapshot = await tx.gatewayCreditSourceSnapshot.findUnique({ where: { id: snapshotId } });
  if (!snapshot || snapshot.status !== "verified" || !HASH.test(snapshot.snapshotHash) || (snapshotHash && snapshot.snapshotHash !== snapshotHash)) fail("POOL_SOURCE_UNVERIFIED");
  if (shared(snapshot.proof)) {
    const proof = snapshot.proof;
    if (snapshot.sourceScope !== SHARED_SCOPE || snapshot.accountingEpochId !== proof.epoch.id ||
      contractHash(proof) !== snapshot.snapshotHash || (snapshotHash && snapshot.snapshotHash !== snapshotHash) ||
      snapshot.identityHash !== proof.binding.authorityHash || snapshot.nativeUnit !== "USD" ||
      snapshot.providerBaseUrl !== `${proof.binding.origin}/v1` || snapshot.observedAt.toISOString() !== proof.source.capturedAt ||
      snapshot.expiresAt.getTime() <= Date.now() || proof.policy.configVersion !== await getGatewaySharedSourceConfigVersion() ||
      snapshot.conversionPolicyHash !== contractHash({ scope: proof.scope, binding: proof.binding, epoch: proof.epoch, policy: proof.policy })) fail("POOL_SOURCE_UNVERIFIED");
    const latest = await tx.gatewayCreditSourceSnapshot.findFirst({ where: { identityHash: snapshot.identityHash, observedAt: { gt: snapshot.observedAt } } });
    if (latest) fail("POOL_SOURCE_SUPERSEDED");
    const runtime = await getRelayRuntime(), fx = requireGatewayFxSnapshot(runtime);
    if (!fx || contractHash(await effectiveRules(tx)) !== contractHash(proof.pricing.rules) ||
      contractHash({ rate: String(fx.rate), source: fx.source, quoteId: fx.id, fetchedAt: fx.fetchedAt, referenceDate: fx.referenceDate }) !== contractHash(proof.pricing.fx)) fail("POOL_PRICING_CHANGED");
    return { snapshot, proof: proof as unknown as SourceQuoteInput, sharedProof: proof };
  }
  const pin = process.env.GATEWAY_CREDIT_SOURCE_CONFIG_HASH ?? "";
  const proof = snapshot.proof as unknown as SourceQuoteInput & { gatewayBinding?: { baseUrl?: string } };
  if (!HASH.test(pin) || !proof?.expected || proof.expected.configVersion !== pin || contractHash(snapshot.proof) !== snapshot.snapshotHash ||
    snapshot.identityHash !== proof.expected.upstreamIdentityHash || snapshot.nativeUnit !== "USD" ||
    snapshot.conversionPolicyHash !== contractHash({ expected: proof.expected, pricing: proof.pricing }) ||
    snapshot.observedAt.toISOString() !== proof.source?.capturedAt || snapshot.expiresAt.getTime() <= Date.now()) fail("POOL_SOURCE_UNVERIFIED");
  if (await gatewayPoolRuntimeConfigHash(tx, proof) !== pin) fail("POOL_RUNTIME_CONFIG_CHANGED");
  if (!snapshot.providerBaseUrl || proof.gatewayBinding?.baseUrl !== snapshot.providerBaseUrl || (await getRelayRuntime()).baseUrl !== snapshot.providerBaseUrl) fail("POOL_RUNTIME_CONFIG_CHANGED");
  const newer = await tx.gatewayCreditSourceSnapshot.findFirst({ where: { identityHash: snapshot.identityHash, observedAt: { gt: snapshot.observedAt } } });
  if (newer) fail("POOL_SOURCE_SUPERSEDED");
  const rules = await effectiveRules(tx);
  if (billingRulesHash(rules, GATEWAY_DEFAULT_MULTIPLIER_BPS) !== proof.expected.billingRulesHash) fail("POOL_PRICING_CHANGED");
  const runtime = await getRelayRuntime();
  const fx = requireGatewayFxSnapshot(runtime);
  if (!fx || contractHash({ rate: String(fx.rate), source: fx.source, quoteId: fx.id, fetchedAt: fx.fetchedAt, referenceDate: fx.referenceDate }) !== proof.expected.fxSnapshotHash) fail("POOL_FX_CHANGED");
  return { snapshot, proof, sharedProof: null };
}

async function adoptionFacts(tx: Prisma.TransactionClient, snapshotId: string, snapshotHash: string, revision: number) {
  const { snapshot, proof, sharedProof } = await sourceProof(tx, snapshotId, snapshotHash);
  const inv = await inventory(tx);
  if (sharedProof) {
    if (inv.holds.some(hold => hold.status !== "reserved")) fail("POOL_SHARED_INFLIGHT_UNPROVEN");
    if (usdUnits(sharedProof.liabilities.accountedUsd) !== 0n) fail("POOL_INITIAL_CONSUMPTION_UNPROVEN");
    const liabilities = sharedLiabilities(inv, revision, sharedProof.epoch.id, 0n, []);
    const evaluated = evaluateSharedWalletSource({ ...sharedProof, now: new Date().toISOString(), liabilities });
    if (!evaluated.ready) fail(evaluated.blockedReasons[0]?.code ?? "POOL_SOURCE_UNVERIFIED");
    if (snapshot.capacityCents !== evaluated.quote.points.totalCents) fail("POOL_SOURCE_CAPACITY_CHANGED");
    return { snapshot, inv, quote: evaluated.quote, sharedProof };
  }
  for (const hold of inv.holds.filter(hold => hold.status !== "reserved")) {
    if (hold.provider !== "shaozhuang" || !hold.binding || hold.binding.userId !== hold.userId || hold.binding.status !== "ready" ||
      hold.binding.providerOwnerId !== proof.expected.issuerUserId || hold.binding.providerGroupId !== proof.expected.groupId) fail("POOL_SOURCE_USAGE_UNPROVEN");
  }
  // First adoption uses C=0 and no historical USD add-back. The remaining source must back W.
  if (usdUnits(proof.source.issuer.cycleAccountedUsd) !== 0n || usdUnits(proof.liabilities.cycleAccountedUsd) !== 0n) fail("POOL_INITIAL_CONSUMPTION_UNPROVEN");
  const now = new Date().toISOString();
  const evaluated = evaluateGatewayPoolSource({ ...proof, now,
    liabilities: { ...proof.liabilities, capturedAt: now, evidenceHash: inv.hash, complete: true, consistent: true,
      poolVersion: revision, consumedCents: 0, wallets: inv.states.map(({ userId, balanceCents, ledgerBalanceCents }) => ({ userId, balanceCents, ledgerBalanceCents })),
      holds: inv.holds, pendingReservations: [] }
  });
  if (!evaluated.ready) fail(evaluated.blockedReasons[0]?.code ?? "POOL_SOURCE_UNVERIFIED");
  if (snapshot.capacityCents !== evaluated.quote.points.totalCents) fail("POOL_SOURCE_CAPACITY_CHANGED");
  return { snapshot, inv, quote: evaluated.quote, sharedProof: null };
}

export async function prepareGatewayPoolAdoption(adminId: string, value: unknown) {
  exactInput(value, ["snapshotId", "snapshotHash"]);
  if (typeof value.snapshotId !== "string" || !ID.test(value.snapshotId) || typeof value.snapshotHash !== "string" || !HASH.test(value.snapshotHash)) fail("POOL_INPUT_INVALID");
  const input = { snapshotId: value.snapshotId, snapshotHash: value.snapshotHash };
  return prisma.$transaction(async tx => {
    await activeAdmin(tx, adminId, true);
    const pool = await lockGatewayAccountingPool(tx);
    if (pool && (pool.accountingVersion !== 0 || pool.status !== "pending" || pool.balanceCents !== 0)) fail("POOL_ALREADY_INITIALIZED");
    const facts = await adoptionFacts(tx, input.snapshotId, input.snapshotHash, pool?.revision ?? 0);
    const proposal = await tx.gatewayCreditPoolProposal.create({ data: {
      snapshotId: facts.snapshot.id, snapshotHash: facts.snapshot.snapshotHash, identityHash: facts.snapshot.identityHash,
      conversionPolicyHash: facts.snapshot.conversionPolicyHash!, adminId, version: (pool?.revision ?? 0) + 1,
      capacityCents: facts.quote.points.totalCents, walletTotalCents: BigInt(facts.quote.points.walletCents),
      heldSubsetCents: BigInt(facts.quote.points.heldCents), walletStateHash: facts.inv.hash,
      expiresAt: new Date(Math.min(Date.parse(facts.quote.proposalExpiresAt), facts.snapshot.expiresAt.getTime()))
    } });
    return { proposalId: proposal.id, version: proposal.version, snapshotId: proposal.snapshotId, snapshotHash: proposal.snapshotHash,
      sourceIdentityHash: proposal.identityHash, capacityCents: proposal.capacityCents, walletTotalCents: Number(proposal.walletTotalCents),
      heldSubsetCents: Number(proposal.heldSubsetCents), allocatableCents: proposal.capacityCents - Number(proposal.walletTotalCents),
      awaitingPaidOrders: facts.inv.waiting.length, expiresAt: proposal.expiresAt.toISOString() };
  }, { timeout: 20_000 });
}

/** Guarded atomic activation. Production remains unconfigured; this is never called automatically.
 * Client input contains only immutable proposal references plus an idempotency key.
 */
export async function initializeGatewayCreditPool(adminId: string, value: unknown) {
  exactInput(value, ["proposalId", "version", "snapshotHash", "requestKey"]);
  if (typeof value.proposalId !== "string" || !ID.test(value.proposalId) || !Number.isSafeInteger(value.version) || Number(value.version) < 1 ||
    typeof value.snapshotHash !== "string" || !HASH.test(value.snapshotHash) || typeof value.requestKey !== "string" || !UUID.test(value.requestKey)) fail("POOL_INPUT_INVALID");
  const input = { proposalId: value.proposalId, version: Number(value.version), snapshotHash: value.snapshotHash, requestKey: value.requestKey.toLowerCase() };
  return prisma.$transaction(async tx => {
    await activeAdmin(tx, adminId, true);
    const pool = await lockGatewayAccountingPool(tx);
    const replay = await tx.gatewayCreditPoolLedger.findUnique({ where: { eventId: `adoption:${input.requestKey}` } });
    if (replay) {
      if (replay.kind !== "adoption" || replay.actorId !== adminId || replay.proposalId !== input.proposalId) fail("POOL_REQUEST_CONFLICT");
      const adopted = await tx.gatewayCreditPoolProposal.findUnique({ where: { id: replay.proposalId! } });
      if (!adopted || adopted.version !== input.version || adopted.snapshotHash !== input.snapshotHash) fail("POOL_REQUEST_CONFLICT");
      return { initialized: true, replayed: true, eventId: replay.eventId };
    }
    const proposal = await tx.gatewayCreditPoolProposal.findUnique({ where: { id: input.proposalId } });
    if (!proposal || proposal.kind !== "adoption" || proposal.adminId !== adminId || proposal.version !== input.version || proposal.snapshotHash !== input.snapshotHash || proposal.expiresAt.getTime() <= Date.now()) fail("POOL_PROPOSAL_STALE");
    if (pool && (pool.accountingVersion !== 0 || pool.status !== "pending" || pool.balanceCents !== 0)) fail("POOL_ALREADY_INITIALIZED");
    if ((pool?.revision ?? 0) + 1 !== proposal.version) fail("POOL_PROPOSAL_STALE");
    const facts = await adoptionFacts(tx, proposal.snapshotId, proposal.snapshotHash, pool?.revision ?? 0);
    if (facts.inv.hash !== proposal.walletStateHash || facts.quote.points.totalCents !== proposal.capacityCents ||
      BigInt(facts.quote.points.walletCents) !== proposal.walletTotalCents || BigInt(facts.quote.points.heldCents) !== proposal.heldSubsetCents ||
      facts.snapshot.identityHash !== proposal.identityHash || facts.snapshot.conversionPolicyHash !== proposal.conversionPolicyHash) fail("POOL_PROPOSAL_STALE");
    if (facts.sharedProof) {
      // Adoption is itself an allocation. Read posted B again under the global fence;
      // an approved older quote can only be used if the current asset still covers it.
      const current = await readGatewaySharedWalletSource();
      if (current.binding.authorityHash !== facts.snapshot.identityHash || current.policy.configVersion !== facts.sharedProof.policy.configVersion ||
        current.policy.configVersion !== await getGatewaySharedSourceConfigVersion() ||
        current.epoch && contractHash(current.epoch) !== contractHash(facts.sharedProof.epoch)) fail("POOL_PROPOSAL_STALE");
      const checked = evaluateSharedWalletSource({...facts.sharedProof,source:current.source,externalCommitments:current.externalCommitments,now:new Date().toISOString()});
      if (!checked.ready || checked.quote.points.totalCents < proposal.capacityCents) fail("POOL_PROPOSAL_STALE");
      await sourceProof(tx,facts.snapshot.id,facts.snapshot.snapshotHash);
    }
    // Opening journals document legacy balances without changing a single wallet cent.
    for (const row of facts.inv.states.filter(row => row.legacyOpeningRequired)) {
      const user = await tx.user.findUniqueOrThrow({ where: { id: row.userId }, include: { tenant: { select: { name: true } } } });
      const wallet = facts.inv.wallets.find(wallet => wallet.userId === row.userId)!;
      await tx.gatewayBillingLedger.create({ data: { billingEventId: `opening:${user.id}`, kind: "opening", userId: user.id,
        tenantId: user.tenantId, tenantName: user.tenant.name, username: user.username, userName: user.name,
        planCode: wallet.planCode, planName: wallet.planName, deltaCents: wallet.balanceCents,
        balanceBeforeCents: 0, balanceAfterCents: wallet.balanceCents, status: "ok", reason: "总池初始化采用既有钱包余额" } });
    }
    const data = { status: "ready", accountingVersion: 1, capacityCents: BigInt(proposal.capacityCents),
      allocatedCents: proposal.walletTotalCents, consumedCents: 0n, deficitCents: 0n,
      sourceSnapshotId: proposal.snapshotId, balanceCents: proposal.capacityCents - Number(proposal.walletTotalCents), revision: proposal.version,
      ...(facts.sharedProof ? { sourceScope: SHARED_SCOPE, accountingEpochId: facts.sharedProof.epoch.id,
        accountingEpochStartedAt: new Date(facts.sharedProof.epoch.startedAt), frozenValuationProduct: BigInt(facts.sharedProof.policy.frozenValuationProduct!) } : {}) };
    await tx.gatewayCreditPool.upsert({ where: { id: "total" }, update: data, create: { id: "total", ...data } });
    await tx.gatewayCreditPoolLedger.create({ data: { eventId: `adoption:${input.requestKey}`, kind: "adoption", poolId: "total", actorId: adminId,
      proposalId: proposal.id, sourceSnapshotId: proposal.snapshotId, deltaAllocatedCents: proposal.walletTotalCents, deltaConsumedCents: 0n,
      capacityCents: BigInt(proposal.capacityCents), capacityBeforeCents: 0n, allocatedBeforeCents: 0n, allocatedAfterCents: proposal.walletTotalCents,
      consumedBeforeCents: 0n, consumedAfterCents: 0n, allocatableBeforeCents: 0, allocatableAfterCents: data.balanceCents, deficitBeforeCents: 0n, deficitAfterCents: 0n } });
    await openGatewayAllocationWindow(tx, await tx.gatewayCreditPool.findUniqueOrThrow({ where: { id: "total" } }));
    return { initialized: true, replayed: false, eventId: `adoption:${input.requestKey}` };
  }, { timeout: 20_000 });
}

/** Status alone is insufficient: fresh proof, latest observation and live policy pins are required. */
export async function assertGatewayPoolReady(tx: Prisma.TransactionClient, pool: GatewayCreditPool | null) {
  if (!pool || pool.status !== "ready" || pool.accountingVersion !== 1 || !pool.sourceSnapshotId) fail("CREDIT_POOL_NOT_READY");
  if (pool.balanceCents < 0 || pool.balanceCents > GATEWAY_MAX_COST_CENTS || pool.deficitCents !== 0n ||
    BigInt(pool.balanceCents) + pool.allocatedCents + pool.consumedCents !== pool.capacityCents) fail("CREDIT_POOL_INVALID");
  const { snapshot, proof, sharedProof } = await sourceProof(tx, pool.sourceSnapshotId);
  if (sharedProof) {
    if (pool.sourceScope !== SHARED_SCOPE || pool.accountingEpochId !== sharedProof.epoch.id ||
      pool.accountingEpochStartedAt?.toISOString() !== sharedProof.epoch.startedAt || String(pool.frozenValuationProduct) !== sharedProof.policy.frozenValuationProduct) fail("CREDIT_POOL_INVALID");
    const evaluated = evaluateSharedWalletSource({ ...sharedProof, now: new Date().toISOString() });
    if (!evaluated.ready || snapshot.capacityCents !== Number(pool.capacityCents)) fail("CREDIT_POOL_NOT_READY");
    return;
  }
  const evaluated = evaluateGatewayPoolSource(proof);
  if (!evaluated.ready || snapshot.capacityCents !== Number(pool.capacityCents) ||
    Date.parse(evaluated.quote.proposalExpiresAt) <= Date.now() || Date.parse(proof.expected.cycleEndsAt) <= Date.now()) fail("CREDIT_POOL_NOT_READY");
}

/** Validate before new provider dispatch. Existing holds settle their original frozen quote. */
export async function assertGatewayPoolNewQuote(tx: Prisma.TransactionClient, snapshot: GatewayBillingSnapshot) {
  const pool = await lockGatewayAccountingPool(tx);
  if (!pool || pool.accountingVersion === 0) return;
  await assertGatewayPoolReady(tx, pool);
  const { proof, sharedProof } = await sourceProof(tx, pool.sourceSnapshotId!);
  if (sharedProof) {
    // New dispatch must cover the exact effective valuation of the current
    // fully verified source proof, while its immutable adoption ceiling stays fixed.
    const quoted = evaluateSharedWalletSource({ ...sharedProof, now: new Date().toISOString() });
    if (!quoted.ready || !snapshot.fxSnapshot) fail("POOL_QUOTE_UNBACKED");
    const fx = sanitizeGatewayFxSnapshot(snapshot.fxSnapshot);
    if (parseFixed(String(fx.rate), 6) * BigInt(snapshot.multiplierBps) < BigInt(quoted.quote.pricing.valuationProduct)) fail("POOL_QUOTE_UNBACKED");
    return;
  }
  const quoted = evaluateGatewayPoolSource(proof);
  if (!quoted.ready || !snapshot.fxSnapshot) fail("POOL_QUOTE_UNBACKED");
  const fx = sanitizeGatewayFxSnapshot(snapshot.fxSnapshot);
  const product = parseFixed(String(fx.rate), 6) * BigInt(snapshot.multiplierBps);
  if (product < BigInt(quoted.quote.pricing.valuationProduct)) fail("POOL_QUOTE_UNBACKED");
}

/** The native tariff is RMB-denominated. FX only proves the monetary funding floor. */
export async function gatewayNativeFundingSnapshot(snapshot: GatewayBillingSnapshot): Promise<GatewayBillingSnapshot> {
  const pool=await prisma.gatewayCreditPool.findUnique({where:{id:"total"},select:{accountingVersion:true,sourceScope:true}});
  if (!pool || pool.accountingVersion!==1 || pool.sourceScope!==SHARED_SCOPE) return snapshot;
  const fx=requireGatewayFxSnapshot(await getRelayRuntime());
  if (!fx) fail("POOL_QUOTE_UNBACKED");
  return {...snapshot,fxSnapshot:fx};
}

/** Called under the original reservation/failover wallet lock, before a provider POST. */
export async function bindGatewayNativePoolFunding(tx: Prisma.TransactionClient, eventId: string, dispatch: Omit<NativeDispatchBinding,"tariffHash"|"credentialId">) {
  const pool=await lockGatewayAccountingPool(tx);
  if (!pool || pool.accountingVersion===0 || pool.sourceScope!==SHARED_SCOPE) return null;
  await assertGatewayPoolReady(tx,pool);
  const hold=await tx.gatewayBillingHold.findUnique({where:{eventId}});
  const job=await tx.gatewayNativeVideoJob.findUnique({where:{id:dispatch.jobId}});
  if (!hold || !job || job.eventId!==hold.eventId || job.userId!==hold.userId || job.tenantId!==hold.tenantId || hold.endpoint!==NATIVE_VIDEO_ENDPOINT ||
    hold.model!==job.model || hold.provider!==dispatch.provider || !["reserved","dispatched"].includes(hold.status) ||
    !["reserved","submitting"].includes(job.state) || job.providerTaskId || job.bindingFingerprint!==dispatch.bindingFingerprint ||
    !HASH.test(dispatch.keyFingerprint)) fail("POOL_SOURCE_USAGE_UNPROVEN");
  const {snapshot,sharedProof}=await sourceProof(tx,pool.sourceSnapshotId!);
  if (!sharedProof || !pool.accountingEpochId || !pool.accountingEpochStartedAt || job.createdAt < pool.accountingEpochStartedAt) fail("POOL_SOURCE_USAGE_UNPROVEN");
  const nativeDispatch={...dispatch,tariffHash:contractHash(job.tariff),credentialId:job.credentialId};
  // Validate the endpoint/provider envelope without claiming any supplier USD.
  validateNativeChargeEvidence({schema:"SANJIE_NATIVE_CHARGE_V1",...dispatch,tariffHash:nativeDispatch.tariffHash,priceVersion:(job.tariff as {priceVersion:string}).priceVersion,
    taskId:"not-yet-submitted",completionTokens:0,outcomeHash:contractHash("reserved")});
  const previous=hold.sourceBinding as unknown as SharedHoldBinding | null;
  if (previous && (previous.bindingPurpose!=="native_funding" || previous.epochId!==pool.accountingEpochId || previous.sourceIdentityHash!==snapshot.identityHash ||
    previous.nativeDispatch?.jobId!==job.id || previous.nativeDispatch.tariffHash!==nativeDispatch.tariffHash)) fail("POOL_SOURCE_USAGE_UNPROVEN");
  const binding: SharedHoldBinding={schema:"SANJIE_SHARED_HOLD_BINDING_V1",scope:SHARED_SCOPE,epochId:pool.accountingEpochId,sourceIdentityHash:snapshot.identityHash,
    credentialFingerprint:sharedProof.binding.credentialFingerprint,routingBindingHash:sharedProof.binding.routeGroupBinding.bindingEvidenceHash,
    providerBaseUrl:snapshot.providerBaseUrl!,configVersion:sharedProof.policy.configVersion,bindingPurpose:"native_funding",nativeDispatch};
  await tx.$executeRaw`UPDATE "GatewayBillingHold" SET "sourceBinding"=${JSON.stringify(binding)}::JSONB WHERE "eventId"=${eventId}`;
  return binding;
}

async function assertNativeCoverage(tx: Prisma.TransactionClient, hold: Awaited<ReturnType<Prisma.TransactionClient["gatewayBillingHold"]["findUniqueOrThrow"]>>, binding: SharedHoldBinding,
  input: {baseCostCents:number;chargedCostCents:number;metadata:Prisma.InputJsonObject}, outcome: string | null) {
  const d=binding.nativeDispatch;
  const e=validateNativeChargeEvidence(input.metadata.nativeChargeEvidence);
  const job=await tx.gatewayNativeVideoJob.findUnique({where:{id:e.jobId}});
  if (binding.bindingPurpose!=="native_funding" || !d || !job || !job.providerTaskId || hold.endpoint!==NATIVE_VIDEO_ENDPOINT ||
    job.id!==d.jobId || job.eventId!==hold.eventId || job.userId!==hold.userId || job.tenantId!==hold.tenantId || job.model!==hold.model ||
    !(e.status === "failed" ? hold.billingMode === "prepaid_quote" && ["processing","failed"].includes(job.state) : ["processing","succeeded"].includes(job.state)) || hold.provider!==d.provider || e.provider!==d.provider || e.endpoint!==d.endpoint ||
    e.keyFingerprint!==d.keyFingerprint || e.bindingFingerprint!==d.bindingFingerprint || job.bindingFingerprint!==d.bindingFingerprint ||
    (job.credentialId ?? null)!==d.credentialId || (hold.credentialId ?? null)!==d.credentialId || e.tariffHash!==d.tariffHash ||
    input.metadata.costSource!=="catalog" || input.metadata.usdCost!==undefined || input.metadata.usdCostLexical!==undefined ||
    e.taskId!==job.providerTaskId || input.metadata.nativeVideoJobId!==job.id || input.metadata.priceVersion!==e.priceVersion || e.outcomeHash!==outcome ||
    (["succeeded","failed"].includes(job.state) && job.completionTokens!==e.completionTokens) ||
    input.baseCostCents!==nativeCoverageCost(job.tariff,e) || input.chargedCostCents!==applyGatewayBillingCost(input.baseCostCents,hold.billingSnapshot as unknown as GatewayBillingSnapshot) ||
    e.outcomeHash!==digest(stable({id:job.providerTaskId,status:e.status ?? "succeeded",tokens:e.completionTokens,priceVersion:e.priceVersion,baseCostCents:input.baseCostCents}))) fail("POOL_SOURCE_USAGE_UNPROVEN");
  return {job,e};
}

/** The published catalog fallback cannot settle an adopted actual-USD-required pool.
 * Missing authoritative cost leaves the original hold for reconciliation, without another debit.
 */
export async function assertGatewayPoolUsageEvidence(tx: Prisma.TransactionClient, snapshot: GatewayBillingSnapshot, input: {
  eventId: string; baseCostCents: number; chargedCostCents: number; metadata: Prisma.InputJsonObject;
}) {
  const pool = await lockGatewayAccountingPool(tx);
  if (!pool || pool.accountingVersion === 0) return;
  const stored = await tx.gatewayCreditSourceSnapshot.findUnique({ where: { id: pool.sourceSnapshotId ?? "" } });
  if (!stored || stored.status !== "verified") fail("POOL_SOURCE_USAGE_UNPROVEN");
  const proof = stored.proof as unknown as SourceQuoteInput;
  const hold = await tx.gatewayBillingHold.findUnique({ where: { eventId: input.eventId } });
  if (shared(stored.proof)) {
    if (!hold || hold.userId !== snapshot.userId || !hold.dispatchedAt || !pool.accountingEpochStartedAt ||
      hold.dispatchedAt < pool.accountingEpochStartedAt) fail("POOL_SOURCE_USAGE_UNPROVEN");
    const binding = hold.sourceBinding as unknown as SharedHoldBinding | null;
    if (!binding || binding.scope !== SHARED_SCOPE || binding.epochId !== pool.accountingEpochId || binding.sourceIdentityHash !== stored.identityHash ||
      !HASH.test(binding.credentialFingerprint) || binding.providerBaseUrl !== stored.providerBaseUrl || (binding.bindingPurpose!=="native_funding" && input.metadata.baseUrl !== binding.providerBaseUrl) ||
      binding.routingBindingHash !== stored.proof.binding.routeGroupBinding.bindingEvidenceHash) fail("POOL_SOURCE_USAGE_UNPROVEN");
    if (![stored.proof.binding.credentialFingerprint, ...stored.proof.binding.approvedCredentialFingerprints].includes(binding.credentialFingerprint)) fail("POOL_SOURCE_USAGE_UNPROVEN");
    if (binding.bindingPurpose==="native_funding") {
      if (stored.proof.pricing.costCoverage!=="local_catalog_or_actual_usd") fail("POOL_SOURCE_USAGE_UNPROVEN");
      await assertNativeCoverage(tx,hold,binding,input,gatewayBillingSettlementOutcome(tx));return;
    }
    if (hold.provider!=="shaozhuang" || binding.nativeDispatch) fail("POOL_SOURCE_USAGE_UNPROVEN");
    if (input.metadata.costSource === "catalog") {
      if (stored.proof.pricing.costCoverage !== "local_catalog_or_actual_usd") fail("POOL_SOURCE_USAGE_UNPROVEN");
      const frozen=hold.billingSnapshot as unknown as GatewayBillingSnapshot;
      const pricing=validateGatewayLocalPricing(frozen.localPricing);
      const evidence=validateGatewayLocalChargeEvidence(input.metadata.localChargeEvidence);
      if (pricing.model!==hold.model || pricing.endpoint!==hold.endpoint || evidence.outcomeHash!==gatewayBillingSettlementOutcome(tx) ||
        localGatewayCharge(pricing,evidence)!==input.baseCostCents || applyGatewayBillingCost(input.baseCostCents,frozen)!==input.chargedCostCents ||
        input.metadata.usdCost !== undefined || input.metadata.usdCostLexical !== undefined) fail("POOL_SOURCE_USAGE_UNPROVEN");
      return;
    }
    if (input.metadata.costSource !== "upstream_usd" || typeof input.metadata.usdCost !== "string" || input.metadata.usdCost !== input.metadata.usdCostLexical ||
      !["usage.actual_cost", "actual_cost"].includes(String(input.metadata.upstreamCostField)) || !/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(input.metadata.usdCost) || !snapshot.fxSnapshot) fail("POOL_SOURCE_USAGE_UNPROVEN");
    const actual = quoteGatewayCharge({ actualUsd: input.metadata.usdCost, fxRate: String(snapshot.fxSnapshot.rate), multiplierBps: snapshot.multiplierBps });
    if (actual.baseCents !== input.baseCostCents || actual.chargedCents !== input.chargedCostCents) fail("POOL_SOURCE_USAGE_UNPROVEN");
    return;
  }
  if (!hold || hold.userId !== snapshot.userId || hold.provider !== "shaozhuang" || !hold.credentialId) fail("POOL_SOURCE_USAGE_UNPROVEN");
  await assertGatewayPoolCredential(tx, snapshot.userId, hold.credentialId);
  if (input.metadata.credentialId !== hold.credentialId || !stored.providerBaseUrl || input.metadata.baseUrl !== stored.providerBaseUrl) fail("POOL_SOURCE_USAGE_UNPROVEN");
  if (proof.pricing?.costCoverage === "catalog_lower_bound_proven") return;
  if (proof.pricing?.costCoverage !== "actual_usd_required" || input.metadata.costSource !== "upstream_usd" ||
    typeof input.metadata.usdCost !== "string" || !snapshot.fxSnapshot) fail("POOL_SOURCE_USAGE_UNPROVEN");
  const actual = quoteGatewayCharge({ actualUsd: input.metadata.usdCost, fxRate: String(snapshot.fxSnapshot.rate), multiplierBps: snapshot.multiplierBps });
  if (actual.baseCents !== input.baseCostCents || actual.chargedCents !== input.chargedCostCents) fail("POOL_SOURCE_USAGE_UNPROVEN");
}

/** Validate the actual per-user key, not just the relay's unused platform credential. */
export async function assertGatewayPoolCredential(tx: Prisma.TransactionClient, userId: string, credentialId: string) {
  const pool = await lockGatewayAccountingPool(tx);
  if (!pool || pool.accountingVersion === 0) return;
  const snapshot = await tx.gatewayCreditSourceSnapshot.findUniqueOrThrow({ where: { id: pool.sourceSnapshotId! } });
  const proof = snapshot.proof as unknown as SourceQuoteInput;
  if (shared(snapshot.proof)) {
    const runtime = await getUserSupplyCredential(userId, credentialId);
    return gatewaySharedHoldBinding(tx, fingerprint(runtime.apiKey), runtime.baseUrl);
  }
  const credential = await tx.gatewaySupplyCredential.findUnique({ where: { id: credentialId } });
  if (!credential || credential.userId !== userId || credential.status !== "ready" || !credential.providerKeyId || !credential.readyAt ||
    credential.providerOwnerId !== proof.expected.issuerUserId || credential.providerGroupId !== proof.expected.groupId) fail("POOL_SOURCE_USAGE_UNPROVEN");
}

export async function gatewaySharedHoldBinding(tx: Prisma.TransactionClient, credentialFingerprint: string, endpoint?: string): Promise<SharedHoldBinding> {
  const pool = await lockGatewayAccountingPool(tx);
  await assertGatewayPoolReady(tx, pool);
  if (!pool || pool.sourceScope !== SHARED_SCOPE || !pool.accountingEpochId || !HASH.test(credentialFingerprint)) fail("POOL_SHARED_CREDENTIAL_BINDING_REQUIRED");
  const { snapshot, sharedProof } = await sourceProof(tx, pool.sourceSnapshotId!);
  if (!sharedProof || ![sharedProof.binding.credentialFingerprint, ...sharedProof.binding.approvedCredentialFingerprints].includes(credentialFingerprint) ||
    endpoint && endpoint !== snapshot.providerBaseUrl) fail("POOL_SOURCE_USAGE_UNPROVEN");
  return { schema: "SANJIE_SHARED_HOLD_BINDING_V1", scope: SHARED_SCOPE, epochId: pool.accountingEpochId,
    sourceIdentityHash: snapshot.identityHash, credentialFingerprint, routingBindingHash: sharedProof.binding.routeGroupBinding.bindingEvidenceHash,
    providerBaseUrl: snapshot.providerBaseUrl!, configVersion: sharedProof.policy.configVersion };
}

function sharedLiabilities(inv: Awaited<ReturnType<typeof inventory>>, revision: number, epochId: string, consumed: bigint,
  observations: { billingEventId: string; actualUsdUnits: bigint | null; eligibleUsdUnits: bigint; ownerDebitPosting: string; userId: string }[]): SharedWalletProof["liabilities"] {
  const evidence = observations.map(row => ({ billingEventId: row.billingEventId, actualUsdUnits: row.actualUsdUnits === null ? null : String(row.actualUsdUnits), eligibleUsdUnits:String(row.eligibleUsdUnits), ownerDebitPosting:row.ownerDebitPosting, userId: row.userId })).sort((a,b) => a.billingEventId.localeCompare(b.billingEventId));
  return { capturedAt: new Date().toISOString(), evidenceHash: inv.hash, complete: true, consistent: true, poolVersion: revision,
    epochId, accountedUsd: formatFixed(observations.reduce((sum,row)=>sum+row.eligibleUsdUnits,0n),8), accountedEvidenceHash: contractHash(evidence),
    consumedCents: Number(consumed), wallets: inv.states.map(({userId,balanceCents,ledgerBalanceCents})=>({userId,balanceCents,ledgerBalanceCents})),
    holds: inv.holds, pendingReservations: [] };
}

async function submissionInventoryProof(tx: Prisma.TransactionClient, journals: Array<{kind:string;eventId:string}>) {
  const rows=await tx.$queryRaw<Array<{eventId:string;refundedCents:number}>>`SELECT "eventId","refundedCents" FROM "GatewayBillingHold" WHERE "billingMode"='prepaid_quote'`;
  const expected=new Set<string>();
  for (const row of rows) {
    await assertGatewaySubmissionCharge(tx,row.eventId);
    expected.add(submissionLedgerEvent(row.eventId));
    if (row.refundedCents) expected.add(submissionLedgerEvent(row.eventId,true));
  }
  for (const row of journals) if (["generation_charge","generation_refund"].includes(row.kind) && !expected.has(row.eventId)) fail("POOL_JOURNAL_MISMATCH");
}

async function sharedInventoryProof(tx: Prisma.TransactionClient, pool: GatewayCreditPool, inv: Awaited<ReturnType<typeof inventory>>) {
  const journals = await tx.gatewayCreditPoolLedger.findMany({ where: {poolId:"total"} });
  if (inv.states.reduce((sum,row)=>sum+BigInt(row.balanceCents),0n) !== pool.allocatedCents ||
    journals.reduce((sum,row)=>sum+row.deltaAllocatedCents,0n) !== pool.allocatedCents ||
    journals.reduce((sum,row)=>sum+row.deltaConsumedCents,0n) !== pool.consumedCents ||
    journals.reduce((sum,row)=>sum+row.capacityCents-row.capacityBeforeCents,0n) !== pool.capacityCents ||
    journals.reduce((sum,row)=>sum+row.deficitAfterCents-row.deficitBeforeCents,0n) !== pool.deficitCents) fail("POOL_JOURNAL_MISMATCH");
  await submissionInventoryProof(tx,journals);
  const observations = await tx.gatewayCreditSourceUsage.findMany({where:{sourceScope:SHARED_SCOPE,accountingEpochId:pool.accountingEpochId}});
  const debits = journals.filter(row=>row.kind==="debit"), byEvent = new Map(observations.map(row=>[row.billingEventId,row]));
  if (debits.some(row=>!byEvent.has(row.eventId) || byEvent.get(row.eventId)!.userId !== row.userId)) fail("POOL_SOURCE_USAGE_UNPROVEN");
  for (const row of observations) {
    const hold = await tx.gatewayBillingHold.findUnique({where:{eventId:row.billingEventId}}), binding = hold?.sourceBinding as unknown as SharedHoldBinding | null;
    if (!hold || !binding || !hold.dispatchedAt || !pool.accountingEpochStartedAt || hold.dispatchedAt < pool.accountingEpochStartedAt ||
      binding.epochId !== row.accountingEpochId || binding.credentialFingerprint !== row.credentialFingerprint || binding.routingBindingHash !== row.routingBindingHash ||
      binding.sourceIdentityHash !== row.identityHash || row.ownerDebitPosting !== "unproven" || row.eligibleUsdUnits !== 0n) fail("POOL_SOURCE_USAGE_UNPROVEN");
    const ledger=await tx.gatewayBillingLedger.findUnique({where:{billingEventId:row.billingEventId}});
    const prepaid=hold.billingMode === "prepaid_quote";
    const observedCharge=ledger && prepaid ? applyGatewayBillingCost(ledger.baseCostCents,hold.billingSnapshot as unknown as GatewayBillingSnapshot) : ledger?.chargedCostCents;
    if (!ledger || ledger.userId !== row.userId || ledger.provider !== hold.provider || ledger.endpoint !== hold.endpoint || ledger.model !== hold.model ||
      !(prepaid ? ledger.kind === "usage" && ledger.deltaCents === 0 && ledger.chargedCostCents === 0 && ledger.usageId === hold.usageId && ledger.baseCostCents > 0 : ledger.kind === "debit" && debits.find(debit=>debit.eventId===row.billingEventId)?.deltaConsumedCents === BigInt(ledger.chargedCostCents))) fail("POOL_SOURCE_USAGE_UNPROVEN");
    if (binding.bindingPurpose==="native_funding") {
      if (!ledger || row.billingProvenance!=="local_catalog" || row.actualUsdUnits!==null || row.localPricingHash!==binding.nativeDispatch?.tariffHash ||
        row.outcomeHash!==hold.outcomeFingerprint) fail("POOL_SOURCE_USAGE_UNPROVEN");
      const {job,e}=await assertNativeCoverage(tx,hold,binding,{baseCostCents:ledger.baseCostCents,chargedCostCents:observedCharge!,metadata:ledger.metadata as Prisma.InputJsonObject},hold.outcomeFingerprint);
      if (ledger.endpoint!==hold.endpoint || ledger.model!==hold.model || ledger.requestId!==job.providerTaskId || ledger.completionTokens!==e.completionTokens ||
        ledger.totalTokens!==e.completionTokens) fail("POOL_SOURCE_USAGE_UNPROVEN");
      continue;
    }
    if (row.billingProvenance === "local_catalog") {
      const pricing=validateGatewayLocalPricing((hold.billingSnapshot as unknown as GatewayBillingSnapshot).localPricing);
      if (row.actualUsdUnits !== null || row.localPricingHash !== pricing.hash || row.outcomeHash !== hold.outcomeFingerprint ||
        pricing.model !== hold.model || pricing.endpoint !== hold.endpoint) fail("POOL_SOURCE_USAGE_UNPROVEN");
      const evidence=validateGatewayLocalChargeEvidence((ledger?.metadata as Prisma.InputJsonObject)?.localChargeEvidence);
      if (evidence.outcomeHash !== row.outcomeHash ||
        evidence.pricingHash !== row.localPricingHash || localGatewayCharge(pricing,evidence) !== ledger.baseCostCents ||
        applyGatewayBillingCost(ledger.baseCostCents,hold.billingSnapshot as unknown as GatewayBillingSnapshot) !== observedCharge) fail("POOL_SOURCE_USAGE_UNPROVEN");
    } else {
      const metadata=ledger.metadata as Prisma.InputJsonObject, frozen=hold.billingSnapshot as unknown as GatewayBillingSnapshot;
      if (row.billingProvenance !== "upstream_actual_usd" || row.actualUsdUnits === null || metadata.costSource !== "upstream_usd" ||
        typeof metadata.usdCost !== "string" || metadata.usdCost !== metadata.usdCostLexical || !frozen.fxSnapshot ||
        !["usage.actual_cost","actual_cost"].includes(String(metadata.upstreamCostField)) || usdUnits(metadata.usdCost) !== row.actualUsdUnits) fail("POOL_SOURCE_USAGE_UNPROVEN");
      const actual=quoteGatewayCharge({actualUsd:metadata.usdCost,fxRate:String(frozen.fxSnapshot.rate),multiplierBps:frozen.multiplierBps});
      if (actual.baseCents !== ledger.baseCostCents || actual.chargedCents !== observedCharge) fail("POOL_SOURCE_USAGE_UNPROVEN");
    }
  }
  return observations;
}

async function collectSharedSnapshot(tx: Prisma.TransactionClient, pool: GatewayCreditPool | null, observation?: SharedWalletSourceObservation, reused = false) {
  const trusted = observation ?? await readGatewaySharedWalletSource();
  if (trusted.policy.configVersion !== await getGatewaySharedSourceConfigVersion()) fail("POOL_RUNTIME_CONFIG_CHANGED");
  const inv = await inventory(tx);
  let epoch = trusted.epoch;
  if (pool?.accountingVersion === 1) {
    if (pool.sourceScope !== SHARED_SCOPE || !pool.accountingEpochId || !pool.accountingEpochStartedAt || !pool.frozenValuationProduct) fail("POOL_REFRESH_SCOPE_CHANGED");
    const previous = await tx.gatewayCreditSourceSnapshot.findUniqueOrThrow({where:{id:pool.sourceSnapshotId!}});
    if (!shared(previous.proof) || previous.identityHash !== trusted.binding.authorityHash || previous.proof.policy.configVersion !== trusted.policy.configVersion ||
      previous.proof.binding.authorityHash !== trusted.binding.authorityHash) fail("POOL_REFRESH_SCOPE_CHANGED");
    const fixed = {id:pool.accountingEpochId,startedAt:pool.accountingEpochStartedAt.toISOString(),assetExpiresAt:null};
    if (epoch && contractHash(epoch)!==contractHash(fixed)) fail("POOL_REFRESH_SCOPE_CHANGED");
    epoch = fixed;
  } else if (!epoch) {
    const previous = await tx.gatewayCreditSourceSnapshot.findFirst({where:{sourceScope:SHARED_SCOPE,identityHash:trusted.binding.authorityHash},orderBy:{observedAt:"desc"}});
    epoch = previous && shared(previous.proof) ? previous.proof.epoch : {id:randomUUID(),startedAt:trusted.source.capturedAt,assetExpiresAt:null};
  }
  const runtime = await getRelayRuntime(), fx = requireGatewayFxSnapshot(runtime);
  if (!fx) fail("POOL_FX_CHANGED");
  const observations = pool?.accountingVersion===1 ? await sharedInventoryProof(tx,pool,inv) : [];
  let proof: SharedWalletProof = { ...trusted, epoch, now:new Date().toISOString(),
    policy:{...trusted.policy,frozenValuationProduct:pool?.accountingVersion===1 ? String(pool.frozenValuationProduct) : trusted.policy.frozenValuationProduct},
    pricing:{fx:{rate:String(fx.rate),source:fx.source,quoteId:fx.id,fetchedAt:fx.fetchedAt,referenceDate:fx.referenceDate},rules:await effectiveRules(tx),
      rulesComplete:true,fallbackMultiplierBps:GATEWAY_DEFAULT_MULTIPLIER_BPS,costCoverage:"local_catalog_or_actual_usd",envelopeEvidenceHash:contractHash({scope:SHARED_SCOPE,cost:"frozen_local_catalog_or_exact_usage_actual_cost",ownerDebitPosting:"unproven",eligibleUsd:"0"})},
    liabilities:sharedLiabilities(inv,pool?.revision??0,epoch.id,pool?.consumedCents??0n,observations) };
  proof = {...proof,now:new Date().toISOString()};
  let evaluated = evaluateSharedWalletSource(proof);
  const quote = evaluated.ready ? evaluated.quote : evaluated.observation;
  if (!quote || (!evaluated.ready && evaluated.blockedReasons.some(reason=>reason.code!=="BACKING_SHORTFALL"))) fail(evaluated.blockedReasons[0]?.code??"POOL_SOURCE_UNVERIFIED");
  if (proof.policy.frozenValuationProduct===null) {
    proof = {...proof,policy:{...proof.policy,frozenValuationProduct:quote.pricing.valuationProduct}};
    evaluated = evaluateSharedWalletSource(proof);
  }
  const final = evaluated.ready ? evaluated.quote : evaluated.observation;
  if (!final) fail("POOL_SOURCE_UNVERIFIED");
  if (reused && pool && BigInt(final.points.totalCents) > pool.capacityCents) fail("POOL_SOURCE_CAPACITY_CHANGED");
  const snapshot = await tx.gatewayCreditSourceSnapshot.create({data:{status:"verified",snapshotHash:contractHash(proof),identityHash:trusted.binding.authorityHash,
    sourceScope:SHARED_SCOPE,accountingEpochId:epoch.id,nativeUnit:"USD",providerBaseUrl:`${trusted.binding.origin}/v1`,capacityCents:final.points.totalCents,
    conversionPolicyHash:contractHash({scope:proof.scope,binding:proof.binding,epoch:proof.epoch,policy:proof.policy}),proof:proof as unknown as Prisma.InputJsonValue,
    observedAt:new Date(proof.source.capturedAt),expiresAt:new Date(final.sourceExpiresAt)}});
  return {snapshot,proof,inv,quote:final,ready:evaluated.ready};
}

async function sharedObservationMovement(tx: Prisma.TransactionClient,pool:GatewayCreditPool,facts:Awaited<ReturnType<typeof collectSharedSnapshot>>) {
  const points = facts.quote.points;
  await tx.gatewayCreditPool.update({where:{id:"total"},data:{status:facts.ready?"ready":"blocked",sourceSnapshotId:facts.snapshot.id,
    capacityCents:BigInt(points.totalCents),balanceCents:points.availableCents,deficitCents:BigInt(points.deficitCents),revision:{increment:1}}});
  await tx.gatewayCreditPoolLedger.create({data:{eventId:`source-observation:${facts.snapshot.id}`,kind:"source_observation",poolId:"total",sourceSnapshotId:facts.snapshot.id,
    deltaAllocatedCents:0n,deltaConsumedCents:0n,capacityBeforeCents:pool.capacityCents,capacityCents:BigInt(points.totalCents),
    allocatedBeforeCents:pool.allocatedCents,allocatedAfterCents:pool.allocatedCents,consumedBeforeCents:pool.consumedCents,consumedAfterCents:pool.consumedCents,
    allocatableBeforeCents:pool.balanceCents,allocatableAfterCents:points.availableCents,deficitBeforeCents:pool.deficitCents,deficitAfterCents:BigInt(points.deficitCents)}});
}

/** Captures trusted source and inventory; external inputs never contain budget or proof. */
export async function persistGatewaySharedSourceSnapshot(adminId:string, requestKey?:string) {
  if (requestKey !== undefined && !UUID.test(requestKey)) fail("POOL_INPUT_INVALID");
  requestKey = requestKey?.toLowerCase();
  const prepared = await prisma.$transaction(async tx=>{
    await activeAdmin(tx,adminId);
    const pool = await lockGatewayAccountingPool(tx);
    return {sourceSnapshotId:pool?.sourceSnapshotId??null,startedAt:Date.now(),receipt:await getGatewayVerificationReceipt(tx,adminId,requestKey)};
  },{timeout:20_000});
  if (prepared.receipt) return prepared.receipt;
  const trusted = await readGatewaySharedWalletSource();
  return prisma.$transaction(async tx=>{
    await activeAdmin(tx,adminId);
    const pool=await lockGatewayAccountingPool(tx);
    const receipt = await getGatewayVerificationReceipt(tx,adminId,requestKey);
    if (receipt) return receipt;
    const current = pool?.accountingVersion===1 && pool.sourceScope===SHARED_SCOPE
      ? await preferredSharedObservation(tx,pool,prepared.sourceSnapshotId,trusted,prepared.startedAt) : null;
    const facts=await collectSharedSnapshot(tx,pool,current??trusted,!!current);
    if(pool?.accountingVersion===1) {
      await sharedObservationMovement(tx,pool,facts);
      if (facts.ready) {
        const window = await openGatewayAllocationWindow(tx, await tx.gatewayCreditPool.findUniqueOrThrow({ where: { id: "total" } }));
        if (window) await recordGatewayVerification(tx,adminId,requestKey,window.id);
      }
    }
    return {snapshotId:facts.snapshot.id,snapshotHash:facts.snapshot.snapshotHash,ready:facts.ready,
      capacityCents:facts.quote.points.totalCents,deficitCents:facts.quote.points.deficitCents,allocatableCents:facts.quote.points.availableCents};
  },{timeout:20_000});
}

// Reuse only across the immediate reservation/binding/dispatch checks. This is
// much shorter than the approved source TTL and never renews capturedAt/expiry.
const SHARED_SOURCE_REUSE_MS = 2_000;
let sharedPoolRefreshInFlight: Promise<void> | null = null;
function sharedSourceObservation(proof: SharedWalletProof): SharedWalletSourceObservation {
  return { schema: proof.schema, scope: proof.scope, binding: proof.binding, epoch: proof.epoch,
    policy: proof.policy, source: proof.source, externalCommitments: proof.externalCommitments };
}
/** CAS against the immutable current observation after a lock-free GET. All
 * accounting liabilities are subsequently rebased under the current fence. */
async function preferredSharedObservation(tx: Prisma.TransactionClient, pool: GatewayCreditPool, previousSnapshotId: string | null,
  incoming: SharedWalletSourceObservation | null, startedAt: number) {
  if (!pool.sourceSnapshotId || pool.sourceSnapshotId === previousSnapshotId) return null;
  const current = await tx.gatewayCreditSourceSnapshot.findUnique({where:{id:pool.sourceSnapshotId}});
  if (!current || current.observedAt.getTime() < (incoming ? Date.parse(incoming.source.capturedAt) : startedAt)) return null;
  const {sharedProof} = await sourceProof(tx,current.id,current.snapshotHash);
  // Millisecond timestamps can tie across workers. Without provable ordering,
  // retain the lower posted asset instead of promoting a larger B.
  return sharedProof && (!incoming || current.observedAt.getTime() > Date.parse(incoming.source.capturedAt) ||
    usdUnits(sharedProof.source.balanceUsd) <= usdUnits(incoming.source.balanceUsd)) ? sharedSourceObservation(sharedProof) : null;
}
async function markSharedSourceUnavailable(tx: Prisma.TransactionClient, pool: GatewayCreditPool, error: GatewayBillingError | SharedWalletSourceError) {
  // Journal only the bounded internal code. Exception text/URLs/credentials or
  // upstream bodies never enter durable diagnostics or a tenant response.
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "POOL_SOURCE_UNVERIFIED";
  await tx.gatewayCreditPool.update({where:{id:"total"},data:{status:"blocked",revision:{increment:1}}});
  await tx.gatewayCreditPoolLedger.create({data:{eventId:`source-unavailable:${code}:${randomUUID()}`,kind:"source_unavailable",poolId:"total",sourceSnapshotId:pool.sourceSnapshotId,
    deltaAllocatedCents:0n,deltaConsumedCents:0n,capacityBeforeCents:pool.capacityCents,capacityCents:pool.capacityCents,
    allocatedBeforeCents:pool.allocatedCents,allocatedAfterCents:pool.allocatedCents,consumedBeforeCents:pool.consumedCents,consumedAfterCents:pool.consumedCents,
    allocatableBeforeCents:pool.balanceCents,allocatableAfterCents:pool.balanceCents,deficitBeforeCents:pool.deficitCents,deficitAfterCents:pool.deficitCents}});
}
async function reusableSharedSource(tx: Prisma.TransactionClient, pool: GatewayCreditPool) {
  if (pool.status !== "ready" || pool.deficitCents !== 0n || !pool.sourceSnapshotId) return null;
  const previous = await tx.gatewayCreditSourceSnapshot.findUnique({where:{id:pool.sourceSnapshotId}});
  const age = previous ? Date.now() - previous.observedAt.getTime() : Infinity;
  if (!previous || !shared(previous.proof) || age < 0 || age >= Math.min(SHARED_SOURCE_REUSE_MS, previous.proof.policy.maxSourceAgeMs)) return null;
  try {
    const { sharedProof } = await sourceProof(tx, previous.id, previous.snapshotHash);
    return sharedProof ? sharedSourceObservation(sharedProof) : null;
  } catch (error) {
    // Config/FX/rule drift requires a new observation and full validation; an
    // expired or unverified assertion is never a fallback for a failed GET.
    if (!(error instanceof GatewayBillingError) && !(error instanceof SharedWalletSourceError)) throw error;
    return null;
  }
}
async function commitSharedObservation(tx: Prisma.TransactionClient, pool: GatewayCreditPool, trusted: SharedWalletSourceObservation, reused = false) {
  try {
    // Recompute W/H/C, durable debit evidence, epoch, valuation and current
    // pricing under the accounting fence even when only the source B is reused.
    await sharedObservationMovement(tx, pool, await collectSharedSnapshot(tx, pool, trusted, reused));
  } catch (error) {
    if (!(error instanceof GatewayBillingError) && !(error instanceof SharedWalletSourceError)) throw error;
    await markSharedSourceUnavailable(tx, pool, error);
  }
}
async function runSharedPoolRefresh() {
  // First validate an immediate prior observation under the fence. No network
  // operation is performed in either accounting transaction.
  const prepared = await prisma.$transaction(async tx=>{
    await lockGatewayAccountingIdentities(tx,[]);
    const pool=await lockGatewayAccountingPool(tx);
    if(!pool || pool.accountingVersion!==1 || pool.sourceScope!==SHARED_SCOPE) return null;
    const trusted = await reusableSharedSource(tx, pool);
    if (trusted) {
      await commitSharedObservation(tx, pool, trusted, true);
      return null;
    }
    return {sourceSnapshotId:pool.sourceSnapshotId,startedAt:Date.now()};
  },{timeout:20_000});
  if (!prepared) return;
  let trusted: SharedWalletSourceObservation | null = null;
  let sourceError: GatewayBillingError | SharedWalletSourceError | null = null;
  try { trusted = await readGatewaySharedWalletSource(); }
  catch (error) {
    if (!(error instanceof GatewayBillingError) && !(error instanceof SharedWalletSourceError)) throw error;
    sourceError = error;
  }
  await prisma.$transaction(async tx=>{
    await lockGatewayAccountingIdentities(tx,[]);
    const pool = await lockGatewayAccountingPool(tx);
    if (!pool || pool.accountingVersion!==1 || pool.sourceScope!==SHARED_SCOPE) return;
    try {
      // A different worker may have committed newer B while our GET waited.
      // Its deficit also wins over an older success or failure.
      const current = await preferredSharedObservation(tx,pool,prepared.sourceSnapshotId,trusted,prepared.startedAt);
      if (current) {await commitSharedObservation(tx,pool,current,true);return;}
    } catch (error) {
      if (!(error instanceof GatewayBillingError) && !(error instanceof SharedWalletSourceError)) throw error;
      await markSharedSourceUnavailable(tx,pool,error); return;
    }
    if (sourceError) { await markSharedSourceUnavailable(tx,pool,sourceError); return; }
    await commitSharedObservation(tx,pool,trusted!);
  },{timeout:20_000});
}

/** Separate committed observation fence: rejected financial actions cannot roll
 * back D. Concurrent checks share one refresh; later callers still validate the
 * current accounting inventory. Legacy/independent pools make no source GET. */
export async function refreshGatewaySharedPoolFromSource() {
  if (sharedPoolRefreshInFlight) return sharedPoolRefreshInFlight;
  const operation = runSharedPoolRefresh(); sharedPoolRefreshInFlight = operation;
  try { await operation; }
  finally { if (sharedPoolRefreshInFlight === operation) sharedPoolRefreshInFlight = null; }
}

/** Allocation A->W or consumption W->C. Hold/release does not enter this journal. */
export async function moveGatewayPool(tx: Prisma.TransactionClient, input: {
  eventId: string; kind: "gift" | "recharge" | "debit" | "generation_charge" | "generation_refund"; userId: string; actorId?: string | null; amountCents: number;
}) {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > GATEWAY_MAX_COST_CENTS) fail("POOL_AMOUNT_INVALID");
  const pool = await lockGatewayAccountingPool(tx);
  if (!pool || pool.accountingVersion === 0) {
    if (input.kind === "gift") fail("CREDIT_POOL_NOT_READY");
    return { tracked: false, allocatableBeforeCents: null, allocatableAfterCents: null };
  }
  if (await tx.gatewayCreditPoolLedger.findUnique({ where: { eventId: input.eventId } })) fail("POOL_EVENT_CONFLICT");
  const allocating = input.kind === "gift" || input.kind === "recharge";
  const refund = input.kind === "generation_refund";
  if (allocating) {
    await assertGatewayPoolReady(tx, pool);
    await assertGatewayAllocationBudget(tx, pool, input.amountCents);
  }
  if (input.kind === "gift" && pool.status !== "ready") fail("CREDIT_POOL_NOT_READY");
  const amount = BigInt(input.amountCents);
  if (allocating && pool.status === "ready" && pool.balanceCents < input.amountCents) fail("INSUFFICIENT_POOL_BALANCE");
  const allocated = pool.allocatedCents + (allocating || refund ? amount : -amount);
  const consumed = pool.consumedCents + (allocating ? 0n : refund ? -amount : amount);
  if (allocated < 0n || consumed < 0n) fail("CREDIT_POOL_INVALID");
  const remainder = pool.capacityCents - allocated - consumed;
  const deficit = remainder < 0n ? -remainder : 0n;
  const balance = Number(remainder < 0n ? 0n : remainder);
  if (balance > GATEWAY_MAX_COST_CENTS) fail("CREDIT_POOL_INVALID");
  await tx.gatewayCreditPool.update({ where: { id: "total" }, data: { allocatedCents: allocated, consumedCents: consumed,
    balanceCents: balance, deficitCents: deficit, revision: { increment: 1 } } });
  await tx.gatewayCreditPoolLedger.create({ data: { eventId: input.eventId, kind: input.kind, poolId: "total", actorId: input.actorId,
    userId: input.userId, sourceSnapshotId: pool.sourceSnapshotId, deltaAllocatedCents: allocating || refund ? amount : -amount,
    deltaConsumedCents: allocating ? 0n : refund ? -amount : amount, capacityCents: pool.capacityCents, allocatedBeforeCents: pool.allocatedCents,
    capacityBeforeCents: pool.capacityCents,
    allocatedAfterCents: allocated, consumedBeforeCents: pool.consumedCents, consumedAfterCents: consumed,
    allocatableBeforeCents: pool.balanceCents, allocatableAfterCents: balance, deficitBeforeCents: pool.deficitCents, deficitAfterCents: deficit } });
  if (allocating) await recordGatewayAllocation(tx, pool, { ...input, kind: input.kind as "gift" | "recharge" });
  return { tracked: true, allocatableBeforeCents: pool.balanceCents, allocatableAfterCents: balance };
}

/** Cascading deletion must not erase adopted liability, pending receipts or unknown supply outcomes. */
export async function assertGatewayAccountingDeletionSafe(tx: Prisma.TransactionClient, userId: string) {
  await lockGatewayAccountingIdentities(tx, [userId]);
  const pool = await lockGatewayAccountingPool(tx);
  const held = await tx.gatewayBillingHold.count({ where: { userId, status: { in: ["reserved", "dispatched", "unknown"] } } });
  const waiting = await tx.gatewayOrder.count({ where: { userId, creditAllocationState: "awaiting_capacity" } });
  const wallet = await tx.gatewayWallet.findUnique({ where: { userId } });
  const paid = await tx.gatewayOrder.findMany({ where: { userId, status: "paid" }, select: { id: true } });
  const proofs = await tx.gatewayCreditFundingEvidence.count({ where: { orderId: { in: paid.map(row => row.id) } } });
  if (proofs !== paid.length) fail("ACCOUNTING_DELETION_BLOCKED");
  if (held || waiting || (pool?.accountingVersion === 1 && wallet && wallet.balanceCents !== 0)) fail("ACCOUNTING_DELETION_BLOCKED");
}

export async function recordGatewaySourceUsage(tx: Prisma.TransactionClient, billingEventId: string, userId: string, metadata: Prisma.InputJsonObject) {
  const pool = await lockGatewayAccountingPool(tx);
  if (!pool || pool.accountingVersion === 0) return;
  if (pool.sourceScope !== SHARED_SCOPE && (metadata.costSource !== "upstream_usd" || typeof metadata.usdCost !== "string")) return;
  const ledger = await tx.gatewayBillingLedger.findUnique({ where: { billingEventId } });
  if (ledger?.chargedCostCents === 0 && ledger.kind !== "usage") return; // Legacy zero debit creates no observation.
  const movement = await tx.gatewayCreditPoolLedger.findUnique({ where: { eventId: billingEventId } });
  const hold = await tx.gatewayBillingHold.findUnique({ where: { eventId: billingEventId } });
  if (!ledger || !hold || ledger.userId !== userId || hold.userId !== userId || ledger.provider !== hold.provider || contractHash(ledger.metadata) !== contractHash(metadata)) fail("POOL_SOURCE_USAGE_UNPROVEN");
  const prepaid = ledger.kind === "usage" && hold.billingMode === "prepaid_quote";
  if (prepaid) {
    await assertGatewaySubmissionCharge(tx, billingEventId);
    if (ledger.deltaCents !== 0 || ledger.chargedCostCents !== 0 || ledger.baseCostCents <= 0 || !ledger.usageId) fail("POOL_SOURCE_USAGE_UNPROVEN");
  } else if (ledger.kind !== "debit" || !movement || movement.kind !== "debit" || movement.userId !== userId) fail("POOL_SOURCE_USAGE_UNPROVEN");
  const observedCharge = prepaid ? applyGatewayBillingCost(ledger.baseCostCents,hold.billingSnapshot as unknown as GatewayBillingSnapshot) : ledger.chargedCostCents;
  if (pool.sourceScope !== SHARED_SCOPE) {
    if (!hold.credentialId) fail("POOL_SOURCE_USAGE_UNPROVEN");
    await assertGatewayPoolCredential(tx, userId, hold.credentialId);
  }
  await assertGatewayPoolUsageEvidence(tx, hold.billingSnapshot as unknown as GatewayBillingSnapshot, { eventId: billingEventId,
    baseCostCents: ledger.baseCostCents, chargedCostCents: observedCharge, metadata });
  const snapshot = await tx.gatewayCreditSourceSnapshot.findUniqueOrThrow({ where: { id: pool.sourceSnapshotId! } });
  const proof = snapshot.proof as unknown as SourceQuoteInput;
  if (shared(snapshot.proof)) {
    const binding = hold.sourceBinding as unknown as SharedHoldBinding;
    await tx.gatewayCreditSourceUsage.create({ data: { billingEventId, userId, sourceSnapshotId: snapshot.id,
      sourceScope: SHARED_SCOPE, identityHash: snapshot.identityHash, groupId: snapshot.proof.binding.routeGroupBinding.groupId,
      cycleId: null, accountingEpochId: pool.accountingEpochId, credentialFingerprint: binding.credentialFingerprint,
      routingBindingHash: binding.routingBindingHash, ownerDebitPosting:"unproven", eligibleUsdUnits:0n,
      billingProvenance:metadata.costSource === "catalog" ? "local_catalog" : "upstream_actual_usd",
      localPricingHash:metadata.costSource === "catalog" ? binding.bindingPurpose==="native_funding" ? binding.nativeDispatch!.tariffHash : validateGatewayLocalChargeEvidence(metadata.localChargeEvidence).pricingHash : null,
      outcomeHash:metadata.costSource === "catalog" ? binding.bindingPurpose==="native_funding" ? validateNativeChargeEvidence(metadata.nativeChargeEvidence).outcomeHash : validateGatewayLocalChargeEvidence(metadata.localChargeEvidence).outcomeHash : null,
      actualUsdUnits: metadata.costSource === "catalog" ? null : parseFixed(String(metadata.usdCost), 8) } });
    return;
  }
  await tx.gatewayCreditSourceUsage.create({ data: { billingEventId, userId, sourceSnapshotId: snapshot.id,
    identityHash: snapshot.identityHash, groupId: proof.expected.groupId, cycleId: proof.expected.cycleId, actualUsdUnits: parseFixed(String(metadata.usdCost), 8) } });
}

async function refreshFacts(tx: Prisma.TransactionClient, pool: GatewayCreditPool, snapshotId: string, snapshotHash: string) {
  const { snapshot, proof, sharedProof } = await sourceProof(tx, snapshotId, snapshotHash);
  const previous = await tx.gatewayCreditSourceSnapshot.findUniqueOrThrow({ where: { id: pool.sourceSnapshotId! } });
  if (sharedProof) {
    if (pool.sourceScope !== SHARED_SCOPE || pool.accountingEpochId !== sharedProof.epoch.id ||
      previous.identityHash !== snapshot.identityHash || pool.accountingEpochStartedAt?.toISOString() !== sharedProof.epoch.startedAt ||
      String(pool.frozenValuationProduct) !== sharedProof.policy.frozenValuationProduct) fail("POOL_REFRESH_SCOPE_CHANGED");
    const inv = await inventory(tx), observations = await sharedInventoryProof(tx, pool, inv);
    // A persisted source observation may only use the exact USD inventory captured with B.
    // Later settlement requires another GET; it cannot add L to an older, pre-debit B.
    const liabilities = sharedLiabilities(inv, pool.revision, sharedProof.epoch.id, pool.consumedCents, observations);
    if (liabilities.accountedEvidenceHash !== sharedProof.liabilities.accountedEvidenceHash ||
      usdUnits(liabilities.accountedUsd) !== usdUnits(sharedProof.liabilities.accountedUsd)) fail("POOL_ACCOUNTED_USD_MISMATCH");
    const evaluated = evaluateSharedWalletSource({...sharedProof,now:new Date().toISOString(),liabilities});
    if (!evaluated.ready) fail(evaluated.blockedReasons[0]?.code ?? "POOL_SOURCE_UNVERIFIED");
    if (snapshot.capacityCents !== evaluated.quote.points.totalCents) fail("POOL_SOURCE_CAPACITY_CHANGED");
    return {snapshot, inv, quote:evaluated.quote};
  }
  const old = previous.proof as unknown as SourceQuoteInput;
  if (snapshot.identityHash !== previous.identityHash || proof.expected.groupId !== old.expected.groupId ||
    proof.expected.issuerUserId !== old.expected.issuerUserId || proof.expected.cycleId !== old.expected.cycleId ||
    proof.expected.cycleStartedAt !== old.expected.cycleStartedAt || proof.expected.cycleEndsAt !== old.expected.cycleEndsAt ||
    proof.expected.configVersion !== old.expected.configVersion || proof.expected.capacityPolicy !== old.expected.capacityPolicy ||
    proof.expected.capacityPolicyEvidenceHash !== old.expected.capacityPolicyEvidenceHash || proof.expected.poolVersion !== pool.revision) fail("POOL_REFRESH_SCOPE_CHANGED");
  const inv = await inventory(tx);
  const sumW = inv.states.reduce((total, row) => total + BigInt(row.balanceCents), 0n);
  const journals = await tx.gatewayCreditPoolLedger.findMany({ where: { poolId: "total" } });
  if (sumW !== pool.allocatedCents || journals.reduce((sum, row) => sum + row.deltaAllocatedCents, 0n) !== pool.allocatedCents ||
    journals.reduce((sum, row) => sum + row.deltaConsumedCents, 0n) !== pool.consumedCents ||
    journals.reduce((sum, row) => sum + row.capacityCents - row.capacityBeforeCents, 0n) !== pool.capacityCents) fail("POOL_JOURNAL_MISMATCH");
  const debits = journals.filter(row => row.kind === "debit");
  const observations = await tx.gatewayCreditSourceUsage.findMany({ where: { identityHash: previous.identityHash, groupId: old.expected.groupId, cycleId: old.expected.cycleId } });
  const byEvent = new Map(observations.map(row => [row.billingEventId, row]));
  await submissionInventoryProof(tx,journals);
  if (debits.some(row => !byEvent.has(row.eventId) || byEvent.get(row.eventId)!.userId !== row.userId)) fail("POOL_SOURCE_USAGE_UNPROVEN");
  for (const row of observations) {
    if (debits.some(debit=>debit.eventId===row.billingEventId)) continue;
    const h=await assertGatewaySubmissionCharge(tx,row.billingEventId);
    const ledger=await tx.gatewayBillingLedger.findUnique({where:{billingEventId:row.billingEventId}});
    if (!ledger || ledger.kind !== "usage" || ledger.userId !== row.userId || ledger.deltaCents !== 0 || ledger.chargedCostCents !== 0 || !ledger.usageId) fail("POOL_SOURCE_USAGE_UNPROVEN");
    const meta=ledger.metadata as Prisma.InputJsonObject;
    if (meta.costSource !== "upstream_usd" || typeof meta.usdCost !== "string" || usdUnits(meta.usdCost) !== row.actualUsdUnits || !h.billingSnapshot.fxSnapshot) fail("POOL_SOURCE_USAGE_UNPROVEN");
    const actual=quoteGatewayCharge({actualUsd:meta.usdCost,fxRate:String(h.billingSnapshot.fxSnapshot.rate),multiplierBps:h.billingSnapshot.multiplierBps});
    if (actual.baseCents !== ledger.baseCostCents) fail("POOL_SOURCE_USAGE_UNPROVEN");
  }
  // Independent legacy source proofs may add back prior actual debits only.
  // Fixed business purchases and refunded supplier observations never restore funding capacity.
  const capacityObservations = observations.filter(row=>debits.some(debit=>debit.eventId===row.billingEventId));
  const actualUsd = formatFixed(capacityObservations.reduce((sum, row) => sum + row.actualUsdUnits!, 0n), 8);
  if (usdUnits(proof.source.issuer.cycleAccountedUsd) !== usdUnits(actualUsd) || usdUnits(proof.liabilities.cycleAccountedUsd) !== usdUnits(actualUsd) ||
    proof.source.issuer.accountedEvidenceHash !== contractHash(capacityObservations.map(row => ({ billingEventId: row.billingEventId, actualUsdUnits: String(row.actualUsdUnits), userId: row.userId })).sort((a,b) => a.billingEventId.localeCompare(b.billingEventId)))) fail("POOL_ACCOUNTED_USD_MISMATCH");
  const now = new Date().toISOString();
  const evaluated = evaluateGatewayPoolSource({ ...proof, now, liabilities: { ...proof.liabilities, capturedAt: now,
    evidenceHash: inv.hash, complete: true, consistent: true, poolVersion: pool.revision, consumedCents: Number(pool.consumedCents),
    wallets: inv.states.map(({ userId, balanceCents, ledgerBalanceCents }) => ({ userId, balanceCents, ledgerBalanceCents })), holds: inv.holds, pendingReservations: [] } });
  if (!evaluated.ready) fail(evaluated.blockedReasons[0]?.code ?? "POOL_SOURCE_UNVERIFIED");
  const oldQuote = evaluateGatewayPoolSource(old);
  // Historical C was charged with frozen prices. Revaluing spent USD upward could recreate A.
  if (!oldQuote.ready || BigInt(evaluated.quote.pricing.valuationProduct) > BigInt(oldQuote.quote.pricing.valuationProduct)) fail("POOL_REFRESH_VALUATION_CHANGED");
  if (snapshot.capacityCents !== evaluated.quote.points.totalCents) fail("POOL_SOURCE_CAPACITY_CHANGED");
  return { snapshot, inv, quote: evaluated.quote };
}

export async function prepareGatewayPoolRefresh(adminId: string, value: unknown) {
  exactInput(value, ["snapshotId", "snapshotHash"]);
  if (typeof value.snapshotId !== "string" || !ID.test(value.snapshotId) || typeof value.snapshotHash !== "string" || !HASH.test(value.snapshotHash)) fail("POOL_INPUT_INVALID");
  const input = { snapshotId: value.snapshotId, snapshotHash: value.snapshotHash };
  return prisma.$transaction(async tx => {
    await activeAdmin(tx, adminId);
    const pool = await lockGatewayAccountingPool(tx);
    if (!pool || pool.accountingVersion !== 1 || !pool.sourceSnapshotId) fail("CREDIT_POOL_NOT_READY");
    const facts = await refreshFacts(tx, pool, input.snapshotId, input.snapshotHash);
    const proposal = await tx.gatewayCreditPoolProposal.create({ data: { kind: "source_refresh", snapshotId: facts.snapshot.id,
      snapshotHash: facts.snapshot.snapshotHash, identityHash: facts.snapshot.identityHash, conversionPolicyHash: facts.snapshot.conversionPolicyHash!,
      adminId, version: pool.revision + 1, capacityCents: facts.quote.points.totalCents, walletTotalCents: pool.allocatedCents,
      consumedCents: pool.consumedCents, heldSubsetCents: BigInt(facts.quote.points.heldCents), walletStateHash: facts.inv.hash,
      expiresAt: new Date(Math.min(Date.parse(facts.quote.proposalExpiresAt), facts.snapshot.expiresAt.getTime())) } });
    return { proposalId: proposal.id, version: proposal.version, snapshotHash: proposal.snapshotHash, expiresAt: proposal.expiresAt.toISOString() };
  }, { timeout: 20_000 });
}

export async function refreshGatewayCreditPool(adminId: string, value: unknown) {
  exactInput(value, ["proposalId", "version", "snapshotHash", "requestKey"]);
  if (typeof value.proposalId !== "string" || !ID.test(value.proposalId) || !Number.isSafeInteger(value.version) || Number(value.version) < 1 ||
    typeof value.snapshotHash !== "string" || !HASH.test(value.snapshotHash) || typeof value.requestKey !== "string" || !UUID.test(value.requestKey)) fail("POOL_INPUT_INVALID");
  const input = { proposalId: value.proposalId, version: Number(value.version), snapshotHash: value.snapshotHash, requestKey: value.requestKey.toLowerCase() };
  return prisma.$transaction(async tx => {
    await activeAdmin(tx, adminId);
    const pool = await lockGatewayAccountingPool(tx);
    const replay = await tx.gatewayCreditPoolLedger.findUnique({ where: { eventId: `source-refresh:${input.requestKey}` } });
    const proposal = await tx.gatewayCreditPoolProposal.findUnique({ where: { id: input.proposalId } });
    if (!proposal || proposal.kind !== "source_refresh" || proposal.adminId !== adminId || proposal.version !== input.version || proposal.snapshotHash !== input.snapshotHash) fail("POOL_REQUEST_CONFLICT");
    if (replay) {
      if (replay.kind !== "source_refresh" || replay.proposalId !== proposal.id || replay.actorId !== adminId) fail("POOL_REQUEST_CONFLICT");
      return { refreshed: true, replayed: true };
    }
    if (!pool || pool.accountingVersion !== 1 || pool.revision + 1 !== proposal.version || proposal.expiresAt.getTime() <= Date.now()) fail("POOL_PROPOSAL_STALE");
    const facts = await refreshFacts(tx, pool, proposal.snapshotId, proposal.snapshotHash);
    if (facts.inv.hash !== proposal.walletStateHash || pool.allocatedCents !== proposal.walletTotalCents || pool.consumedCents !== proposal.consumedCents || facts.quote.points.totalCents !== proposal.capacityCents) fail("POOL_PROPOSAL_STALE");
    await tx.gatewayCreditPool.update({ where: { id: "total" }, data: { status: "ready", sourceSnapshotId: facts.snapshot.id,
      capacityCents: BigInt(proposal.capacityCents), balanceCents: facts.quote.points.availableCents, deficitCents: 0n, revision: { increment: 1 } } });
    await tx.gatewayCreditPoolLedger.create({ data: { eventId: `source-refresh:${input.requestKey}`, kind: "source_refresh", poolId: "total", actorId: adminId,
      proposalId: proposal.id, sourceSnapshotId: facts.snapshot.id, deltaAllocatedCents: 0n, deltaConsumedCents: 0n,
      capacityCents: BigInt(proposal.capacityCents), capacityBeforeCents: pool.capacityCents, allocatedBeforeCents: pool.allocatedCents, allocatedAfterCents: pool.allocatedCents,
      consumedBeforeCents: pool.consumedCents, consumedAfterCents: pool.consumedCents, allocatableBeforeCents: pool.balanceCents,
      allocatableAfterCents: facts.quote.points.availableCents, deficitBeforeCents: pool.deficitCents, deficitAfterCents: 0n } });
    await openGatewayAllocationWindow(tx, await tx.gatewayCreditPool.findUniqueOrThrow({ where: { id: "total" } }));
    return { refreshed: true, replayed: false };
  }, { timeout: 20_000 });
}

// Source observations come only from trusted server connectors, never client budgets/proof flags.
export const gatewayAccountingRequestKey = () => randomUUID();
