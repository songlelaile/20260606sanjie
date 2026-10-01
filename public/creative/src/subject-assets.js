/* subject-assets.js — 商品主体/模特/视觉模板素材的本机 IndexedDB 存储 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SZ_SUBJECT_ASSETS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var DB_NAME = 'sz_subject_assets_v1';
  var STORE_NAME = 'assets';
  var DB_VERSION = 1;

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') { reject(new Error('当前环境不支持 IndexedDB')); return; }
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'assetId' });
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('无法打开主体素材库')); };
    });
  }
  function bytesHash(bytes) {
    var h = 2166136261;
    for (var i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619);
    return ('00000000' + (h >>> 0).toString(16)).slice(-8);
  }
  function digest(buffer) {
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
      return crypto.subtle.digest('SHA-256', buffer).then(function (out) {
        return Array.prototype.map.call(new Uint8Array(out), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      });
    }
    return Promise.resolve(bytesHash(new Uint8Array(buffer)));
  }
  function transact(mode, worker) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, mode);
        var store = tx.objectStore(STORE_NAME);
        var result, settled = false;
        function finish(value) { if (settled) return; settled = true; resolve(value); }
        function fail(error) { if (settled) return; settled = true; reject(error); }
        try { result = worker(store, finish, fail); } catch (error) { fail(error); }
        tx.oncomplete = function () { db.close(); finish(result); };
        tx.onerror = function () { db.close(); fail(tx.error || new Error('主体素材库事务失败')); };
        tx.onabort = tx.onerror;
      });
    });
  }
  function putFile(file, meta) {
    meta = meta || {};
    if (!file || typeof file.arrayBuffer !== 'function') return Promise.reject(new Error('没有可保存的图片文件'));
    if (!/^image\/(?:png|jpeg|webp)$/i.test(String(file.type || ''))) return Promise.reject(new Error('主体素材仅支持 PNG、JPEG、WebP'));
    if (Number(file.size) > 20 * 1024 * 1024) return Promise.reject(new Error('单张主体素材不能超过20MB'));
    return file.arrayBuffer().then(function (buffer) {
      return digest(buffer).then(function (contentHash) {
        var assetId = 'asset_' + contentHash.slice(0, 32);
        var record = {
          assetId: assetId, contentHash: contentHash, blob: file, name: String(file.name || meta.name || 'image').slice(0, 180),
          type: String(file.type || 'image/png'), size: Number(file.size) || buffer.byteLength, role: String(meta.role || 'subject'),
          angle: String(meta.angle || ''), createdAt: Date.now(), updatedAt: Date.now()
        };
        return transact('readwrite', function (store) { store.put(record); }).then(function () {
          return { assetId: assetId, contentHash: contentHash, name: record.name, type: record.type, size: record.size, role: record.role, angle: record.angle };
        });
      });
    });
  }
  function get(assetId) {
    return transact('readonly', function (store, resolve, reject) {
      var request = store.get(String(assetId || ''));
      request.onsuccess = function () { resolve(request.result || null); };
      request.onerror = function () { reject(request.error || new Error('读取主体素材失败')); };
    });
  }
  function remove(assetId) {
    return transact('readwrite', function (store) { store.delete(String(assetId || '')); }).then(function () { return true; });
  }
  function getMany(assetIds) {
    return Promise.all((assetIds || []).map(function (assetId) { return get(assetId); })).then(function (items) { return items.filter(Boolean); });
  }
  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(reader.error || new Error('读取图片失败')); };
      reader.readAsDataURL(blob);
    });
  }
  function getDataUrls(assetIds) {
    return getMany(assetIds).then(function (records) {
      return Promise.all(records.map(function (record) {
        return blobToDataUrl(record.blob).then(function (dataUrl) { return { assetId: record.assetId, dataUrl: dataUrl, record: record }; });
      }));
    });
  }
  function availability(assetIds) {
    assetIds = (assetIds || []).filter(Boolean);
    return getMany(assetIds).then(function (records) {
      var found = {};
      records.forEach(function (record) { found[record.assetId] = true; });
      return { total: assetIds.length, available: records.length, missing: assetIds.filter(function (id) { return !found[id]; }) };
    });
  }
  return Object.freeze({ putFile: putFile, get: get, getMany: getMany, getDataUrls: getDataUrls, remove: remove, availability: availability, blobToDataUrl: blobToDataUrl });
});
