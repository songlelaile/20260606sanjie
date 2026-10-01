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

  function transact(storeName, mode, work) {
    return open().then(function withDb(db) {
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
          request = work(store, tx);
        } catch (error) {
          try { tx.abort(); } catch (_) { /* noop */ }
          fail(error);
          return;
        }

        if (request && typeof request.onsuccess !== 'undefined') {
          request.onsuccess = function onRequestSuccess() {
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

    return transact(ASSET_STORE, 'readwrite', function put(store) {
      return store.put(record);
    }).then(function saved() {
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

  function saveDraft(mode, draft) {
    var key = String(mode || '').trim();
    if (!key) return Promise.reject(new TypeError('草稿 mode 不能为空。'));
    var record = {
      mode: key,
      data: clonePlain(draft || {}),
      updatedAt: nowIso()
    };
    return transact(DRAFT_STORE, 'readwrite', function put(store) {
      return store.put(record);
    }).then(function saved() { return clonePlain(record); });
  }

  function getDraft(mode) {
    return transact(DRAFT_STORE, 'readonly', function get(store) {
      return store.get(String(mode));
    }).then(function loaded(record) {
      return record ? clonePlain(record) : null;
    });
  }

  function deleteDraft(mode) {
    return transact(DRAFT_STORE, 'readwrite', function remove(store) {
      return store.delete(String(mode));
    }).then(function removed() { return true; });
  }

  function saveRun(run) {
    if (!run || !run.id) return Promise.reject(new TypeError('运行记录 id 不能为空。'));
    var record = clonePlain(run);
    record.id = String(record.id);
    record.updatedAt = nowIso();
    if (!record.createdAt) record.createdAt = record.updatedAt;
    return transact(RUN_STORE, 'readwrite', function put(store) {
      return store.put(record);
    }).then(function saved() { return clonePlain(record); });
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
