import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEcbXml, validateFxCache, fxCacheId, FX_CACHE_MAX_AGE_MS, FX_REFERENCE_MAX_AGE_DAYS } from './exchange-rate-core.mjs';

const XML = readFileSync(new URL('../../../scripts/fixtures/ecb-daily.xml', import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-03T00:05:00.000Z');
const parsed = () => parseEcbXml(XML, NOW);
const edit = changes => { const cache = { ...parsed(), ...changes }; cache.id = fxCacheId(cache); return cache; };
const rejects = (operation, code) => assert.throws(operation, e => e.code === code);

test('official ECB shape yields exact six-decimal USD/CNY cross with complete strict cache', () => {
  const cache = parsed(); assert.equal(cache.rate, 6.704588); assert.equal(cache.referenceDate, '2026-10-02');
  assert.equal(cache.fetchedAt, '2026-10-03T00:05:00.000Z'); assert.equal(cache.id, fxCacheId(cache));
  assert.equal(Object.keys(cache).length, 12); assert.equal(Object.isFrozen(cache), true);
  assert.deepEqual(validateFxCache(JSON.parse(JSON.stringify(cache)), NOW), cache);
});
test('identity excludes fetch time and includes same-date corrections/raw XML', () => {
  const cache = parsed(); assert.equal(fxCacheId({ ...cache, fetchedAt: '2026-10-03T00:06:00.000Z' }), cache.id);
  assert.notEqual(parseEcbXml(XML.replace("rate='7.5259'", "rate='7.5260'"), NOW).id, cache.id);
  assert.notEqual(parseEcbXml(XML.replace('\n', '\n\n'), NOW).id, cache.id);
});
test('cross uses rational half-up rounding rather than binary float or inverse rate', () => {
  const xml = XML.replace("rate='1.1225'", "rate='2.0'").replace("rate='7.5259'", "rate='13.000001'");
  assert.equal(parseEcbXml(xml, NOW).rate, 6.500001);
  rejects(() => validateFxCache({ ...parsed(), rate: 1 / parsed().rate }, NOW), 'FX_CACHE_RATE_INVALID');
});
test('cache fetched age boundary is exactly 72 hours', () => {
  const cache = parsed(); assert.equal(FX_CACHE_MAX_AGE_MS, 72 * 3600000);
  assert.equal(validateFxCache(cache, NOW + FX_CACHE_MAX_AGE_MS).id, cache.id);
  rejects(() => validateFxCache(cache, NOW + FX_CACHE_MAX_AGE_MS + 1), 'FX_CACHE_EXPIRED');
  assert.equal(validateFxCache(cache, NOW + FX_CACHE_MAX_AGE_MS + 1, { allowExpired: true }).id, cache.id);
});
test('reference age uses UTC calendar day, not fetch time or local timezone', () => {
  assert.equal(FX_REFERENCE_MAX_AGE_DAYS, 7);
  const cache = edit({ referenceDate: '2026-09-26' });
  assert.equal(validateFxCache(cache, Date.parse('2026-10-03T23:59:59.999Z')).referenceDate, '2026-09-26');
  rejects(() => validateFxCache(cache, Date.parse('2026-10-04T00:00:00.000Z')), 'FX_REFERENCE_EXPIRED');
  const future = edit({ referenceDate: '2026-10-04' });
  rejects(() => validateFxCache(future, NOW, { allowExpired: true }), 'FX_REFERENCE_FUTURE');
});
test('future fetched skew allows at most five minutes and expired mode never bypasses future', () => {
  assert.equal(validateFxCache(edit({ fetchedAt: new Date(NOW + 300000).toISOString() }), NOW).rate, 6.704588);
  rejects(() => validateFxCache(edit({ fetchedAt: new Date(NOW + 300001).toISOString() }), NOW, { allowExpired: true }), 'FX_FETCHED_AT_FUTURE');
});
test('invalid Gregorian dates and non-UTC or normalized timestamps are rejected', () => {
  for (const value of ['2026-02-29', '2026-13-01', '2026-2-01', '2026-01-32']) rejects(() => validateFxCache(edit({ referenceDate: value }), NOW), 'FX_REFERENCE_DATE_INVALID');
  for (const value of ['2026-10-03T08:05:00+08:00', '2026-10-03T24:00:00.000Z', '2026-02-29T00:00:00Z', '2026-10-03']) rejects(() => validateFxCache(edit({ fetchedAt: value }), NOW), 'FX_FETCHED_AT_INVALID');
  assert.equal(validateFxCache(edit({ fetchedAt: '2026-10-03T00:05:00Z' }), NOW).rate, 6.704588);
});
test('strict cache rejects unknown/missing keys, accessors, prototype and hash tampering', () => {
  rejects(() => validateFxCache({ ...parsed(), token: 'forbidden' }, NOW), 'FX_CACHE_FIELDS_INVALID');
  const missing = { ...parsed() }; delete missing.quote; rejects(() => validateFxCache(missing, NOW), 'FX_CACHE_FIELDS_INVALID');
  const accessor = { ...parsed() }; Object.defineProperty(accessor, 'rate', { get: () => 6.704588, enumerable: true }); rejects(() => validateFxCache(accessor, NOW), 'FX_CACHE_FORMAT_INVALID');
  rejects(() => validateFxCache(Object.assign(Object.create({ hidden: true }), parsed()), NOW), 'FX_CACHE_FORMAT_INVALID');
  rejects(() => validateFxCache({ ...parsed(), id: '0'.repeat(64) }, NOW), 'FX_CACHE_ID_INVALID');
  rejects(() => validateFxCache(edit({ xmlSha256: 'A'.repeat(64) }), NOW), 'FX_CACHE_HASH_INVALID');
  rejects(() => validateFxCache(edit({ sourceUrl: 'https://attacker.invalid/' }), NOW), 'FX_CACHE_SOURCE_INVALID');
});
test('ECB parser rejects DTD/entities, extras, multiple dates and duplicate currencies', () => {
  rejects(() => parseEcbXml('<!DOCTYPE x>' + XML, NOW), 'FX_XML_DTD_ENTITY_REFUSED');
  rejects(() => parseEcbXml(XML.replace('Reference rates', '&evil;'), NOW), 'FX_XML_STRUCTURE_INVALID');
  rejects(() => parseEcbXml(XML.replace('</gesmes:Envelope>', '<extra/></gesmes:Envelope>'), NOW), 'FX_XML_STRUCTURE_INVALID');
  rejects(() => parseEcbXml(XML.replace("<Cube time='2026-10-02'>", "<Cube time='2026-10-02'><Cube time='2026-10-01'>"), NOW), 'FX_XML_STRUCTURE_INVALID');
  rejects(() => parseEcbXml(XML.replace("<Cube currency='USD' rate='1.1225'/>", "<Cube currency='USD' rate='1.1225'/><Cube currency='USD' rate='1.1225'/>"), NOW), 'FX_XML_DUPLICATE_CURRENCY');
  rejects(() => parseEcbXml(XML.replace("currency='CNY'", "currency='XXX'"), NOW), 'FX_XML_REQUIRED_CURRENCY_MISSING');
});
test('XML rejects foreign namespace, duplicate attribute, non-number and byte oversize', () => {
  rejects(() => parseEcbXml(XML.replace('http://www.ecb.int/vocabulary/', 'https://evil.invalid/'), NOW), 'FX_XML_NAMESPACE_INVALID');
  rejects(() => parseEcbXml(XML.replace("currency='USD'", "currency='USD' currency='USD'"), NOW), 'FX_XML_DUPLICATE_ATTRIBUTE');
  for (const value of ['NaN', 'Infinity', '1e3', '-1', '0', '1,22', ' 1.2', '01.2']) rejects(() => parseEcbXml(XML.replace("rate='1.1225'", `rate='${value}'`), NOW), 'FX_EUR_RATE_INVALID');
  rejects(() => parseEcbXml(XML.replace("rate='1.1225'", "rate='&amp;1'"), NOW), 'FX_XML_ATTRIBUTES_INVALID');
  rejects(() => parseEcbXml(XML + '中'.repeat(22000), NOW), 'FX_XML_SIZE_INVALID');
  rejects(() => parseEcbXml(XML, Number.NaN), 'FX_NOW_INVALID');
});
