import {describe,expect,it,vi} from 'vitest';
import {accountKey,clone,harness,ready} from './test-fixtures/studio-genesis-ui-harness';
type Harness=ReturnType<typeof harness>;
type Saved=Harness['saved'];
const mainKey=`${accountKey}:single:main`,detailKey=`${accountKey}:single:detail`;
const recovered=(key:string)=>`${key}:type-recovery-v1`;
function mixed(h:Harness,type:'main'|'detail'){
  const settings={...h.engine.defaults(type),count:1,model:'fixture-image'};
  const task=h.saved.draft.tasks[0];task.plan=h.engine.createPlan(task,settings);
  h.saved.draft.settings=settings;
  h.saved.snapshot.tasks=[{id:task.id,name:task.name,plan:clone(task.plan),slots:(task.plan as {shots:unknown[]}).shots.map(shot=>({shot,status:'ready',item:null,error:'',archiveOk:false}))}];
  return clone(h.saved);
}
async function boot(h:Harness){ready(h);await vi.waitFor(()=>expect(h.document.control('[data-setting=model]').disabled).toBe(false));}
const click=(h:Harness,name:string)=>h.document.root.dispatch('click',h.document.control(`[data-action=${name}]`));
describe('recovered workspace CAS integration',()=>{
  it('preserves a new pending task in the recovery row when a stale page tries to leave',async()=>{
    const rows=new Map<string,unknown>(),journal=new Map<string,string>();
    const a=harness('main',false,journal,'',{sharedDrafts:rows}),original=mixed(a,'detail');rows.set(mainKey,original);
    await boot(a);const first=clone(rows.get(recovered(mainKey)) as Saved);
    expect(a.document.root.textContent).toContain('已保留旧版混合草稿');
    const b=harness('main',false,journal,'',{sharedDrafts:rows});await boot(b);
    click(a,'plan');await vi.waitFor(()=>expect((rows.get(recovered(mainKey)) as Saved).draft.tasks[0].plan).toBeTruthy());
    const confirm=a.document.control('[data-confirm]');confirm.checked=true;a.document.root.dispatch('change',confirm);
    a.bridge.send.mockResolvedValue({ok:false,stateUncertain:true,error:'fixture unknown response'});click(a,'generate');
    await vi.waitFor(()=>expect(a.bridge.send).toHaveBeenCalledOnce());
    await vi.waitFor(()=>expect(a.document.control('[data-setting=model]').disabled).toBe(false));
    const newest=clone(rows.get(recovered(mainKey)) as Saved);expect(newest.snapshot.tasks).toHaveLength(1);
    expect(newest.snapshot.tasks[0].slots[0].status).toBe('uncertain');expect(newest.draft.tasks[0].id).toBe(first.draft.tasks[0].id);
    expect((await b.navigationGuard().canDeactivate()).allowed).toBe(false);
    expect(rows.get(recovered(mainKey))).toEqual(newest);expect(rows.get(mainKey)).toEqual(original);
    const c=harness('main',false,journal,'',{sharedDrafts:rows});await boot(c);
    expect(c.controller().state.tasks[0].slots[0].status).toBe('uncertain');
    expect(c.document.root.textContent).toContain('已保留旧版混合草稿');
    click(c,'legacy-tasks');await vi.waitFor(()=>expect(c.document.getElementById('sgDialog')?.hidden).toBe(false));
    expect(c.document.getElementById('sgDialog')!.textContent).toContain('已保存商品');
    expect(a.bridge.send).toHaveBeenCalledOnce();expect(b.bridge.send).not.toHaveBeenCalled();expect(c.bridge.send).not.toHaveBeenCalled();
  });
  it('updates main and detail recovery revisions independently without touching either canonical legacy row',async()=>{
    const rows=new Map<string,unknown>(),journal=new Map<string,string>();
    const main=harness('main',false,journal,'',{sharedDrafts:rows}),detail=harness('detail',false,journal,'',{sharedDrafts:rows});
    const oldMain=mixed(main,'detail'),oldDetail=mixed(detail,'main');rows.set(mainKey,oldMain);rows.set(detailKey,oldDetail);
    await Promise.all([boot(main),boot(detail)]);
    const beforeMain=clone(rows.get(recovered(mainKey)) as Saved & {revision:string}),beforeDetail=clone(rows.get(recovered(detailKey)) as Saved & {revision:string});
    expect((await main.navigationGuard().canDeactivate()).allowed).toBe(true);
    expect((rows.get(recovered(mainKey)) as {revision:string}).revision).not.toBe(beforeMain.revision);
    expect(rows.get(recovered(detailKey))).toEqual(beforeDetail);
    expect((await detail.navigationGuard().canDeactivate()).allowed).toBe(true);
    expect((rows.get(recovered(detailKey)) as {revision:string}).revision).not.toBe(beforeDetail.revision);
    expect(rows.get(mainKey)).toEqual(oldMain);expect(rows.get(detailKey)).toEqual(oldDetail);
    expect(main.bridge.send).not.toHaveBeenCalled();expect(detail.bridge.send).not.toHaveBeenCalled();
  });
});
