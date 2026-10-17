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
  mode:string;ratio:string;resolution:string;count:number;language:string;platform:string;moduleMode:string;modules:string[];model:string;
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
function fixture(api:ReturnType<typeof engine>,options:Record<string,unknown>={}) {
  let username="user:alice",pending:unknown=null,archiveFails=false;
  const config=clone(configuration),submitted:GenerationMessage[]=[],archived:Array<{item:ResultItem;context:ArchiveContext}>=[];
  const bridge={getAccountKey:async()=>username,config:()=>config,modelInfo:()=>({ready:true,supportsReference:true}),archiveContext:()=>({accountKey:username,surfaceMode:"main"}),send:async(type:string,message:GenerationMessage):Promise<ProviderResponse>=>{if(type!=="GENERATE_IMAGE")throw new Error(type);submitted.push(clone(message));return {ok:true,images:[OUTPUT]};},archive:async(item:ResultItem,context:ArchiveContext)=>{archived.push({item:clone(item),context:clone(context)});return archiveFails?{ok:false,error:"磁盘写入失败"}:{ok:true};}};
  const journal={read:()=>pending,write:(receipt:unknown)=>{pending=clone(receipt);},clear:()=>{pending=null;}};
  const controller=api.createController({bridge,journal,lock:async(_name:string,run:()=>unknown)=>run(),...options});
  return {controller,bridge,journal,config,submitted,archived,setUser:(next:string)=>{username=next;},setArchiveFails:(next:boolean)=>{archiveFails=next;},pending:()=>pending};
}
function backend(providerStatus=200, providerBody?:unknown, providerHeaders?:HeadersInit) {
  const requests:Array<{url:string;body:Record<string,unknown>}>=[];
  const local=new Map<string,string>();
  const storage={get length(){return local.size;},key:(index:number)=>[...local.keys()][index]||null,getItem:(key:string)=>local.get(key)??null,setItem:(key:string,value:string)=>local.set(key,value),removeItem:(key:string)=>local.delete(key)};
  const context=createContext({URL,URLSearchParams,Request,Headers,Response,Blob,FormData,TextEncoder,TextDecoder,ArrayBuffer,Uint8Array,btoa,atob,console,setTimeout,clearTimeout,AbortController,crypto:webcrypto,localStorage:storage,sessionStorage:storage,__SZ_PROMPTLAB_BACKGROUND_TEST_MODE__:true,location:{href:"https://site.test/creative/labs/image-prompt-lab/promptlab.html?mode=studio",origin:"https://site.test",search:"?mode=studio"},document:{getElementById:()=>null,addEventListener(){},body:{classList:{contains:()=>false,toggle(){}}}},addEventListener(){},fetch:async(input:string,init?:RequestInit)=>{
    if(input==="/api/auth/me")return Response.json({data:{id:"alice",tenantId:"shop",username:"alice",creativeEntitlement:{allowed:true}}});
    if(input!=="/api/creative/proxy")throw new Error(`Unexpected network: ${input}`);
    if(init?.body instanceof FormData)requests.push({url:String(init.body.get('__sz_url')),body:Object.fromEntries([...init.body.entries()].filter(([name])=>!name.startsWith('__sz_')))});
    else {const envelope=JSON.parse(String(init?.body));const raw=envelope.bodyText||Buffer.from(envelope.bodyBase64,"base64").toString();requests.push({url:envelope.url,body:JSON.parse(raw)});}
    return providerStatus===200?Response.json({data:[{url:OUTPUT}]}):Response.json(providerBody || {error:{message:"provider fixture rejected request"}},{status:providerStatus,headers:providerHeaders});
  }}); context.window=context;
  for(const file of ["web-chrome.js","src/business-knowledge.js","src/subject-orchestration.js","src/subject-assets.js","src/reference-detail-contract.js","labs/image-prompt-lab/reference-detail-blueprint.js","labs/image-prompt-lab/reference-detail-batch.js","labs/image-prompt-lab/viral-series-contract.js","labs/image-prompt-lab/style-refresh-contract.js","labs/image-prompt-lab/creative-tools-contract.js","labs/image-prompt-lab/studio-genesis-contract.js","labs/image-prompt-lab/image-archive-store.js","labs/image-prompt-lab/background.js"])runInContext(script(file),context,{filename:file});
  return {api:context.SZ_STUDIO_GENESIS,background:context.__SZ_PROMPTLAB_BACKGROUND_TEST_API__,requests};
}

describe("product-first studio plans",()=>{
  it("inherits global settings, allows task overrides and invalidates changed inputs",()=>{
    const api=engine(),{value,settings}=task(api);
    const override={...value,overrides:{ratio:"3:4",resolution:"2K",count:3,model:"private-image"}};
    const effective=api.resolveSettings(settings,override);
    expect(effective).toMatchObject({mode:"main",ratio:"3:4",resolution:"2K",count:3,model:"private-image"});
    const plan=api.createPlan(override,effective);
    expect(plan.shots).toHaveLength(3);
    expect(api.validatePlan(plan,override,effective).ok).toBe(true);
    expect(api.validatePlan(plan,{...override,requirements:"new requirement"},effective).code).toBe("STUDIO_PLAN_STALE");
    expect(api.validatePlan(plan,{...override,products:[{image:OTHER,name:"正面",width:64,height:64}]},effective).ok).toBe(false);
    expect(api.validatePlan(plan,override,{...effective,model:"other-image"}).ok).toBe(false);
  });
  it("rejects invalid count, MIME, settings and empty custom modules",()=>{
    const api=engine(),{value,settings}=task(api);
    expect(api.createPlan(value,{...settings,count:21}).code).toBe("STUDIO_COUNT");
    expect(api.createPlan(value,{...settings,ratio:"7:9"}).ok).toBe(false);
    expect(api.createPlan(value,{...settings,moduleMode:"custom",modules:[]}).ok).toBe(false);
    expect(api.createPlan({...value,products:[{image:"data:image/svg+xml;base64,PHN2Zz4="}]},settings).code).toBe("STUDIO_PRODUCT_IMAGE");
    expect(api.createPlan({...value,products:Array(7).fill({image:PRODUCT})},settings).ok).toBe(false);
  });
  it("edits immutable shots, binds payload to plan and always keeps identity constraints",()=>{
    const api=engine(),{value}=task(api);
    const original=value.plan as PlanSnapshot,edited=api.editShot(original,"shot-1",{label:"正面",prompt:"自然光背景"});
    expect(original.shots[0].prompt).not.toBe(edited.shots[0].prompt);
    const payload=api.createPayload(edited,"shot-1");expect(payload.prompt).toContain("不可移除的产品身份约束");
    expect(api.validateGenerationPayload(payload).ok).toBe(true);
    expect(api.validateGenerationPayload({...payload,prompt:"replace product"}).code).toBe("STUDIO_PAYLOAD_CHANGED");
    expect(api.validateGenerationPayload({...payload,referenceDetailFormal:true}).ok).toBe(false);
    expect(api.validateGenerationPayload({...payload,knowledgeBatchId:"fake"}).code).toBe("STUDIO_ROUTE_MIXED");
    expect(JSON.stringify(payload).split(PRODUCT)).toHaveLength(2);
    expect(api.validateGenerationPayload({...payload,productImages:[OTHER]}).ok).toBe(false);
  });
});

describe("batch execution receipts, originals and isolation",()=>{
  it("freezes submitted settings/config, applies each product model and retains completed images",async()=>{
    const api=engine(),a=task(api,"a"),b=task(api,"b",1),f=fixture(api);
    b.value.overrides={model:"per-product-image",count:1};b.value.plan=api.createPlan(b.value,api.resolveSettings(a.settings,b.value));
    const originalSend=f.bridge.send;f.bridge.send=async(type,message)=>{const response=await originalSend(type,message);f.config.imageModel="changed-later";a.settings.ratio="16:9";return response;};
    const result=await f.controller.run([a.value,b.value],{...a.settings});expect(result.ok).toBe(true);
    expect(f.submitted.map(entry=>entry.config.imageModel)).toEqual(["fixture-image","fixture-image","per-product-image"]);
    expect(f.submitted.every(entry=>entry.payload.ratio==="1:1")).toBe(true);
    expect(JSON.stringify(f.controller.snapshot())).not.toContain("synthetic-key");
    expect(f.archived).toHaveLength(3);expect(f.pending()).toBeNull();
  });
  it("archives generated detail screens under the captured detail surface",async()=>{
    const api=engine(),{value,settings}=task(api,"detail-product",1,"detail"),f=fixture(api);
    expect((await f.controller.run([value],settings)).ok).toBe(true);
    expect(f.archived[0].context).toMatchObject({accountKey:"user:alice",surfaceMode:"detail"});
    expect(f.archived[0].item).toMatchObject({labMode:"detail",detailMode:"product",detailScreenIndex:1,detailScreenTotal:1});
  });
  it("stops the next request while retaining the in-flight success",async()=>{
    const api=engine(),{value,settings}=task(api),f=fixture(api);
    const originalSend=f.bridge.send;f.bridge.send=async(type,message)=>{await f.controller.stop();return originalSend(type,message);};
    const result=await f.controller.run([value],settings);expect(result.stopped).toBe(true);
    expect(f.submitted).toHaveLength(1);expect(f.controller.state.tasks[0].slots.map((slot:SlotState)=>slot.status)).toEqual(["done","ready"]);
    f.bridge.send=originalSend;await f.controller.run([value],settings);expect(f.submitted).toHaveLength(2);
  });
  it("retries only a definitive failure and never regenerates existing originals after archive failure",async()=>{
    const api=engine(),{value,settings}=task(api),f=fixture(api);f.setArchiveFails(true);
    const originalSend=f.bridge.send;let rejected=false;
    f.bridge.send=async(type,message)=>{if(message.payload.studioGenesisPlan.shotId==="shot-2"&&!rejected){rejected=true;f.submitted.push(clone(message));return {ok:false,definitiveFailure:true,error:"HTTP 429 rejected"};}return originalSend(type,message);};
    await f.controller.run([value],settings);expect(f.submitted).toHaveLength(2);
    const first=f.controller.state.tasks[0].slots[0];expect(first.status).toBe("done");expect(first.archiveOk).toBe(false);
    f.setArchiveFails(false);await f.controller.retryArchive(first.item.resultId);expect(f.submitted).toHaveLength(2);expect(first.archiveOk).toBe(true);
    await f.controller.retryFailed([value],settings);expect(f.submitted).toHaveLength(3);
    expect(f.submitted.filter(entry=>entry.payload.studioGenesisPlan.shotId==="shot-1")).toHaveLength(1);
  });
  it("continues later products after a definite rejection without duplicating successes",async()=>{
    const api=engine(),a=task(api,"a",1),b=task(api,"b",1),c=task(api,"c",1),f=fixture(api);
    const originalSend=f.bridge.send;f.bridge.send=async(type,message)=>{if(message.payload.studioGenesisPlan.plan.taskId==="b"){f.submitted.push(clone(message));return {ok:false,definitiveFailure:true,error:"HTTP 400 invalid"};}return originalSend(type,message);};
    const result=await f.controller.run([a.value,b.value,c.value],a.settings);
    expect(result.ok).toBe(false);expect(result.uncertain).toBe(false);expect(result.stopped).toBe(false);
    expect(f.submitted.map(entry=>entry.payload.studioGenesisPlan.plan.taskId)).toEqual(["a","b","c"]);
    expect(f.controller.state.tasks.map((entry:TaskState)=>entry.slots[0].status)).toEqual(["done","failed","done"]);
  });
  it("blocks an unknown provider receipt across restore and requires explicit reconciliation",async()=>{
    const api=engine(),{value,settings}=task(api),f=fixture(api);f.bridge.send=async()=>({ok:false,error:"connection lost"});
    await f.controller.run([value],settings);expect(f.controller.state.uncertain).not.toBeNull();expect(f.pending()).not.toBeNull();
    const saved=f.controller.snapshot(),restored=fixture(api);restored.journal.write(f.pending());expect(restored.controller.restore(saved).ok).toBe(true);
    expect((await restored.controller.run([value],settings)).uncertain).toBe(true);expect(restored.submitted).toHaveLength(0);
    expect((await restored.controller.resolveUncertain({confirmed:false})).ok).toBe(false);
    await restored.controller.resolveUncertain({confirmed:true});await restored.controller.retryFailed([value],settings);expect(restored.submitted).toHaveLength(1);
  });
  it("checks account boundaries and preserves returned results when account changes",async()=>{
    const api=engine(),{value,settings}=task(api),f=fixture(api);
    const originalSend=f.bridge.send;f.bridge.send=async(type,message)=>{const result=await originalSend(type,message);f.setUser("user:bob");return result;};
    expect((await f.controller.run([value],settings)).ok).toBe(false);
    expect(f.submitted).toHaveLength(1);expect(f.controller.state.tasks[0].slots[0].item.url).toBe(OUTPUT);
    expect(f.archived).toHaveLength(0);expect(f.controller.state.tasks[0].slots[0].archiveError).toContain("账号已切换");
    expect((await f.controller.run([value],settings)).code).toBe("STUDIO_ACCOUNT_CHANGED");
  });
  it("does not submit when durable receipt or browser lock is unavailable",async()=>{
    const api=engine(),{value,settings}=task(api),f=fixture(api,{journal:{read:()=>null,write:()=>{throw new Error("quota exceeded");},clear(){}}});
    expect((await f.controller.run([value],settings)).ok).toBe(false);expect(f.submitted).toHaveLength(0);
    const withoutLock=fixture(api,{lock:null});expect((await withoutLock.controller.run([value],settings)).code).toBe("STUDIO_LOCK_REQUIRED");
  });
});

describe("actual website background product route",()=>{
  it.each(["auto","low","medium","high"])("passes explicitly selected %s quality to the real generic JSON provider body",async(quality)=>{
    const h=backend(),{value,settings}=task(h.api,"ad-quality",1);
    const plan=h.api.createPlan(value,{...settings,imageType:"ad",quality,generationSpeed:"standard"});
    const response=await h.background.createImageTask(configuration,h.api.createPayload(plan,"shot-1"));
    expect(response.ok,response.error).toBe(true);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].body).toMatchObject({quality,model:"fixture-image",n:1});
    expect(h.requests[0].body).not.toHaveProperty("generationSpeed");
    expect(h.requests[0].body).not.toHaveProperty("speed");
  });
  it("rejects unsupported explicit quality before any Gemini provider request",async()=>{
    const h=backend(),{value,settings}=task(h.api,"ad-quality",1);
    const plan=h.api.createPlan(value,{...settings,imageType:"ad",quality:"high"});
    const response=await h.background.createImageTask({...configuration,provider:"nano-banana",imageAdapter:"nano-banana",imageModel:"gemini-3.1-flash-image"},h.api.createPayload(plan,"shot-1"));
    expect(response).toMatchObject({ok:false,code:"CONFIG_CREATIVE_QUALITY_UNSUPPORTED",definitiveFailure:true});
    expect(h.requests).toHaveLength(0);
  });
  it.each(["main","detail"])("passes genuine %s product plans to the existing provider adapter",async(mode)=>{
    const h=backend(),{value}=task(h.api,"product",2,mode);
    const payload=h.api.createPayload(value.plan,"shot-1");
    const response=await h.background.createImageTask(configuration,payload);
    expect(response.ok,response.error).toBe(true);expect(response.knowledgeMeta.code).toBe("studio_genesis_product_scope");
    expect(h.requests).toHaveLength(1);expect(h.requests[0].url).toBe(configuration.imageEndpoint);
    expect(h.requests[0].body).toMatchObject({model:"fixture-image",n:1,product_images:[PRODUCT]});
    expect(h.requests[0].body.prompt).toContain(mode==="detail"?"连续详情图":"商品主图");
  });
  it.each([[400,true],[500,false]])("maps provider HTTP %s to a definite rejection=%s",async(status,definite)=>{
    const h=backend(Number(status)),{value}=task(h.api),payload=h.api.createPayload(value.plan,"shot-1");
    const response=await h.background.createImageTask(configuration,payload);
    expect(response.ok).toBe(false);expect(response.definitiveFailure).toBe(definite);expect(response.stateUncertain).toBe(!definite);
    expect(h.requests).toHaveLength(1);
  });
  it.each([
    {code:'CREATIVE_SUPPLY_NOT_CONFIGURED',adapter:'generic-json'},
    {code:'CREATIVE_SUPPLY_UNAVAILABLE',adapter:'generic-json'},
    {code:'CREATIVE_SUPPLY_NOT_CONFIGURED',adapter:'openai-images'}
  ])("clears pending receipts for trusted local $code rejections through $adapter and allows an explicit retry",async({code,adapter})=>{
    const h=backend(503,{error:'供应订阅未配置，请联系管理员',code,providerSubmitted:false,definitiveFailure:true},{'X-Sanjie-Provider-Submission':'not-submitted'});
    const f=fixture(h.api),{value,settings}=task(h.api,'supply-config',1);
    f.config.imageAdapter=adapter;
    f.bridge.send=async(_type,message)=>h.background.createImageTask(message.config,message.payload);
    const response=await f.controller.run([value],settings);
    expect(response).toMatchObject({ok:false,uncertain:false});
    expect(f.controller.state.tasks[0].slots[0]).toMatchObject({status:'failed'});
    expect(f.controller.state.tasks[0].slots[0].error).toContain('本次未提交生图');
    expect(f.controller.state.uncertain).toBeNull();
    expect(f.pending()).toBeNull();
    await f.controller.run([value],settings,{retryFailed:true});
    expect(h.requests).toHaveLength(2);
  });
  it.each([
    {body:{error:'供应订阅未配置，请联系管理员',code:'CREATIVE_SUPPLY_NOT_CONFIGURED',providerSubmitted:false,definitiveFailure:true},headers:undefined},
    {body:{error:'provider unavailable',code:'OTHER_PROVIDER_FAILURE',providerSubmitted:false,definitiveFailure:true},headers:{'X-Sanjie-Provider-Submission':'not-submitted'}},
    {body:{error:'provider unavailable',code:'CREATIVE_SUPPLY_NOT_CONFIGURED',providerSubmitted:true,definitiveFailure:true},headers:{'X-Sanjie-Provider-Submission':'not-submitted'}}
  ])("keeps unproven HTTP 503 failures uncertain even when their JSON claims a definite rejection",async({body,headers})=>{
    const h=backend(503,body,headers),{value}=task(h.api);
    const response=await h.background.createImageTask(configuration,h.api.createPayload(value.plan,'shot-1'));
    expect(response).toMatchObject({ok:false,definitiveFailure:false,stateUncertain:true});
  });
  it("rejects changed plans, unsupported models and link/reference route mixing before provider",async()=>{
    const h=backend(),{value}=task(h.api),payload=h.api.createPayload(value.plan,"shot-1");
    for(const input of [{...payload,prompt:"forged"},{...payload,detailMode:"reference"},{...payload,promptSource:"link",knowledgeBatchId:"fake"},{...payload,referenceDetailAuthorization:"fake"}])expect((await h.background.createImageTask(configuration,input)).ok).toBe(false);
    expect((await h.background.createImageTask({...configuration,imageModel:"deepseek-text"},payload)).code).toBe("CONFIG_STUDIO_REFERENCE_REQUIRED");
    expect(h.requests).toHaveLength(0);
    // Saved link prompts are no longer gated by optional business knowledge, so they
    // take the ordinary prompt scope rather than any studio bypass; subject binding stays mandatory.
    expect(await h.background.verifyKnowledgeBeforeImage({labMode:"detail",detailMode:"link",promptSource:"link"})).toMatchObject({ok:true,knowledgeMeta:{code:"prompt_input_scope",provider:"none"}});
    expect(await h.background.verifyKnowledgeBeforeImage({labMode:"detail",detailMode:"link",promptSource:"link",subjectTaskId:"S-1"})).toMatchObject({ok:false,code:"subject_binding_incomplete"});
  });
});
