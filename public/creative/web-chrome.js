/* 网站工作台的浏览器兼容层：让原扩展页面在同源 iframe 里收发消息、按账号保存配置。 */
(function (global) {
  "use strict";

  var LOCAL_PREFIX = "sz.chrome.local.v1:";
  var SESSION_PREFIX = "sz.chrome.session.v1:";
  var PROXY_PATH = "/api/creative/proxy";
  var MAX_PROXY_BYTES = 24 * 1024 * 1024;
  var messageListeners = [];
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

  function profileKey(id) {
    return "user:" + String(id).replace(/[^\w@.+:-]/g, "_").slice(0, 120);
  }

  // Credentials are backed by the authenticated account, independently of the
  // browser cache and release directory. Never log bodies or retry mutations.
  function configProfileRequest(method, body) {
    body = body || {};
    return requireAccount().then(function (id) {
      var owner = profileKey(id);
      if (body.accountKey !== owner) throw new Error("登录账号已变化，配置未修改，请刷新工作台。");
      var controller = new global.AbortController();
      var timer = global.setTimeout(function () { controller.abort(); }, 15000);
      return nativeFetch("/api/creative/config-profiles", {
        method: method, credentials: "same-origin", cache: "no-store",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      }).then(function (response) {
        return response.json().catch(function () { return null; }).then(function (result) {
          if (!response.ok || !result || !result.data || result.data.accountKey !== owner) {
            var conflict = response.status === 409;
            // Only these public protocol codes have actionable meanings. Keep
            // their distinction without reflecting arbitrary response text.
            var safeErrors = {
              CONFIG_CREDENTIAL_SCOPE_CHANGED: "接口地址已变化，请填写对应 API Key；原接口绑定仍保留。",
              ACCOUNT_CHANGED: "登录账号已变化，请重新载入工作台后再操作。",
              CONFIG_BUSY: "账号配置正在保存，请稍后重试。",
              CONFIG_REVISION_CONFLICT: "配置已在其他页面更新，请重新载入后再修改。",
              CONFIG_PROVIDER_INVALID: "请选择有效的模型服务商。",
              CONFIG_ENDPOINT_INVALID: "模型接口必须是公开 HTTPS 地址且不含凭据或查询参数。",
              CONFIG_INVALID: "模型配置格式无效，请核对后再保存。"
            };
            var knownCode = !response.ok && result && Object.prototype.hasOwnProperty.call(safeErrors, result.code) ? result.code : '';
            var errorCode = knownCode || (conflict ? "CONFIG_CONFLICT" : "CONFIG_SERVICE_UNAVAILABLE");
            throw Object.assign(new Error(knownCode ? safeErrors[knownCode] : conflict ? "配置已在其他页面更新，请重新载入后再修改。" : "账号配置结果暂无法确认，请稍后重新载入核对绑定。"), { code: errorCode });
          }
          // A login change during the request must not expose the old owner's
          // hydration to the new session or apply its save result to the form.
          return requireAccount().then(function (current) {
            if (profileKey(current) !== owner) throw new Error("登录账号已变化，请刷新工作台。");
            return result.data;
          });
        });
      }).finally(function () { global.clearTimeout(timer); });
    });
  }

  global.SZ_WEB_ACCOUNT = {
    require: requireAccount,
    storageKey: profileKey,
    configProfileRequest: configProfileRequest,
    supportsConfigProfiles: false,
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

  function screenshotLegacyStorageArea(storage, prefix) {
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


  var SCREENSHOT_STORAGE_INDEX_SCHEMA = "SZ_SCREENSHOT_STORAGE_INDEX_V1";

  function screenshotStorageScope() {
    if (typeof global.authCheck !== "function") return Promise.reject(screenshotStorageError("当前账号无法确认，截图记录未读取或覆盖。"));
    return Promise.resolve().then(function () { return global.authCheck(); }).then(function (auth) {
      if (!auth || !auth.ok || !auth.user || !auth.user.id) throw screenshotStorageError("当前账号身份已失效，截图记录未读取或覆盖。请重新登录后重试。");
      return "environment:" + encodeURIComponent(String(global.__SANJIE_ENVIRONMENT || "default")) + ":account:" + encodeURIComponent(String(auth.user.id)) + ":";
    });
  }

  // Existing credential/profile/session records retain the published storage
  // implementation. Only screenshot indexes opt into authenticated IDB storage.
  function storageArea(storage, prefix) {
    var legacy = screenshotLegacyStorageArea(storage, prefix);
    if (storage !== global.localStorage || prefix !== LOCAL_PREFIX) return legacy;
    function namesOf(keys) {
      if (keys == null) {
        var names = [];
        for (var index = 0; index < storage.length; index++) {
          var key = storage.key(index);
          if (key && key.indexOf(prefix) === 0) names.push(key.slice(prefix.length));
        }
        return names;
      }
      return typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys.slice() : keys && typeof keys === "object" ? Object.keys(keys) : [];
    }
    function indexAt(name) {
      var raw = storage.getItem(prefix + name);
      if (raw === null) return null;
      var value;
      try { value = JSON.parse(raw); }
      catch (_) {
        if (raw.indexOf(SCREENSHOT_STORAGE_INDEX_SCHEMA) >= 0) throw screenshotStorageError("参考截图索引损坏，原数据未覆盖。");
        return null;
      }
      if (!value || value.schema !== SCREENSHOT_STORAGE_INDEX_SCHEMA) return null;
      if (Object.keys(value).length !== 2 || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries)) throw screenshotStorageError("参考截图索引损坏，原数据未覆盖。");
      Object.keys(value.entries).forEach(function (scope) {
        if (!screenshotPointer(value.entries[scope], prefix + "screenshot:" + scope + name)) throw screenshotStorageError("参考截图索引条目损坏，原数据未覆盖。");
      });
      return value;
    }
    function sourceOperation(work, callback, isRead) {
      return Promise.resolve().then(work).then(function (result) {
        chromeApi.runtime.lastError = undefined;
        if (typeof callback === "function") callback(result);
        return result;
      }, function (error) {
        chromeApi.runtime.lastError = { message: error && error.message || "参考详情截图存储失败。" };
        if (typeof callback === "function") { callback(undefined); return; }
        throw error;
      });
    }
    function rollback(written) {
      var failed = false;
      written.slice().reverse().forEach(function (entry) {
        try {
          if (storage.getItem(entry.key) !== entry.raw) return;
          if (entry.oldRaw === null) storage.removeItem(entry.key);
          else storage.setItem(entry.key, entry.oldRaw);
        } catch (_) { failed = true; }
      });
      return failed;
    }
    function get(keys, callback) {
      var names, indexes;
      try {
        names = namesOf(keys);
        indexes = names.filter(function (name) { return !!indexAt(name); });
      } catch (error) { return sourceOperation(function () { throw error; }, callback, true); }
      if (!indexes.length) return legacy.get(keys, callback);
      return sourceOperation(function () {
        return screenshotStorageScope().then(function (scope) {
          var requested = [];
          return legacy.get(keys).then(function (result) {
            indexes.forEach(function (name) {
              var index = indexAt(name);
              if (!index) throw screenshotStorageError("参考截图记录已在其他工作台变更，请重新载入。");
              delete result[name];
              var pointer = index.entries[scope];
              if (pointer) requested.push({ name: name, pointer: screenshotPointer(pointer, prefix + "screenshot:" + scope + name) });
              else if (keys && typeof keys === "object" && !Array.isArray(keys) && Object.prototype.hasOwnProperty.call(keys, name)) result[name] = keys[name];
            });
            if (!requested.length) return result;
            return screenshotDatabaseTransaction("readonly", function (store) {
              var records = {};
              requested.forEach(function (item) { var request = store.get(item.pointer.recordId); request.onsuccess = function () { records[item.name] = request.result; }; });
              return records;
            }).then(function (records) {
              return screenshotStorageScope().then(function (currentScope) {
                if (currentScope !== scope) throw screenshotStorageError("登录账号已变更，本次截图记录未返回。");
                requested.forEach(function (item) {
                  var record = records[item.name];
                  if (!record || record.schema !== SCREENSHOT_STORAGE_RECORD_SCHEMA || record.storageKey !== item.pointer.storageKey || !Object.prototype.hasOwnProperty.call(record, "value")) throw screenshotStorageError("参考详情截图存储内容缺失或账号不匹配，原索引未覆盖。");
                  result[item.name] = record.value;
                });
                return result;
              });
            });
          });
        });
      }, callback, true);
    }
    function set(items, callback) {
      var names = Object.keys(items || {}), affected;
      try { affected = names.filter(function (name) { return containsScreenshotSource(items[name]) || !!indexAt(name); }); }
      catch (error) { return sourceOperation(function () { throw error; }, callback); }
      if (!affected.length) return legacy.set(items, callback);
      return sourceOperation(function () {
        return screenshotStorageScope().then(function (scope) {
          return screenshotStorageLock(prefix + "screenshot-indexes", function () {
            var entries = names.map(function (name) {
              var key = prefix + name, oldRaw = storage.getItem(key), index = indexAt(name);
              if (affected.indexOf(name) < 0) return { key: key, oldRaw: oldRaw, raw: JSON.stringify(items[name]), recordId: "" };
              var storageKey = prefix + "screenshot:" + scope + name;
              var recordId = "screenshot-record-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2);
              var oldPointer = index && index.entries[scope] || null;
              var next = { schema: SCREENSHOT_STORAGE_INDEX_SCHEMA, entries: Object.assign({}, index && index.entries || {}) };
              next.entries[scope] = { schema: SCREENSHOT_STORAGE_POINTER_SCHEMA, storageKey: storageKey, recordId: recordId };
              return { key: key, oldRaw: oldRaw, raw: JSON.stringify(next), recordId: recordId, storageKey: storageKey, value: items[name], oldPointer: oldPointer };
            });
            var records = entries.filter(function (entry) { return !!entry.recordId; });
            return screenshotDatabaseTransaction("readwrite", function (store) {
              records.forEach(function (entry) { store.put({ schema: SCREENSHOT_STORAGE_RECORD_SCHEMA, storageKey: entry.storageKey, value: entry.value }, entry.recordId); });
            }).then(function () {
              return screenshotStorageScope().then(function (currentScope) {
                var written = [];
                try {
                  if (currentScope !== scope) throw screenshotStorageError("登录账号已变更，本次截图保存未覆盖原记录。");
                  if (entries.some(function (entry) { return storage.getItem(entry.key) !== entry.oldRaw; })) throw screenshotStorageError("参考截图记录已在其他工作台变更，本次保存未覆盖新值。");
                  entries.forEach(function (entry) { if (storage.getItem(entry.key) !== entry.oldRaw) throw screenshotStorageError("参考截图记录已在其他工作台变更，本次保存已停止。"); storage.setItem(entry.key, entry.raw); written.push(entry); });
                } catch (error) {
                  var failed = rollback(written);
                  var unused = records.filter(function (entry) { return storage.getItem(entry.key) !== entry.raw; }).map(function (entry) { return entry.recordId; });
                  return deleteScreenshotRecords(unused).catch(function () {}).then(function () { if (failed) throw screenshotStorageError("截图保存失败，部分旧索引未能恢复；已有有效内容已保留，请重新载入核对。"); throw error; });
                }
                return deleteScreenshotRecords(records.filter(function (entry) { return !!entry.oldPointer; }).map(function (entry) { return entry.oldPointer.recordId; })).catch(function () {});
              }, function (error) { return deleteScreenshotRecords(records.map(function (entry) { return entry.recordId; })).catch(function () {}).then(function () { throw error; }); });
            });
          });
        });
      }, callback);
    }
    function remove(keys, callback, clearing) {
      var names = Array.from(new Set(namesOf(keys))), indexes;
      try { indexes = names.filter(function (name) { return !!indexAt(name); }); }
      catch (error) { return sourceOperation(function () { throw error; }, callback); }
      if (!indexes.length) return clearing ? legacy.clear(callback) : legacy.remove(keys, callback);
      return sourceOperation(function () {
        return screenshotStorageScope().then(function (scope) {
          return screenshotStorageLock(prefix + "screenshot-indexes", function () {
            return screenshotStorageScope().then(function (currentScope) {
              if (currentScope !== scope) throw screenshotStorageError("登录账号已变更，本次截图删除已停止。");
              var entries = names.map(function (name) {
                var key = prefix + name, oldRaw = storage.getItem(key), index = indexAt(name);
                if (!index) return { key: key, oldRaw: oldRaw, raw: null };
                var ownPointer = index.entries[scope] || null;
                var next = { schema: SCREENSHOT_STORAGE_INDEX_SCHEMA, entries: Object.assign({}, index.entries) };
                delete next.entries[scope];
                return { key: key, oldRaw: oldRaw, raw: Object.keys(next.entries).length ? JSON.stringify(next) : null, pointer: ownPointer };
            });
            var written = [];
            try {
              entries.forEach(function (entry) {
                if (storage.getItem(entry.key) !== entry.oldRaw) throw screenshotStorageError("存储记录已在其他工作台变更，本次删除已停止。");
                if (entry.raw === null) storage.removeItem(entry.key); else storage.setItem(entry.key, entry.raw);
                written.push(entry);
              });
            } catch (error) { rollback(written); throw error; }
            // Index deletion is final. Never restore a pointer after an unknown
            // cleanup commit; unreachable old values are safe to retain.
            return deleteScreenshotRecords(entries.filter(function (entry) { return !!entry.pointer; }).map(function (entry) { return entry.pointer.recordId; })).catch(function () {});
            });
          });
        });
      }, callback);
    }
    return { get: get, set: set, remove: remove, clear: function (callback) { return remove(null, callback, true); } };
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

  function platformSupplyUrl(url) {
    try {
      var parsed = new URL(url, global.location.href);
      return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "sub.shaozhuangai.com" &&
        (!parsed.port || parsed.port === "443") && !parsed.username && !parsed.password;
    } catch (_) { return false; }
  }

  function ownGatewayUrl(url) {
    try {
      var parsed = new URL(url, global.location.href);
      return parsed.origin === global.location.origin && !parsed.username && !parsed.password &&
        /^\/(?:api\/)?v1\/(chat\/completions|images\/(generations|edits)|videos)\/?$/.test(parsed.pathname);
    } catch (_) { return false; }
  }

  function usesServerCredentials(url) {
    if (!platformSupplyUrl(url)) return false;
    var path = new URL(url, global.location.href).pathname.replace(/\/+$/, "");
    return path === "/v1" || /^\/v1\/(chat\/completions|images\/(generations|edits)|models|videos(?:\/[^/]+(?:\/content)?)?)$/.test(path);
  }

  function newSupplyRequestKey() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") return global.crypto.randomUUID();
    if (!global.crypto || typeof global.crypto.getRandomValues !== "function") throw new Error("浏览器无法创建安全的请求标识，请刷新后重试。");
    var bytes = global.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    var hex = Array.from(bytes, function (value) { return value.toString(16).padStart(2, "0"); }).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }

  function supplyHeaders(url, method, headers) {
    headers = Object.assign({}, headers);
    if (!platformSupplyUrl(url) && !ownGatewayUrl(url)) return headers;
    if (platformSupplyUrl(url)) Object.keys(headers).forEach(function (key) {
      if (key.toLowerCase() === "proxy-authorization") delete headers[key];
    });
    if (String(method || "GET").toUpperCase() === "POST") {
      var existing = Object.keys(headers).find(function (key) { return key.toLowerCase() === "idempotency-key"; });
      if (!existing) headers["idempotency-key"] = newSupplyRequestKey();
    }
    return headers;
  }

  function usesPlatformWallet(config, kind) {
    if (!config || config.provider !== "openai-compatible") return false;
    if (config._supplyChannel === "external_key") return false;
    if (String(config.apiKey || "").trim()) return false;
    var endpoint = kind === "image" ? config.imageEndpoint : kind === "chat" ? config.visionBaseUrl : "";
    if (typeof endpoint !== "string" || !endpoint.trim()) return false;
    try {
      var url = new URL(endpoint);
      if (url.protocol !== "https:" || url.hostname !== "sub.shaozhuangai.com" ||
          url.username || url.password || url.port || url.search || url.hash) return false;
      return kind === "image" ? /^\/v1\/images\/(?:generations|edits)\/?$/.test(url.pathname) : /^\/v1\/?$/.test(url.pathname);
    } catch (_) { return false; }
  }


  global.SZ_WEB_SUPPLY = Object.freeze({ usesServerCredentials: usesServerCredentials, usesPlatformWallet: usesPlatformWallet, showCreditPurchasePrompt: showPurchasePrompt });

  function notifySupplyBalanceChanged() {
    try {
      global.dispatchEvent(new global.Event("sanjie:credits-changed"));
      if (global.parent && global.parent !== global) global.parent.dispatchEvent(new global.parent.Event("sanjie:credits-changed"));
    } catch (_) { /* A separately hosted parent cannot receive a same-origin refresh. */ }
  }

  function showPurchasePrompt() {
    if (!global.document || global.document.getElementById("sz-credit-purchase-prompt")) return;
    var previous = global.document.activeElement;
    var dialog = global.document.createElement("dialog");
    dialog.id = "sz-credit-purchase-prompt";
    dialog.setAttribute("aria-labelledby", "sz-credit-purchase-title");
    dialog.style.cssText = "max-width:420px;width:calc(100% - 48px);border:1px solid #655628;border-radius:18px;background:#101b0c;color:#f7edd6;padding:28px;box-shadow:0 20px 70px #0008";
    var title = global.document.createElement("h2");
    title.id = "sz-credit-purchase-title"; title.textContent = "可用积分不足";
    title.style.cssText = "margin:0 0 12px;font-size:21px";
    var description = global.document.createElement("p");
    description.textContent = "请购买套餐后继续创作。当前素材和方案已保留。";
    description.style.cssText = "line-height:1.7;margin:0 0 24px";
    var purchase = global.document.createElement("a");
    purchase.href = "/models"; purchase.target = "_top"; purchase.textContent = "购买套餐";
    purchase.style.cssText = "display:inline-block;background:#f7ca67;color:#18200d;border-radius:9px;padding:10px 18px;text-decoration:none;font-weight:700";
    var close = global.document.createElement("button");
    close.type = "button"; close.textContent = "暂时返回";
    close.style.cssText = "margin-left:14px;background:transparent;border:1px solid #655628;color:inherit;border-radius:9px;padding:10px 18px;cursor:pointer";
    close.onclick = function () { dialog.close(); };
    dialog.addEventListener("close", function () { dialog.remove(); if (previous && previous.isConnected) previous.focus(); });
    dialog.append(title, description, purchase, close);
    global.document.body.appendChild(dialog); dialog.showModal(); close.focus();
  }

  var billingSignals = new WeakMap();
  function registerBillingRequest(signal, reference) {
    if (!signal || typeof signal !== "object") return;
    var references = billingSignals.get(signal) || [];
    if (!references.some(function (item) { return item.idempotencyKey === reference.idempotencyKey; })) references.push(reference);
    billingSignals.set(signal, references);
  }
  function notifyBillingChanged() {
    try { global.dispatchEvent(new global.Event("sanjie:credits-changed")); } catch (_) {}
    try { if (global.parent && global.parent !== global) global.parent.dispatchEvent(new global.parent.Event("sanjie:credits-changed")); } catch (_) {}
  }
  global.SZCreativeBilling = Object.freeze({
    registerRequest: registerBillingRequest,
    // Called only by explicit cancel actions. Deadline and transport aborts do not cancel billing.
    cancelSignal: function (signal) {
      return Promise.all((billingSignals.get(signal) || []).map(function (reference) {
        return nativeFetch("/api/creative/billing/cancel", { method: "POST", credentials: "same-origin", cache: "no-store",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(reference) }).then(function (response) {
          if (!response.ok) throw new Error("取消记录未确认，请重试；已扣积分保留。");
          notifyBillingChanged(); return response.json();
        });
      }));
    }
  });

  function showSubmissionQuote(quote, endpoint) {
    if (!global.document || !global.document.body || typeof global.document.body.insertBefore !== "function") return;
    var node = global.document.getElementById && global.document.getElementById("sz-submission-quote");
    if (!node) {
      node = global.document.createElement("div"); node.id = "sz-submission-quote";
      node.setAttribute("role", "status"); node.setAttribute("aria-live", "polite");
      node.style.cssText = "padding:8px 12px;background:#eef6ff;color:#143862;font-size:12px;line-height:1.5;border-bottom:1px solid #c4d9ef;";
      global.document.body.insertBefore(node, global.document.body.firstChild);
    }
    node.textContent = "本次" + (endpoint === "chat.completions" ? "文本/分析" : endpoint === "videos" ? "视频生成" : "图片生成") + "报价 " + String(quote.quoteCents / 10) + " 积分 · 提交时扣，失败退回，取消不退";
  }

  function createCreativeRequestPacer() {
    var startWall = Date.now(), startMono = global.performance && global.performance.now();
    var environment = new URL(global.location.href).searchParams.get('env') || '';
    var queuedWrites = Object.create(null), cancelledWrites = Object.create(null);
    function failure(code) { var error = new Error('原任务已保留，请稍后核对。'); error.code = code; return error; }
    function clock() {
      var now = Date.now(), mono = global.performance && global.performance.now();
      if (!Number.isFinite(startMono) || !Number.isFinite(mono) || Math.abs(now - startWall - (mono - startMono)) > 1000) throw failure('CREATIVE_QUEUE_CLOCK_CHANGED');
      return now;
    }
    function identity(value) {
      var fields = ['version','receiptId','jobId','accountKey','workspaceKey','taskId','shotId','batchId','planSignatureHash'];
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || value.version !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.receiptId || '') || !/^[a-f0-9]{64}$/.test(value.planSignatureHash || '') || fields.slice(2).some(function (key) { return typeof value[key] !== 'string' || key !== 'batchId' && !value[key] || value[key].length > 256; })) throw failure('CREATIVE_QUEUE_IDENTITY_INVALID');
      return value.accountKey;
    }
    function scope(owner) { return 'sz-creative-request-pace:v1:' + environment + ':' + owner; }
    function check(signal, deadline) {
      if (!global.navigator || !global.navigator.locks || typeof global.navigator.locks.request !== 'function' || !global.localStorage) throw failure('CREATIVE_QUEUE_UNAVAILABLE');
      if (signal && signal.aborted) throw failure('CREATIVE_QUEUE_CANCELLED');
      if (clock() >= deadline) throw failure('CREATIVE_QUEUE_TIMEOUT');
    }
    function sleep(ms, signal, deadline) {
      check(signal,deadline);
      return new Promise(function (resolve,reject) {
        var timer, ended = false;
        function finish(error) { if (ended) return; ended = true; global.clearTimeout(timer); if (signal) signal.removeEventListener('abort',aborted); error ? reject(error) : resolve(); }
        function aborted() { finish(failure('CREATIVE_QUEUE_CANCELLED')); }
        if (signal) signal.addEventListener('abort',aborted,{once:true});
        timer = global.setTimeout(function () { try { check(signal,deadline); finish(); } catch (error) { finish(error); } },Math.min(Math.max(ms,1),1000,Math.max(1,deadline-clock())));
        if (signal && signal.aborted) aborted();
      });
    }
    function lock(name, signal, fn, deadline) {
      var controller = new global.AbortController(),timer,entered = false;
      function aborted() { controller.abort(); }
      if (signal) signal.addEventListener('abort',aborted,{once:true});
      if (signal && signal.aborted) controller.abort();
      if (deadline) timer = global.setTimeout(aborted,Math.max(1,deadline-clock()));
      return global.navigator.locks.request(name,{signal:controller.signal},function (held) {
        entered = true;global.clearTimeout(timer);if (signal) signal.removeEventListener('abort',aborted);
        check(signal,deadline || clock()+180000);return fn(held);
      }).finally(function () { global.clearTimeout(timer);if (!entered && signal) signal.removeEventListener('abort',aborted); });
    }
    function load(owner,kind) {
      var now = clock(),raw = global.localStorage.getItem(scope(owner)+':'+kind),value;
      try { value = raw === null ? null : JSON.parse(raw); } catch (_) { throw failure('CREATIVE_QUEUE_STORAGE_INVALID'); }
      if (value === null) return {version:1,nextAt:now,blockedUntil:now,updatedAt:now};
      if (!value || Object.keys(value).length !== 4 || value.version !== 1 || ['nextAt','blockedUntil','updatedAt'].some(function (key) { return !Number.isSafeInteger(value[key]) || value[key] < 0; }) || value.updatedAt > now + 1000 || value.nextAt > value.updatedAt + 1000 || value.blockedUntil > value.updatedAt + 180000) throw failure('CREATIVE_QUEUE_STORAGE_INVALID');
      return value;
    }
    async function token(owner,kind,signal,deadline) {
      check(signal,deadline);
      return lock(scope(owner)+':'+kind+':admission',signal,async function () {
        for (;;) {
          check(signal,deadline);var value = load(owner,kind),now = clock(),wait = Math.max(value.nextAt,value.blockedUntil)-now;
          if (wait > 0) { await sleep(wait,signal,deadline);continue; }
          value.nextAt = now + (kind === 'read' ? 500 : 750);value.updatedAt = now;
          global.localStorage.setItem(scope(owner)+':'+kind,JSON.stringify(value));return;
        }
      },deadline);
    }
    function retryDelay(header) {
      var now = clock(),seconds = typeof header === 'string' && /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) : NaN;
      var ms = Number.isFinite(seconds) ? Math.ceil(seconds*1000) : typeof header === 'string' && Number.isFinite(Date.parse(header)) ? Date.parse(header)-now : 1000;
      return {ms:Math.min(180000,Math.max(1000,ms)),retry:ms <= 60000};
    }
    async function cooldown(owner,kind,header,signal,deadline) {
      var delay = retryDelay(header);
      await lock(scope(owner)+':'+kind+':admission',signal,function () {
        check(signal,deadline);var value = load(owner,kind),now = clock();
        value.blockedUntil = Math.max(value.blockedUntil,now+delay.ms);value.updatedAt = now;
        global.localStorage.setItem(scope(owner)+':'+kind,JSON.stringify(value));
      },deadline);return delay.retry;
    }
    function bounded(fn,signal) {
      return new Promise(function (resolve,reject) {
        var controller = new global.AbortController(),ended = false,timer;
        function finish(error,value) { if (ended) return;ended = true;global.clearTimeout(timer);if (signal) signal.removeEventListener('abort',aborted);if (error) { controller.abort();reject(error); } else resolve(value); }
        function aborted() { finish(failure('CREATIVE_QUEUE_CANCELLED')); }
        if (signal) signal.addEventListener('abort',aborted,{once:true});
        timer = global.setTimeout(function () { finish(failure('CREATIVE_QUEUE_AUTH_OR_QUOTE_TIMEOUT')); },15000);
        if (signal && signal.aborted) { aborted();return; }
        Promise.resolve().then(function () { if (ended) return;return fn(controller.signal); }).then(function (value) { if (!ended) finish(null,value); },function (error) { finish(error); });
      });
    }
    async function sameOwner(owner,signal,deadline) {
      check(signal,deadline);
      var data = await bounded(async function (boundedSignal) {
        var response = await nativeFetch('/api/auth/me',{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:boundedSignal});
        if (!response.ok) throw failure('CREATIVE_QUEUE_ACCOUNT_UNAVAILABLE');return response.json();
      },signal),user = data && data.data;
      check(signal,deadline);
      if (!user || typeof user.tenantId !== 'string' || !user.tenantId || typeof user.username !== 'string' || !user.username || 'user:'+(user.tenantId+':'+user.username).replace(/[^\w@.+:-]/g,'_').slice(0,120) !== owner) throw failure('CREATIVE_QUEUE_ACCOUNT_CHANGED');
    }
    async function read(value,fn,signal) {
      var owner = identity(value),deadline = clock()+180000;
      check(signal,deadline);
      var admitted = await lock(scope(owner)+':read-slots-admission',signal,function () {
        check(signal,deadline);
        var key = scope(owner)+':read-cursor',raw = global.localStorage.getItem(key),cursor;
        try { cursor = raw === null ? {version:1,next:0} : JSON.parse(raw); } catch (_) { throw failure('CREATIVE_QUEUE_STORAGE_INVALID'); }
        if (!cursor || Object.keys(cursor).length !== 2 || cursor.version !== 1 || !Number.isInteger(cursor.next) || cursor.next < 0 || cursor.next >= 6) throw failure('CREATIVE_QUEUE_STORAGE_INVALID');
        var index = cursor.next;cursor.next = (index+1)%6;
        global.localStorage.setItem(key,JSON.stringify(cursor));
        var reply = lock(scope(owner)+':read-slot:'+index,signal,async function () {
          for (var attempt=0;attempt<3;attempt++) {
            await token(owner,'read',signal,deadline);await sameOwner(owner,signal,deadline);
            var result = await fn();await sameOwner(owner,signal,clock()+15000);
            if (!result || result.status !== 429) return result;
            if (!await cooldown(owner,'read',result.retryAfter,signal,deadline) || attempt === 2) return result;
          }
        },deadline);
        reply.catch(function () {});return {reply:reply};
      },deadline);
      return admitted.reply;
    }
    function cancelQueued(value) {
      try {
        identity(value);var key = identityKey(value),entry = queuedWrites[value.receiptId];
        if (entry) { if (entry.key !== key || entry.submitted) return false;entry.controller.abort();return true; }
        var saved=readClaim(value.accountKey,value);if(saved && saved.submitted)return false;
        cancelledWrites[value.receiptId] = key;return true;
      } catch (_) { return false; }
    }
    function identityKey(value) {
      identity(value);
      return JSON.stringify(Object.fromEntries(['version','receiptId','jobId','accountKey','workspaceKey','taskId','shotId','batchId','planSignatureHash'].map(function (field) { return [field,value[field]]; })));
    }
    function originalUncertain(code) { var error=failure(code);error.preserveOriginal=true;return error; }
    function readClaim(owner,value) {
      var raw;
      try { raw=global.localStorage.getItem(scope(owner)+':write-receipt:'+value.receiptId); }
      catch (_) { throw originalUncertain('CREATIVE_QUEUE_STORAGE_INVALID'); }
      if (raw===null) return null;
      var saved;
      try { saved=JSON.parse(raw); }
      catch (_) { throw originalUncertain('CREATIVE_QUEUE_STORAGE_INVALID'); }
      if (!saved || Object.keys(saved).length!==3 || saved.version!==1 || typeof saved.submitted!=='boolean') throw originalUncertain('CREATIVE_QUEUE_STORAGE_INVALID');
      try { if (identityKey(saved.identity)!==identityKey(value)) throw originalUncertain('CREATIVE_QUEUE_IDENTITY_INVALID'); }
      catch (_) { throw originalUncertain('CREATIVE_QUEUE_IDENTITY_INVALID'); }
      return saved;
    }
    async function preparationWait(owner,name,signal,fn) {
      // A progressing FIFO can span several minutes. An inert preparation gate
      // still expires after 180s; the admitted phase retains its own 180s bound.
      var queuedAt=clock(),controller=new global.AbortController(),timer,entered=false,queueError;
      function aborted() { controller.abort(); }
      if (signal) signal.addEventListener('abort',aborted,{once:true});
      function watch() {
        if (entered) return;
        try {
          check(signal,Number.MAX_SAFE_INTEGER);
          var raw=global.localStorage.getItem(scope(owner)+':write');
          var progress=raw===null?queuedAt:load(owner,'write').updatedAt;
          var deadline=Math.max(queuedAt,progress)+180000,now=clock();check(signal,deadline);
          timer=global.setTimeout(watch,Math.min(1000,Math.max(1,deadline-now)));
        } catch (error) { queueError=error;controller.abort(); }
      }
      watch();
      try {
        return await lock(name,controller.signal,function () {
          entered=true;global.clearTimeout(timer);var deadline=clock()+180000;check(signal,deadline);return fn(deadline);
        });
      } catch (error) { throw queueError || error; }
      finally { global.clearTimeout(timer);if (signal) signal.removeEventListener('abort',aborted); }
    }
    async function preparation(owner,signal,fn) {
      var assigned=await lock(scope(owner)+':write-preparation-admission',signal,function () {
        check(signal,clock()+180000);
        var key=scope(owner)+':write-preparation-cursor',raw=global.localStorage.getItem(key),cursor;
        try { cursor=raw===null?{version:1,next:0}:JSON.parse(raw); } catch (_) { throw failure('CREATIVE_QUEUE_STORAGE_INVALID'); }
        if (!cursor || Object.keys(cursor).length!==2 || cursor.version!==1 || !Number.isInteger(cursor.next) || cursor.next<0 || cursor.next>=6) throw failure('CREATIVE_QUEUE_STORAGE_INVALID');
        var index=cursor.next;cursor.next=(index+1)%6;global.localStorage.setItem(key,JSON.stringify(cursor));return index;
      },clock()+180000);
      return preparationWait(owner,scope(owner)+':write-preparation:'+assigned,signal,fn);
    }
    async function dispatchWrite(owner,signal,deadline,request) {
      // This short gate covers live ownership and the actual HTTP invocation.
      // Neither quote body nor provider response is awaited while it is held.
      return lock(scope(owner)+':write-jobs',signal,async function () {
        return lock(scope(owner)+':write:admission',signal,async function () {
          for (;;) {
            check(signal,deadline);var value=load(owner,'write'),now=clock(),wait=Math.max(value.nextAt,value.blockedUntil)-now;
            if (wait>0) { await sleep(wait,signal,deadline);continue; }
            await sameOwner(owner,signal,deadline);check(signal,deadline);
            now=clock();value.nextAt=now+750;value.updatedAt=now;global.localStorage.setItem(scope(owner)+':write',JSON.stringify(value));
            var reply;try { reply=Promise.resolve(request()); } catch (error) { reply=Promise.reject(error); }
            reply.catch(function () {});return {reply:reply};
          }
        },deadline);
      },deadline);
    }
    async function writeJob(value,externalSignal,fn) {
      var owner=identity(value),key=identityKey(value),captured=JSON.parse(key),entry={key:key,controller:new global.AbortController(),submitted:false};
      if (cancelledWrites[value.receiptId]) { var cancelled=cancelledWrites[value.receiptId];delete cancelledWrites[value.receiptId];if(cancelled===key)throw failure('CREATIVE_QUEUE_CANCELLED'); }
      if (queuedWrites[value.receiptId]) throw originalUncertain('CREATIVE_QUEUE_ALREADY_QUEUED');
      queuedWrites[value.receiptId]=entry;
      function abortQueue() { entry.controller.abort(); }
      if (externalSignal) externalSignal.addEventListener('abort',abortQueue,{once:true});
      if (externalSignal && externalSignal.aborted) abortQueue();
      var signal=entry.controller.signal;
      function checkIdentity(deadline) { check(signal,deadline);if(identityKey(value)!==key)throw failure('CREATIVE_QUEUE_IDENTITY_INVALID'); }
      try {
        checkIdentity(clock()+180000);
        var result=await global.navigator.locks.request(scope(owner)+':write-receipt:'+captured.receiptId,{ifAvailable:true},async function (held) {
          if(!held)throw originalUncertain('CREATIVE_QUEUE_ALREADY_QUEUED');
          checkIdentity(clock()+180000);
          if(readClaim(owner,captured))throw originalUncertain('CREATIVE_QUEUE_ORIGINAL_ALREADY_CLAIMED');
          global.localStorage.setItem(scope(owner)+':write-receipt:'+captured.receiptId,JSON.stringify({version:1,identity:captured,submitted:false}));
          return preparation(owner,signal,async function (deadline) {
            var phase='new';checkIdentity(deadline);
            return fn({
              step:async function (request) {
                checkIdentity(deadline);if(phase!=='new')throw failure('CREATIVE_QUEUE_PHASE_INVALID');phase='quoting';
                var started=await dispatchWrite(owner,signal,deadline,function () {checkIdentity(deadline);return bounded(request,signal);});
                var quoted=await started.reply;await sameOwner(owner,signal,deadline);checkIdentity(deadline);phase='quoted';return quoted;
              },
              submit:async function (request) {
                checkIdentity(deadline);if(phase!=='new' && phase!=='quoted' || entry.submitted)throw originalUncertain('CREATIVE_QUEUE_PHASE_INVALID');phase='submitting';
                var started=await dispatchWrite(owner,signal,deadline,function () {
                  checkIdentity(deadline);var saved=readClaim(owner,captured);
                  if(!saved || saved.submitted)throw originalUncertain('CREATIVE_QUEUE_ORIGINAL_ALREADY_CLAIMED');
                  global.localStorage.setItem(scope(owner)+':write-receipt:'+captured.receiptId,JSON.stringify({version:1,identity:captured,submitted:true}));
                  entry.submitted=true;phase='submitted';return request();
                });return started;
              },
              cooldown:async function (response) { if(response && response.status===429)await cooldown(owner,'write',response.headers && response.headers.get('Retry-After'),signal,deadline); }
            });
          });
        });
        return await (result && result.reply ? result.reply : result);
      } finally { if(externalSignal)externalSignal.removeEventListener('abort',abortQueue);if(queuedWrites[captured.receiptId]===entry)delete queuedWrites[captured.receiptId]; }
    }
    return Object.freeze({version:1,read:read,writeJob:writeJob,cancelQueued:cancelQueued});
  }
  var creativeRequestPacer = createCreativeRequestPacer();
  global.SZCreativeRequestPacer = creativeRequestPacer;

  function pacedImageProxy(url,init,encoded,headers,expectedAccount,endpoint,walletGeneration,receiptIdentity) {
    var providerDispatched = false;
    function notSubmitted(status) {
      status = [400,401,402,403,404,413,429,502,503].indexOf(status) >= 0 ? status : 503;
      var response = Response.json({code:'CREATIVE_REQUEST_NOT_SUBMITTED',providerSubmitted:false,definitiveFailure:true,stateUncertain:false,error:'本次未提交生图，请核对账号或稍后重试。'},
        {status:status,headers:{'X-Sanjie-Provider-Submission':'not-submitted','Cache-Control':'no-store'}});
      response.szCreativeProxyNotSubmitted = true;return response;
    }
    return creativeRequestPacer.writeJob(receiptIdentity,init.signal,async function (ticket) {
      var quotedCents;
      if (walletGeneration) {
        var quoteBody = encoded.kind === 'form' ? Object.fromEntries(Array.from(encoded.form.entries()).filter(function (entry) { return typeof entry[1] === 'string'; })) : encoded.kind === 'text' ? JSON.parse(encoded.text) : encoded.kind === 'base64' ? JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded.base64),function (char) { return char.charCodeAt(0); }))) : null;
        if (!quoteBody || typeof quoteBody.model !== 'string') return {reply:Promise.resolve(notSubmitted(400))};
        if (encoded.kind === 'form' && quoteBody.n !== undefined) quoteBody.n = Number(quoteBody.n);
        var priced = await ticket.step(async function (signal) {
          var response = await nativeFetch('/api/creative/billing/quote',{method:'POST',credentials:'same-origin',cache:'no-store',signal:signal,
            headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:endpoint,model:quoteBody.model,body:quoteBody,expectedAccount:expectedAccount || undefined})});
          return response.ok ? {quote:await response.json()} : {response:response};
        });
        if (priced.response) {
          await ticket.cooldown(priced.response);
          if (priced.response.status === 402) showPurchasePrompt();
          return {reply:Promise.resolve(notSubmitted(priced.response.status))};
        }
        var quote = priced.quote;
        if (!quote || quote.billingMode !== 'prepaid_quote' || !Number.isSafeInteger(quote.quoteCents) || quote.quoteCents <= 0) return {reply:Promise.resolve(notSubmitted(503))};
        quotedCents = quote.quoteCents;showSubmissionQuote(quote,endpoint);
      }
      var payloadBytes = encoded.kind === 'text' ? encoded.text.length : encoded.kind === 'base64' ? encoded.base64.length : 0;
      if (payloadBytes > MAX_PROXY_BYTES) return {reply:Promise.resolve(notSubmitted(413))};
      return ticket.submit(function () {
        // No queue time is charged to the model/header deadline. This callback
        // runs only once at the real, original generation proxy dispatch.
        if (typeof init.szOnProxyDispatch === 'function') { try { init.szOnProxyDispatch(); } catch (_) {} }
        providerDispatched = true;
        var request;
        if (encoded.kind === 'form') {
          var form = new FormData();form.set('__sz_url',url);form.set('__sz_method',String(init.method || 'POST'));form.set('__sz_headers',JSON.stringify(headers));
          encoded.form.forEach(function (value,key) { form.append(key,value); });
          form.set('__sz_image_receipt',JSON.stringify(receiptIdentity));
          if (expectedAccount) form.set('__sz_expected_account',expectedAccount);
          if (quotedCents !== undefined) form.set('__sz_quote_cents',String(quotedCents));
          request = nativeFetch(PROXY_PATH,{method:'POST',body:form,credentials:'same-origin',cache:'no-store',signal:init.signal});
        } else request = nativeFetch(PROXY_PATH,{method:'POST',credentials:'same-origin',cache:'no-store',signal:init.signal,headers:{'Content-Type':'application/json'},
          body:JSON.stringify({url:url,receiptIdentity:receiptIdentity,expectedAccount:expectedAccount || undefined,expectedQuoteCents:quotedCents,method:String(init.method || 'GET'),headers:headers,
            bodyText:encoded.kind === 'text' ? encoded.text : '',bodyBase64:encoded.kind === 'base64' ? encoded.base64 : '',contentType:encoded.contentType || headers['Content-Type'] || headers['content-type'] || ''})});
        return Promise.resolve(request).then(async function (response) { try { await ticket.cooldown(response); } catch (_) {}return response; });
      });
    }).catch(function (error) {
      // This proof owns only the branch that never invoked the proxy POST.
      // Once invoked, preserve the original unknown transport outcome.
      if (providerDispatched || error && error.preserveOriginal === true) throw error;
      return notSubmitted(503);
    });
  }

  function proxyFetch(url, init) {
    init = init || {};
    var headers = supplyHeaders(url, init.method, headerObject(init.headers));
    var expectedAccount = (platformSupplyUrl(url) || init.szImageReceipt) && typeof init.szExpectedAccount === "string" ? init.szExpectedAccount : "";
    var endpoint = platformSupplyUrl(url) ? new URL(url).pathname.replace(/^\/v1\//, "").replace(/\/+$/, "").replace("chat/completions", "chat.completions").replace("images/generations", "images.generations").replace("images/edits", "images.edits") : "";
    var walletGeneration = String(init.method || "GET").toUpperCase() === "POST" && ["chat.completions", "images.generations", "images.edits", "videos"].indexOf(endpoint) >= 0 && !Object.keys(headers).some(function (key) { return key.toLowerCase() === "authorization" && String(headers[key]).trim(); });
    // The runtime already froze this site-only identity before dispatch.
    // It is an envelope field, never a supplier header or multipart image field.
    var imageUrl;
    try { imageUrl = new URL(url); } catch (_) {}
    var imageGeneration = String(init.method || "GET").toUpperCase() === "POST" && imageUrl && imageUrl.protocol === "https:" && !imageUrl.username && !imageUrl.password && !imageUrl.search && !imageUrl.hash && /^\/v1\/images\/(generations|edits)\/?$/.test(imageUrl.pathname);
    var receiptIdentity = imageGeneration ? init.szImageReceipt : undefined;
    var keyName = Object.keys(headers).find(function (key) { return key.toLowerCase() === "idempotency-key"; });
    if (walletGeneration && keyName) registerBillingRequest(init.szBillingSignal || init.signal, { idempotencyKey: headers[keyName], expectedAccount: expectedAccount || undefined });
    return encodeBody(init.body).then(async function (encoded) {
      if (receiptIdentity) { if (typeof init.szOnProxyQueue === 'function') { try { init.szOnProxyQueue(); } catch (_) {} }return pacedImageProxy(url,init,encoded,headers,expectedAccount,endpoint,walletGeneration,receiptIdentity); }
      var quotedCents;
      if (walletGeneration) {
        var quoteBody = encoded.kind === "form" ? Object.fromEntries(Array.from(encoded.form.entries()).filter(function (entry) { return typeof entry[1] === "string"; })) : encoded.kind === "text" ? JSON.parse(encoded.text) : encoded.kind === "base64" ? JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded.base64), function (char) { return char.charCodeAt(0); }))) : null;
        if (!quoteBody || typeof quoteBody.model !== "string") throw new Error("平台生成参数无法报价，本次未提交。");
        if (encoded.kind === "form" && quoteBody.n !== undefined) quoteBody.n = Number(quoteBody.n);
        var quoteResponse = await nativeFetch("/api/creative/billing/quote", { method: "POST", credentials: "same-origin", cache: "no-store", signal: init.signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: endpoint, model: quoteBody.model, body: quoteBody, expectedAccount: expectedAccount || undefined }) });
        if (!quoteResponse.ok) { quoteResponse.szCreativeProxyNotSubmitted = true; return quoteResponse; }
        var quote = await quoteResponse.json();
        if (quote.billingMode !== "prepaid_quote" || !Number.isSafeInteger(quote.quoteCents) || quote.quoteCents <= 0) throw new Error("平台积分报价无效，本次未提交。");
        quotedCents = quote.quoteCents;
        showSubmissionQuote(quote, endpoint);
        await new Promise(function (resolve) { setTimeout(resolve, 0); });
      }
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
        if (receiptIdentity) form.set("__sz_image_receipt", JSON.stringify(receiptIdentity));
        if (expectedAccount) form.set("__sz_expected_account", expectedAccount);
        if (quotedCents !== undefined) form.set("__sz_quote_cents", String(quotedCents));
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
          receiptIdentity: receiptIdentity,
          expectedAccount: expectedAccount || undefined,
          expectedQuoteCents: quotedCents,
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
        if (response.status === 402 && typeof response.clone === "function") {
          response.clone().json().then(function (body) {
            if (body && body.code === "INSUFFICIENT_BALANCE" && body.providerSubmitted === false) showPurchasePrompt();
          }).catch(function () { /* Preserve the original error response. */ });
        }
      }
      if (platformSupplyUrl(url) && String(init.method || "GET").toUpperCase() === "POST") notifySupplyBalanceChanged();
      return response;
    }, function (error) {
      if (platformSupplyUrl(url) && String(init.method || "GET").toUpperCase() === "POST") notifySupplyBalanceChanged();
      throw error;
    });
  }

  if (nativeFetch) {
    global.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && (input.url || input.href)) || "";
      if (!shouldProxy(url)) {
        if (!ownGatewayUrl(url)) return nativeFetch(input, init);
        if (typeof Request !== "undefined" && input instanceof Request) {
          var ownRequest = new Request(input, init);
          return nativeFetch(ownRequest, { headers: supplyHeaders(ownRequest.url, ownRequest.method, headerObject(ownRequest.headers)) });
        }
        return nativeFetch(input, Object.assign({}, init || {}, { headers: supplyHeaders(url, init && init.method, headerObject(init && init.headers)) }));
      }
      if (typeof Request !== "undefined" && input instanceof Request) {
        var request = new Request(input, init);
        return (request.method === "GET" || request.method === "HEAD" ? Promise.resolve(undefined) : request.clone().arrayBuffer())
          .then(function (body) { return proxyFetch(request.url, { method: request.method, headers: request.headers, body: body, signal: request.signal, szExpectedAccount: init && init.szExpectedAccount, szBillingSignal: init && init.szBillingSignal, szImageReceipt: init && init.szImageReceipt, szOnProxyDispatch: init && init.szOnProxyDispatch, szOnProxyQueue: init && init.szOnProxyQueue }); });
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
          global.SZ_WEB_ACCOUNT.supportsConfigProfiles = global.SZ_WEB_ACCOUNT.supportsConfigProfiles || data.creativeConfigProfilesVersion === 1;
          return { ok: true, creativeEntitlement: data.creativeEntitlement || null, user: { id: id, username: data.username, email: data.username, name: data.name || data.username } };
        });
      })
      .catch(function () {
        return { ok: false, reason: "auth_transient" };
      }).finally(function () { authInFlight = null; });
    return authInFlight;
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
