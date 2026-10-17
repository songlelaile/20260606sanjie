import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { FIXTURE_COOKIE } from './proxy.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const session = args.get('--session'), evidenceFile = args.get('--evidence');
const readOnly = args.get('--read-only') === 'yes';
if (!session || !path.isAbsolute(session) || !evidenceFile || !path.isAbsolute(evidenceFile)) throw new Error('Use absolute --session and --evidence');
const state = JSON.parse(await fs.readFile(path.join(session, 'fixture-state.json'), 'utf8'));
assert.equal(state.schema, 'SW_LOCAL_FIXTURE_V1'); assert.equal(state.session, session); assert.equal(state.status, 'ready');
const evidence = { schema: 'SW_LOCAL_FIXTURE_SERVER_PROBE_V1', tier: 'actual Node reverse proxy + actual Next components fixture + actual standalone mac AionCore; HTTP/server acceptance only, no browser interaction', mode: readOnly ? 'read_only' : 'disposable_mutation_probe', mutationAttempts: readOnly ? 0 : 5, session, startedAt: new Date().toISOString(), checks: [], realWalletUsed: false, modelMessagesSent: 0, providerWritesSent: 0, finalRelease: false };
const call = (route, { method = 'GET', json, headers = {} } = {}) => new Promise((resolve, reject) => {
  const body = json === undefined ? undefined : JSON.stringify(json);
  const req = request({ hostname: '127.0.0.1', port: state.ports.proxy, path: route, method, headers: { Host: `localhost:${state.ports.proxy}`, Cookie: FIXTURE_COOKIE, ...(method === 'GET' ? {} : { Origin: state.origin }), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }), ...headers } }, (res) => {
    const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => { const bytes = Buffer.concat(chunks); let value; try { value = JSON.parse(bytes); } catch {} resolve({ status: res.statusCode, headers: res.headers, bytes, value }); });
  }); req.on('error', reject); req.end(body);
});
const mark = (name, data = {}) => evidence.checks.push({ name, passed: true, ...data });
try {
  const health = await call('/sower-work/app/api/sower/health'); assert.equal(health.status, 200); assert.equal(health.value.data.ready, true); mark('actual bridge/engine health is ready through the local-only proxy', { capabilities: health.value.data.capabilities });
  const wallet = await call('/api/sower-work/credits'); assert.equal(wallet.status, 200); assert.equal(wallet.value.meta.fixture, true); assert.equal(wallet.value.meta.realWalletRead, false); mark('actual Wallet endpoint uses explicitly marked read-only synthetic data');
  const ledger = await call('/api/sower-work/credits/ledger?page=2'); assert.equal(ledger.status, 200); assert.equal(ledger.value.data.items.length, 2); assert.equal(ledger.value.meta.fixture, true); mark('fixture ledger really serves the second page without reading production');
  const providers = await call('/sower-work/app/api/providers'); assert.equal(providers.status, 200); assert.deepEqual(providers.value.data, []); mark('fresh isolated engine has no imported provider configuration');
  const forbiddenOrigin = await call('/sower-work/app/api/sower/health', { headers: { Origin: 'https://foreign.example' } }); assert.equal(forbiddenOrigin.status, 403);
  const forbiddenHost = await call('/sower-work/app/api/sower/health', { headers: { Host: `127.0.0.1:${state.ports.proxy}` } }); assert.equal(forbiddenHost.status, 403);
  const missingCookie = await call('/sower-work/app/api/sower/health', { headers: { Cookie: '' } }); assert.equal(missingCookie.status, 401);
  mark('wrong Host, foreign Origin and missing fixture cookie reject before inner forwarding');
  if (!readOnly) {
    const missingOrigin = await call('/sower-work/app/api/conversations', { method: 'POST', json: {}, headers: { Origin: '' } }); assert.equal(missingOrigin.status, 403); mark('unsafe methods require the exact local Origin');
    const message = await call('/sower-work/app/api/conversations/fixture/messages', { method: 'POST', json: { message: 'must never be forwarded' } }); assert.equal(message.status, 403);
    const provider = await call('/sower-work/app/api/providers', { method: 'POST', json: { platform: 'custom', api_key: 'fixture-must-never-be-configured' } }); assert.equal(provider.status, 403);
    const configuredModel = await call('/sower-work/app/api/conversations', { method: 'POST', json: { type: 'aionrs', model: { provider_id: 'fixture-forbidden', model: 'fixture-forbidden' } } }); assert.equal(configuredModel.status, 403); mark('message/provider/model-configured creation writes are actively blocked');
    const blank = await call('/sower-work/app/api/conversations', { method: 'POST', json: { type: 'aionrs', name: 'Disposable launcher probe; never send a model message', model: { provider_id: '', model: '' }, extra: {} } }); assert.equal(blank.status, 201); assert.ok(blank.value.data.id); mark('actual engine accepts a model-less conversation through the proxy', { conversationId: blank.value.data.id });
  }
  const copied = JSON.parse(await fs.readFile(path.join(session, 'next-fixture/copied-components-manifest.json'), 'utf8'));
  for (const file of copied.copiedFiles) { const bytes = await fs.readFile(path.join(session, 'next-fixture', file.relativePath)); assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256); }
  mark('all 8 actual component/CSS/contract copies match their recorded byte hashes', { copies: copied.copiedFiles.length, versions: copied.runtimeVersions });
  const diagnostics = await call('/_fixture/health'); assert.equal(diagnostics.value.diagnostics.modelMessageCallsForwarded, 0); assert.equal(diagnostics.value.diagnostics.providerWriteCallsForwarded, 0); mark('execution boundary reports zero forwarded model messages and provider writes', diagnostics.value.diagnostics);
  const services = JSON.parse(await fs.readFile(path.join(session, 'runtime/services.json'), 'utf8'));
  evidence.ownedProcessIds = { launcher: state.launcherPid, next: state.nextPid, runtime: state.runtimePid, engine: services.enginePid };
  evidence.passed = true;
} catch (error) { evidence.passed = false; evidence.failure = error.message; process.exitCode = 1; }
evidence.finishedAt = new Date().toISOString(); await fs.mkdir(path.dirname(evidenceFile), { recursive: true }); await fs.writeFile(evidenceFile, JSON.stringify(evidence, null, 2)); console.info(JSON.stringify({ passed: evidence.passed, checks: evidence.checks.length, evidenceFile, failure: evidence.failure }));
