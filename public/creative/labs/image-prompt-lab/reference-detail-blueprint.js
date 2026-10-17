/* reference-detail-blueprint.js — “参考成详”工作蓝图纯逻辑层 */
(function (root, factory) {
  'use strict';
  var injected = root && root.SZ_REFERENCE_DETAIL_CONTRACT;
  if (typeof module === 'object' && module.exports) {
    if (!injected) {
      try { injected = require('../../src/reference-detail-contract.js'); } catch (_) { /* 延迟到调用时报错 */ }
    }
    module.exports = factory(injected);
  } else if (root) {
    root.SZ_REFERENCE_DETAIL_BLUEPRINT = factory(injected);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (injectedContract) {
  'use strict';

  var WORKING_SCHEMA = 'REFERENCE_DETAIL_WORKING_BLUEPRINT_V1';
  var FORMAL_SOURCE_SCHEMA = 'REFERENCE_DETAIL_SOURCE_V1';
  // 只用于识别并拒绝旧本地状态；它不再是可创建、可导入或可导出的来源合同。
  var REMOVED_UPLOAD_SOURCE_SCHEMA = 'REFERENCE_DETAIL_UPLOAD_SOURCE_V1';
  var REMOVED_UPLOAD_MARKERS = Object.freeze(['upload_fallback', 'upload_images', 'uploaded_images']);
  var LEGACY_UPLOAD_REMOVED_MESSAGE = '旧 1–6 张手动参考图来源已移除。请粘贴淘宝/天猫商品 URL，或在受支持的当前商品页重新提取。';
  var FORMAL_SOURCE_REQUIRED_MESSAGE = '参考成详只接受通过淘宝/天猫商品 URL 或受支持当前商品页提取的 REFERENCE_DETAIL_SOURCE_V1。';
  var SCHEMA_VERSION = 1;
  var MIN_CHUNK_SIZE = 4;
  var MAX_CHUNK_SIZE = 6;
  var MIN_SCREEN_COUNT = 5;
  var MAX_SCREEN_COUNT = 16;
  var MAX_MODEL_TEXT = 12000;
  var MAX_MODEL_SHORT_TEXT = 1000;
  var MAX_MODEL_LIST = 100;
  var MAX_DIRECTION_TEXT = 160;
  var SAFE_FLAG = /^[A-Z][A-Z0-9_]{1,79}$/;
  var SAFE_TARGET = /^(?:\*|headline|body|bullets(?:\.\d+)?|cta|editableCopy\.(?:headline|body|bullets(?:\.\d+)?|cta))$/;
  var OWNERSHIP_VALUES = Object.freeze(['self', 'self_owned', 'own_product', 'product']);
  var VERIFIED_VALUES = Object.freeze(['confirmed', 'verified', 'approved', 'active']);
  var SALES_ROLE_LABELS = Object.freeze({
    hero: '首屏钩子', pain: '痛点', benefit: '核心利益', feature: '功能卖点', scene: '使用场景',
    detail: '细节说明', comparison: '差异对比', proof: '证据证明', spec: '规格参数', size: '尺寸说明',
    usage: '使用方法', faq: '异议解答', service: '服务说明', cta: '转化收尾', unknown: '待编辑模块'
  });
  var SALES_ROLE_DIRECTIONS = Object.freeze({
    hero: '以自家商品主体和完整组合建立首屏认知，让用户立即理解本页核心价值。',
    pain: '用真实使用场景呈现目标人群的关键困扰，为后续解决方案铺垫。',
    benefit: '围绕已确认的核心利益展示使用结果，让用户快速理解购买价值。',
    feature: '用主体特写和结构示意讲清一项核心功能，突出其与使用需求的关系。',
    scene: '将自家商品放入典型使用场景，让用户直观感受适用时机和人群。',
    detail: '通过材质与工艺近景展示可见细节，增强对自家商品品质的理解。',
    comparison: '用清晰的信息层级呈现已确认的差异点，帮助用户快速完成选择。',
    proof: '用自家可核验的细节和使用证据支撑本屏主张，增强信任感。',
    spec: '用简洁图示呈现已确认的规格信息，帮助用户快速核对关键参数。',
    size: '通过尺寸标注和实际比例关系讲清商品大小，降低选购理解成本。',
    usage: '按真实使用顺序展示关键操作步骤，让用户一眼看懂如何使用。',
    faq: '直面用户最关心的一个购买疑问，用已确认信息给出清晰回应。',
    service: '用简洁服务信息说明购买后的关键保障，降低用户决策顾虑。',
    cta: '回收前文核心价值并突出自家商品主体，引导用户完成最终决策。',
    unknown: '聚焦本模块的主要销售任务，用自家商品和原创画面完成清晰表达。'
  });
  var DIRECTION_VARIANTS = Object.freeze([
    '用整体组合与主次层级强化第一视觉焦点',
    '用结构近景讲清关键细节与使用关系',
    '用材质纹理特写增强可见的品质感',
    '用真实使用动作呈现商品如何发挥作用',
    '用典型场景与环境关系说明适用时机',
    '用尺度对照与空间关系帮助用户建立直观认知',
    '用包装与内容物组合说清整体配置',
    '用功能局部与操作线索聚焦一个核心机制',
    '用人与商品的真实互动强化场景代入感',
    '用步骤先后与动作节点讲清使用方式',
    '用前中后景的空间层次突出商品主体',
    '用配件与主体的对应关系说清完整使用体验',
    '用工艺节点特写补充本屏的可见证据',
    '用简洁图示与重点标注降低信息理解成本',
    '用购买决策所需的关键信息完成信任收口',
    '用核心价值回收与清晰主体展示完成转化收尾'
  ]);

  function BlueprintError(code, message, path) {
    this.name = 'ReferenceDetailBlueprintError';
    this.code = code || 'BLUEPRINT_ERROR';
    this.message = message || '参考成详蓝图错误';
    this.path = path || '$';
    if (Error.captureStackTrace) Error.captureStackTrace(this, BlueprintError);
  }
  BlueprintError.prototype = Object.create(Error.prototype);
  BlueprintError.prototype.constructor = BlueprintError;

  function fail(code, message, path) {
    throw new BlueprintError(code, message, path);
  }

  function requireContract(contract) {
    contract = contract || injectedContract;
    if (!contract || typeof contract.sanitizeSourceSnapshot !== 'function' ||
        typeof contract.sanitizeBlueprint !== 'function' || typeof contract.stableHash !== 'function') {
      fail('CONTRACT_UNAVAILABLE', '参考成详合同未加载，请先注入 SZ_REFERENCE_DETAIL_CONTRACT。', '$contract');
    }
    return contract;
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function deepFreeze(value, seen) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    seen = seen || (typeof WeakSet === 'function' ? new WeakSet() : null);
    if (seen) {
      if (seen.has(value)) return value;
      seen.add(value);
    }
    Object.keys(value).forEach(function (key) { deepFreeze(value[key], seen); });
    return Object.freeze(value);
  }

  function own(object, key) {
    return object && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
  }

  function text(value, max) {
    if (value == null) return '';
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return '';
    return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max || MAX_MODEL_TEXT);
  }

  function directionBody(value) {
    return text(value, MAX_MODEL_TEXT)
      .replace(/\s+/g, ' ')
      .replace(/[\u3002\uff01\uff1f!?\uff1b;.]+/g, '，')
      .replace(/[,\uff0c]+/g, '，')
      .replace(/^[\s,\uff0c:：]+|[\s,\uff0c:：]+$/g, '')
      .trim();
  }

  function normalizeDirection(value, fallback) {
    var body = directionBody(value);
    if (!body && fallback != null) body = directionBody(fallback);
    if (!body) return '';
    body = body.slice(0, MAX_DIRECTION_TEXT - 1).replace(/[\s,\uff0c:：]+$/g, '').trim();
    return body ? body + '。' : '';
  }

  function fallbackDirectionForRole(salesRole) {
    return normalizeDirection(SALES_ROLE_DIRECTIONS[salesRole] || SALES_ROLE_DIRECTIONS.unknown);
  }

  function directionVariant(baseDirection, occurrence) {
    var facet = DIRECTION_VARIANTS[Math.max(0, occurrence - 1) % DIRECTION_VARIANTS.length];
    var base = directionBody(baseDirection);
    var suffix = '，' + facet;
    var maxBase = Math.max(1, MAX_DIRECTION_TEXT - suffix.length - 1);
    return normalizeDirection(base.slice(0, maxBase) + suffix);
  }

  function mergedDirection(modules) {
    var directions = unique((modules || []).map(function (module) {
      return directionBody(module && module.visualBrief && module.visualBrief.description);
    }).filter(Boolean));
    if (!directions.length) return fallbackDirectionForRole(modules && modules[0] && modules[0].salesRole);
    if (directions.length === 1) return normalizeDirection(directions[0]);
    var first = directions[0];
    var last = directions[directions.length - 1];
    var shell = '在同一屏中承接“”与“”，形成清晰的信息推进';
    var available = Math.max(12, MAX_DIRECTION_TEXT - shell.length - 1);
    var firstMax = Math.ceil(available / 2);
    var lastMax = Math.floor(available / 2);
    return normalizeDirection('在同一屏中承接“' + first.slice(0, firstMax) + '”与“' + last.slice(0, lastMax) + '”，形成清晰的信息推进');
  }

  function textList(value, maxItems, maxText) {
    if (!Array.isArray(value)) return [];
    var out = [];
    var seen = Object.create(null);
    value.slice(0, maxItems || MAX_MODEL_LIST).forEach(function (item) {
      var clean = text(item, maxText || MAX_MODEL_SHORT_TEXT);
      if (clean && !seen[clean]) {
        seen[clean] = true;
        out.push(clean);
      }
    });
    return out;
  }

  function idList(value) {
    if (!Array.isArray(value)) return [];
    var seen = Object.create(null);
    var out = [];
    value.forEach(function (item) {
      var id = text(item, 240);
      if (/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id) && !seen[id]) {
        seen[id] = true;
        out.push(id);
      }
    });
    return out;
  }

  function unique(values) {
    var seen = Object.create(null);
    return values.filter(function (value) {
      var key = String(value);
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function enumOr(value, allowed, fallback) {
    value = text(value, 80);
    return allowed.indexOf(value) >= 0 ? value : fallback;
  }

  function contractEnums(contract, key) {
    return contract.enums && Array.isArray(contract.enums[key]) ? Array.from(contract.enums[key]) : [];
  }

  function stableHash(value, prefix, contract) {
    return requireContract(contract).stableHash(value, prefix);
  }

  function marker(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  function looksLikeImageReferenceArray(value) {
    return Array.isArray(value) && value.length > 0 && value.every(function (item) {
      if (typeof item === 'string') return true;
      if (!isPlainObject(item) || own(item, 'moduleId')) return false;
      return typeof (own(item, 'url') || own(item, 'src') || own(item, 'dataUrl') || own(item, 'ref') || own(item, 'image')) === 'string';
    });
  }

  function removedUploadMarker(value, path, depth) {
    path = path || '$';
    depth = depth || 0;
    if (!isPlainObject(value) || depth > 3) return null;
    var schema = own(value, 'schema');
    if (schema === REMOVED_UPLOAD_SOURCE_SCHEMA) return { path: path + '.schema', marker: 'legacy_schema' };
    var topSourceMode = marker(own(value, 'sourceMode'));
    var topKind = marker(own(value, 'kind'));
    if (REMOVED_UPLOAD_MARKERS.indexOf(topSourceMode) >= 0) return { path: path + '.sourceMode', marker: topSourceMode };
    if (REMOVED_UPLOAD_MARKERS.indexOf(topKind) >= 0) return { path: path + '.kind', marker: topKind };
    if (schema === FORMAL_SOURCE_SCHEMA && Array.isArray(own(value, 'images'))) {
      return { path: path + '.images', marker: 'legacy_images_field' };
    }

    var sourceKind = marker(own(value, 'sourceKind'));
    if (REMOVED_UPLOAD_MARKERS.indexOf(sourceKind) >= 0) return { path: path + '.sourceKind', marker: sourceKind };

    var source = own(value, 'source');
    if (isPlainObject(source)) {
      if (own(source, 'schema') === REMOVED_UPLOAD_SOURCE_SCHEMA) return { path: path + '.source.schema', marker: 'legacy_schema' };
      var sourceMode = marker(own(source, 'sourceMode'));
      var kind = marker(own(source, 'kind'));
      var platform = marker(own(source, 'platform'));
      if (REMOVED_UPLOAD_MARKERS.indexOf(sourceMode) >= 0) return { path: path + '.source.sourceMode', marker: sourceMode };
      if (REMOVED_UPLOAD_MARKERS.indexOf(kind) >= 0) return { path: path + '.source.kind', marker: kind };
      if (platform === 'upload') return { path: path + '.source.platform', marker: platform };
    }

    var provenance = own(value, 'provenance');
    if (isPlainObject(provenance) && REMOVED_UPLOAD_MARKERS.indexOf(marker(own(provenance, 'kind'))) >= 0) {
      return { path: path + '.provenance.kind', marker: marker(own(provenance, 'kind')) };
    }
    var snapshotId = marker(own(value, 'sourceSnapshotId') || own(value, 'snapshotId'));
    var blueprintId = marker(own(value, 'blueprintId'));
    if (/^rdu_/.test(snapshotId)) return {
      path: own(value, 'sourceSnapshotId') ? path + '.sourceSnapshotId' : path + '.snapshotId',
      marker: 'legacy_upload_snapshot_id'
    };
    if (schema === WORKING_SCHEMA && /^rdup_/.test(blueprintId)) {
      return { path: path + '.blueprintId', marker: 'legacy_working_id' };
    }
    var warnings = own(value, 'warnings');
    if (Array.isArray(warnings)) {
      for (var warningIndex = 0; warningIndex < warnings.length; warningIndex++) {
        if (isPlainObject(warnings[warningIndex]) && own(warnings[warningIndex], 'code') === 'UPLOAD_FALLBACK_SOURCE') {
          return { path: path + '.warnings[' + warningIndex + '].code', marker: 'legacy_warning' };
        }
      }
    }
    var modules = own(value, 'modules');
    if (Array.isArray(modules)) {
      for (var moduleIndex = 0; moduleIndex < modules.length; moduleIndex++) {
        var module = modules[moduleIndex];
        if (!isPlainObject(module)) continue;
        var modulePath = path + '.modules[' + moduleIndex + ']';
        var moduleProvenance = own(module, 'provenance');
        if (isPlainObject(moduleProvenance) && REMOVED_UPLOAD_MARKERS.indexOf(marker(own(moduleProvenance, 'kind'))) >= 0) {
          return { path: modulePath + '.provenance.kind', marker: marker(own(moduleProvenance, 'kind')) };
        }
        var sourceBlockIds = Array.isArray(own(module, 'sourceBlockIds')) ? own(module, 'sourceBlockIds') : [];
        if (/^rdub_/.test(marker(own(module, 'moduleId') || own(module, 'sourceBlockId'))) ||
            sourceBlockIds.some(function (id) { return /^rdub_/.test(marker(id)); })) {
          return { path: modulePath + '.sourceBlockIds', marker: 'legacy_upload_block' };
        }
      }
    }
    var orderedBlocks = own(value, 'orderedBlocks');
    if (Array.isArray(orderedBlocks)) {
      for (var blockIndex = 0; blockIndex < orderedBlocks.length; blockIndex++) {
        if (isPlainObject(orderedBlocks[blockIndex]) && /^rdub_/.test(marker(own(orderedBlocks[blockIndex], 'blockId')))) {
          return { path: path + '.orderedBlocks[' + blockIndex + '].blockId', marker: 'legacy_upload_block' };
        }
      }
    }
    var assets = own(value, 'assets');
    if (Array.isArray(assets)) {
      for (var assetIndex = 0; assetIndex < assets.length; assetIndex++) {
        if (!isPlainObject(assets[assetIndex])) continue;
        if (/^rdu(?:asset|a)_/.test(marker(own(assets[assetIndex], 'assetId')))) {
          return { path: path + '.assets[' + assetIndex + '].assetId', marker: 'legacy_upload_asset' };
        }
        if (/^\$upload\.images(?:\[|\.|$)/i.test(marker(own(assets[assetIndex], 'sourcePath')))) {
          return { path: path + '.assets[' + assetIndex + '].sourcePath', marker: 'legacy_upload_source_path' };
        }
      }
    }

    var nestedKeys = ['referenceDetail', 'editor', 'working'];
    for (var nestedIndex = 0; nestedIndex < nestedKeys.length; nestedIndex++) {
      var nestedKey = nestedKeys[nestedIndex];
      var nested = own(value, nestedKey);
      var found = removedUploadMarker(nested, path + '.' + nestedKey, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function sourceMigrationDiagnostic(input) {
    var legacy = removedUploadMarker(input);
    if (legacy) return deepFreeze({
      ok: false,
      legacy: true,
      code: 'LEGACY_REFERENCE_UPLOAD_REMOVED',
      message: LEGACY_UPLOAD_REMOVED_MESSAGE,
      path: legacy.path,
      action: 'recapture_reference_detail_source'
    });
    if (isPlainObject(input) && own(input, 'schema') === FORMAL_SOURCE_SCHEMA) return deepFreeze({
      ok: true,
      legacy: false,
      code: 'FORMAL_SOURCE_ACCEPTED',
      message: '',
      path: '$.schema',
      action: ''
    });
    return deepFreeze({
      ok: false,
      legacy: false,
      code: 'FORMAL_SOURCE_REQUIRED',
      message: FORMAL_SOURCE_REQUIRED_MESSAGE,
      path: Array.isArray(input) ? '$' : '$.schema',
      action: 'recapture_reference_detail_source'
    });
  }

  function rejectSourceDiagnostic(diagnostic) {
    if (!diagnostic.ok) fail(diagnostic.code, diagnostic.message, diagnostic.path);
  }

  function importSourceSnapshot(input, options) {
    var diagnostic = sourceMigrationDiagnostic(input);
    rejectSourceDiagnostic(diagnostic);
    var contract = requireContract(options && options.contract);
    var snapshot = contract.sanitizeSourceSnapshot(input, options && options.contractOptions);
    if (!snapshot || snapshot.schema !== FORMAL_SOURCE_SCHEMA) {
      fail('FORMAL_SOURCE_REQUIRED', FORMAL_SOURCE_REQUIRED_MESSAGE, '$.schema');
    }
    return snapshot;
  }

  function ensureSnapshot(input, options) {
    return importSourceSnapshot(input, options || {});
  }

  function blockProjection(block) {
    return {
      blockId: block.blockId,
      originalIndex: block.originalIndex,
      type: block.type,
      salesRole: block.salesRole,
      sourceSummary: block.sourceSummary,
      text: block.text,
      assetIds: block.assetIds.slice(),
      assetSlices: (block.assetSlices || []).map(function (slice) {
        return {
          assetId: slice.assetId,
          cropX: slice.cropX, cropY: slice.cropY,
          cropWidth: slice.cropWidth, cropHeight: slice.cropHeight,
          sourceWidth: slice.sourceWidth, sourceHeight: slice.sourceHeight
        };
      }),
      factIds: block.factIds.slice(),
      completeness: block.completeness
    };
  }

  function createOrderedChunks(snapshotInput, options) {
    options = options || {};
    var contract = requireContract(options.contract);
    var snapshot = ensureSnapshot(snapshotInput, options);
    var minSize = Number.isSafeInteger(options.minSize) ? options.minSize : MIN_CHUNK_SIZE;
    var maxSize = Number.isSafeInteger(options.maxSize) ? options.maxSize : MAX_CHUNK_SIZE;
    if (minSize < MIN_CHUNK_SIZE || maxSize < minSize || maxSize > MAX_CHUNK_SIZE) {
      fail('INVALID_CHUNK_SIZE', '参考成详分析分片必须使用 4–6 块边界；仅总来源不足 4 块时允许短分片。', '$options');
    }
    var blocks = snapshot.orderedBlocks;
    if (!blocks.length) return deepFreeze([]);
    var chunkCount = Math.ceil(blocks.length / maxSize);
    var baseSize = Math.floor(blocks.length / chunkCount);
    var extra = blocks.length % chunkCount;
    var cursor = 0;
    var chunks = [];

    for (var chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
      var ownedSize = baseSize + (chunkIndex < extra ? 1 : 0);
      var ownedStart = cursor;
      var ownedEnd = cursor + ownedSize;
      cursor = ownedEnd;
      var analysisStart = ownedStart;
      var analysisEnd = ownedEnd;
      while (analysisEnd - analysisStart < minSize && (analysisStart > 0 || analysisEnd < blocks.length)) {
        if (analysisStart > 0) analysisStart -= 1;
        else if (analysisEnd < blocks.length) analysisEnd += 1;
      }
      var analysisBlocks = blocks.slice(analysisStart, analysisEnd);
      var ownedBlocks = blocks.slice(ownedStart, ownedEnd);
      var identity = {
        snapshotId: snapshot.snapshotId,
        chunkIndex: chunkIndex,
        sourceBlockIds: analysisBlocks.map(function (block) { return block.blockId; }),
        ownedSourceBlockIds: ownedBlocks.map(function (block) { return block.blockId; })
      };
      chunks.push({
        chunkId: stableHash(identity, 'rdchunk_', contract),
        chunkIndex: chunkIndex,
        sourceSnapshotId: snapshot.snapshotId,
        startOriginalIndex: analysisBlocks[0].originalIndex,
        endOriginalIndex: analysisBlocks[analysisBlocks.length - 1].originalIndex,
        sourceBlockIds: identity.sourceBlockIds,
        ownedSourceBlockIds: identity.ownedSourceBlockIds,
        blocks: analysisBlocks.map(blockProjection)
      });
    }
    return deepFreeze(chunks);
  }

  function sourceMaps(snapshot) {
    var blockById = Object.create(null);
    var assetById = Object.create(null);
    var factById = Object.create(null);
    snapshot.orderedBlocks.forEach(function (block) { blockById[block.blockId] = block; });
    snapshot.assets.forEach(function (asset) { assetById[asset.assetId] = asset; });
    snapshot.facts.forEach(function (fact) { factById[fact.factId] = fact; });
    return { blockById: blockById, assetById: assetById, factById: factById };
  }

  function sourceRiskFlags(blocks, maps) {
    var flags = ['COPY_REWRITE_REQUIRED', 'ORIGINAL_REWRITE_REQUIRED'];
    var sourceText = '';
    blocks.forEach(function (block) {
      sourceText += ' ' + (block.sourceSummary || '') + ' ' + (block.text || '');
      if (block.completeness === 'partial') flags.push('SOURCE_PARTIAL');
      if (block.completeness === 'unknown') flags.push('SOURCE_UNKNOWN');
      if (block.completeness === 'blocked') flags.push('SOURCE_BLOCKED');
      if (block.factIds.length) flags.push('SOURCE_FACT_REFERENCE_ONLY');
      block.assetIds.forEach(function (assetId) {
        if (maps.assetById[assetId]) flags.push('REFERENCE_ONLY_ASSET', 'REPLACEMENT_REQUIRED');
      });
    });
    var patterns = [
      [/价格|售价|到手价|券后|¥|￥|price/i, 'COMPETITOR_PRICE_CLAIM'],
      [/销量|已售|月销|成交|sales/i, 'COMPETITOR_SALES_CLAIM'],
      [/评价|好评|买家秀|review/i, 'COMPETITOR_REVIEW_CLAIM'],
      [/检测|检验|报告|test(?:ed|ing)?/i, 'COMPETITOR_TEST_CLAIM'],
      [/资质|认证|证书|专利|certif/i, 'COMPETITOR_CERTIFICATION_CLAIM'],
      [/品牌|商标|logo|brand/i, 'COMPETITOR_BRAND_ASSET'],
      [/模特|人物|肖像|明星|代言|person|model|celebrity/i, 'COMPETITOR_PERSON_ASSET']
    ];
    patterns.forEach(function (entry) { if (entry[0].test(sourceText)) flags.push(entry[1]); });
    return unique(flags).sort();
  }

  function sourceAssetSlots(blocks, maps, contract) {
    var ids = [];
    blocks.forEach(function (block) { ids = ids.concat(block.assetIds); });
    return unique(ids).map(function (assetId, index) {
      var asset = maps.assetById[assetId];
      return {
        slotId: stableHash({ sourceAssetId: assetId, index: index, lineage: blocks.map(function (block) { return block.blockId; }) }, 'rdslot_', contract),
        role: asset ? asset.role : 'unknown',
        sourceAssetId: assetId,
        productAssetId: null,
        rightsStatus: 'reference_only',
        directUseAllowed: false,
        replacementRequired: true,
        required: true
      };
    });
  }

  function derivedSourceFactBindings(blocks, moduleId, contract) {
    var factIds = unique([].concat.apply([], blocks.map(function (block) { return block.factIds || []; })));
    return factIds.map(function (sourceFactId, index) {
      return {
        bindingId: stableHash({ workingModuleId: moduleId, sourceFactId: sourceFactId, index: index }, 'rdwbind_', contract),
        sourceFactId: sourceFactId,
        targetField: '',
        required: true
      };
    });
  }

  function fallbackModule(snapshot, sourceBlockIds, options) {
    options = options || {};
    var contract = requireContract(options.contract);
    var maps = options.maps || sourceMaps(snapshot);
    var blocks = sourceBlockIds.map(function (id) { return maps.blockById[id]; }).filter(Boolean)
      .sort(function (a, b) { return a.originalIndex - b.originalIndex; });
    if (!blocks.length) fail('MISSING_SOURCE_BLOCK', '确定性兜底模块必须绑定至少一个来源块。', '$sourceBlockIds');
    var lineage = blocks.map(function (block) { return block.blockId; });
    var moduleId = options.moduleId || (lineage.length === 1 && !options.variant
      ? lineage[0]
      : stableHash({ snapshotId: snapshot.snapshotId, sourceBlockIds: lineage, variant: options.variant || 'fallback' }, 'rdm_', contract));
    var summaries = unique(blocks.map(function (block) { return block.sourceSummary || ''; }).filter(Boolean));
    var sourceCopy = blocks.map(function (block) { return block.text || ''; }).filter(Boolean).join('\n');
    var salesRole = blocks[0].salesRole || 'unknown';
    return {
      moduleId: moduleId,
      blockId: moduleId,
      sourceBlockId: lineage.length === 1 ? lineage[0] : '',
      sourceBlockIds: lineage,
      originalIndex: blocks[0].originalIndex,
      order: Number.isSafeInteger(options.order) ? options.order : blocks[0].originalIndex,
      type: blocks.length === 1 ? blocks[0].type : 'mixed',
      salesRole: salesRole,
      sourceSummary: text(summaries.join('；') || ('来源块 ' + (blocks[0].originalIndex + 1)), MAX_MODEL_SHORT_TEXT),
      sourceCopy: text(sourceCopy, MAX_MODEL_TEXT),
      editableCopy: { headline: '', body: '', bullets: [], cta: '' },
      visualBrief: {
        description: fallbackDirectionForRole(salesRole),
        layout: '', mood: '', shotType: '', subjectPlacement: '', background: '', lighting: '',
        palette: [], textZones: [], density: '', transition: '', mustKeep: [],
        avoid: ['不得复用来源原图、原文、品牌、Logo、人物或未经自家事实支持的主张']
      },
      sourceFactBindings: derivedSourceFactBindings(blocks, moduleId, contract),
      factBindings: [],
      sourceFactCandidateIds: unique([].concat.apply([], blocks.map(function (block) { return block.factIds; }))),
      assetSlots: sourceAssetSlots(blocks, maps, contract),
      targetAssetDrafts: [],
      selected: blocks.some(function (block) { return block.completeness !== 'blocked'; }),
      locked: false,
      riskFlags: sourceRiskFlags(blocks, maps),
      provenance: { kind: 'deterministic_fallback', chunkId: options.chunkId || '', chunkIndex: Number.isSafeInteger(options.chunkIndex) ? options.chunkIndex : -1 }
    };
  }

  function createFallbackModules(snapshotInput, sourceBlockIds, options) {
    options = options || {};
    var snapshot = ensureSnapshot(snapshotInput, options);
    var maps = sourceMaps(snapshot);
    var ids = idList(sourceBlockIds && sourceBlockIds.length ? sourceBlockIds : snapshot.orderedBlocks.map(function (block) { return block.blockId; }));
    return deepFreeze(ids.filter(function (id) { return !!maps.blockById[id]; }).map(function (id, index) {
      return fallbackModule(snapshot, [id], { contract: options.contract, maps: maps, order: index, chunkId: options.chunkId, chunkIndex: options.chunkIndex });
    }));
  }

  function sourceStringsForModule(module, maps) {
    var values = [];
    module.sourceBlockIds.forEach(function (id) {
      var block = maps.blockById[id];
      if (block) values.push(block.text, block.sourceSummary);
    });
    return values.map(function (item) { return text(item, MAX_MODEL_TEXT).replace(/\s+/g, ' ').trim(); }).filter(Boolean);
  }

  function copyValueGuard(value, sourceStrings, max) {
    var clean = text(value, max);
    if (!clean) return { value: '', removed: false };
    var comparable = clean.replace(/\s+/g, ' ').trim();
    var copied = sourceStrings.some(function (source) { return comparable === source; });
    return { value: copied ? '' : clean, removed: copied };
  }

  function normalizeEditableCopy(input, sourceStrings) {
    input = isPlainObject(input) ? input : {};
    var headline = copyValueGuard(own(input, 'headline') != null ? own(input, 'headline') : own(input, 'primaryCopy'), sourceStrings, MAX_MODEL_SHORT_TEXT);
    var body = copyValueGuard(own(input, 'body') != null ? own(input, 'body') : own(input, 'secondaryCopy'), sourceStrings, MAX_MODEL_TEXT);
    var cta = copyValueGuard(own(input, 'cta'), sourceStrings, MAX_MODEL_SHORT_TEXT);
    var rawBullets = own(input, 'bullets') != null ? own(input, 'bullets') : own(input, 'sellingPoints');
    var bullets = [];
    var removed = headline.removed || body.removed || cta.removed;
    textList(rawBullets, MAX_MODEL_LIST, MAX_MODEL_SHORT_TEXT).forEach(function (item) {
      var guarded = copyValueGuard(item, sourceStrings, MAX_MODEL_SHORT_TEXT);
      if (guarded.removed) removed = true;
      else if (guarded.value) bullets.push(guarded.value);
    });
    return {
      value: { headline: headline.value, body: body.value, bullets: unique(bullets), cta: cta.value },
      removed: removed
    };
  }

  function normalizeVisualBrief(input, fallback) {
    input = isPlainObject(input) ? input : {};
    fallback = fallback || {};
    var description = own(input, 'description') != null ? own(input, 'description') : fallback.description;
    return {
      description: normalizeDirection(description),
      layout: text(own(input, 'layout') != null ? own(input, 'layout') : fallback.layout, MAX_MODEL_SHORT_TEXT),
      mood: text(own(input, 'mood') != null ? own(input, 'mood') : fallback.mood, MAX_MODEL_SHORT_TEXT),
      shotType: text(own(input, 'shotType') != null ? own(input, 'shotType') : fallback.shotType, MAX_MODEL_SHORT_TEXT),
      subjectPlacement: text(own(input, 'subjectPlacement') != null ? own(input, 'subjectPlacement') : fallback.subjectPlacement, MAX_MODEL_SHORT_TEXT),
      background: text(own(input, 'background') != null ? own(input, 'background') : fallback.background, MAX_MODEL_SHORT_TEXT),
      lighting: text(own(input, 'lighting') != null ? own(input, 'lighting') : fallback.lighting, MAX_MODEL_SHORT_TEXT),
      palette: textList(own(input, 'palette') != null ? own(input, 'palette') : fallback.palette, MAX_MODEL_LIST, MAX_MODEL_SHORT_TEXT),
      textZones: textList(own(input, 'textZones') != null ? own(input, 'textZones') : fallback.textZones, MAX_MODEL_LIST, MAX_MODEL_SHORT_TEXT),
      density: text(own(input, 'density') != null ? own(input, 'density') : fallback.density, MAX_MODEL_SHORT_TEXT),
      transition: text(own(input, 'transition') != null ? own(input, 'transition') : fallback.transition, MAX_MODEL_SHORT_TEXT),
      mustKeep: textList(own(input, 'mustKeep') != null ? own(input, 'mustKeep') : fallback.mustKeep, MAX_MODEL_LIST, MAX_MODEL_SHORT_TEXT)
        .filter(function (item) { return !/竞品|来源品牌|商标|logo|原图|原文|来源人物|来源模特/i.test(item); }),
      avoid: unique(textList(fallback.avoid, MAX_MODEL_LIST, MAX_MODEL_SHORT_TEXT)
        .concat(textList(own(input, 'avoid'), MAX_MODEL_LIST, MAX_MODEL_SHORT_TEXT))
        .concat(['不得复用来源品牌、Logo、人物、原图或原文']))
    };
  }

  function normalizeProductFacts(input, contract) {
    var byId = Object.create(null);
    var list = [];
    (Array.isArray(input) ? input : []).forEach(function (fact) {
      if (!isPlainObject(fact)) return;
      var factId = text(own(fact, 'productFactId') || own(fact, 'factId') || own(fact, 'id'), 240);
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(factId) || byId[factId]) return;
      var ownership = text(own(fact, 'ownership') || own(fact, 'owner') || own(fact, 'sourceKind'), 80).toLowerCase();
      var status = text(own(fact, 'status') || own(fact, 'approvalStatus'), 80).toLowerCase();
      var owned = own(fact, 'isOwnProduct') === true || OWNERSHIP_VALUES.indexOf(ownership) >= 0;
      var verified = own(fact, 'verified') === true || own(fact, 'confirmed') === true || VERIFIED_VALUES.indexOf(status) >= 0;
      var normalized = {
        productFactId: factId,
        key: text(own(fact, 'key') || own(fact, 'factKey') || factId, 240),
        label: text(own(fact, 'label') || own(fact, 'name'), MAX_MODEL_SHORT_TEXT),
        owned: owned,
        verified: verified
      };
      byId[factId] = normalized;
      list.push(normalized);
    });
    return { list: list, byId: byId };
  }

  function normalizeProductFactBindings(value, moduleId, productFacts, contract, allowUnverifiedIntent) {
    var facts = normalizeProductFacts(productFacts, contract);
    var seen = Object.create(null);
    var out = [];
    (Array.isArray(value) ? value : []).slice(0, MAX_MODEL_LIST).forEach(function (binding, index) {
      if (!isPlainObject(binding)) return;
      var factId = text(own(binding, 'productFactId') || own(binding, 'factId'), 240);
      var targetField = text(own(binding, 'targetField') || '*', 100);
      var fact = facts.byId[factId];
      if (!fact || !fact.owned || (!fact.verified && allowUnverifiedIntent !== true) || !SAFE_TARGET.test(targetField)) return;
      var bindingId = stableHash({ workingModuleId: moduleId, productFactId: factId, targetField: targetField, index: index }, 'rdwpbind_', contract);
      if (!seen[bindingId]) {
        seen[bindingId] = true;
        out.push({ bindingId: bindingId, productFactId: factId, productFactKey: fact.key, targetField: targetField, required: own(binding, 'required') !== false });
      }
    });
    return out;
  }

  function normalizeTargetAssetDrafts(value, module) {
    var sourceSlotIds = Object.create(null);
    (module.assetSlots || []).forEach(function (slot) { sourceSlotIds[slot.slotId] = true; });
    var seen = Object.create(null);
    var out = [];
    (Array.isArray(value) ? value : []).slice(0, MAX_MODEL_LIST).forEach(function (draft) {
      if (!isPlainObject(draft)) return;
      var sourceSlotId = text(own(draft, 'sourceSlotId'), 240);
      var targetAssetId = text(own(draft, 'targetAssetId') || own(draft, 'productAssetId'), 240);
      if (!sourceSlotIds[sourceSlotId] || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(targetAssetId)) return;
      var key = sourceSlotId + '\u0000' + targetAssetId;
      if (!seen[key]) {
        seen[key] = true;
        out.push({ sourceSlotId: sourceSlotId, targetAssetId: targetAssetId });
      }
    });
    return out;
  }

  function normalizedRiskFlags(value, base) {
    var flags = (base || []).slice();
    (Array.isArray(value) ? value : []).slice(0, MAX_MODEL_LIST).forEach(function (flag) {
      flag = text(flag, 80).toUpperCase();
      if (SAFE_FLAG.test(flag)) flags.push(flag);
    });
    return unique(flags).sort();
  }

  function contiguousOwnedIds(rawIds, chunk, used, positionById) {
    var allowed = Object.create(null);
    chunk.ownedSourceBlockIds.forEach(function (id) { allowed[id] = true; });
    var sorted = unique(rawIds).filter(function (id) { return allowed[id] && !used[id]; })
      .sort(function (a, b) { return positionById[a] - positionById[b]; });
    if (!sorted.length) return [];
    var run = [sorted[0]];
    for (var index = 1; index < sorted.length; index++) {
      if (positionById[sorted[index]] === positionById[run[run.length - 1]] + 1) run.push(sorted[index]);
      else break;
    }
    return run;
  }

  function rawModuleSourceIds(item) {
    if (!isPlainObject(item)) return [];
    var ids = own(item, 'sourceBlockIds') || own(item, 'blockIds');
    if (!Array.isArray(ids)) ids = own(item, 'sourceBlockId') || own(item, 'blockId') ? [own(item, 'sourceBlockId') || own(item, 'blockId')] : [];
    return idList(ids);
  }

  function normalizeChunkResult(snapshotInput, chunk, rawResult, options) {
    options = options || {};
    var contract = requireContract(options.contract);
    var snapshot = ensureSnapshot(snapshotInput, options);
    if (!chunk || chunk.sourceSnapshotId !== snapshot.snapshotId) fail('SOURCE_MISMATCH', '分片与来源快照不匹配。', '$chunk.sourceSnapshotId');
    var maps = sourceMaps(snapshot);
    var positionById = Object.create(null);
    snapshot.orderedBlocks.forEach(function (block, index) { positionById[block.blockId] = index; });
    var payload = isPlainObject(rawResult) && isPlainObject(rawResult.result) ? rawResult.result : rawResult;
    if (isPlainObject(payload) && isPlainObject(payload.blueprint)) payload = payload.blueprint;
    var rawModules = isPlainObject(payload) && Array.isArray(payload.modules) ? payload.modules : [];
    var used = Object.create(null);
    var modules = [];
    var warnings = [];

    rawModules.slice(0, Math.max(MAX_CHUNK_SIZE * 3, chunk.ownedSourceBlockIds.length)).forEach(function (item, modelIndex) {
      if (!isPlainObject(item)) return;
      var lineage = contiguousOwnedIds(rawModuleSourceIds(item), chunk, used, positionById);
      if (!lineage.length) {
        warnings.push({ code: 'MODEL_MODULE_DROPPED', message: '模型模块缺少当前分片内的可信来源块，已忽略。', chunkId: chunk.chunkId });
        return;
      }
      lineage.forEach(function (id) { used[id] = true; });
      var base = fallbackModule(snapshot, lineage, {
        contract: contract, maps: maps, chunkId: chunk.chunkId, chunkIndex: chunk.chunkIndex,
        variant: 'ai:' + modelIndex
      });
      var sourceStrings = sourceStringsForModule(base, maps);
      var copyRaw = isPlainObject(item.editableCopy) ? item.editableCopy : item;
      var editable = normalizeEditableCopy(copyRaw, sourceStrings);
      var riskFlags = base.riskFlags.slice();
      if (editable.removed) riskFlags = normalizedRiskFlags(['SOURCE_COPY_REMOVED', 'COPY_REWRITE_REQUIRED'], riskFlags);
      else if (editable.value.headline || editable.value.body || editable.value.bullets.length || editable.value.cta) {
        riskFlags = riskFlags.filter(function (flag) { return flag !== 'COPY_REWRITE_REQUIRED' && flag !== 'ORIGINAL_REWRITE_REQUIRED'; });
      }
      var moduleId = stableHash({ snapshotId: snapshot.snapshotId, sourceBlockIds: lineage, kind: 'ai' }, 'rdm_', contract);
      modules.push(Object.assign({}, base, {
        moduleId: moduleId,
        blockId: moduleId,
        type: enumOr(own(item, 'type'), contractEnums(contract, 'blockTypes'), base.type),
        salesRole: enumOr(own(item, 'salesRole') || own(item, 'role'), contractEnums(contract, 'salesRoles'), base.salesRole),
        editableCopy: editable.value,
        visualBrief: normalizeVisualBrief(own(item, 'visualBrief'), base.visualBrief),
        factBindings: base.factBindings,
        riskFlags: riskFlags,
        provenance: { kind: 'ai', chunkId: chunk.chunkId, chunkIndex: chunk.chunkIndex }
      }));
    });

    chunk.ownedSourceBlockIds.forEach(function (blockId) {
      if (!used[blockId]) {
        modules.push(fallbackModule(snapshot, [blockId], {
          contract: contract, maps: maps, chunkId: chunk.chunkId, chunkIndex: chunk.chunkIndex,
          order: positionById[blockId]
        }));
      }
    });
    modules.sort(function (a, b) { return a.originalIndex - b.originalIndex || a.moduleId.localeCompare(b.moduleId); });
    modules = modules.map(function (module, index) { return Object.assign({}, module, { order: index }); });
    var aiCount = modules.filter(function (module) { return module.provenance.kind === 'ai'; }).length;
    return deepFreeze({
      chunkId: chunk.chunkId,
      chunkIndex: chunk.chunkIndex,
      sourceSnapshotId: snapshot.snapshotId,
      status: aiCount === 0 ? 'fallback' : (modules.some(function (module) { return module.provenance.kind !== 'ai'; }) ? 'partial' : 'ai'),
      modules: modules,
      warnings: warnings
    });
  }

  function synthesisEntry(module) {
    return { moduleId: module.moduleId, salesRole: module.salesRole, sourceBlockIds: module.sourceBlockIds.slice() };
  }

  function synthesizeGlobalSalesLogic(modules, rawGlobal) {
    modules = Array.isArray(modules) ? modules.slice().sort(function (a, b) { return a.order - b.order || a.originalIndex - b.originalIndex; }) : [];
    var buckets = { pain: [], benefit: [], proof: [], objection: [], conversion: [] };
    modules.forEach(function (module) {
      var entry = synthesisEntry(module);
      if (module.salesRole === 'pain') buckets.pain.push(entry);
      if (['benefit', 'feature', 'scene', 'detail', 'usage'].indexOf(module.salesRole) >= 0) buckets.benefit.push(entry);
      if (['proof', 'spec', 'size'].indexOf(module.salesRole) >= 0) buckets.proof.push(entry);
      if (['comparison', 'faq', 'service'].indexOf(module.salesRole) >= 0) buckets.objection.push(entry);
      if (['cta', 'hero'].indexOf(module.salesRole) >= 0) buckets.conversion.push(entry);
    });
    var stageNames = ['pain', 'benefit', 'proof', 'objection', 'conversion'];
    var present = stageNames.filter(function (key) { return buckets[key].length > 0; });
    return deepFreeze({
      sequence: modules.map(synthesisEntry),
      pain: buckets.pain,
      benefit: buckets.benefit,
      proof: buckets.proof,
      objection: buckets.objection,
      conversion: buckets.conversion,
      narrative: present.join(' -> '),
      analysisSummary: '',
      completeness: present.length === stageNames.length ? 'complete' : (modules.length ? 'partial' : 'blocked')
    });
  }

  function responseLookup(responses) {
    var byId = Object.create(null);
    if (Array.isArray(responses)) {
      responses.forEach(function (response) {
        if (!isPlainObject(response)) return;
        // expectedChunkId 必须由调用方的本地调度器附加；模型自报 chunkId 不可信。
        var chunkId = text(own(response, 'expectedChunkId'), 240);
        if (chunkId && !byId[chunkId]) byId[chunkId] = response;
      });
    } else if (isPlainObject(responses)) {
      Object.keys(responses).forEach(function (chunkId) { byId[chunkId] = responses[chunkId]; });
    }
    return byId;
  }

  function mergeChunkResults(snapshotInput, chunksInput, responses, options) {
    options = options || {};
    var snapshot = ensureSnapshot(snapshotInput, options);
    var chunks = Array.isArray(chunksInput) ? chunksInput.slice() : createOrderedChunks(snapshot, options);
    chunks.sort(function (a, b) { return a.chunkIndex - b.chunkIndex; });
    var lookup = responseLookup(responses);
    var normalizedChunks = [];
    var modules = [];
    var warnings = [];

    chunks.forEach(function (chunk) {
      var response = lookup[chunk.chunkId];
      var normalized = normalizeChunkResult(snapshot, chunk, response || {}, options);
      normalizedChunks.push(normalized);
      modules = modules.concat(normalized.modules);
      warnings = warnings.concat(normalized.warnings);
      if (!response) warnings.push({ code: 'CHUNK_FALLBACK', message: '分片缺失，已使用确定性兜底。', chunkId: chunk.chunkId });
    });
    modules.sort(function (a, b) { return a.originalIndex - b.originalIndex || a.order - b.order || a.moduleId.localeCompare(b.moduleId); });
    modules = modules.map(function (module, index) { return Object.assign({}, module, { order: index }); });
    var statuses = normalizedChunks.map(function (chunk) { return chunk.status; });
    var buildStatus = statuses.every(function (status) { return status === 'ai'; }) ? 'complete'
      : (statuses.every(function (status) { return status === 'fallback'; }) ? 'fallback' : 'partial');
    return deepFreeze({
      sourceSnapshotId: snapshot.snapshotId,
      modules: modules,
      chunks: normalizedChunks,
      globalSalesLogic: synthesizeGlobalSalesLogic(modules, options.globalSalesLogic),
      buildStatus: buildStatus,
      warnings: warnings
    });
  }

  function workingEnvelope(snapshot, modules, options) {
    options = options || {};
    var contract = requireContract(options.contract);
    var revision = Number.isSafeInteger(options.revision) && options.revision > 0 ? options.revision : 1;
    var createdAt = text(options.createdAt || snapshot.source.capturedAt, 80);
    var updatedAt = text(options.updatedAt || createdAt, 80);
    modules = modules.slice().sort(function (a, b) { return a.order - b.order || a.originalIndex - b.originalIndex; })
      .map(function (module, index) {
        var normalized = Object.assign({}, module, { order: index });
        normalized.visualBrief = normalizeVisualBrief(module.visualBrief, {
          description: fallbackDirectionForRole(module.salesRole),
          layout: '', mood: '', shotType: '', subjectPlacement: '', background: '', lighting: '',
          palette: [], textZones: [], density: '', transition: '', mustKeep: [], avoid: []
        });
        return normalized;
      });
    var blueprintId = options.blueprintId || stableHash(snapshot.snapshotId, 'rdp_', contract);
    // 只有经过合同 against-source + revision envelope 校验的恢复路径才会传入 trustedApprovalStatus。
    var approvalStatus = options.trustedApprovalStatus === 'approved' ? 'approved' : 'draft';
    var approval = approvalStatus === 'approved' && isPlainObject(options.trustedApproval)
      ? cloneJson(options.trustedApproval)
      : { approvedAt: '', verificationId: '', productFactCardIds: [] };
    var revisionId = stableHash({ blueprintId: blueprintId, revision: revision, modules: modules.map(function (module) {
      return {
        moduleId: module.moduleId,
        sourceBlockIds: module.sourceBlockIds,
        order: module.order,
        selected: module.selected,
        locked: module.locked,
        editableCopy: module.editableCopy,
        visualBrief: module.visualBrief
      };
    }) }, 'rdrev_', contract);
    return deepFreeze({
      schema: WORKING_SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      blueprintId: blueprintId,
      sourceSnapshotId: snapshot.snapshotId,
      sourceDigest: snapshot.snapshotId,
      revision: revision,
      revisionId: revisionId,
      approvalStatus: approvalStatus,
      approval: approval,
      createdAt: createdAt,
      updatedAt: updatedAt,
      sourceOrder: snapshot.orderedBlocks.map(function (block) { return block.blockId; }),
      modules: modules,
      globalSalesLogic: synthesizeGlobalSalesLogic(modules, options.globalSalesLogic),
      buildStatus: options.buildStatus || 'fallback',
      warnings: Array.isArray(options.warnings) ? cloneJson(options.warnings) : [],
      operationLog: Array.isArray(options.operationLog) ? cloneJson(options.operationLog) : []
    });
  }

  function createDeterministicFallback(snapshotInput, options) {
    options = options || {};
    var snapshot = ensureSnapshot(snapshotInput, options);
    var modules = createFallbackModules(snapshot, null, options);
    return workingEnvelope(snapshot, modules, Object.assign({}, options, {
      approvalStatus: 'draft',
      buildStatus: 'fallback',
      warnings: (snapshot.warnings || []).concat(snapshot.completeness.overall === 'complete' ? [] : [{
        code: 'SOURCE_' + String(snapshot.completeness.overall).toUpperCase(),
        message: '来源不完整，兜底蓝图已保留全部可用块，生成前需人工确认。'
      }])
    }));
  }

  function createWorkingBlueprint(snapshotInput, options) {
    options = options || {};
    var snapshot = ensureSnapshot(snapshotInput, options);
    if (!options.chunkResults) return createDeterministicFallback(snapshot, options);
    var chunks = Array.isArray(options.chunks) ? options.chunks : createOrderedChunks(snapshot, options);
    var merged = mergeChunkResults(snapshot, chunks, options.chunkResults, options);
    return workingEnvelope(snapshot, merged.modules, Object.assign({}, options, {
      approvalStatus: 'draft',
      buildStatus: merged.buildStatus,
      warnings: (snapshot.warnings || []).concat(merged.warnings),
      globalSalesLogic: merged.globalSalesLogic
    }));
  }

  function ensureWorking(working, snapshot) {
    var legacy = removedUploadMarker(working);
    if (legacy) fail('LEGACY_REFERENCE_UPLOAD_REMOVED', LEGACY_UPLOAD_REMOVED_MESSAGE, legacy.path);
    if (!isPlainObject(working) || working.schema !== WORKING_SCHEMA || !Array.isArray(working.modules) || !Number.isSafeInteger(working.revision)) {
      fail('INVALID_WORKING_BLUEPRINT', '工作蓝图结构无效。', '$working');
    }
    if (snapshot && working.sourceSnapshotId !== snapshot.snapshotId) fail('SOURCE_MISMATCH', '工作蓝图与来源快照不匹配。', '$working.sourceSnapshotId');
    return working;
  }

  function moduleById(modules, moduleId) {
    for (var index = 0; index < modules.length; index++) if (modules[index].moduleId === moduleId) return modules[index];
    return null;
  }

  function patchModule(module, patch, snapshot, options) {
    patch = isPlainObject(patch) ? patch : {};
    var contract = requireContract(options.contract);
    var maps = sourceMaps(snapshot);
    var next = cloneJson(module);
    if (own(patch, 'type') != null) next.type = enumOr(patch.type, contractEnums(contract, 'blockTypes'), module.type);
    if (own(patch, 'salesRole') != null) next.salesRole = enumOr(patch.salesRole, contractEnums(contract, 'salesRoles'), module.salesRole);
    if (own(patch, 'editableCopy') != null) next.editableCopy = normalizeEditableCopy(patch.editableCopy, sourceStringsForModule(module, maps)).value;
    if (own(patch, 'visualBrief') != null) next.visualBrief = normalizeVisualBrief(patch.visualBrief, module.visualBrief);
    if (own(patch, 'factBindings') != null) next.factBindings = normalizeProductFactBindings(
      patch.factBindings, module.moduleId, options.productFacts, contract, options.allowUnverifiedFactBindingIntents === true
    );
    if (own(patch, 'targetAssetDrafts') != null) next.targetAssetDrafts = normalizeTargetAssetDrafts(patch.targetAssetDrafts, module);
    if (own(patch, 'selected') != null) next.selected = patch.selected === true;
    next.riskFlags = sourceRiskFlags(next.sourceBlockIds.map(function (id) { return maps.blockById[id]; }).filter(Boolean), maps);
    if (next.editableCopy.headline || next.editableCopy.body || next.editableCopy.bullets.length || next.editableCopy.cta) {
      next.riskFlags = next.riskFlags.filter(function (flag) { return flag !== 'COPY_REWRITE_REQUIRED' && flag !== 'ORIGINAL_REWRITE_REQUIRED'; });
    }
    return next;
  }

  function commitRevision(working, snapshot, modules, operation, options) {
    options = options || {};
    var log = (working.operationLog || []).slice();
    var logEntry = {
      revision: working.revision + 1,
      type: text(operation.type, 80),
      moduleIds: idList(operation.moduleIds || (operation.moduleId ? [operation.moduleId] : []))
    };
    var resultModuleId = text(operation.resultModuleId, 240);
    if (resultModuleId) logEntry.resultModuleId = resultModuleId;
    var resultModuleIds = idList(operation.resultModuleIds);
    if (resultModuleIds.length) logEntry.resultModuleIds = resultModuleIds;
    var operationKey = text(operation.operationKey, 120);
    if (operationKey) logEntry.operationKey = operationKey;
    log.push(logEntry);
    if (log.length > 500) log = log.slice(log.length - 500);
    return workingEnvelope(snapshot, modules, {
      contract: options.contract,
      blueprintId: working.blueprintId,
      revision: working.revision + 1,
      createdAt: working.createdAt,
      updatedAt: options.updatedAt || working.updatedAt,
      approvalStatus: 'draft',
      buildStatus: working.buildStatus,
      warnings: working.warnings,
      operationLog: log
    });
  }

  function applyRevision(workingInput, operation, snapshotInput, options) {
    options = options || {};
    var snapshot = ensureSnapshot(snapshotInput, options);
    var working = ensureWorking(workingInput, snapshot);
    if (!isPlainObject(operation)) fail('INVALID_OPERATION', '修订操作必须是普通对象。', '$operation');
    var type = text(operation.type, 80);
    var modules = cloneJson(working.modules);
    var target;
    var index;
    var resultModuleId = '';
    var resultModuleIds = [];
    var normalizedOperationModuleIds = null;
    var operationKey = '';

    if (type === 'edit') {
      target = moduleById(modules, text(operation.moduleId, 240));
      if (!target) fail('UNKNOWN_MODULE', '要编辑的模块不存在。', '$operation.moduleId');
      if (target.locked) fail('MODULE_LOCKED', '模块已锁定，不能编辑。', '$operation.moduleId');
      modules[modules.indexOf(target)] = patchModule(target, operation.patch, snapshot, options);
    } else if (type === 'select') {
      target = moduleById(modules, text(operation.moduleId, 240));
      if (!target) fail('UNKNOWN_MODULE', '要选择的模块不存在。', '$operation.moduleId');
      target.selected = operation.selected === true;
    } else if (type === 'lock') {
      target = moduleById(modules, text(operation.moduleId, 240));
      if (!target) fail('UNKNOWN_MODULE', '要锁定的模块不存在。', '$operation.moduleId');
      target.locked = operation.locked !== false;
    } else if (type === 'delete') {
      index = modules.findIndex(function (module) { return module.moduleId === text(operation.moduleId, 240); });
      if (index < 0) fail('UNKNOWN_MODULE', '要删除的模块不存在。', '$operation.moduleId');
      if (modules[index].locked) fail('MODULE_LOCKED', '模块已锁定，不能删除。', '$operation.moduleId');
      modules.splice(index, 1);
    } else if (type === 'copy') {
      index = modules.findIndex(function (module) { return module.moduleId === text(operation.moduleId, 240); });
      if (index < 0) fail('UNKNOWN_MODULE', '要复制的模块不存在。', '$operation.moduleId');
      target = cloneJson(modules[index]);
      target.moduleId = stableHash({ blueprintId: working.blueprintId, sourceModuleId: target.moduleId, revision: working.revision + 1, copyIndex: modules.length }, 'rdm_copy_', options.contract);
      target.blockId = target.moduleId;
      target.locked = false;
      target.provenance = { kind: 'user_copy', sourceModuleId: modules[index].moduleId };
      resultModuleId = target.moduleId;
      modules.splice(index + 1, 0, target);
    } else if (type === 'merge') {
      var rawMergeIds = own(operation, 'moduleIds');
      if (!Array.isArray(rawMergeIds) || rawMergeIds.length < 2 || rawMergeIds.some(function (id) { return typeof id !== 'string'; })) {
        fail('INVALID_MODULE_MERGE', '合并必须提供至少两个稳定 moduleId。', '$operation.moduleIds');
      }
      var requestedMergeIds = idList(rawMergeIds);
      if (requestedMergeIds.length !== rawMergeIds.length) {
        fail('INVALID_MODULE_MERGE', '合并 moduleIds 必须有效且不重复。', '$operation.moduleIds');
      }
      var requestedMergeMap = Object.create(null);
      requestedMergeIds.forEach(function (moduleId) { requestedMergeMap[moduleId] = true; });
      var mergeParents = modules.filter(function (module) { return !!requestedMergeMap[module.moduleId]; });
      if (mergeParents.length !== requestedMergeIds.length) {
        fail('UNKNOWN_MODULE', '要合并的模块不存在。', '$operation.moduleIds');
      }
      if (mergeParents.some(function (module) { return module.locked; })) {
        fail('MODULE_LOCKED', '合并范围包含已锁定模块，请先解锁。', '$operation.moduleIds');
      }
      // 调用方输入顺序不可信；父模块和 lineage 始终按当前工作顺序/来源原序规范化。
      normalizedOperationModuleIds = mergeParents.map(function (module) { return module.moduleId; });
      var mergeLineage = unique([].concat.apply([], mergeParents.map(function (module) { return Array.isArray(module.sourceBlockIds) ? module.sourceBlockIds : []; })));
      var sourcePosition = Object.create(null);
      snapshot.orderedBlocks.forEach(function (block, blockIndex) { sourcePosition[block.blockId] = blockIndex; });
      if (!mergeLineage.length || mergeLineage.some(function (blockId) { return !Number.isSafeInteger(sourcePosition[blockId]); })) {
        fail('MISSING_SOURCE_BLOCK', '合并模块的 lineage 必须全部来自当前不可变快照。', '$operation.moduleIds');
      }
      mergeLineage.sort(function (a, b) { return sourcePosition[a] - sourcePosition[b] || a.localeCompare(b); });
      operationKey = 'working_merge_r' + (working.revision + 1) + '_' + stableHash(normalizedOperationModuleIds, '', options.contract).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 48);
      resultModuleId = stableHash({
        blueprintId: working.blueprintId,
        revision: working.revision + 1,
        operationKey: operationKey,
        sourceModuleIds: normalizedOperationModuleIds,
        sourceBlockIds: mergeLineage
      }, 'rdm_intent_', options.contract);
      var mergedModule = fallbackModule(snapshot, mergeLineage, {
        contract: options.contract,
        moduleId: resultModuleId,
        variant: operationKey,
        order: mergeParents[0].order
      });
      var parentRisks = unique([].concat.apply([], mergeParents.map(function (module) { return module.riskFlags || []; })));
      mergedModule.type = mergeParents.every(function (module) { return module.type === mergeParents[0].type; }) ? mergeParents[0].type : 'mixed';
      mergedModule.salesRole = mergeParents.every(function (module) { return module.salesRole === mergeParents[0].salesRole; }) ? mergeParents[0].salesRole : 'unknown';
      mergedModule.editableCopy = { headline: '', body: '', bullets: [], cta: '' };
      mergedModule.visualBrief = normalizeVisualBrief({}, mergedModule.visualBrief);
      mergedModule.factBindings = [];
      mergedModule.targetAssetDrafts = [];
      mergedModule.selected = mergeParents.every(function (module) { return module.selected !== false; });
      mergedModule.locked = false;
      mergedModule.riskFlags = normalizedRiskFlags(['WORKING_MERGE', 'COPY_REWRITE_REQUIRED', 'ORIGINAL_REWRITE_REQUIRED'], mergedModule.riskFlags.concat(parentRisks));
      mergedModule.provenance = {
        kind: 'user_merge_intent',
        sourceModuleIds: normalizedOperationModuleIds.slice(),
        operationKey: operationKey
      };
      var firstMergeIndex = modules.indexOf(mergeParents[0]);
      modules = modules.filter(function (module) { return !requestedMergeMap[module.moduleId]; });
      var insertionIndex = working.modules.slice(0, firstMergeIndex).filter(function (module) { return !requestedMergeMap[module.moduleId]; }).length;
      modules.splice(insertionIndex, 0, mergedModule);
    } else if (type === 'split') {
      index = modules.findIndex(function (module) { return module.moduleId === text(operation.moduleId, 240); });
      if (index < 0) fail('UNKNOWN_MODULE', '要拆分的模块不存在。', '$operation.moduleId');
      target = modules[index];
      if (target.locked) fail('MODULE_LOCKED', '模块已锁定，不能拆分。', '$operation.moduleId');
      var splitLineage = canonicalWorkingLineage(target, snapshot, '$operation.moduleId');
      if (splitLineage.length < 2) fail('INVALID_MODULE_SPLIT', '只有包含多个来源块的模块才能拆分。', '$operation.moduleId');
      operationKey = 'working_split_r' + (working.revision + 1) + '_' + stableHash({
        sourceModuleId: target.moduleId,
        sourceBlockIds: splitLineage
      }, '', options.contract).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 48);
      var splitParts = splitLineage.map(function (sourceBlockId, splitIndex) {
        return {
          sourceBlockIds: [sourceBlockId],
          operationKey: (operationKey + '_part_' + (splitIndex + 1)).slice(0, 120)
        };
      });
      var splitChildren = splitParts.map(function (part, splitIndex) {
        var childModuleId = stableHash({
          blueprintId: working.blueprintId,
          revision: working.revision + 1,
          sourceModuleId: target.moduleId,
          sourceBlockIds: part.sourceBlockIds,
          operationKey: part.operationKey
        }, 'rdm_split_', options.contract);
        var child = fallbackModule(snapshot, part.sourceBlockIds, {
          contract: options.contract,
          moduleId: childModuleId,
          variant: part.operationKey,
          order: index + splitIndex
        });
        child.selected = target.selected !== false;
        child.locked = false;
        child.editableCopy = { headline: '', body: '', bullets: [], cta: '' };
        child.factBindings = [];
        child.targetAssetDrafts = [];
        child.riskFlags = normalizedRiskFlags(
          ['WORKING_SPLIT', 'COPY_REWRITE_REQUIRED', 'ORIGINAL_REWRITE_REQUIRED'],
          (target.riskFlags || []).concat(child.riskFlags || [])
        );
        child.provenance = {
          kind: 'user_split_intent',
          sourceModuleId: target.moduleId,
          sourceModuleIds: [target.moduleId],
          operationKey: operationKey,
          partOperationKey: part.operationKey,
          splitIndex: splitIndex,
          splitCount: splitParts.length,
          parts: cloneJson(splitParts)
        };
        return child;
      });
      resultModuleIds = splitChildren.map(function (module) { return module.moduleId; });
      resultModuleId = resultModuleIds[0];
      modules.splice.apply(modules, [index, 1].concat(splitChildren));
    } else if (type === 'move') {
      index = modules.findIndex(function (module) { return module.moduleId === text(operation.moduleId, 240); });
      if (index < 0) fail('UNKNOWN_MODULE', '要移动的模块不存在。', '$operation.moduleId');
      var toIndex = Number(operation.toIndex);
      if (!Number.isSafeInteger(toIndex) || toIndex < 0 || toIndex >= modules.length) fail('INVALID_ORDER', '目标排序位置无效。', '$operation.toIndex');
      target = modules.splice(index, 1)[0];
      modules.splice(toIndex, 0, target);
    } else if (type === 'reorder') {
      var order = idList(operation.moduleOrder);
      if (order.length !== modules.length || unique(order).length !== modules.length || order.some(function (id) { return !moduleById(modules, id); })) {
        fail('INVALID_MODULE_ORDER', 'moduleOrder 必须且只能包含全部当前模块。', '$operation.moduleOrder');
      }
      modules = order.map(function (id) { return moduleById(modules, id); });
    } else if (type === 'restore_source_order') {
      modules.sort(function (a, b) { return a.originalIndex - b.originalIndex || a.moduleId.localeCompare(b.moduleId); });
    } else {
      fail('UNKNOWN_OPERATION', '不支持的蓝图修订操作。', '$operation.type');
    }

    modules.forEach(function (module, moduleIndex) { module.order = moduleIndex; });
    return commitRevision(working, snapshot, modules, {
      type: type,
      moduleId: operation.moduleId,
      moduleIds: normalizedOperationModuleIds || (type === 'reorder' ? operation.moduleOrder : undefined),
      resultModuleId: resultModuleId,
      resultModuleIds: resultModuleIds,
      operationKey: operationKey
    }, options);
  }

  function applyRebuildResult(workingInput, snapshotInput, chunks, responses, options) {
    options = options || {};
    var snapshot = ensureSnapshot(snapshotInput, options);
    var working = ensureWorking(workingInput, snapshot);
    if (options.sourceDigest && options.sourceDigest !== snapshot.snapshotId) fail('STALE_SOURCE_RESPONSE', '拆解响应属于旧来源，已拒绝。', '$options.sourceDigest');
    if (Number.isSafeInteger(options.baseRevision) && options.baseRevision !== working.revision) fail('STALE_REVISION_RESPONSE', '拆解响应基于旧修订，已拒绝。', '$options.baseRevision');
    var merged = mergeChunkResults(snapshot, chunks, responses, options);
    var locked = working.modules.filter(function (module) { return module.locked; }).map(cloneJson);
    var lockedSourceIds = Object.create(null);
    locked.forEach(function (module) { module.sourceBlockIds.forEach(function (id) { lockedSourceIds[id] = true; }); });
    var modules = merged.modules.filter(function (module) {
      return !module.sourceBlockIds.some(function (id) { return lockedSourceIds[id]; });
    }).map(cloneJson).concat(locked);
    modules.sort(function (a, b) { return a.originalIndex - b.originalIndex || a.moduleId.localeCompare(b.moduleId); });
    modules.forEach(function (module, index) { module.order = index; });
    return commitRevision(working, snapshot, modules, { type: 'rebuild', moduleIds: locked.map(function (module) { return module.moduleId; }) }, Object.assign({}, options, {
      approvalStatus: 'draft'
    }));
  }

  function claimFields(module) {
    var fields = [];
    if (text(module.editableCopy.headline, MAX_MODEL_SHORT_TEXT)) fields.push('headline');
    if (text(module.editableCopy.body, MAX_MODEL_TEXT)) fields.push('body');
    (Array.isArray(module.editableCopy.bullets) ? module.editableCopy.bullets : []).forEach(function (bullet, index) {
      if (text(bullet, MAX_MODEL_SHORT_TEXT)) fields.push('bullets.' + index);
    });
    if (text(module.editableCopy.cta, MAX_MODEL_SHORT_TEXT)) fields.push('cta');
    return fields;
  }

  function copyContentForWorking(editableCopy) {
    editableCopy = isPlainObject(editableCopy) ? editableCopy : {};
    return [editableCopy.headline, editableCopy.body].concat(Array.isArray(editableCopy.bullets) ? editableCopy.bullets : [], [editableCopy.cta])
      .map(function (value) { return text(value, MAX_MODEL_TEXT); }).join(' ').replace(/\s+/g, ' ').trim();
  }

  function bindingCovers(binding, field) {
    var target = text(binding && binding.targetField || '*', 100).replace(/^editableCopy\./, '');
    if (target === '*') return true;
    if (target === field) return true;
    return target === 'bullets' && field.indexOf('bullets.') === 0;
  }

  function trustedAssetRegistry(options) {
    var registry = Object.create(null);
    var combined = [];
    if (Array.isArray(options.verifiedTargetAssets)) combined = combined.concat(options.verifiedTargetAssets);
    if (Array.isArray(options.subjectAssets)) combined = combined.concat(options.subjectAssets);
    combined.forEach(function (asset) {
      if (!isPlainObject(asset)) return;
      var id = text(own(asset, 'targetAssetId') || own(asset, 'productAssetId') || own(asset, 'assetId'), 240);
      var rights = text(own(asset, 'rightsStatus'), 80);
      if (id && (rights === 'authorized' || rights === 'self_owned')) registry[id] = { assetId: id, rightsStatus: rights };
    });
    return registry;
  }

  function trustedFactKeyRegistry(options) {
    var keys = Object.create(null);
    var cards = Object.create(null);
    var normalized = normalizeProductFacts(options.productFacts, options.contract);
    normalized.list.forEach(function (fact) {
      if (fact.owned && fact.verified && fact.key) keys[fact.key] = true;
    });
    (Array.isArray(options.verifiedProductFactCards) ? options.verifiedProductFactCards : []).forEach(function (card) {
      if (!isPlainObject(card)) return;
      var cardId = text(own(card, 'productFactCardId'), 240);
      var verificationId = text(own(card, 'verificationId'), 240);
      if (!cardId || !verificationId || !Array.isArray(card.factKeys)) return;
      cards[cardId] = true;
      card.factKeys.forEach(function (key) {
        key = text(key, 240);
        if (key) keys[key] = true;
      });
    });
    return { keys: keys, cards: cards, normalizedFacts: normalized };
  }

  function validateScreenCount(value) {
    var count = Number(value);
    if (!Number.isSafeInteger(count) || count < MIN_SCREEN_COUNT || count > MAX_SCREEN_COUNT) {
      fail('INVALID_SCREEN_COUNT', '参考成详输出屏数必须在 5–16。', '$screenCount');
    }
    return count;
  }

  function validateGenerationGate(workingInput, snapshotInput, options) {
    options = options || {};
    var snapshot = ensureSnapshot(snapshotInput, options);
    var working = ensureWorking(workingInput, snapshot);
    var errors = [];
    var warnings = [];
    var trustedFacts = trustedFactKeyRegistry(options);
    var validFactKeys = Object.keys(trustedFacts.keys).sort();
    var validFactIds = trustedFacts.normalizedFacts.list.filter(function (fact) { return fact.owned && fact.verified; })
      .map(function (fact) { return fact.productFactId; });
    var validFactMap = Object.create(null);
    validFactIds.forEach(function (id) { validFactMap[id] = true; });
    var assetRegistry = trustedAssetRegistry(options);
    var selected = working.modules.filter(function (module) { return module.selected; });

    try { validateScreenCount(options.screenCount == null ? Math.max(MIN_SCREEN_COUNT, Math.min(MAX_SCREEN_COUNT, selected.length || MIN_SCREEN_COUNT)) : options.screenCount); }
    catch (error) { errors.push({ code: error.code, message: error.message, path: error.path }); }
    if (!selected.length) errors.push({ code: 'NO_SELECTED_MODULE', message: '至少选择一个蓝图模块后才能生成。', path: '$.modules' });
    if (options.requireApproval !== false && working.approvalStatus !== 'approved') {
      errors.push({ code: 'BLUEPRINT_NOT_APPROVED', message: '蓝图尚未通过显式审核，不能进入生成。', path: '$.approvalStatus' });
    }
    if (options.requireSubjectAsset !== false && !Object.keys(assetRegistry).length) {
      errors.push({ code: 'SUBJECT_ASSET_NOT_AUTHORIZED', message: '至少需要一张已授权或自有的商品主体图。', path: '$.subjectAssets' });
    }

    var maps = sourceMaps(snapshot);
    selected.forEach(function (module, moduleIndex) {
      var sourceStrings = sourceStringsForModule(module, maps);
      var rawDirectionValue = module.visualBrief && module.visualBrief.description;
      var rawDirection = typeof rawDirectionValue === 'string' ? rawDirectionValue : '';
      var canonicalDirection = normalizeDirection(rawDirection);
      if (!rawDirection.trim()) {
        errors.push({
          code: 'SCREEN_DIRECTION_REQUIRED',
          message: '每个所选模块必须填写一句本屏核心内容与描述方向。',
          path: '$.modules[' + moduleIndex + '].visualBrief.description',
          moduleId: module.moduleId
        });
      } else if (rawDirection !== canonicalDirection || rawDirection.length > MAX_DIRECTION_TEXT || /[\r\n]/.test(rawDirection)) {
        errors.push({
          code: 'SCREEN_DIRECTION_INVALID',
          message: '本屏描述方向必须是 1–160 字的单行一句话。',
          path: '$.modules[' + moduleIndex + '].visualBrief.description',
          moduleId: module.moduleId
        });
      }
      var claims = claimFields(module);
      claims.forEach(function (field) {
        var value;
        if (field === 'headline' || field === 'body' || field === 'cta') value = module.editableCopy[field];
        else value = module.editableCopy.bullets[Number(field.split('.')[1])];
        var normalized = text(value, MAX_MODEL_TEXT).replace(/\s+/g, ' ').trim();
        if (sourceStrings.indexOf(normalized) >= 0) {
          errors.push({ code: 'SOURCE_COPY_NOT_REWRITTEN', message: '生成文案不能直接复用来源原文。', path: '$.modules[' + moduleIndex + '].editableCopy.' + field, moduleId: module.moduleId });
        }
        var hasBinding = (module.factBindings || []).some(function (binding) {
          return !!validFactMap[binding.productFactId] && bindingCovers(binding, field);
        });
        if (!hasBinding) {
          errors.push({ code: 'UNBOUND_PRODUCT_CLAIM', message: '每项生成文案必须绑定已确认的自家商品事实。', path: '$.modules[' + moduleIndex + '].editableCopy.' + field, moduleId: module.moduleId });
        }
      });
      (module.assetSlots || []).forEach(function (slot, slotIndex) {
        if (slot.sourceAssetId) {
          if (!maps.assetById[slot.sourceAssetId]) {
            errors.push({ code: 'UNKNOWN_SOURCE_ASSET', message: '素材槽引用了不存在的来源素材。', path: '$.modules[' + moduleIndex + '].assetSlots[' + slotIndex + ']' });
          }
          if (slot.rightsStatus !== 'reference_only' || slot.directUseAllowed !== false || slot.replacementRequired !== true) {
            errors.push({ code: 'REFERENCE_ONLY_GATE', message: '来源素材只能作为 reference_only 参考，必须替换为自家主体素材。', path: '$.modules[' + moduleIndex + '].assetSlots[' + slotIndex + ']' });
          }
          if (slot.required && slot.replacementRequired && options.requireAssetSlotBindings !== false) {
            var draft = (module.targetAssetDrafts || []).find(function (item) { return item.sourceSlotId === slot.slotId; });
            if (!draft) {
              errors.push({ code: 'ASSET_REPLACEMENT_REQUIRED', message: '每个受限来源素材槽必须绑定经核验的自家目标素材。', path: '$.modules[' + moduleIndex + '].assetSlots[' + slotIndex + ']' });
            } else if (!assetRegistry[draft.targetAssetId]) {
              errors.push({ code: 'UNVERIFIED_TARGET_ASSET', message: '目标素材未出现在可信素材 registry。', path: '$.modules[' + moduleIndex + '].targetAssetDrafts' });
            }
          }
        }
      });
    });
    if (snapshot.completeness.overall !== 'complete') warnings.push({
      code: 'SOURCE_' + snapshot.completeness.overall.toUpperCase(),
      message: '来源快照不完整，生成前应逐项复核来源警告。', path: '$.source.completeness'
    });
    return deepFreeze({ ok: errors.length === 0, errors: errors, warnings: warnings, validProductFactIds: validFactIds, validProductFactKeys: validFactKeys });
  }

  function selectedModulesInOrder(working) {
    return working.modules.filter(function (module) { return module.selected; })
      .slice().sort(function (a, b) { return a.order - b.order || a.originalIndex - b.originalIndex || a.moduleId.localeCompare(b.moduleId); });
  }

  function mergeEditableCopy(modules) {
    var copies = modules.map(function (module) { return module.editableCopy || {}; });
    return {
      headline: copies.map(function (copy) { return text(copy.headline, MAX_MODEL_SHORT_TEXT); }).filter(Boolean)[0] || '',
      body: unique(copies.map(function (copy) { return text(copy.body, MAX_MODEL_TEXT); }).filter(Boolean)).join('\n'),
      bullets: unique([].concat.apply([], copies.map(function (copy) { return textList(copy.bullets, MAX_MODEL_LIST, MAX_MODEL_SHORT_TEXT); }))),
      cta: copies.map(function (copy) { return text(copy.cta, MAX_MODEL_SHORT_TEXT); }).filter(Boolean).slice(-1)[0] || ''
    };
  }

  function mergeFactBindingInputs(modules, editableCopy) {
    var seen = Object.create(null);
    var inputs = [];
    modules.forEach(function (module) {
      (module.factBindings || []).forEach(function (binding) {
        var productFactId = text(binding.productFactId, 240);
        var targetField = text(binding.targetField || '*', 100).replace(/^editableCopy\./, '');
        var moduleCopy = module.editableCopy || {};
        if (/^bullets\.\d+$/.test(targetField)) {
          var sourceBullet = text((moduleCopy.bullets || [])[Number(targetField.split('.')[1])], MAX_MODEL_SHORT_TEXT);
          var mergedBulletIndex = editableCopy.bullets.indexOf(sourceBullet);
          if (!sourceBullet || mergedBulletIndex < 0) return;
          targetField = 'bullets.' + mergedBulletIndex;
        } else if (targetField === 'headline' && text(moduleCopy.headline, MAX_MODEL_SHORT_TEXT) !== editableCopy.headline) {
          return;
        } else if (targetField === 'body' && editableCopy.body.indexOf(text(moduleCopy.body, MAX_MODEL_TEXT)) < 0) {
          return;
        } else if (targetField === 'cta' && text(moduleCopy.cta, MAX_MODEL_SHORT_TEXT) !== editableCopy.cta) {
          return;
        }
        var key = productFactId + '\u0000' + targetField;
        if (productFactId && SAFE_TARGET.test(targetField) && !seen[key]) {
          seen[key] = true;
          inputs.push({ productFactId: productFactId, targetField: targetField, required: binding.required !== false });
        }
      });
    });
    return inputs;
  }

  function mergeVisualBrief(modules) {
    var briefs = modules.map(function (module) { return module.visualBrief || {}; });
    return {
      description: mergedDirection(modules),
      layout: briefs.map(function (brief) { return text(brief.layout, MAX_MODEL_SHORT_TEXT); }).filter(Boolean)[0] || '',
      mood: briefs.map(function (brief) { return text(brief.mood, MAX_MODEL_SHORT_TEXT); }).filter(Boolean)[0] || '',
      shotType: briefs.map(function (brief) { return text(brief.shotType, MAX_MODEL_SHORT_TEXT); }).filter(Boolean)[0] || '',
      subjectPlacement: briefs.map(function (brief) { return text(brief.subjectPlacement, MAX_MODEL_SHORT_TEXT); }).filter(Boolean)[0] || '',
      background: briefs.map(function (brief) { return text(brief.background, MAX_MODEL_SHORT_TEXT); }).filter(Boolean)[0] || '',
      lighting: briefs.map(function (brief) { return text(brief.lighting, MAX_MODEL_SHORT_TEXT); }).filter(Boolean)[0] || '',
      palette: unique([].concat.apply([], briefs.map(function (brief) { return textList(brief.palette, MAX_MODEL_LIST, MAX_MODEL_SHORT_TEXT); }))),
      textZones: unique([].concat.apply([], briefs.map(function (brief) { return textList(brief.textZones, MAX_MODEL_LIST, MAX_MODEL_SHORT_TEXT); }))),
      density: briefs.map(function (brief) { return text(brief.density, MAX_MODEL_SHORT_TEXT); }).filter(Boolean)[0] || '',
      transition: briefs.map(function (brief) { return text(brief.transition, MAX_MODEL_SHORT_TEXT); }).filter(Boolean)[0] || '',
      mustKeep: unique([].concat.apply([], briefs.map(function (brief) { return textList(brief.mustKeep, MAX_MODEL_LIST, MAX_MODEL_SHORT_TEXT); }))),
      avoid: unique([].concat.apply([], briefs.map(function (brief) { return textList(brief.avoid, MAX_MODEL_LIST, MAX_MODEL_SHORT_TEXT); })))
    };
  }

  function mergeTargetAssetDrafts(parents, mergedModule) {
    var targetBySourceAssetId = Object.create(null);
    parents.forEach(function (parent) {
      var slotById = Object.create(null);
      (parent.assetSlots || []).forEach(function (slot) { slotById[slot.slotId] = slot; });
      (parent.targetAssetDrafts || []).forEach(function (draft) {
        var slot = slotById[draft.sourceSlotId];
        if (slot && slot.sourceAssetId && !targetBySourceAssetId[slot.sourceAssetId]) {
          targetBySourceAssetId[slot.sourceAssetId] = draft.targetAssetId;
        }
      });
    });
    return (mergedModule.assetSlots || []).map(function (slot) {
      var targetAssetId = targetBySourceAssetId[slot.sourceAssetId];
      return targetAssetId ? { sourceSlotId: slot.slotId, targetAssetId: targetAssetId } : null;
    }).filter(Boolean);
  }

  function latestResultModuleId(working, expectedType) {
    var entry = (working.operationLog || [])[working.operationLog.length - 1];
    if (!entry || entry.type !== expectedType || !entry.resultModuleId) {
      fail('MATERIALIZATION_REVISION_FAILED', '屏幕物化修订未返回稳定模块 ID。', '$working.operationLog');
    }
    return entry.resultModuleId;
  }

  function canonicalizeSelectedDirections(working, snapshot, options) {
    var current = working;
    var seen = Object.create(null);
    selectedModulesInOrder(current).forEach(function (initialModule, screenIndex) {
      var module = moduleById(current.modules, initialModule.moduleId);
      var baseDirection = normalizeDirection(
        module.visualBrief && module.visualBrief.description,
        fallbackDirectionForRole(module.salesRole)
      );
      var candidate = baseDirection;
      var occurrence = 1;
      while (seen[candidate]) {
        candidate = occurrence <= DIRECTION_VARIANTS.length
          ? directionVariant(baseDirection, occurrence)
          : normalizeDirection(directionBody(baseDirection).slice(0, 118) + '，聚焦第' + (screenIndex + 1) + '屏的独立信息重点');
        occurrence += 1;
      }
      seen[candidate] = true;
      if (module.visualBrief.description !== candidate) {
        current = applyRevision(current, {
          type: 'edit',
          moduleId: module.moduleId,
          patch: { visualBrief: Object.assign({}, module.visualBrief, { description: candidate }) }
        }, snapshot, options);
      }
    });
    return current;
  }

  function materializeScreenBlueprint(workingInput, snapshotInput, targetScreenCount, options) {
    options = options || {};
    var snapshot = ensureSnapshot(snapshotInput, options);
    var current = ensureWorking(workingInput, snapshot);
    var count = validateScreenCount(targetScreenCount);
    var selected = selectedModulesInOrder(current);
    if (!selected.length) fail('NO_SELECTED_MODULE', '至少选择一个蓝图模块。', '$.modules');

    if (selected.length > count) {
      var mergeGroups = [];
      var baseSize = Math.floor(selected.length / count);
      var extra = selected.length % count;
      var cursor = 0;
      for (var groupIndex = 0; groupIndex < count; groupIndex++) {
        var groupSize = baseSize + (groupIndex < extra ? 1 : 0);
        mergeGroups.push(selected.slice(cursor, cursor + groupSize).map(function (module) { return module.moduleId; }));
        cursor += groupSize;
      }
      mergeGroups.forEach(function (moduleIds) {
        if (moduleIds.length < 2) return;
        var parents = moduleIds.map(function (moduleId) { return moduleById(current.modules, moduleId); });
        var editableCopy = mergeEditableCopy(parents);
        var factBindings = mergeFactBindingInputs(parents, editableCopy);
        var visualBrief = mergeVisualBrief(parents);
        current = applyRevision(current, { type: 'merge', moduleIds: moduleIds }, snapshot, options);
        var mergedModuleId = latestResultModuleId(current, 'merge');
        var mergedModule = moduleById(current.modules, mergedModuleId);
        var patch = {
          editableCopy: editableCopy,
          visualBrief: visualBrief,
          targetAssetDrafts: mergeTargetAssetDrafts(parents, mergedModule)
        };
        if (factBindings.length) patch.factBindings = factBindings;
        current = applyRevision(current, {
          type: 'edit', moduleId: mergedModuleId, patch: patch
        }, snapshot, options);
      });
    } else if (selected.length < count) {
      var perModule = Math.floor(count / selected.length);
      var remainder = count % selected.length;
      selected.forEach(function (sourceModule, moduleIndex) {
        var repetitions = perModule + (moduleIndex < remainder ? 1 : 0);
        var copyAfterId = sourceModule.moduleId;
        for (var repeat = 1; repeat < repetitions; repeat++) {
          current = applyRevision(current, { type: 'copy', moduleId: copyAfterId }, snapshot, options);
          var copyId = latestResultModuleId(current, 'copy');
          var copiedModule = moduleById(current.modules, copyId);
          current = applyRevision(current, {
            type: 'edit',
            moduleId: copyId,
            patch: {
              visualBrief: Object.assign({}, copiedModule.visualBrief, {
                description: directionVariant(sourceModule.visualBrief.description || fallbackDirectionForRole(sourceModule.salesRole), repeat)
              })
            }
          }, snapshot, options);
          copyAfterId = copyId;
        }
      });
    }

    current = canonicalizeSelectedDirections(current, snapshot, options);
    if (selectedModulesInOrder(current).length !== count) {
      fail('MATERIALIZATION_COUNT_MISMATCH', '屏幕物化后未得到目标数量。', '$.modules');
    }
    return current;
  }

  function sameOrderedStrings(first, second) {
    if (!Array.isArray(first) || !Array.isArray(second) || first.length !== second.length) return false;
    for (var index = 0; index < first.length; index++) {
      if (String(first[index]) !== String(second[index])) return false;
    }
    return true;
  }

  function applyScreenDirections(workingInput, snapshotInput, directions, options) {
    options = options || {};
    var snapshot = ensureSnapshot(snapshotInput, options);
    var current = ensureWorking(workingInput, snapshot);
    var screens = selectedModulesInOrder(current);
    if (!Array.isArray(directions) || directions.length !== screens.length) {
      fail('SCREEN_DIRECTION_COUNT_MISMATCH', '最终分屏方向必须与已选分屏一一对应。', '$directions');
    }
    var seen = Object.create(null);
    var normalized = directions.map(function (raw, index) {
      var screen = screens[index];
      if (!isPlainObject(raw) || Number(raw.screenIndex) !== index + 1 || String(raw.moduleId || '') !== screen.moduleId ||
          !sameOrderedStrings(raw.sourceBlockIds, screen.sourceBlockIds)) {
        fail('SCREEN_DIRECTION_IDENTITY_MISMATCH', '最终分屏方向的屏号、模块 ID 或来源血缘不匹配。', '$directions[' + index + ']');
      }
      if (typeof raw.descriptionDirection !== 'string') {
        fail('SCREEN_DIRECTION_REQUIRED', '最终分屏必须提供一句话描述方向。', '$directions[' + index + '].descriptionDirection');
      }
      var input = raw.descriptionDirection.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      var marks = input.match(/[。！？!?；;.]/g) || [];
      if (!input || input.length > MAX_DIRECTION_TEXT || marks.length > 1 ||
          (marks.length === 1 && !/[。！？!?；;.]$/.test(input))) {
        fail('SCREEN_DIRECTION_INVALID', '最终分屏方向必须是 1–160 字的单句。', '$directions[' + index + '].descriptionDirection');
      }
      var direction = normalizeDirection(input);
      var comparable = directionBody(direction).toLowerCase().replace(/[\s,，:：]/g, '');
      if (!comparable || seen[comparable]) {
        fail('SCREEN_DIRECTION_DUPLICATE', '最终分屏方向必须逐屏独立且不能重复。', '$directions[' + index + '].descriptionDirection');
      }
      seen[comparable] = true;
      return { moduleId: screen.moduleId, direction: direction };
    });
    normalized.forEach(function (entry) {
      var module = moduleById(current.modules, entry.moduleId);
      if (module.visualBrief.description === entry.direction) return;
      current = applyRevision(current, {
        type: 'edit',
        moduleId: entry.moduleId,
        patch: { visualBrief: Object.assign({}, module.visualBrief, { description: entry.direction }) }
      }, snapshot, options);
    });
    return current;
  }

  function mergedScreenModule(group, screenIndex, contract) {
    var first = group[0];
    var moduleIds = group.map(function (module) { return module.moduleId; });
    var lineage = unique([].concat.apply([], group.map(function (module) { return module.sourceBlockIds; })));
    var copies = group.map(function (module) { return module.editableCopy; });
    var briefs = group.map(function (module) { return module.visualBrief; });
    return {
      moduleId: stableHash({ moduleIds: moduleIds, screenIndex: screenIndex }, 'rdscreen_', contract),
      sourceModuleIds: moduleIds,
      sourceBlockIds: lineage,
      originalIndex: Math.min.apply(null, group.map(function (module) { return module.originalIndex; })),
      order: screenIndex,
      type: group.length === 1 ? first.type : 'mixed',
      salesRole: first.salesRole,
      editableCopy: {
        headline: copies.map(function (copy) { return copy.headline; }).filter(Boolean)[0] || '',
        body: unique(copies.map(function (copy) { return copy.body; }).filter(Boolean)).join('\n'),
        bullets: unique([].concat.apply([], copies.map(function (copy) { return copy.bullets || []; }))),
        cta: copies.map(function (copy) { return copy.cta; }).filter(Boolean).slice(-1)[0] || ''
      },
      visualBrief: {
        description: unique(briefs.map(function (brief) { return brief.description; }).filter(Boolean)).join('；'),
        layout: briefs.map(function (brief) { return brief.layout; }).filter(Boolean)[0] || '',
        mood: briefs.map(function (brief) { return brief.mood; }).filter(Boolean)[0] || '',
        shotType: briefs.map(function (brief) { return brief.shotType; }).filter(Boolean)[0] || '',
        subjectPlacement: briefs.map(function (brief) { return brief.subjectPlacement; }).filter(Boolean)[0] || '',
        background: briefs.map(function (brief) { return brief.background; }).filter(Boolean)[0] || '',
        lighting: briefs.map(function (brief) { return brief.lighting; }).filter(Boolean)[0] || '',
        palette: unique([].concat.apply([], briefs.map(function (brief) { return brief.palette || []; }))),
        textZones: unique([].concat.apply([], briefs.map(function (brief) { return brief.textZones || []; }))),
        density: briefs.map(function (brief) { return brief.density; }).filter(Boolean)[0] || '',
        transition: briefs.map(function (brief) { return brief.transition; }).filter(Boolean)[0] || '',
        mustKeep: unique([].concat.apply([], briefs.map(function (brief) { return brief.mustKeep || []; }))),
        avoid: unique([].concat.apply([], briefs.map(function (brief) { return brief.avoid || []; })))
      },
      factBindings: unique([].concat.apply([], group.map(function (module) { return module.factBindings || []; })).map(function (binding) { return JSON.stringify(binding); })).map(function (item) { return JSON.parse(item); }),
      sourceFactBindings: unique([].concat.apply([], group.map(function (module) { return module.sourceFactBindings || []; })).map(function (binding) { return JSON.stringify(binding); })).map(function (item) { return JSON.parse(item); }),
      assetSlots: unique([].concat.apply([], group.map(function (module) { return module.assetSlots || []; })).map(function (slot) { return JSON.stringify(slot); })).map(function (item) { return JSON.parse(item); }),
      targetAssetDrafts: unique([].concat.apply([], group.map(function (module) { return module.targetAssetDrafts || []; })).map(function (draft) { return JSON.stringify(draft); })).map(function (item) { return JSON.parse(item); }),
      riskFlags: unique([].concat.apply([], group.map(function (module) { return module.riskFlags || []; }))).sort()
    };
  }

  function selectScreens(workingOrModules, targetScreenCount, options) {
    options = options || {};
    var contract = requireContract(options.contract);
    var legacy = removedUploadMarker(workingOrModules);
    if (!legacy && Array.isArray(workingOrModules)) {
      for (var legacyIndex = 0; legacyIndex < workingOrModules.length; legacyIndex++) {
        legacy = removedUploadMarker(workingOrModules[legacyIndex], '$[' + legacyIndex + ']');
        if (legacy) break;
      }
    }
    if (legacy) fail('LEGACY_REFERENCE_UPLOAD_REMOVED', LEGACY_UPLOAD_REMOVED_MESSAGE, legacy.path);
    if (looksLikeImageReferenceArray(workingOrModules)) {
      fail('FORMAL_SOURCE_REQUIRED', FORMAL_SOURCE_REQUIRED_MESSAGE, '$');
    }
    var count = validateScreenCount(targetScreenCount);
    var modules = Array.isArray(workingOrModules) ? workingOrModules : (workingOrModules && workingOrModules.modules);
    modules = (Array.isArray(modules) ? modules : []).filter(function (module) { return module.selected !== false; })
      .slice().sort(function (a, b) { return a.order - b.order || a.originalIndex - b.originalIndex; });
    if (!modules.length) fail('NO_SELECTED_MODULE', '至少选择一个蓝图模块。', '$.modules');
    var groups = [];
    var index;
    if (modules.length >= count) {
      var base = Math.floor(modules.length / count);
      var extra = modules.length % count;
      var cursor = 0;
      for (index = 0; index < count; index++) {
        var size = base + (index < extra ? 1 : 0);
        groups.push(modules.slice(cursor, cursor + size));
        cursor += size;
      }
    } else {
      var perModule = Math.floor(count / modules.length);
      var remainder = count % modules.length;
      modules.forEach(function (module, moduleIndex) {
        var repetitions = perModule + (moduleIndex < remainder ? 1 : 0);
        for (var repeat = 0; repeat < repetitions; repeat++) {
          if (repeat === 0) groups.push([module]);
          else {
            var extension = cloneJson(module);
            extension.moduleId = stableHash({ sourceModuleId: module.moduleId, extension: repeat, target: count }, 'rdscreen_ext_', contract);
            extension.editableCopy = { headline: '', body: '', bullets: [], cta: '' };
            extension.visualBrief.description = '延展同一来源模块的原创视觉层次；不得复制原图原文或新增未经自家事实支持的主张。';
            extension.factBindings = [];
            extension.riskFlags = normalizedRiskFlags(['COPY_REWRITE_REQUIRED'], extension.riskFlags);
            groups.push([extension]);
          }
        }
      });
    }
    return deepFreeze(groups.map(function (group, screenIndex) { return mergedScreenModule(group, screenIndex, contract); }));
  }

  function compileScreenPlan(workingInput, snapshotInput, options) {
    options = options || {};
    var snapshot = ensureSnapshot(snapshotInput, options);
    var working = ensureWorking(workingInput, snapshot);
    var count = validateScreenCount(options.screenCount == null ? 10 : options.screenCount);
    var materialized = materializeScreenBlueprint(working, snapshot, count, options);
    var gate = validateGenerationGate(materialized, snapshot, Object.assign({}, options, { screenCount: count }));
    if (!gate.ok && options.allowUnsafePreview !== true) {
      var error = new BlueprintError('GENERATION_GATE_FAILED', '蓝图未通过生成门禁。', '$working');
      error.issues = gate.errors;
      throw error;
    }
    var screens = selectedModulesInOrder(materialized);
    var screenPlans = screens.map(function (screen, index) {
      var label = SALES_ROLE_LABELS[screen.salesRole] || SALES_ROLE_LABELS.unknown;
      var direction = normalizeDirection(screen.visualBrief.description);
      return {
        '屏幕': index + 1,
        '名称': label,
        '模块类型': screen.type,
        '销售作用': screen.salesRole,
        '核心内容': direction,
        '描述方向': direction,
        '主文案': screen.editableCopy.headline,
        '副文案': screen.editableCopy.body,
        '卖点': screen.editableCopy.bullets.slice(),
        '行动文案': screen.editableCopy.cta,
        '商业分镜': direction,
        '画面方向': direction,
        '布局': screen.visualBrief.layout,
        '氛围': screen.visualBrief.mood,
        '事实绑定': screen.factBindings.map(function (binding) { return binding.productFactId; }).filter(Boolean),
        '素材槽': screen.assetSlots.map(function (slot) {
          var targetDraft = (screen.targetAssetDrafts || []).find(function (draft) { return draft.sourceSlotId === slot.slotId; });
          return {
            role: slot.role,
            sourceAssetId: slot.sourceAssetId || null,
            productAssetId: targetDraft ? targetDraft.targetAssetId : (slot.productAssetId || null),
            rightsStatus: slot.sourceAssetId ? 'reference_only' : slot.rightsStatus,
            directUseAllowed: slot.sourceAssetId ? false : slot.directUseAllowed,
            replacementRequired: slot.sourceAssetId ? true : slot.replacementRequired
          };
        }),
        '风险提示': screen.riskFlags.slice(),
        '对应来源块': screen.sourceBlockIds.slice(),
        '生图提示词': [
          '仅生成当前第' + (index + 1) + '个独立详情单屏，不生成拼图或整张长图。',
          '本屏核心内容与描述方向：' + direction,
          screen.visualBrief.layout ? ('布局：' + screen.visualBrief.layout) : '',
          screen.visualBrief.mood ? ('氛围：' + screen.visualBrief.mood) : '',
          screen.editableCopy.headline ? ('主文案：' + screen.editableCopy.headline) : '',
          screen.editableCopy.body ? ('副文案：' + screen.editableCopy.body) : '',
          screen.editableCopy.bullets.length ? ('卖点：' + screen.editableCopy.bullets.join('；')) : '',
          '来源素材只作 reference_only 结构参考；画面主体必须使用已授权或自有商品素材，不得复用竞品品牌、Logo、人物、原图或原文。'
        ].filter(Boolean).join('\n'),
        '追踪': {
          blueprintId: materialized.blueprintId,
          revision: materialized.revision,
          revisionId: materialized.revisionId,
          moduleIds: [screen.moduleId],
          sourceBlockIds: screen.sourceBlockIds
        }
      };
    });
    return deepFreeze({
      '详情页方向': '参考成详：来源结构只读，使用自家事实与主体素材进行原创改写。',
      '全局销售逻辑': cloneJson(materialized.globalSalesLogic),
      '详情页规格': { '屏数': count },
      '屏幕规划': screenPlans,
      '参考成详追踪': {
        schema: 'REFERENCE_DETAIL_BLUEPRINT_V1',
        blueprintId: materialized.blueprintId,
        blueprintRevision: materialized.revision,
        sourceSnapshotId: snapshot.snapshotId,
        sourceDigest: snapshot.snapshotId
      },
      '门禁': gate
    });
  }

  function projectionContractOptions(options) {
    var input = isPlainObject(options && options.contractOptions) ? options.contractOptions : {};
    var output = {};
    Object.keys(input).forEach(function (key) {
      if (key !== 'previousBlueprint' && key !== 'sourceSnapshot' && key !== 'updatedAt' && key !== 'approvalStatus' && key !== 'approval') {
        output[key] = input[key];
      }
    });
    ['urlPolicy', 'limits', 'verifiedProductFactCards', 'verifiedTargetAssets'].forEach(function (key) {
      if (options && own(options, key) != null) output[key] = options[key];
    });
    return output;
  }

  function sameJson(left, right, contract) {
    return requireContract(contract).stableSerialize(left) === requireContract(contract).stableSerialize(right);
  }

  function canonicalWorkingLineage(module, snapshot, path) {
    var ids = module && module.sourceBlockIds;
    if (!Array.isArray(ids) || !ids.length || idList(ids).length !== ids.length) {
      fail('INVALID_WORKING_LINEAGE', '工作模块必须包含不重复的 sourceBlockIds。', path + '.sourceBlockIds');
    }
    var positions = Object.create(null);
    snapshot.orderedBlocks.forEach(function (block, index) { positions[block.blockId] = index; });
    if (ids.some(function (id) { return !Number.isSafeInteger(positions[id]); })) {
      fail('UNKNOWN_SOURCE_BLOCK', '工作模块引用了当前快照之外的来源块。', path + '.sourceBlockIds');
    }
    return ids.slice().sort(function (a, b) { return positions[a] - positions[b] || a.localeCompare(b); });
  }

  function lineageKey(ids) {
    return ids.join('\u0000');
  }

  function lineageUnionForFormalIds(ids, currentById, snapshot) {
    var combined = [];
    ids.forEach(function (id) {
      if (!currentById[id]) fail('UNKNOWN_SOURCE_MODULE', '工作派生意图引用的正式父模块不存在。', '$working.modules.provenance');
      combined = combined.concat(currentById[id].sourceBlockIds);
    });
    var seen = Object.create(null);
    combined = combined.filter(function (id) {
      if (seen[id]) return false;
      seen[id] = true;
      return true;
    });
    var positions = Object.create(null);
    snapshot.orderedBlocks.forEach(function (block, index) { positions[block.blockId] = index; });
    return combined.sort(function (a, b) { return positions[a] - positions[b] || a.localeCompare(b); });
  }

  function exactCoverFormalModules(targetLineage, currentModules) {
    var target = Object.create(null);
    targetLineage.forEach(function (id) { target[id] = true; });
    var candidates = currentModules.filter(function (module) {
      return module.sourceBlockIds.length && module.sourceBlockIds.every(function (id) { return !!target[id]; });
    }).slice().sort(function (a, b) {
      return b.sourceBlockIds.length - a.sourceBlockIds.length || a.order - b.order || a.moduleId.localeCompare(b.moduleId);
    });
    var covered = Object.create(null);
    var chosen = [];
    while (Object.keys(covered).length < targetLineage.length) {
      var next = null;
      for (var index = 0; index < candidates.length; index++) {
        var candidate = candidates[index];
        if (chosen.indexOf(candidate) >= 0) continue;
        if (candidate.sourceBlockIds.some(function (id) { return !!covered[id]; })) continue;
        if (!candidate.sourceBlockIds.some(function (id) { return !covered[id]; })) continue;
        next = candidate;
        break;
      }
      if (!next) break;
      chosen.push(next);
      next.sourceBlockIds.forEach(function (id) { covered[id] = true; });
    }
    if (targetLineage.some(function (id) { return !covered[id]; })) return [];
    return chosen.sort(function (a, b) { return a.order - b.order || a.moduleId.localeCompare(b.moduleId); })
      .map(function (module) { return module.moduleId; });
  }

  function projectionOperationKey(kind, workingModule, targetIndex, revision, contract) {
    var hash = stableHash({
      kind: kind,
      workingModuleId: workingModule && workingModule.moduleId || '',
      sourceBlockIds: workingModule && workingModule.sourceBlockIds || [],
      targetIndex: targetIndex,
      revision: revision
    }, 'op_', contract);
    return ('working_' + kind + '_r' + revision + '_' + hash).slice(0, 120);
  }

  function projectionSplitParts(module, parent, snapshot, targetIndex) {
    var provenance = isPlainObject(module.provenance) ? module.provenance : {};
    var rawParts = provenance.parts;
    var path = '$working.modules[' + targetIndex + '].provenance.parts';
    if (!Array.isArray(rawParts) || rawParts.length < 2) {
      fail('INVALID_MODULE_SPLIT', '拆分意图必须保留至少两个完整分组。', path);
    }
    var positions = Object.create(null);
    snapshot.orderedBlocks.forEach(function (block, index) { positions[block.blockId] = index; });
    var parentSources = Object.create(null);
    parent.sourceBlockIds.forEach(function (sourceBlockId) { parentSources[sourceBlockId] = true; });
    var covered = Object.create(null);
    var operationKeys = Object.create(null);
    var parts = rawParts.map(function (part, partIndex) {
      var partPath = path + '[' + partIndex + ']';
      if (!isPlainObject(part)) fail('INVALID_MODULE_SPLIT', '拆分分组必须是普通对象。', partPath);
      var ids = idList(part.sourceBlockIds);
      if (!Array.isArray(part.sourceBlockIds) || !ids.length || ids.length !== part.sourceBlockIds.length) {
        fail('INVALID_MODULE_SPLIT', '拆分分组必须包含不重复的来源块。', partPath + '.sourceBlockIds');
      }
      ids.forEach(function (sourceBlockId) {
        if (!parentSources[sourceBlockId] || !Number.isSafeInteger(positions[sourceBlockId])) {
          fail('INVALID_MODULE_SPLIT', '拆分分组不得引用父模块之外的来源块。', partPath + '.sourceBlockIds');
        }
        if (covered[sourceBlockId]) fail('INVALID_MODULE_SPLIT', '拆分分组之间不得重叠。', partPath + '.sourceBlockIds');
        covered[sourceBlockId] = true;
      });
      ids.sort(function (a, b) { return positions[a] - positions[b] || a.localeCompare(b); });
      var partOperationKey = text(part.operationKey, 120);
      if (!partOperationKey || operationKeys[partOperationKey]) {
        fail('INVALID_MODULE_SPLIT', '拆分分组必须保留唯一 operationKey。', partPath + '.operationKey');
      }
      operationKeys[partOperationKey] = true;
      return { sourceBlockIds: ids, operationKey: partOperationKey };
    });
    if (Object.keys(covered).length !== parent.sourceBlockIds.length ||
        parent.sourceBlockIds.some(function (sourceBlockId) { return !covered[sourceBlockId]; })) {
      fail('INVALID_MODULE_SPLIT', '拆分分组必须精确覆盖父模块的全部 lineage。', path);
    }
    return parts;
  }

  function targetProjectionDescriptor(module, targetIndex, lineage, currentModules, currentById, snapshot) {
    var current = currentById[module.moduleId];
    if (current) {
      if (lineageKey(current.sourceBlockIds) !== lineageKey(lineage)) {
        fail('WORKING_LINEAGE_MISMATCH', '存续正式 moduleId 不得替换 sourceBlockIds。', '$working.modules[' + targetIndex + '].sourceBlockIds');
      }
      return { working: module, targetIndex: targetIndex, lineage: lineage, mode: 'keep', baseIds: [current.moduleId], fixed: true };
    }
    var provenance = isPlainObject(module.provenance) ? module.provenance : {};
    var provenanceKind = text(provenance.kind, 80);
    var provenanceParents = idList(provenance.sourceModuleIds || (provenance.sourceModuleId ? [provenance.sourceModuleId] : []));
    if (provenanceKind === 'user_split_intent' && provenanceParents.length === 1 && currentById[provenanceParents[0]]) {
      var splitParent = currentById[provenanceParents[0]];
      var splitParts = projectionSplitParts(module, splitParent, snapshot, targetIndex);
      var splitPartIndex = splitParts.findIndex(function (part) { return lineageKey(part.sourceBlockIds) === lineageKey(lineage); });
      if (splitPartIndex < 0) {
        fail('INVALID_MODULE_SPLIT', '拆分子模块 lineage 必须与保留的分组一致。', '$working.modules[' + targetIndex + '].sourceBlockIds');
      }
      return {
        working: module,
        targetIndex: targetIndex,
        lineage: lineage,
        mode: 'split',
        baseIds: [splitParent.moduleId],
        fixed: false,
        splitParentId: splitParent.moduleId,
        splitParts: splitParts,
        splitPartIndex: splitPartIndex
      };
    }
    if (provenanceKind === 'user_merge_intent' && provenanceParents.length >= 2 && provenanceParents.every(function (id) { return !!currentById[id]; })) {
      if (lineageKey(lineageUnionForFormalIds(provenanceParents, currentById, snapshot)) === lineageKey(lineage)) {
        return { working: module, targetIndex: targetIndex, lineage: lineage, mode: 'merge', baseIds: provenanceParents.slice(), fixed: false };
      }
    }
    var exact = currentModules.filter(function (candidate) { return lineageKey(candidate.sourceBlockIds) === lineageKey(lineage); })
      .sort(function (a, b) { return a.order - b.order || a.moduleId.localeCompare(b.moduleId); });
    if (provenanceKind === 'user_copy' && exact.length) {
      var preferred = currentById[provenance.sourceModuleId] && lineageKey(currentById[provenance.sourceModuleId].sourceBlockIds) === lineageKey(lineage)
        ? provenance.sourceModuleId : exact[0].moduleId;
      return { working: module, targetIndex: targetIndex, lineage: lineage, mode: 'duplicate', baseIds: [preferred], fixed: false };
    }
    var cover = exact.length ? [exact[0].moduleId] : exactCoverFormalModules(lineage, currentModules);
    if (!cover.length) {
      fail('UNREPRESENTABLE_WORKING_STRUCTURE', '当前正式 revision 无法不拆分已有 lineage 地表示该工作模块。', '$working.modules[' + targetIndex + '].sourceBlockIds');
    }
    if (provenanceKind === 'user_merge_intent') {
      if (cover.length === 1) cover.push(cover[0]);
      return { working: module, targetIndex: targetIndex, lineage: lineage, mode: 'merge', baseIds: cover, fixed: false };
    }
    return { working: module, targetIndex: targetIndex, lineage: lineage, mode: cover.length > 1 ? 'merge' : 'keep', baseIds: cover, fixed: false };
  }

  function trustedProductFactKeys(module, options, contract) {
    var normalized = normalizeProductFacts(options.productFacts, contract);
    var keys = [];
    (module.factBindings || []).forEach(function (binding) {
      var fact = normalized.byId[binding.productFactId];
      if (!fact || !fact.owned || (!fact.verified && options.allowUnverifiedFactBindingIntents !== true)) return;
      if (binding.productFactKey && binding.productFactKey !== fact.key) return;
      if (fact.key) keys.push(fact.key);
    });
    return unique(keys).sort();
  }

  function mutableFormalEdit(formalModule, workingModule, options, contract) {
    var copy = isPlainObject(workingModule.editableCopy) ? cloneJson(workingModule.editableCopy) : { headline: '', body: '', bullets: [], cta: '' };
    var brief = isPlainObject(workingModule.visualBrief) ? cloneJson(workingModule.visualBrief) : { description: '', layout: '', mood: '', mustKeep: [], avoid: [] };
    var selectedKeys = trustedProductFactKeys(workingModule, options, contract);
    var productFactsWereProvided = Array.isArray(options.productFacts);
    var bindingEdits = formalModule.factBindings.map(function (binding) {
      return {
        bindingId: binding.bindingId,
        targetField: selectedKeys.length ? selectedKeys[0] : (productFactsWereProvided ? '' : binding.targetField)
      };
    });
    var edit = {
      moduleId: formalModule.moduleId,
      type: enumOr(workingModule.type, contractEnums(contract, 'blockTypes'), formalModule.type),
      salesRole: enumOr(workingModule.salesRole, contractEnums(contract, 'salesRoles'), formalModule.salesRole),
      editableCopy: copy,
      visualBrief: brief,
      selected: workingModule.selected !== false,
      locked: workingModule.locked === true,
      factBindingEdits: bindingEdits
    };
    var desiredBindings = formalModule.factBindings.map(function (binding, index) {
      var next = cloneJson(binding);
      next.targetField = bindingEdits[index].targetField;
      return next;
    });
    var changed = edit.type !== formalModule.type || edit.salesRole !== formalModule.salesRole ||
      !sameJson(edit.editableCopy, formalModule.editableCopy, contract) ||
      !sameJson(edit.visualBrief, formalModule.visualBrief, contract) ||
      edit.selected !== formalModule.selected || edit.locked !== formalModule.locked ||
      !sameJson(desiredBindings, formalModule.factBindings, contract);
    return { changed: changed, edit: edit };
  }

  function createProjectionEnvelope(workingInput, snapshotInput, options) {
    options = options || {};
    var contract = requireContract(options.contract);
    if (typeof contract.reviseBlueprint !== 'function' || typeof contract.createRevisionEnvelope !== 'function' ||
        typeof contract.advanceRevisionEnvelope !== 'function') {
      fail('CONTRACT_PROJECTION_UNAVAILABLE', '正式合同缺少 reviseBlueprint/revision envelope API。', '$contract');
    }
    var snapshot = ensureSnapshot(snapshotInput, options);
    var working = ensureWorking(workingInput, snapshot);
    if (!working.modules.length) fail('REQUIRED_FIELD', '正式蓝图至少保留一个模块。', '$working.modules');
    var baseOptions = projectionContractOptions(options);
    var suppliedEnvelope = isPlainObject(options.revisionEnvelope) ? options.revisionEnvelope : null;
    var current = suppliedEnvelope ? suppliedEnvelope.currentBlueprint : options.currentBlueprint;
    var immediatePrevious = suppliedEnvelope ? suppliedEnvelope.immediatePreviousBlueprint : options.immediatePreviousBlueprint;
    if (!current) {
      current = contract.createBlueprintFromSnapshot(snapshot, Object.assign({}, baseOptions, {
        createdAt: options.createdAt || snapshot.source.capturedAt
      }));
      immediatePrevious = null;
    }
    var envelope = contract.createRevisionEnvelope(current, immediatePrevious == null ? null : immediatePrevious, snapshot, baseOptions);
    if (envelope.currentBlueprint.blueprintId !== working.blueprintId || envelope.currentBlueprint.sourceSnapshotId !== working.sourceSnapshotId) {
      fail('LINKAGE_MISMATCH', '工作蓝图与正式 revision envelope 不同系。', '$working.blueprintId');
    }
    var updatedAt = options.updatedAt || working.updatedAt || envelope.currentBlueprint.updatedAt;
    var projectedRevisions = [];

    function advance(changes) {
      var reviseOptions = Object.assign({}, baseOptions, { sourceSnapshot: snapshot, updatedAt: updatedAt });
      if (envelope.immediatePreviousBlueprint) reviseOptions.previousBlueprint = envelope.immediatePreviousBlueprint;
      var next = contract.reviseBlueprint(envelope.currentBlueprint, changes, reviseOptions);
      envelope = contract.advanceRevisionEnvelope(envelope, next, snapshot, baseOptions);
      projectedRevisions.push(next);
    }

    var targetModules = working.modules.slice().sort(function (a, b) { return a.order - b.order || a.originalIndex - b.originalIndex; });
    var targetIds = Object.create(null);
    var currentModules = envelope.currentBlueprint.modules.slice();
    var currentById = Object.create(null);
    currentModules.forEach(function (module) { currentById[module.moduleId] = module; });
    var descriptors = targetModules.map(function (module, index) {
      if (!module.moduleId || targetIds[module.moduleId]) fail('DUPLICATE_ID', '工作模块 moduleId 缺失或重复。', '$working.modules[' + index + '].moduleId');
      targetIds[module.moduleId] = true;
      var lineage = canonicalWorkingLineage(module, snapshot, '$working.modules[' + index + ']');
      return targetProjectionDescriptor(module, index, lineage, currentModules, currentById, snapshot);
    });

    var splitGroups = Object.create(null);
    descriptors.filter(function (descriptor) { return descriptor.mode === 'split'; }).forEach(function (descriptor) {
      var existing = splitGroups[descriptor.splitParentId];
      if (!existing) {
        splitGroups[descriptor.splitParentId] = { parentId: descriptor.splitParentId, parts: descriptor.splitParts, descriptors: [descriptor] };
      } else {
        if (!sameJson(existing.parts, descriptor.splitParts, contract)) {
          fail('INVALID_MODULE_SPLIT', '同一父模块的拆分子模块必须保留一致分区。', '$working.modules[' + descriptor.targetIndex + '].provenance.parts');
        }
        existing.descriptors.push(descriptor);
      }
    });
    var splitParentIds = Object.keys(splitGroups);
    if (splitParentIds.length) {
      splitParentIds.forEach(function (parentId) {
        var conflicting = descriptors.find(function (descriptor) {
          return descriptor.mode !== 'split' && descriptor.baseIds.indexOf(parentId) >= 0;
        });
        if (conflicting) {
          fail('UNREPRESENTABLE_WORKING_STRUCTURE', '同一次投影不得既保留拆分父模块又消费其子分组。', '$working.modules[' + conflicting.targetIndex + ']');
        }
      });
      var splitRevision = envelope.currentBlueprint.revision + 1;
      var splitOperations = [];
      var splitOperationKeys = Object.create(null);
      currentModules.forEach(function (formalModule, formalIndex) {
        var group = splitGroups[formalModule.moduleId];
        if (!group) {
          splitOperations.push({ op: 'keep', moduleId: formalModule.moduleId });
          return;
        }
        var formalParts = group.parts.map(function (part, partIndex) {
          var operationKey = projectionOperationKey('split_' + formalIndex + '_' + partIndex, {
            moduleId: group.parentId,
            sourceBlockIds: part.sourceBlockIds
          }, partIndex, splitRevision, contract);
          if (splitOperationKeys[operationKey]) fail('DUPLICATE_OPERATION_KEY', '拆分投影产生了重复 operationKey。', '$working.modules');
          splitOperationKeys[operationKey] = true;
          return { sourceBlockIds: part.sourceBlockIds.slice(), operationKey: operationKey };
        });
        group.formalParts = formalParts;
        splitOperations.push({ op: 'split', sourceModuleId: group.parentId, parts: formalParts });
      });
      advance({ operations: splitOperations });
      currentModules = envelope.currentBlueprint.modules.slice();
      currentById = Object.create(null);
      currentModules.forEach(function (module) { currentById[module.moduleId] = module; });
      splitParentIds.forEach(function (parentId) {
        var group = splitGroups[parentId];
        group.descriptors.forEach(function (descriptor) {
          var expectedPart = group.formalParts[descriptor.splitPartIndex];
          var derived = currentModules.find(function (module) {
            return module.derivation && module.derivation.kind === 'split' &&
              module.derivation.createdRevision === splitRevision &&
              module.derivation.parentModuleIds.length === 1 && module.derivation.parentModuleIds[0] === parentId &&
              module.derivation.operationKey === expectedPart.operationKey;
          });
          if (!derived || lineageKey(derived.sourceBlockIds) !== lineageKey(descriptor.lineage)) {
            fail('CONTRACT_PROJECTION_FAILED', '合同未返回预期的 split 派生模块。', '$contract.reviseBlueprint');
          }
          descriptor.mode = 'keep';
          descriptor.baseIds = [derived.moduleId];
          descriptor.fixed = false;
        });
      });
    }

    var usagesByBase = Object.create(null);
    descriptors.forEach(function (descriptor) {
      descriptor.usages = descriptor.baseIds.map(function (baseId, parentIndex) {
        if (!currentById[baseId]) fail('UNKNOWN_SOURCE_MODULE', '投影计划只能引用当前正式 revision 的模块。', '$working.modules[' + descriptor.targetIndex + ']');
        var usage = {
          descriptor: descriptor,
          baseId: baseId,
          parentIndex: parentIndex,
          forceDuplicate: descriptor.mode === 'duplicate',
          resourceId: '',
          operationKey: ''
        };
        if (!usagesByBase[baseId]) usagesByBase[baseId] = [];
        usagesByBase[baseId].push(usage);
        return usage;
      });
    });

    Object.keys(usagesByBase).forEach(function (baseId) {
      var usages = usagesByBase[baseId];
      var original = usages.find(function (usage) { return !usage.forceDuplicate && usage.descriptor.fixed; }) ||
        usages.find(function (usage) { return !usage.forceDuplicate; });
      if (original) original.resourceId = baseId;
    });
    var duplicateUsages = [];
    descriptors.forEach(function (descriptor) {
      descriptor.usages.forEach(function (usage) { if (!usage.resourceId) duplicateUsages.push(usage); });
    });

    if (duplicateUsages.length) {
      var duplicateRevision = envelope.currentBlueprint.revision + 1;
      var duplicateOperations = [];
      duplicateUsages.forEach(function (usage, duplicateIndex) {
        usage.operationKey = projectionOperationKey('duplicate_' + duplicateIndex, usage.descriptor.working, usage.descriptor.targetIndex, duplicateRevision, contract);
        duplicateOperations.push({ op: 'duplicate', sourceModuleId: usage.baseId, operationKey: usage.operationKey });
      });
      currentModules.forEach(function (module) {
        var originalIsUsed = (usagesByBase[module.moduleId] || []).some(function (usage) { return usage.resourceId === module.moduleId; });
        duplicateOperations.push({ op: originalIsUsed ? 'keep' : 'delete', moduleId: module.moduleId });
      });
      advance({ operations: duplicateOperations });
      duplicateUsages.forEach(function (usage) {
        var derived = envelope.currentBlueprint.modules.find(function (module) {
          return module.derivation.createdRevision === duplicateRevision && module.derivation.operationKey === usage.operationKey;
        });
        if (!derived) fail('CONTRACT_PROJECTION_FAILED', '合同未返回预期的 duplicate 派生模块。', '$contract.reviseBlueprint');
        usage.resourceId = derived.moduleId;
      });
    }

    var resourceIds = Object.create(null);
    descriptors.forEach(function (descriptor) {
      descriptor.resourceIds = descriptor.usages.map(function (usage) {
        if (!usage.resourceId || resourceIds[usage.resourceId]) fail('CONTRACT_PROJECTION_FAILED', '投影资源未唯一分配。', '$working.modules[' + descriptor.targetIndex + ']');
        resourceIds[usage.resourceId] = true;
        return usage.resourceId;
      });
    });

    var structuralRevision = envelope.currentBlueprint.revision + 1;
    var structuralOperations = [];
    descriptors.forEach(function (descriptor) {
      if (descriptor.mode === 'merge') {
        if (descriptor.resourceIds.length < 2) fail('INVALID_MODULE_MERGE', '正式 merge 投影至少需要两个父资源。', '$working.modules[' + descriptor.targetIndex + ']');
        descriptor.operationKey = projectionOperationKey('merge', descriptor.working, descriptor.targetIndex, structuralRevision, contract);
        structuralOperations.push({ op: 'merge', sourceModuleIds: descriptor.resourceIds.slice(), operationKey: descriptor.operationKey });
      } else {
        structuralOperations.push({ op: 'keep', moduleId: descriptor.resourceIds[0] });
      }
    });
    envelope.currentBlueprint.modules.forEach(function (module) {
      if (!resourceIds[module.moduleId]) structuralOperations.push({ op: 'delete', moduleId: module.moduleId });
    });
    var currentOrder = envelope.currentBlueprint.modules.map(function (module) { return module.moduleId; });
    var keepOrder = structuralOperations.filter(function (operation) { return operation.op === 'keep'; }).map(function (operation) { return operation.moduleId; });
    var structuralNoop = structuralOperations.length === currentOrder.length &&
      structuralOperations.every(function (operation) { return operation.op === 'keep'; }) && sameJson(keepOrder, currentOrder, contract);
    if (!structuralNoop) advance({ operations: structuralOperations });

    if (envelope.currentBlueprint.modules.length !== descriptors.length) {
      fail('CONTRACT_PROJECTION_FAILED', '正式结构投影后模块数量不一致。', '$contract.reviseBlueprint');
    }
    envelope.currentBlueprint.modules.forEach(function (formalModule, index) {
      if (lineageKey(formalModule.sourceBlockIds) !== lineageKey(descriptors[index].lineage)) {
        fail('CONTRACT_PROJECTION_FAILED', '正式结构投影后 lineage 不一致。', '$contract.reviseBlueprint.modules[' + index + ']');
      }
    });

    var edits = [];
    envelope.currentBlueprint.modules.forEach(function (formalModule, index) {
      var normalized = mutableFormalEdit(formalModule, descriptors[index].working, options, contract);
      if (normalized.changed) edits.push(normalized.edit);
    });
    if (edits.length || envelope.currentBlueprint.approvalStatus !== 'draft' || options.forceDraftRevision === true) {
      advance({ moduleEdits: edits });
    }
    var checkedEnvelope = contract.createRevisionEnvelope(envelope.currentBlueprint, envelope.immediatePreviousBlueprint, snapshot, baseOptions);
    return deepFreeze({
      currentBlueprint: checkedEnvelope.currentBlueprint,
      immediatePreviousBlueprint: checkedEnvelope.immediatePreviousBlueprint,
      revisions: projectedRevisions.slice()
    });
  }

  function projectToContractBlueprint(workingInput, snapshotInput, options) {
    options = options || {};
    var envelope = createProjectionEnvelope(workingInput, snapshotInput, options);
    return options.returnEnvelope === true ? envelope : envelope.currentBlueprint;
  }

  function restoreWorkingBlueprint(formalInput, snapshotInput, options) {
    options = options || {};
    var contract = requireContract(options.contract);
    if (typeof contract.createRevisionEnvelope !== 'function') fail('CONTRACT_RESTORE_UNAVAILABLE', '正式合同缺少 revision envelope 恢复 API。', '$contract');
    var snapshot = importSourceSnapshot(snapshotInput, options);
    var suppliedEnvelope = isPlainObject(formalInput) && isPlainObject(formalInput.currentBlueprint) ? formalInput : null;
    var current = suppliedEnvelope ? formalInput.currentBlueprint : formalInput;
    var immediatePrevious = suppliedEnvelope ? formalInput.immediatePreviousBlueprint : options.immediatePreviousBlueprint;
    var baseOptions = projectionContractOptions(options);
    var envelope = contract.createRevisionEnvelope(current, immediatePrevious == null ? null : immediatePrevious, snapshot, baseOptions);
    var formal = envelope.currentBlueprint;
    var productFacts = normalizeProductFacts(options.productFacts, contract);
    var factsByKey = Object.create(null);
    productFacts.list.filter(function (fact) { return fact.owned && fact.verified && fact.key; })
      .sort(function (a, b) { return a.productFactId.localeCompare(b.productFactId); })
      .forEach(function (fact) { if (!factsByKey[fact.key]) factsByKey[fact.key] = fact; });
    var modules = formal.modules.map(function (formalModule) {
      var base = fallbackModule(snapshot, formalModule.sourceBlockIds, {
        contract: contract,
        moduleId: formalModule.moduleId,
        order: formalModule.order,
        variant: 'formal_restore'
      });
      var productBindingInputs = [];
      formalModule.factBindings.forEach(function (binding) {
        var fact = factsByKey[binding.targetField];
        if (fact) productBindingInputs.push({ productFactId: fact.productFactId, targetField: '*' });
      });
      var formalSlotById = Object.create(null);
      formalModule.assetSlots.forEach(function (slot) { formalSlotById[slot.slotId] = slot; });
      var workingSlotByAsset = Object.create(null);
      base.assetSlots.forEach(function (slot) { workingSlotByAsset[slot.sourceAssetId] = slot; });
      var targetAssetDrafts = formalModule.targetAssetSlots.map(function (target) {
        var sourceSlot = formalSlotById[target.sourceSlotId];
        var workingSlot = sourceSlot && workingSlotByAsset[sourceSlot.sourceAssetId];
        return workingSlot ? { sourceSlotId: workingSlot.slotId, targetAssetId: target.targetAssetId } : null;
      }).filter(Boolean);
      var editableCopy = cloneJson(formalModule.editableCopy);
      var hasCopy = claimFields({ editableCopy: editableCopy }).length > 0;
      var copiedSource = copyContentForWorking(editableCopy) &&
        copyContentForWorking(editableCopy) === text(formalModule.sourceCopy, MAX_MODEL_TEXT).replace(/\s+/g, ' ').trim();
      var riskFlags = normalizedRiskFlags(formalModule.riskFlags, base.riskFlags);
      if (hasCopy && !copiedSource) {
        riskFlags = riskFlags.filter(function (flag) { return flag !== 'COPY_REWRITE_REQUIRED' && flag !== 'ORIGINAL_REWRITE_REQUIRED'; });
      }
      return Object.assign({}, base, {
        moduleId: formalModule.moduleId,
        blockId: formalModule.moduleId,
        sourceBlockId: formalModule.sourceBlockId,
        sourceBlockIds: formalModule.sourceBlockIds.slice(),
        derivation: cloneJson(formalModule.derivation),
        originalIndex: formalModule.originalIndex,
        order: formalModule.order,
        type: formalModule.type,
        salesRole: formalModule.salesRole,
        sourceSummary: formalModule.sourceSummary,
        sourceCopy: formalModule.sourceCopy,
        editableCopy: editableCopy,
        visualBrief: normalizeVisualBrief(formalModule.visualBrief, base.visualBrief),
        sourceFactBindings: cloneJson(formalModule.factBindings),
        factBindings: normalizeProductFactBindings(productBindingInputs, formalModule.moduleId, options.productFacts, contract),
        assetSlots: base.assetSlots,
        targetAssetDrafts: targetAssetDrafts,
        selected: formalModule.selected,
        locked: formalModule.locked,
        riskFlags: riskFlags,
        provenance: { kind: 'formal_restore', formalModuleId: formalModule.moduleId }
      });
    });
    return workingEnvelope(snapshot, modules, {
      contract: contract,
      blueprintId: formal.blueprintId,
      revision: formal.revision,
      createdAt: formal.createdAt,
      updatedAt: formal.updatedAt,
      trustedApprovalStatus: formal.approvalStatus,
      trustedApproval: formal.approval,
      buildStatus: 'restored',
      warnings: (snapshot.warnings || []).concat(formal.warnings || []),
      operationLog: []
    });
  }

  function createApi(contract) {
    requireContract(contract);
    return buildExports(contract);
  }

  function buildExports(contractOverride) {
    function withContract(options) {
      return Object.assign({}, options || {}, contractOverride ? { contract: contractOverride } : {});
    }
    return deepFreeze({
      WORKING_SCHEMA: WORKING_SCHEMA,
      FORMAL_SOURCE_SCHEMA: FORMAL_SOURCE_SCHEMA,
      SCHEMA_VERSION: SCHEMA_VERSION,
      MIN_CHUNK_SIZE: MIN_CHUNK_SIZE,
      MAX_CHUNK_SIZE: MAX_CHUNK_SIZE,
      MIN_SCREEN_COUNT: MIN_SCREEN_COUNT,
      MAX_SCREEN_COUNT: MAX_SCREEN_COUNT,
      BlueprintError: BlueprintError,
      createApi: createApi,
      diagnoseSourceMigration: sourceMigrationDiagnostic,
      importSourceSnapshot: function (input, options) { return importSourceSnapshot(input, withContract(options)); },
      createOrderedChunks: function (input, options) { return createOrderedChunks(input, withContract(options)); },
      createFallbackModules: function (input, ids, options) { return createFallbackModules(input, ids, withContract(options)); },
      createDeterministicFallback: function (input, options) { return createDeterministicFallback(input, withContract(options)); },
      normalizeChunkResult: function (input, chunk, raw, options) { return normalizeChunkResult(input, chunk, raw, withContract(options)); },
      mergeChunkResults: function (input, chunks, responses, options) { return mergeChunkResults(input, chunks, responses, withContract(options)); },
      synthesizeGlobalSalesLogic: synthesizeGlobalSalesLogic,
      createWorkingBlueprint: function (input, options) { return createWorkingBlueprint(input, withContract(options)); },
      applyRevision: function (working, operation, snapshot, options) { return applyRevision(working, operation, snapshot, withContract(options)); },
      applyRebuildResult: function (working, snapshot, chunks, responses, options) { return applyRebuildResult(working, snapshot, chunks, responses, withContract(options)); },
      validateGenerationGate: function (working, snapshot, options) { return validateGenerationGate(working, snapshot, withContract(options)); },
      materializeScreenBlueprint: function (working, snapshot, count, options) { return materializeScreenBlueprint(working, snapshot, count, withContract(options)); },
      applyScreenDirections: function (working, snapshot, directions, options) { return applyScreenDirections(working, snapshot, directions, withContract(options)); },
      selectScreens: function (workingOrModules, count, options) { return selectScreens(workingOrModules, count, withContract(options)); },
      compileScreenPlan: function (working, snapshot, options) { return compileScreenPlan(working, snapshot, withContract(options)); },
      projectToContractEnvelope: function (working, snapshot, options) { return createProjectionEnvelope(working, snapshot, withContract(options)); },
      projectToContractBlueprint: function (working, snapshot, options) { return projectToContractBlueprint(working, snapshot, withContract(options)); },
      restoreWorkingBlueprint: function (formal, snapshot, options) { return restoreWorkingBlueprint(formal, snapshot, withContract(options)); },
      normalizeProductFacts: function (input) { return deepFreeze(normalizeProductFacts(input, contractOverride)); }
    });
  }

  return buildExports(injectedContract);
});
