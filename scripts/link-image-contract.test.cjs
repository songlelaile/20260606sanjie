'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const contract = require('../public/creative/labs/image-prompt-lab/link-image-contract.js');
const clone = value => JSON.parse(JSON.stringify(value));
const asset = name => 'https://fixture.invalid/' + name + '.png';
const image = name => ({ id: name, name: name + '-filename-must-not-be-painted', image: asset(name) });
function input(id = 'L001', mode = 'main', count = mode === 'detail' ? 10 : 5) {
  return { bundleId:'account-owned-import',category:'服装',link:{'链接编号':id,'生成方式':'差异化','链接分组':'核心','链接定位':id+'专属定位','主推关键词':id+'主推词','用户场景需求':id+'场景','来源关键词':'来源','竞品未覆盖词根':'需求','差异化定位逻辑':id+'差异','标题结构':'品类+场景','标题定位词路':'品类','商品标题':id+'商品标题','标题冲突处理':'无','主图核心文案':id+'主图文案','详情页定位':id+'详情定位','详情页文案':id+'详情文案','详情文案逻辑':'需求 -> 商品 -> 细节','优先级分数':90,'优先级':'高','数据状态':'已确认'},products:[image(id+'-product-front'),image(id+'-product-side')],models:[image(id+'-model')],config:{mode,count,ratio:mode==='detail'?'3:4':'1:1',resolution:'2K',quality:'high',speed:'standard',language:'中文',platform:'淘宝',requirements:'只使用真实资料',model:'gpt-image-1',provider:'configured-provider'} };
}
function deferred() { let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve}; }
const flush=()=>new Promise(done=>setTimeout(done,0));
function fixture(options = {}) {
  let account='account:alice',pending=null,id=0,archiveFailure=false;
  const current=input('L001','main',2), requests=[],archives=[];
  const config={provider:'configured-provider',imageModel:'gpt-image-1',imageAdapter:'generic-json'};
  const deps={readInput:()=>current,config:()=>config,archiveContext:()=>({accountKey:account,surfaceMode:'main'}),newJobId:()=>'link-job-'+(++id),
    send:async(type,message)=>{requests.push({type,message:clone(message)});return {ok:true,images:[asset('generated-'+id)],taskId:'provider-'+id};},
    archive:async(item,owner)=>{archives.push({item:clone(item),owner:clone(owner)});return archiveFailure?{ok:false,error:'fixture disk error'}:{ok:true};},
    journal:{read:()=>clone(pending),write:value=>{pending=clone(value);},clear:()=>{pending=null;},compareAndClear:expected=>{if(!pending)return true;if(!expected||['jobId','signature','shotId','batchId'].some(k=>pending[k]!==expected[k]))return false;pending=null;return true;}},...options};
  return {current,config,deps,requests,archives,controller:contract.createController(deps),receipt:()=>clone(pending),setReceipt:value=>{pending=clone(value);},setAccount:value=>{account=value;},failArchive:value=>{archiveFailure=value;}};
}

test('each plan owns one canonical L and one mode, with independent defaults and immutable shots',()=>{
  const data=input();delete data.config.count;
  const main=contract.createPlan(data),detail=contract.createPlan({...data,config:{...data.config,mode:'detail',ratio:'3:4'}});
  assert.equal(main.ok,true);assert.equal(main.totalOutputs,5);assert.equal(detail.totalOutputs,10);
  assert.equal(main.linkId,'L001');assert.equal(main.mode,'main');assert.equal(detail.mode,'detail');assert.notEqual(main.signature,detail.signature);
  assert.equal(Object.isFrozen(main),true);assert.equal(Object.isFrozen(main.shots[0]),true);assert.equal(Object.isFrozen(main.images.products[0]),true);
  assert.equal(new Set(main.shots.map(s=>s.prompt)).size,5);
  assert.deepEqual(Object.keys(main.input.link),contract.rowFields);
  assert.equal(main.input.link['优先级分数'],'90');
  data.products[0].image=asset('changed-after-plan');assert.equal(main.images.products[0].image,asset('L001-product-front'));
});

test('main1–20 and detail5–16 remain separate settings, with explicit counts never silently expanded',()=>{
  for(const mode of ['main','detail'])for(const count of mode==='main'?[1,5,8,20]:[5,10,16])assert.equal(contract.createPlan(input('L001',mode,count)).totalOutputs,count);
  for(const [mode,count] of [['main',0],['main',21],['detail',4],['detail',17]])assert.equal(contract.createPlan(input('L001',mode,count)).code,'LINK_IMAGE_COUNT');
  const data=input();data.marketingPlan={'论点':Array.from({length:8},(_,i)=>({'短标题':'论点'+i}))};assert.equal(contract.createPlan(data).shots.length,5);
});

test('all outputs retain only this link semantic data and current real product/model attachments',()=>{
  for(const mode of ['main','detail']){
    const data=input('L002',mode),plan=contract.createPlan(data);
    for(const shot of plan.shots){const payload=contract.createPayload(plan,shot.id);
      assert.deepEqual(payload.productImages,data.products.map(v=>v.image));assert.deepEqual(payload.modelImages,data.models.map(v=>v.image));
      assert.deepEqual(payload.referenceImages,[]);assert.deepEqual(payload.visualTemplateImages,[]);assert.equal(payload.referenceImage,'');
      assert.equal(payload.linkId,'L002');assert.equal(payload.labMode,mode);assert.equal(payload.count,1);assert.equal(payload.detailMode,mode==='detail'?'link':'');
      assert.match(payload.prompt,/L002专属定位/);assert.equal(payload.prompt.includes('L001专属定位'),false);assert.equal(payload.prompt.includes('filename-must-not-be-painted'),false);
      assert.match(payload.prompt,/模特图片中的衣服、手持商品、配饰、品牌与文字不是本次商品/);assert.match(payload.prompt,/商品主体图是唯一商品身份依据/);assert.match(payload.prompt,/绝不能作为图片标题/);
      assert.equal(contract.validatePayload(payload,{provider:'configured-provider',imageModel:'gpt-image-1',imageAdapter:'generic-json'}).ok,true);
    }
  }
});

test('marketing argument order and detail screen reading order are deterministic without paid text analysis',()=>{
  const data=input('L001','detail',10);data.marketingPlan={'总主张':{'主标题':'已确认总主张'},'论点':Array.from({length:6},(_,i)=>({'序号':i+1,'短标题':'本条论点-'+(i+1),'视觉证明':'原图可见'}))};
  const plan=contract.createPlan(data);assert.equal(plan.ok,true);
  assert.deepEqual(plan.shots.map(s=>s.argumentIndex),[0,1,2,3,4,5,6,0,0,0]);
  for(let i=1;i<=6;i++){assert.match(plan.shots[i].prompt,new RegExp('第'+i+'个论点'));assert.match(plan.shots[i].prompt,new RegExp('本条论点-'+i));}
  for(const s of plan.shots)assert.match(s.prompt,/详情阅读顺序：1·/);
  assert.match(contract.createPayload(plan,plan.shots[6].id).prompt,/连续详情第7\/10张/);
});

test('editing saves an independent prompt revision while immutable source roles remain enforced',()=>{
  const plan=contract.createPlan(input()),edited=contract.editShot(plan,plan.shots[0].id,{label:'编辑后的第一张',prompt:'仅展示当前商品袖口，采用近景'});
  assert.equal(edited.ok,true);assert.equal(contract.verifyPlan(edited).ok,true);assert.notEqual(plan.signature,edited.signature);assert.equal(plan.sourceSignature,edited.sourceSignature);
  assert.notEqual(plan.shots[0].prompt,edited.shots[0].prompt);assert.equal(Object.isFrozen(edited),true);
  const payload=contract.createPayload(edited,edited.shots[0].id);assert.match(payload.prompt,/采用近景/);assert.match(payload.prompt,/不可移除的商品与链接约束/);
  assert.equal(contract.editShot(plan,plan.shots[0].id,{prompt:''}).code,'LINK_IMAGE_PROMPT_INVALID');
});

test('metadata asset references never become real bindings and explicit replacement requires the exact confirmation',()=>{
  const data=input();data.subjectRequirement={localModelReferenceCount:2,localReferences:{models:[{assetId:'old-model',contentHash:'a'},{assetId:'old-model2',contentHash:'b'}]},requiresUpload:true};
  assert.equal(contract.createPlan(data).code,'LINK_IMAGE_REBIND_REQUIRED');
  data.subjectRequirement.localModelReferenceCount=6;assert.equal(contract.createPlan(data).code,'LINK_IMAGE_REQUIREMENT_UNSUPPORTED');
  data.bindingOverride={confirmed:true,reason:'explicit-rebind',replacesUpstream:true};const plan=contract.createPlan(data);assert.equal(plan.ok,true);assert.deepEqual(plan.input.bindingOverride,data.bindingOverride);
  assert.equal(contract.validatePayload(contract.createPayload(plan,plan.shots[0].id)).ok,true);
  assert.equal(contract.createPlan({...data,bindingOverride:{confirmed:true}}).code,'LINK_IMAGE_REBIND_CONFIRMATION');
  assert.equal(contract.createPlan({...data,products:[]}).code,'LINK_IMAGE_ASSET_COUNT');
  assert.equal(contract.createPlan({...data,models:[{image:''}]}).code,'LINK_IMAGE_ASSET_INVALID');
  const changed=clone(plan);changed.input.bindingOverride=null;assert.equal(contract.verifyPlan(changed).code,'LINK_IMAGE_PLAN_STALE');
});

test('missing IDs, row rules, oversized or untrusted assets fail before building an executable plan',()=>{
  for(const update of [{products:[]},{products:Array.from({length:7},(_,i)=>image('p'+i))},{models:Array.from({length:4},(_,i)=>image('m'+i))}])assert.equal(contract.createPlan({...input(),...update}).code,'LINK_IMAGE_ASSET_COUNT');
  for(const url of ['http://fixture.invalid/p.png','https://u:p@fixture.invalid/p.png','data:image/svg+xml;base64,PHN2Zz4=','blob:foreign'])assert.equal(contract.createPlan({...input(),products:[{image:url}]}).code,'LINK_IMAGE_ASSET_INVALID');
  const data=input();delete data.link['链接编号'];assert.equal(contract.createPlan(data).code,'LINK_IMAGE_LINK');data.link['链接编号']='L001';data.link['主图核心文案']='';assert.equal(contract.createPlan(data).code,'LINK_IMAGE_LINK_RULES');
  assert.equal(contract.createPlan({...input(),bundleId:''}).code,'LINK_IMAGE_BUNDLE');
  assert.equal(contract.createPlan({...input(),config:{...input().config,speed:'fast'}}).code,'LINK_IMAGE_QUALITY');
});

test('canonical payload rejects changed prompt, image roles, count, size, source and mixed route fields',()=>{
  const plan=contract.createPlan(input()),payload=contract.createPayload(plan,plan.shots[0].id);
  for(const update of [{prompt:'discard current link'},{negativePrompt:''},{productImages:[asset('other')]},{modelImages:[]},{productImageEvidence:[]},{modelImageEvidence:[]},{referenceImages:[asset('stale-reference')]},{visualTemplateImages:[asset('competitor')]},{count:2},{size:'999*999'},{ratio:'9:16'},{resolution:'4K'},{quality:'low'},{speed:'fast'},{linkId:'L002'},{linkMode:'detail'}])assert.equal(contract.validatePayload({...payload,...update}).ok,false,JSON.stringify(update));
  for(const update of [{contractPlan:{}},{mirrorPlan:{}},{studioGenesisVersion:'foreign'},{guideContract:{}}])assert.equal(contract.validatePayload({...payload,...update}).code,'LINK_IMAGE_ROUTE_MIXED');
  assert.equal(contract.validatePayload({...payload,unexpected:'arbitrary'}).code,'LINK_IMAGE_FIELDS');
  assert.equal(contract.validatePayload({...payload,promptSource:'link'}).code,'LINK_IMAGE_ROUTE');
  const changed=clone(payload);changed.linkPlan.plan.config.ratio='9:16';assert.equal(contract.validatePayload(changed).code,'LINK_IMAGE_SNAPSHOT');
});

test('full transport placeholders never repeat source pixels inside plan metadata and actual model/provider are frozen',()=>{
  const plan=contract.createPlan(input()),p=contract.createPayload(plan,plan.shots[0].id);
  assert.deepEqual(p.linkPlan.plan.images.products.map(v=>v.image),['@product:0','@product:1']);assert.deepEqual(p.linkPlan.plan.images.models.map(v=>v.image),['@model:0']);
  assert.equal(p.linkPlan.plan.config.model,'gpt-image-1');assert.equal(p.linkPlan.plan.config.provider,'configured-provider');
  assert.equal(contract.validatePayload(p,{provider:'other',imageModel:'gpt-image-1',imageAdapter:'generic-json'}).code,'LINK_IMAGE_MODEL_CHANGED');
  assert.equal(contract.validatePayload(p,{provider:'configured-provider',imageModel:'gpt-image-2',imageAdapter:'generic-json'}).code,'LINK_IMAGE_MODEL_CHANGED');
  assert.equal(contract.validatePayload(p,{provider:'configured-provider',imageModel:'gpt-4.1',imageAdapter:'openai-images'}).code,'LINK_IMAGE_MODEL_UNSUPPORTED');
  assert.equal(contract.validatePayload({...p,_jobId:'job',batchId:'batch'}).ok,true);
});

test('24MiB budget includes encoded repeated image evidence and complete plan metadata, leaving original inputs intact',()=>{
  const data=input('L001','main',1);data.products=[{name:'large',image:'data:image/png;base64,'+'A'.repeat(9*1024*1024)}];data.models=[];
  const plan=contract.createPlan(data);assert.equal(plan.ok,true);assert.throws(()=>contract.createPayload(plan,plan.shots[0].id),e=>e.code==='LINK_IMAGE_BUDGET');assert.equal(data.products[0].image.length,9*1024*1024+22);
  const small=contract.createPlan(input()),payload=contract.createPayload(small,small.shots[0].id);assert.equal(contract.payloadBytes(payload)>=Buffer.byteLength(JSON.stringify(payload))+contract.requestMetadataReserveBytes,true);
  const copied=clone(payload);copied.linkPlan.plan.input.marketingPlan={text:'资料'.repeat(12*1024*1024)};assert.equal(contract.checkPayloadBudget(copied).code,'LINK_IMAGE_BUDGET');
});

test('controller submits exact real model and archives link and mode identity without generic route contamination',async()=>{
  const f=fixture();f.current.config.mode='detail';f.current.config.count=5;f.current.config.ratio='3:4';assert.equal(f.controller.buildPlan().ok,true);
  const done=await f.controller.generate();assert.equal(done.ok,true);assert.equal(f.requests.length,5);assert.equal(f.archives.length,5);assert.equal(f.receipt(),null);
  for(const {item,owner} of f.archives){assert.equal(item.linkImageContractVersion,contract.version);assert.equal(item.linkId,'L001');assert.equal(item.linkMode,'detail');assert.equal(item.labMode,'detail');assert.equal(owner.surfaceMode,'detail');assert.equal(owner.accountKey,'account:alice');assert.equal(item.creativeContractVersion,undefined);assert.equal(item.model,'gpt-image-1');assert.equal(item.linkPlanSnapshot.version,contract.version);assert.match(item.businessBatchTitle,/L001.*详情/);}
  assert.equal(f.controller.getTaskState().completedCount,5);await f.controller.generate();assert.equal(f.requests.length,5);
});

test('provider changes, source changes and image budget failures cause zero journal or provider writes',async()=>{
  const model=fixture();model.controller.buildPlan();model.config.imageModel='gpt-image-2';assert.equal((await model.controller.generate()).code,'LINK_IMAGE_MODEL_CHANGED');assert.equal(model.requests.length,0);assert.equal(model.receipt(),null);
  const stale=fixture();stale.controller.buildPlan();stale.current.link['主图核心文案']='new direction';assert.equal((await stale.controller.generate()).code,'CREATIVE_PLAN_STALE');assert.equal(stale.requests.length,0);
  const budget=fixture();budget.current.products=[{image:'data:image/png;base64,'+'A'.repeat(9*1024*1024)}];budget.current.models=[];budget.controller.buildPlan();assert.equal((await budget.controller.generate()).code,'LINK_IMAGE_BUDGET');assert.equal(budget.requests.length,0);assert.equal(budget.receipt(),null);
});

test('account switch or journal persistence error never dispatches the reviewed old task to a new account',async()=>{
  const owner=fixture();owner.controller.buildPlan();owner.setAccount('account:bob');assert.equal((await owner.controller.generate()).code,'CREATIVE_ACCOUNT_CHANGED');assert.equal(owner.requests.length,0);
  const journal=fixture({journal:{read:()=>null,clear(){},write(){throw new Error('quota');},compareAndClear:()=>false}});journal.controller.buildPlan();await journal.controller.generate();assert.equal(journal.requests.length,0);
});

test('pending receipt in one link does not block the independent next link controller',async()=>{
  const slow=deferred(),first=fixture({timeoutMs:5,send:async()=>slow.promise}),second=fixture();second.current.link={...second.current.link,'链接编号':'L002'};
  first.controller.buildPlan();second.controller.buildPlan();assert.equal((await first.controller.generate()).uncertain,true);
  assert.equal((await second.controller.generate()).ok,true);assert.equal(second.requests.length,2);assert.equal(first.controller.getTaskState().activeCount,0);assert.equal(first.controller.getTaskState().pendingCount,1);
  slow.resolve({ok:true,images:[asset('first-late')]});await flush();await flush();assert.equal(first.archives[0].item.linkId,'L001');assert.equal(second.archives[0].item.linkId,'L002');
});

test('late success keeps original owner batch and saved prompt, while a newer receipt and replacement slots survive',async()=>{
  const late=deferred(),f=fixture({timeoutMs:5,send:async()=>late.promise});f.controller.buildPlan();f.controller.editShot(f.controller.state.slots[0].shot.id,{prompt:'原链接已保存的近景方案'});
  assert.equal((await f.controller.generate()).uncertain,true);const receipt=f.receipt();
  f.current.link['主图核心文案']='下一版文案';f.controller.buildPlan();const replacement=f.controller.state.slots[0];
  const newer={...receipt,jobId:'newer-job',batchId:'newer-batch',signature:'newer-signature'};f.setReceipt(newer);f.setAccount('account:bob');late.resolve({ok:true,images:[asset('late-original')]});await flush();await flush();
  assert.equal(replacement.item,null);assert.equal(f.receipt().jobId,'newer-job');assert.equal(f.controller.state.uncertain.jobId,'newer-job');assert.equal(f.controller.state.previousResults.length,1);
  const archived=f.archives[0];assert.equal(archived.owner.accountKey,'account:alice');assert.equal(archived.item.batchId,receipt.batchId);assert.equal(archived.item.jobId,receipt.jobId);assert.match(archived.item.prompt,/原链接已保存的近景方案/);assert.equal(archived.item.linkId,'L001');
});

test('stop preserves current returned image and never submits the queued following shot',async()=>{
  const gate=deferred(),f=fixture({send:async(type,message)=>{f.requests.push({type,message});return type==='CANCEL_GENERATION'?{ok:true}:gate.promise;}});f.controller.buildPlan();const running=f.controller.generate();await flush();await f.controller.stop();gate.resolve({ok:true,images:[asset('stopped-current')]});await running;
  assert.equal(f.requests.filter(v=>v.type==='GENERATE_IMAGE').length,1);assert.equal(f.archives.length,1);assert.equal(f.controller.state.slots[1].item,null);
});

test('archive retry saves the same original without another paid generation; invalidation retains successful history',async()=>{
  const f=fixture();f.failArchive(true);f.controller.buildPlan();await f.controller.generate();const sent=f.requests.length;assert.equal(f.controller.state.slots[0].archiveOk,false);
  assert.equal((await f.controller.retryShot(f.controller.state.slots[0].shot.id)).code,'CREATIVE_ARCHIVE_PENDING');f.failArchive(false);assert.equal((await f.controller.retryArchive(f.controller.state.slots[0])).ok,true);assert.equal(f.requests.length,sent);
  f.controller.invalidate();assert.equal(f.controller.state.plan,null);assert.equal(f.controller.state.previousResults.length,2);
});

test('restoring a mismatched saved slot refuses without mutating the current saved task',()=>{
  const f=fixture();f.controller.buildPlan();const before=f.controller.snapshot(),bad=clone(before);bad.slots[0].shot.prompt='another link prompt';assert.equal(f.controller.restore(bad).code,'LINK_IMAGE_RESTORE_BINDING');assert.deepEqual(f.controller.snapshot(),before);
});

test('a definitive failed shot retry does not regenerate successful originals',async()=>{
  const f=fixture({send:async(type,message)=>{f.requests.push({type,message});return f.requests.length===2?{ok:false,definitiveFailure:true,code:'LINK_IMAGE_FIXTURE_FAILURE',error:'failed'}:{ok:true,images:[asset('result-'+f.requests.length)]};}});f.controller.buildPlan();await f.controller.generate();assert.equal(f.controller.state.slots[0].status,'done');assert.equal(f.controller.state.slots[1].status,'failed');
  assert.equal((await f.controller.retryFailed()).ok,true);assert.equal(f.requests.length,3);assert.equal(f.controller.state.slots[0].item.url,asset('result-1'));
});

test('actual upstream importer fixtures bind separate L subjects and models without accepting reference metadata as pixels',()=>{
  const fs=require('node:fs'),path=require('node:path'),importer=require('../public/creative/labs/image-prompt-lab/link-list-import.js');
  for(const file of ['import-subject-bindings.json','import-two-positionings.json']){
    const parsed=importer.parse(fs.readFileSync(path.join(__dirname,'../docs/uat-link-image-20261015/fixtures',file),'utf8'));assert.equal(parsed.ok,true);
    for(const task of parsed.tasks)for(const mode of ['main','detail']){
      const data={...input(task.linkId,mode),bundleId:parsed.bundleId,category:parsed.category,link:parsed.rows.find(row=>row['链接编号']===task.linkId),marketingPlan:task.marketingPlan,subjectTaskId:task.subjectTaskId,subjectRequirement:task.subjectRequirement,models:Array.from({length:task.subjectRequirement?.localModelReferenceCount||0},(_,i)=>image(task.linkId+'-reuploaded-model-'+i))};
      const plan=contract.createPlan(data);assert.equal(plan.ok,true);const payload=contract.createPayload(plan,plan.shots[0].id);assert.equal(contract.validatePayload(payload).ok,true);assert.deepEqual(payload.modelImages,data.models.map(v=>v.image));
      assert.equal(payload.productImages.every(value=>value.startsWith('https://fixture.invalid/')),true);
    }
  }
});
