(function initEcommerceVideoStore(root, factory) {
  'use strict';

  var api = factory(root);
  root.SZEcommerceVideoStore = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createEcommerceVideoStore(root) {
  'use strict';

  var DB_NAME = 'sz_ecommerce_video_studio';
  var DB_VERSION = 1;
  var ASSET_STORE = 'assets';
  var DRAFT_STORE = 'drafts';
  var RUN_STORE = 'runs';
  var dbPromise = null;

  function nowIso() {
    return new Date().toISOString();
  }

  function makeId(prefix) {
    var random = root.crypto && typeof root.crypto.randomUUID === 'function'
      ? root.crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    return String(prefix || 'item') + '-' + random;
  }

  function clonePlain(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function open() {
    if (dbPromise) return dbPromise;
    if (!root.indexedDB) {
      return Promise.reject(new Error('当前环境不支持 IndexedDB，无法保存本地素材。'));
    }

    dbPromise = new Promise(function executor(resolve, reject) {
      var request = root.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function onUpgrade(event) {
        var db = event.target.result;

        if (!db.objectStoreNames.contains(ASSET_STORE)) {
          var assets = db.createObjectStore(ASSET_STORE, { keyPath: 'id' });
          assets.createIndex('kind', 'kind', { unique: false });
          assets.createIndex('createdAt', 'createdAt', { unique: false });
        }

        if (!db.objectStoreNames.contains(DRAFT_STORE)) {
          var drafts = db.createObjectStore(DRAFT_STORE, { keyPath: 'mode' });
          drafts.createIndex('updatedAt', 'updatedAt', { unique: false });
        }

        if (!db.objectStoreNames.contains(RUN_STORE)) {
          var runs = db.createObjectStore(RUN_STORE, { keyPath: 'id' });
          runs.createIndex('updatedAt', 'updatedAt', { unique: false });
          runs.createIndex('status', 'status', { unique: false });
        }
      };
      request.onsuccess = function onSuccess(event) {
        var db = event.target.result;
        db.onversionchange = function onVersionChange() {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = function onError() {
        dbPromise = null;
        reject(request.error || new Error('打开本地素材库失败。'));
      };
      request.onblocked = function onBlocked() {
        dbPromise = null;
        reject(new Error('本地素材库正在被其他页面占用，请关闭旧页面后重试。'));
      };
    });

    return dbPromise;
  }

  function transact(storeName, mode, work, expectedAccountKey, isCurrent) {
    return open().then(function withDb(db) {
      var accountCheck = expectedAccountKey && root.SZ_WEB_ACCOUNT
        ? root.SZ_WEB_ACCOUNT.require() : Promise.resolve(expectedAccountKey || '');
      return accountCheck.then(function checked(account) {
      if (expectedAccountKey && account !== expectedAccountKey) throw new Error('账号已切换，请切回原账号后继续此视频计划。');
      if (isCurrent && !isCurrent()) throw new Error('草稿已变化，已停止原草稿操作。');
      return new Promise(function transactionPromise(resolve, reject) {
        var tx = db.transaction(storeName, mode);
        var store = tx.objectStore(storeName);
        var request;
        var requestResult;
        var settled = false;

        function succeed(value) {
          if (settled) return;
          settled = true;
          resolve(value);
        }

        function fail(error) {
          if (settled) return;
          settled = true;
          reject(error || new Error('本地数据操作失败。'));
        }

        try {
          request = work(store, tx, account);
        } catch (error) {
          try { tx.abort(); } catch (_) { /* noop */ }
          fail(error);
          return;
        }

        if (request && typeof request.onsuccess !== 'undefined') {
          request.onsuccess = function onRequestSuccess() {
            try { if (isCurrent && !isCurrent()) throw new Error('草稿已变化，已停止原草稿写入。'); }
            catch (error) {
              try { tx.abort(); } catch (_) { /* already aborted */ }
              fail(error);
              return;
            }
            requestResult = request.result;
            if (mode === 'readonly') succeed(requestResult);
          };
          request.onerror = function onRequestError() {
            fail(request.error || tx.error || new Error('本地数据操作失败。'));
          };
        }
        tx.oncomplete = function onComplete() {
          succeed(request && typeof request.onsuccess !== 'undefined' ? requestResult : request);
        };
        tx.onerror = function onTxError() {
          fail(tx.error || new Error('本地数据操作失败。'));
        };
        tx.onabort = function onTxAbort() {
          fail(tx.error || new Error('本地数据操作已中止。'));
        };
      });
      });
    });
  }

  function saveAsset(file, metadata) {
    if (!(file instanceof Blob)) {
      return Promise.reject(new TypeError('saveAsset 需要 File 或 Blob。'));
    }
    var meta = metadata || {};
    var timestamp = nowIso();
    var record = {
      id: String(meta.id || makeId('asset')),
      kind: String(meta.kind || 'file'),
      name: String(meta.name || file.name || '未命名素材'),
      mimeType: String(meta.mimeType || file.type || 'application/octet-stream'),
      size: Number(file.size || 0),
      durationSec: Number.isFinite(Number(meta.durationSec)) ? Number(meta.durationSec) : null,
      width: Number.isFinite(Number(meta.width)) ? Number(meta.width) : null,
      height: Number.isFinite(Number(meta.height)) ? Number(meta.height) : null,
      role: String(meta.role || 'asset'),
      referenceVideoId: meta.referenceVideoId ? String(meta.referenceVideoId) : '',
      timeSec: Number.isFinite(Number(meta.timeSec)) ? Number(meta.timeSec) : null,
      createdAt: String(meta.createdAt || timestamp),
      updatedAt: timestamp,
      blob: file
    };

    return transact(ASSET_STORE, 'readwrite', function put(store, _tx, account) {
      if (meta.expectedAccountKey) record.accountKey = account;
      return store.put(record);
    }, meta.expectedAccountKey || '', meta.isCurrent).then(function saved() {
      return toAssetSummary(record);
    });
  }

  function getAsset(id) {
    return transact(ASSET_STORE, 'readonly', function get(store) {
      return store.get(String(id));
    });
  }

  function deleteAsset(id) {
    return transact(ASSET_STORE, 'readwrite', function remove(store) {
      return store.delete(String(id));
    }).then(function removed() { return true; });
  }

  // Inspect every saved production record, including released/hidden plans and
  // result-only legacy records. An unreadable reference graph never authorizes deletion.
  function productionRetainedAssetIds(runs) {
    if (!Array.isArray(runs)) throw new Error('无法核对成片计划引用，本地副本保留。');
    var ids = new Set(), seen = new Set();
    var lists = ['images', 'videos', 'audios', 'productImages', 'generationVideos', 'referenceVideos', 'referenceAudios', 'referenceFrames', 'assets', 'tracks'];
    function add(value) {
      if (value == null || value === '') return;
      if (typeof value !== 'string') throw new Error('成片素材引用无法核对，本地副本保留。');
      if (value.trim()) ids.add(value.trim());
    }
    function visit(value, asset) {
      if (value == null) return;
      if (typeof value !== 'object' || Array.isArray(value)) throw new Error('成片记录无法核对，本地副本保留。');
      if (asset) add(value.id);
      if (seen.has(value)) return;
      seen.add(value);
      Object.keys(value).forEach(function (key) {
        var child = value[key];
        if (['plan', 'request', 'finalAudio'].indexOf(key) >= 0 && child != null && (typeof child !== 'object' || Array.isArray(child))) throw new Error('成片快照无法核对，本地副本保留。');
        if (['shots', 'shotRuns', 'narrationRuns', 'attempts'].indexOf(key) >= 0 && child != null) {
          if (!Array.isArray(child) || child.some(function (item) { return !item || typeof item !== 'object' || Array.isArray(item); })) throw new Error('成片镜头记录无法核对，本地副本保留。');
        }
        if (['sourceAssetId', 'resultAssetId', 'assetId', 'referenceVideoId'].indexOf(key) >= 0) { add(child); return; }
        if (key === 'musicAssetIds') {
          if (child != null && !Array.isArray(child)) throw new Error('成片音频引用无法核对，本地副本保留。');
          (child || []).forEach(add); return;
        }
        if (key === 'storageRef') {
          if (child != null) {
            if (typeof child !== 'object' || Array.isArray(child) || typeof child.id !== 'string' || !child.id.trim()) throw new Error('本地素材索引无法核对，副本保留。');
            visit(child, false); add(child.id);
          }
          return;
        }
        if (key === 'referenceVideo') { if (child != null) visit(child, true); return; }
        if (lists.indexOf(key) >= 0) {
          if (child != null && (!Array.isArray(child) || child.some(function (item) { return !item || typeof item !== 'object' || Array.isArray(item); }))) throw new Error('成片素材列表无法核对，本地副本保留。');
          (child || []).forEach(function (item) { visit(item, true); }); return;
        }
        if (Array.isArray(child)) child.forEach(function (item) { if (item && typeof item === 'object') visit(item, false); });
        else if (child && typeof child === 'object') visit(child, false);
      });
    }
    runs.forEach(function (run) {
      if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error('生成历史无法核对，本地副本保留。');
      if (run.purpose === 'production') visit(run, false);
    });
    return ids;
  }

  function deleteAssetsIfUnreferenced(ids, options) {
    var opts = options || {}, expected = String(opts.expectedAccountKey || '').trim();
    if (!expected || !root.SZ_WEB_ACCOUNT || typeof root.SZ_WEB_ACCOUNT.require !== 'function') {
      return Promise.reject(new Error('无法确认素材所属账号，本地副本保留。'));
    }
    var candidates = Array.from(new Set((ids || []).map(String)));
    return open().then(function (db) {
      return root.SZ_WEB_ACCOUNT.require().then(function (account) {
        if (account !== expected || opts.isCurrent && !opts.isCurrent()) throw new Error('账号或草稿已变化，已停止删除。');
        return new Promise(function (resolve, reject) {
          var tx = db.transaction([ASSET_STORE, RUN_STORE], 'readwrite');
          var assets = tx.objectStore(ASSET_STORE), result = { deleted: [], retained: [] }, failure;
          function current() { if (opts.isCurrent && !opts.isCurrent()) throw new Error('草稿已变化，已停止删除。'); }
          function referenced(id, retained) {
            return retained.has(id) || (opts.assetAliases || []).some(function (alias) { return alias.storageId === id && retained.has(alias.assetId); });
          }
          function abort(error) { failure = error; try { tx.abort(); } catch (_) { /* already aborted */ } }
          tx.onabort = tx.onerror = function () { reject(failure || tx.error || new Error('无法核对成片计划引用，本地副本保留。')); };
          tx.oncomplete = function () { resolve(result); };
          var request = tx.objectStore(RUN_STORE).getAll();
          request.onsuccess = function () {
            try {
              current();
              var retained = productionRetainedAssetIds(request.result);
              var memory = productionRetainedAssetIds(typeof opts.memoryRuns === 'function' ? opts.memoryRuns() : []);
              memory.forEach(function (id) { retained.add(id); });
              candidates.forEach(function (id) {
                if (referenced(id, retained)) { result.retained.push(id); return; }
                var record = assets.get(id);
                record.onsuccess = function () {
                  try {
                    current();
                    // Old unowned blobs remain readable, but are never assigned to this account by deletion.
                    if (!record.result || record.result.accountKey !== expected) { result.retained.push(id); return; }
                    var latest = productionRetainedAssetIds(typeof opts.memoryRuns === 'function' ? opts.memoryRuns() : []);
                    if (referenced(id, latest)) { result.retained.push(id); return; }
                    var deletion = assets.delete(id);
                    deletion.onsuccess = function () {
                      try {
                        current();
                        if (referenced(id, productionRetainedAssetIds(typeof opts.memoryRuns === 'function' ? opts.memoryRuns() : []))) throw new Error('成片计划仍引用此素材，本地副本保留。');
                      } catch (error) { abort(error); }
                    };
                    result.deleted.push(id);
                  } catch (error) { abort(error); }
                };
              });
            } catch (error) { abort(error); }
          };
        });
      });
    });
  }

  function listAssets(options) {
    var opts = options || {};
    return transact(ASSET_STORE, 'readonly', function all(store) {
      return opts.kind ? store.index('kind').getAll(String(opts.kind)) : store.getAll();
    }).then(function listed(records) {
      var items = (records || []).sort(function byCreated(a, b) {
        return String(b.createdAt).localeCompare(String(a.createdAt));
      });
      if (Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0) {
        items = items.slice(0, Number(opts.limit));
      }
      return opts.includeBlob ? items : items.map(toAssetSummary);
    });
  }

  function toAssetSummary(record) {
    if (!record) return null;
    return {
      id: record.id,
      kind: record.kind,
      name: record.name,
      mimeType: record.mimeType,
      size: record.size,
      durationSec: record.durationSec,
      width: record.width,
      height: record.height,
      role: record.role,
      referenceVideoId: record.referenceVideoId || '',
      timeSec: record.timeSec == null ? null : record.timeSec,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      storageRef: {
        dbName: DB_NAME,
        storeName: ASSET_STORE,
        id: record.id
      }
    };
  }

  function saveDraft(mode, draft, options) {
    var opts = options || {};
    var key = String(mode || '').trim();
    if (!key) return Promise.reject(new TypeError('草稿 mode 不能为空。'));
    var record = {
      mode: key,
      data: clonePlain(draft || {}),
      updatedAt: nowIso()
    };
    return transact(DRAFT_STORE, 'readwrite', function put(store) {
      return store.put(record);
    }, opts.expectedAccountKey, opts.isCurrent).then(function saved() { return clonePlain(record); });
  }

  function getDraft(mode) {
    return transact(DRAFT_STORE, 'readonly', function get(store) {
      return store.get(String(mode));
    }).then(function loaded(record) {
      return record ? clonePlain(record) : null;
    });
  }

  function deleteDraft(mode, options) {
    var opts = options || {};
    return transact(DRAFT_STORE, 'readwrite', function remove(store) {
      return store.delete(String(mode));
    }, opts.expectedAccountKey, opts.isCurrent).then(function removed() { return true; });
  }

  function saveRun(run) {
    if (!run || !run.id) return Promise.reject(new TypeError('运行记录 id 不能为空。'));
    var record = clonePlain(run);
    record.id = String(record.id);
    record.updatedAt = nowIso();
    if (!record.createdAt) record.createdAt = record.updatedAt;
    return transact(RUN_STORE, 'readwrite', function put(store) {
      return store.put(record);
    }, record.purpose === 'production' ? record.accountKey : '').then(function saved() { return clonePlain(record); });
  }

  function getRun(id) {
    return transact(RUN_STORE, 'readonly', function get(store) {
      return store.get(String(id));
    }).then(clonePlain);
  }

  function listRuns(options) {
    var opts = options || {};
    return transact(RUN_STORE, 'readonly', function all(store) {
      return opts.status ? store.index('status').getAll(String(opts.status)) : store.getAll();
    }).then(function listed(records) {
      var items = (records || []).sort(function byUpdated(a, b) {
        return String(b.updatedAt).localeCompare(String(a.updatedAt));
      });
      if (Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0) {
        items = items.slice(0, Number(opts.limit));
      }
      return clonePlain(items);
    });
  }

  function deleteRun(id) {
    return transact(RUN_STORE, 'readwrite', function remove(store) {
      return store.delete(String(id));
    }).then(function removed() { return true; });
  }

  return Object.freeze({
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    ASSET_STORE: ASSET_STORE,
    DRAFT_STORE: DRAFT_STORE,
    RUN_STORE: RUN_STORE,
    open: open,
    saveAsset: saveAsset,
    getAsset: getAsset,
    deleteAsset: deleteAsset,
    productionRetainedAssetIds: productionRetainedAssetIds,
    deleteAssetsIfUnreferenced: deleteAssetsIfUnreferenced,
    listAssets: listAssets,
    saveDraft: saveDraft,
    getDraft: getDraft,
    deleteDraft: deleteDraft,
    saveRun: saveRun,
    getRun: getRun,
    listRuns: listRuns,
    deleteRun: deleteRun
  });
});
