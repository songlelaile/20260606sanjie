import { describe, expect, it, vi } from "vitest";
import { accountKey, clone, deferred, harness, oldReceipt, ready } from "./test-fixtures/studio-genesis-ui-harness";

type H = ReturnType<typeof harness>;
type State = { ready:boolean; busy:boolean; activeCount:number; pendingReceiptCount:number; summary:string };
const taskBridge = (h:H) => h.context.SanjieStudioGenesisBridge as {getTaskState():State;activate():Promise<{ok:boolean;error?:string}>};
const key = `${accountKey}:single:main`;
const click = (h:H, action:string) => h.document.root.dispatch("click",h.document.control(`[data-action=${action}]`));
const boot = async (h:H) => { ready(h);await vi.waitFor(()=>expect(h.document.control("[data-setting=model]").disabled).toBe(false)); };
const progress = (h:H) => h.document.root.querySelector("[data-task-progress]");
const phase = (h:H) => h.document.control("[data-result-phase]").textContent;

describe("Studio visible task progress and preserved receipt recovery",()=>{
  it.each(["main","detail","ad","batch"] as const)("does not render an idle %s task progress card",async entry=>{
    const h=harness(entry);await boot(h);
    expect(!!progress(h)).toBe(false);expect(h.document.root.querySelectorAll("[data-task-row]")).toHaveLength(0);
    expect(taskBridge(h).getTaskState()).toMatchObject({busy:false,activeCount:0,pendingReceiptCount:0});
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it.each(["main","detail","ad","batch"] as const)("shows ended %s receipts as pending while preserving their original identity",async entry=>{
    const h=harness(entry), record=h.saved.snapshot.tasks[0], scope=entry==="batch"?"batch:main":`single:${entry==="detail"?"detail":entry==="ad"?"main:ad":"main"}`;
    const receipt={...oldReceipt,jobId:`${entry}-original-job`,taskId:record.id,shotId:record.slots[0].shot.id};
    record.slots[0].status="uncertain";record.slots[0].pendingReceipt=receipt;
    h.saved.snapshot.uncertain=receipt;h.saved.snapshot.pendingReceipts=[receipt];
    h.storage.set(`sz_studio_genesis_pending_v2:${accountKey}:${scope}:${receipt.jobId}`,JSON.stringify(receipt));
    await boot(h);
    expect(taskBridge(h).getTaskState()).toMatchObject({ready:true,busy:false,activeCount:0,pendingReceiptCount:1});
    expect(!!progress(h)).toBe(true);expect(h.document.control("[data-task-row]").textContent).toContain(receipt.jobId);expect(h.document.control("[data-task-elapsed]").textContent).toContain("已等待");
    expect(h.document.control("[data-pending-receipt]").textContent).toContain("查看生成记录");
    expect([...h.storage.values()].map(value=>JSON.parse(value))).toEqual([receipt]);
    expect(h.controller().state.tasks[0].slots[0].pendingReceipt).toMatchObject(receipt);
    expect(h.document.control("[data-setting=model]").disabled).toBe(false);
    expect(h.bridge.send).not.toHaveBeenCalled();expect(h.storage.size).toBe(1);
  });

  it("shows orphaned receipts as pending without treating them as active work",async()=>{
    const h=harness("main");h.saved.snapshot.uncertain=oldReceipt;h.saved.snapshot.pendingReceipts=[oldReceipt];
    h.storage.set(`sz_studio_genesis_pending_v2:${accountKey}:single:main:${oldReceipt.jobId}`,JSON.stringify(oldReceipt));
    await boot(h);
    expect(!!progress(h)).toBe(true);expect(h.document.root.querySelectorAll("[data-task-row]")).toHaveLength(1);
    expect(taskBridge(h).getTaskState()).toMatchObject({activeCount:0,pendingReceiptCount:1});
    expect(h.context.setInterval).toHaveBeenCalledOnce();expect(h.storage.size).toBe(1);expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("shows picture identity, queued and generating phases, then keeps the success in results",async()=>{
    const h=harness("main"),accountCheck=deferred<string>(),reply=deferred<unknown>();
    Object.assign(h.bridge,{archive:vi.fn(async()=>({ok:true}))});h.bridge.send.mockImplementation(()=>reply.promise);
    await boot(h);const label=h.saved.snapshot.tasks[0].slots[0].shot.label;
    h.bridge.getAccountKey.mockImplementation(()=>h.controller().state.tasks.some((entry:{slots:Array<{status:string}>})=>entry.slots.some(slot=>slot.status==="queued"))?accountCheck.promise:Promise.resolve(accountKey));
    click(h,"generate");await vi.waitFor(()=>expect(h.controller().state.tasks[0].slots[0].status).toBe("queued"));
    expect(!!progress(h)).toBe(true);expect(phase(h)).toBe("生成中…");expect(h.document.root.textContent).toContain("0/1 已生成");expect(h.bridge.send).not.toHaveBeenCalled();
    accountCheck.complete(accountKey);await vi.waitFor(()=>expect(h.bridge.send).toHaveBeenCalledOnce());
    expect(!!progress(h)).toBe(true);expect(phase(h)).toBe("生成中…");
    reply.complete({ok:true,images:["https://fixture.test/completed.png"]});
    await vi.waitFor(()=>expect(h.document.control("[data-setting=model]").disabled).toBe(false));
    expect(!!progress(h)).toBe(true);expect(phase(h)).toBe("生成完成");expect(h.document.control("[data-message]").textContent).toContain("图片已生成");
    expect(h.document.root.querySelectorAll("img").some(image=>image.attributes.get("src")==="https://fixture.test/completed.png")).toBe(true);
    expect(h.document.control("[data-action=download]").disabled).toBe(false);
  });

  it("keeps successful pixels and plan counts while another picture is generating",async()=>{
    const h=harness("main"),reply=deferred<unknown>(),entry=h.saved.draft.tasks[0];
    h.saved.draft.settings.count=2;entry.plan=h.engine.createPlan(entry,h.saved.draft.settings);
    const record=h.saved.snapshot.tasks[0];record.plan=entry.plan;
    record.slots=(entry.plan as {shots:typeof record.slots[number]["shot"][]}).shots.map(shot=>({shot,status:"ready",item:null,error:"",archiveOk:false}));
    Object.assign(h.bridge,{archive:vi.fn(async()=>({ok:true}))});
    h.bridge.send.mockResolvedValueOnce({ok:true,images:["https://fixture.test/first-success.png"]}).mockImplementationOnce(()=>reply.promise);
    await boot(h);click(h,"generate");
    await vi.waitFor(()=>expect(h.controller().state.tasks[0].slots[0].archiveOk).toBe(true));
    expect(!!progress(h)).toBe(true);expect(phase(h)).toBe("生成中…");
    expect(h.document.root.querySelectorAll("img").some(image=>image.attributes.get("src")==="https://fixture.test/first-success.png")).toBe(true);
    reply.complete({ok:true,images:["https://fixture.test/second-success.png"]});
    await vi.waitFor(()=>expect(h.document.control("[data-setting=model]").disabled).toBe(false));expect(!!progress(h)).toBe(true);
  });

  it("retains failed task identity until explicit retry and then shows completion",async()=>{
    const h=harness("main"),reply=deferred<unknown>();Object.assign(h.bridge,{archive:vi.fn(async()=>({ok:true}))});
    h.bridge.send.mockResolvedValue({ok:false,definitiveFailure:true,providerSubmitted:false,error:"fixture generation failed"});
    await boot(h);click(h,"generate");await vi.waitFor(()=>expect(h.document.control("[data-action=retry]").disabled).toBe(false));
    expect(!!progress(h)).toBe(true);expect(h.document.root.textContent).toContain("生成失败");
    h.bridge.send.mockImplementation(()=>reply.promise);click(h,"retry");await vi.waitFor(()=>expect(h.bridge.send).toHaveBeenCalledTimes(2));
    expect(phase(h)).toBe("生成中…");
    reply.complete({ok:true,images:["https://fixture.test/retry-success.png"]});
    await vi.waitFor(()=>expect(h.document.control("[data-setting=model]").disabled).toBe(false));expect(!!progress(h)).toBe(true);
  });

  it("leaves failed rows with their old project when a new project opens",async()=>{
    const h=harness("main");h.saved.snapshot.tasks[0].slots[0].status="failed";
    await boot(h);expect(!!progress(h)).toBe(true);expect(h.document.root.textContent).toContain("生成失败");
    click(h,"new-project");await vi.waitFor(()=>expect(h.document.root.querySelector("[data-action=restore-project]")).not.toBeNull());
    expect(!!progress(h)).toBe(true);expect(taskBridge(h).getTaskState().summary).toContain("失败 1");
    expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("turns an unknown generation reply into a reminder and leaves a new explicit task available",async()=>{
    const h=harness("main");h.bridge.send.mockResolvedValue({ok:false,stateUncertain:true,providerSubmitted:true,error:"请求结果尚未确认，请查看原任务进度，避免重复生成。"});
    await boot(h);click(h,"generate");
    await vi.waitFor(()=>expect(h.document.root.querySelector("[data-new-generation]")).not.toBeNull());
    expect(h.document.control("[data-message]").classList.contains("is-error")).toBe(false);
    expect(h.document.control("[data-message]").textContent).toContain("其他任务可继续");
    expect(taskBridge(h).getTaskState()).toMatchObject({activeCount:0,pendingReceiptCount:1});
    expect(!!progress(h)).toBe(true);expect(h.document.control("[data-new-generation-note]").textContent).toContain("按新任务计费");
    expect(h.bridge.send).toHaveBeenCalledOnce();expect(h.storage.size).toBe(1);
  });

  it("ends a live wait, opens an independent project, and saves the late original only into its backup",async()=>{
    const drafts=new Map<string,unknown>(),h=harness("main",false,new Map(),"",{sharedDrafts:drafts});drafts.set(key,clone(h.saved));
    const late=deferred<unknown>(),saving=deferred<{ok:boolean}>(),archive=vi.fn(()=>saving.promise);Object.assign(h.bridge,{archive});h.bridge.send.mockImplementation(()=>late.promise);
    await boot(h);const originalId=h.saved.draft.tasks[0].id;click(h,"generate");
    await vi.waitFor(()=>expect(h.bridge.send).toHaveBeenCalledOnce());
    const originalController=h.controller();expect(taskBridge(h).getTaskState().activeCount).toBe(1);
    click(h,"end-wait");await vi.waitFor(()=>expect(h.document.control("[data-action=new-project]").disabled).toBe(false));
    expect(originalController.hasInFlightRequest()).toBe(true);expect(taskBridge(h).getTaskState()).toMatchObject({activeCount:0,pendingReceiptCount:1});
    expect(!!progress(h)).toBe(true);
    click(h,"new-project");
    await vi.waitFor(()=>expect((drafts.get(key) as H["saved"]).draft.tasks[0].id).not.toBe(originalId));
    await vi.waitFor(()=>expect(h.document.control("[data-setting=model]").disabled).toBe(false));
    const fresh=clone(drafts.get(key)), backupKey=[...drafts.keys()].find(value=>value.includes(":saved-project:"))!;
    expect(!!progress(h)).toBe(true);expect(h.document.control("[data-action=restore-retained]").textContent).toBe("恢复保留任务");
    late.complete({ok:true,images:["https://fixture.test/original-late.png"]});
    await vi.waitFor(()=>expect(originalController.state.tasks[0].slots[0].archiveSaving).toBe(true));
    expect(!!progress(h)).toBe(true);expect(phase(h)).toBe("生成结果");
    expect(h.document.control("[data-setting=model]").disabled).toBe(false);expect(drafts.get(key)).toEqual(fresh);
    saving.complete({ok:true});
    await vi.waitFor(()=>expect(originalController.hasInFlightRequest()).toBe(false));
    await vi.waitFor(()=>expect((drafts.get(backupKey) as H["saved"]).snapshot.tasks[0].slots[0].status).toBe("done"));
    expect(drafts.get(key)).toEqual(fresh);expect(archive).toHaveBeenCalledOnce();expect(h.storage.size).toBe(0);
    expect(!!progress(h)).toBe(true);
    expect(taskBridge(h).getTaskState()).toMatchObject({activeCount:0,pendingReceiptCount:0});
    expect(h.document.control("[data-setting=model]").disabled).toBe(false);expect(h.bridge.send).toHaveBeenCalledOnce();
  });

  it("allows retained activation with a pending result but rejects a different account without writes",async()=>{
    const h=harness("main");await boot(h);const writes=h.writes.length;
    expect(await taskBridge(h).activate()).toEqual({ok:true});h.bridge.getAccountKey.mockResolvedValue("another-owner");
    expect(await taskBridge(h).activate()).toMatchObject({ok:false,error:expect.stringContaining("登录账号已变化")});
    expect(h.writes).toHaveLength(writes);expect(h.bridge.send).not.toHaveBeenCalled();
  });

  it("restores the still-live original controller and writes its late image into the current project",async()=>{
    const drafts=new Map<string,unknown>(),h=harness("main",false,new Map(),"",{sharedDrafts:drafts});drafts.set(key,clone(h.saved));
    const late=deferred<unknown>();Object.assign(h.bridge,{archive:vi.fn(async()=>({ok:true}))});h.bridge.send.mockImplementation(()=>late.promise);
    await boot(h);click(h,"generate");await vi.waitFor(()=>expect(h.bridge.send).toHaveBeenCalledOnce());const original=h.controller();
    click(h,"end-wait");await vi.waitFor(()=>expect(h.document.control("[data-action=new-project]").disabled).toBe(false));click(h,"new-project");
    await vi.waitFor(()=>expect(h.document.root.querySelector("[data-action=restore-project]")).not.toBeNull());
    await vi.waitFor(()=>expect(h.document.control("[data-setting=model]").disabled).toBe(false));click(h,"restore-project");
    await vi.waitFor(()=>expect(h.controller()).toBe(original));
    await vi.waitFor(()=>expect(h.document.control("[data-setting=model]").disabled).toBe(false));
    late.complete({ok:true,images:["https://fixture.test/restored-late.png"]});
    await vi.waitFor(()=>expect((drafts.get(key) as H["saved"]).snapshot.tasks[0].slots[0].item?.url).toBe("https://fixture.test/restored-late.png"));
    expect(h.storage.size).toBe(0);expect(h.bridge.send).toHaveBeenCalledOnce();
    expect(taskBridge(h).getTaskState()).toMatchObject({activeCount:0,pendingReceiptCount:0});
  });

  it("reports saving as active until returned pixels finish archiving",async()=>{
    const h=harness("main"),saving=deferred<{ok:boolean}>();Object.assign(h.bridge,{archive:vi.fn(()=>saving.promise)});
    h.bridge.send.mockResolvedValue({ok:true,images:["https://fixture.test/saving.png"]});await boot(h);click(h,"generate");
    await vi.waitFor(()=>expect(h.controller().state.tasks[0].slots[0].archiveSaving).toBe(true));
    expect(taskBridge(h).getTaskState()).toMatchObject({busy:true,activeCount:1});
    expect(!!progress(h)).toBe(true);expect(h.document.root.textContent).toContain("已生成待保存");
    saving.complete({ok:true});await vi.waitFor(()=>expect(h.document.control("[data-setting=model]").disabled).toBe(false));
    expect(taskBridge(h).getTaskState()).toMatchObject({busy:false,activeCount:0});
    expect(!!progress(h)).toBe(true);
  });

  it("keeps failed historical pixel saves recoverable without disabling the independent current draft",async()=>{
    const drafts=new Map<string,unknown>(),h=harness("main",false,new Map(),"",{sharedDrafts:drafts});drafts.set(key,clone(h.saved));
    const late=deferred<unknown>(),archive=vi.fn(async()=>({ok:false,error:"fixture archive unavailable"}));Object.assign(h.bridge,{archive});h.bridge.send.mockImplementation(()=>late.promise);
    await boot(h);click(h,"generate");await vi.waitFor(()=>expect(h.bridge.send).toHaveBeenCalledOnce());const original=h.controller();
    click(h,"end-wait");await vi.waitFor(()=>expect(h.document.control("[data-action=new-project]").disabled).toBe(false));click(h,"new-project");
    await vi.waitFor(()=>expect(h.document.root.querySelector("[data-action=restore-project]")).not.toBeNull());
    await vi.waitFor(()=>expect(h.document.control("[data-setting=model]").disabled).toBe(false));h.writeControl.error=new Error("fixture disk full");
    late.complete({ok:true,images:["https://fixture.test/recoverable-pixels.png"]});
    await vi.waitFor(()=>expect(original.hasInFlightRequest()).toBe(false));
    expect(h.document.control("[data-setting=model]").disabled).toBe(false);
    expect(await h.navigationGuard().canDeactivate()).toMatchObject({allowed:false,reason:expect.stringContaining("历史任务")});
    expect(!!progress(h)).toBe(true);expect(h.document.control("[data-retained-recovery]").textContent).toContain("待补存");
    expect(h.document.control("[data-action=restore-retained]").closest("[data-task-progress]")).toBeNull();
    h.writeControl.error=undefined;click(h,"restore-retained");await vi.waitFor(()=>expect(h.controller()).toBe(original));
    await vi.waitFor(()=>expect(h.document.control("[data-setting=model]").disabled).toBe(false));
    expect((drafts.get(key) as H["saved"]).snapshot.tasks[0].slots[0].item?.url).toBe("https://fixture.test/recoverable-pixels.png");
    expect(h.document.root.querySelector("[data-action=archive]")).not.toBeNull();expect(h.bridge.send).toHaveBeenCalledOnce();
  });

  it("does not turn focus recovery of an old live promise into a global API configuration failure",async()=>{
    const h=harness("main",false,new Map(),"",{timeoutMs:20}),late=deferred<unknown>();h.bridge.send.mockImplementation(()=>late.promise);
    await boot(h);click(h,"generate");await vi.waitFor(()=>expect(h.document.root.querySelector("[data-new-generation]")).not.toBeNull());
    await vi.waitFor(()=>expect(h.document.control("[data-action=generate]").disabled).toBe(false));
    expect(h.controller().hasInFlightRequest()).toBe(true);const recoveries=h.recoveryStarted.mock.calls.length;
    h.dispatchWindow("focus");for(let index=0;index<100;index++)await Promise.resolve();
    expect(h.recoveryStarted).toHaveBeenCalledTimes(recoveries);expect(h.document.control("[data-action=generate]").disabled).toBe(false);
    expect(h.document.root.querySelector("[data-generation-api-required]")).toBeNull();
    late.complete({ok:false,stateUncertain:true,providerSubmitted:true,error:"fixture unknown reply"});
    await vi.waitFor(()=>expect(h.controller().hasInFlightRequest()).toBe(false));
  });
  it("shows partial completion from current required slots even when the results step is open",async()=>{
    const h=harness("main"),entry=h.saved.draft.tasks[0],record=h.saved.snapshot.tasks[0];
    h.saved.draft.settings.count=3;entry.plan=h.engine.createPlan(entry,h.saved.draft.settings);record.plan=entry.plan;
    record.slots=(entry.plan as {shots:typeof record.slots[number]["shot"][]}).shots.map((shot:typeof record.slots[number]["shot"],index:number)=>({shot,status:index===0?"done":index===1?"failed":"uncertain",item:index===0?{url:"https://fixture.test/partial-original.png",resultId:"partial-original",accountKey,studioTaskId:entry.id,studioGenesisPlan:clone(entry.plan)}:null,error:"",archiveOk:index===0}));
    const receipt={...oldReceipt,taskId:entry.id,shotId:record.slots[2].shot.id};
    Object.assign(record.slots[2],{pendingReceipt:receipt});h.saved.snapshot.pendingReceipts=[receipt];h.saved.snapshot.uncertain=receipt;
    h.storage.set(`sz_studio_genesis_pending_v2:${accountKey}:single:main:${receipt.jobId}`,JSON.stringify(receipt));
    await boot(h);
    const resultStep=h.document.root.querySelectorAll("[data-action=navigate-step]").find(button=>button.dataset.step==="4")!;
    h.document.root.dispatch("click",resultStep);
    expect(phase(h)).toBe("部分完成");expect(h.document.control("[data-run-progress]").textContent).toContain("1/3 已生成 · 1 失败 · 1 待确认");
    expect(taskBridge(h).getTaskState()).toMatchObject({currentPlan:{completedCount:1,plannedCount:3,failedCount:1,pendingReceiptCount:1},failedCount:1,pendingReceiptCount:1});
    expect(h.document.control("[data-action=download]").disabled).toBe(false);expect(h.bridge.send).not.toHaveBeenCalled();
    expect(h.storage.size).toBe(1);
  });

  it("retains successful originals and the whole-plan denominator through a failed-only retry",async()=>{
    const h=harness("main"),entry=h.saved.draft.tasks[0],record=h.saved.snapshot.tasks[0],retry=deferred<unknown>();
    h.saved.draft.settings.count=2;entry.plan=h.engine.createPlan(entry,h.saved.draft.settings);record.plan=entry.plan;
    record.slots=(entry.plan as {shots:typeof record.slots[number]["shot"][]}).shots.map((shot:typeof record.slots[number]["shot"],index:number)=>({shot,status:index?"failed":"done",item:index?null:{url:"https://fixture.test/kept-original.png",resultId:"kept-original",accountKey,studioTaskId:entry.id,studioGenesisPlan:clone(entry.plan)},error:"",archiveOk:!index}));
    h.bridge.send.mockImplementation(()=>retry.promise);Object.assign(h.bridge,{archive:vi.fn(async()=>({ok:true}))});
    await boot(h);click(h,"retry");await vi.waitFor(()=>expect(h.bridge.send).toHaveBeenCalledOnce());
    expect(h.document.control("[data-run-progress]").textContent).toContain("1/2 已生成");
    expect(taskBridge(h).getTaskState()).toMatchObject({currentPlan:{completedCount:1,plannedCount:2}});
    expect(h.document.root.querySelectorAll("img").some(image=>image.attributes.get("src")==="https://fixture.test/kept-original.png")).toBe(true);
    retry.complete({ok:true,images:["https://fixture.test/retried-original.png"]});
    await vi.waitFor(()=>expect(h.document.control("[data-setting=model]").disabled).toBe(false));
    expect(h.document.control("[data-run-progress]").textContent).toContain("2/2 已生成");expect(phase(h)).toBe("生成完成");
    expect(h.controller().state.tasks[0].slots[0].item?.resultId).toBe("kept-original");expect(h.bridge.send).toHaveBeenCalledOnce();
  });

  it("keeps generated pixels downloadable and provides save recovery when local archiving fails",async()=>{
    const h=harness("main");h.bridge.send.mockResolvedValue({ok:true,images:["https://fixture.test/unsaved-original.png"]});Object.assign(h.bridge,{archive:vi.fn(async()=>({ok:false,error:"fixture disk full"}))});
    await boot(h);click(h,"generate");await vi.waitFor(()=>expect(h.document.control("[data-setting=model]").disabled).toBe(false));
    expect(taskBridge(h).getTaskState()).toMatchObject({unsavedCount:1,currentPlan:{completedCount:1,plannedCount:1,unsavedCount:1}});
    expect(h.document.control("[data-task-row]").textContent).toContain("已生成待补存");expect(h.document.control("[data-action=archive]").disabled).toBe(false);
    expect(h.document.control("[data-action=download]").disabled).toBe(false);expect(h.bridge.send).toHaveBeenCalledOnce();
  });

  it("updates elapsed labels without rewriting the status-only live region or resubmitting",async()=>{
    const h=harness("main"),record=h.saved.snapshot.tasks[0],receipt={...oldReceipt,taskId:record.id,shotId:record.slots[0].shot.id,createdAt:Date.now()-62_000};
    record.slots[0].status="uncertain";Object.assign(record.slots[0],{pendingReceipt:receipt});h.saved.snapshot.pendingReceipts=[receipt];h.saved.snapshot.uncertain=receipt;
    h.storage.set(`sz_studio_genesis_pending_v2:${accountKey}:single:main:${receipt.jobId}`,JSON.stringify(receipt));
    await boot(h);const announcer=h.document.getElementById("sgTaskAnnouncement")!,live=announcer.querySelector("span")!,before=live.textContent;
    const timer=(h.context.setInterval as ReturnType<typeof vi.fn>).mock.calls[0][0] as ()=>void;
    const row=h.document.control("[data-task-row]"),initialElapsed=h.document.control("[data-task-elapsed]").textContent;
    timer();timer();
    expect(h.document.control("[data-task-elapsed]").textContent).toBe(initialElapsed);expect(h.document.getElementById("sgTaskAnnouncement")?.querySelector("span")).toBe(live);expect(live.textContent).toBe(before);
    expect(row.querySelector("[aria-live]")).toBeNull();expect(h.bridge.send).not.toHaveBeenCalled();
    const result=await (h.context.SanjieStudioGenesisBridge as {revealTask(key:string):Promise<{ok:boolean}>}).revealTask(receipt.jobId);
    expect(result).toEqual({ok:true});expect(h.bridge.send).not.toHaveBeenCalled();expect(h.storage.size).toBe(1);
  });

});
