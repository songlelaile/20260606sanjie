/* knowledge-output-contract.js — 本地业务知识的输出追踪与事实校验契约 */
(function (root) {
  'use strict';
  var OUTPUT_CONTRACT_VERSION = 'KNOWLEDGE_OUTPUT_V1';

  function cleanText(value, limit) {
    value = String(value == null ? '' : value)
      .replace(/\u0000/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
    if (limit && value.length > limit) value = value.slice(0, limit);
    return value;
  }

  function hashText(value) {
    value = String(value || '');
    var hash = 2166136261;
    for (var i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return ('00000000' + (hash >>> 0).toString(16)).slice(-8);
  }

  function traceLinkId(value) {
    value = cleanText(value, 40).toUpperCase().replace(/\s+/g, '');
    var match = value.match(/^L0*(\d+)$/);
    if (!match || !Number(match[1])) return '';
    var digits = String(Number(match[1]));
    while (digits.length < 3) digits = '0' + digits;
    return 'L' + digits;
  }

  // 字段级追踪由确定性边界生成，不接受模型自报“我用了哪篇知识”。
  // 只保留路径、证据所有者、决策与输出指纹，不复制笔记正文、提示词或 Key。
  function buildFieldTrace(options) {
    options = options && typeof options === 'object' ? options : {};
    var meta = options.knowledgeMeta && typeof options.knowledgeMeta === 'object' ? options.knowledgeMeta : {};
    var output = options.output && typeof options.output === 'object' ? options.output : {};
    var policies = options.policies && typeof options.policies === 'object' ? options.policies : {};
    var fields = Array.isArray(options.fields) ? options.fields.slice(0, 80) : Object.keys(output).slice(0, 80);
    var provider = cleanText(meta.provider, 40) || 'none';
    var code = cleanText(meta.code, 80);
    var matchedCount = Math.max(0, Number(meta.matchedCount) || 0);
    var hasLocalKnowledge = provider === 'local';
    var knowledgeAvailable = options.knowledgeApplied !== false &&
      code !== 'no_match' && code !== 'scope_disabled' && code !== 'disabled' &&
      provider !== 'none' && (matchedCount > 0 || hasLocalKnowledge);
    var sourcePaths = (Array.isArray(meta.sources) ? meta.sources : []).map(function (source) {
      return cleanText(source && source.path, 600);
    }).filter(Boolean).filter(function (path, index, all) { return all.indexOf(path) === index; }).slice(0, 6);
    var linkId = traceLinkId(options.linkId);
    var provenanceGranularity = cleanText(options.provenanceGranularity || meta.provenanceGranularity, 40) || 'task_scope';
    var deterministicRejections = options.deterministicRejections && typeof options.deterministicRejections === 'object'
      ? options.deterministicRejections : {};

    return fields.map(function (field) {
      field = cleanText(field, 80);
      var policy = policies[field] && typeof policies[field] === 'object' ? policies[field] : {};
      var prohibited = policy.allowKnowledge === false;
      var outputPresent = Object.prototype.hasOwnProperty.call(output, field);
      var decision = prohibited ? 'prohibited' : (knowledgeAvailable ? cleanText(policy.decision, 40) || 'constrained' : 'no_effect');
      var rejectedReason = '';
      var deterministicReason = cleanText(deterministicRejections[field], 180);
      var traceBasis = deterministicReason ? 'deterministic_rejection' : 'policy_context';
      if (prohibited) rejectedReason = deterministicReason || 'policy_disallows_knowledge_influence';
      else if (!outputPresent) rejectedReason = 'output_missing';
      else if (options.knowledgeApplied === false) rejectedReason = cleanText(options.noEffectReason, 180) || 'knowledge_not_applied';
      else if (!knowledgeAvailable) rejectedReason = code === 'no_match' ? 'knowledge_no_match' : (code || 'knowledge_not_enabled');
      return {
        linkId: linkId,
        field: field,
        decision: decision,
        traceBasis: traceBasis,
        provenanceGranularity: provenanceGranularity,
        sourcePaths: knowledgeAvailable && !prohibited ? sourcePaths.slice() : [],
        evidenceOwners: (Array.isArray(policy.evidenceOwners) ? policy.evidenceOwners : []).map(function (owner) {
          return cleanText(owner, 60);
        }).filter(Boolean).slice(0, 8),
        rejectedReason: rejectedReason,
        outputFingerprint: outputPresent ? hashText(JSON.stringify(output[field])) : ''
      };
    });
  }

  function normalizeFactValue(value) {
    if (value == null) return '';
    if (typeof value === 'number' && isFinite(value)) return String(Number(value));
    value = cleanText(value, 240);
    try { value = value.normalize('NFKC'); } catch (error) {}
    var numeric = value.match(/^[-+]?\d+(?:\.\d+)?$/);
    return numeric ? String(Number(value)) : value.toLowerCase();
  }

  var GENERATED_CLAIM_RULES = [
    { code: 'absolute_superlative', alwaysBlock: true, pattern: /(?:全网第一|全国第一|世界第一|行业第一|销量第一|排名第一|全网首发|顶级|极致|最佳|最强|唯一(?:选择|品牌|产品|一款|拥有|做到|解决方案)|独家|独有|首创|首个|最高级|国家级|世界级|永久|绝对|全网最低价|百分百有效|100%有效|零风险|无副作用)/i },
    { code: 'unsupported_competitor_coverage', alwaysBlock: true, pattern: /(?:竞品都没有|竞品全都没有|所有竞品(?:都)?没有|竞品完全未覆盖|全行业都没有|同行都没有|市面上(?:都)?没有|别人都没有)/i },
    { code: 'medical_treatment_claim', alwaysBlock: true, pattern: /(?:治愈|治疗|疗效|药效|抗癌|防癌|治癌|降血压|降血糖|减肥|壮阳|祛病|消炎|医疗功效)/i },
    { code: 'unsupported_certification', alwaysBlock: false, pattern: /(?:(?:母婴|婴幼儿|食品|医疗|医用|国家|国际|权威|官方|欧盟)级?认证|FDA认证|CE认证|3C认证|专利认证)/i },
    { code: 'unauthorized_brand_leverage', alwaysBlock: true, pattern: /(?:华为|苹果|apple|小米|三星|索尼|戴森|西门子|海尔|美的|卡地亚|蒂芙尼|宝格丽|香奈儿|迪奥|古驰|耐克|阿迪达斯|乐高|迪士尼)\s*(?:同款|联名|授权|官方|平替|代工|原装|正品)/i },
    { code: 'unsupported_fit_guarantee', alwaysBlock: true, pattern: /(?:完美齐平|完美贴合|严丝合缝|百分百适配|100%适配|绝不变形|永不变形)/i }
  ];

  function claimComparable(value) {
    value = cleanText(value, 12000).toLowerCase();
    try { value = value.normalize('NFKC'); } catch (error) {}
    return value.replace(/[\s\u3000,，。；;：:、|｜/\\()（）【】\[\]"'“”‘’_-]+/g, '');
  }

  function claimUnit(value) {
    value = cleanText(value, 40).toLowerCase().replace(/\s+/g, '');
    var units = {
      '毫米': 'mm', '厘米': 'cm', '米': 'm', '千克': 'kg', '公斤': 'kg',
      '升': 'l', '分贝': 'db', '瓦': 'w', '伏': 'v', '％': '%'
    };
    return units[value] || value;
  }

  function claimEvidenceStatus(value) {
    return cleanText(value, 40).toLowerCase();
  }

  function claimFactVerified(fact) {
    return ['verified', 'confirmed', 'approved', '已验证', '已确认', '有效'].indexOf(claimEvidenceStatus(fact && fact.evidenceStatus)) >= 0;
  }

  function claimFactNegative(fact) {
    var value = claimComparable(fact && fact.factValue);
    return ['false', 'no', '0', '否', '无', '不支持', '未通过', '禁止', 'unsupported', 'notsupported', 'not_supported'].indexOf(value) >= 0 ||
      /^(?:不支持|无|未通过|禁止|不可用)/.test(value);
  }

  function generatedTextEntries(value, path, out, seen) {
    path = path || '';
    out = out || [];
    seen = seen || [];
    if (value == null) return out;
    if (typeof value === 'string') {
      // 负面提示词和避让点会主动列举禁止内容，不应被当作正向商品声明。
      if (!/(?:负面|避让|禁止项|negative|avoid)/i.test(path) && value.trim()) {
        out.push({ fieldPath: path || '$', text: value });
      }
      return out;
    }
    if (typeof value !== 'object') return out;
    if (seen.indexOf(value) >= 0) return out;
    seen.push(value);
    if (Array.isArray(value)) {
      value.slice(0, 240).forEach(function (item, index) {
        generatedTextEntries(item, path + '[' + index + ']', out, seen);
      });
    } else {
      Object.keys(value).slice(0, 240).forEach(function (key) {
        generatedTextEntries(value[key], path ? (path + '.' + key) : key, out, seen);
      });
    }
    return out;
  }

  function factTextCandidates(fact) {
    fact = fact && typeof fact === 'object' ? fact : {};
    var key = claimComparable(fact.factKey), value = claimComparable(fact.factValue), unit = claimUnit(fact.unit);
    var candidates = [];
    [value, key, value && unit ? claimComparable(value + unit) : '', key && value ? claimComparable(key + value + unit) : '']
      .forEach(function (candidate) {
        if (candidate && candidate.length >= 2 && candidates.indexOf(candidate) < 0) candidates.push(candidate);
      });
    return candidates;
  }

  function verifiedTextEvidence(claim, facts) {
    claim = claimComparable(claim);
    if (!claim) return false;
    return (Array.isArray(facts) ? facts : []).some(function (fact) {
      if (!claimFactVerified(fact) || claimFactNegative(fact)) return false;
      return factTextCandidates(fact).some(function (candidate) {
        return candidate === claim || candidate.indexOf(claim) >= 0 || claim.indexOf(candidate) >= 0;
      });
    });
  }

  function measurementClaims(text) {
    var out = [], re = /([-+]?\d+(?:\.\d+)?)\s*(kg|公斤|千克|mm|毫米|cm|厘米|m|米|l|升|%|％|db|分贝|w|瓦|v|伏)/ig, match;
    while ((match = re.exec(String(text || '')))) {
      out.push({ value: String(Number(match[1])), unit: claimUnit(match[2]), raw: match[0], index: match.index });
    }
    return out;
  }

  function visualLayoutPercentage(entry, claim) {
    if (!entry || !claim || claim.unit !== '%') return false;
    var path = String(entry.fieldPath || '');
    var text = String(entry.text || '');
    var raw = String(claim.raw || '');
    var index = text.indexOf(raw);
    var nearby = index >= 0
      ? text.slice(Math.max(0, index - 36), Math.min(text.length, index + raw.length + 36))
      : text;
    var visualPath = /(?:字号规范|字体与字号|文字层级|画面布局|页面布局结构|排版规范|构图|版式|留白|图文比例)/i.test(path);
    var visualContext = /(?:字号|字体|标题|副标题|说明文字|注释文字|文字|文案区|画面|主体|商品|产品|构图|布局|版式|留白|图文|视觉|占画面|面积占比)/i.test(nearby);
    var claimContext = /(?:率|功效|效果|有效|提升|提高|降低|减少|增长|准确|成功|满意|好评|转化|点击|除菌|抑菌|杀菌|抗菌|去除|治愈|治疗|防护|节省|省电|省水)/i.test(nearby);
    return (visualPath || visualContext) && !claimContext;
  }

  function photographicFocalLength(entry, claim) {
    if (!entry || !claim || claim.unit !== 'mm') return false;
    var path = String(entry.fieldPath || '');
    if (/(?:文案|标题|卖点|商品声明|产品名称|copy|headline|title|sellingPoint|claim)/i.test(path) ||
        !/(?:镜头|焦距|焦段|中文(?:详情)?提示词|生图提示词|构图|画面|摄影|focal|camera|lens|imagePrompt|generationPrompt|composition)/i.test(path)) return false;
    var text = String(entry.text || '');
    var index = Number(claim.index);
    if (!isFinite(index) || index < 0) return false;
    var before = text.slice(Math.max(0, index - 32), index).split(/[,，。;；\n]/).pop();
    var after = text.slice(index + claim.raw.length, index + claim.raw.length + 32).split(/[,，。;；\n]/)[0];
    var nearby = before + claim.raw + after;
    // mm 也可能是商品尺寸；视觉字段不能掩盖其中夹带的规格声明。
    if (/(?:长度|宽度|高度|厚度|深度|尺寸|直径|口径|规格|长宽|厚|外壳|结构|部件|包装|参数)/i.test(nearby) ||
        /(?:商品|产品|机身)\s*(?:的)?\s*[:：=为是]?\s*$/.test(before)) return false;
    var opticalField = /(?:^|\.)(?:镜头|摄影镜头|焦距|焦段|focalLength|cameraLens)$/i.test(path);
    var opticalBefore = /(?:镜头|焦距|焦段|focal\s*length)\s*[:：=为是]?\s*$/i.test(before);
    var opticalAfter = /^(?:\s*(?:摄影|拍摄|人像|商业|等效|全画幅|定焦|广角|长焦|中焦|中长焦|标准)){0,4}\s*(?:镜头|焦距|焦段|focal\s*length|lens)/i.test(after);
    return opticalField || opticalBefore || opticalAfter;
  }

  function factMatchesMeasurement(fact, claim) {
    if (!fact || !claim) return false;
    var unit = claimUnit(fact.unit), value = normalizeFactValue(fact.factValue);
    if (unit && String(Number(value)) === claim.value && unit === claim.unit) return true;
    return measurementClaims(String(fact.factValue || '') + String(fact.unit || '')).some(function (found) {
      return found.value === claim.value && found.unit === claim.unit;
    });
  }

  function factTermMention(entryText, fact) {
    var normalized = claimComparable(entryText);
    if (!normalized) return '';
    var value = claimComparable(fact && fact.factValue);
    var booleanValue = /^(?:true|yes|1|是|支持|false|no|0|否|无|不支持|未通过|禁止|unsupported|notsupported|not_supported)$/.test(value);
    var candidates = booleanValue ? [claimComparable(fact && fact.factKey)] : factTextCandidates(fact);
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i] && candidates[i].length >= 2 && normalized.indexOf(candidates[i]) >= 0) return candidates[i];
    }
    return '';
  }

  function validateGeneratedClaims(output, options) {
    options = options && typeof options === 'object' ? options : {};
    var entries = generatedTextEntries(output), facts = Array.isArray(options.facts) ? options.facts : [];
    var inputEvidence = claimComparable(typeof options.inputEvidence === 'string'
      ? options.inputEvidence : JSON.stringify(options.inputEvidence || ''));
    var violations = [], seen = Object.create(null);
    function reject(entry, type, claim, reason, fact) {
      var key = entry.fieldPath + '|' + type + '|' + claimComparable(claim);
      if (seen[key]) return;
      seen[key] = true;
      violations.push({
        fieldPath: cleanText(entry.fieldPath, 300), claimType: type,
        claim: cleanText(claim, 160), reason: reason,
        factKey: cleanText(fact && fact.factKey, 120),
        evidenceStatus: cleanText(fact && fact.evidenceStatus, 40)
      });
    }
    entries.forEach(function (entry) {
      GENERATED_CLAIM_RULES.forEach(function (rule) {
        var match = String(entry.text || '').match(rule.pattern);
        if (!match) return;
        if (!rule.alwaysBlock && verifiedTextEvidence(match[0], facts)) return;
        reject(entry, rule.code, match[0], rule.alwaysBlock ? 'prohibited_claim' : 'verified_evidence_required');
      });
      measurementClaims(entry.text).forEach(function (claim) {
        // 字号、留白、主体占画面等百分比是视觉执行参数，不是商品功效或规格。
        // 仅豁免明确的视觉百分比和摄影焦段；商品参数及“除菌率 99%”一类
        // 带功效/指标语境的百分比仍必须经过输入或已验证事实证据校验。
        if (visualLayoutPercentage(entry, claim) || photographicFocalLength(entry, claim)) return;
        var pending = facts.find(function (fact) { return !claimFactVerified(fact) && factMatchesMeasurement(fact, claim); });
        if (pending) {
          reject(entry, 'needs_evidence_measurement', claim.raw, 'needs_evidence_fact_used_as_claim', pending);
          return;
        }
        var verified = facts.some(function (fact) { return claimFactVerified(fact) && factMatchesMeasurement(fact, claim); });
        var inInput = inputEvidence.indexOf(claimComparable(claim.raw)) >= 0 ||
          inputEvidence.indexOf(claimComparable(claim.value + claim.unit)) >= 0;
        if (!verified && !inInput) reject(entry, 'unverified_measurement', claim.raw, 'verified_or_input_evidence_required');
      });
      facts.forEach(function (fact) {
        var mention = factTermMention(entry.text, fact);
        if (!mention) return;
        if (!claimFactVerified(fact)) {
          reject(entry, 'needs_evidence_fact', mention, 'needs_evidence_fact_used_as_claim', fact);
        } else if (claimFactNegative(fact)) {
          reject(entry, 'verified_fact_conflict', mention, 'generated_claim_conflicts_with_verified_fact', fact);
        }
      });
    });
    return {
      ok: violations.length === 0,
      code: violations.length ? 'generated_claim_unverified' : '',
      violations: violations.slice(0, 40),
      checkedFieldCount: entries.length
    };
  }

  function assessProductApplicability(terms, facts) {
    facts = Array.isArray(facts) ? facts : [];
    var normalizedTerms = (Array.isArray(terms) ? terms : []).map(function (term) {
      if (term && typeof term === 'object') term = term.term != null ? term.term : (term.root != null ? term.root : term['词根']);
      return cleanText(term, 120);
    }).filter(Boolean).filter(function (term, index, all) { return all.indexOf(term) === index; });
    var verifiedTerms = [], blockedTerms = [], pendingTerms = [];
    normalizedTerms.forEach(function (term) {
      var normalized = claimComparable(term);
      var matches = facts.filter(function (fact) {
        return factTextCandidates(fact).some(function (candidate) {
          return candidate.indexOf(normalized) >= 0 || normalized.indexOf(candidate) >= 0;
        });
      });
      if (matches.some(function (fact) { return !claimFactVerified(fact) || claimFactNegative(fact); })) blockedTerms.push(term);
      else if (matches.some(claimFactVerified)) verifiedTerms.push(term);
      else pendingTerms.push(term);
    });
    return {
      status: blockedTerms.length ? 'blocked' : (pendingTerms.length ? 'applicability_pending' : 'verified'),
      verifiedTerms: verifiedTerms, blockedTerms: blockedTerms, pendingTerms: pendingTerms
    };
  }

  root.SZKnowledgeOutputContract = {
    OUTPUT_CONTRACT_VERSION: OUTPUT_CONTRACT_VERSION,
    cleanText: cleanText,
    hashText: hashText,
    buildFieldTrace: buildFieldTrace,
    validateGeneratedClaims: validateGeneratedClaims,
    assessProductApplicability: assessProductApplicability
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
