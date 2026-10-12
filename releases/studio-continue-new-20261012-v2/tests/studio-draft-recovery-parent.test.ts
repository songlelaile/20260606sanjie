// Adapted from the published draft-recovery V3 suite; only checkpoint revision expectations changed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const assetRoot = process.env.CREATIVE_ASSET_TEST_ROOT || "assets/public/creative";
const source = (name: string) => readFileSync(resolve(assetRoot, "labs/image-prompt-lab", name), "utf8");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const accountKey = "account:startup-fixture";
const provider = { provider: "openai-compatible", label: "Fixture API", imageModel: "fixture-catalog-image" };
type Catalog = { ok: boolean; accountKey?: string; providers?: typeof provider[]; error?: string };

function deferred<T>() {
  let complete!: (value: T) => void, fail!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => { complete = resolve; fail = reject; });
  return { promise, complete, fail };
}

type DomEvent = { type: string; target: Element; preventDefault: () => void; dataTransfer?: { files: unknown[] } };
type UnloadEvent = { preventDefault: () => void; returnValue?: string };

// This DOM only supplies the APIs used by the real UI. The actual script builds
// all controls; assertions never substitute a hand-written workspace or boot.
class Element {
  readonly attributes = new Map<string, string>();
  readonly children: Element[] = [];
  readonly listeners = new Map<string, Array<(event: DomEvent) => void>>();
  parentNode: Element | null = null;
  value = "";
  checked = false;
  text = "";
  onclick: ((event: DomEvent) => void) | null = null;
  private markup = "";
  constructor(readonly tagName: string, readonly document: TestDocument) {}
  get id() { return this.attributes.get("id") || ""; }
  set id(value: string) { this.attributes.set("id", value); }
  get dataset() {
    return Object.fromEntries([...this.attributes].filter(([key]) => key.startsWith("data-")).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()), value]));
  }
  get disabled() { return this.attributes.has("disabled"); }
  set disabled(value: boolean) { if (value) this.attributes.set("disabled", ""); else this.attributes.delete("disabled"); }
  get hidden() { return this.attributes.has("hidden"); }
  set hidden(value: boolean) { if (value) this.attributes.set("hidden", ""); else this.attributes.delete("hidden"); }
  get type() { return this.attributes.get("type") || ""; }
  get classList() {
    const contains = (name: string) => (this.attributes.get("class") || "").split(/\s+/).includes(name);
    const toggle = (name: string, force = !contains(name)) => {
      const names = new Set((this.attributes.get("class") || "").split(/\s+/).filter(Boolean));
      if (force) names.add(name); else names.delete(name);
      this.attributes.set("class", [...names].join(" "));
      return force;
    };
    return { contains, toggle, add: (name: string) => toggle(name, true), remove: (name: string) => toggle(name, false) };
  }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.children.splice(0); this.text = value; }
  get innerHTML() { return this.markup; }
  set innerHTML(value: string) {
    const fault=this.document.renderFault;
    if (fault && fault.remaining>0 && fault.matches(value)) { fault.remaining--;throw new Error('fixture workspace render failed'); }
    this.markup = value;
    this.children.splice(0); this.text = "";
    this.document.renders.push(value);
    const stack: Element[] = [this], voidTags = new Set(["input", "img", "br", "hr"]);
    for (const match of value.matchAll(/<\/?([a-z][a-z0-9-]*)([^>]*?)>|([^<]+)/gi)) {
      if (match[3]) { stack[stack.length - 1].text += match[3]; continue; }
      const tag = match[1].toLowerCase();
      if (match[0].startsWith("</")) {
        while (stack.length > 1) if (stack.pop()?.tagName === tag.toUpperCase()) break;
        continue;
      }
      const child = new Element(tag.toUpperCase(), this.document);
      for (const attribute of match[2].matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) child.attributes.set(attribute[1], attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
      child.value = child.attributes.get("value") || "";
      child.checked = child.attributes.has("checked");
      stack[stack.length - 1].appendChild(child);
      if (!voidTags.has(tag) && !match[0].endsWith("/>")) stack.push(child);
    }
  }
  appendChild(child: Element) { child.parentNode = this; this.children.push(child); return child; }
  prepend(child: Element) { child.parentNode = this; this.children.unshift(child); }
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  matches(selector: string): boolean {
    return selector.split(",").some(part => {
      const simple = part.trim();
      if (simple.startsWith("#")) return this.id === simple.slice(1);
      if (simple.startsWith(".")) return this.classList.contains(simple.slice(1));
      const attribute = /^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\](:checked)?$/.exec(simple);
      if (attribute) return this.attributes.has(attribute[1]) && (!attribute[2] || this.attributes.get(attribute[1]) === attribute[2]) && (!attribute[3] || this.checked);
      return this.tagName === simple.toUpperCase();
    });
  }
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  querySelectorAll(selector: string) { return this.descendants().filter(element => element.matches(selector)); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  setAttribute(name: string, value: string) { this.attributes.set(name,value); }
  focus() {}
  addEventListener(name: string, listener: (event: DomEvent) => void) {
    const list = this.listeners.get(name) || []; list.push(listener); this.listeners.set(name, list);
  }
  dispatch(type: string, target: Element, extra: Partial<DomEvent> = {}) {
    const event: DomEvent = { type, target, preventDefault: vi.fn(), ...extra };
    if (type === "click") this.onclick?.(event);
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

class TestDocument {
  readonly renders: string[] = [];
  readonly documentElement = new Element("HTML", this);
  renderFault?: { remaining: number; matches: (value: string) => boolean };
  readonly body = new Element("BODY", this);
  readonly app = new Element("DIV", this);
  readonly readyState = "complete";
  readonly visibilityState = "visible";
  constructor() { this.app.attributes.set("class", "app"); this.body.appendChild(this.app); }
  createElement(tag: string) { return new Element(tag.toUpperCase(), this); }
  querySelector(selector: string) { return this.body.querySelector(selector); }
  getElementById(id: string) { return this.querySelector(`#${id}`); }
  addEventListener() {}
  get root() {
    const root = this.getElementById("studioGenesisRoot");
    if (!root) throw new Error("The real UI has not created its root");
    return root;
  }
  control(selector: string) {
    const control = this.root.querySelector(selector);
    if (!control) throw new Error(`The real UI did not render ${selector}`);
    return control;
  }
}

type RecordValue = {draft: any; snapshot: any; savedAt?: string};
type Receipt = {accountKey:string; jobId:string; taskId:string; shotId:string; batchId:string; createdAt:number};
function harness(entry: 'main'|'detail'|'ad' = 'detail', batch = false, seed?: {rows: Map<string,RecordValue>; storage: Map<string,string>}) {
  const mode = entry==='detail'?'detail':'main';
  const document=new TestDocument(), rows=seed?.rows || new Map<string,RecordValue>(), storage=seed?.storage || new Map<string,string>();
  const writes:Array<{key:string;value:RecordValue}>=[], reads:string[]=[], controllers:any[]=[], dependencies:any[]=[];
  const controls:{failKey?:string; failPrefix?:string; readWait?:Promise<void>; beforeRead?:(key:string)=>void; writeWait?:Promise<void>}={};
  const bridge={refresh:vi.fn(async()=>({ok:true,accountKey})),getAccountKey:vi.fn(async()=>accountKey),
    listBoundApis:vi.fn(async()=>({ok:true,accountKey,providers:[provider]})),
    modelInfo:vi.fn(()=>({ready:true,supportsReference:true,provider:provider.provider,model:provider.imageModel})),
    config:vi.fn(()=>({provider:provider.provider,apiKey:'fixture-test-only',imageModel:provider.imageModel})),
    setApiBusy:vi.fn(),send:vi.fn(),analyze:vi.fn(),archiveContext:vi.fn(()=>({accountKey})),archive:vi.fn(async()=>({ok:true}))};
  const db={transaction:()=>{
    let pending=0,completed=false;
    const pendingWrites=new Map<string,RecordValue>();
    const settled=()=>{
      pending--;
      if(!pending)queueMicrotask(()=>{
        if(pending || completed)return;
        completed=true;for(const [key,value] of pendingWrites)rows.set(key,value);tx.oncomplete?.();
      });
    };
    const tx={oncomplete:undefined as (()=>void)|undefined,onerror:undefined as (()=>void)|undefined,onabort:undefined as (()=>void)|undefined,error:undefined as Error|undefined,
      objectStore:()=>({get:(key:string)=>{
        pending++;
        reads.push(key);const request={result:undefined as unknown,onsuccess:undefined as (()=>void)|undefined};
        Promise.resolve(controls.readWait).then(()=>{if(completed)return;controls.beforeRead?.(key);request.result=rows.has(key)?clone(rows.get(key)):undefined;request.onsuccess?.();settled();});return request;
      },put:(value:RecordValue,key:string)=>{
        pending++;
        const captured=clone(value);writes.push({key,value:captured});
        Promise.resolve(controls.writeWait).then(()=>{if(completed)return;if(controls.failKey===key || controls.failPrefix && key.startsWith(controls.failPrefix)){completed=true;tx.error=new Error('fixture storage failed');tx.onerror?.();}else{pendingWrites.set(key,captured);settled();}});
      }}),abort:vi.fn(()=>{completed=true;tx.onabort?.();})};return tx;
  },close:vi.fn()};
  const indexedDB={open:vi.fn(()=>{const request={result:db,onsuccess:undefined as (()=>void)|undefined};queueMicrotask(()=>request.onsuccess?.());return request;})};
  const context=createContext({document,indexedDB,URL,URLSearchParams,crypto:{randomUUID},console,setTimeout,clearTimeout,
    location:{search:`?studio=1&mode=${mode}${entry==='ad'?'&type=ad':''}${batch?'&batch=1':''}`},
    navigator:{locks:{request:async(name:string,_options:unknown,callback:(lock:{name:string})=>unknown)=>callback({name})}},
    localStorage:{get length(){return storage.size},key:(index:number)=>[...storage.keys()][index]??null,getItem:(key:string)=>storage.get(key)??null,
      setItem:vi.fn((key:string,value:string)=>storage.set(key,value)),removeItem:vi.fn((key:string)=>storage.delete(key))},
    addEventListener:vi.fn(),SZ_CREATIVE_TOOLS_BRIDGE:bridge});context.window=context;
  runInContext(source('studio-genesis-contract.js'),context);
  const engine=context.SZ_STUDIO_GENESIS;
  const uploadContext=createContext({document:{readyState:'loading',addEventListener:vi.fn()}});uploadContext.window=uploadContext;
  runInContext(source('image-upload.js'),uploadContext);context.SZ_IMAGE_UPLOAD=uploadContext.SZ_IMAGE_UPLOAD;
  context.SZ_STUDIO_GENESIS={...engine,createController:(deps:any)=>{const result=engine.createController(deps);controllers.push(result);dependencies.push(deps);return result;}};
  const key=(type:string)=>`${accountKey}:${batch?'batch':'single'}:${type==='detail'?'detail':'main'}${type==='ad'?':ad':''}`;
  function record(type:'main'|'detail'|'ad', count=type==='detail'?5:1, success=true):RecordValue {
    const settings={...engine.defaults(type==='detail'?'detail':'main'),count,model:provider.imageModel};
    if(type==='ad')Object.assign(settings,{imageType:'ad',adTemplate:engine.adTemplates[0].id,adType:'电商广告'});
    const task={id:`original-${type}`,name:`${type} fixture`,products:[{image:'https://fixture.test/product.png',name:'product'}],requirements:`${type} brief`,analysis:{fixture:type},overrides:null,confirmed:true,collapsed:false,plan:null as any};
    task.plan=engine.createPlan(task,settings);
    if(type==='detail'&&task.plan.shots.length!==count){settings.modules=engine.detailModules.slice(0,count).map((x:any)=>x.label);task.plan=engine.createPlan(task,settings);}
    const saved=engine.createController({bridge});saved.state.accountKey=accountKey;saved.state.batchId=`batch-${type}`;
    saved.state.tasks=[{id:task.id,name:task.name,plan:clone(task.plan),slots:task.plan.shots.map((shot:any,index:number)=>({shot:clone(shot),status:success&&index===0?'done':'ready',item:success&&index===0?{url:'https://fixture.test/original-success.png',accountKey,jobId:`success-${type}`,resultId:`success-${type}:studio:${shot.id}`,studioTaskId:task.id,batchId:`batch-${type}`,studioGenesisPlan:clone(task.plan)}:null,error:'',archiveOk:success&&index===0,archiveSaving:false}))}];
    return {draft:{settings,tasks:[task]},snapshot:saved.snapshot(),savedAt:'2026-10-11T10:00:00.000Z'};
  }
  function markUnknown(value:RecordValue,start=1,scope=entry) {
    value.snapshot.tasks[0].slots.forEach((slot:any,index:number)=>{if(index<start)return;const receipt:Receipt={accountKey,jobId:`pending-${value.draft.tasks[0].id}-${index}`,taskId:value.draft.tasks[0].id,shotId:slot.shot.id,batchId:value.snapshot.batchId,createdAt:1791720000000+index};
      slot.status='uncertain';slot.pendingReceipt=receipt;slot.receiptJobId=receipt.jobId;
      value.snapshot.pendingReceipts.push(clone(receipt));value.snapshot.uncertain=clone(receipt);
      storage.set(`sz_studio_genesis_pending_v2:${key(scope)}:${receipt.jobId}`,JSON.stringify(receipt));});
  }
  function execute(){runInContext(source('studio-genesis-ui.js'),context);}
  function start(value=record(entry)){rows.set(key(entry),clone(value));execute();}
  async function bootExisting(){execute();await vi.waitFor(()=>expect(document.root.querySelector('[data-setting=model]')?.disabled,document.root.textContent).toBe(false));}
  async function boot(value=record(entry)){start(value);await vi.waitFor(()=>expect(document.root.querySelector('[data-setting=model]')?.disabled,document.root.textContent).toBe(false));}
  const click=(selector:string)=>document.root.dispatch('click',document.control(selector));
  async function switchTo(type:'main'|'detail'|'ad'){click(`[data-mode=${type}]`);await vi.waitFor(()=>{expect(document.control(`[data-mode=${type}]`).attributes.get('aria-selected')).toBe('true');expect(document.control(`[data-mode=${type}]`).disabled).toBe(false);});}
  return {document,bridge,engine,rows,storage,controllers,dependencies,reads,writes,controls,key,record,markUnknown,start,boot,click,switchTo,context,
    execute,bootExisting,active:()=>controllers[controllers.length-1]};
}

const recoveryKey = (h: ReturnType<typeof harness>, type: string) => `${h.key(type)}:type-recovery-v1`;
const checkpointPrefix = (h: ReturnType<typeof harness>, type: string) => `${h.key(type)}:before-explicit-mode:`;
const checkpointRows = (h: ReturnType<typeof harness>, type: string) => [...h.rows.entries()].filter(([key]) => key.startsWith(checkpointPrefix(h,type)));
// CAS adds only a storage revision; assert it exists and compare the retained payload in full.
function checkpointPayload(value:RecordValue) {
  const {revision,...payload}=value as RecordValue & {revision:string};
  expect(revision).toMatch(/^[0-9a-f-]{36}$/i);
  return payload;
}
async function expectRecovery(h: ReturnType<typeof harness>, type: 'main'|'detail'|'ad') {
  await vi.waitFor(() => expect(h.rows.has(recoveryKey(h,type))).toBe(true));
  return h.rows.get(recoveryKey(h,type))!;
}
function expectNoGeneration(h: ReturnType<typeof harness>) {
  expect(h.bridge.send.mock.calls.filter(([action]) => action !== 'GET_IMAGE_RECEIPT')).toEqual([]);
  expect(h.bridge.analyze).not.toHaveBeenCalled();
}

describe('legacy mixed image drafts become usable without mutating old requests', () => {
  it.each(['single','batch'])('opens an independent main editor while retaining the complete old detail draft in %s scope', async kind => {
    const h=harness('main',kind==='batch'), saved=h.record('detail');h.markUnknown(saved);
    const original=clone(saved), journals=[...h.storage.entries()];await h.boot(saved);
    const recovered=await expectRecovery(h,'main');
    expect(h.rows.get(h.key('main'))).toEqual(original);
    expect(checkpointRows(h,'main').map(([,value])=>checkpointPayload(value))).toEqual([original]);
    expect(recovered.draft.settings.mode).toBe('main');
    expect(recovered.draft.tasks[0].name).toBe(saved.draft.tasks[0].name);
    expect(recovered.draft.tasks[0].products).toEqual(saved.draft.tasks[0].products);
    expect(recovered.draft.tasks[0].requirements).toBe('');
    expect(recovered.draft.tasks[0].id).not.toBe(saved.draft.tasks[0].id);
    expect(recovered.draft.tasks[0].plan).toBeNull();expect(recovered.draft.tasks[0].confirmed).toBe(false);
    expect(h.active().state.tasks).toEqual([]);
    expect(h.dependencies.at(-1).workspaceKey).toBe(`${kind}:main`);
    expect([...h.storage.entries()]).toEqual(journals);expectNoGeneration(h);
    expect(h.document.root.textContent).not.toContain('创作工作台暂未就绪');
  });
  it.each(['detail','ad'] as const)('opens the requested %s editor from a misplaced main draft', async requested => {
    const h=harness(requested), saved=h.record('main');await h.boot(saved);
    const recovered=await expectRecovery(h,requested);
    expect(recovered.draft.settings.mode).toBe(requested==='detail'?'detail':'main');
    expect(recovered.draft.settings.imageType==='ad').toBe(requested==='ad');
    expect(recovered.draft.tasks[0].requirements).toBe('');
    expect(recovered.draft.tasks[0].plan).toBeNull();expect(recovered.draft.tasks[0].confirmed).toBe(false);
    expect(h.rows.get(h.key(requested))).toEqual(saved);expectNoGeneration(h);
  });
  it('recovers requested-type input fields with new task identities and no approval', async () => {
    const h=harness('main'), saved=h.record('detail'), priorMain=h.record('main');
    priorMain.draft.settings.ratio=h.engine.ratios.find((ratio:string)=>ratio!=='1:1') || h.engine.ratios[0];
    saved.draft.typeSettings={main:clone(priorMain.draft.settings)};
    saved.draft.typeSteps={main:3};
    saved.draft.tasks[0].typeDrafts={main:{requirements:'preserved main input',analysis:'preserved main analysis',overrides:null,plan:priorMain.draft.tasks[0].plan,confirmed:true}};
    const original=clone(saved);await h.boot(saved);const recovered=await expectRecovery(h,'main');
    expect(recovered.draft.settings.ratio).toBe(priorMain.draft.settings.ratio);
    expect(recovered.draft.tasks[0].requirements).toBe('preserved main input');
    expect(recovered.draft.tasks[0].id).not.toBe(saved.draft.tasks[0].id);
    expect(recovered.draft.tasks[0].plan).toBeNull();expect(recovered.draft.tasks[0].confirmed).toBe(false);
    expect(h.active().state.tasks).toEqual([]);expect(h.rows.get(h.key('main'))).toEqual(original);expectNoGeneration(h);
  });
  it('isolates an old foreign-type snapshot even when the editable draft type matches the URL', async () => {
    const h=harness('main'), saved=h.record('main'), oldDetail=h.record('detail');
    h.markUnknown(oldDetail);saved.snapshot=clone(oldDetail.snapshot);await h.boot(saved);
    const recovered=await expectRecovery(h,'main');
    expect(h.rows.get(h.key('main'))).toEqual(saved);expect(recovered.snapshot?.tasks || []).toEqual([]);
    expect(recovered.draft.tasks[0].plan).toBeNull();expect(recovered.draft.tasks[0].confirmed).toBe(false);
    expect(h.storage.size).toBe(4);expectNoGeneration(h);
  });
  it('keeps an exact durable unknown receipt in its original scope and does not query it against a new task', async () => {
    const h=harness('main'), saved=h.record('detail');h.markUnknown(saved);
    for(const [key,raw] of h.storage) {
      const receipt=JSON.parse(raw);Object.assign(receipt,{receiptVersion:1,receiptId:randomUUID(),workspaceKey:'single:main',planSignatureHash:'a'.repeat(64)});
      h.storage.set(key,JSON.stringify(receipt));
      const slot=saved.snapshot.tasks[0].slots.find((slot:any)=>slot.pendingReceipt?.jobId===receipt.jobId);slot.pendingReceipt=clone(receipt);
    }
    const journals=[...h.storage.entries()], original=clone(saved);await h.boot(saved);await expectRecovery(h,'main');
    expect([...h.storage.entries()]).toEqual(journals);expect(h.rows.get(h.key('main'))).toEqual(original);
    expect(h.active().state.tasks).toEqual([]);expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it('provides a read-only view containing preserved inputs, successful images and unknown tasks', async () => {
    const h=harness('main'), saved=h.record('detail');h.markUnknown(saved);
    saved.draft.tasks[0].requirements='original detail description';
    const oldPrevious=clone(saved.snapshot.tasks[0].slots[0]);oldPrevious.item.url='https://fixture.test/previous-original.png';oldPrevious.item.resultId='old-previous-image';
    saved.snapshot.previousResults.push(oldPrevious);await h.boot(saved);
    const before=clone(h.rows.get(h.key('main'))!), journals=[...h.storage.entries()], count=h.writes.length;
    h.click('[data-action=legacy-tasks]');
    await vi.waitFor(()=>expect(h.document.getElementById('sgDialog')?.hidden).toBe(false));
    const modal=h.document.getElementById('sgDialog')!;
    expect(modal.textContent).toContain('original detail description');
    const sources=modal.querySelectorAll('img').map(img=>img.attributes.get('src'));
    expect(sources).toContain('https://fixture.test/product.png');
    expect(sources).toContain('https://fixture.test/original-success.png');
    expect(sources).toContain('https://fixture.test/previous-original.png');
    expect(modal.textContent).toMatch(/确认|回执|未完成|未知/);
    expect(modal.querySelector('[data-action=generate]')).toBeNull();
    expect(modal.querySelector('[data-action=retry]')).toBeNull();
    expect(h.writes).toHaveLength(count);expect(h.rows.get(h.key('main'))).toEqual(before);
    expect([...h.storage.entries()]).toEqual(journals);expectNoGeneration(h);
  });
  it('saves edits to the recovery row and can leave the usable editor without changing the legacy record', async () => {
    const h=harness('main'), saved=h.record('detail');await h.boot(saved);await expectRecovery(h,'main');
    const name=h.document.control('[data-task-field=name]');name.value='current main edited';h.document.root.dispatch('input',name);
    expect((await h.context.SanjieStudioGenesisBridge.canDeactivate()).allowed).toBe(true);
    expect(h.rows.get(recoveryKey(h,'main'))!.draft.tasks[0].name).toBe('current main edited');
    expect(h.rows.get(h.key('main'))).toEqual(saved);
    expect(h.writes.filter(write=>write.key===h.key('main'))).toEqual([]);expectNoGeneration(h);
  });
  it('prefers an existing requested-type recovery row on reload without another checkpoint or task identity', async () => {
    const h=harness('main'), saved=h.record('detail');await h.boot(saved);const recovered=await expectRecovery(h,'main');
    const originalId=recovered.draft.tasks[0].id;
    const name=h.document.control('[data-task-field=name]');name.value='reload main input';h.document.root.dispatch('input',name);
    await h.context.SanjieStudioGenesisBridge.canDeactivate();
    const second=harness('main',false,{rows:h.rows,storage:h.storage});await second.bootExisting();
    expect(second.document.control('[data-task-field=name]').value).toBe('reload main input');
    expect(second.rows.get(recoveryKey(second,'main'))!.draft.tasks[0].id).toBe(originalId);
    expect(second.writes.filter(write=>write.key.includes(':before-explicit-mode:'))).toEqual([]);
    expect(second.rows.get(second.key('main'))).toEqual(saved);expectNoGeneration(second);
  });
  it('recovers a mixed target during type switching and retains both current and target workspaces', async () => {
    const h=harness('detail'), mainLegacy=h.record('ad');h.rows.set(h.key('main'),clone(mainLegacy));await h.boot();
    const detailBefore=clone(h.rows.get(h.key('detail'))!);await h.switchTo('main');
    const recovered=await expectRecovery(h,'main');
    expect(h.rows.get(h.key('main'))).toEqual(mainLegacy);expect(checkpointRows(h,'main').map(([,value])=>checkpointPayload(value))).toEqual([mainLegacy]);
    expect(recovered.draft.settings.mode).toBe('main');expect(recovered.draft.settings.imageType).not.toBe('ad');
    expect(h.active().state.tasks).toEqual([]);await h.switchTo('detail');
    expect(h.active().state.tasks[0].plan).toEqual(detailBefore.snapshot.tasks[0].plan);
    const recoveredId=recovered.draft.tasks[0].id;await h.switchTo('main');
    expect(h.rows.get(recoveryKey(h,'main'))!.draft.tasks[0].id).toBe(recoveredId);expectNoGeneration(h);
  });
  it('does not overwrite a valid canonical target draft while leaving a recovered source', async () => {
    const h=harness('main'), saved=h.record('ad'), detail=h.record('detail');h.rows.set(h.key('detail'),clone(detail));
    await h.boot(saved);await h.switchTo('detail');
    expect(h.active().state.tasks[0].plan).toEqual(detail.snapshot.tasks[0].plan);
    expect(h.rows.has(recoveryKey(h,'detail'))).toBe(false);
    expect(h.rows.get(h.key('main'))).toEqual(saved);await h.switchTo('main');
    expect(h.active().state.tasks).toEqual([]);expectNoGeneration(h);
  });
  it('keeps matching canonical drafts on their original key with their approved plan and original result', async () => {
    const h=harness('main'), saved=h.record('main');await h.boot(saved);
    expect(h.rows.has(recoveryKey(h,'main'))).toBe(false);
    expect(h.active().state.tasks[0].plan).toEqual(saved.snapshot.tasks[0].plan);
    expect(h.active().state.tasks[0].slots[0].item).toEqual(saved.snapshot.tasks[0].slots[0].item);
    expect(h.document.control('[data-confirm]').checked).toBe(true);
    await h.context.SanjieStudioGenesisBridge.canDeactivate();expect(h.writes.at(-1)!.key).toBe(h.key('main'));expectNoGeneration(h);
  });
  it('does not duplicate or expose a legacy snapshot owned by another account', async () => {
    const h=harness('main'), saved=h.record('detail');saved.snapshot.accountKey='other-account';h.start(saved);
    await vi.waitFor(()=>expect(h.document.root.textContent).toContain('其他账号'));
    expect(h.document.root.querySelector('[data-action=generate]')).toBeNull();
    expect(h.document.root.querySelector('[data-action=legacy-tasks]')).toBeNull();
    expect(h.writes).toEqual([]);expect(h.rows.get(h.key('main'))).toEqual(saved);expectNoGeneration(h);
  });
  it('does not adopt a recovery row owned by another account', async () => {
    const h=harness('main'), saved=h.record('detail'), recovery=h.record('main');recovery.snapshot.accountKey='other-account';
    h.rows.set(recoveryKey(h,'main'),clone(recovery));h.start(saved);
    await vi.waitFor(()=>expect(h.document.root.textContent).toContain('其他账号'));
    expect(h.document.root.querySelector('[data-action=generate]')).toBeNull();
    expect(h.rows.get(recoveryKey(h,'main'))).toEqual(recovery);expect(h.rows.get(h.key('main'))).toEqual(saved);expectNoGeneration(h);
  });
  it('retains the legacy draft when its checkpoint fails and opens the editor after an explicit retry succeeds', async () => {
    const h=harness('main'), saved=h.record('detail');h.controls.failPrefix=checkpointPrefix(h,'main');h.start(saved);
    await vi.waitFor(()=>expect(h.document.root.textContent).toContain('fixture storage failed'));
    expect(h.rows.get(h.key('main'))).toEqual(saved);expect(h.rows.has(recoveryKey(h,'main'))).toBe(false);
    expect(h.document.root.querySelector('[data-action=generate]')).toBeNull();
    h.controls.failPrefix=undefined;h.click('[data-action=retry-startup]');
    await vi.waitFor(()=>expect(h.document.root.querySelector('[data-setting=model]')?.disabled,h.document.root.textContent).toBe(false));
    await expectRecovery(h,'main');expect(h.rows.get(h.key('main'))).toEqual(saved);expectNoGeneration(h);
  });
  it('stays on the usable current type if a mixed target checkpoint cannot be stored', async () => {
    const h=harness('detail'), mainLegacy=h.record('ad');h.rows.set(h.key('main'),clone(mainLegacy));await h.boot();
    h.controls.failPrefix=checkpointPrefix(h,'main');h.click('[data-mode=main]');
    await vi.waitFor(()=>expect(h.document.root.textContent).toContain('fixture storage failed'));
    expect(h.document.control('[data-mode=detail]').attributes.get('aria-selected')).toBe('true');
    expect(h.document.control('[data-mode=detail]').disabled).toBe(false);
    expect(h.rows.get(h.key('main'))).toEqual(mainLegacy);expect(h.rows.has(recoveryKey(h,'main'))).toBe(false);expectNoGeneration(h);
  });
  it('does not migrate after the account changes during legacy storage reads', async () => {
    const h=harness('main'), saved=h.record('detail');h.controls.beforeRead=key=>{if(key===h.key('main'))h.bridge.getAccountKey.mockResolvedValue('other-account');};h.start(saved);
    await vi.waitFor(()=>expect(h.document.root.textContent).toContain('账号已变化'));
    expect(h.rows.get(h.key('main'))).toEqual(saved);expect(h.writes).toEqual([]);
    expect(h.document.root.querySelector('[data-action=generate]')).toBeNull();expectNoGeneration(h);
  });
  it('does not replace the source when another page edits it during checkpoint saving', async () => {
    const h=harness('main'), saved=h.record('detail'), hold=deferred<void>();h.controls.writeWait=hold.promise;h.start(saved);
    await vi.waitFor(()=>expect(h.writes.some(write=>write.key.startsWith(checkpointPrefix(h,'main')))).toBe(true));
    const newer=clone(saved);newer.draft.tasks[0].requirements='newer detail input in another page';h.rows.set(h.key('main'),newer);hold.complete();
    await vi.waitFor(()=>expect(h.document.root.textContent).toContain('其他页面更新'));
    expect(h.rows.get(h.key('main'))).toEqual(newer);expect(h.rows.has(recoveryKey(h,'main'))).toBe(false);
    expect(checkpointRows(h,'main').map(([,value])=>checkpointPayload(value))).toEqual([saved]);
    expect(h.document.root.querySelector('[data-action=generate]')).toBeNull();expectNoGeneration(h);
  });
  it('reuses a recovery draft another page created during the backup without overwriting its input', async () => {
    const h=harness('main'), saved=h.record('detail'), hold=deferred<void>();h.controls.writeWait=hold.promise;h.start(saved);
    await vi.waitFor(()=>expect(h.writes.some(write=>write.key.startsWith(checkpointPrefix(h,'main')))).toBe(true));
    const backupKey=h.writes.find(write=>write.key.startsWith(checkpointPrefix(h,'main')))!.key;
    const other=h.record('main');other.draft.legacyBackupKey=backupKey;other.draft.tasks[0].id='another-page-main-input';
    other.draft.tasks[0].name='other page saved name';other.draft.tasks[0].requirements='other page saved requirements';
    other.draft.tasks[0].plan=null;other.draft.tasks[0].confirmed=false;
    const empty=h.engine.createController({bridge:h.bridge});empty.state.accountKey=accountKey;other.snapshot=empty.snapshot();
    h.rows.set(recoveryKey(h,'main'),clone(other));hold.complete();
    await vi.waitFor(()=>expect(h.document.root.querySelector('[data-setting=model]')?.disabled,h.document.root.textContent).toBe(false));
    expect(h.document.control('[data-task-field=name]').value).toBe('other page saved name');
    expect(h.rows.get(recoveryKey(h,'main'))).toEqual(other);
    expect(h.writes.filter(write=>write.key===recoveryKey(h,'main'))).toEqual([]);
    expect(h.rows.get(h.key('main'))).toEqual(saved);expectNoGeneration(h);
  });
  it('keeps new projects and restored projects in the recovery row across reloads', async () => {
    const h=harness('main'), saved=h.record('detail');await h.boot(saved);await expectRecovery(h,'main');
    h.click('[data-action=plan]');await vi.waitFor(()=>expect(h.document.root.querySelector('[data-action=new-project]')).not.toBeNull());
    const beforeProject=clone(h.rows.get(recoveryKey(h,'main'))!);h.click('[data-action=new-project]');
    await vi.waitFor(()=>expect(h.document.root.textContent).toContain('上一项目已保留'));
    const newDraft=clone(h.rows.get(recoveryKey(h,'main'))!);
    expect(newDraft.draft.tasks[0].id).not.toBe(beforeProject.draft.tasks[0].id);
    expect(newDraft.draft.legacyBackupKey).toBe(beforeProject.draft.legacyBackupKey);
    expect(h.rows.get(h.key('main'))).toEqual(saved);
    const second=harness('main',false,{rows:h.rows,storage:h.storage});await second.bootExisting();
    expect(second.rows.get(recoveryKey(second,'main'))!.draft.tasks[0].id).toBe(newDraft.draft.tasks[0].id);
    expect(second.document.root.querySelector('[data-action=legacy-tasks]')).not.toBeNull();
    second.click('[data-action=restore-project]');await vi.waitFor(()=>expect(second.document.root.textContent).toContain('已恢复上一项目'));
    expect(second.rows.get(recoveryKey(second,'main'))!.draft.tasks[0].id).toBe(beforeProject.draft.tasks[0].id);
    expect(second.rows.get(second.key('main'))).toEqual(saved);expectNoGeneration(h);expectNoGeneration(second);
  });
  it('can retry repeated post-binding render failures without duplicate click handlers or duplicate saves', async () => {
    const h=harness('main'), saved=h.record('main');
    h.document.renderFault={remaining:2,matches:value=>value.includes('data-setting="model"') || value.includes('data-setting=model')};
    h.start(saved);await vi.waitFor(()=>expect(h.document.root.textContent).toContain('fixture workspace render failed'));
    expect(h.document.documentElement.attributes.get('data-studio-startup')).toBe('error');
    expect(h.document.root.listeners.get('click')).toHaveLength(1);expect(h.rows.get(h.key('main'))).toEqual(saved);
    h.click('[data-action=retry-startup]');
    await vi.waitFor(()=>{expect(h.bridge.refresh).toHaveBeenCalledTimes(2);expect(h.document.root.textContent).toContain('fixture workspace render failed');});
    expect(h.document.root.listeners.get('click')).toHaveLength(1);
    h.click('[data-action=retry-startup]');
    await vi.waitFor(()=>expect(h.document.root.querySelector('[data-setting=model]')?.disabled,h.document.root.textContent).toBe(false));
    expect(h.bridge.refresh).toHaveBeenCalledTimes(3);
    expect(h.document.documentElement.attributes.get('data-studio-startup')).toBe('ready');
    expect(h.document.root.listeners.get('click')).toHaveLength(1);
    const writesBefore=h.writes.length;h.click('[data-action=plan]');
    await vi.waitFor(()=>expect(h.document.root.textContent).toContain('方案已整理'));
    expect(h.writes).toHaveLength(writesBefore+1);expectNoGeneration(h);
  });
  it('restores the host startup failure signal after first-paint completion clears a prior timeout marker', async () => {
    const h=harness('main'), saved=h.record('main');
    h.document.documentElement.classList.add('studio-genesis-page');
    h.document.documentElement.attributes.set('data-lab-first-paint-failure','timeout');
    const completion=vi.fn((status:string)=>{
      if(status==='error')h.document.documentElement.attributes.delete('data-lab-startup');
    });
    h.context.SZ_LAB_FIRST_PAINT={complete:completion};
    h.bridge.refresh.mockResolvedValue({ok:false,error:'fixture recovery read failed'} as any);
    h.start(saved);await vi.waitFor(()=>expect(completion).toHaveBeenCalledWith('error'));
    expect(h.document.documentElement.attributes.get('data-lab-startup')).toBe('error');
    expect(h.document.documentElement.attributes.get('data-studio-startup')).toBe('error');
    expect(h.document.root.textContent).toContain('fixture recovery read failed');
    expect(h.document.root.querySelector('[data-action=retry-startup]')).not.toBeNull();
    expect(h.rows.get(h.key('main'))).toEqual(saved);expect(h.writes).toEqual([]);expectNoGeneration(h);
  });
  it('keeps fatal script or stylesheet errors on the generic resource screen instead of matching the studio retry CSS gate', async () => {
    for(const [attribute,value] of [['data-lab-first-paint-failure','fatal'],['data-lab-styles','error']]) {
      const h=harness('main'), saved=h.record('main');
      h.document.documentElement.classList.add('studio-genesis-page');
      h.document.documentElement.attributes.set(attribute,value);
      const generic=h.document.createElement('section');generic.id='labStartupStatus';generic.textContent='fixture resource load failure — reload required';h.document.body.prepend(generic);
      h.context.SZ_LAB_FIRST_PAINT={complete:vi.fn(()=>h.document.documentElement.attributes.delete('data-lab-startup'))};
      h.bridge.refresh.mockResolvedValue({ok:false,error:'fixture resource initialization failed'} as any);
      h.start(saved);await vi.waitFor(()=>expect(h.document.documentElement.attributes.get('data-studio-startup')).toBe('resource-error'));
      expect(h.document.documentElement.attributes.get('data-lab-startup')).toBe('error');
      const studioRetryGate=h.document.documentElement.classList.contains('studio-genesis-page')
        && h.document.documentElement.attributes.get('data-studio-startup')==='error'
        && h.document.documentElement.attributes.get('data-lab-startup')==='error';
      expect(studioRetryGate).toBe(false);
      expect(h.document.getElementById('labStartupStatus')).toBe(generic);
      expect(generic.textContent).toContain('reload required');
      expect(h.rows.get(h.key('main'))).toEqual(saved);expect(h.writes).toEqual([]);expectNoGeneration(h);
    }
  });
});
