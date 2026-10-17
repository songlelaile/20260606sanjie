/* The confirmed subject window belongs to the current SKU base image only. */
(function (global) {
  'use strict';
  var bound = false, preview, panel, overlay, selection, image, source = '';
  var draft = null, confirmed = null, editing = false, drag = null;
  var fields = ['x', 'y', 'w', 'h'];
  function byId(id) { return global.document && global.document.getElementById(id); }
  function copy(region) { return region ? { x: region.x, y: region.y, w: region.w, h: region.h, confirmed: region.confirmed === true } : null; }
  function valid(region) {
    if (!region || !fields.every(function (key) { return Number.isFinite(region[key]); })) return false;
    return region.x >= .01 && region.y >= .01 && region.w >= .2 && region.h >= .2 &&
      region.x + region.w <= .99 + 1e-9 && region.y + region.h <= .99 + 1e-9 && region.w * region.h <= .70 + 1e-9;
  }
  function busy() { return !!(byId('skuBaseRightsConfirmed') && byId('skuBaseRightsConfirmed').disabled); }
  function announce() {
    if (typeof global.CustomEvent === 'function' && global.document && global.document.dispatchEvent) {
      global.document.dispatchEvent(new global.CustomEvent('sku-region-change', { detail: { region: get() } }));
    }
  }
  function imageSource() { var current = preview && preview.querySelector('img'); return current && current.getAttribute('src') || ''; }
  function get() { return confirmed && valid(confirmed) && source && source === imageSource() ? copy(confirmed) : null; }
  function message() {
    if (!source) return '请先添加对象底图，再框选商品及必要的接触阴影。';
    if (confirmed) return '主体区域已确认。区域外仍使用原底图像素，文案、图标和背景保持原样。';
    if (!draft) return '点击“框选商品区域”，在底图上拖出商品及阴影的边界；不要选入文案或图标。';
    if (!valid(draft)) return '范围需距画布边缘至少 1%，宽高至少 20%，面积不超过 70%；请重新框选。';
    return '已框选，尚未确认。检查范围只包含商品及必要阴影，再点击“确认主体区域”。';
  }
  function geometry() {
    if (!image || !image.naturalWidth || !image.naturalHeight || !preview) return null;
    var box = image.getBoundingClientRect(), parentBox = preview.getBoundingClientRect();
    var scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
    var width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    if (!width || !height) return null;
    return { x: box.left + (box.width - width) / 2, y: box.top + (box.height - height) / 2,
      left: box.left - parentBox.left - preview.clientLeft + (box.width - width) / 2,
      top: box.top - parentBox.top - preview.clientTop + (box.height - height) / 2, width: width, height: height };
  }
  function paint() {
    if (!overlay || !selection) return;
    var box = geometry(), region = draft || confirmed;
    overlay.hidden = !box || !source;
    if (!box) return;
    overlay.style.left = box.left + 'px'; overlay.style.top = box.top + 'px';
    overlay.style.width = box.width + 'px'; overlay.style.height = box.height + 'px';
    overlay.classList.toggle('is-editing', editing && !busy());
    selection.hidden = !region;
    if (!region) return;
    selection.style.left = (region.x * 100) + '%'; selection.style.top = (region.y * 100) + '%';
    selection.style.width = (region.w * 100) + '%'; selection.style.height = (region.h * 100) + '%';
    selection.classList.toggle('is-confirmed', !!confirmed);
    selection.classList.toggle('is-invalid', !valid(region));
  }
  function render() {
    if (!panel) return;
    var isBusy = busy(), hasImage = !!source;
    var editButton = byId('skuRegionEditBtn'), confirmButton = byId('skuRegionConfirmBtn'), resetButton = byId('skuRegionResetBtn');
    if (editButton) { editButton.disabled = !hasImage || isBusy; editButton.textContent = confirmed ? '重新框选商品区域' : '框选商品区域'; }
    if (confirmButton) confirmButton.disabled = !hasImage || !draft || !valid(draft) || isBusy || !!confirmed;
    if (resetButton) resetButton.disabled = !hasImage || (!draft && !confirmed) || isBusy;
    var status = byId('skuRegionState');
    if (status) { status.textContent = message(); status.className = 'sku-region-state' + (confirmed ? ' confirmed' : draft && !valid(draft) ? ' invalid' : ''); }
    fields.forEach(function (key) {
      var field = byId('skuRegion' + key.toUpperCase());
      if (!field) return;
      field.disabled = !hasImage || isBusy || !!confirmed;
      if (global.document.activeElement !== field) field.value = draft ? String(Math.round(draft[key] * 10000) / 100) : '';
    });
    paint();
  }
  function clear() { draft = null; confirmed = null; editing = false; drag = null; render(); announce(); return null; }
  function set(region) {
    syncImage();
    if (!source || !valid(region) || busy()) return { ok: false, error: '请在当前底图上设置有效的主体区域。' };
    draft = copy(region); draft.confirmed = false;
    confirmed = region.confirmed === true ? Object.assign(copy(region), { confirmed: true }) : null;
    editing = !confirmed; render(); announce();
    return { ok: true, region: get(), draft: copy(draft) };
  }
  function syncImage() {
    if (!preview) return;
    // The legacy renderer assigns className when redrawing this preview.
    preview.classList.add('sku-region-preview');
    var nextImage = preview.querySelector('img'), nextSource = imageSource();
    if (nextSource !== source) { source = nextSource; draft = null; confirmed = null; editing = false; drag = null; announce(); }
    if (nextImage !== image) {
      image = nextImage;
      if (image) image.addEventListener('load', render);
    }
    if (image && overlay && overlay.parentNode !== preview) preview.appendChild(overlay);
    render();
  }
  function point(event) {
    var box = geometry(); if (!box) return null;
    return { x: Math.max(.01, Math.min(.99, (event.clientX - box.x) / box.width)),
      y: Math.max(.01, Math.min(.99, (event.clientY - box.y) / box.height)) };
  }
  function move(event) {
    if (!drag || event.pointerId !== drag.id) return;
    var next = point(event); if (!next) return;
    draft = { x: Math.min(drag.start.x, next.x), y: Math.min(drag.start.y, next.y),
      w: Math.abs(next.x - drag.start.x), h: Math.abs(next.y - drag.start.y), confirmed: false };
    render();
  }
  function end(event) {
    if (!drag || event.pointerId !== drag.id) return;
    move(event); drag = null;
    try { overlay.releasePointerCapture(event.pointerId); } catch (_) {}
    render(); announce();
  }
  function bind() {
    if (bound) { syncImage(); return true; }
    preview = byId('skuTemplatePreview'); panel = byId('skuRegionPanel');
    if (!preview || !panel || !global.document.createElement) return false;
    bound = true; preview.classList.add('sku-region-preview');
    overlay = global.document.createElement('div'); overlay.className = 'sku-region-overlay'; overlay.hidden = true;
    overlay.setAttribute('aria-label', 'SKU 主体区域框选画布');
    selection = global.document.createElement('div'); selection.className = 'sku-region-selection'; selection.hidden = true;
    var label = global.document.createElement('span'); label.textContent = '仅替换商品'; selection.appendChild(label); overlay.appendChild(selection);
    overlay.addEventListener('pointerdown', function (event) {
      if (!editing || busy() || event.button !== 0) return;
      var start = point(event); if (!start) return;
      event.preventDefault(); event.stopPropagation(); confirmed = null; draft = null; drag = { id: event.pointerId, start: start };
      try { overlay.setPointerCapture(event.pointerId); } catch (_) {}
      render(); announce();
    });
    overlay.addEventListener('pointermove', move); overlay.addEventListener('pointerup', end);
    overlay.addEventListener('pointercancel', function () { drag = null; render(); });
    byId('skuRegionEditBtn').addEventListener('click', function () {
      if (!source || busy()) return; confirmed = null; draft = null; editing = true; render(); announce();
    });
    byId('skuRegionConfirmBtn').addEventListener('click', function () {
      if (!source || busy() || !valid(draft)) return;
      confirmed = Object.assign(copy(draft), { confirmed: true }); editing = false; render(); announce();
    });
    byId('skuRegionResetBtn').addEventListener('click', function () { if (!busy()) clear(); });
    fields.forEach(function (key) {
      var field = byId('skuRegion' + key.toUpperCase());
      field.addEventListener('input', function () {
        if (!source || busy() || confirmed) return;
        draft = { confirmed: false }; fields.forEach(function (name) { var value = byId('skuRegion' + name.toUpperCase()).value; draft[name] = value === '' ? NaN : Number(value) / 100; });
        editing = true; render(); announce();
      });
    });
    if (typeof global.MutationObserver === 'function') {
      new global.MutationObserver(syncImage).observe(preview, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
      var rights = byId('skuBaseRightsConfirmed');
      if (rights) new global.MutationObserver(render).observe(rights, { attributes: true, attributeFilter: ['disabled'] });
    }
    if (typeof global.ResizeObserver === 'function') new global.ResizeObserver(paint).observe(preview);
    if (typeof global.addEventListener === 'function') global.addEventListener('resize', paint);
    syncImage(); return true;
  }
  global.SZ_SKU_REGION = { bind: bind, get: get, region: get, set: set, clear: clear, valid: valid };
  if (global.document && global.document.addEventListener) {
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', bind);
    else bind();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
