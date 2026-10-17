import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

const folder = resolve("public/creative/labs/image-prompt-lab");
const source = (name: string) => readFileSync(name === "creative-tools-contract.js" && process.env.SANJIE_LINK_CORE_SOURCE ? resolve(process.env.SANJIE_LINK_CORE_SOURCE) : resolve(folder, name), "utf8");
const fixture = () => JSON.parse(readFileSync(resolve("docs/uat-link-image-20261015/fixtures/import-two-positionings.json"), "utf8"));
const clone = <T>(value: T): T => {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(item => clone(item)) as T;
  return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,clone(item)])) as T;
};
function largePNG(marker: number): TestFile {
  // A complete PNG with incompressible RGB pixels, not a padded data URL. Each
  // image is just over 1 MiB of Base64, so 100 shared bindings expose the old full-list
  // stringify failure while structural copies can share immutable image strings.
  const width=512, height=512, pixels=Buffer.alloc((width*3+1)*height);let random=marker||1;
  for(let y=0;y<height;y++)for(let x=1;x<=width*3;x++){random^=random<<13;random^=random>>>17;random^=random<<5;pixels[y*(width*3+1)+x]=random&255;}
  const chunk=(type:string,data:Buffer)=>{const name=Buffer.from(type),body=Buffer.concat([name,data]);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const output=Buffer.alloc(data.length+12);output.writeUInt32BE(data.length,0);body.copy(output,4);output.writeUInt32BE((crc^0xffffffff)>>>0,output.length-4);return output;};
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(pixels)),chunk("IEND",Buffer.alloc(0))]);
  return {type:"image/png",name:`large-${marker}.png`,size:bytes.length,image:`data:image/png;base64,${bytes.toString("base64")}`,arrayBuffer:async()=>Uint8Array.from(bytes).buffer};
}

function image(marker: number) {
  const bytes = Buffer.alloc(40); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes); bytes.writeUInt32BE(64,16); bytes.writeUInt32BE(64,20); bytes[24] = marker;
  return `data:image/png;base64,${bytes.toString("base64")}`;
}
interface RequestStub { result?: unknown; error?: Error; onsuccess?: () => void; onerror?: () => void }
function database() {
  const records = new Map<string, unknown>();
  let tail = Promise.resolve();
  const db = {
    close() {}, createObjectStore() {},
    transaction(_store: string, mode: string, convert: (value: unknown) => unknown = clone) {
      let aborted = false, working = new Map<string, unknown>();
      const operations: Array<() => void> = [];
      const tx = {
        error: null as Error | null, oncomplete: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined, onabort: undefined as (() => void) | undefined,
        abort() { aborted = true; tx.onabort?.(); },
        objectStore() { return {
          get(key: string) { const request: RequestStub = {}; operations.push(() => { request.result = convert(working.get(key)); request.onsuccess?.(); }); return request; },
          put(value: unknown, key: string) { operations.push(() => working.set(key, clone(value))); }
        }; }
      };
      tail = tail.then(async () => {
        working = new Map([...records].map(([key,value]) => [key,clone(value)]));
        await Promise.resolve();
        while (operations.length && !aborted) { operations.shift()!(); await Promise.resolve(); }
        if (!aborted) { if (mode === "readwrite") { records.clear(); for (const [key,value] of working) records.set(key,value); } tx.oncomplete?.(); }
      });
      return tx;
    }
  };
  return { records, inRealm(convert: (value: unknown) => unknown) { return { open() { const request: RequestStub & { onupgradeneeded?: () => void } = { result: { ...db, transaction: (store: string, mode: string) => db.transaction(store,mode,convert) } }; queueMicrotask(() => { request.onupgradeneeded?.(); request.onsuccess?.(); }); return request; } }; } };
}
interface UIAsset { id: string; image: string; name: string; contentHash: string }
interface Output { config: { mode: string; provider: string; model: string; count: number; ratio: string; modules: string[]; requirements: string }; confirmedSignature: string; snapshot: unknown; receipt: unknown; lastFailure?: Record<string, unknown> }
interface Link { linkId: string; products: UIAsset[]; models: UIAsset[]; bindingConfirmed: boolean; bindingOverride: unknown; row: Record<string, string>; task: { subjectRequirement?: Record<string, unknown> }; outputs: Record<string, Output>; syncBackups?: unknown[] }
interface Workspace { accountKey: string; bundleId: string; revision: string; saveFault?: boolean; rawImport: string; imported: { bundle: unknown; rows: unknown[] }; links: Link[]; selected: string[]; activeLinkId: string; activeMode: string; reviewConfirmation?: { mode: string; links: Array<{ id: string; signature: string }>; at: string } }
interface Plan { ok: boolean; error?: string; signature: string; sourceSignature: string; shots: Array<{ id: string; prompt: string; label: string; index: number }> }
interface Entry { key: string; owner: Workspace; link: Link; mode: string; journal: { read(): unknown }; controller: { state: { plan: Plan | null; uncertain: unknown; busy: boolean; slots: Array<{ status: string; item?: unknown }>; previousResults: Array<{ status: string; item?: unknown }> }; snapshot(): unknown; editShot(id: string, changes: { prompt: string }): { ok: boolean }; resolveUncertain(input: { confirmed: boolean }): { ok: boolean } } }
interface UI {
  workspace?: Workspace; controllers: Map<string, Entry>; queue: Promise<void>;
  importRaw(raw: unknown, category?: string): Promise<{ ok: boolean; bundleId: string }>;
  addFiles(files: TestFile[], kind: string): Promise<void>; bindingError(link: Link): string; confirmBinding(link?: Link): Promise<void>;
  buildPlan(entry: Entry): Promise<Plan>; confirmPlan(entry: Entry): Promise<void>; runEntry(entry: Entry, method?: string, shotId?: string): Promise<{ ok: boolean }>;
  reviewMatches(owner?: Workspace, mode?: string): boolean; confirmReview(): Promise<void>; plannedFilename(linkId: string, mode: string, index: number): string;
  persist(owner?: Workspace): Promise<void>; snapshot(owner: Workspace): Workspace; encodeRecord(owner: Workspace): unknown; action(button: { disabled: boolean; dataset: Record<string, string> }): Promise<void>;
}
interface TestFile { type: string; name: string; size: number; image: string; arrayBuffer(): Promise<ArrayBuffer> }
function upload(marker: number, name = `产品${marker}.png`): TestFile { return { type: "image/png", name, size: 40, image: image(marker), arrayBuffer: async () => Uint8Array.from([marker,2,3]).buffer }; }
class Element {
  private markup = ""; private controls: Element[] = [];
  id = ""; className = ""; tagName = "DIV"; hidden = false; disabled = false; textContent = ""; value = ""; checked = false; indeterminate = false;
  naturalWidth = 0; naturalHeight = 0; complete = false;
  constructor(private resultImagePixels?: { naturalWidth: number; naturalHeight: number; complete: boolean }) {}
  dataset: Record<string, string> = {}; listeners = new Map<string, Array<(event: unknown) => void>>(); children: Element[] = [];
  readonly attributes = new Map<string, string>();
  readonly scrollIntoView = vi.fn(); readonly focus = vi.fn();
  get innerHTML() { return this.markup; }
  set innerHTML(markup: string) {
    this.markup=markup; this.controls=[];
    for (const match of markup.matchAll(/<([a-z][\w-]*)\b([^>]*?)>/gi)) {
      const node=new Element(this.resultImagePixels);node.tagName=match[1].toUpperCase();
      for (const attr of match[2].matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) node.setAttribute(attr[1],attr[2]??attr[3]??attr[4]??"");
      if(node.tagName==="IMG"&&node.attributes.has("data-li-result-pixels")&&this.resultImagePixels)Object.assign(node,this.resultImagePixels);
      node.disabled=node.attributes.has("disabled");node.checked=node.attributes.has("checked");node.value=node.attributes.get("value")||"";this.controls.push(node);
    }
  }
  get classList() {
    const contains=(name:string)=>this.className.split(/\s+/).includes(name);
    const toggle=(name:string,force=!contains(name))=>{const names=new Set(this.className.split(/\s+/).filter(Boolean));if(force)names.add(name);else names.delete(name);this.className=[...names].join(" ");return force;};
    return {contains,toggle,add:(...names:string[])=>names.forEach(name=>toggle(name,true))};
  }
  append(child: Element) { this.children.push(child); }
  setAttribute(name:string,value:string) {this.attributes.set(name,value);if(name==="id")this.id=value;if(name==="class")this.className=value;if(name.startsWith("data-"))this.dataset[name.slice(5).replace(/-([a-z])/g,(_all,char:string)=>char.toUpperCase())]=value;}
  getAttribute(name:string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name:string) { this.attributes.delete(name); }
  click() {}
  querySelectorAll(selector:string):Element[] {
    const parts=selector.split(",").map(value=>value.trim());
    return this.controls.flatMap(node=>[node,...node.querySelectorAll(selector)]).filter(node=>parts.some(part=>{
      if(part===".li-steps li")return node.tagName==="LI";
      if(part.startsWith("#"))return node.id===part.slice(1);
      const attribute=/^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(part);
      return !!attribute&&node.attributes.has(attribute[1])&&(attribute[2]===undefined||node.attributes.get(attribute[1])===attribute[2]);
    }));
  }
  querySelector(selector:string) {return this.querySelectorAll(selector)[0]||null;}
  addEventListener(type: string, callback: (event: unknown) => void) { this.listeners.set(type, [...this.listeners.get(type) || [], callback]); }
}
function harness(options: { account?: string; db?: ReturnType<typeof database>; storage?: Map<string, string>; search?: string; stringifyLimit?: number; resultImagePixels?: { naturalWidth: number; naturalHeight: number; complete: boolean }; send?: () => Promise<{ ok: boolean; images?: string[]; error?: string; code?: string; status?: number; httpStatus?: number; definitiveFailure?: boolean; providerSubmitted?: boolean; stateUncertain?: boolean; [key: string]: unknown }> } = {}) {
  let account = options.account || "tenant:alice";
  const busyScopes = new Map<string, boolean>();
  const isBusy = () => [...busyScopes.values()].some(Boolean);
  const db = options.db || database(), storage = options.storage || new Map<string, string>();
  const root = new Element(options.resultImagePixels), app = new Element(), body = new Element(), elements = new Map<string, Element>();
  const callbacks = new Map<string, Array<() => void>>(), timers = new Map<number, { callback: () => void; delay: number }>(); let timerId = 0;
  let waitForLock: (() => Promise<void>) | undefined;
  let lockAvailable = (_name: string) => true;
  const lockRequests: string[] = [], heldLocks = new Set<string>();
  root.id = "linkImageRoot"; app.append(root); elements.set(root.id,root);
  const document = { readyState: "loading", title: "", body,
    getElementById(id: string) { return elements.get(id)||root.querySelector(`#${id}`); },
    querySelector(selector: string) { return selector === ".app" ? app : null; }, createElement() { return new Element(); },
    addEventListener(type: string, callback: () => void) { callbacks.set(type, [...callbacks.get(type) || [],callback]); } };
  const config = { provider: "openai-compatible", imageModel: "gpt-image-2", imageAdapter: "generic-json", apiKey: "synthetic-never-exported", imageEndpoint: "https://synthetic.test/images" };
  const ready = vi.fn(), failed = vi.fn(), handoff = vi.fn(async (_input: unknown) => ({ ok: true, opened: true })), preview = vi.fn();
  const send = vi.fn(async (type: string, message: { payload: { linkId: string; modelImages: string[]; productImages: string[]; referenceImages: string[] } }) => { if (type === "CANCEL_GENERATION") return {ok:true}; expect(type).toBe("GENERATE_IMAGE"); expect(message.payload).toBeDefined(); return options.send ? options.send() : { ok: true, images: [image(9)] }; });
  const bridge = { ready: async () => ({ ok: true, accountKey: account }), getAccountKey: async () => account, config: () => config,
    listBoundApis: async () => ({ ok: true, accountKey: account, providers: [{ provider: config.provider, imageModel: config.imageModel }] }),
    modelInfo: async () => ({ provider: config.provider, model: config.imageModel, ratios: ["1:1","3:4"], resolutions: ["1K","2K"], qualityOptions: ["auto"] }),
    selectBoundApi: vi.fn(async () => { if(isBusy())throw new Error("CONFIG_BUSY");return { ok: true }; }), setApiBusy(scope: string, value: boolean) {busyScopes.set(scope,value);}, send, archive: vi.fn(async (item: unknown, owner: unknown) => { expect(item).toBeTruthy(); expect(owner).toBeTruthy(); return { ok: true }; }), archiveContext: () => ({ accountKey: account }),
    registerGenerationJob() {}, unregisterGenerationJob() {}, newJobId: () => webcrypto.randomUUID(), openHistory: vi.fn(async () => ({ ok: true })), openConfig: vi.fn(async () => ({ ok: true })), download: vi.fn(async () => ({ ok: true })) };
  const context = createContext({ URLSearchParams, console, crypto: webcrypto, Uint8Array, TextEncoder, TextDecoder,
    location: { search: options.search || "?mode=link-image&source=web", reload: vi.fn() }, document, navigator: { locks: { request: async (name: string, _options: object, callback: (lock: object | null) => unknown) => { lockRequests.push(name);await waitForLock?.();if(!lockAvailable(name)||heldLocks.has(name))return callback(null);heldLocks.add(name);try{return await callback({});}finally{heldLocks.delete(name);} } } },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string,value: string) => storage.set(key,value), removeItem: (key: string) => storage.delete(key) },
    setTimeout: (callback: () => void, delay: number) => { const id = ++timerId; if(delay===0)queueMicrotask(callback);else timers.set(id,{callback,delay}); return id; }, clearTimeout: (id: number) => timers.delete(id),
    addEventListener() {}, SZ_CREATIVE_TOOLS_BRIDGE: bridge, SZ_LAB_STARTUP: { ready, fail: failed }, SZ_IMAGE_UPLOAD: { openPreview: preview }, SZ_LINK_RESULT_HANDOFF: { open: handoff }, __SZ_LINK_IMAGE_UI_TEST_MODE__: true,
    FileReader: class { result = ""; onload?: () => void; readAsDataURL(file: TestFile) { this.result = file.image; queueMicrotask(() => this.onload?.()); } },
    Image: class { naturalWidth = 64; naturalHeight = 64; onload?: () => void; set src(_value: string) { queueMicrotask(() => this.onload?.()); } }
  });
  context.window = context;
  // A lexical alias keeps native Math lookups out of the VM global proxy during
  // large-image signature hashing, matching an ordinary browser execution cost.
  runInContext("const Math = globalThis.Math;",context);
  // Real IndexedDB clones into the receiving window's realm. Preserve that
  // boundary so the importer's ordinary-JSON prototype check stays meaningful.
  const realmClone=runInContext(`(function clone(value) { if(value===null || typeof value!=="object")return value; if(Array.isArray(value))return value.map(clone); return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clone(item)])); })`,context) as (value:unknown)=>unknown;
  context.indexedDB = db.inRealm(realmClone);
  const serialization={largestAttempt:0,rejected:0};context.__serialization=serialization;
  if(options.stringifyLimit){context.__stringifyLimit=options.stringifyLimit;runInContext(`{
    const original=JSON.stringify,limit=__stringifyLimit;
    JSON.stringify=function(value,...arguments_) {
      let bytes=0;
      function count(item) {
        if(bytes>limit)return;
        if(typeof item==='string'){bytes+=item.length+2;return;}
        if(item===null || typeof item!=='object'){bytes+=8;return;}
        bytes+=2;
        if(Array.isArray(item)){for(const child of item){count(child);if(bytes>limit)break;}}
        else for(const key of Object.keys(item)){bytes+=key.length+4;count(item[key]);if(bytes>limit)break;}
      }
      count(value);__serialization.largestAttempt=Math.max(__serialization.largestAttempt,bytes);
      if(bytes>limit){__serialization.rejected++;throw new RangeError('Invalid string length (test serialization bound)');}
      return original.call(this,value,...arguments_);
    };
  }`,context);}
  for (const name of ["creative-tools-contract.js", "link-list-import.js", "link-image-contract.js", "link-image-ui.js"]) runInContext(source(name), context, { filename: name });
  const flush = async () => { for (let index=0;index<100;index++) await Promise.resolve(); };
  const start = async () => { document.readyState = "complete"; callbacks.get("DOMContentLoaded")?.forEach(callback => callback()); await flush(); };
  const api = () => context.__SZ_LINK_IMAGE_UI_TEST_API__ as UI;
  const flushSaves = async () => { for (const [id,timer] of timers) if (timer.delay===300) {timers.delete(id);timer.callback();} await flush(); await api().queue; };
  const fireTimers = async (delay: number) => { let count=0;for(const [id,timer] of timers)if(timer.delay===delay){timers.delete(id);timer.callback();count++;}await flush();return count; };
  return { db, storage, root, body, bridge, handoff, preview, serialization, configuration: config, lockRequests, heldLocks, setLockAvailable(callback: (name:string) => boolean) {lockAvailable=callback;}, get busy(){return isBusy();}, scope:(name:string)=>busyScopes.get(name)||false, ready, failed, start, flush, flushSaves, fireTimers, api, setLockWait(callback: () => Promise<void>) {waitForLock=callback;}, setAccount(value: string) { account=value; }, taskBridge: () => context.SanjieLinkImageBridge as { getTaskState(): { ready: boolean; activeCount: number; pendingReceiptCount: number; busy:boolean }; canDeactivate(): Promise<{ allowed: boolean }>; activate(): Promise<{ ok: boolean }> } };
}
async function imported(h: ReturnType<typeof harness>) { await h.start(); expect(h.failed).not.toHaveBeenCalled(); const raw=fixture(); await h.api().importRaw(JSON.stringify(raw)); return raw; }
function entry(h: ReturnType<typeof harness>, linkId="L001", mode="main") { return [...h.api().controllers.values()].find(item => item.link.linkId===linkId && item.mode===mode)!; }
async function bound(h: ReturnType<typeof harness>, linkId="L001") { const workspace=h.api().workspace!; workspace.activeLinkId=linkId; await h.api().addFiles([upload(linkId==="L001"?1:2)],"products"); await h.api().addFiles([upload(3,"当前模特.png")],"models"); await h.api().confirmBinding(); }
async function confirmedOutput(h: ReturnType<typeof harness>, linkId="L001", mode="detail") { const owner=h.api().workspace!;owner.activeLinkId=linkId;owner.activeMode=mode;const task=entry(h,linkId,mode);await h.api().buildPlan(task);await h.api().confirmPlan(task);return task; }
const syncAll = (h: ReturnType<typeof harness>) => h.api().action({disabled:false,dataset:{liAction:"sync-all-confirm"}});
const clickAction = (h: ReturnType<typeof harness>, liAction: string, extra: Record<string, string> = {}) => h.api().action({disabled:false,dataset:{liAction,...extra}});
async function reviewReady(h: ReturnType<typeof harness>, mode="detail", confirmIndividual=false) {
  await imported(h);
  for(const link of h.api().workspace!.links){await bound(h,link.linkId);h.api().workspace!.activeMode=mode;const task=entry(h,link.linkId,mode);await h.api().buildPlan(task);if(confirmIndividual)await h.api().confirmPlan(task);}
  await clickAction(h,"select-link",{id:"L001"});
}
async function changeControl(h: ReturnType<typeof harness>, target: Element) { h.root.listeners.get("change")![0]({target}); await h.flush(); }

describe("dedicated account-owned link workspace UI", () => {
  it("boots only the new route and waits for account restoration before declaring ready", async () => {
    const old=harness({ search:"?mode=main&source=web&layout=1" }); await old.start(); expect(old.taskBridge()).toBeUndefined(); expect(old.ready).not.toHaveBeenCalled();
    const h=harness(); expect(h.ready).not.toHaveBeenCalled(); await h.start(); expect(h.ready).toHaveBeenCalledOnce(); expect(h.body.dataset.linkImageStartup).toBe("ready"); expect(h.root.innerHTML).toContain("链接成图"); expect(h.root.innerHTML).toContain("surface=list-legacy");
  });
  it("keeps startup covered until the actual account bridge resolves and reports its rejection", async () => {
    const h=harness(); let complete!:(result:{ok:boolean;accountKey:string})=>void;
    h.bridge.ready=()=>new Promise(resolve=>{complete=resolve;});
    await h.start(); expect(h.ready).not.toHaveBeenCalled(); expect(h.taskBridge().getTaskState().ready).toBe(false);
    complete({ok:false,accountKey:"tenant:alice"}); await h.flush(); expect(h.failed).toHaveBeenCalled(); expect(h.ready).not.toHaveBeenCalled(); expect(h.body.dataset.linkImageStartup).toBe("failed");
    expect(h.busy).toBe(false);
  });
  it("releases its API scope after a terminal model-read startup failure", async () => {
    const h=harness();h.bridge.modelInfo=async()=>{throw new Error("synthetic model catalog failure");};await h.start();expect(h.failed).toHaveBeenCalled();expect(h.busy).toBe(false);
    const other=harness();other.bridge.setApiBusy("another-preserved-workflow",true);other.bridge.modelInfo=async()=>{throw new Error("synthetic model catalog failure");};await other.start();expect(other.scope("link-image")).toBe(false);expect(other.scope("another-preserved-workflow")).toBe(true);expect(other.busy).toBe(true);
  });
  it("preserves complete source metadata and refuses malformed imports without replacing the current workspace", async () => {
    const h=harness(), raw=await imported(h), before=h.api().workspace;
    expect(before?.imported.bundle).toEqual(raw); expect(before?.rawImport).toBe(JSON.stringify(raw)); expect(h.bridge.send).not.toHaveBeenCalled();
    await expect(h.api().importRaw('{"rows": [}')).rejects.toThrow(); expect(h.api().workspace).toBe(before);
    expect([...h.db.records.values()].some(value => JSON.stringify(value).includes("synthetic-never-exported"))).toBe(false);
  });
  it("does not treat upstream local references as uploaded images and requires a separate explicit replacement", async () => {
    const h=harness(); await imported(h); const link=h.api().workspace!.links[0];
    link.task.subjectRequirement={localProductReferenceCount:1,localModelReferenceCount:4,localReferences:{models:[{name:"未上传模特"}]}};
    await h.api().addFiles([upload(1)],"products"); await expect(h.api().confirmBinding()).rejects.toThrow("4 张模特图");
    link.bindingOverride={confirmed:true,reason:"explicit-rebind",replacesUpstream:true}; await h.api().confirmBinding(); expect(link.bindingConfirmed).toBe(true); expect(link.models).toEqual([]);
  });
  it("isolates each link and output, sends real bound models, and requires current prompt confirmation", async () => {
    const h=harness(); await imported(h); await bound(h); const main=entry(h), detail=entry(h,"L001","detail"), other=entry(h,"L002");
    await h.api().buildPlan(main); await expect(h.api().runEntry(main)).rejects.toThrow("尚未确认");
    await h.api().confirmPlan(main); await h.api().runEntry(main);
    expect(h.bridge.send).toHaveBeenCalledTimes(5); expect(detail.controller.state.plan).toBeNull(); expect(other.controller.state.plan).toBeNull();
    for (const [type, envelope] of h.bridge.send.mock.calls) {
      expect(type).toBe("GENERATE_IMAGE"); expect(envelope.payload.linkId).toBe("L001");
      expect(envelope.payload.productImages).toEqual([image(1)]); expect(envelope.payload.modelImages).toEqual([image(3)]); expect(envelope.payload.referenceImages).toEqual([]);
    }
    expect(main.controller.state.slots.every(slot=>slot.status==="done")).toBe(true);
    expect(h.bridge.archive).toHaveBeenCalledTimes(5);
    const archived=h.bridge.archive.mock.calls[0] as unknown[]; expect(archived[1]).toEqual(expect.objectContaining({accountKey:"tenant:alice"}));
    await h.api().action({disabled:false,dataset:{liAction:"download",index:"0"}}); expect(h.bridge.download).toHaveBeenCalledWith(expect.objectContaining({linkId:"L001",linkMode:"main"}),"L001-main-1.png");
  });
  it("retains an edited prompt and restores the same owner bundle, bindings, results and confirmation", async () => {
    const h=harness(); await imported(h); await bound(h); const task=entry(h); await h.api().buildPlan(task);
    const shot=task.controller.state.plan!.shots[0]; task.controller.editShot(shot.id,{prompt:shot.prompt+"\n额外留白"}); await h.api().confirmPlan(task); await h.api().runEntry(task); await h.api().persist();
    const restored=harness({db:h.db,storage:h.storage}); await restored.start(); expect(restored.failed).not.toHaveBeenCalled();
    const old=entry(restored); expect(old.link.models).toHaveLength(1); expect(old.controller.state.plan!.shots[0].prompt).toContain("额外留白"); expect(old.controller.state.slots).toHaveLength(5); expect(old.link.outputs.main.confirmedSignature).toBe(old.controller.state.plan!.signature);
    const bob=harness({db:h.db,storage:h.storage,account:"tenant:bob"}); await bob.start(); expect(bob.api().workspace).toBeUndefined();
  });
  it("rejects a concurrent workspace overwrite and blocks dispatch after an account switch", async () => {
    const h=harness(); await imported(h); await bound(h); const task=entry(h); await h.api().buildPlan(task); await h.api().confirmPlan(task);
    const key=`tenant:alice:bundle:${h.api().workspace!.bundleId}`, external=clone(h.api().snapshot(h.api().workspace!)); external.revision="other-tab-revision"; h.db.records.set(key,h.api().encodeRecord(external));
    await expect(h.api().persist()).rejects.toThrow("另一页面"); expect((h.db.records.get(key) as Workspace).revision).toBe("other-tab-revision"); await expect(h.api().runEntry(task)).rejects.toThrow(); expect(h.bridge.send).not.toHaveBeenCalled();
    h.setAccount("tenant:bob"); expect((await h.taskBridge().activate()).ok).toBe(false); expect((await h.taskBridge().canDeactivate()).allowed).toBe(false);
  });
  it("keeps one link's uncertain receipt from blocking another independently bound link", async () => {
    let calls=0; const h=harness({send:async()=>++calls===1?{ok:false,error:"synthetic response lost"}:{ok:true,images:[image(9)]}}); await imported(h); await bound(h); const first=entry(h); await h.api().buildPlan(first); await h.api().confirmPlan(first); await h.api().runEntry(first);
    expect(first.controller.state.uncertain).toBeTruthy(); await bound(h,"L002"); const second=entry(h,"L002"); await h.api().buildPlan(second); await h.api().confirmPlan(second); await h.api().runEntry(second);
    expect(second.controller.state.slots.every(slot=>slot.status==="done")).toBe(true); expect(first.controller.state.uncertain).toBeTruthy(); expect(h.taskBridge().getTaskState()).toMatchObject({activeCount:0,pendingReceiptCount:1});
  });
  it("recovers a retained receipt from account-owned IndexedDB when its fast journal copy is missing", async () => {
    const h=harness({send:async()=>({ok:false,error:"synthetic response lost"})}); await imported(h); await bound(h); const task=entry(h); await h.api().buildPlan(task); await h.api().confirmPlan(task); await h.api().runEntry(task); await h.api().persist();
    h.storage.clear(); const restored=harness({db:h.db,storage:h.storage}); await restored.start(); expect(restored.failed).not.toHaveBeenCalled(); expect(entry(restored).controller.state.uncertain).toBeTruthy(); expect(entry(restored).journal.read()).toBeTruthy(); expect(restored.taskBridge().getTaskState().activeCount).toBe(0);
  });
  it("uses only the actual selectBoundApi bridge when a saved output model must be activated", async () => {
    const h=harness(); await imported(h); await bound(h); h.configuration.imageModel="another-model";
    h.bridge.selectBoundApi.mockImplementation(async()=>{expect(h.busy).toBe(false);h.configuration.imageModel="gpt-image-2";return {ok:true};});
    await h.api().buildPlan(entry(h)); expect(h.bridge.selectBoundApi).toHaveBeenCalledWith("openai-compatible"); expect(entry(h).controller.state.plan).toBeTruthy();
  });
  it("activates the saved model before a confirmed generation without blocking on its own preparation lock", async () => {
    const h=harness(); await imported(h); await bound(h); const task=entry(h); await h.api().buildPlan(task); await h.api().confirmPlan(task); h.configuration.imageModel="another-model";
    h.bridge.selectBoundApi.mockImplementation(async()=>{expect(h.busy).toBe(false);h.configuration.imageModel="gpt-image-2";return {ok:true};});
    expect((await h.api().runEntry(task)).ok).toBe(true); expect(h.bridge.selectBoundApi).toHaveBeenCalledWith("openai-compatible"); expect(h.bridge.send).toHaveBeenCalledTimes(5);
  });
  it("reacquires its API scope synchronously while the actual provider-selection promise is pending", async () => {
    const h=harness();await imported(h);await bound(h);h.configuration.imageModel="another-model";
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    h.bridge.selectBoundApi.mockImplementation(async()=>{expect(h.busy).toBe(false);await gate;h.configuration.imageModel="gpt-image-2";return {ok:true};});
    const planning=h.api().buildPlan(entry(h));await h.flush();expect(h.busy).toBe(true);release();await planning;expect(h.busy).toBe(false);
  });
  it("rejects a manual provider selection when another link starts during its account read", async () => {
    const h=harness();await imported(h);await bound(h,"L002");const second=entry(h,"L002");await h.api().buildPlan(second);await h.api().confirmPlan(second);h.api().workspace!.activeLinkId="L001";
    let finishAccount!:(value:string)=>void, releaseTask!:()=>void;const accountRead=new Promise<string>(resolve=>{finishAccount=resolve;}),taskGate=new Promise<void>(resolve=>{releaseTask=resolve;});let first=true;
    h.bridge.getAccountKey=async()=>{if(first){first=false;return accountRead;}return "tenant:alice";};h.setLockWait(()=>taskGate);
    h.root.listeners.get("change")![0]({target:{id:"liModel",value:"another-provider",dataset:{}}});await h.flush();
    const attempt=h.api().runEntry(second);await h.flush();finishAccount("tenant:alice");await h.flush();expect(h.bridge.selectBoundApi).not.toHaveBeenCalled();expect(h.configuration.provider).toBe("openai-compatible");expect(h.busy).toBe(true);
    releaseTask();await attempt;
  });
  it("reenables the actual parsed import and binding controls after their asynchronous work finishes", async () => {
    const h=harness(); await h.start();
    const pending=h.api().importRaw(JSON.stringify(fixture())); expect(h.root.querySelector('[data-li-action="import"]')?.disabled).toBe(true); await pending;
    expect(h.root.querySelector('[data-li-action="import"]')?.disabled).toBe(false);
    const uploadWork=h.api().addFiles([upload(1)],"products"); expect(h.root.querySelector('[data-li-action="confirm-binding"]')?.disabled).toBe(true); await uploadWork;
    expect(h.root.querySelector('[data-li-action="confirm-binding"]')?.disabled).toBe(false); expect(h.root.querySelector('[data-li-upload="products"]')?.disabled).toBe(false);
    await h.api().confirmBinding(); expect(h.root.querySelector('#liBindingBadge')?.textContent).toBe("已确认绑定");
    expect(h.root.querySelectorAll('.li-steps li').filter(node=>node.classList.contains("is-current"))).toHaveLength(1);
  });
  it("keeps selection checkboxes compact under the loaded global input styles and updates row planning state", async () => {
    const css=source("link-image.css");const checkbox=css.match(/#linkImageRoot input\[type=checkbox\]\{([^}]+)\}/)?.[1]||"";
    expect(checkbox).toContain("width:15px");expect(checkbox).toContain("max-width:15px");expect(checkbox).toContain("flex:0 0 15px");expect(checkbox).toContain("padding:0");
    expect(css).toContain("#linkImageRoot .li-link-row>button{display:block;width:auto;min-width:0");
    const h=harness();await imported(h);await bound(h);const task=entry(h);const marker=()=>h.root.querySelector('[data-li-link-state="L001"]')?.textContent;
    expect(marker()).toContain("主图待规划");await h.api().action({disabled:false,dataset:{liAction:"plan"}});expect(marker()).toContain("主图待确认");expect(marker()).toContain("详情待规划");
    await h.api().confirmPlan(task);expect(marker()).toContain("主图已确认");
  });
  it("synchronizes select-all, individual checks, partial selection and batch counts without replacing input drafts", async () => {
    const h=harness();await imported(h);
    const selected=()=>h.api().workspace!.selected;
    const all=h.root.querySelector("#liSelectAll")!, rows=h.root.querySelectorAll("[data-li-select]");
    const importDraft=h.root.querySelector("#liImportRaw")!;importDraft.value="尚未导入的原始文本";
    const change=async(target:Element,checked:boolean)=>{target.checked=checked;h.root.listeners.get("change")![0]({target});await h.flush();};
    const batch=()=>h.root.querySelector('[data-li-action="apply-binding"]')!.textContent;
    expect(rows).toHaveLength(2);expect(rows.every(row=>row.checked)).toBe(true);expect(all.checked).toBe(true);expect(all.indeterminate).toBe(false);
    expect(h.root.querySelector("#liSelectionCount")?.textContent).toBe("已选 2 / 2 条");
    await change(all,false);
    expect(selected()).toEqual([]);expect(rows.every(row=>!row.checked)).toBe(true);expect(all.checked).toBe(false);expect(all.indeterminate).toBe(false);
    expect(h.root.querySelector("#liSelectionCount")?.textContent).toBe("已选 0 / 2 条");expect(batch()).toContain("0 条");
    await change(rows[0],true);
    expect(selected()).toEqual(["L001"]);expect(rows.map(row=>row.checked)).toEqual([true,false]);expect(all.checked).toBe(false);expect(all.indeterminate).toBe(true);
    expect(h.root.querySelector("#liSelectionCount")?.textContent).toBe("已选 1 / 2 条");expect(batch()).toContain("1 条");
    await change(all,true);
    expect(selected()).toEqual(["L001","L002"]);expect(rows.every(row=>row.checked)).toBe(true);expect(all.checked).toBe(true);expect(all.indeterminate).toBe(false);
    expect(h.root.querySelector("#liSelectionCount")?.textContent).toBe("已选 2 / 2 条");expect(batch()).toContain("2 条");
    await change(rows[1],false);await h.flushSaves();
    expect(h.root.querySelector("#liImportRaw")).toBe(importDraft);expect(importDraft.value).toBe("尚未导入的原始文本");
    const restored=harness({db:h.db});await restored.start();expect(restored.failed).not.toHaveBeenCalled();
    expect(restored.api().workspace!.selected).toEqual(["L001"]);expect(restored.root.querySelectorAll("[data-li-select]").map(row=>row.checked)).toEqual([true,false]);
    expect(restored.root.querySelector("#liSelectAll")?.indeterminate).toBe(true);expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it("exposes the missing binding step without silently confirming materials or submitting a request", async () => {
    const h=harness();await imported(h);const task=entry(h);
    expect(h.root.querySelector("#liNextState")?.textContent).toMatch(/素材|绑定/);
    expect(h.root.querySelector("#liNextAction")).toBeTruthy();
    await h.api().action({disabled:false,dataset:{liAction:"next-step"}});
    expect(h.root.querySelector("#liBindingSection")?.scrollIntoView).toHaveBeenCalled();expect(h.root.querySelector("#liBindingSection")?.focus).toHaveBeenCalled();
    expect(task.link.bindingConfirmed).toBe(false);expect(task.controller.state.plan).toBeNull();expect(task.link.outputs.main.confirmedSignature).toBe("");expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it("uses the visible next step to plan and explicitly confirm only the current link and output", async () => {
    const h=harness();await imported(h);await bound(h);const main=entry(h),detail=entry(h,"L001","detail"),other=entry(h,"L002");
    expect(h.root.querySelector("#liNextAction")?.textContent).toMatch(/规划/);
    await h.api().action({disabled:false,dataset:{liAction:"next-step"}});
    expect(main.controller.state.plan).toBeTruthy();expect(main.link.outputs.main.confirmedSignature).toBe("");
    expect(h.root.querySelector("#liPlanEditor")?.scrollIntoView).toHaveBeenCalled();expect(h.root.querySelector("#liPlanEditor")?.focus).toHaveBeenCalled();
    expect(h.root.querySelector("#liNextAction")?.textContent).toMatch(/确认/);expect(h.root.querySelector("#liNextState")?.textContent).toMatch(/确认/);
    expect(detail.controller.state.plan).toBeNull();expect(other.controller.state.plan).toBeNull();expect(h.bridge.send).not.toHaveBeenCalled();
    await h.api().action({disabled:false,dataset:{liAction:"next-step"}});
    const mainSignature=main.controller.state.plan!.signature;
    expect(main.link.outputs.main.confirmedSignature).toBe(mainSignature);expect(detail.link.outputs.detail.confirmedSignature).toBe("");expect(other.link.outputs.main.confirmedSignature).toBe("");
    await h.api().action({disabled:false,dataset:{liAction:"switch-output",mode:"detail"}});
    expect(h.root.querySelector("#liNextAction")?.textContent).toMatch(/详情.*规划|规划.*详情/);
    await h.api().action({disabled:false,dataset:{liAction:"next-step"}});expect(detail.controller.state.plan).toBeTruthy();expect(detail.link.outputs.detail.confirmedSignature).toBe("");
    await h.api().action({disabled:false,dataset:{liAction:"next-step"}});
    expect(detail.link.outputs.detail.confirmedSignature).toBe(detail.controller.state.plan!.signature);expect(main.link.outputs.main.confirmedSignature).toBe(mainSignature);
    expect(other.controller.state.plan).toBeNull();expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it("shows every selected plan slot and filename before explicitly confirming the complete reviewed scheme", async () => {
    const h=harness();await reviewReady(h);const owner=h.api().workspace!,raw=owner.rawImport;
    const cards=h.root.querySelectorAll("[data-li-review-slot]"),markup=h.root.querySelector("#liReviewSlots")!.innerHTML;
    expect(h.root.querySelector("#liReviewSection")).toBeTruthy();expect(h.root.querySelector("#liReviewSummary")?.textContent).toMatch(/2.*20|20.*2/);expect(cards).toHaveLength(20);
    const expected=owner.links.flatMap(link=>entry(h,link.linkId,"detail").controller.state.plan!.shots.map(shot=>`${link.linkId}:detail:${shot.id}`));
    expect(cards.map(card=>card.dataset.liReviewSlot)).toEqual(expected);expect(new Set(expected).size).toBe(20);
    for(const link of owner.links)for(const shot of entry(h,link.linkId,"detail").controller.state.plan!.shots){expect(markup).toContain(shot.label);expect(markup).toContain(h.api().plannedFilename(link.linkId,"detail",shot.index));}
    expect(markup).not.toContain("data:image/");expect(h.api().reviewMatches()).toBe(false);expect(owner.links.every(link=>link.outputs.detail.confirmedSignature==="")).toBe(true);expect(h.bridge.send).not.toHaveBeenCalled();
    await clickAction(h,"confirm-review");
    expect(h.api().reviewMatches()).toBe(true);expect(owner.reviewConfirmation).toMatchObject({mode:"detail",links:owner.links.map(link=>({id:link.linkId,signature:entry(h,link.linkId,"detail").controller.state.plan!.signature}))});
    expect(owner.reviewConfirmation?.at).toEqual(expect.any(String));expect(owner.links.every(link=>link.outputs.detail.confirmedSignature===entry(h,link.linkId,"detail").controller.state.plan!.signature)).toBe(true);expect(owner.rawImport).toBe(raw);expect(h.bridge.send).not.toHaveBeenCalled();
    await h.flushSaves();const restored=harness({db:h.db,storage:h.storage});await restored.start();expect(restored.failed).not.toHaveBeenCalled();expect(restored.api().reviewMatches()).toBe(true);expect(restored.api().workspace!.reviewConfirmation).toEqual(owner.reviewConfirmation);expect(restored.bridge.send).not.toHaveBeenCalled();
  });
  it("keeps all-link overview scope separate from selected generation and explicit review consent", async () => {
    const h=harness();await reviewReady(h);const owner=h.api().workspace!,checkbox=h.root.querySelector('[data-li-select="L002"]')!;checkbox.checked=false;await changeControl(h,checkbox);
    expect(owner.selected).toEqual(["L001"]);expect(h.root.querySelectorAll("[data-li-review-slot]")).toHaveLength(10);
    const scope=h.root.querySelector("#liReviewScope")!;scope.value="all";await changeControl(h,scope);
    expect(h.root.querySelectorAll("[data-li-review-slot]")).toHaveLength(20);expect(owner.selected).toEqual(["L001"]);expect(h.api().reviewMatches()).toBe(false);expect(h.bridge.send).not.toHaveBeenCalled();
    await h.api().confirmReview();expect(owner.reviewConfirmation?.links.map(link=>link.id)).toEqual(["L001"]);expect(owner.links[1].outputs.detail.confirmedSignature).toBe("");expect(h.api().reviewMatches()).toBe(true);expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it.each(["main", "detail"])("fills every completed image into its exact reviewed slot for current and other links (%s)", async mode => {
    const h=harness();await reviewReady(h,mode,true);const owner=h.api().workspace!,first=entry(h,"L001",mode),second=entry(h,"L002",mode);
    await h.api().runEntry(first);await clickAction(h,"select-link",{id:"L002"});await h.api().runEntry(second);
    const images=h.root.querySelectorAll("[data-li-review-image]");expect(images).toHaveLength(mode==="main"?10:20);
    expect(images.every(node=>!node.hidden&&node.getAttribute("src")===image(9))).toBe(true);
    for(const task of [first,second])for(const shot of task.controller.state.plan!.shots){const key=`${task.link.linkId}:${mode}:${shot.id}`;expect(h.root.querySelector(`[data-li-review-state="${key}"]`)?.textContent).toBe("已完成");expect(h.root.querySelector(`[data-li-review-preview="${key}"]`)?.disabled).toBe(false);}
    expect(h.root.querySelector("#liReviewSummary")?.textContent).toMatch(new RegExp(`已完成 ${images.length}`));
    // The batch HTML remains metadata-sized even though each original is wired
    // into a separate image element; review never serializes source data URLs.
    expect(h.root.querySelector("#liReviewSlots")!.innerHTML).not.toContain("data:image/");
    const before=clone(first.controller.snapshot()),calls=h.bridge.send.mock.calls.length,shot=first.controller.state.plan!.shots[0],preview=h.root.querySelector(`[data-li-review-preview="L001:${mode}:${shot.id}"]`)!;
    await h.api().action(preview);expect(h.preview).toHaveBeenCalledWith(image(9),shot.label,false);
    const actions=h.root.querySelector(`[data-li-review-actions="L001:${mode}:${shot.id}"]`)!,download=actions.querySelector('[data-li-action="download-slot"]')!;
    await h.api().action(download);expect(h.bridge.download).toHaveBeenLastCalledWith(expect.objectContaining({linkId:"L001",linkMode:mode}),`L001-${mode}-1.png`);
    const tools=actions.querySelectorAll('[data-li-action="result-handoff"]');expect(tools.map(node=>node.dataset.tool)).toEqual(["guided-regenerate","case-fission","style-refresh"]);
    for(const tool of tools)await h.api().action(tool);
    expect(h.handoff).toHaveBeenCalledTimes(3);expect(h.handoff).toHaveBeenLastCalledWith(expect.objectContaining({action:"style-refresh",accountKey:owner.accountKey,bundleId:owner.bundleId,linkId:"L001",mode,shot:expect.objectContaining({id:shot.id}),plan:expect.objectContaining({signature:first.controller.state.plan!.signature}),item:expect.objectContaining({linkShotId:shot.id})}));
    expect(first.controller.snapshot()).toEqual(before);expect(h.bridge.send).toHaveBeenCalledTimes(calls);
    await h.flushSaves();const restored=harness({db:h.db,storage:h.storage});await restored.start();expect(restored.root.querySelectorAll("[data-li-review-image]").every(node=>!node.hidden&&node.getAttribute("src")===image(9))).toBe(true);expect(restored.bridge.send).not.toHaveBeenCalled();
  });
  it("gives image tools isolated metadata containers while preserving original task and result objects", async () => {
    const h=harness();await reviewReady(h,"main",true);const task=entry(h);await h.api().runEntry(task);const before=clone(task.controller.snapshot()),shot=task.controller.state.plan!.shots[0],tool=h.root.querySelector(`[data-li-review-actions="L001:main:${shot.id}"]`)!.querySelector('[data-li-action="result-handoff"]')!;
    h.handoff.mockImplementation(async input=>{const request=input as {item:Record<string,unknown>;shot:{prompt:string};plan:{config:{requirements:string}}};request.item.url="changed by consumer";request.shot.prompt="changed by consumer";request.plan.config.requirements="changed by consumer";return {ok:true,opened:true};});
    await h.api().action(tool);expect(task.controller.snapshot()).toEqual(before);expect(h.bridge.send).toHaveBeenCalledTimes(5);
  });
  it("normalizes an image-field original for tool handoff without changing the stored result", async () => {
    const h=harness();await reviewReady(h,"main",true);const task=entry(h);await h.api().runEntry(task);const item=task.controller.state.slots[0].item as Record<string,unknown>;item.image=item.url;delete item.url;const before=clone(task.controller.snapshot()),shot=task.controller.state.plan!.shots[0];await clickAction(h,"view-review");
    const tool=h.root.querySelector(`[data-li-review-actions="L001:main:${shot.id}"]`)!.querySelector('[data-li-action="result-handoff"]')!;await h.api().action(tool);
    expect(h.handoff).toHaveBeenCalledWith(expect.objectContaining({item:expect.objectContaining({url:image(9),image:image(9)})}));expect(task.controller.snapshot()).toEqual(before);
  });
  it("keeps all-link thumbnails independent of selection and refreshes the exact off-screen link as its late receipt arrives", async () => {
    let release!:(result:{ok:boolean;images:string[]})=>void,submitted!:()=>void;const pending=new Promise<{ok:boolean;images:string[]}>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{submitted=resolve;});
    const h=harness({send:async()=>{submitted();return pending;}});await reviewReady(h,"main",true);const first=entry(h),attempt=h.api().runEntry(first);await started;
    await clickAction(h,"select-link",{id:"L002"});const checkbox=h.root.querySelector('[data-li-select="L001"]')!;checkbox.checked=false;await changeControl(h,checkbox);const scope=h.root.querySelector("#liReviewScope")!;scope.value="all";await changeControl(h,scope);
    const shot=first.controller.state.plan!.shots[0],key=`L001:main:${shot.id}`;expect(h.root.querySelector(`[data-li-review-state="${key}"]`)?.textContent).toBe("生成中");
    expect(await h.fireTimers(12*60*1000)).toBeGreaterThan(0);await attempt;expect(h.root.querySelector(`[data-li-review-state="${key}"]`)?.textContent).toBe("结果待确认");
    const current=h.api().workspace!.activeLinkId;release({ok:true,images:[image(9)]});await h.flush();await h.flushSaves();expect(h.api().workspace!.activeLinkId).toBe(current);
    expect(h.root.querySelector(`[data-li-review-image="${key}"]`)?.getAttribute("src")).toBe(image(9));expect(h.root.querySelector(`[data-li-review-image="${key}"]`)?.hidden).toBe(false);expect(h.root.querySelector(`[data-li-review-state="${key}"]`)?.textContent).toBe("已完成");expect(h.bridge.send).toHaveBeenCalledOnce();
  });
  it.each(["account", "archive-account", "bundle", "link", "mode", "shot", "signature", "snapshot", "snapshot-shots", "result-id"])("refuses a mismatched result in a review slot without altering its original (%s)", async mismatch => {
    const h=harness();await reviewReady(h,"main",true);const task=entry(h);await h.api().runEntry(task);
    const mutable=task.controller.state as unknown as {accountKey:string;slots:Array<{shot:{id:string};item:Record<string,unknown>;archiveContext:{accountKey:string}}>},slot=mutable.slots[0],key=`L001:main:${slot.shot.id}`,before=clone(task.controller.snapshot()),download=h.root.querySelector(`[data-li-review-actions="${key}"]`)!.querySelector('[data-li-action="download-slot"]')!;
    if(mismatch==="account")mutable.accountKey="tenant:bob";
    else if(mismatch==="archive-account")slot.archiveContext.accountKey="tenant:bob";
    else if(mismatch==="bundle")slot.item.linkBundleId="another-bundle";
    else if(mismatch==="link")slot.item.linkId="L002";
    else if(mismatch==="mode")slot.item.linkMode="detail";
    else if(mismatch==="shot")slot.item.linkShotId="other-shot";
    else if(mismatch==="signature")slot.item.linkPlanSignature="another-plan";
    else if(mismatch==="snapshot-shots")(slot.item.linkPlanSnapshot as {plan:{shots:unknown}}).plan.shots={};
    else if(mismatch==="result-id")delete slot.item.resultId;
    else slot.item.linkPlanSnapshot={plan:{signature:slot.item.linkPlanSignature,bundleId:"another-bundle",linkId:"L001",mode:"main",shots:[slot.shot]},shotId:slot.shot.id};
    const tampered=clone(task.controller.snapshot());await clickAction(h,"view-review");expect(h.root.querySelector(`[data-li-review-image="${key}"]`)?.hidden).toBe(true);expect(h.root.querySelector(`[data-li-review-image="${key}"]`)?.getAttribute("src")).toBeNull();expect(h.root.querySelector(`[data-li-review-state="${key}"]`)?.textContent).toBe("历史版本");
    await expect(h.api().action(download)).rejects.toThrow(/归属|变化/);expect(task.controller.snapshot()).toEqual(tampered);expect(h.bridge.download).not.toHaveBeenCalled();expect(h.handoff).not.toHaveBeenCalled();expect(before).not.toEqual(tampered);
  });
  it("keeps a retained same-plan image visible without replacing a new attempt's pending or failed state", async () => {
    const h=harness();await reviewReady(h,"main",true);const task=entry(h);await h.api().runEntry(task);
    const mutable=task.controller.state as unknown as {slots:Array<Record<string,unknown>>;previousResults:Array<Record<string,unknown>>},original=mutable.slots[0],shot=original.shot as {id:string},key=`L001:main:${shot.id}`;mutable.previousResults.push(original);
    for(const [status,label] of [["ready","待生成"],["queued","排队中"],["generating","生成中"],["failed","失败"],["uncertain","结果待确认"]]){
      mutable.slots[0]={shot:clone(original.shot),status,item:null};const before=clone(task.controller.snapshot());await clickAction(h,"view-review");
      expect(h.root.querySelector(`[data-li-review-state="${key}"]`)?.textContent).toBe(label);expect(h.root.querySelector(`[data-li-review-image="${key}"]`)?.getAttribute("src")).toBe(image(9));expect(task.controller.snapshot()).toEqual(before);
    }
    expect(h.bridge.send).toHaveBeenCalledTimes(5);
  });
  it("attaches multi-megabyte originals separately while keeping full-review markup small", async () => {
    const original=largePNG(47).image,h=harness({send:async()=>({ok:true,images:[original]})});await reviewReady(h,"main",true);await h.api().runEntry(entry(h));
    const review=h.root.querySelector("#liReviewSlots")!,pictures=review.querySelectorAll("[data-li-review-image]");expect(original.length).toBeGreaterThan(1024*1024);expect(pictures.filter(node=>!node.hidden)).toHaveLength(5);
    expect(pictures.filter(node=>!node.hidden).every(node=>node.getAttribute("src")===original)).toBe(true);expect(review.innerHTML.length).toBeLessThan(40*1024);expect(review.innerHTML).not.toContain(original);expect(h.bridge.send).toHaveBeenCalledTimes(5);
  });
  it("does not attach a same-number old-plan image to an edited plan and retains it in original results", async () => {
    const h=harness();await reviewReady(h,"main",true);const task=entry(h);await h.api().runEntry(task);const old=clone(task.controller.snapshot()),shot=task.controller.state.plan!.shots[0],oldResult=clone(task.controller.state.slots[0].item);
    task.controller.editShot(shot.id,{prompt:shot.prompt+" 新的构图要求"});await clickAction(h,"view-review");
    expect(h.root.querySelectorAll("[data-li-review-image]").every(node=>node.hidden)).toBe(true);expect(h.root.querySelector("#liReviewSummary")?.textContent).toContain("历史版本 5");expect(task.controller.state.slots[0].item).toEqual(oldResult);expect(task.controller.state.plan!.signature).not.toBe((old as {plan:Plan}).plan.signature);expect(h.bridge.send).toHaveBeenCalledTimes(5);
    await clickAction(h,"download",{index:"0"});expect(h.bridge.download).toHaveBeenCalledWith(oldResult,"L001-main-1.png");
  });
  it("accepts the contract's canonical numeric fields and trimmed source and asset names while detecting a real later change", async () => {
    const h=harness();await h.start();const raw=fixture();raw.rows[0]["优先级分数"]=90;raw.rows[0]["链接定位"]=`  ${raw.rows[0]["链接定位"]}  `;raw.rows[0]["详情页定位"]=`  ${raw.rows[0]["详情页定位"]}  `;
    await h.api().importRaw(JSON.stringify(raw));const owner=h.api().workspace!;owner.selected=["L001"];owner.activeMode="detail";await h.api().addFiles([upload(1,"  产品正面.png  ")],"products");await h.api().addFiles([upload(3,"  当前模特.png  ")],"models");await h.api().confirmBinding();const task=entry(h,"L001","detail");await h.api().buildPlan(task);
    await h.api().confirmReview();expect(h.api().reviewMatches()).toBe(true);expect(owner.rawImport).toBe(JSON.stringify(raw));expect(task.link.products[0].name).toBe("  产品正面.png  ");expect(h.bridge.send).not.toHaveBeenCalled();
    task.link.row["详情页定位"]+=" 真实的新定位";expect(h.api().reviewMatches()).toBe(false);await expect(clickAction(h,"generate")).rejects.toThrow();expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it("does not partly confirm any selected plan when a concurrent draft revision wins the overall confirmation save", async () => {
    const h=harness();await reviewReady(h);await h.flushSaves();const owner=h.api().workspace!,before=clone(owner.links),key=`tenant:alice:bundle:${owner.bundleId}`,external=clone(h.api().snapshot(owner));external.revision="external-review-save";h.db.records.set(key,h.api().encodeRecord(external));
    await expect(h.api().confirmReview()).rejects.toThrow(/另一页面/);expect(owner.links).toEqual(before);expect(owner.reviewConfirmation).toBeUndefined();expect(owner.saveFault).toBe(true);expect((h.db.records.get(key) as Workspace).revision).toBe("external-review-save");expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it("holds review protection before asynchronous account checks and blocks selection, configuration and navigation until its save finishes", async () => {
    const h=harness();await reviewReady(h);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let first=true;h.bridge.getAccountKey=async()=>{if(first){first=false;await gate;}return "tenant:alice";};
    const owner=h.api().workspace!,selected=clone(owner.selected),config=clone(owner.links[0].outputs.detail.config),attempt=h.api().confirmReview();await h.flush();
    expect(h.busy).toBe(true);expect(h.taskBridge().getTaskState().busy).toBe(true);expect((await h.taskBridge().canDeactivate()).allowed).toBe(false);
    const checkbox=h.root.querySelector('[data-li-select="L002"]')!;checkbox.checked=false;await changeControl(h,checkbox);const ratio=h.root.querySelector('[data-li-config="ratio"]')!;ratio.value="1:1";await changeControl(h,ratio);
    expect(owner.selected).toEqual(selected);expect(owner.links[0].outputs.detail.config).toEqual(config);expect(h.bridge.send).not.toHaveBeenCalled();release();await attempt;expect(h.api().reviewMatches()).toBe(true);expect(h.busy).toBe(false);expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it("requires a reviewed complete scheme before batch dispatch even when each link already has confirmed prompts", async () => {
    const h=harness();await reviewReady(h,"detail",true);const before=h.api().workspace!.links.map(link=>link.outputs.detail.confirmedSignature);
    await expect(clickAction(h,"generate")).rejects.toThrow(/整体|整理|方案|确认/);expect(h.bridge.send).not.toHaveBeenCalled();expect(h.root.querySelector("#liReviewSection")?.scrollIntoView).toHaveBeenCalled();expect(h.root.querySelector("#liReviewSection")?.focus).toHaveBeenCalled();expect(h.api().workspace!.links.map(link=>link.outputs.detail.confirmedSignature)).toEqual(before);
    await h.api().confirmReview();expect(h.bridge.send).not.toHaveBeenCalled();await clickAction(h,"generate");expect(h.bridge.send).toHaveBeenCalledTimes(20);expect(h.api().reviewMatches()).toBe(true);
  });
  it("replaces a confirmation notice with scoped running and completed generation status", async () => {
    let release!:()=>void,started!:()=>void,first=true;const gate=new Promise<void>(resolve=>{release=resolve;}),submitted=new Promise<void>(resolve=>{started=resolve;});
    const h=harness({send:async()=>{if(first){first=false;started();await gate;}return {ok:true,images:[image(9)]};}});await reviewReady(h,"main");
    const checkbox=h.root.querySelector('[data-li-select="L002"]')!;checkbox.checked=false;await changeControl(h,checkbox);await h.api().confirmReview();
    expect(h.root.querySelector("#liStatus")?.textContent).toContain("未提交生图");const draft=h.root.querySelector("#liImportRaw")!;draft.value="尚未导入的新清单";
    const attempt=clickAction(h,"generate");await submitted;
    expect(h.root.querySelector("#liStatus")?.textContent).toMatch(/L001.*主图.*正在生成 1\/5/);expect(h.root.querySelector("#liStatus")?.textContent).not.toContain("未提交生图");
    release();await attempt;expect(h.bridge.send).toHaveBeenCalledTimes(5);expect(h.root.querySelector("#liStatus")?.textContent).toMatch(/L001.*主图.*已生成 5\/5/);
    expect(h.root.querySelector("#liStatus")?.attributes.get("role")).toBe("status");expect(h.root.querySelector("#liImportRaw")).toBe(draft);expect(draft.value).toBe("尚未导入的新清单");
    await clickAction(h,"switch-output",{mode:"detail"});expect(h.root.querySelector("#liStatus")?.textContent).not.toMatch(/主图|未提交生图|已生成 5/);
    await clickAction(h,"switch-output",{mode:"main"});expect(h.root.querySelector("#liStatus")?.textContent).toMatch(/L001.*主图.*已生成 5\/5/);
    await h.flushSaves();const restored=harness({db:h.db,storage:h.storage});await restored.start();expect(restored.root.querySelector("#liStatus")?.textContent).toMatch(/L001.*主图.*已生成 5\/5/);expect(restored.bridge.send).not.toHaveBeenCalled();
  });
  it("scopes task updates so background completion preserves a newer current-link error and import draft", async () => {
    let release!:()=>void,started!:()=>void,first=true;const gate=new Promise<void>(resolve=>{release=resolve;}),submitted=new Promise<void>(resolve=>{started=resolve;});
    const h=harness({send:async()=>{if(first){first=false;started();await gate;}return {ok:true,images:[image(9)]};}});await reviewReady(h,"main",true);
    const attempt=h.api().runEntry(entry(h,"L002","main"));await submitted;const draft=h.root.querySelector("#liImportRaw")!;draft.value="尚未完成的 JSON 草稿";
    const button=h.root.querySelector('[data-li-action="import"]')!;expect(button.disabled).toBe(false);h.root.listeners.get("click")![0]({target:{closest:()=>button}});await h.flush();
    const error=h.root.querySelector("#liStatus")!.textContent;expect(error).toMatch(/JSON|清单|导入/);expect(h.root.querySelector("#liStatus")?.attributes.get("role")).toBe("alert");
    release();await attempt;expect(h.bridge.send).toHaveBeenCalledTimes(5);expect(h.root.querySelector("#liStatus")?.textContent).toBe(error);expect(h.root.querySelector("#liStatus")?.attributes.get("role")).toBe("alert");expect(h.root.querySelector("#liImportRaw")).toBe(draft);expect(draft.value).toBe("尚未完成的 JSON 草稿");
    await clickAction(h,"select-link",{id:"L002"});expect(h.root.querySelector("#liStatus")?.textContent).toMatch(/L002.*主图.*已生成 5\/5/);expect(h.root.querySelector("#liStatus")?.attributes.get("role")).toBe("status");
  });
  it("shows decoded result pixels separately from requested clarity without altering images, requests or saved controller state", async () => {
    const h=harness();await reviewReady(h,"main",true);const task=entry(h);await h.api().runEntry(task);const before=clone(task.controller.snapshot()),calls=h.bridge.send.mock.calls.length;
    const result=h.root.querySelector('[data-li-result-pixels="0"]')!,size=h.root.querySelector('[data-li-result-size="0"]')!;result.naturalWidth=1254;result.naturalHeight=1254;
    for(const callback of result.listeners.get("load")||[])callback({target:result});expect(size.textContent).toBe("实际 1254 × 1254 像素 · 请求清晰度 2K · 请求比例 1:1");
    expect(h.bridge.send).toHaveBeenCalledTimes(calls);expect(task.controller.snapshot()).toEqual(before);expect(task.link.outputs.main.config).toMatchObject({resolution:"2K",ratio:"1:1"});
    const unreadable=h.root.querySelector('[data-li-result-pixels="1"]')!,unknown=h.root.querySelector('[data-li-result-size="1"]')!;for(const callback of unreadable.listeners.get("error")||[])callback({target:unreadable});expect(unknown.textContent).toMatch(/实际像素暂无法读取.*请求清晰度 2K/);expect(unknown.textContent).not.toContain("0 × 0");
    await h.flushSaves();const restored=harness({db:h.db,storage:h.storage,resultImagePixels:{naturalWidth:1254,naturalHeight:1254,complete:true}});await restored.start();
    expect(restored.root.querySelector('[data-li-result-size="0"]')?.textContent).toBe("实际 1254 × 1254 像素 · 请求清晰度 2K · 请求比例 1:1");expect(restored.bridge.send).not.toHaveBeenCalled();
    const retained=entry(restored).controller.snapshot() as {slots:unknown[]},saved=before as typeof retained;expect(retained.slots).toEqual(saved.slots);
  });
  it("does not show a main confirmation notice after switching to an unsubmitted detail plan", async () => {
    const h=harness();await reviewReady(h,"main");await h.api().confirmReview();expect(h.root.querySelector("#liStatus")?.textContent).toMatch(/主图.*未提交生图/);
    await clickAction(h,"switch-output",{mode:"detail"});expect(h.root.querySelector("#liStatus")?.hidden).toBe(true);expect(h.root.querySelector("#liStatus")?.textContent).toBe("");expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it("reports an empty generation queue without a stuck submission notice or a duplicate request", async () => {
    const h=harness();await reviewReady(h,"main",true);const task=entry(h);await h.api().runEntry(task);const calls=h.bridge.send.mock.calls.length,before=clone(task.controller.snapshot());
    const result=await h.api().runEntry(task);expect(result.ok).toBe(false);expect(h.bridge.send).toHaveBeenCalledTimes(calls);expect(h.root.querySelector("#liStatus")?.textContent).toMatch(/没有待生成镜头/);expect(h.root.querySelector("#liStatus")?.textContent).not.toMatch(/正在提交|未提交生图/);expect(h.root.querySelector("#liStatus")?.attributes.get("role")).toBe("alert");expect(task.controller.snapshot()).toEqual(before);expect(h.taskBridge().getTaskState().busy).toBe(false);
  });
  it.each(["current-task","newer-notice","other-output"])("accepts a genuine late successful receipt after controller timeout without stale status, duplicate generation or notice takeover (%s)", async scenario => {
    let complete!:(response:{ok:boolean;images:string[]})=>void,started!:()=>void;const response=new Promise<{ok:boolean;images:string[]}>(resolve=>{complete=resolve;}),submitted=new Promise<void>(resolve=>{started=resolve;});
    const h=harness({send:async()=>{started();return response;}});await reviewReady(h,"main",true);const task=entry(h),plan=clone(task.controller.state.plan),attempt=h.api().runEntry(task);await submitted;
    expect(await h.fireTimers(12*60*1000)).toBe(1);expect((await attempt).ok).toBe(false);expect(task.controller.state.busy).toBe(false);expect(task.controller.state.uncertain).toBeTruthy();expect(task.journal.read()).toBeTruthy();expect(h.root.querySelector("#liStatus")?.textContent).toMatch(/等待回执超时/);expect(h.root.querySelector("#liStatus")?.attributes.get("role")).toBe("alert");
    const originalError=(task.controller.state.slots[0] as {error?:string}).error;let newer="";
    const draft=h.root.querySelector("#liImportRaw")!;draft.value="保留未导入的 JSON 草稿";
    if(scenario==="newer-notice"){const button=h.root.querySelector('[data-li-action="import"]')!;h.root.listeners.get("click")![0]({target:{closest:()=>button}});await h.flush();newer=h.root.querySelector("#liStatus")!.textContent;expect(newer).toMatch(/JSON|清单|导入/);}
    if(scenario==="other-output"){await clickAction(h,"switch-output",{mode:"detail"});expect(h.root.querySelector("#liStatus")?.hidden).toBe(true);}
    complete({ok:true,images:[image(9)]});await h.flush();await h.flushSaves();
    expect(h.bridge.send).toHaveBeenCalledOnce();expect(h.bridge.archive).toHaveBeenCalledOnce();expect(task.controller.state.slots[0].status).toBe("done");expect(task.controller.state.slots[0].item).toBeTruthy();expect(task.controller.state.slots.slice(1).every(slot=>slot.status==="ready")).toBe(true);expect(task.controller.state.uncertain).toBeNull();expect(task.journal.read()).toBeNull();expect(task.controller.state.plan).toEqual(plan);expect((task.controller.state.slots[0] as {error?:string}).error).toBe(originalError);
    if(scenario==="newer-notice"){expect(h.root.querySelector("#liStatus")?.textContent).toBe(newer);expect(h.root.querySelector("#liStatus")?.attributes.get("role")).toBe("alert");expect(h.root.querySelector("#liImportRaw")).toBe(draft);expect(draft.value).toBe("保留未导入的 JSON 草稿");}
    else if(scenario==="other-output"){expect(h.root.querySelector("#liStatus")?.hidden).toBe(true);expect(h.root.querySelector("#liStatus")?.textContent).toBe("");await clickAction(h,"switch-output",{mode:"main"});expect(h.root.querySelector("#liStatus")?.textContent).toMatch(/原任务稍后返回成功图片/);expect(h.root.querySelector("#liStatus")?.attributes.get("role")).toBe("status");}
    else {expect(h.root.querySelector("#liStatus")?.textContent).toMatch(/原任务稍后返回成功图片/);expect(h.root.querySelector("#liStatus")?.attributes.get("role")).toBe("status");}
    if(scenario!=="other-output")expect(h.root.querySelector("#liImportRaw")).toBe(draft);
    expect(h.root.querySelector("#liResults")!.innerHTML).not.toContain("等待回执超时");
    await h.flushSaves();const restored=harness({db:h.db,storage:h.storage});await restored.start();expect(restored.failed).not.toHaveBeenCalled();expect(entry(restored).controller.state.slots[0].status).toBe("done");expect(entry(restored).controller.state.uncertain).toBeNull();expect(restored.root.querySelector("#liStatus")?.textContent).toMatch(/已生成 1\/5/);expect(restored.root.querySelector("#liResults")!.innerHTML).not.toContain("等待回执超时");expect(restored.bridge.send).not.toHaveBeenCalled();
  });
  it("stops later batch entries when selection changes during an already authorized link's generation", async () => {
    let release!:()=>void,started!:()=>void,first=true;const gate=new Promise<void>(resolve=>{release=resolve;}),submitted=new Promise<void>(resolve=>{started=resolve;});
    const h=harness({send:async()=>{if(first){first=false;started();await gate;}return {ok:true,images:[image(9)]};}});await reviewReady(h);await h.api().confirmReview();const second=entry(h,"L002","detail"),before=clone(second.controller.state.plan),attempt=clickAction(h,"generate");await submitted;
    const checkbox=h.root.querySelector('[data-li-select="L002"]')!;checkbox.checked=false;await changeControl(h,checkbox);expect(h.api().reviewMatches()).toBe(false);release();await attempt;
    expect(h.bridge.send).toHaveBeenCalledTimes(10);expect(h.bridge.send.mock.calls.every(([,request])=>request.payload.linkId==="L001")).toBe(true);expect(second.controller.state.slots.every(slot=>slot.status==="ready")).toBe(true);expect(second.controller.state.plan).toEqual(before);expect(h.root.querySelector("#liStatus")?.textContent).toMatch(/方案|确认|选择|勾选/);
  });
  it.each([false,true])("rechecks exact batch review after an asynchronous generation lock without regranting deselect/reselect consent (reselect=%s)", async reselect => {
    const h=harness();await reviewReady(h);await h.api().confirmReview();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});h.setLockWait(async()=>{entered();await gate;});
    const attempt=clickAction(h,"generate");await waiting;const checkbox=h.root.querySelector('[data-li-select="L002"]')!;checkbox.checked=false;await changeControl(h,checkbox);if(reselect){checkbox.checked=true;await changeControl(h,checkbox);}
    expect(h.api().reviewMatches()).toBe(false);release();await attempt;expect(h.bridge.send).not.toHaveBeenCalled();expect(h.root.querySelector("#liStatus")?.textContent).toMatch(/方案|确认|选择|勾选/);expect(entry(h,"L001","detail").controller.state.slots.every(slot=>slot.status==="ready")).toBe(true);
  });
  it.each(["selection","prompt","mode","config","binding","source"])("invalidates complete-plan consent after %s drift and never submits a stale batch", async kind => {
    const h=harness();await reviewReady(h);await h.api().confirmReview();const owner=h.api().workspace!,task=entry(h,"L001","detail"),token=clone(owner.reviewConfirmation);
    if(kind==="selection")owner.selected=["L001"];
    if(kind==="prompt"){const shot=task.controller.state.plan!.shots[0];task.controller.editShot(shot.id,{prompt:shot.prompt+"\n确认之后的新文案"});}
    if(kind==="mode")owner.activeMode="main";
    if(kind==="config")task.link.outputs.detail.config.ratio="1:1";
    if(kind==="binding")task.link.products[0].image=image(8);
    if(kind==="source")task.link.row["主推关键词"]+=" 确认之后的变化";
    expect(h.api().reviewMatches()).toBe(false);await expect(clickAction(h,"generate")).rejects.toThrow();expect(h.bridge.send).not.toHaveBeenCalled();expect(owner.reviewConfirmation).toEqual(token);
  });
  it("restores legacy confirmed plans and results without inventing overall review consent", async () => {
    const h=harness();await reviewReady(h,"detail",true);const task=entry(h,"L001","detail");await h.api().runEntry(task);await h.flushSaves();const owner=h.api().workspace!,legacy=clone(h.api().snapshot(owner)),key=`tenant:alice:bundle:${owner.bundleId}`;
    delete legacy.reviewConfirmation;h.db.records.set(key,legacy);const before=clone(legacy.links),restored=harness({db:h.db,storage:h.storage});await restored.start();expect(restored.failed).not.toHaveBeenCalled();
    expect(restored.api().workspace!.links).toEqual(before);expect(entry(restored,"L001","detail").controller.state.slots.every(slot=>slot.status==="done")).toBe(true);expect(restored.api().reviewMatches()).toBe(false);expect(restored.root.querySelectorAll("[data-li-review-slot]")).toHaveLength(20);
    await expect(clickAction(restored,"generate")).rejects.toThrow(/整体|整理|方案|确认/);expect(restored.bridge.send).not.toHaveBeenCalled();expect(restored.api().workspace!.links).toEqual(before);
  });
  it("downloads original images using exactly the filenames shown in the plan overview", async () => {
    const h=harness();await reviewReady(h);const owner=h.api().workspace!,task=entry(h,"L001","detail"),markup=h.root.querySelector("#liReviewSlots")!.innerHTML;
    await h.api().confirmReview();await h.api().runEntry(task);expect(owner.activeLinkId).toBe("L001");await clickAction(h,"download-all");expect(h.bridge.download).toHaveBeenCalledTimes(10);
    for(const [index,call] of h.bridge.download.mock.calls.entries()){const filename=h.api().plannedFilename("L001","detail",index+1);expect(markup).toContain(filename);expect(call).toEqual([expect.objectContaining({linkId:"L001",linkMode:"detail"}),filename]);}
  });
  it.each([
    {kind:"model-not-found",code:"model_not_found",status:404,uncertain:false,original:"当前账户未开通所选模型，请检查模型配置。"},
    {kind:"forbidden",code:"forbidden",status:403,uncertain:false,original:"当前 API 账户没有该模型权限，请检查模型配置。"},
    {kind:"ordinary-404",code:"request_invalid",status:404,uncertain:false,original:"请求暂时无法完成，请检查素材和模型设置。"},
    {kind:"uncertain-model-response",code:"model_not_found",status:503,uncertain:true,original:"请求结果尚未确认，请查看原任务进度，避免重复生成。"}
  ])("retains precise $kind diagnostics without changing a model, auto-retrying or losing the original response", async ({kind,code,status,uncertain,original}) => {
    const h=harness({send:async()=>({ok:false,code,status,httpStatus:status,error:original,definitiveFailure:!uncertain,stateUncertain:uncertain,providerSubmitted:uncertain,requestId:"synthetic-request",billingEventId:"synthetic-billing",apiKey:"synthetic-response-secret",raw:{authorization:"synthetic-raw-secret"}})});
    h.configuration.imageModel="gpt-image-2.5-sunbust";await reviewReady(h);await h.api().confirmReview();const task=entry(h,"L001","detail"),configuration=clone(h.configuration),shot=task.controller.state.plan!.shots[0],planBefore=clone(task.controller.state.plan),token=clone(h.api().workspace!.reviewConfirmation);
    await h.api().runEntry(task);expect(h.bridge.send).toHaveBeenCalledOnce();expect(h.configuration).toEqual(configuration);expect(task.controller.state.plan).toEqual(planBefore);expect(h.api().workspace!.reviewConfirmation).toEqual(token);expect(h.root.querySelector("#liStatus")?.textContent).toContain(original);expect(h.root.querySelector("#liStatus")?.attributes.get("role")).toBe("alert");
    const failure=task.link.outputs.detail.lastFailure;expect(failure).toMatchObject({code,status,httpStatus:status,model:"gpt-image-2.5-sunbust",provider:"openai-compatible",definitiveFailure:!uncertain,stateUncertain:uncertain,providerSubmitted:uncertain,requestId:"synthetic-request",billingEventId:"synthetic-billing",shotId:shot.id});
    expect(JSON.stringify(failure)).not.toContain("synthetic-response-secret");expect(JSON.stringify(failure)).not.toContain("synthetic-raw-secret");expect(JSON.stringify(failure)).not.toContain("synthetic-never-exported");
    const diagnostic=h.root.querySelector(`[data-li-failure="${shot.id}"]`);expect(diagnostic).toBeTruthy();const markup=h.root.querySelector("#liResults")!.innerHTML;expect(markup).toContain(original);expect(markup).toContain("gpt-image-2.5-sunbust");expect(markup).toContain(code);expect(markup).not.toMatch(/未扣费|没有扣费|未收费/);
    if(kind==="model-not-found")expect(markup).toMatch(/当前接口不可用|当前接口.*不可用|模型名.*权限/);
    if(kind==="ordinary-404")expect(markup).not.toContain("未开通所选模型");
    if(uncertain){expect(task.controller.state.uncertain).toBeTruthy();expect(task.journal.read()).toBeTruthy();expect(h.root.querySelector('[data-li-action="retry-shot"]')).toBeNull();}
    const scope=h.root.querySelector("#liReviewScope")!;scope.value="all";await changeControl(h,scope);await clickAction(h,"select-link",{id:"L002"});await clickAction(h,"select-link",{id:"L001"});await h.flushSaves();expect(h.bridge.send).toHaveBeenCalledOnce();expect(h.configuration).toEqual(configuration);
    const restored=harness({db:h.db,storage:h.storage});restored.configuration.imageModel=configuration.imageModel;await restored.start();expect(restored.failed).not.toHaveBeenCalled();expect(entry(restored,"L001","detail").link.outputs.detail.lastFailure).toEqual(failure);expect(restored.root.querySelector("#liResults")!.innerHTML).toContain(original);expect(restored.bridge.send).not.toHaveBeenCalled();
  });
  it.each([
    {code:"model_not_found",status:404,uncertain:false,calls:1},
    {code:"forbidden",status:403,uncertain:false,calls:1},
    {code:"request_invalid",status:404,uncertain:false,calls:2},
    {code:"model_not_found",status:503,uncertain:true,calls:2}
  ])("stops repeated shared configuration rejections but preserves independent work for $code HTTP $status uncertain=$uncertain", async ({code,status,uncertain,calls}) => {
    const h=harness({send:async()=>({ok:false,code,status,error:uncertain?"原请求结果待核对":"synthetic explicit rejection",definitiveFailure:!uncertain,stateUncertain:uncertain,providerSubmitted:uncertain})});await reviewReady(h);await h.api().confirmReview();const config=clone(h.configuration);
    await clickAction(h,"generate");expect(h.bridge.send).toHaveBeenCalledTimes(calls);expect(h.configuration).toEqual(config);
    const second=entry(h,"L002","detail");if(calls===1){expect(second.controller.state.slots.every(slot=>slot.status==="ready")).toBe(true);expect(second.link.outputs.detail.lastFailure).toBeUndefined();expect(h.root.querySelector("#liStatus")?.textContent).toMatch(/停止.*后续|后续.*停止/);}else expect(second.link.outputs.detail.lastFailure).toMatchObject({code,status});
  });
  it("explains retained legacy model errors cautiously without rewriting the saved failure or inventing response metadata", async () => {
    const original="当前账户未开通所选模型，请检查模型配置。",h=harness({send:async()=>({ok:false,error:original,definitiveFailure:true})});h.configuration.imageModel="gpt-image-2.5-sunbust";await reviewReady(h);const task=entry(h,"L001","detail");await h.api().confirmPlan(task);await h.api().runEntry(task);Reflect.deleteProperty(task.link.outputs.detail,"lastFailure");Reflect.deleteProperty(task.link.outputs.detail,"failureDiagnostics");await h.flushSaves();const before=clone(task.controller.snapshot());
    const restored=harness({db:h.db,storage:h.storage});restored.configuration.imageModel=h.configuration.imageModel;await restored.start();expect(restored.failed).not.toHaveBeenCalled();const after=entry(restored,"L001","detail").controller.snapshot() as {plan:Plan;slots:Array<Record<string,unknown>>},saved=before as typeof after;
    const retainedSlots=(slots:Array<Record<string,unknown>>)=>slots.map(slot=>({shot:slot.shot,status:slot.status,item:slot.item,error:slot.error,submission:slot.submission}));expect(after.plan).toEqual(saved.plan);expect(retainedSlots(after.slots)).toEqual(retainedSlots(saved.slots));const markup=restored.root.querySelector("#liResults")!.innerHTML;
    expect(markup).toMatch(/当前接口不可用|当前接口.*不可用|模型名.*权限/);expect(markup).toContain(original);expect(markup).toContain("gpt-image-2.5-sunbust");expect(markup).not.toContain("HTTP 404");expect(markup).not.toContain("model_not_found");expect(restored.bridge.send).not.toHaveBeenCalled();
  });
  it.each([
    {stage:"unbound",target:"liBindingSection"},
    {stage:"unplanned",target:"liPlanSection"},
    {stage:"unconfirmed",target:"liPlanEditor"}
  ])("opens the first unready link's $stage step before any selected generation can start", async ({stage,target}) => {
    const h=harness();await imported(h);await bound(h);const ready=entry(h);await h.api().buildPlan(ready);await h.api().confirmPlan(ready);
    const signature=ready.link.outputs.main.confirmedSignature;
    if(stage!=="unbound")await bound(h,"L002");
    const blocked=entry(h,"L002");if(stage==="unconfirmed")await h.api().buildPlan(blocked);
    await h.api().action({disabled:false,dataset:{liAction:"select-link",id:"L001"}});
    h.root.querySelector("#liImportRaw")!.value='{"category":"待导入品类","rows":[]}';h.root.querySelector("#liCategory")!.value="尚未导入的品类";
    await expect(h.api().action({disabled:false,dataset:{liAction:"generate"}})).rejects.toThrow(/L002/);
    expect(h.api().workspace!.activeLinkId).toBe("L002");expect(h.api().workspace!.selected).toEqual(["L001","L002"]);
    expect(h.root.querySelector("#liImportRaw")?.value).toBe('{"category":"待导入品类","rows":[]}');expect(h.root.querySelector("#liCategory")?.value).toBe("尚未导入的品类");
    expect(h.root.querySelector(`#${target}`)?.scrollIntoView).toHaveBeenCalled();expect(h.root.querySelector(`#${target}`)?.focus).toHaveBeenCalled();
    expect(blocked.link.outputs.main.confirmedSignature).toBe("");expect(ready.link.outputs.main.confirmedSignature).toBe(signature);
    expect(entry(h,"L001","detail").controller.state.plan).toBeNull();expect(entry(h,"L002","detail").controller.state.plan).toBeNull();expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it("rechecks the exact confirmed plan after asynchronous lock acquisition before dispatch", async () => {
    const h=harness(); await imported(h); await bound(h); const task=entry(h); await h.api().buildPlan(task); await h.api().confirmPlan(task);
    let release!:()=>void; const locked=new Promise<void>(resolve=>{release=resolve;}); h.setLockWait(()=>locked);
    const attempt=h.api().runEntry(task); await h.flush();
    expect(h.taskBridge().getTaskState().activeCount).toBe(1);
    expect(h.busy).toBe(true);
    const shot=task.controller.state.plan!.shots[0]; task.controller.editShot(shot.id,{prompt:shot.prompt+" changed after confirmation"});
    release(); await expect(attempt).rejects.toThrow("确认后的素材或提示词已变化"); expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it("synchronizes the confirmed detail framework to every link including unselected links without copying source positioning", async () => {
    const h=harness();const original=await imported(h);await bound(h);
    const owner=h.api().workspace!, source=entry(h,"L001","detail"), target=entry(h,"L002","detail");
    owner.activeMode="detail";owner.selected=["L001"];
    source.link.outputs.detail.config.count=7;source.link.outputs.detail.config.modules=["首屏价值","场景需求","决策收口"];
    source.link.outputs.detail.config.requirements="仅属于来源链接的特殊场景";
    target.link.outputs.detail.config.requirements="保留目标链接自己的补充要求";
    await h.api().buildPlan(source);
    const shot=source.controller.state.plan!.shots[0];source.controller.editShot(shot.id,{prompt:shot.prompt+"\n来源已确认的手工排版"});await h.api().confirmPlan(source);
    const sourceBefore=clone(source.controller.snapshot()), sourceSignature=source.link.outputs.detail.confirmedSignature;
    await syncAll(h);
    const synced=entry(h,"L002","detail"), plan=synced.controller.state.plan!;
    expect(synced.link.products).toEqual(source.link.products);expect(synced.link.models).toEqual(source.link.models);expect(synced.link.products).not.toBe(source.link.products);
    expect(synced.link.bindingConfirmed).toBe(true);expect(synced.link.outputs.detail.confirmedSignature).toBe(plan.signature);
    expect(synced.link.outputs.detail.config.count).toBe(7);expect(synced.link.outputs.detail.config.modules).toEqual(source.link.outputs.detail.config.modules);
    expect(synced.link.outputs.detail.config.requirements).toBe("保留目标链接自己的补充要求");
    expect(plan.shots).toHaveLength(7);expect(plan.shots[0].prompt).toContain("当前仅为 L002");expect(plan.shots[0].prompt).toContain(original.rows[1]["详情页文案"]);
    expect(plan.shots[0].prompt).not.toContain("当前仅为 L001");expect(plan.shots[0].prompt).not.toContain(original.rows[0]["详情页文案"]);expect(plan.shots[0].prompt).not.toContain("来源已确认的手工排版");
    expect(source.controller.snapshot()).toEqual(sourceBefore);expect(source.link.outputs.detail.confirmedSignature).toBe(sourceSignature);
    expect(owner.selected).toEqual(["L001"]);expect(owner.imported.bundle).toEqual(original);expect(entry(h,"L002","main").controller.state.plan).toBeNull();expect(h.bridge.send).not.toHaveBeenCalled();
    await h.flushSaves();const restored=harness({db:h.db,storage:h.storage});await restored.start();expect(restored.failed).not.toHaveBeenCalled();
    expect(entry(restored,"L002","detail").link.outputs.detail.confirmedSignature).toBe(entry(restored,"L002","detail").controller.state.plan!.signature);
  });
  it.each(["unbound","unplanned","unconfirmed","edited-after-confirmation","changed-source"])("refuses sync-all for an %s source without changing target materials or plans", async stage => {
    const h=harness();await imported(h);const target=entry(h,"L002","detail");
    if(stage!=="unbound")await bound(h);
    const owner=h.api().workspace!;owner.activeMode="detail";const source=entry(h,"L001","detail");
    if(!["unbound","unplanned"].includes(stage))await h.api().buildPlan(source);
    if(["edited-after-confirmation","changed-source"].includes(stage))await h.api().confirmPlan(source);
    if(stage==="edited-after-confirmation"){const shot=source.controller.state.plan!.shots[0];source.controller.editShot(shot.id,{prompt:shot.prompt+"\n确认后再次编辑"});}
    if(stage==="changed-source")source.link.outputs.detail.config.ratio="1:1";
    const linkBefore=clone(target.link), stateBefore=clone(target.controller.snapshot());
    await expect(syncAll(h)).rejects.toThrow();expect(target.link).toEqual(linkBefore);expect(target.controller.snapshot()).toEqual(stateBefore);expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it("skips busy links, uncertain links and newly journaled requests while synchronizing another available link", async () => {
    const h=harness();await h.start();const raw=fixture();
    for(let index=3;index<=5;index++){const id=`L${String(index).padStart(3,"0")}`;raw.rows.push({...clone(raw.rows[1]),"链接编号":id});raw.linkMetadata[id]=clone(raw.linkMetadata.L002);}
    await h.api().importRaw(JSON.stringify(raw));await bound(h);await confirmedOutput(h);
    const busy=entry(h,"L002","main"), uncertain=entry(h,"L003","detail"), journaled=entry(h,"L004","main");
    busy.controller.state.busy=true;uncertain.controller.state.uncertain={jobId:"retain-uncertain"};
    const receipt={accountKey:"tenant:alice",linkWorkspaceId:journaled.owner.bundleId,linkRecordId:journaled.link.linkId,linkOutputMode:journaled.mode,jobId:"external-pending",signature:"external-signature",shotId:"external-shot",batchId:"external-batch"};
    h.storage.set(`sz_link_image_receipt_v1:${encodeURIComponent("tenant:alice")}:${encodeURIComponent(journaled.key)}`,JSON.stringify(receipt));
    const preserved=[busy,uncertain,journaled].map(task=>({link:clone(task.link),state:clone(task.controller.snapshot())}));
    await syncAll(h);
    for(const [index,task] of [busy,uncertain,journaled].entries()){expect(task.link).toEqual(preserved[index].link);expect(task.controller.snapshot()).toEqual(preserved[index].state);}
    expect(journaled.journal.read()).toEqual(receipt);const free=entry(h,"L005","detail");expect(free.link.outputs.detail.confirmedSignature).toBe(free.controller.state.plan!.signature);
    expect(h.root.querySelector("#liStatus")?.textContent).toMatch(/L002/);expect(h.root.querySelector("#liStatus")?.textContent).toMatch(/L003/);expect(h.root.querySelector("#liStatus")?.textContent).toMatch(/L004/);expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it("retains previous target assets, edited drafts and original results when new shared assets invalidate its main plan", async () => {
    const h=harness();await imported(h);await bound(h,"L002");
    const main=await confirmedOutput(h,"L002","main");await h.api().runEntry(main);
    const detail=await confirmedOutput(h,"L002","detail");const oldShot=detail.controller.state.plan!.shots[0];detail.controller.editShot(oldShot.id,{prompt:oldShot.prompt+"\n保留同步前手工详情稿"});await h.api().confirmPlan(detail);await h.api().runEntry(detail);
    const target=detail.link, oldProducts=clone(target.products), oldMainResults=clone(main.controller.state.slots), oldDetailResults=clone(detail.controller.state.slots), oldRow=clone(target.row), oldTask=clone(target.task);
    await bound(h,"L001");await confirmedOutput(h);const callsBefore=h.bridge.send.mock.calls.length;await syncAll(h);
    const currentMain=entry(h,"L002","main"), currentDetail=entry(h,"L002","detail");
    expect(currentMain.controller.state.plan).toBeNull();expect(currentMain.link.outputs.main.confirmedSignature).toBe("");expect(currentMain.controller.state.previousResults).toEqual(expect.arrayContaining(oldMainResults));
    expect(currentDetail.controller.state.previousResults).toEqual(expect.arrayContaining(oldDetailResults));expect(currentDetail.link.row).toEqual(oldRow);expect(currentDetail.link.task).toEqual(oldTask);
    const backup=JSON.stringify(currentDetail.link.syncBackups);expect(backup).toContain(oldProducts[0].image);expect(backup).toContain("保留同步前手工详情稿");
    expect(h.bridge.send).toHaveBeenCalledTimes(callsBefore);expect(currentDetail.link.outputs.detail.confirmedSignature).toBe(currentDetail.controller.state.plan!.signature);
    await h.flushSaves();const restored=harness({db:h.db,storage:h.storage});await restored.start();expect(restored.failed).not.toHaveBeenCalled();
    expect(entry(restored,"L002","main").controller.state.previousResults).toEqual(expect.arrayContaining(oldMainResults));expect(JSON.stringify(entry(restored,"L002","detail").link.syncBackups)).toContain("保留同步前手工详情稿");
  });
  it("does not mark targets confirmed in memory or overwrite another page when the batch CAS save fails", async () => {
    const h=harness();await imported(h);await bound(h);await confirmedOutput(h);await h.flushSaves();
    const owner=h.api().workspace!, target=entry(h,"L002","detail"), before=clone(target.link), beforeState=clone(target.controller.snapshot()), key=`tenant:alice:bundle:${owner.bundleId}`;
    const external=clone(h.api().snapshot(owner));external.revision="external-batch-revision";const externalRecord=h.api().encodeRecord(external);h.db.records.set(key,externalRecord);
    await expect(syncAll(h)).rejects.toThrow(/另一页面|清单/);expect(target.link).toEqual(before);expect(target.controller.snapshot()).toEqual(beforeState);expect(h.db.records.get(key)).toEqual(externalRecord);expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it("records fresh explicit replacement approval for every target only through the new sync-all action", async () => {
    const h=harness();await h.start();await h.api().importRaw(readFileSync(resolve("docs/uat-link-image-20261015/fixtures/import-subject-bindings.json"),"utf8"));await bound(h);
    const owner=h.api().workspace!, source=owner.links[0], target=owner.links[1];source.bindingOverride={confirmed:true,reason:"explicit-rebind",replacesUpstream:true};await h.api().confirmBinding();await confirmedOutput(h);
    const targetTask=clone(target.task);await syncAll(h);const synced=entry(h,"L002","detail");
    expect(synced.link.bindingOverride).toEqual({confirmed:true,reason:"explicit-rebind",replacesUpstream:true});expect(synced.link.bindingOverride).not.toBe(source.bindingOverride);expect(synced.link.task).toEqual(targetTask);
    expect(h.api().bindingError(synced.link)).toBe("");expect(synced.link.outputs.detail.confirmedSignature).toBe(synced.controller.state.plan!.signature);expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it("preserves target edits and completed results on a repeated sync with unchanged materials and framework", async () => {
    const h=harness();await imported(h);await bound(h);await confirmedOutput(h);await syncAll(h);
    const target=entry(h,"L002","detail"), shot=target.controller.state.plan!.shots[0];target.controller.editShot(shot.id,{prompt:shot.prompt+"\n目标链接独立排版"});await h.api().confirmPlan(target);await h.api().runEntry(target);
    const before=clone(target.controller.state), backups=clone(target.link.syncBackups), callsBefore=h.bridge.send.mock.calls.length;
    h.api().workspace!.activeLinkId="L001";await syncAll(h);
    const synced=entry(h,"L002","detail");expect(synced.controller.state.plan).toEqual(before.plan);expect(synced.controller.state.slots).toEqual(before.slots);expect(synced.controller.state.previousResults).toEqual(before.previousResults);expect(synced.link.syncBackups).toEqual(backups);expect(synced.link.outputs.detail.confirmedSignature).toBe(synced.controller.state.plan!.signature);expect(h.bridge.send).toHaveBeenCalledTimes(callsBefore);
  });
  it.each(["main","detail"])("refuses sync-all while another page owns the source %s generation lock", async mode => {
    const h=harness();await imported(h);await bound(h);await confirmedOutput(h);const target=entry(h,"L002","detail"), before=clone(target.link), sourceKey=entry(h,"L001",mode).key;
    h.setLockAvailable(name=>!name.endsWith(`:${sourceKey}`));
    await expect(syncAll(h)).rejects.toThrow(/另一页面/);expect(target.link).toEqual(before);expect(h.heldLocks.size).toBe(0);expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it("skips a target with an external detail lock while acquiring both modes and confirming another target", async () => {
    const h=harness();await h.start();const raw=fixture();raw.rows.push({...clone(raw.rows[1]),"链接编号":"L003"});raw.linkMetadata.L003=clone(raw.linkMetadata.L002);await h.api().importRaw(JSON.stringify(raw));await bound(h);await confirmedOutput(h);
    const excluded=entry(h,"L002","detail"), before=clone(excluded.link);h.setLockAvailable(name=>!name.endsWith(`:${excluded.key}`));
    await syncAll(h);expect(excluded.link).toEqual(before);const ready=entry(h,"L003","detail");expect(ready.link.outputs.detail.confirmedSignature).toBe(ready.controller.state.plan!.signature);
    for(const link of h.api().workspace!.links)for(const mode of ["main","detail"])expect(h.lockRequests.some(name=>name.endsWith(`:${entry(h,link.linkId,mode).key}`))).toBe(true);
    expect(h.root.querySelector("#liStatus")?.textContent).toMatch(/L002.*另一页面/);expect(h.heldLocks.size).toBe(0);expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it("leaves invalid target detail data untouched and confirms a valid target using its own original records", async () => {
    const h=harness();await h.start();const raw=fixture();raw.rows.push({...clone(raw.rows[1]),"链接编号":"L003"});raw.linkMetadata.L003=clone(raw.linkMetadata.L002);raw.rows[1]["详情页定位"]="";
    await h.api().importRaw(JSON.stringify(raw));await bound(h);await confirmedOutput(h);const invalid=entry(h,"L002","detail"), before=clone(invalid.link), beforeState=clone(invalid.controller.snapshot());
    await syncAll(h);expect(invalid.link).toEqual(before);expect(invalid.controller.snapshot()).toEqual(beforeState);const valid=entry(h,"L003","detail");expect(valid.link.outputs.detail.confirmedSignature).toBe(valid.controller.state.plan!.signature);
    expect(h.root.querySelector("#liStatus")?.textContent).toMatch(/L002.*详情/);expect(h.api().workspace!.imported.bundle).toEqual(raw);expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it("rechecks account ownership after asynchronous lock acquisition before changing any link", async () => {
    const h=harness();await imported(h);await bound(h);await confirmedOutput(h);await h.flushSaves();const owner=h.api().workspace!, before=clone(owner.links);
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});h.setLockWait(()=>gate);const attempt=syncAll(h);await h.flush();
    expect(h.taskBridge().getTaskState().busy).toBe(true);expect((await h.taskBridge().canDeactivate()).allowed).toBe(false);h.setAccount("tenant:bob");release();
    await expect(attempt).rejects.toThrow(/账号已变化/);expect(owner.links).toEqual(before);expect(h.heldLocks.size).toBe(0);expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it("prevents a model-selection event already awaiting account lookup from changing the confirmed source during sync", async () => {
    const h=harness();await imported(h);await bound(h);const source=await confirmedOutput(h);await h.flushSaves();const before=clone(source.link), sourceState=clone(source.controller.snapshot());
    let releaseAccount!:(value:string)=>void, releaseLocks!:()=>void;const pendingAccount=new Promise<string>(resolve=>{releaseAccount=resolve;}), pendingLocks=new Promise<void>(resolve=>{releaseLocks=resolve;});let first=true;
    h.bridge.getAccountKey=async()=>{if(first){first=false;return pendingAccount;}return "tenant:alice";};
    h.root.listeners.get("change")![0]({target:{id:"liModel",value:"another-provider",dataset:{}}});await h.flush();h.setLockWait(()=>pendingLocks);
    const attempt=syncAll(h);await h.flush();releaseAccount("tenant:alice");await h.flush();
    expect(h.bridge.selectBoundApi).not.toHaveBeenCalled();expect(source.link).toEqual(before);expect(source.controller.snapshot()).toEqual(sourceState);releaseLocks();await attempt;
    expect(source.link).toEqual(before);expect(source.controller.snapshot()).toEqual(sourceState);expect(entry(h,"L002","detail").link.outputs.detail.confirmedSignature).toBe(entry(h,"L002","detail").controller.state.plan!.signature);expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it("skips a target whose fast receipt is unreadable without altering that receipt or aborting other confirmations", async () => {
    const h=harness();await h.start();const raw=fixture();raw.rows.push({...clone(raw.rows[1]),"链接编号":"L003"});raw.linkMetadata.L003=clone(raw.linkMetadata.L002);await h.api().importRaw(JSON.stringify(raw));await bound(h);await confirmedOutput(h);await h.flushSaves();
    const target=entry(h,"L002","main"), before=clone(target.link), beforeState=clone(target.controller.snapshot()), key=`sz_link_image_receipt_v1:${encodeURIComponent("tenant:alice")}:${encodeURIComponent(target.key)}`, originalReceipt="{unreadable-original-receipt";
    h.storage.set(key,originalReceipt);await syncAll(h);
    expect(target.link).toEqual(before);expect(target.controller.snapshot()).toEqual(beforeState);expect(h.storage.get(key)).toBe(originalReceipt);expect(h.root.querySelector("#liStatus")?.textContent).toMatch(/L002.*无法安全读取/);
    const valid=entry(h,"L003","detail");expect(valid.link.outputs.detail.confirmedSignature).toBe(valid.controller.state.plan!.signature);expect(h.bridge.send).not.toHaveBeenCalled();
    await h.flushSaves();expect(h.api().workspace!.saveFault).not.toBe(true);
  });
  it("prevents an archive retry already awaiting account lookup from attaching to replaced result slots during sync", async () => {
    const h=harness();await imported(h);await bound(h);const source=await confirmedOutput(h);await h.api().runEntry(source);await h.flushSaves();const before=clone(source.controller.snapshot()), archives=h.bridge.archive.mock.calls.length;
    let releaseAccount!:(value:string)=>void, releaseLocks!:()=>void;const accountGate=new Promise<string>(resolve=>{releaseAccount=resolve;}), lockGate=new Promise<void>(resolve=>{releaseLocks=resolve;});let first=true;
    h.bridge.getAccountKey=async()=>{if(first){first=false;return accountGate;}return "tenant:alice";};
    const retry=h.api().action({disabled:false,dataset:{liAction:"retry-archive",index:"0"}});await h.flush();h.setLockWait(()=>lockGate);const syncing=syncAll(h);await h.flush();releaseAccount("tenant:alice");await retry;
    expect(h.bridge.archive).toHaveBeenCalledTimes(archives);expect(source.controller.snapshot()).toEqual(before);releaseLocks();await syncing;expect(h.bridge.archive).toHaveBeenCalledTimes(archives);expect(source.controller.snapshot()).toEqual(before);
  });
  it("does not copy a source link's upstream replacement consent when applying the same image group", async () => {
    const h=harness(); await h.start(); await h.api().importRaw(readFileSync(resolve("docs/uat-link-image-20261015/fixtures/import-subject-bindings.json"),"utf8")); await bound(h);
    const owner=h.api().workspace!, source=owner.links[0], target=owner.links[1]; source.bindingOverride={confirmed:true,reason:"explicit-rebind",replacesUpstream:true}; await h.api().confirmBinding();
    await h.api().action({disabled:false,dataset:{liAction:"apply-binding"}});
    expect(target.products).toHaveLength(1); expect(target.models).toHaveLength(1); expect(target.bindingOverride).toBeNull(); expect(target.bindingConfirmed).toBe(false); expect(h.api().bindingError(target)).toContain("2 张模特图");
  });
  it("saves late updates for an older bundle even when the current bundle schedules another save", async () => {
    const h=harness(); await imported(h); await bound(h); const old=entry(h), oldOwner=h.api().workspace!; await h.api().buildPlan(old);
    const next=fixture(); next.businessContext={name:"second independent import"}; await h.api().importRaw(JSON.stringify(next));
    const shot=old.controller.state.plan!.shots[0]; old.controller.editShot(shot.id,{prompt:shot.prompt+" old workspace late update"});
    await h.api().action({disabled:false,dataset:{liAction:"select-link",id:"L002"}}); await h.flushSaves();
    const saved=h.db.records.get(`tenant:alice:bundle:${oldOwner.bundleId}`);
    expect(JSON.stringify(saved)).toContain("old workspace late update");
  });
  it("stops only the visible bundle and leaves another bundle's prepared task running", async () => {
    const h=harness(); await imported(h); await bound(h); const task=entry(h); await h.api().buildPlan(task); await h.api().confirmPlan(task);
    const next=fixture(); next.businessContext={name:"separate current bundle"}; await h.api().importRaw(JSON.stringify(next));
    let release!:()=>void; const gate=new Promise<void>(resolve=>{release=resolve;}); h.setLockWait(()=>gate);
    const attempt=h.api().runEntry(task); await h.flush(); await h.api().action({disabled:false,dataset:{liAction:"stop-list"}});
    release(); expect((await attempt).ok).toBe(true); expect(h.bridge.send).toHaveBeenCalledTimes(5); expect(task.controller.state.slots.every(slot=>slot.status==="done")).toBe(true);
  });
  it("restores a legacy array with explicitly supplied category and refuses altered per-link metadata atomically", async () => {
    const h=harness(); await h.start(); await h.api().importRaw(JSON.stringify(fixture().rows),"厨房用品"); await h.api().persist();
    const restored=harness({db:h.db}); await restored.start(); expect(restored.failed).not.toHaveBeenCalled();
    const key=`tenant:alice:bundle:${h.api().workspace!.bundleId}`, saved=clone(h.api().snapshot(h.api().workspace!));
    saved.links[1].task.subjectRequirement={localModelReferenceCount:0,canExecute:true}; h.db.records.set(key,saved);
    const bad=harness({db:h.db}); await bad.start(); expect(bad.failed).toHaveBeenCalled(); expect(bad.api().controllers.size).toBe(0); expect(bad.busy).toBe(false); expect(h.db.records.get(key)).toEqual(saved);
  });

  it("pages and unmounts large lists without changing cross-page selection or review consent", async () => {
    const h=harness();await h.start();const raw=fixture();
    for(let index=3;index<=27;index++){const id=`L${String(index).padStart(3,"0")}`;raw.rows.push({...clone(raw.rows[1]),"链接编号":id});raw.linkMetadata[id]=clone(raw.linkMetadata.L002);}
    await h.api().importRaw(JSON.stringify(raw));await bound(h);const owner=h.api().workspace!,source=await confirmedOutput(h,"L001","main");await syncAll(h);await h.api().confirmReview();
    const selection=clone(owner.selected),consent=clone(owner.reviewConfirmation),initialRow=h.root.querySelector('[data-li-select="L001"]');
    expect(h.root.querySelectorAll("[data-li-select]")).toHaveLength(20);expect(h.root.querySelectorAll("[data-li-review-slot]")).toHaveLength(25);
    await clickAction(h,"review-page",{page:"5"});expect(h.root.querySelectorAll("[data-li-review-link]").map(node=>node.dataset.liReviewLink)).toEqual(["L026","L027"]);
    expect(h.root.querySelector('[data-li-select="L001"]')).toBe(initialRow);
    await clickAction(h,"list-page",{page:"1"});expect(h.root.querySelectorAll("[data-li-select]").map(node=>node.dataset.liSelect)).toEqual(owner.links.slice(20).map(link=>link.linkId));
    expect(h.root.querySelectorAll("[data-li-select]").every(node=>node.checked)).toBe(true);
    await clickAction(h,"toggle-links");expect(h.root.querySelectorAll("[data-li-select]")).toHaveLength(0);
    await clickAction(h,"toggle-review");expect(h.root.querySelectorAll("[data-li-review-slot]")).toHaveLength(0);expect(h.root.querySelector("#liReviewSummary")!.textContent).toContain("共 135");
    expect(owner.selected).toEqual(selection);expect(owner.reviewConfirmation).toEqual(consent);expect(h.api().reviewMatches()).toBe(true);
    await clickAction(h,"toggle-links");await clickAction(h,"view-review");expect(h.root.querySelectorAll("[data-li-select]")).toHaveLength(7);expect(h.root.querySelectorAll("[data-li-review-slot]")).toHaveLength(10);
    expect(source.controller.state.plan).toBeTruthy();expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it("clears mounted work while an original request settles and restores its assets, plan and results", async () => {
    let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),submitted=new Promise<void>(resolve=>{started=resolve;});let first=true;
    const h=harness({send:async()=>{if(first){first=false;started();await gate;}return {ok:true,images:[image(9)]};}});await reviewReady(h,"main",true);
    await h.api().confirmReview();const owner=h.api().workspace!,task=entry(h),plan=clone(task.controller.state.plan),products=clone(task.link.products),selected=clone(owner.selected),consent=clone(owner.reviewConfirmation),attempt=clickAction(h,"generate");await submitted;
    const receipt=clone(task.journal.read());expect(receipt).toBeTruthy();await clickAction(h,"park-workspace");
    expect(h.api().workspace).toBe(owner);expect(h.root.querySelectorAll("[data-li-select]")).toHaveLength(0);expect(h.root.querySelectorAll("[data-li-review-slot]")).toHaveLength(0);expect(h.root.querySelector("#liResults")).toBeNull();
    expect(task.journal.read()).toEqual(receipt);expect(task.controller.state.busy).toBe(true);expect(h.taskBridge().getTaskState().activeCount).toBeGreaterThan(0);expect(h.busy).toBe(true);expect(h.root.querySelector("#liParkedTaskState")!.textContent).toContain("正在处理");
    release();await attempt;expect(task.controller.state.slots.filter(slot=>slot.item)).toHaveLength(5);expect(entry(h,"L002").controller.state.slots.filter(slot=>slot.item)).toHaveLength(5);expect(h.bridge.send).toHaveBeenCalledTimes(10);expect(owner.reviewConfirmation).toEqual(consent);expect(h.api().reviewMatches()).toBe(true);expect(h.root.querySelector("#liResults")).toBeNull();
    await clickAction(h,"restore-workspace");expect(h.root.querySelectorAll("[data-li-result-pixels]")).toHaveLength(5);expect(task.link.products).toEqual(products);expect(task.controller.state.plan).toEqual(plan);expect(owner.selected).toEqual(selected);expect(h.api().controllers.get(task.key)).toBe(task);
    const reload=harness({db:h.db,storage:h.storage});await reload.start();expect(entry(reload).controller.state.slots.filter(slot=>slot.item)).toHaveLength(5);expect(reload.bridge.send).not.toHaveBeenCalled();
  });
  it("retains uncertain receipts while clearing the page and refuses an unsaved or foreign-account clear", async () => {
    const h=harness({send:async()=>({ok:false,error:"原请求待核对",providerSubmitted:true,stateUncertain:true})});await reviewReady(h,"main",true);const owner=h.api().workspace!,task=entry(h);await h.api().runEntry(task);
    const receipt=clone(task.journal.read()),uncertain=clone(task.controller.state.uncertain);expect(receipt).toBeTruthy();await clickAction(h,"park-workspace");expect(task.journal.read()).toEqual(receipt);expect(task.controller.state.uncertain).toEqual(uncertain);expect(h.taskBridge().getTaskState().pendingReceiptCount).toBe(1);
    await clickAction(h,"restore-workspace");expect(h.root.querySelector("#liReceipt")!.innerHTML).toContain("原请求待核对");h.setAccount("tenant:bob");await expect(clickAction(h,"park-workspace")).rejects.toThrow("登录账号已变化");expect(h.root.querySelector("#liResults")).not.toBeNull();h.setAccount("tenant:alice");
    const saved=clone(h.api().snapshot(owner));saved.revision="external-clear-update";h.db.records.set(`tenant:alice:bundle:${owner.bundleId}`,h.api().encodeRecord(saved));await expect(clickAction(h,"park-workspace")).rejects.toThrow("另一页面");expect(h.root.querySelector("#liResults")).not.toBeNull();expect(task.journal.read()).toEqual(receipt);
  });
  it("saves and restores 100 links with real multi-megabyte shared PNGs without serializing the expanded workspace", async () => {
    const stringifyLimit=16*1024*1024, h=harness({stringifyLimit});await h.start();const raw=fixture();
    for(let index=3;index<=100;index++){const id=`L${String(index).padStart(3,"0")}`;raw.rows.push({...clone(raw.rows[1]),"链接编号":id,"详情页文案":`保留 ${id} 自己的文案`});raw.linkMetadata[id]=clone(raw.linkMetadata.L002);}
    await h.api().importRaw(JSON.stringify(raw));await bound(h,"L002");const oldTarget=await confirmedOutput(h,"L002","detail");
    const oldShot=oldTarget.controller.state.plan!.shots[0];oldTarget.controller.editShot(oldShot.id,{prompt:oldShot.prompt+"\n同步前目标手工排版"});await h.api().confirmPlan(oldTarget);
    const oldProducts=clone(oldTarget.link.products),oldTargetPlan=clone(oldTarget.controller.state.plan);
    const retainedResult={status:"done",archiveSaving:false,item:{image:image(9),resultId:"retained-before-sync",linkId:"L002"},shot:clone(oldTarget.controller.state.plan!.shots[0]),original:oldProducts[0].image};
    oldTarget.controller.state.slots[0]=retainedResult;
    const product=largePNG(101),model=largePNG(103);expect(product.image.length+model.image.length).toBeGreaterThan(2*1024*1024);
    h.api().workspace!.activeLinkId="L001";await h.api().addFiles([product],"products");await h.api().addFiles([model],"models");await h.api().confirmBinding();
    const source=await confirmedOutput(h,"L001","detail"),shot=source.controller.state.plan!.shots[0];source.controller.editShot(shot.id,{prompt:shot.prompt+"\n保留来源已确认手工稿"});await h.api().confirmPlan(source);
    const signature=source.controller.state.plan!.signature,sourceSignature=source.controller.state.plan!.sourceSignature;
    await syncAll(h);expect(h.api().workspace!.links.every(link=>!!link.outputs.detail.confirmedSignature)).toBe(true);
    expect(h.root.querySelectorAll("[data-li-select]")).toHaveLength(20);
    const slotIds=new Set<string>(),reviewPages:string[]=[];
    for(let page=0;page<20;page++){
      await clickAction(h,"review-page",{page:String(page)});
      const slots=h.root.querySelectorAll("[data-li-review-slot]"),markup=h.root.querySelector("#liReviewSlots")!.innerHTML;
      expect(slots).toHaveLength(50);for(const slot of slots)slotIds.add(slot.dataset.liReviewSlot);
      expect(markup).not.toContain("data:image/");expect(markup.length).toBeLessThan(128*1024);reviewPages.push(markup);
    }
    expect(slotIds.size).toBe(1000);const reviewMarkup=reviewPages.join("");
    const plannedNames=h.api().workspace!.links.flatMap(link=>entry(h,link.linkId,"detail").controller.state.plan!.shots.map(shot=>h.api().plannedFilename(link.linkId,"detail",shot.index)));
    expect(new Set(plannedNames).size).toBe(1000);for(const filename of plannedNames)expect(reviewMarkup).toContain(filename);
    expect(reviewMarkup).not.toContain(product.image);expect(reviewMarkup).not.toContain(model.image);expect(h.bridge.send).not.toHaveBeenCalled();
    await clickAction(h,"review-page",{page:"0"});
    const pending=entry(h,"L100","detail"),receipt={accountKey:"tenant:alice",linkWorkspaceId:pending.owner.bundleId,linkRecordId:"L100",linkOutputMode:"detail",jobId:"retained-request",signature:pending.controller.state.plan!.signature,shotId:pending.controller.state.plan!.shots[0].id,batchId:"retained-batch"};
    pending.controller.state.uncertain=clone(receipt);pending.link.outputs.detail.receipt=clone(receipt);
    h.storage.set(`sz_link_image_receipt_v1:${encodeURIComponent("tenant:alice")}:${encodeURIComponent(pending.key)}`,JSON.stringify(receipt));
    const selected=h.api().workspace!.links.slice(0,11).map(link=>link.linkId),all=h.root.querySelector("#liSelectAll")!;all.checked=false;h.root.listeners.get("change")![0]({target:all});
    for(const linkId of selected){const checkbox=h.root.querySelector(`[data-li-select="${linkId}"]`)!;checkbox.checked=true;h.root.listeners.get("change")![0]({target:checkbox});}await h.flush();await h.flushSaves();
    expect(h.root.querySelectorAll("[data-li-review-slot]")).toHaveLength(50);expect(h.api().reviewMatches()).toBe(false);await h.api().confirmReview();expect(h.api().reviewMatches()).toBe(true);expect(h.bridge.send).not.toHaveBeenCalled();
    await h.api().action({disabled:false,dataset:{liAction:"select-link",id:"L011"}});await h.flushSaves();
    expect(h.api().workspace!.saveFault).not.toBe(true);expect(h.serialization.rejected).toBe(0);expect(h.bridge.send).not.toHaveBeenCalled();
    const key=`tenant:alice:bundle:${source.owner.bundleId}`,stored=h.db.records.get(key) as {storageFormat:string;images:string[];value:unknown};
    expect(stored.storageFormat).toBe("LINK_IMAGE_DRAFT_STORAGE_V2");expect(stored.images.filter(value=>value===product.image)).toHaveLength(1);expect(stored.images.filter(value=>value===model.image)).toHaveLength(1);expect(new Set(stored.images).size).toBe(stored.images.length);
    const serialized=JSON.stringify(stored);expect(serialized.length).toBeLessThan(stringifyLimit);expect(serialized.split(product.image).length-1).toBe(1);expect(serialized.split(model.image).length-1).toBe(1);
    const restored=harness({db:h.db,storage:h.storage,stringifyLimit});await restored.start();expect(restored.failed).not.toHaveBeenCalled();const owner=restored.api().workspace!;
    expect(owner.selected).toEqual(selected);expect(owner.activeLinkId).toBe("L011");expect(owner.imported.bundle).toEqual(raw);expect(owner.links).toHaveLength(100);
    expect(restored.api().reviewMatches()).toBe(true);expect(restored.root.querySelectorAll("[data-li-review-slot]")).toHaveLength(50);expect(owner.reviewConfirmation?.links.map(link=>link.id)).toEqual(selected);
    const restoredSource=entry(restored,"L001","detail");expect(restoredSource.controller.state.plan!.signature).toBe(signature);expect(restoredSource.controller.state.plan!.sourceSignature).toBe(sourceSignature);expect(restoredSource.link.outputs.detail.confirmedSignature).toBe(signature);expect(restoredSource.controller.state.plan!.shots[0].prompt).toContain("保留来源已确认手工稿");
    const restoredTarget=entry(restored,"L002","detail");expect(restoredTarget.controller.state.previousResults).toContainEqual(retainedResult);expect(restoredTarget.link.syncBackups).toEqual(expect.arrayContaining([expect.objectContaining({products:oldProducts,outputs:expect.objectContaining({detail:expect.objectContaining({plan:oldTargetPlan})})})]));
    const current=entry(restored,"L011","detail");expect(current.link.products[0].image).toBe(product.image);expect(current.link.models[0].image).toBe(model.image);expect(current.controller.state.plan!.shots[0].prompt).toContain("保留 L011 自己的文案");expect(current.link.outputs.detail.confirmedSignature).toBe(current.controller.state.plan!.signature);
    expect(entry(restored,"L100","detail").journal.read()).toEqual(receipt);expect(entry(restored,"L100","detail").controller.state.uncertain).toEqual(receipt);expect(restored.serialization.rejected).toBe(0);expect(restored.bridge.send).not.toHaveBeenCalled();
  },120000);
  it.each(["missing-image-reference","foreign-account","foreign-bundle"])("fails closed on a %s storage envelope while retaining the stored draft", async kind => {
    const h=harness();await imported(h);await bound(h);await confirmedOutput(h);await h.flushSaves();const key=`tenant:alice:bundle:${h.api().workspace!.bundleId}`;
    const saved=clone(h.db.records.get(key)) as {storageFormat:string;accountKey:string;bundleId:string;images:string[];value:unknown};expect(saved.storageFormat).toBe("LINK_IMAGE_DRAFT_STORAGE_V2");
    if(kind==="missing-image-reference")saved.images=[];else if(kind==="foreign-account")saved.accountKey="tenant:bob";else saved.bundleId="foreign-bundle";
    h.db.records.set(key,saved);const bad=harness({db:h.db,storage:h.storage});await bad.start();expect(bad.failed).toHaveBeenCalled();expect(bad.api().controllers.size).toBe(0);expect(bad.busy).toBe(false);expect(h.db.records.get(key)).toEqual(saved);expect(bad.bridge.send).not.toHaveBeenCalled();
  });
  it("refuses a same-revision save over corrupted stored image references and preserves both copies", async () => {
    const h=harness();await imported(h);await bound(h);await confirmedOutput(h);await h.flushSaves();const owner=h.api().workspace!,before=clone(owner),key=`tenant:alice:bundle:${owner.bundleId}`;
    const corrupted=clone(h.db.records.get(key)) as {storageFormat:string;images:string[]};expect(corrupted.storageFormat).toBe("LINK_IMAGE_DRAFT_STORAGE_V2");corrupted.images=[];h.db.records.set(key,corrupted);
    await expect(h.api().persist()).rejects.toThrow(/原记录仍保留|图片引用|归属/);expect(h.db.records.get(key)).toEqual(corrupted);expect(owner.links).toEqual(before.links);expect(owner.revision).toBe(before.revision);expect(owner.saveFault).toBe(true);expect(h.bridge.send).not.toHaveBeenCalled();
  });
  it("restores legacy inline-image drafts and migrates them losslessly on the next successful save", async () => {
    const h=harness();await imported(h);await bound(h);const task=await confirmedOutput(h,"L001","detail"),shot=task.controller.state.plan!.shots[0];task.controller.editShot(shot.id,{prompt:shot.prompt+"\n旧格式已确认编辑"});await h.api().confirmPlan(task);await h.flushSaves();
    const owner=h.api().workspace!,key=`tenant:alice:bundle:${owner.bundleId}`,legacy=clone(h.api().snapshot(owner));h.db.records.set(key,legacy);
    const restored=harness({db:h.db,storage:h.storage});await restored.start();expect(restored.failed).not.toHaveBeenCalled();const before=clone(restored.api().snapshot(restored.api().workspace!));expect(h.db.records.get(key)).toEqual(legacy);
    await restored.api().persist();const record=h.db.records.get(key) as {storageFormat:string;value:unknown;images:string[]};expect(record.storageFormat).toBe("LINK_IMAGE_DRAFT_STORAGE_V2");expect(record.images).toContain(legacy.links[0].products[0].image);expect(record.images).toContain(legacy.links[0].models[0].image);
    const reopened=harness({db:h.db,storage:h.storage});await reopened.start();expect(reopened.failed).not.toHaveBeenCalled();const after=reopened.api().snapshot(reopened.api().workspace!);expect(after.links).toEqual(before.links);expect(after.rawImport).toBe(before.rawImport);expect(after.imported).toEqual(before.imported);expect(entry(reopened,"L001","detail").controller.state.plan!.shots[0].prompt).toContain("旧格式已确认编辑");expect(reopened.bridge.send).not.toHaveBeenCalled();
  });
  it("rejects an oversized model group without silently truncating any imported file", async () => {
    const h=harness(); await imported(h); await expect(h.api().addFiles([upload(1),upload(2),upload(3),upload(4)],"models")).rejects.toThrow("最多绑定 3 张"); expect(h.api().workspace!.links[0].models).toEqual([]);
  });
});
