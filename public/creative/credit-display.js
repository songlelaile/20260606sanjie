/* Shared display-only credit quotes. Existing creative calls retain their own API billing. */
(function (global) {
  'use strict';
  if (global.SZCreativeCredits) return;

  var current = null;
  var pending = null;
  var revision = 0;
  var retryAfter = 0;
  var annotations = new Map();
  var listeners = new Set();
  var MAX_CENTS = 2147483647;

  function text(value, limit) {
    return typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit || 220) : '';
  }
  function integer(value, min, max) {
    return Number.isSafeInteger(value) && value >= min && value <= max;
  }
  function number(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }
  function format(value) {
    return String(Math.round(value * 10) / 10);
  }
  function sanitize(raw) {
    if (!raw || raw.centsPerPoint !== 10 || !raw.plan || !integer(raw.plan.multiplierBps, 100, 1000000) || !Array.isArray(raw.models)) return null;
    return {
      centsPerPoint: 10,
      plan: { code: text(raw.plan.code, 80), name: text(raw.plan.name, 120), multiplierBps: raw.plan.multiplierBps,
        ruleVersion: integer(raw.plan.ruleVersion, 0, MAX_CENTS) ? raw.plan.ruleVersion : 0 },
      observedAt: text(raw.observedAt, 40),
      models: raw.models.slice(0, 500).filter(function (model) {
        return model && text(model.id) && ['image', 'video', 'chat'].indexOf(model.kind) >= 0;
      }).map(function (model) {
        return { id: text(model.id), upstreamModel: text(model.upstreamModel), label: text(model.label, 160), kind: model.kind,
          pricingStatus: model.pricingStatus === 'priced' ? 'priced' : 'unpriced',
          imageCents: integer(model.imageCents, 0, MAX_CENTS) ? model.imageCents : null,
          videoCents: integer(model.videoCents, 1, MAX_CENTS) ? model.videoCents : null,
          promptPointsPer1K: number(model.promptPointsPer1K), completionPointsPer1K: number(model.completionPointsPer1K) };
      })
    };
  }
  function update(raw) {
    var next = sanitize(raw);
    revision += 1;
    current = next;
    retryAfter = next ? 0 : Date.now() + 5000;
    refreshAnnotations();
    listeners.forEach(function (listener) { try { listener(); } catch (_) {} });
    return !!next;
  }
  function ready() {
    if (current) return Promise.resolve(current);
    if (pending) return pending;
    if (Date.now() < retryAfter) return Promise.resolve(null);
    var startedAt = revision;
    var request = Promise.resolve().then(function () {
      if (typeof global.fetch !== 'function') return null;
      return global.fetch('/api/creative/credits', { credentials: 'same-origin', cache: 'no-store' }).then(function (response) {
        if (!response.ok) return null;
        return response.json().then(function (body) { return body && body.data; });
      });
    }).then(function (data) {
      // A fresh parent DTO wins over an older in-flight fetch.
      if (startedAt === revision) update(data);
      return current;
    }).catch(function () {
      if (startedAt === revision) update(null);
      return current;
    }).finally(function () {
      if (pending === request) pending = null;
    });
    pending = request;
    return pending;
  }
  function findModel(kind, name) {
    if (!current || !name) return null;
    var candidates = current.models.filter(function (model) { return model.kind === kind; });
    var exact = candidates.find(function (model) { return model.id === name; });
    if (exact) return exact;
    var aliases = candidates.filter(function (model) { return model.upstreamModel && model.upstreamModel === name; });
    return aliases.length === 1 ? aliases[0] : null;
  }
  function requestCounts(spec) {
    if (spec.requests !== undefined) {
      if (!Array.isArray(spec.requests) || spec.requests.length > 1000 || !spec.requests.every(function (n) { return integer(n, 1, spec.kind === 'video' ? 1 : 10); })) return null;
      var sum = spec.requests.reduce(function (total, n) { return total + n; }, 0);
      if (spec.count !== undefined && spec.count !== sum) return null;
      return spec.requests.slice();
    }
    var count = spec.count === undefined ? 1 : spec.count;
    if (!integer(count, 0, spec.kind === 'video' ? 1000 : 10)) return null;
    if (!count) return [];
    return spec.kind === 'video' ? Array(count).fill(1) : [count];
  }
  function charged(base) {
    if (!integer(base, 0, MAX_CENTS) || !current) return null;
    var result = Number((BigInt(base) * BigInt(current.plan.multiplierBps) + 9999n) / 10000n);
    return result <= MAX_CENTS ? result : null;
  }
  function describe(spec) {
    spec = spec || {};
    var extra = text(spec.detail, 500);
    var external = spec.channel === 'external_key';
    var preview = spec.channel === 'preview';
    if (spec.kind === 'local') return { text: '', detail: '', estimatedPoints: 0, platformPoints: 0 };
    if (['image', 'video', 'chat'].indexOf(spec.kind) < 0 || !hasRequest(spec)) return { text: '', detail: '' };
    if (external) return { text: '自有 API 计费', detail: ['费用由所配置的 API 服务计收', extra].filter(Boolean).join('；'), platformPoints: 0 };
    var detail = preview ? ['仅平台演示，不扣积分'] : ['预计值，最终以实际用量结算为准'];
    var result = { text: preview ? '演示积分待确认 · 不扣积分' : '本次积分待确认', detail: '' };
    if (preview) result.platformPoints = 0;
    var model = findModel(spec.kind, text(spec.model));
    if (spec.kind === 'chat') {
      result.text = preview ? '演示按实际 Token 计费 · 不扣积分' : '按实际 Token 计费';
      detail.push('分析或聊天消耗随输入和输出变化，生成前无法给出固定总积分');
      if (model && model.pricingStatus === 'priced' && model.promptPointsPer1K !== null && model.completionPointsPer1K !== null) {
        result.text = '输入 ' + String(model.promptPointsPer1K) + ' / 输出 ' + String(model.completionPointsPer1K) + ' 积分/千 Token' + (preview ? ' · 演示不扣积分' : ' · 按实际用量结算');
        detail.push('平台参考单价：输入 ' + String(model.promptPointsPer1K) + '、输出 ' + String(model.completionPointsPer1K) + ' 积分/千 Token');
      } else detail.push('平台模型价格待配置');
    } else if (spec.channel === 'platform_wallet' && number(spec.reservationPoints) !== null && integer(spec.reservationPoints * 10, 1, MAX_CENTS)) {
      result.text = (spec.perRequestReservation ? '每镜最多预占 ' : '提交预占 ') + format(spec.reservationPoints) + ' 积分';
      detail.push('提交时预占，完成后按实际用量结算并释放剩余；预占不代表最终费用');
    } else if (model && model.pricingStatus === 'priced') {
      var counts = requestCounts(spec);
      var rate = spec.kind === 'image' ? model.imageCents : spec.kind === 'video' ? model.videoCents : null;
      var sum = 0;
      if (counts && rate !== null) {
        counts.forEach(function (count) {
          var cost = charged(spec.kind === 'image' ? Math.max(1, count * rate) : count * rate);
          if (cost === null || sum + cost > MAX_CENTS) sum = NaN;
          else sum += cost;
        });
        if (Number.isSafeInteger(sum)) {
          var points = sum / 10;
          result.estimatedPoints = points;
          if (!preview) result.platformPoints = points;
          var quote = (preview ? '平台演示预计 ' : '本次预计 ') + format(points) + ' 积分';
          result.text = preview ? quote + ' · 不扣积分' : quote;
          detail.push(spec.kind === 'video' ? counts.length + ' 个视频任务，按任务固定价估算，不按秒数相乘' : counts.reduce(function (total, count) { return total + count; }, 0) + ' 张图片，按 ' + counts.length + ' 次请求分别取整');
        } else detail.push('报价参数超出范围，无法估算');
      } else detail.push(counts === null ? '实际请求张数未确认，无法估算' : '平台模型价格待配置');
    } else detail.push('平台模型价格待配置');
    if (spec.extraAnalysis && (spec.count === 0 || (Array.isArray(spec.requests) && spec.requests.length === 0))) {
      result.text = '分析按实际 Token 计费' + (preview ? ' · 演示不扣积分' : '');
      delete result.estimatedPoints;
      if (!preview) delete result.platformPoints;
    }
    if (spec.extraAnalysis) detail.push('另含分析调用，按实际 Token 计费，未计入图片或视频估算');
    if (extra) detail.push(extra);
    result.detail = detail.join('；');
    return result;
  }
  function hasRequest(spec) {
    if (!spec || ['image', 'video', 'chat'].indexOf(spec.kind) < 0) return false;
    if (spec.kind === 'chat' || spec.extraAnalysis) return true;
    return spec.count !== 0 && !(Array.isArray(spec.requests) && spec.requests.length === 0);
  }
  function paint(record) {
    var quote = describe(record.spec);
    var visible = quote.text + (record.spec.extraAnalysis ? '；另含分析，按实际 Token 计费' : '') + (text(record.spec.detail, 500) ? '；' + text(record.spec.detail, 500) : '');
    if (record.node.textContent !== visible) record.node.textContent = visible;
    if (record.node.title !== quote.detail) record.node.title = quote.detail;
    var hidden = !!record.button.hidden || (typeof record.button.getAttribute === 'function' && record.button.getAttribute('aria-hidden') === 'true');
    // Read the button's own computed display. A hidden ancestor does not make its display 'none',
    // so cached workbenches can restore their labels when activated again.
    if (typeof global.getComputedStyle === 'function') {
      var style = global.getComputedStyle(record.button);
      hidden = hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
    }
    if (record.wrapper.hidden !== hidden) record.wrapper.hidden = hidden;
    var display = hidden ? 'none' : 'inline-flex';
    if (record.wrapper.style.display !== display) record.wrapper.style.display = display;
  }
  function pruneAnnotations() {
    annotations.forEach(function (record, button) {
      if (button.isConnected === false) {
        if (record.observer) record.observer.disconnect();
        // Retain a detached button for its owner's later reuse, removing only our decoration.
        if (button.parentNode === record.wrapper && record.wrapper.parentNode) record.wrapper.parentNode.insertBefore(button, record.wrapper);
        if (typeof record.wrapper.remove === 'function') record.wrapper.remove();
        annotations.delete(button);
        return;
      }
    });
  }
  function refreshAnnotations() {
    pruneAnnotations();
    annotations.forEach(paint);
  }
  function removeAnnotation(button) {
    var record = annotations.get(button);
    if (!record) return;
    if (record.observer) record.observer.disconnect();
    if (button.parentNode === record.wrapper && record.wrapper.parentNode) record.wrapper.parentNode.insertBefore(button, record.wrapper);
    if (typeof record.wrapper.remove === 'function') record.wrapper.remove();
    annotations.delete(button);
  }
  function annotate(button, spec) {
    if (!button || !global.document || !button.parentNode) return null;
    pruneAnnotations();
    if (!hasRequest(spec)) { removeAnnotation(button); return null; }
    var record = annotations.get(button);
    if (!record) {
      var wrapper = global.document.createElement('span');
      wrapper.setAttribute('data-sz-credit-wrap', '');
      wrapper.className = 'sz-credit-action';
      wrapper.style.cssText = 'display:inline-flex;flex-direction:column;align-items:stretch;gap:4px;min-width:0;max-width:100%;';
      var node = global.document.createElement('small');
      node.setAttribute('data-sz-credit', '');
      node.style.cssText = 'display:block;font-size:12px;line-height:1.5;font-weight:400;color:inherit;opacity:.78;white-space:normal;';
      button.parentNode.insertBefore(wrapper, button);
      wrapper.appendChild(button);
      wrapper.appendChild(node);
      record = { button: button, wrapper: wrapper, node: node, spec: spec || {} };
      annotations.set(button, record);
      // Observe only this button's visibility; quote rendering cannot trigger the observer.
      if (typeof global.MutationObserver === 'function') {
        record.observer = new global.MutationObserver(function () { paint(record); });
        record.observer.observe(button, { attributes: true, attributeFilter: ['hidden', 'style', 'class', 'aria-hidden'] });
      }
    } else {
      // Existing workbench layout code may move the original button after annotation.
      if (button.parentNode !== record.wrapper) {
        button.parentNode.insertBefore(record.wrapper, button);
        record.wrapper.insertBefore(button, record.node);
      }
      record.spec = spec || {};
    }
    paint(record);
    ready();
    return record.node;
  }
  function subscribe(listener) {
    if (typeof listener !== 'function') return function () {};
    listeners.add(listener);
    return function () { listeners.delete(listener); };
  }
  global.SZCreativeCredits = Object.freeze({ ready: ready, describe: describe, annotate: annotate, update: update, subscribe: subscribe });
  if (typeof global.addEventListener === 'function') global.addEventListener('message', function (event) {
    var owner = global.parent || global;
    if (!event || event.source !== owner || !global.location || event.origin !== global.location.origin) return;
    var message = event.data;
    if (message && message.type === 'SZ_CREATIVE_CREDITS_UPDATE' && message.v === 1) update(message.data);
  });
})(typeof window !== 'undefined' ? window : globalThis);
