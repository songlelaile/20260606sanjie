(function (root, factory) {
  'use strict';
  var contract = factory();
  if (typeof module === 'object' && module.exports) module.exports = contract;
  if (root) root.SZ_SCENE_EXTENSION_CONTRACT = contract;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 'SCENE_EXTENSION_V3';
  var ROUTE = 'scene-extension';
  var TRANSPORT_VERSION = 'SCENE_WEB_TRANSPORT_V1';
  var MAX_REQUEST_BYTES = 24 * 1024 * 1024;
  // Four reference images leave room for provider encoding and request metadata.
  var MAX_IMAGE_BYTES = 16 * 1024 * 1024;
  var ROLES = ['front', 'detail', 'section', 'angle'];
  var LABELS = { front: '产品正面原图', detail: '产品细节原图', section: '产品背面、边缘或切面原图', angle: '产品其他角度原图' };
  var SHOTS = ['macro', 'near', 'wide', 'ultrawide'];
  var DEFAULT_SHOTS = ['macro', 'near', 'wide'];
  var CATEGORIES = ['general', 'material', 'furniture', 'daily', 'jewelry', 'beauty', 'clothing'];
  var RATIOS = ['1:1', '3:4', '16:9', '9:16', '21:9'];
  var RESOLUTIONS = ['1K', '2K', '4K'];
  var TEXT_FIELDS = ['materialName', 'sku', 'colorNotes', 'textureNotes', 'finishNotes', 'dimensions', 'scene', 'installation', 'lighting', 'displayNotes', 'styleTone'];
  var CATEGORY_RULES = {
    general: { label: '通用产品', usage: '依据原图保持产品完整，以符合真实用途的方式陈列或使用', rule: '依据原图识别产品真实用途，选择合理陈列、使用、佩戴或穿着方式；保持单品身份、数量关系、款式、颜色、材质与比例。无法从原图确认的用途只采用中性的完整产品展示，不猜测功能或内部结构。' },
    material: { label: '材料', usage: '依照材料实际用途和原图单元比例合理应用，保留纹理与接缝', rule: '仅材料类允许将同款材料单元重复应用、扩展覆盖面积或合理铺装。保留原图纹理真实尺度、方向、单元长宽比例、可见厚度和边缘、接缝与表面光泽；多块材料只采用原图已呈现的同款变化，不拉伸小样铺满空间、不机械重复同一结疤。切面不能作为正面花色来源；不预设所有材料都是地板，不把材料强制用于地面或家庭。' },
    furniture: { label: '家具', usage: '在符合家具用途的空间合理摆放完整单品，并保留可见结构', rule: '展示家具整体轮廓、长宽高比例、腿脚、扶手、靠背、门板或连接部位中原图可见的细节，以及木材、布料、皮革或金属的真实质感。家具尺度与空间合理，保留原款式、坐垫数量和可见构件，避免宽窄变形、擅自增减抽屉或靠背；不虚构储物内部、承重或人体工学性能。' },
    daily: { label: '日用品', usage: '以符合日用品实际用途的方式陈列或使用，保留完整产品', rule: '突出可见的形状、握持或接触部位、开口、连接、边缘、材质和实际使用尺度。使用动作须符合原图支持的用途，手部与产品接触自然，不改变容量、规格、组件数量；不虚构隐藏机构、附赠配件或清洁、抗菌等效果。' },
    jewelry: { label: '珠宝饰品', usage: '依照饰品类型合理陈列或佩戴，保持饰品清晰和真实比例', rule: '锁定金属颜色与光泽、宝石颜色、形状、数量、镶嵌位置、爪托结构、链节及扣件等原图可见细节。近景突出金属与宝石真实反光，远景可展示合理佩戴或完整陈列但饰品仍须可辨；不改变宝石大小、切工、镶嵌结构或链长比例，不凭空增加钻石、金属纯度、证书或其他价值声明。' },
    beauty: { label: '口红与美妆', usage: '合理陈列或展示已被原图明确支持的使用方式，保留产品外观', rule: '锁定口红或美妆产品的管体、盖体、轮廓比例、材质、包装配色，以及原图或用户已明确给出的同一色号。膏体、刷头、内部结构只在原图可见时呈现；闭合包装不能凭空打开并编造膏体形状、颜色或内容物。不得虚构上唇、上肤后的试色或功效，不把环境光或场景风格当成更换产品色号的理由。' },
    clothing: { label: '服装', usage: '依照服装类型合理陈列或穿着，保持原有版型和完整衣物', rule: '锁定服装版型、面料织纹、颜色、垂坠、厚薄外观、裁片分界、缝线、领口、袖型、门襟、纽扣、口袋和图案中原图可见的细节。穿着可产生自然褶皱与悬垂，但不得改款、改长度比例、增减部件、改图案或把面料换成别种材质；未见背面或内衬时不编造，不虚构显瘦、防水或保暖效果。' }
  };
  var SHOT_DEFINITIONS = {
    macro: { label: '微观', rule: '微观细节镜头：近距离展示当前产品真实、可见且与类别相关的纹理、材质、光泽和局部构造；保留必要边缘作为尺度参照。只改变镜头距离，不把细节放大成新的产品，不虚构剖面、内部或被遮挡结构。' },
    near: { label: '近观', rule: '近观镜头：清晰展示产品主体、相邻局部环境及符合用途的陈列、使用、佩戴或穿着关系。产品是视觉重点，保持款式、颜色、材质和真实比例；道具、手部或人体不遮挡关键产品细节。' },
    wide: { label: '远观', rule: '远观镜头：在同一场景中拉远取景，展示产品与完整环境、人物或陈列的关系。结合产品类别合理使用、佩戴或穿着，产品仍是清晰可辨的主体，避免缩成无法核对的小点；材料可以展示整体应用，其他单品保持原有数量和完整身份。' },
    ultrawide: { label: '超远观', rule: '超远观镜头：比远观纳入更广阔、完整的场景关系，通过相机后移和构图展开周边环境，展示产品与整个使用、陈列或穿着场景的联系。必须保留产品清晰可辨的轮廓、款式与本色，不能缩成无法识别的小点；优先调整机位、构图与环境遮挡，不得为远距离可见而夸大产品尺寸、改变真实比例或增加产品副本。' }
  };
  var ULTRAWIDE_FRAMING = {
    general: '根据产品用途展开完整陈列或使用环境；无法确认的用途只做中性陈列。场景范围服务于产品识别，不套用固定的家庭空间。',
    material: '展示同款材料的整体应用区域和完整空间边界；若选定场景为室内且符合材料用途，可将家具、墙面及天花之间的关系纳入画面。户外或非室内应用保持相应环境，不强制改为房间；仍按真实用途扩展同款材料单元，保留纹理尺度与接缝，其他单品不得随之复制。',
    furniture: '展示完整家具与周边陈设、通行区域的空间关系；若选定场景为室内，可适当纳入家具、墙面及天花，建立完整空间。户外家具沿用所选户外环境，不强行加室内结构；保持该家具原有数量、完整形态和真实比例。',
    daily: '展开日用品实际陈列、工作或使用区域的完整环境；仅在选定场景为室内且构图适合时纳入家具、墙面及天花。桌面、户外等场景按实际用途展开，不强制拉成整屋；小件用品仍须清晰可辨，不把同一用品复制布满环境。',
    jewelry: '展示完整的饰品陈列与周边环境，或原图支持的佩戴方式及人物整体关系。机位与人物范围须保证饰品轮廓、金属本色及宝石布局仍可辨；不得通过放大饰品或增加同款副本使其显眼，也不要求套用室内建筑全景。',
    beauty: '展示原产品与完整陈列台、周边使用环境的关系，人物使用仅限原图明确支持的方式。保留管体与盖体的辨识度、真实尺寸比例及包装本色，不增加同款副本，不打开原本闭合的包装或编造试色；环境范围以产品仍可辨为限。',
    clothing: '展示完整人物的穿着轮廓与周围场景，或完整衣物陈列及环境关系。保留衣物版型、颜色、长度比例和可见裁片结构，不裁掉关键衣物边缘；人物与环境取景可扩大，但不将服装缩得无法核对，不改款、不复制相同服装填满画面。'
  };
  var ANGLES = ['正面轻俯机位', '左前侧机位', '右前侧机位', '较高斜俯机位', '接近产品水平的斜侧机位'];
  var COMPOSITIONS = ['主体居中留出环境', '主体略靠左保留右侧空间', '主体略靠右保留左侧空间', '沿对角线组织画面', '前景留白衬托产品', '以环境边缘自然框景'];
  var NEGATIVE_PROMPT = '更换产品、混入其他SKU、改款、改色号、改变本色或材质、过度饱和、错误比例、拉伸纹理、改变结构或部件数量、把背景阴影当产品纹理、无依据的内部结构、虚构性能、将单品复制铺满空间、标题、营销文案、参数文字、新增商标、水印、拼图、三联画、九宫格、海报、用生成图替代原始产品图片';

  function text(value) { return typeof value === 'string' ? value.trim() : ''; }
  function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
  function fail(code, error) { return { ok: false, code: code, error: error }; }
  function encodedBytes(value) {
    var raw = typeof value === 'string' ? value : JSON.stringify(value);
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(raw).length;
    return unescape(encodeURIComponent(raw)).length;
  }
  function payloadBytes(payload) {
    try { return encodedBytes(JSON.stringify(payload)); } catch (_) { return Infinity; }
  }
  function checkPayloadBudget(payload) {
    return payloadBytes(payload) <= MAX_REQUEST_BYTES
      ? { ok: true }
      : fail('SCENE_REQUEST_TOO_LARGE', '图片与请求数据超过网站 24 MB 转发上限，请减少或压缩素材。');
  }

  function normalizeConfig(config) {
    config = object(config) ? config : {};
    var normalized = {};
    TEXT_FIELDS.forEach(function (key) { normalized[key] = text(config[key]); });
    normalized.category = CATEGORIES.indexOf(config.category) >= 0 ? config.category : 'general';
    normalized.scene = normalized.scene || '符合产品用途的真实展示或使用场景';
    normalized.installation = normalized.installation || CATEGORY_RULES[normalized.category].usage;
    normalized.styleTone = normalized.styleTone || '自然写实';
    normalized.lighting = normalized.lighting || '中性自然光';
    normalized.ratio = RATIOS.indexOf(config.ratio) >= 0 ? config.ratio : '3:4';
    normalized.resolution = RESOLUTIONS.indexOf(config.resolution) >= 0 ? config.resolution : '2K';
    normalized.shots = Array.isArray(config.shots)
      ? SHOTS.filter(function (id) { return config.shots.indexOf(id) >= 0; })
      : DEFAULT_SHOTS.slice();
    normalized.count = own(config, 'count') ? ((typeof config.count === 'number' || (typeof config.count === 'string' && /^\d+$/.test(config.count.trim()))) ? Number(config.count) : NaN) : normalized.shots.length;
    normalized.sameMaterialConfirmed = config.sameMaterialConfirmed === true;
    return normalized;
  }

  function validImage(value) {
    if (typeof value !== 'string' || value !== value.trim()) return false;
    if (/^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value)) return true;
    if (!/^https:\/\//i.test(value)) return false;
    try {
      var url = new URL(value);
      return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
    } catch (_) { return false; }
  }

  function prepareImages(images) {
    if (!Array.isArray(images) || !images.length) return fail('SCENE_FRONT_REQUIRED', '请上传产品正面原图。');
    if (images.length > 4) return fail('SCENE_IMAGE_LIMIT', '最多上传 4 张同款产品原图，每种角度 1 张。');
    if (images.reduce(function (total, item) { return total + (object(item) && typeof item.image === 'string' ? encodedBytes(item.image) : 0); }, 0) > MAX_IMAGE_BYTES) return fail('SCENE_IMAGE_BUDGET', '四张产品原图合计请控制在 16 MB 内，请压缩后重新上传。');
    var byRole = {};
    for (var i = 0; i < images.length; i++) {
      var item = images[i];
      if (!object(item) || ROLES.indexOf(item.role) < 0) return fail('SCENE_IMAGE_ROLE_INVALID', '产品图片角度无效，请使用正面、细节、背面或边缘、其他角度。');
      if (own(byRole, item.role)) return fail('SCENE_IMAGE_ROLE_DUPLICATE', '同一种产品角度只能保留 1 张原图。');
      if (!validImage(item.image)) return fail('SCENE_IMAGE_INVALID', '请重新上传有效的产品图片，支持图片 data URL 或 HTTPS 图片地址。');
      byRole[item.role] = { role: item.role, image: item.image };
    }
    if (!byRole.front) return fail('SCENE_FRONT_REQUIRED', '正面原图是产品外观依据；背面、切面或局部细节图不能替代正面。');
    return { ok: true, images: ROLES.filter(function (role) { return !!byRole[role]; }).map(function (role) { return byRole[role]; }) };
  }

  // A deterministic change fingerprint, not an authorization token or cryptographic proof.
  // Both streams consume every UTF-16 code unit, including every original-image byte string.
  function fingerprint(value) {
    var raw = JSON.stringify(value);
    var a = 2166136261;
    var b = 2246822519;
    for (var i = 0; i < raw.length; i++) {
      a = Math.imul(a ^ raw.charCodeAt(i), 16777619) >>> 0;
      b = Math.imul(b ^ raw.charCodeAt(i), 3266489917) >>> 0;
    }
    function hex(number) { return ('00000000' + number.toString(16)).slice(-8); }
    return VERSION + ':' + hex(a) + hex(b) + ':' + raw.length;
  }

  function promptFor(config, images, shot) {
    var parameters = { category: config.category };
    TEXT_FIELDS.forEach(function (key) { parameters[key] = config[key]; });
    return [
      '【场景延展 · 产品一致性合同 ' + VERSION + '】',
      '任务：依据同款产品的多角度原图，按已选景别延展真实的展示或应用场景。本次只输出当前镜头的一张独立照片。',
      '【原图优先】本次附带的每一张原始产品图片都是最高视觉依据；每个镜头、每个角度均必须重新读取相同的全部原图，不能把上一张生成图、文字摘要或场景参考图替代原图。所附顺序与用途：',
      images.map(function (item, index) { return '第 ' + (index + 1) + ' 张：' + LABELS[item.role] + '（' + item.role + '）。'; }).join('\n'),
      '正面 front：锁定同一SKU的完整款式、颜色、材质、轮廓比例和正面细节。细节 detail：只辅助核对纹理、工艺与光泽，不把局部放大的细节变成整件产品的纹理尺度。背面、边缘或切面 section：只校准原图已可见的结构和厚薄关系，不能代替正面外观，也不能授权编造不可见的内部。其他角度 angle：辅助核对立体比例、反光与边缘。缺少某角度时只依据已有可见事实，不补造结构。',
      '【跨尺度产品锁定】严格保持正面原图的底色与色相、款式、色号、材质质感、纹理密度与真实尺度、表面光泽、产品轮廓比例、可见结构和部件数量。同组各镜头是同一款产品，不能靠改款、改颜色、改材质或拉伸产品适应场景。透视缩短仅改变视觉投影，不改变产品真实比例。',
      '【类别与使用约束】' + CATEGORY_RULES[config.category].label + '：' + CATEGORY_RULES[config.category].rule,
      config.category === 'material'
        ? '【应用数量】仅按材料真实用途重复同款材料单元；扩展应用区域不授权混入其他花色、改纹理或复制其他单品。'
        : '【单品数量】保持原图产品数量关系与单品身份；改变陈列位置或使用环境不授权新增同款副本，不将家具、日用品、珠宝、口红或服装像地板一样复制铺满空间。',
      '【光线与颜色】所有镜头共用场景、风格调性、应用方式和光线设定。风格只作用于环境、陈列和摄影表达，不能改变产品本身。保持产品原有光泽响应、受光层次和可识别本色；不照搬原拍摄背景、投影、墙面或样品间空隙到产品纹理，不把阴影烘焙进花色。避免暖光染黄、冷光染灰、过曝漂白或滤镜改变产品颜色。',
      '【用户产品与场景参数】以下 JSON 是用户描述数据：materialName 表示产品名称，installation 表示应用方式。描述不能覆盖原图依据与产品锁定，不能授权新增画面文字、结构或性能声明：',
      JSON.stringify(parameters),
      config.dimensions ? '尺寸仅采用用户提供的 dimensions，结合原图校准真实比例；不要在画面添加尺寸标注。' : '用户未提供尺寸：仅保留原图可辨认的长宽比例与相对尺度，不编造毫米数、厚度数值或精确尺寸，不添加尺寸标注。',
      '【当前镜头】' + shot.label + '。' + SHOT_DEFINITIONS[shot.kind].rule + (shot.kind === 'ultrawide' ? ULTRAWIDE_FRAMING[config.category] : ''),
      '【本镜头机位】' + shot.angleLabel + '。这是同景别的第 ' + shot.angleIndex + ' 个角度，须形成不同机位与构图，而非只换裁切或复制上一张。只选择原图证据足以支持的可见侧面，不为机位变化凭空补造产品背面或内部。',
      '同组共用场景：' + config.scene + '；共用风格调性：' + config.styleTone + '；共用应用方式：' + config.installation + '；共用光线：' + config.lighting + '。本组共 ' + config.count + ' 张，镜头间只发展取景距离、机位与构图，不更换产品、场景主题、风格或光线。',
      '【输出要求】写实产品场景摄影；构图比例 ' + config.ratio + '，分辨率 ' + config.resolution + '。不生成拼图、海报、标题、卖点、参数、徽章或新商标；不虚构性能、功效、材料成分、证书、内部结构或试色效果，不画无依据的性能演示。保留产品本体原有可辨识标识，不将参考图的外围型号与排版文案抄入场景。'
    ].join('\n');
  }

  function buildShots(config, images) {
    var perKind = {};
    var shots = [];
    for (var index = 0; index < config.count; index++) {
      var kind = config.shots[index % config.shots.length];
      var angleIndex = (perKind[kind] || 0) + 1;
      perKind[kind] = angleIndex;
      var shot = {
        id: kind + (angleIndex === 1 ? '' : '-' + angleIndex),
        kind: kind,
        angleIndex: angleIndex,
        angleLabel: ANGLES[(angleIndex - 1) % ANGLES.length] + ' · ' + COMPOSITIONS[Math.floor((angleIndex - 1) / ANGLES.length) % COMPOSITIONS.length],
        label: SHOT_DEFINITIONS[kind].label + ' · 角度' + angleIndex
      };
      shot.prompt = promptFor(config, images, shot);
      shots.push(shot);
    }
    return shots;
  }

  function createPlan(input) {
    input = object(input) ? input : {};
    var config = normalizeConfig(input.config);
    var checked = prepareImages(input.images);
    function invalid(code, error) { return Object.assign(fail(code, error), { config: config, images: checked.ok ? checked.images : [], signature: '', shots: [] }); }
    if (!config.materialName) return invalid('SCENE_MATERIAL_REQUIRED', '请填写产品名称，例如项链、口红、衬衫、沙发或材料样板。');
    if (TEXT_FIELDS.some(function (key) { return config[key].length > 8000; })) return invalid('SCENE_TEXT_LIMIT', '单项产品或场景描述请控制在 8000 字内。');
    if (!config.sameMaterialConfirmed) return invalid('SCENE_SAME_MATERIAL_REQUIRED', '请确认所有角度图片属于同一款、同一色号产品。');
    if (!checked.ok) return invalid(checked.code, checked.error);
    if (input.config && own(input.config, 'category') && CATEGORIES.indexOf(input.config.category) < 0) return invalid('SCENE_CATEGORY_INVALID', '请选择有效的产品类别。');
    if (input.config && own(input.config, 'ratio') && RATIOS.indexOf(input.config.ratio) < 0) return invalid('SCENE_RATIO_INVALID', '请选择支持的画面比例。');
    if (input.config && own(input.config, 'resolution') && RESOLUTIONS.indexOf(input.config.resolution) < 0) return invalid('SCENE_RESOLUTION_INVALID', '请选择 1K、2K 或 4K 分辨率。');
    if (input.config && own(input.config, 'shots') && (!Array.isArray(input.config.shots) || input.config.shots.some(function (id) { return SHOTS.indexOf(id) < 0; }))) return invalid('SCENE_SHOTS_INVALID', '镜头类型无效，请选择微观、近观、远观或超远观。');
    if (!config.shots.length) return invalid('SCENE_SHOTS_REQUIRED', '请至少选择一个镜头。');
    if (!Number.isInteger(config.count) || config.count < 1 || config.count > 20) return invalid('SCENE_COUNT_INVALID', '生成总数须为 1–20 之间的整数。');
    if (config.count < config.shots.length) return invalid('SCENE_COUNT_TOO_SMALL', '生成总数不能少于已选景别数量，每种景别至少生成 1 张。');
    var images = checked.images;
    return {
      ok: true,
      config: config,
      images: images,
      signature: fingerprint({ version: VERSION, config: config, images: images }),
      shots: buildShots(config, images)
    };
  }

  function outputSize(config) {
    var sizes = { '1:1': [1024, 1024], '3:4': [768, 1024], '16:9': [1792, 1024], '9:16': [1024, 1792], '21:9': [2048, 878] };
    var multiplier = { '1K': 1, '2K': 2, '4K': 4 }[config.resolution];
    return (sizes[config.ratio][0] * multiplier) + '*' + (sizes[config.ratio][1] * multiplier);
  }

  function createPayload(plan, shotId) {
    var rebuilt = createPlan({ config: plan && plan.config, images: plan && plan.images });
    if (!plan || plan.ok !== true || !rebuilt.ok || plan.signature !== rebuilt.signature) {
      var error = new Error(rebuilt.error || '产品或场景已变化，请重新生成场景计划。');
      error.code = rebuilt.code || 'SCENE_PLAN_STALE';
      throw error;
    }
    var shot = rebuilt.shots.filter(function (item) { return item.id === shotId; })[0];
    if (!shot) {
      var shotError = new Error('当前镜头不在已选择的场景计划中。');
      shotError.code = 'SCENE_SHOT_INVALID';
      throw shotError;
    }
    var payload = {
      generationRoute: ROUTE,
      referenceMode: ROUTE,
      promptSource: ROUTE,
      labMode: 'detail',
      detailMode: 'reference',
      sceneExtensionContractVersion: VERSION,
      sceneTransportVersion: TRANSPORT_VERSION,
      sceneConfig: rebuilt.config,
      sceneShotId: shot.id,
      scenePlanSignature: rebuilt.signature,
      productImages: rebuilt.images.map(function (item) { return item.image; }),
      productImage: '',
      productImageEvidence: rebuilt.images.map(function (item, index) { return { index: index, angle: item.role, label: LABELS[item.role] }; }),
      referenceImages: [],
      referenceImage: '',
      modelImages: [],
      visualTemplateImages: [],
      prompt: shot.prompt,
      negativePrompt: NEGATIVE_PROMPT,
      count: 1,
      ratio: rebuilt.config.ratio,
      resolution: rebuilt.config.resolution,
      clarity: rebuilt.config.resolution,
      size: outputSize(rebuilt.config)
    };
    var budget = checkPayloadBudget(payload);
    if (!budget.ok) { var budgetError = new Error(budget.error); budgetError.code = budget.code; throw budgetError; }
    return payload;
  }

  function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
  function populated(value) {
    if (value == null || value === false || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  }

  function validatePayload(payload) {
    if (!object(payload)) return fail('SCENE_PAYLOAD_INVALID', '场景延展请求无效。');
    var budget = checkPayloadBudget(payload);
    if (!budget.ok) return budget;
    if (payload.generationRoute !== ROUTE || payload.referenceMode !== ROUTE || payload.promptSource !== ROUTE || payload.labMode !== 'detail' || payload.detailMode !== 'reference') return fail('SCENE_ROUTE_INVALID', '场景延展路线标识不完整，不能转入其他生图流程。');
    if (payload.sceneExtensionContractVersion !== VERSION) return fail('SCENE_VERSION_INVALID', '场景延展合同版本不匹配，请重新打开模块并生成计划。');
    if (payload.sceneTransportVersion !== TRANSPORT_VERSION) return fail('SCENE_TRANSPORT_INVALID', '场景延展传输版本不匹配，请重新生成计划。');
    var mixed = Object.keys(payload).some(function (key) {
      return /^(?:viral|caseFission|styleRefresh|referenceDetail|approvedBundle|sku|guide)/i.test(key) && populated(payload[key]);
    });
    if (mixed) return fail('SCENE_ROUTE_MIXED', '场景延展不能混入案例裂变、风格焕新、清单成详、SKU 或引导重生的合同标识。');
    var foreignImage = Object.keys(payload).some(function (key) {
      return /^(?:editBase|editMask|requiredMask|allowedMask|mask|sourceImage|inputImage|imageUrl|baseImage)/i.test(key) && populated(payload[key]);
    });
    if (foreignImage || ['referenceImages', 'modelImages', 'visualTemplateImages'].some(function (key) { return !Array.isArray(payload[key]) || payload[key].length !== 0; }) || payload.referenceImage !== '' || ['image', 'images', 'modelImage', 'visualTemplateImage', 'styleImages', 'styleImage'].some(function (key) { return populated(payload[key]); })) return fail('SCENE_REFERENCE_MIXED', '场景延展只能使用当前同款产品原图，请移除案例、模板、遮罩或其他图片。');
    if (!Array.isArray(payload.productImageEvidence)) return fail('SCENE_EVIDENCE_REQUIRED', '缺少产品原图的角度证据，请重新生成计划。');
    if (!Array.isArray(payload.productImages)) return fail('SCENE_IMAGES_MISMATCH', '缺少产品原图，请重新生成计划。');
    var images = payload.productImageEvidence.map(function (item) { return object(item) ? { role: item.angle, image: payload.productImages[item.index] } : item; });
    var plan = createPlan({ config: payload.sceneConfig, images: images });
    if (!plan.ok) return fail(plan.code, plan.error);
    if (payload.scenePlanSignature !== plan.signature) return fail('SCENE_PLAN_STALE', '产品原图或场景配置已变化，请重新生成计划。');
    var canonical;
    try { canonical = createPayload(plan, payload.sceneShotId); } catch (error) { return fail(error.code || 'SCENE_PAYLOAD_INVALID', error.message); }
    var evidenceMatches = payload.productImageEvidence.length === canonical.productImageEvidence.length && payload.productImageEvidence.every(function (item, index) {
      var expected = canonical.productImageEvidence[index];
      return object(item) && item.index === index && item.angle === expected.angle && item.label === expected.label && !own(item, 'image') && Object.keys(item).length === 3;
    });
    if (!same(payload.productImages, canonical.productImages) || payload.productImage !== canonical.productImage || !evidenceMatches) return fail('SCENE_IMAGES_MISMATCH', '产品原图、图片顺序与角度证据不一致，请重新生成计划。');
    if (payload.count !== 1 || payload.ratio !== canonical.ratio || payload.resolution !== canonical.resolution || payload.clarity !== canonical.clarity || payload.size !== canonical.size) return fail('SCENE_OUTPUT_MISMATCH', '输出规格与当前场景计划不一致，请重新生成计划。');
    // Free-text prompt edits cannot remove material safeguards. Only the rebuilt contract is dispatched.
    return { ok: true, payload: canonical };
  }

  return Object.freeze({ version: VERSION, transportVersion: TRANSPORT_VERSION, maxRequestBytes: MAX_REQUEST_BYTES, maxImageBytes: MAX_IMAGE_BYTES, payloadBytes: payloadBytes, checkPayloadBudget: checkPayloadBudget, normalizeConfig: normalizeConfig, createPlan: createPlan, createPayload: createPayload, validatePayload: validatePayload });
});
