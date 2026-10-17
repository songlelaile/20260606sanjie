import { createHash } from 'node:crypto';

const TOKEN = Symbol('number');
const MAX_BYTES = 65_536;
export class SharedWalletSourceError extends Error {
  constructor(code) { super(code); this.name = 'SharedWalletSourceError'; this.code = code; }
}
const fail = code => { throw new SharedWalletSourceError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !value[TOKEN];

/** Preserve JSON number lexemes and reject duplicate keys before parsing money. */
function exactJson(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) fail('SOURCE_RESPONSE_TOO_LARGE');
  let cursor = 0, tokens = 0;
  const whitespace = () => { while (cursor < text.length && /[\x20\t\r\n]/.test(text[cursor])) cursor++; };
  const string = () => {
    const start = cursor++;
    let escaped = false;
    while (cursor < text.length) {
      const char = text[cursor++];
      if (!escaped && char === '"') {
        try { return JSON.parse(text.slice(start, cursor)); } catch { fail('SOURCE_JSON_INVALID'); }
      }
      if (!escaped && char === '\\') escaped = true; else escaped = false;
    }
    fail('SOURCE_JSON_INVALID');
  };
  const value = depth => {
    if (depth > 32 || ++tokens > 10_000) fail('SOURCE_JSON_INVALID');
    whitespace(); const char = text[cursor];
    if (char === '"') return string();
    if (char === '{') {
      cursor++; whitespace(); const result = Object.create(null);
      if (text[cursor] === '}') { cursor++; return result; }
      while (true) {
        whitespace(); if (text[cursor] !== '"') fail('SOURCE_JSON_INVALID');
        const key = string(); if (Object.hasOwn(result, key)) fail('SOURCE_JSON_DUPLICATE_KEY');
        whitespace(); if (text[cursor++] !== ':') fail('SOURCE_JSON_INVALID');
        result[key] = value(depth + 1); whitespace();
        const end = text[cursor++]; if (end === '}') return result;
        if (end !== ',') fail('SOURCE_JSON_INVALID');
      }
    }
    if (char === '[') {
      cursor++; whitespace(); const result = [];
      if (text[cursor] === ']') { cursor++; return result; }
      while (true) {
        result.push(value(depth + 1)); whitespace(); const end = text[cursor++];
        if (end === ']') return result; if (end !== ',') fail('SOURCE_JSON_INVALID');
      }
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, cursor)) { cursor += literal.length; return result; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(cursor));
    if (!number) fail('SOURCE_JSON_INVALID');
    cursor += number[0].length; return { [TOKEN]: true, raw: number[0] };
  };
  const parsed = value(0); whitespace(); if (cursor !== text.length) fail('SOURCE_JSON_INVALID');
  return parsed;
}
function usd(value) {
  if (!value?.[TOKEN] || value.raw.length > 96 || !/^(0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value.raw)) fail('SOURCE_USD_INVALID');
  const [whole, fraction = ''] = value.raw.split('.');
  const fixed8 = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
  const significant = fraction.replace(/0+$/, '');
  return { raw: value.raw, decimal: whole + (significant ? `.${significant}` : ''), fixed8: fixed8.toString() };
}
/** Only the approved unrestricted posted owner wallet is a source; quotas/subscriptions are different contracts. */
export function parseSharedWalletUsage(rawBody) {
  const row = exactJson(rawBody);
  if (!object(row) || row.isValid !== true || row.mode !== 'unrestricted' || row.unit !== 'USD' ||
      row.quota !== undefined || row.subscription !== undefined || row.expires_at !== undefined && row.expires_at !== null ||
      row.rate_limits !== undefined && (!Array.isArray(row.rate_limits) || row.rate_limits.length !== 0) ||
      row.status !== undefined && row.status !== 'active') fail('SOURCE_WALLET_SCOPE_CHANGED');
  const balance = usd(row.balance), remaining = usd(row.remaining);
  if (balance.fixed8 !== remaining.fixed8) fail('SOURCE_BALANCE_INCONSISTENT');
  return { mode: 'unrestricted', isValid: true, nativeUnit: 'USD', balanceUsd: balance.decimal,
    remainingUsd: remaining.decimal, balanceRaw: balance.raw, remainingRaw: remaining.raw,
    postedBalanceUsdUnits: balance.fixed8, responseHash: createHash('sha256').update(rawBody).digest('hex') };
}
/** Exact per-request actual USD only. Catalog/usage.cost aliases and rounded JS numbers cannot settle shared supply. */
export function parseExactSharedUpstreamCost(rawJson) {
  try {
    const root = exactJson(rawJson);
    if (!object(root)) return null;
    const fields = [];
    if (root.actual_cost !== undefined) fields.push({ field: 'actual_cost', value: root.actual_cost });
    if (object(root.usage) && root.usage.actual_cost !== undefined) fields.push({ field: 'usage.actual_cost', value: root.usage.actual_cost });
    if (!fields.length) return null;
    const parsed = fields.map(item => ({ ...item, amount: usd(item.value) }));
    if (parsed.some(item => item.amount.fixed8 !== parsed[0].amount.fixed8)) return null;
    return { usdCostLexical: parsed[0].amount.raw, upstreamCostField: parsed[0].field };
  } catch { return null; }
}
