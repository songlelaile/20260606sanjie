/* 网站工作台的浏览器兼容层：让原扩展页面在同源 iframe 里收发消息、按账号保存配置。 */
(function (global) {
  "use strict";

  var ENVIRONMENT_PREFIX = global.__SANJIE_ENVIRONMENT ? "environment:" + encodeURIComponent(String(global.__SANJIE_ENVIRONMENT)) + ":" : "";
  var LOCAL_PREFIX = "sz.chrome.local.v1:" + ENVIRONMENT_PREFIX;
  var SESSION_PREFIX = "sz.chrome.session.v1:" + ENVIRONMENT_PREFIX;
  var PROXY_PATH = "/api/creative/proxy";
  var MAX_PROXY_BYTES = 24 * 1024 * 1024;
  var messageListeners = [];
  var openedTabs = new Map();
  var nextTabId = 2;
  var documentId = "web-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  var nativeFetch = global.fetch ? global.fetch.bind(global) : null;
  var pinnedAccount = "";
  var accountBlocked = false;
  var authInFlight = null;
  var screenshotDatabasePromise = null;
  var SCREENSHOT_STORAGE_POINTER_SCHEMA = "SZ_SCREENSHOT_STORAGE_POINTER_V1";
  var SCREENSHOT_STORAGE_RECORD_SCHEMA = "SZ_SCREENSHOT_STORAGE_RECORD_V1";
  var SCREENSHOT_STORAGE_DATABASE = "sz.chrome.screenshot-values.v1";
  var SCREENSHOT_STORAGE_STORE = "values";
  var SCREENSHOT_STORAGE_TIMEOUT_MS = 10000;

  function screenshotStorageError(message) {
    return Object.assign(new Error(message || "参考详情截图存储不可用，请保留当前截图后重试。"), { code: "SCREENSHOT_STORAGE_UNAVAILABLE" });
  }

  function containsScreenshotSource(value) {
    var stack = [value], seen = typeof WeakSet === "function" ? new WeakSet() : null;
    while (stack.length) {
      var current = stack.pop();
      if (!current || typeof current !== "object") continue;
      if (seen && seen.has(current)) continue;
      if (seen) seen.add(current);
      if (current.schema === "REFERENCE_DETAIL_SCREENSHOT_SOURCE_V1" ||
          current.schema === "REFERENCE_DETAIL_SCREENSHOT_OWNED_RECORD_V1" && current.sourceSchema === "REFERENCE_DETAIL_SCREENSHOT_SOURCE_V1") return true;
      Object.keys(current).forEach(function (key) {
        var child = current[key];
        if (child && typeof child === "object") stack.push(child);
      });
    }
    return false;
  }

  function screenshotPointer(value, storageKey) {
    if (!value || value.schema !== SCREENSHOT_STORAGE_POINTER_SCHEMA) return null;
    if (Object.keys(value).length !== 3 || value.storageKey !== storageKey || typeof value.recordId !== "string" ||
        !/^screenshot-record-[A-Za-z0-9-]{10,160}$/.test(value.recordId)) {
      throw screenshotStorageError("参考详情截图存储索引损坏，原数据未覆盖。请重新载入后重试。");
    }
    return value;
  }

  function oldScreenshotPointer(raw, storageKey) {
    if (raw === null) return null;
    var value;
    try { value = JSON.parse(raw); }
    catch (_) { return null; }
    return screenshotPointer(value, storageKey);
  }

  function openScreenshotDatabase() {
    if (screenshotDatabasePromise) return screenshotDatabasePromise;
    if (!global.indexedDB || typeof global.indexedDB.open !== "function") return Promise.reject(screenshotStorageError("当前浏览器无法保存参考详情截图，请使用支持 IndexedDB 的浏览器。"));
    var pending = new Promise(function (resolve, reject) {
      var request, settled = false;
      var timer = setTimeout(function () { fail("参考详情截图数据库打开超时，请重新载入后重试。"); }, SCREENSHOT_STORAGE_TIMEOUT_MS);
      function fail(message) {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(screenshotStorageError(message));
      }
      try { request = global.indexedDB.open(SCREENSHOT_STORAGE_DATABASE, 1); }
      catch (_) { fail(); return; }
      request.onupgradeneeded = function () {
        if (settled) { try { request.transaction.abort(); } catch (_) {} return; }
        if (!request.result.objectStoreNames.contains(SCREENSHOT_STORAGE_STORE)) request.result.createObjectStore(SCREENSHOT_STORAGE_STORE);
      };
      request.onerror = function () { fail("参考详情截图数据库打开失败，原数据未覆盖。"); };
      request.onblocked = function () { fail("参考详情截图数据库被其他页面占用，请关闭旧工作台后重试。"); };
      request.onsuccess = function () {
        var database = request.result;
        if (settled) { database.close(); return; }
        settled = true; clearTimeout(timer);
        database.onversionchange = function () { database.close(); screenshotDatabasePromise = null; };
        resolve(database);
      };
    });
    screenshotDatabasePromise = pending;
    pending.catch(function () { if (screenshotDatabasePromise === pending) screenshotDatabasePromise = null; });
    return pending;
  }

  function screenshotDatabaseTransaction(mode, work) {
    return openScreenshotDatabase().then(function (database) {
      return new Promise(function (resolve, reject) {
        var transaction, result, settled = false;
        var timer = setTimeout(function () {
          fail("参考详情截图读写超时，原存储索引已保留。请重新载入后重试。");
          if (transaction) { try { transaction.abort(); } catch (_) {} }
        }, SCREENSHOT_STORAGE_TIMEOUT_MS);
        function fail(message) {
          if (settled) return;
          settled = true; clearTimeout(timer); reject(screenshotStorageError(message));
        }
        try {
          transaction = database.transaction(SCREENSHOT_STORAGE_STORE, mode);
          transaction.oncomplete = function () { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
          transaction.onerror = transaction.onabort = function () { fail("参考详情截图读写失败，原存储索引已保留。"); };
          result = work(transaction.objectStore(SCREENSHOT_STORAGE_STORE));
        } catch (_) {
          if (transaction) { try { transaction.abort(); } catch (_) {} }
          fail();
        }
      });
    });
  }

  function deleteScreenshotRecords(ids) {
    if (!ids.length) return Promise.resolve();
    return screenshotDatabaseTransaction("readwrite", function (store) { ids.forEach(function (id) { store.delete(id); }); });
  }

  function screenshotStorageLock(scope, work) {
    var locks = global.navigator && global.navigator.locks;
    if (!locks || typeof locks.request !== "function" || typeof AbortController !== "function") return work();
    var controller = new AbortController();
    var acquired = false;
    var timer = setTimeout(function () { if (!acquired) controller.abort(); }, SCREENSHOT_STORAGE_TIMEOUT_MS);
    return Promise.resolve().then(function () {
      return locks.request("sz.chrome.screenshot-values:" + scope, { mode: "exclusive", signal: controller.signal }, function () {
        acquired = true; clearTimeout(timer); return work();
      });
    }).catch(function (error) {
      if (!acquired && controller.signal.aborted) throw screenshotStorageError("参考详情截图存储锁等待超时，原数据未覆盖。请稍后重试。");
      throw error;
    }).finally(function () { clearTimeout(timer); });
  }

  function accountKey(user) {
    return user && user.id || "";
  }

  function blockAccount() {
    accountBlocked = true;
    if (!global.document || !global.document.body || global.document.getElementById("sz-web-account-expired")) return;
    var overlay = global.document.createElement("div");
    overlay.id = "sz-web-account-expired";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#10170b;color:#fff;display:grid;place-content:center;gap:16px;text-align:center;padding:24px";
    overlay.setAttribute("role", "alert");
    overlay.textContent = "登录账号已变更或会话已失效。请刷新工作台后继续，原账号的配置和成果仍保留。";
    var button = global.document.createElement("button");
    button.textContent = "刷新工作台";
    button.addEventListener("click", function () { global.location.reload(); });
    overlay.appendChild(button);
    global.document.body.appendChild(overlay);
  }

  function authenticatedAccount(auth) {
    if (!auth || !auth.ok || !accountKey(auth.user)) {
      var transient = auth && auth.reason === "auth_transient";
      throw Object.assign(new Error(transient ? "身份验证暂不可用，请稍后重试；原账号的素材和回执仍保留。" : "当前账号身份已失效，请刷新工作台后继续。"),
        { code: "ACCOUNT_UNAVAILABLE", retryable: !!transient });
    }
    return auth.user.id;
  }

  function requireAccount() {
    return global.authCheck().then(authenticatedAccount);
  }
  // Website model requests use the current login session. Only the canonical
  // hosted routes qualify; extension and external-provider requests still need
  // their own credential.
  function usesPlatformWallet(config, kind) {
    if (!config || config.provider !== "openai-compatible") return false;
    var endpoint = kind === "image" ? config.imageEndpoint : kind === "chat" ? config.visionBaseUrl : "";
    if (typeof endpoint !== "string" || !endpoint.trim()) return false;
    try {
      var url = new URL(endpoint);
      if (url.protocol !== "https:" || url.hostname !== "sub.shaozhuangai.com" ||
          url.username || url.password || url.port || url.search || url.hash) return false;
      return kind === "image" ? /^\/v1\/images\/(?:generations|edits)\/?$/.test(url.pathname) : /^\/v1\/?$/.test(url.pathname);
    } catch (_) { return false; }
  }
  global.SZ_WEB_ACCOUNT = {
    require: requireAccount,
    storageKey: profileKey,
    usesPlatformWallet: usesPlatformWallet,
    requireAccess: function () {
      // Identity and entitlement must come from the same current response.
      // Retain a fresh check for every operation, without a second serial trip.
      return global.authCheck().then(function (auth) {
        var id = authenticatedAccount(auth);
        if (!auth.creativeEntitlement || auth.creativeEntitlement.allowed !== true) {
          throw Object.assign(new Error("当前账号尚未开通作图和视频，请在网站充值开通。"), { code: "CREATIVE_ACCESS_REQUIRED" });
        }
        return id;
      });
    }
  };

  function profileKey(id) {
    return "user:" + String(id).replace(/[^\w@.+:-]/g, "_").slice(0, 120);
  }

  // Copy only records with an explicit current-account owner. Keep the original
  // v1 records untouched, including unowned legacy material awaiting review.
  function ownedLegacy(name, value, id, storage, prefix) {
    if (!value || typeof value !== "object") return undefined;
    var owner = profileKey(id);
    if (value.accounts && typeof value.accounts === "object") {
      var out = Object.assign({}, value, { accounts: {} });
      [id, owner].forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(value.accounts, key)) out.accounts[key] = value.accounts[key];
      });
      if (!Object.keys(out.accounts).length) return undefined;
      return out;
    }
    if (name === "sz_web_video_api_key_v1" && typeof value[id] === "string") {
      var map = {}; map[id] = value[id]; return map;
    }
    if (value.accountKey === id || value.accountKey === owner) return value;
    if (name === "sz_image_prompt_lab_config") {
      try {
        var profiles = JSON.parse(storage.getItem(prefix + "sz_image_prompt_lab_config_profiles_v2") || "null");
        var configs = profiles && profiles.accounts && profiles.accounts[owner] && profiles.accounts[owner].configs;
        if (configs && Object.keys(configs).some(function (provider) { return JSON.stringify(configs[provider]) === JSON.stringify(value); })) return value;
      } catch (_) {}
    }
    return undefined;
  }

  function storageArea(storage, prefix) {
    var supportsScreenshotStorage = prefix === LOCAL_PREFIX;
    function namesOf(keys) {
      if (keys == null) return null;
      if (typeof keys === "string") return [keys];
      if (Array.isArray(keys)) return keys.slice();
      return keys && typeof keys === "object" ? Object.keys(keys) : [];
    }
    function operation(work, callback, isRead) {
      return requireAccount().then(function (id) {
        var scopedPrefix = prefix + "account:" + encodeURIComponent(id) + ":";
        return work(scopedPrefix, id);
      }).then(function (result) {
        chromeApi.runtime.lastError = undefined;
        if (typeof callback === "function") callback(result);
        return result;
      }, function (error) {
        chromeApi.runtime.lastError = { message: error && error.message || "浏览器存储不可用。" };
        if (typeof callback === "function") { callback(isRead && error.code !== "SCREENSHOT_STORAGE_UNAVAILABLE" ? {} : undefined); return; }
        throw error;
      });
    }
    return {
      get: function (keys, callback) {
        return operation(function (scopedPrefix, id) {
          var names = namesOf(keys);
          if (names == null) {
            names = [];
            for (var i = 0; i < storage.length; i += 1) {
              var key = storage.key(i);
              if (key && key.indexOf(scopedPrefix) === 0) names.push(key.slice(scopedPrefix.length));
            }
          }
          var result = {};
          var pointers = [];
          names.forEach(function (name) {
            var raw = storage.getItem(scopedPrefix + name);
            var value;
            if (raw !== null) value = JSON.parse(raw);
            else {
              var legacyRaw = storage.getItem(prefix + name);
              if (legacyRaw !== null) value = ownedLegacy(name, JSON.parse(legacyRaw), id, storage, prefix);
              if (value !== undefined) storage.setItem(scopedPrefix + name, JSON.stringify(value));
            }
            var pointer = supportsScreenshotStorage && screenshotPointer(value, scopedPrefix + name);
            if (pointer) pointers.push({ name: name, pointer: pointer });
            else if (value !== undefined) result[name] = value;
            else if (keys && typeof keys === "object" && !Array.isArray(keys)) result[name] = keys[name];
          });
          if (!pointers.length) return result;
          return screenshotDatabaseTransaction("readonly", function (store) {
            var records = {};
            pointers.forEach(function (item) {
              var request = store.get(item.pointer.recordId);
              request.onsuccess = function () { records[item.name] = request.result; };
            });
            return records;
          }).then(function (records) {
            pointers.forEach(function (item) {
              var record = records[item.name];
              if (!record || record.schema !== SCREENSHOT_STORAGE_RECORD_SCHEMA || record.storageKey !== item.pointer.storageKey ||
                  !Object.prototype.hasOwnProperty.call(record, "value")) {
                throw screenshotStorageError("参考详情截图存储内容缺失或账号不匹配，原索引未覆盖。请重新载入后重试。");
              }
              result[item.name] = record.value;
            });
            return result;
          });
        }, callback, true);
      },
      set: function (items, callback) {
        return operation(function (scopedPrefix) {
          var entries = Object.keys(items || {}).map(function (name) {
            var key = scopedPrefix + name, oldRaw = storage.getItem(key);
            var oldPointer = null;
            if (supportsScreenshotStorage) oldPointer = oldScreenshotPointer(oldRaw, key);
            var large = supportsScreenshotStorage && containsScreenshotSource(items[name]);
            var recordId = large ? "screenshot-record-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2) : "";
            var value = large ? { schema: SCREENSHOT_STORAGE_POINTER_SCHEMA, storageKey: key, recordId: recordId } : items[name];
            return { key: key, oldRaw: oldRaw, oldPointer: oldPointer, raw: JSON.stringify(value), recordId: recordId, value: items[name] };
          });
          var largeEntries = entries.filter(function (entry) { return !!entry.recordId; });
          var screenshotMutation = largeEntries.length || entries.some(function (entry) { return !!entry.oldPointer; });
          function persistEntries() {
            var write = largeEntries.length ? screenshotDatabaseTransaction("readwrite", function (store) {
              largeEntries.forEach(function (entry) {
                store.put({ schema: SCREENSHOT_STORAGE_RECORD_SCHEMA, storageKey: entry.key, value: entry.value }, entry.recordId);
              });
            }) : Promise.resolve();
            return write.then(function () {
              var written = [];
              try {
                if (screenshotMutation && entries.some(function (entry) { return storage.getItem(entry.key) !== entry.oldRaw; })) {
                  throw screenshotStorageError("参考详情截图记录已在其他工作台变更，本次保存未覆盖新值。请重新载入后重试。");
                }
                entries.forEach(function (entry) {
                  if (screenshotMutation && storage.getItem(entry.key) !== entry.oldRaw) throw screenshotStorageError("参考详情截图记录已在其他工作台变更，本次保存已停止。");
                  storage.setItem(entry.key, entry.raw); written.push(entry);
                });
              } catch (error) {
                var rollbackFailed = false;
                written.slice().reverse().forEach(function (entry) {
                  try {
                    if (storage.getItem(entry.key) !== entry.raw) return;
                    if (entry.oldRaw === null) storage.removeItem(entry.key);
                    else storage.setItem(entry.key, entry.oldRaw);
                  } catch (_) { rollbackFailed = true; }
                });
                var unusedIds = largeEntries.filter(function (entry) { return storage.getItem(entry.key) !== entry.raw; }).map(function (entry) { return entry.recordId; });
                return deleteScreenshotRecords(unusedIds).catch(function () {}).then(function () {
                  if (rollbackFailed) throw screenshotStorageError("参考详情截图保存失败，部分旧索引未能恢复。已有有效内容已保留，请重新载入核对。");
                  throw error;
                });
              }
              var oldIds = entries.filter(function (entry) { return !!entry.oldPointer; }).map(function (entry) { return entry.oldPointer.recordId; });
              // A cleanup failure leaves an unreachable older value; the new value
              // is already committed and its valid account index must be retained.
              return deleteScreenshotRecords(oldIds).catch(function () {});
            });
          }
          return screenshotMutation ? screenshotStorageLock(scopedPrefix, persistEntries) : persistEntries();
        }, callback);
      },
      remove: function (keys, callback) {
        return operation(function (scopedPrefix) {
          return removeNames(scopedPrefix, namesOf(keys) || []);
        }, callback);
      },
      clear: function (callback) {
        return operation(function (scopedPrefix) {
          var names = [];
          for (var i = 0; i < storage.length; i += 1) {
            var key = storage.key(i);
            if (key && key.indexOf(scopedPrefix) === 0) names.push(key);
          }
          return removeNames(scopedPrefix, names.map(function (key) { return key.slice(scopedPrefix.length); }));
        }, callback);
      }
    };
    function removeNames(scopedPrefix, names) {
      names = Array.from(new Set(names));
      var entries = names.map(function (name) {
        var key = scopedPrefix + name, raw = storage.getItem(key);
        return { key: key, raw: raw, pointer: supportsScreenshotStorage ? oldScreenshotPointer(raw, key) : null };
      });
      function removeEntries() {
        var removed = [];
        try { entries.forEach(function (entry) {
          if (storage.getItem(entry.key) !== entry.raw) throw screenshotStorageError("存储记录已在其他工作台变更，本次删除已停止。");
          storage.removeItem(entry.key); removed.push(entry);
        }); }
        catch (error) {
          removed.slice().reverse().forEach(function (entry) {
            try { if (entry.raw !== null && storage.getItem(entry.key) === null) storage.setItem(entry.key, entry.raw); } catch (_) {}
          });
          throw error;
        }
        // The index deletion is the remove operation. Database cleanup is best
        // effort: after a timeout its commit may be unknown, so restoring the old
        // pointer could point at an already deleted value. Never recreate it.
        return deleteScreenshotRecords(entries.filter(function (entry) { return !!entry.pointer; }).map(function (entry) { return entry.pointer.recordId; })).catch(function () {});
      }
      return entries.some(function (entry) { return !!entry.pointer; }) ? screenshotStorageLock(scopedPrefix, removeEntries) : removeEntries();
    }
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
      return parsed.origin !== global.location.origin && (parsed.protocol === "https:" || parsed.protocol === "http:");
    } catch (error) {
      return false;
    }
  }

  function proxyFetch(url, init) {
    init = init || {};
    var headers = headerObject(init.headers);
    return global.SZ_WEB_ACCOUNT.requireAccess().then(function () { return encodeBody(init.body); }).then(function (encoded) {
      var payloadBytes = encoded.kind === "text" ? new TextEncoder().encode(encoded.text).byteLength : (encoded.kind === "base64" ? Math.ceil(encoded.base64.length * 3 / 4) : 0);
      if (payloadBytes > MAX_PROXY_BYTES) {
        return Promise.reject(new Error("请求体超过网站转发上限。"));
      }
      if (encoded.kind === "form") {
        var form = new FormData();
        form.set("__sz_url", url);
        form.set("__sz_method", String(init.method || "POST"));
        form.set("__sz_headers", JSON.stringify(headers));
        var formBytes = 0;
        encoded.form.forEach(function (value, key) {
          if (/^__sz_/.test(key)) throw new Error("上传字段使用了工作台保留名称。");
          formBytes += typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.size;
          form.append(key, value);
        });
        if (formBytes > MAX_PROXY_BYTES) throw new Error("上传素材超过网站转发上限。");
        return nativeFetch(PROXY_PATH, { method: "POST", body: form, credentials: "same-origin", cache: "no-store", signal: init.signal });
      }
      return nativeFetch(PROXY_PATH, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal: init.signal,
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
    }).then(function (response) {
      // This provenance comes only from our same-origin proxy. It rebuilds
      // upstream headers and never forwards this local rejection marker.
      if (response && response.headers && response.headers.get("X-Sanjie-Provider-Submission") === "not-submitted") {
        response.szCreativeProxyNotSubmitted = true;
      }
      return response;
    });
  }

  if (nativeFetch) {
    global.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && (input.url || input.href)) || "";
      if (!shouldProxy(url)) return nativeFetch(input, init);
      if (typeof Request !== "undefined" && input instanceof Request) {
        var request = new Request(input, init);
        return (request.method === "GET" || request.method === "HEAD" ? Promise.resolve(undefined) : request.clone().arrayBuffer())
          .then(function (body) { return proxyFetch(request.url, { method: request.method, headers: request.headers, body: body, signal: request.signal }); });
      }
      return proxyFetch(url, init || {});
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
            var keep = fn(message, { id: chromeApi.runtime.id, url: global.location.href, origin: global.location.origin, frameId: 0, documentId: documentId, tab: { id: 1, url: global.location.href } }, sendResponse);
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
        var opened = global.open((options && options.url) || "about:blank", "_blank");
        if (opened) { try { opened.opener = null; } catch (_) {} }
        var id = opened ? nextTabId++ : undefined;
        if (opened) openedTabs.set(id, opened);
        chromeApi.runtime.lastError = opened ? undefined : { message: "浏览器阻止了新窗口，请允许本网站打开窗口后重试。" };
        if (typeof callback === "function") callback(opened ? { id: id } : undefined);
      },
      update: function (id, options, callback) {
        var opened = openedTabs.get(id);
        try {
          if (!opened || opened.closed) throw new Error("工作台窗口已经关闭。");
          if (options && options.url) opened.location.href = options.url;
          chromeApi.runtime.lastError = undefined;
          if (typeof callback === "function") callback({ id: id });
        } catch (error) {
          chromeApi.runtime.lastError = { message: error.message || "无法打开工作台。" };
          if (typeof callback === "function") callback(undefined);
        }
      },
      remove: function (id, callback) {
        var opened = openedTabs.get(id);
        if (opened) { opened.close(); openedTabs.delete(id); }
        chromeApi.runtime.lastError = undefined;
        if (typeof callback === "function") callback();
      },
      query: function (_options, callback) {
        chromeApi.runtime.lastError = { message: "网页无法读取其他网站的浏览器标签，请使用原采集扩展后导入正式来源快照。" };
        if (typeof callback === "function") callback([]);
      },
      sendMessage: function (_id, _message, callback) {
        chromeApi.runtime.lastError = { message: "网页无法向淘宝页面注入采集程序，请使用原采集扩展后导入正式来源快照。" };
        if (typeof callback === "function") callback(undefined);
      }
    },
    downloads: {
      download: function (options, callback) {
        var source = options && options.url || "";
        var objectUrl = "";
        var promise = requireAccount().then(function () {
          if (/^https?:/i.test(source)) {
            return global.fetch(source, { credentials: "omit" }).then(function (response) {
              if (!response.ok) throw new Error("下载失败（HTTP " + response.status + "）。");
              var size = Number(response.headers.get("content-length")) || 0;
              if (size > 256 * 1024 * 1024) throw new Error("单个下载文件超过 256 MiB 上限。");
              return response.blob();
            }).then(function (blob) {
              if (blob.size > 256 * 1024 * 1024) throw new Error("单个下载文件超过 256 MiB 上限。");
              objectUrl = URL.createObjectURL(blob); return objectUrl;
            });
          }
          if (!/^(blob:|data:image\/)/i.test(source)) throw new Error("下载地址无效。");
          return source;
        }).then(function (url) {
          var link = global.document.createElement("a");
          link.href = url;
          link.download = String(options && options.filename || "成果").split(/[\\/]/).pop();
          link.rel = "noopener";
          global.document.body.appendChild(link);
          link.click();
          link.remove();
          if (objectUrl) setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 60000);
          chromeApi.runtime.lastError = undefined;
          if (typeof callback === "function") callback(1);
          return 1;
        }).catch(function (error) {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          chromeApi.runtime.lastError = { message: error && error.message || "下载失败。" };
          if (typeof callback === "function") { callback(undefined); return undefined; }
          throw error;
        });
        return promise;
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
      executeScript: function (_options, callback) {
        var error = new Error("网页无法注入其他网站，请使用原采集扩展后导入正式来源快照。");
        chromeApi.runtime.lastError = { message: error.message };
        if (typeof callback === "function") { callback([]); return; }
        return Promise.reject(error);
      }
    }
  };
  chromeApi.storage.local = storageArea(global.localStorage, LOCAL_PREFIX);
  chromeApi.storage.session = storageArea(global.sessionStorage, SESSION_PREFIX);
  global.chrome = chromeApi;

  global.authCheck = function () {
    if (accountBlocked) return Promise.resolve({ ok: false, reason: "account_changed" });
    if (authInFlight) return authInFlight;
    authInFlight = Promise.resolve().then(function () {
      return nativeFetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
    }).then(function (response) {
        if (response.status === 401 || response.status === 403) {
          if (pinnedAccount) blockAccount();
          return { ok: false, reason: "auth_error" };
        }
        // A transport/service failure proves no identity. Fail this operation
        // closed, but allow the next fresh check to recover the pinned account.
        if (!response.ok) return { ok: false, reason: "auth_transient" };
        return response.json().then(function (body) {
          var data = body && body.data;
          if (!data || !data.username || !data.tenantId) return { ok: false, reason: "auth_transient" };
          var id = String(data.tenantId) + ":" + String(data.username);
          if (pinnedAccount && pinnedAccount !== id) { blockAccount(); return { ok: false, reason: "account_changed" }; }
          pinnedAccount = id;
          return { ok: true, creativeEntitlement: data.creativeEntitlement || null, user: { id: id, username: data.username, email: data.username, name: data.name || data.username } };
        });
      })
      .catch(function () {
        return { ok: false, reason: "auth_transient" };
      }).finally(function () { authInFlight = null; });
    return authInFlight;
  };
  if (typeof global.addEventListener === "function") {
    global.addEventListener("focus", function () { global.authCheck(); });
    global.addEventListener("pageshow", function () { global.authCheck(); });
    if (global.document && global.document.addEventListener) global.document.addEventListener("visibilitychange", function () {
      if (!global.document.hidden) global.authCheck();
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
