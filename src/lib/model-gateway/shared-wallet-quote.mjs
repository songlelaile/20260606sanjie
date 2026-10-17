import { parseFixed, formatFixed, contractHash, billingRulesHash, USD_SCALE, FX_SCALE, BPS_SCALE, MAX_CENTS } from './source-quote.mjs';

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Object.values(Object.getOwnPropertyDescriptors(value)).every(item => 'value' in item);
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? Date.parse(value) : null;
const hash = value => typeof value === 'string' && HASH.test(value);
const multiplier = value => Number.isInteger(value) && value >= 100 && value <= 1_000_000;

/** Approved posted lifetime owner-wallet arithmetic. No artificial cycle, provider calls or database writes. */
export function evaluateSharedWalletSource(input) {
  const blockedReasons = [];
  const reject = (code, path, message) => blockedReasons.push({ code, path, message });
  const blocked = () => ({ ready: false, blockedReasons });
  const object = (value, path) => { if (!plain(value)) { reject('SHARED_SOURCE_STRUCTURE_INVALID', path, 'Expected plain immutable facts.'); return {}; } return value; };
  const evidence = (value, path) => { if (!hash(value)) reject('EVIDENCE_MISSING', path, 'A reviewed evidence pin is required.'); };
  const amount = (value, decimals, path) => { try { return parseFixed(value, decimals); } catch { reject('DECIMAL_INVALID', path, 'Missing or inexact amount.'); return 0n; } };
  const cents = (value, path) => { if (!Number.isSafeInteger(value) || value < 0 || BigInt(value) > MAX_CENTS) { reject('CENTS_INVALID', path, 'Expected bounded nonnegative cents.'); return 0n; } return BigInt(value); };
  const list = (value, path) => { if (!Array.isArray(value) || value.length > 100_000 || Object.getPrototypeOf(value) !== Array.prototype || !Object.values(Object.getOwnPropertyDescriptors(value)).every(item => 'value' in item)) { reject('INVENTORY_INVALID', path, 'A complete bounded inventory is required.'); return []; } return value; };
  input = object(input, 'input');
  if (input.schema !== 'SANJIE_SHARED_WALLET_PROOF_V1' || input.scope !== 'shared_user_lifetime_wallet') reject('SHARED_SOURCE_SCOPE_INVALID', 'scope', 'The explicitly approved shared wallet scope is required.');
  const binding = object(input.binding, 'binding'), epoch = object(input.epoch, 'epoch'), policy = object(input.policy, 'policy');
  const source = object(input.source, 'source'), external = object(input.externalCommitments, 'externalCommitments');
  const pricing = object(input.pricing, 'pricing'), liabilities = object(input.liabilities, 'liabilities');
  const now = instant(input.now), startedAt = instant(epoch.startedAt), captured = instant(source.capturedAt);
  if (now === null || startedAt === null || startedAt > now || !ID.test(epoch.id ?? '') || epoch.assetExpiresAt !== null) reject('SHARED_EPOCH_INVALID', 'epoch', 'A server-owned lifetime audit epoch is required; asset expiry is unknown, not invented.');
  if (binding.origin !== 'https://sub.shaozhuangai.com' || typeof binding.ownerSubject !== 'string' || binding.ownerSubject.length < 1 || binding.ownerSubject.length > 160 || /[\u0000-\u001f\u007f]/.test(binding.ownerSubject) ||
      binding.approvedExposure !== 'posted_balance_with_unobservable_external_requests') reject('SHARED_AUTHORITY_UNPROVEN', 'binding', 'Operator approval of posted shared-owner exposure is required.');
  evidence(binding.credentialFingerprint, 'binding.credentialFingerprint'); evidence(binding.approvalEvidenceHash, 'binding.approvalEvidenceHash'); evidence(binding.authorityHash, 'binding.authorityHash');
  const group = object(binding.routeGroupBinding, 'binding.routeGroupBinding');
  if (group.groupId !== null && !ID.test(group.groupId ?? '') || typeof group.groupName !== 'string' || group.groupName.length < 1 || group.groupName.length > 80) reject('SHARED_GROUP_BINDING_UNPROVEN', 'binding.routeGroupBinding', 'A reviewed route binding is required, without invented API IDs.');
  evidence(group.bindingEvidenceHash, 'binding.routeGroupBinding.bindingEvidenceHash');
  const approvedCredentials = list(binding.approvedCredentialFingerprints, 'binding.approvedCredentialFingerprints');
  if (approvedCredentials.some(item => !hash(item)) || new Set(approvedCredentials).size !== approvedCredentials.length) reject('SHARED_CREDENTIAL_BINDING_INVALID', 'binding.approvedCredentialFingerprints', 'Dispatch credentials need individual reviewed fingerprints.');
  const { authorityHash: ignoredAuthority, ...authority } = binding;
  void ignoredAuthority;
  if (plain(input.binding) && contractHash(authority) !== binding.authorityHash) reject('SHARED_AUTHORITY_CHANGED', 'binding.authorityHash', 'The approved binding changed.');
  evidence(policy.configVersion, 'policy.configVersion');
  if (!Number.isInteger(policy.maxSourceAgeMs) || policy.maxSourceAgeMs < 1 || policy.maxSourceAgeMs > 60_000 || captured === null || now === null || captured > now || now - captured > policy.maxSourceAgeMs) reject('SOURCE_STALE', 'source.capturedAt', 'Fresh posted wallet reading is required before allocation.');
  if (!Number.isInteger(policy.maxFxAgeMs) || policy.maxFxAgeMs < 1 || policy.maxFxAgeMs > 259_200_000) reject('FX_TTL_INVALID', 'policy.maxFxAgeMs', 'Existing FX freshness bound is required.');
  if (!Number.isInteger(policy.reserveBps) || policy.reserveBps < 0 || policy.reserveBps >= 10_000) reject('RESERVE_POLICY_INVALID', 'policy.reserveBps', 'An explicit approved reserve policy is required.');
  if (source.httpStatus !== 200 || source.isValid !== true || source.mode !== 'unrestricted' || source.nativeUnit !== 'USD') reject('SHARED_SOURCE_SCOPE_CHANGED', 'source', 'The approved unrestricted posted USD wallet must remain valid.');
  evidence(source.responseHash, 'source.responseHash'); evidence(source.evidenceHash, 'source.evidenceHash');
  const balance = amount(source.balanceUsd, 8, 'source.balanceUsd'), remaining = amount(source.remainingUsd, 8, 'source.remainingUsd');
  if (balance !== remaining || amount(source.balanceRaw, 8, 'source.balanceRaw') !== balance || amount(source.remainingRaw, 8, 'source.remainingRaw') !== remaining) reject('SOURCE_BALANCE_INCONSISTENT', 'source.balanceUsd', 'Posted balance and remaining must match exactly.');
  const { evidenceHash: ignoredSource, ...sourceFacts } = source;
  void ignoredSource;
  if (plain(input.source) && contractHash({ source: sourceFacts, binding }) !== source.evidenceHash) reject('SOURCE_EVIDENCE_CHANGED', 'source.evidenceHash', 'Trusted reading projection changed.');
  evidence(external.evidenceHash, 'externalCommitments.evidenceHash');
  let committed = 0n;
  if (external.state === 'proven') committed = amount(external.amountUsd, 8, 'externalCommitments.amountUsd');
  else if (external.state !== 'unobservable' || external.amountUsd !== null) reject('SHARED_COMMITMENT_SEMANTICS_INVALID', 'externalCommitments', 'Unobservable requests remain null, never a claim of zero commitments.');
  const fx = object(pricing.fx, 'pricing.fx'), rate = amount(fx.rate, 6, 'pricing.fx.rate');
  if (rate <= 0n || rate > 1000n * FX_SCALE || !['ecb', 'manual'].includes(fx.source) || !['actual_usd_required', 'local_catalog_or_actual_usd'].includes(pricing.costCoverage)) reject('SHARED_PRICING_UNPROVEN', 'pricing', 'Valid existing FX and verified per-request local pricing or actual USD settlement are required.');
  evidence(pricing.envelopeEvidenceHash, 'pricing.envelopeEvidenceHash');
  if (fx.source === 'ecb') {
    evidence(fx.quoteId, 'pricing.fx.quoteId'); const fetched = instant(fx.fetchedAt);
    const reference = typeof fx.referenceDate === 'string' ? instant(`${fx.referenceDate}T00:00:00.000Z`) : null;
    if (fetched === null || now === null || fetched > now || now - fetched > policy.maxFxAgeMs || reference === null || reference > now || now - reference > 7 * 86_400_000) reject('FX_STALE', 'pricing.fx', 'A fresh verified ECB quote and recent reference date are required.');
  } else if (fx.quoteId !== null || fx.fetchedAt !== null || fx.referenceDate !== null) reject('FX_PROVENANCE_INVALID', 'pricing.fx', 'Manual FX must not invent automatic provenance.');
  const rules = list(pricing.rules, 'pricing.rules'); const plans = new Set();
  if (pricing.rulesComplete !== true || !multiplier(pricing.fallbackMultiplierBps)) reject('PRICING_RULES_UNPROVEN', 'pricing.rules', 'All effective plans and fallback price must be covered.');
  let minimum = multiplier(pricing.fallbackMultiplierBps) ? pricing.fallbackMultiplierBps : 100;
  for (const row of rules) {
    const rule = object(row, 'pricing.rules[]');
    if (typeof rule.planCode !== 'string' || !ID.test(rule.planCode) || plans.has(rule.planCode) || !multiplier(rule.multiplierBps) || !Number.isSafeInteger(rule.version) || rule.version < 0) reject('PRICING_RULES_INVALID', 'pricing.rules', 'Unique versioned effective plan prices are required.');
    plans.add(rule.planCode); if (multiplier(rule.multiplierBps)) minimum = Math.min(minimum, rule.multiplierBps);
  }
  const currentProduct = rate * BigInt(minimum);
  let valuation = currentProduct;
  if (policy.frozenValuationProduct !== null) {
    if (typeof policy.frozenValuationProduct !== 'string' || !/^[1-9]\d{0,32}$/.test(policy.frozenValuationProduct)) reject('VALUATION_INVALID', 'policy.frozenValuationProduct', 'The first adopted valuation must remain fixed.');
    else valuation = BigInt(policy.frozenValuationProduct);
  }
  // The adopted valuation is an immutable ceiling. A lower current funding
  // floor reduces observed capacity; it never reprices wallets, consumed cents
  // or historical holds, and a rebound can only restore the original ceiling.
  if (currentProduct < valuation) valuation = currentProduct;
  const liabilityTime = instant(liabilities.capturedAt);
  if (liabilities.complete !== true || liabilities.consistent !== true || liabilities.epochId !== epoch.id ||
      !Number.isSafeInteger(liabilities.poolVersion) || liabilities.poolVersion < 0 || liabilityTime === null || now === null || liabilityTime > now || now - liabilityTime > policy.maxSourceAgeMs) reject('LIABILITIES_UNPROVEN', 'liabilities', 'Current complete same-epoch accounting inventory is required.');
  evidence(liabilities.evidenceHash, 'liabilities.evidenceHash'); evidence(liabilities.accountedEvidenceHash, 'liabilities.accountedEvidenceHash');
  const accounted = amount(liabilities.accountedUsd, 8, 'liabilities.accountedUsd');
  const consumed = cents(liabilities.consumedCents, 'liabilities.consumedCents');
  if (consumed === 0n && accounted > 0n) reject('POOL_ACCOUNTED_USD_MISMATCH', 'liabilities.accountedUsd', 'Posted USD add-back must relate to actual same-epoch consumption. Response-only cost does not prove owner-wallet posting.');
  let wallet = 0n, held = 0n, pending = 0n; const users = new Map(), heldByUser = new Map(), events = new Set(), orders = new Set();
  for (const row of list(liabilities.wallets, 'liabilities.wallets')) {
    const entry = object(row, 'liabilities.wallets[]'); const value = cents(entry.balanceCents, 'wallet.balanceCents');
    if (!ID.test(entry.userId ?? '') || users.has(entry.userId) || value !== cents(entry.ledgerBalanceCents, 'wallet.ledgerBalanceCents')) reject('WALLET_INCONSISTENT', 'liabilities.wallets', 'Every wallet is adopted once and reconciled to its journal.');
    users.set(entry.userId, value); wallet += value;
  }
  for (const row of list(liabilities.holds, 'liabilities.holds')) {
    const entry = object(row, 'liabilities.holds[]'); const value = cents(entry.heldCents, 'hold.heldCents');
    if (!ID.test(entry.eventId ?? '') || events.has(entry.eventId) || !users.has(entry.userId) || !['reserved', 'dispatched', 'unknown'].includes(entry.status)) reject('HOLD_INCONSISTENT', 'liabilities.holds', 'Active holds are unique subsets of existing wallets.');
    events.add(entry.eventId); held += value;
    heldByUser.set(entry.userId, (heldByUser.get(entry.userId) ?? 0n) + value);
    const holdRate = amount(entry.fxRate, 6, 'hold.fxRate');
    if (!multiplier(entry.multiplierBps) || holdRate * BigInt(multiplier(entry.multiplierBps) ? entry.multiplierBps : 0) < valuation) reject('HOLD_PRICE_UNPROVEN', 'liabilities.holds', 'All active holds must cover the frozen valuation.');
    if (heldByUser.get(entry.userId) > (users.get(entry.userId) ?? 0n)) reject('HOLD_EXCEEDS_WALLET', 'liabilities.holds', 'The aggregate held subset cannot exceed its own wallet.');
  }
  for (const row of list(liabilities.pendingReservations, 'liabilities.pendingReservations')) {
    const entry = object(row, 'liabilities.pendingReservations[]');
    if (!ID.test(entry.orderId ?? '') || orders.has(entry.orderId) || entry.status !== 'reserved') reject('RESERVATION_INCONSISTENT', 'liabilities.pendingReservations', 'Only real capacity reservations enter this inventory.');
    orders.add(entry.orderId); pending += cents(entry.amountCents, 'reservation.amountCents');
  }
  // No existing checkout reserves capacity. Never reinterpret an unpaid or merely awaiting payment as P.
  if (pending !== 0n) reject('RESERVATION_UNSUPPORTED', 'liabilities.pendingReservations', 'This gateway does not create capacity reservations.');
  if (held > wallet) reject('HOLD_EXCEEDS_WALLET', 'liabilities.holds', 'H is included in W and is not deducted again.');
  if (blockedReasons.length) return blocked();
  const budgetBeforeCommitments = balance + accounted;
  if (committed > budgetBeforeCommitments) { reject('SHARED_COMMITMENTS_EXCEED_BALANCE', 'externalCommitments', 'Proven external commitments exceed posted funds plus local actual-USD add-back.'); return blocked(); }
  const budget = budgetBeforeCommitments - committed;
  const total = budget * valuation * 100n * BigInt(10_000 - policy.reserveBps) / (USD_SCALE * FX_SCALE * BPS_SCALE * 10_000n);
  const obligation = wallet + consumed + pending, available = total >= obligation ? total - obligation : 0n, deficit = obligation > total ? obligation - total : 0n;
  if ([total, wallet, held, consumed, pending, available, deficit].some(value => value > MAX_CENTS)) { reject('POOL_CAPACITY_OVERFLOW', 'points', 'Amounts exceed gateway storage bounds.'); return blocked(); }
  const sourceExpiresAt = new Date(captured + policy.maxSourceAgeMs).toISOString();
  const proposalExpiresAt = new Date(Math.min(captured + policy.maxSourceAgeMs, fx.source === 'ecb' ? instant(fx.fetchedAt) + policy.maxFxAgeMs : Number.MAX_SAFE_INTEGER)).toISOString();
  const quote = { version: 1, scope: 'shared_user_lifetime_wallet', configVersion: policy.configVersion, poolVersion: liabilities.poolVersion,
    epochId: epoch.id, epochStartedAt: epoch.startedAt, assetExpiresAt: null, upstreamIdentityHash: binding.authorityHash,
    sourceEvidenceHash: source.evidenceHash, liabilityEvidenceHash: liabilities.evidenceHash, capturedAt: source.capturedAt, sourceExpiresAt, proposalExpiresAt,
    pricing: { fxRate: fx.rate, fxSource: fx.source, fxQuoteId: fx.quoteId, billingRulesHash: billingRulesHash(rules, pricing.fallbackMultiplierBps), costCoverage: pricing.costCoverage,
      minimumMultiplierBps: minimum, valuationProduct: valuation.toString(), reserveBps: policy.reserveBps, envelopeEvidenceHash: pricing.envelopeEvidenceHash },
    usd: { postedBalanceUsd: formatFixed(balance, 8), localAccountedUsd: formatFixed(accounted, 8),
      externalCommittedUsd: external.state === 'unobservable' ? null : formatFixed(committed, 8), externalCommitmentsState: external.state, effectiveBudgetUsd: formatFixed(budget, 8) },
    points: { totalCents: Number(total), availableCents: Number(available), deficitCents: Number(deficit), walletCents: Number(wallet), pendingCents: Number(pending),
      consumedCents: Number(consumed), heldCents: Number(held), availablePoints: formatFixed(available, 1) } };
  const completeQuote = { ...quote, quoteHash: contractHash(quote) };
  if (deficit > 0n) { reject('BACKING_SHORTFALL', 'points', 'Posted shared wallet no longer covers adopted obligations. Wallets and holds remain unchanged.'); return { ready: false, blockedReasons, observation: completeQuote }; }
  return { ready: true, blockedReasons: [], quote: completeQuote };
}
