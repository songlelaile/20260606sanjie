import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = (name: string) => readFileSync(resolve('public/creative/labs/ecommerce-video-studio', name), 'utf8');
class Element {
  dataset: Record<string, string> = {}; children: Element[] = []; attributes: Record<string, string> = {};
  textContent = ''; value = ''; hidden = false; disabled = false;
  style = { setProperty() {} }; classList = { add() {}, remove() {}, toggle() {} };
  setAttribute(k: string, v: string) { this.attributes[k] = v; } getAttribute(k: string) { return this.attributes[k]; }
  append(...items: Element[]) { this.children.push(...items); } appendChild(item: Element) { this.children.push(item); return item; }
  replaceChildren(...items: Element[]) { this.children = items; } querySelectorAll() { return []; } querySelector() { return null; }
  closest() { return this; } addEventListener() {} remove() {} showModal() {} scrollIntoView() {} click() {}
}
type Asset = { id: string; kind: string; name: string; mimeType: string; durationSec?: number; role: string; blob?: Blob; accountKey?: string; storageRef?: unknown; finalAudioRole?: string; finalAudioVolume?: number; finalAudioLoop?: boolean };
type Track = { id: string; assetId: string; role: string; volume: number; loop: boolean; startSeconds: number; origin?: string };
type Audio = { version: number; tracks: Track[]; assets: Asset[]; sourceAudioVolume: number };
type Shot = { id: string; kind: string; durationSeconds: number; index: number; productKey: string; estimatedYuan: number; request: Record<string, unknown>; continuity?: { previousShotId: string; required: boolean } };
type ShotRun = { id: string; status: string; attempts: unknown[]; adoptionStatus: string; resultAssetId?: string; continuityAssetId?: string; continuitySourceAssetId?: string };
type Plan = { id: string; version: number; totalSeconds: number; aiSeconds: number; ratio: string; options: Record<string, unknown>; request: Record<string, unknown>; shots: Shot[]; finalAudio?: Audio };
type Run = { id: string; taskId: string; purpose: string; accountKey: string; status: string; durationSeconds: number; plan: Plan; resultUrls: string[]; shotRuns: ShotRun[]; narrationRuns?: Array<{ id: string; status: string; error?: string }>; generatedAudio?: Audio; audioMix?: unknown; resultAssetId?: string; error?: string };
type RenderOptions = { generatedAudio: boolean; audioTracks: Track[]; sourceAudioVolume: number; resolveVideo: (shot: Shot) => Promise<Asset>; resolveAudio: (track: Track) => Promise<Asset> };
type Studio = {
  state: { assets: { image: Asset[]; video: Asset[]; audio: Asset[] }; accountKey: string; prompt: string; productionOptions: Record<string, unknown>; settings: Record<string, unknown>; productionAudio: { sourceAudioVolume: number }; legacySingle: boolean; backendConnected: boolean; capabilities: Record<string, unknown>; modelCatalog: Array<Record<string, unknown>> };
  cacheDom(): void; snapshotProductionAudio(duration: number): Audio; productionTemplate(): { audios: unknown[]; audioMode: string; resolution: string };
  productionAudioRenderOptions(run: Run): RenderOptions; draftSnapshot(): { assets: { audio: Asset[] }; productionAudio: { sourceAudioVolume: number } };
  hydrateAsset(asset: Asset): Promise<Asset>; executeProductionRun(run: Run): Promise<Run>; previewProductionPlan(): Plan;
  productionContinuityRequest(run: Run, shot: ShotRun, definition: Shot): Promise<Record<string, unknown>>;
};
function harness({ mixReceipt = true, narrationBlocked = false, narrationUncertain = false } = {}) {
  const nodes = new Map<string, Element>(), assets = new Map<string, Asset>(), runs = new Map<string, Run>();
  const frameSeeks: number[] = [], frameDraws: unknown[] = [];
  class FrameVideo {
    src = ''; videoWidth = 720; videoHeight = 1280; duration = 5; onloadeddata: (() => void) | null = null; onerror: (() => void) | null = null;
    listeners = new Map<string, () => void>();
    set currentTime(value: number) { frameSeeks.push(value); queueMicrotask(() => this.listeners.get('seeked')?.()); }
    addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
    removeEventListener(name: string) { this.listeners.delete(name); }
    load() { if (this.src) queueMicrotask(() => this.onloadeddata?.()); }
    pause() {} removeAttribute() { this.src = ''; }
  }
  const createElement = (tag: string) => tag === 'video' ? new FrameVideo() : tag === 'canvas' ? {
    width: 0, height: 0, getContext: () => ({ drawImage: (...args: unknown[]) => frameDraws.push(args) }),
    toBlob: (callback: (blob: Blob) => void) => callback(new Blob(['extracted-tail'], { type: 'image/jpeg' }))
  } : new Element();
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id)!; };
  const saveAsset = vi.fn(async (blob: Blob, metadata: Asset & { expectedAccountKey?: string }) => { const saved = { ...metadata, blob, accountKey: metadata.expectedAccountKey }; assets.set(metadata.id, saved); return saved; });
  const buildPlan = (request: Record<string, unknown>, options: Record<string, unknown>): Plan => ({ id: 'plan', version: 2, request, options, totalSeconds: 15, aiSeconds: 15, ratio: '9:16', shots: [0, 1, 2].map(index => ({ id: 'shot-' + index, kind: 'ai', durationSeconds: 5, productKey: 'seedance-2.0', estimatedYuan: 1, index, request: { productKey: 'seedance-2.0', images: [], rights: { confirmed: true } }, ...(index ? { continuity: { previousShotId: 'shot-' + (index - 1), required: true } } : {}) })) });
  const generated: Audio = { version: 2, tracks: [{ id: 'generated-voice', assetId: 'generated-voice', role: 'narration', volume: 1, loop: false, startSeconds: 0, origin: 'script_narration' }], assets: [], sourceAudioVolume: 0 };
  const ensureRun = vi.fn(async (run: Run) => {
    if (narrationBlocked) throw new Error('脚本配音能力或计费未配置');
    if (narrationUncertain) { run.narrationRuns = [{ id: 'voice', status: 'unknown', error: '配音接收状态待核对' }]; throw new Error('配音接收状态待核对'); }
    return generated;
  });
  const renderTimeline = vi.fn(async (plan: Plan, options: RenderOptions) => {
    for (const shot of plan.shots) await options.resolveVideo(shot);
    for (const track of options.audioTracks) await options.resolveAudio(track);
    return { blob: new Blob(['mixed video'], { type: 'video/webm' }), width: 720, height: 1280, durationSeconds: 15, mimeType: 'video/webm', ...(mixReceipt ? { audioMix: { tracks: options.audioTracks, narrationComplete: true } } : {}) };
  });
  const runtimeSend = vi.fn(), network = vi.fn(() => { throw new Error('No network allowed in offline regression'); });
  const context = createContext({ console, Blob, URL, Response, Promise, Map, Set, structuredClone, AbortController,
    __SZ_VIDEO_STUDIO_EXPOSE_TESTING__: true, crypto: { randomUUID: () => 'id' }, location: { href: 'https://fixture.test/' }, fetch: network,
    setTimeout: () => 0, clearTimeout() {}, document: { readyState: 'loading', addEventListener() {}, getElementById: get, querySelectorAll: () => [], createElement },
    chrome: { runtime: { sendMessage: runtimeSend } }, SZEcommerceVideoProduction: { normalizeOptions: (raw: unknown) => raw, buildPlan, renderTimeline },
    SZEcommerceVideoNarration: { buildPlan: () => ({ required: true, segments: [] }), ensureRun },
    SZEcommerceVideoStore: { DB_NAME: 'sz_ecommerce_video_studio', ASSET_STORE: 'assets', getAsset: async (id: string) => assets.get(id), saveAsset, saveRun: async (run: Run) => { runs.set(run.id, structuredClone(run)); return run; } }
  });
  runInContext(source('video-studio-contract.js'), context); runInContext(source('video-studio.js'), context);
  const api = context.SZEcommerceVideoStudioTesting as Studio; api.cacheDom();
  api.state.accountKey = 'account'; api.state.prompt = '按脚本生成动态商品视频'; api.state.settings.audioMode = 'narration'; api.state.settings.resolution = '480p';
  api.state.productionOptions = { mode: 'quality', totalDurationSeconds: 15, budgetYuan: 10, maxAttempts: 1 };
  api.state.modelCatalog = [{ productKey: 'seedance-2.0', imageMax: 9, nativePlatform: true, generateAudio: false }];
  const voice: Asset = { id: 'voice-reference', kind: 'audio', name: '原声音参考.wav', mimeType: 'audio/wav', durationSec: 7.574376, role: 'rhythm', finalAudioRole: 'narration', finalAudioVolume: 1, finalAudioLoop: false };
  assets.set(voice.id, { ...voice, blob: new Blob(['original voice'], { type: 'audio/wav' }), accountKey: 'account' }); api.state.assets.audio = [voice];
  assets.set('generated-voice', { id: 'generated-voice', kind: 'audio', name: '脚本新配音.wav', mimeType: 'audio/wav', role: 'narration', durationSec: 4, blob: new Blob(['new script voice']), accountKey: 'account' });
  for (let i = 0; i < 3; i++) assets.set('video-' + i, { id: 'video-' + i, kind: 'video', name: '动态镜头', mimeType: 'video/mp4', role: 'asset', blob: new Blob(['generated video']), accountKey: 'account' });
  const makeRun = (): Run => { const plan = buildPlan({ audioMode: 'narration' }, api.state.productionOptions); return { id: 'plan', taskId: 'plan', purpose: 'production', accountKey: 'account', status: 'queued', durationSeconds: 15, plan, resultUrls: [], shotRuns: plan.shots.map((shot, i) => ({ id: shot.id, status: 'succeeded', attempts: [], adoptionStatus: 'accepted', resultAssetId: 'video-' + i })) }; };
  return { api, assets, runs, voice, makeRun, generated, ensureRun, saveAsset, renderTimeline, runtimeSend, network, get, frameSeeks, frameDraws };
}

describe('script narration replaces raw uploaded audio in new dynamic plans', () => {
  it('keeps reference audio and visible audio/resolution settings in the creative request, without a final upload mix', () => {
    const h = harness(), request = h.api.productionTemplate();
    expect(request.audios).toMatchObject([{ id: 'voice-reference', role: 'rhythm' }]);
    expect(request).toMatchObject({ audioMode: 'narration', resolution: '480p' });
    expect(h.api.previewProductionPlan().finalAudio).toBeUndefined(); expect(h.runtimeSend).not.toHaveBeenCalled();
  });
  it('mixes only newly generated script narration and mutes video source audio', async () => {
    const h = harness(), run = h.makeRun(); await h.api.executeProductionRun(run);
    expect(run.status).toBe('succeeded'); expect(h.ensureRun).toHaveBeenCalledOnce();
    expect(h.renderTimeline.mock.calls[0][1]).toMatchObject({ generatedAudio: true, sourceAudioVolume: 0, audioTracks: [{ assetId: 'generated-voice', origin: 'script_narration' }] });
    expect(run.generatedAudio).toBe(h.generated); expect(h.assets.has('plan_final')).toBe(true);
    expect(h.assets.get('voice-reference')!.blob!.size).toBe(new Blob(['original voice']).size);
    expect(h.runtimeSend).not.toHaveBeenCalled(); expect(h.network).not.toHaveBeenCalled();
  });
  it('blocks before video work if script narration supply or billing is unavailable', async () => {
    const h = harness({ narrationBlocked: true }), run = h.makeRun(); await h.api.executeProductionRun(run);
    expect(run.status).toBe('failed'); expect(run.error).toContain('脚本配音能力或计费未配置');
    expect(h.renderTimeline).not.toHaveBeenCalled(); expect(h.runtimeSend).not.toHaveBeenCalled();
    expect(h.assets.has('plan_final')).toBe(false); expect(run.shotRuns.every(x => x.resultAssetId)).toBe(true);
  });
  it('retains an uncertain narration receipt as unknown instead of classifying it as a definitive failure', async () => {
    const h = harness({ narrationUncertain: true }), run = h.makeRun(); await h.api.executeProductionRun(run);
    expect(run.status).toBe('unknown'); expect(run.narrationRuns![0].status).toBe('unknown');
    expect(h.renderTimeline).not.toHaveBeenCalled(); expect(h.runtimeSend).not.toHaveBeenCalled();
  });
  it('does not publish a final video when the renderer lacks a script-audio mix receipt', async () => {
    const h = harness({ mixReceipt: false }), run = h.makeRun(); await h.api.executeProductionRun(run);
    expect(run.status).toBe('failed'); expect(run.error).toContain('脚本配音尚未确认'); expect(h.assets.has('plan_final')).toBe(false);
  });
  it('preserves old static plans and uploaded-audio snapshots without resuming or rewriting them', async () => {
    const h = harness(), run = h.makeRun(); run.plan.version = 1; run.plan.shots[1].kind = 'local'; run.plan.finalAudio = h.api.snapshotProductionAudio(15);
    const before = structuredClone(run); await h.api.executeProductionRun(run);
    expect(run).toEqual(before); expect(h.get('production-new-plan').hidden).toBe(false); expect(h.get('production-resume').disabled).toBe(true);
    expect(h.ensureRun).not.toHaveBeenCalled(); expect(h.renderTimeline).not.toHaveBeenCalled(); expect(h.runtimeSend).not.toHaveBeenCalled();
  });
  it('persists and rehydrates old audio metadata without altering the original blob', async () => {
    const h = harness(); h.voice.finalAudioVolume = .65; h.api.state.productionAudio.sourceAudioVolume = .1;
    const draft = h.api.draftSnapshot(), hydrated = await h.api.hydrateAsset(draft.assets.audio[0]);
    expect(draft.productionAudio.sourceAudioVolume).toBe(.1); expect(hydrated).toMatchObject({ finalAudioRole: 'narration', finalAudioVolume: .65, durationSec: 7.574376 });
  });
  it('reuses an already saved tail frame, adds its motion reference and preserves the original frozen request', async () => {
    const h = harness(), run = h.makeRun(), definition = run.plan.shots[1], shot = run.shotRuns[1];
    const before = JSON.stringify(definition.request); shot.continuityAssetId = 'saved-tail'; shot.continuitySourceAssetId = 'video-0';
    h.assets.set('saved-tail', { id: 'saved-tail', kind: 'image', name: 'tail', mimeType: 'image/jpeg', role: 'motion', blob: new Blob(['tail']), accountKey: 'account' });
    const request = await h.api.productionContinuityRequest(run, shot, definition);
    expect(request.images).toMatchObject([{ id: 'saved-tail', role: 'motion' }]); expect(request.supplementalRequirements).toContain('图片 1 是上一镜');
    expect(JSON.stringify(definition.request)).toBe(before); expect(h.saveAsset).not.toHaveBeenCalled(); expect(h.runtimeSend).not.toHaveBeenCalled();
  });
  it('extracts and persists the prior video tail before creating a new continuity request, then reuses that receipt', async () => {
    const h = harness(), run = h.makeRun(), shot = run.shotRuns[1], definition = run.plan.shots[1];
    const first = await h.api.productionContinuityRequest(run, shot, definition);
    expect(h.frameSeeks).toEqual([4.94]); expect(h.frameDraws).toHaveLength(1);
    expect(h.saveAsset).toHaveBeenCalledOnce(); expect(h.saveAsset.mock.calls[0][1]).toMatchObject({ kind: 'image', role: 'motion', expectedAccountKey: 'account', sourceResultAssetId: 'video-0' });
    expect(shot.continuityAssetId).toBeTruthy(); expect(h.runs.get(run.id)!.shotRuns[1].continuityAssetId).toBe(shot.continuityAssetId);
    const second = await h.api.productionContinuityRequest(run, shot, definition);
    expect(second).toEqual(first); expect(h.saveAsset).toHaveBeenCalledOnce(); expect(h.runtimeSend).not.toHaveBeenCalled();
  });
  it('blocks a next shot until the prior result is confirmed and blocks full reference slots without deleting originals', async () => {
    const h = harness(), run = h.makeRun(); run.shotRuns[0].status = 'unknown';
    await expect(h.api.productionContinuityRequest(run, run.shotRuns[1], run.plan.shots[1])).rejects.toMatchObject({ code: 'PRODUCTION_CONTINUITY_PREVIOUS_REQUIRED' });
    run.shotRuns[0].status = 'succeeded'; run.plan.shots[1].request.images = Array.from({ length: 9 }, (_, i) => ({ id: 'original-' + i }));
    await expect(h.api.productionContinuityRequest(run, run.shotRuns[1], run.plan.shots[1])).rejects.toMatchObject({ code: 'PRODUCTION_CONTINUITY_IMAGE_LIMIT' });
    expect((run.plan.shots[1].request.images as unknown[]).length).toBe(9); expect(h.runtimeSend).not.toHaveBeenCalled();
  });
});
