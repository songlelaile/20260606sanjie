/* business-knowledge.js — 全插件共享的本地业务知识库最小契约 */
(function (root) {
  'use strict';

  var KEY = 'sz_business_knowledge_v1';
  var SCHEMA_VERSION = 2;
  var MAX_SOURCE_COUNT = 8;
  var MAX_SOURCE_CHARS = 120000;
  var DEFAULT_CONTEXT_CHARS = 12000;
  var FIELD_ORDER = [
    ['product', '产品身份'],
    ['brand', '品牌身份'],
    ['category', '品类边界'],
    ['audience', '核心人群'],
    ['scenarios', '用户场景'],
    ['benefits', '核心功能与利益点'],
    ['differentiation', '差异化与竞争壁垒'],
    ['tone', '文案语气'],
    ['visual', '视觉与设计规范'],
    ['compliance', '合规与禁用表达']
  ];
  var READINESS_DIMENSIONS = [
    { key: 'product', label: '产品', fields: ['product', 'category'] },
    { key: 'brand', label: '品牌', fields: ['brand'] },
    { key: 'audience', label: '受众', fields: ['audience'] },
    { key: 'scenarios', label: '使用场景', fields: ['scenarios'] },
    { key: 'benefits', label: '功能卖点', fields: ['benefits'] },
    { key: 'differentiation', label: '差异化壁垒', fields: ['differentiation'] },
    { key: 'tone', label: '文案语气', fields: ['tone'] },
    { key: 'visual', label: '视觉规范', fields: ['visual'] },
    { key: 'compliance', label: '合规表达', fields: ['compliance'] }
  ];
  var PRODUCTION_ORDERS = {
    link: [
      '锁定当前任务、L 编号、词根需求和市场证据，这些输入不允许被知识库改写',
      '按“精确 L+SKU → 精确 L → 精确 SKU → 精确品类 → 精确关键词 → 笔记优先级 → 更新时间”选择知识',
      '先用已验证产品事实和合规边界排除不适用、待核验或冲突表达',
      '再用人群、场景、功能利益点和差异化壁垒约束链接定位、场景需求与差异化逻辑',
      '最后用品牌语气影响主图/详情文案；商品标题仍只由热词榜白名单和本地 60 字求解器决定'
    ],
    main: [
      '先锁定当前商品主体多角度图和 L 编号，知识库不得改变商品结构、颜色、材质、包装或数量',
      '以当前链接清单的定位、主推关键词、场景需求和主图核心文案确定本张主图任务',
      '按精确 L、SKU、品类、关键词和优先级选择对应知识，并先采用已验证产品事实',
      '用目标人群、使用场景、功能利益点和差异化壁垒决定画面证据与信息取舍',
      '用文案语气和视觉规范决定标题层级、构图、色彩、字体、留白、光影与背景',
      '生成后再用合规边界和结构化事实检查夸大、未证参数、禁用品牌词及主体偏移'
    ],
    detail: [
      '先锁定当前商品主体多角度图、L 编号、详情定位和屏数，知识库不得改号或改商品身份',
      '按精确 L、SKU、品类、关键词和优先级选择对应知识，并先采用已验证产品事实',
      '用目标人群与核心场景确定开场问题、使用语境和用户决策阻力',
      '按“问题 → 功能证据 → 用户利益 → 差异化壁垒 → 信任/使用说明”组织说服顺序',
      '再用文案语气与视觉规范统一逐屏标题层级、图文节奏、色彩、字体、留白和光影',
      '最后逐屏执行合规与事实校验；缺证参数、绝对化、医疗功效和未经授权对比不得进入成稿'
    ]
  };

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

  function normalizeScopes(scopes) {
    scopes = scopes && typeof scopes === 'object' ? scopes : {};
    return {
      link: scopes.link !== false,
      main: scopes.main !== false,
      detail: scopes.detail !== false
    };
  }

  function normalizeFields(fields) {
    fields = fields && typeof fields === 'object' ? fields : {};
    return FIELD_ORDER.reduce(function (out, item) {
      out[item[0]] = cleanText(fields[item[0]], 12000);
      return out;
    }, {});
  }

  function normalizeSources(sources) {
    var remaining = MAX_SOURCE_CHARS;
    return (Array.isArray(sources) ? sources : []).slice(0, MAX_SOURCE_COUNT).map(function (source, idx) {
      source = source && typeof source === 'object' ? source : {};
      var text = remaining > 0 ? cleanText(source.text, remaining) : '';
      remaining = Math.max(0, remaining - text.length);
      return {
        id: cleanText(source.id, 80) || ('kb-source-' + (idx + 1)),
        name: cleanText(source.name, 180) || ('资料' + (idx + 1)),
        type: cleanText(source.type, 80) || 'text/plain',
        size: Math.max(0, Number(source.size) || 0),
        chars: text.length,
        text: text
      };
    }).filter(function (source) { return !!source.text; });
  }

  function normalize(value) {
    value = value && typeof value === 'object' ? value : {};
    return {
      schemaVersion: SCHEMA_VERSION,
      name: cleanText(value.name, 120) || '默认业务知识库',
      enabled: value.enabled !== false,
      updatedAt: Math.max(0, Number(value.updatedAt) || 0),
      scopes: normalizeScopes(value.scopes),
      fields: normalizeFields(value.fields),
      sources: normalizeSources(value.sources)
    };
  }

  function hasContent(value) {
    value = normalize(value);
    return FIELD_ORDER.some(function (item) { return !!value.fields[item[0]]; }) || value.sources.length > 0;
  }

  function summary(value) {
    value = normalize(value);
    var fieldCount = FIELD_ORDER.filter(function (item) { return !!value.fields[item[0]]; }).length;
    var chars = value.sources.reduce(function (sum, source) { return sum + source.chars; }, 0);
    return {
      ready: value.enabled && hasContent(value),
      name: value.name,
      fieldCount: fieldCount,
      sourceCount: value.sources.length,
      sourceChars: chars,
      updatedAt: value.updatedAt,
      scopes: value.scopes
    };
  }

  function readiness(value) {
    value = normalize(value);
    var dimensions = READINESS_DIMENSIONS.map(function (dimension) {
      var complete = dimension.fields.some(function (field) { return !!value.fields[field]; });
      return { key: dimension.key, label: dimension.label, complete: complete };
    });
    var completed = dimensions.filter(function (item) { return item.complete; }).length;
    var identityReady = dimensions.some(function (item) { return item.key === 'product' && item.complete; });
    return {
      completed: completed,
      total: dimensions.length,
      percent: Math.round(completed / dimensions.length * 100),
      ready: identityReady && completed >= 4,
      strong: identityReady && completed >= 7,
      dimensions: dimensions,
      missing: dimensions.filter(function (item) { return !item.complete; }).map(function (item) { return item.key; })
    };
  }

  function starterFromAnswers(answers, baseValue) {
    answers = answers && typeof answers === 'object' ? answers : {};
    var base = normalize(baseValue || {});
    var fields = Object.assign({}, base.fields);
    var aliases = {
      product: ['product'], brand: ['brand'], category: ['category'], audience: ['audience'],
      scenarios: ['scenarios', 'scenario'], benefits: ['benefits'], differentiation: ['differentiation'],
      tone: ['tone'], visual: ['visual'], compliance: ['compliance']
    };
    Object.keys(aliases).forEach(function (field) {
      var value = '';
      aliases[field].some(function (alias) {
        value = cleanText(answers[alias], 12000);
        return !!value;
      });
      if (value) fields[field] = value;
    });
    var identity = cleanText(answers.product, 120) || cleanText(answers.brand, 120) || cleanText(answers.category, 120);
    return normalize({
      name: cleanText(answers.name, 120) || (identity ? (identity + '业务知识库') : base.name),
      enabled: base.enabled,
      updatedAt: base.updatedAt,
      scopes: base.scopes,
      fields: fields,
      sources: base.sources
    });
  }

  function yamlScalar(value) {
    return JSON.stringify(cleanText(value, 240) || '');
  }

  function obsidianMarkdown(value) {
    value = normalize(value);
    var titleIdentity = value.fields.product || value.fields.brand || value.fields.category || value.name;
    var lines = [
      '---',
      'title: ' + yamlScalar(titleIdentity + '业务事实'),
      'status: active',
      'scope: all',
      'category: ' + yamlScalar(value.fields.category || 'ALL'),
      'priority: 100',
      'knowledge_type: business_profile',
      '---',
      '',
      '# ' + titleIdentity + '业务事实',
      '',
      '> 只填写已经确认的业务事实；参数、功效、认证和对比结论请保留证据来源。'
    ];
    FIELD_ORDER.forEach(function (item) {
      lines.push('', '## ' + item[1], '', value.fields[item[0]] || '待补充');
    });
    lines.push('', '## 证据与更新时间', '', '- 证据来源：待补充', '- 最后核验：待补充', '');
    return lines.join('\n');
  }

  function productionOrder(scope) {
    scope = scope === 'detail' ? 'detail' : (scope === 'main' ? 'main' : 'link');
    return PRODUCTION_ORDERS[scope].slice();
  }

  function productionOrderText(scope) {
    return productionOrder(scope).map(function (item, index) {
      return (index + 1) + ') ' + item;
    }).join('；');
  }

  function contextForScope(value, scope, maxChars) {
    value = normalize(value);
    scope = scope === 'detail' ? 'detail' : (scope === 'main' ? 'main' : 'link');
    maxChars = Math.max(1000, Math.min(30000, Number(maxChars) || DEFAULT_CONTEXT_CHARS));
    if (!value.enabled || !value.scopes[scope] || !hasContent(value)) return '';
    var lines = [
      '【业务知识库：' + value.name + '】',
      '使用边界：知识库只补充真实业务规则、人群、场景、差异化、文案和视觉约束；不得覆盖商品主体图、链接编号、词根需求、市场证据或用户本次明确输入，也不得据此臆造未提供的功效与参数。'
    ];
    FIELD_ORDER.forEach(function (item) {
      if (value.fields[item[0]]) lines.push(item[1] + '：' + value.fields[item[0]]);
    });
    if (value.sources.length) {
      lines.push('导入资料摘录（按导入顺序）：');
      value.sources.forEach(function (source, idx) {
        lines.push('资料' + (idx + 1) + '《' + source.name + '》：\n' + source.text);
      });
    }
    return cleanText(lines.join('\n'), maxChars);
  }

  function normalizeStore(value) {
    value = value && typeof value === 'object' ? value : {};
    var accounts = value.accounts && typeof value.accounts === 'object' ? value.accounts : {};
    var out = { schemaVersion: SCHEMA_VERSION, accounts: {} };
    Object.keys(accounts).slice(0, 50).forEach(function (accountKey) {
      out.accounts[cleanText(accountKey, 140) || 'local'] = normalize(accounts[accountKey]);
    });
    // 兼容第一版直接保存单个知识库对象的草稿。
    if (!Object.keys(out.accounts).length && hasContent(value)) out.accounts.local = normalize(value);
    return out;
  }

  function forAccount(store, accountKey) {
    store = normalizeStore(store);
    accountKey = cleanText(accountKey, 140) || 'local';
    return normalize(store.accounts[accountKey] || {});
  }

  function setForAccount(store, accountKey, value) {
    store = normalizeStore(store);
    accountKey = cleanText(accountKey, 140) || 'local';
    store.accounts[accountKey] = normalize(value);
    return store;
  }

  root.SZBusinessKnowledge = {
    KEY: KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    MAX_SOURCE_COUNT: MAX_SOURCE_COUNT,
    MAX_SOURCE_CHARS: MAX_SOURCE_CHARS,
    DEFAULT_CONTEXT_CHARS: DEFAULT_CONTEXT_CHARS,
    FIELD_ORDER: FIELD_ORDER.slice(),
    READINESS_DIMENSIONS: READINESS_DIMENSIONS.map(function (item) { return Object.assign({}, item, { fields: item.fields.slice() }); }),
    cleanText: cleanText,
    normalize: normalize,
    hasContent: hasContent,
    summary: summary,
    readiness: readiness,
    starterFromAnswers: starterFromAnswers,
    obsidianMarkdown: obsidianMarkdown,
    productionOrder: productionOrder,
    productionOrderText: productionOrderText,
    contextForScope: contextForScope,
    normalizeStore: normalizeStore,
    forAccount: forAccount,
    setForAccount: setForAccount
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
