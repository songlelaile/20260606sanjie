(function () {
  'use strict';
  const prefix = '/sower-work/app';
  function mapUrl(value) {
    const url = new URL(String(value), window.location.href);
    const sameOrigin = url.origin === window.location.origin || ((url.protocol === 'ws:' || url.protocol === 'wss:') && url.host === window.location.host && url.protocol === (window.location.protocol === 'https:' ? 'wss:' : 'ws:'));
    if (!sameOrigin || url.pathname.startsWith(prefix + '/')) return String(value);
    if (url.pathname.startsWith('/api/') || ['/ws', '/login', '/logout'].includes(url.pathname)) {
      url.pathname = prefix + url.pathname;
      return url.href;
    }
    return String(value);
  }
  window.__sowerCloudPrefix = mapUrl;
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const target = mapUrl(input instanceof Request ? input.url : input);
    return fetchOriginal(input instanceof Request ? new Request(target, input) : target, init);
  };
  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    return xhrOpen.call(this, method, mapUrl(url), ...rest);
  };
  for (const name of ['WebSocket', 'EventSource']) {
    const Native = window[name];
    if (!Native) continue;
    window[name] = class extends Native {
      constructor(url, ...rest) { super(mapUrl(url), ...rest); }
    };
  }
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    return setAttribute.call(this, name, ['src', 'href', 'action'].includes(name.toLowerCase()) ? mapUrl(value) : value);
  };
  for (const [Type, name] of [[HTMLImageElement, 'src'], [HTMLAnchorElement, 'href'], [HTMLMediaElement, 'src'], [HTMLIFrameElement, 'src'], [HTMLSourceElement, 'src']]) {
    const descriptor = Object.getOwnPropertyDescriptor(Type.prototype, name);
    if (!descriptor || !descriptor.set || !descriptor.get) continue;
    Object.defineProperty(Type.prototype, name, {
      ...descriptor,
      set(value) { descriptor.set.call(this, mapUrl(value)); },
    });
  }
  // Keep private authenticated API responses outside the upstream PWA cache.
  if (navigator.serviceWorker) {
    navigator.serviceWorker.register = function () { return Promise.reject(new Error('Cloud WebUI uses online sessions')); };
  }
  // A healthy backend does not prove that the actual iframe renderer loaded.
  let notified = false;
  window.__sowerCloudNotifyReady = function () {
    if (notified || window.parent === window) return;
    const token = new URL(window.location.href).searchParams.get('_frameToken');
    if (!token || !/^[A-Za-z0-9_-]{16,80}$/.test(token)) return;
    notified = true;
    window.parent.postMessage({ type: 'SOWER_WORK_RENDERER_READY', v: 1, token }, window.location.origin);
  };
  if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
    const appeared = function () {
      const root = document.getElementById('root');
      if (!root || !root.querySelector('.arco-layout, .arco-menu, nav, main, a[href^="#/"]')) return false;
      window.__sowerCloudNotifyReady();
      return true;
    };
    if (!appeared()) {
      const observer = new MutationObserver(function () { if (appeared()) observer.disconnect(); });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(function () { observer.disconnect(); }, 30000);
    }
  }
})();
