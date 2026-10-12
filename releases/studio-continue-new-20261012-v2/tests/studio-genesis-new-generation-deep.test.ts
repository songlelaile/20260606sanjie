import { describe, expect, it, vi } from "vitest";
import { accountKey, clone, deferred, harness, oldReceipt, ready } from "./test-fixtures/studio-genesis-ui-harness";

// Production UI/contract scripts execute against memory-only browser adapters.
// All bridge replies and images are synthetic; no provider or website is called.
type Harness = ReturnType<typeof harness>;
type Stored = Harness["saved"];
type Plan = {taskId:string;signature:string;settings:Record<string,unknown>;shots:Array<{id:string;label:string;prompt:string}>};
type Sent = {jobId:string;payload:{studioGenesisPlan:{plan:Plan;shotId:string}}};
const key = `${accountKey}:single:main`;
const receiptKey = (jobId:string,scope="single:main") => `sz_studio_genesis_pending_v2:${accountKey}:${scope}:${jobId}`;
const flush = async () => {for(let i=0;i<100;i++)await Promise.resolve();};
const click = (h:Harness,action="generate") => h.document.root.dispatch("click",h.document.control(`[data-action=${action}]`));

function seed(h:Harness,statuses=["uncertain"],scope="single:main") {
  const task=h.saved.draft.tasks[0],record=h.saved.snapshot.tasks[0];
  h.saved.draft.settings.count=statuses.length;task.plan=h.engine.createPlan(task,h.saved.draft.settings);record.plan=clone(task.plan);
  h.saved.snapshot.batchId="original-batch";h.saved.snapshot.pendingReceipts=[];
  const receipts:typeof oldReceipt[]=[];
  record.slots=record.plan.shots.map((shot:{id:string},index:number)=>{
    const status=statuses[index],receipt={...oldReceipt,jobId:`original-${index}`,taskId:task.id,shotId:shot.id,batchId:"original-batch"};
    const slot={shot:clone(shot),status,item:status==="done"?{url:`https://fixture.test/existing-${index}.png`,resultId:`existing-${index}`,jobId:`finished-${index}`,studioTaskId:task.id,accountKey,studioGenesisPlan:clone(record.plan)}:null,error:"",archiveOk:status==="done"};
    if(status==="uncertain") {
      Object.assign(slot,{pendingReceipt:receipt,receiptJobId:receipt.jobId});receipts.push(receipt);
      h.storage.set(receiptKey(receipt.jobId,scope),JSON.stringify(receipt));
    }
    return slot;
  });
  h.saved.snapshot.uncertain=receipts[0]||null;
  h.saved.snapshot.pendingReceipts=clone(receipts);
  return {task,record,receipts};
}
async function boot(h:Harness) {
  ready(h);await vi.waitFor(()=>expect(h.document.control("[data-setting=model]").disabled).toBe(false));
}
function installArchive(h:Harness) {
  const archive=vi.fn(async()=>({ok:true}));Object.assign(h.bridge,{archive});return archive;
}
async function idle(h:Harness) {
  await vi.waitFor(()=>expect(h.controller().state.busy).toBe(false));
  await vi.waitFor(()=>expect(h.document.control("[data-setting=model]").disabled).toBe(false));
}
function stored(h:Harness) {return h.writes.at(-1)!.value as Stored;}

describe("new-generation UI deep local acceptance",()=>{
  it("accepts one explicit request despite stale rapid clicks during persistence and a live send",async()=>{
    const h=harness("main"),original=seed(h),save=deferred<void>(),reply=deferred<unknown>();installArchive(h);
    h.bridge.send.mockImplementation(()=>reply.promise);await boot(h);
    const button=h.document.control("[data-new-generation]");h.writeControl.wait=save.promise;
    for(let i=0;i<6;i++)h.document.root.dispatch("click",button);
    await vi.waitFor(()=>expect(h.writes).toHaveLength(1));expect(h.bridge.send).not.toHaveBeenCalled();
    expect(h.document.control("[data-action=generate]").disabled).toBe(true);
    save.complete();await vi.waitFor(()=>expect(h.bridge.send).toHaveBeenCalledOnce());
    for(let i=0;i<6;i++)h.document.root.dispatch("click",button);
    await flush();expect(h.bridge.send).toHaveBeenCalledOnce();
    reply.complete({ok:true,images:["https://fixture.test/new-image.png"]});await idle(h);
    expect(h.controller().state.tasks).toHaveLength(2);
    expect(h.storage.get(receiptKey(original.receipts[0].jobId))).toBe(JSON.stringify(original.receipts[0]));
    expect(h.document.root.querySelector("[data-new-generation]")).toBeNull();
  });

  it("keeps an old live timeout independent while a new image succeeds, then archives the late original once",async()=>{
    const h=harness("main",false,new Map(),"",{timeoutMs:20}),originalReply=deferred<unknown>(),archive=installArchive(h);
    h.bridge.send.mockImplementationOnce(()=>originalReply.promise).mockResolvedValue({ok:true,images:["https://fixture.test/fresh.png"]});
    await boot(h);click(h);
    await vi.waitFor(()=>expect(h.document.control("[data-new-generation]").disabled).toBe(false));
    expect(h.controller().hasInFlightRequest()).toBe(true);
    const oldRecord=clone(h.controller().state.tasks[0]),oldReceiptValue=clone(h.controller().state.uncertain);
    click(h);await vi.waitFor(()=>expect(h.bridge.send).toHaveBeenCalledTimes(2));
    await vi.waitFor(()=>expect(h.controller().state.tasks[1].slots[0].status).toBe("done"));
    expect(h.controller().state.tasks[0]).toEqual(oldRecord);
    const freshId=h.controller().state.tasks[1].id;
    originalReply.complete({ok:true,images:["https://fixture.test/late-original.png"]});
    await vi.waitFor(()=>expect(h.controller().hasInFlightRequest()).toBe(false));await idle(h);
    expect(h.controller().state.tasks[0].slots[0].item).toMatchObject({jobId:oldReceiptValue.jobId,studioTaskId:oldRecord.id,url:"https://fixture.test/late-original.png"});
    expect(h.controller().state.tasks[1].slots[0].item).toMatchObject({studioTaskId:freshId,url:"https://fixture.test/fresh.png"});
    expect(archive).toHaveBeenCalledTimes(2);expect(h.bridge.send).toHaveBeenCalledTimes(2);expect(h.storage.size).toBe(0);
  });

  it("restores original and copied unknown tasks after a refresh without sending anything automatically",async()=>{
    const drafts=new Map<string,unknown>(),storage=new Map<string,string>(),h=harness("main",false,storage,"",{sharedDrafts:drafts});seed(h);drafts.set(key,clone(h.saved));
    h.bridge.send.mockResolvedValue({ok:false,stateUncertain:true,error:"fixture unknown new reply"});await boot(h);click(h);
    await vi.waitFor(()=>expect(h.bridge.send).toHaveBeenCalledOnce());await idle(h);
    const saved=clone(drafts.get(key) as Stored),newTask=saved.draft.tasks[0].id;
    expect(saved.snapshot.tasks).toHaveLength(2);expect(storage.size).toBe(2);
    const refreshed=harness("main",false,storage,"",{sharedDrafts:drafts});await boot(refreshed);
    expect(refreshed.controller().state.tasks.map((task:{id:string})=>task.id)).toEqual(saved.snapshot.tasks.map((task:{id:string})=>task.id));
    expect(refreshed.controller().state.tasks.find((task:{id:string})=>task.id===newTask).slots[0].status).toBe("uncertain");
    expect(refreshed.controller().state.pendingReceipts).toHaveLength(2);
    expect(refreshed.bridge.send).not.toHaveBeenCalled();expect(storage.size).toBe(2);
  });

  it.each(["increase-count","edit-prompt"])("preserves the original signed pending record when %s leaves other current images ready",async change=>{
    const drafts=new Map<string,unknown>(),storage=new Map<string,string>(),h=harness("main",false,storage,"",{sharedDrafts:drafts});
    const original=seed(h,change==="increase-count"?["uncertain"]:["uncertain","ready"]);
    if(change==="increase-count"){
      h.saved.draft.settings.count=2;original.task.plan=h.engine.createPlan(original.task,h.saved.draft.settings);
    }else original.task.plan=h.engine.editShot(original.task.plan,"shot-2",{prompt:"新的构图提示，必须保留原请求完整方案。"});
    const revised=clone(original.task.plan as Plan);expect(revised.signature).not.toBe(original.record.plan.signature);
    drafts.set(key,clone(h.saved));installArchive(h);
    h.bridge.send.mockImplementation((_type,message:Sent)=>Promise.resolve({ok:true,images:[`https://fixture.test/updated-${message.payload.studioGenesisPlan.shotId}.png`]}));
    await boot(h);const oldRecord=clone(h.controller().state.tasks[0]);
    expect(h.document.control("[data-action=generate]").textContent).toContain("按当前方案生成新图");
    click(h);await vi.waitFor(()=>expect(h.bridge.send).toHaveBeenCalledTimes(2));await idle(h);
    expect(h.controller().state.tasks.find((task:{id:string})=>task.id===original.task.id)).toEqual(oldRecord);
    const fresh=stored(h).draft.tasks[0];expect(fresh.id).not.toBe(original.task.id);
    expect((fresh.plan as Plan).shots).toEqual(revised.shots);
    expect(h.bridge.send.mock.calls.every(call=>(call[1] as Sent).payload.studioGenesisPlan.plan.taskId===fresh.id)).toBe(true);
    expect(storage.get(receiptKey(original.receipts[0].jobId))).toBe(JSON.stringify(original.receipts[0]));
    const refreshed=harness("main",false,storage,"",{sharedDrafts:drafts});await boot(refreshed);
    expect(refreshed.controller().state.tasks.find((task:{id:string})=>task.id===original.task.id)).toEqual(oldRecord);
    expect(refreshed.controller().state.tasks.find((task:{id:string})=>task.id===fresh.id).slots.every((slot:{status:string})=>slot.status==="done")).toBe(true);
    expect(refreshed.bridge.send).not.toHaveBeenCalled();
  });

  it("repeats the full blocked plan in a mixed batch while retaining its originals and skipping another completed task",async()=>{
    const h=harness("batch"),original=seed(h,["done","uncertain"],"batch:main"),completedTask=clone(original.task);
    completedTask.id="separate-complete";completedTask.plan=h.engine.reidentifyPlan(original.task.plan,completedTask.id);
    h.saved.draft.tasks.push(completedTask);
    const completedRecord={id:completedTask.id,name:completedTask.name,plan:clone(completedTask.plan),slots:(completedTask.plan as Plan).shots.map(shot=>({shot,status:"done",item:{resultId:`separate-${shot.id}`,url:`https://fixture.test/${shot.id}.png`,studioTaskId:completedTask.id,studioGenesisPlan:clone(completedTask.plan)},archiveOk:true}))};
    h.saved.snapshot.tasks.push(clone(completedRecord));installArchive(h);
    h.bridge.send.mockImplementation((_kind,message:Sent)=>Promise.resolve({ok:true,images:[`https://fixture.test/new-${message.payload.studioGenesisPlan.shotId}.png`]}));
    await boot(h);expect(h.document.control("[data-new-generation-note]").textContent).toContain("另生成 2 张新图");
    const initial=clone(h.controller().state.tasks);click(h);await vi.waitFor(()=>expect(h.bridge.send).toHaveBeenCalledTimes(2));await idle(h);
    expect(h.controller().state.tasks[0]).toEqual(initial[0]);
    expect(h.controller().state.tasks.find((task:{id:string})=>task.id===completedTask.id)).toEqual(initial[1]);
    const submissions=h.bridge.send.mock.calls.map(call=>(call[1] as Sent).payload.studioGenesisPlan.plan.taskId);
    expect(new Set(submissions).size).toBe(1);expect(submissions[0]).not.toBe(original.task.id);expect(submissions[0]).not.toBe(completedTask.id);
    expect(h.storage.size).toBe(1);
  });

  it.each(["detail","ad"])("preserves a separately edited %s type draft when copying the active plan",async type=>{
    const h=harness("main"),original=seed(h),otherSettings={...h.engine.defaults(type==="detail"?"detail":"main"),count:1,model:"other-type-model"};
    if(type==="ad")Object.assign(otherSettings,{imageType:"ad",adTemplate:h.engine.adTemplates[1].id,adType:"品牌广告"});
    const otherTask={...original.task,requirements:`${type} 独立要求`,analysis:"另一模式已核对分析"};
    const otherPlan=h.engine.editShot(h.engine.createPlan(otherTask,otherSettings),"shot-1",{prompt:`${type} 保留的手工编辑方案`,label:`${type} 自定义名称`});
    const typeDraft={requirements:otherTask.requirements,analysis:otherTask.analysis,overrides:null,plan:otherPlan,confirmed:true};
    Object.assign(original.task,{typeDrafts:{[type]:typeDraft}});Object.assign(h.saved.draft,{typeSettings:{[type]:otherSettings}});
    h.bridge.send.mockResolvedValue({ok:false,definitiveFailure:true,providerSubmitted:false,error:"fixture confirmed not submitted"});await boot(h);click(h);
    await vi.waitFor(()=>expect(h.bridge.send).toHaveBeenCalledOnce());await idle(h);
    const copied=stored(h).draft.tasks[0] as typeof original.task & {typeDrafts:Record<string,typeof typeDraft>};
    const savedOther=copied.typeDrafts[type];expect(copied.id).not.toBe(original.task.id);
    expect(savedOther.plan.taskId).toBe(copied.id);expect(savedOther.plan.shots).toEqual(otherPlan.shots);expect(savedOther.plan.settings).toEqual(otherSettings);
    expect(savedOther).toMatchObject({requirements:typeDraft.requirements,analysis:typeDraft.analysis,confirmed:true});
    expect(h.engine.validatePlan(savedOther.plan)).toEqual({ok:true});
    expect(h.bridge.send).toHaveBeenCalledOnce();
  });

  it("rejects a changed account before creating or submitting the independent task",async()=>{
    const h=harness("main"),original=seed(h);await boot(h);h.bridge.getAccountKey.mockResolvedValue("other-owner");click(h);
    await vi.waitFor(()=>expect(h.document.control("[data-message]").textContent).toContain("登录账号已变化"));
    expect(h.controller().state.tasks[0].id).toBe(original.task.id);expect(h.writes).toEqual([]);expect(h.bridge.send).not.toHaveBeenCalled();
    expect(h.storage.get(receiptKey(original.receipts[0].jobId))).toBe(JSON.stringify(original.receipts[0]));
  });

  it("does not submit or overwrite the durable draft if the copied plan cannot be saved",async()=>{
    const drafts=new Map<string,unknown>(),h=harness("main",false,new Map(),"",{sharedDrafts:drafts}),original=seed(h);
    drafts.set(key,clone(h.saved));const durable=clone(drafts.get(key));await boot(h);
    h.writeControl.error=new Error("fixture quota exceeded");click(h);
    await vi.waitFor(()=>expect(h.document.control("[data-message]").textContent).toContain("fixture quota exceeded"));
    expect(h.bridge.send).not.toHaveBeenCalled();expect(drafts.get(key)).toEqual(durable);
    expect(h.controller().state.tasks).toHaveLength(1);expect(h.storage.get(receiptKey(original.receipts[0].jobId))).toBe(JSON.stringify(original.receipts[0]));
    expect(h.document.control("[data-action=generate]").disabled).toBe(true);
  });

  it("does not offer full-plan regeneration for an already completed current plan with an older same-position receipt",async()=>{
    const h=harness("main"),original=seed(h,["done"]),receipt={...oldReceipt,taskId:original.task.id,shotId:"shot-1",jobId:"older-revision-job"};
    h.storage.set(receiptKey(receipt.jobId),JSON.stringify(receipt));h.saved.snapshot.uncertain=receipt;
    await boot(h);
    expect(h.controller().state.tasks[0].slots[0].status).toBe("done");
    expect(h.document.root.querySelector("[data-new-generation]")===null).toBe(true);
    expect(h.document.control("[data-action=generate]").disabled).toBe(true);
    expect(h.storage.get(receiptKey(receipt.jobId))).toBe(JSON.stringify(receipt));expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("preserves another tab's new pending task when a stale tab tries to save during exit",async()=>{
    const drafts=new Map<string,unknown>(),storage=new Map<string,string>();
    const a=harness("main",false,storage,"",{sharedDrafts:drafts}),original=seed(a);drafts.set(key,clone(a.saved));
    const b=harness("main",false,storage,"",{sharedDrafts:drafts});await Promise.all([boot(a),boot(b)]);
    a.bridge.send.mockResolvedValue({ok:false,stateUncertain:true,error:"fixture new pending task"});click(a);
    await vi.waitFor(()=>expect(a.bridge.send).toHaveBeenCalledOnce());await idle(a);
    const newer=clone(drafts.get(key) as Stored),newId=newer.draft.tasks[0].id;
    expect(newId).not.toBe(original.task.id);expect(newer.snapshot.tasks).toHaveLength(2);
    const leaving=await b.navigationGuard().canDeactivate();
    const persisted=drafts.get(key) as Stored;
    expect(persisted.draft.tasks[0].id).toBe(newId);
    expect(persisted.snapshot.tasks.some((task:{id:string})=>task.id===newId)).toBe(true);
    const c=harness("main",false,storage,"",{sharedDrafts:drafts});await boot(c);
    expect(c.controller().state.tasks.some((task:{id:string})=>task.id===newId)).toBe(true);
    expect(c.controller().state.pendingReceipts).toHaveLength(2);
    expect(a.bridge.send).toHaveBeenCalledOnce();expect(b.bridge.send).not.toHaveBeenCalled();expect(c.bridge.send).not.toHaveBeenCalled();
    expect(leaving.allowed).toBe(false);
  });

  it("permits only one durable independent generation when two stale tabs click together",async()=>{
    const drafts=new Map<string,unknown>(),storage=new Map<string,string>();
    const a=harness("main",false,storage,"",{sharedDrafts:drafts});seed(a);drafts.set(key,clone(a.saved));
    const b=harness("main",false,storage,"",{sharedDrafts:drafts});await Promise.all([boot(a),boot(b)]);
    for(const page of [a,b])page.bridge.send.mockResolvedValue({ok:false,stateUncertain:true,error:"fixture reply unknown"});
    click(a);click(b);
    await vi.waitFor(()=>expect(a.bridge.send.mock.calls.length+b.bridge.send.mock.calls.length).toBe(1));
    const winner=a.bridge.send.mock.calls.length?a:b,loser=winner===a?b:a;
    await idle(winner);
    await vi.waitFor(()=>expect(loser.document.control("[data-message]").textContent).toContain("其他页面已更新"));
    expect(loser.document.control("[data-action=generate]").disabled).toBe(true);
    const current=drafts.get(key) as Stored,newId=current.draft.tasks[0].id;
    expect((winner.bridge.send.mock.calls[0][1] as Sent).payload.studioGenesisPlan.plan.taskId).toBe(newId);
    expect(current.snapshot.tasks).toHaveLength(2);expect(storage.size).toBe(2);
    expect(a.bridge.send.mock.calls.length+b.bridge.send.mock.calls.length).toBe(1);
    click(loser);await flush();expect(a.bridge.send.mock.calls.length+b.bridge.send.mock.calls.length).toBe(1);
    expect((drafts.get(key) as Stored).draft.tasks[0].id).toBe(newId);
  });

  it("advances one tab's revision on consecutive saves without a false conflict",async()=>{
    const drafts=new Map<string,unknown>(),h=harness("main",false,new Map(),"",{sharedDrafts:drafts});seed(h);drafts.set(key,clone(h.saved));await boot(h);
    expect((await h.navigationGuard().canDeactivate()).allowed).toBe(true);
    const first=clone(drafts.get(key) as Stored & {revision:string});expect(first.revision).toBeTruthy();
    expect((await h.navigationGuard().canDeactivate()).allowed).toBe(true);
    const second=drafts.get(key) as Stored & {revision:string};expect(second.revision).toBeTruthy();expect(second.revision).not.toBe(first.revision);
    expect(second.draft).toEqual(first.draft);expect(second.snapshot).toEqual(first.snapshot);
    expect(h.document.control("[data-message]").textContent).not.toContain("其他页面已更新");expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("switches image types and back with the architecture's stored revisions and intact original receipts",async()=>{
    const drafts=new Map<string,unknown>(),h=harness("main",false,new Map(),"",{sharedDrafts:drafts}),original=seed(h);drafts.set(key,clone(h.saved));await boot(h);
    const switchTo=(mode:string)=>{
      const button=h.document.root.querySelectorAll("[data-action=mode]").find(value=>value.dataset.mode===mode)!;
      h.document.root.dispatch("click",button);
    };
    const detailKey=`${accountKey}:single:detail`;
    switchTo("detail");
    await vi.waitFor(()=>expect(drafts.has(detailKey)||(drafts.get(key) as Stored).draft.settings.mode==="detail").toBe(true));await idle(h);
    const separateWorkspaces=drafts.has(detailKey);
    const detail=clone(drafts.get(separateWorkspaces?detailKey:key) as Stored & {revision:string});
    expect(detail.revision).toBeTruthy();expect(detail.draft.settings.mode).toBe("detail");
    if(separateWorkspaces){
      expect((drafts.get(key) as Stored).draft.tasks[0].plan).toEqual(original.record.plan);
      expect(detail.draft.tasks[0].id).not.toBe(original.task.id);
    }else{
      const saved=detail.draft.tasks[0] as typeof original.task & {typeDrafts:Record<string,{plan:Plan}>};
      expect(saved.id).toBe(original.task.id);expect(saved.typeDrafts.main.plan).toEqual(original.record.plan);
    }
    const beforeReturn=(drafts.get(key) as Stored & {revision:string}).revision;
    switchTo("main");
    await vi.waitFor(()=>{
      const current=drafts.get(key) as Stored & {revision:string};
      expect(current.draft.settings.mode).toBe("main");expect(current.revision).not.toBe(beforeReturn);
    });await idle(h);
    expect(h.controller().state.tasks[0]?.id).toBe(original.task.id);
    expect((await h.navigationGuard().canDeactivate()).allowed).toBe(true);
    expect((drafts.get(key) as Stored).draft.tasks[0].plan).toEqual(original.record.plan);
    expect((drafts.get(key) as Stored).snapshot.tasks[0].plan).toEqual(original.record.plan);
    expect((drafts.get(key) as Stored).snapshot.tasks[0].slots[0].pendingReceipt).toEqual(original.receipts[0]);
    expect(h.storage.get(receiptKey(original.receipts[0].jobId))).toBe(JSON.stringify(original.receipts[0]));expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("creates and restores a project using the current workspace revision without dropping its pending record",async()=>{
    const drafts=new Map<string,unknown>(),h=harness("main",false,new Map(),"",{sharedDrafts:drafts}),original=seed(h);drafts.set(key,clone(h.saved));await boot(h);
    click(h,"new-project");await vi.waitFor(()=>expect((drafts.get(key) as Stored).draft.tasks[0].id).not.toBe(original.task.id));await idle(h);
    const fresh=clone(drafts.get(key) as Stored & {revision:string});expect(fresh.revision).toBeTruthy();
    expect([...drafts.keys()].filter(value=>value.includes(":saved-project:"))).toHaveLength(1);
    click(h,"restore-project");await vi.waitFor(()=>expect((drafts.get(key) as Stored).draft.tasks[0].id).toBe(original.task.id));await idle(h);
    const restored=drafts.get(key) as Stored & {revision:string};expect(restored.revision).not.toBe(fresh.revision);
    expect(restored.snapshot.tasks[0].plan).toEqual(original.record.plan);expect(restored.snapshot.tasks[0].slots[0].pendingReceipt).toEqual(original.receipts[0]);
    expect([...drafts.keys()].filter(value=>value.includes(":saved-project:"))).toHaveLength(2);
    expect(h.storage.get(receiptKey(original.receipts[0].jobId))).toBe(JSON.stringify(original.receipts[0]));expect(h.bridge.send).not.toHaveBeenCalled();
  });
});
