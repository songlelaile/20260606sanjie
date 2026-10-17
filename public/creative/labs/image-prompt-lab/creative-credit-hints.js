/* Display only. Quotes never change the configured provider or submit a model request. */
(function (global) {
  'use strict';
  var providers = new Map();
  var scheduled = false;
  var observer;
  var doc = global.document;
  function supplyChannel(kind) {
    try {
      if (typeof global.SZCreativeCreditChannel === 'function') {
        var value = global.SZCreativeCreditChannel(kind);
        if (value === 'platform_wallet' || value === 'external_key' || value === 'preview') return value;
      }
    } catch (error) {}
    return 'external_key';
  }
  function annotate(button, spec) {
    if (!button || !global.SZCreativeCredits) return;
    if (['image', 'video', 'chat'].indexOf(spec.kind) >= 0) button.dataset.szCreditKind = spec.kind;
    else delete button.dataset.szCreditKind;
    global.SZCreativeCredits.annotate(button, spec);
    if (button.matches('.action-close,.ct-remove,.sg-asset button')) button.closest('[data-sz-credit-wrap]')?.classList.add('sz-credit-icon-action');
  }
  function local(button, detail) { annotate(button, { kind: 'local', detail: detail || '' }); }
  function image(button, model, requests, detail, extraAnalysis, channel) {
    var spec = { kind: 'image', model: model || '', channel: ['platform_wallet', 'external_key', 'preview'].indexOf(channel) >= 0 ? channel : supplyChannel('image'), detail: detail || '', extraAnalysis: !!extraAnalysis };
    // Null intentionally means that the actual batch has not been confirmed yet.
    spec.requests = Array.isArray(requests) ? requests : null;
    if (Array.isArray(requests)) spec.count = requests.reduce(function (sum, count) { return sum + count; }, 0);
    annotate(button, spec);
  }
  function chat(button, model, detail) {
    annotate(button, { kind: 'chat', model: model || '', channel: supplyChannel('chat'), detail: '分析按实际 Token 用量计费' + (detail ? '；' + detail : '') });
  }
  function watch() {
    if (observer && doc.body) observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'class'] });
  }
  function refresh() {
    scheduled = false;
    if (!doc || !doc.body || !global.SZCreativeCredits) return;
    if (observer) observer.disconnect();
    try {
      providers.forEach(function (run) { try { run(); } catch (_) {} });
      // Only registered API submissions receive a quote. Other controls keep their original layout.
    } finally { watch(); }
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    global.requestAnimationFrame ? global.requestAnimationFrame(refresh) : global.setTimeout(refresh, 0);
  }
  function register(name, run) { providers.set(name, run); schedule(); }
  global.SZCreativeCreditHints = { annotate: annotate, local: local, image: image, chat: chat, register: register, refresh: schedule };
  if (!doc) return;
  if (global.MutationObserver) observer = new global.MutationObserver(schedule);
  doc.addEventListener('input', schedule);
  doc.addEventListener('change', schedule);
  // A click may change only in-memory selections; read them after its existing handler.
  doc.addEventListener('click', schedule);
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', schedule); else schedule();
})(typeof window !== 'undefined' ? window : globalThis);
