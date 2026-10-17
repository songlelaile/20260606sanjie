import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { webcrypto } from "node:crypto";
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
  mode:string;ratio:string;resolution:string;count:number;language:string;platform:string;moduleMode:string;modules:string[];model:string;imageType?:string;
}
interface Shot { id:string;index:number;label:string;prompt:string; }
interface PlanSnapshot { taskId:string;shots:Shot[]; }
interface TestTask {
  id:string;name:string;requirements:string;products:Array<{image:string;name:string;width:number;height:number}>;
  overrides:Partial<StudioSettings>|null;analysis:string;plan:unknown;
}
interface GenerationMessage {
  config:typeof configuration;
  payload:{studioGenesisPlan:{shotId:string;plan:PlanSnapshot};ratio:string;prompt:string;[key:string]:unknown};
}
interface ProviderResponse { ok:boolean;images?:string[];error?:string;definitiveFailure?:boolean;stateUncertain?:boolean; }
interface ArchiveContext { accountKey:string;surfaceMode:string; }
interface ResultItem { resultId:string;url:string;[key:string]:unknown; }
interface SlotState { status:string; }
interface TaskState { slots:SlotState[]; }

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
describe("studio 100 concurrent generation",()=>{
  function concurrentFixture(options:Record<string,unknown>={}) {
    const api=engine(),{value,settings}=task(api,'parallel-receipts',2);
    type Receipt=Record<string,string>;
    const receipts=new Map<string,Receipt>(),replies=new Map<string,(response:ProviderResponse)=>void>();let job=0;
    const read=(excluded:string[]=[])=>[...receipts.values()].find(receipt=>!excluded.includes(receipt.jobId))||null;
    const journal={concurrent:true,read,readExcluding:read,readReceipt:(receipt:Receipt)=>receipts.get(receipt.jobId)||null,
      write:(receipt:Receipt)=>{receipts.set(receipt.jobId,clone(receipt));},clear:()=>{const receipt=read();if(receipt)receipts.delete(receipt.jobId);},
      compareAndClear:(receipt:Receipt)=>{const saved=receipts.get(receipt.jobId);if(!saved||!['jobId','accountKey','taskId','shotId','batchId'].every(key=>saved[key]===receipt[key]))return false;receipts.delete(receipt.jobId);return true;}};
    const bridge={getAccountKey:async()=>'parallel-owner',modelInfo:()=>({ready:true,supportsReference:true}),config:()=>configuration,
      newJobId:()=>`parallel-${++job}`,send:async(_type:string,message:{jobId:string})=>new Promise<ProviderResponse>(resolve=>replies.set(message.jobId,resolve)),archive:async()=>({ok:true})};
    const controller=api.createController({concurrency:100,workspaceKey:'single:main',lock:async(_name:string,run:()=>unknown)=>run(),journal,bridge,...options});
    return {controller,value,settings,journal,bridge,receipts,replies};
  }
  it('resolves out-of-order uncertain replies by their own receipt and keeps the other request awaiting confirmation',async()=>{
    const f=concurrentFixture(),running=f.controller.run([f.value],f.settings);
    await expect.poll(()=>f.replies.size).toBe(2);
    f.replies.get('parallel-2')!({ok:false,stateUncertain:true,error:'second request unknown'});
    await expect.poll(()=>f.controller.state.uncertain?.jobId).toBe('parallel-2');
    f.replies.get('parallel-1')!({ok:false,stateUncertain:true,error:'first request unknown'});
    expect(await running).toMatchObject({ok:false,uncertain:true,awaitingReceipt:false});
    expect((await f.controller.resolveUncertain({confirmed:true})).ok).toBe(true);
    expect([...f.receipts.keys()]).toEqual(['parallel-1']);
    expect(f.controller.state.uncertain.jobId).toBe('parallel-1');
    expect(f.controller.state.tasks[0].slots.map((slot:SlotState)=>slot.status)).toEqual(['uncertain','failed']);
    expect((await f.controller.resolveUncertain({confirmed:true})).ok).toBe(true);
    expect(f.receipts.size).toBe(0);expect(f.controller.state.uncertain).toBeNull();
    expect(f.replies.size).toBe(2);
  });
  it('reserves receipts while saving so delayed sibling account checks cannot treat the same batch as an external request',async()=>{
    const f=concurrentFixture();let accountCalls=0,releaseAccount!:()=>void,releaseSave!:()=>void,changeCalls=0;
    const accountWait=new Promise<void>(resolve=>{releaseAccount=resolve;}),saveWait=new Promise<void>(resolve=>{releaseSave=resolve;});
    f.bridge.getAccountKey=async()=>{if(++accountCalls===5)await accountWait;return 'parallel-owner';};
    const write=f.journal.write;f.journal.write=receipt=>{write(receipt);releaseAccount();};
    const controller=engine().createController({concurrency:100,workspaceKey:'single:main',lock:async(_name:string,run:()=>unknown)=>run(),journal:f.journal,bridge:f.bridge,
      onChange:async()=>{if(++changeCalls===2)await saveWait;}});
    const running=controller.run([f.value],f.settings);
    await expect.poll(()=>f.receipts.size).toBe(2);releaseSave();
    await expect.poll(()=>f.replies.size).toBe(2);
    f.replies.forEach(reply=>reply({ok:true,images:[OUTPUT]}));
    expect(await running).toMatchObject({ok:true,completed:2});expect(f.receipts.size).toBe(0);
  });
  it('keeps another unresolved receipt after a timed-out request returns a late success',async()=>{
    const f=concurrentFixture({timeoutMs:20}),running=f.controller.run([f.value],f.settings);
    await expect.poll(()=>f.replies.size).toBe(2);
    expect(await running).toMatchObject({ok:false,uncertain:true,awaitingReceipt:true});
    const successfulJob=f.controller.state.uncertain.jobId,otherJob=successfulJob==='parallel-1'?'parallel-2':'parallel-1';
    f.replies.get(otherJob)!({ok:false,stateUncertain:true,error:'other request unknown'});
    f.replies.get(successfulJob)!({ok:true,images:[OUTPUT]});
    await expect.poll(()=>f.controller.hasInFlightRequest()).toBe(false);
    expect(f.controller.state.uncertain.jobId).toBe(otherJob);expect([...f.receipts.keys()]).toEqual([otherJob]);
    expect((await f.controller.resolveUncertain({confirmed:true})).ok).toBe(true);expect(f.receipts.size).toBe(0);
    expect(f.controller.state.tasks[0].slots.filter((slot:{item?:unknown})=>!!slot.item)).toHaveLength(1);
  });
  it('holds the workspace lock through sibling receipt persistence after one worker fails before submission',async()=>{
    const f=concurrentFixture();let changeCalls=0,held=false,settled=false,releaseFailure!:()=>void,releaseSave!:()=>void;
    const failWait=new Promise<void>(resolve=>{releaseFailure=resolve;}),saveWait=new Promise<void>(resolve=>{releaseSave=resolve;});
    const controller=engine().createController({concurrency:100,workspaceKey:'single:main',journal:f.journal,bridge:f.bridge,
      lock:async(_name:string,run:()=>unknown)=>{held=true;try{return await run();}finally{held=false;}},
      onChange:async()=>{const call=++changeCalls;if(call===2){await failWait;throw new Error('fixture save failure');}if(call===3)await saveWait;}});
    const running=controller.run([f.value],f.settings);running.then(()=>{settled=true;});
    await expect.poll(()=>changeCalls).toBe(3);releaseFailure();
    await expect.poll(()=>controller.state.stopped).toBe(true);
    expect(held).toBe(true);expect(settled).toBe(false);expect(f.replies.size).toBe(0);
    releaseSave();expect(await running).toMatchObject({ok:false});
    expect(held).toBe(false);expect(f.replies.size).toBe(0);expect(f.receipts.size).toBe(0);
  });
  it("starts 100 independent requests, queues overflow, and consumes out-of-order receipts once",async()=>{
    const api=engine(), settings={...api.defaults('main'),count:20};
    const tasks=Array.from({length:6},(_,index)=>task(api,`concurrent-${index}`,20).value);
    type Receipt=Record<string,string>;
    const receipts=new Map<string,Receipt>(), replies=new Map<string,(value:ProviderResponse)=>void>();
    const archived:string[]=[];let job=0,active=0,peak=0;
    const read=(excluded:string[]=[])=>[...receipts.values()].find(value=>!excluded.includes(value.jobId))||null;
    const controller=api.createController({concurrency:100,workspaceKey:'single:main',lock:async(_name:string,run:()=>unknown)=>run(),
      journal:{concurrent:true,read,readExcluding:read,readReceipt:(receipt:Receipt)=>receipts.get(receipt.jobId)||null,
        write:(receipt:Receipt)=>receipts.set(receipt.jobId,clone(receipt)),clear:()=>{},
        compareAndClear:(receipt:Receipt)=>receipts.delete(receipt.jobId)},
      bridge:{getAccountKey:async()=>'concurrent-owner',modelInfo:()=>({ready:true,supportsReference:true}),config:()=>configuration,
        newJobId:()=>`parallel-${++job}`,send:async(_type:string,message:{jobId:string})=>{
          active++;peak=Math.max(peak,active);
          return new Promise<ProviderResponse>(resolve=>replies.set(message.jobId,value=>{active--;resolve(value);}));
        },archive:async(item:{jobId:string})=>{archived.push(item.jobId);return {ok:true};}}
    });
    const running=controller.run(tasks,settings);
    await expect.poll(()=>replies.size).toBe(100);
    expect(peak).toBe(100);expect(receipts.size).toBe(100);
    expect(controller.run(tasks,settings)).toBe(running);
    const first=[...replies.entries()].reverse();
    first.forEach(([id,reply])=>{replies.delete(id);reply({ok:true,images:[OUTPUT]});});
    await expect.poll(()=>job).toBe(120);
    await expect.poll(()=>replies.size).toBe(20);
    [...replies.entries()].forEach(([id,reply])=>{replies.delete(id);reply({ok:true,images:[OUTPUT]});});
    expect(await running).toMatchObject({ok:true,completed:120,total:120});
    expect(peak).toBe(100);expect(receipts.size).toBe(0);
    expect(archived).toHaveLength(120);expect(new Set(archived).size).toBe(120);
  },20000);
});
