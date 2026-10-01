/* 网站工作台的浏览器兼容层：让原扩展页面在同源 iframe 里收发消息、按账号保存配置。 */
(function (global) {
  "use strict";

  var LOCAL_PREFIX = "sz.chrome.local.v1:";
  var SESSION_PREFIX = "sz.chrome.session.v1:";
  var PROXY_PATH = "/api/creative/proxy";
  var MAX_PROXY_BYTES = 24 * 1024 * 1024;
  var messageListeners = [];
  var nativeFetch = global.fetch ? global.fetch.bind(global) : null;
  var authState = null;

  function storageArea(storage, prefix) {
    function readAll() {
      var out = {};
      for (var i = 0; i < storage.length; i += 1) {
        var key = storage.key(i);
        if (!key || key.indexOf(prefix) !== 0) continue;
        try {
          out[key.slice(prefix.length)] = JSON.parse(storage.getItem(key));
        } catch (error) {
          out[key.slice(prefix.length)] = null;
        }
      }
      return out;
    }

    function namesOf(keys) {
      if (keys == null) return null;
      if (typeof keys === "string") return [keys];
      if (Array.isArray(keys)) return keys.slice();
      if (typeof keys === "object") return Object.keys(keys);
      return [];
    }

    return {
      get: function (keys, callback) {
        var all = readAll();
        var names = namesOf(keys);
        var result = {};
        if (names == null) {
          result = all;
        } else {
          names.forEach(function (name) {
            if (Object.prototype.hasOwnProperty.call(all, name)) result[name] = all[name];
            else if (keys && typeof keys === "object" && !Array.isArray(keys) && Object.prototype.hasOwnProperty.call(keys, name)) {
              result[name] = keys[name];
            }
          });
        }
        chromeApi.runtime.lastError = undefined;
        if (typeof callback === "function") callback(result);
        return Promise.resolve(result);
      },
      set: function (items, callback) {
        Object.keys(items || {}).forEach(function (name) {
          storage.setItem(prefix + name, JSON.stringify(items[name]));
        });
        chromeApi.runtime.lastError = undefined;
        if (typeof callback === "function") callback();
        return Promise.resolve();
      },
      remove: function (keys, callback) {
        (namesOf(keys) || []).forEach(function (name) {
          storage.removeItem(prefix + name);
        });
        chromeApi.runtime.lastError = undefined;
        if (typeof callback === "function") callback();
        return Promise.resolve();
      },
      clear: function (callback) {
        Object.keys(readAll()).forEach(function (name) {
          storage.removeItem(prefix + name);
        });
        chromeApi.runtime.lastError = undefined;
        if (typeof callback === "function") callback();
        return Promise.resolve();
      }
    };
  }

  function headerObject(headers) {
    var out = {};
    if (!headers) return out;
    if (typeof Headers !== "undefined" && headers instanceof Headers) {
      headers.forEach(function (value, key) { out[key] = value; });
      return out;
    }
    if (Array.isArray(headers)) {
      headers.forEach(function (pair) {
        if (pair && pair.length >= 2) out[String(pair[0])] = String(pair[1]);
      });
      return out;
    }
    Object.keys(headers).forEach(function (key) { out[key] = String(headers[key]); });
    return out;
  }

  function bytesToBase64(bytes) {
    var chunks = [];
    var size = 0x8000;
    for (var i = 0; i < bytes.length; i += size) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + size)));
    }
    return btoa(chunks.join(""));
  }

  function encodeBody(body) {
    if (body == null) return Promise.resolve({ kind: "empty" });
    if (typeof FormData !== "undefined" && body instanceof FormData) return Promise.resolve({ kind: "form", form: body });
    if (typeof body === "string") return Promise.resolve({ kind: "text", text: body });
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      return Promise.resolve({ kind: "text", text: body.toString(), contentType: "application/x-www-form-urlencoded" });
    }
    if (typeof Blob !== "undefined" && body instanceof Blob) {
      return body.arrayBuffer().then(function (buffer) {
        return { kind: "base64", base64: bytesToBase64(new Uint8Array(buffer)), contentType: body.type || "" };
      });
    }
    if (body instanceof ArrayBuffer) {
      return Promise.resolve({ kind: "base64", base64: bytesToBase64(new Uint8Array(body)) });
    }
    if (ArrayBuffer.isView(body)) {
      return Promise.resolve({ kind: "base64", base64: bytesToBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)) });
    }
    return Promise.resolve({ kind: "text", text: String(body) });
  }

  function shouldProxy(url) {
    try {
      var parsed = new URL(url, global.location.href);
      return parsed.protocol === "https:" && parsed.origin !== global.location.origin;
    } catch (error) {
      return false;
    }
  }

  function proxyFetch(url, init) {
    init = init || {};
    var headers = headerObject(init.headers);
    return encodeBody(init.body).then(function (encoded) {
      var payloadBytes = encoded.kind === "text" ? encoded.text.length : (encoded.kind === "base64" ? encoded.base64.length : 0);
      if (payloadBytes > MAX_PROXY_BYTES) {
        return Promise.reject(new Error("请求体超过网站转发上限。"));
      }
      if (encoded.kind === "form") {
        var form = new FormData();
        form.set("__sz_url", url);
        form.set("__sz_method", String(init.method || "POST"));
        form.set("__sz_headers", JSON.stringify(headers));
        encoded.form.forEach(function (value, key) { form.append(key, value); });
        return nativeFetch(PROXY_PATH, { method: "POST", body: form, credentials: "same-origin", cache: "no-store" });
      }
      return nativeFetch(PROXY_PATH, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url,
          method: String(init.method || "GET"),
          headers: headers,
          bodyText: encoded.kind === "text" ? encoded.text : "",
          bodyBase64: encoded.kind === "base64" ? encoded.base64 : "",
          contentType: encoded.contentType || headers["Content-Type"] || headers["content-type"] || ""
        })
      });
    });
  }

  if (nativeFetch) {
    global.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var requestInit = init || {};
      if (!init && input && typeof Request !== "undefined" && input instanceof Request) {
        requestInit = {
          method: input.method,
          headers: input.headers,
          body: input.method === "GET" || input.method === "HEAD" ? undefined : input.body
        };
      }
      if (!shouldProxy(url)) return nativeFetch(input, init);
      return proxyFetch(url, requestInit);
    };
  }

  var chromeApi = {
    runtime: {
      id: "shaozhuang-web-studio",
      lastError: undefined,
      getManifest: function () {
        return { name: "少壮视觉工作台", version: "web", manifest_version: 3 };
      },
      getURL: function (path) {
        var clean = String(path || "").replace(/^\//, "");
        return new URL("/creative/" + clean, global.location.origin).href;
      },
      sendMessage: function (message, callback) {
        chromeApi.runtime.lastError = undefined;
        var responded = false;
        var pendingAsync = false;
        function sendResponse(response) {
          if (responded) return;
          responded = true;
          chromeApi.runtime.lastError = undefined;
          if (typeof callback === "function") callback(response);
        }
        messageListeners.slice().forEach(function (fn) {
          try {
            var keep = fn(message, { id: chromeApi.runtime.id, url: global.location.href, tab: { id: 1 } }, sendResponse);
            if (keep === true) pendingAsync = true;
          } catch (error) {
            console.error(error);
          }
        });
        if (!pendingAsync && !responded) {
          chromeApi.runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
          if (typeof callback === "function") callback(undefined);
        }
      },
      onMessage: {
        addListener: function (fn) { messageListeners.push(fn); },
        removeListener: function (fn) {
          messageListeners = messageListeners.filter(function (item) { return item !== fn; });
        }
      },
      onInstalled: {
        addListener: function (fn) {
          setTimeout(function () {
            try { fn({ reason: "install" }); } catch (error) { console.warn(error); }
          }, 0);
        }
      },
      onStartup: {
        addListener: function (fn) {
          setTimeout(function () {
            try { fn(); } catch (error) { console.warn(error); }
          }, 0);
        }
      }
    },
    storage: {},
    tabs: {
      create: function (options, callback) {
        var opened = global.open((options && options.url) || "about:blank", "_blank", "noopener");
        if (typeof callback === "function") callback(opened ? { id: 1 } : undefined);
      },
      update: function (_id, _options, callback) {
        if (typeof callback === "function") callback();
      },
      remove: function (_id, callback) {
        if (typeof callback === "function") callback();
      },
      sendMessage: function () {}
    },
    downloads: {
      download: function (options, callback) {
        var link = global.document.createElement("a");
        link.href = options && options.url || "";
        link.download = options && options.filename || "";
        link.rel = "noopener";
        global.document.body.appendChild(link);
        link.click();
        link.remove();
        if (typeof callback === "function") callback(1);
      }
    },
    permissions: {
      request: function (_options, callback) {
        if (typeof callback === "function") callback(true);
      }
    },
    contextMenus: {
      create: function () {},
      removeAll: function (callback) {
        if (typeof callback === "function") callback();
      },
      onClicked: { addListener: function () {} }
    },
    alarms: {
      create: function () {},
      onAlarm: { addListener: function () {} }
    },
    action: { onClicked: { addListener: function () {} } },
    scripting: {
      executeScript: function () { return Promise.resolve([]); }
    }
  };
  chromeApi.storage.local = storageArea(global.localStorage, LOCAL_PREFIX);
  chromeApi.storage.session = storageArea(global.sessionStorage, SESSION_PREFIX);
  global.chrome = chromeApi;

  global.authCheck = function () {
    if (authState) return Promise.resolve(authState);
    return nativeFetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (body) {
        var data = body && body.data;
        if (!data || !data.username || !data.tenantId) return { ok: false, reason: "auth_error" };
        authState = {
          ok: true,
          user: {
            id: String(data.tenantId) + ":" + String(data.username),
            username: data.username,
            email: data.username,
            name: data.name || data.username
          }
        };
        return authState;
      })
      .catch(function () { return { ok: false, reason: "auth_error" }; });
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
