/* Local-only UI fixture. No provider, billing, or production writes are possible. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../public');
const injection = `<script>
window.__SANJIE_ENVIRONMENT = 'task-lifecycle-offline-20261013';
document.addEventListener('DOMContentLoaded', function () {
  var callbacks = {}, count = 0, original = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = function (request, callback) {
    if (request.type === 'BUILD_LINK_PROMPT' && /^offline-preview-/.test(request.jobId || '')) {
      callbacks[request.jobId] = callback; return;
    }
    if (request.type === 'CANCEL_GENERATION' && /^offline-preview-/.test(request.jobId || '')) {
      if (callback) callback({ok:true,cancelled:true,ended:true,jobId:request.jobId}); return;
    }
    return original.apply(this, arguments);
  };
  var controls = document.createElement('section');
  controls.style.cssText='margin:12px;padding:16px;border:2px dashed #e8b849;border-radius:12px;background:#192113;color:#fff';
  controls.innerHTML='<strong>本地离线验收 · 无模型请求 / 无扣费</strong><p>模拟两个独立提词任务，验证任务提醒和结束隔离。</p><button id="fixtureStart">启动两个独立提词任务</button> <button id="fixtureLate">返回旧任务成功回调</button> <button id="fixtureFail">返回其余任务失败</button><p id="fixtureOutcome" role="status">尚未开始</p>';
  document.body.prepend(controls);
  var results=[];
  document.getElementById('fixtureStart').onclick=function(){
    ['L001','L002'].forEach(function(linkId){
      var id='offline-preview-'+(++count);
      sendRuntime('BUILD_LINK_PROMPT',{jobId:id,payload:{linkId:linkId}}).then(function(r){
        results.push({jobId:id,ok:r.ok,code:r.code,ended:r.ended});
        document.getElementById('fixtureOutcome').textContent=JSON.stringify(results);
      });
    });
  };
  document.getElementById('fixtureLate').onclick=function(){
    var id=Object.keys(callbacks)[0]; if(id) callbacks[id]({ok:true,data:{'中文提示词':'旧任务成功回调'},jobId:id});
  };
  document.getElementById('fixtureFail').onclick=function(){
    Object.keys(callbacks).slice(1).forEach(function(id){callbacks[id]({ok:false,code:'request_invalid',error:'离线模拟：提示词任务失败',jobId:id});});
  };
});
</script>`;
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  res.setHeader('Cache-Control','no-store');
  if(url.pathname==='/api/auth/me'){
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({data:{id:'offline-task-user',tenantId:'offline-task-tenant',username:'offline-task-user',creativeEntitlement:{allowed:true}}}));return;
  }
  if(url.pathname==='/api/creative/credits'){
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({data:{centsPerPoint:10,models:[],plan:{code:'offline',name:'离线验收',multiplierBps:10000,ruleVersion:1}}}));return;
  }
  if(url.pathname.startsWith('/api/')){res.writeHead(403);res.end('Offline fixture: external operations blocked');return;}
  let file;
  try{file=path.resolve(root,'.'+decodeURIComponent(url.pathname));}catch{res.writeHead(400);res.end();return;}
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');
  let data=fs.readFileSync(file);
  if(file.endsWith('/promptlab.html')) data=Buffer.from(data.toString().replace('<head>','<head>'+injection));
  res.end(data);
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port+'/creative/labs/image-prompt-lab/promptlab.html?mode=main&source=web&layout=1',environment:'offline',providerCalls:0})));
