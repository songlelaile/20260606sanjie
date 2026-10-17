/* Local browser acceptance. No provider, production account or production service is used. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('/Users/shaozhuang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname,'..'), assets=path.join(root,process.env.CREATIVE_ASSET_TEST_ROOT||'public/creative','..'), output=path.join(root,process.env.CREATIVE_UPLOAD_OUTPUT_DIR||'.codex-deploy/image-upload-20261002-v2');
fs.mkdirSync(output,{recursive:true});
const checks=[],errors=[],requests=[],imageRequests=[];
const startedAt=Date.now(),timings={};
let browser,server,page,fixtureImage,fixtureSecond;
const check=(name,passed,detail)=>{checks.push({name,passed:Boolean(passed),detail});if(!passed)throw new Error(name+': '+JSON.stringify(detail));};
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'};
const routes=[
  ['main','?source=web&studio=1'],['detail','?mode=detail&source=web&studio=1'],['batch','?source=web&studio=1&batch=1'],
  ['clothing','?mode=creative&tool=clothing&source=web'],['buyer','?mode=creative&tool=buyer&source=web'],['refinement','?mode=creative&tool=refinement&source=web'],
  ['reference','?mode=detail&detailMode=reference&source=detail-reference&layout=1'],['sku','?mode=sku&source=web&layout=1'],['viral','?mode=viral&source=web&layout=1'],['legacy-main','?source=web']
];
async function main(){
  server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/api/auth/me'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:{id:'image-upload-fixture',tenantId:'upload-uat',username:'fixture',creativeEntitlement:{allowed:true}}}));return;}
    if(url.pathname==='/api/creative/proxy'){
      let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{
        const data=JSON.parse(body);imageRequests.push({url:data.url,method:data.method});
        if(data.method!=='GET'||!/^https:\/\/img\.alicdn\.com\/upload-uat\/(?:first|second|slow|broken)\.png(?:\?replacement)?$/.test(data.url)){res.writeHead(403,{'Content-Type':'application/json'});res.end('{"error":"Fixture only allows image GET"}');return;}
        const fixturePath=new URL(data.url).pathname;
        const respond=()=>{const bytes=fixturePath.endsWith('/broken.png')?Buffer.from('not an image'):fixturePath.endsWith('/second.png')?fixtureSecond:fixtureImage;res.writeHead(200,{'Content-Type':'image/png','Content-Length':bytes.length});res.end(bytes);};
        if(fixturePath.endsWith('/slow.png'))setTimeout(respond,500);else respond();
      });return;
    }
    if(url.pathname.startsWith('/api/')){requests.push({path:url.pathname,method:req.method});res.writeHead(403,{'Content-Type':'application/json'});res.end('{"error":"Local upload acceptance does not call providers"}');return;}
    const file=path.resolve(assets,'.'+decodeURIComponent(url.pathname));
    if(!file.startsWith(assets+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end('Not found');return;}
    const content=fs.readFileSync(file);
    res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.end(content);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port, base=origin+'/creative/labs/image-prompt-lab/promptlab.html';
  browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const context=await browser.newContext({viewport:{width:1440,height:1100}});
  await context.addInitScript(()=>{window.__SANJIE_ENVIRONMENT='image-upload-20261002';});
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'?source=web&studio=1');
  const png=Buffer.from(await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=300;canvas.height=200;const ctx=canvas.getContext('2d');ctx.fillStyle='#ed9137';ctx.fillRect(0,0,300,200);ctx.fillStyle='#26331f';ctx.fillRect(75,40,150,120);return canvas.toDataURL('image/png').split(',')[1];}),'base64');
  const fixture={name:'local-product.png',mimeType:'image/png',buffer:png};
  const second=Buffer.from(await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=300;canvas.height=200;canvas.getContext('2d').fillRect(0,0,300,200);return canvas.toDataURL('image/png').split(',')[1];}),'base64');
  fixtureImage=png;fixtureSecond=second;
  for(const [name,query] of routes){
    await page.goto(base+query);await page.waitForFunction(()=>window.SZ_IMAGE_UPLOAD && window.SZ_CREATIVE_TOOLS_BRIDGE);
    if(['main','detail','batch'].includes(name))await page.locator('#studioGenesisRoot .cu-upload').first().waitFor();
    if(['clothing','buyer','refinement'].includes(name))await page.locator('#creativeToolsRoot .cu-upload').first().waitFor();
    await page.waitForFunction(()=>[...document.querySelectorAll('input[type="file"][accept*="image/"]')].filter(input=>!input.hidden).every(input=>input.closest('.cu-upload')));
    const geometry=await page.locator('.cu-drop').evaluateAll(nodes=>nodes.filter(node=>node.getClientRects().length).map(node=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);return {width:r.width,height:r.height,radius:s.borderRadius,border:s.borderStyle};}));
    check(name+' image inputs all share upload component',true);
    check(name+' visible zones match dimensions',geometry.every(item=>item.width<=308.1&&item.height===128&&item.radius==='12px'&&item.border==='dashed'),geometry);
    if(['main','detail','batch'].includes(name)){
      const zone=page.locator('#studioGenesisRoot .cu-drop').first();await page.waitForFunction(()=>!document.querySelector('#studioGenesisRoot [data-files]').disabled);
      const chooserPromise=page.waitForEvent('filechooser');await zone.click();const chooser=await chooserPromise;await chooser.setFiles(fixture);
      await page.locator('#studioGenesisRoot .sg-asset').first().waitFor();
      const count=await zone.locator('..').locator('[data-cu-count]').textContent();check(name+' native full zone click uploads once',count==='1/6',count);
      const image=await page.locator('#studioGenesisRoot .sg-asset img').first().getAttribute('src');check(name+' uploaded bytes retained',sha(Buffer.from(image.split(',')[1],'base64'))===sha(png));
      await page.locator('#studioGenesisRoot .sg-asset img').first().click();await page.locator('#sgPreview').waitFor({state:'visible'});await page.keyboard.press('Escape');
      await page.getByRole('button',{name:'移除产品图 1',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#studioGenesisRoot .sg-asset'));
      check(name+' remove updates count',await zone.locator('..').locator('[data-cu-count]').textContent()==='0/6');
      if(name==='main')await page.locator('#studioGenesisRoot .sg-card').first().screenshot({path:path.join(output,'main-upload-empty.png')});
    }
    if(['clothing','buyer','refinement'].includes(name)){
      await page.locator('[data-upload="products"]').setInputFiles(fixture);await page.locator('#ctProductGrid img').first().waitFor();
      check(name+' product count',await page.locator('[data-drop="products"]').locator('..').locator('[data-cu-count]').textContent()===(name==='refinement'?'1/50':'1/6'));
      await page.locator('#ctProductGrid .ct-asset-preview').first().click();await page.locator('#ctPreviewModal').waitFor({state:'visible'});await page.getByRole('button',{name:'关闭 ×',exact:true}).click();
      if(name==='clothing'){
        await page.getByRole('button',{name:'素材库 / AI 生成',exact:true}).first().click();
        await page.locator('#ctMaterialModal .cu-drop').waitFor({state:'visible'});
        check('material library modal uses shared upload',await page.locator('#ctMaterialModal .cu-drop').count()===1);
        await page.locator('#ctMaterialModal [data-upload="model"]').setInputFiles(fixture);await page.locator('#ctMaterialHistory img').first().waitFor();
        await page.locator('#ctMaterialModal [data-action="close-material"]').click();
        await page.getByRole('tab',{name:'基础套图',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('#creativeToolsRoot .cu-drop').length===1);check('clothing basic uses shared product upload',true);
      }
    }
    await page.screenshot({path:path.join(output,name+'-workspace.png'),fullPage:true});
  }
  await page.goto(base+'?source=web&studio=1');await page.waitForFunction(()=>document.querySelector('#studioGenesisRoot [data-files]')&&!document.querySelector('#studioGenesisRoot [data-files]').disabled);
  const mainZone=page.locator('#studioGenesisRoot .cu-drop');
  async function transfer(zone,event,bytes=second){await zone.evaluate((element,{event,base64})=>{const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(base64),char=>char.charCodeAt(0))],'local-paste.png',{type:'image/png'}));element.dispatchEvent(event==='paste'?new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}):new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));},{event,base64:bytes.toString('base64')});}
  await transfer(mainZone,'drop');await page.waitForFunction(()=>document.querySelectorAll('#studioGenesisRoot .sg-asset').length===1);check('main drag uploads once',true);
  await page.getByRole('button',{name:'移除产品图 1',exact:true}).click();await transfer(mainZone,'paste');await page.waitForFunction(()=>document.querySelectorAll('#studioGenesisRoot .sg-asset').length===1);check('main paste uploads once',true);
  await page.goto(base+'?mode=sku&source=web&layout=1');const skuZone=page.locator('#skuProductFiles').locator('..');await skuZone.waitFor({state:'visible'});
  await transfer(skuZone,'drop',png);await page.waitForFunction(()=>document.querySelectorAll('#skuProductPreview img').length===1);check('legacy SKU drag uploads once',true);
  const original=await page.evaluate(async()=>{const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('sz_image_upload_originals_v1:environment:image-upload-20261002');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});const list=await new Promise(resolve=>{const request=db.transaction('originals').objectStore('originals').getAll();request.onsuccess=()=>resolve(request.result);});return Promise.all(list.map(async item=>({name:item.name,bytes:Array.from(new Uint8Array(await item.blob.arrayBuffer())),owner:item.accountKey})));});
  check('legacy compressed upload retains original bytes',original.some(item=>sha(Buffer.from(item.bytes))===sha(png)),original.map(item=>({name:item.name,size:item.bytes.length,owner:item.owner})));
  await page.locator('#skuProductPreview img').first().click();await page.locator('.cu-dialog').waitFor({state:'visible'});const downloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:'下载原图',exact:true}).click();const download=await downloadPromise;await download.saveAs(path.join(output,'downloaded-original.png'));check('legacy original download matches uploaded hash',sha(fs.readFileSync(path.join(output,'downloaded-original.png')))===sha(png));await page.keyboard.press('Escape');
  await page.locator('#skuProductFiles').setInputFiles({name:'bad.txt',mimeType:'text/plain',buffer:Buffer.from('bad')});check('non-image has visible validation',await skuZone.locator('..').locator('.cu-error').isVisible());
  await page.locator('#skuProductFiles').setInputFiles({name:'broken.png',mimeType:'image/png',buffer:Buffer.from('invalid png')});await page.waitForFunction(()=>document.getElementById('skuState').textContent.includes('无法解码'));check('corrupt legacy image leaves count intact',await page.locator('#skuProductPreview img').count()===1);
  await page.locator('#skuProductFiles').setInputFiles({name:'empty.png',mimeType:'image/png',buffer:Buffer.alloc(0)});check('empty image rejected visibly',await skuZone.locator('..').locator('.cu-error').textContent().then(text=>text.includes('空文件')));
  await page.locator('#skuProductFiles').setInputFiles({name:'large.png',mimeType:'image/png',buffer:Buffer.alloc(20*1024*1024+1)});check('oversize image rejected visibly',await skuZone.locator('..').locator('.cu-error').textContent().then(text=>text.includes('20 MB')));
  const keyboardChooser=page.waitForEvent('filechooser',{timeout:5000});await skuZone.press('Enter');const keyboardFiles=await keyboardChooser;await keyboardFiles.setFiles([]);check('keyboard Enter opens native image chooser',true);
  await page.evaluate(()=>chooseImportedSkuReplacement({skuCode:'LOCAL-UAT',source:'taobao-sku-scan'}));await page.locator('.cu-picker .cu-drop').waitFor();check('SKU row replacement has shared upload dialog',await page.locator('.cu-picker [data-cu-count]').textContent()==='0/1');await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.evaluate(async base64=>{const file=new File([Uint8Array.from(atob(base64),char=>char.charCodeAt(0))],'variants.png',{type:'image/png'});await SZ_IMAGE_UPLOAD.retainOriginal(file,'variant-a');await SZ_IMAGE_UPLOAD.retainOriginal(file,'variant-b');await Promise.all([SZ_IMAGE_UPLOAD.openPreview('variant-a','版本 A',true),SZ_IMAGE_UPLOAD.openPreview('variant-b','版本 B',true)]);},png.toString('base64'));
  check('concurrent previews leave one dialog',await page.locator('.cu-modal').count()===1);check('multiple derivative mappings retain original lookup',(await page.locator('.cu-dialog a').getAttribute('href')).startsWith('blob:'));await page.keyboard.press('Escape');
  await page.goto(base+'?mode=viral&source=web&layout=1');await page.locator('#viralSceneModeBtn').click();await page.locator('#sceneMaterialPanel .cu-drop').first().waitFor({state:'visible'});
  check('scene extension four roles use shared upload',await page.locator('#sceneMaterialPanel .cu-drop').count()===4);
  const sceneGeometry=await page.locator('#sceneMaterialPanel .cu-drop').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {width:r.width,height:r.height};}));check('scene four zones keep full reference dimensions',sceneGeometry.every(item=>item.width===308&&item.height===128),sceneGeometry);
  await page.locator('#sceneFrontFile').setInputFiles(fixture);await page.locator('#sceneFrontPreview img').waitFor();await page.waitForFunction(()=>document.getElementById('sceneFrontFile').closest('.cu-upload').querySelector('[data-cu-count]').textContent==='1/1');check('scene front role count updates once',true);
  await page.locator('#sceneFrontPreview img').click();await page.locator('.cu-dialog').waitFor();check('scene original preview resolves stored upload',(await page.locator('.cu-dialog a').getAttribute('href')).startsWith('blob:'));await page.keyboard.press('Escape');
  await page.locator('#sceneMaterialName').fill('本地测试产品');await page.locator('#sceneSameMaterial').check();await page.locator('#scenePlanBtn').click();
  check('scene plan available before replacement',await page.evaluate(()=>Boolean(SZ_SCENE_EXTENSION_CONTROLLER.state.plan)));
  await page.evaluate(()=>{window.__originalRetain=SZ_IMAGE_UPLOAD.retainOriginal;SZ_IMAGE_UPLOAD.retainOriginal=async(...args)=>{await new Promise(resolve=>{window.__releaseSceneRetain=resolve;});return window.__originalRetain(...args);};});
  await page.locator('#sceneFrontFile').setInputFiles({name:'replacement.png',mimeType:'image/png',buffer:second});await page.waitForFunction(()=>typeof window.__releaseSceneRetain==='function');
  check('scene pending original save invalidates old plan',await page.evaluate(()=>SZ_SCENE_EXTENSION_CONTROLLER.state.plan===null));
  check('scene pending original save blocks plan and generation',await page.evaluate(()=>document.getElementById('scenePlanBtn').disabled&&document.getElementById('sceneGenerateBtn').disabled));
  await page.locator('#sceneFrontClear').click();await page.evaluate(()=>{window.__releaseSceneRetain();SZ_IMAGE_UPLOAD.retainOriginal=window.__originalRetain;delete window.__releaseSceneRetain;});
  await page.waitForFunction(()=>!document.getElementById('scenePlanBtn').disabled);
  check('scene remove during pending save cancels replacement',await page.locator('#sceneFrontPreview img').count()===0);
  await page.evaluate(()=>{SZ_IMAGE_UPLOAD.retainOriginal=async()=>{throw new Error('本地测试：原件保存失败');};});
  await page.locator('#sceneFrontFile').setInputFiles(fixture);await page.waitForFunction(()=>document.getElementById('sceneState').textContent.includes('本地测试：原件保存失败'));
  check('scene original save failure leaves upload empty and unlocked',await page.evaluate(()=>!document.querySelector('#sceneFrontPreview img')&&!document.getElementById('scenePlanBtn').disabled));
  await page.evaluate(()=>{SZ_IMAGE_UPLOAD.retainOriginal=window.__originalRetain;delete window.__originalRetain;});
  await page.locator('#sceneFrontFile').setInputFiles(fixture);await page.locator('#sceneFrontPreview img').waitFor();
  await page.locator('#sceneFrontClear').click();await page.waitForFunction(()=>!document.querySelector('#sceneFrontPreview img'));check('scene remove updates role count',await page.locator('#sceneFrontFile').locator('..').locator('..').locator('[data-cu-count]').textContent()==='0/1');
  await transfer(page.locator('#sceneDetailFile').locator('..'),'paste',png);await page.locator('#sceneDetailPreview img').waitFor();check('scene focused paste uses correct role',await page.locator('#sceneFrontPreview img').count()===0);
  const oldSceneImage=await page.locator('#sceneDetailPreview img').getAttribute('src');await transfer(page.locator('#sceneDetailPreview'),'drop',second);await page.waitForFunction(old=>document.querySelector('#sceneDetailPreview img')?.src!==old,oldSceneImage);check('scene thumbnail drop uses same protected upload',await page.locator('#sceneDetailPreview img').count()===1);
  await page.evaluate(async base64=>{await SZ_IMAGE_UPLOAD.openPreview('data:image/png;base64,'+base64,'未存原件的旧素材',true);},Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=2;c.height=2;return c.toDataURL('image/png').split(',')[1];}),'base64').toString('base64'));
  check('old images without retained originals use accurate download label',await page.getByRole('link',{name:'下载当前图片',exact:true}).count()===1);await page.keyboard.press('Escape');
  await page.screenshot({path:path.join(output,'scene-compatible-workspace.png'),fullPage:true});
  async function textTransfer(zone,event,text){await zone.evaluate((element,{event,text})=>{const data=new DataTransfer();data.setData('text/plain',text);element.dispatchEvent(event==='paste'?new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}):new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));},{event,text});}
  const firstUrl='https://img.alicdn.com/upload-uat/first.png',secondUrl='https://img.alicdn.com/upload-uat/second.png',slowUrl='https://img.alicdn.com/upload-uat/slow.png';
  await page.goto(base+'?mode=sku&source=web&layout=1');const subjectZone=page.locator('#skuProductFiles').locator('..'),templateZone=page.locator('#skuTemplateFile').locator('..');await subjectZone.waitFor({state:'visible'});
  check('SKU both zones expose all four import methods',await page.locator('#skuPanel .cu-methods').allTextContents().then(list=>list.length===2&&list.every(text=>text.includes('粘贴 URL')&&text.includes('点击上传')&&text.includes('拖入')&&text.includes('粘贴图片'))));
  check('SKU previous URL routes are hidden',!(await page.locator('#skuProductUrls').isVisible())&&!(await page.locator('#skuTemplateUrl').isVisible()));
  await textTransfer(subjectZone,'paste',firstUrl);await page.waitForFunction(()=>document.querySelectorAll('#skuProductPreview img').length===1);check('SKU paste URL downloads once and adds subject',true);
  await textTransfer(templateZone,'drop',secondUrl);await page.locator('#skuTemplatePreview img').waitFor();check('SKU dragged URL fills only object base',await page.locator('#skuProductPreview img').count()===1);
  const oldTemplate=await page.locator('#skuTemplatePreview img').getAttribute('src');await textTransfer(templateZone,'paste',firstUrl+'\n'+secondUrl);check('single image rejects multiple URLs without replacement',await page.locator('#skuTemplatePreview img').getAttribute('src')===oldTemplate);
  await page.locator('#skuTemplateClearBtn').click();await transfer(templateZone,'paste',png);await page.locator('#skuTemplatePreview img').waitFor();check('SKU object base accepts pasted image once',await page.locator('#skuTemplatePreview img').count()===1);
  await page.locator('#skuTemplateClearBtn').click();const templateChooser=page.waitForEvent('filechooser');await templateZone.click();await (await templateChooser).setFiles(fixture);await page.locator('#skuTemplatePreview img').waitFor();check('SKU object base whole-zone click selects image',true);
  await page.locator('#skuTemplateClearBtn').click();await transfer(templateZone,'drop',second);await page.locator('#skuTemplatePreview img').waitFor();check('SKU object base accepts dropped image once',true);
  await textTransfer(subjectZone,'paste','http://img.alicdn.com/upload-uat/first.png');await page.waitForFunction(()=>!SZ_IMAGE_UPLOAD.isImporting());check('HTTP URL rejected visibly without count mutation',await subjectZone.locator('..').locator('.cu-error').textContent().then(text=>text.includes('HTTPS'))&&await page.locator('#skuProductPreview img').count()===1);
  await textTransfer(subjectZone,'paste','https://img.alicdn.com/upload-uat/broken.png');await page.waitForFunction(()=>!SZ_IMAGE_UPLOAD.isImporting());check('non-image URL rejected visibly without count mutation',await subjectZone.locator('..').locator('.cu-error').isVisible()&&await page.locator('#skuProductPreview img').count()===1);
  await textTransfer(subjectZone,'paste',slowUrl);await page.locator('#skuClearBtn').click();await page.waitForTimeout(600);check('SKU clear project cancels pending URL without late rows',await page.locator('#skuProductPreview img').count()===0&&!await page.evaluate(()=>SZ_IMAGE_UPLOAD.isImporting()));
  await page.screenshot({path:path.join(output,'sku-four-methods.png'),fullPage:true});
  await page.goto(base+'?source=web&studio=1');const modernZone=page.locator('#studioGenesisRoot .cu-drop');await page.waitForFunction(()=>document.querySelector('#studioGenesisRoot [data-files]')&&!document.querySelector('#studioGenesisRoot [data-files]').disabled);
  await textTransfer(modernZone,'paste',firstUrl);await page.locator('#studioGenesisRoot .sg-asset').waitFor();check('modern URL paste survives pending rerender and uploads once',await page.locator('#studioGenesisRoot .sg-asset').count()===1);
  await page.goto(base+'?mode=creative&tool=refinement&source=web');await page.locator('[data-upload="products"]').waitFor({state:'attached'});await page.waitForFunction(()=>!document.querySelector('[data-upload="products"]').matches(':disabled'));
  await textTransfer(page.locator('[data-drop="products"]'),'drop',firstUrl);await page.locator('#ctProductGrid img').waitFor();check('creative dragged URL imports exactly once',await page.locator('#ctProductGrid img').count()===1);
  await page.goto(base+'?mode=viral&source=web&layout=1');await page.locator('#viralSceneModeBtn').click();await page.locator('#sceneFrontFile').setInputFiles(fixture);await page.locator('#sceneFrontPreview img').waitFor();await page.locator('#sceneMaterialName').fill('本地 URL 测试产品');await page.locator('#sceneSameMaterial').check();await page.locator('#scenePlanBtn').click();
  await textTransfer(page.locator('#sceneFrontFile').locator('..'),'paste',slowUrl);check('scene URL download immediately invalidates old plan and blocks generation',await page.evaluate(()=>!SZ_SCENE_EXTENSION_CONTROLLER.state.plan&&document.getElementById('scenePlanBtn').disabled&&document.getElementById('sceneGenerateBtn').disabled));
  await page.locator('#sceneFrontClear').click();await page.waitForTimeout(600);check('scene clear cancels pending URL without late refill',await page.locator('#sceneFrontPreview img').count()===0&&!await page.evaluate(()=>SZ_IMAGE_UPLOAD.isImporting()));
  await page.locator('#sceneFrontFile').locator('..').locator('..').locator('[data-cu-url]').fill(firstUrl);await page.locator('#sceneFrontFile').locator('..').locator('..').locator('[data-cu-add-url]').click();await page.locator('#sceneFrontPreview img').waitFor();check('scene URL field add uses native role and retains original',await page.locator('#sceneFrontPreview img').count()===1);
  await textTransfer(page.locator('#sceneFrontFile').locator('..'),'paste',slowUrl+'?replacement');await page.locator('#sceneFrontFile').setInputFiles({name:'new-local.png',mimeType:'image/png',buffer:second});await page.waitForTimeout(600);check('new native file cancels prior scene URL replacement',await page.locator('#sceneFrontPreview img').getAttribute('src').then(src=>sha(Buffer.from(src.split(',')[1],'base64'))===sha(second)));
  await page.locator('#sceneFrontFile').setInputFiles(fixture);await page.waitForFunction(base64=>document.querySelector('#sceneFrontPreview img')?.src==='data:image/png;base64,'+base64,png.toString('base64'));
  await page.locator('#sceneFrontPreview img').click();await page.locator('.cu-dialog').waitFor();const urlOriginalDownload=page.waitForEvent('download');await page.getByRole('link',{name:'下载原图',exact:true}).click();await (await urlOriginalDownload).saveAs(path.join(output,'url-original.png'));check('URL imported original download preserves source bytes',sha(fs.readFileSync(path.join(output,'url-original.png')))===sha(png));await page.keyboard.press('Escape');
  await page.goto(base+'?source=web');const legacyZone=page.locator('#productFrontFile').locator('..');await legacyZone.waitFor({state:'visible'});const priorDisabled=await page.locator('#generateBtn').isEnabled();await textTransfer(legacyZone,'paste','http://img.alicdn.com/upload-uat/first.png');await page.waitForFunction(()=>!SZ_IMAGE_UPLOAD.isImporting());check('failed legacy URL import restores original generate-button state',await page.locator('#generateBtn').isEnabled()===priorDisabled);
  await page.setViewportSize({width:375,height:900});await page.goto(base+'?source=web&studio=1');await page.locator('#studioGenesisRoot .cu-drop').waitFor();
  check('narrow viewport no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,'narrow-main.png'),fullPage:true});
  check('no provider or business API request',requests.length===0,requests);check('browser page errors absent',errors.length===0,errors);
  check('remote imports use only image GET fixtures',imageRequests.length>=4&&imageRequests.every(item=>item.method==='GET'),imageRequests);
  timings.originalAcceptanceMs=Date.now()-startedAt;
  // Append isolated cases after the existing acceptance sequence so its data,
  // request counts and check order remain unchanged.
  const legacyStartedAt=Date.now();
  const legacyContext=await browser.newContext({viewport:{width:1440,height:1100}});
  await legacyContext.addInitScript(()=>{window.__SANJIE_ENVIRONMENT='image-upload-20261002-legacy-delay';});
  await legacyContext.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  page=await legacyContext.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'?mode=sku&source=web&layout=1');
  await page.locator('#skuProductFiles').locator('..').waitFor({state:'visible'});
  await page.locator('#skuProductFiles').setInputFiles(fixture);
  await page.waitForFunction(()=>document.querySelector('#skuProductPreview img')&&!legacyImageUploadBusy());
  await page.locator('#skuTemplateFile').setInputFiles({name:'initial-base.png',mimeType:'image/png',buffer:second});
  await page.waitForFunction(()=>document.querySelector('#skuTemplatePreview img')&&!legacyImageUploadBusy());
  await page.getByRole('textbox',{name:'SKU 标题，仅用于结果和下载命名',exact:true}).fill('延迟原件验收商品');await page.locator('#skuSelectAllBtn').click();await page.locator('#skuBaseRightsConfirmed').check();
  await page.waitForFunction(()=>!document.getElementById('skuGenerateBtn').disabled);
  const controlIds=['skuGenerateBtn','skuClearBtn','skuTemplateClearBtn','skuProductFiles','skuTemplateFile'];
  const controlState=()=>page.evaluate(ids=>Object.fromEntries(ids.map(id=>[id,document.getElementById(id).disabled])),controlIds);
  const beforeLegacySave=await controlState(),oldLegacyBase=await page.locator('#skuTemplatePreview img').getAttribute('src');
  check('delayed legacy test starts from a ready SKU with enabled clear and generate',!beforeLegacySave.skuGenerateBtn&&!beforeLegacySave.skuClearBtn&&!beforeLegacySave.skuTemplateClearBtn,beforeLegacySave);
  const third=Buffer.from(await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=300;canvas.height=200;canvas.getContext('2d').fillStyle='#176f92';canvas.getContext('2d').fillRect(0,0,300,200);return canvas.toDataURL('image/png').split(',')[1];}),'base64');
  async function delayLegacyRetain(){
    await page.evaluate(()=>{
      const original=SZ_IMAGE_UPLOAD.retainOriginal;
      window.__restoreLegacyRetain=()=>{SZ_IMAGE_UPLOAD.retainOriginal=original;delete window.__releaseLegacyRetain;delete window.__restoreLegacyRetain;};
      SZ_IMAGE_UPLOAD.retainOriginal=async(...args)=>{await new Promise((resolve,reject)=>{window.__releaseLegacyRetain=fail=>fail?reject(new Error('本地测试：SKU 原件保存失败')):resolve();});return original(...args);};
    });
  }
  await delayLegacyRetain();await page.locator('#skuTemplateFile').setInputFiles({name:'delayed-base.png',mimeType:'image/png',buffer:third});
  await page.waitForFunction(()=>typeof window.__releaseLegacyRetain==='function');
  const pendingLegacySave=await controlState();
  check('legacy original save blocks generation clearing and replacement',Object.values(pendingLegacySave).every(Boolean),pendingLegacySave);
  await page.evaluate(()=>{document.getElementById('skuClearBtn').click();document.getElementById('skuTemplateClearBtn').click();});
  check('disabled legacy clear cannot erase the current SKU during original save',await page.locator('#skuProductPreview img').count()===1&&await page.locator('#skuTemplatePreview img').getAttribute('src')===oldLegacyBase);
  await page.evaluate(()=>window.__releaseLegacyRetain(false));
  await page.waitForFunction(old=>!legacyImageUploadBusy()&&document.querySelector('#skuTemplatePreview img')?.src!==old,oldLegacyBase);
  const successfulLegacySave=await controlState(),savedLegacyBase=await page.locator('#skuTemplatePreview img').getAttribute('src');
  check('successful legacy original save restores prior control states',JSON.stringify(successfulLegacySave)===JSON.stringify(beforeLegacySave),successfulLegacySave);
  check('successful legacy original save commits exactly one replacement base',savedLegacyBase!==oldLegacyBase&&await page.locator('#skuTemplatePreview img').count()===1&&await page.locator('#skuProductPreview img').count()===1);
  await page.evaluate(()=>window.__restoreLegacyRetain());
  await delayLegacyRetain();await page.locator('#skuTemplateFile').setInputFiles({name:'failed-base.png',mimeType:'image/png',buffer:second});
  await page.waitForFunction(()=>typeof window.__releaseLegacyRetain==='function');
  const pendingFailedSave=await controlState();check('failing legacy original save keeps generation and clear locked while pending',Object.values(pendingFailedSave).every(Boolean),pendingFailedSave);
  await page.evaluate(()=>window.__releaseLegacyRetain(true));
  await page.waitForFunction(()=>!legacyImageUploadBusy());
  const failedLegacySave=await controlState();
  check('failed legacy original save restores prior control states',JSON.stringify(failedLegacySave)===JSON.stringify(beforeLegacySave),failedLegacySave);
  const failedSaveMessage=await page.locator('#skuState').textContent();
  check('failed legacy original save preserves prior assets and reports the failure',await page.locator('#skuTemplatePreview img').getAttribute('src')===savedLegacyBase&&await page.locator('#skuProductPreview img').count()===1&&failedSaveMessage.includes('本地测试：SKU 原件保存失败'),failedSaveMessage);
  await page.evaluate(()=>window.__restoreLegacyRetain());timings.delayedLegacyOriginalSaveMs=Date.now()-legacyStartedAt;
  const cleanStartedAt=Date.now(),cleanContext=await browser.newContext({viewport:{width:1440,height:1100}});
  await cleanContext.addInitScript(()=>{window.__SANJIE_ENVIRONMENT='image-upload-20261002-clean-screenshot';});
  await cleanContext.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  page=await cleanContext.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'?mode=sku&source=web&layout=1');
  await page.locator('#skuPanel .cu-upload').first().waitFor({state:'visible'});
  check('clean SKU screenshot uses an independent empty context',await page.locator('#skuProductPreview img,#skuTemplatePreview img').count()===0&&await page.locator('#skuPanel [data-cu-count]').allTextContents().then(counts=>JSON.stringify(counts)===JSON.stringify(['0/20','0/1'])));
  await page.screenshot({path:path.join(output,'clean-upload-sku.png'),fullPage:true});timings.cleanSkuScreenshotMs=Date.now()-cleanStartedAt;
  if(errors.length||requests.length)throw new Error('Additional acceptance cases produced browser errors or business requests: '+JSON.stringify({errors,requests}));
}
main().catch(async error=>{errors.push(error.stack||error.message);if(page){await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});const debug=await page.evaluate(()=>({url:location.href,startup:document.documentElement.dataset.labStartup,active:document.activeElement?.outerHTML?.slice(0,1000),skuDisabled:document.getElementById('skuProductFiles')?.matches(':disabled')})).catch(()=>null);errors.push(JSON.stringify(debug));}process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));const result={passed:checks.filter(item=>item.passed).length,total:checks.length,checks,errors,requests,imageRequests,realProvider:false,durationMs:Date.now()-startedAt,timings};fs.writeFileSync(path.join(output,'acceptance.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,total:result.total,failed:checks.filter(item=>!item.passed),errors,requests,realProvider:false,durationMs:result.durationMs,timings},null,2));});
