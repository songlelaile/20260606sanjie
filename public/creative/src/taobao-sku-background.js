(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SZ_TAOBAO_SKU_BACKGROUND = api;
  if (root && root.chrome && root.chrome.runtime && root.chrome.runtime.onMessage) api.install(root.chrome);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SNAPSHOT_SCHEMA = 'TAOBAO_SKU_SNAPSHOT_V1';
  var DRAFT_SCHEMA = 'SKU_DRAFT_PROJECT_V1';
  var IMPORT_SCHEMA = 'TAOBAO_SKU_IMPORT_CONTEXT_V1';
  var OPEN_INTENT_SCHEMA = 'TAOBAO_SKU_OPEN_INTENT_V1';
  var IMPORT_CONTEXT_KEY_PREFIX = 'sz_taobao_sku_import_context_v1:';
  var IMPORT_INDEX_KEY = 'sz_taobao_sku_import_context_index_v1';
  var OPEN_INTENT_KEY_PREFIX = 'sz_taobao_sku_open_intent_v1:';
  var DRAFT_INDEX_KEY = 'sz_taobao_sku_draft_index_v1';
  var DRAFT_KEY_PREFIX = 'sz_taobao_sku_draft_project_v1:';
  var IMPORT_TTL_MS = 10 * 60 * 1000;
  var IMPORT_CLAIM_TTL_MS = 2 * 60 * 1000;
  var OPEN_INTENT_TTL_MS = 2 * 60 * 1000;
  var MAX_DRAFTS = 20;
  var MAX_AXES = 8;
  var MAX_VALUES_PER_AXIS = 240;
  var MAX_VARIANTS = 1200;
  var MAX_MEDIA = 2400;
  var MAX_DOWNLOADS = 240;
  var MAX_DRAFT_EDITS = 1200;
  var MAX_REPLACEMENT_IMAGE_CHARS = 2 * 1024 * 1024;
  var DOWNLOAD_CONCURRENCY = 3;
  var importMutationTail = Promise.resolve();

  function text(value, max) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max || 240);
  }

  function plainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function randomToken(bytes) {
    var cryptoApi = typeof globalThis !== 'undefined' && globalThis.crypto;
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
      throw new Error('浏览器安全随机数不可用，无法建立 SKU 导入上下文');
    }
    var values = new Uint8Array(bytes || 24);
    cryptoApi.getRandomValues(values);
    var binary = '';
    for (var index = 0; index < values.length; index++) binary += String.fromCharCode(values[index]);
    var encoded;
    if (typeof btoa === 'function') encoded = btoa(binary);
    else if (typeof Buffer !== 'undefined') encoded = Buffer.from(binary, 'binary').toString('base64');
    else throw new Error('安全随机令牌编码不可用');
    return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function queueImportMutation(task) {
    var run = importMutationTail.then(task, task);
    importMutationTail = run.catch(function () {});
    return run;
  }

  function idText(value, max) {
    return text(value, max || 180).replace(/[^\w:.-]/g, '_');
  }

  function assertArrayLimit(value, max, label) {
    if (value != null && !Array.isArray(value)) throw new Error(label + '必须是数组');
    var list = Array.isArray(value) ? value : [];
    if (list.length > max) throw new Error(label + '超过上限 ' + max);
    return list;
  }

  function allowedProductHost(hostname) {
    hostname = String(hostname || '').toLowerCase().replace(/\.$/, '');
    return hostname === 'item.taobao.com' || hostname === 'detail.tmall.com' ||
      hostname === 'chaoshi.detail.tmall.com' || hostname === 'detail.tmall.hk';
  }

  function allowedProductPath(hostname, pathname) {
    pathname = String(pathname || '');
    if (hostname === 'detail.tmall.hk') return pathname === '/item.htm' || pathname === '/hk/item.htm';
    return pathname === '/item.htm';
  }

  function parseProductPage(value) {
    try {
      var url = new URL(String(value || ''));
      var hostname = url.hostname.toLowerCase().replace(/\.$/, '');
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
      if (!allowedProductHost(hostname) || !allowedProductPath(hostname, url.pathname)) return null;
      var itemId = url.searchParams.get('id') || '';
      if (!/^\d{5,30}$/.test(itemId)) return null;
      var platform = hostname === 'item.taobao.com' ? 'taobao' : 'tmall';
      return {
        itemId: itemId,
        platform: platform,
        hostname: hostname,
        pathname: url.pathname,
        canonicalUrl: 'https://' + hostname + url.pathname + '?id=' + encodeURIComponent(itemId)
      };
    } catch (error) {
      return null;
    }
  }

  function allowedProductPage(value) {
    return !!parseProductPage(value);
  }

  function parseProductInput(value, platformHint) {
    value = String(value == null ? '' : value).trim();
    if (/^\d{5,30}$/.test(value)) {
      var tmall = platformHint === 'tmall';
      return {
        itemId: value,
        platform: tmall ? 'tmall' : 'taobao',
        hostname: tmall ? 'detail.tmall.com' : 'item.taobao.com',
        pathname: '/item.htm',
        canonicalUrl: 'https://' + (tmall ? 'detail.tmall.com' : 'item.taobao.com') + '/item.htm?id=' + encodeURIComponent(value)
      };
    }
    return parseProductPage(value);
  }

  function allowedAssetHost(hostname) {
    hostname = String(hostname || '').toLowerCase().replace(/\.$/, '');
    return hostname === 'alicdn.com' || hostname.endsWith('.alicdn.com') ||
      hostname === 'alicdn.cn' || hostname.endsWith('.alicdn.cn') ||
      hostname === 'taobaocdn.com' || hostname.endsWith('.taobaocdn.com') ||
      hostname === 'tbcdn.cn' || hostname.endsWith('.tbcdn.cn') ||
      hostname === 'tmallcdn.com' || hostname.endsWith('.tmallcdn.com');
  }

  function safeAssetUrl(value) {
    try {
      var input = String(value || '');
      if (!input || input.length > 4096 || /[\u0000-\u001f\u007f]/.test(input)) return '';
      var url = new URL(input.trim());
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowedAssetHost(url.hostname)) return '';
      url.hash = '';
      return url.href;
    } catch (error) {
      return '';
    }
  }

  function safePageUrl(value, itemId, platform) {
    var parsed = parseProductPage(value);
    if (parsed && parsed.itemId === itemId) return parsed.canonicalUrl;
    var host = platform === 'tmall' ? 'detail.tmall.com' : 'item.taobao.com';
    return 'https://' + host + '/item.htm?id=' + encodeURIComponent(itemId);
  }

  function sanitizeImage(value) {
    value = plainObject(value) ? value : {};
    var url = safeAssetUrl(value.url);
    if (!url) return null;
    var role = /^(?:sku|option|main|detail|none)$/.test(String(value.role || '')) ? String(value.role) : 'none';
    return { url: url, role: role, sourcePath: text(value.sourcePath, 500) };
  }

  function sanitizePrice(value) {
    value = plainObject(value) ? value : {};
    var rawAmount = text(value.amount, 80);
    var match = rawAmount.match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    return { amount: match[0], currency: 'CNY', type: text(value.type || 'page_display', 60), raw: text(value.raw, 160) };
  }

  function sanitizeAvailability(value) {
    value = plainObject(value) ? value : {};
    var state = /^(?:available|unavailable|unknown)$/.test(String(value.state || '')) ? String(value.state) : 'unknown';
    var quantity = Number(value.quantity);
    return {
      quantity: Number.isFinite(quantity) && quantity >= 0 ? Math.floor(quantity) : null,
      state: state,
      raw: text(value.raw, 160)
    };
  }

  function sanitizeSnapshot(input) {
    if (!plainObject(input) || input.schema !== SNAPSHOT_SCHEMA) throw new Error('SKU 快照格式无效');
    if (input.schemaVersion !== 1) throw new Error('SKU 快照 schemaVersion 必须为 1');
    if (input.sourceMode !== 'PUBLIC_REFERENCE') throw new Error('SKU 快照仅允许 PUBLIC_REFERENCE 公开参考数据');
    var itemId = text(input.itemId, 40);
    if (!/^\d{5,30}$/.test(itemId)) throw new Error('SKU 快照缺少有效商品 ID');
    var capturedAt = text(input.capturedAt, 80);
    if (!capturedAt || !Number.isFinite(Date.parse(capturedAt))) throw new Error('SKU 快照 capturedAt 时间无效');
    var platform = input.platform === 'tmall' ? 'tmall' : 'taobao';
    var axesInput = assertArrayLimit(input.axes, MAX_AXES, 'SKU 规格轴');
    var variantsInput = assertArrayLimit(input.variants, MAX_VARIANTS, 'SKU 变体');
    var mediaInput = assertArrayLimit(input.media, MAX_MEDIA, 'SKU 素材');
    var warningsInput = assertArrayLimit(input.warnings, 120, 'SKU 警告');
    var evidence = plainObject(input.evidence) ? input.evidence : {};
    var candidatePaths = assertArrayLimit(evidence.candidatePaths, 80, 'SKU 证据路径');
    var endpointPaths = assertArrayLimit(evidence.endpointPaths, 80, 'SKU 端点路径');
    var axes = [];
    var axisIds = Object.create(null);
    var valueIds = Object.create(null);

    axesInput.forEach(function (axis, axisIndex) {
      axis = plainObject(axis) ? axis : {};
      var axisId = idText(axis.axisId || ('axis_' + axisIndex), 180);
      if (!axisId || axisIds[axisId]) throw new Error('SKU 规格轴 ID 缺失或重复');
      axisIds[axisId] = true;
      var values = [];
      assertArrayLimit(axis.values, MAX_VALUES_PER_AXIS, '单个 SKU 规格值').forEach(function (value, valueIndex) {
        value = plainObject(value) ? value : {};
        var valueId = idText(value.valueId || (axisId + '_value_' + valueIndex), 180);
        if (!valueId || valueIds[valueId]) throw new Error('SKU 规格值 ID 缺失或重复');
        valueIds[valueId] = axisId;
        values.push({
          valueId: valueId,
          sourceValueId: text(value.sourceValueId, 120) || null,
          label: text(value.label, 240) || ('规格值 ' + (valueIndex + 1)),
          alias: text(value.alias, 240),
          position: Number.isFinite(Number(value.position)) ? Math.max(0, Math.floor(Number(value.position))) : valueIndex,
          image: sanitizeImage(value.image)
        });
      });
      axes.push({
        axisId: axisId,
        sourcePropertyId: text(axis.sourcePropertyId, 120) || null,
        name: text(axis.name, 160) || ('规格 ' + (axisIndex + 1)),
        position: Number.isFinite(Number(axis.position)) ? Math.max(0, Math.floor(Number(axis.position))) : axisIndex,
        values: values
      });
    });

    var variants = [];
    var variantIds = Object.create(null);
    variantsInput.forEach(function (variant, variantIndex) {
      variant = plainObject(variant) ? variant : {};
      var variantId = idText(variant.variantId || ('variant_' + variantIndex), 200);
      if (!variantId || variantIds[variantId]) throw new Error('SKU 变体 ID 缺失或重复');
      var coordinate = [];
      var seenAxes = Object.create(null);
      assertArrayLimit(variant.coordinate, MAX_AXES, 'SKU 坐标').forEach(function (pair) {
        pair = plainObject(pair) ? pair : {};
        var axisId = idText(pair.axisId, 180);
        var valueId = idText(pair.valueId, 180);
        if (!axisIds[axisId] || valueIds[valueId] !== axisId || seenAxes[axisId]) return;
        seenAxes[axisId] = true;
        coordinate.push({ axisId: axisId, valueId: valueId });
      });
      variantIds[variantId] = true;
      variants.push({
        variantId: variantId,
        sourceSkuId: text(variant.sourceSkuId, 160) || null,
        coordinate: coordinate,
        coordinateKey: text(variant.coordinateKey, 800) || coordinate.map(function (pair) { return pair.axisId + '=' + pair.valueId; }).join('|'),
        displayName: text(variant.displayName, 500) || ('SKU ' + String(variantIndex + 1).padStart(3, '0')),
        observedPrice: sanitizePrice(variant.observedPrice),
        observedAvailability: sanitizeAvailability(variant.observedAvailability),
        image: sanitizeImage(variant.image)
      });
    });

    var media = [];
    var assetIds = Object.create(null);
    mediaInput.forEach(function (asset, assetIndex) {
      asset = plainObject(asset) ? asset : {};
      var linkedAxisValueIds = assertArrayLimit(asset.linkedAxisValueIds, MAX_VARIANTS, '素材关联规格值');
      var linkedVariantIds = assertArrayLimit(asset.linkedVariantIds, MAX_VARIANTS, '素材关联变体');
      var url = safeAssetUrl(asset.url);
      if (!url) return;
      var assetId = idText(asset.assetId || ('asset_' + assetIndex), 200);
      if (!assetId || assetIds[assetId]) throw new Error('SKU 素材 ID 缺失或重复');
      assetIds[assetId] = true;
      var role = /^(?:main|option|sku|detail)$/.test(String(asset.role || '')) ? String(asset.role) : 'main';
      media.push({
        assetId: assetId,
        url: url,
        role: role,
        sourcePath: text(asset.sourcePath, 500),
        linkedAxisValueIds: linkedAxisValueIds.map(function (id) { return idText(id, 180); }).filter(function (id) { return !!valueIds[id]; }),
        linkedVariantIds: linkedVariantIds.map(function (id) { return idText(id, 200); }).filter(function (id) { return !!variantIds[id]; }),
        rightsStatus: 'reference_only'
      });
    });

    var completeness = /^(?:complete|partial|unknown)$/.test(String(input.completeness || '')) ? String(input.completeness) : 'unknown';
    return {
      schema: SNAPSHOT_SCHEMA,
      schemaVersion: 1,
      snapshotId: idText(input.snapshotId || ('snapshot_' + itemId), 200),
      platform: platform,
      sourceMode: 'PUBLIC_REFERENCE',
      itemId: itemId,
      title: text(input.title, 500),
      canonicalUrl: safePageUrl(input.canonicalUrl, itemId, platform),
      capturedAt: new Date(Date.parse(capturedAt)).toISOString(),
      adapterVersion: text(input.adapterVersion || '1', 40),
      completeness: completeness,
      axes: axes,
      variants: variants,
      media: media,
      evidence: {
        candidatePaths: candidatePaths.map(function (item) { return text(item, 500); }).filter(Boolean),
        endpointPaths: endpointPaths.map(function (item) { return text(item, 500); }).filter(Boolean),
        payloadCount: Math.max(0, Math.min(10000, Math.floor(Number(evidence.payloadCount) || 0)))
      },
      warnings: warningsInput.map(function (warning) {
        warning = plainObject(warning) ? warning : {};
        return { code: idText(warning.code || 'WARNING', 80), message: text(warning.message, 500), path: text(warning.path, 500) };
      })
    };
  }

  function draftId(now, randomValue) {
    now = Number(now) || Date.now();
    var suffix;
    if (Number.isFinite(Number(randomValue))) {
      suffix = Math.floor(Math.abs(Number(randomValue)) * 0xffffff).toString(36).padStart(5, '0').slice(0, 6);
    } else {
      suffix = randomToken(10);
    }
    return 'sku_draft_' + now.toString(36) + '_' + suffix;
  }

  function buildDraftProject(snapshot, selectedVariantIds, now, randomValue) {
    snapshot = sanitizeSnapshot(snapshot);
    var selected = Object.create(null);
    var hasSelection = Array.isArray(selectedVariantIds);
    assertArrayLimit(selectedVariantIds, MAX_VARIANTS, '已选 SKU').forEach(function (id) { selected[idText(id, 200)] = true; });
    var id = draftId(now, randomValue);
    var createdAt = new Date(Number(now) || Date.now()).toISOString();
    return {
      schema: DRAFT_SCHEMA,
      schemaVersion: 1,
      draftId: id,
      revision: 1,
      createdAt: createdAt,
      updatedAt: createdAt,
      sourceSnapshotId: snapshot.snapshotId,
      source: {
        platform: snapshot.platform,
        itemId: snapshot.itemId,
        canonicalUrl: snapshot.canonicalUrl,
        sourceMode: 'PUBLIC_REFERENCE',
        title: snapshot.title,
        completeness: snapshot.completeness,
        capturedAt: snapshot.capturedAt
      },
      axes: snapshot.axes,
      variants: snapshot.variants.map(function (variant) {
        return {
          draftVariantId: 'draft_' + variant.variantId,
          sourceVariantId: variant.variantId,
          sourceSkuId: variant.sourceSkuId,
          coordinate: variant.coordinate,
          coordinateKey: variant.coordinateKey,
          displayName: variant.displayName,
          skuId: '',
          skuCode: '',
          attributeText: '',
          editableAttributes: {},
          sourceImageUrl: variant.image && variant.image.url || '',
          sourceImageRole: variant.image && variant.image.role || 'none',
          replacementImage: null,
          observedPrice: variant.observedPrice,
          observedAvailability: variant.observedAvailability,
          rightsStatus: 'reference_only',
          selected: hasSelection ? !!selected[variant.variantId] : true
        };
      }),
      media: snapshot.media,
      warnings: snapshot.warnings
    };
  }

  function safeFilename(value, fallback) {
    var parts = String(value || '').replace(/\\/g, '/').split('/').map(function (part) {
      return part.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '').replace(/[ .]+$/g, '').trim().slice(0, 90);
    }).filter(Boolean).slice(0, 8);
    var name = parts.join('/').slice(0, 600);
    return name || (fallback || '淘宝SKU/图片.jpg');
  }

  function safeFilenameSegment(value, fallback) {
    var clean = String(value || '').replace(/[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, '_')
      .replace(/^\.+/, '').replace(/[ .]+$/g, '').trim().slice(0, 80);
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) clean = '_' + clean;
    return clean || fallback;
  }

  function extensionForUrl(value) {
    try {
      var pathname = new URL(value).pathname;
      var match = pathname.match(/\.(jpe?g|png|webp|gif|avif)$/i);
      return match ? (match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase()) : 'jpg';
    } catch (error) {
      return 'jpg';
    }
  }

  function sanitizeDownloadItems(message, sourcePage) {
    message = plainObject(message) ? message : {};
    var plan = plainObject(message.plan) ? message.plan : {};
    var previewFiles = Array.isArray(message.files) ? message.files : null;
    var source = previewFiles || (Array.isArray(message.items) ? message.items : (Array.isArray(plan.items) ? plan.items : (Array.isArray(plan.files) ? plan.files : [])));
    assertArrayLimit(source, MAX_DOWNLOADS, '下载图片');
    var previewMappings = previewFiles ? assertArrayLimit(message.mappings, MAX_VARIANTS, '下载图片映射') : [];
    if (previewFiles && message.mode !== 'deduplicated_assets' && message.mode !== 'per_variant_folder') {
      throw new Error('下载模式无效');
    }
    var mappingsByFile = Object.create(null);
    previewMappings.forEach(function (mapping) {
      mapping = plainObject(mapping) ? mapping : {};
      var rawFileId = String(mapping.fileId || '');
      if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(rawFileId) || mapping.status !== 'ready') return;
      if (!mappingsByFile[rawFileId]) mappingsByFile[rawFileId] = [];
      mappingsByFile[rawFileId].push(mapping);
    });
    var seen = Object.create(null);
    return source.map(function (item, index) {
      item = plainObject(item) ? item : {};
      var url = safeAssetUrl(item.url || item.imageUrl);
      if (!url) return null;
      var mapping = null;
      if (previewFiles) {
        var rawFileId = String(item.fileId || '');
        if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(rawFileId)) return null;
        var linked = mappingsByFile[rawFileId] || [];
        mapping = linked.find(function (candidate) {
          return safeAssetUrl(candidate.url) === url && /^(?:sku|option|main|detail)$/.test(String(candidate.imageRole || ''));
        }) || null;
        if (!mapping) return null;
      }
      var rawRole = previewFiles ? mapping.imageRole : item.role;
      var role = /^(?:sku|option|main|detail)$/.test(String(rawRole || '')) ? String(rawRole) : '';
      if (previewFiles && !role) return null;
      if (!role) role = 'sku';
      var variantIdentity = previewFiles ? mapping.variantId : (item.variantName || item.displayName || item.variantId);
      var variantName = safeFilenameSegment(variantIdentity, 'SKU_' + String(index + 1).padStart(3, '0'));
      var roleName = { sku: 'SKU图', option: '规格图', main: '主图', detail: '详情图' }[role];
      var stableId = safeFilenameSegment(previewFiles ? item.fileId : (item.assetId || item.variantId), String(index + 1).padStart(3, '0'));
      var rootFolder = '淘宝商品_' + safeFilenameSegment(sourcePage && sourcePage.itemId, '未知ID');
      var modeFolder = previewFiles && message.mode === 'deduplicated_assets' ? '去重素材' : '按SKU/' + variantName;
      var filename = safeFilename(rootFolder + '/' + modeFolder + '/' + roleName + '_' + stableId + '.' + extensionForUrl(url));
      var key = previewFiles ? (url + '\n' + String(item.fileId || '')) : (url + '\n' + variantName + '\n' + role);
      if (seen[key]) return null;
      seen[key] = true;
      return {
        url: url,
        filename: filename,
        role: role,
        variantName: variantName,
        assetId: idText(item.assetId, 200),
        variantId: idText(previewFiles ? mapping.variantId : item.variantId, 200)
      };
    }).filter(Boolean);
  }

  function storageArea(chromeApi, name) {
    var area = chromeApi && chromeApi.storage && chromeApi.storage[name];
    if (!area) throw new Error(name === 'session' ? '浏览器不支持安全的会话级 SKU 交接' : '浏览器本地存储不可用');
    return area;
  }

  function storageGet(chromeApi, areaName, keys) {
    return new Promise(function (resolve, reject) {
      var area;
      try { area = storageArea(chromeApi, areaName); }
      catch (error) { reject(error); return; }
      area.get(keys, function (result) {
        var error = chromeApi.runtime.lastError;
        if (error) reject(new Error(error.message || '读取 SKU 存储失败'));
        else resolve(result || {});
      });
    });
  }

  function storageSet(chromeApi, areaName, value) {
    return new Promise(function (resolve, reject) {
      var area;
      try { area = storageArea(chromeApi, areaName); }
      catch (error) { reject(error); return; }
      area.set(value, function () {
        var error = chromeApi.runtime.lastError;
        if (error) reject(new Error(error.message || '保存 SKU 存储失败'));
        else resolve();
      });
    });
  }

  function storageRemove(chromeApi, areaName, keys) {
    return new Promise(function (resolve, reject) {
      var area;
      try { area = storageArea(chromeApi, areaName); }
      catch (error) { reject(error); return; }
      area.remove(keys, function () {
        var error = chromeApi.runtime.lastError;
        if (error) reject(new Error(error.message || '清理 SKU 存储失败'));
        else resolve();
      });
    });
  }

  function validContextId(value) {
    value = String(value || '');
    return /^[A-Za-z0-9_-]{32,96}$/.test(value) ? value : '';
  }

  function validClaimNonce(value) {
    value = String(value || '');
    return /^[A-Za-z0-9_-]{24,96}$/.test(value) ? value : '';
  }

  function validDraftId(value) {
    value = String(value || '');
    return /^sku_draft_[a-z0-9]+_[A-Za-z0-9_-]{5,96}$/.test(value) ? value : '';
  }

  function persistDraftUnsafe(chromeApi, project, options) {
    options = options || {};
    var now = Number(options.now) || Date.now();
    var contextId = validContextId(options.contextId) || randomToken(24);
    var projectKey = DRAFT_KEY_PREFIX + project.draftId;
    var contextKey = IMPORT_CONTEXT_KEY_PREFIX + contextId;
    return Promise.all([
      storageGet(chromeApi, 'local', [DRAFT_INDEX_KEY]),
      storageGet(chromeApi, 'session', null)
    ]).then(function (stored) {
      var localStored = stored[0];
      var sessionStored = stored[1];
      var index = Array.isArray(localStored[DRAFT_INDEX_KEY]) ? localStored[DRAFT_INDEX_KEY].filter(function (entry) {
        return plainObject(entry) && entry.draftId && entry.key && entry.draftId !== project.draftId;
      }) : [];
      index.unshift({ draftId: project.draftId, key: projectKey, itemId: project.source.itemId, title: project.source.title, createdAt: project.createdAt });
      var staleDraftKeys = index.slice(MAX_DRAFTS).map(function (entry) { return entry.key; }).filter(Boolean);
      index = index.slice(0, MAX_DRAFTS);

      var importIndex = Array.isArray(sessionStored[IMPORT_INDEX_KEY]) ? sessionStored[IMPORT_INDEX_KEY].filter(function (token) {
        var key = IMPORT_CONTEXT_KEY_PREFIX + token;
        return validContextId(token) && plainObject(sessionStored[key]) && Number(sessionStored[key].expiresAt) > now && token !== contextId;
      }) : [];
      var staleContextKeys = Object.keys(sessionStored).filter(function (key) {
        return key.indexOf(IMPORT_CONTEXT_KEY_PREFIX) === 0 && key !== contextKey &&
          (!plainObject(sessionStored[key]) || Number(sessionStored[key].expiresAt) <= now);
      });
      importIndex.unshift(contextId);

      var context = {
        schema: IMPORT_SCHEMA,
        schemaVersion: 1,
        contextId: contextId,
        draftId: project.draftId,
        projectKey: projectKey,
        createdAt: now,
        expiresAt: now + IMPORT_TTL_MS,
        claimedTabId: null,
        claimedAt: null,
        claimNonce: null,
        skuMax: options.skuMax === 5 || options.skuMax === 10 ? options.skuMax : 20,
        skuResolution: /^(?:1K|2K|4K)$/.test(options.skuResolution) ? options.skuResolution : '1K',
        skuRatio: /^(?:1:1|3:4|4:5)$/.test(options.skuRatio) ? options.skuRatio : '1:1'
      };
      var localOut = {};
      localOut[projectKey] = project;
      localOut[DRAFT_INDEX_KEY] = index;
      var sessionOut = {};
      sessionOut[contextKey] = context;
      sessionOut[IMPORT_INDEX_KEY] = importIndex;

      return storageSet(chromeApi, 'local', localOut).then(function () {
        return storageSet(chromeApi, 'session', sessionOut).catch(function (error) {
          return storageRemove(chromeApi, 'local', [projectKey]).catch(function () {}).then(function () { throw error; });
        });
      }).then(function () {
        var cleanup = [];
        if (staleDraftKeys.length) cleanup.push(storageRemove(chromeApi, 'local', staleDraftKeys).catch(function () {}));
        if (staleContextKeys.length) cleanup.push(storageRemove(chromeApi, 'session', staleContextKeys).catch(function () {}));
        return Promise.all(cleanup);
      }).then(function () { return context; });
    });
  }

  function persistDraft(chromeApi, project, options) {
    return queueImportMutation(function () { return persistDraftUnsafe(chromeApi, project, options); });
  }

  function removeImportContextUnsafe(chromeApi, contextId) {
    var key = IMPORT_CONTEXT_KEY_PREFIX + contextId;
    return storageGet(chromeApi, 'session', [IMPORT_INDEX_KEY]).then(function (stored) {
      var index = Array.isArray(stored[IMPORT_INDEX_KEY]) ? stored[IMPORT_INDEX_KEY].filter(function (token) { return token !== contextId; }) : [];
      var out = {};
      out[IMPORT_INDEX_KEY] = index;
      return storageSet(chromeApi, 'session', out).then(function () {
        return storageRemove(chromeApi, 'session', [key]);
      });
    });
  }

  function compensateDraft(chromeApi, context, draftIdValue) {
    return queueImportMutation(function () {
      var draftIdValueSafe = validDraftId(draftIdValue || (context && context.draftId));
      var contextId = validContextId(context && context.contextId);
      return storageGet(chromeApi, 'local', [DRAFT_INDEX_KEY]).then(function (stored) {
        var index = Array.isArray(stored[DRAFT_INDEX_KEY]) ? stored[DRAFT_INDEX_KEY].filter(function (entry) { return entry && entry.draftId !== draftIdValueSafe; }) : [];
        var out = {};
        out[DRAFT_INDEX_KEY] = index;
        return storageSet(chromeApi, 'local', out).then(function () {
          return draftIdValueSafe ? storageRemove(chromeApi, 'local', [DRAFT_KEY_PREFIX + draftIdValueSafe]) : null;
        });
      }).then(function () {
        return contextId ? removeImportContextUnsafe(chromeApi, contextId) : null;
      });
    });
  }

  function senderRuntimeMatches(chromeApi, sender) {
    return !!sender && sender.id === chromeApi.runtime.id;
  }

  function productSender(chromeApi, sender) {
    if (!senderRuntimeMatches(chromeApi, sender) || sender.frameId !== 0 || !sender.tab || !Number.isInteger(sender.tab.id)) return null;
    return parseProductPage(sender.tab.url);
  }

  function extensionPageUrl(chromeApi, sender) {
    if (!senderRuntimeMatches(chromeApi, sender)) return null;
    try {
      var url = new URL(String(sender.url || ''));
      var expected = new URL(chromeApi.runtime.getURL('labs/image-prompt-lab/promptlab.html'));
      if (url.protocol !== expected.protocol || url.host !== expected.host || url.pathname !== expected.pathname || url.username || url.password) return null;
      if (sender.frameId != null && sender.frameId !== 0) return null;
      return url;
    } catch (error) {
      return null;
    }
  }

  function extensionWorkbenchSender(chromeApi, sender, contextId, requireImportSource) {
    var url = extensionPageUrl(chromeApi, sender);
    if (!url || url.searchParams.get('mode') !== 'sku') return false;
    if (requireImportSource && url.searchParams.get('source') !== 'taobao-sku-scan') return false;
    if (contextId && url.searchParams.get('skuImportContextId') !== contextId) return false;
    return !requireImportSource || (sender.tab && Number.isInteger(sender.tab.id));
  }

  function extensionPopupSender(chromeApi, sender) {
    if (!senderRuntimeMatches(chromeApi, sender)) return false;
    return String(sender.url || '').split(/[?#]/)[0] === chromeApi.runtime.getURL('src/popup.html');
  }

  function openDraftWorkbench(chromeApi, context) {
    var query = '?mode=sku&source=taobao-sku-scan&skuImportContextId=' + encodeURIComponent(context.contextId) +
      '&draftId=' + encodeURIComponent(context.draftId) + '&skuMax=' + encodeURIComponent(context.skuMax) +
      '&skuResolution=' + encodeURIComponent(context.skuResolution) +
      '&skuRatio=' + encodeURIComponent(context.skuRatio);
    return new Promise(function (resolve, reject) {
      chromeApi.tabs.create({ url: chromeApi.runtime.getURL('labs/image-prompt-lab/promptlab.html') + query }, function (tab) {
        var error = chromeApi.runtime.lastError;
        if (error) reject(new Error(error.message || '无法打开 SKU 工作台'));
        else resolve(tab || {});
      });
    });
  }

  function createTab(chromeApi, options) {
    return new Promise(function (resolve, reject) {
      chromeApi.tabs.create(options, function (tab) {
        var error = chromeApi.runtime.lastError;
        if (error) reject(new Error(error.message || '无法创建商品页签'));
        else resolve(tab || {});
      });
    });
  }

  function updateTab(chromeApi, tabId, options) {
    return new Promise(function (resolve, reject) {
      chromeApi.tabs.update(tabId, options, function (tab) {
        var error = chromeApi.runtime.lastError;
        if (error) reject(new Error(error.message || '无法打开淘宝商品页'));
        else resolve(tab || {});
      });
    });
  }

  function openProductDetail(chromeApi, parsed, options, now) {
    options = options || {};
    return createTab(chromeApi, { url: 'about:blank', active: false }).then(function (tab) {
      if (!Number.isInteger(tab.id)) throw new Error('新商品页签缺少有效 ID');
      var key = OPEN_INTENT_KEY_PREFIX + tab.id;
      var intent = {
        schema: OPEN_INTENT_SCHEMA,
        itemId: parsed.itemId,
        canonicalUrl: parsed.canonicalUrl,
        createdAt: now,
        expiresAt: now + OPEN_INTENT_TTL_MS,
        nonce: randomToken(18),
        options: {
          skuMax: options.skuMax === 5 || options.skuMax === 10 ? options.skuMax : 20,
          skuResolution: /^(?:1K|2K|4K)$/.test(options.skuResolution) ? options.skuResolution : '1K',
          skuRatio: /^(?:1:1|3:4|4:5)$/.test(options.skuRatio) ? options.skuRatio : '1:1'
        }
      };
      var out = {};
      out[key] = intent;
      return queueImportMutation(function () { return storageSet(chromeApi, 'session', out); }).then(function () {
        return updateTab(chromeApi, tab.id, { url: parsed.canonicalUrl, active: true }).catch(function (error) {
          return storageRemove(chromeApi, 'session', [key]).catch(function () {}).then(function () { throw error; });
        });
      }).then(function () {
        return { ok: true, tabId: tab.id, itemId: parsed.itemId, url: parsed.canonicalUrl };
      });
    });
  }

  function claimOpenIntent(chromeApi, sender, now) {
    var page = productSender(chromeApi, sender);
    if (!page) return Promise.resolve({ ok: false, error: '只允许顶层淘宝或天猫商品详情页领取扫描意图' });
    var key = OPEN_INTENT_KEY_PREFIX + sender.tab.id;
    return queueImportMutation(function () {
      return storageGet(chromeApi, 'session', [key]).then(function (stored) {
        var intent = stored[key];
        if (!plainObject(intent) || intent.schema !== OPEN_INTENT_SCHEMA) return { ok: true, autoOpen: false };
        if (Number(intent.expiresAt) <= now) {
          return storageRemove(chromeApi, 'session', [key]).then(function () { return { ok: true, autoOpen: false, code: 'expired' }; });
        }
        if (intent.itemId !== page.itemId) {
          return { ok: false, code: 'intent_mismatch', error: '商品页与待扫描对象不匹配' };
        }
        return storageRemove(chromeApi, 'session', [key]).then(function () {
          return {
            ok: true,
            autoOpen: true,
            itemId: page.itemId,
            canonicalUrl: page.canonicalUrl,
            platform: page.platform,
            options: plainObject(intent.options) ? intent.options : {}
          };
        });
      });
    });
  }

  function publicContext(context) {
    return {
      schema: context.schema,
      schemaVersion: context.schemaVersion,
      contextId: context.contextId,
      draftId: context.draftId,
      createdAt: context.createdAt,
      expiresAt: context.expiresAt,
      skuMax: context.skuMax,
      skuResolution: context.skuResolution,
      skuRatio: context.skuRatio
    };
  }

  function claimImportContext(chromeApi, contextId, sender, now) {
    var contextKey = IMPORT_CONTEXT_KEY_PREFIX + contextId;
    var tabId = sender.tab.id;
    return queueImportMutation(function () {
      return storageGet(chromeApi, 'session', [contextKey]).then(function (stored) {
        var context = stored[contextKey];
        if (!plainObject(context) || context.schema !== IMPORT_SCHEMA || context.contextId !== contextId) {
          return { ok: false, code: 'missing_or_expired', error: '本次淘宝 SKU 导入已使用或已过期，请回到商品页重新导入' };
        }
        if (Number(context.expiresAt) <= now) {
          return removeImportContextUnsafe(chromeApi, contextId).then(function () {
            return { ok: false, code: 'missing_or_expired', error: '本次淘宝 SKU 导入已过期，请回到商品页重新导入' };
          });
        }
        var claimExpired = context.claimedTabId != null && Number(context.claimedAt) + IMPORT_CLAIM_TTL_MS <= now;
        if (context.claimedTabId != null && context.claimedTabId !== tabId && !claimExpired) {
          return { ok: false, code: 'claimed_elsewhere', error: '本次 SKU 导入已被另一个工作台领取' };
        }
        if (context.claimedTabId !== tabId || claimExpired || !context.claimNonce) {
          context = Object.assign({}, context, { claimedTabId: tabId, claimedAt: now, claimNonce: randomToken(18) });
          var out = {};
          out[contextKey] = context;
          return storageSet(chromeApi, 'session', out).then(function () { return context; });
        }
        return context;
      }).then(function (context) {
        if (!plainObject(context) || context.ok === false) return context;
        return storageGet(chromeApi, 'local', [context.projectKey]).then(function (stored) {
          var project = stored[context.projectKey];
          if (!plainObject(project) || project.schema !== DRAFT_SCHEMA || project.draftId !== context.draftId) {
            return { ok: false, code: 'draft_missing', error: '本地 SKU 草稿不存在，请回到商品页重新导入' };
          }
          return { ok: true, context: publicContext(context), project: project, claimNonce: context.claimNonce };
        });
      });
    });
  }

  function consumeImportContext(chromeApi, contextId, draftIdValue, claimNonce, sender, now) {
    var contextKey = IMPORT_CONTEXT_KEY_PREFIX + contextId;
    return queueImportMutation(function () {
      return storageGet(chromeApi, 'session', [contextKey]).then(function (stored) {
        var context = stored[contextKey];
        if (!plainObject(context) || context.schema !== IMPORT_SCHEMA || context.contextId !== contextId || Number(context.expiresAt) <= now) {
          return { ok: false, code: 'stale_context', error: 'SKU 导入上下文已使用或已过期' };
        }
        if (context.draftId !== draftIdValue || context.claimedTabId !== sender.tab.id || context.claimNonce !== claimNonce) {
          return { ok: false, code: 'claim_mismatch', error: 'SKU 导入领取凭据不匹配' };
        }
        return removeImportContextUnsafe(chromeApi, contextId).then(function () { return { ok: true, consumed: true }; });
      });
    });
  }

  function safeDataImage(value) {
    value = String(value || '');
    if (value.length > MAX_REPLACEMENT_IMAGE_CHARS) return '';
    return /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/=\s]+$/i.test(value) ? value.replace(/\s/g, '') : '';
  }

  function sanitizeReplacementImage(value) {
    if (value == null || value === '') return null;
    var raw = plainObject(value) ? value.url : value;
    var url = safeAssetUrl(raw) || safeDataImage(raw);
    if (!url) throw new Error('替换图片必须是受信任 CDN URL 或受支持的 data:image');
    return { url: url, source: url.indexOf('data:') === 0 ? 'local_data' : 'trusted_cdn' };
  }

  function boundedEditText(value, max, label) {
    var source = String(value == null ? '' : value);
    if (source.length > max) throw new Error(label + '超过长度上限 ' + max);
    return text(source, max);
  }

  function getDraftProject(chromeApi, draftIdValue) {
    var key = DRAFT_KEY_PREFIX + draftIdValue;
    return storageGet(chromeApi, 'local', [key]).then(function (stored) {
      var project = stored[key];
      if (!plainObject(project) || project.schema !== DRAFT_SCHEMA || project.draftId !== draftIdValue) {
        return { ok: false, code: 'draft_missing', error: '本地 SKU 草稿不存在' };
      }
      return { ok: true, project: project };
    });
  }

  function saveDraftEdits(chromeApi, draftIdValue, expectedRevision, edits, now) {
    return queueImportMutation(function () {
      var key = DRAFT_KEY_PREFIX + draftIdValue;
      return storageGet(chromeApi, 'local', [key]).then(function (stored) {
        var project = stored[key];
        if (!plainObject(project) || project.schema !== DRAFT_SCHEMA || project.draftId !== draftIdValue) {
          return { ok: false, code: 'draft_missing', error: '本地 SKU 草稿不存在' };
        }
        var revision = Number(project.revision) || 1;
        if (!Number.isInteger(expectedRevision) || expectedRevision !== revision) {
          return { ok: false, code: 'revision_conflict', revision: revision, error: 'SKU 草稿已被其他工作台更新，请刷新后重试' };
        }
        var byId = Object.create(null);
        project.variants.forEach(function (variant, index) { byId[variant.draftVariantId] = index; });
        var seen = Object.create(null);
        var prepared = edits.map(function (edit) {
          if (!plainObject(edit)) throw new Error('SKU 草稿编辑项无效');
          var editId = text(edit.draftVariantId, 220);
          if (!hasOwn(byId, editId) || seen[editId]) throw new Error('SKU 草稿变体 ID 不存在或重复');
          seen[editId] = true;
          var patch = {};
          if (hasOwn(edit, 'skuId')) patch.skuId = boundedEditText(edit.skuId, 160, 'skuId');
          if (hasOwn(edit, 'skuCode')) patch.skuCode = boundedEditText(edit.skuCode, 160, 'skuCode');
          if (hasOwn(edit, 'attributeText')) patch.attributeText = boundedEditText(edit.attributeText, 2000, 'attributeText');
          if (hasOwn(edit, 'replacementImage')) patch.replacementImage = sanitizeReplacementImage(edit.replacementImage);
          if (hasOwn(edit, 'selected')) patch.selected = edit.selected === true;
          return { index: byId[editId], patch: patch };
        });
        var updated = Object.assign({}, project, {
          revision: revision + 1,
          updatedAt: new Date(now).toISOString(),
          variants: project.variants.slice()
        });
        prepared.forEach(function (entry) {
          updated.variants[entry.index] = Object.assign({}, updated.variants[entry.index], entry.patch);
        });
        var out = {};
        out[key] = updated;
        return storageSet(chromeApi, 'local', out).then(function () {
          return { ok: true, draftId: draftIdValue, revision: updated.revision, updatedAt: updated.updatedAt, project: updated };
        });
      });
    });
  }

  function downloadOne(chromeApi, item) {
    return new Promise(function (resolve) {
      chromeApi.downloads.download({ url: item.url, filename: item.filename, conflictAction: 'uniquify', saveAs: false }, function (downloadId) {
        var error = chromeApi.runtime.lastError;
        resolve(error || downloadId == null
          ? { ok: false, item: item, error: error && error.message || 'Chrome 未能启动图片下载' }
          : { ok: true, item: item, downloadId: downloadId });
      });
    });
  }

  function runDownloads(chromeApi, items) {
    var cursor = 0;
    var results = new Array(items.length);
    var workers = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, items.length) }, function () {
      return (async function () {
        while (cursor < items.length) {
          var index = cursor++;
          results[index] = await downloadOne(chromeApi, items[index]);
        }
      })();
    });
    return Promise.all(workers).then(function () {
      var successes = results.filter(function (result) { return result && result.ok; });
      var failures = results.filter(function (result) { return result && !result.ok; });
      return {
        ok: successes.length > 0 && failures.length === 0,
        partial: successes.length > 0 && failures.length > 0,
        requested: items.length,
        started: successes.length,
        failed: failures.length,
        downloadIds: successes.map(function (result) { return result.downloadId; }),
        errors: failures.slice(0, 20).map(function (result) { return { filename: result.item.filename, error: text(result.error, 240) }; })
      };
    });
  }

  function sendError(sendResponse, error) {
    sendResponse({ ok: false, error: text(error && error.message || error, 500) });
  }

  function handlesMessageType(type) {
    switch (type) {
      case 'TAOBAO_SKU_OPEN_DETAIL':
      case 'TAOBAO_SKU_CLAIM_OPEN_INTENT':
      case 'TAOBAO_SKU_DOWNLOAD_IMAGES':
      case 'TAOBAO_SKU_IMPORT_WORKBENCH':
      case 'TAOBAO_SKU_GET_IMPORT_CONTEXT':
      case 'TAOBAO_SKU_CONSUME_IMPORT_CONTEXT':
      case 'TAOBAO_SKU_GET_DRAFT_PROJECT':
      case 'TAOBAO_SKU_SAVE_DRAFT_EDITS':
        return true;
      default:
        return false;
    }
  }

  function install(chromeApi) {
    if (!chromeApi || !chromeApi.runtime || !chromeApi.runtime.onMessage || install.installed) return false;
    install.installed = true;
    chromeApi.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || typeof message.type !== 'string' || message.type.indexOf('TAOBAO_SKU_') !== 0) return;

      if (!handlesMessageType(message.type)) {
        sendResponse({ ok: false, code: 'unsupported_sku_message', error: '不支持的淘宝 SKU 消息类型' });
        return;
      }

      if (message.type === 'TAOBAO_SKU_OPEN_DETAIL') {
        if (!extensionPopupSender(chromeApi, sender)) {
          sendResponse({ ok: false, error: '只允许插件面板打开淘宝 SKU 扫描页' });
          return;
        }
        var parsedInput = parseProductInput(message.input || message.objectId || message.itemId || message.url, message.platform);
        if (!parsedInput) {
          sendResponse({ ok: false, error: '请输入有效的淘宝/天猫商品 ID 或精确详情页链接' });
          return;
        }
        openProductDetail(chromeApi, parsedInput, {
          skuMax: Number(message.skuMax),
          skuResolution: text(message.skuResolution, 10),
          skuRatio: text(message.skuRatio, 10)
        }, Date.now()).then(sendResponse).catch(function (error) { sendError(sendResponse, error); });
        return true;
      }

      if (message.type === 'TAOBAO_SKU_CLAIM_OPEN_INTENT') {
        claimOpenIntent(chromeApi, sender, Date.now()).then(sendResponse).catch(function (error) { sendError(sendResponse, error); });
        return true;
      }

      if (message.type === 'TAOBAO_SKU_DOWNLOAD_IMAGES') {
        var downloadSourcePage = productSender(chromeApi, sender);
        if (!downloadSourcePage) {
          sendResponse({ ok: false, error: '只允许从顶层淘宝或天猫商品详情页下载 SKU 图片' });
          return;
        }
        var items;
        try { items = sanitizeDownloadItems(message, downloadSourcePage); }
        catch (error) { sendError(sendResponse, error); return; }
        if (!items.length) {
          sendResponse({ ok: false, error: '没有可下载的有效淘宝 SKU 图片' });
          return;
        }
        runDownloads(chromeApi, items).then(sendResponse).catch(function (error) { sendError(sendResponse, error); });
        return true;
      }

      if (message.type === 'TAOBAO_SKU_IMPORT_WORKBENCH') {
        var sourcePage = productSender(chromeApi, sender);
        if (!sourcePage) {
          sendResponse({ ok: false, error: '只允许从顶层淘宝或天猫商品详情页导入 SKU' });
          return;
        }
        var project;
        try {
          project = buildDraftProject(message.snapshot, message.selectedVariantIds, Date.now());
          if (project.source.itemId !== sourcePage.itemId) throw new Error('SKU 快照商品 ID 与当前详情页不匹配');
          project.source.canonicalUrl = sourcePage.canonicalUrl;
          project.source.platform = sourcePage.platform;
        } catch (error) {
          sendError(sendResponse, error);
          return;
        }
        var persistedContext;
        persistDraft(chromeApi, project, {
          skuMax: Number(message.skuMax),
          skuResolution: text(message.skuResolution, 10),
          skuRatio: text(message.skuRatio, 10)
        }).then(function (context) {
          persistedContext = context;
          return openDraftWorkbench(chromeApi, context);
        }).then(function (tab) {
          sendResponse({
            ok: true,
            draftId: project.draftId,
            contextId: persistedContext.contextId,
            variantCount: project.variants.length,
            selectedCount: project.variants.filter(function (variant) { return variant.selected; }).length,
            tabId: tab && tab.id
          });
        }).catch(function (error) {
          var cleanup = persistedContext ? compensateDraft(chromeApi, persistedContext, project.draftId) : Promise.resolve();
          cleanup.catch(function () {}).then(function () { sendError(sendResponse, error); });
        });
        return true;
      }

      if (message.type === 'TAOBAO_SKU_GET_IMPORT_CONTEXT') {
        var contextId = validContextId(message.contextId);
        if (!contextId || !extensionWorkbenchSender(chromeApi, sender, contextId, true)) {
          sendResponse({ ok: false, error: 'SKU 导入上下文只能由与令牌绑定的批量 SKU 工作台读取' });
          return;
        }
        claimImportContext(chromeApi, contextId, sender, Date.now()).then(sendResponse).catch(function (error) { sendError(sendResponse, error); });
        return true;
      }

      if (message.type === 'TAOBAO_SKU_CONSUME_IMPORT_CONTEXT') {
        var consumeContextId = validContextId(message.contextId);
        var consumeDraftId = validDraftId(message.draftId);
        var claimNonce = validClaimNonce(message.claimNonce);
        if (!consumeContextId || !consumeDraftId || !claimNonce || !extensionWorkbenchSender(chromeApi, sender, consumeContextId, true)) {
          sendResponse({ ok: false, error: 'SKU 导入上下文只能由已领取的批量 SKU 工作台清除' });
          return;
        }
        consumeImportContext(chromeApi, consumeContextId, consumeDraftId, claimNonce, sender, Date.now())
          .then(sendResponse).catch(function (error) { sendError(sendResponse, error); });
        return true;
      }

      if (message.type === 'TAOBAO_SKU_GET_DRAFT_PROJECT') {
        var getDraftId = validDraftId(message.draftId);
        if (!getDraftId || !extensionWorkbenchSender(chromeApi, sender, null, false)) {
          sendResponse({ ok: false, error: '只允许批量 SKU 工作台读取指定的本地草稿' });
          return;
        }
        getDraftProject(chromeApi, getDraftId).then(sendResponse).catch(function (error) { sendError(sendResponse, error); });
        return true;
      }

      if (message.type === 'TAOBAO_SKU_SAVE_DRAFT_EDITS') {
        var saveDraftId = validDraftId(message.draftId);
        var edits;
        try { edits = assertArrayLimit(message.edits, MAX_DRAFT_EDITS, 'SKU 草稿编辑'); }
        catch (error) { sendError(sendResponse, error); return; }
        if (!saveDraftId || !extensionWorkbenchSender(chromeApi, sender, null, false)) {
          sendResponse({ ok: false, error: '只允许批量 SKU 工作台保存指定的本地草稿' });
          return;
        }
        saveDraftEdits(chromeApi, saveDraftId, Number(message.expectedRevision), edits, Date.now())
          .then(sendResponse).catch(function (error) { sendError(sendResponse, error); });
        return true;
      }
    });
    return true;
  }

  return {
    constants: {
      SNAPSHOT_SCHEMA: SNAPSHOT_SCHEMA,
      DRAFT_SCHEMA: DRAFT_SCHEMA,
      IMPORT_SCHEMA: IMPORT_SCHEMA,
      OPEN_INTENT_SCHEMA: OPEN_INTENT_SCHEMA,
      IMPORT_CONTEXT_KEY_PREFIX: IMPORT_CONTEXT_KEY_PREFIX,
      IMPORT_INDEX_KEY: IMPORT_INDEX_KEY,
      OPEN_INTENT_KEY_PREFIX: OPEN_INTENT_KEY_PREFIX,
      DRAFT_INDEX_KEY: DRAFT_INDEX_KEY,
      DRAFT_KEY_PREFIX: DRAFT_KEY_PREFIX,
      IMPORT_TTL_MS: IMPORT_TTL_MS,
      IMPORT_CLAIM_TTL_MS: IMPORT_CLAIM_TTL_MS,
      MAX_VARIANTS: MAX_VARIANTS,
      MAX_DOWNLOADS: MAX_DOWNLOADS,
      MAX_REPLACEMENT_IMAGE_CHARS: MAX_REPLACEMENT_IMAGE_CHARS
    },
    allowedProductHost: allowedProductHost,
    parseProductPage: parseProductPage,
    parseProductInput: parseProductInput,
    allowedProductPage: allowedProductPage,
    safeAssetUrl: safeAssetUrl,
    sanitizeSnapshot: sanitizeSnapshot,
    buildDraftProject: buildDraftProject,
    safeFilename: safeFilename,
    sanitizeDownloadItems: sanitizeDownloadItems,
    sanitizeReplacementImage: sanitizeReplacementImage,
    handlesMessageType: handlesMessageType,
    persistDraft: persistDraft,
    runDownloads: runDownloads,
    install: install
  };
});
