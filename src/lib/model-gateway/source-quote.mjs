import { createHash } from 'node:crypto';

// Pure proposal arithmetic. No network, database, environment or current clock reads.
export const USD_SCALE = 100_000_000n;
export const FX_SCALE = 1_000_000n;
export const BPS_SCALE = 10_000n;
export const MAX_CENTS = 2_147_483_647n;

export class SourceQuoteError extends Error {
  constructor(code, message) { super(message); this.name = 'SourceQuoteError'; this.code = code; }
}

/** Full-match decimal parsing; scientific notation is expanded exactly, never regex-truncated. */
export function parseFixed(value, decimals) {
  if (typeof value !== 'string' || value.length > 96 || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new SourceQuoteError('DECIMAL_INVALID', 'Expected a bounded decimal string.');
  }
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,2}))?$/.exec(value);
  if (!match) throw new SourceQuoteError('DECIMAL_INVALID', 'Invalid nonnegative decimal.');
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0);
  const digits = BigInt(match[1] + fraction);
  const shift = decimals + exponent - fraction.length;
  if (Math.abs(shift) > 96) throw new SourceQuoteError('DECIMAL_INVALID', 'Decimal exponent exceeds the bound.');
  if (shift >= 0) return digits * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift);
  if (digits % divisor !== 0n) throw new SourceQuoteError('DECIMAL_PRECISION', 'Value cannot be represented exactly.');
  return digits / divisor;
}

export function formatFixed(value, decimals) {
  if (typeof value !== 'bigint' || value < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new SourceQuoteError('DECIMAL_INVALID', 'Invalid fixed-point value.');
  }
  if (decimals === 0) return String(value);
  const scale = 10n ** BigInt(decimals);
  const fraction = String(value % scale).padStart(decimals, '0').replace(/0+$/, '');
  return String(value / scale) + (fraction ? '.' + fraction : '');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function contractHash(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }

export function billingRulesHash(rules, fallbackMultiplierBps) {
  return contractHash({ fallbackMultiplierBps, rules: rules.map(rule => ({ planCode: rule.planCode, version: rule.version, multiplierBps: rule.multiplierBps })).sort((a, b) => a.planCode.localeCompare(b.planCode)) });
}

/** Same two upward cent roundings as the published Gateway contract; the caller supplies frozen FX/rules. */
export function quoteGatewayCharge({ actualUsd, fxRate, multiplierBps }) {
  const usd = parseFixed(actualUsd, 8), rate = parseFixed(fxRate, 6);
  if (rate <= 0n || rate > 1000n * FX_SCALE || usd > 1_000_000n * USD_SCALE || !validMultiplier(multiplierBps)) {
    throw new SourceQuoteError('CHARGE_INPUT_INVALID', 'Charge input exceeds the Gateway bounds.');
  }
  const baseCents = ceilDiv(usd * rate * 100n, USD_SCALE * FX_SCALE);
  const chargedCents = ceilDiv(baseCents * BigInt(multiplierBps), BPS_SCALE);
  if (chargedCents > MAX_CENTS) throw new SourceQuoteError('COST_OVERFLOW', 'Charge exceeds wallet storage.');
  return { actualUsd: formatFixed(usd, 8), baseCents: Number(baseCents), chargedCents: Number(chargedCents), chargedPoints: formatFixed(chargedCents, 1) };
}

function ceilDiv(numerator, denominator) { return (numerator + denominator - 1n) / denominator; }
function validMultiplier(value) { return Number.isInteger(value) && value >= 100 && value <= 1_000_000; }
function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.values(Object.getOwnPropertyDescriptors(value)).every(item => 'value' in item);
}
function hash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function id(value) { return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value); }
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) && new Date(result).toISOString() === value ? result : null;
}

/**
 * A complete, pinned observation may produce a proposal, never an activated pool.
 * capacity budgets are already proven USD for the stated cycle: this function
 * deliberately does not turn percentages, concurrency or daily limits into Q30.
 */
export function evaluateGatewayPoolSource(input) {
  const blockedReasons = [];
  const reject = (code, path, message) => { blockedReasons.push({ code, path, message }); };
  const fail = () => ({ ready: false, blockedReasons });
  const object = (value, path) => {
    if (!plain(value)) { reject('SNAPSHOT_STRUCTURE_INVALID', path, 'Expected a plain data object.'); return {}; }
    return value;
  };
  const amount = (value, decimals, path) => {
    try { return parseFixed(value, decimals); }
    catch (error) { reject(error.code ?? 'DECIMAL_INVALID', path, 'Missing or inexact numeric evidence.'); return 0n; }
  };
  const cents = (value, path) => {
    if (!Number.isSafeInteger(value) || value < 0 || BigInt(value) > MAX_CENTS) { reject('CENTS_INVALID', path, 'Expected nonnegative integer Gateway cents.'); return 0n; }
    return BigInt(value);
  };
  const evidence = (value, path) => { if (!hash(value)) reject('EVIDENCE_MISSING', path, 'A pinned evidence hash is required.'); };
  const list = (value, path) => {
    if (!Array.isArray(value) || value.length > 100_000 || Object.getPrototypeOf(value) !== Array.prototype || !Object.values(Object.getOwnPropertyDescriptors(value)).every(item => 'value' in item)) { reject('INVENTORY_INVALID', path, 'Expected a bounded complete inventory.'); return []; }
    return value;
  };
  input = object(input, 'input');
  const expected = object(input.expected, 'expected'), source = object(input.source, 'source');
  const pricing = object(input.pricing, 'pricing'), liabilities = object(input.liabilities, 'liabilities');
  const now = instant(input.now), cycleStart = instant(expected.cycleStartedAt), cycleEnd = instant(expected.cycleEndsAt);
  if (now === null || cycleStart === null || cycleEnd === null || now < cycleStart || now >= cycleEnd) reject('CYCLE_INVALID', 'expected.cycle', 'A current, explicit cycle is required.');
  for (const key of ['configVersion', 'upstreamIdentityHash', 'capacityPolicyEvidenceHash', 'billingRulesHash', 'pricingEnvelopeEvidenceHash', 'fxSnapshotHash']) evidence(expected[key], `expected.${key}`);
  for (const key of ['issuerUserId', 'groupId', 'cycleId']) if (!id(expected[key])) reject('IDENTITY_INVALID', `expected.${key}`, 'An explicit source identity is required.');
  if (!['independent_usd', 'balance_only_proven'].includes(expected.capacityPolicy)) reject('CAPACITY_POLICY_UNPROVEN', 'expected.capacityPolicy', 'Actual instance capacity semantics must be pinned.');
  if (!['ecb', 'manual'].includes(expected.fxSource)) reject('FX_POLICY_INVALID', 'expected.fxSource', 'A pinned existing FX mode is required.');
  if (!Number.isInteger(expected.maxSourceAgeMs) || expected.maxSourceAgeMs <= 0 || expected.maxSourceAgeMs > 86_400_000) reject('SOURCE_TTL_INVALID', 'expected.maxSourceAgeMs', 'A bounded source freshness policy is required.');
  if (!Number.isInteger(expected.maxFxAgeMs) || expected.maxFxAgeMs <= 0 || expected.maxFxAgeMs > 259_200_000) reject('FX_TTL_INVALID', 'expected.maxFxAgeMs', 'FX freshness cannot exceed the existing 72-hour cache bound.');
  if (!Number.isInteger(expected.reserveBps) || expected.reserveBps < 0 || expected.reserveBps >= 10_000) reject('RESERVE_POLICY_INVALID', 'expected.reserveBps', 'An explicit reserve policy is required.');
  if (!Number.isSafeInteger(expected.poolVersion) || expected.poolVersion < 0) reject('POOL_VERSION_INVALID', 'expected.poolVersion', 'A pool CAS version is required.');
  const capturedAt = instant(source.capturedAt);
  if (capturedAt === null || now === null || capturedAt > now || now - capturedAt > expected.maxSourceAgeMs || capturedAt < cycleStart) reject('SOURCE_STALE', 'source.capturedAt', 'Source must be current and belong to the cycle.');
  evidence(source.evidenceHash, 'source.evidenceHash');
  if (source.configVersion !== expected.configVersion) reject('SOURCE_CONFIG_CHANGED', 'source.configVersion', 'Source configuration changed after capture.');
  if (source.upstreamIdentityHash !== expected.upstreamIdentityHash) reject('SOURCE_IDENTITY_MISMATCH', 'source.upstreamIdentityHash', 'Observation is from a different upstream identity.');
  if (source.cycleId !== expected.cycleId) reject('SOURCE_CYCLE_MISMATCH', 'source.cycleId', 'Observation belongs to a different cycle.');
  const issuer = object(source.issuer, 'source.issuer'), group = object(source.group, 'source.group');
  if (issuer.userId !== expected.issuerUserId || issuer.status !== 'active') reject('ISSUER_IDENTITY_MISMATCH', 'source.issuer', 'The configured active dedicated issuer is required.');
  if (issuer.dedicated !== true) reject('ISSUER_SCOPE_UNPROVEN', 'source.issuer.dedicated', 'Shared or unidentified account balances are not pool assets.');
  evidence(issuer.scopeEvidenceHash, 'source.issuer.scopeEvidenceHash');
  if (issuer.balanceUnit !== 'USD' || issuer.balanceMeaning !== 'remaining_total') reject('BALANCE_SEMANTICS_UNPROVEN', 'source.issuer.balanceMeaning', 'Balance units and treatment of upstream reservations must be proven.');
  const balance = amount(issuer.balanceUsd, 8, 'source.issuer.balanceUsd');
  const frozen = amount(issuer.upstreamFrozenUsd, 8, 'source.issuer.upstreamFrozenUsd');
  if (frozen !== 0n) reject('UPSTREAM_FROZEN_ATTRIBUTION_UNPROVEN', 'source.issuer.upstreamFrozenUsd', 'Nonzero upstream frozen balance needs attribution to local or external liabilities before initialization.');
  const external = amount(issuer.externalCommittedUsd, 8, 'source.issuer.externalCommittedUsd');
  evidence(issuer.commitmentEvidenceHash, 'source.issuer.commitmentEvidenceHash');
  if (group.id !== expected.groupId || group.issuerUserId !== expected.issuerUserId || group.status !== 'active' || group.billingType !== 'standard_balance' || group.issuerAccess !== 'proven' || group.costBasis !== 'actual_cost') reject('GROUP_PROOF_MISSING', 'source.group', 'The active configured balance group, issuer access and actual-cost basis must be proven.');
  evidence(group.evidenceHash, 'source.group.evidenceHash');
  evidence(group.effectiveRateEvidenceHash, 'source.group.effectiveRateEvidenceHash');

  const capacity = object(source.capacity, 'source.capacity');
  if (capacity.policyEvidenceHash !== expected.capacityPolicyEvidenceHash) reject('CAPACITY_POLICY_CHANGED', 'source.capacity.policyEvidenceHash', 'Capacity semantics do not match the reviewed instance policy.');
  let capacityBudget = null;
  if (expected.capacityPolicy === 'balance_only_proven') {
    if (capacity.kind !== 'balance_only_proven' || capacity.constraintInventoryComplete !== true || capacity.noIndependentCapacityConstraint !== true) reject('CAPACITY_UNPROVEN', 'source.capacity', 'Standard(Balance) or absence of a USD field does not prove absence of independent capacity constraints, including native-unit subscriptions.');
  } else if (expected.capacityPolicy === 'independent_usd') {
    if (capacity.kind !== 'bounded_usd' || capacity.budgetBasis !== 'remaining_plus_local_accounted_current_cycle') reject('CAPACITY_UNPROVEN', 'source.capacity', 'Finite, same-cycle actual USD capacity is required.');
    const accounts = list(capacity.accounts, 'source.capacity.accounts');
    if (!accounts.length) reject('CAPACITY_MISSING', 'source.capacity.accounts', 'No actual group USD capacity was observed.');
    const identities = new Set(), scopes = new Set();
    capacityBudget = 0n;
    let reservedBudget = null;
    for (let index = 0; index < accounts.length; index++) {
      const account = object(accounts[index], `source.capacity.accounts[${index}]`), path = `source.capacity.accounts[${index}]`;
      if (!id(account.id) || identities.has(account.id)) reject('CAPACITY_ID_DUPLICATE', `${path}.id`, 'Provider account identity is missing or duplicated.');
      identities.add(account.id);
      if (!id(account.capacityScopeId) || scopes.has(account.capacityScopeId)) reject('CAPACITY_SCOPE_DUPLICATE', `${path}.capacityScopeId`, 'Shared capacity must be consolidated once, never added per key/account.');
      scopes.add(account.capacityScopeId);
      if (account.groupId !== expected.groupId || account.status !== 'active' || account.unit !== 'USD' || account.bounded !== true) reject('CAPACITY_UNPROVEN', path, 'Inactive, unlimited or non-USD capacity cannot be monetized.');
      if (account.cycleId !== expected.cycleId || instant(account.validFrom) !== cycleStart || instant(account.validUntil) !== cycleEnd) reject('CAPACITY_WINDOW_MISMATCH', path, 'Capacity must cover the exact reviewed cycle without assumed renewals.');
      evidence(account.evidenceHash, `${path}.evidenceHash`);
      const budget = amount(account.budgetUsd, 8, `${path}.budgetUsd`);
      capacityBudget += budget;
      if (account.id === capacity.platformReservedAccountId) reservedBudget = budget;
    }
    if (!id(capacity.platformReservedAccountId) || reservedBudget === null) reject('PLATFORM_RESERVE_UNPROVEN', 'source.capacity.platformReservedAccountId', 'The configured platform provider reserve must match observed capacity.');
    else capacityBudget -= reservedBudget;
  }

  const fx = object(pricing.fx, 'pricing.fx');
  const rate = amount(fx.rate, 6, 'pricing.fx.rate');
  const fxShape = typeof fx.rate === 'string' && typeof fx.source === 'string' && (typeof fx.quoteId === 'string' || fx.quoteId === null) && (typeof fx.fetchedAt === 'string' || fx.fetchedAt === null) && (typeof fx.referenceDate === 'string' || fx.referenceDate === null);
  if (!fxShape || contractHash({ rate: fx.rate, source: fx.source, quoteId: fx.quoteId, fetchedAt: fx.fetchedAt, referenceDate: fx.referenceDate }) !== expected.fxSnapshotHash) reject('FX_SNAPSHOT_CHANGED', 'pricing.fx', 'The numerical FX/provenance snapshot differs from its reviewed pin.');
  if (rate <= 0n || rate > 1000n * FX_SCALE || fx.source !== expected.fxSource) reject('FX_INVALID', 'pricing.fx', 'An existing valid FX snapshot is required.');
  if (fx.source === 'ecb') {
    evidence(fx.quoteId, 'pricing.fx.quoteId');
    const fetched = instant(fx.fetchedAt);
    const reference = typeof fx.referenceDate === 'string' ? instant(`${fx.referenceDate}T00:00:00.000Z`) : null;
    if (fetched === null || reference === null || now === null || fetched > now || now - fetched > expected.maxFxAgeMs || reference > now || now - reference > 7 * 86_400_000) reject('FX_STALE', 'pricing.fx', 'FX/reference dates must remain within the published cache policy.');
  } else if (fx.quoteId !== null || fx.fetchedAt !== null || fx.referenceDate !== null) reject('FX_INVALID', 'pricing.fx', 'Manual FX must not claim automatic provenance.');
  const rules = list(pricing.rules, 'pricing.rules');
  if (pricing.rulesComplete !== true || !rules.length || !validMultiplier(pricing.fallbackMultiplierBps)) reject('BILLING_RULES_INCOMPLETE', 'pricing.rules', 'All effective billing rules, including fallback, are required.');
  let minimumMultiplierBps = validMultiplier(pricing.fallbackMultiplierBps) ? pricing.fallbackMultiplierBps : 10_000;
  let validRules = true;
  const plans = new Set();
  for (let index = 0; index < rules.length; index++) {
    const rule = object(rules[index], `pricing.rules[${index}]`);
    if (!id(rule.planCode) || plans.has(rule.planCode) || !Number.isSafeInteger(rule.version) || rule.version < 0 || !validMultiplier(rule.multiplierBps)) { validRules = false; reject('BILLING_RULE_INVALID', `pricing.rules[${index}]`, 'Rule identity/version/multiplier is invalid or duplicated.'); }
    plans.add(rule.planCode);
    if (validMultiplier(rule.multiplierBps)) minimumMultiplierBps = Math.min(minimumMultiplierBps, rule.multiplierBps);
  }
  // The rule hash is recomputed from numerical contents, not trusted from a claimed field.
  if (!validRules || !rules.every(plain) || billingRulesHash(rules, pricing.fallbackMultiplierBps) !== expected.billingRulesHash) reject('BILLING_RULES_CHANGED', 'pricing.rules', 'Effective numerical rules differ from the reviewed config version.');
  if (!['actual_usd_required', 'catalog_lower_bound_proven'].includes(pricing.costCoverage) || pricing.envelopeEvidenceHash !== expected.pricingEnvelopeEvidenceHash) reject('CATALOG_COST_BOUND_UNPROVEN', 'pricing.costCoverage', 'Catalog fallback cannot establish an actual USD cost bound without explicit evidence.');

  const inventoryTime = instant(liabilities.capturedAt);
  if (liabilities.complete !== true || liabilities.consistent !== true || inventoryTime === null || now === null || inventoryTime > now || now - inventoryTime > expected.maxSourceAgeMs) reject('LIABILITY_INVENTORY_INCOMPLETE', 'liabilities', 'A complete consistent financial snapshot is required.');
  evidence(liabilities.evidenceHash, 'liabilities.evidenceHash');
  if (liabilities.poolVersion !== expected.poolVersion) reject('POOL_VERSION_CHANGED', 'liabilities.poolVersion', 'Pool CAS version changed after the proposal snapshot.');
  if (liabilities.cycleId !== expected.cycleId) reject('LIABILITY_CYCLE_MISMATCH', 'liabilities.cycleId', 'Consumption must belong to the same cycle as source add-back.');
  const consumedUsd = amount(liabilities.cycleAccountedUsd, 8, 'liabilities.cycleAccountedUsd');
  const sourceAccounted = amount(issuer.cycleAccountedUsd, 8, 'source.issuer.cycleAccountedUsd');
  if (sourceAccounted !== consumedUsd) reject('ACCOUNTED_USD_MISMATCH', 'source.issuer.cycleAccountedUsd', 'Only actual USD already recorded once in this cycle may be added back.');
  evidence(liabilities.accountedEvidenceHash, 'liabilities.accountedEvidenceHash');
  if (issuer.accountedEvidenceHash !== liabilities.accountedEvidenceHash) reject('ACCOUNTED_EVIDENCE_MISMATCH', 'source.issuer.accountedEvidenceHash', 'Source add-back and local actual-USD journal must reference the same evidence.');
  const consumedCents = cents(liabilities.consumedCents, 'liabilities.consumedCents');
  if (consumedUsd > 0n && consumedCents === 0n) reject('CYCLE_LEDGER_MISMATCH', 'liabilities.consumedCents', 'Positive pool-provider consumption has no corresponding point retirement evidence.');
  const wallets = list(liabilities.wallets, 'liabilities.wallets'), walletByUser = new Map();
  let walletCents = 0n;
  for (let index = 0; index < wallets.length; index++) {
    const wallet = object(wallets[index], `liabilities.wallets[${index}]`), path = `liabilities.wallets[${index}]`;
    if (!id(wallet.userId) || walletByUser.has(wallet.userId)) reject('WALLET_ID_DUPLICATE', `${path}.userId`, 'All wallet identities must be unique, including inactive accounts.');
    const balanceCents = cents(wallet.balanceCents, `${path}.balanceCents`);
    if (balanceCents !== cents(wallet.ledgerBalanceCents, `${path}.ledgerBalanceCents`)) reject('WALLET_LEDGER_MISMATCH', path, 'Wallet balance does not match its immutable ledger.');
    walletByUser.set(wallet.userId, balanceCents);
    walletCents += balanceCents;
  }
  const holds = list(liabilities.holds, 'liabilities.holds'), holdEvents = new Set(), holdsByUser = new Map();
  let heldCents = 0n, valuationProduct = rate * BigInt(minimumMultiplierBps);
  for (let index = 0; index < holds.length; index++) {
    const hold = object(holds[index], `liabilities.holds[${index}]`), path = `liabilities.holds[${index}]`;
    if (!id(hold.eventId) || holdEvents.has(hold.eventId)) reject('HOLD_EVENT_DUPLICATE', `${path}.eventId`, 'Frozen request identity must be unique.');
    holdEvents.add(hold.eventId);
    if (!walletByUser.has(hold.userId) || !['reserved', 'dispatched', 'unknown'].includes(hold.status)) reject('HOLD_INVENTORY_INVALID', path, 'Only complete active holds belonging to an inventoried wallet are accepted.');
    const held = cents(hold.heldCents, `${path}.heldCents`);
    heldCents += held;
    holdsByUser.set(hold.userId, (holdsByUser.get(hold.userId) ?? 0n) + held);
    const heldRate = amount(hold.fxRate, 6, `${path}.fxRate`);
    if (heldRate <= 0n || heldRate > 1000n * FX_SCALE || !validMultiplier(hold.multiplierBps)) reject('HOLD_PRICE_UNPROVEN', path, 'Historical in-flight FX and multiplier must remain frozen.');
    else valuationProduct = valuationProduct < heldRate * BigInt(hold.multiplierBps) ? valuationProduct : heldRate * BigInt(hold.multiplierBps);
  }
  for (const [userId, held] of holdsByUser) if (held > (walletByUser.get(userId) ?? 0n)) reject('HOLD_LIABILITY_DEFICIT', 'liabilities.holds', 'Frozen known liabilities exceed the wallet; reconcile without releasing unknown outcomes.');
  const pending = list(liabilities.pendingReservations, 'liabilities.pendingReservations'), orderIds = new Set();
  let pendingCents = 0n;
  for (let index = 0; index < pending.length; index++) {
    const order = object(pending[index], `liabilities.pendingReservations[${index}]`), path = `liabilities.pendingReservations[${index}]`;
    if (!id(order.orderId) || orderIds.has(order.orderId) || order.status !== 'reserved') reject('ORDER_RESERVATION_INVALID', path, 'Only actual unique pool reservations count, not all unpaid orders.');
    orderIds.add(order.orderId);
    pendingCents += cents(order.amountCents, `${path}.amountCents`);
  }
  if (external > balance + sourceAccounted) reject('EXTERNAL_COMMITMENT_DEFICIT', 'source.issuer.externalCommittedUsd', 'External claims exceed issuer backing.');
  const issuerBudget = balance + sourceAccounted - external;
  const effectiveBudget = capacityBudget === null ? issuerBudget : (capacityBudget < issuerBudget ? capacityBudget : issuerBudget);
  if (blockedReasons.length) return fail();
  // Assets round down. Apply the lowest actual effective rate/multiplier once;
  // do not reuse the charge helper's upward rounding to create distributable funds.
  const totalCents = effectiveBudget * valuationProduct * 100n * BigInt(10_000 - expected.reserveBps) / (USD_SCALE * FX_SCALE * BPS_SCALE * BPS_SCALE);
  const committed = walletCents + pendingCents + consumedCents;
  if (totalCents > MAX_CENTS) reject('POOL_STORAGE_OVERFLOW', 'quote.totalCents', 'The existing pool integer-cent model cannot store this capacity.');
  if (committed > totalCents) reject('BACKING_SHORTFALL', 'liabilities', 'Verified backing does not cover carried wallets, actual order reservations and cycle consumption.');
  if (blockedReasons.length) return fail();
  const availableCents = totalCents - committed;
  const expiryTimes = [capturedAt + expected.maxSourceAgeMs, inventoryTime + expected.maxSourceAgeMs, cycleEnd];
  if (fx.source === 'ecb') expiryTimes.push(instant(fx.fetchedAt) + expected.maxFxAgeMs, instant(`${fx.referenceDate}T00:00:00.000Z`) + 7 * 86_400_000);
  const quote = {
    version: 1, configVersion: expected.configVersion, poolVersion: expected.poolVersion,
    cycleId: expected.cycleId, cycleStartedAt: expected.cycleStartedAt, cycleEndsAt: expected.cycleEndsAt,
    sourceEvidenceHash: source.evidenceHash, liabilityEvidenceHash: liabilities.evidenceHash,
    upstreamIdentityHash: expected.upstreamIdentityHash, issuerUserId: expected.issuerUserId, groupId: expected.groupId,
    capturedAt: source.capturedAt, sourceExpiresAt: new Date(capturedAt + expected.maxSourceAgeMs).toISOString(),
    proposalExpiresAt: new Date(Math.min(...expiryTimes)).toISOString(),
    pricing: { fxRate: formatFixed(rate, 6), fxSource: fx.source, fxQuoteId: fx.quoteId,
      billingRulesHash: expected.billingRulesHash, minimumMultiplierBps, valuationProduct: String(valuationProduct), reserveBps: expected.reserveBps,
      envelopeEvidenceHash: expected.pricingEnvelopeEvidenceHash },
    // These USD observations are separate from the point conservation counters.
    usd: { issuerBalanceUsd: formatFixed(balance, 8), cycleAccountedUsd: formatFixed(sourceAccounted, 8), externalCommittedUsd: formatFixed(external, 8),
      issuerBudgetUsd: formatFixed(issuerBudget, 8), groupCapacityUsd: capacityBudget === null ? null : formatFixed(capacityBudget, 8), effectiveBudgetUsd: formatFixed(effectiveBudget, 8), capacityPolicy: expected.capacityPolicy },
    points: { totalCents: Number(totalCents), availableCents: Number(availableCents), walletCents: Number(walletCents), pendingCents: Number(pendingCents), consumedCents: Number(consumedCents),
      heldCents: Number(heldCents), availablePoints: formatFixed(availableCents, 1) }
  };
  return { ready: true, quote: { ...quote, quoteHash: contractHash(quote) }, blockedReasons: [] };
}
