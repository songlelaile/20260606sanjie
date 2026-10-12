import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve(process.env.CREATIVE_ASSET_TEST_ROOT || 'public/creative', 'labs/image-prompt-lab/studio-genesis-contract.js'), 'utf8');
const clone = <T>(value:T):T => JSON.parse(JSON.stringify(value));
type Shot = {id:string;index:number;label:string;prompt:string};
type Plan = {ok:boolean;taskId:string;input:{id:string};settings:Record<string,unknown>;sourceSignature:string;signature:string;shots:Shot[]};
type Receipt = {jobId:string;taskId:string;shotId:string;accountKey:string;batchId:string};
type Reply = {ok:boolean;images?:string[];stateUncertain?:boolean;error?:string};
type Result = {jobId:string;studioTaskId:string;url:string;studioGenesisPlan:Plan};
const deferred = <T>() => { let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve}; };
const flush = async () => { for(let i=0;i<100;i++)await Promise.resolve(); };

function fixture(mode='main') {
  const context=createContext({URL,setTimeout,clearTimeout});context.window=context;
  runInContext(source,context);const api=context.SZ_STUDIO_GENESIS;
  const settings={...api.defaults(mode),count:1,model:'fixture-image'};
  const task={id:'original-product',name:'同款外套',requirements:'保留原图材质',analysis:'米白色外套',products:[{image:'https://fixture.test/product.png',name:'正面'}],overrides:null,plan:null as Plan|null};
  task.plan=api.createPlan(task,settings);
  task.plan=api.editShot(task.plan,'shot-1',{label:'已核对的自定义名称',prompt:'已核对的独立构图，保持商品原样。'});
  return {api,settings,task};
}

afterEach(()=>vi.useRealTimers());

describe('explicit independent copy of a confirmed studio plan',()=>{
  it.each(['main','detail'])('preserves every confirmed %s field and regenerates valid task signatures',mode=>{
    const {api,settings,task}=fixture(mode),original=clone(task.plan!);
    const copied:Plan=api.reidentifyPlan(task.plan,'independent-product');
    expect(copied).toMatchObject({ok:true,taskId:'independent-product',input:{id:'independent-product'}});
    expect(copied.shots).toEqual(original.shots);expect(copied.settings).toEqual(original.settings);
    expect(copied.input).toEqual({...original.input,id:'independent-product'});
    expect(copied.sourceSignature).not.toBe(original.sourceSignature);expect(copied.signature).not.toBe(original.signature);
    expect(api.validatePlan(copied,{...task,id:'independent-product',plan:copied},settings)).toEqual({ok:true});
    expect(api.createPayload(copied,'shot-1').prompt).toBe(api.createPayload(original,'shot-1').prompt);
    expect(task.plan).toEqual(original);
    copied.shots[0].prompt='later edit';expect(task.plan!.shots).toEqual(original.shots);
  });

  it('keeps the stored legacy settings shape without adding current defaults',()=>{
    const {api,task}=fixture();expect(task.plan!.settings).not.toHaveProperty('imageType');
    const copied=api.reidentifyPlan(task.plan,'another-product');
    expect(copied.settings).toEqual(task.plan!.settings);expect(copied.settings).not.toHaveProperty('imageType');
    expect(api.validatePlan(copied)).toEqual({ok:true});
  });

  it.each([null,{}, {ok:true}, 'invalid'])('rejects an invalid source plan (%s)',value=>{
    expect(fixture().api.reidentifyPlan(value,'new-product')).toMatchObject({ok:false});
  });

  it('rejects tampered confirmed content without repairing or changing it',()=>{
    const {api,task}=fixture();task.plan!.shots[0].prompt='unsigned change';const original=clone(task.plan);
    expect(api.reidentifyPlan(task.plan,'new-product')).toMatchObject({ok:false,code:'STUDIO_PLAN_STALE'});
    expect(task.plan).toEqual(original);
  });

  it.each(['original-product','',' whitespace ',null,17,'x'.repeat(161),'bad\u0000id'])('requires a distinct valid task identity (%s)',value=>{
    const {api,task}=fixture(),original=clone(task.plan);
    expect(api.reidentifyPlan(task.plan,value)).toMatchObject({ok:false,code:'STUDIO_TASK_ID'});
    expect(task.plan).toEqual(original);
  });

  it('keeps the original uncertain receipt and accepts its late result under the original task',async()=>{
    vi.useFakeTimers();const {api,task,settings}=fixture();
    const receipts=new Map<string,Receipt>(),sent:Receipt[]=[],archived:Result[]=[];
    const originalReply=deferred<Reply>(),started=deferred<void>();let job=0;
    const journal={
      concurrent:true,read:()=>[...receipts.values()][0]||null,readAll:()=>[...receipts.values()],
      readReceipt:(receipt:Receipt)=>receipts.get(receipt.jobId)||null,
      write:(receipt:Receipt)=>receipts.set(receipt.jobId,clone(receipt)),clear:()=>{},
      compareAndClear:(receipt:Receipt)=>{const saved=receipts.get(receipt.jobId);if(!saved||!['jobId','taskId','shotId','accountKey','batchId'].every(key=>saved[key as keyof Receipt]===receipt[key as keyof Receipt]))return false;receipts.delete(receipt.jobId);return true;}
    };
    const bridge={
      getAccountKey:async()=>'copy-owner',config:()=>({provider:'fixture',imageModel:'fixture-image'}),modelInfo:()=>({ready:true,supportsReference:true}),newJobId:()=>`copy-job-${++job}`,
      send:async(_type:string,message:{jobId:string})=>{sent.push(clone(receipts.get(message.jobId)!));if(sent.length===1){started.resolve();return originalReply.promise;}return {ok:true,images:['https://fixture.test/new-result.png']};},
      archive:async(item:Result)=>{archived.push(clone(item));return {ok:true};}
    };
    const controller=api.createController({bridge,journal,concurrency:100,timeoutMs:15,lock:async(_name:string,run:()=>unknown)=>run()});
    const first=controller.run([task],settings);await started.promise;await vi.advanceTimersByTimeAsync(15);
    expect(await first).toMatchObject({uncertain:true,awaitingReceipt:true});
    const originalReceipt=clone(journal.read()!),originalRecord=clone(controller.state.tasks[0]);
    const copiedPlan=api.reidentifyPlan(task.plan,'independent-product'),next={...task,id:'independent-product',plan:copiedPlan};
    expect(receipts.get(originalReceipt.jobId)).toEqual(originalReceipt);expect(sent).toHaveLength(1);
    expect(await controller.run([next],settings)).toMatchObject({ok:true});
    expect(controller.state.tasks.find((record:{id:string})=>record.id===task.id)).toEqual(originalRecord);
    expect(receipts.get(originalReceipt.jobId)).toEqual(originalReceipt);expect(receipts.size).toBe(1);
    expect(sent.map(receipt=>receipt.taskId)).toEqual(['original-product','independent-product']);
    const snapshot=controller.snapshot(),restored=api.createController({bridge,journal});
    expect(restored.restore(snapshot)).toEqual({ok:true});
    expect(restored.state.tasks.map((record:{id:string})=>record.id)).toEqual(['original-product','independent-product']);
    expect(restored.state.tasks[0].slots[0].pendingReceipt).toEqual(originalReceipt);
    originalReply.resolve({ok:true,images:['https://fixture.test/old-result.png']});await flush();
    expect(controller.hasInFlightRequest()).toBe(false);expect(receipts.size).toBe(0);expect(controller.state.uncertain).toBeNull();
    expect(archived).toHaveLength(2);
    expect(archived.find(item=>item.jobId===originalReceipt.jobId)).toMatchObject({studioTaskId:'original-product',url:'https://fixture.test/old-result.png',studioGenesisPlan:{signature:task.plan!.signature}});
    expect(controller.state.tasks.find((record:{id:string})=>record.id==='independent-product').slots[0].item).toMatchObject({studioTaskId:'independent-product',url:'https://fixture.test/new-result.png',studioGenesisPlan:{signature:copiedPlan.signature}});
    expect(sent).toHaveLength(2);
  });
  it('atomically rejects replacing a pending plan even when a changed plan contains new ready positions',async()=>{
    const {api,task,settings}=fixture();const receipts=new Map<string,Receipt>();let sends=0;
    const journal={concurrent:true,read:()=>[...receipts.values()][0]||null,readAll:()=>[...receipts.values()],readReceipt:(r:Receipt)=>receipts.get(r.jobId)||null,
      write:(r:Receipt)=>receipts.set(r.jobId,clone(r)),clear:()=>{},compareAndClear:(r:Receipt)=>receipts.delete(r.jobId)};
    const bridge={getAccountKey:async()=>'copy-owner',config:()=>({provider:'fixture',imageModel:'fixture-image'}),modelInfo:()=>({ready:true,supportsReference:true}),newJobId:()=>`guard-job-${++sends}`,
      send:async()=>({ok:false,stateUncertain:true,error:'unknown fixture response'}),archive:async()=>({ok:true})};
    const controller=api.createController({bridge,journal,concurrency:100,lock:async(_name:string,run:()=>unknown)=>run()});
    await controller.run([task],settings);
    const snapshot=clone(controller.snapshot()),receipt=clone(journal.read());
    const updatedSettings={...settings,count:2},updated={...task,requirements:'changed confirmed composition'};updated.plan=api.createPlan(updated,updatedSettings);
    const unrelated={...updated,id:'unrelated-product'};unrelated.plan=api.createPlan(unrelated,updatedSettings);
    const result=await controller.run([unrelated,updated],updatedSettings);
    expect(result).toMatchObject({ok:false,code:'STUDIO_PLAN_RECEIPT_CONFLICT'});
    expect(sends).toBe(1);expect(controller.snapshot()).toMatchObject(snapshot);expect(controller.state.tasks).toHaveLength(1);expect(journal.read()).toEqual(receipt);
    const copied={...updated,id:'safe-new-product',plan:api.reidentifyPlan(updated.plan,'safe-new-product')};
    await controller.run([copied],updatedSettings);
    expect(sends).toBe(3);expect(controller.state.tasks.find((r:{id:string})=>r.id===task.id)).toMatchObject(snapshot.tasks[0]);
    expect(receipts.get(receipt!.jobId)).toEqual(receipt);
  });

});
