import { describe, expect, it } from "vitest";
import { contractHash } from "./source-quote.mjs";
import { evaluateSharedWalletSource, type SharedWalletProof } from "./shared-wallet-quote.mjs";
const hash = "a".repeat(64), time = "2026-10-09T00:00:00.000Z";
function fixture(): SharedWalletProof {
  const facts = { origin: "https://sub.shaozhuangai.com" as const, credentialFingerprint: hash, ownerSubject: "fixture-owner", routeGroupBinding: { groupId: null, groupName: "fixture-group", bindingEvidenceHash: hash }, approvalEvidenceHash: hash, approvedExposure: "posted_balance_with_unobservable_external_requests" as const, approvedCredentialFingerprints: [] };
  const binding = { ...facts, authorityHash: contractHash(facts) };
  const source = { capturedAt: time, responseHash: hash, httpStatus: 200 as const, isValid: true as const, mode: "unrestricted" as const, nativeUnit: "USD" as const, balanceUsd: "1", remainingUsd: "1", balanceRaw: "1.00000000", remainingRaw: "1" };
  return { schema: "SANJIE_SHARED_WALLET_PROOF_V1", scope: "shared_user_lifetime_wallet", now: time, binding, epoch: { id: "local-epoch", startedAt: time, assetExpiresAt: null },
    policy: { configVersion: hash, maxSourceAgeMs: 30_000, maxFxAgeMs: 259_200_000, reserveBps: 0, frozenValuationProduct: "10000000000" }, source: { ...source, evidenceHash: contractHash({ source, binding }) }, externalCommitments: { state: "unobservable", amountUsd: null, evidenceHash: hash },
    pricing: { fx: { rate: "1", source: "manual", quoteId: null, fetchedAt: null, referenceDate: null }, rules: [{ planCode: "business", multiplierBps: 11000, version: 1 }], rulesComplete: true, fallbackMultiplierBps: 10000, costCoverage: "actual_usd_required", envelopeEvidenceHash: hash },
    liabilities: { capturedAt: time, evidenceHash: hash, complete: true, consistent: true, poolVersion: 0, epochId: "local-epoch", accountedUsd: "0", accountedEvidenceHash: hash, consumedCents: 0, wallets: [{ userId: "u", balanceCents: 40, ledgerBalanceCents: 40 }], holds: [{ eventId: "h", userId: "u", heldCents: 10, status: "reserved", fxRate: "1", multiplierBps: 10000 }], pendingReservations: [] } };
}
function balance(value: SharedWalletProof, amount: string) { value.source.balanceUsd = value.source.remainingUsd = value.source.balanceRaw = value.source.remainingRaw = amount; const { evidenceHash: ignored, ...source } = value.source; void ignored; value.source.evidenceHash = contractHash({ source, binding: value.binding }); }
describe("shared lifetime posted balance arithmetic", () => {
  it("lowest effective rate values funds and adopts W including H once, without fake external zero", () => { const result = evaluateSharedWalletSource(fixture()); expect(result.ready).toBe(true); if (!result.ready) return; expect(result.quote.points).toMatchObject({ totalCents: 100, availableCents: 60, walletCents: 40, heldCents: 10 }); expect(result.quote.usd.externalCommittedUsd).toBeNull(); expect(result.quote.assetExpiresAt).toBeNull(); });
  it("independently posted same-request USD can offset source drain", () => { const value = fixture(); balance(value, "0.8"); value.liabilities.accountedUsd = "0.2"; value.liabilities.consumedCents = 20; value.liabilities.wallets[0].balanceCents = value.liabilities.wallets[0].ledgerBalanceCents = 20; const result = evaluateSharedWalletSource(value); expect(result.ready).toBe(true); if (result.ready) expect(result.quote.points).toMatchObject({ totalCents: 100, availableCents: 60, consumedCents: 20, walletCents: 20 }); });
  it("response actual USD without owner posting evidence settles C but does not mint add-back", () => { const value = fixture(); balance(value, "0.8"); value.liabilities.consumedCents = 20; value.liabilities.wallets[0].balanceCents = value.liabilities.wallets[0].ledgerBalanceCents = 20; const result = evaluateSharedWalletSource(value); expect(result.ready).toBe(true); if (result.ready) expect(result.quote.points).toMatchObject({ totalCents: 80, availableCents: 40, consumedCents: 20, walletCents: 20 }); });
  it("catalog consumption without actual USD reserves C and preserves only posted-balance capacity", () => {
    const value = fixture(); value.pricing.costCoverage = "local_catalog_or_actual_usd";
    balance(value, "0.8"); value.liabilities.consumedCents = 20; value.liabilities.wallets[0].balanceCents = value.liabilities.wallets[0].ledgerBalanceCents = 20;
    const result = evaluateSharedWalletSource(value); expect(result.ready).toBe(true); if (!result.ready) return;
    expect(result.quote.pricing.costCoverage).toBe("local_catalog_or_actual_usd");
    expect(result.quote.points).toMatchObject({ totalCents: 80, availableCents: 40, consumedCents: 20, walletCents: 20 });
    expect(result.quote.usd).toMatchObject({ postedBalanceUsd: "0.8", localAccountedUsd: "0", effectiveBudgetUsd: "0.8" });
    expect(result.quote.usd).not.toHaveProperty("actualUsd");
  });
  it("catalog C remains reserved after upstream posted balance falls", () => {
    const value = fixture(); value.pricing.costCoverage = "local_catalog_or_actual_usd";
    balance(value, "0.3"); value.liabilities.consumedCents = 20; value.liabilities.wallets[0].balanceCents = value.liabilities.wallets[0].ledgerBalanceCents = 20;
    const result = evaluateSharedWalletSource(value); expect(result.ready).toBe(false); if (result.ready) return;
    expect(result.observation?.points).toMatchObject({ totalCents: 30, availableCents: 0, deficitCents: 10, walletCents: 20, consumedCents: 20, heldCents: 10 });
    expect(result.observation?.usd.localAccountedUsd).toBe("0");
  });
  it.each(["catalog", "estimated_usd", { toString: () => "local_catalog_or_actual_usd" }])("unsupported coverage %j cannot authorize a quote", costCoverage => {
    const value = fixture(); value.pricing.costCoverage = costCoverage as never;
    expect(evaluateSharedWalletSource(value).ready).toBe(false);
  });
  it("catalog permission still requires immutable reviewed settlement evidence", () => {
    const value = fixture(); value.pricing.costCoverage = "local_catalog_or_actual_usd"; value.pricing.envelopeEvidenceHash = "";
    expect(evaluateSharedWalletSource(value).ready).toBe(false);
  });
  it("external drain yields durable deficit observation without erasing W or H", () => { const value = fixture(); balance(value, "0.3"); value.liabilities.accountedUsd = "0.2"; value.liabilities.consumedCents = 20; const result = evaluateSharedWalletSource(value); expect(result.ready).toBe(false); if (result.ready) return; expect(result.observation?.points).toMatchObject({ totalCents: 50, availableCents: 0, deficitCents: 10, walletCents: 40, consumedCents: 20, heldCents: 10 }); expect(value.liabilities.wallets[0].balanceCents).toBe(40); });
  it("price increase cannot revalue spent USD or create A", () => { const value = fixture(); value.pricing.fx.rate = "2"; const result = evaluateSharedWalletSource(value); expect(result.ready).toBe(true); if (result.ready) expect(result.quote.points.totalCents).toBe(100); });
  it("lower current FX values fresh funds conservatively under the immutable adopted ceiling", () => {
    const value = fixture(); value.pricing.fx.rate = "0.5"; const before = structuredClone(value);
    const result = evaluateSharedWalletSource(value); expect(result.ready).toBe(true); if (!result.ready) return;
    expect(result.quote.pricing.valuationProduct).toBe("5000000000");
    expect(result.quote.points).toMatchObject({ totalCents: 50, availableCents: 10, walletCents: 40, heldCents: 10 });
    expect(value).toEqual(before); expect(value.policy.frozenValuationProduct).toBe("10000000000");
  });
  it("a lower effective plan price creates a real deficit rather than preserving old capacity", () => {
    const value = fixture(); value.pricing.rules[0] = { planCode: "business", multiplierBps: 2500, version: 2 };
    const result = evaluateSharedWalletSource(value); expect(result.ready).toBe(false); if (result.ready) return;
    expect(result.blockedReasons.map(row => row.code)).toEqual(["BACKING_SHORTFALL"]);
    expect(result.observation?.pricing.valuationProduct).toBe("2500000000");
    expect(result.observation?.points).toMatchObject({ totalCents: 25, availableCents: 0, deficitCents: 15, walletCents: 40, heldCents: 10 });
  });
  it("FX rebound restores at most the original ceiling and never revalues historical consumed cents", () => {
    const value = fixture(); value.liabilities.consumedCents = 20;
    value.liabilities.wallets[0].balanceCents = value.liabilities.wallets[0].ledgerBalanceCents = 20;
    value.pricing.fx.rate = "0.5"; const reduced = evaluateSharedWalletSource(value); expect(reduced.ready).toBe(true);
    if (reduced.ready) expect(reduced.quote.points).toMatchObject({ totalCents: 50, consumedCents: 20, availableCents: 10 });
    value.pricing.fx.rate = "2"; const rebound = evaluateSharedWalletSource(value); expect(rebound.ready).toBe(true);
    if (rebound.ready) expect(rebound.quote.points).toMatchObject({ totalCents: 100, consumedCents: 20, availableCents: 60 });
    expect(value.policy.frozenValuationProduct).toBe("10000000000"); expect(value.liabilities.accountedUsd).toBe("0");
  });
  it("an active hold below the rebound effective floor remains unproven without changing its price", () => {
    const value = fixture(); value.pricing.fx.rate = "0.5"; value.liabilities.holds[0].fxRate = "0.5";
    expect(evaluateSharedWalletSource(value).ready).toBe(true);
    value.pricing.fx.rate = "1"; const result = evaluateSharedWalletSource(value);
    expect(result.ready).toBe(false); if (!result.ready) expect(result.blockedReasons.map(row => row.code)).toContain("HOLD_PRICE_UNPROVEN");
    expect(value.liabilities.holds[0].fxRate).toBe("0.5");
  });
  it("multiple holds aggregate against their own wallet", () => { const value = fixture(); value.liabilities.wallets[0].balanceCents = value.liabilities.wallets[0].ledgerBalanceCents = 10; value.liabilities.wallets.push({ userId: "other", balanceCents: 20, ledgerBalanceCents: 20 }); value.liabilities.holds = [{ ...value.liabilities.holds[0], heldCents: 7 }, { ...value.liabilities.holds[0], eventId: "h2", heldCents: 7 }]; expect(evaluateSharedWalletSource(value).ready).toBe(false); });
  it("historical/unmatched add-back cannot exist with C=0", () => { const value = fixture(); value.liabilities.accountedUsd = "50"; expect(evaluateSharedWalletSource(value).ready).toBe(false); });
  it("stale reading cannot authorize new gifts", () => { const value = fixture(); value.now = "2026-10-09T00:00:30.001Z"; expect(evaluateSharedWalletSource(value).ready).toBe(false); });
  it("changed source binding cannot reuse approval", () => { const value = fixture(); value.binding.credentialFingerprint = "b".repeat(64); expect(evaluateSharedWalletSource(value).ready).toBe(false); });
  it("unobservable commitments are not numeric zero assertions", () => { const value = fixture(); value.externalCommitments = { state: "unobservable", amountUsd: "0", evidenceHash: hash } as never; expect(evaluateSharedWalletSource(value).ready).toBe(false); });
});
