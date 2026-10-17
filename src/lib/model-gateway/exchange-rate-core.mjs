import { createHash } from 'node:crypto';

export const ECB_SOURCE_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
export const FX_CACHE_MAX_AGE_MS = 72 * 60 * 60 * 1000;
export const FX_REFERENCE_MAX_AGE_DAYS = 7;
export const FX_XML_MAX_BYTES = 64 * 1024;
const DAY_MS = 86400000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const KEYS = ['version', 'source', 'sourceUrl', 'base', 'quote', 'rate', 'referenceDate', 'fetchedAt', 'eurUsd', 'eurCny', 'xmlSha256', 'id'];
const HASH = /^[a-f0-9]{64}$/;
const DECIMAL = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,12})?$/;

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function need(value, code) { if (!value) fail(code); }
function instant(now = new Date()) {
  const value = now instanceof Date ? now.getTime() : now;
  need(typeof value === 'number' && Number.isFinite(value) && Number.isFinite(new Date(value).getTime()), 'FX_NOW_INVALID');
  return value;
}
function referenceTime(value) {
  need(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'FX_REFERENCE_DATE_INVALID');
  const timestamp = Date.parse(value + 'T00:00:00.000Z');
  need(Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value, 'FX_REFERENCE_DATE_INVALID');
  return timestamp;
}
function fetchedTime(value) {
  need(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value), 'FX_FETCHED_AT_INVALID');
  const timestamp = Date.parse(value);
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  need(Number.isFinite(timestamp) && new Date(timestamp).toISOString() === canonical, 'FX_FETCHED_AT_INVALID');
  return timestamp;
}
function decimal(value) {
  need(typeof value === 'string' && DECIMAL.test(value), 'FX_EUR_RATE_INVALID');
  const [whole, fraction = ''] = value.split('.');
  const numerator = BigInt(whole + fraction);
  need(numerator > 0n, 'FX_EUR_RATE_INVALID');
  return { numerator, denominator: 10n ** BigInt(fraction.length) };
}
function crossRate(eurUsd, eurCny) {
  const usd = decimal(eurUsd), cny = decimal(eurCny);
  const numerator = cny.numerator * usd.denominator * 1000000n;
  const denominator = cny.denominator * usd.numerator;
  const quotient = numerator / denominator;
  const rounded = quotient + (numerator % denominator * 2n >= denominator ? 1n : 0n);
  need(rounded > 0n && rounded <= BigInt(Number.MAX_SAFE_INTEGER), 'FX_CROSS_RATE_INVALID');
  return Number(rounded) / 1000000;
}

// Stable identity excludes fetch time: same reference date may be republished.
export function fxCacheId(cache) {
  return createHash('sha256').update(JSON.stringify({
    version: cache.version, source: cache.source, sourceUrl: cache.sourceUrl,
    base: cache.base, quote: cache.quote, rate: cache.rate,
    referenceDate: cache.referenceDate, eurUsd: cache.eurUsd,
    eurCny: cache.eurCny, xmlSha256: cache.xmlSha256,
  })).digest('hex');
}

export function validateFxCache(raw, now = new Date(), { allowExpired = false } = {}) {
  const nowMs = instant(now);
  need(typeof allowExpired === 'boolean', 'FX_CACHE_OPTIONS_INVALID');
  need(raw && typeof raw === 'object' && !Array.isArray(raw), 'FX_CACHE_FORMAT_INVALID');
  const prototype = Object.getPrototypeOf(raw);
  need(prototype === Object.prototype || prototype === null, 'FX_CACHE_FORMAT_INVALID');
  const keys = Reflect.ownKeys(raw);
  need(keys.length === KEYS.length && keys.every(key => KEYS.includes(key)) && KEYS.every(key => Object.hasOwn(raw, key)), 'FX_CACHE_FIELDS_INVALID');
  need(KEYS.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(raw, key), 'value')), 'FX_CACHE_FORMAT_INVALID');
  need(raw.version === 1 && raw.source === 'ecb' && raw.sourceUrl === ECB_SOURCE_URL && raw.base === 'USD' && raw.quote === 'CNY', 'FX_CACHE_SOURCE_INVALID');
  need(typeof raw.rate === 'number' && Number.isFinite(raw.rate) && raw.rate > 0 && raw.rate === crossRate(raw.eurUsd, raw.eurCny), 'FX_CACHE_RATE_INVALID');
  need(typeof raw.xmlSha256 === 'string' && HASH.test(raw.xmlSha256) && typeof raw.id === 'string' && HASH.test(raw.id), 'FX_CACHE_HASH_INVALID');
  const refMs = referenceTime(raw.referenceDate), fetchedMs = fetchedTime(raw.fetchedAt);
  const todayMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
  need(refMs <= todayMs, 'FX_REFERENCE_FUTURE');
  need(fetchedMs <= nowMs + FUTURE_SKEW_MS, 'FX_FETCHED_AT_FUTURE');
  need(raw.id === fxCacheId(raw), 'FX_CACHE_ID_INVALID');
  if (!allowExpired) {
    need(nowMs - fetchedMs <= FX_CACHE_MAX_AGE_MS, 'FX_CACHE_EXPIRED');
    need(todayMs - refMs <= FX_REFERENCE_MAX_AGE_DAYS * DAY_MS, 'FX_REFERENCE_EXPIRED');
  }
  return Object.freeze(Object.fromEntries(KEYS.map(key => [key, raw[key]])));
}

function attributes(input) {
  const attrs = Object.create(null);
  let remaining = input;
  while (remaining.trim()) {
    const match = /^\s+([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(['"])([^<&]*?)\2/.exec(remaining);
    need(match, 'FX_XML_ATTRIBUTES_INVALID');
    need(!Object.hasOwn(attrs, match[1]), 'FX_XML_DUPLICATE_ATTRIBUTE');
    attrs[match[1]] = match[3]; remaining = remaining.slice(match[0].length);
  }
  return attrs;
}
function exactAttributes(attrs, names) {
  need(Object.keys(attrs).length === names.length && names.every(name => Object.hasOwn(attrs, name)), 'FX_XML_ATTRIBUTES_INVALID');
}

export function parseEcbXml(xml, now = new Date()) {
  const nowMs = instant(now);
  need(typeof xml === 'string' && Buffer.byteLength(xml, 'utf8') <= FX_XML_MAX_BYTES, 'FX_XML_SIZE_INVALID');
  need(!/<!DOCTYPE|<!ENTITY/i.test(xml), 'FX_XML_DTD_ENTITY_REFUSED');
  const envelope = /^\s*(?:<\?xml\s+version=['"]1\.0['"]\s+encoding=['"]UTF-8['"]\s*\?>\s*)?<gesmes:Envelope([^>]*)>\s*<gesmes:subject>Reference rates<\/gesmes:subject>\s*<gesmes:Sender>\s*<gesmes:name>European Central Bank<\/gesmes:name>\s*<\/gesmes:Sender>\s*<Cube>\s*<Cube([^>]*)>([\s\S]*?)<\/Cube>\s*<\/Cube>\s*<\/gesmes:Envelope>\s*$/.exec(xml);
  need(envelope, 'FX_XML_STRUCTURE_INVALID');
  const rootAttrs = attributes(envelope[1]); exactAttributes(rootAttrs, ['xmlns:gesmes', 'xmlns']);
  need(rootAttrs['xmlns:gesmes'] === 'http://www.gesmes.org/xml/2002-08-01' && rootAttrs.xmlns === 'http://www.ecb.int/vocabulary/2002-08-01/eurofxref', 'FX_XML_NAMESPACE_INVALID');
  const dateAttrs = attributes(envelope[2]); exactAttributes(dateAttrs, ['time']);
  let remaining = envelope[3]; const rates = new Map();
  while (remaining.trim()) {
    const row = /^\s*<Cube([^>]*)\/>/.exec(remaining); need(row, 'FX_XML_STRUCTURE_INVALID');
    const attrs = attributes(row[1]); exactAttributes(attrs, ['currency', 'rate']);
    need(/^[A-Z]{3}$/.test(attrs.currency), 'FX_XML_CURRENCY_INVALID');
    decimal(attrs.rate); need(!rates.has(attrs.currency), 'FX_XML_DUPLICATE_CURRENCY');
    rates.set(attrs.currency, attrs.rate); remaining = remaining.slice(row[0].length);
  }
  need(rates.has('USD') && rates.has('CNY'), 'FX_XML_REQUIRED_CURRENCY_MISSING');
  const cache = {
    version: 1, source: 'ecb', sourceUrl: ECB_SOURCE_URL, base: 'USD', quote: 'CNY',
    rate: crossRate(rates.get('USD'), rates.get('CNY')), referenceDate: dateAttrs.time,
    fetchedAt: new Date(nowMs).toISOString(), eurUsd: rates.get('USD'), eurCny: rates.get('CNY'),
    xmlSha256: createHash('sha256').update(xml, 'utf8').digest('hex'),
  };
  cache.id = fxCacheId(cache);
  return validateFxCache(cache, nowMs);
}
