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
  it("uses distinct mode defaults without leaking a different mode's modules or ad settings",()=>{
    const api=engine(),{value}=task(api);
    expect(api.defaults("main")).toMatchObject({mode:"main",ratio:"1:1",count:1});
    expect(api.defaults("detail")).toMatchObject({mode:"detail",imageType:"detail",ratio:"3:4",count:5});
    const global={...api.defaults("main"),imageType:"ad",moduleMode:"custom",modules:["首页图"],moduleSkills:{"首页图":"主图限定技能"},adTemplate:"neon_future",adType:"品牌广告",quality:"high",generationSpeed:"standard",language:"英语",model:"private-image"};
    const effective=api.resolveSettings(global,{overrides:{mode:"detail"}});
    expect(effective).toMatchObject({mode:"detail",imageType:"detail",ratio:"3:4",count:5,moduleMode:"smart",modules:[],language:"英语",model:"private-image"});
    expect(effective).not.toHaveProperty("moduleSkills");
    expect(effective).not.toHaveProperty("adTemplate");
    expect(effective).not.toHaveProperty("adType");
    expect(effective).not.toHaveProperty("quality");
    expect(effective).not.toHaveProperty("generationSpeed");
    expect(api.createPlan(value,effective).ok).toBe(true);
    expect(api.resolveSettings({...global,ratio:"4:5",count:7},{overrides:{mode:"detail"}})).toMatchObject({ratio:"4:5",count:7});
    expect(api.resolveSettings(global,{overrides:{mode:"detail",ratio:"1:1",count:2}})).toMatchObject({ratio:"1:1",count:2});
    expect(api.resolveSettings(api.defaults("detail"),{overrides:{mode:"main"}})).toMatchObject({mode:"main",ratio:"1:1",count:1,modules:[]});
  });
  it("plans independent main images and an ordered detail sequence using each mode's official skills",()=>{
    const api=engine(),{value}=task(api);
    const main=api.createPlan(value,{...api.defaults("main"),count:5,moduleSkills:{"首页图":"仅供自定义模块使用"}});
    const detail=api.createPlan(value,{...api.defaults("detail"),imageType:"main",moduleSkills:{"首屏主视觉":"过期的自定义技能"}});
    expect(main.shots.map((shot:Shot)=>shot.label)).toEqual(["首页图","痛点图","细节图","白底首图","全功能图"]);
    expect(main.shots[0].prompt).toContain("本张作为可单独展示的商品主图");
    expect(main.shots[0].prompt).toContain(api.mainModules[0].skill);
    expect(main.shots[0].prompt).not.toContain("仅供自定义模块使用");
    expect(main.shots[0].prompt).not.toContain("详情阅读顺序");
    expect(detail.settings.imageType).toBe("detail");
    expect(detail.shots.map((shot:Shot)=>shot.label)).toEqual(["首屏主视觉","核心卖点图","使用场景图","商品细节图","使用建议图"]);
    expect(detail.shots[3].prompt).toContain("详情阅读顺序：1·首屏主视觉 → 2·核心卖点图 → 3·使用场景图 → 4·商品细节图 → 5·使用建议图");
    expect(detail.shots[3].prompt).toContain("当前只制作第 4 屏");
    expect(detail.shots[3].prompt).toContain(api.detailModules.find((module:{id:string})=>module.id==="product_detail").skill);
    expect(detail.shots[0].prompt).not.toContain("过期的自定义技能");
  });
  it("rejects cross-mode official modules and implicit duplicate detail screens while allowing main variants",()=>{
    const api=engine(),{value}=task(api);
    const main={...api.defaults("main"),moduleMode:"custom",modules:["首页图"],count:3};
    expect(api.createPlan(value,main).shots).toHaveLength(3);
    expect(api.createPlan(value,{...api.defaults("detail"),moduleMode:"custom",modules:["商品细节图"],count:3}).code).toBe("STUDIO_DETAIL_MODULE_COUNT");
    expect(api.createPlan(value,{...main,modules:["商品细节图"],count:1}).code).toBe("STUDIO_MODULE_MODE");
    expect(api.createPlan(value,{...api.defaults("detail"),moduleMode:"custom",modules:["首页图"],count:1}).code).toBe("STUDIO_MODULE_MODE");
    expect(api.createPlan(value,{...api.defaults("detail"),moduleMode:"custom",modules:["材质介绍","材质介绍"],moduleSkills:{"材质介绍":"以真实可见纹理构图"},count:2}).ok).toBe(true);
    const namedCustom=api.createPlan(value,{...api.defaults("detail"),moduleMode:"custom",modules:["首页图"],moduleSkills:{"首页图":"详情首屏介绍，保留原图可见质感"},count:1});
    expect(namedCustom.ok).toBe(true);
    expect(namedCustom.shots[0].prompt).toContain("详情首屏介绍，保留原图可见质感");
    expect(namedCustom.shots[0].prompt).not.toContain(api.mainModules[0].skill);
    expect(api.createPlan(value,{...api.defaults("main"),imageType:"detail"}).code).toBe("STUDIO_IMAGE_TYPE");
    expect(api.createPlan(value,{...api.defaults("detail"),imageType:"ad"}).code).toBe("STUDIO_IMAGE_TYPE");
  });
  it("binds detail identity and screen position even after editing a shot",()=>{
    const api=engine(),{value,settings}=task(api,"detail-scope",3,"detail");
    const edited=api.editShot(value.plan,"shot-2",{prompt:"柔和自然光"});
    const payload=api.createPayload(edited,"shot-2");
    expect(payload).toMatchObject({imageType:"detail",labMode:"detail",detailMode:"product",detailScreenIndex:2,detailScreenTotal:3,count:1});
    expect(payload.prompt).toContain("当前是连续商品详情中的第 2/3 屏");
    expect(payload.prompt).toContain("不改变当前图片类型或屏幕位置");
    expect(api.validateGenerationPayload(payload).ok).toBe(true);
    for(const change of [{imageType:"main"},{labMode:"main"},{detailScreenIndex:1},{detailScreenTotal:2}])expect(api.validateGenerationPayload({...payload,...change}).code).toBe("STUDIO_PAYLOAD_CHANGED");
    expect(api.validatePlan(edited,value,settings).ok).toBe(true);
    const main=task(api,"main-scope");
    expect(api.validatePlan(main.value.plan,main.value,{...main.settings,imageType:"main"}).ok).toBe(true);
    expect(api.validatePlan(main.value.plan,main.value,{...main.settings,imageType:"ad"}).code).toBe("STUDIO_PLAN_STALE");
  });
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
  it.each([undefined,"main"])("keeps signed V1 detail drafts with legacy imageType=%s executable without rewriting them",async(imageType)=>{
    const api=engine(),f=fixture(api);
    const input={id:"legacy-detail",name:"旧详情商品",requirements:"自然光",analysis:"",products:[{image:PRODUCT,name:"正面"}]};
    const settings={mode:"detail",ratio:"3:4",resolution:"1K",count:1,language:"无文字纯视觉",platform:"智能匹配",moduleMode:"custom",modules:imageType?["首页图"]:["商品介绍","整体外观"],model:"",...(imageType?{expertMode:true,moduleSkills:{"首页图":"自然光"},imageType}:{})};
    const label=imageType?"首页图":"商品介绍";
    const plan={ok:true,version:"STUDIO_GENESIS_V1",taskId:input.id,input,settings,shots:[{id:"shot-1",index:1,label,prompt:`为“旧详情商品”制作连续详情图中的第 1/1 屏，每次只输出一张独立图片。\n本张画面重点：${label}。与同组其他屏统一色彩、光线与排版风格。`}],sourceSignature:imageType?"STUDIO_GENESIS_V1:78edd67f77661a5:412":"STUDIO_GENESIS_V1:36e1738d10771a0b:354",signature:imageType?"STUDIO_GENESIS_V1:fd4f93fa48f86e06:656":"STUDIO_GENESIS_V1:cd472d1b3a0e017:601"};
    const original=clone(plan),effective=api.resolveSettings(settings);
    expect(effective.imageType).toBe("detail");
    expect(api.validatePlan(plan).ok).toBe(true);
    expect(api.validatePlan(plan,input,effective).ok).toBe(true);
    const payload=api.createPayload(plan,"shot-1");
    expect(payload).toMatchObject({imageType:"detail",detailScreenIndex:1,detailScreenTotal:1});
    expect(api.validateGenerationPayload(payload).ok).toBe(true);
    expect(f.controller.restore({version:api.version,accountKey:"user:alice",tasks:[{id:input.id,name:input.name,plan:clone(plan),slots:[{shot:clone(plan.shots[0]),status:"ready",item:null,archiveOk:false}]}]}).ok).toBe(true);
    expect((await f.controller.run([{...input,plan}],effective)).ok).toBe(true);
    expect(f.submitted).toHaveLength(1);
    expect(f.archived[0].item).toMatchObject({labMode:"detail",detailMode:"product",detailScreenIndex:1,detailScreenTotal:1});
    expect(plan).toEqual(original);
  });
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
  it("reuses completed originals when the same product switches main to detail and returns to the confirmed main plan",async()=>{
    const api=engine(),main=task(api,"same-product",2,"main"),detail=task(api,"same-product",2,"detail"),f=fixture(api);
    expect((await f.controller.run([main.value],main.settings)).ok).toBe(true);
    const originalMain=f.controller.snapshot().tasks[0].slots.map((slot:{item:ResultItem})=>slot.item.resultId);
    expect((await f.controller.run([detail.value],detail.settings)).ok).toBe(true);
    expect(f.submitted).toHaveLength(4);
    // Duplicate receipt copies must be consumed together when their original becomes active.
    f.controller.state.previousResults.push(clone(f.controller.state.previousResults[0]));
    expect((await f.controller.run([main.value],main.settings)).code).toBe("STUDIO_NOTHING_QUEUED");
    expect(f.submitted).toHaveLength(4);
    expect(f.archived).toHaveLength(4);
    expect(f.controller.state.tasks[0].slots.map((slot:{item:ResultItem})=>slot.item.resultId)).toEqual(originalMain);
    expect(f.controller.state.previousResults).toHaveLength(2);
    expect(f.controller.state.previousResults.every((slot:{item:{labMode:string}})=>slot.item.labMode==="detail")).toBe(true);
    expect((await f.controller.run([detail.value],detail.settings)).code).toBe("STUDIO_NOTHING_QUEUED");
    expect(f.submitted).toHaveLength(4);
  });
  it("continues only missing main shots after a partial main run switches to detail and returns",async()=>{
    const api=engine(),main=task(api,"partial-product",3,"main"),detail=task(api,"partial-product",1,"detail"),f=fixture(api);
    const originalSend=f.bridge.send;
    f.bridge.send=async(type,message)=>{await f.controller.stop();return originalSend(type,message);};
    expect((await f.controller.run([main.value],main.settings)).stopped).toBe(true);
    const original=f.controller.state.tasks[0].slots[0].item.resultId;
    f.bridge.send=originalSend;
    expect((await f.controller.run([detail.value],detail.settings)).ok).toBe(true);
    expect((await f.controller.run([main.value],main.settings)).ok).toBe(true);
    expect(f.submitted.map(message=>[message.payload.studioGenesisPlan.plan.taskId,message.payload.studioGenesisPlan.shotId,message.payload.labMode])).toEqual([
      ["partial-product","shot-1","main"],["partial-product","shot-1","detail"],["partial-product","shot-2","main"],["partial-product","shot-3","main"]
    ]);
    expect(f.controller.state.tasks[0].slots[0].item.resultId).toBe(original);
    expect(f.controller.state.tasks[0].slots.every((slot:SlotState)=>slot.status==="done")).toBe(true);
  });
  it("does not use older originals to complete a newly edited plan",async()=>{
    const api=engine(),main=task(api,"revised-product",2,"main"),detail=task(api,"revised-product",1,"detail"),f=fixture(api);
    await f.controller.run([main.value],main.settings);
    const originals=f.controller.state.tasks[0].slots.map((slot:{item:ResultItem})=>slot.item.resultId);
    await f.controller.run([detail.value],detail.settings);
    const revised={...main.value,requirements:"新的画面要求",plan:null as unknown};
    revised.plan=api.createPlan(revised,main.settings);
    expect((await f.controller.run([revised],main.settings)).ok).toBe(true);
    expect(f.submitted).toHaveLength(5);
    expect(f.controller.state.previousResults.filter((slot:{item:ResultItem})=>originals.includes(slot.item.resultId))).toHaveLength(2);
    expect(f.controller.state.tasks[0].slots.every((slot:{item:ResultItem})=>!originals.includes(slot.item.resultId))).toBe(true);
  });
  it.each(["task","shot","signature","plan"])("requires matching historical %s evidence before reusing an original",async(field)=>{
    const api=engine(),main=task(api,"bound-product",1,"main"),detail=task(api,"bound-product",1,"detail"),f=fixture(api);
    await f.controller.run([main.value],main.settings);
    await f.controller.run([detail.value],detail.settings);
    const previous=f.controller.state.previousResults[0],original=previous.item.resultId;
    if(field==="task")previous.item.studioTaskId="another-product";
    if(field==="shot")previous.shot.id="shot-2";
    if(field==="signature")previous.item.studioGenesisPlan.signature="another-signature";
    if(field==="plan")previous.item.studioGenesisPlan.input.requirements="changed without confirmation";
    expect((await f.controller.run([main.value],main.settings)).ok).toBe(true);
    expect(f.submitted).toHaveLength(3);
    expect(f.controller.state.tasks[0].slots[0].item.resultId).not.toBe(original);
    expect(f.controller.state.previousResults.some((slot:{item:ResultItem})=>slot.item.resultId===original)).toBe(true);
  });
  it("explicitly regenerates one matching historical main shot while preserving its original and other shots",async()=>{
    const api=engine(),main=task(api,"retry-product",2,"main"),detail=task(api,"retry-product",1,"detail"),f=fixture(api);
    await f.controller.run([main.value],main.settings);
    const originals=f.controller.snapshot().tasks[0].slots.map((slot:{item:ResultItem})=>slot.item.resultId);
    await f.controller.run([detail.value],detail.settings);
    expect((await f.controller.retrySlot(main.value.id,"shot-1",[main.value],main.settings)).ok).toBe(true);
    expect(f.submitted).toHaveLength(4);
    expect(f.submitted[3].payload).toMatchObject({labMode:"main",studioGenesisPlan:{shotId:"shot-1"}});
    expect(f.controller.state.tasks[0].slots[0].item.resultId).not.toBe(originals[0]);
    expect(f.controller.state.tasks[0].slots[1].item.resultId).toBe(originals[1]);
    expect(f.controller.state.previousResults.some((slot:{item:ResultItem})=>slot.item.resultId===originals[0])).toBe(true);
    await f.controller.run([detail.value],detail.settings);
    expect((await f.controller.run([main.value],main.settings)).code).toBe("STUDIO_NOTHING_QUEUED");
    expect(f.submitted).toHaveLength(4);
    expect(f.controller.state.tasks[0].slots[0].item.resultId).not.toBe(originals[0]);
    expect(f.controller.state.previousResults.some((slot:{item:ResultItem})=>slot.item.resultId===originals[0])).toBe(true);
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
    expect(result.error).toBe("HTTP 400 invalid");
    expect(f.controller.state.message).toBe("HTTP 400 invalid");
    expect(f.submitted.map(entry=>entry.payload.studioGenesisPlan.plan.taskId)).toEqual(["a","b","c"]);
    expect(f.controller.state.tasks.map((entry:TaskState)=>entry.slots[0].status)).toEqual(["done","failed","done"]);
  });
  it("reports only the selected retry's error while preserving another shot's historical failure",async()=>{
    const api=engine(),{value,settings}=task(api),f=fixture(api);
    f.bridge.send=async(type,message)=>{void type;return {ok:false,definitiveFailure:true,error:message.payload.studioGenesisPlan.shotId==="shot-1"?"first historical failure":"second historical failure"};};
    const first=await f.controller.run([value],settings);
    expect(first.error).toContain("first historical failure");
    expect(first.error).toContain("本轮另有 1 项未完成");
    f.bridge.send=async()=>({ok:false,definitiveFailure:true,error:"selected retry failure"});
    const retried=await f.controller.retrySlot(value.id,"shot-2",[value],settings);
    expect(retried.ok).toBe(false);expect(retried.error).toBe("selected retry failure");
    expect(f.controller.state.message).toBe("selected retry failure");
    expect(f.controller.state.tasks[0].slots[0].error).toBe("first historical failure");
    expect(f.controller.state.tasks[0].slots[1].error).toBe("selected retry failure");
    expect(f.pending()).toBeNull();
  });
  it("blocks an unknown provider receipt across restore and requires explicit reconciliation",async()=>{
    const api=engine(),{value,settings}=task(api),f=fixture(api);f.bridge.send=async()=>({ok:false,error:"connection lost"});
    await f.controller.run([value],settings);expect(f.controller.state.uncertain).not.toBeNull();expect(f.pending()).not.toBeNull();
    const saved=f.controller.snapshot(),restored=fixture(api);restored.journal.write(f.pending());expect(restored.controller.restore(saved).ok).toBe(true);
    const blocked=await restored.controller.run([value],settings);
    expect(blocked.uncertain).toBe(true);expect(blocked.error).toContain("回执尚未确认");expect(restored.submitted).toHaveLength(0);
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
    expect((await h.background.verifyKnowledgeBeforeImage({labMode:"detail",detailMode:"link",promptSource:"link"})).ok).toBe(true);
  });
});


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
