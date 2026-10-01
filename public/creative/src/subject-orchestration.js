/* subject-orchestration.js — 链接清单到商品主体、SKU 与视觉生产子批次的共享合同 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SZ_SUBJECT_ORCHESTRATION = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 'SUBJECT_PLAN_V1';
  var ROW_FIELDS = [
    '链接编号', '生成方式', '链接分组', '链接定位', '主推关键词', '用户场景需求', '来源关键词',
    '竞品未覆盖词根', '差异化定位逻辑', '标题结构', '标题定位词路', '商品标题', '标题冲突处理',
    '主图核心文案', '详情页定位', '详情页文案', '详情文案逻辑', '优先级分数', '优先级', '数据状态'
  ];
  var MATCH_STATUS = {
    pending: '待选择', exact: '有完全匹配商品', near: '有相近商品', no_product: '暂无对应商品',
    skipped: '本批跳过', later: '稍后处理', override: '用户明确覆盖'
  };
  var MATERIALS = [
    ['长绒棉', /长绒棉/], ['全棉', /全棉/], ['纯棉', /纯棉/], ['水洗棉', /水洗棉/], ['磨毛', /磨毛/],
    ['牛奶绒', /牛奶绒/], ['珊瑚绒', /珊瑚绒/], ['法兰绒', /法兰绒/], ['天丝', /天丝|莱赛尔/],
    ['真丝', /真丝|桑蚕丝/], ['亚麻', /亚麻/], ['聚酯纤维', /聚酯纤维|涤纶/]
  ];
  var STRUCTURES = [
    ['床笠款四件套', /床笠(?:款)?四件套|四件套[^。；，,]{0,8}床笠/],
    ['床单款四件套', /床单(?:款)?四件套|四件套[^。；，,]{0,8}床单/],
    ['四件套', /四件套|4件套/], ['三件套', /三件套|3件套/], ['六件套', /六件套|6件套/],
    ['被套单件', /被套单件|单被套/], ['床单单件', /床单单件|单床单/], ['枕套单件', /枕套单件|单枕套/]
  ];
  var SIZES = [
    ['1.2米床', /1[.。]2\s*(?:米|m)床?/i], ['1.5米床', /1[.。]5\s*(?:米|m)床?/i],
    ['1.8米床', /1[.。]8\s*(?:米|m)床?/i], ['2.0米床', /2[.。]0\s*(?:米|m)床?/i],
    ['宿舍床', /宿舍|学生床|单人床/], ['加大床', /加大床|大床|双人床/]
  ];
  var STYLES = [
    ['奶油风', /奶油风|奶油系/], ['法式', /法式/], ['轻奢', /轻奢/], ['简约', /简约|极简/],
    ['国风', /国风|新中式/], ['田园', /田园/], ['ins风', /\bins\b|ins风/i], ['卡通', /卡通|动漫/],
    ['纯色', /纯色/], ['花卉', /花卉|碎花|印花/], ['格纹', /格纹|格子/]
  ];
  var FUNCTIONS = [
    ['A类', /\bA类\b|婴幼儿A类/i], ['抗菌', /抗菌|抑菌/], ['防螨', /防螨/], ['保暖', /保暖|加厚/],
    ['凉感', /凉感|冰丝/], ['裸睡', /裸睡/], ['不易起球', /不起球|不易起球/], ['不易褪色', /不褪色|不易褪色/]
  ];
  var FOUR_PIECE_RE = /四件套|4件套|床上用品|床品套件|被套|床单|床笠|枕套/;

  function text(value) { return String(value == null ? '' : value).trim(); }
  function plain(value) { return !!(value && typeof value === 'object' && !Array.isArray(value)); }
  function clone(value) {
    if (value == null) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
  }
  function stableObject(value) {
    if (Array.isArray(value)) return value.map(stableObject);
    if (!plain(value)) return value;
    return Object.keys(value).sort().reduce(function (out, key) { out[key] = stableObject(value[key]); return out; }, {});
  }
  function stableJson(value) { return JSON.stringify(stableObject(value)); }
  function hash(value, prefix) {
    var raw = typeof value === 'string' ? value : stableJson(value);
    var h1 = 0x811c9dc5, h2 = 0x9e3779b9;
    for (var i = 0; i < raw.length; i++) {
      var code = raw.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ (code + i), 0x85ebca6b) >>> 0;
    }
    return (prefix || 'fp') + ':' + raw.length + ':' + h1.toString(16) + ':' + h2.toString(16);
  }
  function canonicalLinkId(value, index) {
    var found = text(value).match(/(?:^|[^A-Z])L\s*0*(\d+)/i);
    var n = found ? Number(found[1]) : (Number(index) + 1);
    if (!isFinite(n) || n < 1) n = Number(index) + 1;
    return 'L' + String(Math.floor(n)).padStart(3, '0');
  }
  function subjectTaskId(index) { return 'S' + String(Number(index) + 1).padStart(3, '0'); }
  function payloadRows(payload) {
    var value = payload;
    if (plain(value)) value = value.rows || value.linksJson || value.linkRows || [];
    return (Array.isArray(value) ? value : []).filter(plain).map(function (row) { return clone(row); });
  }
  function rowText(row) {
    return ['商品标题', '链接定位', '主推关键词', '用户场景需求', '来源关键词', '竞品未覆盖词根',
      '差异化定位逻辑', '标题定位词路', '主图核心文案', '详情页定位', '详情页文案']
      .map(function (key) { return text(row && row[key]); }).filter(Boolean).join('｜');
  }
  function matchFirst(source, specs) {
    for (var i = 0; i < specs.length; i++) if (specs[i][1].test(source)) return specs[i][0];
    return '';
  }
  function matchAll(source, specs) {
    var out = [];
    specs.forEach(function (spec) { if (spec[1].test(source) && out.indexOf(spec[0]) < 0) out.push(spec[0]); });
    return out;
  }
  function categoryFamily(category, source) {
    var joined = text(category) + '｜' + source;
    if (FOUR_PIECE_RE.test(joined)) return '四件套';
    return text(category) || matchFirst(source, [['服装', /衣|裤|裙|衫|外套/], ['食品', /食品|零食|饮料|调味/]]) || '当前类目商品';
  }
  function hardStructureFor(category, source) {
    var structure = matchFirst(source, STRUCTURES);
    if (category === '四件套' && !structure) structure = '四件套';
    return structure || category;
  }
  function linkRequirement(row, category, index) {
    var source = rowText(row);
    var family = categoryFamily(category, source);
    var structure = hardStructureFor(family, source);
    var material = matchFirst(source, MATERIALS);
    var size = matchFirst(source, SIZES);
    var styles = matchAll(source, STYLES);
    var functions = matchAll(source, FUNCTIONS);
    var unsupported = family === '四件套' && /三件套|六件套|被套单件|床单单件|枕套单件/.test(structure);
    var hard = { category: family, structure: structure, material: material, size: size };
    var key = [family, structure, material || '材质待确认', size || '尺码可共用'].join('|');
    var requiredFacts = [structure, material, size].filter(Boolean);
    return {
      linkId: canonicalLinkId(row && row['链接编号'], index),
      category: family,
      subjectCategory: family === '四件套' ? structure : family,
      taskKey: key,
      hardAttributes: hard,
      softAttributes: { styles: styles, functions: functions },
      requiredFacts: requiredFacts,
      unsupported: unsupported,
      unsupportedReason: unsupported ? ('目标为四件套，但本链接要求“' + structure + '”，不可静默用四件套主体承接') : '',
      sourceSummary: source.slice(0, 600),
      requirementFingerprint: hash({ linkId: canonicalLinkId(row && row['链接编号'], index), hard: hard, soft: { styles: styles, functions: functions } }, 'req1')
    };
  }
  function taskLabel(requirement) {
    var bits = [requirement.hardAttributes.material, requirement.hardAttributes.structure, requirement.hardAttributes.size].filter(Boolean);
    return bits.join(' · ') || requirement.subjectCategory || requirement.category;
  }
  function defaultVisualProfile(route) {
    return {
      route: route, approved: false, visualProfileId: '', style: '', layout: '', lighting: '', copyMode: '',
      templateAssetIds: [], fingerprint: hash({ route: route, approved: false }, 'visual1')
    };
  }
  function normalizeAssetRefs(items, role) {
    return (Array.isArray(items) ? items : []).filter(function (item) { return item && (item.assetId || item.id); }).slice(0, role === 'subject' ? 3 : 6).map(function (item) {
      return {
        assetId: text(item.assetId || item.id), role: text(item.role || role), angle: text(item.angle || ''),
        name: text(item.name || '').slice(0, 160), type: text(item.type || '').slice(0, 80), size: Number(item.size) || 0,
        contentHash: text(item.contentHash || '')
      };
    });
  }
  function factsFingerprint(facts) {
    facts = plain(facts) ? facts : {};
    return hash({
      productName: text(facts.productName), category: text(facts.category), structure: text(facts.structure),
      material: text(facts.material), size: text(facts.size), colors: Array.isArray(facts.colors) ? facts.colors.map(text).filter(Boolean) : [],
      style: text(facts.style), process: text(facts.process), notes: text(facts.notes), acceptedInnovation: text(facts.acceptedInnovation)
    }, 'facts1');
  }
  function clearIdentityText(value) {
    value = text(value);
    if (!value || /^(?:当前|目标|未知|未识别|待确认|待填写)?(?:类目)?商品$/.test(value) || /^(?:当前|未知|未识别|待确认|待填写)?品类$/.test(value)) return '';
    return value;
  }
  function productionFacts(task) {
    task = plain(task) ? task : {};
    var approved = task.subjectFactsApproved === true ? normalizedFacts(task.subjectFacts) : normalizedFacts({});
    var hard = plain(task.hardAttributes) ? task.hardAttributes : {};
    var category = approved.category || clearIdentityText(task.category);
    var structure = approved.structure || clearIdentityText(hard.structure);
    var productName = approved.productName || clearIdentityText(task.subjectCategory) || structure || category;
    return {
      productName: productName,
      category: category,
      structure: structure,
      material: approved.material || text(hard.material),
      size: approved.size || (text(hard.size) === '尺码可共用' ? '' : text(hard.size)),
      colors: approved.colors,
      style: approved.style,
      process: approved.process,
      notes: approved.notes,
      acceptedInnovation: approved.acceptedInnovation
    };
  }
  function subjectFactsSource(task) {
    if (task && task.subjectFactsApproved === true) return 'user_confirmed';
    return clearIdentityText(productionFacts(task).productName) ? 'link_plan' : '';
  }
  function subjectFingerprint(task) {
    task = task || {};
    return hash({
      skuId: text(task.skuId), decision: text(task.decision),
      assets: normalizeAssetRefs(task.subjectAssets, 'subject').map(function (item) { return [item.assetId, item.contentHash, item.angle]; }),
      factsFingerprint: factsFingerprint(productionFacts(task))
    }, 'subject1');
  }
  function visualProfileFingerprint(profile) {
    profile = plain(profile) ? profile : {};
    return hash({ route: text(profile.route), approved: profile.approved === true, style: text(profile.style), layout: text(profile.layout),
      lighting: text(profile.lighting), copyMode: text(profile.copyMode), templateAssetIds: (profile.templateAssetIds || []).map(text).filter(Boolean) }, 'visual1');
  }
  function refreshTaskFingerprints(task) {
    task.subjectAssets = normalizeAssetRefs(task.subjectAssets, 'subject');
    task.modelAssets = normalizeAssetRefs(task.modelAssets, 'model');
    task.subjectFactsFingerprint = factsFingerprint(productionFacts(task));
    task.subjectFingerprint = subjectFingerprint(task);
    task.subjectBindingId = text(task.subjectBindingId) || ('B-' + hash({ taskId: task.subjectTaskId, skuId: task.skuId || '', subject: task.subjectFingerprint }, 'binding1').split(':').slice(-2).join('-'));
    task.visualProfiles = plain(task.visualProfiles) ? task.visualProfiles : {};
    ['main', 'detail'].forEach(function (route) {
      var profile = Object.assign(defaultVisualProfile(route), task.visualProfiles[route] || {}, { route: route });
      profile.templateAssetIds = (profile.templateAssetIds || []).map(text).filter(Boolean).slice(0, 6);
      profile.fingerprint = visualProfileFingerprint(profile);
      if (!profile.visualProfileId && profile.approved) profile.visualProfileId = 'VP-' + route + '-' + profile.fingerprint.split(':').slice(-1)[0];
      task.visualProfiles[route] = profile;
    });
    return task;
  }
  function taskStatus(task) {
    var decision = text(task && task.decision) || 'pending';
    if (decision === 'no_product') return task.openingReport ? 'report_ready' : 'needs_report';
    if (decision === 'skipped') return 'skipped';
    if (decision === 'later') return 'later';
    if (!['exact', 'near', 'override'].includes(decision)) return 'pending';
    if (!(task.subjectAssets && task.subjectAssets.length)) return 'needs_assets';
    if (!subjectFactsSource(task)) return 'needs_facts';
    return 'ready';
  }
  function mergePriorTask(task, previous) {
    if (!previous) return task;
    ['decision', 'skuId', 'subjectBindingId', 'subjectFacts', 'subjectFactsApproved', 'subjectAssets', 'modelAssets',
      'recognition', 'recognitionApprovedAt', 'visualProfiles', 'openingReport', 'userNote', 'overrideReason'].forEach(function (key) {
      if (previous[key] != null) task[key] = clone(previous[key]);
    });
    return task;
  }
  function createPlan(payload, previousPlan) {
    payload = plain(payload) ? payload : { rows: payload };
    var rows = payloadRows(payload);
    var category = text(payload.category || payload['品类名'] || payload['品类']);
    var requirements = rows.map(function (row, index) { return linkRequirement(row, category, index); });
    var previousByKey = {};
    ((previousPlan && previousPlan.tasks) || []).forEach(function (task) { if (task && task.taskKey) previousByKey[task.taskKey] = task; });
    var grouped = {};
    requirements.forEach(function (req) {
      if (!grouped[req.taskKey]) grouped[req.taskKey] = [];
      grouped[req.taskKey].push(req);
    });
    var taskKeys = Object.keys(grouped).sort(function (a, b) {
      var ai = requirements.findIndex(function (req) { return req.taskKey === a; });
      var bi = requirements.findIndex(function (req) { return req.taskKey === b; });
      return ai - bi || a.localeCompare(b, 'zh-CN');
    });
    var usedPreviousIds = {};
    var nextSeq = 0;
    var tasks = taskKeys.map(function (key) {
      var list = grouped[key];
      var first = list[0];
      var previous = previousByKey[key];
      var taskId = previous && previous.subjectTaskId;
      if (!taskId || usedPreviousIds[taskId]) {
        while (usedPreviousIds[subjectTaskId(nextSeq)]) nextSeq++;
        taskId = subjectTaskId(nextSeq++);
      }
      usedPreviousIds[taskId] = true;
      var task = {
        subjectTaskId: taskId, taskKey: key, label: taskLabel(first), category: first.category, subjectCategory: first.subjectCategory,
        hardAttributes: clone(first.hardAttributes), softAttributes: {
          styles: Array.from(new Set([].concat.apply([], list.map(function (item) { return item.softAttributes.styles; })))),
          functions: Array.from(new Set([].concat.apply([], list.map(function (item) { return item.softAttributes.functions; }))))
        },
        requiredFacts: Array.from(new Set([].concat.apply([], list.map(function (item) { return item.requiredFacts; })))),
        linkIds: list.map(function (item) { return item.linkId; }),
        unsupportedLinkIds: list.filter(function (item) { return item.unsupported; }).map(function (item) { return item.linkId; }),
        unsupportedReason: list.map(function (item) { return item.unsupportedReason; }).filter(Boolean)[0] || '',
        decision: 'pending', skuId: '', subjectBindingId: '', subjectFacts: {}, subjectFactsApproved: false,
        subjectAssets: [], modelAssets: [], recognition: null, visualProfiles: { main: defaultVisualProfile('main'), detail: defaultVisualProfile('detail') },
        openingReport: null, createdAt: Date.now(), updatedAt: Date.now()
      };
      mergePriorTask(task, previous);
      refreshTaskFingerprints(task);
      task.status = taskStatus(task);
      return task;
    });
    var bindingsByLinkId = {};
    var requirementsByLinkId = {};
    requirements.forEach(function (requirement) {
      var task = tasks.find(function (item) { return item.taskKey === requirement.taskKey; });
      requirementsByLinkId[requirement.linkId] = requirement;
      bindingsByLinkId[requirement.linkId] = {
        linkId: requirement.linkId, subjectTaskId: task.subjectTaskId, subjectBindingId: task.subjectBindingId,
        skuId: text(task.skuId), matchStatus: text(task.decision) || 'pending', override: task.decision === 'override' || task.decision === 'near',
        requirementFingerprint: requirement.requirementFingerprint
      };
    });
    var rowsFingerprint = hash(rows.map(function (row, index) {
      return ROW_FIELDS.map(function (field) { return field === '链接编号' ? canonicalLinkId(row[field], index) : text(row[field]); });
    }), 'subjectrows1');
    var plan = {
      schemaVersion: VERSION, planId: 'SP-' + rowsFingerprint.split(':').slice(-1)[0], category: category,
      rowsFingerprint: rowsFingerprint, planFingerprint: '', tasks: tasks, bindingsByLinkId: bindingsByLinkId,
      requirementsByLinkId: requirementsByLinkId, advisoryOnly: true, blocksLinkConfirmation: false,
      createdAt: previousPlan && previousPlan.createdAt || Date.now(), updatedAt: Date.now()
    };
    plan.planFingerprint = hash({ rowsFingerprint: rowsFingerprint, requirements: requirementsByLinkId, taskKeys: taskKeys }, 'plan1');
    return plan;
  }
  function syncBindings(plan) {
    var tasksById = {};
    (plan.tasks || []).forEach(function (task) {
      refreshTaskFingerprints(task);
      task.status = taskStatus(task);
      tasksById[task.subjectTaskId] = task;
    });
    Object.keys(plan.bindingsByLinkId || {}).forEach(function (linkId) {
      var binding = plan.bindingsByLinkId[linkId];
      var task = tasksById[binding.subjectTaskId];
      if (!task) return;
      binding.subjectBindingId = task.subjectBindingId;
      binding.skuId = text(task.skuId);
      binding.matchStatus = text(task.decision) || 'pending';
      binding.override = task.decision === 'override' || task.decision === 'near';
    });
    plan.updatedAt = Date.now();
    return plan;
  }
  function remapLinkIds(plan, sourceRows, nextRows) {
    if (!plain(plan)) return plan;
    plan = clone(plan);
    var map = {};
    (sourceRows || []).forEach(function (row, index) {
      var oldId = canonicalLinkId(row && row['链接编号'], index);
      var newId = canonicalLinkId(nextRows && nextRows[index] && nextRows[index]['链接编号'], index);
      map[oldId] = newId;
    });
    function remapObject(source) {
      return Object.keys(source || {}).reduce(function (out, oldId) {
        if (!map[oldId]) return out;
        var value = clone(source[oldId]);
        if (plain(value)) value.linkId = map[oldId];
        out[map[oldId]] = value;
        return out;
      }, {});
    }
    plan.bindingsByLinkId = remapObject(plan.bindingsByLinkId);
    plan.requirementsByLinkId = remapObject(plan.requirementsByLinkId);
    Object.keys(plan.requirementsByLinkId || {}).forEach(function (linkId) {
      var requirement = plan.requirementsByLinkId[linkId];
      requirement.linkId = linkId;
      requirement.requirementFingerprint = hash({ linkId: linkId, hard: requirement.hardAttributes || {}, soft: requirement.softAttributes || {} }, 'req1');
      if (plan.bindingsByLinkId[linkId]) plan.bindingsByLinkId[linkId].requirementFingerprint = requirement.requirementFingerprint;
    });
    plan.tasks = (plan.tasks || []).map(function (task) {
      task.linkIds = (task.linkIds || []).map(function (id) { return map[id]; }).filter(Boolean);
      task.unsupportedLinkIds = (task.unsupportedLinkIds || []).map(function (id) { return map[id]; }).filter(Boolean);
      return task;
    }).filter(function (task) { return task.linkIds.length; });
    plan.rowsFingerprint = hash((nextRows || []).map(function (row, index) {
      return ROW_FIELDS.map(function (field) { return field === '链接编号' ? canonicalLinkId(row && row[field], index) : text(row && row[field]); });
    }), 'subjectrows1');
    plan.planFingerprint = hash({ rowsFingerprint: plan.rowsFingerprint, requirements: plan.requirementsByLinkId,
      taskKeys: (plan.tasks || []).map(function (task) { return task.taskKey; }) }, 'plan1');
    return syncBindings(plan);
  }
  function planSummary(plan) {
    var tasks = (plan && plan.tasks) || [];
    var counts = { ready: 0, pending: 0, noProduct: 0, skipped: 0, total: tasks.length, links: 0 };
    tasks.forEach(function (task) {
      counts.links += (task.linkIds || []).length;
      var status = taskStatus(task);
      if (status === 'ready') counts.ready++;
      else if (status === 'needs_report' || status === 'report_ready') counts.noProduct++;
      else if (status === 'skipped' || status === 'later') counts.skipped++;
      else counts.pending++;
    });
    return counts;
  }
  function normalizedFacts(facts) {
    facts = plain(facts) ? facts : {};
    return {
      productName: text(facts.productName), category: text(facts.category), structure: text(facts.structure), material: text(facts.material),
      size: text(facts.size), colors: Array.isArray(facts.colors) ? facts.colors.map(text).filter(Boolean) : text(facts.colors).split(/[,，、|]/).map(text).filter(Boolean),
      style: text(facts.style), process: text(facts.process), notes: text(facts.notes), acceptedInnovation: text(facts.acceptedInnovation)
    };
  }
  function evaluateMatch(task, facts) {
    facts = normalizedFacts(facts);
    var expected = task && task.hardAttributes || {};
    var conflicts = [], missing = [], matched = [];
    [['category', '品类'], ['structure', '结构/件套'], ['material', '材质'], ['size', '尺码']].forEach(function (entry) {
      var key = entry[0], label = entry[1], need = text(expected[key]), actual = text(facts[key]);
      if (!need || (key === 'size' && need === '尺码可共用')) return;
      if (!actual) missing.push(label + '待确认');
      else if (actual.indexOf(need) >= 0 || need.indexOf(actual) >= 0) matched.push(label);
      else conflicts.push(label + '要求“' + need + '”，当前主体为“' + actual + '”');
    });
    var score = Math.max(0, Math.min(100, 100 - conflicts.length * 35 - missing.length * 12));
    return { ok: conflicts.length === 0, score: score, conflicts: conflicts, missing: missing, matched: matched,
      level: conflicts.length ? 'mismatch' : (missing.length ? 'needs_confirmation' : 'matched') };
  }
  function marketRows(input) {
    if (plain(input)) input = input.rows || input.data || [];
    return (Array.isArray(input) ? input : []).filter(plain);
  }
  function marketTitle(row) { return text(row['商品名称'] || row['商品标题'] || row.title || row.name); }
  function marketRank(row, index) { return Number(row['排名'] || row.rank) || index + 1; }
  function buildOpeningReport(task, marketInput) {
    var rows = marketRows(marketInput);
    var required = (task && task.requiredFacts || []).filter(Boolean);
    var candidates = rows.map(function (row, index) {
      var title = marketTitle(row);
      var hits = required.filter(function (term) { return title.indexOf(term) >= 0; });
      return { row: row, title: title, rank: marketRank(row, index), hits: hits, score: hits.length * 1000 - marketRank(row, index) };
    }).filter(function (item) { return item.title && item.hits.length; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 12);
    if (!rows.length) {
      return { schemaVersion: 'OPENING_REPORT_V1', evidenceStatus: 'insufficient', message: '当前没有可用 Top300 市场证据，系统不会臆造开款结论。请先采集市场排行后重试。',
        taskId: task && task.subjectTaskId || '', requiredFacts: required, benchmarks: [], suggestions: [], generatedAt: Date.now() };
    }
    if (!candidates.length) {
      return { schemaVersion: 'OPENING_REPORT_V1', evidenceStatus: 'insufficient', message: 'Top300 中没有找到与本主体任务硬属性直接匹配的商品，暂不能给出有证据的差异化结论。',
        taskId: task && task.subjectTaskId || '', requiredFacts: required, benchmarks: [], suggestions: [], generatedAt: Date.now() };
    }
    var styleCounts = {};
    candidates.forEach(function (item) {
      matchAll(item.title, STYLES).forEach(function (style) { styleCounts[style] = (styleCounts[style] || 0) + 1; });
    });
    var commonStyles = Object.keys(styleCounts).sort(function (a, b) { return styleCounts[b] - styleCounts[a]; }).slice(0, 3);
    var suggestions = [
      '保持“' + required.join(' + ') + '”硬属性不变，从榜单高频风格“' + (commonStyles.join('、') || '未形成明显集中') + '”中选择一个明确视觉方向。',
      '优先对 Top' + Math.min.apply(null, candidates.map(function (item) { return item.rank; })) + '–Top' + Math.max.apply(null, candidates.map(function (item) { return item.rank; })) + ' 的标题与卖点做结构化对比，只借鉴需求表达，不复制商品主体、品牌或版式。',
      '微创新只写入开发建议；用户采纳并补充为 SKU 事实前，不进入生产提示词和生图。'
    ];
    return {
      schemaVersion: 'OPENING_REPORT_V1', evidenceStatus: 'supported', message: '已基于当前 Top300 中 ' + candidates.length + ' 个直接匹配样本形成开款建议。',
      taskId: task && task.subjectTaskId || '', requiredFacts: required,
      benchmarks: candidates.map(function (item) { return { rank: item.rank, title: item.title, hits: item.hits, imageUrl: text(item.row['商品图片URL'] || item.row.imageUrl), productUrl: text(item.row['商品链接'] || item.row.url) }; }),
      commonStyles: commonStyles, suggestions: suggestions, marketFingerprint: hash(rows.map(function (row, index) { return [marketRank(row, index), marketTitle(row)]; }), 'market1'),
      generatedAt: Date.now()
    };
  }
  function orchestrationContext(plan, taskId, route) {
    route = route === 'detail' ? 'detail' : 'main';
    var task = (plan && plan.tasks || []).find(function (item) { return item.subjectTaskId === taskId; });
    if (!task) return null;
    refreshTaskFingerprints(task);
    var visual = task.visualProfiles[route] || defaultVisualProfile(route);
    var facts = productionFacts(task);
    return {
      orchestrationBatchId: 'OB-' + hash({ plan: plan.planFingerprint, createdAt: plan.createdAt || 0 }, 'orchestration1').split(':').slice(-1)[0],
      subjectBatchId: 'SB-' + route + '-' + hash({ route: route, taskId: task.subjectTaskId, binding: task.subjectBindingId, skuId: task.skuId,
        subject: task.subjectFingerprint, facts: task.subjectFactsFingerprint, visual: visual.fingerprint }, 'subjectbatch1').split(':').slice(-1)[0],
      subjectTaskId: task.subjectTaskId, subjectBindingId: task.subjectBindingId, skuId: text(task.skuId),
      subjectFingerprint: task.subjectFingerprint, subjectFactsFingerprint: task.subjectFactsFingerprint,
      subjectFacts: facts, subjectFactsSource: subjectFactsSource(task),
      visualProfileId: text(visual.visualProfileId), visualProfileFingerprint: text(visual.fingerprint), route: route,
      linkIds: (task.linkIds || []).slice(), override: task.decision === 'override' || task.decision === 'near'
    };
  }

  return Object.freeze({
    version: VERSION, rowFields: ROW_FIELDS.slice(), matchStatus: Object.assign({}, MATCH_STATUS),
    hash: hash, stableJson: stableJson, canonicalLinkId: canonicalLinkId, subjectTaskId: subjectTaskId,
    payloadRows: payloadRows, linkRequirement: linkRequirement, createPlan: createPlan, syncBindings: syncBindings,
    remapLinkIds: remapLinkIds, planSummary: planSummary, taskStatus: taskStatus, refreshTaskFingerprints: refreshTaskFingerprints,
    factsFingerprint: factsFingerprint, subjectFingerprint: subjectFingerprint, visualProfileFingerprint: visualProfileFingerprint,
    normalizeAssetRefs: normalizeAssetRefs, normalizedFacts: normalizedFacts, productionFacts: productionFacts,
    subjectFactsSource: subjectFactsSource, evaluateMatch: evaluateMatch,
    buildOpeningReport: buildOpeningReport, orchestrationContext: orchestrationContext
  });
});
