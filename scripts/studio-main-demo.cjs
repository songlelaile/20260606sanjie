#!/usr/bin/env node
'use strict';

// Local demonstration only. Production assets are read unchanged from public/.
// Analysis and generation are explicit fixtures; provider HTTP is always denied.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const repository = path.resolve(__dirname, '..');
const publicRoot = path.join(repository, 'public');
const environment = 'studio-main-local-demo-v1';
const userId = 'demo-local:visitor';
const profileId = `user:${userId}`;
const defaultPort = 18802;
const fixtureDir = path.join(os.tmpdir(), 'sanjie-studio-main-demo');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(name, body) {
  const type = Buffer.from(name), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(body.length); crc.writeUInt32BE(crc32(Buffer.concat([type, body])));
  return Buffer.concat([length, type, body, crc]);
}
function productFixture() {
  const size = 800, pixels = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1); pixels[row] = 0;
    for (let x = 0; x < size; x++) {
      let color = [249, 248, 245];
      if (((x - 400) / 220) ** 2 + ((y - 656) / 33) ** 2 < 1) color = [223, 219, 211];
      const side = Math.abs(x - 400), top = 300;
      const inBag = y >= top && y <= 640 && side < 155 + (y - top) * 0.11;
      if (inBag) color = [192 + Math.round(x / 85), 155 + Math.round(x / 105), 116 + Math.round(x / 155)];
      const handleDistance = ((x - 400) / 98) ** 2 + ((y - 285) / 123) ** 2;
      if (y < 310 && handleDistance > .78 && handleDistance < 1.08) color = [122, 84, 53];
      if (y > 300 && y < 640 && (Math.abs(x - 276) < 5 || Math.abs(x - 524) < 5)) color = [135, 97, 63];
      if (y > 435 && y < 440 && side < 90 || y > 390 && y < 437 && Math.abs(side - 88) < 3) color = [158, 119, 81];
      if (y > 326 && y < 342 && side < 157) color = [154, 111, 73];
      const offset = row + 1 + x * 3; color.forEach((channel, i) => { pixels[offset + i] = channel; });
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const label = Buffer.from('Comment\0Locally drawn demo product fixture. Not a photograph or AI model output.');
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),pngChunk('tEXt',label),pngChunk('IDAT',zlib.deflateSync(pixels)),pngChunk('IEND',Buffer.alloc(0))]);
}

function setupScript(origin, missingApi=false) {
  const config = { provider:'openai-compatible', imageAdapter:'generic-json', visionBaseUrl:`${origin}/__demo/model-disabled`, visionModel:'demo-analysis-fixture', textModel:'demo-analysis-fixture', imageEndpoint:`${origin}/__demo/model-disabled`, imageModel:'demo-image-fixture', apiKey:missingApi?'':'LOCAL_DEMO_NOT_A_REAL_API_KEY' };
  const prefix = `sz.chrome.local.v1:environment:${encodeURIComponent(environment)}:account:${encodeURIComponent(userId)}:`;
  const profile = { version:2, configs:{}, legacyConfigImports:{}, accounts:{[profileId]:{activeProvider:config.provider,configs:{[config.provider]:config}}} };
  return `<script>window.__SANJIE_ENVIRONMENT=${JSON.stringify(environment)};window.__STUDIO_MAIN_DEMO__=true;window.__DEMO_NATIVE_FETCH=window.fetch.bind(window);localStorage.setItem(${JSON.stringify(prefix+'sz_image_prompt_lab_config_profiles_v2')},${JSON.stringify(JSON.stringify(profile))});localStorage.setItem(${JSON.stringify(prefix+'sz_image_prompt_lab_config')},${JSON.stringify(JSON.stringify({...config,accountKey:profileId}))});document.addEventListener('securitypolicyviolation',function(event){window.__DEMO_NATIVE_FETCH('/__demo/event',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'csp-blocked',directive:event.violatedDirective,url:event.blockedURI})}).catch(function(){});});</script>`;
}

function bridgeScript(missingApi) {
  return `<script>
  (()=>{'use strict';
    const bridge=window.SZ_CREATIVE_TOOLS_BRIDGE;
    const missingApi=${missingApi===undefined?'window.__STUDIO_MAIN_DEMO_MISSING_API__===true':JSON.stringify(missingApi)};
    if(!bridge)throw new Error('Demo bridge cannot attach before promptlab.');
    const nativeFetch=window.__DEMO_NATIVE_FETCH;
    const record=(type,detail={})=>nativeFetch('/__demo/event',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type,...detail})}).catch(()=>{});
    const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
    const loadImage=url=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('演示素材无法读取。'));image.src=url;});
    bridge.analyze=async input=>{
      if(missingApi)return {ok:false,error:'当前演示账号尚未配置生图 API。'};
      await record('fixture-analysis',{products:(input.products||[]).length});await delay(700);
      return {ok:true,demoFixture:true,data:'【本地交互演示 · 分析示例】输入产品图已读取。以下为预设演示描述：棕色手提袋，完整主体、双提手与正面口袋。仅演示分析、方案编辑和生成流程，请依据实际商品核对；未调用视觉模型。'};
    };
    const originalSend=bridge.send;
    bridge.send=async(type,message)=>{
      if(type!=='GENERATE_IMAGE')return originalSend(type,message);
      if(missingApi)return {ok:false,definitiveFailure:true,error:'当前演示账号尚未配置生图 API。'};
      const payload=message&&message.payload||{};
      const rawRatio=String(payload.ratio||payload.aspectRatio||'1:1').split(':').map(Number);
      const ratio=rawRatio.length===2&&rawRatio.every(n=>n>0)?rawRatio[0]/rawRatio[1]:1;
      const width=ratio>=1?1024:Math.max(160,Math.round(1024*ratio));
      const height=ratio>=1?Math.max(160,Math.round(1024/ratio)):1024;
      await record('fixture-generation',{jobId:message.jobId,ratio:payload.ratio||'',quality:payload.quality||'auto',generationSpeed:payload.generationSpeed||'standard',width,height});await delay(1000);
      const image=await loadImage((payload.productImages||[])[0]||'/__demo/product.png');
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d');
      const backdrop=context.createLinearGradient(0,0,width,height);backdrop.addColorStop(0,'#f8f6ee');backdrop.addColorStop(1,'#e7e0d3');context.fillStyle=backdrop;context.fillRect(0,0,width,height);
      const scale=Math.min(width*.8/image.width,height*.67/image.height),drawWidth=image.width*scale,drawHeight=image.height*scale;
      context.drawImage(image,(width-drawWidth)/2,(height-drawHeight)/2,drawWidth,drawHeight);
      const pad=Math.max(12,Math.round(Math.min(width,height)*.025));context.fillStyle='#473928';context.font='bold '+Math.max(16,Math.round(Math.min(width,height)*.032))+'px sans-serif';context.fillText('本地演示样图',pad,pad*2);
      context.font=Math.max(12,Math.round(Math.min(width,height)*.021))+'px sans-serif';context.fillText('预设素材排版 · 未调用付费模型',pad,height-pad);
      return {ok:true,images:[canvas.toDataURL('image/png')],demoFixture:true,taskId:'local-demo-'+message.jobId};
    };
    const originalArchive=bridge.archive;
    bridge.archive=async(item,captured)=>{const result=await originalArchive({...item,demoFixture:true,demoLabel:'本地演示样图，未调用付费模型'},captured);await record('local-archive',{ok:!!result?.ok,resultId:item.resultId});return result;};
    bridge.modelInfo=()=>({provider:'openai-compatible',model:'demo-image-fixture',adapter:'generic-json',imageAdapter:'generic-json',qualityOptions:['auto','low','medium','high'],generationSpeeds:['standard'],ready:!missingApi,supportsReference:true,resolutions:['0.5K','1K','2K','4K'],specificationHint:'本地演示样图；未调用模型。'});
    bridge.listBoundApis=async()=>({ok:true,accountKey:await bridge.getAccountKey(),providers:missingApi?[]:[{provider:'openai-compatible',label:'本地演示（预设响应）',imageModel:'demo-image-fixture',imageAdapter:'generic-json'}]});
    document.addEventListener('DOMContentLoaded',()=>{
      const banner=document.createElement('div');banner.id='studio-main-demo-banner';banner.textContent=(missingApi?'未配置 API 场景 · ':'')+'本地交互演示 · 未调用付费模型';banner.setAttribute('role','status');banner.style.cssText='position:fixed;top:0;left:0;right:0;z-index:2147483600;padding:8px 12px;text-align:center;background:#fff5d6;color:#68510e;font:12px/1.5 sans-serif;box-shadow:0 1px 0 #e9daa8;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px 12px';
      const fixtureButton=document.createElement('button');fixtureButton.type='button';fixtureButton.id='studio-demo-fixture-input';fixtureButton.textContent='载入本地合成示例图';fixtureButton.disabled=true;fixtureButton.style.cssText='padding:5px 10px;border:1px solid #a78535;border-radius:5px;background:#fff;color:#513d0c;font:inherit;cursor:pointer';
      const fixtureStatus=document.createElement('span');fixtureStatus.id='studio-demo-fixture-input-status';fixtureStatus.textContent='仅供本地 QA：合成素材导入，不验证系统文件选择器。';fixtureButton.setAttribute('aria-describedby',fixtureStatus.id);banner.append(fixtureButton,fixtureStatus);document.body.prepend(banner);
      const fitBanner=()=>{document.body.style.paddingTop=Math.ceil(banner.getBoundingClientRect().height)+'px';};fitBanner();
      if(typeof ResizeObserver==='function')new ResizeObserver(fitBanner).observe(banner);
      let fixtureLoading=false;
      const fixtureInput=()=>{
        if(document.documentElement.dataset.studioStartup!=='ready'||document.documentElement.dataset.labStartup!=='ready')return null;
        return Array.from(document.querySelectorAll('#studioGenesisRoot input[type="file"][data-files]')).find(input=>!input.disabled)||null;
      };
      const syncFixtureButton=()=>{const available=!!fixtureInput(),disabled=fixtureLoading||!available;if(fixtureButton.disabled!==disabled)fixtureButton.disabled=disabled;fixtureButton.title=disabled?'请等待工作台就绪、产品图输入可用后再载入。':'通过正常产品图输入导入本地合成 PNG；不验证系统文件选择器。';};
      new MutationObserver(syncFixtureButton).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','data-lab-startup','data-studio-startup']});syncFixtureButton();
      fixtureButton.addEventListener('click',async()=>{
        const input=fixtureInput();
        if(fixtureLoading||!input){fixtureStatus.textContent='工作台尚未就绪或正在处理，请稍后再载入。';await record('fixture-input',{phase:'blocked',reason:'product-input-unavailable',nativePicker:false});return;}
        fixtureLoading=true;syncFixtureButton();fixtureStatus.textContent='正在载入同源本地合成 PNG…';
        await record('fixture-input',{phase:'attempt',nativePicker:false,method:'visible-demo-button-file-input-change',taskId:input.dataset.files});
        try{
          if(typeof File!=='function'||typeof DataTransfer!=='function')throw new Error('浏览器不支持本地示例导入；可下载演示图后手动选择。');
          const response=await nativeFetch('/__demo/product.png',{cache:'no-store'});
          if(!response.ok||!String(response.headers.get('content-type')||'').startsWith('image/png'))throw new Error('本地合成示例图无法读取，请稍后重试。');
          const blob=await response.blob();
          if(fixtureInput()!==input){fixtureStatus.textContent='工作台状态已变化，示例图尚未导入，请再次点击。';await record('fixture-input',{phase:'blocked',reason:'product-input-changed',nativePicker:false});return;}
          const file=new File([blob],'local-synthetic-demo-tote.png',{type:'image/png',lastModified:Date.now()}),transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;
          input.dispatchEvent(new Event('change',{bubbles:true}));
          fixtureStatus.textContent='已交给正常产品图输入，请核对缩略图。合成素材 QA，不代表系统选择器上传验收。';
          await record('fixture-input',{phase:'dispatched',nativePicker:false,method:'visible-demo-button-file-input-change',taskId:input.dataset.files,fileName:file.name,bytes:file.size});
        }catch(error){fixtureStatus.textContent=error.message||'本地合成示例导入失败，请重试。';await record('fixture-input',{phase:'failed',nativePicker:false,reason:'fixture-input-failed'});}
        finally{fixtureLoading=false;syncFixtureButton();}
      });
      const demoLink=anchor=>{if(!anchor||!anchor.hasAttribute('href'))return;const url=new URL(anchor.getAttribute('href'),location.href);if(url.origin===location.origin&&url.pathname.endsWith('/promptlab.html')&&url.searchParams.get('studio')==='1'&&url.searchParams.get('demo')!=='1'){url.searchParams.set('demo','1');anchor.setAttribute('href',url.pathname+url.search+url.hash);}};
      const rewriteLinks=()=>document.querySelectorAll('a[href]').forEach(demoLink);
      rewriteLinks();new MutationObserver(rewriteLinks).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['href']});
      document.addEventListener('click',event=>demoLink(event.target.closest('a[href]')),true);
      document.addEventListener('click',event=>{const action=event.target.closest('[data-action]');if(action)record('ui-action',{action:action.dataset.action});});
      record('bridge-ready');
    },{once:true});
  })();
  </script>`;
}

function shell() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>三阶引擎 · 主图本地演示</title><style>
  *{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0c1307;color:#d5d9c9}button,a{font:inherit}button{cursor:pointer}aside{position:fixed;inset:0 auto 0 0;width:210px;padding:20px 13px;border-right:1px solid #303915}h1{font-size:18px;margin:0;color:#f5ebc2}.brand{display:flex;gap:10px;align-items:center;margin-bottom:28px}.brand b{background:#ffcf65;border-radius:6px;color:#352e11;padding:6px 10px;font-size:22px}.brand small{font-size:11px;display:block;color:#abb291}.shop{padding:12px;border:1px solid #35421b;border-radius:7px;margin-bottom:31px}.shop small{display:block;font-size:11px}.shop strong{display:block;margin-top:10px;color:#f3deb3}.nav{display:grid;gap:8px}.nav span{padding:10px;border-radius:6px}.nav .selected{background:#f6cf72;color:#312c13;font-weight:700}aside footer{position:absolute;bottom:18px;left:22px;font-size:11px;color:#aeb69c}.work{margin:12px 12px 12px 222px;border:1px solid #35421b;border-radius:12px;height:calc(100vh - 24px);overflow:hidden;display:flex}.tools{width:132px;flex:none;border-right:1px solid #35421b;padding:20px 10px;background:#101807}.tools small{font-size:11px;color:#a9b196}.tools button,.tools span{display:block;width:100%;border:0;background:transparent;color:#d5d9c9;text-align:left;margin:5px 0;padding:9px 11px;border-radius:6px}.tools button.active{color:#332d12;background:#f6cf72;font-weight:700}.main{flex:1;min-width:0;display:flex;flex-direction:column}.top{height:55px;display:flex;align-items:center;justify-content:space-between;padding:0 22px;border-bottom:1px solid #35421b;background:#101807}.top small{color:#aeb698}.top button{border:1px solid #ccab53;background:#f6cf72;border-radius:5px;padding:7px 13px;color:#382e10;font-size:12px}.demo-meta{display:flex;gap:8px;align-items:center}.demo-meta a{font-size:11px;color:#d9d6af;text-decoration:none}.main iframe{display:block;width:100%;border:0;flex:1;background:#f8f9fb}.fixture-help{position:fixed;bottom:16px;left:14px;right:auto;width:184px;background:#17220c;padding:8px;border-radius:6px;font-size:11px}.fixture-help a{color:#ffcf65}
  @media(max-width:900px){aside{width:155px}.work{margin-left:166px}.tools{width:110px}.fixture-help{width:129px}.top{padding:0 12px}}
  </style></head><body>
  <aside><div class="brand"><b>▧</b><div><h1>三阶引擎</h1><small>本地演示 · 作图流程</small></div></div><div class="shop"><small>当前演示店铺</small><strong>演示商品素材</strong></div><div class="nav"><span>◌　Sower Work</span><span class="selected">▧　图像创作</span><span>▱　视频创作</span><span>♧　三阶报告</span><span>✧　AI 工具</span><span>♧　模型网关</span><span>◌　管理</span></div><footer>本机独立演示账号</footer></aside>
  <div class="work"><nav class="tools"><small>图像创作</small><button class="active" data-route="main">▧　主图</button><button data-route="detail">▤　详情</button><button data-route="ad">✧　广告图</button><span>⌗　参考成详</span><span>▱　批量 SKU</span><span>▧　案例裂变</span><span>◉　风格焕新</span><span>↗　场景延展</span><span>♧　DIY成图</span><span>▣　买家秀</span><span>✣　产品精修</span><small>视频创作</small><span>▱　生成视频</span><button data-route="batch">▱　批量任务</button></nav><main class="main"><header class="top"><small>创作工作台　›　<span id="route-label">主图</span></small><div class="demo-meta"><a href="/__demo/metrics" target="_blank">演示调用记录</a><button data-route="batch">＋ 创建批量任务</button></div></header><iframe id="studio" title="主图创作本地交互演示" src="/creative/labs/image-prompt-lab/promptlab.html?source=web&studio=1&demo=1"></iframe></main></div>
  <div class="fixture-help">演示素材：<a href="/__demo/product.png" download="demo-product-tote.png">下载产品图 PNG</a><br>分析与生成均为预设样例。<p id="demo-navigation-message" role="status"></p></div>
  <script>
  (()=>{
    const frame=document.getElementById('studio'),labels={main:'主图',detail:'详情图',ad:'广告图',batch:'批量任务'};
    let frameObserver;
    function select(route){document.getElementById('route-label').textContent=labels[route]||labels.main;frame.title=(labels[route]||labels.main)+'创作本地交互演示';document.querySelectorAll('.tools button').forEach(button=>button.classList.toggle('active',button.dataset.route===route));}
    document.querySelectorAll('[data-route]').forEach(button=>button.addEventListener('click',async()=>{
      const route=button.dataset.route,guard=frame.contentWindow?.SanjieStudioGenesisBridge;
      if(guard){const result=await guard.canDeactivate();if(!result.allowed){document.getElementById('demo-navigation-message').textContent=result.reason||'当前任务尚未结束';return;}}
      document.getElementById('demo-navigation-message').textContent='';
      frame.src='/creative/labs/image-prompt-lab/promptlab.html?source=web&studio=1&demo=1'+(route==='detail'?'&mode=detail':route==='ad'?'&type=ad':route==='batch'?'&batch=1':'');select(route);
    }));
    frame.addEventListener('load',()=>{
      if(frameObserver)frameObserver.disconnect();
      const doc=frame.contentDocument;
      if(!doc)return;
      const sync=()=>{const params=new URLSearchParams(frame.contentWindow.location.search),selected=doc.querySelector('[data-action="mode"][aria-selected="true"]');if(params.get('batch')==='1')select('batch');else if(selected)select(selected.dataset.mode);};
      sync();frameObserver=new MutationObserver(sync);frameObserver.observe(doc.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-selected']});
      doc.addEventListener('click',event=>{if(event.target.closest('[data-action="mode"]'))setTimeout(sync,0);});
    });
  })();
  </script>
  </body></html>`;
}

function createDemoServer({port=defaultPort,bundled=false}={}) {
  // Optional production entry packaging, with the same explicit local-only
  // analysis/generation fixtures. Run this mode with node --import tsx.
  const entry = bundled ? require('../src/lib/creative-entry-bundle.ts') : null;
  const metrics = { startedAt:new Date().toISOString(), environment, fixtureInputAttempts:0, fixtureInputDispatched:0, fixtureInputBlocked:0, fixtureInputFailures:0, fixtureAnalysis:0, fixtureGeneration:0, localArchives:0, blockedProxyRequests:0, blockedOtherApiRequests:0, outboundProviderRequests:0, events:[], requests:{} };
  const png = productFixture(); fs.mkdirSync(fixtureDir,{recursive:true});
  const productPath=path.join(fixtureDir,'demo-product-tote.png');fs.writeFileSync(productPath,png);
  const origin = `http://127.0.0.1:${port}`;
  const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.woff2':'font/woff2'};
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,origin),route=decodeURIComponent(url.pathname);
    metrics.requests[route]=(metrics.requests[route]||0)+1;
    res.setHeader('cache-control','no-store');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'");
    function send(status,value,type='application/json; charset=utf-8'){res.writeHead(status,{'content-type':type});res.end(typeof value==='object'&&!Buffer.isBuffer(value)?JSON.stringify(value,null,2):value);}
    if(route==='/api/auth/me')return send(200,{data:{username:'visitor',tenantId:'demo-local',name:'本地演示账号',creativeEntitlement:{allowed:true,demo:true}}});
    if(route==='/api/creative/credits')return send(200,{data:{centsPerPoint:10,plan:{code:'local-demo',name:'本地演示',multiplierBps:10000,ruleVersion:1},models:[],observedAt:new Date().toISOString()}});
    if(route==='/api/creative/proxy'||route==='/__demo/model-disabled'){metrics.blockedProxyRequests++;return send(403,{ok:false,code:'LOCAL_DEMO_PROVIDER_BLOCKED',error:'本地演示禁止模型网络调用。'});}
    if(route.startsWith('/api/')){metrics.blockedOtherApiRequests++;return send(403,{ok:false,code:'LOCAL_DEMO_API_BLOCKED',error:'该接口不属于本地演示范围。'});}
    if(route==='/__demo/metrics')return send(200,{...metrics,bundled,productPath,productSha256:crypto.createHash('sha256').update(png).digest('hex'),mode:'actual public UI + explicit mock analysis and generation',providerNetworkPolicy:'No server outbound networking. All provider proxy routes return 403. Browser CSP allows only this origin, blob and data.'});
    if(route==='/__demo/product.png')return send(200,png,'image/png');
    if(route==='/__demo/event'&&req.method==='POST'){
      let body='';for await(const part of req){body+=part;if(body.length>16384){req.destroy();return;}}
      try{const event=JSON.parse(body);if(event.type==='fixture-input'){if(event.phase==='attempt')metrics.fixtureInputAttempts++;if(event.phase==='dispatched')metrics.fixtureInputDispatched++;if(event.phase==='blocked')metrics.fixtureInputBlocked++;if(event.phase==='failed')metrics.fixtureInputFailures++;}if(event.type==='fixture-analysis')metrics.fixtureAnalysis++;if(event.type==='fixture-generation')metrics.fixtureGeneration++;if(event.type==='local-archive'&&event.ok)metrics.localArchives++;metrics.events.push({...event,at:new Date().toISOString()});metrics.events=metrics.events.slice(-1000);return send(200,{ok:true});}catch{return send(400,{ok:false});}
    }
    if(route==='/'||route==='/demo'||route==='/dashboards/operating-network')return send(200,shell(),'text/html; charset=utf-8');
    const target=path.resolve(publicRoot,`.${route}`);
    if(!target.startsWith(publicRoot+path.sep))return send(403,{ok:false});
    try{
      const entryPath = route.replace(/^\/creative\//,'');
      let source;
      if(entry && entry.isCreativeEntryPath(entryPath)) {
        const packed = await entry.loadCreativeEntryBundle(path.join(publicRoot,'creative'));
        source = entryPath===entry.CREATIVE_ENTRY_HTML ? packed.html : entryPath===entry.CREATIVE_ENTRY_CSS ? packed.css : packed.js;
        if(entryPath===entry.CREATIVE_ENTRY_JS) {
          const marker='/* Source: labs/image-prompt-lab/creative-tools-ui.js */';
          if(!source.includes(marker))throw new Error('Missing demo fixture bridge insertion point');
          source=source.replace(marker,bridgeScript().replace(/^<script>\s*|\s*<\/script>$/g,'')+'\n;\n'+marker);
        }
      } else {
        const stat=fs.statSync(target);if(!stat.isFile())return send(404,{ok:false,error:'Not found'});
        source=fs.readFileSync(target);
      }
      if(route==='/creative/labs/image-prompt-lab/promptlab.html'&&url.searchParams.get('demo')==='1'){
        const missingApi=url.searchParams.get('demoApi')==='missing';
        source=source.toString().replace(/(<script src="\/creative\/web-chrome\.js(?:\?[^"<>]*)?"><\/script>)/,`${setupScript(origin,missingApi)}$1`).replace(/(<script src="creative-tools-ui\.js[^>]+><\/script>)/,`${bridgeScript(missingApi)}$1`);
        if(bundled)source=source.replace('<head>','<head><script>window.__STUDIO_MAIN_DEMO_MISSING_API__='+JSON.stringify(missingApi)+';</script>');
      }
      return send(200,source,mime[path.extname(target)]||'application/octet-stream');
    }catch{return send(404,{ok:false,error:'Not found'});}
  });
  return {server,metrics,productPath,origin};
}

if(require.main===module){
  const portArgument=process.argv.indexOf('--port');const port=portArgument>=0?Number(process.argv[portArgument+1]):defaultPort;
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Port must be an integer from 1024 to 65535.');
  const demo=createDemoServer({port,bundled:process.argv.includes('--bundle')});demo.server.listen(port,'127.0.0.1',()=>process.stdout.write(JSON.stringify({url:demo.origin,iframe:`${demo.origin}/creative/labs/image-prompt-lab/promptlab.html?source=web&studio=1&demo=1`,productPath:demo.productPath,metrics:`${demo.origin}/__demo/metrics`,pid:process.pid})+'\n'));
  const close=()=>demo.server.close(()=>process.exit(0));process.on('SIGINT',close);process.on('SIGTERM',close);
}
module.exports={createDemoServer,productFixture};
