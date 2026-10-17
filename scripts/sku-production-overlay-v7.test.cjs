'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, webcrypto, randomUUID } = require('node:crypto');
const ts = require('typescript');
const { build, V4_PINS, SOURCE_PINS, SELECTED, ADDED } = require('./prepare-sku-durable-production-overlay-v7.cjs');
const ROOT = path.resolve(__dirname, '..'), PREFIX = 'public/creative/labs/image-prompt-lab/';
const BASE = path.join(ROOT, 'docs/uat-sku-workflow-20261012/production-overlay-v4');
const RUNTIME = 'studio-runtime-20261010-credit-v3.js';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const review = build({ reviewOnly: true });
function findNode(text, predicate) {
  const parsed = ts.createSourceFile('actual-v7.js', text, ts.ScriptTarget.Latest, true);
  const found = [];
  function visit(node) { if (predicate(node, parsed)) found.push(node); ts.forEachChild(node, visit); }
  visit(parsed);
  assert.equal(found.length, 1);
  return text.slice(found[0].getStart(parsed), found[0].end);
}
function message(text, type) {
  return findNode(text, (node, source) => ts.isIfStatement(node) && node.expression.getText(source) === "msg.type === '" + type + "'");
}
function runtimeHarness() {
  const calls = [];
  const identitySource = findNode(review.compiled[RUNTIME], (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'normalizeImageReceiptIdentity');
  const sandbox = {
    AbortController, TextEncoder, crypto: webcrypto,
    activeJobs: {}, pendingSkuDurableReceipts: {}, pendingReferenceDetailClaims: {}, referenceDetailCancellationTombstones: {},
    referenceDetailMessageSurfacePreflight: (_type, _config, payload) => ({ ok: true, surface: payload.labMode, payload }),
    imagePreSubmissionFailure: (value) => value,
    normalizeCfg: (value) => value, usesPlatformWallet: () => true,
    skuDurableRuntimeSupported: () => true,
    skuDurableRuntimeValidate: async (_msg, _payload, _job) => { calls.push('sku-validate'); return { ok: true, identity: _msg.receiptIdentity }; },
    createImageTask: async (_cfg, payload) => {
      calls.push({ jobId: payload._jobId, identity: sandbox.activeJobs[payload._jobId]?.szImageReceiptIdentity });
      return { ok: true, images: ['data:image/png;base64,eA=='] };
    }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(identitySource + '\n' +
    'this.generate=function(msg,sender,sendResponse){' + message(review.compiled[RUNTIME], 'GENERATE_IMAGE') + '};\n' +
    'this.cancel=function(msg,sender,sendResponse){' + message(review.compiled[RUNTIME], 'CANCEL_GENERATION') + '};\n' +
    'this.capability=function(msg,sender,sendResponse){' + message(review.compiled[RUNTIME], 'GET_SKU_RECEIPT_CAPABILITY') + '};', context);
  return { sandbox, calls, context };
}
function identity(jobId, signature = 'plan-signature') {
  return { version: 1, receiptId: randomUUID(), jobId, accountKey: 'owner', workspaceKey: 'workspace', taskId: 'task',
    shotId: 'shot', batchId: 'batch', planSignatureHash: hash(signature) };
}

test('candidate scope is five writes with eight-file inventory; protected v4 assets stay exact', () => {
  assert.equal(review.manifest.files.length, 5);
  assert.equal(review.manifest.inventory.length, 8);
  assert.deepEqual(review.manifest.protectedPayloads.map((file) => file.file), ['sku-region-ui.js', 'sku-region-ui.css', 'sku-delivery-store.js']);
  for (const file of review.manifest.protectedPayloads) assert.equal(file.baselineSha256, file.newSha256);
  assert.equal(review.manifest.files.at(-1).file, 'sku-durable-receipt.js');
  assert.equal(review.manifest.files.at(-1).baselineSha256, null);
  assert.equal(hash(review.compiled['sku-durable-receipt.js']), SOURCE_PINS['sku-durable-receipt.js']);
});
test('independent audit replay verifies every unedited byte chunk and exact selected globals', () => {
  for (const [name, proof] of [['promptlab.js', review.audit.promptlab], ['background.js', review.audit.background],
    [RUNTIME, review.audit.packedRuntime], ['promptlab.html', review.audit.html]]) {
    const before = fs.readFileSync(path.join(BASE, 'overlay', PREFIX, name), 'utf8'), after = review.compiled[name];
    for (const chunk of proof.chunks) {
      const original = before.slice(chunk.baselineStart, chunk.baselineEnd);
      assert.equal(original, after.slice(chunk.outputStart, chunk.outputEnd));
      assert.equal(hash(original), chunk.sha256);
    }
  }
  assert.equal(review.audit.promptlab.preservedGlobalFunctionCount, 898);
  assert.equal(review.audit.packedRuntime.existingReceiptHelpers.length, 9);
  assert.equal(review.audit.packedRuntime.formalGenesisReceiptRoute.byteIdentical, true);
  assert.deepEqual(review.audit.promptlab.selectedGlobals, SELECTED);
  assert.deepEqual(review.audit.promptlab.addedGlobals, ADDED);
  assert.ok(review.audit.promptlab.excludedLocalFunctionChanges.some((item) => item.name === 'cfgFromForm'));
});
test('packed HTML loads durable after delivery and before promptlab while retaining packed runtime/styles', () => {
  const html = review.compiled['promptlab.html'];
  const delivery = html.indexOf('<script src="sku-delivery-store.js');
  const durable = html.indexOf('<script src="sku-durable-receipt.js');
  const promptlab = html.indexOf('<script src="promptlab.js');
  assert.ok(delivery < durable && durable < promptlab);
  assert.equal((html.match(/<script src="sku-durable-receipt\.js/g) || []).length, 1);
  assert.equal((html.match(/<script src="studio-runtime-20261010-credit-v3\.js/g) || []).length, 1);
  assert.equal(html.includes('<script src="background.js'), false);
  assert.equal(review.audit.existingPackedStylesUnchanged, true);
});
test('actual patched packed handler routes SKU DTO before formalGenesis and hands original identity to image task', async () => {
  const harness = runtimeHarness(), dto = identity('sku-job');
  const response = await new Promise((resolve) => harness.context.generate({ type: 'GENERATE_IMAGE', jobId: dto.jobId, config: {},
    receiptIdentity: dto, payload: { labMode: 'sku', detailMode: 'sku', promptSource: 'sku', skuDurablePlan: {} } }, {}, resolve));
  assert.equal(response.ok, true);
  assert.equal(harness.calls[0], 'sku-validate');
  assert.equal(harness.calls[1].identity.receiptId, dto.receiptId);
  assert.equal(harness.calls[1].identity.jobId, dto.jobId);
});
test('unchanged actual formalGenesis handler accepts existing nine-field DTO without entering SKU validator', async () => {
  const harness = runtimeHarness(), dto = identity('formal-job');
  const response = await new Promise((resolve) => harness.context.generate({ type: 'GENERATE_IMAGE', jobId: dto.jobId, config: {},
    receiptIdentity: dto, payload: { labMode: 'studio-genesis', batchId: 'batch',
      studioGenesisPlan: { shotId: 'shot', plan: { taskId: 'task', signature: 'plan-signature', settings: {} } } } }, {}, resolve));
  assert.equal(response.ok, true);
  assert.equal(harness.calls.includes('sku-validate'), false);
  assert.equal(harness.calls[0].identity.receiptId, dto.receiptId);
});
test('packed capability answers synchronously; pending SKU cancellation preserves claim and performs no task', () => {
  const harness = runtimeHarness();
  let capability, cancelled;
  harness.context.capability({ type: 'GET_SKU_RECEIPT_CAPABILITY' }, {}, (value) => { capability = value; });
  assert.equal(capability.supported, true);
  const claim = harness.sandbox.pendingSkuDurableReceipts['sku-pending'] = { cancelled: false };
  harness.context.cancel({ type: 'CANCEL_GENERATION', jobId: 'sku-pending' }, {}, (value) => { cancelled = value; });
  assert.equal(cancelled.noSubmission, true);
  assert.equal(claim.cancelled, true);
  assert.equal(harness.sandbox.pendingSkuDurableReceipts['sku-pending'], claim);
  assert.equal(harness.calls.length, 0);
});
test('frozen source drift and pre-existing output reject before candidate files are written', () => {
  const temporary = fs.mkdtempSync(path.join(ROOT, 'docs/uat-sku-workflow-20261012/.sku-v7-offline-test-'));
  try {
    const local = path.join(temporary, 'local'), output = path.join(temporary, 'candidate');
    fs.mkdirSync(local);
    for (const name of Object.keys(SOURCE_PINS)) fs.copyFileSync(path.join(ROOT, PREFIX, name), path.join(local, name));
    fs.appendFileSync(path.join(local, 'promptlab.js'), '\n// injected drift\n');
    assert.throws(() => build({ local, output }), /Frozen source SHA mismatch/);
    assert.equal(fs.existsSync(output), false);
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, 'foreign.txt'), 'preserve');
    assert.throws(() => build({ output }), /Output already exists/);
    assert.equal(fs.readFileSync(path.join(output, 'foreign.txt'), 'utf8'), 'preserve');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
test('all installed-v4 document and payload hashes still match frozen evidence after review', () => {
  for (const [name, digest] of Object.entries(V4_PINS)) assert.equal(hash(fs.readFileSync(path.join(BASE, name))), digest);
  const old = JSON.parse(fs.readFileSync(path.join(BASE, 'manifest.json'), 'utf8'));
  for (const file of old.files) assert.equal(hash(fs.readFileSync(path.join(BASE, 'overlay', file.path))), file.newSha256);
});

function ownerHarness(options = {}) {
  const counts = { reads: 0, archive: 0, renders: 0, receiptGets: 0, posts: 0 };
  const markers = new Map([
    ['receipt:owner:pending', JSON.stringify({version:1,receiptId:'original-receipt',jobId:'original-job'})],
    ['receipt:owner:legacy-one', JSON.stringify({version:1,jobId:'old-one'})],
    ['receipt:owner:legacy-two', JSON.stringify({version:1,jobId:'old-two'})]
  ]);
  const imported = {skuId:'imported-sku',url:'data:image/png;base64,aW1wb3J0',name:'keep imported title',source:'file'};
  const state = {archiveAccountKey:options.owner || 'local',archiveIdentityVersion:0,archiveRefreshToken:0,archiveChangeVersion:0,
    skuActive:false,skuMax:20,skuProducts:[imported],skuSelections:{'imported-sku':true},skuTaskStatus:{}};
  const entry = {identity:{receiptId:'original-receipt',jobId:'original-job'},snapshot:{subjectImage:'data:image/png;base64,c3ViamVjdA==',
    baseImage:'data:image/png;base64,YmFzZQ==',metadata:{skuId:'original-sku',skuCode:'SKU-1',title:'original frozen title'}}};
  const sandbox = {state,Promise,globalThis:null,
    chrome:{runtime:{id:options.runtime || 'shaozhuang-web-studio'}},LEGACY_IMAGE_RECEIPT_PREFIX:'receipt:',
    archiveAvailable:()=>false,IMAGE_ARCHIVE:null,currentLabMode:()=>options.mode || 'sku',
    refreshArchiveHistory:()=>{counts.archive++;return Promise.resolve({ok:true});},
    releaseArchiveObjectUrls:()=>{},renderArchiveHistory:()=>{},renderSkuWorkspace:()=>{counts.renders++;},
    localStorage:{get length(){return markers.size;},key:i=>[...markers.keys()][i],getItem:key=>markers.get(key)},
    SZ_SKU_DURABLE_RECEIPT:{read:async(owner,key)=>{counts.reads++;if(options.waitRead)await options.waitRead;
      return owner==='owner' && key==='receipt:owner:pending' ? entry : null;}},
    creativeWebAccountKey:()=>Promise.resolve(String(state.archiveAccountKey)),
    skuReplicaBaseImage:item=>item._skuDurableBaseImage || 'imported-base',
    ensureSkuProductIdentity:item=>item,skuTaskStatusFor:id=>state.skuTaskStatus[id] || {state:'idle'},
    fetch:()=>{counts.receiptGets++;throw Error('discovery must not query receipts');},
    sendRuntime:()=>{counts.posts++;throw Error('discovery must not submit');}
  };
  sandbox.globalThis=sandbox;
  const context=vm.createContext(sandbox);
  const declarations=['setArchiveAccountKey','restoreSkuDurableReceipts'].map(name=>findNode(review.compiled['promptlab.js'],
    node=>ts.isFunctionDeclaration(node)&&node.name?.text===name)).join('\n');
  vm.runInContext(declarations,context);
  return {context,state,markers,imported,entry,counts};
}
const flushOwner = () => new Promise(resolve=>setImmediate(resolve));

test('normal async account-ready discovery restores original task without receipt GET/POST or changing imports/legacy pointers', async () => {
  const h=ownerHarness(), before=[...h.markers];
  await h.context.setArchiveAccountKey('owner',{deferArchive:true});
  await flushOwner();
  assert.equal(h.state.archiveIdentityVersion,1);
  assert.equal(h.state.skuProducts[0],h.imported);
  assert.equal(h.imported.name,'keep imported title');
  assert.equal(h.state.skuSelections['imported-sku'],true);
  assert.equal(h.state.skuProducts.length,2);
  const restored=h.state.skuProducts[1],status=h.state.skuTaskStatus[restored.skuId];
  assert.equal(status.state,'uncertain');
  assert.equal(status._skuRecovery.jobId,'original-job');
  assert.equal(restored._skuDurableMetadata.title,'original frozen title');
  assert.deepEqual([...h.markers],before);
  assert.equal(h.counts.receiptGets+h.counts.posts,0);
  assert.equal(h.counts.renders,1);
  assert.equal(h.counts.archive,0);
});
test('same-owner refresh after initialization discovers once and keeps archive return semantics', async () => {
  const h=ownerHarness({owner:'owner'});
  const result=await h.context.setArchiveAccountKey('owner',{refresh:true});
  await flushOwner();
  assert.equal(result.ok,true);
  assert.equal(h.counts.archive,1);
  assert.equal(h.state.skuProducts.length,2);
  await h.context.setArchiveAccountKey('owner',{refresh:true});
  await flushOwner();
  assert.equal(h.counts.reads,1);
  assert.equal(h.state.skuProducts.length,2);
  assert.equal(h.counts.receiptGets+h.counts.posts,0);
});
test('owner hook is limited to logged-in website SKU surfaces', async () => {
  for(const options of [{mode:'main'},{mode:'detail'},{runtime:'extension-id'},{owner:'local'}]) {
    const h=ownerHarness(options);
    await h.context.setArchiveAccountKey(options.owner==='local'?'local':'owner',{refresh:true});
    await flushOwner();
    assert.equal(h.counts.reads,0);
    assert.equal(h.state.skuProducts.length,1);
    assert.equal(h.counts.receiptGets+h.counts.posts,0);
  }
});
test('account switch during original discovery cannot attach the old owner task or erase existing imports/old markers', async () => {
  let release;const waitRead=new Promise(resolve=>{release=resolve;});
  const h=ownerHarness({waitRead}),before=[...h.markers];
  await h.context.setArchiveAccountKey('owner',{deferArchive:true});
  await flushOwner();
  await h.context.setArchiveAccountKey('another-owner',{deferArchive:true});
  release();await flushOwner();
  assert.equal(h.state.archiveAccountKey,'another-owner');
  assert.equal(h.state.archiveIdentityVersion,2);
  assert.equal(h.state.skuProducts.length,1);
  assert.equal(h.state.skuProducts[0],h.imported);
  assert.deepEqual([...h.markers],before);
  assert.equal(Object.keys(h.state.skuTaskStatus).length,0);
  assert.equal(h.counts.receiptGets+h.counts.posts,0);
});
test('frozen-v5 payloads remain unchanged and v7 differs only by owner/recovery functions and HTML cache references', () => {
  const {V5_PINS,stripOwnerHook}=require('./prepare-sku-durable-production-overlay-v7.cjs');
  const v5=path.join(ROOT,'docs/uat-sku-workflow-20261012/production-overlay-v5');
  for(const [name,digest] of Object.entries(V5_PINS))assert.equal(hash(fs.readFileSync(path.join(v5,name))),digest);
  const manifest=JSON.parse(fs.readFileSync(path.join(v5,'manifest.json'),'utf8'));
  for(const file of manifest.inventory) {
    const old=fs.readFileSync(path.join(v5,'overlay',file.path),'utf8');
    assert.equal(hash(old),file.newSha256);
    if(file.file==='promptlab.js') {
      const owner=text=>findNode(text,node=>ts.isFunctionDeclaration(node)&&node.name?.text==='setArchiveAccountKey');
      assert.equal(stripOwnerHook(owner(review.compiled[file.file])),owner(old));
      const settings=text=>findNode(text,node=>ts.isFunctionDeclaration(node)&&node.name?.text==='skuSettingsFromDurableEntry');
      assert.equal(old.replace(owner(old),owner(review.compiled[file.file])).replace(settings(old),settings(review.compiled[file.file])),review.compiled[file.file]);
    } else if(file.file==='promptlab.html') assert.equal(old.replaceAll('20261013-sku-durable-v5','20261013-sku-durable-v7'),review.compiled[file.file]);
    else assert.equal(old,review.compiled[file.file]);
  }
});
test('checkout preserves every pre-existing byte outside authorized owner hook and tuple recovery including counter omission', () => {
  const {stripOwnerHook}=require('./prepare-sku-durable-production-overlay-v7.cjs');
  const source=fs.readFileSync(path.join(ROOT,PREFIX,'promptlab.js'),'utf8');
  const owner=findNode(source,node=>ts.isFunctionDeclaration(node)&&node.name?.text==='setArchiveAccountKey');
  assert.equal(owner.includes('state.archiveIdentityVersion++'),false);
  const settings=text=>findNode(text,node=>ts.isFunctionDeclaration(node)&&node.name?.text==='skuSettingsFromDurableEntry');
  const frozenV6=fs.readFileSync(path.join(ROOT,'docs/uat-sku-workflow-20261012/production-overlay-v6/overlay',PREFIX,'promptlab.js'),'utf8');
  const original=source.replace(owner,stripOwnerHook(owner)).replace(settings(source),settings(frozenV6));
  assert.equal(hash(original),'00fcbb29fc88d7d2d4bb4bd94f027f3106c44697f3762d4df2c7f8b0c32c7064');
  const packedOwner=findNode(review.compiled['promptlab.js'],node=>ts.isFunctionDeclaration(node)&&node.name?.text==='setArchiveAccountKey');
  assert.equal(packedOwner.includes('state.archiveIdentityVersion++'),true);
  assert.equal(review.audit.promptlab.ownerReadyHook.checkoutCounterOmissionPreserved,true);
  assert.equal(review.audit.promptlab.ownerReadyHook.publishedCounterPreserved,true);
});
function tupleHarness(candidate=review.compiled['promptlab.js']) {
  const globals=['SKU_OUTPUT_MIN_EDGE','SKU_OUTPUT_MAX_EDGE','SKU_OUTPUT_MAX_PIXELS','SKU_PRESET_RATIOS','SKU_PRESET_BASE_SIZES'];
  const functions=['skuSizeParts','skuGreatestCommonDivisor','skuRatioFromDimensions','skuPresetSize','skuCustomSizeValidation',
    'skuOutputSizeValidation','skuProviderSpecForOutput','skuSettingsFromDurableEntry'];
  const text=globals.map(name=>findNode(candidate,node=>ts.isVariableStatement(node)&&
    node.declarationList.declarations.some(declaration=>ts.isIdentifier(declaration.name)&&declaration.name.text===name))).join('\n')+'\n'+
    functions.map(name=>findNode(candidate,node=>ts.isFunctionDeclaration(node)&&node.name?.text===name)).join('\n');
  const context=vm.createContext({cloneGuideValue:value=>structuredClone(value),freezeSkuVisualContract:value=>value});
  vm.runInContext(text,context);
  return context;
}
const actualArchive=require('../public/creative/labs/image-prompt-lab/image-archive-store.js');
function archiveIdentity(settings) {
  return {surfaceMode:'sku',ratio:settings.outputRatio,resolution:settings.outputResolution,
    outputSize:settings.outputSize,outputWidth:settings.outputWidth,outputHeight:settings.outputHeight,
    providerSize:settings.modelSize,providerRatio:settings.modelRatio,providerResolution:settings.modelResolution};
}
function tupleEntry(output,requested) {
  return {identity:{batchId:'original-batch'},snapshot:{output:JSON.parse(JSON.stringify(output)),
    geometry:{requestedSize:requested},baseImage:'original-base',subjectImage:'original-subject',model:{imageAdapter:'openai-images'},
    contract:{contractFingerprint:'original-contract',subject:{authorizedRegion:{x:0.1,y:0.2,w:0.5,h:0.5}}},metadata:{},prompt:'original-prompt'}};
}
test('actual archive sanitizer rejects v6 custom recovery and accepts canonical v7 frozen provider tuple', () => {
  const old=tupleHarness(fs.readFileSync(path.join(ROOT,'docs/uat-sku-workflow-20261012/production-overlay-v6/overlay',PREFIX,'promptlab.js'),'utf8'));
  const current=tupleHarness(),output=current.skuOutputSizeValidation({resolution:'custom',width:1000,height:1000});
  const entry=tupleEntry(output,'1024*1024'),before=JSON.stringify(entry);
  assert.equal(actualArchive.sanitizeSkuOutputIdentity(archiveIdentity(old.skuSettingsFromDurableEntry(entry))),null);
  const settings=current.skuSettingsFromDurableEntry(entry);
  assert.equal(settings.modelResolution,'1K');assert.equal(settings.modelRatio,'1:1');
  assert.equal(settings.modelWidth,1024);assert.equal(settings.modelHeight,1024);
  assert.equal(settings.outputSize,'1000*1000');assert.equal(settings.outputResolution,'custom');
  assert.ok(actualArchive.sanitizeSkuOutputIdentity(archiveIdentity(settings)));
  assert.equal(JSON.stringify(entry),before);
});
test('rectangular/custom/preset provider tuples survive actual archive validation using only frozen settings', () => {
  const context=tupleHarness();
  for(const options of [{resolution:'custom',width:1000,height:1500},{resolution:'custom',width:3600,height:3600},
    {resolution:'1K',ratio:'21:9'},{resolution:'2K',ratio:'21:9'},{resolution:'4K',ratio:'9:16'}]) {
    const output=context.skuOutputSizeValidation(options),provider=context.skuProviderSpecForOutput(output);
    const entry=tupleEntry(output,provider.size),before=JSON.stringify(entry),settings=context.skuSettingsFromDurableEntry(entry);
    assert.ok(actualArchive.sanitizeSkuOutputIdentity(archiveIdentity(settings)),JSON.stringify(options));
    assert.equal(settings.modelSize,entry.snapshot.geometry.requestedSize);
    assert.equal(settings.modelWidth+'*'+settings.modelHeight,provider.size);
    assert.equal(JSON.stringify(entry),before);
  }
});
test('mismatched frozen requested geometry or output metadata rejects before processing without changing receipt', () => {
  const context=tupleHarness(),output=context.skuOutputSizeValidation({resolution:'custom',width:1000,height:1000});
  for(const mutate of [entry=>{entry.snapshot.geometry.requestedSize='1536*1024';},entry=>{entry.snapshot.output.width=1200;}]) {
    const entry=tupleEntry(output,'1024*1024');mutate(entry);const before=JSON.stringify(entry);
    assert.throws(()=>context.skuSettingsFromDurableEntry(entry),error=>error.code==='SKU_RECEIPT_GEOMETRY_INVALID');
    assert.equal(JSON.stringify(entry),before);
  }
});
test('v7 preserves frozen-v6 bytes outside one recovery settings function and HTML cache references', () => {
  const {V6_PINS}=require('./prepare-sku-durable-production-overlay-v7.cjs');
  const v6=path.join(ROOT,'docs/uat-sku-workflow-20261012/production-overlay-v6');
  for(const [name,digest] of Object.entries(V6_PINS))assert.equal(hash(fs.readFileSync(path.join(v6,name))),digest);
  const manifest=JSON.parse(fs.readFileSync(path.join(v6,'manifest.json'),'utf8'));
  for(const file of manifest.inventory) {
    const old=fs.readFileSync(path.join(v6,'overlay',file.path),'utf8');assert.equal(hash(old),file.newSha256);
    if(file.file==='promptlab.js') {
      const settings=text=>findNode(text,node=>ts.isFunctionDeclaration(node)&&node.name?.text==='skuSettingsFromDurableEntry');
      assert.equal(old.replace(settings(old),settings(review.compiled[file.file])),review.compiled[file.file]);
    } else if(file.file==='promptlab.html')assert.equal(old.replaceAll('20261013-sku-durable-v6','20261013-sku-durable-v7'),review.compiled[file.file]);
    else assert.equal(old,review.compiled[file.file]);
  }
});
