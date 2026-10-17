const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const repo = path.resolve(__dirname, '..');
const moduleDir = path.join(process.env.ECOMMERCE_VIDEO_TEST_ROOT || repo, 'public/creative/labs/ecommerce-video-studio');
const Contract = require(path.join(moduleDir, 'video-studio-contract.js'));
const Production = require(path.join(moduleDir, 'video-production.js'));
const voiceFile = path.join(repo, 'docs/video-generation-run-20261009/assets/voice.wav');
const actualVoice = new Blob([fs.readFileSync(voiceFile)], { type: 'audio/wav' });
function wav(seconds, frequency = 220) {
  const rate = 22050, frames = Math.round(seconds * rate), data = Buffer.alloc(44 + frames * 2);
  data.write('RIFF'); data.writeUInt32LE(36 + frames * 2, 4); data.write('WAVE', 8); data.write('fmt ', 12);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * i / rate) * 3000), 44 + i * 2);
  return new Blob([data], { type: 'audio/wav' });
}
function decodedDuration(input) {
  const bytes = Buffer.from(input);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('bad WAV');
  let at = 12, byteRate, length;
  while (at + 8 <= bytes.length) {
    const name = bytes.toString('ascii', at, at + 4), size = bytes.readUInt32LE(at + 4);
    if (name === 'fmt ') byteRate = bytes.readUInt32LE(at + 16);
    if (name === 'data') length = size;
    at += 8 + size + (size % 2);
  }
  assert.ok(byteRate > 0 && length > 0); return length / byteRate;
}
const voiceDuration = decodedDuration(fs.readFileSync(voiceFile));
function webm() {
  return new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67, 0xff,
    0x15, 0x49, 0xa9, 0x66, 0x80, 0x1f, 0x43, 0xb6, 0x75, 0x80])], { type: 'video/webm' });
}
function plan({ video = false, musicAssetIds = [] } = {}) {
  return { id: 'audio-regression', ratio: '9:16', totalSeconds: 15, musicAssetIds,
    shots: Array.from({ length: 3 }, (_, i) => ({ id: 'shot-' + i, kind: 'local', sourceAssetId: 'visual-' + i,
      sourceKind: video && i === 0 ? 'video' : 'image', durationSeconds: 5, subtitle: '' })) };
}
function harness({ decodeFailure = false, width = 360, height = 640 } = {}) {
  let clock = 0, timerId = 0, pumping = false, revoked = 0, tracksStopped = 0;
  const timers = new Map(), media = [], audioSources = [], gains = [], recordings = [], contexts = [];
  function pump() {
    if (pumping || !timers.size) return; pumping = true;
    setImmediate(() => { pumping = false;
      const first = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (first) { timers.delete(first[0]); clock = first[1].at; first[1].fn(); } pump();
    });
  }
  function schedule(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: clock + ms }); pump(); return id; }
  function streamTrack(kind) { return { kind, stop() { tracksStopped++; } }; }
  const output = { tracks: [streamTrack('video')], getTracks() { return this.tracks; },
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }, addTrack(track) { this.tracks.push(track); } };
  class Media {
    constructor(tag) { this.tag = tag; this.events = new Map(); this.naturalWidth = tag === 'img' ? 360 : 0;
      this.naturalHeight = tag === 'img' ? 640 : 0; this.videoWidth = width; this.videoHeight = height;
      this.duration = 5; this.currentTime = 0; this.error = null; this.seeking = false; media.push(this); }
    addEventListener(name, fn) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(fn); }
    removeEventListener(name, fn) { this.events.get(name)?.delete(fn); }
    emit(name) { for (const fn of [...this.events.get(name) || []]) fn({}); }
    set src(value) { this._src = value; if (this.tag === 'img') queueMicrotask(() => this.emit('load')); }
    load() { if (this._src) queueMicrotask(() => this.emit('loadeddata')); }
    play() { return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute() { this._src = ''; }
  }
  class Audio {
    constructor() { this.state = 'suspended'; this.sampleRate = 48000; contexts.push(this); }
    get currentTime() { return clock / 1000; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamDestination() { return { stream: { getAudioTracks() { return [streamTrack('audio')]; } } }; }
    decodeAudioData(bytes) { return decodeFailure ? Promise.reject(new Error('decoder rejection')) : Promise.resolve({ duration: decodedDuration(bytes) }); }
    createBuffer(channels, length, sampleRate) { const samples = new Float32Array(length); return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData() { return samples; } }; }
    createBufferSource() {
      const source = { connect(target) { this.target = target; }, disconnect() { this.disconnected = true; },
        start(when) { this.started = { when, clock }; }, stop(when) { if (when === undefined) this.cancelledAt = clock; else this.stoppedAt = when; } };
      audioSources.push(source); return source;
    }
    createMediaElementSource(element) { const source = { element, connect(target) { this.target = target; }, disconnect() { this.disconnected = true; } }; audioSources.push(source); return source; }
    createGain() { const values = [], gain = { values, connect(target) { this.target = target; }, disconnect() { this.disconnected = true; } };
      gain.gain = { set value(value) { values.push({ value, clock }); }, get value() { return values.at(-1)?.value; } }; gains.push(gain); return gain; }
  }
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(_stream, options) { this.state = 'inactive'; this.mimeType = options.mimeType; this.timing = {}; recordings.push(this.timing); }
    start() { this.state = 'recording'; this.timing.start = clock; }
    stop() { this.state = 'inactive'; this.timing.stop = clock; queueMicrotask(() => { this.ondataavailable({ data: webm() }); this.onstop(); }); }
  }
  const ctx = { fillRect() {}, drawImage() {}, measureText() { return { width: 1 }; }, fillText() {} };
  const env = { SZEcommerceVideoContract: Contract, Blob, AbortController, AudioContext: Audio, MediaRecorder: Recorder,
    URL: { createObjectURL() { return 'blob:fixture-' + media.length; }, revokeObjectURL() { revoked++; } },
    document: { createElement(tag) { return tag === 'canvas' ? { getContext() { return ctx; }, captureStream() { return output; } } : new Media(tag); } },
    performance: { now() { return clock; } }, setTimeout: schedule, clearTimeout(id) { timers.delete(id); } };
  vm.runInNewContext(fs.readFileSync(path.join(moduleDir, 'video-production.js'), 'utf8'), env);
  return { api: env.SZEcommerceVideoProduction, audioSources, gains, recordings, contexts, media, schedule,
    resources() { return { revoked, tracksStopped, timers: timers.size }; } };
}
const imageBlob = new Blob(['decoded fixture image'], { type: 'image/png' });
const selected = [{ id: 'voice', assetId: 'voice', role: 'narration', volume: 1, startSeconds: 0, loop: false },
  { id: 'bgm', assetId: 'bgm', role: 'music', volume: 0.25, startSeconds: 0, loop: true }];
function resolvers() { return { resolveAsset: async () => imageBlob,
  resolveAudio: async track => track.assetId === 'voice' ? { blob: actualVoice, durationSec: 3.2 } : wav(1) }; }
test('real 7.574-second voice survives three five-second shots, independently of stale 3.2-second metadata; BGM loops at exact selected gain', async () => {
  const h = harness(); const result = await h.api.renderTimeline(plan(), { ...resolvers(), audioTracks: selected, sourceAudioVolume: 0 });
  assert.equal(result.audioMix.tracks.length, 2); assert.equal(result.audioMix.narrationComplete, true);
  const voice = result.audioMix.tracks[0], music = result.audioMix.tracks[1];
  assert.equal(voice.durationSeconds, voiceDuration); assert.equal(voice.outputDurationSeconds, voiceDuration); assert.equal(voice.loop, false);
  assert.equal(music.volume, 0.25); assert.equal(music.loop, true); assert.equal(music.outputDurationSeconds, 15);
  assert.equal(h.audioSources.length, 3); assert.equal(h.audioSources[0].loop, false); assert.equal(h.audioSources[1].loop, true);
  assert.equal(h.gains[0].values[0].value, 1); assert.equal(h.gains[1].values[0].value, 0.25);
  h.audioSources.forEach(source => { assert.equal(source.started.clock, h.recordings[0].start); assert.equal(source.started.when, h.recordings[0].start / 1000); assert.equal(source.stoppedAt, 15); assert.equal(source.disconnected, true); });
  assert.equal(h.recordings[0].stop - h.recordings[0].start, 15000);
  assert.equal(result.audioMix.outputAudioTracks, 1); assert.equal(h.contexts[0].state, 'closed'); assert.equal(h.resources().timers, 0);
});
test('narration alone keeps a zero-signal sample clock until the whole-film boundary so the last voice packet and trailing silence are encoded', async () => {
  const h = harness(); const result = await h.api.renderTimeline(plan(), { ...resolvers(), audioTracks: [selected[0]], sourceAudioVolume: 0 });
  assert.equal(result.audioMix.tracks.length, 1); assert.equal(result.audioMix.tracks[0].outputDurationSeconds, voiceDuration);
  const quiet = h.audioSources[1]; assert.equal(quiet.loop, true); assert.equal(quiet.target.gain.value, 0);
  assert.equal(quiet.buffer.duration, 1); assert.equal(quiet.buffer.getChannelData(0).every(value => value === 0), true);
  assert.equal(quiet.started.when, h.recordings[0].start / 1000); assert.equal(quiet.stoppedAt, 15);
  assert.equal(quiet.cancelledAt, 15000); assert.equal(quiet.disconnected, true); assert.equal(h.contexts[0].state, 'closed');
});
test('voice over the whole-film boundary rejects before capture, never silently crops, accelerates, or loops', async () => {
  const h = harness();
  await assert.rejects(h.api.renderTimeline(plan(), { ...resolvers(), audioTracks: [{ ...selected[0], startSeconds: 8 }] }), { code: 'PRODUCTION_NARRATION_TOO_LONG' });
  assert.equal(h.recordings.length, 0); assert.equal(h.contexts[0].state, 'closed');
  await assert.rejects(h.api.renderTimeline(plan(), { ...resolvers(), audioTracks: [{ ...selected[0], loop: true }] }), { code: 'PRODUCTION_NARRATION_LOOP_INVALID' });
});
test('selection, gains, offsets and resolver snapshot cannot change during an in-flight render; music need not loop', async () => {
  const h = harness(), tracks = [{ ...selected[0], startSeconds: 1, volume: 0.8 }, { ...selected[1], loop: false }];
  const opts = { ...resolvers(), audioTracks: tracks, sourceAudioVolume: 0 };
  const task = h.api.renderTimeline(plan(), opts);
  tracks[0].volume = 0; tracks[0].assetId = 'different-account-asset'; tracks[0].startSeconds = 14; opts.resolveAudio = () => { throw Error('new resolver'); };
  const result = await task; assert.equal(result.audioMix.tracks[0].assetId, 'voice'); assert.equal(result.audioMix.tracks[0].volume, 0.8);
  assert.equal(h.audioSources[0].started.when, 1); assert.equal(result.audioMix.tracks[0].startSeconds, 1);
  assert.equal(result.audioMix.tracks[1].loop, false); assert.equal(result.audioMix.tracks[1].outputDurationSeconds, 1);
});
test('explicit empty selected audio suppresses legacy music, while absent selection keeps old music-only records playable', async () => {
  const muted = harness(); let resolved = false;
  const none = await muted.api.renderTimeline(plan({ musicAssetIds: ['old-music'] }), { resolveAsset: async id => { if (id === 'old-music') resolved = true; return imageBlob; }, audioTracks: [], sourceAudioVolume: 0 });
  assert.equal(resolved, false); assert.equal(muted.contexts.length, 0); assert.equal(none.audioMix.outputAudioTracks, 0);
  const legacy = harness(), old = await legacy.api.renderTimeline(plan({ musicAssetIds: ['old-music'] }), { resolveAsset: async id => id === 'old-music' ? wav(1) : imageBlob, sourceAudioVolume: 0, musicVolume: 0.4 });
  assert.equal(old.audioMix.tracks[0].role, 'music'); assert.equal(old.audioMix.tracks[0].volume, 0.4);
});
test('source video sound obeys explicit source volume instead of accidental hardcoded ducking', async () => {
  const h = harness(); const result = await h.api.renderTimeline(plan({ video: true }), { ...resolvers(),
    resolveAsset: async id => id === 'visual-0' ? new Blob(['decoded fixture video'], { type: 'video/webm' }) : imageBlob,
    audioTracks: selected, sourceAudioVolume: 0.6 });
  assert.equal(result.audioMix.sourceAudioVolume, 0.6);
  const sourceGain = h.audioSources.find(source => source.element).target;
  assert.ok(sourceGain.values.some(item => item.value === 0.6)); assert.equal(sourceGain.values.at(-1).value, 0);
});
test('cancellation stops both scheduled audio sources, closes the mixer and releases capture and assets', async () => {
  const h = harness(), controller = new AbortController(); h.schedule(() => controller.abort(), 5000);
  await assert.rejects(h.api.renderTimeline(plan(), { ...resolvers(), audioTracks: selected, sourceAudioVolume: 0, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(h.recordings[0].stop, 5000); h.audioSources.forEach(source => assert.equal(source.cancelledAt, 5000));
  assert.equal(h.contexts[0].state, 'closed'); assert.equal(h.resources().revoked, 3); assert.equal(h.resources().tracksStopped, 2); assert.equal(h.resources().timers, 0);
});
test('decoder failure and invalid role/volume/start/duplicate identity fail explicitly', async () => {
  const h = harness({ decodeFailure: true });
  await assert.rejects(h.api.renderTimeline(plan(), { ...resolvers(), audioTracks: selected }), { code: 'PRODUCTION_AUDIO_DECODE_FAILED' });
  assert.equal(h.recordings.length, 0); assert.equal(h.contexts[0].state, 'closed');
  for (const bad of [[{ ...selected[0], role: 'reference' }], [{ ...selected[0], volume: NaN }], [{ ...selected[0], volume: 1.1 }],
    [{ ...selected[0], startSeconds: 'wrong' }], [selected[0], selected[0]], [null]]) assert.throws(() => Production.normalizeAudioTracks(bad, 15));
});

function dynamicPlan() {
  const value = { id: 'dynamic-audio', version: 2, resolution: '480p', ratio: '9:16', totalSeconds: 15,
    referenceAudioIds: ['uploaded-reference'], narrationRequired: true,
    request: { script: '确认的台词与动作', storyboard: [
      { id: 'voice', startSecond: 0, endSecond: 8, narration: '这是确认的口播' },
      { id: 'quiet', startSecond: 8, endSecond: 15, narration: '' }
    ] },
    shots: [0, 1, 2].map(i => ({ id: 'dynamic-' + i, kind: 'ai', durationSeconds: 5, subtitleCues: [] })) };
  const scriptFingerprint = Contract.fingerprint([value.request.script, value.request.storyboard.map(story => [story.id, story.startSecond, story.endSecond, story.narration])], 'narration_');
  const tracks = [{ id: 'generated', assetId: 'generated-audio', role: 'narration', volume: 1, startSeconds: 0, endSeconds: 8, maxDurationSeconds: 8,
    loop: false, origin: 'script_narration', scriptFingerprint, requestId: 'narration-request' }];
  return { value, tracks };
}
test('dynamic renderer rejects static-image plans and does not resolve preserved images', async () => {
  const h = harness(), {value} = dynamicPlan(); value.shots[1].kind = 'local';
  let resolved = 0;
  await assert.rejects(h.api.renderTimeline(value, { resolveAsset: async () => { resolved++; } }), { code: 'PRODUCTION_STATIC_SHOT_FORBIDDEN' });
  assert.equal(resolved, 0); assert.equal(h.recordings.length, 0);
});
test('dynamic renderer refuses uploaded original audio, stale script receipts and missing narration', async () => {
  const h = harness(), {value, tracks} = dynamicPlan();
  for (const track of [{...tracks[0], assetId: 'uploaded-reference'}, {...tracks[0], scriptFingerprint: 'stale'}, {...tracks[0], origin: undefined}, {...tracks[0], endSeconds: 9}]) {
    await assert.rejects(h.api.renderTimeline(value, { generatedAudio: true, audioTracks: [track] }), { code: 'PRODUCTION_NARRATION_BINDING_INVALID' });
  }
  await assert.rejects(h.api.renderTimeline(value, { generatedAudio: true, audioTracks: [] }), { code: 'PRODUCTION_SCRIPT_NARRATION_REQUIRED' });
  assert.equal(h.recordings.length, 0);
});
test('dynamic output keeps the selected resolution despite provider codec alignment and only mixes newly generated script narration', async () => {
  const h = harness({ width: 480, height: 848 }), {value, tracks} = dynamicPlan();
  const out = await h.api.renderTimeline(value, { generatedAudio: true, audioTracks: tracks, sourceAudioVolume: 1,
    resolveVideo: async () => ({blob: new Blob(['video'], {type:'video/webm'}), durationSec: 5}),
    resolveAudio: async track => { assert.equal(track.assetId, 'generated-audio'); return {blob: wav(1)}; } });
  assert.equal(out.width, 480); assert.equal(out.height, 854); assert.equal(out.audioMix.sourceAudioVolume, 0);
  assert.equal(out.audioMix.tracks[0].origin, 'script_narration'); assert.equal(out.audioMix.tracks[0].requestId, 'narration-request');
});
test('dynamic output rejects a lower-resolution source instead of upscaling it to the selection', async () => {
  const h = harness(), {value, tracks} = dynamicPlan();
  await assert.rejects(h.api.renderTimeline(value, { generatedAudio: true, audioTracks: tracks,
    resolveVideo: async () => ({blob:new Blob(['video'],{type:'video/webm'}),durationSec:5}) }), {code:'PRODUCTION_VIDEO_RESOLUTION_MISMATCH'});
  assert.equal(h.recordings.length,0);
});
test('new narration cannot overrun its confirmed scene interval or be automatically truncated', async () => {
  const h = harness({ width: 480, height: 854 }), {value, tracks} = dynamicPlan();
  value.request.storyboard[0].endSecond = .7; value.request.storyboard[1].startSecond = .7;
  tracks[0].endSeconds = .7; tracks[0].maxDurationSeconds = .7;
  tracks[0].scriptFingerprint = Contract.fingerprint([value.request.script, value.request.storyboard.map(story => [story.id,story.startSecond,story.endSecond,story.narration])],'narration_');
  await assert.rejects(h.api.renderTimeline(value, {generatedAudio:true,audioTracks:tracks,
    resolveVideo:async()=>({blob:new Blob(['video'],{type:'video/webm'}),durationSec:5}),resolveAudio:async()=>({blob:wav(1)})}), {code:'PRODUCTION_NARRATION_SEGMENT_TOO_LONG'});
  assert.equal(h.recordings.length,0);
});
