import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { parseEcbXml, validateFxCache, fxCacheId } from '../src/lib/model-gateway/exchange-rate-core.mjs';
import { updateGatewayExchangeRate, fetchEcbXml } from './update-gateway-exchange-rate.mjs';

const XML = await fs.readFile(new URL('./fixtures/ecb-daily.xml', import.meta.url), 'utf8');
const TIME = Date.parse('2026-10-03T00:05:00.000Z');
const now = () => new Date(TIME);
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-fx-node-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cacheFile = path.join(directory, 'usd-cny.json');
  return { directory, cacheFile, statusFile: cacheFile + '.status.json' };
}
const successfulFetch = async () => ({ xml: XML, receipt: { sourceUrl: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml', status: 200, redirects: 0, contentType: 'text/xml', bodyBytes: Buffer.byteLength(XML) } });
async function save(file, cache) { await fs.writeFile(file, JSON.stringify(cache) + '\n'); return fs.readFile(file); }

test('successful update durably publishes validated cache and matching status, without temporary files', async t => {
  const f = await fixture(t); const result = await updateGatewayExchangeRate({ cacheFile: f.cacheFile, now }, { fetchXml: successfulFetch });
  assert.equal(result.ok, true); assert.equal(result.cacheWritten, true); assert.equal(result.statusWritten, true);
  const cache = validateFxCache(JSON.parse(await fs.readFile(f.cacheFile, 'utf8')), TIME); const status = JSON.parse(await fs.readFile(f.statusFile, 'utf8'));
  assert.deepEqual(status, { version: 1, cacheId: cache.id, fetchedAt: cache.fetchedAt, attemptedAt: cache.fetchedAt, success: true });
  assert.equal((await fs.stat(f.cacheFile)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['usd-cny.json', 'usd-cny.json.status.json']);
});
test('network failure preserves last-good bytes and fetch timestamp and writes safe failure status', async t => {
  const f = await fixture(t); const old = parseEcbXml(XML, TIME - 86400000); const before = await save(f.cacheFile, old);
  const result = await updateGatewayExchangeRate({ cacheFile: f.cacheFile, now }, { fetchXml: async () => { const e = new Error('never export response body or secret'); e.code = 'FX_FETCH_NETWORK_FAILED'; throw e; } });
  assert.equal(result.ok, false); assert.equal(result.cachePreserved, true); assert.deepEqual(await fs.readFile(f.cacheFile), before);
  const status = JSON.parse(await fs.readFile(f.statusFile, 'utf8')); assert.equal(status.cacheId, old.id); assert.equal(status.fetchedAt, old.fetchedAt); assert.equal(status.attemptedAt, now().toISOString()); assert.equal(status.success, false); assert.equal(status.errorCode, 'FX_FETCH_FAILED');
  assert.equal(JSON.stringify(status).includes('secret'), false);
});
test('expired but structurally valid old cache can be refreshed; corrupt old cache fails closed', async t => {
  const f = await fixture(t); const old = { ...parseEcbXml(XML, TIME), referenceDate: '2026-09-01', fetchedAt: '2026-09-01T00:05:00.000Z' }; old.id = fxCacheId(old); await save(f.cacheFile, old);
  assert.equal((await updateGatewayExchangeRate({ cacheFile: f.cacheFile, now }, { fetchXml: successfulFetch })).ok, true);
  const corrupt = Buffer.from('{"corrupt":true}\n'); await fs.writeFile(f.cacheFile, corrupt);
  let fetched = false; const result = await updateGatewayExchangeRate({ cacheFile: f.cacheFile, now }, { fetchXml: async () => { fetched = true; return successfulFetch(); } });
  assert.equal(result.ok, false); assert.equal(fetched, false); assert.deepEqual(await fs.readFile(f.cacheFile), corrupt);
});
test('source-date rollback and same-date earlier fetch cannot overwrite latest successful cache', async t => {
  const f = await fixture(t); let old = parseEcbXml(XML, TIME); let before = await save(f.cacheFile, old);
  const result = await updateGatewayExchangeRate({ cacheFile: f.cacheFile, now }, { fetchXml: async () => ({ xml: XML.replace('2026-10-02', '2026-10-01') }) });
  assert.equal(result.code, 'FX_REFERENCE_DATE_ROLLBACK'); assert.deepEqual(await fs.readFile(f.cacheFile), before);
  old = { ...old, fetchedAt: new Date(TIME + 60000).toISOString() }; before = await save(f.cacheFile, old);
  const earlier = await updateGatewayExchangeRate({ cacheFile: f.cacheFile, now }, { fetchXml: successfulFetch });
  assert.equal(earlier.code, 'FX_FETCHED_AT_ROLLBACK'); assert.deepEqual(await fs.readFile(f.cacheFile), before);
});
test('same-date republication changes identity and successful same data updates fetchedAt only', async t => {
  const f = await fixture(t); const old = parseEcbXml(XML, TIME - 60000); await save(f.cacheFile, old);
  const result = await updateGatewayExchangeRate({ cacheFile: f.cacheFile, now }, { fetchXml: successfulFetch }); assert.equal(result.cacheId, old.id); assert.notEqual(result.fetchedAt, old.fetchedAt);
  const changed = await updateGatewayExchangeRate({ cacheFile: f.cacheFile, now }, { fetchXml: async () => ({ xml: XML.replace("rate='7.5259'", "rate='7.5260'") }) }); assert.equal(changed.ok, true); assert.notEqual(changed.cacheId, old.id);
});
test('malformed XML, oversized data and invalid future source preserve existing cache', async t => {
  const f = await fixture(t); const before = await save(f.cacheFile, parseEcbXml(XML, TIME));
  for (const xml of ['<html>bad</html>', XML + 'a'.repeat(65536), XML.replace('2026-10-02', '2026-10-04')]) {
    const result = await updateGatewayExchangeRate({ cacheFile: f.cacheFile, now }, { fetchXml: async () => ({ xml }) }); assert.equal(result.ok, false); assert.deepEqual(await fs.readFile(f.cacheFile), before);
  }
});
test('symlink cache and status paths are refused before publishing', async t => {
  const f = await fixture(t); const target = path.join(f.directory, 'original'); const original = await save(target, parseEcbXml(XML, TIME)); await fs.symlink(target, f.cacheFile);
  assert.equal((await updateGatewayExchangeRate({ cacheFile: f.cacheFile, now }, { fetchXml: successfulFetch })).ok, false); assert.deepEqual(await fs.readFile(target), original);
  await fs.unlink(f.cacheFile); const before = await save(f.cacheFile, parseEcbXml(XML, TIME - 60000)); await fs.unlink(f.statusFile); await fs.symlink(target, f.statusFile);
  const result = await updateGatewayExchangeRate({ cacheFile: f.cacheFile, now }, { fetchXml: successfulFetch }); assert.equal(result.ok, false); assert.equal(result.cachePreserved, true); assert.deepEqual(await fs.readFile(f.cacheFile), before); assert.deepEqual(await fs.readFile(target), original);
});
test('pre-commit rename error preserves old cache; post-commit status failure accurately reports committed cache', async t => {
  const f = await fixture(t); const originalRename = fs.rename.bind(fs); const before = await save(f.cacheFile, parseEcbXml(XML, TIME - 60000));
  const mock = t.mock.method(fs, 'rename', async (source, target) => { if (target === f.cacheFile) throw Object.assign(new Error(), { code: 'EACCES' }); return originalRename(source, target); });
  const pre = await updateGatewayExchangeRate({ cacheFile: f.cacheFile, now }, { fetchXml: successfulFetch }); assert.equal(pre.cachePreserved, true); assert.deepEqual(await fs.readFile(f.cacheFile), before);
  mock.mock.restore();
  t.mock.method(fs, 'rename', async (source, target) => { if (target === f.statusFile) throw Object.assign(new Error(), { code: 'EACCES' }); return originalRename(source, target); });
  const post = await updateGatewayExchangeRate({ cacheFile: f.cacheFile, now }, { fetchXml: successfulFetch }); assert.equal(post.ok, false); assert.equal(post.cacheCommitted, true); assert.equal(post.cachePreserved, false); assert.equal(post.statusWritten, false); assert.equal(validateFxCache(JSON.parse(await fs.readFile(f.cacheFile, 'utf8')), TIME).fetchedAt, now().toISOString());
});

function mockTransport(t, options) {
  t.mock.method(https, 'get', (url, requestOptions, callback) => {
    assert.equal(url, 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'); assert.equal(requestOptions.headers['Accept-Encoding'], 'identity'); assert.equal(requestOptions.rejectUnauthorized, true); assert.deepEqual(requestOptions.agent.options.proxyEnv, {});
    const request = new EventEmitter(); request.destroy = () => {};
    queueMicrotask(() => {
      if (options.neverHeaders) return;
      const response = new PassThrough(); response.statusCode = options.status ?? 200; response.headers = options.headers ?? { 'content-type': 'text/xml' }; response.complete = options.complete ?? true;
      callback(response);
      if (options.neverEnd) return;
      response.end(options.body ?? XML);
    });
    return request;
  });
}
test('fixed HTTPS reader accepts normal XML with bounded actual bytes', async t => {
  mockTransport(t, {}); const result = await fetchEcbXml(); assert.equal(result.xml, XML); assert.equal(result.receipt.redirects, 0); assert.equal(result.receipt.bodyBytes, Buffer.byteLength(XML));
});
test('fixed HTTPS reader refuses redirects without following location', async t => {
  mockTransport(t, { status: 302, headers: { location: 'http://127.0.0.1/' } }); await assert.rejects(fetchEcbXml(), e => e.code === 'FX_FETCH_REDIRECT_REFUSED');
});
test('fixed HTTPS reader rejects HTML, compressed and oversized responses', async t => {
  for (const options of [{ headers: { 'content-type': 'text/html' } }, { headers: { 'content-type': 'text/xml', 'content-encoding': 'gzip' } }, { body: 'a'.repeat(65537) }, { headers: { 'content-type': 'text/xml', 'content-length': '65537' } }]) {
    mockTransport(t, options); await assert.rejects(fetchEcbXml()); t.mock.restoreAll();
  }
});
test('total deadline covers body streaming, not just response headers', async t => {
  mockTransport(t, { neverEnd: true }); const start = Date.now(); await assert.rejects(fetchEcbXml({ timeoutMs: 30 }), e => e.code === 'FX_FETCH_TIMEOUT'); assert.ok(Date.now() - start < 1000);
});
test('invalid UTF-8 and partial HTTP responses are never published', async t => {
  mockTransport(t, { body: Buffer.from([0xc3, 0x28]) }); await assert.rejects(fetchEcbXml(), e => e.code === 'FX_XML_ENCODING_INVALID');
  t.mock.restoreAll(); mockTransport(t, { complete: false }); await assert.rejects(fetchEcbXml(), e => e.code === 'FX_FETCH_RESPONSE_ABORTED');
});
test('total deadline covers DNS/headers and synchronous transport failure cleans its timer', async t => {
  mockTransport(t, { neverHeaders: true }); await assert.rejects(fetchEcbXml({ timeoutMs: 30 }), e => e.code === 'FX_FETCH_TIMEOUT');
  t.mock.restoreAll(); t.mock.method(https, 'get', () => { throw new Error('private transport text'); }); await assert.rejects(fetchEcbXml(), e => e.code === 'FX_FETCH_NETWORK_FAILED');
});
test('directory fsync failure after rename cannot falsely report the old cache was preserved', async t => {
  const f = await fixture(t); await save(f.cacheFile, parseEcbXml(XML, TIME - 60000));
  const originalOpen = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (filename, flags, mode) => {
    const handle = await originalOpen(filename, flags, mode);
    if (filename === f.directory) handle.sync = async () => { throw Object.assign(new Error(), { code: 'EIO' }); };
    return handle;
  });
  const result = await updateGatewayExchangeRate({ cacheFile: f.cacheFile, now }, { fetchXml: successfulFetch });
  assert.equal(result.ok, false); assert.equal(result.cacheCommitted, true); assert.equal(result.cachePreserved, false);
  assert.equal(validateFxCache(JSON.parse(await fs.readFile(f.cacheFile, 'utf8')), TIME).fetchedAt, now().toISOString());
});
