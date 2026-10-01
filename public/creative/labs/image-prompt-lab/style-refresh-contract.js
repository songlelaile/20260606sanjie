(function (root, factory) {
  'use strict';
  var contract = factory();
  if (typeof module === 'object' && module.exports) module.exports = contract;
  if (root) root.SZ_STYLE_REFRESH_CONTRACT = contract;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 'STYLE_REFRESH_V10';
  var STRENGTHS = Object.freeze({
    stable: Object.freeze({ id: 'stable', name: '稳妥焕新', redesignTarget: 45, rule: '保留熟悉的电商构图，只升级背景、光影、留白和材质质感。' }),
    commercial: Object.freeze({ id: 'commercial', name: '商业升级', redesignTarget: 68, rule: '在商品身份不变的前提下明显重构场景、镜头、光影和视觉秩序。' }),
    breakthrough: Object.freeze({ id: 'breakthrough', name: '破圈创意', redesignTarget: 86, rule: '允许大胆尺度、空间与艺术化表达，但不得改变商品本体或妨碍商品识别。' })
  });

  var COPY_MODES = Object.freeze({
    none: Object.freeze({ id: 'none', name: '不要文案' }),
    generate: Object.freeze({ id: 'generate', name: '生成新文案' }),
    rewrite: Object.freeze({ id: 'rewrite', name: '修改已有文案' })
  });

  var FLOOR_VISUAL_LOCK = '只改变墙面、家具、道具、光线、机位与留白；严格保持输入形态以及地板SKU的色号、材质或木种、纹理、板宽板长、铺装方向与拼法、拼缝、倒角、光泽、表面工艺、可见边界和数量，单片、色板、成叠、卷材或包装不得复制、展开或扩铺，未经商品事实确认不得写入防水、地暖、静音、防滑、环保或抗菌性能。';
  var CARPET_VISUAL_LOCK = '只改变墙面、家具、道具、光线、机位、留白与文案气质；严格保持输入形态以及地毯SKU的图案、色号、边框与中心章、织法、纤维、绒高与绒向、雕花层次、光泽、形状尺寸、厚度、背衬、包边或流苏、纹样重复、模块尺寸、接缝、裁切收口、铺向、可见边界和数量，卷起、折叠、成叠、色样、单张或包装不得复制、展开、裁切或扩铺，未经商品事实确认不得写入手工、手结、产地、羊毛、真丝、可水洗、防污、防滑、阻燃、环保、静音、吸音或抗菌性能。';
  var HOME_DAILY_VISUAL_LOCK = '只改变空间、家具、辅助道具、光线、机位、留白与文案气质；严格保持输入形态以及居家日用SKU的品类用途、轮廓结构、尺寸比例、数量、颜色、材质、纹理图案、文字标识、表面工艺、透明度、厚度、软硬与垂坠状态，以及盖体、开口、踏板、感应区、提手、内桶、刷头、刷杆、底座、挂钩、夹口、横杆、防滑件、包边、背衬、孔环、褶型、轨道或安装件等全部可见部件与连接关系。单件、套装、折叠、卷起、堆叠、样片、局部、包装或未安装输入不得复制、拆分、展开、裁切、增配或安装成完整场景；未经商品事实确认不得写入材质、容量、承重、防滑、防水、吸水、速干、刮泥、遮光、隔热、隔音、防晒、隐私、抗菌、防霉、除臭、防锈、阻燃、环保、再生、可回收、感应、缓降、静音、耐磨、户外或易清洁性能。';

  // Nutrition styles extend the catalog only; the V10 generation contract stays unchanged.
  var NUTRITION_VISUAL_LOCK = '风格仅作用于背景、台座、辅助道具、光线、机位、留白与文案气质；商品主体图仍是唯一事实来源，严格保持同一SKU的瓶身或盒袋轮廓、尺寸比例、瓶盖与封口、颜色、材质、透明度、标签版式、品牌标识、原有文字、图案、包装状态、可见内容物和数量。不得改瓶、换盖、换标、改字、补画被遮挡的标签或复制商品；未展示的胶囊、片剂、软糖、粉末、液体、切面、包装内件和赠品不得凭空增加，不得开瓶、拆盒、倾倒、切开或展示服用动作。环境配色不得染改商品本色，装饰不得附着标签；道具仅作为环境，不能暗示配方或原料来源。不得套用第三方品牌标志、独有包装、代言人、医护形象、认证章或功效示意；未经商品事实确认不得新增含量、成分、剂量、吸收率、产地、纯度、销量、价格、认证、适用人群或健康功效，文字仍服从用户所选文案模式。';

  // Card summaries are display-only. Keep the complete visual definitions below as
  // the sole source for generation, planning and product-identity safeguards.
  var STYLE_CARD_SUMMARIES = Object.freeze({
    'jewelry-organic-sculpture': '暖白曲面、圆润台座与连续柔影，结合近距离视角和克制反光，形成柔和而现代的雕塑感',
    'jewelry-art-deco': '深浅高反差色彩、阶梯几何与对称轴线，配合放射投影和锐利轮廓光，营造精致仪式感',
    'jewelry-urban-link': '拉丝金属、建筑网格与圆环构成，结合硬边城市光和近景裁切，呈现利落的都会力量',
    'jewelry-metal-lace': '细密镂空光影、哑光织物和暖金色调，以微距掠射光表达精密而轻盈的层次感',
    'jewelry-gem-spectrum': '透明材质、克制撞色与切面折射光，在深浅互补背景中建立明快有序的色彩层次',
    'jewelry-pearl-tide': '虹彩曲面、沙米色、水波纹理与柔润环形光，在静谧留白中形成轻盈通透的海岸氛围',
    'jewelry-secret-garden': '抽象叶影、半透明花瓣、露珠散景与柔和逆光，形成朦胧、灵动而克制的自然秘境',
    'jewelry-oriental-craft': '温润金色、玉色、墨黑漆面与宣纸留白，结合克制对称和暖色掠光，呈现当代东方气韵',
    'floor-nordic-light': '清澈侧光、矿物白墙、浅灰织物与低矮家具，在安静长视线中呈现清爽自然的北境氛围',
    'floor-twilight-timber': '深灰石膏、暖金属与局部照明，以克制暗部和丰富空间层次营造沉静私密的暮色气质',
    'floor-geometric-parquet': '对称空间、现代线脚、俯斜机位与清晰轴线，共同建立经典精准且富有节奏的几何秩序',
    'floor-architectural-mineral': '灰泥、玻璃、浅石立面与天窗漫射光，形成低饱和、理性纯粹的建筑材料感',
    'floor-urban-workshop': '清水混凝土、黑钢、长虹玻璃与硬边窗影，结合低机位透视，呈现硬朗完整的都会工业气质',
    'floor-hospitality-luxe': '暖色洗墙、柔和织物与少量金属点缀，通过前中后景层次呈现克制从容的款待感',
    'floor-biophilic-flow': '大窗自然景观、植物边界、天然织物与石材，以清透日光连接室内外，营造舒展平静的自然感',
    'floor-organic-colorfield': '柔和矿物色、圆角家具、哑光构件与俯拍网格，共同塑造包容轻松的当代色彩空间',
    'carpet-tonal-luxe': '暖灰空间、低矮曲线家具、同色系织物与大面积留白，以柔和光线呈现安静精致的触觉氛围',
    'carpet-abstract-gallery': '克制艺廊、单件雕塑家具、俯斜机位与展陈光，营造具有艺术张力又保持清晰秩序的画面',
    'carpet-classic-heritage': '温润灰泥、深木、少量旧金与现代线脚，在对称轴和柔和窗光中呈现沉稳雅致的传承气质',
    'carpet-modern-geometry': '象牙白、黑色与少量金属结合建筑切面和有序投影，形成清晰利落的现代几何节奏',
    'carpet-woven-craft': '浅木、亚麻、陶土与安静工作室尺度，借自然窗光和细腻投影传达质朴克制的织造触感',
    'carpet-sculptural-pile': '连续曲面、雾面台阶与低角度掠光构成雕塑展场，突出层次、触感与柔和起伏',
    'carpet-color-statement': '清晰负空间、正交或俯拍构图与明快硬光，让色彩关系成为画面的主要节奏和视觉焦点',
    'carpet-modular-grid': '清晰路径、功能分区、俯斜广角与线性灯带，结合克制陈设建立理性现代的模块秩序',
    'home-quiet-order': '暖白墙面、浅木台面、细线网格与柔和窗光，在真实尺度和克制留白中营造安静日常秩序',
    'home-compact-function': '紧凑空间、纵向线条、清晰动线和正交视角，强调有限尺度中的利落、高效与呼吸感',
    'home-precision-clean': '干净石材、微水泥和玻璃背景，结合精准轮廓光与克制反射，呈现清爽理性的精工气质',
    'home-soft-bath': '灰米矿物墙、雾面玻璃、低矮木作与柔雾晨光，形成洁净柔和且富有仪式感的空间',
    'home-sheer-daylight': '柔和侧逆光、克制框景、通透层次与大面积留白，共同营造轻盈朦胧的晨间氛围',
    'home-architectural-drape': '低饱和建筑面、整洁开口和纵向构图，借侧光强化垂直尺度与从容的空间节奏',
    'home-woven-table': '俯拍或四十五度视角、少量陶瓷与玻璃、贴面掠光和边缘细节，呈现细腻清晰的陈列氛围',
    'home-entry-graphic': '石材或木质过渡空间、斜向日光与俯斜视角，以简洁陈设和清晰动线营造友好到达感',
    'nutrition-ocean-blue': '海洋蓝白、远景水纹与清透侧光，在水平留白中呈现清爽通透的陈列气质',
    'nutrition-amber-optics': '暖黄背景、透明台座与斜向光影，以琥珀色环境反光形成明亮而精致的光学层次',
    'nutrition-clinical-white': '纯白展面、轻灰接触影与均匀柔光，以大面积留白突出简洁理性的产品识别',
    'nutrition-precision-grid': '冷白、雾蓝、薄灰分区与细线网格，结合正交构图和匀净布光建立清晰秩序',
    'nutrition-heritage-gold': '香槟米白、深棕与少量哑金，搭配居中展陈和克制轮廓光，呈现典雅传承感',
    'nutrition-botanical-green': '深浅植物绿、奶油白与远景叶影，在漫射日光和自然留白中呈现草本生活气息',
    'nutrition-mineral-form': '浅灰石面、粉笔白几何体与柔和掠光，借疏朗体块和稳定构图呈现沉静的材质秩序',
    'nutrition-daily-sunlight': '浅木桌面、米白墙与斜向窗光，少量远景日常器物营造自然松弛的晨间氛围',
    'nutrition-active-color': '钴蓝、明黄与珊瑚点色，结合几何台面和清晰硬影，形成年轻明快的视觉节奏',
    'nutrition-soft-pastel': '浅鹅黄、淡粉与薄荷色，搭配圆角背景和轻柔投影，呈现友好轻盈的柔彩气质',
    'nutrition-warm-care': '燕麦米色、暖木与远景柔焦，借低对比逆光和宽松留白传达温暖从容的日常感',
    'nutrition-red-focus': '白底、深灰分区与克制红色焦点，结合清晰主次和干净投影，形成鲜明的商业陈列'
  });

  var STYLES = Object.freeze([
    Object.freeze({ id: 'gallery-white', name: '白盒美术馆', group: '高级棚拍', tags: ['服装', '鞋履', '箱包', '配饰', '珠宝'], fit: ['服装', '鞋', '包', '首饰', '饰品', '金属'], visual: '纯净暖白展厅、雕塑式留白、柔和顶侧光、低饱和阴影、克制高级的艺术陈列' }),
    Object.freeze({ id: 'architectural-pedestal', name: '建筑基座', group: '高级棚拍', tags: ['鞋履', '箱包', '家居', '配饰'], fit: ['鞋', '包', '家居', '皮革', '金属'], visual: '几何建筑台座、硬朗空间切面、斜向日光、清晰体块与秩序感' }),
    Object.freeze({ id: 'tactile-fabric', name: '柔感织物', group: '材质叙事', tags: ['服装', '家纺', '软包', '配饰'], fit: ['服装', '家纺', '布艺', '针织', '棉', '羊毛', '丝'], visual: '层叠织物背景、柔软褶皱、近距离触感、漫射窗光、温和浅色调' }),
    Object.freeze({ id: 'obsidian-luxury', name: '黑曜奢品', group: '高级棚拍', tags: ['珠宝', '腕表', '皮具', '香氛'], fit: ['珠宝', '首饰', '腕表', '皮革', '金属', '玻璃'], visual: '深黑镜面与黑曜石、精确轮廓光、金属高光、低调奢华、戏剧化暗部' }),
    Object.freeze({ id: 'hard-flash-editorial', name: '硬闪编辑', group: '潮流编辑', tags: ['服装', '鞋履', '眼镜', '配饰'], fit: ['服装', '鞋', '眼镜', '帽', '饰品'], visual: '杂志硬闪、锐利投影、近景裁切、轻微颗粒、直接而时髦的编辑感' }),
    Object.freeze({ id: 'film-street', name: '胶片街拍', group: '潮流编辑', tags: ['服装', '鞋履', '箱包', '配饰'], fit: ['服装', '鞋', '包', '帽', '眼镜'], visual: '城市街角、自然抓拍、胶片颗粒、真实环境光、松弛生活方式氛围' }),
    Object.freeze({ id: 'kinetic-freeze', name: '动态冻结', group: '运动能量', tags: ['运动服', '鞋履', '户外', '配饰'], fit: ['运动', '鞋', '户外', '尼龙', '机能'], visual: '高速动作冻结、风感与颗粒飞溅、强方向光、倾斜构图、清晰能量轨迹' }),
    Object.freeze({ id: 'surreal-scale', name: '超现实巨物', group: '创意实验', tags: ['箱包', '鞋履', '配饰', '潮玩'], fit: ['包', '鞋', '饰品', '潮玩'], visual: '超现实尺度反差、微缩人物或巨物空间、清楚商品轮廓、电影化景深与想象力' }),
    Object.freeze({ id: 'color-block', name: '色块平面', group: '平面设计', tags: ['服装', '鞋履', '配饰', '美妆'], fit: ['服装', '鞋', '饰品', '彩色', '美妆'], visual: '大面积色块、图形切割、平面构成、清晰负空间、强识别但无文字的海报语言' }),
    Object.freeze({ id: 'liquid-metal', name: '液态金属', group: '创意实验', tags: ['珠宝', '眼镜', '科技配饰', '鞋履'], fit: ['珠宝', '首饰', '眼镜', '金属', '科技', '鞋'], visual: '流动银色金属、镜面反射、冷色光晕、未来感材质、精致高光控制' }),
    Object.freeze({ id: 'local-craft', name: '在地手作', group: '生活方式', tags: ['服装', '编织', '家居', '配饰'], fit: ['服装', '编织', '木', '陶', '棉麻', '手作'], visual: '手作工作台、自然材料、暖色侧光、真实细节、质朴但精致的在地文化气息' }),
    Object.freeze({ id: 'natural-sunlight', name: '自然日照', group: '生活方式', tags: ['服装', '鞋履', '箱包', '家居'], fit: ['服装', '鞋', '包', '家居', '棉麻', '皮革'], visual: '居家或建筑空间自然日照、真实阴影、轻松呼吸感、柔和暖色、可信生活场景' }),
    Object.freeze({ id: 'wabi-sabi', name: '侘寂风', group: '生活方式', popular: true, tags: ['服装', '家居', '香氛', '手作', '配饰'], fit: ['棉麻', '亚麻', '陶', '木', '手作', '服装', '家居', '香氛'], visual: '灰米与泥土色、粗粝墙面和天然肌理、不对称留白、柔和侧光、安静克制且带时间痕迹' }),
    Object.freeze({ id: 'mid-century-vintage', name: '中古风', group: '复古美学', popular: true, tags: ['服装', '箱包', '眼镜', '皮具', '家居'], fit: ['皮革', '木', '黄铜', '服装', '包', '眼镜', '配饰', '家具'], visual: '胡桃木、焦糖棕与橄榄绿、黄铜点缀、20世纪中期几何家具、暖色胶片光和摩登复古秩序' }),
    Object.freeze({ id: 'cream-soft', name: '奶油风', group: '生活方式', popular: true, tags: ['女装', '针织', '美妆', '母婴', '家居'], fit: ['女装', '针织', '羊毛', '美妆', '母婴', '家居', '米白', '柔软'], visual: '奶油白、燕麦色与浅咖、圆润曲线、软糯材质、低对比漫射光、温柔明亮且治愈的空间氛围' }),
    Object.freeze({ id: 'ins-minimal', name: 'INS风', group: '社媒热门', popular: true, tags: ['服装', '鞋履', '箱包', '美妆', '配饰'], fit: ['服装', '鞋', '包', '饰品', '美妆', '简约'], visual: '低饱和中性色、干净网格、自然光与轻阴影、随手感道具、适合社交媒体传播的轻盈极简构图' }),
    Object.freeze({ id: 'french-vintage', name: '法式复古', group: '复古美学', popular: true, tags: ['女装', '珠宝', '箱包', '香氛', '美妆'], fit: ['女装', '蕾丝', '丝绸', '珠宝', '首饰', '包', '香氛', '美妆'], visual: '象牙白、酒红与旧金色、古典线脚和丝绒质感、柔焦窗光、优雅浪漫的法式杂志氛围' }),
    Object.freeze({ id: 'new-chinese', name: '新中式', group: '东方审美', popular: true, tags: ['服装', '珠宝', '茶器', '家居', '配饰'], fit: ['国风', '中式', '丝', '锦', '茶', '玉', '首饰', '服装', '家居'], visual: '黛青、米宣与朱砂点色、现代留白、屏风窗棂和山水意象的抽象转译、含蓄东方光影与当代秩序' }),
    Object.freeze({ id: 'dopamine-color', name: '多巴胺', group: '平面设计', popular: true, tags: ['服装', '鞋履', '童装', '配饰', '潮玩'], fit: ['彩色', '童装', '服装', '鞋', '饰品', '潮玩', '年轻'], visual: '高明度撞色、快乐色块与圆润图形、强节奏构成、明快硬光、活力外放但保持商品轮廓清晰' }),
    Object.freeze({ id: 'american-retro', name: '美式复古', group: '复古美学', popular: true, tags: ['牛仔', '运动服', '鞋履', '户外', '皮具'], fit: ['牛仔', '皮革', '运动', '户外', '鞋', '帽', '服装', '复古'], visual: '褪色红蓝、牛仔与旧皮革、70至90年代广告色调、颗粒硬光、公路或运动场景的自由复古气质' }),
    Object.freeze({ id: 'korean-clean', name: '韩系清透', group: '社媒热门', popular: true, tags: ['女装', '美妆', '珠宝', '箱包', '配饰'], fit: ['女装', '美妆', '首饰', '包', '针织', '浅色', '清透'], visual: '高明度低饱和、清透柔光、简洁浅色背景、细腻肤感与克制道具、轻巧精致的韩系商业画面' }),
    Object.freeze({ id: 'wood-healing', name: '原木治愈', group: '生活方式', popular: true, tags: ['家居', '服装', '手作', '母婴', '配饰'], fit: ['木', '棉麻', '手作', '家居', '母婴', '服装', '自然'], visual: '浅原木、米白与植物绿、自然材料和居家尺度、柔暖窗光、真实生活痕迹与松弛治愈感' }),
    Object.freeze({ id: 'y3k-future', name: 'Y3K未来', group: '创意实验', popular: true, tags: ['鞋履', '眼镜', '科技配饰', '运动服', '美妆'], fit: ['科技', '金属', '眼镜', '鞋', '运动', '美妆', '机能'], visual: '液态玻璃、虹彩金属与透明层叠、冷色霓虹边光、流行未来主义空间、锐利但精致的数字时尚感' }),
    Object.freeze({ id: 'scrapbook-collage', name: '拼贴手账', group: '潮流编辑', popular: true, tags: ['服装', '配饰', '文创', '食品', '潮玩'], fit: ['服装', '饰品', '文创', '食品', '潮玩', '年轻', '手作'], visual: '撕纸边缘、胶带笔触和印刷网点、非规则拼贴、手作标记与真实材质阴影，形成亲近而有个性的社媒编辑感' }),
    Object.freeze({ id: 'jewelry-organic-sculpture', name: '流体雕塑', group: '珠宝美学', tags: ['珠宝', '首饰', '耳饰', '戒指', '素金', '金属配饰'], fit: ['珠宝首饰', '珠宝', '首饰', '饰品', '耳环', '耳饰', '戒指', '吊坠', '素金', '黄金', '白金', '铂金', '银饰', '纯银', '银色金属', '金属', '镜面', '缎面'], visual: '暖白曲面、卵石形石膏台、连续柔影、贴近身体尺度的微距、镜面与缎面反光，以雕塑留白衬托原有轮廓，不改变商品造型' }),
    Object.freeze({ id: 'jewelry-art-deco', name: '鎏光几何', group: '珠宝美学', tags: ['珠宝', '腕表', '钻石', '婚戒', '彩宝', '配饰'], fit: ['珠宝首饰', '珠宝', '首饰', '饰品', '腕表', '钻石婚戒', '钻石', '婚戒', '铂金', '白金', '银饰', '纯银', '银色金属', '金属', '彩宝', '黑玛瑙', '祖母绿', '红宝石', '蓝宝石'], visual: '漆黑、象牙白与深宝石色的阶梯几何台座、对称中轴、放射投影、锐利轮廓光和克制镜面，只用背景呼应原有宝石色，不新增纹样或宝石' }),
    Object.freeze({ id: 'jewelry-urban-link', name: '都市链构', group: '珠宝美学', tags: ['珠宝', '项链', '手链', '手镯', '男饰', '中性配饰'], fit: ['珠宝首饰', '珠宝', '首饰', '饰品', '链条', '链节', '项链', '手链', '手镯', '男士', '中性', '银饰', '纯银', '银色金属', '金属', '钛饰', '钢饰'], visual: '拉丝钢、建筑网格与圆环远景装置、硬边城市光、近景裁切和强体块秩序，强化原有链节与金属质感，不增加链节或五金' }),
    Object.freeze({ id: 'jewelry-metal-lace', name: '金工蕾丝', group: '珠宝美学', tags: ['珠宝', '黄金', '钻石', '手工艺', '高级珠宝', '配饰'], fit: ['珠宝首饰', '珠宝', '首饰', '黄金首饰', '黄金', '足金', '金属', '钻石', '镂空', '花丝', '錾刻', '拉丝', '锤纹', '编织'], visual: '细密镂空屏风投影、哑光丝绸、旧金与象牙色、微距掠射光，呈现高定金工的精密与轻盈，不给商品表面新增雕纹' }),
    Object.freeze({ id: 'jewelry-gem-spectrum', name: '彩宝光谱', group: '珠宝美学', tags: ['珠宝', '彩宝', '戒指', '耳饰', '项链', '高级珠宝'], fit: ['珠宝首饰', '珠宝', '首饰', '彩宝戒指', '彩宝', '宝石', '戒指', '耳环', '项链', '红宝石', '蓝宝石', '祖母绿', '碧玺', '托帕石', '水晶', '珐琅'], visual: '从商品现有宝石取色的透明玻璃、克制撞色色块、切面折射光和深浅互补背景，保持原有宝石种类、数量与颜色不变' }),
    Object.freeze({ id: 'jewelry-pearl-tide', name: '海潮珠光', group: '珠宝美学', tags: ['珠宝', '珍珠', '项链', '耳饰', '胸针', '配饰'], fit: ['珠宝首饰', '珠宝', '首饰', '珍珠项链', '珍珠', '贝母', '珠链', '项链', '耳环', '胸针', '海水珠', '淡水珠', '异形珠', 'Akoya'], visual: '珠母虹彩、贝壳曲面、沙米色与浅水波纹、柔润环形高光和静谧留白，突出原有珠光与形态，不凭空增加珍珠或贝母' }),
    Object.freeze({ id: 'jewelry-secret-garden', name: '秘境花园', group: '珠宝美学', tags: ['珠宝', '女饰', '钻石', '彩宝', '珍珠', '高级珠宝'], fit: ['珠宝首饰', '珠宝', '首饰', '花朵', '植物', '枝叶', '钻石', '彩宝', '珍珠', '珐琅', '胸针', '耳环', '项链'], visual: '抽象叶影、远景半透明花瓣、露珠散景、雾面玻璃与柔和逆光，花草只作环境衬景，不附着或替换珠宝结构' }),
    Object.freeze({ id: 'jewelry-oriental-craft', name: '东方古韵', group: '珠宝美学', tags: ['珠宝', '黄金', '玉石', '珍珠', '珐琅', '东方配饰'], fit: ['珠宝首饰', '珠宝', '首饰', '古法黄金', '黄金', '足金', '玉镯', '玉石', '翡翠', '和田玉', '珍珠', '珐琅', '花丝', '錾刻', '金丝'], visual: '温润金色、玉色、墨黑漆面与宣纸留白、细金丝般投影、克制对称和暖色掠光，只呈现东方工艺气韵，不新增图腾或改色' }),
    Object.freeze({ id: 'floor-nordic-light', name: '北境木光', group: '地板美学', tags: ['地板', '木地板', '实木地板', '工程木地板', '强化地板', '浅色地材'], fit: ['地板', '木地板', '实木地板', '实木复合地板', '工程木地板', '多层实木地板', '三层实木地板', '强化地板', '复合地板', '浅色木地板', '浅色木纹地板', '橡木地板', '白橡木地板', '白蜡木地板', '宽板地板', '长板地板'], visual: '清澈侧光、矿物白墙、浅灰亚麻与低矮功能家具，镜头顺输入已有板向建立安静长视线，暮色或暖色环境也不得漂白、染色或重排地板；' + FLOOR_VISUAL_LOCK }),
    Object.freeze({ id: 'floor-twilight-timber', name: '暮色木境', group: '地板美学', tags: ['深色木地板', '深色实木地板', '烟熏木地板', '烟熏橡木', '烟熏橡木地板', '胡桃木地板', '热处理木地板', '高端住宅地板'], fit: ['深色木地板', '深色实木地板', '烟熏木地板', '烟熏橡木', '烟熏橡木地板', '深色橡木地板', '胡桃木地板', '黑胡桃地板', '热处理木地板', '碳化木地板', '深棕地板', '黑色地板', '会所地板'], visual: '深灰石膏、拉丝古铜、暖色局部照明和克制暗部，以私邸层次衬托输入本来就有的深木、烟熏或胡桃色，绝不把浅色地板染深或提高镜面反光；' + FLOOR_VISUAL_LOCK }),
    Object.freeze({ id: 'floor-geometric-parquet', name: '几何木序', group: '地板美学', tags: ['人字拼地板', '鱼骨拼地板', '拼花地板', '艺术地板', '高端木地板'], fit: ['人字拼地板', '鱼骨拼地板', 'Chevron地板', '人字拼', '鱼骨拼', '法式人字拼', '拼花地板', '艺术拼花地板', '凡尔赛拼花地板', '篮编地板', '几何拼花地板'], visual: '对称厅堂、现代线脚、俯斜机位和清晰轴线，只沿输入原本已有的人字、鱼骨、Chevron或拼花节奏构图，直铺板不得改成拼花，也不得新增边框、嵌条或双色组合；' + FLOOR_VISUAL_LOCK }),
    Object.freeze({ id: 'floor-architectural-mineral', name: '建筑矿境', group: '地板美学', tags: ['石纹地板', '水泥纹地板', 'SPC地板', 'LVT地板', '矿物地材', '水磨石地板'], fit: ['SPC地板', '石塑地板', 'LVT地板', 'PVC地板', '水泥纹地板', '混凝土纹地板', '石纹地板', '仿石地板', '石材地板', '瓷砖地面', '微水泥地面', '水磨石地板', '洞石纹地板', '大理石纹地板'], visual: '整体灰泥、玻璃、浅石立面和天窗漫射光形成低饱和建筑秩序，不把木纹换成石纹，不重绘原石纹、印刷重复或水磨颗粒；' + FLOOR_VISUAL_LOCK }),
    Object.freeze({ id: 'floor-urban-workshop', name: '都会工坊', group: '地板美学', tags: ['地板', '工业风地板', '商用地板', '深色地材', '工装地面'], fit: ['地板', '工业风地板', '商用地板', '工装地板', '水泥纹地板', '灰色地板', '深色地板', '办公室地板', '零售空间地板', '展厅地板'], visual: '清水混凝土墙、远景黑钢、长虹玻璃、厂房高窗、硬边窗影和低机位建筑透视，工业元素只存在于环境，不向地板新增水泥、金属、砖纹、划痕或做旧；' + FLOOR_VISUAL_LOCK }),
    Object.freeze({ id: 'floor-hospitality-luxe', name: '酒店雅奢', group: '地板美学', tags: ['地板', '木地板', '酒店地板', '会所地板', '高端住宅地板', '石材地面'], fit: ['地板', '木地板', '橡木地板', '胡桃木地板', '酒店地板', '酒店大堂地板', '会所地板', '高端住宅地板', '工程木地板', '实木复合地板', '拼花地板', '石材地板', '大理石地板'], visual: '暖色洗墙、羊毛织物、少量黄铜和酒店式前中后景层次，以克制款待感呈现地面尺度，不新增边框、拼色、镜面光泽或品牌式图案；' + FLOOR_VISUAL_LOCK }),
    Object.freeze({ id: 'floor-biophilic-flow', name: '生境共融', group: '地板美学', tags: ['木地板', '竹地板', '软木地板', '弹性地材', '商用地板', '生物亲和'], fit: ['竹地板', '软木地板', '亚麻地板', '橡胶地板', '生物基地板', '环保地板', '低碳地板', '商用地板', '办公地板', '学校地板', '医院地板', '康养空间地板'], visual: '大窗外林木、空间边缘植物群落、天然织物与石材家具、清透日光和室内外衔接，叶影只落在墙面，植物不覆盖地板，环境绿光不得污染原色；' + FLOOR_VISUAL_LOCK }),
    Object.freeze({ id: 'floor-organic-colorfield', name: '有机色场', group: '地板美学', tags: ['亚麻地板', '橡胶地板', '软木地板', '弹性地材', '方块地材', '商用地板'], fit: ['亚麻地板', '亚麻油毡', '橡胶地板', '软木地板', '弹性地板', '弹性卷材', '卷材地板', '同质透心地板', '塑胶地板', 'PVC卷材', '方块地材', '方块地毯', '地毯砖', '织物地板', '声学地板'], visual: '柔和矿物色墙面、圆角家具、哑光声学构件和俯拍网格，环境色块从输入地材已有色号取得，不在地面重新分区、改色或新增云石、颗粒、织纹与模块组合；' + FLOOR_VISUAL_LOCK }),
    Object.freeze({ id: 'carpet-tonal-luxe', name: '静奢绒境', group: '地毯美学', tags: ['地毯', '块毯', '素色地毯', '低饱和地毯', '高端家居', '私邸地毯'], fit: ['地毯', '块毯', '客厅地毯', '卧室地毯', '羊毛地毯', '真丝地毯', '纯色地毯', '素色地毯', '米色地毯', '奶油色地毯', '灰色地毯', '短绒地毯'], visual: '暖石灰墙、低矮曲线家具、同色系织物与大面积呼吸留白，以柔和顶侧光和贴地掠射光呈现输入原有绒面、光泽与轮廓，环境色只能协调，不得漂白、染色或柔化商品图案；' + CARPET_VISUAL_LOCK }),
    Object.freeze({ id: 'carpet-abstract-gallery', name: '抽象画境', group: '地毯美学', tags: ['地毯', '抽象地毯', '渐变地毯', '艺术地毯', '现代地毯', '印花地毯'], fit: ['地毯', '抽象地毯', '艺术地毯', '渐变地毯', '水彩地毯', '泼墨地毯', '烟雾地毯', '云纹地毯', '数码印花地毯', '印花地毯', '现代地毯', '设计师地毯'], visual: '克制白盒或深色艺廊、单件雕塑家具、俯斜机位与柔硬结合的展陈光，背景只从输入地毯已有色彩取得低饱和呼应，不得添加、重绘、延伸或模仿任何笔触、渐变或艺术家作品；' + CARPET_VISUAL_LOCK }),
    Object.freeze({ id: 'carpet-classic-heritage', name: '古典回廊', group: '地毯美学', tags: ['地毯', '古典地毯', '传统纹样', '复古地毯', '欧式地毯', '东方地毯'], fit: ['地毯', '古典地毯', '传统地毯', '波斯地毯', '土耳其地毯', '奥沙克地毯', '东方地毯', '中式地毯', '欧式地毯', '奥比松地毯', '萨伏纳里地毯', '中心章地毯', '边框地毯', '复古地毯', '仿古地毯'], visual: '温润灰泥、深木、少量旧金和现代化线脚构成安静回廊，以对称轴、柔和窗光和收藏级私邸尺度衬托输入原有中心章、边框与纹样，不得新增徽章、花卉、图腾、磨损或做旧；' + CARPET_VISUAL_LOCK }),
    Object.freeze({ id: 'carpet-modern-geometry', name: '摩登几何', group: '地毯美学', tags: ['地毯', '几何地毯', '现代地毯', '艺术地毯', '装饰艺术', '设计师地毯'], fit: ['地毯', '几何地毯', '线性地毯', '条纹地毯', '棋盘格地毯', '方格地毯', '圆点地毯', '抽象几何地毯', 'Art Deco地毯', '装饰艺术地毯', '包豪斯地毯', '孟菲斯地毯', '现代地毯'], visual: '象牙白、黑色与少量金属的建筑切面，沿输入已有线条、格网或几何轴线安排台阶、家具和投影，无几何图案的商品不得被生成几何纹样，也不得改变原重复尺度与边框；' + CARPET_VISUAL_LOCK }),
    Object.freeze({ id: 'carpet-woven-craft', name: '织艺原境', group: '地毯美学', tags: ['地毯', '平织地毯', '编织地毯', '天然材质地毯', '工艺地毯', '家居地毯'], fit: ['地毯', '平织地毯', '编织地毯', '手织地毯', '手工地毯', '手结地毯', '基里姆地毯', '达里地毯', '黄麻地毯', '剑麻地毯', '棉麻地毯', '羊毛地毯', '流苏地毯'], visual: '浅木、亚麻、陶土与安静工作室尺度，使用自然窗光、经纬般的远景投影和边缘微距突出输入原有织法、厚度、包边与流苏，未经输入确认不得宣称手工、手结、产地或天然纤维；' + CARPET_VISUAL_LOCK }),
    Object.freeze({ id: 'carpet-sculptural-pile', name: '绒丘浮雕', group: '地毯美学', tags: ['地毯', '高低绒地毯', '雕花地毯', '长绒地毯', '簇绒地毯', '肌理地毯'], fit: ['地毯', '长绒地毯', '高绒地毯', '厚绒地毯', '高低绒地毯', '雕花地毯', '割绒地毯', '圈绒地毯', '割圈地毯', '簇绒地毯', '立体地毯', '肌理地毯', '羊羔绒地毯', '雪尼尔地毯', '卧室地毯', '床边毯'], visual: '连续曲面展墙、雾面台阶与低角度掠光形成雕塑式材质展场，通过贴地微距和中景证明输入已有长短绒、高低绒、割圈或雕花边界，平织或短绒不得增厚，任何商品都不得新增浮雕、沟槽、圈绒、渐变或厚度；' + CARPET_VISUAL_LOCK }),
    Object.freeze({ id: 'carpet-color-statement', name: '色彩宣言', group: '地毯美学', tags: ['地毯', '彩色地毯', '撞色地毯', '儿童地毯', '现代地毯', '潮流家居'], fit: ['地毯', '彩色地毯', '多彩地毯', '撞色地毯', '高饱和地毯', '彩虹地毯', '儿童房地毯', '童趣地毯', '红色地毯', '蓝色地毯', '绿色地毯', '橙色地毯', '粉色地毯', '黄色地毯', '潮流地毯'], visual: '从输入地毯现有色号抽取背景墙、远景家具和单一道具色，配合清楚负空间、俯拍或正交构图和明快硬光形成色彩宣言，不得新增颜色、扩大色块、重排撞色关系或改动图案占比；' + CARPET_VISUAL_LOCK }),
    Object.freeze({ id: 'carpet-modular-grid', name: '模块秩序', group: '地毯美学', tags: ['地毯', '方块地毯', '地毯砖', '满铺地毯', '商用地毯', '办公地毯', '酒店地毯'], fit: ['地毯', '方块地毯', '地毯砖', '模块地毯', '模块化地毯', '拼块地毯', '地毯方块', '满铺地毯', '卷材地毯', '商用地毯', '办公地毯', '写字楼地毯', '酒店地毯', '走廊地毯', '学校地毯', '会议室地毯', '拼接地毯'], visual: '现代办公、酒店或公共空间的清晰路径、功能分区和前中后景，使用俯斜广角、线性灯带与克制家具表达模块尺度，只能跟随输入已有拼接、铺向和覆盖范围，单片、色样、卷材或局部地毯不得扩铺成完整空间；' + CARPET_VISUAL_LOCK }),
    Object.freeze({ id: 'home-quiet-order', name: '静序日常', group: '日用美学', tags: ['居家日用品', '家居日用品', '衣架', '收纳用品', '晾晒用品', '清洁用品'], fit: ['居家日用品', '家居日用品', '日用品', '生活用品', '衣架', '木衣架', '塑料衣架', '金属衣架', '植绒衣架', '防滑衣架', '裤架', '裙架', '夹裤架', '晾衣架', '晾晒架', '挂钩', '置物架', '收纳用品'], visual: '暖白墙面、浅木或素色台面、细线收纳网格、真实居家尺度与柔和窗光，以克制留白呈现输入原有轮廓和使用关系；衣架的挂钩、肩线、横杆和夹口必须按输入保留，单个衣架不得复制成列，衣物不得遮挡关键结构；' + HOME_DAILY_VISUAL_LOCK }),
    Object.freeze({ id: 'home-compact-function', name: '小居机能', group: '日用美学', tags: ['居家日用品', '家居日用品', '小户型', '收纳用品', '垃圾桶', '衣架'], fit: ['居家日用品', '家居日用品', '日用品', '生活用品', '小户型用品', '小户型收纳', '窄缝垃圾桶', '壁挂垃圾桶', '分类垃圾桶', '桌面垃圾桶', '迷你垃圾桶', '折叠衣架', '多功能衣架', '墙面收纳', '门后收纳', '夹缝收纳', '厨房收纳', '浴室收纳'], visual: '窄幅玄关、洗衣角或卫浴壁龛，使用纵向收纳线、清晰动线、正交机位和真实伸手尺度表达紧凑效率；只呈现输入本来已有的折叠、挂接、分仓、壁挂或伸缩结构，未安装商品不得上墙，普通商品不得补造新机构或多功能形态；' + HOME_DAILY_VISUAL_LOCK }),
    Object.freeze({ id: 'home-precision-clean', name: '精工洁境', group: '日用美学', tags: ['居家日用品', '家居日用品', '垃圾桶', '马桶刷', '清洁工具', '卫浴用品'], fit: ['居家日用品', '家居日用品', '日用品', '生活用品', '垃圾桶', '脚踏垃圾桶', '按压垃圾桶', '感应垃圾桶', '分类垃圾桶', '厨房垃圾桶', '卫生间垃圾桶', '浴室垃圾桶', '不锈钢垃圾桶', '金属垃圾桶', '马桶刷', '厕所刷', '洁厕刷', '清洁工具', '卫浴套件'], visual: '干净石材、微水泥和玻璃背景，精准侧轮廓光、低机位英雄构图及克制反射，形成日用器物的精确感；不得新增、删除或改造垃圾桶的盖体、开口、踏板、感应区、提手、内桶与分仓，也不得改变马桶刷的刷头、刷杆、底座及露出状态；' + HOME_DAILY_VISUAL_LOCK }),
    Object.freeze({ id: 'home-soft-bath', name: '柔感浴场', group: '日用美学', tags: ['居家日用品', '家居日用品', '浴室垫', '卫浴用品', '浴室纺织', '浴帘'], fit: ['居家日用品', '家居日用品', '日用品', '生活用品', '浴室', '卫生间用品', '浴室垫', '浴室地垫', '卫浴垫', '淋浴垫', '浴缸垫', '脚垫', '毛圈地垫', '硅藻泥垫', '浴帘', '浴室收纳', '浴室垃圾桶', '马桶刷'], visual: '灰米矿物墙、雾面玻璃、低矮木凳与柔雾晨光建立安静居家浴场，全部表面保持干爽，道具不得覆盖商品；浴室垫不得改变垫面纹理、绒高、软硬、背衬、边缘、厚度和尺寸，卫浴用品不得新增水滴、泡沫、污渍或清洁演示，也不得暗示吸水、防滑或速干性能；' + HOME_DAILY_VISUAL_LOCK }),
    Object.freeze({ id: 'home-sheer-daylight', name: '晨雾窗光', group: '日用美学', tags: ['居家日用品', '家居日用品', '窗纱', '纱帘', '纱窗', '窗饰'], fit: ['居家日用品', '家居日用品', '日用品', '生活用品', '窗纱', '纱帘', '白纱', '透光窗帘', '蕾丝纱帘', '雪纺纱帘', '遮像纱帘', '柔纱帘', '纱窗', '隐形纱窗', '金刚网纱窗'], visual: '以输入实际透光状态为准的侧逆光、克制窗框、柔和室内外层次和大面积留白，柔光只来自空间，不得改变商品透光度；只顺应输入原有垂坠、框体、网面、开合状态与安装件，薄纱不得变厚，纱窗不得变纱帘，折叠、卷装、样片或包装不得安装展开；' + HOME_DAILY_VISUAL_LOCK }),
    Object.freeze({ id: 'home-architectural-drape', name: '建筑垂幕', group: '日用美学', tags: ['居家日用品', '家居日用品', '窗帘', '落地窗帘', '布艺窗帘', '窗饰'], fit: ['居家日用品', '家居日用品', '日用品', '生活用品', '窗帘', '遮光窗帘', '布艺窗帘', '落地窗帘', '厚窗帘', '绒布窗帘', '提花窗帘', '酒店窗帘', '双层窗帘', '打孔帘', '挂钩帘', '轨道帘', '罗马帘', '卷帘'], visual: '整洁窗洞、低饱和建筑面和纵向构图，以侧光呈现输入本来存在的垂坠或平整帘面；布帘、罗马帘和卷帘不得互换，不得替换轨道、帘杆、孔环、挂钩、褶型、开合方式、幅数、长度、花型或透光度，未安装、折叠、卷起、样片或包装输入不得铺成完整窗面；' + HOME_DAILY_VISUAL_LOCK }),
    Object.freeze({ id: 'home-woven-table', name: '织面桌景', group: '日用美学', tags: ['居家日用品', '家居日用品', '桌垫', '餐垫', '杯垫', '桌旗'], fit: ['居家日用品', '家居日用品', '日用品', '生活用品', '桌垫', '餐垫', '杯垫', '餐桌垫', '西餐垫', '桌旗', '桌布', 'PVC桌垫', '皮革桌垫', '硅胶桌垫', '编织餐垫', '办公桌垫', '键盘垫', '鼠标垫'], visual: '俯拍或四十五度桌面、少量陶瓷与玻璃远景道具、贴面掠光和边缘微距，以清晰留白呈现输入原有编织、印花、表面与尺寸；不得复制铺满桌面、把桌垫改成桌旗或桌布、把桌垫与地垫互换，也不得改变套装数量、形状、边缘、厚度或背衬；' + HOME_DAILY_VISUAL_LOCK }),
    Object.freeze({ id: 'home-entry-graphic', name: '入户图景', group: '日用美学', tags: ['居家日用品', '家居日用品', '入户垫', '门垫', '玄关垫', '玄关用品'], fit: ['居家日用品', '家居日用品', '日用品', '生活用品', '入户垫', '入户地垫', '门垫', '玄关垫', '刮泥垫', '除尘垫', '户外门垫', '防滑门垫', '厨房地垫', '走廊垫', '欢迎垫', '玄关收纳', '挂衣架', '衣帽架', '伞架', '鞋架'], visual: '真实门槛、石材或木质玄关、斜向日光和俯斜机位，鞋具或伞只在远景提供尺度且不遮挡商品；不得添加水渍污泥、脚印、欢迎语或新图案，不得改变形状、厚度、边缘、背衬、用途与铺放范围，室内垫与户外垫不得互换，也不得暗示刮泥、防滑或户外耐候性能；' + HOME_DAILY_VISUAL_LOCK }),
    Object.freeze({ id: 'nutrition-ocean-blue', name: '海洋蓝白', group: '营养美学', tags: ['鱼油', '藻油', '磷虾油', 'DHA', 'Omega-3'], fit: ['鱼油', '深海鱼油', '藻油', '磷虾油', '鱼肝油', 'DHA', 'EPA', 'omega', 'fish oil', 'algae oil'], visual: '海洋蓝、藏蓝与纯白背景，远景抽象水纹、水平留白、透明台面边缘和清透侧光；主体保持干燥清晰，水纹仅在背景，不浸泡商品、不画鱼群或海产原料；' + NUTRITION_VISUAL_LOCK }),
    Object.freeze({ id: 'nutrition-amber-optics', name: '琥珀光学', group: '营养美学', tags: ['鱼油', '维生素D', '维生素E', '辅酶Q10'], fit: ['鱼油', '藻油', '维生素d', '维生素e', '辅酶q10', '软胶囊', 'vitamin d', 'vitamin e', 'coq10', 'fish oil'], visual: '暖黄与奶油白背景、透明玻璃台座、斜向硬影和受控的琥珀色环境反光；以光线穿过独立台座形成层次，原瓶不得透明化、改为琥珀瓶或产生油滴与胶囊装饰；' + NUTRITION_VISUAL_LOCK }),
    Object.freeze({ id: 'nutrition-clinical-white', name: '纯白精研', group: '营养美学', tags: ['保健品', '膳食补充剂', '维生素', '矿物质'], fit: ['保健品', '营养补充剂', '膳食补充剂', '维生素', '复合维生素', '多维', '矿物质', 'supplement', 'multivitamin', 'vitamin', 'mineral'], visual: '纯白无缝展面、轻灰接触影、中性均匀柔光与完整主体构图，以大面积留白和清楚边缘表达理性专业；背景不放实验器械、医疗十字、实验数据或检测图表；' + NUTRITION_VISUAL_LOCK }),
    Object.freeze({ id: 'nutrition-precision-grid', name: '蓝白精序', group: '营养美学', tags: ['钙铁锌', '钙镁锌', 'B族维生素', '矿物营养'], fit: ['钙铁锌', '钙镁锌', '钙', '铁', '锌', '镁', 'b族', '维生素b', 'calcium', 'magnesium', 'zinc', 'iron', 'b complex'], visual: '冷白、雾蓝和浅灰背景分区、细线网格、正交构图与匀净布光，以低密度几何秩序衬托原包装；网格留在主体外，不重排标签、不生成参数表、检测报告或分子结构；' + NUTRITION_VISUAL_LOCK }),
    Object.freeze({ id: 'nutrition-heritage-gold', name: '典藏金韵', group: '营养美学', tags: ['复合维生素', '矿物质', '鱼油', '营养礼盒'], fit: ['复合维生素', '多维', '矿物质', '钙镁锌', '鱼油', '营养礼盒', 'multivitamin', 'calcium', 'magnesium', 'zinc'], visual: '香槟米白、深棕背景与少量哑金装饰线，居中展陈、细腻台面和克制轮廓光形成典雅传承感；哑金仅用于环境，不给原瓶换金盖、不新增金章、金箔标签、丝带或礼盒；' + NUTRITION_VISUAL_LOCK }),
    Object.freeze({ id: 'nutrition-botanical-green', name: '草本绿境', group: '营养美学', tags: ['植物营养', '草本补充剂', '益生菌', '膳食纤维'], fit: ['植物营养', '植物', '草本', '叶黄素', '益生菌', '膳食纤维', '蔓越莓', '奶蓟草', 'botanical', 'herbal', 'probiotic', 'fiber', 'lutein'], visual: '深浅植物绿、奶油白背景、远景抽象叶影与漫射日光，用自然留白建立草本生活氛围；仅用不可辨识品种的叶影，不新增水果、药材、菌群图或配方成分，不把绿色染到包装；' + NUTRITION_VISUAL_LOCK }),
    Object.freeze({ id: 'nutrition-mineral-form', name: '矿感几何', group: '营养美学', tags: ['钙片', '铁剂', '锌片', '镁', '维生素D'], fit: ['钙片', '钙', '铁剂', '补铁', '铁', '锌片', '锌', '镁', '维生素d', 'calcium', 'iron', 'zinc', 'magnesium', 'vitamin d'], visual: '浅灰石面、粉笔白几何台座、柔和掠光与疏朗体块，使用稳定构图表达沉静的材质秩序；石面只作承托环境，不描绘矿石原料、骨骼牙齿或吸收示意，不改变包装形态；' + NUTRITION_VISUAL_LOCK }),
    Object.freeze({ id: 'nutrition-daily-sunlight', name: '晨光日常', group: '营养美学', tags: ['维生素', '鱼油', '日常营养', '蛋白粉'], fit: ['维生素', '多维', '鱼油', '日常营养', '蛋白粉', '膳食补充剂', 'daily', 'vitamin', 'protein'], visual: '浅木桌面、米白墙、斜向窗光与少量远景日常器物，通过真实尺度和自然留白呈现晨间生活；不打开包装，不出现服用、冲泡、分装、餐食配方或手持药片动作；' + NUTRITION_VISUAL_LOCK }),
    Object.freeze({ id: 'nutrition-active-color', name: '活力色场', group: '营养美学', tags: ['复合维生素', '维生素C', '营养软糖', '运动营养'], fit: ['复合维生素', '维生素c', '多维', '营养软糖', '运动营养', 'b族', 'multivitamin', 'vitamin c', 'gummy', 'gummies'], visual: '钴蓝大色块、明黄和珊瑚点色、几何台面、清晰硬影与有节奏的非对称留白；明快色彩仅限环境，图形采用方形或平面块，不画糖果、胶囊、果蔬或功能爆发特效；' + NUTRITION_VISUAL_LOCK }),
    Object.freeze({ id: 'nutrition-soft-pastel', name: '轻柔粉彩', group: '营养美学', tags: ['营养软糖', '维生素D', '益生菌', '胶原营养'], fit: ['营养软糖', '维生素d', '益生菌', '胶原', '软糖', 'vitamin d', 'gummy', 'gummies', 'probiotic', 'collagen'], visual: '浅鹅黄、淡粉和薄荷色背景、圆角展面与轻柔投影，以轻盈留白和细黑轮廓形成友好现代的粉彩画面；圆角只用于背景，不给包装加卡通人物、软糖造型或年龄标签；' + NUTRITION_VISUAL_LOCK }),
    Object.freeze({ id: 'nutrition-warm-care', name: '暖调陪伴', group: '营养美学', tags: ['鱼油', '复合维生素', '钙D', '家庭营养'], fit: ['鱼油', '复合维生素', '钙d', '钙片', '家庭营养', '中老年', '营养补充剂', 'fish oil', 'multivitamin', 'calcium'], visual: '燕麦米色、暖木台面、远景柔焦和低对比逆光，以宽松留白呈现温暖从容的日常感；采用无人的静物环境，不凭空指定使用年龄、不增加家庭成员或服用场景、不补造套装；' + NUTRITION_VISUAL_LOCK }),
    Object.freeze({ id: 'nutrition-red-focus', name: '红白焦点', group: '营养美学', tags: ['保健品', '维生素C', '铁剂', '综合营养'], fit: ['保健品', '维生素c', '铁剂', '补铁', '铁', '综合营养', '营养补充剂', 'vitamin c', 'iron', 'supplement'], visual: '白色主背景、深灰辅助分区、少量红色直线或远景色块，清楚的主次层级和干净投影形成商业陈列；红色仅为环境焦点，不作降价贴、销量章、认证章、医疗十字或包装改色；' + NUTRITION_VISUAL_LOCK })
  ]);

  var DEFAULT_DIRECTIONS = Object.freeze([
    Object.freeze({ id: 'hero', name: '英雄主图', axis: '构图与空间', brief: '以商品为绝对主角建立第一眼识别，轮廓完整，留白清楚，适合作为电商首图或传播封面。' }),
    Object.freeze({ id: 'material', name: '材质特写', axis: '镜头与质感', brief: '用近景或局部放大证明材质、工艺、纹理和边缘细节，同时保留足够整体信息用于确认同款。' }),
    Object.freeze({ id: 'interaction', name: '自然互动', axis: '场景与动作', brief: '在合理使用场景中加入自然手部、身体局部或环境互动，表达尺度与使用关系，不喧宾夺主。' }),
    Object.freeze({ id: 'concept', name: '创意场景', axis: '概念与道具', brief: '使用符合所选风格的空间、道具或尺度创意形成传播记忆点，商品结构仍必须真实可辨。' }),
    Object.freeze({ id: 'angle', name: '角度新解', axis: '机位与透视', brief: '选择不同于常规正面的俯拍、低机位或侧向透视，保持产品比例和结构不变。' }),
    Object.freeze({ id: 'rhythm', name: '节奏构成', axis: '排列与节奏', brief: '用单商品多层空间关系或克制重复元素形成平面节奏，不复制出错误商品数量。' }),
    Object.freeze({ id: 'light', name: '光影实验', axis: '光线与色温', brief: '通过明确主光、轮廓光或投影结构塑造不同情绪，避免遮盖商品颜色与关键结构。' }),
    Object.freeze({ id: 'environment', name: '环境叙事', axis: '生活方式', brief: '把商品放进可信但具有审美完成度的环境，表达目标人群与生活方式。' }),
    Object.freeze({ id: 'depth', name: '纵深层次', axis: '前中后景', brief: '用前景引导、中景主体和克制远景建立空间纵深，主体完整清楚，前景不得遮挡关键结构。' }),
    Object.freeze({ id: 'symmetry', name: '对称秩序', axis: '轴线与平衡', brief: '以中心轴、镜像关系或均衡体块建立稳定秩序，不复制商品，也不虚构成套数量。' }),
    Object.freeze({ id: 'negative-space', name: '留白海报', axis: '负空间与版式', brief: '用大面积干净负空间形成海报式视觉焦点，商品识别区完整，并为所选文案模式预留合理位置。' }),
    Object.freeze({ id: 'color-echo', name: '色彩呼应', axis: '色彩与背景', brief: '从商品既有颜色提取环境呼应色，建立有层次的配色关系，不改商品本色、不新增图案。' }),
    Object.freeze({ id: 'low-angle', name: '低机位体量', axis: '机位与尺度', brief: '使用克制低机位突出主体体量与存在感，避免夸张透视造成比例、结构或功能误读。' }),
    Object.freeze({ id: 'top-view', name: '俯视关系', axis: '俯拍与布局', brief: '从俯视或高角度组织主体、道具与留白关系，保持原有数量、朝向和完整边界。' }),
    Object.freeze({ id: 'edge-detail', name: '边缘细节', axis: '局部与整体', brief: '聚焦边缘、连接、收口或表面转折，同时保留足够整体轮廓用于确认同一商品。' }),
    Object.freeze({ id: 'light-plane', name: '光影切面', axis: '投影与结构', brief: '让受控投影和明暗切面参与构图，增强空间层次，但不把阴影误画成商品纹样或部件。' }),
    Object.freeze({ id: 'human-scale', name: '真实尺度', axis: '比例与参照', brief: '用可信家具、手部或环境参照表达实际尺度，参照物保持克制，不暗示未经确认的功能。' }),
    Object.freeze({ id: 'still-life', name: '静物叙事', axis: '道具与关系', brief: '以少量相关道具建立完整静物关系，商品始终是唯一主角，道具不得冒充配件或套装内容。' }),
    Object.freeze({ id: 'tension', name: '动静对比', axis: '视觉张力', brief: '通过稳定主体与方向性光线、轻微环境动势形成张力，商品形态、位置关系和可见细节保持真实。' }),
    Object.freeze({ id: 'closing-cover', name: '收束封面', axis: '系列收口', brief: '以最清楚的主体识别、成熟留白和统一风格语言完成系列收口，适合作为末张总结或二次传播封面。' })
  ]);

  function text(value) { return String(value == null ? '' : value).trim(); }
  function clampOutputCount(value) {
    var n = parseInt(value, 10);
    return isFinite(n) ? Math.max(1, Math.min(20, n)) : 4;
  }
  function styleById(id) {
    id = text(id);
    return STYLES.filter(function (style) { return style.id === id; })[0] || STYLES[0];
  }
  function styleSummary(id) {
    var style = styleById(id);
    return STYLE_CARD_SUMMARIES[style.id] || style.visual;
  }
  function strengthById(id) { return STRENGTHS[text(id)] || STRENGTHS.commercial; }
  function normalizeStyleSource(value) { return text(value).toLowerCase() === 'custom' ? 'custom' : 'library'; }
  function normalizeCopyMode(value) {
    value = text(value).toLowerCase();
    if (value === 'generate') return 'generate';
    if (value === 'rewrite' || value === 'retain') return 'rewrite';
    return 'none';
  }

  function copyStyleProfile(styleId) {
    var style = styleById(styleId);
    var profiles = {
      'gallery-white': ['克制、高级、策展式短句', '现代无衬线或高对比衬线感', '大留白、疏字距、左下或边缘对齐'],
      'architectural-pedestal': ['理性、结构化、精确有力', '几何无衬线粗体', '沿建筑切面网格对齐'],
      'tactile-fabric': ['柔和、感官化、贴近材质', '轻盈人文无衬线或柔和衬线感', '小尺度、呼吸留白、避免压住纹理'],
      'obsidian-luxury': ['极简、稀缺感、奢品语气', '高对比衬线或精细窄体', '少字、宽字距、暗部边缘排布'],
      'hard-flash-editorial': ['直接、时髦、杂志标题感', '粗体窄字或编辑体', '大胆裁切、错位层级、避免遮挡商品'],
      'film-street': ['松弛、真实、生活方式口吻', '自然手写感或简洁杂志体', '像街拍注释般克制排布'],
      'kinetic-freeze': ['短促、动势强、能量感', '倾斜粗体或运动无衬线', '顺应运动轨迹、强节奏层级'],
      'surreal-scale': ['概念化、带反差、记忆点优先', '超大展示字或实验排版', '利用尺度反差形成标题空间'],
      'color-block': ['清晰、图形化、品牌识别强', '几何粗体无衬线', '与色块网格一体化排版'],
      'liquid-metal': ['未来、冷静、科技奢感', '细窄科技无衬线', '沿反射与光晕边缘克制排布'],
      'local-craft': ['真诚、温暖、有手作温度', '人文衬线或自然手写感', '贴近材料与工作台关系排布'],
      'natural-sunlight': ['自然、可信、轻生活叙事', '友好现代无衬线', '顺应窗光与空间留白排布'],
      'wabi-sabi': ['淡雅、克制、有时间感', '人文衬线或细宋体气质', '不对称大留白，避开天然肌理与商品轮廓'],
      'mid-century-vintage': ['摩登、复古、强调质感', '粗衬线或几何无衬线', '沿中古家具与几何网格建立秩序'],
      'cream-soft': ['温柔、治愈、轻松亲近', '圆润现代无衬线', '小尺度短句，放入柔软曲线形成的留白区'],
      'ins-minimal': ['轻盈、简洁、社媒友好', '干净现代无衬线', '清晰网格与自然留白，像生活方式刊物标题'],
      'french-vintage': ['浪漫、精致、带经典韵味', '高对比衬线或优雅窄体', '对称留白或边缘式杂志排版'],
      'new-chinese': ['含蓄、凝练、当代东方', '现代宋体或宋黑结合', '沿轴线与山水式留白克制排布'],
      'dopamine-color': ['乐观、直接、年轻有力', '几何粗体无衬线', '与撞色色块形成强节奏，保持商品识别区干净'],
      'american-retro': ['自由、怀旧、带旧广告感', '粗衬线或复古展示体', '使用旧海报层级与边缘注释式排版'],
      'korean-clean': ['清透、克制、精致轻巧', '细字重现代无衬线', '轻层级、短行距与高明度留白'],
      'wood-healing': ['温暖、真诚、自然松弛', '人文无衬线或柔和衬线', '顺应窗光与原木空间自然留白'],
      'y3k-future': ['冷静、未来、数字时尚感', '窄体科技无衬线', '沿透明层与霓虹边光建立悬浮层级'],
      'scrapbook-collage': ['亲近、手作、带个性表达', '手写感与粗体展示字组合', '不规则拼贴但保留完整商品识别区'],
      'jewelry-organic-sculpture': ['安静、现代、带触觉雕塑感', '细字重现代无衬线或克制高对比衬线', '沿连续曲面建立非对称留白，避开商品轮廓与高光'],
      'jewelry-art-deco': ['摩登、精准、带都会仪式感', '几何无衬线与高对比衬线组合', '沿中轴、阶梯与放射网格对齐，保持宝石识别区纯净'],
      'jewelry-urban-link': ['利落、自信、都市力量感', '窄体粗字或建筑感无衬线', '顺应链节节奏和斜向裁切建立层级，不复制或遮挡商品'],
      'jewelry-metal-lace': ['精致、传承、强调手工温度', '优雅衬线或细宋体气质', '小尺度排版配合镂空投影，给工艺微距保留充分呼吸区'],
      'jewelry-gem-spectrum': ['明快、丰盈、色彩秩序清晰', '几何无衬线或简洁展示体', '从商品现有宝石取色建立色块网格，文字落在中性留白区'],
      'jewelry-pearl-tide': ['柔润、从容、轻盈而经典', '圆润现代无衬线或纤细衬线', '短句沿水波与贝壳曲线排布，不压住珍珠层次高光'],
      'jewelry-secret-garden': ['诗意、灵动、含蓄自然', '轻盈人文衬线或现代宋体', '利用叶影和远景花瓣形成非对称留白，花草不侵入商品结构'],
      'jewelry-oriental-craft': ['凝练、温润、当代东方', '现代宋体与简洁黑体组合', '以轴线和宣纸式留白克制排布，不使用传统图腾作文字装饰'],
      'floor-nordic-light': ['清澈、克制、强调自然尺度', '细字重现代无衬线', '顺输入已有板向与墙面留白排布，不压住木纹和拼缝'],
      'floor-twilight-timber': ['沉静、私邸感、突出深木层次', '精细窄体或克制高对比衬线', '文字落在暖色墙面留白，不抬亮暗部或覆盖地板反光'],
      'floor-geometric-parquet': ['经典、精准、强调铺装秩序', '高对比衬线与几何无衬线组合', '只沿输入原有拼花轴线对齐，不跨越接缝制造新图案'],
      'floor-architectural-mineral': ['理性、纯粹、具有建筑材料感', '建筑感无衬线或窄体字', '利用立面和采光缝留白，避免压住石纹、颗粒和倒角'],
      'floor-urban-workshop': ['硬朗、都会、带工程完成度', '窄体粗字或几何无衬线', '沿窗框与建筑网格建立层级，地板表面保持完整可辨'],
      'floor-hospitality-luxe': ['从容、精致、带克制款待感', '优雅衬线或现代窄体', '在墙面与软装留白中做低密度排版，不给地面新增徽章或边框'],
      'floor-biophilic-flow': ['舒展、平静、强调自然连接感', '友好人文无衬线', '顺自然采光排布，文字与植物均避开地板纹理和可见边界'],
      'floor-organic-colorfield': ['柔和、包容、具有当代公共空间感', '圆润几何无衬线', '跟随输入已有模块网格留白，不用文字或色块重新划分地面'],
      'carpet-tonal-luxe': ['安静、精致、强调材质层次与私邸尺度', '细字重现代无衬线或克制高对比衬线', '文字落在墙面大留白，不压住地毯轮廓、绒向与原有图案'],
      'carpet-abstract-gallery': ['策展式、艺术化、保留商业清晰度', '现代展示体或纤细高对比衬线', '利用艺廊负空间建立不对称层级，不跨入地毯图案或模仿作品签名'],
      'carpet-classic-heritage': ['沉稳、典藏、具有现代传承感', '优雅衬线或现代宋体气质', '沿空间中轴与墙面线脚排布，不用文字补画边框、中心章或传统纹样'],
      'carpet-modern-geometry': ['摩登、精准、图形秩序清晰', '几何无衬线或窄体展示字', '只顺应输入已有格网与重复节奏，文字不得制造新的几何关系'],
      'carpet-woven-craft': ['真诚、克制、强调织造触感', '人文无衬线或轻盈衬线', '小尺度文字落在自然材料留白区，为经纬、包边与流苏特写让位'],
      'carpet-sculptural-pile': ['立体、触觉、强调真实绒面层次', '精细窄体或几何无衬线', '文字落在曲面展墙留白，不跨入绒面高光、雕花边界或地毯轮廓'],
      'carpet-color-statement': ['明快、自信、强调既有色彩关系', '几何粗体无衬线', '从输入已有色号建立清楚层级，文字落在中性负空间且不扩大色块'],
      'carpet-modular-grid': ['理性、清晰、具有当代商用完成度', '建筑感无衬线或窄体字', '沿输入已有接缝与空间路径对齐，不用文字、色带或标记重新分区'],
      'home-quiet-order': ['安静、克制、强调日常秩序', '细字重人文无衬线', '沿收纳网格和自然留白排布，不遮挡商品轮廓与关键结构'],
      'home-compact-function': ['清晰、利落、突出紧凑效率', '窄体或几何无衬线', '沿纵向收纳线建立短层级，不用文字虚构额外功能分区'],
      'home-precision-clean': ['精准、自信、带专业器物感', '精细窄体或理性无衬线', '文字落在石材或玻璃负空间，避开盖体、踏板、刷头与连接件'],
      'home-soft-bath': ['柔和、洁净、具有安静仪式感', '圆润现代无衬线或纤细衬线', '利用雾面墙与柔光留白，不跨入垫面纹理或卫浴用品轮廓'],
      'home-sheer-daylight': ['轻盈、通透、强调真实光感', '纤细人文无衬线或轻盈衬线', '沿窗洞边缘和透光留白排布，不压住网面、褶型与安装关系'],
      'home-architectural-drape': ['从容、建筑化、强调纵向尺度', '高挑窄体无衬线或克制高对比衬线', '顺输入原有落幅与窗洞轴线排布，不跨越帘面花型、褶型和开合边界'],
      'home-woven-table': ['细腻、触觉化、保持桌面清晰', '人文无衬线或简洁展示体', '沿俯拍桌面网格做小尺度排版，为编织、印花、边缘和套装关系让位'],
      'home-entry-graphic': ['友好、现代、具有到家仪式感', '几何无衬线或清晰人文无衬线', '沿门槛与动线建立方向层级，文字不得变成垫面图案或欢迎语'],
      'nutrition-ocean-blue': ['清爽、从容、表达清晰', '现代无衬线配合轻盈衬线', '沿水平留白排布短标题，避开瓶身与标签'],
      'nutrition-amber-optics': ['明亮、简洁、精致有序', '几何无衬线与克制衬线', '文字置于光影外的平整留白，保留透光台座层次'],
      'nutrition-clinical-white': ['克制、客观、简洁可信', '清晰现代无衬线', '大留白与稳定左对齐，短层级只使用已确认商品事实'],
      'nutrition-precision-grid': ['理性、清楚、信息主次分明', '方正现代无衬线', '沿主体外的细线网格对齐，不把版式写入标签'],
      'nutrition-heritage-gold': ['典雅、沉稳、从容克制', '高对比衬线与清晰无衬线', '沿中轴建立疏朗层级，不使用徽章或封印式文字'],
      'nutrition-botanical-green': ['自然、平静、亲近生活', '人文无衬线或轻盈衬线', '短句落在奶白留白区，避开叶影与产品识别区'],
      'nutrition-mineral-form': ['沉静、简洁、结构清楚', '理性无衬线与精细窄体', '文字沿几何体外的负空间排布，避免压住台座边缘与商品'],
      'nutrition-daily-sunlight': ['自然、轻松、贴近日常', '友好人文无衬线与柔和衬线', '顺窗光预留短标题空间，不给环境器物加商品说明'],
      'nutrition-active-color': ['明快、直接、年轻有节奏', '几何粗体无衬线', '标题与背景色块建立节奏，完整保留产品轮廓与标签'],
      'nutrition-soft-pastel': ['友好、轻盈、温和简洁', '圆润现代无衬线', '小尺度短句落在浅色留白区，不用气泡标签贴到瓶身'],
      'nutrition-warm-care': ['温暖、从容、朴素清楚', '柔和衬线与人文无衬线', '在宽松留白中呈现少量文字，避免家庭或年龄功效暗示'],
      'nutrition-red-focus': ['鲜明、简洁、商业识别清楚', '清晰粗体无衬线', '文字与红色环境焦点相邻但不作促销徽章，不添加未知价格']
    };
    var profile = profiles[style.id] || ['简洁、可信、商业清晰', '现代无衬线', '不遮挡商品的稳定留白区'];
    return Object.freeze({ tone: profile[0], typography: profile[1], layout: profile[2] });
  }

  function copyStrategy(input) {
    input = input || {};
    var mode = normalizeCopyMode(input.copyMode);
    var strength = strengthById(input.strength);
    var custom = normalizeStyleSource(input.styleSource) === 'custom';
    var customName = text(input.customStyleName) || '自由共创风格';
    var profile = custom
      ? Object.freeze({
        tone: '贴合' + customName + '视觉描述的原创语气',
        typography: '根据用户自定义视觉描述推导字体气质，保持清晰可读',
        layout: '根据用户自定义构图与留白要求排布，不遮挡商品主体'
      })
      : copyStyleProfile(input.styleId);
    var strengthRule = strength.id === 'stable'
      ? '一句短标题为主，建议4-10个汉字，画面占比约8%-12%，不使用夸张口号。'
      : (strength.id === 'breakthrough'
        ? '允许强标题与一条短副标题，画面占比约18%-28%，表达可更具反差与记忆点，但必须易读且不遮挡商品。'
        : '一条核心标题，可选一条短副标题，画面占比约12%-20%，突出单一利益点并保持商业清晰。');
    return Object.freeze({
      mode: mode,
      modeName: COPY_MODES[mode].name,
      tone: profile.tone,
      typography: profile.typography,
      layout: profile.layout,
      densityRule: strengthRule,
      source: text(input.copySource),
      instruction: text(input.copyInstruction)
    });
  }

  function recommendStyles(category, material, limit) {
    var haystack = (text(category) + ' ' + text(material)).toLowerCase().trim();
    limit = Math.max(1, Math.min(6, parseInt(limit, 10) || 3));
    return STYLES.map(function (style, index) {
      var score = 0;
      style.fit.forEach(function (token) { if (haystack.indexOf(String(token).toLowerCase()) >= 0) score += 8; });
      style.tags.forEach(function (token) { if (haystack.indexOf(String(token).toLowerCase()) >= 0) score += 4; });
      if (!haystack) score = style.popular ? 3 : (index === 0 ? 2 : (index === 11 ? 1 : 0));
      return { style: style, score: score, index: index };
    }).sort(function (a, b) { return b.score - a.score || a.index - b.index; }).slice(0, limit).map(function (entry, rank) {
      var reason = !haystack && entry.style.popular
        ? '热门通用起点'
        : (entry.score > 0
          ? (entry.style.popular ? '热门风格 · 与当前品类/材质匹配' : '与当前品类/材质匹配')
          : '通用商业安全起点');
      return Object.freeze({ id: entry.style.id, name: entry.style.name, group: entry.style.group, popular: !!entry.style.popular, visual: entry.style.visual, rank: rank + 1, reason: reason });
    });
  }

  function directionSpecs(count, productName) {
    count = clampOutputCount(count);
    productName = text(productName) || '目标商品';
    return Array.apply(null, Array(count)).map(function (_, index) {
      var base = DEFAULT_DIRECTIONS[index] || DEFAULT_DIRECTIONS[index % DEFAULT_DIRECTIONS.length];
      return Object.freeze({
        index: index + 1,
        id: base.id,
        name: base.name,
        axis: base.axis,
        brief: productName + '：' + base.brief
      });
    });
  }

  function createConfig(input) {
    input = input || {};
    var styleSource = normalizeStyleSource(input.styleSource);
    var libraryStyle = styleById(input.styleId);
    var customName = text(input.customStyleName) || '自由共创风格';
    var customVisual = text(input.customStyleVisual);
    var customAvoid = text(input.customStyleAvoid);
    var style = styleSource === 'custom'
      ? { id: 'custom-user', name: customName, group: 'V3 自由共创', visual: customVisual || '等待用户填写自定义视觉描述' }
      : libraryStyle;
    var strength = strengthById(input.strength);
    var copy = copyStrategy(input);
    var outputCount = clampOutputCount(input.outputCount == null ? input.screenCount : input.outputCount);
    return Object.freeze({
      version: VERSION,
      routeId: 'style-refresh',
      routeName: '风格焕新',
      styleSource: styleSource,
      styleSourceName: styleSource === 'custom' ? 'V3 自由共创' : '经典风格库',
      styleId: style.id,
      styleName: style.name,
      styleGroup: style.group,
      styleVisual: style.visual,
      customStyleName: styleSource === 'custom' ? customName : '',
      customStyleVisual: styleSource === 'custom' ? customVisual : '',
      customStyleAvoid: styleSource === 'custom' ? customAvoid : '',
      strength: strength.id,
      strengthName: strength.name,
      redesignTarget: strength.redesignTarget,
      copyMode: copy.mode,
      copyModeName: copy.modeName,
      copySource: copy.source,
      copyInstruction: copy.instruction,
      copyTone: copy.tone,
      copyTypography: copy.typography,
      copyLayout: copy.layout,
      copyDensityRule: copy.densityRule,
      outputCount: outputCount,
      category: text(input.category),
      material: text(input.material),
      productConsistencyMode: 'strict_same_sku',
      productIdentityPriority: 100,
      qaGate: Object.freeze({ identityMin: 86, styleMin: 75, copyMin: 75, copyViolationMax: 0 })
    });
  }

  function promptRules(input) {
    var cfg = createConfig(input);
    var copyRule = cfg.copyMode === 'none'
      ? '用户选择不要文案：画面必须完全无营销文案，禁止新增标题、副标题、价格、参数、字母、数字、水印和伪文字；商品本身真实存在的品牌标识与包装文字必须保持原样，不得新增或改写。'
      : (cfg.copyMode === 'rewrite'
        ? '用户选择修改已有文案：原文案为“' + (cfg.copySource || '未填写') + '”；修改要求为“' + (cfg.copyInstruction || '在事实不变的前提下优化表达') + '”。必须明确替换原文案，不得同时保留新旧两版，不得臆造参数、功效、价格或品牌。'
        : '用户选择生成新文案：依据当前商品事实与“' + (cfg.copySource || '未指定必含卖点') + '”生成新文案；附加要求为“' + (cfg.copyInstruction || '无') + '”。不得臆造参数、功效、价格、销量、认证或品牌。');
    return [
      'STYLE REFRESH CONTRACT ' + VERSION + '：当前路线为“风格焕新”，不得读取或混入“案例裂变”的图1参考、分析结果或提示词。',
      '商品身份最高优先级：上传的商品主体图是唯一事实来源。100%保持同一SKU的结构、比例、颜色、材质、部件、图案、包装、数量和可见细节；任何风格创意都不得改款。',
      '所选风格：' + cfg.styleName + ' / ' + cfg.styleGroup + '。视觉定义：' + cfg.styleVisual + '。',
      cfg.styleSource === 'custom' ? 'V3备选来源：这是用户直接填写的自由共创方案，不是案例裂变参考，也不得读取案例图、案例分析或案例提示词。避让要求：' + (cfg.customStyleAvoid || '无额外要求；继续遵守商品保真与商业真实性边界。') : '',
      '创意强度：' + cfg.strengthName + '，目标重设计强度约 ' + cfg.redesignTarget + '%。' + strengthById(cfg.strength).rule,
      copyRule,
      cfg.copyMode === 'none' ? '' : '文案视觉方式必须同时参考风格与强度：语气=' + cfg.copyTone + '；字体气质=' + cfg.copyTypography + '；排版=' + cfg.copyLayout + '；密度与冲击力=' + cfg.copyDensityRule,
      '每次请求只生成一张独立完整图片，禁止九宫格、拼图、对比合集、分镜编号和多图合成。整组共享同一风格语言，但每张在构图、镜头、场景、互动、道具或光影中至少三项不同。',
      '不得凭空增加商品数量，不得用参考风格中的旧商品替换目标商品，不得夸大材质、功能或使用效果。'
    ].filter(Boolean).join('\n');
  }

  function createPlan(input) {
    var cfg = createConfig(input);
    var productName = text(input && input.productName) || '目标商品';
    var directions = directionSpecs(cfg.outputCount, productName);
    return Object.freeze({
      config: cfg,
      screens: Object.freeze(directions.map(function (direction) {
        return Object.freeze({
          屏幕: direction.index,
          名称: direction.name,
          焕新方向: direction.axis,
          视觉风格: cfg.styleName + '：' + cfg.styleVisual,
          创意强度: cfg.strengthName,
          画面任务: direction.brief,
          文案规则: cfg.copyMode === 'none'
            ? '不要文案；不新增营销文字，商品原有标识保持真实'
            : (cfg.copyMode === 'rewrite'
              ? '修改已有文案“' + (cfg.copySource || '未填写') + '”；' + (cfg.copyInstruction || '按当前风格与强度优化表达')
              : '生成新文案；必含信息=' + (cfg.copySource || '仅使用已确认商品事实') + '；' + (cfg.copyInstruction || '按当前风格与强度生成')),
          文案风格: cfg.copyMode === 'none' ? '不适用' : cfg.copyTone + '；' + cfg.copyTypography,
          文案排版: cfg.copyMode === 'none' ? '不适用' : cfg.copyLayout + '；' + cfg.copyDensityRule,
          商品保真: '严格锁定上传主体图中的同一SKU；结构、比例、颜色、材质、部件、图案、包装、数量全部不变',
          质检门槛: cfg.copyMode === 'none' ? '商品保真≥86；风格命中≥75；新增营销文字违规必须为0' : '商品保真≥86；风格命中≥75；文案达成≥75'
        });
      }))
    });
  }

  function qaStatus(input) {
    input = input || {};
    var identity = Number(input.identityScore) || 0;
    var style = Number(input.styleScore) || 0;
    var copyViolation = Math.max(0, Number(input.copyViolationCount) || 0);
    var mode = normalizeCopyMode(input.copyMode);
    var copyScore = Number(input.copyScore);
    if (!isFinite(copyScore)) copyScore = mode === 'none' && copyViolation === 0 ? 100 : 0;
    if (identity < 70 || (mode === 'none' && copyViolation > 0) || (mode !== 'none' && copyScore < 50)) return 'failed';
    if (identity >= 86 && style >= 75 && (mode === 'none' ? copyViolation === 0 : copyScore >= 75)) return 'passed';
    return 'review';
  }

  return Object.freeze({
    version: VERSION,
    config: Object.freeze({ defaultOutputCount: 4, minOutputCount: 1, maxOutputCount: 20, defaultStyleSource: 'library', defaultStyleId: 'gallery-white', defaultStrength: 'commercial', defaultCopyMode: 'none' }),
    styles: STYLES,
    strengths: STRENGTHS,
    copyModes: COPY_MODES,
    styleById: styleById,
    styleSummary: styleSummary,
    strengthById: strengthById,
    normalizeStyleSource: normalizeStyleSource,
    clampOutputCount: clampOutputCount,
    normalizeCopyMode: normalizeCopyMode,
    copyStyleProfile: copyStyleProfile,
    copyStrategy: copyStrategy,
    recommendStyles: recommendStyles,
    directionSpecs: directionSpecs,
    createConfig: createConfig,
    createPlan: createPlan,
    promptRules: promptRules,
    qaStatus: qaStatus
  });
});
