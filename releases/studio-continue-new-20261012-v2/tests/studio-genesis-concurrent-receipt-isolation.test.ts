import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const image = (marker: number) => {
  const bytes = Buffer.alloc(32);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  bytes.writeUInt32BE(64,16); bytes.writeUInt32BE(64,20); bytes[26] = marker;
  return `data:image/png;base64,${bytes.toString("base64")}`;
};
const PRODUCT = image(1), OTHER = image(2), OUTPUT = image(3);
const assetRoot = process.env.CREATIVE_ASSET_TEST_ROOT || "public/creative";
const script = (path: string) => readFileSync(resolve(assetRoot,path),"utf8");
const clone = <T>(value:T):T => JSON.parse(JSON.stringify(value));
const configuration = {provider:"openai-compatible",imageAdapter:"generic-json",apiKey:"synthetic-key",imageEndpoint:"https://provider.test/v1/images",imageModel:"fixture-image",visionBaseUrl:"https://provider.test/v1",visionModel:"fixture-vision",textModel:"fixture-text"};
interface StudioSettings {
  mode:string;ratio:string;resolution:string;count:number;language:string;platform:string;moduleMode:string;modules:string[];model:string;
}
interface TestTask {
  id:string;name:string;requirements:string;products:Array<{image:string;name:string;width:number;height:number}>;
  overrides:Partial<StudioSettings>|null;analysis:string;plan:unknown;
}
interface ProviderResponse { ok:boolean;images?:string[];error?:string;definitiveFailure?:boolean;stateUncertain?:boolean; }
interface ResultItem { resultId:string;url:string;[key:string]:unknown; }

function engine() {
  const context = createContext({URL,setTimeout,clearTimeout,console}); context.window = context;
  runInContext(script("labs/image-prompt-lab/studio-genesis-contract.js"),context);
  return context.SZ_STUDIO_GENESIS;
}
function task(api:ReturnType<typeof engine>,id="a",count=2,mode="main") {
  const settings={...api.defaults(mode),count};
  const value:TestTask={id,name:`商品 ${id}`,requirements:"柔和光线，突出原图可见细节",products:[{image:PRODUCT,name:"正面",width:64,height:64}],overrides:null,analysis:"",plan:null};
  value.plan=api.createPlan(value,settings); expect((value.plan as {ok:boolean}).ok).toBe(true);
  return {value,settings};
}
describe('receipt isolation without user unlock',()=>{
  type Receipt=Record<string,string>;
  function concurrent(options:Record<string,unknown>={}) {
    const api=engine(),receipts=new Map<string,Receipt>(),replies=new Map<string,(response:ProviderResponse)=>void>(),sent:string[]=[],archives:ResultItem[]=[],locks:string[]=[];
    let job=0,held=false;
    const read=(excluded:string[]=[])=>[...receipts.values()].find(receipt=>!excluded.includes(receipt.jobId))||null;
    const journal={concurrent:true,read,readAll:()=>[...receipts.values()],readExcluding:read,readReceipt:(receipt:Receipt)=>receipts.get(receipt.jobId)||null,write:(receipt:Receipt)=>receipts.set(receipt.jobId,clone(receipt)),clear:()=>{},compareAndClear:(receipt:Receipt)=>{const saved=receipts.get(receipt.jobId);if(!saved||!['jobId','taskId','shotId','accountKey','batchId'].every(key=>saved[key]===receipt[key]))return false;receipts.delete(receipt.jobId);return true;}};
    const bridge={getAccountKey:async()=>'isolation-owner',config:()=>configuration,modelInfo:()=>({ready:true,supportsReference:true}),newJobId:()=>`isolation-${++job}`,send:async(_type:string,message:{jobId:string})=>{sent.push(message.jobId);return new Promise<ProviderResponse>(resolve=>replies.set(message.jobId,resolve));},archive:async(item:ResultItem)=>{archives.push(clone(item));return {ok:true};}};
    const controller=api.createController({journal,bridge,concurrency:100,workspaceKey:'single:detail',lock:async(name:string,run:()=>unknown)=>{if(held)return {ok:false,code:'STUDIO_ALREADY_RUNNING'};held=true;locks.push(name);try{return await run();}finally{held=false;}},...options});
    return {api,controller,journal,bridge,receipts,replies,sent,archives,locks,held:()=>held};
  }
  it('continues overflow after an unknown reply with peak100 and preserves its exact receipt',async()=>{
    const f=concurrent(),tasks=Array.from({length:6},(_,i)=>task(f.api,`isolation-product-${i}`,20).value),settings={...f.api.defaults('main'),count:20};
    let active=0,peak=0;const send=f.bridge.send;f.bridge.send=async(type,message)=>{active++;peak=Math.max(peak,active);try{return await send(type,message);}finally{active--;}};
    const running=f.controller.run(tasks,settings);await expect.poll(()=>f.sent.length,{interval:1}).toBe(100);
    f.replies.get('isolation-1')!({ok:false,stateUncertain:true,error:'missing reply'});
    await expect.poll(()=>f.sent.length,{interval:1}).toBe(101);
    for(let i=2;i<=120;i++){await expect.poll(()=>f.replies.has(`isolation-${i}`),{interval:1}).toBe(true);f.replies.get(`isolation-${i}`)!({ok:true,images:[OUTPUT]});}
    expect(await running).toMatchObject({ok:false,completed:119,uncertain:true,stopped:false});
    expect(peak).toBe(100);expect(f.sent).toHaveLength(120);expect([...f.receipts.keys()]).toEqual(['isolation-1']);expect(f.archives).toHaveLength(119);
  });
  it('releases the workspace after timeout, permits independent run and archives the original late result once',async()=>{
    const f=concurrent({timeoutMs:15}),one=task(f.api,'original',1),two=task(f.api,'independent',1);
    const first=f.controller.run([one.value],one.settings);await expect.poll(()=>f.sent.length,{interval:1}).toBe(1);
    expect(await first).toMatchObject({uncertain:true,awaitingReceipt:true});expect(f.held()).toBe(false);
    expect((await f.controller.retrySlot(one.value.id,'shot-1',[one.value],one.settings)).code).toBe('STUDIO_RECEIPT_PENDING');expect(f.sent).toHaveLength(1);
    const second=f.controller.run([two.value],two.settings);await expect.poll(()=>f.sent.length,{interval:1}).toBe(2);
    f.replies.get('isolation-2')!({ok:true,images:[OUTPUT]});expect(await second).toMatchObject({ok:true});
    f.replies.get('isolation-1')!({ok:true,images:[OTHER]});await expect.poll(()=>f.controller.hasInFlightRequest(),{interval:1}).toBe(false);
    expect(f.receipts.size).toBe(0);expect(f.archives.map(item=>item.jobId).sort()).toEqual(['isolation-1','isolation-2']);
    expect(f.archives.find(item=>item.jobId==='isolation-1')?.studioTaskId).toBe('original');expect(f.sent).toHaveLength(2);
  });
  it('does not revive a stopped original waiting for a slot when a new run resets stopped=false',async()=>{
    let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});let calls=0;
    const f=concurrent({timeoutMs:15,withGenerationSlot:async(_owner:string,send:()=>unknown,cancelled:()=>boolean)=>{if(++calls===1)await waiting;return cancelled()?{ok:false,definitiveFailure:true,providerSubmitted:false,error:'cancelled before submit'}:send();}}),one=task(f.api,'stopped-original',1),two=task(f.api,'next-run',1);
    expect(await f.controller.run([one.value],one.settings)).toMatchObject({uncertain:true,awaitingReceipt:true});
    await f.controller.stop();const second=f.controller.run([two.value],two.settings);await expect.poll(()=>f.sent.length,{interval:1}).toBe(1);
    expect(f.controller.state.busy).toBe(true);const currentBatch=f.controller.state.batchId;release();
    await expect.poll(()=>f.receipts.has('isolation-1'),{interval:1}).toBe(false);
    expect(f.controller.state.busy).toBe(true);expect(f.controller.state.batchId).toBe(currentBatch);expect(f.sent).toEqual(['isolation-2']);
    f.replies.get('isolation-2')!({ok:true,images:[OUTPUT]});expect(await second).toMatchObject({ok:true});expect(f.archives).toHaveLength(1);
  });
  it('binds every restored receipt, skips exact slots after plan editing and permits unrelated task',async()=>{
    const f=concurrent(),one=task(f.api,'pending-product',2),two=task(f.api,'new-product',1);
    f.controller.state.accountKey='isolation-owner';two.value.overrides={count:1};
    const pending=[1,2].map(i=>({jobId:`saved-${i}`,taskId:one.value.id,shotId:`shot-${i}`,batchId:'old-batch',accountKey:'isolation-owner'}));pending.forEach(f.journal.write);
    expect(await f.controller.recoverPendingReceipt()).toMatchObject({pending:true,receipts:pending});
    one.value.plan=f.api.editShot(one.value.plan,'shot-1',{prompt:'An edited view'});
    const running=f.controller.run([one.value,two.value],one.settings);await expect.poll(()=>f.sent.length,{interval:1}).toBe(1);
    f.replies.get('isolation-1')!({ok:true,images:[OUTPUT]});expect(await running).toMatchObject({ok:true});expect(f.receipts.size).toBe(2);expect(f.sent).toHaveLength(1);
  });
  it('automatically clears a saved trusted notSubmitted outcome without a resend',async()=>{
    const f=concurrent(),one=task(f.api,'not-submitted',1),controller=f.controller;
    const clear=f.journal.compareAndClear;f.journal.compareAndClear=()=>false;
    const running=controller.run([one.value],one.settings);await expect.poll(()=>f.sent.length,{interval:1}).toBe(1);
    f.replies.get('isolation-1')!({ok:false,definitiveFailure:true,providerSubmitted:false,error:'not submitted'} as ProviderResponse);
    await running;const saved=controller.snapshot();f.journal.compareAndClear=clear;
    const restored=f.api.createController({journal:f.journal,bridge:f.bridge,concurrency:100,lock:async(_name:string,run:()=>unknown)=>run()});restored.restore(saved);
    expect(await restored.recoverPendingReceipt()).toMatchObject({ok:true,pending:false,uncertain:false});expect(f.receipts.size).toBe(0);expect(f.sent).toHaveLength(1);expect(restored.state.tasks[0].slots[0].status).toBe('failed');
  });
  it('upgrades an old anonymous interrupted receipt without leaving a permanent duplicate',async()=>{
    const f=concurrent(),one=task(f.api,'anonymous-original',1),running=f.controller.run([one.value],one.settings);
    await expect.poll(()=>f.sent.length,{interval:1}).toBe(1);f.replies.get('isolation-1')!({ok:false,stateUncertain:true,error:'missing response'});await running;
    const saved=f.controller.snapshot();saved.pendingReceipts=[];delete saved.uncertain.jobId;delete saved.tasks[0].slots[0].receiptJobId;delete saved.tasks[0].slots[0].pendingReceipt.jobId;
    const restored=f.api.createController({journal:f.journal,bridge:f.bridge,concurrency:100,lock:async(_name:string,run:()=>unknown)=>run()});restored.restore(saved);
    await restored.recoverPendingReceipt();expect(restored.state.pendingReceipts.map((receipt:Receipt)=>receipt.jobId)).toEqual(['isolation-1']);
    expect(await restored.resolveUncertain({confirmed:true})).toMatchObject({ok:true});expect(restored.state.pendingReceipts).toEqual([]);expect(restored.state.uncertain).toBeNull();expect(f.sent).toHaveLength(1);
  });

});
