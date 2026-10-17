export class SharedWalletSourceError extends Error { code: string; constructor(code: string); }
export type SharedWalletUsage = { mode: 'unrestricted'; isValid: true; nativeUnit: 'USD'; balanceUsd: string;
  remainingUsd: string; balanceRaw: string; remainingRaw: string; postedBalanceUsdUnits: string; responseHash: string };
export function parseSharedWalletUsage(rawBody: string): SharedWalletUsage;
export function parseExactSharedUpstreamCost(rawJson: string): { usdCostLexical: string; upstreamCostField: 'usage.actual_cost' | 'actual_cost' } | null;
