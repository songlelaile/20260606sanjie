'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const lab=process.env.SKU_PAID_PRECHECK_LAB || path.resolve(__dirname,'../public/creative/labs/image-prompt-lab');
const source=fs.readFileSync(path.join(lab,'promptlab.js'),'utf8'),parsed=ts.createSourceFile('actual-paid-sku.js',source,ts.ScriptTarget.Latest,true);
const node=parsed.statements.filter(item=>ts.isFunctionDeclaration(item)&&item.name?.text==='generateSkuOne');
assert.equal(node.length,1);
const actual=source.slice(node[0].getStart(parsed),node[0].end);
function harness(precheck) {
  const prior={state:'running',jobId:'actual-dispatched-job'};
  const state={archiveAccountKey:'owner',skuBatchToken:4,stopRequested:false,skuTaskStatus:{'paid-task':prior}};
  const sandbox={Promise,state,skuCheckPaidTaskForGeneration:precheck,renderSkuWorkspace:()=>{sandbox.renders++;},renders:0};
  const context=vm.createContext(sandbox);vm.runInContext(actual,context);
  const entry=context.generateSkuOne;
  return {state,prior,sandbox,context,entry,task:{skuId:'paid-task',_skuOwner:'owner',item:{_skuPaidSnapshot:{}}}};
}
test('actual paid precheck does not reclassify a recursive rejection after dispatch as no-submission',async()=>{
  const h=harness(()=>Promise.resolve(true)),acceptedError=new Error('recursive rejection after provider acceptance');
  let recursiveCalls=0;
  h.context.generateSkuOne=async(task,token)=>{recursiveCalls++;assert.equal(task._skuPaidScopeChecked,true);assert.equal(token,4);throw acceptedError;};
  await assert.rejects(()=>h.entry(h.task,4,{config:{}}),error=>error===acceptedError);
  assert.equal(recursiveCalls,1);assert.equal(h.state.skuTaskStatus['paid-task'],h.prior);
  assert.equal(h.state.skuTaskStatus['paid-task'].providerSubmitted,undefined);assert.equal(h.sandbox.renders,0);
});
test('actual rejected precheck remains a local no-submission outcome and never enters recursive generation',async()=>{
  const h=harness(()=>Promise.reject(new Error('stage settings changed')));let recursiveCalls=0;
  h.context.generateSkuOne=()=>{recursiveCalls++;throw new Error('must not generate');};
  const response=await h.entry(h.task,4,{config:{}});
  assert.equal(response.ok,false);assert.equal(response.definitiveFailure,true);assert.equal(response.providerSubmitted,false);
  assert.equal(response.code,'SKU_PAID_SCOPE_CHANGED');assert.equal(recursiveCalls,0);assert.equal(h.sandbox.renders,1);
});
test('actual fresh paid localization does not reclassify a recursive dispatch rejection',async()=>{
  const h=harness(()=>Promise.resolve(true)),acceptedError=new Error('recursive dispatch catch render rejected');
  h.task._skuPaidScopeChecked=true;h.task.item.url='data:image/png;base64,c3ViamVjdA==';
  h.context.skuSettingsFromDurableEntry=()=>({config:{},archiveBatchId:'batch'});
  h.context.skuBusinessTitle=()=> 'approved title';h.context.skuReplicaBaseImage=()=> 'data:image/png;base64,YmFzZQ==';
  h.context.skuVisualSourceDataUrl=async value=>value;
  h.context.skuValidateLocalizedInputGeometry=async(_base,_subject,settings)=>({settings});
  let dispatched=0;const uncertain={state:'uncertain',jobId:'actual-dispatched-job'};
  h.context.generateSkuOne=async task=>{assert.equal(task._skuInputsLocalized,true);dispatched++;h.state.skuTaskStatus['paid-task']=uncertain;throw acceptedError;};
  await assert.rejects(()=>h.entry(h.task,4,{config:{},archiveBatchId:'batch'}),error=>error===acceptedError);
  assert.equal(dispatched,1);assert.equal(h.state.skuTaskStatus['paid-task'],uncertain);assert.equal(h.sandbox.renders,0);
  assert.equal(h.state.skuTaskStatus['paid-task'].providerSubmitted,undefined);
});
test('actual failed local image preparation remains no-submission without dispatch',async()=>{
  const h=harness(()=>Promise.resolve(true));h.task._skuPaidScopeChecked=true;h.task.item.url='data:image/png;base64,c3ViamVjdA==';
  h.context.skuSettingsFromDurableEntry=()=>({config:{},archiveBatchId:'batch'});
  h.context.skuBusinessTitle=()=> 'approved title';h.context.skuReplicaBaseImage=()=> 'data:image/png;base64,YmFzZQ==';
  h.context.skuVisualSourceDataUrl=async()=>{throw new Error('local image preparation failed');};
  let dispatched=0;h.context.generateSkuOne=async()=>{dispatched++;throw new Error('unexpected dispatch');};
  const result=await h.entry(h.task,4,{config:{},archiveBatchId:'batch'});
  assert.equal(result.ok,false);assert.equal(dispatched,0);
  assert.equal(h.state.skuTaskStatus['paid-task'].definitiveFailure,true);assert.equal(h.state.skuTaskStatus['paid-task'].providerSubmitted,false);
});
