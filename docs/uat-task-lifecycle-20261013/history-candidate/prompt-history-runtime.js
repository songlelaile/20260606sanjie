// Candidate-only additions: metadata recovery never dispatches or releases a receipt.
function promptTaskBoundConfigRead(action) {
  return new Promise(function (resolve) {
    var settled = false;
    var timer = setTimeout(function () { done({ok:false,code:'CONFIG_READ_TIMEOUT',error:'账号和 API 配置读取超时，请稍后重新打开工作台。'}); },15000);
    function done(value) { if (settled) return;settled = true;clearTimeout(timer);resolve(value); }
    try { Promise.resolve(action()).then(done,function () { done({ok:false,code:'CONFIG_READ_FAILED',error:'账号和 API 配置读取失败，请稍后重试。'}); }); }
    catch (_) { done({ok:false,code:'CONFIG_READ_FAILED',error:'账号和 API 配置读取失败，请稍后重试。'}); }
  });
}
function promptTaskOldJournal(owner) {
  var query = new URLSearchParams(location.search), mode = query.get('mode') || 'main';
  var allowed = mode === 'main' ? ['ANALYZE_IMAGE','BUILD_LINK_PROMPT'] : mode === 'detail' ? ['BUILD_DETAIL_PROMPT'] : [];
  try {
    var old = JSON.parse(localStorage.getItem('sz.prompt-task-journal.v1:' + encodeURIComponent(owner)) || '[]');
    return Array.isArray(old) ? old.filter(function (task) { return task && allowed.indexOf(task.type) >= 0; }).slice(-40) : [];
  } catch (_) { return []; }
}
function promptTaskHistoricalReceiptCount(owner) {
  if (owner === 'local') return 0;
  var prefix = LEGACY_IMAGE_RECEIPT_PREFIX + encodeURIComponent(owner) + ':', journalPrefix = 'sz.prompt-task-journal.v1:' + encodeURIComponent(owner), known = Object.create(null), keys = [], count = 0;
  try {
    for (var index = 0; index < localStorage.length && index < 2000; index++) {
      var key = localStorage.key(index); if (!key) continue;
      if (key.indexOf(prefix) === 0) keys.push(key);
      if (key === journalPrefix || key.indexOf(journalPrefix + ':') === 0) {
        var records; try { records = JSON.parse(localStorage.getItem(key) || '[]'); } catch (_) {}
        if (Array.isArray(records)) records.forEach(function (task) { if (task && typeof task.receiptKey === 'string' && task.receiptKey.indexOf(prefix) === 0) known[task.receiptKey] = true; });
      }
    }
    keys.forEach(function (key) { if (known[key]) return;var marker;try { marker = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) {}if (marker && marker.version === 1 && typeof marker.jobId === 'string' && ['pending','uncertain','delivered'].indexOf(marker.state) >= 0) count++; });
  } catch (_) {}
  return count;
}
function promptTaskAdoptLegacyReceipt(owner, key, marker, request, delivered) {
  if (owner !== promptTaskOwner() || !marker || marker.version !== 1 || !marker.jobId ||
      key.indexOf(LEGACY_IMAGE_RECEIPT_PREFIX + encodeURIComponent(owner) + ':') !== 0) return false;
  // Caller already computed this exact key from the current frozen provider inputs.
  var records = promptTaskJournal(owner), existing = records.find(function (task) { return task.receiptKey === key && task.jobId === marker.jobId; });
  if (existing) { if (delivered) { existing.status = 'recovered';existing.receiptState = 'received'; }promptTaskPersist(owner);promptTaskRender();return true; }
  var payload = request && request.payload || {}, target = String(payload.linkId || payload.skuId || payload.link && payload.link['链接编号'] || '').replace(/[\u0000-\u001f\u007f]/g,'').slice(0,60);
  if (payload.detailScreenIndex || payload.mainImageIndex) target += ' 第' + (Number(payload.detailScreenIndex || payload.mainImageIndex) || 1) + '张';
  records.push({id:'history_' + key.slice(-100).replace(/[^A-Za-z0-9_-]/g,'_'),jobId:String(marker.jobId).slice(0,180),type:'GENERATE_IMAGE',label:'图片生成',targetLabel:target,
    receiptKey:key,status:delivered?'recovered':'uncertain',startedAt:Number.isFinite(marker.createdAt)?marker.createdAt:Date.now(),endedAt:Date.now(),receiptState:delivered?'received':'pending',code:'LEGACY_RECEIPT_ADOPTED'});
  promptTaskPersist(owner);promptTaskRender();return true;
}
