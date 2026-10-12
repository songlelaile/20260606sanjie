import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Real contract, synthetic replies and local memory only. Never calls a provider.
const source = readFileSync(resolve(process.env.CREATIVE_ASSET_TEST_ROOT || 'public/creative', 'labs/image-prompt-lab/studio-genesis-contract.js'), 'utf8');
const clone = <T>(value:T):T => JSON.parse(JSON.stringify(value));
const image = (marker:number) => {
  const bytes = Buffer.alloc(32);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  bytes.writeUInt32BE(64,16); bytes.writeUInt32BE(64,20); bytes[26] = marker;
  return `data:image/png;base64,${bytes.toString('base64')}`;
};
const deferred = <T>() => { let resolve!:(value:T)=>void, reject!:(error:Error)=>void; const promise = new Promise<T>((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; };
type Reply = {ok:boolean;images?:string[];taskId?:string;jobId?:string;error?:string;definitiveFailure?:boolean;stateUncertain?:boolean};
type Receipt = {jobId:string;taskId:string;shotId:string;batchId:string;accountKey:string};
type Message = {jobId:string;payload:{studioGenesisPlan:{shotId:string}}};
type ArchiveItem = {jobId:string};
type ArchiveContext = {accountKey:string;surfaceMode:string};
type Shot = {id:string};
type Slot = {status:string;item:unknown};
type ReceiptTask = {slots:Slot[]};
type Journal = {
  read:()=>Receipt|null|Promise<Receipt|null>;
  write:(value:Receipt)=>void;
  clear:()=>void;
  compareAndClear?:(receipt:Receipt)=>boolean|Promise<boolean>;
};
const flush = async () => { for (let i=0;i<80;i++) await Promise.resolve(); };

function fixture(count=2, lateAt=1) {
  vi.useFakeTimers();
  const context=createContext({URL,setTimeout,clearTimeout}); context.window=context;
  runInContext(source,context); const api=context.SZ_STUDIO_GENESIS;
  const settings={...api.defaults('detail'),count};
  const task={id:'product',name:'原商品',requirements:'自然光',products:[{image:image(1),name:'正面',width:64,height:64}],overrides:null,analysis:'',plan:null as unknown};
  task.plan=api.createPlan(task,settings); expect((task.plan as {ok:boolean}).ok).toBe(true);
  let owner='user:alice', pending:Receipt|null=null, archiveFails=false, archiveThrows=false, job=0;
  const submitted:Message[]=[],archived:Array<{item:ArchiveItem;context:ArchiveContext}>=[],registered=new Set<string>(),apiBusy:boolean[]=[];
  const reply=deferred<Reply>(),started=deferred<void>();
  const config={provider:'fixture',imageModel:'original-model'};
  const bridge={
    getAccountKey:async()=>owner, config:()=>config, modelInfo:()=>({ready:true,supportsReference:true}),
    archiveContext:()=>({accountKey:owner,surfaceMode:'main'}), newJobId:()=>`fixture-job-${++job}`,
    registerGenerationJob:(id:string)=>registered.add(id), unregisterGenerationJob:(id:string)=>registered.delete(id),
    setApiBusy:(_route:string,busy:boolean)=>apiBusy.push(busy),
    send:async(_type:string,message:Message):Promise<Reply>=>{submitted.push(clone(message));if(submitted.length===lateAt){started.resolve();return reply.promise;}return {ok:true,images:[image(submitted.length+10)]};},
    archive:async(item:ArchiveItem,captured:ArchiveContext)=>{archived.push({item:clone(item),context:clone(captured)});if(archiveThrows)throw new Error('archive rejected');return archiveFails?{ok:false,error:'磁盘不可写'}:{ok:true};}
  };
  const journal:Journal={read:()=>pending,write:(value:Receipt)=>{pending=clone(value);},clear:()=>{pending=null;}};
  const lock=async(_name:string,callback:()=>Promise<unknown>)=>callback();
  const controller=api.createController({bridge,journal,lock,timeoutMs:15});
  return {api,controller,bridge,journal,settings,task,config,submitted,archived,registered,apiBusy,reply,started,
    pending:()=>pending,setUser:(key:string)=>{owner=key;},setArchiveFails:(value:boolean)=>{archiveFails=value;},setArchiveThrows:(value:boolean)=>{archiveThrows=value;}};
}
async function timeout(f:ReturnType<typeof fixture>) {
  const run=f.controller.run([f.task],f.settings); await f.started.promise; await vi.advanceTimersByTimeAsync(15); return run;
}
async function finish(f:ReturnType<typeof fixture>,response:Reply={ok:true,images:[image(99)],taskId:'provider-original'}) {
  f.reply.resolve(response); await flush(); expect(f.controller.hasInFlightRequest()).toBe(false);
}
// Public receipt mutations must fail closed while the original transport lives.
// Compare the complete state and journal so a rejected mutation cannot secretly
// detach the request, discard completed images or authorize a duplicate send.
async function expectLiveReceiptMutationsBlocked(f:ReturnType<typeof fixture>,replacement=f.controller.snapshot()) {
  const snapshot=clone(f.controller.snapshot()),pending=clone(f.pending()),sent=f.submitted.length,archived=f.archived.length,registered=[...f.registered];
  expect(f.controller.hasInFlightRequest()).toBe(true);
  expect(await f.controller.resolveUncertain({confirmed:true})).toMatchObject({ok:false,code:'STUDIO_CONFIRM_REQUIRED'});
  expect(await f.controller.recoverPendingReceipt()).toMatchObject({ok:false,code:'STUDIO_ALREADY_RUNNING'});
  expect(f.controller.restore(replacement)).toMatchObject({ok:false,code:'STUDIO_ALREADY_RUNNING'});
  expect(f.controller.snapshot()).toEqual(snapshot);expect(f.pending()).toEqual(pending);
  expect(f.submitted).toHaveLength(sent);expect(f.archived).toHaveLength(archived);expect([...f.registered]).toEqual(registered);
}
async function injectLegacyExternalSnapshot(f:ReturnType<typeof fixture>,replacement:unknown) {
  await expectLiveReceiptMutationsBlocked(f,replacement);
  // Simulate legacy/external direct state replacement solely to exercise the
  // late-reply defensive isolation. The supported restore API stays forbidden;
  // the hidden original request map and transport promise are never replaced.
  Object.assign(f.controller.state,clone(replacement),{busy:false,awaitingReceipt:true});
  expect(f.controller.hasInFlightRequest()).toBe(true);
}
afterEach(()=>vi.useRealTimers());

describe('studio original receipt lifetime after local timeout',()=>{
  it('recovers shot 12/16 by its original job, archives once and resumes only missing shots',async()=>{
    const f=fixture(16,12),result=await timeout(f),receipt=clone(f.pending()!);
    expect(result).toMatchObject({completed:11,total:16,uncertain:true,awaitingReceipt:true});
    expect(f.controller.state.busy).toBe(false); expect(f.controller.state.awaitingReceipt).toBe(true);
    expect(f.registered.has(receipt.jobId)).toBe(true); expect(f.apiBusy.at(-1)).toBe(true);
    await finish(f);
    const slot=f.controller.state.tasks[0].slots[11];
    expect(slot).toMatchObject({status:'done',archiveOk:true,item:{jobId:receipt.jobId,batchId:receipt.batchId,url:image(99),taskId:'provider-original'}});
    expect(f.archived).toHaveLength(12);expect(f.pending()).toBeNull();expect(f.controller.state.uncertain).toBeNull();
    expect(f.registered.size).toBe(0);expect(f.apiBusy.at(-1)).toBe(false);
    expect((await f.controller.retryFailed([f.task],f.settings)).code).toBe('STUDIO_NOTHING_QUEUED');
    expect(f.submitted).toHaveLength(12);
    await f.controller.run([f.task],f.settings);
    expect(f.submitted).toHaveLength(16);expect(f.submitted.filter(value=>value.payload.studioGenesisPlan.shotId==='shot-12')).toHaveLength(1);
    expect(f.archived.filter(value=>value.item.jobId===receipt.jobId)).toHaveLength(1);
  });
  it('rejects receipt confirmation, recovery and restore while the original send is alive',async()=>{
    const f=fixture();await timeout(f);
    await expectLiveReceiptMutationsBlocked(f);
    expect(f.pending()).not.toBeNull();expect(f.controller.state.uncertain).not.toBeNull();
    expect((await f.controller.retryFailed([f.task],f.settings)).code).toBe('STUDIO_RECEIPT_PENDING');
    expect((await f.controller.run([f.task],f.settings)).code).toBe('STUDIO_RECEIPT_PENDING');
    expect((await f.controller.retrySlot(f.task.id,'shot-1',[f.task],f.settings)).code).toBe('STUDIO_RECEIPT_PENDING');
    expect(f.submitted).toHaveLength(1);await finish(f);
    expect(f.controller.state.tasks[0].slots[0].status).toBe('done');expect(f.pending()).toBeNull();
  });
  it('returns the timeout but holds the account lock until actual receipt consumption completes',async()=>{
    const f=fixture();let held=false;
    const lock=async(_name:string,callback:()=>Promise<unknown>)=>{if(held)return {ok:false,code:'STUDIO_ALREADY_RUNNING'};held=true;try{return await callback();}finally{held=false;}};
    f.controller=f.api.createController({bridge:f.bridge,journal:f.journal,lock,timeoutMs:15});
    await timeout(f);expect(held).toBe(true);
    const other=f.api.createController({bridge:f.bridge,journal:f.journal,lock,timeoutMs:15});
    other.restore(f.controller.snapshot());
    expect((await other.resolveUncertain({confirmed:true})).code).toBe('STUDIO_ALREADY_RUNNING');
    expect((await other.run([f.task],f.settings)).code).toBe('STUDIO_ALREADY_RUNNING');
    expect(f.pending()).not.toBeNull();expect(f.submitted).toHaveLength(1);
    await finish(f);expect(held).toBe(false);
  });
  it('accepts a late definitive failure and permits an explicit retry only after it returned',async()=>{
    const f=fixture();await timeout(f);
    await finish(f,{ok:false,definitiveFailure:true,error:'provider rejected'});
    expect(f.controller.state.tasks[0].slots[0].status).toBe('failed');expect(f.pending()).toBeNull();expect(f.archived).toHaveLength(0);
    await f.controller.retryFailed([f.task],f.settings);expect(f.submitted).toHaveLength(2);
  });
  it('separates a finished uncertain transport error from a still active send',async()=>{
    const f=fixture();await timeout(f);f.reply.reject(new Error('network disconnected'));await flush();
    expect(f.controller.hasInFlightRequest()).toBe(false);expect(f.controller.state.awaitingReceipt).toBe(false);
    expect(f.apiBusy.at(-1)).toBe(false);expect(f.pending()).not.toBeNull();expect(f.controller.state.uncertain).not.toBeNull();
    expect((await f.controller.retryFailed([f.task],f.settings)).uncertain).toBe(true);expect(f.submitted).toHaveLength(1);
    await f.controller.resolveUncertain({confirmed:true});await f.controller.retryFailed([f.task],f.settings);expect(f.submitted).toHaveLength(2);
  });
  it('saves late success after stop without restarting the remaining queue',async()=>{
    const f=fixture();await timeout(f);await f.controller.stop();await finish(f);
    expect(f.controller.state.stopped).toBe(true);expect(f.controller.state.tasks[0].slots.map((slot:Slot)=>slot.status)).toEqual(['done','ready']);
    expect(f.submitted).toHaveLength(1);expect(f.archived).toHaveLength(1);
  });
  it('keeps the original owner result when the live account changes and defers archive',async()=>{
    const f=fixture();await timeout(f);const original=clone(f.pending()!);f.setUser('user:bob');await finish(f);
    const slot=f.controller.state.tasks[0].slots[0];
    expect(slot.item).toMatchObject({accountKey:'user:alice',jobId:original.jobId,batchId:original.batchId});
    expect(slot.archiveOk).toBe(false);expect(slot.archiveError).toContain('账号已切换');expect(f.archived).toHaveLength(0);
    expect(f.pending()).toBeNull();expect((await f.controller.run([f.task],f.settings)).code).toBe('STUDIO_ACCOUNT_CHANGED');
    f.setUser('user:alice');await f.controller.retryArchive(slot.item.resultId);expect(f.archived[0].context.accountKey).toBe('user:alice');
  });
  it('isolates a replaced account snapshot from an old success and keeps the old receipt result separately',async()=>{
    const f=fixture();await timeout(f);const saved=f.controller.snapshot(),old=clone(f.pending()!);
    const replacement=clone(saved);replacement.accountKey='user:bob';replacement.batchId='bob-batch';replacement.uncertain={jobId:'bob-job',accountKey:'user:bob',batchId:'bob-batch'};
    replacement.tasks[0].slots[0]={...replacement.tasks[0].slots[0],receiptJobId:'bob-job',status:'uncertain'};
    await injectLegacyExternalSnapshot(f,replacement);f.journal.write(replacement.uncertain);f.setUser('user:bob');await finish(f);
    expect(f.controller.state.accountKey).toBe('user:bob');expect(f.controller.state.tasks[0].slots[0].item).toBeNull();
    expect(f.controller.state.uncertain.jobId).toBe('bob-job');expect(f.pending()!.jobId).toBe('bob-job');
    expect(f.controller.state.previousResults).toHaveLength(0);expect(f.controller.snapshot()).not.toHaveProperty('retainedReceipts');
    expect(JSON.stringify(f.controller.snapshot())).not.toContain(image(99));
    expect(await f.controller.getRetainedReceiptResults('user:alice')).toEqual([]);
    f.setUser('user:alice');expect((await f.controller.getRetainedReceiptResults('user:alice'))[0].item.jobId).toBe(old.jobId);
    expect(f.archived).toHaveLength(0);
  });
  it.each(['edited-plan','same-plan-retry'])('preserves an old success as history after a %s snapshot without replacing a newer response',async(kind)=>{
    const f=fixture();await timeout(f);const old=clone(f.pending()!),replacement=f.controller.snapshot();
    if(kind==='edited-plan')replacement.tasks[0].plan=f.api.editShot(replacement.tasks[0].plan,'shot-1',{prompt:'新方案光线'});
    replacement.tasks[0].slots=replacement.tasks[0].plan.shots.map((shot:Shot,index:number)=>({...replacement.tasks[0].slots[index],shot,receiptJobId:'new-job',status:'done',item:{url:image(66),jobId:'new-job',resultId:'new-job:studio:'+shot.id,studioTaskId:'product',studioGenesisPlan:replacement.tasks[0].plan}}));
    replacement.batchId='new-batch';replacement.uncertain=null;await injectLegacyExternalSnapshot(f,replacement);
    f.journal.write({jobId:'new-job',taskId:'product',shotId:'shot-1',batchId:'new-batch',accountKey:'user:alice'});
    await finish(f);
    expect(f.controller.state.tasks[0].slots[0].item.url).toBe(image(66));expect(f.controller.state.batchId).toBe('new-batch');
    expect(f.controller.state.previousResults).toHaveLength(1);expect(f.controller.state.previousResults[0].item).toMatchObject({jobId:old.jobId,batchId:old.batchId,url:image(99)});
    expect(f.pending()!.jobId).toBe('new-job');expect(f.archived[0].item.jobId).toBe(old.jobId);
  });
  it('does not clear or unregister another job receipt when the old one succeeds',async()=>{
    const f=fixture();await timeout(f);const newer={jobId:'other-job',taskId:'other-task',shotId:'shot-2',batchId:'other-batch',accountKey:'user:alice'};
    f.journal.write(newer);f.controller.state.uncertain=clone(newer);f.registered.add(newer.jobId);await finish(f);
    expect(f.pending()).toEqual(newer);expect(f.controller.state.uncertain).toEqual(newer);expect([...f.registered]).toEqual(['other-job']);
  });
  it('rejects an explicitly different response job identity instead of assigning its image',async()=>{
    const f=fixture();await timeout(f);const pending=clone(f.pending()!);await finish(f,{ok:true,jobId:'wrong-job',images:[image(99)]});
    expect(f.controller.state.tasks[0].slots[0].item).toBeNull();expect(f.archived).toHaveLength(0);expect(f.pending()).toEqual(pending);
    expect(f.controller.state.uncertain.error).toContain('编号不一致');
  });
  it.each(['returned-failure','thrown-failure'])('preserves success after archive %s and retries storage concurrently without regenerating or double saving',async(kind)=>{
    const f=fixture();await timeout(f);f.setArchiveFails(kind==='returned-failure');f.setArchiveThrows(kind==='thrown-failure');await finish(f);
    const slot=f.controller.state.tasks[0].slots[0];expect(slot.status).toBe('done');expect(slot.archiveOk).toBe(false);expect(f.pending()).toBeNull();
    expect((await f.controller.retryFailed([f.task],f.settings)).code).toBe('STUDIO_NOTHING_QUEUED');expect(f.submitted).toHaveLength(1);
    f.setArchiveFails(false);f.setArchiveThrows(false);
    await Promise.all([f.controller.retryArchive(slot.item.resultId),f.controller.retryArchive(slot.item.resultId)]);
    expect(f.archived).toHaveLength(2);expect(slot.archiveOk).toBe(true);
    expect((await f.controller.retryArchive(slot.item.resultId)).skipped).toBe(true);expect(f.archived).toHaveLength(2);
  });
  it('captures original plan, selected model, config, owner and batch before an API edit',async()=>{
    const f=fixture();f.task.plan=f.api.createPlan(f.task,{...f.settings,model:'selected-original'});f.settings.model='selected-original';
    await timeout(f);const receipt=clone(f.pending()!);f.config.provider='new-provider';f.config.imageModel='new-model';await finish(f);
    expect(f.archived[0]).toMatchObject({context:{accountKey:'user:alice',surfaceMode:'detail'},item:{batchId:receipt.batchId,model:'selected-original',generationConfig:{provider:'fixture',imageModel:'selected-original'}}});
  });
  it('rechecks the latest synchronous receipt after an awaited read and preserves a replacement',async()=>{
    const f=fixture();await timeout(f);const newer={jobId:'new-receipt',taskId:'product',shotId:'shot-2',batchId:'next-batch',accountKey:'user:alice'};
    const read=f.journal.read;let reads=0;
    f.journal.read=()=>{const value=read();if(++reads===1)queueMicrotask(()=>f.journal.write(newer));return value;};
    await finish(f);expect(reads).toBe(2);expect(f.pending()).toEqual(newer);expect(f.controller.state.uncertain).toEqual(newer);
  });
  it.each(['jobId','accountKey','taskId','shotId','batchId'])('does not clear a receipt with changed %s identity',async(field)=>{
    const f=fixture();await timeout(f);const changed={...f.pending()!,[field]:'another-identity'};
    f.journal.write(changed);await finish(f);expect(f.pending()).toEqual(changed);
  });
  it('retains an asynchronous journal unless it supplies atomic compareAndClear',async()=>{
    const f=fixture();await timeout(f);const receipt=clone(f.pending()!),read=f.journal.read;
    f.journal.read=async()=>read();await finish(f);
    expect(f.pending()).toEqual(receipt);expect(f.controller.state.uncertain).not.toBeNull();expect(f.archived).toHaveLength(1);
  });
  it('supports an atomic asynchronous journal comparison without clearing another receipt',async()=>{
    const f=fixture();await timeout(f);const read=f.journal.read,clear=f.journal.clear;let compares=0;
    f.journal.read=async()=>read();
    f.journal.compareAndClear=async(receipt:Receipt)=>{compares++;if(JSON.stringify(read())===JSON.stringify(receipt)){clear();return true;}return false;};
    await finish(f);expect(compares).toBe(1);expect(f.pending()).toBeNull();expect(f.controller.state.uncertain).toBeNull();
  });
  it.each(['async','sync'])('holds the account lock through %s timeout persistence failure and blocks a second page',async(kind)=>{
    const f=fixture();let held=false;
    const lock=async(_name:string,callback:()=>Promise<unknown>)=>{if(held)return {ok:false,code:'STUDIO_ALREADY_RUNNING'};held=true;try{return await callback();}finally{held=false;}};
    const check=()=>{if(f.controller.state.awaitingReceipt && f.controller.state.stopped)throw new Error('quota exceeded');};
    f.controller=f.api.createController({bridge:f.bridge,journal:f.journal,lock,timeoutMs:15,onChange:kind==='async'?async()=>check():check});
    const result=await timeout(f);expect(result.code).toBe('STUDIO_EXECUTION_FAILED');expect(held).toBe(true);
    const other=f.api.createController({bridge:f.bridge,journal:f.journal,lock});other.restore(f.controller.snapshot());
    expect((await other.resolveUncertain({confirmed:true})).code).toBe('STUDIO_ALREADY_RUNNING');
    expect((await other.run([f.task],f.settings)).code).toBe('STUDIO_ALREADY_RUNNING');expect(f.submitted).toHaveLength(1);
    await finish(f);expect(held).toBe(false);expect(f.archived).toHaveLength(1);
  });
  it('keeps the receipt uncertain if neither the original nor its draft is saved',async()=>{
    const f=fixture();f.setArchiveFails(true);
    f.controller=f.api.createController({bridge:f.bridge,journal:f.journal,lock:async(_name:string,run:()=>Promise<unknown>)=>run(),timeoutMs:15,onChange:()=>{if(f.controller.state.tasks.some((task:ReceiptTask)=>task.slots.some((slot:Slot)=>slot.item)))throw new Error('quota');}});
    await timeout(f);await finish(f);
    expect(f.pending()).not.toBeNull();expect(f.controller.state.uncertain).not.toBeNull();
    expect(f.controller.state.tasks[0].slots[0].status).toBe('done');expect(f.archived).toHaveLength(1);
  });
  it('does not reuse a new account snapshot result even when its resultId collides',async()=>{
    const f=fixture();await timeout(f);const receipt=clone(f.pending()!),snapshot=f.controller.snapshot();
    snapshot.accountKey='user:bob';snapshot.uncertain=null;
    snapshot.tasks[0].slots[0].status='done';snapshot.tasks[0].slots[0].archiveOk=true;
    snapshot.tasks[0].slots[0].item={url:image(66),resultId:receipt.jobId+':studio:shot-1',jobId:receipt.jobId,accountKey:'user:bob',studioTaskId:'product',studioGenesisPlan:snapshot.tasks[0].plan};
    await injectLegacyExternalSnapshot(f,snapshot);f.setUser('user:bob');await finish(f);
    expect(f.controller.snapshot().tasks[0].slots[0].item.url).toBe(image(66));expect(f.controller.snapshot().tasks[0].slots[0].archiveOk).toBe(true);
    expect(JSON.stringify(f.controller.snapshot())).not.toContain(image(99));expect(f.pending()).toEqual(receipt);
    f.setUser('user:alice');expect((await f.controller.getRetainedReceiptResults('user:alice'))[0].item.url).toBe(image(99));
  });
  it('re-homes the original if a same-owner snapshot is replaced while archive is saving',async()=>{
    const f=fixture();await timeout(f);const replacement=f.controller.snapshot();
    replacement.batchId='new-batch';replacement.uncertain=null;replacement.tasks[0].plan=f.api.editShot(replacement.tasks[0].plan,'shot-1',{prompt:'新方案'});
    replacement.tasks[0].slots=replacement.tasks[0].plan.shots.map((shot:Shot,index:number)=>({...replacement.tasks[0].slots[index],shot,receiptJobId:'new-job',status:'ready',item:null}));
    f.bridge.archive=async()=>{await injectLegacyExternalSnapshot(f,replacement);return {ok:false,error:'磁盘不可写'};};
    await finish(f);expect(f.controller.state.tasks[0].slots[0].item).toBeNull();
    expect(f.controller.state.previousResults[0].item.url).toBe(image(99));expect(f.controller.state.previousResults[0].archiveOk).toBe(false);
    expect(f.pending()).toBeNull();
  });
});
