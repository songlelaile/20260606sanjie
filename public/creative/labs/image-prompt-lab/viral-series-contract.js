'use strict';

(function exposeViralSeriesContract(root) {
  var CONFIG = Object.freeze({
    version: 'VIRAL_SERIES_V3',
    defaultVariantCount: 5,
    minVariantCount: 1,
    maxVariantCount: 20,
    visualSimilarityTarget: 30,
    redesignTarget: 70,
    productConsistencyMode: 'strict_same_sku'
  });

  var DIFFERENTIATION_AXES = Object.freeze([
    '构图布局',
    '镜头角度与裁切',
    '使用场景',
    '人物互动',
    '道具组合',
    '文案钩子',
    '视觉焦点层级'
  ]);

  var VARIANT_TEMPLATES = Object.freeze([
    Object.freeze({ name: '沉浸使用场景', axis: '场景 + 广角构图 + 情绪氛围', brief: '把{{product}}置于可信的真实使用场景，以环境纵深和自然接触关系增强代入感，主体完整清晰。' }),
    Object.freeze({ name: '核心卖点聚焦', axis: '中心构图 + 卖点钩子 + 焦点层级', brief: '采用强中心主视觉和克制留白，让{{product}}成为唯一视觉焦点，用一个核心利益点形成高转化记忆。' }),
    Object.freeze({ name: '人物自然互动', axis: '人物互动 + 中近景镜头 + 动作关系', brief: '使用全新模特或局部肢体与{{product}}自然互动，清楚展示使用动作、尺度和情绪，但不遮挡或改写产品。' }),
    Object.freeze({ name: '细节质感特写', axis: '微距裁切 + 材质细节 + 光影重点', brief: '用宏观与微距层次强调{{product}}的真实材质、纹理、工艺和可见细节，同时保留足够整体轮廓供款式识别。' }),
    Object.freeze({ name: '痛点解决演示', axis: '前后关系 + 功能演示 + 对比叙事', brief: '以生活痛点切入并让{{product}}承担解决方案，用动作或场景证据表达，不使用贬损竞品或虚假功效。' }),
    Object.freeze({ name: '极简陈列展示', axis: '极简布局 + 棚拍镜头 + 道具组合', brief: '采用高端棚拍式极简陈列，以少量材质道具、精准阴影和高级留白突出{{product}}的外观价值。' }),
    Object.freeze({ name: '结构角度展示', axis: '角度变化 + 结构信息 + 版式节奏', brief: '切换到最能说明结构的视角，通过{{product}}同一SKU的多角度证据呈现产品，不制造不存在的部件或变体。' }),
    Object.freeze({ name: '氛围价值收口', axis: '情绪场景 + 文案节奏 + 空间层次', brief: '以品牌中性的高质感氛围和简短价值文案收口，强化拥有感与审美价值，{{product}}仍是图2同一SKU。' }),
    Object.freeze({ name: '尺寸尺度证明', axis: '尺度参照 + 信息标注 + 正视构图', brief: '用可信的生活尺度参照与克制标注呈现{{product}}的真实大小关系，只表达可由图2确认的信息。' }),
    Object.freeze({ name: '使用步骤演示', axis: '步骤动作 + 连贯镜头 + 操作焦点', brief: '选择一个关键使用步骤，以单屏内清晰的动作关系展示{{product}}如何被使用，不拆改产品或虚构功能。' }),
    Object.freeze({ name: '多场景适配', axis: '场景切换 + 环境构图 + 人群线索', brief: '把{{product}}放入与前序图片不同但合理的使用环境，通过空间与人群线索证明场景适配，商品外观保持完全一致。' }),
    Object.freeze({ name: '动态瞬间捕捉', axis: '动作瞬间 + 斜向构图 + 运动层次', brief: '用自然动作瞬间和轻微动态层次增强{{product}}的使用代入感，产品主体仍清晰、完整且不变形。' }),
    Object.freeze({ name: '开箱陈列体验', axis: '开箱视角 + 包装关系 + 桌面场景', brief: '在图2确有包装证据时展示{{product}}的开箱或取用体验；没有包装证据时改为高端桌面陈列，禁止虚构包装。' }),
    Object.freeze({ name: '工艺结构证明', axis: '剖面感构图 + 工艺焦点 + 证据文案', brief: '通过真实可见的结构连接、边缘与做工细节证明{{product}}的工艺品质，不生成图2中不存在的内部结构。' }),
    Object.freeze({ name: '信任细节佐证', axis: '证据特写 + 使用痕迹 + 克制说明', brief: '选取{{product}}一个可从图2确认的可信细节，以真实光影和简短说明建立购买信任，不添加认证或夸大承诺。' }),
    Object.freeze({ name: '空间关系展示', axis: '空间比例 + 环境纵深 + 侧向镜头', brief: '用不同于前序画面的空间纵深和侧向镜头展示{{product}}在真实环境中的占位与使用关系。' }),
    Object.freeze({ name: '季节情绪场景', axis: '季节氛围 + 色温变化 + 情绪钩子', brief: '在共享系列色彩体系内加入合理的季节情绪，让{{product}}承接新的生活氛围，同时保持款式和材质准确。' }),
    Object.freeze({ name: '俯拍平铺图鉴', axis: '俯拍镜头 + 平铺秩序 + 信息留白', brief: '采用高端杂志式俯拍平铺构图呈现{{product}}及少量中性道具，主体数量、部件和包装严格以图2为准。' }),
    Object.freeze({ name: '编辑感视觉海报', axis: '海报构图 + 大留白 + 标题节奏', brief: '以高级编辑设计语言为{{product}}建立强记忆海报，延续全组字体与色彩，但使用全新的构图比例和视觉重心。' }),
    Object.freeze({ name: '核心价值终章', axis: '英雄视角 + 价值总结 + 光影收束', brief: '用与首图不同的英雄视角总结{{product}}最可信的核心价值，以统一光影和简短文案完成系列收束。' })
  ]);

  function clampVariantCount(value) {
    var parsed = parseInt(value, 10);
    if (!isFinite(parsed)) parsed = CONFIG.defaultVariantCount;
    return Math.max(CONFIG.minVariantCount, Math.min(CONFIG.maxVariantCount, parsed));
  }

  function createConfig(input) {
    input = input || {};
    var similarity = Number(input.visualSimilarityTarget);
    if (!isFinite(similarity) || similarity <= 0 || similarity >= 100) similarity = CONFIG.visualSimilarityTarget;
    var redesign = Number(input.redesignTarget);
    if (!isFinite(redesign) || redesign <= 0 || redesign >= 100) redesign = 100 - similarity;
    return {
      version: CONFIG.version,
      variantCount: clampVariantCount(input.variantCount || input.screenCount),
      visualSimilarityTarget: similarity,
      redesignTarget: redesign,
      productConsistencyMode: CONFIG.productConsistencyMode,
      seriesStyleConsistency: true,
      differentiationAxes: DIFFERENTIATION_AXES.slice()
    };
  }

  function variantSpecs(count, productText) {
    var product = String(productText || '图2产品').trim() || '图2产品';
    return VARIANT_TEMPLATES.slice(0, clampVariantCount(count)).map(function (template) {
      return {
        name: template.name,
        axis: template.axis,
        brief: template.brief.split('{{product}}').join(product)
      };
    });
  }

  function promptRuleLines(input) {
    var config = createConfig(input);
    var count = config.variantCount;
    return [
      '【爆款同款系列裂变硬规则｜图1参考 + 图2产品｜' + config.version + '】',
      '任务：规划' + count + '张彼此独立的电商详情页单屏裂变图；每次生图请求只生成当前1张，不得把多张做成合集、拼图或长详情页。',
      '优先级：款式一致 > 风格一致 > 图片差异化。差异化不得以改变商品为代价。',
      '款式一致：' + count + '张图中的商品必须是图2同一个SKU。轮廓、结构、长宽厚比例、颜色、材质、纹理、包装、部件、数量、图案位置和全部可见细节保持一致；禁止换款、改色、换材质、增删部件、改变包装或把同款画成相似款。',
      '风格一致：先从图1提炼一套共享系列视觉系统，所有裂变图固定使用同一色彩体系、字体家族与层级、标题样式、留白节奏、光线方向与色温、材质表现、背景质感和高端电商完成度。',
      '图片差异化：任意两张至少在以下7个维度中的3项显著不同：' + config.differentiationAxes.join('、') + '。禁止只换文案、只挪位置或批量套同一模板。',
      '相似度边界：只保留约' + config.visualSimilarityTarget + '%视觉基因，且仅限整体风格气质、文案表达主题与层级、画面展示内容类型、构图节奏、光影景深及“人物如何与产品互动”的关系；禁止像素级复刻、同构重画或一比一照搬。',
      '原创重设计：其余约' + config.redesignTarget + '%必须重新设计，主动改变布局细节、背景空间、道具组合、镜头裁切、人物身份/服装/姿态细节和装饰元素，使画面更美观大气、更具代入感，符合高端电商审美。',
      '商品白名单：最终画面中的商业商品只能是图2产品。商品身份、结构、比例、颜色、材质、包装、部件、数量和可见细节100%以图2产品主体图为准。',
      '图1禁入项：不得出现图1里的商品、旧包装、旧SKU、品牌名、品牌Logo、商标、水印、专属纹样、可识别包装文字或其他可识别商业资产；不得把图1商品当道具、赠品、背景陈列或模特手持物。',
      '互动规则：如果图1存在模特与产品互动，只借鉴互动功能关系；改用全新且不可识别为图1人物的模特，或用户另行上传的模特。模特只能与图2产品自然互动，不得遮挡、替代或改写图2产品。',
      '文案规则：可参考图1文案的内容主题、短句节奏、标题/副标题层级和文字位置，但必须围绕图2产品事实重新表达；不得复制品牌口号、品牌名、型号、功效承诺或专属措辞。',
      '输出审美：每张图一个主视觉、一个核心卖点、少量清晰短文案、充足留白、专业商业光影、真实接触阴影、自然空间层次、强产品质感与使用代入感。'
    ];
  }

  function promptRules(input) {
    return promptRuleLines(input).join('\n');
  }

  function fieldText(plan, names) {
    plan = plan || {};
    for (var i = 0; i < names.length; i++) {
      var value = plan[names[i]];
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    return '';
  }

  function normalizeDirection(value) {
    return String(value || '').toLowerCase().replace(/[\s，,。；;、/|+＋·:：_-]+/g, '');
  }

  function validatePlanList(plans, expectedCount) {
    var count = clampVariantCount(expectedCount);
    if (!Array.isArray(plans) || plans.length !== count) {
      return { ok: false, error: '裂变图数量不正确：需要 ' + count + ' 张，实际 ' + (Array.isArray(plans) ? plans.length : 0) + ' 张' };
    }
    var required = [
      { label: '裂变方向', names: ['裂变方向', 'derivativeDirection', 'variantDirection'] },
      { label: '系列一致性', names: ['系列一致性', 'seriesConsistency', 'styleConsistency'] },
      { label: '差异化说明', names: ['差异化说明', 'differentiation', 'differencePlan'] }
    ];
    var seen = {};
    for (var i = 0; i < plans.length; i++) {
      for (var j = 0; j < required.length; j++) {
        if (!fieldText(plans[i], required[j].names)) {
          return { ok: false, error: '第 ' + (i + 1) + ' 张裂变图缺少' + required[j].label };
        }
      }
      var direction = normalizeDirection(fieldText(plans[i], required[0].names));
      if (!direction || seen[direction]) {
        return { ok: false, error: '裂变方向不够差异化：第 ' + (i + 1) + ' 张与其他图片方向重复' };
      }
      seen[direction] = true;
    }
    return { ok: true, error: '' };
  }

  root.SZ_VIRAL_SERIES_CONTRACT = Object.freeze({
    config: CONFIG,
    differentiationAxes: DIFFERENTIATION_AXES,
    variantTemplates: VARIANT_TEMPLATES,
    clampVariantCount: clampVariantCount,
    createConfig: createConfig,
    variantSpecs: variantSpecs,
    promptRuleLines: promptRuleLines,
    promptRules: promptRules,
    validatePlanList: validatePlanList
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
