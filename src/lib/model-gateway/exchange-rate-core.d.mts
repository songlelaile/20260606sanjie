export interface FxCache {
  version: 1;
  source: 'ecb';
  sourceUrl: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
  base: 'USD';
  quote: 'CNY';
  rate: number;
  referenceDate: string;
  fetchedAt: string;
  eurUsd: string;
  eurCny: string;
  xmlSha256: string;
  id: string;
}
export const ECB_SOURCE_URL: FxCache['sourceUrl'];
export const FX_CACHE_MAX_AGE_MS: number;
export const FX_REFERENCE_MAX_AGE_DAYS: number;
export const FX_XML_MAX_BYTES: number;
export function parseEcbXml(xml: string, now?: Date | number): FxCache;
export function validateFxCache(raw: unknown, now?: Date | number, options?: { allowExpired?: boolean }): FxCache;
export function fxCacheId(cache: Omit<FxCache, 'id' | 'fetchedAt'> | FxCache): string;
