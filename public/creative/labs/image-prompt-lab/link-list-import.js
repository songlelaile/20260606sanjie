(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SZ_LINK_LIST_IMPORT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var VERSION = 'LINK_LIST_IMPORT_V1';
  var MAX_BYTES = 32 * 1024 * 1024, MAX_ROWS = 20000, MAX_DEPTH = 48;
  var FIELDS = ['链接编号', '生成方式', '链接分组', '链接定位', '主推关键词', '用户场景需求', '来源关键词',
    '竞品未覆盖词根', '差异化定位逻辑', '标题结构', '标题定位词路', '商品标题', '标题冲突处理',
    '主图核心文案', '详情页定位', '详情页文案', '详情文案逻辑', '优先级分数', '优先级', '数据状态'];
  var ROW_KEYS = ['rows', 'linksJson', 'linkRows', 'data', 'links'];
  function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
  function text(value) { return typeof value === 'string' ? value.trim() : ''; }
  function fail(code, error, extra) { return Object.assign({ ok: false, code: code, error: error }, extra || {}); }
  function issue(code, message) { var error = new Error(message); error.code = code; throw error; }
  function bytes(value) {
    var size = 0;
    for (var i = 0; i < value.length; i++) {
      var code = value.charCodeAt(i);
      if (code < 128) size++;
      else if (code < 2048) size += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { size += 4; i++; }
      else size += 3;
    }
    return size;
  }
  function rejectDuplicateJsonKeys(raw) {
    var offset = 0;
    function whitespace() { while (/[\x20\t\r\n]/.test(raw.charAt(offset)) && offset < raw.length) offset++; }
    function invalid() { issue('LINK_LIST_JSON_INVALID', 'JSON 格式无效，请重新复制插件导出的完整链接清单。'); }
    function stringToken() {
      if (raw.charAt(offset) !== '"') invalid();
      var start = offset++;
      while (offset < raw.length) {
        var char = raw.charAt(offset++);
        if (char === '\\') offset++;
        else if (char === '"') return raw.slice(start, offset);
      }
      invalid();
    }
    function value(depth) {
      if (depth > MAX_DEPTH) issue('LINK_LIST_TOO_DEEP', '链接清单嵌套过深，请使用插件导出的 JSON。');
      whitespace();
      var char = raw.charAt(offset);
      if (char === '"') { stringToken(); return; }
      if (char === '{') {
        offset++; whitespace(); var keys = Object.create(null);
        if (raw.charAt(offset) === '}') { offset++; return; }
        while (offset < raw.length) {
          whitespace(); var key;
          try { key = JSON.parse(stringToken()); } catch (error) { if (error.code) throw error; invalid(); }
          if (own(keys, key)) issue('LINK_LIST_JSON_DUPLICATE_KEY', 'JSON 存在重复字段，会丢失原始数据，请重新导出完整清单。');
          keys[key] = true; whitespace();
          if (raw.charAt(offset++) !== ':') invalid();
          value(depth + 1); whitespace(); char = raw.charAt(offset++);
          if (char === '}') return;
          if (char !== ',') invalid();
        }
        invalid();
      }
      if (char === '[') {
        offset++; whitespace();
        if (raw.charAt(offset) === ']') { offset++; return; }
        while (offset < raw.length) {
          value(depth + 1); whitespace(); char = raw.charAt(offset++);
          if (char === ']') return;
          if (char !== ',') invalid();
        }
        invalid();
      }
      var start = offset;
      while (offset < raw.length && !/[\x20\t\r\n,\]}]/.test(raw.charAt(offset))) offset++;
      if (start === offset) invalid();
    }
    value(0); whitespace();
    if (offset !== raw.length) invalid();
  }
  function cloneJson(value, stack, depth) {
    stack = stack || []; depth = depth || 0;
    if (depth > MAX_DEPTH) issue('LINK_LIST_TOO_DEEP', '链接清单嵌套过深，请使用插件导出的 JSON。');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object') issue('LINK_LIST_VALUE_INVALID', '链接清单只能包含 JSON 数据。');
    if (stack.indexOf(value) >= 0) issue('LINK_LIST_VALUE_INVALID', '链接清单不能包含循环引用。');
    var proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) issue('LINK_LIST_VALUE_INVALID', '链接清单必须是普通 JSON 对象。');
    stack.push(value);
    var out = Array.isArray(value) ? [] : {};
    Object.keys(value).forEach(function (key) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') issue('LINK_LIST_UNSAFE_KEY', '链接清单包含不支持的对象键。');
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) issue('LINK_LIST_VALUE_INVALID', '链接清单不能包含执行逻辑。');
      out[key] = cloneJson(descriptor.value, stack, depth + 1);
    });
    stack.pop();
    return out;
  }
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (object(value)) return '{' + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ':' + stable(value[key]); }).join(',') + '}';
    return JSON.stringify(value);
  }
  // This local identity detects changed imports. It is never authorization.
  function fingerprint(value) {
    var raw = stable(value), a = 2166136261, b = 2246822519;
    for (var i = 0; i < raw.length; i++) { a = Math.imul(a ^ raw.charCodeAt(i), 16777619) >>> 0; b = Math.imul(b ^ raw.charCodeAt(i), 3266489917) >>> 0; }
    return VERSION + ':' + a.toString(16) + ':' + b.toString(16) + ':' + raw.length;
  }
  function canonicalLinkId(raw) {
    if (typeof raw !== 'string' && typeof raw !== 'number') return '';
    var value = String(raw).trim(), match = value.match(/^(?:[Ll]\s*)?0*(\d+)$/);
    var number = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(number) && number > 0 ? 'L' + String(number).padStart(3, '0') : '';
  }
  function rowId(row) {
    var ids = [];
    ['链接编号', 'linkId', 'link_id'].forEach(function (key) {
      if (!own(row, key) || row[key] === '' || row[key] === null) return;
      var id = canonicalLinkId(row[key]);
      if (!id) issue('LINK_LIST_ID_INVALID', '链接编号无效，请使用 L001 这样的完整编号。');
      if (ids.indexOf(id) < 0) ids.push(id);
    });
    if (!ids.length) issue('LINK_LIST_ID_REQUIRED', '每条链接都需要显式编号；不会自动补号。');
    if (ids.length !== 1) issue('LINK_LIST_ID_CONFLICT', '同一行的链接编号字段互相冲突。');
    return ids[0];
  }
  function rowSource(value) {
    if (Array.isArray(value)) return { rows: value, format: 'array', envelope: false };
    if (!object(value)) issue('LINK_LIST_SHAPE_INVALID', '请导入链接 JSON 对象或数组。');
    var present = ROW_KEYS.filter(function (key) { return own(value, key); });
    if (present.length > 1) issue('LINK_LIST_ROWS_AMBIGUOUS', '同一清单包含多个链接行容器，请只保留一个。');
    if (present.length) {
      if (!Array.isArray(value[present[0]])) issue('LINK_LIST_ROWS_INVALID', '链接行容器必须是数组。');
      return { rows: value[present[0]], format: 'envelope', envelope: true, key: present[0] };
    }
    return { rows: [value], format: 'row', envelope: false };
  }
  function categoryFrom(value, rows, options) {
    var declared = [], manual = options && own(options, 'category') ? options.category : '';
    function add(source) {
      if (!object(source)) return;
      ['category', '品类名', '品类'].forEach(function (key) {
        if (!own(source, key) || source[key] === null || source[key] === '') return;
        if (typeof source[key] !== 'string') issue('LINK_LIST_CATEGORY_INVALID', '品类必须是明确的文字名称。');
        var category = source[key].trim();
        if (category && declared.indexOf(category) < 0) declared.push(category);
      });
    }
    if (!Array.isArray(value)) add(value);
    rows.forEach(add);
    if (manual !== '' && manual !== null && typeof manual !== 'string') issue('LINK_LIST_CATEGORY_INVALID', '请填写文字品类。');
    manual = text(manual);
    if (declared.length > 1 || declared.length && manual && declared[0] !== manual) issue('LINK_LIST_CATEGORY_CONFLICT', '当前清单的品类不一致，不能静默覆盖。');
    var category = declared[0] || manual;
    if (!category) issue('LINK_LIST_CATEGORY_REQUIRED', '清单缺少品类，请明确填写后重新导入；系统不会根据定位猜测。');
    if (category.length > 120) issue('LINK_LIST_CATEGORY_INVALID', '品类名称最多 120 字符。');
    return category;
  }
  function indexById(value, label) {
    var out = Object.create(null);
    if (value == null) return out;
    if (!object(value)) issue('LINK_LIST_METADATA_INVALID', label + '必须是对象。');
    Object.keys(value).forEach(function (key) {
      var id = canonicalLinkId(key);
      if (!id) return; // Unrecognized metadata remains in bundle, never becomes a task.
      if (own(out, id)) issue('LINK_LIST_METADATA_AMBIGUOUS', label + '包含重复链接编号：' + id + '。');
      if (object(value[key])) ['linkId', 'link_id', '链接编号'].forEach(function (field) {
        if (own(value[key], field) && value[key][field] !== null && value[key][field] !== '' && canonicalLinkId(value[key][field]) !== id) issue('LINK_LIST_METADATA_LINK_MISMATCH', label + '的内部链接编号与所属链接不一致：' + id + '。');
      });
      out[id] = value[key];
    });
    return out;
  }
  function sources(bundle) {
    var source = rowSource(bundle), rows = Object.create(null);
    source.rows.forEach(function (row) { if (object(row)) { var id = rowId(row); if (!own(rows, id)) rows[id] = row; } });
    var plan = object(bundle) && object(bundle.subjectPlan) ? bundle.subjectPlan : null;
    if (plan && own(plan, 'schemaVersion') && plan.schemaVersion !== 'SUBJECT_PLAN_V1') issue('LINK_LIST_SUBJECT_VERSION_UNSUPPORTED', '主体建议版本不兼容，请重新导出清单。');
    if (plan && own(plan, 'tasks') && !Array.isArray(plan.tasks)) issue('LINK_LIST_SUBJECT_INVALID', '商品主体任务必须是数组。');
    var tasks = Object.create(null);
    (plan && Array.isArray(plan.tasks) ? plan.tasks : []).forEach(function (task) {
      if (!object(task) || !text(task.subjectTaskId)) issue('LINK_LIST_SUBJECT_INVALID', '每个商品主体建议都需要明确的任务编号。');
      var id = text(task.subjectTaskId);
      if (own(tasks, id)) issue('LINK_LIST_SUBJECT_AMBIGUOUS', '商品主体任务编号重复：' + id + '。');
      tasks[id] = task;
    });
    var bindings = indexById(plan ? plan.bindingsByLinkId : null, '主体绑定');
    Object.keys(bindings).forEach(function (id) {
      var binding = bindings[id], taskId = object(binding) && text(binding.subjectTaskId), task = tasks[taskId];
      if (!task) issue('LINK_LIST_SUBJECT_BINDING_INVALID', id + ' 的主体任务不存在，请校对绑定关系。');
      if (own(task, 'linkIds') && (!Array.isArray(task.linkIds) || !task.linkIds.some(function (linkId) { return canonicalLinkId(linkId) === id; }))) issue('LINK_LIST_SUBJECT_LINK_MISMATCH', id + ' 不属于所绑定的主体任务，不能使用其他链接的素材建议。');
    });
    return { rows: rows, metadata: indexById(object(bundle) ? bundle.linkMetadata : null, '商业元数据'), plan: plan, tasks: tasks,
      bindings: bindings, requirements: indexById(plan ? plan.requirementsByLinkId : null, '主体需求') };
  }
  function planFor(index, id) {
    var row = index.rows[id] || {}, meta = index.metadata[id] || {};
    var plan = object(row['营销企划']) ? row['营销企划'] : object(row.marketingPlan) ? row.marketingPlan : meta.marketingPlan;
    return object(plan) ? cloneJson(plan) : null;
  }
  function assetReferences(items, role) {
    return (Array.isArray(items) ? items : []).filter(object).map(function (item) {
      var out = {};
      ['assetId', 'role', 'angle', 'name', 'type', 'contentHash'].forEach(function (key) { out[key] = text(item[key]); });
      out.assetId = out.assetId || text(item.id); out.role = out.role || role;
      out.size = Number.isFinite(item.size) && item.size >= 0 ? item.size : 0;
      return out;
    }).filter(function (item) { return !!item.assetId; });
  }
  function uniqueReferenceCount(items) {
    var seen = Object.create(null);
    items.forEach(function (item) { seen[item.contentHash ? 'hash:' + item.contentHash : 'id:' + item.assetId] = true; });
    return Object.keys(seen).length;
  }
  function requirementFor(index, id) {
    var binding = object(index.bindings[id]) ? index.bindings[id] : {}, requirement = object(index.requirements[id]) ? index.requirements[id] : {};
    var taskId = text(binding.subjectTaskId), task = index.tasks[taskId] || {};
    var products = assetReferences(task.subjectAssets, 'subject'), models = assetReferences(task.modelAssets, 'model');
    return { linkId: id, hasSubjectPlan: !!index.plan, subjectTaskId: taskId, subjectBindingId: text(binding.subjectBindingId) || text(task.subjectBindingId),
      skuId: text(binding.skuId) || text(task.skuId), label: text(task.label), productName: text(task.subjectCategory),
      hardAttributes: cloneJson(object(requirement.hardAttributes) ? requirement.hardAttributes : object(task.hardAttributes) ? task.hardAttributes : {}),
      softAttributes: cloneJson(object(requirement.softAttributes) ? requirement.softAttributes : object(task.softAttributes) ? task.softAttributes : {}),
      requiredFacts: cloneJson(Array.isArray(requirement.requiredFacts) ? requirement.requiredFacts : Array.isArray(task.requiredFacts) ? task.requiredFacts : []),
      sourceSubjectFacts: cloneJson(object(task.subjectFacts) ? task.subjectFacts : {}), sourceSubjectFactsApproved: task.subjectFactsApproved === true,
      sourceDecision: text(task.decision), sourceMatchStatus: text(binding.matchStatus),
      localReferences: { products: products, models: models }, localProductReferenceCount: uniqueReferenceCount(products), localModelReferenceCount: uniqueReferenceCount(models),
      requiresUpload: true, requiresRebinding: true, localAssetsBound: false, canExecute: false, metadataOnly: true,
      message: index.plan ? '清单只携带插件本机素材引用。请在当前账号重新上传并绑定本条链接的产品主体图和模特图。' : '请为本条链接上传并绑定当前账号的产品主体图及需要的模特图。' };
  }
  function parse(raw, options) {
    try {
      options = object(options) ? cloneJson(options) : {};
      if (typeof raw === 'string') {
        raw = raw.replace(/^\uFEFF/, '').trim();
        if (!raw) return fail('LINK_LIST_EMPTY', '请粘贴或选择链接清单 JSON。');
        if (bytes(raw) > MAX_BYTES) return fail('LINK_LIST_TOO_LARGE', '链接清单 JSON 超过 32 MiB，请拆分后导入。');
        rejectDuplicateJsonKeys(raw);
        try { raw = JSON.parse(raw); } catch (_) { return fail('LINK_LIST_JSON_INVALID', 'JSON 格式无效，请重新复制插件导出的完整链接清单。'); }
      }
      var value = cloneJson(raw), serialized = JSON.stringify(value);
      if (bytes(serialized) > MAX_BYTES) return fail('LINK_LIST_TOO_LARGE', '链接清单 JSON 超过 32 MiB，请拆分后导入。');
      var source = rowSource(value);
      if (!source.rows.length) return fail('LINK_LIST_ROWS_EMPTY', '链接清单没有可用行。');
      if (source.rows.length > MAX_ROWS) return fail('LINK_LIST_ROWS_LIMIT', '每份清单最多 20000 条链接，请拆分导入。');
      if (object(value) && own(value, 'rowContractVersion') && value.rowContractVersion !== 1) return fail('LINK_LIST_VERSION_UNSUPPORTED', '仅支持 rowContractVersion: 1，请使用兼容版本的链接清单。');
      ['businessContext', 'linkMetadata', 'subjectPlan'].forEach(function (key) {
        if (source.envelope && own(value, key) && value[key] !== null && !object(value[key])) issue('LINK_LIST_METADATA_INVALID', key + '必须是 JSON 对象。');
      });
      var seen = Object.create(null), rows = source.rows.map(function (row, index) {
        if (!object(row)) issue('LINK_LIST_ROW_INVALID', '第 ' + (index + 1) + ' 条链接不是有效对象。');
        var id = rowId(row);
        if (own(seen, id)) issue('LINK_LIST_ID_DUPLICATE', '链接编号重复：' + id + '。不会自动重排或补号。');
        seen[id] = true;
        var out = {};
        FIELDS.forEach(function (field) {
          var item = own(row, field) ? row[field] : '';
          if (item === null) item = '';
          if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') issue('LINK_LIST_FIELD_INVALID', id + ' 的“' + field + '”必须是文字或数值。');
          out[field] = field === '链接编号' ? id : item;
        });
        return out;
      });
      var category = categoryFrom(value, source.rows, options);
      var bundle = source.envelope ? value : { category: category, rowContractVersion: 1, rows: value && Array.isArray(value) ? value : [value] };
      if (!text(bundle.category)) bundle.category = category;
      var index = sources(bundle), tasks = rows.map(function (row) {
        var id = row['链接编号'], requirement = requirementFor(index, id);
        return { linkId: id, subjectTaskId: requirement.subjectTaskId, skuId: requirement.skuId, subjectRequirement: requirement, marketingPlan: planFor(index, id) };
      });
      var identity = fingerprint(bundle);
      return { ok: true, version: VERSION, bundleId: identity, fingerprint: identity, category: category, rows: rows, bundle: bundle, tasks: tasks, sourceFormat: source.format };
    } catch (error) {
      return fail(error && error.code || 'LINK_LIST_INVALID', error && error.code ? error.message : '链接清单无法安全读取，请使用插件导出的 JSON。');
    }
  }
  function marketingPlanForLink(bundle, id) {
    try { return planFor(sources(cloneJson(bundle)), canonicalLinkId(id)); } catch (_) { return null; }
  }
  function bindingRequirement(bundle, id) {
    try { return requirementFor(sources(cloneJson(bundle)), canonicalLinkId(id)); }
    catch (_) { return { linkId: canonicalLinkId(id), requiresUpload: true, requiresRebinding: true, localAssetsBound: false, canExecute: false, metadataOnly: true, localReferences: { products: [], models: [] }, localProductReferenceCount: 0, localModelReferenceCount: 0, error: '主体需求元数据无效，请重新上传并明确绑定。' }; }
  }
  return Object.freeze({ version: VERSION, rowContractVersion: 1, rowFields: Object.freeze(FIELDS.slice()), maxRows: MAX_ROWS, maxBytes: MAX_BYTES,
    parse: parse, canonicalLinkId: canonicalLinkId, marketingPlanForLink: marketingPlanForLink, bindingRequirement: bindingRequirement });
});
