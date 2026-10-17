import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { createRequire } from 'node:module';
import { createHash, webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const folder = resolve(process.env.CREATIVE_ASSET_TEST_ROOT || 'public/creative', 'labs/image-prompt-lab');
const script = readFileSync(resolve(folder, 'link-image-result-actions.js'), 'utf8');
const workflow = createRequire(import.meta.url)(resolve(folder, 'link-image-contract.js'));
const img = (n: number) => { const b = Buffer.alloc(40); Buffer.from([137,80,78,71,13,10,26,10]).copy(b); b.writeUInt32BE(64,16); b.writeUInt32BE(64,20); b[24]=n; return 'data:image/png;base64,' + b.toString('base64'); };
interface ResultItem {
  url: string; productImages: string[];
  apiKey?: string; provider?: string; generationRoute?: string; labMode?: string;
  creativeGuideOrigin: { mode: string; provenance: { shotId: string; mode: string } };
}
type RecordedCall = ['edit', string, ResultItem] | ['native-edit', ResultItem]
  | ['product' | 'model', string, string] | ['reference', string];
interface HandoffOutcome { ok: boolean; imported?: boolean; action?: string; error?: string }
interface HandoffApi {
  open(payload: ReturnType<typeof input>): Promise<HandoffOutcome>;
  openCreativeFission(item: unknown, accountKey: string): Promise<HandoffOutcome>;
  receive(): Promise<HandoffOutcome>;
  claim(token: string | null, child: Win, accountKey: string): Promise<{ action: string; item: ResultItem }>;
  complete(token: string | null, child: Win, outcome: HandoffOutcome): boolean;
}
interface MockNode { id: string; style: Record<string, string>; textContent: string; setAttribute(): void }
interface MockFrame { src: string; contentWindow: Win; ownerDocument: ReturnType<typeof doc>; isConnected: boolean }
interface MockState {
  archiveAccountKey: string; productImages: Record<string, string>; modelImages: Record<string, string>; refImages: string[];
  results: Array<{ url: string }>; activeJobIds: Record<string, unknown>; activeJobId?: string; refImage?: string;
  referencePrompts?: { main: { id: string } }; linkList?: Array<{ id: string }>;
  referenceDetail?: { currentBlueprint: { id: string } }; activePromptRecord?: { id: string };
  styleRefresh?: { run: { phase: string } }; guideDraft?: { id: string }; linkResultDraftId?: string;
  linkResultProvenance: Record<string, unknown>; linkResultSourceEvidence: { products: string[] };
}
interface Win {
  location: { href: string; readonly origin: string; readonly search: string; replace(next: string): void };
  document: ReturnType<typeof doc>; state: MockState; closed: boolean; __SANJIE_ENVIRONMENT: string;
  parent: Win; top: Win; opener: Win | null; frameElement: MockFrame;
  calls: RecordedCall[]; timers: Map<number, () => void>; close(): void; open(url: string): Win | null;
  SZ_LINK_RESULT_HANDOFF: HandoffApi; SZ_LINK_IMAGE_WORKFLOW: unknown;
  SZ_CREATIVE_TOOLS_BRIDGE: { getAccountKey(): Promise<string>; openResultAction(action: string, item: ResultItem): Promise<void> };
  SZ_SCENE_EXTENSION_BRIDGE: { ready(): Promise<{ ok: boolean }> };
  SZ_CREATIVE_TOOLS_UI?: { getState(): unknown }; SanjiePromptLabTaskBridge?: { getState(): { busy: boolean } };
  fetch?: (url: string) => Promise<{ ok: boolean; blob?: () => Promise<{ size: number; type?: string }> }>;
  FileReader?: new () => object;
  setTimeout(fn: () => void): number; clearTimeout(id: number): void;
  setProductAngle(angle: string, image: string): void; setModelAngle(angle: string, image: string): void; setRefImage(image: string): void;
}
function recordedItem(calls: RecordedCall[], kind: 'edit' | 'native-edit'): ResultItem {
  const call = calls.find(call => call[0] === kind);
  if (!call || (call[0] !== 'edit' && call[0] !== 'native-edit')) throw new Error(`Missing ${kind} result action`);
  return call[0] === 'edit' ? call[2] : call[1];
}
function deferred() { let resolve!: (value: string) => void; return { promise: new Promise<string>(yes => { resolve = yes; }), finish: (value: string) => resolve(value) }; }
function doc() {
  const nodes = new Map<string, MockNode>();
  const iframeNodes: MockFrame[] = [];
  const app = { insertBefore(node: MockNode) { nodes.set(node.id, node); }, appendChild(node: MockNode) { nodes.set(node.id, node); }, firstChild: null };
  return { readyState: 'loading', body: app, addEventListener() {}, getElementById(id: string) { return nodes.get(id); },
    iframeNodes, querySelectorAll(selector: string) { return selector === 'iframe' ? iframeNodes : []; },
    querySelector(selector: string) { return selector === '.app' ? app : null; },
    createElement() { return { id: '', style: {}, textContent: '', setAttribute() {} }; }, nodes };
}
function windowAt(url: string): Win {
  const location = { href: url } as Win['location'];
  Object.defineProperties(location, { origin: { get: () => new URL(location.href).origin }, search: { get: () => new URL(location.href).search } });
  location.replace = (next: string) => { location.href = next; };
  const timers = new Map<number, () => void>(); let sequence = 0;
  const calls: RecordedCall[] = [], document = doc();
  // The real script injects the handoff API and generated provenance into this
  // mutable host; the fixture wires its window relationships immediately below.
  const win = { location, document, state: { archiveAccountKey: 'account:alice', productImages: {}, modelImages: {}, refImages: [], results: [], activeJobIds: {} },
    crypto: webcrypto, structuredClone, __SANJIE_ENVIRONMENT: 'fixture', closed: false,
    setTimeout(fn: () => void) { const id=++sequence; timers.set(id,fn); return id; }, clearTimeout(id: number) { timers.delete(id); },
    close() { win.closed = true; }, calls, timers,
    SZ_LINK_IMAGE_WORKFLOW: workflow,
    SZ_CREATIVE_TOOLS_BRIDGE: { getAccountKey: async () => 'account:alice', openResultAction: async (action: string, item: ResultItem) => { calls.push(['edit',action,item]); } },
    SZ_SCENE_EXTENSION_BRIDGE: { ready: async () => ({ ok: true }) },
    setProductAngle(angle: string, image: string) { win.state.productImages[angle]=image; calls.push(['product',angle,image]); },
    setModelAngle(angle: string, image: string) { win.state.modelImages[angle]=image; calls.push(['model',angle,image]); },
    setRefImage(image: string) { win.state.refImage=image; win.state.refImages=[image]; calls.push(['reference',image]); }
  } as unknown as Win;
  win.parent=win;win.top=win;win.opener=null;
  return win;
}
function install(win: Win) { runInContext(script, createContext({ window: win, URL, URLSearchParams, Map, Promise, JSON, Object, String, Error, Array })); return win.SZ_LINK_RESULT_HANDOFF; }
function input(action='guided-regenerate', count=2, mode='main') {
  const plan = workflow.createPlan({ bundleId: 'bundle-original', category: '外套', link: { 链接编号: 'L001', 商品标题: '真实西装', 链接定位: '通勤', 主推关键词:'西装', 用户场景需求:'办公室通勤', 差异化定位逻辑:'真实版型', 主图核心文案:'通勤穿搭', 详情页定位:'商品细节', 详情页文案:'实拍细节', 详情文案逻辑:'整体到细节' },
    products: Array.from({ length: count }, (_,index) => ({ id: 'p'+index, image: img(index+1), name:'产品'+index })), models: [{ id:'m1',image:img(20),name:'模特' }],
    config: { mode, provider:'saved-custom-api', model:'image-model', count: 5 } });
  if (!plan.ok) throw new Error(plan.error);
  const payload = workflow.createPayload(plan,plan.shots[0].id);
  const item = { url: img(30), resultId:'result-original', jobId:'job-original', linkId:plan.linkId, linkBundleId:plan.bundleId, linkMode:mode,
    linkShotId:plan.shots[0].id, linkPlanSignature:plan.signature, linkPlanSnapshot:payload.linkPlan,
    productImages: payload.productImages, modelImages:payload.modelImages, prompt:payload.prompt, ratio:plan.config.ratio, resolution:plan.config.resolution,
    generationRoute:'link-image', apiKey:'NEVER_TRANSFER_THIS', provider:'do-not-switch-provider' };
  return { action, item, shot:plan.shots[0], plan:payload.linkPlan.plan, accountKey:'account:alice', bundleId:plan.bundleId, linkId:plan.linkId, mode };
}
async function spin() { for(let i=0;i<8;i++) await Promise.resolve(); }
const canonicalFrame = (surface:string) => 'https://test.invalid/creative/labs/image-prompt-lab/promptlab.html' + (surface==='list-legacy'?'?mode=main&source=web&layout=1':`?mode=viral&source=web&layout=1&workflow=1&creativeRoute=${surface==='viral-style'?'style-refresh':'case'}`);
function fixture(sourceUrl='https://test.invalid/creative/labs/image-prompt-lab/promptlab.html?mode=link-image&source=web') {
  const source = windowAt(sourceUrl);
  const popup = windowAt('about:blank'), target = windowAt('about:blank'); let opened = 0;
  target.parent=popup;target.top=popup;
  const frame={src:'about:blank',contentWindow:target,ownerDocument:popup.document,isConnected:true};target.frameElement=frame;popup.document.iframeNodes.push(frame);
  popup.location.replace = (next:string) => {
    popup.location.href=next;
    const surface=new URL(next).searchParams.get('surface')||'';
    // Model only the existing host's surface-to-iframe rendering. The handoff
    // script under test never assigns iframe src or changes the host document.
    frame.src=canonicalFrame(surface);target.location.href=frame.src;
  };
  popup.close=()=>{popup.closed=true;target.closed=true;};
  source.open = (url: string) => { opened++; expect(url).toBe('about:blank'); popup.opener=source;return popup; };
  const api = install(source);
  return { source,popup,target,frame,api,get opened() { return opened; },
    async start(payload: ReturnType<typeof input>) { const result=api.open(payload); await spin(); install(target); return { result, received: target.SZ_LINK_RESULT_HANDOFF.receive() }; } };
}

describe('link result action handoff', () => {
  it.each(['guided-regenerate','case-fission','style-refresh'])('imports %s into a fresh existing tool without paid calls, API transfer, or source mutation', async action => {
    const f=fixture(), payload=input(action), before=structuredClone(f.source.state), original=structuredClone(payload);
    f.source.state.activeJobId='still-running-link-job'; before.activeJobId='still-running-link-job';
    const handoff=await f.start(payload);
    expect(await handoff.received).toMatchObject({ok:true,imported:true,action}); expect(await handoff.result).toMatchObject({ok:true,imported:true,action});
    expect(f.source.state).toEqual(before); expect(payload).toEqual(original); expect(f.target.opener).toBeNull(); expect(f.popup.opener).toBeNull();
    expect(f.target.state.productImages.front).toBe(payload.item.productImages[0]);
    expect(f.target.state.linkResultProvenance).toMatchObject({linkId:'L001',mode:'main',sourceJobId:'job-original',accountKey:'account:alice'});
    expect(f.target.state.linkResultDraftId).toBeTruthy();
    if(action==='guided-regenerate') { const item=recordedItem(f.target.calls, 'edit'); expect(item.apiKey).toBeUndefined(); expect(item.provider).toBeUndefined(); expect(item.generationRoute).toBeUndefined(); expect(item.productImages).toEqual(payload.item.productImages); expect(item.creativeGuideOrigin.provenance.shotId).toBe(payload.shot.id); }
    if(action==='case-fission') expect(f.target.state.refImages).toEqual([payload.item.url]);
    if(action==='style-refresh') { expect(f.target.state.refImages).toEqual([]); expect(new URL(f.target.location.href).searchParams.get('creativeRoute')).toBe('style-refresh'); }
    expect(f.target.calls.every((call) => ['product','model','reference','edit'].includes(call[0]))).toBe(true);
  });
  it('copies a local blob result into the independent draft before detaching its source', async () => {
    const f=fixture(), p=input(); p.item.url='blob:https://test.invalid/local-result'; const fetches:string[]=[];
    f.target.fetch=async(url:string)=>{fetches.push(url);return {ok:true,blob:async()=>({type:'image/png',size:40})};};
    f.target.FileReader=class { result=img(30); onload=()=>{}; readAsDataURL() { queueMicrotask(()=>this.onload()); } };
    const h=await f.start(p); expect((await h.received).ok).toBe(true); await h.result;
    expect(fetches).toEqual(['blob:https://test.invalid/local-result']); expect(recordedItem(f.target.calls, 'edit').url).toBe(img(30));
    expect(p.item.url).toBe('blob:https://test.invalid/local-result'); expect(f.target.opener).toBeNull(); expect(f.popup.opener).toBeNull();
  });
  it('keeps a failed local blob import separate without changing the source or any target draft', async () => {
    const f=fixture(), p=input(), original=structuredClone(f.source.state); p.item.url='blob:https://test.invalid/expired';
    f.target.fetch=async()=>({ok:false}); f.target.FileReader=class {};
    const h=await f.start(p); expect((await h.received).ok).toBe(false); expect((await h.result).ok).toBe(false);
    expect(f.target.calls).toEqual([]); expect(f.target.state.linkResultDraftId).toBeUndefined(); expect(f.source.state).toEqual(original);
  });
  it('executes the currently published native edit bridge when supplied as the acceptance baseline', async () => {
    const path=process.env.SANJIE_RESULT_RECEIVER_SOURCE;
    if(!path) return;
    const native=readFileSync(resolve(path),'utf8');
    expect(createHash('sha256').update(native).digest('hex')).toBe(process.env.SANJIE_RESULT_RECEIVER_SHA256 || '0d6a5e1a6800711047d72c7c3fddb4459bd32bb469d2ec69bfb2b532b412fe7e');
    const start=native.indexOf('window.SZ_CREATIVE_TOOLS_BRIDGE = {'), end=native.indexOf('\n  };',start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const f=fixture(), sends: unknown[]=[];
    const stubs: Record<string, unknown>={ window:f.target, state:f.target.state, cfgFromForm:()=>({provider:'retained-custom',apiKey:'stays-in-target'}),
      send:(...args:unknown[])=>{sends.push(args);throw new Error('No dispatch expected');},
      creativeWebAccountKey:async()=> 'account:alice', cloneGuideValue:structuredClone, $:()=>null,
      openGuideRegenerateModal:(item: ResultItem)=>{f.target.calls.push(['native-edit',item]);return {ok:true};} };
    ['queueArchiveResult','creativeWebRefresh','creativeWebListBoundApis','creativeWebSelectBoundApi','creativeWebSetApiBusy','newJobId','registerGenerationJob','unregisterGenerationJob','openArchiveHistory'].forEach(name=>{stubs[name]=()=>{};});
    runInContext(native.slice(start,end+'\n  };'.length),createContext(stubs));
    const p=input('guided-regenerate',2,'detail'), h=await f.start(p); expect((await h.received).ok).toBe(true); await h.result;
    const item=recordedItem(f.target.calls, 'native-edit');
    expect(item.productImages).toEqual(p.item.productImages); expect(item.labMode).toBe('main'); expect(item.creativeGuideOrigin.provenance.mode).toBe('detail');
    expect(item.generationRoute).toBeUndefined(); expect(item.apiKey).toBeUndefined(); expect(sends).toEqual([]);
  });
  it('opens the blank child synchronously before checking the live account', async () => {
    const f=fixture(), wait=deferred(); f.source.SZ_CREATIVE_TOOLS_BRIDGE.getAccountKey=()=>wait.promise;
    const opening=f.api.open(input()); expect(f.opened).toBe(1); expect(f.target.location.href).toBe('about:blank');
    wait.finish('account:bob'); expect(await opening).toMatchObject({ok:false}); expect(f.target.closed).toBe(true); expect(f.target.calls).toEqual([]);
  });
  it('keeps a blocked popup actionable and sends no import', async () => {
    const f=fixture(); f.source.open=()=>null; expect(await f.api.open(input())).toMatchObject({ok:false,error:expect.stringContaining('弹出窗口')}); expect(f.target.calls).toEqual([]);
  });
  it.each(['account','bundle','link','mode','shot','signature','image','product','model'])('rejects changed %s before opening a window', async kind => {
    const f=fixture(), p=input();
    if(kind==='account') p.accountKey='account:bob';
    if(kind==='bundle') p.bundleId='wrong';
    if(kind==='link') p.linkId='L002';
    if(kind==='mode') p.mode='detail';
    if(kind==='shot') p.shot={...p.shot,prompt:'changed'};
    if(kind==='signature') p.item.linkPlanSignature='changed';
    if(kind==='image') p.item.url='javascript:alert(1)';
    if(kind==='product') p.item.productImages=[img(42)];
    if(kind==='model') p.item.modelImages=[];
    expect(await f.api.open(p)).toMatchObject({ok:false}); expect(f.opened).toBe(0);
  });
  it('rejects a different receiving account without importing or overwriting its draft', async () => {
    const f=fixture(), p=input(), opening=f.api.open(p); await spin();
    f.target.state.archiveAccountKey='account:bob'; f.target.SZ_CREATIVE_TOOLS_BRIDGE.getAccountKey=async()=> 'account:bob'; f.popup.opener=f.source;
    install(f.target); expect(await f.target.SZ_LINK_RESULT_HANDOFF.receive()).toMatchObject({ok:false}); expect(f.target.calls).toEqual([]);
    for(const timeout of f.source.timers.values()) timeout(); expect(await opening).toMatchObject({ok:false});
  });
  it('rejects another deployment environment before sending materials', async () => {
    const f=fixture(), opening=f.api.open(input()); await spin(); f.popup.opener=f.source; f.target.__SANJIE_ENVIRONMENT='another'; install(f.target);
    expect(await f.target.SZ_LINK_RESULT_HANDOFF.receive()).toMatchObject({ok:false}); expect(f.target.calls).toEqual([]);
    for(const timeout of f.source.timers.values()) timeout(); expect(await opening).toMatchObject({ok:false});
  });
  it.each(['product','model','reference','result','job','prompt','savedPrompt','legacyTask','linkList','blueprint','styleRun','guide','draft'])('refuses an occupied %s target and preserves it exactly', async kind => {
    const f=fixture(), p=input('style-refresh'), opening=f.api.open(p); await spin();
    if(kind==='product') f.target.state.productImages.front=img(99);
    if(kind==='model') f.target.state.modelImages.front=img(99);
    if(kind==='savedPrompt') f.target.state.referencePrompts={main:{id:'old'}};
    if(kind==='legacyTask') f.target.SanjiePromptLabTaskBridge={getState:()=>({busy:true})};
    if(kind==='linkList') f.target.state.linkList=[{id:'old'}];
    if(kind==='blueprint') f.target.state.referenceDetail={currentBlueprint:{id:'old'}};
    if(kind==='reference') f.target.state.refImages=[img(99)];
    if(kind==='result') f.target.state.results=[{url:img(99)}];
    if(kind==='job') f.target.state.activeJobId='old-job';
    if(kind==='prompt') f.target.state.activePromptRecord={id:'old-prompt'};
    if(kind==='styleRun') f.target.state.styleRefresh={run:{phase:'complete'}};
    if(kind==='guide') f.target.state.guideDraft={id:'old'};
    if(kind==='draft') f.target.state.linkResultDraftId='old';
    const original=structuredClone(f.target.state); f.popup.opener=f.source; install(f.target);
    expect(await f.target.SZ_LINK_RESULT_HANDOFF.receive()).toMatchObject({ok:false,error:expect.stringContaining('没有覆盖')});
    expect(await opening).toMatchObject({ok:false}); expect(f.target.state).toEqual(original); expect(f.target.calls).toEqual([]);
  });
  it('does not allow an unbound window, changed route, or replay to claim a result', async () => {
    const f=fixture(), opening=f.api.open(input()); await spin(); const token=new URL(f.popup.location.href).searchParams.get('linkResultToken');
    const imposter=windowAt(f.target.location.href);
    await expect(f.api.claim(token,imposter,'account:alice')).rejects.toThrow('失效');
    const properUrl=f.target.location.href; f.target.location.href=properUrl.replace('mode=main','mode=viral');
    await expect(f.api.claim(token,f.target,'account:alice')).rejects.toThrow('失效'); f.target.location.href=properUrl;
    const first=await f.api.claim(token,f.target,'account:alice'); expect(first.item.url).toBe(img(30));
    await expect(f.api.claim(token,f.target,'account:alice')).rejects.toThrow('失效');
    f.api.complete(token,f.target,{ok:true}); expect(await opening).toMatchObject({ok:true});
    await expect(f.api.claim(token,f.target,'account:alice')).rejects.toThrow('失效');
  });
  it('retains all six source originals and clearly explains the native three-slot limit', async () => {
    const f=fixture(), p=input('style-refresh',6), h=await f.start(p); expect((await h.received).ok).toBe(true); await h.result;
    expect(Object.keys(f.target.state.productImages)).toHaveLength(3); expect(f.target.state.linkResultSourceEvidence.products).toEqual(p.item.productImages);
    expect(f.target.document.nodes.get('linkResultImportNotice')!.textContent).toContain('其余 3 张仍保留在源清单');
  });
  it('keeps all six originals for the guide execution snapshot, including detail source provenance', async () => {
    const f=fixture(), p=input('guided-regenerate',6,'detail'), h=await f.start(p); expect((await h.received).ok).toBe(true); await h.result;
    const item=recordedItem(f.target.calls, 'edit'); expect(item.productImages).toHaveLength(6); expect(item.creativeGuideOrigin.mode).toBe('detail');
  });
  it('uses only one receiving operation when startup invokes it twice', async () => {
    const f=fixture(), opening=f.api.open(input()); await spin(); f.popup.opener=f.source; const receiver=install(f.target);
    const first=receiver.receive(), second=receiver.receive(); expect(first).toBe(second); await first; await opening;
    expect(f.target.calls.filter((call)=>call[0]==='edit')).toHaveLength(1);
  });
  it('fails safely when the original tab closes or target reloads after consumption', async () => {
    const target=windowAt('https://test.invalid/creative/labs/image-prompt-lab/promptlab.html?mode=main&source=web&linkResultToken=expired');
    const receiver=install(target); expect(await receiver.receive()).toMatchObject({ok:false}); expect(target.calls).toEqual([]);
  });
});

describe('website-shell preserving result handoff',()=>{
  it.each([['style-refresh','viral-style'],['case-fission','viral-case'],['guided-regenerate','list-legacy']])('opens %s inside canonical %s website shell without iframe mutations',async(action,surface)=>{
    const f=fixture(),before=structuredClone(f.source.state),pending=f.api.open(input(action));await spin();
    const shell=new URL(f.popup.location.href),frameBefore=f.frame.src,receiverBefore=f.target.location.href;
    expect(shell.pathname).toBe('/dashboards/operating-network');expect(shell.searchParams.get('surface')).toBe(surface);expect(shell.searchParams.get('linkResultToken')).toMatch(/^[a-f0-9-]{36}$/);
    expect(receiverBefore).toBe(canonicalFrame(surface));expect(new URL(receiverBefore).searchParams.has('linkResultToken')).toBe(false);
    install(f.target);expect(await f.target.SZ_LINK_RESULT_HANDOFF.receive()).toMatchObject({ok:true});expect(await pending).toMatchObject({ok:true});
    expect(f.popup.location.href).toBe(shell.href);expect(f.frame.src).toBe(frameBefore);expect(f.target.location.href).toBe(receiverBefore);
    expect(f.source.state).toEqual(before);expect(f.popup.opener).toBeNull();
  });

  it.each(['wrong-path','wrong-origin','unknown-surface','extra-shell-query','duplicate-token','hash','wrong-frame-query','wrong-frame-src','detached-frame','wrong-frame-owner','nested-parent'])('refuses to inherit a token for %s and sends no material',async kind=>{
    const f=fixture(),pending=f.api.open(input('style-refresh'));await spin();
    const shell=new URL(f.popup.location.href);
    if(kind==='wrong-path')f.popup.location.href=shell.href.replace('/dashboards/operating-network','/some-other-page');
    if(kind==='wrong-origin')f.popup.location.href=shell.href.replace('test.invalid','other.invalid');
    if(kind==='unknown-surface')f.popup.location.href=shell.href.replace('viral-style','main');
    if(kind==='extra-shell-query')f.popup.location.href+='&history=1';
    if(kind==='duplicate-token')f.popup.location.href+='&linkResultToken='+shell.searchParams.get('linkResultToken');
    if(kind==='hash')f.popup.location.href+='#other';
    if(kind==='wrong-frame-query')f.target.location.href+='&extra=1';
    if(kind==='wrong-frame-src')f.frame.src=canonicalFrame('viral-case');
    if(kind==='detached-frame')f.frame.isConnected=false;
    if(kind==='wrong-frame-owner')f.frame.ownerDocument=doc();
    if(kind==='nested-parent')f.popup.parent=windowAt(f.popup.location.href);
    expect(install(f.target)).toBeUndefined();expect(f.target.calls).toEqual([]);
    for(const timeout of f.source.timers.values())timeout();expect(await pending).toMatchObject({ok:false});expect(f.target.state.linkResultDraftId).toBeUndefined();
  });

  it('rejects the popup itself, an unlisted sibling, a duplicate destination and a different popup before claim',async()=>{
    const f=fixture(),pending=f.api.open(input('case-fission'));await spin();const token=new URL(f.popup.location.href).searchParams.get('linkResultToken');
    await expect(f.api.claim(token,f.popup,'account:alice')).rejects.toThrow('失效');
    const sibling=windowAt(f.target.location.href);sibling.parent=f.popup;sibling.top=f.popup;sibling.frameElement={...f.frame,contentWindow:sibling};
    await expect(f.api.claim(token,sibling,'account:alice')).rejects.toThrow('失效');
    f.popup.document.iframeNodes.push(sibling.frameElement);
    await expect(f.api.claim(token,sibling,'account:alice')).rejects.toThrow('失效');await expect(f.api.claim(token,f.target,'account:alice')).rejects.toThrow('失效');
    f.popup.document.iframeNodes.pop();
    const other=windowAt(f.popup.location.href);other.opener=f.source;sibling.parent=other;sibling.frameElement.ownerDocument=other.document;other.document.iframeNodes.push(sibling.frameElement);
    await expect(f.api.claim(token,sibling,'account:alice')).rejects.toThrow('失效');
    const payload=await f.api.claim(token,f.target,'account:alice');expect(payload.action).toBe('case-fission');expect(f.api.complete(token,sibling,{ok:true})).toBe(false);
    expect(f.api.complete(token,f.target,{ok:true})).toBe(true);expect(await pending).toMatchObject({ok:true});
  });

  it('pins the receiving document before the asynchronous account check and blocks same-window reload replay',async()=>{
    const f=fixture(),pending=f.api.open(input());await spin();const token=new URL(f.popup.location.href).searchParams.get('linkResultToken'),check=deferred();
    f.source.SZ_CREATIVE_TOOLS_BRIDGE.getAccountKey=()=>check.promise;
    const claimed=f.api.claim(token,f.target,'account:alice');f.target.document=doc();check.finish('account:alice');
    await expect(claimed).rejects.toThrow('变化');expect(f.api.complete(token,f.target,{ok:true})).toBe(false);expect(f.target.calls).toEqual([]);
    for(const timeout of f.source.timers.values())timeout();expect(await pending).toMatchObject({ok:false});
  });

  it('checks the shell again after local blob materialization before applying any draft',async()=>{
    const f=fixture(),p=input('case-fission'),read=deferred();p.item.url='blob:https://test.invalid/late-local';
    f.target.fetch=async()=>({ok:true,blob:async()=>({size:20})});f.target.FileReader=class {result=img(30);onload=()=>{};readAsDataURL(){void read.promise.then(()=>this.onload());}};
    const pending=f.api.open(p);await spin();install(f.target);const receiving=f.target.SZ_LINK_RESULT_HANDOFF.receive();await spin();
    f.popup.location.href+='&history=1';read.finish('done');expect(await receiving).toMatchObject({ok:false});expect(f.target.calls).toEqual([]);expect(f.target.state.linkResultDraftId).toBeUndefined();
    for(const timeout of f.source.timers.values())timeout();expect(await pending).toMatchObject({ok:false});
  });

  it('keeps direct receivers compatible with their already-bound old sender without allowing a new shell record to use that mode',async()=>{
    const f=fixture(),p=input(),pending=f.api.open(p);await spin();const token=new URL(f.popup.location.href).searchParams.get('linkResultToken');
    const payload=await f.api.claim(token,f.target,'account:alice');f.api.complete(token,f.target,{ok:true});await pending;
    const direct=windowAt(`https://test.invalid/creative/labs/image-prompt-lab/promptlab.html?source=web&mode=main&linkResultToken=${token}`),oldSource=windowAt(f.source.location.href);
    let completed=false;Object.assign(oldSource,{SZ_LINK_RESULT_HANDOFF:{claim:async(received:string,child:Win,account:string)=>{expect(received).toBe(token);expect(child).toBe(direct);expect(account).toBe('account:alice');return structuredClone(payload);},complete:(received:string,child:Win)=>{completed=received===token&&child===direct;return completed;}}});
    direct.opener=oldSource;install(direct);expect(await direct.SZ_LINK_RESULT_HANDOFF.receive()).toMatchObject({ok:true});expect(completed).toBe(true);expect(direct.opener).toBeNull();
    const fresh=fixture(),freshPending=fresh.api.open(input());await spin();const freshToken=new URL(fresh.popup.location.href).searchParams.get('linkResultToken');
    direct.location.href=direct.location.href.replace(token!,freshToken!);direct.opener=fresh.source;await expect(fresh.api.claim(freshToken,direct,'account:alice')).rejects.toThrow('失效');
    for(const timeout of fresh.source.timers.values())timeout();expect(await freshPending).toMatchObject({ok:false});
  });
});

const creativeContract=createRequire(import.meta.url)(resolve(folder,'creative-tools-contract.js'));
function creativeFixture(tool='buyer',count=2,previous=false){
  const f=fixture(`https://test.invalid/creative/labs/image-prompt-lab/promptlab.html?mode=creative&tool=${tool}&source=web`);
  const products=Array.from({length:count},(_,index)=>({name:`商品原图${index+1}`,image:img(index+1)}));
  const plan=creativeContract.createPlan({tool,mode:'tryon',products,modelImage:tool==='refinement'?'':img(70),config:{count:1,name:'原商品',requirements:'保留原款型和材质'}});if(!plan.ok)throw new Error(plan.error);
  const shot=plan.shots[tool==='refinement'?count-1:0],payload=creativeContract.createPayload(plan,shot.id);
  const item={url:img(90),resultId:'creative-job:creative:'+shot.id,jobId:'creative-job',taskId:'supplier-record',batchId:'creative-batch',creativeContractVersion:creativeContract.version,creativeTool:tool,creativeMode:plan.mode,creativeShotId:shot.id,creativePlanSignature:plan.signature,creativePlanSnapshot:structuredClone(payload.contractPlan),productImages:payload.productImages.slice(),modelImages:payload.modelImages.slice(),productName:'原商品',prompt:payload.prompt,ratio:payload.ratio,resolution:payload.resolution,generationRoute:'creative-tools',apiKey:'DO_NOT_COPY',generationConfig:{provider:'saved-api',apiKey:'DO_NOT_COPY'}};
  const slot={shot:structuredClone(shot),status:'done',item:structuredClone(item),archiveContext:{accountKey:'account:alice'}};
  const snapshot={tool,ready:true,startupFailed:false,busy:true,draft:{products:structuredClone(products),config:{provider:'current-api',apiKey:'CURRENT_SECRET'}},controller:{accountKey:'account:alice',plan:structuredClone(plan),slots:previous?[]:[slot],previousResults:previous?[slot]:[]}};
  const getState=vi.fn(()=>structuredClone(snapshot));f.source.SZ_CREATIVE_TOOLS_UI={getState};f.source.state.activeJobId='ongoing-original';
  return {...f,get opened(){return f.opened;},item,slot,snapshot,getState,async startCreative(){const opening=f.api.openCreativeFission(item,'account:alice');await spin();install(f.target);return{opening,receiving:f.target.SZ_LINK_RESULT_HANDOFF.receive()};}};
}

describe('creative result uses the same shell-bound handoff without raw context dispatch',()=>{
  it.each(['clothing','buyer','refinement'])('imports actual %s originals and result reference into fresh viral-case while retaining source/config',async tool=>{
    const f=creativeFixture(tool,tool==='refinement'?50:2),stateBefore=structuredClone(f.source.state),snapshotBefore=structuredClone(f.snapshot),itemBefore=structuredClone(f.item);
    const h=await f.startCreative();expect(await h.receiving).toMatchObject({ok:true,action:'case-fission'});expect(await h.opening).toMatchObject({ok:true,action:'case-fission'});
    expect(new URL(f.popup.location.href).searchParams.get('surface')).toBe('viral-case');expect(f.target.state.refImages).toEqual([f.item.url]);
    expect(f.target.state.linkResultSourceEvidence.products).toEqual(f.item.productImages);expect(f.target.state.productImages.front).toBe(f.item.productImages[0]);
    expect(f.target.state.linkResultProvenance).toMatchObject({schema:'CREATIVE_RESULT_REUSE_V1',tool,shotId:f.item.creativeShotId,sourceJobId:f.item.jobId});
    expect(f.target.state.linkResultProvenance.linkId).toBeUndefined();expect(f.source.state).toEqual(stateBefore);expect(f.snapshot).toEqual(snapshotBefore);expect(f.item).toEqual(itemBefore);
    expect(f.getState).toHaveBeenCalledOnce();expect(JSON.stringify(f.target.state)).not.toMatch(/DO_NOT_COPY|CURRENT_SECRET|generationConfig|current-api/);
    expect(f.target.calls.every((call)=>['product','model','reference'].includes(String(call[0])))).toBe(true);expect(f.popup.opener).toBeNull();
    if(tool==='refinement'){expect(f.item.productImages).toEqual([img(50)]);expect(f.target.state.linkResultSourceEvidence.products).toHaveLength(1);}
  });

  it('accepts an actual historical outdated result using its own snapshot rather than the current plan',async()=>{
    const f=creativeFixture('buyer',2,true);f.slot.status='outdated';f.snapshot.controller.plan={...f.snapshot.controller.plan,signature:'different-current-plan'};
    const h=await f.startCreative();expect(await h.receiving).toMatchObject({ok:true});await h.opening;expect(f.target.state.linkResultSourceEvidence.products).toEqual(f.item.productImages);
  });

  it.each(['account','controller-account','archive-account','tool','ready','missing-result','duplicate-result','result-id','job','shot','signature','mode','version','url','products','models','snapshot-product','snapshot-model','snapshot-shot','material-tool'])('rejects invalid creative %s before opening a popup',async kind=>{
    const f=creativeFixture();let owner='account:alice';
    if(kind==='account')owner='account:bob';if(kind==='controller-account')f.snapshot.controller.accountKey='account:bob';if(kind==='archive-account')f.slot.archiveContext.accountKey='account:bob';
    if(kind==='tool')f.snapshot.tool='clothing';if(kind==='ready')f.snapshot.ready=false;if(kind==='missing-result')f.snapshot.controller.slots=[];if(kind==='duplicate-result')f.snapshot.controller.previousResults.push(structuredClone(f.slot));
    if(kind==='result-id')f.item.resultId='wrong';if(kind==='job')f.item.jobId='wrong';if(kind==='shot')f.item.creativeShotId='wrong';if(kind==='signature')f.item.creativePlanSignature='wrong';if(kind==='mode')f.item.creativeMode='wrong';if(kind==='version')f.item.creativeContractVersion='wrong';if(kind==='url')f.item.url=img(91);
    if(kind==='products')f.item.productImages=[img(98)];if(kind==='models')f.item.modelImages=[];if(kind==='snapshot-product')f.slot.item.creativePlanSnapshot.images.products[0].image=img(98);if(kind==='snapshot-model')f.slot.item.creativePlanSnapshot.images.modelImage=img(98);if(kind==='snapshot-shot')f.slot.item.creativePlanSnapshot.shot.id='wrong';
    if(kind==='material-tool'){f.snapshot.tool='model';f.slot.item.creativeTool='model';f.item.creativeTool='model';}
    const before=structuredClone(f.snapshot);expect(await f.api.openCreativeFission(f.item,owner)).toMatchObject({ok:false});expect(f.opened).toBe(0);expect(f.snapshot).toEqual(before);expect(f.target.calls).toEqual([]);
  });

  it('opens synchronously and closes only the empty popup when the live creative account changes',async()=>{
    const f=creativeFixture(),wait=deferred();f.source.SZ_CREATIVE_TOOLS_BRIDGE.getAccountKey=()=>wait.promise;
    const opening=f.api.openCreativeFission(f.item,'account:alice');expect(f.opened).toBe(1);expect(f.popup.location.href).toBe('about:blank');wait.finish('account:bob');
    expect(await opening).toMatchObject({ok:false});expect(f.popup.closed).toBe(true);expect(f.source.state.activeJobId).toBe('ongoing-original');expect(f.target.calls).toEqual([]);
  });
});
