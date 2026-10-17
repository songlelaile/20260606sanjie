import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountKey, harness, provider } from './test-fixtures/studio-genesis-ui-harness';

// Real published-entry storage functions and real controller; all IO is mocked.
// No browser storage, network, provider, credentials or production files touched.
const assetRoot = resolve(process.env.CREATIVE_ASSET_TEST_ROOT || 'public/creative');
const readAsset = (name: string) => {
  const target=resolve(assetRoot,'labs/image-prompt-lab',name);
  // Static release overlays omit this unchanged dependency. Use the repository
  // copy for upload markup while contracts/UI always come from the chosen root.
  const path=name==='image-upload.js'&&!existsSync(target)?resolve('public/creative/labs/image-prompt-lab',name):target;
  return readFileSync(path,'utf8');
};
const frozenMarker = '/* Frozen source: public/creative/labs/image-prompt-lab/studio-genesis-ui.js */';
const bundlePath=resolve(assetRoot,'labs/image-prompt-lab/studio-views-20261010-credit-v3.js');
const bundle=process.env.STUDIO_STORAGE_TEST_BUNDLE==='1'&&existsSync(bundlePath)?readAsset('studio-views-20261010-credit-v3.js'):null;
const ui=bundle?bundle.slice(bundle.indexOf(frozenMarker)):readAsset('studio-genesis-ui.js');
const storageEnd = ui.indexOf('  const scopeFor =') >= 0 ? ui.indexOf('  const scopeFor =') : ui.indexOf('  const draftKey = () =>');
const storageFunctions = ui.slice(ui.indexOf('  async function openDB()'),storageEnd);
const persistFunction = ui.slice(ui.indexOf('  async function persist('),ui.indexOf('  function scheduleSave()'));
const flushStorage = async () => { for(let i=0;i<180;i++)await Promise.resolve(); };
type ProviderReply = {ok:boolean;images?:string[];error?:string;definitiveFailure?:boolean;providerSubmitted?:boolean;stateUncertain?:boolean};
const storageDeferred = () => { let resolve!:(value:ProviderReply)=>void;const promise=new Promise<ProviderReply>(yes=>{resolve=yes;});return {promise,resolve}; };
type StorageReceipt = {jobId:string;[field:string]:unknown};
type MockRequest<T> = {result:T;onsuccess?:()=>void;onerror?:()=>void;error?:Error};
type MockTransaction = {mode:string;error:Error|null;aborted:boolean;finished:boolean;value?:unknown;key?:string;attempted?:boolean;onabort?:()=>void;oncomplete?:()=>void;onerror?:()=>void;abort():void;commit():void;objectStore():{put(value:unknown,key:string):void;get(key:string):MockRequest<unknown>}};
type MockConnection = {close():void;createObjectStore():void;transaction(store:string,mode?:string):MockTransaction};
const storageImage = (marker:number) => { const bytes=Buffer.alloc(32);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.writeUInt32BE(64,16);bytes.writeUInt32BE(64,20);bytes[26]=marker;return `data:image/png;base64,${bytes.toString('base64')}`; };

function storageHarness(count=5) {
  vi.useFakeTimers();
  let writeMode='normal',readMode='normal',holdOpen=false,opens=0,closes=0,aborts=0,submitted=0;
  const openRequests:MockRequest<MockConnection>[]=[],transactions:MockTransaction[]=[],stored=new Map<string,unknown>(),errors:string[]=[],registered=new Set<string>(),receipts=new Map<string,StorageReceipt>();
  const connection = ():MockConnection => ({
    close(){closes++;},createObjectStore(){},
    transaction(_store:string,mode='readonly') {
      const tx:MockTransaction={mode,error:null,aborted:false,finished:false,abort(){if(this.aborted||this.finished)return;this.aborted=true;this.finished=true;aborts++;this.onabort?.();},commit(){if(this.aborted||this.finished)return;if(this.attempted&&this.key)stored.set(this.key,this.value);this.finished=true;this.oncomplete?.();},objectStore(){return {
        put(value:unknown,key:string){
          tx.value=value;tx.key=key;tx.attempted=true;
          const action=writeMode;
          queueMicrotask(()=>{if(tx.aborted||tx.finished)return;if(action==='error'){tx.error=new Error('fixture disk full');tx.finished=true;tx.onerror?.();}else if(action==='normal')tx.commit();});
        },
        get(key:string){const request:MockRequest<unknown>={result:undefined};queueMicrotask(()=>{if(tx.aborted||readMode==='hang')return;request.result=stored.get(key);request.onsuccess?.();});return request;}
      };}};
      transactions.push(tx);return tx;
    }
  });
  const indexedDB={open(){opens++;const request:MockRequest<MockConnection>={result:connection()};openRequests.push(request);if(!holdOpen)queueMicrotask(()=>request.onsuccess?.());return request;}};
  const context=createContext({URL,setTimeout,clearTimeout,console,indexedDB,queueMicrotask,errors,randomUUID});
  runInContext(readAsset('studio-genesis-contract.js'),context);
  runInContext(`
    let database,saveTimer,saveQueue=Promise.resolve(),saveFault=false,saveError='',startupFailed=false,restoring=false,controller,draft={},expectedDraftToken='missing';
    const workspaceBinding={draft,controller:null,scope:'single:detail',restoring:false,expectedDraftToken:'missing'},uid=()=>randomUUID();
    const draftStorageTimeoutMs=15*1000,environment='',account='offline:account',root={querySelector:()=>null},clone=value=>JSON.parse(JSON.stringify(value));
    const ensureAccount=async()=>{},draftKey=()=> 'offline:draft',showError=error=>errors.push(error.message);
    ${storageFunctions}
    ${persistFunction}
    globalThis.storage={openDB,dbGet,dbPut,persist,setController:value=>{controller=value;workspaceBinding.controller=value;},setDraft:value=>{draft=value;workspaceBinding.draft=value;},get fault(){return saveFault;},get error(){return saveError;},get database(){return database;},get expectedToken(){return ${persistFunction.includes('owner.expectedDraftToken') ? 'workspaceBinding.expectedDraftToken' : 'expectedDraftToken'};}};
  `,context,{filename:'production UI storage functions'});
  const api=context.SZ_STUDIO_GENESIS,storage=context.storage;
  const settings={...api.defaults('detail'),count};
  const task={plan:undefined as {ok:boolean}|undefined,id:'offline-product',name:'offline product',requirements:'商品可见细节',products:[{image:storageImage(1),name:'fixture',width:64,height:64}],overrides:null,analysis:''};
  task.plan=api.createPlan(task,settings);expect(task.plan?.ok).toBe(true);storage.setDraft({settings,tasks:[task]});
  const bridge={getAccountKey:async()=>'offline:account',config:()=>({provider:'fixture',imageModel:'image2'}),modelInfo:()=>({ready:true,supportsReference:true}),registerGenerationJob:(job:string)=>registered.add(job),unregisterGenerationJob:(job:string)=>registered.delete(job),setApiBusy:vi.fn(),send:vi.fn(async():Promise<ProviderReply>=>{submitted++;return {ok:false,definitiveFailure:true,providerSubmitted:false,error:'产品图输入无效'};}),archive:vi.fn(async()=>({ok:false,error:'fixture archive unavailable'}))};
  const journal={concurrent:true,read:()=>receipts.values().next().value||null,readAll:()=>[...receipts.values()],readReceipt:(value:StorageReceipt)=>receipts.get(value.jobId)||null,write:(value:StorageReceipt)=>receipts.set(value.jobId,value),compareAndClear:(value:StorageReceipt)=>receipts.delete(value.jobId),clear:()=>receipts.clear()};
  const controller=api.createController({bridge,journal,concurrency:100,lock:async(_name:string,callback:()=>unknown)=>callback(),timeoutMs:20,onChange:()=>storage.persist({fromController:true})});storage.setController(controller);
  return {storage,controller,task,settings,bridge,journal,receipts,registered,transactions,stored,errors,openRequests,setWriteMode:(value:string)=>{writeMode=value;},setReadMode:(value:string)=>{readMode=value;},setHoldOpen:(value:boolean)=>{holdOpen=value;},get opens(){return opens;},get closes(){return closes;},get aborts(){return aborts;},get submitted(){return submitted;}};
}
afterEach(()=>vi.useRealTimers());

describe('bounded production draft storage and safe generation settlement',()=>{
  it('advances the expected revision only after the write transaction commits',async()=>{
    const h=storageHarness(1);await h.storage.persist();
    const previous=h.stored.get('offline:draft'),token=h.storage.expectedToken;
    h.setWriteMode('hang');const pending=h.storage.persist();await flushStorage();
    const active=h.transactions.at(-1)!;
    expect(active.attempted).toBe(true);expect(h.storage.expectedToken).toBe(token);expect(h.stored.get('offline:draft')).toBe(previous);
    active.commit();await pending;
    const committed=h.stored.get('offline:draft') as {revision:string};
    expect(committed).not.toBe(previous);expect(h.storage.expectedToken).toBe(`revision:${committed.revision}`);expect(h.storage.expectedToken).not.toBe(token);
  });
  it('keeps the committed revision after abort and retries from it without a false conflict',async()=>{
    const h=storageHarness(1);await h.storage.persist();
    const previous=h.stored.get('offline:draft'),token=h.storage.expectedToken;
    h.setWriteMode('hang');const pending=h.storage.persist(),rejected=expect(pending).rejects.toThrow('事务已取消');await flushStorage();
    const active=h.transactions.at(-1)!;active.abort();await rejected;active.commit();
    expect(h.stored.get('offline:draft')).toBe(previous);expect(h.storage.expectedToken).toBe(token);
    h.setWriteMode('normal');await h.storage.persist();
    const committed=h.stored.get('offline:draft') as {revision:string};
    expect(committed).not.toBe(previous);expect(h.storage.expectedToken).toBe(`revision:${committed.revision}`);expect(h.storage.fault).toBe(false);
  });
  it('bounds a hung write, aborts it before queue release and permits a later fresh save',async()=>{
    const h=storageHarness(1);h.setWriteMode('hang');
    const pending=h.storage.persist();const rejected=expect(pending).rejects.toThrow('保存超时');await flushStorage();
    expect(h.transactions).toHaveLength(1);await vi.advanceTimersByTimeAsync(15000);await rejected;
    expect(h.aborts).toBe(1);expect(h.closes).toBe(1);expect(h.storage.database).toBeNull();expect(h.storage.fault).toBe(true);expect(h.errors.at(-1)).toContain('本机草稿未保存');
    const expired=h.transactions[0];expired.oncomplete?.();expect(h.stored.size).toBe(0);
    h.setWriteMode('normal');await h.storage.persist();expect(h.opens).toBe(2);expect(h.stored.size).toBe(1);expect(h.storage.fault).toBe(false);
  });
  it('closes a late open connection and retries with a fresh open after the deadline',async()=>{
    const h=storageHarness(1);h.setHoldOpen(true);
    const pending=h.storage.openDB();const rejected=expect(pending).rejects.toThrow('打开超时');await vi.advanceTimersByTimeAsync(15000);await rejected;
    expect(h.storage.database).toBeUndefined();h.openRequests[0].onsuccess?.();expect(h.closes).toBe(1);expect(h.storage.database).toBeUndefined();
    h.setHoldOpen(false);await h.storage.openDB();expect(h.opens).toBe(2);expect(h.storage.database).toBeTruthy();
  });
  it('bounds a hung read without erasing the stored draft',async()=>{
    const h=storageHarness(1);h.stored.set('old-draft',{keep:'original'});h.setReadMode('hang');
    const pending=h.storage.dbGet('old-draft');const rejected=expect(pending).rejects.toThrow('读取超时');await flushStorage();await vi.advanceTimersByTimeAsync(15000);await rejected;
    expect(h.aborts).toBe(1);expect(h.stored.get('old-draft')).toEqual({keep:'original'});
    h.setReadMode('normal');expect(await h.storage.dbGet('old-draft')).toEqual({keep:'original'});
  });
  it('reports a transaction error and allows a subsequent ordinary persist to recover',async()=>{
    const h=storageHarness(1);h.setWriteMode('error');await expect(h.storage.persist()).rejects.toThrow('fixture disk full');
    expect(h.storage.fault).toBe(true);expect(h.errors.at(-1)).toContain('fixture disk full');
    h.setWriteMode('normal');await h.storage.persist();expect(h.storage.fault).toBe(false);expect(h.stored.size).toBe(1);
  });
  it('settles all five failed replies after one save deadline instead of waiting for every queued save',async()=>{
    const h=storageHarness(),reply=storageDeferred();h.bridge.send.mockImplementation(()=>reply.promise);
    const run=h.controller.run([h.task],h.settings);await flushStorage();expect(h.bridge.send).toHaveBeenCalledTimes(5);
    h.setWriteMode('hang');reply.resolve({ok:false,definitiveFailure:true,providerSubmitted:false,error:'产品图输入无效'});await flushStorage();
    expect(h.bridge.send,h.controller.state.error||h.controller.state.message).toHaveBeenCalledTimes(5);expect(h.controller.state.tasks[0].slots.map((slot:{status:string})=>slot.status)).toEqual(Array(5).fill('failed'));expect(h.controller.state.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(15000);const result=await run;
    expect(result.ok).toBe(false);expect(h.aborts).toBe(1);expect(h.controller.state.busy).toBe(false);expect(h.controller.state.awaitingReceipt).toBe(false);expect(h.controller.hasInFlightRequest()).toBe(false);expect(h.registered.size).toBe(0);expect(h.receipts.size).toBe(0);
    expect(h.controller.state.tasks[0].slots.every((slot:{status:string})=>slot.status==='failed')).toBe(true);
  });
  it('requires the pre-submission draft save to finish and sends nothing when it times out',async()=>{
    const h=storageHarness(1);let writes=0;
    const ordinary=h.storage.persist;h.storage.persist=(options:unknown)=>{if(++writes===2)h.setWriteMode('hang');return ordinary(options);};
    const run=h.controller.run([h.task],h.settings);await flushStorage();expect(h.bridge.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15000);const result=await run;
    expect(result.ok).toBe(false);expect(h.bridge.send).not.toHaveBeenCalled();expect(h.receipts.size).toBe(0);expect(h.controller.state.busy).toBe(false);expect(h.controller.hasInFlightRequest()).toBe(false);
  });
  it('preserves a late success and its receipt when both draft storage and archive fail, then recovers without generating again',async()=>{
    const h=storageHarness(1),reply=storageDeferred();h.bridge.send.mockImplementation(()=>reply.promise);
    const run=h.controller.run([h.task],h.settings);await flushStorage();expect(h.bridge.send).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(20);expect((await run).uncertain).toBe(true);
    h.setWriteMode('hang');reply.resolve({ok:true,images:[storageImage(99)]});await flushStorage();await vi.advanceTimersByTimeAsync(15000);await flushStorage();
    const slot=h.controller.state.tasks[0].slots[0];expect(slot.status).toBe('done');expect(slot.item.url).toBe(storageImage(99));expect(slot.archiveOk).toBe(false);expect(h.receipts.size).toBe(1);expect(h.controller.state.uncertain).toBeTruthy();expect(h.controller.state.busy).toBe(false);expect(h.controller.hasInFlightRequest()).toBe(false);
    expect((await h.controller.retryFailed([h.task],h.settings)).ok).toBe(false);expect(h.bridge.send).toHaveBeenCalledOnce();
    h.setWriteMode('normal');await h.storage.persist();const recovered=await h.controller.recoverPendingReceipt();expect(recovered.pending).toBe(false);expect(h.receipts.size).toBe(0);expect(slot.item.url).toBe(storageImage(99));expect(h.bridge.send).toHaveBeenCalledOnce();
  });
  it('keeps an unknown provider receipt after storage timeout and never turns it into a retryable failure',async()=>{
    const h=storageHarness(1);h.bridge.send.mockImplementation(async()=>{h.setWriteMode('hang');return {ok:false,stateUncertain:true,error:'fixture transport disconnected'};});
    const run=h.controller.run([h.task],h.settings);await flushStorage();await vi.advanceTimersByTimeAsync(15000);await run;
    expect(h.controller.state.tasks[0].slots[0].status).toBe('uncertain');expect(h.receipts.size).toBe(1);expect(h.controller.state.busy).toBe(false);expect(h.controller.hasInFlightRequest()).toBe(false);
    await h.controller.retryFailed([h.task],h.settings);expect(h.bridge.send).toHaveBeenCalledOnce();expect(h.receipts.size).toBe(1);
  });
});

function deferred<T>() {
  let complete!: (value:T)=>void;const promise=new Promise<T>(resolve=>{complete=resolve;});return {promise,complete};
}

async function readyForStorageTest() {
  const h=harness('detail');h.refresh.complete({ok:true,accountKey});h.read.complete(h.saved);
  await vi.waitFor(()=>expect(h.bridge.listBoundApis).toHaveBeenCalledOnce());h.catalog.complete({ok:true,accountKey,providers:[provider]});
  await vi.waitFor(()=>expect(h.document.control('[data-action=config]').disabled).toBe(false));return h;
}
const flushStorageUi=async()=>{for(let i=0;i<180;i++)await Promise.resolve();};
describe('real UI completion after local draft save fails',()=>{
  it('renders unlocked controls and the storage error when the generation final save rejects',async()=>{
    const h=await readyForStorageTest();
    h.bridge.send.mockImplementation(async()=>{h.writeControl.error=new Error('fixture local disk failure');return {ok:false,definitiveFailure:true,providerSubmitted:false,error:'产品图输入无效'};});
    const generate=h.document.control('[data-action=generate]');h.document.root.dispatch('click',generate);
    await vi.waitFor(()=>expect(h.bridge.send).toHaveBeenCalledOnce());
    await vi.waitFor(()=>expect(h.document.control('[data-action=config]').disabled).toBe(false));
    expect(h.controller().state.busy).toBe(false);expect(h.controller().hasInFlightRequest()).toBe(false);
    expect(h.document.root.querySelector('[data-action=stop]')).toBeNull();expect(h.document.control('[data-action=retry]').disabled).toBe(false);
    expect(h.document.root.textContent).toContain('本机草稿未保存');expect(h.document.root.textContent).toContain('fixture local disk failure');
    h.writeControl.error=undefined;h.bridge.send.mockResolvedValue({ok:true,images:['https://fixture.test/recovered-result.png']});
    h.document.root.dispatch('click',h.document.control('[data-action=retry-slot]'));
    await vi.waitFor(()=>expect(h.bridge.send).toHaveBeenCalledTimes(2));await vi.waitFor(()=>expect(h.document.control('[data-action=config]').disabled).toBe(false));
    expect(h.controller().state.tasks[0].slots[0].status).toBe('done');expect(h.controller().state.tasks[0].slots[0].errorMeta).toBeUndefined();expect(h.controller().state.busy).toBe(false);
  });
  it('renders completion after the failing response save and final user save both time out',async()=>{
    vi.useFakeTimers();const h=await readyForStorageTest(),wait=deferred<void>();
    try {
      h.bridge.send.mockImplementation(async()=>{h.writeControl.wait=wait.promise;return {ok:false,definitiveFailure:true,providerSubmitted:false,error:'产品图输入无效'};});
      h.document.root.dispatch('click',h.document.control('[data-action=generate]'));await flushStorageUi();expect(h.bridge.send).toHaveBeenCalledOnce();
      expect(h.controller().state.busy).toBe(true);await vi.advanceTimersByTimeAsync(30000);await flushStorageUi();
      expect(h.controller().state.busy).toBe(false);expect(h.document.root.querySelector('[data-action=stop]')).toBeNull();expect(h.document.control('[data-action=config]').disabled).toBe(false);expect(h.document.control('[data-action=retry]').disabled).toBe(false);
      expect(h.document.root.textContent).toContain('本机草稿未保存');expect(h.document.root.textContent).toContain('保存超时');
    } finally {wait.complete();vi.useRealTimers();}
  });
});
