/* Shared image upload presentation. Business handlers retain their original inputs. */
(() => {
  'use strict';
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const svg = path => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const imageIcon = svg('<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m4 18 5-5 4 3 4-6 4 5"/>');
  const uploadIcon = svg('<path d="M12 16V3m-5 5 5-5 5 5M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>');
  function markup({title='产品图',subtitle='上传清晰的产品图片',count=0,max=6,hint='白底产品图最佳 · 最多 6 张同款商品图',note='多图用于补充同一商品的必要视角，原图会保留。',input='',zoneAttributes='' } = {}) {
    return `<div class="cu-upload"><div class="cu-head"><span class="cu-image-icon">${imageIcon}</span><div class="cu-heading"><h3>${esc(title)}</h3><p>${esc(subtitle)}</p></div><span class="cu-count" data-cu-count aria-live="polite">${Number(count)||0}/${Number(max)||1}</span></div><div class="cu-drop" role="button" tabindex="0" aria-label="上传${esc(title)}，点击上传、拖入、粘贴图片或粘贴 URL" ${zoneAttributes}><span class="cu-upload-icon">${uploadIcon}</span><strong>点击或拖入${esc(title)}</strong><span class="cu-hint">${esc(hint)}</span>${input}</div><p class="cu-methods">拖入 · 点击上传 · 粘贴图片 · 粘贴 URL</p><div class="cu-url-row"><input type="text" data-cu-url aria-label="${esc(title)}图片 URL" placeholder="粘贴图片 URL" autocomplete="off" spellcheck="false"><button type="button" data-cu-add-url>添加</button></div><p class="cu-note">${esc(note)}</p><p class="cu-error" role="alert" hidden></p></div>`;
  }
  let preview, returnFocus, originalDB, previewSequence=0;
  const originalReads = new WeakMap();
  async function owner() {
    const bridge = window.SZ_CREATIVE_TOOLS_BRIDGE;
    if (!bridge || !bridge.getAccountKey) throw new Error('请等待当前账号素材库加载完成后上传。');
    return String(await bridge.getAccountKey());
  }
  async function openOriginalDB() {
    if (!originalDB) originalDB = new Promise((resolve,reject) => {
      const environment = window.__SANJIE_ENVIRONMENT ? ':environment:' + encodeURIComponent(String(window.__SANJIE_ENVIRONMENT)) : '';
      const request = indexedDB.open('sz_image_upload_originals_v1' + environment,1);
      request.onupgradeneeded = () => request.result.createObjectStore('originals',{keyPath:'id'}).createIndex('derivative','derivative');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('无法打开图片原件库，请检查浏览器存储权限。'));
    });
    return originalDB;
  }
  const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(value => value.toString(16).padStart(2,'0')).join('');
  function validateFile(file) {
    if (!file || !file.type.startsWith('image/')) throw new Error('请选择图片文件。');
    if (!file.size) throw new Error('图片是空文件，请重新选择。');
    if (file.size > 20 * 1024 * 1024) throw new Error('单张图片不能超过 20 MB。');
  }
  async function retainOriginal(file, derivative) {
    validateFile(file);
    if (!originalReads.has(file)) originalReads.set(file,(async () => {
      const accountKey = await owner(), bytes = await file.arrayBuffer();
      return { accountKey,hash:await digest(bytes),blob:file,name:file.name||'粘贴的图片',type:file.type,bytes:file.size };
    })());
    const original = await originalReads.get(file);
    const derivativeKey = original.accountKey + ':' + await digest(new TextEncoder().encode(derivative)), db = await openOriginalDB();
    if (original.accountKey !== await owner()) throw new Error('登录账号已变化，本次图片上传已停止。');
    await new Promise((resolve,reject) => {
      const tx = db.transaction('originals','readwrite');
      tx.objectStore('originals').put({...original,id:original.accountKey + ':' + original.hash + ':' + derivativeKey,derivative:derivativeKey,createdAt:Date.now()});
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(new Error('图片原件未保存，请检查浏览器存储空间后重新上传。'));
    });
  }
  async function findOriginal(image) {
    const accountKey = await owner(), key = accountKey + ':' + await digest(new TextEncoder().encode(image)), db = await openOriginalDB();
    const record = await new Promise((resolve,reject) => { const request = db.transaction('originals').objectStore('originals').index('derivative').get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error); });
    if (accountKey !== await owner()) throw new Error('登录账号已变化，请重新打开素材预览。');
    return record;
  }
  function closePreview() {
    previewSequence++;
    if (!preview) return;
    if (preview.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
    preview.remove();preview=null;
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
  }
  async function openPreview(image,title='图片原件',lookup=false) {
    closePreview();const sequence=previewSequence;returnFocus=document.activeElement;
    let url=image,name=title,objectUrl='',hasOriginal=!lookup;
    if (lookup) { const record=await findOriginal(image);if(record){objectUrl=URL.createObjectURL(record.blob);url=objectUrl;name=record.name;hasOriginal=true;} }
    if(sequence!==previewSequence){if(objectUrl)URL.revokeObjectURL(objectUrl);return;}
    preview=document.createElement('div');preview.className='cu-modal';
    preview.innerHTML=`<section class="cu-dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><h2>${esc(title)}</h2><a href="${esc(url)}" download="${esc(name)}">${hasOriginal?'下载原图':'下载当前图片'}</a><button type="button" data-cu-close>关闭 ×</button></header><img src="${esc(url)}" alt="${esc(title)}"></section>`;
    if(objectUrl)preview.dataset.objectUrl=objectUrl;
    document.body.append(preview);preview.querySelector('button').focus();
  }
  function showError(block,error) {
    const status=block && block.querySelector('.cu-error');
    if(status){status.hidden=false;status.textContent=error.message||String(error);}
  }
  const legacy = {
    refFile:{title:'参考图',subtitle:'上传清晰的视觉参考图片',preview:'refPreview',counter:'refImageCount',max:6,note:'参考图用于学习视觉风格，商品身份以产品图为准。原图会保留。'},
    skuProductFiles:{title:'产品图',subtitle:'上传用于替换的产品图片',preview:'skuProductPreview',counter:'skuProductCount',max:20,note:'每张主体图分别绑定对应 SKU，原图会保留。'},
    skuTemplateFile:{title:'对象 SKU 底图',subtitle:'上传完整的对象 SKU 图片',preview:'skuTemplatePreview',counter:'skuTemplateCount',max:1,note:'保留完整底图，只替换其中的商品主体。原图会保留。'}
  };
  for (const [kind,label] of [['Front','正视图'],['Side','侧视图'],['Back','背视图']]) {
    legacy['product'+kind+'File']={title:'产品'+label,subtitle:'上传清晰的同款产品图片',preview:'product'+kind+'Preview',max:1,note:'用于补充同一商品的必要视角，原图会保留。'};
    legacy['model'+kind+'File']={title:'模特'+label,subtitle:'上传清晰的模特图片（可选）',preview:'model'+kind+'Preview',max:1,note:'人物仅辅助画面展示，商品仍以产品图为准。原图会保留。'};
  }
  const records=[];
  let pendingImport=null, importSequence=0;
  function isImporting() { return Boolean(pendingImport); }
  function importTarget(input) {
    const studio=input.dataset.files,creative=input.dataset.upload;
    const scope=studio?'studio':creative?'creative':input.closest('.scene-material-card')?'scene':'legacy';
    const inputKey=studio||creative||input.id||'replacement';
    let selector=input.id?'#'+CSS.escape(input.id):studio?`#studioGenesisRoot [data-files="${CSS.escape(studio)}"]`:creative?`${input.closest('#ctMaterialModal')?'#ctMaterialModal':'#creativeToolsRoot'} [data-upload="${CSS.escape(creative)}"]`:'';
    return {inputKey,scope,kind:creative||'',resolve:()=>selector?document.querySelector(selector):input};
  }
  function importState(operation,pending) {
    document.dispatchEvent(new CustomEvent('cu-import-state',{detail:{pending,inputKey:operation.inputKey,scope:operation.scope,kind:operation.kind}}));
    window.SZ_CREATIVE_TOOLS_BRIDGE?.setApiBusy?.('image-url-import',pending);
    const block=operation.resolve()?.closest('.cu-upload');if(block){block.classList.toggle('cu-importing',pending);block.querySelector('.cu-drop').setAttribute('aria-busy',String(pending));}
  }
  function finishImport(operation) {
    if(pendingImport!==operation)return;
    pendingImport=null;importState(operation,false);
  }
  function cancelImport() { if(pendingImport)finishImport(pendingImport); }
  function imageUrls(text) {
    const value=String(text||'').trim();if(!value)return [];
    const list=/^data:image\//i.test(value)?[value]:value.split(/\s+/).filter(line=>line&&!line.startsWith('#'));
    return [...new Set(list)];
  }
  async function urlFile(source,index) {
    let data=source,name='URL 图片 '+(index+1);
    if(!/^data:image\/(?:png|jpeg|webp);base64,/i.test(source)) {
      let url;try{url=new URL(source);}catch(_){throw new Error('请粘贴完整的图片 URL。');}
      if(url.protocol!=='https:'||url.username||url.password)throw new Error('请使用不带账号密码的 HTTPS 图片 URL。');
      const bridge=window.SZ_CREATIVE_TOOLS_BRIDGE;
      if(!bridge?.send)throw new Error('图片导入服务尚未准备好，请稍后重试。');
      const response=await bridge.send('FETCH_IMAGE',{url:url.href});
      if(!response?.ok||!response.dataUrl)throw new Error(response?.error||'无法读取此图片 URL，请检查图片是否可访问。');
      data=response.dataUrl;
      try{name=decodeURIComponent(url.pathname.split('/').pop())||name;}catch(_){}
    }
    const match=String(data).match(/^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=\s]+)$/i);
    if(!match)throw new Error('URL 返回的内容不是有效的 JPG、PNG 或 WebP 图片。');
    if(match[2].length>Math.ceil(20*1024*1024/3)*4+8)throw new Error('单张图片不能超过 20 MB。');
    let bytes;try{bytes=Uint8Array.from(atob(match[2]),char=>char.charCodeAt(0));}catch(_){throw new Error('图片数据格式无效。');}
    if(!/\.(?:png|jpe?g|webp)$/i.test(name))name+='.'+({ 'image/jpeg':'jpg','image/png':'png','image/webp':'webp' }[match[1].toLowerCase()]);
    const file=new File([bytes],name,{type:match[1].toLowerCase()});validateFile(file);
    return file;
  }
  async function importUrls(zone,text) {
    const input=zone?.querySelector('input[type="file"]'),block=zone?.closest('.cu-upload');
    if(!input||input.matches(':disabled'))return;
    if(isImporting()){showError(block,new Error('正在读取图片 URL，请等待完成或取消。'));return;}
    const urls=imageUrls(text);if(!urls.length)return;
    const max=Number(block.querySelector('[data-cu-count]')?.textContent.split('/')[1])||1;
    if((!input.multiple&&urls.length>1)||urls.length>max){showError(block,new Error(`此位置最多添加 ${input.multiple?max:1} 张图片，请减少 URL 数量。`));return;}
    const operation={...importTarget(input),sequence:++importSequence,route:location.href};pendingImport=operation;importState(operation,true);
    const activeBlock=operation.resolve()?.closest('.cu-upload');if(activeBlock){activeBlock.querySelector('.cu-error').hidden=true;activeBlock.classList.add('cu-importing');}
    try {
      const account=await owner(),files=[];
      for(let index=0;index<urls.length;index++){files.push(await urlFile(urls[index],index));if(pendingImport!==operation)return;}
      if(account!==await owner())throw new Error('登录账号已变化，本次 URL 导入已停止。');
      if(pendingImport!==operation||operation.route!==location.href||!operation.resolve()?.isConnected)return;
      finishImport(operation);
      const target=operation.resolve(),targetBlock=target?.closest('.cu-upload');
      if(!target||target.matches(':disabled')||!targetBlock)return;
      const urlInput=targetBlock.querySelector('[data-cu-url]');if(urlInput)urlInput.value='';
      assignFiles(target.closest('.cu-drop'),files);
    } catch(error) {
      if(pendingImport===operation){finishImport(operation);showError(operation.resolve()?.closest('.cu-upload')||block,error);}
    } finally { finishImport(operation); }
  }
  function legacyConfig(input) {
    const cfg=legacy[input.id];if(cfg)return cfg;
    if(input.type==='file' && /image\//.test(input.accept) && !input.hidden && !input.closest('.cu-upload')) {
      const card=input.closest('.scene-material-card');
      if(card)return {title:card.querySelector('h3')?.textContent.trim()||'产品图',subtitle:'上传清晰的同款产品图片',max:1,preview:card.querySelector('.scene-material-preview')?.id,note:'用于补充同一商品的必要视角，原图会保留。',scene:true};
    }
    return null;
  }
  function decorate() {
    document.querySelectorAll('input[type="file"]').forEach(input => {
      if(input.closest('.cu-upload'))return;
      const cfg=legacyConfig(input);if(!cfg)return;
      const source=input.closest('.angle-card,.image-box,.sku-upload-card,.scene-material-card')||input.parentElement;
      const host=document.createElement('div');host.innerHTML=markup({...cfg,hint:`${cfg.max===1?'每个位置 1 张图片':'支持多选 · 最多 '+cfg.max+' 张'} · 可粘贴图片`,zoneAttributes:'data-cu-legacy'});
      const block=host.firstElementChild, zone=block.querySelector('.cu-drop'),oldLabel=input.closest('label.sku-drop'),anchor=oldLabel||input;
      const existingPreview=cfg.preview && document.getElementById(cfg.preview);
      if(existingPreview && source.contains(existingPreview))existingPreview.before(block);else anchor.before(block);
      zone.append(input);input.tabIndex=-1;input.setAttribute('aria-label','上传'+cfg.title);
      if(oldLabel)oldLabel.remove();
      source.classList.add('cu-legacy-scope');
      const urlId=input.id==='skuProductFiles'?'skuProductUrls':input.id==='skuTemplateFile'?'skuTemplateUrl':input.id==='refFile'?'refUrl':input.id.replace(/File$/,'Url');
      const oldUrl=document.getElementById(urlId);if(oldUrl){oldUrl.classList.add('cu-replaced-url');oldUrl.closest('.sku-inline-details')?.classList.add('cu-replaced-url');}
      const heading=source.querySelector(':scope > .angle-title,:scope > .box-title,:scope > .sku-upload-head');
      if(heading)heading.classList.add('cu-replaced-heading');
      if(cfg.scene)source.querySelectorAll(':scope > h3,:scope > p').forEach(element=>element.classList.add('cu-replaced-heading'));
      records.push({input,cfg,block,zone,source});
    });
    sync();
  }
  function sync() {
    for(const record of records) {
      if(!record.input.isConnected)continue;
      const {input,cfg,block,zone}=record,counter=cfg.counter && document.getElementById(cfg.counter),target=cfg.preview && document.getElementById(cfg.preview);
      let count=target?target.querySelectorAll('img').length:0,max=cfg.max;
      if(counter){const pair=counter.textContent.match(/(\d+)\s*\/\s*(\d+)/),imported=counter.textContent.match(/(\d+)\s*个真实 SKU/);if(pair){count=Number(pair[1]);max=Number(pair[2]);}else if(imported){count=Number(imported[1]);max=count||cfg.max;}}
      const label=block.querySelector('[data-cu-count]'),value=`${count}/${max}`;
      if(label.textContent!==value)label.textContent=value;
      const hint=block.querySelector('.cu-hint'),hintText=`${max===1?'每个位置 1 张图片':'支持多选 · 最多 '+max+' 张'} · 可粘贴图片`;
      if(hint.textContent!==hintText)hint.textContent=hintText;
      zone.setAttribute('aria-disabled',String(input.matches(':disabled')));
      if(target)target.querySelectorAll('img').forEach(img => {if(!img.hasAttribute('data-cu-preview')){img.setAttribute('data-cu-preview','');img.tabIndex=0;img.setAttribute('role','button');img.setAttribute('aria-label','预览'+cfg.title+'原图');}});
    }
  }
  function openPicker(input,config) {
    const modal=document.createElement('div');modal.className='cu-modal';
    modal.innerHTML=`<section class="cu-dialog cu-picker" role="dialog" aria-modal="true" aria-label="${esc(config.title)}"><header><h2>${esc(config.title)}</h2><button type="button" data-cu-cancel>取消</button></header>${markup({...config,input:''})}</section>`;
    const zone=modal.querySelector('.cu-drop');input.hidden=false;input.tabIndex=-1;zone.append(input);
    const previous=document.activeElement,close=()=>{if(pendingImport?.resolve()===input)cancelImport();modal.remove();if(previous?.isConnected)previous.focus();};
    modal.querySelector('button').addEventListener('click',close);
    input.addEventListener('change',close,{once:true});
    modal.addEventListener('keydown',event=>{if(event.key==='Escape')close();});
    document.body.append(modal);zone.focus();
  }
  window.SZ_IMAGE_UPLOAD={markup,validateFile,retainOriginal,openPreview,openPicker,showError,importUrls,isImporting,cancelImport};
  document.addEventListener('click',event => {
    if(event.target.closest('[data-cu-close]') || event.target===preview){closePreview();return;}
    const img=event.target.closest('[data-cu-preview]');
    if(img){const record=records.find(entry=>entry.source.contains(img));openPreview(img.src,record?.cfg.title||'图片原件',true).catch(error=>showError(record?.block,error));return;}
    const urlButton=event.target.closest('[data-cu-add-url]');if(urlButton){const block=urlButton.closest('.cu-upload');importUrls(block.querySelector('.cu-drop'),block.querySelector('[data-cu-url]').value);return;}
    const zone=event.target.closest('.cu-drop');if(!zone||event.target.closest('input'))return;
    const input=zone.querySelector('input[type="file"]');if(input && !input.matches(':disabled'))input.click();
  });
  document.addEventListener('keydown',event => {
    if(event.key==='Escape'&&isImporting()){event.preventDefault();cancelImport();return;}
    if(event.target.matches('[data-cu-url]')&&event.key==='Enter'){event.preventDefault();const block=event.target.closest('.cu-upload');importUrls(block.querySelector('.cu-drop'),event.target.value);return;}
    if(event.key==='Escape' && preview){closePreview();return;}
    if(preview && event.key==='Tab'){const controls=[...preview.querySelectorAll('a,button')],first=controls[0],last=controls.at(-1);if(event.shiftKey && document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first.focus();}return;}
    if(!['Enter',' '].includes(event.key))return;
    const zone=event.target.closest('.cu-drop'),img=event.target.closest('[data-cu-preview]');
    if(event.target===zone||event.target===img){event.preventDefault();event.target.click();}
  });
  function assignFiles(zone,files) {
    const input=zone.querySelector('input[type="file"]');if(!input||input.matches(':disabled'))return;
    const list=Array.from(files||[]);if(!list.length)return;
    try {list.forEach(validateFile);}catch(error){showError(zone.closest('.cu-upload'),error);return;}
    if(!input.multiple && list.length>1){showError(zone.closest('.cu-upload'),new Error('此位置每次只能上传 1 张图片，请重新选择。'));return;}
    const transfer=new DataTransfer();list.forEach(file=>transfer.items.add(file));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  }
  function eventZone(target) {
    return target.closest('.cu-upload')?.querySelector('.cu-drop')||records.find(entry=>entry.cfg.preview && document.getElementById(entry.cfg.preview)?.contains(target))?.zone;
  }
  function transferUrl(transfer) {
    const text=transfer?.getData('text/uri-list')||transfer?.getData('text/plain');if(text)return text;
    const html=transfer?.getData('text/html');if(!html)return '';
    return new DOMParser().parseFromString(html,'text/html').querySelector('img')?.getAttribute('src')||'';
  }
  document.addEventListener('click',event=>{
    if(!pendingImport)return;
    if(event.target.closest('[data-cu-cancel-import]')){cancelImport();return;}
    if((event.target.closest('[data-action="close-material"]') || event.target.id==='ctMaterialModal') && pendingImport.resolve()?.closest('#ctMaterialModal')){cancelImport();return;}
    const clear=event.target.closest('button');
    if(clear && (clear.id==='skuClearBtn'||(/Clear|clear|remove/.test(clear.id+' '+(clear.dataset.action||''))) && clear.closest('.cu-legacy-scope')))cancelImport();
  },true);
  document.addEventListener('drop',event=>{
    const zone=eventZone(event.target),url=transferUrl(event.dataTransfer);
    if(zone&&!event.dataTransfer?.files.length&&url){event.preventDefault();event.stopImmediatePropagation();importUrls(zone,url);return;}
    const target=event.target.closest('.scene-material-preview');if(!target)return;
    const record=records.find(entry=>entry.cfg.scene && entry.cfg.preview===target.id);if(!record)return;
    event.preventDefault();event.stopImmediatePropagation();assignFiles(record.zone,event.dataTransfer.files);
  },true);
  for(const name of ['dragover','dragleave','drop'])document.addEventListener(name,event=>{
    const zone=event.target.closest('.cu-drop');if(!zone)return;
    if(name==='dragover'){event.preventDefault();zone.classList.add('cu-dragging');}
    else if(name==='dragleave'){if(!zone.contains(event.relatedTarget))zone.classList.remove('cu-dragging');}
    else{event.preventDefault();zone.classList.remove('cu-dragging');if(!zone.hasAttribute('data-drop')){event.stopPropagation();assignFiles(zone,event.dataTransfer.files);}}
  });
  document.addEventListener('paste',event=>{
    const target=event.target.closest('.scene-material-preview');
    const zone=eventZone(event.target);
    if(!zone)return;
    const files=Array.from(event.clipboardData?.items||[]).filter(item=>item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);
    if(files.length){event.preventDefault();event.stopImmediatePropagation();assignFiles(zone,files);return;}
    const url=transferUrl(event.clipboardData);
    if(url){event.preventDefault();event.stopImmediatePropagation();importUrls(zone,url);}
  },true);
  document.addEventListener('change',event=>{
    const input=event.target;if(input.type!=='file'||!input.closest('.cu-upload'))return;
    if(pendingImport && pendingImport.resolve()===input && input.files?.length)cancelImport();
    const block=input.closest('.cu-upload'),status=block.querySelector('.cu-error');if(status)status.hidden=true;
    if(input.closest('[data-cu-legacy]'))try{Array.from(input.files||[]).forEach(validateFile);}catch(error){event.stopImmediatePropagation();input.value='';showError(block,error);}
  },true);
  function start() {
    decorate();let queued=false;
    new MutationObserver(mutations=>{if(queued||!mutations.some(change=>!change.target.closest?.('.cu-upload')))return;queued=true;queueMicrotask(()=>{queued=false;decorate();});}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','class']});
  }
  if(document.body)decorate();
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
