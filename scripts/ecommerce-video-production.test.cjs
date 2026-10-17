const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs');
const parent = path.resolve(__dirname, '..');
let testRoot = process.env.ECOMMERCE_VIDEO_TEST_ROOT;
if (!testRoot) {
  const candidate = path.join(parent, 'candidate');
  const complete = base => ['video-production.js', 'video-studio-contract.js'].every(name => fs.existsSync(path.join(base, 'public/creative/labs/ecommerce-video-studio', name)));
  if (complete(candidate)) testRoot = candidate;
  else {
    testRoot = parent;
    while (!complete(testRoot) && path.dirname(testRoot) !== testRoot) testRoot = path.dirname(testRoot);
    if (!complete(testRoot)) throw new Error('Set ECOMMERCE_VIDEO_TEST_ROOT to a complete candidate or repository');
  }
}
const moduleDir = path.join(testRoot, 'public/creative/labs/ecommerce-video-studio');
const Contract = require(path.join(moduleDir, 'video-studio-contract.js'));
const Production = require(path.join(moduleDir, 'video-production.js'));
const stamp = '2026-10-09T01:00:00.000Z';
function asset(id, kind, role) {
  return { id, kind, role: role || (kind === 'image' ? 'product' : kind === 'audio' ? 'rhythm' : 'asset'), name: id,
    mimeType: kind === 'image' ? 'image/png' : kind === 'audio' ? 'audio/wav' : 'video/webm', durationSeconds: kind === 'image' ? 0 : 5,
    storageRef: { dbName: Contract.ASSET_DB_NAME, storeName: Contract.ASSET_STORE_NAME, id }, rightsConfirmed: true };
}
function request(extra = {}) {
  const result = { mode: 'direct', creativeRoute: 'hero_product', styleProfile: 'commerce_studio',
    productKey: 'seedance-2.0', durationSeconds: 15, resolution: '1080p', ratio: '9:16', audioMode: 'silent',
    script: '仅展示用户指定的蓝色包装果茶，保持真实品牌与包装文字。', supplementalRequirements: '原商品锁定约束。',
    images: [asset('product-a', 'image')], videos: [], audios: [], ...extra };
  result.rights = { confirmed: true, confirmedAt: stamp, fingerprint: Contract.assetRightsFingerprint(result) };
  return result;
}
test('all presets generate every frame using exactly the selected model and resolution', () => {
  for (const mode of ['economic', 'balanced', 'quality']) for (const productKey of Object.keys(Production.RESOLUTION_PRICES)) {
    for (const resolution of Object.keys(Production.RESOLUTION_PRICES[productKey])) {
      const raw = request({ productKey, resolution });
      const before = JSON.stringify(raw);
      const plan = Production.buildPlan(raw, { mode, totalDurationSeconds: 15, hybridAiSeconds: 0, budgetYuan: 100 });
      assert.equal(plan.version, 2); assert.equal(plan.aiSeconds, 15); assert.equal(plan.localSeconds, 0);
      assert.equal(plan.shots.length, 3); assert.equal(plan.resolution, resolution);
      assert.ok(plan.shots.every(shot => shot.kind === 'ai' && shot.productKey === productKey && shot.request.productKey === productKey && shot.request.resolution === resolution));
      assert.equal(plan.estimateYuan, Math.round(Production.RESOLUTION_PRICES[productKey][resolution] * 300) / 100);
      assert.equal(JSON.stringify(raw), before); assert.equal(Object.isFrozen(raw), false);
      assert.ok(Object.isFrozen(plan.shots[0].request));
    }
  }
});
test('zero legacy AI seconds cannot create a silent static-image success', () => {
  const plan = Production.buildPlan(request(), { mode: 'economic', hybridAiSeconds: 0, budgetYuan: 0 });
  assert.equal(plan.withinBudget, false);
  assert.ok(plan.shots.every(shot => shot.kind === 'ai' && shot.request));
  assert.ok(plan.shots.every(shot => /连续动态视频/.test(shot.request.supplementalRequirements)));
});
test('source images stay references and later generated shots require the preceding output frame', () => {
  const raw = request({ images: [asset('front', 'image'), asset('side', 'image')] });
  const plan = Production.buildPlan(raw, { totalDurationSeconds: 30 });
  assert.equal(plan.shots[0].continuity, null);
  for (let i = 1; i < plan.shots.length; i++) {
    assert.deepEqual(plan.shots[i].continuity, { previousShotId: plan.shots[i - 1].id, required: true });
    assert.deepEqual(plan.shots[i].request.images.map(image => image.id), ['front', 'side']);
    assert.equal(plan.shots[i].sourceAssetId, undefined);
  }
});
test('confirmed fractional storyboard timings survive segmentation without scaling, omissions or duplicated captions', () => {
  const storyboard = Contract.normalizeStoryboard([
    { id: 'hook', durationSeconds: 3.5, visual: '人物连续走两步', narration: '第一句', motion: '跟随前进' },
    { id: 'detail', durationSeconds: 4, visual: '连续转身', narration: '第二句', motion: '顺时针跟随' },
    { id: 'close', durationSeconds: 7.5, visual: '提裙摆后松开，继续走', narration: '第三句', motion: '轻微右移' }
  ], { durationSeconds: 15 });
  const raw = request({ mode: 'assist', goal: '商品展示', storyboard, scriptConfirmed: true, reviewConfirmedAt: stamp });
  raw.reviewFingerprint = Contract.reviewFingerprint(raw.script, storyboard);
  const plan = Production.buildPlan(raw, { totalDurationSeconds: 15 });
  assert.deepEqual(plan.shots[0].storyboard.map(story => [story.sourceStoryboardId, story.startSecond, story.endSecond]), [['hook', 0, 3.5], ['detail', 3.5, 5]]);
  assert.deepEqual(plan.shots[1].storyboard.map(story => [story.sourceStoryboardId, story.startSecond, story.endSecond]), [['detail', 0, 2.5], ['close', 2.5, 5]]);
  assert.equal(plan.shots[1].storyboard[0].continuation, true);
  assert.match(plan.shots[1].request.supplementalRequirements, /从上一镜既有姿态继续/);
  assert.match(plan.shots[0].request.supplementalRequirements, /3.5–5 秒/);
  assert.match(plan.shots[2].request.supplementalRequirements, /提裙摆后松开/);
  assert.equal(plan.request.storyboard[2].durationSeconds, 7.5);
  assert.throws(() => Production.buildPlan(raw, { totalDurationSeconds: 30 }), { code: 'PRODUCTION_STORYBOARD_DURATION_MISMATCH' });
  const edited = JSON.parse(JSON.stringify(raw)); edited.storyboard[0].motion = '确认后改变动作';
  assert.throws(() => Production.buildPlan(edited, { totalDurationSeconds: 15 }), { code: 'PRODUCTION_REVIEW_REQUIRED' });
});
test('confirmed millisecond scene boundaries are never rounded to centiseconds', () => {
  const storyboard = Contract.normalizeStoryboard([{id:'a',durationSeconds:1.555,visual:'连续动作一'},{id:'b',durationSeconds:13.445,visual:'连续动作二'}],{durationSeconds:15});
  const raw=request({mode:'assist',goal:'动作',storyboard,scriptConfirmed:true,reviewConfirmedAt:stamp});
  raw.reviewFingerprint=Contract.reviewFingerprint(raw.script,storyboard);
  const plan=Production.buildPlan(raw,{});
  assert.equal(plan.shots[0].storyboard[0].endSecond,1.555);
  assert.equal(plan.shots[0].storyboard[1].startSecond,1.555);
  assert.equal(plan.shots[0].storyboard[1].durationSeconds,3.445);
});
test('uploaded audio is reference-only while fresh narration is independently required', () => {
  const raw = request({ audioMode: 'narration', narrationLanguage: 'zh-CN', audios: [asset('uploaded-reference', 'audio')] });
  const original = JSON.stringify(raw);
  const plan = Production.buildPlan(raw, { totalDurationSeconds: 15 });
  assert.equal(plan.narrationRequired, true); assert.deepEqual(plan.referenceAudioIds, ['uploaded-reference']);
  assert.deepEqual(plan.audioTracks, []); assert.deepEqual(plan.musicAssetIds, []);
  for (const shot of plan.shots) {
    assert.deepEqual(shot.request.audios, []); assert.equal(shot.request.audioMode, 'silent');
    assert.match(shot.request.supplementalRequirements, /严禁把上传音频原样加入/);
  }
  assert.equal(JSON.stringify(raw), original);
});
test('a new dynamic plan preserves an old saved static plan and its uploaded audio metadata', () => {
  const old = { version: 1, id: 'preserved', shots: [{ kind: 'local', sourceAssetId: 'old-image' }],
    finalAudio: { tracks: [{ assetId: 'old-voice', role: 'narration' }] }, resultAssetId: 'old-output' };
  const before = JSON.stringify(old);
  Production.buildPlan(request(), { totalDurationSeconds: 15 });
  assert.equal(JSON.stringify(old), before);
});
test('selected ratios and output dimensions preserve the selected resolution', () => {
  assert.deepEqual(Production.dimensions('480p', '9:16'), { width: 480, height: 854 });
  assert.deepEqual(Production.dimensions('1080p', '1:1'), { width: 1080, height: 1080 });
  assert.deepEqual(Production.dimensions('4k', '16:9'), { width: 3840, height: 2160 });
  const square = Production.buildPlan(request({ ratio: '1:1', resolution: '480p' }), {});
  assert.equal(square.width, 480); assert.equal(square.height, 480);
  assert.throws(() => Production.buildPlan(request({ ratio: 'adaptive' }), {}), { code: 'PRODUCTION_DIMENSIONS_INVALID' });
  assert.throws(() => Production.buildPlan(request({ productKey: 'seedance-2.0-mini', resolution: '1080p' }), {}), { code: 'RESOLUTION_INVALID' });
});
test('preflight refuses stale authorization, a missing confirmed storyboard and unpriced video references', () => {
  const stale = request(); stale.images.push(asset('new-unconfirmed-image', 'image'));
  assert.throws(() => Production.buildPlan(stale, {}), { code: 'PRODUCTION_ASSET_RIGHTS_REQUIRED' });
  assert.throws(() => Production.buildPlan(request({ mode: 'assist', goal: '商品', storyboard: [] }), {}), { code: 'PRODUCTION_REVIEW_REQUIRED' });
  assert.throws(() => Production.buildPlan(request({ videos: [asset('clip', 'video')] }), {}), { code: 'PRODUCTION_REFERENCE_PRICE_UNKNOWN' });
  const many = request({ images: Array.from({length: 9}, (_, i) => asset('image-' + i, 'image')) });
  assert.throws(() => Production.buildPlan(many, {}), { code: 'PRODUCTION_CONTINUITY_REFERENCE_LIMIT' });
});
test('generation budget options prevent unlimited attempts and illegitimate shot lengths', () => {
  assert.throws(() => Production.normalizeOptions({ maxAttempts: 3 }), { code: 'PRODUCTION_ATTEMPTS_INVALID' });
  assert.throws(() => Production.normalizeOptions({ hybridAiSeconds: 20 }), { code: 'PRODUCTION_AI_DURATION_INVALID' });
  assert.throws(() => Production.normalizeOptions({ hybridAiSeconds: 6 }), { code: 'PRODUCTION_AI_DURATION_INVALID' });
  assert.throws(() => Production.normalizeOptions({ totalDurationSeconds: 31 }), { code: 'PRODUCTION_DURATION_INVALID' });
  assert.deepEqual(Production.normalizeOptions({ preset: 'quality', budgetYuan: '12.25', maxAttempts: 2, hybridAiSeconds: 15 }), { mode: 'quality', budgetProductKey: 'seedance-2.0-mini', budgetYuan: 12.25, maxAttempts: 2, hybridAiSeconds: 15 });
});
test('renderer aborts before loading a source and reports missing browser recorder explicitly', async () => {
  const plan = Production.buildPlan(request(), { mode: 'economic', hybridAiSeconds: 0 });
  const controller = new AbortController(); controller.abort();
  let resolved = false;
  await assert.rejects(Production.renderTimeline(plan, { signal: controller.signal, resolveAsset: async () => { resolved = true; } }), { name: 'AbortError' });
  assert.equal(resolved, false);
  await assert.rejects(Production.renderTimeline(plan, {}), { code: 'PRODUCTION_RECORDER_UNAVAILABLE' });
});
function webmFixture(knownSize, existingDuration) {
  const payload = [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40];
  if (existingDuration) { const number = Buffer.alloc(8); number.writeDoubleBE(1000); payload.push(0x44, 0x89, 0x88, ...number); }
  const info = [0x15, 0x49, 0xa9, 0x66, 0x80 | payload.length, ...payload];
  const size = knownSize ? [0x80 | info.length] : [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  return new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67, ...size, ...info])], { type: 'video/webm' });
}
test('downloaded WebM receives an EBML Duration and preserves both known/unknown Segment sizes', async () => {
  for (const knownSize of [false, true]) for (const existing of [false, true]) {
    const input = webmFixture(knownSize, existing), output = await Production.fixWebmDuration(input, 30);
    const bytes = Buffer.from(await output.arrayBuffer()), at = bytes.indexOf(Buffer.from([0x44, 0x89, 0x88]));
    assert.ok(at >= 0); assert.equal(bytes.readDoubleBE(at + 3), 30000); assert.equal(output.type, 'video/webm');
    assert.equal(output.size - input.size, existing ? 0 : 11);
    if (knownSize) assert.equal((bytes[9] & 0x7f) + 10, output.size);
  }
  await assert.rejects(Production.fixWebmDuration(new Blob([new Uint8Array([0])]), 15), { code: 'PRODUCTION_WEBM_INVALID' });
});
function browserHarness({ playDelay = 200, infinity = true, invalid = false } = {}) {
  const vm = require('node:vm');
  let clock = 0, nextTimer = 0, pumping = false, revoked = 0, stoppedTracks = 0;
  const timers = new Map(), media = [], recordings = [], draws = [];
  function pump() {
    if (pumping || !timers.size) return;
    pumping = true;
    setTimeout(() => {
      pumping = false;
      const first = Array.from(timers.entries()).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (first) { timers.delete(first[0]); clock = first[1].at; first[1].fn(); }
      pump();
    }, 0);
  }
  function schedule(fn, ms) { const key = ++nextTimer; timers.set(key, { fn, at: clock + ms }); pump(); return key; }
  class Media {
    constructor(tag) { this.tag = tag; this.events = new Map(); this.naturalWidth = tag === 'img' ? 360 : 0; this.naturalHeight = tag === 'img' ? 640 : 0;
      this.videoWidth = invalid ? 0 : 1080; this.videoHeight = invalid ? 0 : 1920; this.duration = infinity ? Infinity : 5; this.readyState = 2; this.error = null; this._time = 0; this.seeking = false; this.seeks = []; media.push(this); }
    addEventListener(name, callback, options) { if (!this.events.has(name)) this.events.set(name, []); this.events.get(name).push({ callback, once: options && options.once }); }
    removeEventListener(name, callback) { this.events.set(name, (this.events.get(name) || []).filter(event => event.callback !== callback)); }
    emit(name) { for (const event of [...this.events.get(name) || []]) { if (event.once) this.removeEventListener(name, event.callback); event.callback({}); } }
    set src(value) { this._src = value; if (this.tag === 'img') queueMicrotask(() => this.emit('load')); }
    load() { if (this._src) queueMicrotask(() => this.emit('loadeddata')); }
    removeAttribute() { this._src = ''; }
    get currentTime() { return this._time; }
    set currentTime(value) { this.seeks.push(value); this.seeking = true; schedule(() => { if (value >= 1000000000) this.duration = 5; this._time = value >= 1000000000 ? 5 : value; this.seeking = false; this.emit('durationchange'); this.emit('seeked'); }, 10); }
    play() { return new Promise(resolve => schedule(resolve, playDelay)); }
    pause() { this.paused = true; }
  }
  const stream = { tracks: [{ stop() { stoppedTracks++; } }], getTracks() { return this.tracks; }, addTrack(track) { this.tracks.push(track); } };
  const context = { fillRect() {}, drawImage(value) { draws.push({ at: clock, media: value }); }, measureText(value) { return { width: value.length * 10 }; }, fillText() {} };
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(_stream, options) { this.mimeType = options.mimeType; this.state = 'inactive'; this.timing = {}; recordings.push(this.timing); }
    start() { this.state = 'recording'; this.timing.start = clock; }
    stop() { this.state = 'inactive'; this.timing.stop = clock; queueMicrotask(() => { this.ondataavailable({ data: webmFixture(false, false) }); this.onstop(); }); }
  }
  const env = { SZEcommerceVideoContract: Contract, Blob, AbortController, MediaRecorder: Recorder,
    URL: { createObjectURL() { return 'blob:fixture-' + media.length; }, revokeObjectURL() { revoked++; } },
    document: { createElement(tag) { return tag === 'canvas' ? { getContext() { return context; }, captureStream() { return stream; } } : new Media(tag); } },
    performance: { now() { return clock; } }, setTimeout: schedule, clearTimeout(key) { timers.delete(key); } };
  vm.runInNewContext(fs.readFileSync(path.join(moduleDir, 'video-production.js'), 'utf8'), env);
  return { api: env.SZEcommerceVideoProduction, media, recordings, draws, schedule, resources() { return { revoked, stoppedTracks, remainingTimers: timers.size }; } };
}
test('renderer fixed timeline absorbs 200ms starts for every clip and probes Infinity WebM before resetting to frame zero', async () => {
  const harness = browserHarness(), plan = Production.buildPlan(request(), { mode: 'quality', totalDurationSeconds: 15 });
  const source = { blob: new Blob(['valid-source-decoded-by-browser-double'], { type: 'video/webm' }), durationSec: 5 };
  const output = await harness.api.renderTimeline(plan, { preserveAudio: false, resolveVideo: async () => source });
  assert.equal(output.durationSeconds, 15); assert.ok(output.blob.size > 0);
  assert.equal(harness.recordings.length, 1);
  assert.ok(Math.abs(harness.recordings[0].stop - harness.recordings[0].start - 15000) < 0.01, 'final capture timestamp remains 15s, not 15.6s');
  assert.equal(harness.media.length, 3);
  harness.media.forEach(value => assert.deepEqual(value.seeks, [1000000000, 0]));
  assert.equal(harness.resources().revoked, 3); assert.equal(harness.resources().stoppedTracks, 1); assert.equal(harness.resources().remainingTimers, 0);
});
test('renderer rejects undecodable Infinity input and startup delay rather than silently padding a successful output', async () => {
  const plan = Production.buildPlan(request(), { mode: 'quality', totalDurationSeconds: 15 });
  const source = { blob: new Blob(['fixture'], { type: 'video/webm' }), durationSec: 5 };
  const bad = browserHarness({ invalid: true });
  await assert.rejects(bad.api.renderTimeline(plan, { preserveAudio: false, resolveVideo: async () => source }), { code: 'PRODUCTION_MEDIA_DURATION' });
  assert.equal(bad.recordings.length, 0);
  const slow = browserHarness({ playDelay: 900 });
  await assert.rejects(slow.api.renderTimeline(plan, { preserveAudio: false, resolveVideo: async () => source }), { code: 'PRODUCTION_PLAYBACK_DELAY' });
  assert.equal(slow.resources().stoppedTracks, 1); assert.equal(slow.resources().revoked, 3);
});
test('in-flight renderer cancellation stops capture, clears scheduled frames and releases every source URL', async () => {
  const harness = browserHarness({ infinity: false }), plan = Production.buildPlan(request(), { mode: 'quality', totalDurationSeconds: 15 });
  const controller = new AbortController(); harness.schedule(() => controller.abort(), 2000);
  await assert.rejects(harness.api.renderTimeline(plan, { signal: controller.signal, preserveAudio: false,
    resolveVideo: async () => ({ blob: new Blob(['fixture'], { type: 'video/webm' }), durationSec: 5 }) }), { name: 'AbortError' });
  assert.equal(harness.recordings[0].stop, 2000); assert.equal(harness.resources().stoppedTracks, 1);
  assert.equal(harness.resources().revoked, 3); assert.equal(harness.resources().remainingTimers, 0);
});
