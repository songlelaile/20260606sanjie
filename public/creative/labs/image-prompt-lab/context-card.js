(function () {
  'use strict';

  if (window.__SZ_LOCAL_LINK_CONTEXT_PROMPT_CARD__) {
    window.__SZ_LOCAL_LINK_CONTEXT_PROMPT_CARD__.showLast && window.__SZ_LOCAL_LINK_CONTEXT_PROMPT_CARD__.showLast();
    return;
  }

  var MAINIMG_CONFIG_KEY = 'sycm_mainimg_card_config';
  var state = {
    payload: null,
    result: null,
    cardBlob: null,
    cardUrl: ''
  };

  function runtimeSend(message, timeoutMs) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = Number(timeoutMs) > 0 ? setTimeout(function () {
        finish({ ok: false, error: '插件工作台响应超时' });
      }, Math.max(1000, Number(timeoutMs))) : null;
      function finish(value) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      }
      try {
        chrome.runtime.sendMessage(message, function (resp) {
          var err = chrome.runtime.lastError;
          if (err) finish({ ok: false, error: err.message });
          else finish(resp || { ok: false, error: '无响应' });
        });
      } catch (e) {
        finish({ ok: false, error: (e && e.message) || String(e) });
      }
    });
  }

  function storageGet(keys) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get(keys, resolve); } catch (e) { resolve({}); }
    });
  }

  function makeRoot() {
    var host = document.getElementById('__sz_local_link_context_prompt_card_host__');
    if (!host) {
      host = document.createElement('div');
      host.id = '__sz_local_link_context_prompt_card_host__';
      document.documentElement.appendChild(host);
    }
    if (!host.shadowRoot) host.attachShadow({ mode: 'open' });
    return host.shadowRoot;
  }

  var root = makeRoot();
  root.innerHTML = [
    '<style>',
    ':host{all:initial}',
    '.mask{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.36);display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#f8f4dc}',
    '.mask[hidden]{display:none}',
    '.panel{width:min(920px,calc(100vw - 48px));max-height:calc(100vh - 48px);overflow:auto;background:#081404;border:1px solid rgba(246,198,95,.34);box-shadow:0 26px 80px rgba(0,0,0,.42);border-radius:22px;padding:28px}',
    '.head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px}.title{font-size:28px;font-weight:900;line-height:1.1}.desc{margin:10px 0 0;color:rgba(248,244,220,.66);font-size:16px;line-height:1.7}',
    '.x{width:46px;height:46px;border-radius:50%;border:1px solid rgba(246,198,95,.36);background:rgba(246,198,95,.08);color:#f8f4dc;font-size:28px;cursor:pointer}',
    '.chooser{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:20px 0 22px}.choice{border:1px solid rgba(246,198,95,.3);border-radius:16px;background:#102105;color:#f8f4dc;text-align:left;padding:22px;cursor:pointer;min-height:126px}.choice strong{display:block;color:#f6c65f;font-size:22px;margin-bottom:12px}.choice span{font-size:16px;line-height:1.6;color:rgba(248,244,220,.66)}.choice.primary{outline:3px solid #9dc6ff;background:#32340d}',
    '.status{border-top:1px solid rgba(246,198,95,.18);padding-top:18px;color:rgba(248,244,220,.72);font-size:15px;line-height:1.6}.status.warn{color:#ff9d9d}.status.ok{color:#8ee2bc}',
    '.card-wrap{display:none;margin-top:20px}.card-wrap.on{display:block}.card-preview{display:block;width:min(420px,100%);max-height:72vh;margin:0 auto 18px;border-radius:18px;box-shadow:0 18px 60px rgba(0,0,0,.35);background:#111;cursor:zoom-in}.actions{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}.btn{border:1px solid rgba(246,198,95,.32);border-radius:12px;background:#18260a;color:#f8f4dc;padding:12px 20px;font-weight:800;cursor:pointer}.btn.main{background:#f6c65f;color:#151704}.btn.blue{background:#93d7ff;color:#07121a}.btn:disabled{opacity:.45;cursor:not-allowed}',
    '.card-zoom{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:28px;background:rgba(0,0,0,.9);backdrop-filter:blur(8px)}.card-zoom[hidden]{display:none}.card-zoom img{display:block;max-width:94vw;max-height:90vh;object-fit:contain;border-radius:12px;box-shadow:0 28px 100px rgba(0,0,0,.65)}.card-zoom-x{position:fixed;right:22px;top:18px;width:46px;height:46px;border:1px solid rgba(255,255,255,.38);border-radius:50%;background:rgba(0,0,0,.52);color:#fff;font-size:30px;cursor:pointer}',
    '@media(max-width:720px){.panel{padding:20px}.chooser{grid-template-columns:1fr}.title{font-size:24px}}',
    '</style>',
    '<div id="mask" class="mask" hidden>',
    '  <div class="panel" role="dialog" aria-modal="true">',
    '    <div class="head"><div><div class="title">选择图片处理方式</div><p class="desc">生成提示词会留在当前页面完成；只有选择导入参考，才会打开主图工作台。</p></div><button id="close" class="x" type="button">×</button></div>',
    '    <div id="chooser" class="chooser">',
    '      <button id="importRef" class="choice primary" type="button"><strong>导入参考</strong><span>打开主图工作台，把当前右键图片作为参考图/竞品图继续提词、生图或引导重生。</span></button>',
    '      <button id="makeCard" class="choice" type="button"><strong>生成分享卡</strong><span>在当前页面反推提示词，并按分享卡样式原地生成图文卡片。</span></button>',
    '    </div>',
    '    <div id="status" class="status">等待选择。</div>',
    '    <div id="cardWrap" class="card-wrap"><img id="cardPreview" class="card-preview" alt="提示词分享卡"><div class="actions"><button id="saveCard" class="btn main" type="button">保存到本地</button><button id="copyCard" class="btn" type="button">复制图片</button><button id="importAfter" class="btn blue" type="button">导入参考</button></div></div>',
    '  </div>',
    '</div>',
    '<div id="cardZoom" class="card-zoom" hidden><button id="cardZoomClose" class="card-zoom-x" type="button" aria-label="关闭大图预览">×</button><img id="cardZoomImage" alt="提示词分享卡大图预览"></div>'
  ].join('');

  var els = {
    mask: root.getElementById('mask'),
    chooser: root.getElementById('chooser'),
    status: root.getElementById('status'),
    cardWrap: root.getElementById('cardWrap'),
    cardPreview: root.getElementById('cardPreview'),
    close: root.getElementById('close'),
    importRef: root.getElementById('importRef'),
    makeCard: root.getElementById('makeCard'),
    saveCard: root.getElementById('saveCard'),
    copyCard: root.getElementById('copyCard'),
    importAfter: root.getElementById('importAfter'),
    cardZoom: root.getElementById('cardZoom'),
    cardZoomImage: root.getElementById('cardZoomImage'),
    cardZoomClose: root.getElementById('cardZoomClose')
  };

  function setStatus(text, kind) {
    els.status.textContent = text || '';
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function close() {
    if (els.cardZoom) els.cardZoom.hidden = true;
    if (els.cardZoomImage) els.cardZoomImage.removeAttribute('src');
    els.mask.hidden = true;
  }

  function show(payload) {
    state.payload = payload || state.payload || {};
    state.result = null;
    state.cardBlob = null;
    if (state.cardUrl) URL.revokeObjectURL(state.cardUrl);
    state.cardUrl = '';
    els.chooser.style.display = 'grid';
    if (els.cardZoom) els.cardZoom.hidden = true;
    els.cardWrap.classList.remove('on');
    els.cardPreview.removeAttribute('src');
    setStatus('请选择处理方式。');
    els.mask.hidden = false;
  }

  function importReference() {
    if (!state.payload || !state.payload.imageUrl) {
      setStatus('缺少图片地址，无法导入参考。', 'warn');
      return Promise.resolve({ ok: false, error: '缺少图片地址' });
    }
    els.importRef.disabled = true;
    els.importAfter.disabled = true;
    els.importRef.setAttribute('aria-busy', 'true');
    els.importAfter.setAttribute('aria-busy', 'true');
    setStatus('正在打开主图工作台...', '');
    return runtimeSend({ type: 'OPEN_CONTEXT_WORKBENCH', payload: state.payload }).then(function (response) {
      els.importRef.disabled = false;
      els.importAfter.disabled = false;
      els.importRef.removeAttribute('aria-busy');
      els.importAfter.removeAttribute('aria-busy');
      if (!response || !response.ok) {
        var reason = String(response && response.error || '工作台无响应');
        var staleContext = /Extension context invalidated|Receiving end does not exist|message port closed/i.test(reason);
        setStatus(staleContext
          ? '插件刚刚更新，请刷新当前页面后重新导入。'
          : '导入失败：' + reason, 'warn');
        return response || { ok: false, error: reason };
      }
      close();
      return response;
    });
  }

  function pickPrompt(data) {
    data = data || {};
    var cn = data['中文提示词'] || data.cnPrompt || data.prompt || '';
    if (!cn) {
      cn = [
        data['主体'] || data.subject || '',
        data['构图'] || data.composition || '',
        data['镜头'] || data.camera || '',
        data['光线'] || data.lighting || '',
        data['色彩'] || data.color || '',
        data['场景'] || data.scene || '',
        data['风格'] || data.style || ''
      ].filter(Boolean).join('，');
    }
    return {
      title: '提示词',
      prompt: cn || '高质感电商主图，主体清晰，背景克制，细节丰富，高质量生成。',
      negative: data['负面提示词'] || data.negativePrompt || '',
      style: data['风格'] || data.style || ''
    };
  }

  function fetchImageAsDataUrl(url) {
    return runtimeSend({ type: 'FETCH_IMAGE', url: url }).then(function (res) {
      if (res && res.ok && res.dataUrl) return res.dataUrl;
      return url;
    });
  }

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('图片载入失败')); };
      img.src = url;
    });
  }

  function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
    text = (text || '').replace(/\s+/g, ' ').trim();
    var line = '';
    var lines = 0;
    for (var i = 0; i < text.length; i++) {
      var test = line + text[i];
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, y);
        y += lineHeight;
        lines += 1;
        line = text[i];
        if (maxLines && lines >= maxLines - 1) break;
      } else {
        line = test;
      }
    }
    if (line && (!maxLines || lines < maxLines)) ctx.fillText(line, x, y);
  }

  function drawCover(ctx, img, x, y, w, h) {
    var iw = img.naturalWidth || img.width;
    var ih = img.naturalHeight || img.height;
    var scale = Math.max(w / iw, h / ih);
    var sw = w / scale;
    var sh = h / scale;
    ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r || 0, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  function cardSize(ratio) {
    if (ratio === '1:1') return { w: 1080, h: 1080 };
    if (ratio === '3:4') return { w: 1080, h: 1440 };
    return { w: 1080, h: 1350 };
  }

  function makeCardBlob(imageUrl, text, cfg) {
    cfg = Object.assign({ position: 'top', border: 36, ratio: '4:5' }, cfg || {});
    cfg.border = Math.max(0, Math.min(80, parseInt(cfg.border, 10) || 36));
    var size = cardSize(cfg.ratio);
    return fetchImageAsDataUrl(imageUrl).then(loadImage).then(function (img) {
      var canvas = document.createElement('canvas');
      canvas.width = size.w;
      canvas.height = size.h;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f5f5f5';
      ctx.fillRect(0, 0, size.w, size.h);
      var b = cfg.border;
      var mediaH = Math.round(size.h * 0.61);
      if (cfg.position === 'center') mediaH = Math.round(size.h * 0.56);
      if (cfg.position === 'full') mediaH = Math.round(size.h * 0.67);
      roundRect(ctx, b, b, size.w - b * 2, mediaH - b, 28);
      ctx.save();
      ctx.clip();
      drawCover(ctx, img, b, b, size.w - b * 2, mediaH - b);
      ctx.restore();
      var panelY = mediaH;
      ctx.fillStyle = '#15171b';
      roundRect(ctx, b, panelY, size.w - b * 2, size.h - panelY - b, 28);
      ctx.fill();
      ctx.fillStyle = '#f7f7f0';
      ctx.font = '700 54px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillText(text.title || '提示词', b + 46, panelY + 84);
      ctx.fillStyle = '#d8d8d8';
      ctx.font = '400 34px "PingFang SC","Microsoft YaHei",sans-serif';
      var body = [
        '正向提示词 ' + text.prompt,
        text.negative ? '负向提示词 ' + text.negative : '',
        text.style ? '风格标签 ' + text.style : ''
      ].filter(Boolean).join('  ');
      wrapText(ctx, body, b + 46, panelY + 150, size.w - b * 2 - 92, 52, 16);
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          blob ? resolve(blob) : reject(new Error('分享卡导出失败'));
        }, 'image/png');
      });
    });
  }

  function generateShareCard() {
    var payload = state.payload || {};
    if (!payload.imageUrl) {
      setStatus('缺少图片地址，无法生成分享卡。', 'warn');
      return;
    }
    els.chooser.style.display = 'none';
    els.cardWrap.classList.remove('on');
    setStatus('正在读取模型配置...', '');
    Promise.all([
      runtimeSend({ type: 'GET_CONTEXT' }),
      storageGet([MAINIMG_CONFIG_KEY])
    ]).then(function (all) {
      var ctx = all[0] || {};
      var cfg = ctx.config || {};
      var cardCfg = (all[1] && all[1][MAINIMG_CONFIG_KEY]) || {};
      if (!cfg.apiKey) {
        return runtimeSend({ type: 'OPEN_UNIFIED_API_SETTINGS', source: 'context-card' }).then(function (opened) {
          if (opened && opened.unavailable) {
            throw new Error('还没有配置 API Key，请打开独立实验室的“统一 API 设置”完成配置。');
          }
          throw new Error('还没有配置 API Key，请在已打开的插件启动界面“统一 API 设置”中保存后重试。');
        });
      }
      setStatus('正在反推图片提示词...', '');
      return runtimeSend({ type: 'ANALYZE_IMAGE', config: cfg, payload: { image: payload.imageUrl, linkHint: '' } })
        .then(function (res) {
          if (!res || !res.ok) throw new Error((res && res.error) || '提示词生成失败');
          state.result = pickPrompt(res.data);
          setStatus('正在生成分享卡...', '');
          return makeCardBlob(payload.imageUrl, state.result, cardCfg);
        });
    }).then(function (blob) {
      state.cardBlob = blob;
      if (state.cardUrl) URL.revokeObjectURL(state.cardUrl);
      state.cardUrl = URL.createObjectURL(blob);
      els.cardPreview.src = state.cardUrl;
      els.cardWrap.classList.add('on');
      setStatus('分享卡已生成，可保存、复制，或再导入参考。', 'ok');
    }).catch(function (e) {
      els.chooser.style.display = 'grid';
      setStatus('生成失败：' + ((e && e.message) || e), 'warn');
    });
  }

  function saveCard() {
    if (!state.cardBlob) return;
    var a = document.createElement('a');
    a.href = state.cardUrl || URL.createObjectURL(state.cardBlob);
    a.download = '少壮AI提示词分享卡-' + Date.now() + '.png';
    a.click();
  }

  function copyCard() {
    if (!state.cardBlob || !navigator.clipboard || !window.ClipboardItem) {
      setStatus('当前浏览器不支持复制图片，请使用保存到本地。', 'warn');
      return;
    }
    navigator.clipboard.write([new ClipboardItem({ 'image/png': state.cardBlob })]).then(function () {
      setStatus('分享卡已复制。', 'ok');
    }).catch(function (e) {
      setStatus('复制失败：' + ((e && e.message) || e), 'warn');
    });
  }

  function openCardZoom() {
    if (!state.cardUrl || !els.cardZoom || !els.cardZoomImage) return;
    els.cardZoomImage.src = state.cardUrl;
    els.cardZoom.hidden = false;
    if (els.cardZoomClose) els.cardZoomClose.focus();
  }

  function closeCardZoom() {
    if (els.cardZoom) els.cardZoom.hidden = true;
    if (els.cardZoomImage) els.cardZoomImage.removeAttribute('src');
  }

  els.close.addEventListener('click', close);
  els.mask.addEventListener('click', function (ev) { if (ev.target === els.mask) close(); });
  els.importRef.addEventListener('click', importReference);
  els.importAfter.addEventListener('click', importReference);
  els.makeCard.addEventListener('click', generateShareCard);
  els.saveCard.addEventListener('click', saveCard);
  els.copyCard.addEventListener('click', copyCard);
  els.cardPreview.addEventListener('click', openCardZoom);
  if (els.cardZoomClose) els.cardZoomClose.addEventListener('click', closeCardZoom);
  if (els.cardZoom) els.cardZoom.addEventListener('click', function (ev) { if (ev.target === els.cardZoom) closeCardZoom(); });
  document.addEventListener('keydown', function (ev) { if (ev && ev.key === 'Escape') closeCardZoom(); });

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.type !== 'SZ_CONTEXT_IMAGE_ACTION') return;
    show(msg.payload || {});
  });

  window.__SZ_LOCAL_LINK_CONTEXT_PROMPT_CARD__ = {
    show: show,
    showLast: function () { show(state.payload || {}); }
  };
})();
