/* Product-first workspace. All model requests continue through the account-scoped website bridge. */
(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  if (params.get('studio') !== '1') return;
  const isBatch = params.get('batch') === '1';
  const mode = params.get('mode') === 'detail' ? 'detail' : 'main';
  const initialAd = params.get('type') === 'ad';
  const icons = {
    spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/><path d="m20 2 .8 2.2L23 5l-2.2.8L20 8l-.8-2.2L17 5l2.2-.8Z"/>',
    image:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m4 18 5-5 4 3 4-6 4 5"/>',
    upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
    history:'<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v5l3 2"/>',
    plus:'<path d="M12 5v14M5 12h14"/>', settings:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.spark}</svg>`;
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const uid = () => crypto.randomUUID();
  let root, bridge, engine, controller, draft, workspaceBinding, account, database, apiChoices = [], modelInfo = {}, notice = '', noticeError = false;
  let busy = false, analyzing = false, uploading = false, saveTimer, saveQueue = Promise.resolve(), saveFault = false, restoring = false, initializing = true;
  const draftStorageTimeoutMs = 15 * 1000;
  let saveError = '';
  let startupFailed = false, receiptRecovery = null, bound = false;
  let pendingRender = null, taskElapsedTimer = null, lastTaskAnnouncement = '', previewReturnFocus = null;
  let deactivating = false, deactivationPromise = null;
  let moduleTab = 'official', moduleGroup = '', managingModules = false, selectedResults = new Set(), showPlan = true, briefCandidate = '';
  const displayedPlanChecks = new WeakMap();
  const retainedWorkspaces = new Set();
  const localOriginals = new Map(), displayFrame = window.frameElement;
  let displayRenderVersion = 0;
  const environment = window.__SANJIE_ENVIRONMENT ? `:${window.__SANJIE_ENVIRONMENT}` : '';
  const task = index => ({ id:uid(), name:`商品任务 ${index}`, requirements:'', products:[], overrides:null, plan:null, confirmed:false, collapsed:false });
  function current() { return controller ? controller.state : { tasks:[],previousResults:[],busy:false,uncertain:null }; }
  function workspaceBusy() {
    const state=current();
    const archiving=(state.tasks||[]).some(entry=>(entry.slots||[]).some(slot=>slot?.archiveSaving))||(state.previousResults||[]).some(slot=>slot?.archiveSaving);
    return (initializing||restoring)&&!startupFailed || busy || analyzing || uploading || !!receiptRecovery || window.SZ_IMAGE_UPLOAD?.isImporting?.() || state.busy || archiving;
  }
  function generationLocked() { return workspaceBusy() || deactivating; }
  function navigationLocked() { return workspaceBusy(); }
  function retainedUnsaved(binding) { return binding.saveFault||(binding.controller.state.tasks||[]).some(entry=>(entry.slots||[]).some(slot=>slot.archiveSaving||slot.item&&slot.archiveOk===false)); }
  function unloadLocked() { return navigationLocked() || !!current().awaitingReceipt || !!controller?.hasInFlightRequest?.() || [...retainedWorkspaces].some(binding=>binding.controller.hasInFlightRequest?.()||retainedUnsaved(binding)); }
  function locked() { return navigationLocked() || deactivating; }
  window.SanjieStudioGenesisBridge = {
    getTaskState,
    async activate() {
      if(startupFailed)return {ok:false,error:'创作工作台暂未就绪，请重试读取。'};
      if(initializing||!bridge||!account)return {ok:false,error:'创作工作台正在读取，请稍后再切换。'};
      try { await ensureAccount();return {ok:true}; }
      catch(error) { return {ok:false,error:error.message||'登录账号已变化，请重新打开工作台。'}; }
    },
    async canDeactivate() {
      if(deactivationPromise)return deactivationPromise;
      const activeReason='当前创作任务正在处理，请等待完成或停止后续生成，再切换入口。';
      if([...retainedWorkspaces].some(retainedUnsaved))return {allowed:false,reason:'历史任务的原件或草稿尚未保存，请在任务进度中恢复该项目并补存；其他工作台可继续使用。'};
      if(unloadLocked())return {allowed:false,reason:activeReason};
      // Failed startup never exposes editing. Keep its original stored draft
      // intact instead of persisting a partly restored workspace on the way out.
      if(startupFailed)return {allowed:true};
      if(!draft||!controller||!bridge)return {allowed:false,reason:'创作工作台尚未就绪，请稍后再切换入口。'};
      // A pending receipt protects only its original image. An idle workspace can
      // be left once the full draft and receipts reach account-scoped storage.
      // Freeze new mutations while saving; check activity and ownership again
      // after the asynchronous write before the host removes this iframe.
      deactivating=true;if(!startupFailed)render();
      deactivationPromise=(async()=>{
        try {
          const snapshot=controller.snapshot();
          if(snapshot.accountKey&&String(snapshot.accountKey)!==account)throw new Error('任务所属账号与草稿不一致，已停止保存。');
          const savedState=JSON.stringify({draft,snapshot});
          await persist();await ensureAccount();
          if(unloadLocked())return {allowed:false,reason:activeReason};
          if(JSON.stringify({draft,snapshot:controller.snapshot()})!==savedState){saveFault=true;return {allowed:false,reason:'草稿在保存期间发生变化，请稍后再切换入口。'};}
          return {allowed:true};
        } catch(error) {
          saveFault=true;showError(error);return {allowed:false,reason:error.message||'当前草稿保存失败，请先检查浏览器存储空间。'};
        } finally { deactivating=false;deactivationPromise=null;if(!startupFailed)render(); }
      })();
      return deactivationPromise;
    }
  };
  async function ensureAccount() {
    const identity = await bridge.getAccountKey();
    if (String(identity) !== account) throw new Error('登录账号已变化，请重新打开工作台；原账号素材仍保留。');
  }
  async function openDB() {
    if (database) return database;
    database = await new Promise((resolve,reject) => {
      const request = indexedDB.open(`sz_studio_genesis_v1${environment}`,1);
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        try { request.transaction?.abort(); } catch (_) {}
        reject(new Error('本机草稿库打开超时，请稍后重试。'));
      },draftStorageTimeoutMs);
      request.onupgradeneeded = () => { if(expired){try { request.transaction?.abort(); } catch (_) {} return;}request.result.createObjectStore('drafts'); };
      request.onsuccess = () => {
        if(expired){try { request.result.close(); } catch (_) {} return;}
        clearTimeout(timer);resolve(request.result);
      };
      request.onerror = () => { clearTimeout(timer);if(!expired)reject(request.error || new Error('无法打开本机草稿库。')); };
    });
    return database;
  }
  async function draftTransaction(mode,operation) {
    const db = await openDB();
    return new Promise((resolve,reject) => {
      let transaction, settled = false;
      const finish = (error,value) => { if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value); };
      const timer = setTimeout(() => {
        if(settled)return;
        settled=true;
        // Abort before releasing the save queue so a timed out write cannot
        // commit an older snapshot after a later successful save.
        try { transaction?.abort(); } catch (_) {}
        if(database===db)database=null;
        try { db.close(); } catch (_) {}
        reject(new Error(`本机草稿${mode==='readwrite'?'保存':'读取'}超时，请稍后重试。`));
      },draftStorageTimeoutMs);
      try {
        transaction=mode==='readwrite'?db.transaction('drafts',mode):db.transaction('drafts');
        transaction.onerror=()=>finish(transaction.error || new Error('本机草稿事务失败。'));
        transaction.onabort=()=>finish(transaction.error || new Error('本机草稿事务已取消。'));
        if(mode==='readwrite')transaction.oncomplete=()=>finish();
        operation(transaction.objectStore('drafts'),finish,transaction);
      } catch(error) { finish(error); }
    });
  }
  async function dbGet(key) {
    return draftTransaction('readonly',(store,finish)=>{const request=store.get(key);request.onsuccess=()=>finish(null,request.result);request.onerror=()=>finish(request.error || new Error('本机草稿读取失败。'));});
  }
  function draftToken(value) {
    if(value==null)return 'missing';
    if(typeof value.revision==='string'&&value.revision)return `revision:${value.revision}`;
    // Legacy drafts have no revision. Compare their entire stable JSON so two
    // tabs that loaded the same old record cannot both replace it unnoticed.
    return `legacy:${JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.keys(item).sort().reduce((sorted,key)=>(sorted[key]=item[key],sorted),{}):item)}`;
  }
  async function dbPut(key,value,expectedToken='missing') {
    const saved={...value,revision:uid()};
    await draftTransaction('readwrite',(store,finish,transaction)=>{
      const request=store.get(key);
      request.onerror=()=>finish(request.error || new Error('本机草稿读取失败。'));
      request.onsuccess=()=>{
        try {
          if(draftToken(request.result)!==expectedToken)throw Object.assign(new Error('其他页面已更新这份草稿，当前页面已停止保存和生成。请保留当前页面并重新打开工作台读取最新任务；原任务回执仍保留。'),{code:'STUDIO_DRAFT_CONFLICT'});
          store.put(saved,key);
        } catch(error) {finish(error);try{transaction.abort();}catch(_){}}
      };
    });
    // Only advance the expected revision after the transaction commits.
    return draftToken(saved);
  }
  async function installRecoveredDraft(key,recoveryKey,original,next) {
    let installed;
    await draftTransaction('readwrite',(store,finish)=>{
      const request=store.get(recoveryKey);
      request.onerror=()=>finish(request.error||new Error('恢复草稿读取失败，请重试。'));
      request.onsuccess=()=>{
        if(request.result){installed=request.result;return;}
        const source=store.get(key);
        source.onerror=()=>finish(source.error||new Error('原草稿读取失败，请重试。'));
        source.onsuccess=()=>{
          if(JSON.stringify(source.result)!==JSON.stringify(original)){finish(new Error('原草稿已在其他页面更新，请重试读取。'));return;}
          installed={...next,revision:uid()};store.put(installed,recoveryKey);
        };
      };
    });
    return installed;
  }
  const scopeFor = type => `${isBatch?'batch':'single'}:${type==='detail'?'detail':'main'}${type==='ad'?':ad':''}`;
  let workspaceScope = scopeFor(initialAd?'ad':mode);
  const draftKey = (scope=workspaceScope) => `${account}:${scope}`;
  const workspaceType = settings => settings.imageType==='ad'?'ad':settings.mode==='detail'?'detail':'main';
  function journal(scope=workspaceScope) {
    const legacyKey = `sz_studio_genesis_pending_v1${environment}:${account}`;
    const prefix = `sz_studio_genesis_pending_v2${environment}:${account}:${scope}:`;
    function validate(raw) {
      let value;
      try { value=JSON.parse(raw); } catch (_) { throw new Error('本机任务回执无法读取，请核对已有请求。'); }
      if(!value||typeof value.taskId!=='string'||!value.taskId.trim()||typeof value.shotId!=='string'||!value.shotId.trim()||value.accountKey!==account||value.createdAt!==undefined&&(!Number.isFinite(value.createdAt)||value.createdAt<=0)||value.jobId!==undefined&&(typeof value.jobId!=='string'||!value.jobId.trim()))throw new Error('本机任务回执内容损坏或所属账号不一致，请核对已有请求。');
      return value;
    }
    function read(excluded=[]) {
      try {
      const legacy=localStorage.getItem(legacyKey);
      if(legacy!==null)return validate(legacy);
      for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key?.startsWith(prefix)&&!excluded.includes(key.slice(prefix.length)))return validate(localStorage.getItem(key));}
      return null;
      } catch(error) { if(/回执/.test(error.message))throw error;throw new Error('本机任务回执无法读取，请保留草稿并核对已有请求。'); }
    }
    function readAll() {
      try {
        const values=[], legacy=localStorage.getItem(legacyKey);
        if(legacy!==null)values.push(validate(legacy));
        for(let i=0;i<localStorage.length;i++){
          const key=localStorage.key(i);
          if(key?.startsWith(prefix))values.push(validate(localStorage.getItem(key)));
        }
        return values.filter((value,index)=>!values.slice(0,index).some(known=>['jobId','accountKey','taskId','shotId','batchId'].every(field=>known[field]===value[field])));
      } catch(error) { if(/回执/.test(error.message))throw error;throw new Error('本机任务回执无法读取，请保留草稿并重新打开工作台。'); }
    }
    function compareAndClear(receipt) {
      const ownedKey=prefix+receipt.jobId, key=localStorage.getItem(ownedKey)!==null?ownedKey:legacyKey;
      const raw=localStorage.getItem(key);if(raw===null)return false;
      const saved=validate(raw);
      if(!['jobId','accountKey','taskId','shotId','batchId'].every(field=>saved[field]===receipt[field]))return false;
      localStorage.removeItem(key);return true;
    }
    return {concurrent:true,read,readAll,readExcluding:read,readReceipt:receipt=>{const raw=localStorage.getItem(prefix+receipt.jobId)??localStorage.getItem(legacyKey);return raw===null?null:validate(raw);},write:value=>localStorage.setItem(prefix+value.jobId,JSON.stringify(value)),compareAndClear,clear:()=>{const pending=read();if(pending)compareAndClear(pending);}};
  }
  function createWorkspace(nextDraft,scope,storageKey=draftKey(scope),legacy=null,expectedDraftToken='missing') {
    const binding={draft:nextDraft,scope,storageKey,legacy,legacyBackupKey:nextDraft.legacyBackupKey,controller:null,restoring:true,expectedDraftToken};
    binding.controller=engine.createController({bridge,journal:journal(scope),concurrency:100,workspaceKey:scope,withGenerationSlot,async onChange(){
      if(binding.restoring)return;
      if(workspaceBinding===binding)scheduleRender();
      else if(retainedWorkspaces.has(binding))scheduleRender(false);
      await persist({fromController:true,source:binding});
    }});
    return binding;
  }
  function installWorkspace(binding) {
    if(workspaceBinding!==binding)releaseLocalOriginals();
    workspaceBinding=binding;workspaceScope=binding.scope;draft=binding.draft;controller=binding.controller;
    saveFault=!!binding.saveFault;saveError=binding.saveError||'';
  }
  function validateWorkspace(saved,type) {
    if(saved.snapshot?.accountKey&&saved.snapshot.accountKey!==account)throw new Error('该图片类型的草稿属于其他账号，原草稿仍保留。');
    if(!saved?.draft||!Array.isArray(saved.draft.tasks)||workspaceType(saved.draft.settings||{})!==type)throw new Error('该图片类型的草稿内容不一致，原草稿仍保留，请先核对本机任务。');
    if(saved.snapshot?.tasks?.some(entry=>workspaceType(entry.plan?.settings||{})!==type))throw new Error('该图片类型的旧任务含有其他图片类型，原任务和回执仍保留，请先核对。');
  }
  const typeLabel = type => ({main:'主图',detail:'详情图',ad:'广告图'})[type];
  async function loadWorkspace(type,scope,beforeWrite) {
    const key=draftKey(scope),recoveryKey=`${key}:type-recovery-v1`;
    const recovered=await dbGet(recoveryKey);await ensureAccount();
    if(recovered){
      validateWorkspace(recovered,type);
      const backupKey=recovered.draft.legacyBackupKey;
      if(typeof backupKey!=='string'||!backupKey.startsWith(`${key}:before-explicit-mode:`))throw new Error('保留的旧任务位置暂不能核对，请重试读取。');
      const legacy=await dbGet(backupKey);await ensureAccount();
      if(!legacy?.draft||legacy.snapshot?.accountKey&&legacy.snapshot.accountKey!==account)throw new Error('保留的旧任务暂不能读取，请重试；原数据仍保留。');
      return {saved:recovered,storageKey:recoveryKey,legacy};
    }
    const saved=await dbGet(key);await ensureAccount();
    if(!saved)return {saved:null,storageKey:key,legacy:null};
    if(!saved.draft||!Array.isArray(saved.draft.tasks)||saved.snapshot?.accountKey&&saved.snapshot.accountKey!==account){validateWorkspace(saved,type);}
    const mixed=workspaceType(saved.draft.settings||{})!==type||saved.snapshot?.tasks?.some(entry=>workspaceType(entry.plan?.settings||{})!==type);
    if(!mixed){validateWorkspace(saved,type);return {saved,storageKey:key,legacy:null};}
    // Old versions saved all three types under the entry URL's fixed key.
    // Keep the complete record and its original receipt scope. Fresh task IDs
    // ensure that editable inputs cannot retry or impersonate an old request.
    if(beforeWrite)await beforeWrite;
    const backupKey=`${key}:before-explicit-mode:${uid()}`;
    await dbPut(backupKey,saved);await ensureAccount();
    const defaults=engine.defaults(type==='detail'?'detail':'main');
    const oldSettings=workspaceType(saved.draft.settings||{})===type?saved.draft.settings:saved.draft.typeSettings?.[type];
    const config=oldSettings&&workspaceType(oldSettings)===type?clone(oldSettings):{...defaults,model:saved.draft.settings?.model||''};
    config.mode=type==='detail'?'detail':'main';config.imageType=type==='ad'?'ad':'main';
    if(type==='ad'){config.adTemplate=config.adTemplate||engine.adTemplates?.[0]?.id;config.adType=config.adType||'电商广告';}
    const tasks=saved.draft.tasks.map((entry,index)=>{
      const old=workspaceType(saved.draft.settings||{})===type?entry:entry.typeDrafts?.[type];
      const overrides=old?.overrides?{...clone(old.overrides),mode:config.mode,imageType:config.imageType}:null;
      return {...task(index+1),name:entry.name||`商品任务 ${index+1}`,products:clone(entry.products||[]),requirements:old?.requirements||'',analysis:old?.analysis||'',overrides};
    });
    const next={draft:{settings:config,tasks:tasks.length?tasks:[task(1)],legacyBackupKey:backupKey,viewStep:0,userModules:clone(saved.draft.userModules||[]),userModuleGroups:clone(saved.draft.userModuleGroups||[])},savedAt:new Date().toISOString()};
    // Saving the separate recovery row makes reload/switching deterministic;
    // neither the original canonical record nor its receipt journal is changed.
    const installed=await installRecoveredDraft(key,recoveryKey,saved,next);await ensureAccount();
    validateWorkspace(installed,type);
    if(typeof installed.draft.legacyBackupKey!=='string'||!installed.draft.legacyBackupKey.startsWith(`${key}:before-explicit-mode:`))throw new Error('保留的旧任务位置暂不能核对，请重试读取。');
    const retained=installed.draft.legacyBackupKey===backupKey?saved:await dbGet(installed.draft.legacyBackupKey);await ensureAccount();
    if(!retained?.draft||retained.snapshot?.accountKey&&retained.snapshot.accountKey!==account)throw new Error('保留的旧任务暂不能核对，请重试读取。');
    return {saved:installed,storageKey:recoveryKey,legacy:retained};
  }
  function legacyBanner() {
    if(!workspaceBinding?.legacy)return '';
    return `<section class="sg-card" role="status"><strong>已保留旧版混合草稿</strong><p class="sg-note">产品图和当前${typeLabel(workspaceType(draft.settings))}的输入已恢复。旧方案、生成成果和待确认请求完整保留；请重新整理并核对当前类型的方案。</p><button type="button" class="sg-button" data-action="legacy-tasks">查看保留的旧任务</button></section>`;
  }
  function showLegacyTasks() {
    const saved=workspaceBinding?.legacy;if(!saved)return;
    const slots=[...(saved.snapshot?.tasks||[]).flatMap(entry=>entry.slots||[]),...(saved.snapshot?.previousResults||[])];
    const unfinished=slots.filter(slot=>!slot.item&&['generating','uncertain'].includes(slot.status)).length;
    const content=`<p class="sg-note">以下为保留的原草稿和任务记录。待确认请求继续保留原身份，不会自动重新提交。若旧图片预览暂不可用，可在生成记录中查看已归档原件。</p><button type="button" class="sg-button" data-action="history">打开生成记录</button>${(saved.draft.tasks||[]).map(entry=>`<section class="sg-card"><h3>${esc(entry.name||'商品任务')}</h3><p>${esc(entry.requirements||'未填写创作要求')}</p>${(entry.products||[]).filter(asset=>engine.validImage(asset.image)).map(asset=>`<img src="${esc(asset.image)}" alt="${esc(asset.name||'原产品图')}" style="max-width:160px;max-height:200px">`).join('')}</section>`).join('')}<p>${slots.filter(slot=>slot.item).length} 张已有成果 · ${unfinished||saved.snapshot?.uncertain?Math.max(unfinished,1):0} 张结果待确认</p>${slots.filter(slot=>slot.item&&engine.validImage(slot.item.url)).map(slot=>`<figure><img src="${esc(slot.item.url)}" alt="${esc(slot.shot?.label||'原生成成果')}" style="max-width:240px;max-height:280px"><figcaption>${esc(slot.shot?.label||'原生成成果')}</figcaption></figure>`).join('')}`;
    openDialog('保留的旧任务',content);
  }
  async function switchWorkspace(next) {
    if(!['main','detail','ad'].includes(next)||next===workspaceType(draft.settings)||locked())return;
    busy=true;render();
    const previous=workspaceBinding;
    try {
      // Saving this type and reading the next type use different keys, so the
      // reads overlap the save; each chain keeps its identity checks and order.
      // Target migration writes wait behind the save, and a failed save is
      // reported at once: the abandoned read can neither write nor install.
      const scope=scopeFor(next),saving=persist().then(()=>ensureAccount()),reading=loadWorkspace(next,scope,saving);
      reading.catch(()=>{});
      await saving;
      const loaded=await reading,saved=loaded.saved;await ensureAccount();
      let nextDraft;
      if(saved){validateWorkspace(saved,next);nextDraft=clone(saved.draft);}
      else {
        const cfg={...engine.defaults(next==='detail'?'detail':'main'),model:draft.settings.model,imageType:next==='ad'?'ad':'main',expertMode:false};
        if(next==='ad'){cfg.adTemplate=engine.adTemplates?.[0]?.id;cfg.adType='电商广告';}
        nextDraft={settings:cfg,tasks:draft.tasks.map((entry,index)=>({...task(index+1),name:entry.name,products:clone(entry.products)}))};
      }
      nextDraft.userModules=clone(library());nextDraft.userModuleGroups=clone(groups());
      const retained=[...retainedWorkspaces].find(value=>value.scope===scope&&value.storageKey===loaded.storageKey&&value.expectedDraftToken===draftToken(saved));
      const binding=retained||createWorkspace(nextDraft,scope,loaded.storageKey,loaded.legacy,draftToken(saved));
      if(!retained){
        if(saved?.snapshot){const result=await binding.controller.restore(saved.snapshot);if(!result?.ok)throw new Error(result?.error||'该图片类型的草稿暂不能安全恢复，原草稿仍保留。');}
        const recovered=await binding.controller.recoverPendingReceipt();
        if(!recovered?.ok)throw new Error(recovered?.error||'该图片类型的回执暂不能安全恢复，原回执仍保留。');
      }
      await ensureAccount();
      if(previous.controller.state.busy)throw new Error('原图片类型正在保存任务，请稍后再切换。');
      retainedWorkspaces.add(previous);retainedWorkspaces.delete(binding);
      binding.restoring=false;installWorkspace(binding);
      moduleTab='official';moduleGroup='';selectedResults.clear();showPlan=true;
      await persist();
    } catch(error) {if(workspaceBinding!==previous)retainedWorkspaces.add(workspaceBinding);retainedWorkspaces.delete(previous);installWorkspace(previous);throw error;}
    finally {busy=false;render();}
  }
  // Shared browser slots cap all studio surfaces at 100 live provider requests.
  function stopQueuedSubmissions() {
    const pacer=window.SZCreativeRequestPacer;
    if(!pacer||pacer.version!==1||typeof pacer.cancelQueued!=='function'||current().accountKey!==account)return;
    for(const task of current().tasks||[])for(const slot of task.slots||[]) {
      const r=slot.pendingReceipt;
      if(slot.status!=='generating'||!r||r.receiptVersion!==1||r.accountKey!==account||r.workspaceKey!==workspaceScope||r.taskId!==task.id||r.shotId!==slot.shot.id)continue;
      pacer.cancelQueued({version:1,receiptId:r.receiptId,jobId:r.jobId,accountKey:r.accountKey,workspaceKey:r.workspaceKey,taskId:r.taskId,shotId:r.shotId,batchId:r.batchId,planSignatureHash:r.planSignatureHash});
    }
  }
  async function withGenerationSlot(owner,send,cancelled) {
    const locks=navigator.locks,prefix=`sz-studio-image-slot${environment}:${owner}:`;
    const notSubmitted=()=>({ok:false,definitiveFailure:true,providerSubmitted:false,error:'已停止排队，尚未提交此图。'});
    // This catch owns only the account check before send, never the provider reply.
    const runInSlot=async()=>{
      if(cancelled())return notSubmitted();
      try {await ensureAccount();} catch(error) {return {ok:false,definitiveFailure:true,providerSubmitted:false,error:error?.message||'登录状态暂不能核对，本图尚未提交。'};}
      if(cancelled())return notSubmitted();
      return send();
    };
    let useQuery=typeof locks.query==='function';
    for(;;){
      if(cancelled())return notSubmitted();
      if(useQuery){
        let admission;
        try {admission=await locks.request(`sz-studio-image-admission${environment}:${owner}`,async()=>{
          if(cancelled())return {cancelled:true};
          let snapshot,timer;
          try {snapshot=await Promise.race([locks.query(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('slot query timeout')),250);})]);}
          catch(_){return {fallback:true};}finally{clearTimeout(timer);}
          if(!snapshot||!Array.isArray(snapshot.held)||snapshot.held.some(lock=>!lock||typeof lock.name!=='string'))return {fallback:true};
          const held=new Set(snapshot.held.map(lock=>lock.name));let index=0;
          while(index<100&&held.has(prefix+index))index++;
          if(index===100)return {wait:true};
          let notify;const handshake=new Promise(resolve=>{notify=resolve;});
          const reply=locks.request(prefix+index,{ifAvailable:true},async lock=>{
            notify(!!lock);if(!lock)return;
            return runInSlot();
          });
          // Handshake ends the FIFO gate once the native slot is held. The slot
          // and its provider promise remain attached until the original settles.
          reply.catch(()=>notify(false));
          return await handshake?{reply}:{fallback:true};
        });} catch(_){admission={fallback:true};}
        if(admission.cancelled)return notSubmitted();
        if(admission.reply)return admission.reply;
        if(admission.fallback)useQuery=false;
        else {if(admission.wait)await new Promise(resolve=>setTimeout(resolve,100));continue;}
      }
      // Older Web Locks implementations keep the existing conservative scan.
      for(let index=0;index<100;index++){
        let acquired=false;
        const result=await locks.request(prefix+index,{ifAvailable:true},async lock=>{
          if(!lock)return;
          acquired=true;return runInSlot();
        });
        if(acquired)return result;
      }
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }
  async function persist({fromController=false,source}={}) {
    clearTimeout(saveTimer);
    const owner=source||workspaceBinding;
    if (startupFailed || !owner?.draft || owner.restoring || owner===workspaceBinding&&restoring) return;
    if(fromController&&(owner===workspaceBinding?saveFault:owner.saveFault))throw new Error(owner.saveError || saveError || '本机草稿尚未保存，请稍后重试。');
    if(!fromController)await ensureAccount();
    if(startupFailed)return;
    const snapshot=owner.controller.snapshot();
    if(fromController&&snapshot.accountKey&&snapshot.accountKey!==account)throw new Error('任务所属账号与草稿不一致，已停止保存。');
    const value={draft:clone(owner.draft),snapshot,savedAt:new Date().toISOString()};
    if(owner.legacyBackupKey)value.draft.legacyBackupKey=owner.legacyBackupKey;
    saveQueue=saveQueue.catch(()=>{}).then(async()=>{
      if(startupFailed)return;
      // A failed transaction applies to callbacks already queued in this run.
      // A later user action may retry storage through ordinary persist().
      if(fromController&&(owner===workspaceBinding?saveFault:owner.saveFault))throw new Error(owner.saveError || saveError || '本机草稿尚未保存，请稍后重试。');
      // An archived project may still receive its original reply. Resolve its
      // storage destination inside the queue, after the project move commits.
      const key=owner.storageKey||draftKey(owner.scope);
      owner.expectedDraftToken=await dbPut(key,value,owner.expectedDraftToken);
    });
    try { await saveQueue;owner.saveFault=false;owner.saveError='';if(owner===workspaceBinding){saveFault=false;saveError='';const label=root.querySelector('[data-save-state]');if(label)label.textContent='草稿已保存';} }
    catch (error) { const detail=error.code==='STUDIO_DRAFT_CONFLICT'||error.message?.startsWith('本机草稿未保存：')?error.message:`本机草稿未保存：${error.message||error}。请检查浏览器存储空间。`;owner.saveFault=true;owner.saveError=detail;const failure=Object.assign(new Error(detail),{code:error.code});if(owner===workspaceBinding){saveFault=true;saveError=detail;showError(failure);}throw failure; }
  }
  function scheduleSave() { clearTimeout(saveTimer);if(startupFailed)return;saveTimer=setTimeout(()=>persist().catch(showError),300); }
  function showError(error) { notice=error.message||String(error);noticeError=true;renderMessage();const modal=document.getElementById('sgDialog');if(modal&&!modal.hidden){const detail=modal.querySelector('[data-dialog-error]');if(detail)detail.textContent=notice;} }
  function message(text) { notice=text;noticeError=false;renderMessage(); }
  function renderMessage() {
    if(!root)return;
    const element=root.querySelector('[data-message]');
    if(element){element.hidden=!notice;element.textContent=notice;element.classList.toggle('is-error',noticeError);}
  }
  const options = (values,value) => values.map(entry=>{const [key,label]=Array.isArray(entry)?entry:[entry,entry];return `<option value="${esc(key)}"${String(value)===String(key)?' selected':''}>${esc(label)}</option>`;}).join('');
  const settings = entry => engine.resolveSettings(draft.settings,entry);
  // Display checks may reuse an unchanged input version. Copy objects without
  // serializing image strings, and compare every nested value to catch in-place
  // edits from imports as well as ordinary UI edits. Execution still uses the
  // contract's complete validation independently of this render-only cache.
  function validationSnapshot(value) {
    if(!value||typeof value!=='object')return value;
    if(Array.isArray(value))return value.map(validationSnapshot);
    const saved=Object.create(null);Object.keys(value).forEach(key=>{saved[key]=validationSnapshot(value[key]);});return saved;
  }
  function sameValidationInput(saved,value) {
    if(saved===value)return true;
    if(!saved||!value||typeof saved!=='object'||typeof value!=='object'||Array.isArray(saved)!==Array.isArray(value))return false;
    if(Array.isArray(value)&&saved.length!==value.length)return false;
    const keys=Object.keys(value), oldKeys=Object.keys(saved);
    return keys.length===oldKeys.length&&keys.every((key,index)=>key===oldKeys[index]&&sameValidationInput(saved[key],value[key]));
  }
  function displayedPlanCheck(entry) {
    const config=settings(entry), inputs={
      account, binding:typeof bridge.config==='function'?bridge.config():bridge.config||{},
      task:{id:entry.id,name:entry.name,requirements:entry.requirements,analysis:entry.analysis,products:entry.products},
      settings:config, plan:entry.plan
    };
    const saved=displayedPlanChecks.get(entry);
    if(saved&&saved.draft===draft&&sameValidationInput(saved.inputs,inputs))return saved.check;
    const check=engine.validatePlan(entry.plan,entry,config);
    displayedPlanChecks.set(entry,{draft,inputs:validationSnapshot(inputs),check});return check;
  }
  function field(label,key,values,config,target,wide=false) {
    const value=config[key]??'';
    if(value!==''&&!values.some(item=>String(Array.isArray(item)?item[0]:item)===String(value)))values=values.concat([[value,String(value)]]);
    return `<label class="${wide?'sg-wide':''}">${label}<select value="${esc(value)}" data-setting="${key}" data-target="${target}"${locked()?' disabled':''}>${options(values,value)}</select></label>`;
  }
  function settingsForm(config,target) {
    return mainSettingsForm(config,target);
  }
  function apiSelect() {
    const provider=modelInfo.provider||'';
    return `<div class="sg-form" style="margin-bottom:14px"><label class="sg-wide">已配置 API<select data-api${locked()?' disabled':''}>${apiChoices.length?options(apiChoices.map(item=>[item.provider,`${item.label} · ${item.imageModel}`]),provider):`<option value="">${initializing?'正在读取 API 配置…':'请先配置 API'}</option>`}</select></label></div>`;
  }
  const libraryKey = () => `sz_studio_main_modules_v1${environment}:${account}`;
  const groupKey = () => `sz_studio_module_groups_v1${environment}:${account}`;
  const ungrouped = '__ungrouped__';
  function library() { return draft.userModules || []; }
  function groups() {
    return [...new Set([...(Array.isArray(draft.userModuleGroups)?draft.userModuleGroups:[]),...library().map(item=>item.group)].filter(value=>typeof value==='string'&&value.trim()).map(value=>value.trim()))];
  }
  function groupNameError(name) {
    if(!name||name.length>40)return '请填写 1–40 字的分组名称。';
    if(['全部分组','未分组',ungrouped].includes(name))return '请使用不同的分组名称。';
    return '';
  }
  function groupEditor(name='') {
    openDialog(name?'编辑分组':'新建分组',`<p class="sg-note">分组用于整理自建模块；空分组也会保留。</p><div class="sg-form"><label class="sg-wide">分组名称<input data-group-name maxlength="40" value="${esc(name)}" placeholder="例如：商品陈列"></label></div><div class="sg-actions"><button class="sg-button" type="button" data-action="manage-groups">返回分组管理</button><button class="sg-button sg-primary" type="button" data-action="save-group" data-original="${esc(name)}">保存</button></div>`);
  }
  function groupManager() {
    openDialog('管理分组',`<p class="sg-note">删除分组后，其中的模块移到「未分组」，模块内容和已选方案会保留。</p><div class="sg-actions"><button class="sg-button sg-primary" type="button" data-action="group-editor">＋ 新建分组</button>${draft.removedGroup?'<button class="sg-button" type="button" data-action="restore-group">撤销最近删除分组</button>':''}</div><div class="sg-plan-list" style="margin-top:14px">${groups().map(name=>`<article class="sg-shot"><div class="sg-card-head"><div><h3>${esc(name)}</h3><p class="sg-note">${library().filter(item=>item.group===name).length} 个模块</p></div><div class="sg-actions"><button class="sg-button sg-small" type="button" data-action="group-editor" data-group="${esc(name)}">编辑</button><button class="sg-button sg-small" type="button" data-action="delete-group" data-group="${esc(name)}">删除</button></div></div></article>`).join('')||'<p class="sg-note">还没有分组，可创建一个空分组或在模块编辑时指定。</p>'}</div>`);
  }
  async function saveGroup(button) {
    const modal=document.getElementById('sgDialog'), name=modal.querySelector('[data-group-name]').value.trim(), original=button.dataset.original||'', list=groups();
    const error=groupNameError(name)||(list.includes(name)&&name!==original?'该分组名称已存在。':'')||(original&&!list.includes(original)?'该分组已变化，请重新打开分组管理。':'');
    if(error){modal.querySelector('[data-dialog-error]').textContent=error;return;}
    busy=true;render();
    try {
      await ensureAccount();draft.userModuleGroups=original?list.map(value=>value===original?name:value):list.concat(name);
      if(original){draft.userModules=library().map(item=>item.group===original?{...item,group:name}:item);if(moduleGroup===original)moduleGroup=name;}
      await saveLibrary();groupManager();message('分组已保存。');
    } finally { busy=false;render(); }
  }
  async function deleteGroup(name) {
    const list=groups();if(!list.includes(name))throw new Error('该分组已不存在。');
    busy=true;render();
    try {
      await ensureAccount();draft.removedGroup={name,moduleIds:library().filter(item=>item.group===name).map(item=>item.id)};
      draft.userModules=library().map(item=>item.group===name?{...item,group:''}:item);draft.userModuleGroups=list.filter(value=>value!==name);
      if(moduleGroup===name)moduleGroup=ungrouped;
      await saveLibrary();groupManager();message('分组已删除，原模块已移到「未分组」。');
    } finally { busy=false;render(); }
  }
  async function restoreGroup() {
    if(!draft.removedGroup)return;
    busy=true;render();
    try {
      await ensureAccount();const removed=draft.removedGroup;draft.userModuleGroups=[...new Set([...groups(),removed.name])];
      draft.userModules=library().map(item=>removed.moduleIds.includes(item.id)&&!item.group?{...item,group:removed.name}:item);
      draft.removedGroup=null;moduleGroup=removed.name;await saveLibrary();groupManager();message('分组已恢复。');
    } finally { busy=false;render(); }
  }
  function availableModules(config) {
    const type=config.imageType==='ad'?'ad':config.mode;
    return moduleTab==='official' ? config.mode==='detail'?engine.detailModules:engine.mainModules : library().filter(item=>(item.type||'main')===type&&(!moduleGroup||(moduleGroup===ungrouped?!item.group:item.group===moduleGroup))).map(item=>({id:item.id,label:item.name,skill:item.skill,description:item.description}));
  }
  function moduleCount(config,label) { return (config.modules||[]).filter(value=>value===label).length; }
  function moduleForm(config,target) {
    const custom=config.moduleMode==='custom', all=availableModules(config), selected=config.modules||[];
    const allSelected=all.length&&all.every(item=>selected.includes(item.label));
    return `<section class="sg-modules sg-wide"><span class="sg-field-label">${config.mode==='detail'?'详情图':config.imageType==='ad'?'广告图':'主图'}模块</span><div class="sg-module-modes" role="group" aria-label="模块选择方式">${[['smart','智能模块'],['custom','自定义模块']].map(([key,label])=>`<button type="button" data-action="module-mode" data-value="${key}" data-target="${target}" aria-pressed="${config.moduleMode===key}"${locked()?' disabled':''}>${label}${key==='custom'?'<small class="sg-new">新</small>':''}</button>`).join('')}</div>
      ${custom?`<div class="sg-module-tabs" role="tablist" aria-label="模块来源">${[['official','官方模块'],['mine','我的模块']].map(([key,label])=>`<button type="button" role="tab" aria-selected="${moduleTab===key}" data-action="module-tab" data-value="${key}"${locked()?' disabled':''}>${label}</button>`).join('')}</div>${moduleTab==='mine'?`<div class="sg-module-tools"><select data-module-group aria-label="模块分组"${locked()?' disabled':''}>${options([['','全部分组'],[ungrouped,'未分组'],...groups()],moduleGroup)}</select><button type="button" class="sg-text-button" data-action="module-editor"${locked()?' disabled':''}>＋ 自定义模块</button><button type="button" class="sg-text-button" data-action="manage-groups"${locked()?' disabled':''}>管理分组</button><button type="button" class="sg-text-button" data-action="manage-modules"${locked()?' disabled':''}>${managingModules?'完成管理':'去管理'}</button></div>`:''}<div class="sg-module-summary"><span>选择模块 <b>${selected.length}/16</b></span><label><input type="checkbox" data-module-all data-target="${target}"${allSelected?' checked':''}${locked()||!all.length?' disabled':''}>全选</label></div><div class="sg-module-grid">${all.map(item=>{const quantity=moduleCount(config,item.label);return `<div class="sg-module-item${quantity?' is-selected':''}"><label title="${esc(item.description||item.skill)}"><input type="checkbox" data-module="${esc(item.label)}" data-target="${target}"${quantity?' checked':''}${locked()?' disabled':''}><span>${esc(item.label)}</span></label>${quantity?`<div class="sg-module-quantity"><button type="button" aria-label="减少${esc(item.label)}数量" data-action="module-count" data-label="${esc(item.label)}" data-target="${target}" data-delta="-1"${locked()||quantity<=1?' disabled':''}>−</button><span>${quantity}</span><button type="button" aria-label="增加${esc(item.label)}数量" data-action="module-count" data-label="${esc(item.label)}" data-target="${target}" data-delta="1"${locked()||quantity>=5||selected.length>=16?' disabled':''}>＋</button></div>`:''}${moduleTab==='mine'&&managingModules?`<div class="sg-module-edit"><button type="button" data-action="module-editor" data-module-id="${esc(item.id)}"${locked()?' disabled':''}>编辑</button><button type="button" data-action="delete-module" data-module-id="${esc(item.id)}"${locked()?' disabled':''}>移除</button></div>`:''}</div>`;}).join('')}</div>${!all.length?'<p class="sg-note sg-module-empty">暂无可用模块，点击「自定义模块」添加。</p>':''}${draft.removedModule&&moduleTab==='mine'?'<button type="button" class="sg-text-button" data-action="restore-module">撤销最近移除</button>':''}${selected.length?`<p class="sg-note">已选 ${selected.length} 张：${esc([...new Set(selected)].join('、'))}</p>`:''}`:''}</section>`;
  }
  function mainSettingsForm(config,target) {
    const entry=target==='global'?draft.tasks[0]:draft.tasks.find(item=>item.id===target);
    const models=[...new Set([config.model||modelInfo.model||'',...apiChoices.filter(item=>item.provider===(modelInfo.provider||'')).map(item=>item.imageModel)].filter(Boolean))];
    const ratioNames={'1:1':'方图','3:4':'竖版','4:3':'横版','9:16':'竖屏','16:9':'横屏'};
    return `<div class="sg-form sg-main-form">
      ${config.imageType==='ad'?field('广告类型','adType',['电商广告','品牌广告','活动广告','社交广告'],config,target,true):field('目标平台','platform',engine.platforms,config,target,true)}
      ${entry&&!isBatch?`<div class="sg-wide sg-brief-field"><div class="sg-field-heading"><label for="sgBrief">${config.mode==='detail'?'详情图要求':config.imageType==='ad'?'广告诉求':'主图要求'}</label><button type="button" class="sg-text-button" data-action="write-brief" data-id="${entry.id}"${locked()||!entry.products.length||!modelInfo.ready?' disabled':''}>${icon('spark')}AI帮写</button></div><textarea id="sgBrief" data-task-field="requirements" data-id="${entry.id}" maxlength="6000" placeholder="输入产品卖点、目标人群、使用场景和图片风格"${locked()?' disabled':''}>${esc(entry.requirements)}</textarea></div>`:''}
      ${field('目标语言','language',engine.languages.map(value=>[value,value==='无文字纯视觉'?'无文字(纯视觉)':value]),config,target,true)}
      ${field('模型','model',models.length?models:[['','请先配置 API']],config,target,true)}
      ${field('尺寸比例','ratio',engine.ratios.map(value=>[value,`${value}${ratioNames[value]?' '+ratioNames[value]:''}`]),config,target)}
      ${field('清晰度','resolution',engine.resolutions.map(value=>[value,`${value} ${{'0.5K':'标准','1K':'标清','2K':'高清','4K':'超清'}[value]}`]),config,target)}
      ${config.moduleMode!=='custom'||config.imageType==='ad'?field(config.mode==='detail'?'详情屏数':'生成数量','count',Array.from({length:16},(_,i)=>[i+1,`${i+1} ${config.mode==='detail'?'屏':'张'}`]),config,target):''}
      ${config.imageType==='ad'?adQualityForm(config,target)+adTemplatesForm(config,target):moduleForm(config,target)}
    </div>`;
  }
  function adQualityForm(config,target) {
    const supported=modelInfo.qualityOptions||(['openai-images','generic-json'].includes(modelInfo.imageAdapter||modelInfo.adapter)?['auto','low','medium','high']:['auto']);
    const selected=config.quality||'auto', labels={auto:'自动质量',low:'低质量',medium:'标准质量',high:'高质量'};
    const choices=[...new Set([...supported,selected])];
    return `<label>质量<select data-setting="quality" data-target="${target}"${locked()?' disabled':''}>${choices.map(value=>`<option value="${esc(value)}"${selected===value?' selected':''}${!supported.includes(value)?' disabled':''}>${esc(labels[value]||value)}${!supported.includes(value)?'（当前 API 不支持）':''}</option>`).join('')}</select></label><section class="sg-wide sg-ad-speed"><span class="sg-field-label">生成速度</span><div class="sg-module-modes" role="group" aria-label="生成速度"><button type="button" data-action="generation-speed" data-value="standard" data-target="${target}" aria-pressed="${config.generationSpeed!=='fast'}"${locked()?' disabled':''}>标准</button><button type="button" aria-pressed="false" disabled title="当前 API 未提供快速生成能力">快速</button></div><p class="sg-note">当前 API 使用标准生成；快速模式尚未提供。</p></section>`;
  }
  function adTemplatesForm(config,target) {
    return `<section class="sg-wide sg-ad-templates"><div class="sg-field-heading"><span>超现实广告模板</span><span class="sg-meta">可编辑画面方案</span></div><div class="sg-ad-grid">${(engine.adTemplates||[]).map((item,index)=>`<button type="button" class="sg-ad-template sg-ad-${index}" data-action="ad-template" data-value="${item.id}" data-target="${target}" aria-pressed="${config.adTemplate===item.id}"${locked()?' disabled':''}><span class="sg-ad-art" aria-hidden="true"><i></i><b></b></span><strong>${esc(item.label)}</strong><small>${esc(item.description)}</small></button>`).join('')}</div><p class="sg-note">超现实场景与真实商品结合，保持商品外形、颜色和标识。</p></section>`;
  }
  function targetConfig(target) { const entry=draft.tasks.find(item=>item.id===target);return entry?entry.overrides:draft.settings; }
  function changedConfig(target) { (target==='global'?draft.tasks.filter(item=>!item.overrides):draft.tasks.filter(item=>item.id===target)).forEach(invalidate);showPlan=true;render();scheduleSave(); }
  function syncModules(config) {
    const type=config.imageType==='ad'?'ad':config.mode;
    config.moduleSkills=Object.fromEntries(library().filter(item=>(item.type||'main')===type&&(config.modules||[]).includes(item.name)).map(item=>[item.name,item.skill]));
    if(config.moduleMode==='custom')config.count=Math.max(1,(config.modules||[]).length);
  }
  function eachConfig(callback) { [...new Set([draft.settings,...Object.values(draft.typeSettings||{}),...draft.tasks.map(entry=>entry.overrides).filter(Boolean)])].forEach(callback); }
  function moduleEditor(id) {
    const item=library().find(module=>module.id===id)||{name:'',description:'',skill:'',group:''};
    const type=item.type||(draft.settings.mode==='detail'?'detail':draft.settings.imageType==='ad'?'ad':'main');
    openDialog('自定义模块',`<p class="sg-note">设定模块名称、简介和 Skill，作为本模块的画面提示词。</p><div class="sg-form"><label class="sg-wide">图类型<select data-module-type>${options([['main','主图'],['detail','详情图'],['ad','广告图']],type)}</select></label><label class="sg-wide">模块名称<input data-module-name maxlength="80" value="${esc(item.name)}" placeholder="例如：桌面使用场景"></label><label class="sg-wide">所属分组<input data-module-group-name maxlength="40" value="${esc(item.group)}" placeholder="输入已有分组或新建分组"></label><label class="sg-wide">模块简介<input data-module-description maxlength="200" value="${esc(item.description)}"></label><label class="sg-wide">Skill（模块提示词）<textarea data-module-skill maxlength="2000" placeholder="描述构图、光线、背景和需要突出的商品细节">${esc(item.skill)}</textarea></label></div><div class="sg-actions"><button class="sg-button" type="button" data-action="close-dialog">取消</button><button class="sg-button sg-primary" type="button" data-action="save-module" data-module-id="${esc(id||'')}">保存</button></div>`);
  }
  function openDialog(title,body) {
    let modal=document.getElementById('sgDialog');if(!modal){modal=document.createElement('div');modal.id='sgDialog';modal.className='sg-modal';document.body.appendChild(modal);modal.addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(button)action(button).catch(showError);else if(event.target===modal)modal.hidden=true;});}
    modal.innerHTML=`<section class="sg-modal-content" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="sg-card-head"><h2>${esc(title)}</h2><button type="button" class="sg-button sg-small" data-action="close-dialog" aria-label="关闭弹窗">关闭</button></div>${body}<p data-dialog-error role="alert" class="sg-note"></p></section>`;modal.hidden=false;modal.querySelector('input,textarea,button')?.focus();
  }
  function tabs() {
    const active=draft.settings.mode==='detail'?'detail':draft.settings.imageType==='ad'?'ad':'main';
    return `<div class="sg-tabs" role="tablist" aria-label="图片类型">${[['main','主图'],['detail','详情图'],['ad','广告图']].map(([id,label])=>`<button type="button" role="tab" aria-selected="${active===id}" data-action="mode" data-mode="${id}"${locked()?' disabled':''}>${label}${id==='ad'?'<small class="sg-new">新</small>':''}</button>`).join('')}</div>`;
  }
  function products(entry) {
    return `${window.SZ_IMAGE_UPLOAD.markup({title:'产品图',subtitle:'上传清晰的产品图片',count:entry.products.length,max:6,hint:'白底产品图最佳 · 最多 6 张同款商品图',note:'多图用于补充同一商品的必要视角，原图会保留。',input:`<input type="file" accept="image/png,image/jpeg,image/webp" multiple data-files="${entry.id}" aria-label="${esc(entry.name)}产品图"${locked()?' disabled':''}>`,zoneAttributes:`data-drop="${entry.id}"`})}
      <div class="sg-assets">${entry.products.map((asset,index)=>`<div class="sg-asset"><img src="${esc(asset.image)}" alt="${esc(asset.name)}" role="button" tabindex="0" aria-label="预览产品图 ${index+1}" data-product-preview="${entry.id}" data-index="${index}"><button type="button" aria-label="移除产品图 ${index+1}" data-action="remove-image" data-id="${entry.id}" data-index="${index}"${locked()?' disabled':''}>×</button><small>${esc(asset.name)}</small></div>`).join('')}</div><a class="sg-refinement-link" href="/dashboards/operating-network?surface=refinement" target="_top">没有白底图？ 去精修获得白底图</a>`;
  }
  function taskFields(entry) {
    return `<div class="sg-form"><label class="sg-wide">商品名称<input data-task-field="name" data-id="${entry.id}" value="${esc(entry.name)}" maxlength="100" placeholder="为商品任务命名"${locked()?' disabled':''}></label><label class="sg-wide">图片要求<textarea data-task-field="requirements" data-id="${entry.id}" maxlength="6000" placeholder="输入产品卖点、目标人群、使用场景和图片风格"${locked()?' disabled':''}>${esc(entry.requirements)}</textarea></label></div>`;
  }
  function plans(entry) {
    if(!entry.plan)return '';
    return `<div class="sg-plan-list">${entry.plan.shots.map(shot=>`<article class="sg-shot"><h3>${esc(shot.index||'')} ${esc(shot.label)}</h3><textarea data-shot="${shot.id}" data-id="${entry.id}" aria-label="${esc(entry.name)} ${esc(shot.label)}方案"${locked()?' disabled':''}>${esc(shot.prompt)}</textarea></article>`).join('')}</div><label class="sg-confirm"><input type="checkbox" data-confirm="${entry.id}"${entry.confirmed?' checked':''}${locked()?' disabled':''}><span>我已核对商品、内容与画面方案，按此方案生成。</span></label>`;
  }
  function slotsFor(id) { const record=current().tasks.find(entry=>entry.id===id);return (record?.slots||[]).map(slot=>({...slot,taskId:id,taskName:record.name})); }
  function allSlots() {
    const type=draft?.settings.imageType==='ad'?'ad':draft?.settings.mode;
    const sameType=config=>(config.imageType==='ad'?'ad':config.mode)===type;
    return (current().tasks||[]).filter(entry=>entry.plan&&sameType(entry.plan.settings)).flatMap(entry=>{
      const planned=draft.tasks.find(item=>item.id===entry.id)?.plan;
      return (entry.slots||[]).map(slot=>({...slot,taskName:entry.name,taskId:entry.id,previous:!planned||planned.signature!==entry.plan.signature}));
    }).concat((current().previousResults||[]).filter(slot=>slot.item?.studioGenesisPlan?.settings&&sameType(slot.item.studioGenesisPlan.settings)).map(slot=>({...slot,previous:true,taskName:slot.item&&slot.item.productName||''})));
  }
  function activeSlots() {
    return (current().tasks||[]).filter(entry=>{
      const planned=draft.tasks.find(item=>item.id===entry.id)?.plan;
      return planned&&entry.plan&&planned.signature===entry.plan.signature;
    }).flatMap(entry=>entry.slots||[]);
  }
  function pendingImage(taskId,shotId) {
    const state=current();
    return (state.pendingReceipts||[]).concat(state.uncertain||[]).some(receipt=>receipt.accountKey===account&&receipt.taskId===taskId&&receipt.shotId===shotId)||
      (state.tasks||[]).some(entry=>entry.id===taskId&&(entry.slots||[]).some(slot=>slot.shot.id===shotId&&!slot.item&&slot.status==='uncertain'));
  }
  function eligibleShots(entry,retry=false) {
    if(!entry.plan)return [];
    const record=current().tasks.find(item=>item.id===entry.id), compatible=record&&record.plan.signature===entry.plan.signature;
    if(retry)return compatible?record.slots.filter(slot=>slot.status==='failed'&&!pendingImage(entry.id,slot.shot.id)):[];
    return compatible?record.slots.filter(slot=>['ready','queued'].includes(slot.status)&&!pendingImage(entry.id,slot.shot.id)):
      entry.plan.shots.filter(shot=>!pendingImage(entry.id,shot.id));
  }
  function newGenerationTasks() {
    // A revised plan must not replace the plan needed to recover an older
    // receipt. Make that revised plan an explicit, independently priced task.
    const revised=draft.tasks.filter(entry=>{
      const record=current().tasks.find(item=>item.id===entry.id);
      return entry.plan&&record&&record.plan.signature!==entry.plan.signature&&record.slots.some(slot=>pendingImage(entry.id,slot.shot.id));
    });
    if(draft.tasks.some(entry=>!revised.includes(entry)&&(eligibleShots(entry).length||eligibleShots(entry,true).length)))return revised;
    return draft.tasks.filter(entry=>{
      if(revised.includes(entry))return true;
      if(!entry.plan)return false;
      const record=current().tasks.find(item=>item.id===entry.id), compatible=record&&record.plan.signature===entry.plan.signature;
      return entry.plan.shots.some(shot=>pendingImage(entry.id,shot.id)&&(!compatible||!record.slots.find(slot=>slot.shot.id===shot.id)?.item));
    });
  }
  function copyGenerationTasks(entries) {
    const copies=new Map(entries.map(entry=>{
      const next=clone(entry);next.id=uid();
      const copyPlan=plan=>{
        const result=engine.reidentifyPlan(plan,next.id);
        if(result.ok===false)throw new Error(result.error);
        return result;
      };
      next.plan=copyPlan(entry.plan);
      Object.values(next.typeDrafts||{}).forEach(saved=>{if(saved.plan)saved.plan=copyPlan(saved.plan);});
      return [entry,next];
    }));
    // Keep the original controller records and journals for receipt recovery.
    draft.tasks=draft.tasks.map(entry=>copies.get(entry)||entry);
  }
  function statusLabel(status) { return ({ready:'待生成',queued:'排队中',generating:'生成中',done:'已完成',failed:'生成失败',uncertain:'生成结果确认中'})[status]||status; }
  function taskRows() {
    const rows=[], seen=new Set();
    const bindings=[...retainedWorkspaces,workspaceBinding].filter(Boolean);
    bindings.forEach(binding=>{
      const state=binding.controller.state;
      if(state.accountKey&&state.accountKey!==account)return;
      (state.tasks||[]).forEach(entry=>(entry.slots||[]).forEach(slot=>{
        if(!slot.item&&!['queued','generating','uncertain','failed'].includes(slot.status))return;
        const receipt=slot.pendingReceipt||slot.generationReceipt||(state.pendingReceipts||[]).find(value=>value.taskId===entry.id&&value.shotId===slot.shot.id)||{};
        const jobId=receipt.jobId||slot.receiptJobId||slot.item?.jobId||'';
        const key=jobId||`${entry.id}:${slot.shot.id}`;
        if(seen.has(key))return;seen.add(key);
        rows.push({key,jobId,taskId:entry.id,label:`${entry.name} · ${slot.shot.label}`,status:slot.status,type:workspaceType(entry.plan.settings),createdAt:receipt.createdAt||slot.item?.createdAt||0,previous:binding!==workspaceBinding||!draft?.tasks.some(value=>value.id===entry.id),error:slot.error?historicalSlotError(slot):'',unsaved:binding.saveFault||slot.item&&slot.archiveOk===false,projectKey:binding!==workspaceBinding&&binding.storageKey.includes(':saved-project:')?binding.storageKey:''});
      }));
      (state.pendingReceipts||[]).concat(state.uncertain||[]).forEach(receipt=>{
        if(receipt.accountKey&&receipt.accountKey!==account)return;
        const key=receipt.jobId||`${receipt.taskId}:${receipt.shotId}`;
        if(seen.has(key))return;seen.add(key);
        rows.push({key,jobId:receipt.jobId||'',taskId:receipt.taskId||'',label:'旧图片任务',status:'uncertain',type:workspaceType(binding.draft.settings),createdAt:receipt.createdAt||0,previous:true,error:''});
      });
    });
    return rows.sort((a,b)=>b.createdAt-a.createdAt);
  }
  function getTaskState(rows=taskRows()) {
    const count=status=>rows.filter(row=>row.status===status).length;
    const generating=count('generating'), queued=count('queued'), pendingReceiptCount=count('uncertain'), failed=count('failed'), completed=count('done');
    const retainedSaving=[...retainedWorkspaces].some(binding=>binding.controller.state.busy||(binding.controller.state.tasks||[]).some(entry=>(entry.slots||[]).some(slot=>slot.archiveSaving)));
    const preparing=(workspaceBusy()||retainedSaving)&&!generating&&!queued;
    const activeCount=generating+queued+(preparing?1:0);
    const summary=`${activeCount} 项进行中 · ${pendingReceiptCount} 项结果待确认 · ${failed} 项失败 · ${completed} 项完成`;
    return {ready:!initializing&&!restoring&&!startupFailed,busy:activeCount>0,activeCount,pendingReceiptCount,failedCount:failed,completedCount:completed,summary};
  }
  function taskElapsed(createdAt,now=Date.now()) {
    if(!createdAt)return '开始时间未记录';
    const seconds=Math.max(0,Math.floor((now-createdAt)/1000));
    return seconds<60?`${seconds} 秒`:`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;
  }
  function taskProgressMarkup() {
    const rows=taskRows(), state=getTaskState(rows);
    const phase=initializing||restoring?'正在读取任务':uploading?'正在导入产品图':analyzing?'正在分析产品':state.activeCount&&!rows.some(row=>['generating','queued'].includes(row.status))?'正在保存任务或成果':'';
    return `<section class="sg-card sg-task-progress" data-task-progress aria-label="任务进度"><div class="sg-card-head"><div><h2>任务进度</h2><p class="sg-note" data-task-summary>${esc(state.summary)}</p></div>${current().busy?'<button type="button" class="sg-button sg-small" data-action="end-wait">结束本次等待</button>':''}</div>${phase?`<p class="sg-note">${esc(phase)}</p>`:''}${rows.length?`<details${state.activeCount||state.pendingReceiptCount?' open':''}><summary>查看 ${rows.length} 张图片的任务状态</summary><div class="sg-task-list">${rows.map(row=>`<article class="sg-task-row" data-task-row="${esc(row.key)}"><div><strong>${esc(row.label)}</strong><span class="sg-meta">${esc(typeLabel(row.type))}${row.previous?' · 历史任务':''}</span></div><p class="sg-task-state">${row.status==='uncertain'?'结果待确认 · 本次等待已结束':statusLabel(row.status)}</p><p class="sg-meta">${row.createdAt?`提交于 ${esc(new Date(row.createdAt).toLocaleString('zh-CN'))} · 已过 <span data-task-elapsed="${row.createdAt}">${taskElapsed(row.createdAt)}</span>`:'开始时间未记录'}</p><details><summary>任务编号</summary><code>${esc(row.jobId||row.taskId||'旧记录未保存编号')}</code></details>${row.status==='uncertain'?'<p class="sg-note">原请求和结果继续保留，可创建新任务。新生成按新任务计费。</p>':row.status==='failed'&&row.error?`<p class="sg-note">${esc(row.error)}</p>`:''}${row.unsaved?'<p class="sg-note">原件或草稿待补存，请保留本页面。</p>':''}${row.projectKey&&row.type===workspaceType(draft.settings)?`<button type="button" class="sg-button sg-small" data-action="restore-retained" data-project-key="${esc(row.projectKey)}"${locked()?' disabled':''}>恢复此项目</button>`:''}</article>`).join('')}</div></details>`:'<p class="sg-note">当前没有正在执行的图片任务。</p>'}</section>`;
  }
  function refreshTaskProgress() {
    const element=root?.querySelector('[data-task-progress]');
    if(!element)return;
    const markup=taskProgressMarkup();element.innerHTML=markup.slice(markup.indexOf('>')+1,-'</section>'.length);
    syncTaskProgress();
  }
  function stopTaskElapsedTimer() {
    if(!taskElapsedTimer)return;
    if(typeof window.clearInterval==='function')window.clearInterval(taskElapsedTimer.id);
    taskElapsedTimer=null;
  }
  function updateTaskElapsed() {
    if(document.visibilityState==='hidden')return;
    const now=Date.now();
    root?.querySelectorAll('[data-task-elapsed]').forEach(element=>{
      const text=taskElapsed(Number(element.dataset.taskElapsed),now);
      if(element.textContent!==text)element.textContent=text;
    });
  }
  function syncTaskProgress() {
    const rows=taskRows(), state=getTaskState(rows);
    // Keep announcements outside the replaced workspace. Elapsed ticks only
    // update their own labels and never announce the entire task list again.
    let announcer=document.getElementById('sgTaskAnnouncement');
    if(!announcer){announcer=document.createElement('div');announcer.id='sgTaskAnnouncement';announcer.className='sg-visually-hidden';announcer.style.cssText='position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap';announcer.innerHTML='<span role="status" aria-live="polite" aria-atomic="true"></span>';document.body.appendChild(announcer);}
    const signature=JSON.stringify([state.summary,rows.map(row=>[row.key,row.status])]);
    if(signature!==lastTaskAnnouncement){lastTaskAnnouncement=signature;announcer.querySelector('span').textContent=rows.length||state.busy?state.summary:'';}
    const ticking=document.visibilityState!=='hidden'&&rows.some(row=>row.createdAt>0&&['queued','generating','uncertain'].includes(row.status));
    if(ticking&&!taskElapsedTimer)taskElapsedTimer={id:setInterval(updateTaskElapsed,1000)};
    else if(!ticking)stopTaskElapsedTimer();
  }
  // Display legacy snapshots safely without changing their task or receipt state.
  function historicalSlotError(slot) {
    const original=slot.error, stored=original&&typeof original==='object'&&!Array.isArray(original)?original:null;
    const meta=slot.errorMeta&&typeof slot.errorMeta==='object'&&!Array.isArray(slot.errorMeta)?slot.errorMeta:null;
    let body=stored, raw=typeof original==='string'?original:'';
    if(!body&&raw.length<=16384){
      const start=raw.indexOf('{');
      if(start>=0)try {const parsed=JSON.parse(raw.slice(start));if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))body=parsed;}catch(_){}
    }
    const detail=body&&body.error&&typeof body.error==='object'?body.error:null;
    const codeValue=meta&&meta.code||body&&(body.code||body.errorCode)||detail&&detail.code||'';
    const code=typeof codeValue==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,95}$/.test(codeValue)?codeValue.toUpperCase():'';
    const stateCodes=[meta&&meta.code,body&&body.code,body&&body.errorCode,detail&&detail.code].map(value=>typeof value==='string'?value.slice(0,96).toUpperCase():'').join(' ');
    const hintValue=body&&(body.message||typeof body.error==='string'&&body.error)||detail&&detail.message||raw;
    const hint=typeof hintValue==='string'?hintValue.slice(0,1024):'';
    const check='请先查看原任务记录，避免重复提交。';
    const uncertain=slot.status==='uncertain'||slot.stateUncertain===true||slot.providerSubmitted===true||meta&&(meta.stateUncertain===true||meta.providerSubmitted===true)||body&&(body.stateUncertain===true||body.providerSubmitted===true)||detail&&(detail.stateUncertain===true||detail.providerSubmitted===true)||
      /UNKNOWN|UNCERTAIN|INFLIGHT|IN_FLIGHT|ALREADY_SUBMITTED|ALREADY_DISPATCHED|REQUEST_ACTIVE|HOLD_PENDING|REPLAY|SOURCE_USAGE_UNPROVEN/.test(stateCodes);
    if(uncertain)return '本次等待已结束，原请求的结果待确认；其他任务可继续。';
    // A historical string or HTTP status is never proof of non-submission.
    const receipt=meta||stored;
    const notSubmitted=receipt&&receipt.proxyNotSubmitted===true&&receipt.providerSubmitted===false&&receipt.definitiveFailure===true&&
      /^(?:CREATIVE_REQUEST_NOT_SUBMITTED|CREATIVE_SUPPLY_NOT_CONFIGURED|CREATIVE_SUPPLY_UNAVAILABLE|CREATIVE_ACCOUNT_CHANGED|INSUFFICIENT_BALANCE|CREATIVE_CREDIT_SERVICE_UNAVAILABLE|CREDIT_SERVICE_UNAVAILABLE|POOL_[A-Z0-9_]+|CREDIT_POOL_[A-Z0-9_]+)$/.test(code);
    const service='生成服务暂时繁忙。'+(notSubmitted?'请稍后再试。':check);
    const balance='可用积分不足，请补充积分。'+(notSubmitted?'补充后可继续。':check);
    const login='请恢复原账号登录后查看任务记录，避免重复提交。';
    const modelAuth='自有生图接口鉴权失败，请重新核对并保存 API 配置。'+check;
    const legacyAuth='接口鉴权未通过，请核对登录状态和 API 配置。'+check;
    const limited='请求较多，服务暂时繁忙。'+(notSubmitted?'请稍后再试。':check);
    if(/^(?:POOL_|CREDIT_POOL_|SHARED_SOURCE_|SOURCE_|FX_RATE_|INVALID_FX_|INSUFFICIENT_POOL_|CREATIVE_SUPPLY_|CREATIVE_CREDIT_SERVICE_|CREDIT_SERVICE_)/.test(code))return service;
    if(/^(?:INSUFFICIENT_BALANCE|INSUFFICIENT_CREDITS)$/.test(code))return balance;
    if(code==='CREATIVE_REQUEST_NOT_SUBMITTED'&&notSubmitted&&(receipt.httpStatus||receipt.status)===401)return login;
    // Only persisted non-submission proof for this same current slot may invite manual retry.
    const failure=slot.generationFailure, failedReceipt=failure&&failure.receipt;
    const currentReceipt=slot.pendingReceipt||failedReceipt;
    const receiptFields=['receiptId','jobId','accountKey','workspaceKey','taskId','shotId','batchId','planSignatureHash'];
    const sameFailedReceipt=meta&&meta.providerAttempted!==true&&meta.upstreamRejected!==true&&failure&&failure.providerSubmitted===false&&failure.definitiveFailure===true&&
      failedReceipt&&currentReceipt&&failedReceipt.receiptVersion===1&&currentReceipt.receiptVersion===1&&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(currentReceipt.receiptId||'')&&
      /^[a-f0-9]{64}$/.test(currentReceipt.planSignatureHash||'')&&currentReceipt.accountKey===account&&
      currentReceipt.jobId===slot.receiptJobId&&currentReceipt.shotId===slot.shot?.id&&
      receiptFields.every(key=>typeof failedReceipt[key]==='string'&&(key==='batchId'||!!failedReceipt[key])&&failedReceipt[key]===currentReceipt[key]);
    if(code==='CREATIVE_REQUEST_NOT_SUBMITTED'&&notSubmitted&&sameFailedReceipt&&slot.status==='failed'&&!slot.generationReceipt)return '本次尚未提交生图，可重试此图。';
    if(/^(?:AUTH_REQUIRED|ACCOUNT_UNAVAILABLE|CREATIVE_ACCOUNT_(?:CHANGED|UNAVAILABLE)|STUDIO_ACCOUNT_(?:CHANGED|REQUIRED))$/.test(code))return login;
    if(code==='MODEL_AUTH_FAILED')return modelAuth;
    // Older snapshots stored the safe auth wording with an ambiguous code.
    if(code==='UNAUTHORIZED')return /模型服务鉴权失败|自有生图接口鉴权失败/.test(hint)?modelAuth:legacyAuth;
    if(/模型服务鉴权失败|自有生图接口鉴权失败/.test(hint))return modelAuth;
    if(/^(?:RATE_LIMITED|TOO_MANY_REQUESTS)$/.test(code))return limited;
    if(/^(?:IMAGE_MODEL_INVALID|MODEL_INVALID|INVALID_MODEL|IMAGE_MODEL_REQUIRED|MODEL_TYPE_MISMATCH)$/.test(code)||/images?\s+endpoint\s+(?:requires?|expects?)\s+(?:an?\s+)?image\s+model/i.test(hint))return '所选模型不适用于生图，请重新选择模型并核对设置。'+check;
    if(/^(?:IMAGE_)?MODEL_NOT_FOUND$/.test(code))return '所选生图模型暂时不可用，请重新选择模型并核对设置。'+check;
    if(/^(?:PRODUCT_IMAGE_FETCH_FAILED|PRODUCT_IMAGE_INVALID|IMAGE_PREPARE_FAILED|IMAGE_PREPARATION_FAILED|IMAGE_INPUT_PREPARATION_FAILED|IMAGE_FETCH_FAILED|IMAGE_DECODE_FAILED|INVALID_IMAGE|INVALID_IMAGE_FORMAT|UNSUPPORTED_IMAGE_FORMAT)$/.test(code))return '产品图或素材暂时无法读取，请检查素材。'+check;
    if(/总(?:积分)?池|积分池|会计|账本|供应|订阅未配置|上游|(?:USD|\bFX\b)|汇率|api[ _-]?key|authorization|secret|upstream|provider|ledger|exchange[_ -]?rate/i.test(hint))return service;
    if(/可用积分不足|余额不足|insufficient (?:balance|credit)/i.test(hint))return balance;
    if(/未登录|请先登录|登录.{0,12}(?:失效|过期)|HTTP\s+401/i.test(hint))return login;
    if(/请求较多|请求过于频繁|rate[_ -]?limit|too many requests|HTTP\s+429/i.test(hint))return limited;
    if(/(?:产品图|商品主体图)(?:读取失败|解码失败)|(?:无法读取|读取失败).{0,12}(?:产品图|商品主体图)|(?:图片格式不支持|图片解码失败)/i.test(hint))return '产品图或素材暂时无法读取，请检查素材。'+check;
    return '这张图片暂时未完成。'+check;
  }
  // Presentation-only cache. Canonical URLs, receipts and drafts stay intact.
  function releaseLocalOriginals() {
    for(const entry of localOriginals.values())if(entry.url)try{URL.revokeObjectURL(entry.url);}catch(_){}
    localOriginals.clear();
  }
  function localDisplayOwner(binding=workspaceBinding) {
    try{return !!account&&binding===workspaceBinding&&!!root&&root.isConnected!==false&&(!displayFrame||displayFrame.isConnected)&&bridge.archiveContext?.().accountKey===account;}catch(_){return false;}
  }
  function localOriginalDescriptor(slot) {
    try {
      const item=slot?.item,r=slot?.generationReceipt;
      if(slot.status!=='done'||!slot.archiveOk||!item||!r||!item.archiveAssetId||item.accountKey!==account||r.accountKey!==account||r.taskId!==item.studioTaskId||r.shotId!==slot.shot?.id||r.jobId!==item.jobId||r.batchId!==item.batchId||item.resultId!==r.jobId+':studio:'+r.shotId)return null;
      if(['accountKey','taskId','shotId','jobId','batchId'].some(key=>typeof r[key]!=='string'||!r[key].trim())||!Number.isFinite(r.createdAt)||r.createdAt<=0)return null;
      const plan=slot.previous?item.studioGenesisPlan:current().tasks.find(task=>task.id===r.taskId)?.plan;
      if(!plan||engine.validatePlan(plan)?.ok!==true||JSON.stringify(plan)!==JSON.stringify(item.studioGenesisPlan)||JSON.stringify(plan.shots.find(shot=>shot.id===r.shotId))!==JSON.stringify(slot.shot))return null;
      let identity;
      if(r.receiptVersion===1){
        identity={version:1,receiptId:r.receiptId,jobId:r.jobId,accountKey:r.accountKey,workspaceKey:r.workspaceKey,taskId:r.taskId,shotId:r.shotId,batchId:r.batchId,planSignatureHash:r.planSignatureHash};
        if(r.workspaceKey!==workspaceScope||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(identity.receiptId||'')||!/^[a-f0-9]{64}$/.test(identity.planSignatureHash||''))return null;
        const url=new URL(item.url,location.origin),query=JSON.parse(url.searchParams.get('identity'));
        if(url.origin!==location.origin||url.username||url.password||url.hash||!new RegExp('^/api/creative/image-receipts/'+identity.receiptId+'/content/(?:0|[1-9][0-9]{0,2})$').test(url.pathname)||Array.from(url.searchParams.keys()).length!==1||Object.keys(query||{}).length!==9||!Object.keys(identity).every(key=>query[key]===identity[key]))return null;
      }else{
        if(['receiptVersion','receiptId','workspaceKey','planSignatureHash'].some(key=>Object.prototype.hasOwnProperty.call(r,key))||!engine.validImage(item.url))return null;
        if(!/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(item.url)){
          const url=new URL(item.url);if(url.protocol!=='https:'||url.username||url.password||url.hash||url.pathname.startsWith('/api/creative/image-receipts/'))return null;
        }
        identity={accountKey:r.accountKey,taskId:r.taskId,shotId:r.shotId,jobId:r.jobId,batchId:r.batchId,createdAt:r.createdAt};
      }
      const expected={archiveAssetId:item.archiveAssetId,resultId:item.resultId,jobId:item.jobId,providerTaskId:String(item.taskId||'')};
      return {key:JSON.stringify({account,scope:workspaceScope,previous:!!slot.previous,expected,identity,createdAt:r.createdAt,url:item.url}),identity,expected,signature:plan.signature,url:item.url};
    }catch(_){return null;}
  }
  function currentLocalDescriptor(descriptor) {
    return allSlots().map(localOriginalDescriptor).find(value=>value?.key===descriptor.key);
  }
  function localResultUrl(slot) {
    const descriptor=localOriginalDescriptor(slot),entry=descriptor&&localOriginals.get(descriptor.key);
    return localDisplayOwner()&&entry?.url||slot.item?.url||'';
  }
  function applyLocalOriginals(version) {
    if(version!==displayRenderVersion||!localDisplayOwner())return;
    for(const slot of allSlots()){
      const descriptor=localOriginalDescriptor(slot),entry=descriptor&&localOriginals.get(descriptor.key);if(!entry?.url)continue;
      root.querySelectorAll('[data-preview]').forEach(image=>{if(image.dataset.preview===slot.item.resultId)image.src=entry.url;});
      const modal=document.getElementById('sgPreview');if(modal&&!modal.hidden&&modal.dataset.localResult===slot.item.resultId){const image=modal.querySelector('img');if(image)image.src=entry.url;}
    }
  }
  function readLocalOriginal(slot,explicit=false) {
    const descriptor=localOriginalDescriptor(slot),binding=workspaceBinding,archive=window.SZ_IMAGE_ARCHIVE;
    if(!descriptor||!localDisplayOwner(binding)||deactivating||typeof archive?.readCommittedResult!=='function')return Promise.resolve(null);
    let entry=localOriginals.get(descriptor.key);
    if(entry?.url)return Promise.resolve(entry.url);
    if(entry?.promise)return entry.promise;
    if(entry&&!explicit)return Promise.resolve(null);
    entry={url:'',promise:null};localOriginals.set(descriptor.key,entry);
    entry.promise=(async()=>{
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(descriptor.signature));
      const hash=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
      if(descriptor.identity.version===1&&hash!==descriptor.identity.planSignatureHash||!localDisplayOwner(binding)||deactivating||localOriginals.get(descriptor.key)!==entry||!currentLocalDescriptor(descriptor))return null;
      const result=await archive.readCommittedResult(account,descriptor.expected);
      if(!result?.ok||result.accountKey!==account||!Object.keys(descriptor.expected).every(key=>result[key]===descriptor.expected[key])||!(result.blob instanceof Blob)||!localDisplayOwner(binding)||deactivating||localOriginals.get(descriptor.key)!==entry||!currentLocalDescriptor(descriptor))return null;
      const url=URL.createObjectURL(result.blob);
      if(!localDisplayOwner(binding)||localOriginals.get(descriptor.key)!==entry||!currentLocalDescriptor(descriptor)){URL.revokeObjectURL(url);return null;}
      entry.url=url;applyLocalOriginals(displayRenderVersion);return url;
    })().catch(()=>null).finally(()=>{entry.promise=null;});
    return entry.promise;
  }
  function refreshLocalOriginals() {
    if(!localDisplayOwner()){releaseLocalOriginals();return;}
    const slots=allSlots(),keys=new Set(slots.map(localOriginalDescriptor).filter(Boolean).map(value=>value.key));
    for(const[key,entry]of localOriginals)if(!keys.has(key)){if(entry.url)try{URL.revokeObjectURL(entry.url);}catch(_){}localOriginals.delete(key);}
    if(!deactivating)for(const slot of slots)void readLocalOriginal(slot);
    applyLocalOriginals(displayRenderVersion);
  }
  window.addEventListener('pagehide',releaseLocalOriginals);
  function resultsMarkup(slots) {
    return `<div class="sg-results">${slots.filter(slot=>slot.item||['failed','generating','uncertain'].includes(slot.status)).map(slot=>{
      const image=slot.item&&localResultUrl(slot);
      const taskId=slot.taskId||slot.item?.studioTaskId;
      return `<article class="sg-result${slot.status==='failed'?' sg-failed':''}">${image?`<label class="sg-result-select"><input type="checkbox" aria-label="选择${esc(slot.shot&&slot.shot.label||'结果图片')}" data-result-select="${esc(slot.item.resultId)}"${selectedResults.has(slot.item.resultId)?' checked':''}></label><img loading="lazy" decoding="async" src="${esc(image)}" alt="${esc(slot.shot&&slot.shot.label||'生成图片')}" data-preview="${esc(slot.item.resultId)}" role="button" tabindex="0" aria-label="预览${esc(slot.shot&&slot.shot.label||'生成图片')}">`:''}<div><h3>${esc(slot.taskName||'')} ${esc(slot.shot&&slot.shot.label||'')}${slot.previous?' · 历史版本':''}</h3><p>${statusLabel(slot.status)}</p>${slot.error?`<p>${esc(historicalSlotError(slot))}</p>`:''}${image?`<p>${slot.archiveOk?'已存入本机历史':'原件待补存'}</p><div class="sg-actions"><button type="button" class="sg-button sg-small" data-action="download" data-result="${esc(slot.item.resultId)}">下载</button><button type="button" class="sg-button sg-small" data-action="edit-result" data-result="${esc(slot.item.resultId)}"${locked()?' disabled':''}>编辑图片</button>${!slot.archiveOk?`<button type="button" class="sg-button sg-small" data-action="archive" data-result="${esc(slot.item.resultId)}"${locked()?' disabled':''}>补存原件</button>`:''}</div>`:''}${!slot.previous&&taskId&&!pendingImage(taskId,slot.shot.id)&&['done','failed'].includes(slot.status)?`<button type="button" class="sg-text-button" data-action="retry-slot" data-task-id="${esc(taskId)}" data-shot-id="${esc(slot.shot.id)}"${generationLocked()||!modelInfo.ready?' disabled':''}>${slot.status==='done'?'重新生成此图':'重试此图'}</button>`:''}</div></article>`;
    }).join('')}</div>`;
  }
  function runSummary() {
    const slots=activeSlots(), done=slots.filter(slot=>slot.status==='done').length;
    if(!slots.length)return '';
    return `<div class="sg-run-summary"><span>${done}/${slots.length} 已完成</span><progress value="${done}" max="${slots.length}"></progress><span>${slots.filter(slot=>slot.status==='failed').length} 项失败</span></div>`;
  }
  function renderSingle() {
    const entry=draft.tasks[0];
    const ad=draft.settings.imageType==='ad', kind=ad?'广告图':draft.settings.mode==='detail'?'详情图':'主图';
    return `<div class="sg-hero"><span class="sg-eyebrow">${icon('spark')} AI 主图 · 详情页 · 广告图</span><h1>${ad?'超现实广告图实验室':draft.settings.mode==='detail'?'详情生图实验室':'主图生图实验室'}</h1><p>上传产品图，AI 智能分析并帮写拍摄需求，生成多角度、多场景的电商图片</p></div>
      <div class="sg-top-actions"><div class="sg-actions">${commonActions()}</div></div>${stepper(entry)}
      <div data-message class="sg-message" role="status" aria-live="polite" hidden></div>${taskProgressMarkup()}
      <div class="sg-workspace"><div class="sg-inputs"><section class="sg-card">${products(entry)}</section>
      <section class="sg-card sg-settings-card">${tabs()}${settingsForm(draft.settings,'global')}<details class="sg-advanced"><summary>商品信息</summary><div class="sg-form"><label class="sg-wide">商品名称<input data-task-field="name" data-id="${entry.id}" value="${esc(entry.name)}" maxlength="100"${locked()?' disabled':''}></label></div></details></section><div class="sg-expert"><span>开启后分析更深入，规划质量更高</span><label>专家模式 <input type="checkbox" role="switch" aria-label="专家模式" data-setting="expertMode" data-target="global"${draft.settings.expertMode?' checked':''}${locked()?' disabled':''}></label></div><button class="sg-button sg-primary sg-analyze-submit" type="button" data-action="analyze" data-id="${entry.id}"${!entry.products.length||locked()||!modelInfo.ready?' disabled':''}>${icon('spark')}${analyzing?'正在分析…':'分析产品'}</button><button class="sg-button sg-primary sg-local-plan" type="button" data-action="plan"${!entry.products.length||locked()?' disabled':''}>${icon('settings')}整理创作方案</button><p class="sg-note">核对整理后的画面方案，再点击继续生成。整理方案不调用模型；AI 分析和生成使用已配置 API。</p></div>
      <section class="sg-card sg-result-panel"><div class="sg-card-head"><div class="sg-card-title">${icon('spark')}<div><h2>${entry.plan?'确认规划与生成结果':'生成结果'}</h2><p>${entry.plan?`核对每张${kind}的画面方案后生成`:'上传产品图并点击分析开始'}</p></div></div></div><div data-result-body>${singleResultBody(entry)}</div></section></div>`;
  }
  function singleResultBody(entry) {
    if(!entry.plan&&!allSlots().length&&!current().tasks.length)return `<div class="sg-empty">${icon('spark')}<p>上传产品图并填写要求后<br>点击「分析产品」开始</p>${draft.previousProjectKey?'<button class="sg-text-button" type="button" data-action="restore-project">恢复上一项目</button>':''}</div>${pendingReceiptMarkup(current().uncertain)}`;
    return `${entry.plan?`<div class="sg-plan-toolbar"><button class="sg-text-button" type="button" data-action="back-input"${locked()?' disabled':''}>← 返回输入</button><button class="sg-text-button" type="button" data-action="toggle-plan"${locked()?' disabled':''}>${showPlan?'收起规划':'查看规划'}</button><button class="sg-text-button" type="button" data-action="new-project"${locked()?' disabled':''}>新建项目</button></div>${showPlan?`<details class="sg-design-specs"><summary>整体设计要求</summary><textarea aria-label="整体设计要求" data-task-field="requirements" data-id="${entry.id}"${locked()?' disabled':''}>${esc(entry.requirements)}</textarea><p class="sg-note">修改后重新整理方案，再核对确认。</p></details>${entry.analysis?`<details class="sg-analysis-details"><summary>查看产品分析</summary><pre>${esc(entry.analysis)}</pre></details>`:''}${plans(entry)}`:''}`:''}${generateActions()}${runSummary()}${allSlots().some(slot=>slot.item)?`<div class="sg-actions"><button class="sg-button sg-small" type="button" data-action="select-results">全选结果</button><button class="sg-button sg-small" type="button" data-action="download-selected"${!selectedResults.size?' disabled':''}>下载已选 (${selectedResults.size})</button></div>`:''}${resultsMarkup(allSlots())}${draft.previousProjectKey?'<button class="sg-text-button" type="button" data-action="restore-project">恢复上一项目</button>':''}`;
  }
  function stepper(entry) {
    const slots=activeSlots(), active=analyzing?1:current().busy?3:slots.length&&slots.every(slot=>slot.status==='done')?4:entry.plan?2:0;
    return `<ol class="sg-steps" aria-label="创作进度">${['输入','分析中','确认规划','生成中','完成'].map((label,index)=>`<li class="${index===active?'is-active':index<active?'is-complete':''}"${index===active?' aria-current="step"':''}><b>${index+1}</b><div><small>STEP 0${index+1}</small>${label}</div></li>`).join('')}</ol>`;
  }
  function commonActions() {
    return `<button type="button" class="sg-button" data-action="history">${icon('history')}生成记录</button><button type="button" class="sg-button" data-action="config"${locked()?' disabled':''}>${icon('settings')}配置 API</button>`;
  }
  function pendingReceiptMarkup(receipt) {
    if(!receipt)return '';
    if(current().accountKey!==account||receipt.accountKey&&receipt.accountKey!==account)return '<div class="sg-message is-error" role="alert">任务回执所属账号不一致，请重新打开工作台；原账号素材和回执仍保留。</div>';
    const pending=allSlots().filter(slot=>slot.status==='uncertain'&&!slot.item), count=pending.length||1;
    return `<p class="sg-note sg-pending-receipt" data-pending-receipt role="status" aria-live="polite">${count} 张图片的结果待确认，本次等待已结束。可查看上方任务进度，其他图片可继续生成，无需手动解除。</p>`;
  }
  // Recovery uses the original request's stored success or trusted notSubmitted
  // outcome to update its exact image; there is no supplier polling here.
  async function refreshReceipts() {
    if(startupFailed||!controller||!draft||initializing||restoring||deactivating||navigationLocked()||controller.hasInFlightRequest?.())return;
    if(receiptRecovery)return receiptRecovery;
    // A file picker's focus event must not lock an empty workspace's upload.
    // Unreadable journals still enter the full existing recovery/account checks.
    try {
      const state=current();
      if(state.accountKey===account&&!state.uncertain&&Array.isArray(state.pendingReceipts)&&!state.pendingReceipts.length&&!journal(workspaceScope).readAll().length)return;
    } catch(_) {}
    receiptRecovery=(async()=>{
      const before=JSON.stringify(controller.snapshot());
      await ensureAccount();
      const result=await controller.recoverPendingReceipt();
      if(!result||result.ok!==true)throw new Error(result&&result.error||'生成结果暂时无法同步，请稍后重试。');
      await ensureAccount();
      if(before!==JSON.stringify(controller.snapshot()))await persist();
    })();
    try { await receiptRecovery; } catch(error) { modelInfo={};throw error; } finally { receiptRecovery=null;if(!startupFailed)render(); }
  }
  function generateActions() {
    const slots=allSlots(), uncertain=current().uncertain;
    const ready=draft.tasks.length&&draft.tasks.every(entry=>entry.plan&&entry.confirmed&&displayedPlanCheck(entry).ok!==false);
    const hasPending=draft.tasks.some(entry=>eligibleShots(entry).length), hasFailed=draft.tasks.some(entry=>eligibleShots(entry,true).length);
    const freshTasks=newGenerationTasks(), freshCount=freshTasks.reduce((sum,entry)=>sum+entry.plan.shots.length,0);
    const imageApiUnavailable=!modelInfo.ready||modelInfo.supportsReference===false;
    const apiReason=!initializing&&imageApiUnavailable?(!modelInfo.ready?'当前自有 API 尚未配置完整，请选择平台积分模式或配置并保存自有 API，再生成已确认的方案。':'当前 API 的生图模型不支持产品参考图。请配置支持产品参考图的生图 API。'):'';
    return `<div class="sg-actions"><button type="button" class="sg-button sg-primary" data-action="generate"${freshCount?' data-new-generation':''}${!ready||generationLocked()||imageApiUnavailable||saveFault||(!hasPending&&!freshCount)?' disabled':''}>${icon('spark')}${current().busy?'正在生成…':freshCount?'按当前方案生成新图':slots.length?'继续未完成任务':isBatch?'提交批量生成':'确认并生成'}</button>${current().busy?'<button type="button" class="sg-button" data-action="stop">停止后续生成</button>':''}${hasFailed?`<button type="button" class="sg-button" data-action="retry"${generationLocked()||imageApiUnavailable?' disabled':''}>只重试失败项</button>`:''}${slots.some(slot=>slot.item)?'<button type="button" class="sg-button" data-action="download-all">下载已完成图片</button>':''}</div>${freshCount?`<p class="sg-note" data-new-generation-note>原请求仍在等待结果。点击将按当前商品方案另生成 ${freshCount} 张新图，按新任务计费；原任务和已有图片继续保留。</p>`:''}<p class="sg-note" data-generation-concurrency>最多 100 张同时生成，超出部分排队</p>${apiReason?`<div class="sg-note" data-generation-api-required role="status"><p>${esc(apiReason)}</p><button type="button" class="sg-button sg-small" data-action="config"${locked()?' disabled':''}>配置 API</button></div>`:''}${pendingReceiptMarkup(uncertain)}`;
  }
  function renderBatch() {
    const total=draft.tasks.reduce((sum,entry)=>sum+Number(settings(entry).count),0);
    return `<div class="sg-batch"><div class="sg-header"><div><h1>批量任务</h1><p>一次创建多个商品任务，按各自方案生成。</p></div><div class="sg-actions">${commonActions()}</div></div><div data-message class="sg-message" role="status" aria-live="polite" hidden></div>${taskProgressMarkup()}${tabs()}
      <section class="sg-card"><div class="sg-card-head"><div><h2>全局批量设置</h2><p>未单独设置的商品任务会继承这些参数。</p></div><span class="sg-meta" data-save-state>本机草稿</span></div>${settingsForm(draft.settings,'global')}</section>
      ${draft.tasks.map((entry,index)=>`<article class="sg-card" data-task="${entry.id}"><div class="sg-task-header"><div class="sg-task-name"><span class="sg-number">${index+1}</span><div><h3>${esc(entry.name)}</h3><span class="sg-meta">${entry.overrides?`${esc(settings(entry).ratio)} · ${esc(settings(entry).resolution)} · ${settings(entry).count} 张`:'跟随全局'}</span></div></div><div class="sg-actions"><button type="button" class="sg-button sg-small" data-action="collapse" data-id="${entry.id}" aria-expanded="${!entry.collapsed}">${entry.collapsed?'展开':'收起'}</button><button type="button" class="sg-button sg-small sg-danger" data-action="remove-task" data-id="${entry.id}"${locked()||draft.tasks.length===1?' disabled':''}>删除</button></div></div>
      <div${entry.collapsed?' hidden':''}><div class="sg-task-content"><div>${products(entry)}</div><div>${taskFields(entry)}<button type="button" class="sg-button sg-small" style="margin-top:10px" data-action="analyze" data-id="${entry.id}"${locked()||!entry.products.length||!modelInfo.ready?' disabled':''}>${icon('spark')}AI 分析产品</button></div></div><div class="sg-override"><span>${entry.overrides?'已启用单独参数':'覆盖全局参数'}</span><button type="button" class="sg-button sg-small" data-action="override" data-id="${entry.id}"${locked()?' disabled':''}>${entry.overrides?'跟随全局':'单独设置'}</button></div>${entry.overrides?`<div class="sg-overrides">${settingsForm(settings(entry),entry.id)}</div>`:''}${entry.plan?`<section class="sg-batch-plan"><div class="sg-card-head"><h2>商品方案</h2><button type="button" class="sg-button sg-small" data-action="plan-task" data-id="${entry.id}"${locked()?' disabled':''}>重新整理</button></div>${plans(entry)}</section>`:''}${resultsMarkup(slotsFor(entry.id))}</div></article>`).join('')}
      <button type="button" class="sg-button sg-add" data-action="add-task"${locked()||draft.tasks.length>=30?' disabled':''}>${icon('plus')}新建商品任务</button>
      <footer class="sg-footer"><div><strong>${draft.tasks.length} 项商品任务 · ${total} 张图片</strong><p>生成费用由所配置服务商计收</p></div><div class="sg-actions"><button type="button" class="sg-button" data-action="plan"${locked()?' disabled':''}>整理全部方案</button>${generateActions()}</div></footer>${runSummary()}</div>`;
  }
  // Concurrent receipts can update many slots before the next paint. Keep every
  // controller save awaited, but build the visible workspace once per frame.
  function scheduleRender(full=true) {
    if(startupFailed||!draft)return;
    // Hidden frames may not paint. Account/config guards must still observe the
    // latest busy state before an already queued animation frame can run.
    bridge.setApiBusy('studio-genesis',locked());
    if(pendingRender){pendingRender.full=pendingRender.full||full;return;}
    const pending={full,id:null,cancel:null};pendingRender=pending;
    const paint=()=>{
      if(pendingRender!==pending)return;
      pendingRender=null;
      if(pending.full)render();else refreshTaskProgress();
    };
    if(typeof window.requestAnimationFrame==='function'){
      pending.cancel=id=>window.cancelAnimationFrame?.(id);
      pending.id=window.requestAnimationFrame(paint);
    } else {pending.cancel=clearTimeout;pending.id=setTimeout(paint,16);}
  }
  function render() {
    if(pendingRender){pendingRender.cancel(pendingRender.id);pendingRender=null;}
    if(startupFailed||!draft)return;
    displayRenderVersion++;
    document.documentElement?.classList.toggle('sg-replica',true);
    root.innerHTML=legacyBanner()+(isBatch?renderBatch():renderSingle());renderMessage();syncTaskProgress();
    bridge.setApiBusy('studio-genesis',locked());
    renderCredits();
    refreshLocalOriginals();
  }
  function syncResultSelection() {
    root.querySelectorAll('[data-result-select]').forEach(input=>{input.checked=selectedResults.has(input.dataset.resultSelect);});
    root.querySelectorAll('[data-action="download-selected"]').forEach(button=>{
      button.disabled=!selectedResults.size;button.textContent=`下载已选 (${selectedResults.size})`;
    });
  }
  function renderCredits() {
    const hints=window.SZCreativeCreditHints;if(!hints||!root||!draft||!bridge)return;
    const config=typeof bridge.config==='function'?bridge.config():bridge.config||{};
    root.querySelectorAll('[data-action="analyze"]').forEach(button=>hints.chat(button,config.visionModel,'本次 1 项产品分析；整理方案为本地操作'));
    root.querySelectorAll('[data-action="write-brief"]').forEach(button=>hints.chat(button,config.visionModel,'本次 1 项产品分析并帮写要求；采用与编辑候选内容为本地操作'));
    root.querySelectorAll('[data-action="retry-slot"]').forEach(button=>{
      const record=current().tasks.find(item=>item.id===button.dataset.taskId);
      const entry=draft.tasks.find(item=>item.id===button.dataset.taskId);
      hints.image(button,record?.plan?.settings?.model||entry?.plan?.settings?.model||config.imageModel||modelInfo.model||'',[1],'本次只重新生成此图 1 张；原结果保留');
    });
    function quote(action,retry) {
      let count=0;const models=new Set();
      const freshTasks=retry?[]:newGenerationTasks();
      draft.tasks.forEach(entry=>{
        if(!entry.plan)return;
        const quantity=freshTasks.includes(entry)?entry.plan.shots.length:eligibleShots(entry,retry).length;
        if(quantity){count+=quantity;models.add(entry.plan.settings.model||config.imageModel||modelInfo.model||'');}
      });
      root.querySelectorAll(`[data-action="${action}"]`).forEach(button=>hints.image(button,models.size===1?[...models][0]:'',Array(count).fill(1),`本次 ${count} 张${retry?'失败项重试':freshTasks.length?'新图；原请求继续保留':'待生成图片'}${models.size>1?'；各商品使用不同模型，需分别报价':''}`));
    }
    quote('generate',false);quote('retry',true);
  }
  window.SZCreativeCreditHints?.register('studio-genesis',renderCredits);
  function invalidate(entry) { displayedPlanChecks.delete(entry);entry.plan=null;entry.confirmed=false; }
  async function refreshModels(refreshed) {
    if(startupFailed)return;
    modelInfo = {};
    const catalog=await bridge.listBoundApis(refreshed&&refreshed.boundApis);
    if(startupFailed)return;
    if (!catalog || !catalog.ok) throw new Error(catalog&&catalog.error||'无法读取已配置 API，请重新打开工作台。');
    if (String(catalog.accountKey) !== account) throw new Error('登录账号已变化，请重新打开工作台；原账号素材仍保留。');
    apiChoices=catalog.providers||[];
    modelInfo=bridge.modelInfo();
  }
  async function decode(file) {
    if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('请上传 PNG、JPEG 或 WebP 图片。');
    if(file.size>16*1024*1024)throw new Error('单张产品图不能超过 16 MB。');
    const image=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('图片读取失败。'));reader.readAsDataURL(file);});
    const dimensions=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve({width:img.naturalWidth,height:img.naturalHeight});img.onerror=()=>reject(new Error('图片无法解码，请重新导出后上传。'));img.src=image;});
    return {id:uid(),name:file.name||'产品图',image,bytes:file.size,...dimensions};
  }
  async function upload(id,files) {
    if(locked())throw new Error('请等待当前任务结束后更换素材。');
    if(!files.length)return;
    const sourceDraft=draft;
    uploading=true;render();
    try {
      await ensureAccount();const entry=draft.tasks.find(item=>item.id===id);
      if(!entry)throw new Error('当前商品任务已不存在，请重新选择。');
      if(entry.products.length+files.length>6)throw new Error('每个商品任务最多上传 6 张产品图。');
      if(entry.products.reduce((sum,item)=>sum+(item.bytes||0),0)+files.reduce((sum,file)=>sum+file.size,0)>16*1024*1024)throw new Error('同一商品的产品图合计不能超过 16 MB，请压缩后上传。');
      const images=await Promise.all(files.map(decode));await ensureAccount();
      if(draft!==sourceDraft||!draft.tasks.includes(entry))throw new Error('商品任务已切换，本次图片导入已停止。');
      const unique=images.filter((image,index)=>!entry.products.some(asset=>asset.image===image.image)&&!images.slice(0,index).some(asset=>asset.image===image.image));
      if(unique.length){entry.products.push(...unique);entry.analysis='';invalidate(entry);await persist();}
      message(`已添加 ${unique.length} 张产品图。${unique.length<images.length?'重复图片已跳过。':''}`);
    }
    finally { uploading=false;render(); }
  }
  function buildPlan(entry) {
    const output=engine.createPlan(entry,settings(entry),{analysis:entry.analysis||''});
    if(output.ok===false)throw new Error(`${entry.name}：${output.error}`);
    entry.plan=output;entry.confirmed=false;entry.collapsed=false;
  }
  async function analyze(entry) {
    if(locked())throw new Error('请等待当前任务结束。');
    analyzing=true;render();
    try {
      await ensureAccount();
      const result=await bridge.analyze({products:entry.products,tool:'product',requirements:entry.requirements,settings:settings(entry),purpose:'plan'});
      if(!result||result.ok===false)throw new Error(result&&result.error||'AI 分析未返回可用结果。');
      await ensureAccount();
      const facts=result.data||result.analysis||result.text||result.content||result;
      entry.analysis=typeof facts==='string'?facts:JSON.stringify(facts,null,2);
      buildPlan(entry);showPlan=true;await persist();message('产品分析已返回，请核对并编辑画面方案。');
    } finally { analyzing=false;render(); }
  }
  async function writeBrief(entry) {
    if(locked()||!entry.products.length)throw new Error('请先上传产品图，并等待当前任务结束。');
    analyzing=true;render();
    try {
      await ensureAccount();const result=await bridge.analyze({products:entry.products,tool:'product',requirements:entry.requirements,settings:settings(entry),purpose:'brief'});
      if(!result||result.ok===false)throw new Error(result&&result.error||'AI 帮写未返回可用内容。');await ensureAccount();
      const facts=result.data||result.analysis||result.text||result.content||result;
      const visible=typeof facts==='string'?facts:[facts.productName,facts.category,facts.structure,facts.material,...(facts.colors||facts.primaryColors||[]),...(facts.identityPoints||[])].filter(Boolean).join('；');
      const config=settings(entry), direction=(engine.adTemplates||[]).find(item=>item.id===config.adTemplate);
      briefCandidate=[entry.requirements,`商品可见特点：${visible.slice(0,2200)}。`,`保持原图款式、颜色、材质、轮廓和标识，商品清晰完整，采用自然光影。`,direction?`广告方向：${direction.label}。${direction.skill}`:config.mode==='detail'?'整组详情图统一配色与光线，分别展示整体外观、可见细节和使用场景。':'突出商品主体，背景简洁，画面留有呼吸感。',`面向${config.platform}，${config.language==='无文字纯视觉'?'不添加文字':'文案只使用已确认的商品资料'}。`].filter(Boolean).join('\n');
      openDialog('AI 帮写要求',`<p class="sg-note">根据产品图识别的可见特点整理，修改并采用后才进入创作要求。</p><textarea data-brief-candidate aria-label="AI 帮写候选要求">${esc(briefCandidate)}</textarea><div class="sg-actions"><button class="sg-button" data-action="close-dialog" type="button">取消</button><button class="sg-button sg-primary" data-action="apply-brief" data-id="${entry.id}" type="button">采用并继续编辑</button></div>`);
    } finally { analyzing=false;render(); }
  }
  async function saveLibrary() { await ensureAccount();draft.userModuleGroups=groups();localStorage.setItem(libraryKey(),JSON.stringify(library()));localStorage.setItem(groupKey(),JSON.stringify(draft.userModuleGroups));await persist(); }
  async function saveModule(button) {
    const modal=document.getElementById('sgDialog'), name=modal.querySelector('[data-module-name]').value.trim(), skill=modal.querySelector('[data-module-skill]').value.trim(), type=modal.querySelector('[data-module-type]').value;
    if(!name||!skill){modal.querySelector('[data-dialog-error]').textContent='请填写模块名称和 Skill。';return;}
    const existing=library().find(item=>item.id===button.dataset.moduleId);
    if(library().some(item=>item.name===name&&item.id!==button.dataset.moduleId)||(engine.mainModules||[]).concat(engine.detailModules||[]).some(item=>item.label===name)){modal.querySelector('[data-dialog-error]').textContent='该名称已存在，请使用不同的模块名称。';return;}
    const group=modal.querySelector('[data-module-group-name]').value.trim();
    if(group&&groupNameError(group)){modal.querySelector('[data-dialog-error]').textContent=groupNameError(group);return;}
    const item={id:existing?.id||uid(),name,skill,type,group,description:modal.querySelector('[data-module-description]').value.trim()};
    draft.userModules=existing?library().map(value=>value.id===existing.id?item:value):library().concat(item);
    if(existing){eachConfig(config=>{config.modules=(config.modules||[]).flatMap(value=>value===existing.name?(type===(config.imageType==='ad'?'ad':config.mode)?[name]:[]):[value]);syncModules(config);});draft.tasks.forEach(invalidate);}
    await saveLibrary();modal.hidden=true;moduleTab='mine';moduleGroup='';render();message('模块已保存，可在「我的模块」中选择。');
  }
  async function newProject() {
    busy=true;render();
    try {
      await persist();
      await ensureAccount();const key=`${account}:saved-project:${uid()}`, prior=workspaceBinding, storageKey=prior.storageKey;
      const nextDraft={settings:clone(draft.settings),tasks:[task(1)],userModules:library(),userModuleGroups:groups(),previousProjectKey:key};
      if(prior.legacyBackupKey)nextDraft.legacyBackupKey=prior.legacyBackupKey;
      const binding=createWorkspace(nextDraft,workspaceScope,storageKey,prior.legacy,prior.expectedDraftToken);
      // Fence the storage move with every pending controller write. Late
      // results keep saving the original project, never the new current draft.
      saveQueue=saveQueue.catch(()=>{}).then(async()=>{
        const token=await dbPut(key,{draft:clone(prior.draft),snapshot:prior.controller.snapshot()});
        await ensureAccount();
        binding.expectedDraftToken=prior.expectedDraftToken;prior.storageKey=key;prior.expectedDraftToken=token;
        retainedWorkspaces.add(prior);binding.restoring=false;installWorkspace(binding);
      });
      await saveQueue;
      selectedResults.clear();showPlan=true;await persist();message('已新建项目，上一项目已保留，可恢复。');
    } finally { busy=false;render(); }
  }
  async function restoreProject(projectKey=draft.previousProjectKey) {
    busy=true;render();
    try {
      await persist();
      await ensureAccount();const previousKey=projectKey, previous=await dbGet(previousKey);if(!previous)throw new Error('上一项目暂不可读取。');
      validateWorkspace(previous,workspaceType(draft.settings));
      const prior=workspaceBinding, storageKey=prior.storageKey, currentKey=`${account}:saved-project:${uid()}`, userModuleGroups=groups();
      saveQueue=saveQueue.catch(()=>{}).then(async()=>{
        // Re-read after earlier late-result saves. A live original controller
        // must never be replaced with the stale snapshot read before the fence.
        const latest=await dbGet(previousKey);if(!latest)throw new Error('上一项目暂不可读取。');
        validateWorkspace(latest,workspaceType(prior.draft.settings));
        const retained=[...retainedWorkspaces].find(value=>value.storageKey===previousKey);
        if(retained&&retained.expectedDraftToken!==draftToken(latest))throw new Error('上一项目已被其他页面更新，请保留原任务并重新读取。');
        const binding=retained||createWorkspace(clone(latest.draft),workspaceScope,storageKey,prior.legacy,prior.expectedDraftToken);
        if(!retained){const result=await binding.controller.restore(latest.snapshot);if(result.ok===false)throw new Error(result.error);}
        const token=await dbPut(currentKey,{draft:clone(prior.draft),snapshot:prior.controller.snapshot()});
        await ensureAccount();
        binding.storageKey=storageKey;binding.expectedDraftToken=prior.expectedDraftToken;
        prior.storageKey=currentKey;prior.expectedDraftToken=token;
        retainedWorkspaces.add(prior);retainedWorkspaces.delete(binding);
        binding.restoring=false;installWorkspace(binding);draft.userModuleGroups=[...new Set([...userModuleGroups,...groups()])];draft.previousProjectKey=currentKey;
      });
      await saveQueue;
      selectedResults.clear();showPlan=true;await persist();message('已恢复上一项目，切换前的项目也已保留。');
    } finally { busy=false;render(); }
  }
  async function download(resultId) {
    await ensureAccount();const slot=allSlots().find(entry=>entry.item&&entry.item.resultId===resultId);
    if(!slot)throw new Error('结果图片不存在。');
    const binding=workspaceBinding,descriptor=localOriginalDescriptor(slot),url=await readLocalOriginal(slot,true)||slot.item.url;
    await ensureAccount();
    const fresh=allSlots().find(entry=>entry.item?.resultId===resultId);
    if(!localDisplayOwner(binding)||deactivating||!fresh||fresh.item.url!==slot.item.url||descriptor&&localOriginalDescriptor(fresh)?.key!==descriptor.key)throw new Error('结果所属任务已变化，请从当前结果重新下载。');
    const filename=`少壮创作/${String(slot.taskName||slot.item.productName||'商品').replace(/[\\/:*?"<>|]/g,'_')}_${String(slot.shot&&slot.shot.index||1).padStart(2,'0')}.png`;
    await new Promise((resolve,reject)=>chrome.downloads.download({url,filename,saveAs:false},()=>{const error=chrome.runtime.lastError;if(error)reject(new Error(error.message));else resolve();}));
  }
  async function action(button) {
    const name=button.dataset.action,id=button.dataset.id,entry=draft.tasks.find(item=>item.id===id);
    if(name==='legacy-tasks'){await ensureAccount();showLegacyTasks();return;}
    if(button.disabled)return;
    if(name==='end-wait') { const ending=controller.endWait();if(typeof stopQueuedSubmissions==='function')stopQueuedSubmissions();await ending;message('本次等待已结束，原请求和迟到结果继续保留；可新建任务或打开其他工作台。');render();return; }
    const submitsImage=['generate','retry','retry-slot'].includes(name);
    if((submitsImage?generationLocked():locked())&&!['stop','history','download','download-all','close-dialog','close-preview'].includes(name))return;
    if(name==='close-dialog') { document.getElementById('sgDialog').hidden=true;return; }
    if(name==='manage-groups') { groupManager();return; }
    if(name==='group-editor') { groupEditor(button.dataset.group||'');return; }
    if(name==='save-group') { await saveGroup(button);return; }
    if(name==='delete-group') { await deleteGroup(button.dataset.group);return; }
    if(name==='restore-group') { await restoreGroup();return; }
    if(name==='save-module') { await saveModule(button);return; }
    if(name==='module-editor') { moduleEditor(button.dataset.moduleId);return; }
    if(name==='module-tab') { moduleTab=button.dataset.value;render();return; }
    if(name==='manage-modules') { managingModules=!managingModules;render();return; }
    if(name==='module-mode') {
      const config=targetConfig(button.dataset.target);config.moduleMode=button.dataset.value;if(config.moduleMode==='custom')syncModules(config);changedConfig(button.dataset.target);return;
    }
    if(name==='module-count') {
      const config=targetConfig(button.dataset.target), label=button.dataset.label, quantity=moduleCount(config,label)+Number(button.dataset.delta), total=(config.modules||[]).length+Number(button.dataset.delta);
      if(quantity<1||quantity>5||total>16)return;const first=config.modules.indexOf(label);config.modules=config.modules.filter(value=>value!==label);config.modules.splice(first,0,...Array(quantity).fill(label));syncModules(config);changedConfig(button.dataset.target);return;
    }
    if(name==='ad-template') { const config=targetConfig(button.dataset.target);config.adTemplate=button.dataset.value;changedConfig(button.dataset.target);return; }
    if(name==='generation-speed') { const config=targetConfig(button.dataset.target);config.generationSpeed='standard';changedConfig(button.dataset.target);return; }
    if(name==='delete-module'||name==='restore-module') {
      if(name==='delete-module'){const item=library().find(value=>value.id===button.dataset.moduleId);if(!item)return;draft.removedModule=item;draft.userModules=library().filter(value=>value.id!==item.id);eachConfig(config=>{config.modules=(config.modules||[]).filter(value=>value!==item.name);syncModules(config);});draft.tasks.forEach(invalidate);}
      else if(draft.removedModule){draft.userModules=library().concat(draft.removedModule);draft.removedModule=null;}
      await saveLibrary();render();return;
    }
    if(name==='write-brief') { await writeBrief(entry);return; }
    if(name==='apply-brief') { entry.requirements=document.querySelector('[data-brief-candidate]').value.slice(0,6000);invalidate(entry);document.getElementById('sgDialog').hidden=true;await persist();render();return; }
    if(name==='back-input') { showPlan=false;render();root.querySelector('#sgBrief')?.focus();return; }
    if(name==='toggle-plan') { showPlan=!showPlan;render();return; }
    if(name==='new-project') { await newProject();return; }
    if(name==='restore-project') { await restoreProject();return; }
    if(name==='restore-retained') { const key=button.dataset.projectKey;if(![...retainedWorkspaces].some(binding=>binding.storageKey===key))throw new Error('历史项目暂不可读取，请查看生成记录。');await restoreProject(key);return; }
    if(name==='select-results') { const ids=allSlots().filter(slot=>slot.item).map(slot=>slot.item.resultId);selectedResults=ids.every(value=>selectedResults.has(value))?new Set():new Set(ids);syncResultSelection();return; }
    if(name==='download-selected') { for(const resultId of selectedResults)await download(resultId);return; }
    if(name==='edit-result') { const slot=allSlots().find(item=>item.item?.resultId===button.dataset.result);if(slot){const result=await bridge.openResultAction('edit',slot.item);if(result?.ok===false)throw new Error(result.error);}return; }
    if(name==='retry-slot') { busy=true;render();try{await persist();const result=await controller.retrySlot(button.dataset.taskId,button.dataset.shotId,draft.tasks,draft.settings);if(!result||result.ok===false)throw new Error(result&&typeof result.error==='string'&&result.error.trim()?result.error:'本次图片重试未完成，请查看此图结果。');}finally{busy=false;try{await persist();}finally{render();}}return; }
    if(name==='history') { await ensureAccount();await bridge.openHistory(button); }
    else if(name==='config') { const result=bridge.openConfig();if(result&&result.ok===false)throw new Error(result.error); }
    else if(name==='mode') {
      await switchWorkspace(button.dataset.mode);
    } else if(name==='add-task') { draft.tasks.push(task(draft.tasks.length+1));render();await persist(); }
    else if(name==='remove-task') { draft.tasks=draft.tasks.filter(item=>item.id!==id);render();await persist(); }
    else if(name==='remove-image') { entry.products.splice(Number(button.dataset.index),1);entry.analysis='';invalidate(entry);render();await persist(); }
    else if(name==='collapse') { entry.collapsed=!entry.collapsed;render();scheduleSave(); }
    else if(name==='override') { entry.overrides=entry.overrides?null:clone(draft.settings);invalidate(entry);render();await persist(); }
    else if(name==='plan'||name==='plan-task') {
      const entries=name==='plan-task'?[entry]:draft.tasks;
      // Validate the entire selection before changing any plan.
      entries.forEach(item=>{const valid=engine.validateTask(item,settings(item));if(valid.ok===false)throw new Error(`${item.name}：${valid.error}`);});
      entries.forEach(buildPlan);render();await persist();message('方案已整理，请核对后确认生成。');
    } else if(name==='analyze')await analyze(entry);
    else if(name==='generate'||name==='retry') {
      if(generationLocked())return;
      if(!draft.tasks.every(item=>item.confirmed&&item.plan))throw new Error('请先整理并确认每个商品的方案。');
      const freshTasks=name==='generate'&&button.hasAttribute('data-new-generation')?newGenerationTasks():[];
      if(button.hasAttribute('data-new-generation')&&!freshTasks.length){render();return;}
      busy=true;render();
      try { await ensureAccount();if(freshTasks.length)copyGenerationTasks(freshTasks);await persist();const selected=draft.tasks.filter(item=>eligibleShots(item,name==='retry').length);const result=await(name==='retry'?controller.retryFailed(selected,draft.settings):controller.run(selected,draft.settings));if(result&&result.uncertain)message('本轮等待已结束，有图片结果待确认。原请求保留，其他任务可继续；再次生成按新任务计费。');else if(result&&result.ok===false)throw new Error(result.error||'任务未全部完成，请查看商品结果。');else message(result?.completed?`本轮已完成 ${result.completed} 张图片。`:'本轮任务已结束。'); }
      finally { busy=false;try{await persist();}finally{render();} }
    } else if(name==='stop') { controller.stop();stopQueuedSubmissions();message('已停止排队任务；当前请求返回后会保留结果。');render(); }
    else if(name==='archive') { await controller.retryArchive(button.dataset.result);await persist();render(); }
    else if(name==='download')await download(button.dataset.result);
    else if(name==='download-all') { for(const slot of allSlots().filter(item=>item.item))await download(slot.item.resultId); }
    else if(name==='close-preview')closeModal(document.getElementById('sgPreview'));
  }
  function change(event) {
    const element=event.target;
    if(locked())return;
    if(element.hasAttribute('data-module-group')) { moduleGroup=element.value;render();return; }
    if(element.hasAttribute('data-result-select')) { if(element.checked)selectedResults.add(element.dataset.resultSelect);else selectedResults.delete(element.dataset.resultSelect);syncResultSelection();return; }
    if(element.hasAttribute('data-module')||element.hasAttribute('data-module-all')) {
      const config=targetConfig(element.dataset.target), available=availableModules(config);
      let selected=(config.modules||[]).slice();
      if(element.hasAttribute('data-module-all')){const names=available.map(item=>item.label);selected=selected.filter(value=>!names.includes(value));if(element.checked)selected.push(...names.slice(0,16-selected.length));}
      else {selected=selected.filter(value=>value!==element.dataset.module);if(element.checked){if(selected.length>=16){message('最多选择 16 张图片，请先减少数量。');render();return;}selected.push(element.dataset.module);}}
      config.modules=selected;syncModules(config);changedConfig(element.dataset.target);return;
    }
    if(element.dataset.setting) {
      const entry=draft.tasks.find(item=>item.id===element.dataset.target), key=element.dataset.setting;
      const config=entry?entry.overrides:draft.settings;
      config[key]=key==='expertMode'?element.checked:key==='count'?Number(element.value):key==='modules'?element.value.split('\n').map(item=>item.trim()).filter(Boolean):element.value;
      (entry?[entry]:draft.tasks.filter(item=>!item.overrides)).forEach(invalidate);
      if(event.type==='change')render();scheduleSave();
    } else if(element.dataset.taskField) {
      const entry=draft.tasks.find(item=>item.id===element.dataset.id);entry[element.dataset.taskField]=element.value;invalidate(entry);scheduleSave();
      const generate=root.querySelector('[data-action=generate]');if(generate)generate.disabled=true;
      root.querySelectorAll('[data-confirm]').forEach(control=>{control.checked=false;control.disabled=true;});
    } else if(element.dataset.shot) {
      const entry=draft.tasks.find(item=>item.id===element.dataset.id), updated=engine.editShot(entry.plan,element.dataset.shot,{prompt:element.value});
      if(updated.ok===false){showError(new Error(updated.error));return;}entry.plan=updated;entry.confirmed=false;scheduleSave();
      const generate=root.querySelector('[data-action=generate]');if(generate)generate.disabled=true;root.querySelectorAll('[data-confirm]').forEach(control=>{control.checked=false;});
    } else if(element.dataset.confirm) { draft.tasks.find(item=>item.id===element.dataset.confirm).confirmed=element.checked;render();scheduleSave(); }
  }
  async function preview(resultId,trigger) {
    const slot=allSlots().find(item=>item.item&&item.item.resultId===resultId);if(!slot)return;
    const binding=workspaceBinding,descriptor=localOriginalDescriptor(slot),url=await readLocalOriginal(slot,true)||slot.item.url;
    const fresh=allSlots().find(entry=>entry.item?.resultId===resultId);
    if(!localDisplayOwner(binding)||!fresh||fresh.item.url!==slot.item.url||descriptor&&localOriginalDescriptor(fresh)?.key!==descriptor.key)return;
    openPreview(url,slot.shot&&slot.shot.label||'生成图片','生成图片原件',resultId,trigger);
  }
  function productPreview(element) {
    const entry=draft.tasks.find(item=>item.id===element.dataset.productPreview),asset=entry&&entry.products[Number(element.dataset.index)];
    if(asset)openPreview(asset.image,asset.name||'产品图','产品图原件','',element);
  }
  function openPreview(image,title,alt,resultId='',trigger) {
    let modal=document.getElementById('sgPreview');
    if(!modal){modal=document.createElement('div');modal.id='sgPreview';modal.className='sg-modal';document.body.appendChild(modal);modal.addEventListener('click',event=>{if(event.target===modal||event.target.closest('[data-action=close-preview]'))closeModal(modal);});}
    modal.dataset.localResult=resultId;
    previewReturnFocus=trigger||document.activeElement;
    modal.innerHTML=`<div class="sg-modal-content" role="dialog" aria-modal="true" aria-label="${esc(title)}预览"><div class="sg-card-head"><h2>${esc(title)}</h2><button type="button" class="sg-button" data-action="close-preview">关闭</button></div><img src="${esc(image)}" alt="${esc(alt)}"></div>`;modal.hidden=false;modal.querySelector('button').focus();
  }
  function closeModal(modal) {
    if(!modal)return;
    modal.hidden=true;
    if(modal.id==='sgPreview'){
      modal.innerHTML='';modal.dataset.localResult='';
      const origin=previewReturnFocus;previewReturnFocus=null;
      if(origin){
        const candidates=Array.from(root.querySelectorAll('[data-preview],[data-product-preview]'));
        // A receipt may repaint the workspace while this modal is open. Resolve
        // the same result/product in the new DOM instead of focusing a detached node.
        const target=candidates.find(element=>element===origin)||candidates.find(element=>origin.dataset.preview?element.dataset.preview===origin.dataset.preview:element.dataset.productPreview===origin.dataset.productPreview&&element.dataset.index===origin.dataset.index);
        target?.focus({preventScroll:true});
      }
    }
  }
  function bind() {
    if(bound)return;
    bound=true;
    document.addEventListener('cu-import-state',event=>{
      if(!root||!draft||!controller)return;
      const detail=event.detail||{};
      if(detail.pending&&detail.scope==='studio'){
        const entry=draft.tasks.find(item=>item.id===detail.inputKey);
        if(entry){invalidate(entry);scheduleSave();}
      }
      render();
    });
    root.addEventListener('click',event=>{
      const button=event.target.closest('[data-action]');if(button)action(button).catch(showError);
      const image=event.target.closest('[data-preview]');if(image)preview(image.dataset.preview,image).catch(showError);
      const product=event.target.closest('[data-product-preview]');if(product)productPreview(product);
    });
    root.addEventListener('input',event=>{if(event.target.type!=='checkbox')change(event);});
    root.addEventListener('change',event=>{
      if(event.target.dataset.files){const files=Array.from(event.target.files||[]);event.target.value='';upload(event.target.dataset.files,files).catch(showError);return;}
      if(event.target.hasAttribute('data-api')){
        if(locked())return;busy=true;
        Promise.resolve(bridge.selectBoundApi(event.target.value)).then(result=>{if(result.ok===false)throw new Error(result.error);return refreshModels();}).then(()=>{draft.settings.model=modelInfo.model;draft.tasks.forEach(invalidate);return persist();}).catch(showError).finally(()=>{busy=false;render();});return;
      }
      // Text input already updated on input; only selections and checkboxes need change handling.
      if(event.target.tagName==='SELECT'||event.target.type==='checkbox')change(event);
      else if(event.target.dataset.setting||event.target.dataset.taskField)render();
    });
    root.addEventListener('dragover',event=>{const drop=event.target.closest('[data-drop]');if(drop){event.preventDefault();drop.classList.add('is-dragging');}});
    root.addEventListener('dragleave',event=>{const drop=event.target.closest('[data-drop]');if(drop)drop.classList.remove('is-dragging');});
    root.addEventListener('drop',event=>{const drop=event.target.closest('[data-drop]');if(drop){event.preventDefault();drop.classList.remove('is-dragging');upload(drop.dataset.drop,Array.from(event.dataTransfer.files||[])).catch(showError);}});
    root.addEventListener('paste',event=>{if(event.defaultPrevented)return;const files=Array.from(event.clipboardData&&event.clipboardData.items||[]).filter(item=>item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);if(!files.length)return;const block=event.target.closest('[data-task],[data-drop]');const id=block&&(block.dataset.task||block.dataset.drop)||(!isBatch&&draft.tasks[0].id);if(!id){showError(new Error('请先选中要添加产品图的商品任务。'));return;}event.preventDefault();upload(id,files).catch(showError);});
    document.addEventListener('keydown',event=>{if(event.defaultPrevented)return;const modal=[document.getElementById('sgDialog'),document.getElementById('sgPreview')].find(value=>value&&!value.hidden);if(event.key==='Escape'&&modal){event.preventDefault();event.stopImmediatePropagation();closeModal(modal);}if((event.key==='Enter'||event.key===' ')&&event.target.matches('[data-product-preview],[data-preview]')){event.preventDefault();if(event.target.hasAttribute('data-preview'))preview(event.target.dataset.preview,event.target).catch(showError);else productPreview(event.target);}});
    window.addEventListener('beforeunload',event=>{if(unloadLocked()||!startupFailed&&(deactivating||saveFault)){event.preventDefault();event.returnValue='任务尚未结束或草稿尚未保存';}if(!startupFailed)persist().catch(()=>{});});
    document.addEventListener('visibilitychange',()=>{if(startupFailed)return;if(document.visibilityState==='hidden'){stopTaskElapsedTimer();persist().catch(()=>{});}else{syncTaskProgress();if(!locked())refreshReceipts().then(()=>bridge.refresh()).then(refreshModels).then(()=>{render();}).catch(showError);}});
    window.addEventListener('focus',()=>{refreshReceipts().catch(showError);});
    window.addEventListener('storage',event=>{if(event.key?.startsWith(`sz_studio_genesis_pending_`))refreshReceipts().catch(showError);});
    // Returning from the existing API dialog refreshes the bound account configuration.
    document.getElementById('configCancelBtn')?.addEventListener('click',()=>{if(startupFailed)return;setTimeout(()=>{if(startupFailed)return;refreshModels().then(()=>{if(!startupFailed)render();}).catch(showError);},0);});
    window.addEventListener('sz-bound-api-changed',()=>{if(startupFailed)return;refreshModels().then(()=>{if(startupFailed)return;draft.settings.model=modelInfo.model;draft.tasks.forEach(invalidate);render();scheduleSave();}).catch(showError);});
  }
  async function boot() {
    document.documentElement?.setAttribute('data-lab-startup','pending');
    document.documentElement?.setAttribute('data-studio-startup','pending');
    if(!root){root=document.createElement('section');root.id='studioGenesisRoot';document.querySelector('.app').prepend(root);}
    root.innerHTML='<div class="sg-hero"><p>正在读取创作工作台…</p></div>';
    bridge=window.SZ_CREATIVE_TOOLS_BRIDGE;engine=window.SZ_STUDIO_GENESIS;
    if(!bridge||!engine)throw new Error('创作模块未完整加载，请重新打开页面。');
    // Refresh initializes account-scoped settings for every route, including main/detail.
    const refreshed=await bridge.refresh({deferArchive:true});if(!refreshed||!refreshed.ok||!refreshed.accountKey)throw new Error(refreshed&&refreshed.error||'统一配置尚未就绪。');
    account=String(refreshed.accountKey);
    draft={settings:engine.defaults(mode),tasks:Array.from({length:isBatch?3:1},(_,i)=>task(i+1))};
    if(initialAd)Object.assign(draft.settings,{imageType:'ad',adType:'电商广告',adTemplate:engine.adTemplates[0].id});
    const loaded=await loadWorkspace(initialAd?'ad':mode,workspaceScope),saved=loaded.saved;
    installWorkspace(createWorkspace(draft,workspaceScope,loaded.storageKey,loaded.legacy,draftToken(saved)));
    if(saved&&saved.draft){
      validateWorkspace(saved,initialAd?'ad':mode);
      restoring=true;
      try { draft=clone(saved.draft);
      workspaceBinding.draft=draft;
      workspaceBinding.legacyBackupKey=draft.legacyBackupKey;
      if(saved.snapshot){const restored=await controller.restore(saved.snapshot);if(restored.ok===false)throw new Error(restored.error||'草稿任务无法安全恢复，请先核对本机历史。');}
      } finally { restoring=false; }
    }
    // Recover the exact pending images before showing controls. Unconfirmed
    // images stay protected while independent images retain their queue slots.
    if(typeof controller.recoverPendingReceipt!=='function')throw new Error('任务回执恢复模块未完整加载，请重新打开页面；核对前无法生成。');
    restoring=true;
    try {
      const recovered=await controller.recoverPendingReceipt();
      if(!recovered||recovered.ok!==true)throw new Error(recovered&&recovered.error||'任务回执无法安全恢复，请核对已有请求后重新打开工作台。');
      if(controller.state.accountKey!==account)throw new Error('登录账号已变化，请重新打开工作台；原账号素材和回执仍保留。');
    } finally { restoring=false;workspaceBinding.restoring=false; }
    try { const savedModules=JSON.parse(localStorage.getItem(libraryKey())||'null');if(Array.isArray(savedModules))draft.userModules=savedModules; } catch (_) { showError(new Error('自建模块库未能读取，当前草稿模块仍保留。')); }
    try { const savedGroups=JSON.parse(localStorage.getItem(groupKey())||'null');if(Array.isArray(savedGroups))draft.userModuleGroups=savedGroups; } catch (_) { showError(new Error('模块分组未能读取，当前草稿分组仍保留。')); }
    if(groups().length||Array.isArray(draft.userModuleGroups))draft.userModuleGroups=groups();
    bind();render();
    // Reveal only this account's restored workspace; config mutations stay locked.
    window.SZ_LAB_FIRST_PAINT?.complete();
    // Restore this account's draft before showing editable controls. API catalog
    // loading may continue after first paint, with all mutations still locked.
    try { await refreshModels(refreshed);if(!draft.settings.model)draft.settings.model=modelInfo.model||''; }
    catch(error) { showError(error); }
    finally { initializing=false;render();document.documentElement?.setAttribute('data-lab-startup','ready');document.documentElement?.setAttribute('data-studio-startup','ready'); }
  }
  const start=()=>boot().catch(error=>{
    startupFailed=true;document.documentElement?.setAttribute('data-lab-startup','error');
    document.documentElement?.setAttribute('data-studio-startup','error');
    if(root){
      root.innerHTML=`<section class="sg-card" style="margin-top:30px"><h2>创作工作台暂未就绪</h2><p class="sg-message is-error" role="alert">${esc(error.message||error)}</p><p class="sg-note">原素材、草稿和任务记录仍保留。可以重试读取，或通过左侧菜单打开其他创作入口。</p><button type="button" class="sg-button" data-action="retry-startup">重试读取工作台</button></section>`;
      root.onclick=event=>{if(!event.target.closest('[data-action="retry-startup"]'))return;root.onclick=null;startupFailed=false;initializing=true;restoring=false;notice='';noticeError=false;start();};
    }
    window.SZ_LAB_FIRST_PAINT?.complete('error');
    // First-paint completion can clear a previous timeout marker. Restore the
    // host's failure signal, while retaining the existing reload screen for
    // missing scripts or styles that an in-place draft retry cannot repair.
    if(document.documentElement?.dataset.labFirstPaintFailure==='fatal'||document.documentElement?.dataset.labStyles==='error')document.documentElement?.setAttribute('data-studio-startup','resource-error');
    document.documentElement?.setAttribute('data-lab-startup','error');
  });
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
