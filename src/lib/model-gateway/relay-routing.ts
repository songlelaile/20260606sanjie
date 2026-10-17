export type RelayShopPurpose = "default" | "image";

export type RelayShopKey = {
  shopName: string;
  purpose: RelayShopPurpose;
  apiKey: string;
};

export function selectRelayApiKey(input: {
  platformKey: string;
  shopKeys?: RelayShopKey[];
  shopName?: string;
  kind: "chat" | "image" | "video" | "unknown";
}) {
  const shopName = input.shopName?.trim() || "";
  const keys = input.shopKeys || [];
  if (shopName && input.kind === "image") {
    const image = keys.find((item) => item.shopName === shopName && item.purpose === "image" && item.apiKey);
    if (image) return image.apiKey;
  }
  if (shopName) {
    const shop = keys.find((item) => item.shopName === shopName && item.purpose === "default" && item.apiKey);
    if (shop) return shop.apiKey;
  }
  return input.platformKey;
}

/** Sub2API records dollars internally. Only an explicit usage cost is accepted. */
export function parseUpstreamUsdCost(data: unknown) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const usage = (data as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  for (const key of ["actual_cost", "cost"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000) return value;
  }
  return null;
}

export function usdToCnyCents(usd: number, cnyPerUsd: number) {
  if (!Number.isFinite(usd) || usd < 0 || usd > 1_000_000) return null;
  if (!Number.isFinite(cnyPerUsd) || cnyPerUsd <= 0 || cnyPerUsd > 1_000) return null;
  const micro = BigInt(Math.round(usd * 100_000_000));
  const rate = BigInt(Math.round(cnyPerUsd * 1_000_000));
  const cents = (micro * rate + 999_999_999_999n) / 1_000_000_000_000n;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(cents);
}

export function formatUsd(value: number) {
  return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}
