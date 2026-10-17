const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID, createHash, webcrypto } = require('node:crypto');
const contract = require('../public/creative/labs/ecommerce-video-studio/video-studio-contract.js');
const source = fs.readFileSync(path.join(__dirname, '../public/creative/labs/ecommerce-video-studio/video-narration.js'), 'utf8');
function plan(audioMode = 'narration') { return { version: 2, totalSeconds: 10, narrationRequired: audioMode !== 'silent', referenceAudioIds: ['reference-original'], request: { audioMode, script: '已确认的完整视觉脚本', audios: [{ id: 'reference-original' }], storyboard: [
  { id: 'shot_1', startSecond: 0, endSecond: 5, narration: '第一镜新台词' }, { id: 'shot_2', startSecond: 5, endSecond: 10, narration: '第二镜新台词' }
] } }; }
function harness() {
  const env = { module: { exports: {} }, require: () => contract, crypto: { randomUUID, subtle: webcrypto.subtle }, Blob, Date, console };
  vm.runInNewContext(source, env); const api = env.module.exports;
  const run = { id: 'run', accountKey: 'owner', plan: plan() }, saved = new Map(), calls = [], snapshots = []; let active = 'owner';
  let transport = async (url, options) => {
    if (options.method === 'GET') return Response.json({ data: { available: true } });
    return audio(JSON.parse(options.body).requestId);
  };
  const hooks = { fetch: async (url, options) => { calls.push({ url, options }); return transport(url, options); },
    store: { saveAsset: async (blob, meta) => { const asset = { ...meta, id: meta.id, blob, accountKey: active }; saved.set(meta.id, asset); return { ...meta, accountKey: active }; }, getAsset: async id => saved.get(id) },
    assertAccount: () => { if (run.accountKey !== active) throw new Error('account changed'); }, persist: async () => { snapshots.push(JSON.parse(JSON.stringify(run))); } };
  return { api, run, hooks, saved, calls, snapshots, setTransport: value => { transport = value; }, setAccount: value => { active = value; } };
}
function audio(requestId) { return new Response(new Blob(['newly synthesized audio'], { type: 'audio/wav' }), { headers: { 'content-type': 'audio/wav', 'X-Narration-Origin': 'script_narration', 'X-Narration-Request-Id': requestId, 'X-Narration-Duration': '2.4', 'X-Narration-Billing-Event': 'stable-billing-event', 'X-Narration-Content-Hash': createHash('sha256').update('newly synthesized audio').digest('hex') } }); }
function rejection(code = 'NARRATION_PROVIDER_REJECTED') { return Response.json({ code, error: '供应商明确拒绝此段', providerSubmitted: true, definitiveFailure: true, stateUncertain: false }, { status: 422 }); }
test('uses each original confirmed narration once, aligned to its boundaries; uploaded audio is excluded', async () => {
  const h = harness(), result = await h.api.ensureRun(h.run, h.hooks);
  assert.equal(result.tracks.length, 2); assert.deepEqual(Array.from(result.tracks, track => track.startSeconds), [0, 5]); assert.equal(result.sourceAudioVolume, 0);
  const bodies = h.calls.filter(call => call.options.method === 'POST').map(call => JSON.parse(call.options.body));
  assert.deepEqual(bodies.map(body => body.text), ['第一镜新台词', '第二镜新台词']); assert.ok(!JSON.stringify(bodies).includes('reference-original')); assert.ok(!JSON.stringify(bodies).includes('完整视觉脚本'));
  assert.equal(result.tracks[0].origin, 'script_narration'); assert.equal(result.tracks[0].scriptFingerprint, h.api.fingerprint(h.run.plan)); assert.equal(h.saved.size, 2);
  assert.ok(h.snapshots.some(snapshot => snapshot.narrationRuns[0].status === 'submitting' && snapshot.narrationRuns[0].requestId));
  await h.api.ensureRun(h.run, h.hooks); assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 2);
});
test('missing speech or billing capability prevents all supplier POSTs', async () => {
  const h = harness(); h.setTransport(async () => Response.json({ data: { available: false, code: 'NARRATION_BILLING_NOT_CONFIGURED', message: '配音未计价' } }));
  await assert.rejects(h.api.ensureRun(h.run, h.hooks), { code: 'NARRATION_BILLING_NOT_CONFIGURED' }); assert.ok(h.calls.every(call => call.options.method === 'GET')); assert.equal(h.saved.size, 0);
});
test('read-only Fish capability inspection keeps missing-supply details without allowing generation', async () => {
  const h = harness();
  const capability = { available: false, provider: 'fish', providerLabel: 'Fish Audio', model: '', referenceId: '', billingUnit: 'million_utf8_bytes', rate: { currency: 'CNY', unit: 'utf8_bytes', perUnits: 1000000, centsPerUnit: null }, code: 'NARRATION_NOT_CONFIGURED', message: 'Fish Audio API Key、模型、音色与配音计价未配置', missing: ['apiKey', 'model', 'referenceId', 'rate'] };
  h.setTransport(async () => Response.json({ data: capability }));
  const actual = await h.api.capabilities({ accountKey: 'owner', fetch: h.hooks.fetch, requireAvailable: false });
  assert.equal(actual.provider, 'fish'); assert.equal(actual.model, ''); assert.equal(actual.billingUnit, 'million_utf8_bytes'); assert.equal(actual.available, false); assert.equal(actual.missing.includes('referenceId'), true);
  await assert.rejects(h.api.ensureRun(h.run, h.hooks), { code: 'NARRATION_NOT_CONFIGURED' }); assert.ok(h.calls.every(call => call.options.method === 'GET'));
});
test('Fish capability display preserves the configured voice and byte-based rate', async () => {
  const h = harness();
  h.setTransport(async () => Response.json({ data: { available: true, provider: 'fish', model: 's2-pro', referenceId: 'configured-voice', billingUnit: 'million_utf8_bytes', currency: 'CNY', centsPerMillionUtf8Bytes: 12000, rate: { currency: 'CNY', unit: 'utf8_bytes', perUnits: 1000000, centsPerUnit: 12000 } } }));
  const actual = await h.api.capabilities({ accountKey: 'owner', fetch: h.hooks.fetch, requireAvailable: false });
  assert.equal(actual.referenceId, 'configured-voice'); assert.equal(actual.currency, 'CNY'); assert.equal(actual.rate.perUnits, 1000000); assert.equal(actual.centsPerMillionUtf8Bytes, 12000); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].options.method, 'GET');
});
test('unknown paid request is reconciled by GET under the saved identity; no second speech POST', async () => {
  const h = harness(); h.run.plan.request.storyboard = h.run.plan.request.storyboard.slice(0, 1);
  h.setTransport(async (_, opts) => { if (opts.method === 'GET') return Response.json({ data: { available: true } }); throw new Error('network lost after submit'); });
  await assert.rejects(h.api.ensureRun(h.run, h.hooks)); const id = h.run.narrationRuns[0].requestId; assert.equal(h.run.narrationRuns[0].status, 'unknown');
  h.setTransport(async (url, opts) => { assert.equal(opts.method, 'GET'); assert.ok(url.includes(id)); return audio(id); });
  await h.api.ensureRun(h.run, h.hooks); assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1); assert.equal(h.run.narrationRuns[0].status, 'succeeded');
});
test('missing unknown receipt stays unknown and cannot be retried as a new paid request', async () => {
  const h = harness(); h.run.plan.request.storyboard = h.run.plan.request.storyboard.slice(0, 1); h.run.narrationRuns = [{ ...h.api.buildPlan(h.run.plan).segments[0], requestId: 'original', status: 'unknown', attempts: [] }];
  h.setTransport(async () => Response.json({ code: 'NARRATION_NOT_FOUND', error: 'not found', definitiveFailure: true, stateUncertain: false }, { status: 404 }));
  await assert.rejects(h.api.ensureRun(h.run, h.hooks)); assert.equal(h.run.narrationRuns[0].status, 'unknown'); assert.equal(h.run.narrationRuns[0].definitiveFailure, false); await assert.rejects(h.api.retrySegment(h.run, 'shot_1', h.hooks), { code: 'NARRATION_RETRY_BLOCKED' }); assert.ok(h.calls.every(call => call.options.method === 'GET'));
});
test('retries only a definitively failed segment, retaining successful visual and audio work', async () => {
  const h = harness(); let secondFailed = false;
  h.setTransport(async (_, opts) => { if (opts.method === 'GET') return Response.json({ data: { available: true } }); const body = JSON.parse(opts.body); if (body.shotId === 'shot_2' && !secondFailed) { secondFailed = true; return rejection(); } return audio(body.requestId); });
  await assert.rejects(h.api.ensureRun(h.run, h.hooks)); const firstAsset = h.run.narrationRuns[0].resultAssetId, rejectedId = h.run.narrationRuns[1].requestId;
  assert.equal(h.run.narrationRuns[1].definitiveFailure, true); await h.api.retrySegment(h.run, 'shot_2', h.hooks); assert.equal(h.run.narrationRuns[0].resultAssetId, firstAsset); assert.notEqual(h.run.narrationRuns[1].requestId, rejectedId);
  const bodies = h.calls.filter(call => call.options.method === 'POST').map(call => JSON.parse(call.options.body)); assert.equal(bodies.filter(body => body.shotId === 'shot_1').length, 1); assert.equal(bodies.filter(body => body.shotId === 'shot_2').length, 2);
});
test('explicit silent plan has no final audio and no supplier requests; narration without text blocks', async () => {
  const h = harness(); h.run.plan = plan('silent'); const result = await h.api.ensureRun(h.run, h.hooks); assert.equal(result.tracks.length, 0); assert.equal(h.calls.length, 0);
  h.run.plan = plan(); h.run.plan.request.storyboard.forEach(shot => { shot.narration = ''; }); assert.throws(() => h.api.buildPlan(h.run.plan), { code: 'NARRATION_SCRIPT_REQUIRED' });
});
test('changed confirmed script cannot silently reuse saved narration', async () => {
  const h = harness(); await h.api.ensureRun(h.run, h.hooks); h.run.plan.request.storyboard[0].narration = '改变后的新台词'; const count = h.calls.length;
  await assert.rejects(h.api.ensureRun(h.run, h.hooks), { code: 'NARRATION_PLAN_CHANGED' }); assert.equal(h.calls.length, count);
});
test('a provider response without new-generation provenance is held unknown, never treated as completed narration', async () => {
  const h = harness(); h.setTransport(async (_, opts) => opts.method === 'GET' ? Response.json({ data: { available: true } }) : new Response('original uploaded audio', { headers: { 'content-type': 'audio/wav' } }));
  await assert.rejects(h.api.ensureRun(h.run, h.hooks), { code: 'NARRATION_RESULT_UNCONFIRMED' }); assert.equal(h.run.narrationRuns[0].status, 'unknown'); assert.equal(h.saved.size, 0);
});
test('missing billing receipts or changed audio bytes are held unknown before saving', async () => {
  for (const corrupt of ['billing', 'hash', 'mismatch']) {
    const h = harness(); h.setTransport(async (_, opts) => {
      if (opts.method === 'GET') return Response.json({ data: { available: true } });
      const result = audio(JSON.parse(opts.body).requestId);
      if (corrupt === 'billing') result.headers.delete('X-Narration-Billing-Event');
      if (corrupt === 'hash') result.headers.delete('X-Narration-Content-Hash');
      if (corrupt === 'mismatch') result.headers.set('X-Narration-Content-Hash', '0'.repeat(64));
      return result;
    });
    await assert.rejects(h.api.ensureRun(h.run, h.hooks), { code: 'NARRATION_RESULT_UNCONFIRMED' }); assert.equal(h.run.narrationRuns[0].status, 'unknown'); assert.equal(h.saved.size, 0);
  }
});
