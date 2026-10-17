import { isCreditPoolManagementOverview, type CreditPoolManagementOverview } from "./credit-pool-management-contract";

/** Observations are display-only facts, never funding, allocation or settlement proof. */
export type RelayGroupObservation = {
  groupId: string;
  name: string | null;
  platform: string | null;
  status: string | null;
  accountCount: number | null;
  activeAccountCount: number | null;
  usage: { todayCost: string | null; yesterdayCost: string | null; totalCost: string | null; unit: "relay_reported_cost" } | null;
  capacity: { concurrencyUsed: number | null; concurrencyMax: number | null; sessionsUsed: number | null;
    sessionsMax: number | null; rpmUsed: number | null; rpmMax: number | null } | null;
};
export type RelaySupplyObservation = {
  status: "ok" | "partial" | "not_configured" | "unavailable";
  observedAt: string | null;
  groups: RelayGroupObservation[];
  code: string | null;
  referenceOnly: true;
};
export type CreditPoolObservation = {
  observedAt: string;
  readOnly: true;
  wallet: {
    status: "ok" | "unavailable";
    balanceUsd: string | null;
    remainingUsd: string | null;
    observedAt: string | null;
    unit: "USD";
    scope: "sub2api_internal_user_wallet";
    code: string | null;
  };
  ledger: { status: "ok" | "unavailable"; overview: CreditPoolManagementOverview | null; code: string | null };
  supply: RelaySupplyObservation;
};

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join() === keys.sort().join();
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const usd = (value: unknown): value is string => typeof value === "string" && value.length <= 96 && /^(0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value);
const count = (value: unknown) => value === null || Number.isSafeInteger(value) && Number(value) >= 0;
const code = (value: unknown) => value === null || typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value);
const label = (value: unknown) => value === null || typeof value === "string" && value.length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f@]/.test(value);
export function isRelaySupplyObservation(value: unknown): value is RelaySupplyObservation {
  if (!object(value) || !exact(value, ["status", "observedAt", "groups", "code", "referenceOnly"]) || value.referenceOnly !== true ||
    !["ok", "partial", "not_configured", "unavailable"].includes(value.status as string) || !code(value.code) || !Array.isArray(value.groups) || value.groups.length > 100) return false;
  if (["ok", "partial"].includes(value.status as string) ? !instant(value.observedAt) : value.observedAt !== null || value.groups.length !== 0) return false;
  if (value.status === "ok" ? value.code !== null : value.code === null) return false;
  const ids = new Set<string>();
  for (const group of value.groups) {
    if (!object(group) || !exact(group, ["groupId", "name", "platform", "status", "accountCount", "activeAccountCount", "usage", "capacity"]) ||
      typeof group.groupId !== "string" || !/^[1-9]\d{0,15}$/.test(group.groupId) || ids.has(group.groupId) || !label(group.name) || !label(group.platform) || !label(group.status) ||
      !count(group.accountCount) || !count(group.activeAccountCount) || group.accountCount !== null && group.activeAccountCount !== null && Number(group.activeAccountCount) > Number(group.accountCount)) return false;
    ids.add(group.groupId);
    if (group.usage !== null && (!object(group.usage) || !exact(group.usage, ["todayCost", "yesterdayCost", "totalCost", "unit"]) || group.usage.unit !== "relay_reported_cost" ||
      [group.usage.todayCost, group.usage.yesterdayCost, group.usage.totalCost].some(value => value !== null && !usd(value)))) return false;
    if (group.capacity !== null && (!object(group.capacity) || !exact(group.capacity, ["concurrencyUsed", "concurrencyMax", "sessionsUsed", "sessionsMax", "rpmUsed", "rpmMax"]) ||
      Object.values(group.capacity).some(value => !count(value)))) return false;
  }
  return true;
}
export function isCreditPoolWalletObservation(wallet: unknown): wallet is CreditPoolObservation["wallet"] {
  if (!object(wallet) || !exact(wallet, ["status", "balanceUsd", "remainingUsd", "observedAt", "unit", "scope", "code"]) ||
    wallet.unit !== "USD" || wallet.scope !== "sub2api_internal_user_wallet" || !code(wallet.code)) return false;
  if (wallet.status === "ok") {
    if (!usd(wallet.balanceUsd) || !usd(wallet.remainingUsd) || wallet.balanceUsd !== wallet.remainingUsd || !instant(wallet.observedAt) || wallet.code !== null) return false;
  } else if (wallet.status !== "unavailable" || wallet.balanceUsd !== null || wallet.remainingUsd !== null || wallet.observedAt !== null || wallet.code === null) return false;
  return true;
}
export function isCreditPoolObservation(value: unknown): value is CreditPoolObservation {
  if (!object(value) || !exact(value, ["observedAt", "readOnly", "wallet", "ledger", "supply"]) || value.readOnly !== true || !instant(value.observedAt) || !isCreditPoolWalletObservation(value.wallet)) return false;
  const { ledger } = value;
  if (!object(ledger) || !exact(ledger, ["status", "overview", "code"]) || !code(ledger.code)) return false;
  if (ledger.status === "ok" ? ledger.code !== null || !isCreditPoolManagementOverview(ledger.overview) : ledger.status !== "unavailable" || ledger.overview !== null || ledger.code === null) return false;
  return isRelaySupplyObservation(value.supply);
}
