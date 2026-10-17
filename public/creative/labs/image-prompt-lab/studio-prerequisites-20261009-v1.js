
;
/* Frozen source: public/creative/src/local-import.js */
/*
 * local-import.js — 本地词表 / 市场排行表 / 自定义链接清单读取与字段归一。
 * 依赖页面先加载本地 vendor/xlsx.full.min.js；文件只在浏览器内解析。
 */
(function (root, factory) {
  'use strict';
  var api = factory(root || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LOCALTABLES = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var MAX_FILE_BYTES = 30 * 1024 * 1024;
  var MAX_VALID_ROWS = 50000;
  var MAX_SHEET_COUNT = 64;
  var MAX_DECLARED_CELLS = 2000000;
  var MAX_MATRIX_CELLS = 1500000;
  var MAX_HEADER_SCAN_ROWS = 50;
  var MAX_READ_ROWS = MAX_VALID_ROWS + MAX_HEADER_SCAN_ROWS + 2;
  var MAX_ZIP_ENTRIES = 2048;
  var MAX_ZIP_ENTRY_BYTES = 80 * 1024 * 1024;
  var MAX_ZIP_TOTAL_BYTES = 128 * 1024 * 1024;
  var DEMAND_ORDER = ['品类', '属性', '人群', '功能', '场景', '风格', '品牌', '定制'];
  // 前 12 列沿用生意参谋市场排行协议；淘宝搜索 Top300 的字段只作为可选扩展追加，
  // 避免改变旧表的字段顺序或把新字段升级成必填项。
  var MARKET_FIELDS = [
    '排名', '排名环比', '商品名称', '商品ID', '商品图片URL', '商品链接', '店铺名称', '店铺链接',
    '店铺图片URL', '访客数(区间)', '支付买家数(区间)', '商品关键词',
    '搜索关键词', '收货人数', '收货人数值', '店铺类型', '入口价格', '入口价格值', '数据来源'
  ];
  var LINK_FIELDS = [
    '链接编号', '生成方式', '链接分组', '链接定位', '主推关键词', '用户场景需求', '来源关键词',
    '竞品未覆盖词根', '差异化定位逻辑', '标题结构', '标题定位词路', '商品标题', '标题冲突处理',
    '主图核心文案', '详情页定位', '详情页文案', '详情文案逻辑', '优先级分数', '优先级', '数据状态'
  ];

  var WORD_ALIASES = {
    keyword: ['关键词', '搜索词', '相关搜索词', '相关词', '衍生词', '词', '关键词名称', 'keyword', 'word', 'query', 'searchword'],
    popularity: ['搜索人气', '人气', '搜索指数', '搜索热度', '搜索量', '展现量', 'searchindex', 'searchpopularity', 'popularity', 'pop'],
    sources: ['榜单来源', '来源榜单', '词表来源', '榜单', 'sources', 'source'],
    seedWords: ['衍生种子词', '种子词', '来源词', '父词', 'seedwords', 'seeds'],
    rankEvidence: ['榜单排名证据', '排名证据', '榜单名次', 'rankevidence'],
    rankPop: ['热词榜人气', '热词人气', '榜单人气', 'rankpop'],
    derivePop: ['衍生词榜人气', '衍生词人气', 'derivepop'],
    parts: ['词根拆分', '分词结果', '词根组合', '词根列表', 'parts', 'roots'],
    demands: ['命中需求', '需求类型', '需求标签', '需求分类', 'demands'],
    partTypes: ['逐根需求', '词根需求', '词根类型明细', 'parttypes'],
    root: ['词根', 'root', '根词', '拆分词'],
    rootType: ['需求类型', '词根类型', '分类', 'type'],
    rootCount: ['出现词数', '关键词出现数', '出现次数', 'count'],
    rootPop: ['预估人气', '预估搜索人气', '搜索人气', 'pop'],
    rootExamples: ['示例词', '示例关键词', 'examples']
  };
  var MARKET_ALIASES = {
    '排名': ['排名', '排行', '名次', '序号', 'rank', 'ranking', 'rankno'],
    '排名环比': ['排名环比', '排名变化', '环比', 'rankchange', 'cyclecqc'],
    '商品名称': ['商品名称', '商品标题', '宝贝标题', '标题', 'itemtitle', 'itemname', 'subject'],
    '商品ID': ['商品id', '宝贝id', 'itemid', 'itempicid'],
    '商品图片URL': ['商品图片url', '商品图片', '图片url', '主图url', '主图', 'itempic', 'picturl', 'picurl', 'pic'],
    '商品链接': ['商品链接', '宝贝链接', '详情链接', '商品url', 'url', 'itemurl', 'itemdetailurl', 'detailurl'],
    '店铺名称': ['店铺名称', '店铺', '商家名称', 'shopname', 'sellername', 'shoptitle', 'nick'],
    '店铺链接': ['店铺链接', '店铺url', 'shopurl', 'sellerurl'],
    '店铺图片URL': ['店铺图片url', '店铺图片', '店铺logo', 'shoppic', 'shoplogo', 'sellerlogo'],
    '访客数(区间)': ['访客数(区间)', '访客数', '访客', 'uvrange', 'visitorrange', 'uv'],
    '支付买家数(区间)': ['支付买家数(区间)', '支付买家数', '成交人数', 'paybyrcnt', 'paybyerrange', 'paybyernumrange', 'byerrange'],
    '商品关键词': ['商品关键词', '核心关键词', '核心词', 'itemkeyword', 'corekeyword', 'keyword', 'keywords', 'word'],
    '搜索关键词': ['搜索关键词', '淘宝搜索关键词', '搜索词', '查询关键词', '查询词', 'searchkeyword', 'searchquery', 'query'],
    '收货人数': ['收货人数', '收货人数展示', '收货人数文本', '付款人数', '已购人数', '购买人数', 'receivedtext', 'salesdisplay'],
    '收货人数值': ['收货人数值', '收货人数数值', '收货数值', '付款人数值', '已购人数值', 'receivedcount', 'salescount'],
    '店铺类型': ['店铺类型', '天猫/淘宝', '天猫淘宝', '平台', '平台类型', '商品平台', '店铺平台', 'shoptype', 'sellertype', 'usertype'],
    '入口价格': ['入口价格', '入口价', '搜索价格', '搜索价', '展示价格', '展示价', '商品卡价格', '卡片价格', 'entryprice', 'searchprice', 'displayprice', 'price'],
    '入口价格值': ['入口价格值', '入口价格数值', '入口价数值', '搜索价格值', '搜索价数值', '展示价格值', '展示价数值', '价格值', 'entrypricevalue', 'pricevalue'],
    '数据来源': ['数据来源', '采集来源', '榜单来源', '来源', 'datasource', 'sourcetype', 'source']
  };
  var CATEGORY_ALIASES = ['品类', '品类名', '类目', '类目名', '类目名称', '叶子类目', 'category', 'catename'];
  var LINK_ALIASES = {
    '链接编号': ['链接编号', '链接id', '链接ID', 'L编号', '编号', '序号', 'linkid', 'link_id'],
    '生成方式': ['生成方式', '生成来源', 'generationmode', 'source'],
    '链接分组': ['链接分组', '分组', '链接类型', 'linkgroup', 'group'],
    '链接定位': ['链接定位', '定位', '链接方向', '定位方向', 'linkpositioning', 'positioning'],
    '主推关键词': ['主推关键词', '主推词', '主关键词', '核心关键词', '关键词', 'primarykeyword', 'primarykeywords', 'keyword', 'keywords'],
    '用户场景需求': ['用户场景需求', '场景需求', '人群场景需求', '用户需求', '目标场景', 'scenario_need', 'usersceneneed', 'userneed'],
    '来源关键词': ['来源关键词', '来源词', '原始关键词', 'sourcekeywords', 'sourcekeyword'],
    '竞品未覆盖词根': ['竞品未覆盖词根', '未覆盖词根', '机会词根', 'uncoveredroots'],
    '差异化定位逻辑': ['差异化定位逻辑', '差异化定位', '差异化逻辑', '差异化壁垒', '差异化卖点', '差异化', '差异点', 'differentiation'],
    '标题结构': ['标题结构', 'titlestructure'],
    '标题定位词路': ['标题定位词路', '标题词路', '标题方向', 'titlepath', 'titleroute'],
    '商品标题': ['商品标题', '产品标题', '标题', 'producttitle', 'itemtitle', 'title'],
    '标题冲突处理': ['标题冲突处理', '标题冲突', 'titleconflict'],
    '主图核心文案': ['主图核心文案', '主图文案', '核心文案', '图片文案', '主图卖点文案', 'imagecopy', 'maincopy', 'corecopy'],
    '详情页定位': ['详情页定位', '详情定位', '详情方向', 'detailpositioning'],
    '详情页文案': ['详情页文案', '详情文案', '详情核心文案', 'detailcopy'],
    '详情文案逻辑': ['详情文案逻辑', '详情页逻辑', '详情逻辑', '文案逻辑', 'detailcopylogic', 'detaillogic'],
    '优先级分数': ['优先级分数', '优先分', 'priorityscore'],
    '优先级': ['优先级', '优先级别', 'priority'],
    '数据状态': ['数据状态', '状态', 'datastatus', 'status']
  };

  function text(v) {
    if (v == null) return '';
    if (typeof v === 'object') {
      if (Object.prototype.hasOwnProperty.call(v, 'value')) return text(v.value);
      try { return JSON.stringify(v); } catch (e) { return ''; }
    }
    return String(v).replace(/^\ufeff/, '').trim();
  }
  function headerKey(v) {
    return text(v).replace(/[（]/g, '(').replace(/[）]/g, ')')
      .replace(/[\s_\-·.()]/g, '').toLowerCase();
  }
  function wordKey(v) { return text(v).replace(/\s+/g, '').toLowerCase(); }
  function rootKey(v) { return wordKey(v); }
  function aliasHit(value, aliases) {
    var k = headerKey(value);
    for (var i = 0; i < aliases.length; i++) if (k === headerKey(aliases[i])) return true;
    return false;
  }
  function columnIndex(headers, aliases) {
    for (var i = 0; i < headers.length; i++) if (aliasHit(headers[i], aliases)) return i;
    return -1;
  }
  function addUnique(arr, value) {
    value = text(value);
    if (value && arr.indexOf(value) < 0) arr.push(value);
  }
  function normalizeKind(kind) {
    var k = headerKey(kind);
    // “商品链接清单 / 链接关键词清单”同时包含商品或词，必须先识别链接语义，
    // 否则会误走市场排行或词表解析器。
    if (k === 'link' || k === 'links' || k === 'linkmatrix' || /链接清单|链接矩阵|上架清单|链接/.test(k)) return 'link';
    if (k === 'word' || k === 'words' || k === 'extra' || k === 'keyword' || /词/.test(k)) return 'word';
    if (k === 'market' || k === 'mr' || /市场|排行|竞品|商品/.test(k)) return 'market';
    throw new Error('未知表格类型：' + text(kind));
  }
  function normalizeDemandType(value) {
    var k = headerKey(value).replace(/^需求/, '');
    if (!k) return '';
    if (/品牌|竞品/.test(k)) return '品牌';
    if (/定制|规格|包装/.test(k)) return '定制';
    if (/场景|用途/.test(k)) return '场景';
    if (/人群|对象/.test(k)) return '人群';
    if (/风格|款式/.test(k)) return '风格';
    if (/属性|材质|成分/.test(k)) return '属性';
    if (/功能|功效|痛点|诉求/.test(k)) return '功能';
    if (/品类|类目|产品/.test(k)) return '品类';
    return '';
  }
  function splitList(value) {
    var s = text(value);
    if (!s) return [];
    var out = [];
    s.split(/[\/、，,；;|\n\r]+/).forEach(function (x) { x = text(x); if (x && out.indexOf(x) < 0) out.push(x); });
    return out;
  }
  function splitDemands(value) {
    var out = [];
    splitList(value).forEach(function (x) { var t = normalizeDemandType(x); if (t) addUnique(out, t); });
    return out;
  }
  function trimDetailRoot(v) {
    return text(v).replace(/^[\s\/、，,；;|]+|[\s\/、，,；;|]+$/g, '');
  }
  function parsePartDetail(value) {
    var s = text(value), parts = [], types = [], map = Object.create(null), unknown = [];
    if (!s) return { parts: parts, types: types, map: map, unknown: unknown };
    var re = /([^()（）]+?)[(（]([^()（）]+)[)）]/g, m;
    while ((m = re.exec(s))) {
      var p = trimDetailRoot(m[1]);
      var t = normalizeDemandType(m[2]);
      if (!p) continue;
      if (!t) unknown.push(text(m[2]));
      parts.push(p); types.push(t); map[rootKey(p)] = t;
    }
    return { parts: parts, types: types, map: map, unknown: unknown };
  }
  function parseMetric(value) {
    if (typeof value === 'number') return isFinite(value) ? value : 0;
    var s = text(value).replace(/,/g, '');
    if (!s || s === '-' || s === '--') return 0;
    var nums = [], re = /([\d.]+)\s*([万亿]?)/g, m;
    while ((m = re.exec(s))) {
      var n = parseFloat(m[1]);
      if (m[2] === '万') n *= 1e4;
      if (m[2] === '亿') n *= 1e8;
      if (isFinite(n)) nums.push(n);
    }
    if (!nums.length) return 0;
    return nums.length > 1 && /[~～-]/.test(s) ? (nums[0] + nums[1]) / 2 : nums[0];
  }
  function isHitCell(value) {
    var s = text(value).toLowerCase();
    return !!s && !/^(0|否|未命中|无|false|no|-|--)$/.test(s);
  }
  function valueAt(row, idx) { return idx >= 0 && row ? row[idx] : ''; }
  function rowHasContent(row) {
    for (var i = 0; i < (row || []).length; i++) if (text(row[i])) return true;
    return false;
  }
  function matrixCellCount(matrix) {
    var total = 0;
    for (var i = 0; i < (matrix || []).length; i++) {
      var row = matrix[i];
      var cells = Array.isArray(row) ? row.length : (row == null ? 0 : 1);
      if (cells > MAX_MATRIX_CELLS - total) return MAX_MATRIX_CELLS + 1;
      total += cells;
    }
    return total;
  }
  function assertMatrixBudget(sheets) {
    if (!Array.isArray(sheets) || !sheets.length) throw new Error('文件中没有可读取的工作表。');
    if (sheets.length > MAX_SHEET_COUNT) throw new Error('工作表超过 ' + MAX_SHEET_COUNT + ' 个，请删除无关工作表后重试。');
    var total = 0;
    for (var i = 0; i < sheets.length; i++) {
      var cells = matrixCellCount((sheets[i] && sheets[i].matrix) || []);
      if (cells > MAX_MATRIX_CELLS - total) throw new Error('解析后的实际单元格超过 150 万个，请删除无关列、工作表或拆分文件后重试。');
      total += cells;
    }
  }
  function zipFailure(message) { throw new Error('压缩包安全检查失败：' + message); }
  function isZipBytes(bytes) {
    if (!bytes || bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
    var third = bytes[2], fourth = bytes[3];
    return (third === 0x03 && fourth === 0x04) || (third === 0x05 && fourth === 0x06) || (third === 0x07 && fourth === 0x08);
  }
  // XLSX 是 ZIP。只读中央目录即可在真正解压 XML 前拦住明显的压缩炸弹；
  // ZIP64/分卷/损坏目录无法在此轻量路径中可靠核验，直接拒绝而不是冒险交给解析器。
  function preflightZip(bytes) {
    if (!isZipBytes(bytes)) return;
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), length = bytes.byteLength;
    var min = Math.max(0, length - 22 - 0xffff), eocd = -1;
    for (var p = length - 22; p >= min; p--) {
      if (view.getUint32(p, true) !== 0x06054b50) continue;
      var commentLength = view.getUint16(p + 20, true);
      if (p + 22 + commentLength === length) { eocd = p; break; }
    }
    if (eocd < 0) zipFailure('中央目录结尾缺失或损坏，无法安全读取。');
    var diskNo = view.getUint16(eocd + 4, true), centralDisk = view.getUint16(eocd + 6, true);
    var diskEntries = view.getUint16(eocd + 8, true), entryCount = view.getUint16(eocd + 10, true);
    var centralSize = view.getUint32(eocd + 12, true), centralOffset = view.getUint32(eocd + 16, true);
    if (entryCount === 0xffff || diskEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      zipFailure('ZIP64 无法安全预检，请拆分或另存为普通 XLSX。');
    }
    if (diskNo !== 0 || centralDisk !== 0 || diskEntries !== entryCount) zipFailure('不支持分卷 ZIP，请另存为普通 XLSX。');
    if (entryCount > MAX_ZIP_ENTRIES) zipFailure('条目超过 ' + MAX_ZIP_ENTRIES + ' 个，请删除无关内容后重试。');
    if (centralOffset > eocd || centralSize > eocd - centralOffset) zipFailure('中央目录偏移或长度损坏，无法安全读取。');
    var centralEnd = centralOffset + centralSize, cursor = centralOffset, total = 0;
    for (var i = 0; i < entryCount; i++) {
      if (cursor + 46 > centralEnd || view.getUint32(cursor, true) !== 0x02014b50) zipFailure('中央目录条目损坏，无法安全读取。');
      var flags = view.getUint16(cursor + 8, true);
      var compressed = view.getUint32(cursor + 20, true), uncompressed = view.getUint32(cursor + 24, true);
      var nameLength = view.getUint16(cursor + 28, true), extraLength = view.getUint16(cursor + 30, true), fileCommentLength = view.getUint16(cursor + 32, true);
      var startDisk = view.getUint16(cursor + 34, true), localOffset = view.getUint32(cursor + 42, true);
      if (compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff || startDisk === 0xffff) {
        zipFailure('ZIP64 条目无法安全预检，请拆分或另存为普通 XLSX。');
      }
      if (startDisk !== 0) zipFailure('不支持分卷 ZIP 条目，请另存为普通 XLSX。');
      if (flags & 1) zipFailure('不支持加密 ZIP，请上传未加密的 XLSX。');
      if (uncompressed > MAX_ZIP_ENTRY_BYTES) zipFailure('单个条目解压后超过 80MB，请精简或拆分文件后重试。');
      if (uncompressed > MAX_ZIP_TOTAL_BYTES - total) zipFailure('全部条目解压后超过 128MB，请精简或拆分文件后重试。');
      total += uncompressed;
      var next = cursor + 46 + nameLength + extraLength + fileCommentLength;
      if (next > centralEnd) zipFailure('中央目录条目长度损坏，无法安全读取。');
      if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== 0x04034b50) zipFailure('本地文件头与中央目录不一致，无法安全读取。');
      var localFlags = view.getUint16(localOffset + 6, true);
      var localCompressed = view.getUint32(localOffset + 18, true), localUncompressed = view.getUint32(localOffset + 22, true);
      var localNameLength = view.getUint16(localOffset + 26, true), localExtraLength = view.getUint16(localOffset + 28, true);
      if (localCompressed === 0xffffffff || localUncompressed === 0xffffffff) zipFailure('ZIP64 本地条目无法安全预检。');
      var dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      if (dataOffset > centralOffset || compressed > centralOffset - dataOffset) zipFailure('压缩数据范围越界，无法安全读取。');
      if (!(localFlags & 8) && (localCompressed !== compressed || localUncompressed !== uncompressed)) {
        zipFailure('本地文件头与中央目录大小不一致，无法安全读取。');
      }
      cursor = next;
    }
    if (cursor !== centralEnd) zipFailure('中央目录含未识别数据，无法安全读取。');
  }
  function sheetNameBonus(name, kind) {
    name = headerKey(name);
    if (kind === 'word') {
      if (name === '需求') return 18;
      if (/需求|词表|关键词/.test(name)) return 10;
      if (/词根/.test(name)) return -8;
    } else if (kind === 'market') {
      if (name === '市场排行') return 18;
      if (/市场排行|商品排行|竞品|商品榜/.test(name)) return 10;
    } else {
      if (name === '链接上架清单') return 24;
      if (/链接上架清单|链接清单|链接矩阵|上架清单/.test(name)) return 14;
    }
    return 0;
  }
  function scoreHeader(row, kind) {
    if (!row || !row.length) return { score: -1, required: false };
    var score = 0, required = false;
    if (kind === 'word') {
      required = columnIndex(row, WORD_ALIASES.keyword) >= 0;
      if (required) score += 35;
      if (columnIndex(row, WORD_ALIASES.popularity) >= 0) score += 6;
      if (columnIndex(row, WORD_ALIASES.parts) >= 0) score += 8;
      if (columnIndex(row, WORD_ALIASES.demands) >= 0) score += 5;
      if (columnIndex(row, WORD_ALIASES.partTypes) >= 0) score += 8;
      for (var i = 0; i < row.length; i++) if (/^需求(品类|属性|人群|功能|场景|风格|品牌|定制)$/.test(headerKey(row[i]))) score += 2;
    } else if (kind === 'market') {
      required = columnIndex(row, MARKET_ALIASES['商品名称']) >= 0;
      if (required) score += 35;
      MARKET_FIELDS.forEach(function (f) { if (f !== '商品名称' && columnIndex(row, MARKET_ALIASES[f]) >= 0) score += 3; });
      if (columnIndex(row, CATEGORY_ALIASES) >= 0) score += 2;
    } else {
      var promptFields = ['链接定位', '主推关键词', '用户场景需求', '差异化定位逻辑', '商品标题', '主图核心文案', '详情页定位', '详情页文案', '详情文案逻辑'];
      required = promptFields.some(function (field) { return columnIndex(row, LINK_ALIASES[field]) >= 0; });
      if (required) score += 35;
      LINK_FIELDS.forEach(function (field) { if (columnIndex(row, LINK_ALIASES[field]) >= 0) score += field === '链接编号' ? 8 : 3; });
      if (columnIndex(row, CATEGORY_ALIASES) >= 0) score += 4;
    }
    return { score: score, required: required };
  }
  function selectMainSheet(sheets, kind) {
    var best = null;
    (sheets || []).forEach(function (sheet) {
      var matrix = sheet.matrix || [], max = Math.min(matrix.length, MAX_HEADER_SCAN_ROWS);
      for (var r = 0; r < max; r++) {
        var h = scoreHeader(matrix[r], kind);
        var total = h.score + sheetNameBonus(sheet.name, kind) + (h.required ? 20 : 0);
        if (!best || total > best.total) best = { sheet: sheet, headerRow: r, headers: matrix[r] || [], required: h.required, total: total };
      }
    });
    if (!best || !best.required) {
      var found = best && best.headers ? best.headers.map(text).filter(Boolean).slice(0, 20).join('、') : '无';
      if (kind === 'word') throw new Error('未识别到“关键词/搜索词”列。候选表头：' + found);
      if (kind === 'market') throw new Error('未识别到“商品名称/商品标题”列。候选表头：' + found);
      throw new Error('未识别到链接定位、主推关键词、商品标题或详情页定位等链接字段。候选表头：' + found);
    }
    return best;
  }
  function selectRootSheet(sheets) {
    var best = null;
    (sheets || []).forEach(function (sheet) {
      var matrix = sheet.matrix || [], max = Math.min(matrix.length, MAX_HEADER_SCAN_ROWS);
      for (var r = 0; r < max; r++) {
        var row = matrix[r] || [];
        var ri = columnIndex(row, WORD_ALIASES.root), ti = columnIndex(row, WORD_ALIASES.rootType);
        if (ri < 0) continue;
        var score = 20 + (ti >= 0 ? 10 : 0) + (/词根/.test(headerKey(sheet.name)) ? 15 : 0);
        if (!best || score > best.score) best = { sheet: sheet, headerRow: r, headers: row, score: score };
      }
    });
    return best;
  }
  function matrixFromObjects(rows) {
    rows = Array.isArray(rows) ? rows : [];
    var headers = [];
    rows.forEach(function (row) { if (row && typeof row === 'object') Object.keys(row).forEach(function (k) { if (headers.indexOf(k) < 0) headers.push(k); }); });
    if (headers.length && (rows.length + 1) > Math.floor(MAX_MATRIX_CELLS / headers.length)) {
      throw new Error('解析后的实际单元格超过 150 万个，请删除无关列或拆分 JSON 后重试。');
    }
    return [headers].concat(rows.map(function (row) { return headers.map(function (h) { return row && row[h] != null ? row[h] : ''; }); }));
  }
  function mergeWord(target, source) {
    if (parseMetric(source.pop) > parseMetric(target.pop)) target.pop = source.pop;
    target.rankPop = Math.max(parseMetric(target.rankPop), parseMetric(source.rankPop));
    target.derivePop = Math.max(parseMetric(target.derivePop), parseMetric(source.derivePop));
    for (var i = 0; i < source.parts.length; i++) {
      var p = source.parts[i], idx = target.parts.map(rootKey).indexOf(rootKey(p));
      if (idx < 0) { target.parts.push(p); target.partTypes.push(source.partTypes[i] || ''); }
      else if (!target.partTypes[idx] && source.partTypes[i]) target.partTypes[idx] = source.partTypes[i];
    }
    source.demands.forEach(function (d) { addUnique(target.demands, d); });
    (source.sources || []).forEach(function (value) { addUnique(target.sources, value); });
    (source.seedWords || []).forEach(function (value) { addUnique(target.seedWords, value); });
    (source.rankEvidence || []).forEach(function (value) { addUnique(target.rankEvidence, value); });
  }
  function parseRootSeed(rootSelection) {
    var map = Object.create(null), sheetName = '';
    if (!rootSelection) return { map: map, sheet: sheetName };
    var matrix = rootSelection.sheet.matrix || [], h = rootSelection.headers;
    var ri = columnIndex(h, WORD_ALIASES.root), ti = columnIndex(h, WORD_ALIASES.rootType);
    var ci = columnIndex(h, WORD_ALIASES.rootCount), pi = columnIndex(h, WORD_ALIASES.rootPop), ei = columnIndex(h, WORD_ALIASES.rootExamples);
    for (var r = rootSelection.headerRow + 1; r < matrix.length; r++) {
      var name = text(valueAt(matrix[r], ri)); if (!name) continue;
      var k = rootKey(name), type = normalizeDemandType(valueAt(matrix[r], ti));
      map[k] = { root: name, type: type, seedCount: parseMetric(valueAt(matrix[r], ci)), seedPop: parseMetric(valueAt(matrix[r], pi)), examples: splitList(valueAt(matrix[r], ei)) };
    }
    return { map: map, sheet: rootSelection.sheet.name || '' };
  }
  function parseWordSheets(sheets, meta) {
    var selected = selectMainSheet(sheets, 'word'), matrix = selected.sheet.matrix || [], headers = selected.headers;
    var kwIdx = columnIndex(headers, WORD_ALIASES.keyword), popIdx = columnIndex(headers, WORD_ALIASES.popularity);
    var partsIdx = columnIndex(headers, WORD_ALIASES.parts), demandsIdx = columnIndex(headers, WORD_ALIASES.demands), detailIdx = columnIndex(headers, WORD_ALIASES.partTypes);
    var sourcesIdx = columnIndex(headers, WORD_ALIASES.sources), seedWordsIdx = columnIndex(headers, WORD_ALIASES.seedWords);
    var rankEvidenceIdx = columnIndex(headers, WORD_ALIASES.rankEvidence), rankPopIdx = columnIndex(headers, WORD_ALIASES.rankPop);
    var derivePopIdx = columnIndex(headers, WORD_ALIASES.derivePop);
    var rootSeed = parseRootSeed(selectRootSheet(sheets)), typeCols = {};
    DEMAND_ORDER.forEach(function (t) {
      for (var i = 0; i < headers.length; i++) if (headerKey(headers[i]) === headerKey('需求' + t)) { typeCols[t] = i; break; }
    });
    var map = Object.create(null), order = [], rawRows = Math.max(0, matrix.length - selected.headerRow - 1), validSource = 0;
    var missingParts = 0, defaultTypes = 0, unknownTypes = [], missingDemands = 0, scientificIds = 0;
    for (var r = selected.headerRow + 1; r < matrix.length; r++) {
      var row = matrix[r]; if (!rowHasContent(row)) continue;
      var kw = text(valueAt(row, kwIdx)); if (!kw) continue;
      validSource++; if (validSource > MAX_VALID_ROWS) throw new Error('有效关键词超过 5 万行，请先拆分或精简文件。');
      var parts = splitList(valueAt(row, partsIdx));
      var detail = parsePartDetail(valueAt(row, detailIdx));
      detail.unknown.forEach(function (x) { addUnique(unknownTypes, x); });
      if (!parts.length && detail.parts.length) parts = detail.parts.slice();
      if (!parts.length) missingParts++;
      var partTypes = parts.map(function (p) { return detail.map[rootKey(p)] || (rootSeed.map[rootKey(p)] && rootSeed.map[rootKey(p)].type) || ''; });
      var demands = splitDemands(valueAt(row, demandsIdx));
      Object.keys(typeCols).forEach(function (t) { if (isHitCell(valueAt(row, typeCols[t]))) addUnique(demands, t); });
      for (var p = 0; p < parts.length; p++) {
        if (!partTypes[p]) { partTypes[p] = '品类'; defaultTypes++; }
        addUnique(demands, partTypes[p]);
      }
      if (!demands.length) missingDemands++;
      var word = {
        kw: kw,
        pop: text(valueAt(row, popIdx)),
        rankPop: parseMetric(valueAt(row, rankPopIdx)),
        derivePop: parseMetric(valueAt(row, derivePopIdx)),
        parts: parts,
        partTypes: partTypes,
        demands: demands,
        sources: splitList(valueAt(row, sourcesIdx)),
        seedWords: splitList(valueAt(row, seedWordsIdx)),
        rankEvidence: splitList(valueAt(row, rankEvidenceIdx))
      };
      var nk = wordKey(kw);
      if (!map[nk]) { map[nk] = word; order.push(nk); } else mergeWord(map[nk], word);
    }
    if (!order.length) throw new Error('词表中没有有效关键词行。');
    var words = order.map(function (k) { return map[k]; }), rootsMap = Object.create(null);
    if (!words.some(function (w) { return w.parts && w.parts.length; })) {
      throw new Error('词表缺少“词根拆分”或“逐根需求”数据，无法按词根需求生成链接。请上传词根需求表，或使用页面内示例格式补齐。');
    }
    Object.keys(rootSeed.map).forEach(function (k) {
      var s = rootSeed.map[k]; rootsMap[k] = {
        root: s.root, type: s.type || '品类', count: 0, pop: 0, examples: [], rankingSources: [], rankEvidence: [],
        seedCount: s.seedCount, seedPop: s.seedPop
      };
    });
    words.forEach(function (w) {
      var seen = Object.create(null);
      w.parts.forEach(function (p, i) {
        var k = rootKey(p); if (!k || seen[k]) return; seen[k] = 1;
        if (!rootsMap[k]) rootsMap[k] = { root: p, type: w.partTypes[i] || '品类', count: 0, pop: 0, examples: [], rankingSources: [], rankEvidence: [], seedCount: 0, seedPop: 0 };
        if (!rootsMap[k].type && w.partTypes[i]) rootsMap[k].type = w.partTypes[i];
        rootsMap[k].count++; rootsMap[k].pop += parseMetric(w.pop);
        (w.sources || []).forEach(function (value) { addUnique(rootsMap[k].rankingSources, value); });
        (w.rankEvidence || []).forEach(function (value) { addUnique(rootsMap[k].rankEvidence, value); });
        if (rootsMap[k].examples.length < 3) addUnique(rootsMap[k].examples, w.kw);
      });
    });
    var roots = Object.keys(rootsMap).map(function (k) {
      var x = rootsMap[k]; return {
        root: x.root, type: x.type || '品类', count: x.count || x.seedCount || 0, pop: x.pop || x.seedPop || 0,
        examples: x.examples.length ? x.examples : ((rootSeed.map[k] && rootSeed.map[k].examples) || []),
        rankingSources: (x.rankingSources || []).slice(), rankEvidence: (x.rankEvidence || []).slice(), src: 'local-import'
      };
    }).sort(function (a, b) { return b.count - a.count || b.pop - a.pop; });
    var warnings = [], duplicates = validSource - words.length;
    if (duplicates) warnings.push('已合并 ' + duplicates + ' 行重复关键词');
    if (missingParts) warnings.push(missingParts + ' 个词没有词根列；本地规则会用原关键词兜底，建议使用 AI 精炼');
    if (defaultTypes) warnings.push(defaultTypes + ' 个词根缺少类型，已按“品类”兜底');
    if (missingDemands) warnings.push(missingDemands + ' 个词没有需求标签');
    if (unknownTypes.length) warnings.push('未识别的需求类型：' + unknownTypes.slice(0, 5).join('、'));
    if (!words.some(function (word) { return (word.sources || []).indexOf('热词榜') >= 0; })) {
      warnings.push('未识别到热词榜来源；链接定位仍可使用本表，但商品标题将按热词榜白名单阻断');
    }
    var mapped = {
      keyword: text(headers[kwIdx]), popularity: popIdx >= 0 ? text(headers[popIdx]) : '',
      parts: partsIdx >= 0 ? text(headers[partsIdx]) : '', demands: demandsIdx >= 0 ? text(headers[demandsIdx]) : '',
      partTypes: detailIdx >= 0 ? text(headers[detailIdx]) : '', sources: sourcesIdx >= 0 ? text(headers[sourcesIdx]) : '',
      seedWords: seedWordsIdx >= 0 ? text(headers[seedWordsIdx]) : '', rankEvidence: rankEvidenceIdx >= 0 ? text(headers[rankEvidenceIdx]) : ''
    };
    return {
      data: { status: 'done', ts: Date.now(), wordCount: words.length, words: words, roots: roots, source: 'local-import', message: '本地词表已识别 ' + words.length + ' 个词。', stats: { rawCount: validSource, dedupedCount: words.length, removedCount: duplicates, source: 'local-import' } },
      diagnostics: { fileName: (meta && meta.fileName) || '', sheet: selected.sheet.name || '', rootSheet: rootSeed.sheet, rawRows: rawRows, sourceRows: validSource, validRows: words.length, duplicatesRemoved: duplicates, columns: mapped, warnings: warnings, scientificIds: scientificIds }
    };
  }
  function normalizeUrl(value) {
    var s = text(value); return s.indexOf('//') === 0 ? ('https:' + s) : s;
  }
  function marketDedupKey(row) {
    var id = wordKey(row['商品ID']); if (id) return 'id:' + id;
    var url = wordKey(row['商品链接']); if (url) return 'url:' + url;
    return 'title:' + wordKey(row['商品名称']) + '|' + wordKey(row['店铺名称']);
  }
  function mergeMarketRow(target, source) {
    MARKET_FIELDS.forEach(function (f) { if (!text(target[f]) && text(source[f])) target[f] = source[f]; });
  }
  function parseMarketSheets(sheets, meta) {
    var selected = selectMainSheet(sheets, 'market'), matrix = selected.sheet.matrix || [], headers = selected.headers;
    var col = {}, mapped = {};
    MARKET_FIELDS.forEach(function (f) { col[f] = columnIndex(headers, MARKET_ALIASES[f]); mapped[f] = col[f] >= 0 ? text(headers[col[f]]) : ''; });
    var categoryIdx = columnIndex(headers, CATEGORY_ALIASES), map = Object.create(null), order = [];
    var rawRows = Math.max(0, matrix.length - selected.headerRow - 1), validSource = 0, category = '', scientific = 0, unsafeNumeric = 0;
    for (var r = selected.headerRow + 1; r < matrix.length; r++) {
      var src = matrix[r]; if (!rowHasContent(src)) continue;
      var title = text(valueAt(src, col['商品名称'])); if (!title) continue;
      validSource++; if (validSource > MAX_VALID_ROWS) throw new Error('有效商品超过 5 万行，请先拆分或精简文件。');
      var rawId = valueAt(src, col['商品ID']);
      var row = {};
      MARKET_FIELDS.forEach(function (f) { row[f] = text(valueAt(src, col[f])); });
      row['商品名称'] = title;
      // Excel/JSON 若把长 ID 存成 Number，超过安全整数后末位在进入 JS 前就可能失真，无法从近似值还原。
      // 不把近似数字继续冒充精确商品 ID；文本型 ID（包括超长字符串）始终原样保留。
      if (typeof rawId === 'number' && !Number.isSafeInteger(rawId)) {
        unsafeNumeric++;
        row['商品ID'] = '';
      }
      row['商品图片URL'] = normalizeUrl(row['商品图片URL']); row['商品链接'] = normalizeUrl(row['商品链接']);
      row['店铺链接'] = normalizeUrl(row['店铺链接']); row['店铺图片URL'] = normalizeUrl(row['店铺图片URL']);
      if (!row['排名']) row['排名'] = validSource;
      if (/e\+?\d+/i.test(row['商品ID'])) scientific++;
      if (!category && categoryIdx >= 0) category = text(valueAt(src, categoryIdx));
      var k = marketDedupKey(row);
      if (!map[k]) { map[k] = row; order.push(k); } else mergeMarketRow(map[k], row);
    }
    if (!order.length) throw new Error('市场排行表中没有有效商品行。');
    var rows = order.map(function (k) { return map[k]; }), duplicates = validSource - rows.length, warnings = [];
    if (unsafeNumeric) warnings.push(unsafeNumeric + ' 个商品ID在源文件中是超出安全整数范围的数值，末位可能已丢失且无法还原；为避免把近似值当成精确ID，已留空。请把源表“商品ID”列设为文本后重新上传。');
    if (duplicates) warnings.push('已合并 ' + duplicates + ' 行重复商品');
    if (scientific) warnings.push(scientific + ' 个商品ID是科学计数法，Excel 中可能已丢失末位精度');
    ['商品关键词', '商品链接', '店铺名称'].forEach(function (f) { if (col[f] < 0) warnings.push('未识别到“' + f + '”列，相关竞品信息会较少'); });
    return {
      data: { fields: MARKET_FIELDS.slice(), rows: rows, category: category, ts: Date.now(), source: 'local-import' },
      diagnostics: { fileName: (meta && meta.fileName) || '', sheet: selected.sheet.name || '', rawRows: rawRows, sourceRows: validSource, validRows: rows.length, duplicatesRemoved: duplicates, columns: mapped, warnings: warnings, unsafeNumericIds: unsafeNumeric }
    };
  }

  function linkColumnIndexes(headers, aliases) {
    var out = [];
    for (var i = 0; i < (headers || []).length; i++) if (aliasHit(headers[i], aliases)) out.push(i);
    return out;
  }
  function linkSequence(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : NaN;
    var raw = text(value), match = raw.match(/^[Ll]\s*0*(\d+)$/) || raw.match(/^0*(\d+)$/);
    var number = match ? parseInt(match[1], 10) : NaN;
    return Number.isSafeInteger(number) && number > 0 ? number : NaN;
  }
  function linkId(number) {
    number = parseInt(number, 10);
    return 'L' + (number < 1000 ? String(number).padStart(3, '0') : String(number));
  }
  function parseLinkSheets(sheets, meta) {
    var selected = selectMainSheet(sheets, 'link'), matrix = selected.sheet.matrix || [], headers = selected.headers || [];
    var fieldIndexes = {}, mapped = {}, usedColumns = Object.create(null), duplicateMappings = [];
    LINK_FIELDS.forEach(function (field) {
      var indexes = linkColumnIndexes(headers, LINK_ALIASES[field]);
      fieldIndexes[field] = indexes;
      mapped[field] = indexes.length ? indexes.map(function (index) { return text(headers[index]); }).join(' / ') : '';
      indexes.forEach(function (index) { usedColumns[index] = true; });
      if (indexes.length > 1) duplicateMappings.push(field + '（' + mapped[field] + '）');
    });
    var categoryIndexes = linkColumnIndexes(headers, CATEGORY_ALIASES);
    categoryIndexes.forEach(function (index) { usedColumns[index] = true; });
    var ignoredColumns = headers.map(function (header, index) { return usedColumns[index] || !text(header) ? '' : text(header); }).filter(Boolean);
    var promptFields = ['链接定位', '主推关键词', '用户场景需求', '差异化定位逻辑', '商品标题', '主图核心文案', '详情页定位', '详情页文案', '详情文案逻辑'];
    var rawRows = Math.max(0, matrix.length - selected.headerRow - 1), sourceRows = 0, ignoredRows = 0;
    var rows = [], sourceLineByRow = [], exactDuplicates = 0, category = text(meta && meta.category);
    var categoryKey = wordKey(category);

    function mappedValue(src, field, excelRow) {
      var indexes = fieldIndexes[field] || [], values = [];
      indexes.forEach(function (index) {
        var value = text(valueAt(src, index));
        if (value && values.indexOf(value) < 0) values.push(value);
      });
      if (values.length > 1) throw new Error('工作表“' + selected.sheet.name + '”第 ' + excelRow + ' 行映射到“' + field + '”的多列值不一致，请只保留一列。');
      return values[0] || '';
    }

    for (var r = selected.headerRow + 1; r < matrix.length; r++) {
      var src = matrix[r];
      if (!rowHasContent(src)) continue;
      sourceRows++;
      if (sourceRows > MAX_VALID_ROWS) throw new Error('有效链接超过 5 万行，请先拆分或精简文件。');
      var excelRow = r + 1, row = {};
      LINK_FIELDS.forEach(function (field) { row[field] = mappedValue(src, field, excelRow); });
      if (!promptFields.some(function (field) { return !!text(row[field]); })) {
        ignoredRows++;
        continue;
      }
      var rowCategories = [], rowCategoryKeys = Object.create(null);
      for (var c = 0; c < categoryIndexes.length; c++) {
        var rowCategory = text(valueAt(src, categoryIndexes[c])), rowCategoryKey = wordKey(rowCategory);
        if (rowCategoryKey && !rowCategoryKeys[rowCategoryKey]) {
          rowCategoryKeys[rowCategoryKey] = true;
          rowCategories.push(rowCategory);
        }
      }
      if (rowCategories.length > 1) {
        throw new Error('工作表“' + selected.sheet.name + '”第 ' + excelRow + ' 行包含多个不一致的品类：' + rowCategories.join('、') + '。每批链接清单只能使用一个品类。');
      }
      if (rowCategories.length) {
        var nextCategory = rowCategories[0], nextCategoryKey = wordKey(nextCategory);
        if (categoryKey && categoryKey !== nextCategoryKey) {
          throw new Error('链接清单包含多个品类：' + category + '、' + nextCategory + '（工作表“' + selected.sheet.name + '”第 ' + excelRow + ' 行）。请按品类拆分文件后导入。');
        }
        if (!categoryKey) {
          category = nextCategory;
          categoryKey = nextCategoryKey;
        }
      }
      rows.push(row);
      sourceLineByRow.push(excelRow);
    }
    if (!rows.length) throw new Error('链接清单中没有可用于主图或详情提示词的有效行。');

    var explicitCount = rows.filter(function (row) { return !!text(row['链接编号']); }).length;
    var autoNumbered = explicitCount === 0, seenIds = Object.create(null), sequences = [];
    if (explicitCount > 0 && explicitCount < rows.length) {
      var missingIndex = rows.findIndex(function (row) { return !text(row['链接编号']); });
      throw new Error('工作表“' + selected.sheet.name + '”第 ' + sourceLineByRow[missingIndex] + ' 行缺少链接编号。已有部分编号时，每一行都必须填写；若要自动编号，请清空整列后重新导入。');
    }
    // 整列无编号时，非标准备注列不会进入最终 JSON，也不得让同一条标准链接
    // 被误判为两条。已有显式编号时则保留用户刻意设置的不同链接，交由编号唯一性校验。
    if (autoNumbered) {
      var standardSeen = Object.create(null), uniqueRows = [], uniqueLines = [];
      rows.forEach(function (row, index) {
        var standardKey = JSON.stringify(LINK_FIELDS.map(function (field) { return text(row[field]); }));
        if (standardSeen[standardKey]) { exactDuplicates++; return; }
        standardSeen[standardKey] = true;
        uniqueRows.push(row);
        uniqueLines.push(sourceLineByRow[index]);
      });
      rows = uniqueRows;
      sourceLineByRow = uniqueLines;
    }
    rows.forEach(function (row, index) {
      var sequence = autoNumbered ? (index + 1) : linkSequence(row['链接编号']);
      if (!isFinite(sequence)) throw new Error('工作表“' + selected.sheet.name + '”第 ' + sourceLineByRow[index] + ' 行链接编号无效：' + text(row['链接编号']) + '。请使用 L001、L2 或纯数字。');
      var id = linkId(sequence);
      if (seenIds[id]) throw new Error('链接编号重复：' + id + '，出现在工作表“' + selected.sheet.name + '”第 ' + seenIds[id] + ' 行和第 ' + sourceLineByRow[index] + ' 行。');
      seenIds[id] = sourceLineByRow[index];
      sequences.push(sequence);
      row['链接编号'] = id;
    });

    var sorted = sequences.slice().sort(function (a, b) { return a - b; }), missing = [], sequenceSet = Object.create(null);
    sequences.forEach(function (sequence) { sequenceSet[sequence] = true; });
    if (sorted.length > 1) {
      for (var number = sorted[0]; number <= sorted[sorted.length - 1] && missing.length < 20; number++) {
        if (!sequenceSet[number]) missing.push(linkId(number));
      }
    }
    var mainRequired = ['链接定位', '主推关键词', '用户场景需求', '差异化定位逻辑', '主图核心文案'];
    var detailReady = rows.filter(function (row) {
      return !!(text(row['详情页定位']) || text(row['链接定位'])) &&
        !!(text(row['详情页文案']) || text(row['主图核心文案'])) && !!text(row['详情文案逻辑']);
    }).length;
    var mainReady = rows.filter(function (row) { return mainRequired.every(function (field) { return !!text(row[field]); }); }).length;
    var warnings = [];
    if (autoNumbered) warnings.push('原表没有链接编号，已按表格顺序生成 ' + linkId(1) + '–' + linkId(rows.length));
    if (exactDuplicates) warnings.push('已忽略 ' + exactDuplicates + ' 行完全重复数据');
    if (ignoredRows) warnings.push('已忽略 ' + ignoredRows + ' 行缺少提示词定位内容的数据');
    if (duplicateMappings.length) warnings.push('以下目标字段存在多个同值来源列，已合并：' + duplicateMappings.slice(0, 5).join('、'));
    if (ignoredColumns.length) warnings.push('已忽略 ' + ignoredColumns.length + ' 个非标准列：' + ignoredColumns.slice(0, 8).join('、'));
    if (missing.length) warnings.push('编号存在断档：' + missing.join('、') + (missing.length >= 20 ? '…' : '') + '；跨断档批量提词会在调用 AI 前被阻止');
    if (!category) warnings.push('未识别到品类；提词前需要在页面中手动确认');
    if (mainReady < rows.length) warnings.push((rows.length - mainReady) + ' 条缺少完整主图规划字段');
    if (detailReady < rows.length) warnings.push((rows.length - detailReady) + ' 条缺少完整详情规划字段');
    return {
      data: {
        rows: rows, category: category, source: 'custom-link-import', schemaVersion: 'LINK_PROMPT_INPUT_V1',
        promptCoverage: { mainReady: mainReady, detailReady: detailReady, total: rows.length }
      },
      diagnostics: {
        fileName: (meta && meta.fileName) || '', sheet: selected.sheet.name || '', rawRows: rawRows, sourceRows: sourceRows,
        validRows: rows.length, duplicatesRemoved: exactDuplicates, ignoredRows: ignoredRows, autoNumbered: autoNumbered,
        columns: mapped, ignoredColumns: ignoredColumns, category: category, promptCoverage: { mainReady: mainReady, detailReady: detailReady, total: rows.length }, warnings: warnings
      }
    };
  }
  function parseMatrices(sheets, kind, meta) {
    kind = normalizeKind(kind);
    assertMatrixBudget(sheets);
    if (kind === 'word') return parseWordSheets(sheets, meta || {});
    if (kind === 'market') return parseMarketSheets(sheets, meta || {});
    return parseLinkSheets(sheets, meta || {});
  }
  function resolveXlsx(explicit) {
    var x = explicit || root.XLSX || (typeof globalThis !== 'undefined' && globalThis.XLSX);
    if (!x || !x.utils || typeof x.read !== 'function') throw new Error('Excel 解析组件未加载，请刷新扩展后重试。');
    return x;
  }
  function assertWorkbookBudget(workbook, xlsx) {
    var names = (workbook && workbook.SheetNames) || [];
    if (names.length > MAX_SHEET_COUNT) throw new Error('工作表超过 ' + MAX_SHEET_COUNT + ' 个，请删除无关工作表后重试。');
    var total = 0;
    for (var i = 0; i < names.length; i++) {
      var sheet = workbook.Sheets && workbook.Sheets[names[i]];
      var ref = sheet && (sheet['!fullref'] || sheet['!ref']);
      if (!ref) continue;
      var range;
      try { range = xlsx.utils.decode_range(ref); }
      catch (e) { throw new Error('工作表“' + names[i] + '”的单元格范围无效，无法安全读取。'); }
      var rowCount = range.e.r - range.s.r + 1, colCount = range.e.c - range.s.c + 1;
      if (rowCount <= 0 || colCount <= 0 || rowCount > Math.floor((MAX_DECLARED_CELLS - total) / colCount)) {
        throw new Error('工作簿声明的单元格超过 200 万个，请删除无关列、工作表或拆分文件后重试。');
      }
      total += rowCount * colCount;
      if (sheet['!fullref'] && sheet['!ref'] && sheet['!fullref'] !== sheet['!ref']) {
        throw new Error('工作表“' + names[i] + '”超过 ' + MAX_READ_ROWS + ' 行安全读取上限，请拆分文件后重试。');
      }
    }
  }
  function workbookSheets(workbook, xlsx) {
    assertWorkbookBudget(workbook, xlsx);
    var names = workbook.SheetNames || [], out = [], total = 0;
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      // raw:true 保留数值/字符串的原始类型，才能识别被 Excel 当作 Number 的超长商品 ID。
      var matrix = xlsx.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false });
      var cells = matrixCellCount(matrix);
      if (cells > MAX_MATRIX_CELLS - total) throw new Error('解析后的实际单元格超过 150 万个，请删除无关列、工作表或拆分文件后重试。');
      total += cells;
      out.push({ name: name, matrix: matrix });
    }
    return out;
  }
  function parseWorkbook(workbook, kind, meta, explicitXlsx) {
    var xlsx = resolveXlsx(explicitXlsx);
    return parseMatrices(workbookSheets(workbook, xlsx), kind, meta || {});
  }
  function jsonToMatrices(payload, kind) {
    kind = normalizeKind(kind);
    if (payload && payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) payload = payload.data;
    if (kind === 'word' && payload && Array.isArray(payload.words)) {
      var wh = ['关键词', '搜索人气', '词根拆分', '命中需求', '逐根需求', '榜单来源', '衍生种子词', '榜单排名证据', '热词榜人气', '衍生词榜人气'];
      var wm = [wh].concat(payload.words.map(function (w) {
        var parts = Array.isArray(w.parts) ? w.parts : splitList(w.parts);
        var types = Array.isArray(w.partTypes) ? w.partTypes : splitList(w.partTypes);
        return [
          w.kw != null ? w.kw : (w.keyword || ''), w.pop != null ? w.pop : (w.popularity || ''), parts.join(' / '),
          (Array.isArray(w.demands) ? w.demands : splitList(w.demands)).join('、'),
          parts.map(function (p, i) { return p + '(' + (types[i] || '') + ')'; }).join('  '),
          (Array.isArray(w.sources) ? w.sources : splitList(w.sources || w.source)).join('、'),
          (Array.isArray(w.seedWords) ? w.seedWords : splitList(w.seedWords)).join('、'),
          (Array.isArray(w.rankEvidence) ? w.rankEvidence : splitList(w.rankEvidence)).join('、'),
          w.rankPop || '', w.derivePop || ''
        ];
      }));
      var out = [{ name: '需求', matrix: wm }];
      if (Array.isArray(payload.roots)) out.push({ name: '词根', matrix: matrixFromObjects(payload.roots) });
      return out;
    }
    var rows = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.rows) ? payload.rows : null);
    if (!rows && kind === 'link' && payload) {
      rows = Array.isArray(payload.linksJson) ? payload.linksJson
        : (Array.isArray(payload.linkRows) ? payload.linkRows
          : (Array.isArray(payload.links) ? payload.links : (Array.isArray(payload.data) ? payload.data : null)));
    }
    if (!rows) throw new Error('JSON 需要是行数组，或包含 words / rows 数组。');
    return [{ name: kind === 'word' ? '词表' : (kind === 'market' ? '市场排行' : '链接上架清单'), matrix: matrixFromObjects(rows) }];
  }
  function readBuffer(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var reader = new FileReader(); reader.onload = function () { resolve(reader.result); }; reader.onerror = function () { reject(reader.error || new Error('文件读取失败')); }; reader.readAsArrayBuffer(file);
    });
  }
  function parseFile(file, kind) {
    kind = normalizeKind(kind);
    if (!file) return Promise.reject(new Error('没有选择文件。'));
    if (file.size > MAX_FILE_BYTES) return Promise.reject(new Error('文件超过 30MB，请先精简。'));
    var name = text(file.name), ext = (name.split('.').pop() || '').toLowerCase();
    return readBuffer(file).then(function (buffer) {
      var byteLength = buffer && typeof buffer.byteLength === 'number' ? buffer.byteLength : 0;
      if (byteLength > MAX_FILE_BYTES) throw new Error('文件超过 30MB，请先精简。');
      var bytes = new Uint8Array(buffer);
      if (ext === 'json') {
        var jsonText = new TextDecoder('utf-8').decode(bytes);
        var payload; try { payload = JSON.parse(jsonText.replace(/^\ufeff/, '')); } catch (e) { throw new Error('JSON 格式错误：' + e.message); }
        var jsonMeta = { fileName: name };
        if (kind === 'link' && payload && typeof payload === 'object' && !Array.isArray(payload)) {
          var nested = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : null;
          var categoryCandidates = [payload.category, payload['品类'], payload['品类名']];
          if (nested) categoryCandidates.push(nested.category, nested['品类'], nested['品类名']);
          for (var categoryIndex = 0; categoryIndex < categoryCandidates.length; categoryIndex++) {
            jsonMeta.category = text(categoryCandidates[categoryIndex]);
            if (jsonMeta.category) break;
          }
        }
        return parseMatrices(jsonToMatrices(payload, kind), kind, jsonMeta);
      }
      preflightZip(bytes);
      var xlsx = resolveXlsx();
      var workbook;
      try { workbook = xlsx.read(bytes, { type: 'array', cellText: true, cellDates: false, raw: false, sheetRows: MAX_READ_ROWS }); }
      catch (e2) { throw new Error('无法读取该表格：' + ((e2 && e2.message) || e2)); }
      return parseWorkbook(workbook, kind, { fileName: name }, xlsx);
    });
  }

  // 业务知识库复用的通用 Excel 安全文本抽取：沿用 ZIP/工作表/单元格预算，
  // 不执行公式、不访问外链，只返回按工作表顺序拼接的纯文本。
  function extractWorkbookText(file, options) {
    options = options || {};
    var maxChars = Math.max(1000, Math.min(500000, parseInt(options.maxChars, 10) || 120000));
    if (!file) return Promise.reject(new Error('没有选择文件。'));
    if (file.size > MAX_FILE_BYTES) return Promise.reject(new Error('文件超过 30MB，请先精简。'));
    return readBuffer(file).then(function (buffer) {
      var bytes = new Uint8Array(buffer);
      preflightZip(bytes);
      var xlsx = resolveXlsx();
      var workbook;
      try { workbook = xlsx.read(bytes, { type: 'array', cellText: true, cellDates: false, raw: false, sheetRows: MAX_READ_ROWS }); }
      catch (error) { throw new Error('无法读取该表格：' + ((error && error.message) || error)); }
      var sheets = workbookSheets(workbook, xlsx);
      var parts = [], used = 0, truncated = false;
      for (var s = 0; s < sheets.length; s++) {
        var head = '【工作表：' + sheets[s].name + '】\n';
        if (used + head.length > maxChars) { truncated = true; break; }
        parts.push(head); used += head.length;
        var matrix = sheets[s].matrix || [];
        for (var r = 0; r < matrix.length; r++) {
          var line = (matrix[r] || []).map(text).join('\t').replace(/[ \t]+$/g, '') + '\n';
          if (used + line.length > maxChars) {
            parts.push(line.slice(0, Math.max(0, maxChars - used)));
            used = maxChars; truncated = true; break;
          }
          parts.push(line); used += line.length;
        }
        if (truncated) break;
        parts.push('\n'); used++;
      }
      return { text: parts.join('').trim(), truncated: truncated, sheets: sheets.length };
    });
  }

  return {
    parseFile: parseFile,
    parseWorkbook: parseWorkbook,
    parseMatrices: parseMatrices,
    extractWorkbookText: extractWorkbookText,
    normalizeDemandType: normalizeDemandType,
    parseMetric: parseMetric,
    constants: {
      maxFileBytes: MAX_FILE_BYTES, maxRows: MAX_VALID_ROWS, maxSheets: MAX_SHEET_COUNT,
      maxDeclaredCells: MAX_DECLARED_CELLS, maxMatrixCells: MAX_MATRIX_CELLS, maxHeaderScanRows: MAX_HEADER_SCAN_ROWS,
      maxReadRows: MAX_READ_ROWS,
      maxZipEntries: MAX_ZIP_ENTRIES, maxZipEntryBytes: MAX_ZIP_ENTRY_BYTES, maxZipTotalBytes: MAX_ZIP_TOTAL_BYTES,
      demandTypes: DEMAND_ORDER.slice(), marketFields: MARKET_FIELDS.slice(), linkFields: LINK_FIELDS.slice()
    }
  };
});

;
/* Frozen source: public/creative/src/business-knowledge.js */
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
    productionOrder: productionOrder,
    productionOrderText: productionOrderText,
    contextForScope: contextForScope,
    normalizeStore: normalizeStore,
    forAccount: forAccount,
    setForAccount: setForAccount
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

;
/* Frozen source: public/creative/src/subject-orchestration.js */
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

;
/* Frozen source: public/creative/src/subject-assets.js */
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

;
/* Frozen source: public/creative/src/reference-detail-contract.js */
/* reference-detail-contract.js — “参考成详”V1 领域合同与无副作用纯函数 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SZ_REFERENCE_DETAIL_CONTRACT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SOURCE_SCHEMA = 'REFERENCE_DETAIL_SOURCE_V1';
  var SCREENSHOT_SOURCE_SCHEMA = 'REFERENCE_DETAIL_SCREENSHOT_SOURCE_V1';
  var SCREENSHOT_LIMITS = Object.freeze({ maxImages: 6, maxImageBytes: 6 * 1024 * 1024, maxTotalBytes: 24 * 1024 * 1024 });
  var BLUEPRINT_SCHEMA = 'REFERENCE_DETAIL_BLUEPRINT_V1';
  var BATCH_SCHEMA = 'REFERENCE_DETAIL_BATCH_V1';
  var SCHEMA_VERSION = 1;
  var VISUAL_STRUCTURE_BLUEPRINT_SCHEMA = 'REFERENCE_DETAIL_BLUEPRINT_V2';
  var VISUAL_STRUCTURE_BATCH_SCHEMA = 'REFERENCE_DETAIL_BATCH_V2';
  var VISUAL_STRUCTURE_SCHEMA_VERSION = 2;
  var VISUAL_STRUCTURE_ONLY = 'visual_structure_only';

  var COMPLETENESS_STATUSES = Object.freeze(['complete', 'partial', 'unknown', 'blocked']);
  var SOURCE_MODES = Object.freeze(['pasted_url', 'current_page']);
  var SALES_ROLES = Object.freeze([
    'hero', 'pain', 'benefit', 'feature', 'scene', 'detail', 'comparison', 'proof',
    'spec', 'size', 'usage', 'faq', 'service', 'cta', 'unknown'
  ]);
  var BLOCK_TYPES = Object.freeze(['image', 'text', 'image_text', 'video', 'table', 'divider', 'mixed', 'unknown']);
  var ASSET_ROLES = Object.freeze([
    'main', 'hero', 'product', 'subject', 'detail', 'option', 'sku', 'scene', 'model',
    'logo', 'badge', 'icon', 'background', 'decoration', 'comparison', 'proof', 'spec',
    'size', 'service', 'video', 'video_poster', 'unknown'
  ]);
  var RIGHTS_STATUSES = Object.freeze(['reference_only', 'authorized', 'self_owned', 'unknown', 'blocked']);
  var BLUEPRINT_APPROVAL_STATUSES = Object.freeze(['draft', 'in_review', 'approved', 'rejected']);
  var MODULE_DERIVATION_KINDS = Object.freeze(['source', 'duplicate', 'merge', 'split']);
  var BATCH_STATUSES = Object.freeze(['ready', 'running', 'partial', 'completed', 'failed', 'blocked', 'cancelled']);
  var TASK_STATUSES = Object.freeze(['pending', 'running', 'completed', 'failed', 'blocked', 'cancelled']);
  var EVIDENCE_KINDS = Object.freeze(['dom', 'json', 'network', 'metadata', 'user', 'unknown']);
  var RESULT_KINDS = Object.freeze(['page', 'image', 'archive', 'manifest', 'unknown']);
  var DETAIL_IMAGE_BLOCK_TYPES = Object.freeze({ image: true, image_text: true, mixed: true });
  var DETAIL_RANGE_PATH_PREFIX = 'detail-range:graphic-detail-to-shop-recommend:';
  var DETAIL_IMAGE_ASSET_ROLE_DENY = Object.freeze({
    main: true, option: true, sku: true, logo: true, badge: true, icon: true,
    video: true, video_poster: true
  });

  var DEFAULT_LIMITS = Object.freeze({
    maxDepth: 16,
    maxNodes: 50000,
    maxObjectKeys: 1000,
    maxJsonArrayLength: 2000,
    maxTextLength: 12000,
    maxShortTextLength: 1000,
    maxUrlLength: 4096,
    maxFacts: 2000,
    maxBlocks: 5000,
    maxAssets: 10000,
    maxEvidence: 5000,
    maxWarnings: 500,
    maxRefsPerBlock: 500,
    maxCopyBullets: 100,
    maxRiskFlags: 100,
    maxBatchTasks: 1000,
    maxSubjectAssetsPerTask: 100,
    maxSkuIdsPerTask: 2000,
    maxErrorsPerTask: 100,
    maxResultsPerTask: 500
  });
  var HARD_LIMITS = Object.freeze({
    maxDepth: 32,
    maxNodes: 100000,
    maxObjectKeys: 5000,
    maxJsonArrayLength: 10000,
    maxTextLength: 100000,
    maxShortTextLength: 10000,
    maxUrlLength: 8192,
    maxFacts: 10000,
    maxBlocks: 20000,
    maxAssets: 30000,
    maxEvidence: 20000,
    maxWarnings: 2000,
    maxRefsPerBlock: 5000,
    maxCopyBullets: 500,
    maxRiskFlags: 500,
    maxBatchTasks: 5000,
    maxSubjectAssetsPerTask: 1000,
    maxSkuIdsPerTask: 10000,
    maxErrorsPerTask: 1000,
    maxResultsPerTask: 5000
  });

  var DEFAULT_URL_POLICY = deepFreeze({
    sourceRules: [
      { platform: 'taobao', host: 'item.taobao.com', paths: ['/item.htm'], itemIdParam: 'id' },
      { platform: 'tmall', host: 'detail.tmall.com', paths: ['/item.htm'], itemIdParam: 'id' },
      { platform: 'tmall', host: 'chaoshi.detail.tmall.com', paths: ['/item.htm'], itemIdParam: 'id' },
      { platform: 'tmall', host: 'detail.tmall.hk', paths: ['/item.htm', '/hk/item.htm'], itemIdParam: 'id' }
    ],
    assetHostRules: [
      { host: 'alicdn.com', includeSubdomains: true },
      { host: 'alicdn.cn', includeSubdomains: true },
      { host: 'taobaocdn.com', includeSubdomains: true },
      { host: 'tbcdn.cn', includeSubdomains: true },
      { host: 'tmallcdn.com', includeSubdomains: true }
    ]
  });

  var DANGEROUS_KEYS = Object.freeze({ '__proto__': true, prototype: true, constructor: true });
  var SENSITIVE_KEYS = Object.freeze({
    cookie: true, cookies: true, setcookie: true, token: true, accesstoken: true,
    refreshtoken: true, authorization: true, proxyauthorization: true, apikey: true,
    secret: true, password: true, credential: true, credentials: true, headers: true,
    requestheaders: true, responseheaders: true, sessionid: true
  });
  var SENSITIVE_URL_QUERY_KEYS = Object.freeze({
    sign: true, signature: true, x5sec: true, expires: true, policy: true,
    credential: true, securitytoken: true, accesskeyid: true, keypairid: true,
    algorithm: true, signedheaders: true, auth: true, authkey: true, authtoken: true,
    ossaccesskeyid: true, xosscredential: true, xosssecuritytoken: true, xosssignature: true,
    xamzcredential: true, xamzsecuritytoken: true, xamzsignature: true,
    xamzexpires: true, xamzalgorithm: true, xamzsignedheaders: true
  });
  var SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
  var SAFE_PLATFORM = /^[a-z][a-z0-9_-]{1,31}$/;
  var SAFE_RISK_FLAG = /^[A-Z][A-Z0-9_]{1,79}$/;
  var RIGHTS_RESTRICTIVENESS = Object.freeze({ self_owned: 0, authorized: 1, reference_only: 2, unknown: 3, blocked: 4 });

  function ContractError(code, message, path) {
    this.name = 'ReferenceDetailContractError';
    this.code = code || 'CONTRACT_ERROR';
    this.message = message || '参考成详合同错误';
    this.path = path || '$';
    if (Error.captureStackTrace) Error.captureStackTrace(this, ContractError);
  }
  ContractError.prototype = Object.create(Error.prototype);
  ContractError.prototype.constructor = ContractError;

  function fail(code, message, path) {
    throw new ContractError(code, message, path);
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    try {
      var proto = Object.getPrototypeOf(value);
      return proto === Object.prototype || proto === null;
    } catch (_) {
      return false;
    }
  }

  function isCrossRealmPlainObject(value) {
    if (isPlainObject(value)) return true;
    try {
      var proto = Object.getPrototypeOf(value);
      return Object.prototype.toString.call(value) === '[object Object]' && !!proto && Object.getPrototypeOf(proto) === null;
    } catch (_) {
      return false;
    }
  }

  function ownDescriptor(object, key) {
    if (!object || typeof object !== 'object') return null;
    try {
      if (!Object.prototype.hasOwnProperty.call(object, key)) return null;
      return Object.getOwnPropertyDescriptor(object, key) || null;
    } catch (_) {
      return null;
    }
  }

  function ownValue(object, key, context, path) {
    var descriptor = ownDescriptor(object, key);
    if (!descriptor) return undefined;
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      if (context) addIssue(context, 'NON_JSON_ACCESSOR_DROPPED', '访问器字段不属于普通 JSON，已忽略。', path || '$', 'warning');
      return undefined;
    }
    return descriptor.value;
  }

  function normalizedUrlComponent(value) {
    var output = String(value == null ? '' : value);
    try { if (typeof output.normalize === 'function') output = output.normalize('NFKC'); } catch (_) {}
    for (var index = 0; index < 4; index++) {
      var decoded;
      try { decoded = decodeURIComponent(output.replace(/\+/g, '%20')); }
      catch (_) { return { value: output, unsafe: true }; }
      try { if (typeof decoded.normalize === 'function') decoded = decoded.normalize('NFKC'); } catch (_) {}
      if (decoded === output) break;
      output = decoded;
    }
    return { value: output, unsafe: /[\u0000-\u001f\u007f]/.test(output) || /%[0-9a-f]{2}/i.test(output) };
  }

  function normalizedSensitiveKey(key) {
    var normalizedComponent = normalizedUrlComponent(key);
    if (normalizedComponent.unsafe) return '__unsafe_url_component__';
    return normalizedComponent.value.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function isSensitiveKey(key) {
    return !!SENSITIVE_KEYS[normalizedSensitiveKey(key)];
  }

  function isSensitiveUrlQueryKey(key) {
    var normalized = normalizedSensitiveKey(key);
    if (!normalized) return false;
    if (normalized === '__unsafe_url_component__') return true;
    if (SENSITIVE_KEYS[normalized] || SENSITIVE_URL_QUERY_KEYS[normalized]) return true;
    if (normalized === 'sig' || /^auth(?:key|token|signature|credential)?$/.test(normalized)) return true;
    if (/(?:token|secret|credential|signature|accesskeyid|accesskey|accessid|apikey|authkey|securitytoken|secretkey|consumerkey|signedheaders|password|passwd|sessionid|sessionkey|jwt)$/.test(normalized)) return true;
    if (/^(?:expires|policy|x5sec)$/.test(normalized)) return true;
    var signingMatch = normalized.match(/^(xoss|xamz|oss|amz)(sign|signature|credential|securitytoken|accesskeyid|expires|policy|algorithm|signedheaders)$/);
    return !!signingMatch;
  }

  function hasSensitiveUrlQuery(parsed) {
    return Array.from(parsed.searchParams.entries()).some(function (entry) {
      if (isSensitiveUrlQueryKey(entry[0])) return true;
      var normalizedValue = normalizedUrlComponent(entry[1]);
      if (normalizedValue.unsafe || /\b(?:bearer|basic)\s+\S+/i.test(normalizedValue.value) ||
          /["']?(?:authorization|cookie|tokens?|api[-_ ]?key|access[-_ ]?key|secret|password|credential)["']?\s*[:=]/i.test(normalizedValue.value) ||
          /\bAKIA[0-9A-Z]{12,}\b/.test(normalizedValue.value) ||
          /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(normalizedValue.value)) return true;
      var embedded = normalizedValue.value.split(/[&;]/);
      return embedded.some(function (part) {
        var equalsAt = part.indexOf('=');
        return equalsAt > 0 && isSensitiveUrlQueryKey(part.slice(0, equalsAt).trim());
      });
    });
  }

  function cleanNumber(value, fallback) {
    if (value == null || value === '') return fallback;
    var number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
  }

  function compareCodeUnits(first, second) {
    first = String(first);
    second = String(second);
    return first < second ? -1 : (first > second ? 1 : 0);
  }

  function screenCountValue(value, path) {
    if (value === undefined) return 10;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 5 || value > 16) {
      fail('INVALID_SCREEN_COUNT', '参考成详输出屏数必须是 5–16 的整数 number。', path);
    }
    return value;
  }

  function normalizedLimits(options) {
    var source = isPlainObject(options) && isPlainObject(ownValue(options, 'limits')) ? ownValue(options, 'limits') : options;
    source = isPlainObject(source) ? source : {};
    var output = {};
    Object.keys(DEFAULT_LIMITS).forEach(function (key) {
      var requested = cleanNumber(ownValue(source, key), null);
      var value = requested == null ? DEFAULT_LIMITS[key] : requested;
      output[key] = Math.max(1, Math.min(value, HARD_LIMITS[key]));
    });
    return output;
  }

  function createContext(options) {
    return {
      limits: normalizedLimits(options),
      issues: [],
      issueKeys: Object.create(null),
      nodes: 0,
      seen: typeof WeakSet === 'function' ? new WeakSet() : null
    };
  }

  function addIssue(context, code, message, path, severity) {
    var issue = {
      code: String(code || 'WARNING').slice(0, 80),
      message: String(message || '').slice(0, 1000),
      path: String(path || '$').slice(0, 1000),
      severity: severity === 'error' ? 'error' : 'warning'
    };
    var key = issue.code + '\u0000' + issue.path + '\u0000' + issue.message;
    if (context.issueKeys[key]) return;
    if (context.issues.length >= context.limits.maxWarnings) fail('LIMIT_EXCEEDED', '合同诊断数量超过上限。', '$.warnings');
    context.issueKeys[key] = true;
    context.issues.push(issue);
  }

  function sortedIssues(context) {
    return context.issues.slice().sort(function (a, b) {
      return compareCodeUnits(a.severity, b.severity) || compareCodeUnits(a.code, b.code) ||
        compareCodeUnits(a.path, b.path) || compareCodeUnits(a.message, b.message);
    });
  }

  function textValue(value, path, context, options) {
    options = options || {};
    if (value == null) value = '';
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      fail('INVALID_TEXT', '字段必须是文本或可安全转为文本的原始值。', path);
    }
    var output = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    var max = options.max || context.limits.maxTextLength;
    if (output.length > max) fail('LIMIT_EXCEEDED', '文本长度超过上限 ' + max + '。', path);
    if (options.required && !output) fail('REQUIRED_FIELD', '缺少必填文本。', path);
    return output;
  }

  function idValue(value, path, context, options) {
    options = options || {};
    var output = textValue(value, path, context, { required: options.required, max: options.max || 240 });
    if (!output) return '';
    if (!SAFE_ID.test(output)) fail('INVALID_ID', 'ID 只能包含字母、数字、点、下划线、冒号或短横线。', path);
    return output;
  }

  function enumValue(value, allowed, fallback, path) {
    var output = String(value == null ? '' : value);
    if (allowed.indexOf(output) >= 0) return output;
    if (fallback != null) return fallback;
    fail('INVALID_ENUM', '字段值不属于允许枚举。', path);
  }

  function booleanValue(value, fallback) {
    return value === true ? true : value === false ? false : fallback;
  }

  function positiveIntegerValue(value, path) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      fail('INVALID_REVISION', 'revision 必须是正整数 number。', path);
    }
    return value;
  }

  function nonNegativeIntegerValue(value, path) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      fail('INVALID_INTEGER', '字段必须是非负整数 number。', path);
    }
    return value;
  }

  function timestampValue(value, path, context, fallback) {
    var raw = value == null || value === '' ? fallback : value;
    raw = textValue(raw, path, context, { required: true, max: 80 });
    var parsed = new Date(raw);
    if (!Number.isFinite(parsed.getTime())) fail('INVALID_TIMESTAMP', '时间必须是有效 ISO 日期。', path);
    return parsed.toISOString();
  }

  function arrayValue(value, path, max, required) {
    if (value == null && !required) return [];
    if (!Array.isArray(value)) fail('INVALID_ARRAY', '字段必须是数组。', path);
    if (value.length > max) fail('LIMIT_EXCEEDED', '数组数量超过上限 ' + max + '。', path);
    for (var index = 0; index < value.length; index++) {
      var descriptor = ownDescriptor(value, String(index));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.value === undefined) {
        fail('NON_JSON_VALUE', '合同数组不接受空洞、访问器或 undefined 项。', path + '[' + index + ']');
      }
    }
    return value;
  }

  function arrayEntry(array, index, context, path) {
    var descriptor = ownDescriptor(array, String(index));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      addIssue(context, 'NON_JSON_ACCESSOR_DROPPED', '访问器或空洞数组项不属于普通 JSON，已忽略。', path, 'warning');
      return undefined;
    }
    return descriptor.value;
  }

  function sanitizeJsonValue(value, path, context, depth) {
    context.nodes += 1;
    if (context.nodes > context.limits.maxNodes) fail('LIMIT_EXCEEDED', '普通 JSON 节点数量超过上限。', path);
    if (depth > context.limits.maxDepth) fail('LIMIT_EXCEEDED', '普通 JSON 深度超过上限。', path);
    if (value === null || typeof value === 'boolean') return value;
    if (value === undefined) fail('NON_JSON_VALUE', '普通 JSON 不接受 undefined。', path);
    if (typeof value === 'string') return textValue(value, path, context, { max: context.limits.maxTextLength });
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('NON_JSON_VALUE', '普通 JSON 不接受非有限数字。', path);
      return value;
    }
    if (typeof value !== 'object') fail('NON_JSON_VALUE', '字段只允许普通 JSON 值。', path);
    if (context.seen) {
      if (context.seen.has(value)) fail('CYCLIC_REFERENCE', '普通 JSON 不接受循环或重复对象引用。', path);
      context.seen.add(value);
    }
    if (Array.isArray(value)) {
      var input = arrayValue(value, path, context.limits.maxJsonArrayLength, true);
      var outputArray = [];
      for (var index = 0; index < input.length; index++) {
        var descriptor = ownDescriptor(input, String(index));
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          fail('NON_JSON_VALUE', '普通 JSON 不接受稀疏数组或访问器数组项。', path + '[' + index + ']');
        }
        outputArray.push(sanitizeJsonValue(descriptor.value, path + '[' + index + ']', context, depth + 1));
      }
      return outputArray;
    }
    if (!isPlainObject(value)) fail('NON_JSON_VALUE', '字段只允许普通对象。', path);
    var keys = Object.keys(value).sort(compareCodeUnits);
    if (keys.length > context.limits.maxObjectKeys) fail('LIMIT_EXCEEDED', '对象字段数量超过上限。', path);
    var outputObject = {};
    keys.forEach(function (key) {
      if (DANGEROUS_KEYS[key]) {
        addIssue(context, 'DANGEROUS_KEY_DROPPED', '危险对象键已过滤。', path + '.[FILTERED_KEY]', 'warning');
        return;
      }
      if (isSensitiveKey(key)) {
        addIssue(context, 'SENSITIVE_FIELD_DROPPED', '敏感字段已过滤，未读取或持久化其值。', path + '.[FILTERED_SENSITIVE_FIELD]', 'warning');
        return;
      }
      var descriptor = ownDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        addIssue(context, 'NON_JSON_ACCESSOR_DROPPED', '访问器字段不属于普通 JSON，已忽略。', path + '.' + key, 'warning');
        return;
      }
      outputObject[key] = sanitizeJsonValue(descriptor.value, path + '.' + key, context, depth + 1);
    });
    return outputObject;
  }

  function stableSerializable(value, seen, path) {
    path = path || '$';
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (value === undefined) fail('NON_JSON_VALUE', '稳定序列化不接受 undefined。', path);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('NON_JSON_VALUE', '稳定序列化不接受非有限数字。', path);
      return value;
    }
    if (typeof value !== 'object') fail('NON_JSON_VALUE', '稳定序列化只接受普通 JSON 值。', path);
    seen = seen || (typeof WeakSet === 'function' ? new WeakSet() : null);
    if (seen) {
      if (seen.has(value)) fail('CYCLIC_REFERENCE', '稳定序列化不接受循环或重复对象引用。', path);
      seen.add(value);
    }
    if (Array.isArray(value)) {
      var outputArray = [];
      for (var index = 0; index < value.length; index++) {
        var descriptor = ownDescriptor(value, String(index));
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.value === undefined) {
          fail('NON_JSON_VALUE', '稳定序列化不接受稀疏、访问器或 undefined 数组项。', path + '[' + index + ']');
        }
        outputArray.push(stableSerializable(descriptor.value, seen, path + '[' + index + ']'));
      }
      return outputArray;
    }
    if (!isCrossRealmPlainObject(value)) fail('NON_JSON_VALUE', '稳定序列化只接受普通对象。', path);
    var output = {};
    Object.keys(value).filter(function (key) { return !DANGEROUS_KEYS[key] && !isSensitiveKey(key); })
      .sort(compareCodeUnits).forEach(function (key) {
        var descriptor = ownDescriptor(value, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.value === undefined) {
          fail('NON_JSON_VALUE', '稳定序列化不接受访问器或 undefined 对象字段。', path + '.' + key);
        }
        output[key] = stableSerializable(descriptor.value, seen, path + '.' + key);
      });
    return output;
  }

  function stableSerialize(value) {
    return JSON.stringify(stableSerializable(value));
  }

  function hashHex(value) {
    var raw = typeof value === 'string' ? value : stableSerialize(value);
    var h1 = 0x811c9dc5;
    var h2 = 0x9e3779b9;
    for (var index = 0; index < raw.length; index++) {
      var code = raw.charCodeAt(index);
      h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ (code + index), 0x85ebca6b) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  function stableHash(value, prefix) {
    return (prefix || 'hash_') + hashHex(value);
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

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function createUrlPolicy(input) {
    if (input == null) return DEFAULT_URL_POLICY;
    if (!isPlainObject(input)) fail('INVALID_URL_POLICY', 'URL 策略必须是普通对象。', '$urlPolicy');
    var sourceInput = ownValue(input, 'sourceRules');
    var assetInput = ownValue(input, 'assetHostRules');
    sourceInput = arrayValue(sourceInput, '$urlPolicy.sourceRules', 100, true);
    assetInput = arrayValue(assetInput, '$urlPolicy.assetHostRules', 100, true);
    var sourceRules = sourceInput.map(function (rule, index) {
      if (!isPlainObject(rule)) fail('INVALID_URL_POLICY', '来源 URL 规则必须是普通对象。', '$urlPolicy.sourceRules[' + index + ']');
      var platform = String(ownValue(rule, 'platform') || '').toLowerCase();
      var host = String(ownValue(rule, 'host') || '').toLowerCase().replace(/\.$/, '');
      var paths = arrayValue(ownValue(rule, 'paths'), '$urlPolicy.sourceRules[' + index + '].paths', 20, true)
        .map(function (path) { return String(path || ''); });
      var itemIdParam = String(ownValue(rule, 'itemIdParam') || 'id');
      if (!SAFE_PLATFORM.test(platform) || !/^[a-z0-9.-]+$/.test(host) || !paths.length ||
          paths.some(function (path) { return path[0] !== '/'; }) || !/^[A-Za-z0-9_-]{1,40}$/.test(itemIdParam)) {
        fail('INVALID_URL_POLICY', '来源 URL 规则字段无效。', '$urlPolicy.sourceRules[' + index + ']');
      }
      return { platform: platform, host: host, paths: paths.slice(), itemIdParam: itemIdParam };
    });
    var assetHostRules = assetInput.map(function (rule, index) {
      if (!isPlainObject(rule)) fail('INVALID_URL_POLICY', '素材 URL 规则必须是普通对象。', '$urlPolicy.assetHostRules[' + index + ']');
      var host = String(ownValue(rule, 'host') || '').toLowerCase().replace(/\.$/, '');
      if (!/^[a-z0-9.-]+$/.test(host)) fail('INVALID_URL_POLICY', '素材 host 规则无效。', '$urlPolicy.assetHostRules[' + index + '].host');
      return { host: host, includeSubdomains: ownValue(rule, 'includeSubdomains') === true };
    });
    return deepFreeze({ sourceRules: sourceRules, assetHostRules: assetHostRules });
  }

  function explicitPort(raw) {
    var match = String(raw || '').match(/^https:\/\/([^/?#]+)/i);
    if (!match) return false;
    var authority = match[1].replace(/^.*@/, '');
    return /:\d+$/.test(authority);
  }

  function hostMatches(hostname, rule) {
    return hostname === rule.host || (rule.includeSubdomains && hostname.endsWith('.' + rule.host));
  }

  function validateUrl(value, kind, options) {
    kind = kind === 'source' ? 'source' : 'asset';
    var policyInput = null;
    if (isPlainObject(options) && ownValue(options, 'urlPolicy')) policyInput = ownValue(options, 'urlPolicy');
    else if (isPlainObject(options) && (ownValue(options, 'sourceRules') || ownValue(options, 'assetHostRules'))) policyInput = options;
    var policy;
    try { policy = policyInput ? createUrlPolicy(policyInput) : DEFAULT_URL_POLICY; }
    catch (error) { return { ok: false, code: error.code || 'INVALID_URL_POLICY', reason: error.message }; }
    var raw = typeof value === 'string' ? value.trim() : '';
    var maxLength = isPlainObject(options) && cleanNumber(ownValue(options, 'maxUrlLength'), null) || DEFAULT_LIMITS.maxUrlLength;
    if (!raw || raw.length > maxLength || /[\u0000-\u001f\u007f\\]/.test(raw)) return { ok: false, code: 'INVALID_URL', reason: 'URL 为空、含反斜杠或超过长度上限。' };
    if (!/^https:\/\//i.test(raw) || explicitPort(raw)) return { ok: false, code: 'URL_NOT_ALLOWED', reason: '只允许无显式端口的 HTTPS URL。' };
    var parsed;
    try { parsed = new URL(raw); } catch (_) { return { ok: false, code: 'INVALID_URL', reason: 'URL 无法解析。' }; }
    var hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
      return { ok: false, code: 'URL_NOT_ALLOWED', reason: 'URL 协议、用户信息或端口不被允许。' };
    }
    if (hasSensitiveUrlQuery(parsed)) return { ok: false, code: 'SENSITIVE_URL_QUERY', reason: 'URL 含敏感鉴权或签名 query，禁止持久化。' };
    if (kind === 'source') {
      var platform = isPlainObject(options) ? String(ownValue(options, 'platform') || '') : '';
      var itemId = isPlainObject(options) ? String(ownValue(options, 'itemId') || '') : '';
      var rule = policy.sourceRules.find(function (candidate) {
        return candidate.host === hostname && candidate.paths.indexOf(parsed.pathname) >= 0 && (!platform || candidate.platform === platform);
      });
      if (!rule) return { ok: false, code: 'URL_NOT_ALLOWED', reason: '来源 host/path 不在平台白名单。' };
      var ids = parsed.searchParams.getAll(rule.itemIdParam);
      if (ids.length !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(ids[0]) || (itemId && ids[0] !== itemId)) {
        return { ok: false, code: 'ITEM_ID_MISMATCH', reason: '来源 URL 商品 ID 缺失、重复或不匹配。' };
      }
      var canonical = 'https://' + hostname + parsed.pathname + '?' + encodeURIComponent(rule.itemIdParam) + '=' + encodeURIComponent(ids[0]);
      return { ok: true, url: canonical, platform: rule.platform, itemId: ids[0] };
    }
    if (!policy.assetHostRules.some(function (rule) { return hostMatches(hostname, rule); })) {
      return { ok: false, code: 'URL_NOT_ALLOWED', reason: '素材 host 不在白名单。' };
    }
    parsed.hostname = hostname;
    parsed.hash = '';
    if (parsed.search) {
      var pairs = Array.from(parsed.searchParams.entries()).sort(function (a, b) {
        return compareCodeUnits(a[0], b[0]) || compareCodeUnits(a[1], b[1]);
      });
      parsed.search = '';
      pairs.forEach(function (pair) { parsed.searchParams.append(pair[0], pair[1]); });
    }
    return { ok: true, url: parsed.toString() };
  }

  function sanitizeEndpointPath(value, path, context) {
    var raw = textValue(value, path, context, { max: context.limits.maxShortTextLength });
    if (!raw) return '';
    var normalizedRaw = normalizedUrlComponent(raw);
    if (normalizedRaw.unsafe || normalizedRaw.value.indexOf('\\') >= 0) fail('INVALID_ENDPOINT_PATH', 'endpointPath 不允许原始或编码反斜杠。', path);
    if (/(?:bearer\s+|\btoken\b|access[_-]?token|refresh[_-]?token|authorization|cookie|api[_-]?key|secret|password)/i.test(normalizedRaw.value)) {
      fail('SENSITIVE_ENDPOINT_PATH', 'endpointPath 含可能的凭据正文，禁止持久化。', path);
    }
    if (raw[0] === '/') {
      if (raw.slice(0, 2) === '//' || raw.indexOf('\\') >= 0) {
        fail('INVALID_ENDPOINT_PATH', 'endpointPath 相对路径必须以单斜杠开头，不得是 scheme-relative 或含反斜杠。', path);
      }
      var relativeParsed;
      try { relativeParsed = new URL(raw, 'https://reference-detail.invalid'); }
      catch (_) { fail('INVALID_ENDPOINT_PATH', 'endpointPath 无法解析。', path); }
      if (hasSensitiveUrlQuery(relativeParsed)) fail('SENSITIVE_URL_QUERY', 'endpointPath 含敏感鉴权或签名 query，禁止持久化。', path);
      return relativeParsed.pathname;
    }
    if (!/^https:\/\//i.test(raw) || explicitPort(raw)) fail('INVALID_ENDPOINT_PATH', 'endpointPath 只允许 HTTPS URL 或以 / 开头的路径。', path);
    var parsed;
    try { parsed = new URL(raw); } catch (_) { fail('INVALID_ENDPOINT_PATH', 'endpointPath 无法解析。', path); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
      fail('INVALID_ENDPOINT_PATH', 'endpointPath 不允许用户信息或端口。', path);
    }
    if (hasSensitiveUrlQuery(parsed)) fail('SENSITIVE_URL_QUERY', 'endpointPath 含敏感鉴权或签名 query，禁止持久化。', path);
    return String(parsed.pathname || '/').slice(0, context.limits.maxShortTextLength);
  }

  function sourceIdentity(source) {
    return source.platform + ':' + source.itemId + ':' + source.canonicalUrl;
  }

  function sanitizeSource(input, context, options) {
    if (!isPlainObject(input)) fail('INVALID_SOURCE', 'source 必须是普通对象。', '$.source');
    var platform = textValue(ownValue(input, 'platform', context, '$.source.platform'), '$.source.platform', context, { required: true, max: 32 }).toLowerCase();
    if (!SAFE_PLATFORM.test(platform)) fail('INVALID_PLATFORM', 'platform 标识无效。', '$.source.platform');
    var itemId = textValue(ownValue(input, 'itemId', context, '$.source.itemId'), '$.source.itemId', context, { required: true, max: 128 });
    if ((platform === 'taobao' || platform === 'tmall') && !/^\d{1,30}$/.test(itemId)) {
      fail('INVALID_ITEM_ID', '淘宝/天猫商品 ID 必须是数字字符串。', '$.source.itemId');
    }
    var sourceMode = enumValue(ownValue(input, 'sourceMode', context, '$.source.sourceMode'), SOURCE_MODES, null, '$.source.sourceMode');
    var validatedUrl = validateUrl(ownValue(input, 'canonicalUrl', context, '$.source.canonicalUrl'), 'source', {
      platform: platform,
      itemId: itemId,
      urlPolicy: isPlainObject(options) && ownValue(options, 'urlPolicy') ? ownValue(options, 'urlPolicy') : DEFAULT_URL_POLICY,
      maxUrlLength: context.limits.maxUrlLength
    });
    if (!validatedUrl.ok) fail(validatedUrl.code, validatedUrl.reason, '$.source.canonicalUrl');
    return {
      platform: platform,
      itemId: itemId,
      canonicalUrl: validatedUrl.url,
      capturedAt: timestampValue(ownValue(input, 'capturedAt', context, '$.source.capturedAt'), '$.source.capturedAt', context),
      sourceMode: sourceMode
    };
  }

  function derivedOverallCompleteness(parts) {
    var values = ['source', 'facts', 'orderedBlocks', 'assets', 'evidence'].map(function (key) { return parts[key]; });
    if (values.indexOf('blocked') >= 0) return 'blocked';
    if (values.indexOf('partial') >= 0) return 'partial';
    if (values.indexOf('unknown') >= 0) return 'unknown';
    return 'complete';
  }

  function sanitizeCompleteness(input, context) {
    input = isPlainObject(input) ? input : {};
    var output = {};
    ['source', 'facts', 'orderedBlocks', 'assets', 'evidence'].forEach(function (key) {
      output[key] = enumValue(ownValue(input, key, context, '$.completeness.' + key), COMPLETENESS_STATUSES, 'unknown', '$.completeness.' + key);
    });
    output.overall = derivedOverallCompleteness(output);
    var requestedOverall = ownValue(input, 'overall', context, '$.completeness.overall');
    if (requestedOverall != null && COMPLETENESS_STATUSES.indexOf(String(requestedOverall)) >= 0 && requestedOverall !== output.overall) {
      addIssue(context, 'COMPLETENESS_RECALCULATED', 'overall 已按分项完整度重新计算，不能被“扫描成功”提升。', '$.completeness.overall', 'warning');
    }
    return output;
  }

  function sanitizeInputWarnings(value, context) {
    var list = arrayValue(value, '$.warnings', context.limits.maxWarnings, false);
    list.forEach(function (warning, index) {
      if (!isPlainObject(warning)) return;
      var code = idValue(ownValue(warning, 'code', context, '$.warnings[' + index + '].code') || 'SOURCE_WARNING', '$.warnings[' + index + '].code', context, { max: 80 });
      var message = textValue(ownValue(warning, 'message', context, '$.warnings[' + index + '].message'), '$.warnings[' + index + '].message', context, { max: context.limits.maxShortTextLength });
      var issuePath = textValue(ownValue(warning, 'path', context, '$.warnings[' + index + '].path') || '$', '$.warnings[' + index + '].path', context, { max: context.limits.maxShortTextLength });
      addIssue(context, code, message, issuePath, ownValue(warning, 'severity') === 'error' ? 'error' : 'warning');
    });
  }

  function sanitizeEvidence(value, sourceKey, context) {
    var list = arrayValue(value, '$.evidence', context.limits.maxEvidence, false);
    var output = [];
    var inputIdMap = Object.create(null);
    var outputIds = Object.create(null);
    for (var index = 0; index < list.length; index++) {
      var item = arrayEntry(list, index, context, '$.evidence[' + index + ']');
      if (item === undefined) continue;
      if (!isPlainObject(item)) fail('INVALID_EVIDENCE', 'evidence 项必须是普通对象。', '$.evidence[' + index + ']');
      var kind = enumValue(ownValue(item, 'kind', context, '$.evidence[' + index + '].kind'), EVIDENCE_KINDS, 'unknown', '$.evidence[' + index + '].kind');
      var sourcePath = textValue(ownValue(item, 'sourcePath', context, '$.evidence[' + index + '].sourcePath'), '$.evidence[' + index + '].sourcePath', context, { max: context.limits.maxShortTextLength });
      var endpointPath = sanitizeEndpointPath(ownValue(item, 'endpointPath', context, '$.evidence[' + index + '].endpointPath'), '$.evidence[' + index + '].endpointPath', context);
      var locator = textValue(ownValue(item, 'locator', context, '$.evidence[' + index + '].locator'), '$.evidence[' + index + '].locator', context, { max: context.limits.maxShortTextLength });
      var note = textValue(ownValue(item, 'note', context, '$.evidence[' + index + '].note'), '$.evidence[' + index + '].note', context, { max: context.limits.maxShortTextLength });
      var completeness = enumValue(ownValue(item, 'completeness', context, '$.evidence[' + index + '].completeness'), COMPLETENESS_STATUSES, 'unknown', '$.evidence[' + index + '].completeness');
      var evidenceId = stableHash({ source: sourceKey, index: index, kind: kind, sourcePath: sourcePath, endpointPath: endpointPath, locator: locator }, 'rde_');
      if (outputIds[evidenceId]) fail('DUPLICATE_ID', 'evidence 稳定 ID 冲突。', '$.evidence[' + index + ']');
      outputIds[evidenceId] = true;
      var rawId = textValue(ownValue(item, 'evidenceId', context, '$.evidence[' + index + '].evidenceId'), '$.evidence[' + index + '].evidenceId', context, { max: 240 });
      if (rawId) {
        if (inputIdMap[rawId]) fail('DUPLICATE_INPUT_ID', '输入 evidenceId 重复。', '$.evidence[' + index + '].evidenceId');
        inputIdMap[rawId] = evidenceId;
      }
      inputIdMap[evidenceId] = evidenceId;
      output.push({ evidenceId: evidenceId, kind: kind, sourcePath: sourcePath, endpointPath: endpointPath, locator: locator, note: note, completeness: completeness });
    }
    return { items: output, idMap: inputIdMap };
  }

  function restrictiveRights(first, second) {
    return RIGHTS_RESTRICTIVENESS[first] >= RIGHTS_RESTRICTIVENESS[second] ? first : second;
  }

  function sanitizeAssets(value, sourceKey, context, options, defaultRights) {
    var list = arrayValue(value, '$.assets', context.limits.maxAssets, false);
    var output = [];
    var byUrl = Object.create(null);
    var inputIdMap = Object.create(null);
    for (var index = 0; index < list.length; index++) {
      var item = arrayEntry(list, index, context, '$.assets[' + index + ']');
      if (item === undefined) continue;
      if (!isPlainObject(item)) fail('INVALID_ASSET', 'asset 项必须是普通对象。', '$.assets[' + index + ']');
      var validatedUrl = validateUrl(ownValue(item, 'url', context, '$.assets[' + index + '].url'), 'asset', {
        urlPolicy: isPlainObject(options) && ownValue(options, 'urlPolicy') ? ownValue(options, 'urlPolicy') : DEFAULT_URL_POLICY,
        maxUrlLength: context.limits.maxUrlLength
      });
      if (!validatedUrl.ok) fail(validatedUrl.code, validatedUrl.reason, '$.assets[' + index + '].url');
      var rawId = textValue(ownValue(item, 'assetId', context, '$.assets[' + index + '].assetId'), '$.assets[' + index + '].assetId', context, { max: 240 });
      var role = enumValue(ownValue(item, 'role', context, '$.assets[' + index + '].role'), ASSET_ROLES, 'unknown', '$.assets[' + index + '].role');
      var mediaType = enumValue(ownValue(item, 'mediaType', context, '$.assets[' + index + '].mediaType'), ['image', 'video'], role === 'video' ? 'video' : 'image', '$.assets[' + index + '].mediaType');
      var claimedRights = enumValue(ownValue(item, 'rightsStatus', context, '$.assets[' + index + '].rightsStatus'), RIGHTS_STATUSES, defaultRights, '$.assets[' + index + '].rightsStatus');
      if (claimedRights !== 'reference_only') {
        addIssue(context, 'SOURCE_RIGHTS_DOWNGRADED', '来源页素材不信任采集输入自报授权，已强制归一为 reference_only。', '$.assets[' + index + '].rightsStatus', 'warning');
      }
      var rightsStatus = 'reference_only';
      var existing = byUrl[validatedUrl.url];
      if (existing) {
        if (rawId) {
          if (inputIdMap[rawId] && inputIdMap[rawId] !== existing.assetId) fail('DUPLICATE_INPUT_ID', '输入 assetId 指向多个素材。', '$.assets[' + index + '].assetId');
          inputIdMap[rawId] = existing.assetId;
        }
        addIssue(context, 'DUPLICATE_ASSET', '相同规范 URL 的素材已在 registry 去重；详情出现顺序仍由 orderedBlocks 保留。', '$.assets[' + index + ']', 'warning');
        continue;
      }
      var assetId = stableHash(validatedUrl.url, 'rda_');
      var outputItem = {
        assetId: assetId,
        url: validatedUrl.url,
        mediaType: mediaType,
        role: role,
        originalIndex: cleanNumber(ownValue(item, 'originalIndex', context, '$.assets[' + index + '].originalIndex'), index),
        width: cleanNumber(ownValue(item, 'width', context, '$.assets[' + index + '].width'), null),
        height: cleanNumber(ownValue(item, 'height', context, '$.assets[' + index + '].height'), null),
        altText: textValue(ownValue(item, 'altText', context, '$.assets[' + index + '].altText'), '$.assets[' + index + '].altText', context, { max: context.limits.maxShortTextLength }),
        sourcePath: textValue(ownValue(item, 'sourcePath', context, '$.assets[' + index + '].sourcePath'), '$.assets[' + index + '].sourcePath', context, { max: context.limits.maxShortTextLength }),
        rightsStatus: rightsStatus,
        completeness: enumValue(ownValue(item, 'completeness', context, '$.assets[' + index + '].completeness'), COMPLETENESS_STATUSES, 'unknown', '$.assets[' + index + '].completeness')
      };
      byUrl[validatedUrl.url] = outputItem;
      if (rawId) {
        if (inputIdMap[rawId] && inputIdMap[rawId] !== assetId) fail('DUPLICATE_INPUT_ID', '输入 assetId 重复。', '$.assets[' + index + '].assetId');
        inputIdMap[rawId] = assetId;
      }
      inputIdMap[assetId] = assetId;
      output.push(outputItem);
    }
    return { items: output, idMap: inputIdMap };
  }

  function mappedIdList(value, path, context, idMap) {
    var list = arrayValue(value, path, context.limits.maxRefsPerBlock, false);
    var output = [];
    var seen = Object.create(null);
    for (var index = 0; index < list.length; index++) {
      var raw = arrayEntry(list, index, context, path + '[' + index + ']');
      if (raw === undefined) continue;
      raw = textValue(raw, path + '[' + index + ']', context, { required: true, max: 240 });
      var mapped = idMap[raw];
      if (!mapped) {
        addIssue(context, 'UNKNOWN_REFERENCE_DROPPED', '引用未指向当前快照内的稳定对象，已忽略。', path + '[' + index + ']', 'warning');
        continue;
      }
      if (!seen[mapped]) {
        seen[mapped] = true;
        output.push(mapped);
      }
    }
    return output;
  }

  function pixelInteger(value, path, allowZero) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
      fail('INVALID_ASSET_SLICE', '素材裁切坐标和尺寸必须是安全整数。', path);
    }
    return value;
  }

  function sanitizeAssetSlices(value, path, context, assetMap, assetItems, blockAssetIds) {
    var list = arrayValue(value, path, context.limits.maxRefsPerBlock, false);
    var allowed = Object.create(null);
    blockAssetIds.forEach(function (assetId) { allowed[assetId] = true; });
    var seen = Object.create(null);
    var output = [];
    for (var index = 0; index < list.length; index++) {
      var item = arrayEntry(list, index, context, path + '[' + index + ']');
      if (item === undefined) continue;
      if (!isPlainObject(item)) fail('INVALID_ASSET_SLICE', 'assetSlices 项必须是普通对象。', path + '[' + index + ']');
      var rawAssetId = textValue(ownValue(item, 'assetId', context, path + '[' + index + '].assetId'), path + '[' + index + '].assetId', context, { required: true, max: 240 });
      var assetId = assetMap[rawAssetId];
      if (!assetId || !allowed[assetId]) {
        addIssue(context, 'UNKNOWN_ASSET_SLICE_DROPPED', '裁切引用未指向当前详情块内的素材，已忽略。', path + '[' + index + ']', 'warning');
        continue;
      }
      var asset = assetItems && assetItems[assetId];
      if (!asset || asset.mediaType !== 'image') {
        fail('INVALID_ASSET_SLICE', '只有当前详情块内的图片素材可以声明裁切范围。', path + '[' + index + '].assetId');
      }
      var cropX = pixelInteger(ownValue(item, 'cropX', context, path + '[' + index + '].cropX'), path + '[' + index + '].cropX', true);
      var cropY = pixelInteger(ownValue(item, 'cropY', context, path + '[' + index + '].cropY'), path + '[' + index + '].cropY', true);
      var cropWidth = pixelInteger(ownValue(item, 'cropWidth', context, path + '[' + index + '].cropWidth'), path + '[' + index + '].cropWidth', false);
      var cropHeight = pixelInteger(ownValue(item, 'cropHeight', context, path + '[' + index + '].cropHeight'), path + '[' + index + '].cropHeight', false);
      var sourceWidth = pixelInteger(ownValue(item, 'sourceWidth', context, path + '[' + index + '].sourceWidth'), path + '[' + index + '].sourceWidth', false);
      var sourceHeight = pixelInteger(ownValue(item, 'sourceHeight', context, path + '[' + index + '].sourceHeight'), path + '[' + index + '].sourceHeight', false);
      // Long Tmall detail strips can legitimately exceed 16,384 px while
      // remaining modest in decoded area (for example 750x30,000). Keep a
      // defensive per-axis ceiling for browser decoders, but let the pixel
      // budget be the primary bound for tall source material.
      if (sourceWidth > 8192 || sourceHeight > 65535 || sourceWidth * sourceHeight > 40000000) {
        fail('INVALID_ASSET_SLICE', '素材裁切原图尺寸超过有界上限。', path + '[' + index + ']');
      }
      if ((Number(asset.width) > 0 && Number(asset.width) !== sourceWidth) ||
          (Number(asset.height) > 0 && Number(asset.height) !== sourceHeight)) {
        fail('INVALID_ASSET_SLICE', '素材裁切原图尺寸必须与素材 registry 一致。', path + '[' + index + ']');
      }
      if (cropX + cropWidth > sourceWidth || cropY + cropHeight > sourceHeight) {
        fail('INVALID_ASSET_SLICE', '素材裁切范围不得超出原图边界。', path + '[' + index + ']');
      }
      if (cropX !== 0 || cropWidth !== sourceWidth) {
        fail('INVALID_ASSET_SLICE', '详情长图只允许全宽纵向分片。', path + '[' + index + ']');
      }
      if (cropHeight / cropWidth > 2.001) {
        fail('INVALID_ASSET_SLICE', '单个详情分片高度不得超过分片宽度的 2 倍。', path + '[' + index + ']');
      }
      var signature = [assetId, cropX, cropY, cropWidth, cropHeight, sourceWidth, sourceHeight].join(':');
      if (seen[signature]) continue;
      seen[signature] = true;
      output.push({
        assetId: assetId,
        cropX: cropX, cropY: cropY,
        cropWidth: cropWidth, cropHeight: cropHeight,
        sourceWidth: sourceWidth, sourceHeight: sourceHeight
      });
    }
    return output;
  }

  function sanitizeFacts(value, sourceKey, evidenceMap, context) {
    var list = arrayValue(value, '$.facts', context.limits.maxFacts, false);
    var output = [];
    var inputIdMap = Object.create(null);
    for (var index = 0; index < list.length; index++) {
      var item = arrayEntry(list, index, context, '$.facts[' + index + ']');
      if (item === undefined) continue;
      if (!isPlainObject(item)) fail('INVALID_FACT', 'fact 项必须是普通对象。', '$.facts[' + index + ']');
      var key = textValue(ownValue(item, 'key', context, '$.facts[' + index + '].key'), '$.facts[' + index + '].key', context, { required: true, max: 240 });
      var label = textValue(ownValue(item, 'label', context, '$.facts[' + index + '].label'), '$.facts[' + index + '].label', context, { max: context.limits.maxShortTextLength });
      var category = textValue(ownValue(item, 'category', context, '$.facts[' + index + '].category'), '$.facts[' + index + '].category', context, { max: 120 });
      var unit = textValue(ownValue(item, 'unit', context, '$.facts[' + index + '].unit'), '$.facts[' + index + '].unit', context, { max: 120 });
      var factValue = sanitizeJsonValue(ownValue(item, 'value', context, '$.facts[' + index + '].value'), '$.facts[' + index + '].value', context, 0);
      var factId = stableHash({ source: sourceKey, index: index, key: key, value: factValue, unit: unit }, 'rdf_');
      var rawId = textValue(ownValue(item, 'factId', context, '$.facts[' + index + '].factId'), '$.facts[' + index + '].factId', context, { max: 240 });
      if (rawId) {
        if (inputIdMap[rawId]) fail('DUPLICATE_INPUT_ID', '输入 factId 重复。', '$.facts[' + index + '].factId');
        inputIdMap[rawId] = factId;
      }
      inputIdMap[factId] = factId;
      output.push({
        factId: factId,
        key: key,
        label: label,
        category: category,
        value: factValue,
        unit: unit,
        sourcePath: textValue(ownValue(item, 'sourcePath', context, '$.facts[' + index + '].sourcePath'), '$.facts[' + index + '].sourcePath', context, { max: context.limits.maxShortTextLength }),
        evidenceIds: mappedIdList(ownValue(item, 'evidenceIds', context, '$.facts[' + index + '].evidenceIds'), '$.facts[' + index + '].evidenceIds', context, evidenceMap),
        completeness: enumValue(ownValue(item, 'completeness', context, '$.facts[' + index + '].completeness'), COMPLETENESS_STATUSES, 'unknown', '$.facts[' + index + '].completeness')
      });
    }
    return { items: output, idMap: inputIdMap };
  }

  function sanitizeBlocks(value, sourceKey, maps, context) {
    var list = arrayValue(value, '$.orderedBlocks', context.limits.maxBlocks, false);
    var output = [];
    for (var index = 0; index < list.length; index++) {
      var item = arrayEntry(list, index, context, '$.orderedBlocks[' + index + ']');
      if (item === undefined) continue;
      if (!isPlainObject(item)) fail('INVALID_BLOCK', 'orderedBlocks 项必须是普通对象。', '$.orderedBlocks[' + index + ']');
      var type = enumValue(ownValue(item, 'type', context, '$.orderedBlocks[' + index + '].type'), BLOCK_TYPES, 'unknown', '$.orderedBlocks[' + index + '].type');
      var salesRole = enumValue(ownValue(item, 'salesRole', context, '$.orderedBlocks[' + index + '].salesRole'), SALES_ROLES, 'unknown', '$.orderedBlocks[' + index + '].salesRole');
      var assetIds = mappedIdList(ownValue(item, 'assetIds', context, '$.orderedBlocks[' + index + '].assetIds'), '$.orderedBlocks[' + index + '].assetIds', context, maps.assets);
      var assetSlices = sanitizeAssetSlices(ownValue(item, 'assetSlices', context, '$.orderedBlocks[' + index + '].assetSlices'), '$.orderedBlocks[' + index + '].assetSlices', context, maps.assets, maps.assetItems, assetIds);
      var factIds = mappedIdList(ownValue(item, 'factIds', context, '$.orderedBlocks[' + index + '].factIds'), '$.orderedBlocks[' + index + '].factIds', context, maps.facts);
      var evidenceIds = mappedIdList(ownValue(item, 'evidenceIds', context, '$.orderedBlocks[' + index + '].evidenceIds'), '$.orderedBlocks[' + index + '].evidenceIds', context, maps.evidence);
      var outputBlock = {
        blockId: stableHash({ source: sourceKey, originalIndex: index }, 'rdb_'),
        originalIndex: index,
        type: type,
        salesRole: salesRole,
        sourceSummary: textValue(ownValue(item, 'sourceSummary', context, '$.orderedBlocks[' + index + '].sourceSummary'), '$.orderedBlocks[' + index + '].sourceSummary', context, { max: context.limits.maxShortTextLength }),
        text: textValue(ownValue(item, 'text', context, '$.orderedBlocks[' + index + '].text'), '$.orderedBlocks[' + index + '].text', context, { max: context.limits.maxTextLength }),
        assetIds: assetIds,
        factIds: factIds,
        evidenceIds: evidenceIds,
        completeness: enumValue(ownValue(item, 'completeness', context, '$.orderedBlocks[' + index + '].completeness'), COMPLETENESS_STATUSES, 'unknown', '$.orderedBlocks[' + index + '].completeness')
      };
      // Preserve byte-for-byte canonical compatibility for stored V1 blocks:
      // old snapshots without slice metadata must not acquire an empty key and
      // therefore must retain their historical snapshotId/sourceDigest.
      if (assetSlices.length) outputBlock.assetSlices = assetSlices;
      output.push(outputBlock);
    }
    return output;
  }

  function sanitizeSourceSnapshot(input, options) {
    var context = createContext(options);
    if (!isPlainObject(input)) fail('INVALID_CONTRACT', '来源快照必须是普通对象。', '$');
    var schema = ownValue(input, 'schema', context, '$.schema');
    if (schema === SCREENSHOT_SOURCE_SCHEMA) return sanitizeScreenshotSourceSnapshot(input, options);
    if (schema !== SOURCE_SCHEMA) fail('INVALID_SCHEMA', '来源快照 schema 必须为 ' + SOURCE_SCHEMA + '。', '$.schema');
    if (Number(ownValue(input, 'schemaVersion', context, '$.schemaVersion')) !== SCHEMA_VERSION) fail('INVALID_SCHEMA_VERSION', 'schemaVersion 必须为 1。', '$.schemaVersion');
    var source = sanitizeSource(ownValue(input, 'source', context, '$.source'), context, options);
    var sourceKey = sourceIdentity(source);
    var completeness = sanitizeCompleteness(ownValue(input, 'completeness', context, '$.completeness'), context);
    sanitizeInputWarnings(ownValue(input, 'warnings', context, '$.warnings'), context);
    var evidence = sanitizeEvidence(ownValue(input, 'evidence', context, '$.evidence'), sourceKey, context);
    var rightsInput = ownValue(input, 'rights', context, '$.rights');
    rightsInput = isPlainObject(rightsInput) ? rightsInput : {};
    var claimedDefaultRights = enumValue(ownValue(rightsInput, 'defaultStatus', context, '$.rights.defaultStatus'), RIGHTS_STATUSES, 'reference_only', '$.rights.defaultStatus');
    if (claimedDefaultRights !== 'reference_only') {
      addIssue(context, 'SOURCE_RIGHTS_DOWNGRADED', '来源快照的默认权利不信任输入自报，已强制归一为 reference_only。', '$.rights.defaultStatus', 'warning');
    }
    var defaultRights = 'reference_only';
    var assets = sanitizeAssets(ownValue(input, 'assets', context, '$.assets'), sourceKey, context, options, defaultRights);
    var assetItemsById = Object.create(null);
    assets.items.forEach(function (asset) { assetItemsById[asset.assetId] = asset; });
    var facts = sanitizeFacts(ownValue(input, 'facts', context, '$.facts'), sourceKey, evidence.idMap, context);
    var orderedBlocks = sanitizeBlocks(ownValue(input, 'orderedBlocks', context, '$.orderedBlocks'), sourceKey, {
      assets: assets.idMap,
      assetItems: assetItemsById,
      facts: facts.idMap,
      evidence: evidence.idMap
    }, context);
    var reusableAssetIds = [];
    var restrictedAssetIds = assets.items.map(function (asset) { return asset.assetId; });
    var outputCore = {
      schema: SOURCE_SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      source: source,
      completeness: completeness,
      facts: facts.items,
      orderedBlocks: orderedBlocks,
      assets: assets.items,
      evidence: evidence.items,
      rights: {
        defaultStatus: defaultRights,
        notice: textValue(ownValue(rightsInput, 'notice', context, '$.rights.notice'), '$.rights.notice', context, { max: context.limits.maxShortTextLength }),
        reusableAssetIds: reusableAssetIds,
        restrictedAssetIds: restrictedAssetIds
      },
      warnings: sortedIssues(context)
    };
    var output = Object.assign({ snapshotId: stableHash(outputCore, 'rds_') }, outputCore);
    return deepFreeze(output);
  }

  function validateScreenshotImageUrl(value) {
    var raw = typeof value === 'string' ? value.trim() : '';
    var match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
    if (!match || match[2].length % 4 !== 0) return { ok: false, code: 'INVALID_SCREENSHOT_IMAGE', reason: '参考截图必须为 PNG、JPEG 或 WebP 的 base64 图片。' };
    var encoded = match[2];
    var bytes = encoded.length / 4 * 3 - (/==$/.test(encoded) ? 2 : /=$/.test(encoded) ? 1 : 0);
    if (bytes < 12 || bytes > SCREENSHOT_LIMITS.maxImageBytes) return { ok: false, code: 'SCREENSHOT_IMAGE_TOO_LARGE', reason: '每张参考截图不得超过 6 MiB。' };
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var header = [];
    for (var index = 0; index < Math.min(24, encoded.length); index += 4) {
      var bits = (alphabet.indexOf(encoded[index]) << 18) | (alphabet.indexOf(encoded[index + 1]) << 12) |
        (Math.max(0, alphabet.indexOf(encoded[index + 2])) << 6) | Math.max(0, alphabet.indexOf(encoded[index + 3]));
      header.push((bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255);
    }
    var png = [137, 80, 78, 71, 13, 10, 26, 10].every(function (byte, position) { return header[position] === byte; });
    var jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
    var webp = header[0] === 82 && header[1] === 73 && header[2] === 70 && header[3] === 70 &&
      header[8] === 87 && header[9] === 69 && header[10] === 66 && header[11] === 80;
    if ((match[1] === 'png' && !png) || (match[1] === 'jpeg' && !jpeg) || (match[1] === 'webp' && !webp)) {
      return { ok: false, code: 'SCREENSHOT_FORMAT_MISMATCH', reason: '参考截图内容与图片格式不匹配。' };
    }
    return { ok: true, url: raw, mimeType: 'image/' + match[1], byteLength: bytes };
  }

  function createScreenshotSource(images, options) {
    options = isPlainObject(options) ? options : {};
    var context = createContext(options);
    var list = arrayValue(images, '$images', SCREENSHOT_LIMITS.maxImages, true);
    if (!list.length) fail('SCREENSHOT_IMAGES_REQUIRED', '请添加 1–6 张参考详情截图。', '$images');
    var capturedAt = timestampValue(ownValue(options, 'capturedAt'), '$options.capturedAt', context, new Date().toISOString());
    var totalBytes = 0;
    var records = list.map(function (item, index) {
      var path = '$images[' + index + ']';
      var url = typeof item === 'string' ? item : isPlainObject(item) ? ownValue(item, 'url') || ownValue(item, 'dataUrl') || ownValue(item, 'src') : '';
      var validated = validateScreenshotImageUrl(url);
      if (!validated.ok) fail(validated.code, validated.reason, path);
      totalBytes += validated.byteLength;
      if (totalBytes > SCREENSHOT_LIMITS.maxTotalBytes) fail('SCREENSHOT_PAYLOAD_TOO_LARGE', '参考截图总大小不得超过 24 MiB。', '$images');
      var width = isPlainObject(item) ? ownValue(item, 'width') : null;
      var height = isPlainObject(item) ? ownValue(item, 'height') : null;
      width = width == null ? null : pixelInteger(width, path + '.width', false);
      height = height == null ? null : pixelInteger(height, path + '.height', false);
      if ((width === null) !== (height === null) || width > 8192 || height > 65535 || (width && height && width * height > 40000000)) {
        fail('INVALID_SCREENSHOT_DIMENSIONS', '参考截图尺寸不完整或超过像素上限。', path);
      }
      return { url: validated.url, width: width, height: height };
    });
    var source = { sourceMode: 'screenshots', capturedAt: capturedAt };
    var sourceKey = stableHash({ source: source, images: records }, 'rdscreens_');
    var assets = [];
    var evidence = [];
    var assetById = Object.create(null);
    var blocks = records.map(function (record, index) {
      var assetId = stableHash(record.url, 'rda_');
      var sourcePath = 'screenshots[' + index + ']';
      if (assetById[assetId] && (assetById[assetId].width !== record.width || assetById[assetId].height !== record.height)) {
        fail('SCREENSHOT_DIMENSIONS_MISMATCH', '相同参考截图不得声明不同尺寸。', '$images[' + index + ']');
      }
      if (!assetById[assetId]) {
        var asset = { assetId: assetId, url: record.url, mediaType: 'image', role: 'detail', originalIndex: index,
          width: record.width, height: record.height, altText: '', sourcePath: sourcePath, rightsStatus: 'reference_only', completeness: 'complete' };
        assetById[assetId] = asset;
        assets.push(asset);
      }
      var evidenceId = stableHash({ source: sourceKey, originalIndex: index }, 'rde_');
      evidence.push({ evidenceId: evidenceId, kind: 'user', sourcePath: sourcePath, endpointPath: '', locator: 'ordered-reference-screenshot:' + index, note: '', completeness: 'complete' });
      return { blockId: stableHash({ source: sourceKey, originalIndex: index }, 'rdb_'), originalIndex: index,
        type: 'image', salesRole: 'unknown', sourceSummary: '', text: '', assetIds: [assetId], factIds: [], evidenceIds: [evidenceId], completeness: 'complete' };
    });
    var core = { schema: SCREENSHOT_SOURCE_SCHEMA, schemaVersion: 1, source: source,
      completeness: { source: 'partial', facts: 'unknown', orderedBlocks: 'complete', assets: 'complete', evidence: 'complete', overall: 'partial' },
      facts: [], orderedBlocks: blocks, assets: assets, evidence: evidence,
      rights: { defaultStatus: 'reference_only', notice: '参考截图仅供学习详情结构与视觉表达。', reusableAssetIds: [], restrictedAssetIds: assets.map(function (asset) { return asset.assetId; }) }, warnings: [] };
    return deepFreeze(Object.assign({ snapshotId: stableHash(core, 'rds_') }, core));
  }

  function sanitizeScreenshotSourceSnapshot(input, options) {
    var allowedKeys = ['schema', 'schemaVersion', 'snapshotId', 'source', 'completeness', 'facts', 'orderedBlocks', 'assets', 'evidence', 'rights', 'warnings'];
    if (Object.keys(input).some(function (key) { return allowedKeys.indexOf(key) < 0; })) fail('SCREENSHOT_SOURCE_CONTENT_FORBIDDEN', '截图来源不得夹带商品事实、业务字段或旧参考图别名。', '$');
    if (Number(ownValue(input, 'schemaVersion')) !== 1) fail('INVALID_SCHEMA_VERSION', '截图来源 schemaVersion 必须为 1。', '$.schemaVersion');
    var source = ownValue(input, 'source');
    if (!isPlainObject(source) || ownValue(source, 'sourceMode') !== 'screenshots' ||
        Object.keys(source).some(function (key) { return key !== 'sourceMode' && key !== 'capturedAt'; })) {
      fail('INVALID_SCREENSHOT_SOURCE', '截图学习来源不得声明商品平台、商品 ID 或商品 URL。', '$.source');
    }
    if (ownValue(input, 'images') !== undefined || arrayValue(ownValue(input, 'facts'), '$.facts', 0, true).length) {
      fail('SCREENSHOT_SOURCE_CONTENT_FORBIDDEN', '截图来源不得夹带商品事实或旧参考图别名。', '$');
    }
    var assets = arrayValue(ownValue(input, 'assets'), '$.assets', SCREENSHOT_LIMITS.maxImages, true);
    var blocks = arrayValue(ownValue(input, 'orderedBlocks'), '$.orderedBlocks', SCREENSHOT_LIMITS.maxImages, true);
    var lookup = Object.create(null);
    assets.forEach(function (asset, index) {
      if (!isPlainObject(asset) || !ownValue(asset, 'assetId') || lookup[ownValue(asset, 'assetId')]) fail('INVALID_SCREENSHOT_ASSET', '截图素材身份无效或重复。', '$.assets[' + index + ']');
      lookup[ownValue(asset, 'assetId')] = asset;
    });
    var images = blocks.map(function (block, index) {
      var ids = isPlainObject(block) ? ownValue(block, 'assetIds') : null;
      ids = arrayValue(ids, '$.orderedBlocks[' + index + '].assetIds', 1, true);
      if (ids.length !== 1 || typeof ids[0] !== 'string' || !lookup[ids[0]]) fail('INVALID_SCREENSHOT_BLOCK', '每张参考截图必须有一个有序图像块。', '$.orderedBlocks[' + index + ']');
      var asset = lookup[ids[0]];
      return { url: ownValue(asset, 'url'), width: ownValue(asset, 'width'), height: ownValue(asset, 'height') };
    });
    var canonical = createScreenshotSource(images, { capturedAt: ownValue(source, 'capturedAt') });
    ['source', 'facts', 'orderedBlocks', 'assets', 'evidence', 'rights', 'completeness', 'warnings'].forEach(function (key) {
      if (stableSerialize(ownValue(input, key)) !== stableSerialize(canonical[key])) fail('SCREENSHOT_SOURCE_DERIVATION_MISMATCH', '截图来源内容、顺序或只读权利记录与图片身份不一致。', '$.' + key);
    });
    if (ownValue(input, 'snapshotId') && ownValue(input, 'snapshotId') !== canonical.snapshotId) fail('SOURCE_SNAPSHOT_MISMATCH', '参考截图已变化，请重新学习结构。', '$.snapshotId');
    return canonical;
  }

  function detailSemanticPath(value) {
    var output = String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    try { output = decodeURIComponent(output); } catch (_) {}
    return output.replace(/\\/g, '/');
  }

  function detailPathHasToken(path, tokens) {
    path = detailSemanticPath(path);
    if (!path) return false;
    var normalized = path.replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ');
    var padded = ' ' + normalized + ' ';
    for (var index = 0; index < tokens.length; index++) {
      if (padded.indexOf(' ' + tokens[index] + ' ') >= 0) return true;
    }
    return false;
  }

  function isRejectedDetailSurfacePath(path) {
    path = detailSemanticPath(path);
    if (!path) return false;
    if (/(?:用户评价|商品评价|累计评价|买家秀|问大家|相关推荐|相似商品|猜你喜欢|本店推荐|店铺推荐|看了又看|大家还买|热销推荐|为你推荐|底部工具)/.test(path)) return true;
    return detailPathHasToken(path, [
      'review', 'reviews', 'reviewer', 'comment', 'comments', 'rating', 'feedback',
      'question', 'questions', 'ask', 'qanda', 'qa', 'buyer', 'buyershow',
      'recommend', 'recommended', 'recommendation', 'related', 'similar', 'guess',
      'youmaylike', 'maylike', 'also-buy', 'alsobuy', 'shop-recommend', 'shoprecommend',
      'hot-sale', 'hotsale', 'footer', 'bottom-bar', 'bottombar', 'toolbar', 'tabbar',
      'sidebar', 'floatbar', 'floating', 'navigation', 'nav', 'menu', 'popup', 'modal',
      'drawer', 'promptlab', 'workbench', 'extension-ui', 'sz-workbench',
      'parameter-nav', 'param-nav', 'attribute-nav', 'spec-nav', 'parameter-tab',
      'attribute-tab', 'spec-tab'
    ]);
  }

  function isMainGalleryPath(path) {
    path = detailSemanticPath(path);
    if (!path) return false;
    if (path.indexOf('metadata:') === 0) return true;
    return detailPathHasToken(path, [
      'gallery', 'mainpic', 'main-pic', 'mainpicture', 'main-picture', 'picgallery',
      'preview', 'thumbnail', 'thumbnails', 'carousel', 'sku-gallery', 'skugallery'
    ]);
  }

  function isPositiveDetailPath(path) {
    path = detailSemanticPath(path);
    if (!path) return false;
    if (path.indexOf('detail-dom:') === 0 || path.indexOf('network-detail:') === 0) return true;
    if (path.indexOf('network:') === 0) {
      if (isRejectedDetailSurfacePath(path)) return false;
      return detailPathHasToken(path, ['detail', 'details', 'desc', 'description', 'itemdesc', 'item-detail', 'detail-content']);
    }
    return detailPathHasToken(path, [
      'description', 'j-divitemdesc', 'j-detail', 'detail-content', 'detailcontent',
      'itemdetail', 'item-detail', 'itemdesc'
    ]);
  }

  function isClearlyNonScreenImage(asset) {
    var width = Number(asset && asset.width);
    var height = Number(asset && asset.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 &&
        (width < 96 || height < 72 || width * height < 16384)) return true;
    var hint = detailSemanticPath((asset && asset.url || '') + ' ' + (asset && asset.altText || ''));
    return /(?:^|[\s/_.-])(?:blank|spacer|pixel|1x1|transparent|placeholder|loading|avatar|qrcode|qr-code|sprite)(?:[\s/_.?-]|$)/.test(hint) &&
      (!Number.isFinite(width) || !Number.isFinite(height) || width < 320 || height < 180);
  }

  function classifyDetailImageAsset(asset, block) {
    if (!asset || asset.mediaType !== 'image') return 'not_image';
    if (asset.completeness === 'blocked' || block.completeness === 'blocked') return 'blocked';
    if (DETAIL_IMAGE_ASSET_ROLE_DENY[asset.role]) return asset.role === 'main' ? 'main_gallery' : 'non_detail_role';
    if (isClearlyNonScreenImage(asset)) return 'non_screen_image';
    var path = asset.sourcePath || '';
    if (isRejectedDetailSurfacePath(path)) return 'outside_detail_boundary';
    if (isMainGalleryPath(path)) return 'main_gallery';
    if (isPositiveDetailPath(path)) return '';
    if (detailSemanticPath(path).indexOf('network:') === 0) return 'network_unproven';
    // Legacy V1 snapshots did not mark the detail DOM scope explicitly. Keep a
    // conservative compatibility path only for image assets whose path is not a
    // known main-gallery or semantic boundary surface.
    if (!path || detailSemanticPath(path).indexOf('dom:') === 0) return '';
    return 'scope_unproven';
  }

  function isAnchoredDetailRangePath(path) {
    return detailSemanticPath(path).indexOf(DETAIL_RANGE_PATH_PREFIX) === 0;
  }

  function detailRangeEvidencePathsForBlock(block, evidenceById) {
    var paths = [];
    (block.evidenceIds || []).forEach(function (evidenceId) {
      var evidence = evidenceById[evidenceId];
      if (evidence && evidence.kind === 'dom' && evidence.sourcePath) paths.push(evidence.sourcePath);
    });
    return paths;
  }

  function projectDetailImageSource(input, options) {
    var snapshot = sanitizeSourceSnapshot(input, options);
    if (snapshot.schema === SCREENSHOT_SOURCE_SCHEMA) return deepFreeze({
      ok: true, code: 'SCREENSHOT_SOURCE_READY', snapshot: snapshot,
      report: { boundaryContract: 'ORDERED_REFERENCE_SCREENSHOTS_V1', sourceKind: 'screenshots', detailScreenCount: snapshot.orderedBlocks.length,
        detailImageScreenCount: snapshot.orderedBlocks.length, detailVideoScreenCount: 0, detailTextScreenCount: 0,
        rawBlockCount: snapshot.orderedBlocks.length, rawAssetCount: snapshot.assets.length, filteredBlockCount: 0, filteredAssetCount: 0,
        acceptedBlockIds: snapshot.orderedBlocks.map(function (block) { return block.blockId; }), rejectedBlocks: [] }
    });
    var assetById = Object.create(null);
    var evidenceById = Object.create(null);
    var factById = Object.create(null);
    snapshot.assets.forEach(function (asset) { assetById[asset.assetId] = asset; });
    snapshot.evidence.forEach(function (evidence) { evidenceById[evidence.evidenceId] = evidence; });
    snapshot.facts.forEach(function (fact) { factById[fact.factId] = fact; });
    var accepted = [];
    var rejected = [];
    var keptAssetIds = Object.create(null);
    var keptEvidenceIds = Object.create(null);
    var keptFactIds = Object.create(null);

    snapshot.orderedBlocks.slice().sort(function (first, second) {
      return first.originalIndex - second.originalIndex || compareCodeUnits(first.blockId, second.blockId);
    }).forEach(function (block) {
      // Range membership belongs to this ordered occurrence, not to the
      // URL-deduplicated asset registry.  Requiring block-local DOM evidence
      // both preserves a main-image URL when it visibly repeats in the detail
      // interval and prevents an unrelated block from borrowing an anchored
      // asset sourcePath as proof.
      var proofPaths = detailRangeEvidencePathsForBlock(block, evidenceById);
      if (!proofPaths.some(isAnchoredDetailRangePath)) {
        rejected.push({ blockId: block.blockId, originalIndex: block.originalIndex, reason: 'outside_anchored_detail_range' });
        return;
      }
      var keptBlockAssetIds = [];
      block.assetIds.forEach(function (assetId) {
        var asset = assetById[assetId];
        // The block's anchored DOM evidence proves the occurrence is inside
        // the detail range. The asset registry is URL-deduplicated, so the same
        // image may retain an earlier metadata/main sourcePath even when it is
        // visibly repeated inside the anchored range.
        if (!asset) return;
        if (asset.mediaType === 'image' && isClearlyNonScreenImage(asset)) return;
        keptBlockAssetIds.push(assetId);
      });
      var keptBlockFactIds = block.factIds.filter(function (factId) {
        return !!factById[factId];
      });
      var keptBlockEvidenceIds = block.evidenceIds.filter(function (evidenceId) {
        return !!evidenceById[evidenceId];
      });
      if (!block.text && !keptBlockAssetIds.length && !keptBlockFactIds.length) {
        rejected.push({ blockId: block.blockId, originalIndex: block.originalIndex, reason: 'empty_after_range_sanitization' });
        return;
      }
      keptBlockAssetIds.forEach(function (assetId) { keptAssetIds[assetId] = true; });
      keptBlockFactIds.forEach(function (factId) { keptFactIds[factId] = true; });
      keptBlockEvidenceIds.forEach(function (evidenceId) { keptEvidenceIds[evidenceId] = true; });
      accepted.push({
        block: block,
        assetIds: keptBlockAssetIds,
        factIds: keptBlockFactIds,
        evidenceIds: keptBlockEvidenceIds
      });
    });

    var raw = {
      schema: SOURCE_SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      source: cloneJson(snapshot.source),
      completeness: cloneJson(snapshot.completeness),
      facts: snapshot.facts.filter(function (fact) {
        return !!keptFactIds[fact.factId] || isAnchoredDetailRangePath(fact.sourcePath);
      }).map(cloneJson),
      orderedBlocks: accepted.map(function (entry) {
        var block = cloneJson(entry.block);
        block.assetIds = entry.assetIds.slice();
        block.assetSlices = (block.assetSlices || []).filter(function (slice) {
          return slice && entry.assetIds.indexOf(slice.assetId) >= 0;
        });
        block.factIds = entry.factIds.slice();
        block.evidenceIds = entry.evidenceIds.slice();
        var hasImage = block.assetIds.some(function (assetId) { return assetById[assetId] && assetById[assetId].mediaType === 'image'; });
        var hasVideo = block.assetIds.some(function (assetId) { return assetById[assetId] && assetById[assetId].mediaType === 'video'; });
        if (block.text && block.assetIds.length) block.type = hasImage && !hasVideo ? 'image_text' : 'mixed';
        else if (block.assetIds.length) block.type = hasImage && !hasVideo ? 'image' : (hasVideo && !hasImage ? 'video' : 'mixed');
        else if (block.type === 'image' || block.type === 'image_text' || block.type === 'video' || block.type === 'mixed') block.type = 'text';
        return block;
      }),
      assets: snapshot.assets.filter(function (asset) { return !!keptAssetIds[asset.assetId]; }).map(cloneJson),
      evidence: snapshot.evidence.filter(function (evidence) {
        return !!keptEvidenceIds[evidence.evidenceId] || isAnchoredDetailRangePath(evidence.sourcePath);
      }).map(cloneJson),
      rights: cloneJson(snapshot.rights),
      warnings: cloneJson(snapshot.warnings)
    };
    var projected = sanitizeSourceSnapshot(raw, options);
    var projectedAssetById = Object.create(null);
    projected.assets.forEach(function (asset) { projectedAssetById[asset.assetId] = asset; });
    var detailImageScreenCount = 0;
    var detailVideoScreenCount = 0;
    var detailTextScreenCount = 0;
    projected.orderedBlocks.forEach(function (block) {
      var hasImage = block.assetIds.some(function (assetId) { return projectedAssetById[assetId] && projectedAssetById[assetId].mediaType === 'image'; });
      var hasVideo = block.assetIds.some(function (assetId) { return projectedAssetById[assetId] && projectedAssetById[assetId].mediaType === 'video'; });
      if (hasImage) detailImageScreenCount += 1;
      if (hasVideo) detailVideoScreenCount += 1;
      if (block.text) detailTextScreenCount += 1;
    });
    var report = {
      boundaryContract: 'GRAPHIC_DETAIL_TO_SHOP_RECOMMEND_V1',
      detailScreenCount: projected.orderedBlocks.length,
      detailImageScreenCount: detailImageScreenCount,
      detailVideoScreenCount: detailVideoScreenCount,
      detailTextScreenCount: detailTextScreenCount,
      rawBlockCount: snapshot.orderedBlocks.length,
      rawAssetCount: snapshot.assets.length,
      filteredBlockCount: snapshot.orderedBlocks.length - projected.orderedBlocks.length,
      filteredAssetCount: snapshot.assets.length - projected.assets.length,
      acceptedBlockIds: accepted.map(function (entry) { return entry.block.blockId; }),
      rejectedBlocks: rejected
    };
    return deepFreeze({
      ok: projected.orderedBlocks.length > 0,
      code: projected.orderedBlocks.length > 0 ? 'DETAIL_RANGE_SOURCE_READY' : 'NO_ANCHORED_DETAIL_BLOCKS',
      snapshot: projected,
      report: report
    });
  }

  function classifyDetailImageBlocks(input, options) {
    var projected = projectDetailImageSource(input, options);
    return deepFreeze({ ok: projected.ok, code: projected.code, report: projected.report });
  }

  function riskFlagsForBlock(block, assetById) {
    var flags = [];
    if (block.completeness === 'partial') flags.push('SOURCE_PARTIAL');
    if (block.completeness === 'unknown') flags.push('SOURCE_UNKNOWN');
    if (block.completeness === 'blocked') flags.push('SOURCE_BLOCKED');
    block.assetIds.forEach(function (assetId) {
      var asset = assetById[assetId];
      if (!asset) return;
      if (asset.rightsStatus === 'reference_only') flags.push('REFERENCE_ONLY_ASSET');
      if (asset.rightsStatus === 'unknown') flags.push('UNKNOWN_ASSET_RIGHTS');
      if (asset.rightsStatus === 'blocked') flags.push('BLOCKED_ASSET');
    });
    return Array.from(new Set(flags)).sort(compareCodeUnits);
  }

  function emptyEditableCopy() {
    return { headline: '', body: '', bullets: [], cta: '' };
  }

  function sanitizeEditableCopy(input, path, context) {
    input = isPlainObject(input) ? input : {};
    return {
      headline: textValue(ownValue(input, 'headline', context, path + '.headline'), path + '.headline', context, { max: context.limits.maxShortTextLength }),
      body: textValue(ownValue(input, 'body', context, path + '.body'), path + '.body', context, { max: context.limits.maxTextLength }),
      bullets: arrayValue(ownValue(input, 'bullets', context, path + '.bullets'), path + '.bullets', context.limits.maxCopyBullets, false).map(function (item, index) {
        return textValue(item, path + '.bullets[' + index + ']', context, { max: context.limits.maxShortTextLength });
      }),
      cta: textValue(ownValue(input, 'cta', context, path + '.cta'), path + '.cta', context, { max: context.limits.maxShortTextLength })
    };
  }

  function sanitizeVisualBrief(input, path, context) {
    input = isPlainObject(input) ? input : {};
    return {
      description: textValue(ownValue(input, 'description', context, path + '.description'), path + '.description', context, { max: context.limits.maxTextLength }),
      layout: textValue(ownValue(input, 'layout', context, path + '.layout'), path + '.layout', context, { max: context.limits.maxShortTextLength }),
      mood: textValue(ownValue(input, 'mood', context, path + '.mood'), path + '.mood', context, { max: context.limits.maxShortTextLength }),
      shotType: textValue(ownValue(input, 'shotType', context, path + '.shotType'), path + '.shotType', context, { max: context.limits.maxShortTextLength }),
      subjectPlacement: textValue(ownValue(input, 'subjectPlacement', context, path + '.subjectPlacement'), path + '.subjectPlacement', context, { max: context.limits.maxShortTextLength }),
      background: textValue(ownValue(input, 'background', context, path + '.background'), path + '.background', context, { max: context.limits.maxShortTextLength }),
      lighting: textValue(ownValue(input, 'lighting', context, path + '.lighting'), path + '.lighting', context, { max: context.limits.maxShortTextLength }),
      palette: arrayValue(ownValue(input, 'palette', context, path + '.palette'), path + '.palette', context.limits.maxCopyBullets, false).map(function (item, index) {
        return textValue(item, path + '.palette[' + index + ']', context, { max: context.limits.maxShortTextLength });
      }),
      textZones: arrayValue(ownValue(input, 'textZones', context, path + '.textZones'), path + '.textZones', context.limits.maxCopyBullets, false).map(function (item, index) {
        return textValue(item, path + '.textZones[' + index + ']', context, { max: context.limits.maxShortTextLength });
      }),
      density: textValue(ownValue(input, 'density', context, path + '.density'), path + '.density', context, { max: context.limits.maxShortTextLength }),
      transition: textValue(ownValue(input, 'transition', context, path + '.transition'), path + '.transition', context, { max: context.limits.maxShortTextLength }),
      mustKeep: arrayValue(ownValue(input, 'mustKeep', context, path + '.mustKeep'), path + '.mustKeep', context.limits.maxCopyBullets, false).map(function (item, index) {
        return textValue(item, path + '.mustKeep[' + index + ']', context, { max: context.limits.maxShortTextLength });
      }),
      avoid: arrayValue(ownValue(input, 'avoid', context, path + '.avoid'), path + '.avoid', context.limits.maxCopyBullets, false).map(function (item, index) {
        return textValue(item, path + '.avoid[' + index + ']', context, { max: context.limits.maxShortTextLength });
      })
    };
  }

  function moduleIdentity(blueprintId, sourceBlockIds, derivation) {
    return {
      blueprintId: blueprintId,
      kind: derivation.kind,
      sourceBlockIds: sourceBlockIds.slice(),
      parentModuleIds: derivation.parentModuleIds.slice(),
      createdRevision: derivation.createdRevision,
      operationKey: derivation.operationKey
    };
  }

  function deriveBlueprintModuleId(blueprintId, sourceBlockIds, derivation) {
    return stableHash(moduleIdentity(blueprintId, sourceBlockIds, derivation), 'rdm_');
  }

  function sanitizeModuleDerivation(value, path, context) {
    if (!isPlainObject(value)) fail('INVALID_MODULE_DERIVATION', '模块 derivation 必须是普通对象。', path);
    var kind = enumValue(ownValue(value, 'kind', context, path + '.kind'), MODULE_DERIVATION_KINDS, null, path + '.kind');
    var parentModuleIds = arrayValue(ownValue(value, 'parentModuleIds', context, path + '.parentModuleIds'), path + '.parentModuleIds', context.limits.maxRefsPerBlock, false)
      .map(function (id, index) { return idValue(id, path + '.parentModuleIds[' + index + ']', context, { required: true }); });
    if (new Set(parentModuleIds).size !== parentModuleIds.length) fail('DUPLICATE_ID', '模块派生父 ID 不得重复。', path + '.parentModuleIds');
    var createdRevision = positiveIntegerValue(ownValue(value, 'createdRevision', context, path + '.createdRevision'), path + '.createdRevision');
    var operationKey = idValue(ownValue(value, 'operationKey', context, path + '.operationKey'), path + '.operationKey', context, { required: true, max: 120 });
    if (kind === 'source' && (parentModuleIds.length || createdRevision !== 1)) fail('INVALID_MODULE_DERIVATION', 'source 模块必须出生于 revision 1 且无父模块。', path);
    if (kind === 'duplicate' && parentModuleIds.length !== 1) fail('INVALID_MODULE_DERIVATION', 'duplicate 模块必须且只能有一个父模块。', path + '.parentModuleIds');
    if (kind === 'merge' && parentModuleIds.length < 2) fail('INVALID_MODULE_DERIVATION', 'merge 模块至少需要两个父模块。', path + '.parentModuleIds');
    if (kind === 'split' && parentModuleIds.length !== 1) fail('INVALID_MODULE_DERIVATION', 'split 子模块必须且只能有一个父模块。', path + '.parentModuleIds');
    return { kind: kind, parentModuleIds: parentModuleIds, createdRevision: createdRevision, operationKey: operationKey };
  }

  function sanitizeFactBindings(value, path, context, moduleId) {
    var list = arrayValue(value, path, context.limits.maxRefsPerBlock, false);
    var output = [];
    var ids = Object.create(null);
    list.forEach(function (item, index) {
      if (!isPlainObject(item)) fail('INVALID_FACT_BINDING', 'factBinding 必须是普通对象。', path + '[' + index + ']');
      var sourceFactId = idValue(ownValue(item, 'sourceFactId', context, path + '[' + index + '].sourceFactId'), path + '[' + index + '].sourceFactId', context, { required: true });
      var targetField = textValue(ownValue(item, 'targetField', context, path + '[' + index + '].targetField'), path + '[' + index + '].targetField', context, { max: 240 });
      var expectedId = stableHash({ moduleId: moduleId, sourceFactId: sourceFactId, index: index }, 'rdbind_');
      var bindingId = idValue(ownValue(item, 'bindingId', context, path + '[' + index + '].bindingId'), path + '[' + index + '].bindingId', context) || expectedId;
      if (bindingId !== expectedId) fail('ID_MISMATCH', 'bindingId 与模块的来源事实引用不匹配。', path + '[' + index + '].bindingId');
      if (ids[bindingId]) fail('DUPLICATE_ID', 'factBinding ID 重复。', path + '[' + index + '].bindingId');
      ids[bindingId] = true;
      output.push({ bindingId: bindingId, sourceFactId: sourceFactId, targetField: targetField, required: booleanValue(ownValue(item, 'required'), true) });
    });
    return output;
  }

  function sanitizeAssetSlots(value, path, context, moduleId) {
    var list = arrayValue(value, path, context.limits.maxRefsPerBlock, false);
    var output = [];
    var ids = Object.create(null);
    list.forEach(function (item, index) {
      if (!isPlainObject(item)) fail('INVALID_ASSET_SLOT', 'assetSlot 必须是普通对象。', path + '[' + index + ']');
      var sourceAssetId = idValue(ownValue(item, 'sourceAssetId', context, path + '[' + index + '].sourceAssetId'), path + '[' + index + '].sourceAssetId', context, { required: true });
      var role = enumValue(ownValue(item, 'role', context, path + '[' + index + '].role'), ASSET_ROLES, 'unknown', path + '[' + index + '].role');
      var claimedRights = enumValue(ownValue(item, 'rightsStatus', context, path + '[' + index + '].rightsStatus'), RIGHTS_STATUSES, 'reference_only', path + '[' + index + '].rightsStatus');
      if (claimedRights !== 'reference_only' || ownValue(item, 'directUseAllowed') === true || ownValue(item, 'replacementRequired') === false) {
        fail('SOURCE_DERIVATION_MISMATCH', '蓝图来源槽必须保持 reference_only、禁止直接使用且必须替换。', path + '[' + index + ']');
      }
      var rightsStatus = 'reference_only';
      var expectedId = stableHash({ moduleId: moduleId, sourceAssetId: sourceAssetId, index: index }, 'rdslot_');
      var slotId = idValue(ownValue(item, 'slotId', context, path + '[' + index + '].slotId'), path + '[' + index + '].slotId', context) || expectedId;
      if (slotId !== expectedId) fail('ID_MISMATCH', 'slotId 与模块的来源素材引用不匹配。', path + '[' + index + '].slotId');
      if (ids[slotId]) fail('DUPLICATE_ID', 'assetSlot ID 重复。', path + '[' + index + '].slotId');
      ids[slotId] = true;
      output.push({
        slotId: slotId,
        role: role,
        sourceAssetId: sourceAssetId,
        rightsStatus: rightsStatus,
        directUseAllowed: false,
        replacementRequired: true,
        required: booleanValue(ownValue(item, 'required'), true)
      });
    });
    return output;
  }

  function sanitizeTargetAssetSlots(value, path, context, moduleId) {
    var list = arrayValue(value, path, context.limits.maxRefsPerBlock, false);
    var output = [];
    var ids = Object.create(null);
    list.forEach(function (item, index) {
      if (!isPlainObject(item)) fail('INVALID_TARGET_ASSET_SLOT', 'targetAssetSlot 必须是普通对象。', path + '[' + index + ']');
      var sourceSlotId = idValue(ownValue(item, 'sourceSlotId', context, path + '[' + index + '].sourceSlotId'), path + '[' + index + '].sourceSlotId', context, { required: true });
      var targetAssetId = idValue(ownValue(item, 'targetAssetId', context, path + '[' + index + '].targetAssetId'), path + '[' + index + '].targetAssetId', context, { required: true });
      var rightsStatus = enumValue(ownValue(item, 'rightsStatus', context, path + '[' + index + '].rightsStatus'), ['authorized', 'self_owned'], null, path + '[' + index + '].rightsStatus');
      var rightsEvidenceId = idValue(ownValue(item, 'rightsEvidenceId', context, path + '[' + index + '].rightsEvidenceId'), path + '[' + index + '].rightsEvidenceId', context, { required: true });
      var role = enumValue(ownValue(item, 'role', context, path + '[' + index + '].role'), ASSET_ROLES, 'unknown', path + '[' + index + '].role');
      var expectedId = stableHash({ moduleId: moduleId, sourceSlotId: sourceSlotId, targetAssetId: targetAssetId }, 'rdtarget_');
      var targetSlotId = idValue(ownValue(item, 'targetSlotId', context, path + '[' + index + '].targetSlotId'), path + '[' + index + '].targetSlotId', context) || expectedId;
      if (targetSlotId !== expectedId) fail('ID_MISMATCH', 'targetSlotId 与目标素材绑定不匹配。', path + '[' + index + '].targetSlotId');
      if (ids[targetSlotId]) fail('DUPLICATE_ID', 'targetAssetSlot ID 重复。', path + '[' + index + '].targetSlotId');
      ids[targetSlotId] = true;
      output.push({
        targetSlotId: targetSlotId,
        sourceSlotId: sourceSlotId,
        targetAssetId: targetAssetId,
        role: role,
        rightsStatus: rightsStatus,
        rightsEvidenceId: rightsEvidenceId,
        directUseAllowed: true
      });
    });
    return output.sort(function (a, b) {
      return compareCodeUnits(a.sourceSlotId, b.sourceSlotId) || compareCodeUnits(a.targetAssetId, b.targetAssetId) || compareCodeUnits(a.targetSlotId, b.targetSlotId);
    });
  }

  function copyContent(editableCopy) {
    return [editableCopy.headline, editableCopy.body].concat(editableCopy.bullets || [], [editableCopy.cta])
      .join('\n').replace(/\s+/g, ' ').trim();
  }

  var CORE_DIRECTION_URL = /(?:https?:\/\/|www\.|(?:^|[^a-z0-9.-])(?:[a-z0-9-]+\.)+[a-z]{2,24}(?:[\/?#:]|$|[^a-z0-9-]))/i;
  var CORE_DIRECTION_FORBIDDEN = /(?:竞品|对手商品|同行商品|价格|售价|到手价|券后价|原价|现价|优惠价|折扣|满减|销量|月销|已售|成交量|销售量|评价|评论|好评|买家秀|评分|五星|检测|检验|质检|测试报告|认证|证书|资质|专利|品牌|商标|logo|人物|真人|人像|肖像|模特|明星|代言|\b(?:price|sales?|reviews?|ratings?|tested|testing|certification|certificate|patent|brand|logo|person|people|model|celebrity)\b)/i;
  var CORE_DIRECTION_PRICE_VALUE = /(?:[￥¥$]\s*\d|\d+(?:\.\d+)?\s*(?:元|块钱|人民币|rmb|cny|usd))/i;
  var CORE_DIRECTION_SCREEN_ORDINAL = /第\s*(?:\d{1,4}|[零〇一二两三四五六七八九十百千]{1,8})\s*屏/gi;
  var CORE_DIRECTION_VISUAL_COUNT = /(?:(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千半]+)\s*(?:个|组|张|层|段|步|处|种|类|套|份)\s*(?:(?:清晰|温馨|自然|简洁|高级|现代|完整|连贯|统一|独立|主要|核心|重点|日常|家庭|生活|户外|室内|真实|直观|自家|的)\s*){0,8}(?:画面|镜头|视觉|场景|模块|分屏|层级|信息|重点|核心|方向|内容|方式|氛围|风格|结构|节奏|布局|构图|步骤)|(?:一|1)\s*(?:件|个|只|支|枚|片|袋|包|盒|瓶|罐|套|份|颗|粒|双|对|条|台|箱|杯)\s*(?:(?:清晰|完整|主要|核心|重点|真实|自家|的)\s*){0,6}(?:商品|产品|主体))/gi;
  var CORE_DIRECTION_QUANTIFIED_FACT = /(?:^|[^统])(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万亿半]+)\s*(?:%|％|件|个|只|支|枚|片|袋|包|盒|瓶|罐|套|份|颗|粒|双|对|条|台|箱|杯|毫升|升|克|千克|吨|毫米|厘米|米|公里|英寸|寸|毫秒|秒|分钟|小时|天|月|年|伏|瓦|安|毫安|赫兹|分贝|ml|cl|dl|l|mg|kg|g|mm|cm|km|m|mah|wh|kw|w|v|a|hz|db)(?:\b|(?=[^a-z]))/i;
  var CORE_DIRECTION_GENERIC_TERMS = /(?:参考|自家|本屏|第屏|商品|产品|主体|主图|首屏|详情|页面|画面|镜头|视觉|内容|核心|重点|焦点|主题|方向|卖点|利益点|优势|体验|价值|用途|功能|性能|特性|特点|场景|日常|生活|家庭|户外|室内|使用|操作|细节|结构|层级|节奏|布局|构图|角度|光线|色彩|氛围|质感|风格|信息|说明|步骤|流程|组合|关系|展示|呈现|突出|聚焦|表达|传达|强调|强化|营造|建立|介绍|演示|承接|引导|适用|选择|感受|效果|支持|采用|适合|满足|具备|拥有|包含|提供|用于|带来|实现|清晰|直观|真实|温馨|简洁|高级|现代|自然|舒适|便捷|便携|可信|专业|材质|规格|参数|数量|型号|尺寸|成分|容量|包装|工艺|中的|以及|同时|更加|重复|回扣|show|present|highlight|focus|visual|content|product|scene|detail|benefit|feature|layout|mood|experience|direction|screen|module|and|with|for|the|a|an|of|to|in|on|at|by|from|or|as|is|are)/gi;

  function directionOnlyModule(module) {
    return !copyContent(module.editableCopy || emptyEditableCopy());
  }

  function normalizedComparableText(value) {
    return String(value || '').toLowerCase()
      .replace(/[\s\u3000,，。！？!?\.:：;；、'"“”‘’()（）\[\]【】{}<>《》—_\-|\uff5c]+/g, '');
  }

  function assertRawSingleLineDirection(visualBrief, path, context) {
    if (!isPlainObject(visualBrief)) return;
    var raw = ownValue(visualBrief, 'description', context, path + '.description');
    if (raw != null && /[\r\n\u2028\u2029]/.test(String(raw))) {
      fail('INVALID_CORE_DIRECTION', '每屏核心方向必须是单行单句文本。', path + '.description');
    }
  }

  function coreDirectionFactScanText(direction) {
    return String(direction || '')
      .replace(CORE_DIRECTION_SCREEN_ORDINAL, '')
      .replace(CORE_DIRECTION_VISUAL_COUNT, '');
  }

  function appendComparableFactValues(value, output, depth) {
    if (depth > 8 || value == null || typeof value === 'boolean') return;
    if (typeof value === 'string' || typeof value === 'number') {
      var normalized = normalizedComparableText(value);
      if (normalized) output.push(normalized);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(function (item) { appendComparableFactValues(item, output, depth + 1); });
      return;
    }
    if (!isPlainObject(value)) return;
    Object.keys(value).sort(compareCodeUnits).forEach(function (key) {
      appendComparableFactValues(ownValue(value, key), output, depth + 1);
    });
  }

  function sourceFactNeedles(snapshot) {
    var output = [];
    (snapshot && snapshot.facts || []).forEach(function (fact) {
      var values = [];
      appendComparableFactValues(fact.value, values, 0);
      values.forEach(function (value) {
        if (value.length >= 2 && specificSourceFragment(value)) output.push(value);
        var valueWithUnit = normalizedComparableText(value + String(fact.unit || ''));
        if (valueWithUnit.length >= 2 && specificSourceFragment(valueWithUnit)) output.push(valueWithUnit);
      });
    });
    return Array.from(new Set(output)).sort(compareCodeUnits);
  }

  function specificSourceFragment(value) {
    var remaining = String(value || '').replace(CORE_DIRECTION_GENERIC_TERMS, '')
      .replace(/[的与和及在中内为以于并将从把让更又可能对由或向前后上下作]/g, '');
    return remaining.length >= 2;
  }

  function directionContainsSourceFragment(normalizedDirection, sourceCopy) {
    var clauses = String(sourceCopy || '').split(/[\s　,，。！？!?：:;；、|]+/);
    for (var clauseIndex = 0; clauseIndex < clauses.length; clauseIndex++) {
      var clause = normalizedComparableText(clauses[clauseIndex]);
      if (!clause) continue;
      if (clause.length >= 2 && normalizedDirection.indexOf(clause) >= 0 && specificSourceFragment(clause)) return true;
      if (clause.length < 4) continue;
      for (var directionIndex = 0; directionIndex + 4 <= normalizedDirection.length; directionIndex++) {
        var fragment = normalizedDirection.slice(directionIndex, directionIndex + 4);
        if (specificSourceFragment(fragment) && clause.indexOf(fragment) >= 0) return true;
      }
    }
    return false;
  }

  function assertSafeCoreDirection(module, path, snapshot) {
    var direction = String(module.visualBrief && module.visualBrief.description || '').trim();
    if (!direction) {
      fail('CORE_DIRECTION_REQUIRED', 'editableCopy 全空时，必须填写一句本屏核心描述方向。', path + '.visualBrief.description');
    }
    if (direction.length > 160 || /[\r\n\u2028\u2029]/.test(direction)) {
      fail('INVALID_CORE_DIRECTION', '每屏核心方向必须为 1–160 字的单行单句文本。', path + '.visualBrief.description');
    }
    if (CORE_DIRECTION_URL.test(direction) || CORE_DIRECTION_FORBIDDEN.test(direction) || CORE_DIRECTION_PRICE_VALUE.test(direction)) {
      fail('UNSAFE_CORE_DIRECTION', '每屏核心方向不得包含 URL、竞品、价格、销量、评价、检测认证、品牌 Logo 或人物信息。', path + '.visualBrief.description');
    }
    var withoutTerminal = direction.replace(/[。！？!?；;\.]+$/g, '');
    if (/[。！？!?；;\.]/.test(withoutTerminal)) {
      fail('INVALID_CORE_DIRECTION', '每屏核心方向必须为 1–160 字的单行单句文本。', path + '.visualBrief.description');
    }
    var normalizedDirection = normalizedComparableText(direction);
    [module.sourceSummary, module.sourceCopy].forEach(function (sourceText) {
      var normalizedSource = normalizedComparableText(sourceText);
      if (normalizedSource && (normalizedDirection === normalizedSource || normalizedDirection.indexOf(normalizedSource) >= 0)) {
        fail('COPY_REWRITE_REQUIRED', '每屏核心方向不得等同或包含来源摘要、原文。', path + '.visualBrief.description');
      }
    });
    var factScanText = coreDirectionFactScanText(direction);
    var normalizedFactScanText = normalizedComparableText(factScanText);
    if (CORE_DIRECTION_QUANTIFIED_FACT.test(factScanText) || sourceFactNeedles(snapshot).some(function (needle) {
      return normalizedFactScanText.indexOf(needle) >= 0;
    }) || directionContainsSourceFragment(normalizedFactScanText, module.sourceCopy)) {
      fail('HARD_CODED_CORE_FACT', '每屏核心方向只能描述传播意图；数量、规格、品牌、认证等具体事实必须由各目标事实卡注入，不得写死来源或某一张卡的事实。', path + '.visualBrief.description');
    }
    return direction;
  }

  function assertUniqueSelectedCoreDirections(blueprint) {
    var owners = Object.create(null);
    blueprint.modules.forEach(function (module, moduleIndex) {
      if (!module.selected || !directionOnlyModule(module)) return;
      var path = '$.modules[' + moduleIndex + ']';
      var comparable = normalizedComparableText(module.visualBrief && module.visualBrief.description);
      if (!comparable) return;
      if (owners[comparable] != null) {
        fail('SCREEN_DIRECTION_DUPLICATE', '每个最终分屏必须有独立的一句话定位，不得与其他屏重复。', path + '.visualBrief.description');
      }
      owners[comparable] = moduleIndex;
    });
  }

  function hasReusableTargetAsset(assetRegistry) {
    return Object.keys(assetRegistry).some(function (assetId) {
      var asset = assetRegistry[assetId];
      return asset.rightsStatus === 'authorized' || asset.rightsStatus === 'self_owned';
    });
  }

  function sourceSecurityRiskFlags(assetSlots, sourceCopy, editableCopy) {
    var flags = [];
    (assetSlots || []).forEach(function (slot) {
      if (slot.rightsStatus === 'reference_only') flags.push('REFERENCE_ONLY_ASSET');
      if (slot.rightsStatus === 'unknown') flags.push('UNKNOWN_ASSET_RIGHTS');
      if (slot.rightsStatus === 'blocked') flags.push('BLOCKED_ASSET');
    });
    var normalizedSource = String(sourceCopy || '').replace(/\s+/g, ' ').trim();
    var normalizedTarget = copyContent(editableCopy || emptyEditableCopy());
    if (normalizedSource && (!normalizedTarget || normalizedTarget === normalizedSource)) flags.push('COPY_REWRITE_REQUIRED');
    return Array.from(new Set(flags)).sort(compareCodeUnits);
  }

  function sanitizeModule(item, index, context, blueprintId, approvalStatus) {
    var path = '$.modules[' + index + ']';
    if (!isPlainObject(item)) fail('INVALID_MODULE', '蓝图模块必须是普通对象。', path);
    var rawModuleId = ownValue(item, 'moduleId', context, path + '.moduleId');
    var rawBlockAlias = ownValue(item, 'blockId', context, path + '.blockId');
    var moduleId = idValue(rawModuleId == null ? rawBlockAlias : rawModuleId, path + '.moduleId', context, { required: true });
    if (rawBlockAlias != null && idValue(rawBlockAlias, path + '.blockId', context, { required: true }) !== moduleId) {
      fail('ID_MISMATCH', '兼容 blockId 必须与 moduleId 一致。', path + '.blockId');
    }
    var sourceBlockIds = arrayValue(ownValue(item, 'sourceBlockIds', context, path + '.sourceBlockIds'), path + '.sourceBlockIds', context.limits.maxRefsPerBlock, true)
      .map(function (id, sourceIndex) { return idValue(id, path + '.sourceBlockIds[' + sourceIndex + ']', context, { required: true }); });
    if (!sourceBlockIds.length) fail('REQUIRED_FIELD', '模块 sourceBlockIds 不得为空。', path + '.sourceBlockIds');
    if (new Set(sourceBlockIds).size !== sourceBlockIds.length) fail('DUPLICATE_ID', 'sourceBlockIds 不得重复。', path + '.sourceBlockIds');
    var derivation = sanitizeModuleDerivation(ownValue(item, 'derivation', context, path + '.derivation'), path + '.derivation', context);
    var expectedModuleId = deriveBlueprintModuleId(blueprintId, sourceBlockIds, derivation);
    if (moduleId !== expectedModuleId) fail('ID_MISMATCH', 'moduleId 与模块派生载荷不匹配。', path + '.moduleId');
    var sourceBlockId = idValue(ownValue(item, 'sourceBlockId', context, path + '.sourceBlockId'), path + '.sourceBlockId', context);
    var expectedLegacySource = sourceBlockIds.length === 1 ? sourceBlockIds[0] : '';
    if (sourceBlockId && sourceBlockId !== expectedLegacySource) fail('SOURCE_DERIVATION_MISMATCH', 'sourceBlockId 兼容字段与 sourceBlockIds 不一致。', path + '.sourceBlockId');
    var riskFlags = arrayValue(ownValue(item, 'riskFlags', context, path + '.riskFlags'), path + '.riskFlags', context.limits.maxRiskFlags, false)
      .map(function (flag, flagIndex) {
        flag = textValue(flag, path + '.riskFlags[' + flagIndex + ']', context, { required: true, max: 80 });
        if (!SAFE_RISK_FLAG.test(flag)) fail('INVALID_RISK_FLAG', 'riskFlag 必须是大写下划线标识。', path + '.riskFlags[' + flagIndex + ']');
        return flag;
      });
    var editableCopy = sanitizeEditableCopy(ownValue(item, 'editableCopy', context, path + '.editableCopy'), path + '.editableCopy', context);
    var visualBriefInput = ownValue(item, 'visualBrief', context, path + '.visualBrief');
    if (approvalStatus === 'approved' && !copyContent(editableCopy)) {
      assertRawSingleLineDirection(visualBriefInput, path + '.visualBrief', context);
    }
    var sourceCopy = textValue(ownValue(item, 'sourceCopy', context, path + '.sourceCopy'), path + '.sourceCopy', context, { max: context.limits.maxTextLength });
    var assetSlots = sanitizeAssetSlots(ownValue(item, 'assetSlots', context, path + '.assetSlots'), path + '.assetSlots', context, moduleId);
    var targetAssetSlots = sanitizeTargetAssetSlots(ownValue(item, 'targetAssetSlots', context, path + '.targetAssetSlots'), path + '.targetAssetSlots', context, moduleId);
    var sourceSlotIds = Object.create(null);
    assetSlots.forEach(function (slot) { sourceSlotIds[slot.slotId] = true; });
    targetAssetSlots.forEach(function (slot, slotIndex) {
      if (!sourceSlotIds[slot.sourceSlotId]) fail('UNKNOWN_SOURCE_SLOT', '目标素材槽必须关联当前模块的来源槽。', path + '.targetAssetSlots[' + slotIndex + '].sourceSlotId');
    });
    return {
      moduleId: moduleId,
      blockId: moduleId,
      sourceBlockIds: sourceBlockIds,
      sourceBlockId: expectedLegacySource,
      derivation: derivation,
      originalIndex: nonNegativeIntegerValue(ownValue(item, 'originalIndex', context, path + '.originalIndex'), path + '.originalIndex'),
      order: nonNegativeIntegerValue(ownValue(item, 'order', context, path + '.order'), path + '.order'),
      type: enumValue(ownValue(item, 'type', context, path + '.type'), BLOCK_TYPES, 'unknown', path + '.type'),
      salesRole: enumValue(ownValue(item, 'salesRole', context, path + '.salesRole'), SALES_ROLES, 'unknown', path + '.salesRole'),
      sourceSummary: textValue(ownValue(item, 'sourceSummary', context, path + '.sourceSummary'), path + '.sourceSummary', context, { max: context.limits.maxShortTextLength }),
      sourceCopy: sourceCopy,
      editableCopy: editableCopy,
      visualBrief: sanitizeVisualBrief(visualBriefInput, path + '.visualBrief', context),
      factBindings: sanitizeFactBindings(ownValue(item, 'factBindings', context, path + '.factBindings'), path + '.factBindings', context, moduleId),
      assetSlots: assetSlots,
      targetAssetSlots: targetAssetSlots,
      selected: booleanValue(ownValue(item, 'selected'), true),
      locked: booleanValue(ownValue(item, 'locked'), false),
      riskFlags: Array.from(new Set(riskFlags)).sort(compareCodeUnits)
    };
  }

  function sanitizeBlueprintApproval(input, approvalStatus, context) {
    input = isPlainObject(input) ? input : {};
    if (approvalStatus !== 'approved') {
      return { approvedAt: '', verificationId: '', productFactCardIds: [] };
    }
    var approvedAt = timestampValue(ownValue(input, 'approvedAt', context, '$.approval.approvedAt'), '$.approval.approvedAt', context);
    var verificationId = idValue(ownValue(input, 'verificationId', context, '$.approval.verificationId'), '$.approval.verificationId', context, { required: true });
    var cards = arrayValue(ownValue(input, 'productFactCardIds', context, '$.approval.productFactCardIds'), '$.approval.productFactCardIds', context.limits.maxBatchTasks, true)
      .map(function (id, index) { return idValue(id, '$.approval.productFactCardIds[' + index + ']', context, { required: true }); });
    cards = Array.from(new Set(cards)).sort(compareCodeUnits);
    if (!cards.length) fail('FACT_CARD_REQUIRED', '审核通过的蓝图必须绑定至少一个经核验的目标事实卡。', '$.approval.productFactCardIds');
    return { approvedAt: approvedAt, verificationId: verificationId, productFactCardIds: cards };
  }

  function sanitizeBlueprint(input, options) {
    var context = createContext(options);
    if (!isPlainObject(input)) fail('INVALID_CONTRACT', '蓝图必须是普通对象。', '$');
    if (ownValue(input, 'schema', context, '$.schema') !== BLUEPRINT_SCHEMA) fail('INVALID_SCHEMA', '蓝图 schema 无效。', '$.schema');
    if (Number(ownValue(input, 'schemaVersion', context, '$.schemaVersion')) !== SCHEMA_VERSION) fail('INVALID_SCHEMA_VERSION', 'schemaVersion 必须为 1。', '$.schemaVersion');
    var sourceSnapshotId = idValue(ownValue(input, 'sourceSnapshotId', context, '$.sourceSnapshotId'), '$.sourceSnapshotId', context, { required: true });
    var blueprintId = idValue(ownValue(input, 'blueprintId', context, '$.blueprintId'), '$.blueprintId', context) || stableHash(sourceSnapshotId, 'rdp_');
    var revision = positiveIntegerValue(ownValue(input, 'revision', context, '$.revision'), '$.revision');
    var expectedBlueprintId = stableHash(sourceSnapshotId, 'rdp_');
    if (blueprintId !== expectedBlueprintId) fail('ID_MISMATCH', 'blueprintId 与 sourceSnapshotId 的稳定身份不匹配。', '$.blueprintId');
    var createdAt = timestampValue(ownValue(input, 'createdAt', context, '$.createdAt'), '$.createdAt', context);
    var updatedAt = timestampValue(ownValue(input, 'updatedAt', context, '$.updatedAt'), '$.updatedAt', context, createdAt);
    var approvalStatus = enumValue(ownValue(input, 'approvalStatus', context, '$.approvalStatus'), BLUEPRINT_APPROVAL_STATUSES, 'draft', '$.approvalStatus');
    var modulesInput = arrayValue(ownValue(input, 'modules', context, '$.modules'), '$.modules', context.limits.maxBlocks, true);
    var modules = [];
    var blockIds = Object.create(null);
    modulesInput.forEach(function (item, index) {
      var module = sanitizeModule(item, index, context, blueprintId, approvalStatus);
      if (blockIds[module.moduleId]) fail('DUPLICATE_ID', '蓝图 moduleId 重复。', '$.modules[' + index + '].moduleId');
      if (module.order >= modulesInput.length || modules.some(function (candidate) { return candidate.order === module.order; })) {
        fail('INVALID_MODULE_ORDER', '模块 order 必须是 0..n-1 的唯一整数。', '$.modules[' + index + '].order');
      }
      blockIds[module.moduleId] = true;
      modules.push(module);
    });
    if (!modules.length) fail('REQUIRED_FIELD', '蓝图至少需要一个模块。', '$.modules');
    modules.sort(function (a, b) { return a.order - b.order; });
    sanitizeInputWarnings(ownValue(input, 'warnings', context, '$.warnings'), context);
    var approval = sanitizeBlueprintApproval(ownValue(input, 'approval', context, '$.approval'), approvalStatus, context);
    return deepFreeze({
      schema: BLUEPRINT_SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      blueprintId: blueprintId,
      sourceSnapshotId: sourceSnapshotId,
      revision: revision,
      approvalStatus: approvalStatus,
      approval: approval,
      createdAt: createdAt,
      updatedAt: updatedAt,
      modules: modules,
      warnings: sortedIssues(context)
    });
  }

  function snapshotLookup(snapshot) {
    var blocks = Object.create(null);
    var assets = Object.create(null);
    snapshot.orderedBlocks.forEach(function (block) { blocks[block.blockId] = block; });
    snapshot.assets.forEach(function (asset) { assets[asset.assetId] = asset; });
    return { blocks: blocks, assets: assets };
  }

  function canonicalSourceBlockIds(sourceBlockIds, snapshot, path) {
    var lookup = snapshotLookup(snapshot).blocks;
    var seen = Object.create(null);
    var output = sourceBlockIds.map(function (sourceBlockId, index) {
      if (!lookup[sourceBlockId]) fail('UNKNOWN_SOURCE_BLOCK', 'sourceBlockIds 引用了不存在的来源块。', path + '[' + index + ']');
      if (seen[sourceBlockId]) fail('DUPLICATE_ID', 'sourceBlockIds 不得重复。', path + '[' + index + ']');
      seen[sourceBlockId] = true;
      return sourceBlockId;
    });
    return output.sort(function (a, b) {
      return lookup[a].originalIndex - lookup[b].originalIndex || compareCodeUnits(a, b);
    });
  }

  function targetFieldMap(module) {
    var output = Object.create(null);
    (module && module.factBindings || []).forEach(function (binding) { output[binding.sourceFactId] = binding.targetField || ''; });
    return output;
  }

  function deriveModuleSourceBundle(snapshot, moduleId, sourceBlockIds, editableCopy) {
    var lookup = snapshotLookup(snapshot);
    var summaries = [];
    var copies = [];
    var factIds = [];
    var assetIds = [];
    var factSeen = Object.create(null);
    var assetSeen = Object.create(null);
    var riskFlags = [];
    sourceBlockIds.forEach(function (sourceBlockId) {
      var block = lookup.blocks[sourceBlockId];
      var summary = block.sourceSummary || block.text.slice(0, 240) || (block.assetIds.length ? ('素材模块（' + block.assetIds.length + ' 项）') : '未识别模块');
      if (summary && summaries.indexOf(summary) < 0) summaries.push(summary);
      if (block.text) copies.push(block.text);
      block.factIds.forEach(function (factId) {
        if (!factSeen[factId]) { factSeen[factId] = true; factIds.push(factId); }
      });
      block.assetIds.forEach(function (assetId) {
        if (!assetSeen[assetId]) { assetSeen[assetId] = true; assetIds.push(assetId); }
      });
      riskFlags = riskFlags.concat(riskFlagsForBlock(block, lookup.assets));
    });
    var sourceSummary = summaries.join(' | ');
    var sourceCopy = copies.join(' ');
    var assetSlots = assetIds.map(function (assetId, index) {
      var asset = lookup.assets[assetId];
      return {
        slotId: stableHash({ moduleId: moduleId, sourceAssetId: assetId, index: index }, 'rdslot_'),
        role: asset ? asset.role : 'unknown',
        sourceAssetId: assetId,
        rightsStatus: 'reference_only',
        directUseAllowed: false,
        replacementRequired: true,
        required: true
      };
    });
    riskFlags = riskFlags.concat(sourceSecurityRiskFlags(assetSlots, sourceCopy, editableCopy || emptyEditableCopy()));
    return {
      sourceSummary: sourceSummary,
      sourceCopy: sourceCopy,
      originalIndex: lookup.blocks[sourceBlockIds[0]].originalIndex,
      factIds: factIds,
      assetSlots: assetSlots,
      riskFlags: Array.from(new Set(riskFlags)).sort(compareCodeUnits)
    };
  }

  function buildDerivedModule(snapshot, blueprintId, sourceBlockIds, derivation, seed) {
    seed = isPlainObject(seed) ? seed : {};
    sourceBlockIds = canonicalSourceBlockIds(sourceBlockIds, snapshot, '$derived.sourceBlockIds');
    var moduleId = deriveBlueprintModuleId(blueprintId, sourceBlockIds, derivation);
    var editableCopy = ownValue(seed, 'editableCopy') || emptyEditableCopy();
    var bundle = deriveModuleSourceBundle(snapshot, moduleId, sourceBlockIds, editableCopy);
    var fields = ownValue(seed, 'targetFieldByFact') || targetFieldMap(seed);
    var firstBlock = snapshotLookup(snapshot).blocks[sourceBlockIds[0]];
    return {
      moduleId: moduleId,
      blockId: moduleId,
      sourceBlockIds: sourceBlockIds,
      sourceBlockId: sourceBlockIds.length === 1 ? sourceBlockIds[0] : '',
      derivation: cloneJson(derivation),
      originalIndex: bundle.originalIndex,
      order: ownValue(seed, 'order') == null ? 0 : ownValue(seed, 'order'),
      type: ownValue(seed, 'type') || (sourceBlockIds.length === 1 ? firstBlock.type : 'mixed'),
      salesRole: ownValue(seed, 'salesRole') || (sourceBlockIds.length === 1 ? firstBlock.salesRole : 'unknown'),
      sourceSummary: bundle.sourceSummary,
      sourceCopy: bundle.sourceCopy,
      editableCopy: cloneJson(editableCopy),
      visualBrief: cloneJson(ownValue(seed, 'visualBrief') || { description: bundle.sourceSummary, layout: '', mood: '', mustKeep: [], avoid: [] }),
      factBindings: bundle.factIds.map(function (factId, index) {
        return {
          bindingId: stableHash({ moduleId: moduleId, sourceFactId: factId, index: index }, 'rdbind_'),
          sourceFactId: factId,
          targetField: fields[factId] || '',
          required: true
        };
      }),
      assetSlots: bundle.assetSlots,
      targetAssetSlots: [],
      selected: ownValue(seed, 'selected') === false ? false : true,
      locked: ownValue(seed, 'locked') === true,
      riskFlags: bundle.riskFlags
    };
  }

  function mergeSeedFromParents(parents) {
    var mergedTargetFields = Object.create(null);
    var conflictingFacts = Object.create(null);
    parents.forEach(function (parent) {
      parent.factBindings.forEach(function (binding) {
        if (!binding.targetField) return;
        if (mergedTargetFields[binding.sourceFactId] && mergedTargetFields[binding.sourceFactId] !== binding.targetField) {
          conflictingFacts[binding.sourceFactId] = true;
        } else {
          mergedTargetFields[binding.sourceFactId] = binding.targetField;
        }
      });
    });
    Object.keys(conflictingFacts).forEach(function (factId) { mergedTargetFields[factId] = ''; });
    return {
      editableCopy: emptyEditableCopy(),
      visualBrief: null,
      type: 'mixed',
      salesRole: 'unknown',
      selected: parents.some(function (parent) { return parent.selected; }),
      locked: false,
      targetFieldByFact: mergedTargetFields
    };
  }

  function createBlueprintFromSnapshot(snapshotInput, options) {
    options = isPlainObject(options) ? options : {};
    var snapshot = sanitizeSourceSnapshot(snapshotInput, options);
    var createdAt = timestampValue(ownValue(options, 'createdAt'), '$options.createdAt', createContext(options), snapshot.source.capturedAt);
    var requestedApprovalStatus = ownValue(options, 'approvalStatus');
    if (requestedApprovalStatus != null && requestedApprovalStatus !== 'draft') {
      fail('APPROVAL_REQUIRES_TRUSTED_TRANSITION', '首次蓝图只能是 draft；审核必须调用显式可信迁移。', '$options.approvalStatus');
    }
    var raw = {
      schema: BLUEPRINT_SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      blueprintId: stableHash(snapshot.snapshotId, 'rdp_'),
      sourceSnapshotId: snapshot.snapshotId,
      revision: 1,
      approvalStatus: 'draft',
      approval: { approvedAt: '', verificationId: '', productFactCardIds: [] },
      createdAt: createdAt,
      updatedAt: createdAt,
      modules: snapshot.orderedBlocks.map(function (block, index) {
        return buildDerivedModule(snapshot, stableHash(snapshot.snapshotId, 'rdp_'), [block.blockId], {
          kind: 'source', parentModuleIds: [], createdRevision: 1, operationKey: 'source_' + index
        }, {
          order: index,
          type: block.type,
          salesRole: block.salesRole,
          selected: block.completeness !== 'blocked'
        });
      })
    };
    return sanitizeBlueprint(raw, options);
  }

  function reviseBlueprint(blueprintInput, changes, options) {
    changes = isPlainObject(changes) ? changes : {};
    options = isPlainObject(options) ? options : {};
    var sourceSnapshotInput = ownValue(options, 'sourceSnapshot');
    if (!sourceSnapshotInput) fail('SOURCE_SNAPSHOT_REQUIRED', '修订蓝图必须提供可信不可变来源快照。', '$options.sourceSnapshot');
    var checked = assertBlueprintAgainstSource(blueprintInput, sourceSnapshotInput, options);
    var blueprint = checked.blueprint;
    var snapshot = checked.snapshot;
    var raw = cloneJson(blueprint);
    var edits = arrayValue(ownValue(changes, 'moduleEdits'), '$changes.moduleEdits', normalizedLimits(options).maxBlocks, false);
    var byId = Object.create(null);
    raw.modules.forEach(function (module) { byId[module.moduleId] = module; });
    var seenEdits = Object.create(null);
    edits.forEach(function (edit, index) {
      if (!isPlainObject(edit)) fail('INVALID_MODULE_EDIT', 'moduleEdit 必须是普通对象。', '$changes.moduleEdits[' + index + ']');
      var moduleId = String(ownValue(edit, 'moduleId') || ownValue(edit, 'blockId') || '');
      if (!byId[moduleId] || seenEdits[moduleId]) fail('UNKNOWN_OR_DUPLICATE_MODULE', 'moduleEdit moduleId 不存在或重复。', '$changes.moduleEdits[' + index + '].moduleId');
      seenEdits[moduleId] = true;
      if (ownValue(edit, 'moduleId') != null && ownValue(edit, 'blockId') != null && String(ownValue(edit, 'moduleId')) !== String(ownValue(edit, 'blockId'))) {
        fail('ID_MISMATCH', 'moduleEdit blockId 兼容值必须与 moduleId 一致。', '$changes.moduleEdits[' + index + '].blockId');
      }
      ['sourceBlockIds', 'sourceBlockId', 'derivation', 'originalIndex', 'sourceSummary', 'sourceCopy', 'factBindings', 'assetSlots', 'targetAssetSlots', 'riskFlags'].forEach(function (key) {
        if (ownDescriptor(edit, key)) fail('IMMUTABLE_DERIVED_FIELD', '来源派生字段不能通过普通修订覆盖。', '$changes.moduleEdits[' + index + '].' + key);
      });
      ['type', 'salesRole', 'editableCopy', 'visualBrief', 'selected', 'locked'].forEach(function (key) {
        var descriptor = ownDescriptor(edit, key);
        if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) byId[moduleId][key] = descriptor.value;
      });
      if (ownDescriptor(edit, 'visualBrief')) {
        var pendingCopy = sanitizeEditableCopy(byId[moduleId].editableCopy, '$changes.moduleEdits[' + index + '].editableCopy', createContext(options));
        if (!copyContent(pendingCopy)) {
          assertRawSingleLineDirection(byId[moduleId].visualBrief, '$changes.moduleEdits[' + index + '].visualBrief', createContext(options));
        }
      }
      var bindingEdits = arrayValue(ownValue(edit, 'factBindingEdits'), '$changes.moduleEdits[' + index + '].factBindingEdits', normalizedLimits(options).maxRefsPerBlock, false);
      var bindingById = Object.create(null);
      byId[moduleId].factBindings.forEach(function (binding) { bindingById[binding.bindingId] = binding; });
      var seenBindings = Object.create(null);
      bindingEdits.forEach(function (bindingEdit, bindingIndex) {
        if (!isPlainObject(bindingEdit)) fail('INVALID_FACT_BINDING_EDIT', 'factBindingEdit 必须是普通对象。', '$changes.moduleEdits[' + index + '].factBindingEdits[' + bindingIndex + ']');
        var bindingId = String(ownValue(bindingEdit, 'bindingId') || '');
        if (!bindingById[bindingId] || seenBindings[bindingId]) fail('UNKNOWN_OR_DUPLICATE_BINDING', 'bindingId 不存在或重复。', '$changes.moduleEdits[' + index + '].factBindingEdits[' + bindingIndex + '].bindingId');
        if (ownDescriptor(bindingEdit, 'sourceFactId') || ownDescriptor(bindingEdit, 'required')) {
          fail('IMMUTABLE_DERIVED_FIELD', '来源事实身份与 required 不能通过普通修订覆盖。', '$changes.moduleEdits[' + index + '].factBindingEdits[' + bindingIndex + ']');
        }
        seenBindings[bindingId] = true;
        bindingById[bindingId].targetField = ownValue(bindingEdit, 'targetField');
      });
    });
    var operationsValue = ownValue(changes, 'operations');
    var planValue = ownValue(changes, 'modulePlan');
    if (operationsValue != null && planValue != null) fail('INVALID_MODULE_OPERATION', 'operations 与 modulePlan 不得同时提供。', '$changes.operations');
    var operations = arrayValue(operationsValue != null ? operationsValue : planValue, '$changes.operations', normalizedLimits(options).maxBlocks, false);
    if (operations.length) {
      if (ownDescriptor(changes, 'moduleOrder')) fail('INVALID_MODULE_ORDER', '结构 operations 的顺序就是最终顺序，不得再提交 moduleOrder。', '$changes.moduleOrder');
      var previousById = Object.create(null);
      raw.modules.forEach(function (module) { previousById[module.moduleId] = module; });
      var trustedPreviousById = Object.create(null);
      blueprint.modules.forEach(function (module) { trustedPreviousById[module.moduleId] = module; });
      var accounted = Object.create(null);
      var operationKeys = Object.create(null);
      var duplicatedParents = Object.create(null);
      var splitConsumedParents = Object.create(null);
      var nextModules = [];
      operations.forEach(function (operation, operationIndex) {
        var path = '$changes.operations[' + operationIndex + ']';
        if (!isPlainObject(operation)) fail('INVALID_MODULE_OPERATION', '模块操作必须是普通对象。', path);
        var op = String(ownValue(operation, 'op') || '');
        if (op === 'keep' || op === 'delete') {
          var existingId = idValue(ownValue(operation, 'moduleId'), path + '.moduleId', createContext(options), { required: true });
          if (!previousById[existingId] || accounted[existingId]) fail('UNKNOWN_OR_DUPLICATE_MODULE', '模块不存在或已被其他结构操作消费。', path + '.moduleId');
          if (op === 'delete' && trustedPreviousById[existingId].locked) {
            fail('MODULE_LOCKED', '已锁定模块不得被直接删除；请先单独解锁。', path + '.moduleId');
          }
          accounted[existingId] = true;
          if (op === 'keep') nextModules.push(previousById[existingId]);
          return;
        }
        if (op === 'split') {
          var splitParentId = idValue(ownValue(operation, 'sourceModuleId') || ownValue(operation, 'moduleId'), path + '.sourceModuleId', createContext(options), { required: true });
          var splitParent = previousById[splitParentId];
          var trustedSplitParent = trustedPreviousById[splitParentId];
          if (!splitParent) fail('UNKNOWN_SOURCE_MODULE', 'split 只能引用可信上一 revision 模块。', path + '.sourceModuleId');
          if (accounted[splitParentId]) fail('UNKNOWN_OR_DUPLICATE_MODULE', 'split 父模块已被其他结构操作消费。', path + '.sourceModuleId');
          if (splitParent.locked || trustedSplitParent.locked) fail('MODULE_LOCKED', '已锁定模块不得拆分。', path + '.sourceModuleId');
          if (seenEdits[splitParentId]) fail('INVALID_MODULE_OPERATION', 'split 父模块不得在同一 revision 同时普通编辑；请先提交编辑 revision。', path + '.sourceModuleId');
          if (duplicatedParents[splitParentId]) fail('INVALID_MODULE_OPERATION', 'split 对父模块独占结构消费，同一 revision 不得同时 duplicate。', path + '.sourceModuleId');
          var splitParts = arrayValue(ownValue(operation, 'parts'), path + '.parts', normalizedLimits(options).maxRefsPerBlock, true);
          if (splitParts.length < 2) fail('INVALID_MODULE_SPLIT', 'split 必须包含至少两个非空分组。', path + '.parts');
          var splitParentSources = Object.create(null);
          splitParent.sourceBlockIds.forEach(function (sourceBlockId) { splitParentSources[sourceBlockId] = true; });
          var splitCoveredSources = Object.create(null);
          splitParts.forEach(function (part, partIndex) {
            var partPath = path + '.parts[' + partIndex + ']';
            if (!isPlainObject(part)) fail('INVALID_MODULE_SPLIT', 'split part 必须是普通对象。', partPath);
            var partSourceIds = arrayValue(ownValue(part, 'sourceBlockIds'), partPath + '.sourceBlockIds', normalizedLimits(options).maxRefsPerBlock, true)
              .map(function (id, sourceIndex) { return idValue(id, partPath + '.sourceBlockIds[' + sourceIndex + ']', createContext(options), { required: true }); });
            if (!partSourceIds.length) fail('INVALID_MODULE_SPLIT', 'split 每个分组的 sourceBlockIds 不得为空。', partPath + '.sourceBlockIds');
            partSourceIds = canonicalSourceBlockIds(partSourceIds, snapshot, partPath + '.sourceBlockIds');
            partSourceIds.forEach(function (sourceBlockId) {
              if (!splitParentSources[sourceBlockId]) fail('INVALID_MODULE_SPLIT', 'split 分组不得包含父模块 lineage 之外的来源块。', partPath + '.sourceBlockIds');
              if (splitCoveredSources[sourceBlockId]) fail('INVALID_MODULE_SPLIT', 'split 分组必须互斥，不得重叠消费来源块。', partPath + '.sourceBlockIds');
              splitCoveredSources[sourceBlockId] = true;
            });
            var splitOperationKey = idValue(ownValue(part, 'operationKey'), partPath + '.operationKey', createContext(options), { required: true, max: 120 });
            if (operationKeys[splitOperationKey]) fail('DUPLICATE_OPERATION_KEY', '同一 revision 的派生 operationKey 必须唯一。', partPath + '.operationKey');
            operationKeys[splitOperationKey] = true;
            nextModules.push(buildDerivedModule(snapshot, blueprint.blueprintId, partSourceIds, {
              kind: 'split',
              parentModuleIds: [splitParentId],
              createdRevision: blueprint.revision + 1,
              operationKey: splitOperationKey
            }, trustedSplitParent));
          });
          if (Object.keys(splitCoveredSources).length !== splitParent.sourceBlockIds.length ||
              splitParent.sourceBlockIds.some(function (sourceBlockId) { return !splitCoveredSources[sourceBlockId]; })) {
            fail('INVALID_MODULE_SPLIT', 'split 分组必须精确覆盖父模块的全部 sourceBlockIds。', path + '.parts');
          }
          accounted[splitParentId] = true;
          splitConsumedParents[splitParentId] = true;
          return;
        }
        if (op !== 'duplicate' && op !== 'merge') fail('INVALID_MODULE_OPERATION', '只支持 keep/delete/duplicate/merge/split 模块操作。', path + '.op');
        var parentIds;
        if (op === 'duplicate') {
          parentIds = [idValue(ownValue(operation, 'sourceModuleId') || ownValue(operation, 'moduleId'), path + '.sourceModuleId', createContext(options), { required: true })];
        } else {
          parentIds = arrayValue(ownValue(operation, 'sourceModuleIds'), path + '.sourceModuleIds', normalizedLimits(options).maxRefsPerBlock, true)
            .map(function (id, index) { return idValue(id, path + '.sourceModuleIds[' + index + ']', createContext(options), { required: true }); });
          if (parentIds.length < 2 || new Set(parentIds).size !== parentIds.length) fail('INVALID_MODULE_OPERATION', 'merge 需要至少两个不重复父模块。', path + '.sourceModuleIds');
        }
        parentIds.forEach(function (parentId) {
          if (!previousById[parentId]) fail('UNKNOWN_SOURCE_MODULE', '派生操作只能引用可信上一 revision 模块。', path);
        });
        parentIds.sort(function (a, b) { return previousById[a].order - previousById[b].order || compareCodeUnits(a, b); });
        if (op === 'duplicate') {
          if (splitConsumedParents[parentIds[0]]) {
            fail('INVALID_MODULE_OPERATION', 'split 对父模块独占结构消费，同一 revision 不得同时 duplicate。', path + '.sourceModuleId');
          }
          if (seenEdits[parentIds[0]]) {
            fail('INVALID_MODULE_OPERATION', 'duplicate 必须从可信上一 revision 父模块派生，不得在同 revision 同时编辑父模块。', path + '.sourceModuleId');
          }
          duplicatedParents[parentIds[0]] = true;
        }
        if (op === 'merge') {
          parentIds.forEach(function (parentId) {
            if (previousById[parentId].locked || trustedPreviousById[parentId].locked) {
              fail('MODULE_LOCKED', '已锁定模块不得被 merge 消费。', path + '.sourceModuleIds');
            }
            if (seenEdits[parentId]) {
              fail('INVALID_MODULE_OPERATION', 'merge 必须从可信上一 revision 父模块派生，不得在同 revision 同时编辑父模块。', path + '.sourceModuleIds');
            }
            if (accounted[parentId]) fail('UNKNOWN_OR_DUPLICATE_MODULE', 'merge 父模块已被其他 keep/delete/merge 操作消费。', path);
            accounted[parentId] = true;
          });
        }
        var operationKey = idValue(ownValue(operation, 'operationKey'), path + '.operationKey', createContext(options), { required: true, max: 120 });
        if (operationKeys[operationKey]) fail('DUPLICATE_OPERATION_KEY', '同一 revision 的派生 operationKey 必须唯一。', path + '.operationKey');
        operationKeys[operationKey] = true;
        var sourceIds = [];
        parentIds.forEach(function (parentId) { sourceIds = sourceIds.concat(previousById[parentId].sourceBlockIds); });
        sourceIds = canonicalSourceBlockIds(Array.from(new Set(sourceIds)), snapshot, path + '.sourceBlockIds');
        var derivation = { kind: op, parentModuleIds: parentIds, createdRevision: blueprint.revision + 1, operationKey: operationKey };
        var seed;
        if (op === 'duplicate') {
          seed = trustedPreviousById[parentIds[0]];
        } else {
          seed = mergeSeedFromParents(parentIds.map(function (parentId) { return trustedPreviousById[parentId]; }));
        }
        nextModules.push(buildDerivedModule(snapshot, blueprint.blueprintId, sourceIds, derivation, seed));
      });
      Object.keys(previousById).forEach(function (moduleId) {
        if (!accounted[moduleId]) fail('INCOMPLETE_MODULE_PLAN', 'operations 必须用 keep/delete/merge/split 明确处理每个上一 revision 模块。', '$changes.operations');
      });
      if (!nextModules.length) fail('REQUIRED_FIELD', '蓝图不得删除全部模块。', '$changes.operations');
      raw.modules = nextModules;
    } else {
      var moduleOrder = arrayValue(ownValue(changes, 'moduleOrder'), '$changes.moduleOrder', raw.modules.length || 1, false);
      if (moduleOrder.length) {
        if (moduleOrder.length !== raw.modules.length || new Set(moduleOrder).size !== raw.modules.length || moduleOrder.some(function (id) { return !byId[id]; })) {
          fail('INVALID_MODULE_ORDER', 'moduleOrder 必须且只能包含全部现有 moduleId。', '$changes.moduleOrder');
        }
        raw.modules = moduleOrder.map(function (moduleId) { return byId[moduleId]; });
      }
    }
    raw.modules = raw.modules.map(function (module, index) {
      var seed = cloneJson(module);
      seed.order = index;
      var rebuilt = buildDerivedModule(snapshot, blueprint.blueprintId, module.sourceBlockIds, module.derivation, seed);
      rebuilt.order = index;
      return rebuilt;
    });
    raw.revision = blueprint.revision + 1;
    raw.updatedAt = ownValue(options, 'updatedAt') || blueprint.updatedAt;
    raw.approvalStatus = 'draft';
    raw.approval = { approvedAt: '', verificationId: '', productFactCardIds: [] };
    if (ownDescriptor(changes, 'approvalStatus') || ownDescriptor(changes, 'approval')) {
      fail('APPROVAL_REQUIRES_TRUSTED_TRANSITION', '审批状态不能通过普通修订设置，必须调用显式可信审批迁移。', '$changes.approvalStatus');
    }
    var revised = sanitizeBlueprint(raw, options);
    assertBlueprintAgainstSource(revised, snapshot, options, blueprint);
    return revised;
  }

  function verifiedTargetAssetRegistry(options, context) {
    var list = arrayValue(isPlainObject(options) ? ownValue(options, 'verifiedTargetAssets') : undefined,
      '$options.verifiedTargetAssets', context.limits.maxAssets, false);
    var registry = Object.create(null);
    list.forEach(function (item, index) {
      var path = '$options.verifiedTargetAssets[' + index + ']';
      if (!isPlainObject(item)) fail('INVALID_VERIFIED_ASSET', '可信素材记录必须是普通对象。', path);
      var assetId = idValue(ownValue(item, 'assetId', context, path + '.assetId'), path + '.assetId', context, { required: true });
      var rightsStatus = enumValue(ownValue(item, 'rightsStatus', context, path + '.rightsStatus'), RIGHTS_STATUSES, null, path + '.rightsStatus');
      var evidenceId = idValue(ownValue(item, 'evidenceId', context, path + '.evidenceId'), path + '.evidenceId', context, { required: true });
      var role = enumValue(ownValue(item, 'role', context, path + '.role'), ASSET_ROLES, 'subject', path + '.role');
      if (registry[assetId]) {
        if (registry[assetId].rightsStatus !== rightsStatus || registry[assetId].evidenceId !== evidenceId || registry[assetId].role !== role) {
          fail('CONFLICTING_VERIFIED_ASSET', '同一可信素材 ID 存在冲突记录。', path + '.assetId');
        }
        return;
      }
      registry[assetId] = { assetId: assetId, rightsStatus: rightsStatus, evidenceId: evidenceId, role: role };
    });
    return registry;
  }

  function verifiedFactCardRegistry(options, context) {
    var list = arrayValue(isPlainObject(options) ? ownValue(options, 'verifiedProductFactCards') : undefined,
      '$options.verifiedProductFactCards', context.limits.maxBatchTasks, false);
    var registry = Object.create(null);
    list.forEach(function (item, index) {
      var path = '$options.verifiedProductFactCards[' + index + ']';
      if (!isPlainObject(item)) fail('INVALID_VERIFIED_FACT_CARD', '可信事实卡记录必须是普通对象。', path);
      var cardId = idValue(ownValue(item, 'productFactCardId', context, path + '.productFactCardId'), path + '.productFactCardId', context, { required: true });
      var verificationId = idValue(ownValue(item, 'verificationId', context, path + '.verificationId'), path + '.verificationId', context, { required: true });
      var factKeys = arrayValue(ownValue(item, 'factKeys', context, path + '.factKeys'), path + '.factKeys', context.limits.maxFacts, true)
        .map(function (key, keyIndex) { return textValue(key, path + '.factKeys[' + keyIndex + ']', context, { required: true, max: 240 }); });
      factKeys = Array.from(new Set(factKeys)).sort(compareCodeUnits);
      if (registry[cardId]) {
        if (registry[cardId].verificationId !== verificationId || stableSerialize(registry[cardId].factKeys) !== stableSerialize(factKeys)) {
          fail('CONFLICTING_VERIFIED_FACT_CARD', '同一可信事实卡 ID 存在冲突记录。', path + '.productFactCardId');
        }
        return;
      }
      registry[cardId] = { productFactCardId: cardId, verificationId: verificationId, factKeys: factKeys };
    });
    return registry;
  }

  function assertModuleDerivedFromSnapshot(module, snapshot, path) {
    var canonical = canonicalSourceBlockIds(module.sourceBlockIds, snapshot, path + '.sourceBlockIds');
    if (stableSerialize(canonical) !== stableSerialize(module.sourceBlockIds)) {
      fail('SOURCE_DERIVATION_MISMATCH', 'sourceBlockIds 必须去重并按原详情顺序排列。', path + '.sourceBlockIds');
    }
    var bundle = deriveModuleSourceBundle(snapshot, module.moduleId, canonical, module.editableCopy);
    var expectedLegacy = canonical.length === 1 ? canonical[0] : '';
    if (module.sourceBlockId !== expectedLegacy || module.originalIndex !== bundle.originalIndex ||
        module.sourceSummary !== bundle.sourceSummary || module.sourceCopy !== bundle.sourceCopy) {
      fail('SOURCE_DERIVATION_MISMATCH', '模块来源文案、摘要或原始位置未由 lineage 正确派生。', path);
    }
    if (stableSerialize(module.assetSlots) !== stableSerialize(bundle.assetSlots)) {
      fail('SOURCE_DERIVATION_MISMATCH', '来源素材槽必须由 snapshot 中 lineage 的严格并集派生。', path + '.assetSlots');
    }
    if (module.factBindings.length !== bundle.factIds.length) fail('SOURCE_DERIVATION_MISMATCH', '来源事实绑定数量不一致。', path + '.factBindings');
    module.factBindings.forEach(function (binding, index) {
      var expectedId = stableHash({ moduleId: module.moduleId, sourceFactId: bundle.factIds[index], index: index }, 'rdbind_');
      if (binding.bindingId !== expectedId || binding.sourceFactId !== bundle.factIds[index] || binding.required !== true) {
        fail('SOURCE_DERIVATION_MISMATCH', '来源事实绑定身份必须由 lineage 并集派生。', path + '.factBindings[' + index + ']');
      }
    });
    if (stableSerialize(module.riskFlags) !== stableSerialize(bundle.riskFlags)) {
      fail('SOURCE_DERIVATION_MISMATCH', '强制风险必须是 lineage 权利、完整度与文案门禁的最严格并集。', path + '.riskFlags');
    }
  }

  function moduleWithoutTargets(module) {
    var output = cloneJson(module);
    output.targetAssetSlots = [];
    return output;
  }

  function assertApprovedBlueprintGates(blueprint, options, snapshot) {
    var context = createContext(options);
    var assetRegistry = verifiedTargetAssetRegistry(options, context);
    var factRegistry = verifiedFactCardRegistry(options, context);
    var cardIds = blueprint.approval.productFactCardIds;
    if (!blueprint.modules.some(function (module) { return module.selected; })) {
      fail('NO_SELECTED_MODULE', 'approved 蓝图至少需要一个选中模块。', '$.modules');
    }
    var hasDirectionOnlyModule = blueprint.modules.some(function (module) {
      return module.selected && directionOnlyModule(module);
    });
    if (hasDirectionOnlyModule && !hasReusableTargetAsset(assetRegistry)) {
      fail('UNVERIFIED_TARGET_ASSET', 'direction-only 审批至少需要一张 authorized/self_owned 可复用目标素材。', '$options.verifiedTargetAssets');
    }
    cardIds.forEach(function (cardId, cardIndex) {
      if (!factRegistry[cardId]) {
        fail('UNVERIFIED_FACT_CARD', 'approved 蓝图引用了未在可信 registry 中核验的事实卡。', '$.approval.productFactCardIds[' + cardIndex + ']');
      }
    });
    blueprint.modules.forEach(function (module, moduleIndex) {
      var modulePath = '$.modules[' + moduleIndex + ']';
      if (!module.selected) {
        if (module.targetAssetSlots.length) {
          fail('UNKNOWN_TARGET_BINDING', '未选中模块不得持久化审批目标素材槽。', modulePath + '.targetAssetSlots');
        }
        return;
      }
      if (module.riskFlags.indexOf('SOURCE_BLOCKED') >= 0 || module.riskFlags.indexOf('BLOCKED_ASSET') >= 0) {
        fail('SOURCE_BLOCKED', '含 blocked 来源的选中模块不能处于 approved。', modulePath);
      }
      if (directionOnlyModule(module)) {
        assertSafeCoreDirection(module, modulePath, snapshot);
        if (module.targetAssetSlots.length) {
          fail('UNKNOWN_TARGET_BINDING', 'direction-only 模块不得持久化逐来源槽目标绑定。', modulePath + '.targetAssetSlots');
        }
        return;
      }
      var normalizedSource = String(module.sourceCopy || '').replace(/\s+/g, ' ').trim();
      var normalizedTarget = copyContent(module.editableCopy || emptyEditableCopy());
      if (normalizedSource && (!normalizedTarget || normalizedTarget === normalizedSource || module.riskFlags.indexOf('COPY_REWRITE_REQUIRED') >= 0)) {
        fail('COPY_REWRITE_REQUIRED', 'approved 蓝图的来源文案必须已重写为非空目标文案。', modulePath + '.editableCopy');
      }
      module.factBindings.forEach(function (binding, bindingIndex) {
        if (!binding.required) return;
        if (!binding.targetField) {
          fail('FACT_BINDING_REQUIRED', 'approved 蓝图的必要来源事实必须映射到目标事实卡字段。', modulePath + '.factBindings[' + bindingIndex + '].targetField');
        }
        cardIds.forEach(function (cardId) {
          if (factRegistry[cardId].factKeys.indexOf(binding.targetField) < 0) {
            fail('FACT_BINDING_REQUIRED', 'approved 蓝图的目标事实卡缺少必要映射字段。', modulePath + '.factBindings[' + bindingIndex + '].targetField');
          }
        });
      });
      var sourceSlots = Object.create(null);
      module.assetSlots.forEach(function (sourceSlot) { sourceSlots[sourceSlot.slotId] = sourceSlot; });
      var targetBySourceSlot = Object.create(null);
      module.targetAssetSlots.forEach(function (slot, slotIndex) {
        var slotPath = modulePath + '.targetAssetSlots[' + slotIndex + ']';
        var sourceSlot = sourceSlots[slot.sourceSlotId];
        if (!sourceSlot || targetBySourceSlot[slot.sourceSlotId]) {
          fail('UNKNOWN_TARGET_BINDING', 'approved 目标素材槽必须与当前模块必要来源槽一一对应。', slotPath + '.sourceSlotId');
        }
        if (!sourceSlot.required || !sourceSlot.replacementRequired || slot.role !== sourceSlot.role || slot.directUseAllowed !== true) {
          fail('SOURCE_DERIVATION_MISMATCH', 'approved 目标素材槽不得改写来源槽语义。', slotPath);
        }
        var verified = assetRegistry[slot.targetAssetId];
        if (!verified || (verified.rightsStatus !== 'authorized' && verified.rightsStatus !== 'self_owned') ||
            verified.rightsStatus !== slot.rightsStatus || verified.evidenceId !== slot.rightsEvidenceId) {
          fail('UNVERIFIED_TARGET_ASSET', 'approved 蓝图目标素材槽未通过 authorized/self_owned 可信 registry 复核。', slotPath);
        }
        targetBySourceSlot[slot.sourceSlotId] = true;
      });
      module.assetSlots.forEach(function (sourceSlot, slotIndex) {
        if (sourceSlot.required && sourceSlot.replacementRequired && !targetBySourceSlot[sourceSlot.slotId]) {
          fail('ASSET_REPLACEMENT_REQUIRED', 'approved 蓝图的每个必要来源素材槽都必须绑定可信目标素材。', modulePath + '.assetSlots[' + slotIndex + ']');
        }
      });
    });
    assertUniqueSelectedCoreDirections(blueprint);
  }

  function assertBlueprintAgainstSource(blueprintInput, snapshotInput, options, previousOverride) {
    options = isPlainObject(options) ? options : {};
    var snapshot = sanitizeSourceSnapshot(snapshotInput, options);
    var blueprint = sanitizeBlueprint(blueprintInput, options);
    if (blueprint.sourceSnapshotId !== snapshot.snapshotId) fail('LINKAGE_MISMATCH', '蓝图 sourceSnapshotId 与来源快照不匹配。', '$.sourceSnapshotId');
    blueprint.modules.forEach(function (module, index) {
      if (module.derivation.createdRevision > blueprint.revision) fail('UNPROVEN_MODULE_DERIVATION', '模块不得出生于未来 revision。', '$.modules[' + index + '].derivation.createdRevision');
      assertModuleDerivedFromSnapshot(module, snapshot, '$.modules[' + index + ']');
    });
    var expectedDraft = createBlueprintFromSnapshot(snapshot, options);
    var previousInput = previousOverride || ownValue(options, 'previousBlueprint');
    if (blueprint.revision === 1) {
      if (previousInput) fail('INVALID_REVISION_CHAIN', 'revision 1 不应提供 previousBlueprint。', '$options.previousBlueprint');
      if (blueprint.approvalStatus !== 'draft') fail('INVALID_APPROVAL_TRANSITION', 'revision 1 只能是 draft。', '$.approvalStatus');
      if (stableSerialize(blueprint.modules) !== stableSerialize(expectedDraft.modules)) {
        fail('UNPROVEN_REVISION', 'revision 1 必须是来源快照的一块一模块初始蓝图。', '$.modules');
      }
    } else {
      if (!previousInput) fail('PREVIOUS_BLUEPRINT_REQUIRED', 'revision > 1 必须提供可信上一 revision。', '$options.previousBlueprint');
      var previous = sanitizeBlueprint(previousInput, options);
      if (previous.blueprintId !== blueprint.blueprintId || previous.sourceSnapshotId !== blueprint.sourceSnapshotId ||
          blueprint.revision !== previous.revision + 1 || previous.createdAt !== blueprint.createdAt) {
        fail('INVALID_REVISION_CHAIN', '蓝图 revision 必须沿同一来源恰好递增 1。', '$.revision');
      }
      previous.modules.forEach(function (module, index) { assertModuleDerivedFromSnapshot(module, snapshot, '$previous.modules[' + index + ']'); });
      var previousById = Object.create(null);
      previous.modules.forEach(function (module) { previousById[module.moduleId] = module; });
      var currentById = Object.create(null);
      blueprint.modules.forEach(function (module) { currentById[module.moduleId] = module; });
      previous.modules.forEach(function (module, index) {
        if (module.locked && !currentById[module.moduleId]) {
          fail('MODULE_LOCKED', '已锁定模块不得在下一 revision 中消失；请先单独解锁。', '$previous.modules[' + index + '].moduleId');
        }
      });
      var newOperationKeys = Object.create(null);
      var mergeConsumedParents = Object.create(null);
      var duplicatedParents = Object.create(null);
      var splitChildrenByParent = Object.create(null);
      blueprint.modules.forEach(function (module, index) {
        var prior = previousById[module.moduleId];
        var path = '$.modules[' + index + ']';
        if (prior) {
          if (stableSerialize(module.sourceBlockIds) !== stableSerialize(prior.sourceBlockIds) ||
              stableSerialize(module.derivation) !== stableSerialize(prior.derivation)) {
            fail('IMMUTABLE_DERIVED_FIELD', '存续 moduleId 不得替换 lineage 或 derivation。', path);
          }
          if (prior.locked) {
            var expectedLockedModule = cloneJson(prior);
            expectedLockedModule.order = module.order;
            expectedLockedModule.locked = module.locked;
            if (blueprint.approvalStatus === 'approved' && previous.approvalStatus === 'draft') {
              expectedLockedModule.targetAssetSlots = cloneJson(module.targetAssetSlots);
            }
            if (stableSerialize(expectedLockedModule) !== stableSerialize(module)) {
              fail('MODULE_LOCKED', '已锁定模块只能保持不变或纯解锁；不得在同 revision 解锁并篡改其他字段。', path);
            }
          }
          return;
        }
        if (module.derivation.kind === 'source' || module.derivation.createdRevision !== blueprint.revision) {
          fail('UNPROVEN_MODULE_DERIVATION', '新模块必须由当前 revision 的 duplicate/merge/split 操作产生。', path + '.derivation');
        }
        if (newOperationKeys[module.derivation.operationKey]) fail('DUPLICATE_OPERATION_KEY', '同 revision 新模块 operationKey 重复。', path + '.derivation.operationKey');
        newOperationKeys[module.derivation.operationKey] = true;
        var parents = module.derivation.parentModuleIds.map(function (parentId) {
          if (!previousById[parentId]) fail('UNPROVEN_MODULE_DERIVATION', '派生模块父级必须存在于可信上一 revision。', path + '.derivation.parentModuleIds');
          return previousById[parentId];
        });
        var canonicalParentIds = parents.slice().sort(function (a, b) { return a.order - b.order || compareCodeUnits(a.moduleId, b.moduleId); })
          .map(function (parent) { return parent.moduleId; });
        if (stableSerialize(canonicalParentIds) !== stableSerialize(module.derivation.parentModuleIds)) {
          fail('UNPROVEN_MODULE_DERIVATION', '父模块 ID 必须按上一 revision 顺序规范化。', path + '.derivation.parentModuleIds');
        }
        if (module.derivation.kind === 'split') {
          var splitParent = parents[0];
          if (splitParent.locked) fail('MODULE_LOCKED', '已锁定模块不得拆分。', path + '.derivation.parentModuleIds');
          if (currentById[splitParent.moduleId]) {
            fail('UNPROVEN_MODULE_DERIVATION', 'split 必须消费父模块，同一 revision 不得同时保留父模块与 split 子模块。', path + '.derivation.parentModuleIds');
          }
          var splitParentSources = Object.create(null);
          splitParent.sourceBlockIds.forEach(function (sourceBlockId) { splitParentSources[sourceBlockId] = true; });
          if (!module.sourceBlockIds.length || module.sourceBlockIds.some(function (sourceBlockId) { return !splitParentSources[sourceBlockId]; })) {
            fail('UNPROVEN_MODULE_DERIVATION', 'split 子模块 lineage 必须是父模块 lineage 的非空子集。', path + '.sourceBlockIds');
          }
          var expectedSplitModule = buildDerivedModule(snapshot, blueprint.blueprintId, module.sourceBlockIds, module.derivation, splitParent);
          expectedSplitModule.order = module.order;
          expectedSplitModule = sanitizeModule(expectedSplitModule, module.order, createContext(options), blueprint.blueprintId, blueprint.approvalStatus);
          if (stableSerialize(expectedSplitModule) !== stableSerialize(module)) {
            fail('UNPROVEN_MODULE_DERIVATION', 'split 子模块必须完整继承可信父模块的可编辑种子字段，不得在同 revision 伪造。', path);
          }
          if (!splitChildrenByParent[splitParent.moduleId]) {
            splitChildrenByParent[splitParent.moduleId] = { parent: splitParent, children: [] };
          }
          splitChildrenByParent[splitParent.moduleId].children.push({ module: module, path: path });
        } else {
          var expectedSources = [];
          parents.forEach(function (parent) { expectedSources = expectedSources.concat(parent.sourceBlockIds); });
          expectedSources = canonicalSourceBlockIds(Array.from(new Set(expectedSources)), snapshot, path + '.sourceBlockIds');
          if (stableSerialize(expectedSources) !== stableSerialize(module.sourceBlockIds)) {
            fail('UNPROVEN_MODULE_DERIVATION', 'sourceBlockIds 不是父模块 lineage 的规范并集。', path + '.sourceBlockIds');
          }
          var expectedDerivedModule = buildDerivedModule(
            snapshot,
            blueprint.blueprintId,
            module.sourceBlockIds,
            module.derivation,
            module.derivation.kind === 'duplicate' ? parents[0] : mergeSeedFromParents(parents)
          );
          expectedDerivedModule.order = module.order;
          expectedDerivedModule = sanitizeModule(expectedDerivedModule, module.order, createContext(options), blueprint.blueprintId, blueprint.approvalStatus);
          if (stableSerialize(expectedDerivedModule) !== stableSerialize(module)) {
            fail('UNPROVEN_MODULE_DERIVATION', module.derivation.kind + ' 派生模块必须由可信父模块的规范 seed 完整重建，不得在同 revision 伪造。', path);
          }
        }
        if (module.derivation.kind === 'duplicate') {
          duplicatedParents[module.derivation.parentModuleIds[0]] = true;
        }
        if (module.derivation.kind === 'merge') {
          module.derivation.parentModuleIds.forEach(function (parentId) {
            if (previousById[parentId].locked) {
              fail('MODULE_LOCKED', '已锁定模块不得被 merge 消费。', path + '.derivation.parentModuleIds');
            }
            if (currentById[parentId]) {
              fail('UNPROVEN_MODULE_DERIVATION', 'merge 必须消费父模块，同一 revision 不得同时保留父模块与 merge 子模块。', path + '.derivation.parentModuleIds');
            }
            if (mergeConsumedParents[parentId]) {
              fail('UNPROVEN_MODULE_DERIVATION', '同一父模块在一个 revision 中只能被一个 merge 子模块消费。', path + '.derivation.parentModuleIds');
            }
            mergeConsumedParents[parentId] = module.moduleId;
          });
        }
      });
      Object.keys(splitChildrenByParent).forEach(function (parentId) {
        var splitFamily = splitChildrenByParent[parentId];
        if (mergeConsumedParents[parentId]) {
          fail('UNPROVEN_MODULE_DERIVATION', '同一父模块在一个 revision 中不得同时被 merge 与 split 消费。', '$.modules');
        }
        if (duplicatedParents[parentId]) {
          fail('UNPROVEN_MODULE_DERIVATION', 'split 对父模块独占结构消费，同一 revision 不得同时 duplicate。', '$.modules');
        }
        if (splitFamily.children.length < 2) {
          fail('UNPROVEN_MODULE_DERIVATION', 'split 必须由至少两个子模块共同完成。', splitFamily.children[0].path + '.derivation');
        }
        var coveredSources = Object.create(null);
        splitFamily.children.forEach(function (child) {
          child.module.sourceBlockIds.forEach(function (sourceBlockId) {
            if (coveredSources[sourceBlockId]) {
              fail('UNPROVEN_MODULE_DERIVATION', 'split 子模块 lineage 必须互斥，不得重叠消费来源块。', child.path + '.sourceBlockIds');
            }
            coveredSources[sourceBlockId] = true;
          });
        });
        if (Object.keys(coveredSources).length !== splitFamily.parent.sourceBlockIds.length ||
            splitFamily.parent.sourceBlockIds.some(function (sourceBlockId) { return !coveredSources[sourceBlockId]; })) {
          fail('UNPROVEN_MODULE_DERIVATION', 'split 子模块 lineage 必须精确分区并覆盖父模块的全部来源块。', '$.modules');
        }
      });
      if (blueprint.approvalStatus === 'approved') {
        if (previous.approvalStatus !== 'draft' || blueprint.modules.length !== previous.modules.length) {
          fail('INVALID_APPROVAL_TRANSITION', '审批 revision 只能由相同结构的 draft 单独迁移。', '$.approvalStatus');
        }
        blueprint.modules.forEach(function (module, index) {
          if (!previous.modules[index] || previous.modules[index].moduleId !== module.moduleId ||
              stableSerialize(moduleWithoutTargets(module)) !== stableSerialize(moduleWithoutTargets(previous.modules[index]))) {
            fail('INVALID_APPROVAL_TRANSITION', '审批 revision 不得夹带结构、文案或映射修改。', '$.modules[' + index + ']');
          }
        });
      } else {
        if (blueprint.approvalStatus !== 'draft') fail('UNPROVEN_APPROVAL_STATE', '除显式可信审批外，修订蓝图只能是 draft。', '$.approvalStatus');
        blueprint.modules.forEach(function (module, index) {
          if (module.targetAssetSlots.length) fail('UNVERIFIED_TARGET_ASSET', 'draft 不得持久化未经审批的目标素材槽。', '$.modules[' + index + '].targetAssetSlots');
        });
      }
    }
    if (blueprint.approvalStatus === 'approved') {
      assertApprovedBlueprintGates(blueprint, options, snapshot);
    }
    return { blueprint: blueprint, snapshot: snapshot };
  }

  function validateBlueprintAgainstSource(blueprintInput, snapshotInput, options) {
    try {
      var checked = assertBlueprintAgainstSource(blueprintInput, snapshotInput, options);
      return deepFreeze({ ok: true, value: checked.blueprint, errors: [], warnings: checked.blueprint.warnings || [] });
    } catch (error) {
      return deepFreeze({ ok: false, value: null, errors: [{ code: error.code || 'CONTRACT_ERROR', message: String(error.message || error), path: error.path || '$', severity: 'error' }], warnings: [] });
    }
  }

  function validateBlueprintAgainstSnapshot(blueprintInput, snapshotInput, options) {
    return validateBlueprintAgainstSource(blueprintInput, snapshotInput, options);
  }

  function optionsWithoutPrevious(options) {
    var output = {};
    if (!isPlainObject(options)) return output;
    Object.keys(options).forEach(function (key) {
      if (key === 'previousBlueprint') return;
      var descriptor = ownDescriptor(options, key);
      if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) output[key] = descriptor.value;
    });
    return output;
  }

  function createRevisionEnvelope(currentBlueprintInput, immediatePreviousInput, snapshotInput, options) {
    var currentShape = sanitizeBlueprint(currentBlueprintInput, options);
    if (currentShape.revision === 1 && immediatePreviousInput != null) {
      fail('INVALID_REVISION_CHAIN', 'revision 1 的 envelope 不得包含 immediatePreviousBlueprint。', '$envelope.immediatePreviousBlueprint');
    }
    if (currentShape.revision > 1 && immediatePreviousInput == null) {
      fail('PREVIOUS_BLUEPRINT_REQUIRED', 'revision > 1 的 envelope 必须持久化直接前一 revision。', '$envelope.immediatePreviousBlueprint');
    }
    var validationOptions = optionsWithoutPrevious(options);
    if (immediatePreviousInput != null) validationOptions.previousBlueprint = immediatePreviousInput;
    var checked = assertBlueprintAgainstSource(currentShape, snapshotInput, validationOptions);
    return deepFreeze({
      currentBlueprint: checked.blueprint,
      immediatePreviousBlueprint: immediatePreviousInput == null ? null : sanitizeBlueprint(immediatePreviousInput, options)
    });
  }

  function advanceRevisionEnvelope(envelopeInput, nextBlueprintInput, snapshotInput, options) {
    if (!isPlainObject(envelopeInput)) fail('INVALID_REVISION_ENVELOPE', 'revision envelope 必须是普通对象。', '$envelope');
    var currentInput = ownValue(envelopeInput, 'currentBlueprint');
    var previousInput = ownValue(envelopeInput, 'immediatePreviousBlueprint');
    var restored = createRevisionEnvelope(currentInput, previousInput == null ? null : previousInput, snapshotInput, options);
    var validationOptions = optionsWithoutPrevious(options);
    validationOptions.previousBlueprint = restored.currentBlueprint;
    var nextChecked = assertBlueprintAgainstSource(nextBlueprintInput, snapshotInput, validationOptions);
    return deepFreeze({
      currentBlueprint: nextChecked.blueprint,
      immediatePreviousBlueprint: restored.currentBlueprint
    });
  }

  function approveBlueprint(blueprintInput, snapshotInput, approvalContext, options) {
    approvalContext = isPlainObject(approvalContext) ? approvalContext : {};
    options = isPlainObject(options) ? options : {};
    var checked = assertBlueprintAgainstSource(blueprintInput, snapshotInput, options);
    var blueprint = checked.blueprint;
    if (blueprint.approvalStatus === 'approved') fail('INVALID_APPROVAL_TRANSITION', '蓝图已经 approved，内容变化必须先产生新的 draft revision。', '$.approvalStatus');
    if (!blueprint.modules.some(function (module) { return module.selected; })) fail('NO_SELECTED_MODULE', '审批至少需要一个选中模块。', '$.modules');
    var context = createContext(options);
    var assetRegistry = verifiedTargetAssetRegistry(options, context);
    var factRegistry = verifiedFactCardRegistry(options, context);
    var cardIds = arrayValue(ownValue(approvalContext, 'productFactCardIds'), '$approval.productFactCardIds', context.limits.maxBatchTasks, true)
      .map(function (id, index) { return idValue(id, '$approval.productFactCardIds[' + index + ']', context, { required: true }); });
    cardIds = Array.from(new Set(cardIds)).sort(compareCodeUnits);
    if (!cardIds.length) fail('FACT_CARD_REQUIRED', '审批必须绑定至少一个可信目标事实卡。', '$approval.productFactCardIds');
    cardIds.forEach(function (cardId) {
      if (!factRegistry[cardId]) fail('UNVERIFIED_FACT_CARD', '目标事实卡未出现在独立可信 registry。', '$approval.productFactCardIds');
    });
    var hasDirectionOnlyModule = blueprint.modules.some(function (module) {
      return module.selected && directionOnlyModule(module);
    });
    if (hasDirectionOnlyModule && !hasReusableTargetAsset(assetRegistry)) {
      fail('UNVERIFIED_TARGET_ASSET', 'direction-only 审批至少需要一张 authorized/self_owned 可复用目标素材。', '$options.verifiedTargetAssets');
    }
    var bindings = arrayValue(ownValue(approvalContext, 'slotBindings'), '$approval.slotBindings', context.limits.maxAssets, false);
    var bindingBySourceSlot = Object.create(null);
    bindings.forEach(function (binding, index) {
      var path = '$approval.slotBindings[' + index + ']';
      if (!isPlainObject(binding)) fail('INVALID_TARGET_BINDING', '目标素材绑定必须是普通对象。', path);
      if (ownDescriptor(binding, 'rightsStatus') || ownDescriptor(binding, 'directUseAllowed') || ownDescriptor(binding, 'replacementRequired')) {
        fail('UNTRUSTED_RIGHTS_ASSERTION', '目标绑定不得自报授权状态，授权只能来自可信 registry。', path);
      }
      var rawModuleId = ownValue(binding, 'moduleId');
      var rawBlockAlias = ownValue(binding, 'blockId');
      var moduleId = idValue(rawModuleId == null ? rawBlockAlias : rawModuleId, path + '.moduleId', context, { required: true });
      if (rawBlockAlias != null && idValue(rawBlockAlias, path + '.blockId', context, { required: true }) !== moduleId) fail('ID_MISMATCH', 'slotBinding blockId 兼容值必须与 moduleId 一致。', path + '.blockId');
      var sourceSlotId = idValue(ownValue(binding, 'sourceSlotId'), path + '.sourceSlotId', context, { required: true });
      var targetAssetId = idValue(ownValue(binding, 'targetAssetId'), path + '.targetAssetId', context, { required: true });
      var key = moduleId + '\u0000' + sourceSlotId;
      if (bindingBySourceSlot[key]) fail('DUPLICATE_TARGET_BINDING', '同一来源槽只能绑定一个目标素材。', path);
      bindingBySourceSlot[key] = { moduleId: moduleId, sourceSlotId: sourceSlotId, targetAssetId: targetAssetId };
    });
    var raw = cloneJson(blueprint);
    var consumedBindings = Object.create(null);
    raw.modules.forEach(function (module, moduleIndex) {
      if (!module.selected) return;
      if (module.riskFlags.indexOf('SOURCE_BLOCKED') >= 0 || module.riskFlags.indexOf('BLOCKED_ASSET') >= 0) {
        fail('SOURCE_BLOCKED', '含 blocked 来源的选中模块不能审批。', '$.modules[' + moduleIndex + ']');
      }
      module.targetAssetSlots = [];
      if (directionOnlyModule(module)) {
        assertSafeCoreDirection(module, '$.modules[' + moduleIndex + ']', checked.snapshot);
        return;
      }
      if (module.sourceCopy && module.riskFlags.indexOf('COPY_REWRITE_REQUIRED') >= 0) {
        fail('COPY_REWRITE_REQUIRED', '来源文案必须重写为非空目标文案后才能审批。', '$.modules[' + moduleIndex + '].editableCopy');
      }
      module.factBindings.forEach(function (binding, bindingIndex) {
        if (!binding.required) return;
        if (!binding.targetField) fail('FACT_BINDING_REQUIRED', '必要来源事实必须映射到目标事实卡字段。', '$.modules[' + moduleIndex + '].factBindings[' + bindingIndex + '].targetField');
        cardIds.forEach(function (cardId) {
          if (factRegistry[cardId].factKeys.indexOf(binding.targetField) < 0) {
            fail('FACT_BINDING_REQUIRED', '目标事实卡缺少必要映射字段。', '$.modules[' + moduleIndex + '].factBindings[' + bindingIndex + '].targetField');
          }
        });
      });
      module.assetSlots.forEach(function (sourceSlot, slotIndex) {
        if (!sourceSlot.required || !sourceSlot.replacementRequired) return;
        var key = module.moduleId + '\u0000' + sourceSlot.slotId;
        var binding = bindingBySourceSlot[key];
        if (!binding) fail('ASSET_REPLACEMENT_REQUIRED', '受限来源素材槽必须绑定可信目标素材。', '$.modules[' + moduleIndex + '].assetSlots[' + slotIndex + ']');
        var verified = assetRegistry[binding.targetAssetId];
        if (!verified || (verified.rightsStatus !== 'authorized' && verified.rightsStatus !== 'self_owned')) {
          fail('UNVERIFIED_TARGET_ASSET', '目标素材未获得 authorized/self_owned 可信验证。', '$approval.slotBindings');
        }
        consumedBindings[key] = true;
        module.targetAssetSlots.push({
          targetSlotId: stableHash({ moduleId: module.moduleId, sourceSlotId: sourceSlot.slotId, targetAssetId: verified.assetId }, 'rdtarget_'),
          sourceSlotId: sourceSlot.slotId,
          targetAssetId: verified.assetId,
          role: sourceSlot.role,
          rightsStatus: verified.rightsStatus,
          rightsEvidenceId: verified.evidenceId,
          directUseAllowed: true
        });
      });
    });
    assertUniqueSelectedCoreDirections(raw);
    Object.keys(bindingBySourceSlot).forEach(function (key) {
      if (!consumedBindings[key]) fail('UNKNOWN_TARGET_BINDING', '审批包含未对应必要来源槽的目标素材绑定。', '$approval.slotBindings');
    });
    var approvedAt = timestampValue(ownValue(approvalContext, 'approvedAt'), '$approval.approvedAt', context);
    var verificationId = idValue(ownValue(approvalContext, 'verificationId'), '$approval.verificationId', context, { required: true });
    raw.revision = blueprint.revision + 1;
    raw.approvalStatus = 'approved';
    raw.approval = { approvedAt: approvedAt, verificationId: verificationId, productFactCardIds: cardIds };
    raw.updatedAt = approvedAt;
    var approved = sanitizeBlueprint(raw, options);
    assertBlueprintAgainstSource(approved, checked.snapshot, options, blueprint);
    return approved;
  }

  var VISUAL_STRUCTURE_FORBIDDEN_KEYS = Object.freeze({
    productFactCardId: true,
    productFactCardIds: true,
    verifiedProductFactCards: true,
    factCardsById: true,
    facts: true,
    factBindings: true,
    sourceCopy: true,
    sourceSummary: true,
    editableCopy: true,
    assetSlots: true,
    targetAssetSlots: true,
    publishableCopy: true,
    targetFacts: true
  });

  function assertNoVisualStructureFactFields(input, path) {
    if (!isPlainObject(input)) return;
    Object.keys(VISUAL_STRUCTURE_FORBIDDEN_KEYS).forEach(function (key) {
      if (ownDescriptor(input, key)) {
        fail('VISUAL_STRUCTURE_FACT_FIELD_FORBIDDEN', '结构专用合同不得携带事实卡、来源文案或目标事实字段。', path + '.' + key);
      }
    });
  }

  function sanitizeVisualStructureModule(item, index, context, blueprintId) {
    var path = '$.modules[' + index + ']';
    if (!isPlainObject(item)) fail('INVALID_MODULE', '结构蓝图模块必须是普通对象。', path);
    assertNoVisualStructureFactFields(item, path);
    var moduleId = idValue(ownValue(item, 'moduleId', context, path + '.moduleId'), path + '.moduleId', context, { required: true });
    var blockAlias = ownValue(item, 'blockId', context, path + '.blockId');
    if (blockAlias != null && idValue(blockAlias, path + '.blockId', context, { required: true }) !== moduleId) {
      fail('ID_MISMATCH', '兼容 blockId 必须与 moduleId 一致。', path + '.blockId');
    }
    var sourceBlockIds = arrayValue(ownValue(item, 'sourceBlockIds', context, path + '.sourceBlockIds'), path + '.sourceBlockIds', context.limits.maxRefsPerBlock, true)
      .map(function (id, sourceIndex) { return idValue(id, path + '.sourceBlockIds[' + sourceIndex + ']', context, { required: true }); });
    if (!sourceBlockIds.length) fail('REQUIRED_FIELD', '结构模块 sourceBlockIds 不得为空。', path + '.sourceBlockIds');
    if (new Set(sourceBlockIds).size !== sourceBlockIds.length) fail('DUPLICATE_ID', 'sourceBlockIds 不得重复。', path + '.sourceBlockIds');
    var derivation = sanitizeModuleDerivation(ownValue(item, 'derivation', context, path + '.derivation'), path + '.derivation', context);
    if (moduleId !== deriveBlueprintModuleId(blueprintId, sourceBlockIds, derivation)) {
      fail('ID_MISMATCH', 'moduleId 与结构 lineage 不匹配。', path + '.moduleId');
    }
    var riskFlags = arrayValue(ownValue(item, 'riskFlags', context, path + '.riskFlags'), path + '.riskFlags', context.limits.maxRiskFlags, false)
      .map(function (flag, flagIndex) {
        flag = textValue(flag, path + '.riskFlags[' + flagIndex + ']', context, { required: true, max: 80 });
        if (!SAFE_RISK_FLAG.test(flag)) fail('INVALID_RISK_FLAG', 'riskFlag 必须是大写下划线标识。', path + '.riskFlags[' + flagIndex + ']');
        return flag;
      });
    return {
      moduleId: moduleId,
      blockId: moduleId,
      sourceBlockIds: sourceBlockIds,
      derivation: derivation,
      originalIndex: nonNegativeIntegerValue(ownValue(item, 'originalIndex', context, path + '.originalIndex'), path + '.originalIndex'),
      order: nonNegativeIntegerValue(ownValue(item, 'order', context, path + '.order'), path + '.order'),
      type: enumValue(ownValue(item, 'type', context, path + '.type'), BLOCK_TYPES, 'unknown', path + '.type'),
      salesRole: enumValue(ownValue(item, 'salesRole', context, path + '.salesRole'), SALES_ROLES, 'unknown', path + '.salesRole'),
      visualBrief: sanitizeVisualBrief(ownValue(item, 'visualBrief', context, path + '.visualBrief'), path + '.visualBrief', context),
      selected: booleanValue(ownValue(item, 'selected'), true),
      locked: booleanValue(ownValue(item, 'locked'), false),
      riskFlags: Array.from(new Set(riskFlags)).sort(compareCodeUnits)
    };
  }

  function sanitizeVisualStructureApproval(input, approvalStatus, context) {
    input = isPlainObject(input) ? input : {};
    assertNoVisualStructureFactFields(input, '$.approval');
    var claimMode = ownValue(input, 'claimMode', context, '$.approval.claimMode') || VISUAL_STRUCTURE_ONLY;
    if (claimMode !== VISUAL_STRUCTURE_ONLY) fail('INVALID_CLAIM_MODE', '结构蓝图 claimMode 无效。', '$.approval.claimMode');
    if (approvalStatus !== 'approved') {
      return { approvedAt: '', verificationId: '', claimMode: VISUAL_STRUCTURE_ONLY };
    }
    return {
      approvedAt: timestampValue(ownValue(input, 'approvedAt', context, '$.approval.approvedAt'), '$.approval.approvedAt', context),
      verificationId: idValue(ownValue(input, 'verificationId', context, '$.approval.verificationId'), '$.approval.verificationId', context, { required: true }),
      claimMode: VISUAL_STRUCTURE_ONLY
    };
  }

  function sanitizeVisualStructureBlueprint(input, options) {
    var context = createContext(options);
    if (!isPlainObject(input)) fail('INVALID_CONTRACT', '结构蓝图必须是普通对象。', '$');
    assertNoVisualStructureFactFields(input, '$');
    if (ownValue(input, 'schema', context, '$.schema') !== VISUAL_STRUCTURE_BLUEPRINT_SCHEMA) fail('INVALID_SCHEMA', '结构蓝图 schema 无效。', '$.schema');
    if (Number(ownValue(input, 'schemaVersion', context, '$.schemaVersion')) !== VISUAL_STRUCTURE_SCHEMA_VERSION) fail('INVALID_SCHEMA_VERSION', '结构蓝图 schemaVersion 必须为 2。', '$.schemaVersion');
    if (ownValue(input, 'claimMode', context, '$.claimMode') !== VISUAL_STRUCTURE_ONLY) fail('INVALID_CLAIM_MODE', '结构蓝图必须声明 visual_structure_only。', '$.claimMode');
    var sourceSnapshotId = idValue(ownValue(input, 'sourceSnapshotId', context, '$.sourceSnapshotId'), '$.sourceSnapshotId', context, { required: true });
    var blueprintId = idValue(ownValue(input, 'blueprintId', context, '$.blueprintId'), '$.blueprintId', context, { required: true });
    if (blueprintId !== stableHash(sourceSnapshotId, 'rdp_')) fail('ID_MISMATCH', '结构 blueprintId 与来源快照不匹配。', '$.blueprintId');
    var revision = positiveIntegerValue(ownValue(input, 'revision', context, '$.revision'), '$.revision');
    var createdAt = timestampValue(ownValue(input, 'createdAt', context, '$.createdAt'), '$.createdAt', context);
    var updatedAt = timestampValue(ownValue(input, 'updatedAt', context, '$.updatedAt'), '$.updatedAt', context, createdAt);
    var approvalStatus = enumValue(ownValue(input, 'approvalStatus', context, '$.approvalStatus'), BLUEPRINT_APPROVAL_STATUSES, 'draft', '$.approvalStatus');
    if (approvalStatus !== 'draft' && approvalStatus !== 'approved') fail('INVALID_APPROVAL_STATE', '结构蓝图只接受 draft/approved。', '$.approvalStatus');
    var analysisFingerprint = idValue(ownValue(input, 'analysisFingerprint', context, '$.analysisFingerprint'), '$.analysisFingerprint', context, { required: true });
    var modulesInput = arrayValue(ownValue(input, 'modules', context, '$.modules'), '$.modules', context.limits.maxBlocks, true);
    if (!modulesInput.length) fail('REQUIRED_FIELD', '结构蓝图至少需要一个模块。', '$.modules');
    var moduleIds = Object.create(null);
    var moduleOrders = Object.create(null);
    var modules = modulesInput.map(function (item, index) {
      var module = sanitizeVisualStructureModule(item, index, context, blueprintId);
      if (moduleIds[module.moduleId]) fail('DUPLICATE_ID', '结构蓝图 moduleId 重复。', '$.modules[' + index + '].moduleId');
      if (module.order >= modulesInput.length || moduleOrders[module.order]) fail('INVALID_MODULE_ORDER', '结构模块 order 必须是 0..n-1 的唯一整数。', '$.modules[' + index + '].order');
      moduleIds[module.moduleId] = true;
      moduleOrders[module.order] = true;
      return module;
    }).sort(function (a, b) { return a.order - b.order; });
    sanitizeInputWarnings(ownValue(input, 'warnings', context, '$.warnings'), context);
    return deepFreeze({
      schema: VISUAL_STRUCTURE_BLUEPRINT_SCHEMA,
      schemaVersion: VISUAL_STRUCTURE_SCHEMA_VERSION,
      claimMode: VISUAL_STRUCTURE_ONLY,
      blueprintId: blueprintId,
      sourceSnapshotId: sourceSnapshotId,
      analysisFingerprint: analysisFingerprint,
      revision: revision,
      approvalStatus: approvalStatus,
      approval: sanitizeVisualStructureApproval(ownValue(input, 'approval', context, '$.approval'), approvalStatus, context),
      createdAt: createdAt,
      updatedAt: updatedAt,
      modules: modules,
      warnings: sortedIssues(context)
    });
  }

  var VISUAL_STRUCTURE_DIRECTION_FORBIDDEN = /(?:https?:\/\/|www\.|价格|售价|到手价|券后价|原价|现价|优惠价|折扣|满减|销量|月销|已售|成交量|评价|评论|好评|评分|检测|检验|质检|测试报告|认证|证书|资质|专利|品牌|商标|logo)/i;

  function expectedVisualStructureRiskFlags(module, snapshot) {
    var lookup = snapshotLookup(snapshot);
    var flags = [];
    module.sourceBlockIds.forEach(function (blockId) {
      flags = flags.concat(riskFlagsForBlock(lookup.blocks[blockId], lookup.assets));
    });
    return Array.from(new Set(flags)).sort(compareCodeUnits);
  }

  function assertSafeVisualStructureDirection(module, path, snapshot) {
    var direction = String(module.visualBrief && module.visualBrief.description || '').trim();
    if (!direction) fail('CORE_DIRECTION_REQUIRED', '结构专用蓝图每个选中模块都必须有视觉方向。', path + '.visualBrief.description');
    if (direction.length > 160 || /[\r\n\u2028\u2029]/.test(direction)) fail('INVALID_CORE_DIRECTION', '视觉方向必须为 1–160 字单行文本。', path + '.visualBrief.description');
    var lookup = snapshotLookup(snapshot).blocks;
    var brief = module.visualBrief || {};
    var entries = [
      ['description', brief.description], ['layout', brief.layout], ['mood', brief.mood],
      ['shotType', brief.shotType], ['subjectPlacement', brief.subjectPlacement],
      ['background', brief.background], ['lighting', brief.lighting], ['density', brief.density],
      ['transition', brief.transition]
    ];
    ['palette', 'textZones', 'mustKeep', 'avoid'].forEach(function (key) {
      (brief[key] || []).forEach(function (value, index) { entries.push([key + '[' + index + ']', value]); });
    });
    entries.forEach(function (entry) {
      var fieldPath = path + '.visualBrief.' + entry[0];
      var value = String(entry[1] || '').trim();
      if (!value) return;
      var isAvoid = entry[0].indexOf('avoid[') === 0;
      if (!isAvoid && (VISUAL_STRUCTURE_DIRECTION_FORBIDDEN.test(value) || CORE_DIRECTION_PRICE_VALUE.test(value) ||
          CORE_DIRECTION_QUANTIFIED_FACT.test(coreDirectionFactScanText(value)))) {
        fail('UNSAFE_CORE_DIRECTION', '视觉结构字段不得固化价格、销量、认证、品牌或具体参数事实。', fieldPath);
      }
      var normalized = normalizedComparableText(value);
      module.sourceBlockIds.forEach(function (blockId) {
        var block = lookup[blockId];
        [block && block.sourceSummary, block && block.text].forEach(function (sourceText) {
          var sourceNormalized = normalizedComparableText(sourceText);
          if (sourceNormalized && (normalized === sourceNormalized || normalized.indexOf(sourceNormalized) >= 0 || directionContainsSourceFragment(normalized, sourceText))) {
            fail('SOURCE_CONTENT_LEAK', '视觉结构字段不得复制来源摘要或来源文案。', fieldPath);
          }
        });
      });
      if (sourceFactNeedles(snapshot).some(function (needle) { return normalized.indexOf(needle) >= 0; })) {
        fail('SOURCE_FACT_LEAK', '视觉结构字段不得复制来源商品事实。', fieldPath);
      }
    });
  }

  function assertVisualStructureBlueprintAgainstSource(blueprintInput, snapshotInput, options, immediatePreviousInput) {
    options = isPlainObject(options) ? options : {};
    var blueprint = sanitizeVisualStructureBlueprint(blueprintInput, options);
    var snapshot = sanitizeSourceSnapshot(snapshotInput, options);
    if (blueprint.sourceSnapshotId !== snapshot.snapshotId) fail('SOURCE_SNAPSHOT_MISMATCH', '结构蓝图与来源快照不匹配。', '$.sourceSnapshotId');
    var blockLookup = snapshotLookup(snapshot).blocks;
    blueprint.modules.forEach(function (module, index) {
      var path = '$.modules[' + index + ']';
      var canonical = canonicalSourceBlockIds(module.sourceBlockIds, snapshot, path + '.sourceBlockIds');
      if (stableSerialize(canonical) !== stableSerialize(module.sourceBlockIds)) fail('SOURCE_DERIVATION_MISMATCH', '结构 lineage 必须按来源顺序规范化。', path + '.sourceBlockIds');
      var expectedOriginalIndex = Math.min.apply(Math, canonical.map(function (blockId) { return blockLookup[blockId].originalIndex; }));
      if (module.originalIndex !== expectedOriginalIndex) fail('SOURCE_DERIVATION_MISMATCH', '结构模块原始位置与来源 lineage 不匹配。', path + '.originalIndex');
      if (stableSerialize(module.riskFlags) !== stableSerialize(expectedVisualStructureRiskFlags(module, snapshot))) {
        fail('SOURCE_DERIVATION_MISMATCH', '结构模块风险必须由来源 lineage 严格派生。', path + '.riskFlags');
      }
      if (blueprint.approvalStatus === 'approved' && module.selected) {
        if (module.riskFlags.indexOf('SOURCE_BLOCKED') >= 0 || module.riskFlags.indexOf('BLOCKED_ASSET') >= 0) fail('SOURCE_BLOCKED', 'blocked 来源模块不可批准。', path);
        assertSafeVisualStructureDirection(module, path, snapshot);
      }
    });
    var previousInput = immediatePreviousInput == null ? ownValue(options, 'previousBlueprint') : immediatePreviousInput;
    if (blueprint.revision === 1 && previousInput != null) fail('INVALID_REVISION_CHAIN', '结构蓝图 revision 1 不得携带上一 revision。', '$options.previousBlueprint');
    if (blueprint.revision > 1 && previousInput == null) fail('PREVIOUS_BLUEPRINT_REQUIRED', '结构蓝图 revision > 1 必须携带直接前一 revision。', '$options.previousBlueprint');
    var previous = previousInput == null ? null : sanitizeVisualStructureBlueprint(previousInput, options);
    if (previous) {
      if (previous.blueprintId !== blueprint.blueprintId || previous.sourceSnapshotId !== blueprint.sourceSnapshotId ||
          previous.revision + 1 !== blueprint.revision) {
        fail('INVALID_REVISION_CHAIN', '结构蓝图 revision 链身份或序号不连续。', '$options.previousBlueprint');
      }
      if (blueprint.approvalStatus === 'approved') {
        if (previous.approvalStatus !== 'draft' || previous.analysisFingerprint !== blueprint.analysisFingerprint ||
            stableSerialize(previous.modules) !== stableSerialize(blueprint.modules)) {
          fail('INVALID_APPROVAL_TRANSITION', '结构审批只能从相同结构的直接前一 draft 单独迁移。', '$.approvalStatus');
        }
      } else if (blueprint.approvalStatus !== 'draft') {
        fail('UNPROVEN_APPROVAL_STATE', '结构修订只能保持 draft。', '$.approvalStatus');
      }
    }
    return { blueprint: blueprint, snapshot: snapshot, previous: previous };
  }

  function validateVisualStructureBlueprintAgainstSource(blueprintInput, snapshotInput, options) {
    try {
      var checked = assertVisualStructureBlueprintAgainstSource(blueprintInput, snapshotInput, options);
      return deepFreeze({ ok: true, value: checked.blueprint, errors: [], warnings: checked.blueprint.warnings || [] });
    } catch (error) {
      return deepFreeze({ ok: false, value: null, errors: [{ code: error.code || 'CONTRACT_ERROR', message: String(error.message || error), path: error.path || '$', severity: 'error' }], warnings: [] });
    }
  }

  function projectVisualStructureBlueprint(blueprintInput, snapshotInput, options) {
    options = isPlainObject(options) ? options : {};
    var checked = assertBlueprintAgainstSource(blueprintInput, snapshotInput, options);
    var blueprint = checked.blueprint;
    var previousVisualInput = ownValue(options, 'previousVisualBlueprint');
    var previousVisual = null;
    if (previousVisualInput != null) {
      var previousVisualImmediate = ownValue(options, 'previousVisualImmediatePreviousBlueprint');
      if (Number(previousVisualInput && previousVisualInput.revision) > 1 && previousVisualImmediate == null) {
        fail('PREVIOUS_BLUEPRINT_REQUIRED', '连续结构投影必须同时提供上一 V2 envelope 的 immediatePreviousBlueprint。', '$options.previousVisualImmediatePreviousBlueprint');
      }
      previousVisual = createVisualStructureRevisionEnvelope(
        previousVisualInput, previousVisualImmediate == null ? null : previousVisualImmediate, checked.snapshot, optionsWithoutPrevious(options)
      ).currentBlueprint;
    }
    var createdAt = ownValue(options, 'createdAt') || blueprint.updatedAt;
    var raw = {
      schema: VISUAL_STRUCTURE_BLUEPRINT_SCHEMA,
      schemaVersion: VISUAL_STRUCTURE_SCHEMA_VERSION,
      claimMode: VISUAL_STRUCTURE_ONLY,
      blueprintId: blueprint.blueprintId,
      sourceSnapshotId: blueprint.sourceSnapshotId,
      analysisFingerprint: stableHash({ schema: blueprint.schema, revision: blueprint.revision, modules: blueprint.modules }, 'rdanalysis_'),
      revision: previousVisual ? previousVisual.revision + 1 : 1,
      approvalStatus: 'draft',
      approval: { approvedAt: '', verificationId: '', claimMode: VISUAL_STRUCTURE_ONLY },
      createdAt: previousVisual ? previousVisual.createdAt : createdAt,
      updatedAt: createdAt,
      modules: blueprint.modules.map(function (module) {
        return {
          moduleId: module.moduleId,
          blockId: module.moduleId,
          sourceBlockIds: module.sourceBlockIds.slice(),
          derivation: cloneJson(module.derivation),
          originalIndex: module.originalIndex,
          order: module.order,
          type: module.type,
          salesRole: module.salesRole,
          visualBrief: cloneJson(module.visualBrief),
          selected: module.selected,
          locked: module.locked,
          riskFlags: expectedVisualStructureRiskFlags(module, checked.snapshot)
        };
      })
    };
    return assertVisualStructureBlueprintAgainstSource(raw, checked.snapshot, optionsWithoutPrevious(options), previousVisual).blueprint;
  }

  function approveVisualStructureBlueprint(blueprintInput, snapshotInput, approvalContext, options) {
    approvalContext = isPlainObject(approvalContext) ? approvalContext : {};
    options = isPlainObject(options) ? options : {};
    var baseOptions = optionsWithoutPrevious(options);
    var checked = assertVisualStructureBlueprintAgainstSource(blueprintInput, snapshotInput, options);
    var blueprint = checked.blueprint;
    if (blueprint.approvalStatus !== 'draft') fail('INVALID_APPROVAL_TRANSITION', '只有结构 draft 可执行确认。', '$.approvalStatus');
    if (!blueprint.modules.some(function (module) { return module.selected; })) fail('NO_SELECTED_MODULE', '结构确认至少需要一个选中模块。', '$.modules');
    var directionOwners = Object.create(null);
    blueprint.modules.forEach(function (module, index) {
      if (!module.selected) return;
      assertSafeVisualStructureDirection(module, '$.modules[' + index + ']', checked.snapshot);
      var comparable = normalizedComparableText(module.visualBrief.description);
      if (directionOwners[comparable] != null) fail('SCREEN_DIRECTION_DUPLICATE', '每个结构分屏必须有独立视觉方向。', '$.modules[' + index + '].visualBrief.description');
      directionOwners[comparable] = index;
    });
    var context = createContext(options);
    assertNoVisualStructureFactFields(approvalContext, '$approval');
    var approvedAt = timestampValue(ownValue(approvalContext, 'approvedAt'), '$approval.approvedAt', context);
    var verificationId = idValue(ownValue(approvalContext, 'verificationId'), '$approval.verificationId', context, { required: true });
    var raw = cloneJson(blueprint);
    raw.revision = blueprint.revision + 1;
    raw.approvalStatus = 'approved';
    raw.approval = { approvedAt: approvedAt, verificationId: verificationId, claimMode: VISUAL_STRUCTURE_ONLY };
    raw.updatedAt = approvedAt;
    return assertVisualStructureBlueprintAgainstSource(raw, checked.snapshot, baseOptions, blueprint).blueprint;
  }

  function createVisualStructureRevisionEnvelope(currentBlueprintInput, immediatePreviousInput, snapshotInput, options) {
    var current = sanitizeVisualStructureBlueprint(currentBlueprintInput, options);
    if (current.revision === 1 && immediatePreviousInput != null) fail('INVALID_REVISION_CHAIN', '结构 revision 1 envelope 不得含前一版本。', '$envelope.immediatePreviousBlueprint');
    if (current.revision > 1 && immediatePreviousInput == null) fail('PREVIOUS_BLUEPRINT_REQUIRED', '结构 revision > 1 envelope 必须含直接前一版本。', '$envelope.immediatePreviousBlueprint');
    var checked = assertVisualStructureBlueprintAgainstSource(current, snapshotInput, optionsWithoutPrevious(options), immediatePreviousInput);
    return deepFreeze({ currentBlueprint: checked.blueprint, immediatePreviousBlueprint: checked.previous });
  }

  function advanceVisualStructureRevisionEnvelope(envelopeInput, nextBlueprintInput, snapshotInput, options) {
    if (!isPlainObject(envelopeInput)) fail('INVALID_REVISION_ENVELOPE', '结构 revision envelope 必须是普通对象。', '$envelope');
    var restored = createVisualStructureRevisionEnvelope(
      ownValue(envelopeInput, 'currentBlueprint'), ownValue(envelopeInput, 'immediatePreviousBlueprint'), snapshotInput, options
    );
    var checked = assertVisualStructureBlueprintAgainstSource(nextBlueprintInput, snapshotInput, optionsWithoutPrevious(options), restored.currentBlueprint);
    return deepFreeze({ currentBlueprint: checked.blueprint, immediatePreviousBlueprint: restored.currentBlueprint });
  }

  function sanitizeVisualStructureBatchTask(item, index, context, blueprintId, blueprintRevision) {
    var path = '$.tasks[' + index + ']';
    if (!isPlainObject(item)) fail('INVALID_BATCH_TASK', '结构批量任务必须是普通对象。', path);
    assertNoVisualStructureFactFields(item, path);
    var subjectAssetIds = arrayValue(ownValue(item, 'subjectAssetIds', context, path + '.subjectAssetIds'), path + '.subjectAssetIds', context.limits.maxSubjectAssetsPerTask, true)
      .map(function (id, assetIndex) { return idValue(id, path + '.subjectAssetIds[' + assetIndex + ']', context, { required: true }); });
    var modelAssetIds = arrayValue(ownValue(item, 'modelAssetIds', context, path + '.modelAssetIds'), path + '.modelAssetIds', context.limits.maxSubjectAssetsPerTask, false)
      .map(function (id, assetIndex) { return idValue(id, path + '.modelAssetIds[' + assetIndex + ']', context, { required: true }); });
    subjectAssetIds = Array.from(new Set(subjectAssetIds)).sort(compareCodeUnits);
    modelAssetIds = Array.from(new Set(modelAssetIds)).sort(compareCodeUnits);
    if (!subjectAssetIds.length) fail('SUBJECT_ASSET_REQUIRED', '结构批量目标至少需要一张主体素材。', path + '.subjectAssetIds');
    if (modelAssetIds.some(function (assetId) { return subjectAssetIds.indexOf(assetId) >= 0; })) fail('TARGET_ASSET_ROLE_MISMATCH', '同一素材不得同时声明 subject 与 model。', path + '.modelAssetIds');
    var skuIds = arrayValue(ownValue(item, 'skuIds', context, path + '.skuIds'), path + '.skuIds', context.limits.maxSkuIdsPerTask, false)
      .map(function (id, skuIndex) { return idValue(id, path + '.skuIds[' + skuIndex + ']', context, { required: true }); });
    var errors = arrayValue(ownValue(item, 'errors', context, path + '.errors'), path + '.errors', context.limits.maxErrorsPerTask, false)
      .map(function (error, errorIndex) { return sanitizeTaskError(error, path + '.errors[' + errorIndex + ']', context); });
    var resultRefs = arrayValue(ownValue(item, 'resultRefs', context, path + '.resultRefs'), path + '.resultRefs', context.limits.maxResultsPerTask, false)
      .map(function (result, resultIndex) { return sanitizeResultRef(result, path + '.resultRefs[' + resultIndex + ']', context); });
    var task = {
      taskId: idValue(ownValue(item, 'taskId', context, path + '.taskId'), path + '.taskId', context, { required: true }),
      taskKey: idValue(ownValue(item, 'taskKey', context, path + '.taskKey'), path + '.taskKey', context),
      targetInputId: idValue(ownValue(item, 'targetInputId', context, path + '.targetInputId'), path + '.targetInputId', context, { required: true }),
      subjectAssetIds: subjectAssetIds,
      modelAssetIds: modelAssetIds,
      skuIds: Array.from(new Set(skuIds)).sort(compareCodeUnits),
      status: enumValue(ownValue(item, 'status', context, path + '.status'), TASK_STATUSES, 'pending', path + '.status'),
      errors: errors,
      resultRefs: resultRefs
    };
    var expectedId = stableHash({
      claimMode: VISUAL_STRUCTURE_ONLY,
      blueprintId: blueprintId,
      revision: blueprintRevision,
      targetInputId: task.targetInputId,
      taskKey: task.taskKey,
      subjectAssetIds: task.subjectAssetIds,
      modelAssetIds: task.modelAssetIds,
      skuIds: task.skuIds
    }, 'rdt2_');
    if (task.taskId !== expectedId) fail('ID_MISMATCH', 'V2 taskId 与主体/模特完整身份不匹配。', path + '.taskId');
    return task;
  }

  function visualStructureBatchIdentity(blueprintId, revision, batchKey, screenCount, tasks) {
    return {
      claimMode: VISUAL_STRUCTURE_ONLY,
      blueprintId: blueprintId,
      blueprintRevision: revision,
      batchKey: batchKey,
      screenCount: screenCount,
      taskIds: tasks.map(function (task) { return task.taskId; })
    };
  }

  function sanitizeVisualStructureBatchProject(input, options) {
    var context = createContext(options);
    if (!isPlainObject(input)) fail('INVALID_CONTRACT', '结构批量项目必须是普通对象。', '$');
    assertNoVisualStructureFactFields(input, '$');
    if (ownValue(input, 'schema', context, '$.schema') !== VISUAL_STRUCTURE_BATCH_SCHEMA ||
        Number(ownValue(input, 'schemaVersion', context, '$.schemaVersion')) !== VISUAL_STRUCTURE_SCHEMA_VERSION) {
      fail('INVALID_SCHEMA', '结构批量项目 schema 无效。', '$.schema');
    }
    if (ownValue(input, 'claimMode', context, '$.claimMode') !== VISUAL_STRUCTURE_ONLY) fail('INVALID_CLAIM_MODE', '结构批次 claimMode 无效。', '$.claimMode');
    var blueprintId = idValue(ownValue(input, 'blueprintId', context, '$.blueprintId'), '$.blueprintId', context, { required: true });
    var blueprintRevision = positiveIntegerValue(ownValue(input, 'blueprintRevision', context, '$.blueprintRevision'), '$.blueprintRevision');
    var batchKey = idValue(ownValue(input, 'batchKey', context, '$.batchKey'), '$.batchKey', context);
    var screenCount = screenCountValue(ownValue(input, 'screenCount', context, '$.screenCount'), '$.screenCount');
    var tasksInput = arrayValue(ownValue(input, 'tasks', context, '$.tasks'), '$.tasks', context.limits.maxBatchTasks, true);
    if (!tasksInput.length) fail('REQUIRED_FIELD', '结构批量项目至少需要一个任务。', '$.tasks');
    var ids = Object.create(null);
    var targetIds = Object.create(null);
    var tasks = tasksInput.map(function (item, index) {
      var task = sanitizeVisualStructureBatchTask(item, index, context, blueprintId, blueprintRevision);
      if (ids[task.taskId] || targetIds[task.targetInputId]) fail('DUPLICATE_ID', '结构批次任务或 targetInputId 重复。', '$.tasks[' + index + ']');
      ids[task.taskId] = true;
      targetIds[task.targetInputId] = true;
      if ((task.status === 'failed' || task.status === 'blocked') && !task.errors.length) fail('TASK_STATE_MISMATCH', 'failed/blocked 任务必须带错误。', '$.tasks[' + index + '].errors');
      return task;
    });
    var expectedBatchId = stableHash(visualStructureBatchIdentity(blueprintId, blueprintRevision, batchKey, screenCount, tasks), 'rdbatch2_');
    var batchId = idValue(ownValue(input, 'batchId', context, '$.batchId'), '$.batchId', context, { required: true });
    if (batchId !== expectedBatchId) fail('ID_MISMATCH', 'V2 batchId 与完整任务身份不匹配。', '$.batchId');
    var status = derivedBatchStatus(tasks);
    if (enumValue(ownValue(input, 'status', context, '$.status'), BATCH_STATUSES, status, '$.status') !== status) fail('BATCH_STATUS_MISMATCH', '结构批次状态与任务汇总不一致。', '$.status');
    var createdAt = timestampValue(ownValue(input, 'createdAt', context, '$.createdAt'), '$.createdAt', context);
    var updatedAt = timestampValue(ownValue(input, 'updatedAt', context, '$.updatedAt'), '$.updatedAt', context, createdAt);
    return deepFreeze({
      schema: VISUAL_STRUCTURE_BATCH_SCHEMA,
      schemaVersion: VISUAL_STRUCTURE_SCHEMA_VERSION,
      claimMode: VISUAL_STRUCTURE_ONLY,
      batchId: batchId,
      batchKey: batchKey,
      blueprintId: blueprintId,
      blueprintRevision: blueprintRevision,
      sourceSnapshotId: idValue(ownValue(input, 'sourceSnapshotId', context, '$.sourceSnapshotId'), '$.sourceSnapshotId', context, { required: true }),
      createdAt: createdAt,
      updatedAt: updatedAt,
      status: status,
      screenCount: screenCount,
      maxReferenceImagesPerCall: 0,
      tasks: tasks,
      warnings: sortedIssues(context)
    });
  }

  function assertVisualStructureTargetAsset(assetRegistry, assetId, role, path) {
    var verified = assetRegistry[assetId];
    if (!verified || (verified.rightsStatus !== 'authorized' && verified.rightsStatus !== 'self_owned')) {
      fail('UNVERIFIED_TARGET_ASSET', '目标素材未通过可信授权 registry。', path);
    }
    if (verified.role !== role) fail('TARGET_ASSET_ROLE_MISMATCH', '目标素材角色与 subject/model 槽位不一致。', path);
  }

  function createVisualStructureBatchProject(blueprintInput, targets, options) {
    options = isPlainObject(options) ? options : {};
    var snapshotInput = ownValue(options, 'sourceSnapshot');
    if (!snapshotInput) fail('SOURCE_SNAPSHOT_REQUIRED', '创建结构批次必须提供来源快照。', '$options.sourceSnapshot');
    var checked = assertVisualStructureBlueprintAgainstSource(blueprintInput, snapshotInput, options);
    var blueprint = checked.blueprint;
    if (blueprint.approvalStatus !== 'approved') fail('BLUEPRINT_NOT_APPROVED', '只有 approved 结构蓝图可创建批次。', '$.approvalStatus');
    var context = createContext(options);
    var assetRegistry = verifiedTargetAssetRegistry(options, context);
    var limits = normalizedLimits(options);
    targets = arrayValue(targets, '$targets', limits.maxBatchTasks, true);
    if (!targets.length) fail('REQUIRED_FIELD', '结构批次至少需要一个目标。', '$targets');
    var tasks = targets.map(function (target, index) {
      var path = '$targets[' + index + ']';
      if (!isPlainObject(target)) fail('INVALID_BATCH_TARGET', '结构批次目标必须是普通对象。', path);
      assertNoVisualStructureFactFields(target, path);
      var targetInputId = idValue(ownValue(target, 'targetInputId'), path + '.targetInputId', context, { required: true });
      var taskKey = idValue(ownValue(target, 'taskKey'), path + '.taskKey', context);
      var subjectAssetIds = arrayValue(ownValue(target, 'subjectAssetIds'), path + '.subjectAssetIds', limits.maxSubjectAssetsPerTask, true)
        .map(function (id, assetIndex) { return idValue(id, path + '.subjectAssetIds[' + assetIndex + ']', context, { required: true }); });
      var modelAssetIds = arrayValue(ownValue(target, 'modelAssetIds'), path + '.modelAssetIds', limits.maxSubjectAssetsPerTask, false)
        .map(function (id, assetIndex) { return idValue(id, path + '.modelAssetIds[' + assetIndex + ']', context, { required: true }); });
      subjectAssetIds = Array.from(new Set(subjectAssetIds)).sort(compareCodeUnits);
      modelAssetIds = Array.from(new Set(modelAssetIds)).sort(compareCodeUnits);
      if (!subjectAssetIds.length) fail('SUBJECT_ASSET_REQUIRED', '每个结构目标至少需要一张主体素材。', path + '.subjectAssetIds');
      subjectAssetIds.forEach(function (assetId, assetIndex) { assertVisualStructureTargetAsset(assetRegistry, assetId, 'subject', path + '.subjectAssetIds[' + assetIndex + ']'); });
      modelAssetIds.forEach(function (assetId, assetIndex) { assertVisualStructureTargetAsset(assetRegistry, assetId, 'model', path + '.modelAssetIds[' + assetIndex + ']'); });
      if (modelAssetIds.some(function (assetId) { return subjectAssetIds.indexOf(assetId) >= 0; })) fail('TARGET_ASSET_ROLE_MISMATCH', '同一素材不得同时作为主体与模特。', path + '.modelAssetIds');
      var skuIds = arrayValue(ownValue(target, 'skuIds'), path + '.skuIds', limits.maxSkuIdsPerTask, false)
        .map(function (id, skuIndex) { return idValue(id, path + '.skuIds[' + skuIndex + ']', context, { required: true }); });
      var task = {
        taskId: '', taskKey: taskKey, targetInputId: targetInputId,
        subjectAssetIds: subjectAssetIds, modelAssetIds: modelAssetIds,
        skuIds: Array.from(new Set(skuIds)).sort(compareCodeUnits),
        status: 'pending', errors: [], resultRefs: []
      };
      task.taskId = stableHash({
        claimMode: VISUAL_STRUCTURE_ONLY, blueprintId: blueprint.blueprintId, revision: blueprint.revision,
        targetInputId: task.targetInputId, taskKey: task.taskKey,
        subjectAssetIds: task.subjectAssetIds, modelAssetIds: task.modelAssetIds, skuIds: task.skuIds
      }, 'rdt2_');
      return task;
    });
    var screenCount = screenCountValue(ownValue(options, 'screenCount'), '$options.screenCount');
    var batchKey = idValue(ownValue(options, 'batchKey'), '$options.batchKey', context);
    var createdAt = ownValue(options, 'createdAt') || blueprint.updatedAt;
    var raw = {
      schema: VISUAL_STRUCTURE_BATCH_SCHEMA, schemaVersion: VISUAL_STRUCTURE_SCHEMA_VERSION, claimMode: VISUAL_STRUCTURE_ONLY,
      batchId: stableHash(visualStructureBatchIdentity(blueprint.blueprintId, blueprint.revision, batchKey, screenCount, tasks), 'rdbatch2_'),
      batchKey: batchKey, blueprintId: blueprint.blueprintId, blueprintRevision: blueprint.revision,
      sourceSnapshotId: blueprint.sourceSnapshotId, createdAt: createdAt, updatedAt: createdAt,
      status: derivedBatchStatus(tasks), screenCount: screenCount, tasks: tasks
    };
    var batch = sanitizeVisualStructureBatchProject(raw, options);
    assertVisualStructureBatchAgainstBlueprint(batch, blueprint, options);
    return batch;
  }

  function assertVisualStructureBatchAgainstBlueprint(batchInput, blueprintInput, options) {
    options = isPlainObject(options) ? options : {};
    var batch = sanitizeVisualStructureBatchProject(batchInput, options);
    var snapshotInput = ownValue(options, 'sourceSnapshot');
    if (!snapshotInput) fail('SOURCE_SNAPSHOT_REQUIRED', '结构批次校验必须提供来源快照。', '$options.sourceSnapshot');
    var checked = assertVisualStructureBlueprintAgainstSource(blueprintInput, snapshotInput, options);
    var blueprint = checked.blueprint;
    if (blueprint.approvalStatus !== 'approved') fail('BLUEPRINT_NOT_APPROVED', '结构批次只能关联 approved 蓝图。', '$blueprint.approvalStatus');
    if (batch.blueprintId !== blueprint.blueprintId || batch.blueprintRevision !== blueprint.revision || batch.sourceSnapshotId !== blueprint.sourceSnapshotId) {
      fail('LINKAGE_MISMATCH', '结构批次与蓝图身份、revision 或快照不匹配。', '$.blueprintId');
    }
    var registry = verifiedTargetAssetRegistry(options, createContext(options));
    batch.tasks.forEach(function (task, taskIndex) {
      task.subjectAssetIds.forEach(function (assetId, assetIndex) { assertVisualStructureTargetAsset(registry, assetId, 'subject', '$.tasks[' + taskIndex + '].subjectAssetIds[' + assetIndex + ']'); });
      task.modelAssetIds.forEach(function (assetId, assetIndex) { assertVisualStructureTargetAsset(registry, assetId, 'model', '$.tasks[' + taskIndex + '].modelAssetIds[' + assetIndex + ']'); });
    });
    return { batch: batch, blueprint: blueprint };
  }

  function validateVisualStructureBatchAgainstBlueprint(batchInput, blueprintInput, options) {
    try {
      var checked = assertVisualStructureBatchAgainstBlueprint(batchInput, blueprintInput, options);
      return deepFreeze({ ok: true, value: checked.batch, errors: [], warnings: checked.batch.warnings || [] });
    } catch (error) {
      return deepFreeze({ ok: false, value: null, errors: [{ code: error.code || 'CONTRACT_ERROR', message: String(error.message || error), path: error.path || '$', severity: 'error' }], warnings: [] });
    }
  }

  function updateVisualStructureBatchProject(batchInput, changes, blueprintInput, options) {
    changes = isPlainObject(changes) ? changes : {};
    options = isPlainObject(options) ? options : {};
    var checked = assertVisualStructureBatchAgainstBlueprint(batchInput, blueprintInput, options);
    var raw = cloneJson(checked.batch);
    ['batchId', 'batchKey', 'blueprintId', 'blueprintRevision', 'sourceSnapshotId', 'screenCount', 'tasks', 'status', 'claimMode'].forEach(function (key) {
      if (ownDescriptor(changes, key)) fail('IMMUTABLE_BATCH_FIELD', '结构批次身份字段不能直接修改。', '$changes.' + key);
    });
    var updates = arrayValue(ownValue(changes, 'taskUpdates'), '$changes.taskUpdates', normalizedLimits(options).maxBatchTasks, false);
    var byId = Object.create(null);
    raw.tasks.forEach(function (task) { byId[task.taskId] = task; });
    var seen = Object.create(null);
    updates.forEach(function (update, index) {
      var path = '$changes.taskUpdates[' + index + ']';
      if (!isPlainObject(update)) fail('INVALID_TASK_UPDATE', 'taskUpdate 必须是普通对象。', path);
      ['taskKey', 'targetInputId', 'subjectAssetIds', 'modelAssetIds', 'skuIds'].forEach(function (key) {
        if (ownDescriptor(update, key)) fail('IMMUTABLE_TASK_FIELD', 'V2 任务身份字段不可修改。', path + '.' + key);
      });
      var taskId = String(ownValue(update, 'taskId') || '');
      if (!byId[taskId] || seen[taskId]) fail('UNKNOWN_OR_DUPLICATE_TASK', 'taskId 不存在或重复。', path + '.taskId');
      seen[taskId] = true;
      ['status', 'errors', 'resultRefs'].forEach(function (key) {
        var descriptor = ownDescriptor(update, key);
        if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) byId[taskId][key] = descriptor.value;
      });
    });
    raw.status = derivedBatchStatus(raw.tasks);
    raw.updatedAt = ownValue(options, 'updatedAt') || checked.batch.updatedAt;
    var updated = sanitizeVisualStructureBatchProject(raw, options);
    assertVisualStructureBatchAgainstBlueprint(updated, checked.blueprint, options);
    return updated;
  }

  function sanitizeTaskError(item, path, context) {
    if (!isPlainObject(item)) fail('INVALID_TASK_ERROR', '任务错误必须是普通对象。', path);
    return {
      code: idValue(ownValue(item, 'code', context, path + '.code'), path + '.code', context, { required: true, max: 80 }),
      stage: idValue(ownValue(item, 'stage', context, path + '.stage') || 'unknown', path + '.stage', context, { required: true, max: 80 }),
      message: textValue(ownValue(item, 'message', context, path + '.message'), path + '.message', context, { required: true, max: context.limits.maxShortTextLength }),
      retryable: booleanValue(ownValue(item, 'retryable'), false)
    };
  }

  function sanitizeResultRef(item, path, context) {
    if (!isPlainObject(item)) fail('INVALID_RESULT_REF', '结果引用必须是普通对象。', path);
    return {
      resultId: idValue(ownValue(item, 'resultId', context, path + '.resultId'), path + '.resultId', context, { required: true }),
      kind: enumValue(ownValue(item, 'kind', context, path + '.kind'), RESULT_KINDS, 'unknown', path + '.kind'),
      ref: idValue(ownValue(item, 'ref', context, path + '.ref'), path + '.ref', context, { required: true, max: 500 })
    };
  }

  function sanitizeBatchTask(item, index, context) {
    var path = '$.tasks[' + index + ']';
    if (!isPlainObject(item)) fail('INVALID_BATCH_TASK', '批量任务必须是普通对象。', path);
    var subjectAssetIds = arrayValue(ownValue(item, 'subjectAssetIds', context, path + '.subjectAssetIds'), path + '.subjectAssetIds', context.limits.maxSubjectAssetsPerTask, false)
      .map(function (id, assetIndex) { return idValue(id, path + '.subjectAssetIds[' + assetIndex + ']', context, { required: true }); });
    var skuIds = arrayValue(ownValue(item, 'skuIds', context, path + '.skuIds'), path + '.skuIds', context.limits.maxSkuIdsPerTask, false)
      .map(function (id, skuIndex) { return idValue(id, path + '.skuIds[' + skuIndex + ']', context, { required: true }); });
    var errors = arrayValue(ownValue(item, 'errors', context, path + '.errors'), path + '.errors', context.limits.maxErrorsPerTask, false)
      .map(function (error, errorIndex) { return sanitizeTaskError(error, path + '.errors[' + errorIndex + ']', context); });
    var resultRefs = arrayValue(ownValue(item, 'resultRefs', context, path + '.resultRefs'), path + '.resultRefs', context.limits.maxResultsPerTask, false)
      .map(function (result, resultIndex) { return sanitizeResultRef(result, path + '.resultRefs[' + resultIndex + ']', context); });
    return {
      taskId: idValue(ownValue(item, 'taskId', context, path + '.taskId'), path + '.taskId', context, { required: true }),
      taskKey: idValue(ownValue(item, 'taskKey', context, path + '.taskKey'), path + '.taskKey', context),
      productFactCardId: idValue(ownValue(item, 'productFactCardId', context, path + '.productFactCardId'), path + '.productFactCardId', context, { required: true }),
      subjectAssetIds: Array.from(new Set(subjectAssetIds)).sort(compareCodeUnits),
      skuIds: Array.from(new Set(skuIds)).sort(compareCodeUnits),
      status: enumValue(ownValue(item, 'status', context, path + '.status'), TASK_STATUSES, 'pending', path + '.status'),
      errors: errors,
      resultRefs: resultRefs
    };
  }

  function taskIdentity(blueprintId, blueprintRevision, task) {
    return {
      blueprintId: blueprintId,
      revision: blueprintRevision,
      taskKey: task.taskKey,
      productFactCardId: task.productFactCardId,
      subjectAssetIds: task.subjectAssetIds.slice(),
      skuIds: task.skuIds.slice()
    };
  }

  function batchIdentity(blueprintId, blueprintRevision, batchKey, screenCount, tasks) {
    return {
      blueprintId: blueprintId,
      blueprintRevision: blueprintRevision,
      batchKey: batchKey,
      screenCount: screenCount,
      taskIds: tasks.map(function (task) { return task.taskId; })
    };
  }

  function derivedBatchStatus(tasks) {
    var statuses = tasks.map(function (task) { return task.status; });
    if (statuses.indexOf('running') >= 0) return 'running';
    if (statuses.every(function (status) { return status === 'completed'; })) return 'completed';
    if (statuses.indexOf('failed') >= 0) {
      return statuses.some(function (status) { return status === 'completed' || status === 'cancelled' || status === 'blocked'; }) ? 'partial' : 'failed';
    }
    if (statuses.indexOf('blocked') >= 0) return 'blocked';
    if (statuses.every(function (status) { return status === 'cancelled'; })) return 'cancelled';
    if (statuses.some(function (status) { return status === 'completed' || status === 'cancelled'; })) return 'partial';
    return 'ready';
  }

  function sanitizeBatchProject(input, options) {
    var context = createContext(options);
    if (!isPlainObject(input)) fail('INVALID_CONTRACT', '批量项目必须是普通对象。', '$');
    if (ownValue(input, 'schema', context, '$.schema') !== BATCH_SCHEMA) fail('INVALID_SCHEMA', '批量项目 schema 无效。', '$.schema');
    if (Number(ownValue(input, 'schemaVersion', context, '$.schemaVersion')) !== SCHEMA_VERSION) fail('INVALID_SCHEMA_VERSION', 'schemaVersion 必须为 1。', '$.schemaVersion');
    var blueprintId = idValue(ownValue(input, 'blueprintId', context, '$.blueprintId'), '$.blueprintId', context, { required: true });
    var blueprintRevision = positiveIntegerValue(ownValue(input, 'blueprintRevision', context, '$.blueprintRevision'), '$.blueprintRevision');
    var batchKey = idValue(ownValue(input, 'batchKey', context, '$.batchKey'), '$.batchKey', context);
    var screenCount = screenCountValue(ownValue(input, 'screenCount', context, '$.screenCount'), '$.screenCount');
    var tasksInput = arrayValue(ownValue(input, 'tasks', context, '$.tasks'), '$.tasks', context.limits.maxBatchTasks, true);
    if (!tasksInput.length) fail('REQUIRED_FIELD', '批量项目至少需要一个任务。', '$.tasks');
    var tasks = [];
    var ids = Object.create(null);
    tasksInput.forEach(function (item, index) {
      var task = sanitizeBatchTask(item, index, context);
      if (ids[task.taskId]) fail('DUPLICATE_ID', '批量 taskId 重复。', '$.tasks[' + index + '].taskId');
      var expectedTaskId = stableHash(taskIdentity(blueprintId, blueprintRevision, task), 'rdt_');
      if (task.taskId !== expectedTaskId) fail('ID_MISMATCH', 'taskId 与规范化任务载荷不匹配。', '$.tasks[' + index + '].taskId');
      if ((task.status === 'failed' || task.status === 'blocked') && !task.errors.length) {
        fail('TASK_STATE_MISMATCH', 'failed/blocked 任务必须包含结构化错误。', '$.tasks[' + index + '].errors');
      }
      ids[task.taskId] = true;
      tasks.push(task);
    });
    var expectedBatchId = stableHash(batchIdentity(blueprintId, blueprintRevision, batchKey, screenCount, tasks), 'rdbatch_');
    var batchId = idValue(ownValue(input, 'batchId', context, '$.batchId'), '$.batchId', context, { required: true });
    if (batchId !== expectedBatchId) fail('ID_MISMATCH', 'batchId 与规范化批次载荷不匹配。', '$.batchId');
    var expectedStatus = derivedBatchStatus(tasks);
    var requestedStatus = enumValue(ownValue(input, 'status', context, '$.status'), BATCH_STATUSES, expectedStatus, '$.status');
    if (requestedStatus !== expectedStatus) fail('BATCH_STATUS_MISMATCH', '批次 status 与任务汇总状态不一致。', '$.status');
    var createdAt = timestampValue(ownValue(input, 'createdAt', context, '$.createdAt'), '$.createdAt', context);
    var updatedAt = timestampValue(ownValue(input, 'updatedAt', context, '$.updatedAt'), '$.updatedAt', context, createdAt);
    sanitizeInputWarnings(ownValue(input, 'warnings', context, '$.warnings'), context);
    return deepFreeze({
      schema: BATCH_SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      batchId: batchId,
      batchKey: batchKey,
      blueprintId: blueprintId,
      blueprintRevision: blueprintRevision,
      sourceSnapshotId: idValue(ownValue(input, 'sourceSnapshotId', context, '$.sourceSnapshotId'), '$.sourceSnapshotId', context, { required: true }),
      createdAt: createdAt,
      updatedAt: updatedAt,
      status: expectedStatus,
      screenCount: screenCount,
      maxReferenceImagesPerCall: 6,
      tasks: tasks,
      warnings: sortedIssues(context)
    });
  }

  function createBatchProject(blueprintInput, targets, options) {
    options = isPlainObject(options) ? options : {};
    var sourceSnapshot = ownValue(options, 'sourceSnapshot');
    if (!sourceSnapshot) fail('SOURCE_SNAPSHOT_REQUIRED', '创建批次必须提供可信不可变来源快照用于交叉校验。', '$options.sourceSnapshot');
    var checkedBlueprint = assertBlueprintAgainstSource(blueprintInput, sourceSnapshot, options);
    var blueprint = checkedBlueprint.blueprint;
    if (blueprint.approvalStatus !== 'approved') fail('BLUEPRINT_NOT_APPROVED', '只有审核通过的蓝图才能创建批量项目。', '$.approvalStatus');
    var limits = normalizedLimits(options);
    var trustContext = createContext(options);
    var assetRegistry = verifiedTargetAssetRegistry(options, trustContext);
    var factRegistry = verifiedFactCardRegistry(options, trustContext);
    var screenCount = screenCountValue(ownValue(options, 'screenCount'), '$options.screenCount');
    var batchKey = idValue(ownValue(options, 'batchKey'), '$options.batchKey', trustContext);
    targets = arrayValue(targets, '$targets', limits.maxBatchTasks, true);
    if (!targets.length) fail('REQUIRED_FIELD', '批量项目至少需要一个商品绑定。', '$targets');
    var rawTasks = targets.map(function (target, index) {
      var path = '$targets[' + index + ']';
      if (!isPlainObject(target)) fail('INVALID_BATCH_TARGET', '批量绑定必须是普通对象。', path);
      var productFactCardId = String(ownValue(target, 'productFactCardId') || '');
      if (!SAFE_ID.test(productFactCardId)) fail('INVALID_ID', 'productFactCardId 无效。', path + '.productFactCardId');
      if (blueprint.approval.productFactCardIds.indexOf(productFactCardId) < 0 || !factRegistry[productFactCardId]) {
        fail('UNVERIFIED_FACT_CARD', '批量任务事实卡未包含在蓝图可信审批范围。', path + '.productFactCardId');
      }
      var taskKey = String(ownValue(target, 'taskKey') || '');
      if (taskKey && !SAFE_ID.test(taskKey)) fail('INVALID_ID', 'taskKey 无效。', path + '.taskKey');
      if (ownDescriptor(target, 'subjectAssets')) {
        fail('UNTRUSTED_RIGHTS_ASSERTION', '批量目标不得在 subjectAssets 中自报 rightsStatus；只提交 subjectAssetIds 并由可信 registry 复核。', path + '.subjectAssets');
      }
      var requestedSubjectIds = arrayValue(ownValue(target, 'subjectAssetIds'), path + '.subjectAssetIds', limits.maxSubjectAssetsPerTask, false)
        .map(function (id, assetIndex) { return idValue(id, path + '.subjectAssetIds[' + assetIndex + ']', trustContext, { required: true }); });
      var authorizedIds = [];
      var rejectedCount = 0;
      requestedSubjectIds.forEach(function (assetId) {
        var verified = assetRegistry[assetId];
        if (verified && (verified.rightsStatus === 'authorized' || verified.rightsStatus === 'self_owned')) authorizedIds.push(assetId);
        else rejectedCount += 1;
      });
      authorizedIds = Array.from(new Set(authorizedIds)).sort(compareCodeUnits);
      var errors = [];
      if (!authorizedIds.length) errors.push({
        code: 'SUBJECT_ASSET_NOT_AUTHORIZED',
        stage: 'binding',
        message: rejectedCount ? '主体素材均未获得可复用授权，任务已阻断。' : '缺少已授权或自有主体素材，任务已阻断。',
        retryable: false
      });
      var skuIds = arrayValue(ownValue(target, 'skuIds'), path + '.skuIds', limits.maxSkuIdsPerTask, false)
        .map(function (id, skuIndex) { return idValue(id, path + '.skuIds[' + skuIndex + ']', trustContext, { required: true }); });
      skuIds = Array.from(new Set(skuIds)).sort(compareCodeUnits);
      var task = {
        taskId: '',
        taskKey: taskKey,
        productFactCardId: productFactCardId,
        subjectAssetIds: authorizedIds,
        skuIds: skuIds,
        status: errors.length ? 'blocked' : 'pending',
        errors: errors,
        resultRefs: []
      };
      task.taskId = stableHash(taskIdentity(blueprint.blueprintId, blueprint.revision, task), 'rdt_');
      return task;
    });
    var stableBatchIdentity = batchIdentity(blueprint.blueprintId, blueprint.revision, batchKey, screenCount, rawTasks);
    var createdAt = ownValue(options, 'createdAt') || blueprint.updatedAt;
    var raw = {
      schema: BATCH_SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      batchId: stableHash(stableBatchIdentity, 'rdbatch_'),
      batchKey: batchKey,
      blueprintId: blueprint.blueprintId,
      blueprintRevision: blueprint.revision,
      sourceSnapshotId: blueprint.sourceSnapshotId,
      createdAt: createdAt,
      updatedAt: createdAt,
      status: derivedBatchStatus(rawTasks),
      screenCount: screenCount,
      maxReferenceImagesPerCall: 6,
      tasks: rawTasks
    };
    var batch = sanitizeBatchProject(raw, options);
    assertBatchAgainstBlueprint(batch, blueprint, options);
    return batch;
  }

  function assertBatchAgainstBlueprint(batchInput, blueprintInput, options) {
    options = isPlainObject(options) ? options : {};
    var blueprint = sanitizeBlueprint(blueprintInput, options);
    var batch = sanitizeBatchProject(batchInput, options);
    if (blueprint.approvalStatus !== 'approved') fail('BLUEPRINT_NOT_APPROVED', '批次只能关联可信 approved 蓝图。', '$blueprint.approvalStatus');
    if (batch.blueprintId !== blueprint.blueprintId || batch.blueprintRevision !== blueprint.revision ||
        batch.sourceSnapshotId !== blueprint.sourceSnapshotId) {
      fail('LINKAGE_MISMATCH', '批次与蓝图 ID、revision 或来源快照不匹配。', '$.blueprintId');
    }
    var sourceSnapshot = ownValue(options, 'sourceSnapshot');
    if (!sourceSnapshot) fail('SOURCE_SNAPSHOT_REQUIRED', '可信批次校验必须提供来源快照。', '$options.sourceSnapshot');
    assertBlueprintAgainstSource(blueprint, sourceSnapshot, options);
    var context = createContext(options);
    var assetRegistry = verifiedTargetAssetRegistry(options, context);
    var factRegistry = verifiedFactCardRegistry(options, context);
    batch.tasks.forEach(function (task, index) {
      if (blueprint.approval.productFactCardIds.indexOf(task.productFactCardId) < 0 || !factRegistry[task.productFactCardId]) {
        fail('UNVERIFIED_FACT_CARD', '批次任务事实卡不在可信审批范围。', '$.tasks[' + index + '].productFactCardId');
      }
      task.subjectAssetIds.forEach(function (assetId, assetIndex) {
        var verified = assetRegistry[assetId];
        if (!verified || (verified.rightsStatus !== 'authorized' && verified.rightsStatus !== 'self_owned')) {
          fail('UNVERIFIED_TARGET_ASSET', '批次主体素材未通过可信 registry 复核。', '$.tasks[' + index + '].subjectAssetIds[' + assetIndex + ']');
        }
      });
    });
    return { batch: batch, blueprint: blueprint };
  }

  function validateBatchAgainstBlueprint(batchInput, blueprintInput, options) {
    try {
      var checked = assertBatchAgainstBlueprint(batchInput, blueprintInput, options);
      return deepFreeze({ ok: true, value: checked.batch, errors: [], warnings: checked.batch.warnings || [] });
    } catch (error) {
      return deepFreeze({ ok: false, value: null, errors: [{ code: error.code || 'CONTRACT_ERROR', message: String(error.message || error), path: error.path || '$', severity: 'error' }], warnings: [] });
    }
  }

  function updateBatchProject(batchInput, changes, blueprintInput, options) {
    changes = isPlainObject(changes) ? changes : {};
    options = isPlainObject(options) ? options : {};
    var checked = assertBatchAgainstBlueprint(batchInput, blueprintInput, options);
    var raw = cloneJson(checked.batch);
    ['batchId', 'batchKey', 'blueprintId', 'blueprintRevision', 'sourceSnapshotId', 'screenCount', 'tasks', 'status'].forEach(function (key) {
      if (ownDescriptor(changes, key)) fail('IMMUTABLE_BATCH_FIELD', '批次身份或汇总字段不能直接修改。', '$changes.' + key);
    });
    var updates = arrayValue(ownValue(changes, 'taskUpdates'), '$changes.taskUpdates', normalizedLimits(options).maxBatchTasks, false);
    var byId = Object.create(null);
    raw.tasks.forEach(function (task) { byId[task.taskId] = task; });
    var seen = Object.create(null);
    updates.forEach(function (update, index) {
      var path = '$changes.taskUpdates[' + index + ']';
      if (!isPlainObject(update)) fail('INVALID_TASK_UPDATE', 'taskUpdate 必须是普通对象。', path);
      ['taskKey', 'productFactCardId', 'subjectAssetIds', 'skuIds'].forEach(function (key) {
        if (ownDescriptor(update, key)) fail('IMMUTABLE_TASK_FIELD', '任务身份字段不能通过状态更新修改。', path + '.' + key);
      });
      var taskId = String(ownValue(update, 'taskId') || '');
      if (!byId[taskId] || seen[taskId]) fail('UNKNOWN_OR_DUPLICATE_TASK', 'taskId 不存在或重复。', path + '.taskId');
      seen[taskId] = true;
      ['status', 'errors', 'resultRefs'].forEach(function (key) {
        var descriptor = ownDescriptor(update, key);
        if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) byId[taskId][key] = descriptor.value;
      });
    });
    raw.status = derivedBatchStatus(raw.tasks);
    raw.updatedAt = ownValue(options, 'updatedAt') || checked.batch.updatedAt;
    var updated = sanitizeBatchProject(raw, options);
    assertBatchAgainstBlueprint(updated, checked.blueprint, options);
    return updated;
  }

  function validationResult(factory, input, options) {
    try {
      var value = factory(input, options);
      return deepFreeze({ ok: true, value: value, errors: [], warnings: value.warnings || [] });
    } catch (error) {
      return deepFreeze({
        ok: false,
        value: null,
        errors: [{ code: error.code || 'CONTRACT_ERROR', message: String(error.message || error), path: error.path || '$', severity: 'error' }],
        warnings: []
      });
    }
  }

  function validateSourceSnapshot(input, options) { return validationResult(sanitizeSourceSnapshot, input, options); }
  function validateBlueprint(input, options) { return validationResult(sanitizeBlueprint, input, options); }
  function validateBatchProject(input, options) { return validationResult(sanitizeBatchProject, input, options); }
  function validateVisualStructureBlueprint(input, options) { return validationResult(sanitizeVisualStructureBlueprint, input, options); }
  function validateVisualStructureBatchProject(input, options) { return validationResult(sanitizeVisualStructureBatchProject, input, options); }

  function validateBatchProjectAgainstBlueprint(batchInput, blueprintInput, options) {
    return validateBatchAgainstBlueprint(batchInput, blueprintInput, options);
  }

  function sanitize(input, expectedSchema, options) {
    if (isPlainObject(expectedSchema)) { options = expectedSchema; expectedSchema = ''; }
    var schema = expectedSchema || ownValue(input, 'schema');
    if (schema === SOURCE_SCHEMA || schema === SCREENSHOT_SOURCE_SCHEMA) return sanitizeSourceSnapshot(input, options);
    if (schema === BLUEPRINT_SCHEMA) return sanitizeBlueprint(input, options);
    if (schema === BATCH_SCHEMA) return sanitizeBatchProject(input, options);
    if (schema === VISUAL_STRUCTURE_BLUEPRINT_SCHEMA) return sanitizeVisualStructureBlueprint(input, options);
    if (schema === VISUAL_STRUCTURE_BATCH_SCHEMA) return sanitizeVisualStructureBatchProject(input, options);
    fail('INVALID_SCHEMA', '无法识别参考成详合同 schema。', '$.schema');
  }

  function validate(input, expectedSchema, options) {
    try {
      var value = sanitize(input, expectedSchema, options);
      return deepFreeze({ ok: true, value: value, errors: [], warnings: value.warnings || [] });
    } catch (error) {
      return deepFreeze({ ok: false, value: null, errors: [{ code: error.code || 'CONTRACT_ERROR', message: String(error.message || error), path: error.path || '$', severity: 'error' }], warnings: [] });
    }
  }

  return deepFreeze({
    REFERENCE_DETAIL_SOURCE_V1: SOURCE_SCHEMA,
    REFERENCE_DETAIL_SCREENSHOT_SOURCE_V1: SCREENSHOT_SOURCE_SCHEMA,
    REFERENCE_DETAIL_BLUEPRINT_V1: BLUEPRINT_SCHEMA,
    REFERENCE_DETAIL_BATCH_V1: BATCH_SCHEMA,
    REFERENCE_DETAIL_BLUEPRINT_V2: VISUAL_STRUCTURE_BLUEPRINT_SCHEMA,
    REFERENCE_DETAIL_BATCH_V2: VISUAL_STRUCTURE_BATCH_SCHEMA,
    VISUAL_STRUCTURE_ONLY: VISUAL_STRUCTURE_ONLY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    schemas: { source: SOURCE_SCHEMA, screenshotSource: SCREENSHOT_SOURCE_SCHEMA, blueprint: BLUEPRINT_SCHEMA, batch: BATCH_SCHEMA },
    enums: {
      completeness: COMPLETENESS_STATUSES,
      sourceModes: SOURCE_MODES,
      salesRoles: SALES_ROLES,
      blockTypes: BLOCK_TYPES,
      assetRoles: ASSET_ROLES,
      rightsStatuses: RIGHTS_STATUSES,
      blueprintApprovalStatuses: BLUEPRINT_APPROVAL_STATUSES,
      moduleDerivationKinds: MODULE_DERIVATION_KINDS,
      batchStatuses: BATCH_STATUSES,
      taskStatuses: TASK_STATUSES
    },
    DEFAULT_LIMITS: DEFAULT_LIMITS,
    HARD_LIMITS: HARD_LIMITS,
    DEFAULT_URL_POLICY: DEFAULT_URL_POLICY,
    ContractError: ContractError,
    createUrlPolicy: createUrlPolicy,
    validateUrl: validateUrl,
    SCREENSHOT_LIMITS: SCREENSHOT_LIMITS,
    validateScreenshotImageUrl: validateScreenshotImageUrl,
    createScreenshotSource: createScreenshotSource,
    stableSerialize: stableSerialize,
    stableHash: stableHash,
    sanitize: sanitize,
    validate: validate,
    sanitizeSourceSnapshot: sanitizeSourceSnapshot,
    validateSourceSnapshot: validateSourceSnapshot,
    DETAIL_RANGE_PATH_PREFIX: DETAIL_RANGE_PATH_PREFIX,
    classifyDetailImageBlocks: classifyDetailImageBlocks,
    projectAnchoredDetailSource: projectDetailImageSource,
    projectDetailImageSource: projectDetailImageSource,
    createBlueprintFromSnapshot: createBlueprintFromSnapshot,
    sanitizeBlueprint: sanitizeBlueprint,
    validateBlueprint: validateBlueprint,
    reviseBlueprint: reviseBlueprint,
    approveBlueprint: approveBlueprint,
    validateBlueprintAgainstSource: validateBlueprintAgainstSource,
    validateBlueprintAgainstSnapshot: validateBlueprintAgainstSnapshot,
    createRevisionEnvelope: createRevisionEnvelope,
    advanceRevisionEnvelope: advanceRevisionEnvelope,
    projectVisualStructureBlueprint: projectVisualStructureBlueprint,
    sanitizeVisualStructureBlueprint: sanitizeVisualStructureBlueprint,
    validateVisualStructureBlueprint: validateVisualStructureBlueprint,
    validateVisualStructureBlueprintAgainstSource: validateVisualStructureBlueprintAgainstSource,
    approveVisualStructureBlueprint: approveVisualStructureBlueprint,
    createVisualStructureRevisionEnvelope: createVisualStructureRevisionEnvelope,
    advanceVisualStructureRevisionEnvelope: advanceVisualStructureRevisionEnvelope,
    createBatchProject: createBatchProject,
    sanitizeBatchProject: sanitizeBatchProject,
    validateBatchProject: validateBatchProject,
    validateBatchAgainstBlueprint: validateBatchAgainstBlueprint,
    validateBatchProjectAgainstBlueprint: validateBatchProjectAgainstBlueprint,
    updateBatchProject: updateBatchProject,
    createVisualStructureBatchProject: createVisualStructureBatchProject,
    sanitizeVisualStructureBatchProject: sanitizeVisualStructureBatchProject,
    validateVisualStructureBatchProject: validateVisualStructureBatchProject,
    validateVisualStructureBatchAgainstBlueprint: validateVisualStructureBatchAgainstBlueprint,
    updateVisualStructureBatchProject: updateVisualStructureBatchProject
  });
});

;
/* Frozen source: public/creative/labs/image-prompt-lab/reference-detail-blueprint.js */
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
  var SCREENSHOT_SOURCE_SCHEMA = 'REFERENCE_DETAIL_SCREENSHOT_SOURCE_V1';
  // 只用于识别并拒绝旧本地状态；它不再是可创建、可导入或可导出的来源合同。
  var REMOVED_UPLOAD_SOURCE_SCHEMA = 'REFERENCE_DETAIL_UPLOAD_SOURCE_V1';
  var REMOVED_UPLOAD_MARKERS = Object.freeze(['upload_fallback', 'upload_images', 'uploaded_images']);
  var LEGACY_UPLOAD_REMOVED_MESSAGE = '旧 1–6 张手动参考图来源已移除。请粘贴淘宝/天猫商品 URL，或在受支持的当前商品页重新提取。';
  var FORMAL_SOURCE_REQUIRED_MESSAGE = '请添加几张参考详情截图学习结构，或导入已提取的商品详情来源。';
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
    if (isPlainObject(input) && (own(input, 'schema') === FORMAL_SOURCE_SCHEMA || own(input, 'schema') === SCREENSHOT_SOURCE_SCHEMA)) return deepFreeze({
      ok: true,
      legacy: false,
      code: own(input, 'schema') === SCREENSHOT_SOURCE_SCHEMA ? 'SCREENSHOT_SOURCE_ACCEPTED' : 'FORMAL_SOURCE_ACCEPTED',
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
    if (!snapshot || (snapshot.schema !== FORMAL_SOURCE_SCHEMA && snapshot.schema !== SCREENSHOT_SOURCE_SCHEMA)) {
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
      SCREENSHOT_SOURCE_SCHEMA: SCREENSHOT_SOURCE_SCHEMA,
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

;
/* Frozen source: public/creative/labs/image-prompt-lab/reference-detail-batch.js */
/* reference-detail-batch.js — “参考成详”批量绑定与运行时纯逻辑 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../../src/reference-detail-contract.js'));
  } else {
    root.SZ_REFERENCE_DETAIL_BATCH = factory(root.SZ_REFERENCE_DETAIL_CONTRACT);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CONTRACT) {
  'use strict';

  var EXECUTION_SCHEMA = 'REFERENCE_DETAIL_EXECUTION_BUNDLE_V1';
  var RUNTIME_SCHEMA = 'REFERENCE_DETAIL_BATCH_RUNTIME_V1';
  var PROJECTION_SCHEMA = 'REFERENCE_DETAIL_TARGET_PROJECTION_V1';
  var REPLICA_PLAN_SCHEMA = 'REFERENCE_DETAIL_REPLICA_PLAN_V1';
  var EXECUTION_SCHEMA_V2 = 'REFERENCE_DETAIL_EXECUTION_BUNDLE_V2';
  var RUNTIME_SCHEMA_V2 = 'REFERENCE_DETAIL_BATCH_RUNTIME_V2';
  var PROJECTION_SCHEMA_V2 = 'REFERENCE_DETAIL_TARGET_PROJECTION_V2';
  var REPLICA_PLAN_SCHEMA_V2 = 'REFERENCE_DETAIL_REPLICA_PLAN_V2';
  var VISUAL_STRUCTURE_ONLY = 'visual_structure_only';
  var REPLICA_SET_SCHEMA = 'REFERENCE_DETAIL_REPLICA_SET_V1';
  var REUSE_MODES = Object.freeze(['single_reference', 'batch_reference', 'multi_reference', 'sku_replace']);
  var REPLICA_LIFECYCLE_STATES = Object.freeze([
    'captured', 'segmented', 'analyzed', 'draft', 'user_confirmed',
    'generating', 'generated', 'partial', 'blocked'
  ]);
  var REPLICA_FEATURES = Object.freeze({ multiReferenceUi: false, skuReplaceUi: false });
  var SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
  var AUTHORIZED_RIGHTS = Object.freeze({ authorized: true, self_owned: true });
  var MAX_TARGET_ASSET_REF_LENGTH = 16 * 1024 * 1024;
  var TARGET_ASSET_REF_DIGEST_CHUNK = 32768;
  var TASK_PHASES = Object.freeze([
    'missing_fields', 'blocked', 'pending', 'prompting', 'generating', 'partial',
    'failed', 'completed', 'cancelled', 'interrupted', 'stale'
  ]);
  var SCREEN_STATUSES = Object.freeze(['pending', 'generating', 'completed', 'failed', 'cancelled', 'stale']);
  var SENSITIVE_KEY = /(?:^|_)(?:api_?key|token|secret|password|credential|authorization|cookie|headers?)(?:$|_)/i;
  var FORBIDDEN_GENERATION_KEYS = Object.freeze({
    sourcecopy: true,
    sourcesummary: true,
    sourceassetid: true,
    sourceassetids: true,
    sourceblockid: true,
    sourceblockids: true,
    sourcefactid: true,
    sourcefactids: true
  });

  function BatchError(code, message, path, details) {
    this.name = 'ReferenceDetailBatchError';
    this.code = code || 'BATCH_ERROR';
    this.message = message || '参考成详批量运行时错误';
    this.path = path || '$';
    this.details = details || null;
    if (Error.captureStackTrace) Error.captureStackTrace(this, BatchError);
  }
  BatchError.prototype = Object.create(Error.prototype);
  BatchError.prototype.constructor = BatchError;

  function fail(code, message, path, details) {
    throw new BatchError(code, message, path, details);
  }

  function requireContract() {
    if (!CONTRACT || typeof CONTRACT.createBatchProject !== 'function' ||
        typeof CONTRACT.createRevisionEnvelope !== 'function' || typeof CONTRACT.stableHash !== 'function') {
      fail('CONTRACT_UNAVAILABLE', 'REFERENCE_DETAIL 合同不可用。', '$contract');
    }
    return CONTRACT;
  }

  function requireVisualStructureContract() {
    requireContract();
    if (typeof CONTRACT.createVisualStructureBatchProject !== 'function' ||
        typeof CONTRACT.createVisualStructureRevisionEnvelope !== 'function') {
      fail('CONTRACT_UNAVAILABLE', 'REFERENCE_DETAIL V2 结构合同不可用。', '$contract');
    }
    return CONTRACT;
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function hasOwn(object, key) {
    return !!object && Object.prototype.hasOwnProperty.call(object, key);
  }

  function compareCodeUnits(first, second) {
    first = String(first);
    second = String(second);
    return first < second ? -1 : (first > second ? 1 : 0);
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
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

  function text(value, max) {
    var output = value == null ? '' : String(value);
    output = output.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    max = max || 12000;
    return output.slice(0, max);
  }

  function denseArray(value, path) {
    if (!Array.isArray(value)) fail('INVALID_ARRAY', '字段必须是数组。', path);
    for (var index = 0; index < value.length; index++) {
      var descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); } catch (_) { descriptor = null; }
      if (!descriptor || !hasOwn(descriptor, 'value')) fail('NON_JSON_VALUE', '数组不得包含空洞或访问器。', path + '[' + index + ']');
      var item = descriptor.value;
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
        fail('NON_JSON_VALUE', '数组不得包含 undefined 或非 JSON 值。', path + '[' + index + ']');
      }
      if (typeof item === 'number' && !Number.isFinite(item)) fail('NON_JSON_VALUE', '数组不得包含非有限数字。', path + '[' + index + ']');
    }
    Object.keys(value).forEach(function (key) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) fail('NON_JSON_VALUE', '数组不得包含非 JSON 自定义属性。', path + '.' + key);
    });
    return value;
  }

  function assertDenseJsonContainers(value, path, seen) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))) return;
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' ||
        (typeof value === 'number' && !Number.isFinite(value))) {
      fail('NON_JSON_VALUE', '容器不得包含 undefined 或非 JSON 值。', path);
    }
    if (!value || typeof value !== 'object') fail('NON_JSON_VALUE', '容器只接受普通 JSON。', path);
    seen = seen || (typeof WeakSet === 'function' ? new WeakSet() : null);
    if (seen && seen.has(value)) fail('CYCLIC_REFERENCE', '容器不得包含循环引用。', path);
    if (seen) seen.add(value);
    if (Array.isArray(value)) {
      denseArray(value, path);
      value.forEach(function (item, index) { assertDenseJsonContainers(item, path + '[' + index + ']', seen); });
      if (seen) seen.delete(value);
      return;
    }
    if (!isPlainObject(value)) fail('NON_JSON_VALUE', '容器只接受普通 JSON 对象。', path);
    Object.keys(value).forEach(function (key) {
      var descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch (_) { descriptor = null; }
      if (!descriptor || !hasOwn(descriptor, 'value')) fail('NON_JSON_VALUE', '容器不得包含访问器字段。', path + '.' + key);
      assertDenseJsonContainers(descriptor.value, path + '.' + key, seen);
    });
    if (seen) seen.delete(value);
  }

  function screenCountValue(value, path) {
    if (value === undefined) return 10;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 5 || value > 16) {
      fail('INVALID_SCREEN_COUNT', '参考成详输出屏数必须是 5–16 的整数 number。', path);
    }
    return value;
  }

  function assertSafeId(value, path, required) {
    value = text(value, 500);
    if ((!value && required) || (value && !SAFE_ID.test(value))) {
      fail('INVALID_ID', '字段必须是安全稳定 ID。', path);
    }
    return value;
  }

  function uniqueSortedIds(value, path) {
    if (value == null) return [];
    denseArray(value, path);
    return Array.from(new Set(value.map(function (item, index) {
      return assertSafeId(item, path + '[' + index + ']', true);
    }))).sort(compareCodeUnits);
  }

  function sensitiveSettingKey(key) {
    var normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return SENSITIVE_KEY.test(String(key || '')) ||
      /(?:apikey|accesstoken|refreshtoken|servicetoken|token|secret|password|credentials?|authorization|auth|authkey|cookies?|headers?|sessionid|bearer)$/.test(normalized);
  }

  function normalizedEndpointComponent(value) {
    var output = String(value == null ? '' : value);
    try { if (typeof output.normalize === 'function') output = output.normalize('NFKC'); } catch (_) {}
    for (var index = 0; index < 4; index++) {
      var decoded;
      try { decoded = decodeURIComponent(output.replace(/\+/g, '%20')); }
      catch (_) { return { value: output, unsafe: true }; }
      try { if (typeof decoded.normalize === 'function') decoded = decoded.normalize('NFKC'); } catch (_) {}
      if (decoded === output) break;
      output = decoded;
    }
    return { value: output, unsafe: /[\u0000-\u001f\u007f]/.test(output) || /%[0-9a-f]{2}/i.test(output) };
  }

  function sensitiveEndpointQueryKey(key) {
    var component = normalizedEndpointComponent(key);
    if (component.unsafe) return true;
    var normalized = component.value.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!normalized) return false;
    if (normalized === 'key' || normalized === 'sig' || normalized === 'sign' || normalized === 'signature' ||
        normalized === 'expires' || normalized === 'policy' || normalized === 'x5sec') return true;
    if (sensitiveSettingKey(component.value)) return true;
    if (/^auth(?:key|token|signature|credential)?$/.test(normalized)) return true;
    if (/(?:token|secret|credential|signature|accesskeyid|accesskey|accessid|apikey|authkey|securitytoken|secretkey|consumerkey|signedheaders|password|passwd|sessionid|sessionkey|jwt)$/.test(normalized)) return true;
    return /^(?:xoss|xamz|oss|amz)(?:sign|signature|credential|securitytoken|accesskeyid|expires|policy|algorithm|signedheaders)$/.test(normalized);
  }

  function sensitiveEndpointQueryValue(value) {
    var component = normalizedEndpointComponent(value);
    if (component.unsafe || /\b(?:bearer|basic)\s+\S+/i.test(component.value) ||
        /["']?(?:authorization|cookie|tokens?|api[-_ ]?key|access[-_ ]?key|secret|password|credential)["']?\s*[:=]/i.test(component.value) ||
        /\bAKIA[0-9A-Z]{12,}\b/.test(component.value) ||
        /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(component.value)) return true;
    return component.value.split(/[&;]/).some(function (part) {
      var equalsAt = part.indexOf('=');
      return equalsAt > 0 && sensitiveEndpointQueryKey(part.slice(0, equalsAt).trim());
    });
  }

  function sanitizeEndpointSearch(params) {
    var safePairs = [];
    Array.from(params.entries()).forEach(function (entry) {
      if (!sensitiveEndpointQueryKey(entry[0]) && !sensitiveEndpointQueryValue(entry[1])) safePairs.push(entry);
    });
    safePairs.sort(function (a, b) {
      return compareCodeUnits(a[0], b[0]) || compareCodeUnits(a[1], b[1]);
    });
    return safePairs;
  }

  function safeEndpoint(value) {
    value = text(value, 4096);
    if (!value) return '';
    var normalized = normalizedEndpointComponent(value);
    if (normalized.unsafe || /\\/.test(value) || /\\/.test(normalized.value) ||
        /^\/\//.test(value) || /^\/\//.test(normalized.value)) return '';
    try {
      if (!/^https?:\/\/[^/\\]/i.test(value)) throw new Error('relative endpoint');
      var parsed = new URL(value);
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return '';
      parsed.hash = '';
      var pairs = sanitizeEndpointSearch(parsed.searchParams);
      parsed.search = '';
      pairs.forEach(function (pair) { parsed.searchParams.append(pair[0], pair[1]); });
      return parsed.toString();
    } catch (_) {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || /^[/\\]/.test(value)) return '';
      var hashIndex = value.indexOf('#');
      if (hashIndex >= 0) value = value.slice(0, hashIndex);
      var queryIndex = value.indexOf('?');
      if (queryIndex < 0) return value;
      var base = value.slice(0, queryIndex);
      var params = new URLSearchParams(value.slice(queryIndex + 1));
      var query = sanitizeEndpointSearch(params).map(function (pair) {
        return encodeURIComponent(pair[0]) + '=' + encodeURIComponent(pair[1]);
      }).join('&');
      return base + (query ? '?' + query : '');
    }
  }

  function canonicalJson(value, path, depth) {
    depth = depth || 0;
    if (depth > 20) fail('LIMIT_EXCEEDED', '对象深度超过批量 sidecar 上限。', path);
    if (value == null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return text(value, 100000);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('NON_JSON_VALUE', 'sidecar 不接受非有限数字。', path);
      return value;
    }
    if (Array.isArray(value)) {
      denseArray(value, path);
      return value.map(function (item, index) {
        return canonicalJson(item, path + '[' + index + ']', depth + 1);
      });
    }
    if (!isPlainObject(value)) fail('NON_JSON_VALUE', 'sidecar 只接受普通 JSON。', path);
    var output = {};
    Object.keys(value).sort(compareCodeUnits).forEach(function (key) {
      var normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (key === '__proto__' || key === 'prototype' || key === 'constructor' || sensitiveSettingKey(key)) return;
      var descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch (_) { descriptor = null; }
      if (!descriptor || !hasOwn(descriptor, 'value')) fail('NON_JSON_VALUE', 'sidecar 不接受访问器字段。', path + '.' + key);
      var item = descriptor.value;
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
        fail('NON_JSON_VALUE', 'sidecar 不接受 undefined 或非 JSON 值。', path + '.' + key);
      }
      if (typeof item === 'string' && /(?:baseurl|endpoint|endpointurl|apiurl)$/.test(normalizedKey)) {
        output[key] = safeEndpoint(item);
      } else {
        output[key] = canonicalJson(item, path + '.' + key, depth + 1);
      }
    });
    return output;
  }

  function safeGenerationSettings(input) {
    return deepFreeze(canonicalJson(isPlainObject(input) ? input : {}, '$generationSettings', 0));
  }

  function hash(value, prefix) {
    return requireContract().stableHash(value, prefix);
  }

  // Hash large refs incrementally so confirmation identity covers every code
  // unit without embedding a multi-megabyte data URI in one canonical object.
  function completeTextDigest(value, prefix) {
    var state = hash({ schema: 'REFERENCE_DETAIL_LARGE_TEXT_DIGEST_V1', length: value.length }, 'rdrefseed_');
    var chunkIndex = 0;
    for (var offset = 0; offset < value.length; offset += TARGET_ASSET_REF_DIGEST_CHUNK) {
      state = hash({ state: state, chunkIndex: chunkIndex, chunk: value.slice(offset, offset + TARGET_ASSET_REF_DIGEST_CHUNK) }, 'rdrefchunk_');
      chunkIndex += 1;
    }
    return hash({ state: state, length: value.length, chunkCount: chunkIndex }, prefix);
  }

  function normalizeDraftTarget(input, options) {
    input = isPlainObject(input) ? input : {};
    options = isPlainObject(options) ? options : {};
    var subjectAssetIds = uniqueSortedIds(input.subjectAssetIds, '$target.subjectAssetIds');
    var modelAssetIds = uniqueSortedIds(input.modelAssetIds, '$target.modelAssetIds');
    var skuIds = uniqueSortedIds(input.skuIds, '$target.skuIds');
    var userInput = canonicalJson(isPlainObject(input.userInput) ? input.userInput : {}, '$target.userInput', 0);
    var stableContent = {
      productFactCardId: text(input.productFactCardId, 240),
      internalId: text(input.internalId, 240),
      subjectAssetIds: subjectAssetIds,
      modelAssetIds: modelAssetIds,
      skuIds: skuIds
    };
    var optionIndex = hasOwn(options, 'index') ? 'row_index_' + String(options.index) : '';
    var rowSeed = text(options.rowKey || optionIndex || input.rowKey || input.draftTargetId || input.taskKey || input.internalId, 500) ||
      hash(stableContent, 'rdrowseed_');
    var draftTargetId = input.draftTargetId ? assertSafeId(input.draftTargetId, '$target.draftTargetId', true) :
      hash({ rowSeed: rowSeed, kind: 'draft_target' }, 'rddraft_');
    var targetInputId = input.targetInputId ? assertSafeId(input.targetInputId, '$target.targetInputId', true) :
      hash({ draftTargetId: draftTargetId, kind: 'visual_structure_target_input' }, 'rdtargetinput_');
    var taskKey = input.taskKey ? assertSafeId(input.taskKey, '$target.taskKey', true) :
      hash({ draftTargetId: draftTargetId, rowSeed: rowSeed }, 'rdtaskkey_');
    return deepFreeze({
      draftTargetId: draftTargetId,
      targetInputId: targetInputId,
      taskKey: taskKey,
      selected: input.selected !== false,
      productName: text(input.productName, 1000),
      internalId: text(input.internalId, 240),
      productFactCardId: text(input.productFactCardId, 240),
      subjectAssetIds: subjectAssetIds,
      modelAssetIds: modelAssetIds,
      skuIds: skuIds,
      audience: text(input.audience, 1000),
      language: text(input.language, 240),
      sellingAngle: text(input.sellingAngle, 2000),
      userInput: userInput
    });
  }

  function duplicateDraftTarget(input, options) {
    options = isPlainObject(options) ? options : {};
    var source = normalizeDraftTarget(input);
    var operationKey = text(options.operationKey || options.copyKey || options.copyIndex || 'copy_1', 240);
    if (!operationKey) fail('COPY_OPERATION_KEY_REQUIRED', '复制目标必须提供稳定 operationKey。', '$options.operationKey');
    var raw = clone(source);
    raw.draftTargetId = hash({ sourceDraftTargetId: source.draftTargetId, operationKey: operationKey }, 'rddraft_');
    raw.targetInputId = hash({ draftTargetId: raw.draftTargetId, operationKey: operationKey, kind: 'visual_structure_target_input' }, 'rdtargetinput_');
    raw.taskKey = hash({ sourceTaskKey: source.taskKey, copyDraftTargetId: raw.draftTargetId }, 'rdtaskkey_');
    if (options.productNameSuffix !== false && raw.productName) raw.productName += '（副本）';
    return normalizeDraftTarget(raw);
  }

  function normalizeRegistryFactCard(card, record, index) {
    var path = '$bundle.verifiedProductFactCards[' + index + ']';
    if (!isPlainObject(card)) fail('INVALID_VERIFIED_FACT_CARD', '可信事实卡记录无效。', path);
    var cardId = assertSafeId(card.productFactCardId, path + '.productFactCardId', true);
    var verificationId = assertSafeId(card.verificationId, path + '.verificationId', true);
    if (Array.isArray(card.factKeys)) denseArray(card.factKeys, path + '.factKeys');
    var factKeys = Array.isArray(card.factKeys) ? Array.from(new Set(card.factKeys.map(function (key) {
      key = text(key, 240);
      if (!key) fail('INVALID_FACT_KEY', '可信事实键不能为空。', path + '.factKeys');
      return key;
    }))).sort(compareCodeUnits) : [];
    if (!factKeys.length) fail('FACT_CARD_EMPTY', '可信事实卡不能为空。', path + '.factKeys');
    if (!isPlainObject(record) || record.productFactCardId !== cardId || record.verificationId !== verificationId || !Array.isArray(record.facts)) {
      fail('FACT_CARD_RECORD_MISMATCH', '事实卡 registry 与可执行事实值记录不一致。', '$bundle.factCardsById.' + cardId);
    }
    denseArray(record.facts, '$bundle.factCardsById.' + cardId + '.facts');
    var seen = Object.create(null);
    var facts = record.facts.map(function (fact, factIndex) {
      if (!isPlainObject(fact)) fail('INVALID_FACT_VALUE', '事实值记录必须是普通对象。', '$bundle.factCardsById.' + cardId + '.facts[' + factIndex + ']');
      var factKey = text(fact.factKey, 240);
      if (!factKey || factKeys.indexOf(factKey) < 0 || seen[factKey]) {
        fail('FACT_CARD_RECORD_MISMATCH', '事实值键不在可信事实卡范围内或重复。', '$bundle.factCardsById.' + cardId + '.facts[' + factIndex + '].factKey');
      }
      seen[factKey] = true;
      var value = text(fact.value, 12000);
      if (!value) fail('FACT_VALUE_MISSING', '可信事实值不能为空。', '$bundle.factCardsById.' + cardId + '.facts[' + factIndex + '].value');
      return { factKey: factKey, label: text(fact.label || factKey, 1000), value: value };
    });
    if (factKeys.some(function (key) { return !seen[key]; })) {
      fail('FACT_CARD_RECORD_MISMATCH', '可执行事实值未覆盖可信事实卡全部键。', '$bundle.factCardsById.' + cardId + '.facts');
    }
    facts.sort(function (a, b) { return compareCodeUnits(a.factKey, b.factKey); });
    return {
      registry: { productFactCardId: cardId, verificationId: verificationId, factKeys: factKeys },
      record: { productFactCardId: cardId, verificationId: verificationId, facts: facts }
    };
  }

  function normalizeRegistryAsset(asset, record, index, claimMode) {
    var path = '$bundle.verifiedTargetAssets[' + index + ']';
    if (!isPlainObject(asset)) fail('INVALID_VERIFIED_ASSET', '可信素材记录无效。', path);
    var assetId = assertSafeId(asset.assetId, path + '.assetId', true);
    var rightsStatus = text(asset.rightsStatus, 40);
    if (!AUTHORIZED_RIGHTS[rightsStatus]) fail('UNAUTHORIZED_TARGET_ASSET', '素材未取得 authorized/self_owned 权利。', path + '.rightsStatus');
    var evidenceId = assertSafeId(asset.evidenceId, path + '.evidenceId', true);
    var role = text(asset.role || 'subject', 80);
    if (claimMode === VISUAL_STRUCTURE_ONLY && role !== 'subject' && role !== 'model') {
      fail('TARGET_ASSET_ROLE_MISMATCH', 'V2 资产 registry 只接受 subject/model 严格角色。', path + '.role');
    }
    var refDescriptor = isPlainObject(record) ? Object.getOwnPropertyDescriptor(record, 'ref') : null;
    var ref = refDescriptor && hasOwn(refDescriptor, 'value') ? refDescriptor.value : null;
    if (typeof ref !== 'string' || !ref.length || ref.length > MAX_TARGET_ASSET_REF_LENGTH || /[\u0000-\u001f\u007f]/.test(ref)) {
      fail('ASSET_REF_INVALID', '自有素材引用必须是完整、有界且不含控制字符的字符串。', '$bundle.assetsById.' + assetId + '.ref', {
        maxLength: MAX_TARGET_ASSET_REF_LENGTH
      });
    }
    if (!isPlainObject(record) || record.assetId !== assetId || record.rightsStatus !== rightsStatus ||
        record.evidenceId !== evidenceId || text(record.role || 'subject', 80) !== role) {
      fail('ASSET_RECORD_MISMATCH', '素材 registry 与可执行素材记录不一致。', '$bundle.assetsById.' + assetId);
    }
    return {
      registry: { assetId: assetId, rightsStatus: rightsStatus, evidenceId: evidenceId, role: role },
      record: { assetId: assetId, ref: ref, role: role, rightsStatus: rightsStatus, evidenceId: evidenceId }
    };
  }

  function confirmationFingerprintFor(envelope, verifiedProductFactCards, verifiedTargetAssets, factCardsById, assetsById) {
    return hash({
      schema: 'REFERENCE_DETAIL_CONFIRMATION_V1',
      currentBlueprint: clone(envelope.currentBlueprint),
      immediatePreviousBlueprint: clone(envelope.immediatePreviousBlueprint),
      verifiedProductFactCards: verifiedProductFactCards.map(function (card) {
        return { registry: clone(card), record: clone(factCardsById[card.productFactCardId]) };
      }),
      verifiedTargetAssets: verifiedTargetAssets.map(function (asset) {
        var record = assetsById[asset.assetId];
        return {
          registry: clone(asset),
          record: {
            assetId: record.assetId,
            refDigest: completeTextDigest(record.ref, 'rdassetref_'),
            role: record.role,
            rightsStatus: record.rightsStatus,
            evidenceId: record.evidenceId
          }
        };
      })
    }, 'rdconfirm_');
  }

  function visualStructureConfirmationFingerprintFor(envelope, verifiedTargetAssets, assetsById) {
    return hash({
      schema: 'REFERENCE_DETAIL_CONFIRMATION_V2',
      claimMode: VISUAL_STRUCTURE_ONLY,
      currentBlueprint: clone(envelope.currentBlueprint),
      immediatePreviousBlueprint: clone(envelope.immediatePreviousBlueprint),
      verifiedTargetAssets: verifiedTargetAssets.map(function (asset) {
        var record = assetsById[asset.assetId];
        return {
          registry: clone(asset),
          record: {
            assetId: record.assetId,
            refDigest: completeTextDigest(record.ref, 'rdassetref_'),
            role: record.role,
            rightsStatus: record.rightsStatus,
            evidenceId: record.evidenceId
          }
        };
      })
    }, 'rdconfirm2_');
  }

  function validateVisualStructureExecutionBundle(input) {
    requireVisualStructureContract();
    if (!isPlainObject(input) || input.schema !== EXECUTION_SCHEMA_V2 || Number(input.schemaVersion) !== 2 || input.claimMode !== VISUAL_STRUCTURE_ONLY) {
      fail('INVALID_EXECUTION_BUNDLE', 'V2 execution bundle schema/claimMode 无效。', '$bundle.schema');
    }
    ['verifiedProductFactCards', 'factCardsById', 'productFactCardId', 'facts'].forEach(function (key) {
      if (hasOwn(input, key)) fail('FACTLESS_BUNDLE_POLLUTED', 'visual_structure_only bundle 不得夹带事实卡或事实值字段。', '$bundle.' + key);
    });
    if (!input.sourceSnapshot || !input.currentBlueprint || !input.immediatePreviousBlueprint) {
      fail('EXECUTION_BUNDLE_INCOMPLETE', 'V2 bundle 缺少 snapshot 或完整 revision envelope。', '$bundle');
    }
    if (!Array.isArray(input.verifiedTargetAssets) || !input.verifiedTargetAssets.length || !isPlainObject(input.assetsById)) {
      fail('TRUST_REGISTRY_REQUIRED', 'V2 bundle 必须包含资产-only 可信 registry 与记录。', '$bundle');
    }
    denseArray(input.verifiedTargetAssets, '$bundle.verifiedTargetAssets');
    var sourceSnapshot;
    var envelope;
    try {
      sourceSnapshot = CONTRACT.sanitizeSourceSnapshot(input.sourceSnapshot);
      envelope = CONTRACT.createVisualStructureRevisionEnvelope(
        input.currentBlueprint, input.immediatePreviousBlueprint, sourceSnapshot
      );
    } catch (error) {
      fail(error.code || 'BLUEPRINT_VALIDATION_FAILED', error.message || 'V2 结构 revision 链复核失败。', error.path || '$bundle.currentBlueprint');
    }
    if (envelope.currentBlueprint.approvalStatus !== 'approved') {
      fail('BLUEPRINT_NOT_APPROVED', '只有 approved V2 currentBlueprint 可批量生成。', '$bundle.currentBlueprint.approvalStatus');
    }
    var assetsById = {};
    var verifiedTargetAssets = input.verifiedTargetAssets.map(function (asset, index) {
      var normalized = normalizeRegistryAsset(asset, input.assetsById[asset && asset.assetId], index, VISUAL_STRUCTURE_ONLY);
      if (assetsById[normalized.registry.assetId]) fail('DUPLICATE_TARGET_ASSET', '可信素材 ID 重复。', '$bundle.verifiedTargetAssets');
      assetsById[normalized.registry.assetId] = normalized.record;
      return normalized.registry;
    }).sort(function (a, b) { return compareCodeUnits(a.assetId, b.assetId); });
    Object.keys(input.assetsById).forEach(function (assetId) {
      if (!assetsById[assetId]) fail('UNSCOPED_TARGET_ASSET', 'assetsById 不得含 registry 范围外素材。', '$bundle.assetsById.' + assetId);
    });
    var confirmationFingerprint = visualStructureConfirmationFingerprintFor(envelope, verifiedTargetAssets, assetsById);
    if (input.confirmationFingerprint && input.confirmationFingerprint !== confirmationFingerprint) {
      fail('CONFIRMATION_FINGERPRINT_MISMATCH', 'V2 确认指纹与结构或自有素材不一致。', '$bundle.confirmationFingerprint');
    }
    var bundleId = hash({
      claimMode: VISUAL_STRUCTURE_ONLY,
      confirmationFingerprint: confirmationFingerprint,
      snapshotId: envelope.currentBlueprint.sourceSnapshotId,
      blueprintId: envelope.currentBlueprint.blueprintId,
      revision: envelope.currentBlueprint.revision,
      assets: verifiedTargetAssets
    }, 'rdexec2_');
    if (input.bundleId && input.bundleId !== bundleId) fail('BUNDLE_ID_MISMATCH', 'V2 bundleId 与可信内容不一致。', '$bundle.bundleId');
    return deepFreeze({
      schema: EXECUTION_SCHEMA_V2,
      schemaVersion: 2,
      claimMode: VISUAL_STRUCTURE_ONLY,
      bundleId: bundleId,
      confirmationFingerprint: confirmationFingerprint,
      sourceSnapshot: clone(sourceSnapshot),
      currentBlueprint: clone(envelope.currentBlueprint),
      immediatePreviousBlueprint: clone(envelope.immediatePreviousBlueprint),
      verifiedTargetAssets: verifiedTargetAssets,
      assetsById: assetsById
    });
  }

  function validateExecutionBundle(input) {
    requireContract();
    if (!isPlainObject(input)) fail('INVALID_EXECUTION_BUNDLE', 'execution bundle 必须是普通对象。', '$bundle');
    if (input.schema === EXECUTION_SCHEMA_V2) return validateVisualStructureExecutionBundle(input);
    if (input.schema !== EXECUTION_SCHEMA || Number(input.schemaVersion) !== 1) {
      fail('INVALID_EXECUTION_BUNDLE', 'execution bundle schema 无效。', '$bundle.schema');
    }
    if (!input.sourceSnapshot || !input.currentBlueprint) fail('EXECUTION_BUNDLE_INCOMPLETE', 'execution bundle 缺少 snapshot 或 currentBlueprint。', '$bundle');
    if (input.currentBlueprint.approvalStatus !== 'approved') fail('BLUEPRINT_NOT_APPROVED', '只有 approved currentBlueprint 可批量生成。', '$bundle.currentBlueprint.approvalStatus');
    if (!input.immediatePreviousBlueprint) fail('PREVIOUS_BLUEPRINT_REQUIRED', 'approved revision 必须携带直接前一蓝图。', '$bundle.immediatePreviousBlueprint');
    if (!Array.isArray(input.verifiedProductFactCards) || !input.verifiedProductFactCards.length ||
        !Array.isArray(input.verifiedTargetAssets) || !input.verifiedTargetAssets.length ||
        !isPlainObject(input.factCardsById) || !isPlainObject(input.assetsById)) {
      fail('TRUST_REGISTRY_REQUIRED', 'execution bundle 缺少可信事实或素材 registry。', '$bundle');
    }
    denseArray(input.verifiedProductFactCards, '$bundle.verifiedProductFactCards');
    denseArray(input.verifiedTargetAssets, '$bundle.verifiedTargetAssets');
    var sourceSnapshot;
    var envelope;
    try {
      sourceSnapshot = CONTRACT.sanitizeSourceSnapshot(input.sourceSnapshot);
      envelope = CONTRACT.createRevisionEnvelope(
        input.currentBlueprint,
        input.immediatePreviousBlueprint,
        sourceSnapshot,
        { verifiedProductFactCards: input.verifiedProductFactCards, verifiedTargetAssets: input.verifiedTargetAssets }
      );
    } catch (error) {
      fail(error.code || 'BLUEPRINT_VALIDATION_FAILED', error.message || '蓝图 revision 链复核失败。', error.path || '$bundle.currentBlueprint');
    }
    var factCardsById = {};
    var verifiedProductFactCards = input.verifiedProductFactCards.map(function (card, index) {
      var normalized = normalizeRegistryFactCard(card, input.factCardsById[card && card.productFactCardId], index);
      if (factCardsById[normalized.registry.productFactCardId]) fail('DUPLICATE_FACT_CARD', '可信事实卡 ID 重复。', '$bundle.verifiedProductFactCards');
      factCardsById[normalized.registry.productFactCardId] = normalized.record;
      return normalized.registry;
    }).sort(function (a, b) { return compareCodeUnits(a.productFactCardId, b.productFactCardId); });
    var assetsById = {};
    var verifiedTargetAssets = input.verifiedTargetAssets.map(function (asset, index) {
      var normalized = normalizeRegistryAsset(asset, input.assetsById[asset && asset.assetId], index);
      if (assetsById[normalized.registry.assetId]) fail('DUPLICATE_TARGET_ASSET', '可信素材 ID 重复。', '$bundle.verifiedTargetAssets');
      assetsById[normalized.registry.assetId] = normalized.record;
      return normalized.registry;
    }).sort(function (a, b) { return compareCodeUnits(a.assetId, b.assetId); });
    var approvedCards = envelope.currentBlueprint.approval && envelope.currentBlueprint.approval.productFactCardIds || [];
    approvedCards.forEach(function (cardId) {
      if (!factCardsById[cardId]) fail('UNVERIFIED_FACT_CARD', 'approved 蓝图事实卡不在 execution registry。', '$bundle.currentBlueprint.approval.productFactCardIds');
    });
    var confirmationFingerprint = confirmationFingerprintFor(
      envelope,
      verifiedProductFactCards,
      verifiedTargetAssets,
      factCardsById,
      assetsById
    );
    if (input.confirmationFingerprint && input.confirmationFingerprint !== confirmationFingerprint) {
      fail('CONFIRMATION_FINGERPRINT_MISMATCH', '确认指纹与已确认蓝图、可信事实或自有素材不一致。', '$bundle.confirmationFingerprint');
    }
    var bundleId = hash({
      confirmationFingerprint: confirmationFingerprint,
      snapshotId: envelope.currentBlueprint.sourceSnapshotId,
      blueprintId: envelope.currentBlueprint.blueprintId,
      revision: envelope.currentBlueprint.revision,
      factCards: verifiedProductFactCards,
      assets: verifiedTargetAssets
    }, 'rdexec_');
    if (input.bundleId && input.bundleId !== bundleId) fail('BUNDLE_ID_MISMATCH', 'bundleId 与可信内容不一致。', '$bundle.bundleId');
    return deepFreeze({
      schema: EXECUTION_SCHEMA,
      schemaVersion: 1,
      bundleId: bundleId,
      confirmationFingerprint: confirmationFingerprint,
      sourceSnapshot: clone(sourceSnapshot),
      currentBlueprint: clone(envelope.currentBlueprint),
      immediatePreviousBlueprint: clone(envelope.immediatePreviousBlueprint),
      verifiedProductFactCards: verifiedProductFactCards,
      verifiedTargetAssets: verifiedTargetAssets,
      factCardsById: factCardsById,
      assetsById: assetsById
    });
  }

  function registryMaps(bundle) {
    var cards = Object.create(null);
    var assets = Object.create(null);
    (bundle.verifiedProductFactCards || []).forEach(function (card) { cards[card.productFactCardId] = card; });
    bundle.verifiedTargetAssets.forEach(function (asset) { assets[asset.assetId] = asset; });
    return { cards: cards, assets: assets };
  }

  function createConfirmationFingerprint(bundleInput) {
    return validateExecutionBundle(bundleInput).confirmationFingerprint;
  }

  function requiredTargetFields(blueprint) {
    var fields = [];
    blueprint.modules.forEach(function (module) {
      if (!module.selected) return;
      module.factBindings.forEach(function (binding) {
        if (binding.required && fields.indexOf(binding.targetField) < 0) fields.push(binding.targetField);
      });
    });
    return fields.sort(compareCodeUnits);
  }

  function validateTarget(bundle, input, index) {
    var target = normalizeDraftTarget(input);
    var path = '$targets[' + index + ']';
    var errors = [];
    var maps = registryMaps(bundle);
    function issue(code, message, field) { errors.push({ code: code, message: message, path: path + '.' + field }); }
    if (bundle.claimMode === VISUAL_STRUCTURE_ONLY) {
      if (text(input && input.productFactCardId, 240) || hasOwn(input, 'facts')) {
        issue('FACTLESS_TARGET_POLLUTED', 'visual_structure_only 目标不得绑定事实卡或 facts。', 'productFactCardId');
      }
      if (!target.targetInputId) issue('TARGET_INPUT_ID_REQUIRED', 'V2 目标缺少稳定 targetInputId。', 'targetInputId');
      if (!target.subjectAssetIds.length) issue('SUBJECT_ASSET_REQUIRED', '每个目标至少需要一张自有或授权主体图。', 'subjectAssetIds');
      target.subjectAssetIds.forEach(function (assetId) {
        var verified = maps.assets[assetId];
        var record = bundle.assetsById[assetId];
        if (!verified || !record || !AUTHORIZED_RIGHTS[verified.rightsStatus] ||
            verified.rightsStatus !== record.rightsStatus || verified.role !== 'subject' || record.role !== 'subject') {
          issue(verified && record ? 'TARGET_ASSET_ROLE_MISMATCH' : 'UNAUTHORIZED_TARGET_ASSET', '主体素材必须通过 subject 角色的 authorized/self_owned registry 复核。', 'subjectAssetIds');
        }
      });
      target.modelAssetIds.forEach(function (assetId) {
        var verified = maps.assets[assetId];
        var record = bundle.assetsById[assetId];
        if (!verified || !record || !AUTHORIZED_RIGHTS[verified.rightsStatus] ||
            verified.rightsStatus !== record.rightsStatus || verified.role !== 'model' || record.role !== 'model') {
          issue(verified && record ? 'TARGET_ASSET_ROLE_MISMATCH' : 'UNAUTHORIZED_TARGET_ASSET', '模特素材必须通过 model 角色的 authorized/self_owned registry 复核。', 'modelAssetIds');
        }
      });
      if (target.modelAssetIds.some(function (assetId) { return target.subjectAssetIds.indexOf(assetId) >= 0; })) {
        issue('TARGET_ASSET_ROLE_MISMATCH', '同一素材不得同时作为主体与模特。', 'modelAssetIds');
      }
      return { target: target, errors: errors };
    }
    if (!target.productFactCardId || !SAFE_ID.test(target.productFactCardId)) issue('FACT_CARD_REQUIRED', '请选择可信自家事实卡。', 'productFactCardId');
    else if (bundle.currentBlueprint.approval.productFactCardIds.indexOf(target.productFactCardId) < 0) {
      issue('FACT_CARD_NOT_APPROVED', '事实卡不在当前 approved revision，必须回工作台重新审批。', 'productFactCardId');
    } else if (!maps.cards[target.productFactCardId] || !bundle.factCardsById[target.productFactCardId]) {
      issue('UNVERIFIED_FACT_CARD', '事实卡未通过 execution registry 复核。', 'productFactCardId');
    }
    if (!target.subjectAssetIds.length) issue('SUBJECT_ASSET_REQUIRED', '每个目标至少需要一张自有或授权主体图。', 'subjectAssetIds');
    target.subjectAssetIds.concat(target.modelAssetIds).forEach(function (assetId) {
      var verified = maps.assets[assetId];
      var record = bundle.assetsById[assetId];
      if (!verified || !record || !AUTHORIZED_RIGHTS[verified.rightsStatus] || verified.rightsStatus !== record.rightsStatus) {
        issue('UNAUTHORIZED_TARGET_ASSET', '目标素材未通过 authorized/self_owned registry 复核。', 'subjectAssetIds');
      }
    });
    if (target.productFactCardId && bundle.factCardsById[target.productFactCardId]) {
      var factValues = Object.create(null);
      bundle.factCardsById[target.productFactCardId].facts.forEach(function (fact) { factValues[fact.factKey] = fact.value; });
      requiredTargetFields(bundle.currentBlueprint).forEach(function (field) {
        if (field === '*') {
          if (!Object.keys(factValues).length) issue('FACT_VALUE_MISSING', '事实卡没有可用于必要绑定的事实值。', 'productFactCardId');
        } else if (!text(factValues[field], 12000)) {
          issue('FACT_VALUE_MISSING', '事实卡缺少蓝图必要绑定：' + field, 'productFactCardId');
        }
      });
    }
    return { target: target, errors: errors };
  }

  function selectedTargets(bundle, inputs) {
    denseArray(inputs, '$targets');
    var normalized = [];
    var issues = [];
    var ids = Object.create(null);
    var taskKeys = Object.create(null);
    inputs.forEach(function (input, index) {
      var checked = validateTarget(bundle, input, index);
      if (!checked.target.selected) return;
      if (ids[checked.target.draftTargetId]) checked.errors.push({ code: 'DUPLICATE_DRAFT_TARGET', message: 'draftTargetId 重复。', path: '$targets[' + index + '].draftTargetId' });
      if (taskKeys[checked.target.taskKey]) checked.errors.push({ code: 'DUPLICATE_TASK_KEY', message: 'taskKey 重复；复制行必须生成新 taskKey。', path: '$targets[' + index + '].taskKey' });
      ids[checked.target.draftTargetId] = true;
      taskKeys[checked.target.taskKey] = true;
      normalized.push(checked.target);
      issues = issues.concat(checked.errors);
    });
    if (!normalized.length) issues.push({ code: 'NO_SELECTED_TARGET', message: '至少选择一个可生成目标。', path: '$targets' });
    if (issues.length) fail('TARGETS_BLOCKED', issues[0].message, issues[0].path, { issues: issues });
    return normalized;
  }

  function toContractTargets(inputs, bundleInput) {
    denseArray(inputs, '$targets');
    var visualStructureOnly = bundleInput && bundleInput.claimMode === VISUAL_STRUCTURE_ONLY;
    return deepFreeze(inputs.map(function (input) { return normalizeDraftTarget(input); }).filter(function (target) {
      return target.selected;
    }).map(function (target) {
      if (visualStructureOnly) {
        return {
          taskKey: target.taskKey,
          targetInputId: target.targetInputId,
          subjectAssetIds: target.subjectAssetIds.slice(),
          modelAssetIds: target.modelAssetIds.slice(),
          skuIds: target.skuIds.slice()
        };
      }
      return {
        taskKey: target.taskKey,
        productFactCardId: target.productFactCardId,
        subjectAssetIds: target.subjectAssetIds.slice(),
        skuIds: target.skuIds.slice()
      };
    }));
  }

  function targetAssetRecords(bundle, ids) {
    return ids.map(function (assetId) {
      var record = bundle.assetsById[assetId];
      return {
        assetId: record.assetId,
        ref: record.ref,
        role: record.role,
        rightsStatus: record.rightsStatus,
        evidenceId: record.evidenceId
      };
    });
  }

  function reuseModeValue(value, path) {
    value = text(value || 'single_reference', 80);
    if (REUSE_MODES.indexOf(value) < 0) fail('INVALID_REUSE_MODE', '复制模式无效。', path || '$options.reuseMode');
    return value;
  }

  function positiveVersion(value, path) {
    value = value == null ? 1 : Number(value);
    if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_VERSION', '版本号必须是正整数。', path);
    return value;
  }

  function visualBlueprintForModule(module) {
    var visual = isPlainObject(module && module.visualBrief) ? module.visualBrief : {};
    return {
      description: text(visual.description, 1000),
      layout: text(visual.layout, 1000),
      shotType: text(visual.shotType, 1000),
      subjectPlacement: text(visual.subjectPlacement, 1000),
      background: text(visual.background, 1000),
      lighting: text(visual.lighting, 1000),
      palette: Array.isArray(visual.palette) ? visual.palette.map(function (item) { return text(item, 1000); }).filter(Boolean) : [],
      textZones: Array.isArray(visual.textZones) ? visual.textZones.map(function (item) { return text(item, 1000); }).filter(Boolean) : [],
      density: text(visual.density, 1000),
      transition: text(visual.transition, 1000),
      mood: text(visual.mood, 1000),
      mustKeep: Array.isArray(visual.mustKeep) ? visual.mustKeep.map(function (item) { return text(item, 1000); }).filter(Boolean) : [],
      avoid: Array.isArray(visual.avoid) ? visual.avoid.map(function (item) { return text(item, 1000); }).filter(Boolean) : []
    };
  }

  function comparableDirection(value) {
    return text(value, 1000).toLowerCase().replace(/[\s\u3000,，。！？!?\.:：;；、'"“”‘’()（）\[\]【】{}<>《》—_\-|｜]+/g, '');
  }

  function sourceImageIdsForModule(bundle, module) {
    var blockById = Object.create(null);
    (bundle.sourceSnapshot.orderedBlocks || []).forEach(function (block) {
      if (block && block.blockId) blockById[block.blockId] = block;
    });
    var assetById = Object.create(null);
    (bundle.sourceSnapshot.assets || []).forEach(function (asset) {
      if (asset && asset.assetId) assetById[asset.assetId] = asset;
    });
    var seen = Object.create(null);
    var imageIds = [];
    (module.sourceBlockIds || []).forEach(function (blockId) {
      var block = blockById[blockId];
      (block && block.assetIds || []).forEach(function (assetId) {
        var asset = assetById[assetId];
        if (!asset || seen[assetId]) return;
        if (asset.mediaType === 'image' || /^(?:main|hero|product|subject|detail|option|sku|scene|model|logo|badge|icon|background|decoration|comparison|proof|spec|size|service)$/.test(String(asset.role || ''))) {
          seen[assetId] = true;
          imageIds.push(assetId);
        }
      });
    });
    return imageIds;
  }

  function targetFactsForModule(module, factRecord) {
    var factsByKey = Object.create(null);
    (factRecord.facts || []).forEach(function (fact) { factsByKey[fact.factKey] = fact; });
    var selected = [];
    (module.factBindings || []).forEach(function (binding) {
      if (!binding || binding.required === false) return;
      if (binding.targetField === '*') selected = selected.concat(factRecord.facts || []);
      else if (factsByKey[binding.targetField]) selected.push(factsByKey[binding.targetField]);
    });
    if (!selected.length) selected = (factRecord.facts || []).slice();
    var seen = Object.create(null);
    return selected.filter(function (fact) {
      if (!fact || seen[fact.factKey]) return false;
      seen[fact.factKey] = true;
      return true;
    }).sort(function (a, b) { return compareCodeUnits(a.factKey, b.factKey); });
  }

  function replicaModulesForScreenCount(modules, screenCount, bundle) {
    if (modules.length !== screenCount) {
      fail('CONFIRMED_SCREEN_COUNT_MISMATCH', '生成屏数必须与已确认蓝图的选中模块数一致，确认后不得合并、复制或改序。', '$options.screenCount', {
        confirmedScreenCount: modules.length,
        requestedScreenCount: screenCount,
        blueprintId: bundle.currentBlueprint.blueprintId
      });
    }
    return modules;
  }

  function visualStructureUserInput(target) {
    var output = clone(target.userInput || {});
    if (target.audience && !hasOwn(output, 'audience')) output.audience = target.audience;
    if (target.language && !hasOwn(output, 'language')) output.language = target.language;
    if (target.sellingAngle && !hasOwn(output, 'sellingAngle')) output.sellingAngle = target.sellingAngle;
    return canonicalJson(output, '$target.userInput', 0);
  }

  function createVisualStructureReplicaPlan(bundle, targetInput, options) {
    var checked = validateTarget(bundle, targetInput, 0);
    if (checked.errors.length) fail(checked.errors[0].code, checked.errors[0].message, checked.errors[0].path, { issues: checked.errors });
    var target = checked.target;
    var mode = reuseModeValue(options.reuseMode, '$options.reuseMode');
    var selectedModules = bundle.currentBlueprint.modules.filter(function (module) { return module.selected; })
      .slice().sort(function (a, b) { return a.order - b.order || compareCodeUnits(a.moduleId, b.moduleId); });
    if (!selectedModules.length) fail('REPLICA_SCREEN_REQUIRED', '结构复刻计划至少需要一个已选模块。', '$bundle.currentBlueprint.modules');
    var screenCount = options.screenCount === undefined
      ? screenCountValue(selectedModules.length, '$bundle.currentBlueprint.modules')
      : screenCountValue(options.screenCount, '$options.screenCount');
    selectedModules = replicaModulesForScreenCount(selectedModules, screenCount, bundle);
    var referenceScopeId = options.referenceScopeId
      ? assertSafeId(options.referenceScopeId, '$options.referenceScopeId', true)
      : hash({ bundleId: bundle.bundleId, sourceSnapshotId: bundle.currentBlueprint.sourceSnapshotId, claimMode: VISUAL_STRUCTURE_ONLY }, 'rdrefscope2_');
    var skuScopeId = options.skuScopeId
      ? assertSafeId(options.skuScopeId, '$options.skuScopeId', true)
      : (target.skuIds.length === 1 ? target.skuIds[0] : hash({ targetInputId: target.targetInputId }, 'rdtargetscope2_'));
    if (mode === 'sku_replace') {
      if (target.skuIds.length !== 1 || target.skuIds[0] !== skuScopeId) {
        fail('SKU_SCOPE_REQUIRED', 'SKU 替换模式必须一个任务只绑定一个一致 SKU。', '$target.skuIds');
      }
      var skuScope = options.skuScope;
      if (!isPlainObject(skuScope) || skuScope.skuId !== skuScopeId ||
          (skuScope.targetInputId && skuScope.targetInputId !== target.targetInputId)) {
        fail('SKU_SCOPE_MISMATCH', 'V2 SKU scope 必须绑定当前 targetInputId。', '$options.skuScope');
      }
      var scopedAssetIds = uniqueSortedIds(skuScope.assetIds || [], '$options.skuScope.assetIds');
      var scopedTargetAssets = target.subjectAssetIds.concat(target.modelAssetIds).slice().sort(compareCodeUnits);
      if (!scopedAssetIds.length || CONTRACT.stableSerialize(scopedAssetIds) !== CONTRACT.stableSerialize(scopedTargetAssets)) {
        fail('SKU_ASSET_SCOPE_MISMATCH', 'SKU 素材必须与当前 V2 目标精确一致。', '$options.skuScope.assetIds');
      }
    }
    var generationVersion = positiveVersion(options.generationVersion, '$options.generationVersion');
    var allTargetAssetIds = target.subjectAssetIds.concat(target.modelAssetIds);
    var allTargetAssetSet = Object.create(null);
    allTargetAssetIds.forEach(function (assetId) { allTargetAssetSet[assetId] = true; });
    var screenAssetBindings = options.screenAssetBindings;
    if (screenAssetBindings != null && !isPlainObject(screenAssetBindings)) fail('INVALID_SCREEN_ASSET_BINDINGS', '逐屏素材绑定必须是普通对象。', '$options.screenAssetBindings');
    screenAssetBindings = screenAssetBindings == null ? null : canonicalJson(screenAssetBindings, '$options.screenAssetBindings', 0);
    var directionOwners = Object.create(null);
    var screens = selectedModules.map(function (module, index) {
      var direction = text(module.visualBrief && module.visualBrief.description, 1000);
      var comparable = comparableDirection(direction);
      if (!comparable) fail('SCREEN_DIRECTION_REQUIRED', '每屏必须有结构视觉方向。', '$bundle.currentBlueprint.modules[' + index + '].visualBrief.description');
      if (directionOwners[comparable] != null) fail('SCREEN_DIRECTION_DUPLICATE', '每屏结构视觉方向必须唯一。', '$bundle.currentBlueprint.modules[' + index + '].visualBrief.description');
      directionOwners[comparable] = index;
      var bindingKey = String(index + 1);
      var explicitBindingKey = screenAssetBindings && hasOwn(screenAssetBindings, module.moduleId)
        ? module.moduleId
        : (screenAssetBindings && hasOwn(screenAssetBindings, bindingKey) ? bindingKey : '');
      var explicitBinding = explicitBindingKey ? screenAssetBindings[explicitBindingKey] : null;
      var assetIds = explicitBinding == null ? allTargetAssetIds.slice() : uniqueSortedIds(explicitBinding, '$options.screenAssetBindings.' + explicitBindingKey);
      if (assetIds.some(function (assetId) { return !allTargetAssetSet[assetId]; })) {
        fail('SCREEN_ASSET_SCOPE_MISMATCH', '逐屏素材引用超出当前目标。', '$options.screenAssetBindings.' + explicitBindingKey);
      }
      return {
        screenIndex: index + 1,
        moduleId: module.moduleId,
        moduleOrder: module.order,
        moduleType: module.type,
        locked: module.locked === true,
        commercialRole: module.salesRole,
        visualBlueprint: visualBlueprintForModule(module),
        targetDirection: direction,
        assetIds: Array.from(new Set(assetIds)).sort(compareCodeUnits),
        safetyFlags: (module.riskFlags || []).slice().sort(compareCodeUnits),
        blueprintVersion: bundle.currentBlueprint.revision,
        generationVersion: generationVersion
      };
    });
    var referenceBlueprint = {
      blueprintId: bundle.currentBlueprint.blueprintId,
      blueprintVersion: bundle.currentBlueprint.revision,
      referenceScopeId: referenceScopeId,
      screens: screens.map(function (screen) {
        return {
          screenIndex: screen.screenIndex,
          moduleId: screen.moduleId,
          moduleOrder: screen.moduleOrder,
          moduleType: screen.moduleType,
          locked: screen.locked,
          commercialRole: screen.commercialRole,
          visualBlueprint: clone(screen.visualBlueprint),
          safetyFlags: screen.safetyFlags.slice()
        };
      })
    };
    var targetAssetScope = {
      targetInputId: target.targetInputId,
      skuIds: target.skuIds.slice(),
      subjectAssetIds: target.subjectAssetIds.slice(),
      modelAssetIds: target.modelAssetIds.slice(),
      assets: runtimeAssetMetadata(targetAssetRecords(bundle, allTargetAssetIds))
    };
    var targetContext = {
      targetInputId: target.targetInputId,
      draftTargetId: target.draftTargetId,
      productName: target.productName,
      internalId: target.internalId,
      userInput: visualStructureUserInput(target)
    };
    var identity = {
      claimMode: VISUAL_STRUCTURE_ONLY,
      confirmationFingerprint: bundle.confirmationFingerprint,
      reuseMode: mode,
      referenceScopeId: referenceScopeId,
      skuScopeId: skuScopeId,
      referenceBlueprint: referenceBlueprint,
      targetAssetScope: targetAssetScope,
      targetContext: targetContext,
      screens: screens
    };
    return deepFreeze({
      schema: REPLICA_PLAN_SCHEMA_V2,
      schemaVersion: 2,
      claimMode: VISUAL_STRUCTURE_ONLY,
      replicaPlanId: hash(identity, 'rdreplica2_'),
      confirmationFingerprint: bundle.confirmationFingerprint,
      reuseMode: mode,
      referenceScopeId: referenceScopeId,
      skuScopeId: skuScopeId,
      sourceSnapshotId: bundle.currentBlueprint.sourceSnapshotId,
      blueprintId: bundle.currentBlueprint.blueprintId,
      blueprintVersion: bundle.currentBlueprint.revision,
      targetInputId: target.targetInputId,
      referenceBlueprint: referenceBlueprint,
      targetAssetScope: targetAssetScope,
      targetContext: targetContext,
      screens: screens
    });
  }

  function createReplicaPlan(bundleInput, targetInput, options) {
    options = isPlainObject(options) ? options : {};
    var bundle = validateExecutionBundle(bundleInput);
    if (bundle.claimMode === VISUAL_STRUCTURE_ONLY) return createVisualStructureReplicaPlan(bundle, targetInput, options);
    var checked = validateTarget(bundle, targetInput, 0);
    if (checked.errors.length) fail(checked.errors[0].code, checked.errors[0].message, checked.errors[0].path, { issues: checked.errors });
    var target = checked.target;
    var mode = reuseModeValue(options.reuseMode, '$options.reuseMode');
    var selectedModules = bundle.currentBlueprint.modules.filter(function (module) { return module.selected; })
      .slice().sort(function (a, b) { return a.order - b.order || compareCodeUnits(a.moduleId, b.moduleId); });
    if (!selectedModules.length) fail('REPLICA_SCREEN_REQUIRED', '复刻计划至少需要一个已选蓝图模块。', '$bundle.currentBlueprint.modules');
    var screenCount = options.screenCount === undefined
      ? screenCountValue(selectedModules.length, '$bundle.currentBlueprint.modules')
      : screenCountValue(options.screenCount, '$options.screenCount');
    selectedModules = replicaModulesForScreenCount(selectedModules, screenCount, bundle);
    var referenceScopeId = options.referenceScopeId
      ? assertSafeId(options.referenceScopeId, '$options.referenceScopeId', true)
      : hash({ bundleId: bundle.bundleId, sourceSnapshotId: bundle.currentBlueprint.sourceSnapshotId }, 'rdrefscope_');
    var skuScopeId = options.skuScopeId
      ? assertSafeId(options.skuScopeId, '$options.skuScopeId', true)
      : (target.skuIds.length === 1 ? target.skuIds[0] : hash({ draftTargetId: target.draftTargetId }, 'rdtargetscope_'));
    if (mode === 'sku_replace') {
      if (target.skuIds.length !== 1 || target.skuIds[0] !== skuScopeId) {
        fail('SKU_SCOPE_REQUIRED', 'SKU 替换模式必须一个任务只绑定一个与 skuScopeId 一致的 SKU。', '$target.skuIds');
      }
      var skuScope = options.skuScope;
      if (!isPlainObject(skuScope) || skuScope.skuId !== skuScopeId || skuScope.productFactCardId !== target.productFactCardId) {
        fail('SKU_TRUTH_SCOPE_MISMATCH', 'SKU 替换必须显式绑定当前 SKU 的事实卡。', '$options.skuScope');
      }
      var scopedAssetIds = uniqueSortedIds(skuScope.assetIds || [], '$options.skuScope.assetIds');
      var targetAssetIds = target.subjectAssetIds.concat(target.modelAssetIds).slice().sort(compareCodeUnits);
      if (!scopedAssetIds.length || CONTRACT.stableSerialize(scopedAssetIds) !== CONTRACT.stableSerialize(targetAssetIds)) {
        fail('SKU_ASSET_SCOPE_MISMATCH', 'SKU 替换的素材必须与当前任务精确一致，不得共用其他 SKU 素材。', '$options.skuScope.assetIds');
      }
    }
    var generationVersion = positiveVersion(options.generationVersion, '$options.generationVersion');
    var factRecord = bundle.factCardsById[target.productFactCardId];
    var verificationId = factRecord.verificationId;
    var allTargetAssetIds = target.subjectAssetIds.concat(target.modelAssetIds);
    var allTargetAssetSet = Object.create(null);
    allTargetAssetIds.forEach(function (assetId) { allTargetAssetSet[assetId] = true; });
    var truthFacts = factRecord.facts.map(function (fact) {
      return {
        targetFactId: hash({ productFactCardId: target.productFactCardId, factKey: fact.factKey }, 'rdtruthfact_'),
        factKey: fact.factKey,
        label: fact.label,
        value: fact.value,
        verificationId: verificationId
      };
    });
    var truthFactByKey = Object.create(null);
    truthFacts.forEach(function (fact) { truthFactByKey[fact.factKey] = fact; });
    var truthAssets = targetAssetRecords(bundle, allTargetAssetIds).map(function (asset) {
      return { assetId: asset.assetId, role: asset.role, rightsStatus: asset.rightsStatus, evidenceId: asset.evidenceId };
    });
    var screenAssetBindings = options.screenAssetBindings;
    if (screenAssetBindings != null && !isPlainObject(screenAssetBindings)) {
      fail('INVALID_SCREEN_ASSET_BINDINGS', '逐屏素材绑定必须是普通对象。', '$options.screenAssetBindings');
    }
    screenAssetBindings = screenAssetBindings == null ? null : canonicalJson(screenAssetBindings, '$options.screenAssetBindings', 0);
    var directionOwners = Object.create(null);
    var screens = selectedModules.map(function (module, index) {
      var direction = text(module.visualBrief && module.visualBrief.description, 1000);
      var comparable = comparableDirection(direction);
      if (!comparable) fail('SCREEN_DIRECTION_REQUIRED', '每屏必须有一句面向目标商品的核心内容方向。', '$bundle.currentBlueprint.modules[' + index + '].visualBrief.description');
      if (directionOwners[comparable] != null) fail('SCREEN_DIRECTION_DUPLICATE', '复刻计划的每屏方向必须唯一，不得重复。', '$bundle.currentBlueprint.modules[' + index + '].visualBrief.description');
      directionOwners[comparable] = index;
      var allowedFacts = targetFactsForModule(module, factRecord).map(function (fact) { return truthFactByKey[fact.factKey]; }).filter(Boolean);
      // Formal blueprint targetAssetSlots prove the blueprint approval that happened at the
      // time; they are not a reusable target's runtime bindings. A reused plan defaults to
      // the current target's own assets, or accepts an explicit per-screen subset.
      var bindingKey = String(index + 1);
      var explicitBindingKey = screenAssetBindings && hasOwn(screenAssetBindings, module.moduleId)
        ? module.moduleId
        : (screenAssetBindings && hasOwn(screenAssetBindings, bindingKey) ? bindingKey : '');
      var explicitBinding = explicitBindingKey ? screenAssetBindings[explicitBindingKey] : null;
      var moduleAssetIds = explicitBinding == null
        ? allTargetAssetIds.slice()
        : uniqueSortedIds(explicitBinding, '$options.screenAssetBindings.' + explicitBindingKey);
      if (moduleAssetIds.some(function (assetId) { return !allTargetAssetSet[assetId]; })) {
        fail('SCREEN_ASSET_SCOPE_MISMATCH', '逐屏素材绑定引用了当前目标任务之外的素材。', '$options.screenAssetBindings.' + explicitBindingKey);
      }
      moduleAssetIds = Array.from(new Set(moduleAssetIds)).sort(compareCodeUnits);
      return {
        screenIndex: index + 1,
        moduleId: module.moduleId,
        moduleOrder: module.order,
        moduleType: module.type,
        locked: module.locked === true,
        publishableCopy: clone(module.editableCopy),
        sourceBlockIds: module.sourceBlockIds.slice(),
        sourceImageIds: sourceImageIdsForModule(bundle, module),
        commercialRole: module.salesRole,
        visualBlueprint: visualBlueprintForModule(module),
        targetDirection: direction,
        targetFacts: allowedFacts.map(function (fact) { return clone(fact); }),
        assetIds: moduleAssetIds,
        safetyFlags: (module.riskFlags || []).slice().sort(compareCodeUnits),
        blueprintVersion: bundle.currentBlueprint.revision,
        generationVersion: generationVersion
      };
    });
    var targetProductTruth = {
      truthId: hash({ confirmationFingerprint: bundle.confirmationFingerprint, productFactCardId: target.productFactCardId, facts: truthFacts, assets: truthAssets, skuScopeId: skuScopeId }, 'rdtruth_'),
      confirmationFingerprint: bundle.confirmationFingerprint,
      productFactCardId: target.productFactCardId,
      verificationId: verificationId,
      skuIds: target.skuIds.slice(),
      skuScopeId: skuScopeId,
      facts: truthFacts,
      assets: truthAssets
    };
    var targetContext = {
      draftTargetId: target.draftTargetId,
      audience: target.audience,
      language: target.language,
      sellingAngle: target.sellingAngle
    };
    var referenceBlueprint = {
      sourceSnapshotId: bundle.currentBlueprint.sourceSnapshotId,
      blueprintId: bundle.currentBlueprint.blueprintId,
      blueprintVersion: bundle.currentBlueprint.revision,
      referenceScopeId: referenceScopeId,
      screens: screens.map(function (screen) {
        return {
          screenIndex: screen.screenIndex,
          moduleId: screen.moduleId,
          moduleOrder: screen.moduleOrder,
          moduleType: screen.moduleType,
          locked: screen.locked,
          sourceBlockIds: screen.sourceBlockIds.slice(),
          sourceImageIds: screen.sourceImageIds.slice(),
          commercialRole: screen.commercialRole,
          visualBlueprint: clone(screen.visualBlueprint),
          safetyFlags: screen.safetyFlags.slice()
        };
      })
    };
    var identity = {
      confirmationFingerprint: bundle.confirmationFingerprint,
      reuseMode: mode,
      referenceScopeId: referenceScopeId,
      skuScopeId: skuScopeId,
      referenceBlueprint: referenceBlueprint,
      targetTruthId: targetProductTruth.truthId,
      targetContext: targetContext,
      screens: screens.map(function (screen) {
        return {
          screenIndex: screen.screenIndex,
          moduleId: screen.moduleId,
          targetDirection: screen.targetDirection,
          targetFactIds: screen.targetFacts.map(function (fact) { return fact.targetFactId; }),
          assetIds: screen.assetIds,
          blueprintVersion: screen.blueprintVersion,
          generationVersion: screen.generationVersion
        };
      })
    };
    return deepFreeze({
      schema: REPLICA_PLAN_SCHEMA,
      schemaVersion: 1,
      replicaPlanId: hash(identity, 'rdreplica_'),
      confirmationFingerprint: bundle.confirmationFingerprint,
      reuseMode: mode,
      referenceScopeId: referenceScopeId,
      skuScopeId: skuScopeId,
      sourceSnapshotId: bundle.currentBlueprint.sourceSnapshotId,
      blueprintId: bundle.currentBlueprint.blueprintId,
      blueprintVersion: bundle.currentBlueprint.revision,
      referenceBlueprint: referenceBlueprint,
      targetProductTruth: targetProductTruth,
      targetContext: targetContext,
      screens: screens
    });
  }

  function createReplicaSet(entries, options) {
    options = isPlainObject(options) ? options : {};
    denseArray(entries, '$entries');
    if (!entries.length) fail('REPLICA_SET_EMPTY', '复刻集至少需要一个独立参考计划。', '$entries');
    var scopes = Object.create(null);
    var plans = entries.map(function (entry, index) {
      if (!isPlainObject(entry)) fail('INVALID_REPLICA_SET_ENTRY', '复刻集条目必须是普通对象。', '$entries[' + index + ']');
      var plan = createReplicaPlan(entry.bundle, entry.target, Object.assign({}, entry.options || {}, {
        reuseMode: entry.reuseMode || entry.options && entry.options.reuseMode || options.reuseMode || 'multi_reference'
      }));
      var scopeKey = plan.referenceScopeId + '\u0000' + plan.skuScopeId;
      if (scopes[scopeKey]) fail('REPLICA_SCOPE_DUPLICATE', '同一参考 scope 与 SKU scope 不得重复登记。', '$entries[' + index + ']');
      scopes[scopeKey] = true;
      return plan;
    });
    return deepFreeze({
      schema: REPLICA_SET_SCHEMA,
      schemaVersion: 1,
      replicaSetId: hash(plans.map(function (plan) { return plan.replicaPlanId; }), 'rdreplicaset_'),
      plans: plans
    });
  }

  function deriveReplicaLifecycle(input) {
    input = isPlainObject(input) ? input : {};
    if ((input.schema === REPLICA_PLAN_SCHEMA || input.schema === REPLICA_PLAN_SCHEMA_V2) && Array.isArray(input.screens) && input.screens.length) return 'user_confirmed';
    var runtime = input.runtime;
    if (runtime && Array.isArray(runtime.tasks)) {
      var phases = runtime.tasks.map(function (task) { return task && task.phase || ''; });
      if (phases.some(function (phase) { return phase === 'prompting' || phase === 'generating'; })) return 'generating';
      if (phases.length && phases.every(function (phase) { return phase === 'completed'; })) return 'generated';
      if (phases.some(function (phase) { return phase === 'completed' || phase === 'partial'; }) &&
          phases.some(function (phase) { return phase === 'failed' || phase === 'partial' || phase === 'cancelled' || phase === 'interrupted'; })) return 'partial';
      if (phases.some(function (phase) { return phase === 'blocked' || phase === 'failed' || phase === 'stale'; })) return 'blocked';
    }
    var blueprint = input.currentBlueprint || input.blueprint;
    if (blueprint && blueprint.approvalStatus === 'approved') return 'user_confirmed';
    var working = input.workingBlueprint || input.working;
    if (working && Array.isArray(working.modules) && working.modules.length) {
      if (working.approvalStatus === 'approved') return 'user_confirmed';
      if (working.buildStatus === 'complete' || working.buildStatus === 'partial' || working.buildStatus === 'fallback') return 'draft';
      return 'analyzed';
    }
    if (input.segmented === true || (Array.isArray(input.chunks) && input.chunks.length)) return 'segmented';
    if (input.sourceSnapshot || input.source) return 'captured';
    return 'blocked';
  }

  function runtimeAssetMetadata(assets) {
    return (assets || []).map(function (asset) {
      return {
        assetId: asset.assetId,
        role: asset.role,
        rightsStatus: asset.rightsStatus,
        evidenceId: asset.evidenceId
      };
    });
  }

  function createInputFingerprint(bundleInput, targetInput, generationSettings) {
    var bundle = validateExecutionBundle(bundleInput);
    var target = normalizeDraftTarget(targetInput);
    if (bundle.claimMode === VISUAL_STRUCTURE_ONLY) {
      var checked = validateTarget(bundle, targetInput, 0);
      if (checked.errors.length) fail(checked.errors[0].code, checked.errors[0].message, checked.errors[0].path, { issues: checked.errors });
      target = checked.target;
      var safeV2Settings = safeGenerationSettings(generationSettings);
      return hash({
        claimMode: VISUAL_STRUCTURE_ONLY,
        bundleId: bundle.bundleId,
        confirmationFingerprint: bundle.confirmationFingerprint,
        blueprintId: bundle.currentBlueprint.blueprintId,
        blueprintRevision: bundle.currentBlueprint.revision,
        targetInputId: target.targetInputId,
        productName: target.productName,
        internalId: target.internalId,
        userInput: visualStructureUserInput(target),
        subjectAssets: targetAssetRecords(bundle, target.subjectAssetIds).map(function (asset) {
          return { assetId: asset.assetId, refDigest: completeTextDigest(asset.ref, 'rdassetref_'), role: asset.role, rightsStatus: asset.rightsStatus };
        }),
        modelAssets: targetAssetRecords(bundle, target.modelAssetIds).map(function (asset) {
          return { assetId: asset.assetId, refDigest: completeTextDigest(asset.ref, 'rdassetref_'), role: asset.role, rightsStatus: asset.rightsStatus };
        }),
        skuIds: target.skuIds,
        generationSettings: safeV2Settings
      }, 'rdinput2_');
    }
    var factRecord = bundle.factCardsById[target.productFactCardId];
    if (!factRecord) fail('UNVERIFIED_FACT_CARD', '目标事实卡不在 execution bundle。', '$target.productFactCardId');
    var allAssets = target.subjectAssetIds.concat(target.modelAssetIds);
    allAssets.forEach(function (assetId) {
      if (!bundle.assetsById[assetId]) fail('UNAUTHORIZED_TARGET_ASSET', '目标素材不在 execution bundle。', '$target.subjectAssetIds');
    });
    var safeSettings = safeGenerationSettings(generationSettings);
    return hash({
      bundleId: bundle.bundleId,
      confirmationFingerprint: bundle.confirmationFingerprint,
      blueprintId: bundle.currentBlueprint.blueprintId,
      blueprintRevision: bundle.currentBlueprint.revision,
      productName: target.productName,
      internalId: target.internalId,
      productFactCardId: target.productFactCardId,
      factsDigest: hash(factRecord.facts, 'rdfacts_'),
      subjectAssets: targetAssetRecords(bundle, target.subjectAssetIds).map(function (asset) {
        return { assetId: asset.assetId, refDigest: hash(asset.ref, 'rdassetref_'), role: asset.role, rightsStatus: asset.rightsStatus };
      }),
      modelAssets: targetAssetRecords(bundle, target.modelAssetIds).map(function (asset) {
        return { assetId: asset.assetId, refDigest: hash(asset.ref, 'rdassetref_'), role: asset.role, rightsStatus: asset.rightsStatus };
      }),
      skuIds: target.skuIds,
      audience: target.audience,
      language: target.language,
      sellingAngle: target.sellingAngle,
      generationSettings: safeSettings
    }, 'rdinput_');
  }

  function assertGenerationPayloadSafe(payload, bundleInput) {
    var bundle = validateExecutionBundle(bundleInput);
    var sourceAssetRefs = Object.create(null);
    var sourceAssetIds = Object.create(null);
    (bundle.sourceSnapshot.assets || []).forEach(function (asset) {
      if (asset && asset.assetId) sourceAssetIds[String(asset.assetId)] = true;
      if (asset && asset.url) sourceAssetRefs[String(asset.url)] = true;
    });
    function visit(value, path, keyName, seen) {
      if (value == null || typeof value === 'boolean' || typeof value === 'number') return;
      if (typeof value === 'string') {
        if (/^reference_only$/i.test(value)) fail('REFERENCE_ONLY_LEAK', '最终生成载荷含 reference_only 标记。', path);
        if (sourceAssetIds[value] || sourceAssetRefs[value]) fail('REFERENCE_ASSET_LEAK', '最终生成载荷含来源素材 ID 或原图引用。', path);
        return;
      }
      if (typeof value !== 'object') fail('NON_JSON_VALUE', '最终生成载荷只允许普通 JSON。', path);
      if (seen && seen.has(value)) fail('CYCLIC_REFERENCE', '最终生成载荷不得包含循环引用。', path);
      if (seen) seen.add(value);
      if (Array.isArray(value)) {
        denseArray(value, path);
        value.forEach(function (item, index) { visit(item, path + '[' + index + ']', '', seen); });
        return;
      }
      if (!isPlainObject(value)) fail('NON_JSON_VALUE', '最终生成载荷只允许普通对象。', path);
      Object.keys(value).forEach(function (key) {
        var normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
        var item = value[key];
        if (FORBIDDEN_GENERATION_KEYS[normalized]) fail('REFERENCE_CONTENT_LEAK', '最终生成载荷不得包含来源字段 ' + key + '。', path + '.' + key);
        if (normalized === 'referenceimage' && text(item, 100000)) fail('REFERENCE_IMAGE_LEAK', 'referenceImage 必须为空。', path + '.' + key);
        if ((normalized === 'referenceimages' || normalized === 'visualtemplateimages') && (!Array.isArray(item) || item.length)) {
          fail('REFERENCE_IMAGE_LEAK', key + ' 必须是空数组。', path + '.' + key);
        }
        visit(item, path + '.' + key, key, seen);
      });
    }
    visit(payload, '$payload', '', typeof WeakSet === 'function' ? new WeakSet() : null);
    return true;
  }

  function createVisualStructureGenerationProjection(bundle, targetInput, options) {
    var checked = validateTarget(bundle, targetInput, 0);
    if (checked.errors.length) fail(checked.errors[0].code, checked.errors[0].message, checked.errors[0].path, { issues: checked.errors });
    var target = checked.target;
    var replicaPlan = createVisualStructureReplicaPlan(bundle, target, options);
    var inputFingerprint = createInputFingerprint(bundle, target, options.generationSettings);
    var modules = bundle.currentBlueprint.modules.filter(function (module) { return module.selected; })
      .slice().sort(function (a, b) { return a.order - b.order || compareCodeUnits(a.moduleId, b.moduleId); })
      .map(function (module) {
        return {
          moduleId: module.moduleId,
          order: module.order,
          type: module.type,
          salesRole: module.salesRole,
          locked: module.locked === true,
          visualBrief: clone(module.visualBrief)
        };
      });
    var projection = {
      schema: PROJECTION_SCHEMA_V2,
      schemaVersion: 2,
      claimMode: VISUAL_STRUCTURE_ONLY,
      bundleId: bundle.bundleId,
      confirmationFingerprint: bundle.confirmationFingerprint,
      replicaPlanId: replicaPlan.replicaPlanId,
      reuseMode: replicaPlan.reuseMode,
      referenceScopeId: replicaPlan.referenceScopeId,
      skuScopeId: replicaPlan.skuScopeId,
      blueprintId: bundle.currentBlueprint.blueprintId,
      blueprintRevision: bundle.currentBlueprint.revision,
      draftTargetId: target.draftTargetId,
      targetInputId: target.targetInputId,
      taskKey: target.taskKey,
      inputFingerprint: inputFingerprint,
      screenCount: replicaPlan.screens.length,
      product: {
        productName: target.productName,
        internalId: target.internalId,
        userInput: visualStructureUserInput(target)
      },
      skuIds: target.skuIds.slice(),
      subjectAssets: targetAssetRecords(bundle, target.subjectAssetIds),
      modelAssets: targetAssetRecords(bundle, target.modelAssetIds),
      modules: modules,
      screens: replicaPlan.screens.map(function (screen) {
        return {
          screenIndex: screen.screenIndex,
          moduleId: screen.moduleId,
          moduleOrder: screen.moduleOrder,
          moduleType: screen.moduleType,
          locked: screen.locked,
          commercialRole: screen.commercialRole,
          visualBlueprint: clone(screen.visualBlueprint),
          targetDirection: screen.targetDirection,
          assetIds: screen.assetIds.slice(),
          safetyFlags: screen.safetyFlags.slice(),
          blueprintVersion: screen.blueprintVersion,
          generationVersion: screen.generationVersion
        };
      }),
      generationSettings: clone(safeGenerationSettings(options.generationSettings)),
      referenceImage: '',
      referenceImages: [],
      visualTemplateImages: []
    };
    assertGenerationPayloadSafe(projection, bundle);
    return deepFreeze(projection);
  }

  function createGenerationProjection(bundleInput, targetInput, options) {
    options = isPlainObject(options) ? options : {};
    var bundle = validateExecutionBundle(bundleInput);
    if (bundle.claimMode === VISUAL_STRUCTURE_ONLY) return createVisualStructureGenerationProjection(bundle, targetInput, options);
    var checked = validateTarget(bundle, targetInput, 0);
    if (checked.errors.length) fail(checked.errors[0].code, checked.errors[0].message, checked.errors[0].path, { issues: checked.errors });
    var target = checked.target;
    var replicaPlan = createReplicaPlan(bundle, target, options);
    var inputFingerprint = createInputFingerprint(bundle, target, options.generationSettings);
    var factRecord = bundle.factCardsById[target.productFactCardId];
    var factsByKey = Object.create(null);
    factRecord.facts.forEach(function (fact) { factsByKey[fact.factKey] = fact; });
    var modules = bundle.currentBlueprint.modules.filter(function (module) { return module.selected; })
      .slice().sort(function (a, b) { return a.order - b.order || compareCodeUnits(a.moduleId, b.moduleId); })
      .map(function (module) {
        return {
          moduleId: module.moduleId,
          order: module.order,
          type: module.type,
          salesRole: module.salesRole,
          locked: module.locked === true,
          copy: clone(module.editableCopy),
          visualBrief: clone(module.visualBrief),
          facts: module.factBindings.filter(function (binding) { return binding.required; }).map(function (binding) {
            var resolved = binding.targetField === '*' ? factRecord.facts : [factsByKey[binding.targetField]];
            return {
              bindingId: binding.bindingId,
              targetField: binding.targetField,
              required: true,
              values: resolved.filter(Boolean).map(function (fact) {
                return { factKey: fact.factKey, label: fact.label, value: fact.value };
              })
            };
          })
        };
      });
    var projection = {
      schema: PROJECTION_SCHEMA,
      schemaVersion: 1,
      bundleId: bundle.bundleId,
      confirmationFingerprint: bundle.confirmationFingerprint,
      replicaPlanId: replicaPlan.replicaPlanId,
      reuseMode: replicaPlan.reuseMode,
      referenceScopeId: replicaPlan.referenceScopeId,
      skuScopeId: replicaPlan.skuScopeId,
      blueprintId: bundle.currentBlueprint.blueprintId,
      blueprintRevision: bundle.currentBlueprint.revision,
      draftTargetId: target.draftTargetId,
      taskKey: target.taskKey,
      inputFingerprint: inputFingerprint,
      screenCount: replicaPlan.screens.length,
      product: {
        confirmationFingerprint: bundle.confirmationFingerprint,
        productName: target.productName,
        internalId: target.internalId,
        productFactCardId: target.productFactCardId,
        facts: clone(factRecord.facts),
        skuIds: target.skuIds.slice(),
        audience: target.audience,
        language: target.language,
        sellingAngle: target.sellingAngle
      },
      subjectAssets: targetAssetRecords(bundle, target.subjectAssetIds),
      modelAssets: targetAssetRecords(bundle, target.modelAssetIds),
      modules: modules,
      screens: replicaPlan.screens.map(function (screen) {
        return {
          screenIndex: screen.screenIndex,
          moduleId: screen.moduleId,
          moduleOrder: screen.moduleOrder,
          moduleType: screen.moduleType,
          locked: screen.locked,
          publishableCopy: clone(screen.publishableCopy),
          commercialRole: screen.commercialRole,
          visualBlueprint: clone(screen.visualBlueprint),
          targetDirection: screen.targetDirection,
          targetFacts: screen.targetFacts.map(function (fact) { return clone(fact); }),
          assetIds: screen.assetIds.slice(),
          safetyFlags: screen.safetyFlags.slice(),
          blueprintVersion: screen.blueprintVersion,
          generationVersion: screen.generationVersion
        };
      }),
      generationSettings: clone(safeGenerationSettings(options.generationSettings)),
      referenceImage: '',
      referenceImages: [],
      visualTemplateImages: []
    };
    assertGenerationPayloadSafe(projection, bundle);
    return deepFreeze(projection);
  }

  function logicalJobId(batchId, taskId, inputFingerprint, screenIndex) {
    return hash({ batchId: batchId, taskId: taskId, inputFingerprint: inputFingerprint, screenIndex: screenIndex }, 'rdjob_');
  }

  function requestJobId(logicalId, generation, attempt, stage) {
    return hash({ logicalJobId: logicalId, generation: generation, attempt: attempt, stage: stage || 'image' }, 'rdrequest_');
  }

  function createRuntime(batch, bundle, targets, projections, options) {
    options = isPlainObject(options) ? options : {};
    var visualStructureOnly = bundle.claimMode === VISUAL_STRUCTURE_ONLY;
    var createdAt = text(options.createdAt || batch.createdAt, 80);
    var byTaskKey = Object.create(null);
    targets.forEach(function (target) { byTaskKey[target.taskKey] = target; });
    var byDraftId = Object.create(null);
    projections.forEach(function (projection) { byDraftId[projection.draftTargetId] = projection; });
    var tasks = batch.tasks.map(function (contractTask) {
      var target = byTaskKey[contractTask.taskKey];
      var projection = byDraftId[target.draftTargetId];
      var generation = 1;
      var runtimeTask = {
        taskId: contractTask.taskId,
        taskKey: contractTask.taskKey,
        draftTargetId: target.draftTargetId,
        inputFingerprint: projection.inputFingerprint,
        generation: generation,
        phase: contractTask.status === 'blocked' ? 'blocked' : 'pending',
        target: visualStructureOnly ? {
          confirmationFingerprint: bundle.confirmationFingerprint,
          claimMode: VISUAL_STRUCTURE_ONLY,
          targetInputId: target.targetInputId,
          productName: target.productName,
          internalId: target.internalId,
          userInput: visualStructureUserInput(target),
          skuIds: target.skuIds.slice(),
          subjectAssets: runtimeAssetMetadata(projection.subjectAssets),
          modelAssets: runtimeAssetMetadata(projection.modelAssets)
        } : {
          confirmationFingerprint: bundle.confirmationFingerprint,
          productName: target.productName,
          internalId: target.internalId,
          productFactCardId: target.productFactCardId,
          skuIds: target.skuIds.slice(),
          audience: target.audience,
          language: target.language,
          sellingAngle: target.sellingAngle,
          facts: clone(projection.product.facts),
          subjectAssets: runtimeAssetMetadata(projection.subjectAssets),
          modelAssets: runtimeAssetMetadata(projection.modelAssets)
        },
        prompt: {
          logicalJobId: hash({ batchId: batch.batchId, taskId: contractTask.taskId, inputFingerprint: projection.inputFingerprint }, 'rdprompt_'),
          attempt: 0,
          generation: generation,
          requestJobId: '',
          status: 'pending',
          screenPrompts: [],
          negativePrompt: '',
          error: null
        },
        errors: clone(contractTask.errors || []),
        screens: Array.from({ length: batch.screenCount }, function (_, screenIndex) {
          return {
            screenIndex: screenIndex,
            screenNumber: screenIndex + 1,
            logicalJobId: logicalJobId(batch.batchId, contractTask.taskId, projection.inputFingerprint, screenIndex),
            attempt: 0,
            generation: generation,
            requestJobId: '',
            status: contractTask.status === 'blocked' ? 'cancelled' : 'pending',
            resultRef: null,
            artifactRef: '',
            error: null
          };
        })
      };
      if (visualStructureOnly) runtimeTask.targetInputId = target.targetInputId;
      return runtimeTask;
    });
    var runtime = {
      schema: visualStructureOnly ? RUNTIME_SCHEMA_V2 : RUNTIME_SCHEMA,
      schemaVersion: visualStructureOnly ? 2 : 1,
      batchId: batch.batchId,
      bundleId: bundle.bundleId,
      confirmationFingerprint: bundle.confirmationFingerprint,
      blueprintId: batch.blueprintId,
      blueprintRevision: batch.blueprintRevision,
      screenCount: batch.screenCount,
      settingsFingerprint: hash(safeGenerationSettings(options.generationSettings), 'rdsettings_'),
      generationSettings: clone(safeGenerationSettings(options.generationSettings)),
      createdAt: createdAt,
      updatedAt: createdAt,
      tasks: tasks
    };
    if (visualStructureOnly) runtime.claimMode = VISUAL_STRUCTURE_ONLY;
    return deepFreeze(runtime);
  }

  function createBatchContext(bundleInput, targetInputs, options) {
    options = isPlainObject(options) ? options : {};
    var bundle = validateExecutionBundle(bundleInput);
    var selectedModuleCount = bundle.currentBlueprint.modules.filter(function (module) { return module.selected; }).length;
    var screenCount = options.screenCount === undefined
      ? screenCountValue(selectedModuleCount, '$bundle.currentBlueprint.modules')
      : screenCountValue(options.screenCount, '$options.screenCount');
    if (screenCount !== selectedModuleCount) {
      fail('CONFIRMED_SCREEN_COUNT_MISMATCH', '生成屏数必须与已确认蓝图的选中模块数一致。', '$options.screenCount');
    }
    var targets = selectedTargets(bundle, targetInputs);
    var generationSettings = safeGenerationSettings(options.generationSettings);
    function replicaOptions(target) {
      var scoped = isPlainObject(options.targetScopes) && isPlainObject(options.targetScopes[target.draftTargetId])
        ? options.targetScopes[target.draftTargetId] : {};
      return Object.assign({}, scoped, {
        screenCount: screenCount,
        generationSettings: generationSettings,
        reuseMode: scoped.reuseMode || options.reuseMode || 'single_reference',
        referenceScopeId: scoped.referenceScopeId || options.referenceScopeId,
        skuScopeId: scoped.skuScopeId,
        skuScope: scoped.skuScope,
        screenAssetBindings: scoped.screenAssetBindings,
        generationVersion: 1
      });
    }
    var replicaPlans = targets.map(function (target) {
      return createReplicaPlan(bundle, target, replicaOptions(target));
    });
    var projections = targets.map(function (target) {
      return createGenerationProjection(bundle, target, replicaOptions(target));
    });
    var batchKey = options.batchKey ? assertSafeId(options.batchKey, '$options.batchKey', true) : hash({
      bundleId: bundle.bundleId,
      screenCount: screenCount,
      targetInputs: projections.map(function (projection) {
        return { draftTargetId: projection.draftTargetId, taskKey: projection.taskKey, inputFingerprint: projection.inputFingerprint };
      }),
      generationSettings: generationSettings
    }, 'rdbatchkey_');
    var contractOptions = {
      sourceSnapshot: bundle.sourceSnapshot,
      previousBlueprint: bundle.immediatePreviousBlueprint,
      verifiedTargetAssets: bundle.verifiedTargetAssets,
      screenCount: screenCount,
      batchKey: batchKey,
      createdAt: options.createdAt || bundle.currentBlueprint.updatedAt
    };
    if (bundle.claimMode !== VISUAL_STRUCTURE_ONLY) contractOptions.verifiedProductFactCards = bundle.verifiedProductFactCards;
    var contractTargets = toContractTargets(targets, bundle);
    var batch;
    try {
      batch = bundle.claimMode === VISUAL_STRUCTURE_ONLY
        ? CONTRACT.createVisualStructureBatchProject(bundle.currentBlueprint, contractTargets, contractOptions)
        : CONTRACT.createBatchProject(bundle.currentBlueprint, contractTargets, contractOptions);
    }
    catch (error) { fail(error.code || 'BATCH_CONTRACT_REJECTED', error.message || '合同拒绝批次。', error.path || '$batch'); }
    var runtime = createRuntime(batch, bundle, targets, projections, {
      createdAt: contractOptions.createdAt,
      generationSettings: generationSettings
    });
    return deepFreeze({
      batch: batch,
      runtime: runtime,
      projections: projections,
      replicaPlans: replicaPlans,
      bundleId: bundle.bundleId,
      confirmationFingerprint: bundle.confirmationFingerprint
    });
  }

  function runtimeClone(runtime) {
    var v1 = isPlainObject(runtime) && runtime.schema === RUNTIME_SCHEMA && Number(runtime.schemaVersion) === 1;
    var v2 = isPlainObject(runtime) && runtime.schema === RUNTIME_SCHEMA_V2 && Number(runtime.schemaVersion) === 2 && runtime.claimMode === VISUAL_STRUCTURE_ONLY;
    if ((!v1 && !v2) || !Array.isArray(runtime.tasks)) {
      fail('INVALID_RUNTIME', '批量运行时 sidecar 无效。', '$runtime');
    }
    assertDenseJsonContainers(runtime, '$runtime');
    return clone(runtime);
  }

  function findTask(runtime, taskId) {
    var index = runtime.tasks.findIndex(function (task) { return task.taskId === taskId; });
    if (index < 0) fail('UNKNOWN_TASK', 'taskId 不存在。', '$runtime.tasks');
    return { index: index, task: runtime.tasks[index] };
  }

  function timestamp(runtime, options) {
    return text(options && options.updatedAt || runtime.updatedAt, 80);
  }

  function beginPrompting(runtimeInput, taskId, options) {
    var runtime = runtimeClone(runtimeInput);
    var found = findTask(runtime, taskId);
    var task = found.task;
    if (task.phase === 'prompting' || task.phase === 'generating' || taskHasInFlight(task)) {
      fail('TASK_IN_FLIGHT', '当前目标仍有提词或生图请求在途，不能重复开始提词。', '$runtime.tasks[' + found.index + '].phase');
    }
    if (task.prompt.status === 'completed') fail('PROMPT_ALREADY_COMPLETED', '当前输入的提词已经完成，不得重复提词。', '$runtime.tasks[' + found.index + '].prompt.status');
    if (task.prompt.status === 'failed') fail('RETRY_REQUIRED', '提词失败后必须先执行失败重试。', '$runtime.tasks[' + found.index + '].prompt.status');
    if (['pending', 'interrupted'].indexOf(task.phase) < 0 || task.prompt.status !== 'pending') {
      fail('INVALID_TASK_TRANSITION', '当前任务状态不能开始提词。', '$runtime.tasks[' + found.index + '].phase');
    }
    task.prompt.attempt += 1;
    task.prompt.generation = task.generation;
    task.prompt.requestJobId = requestJobId(task.prompt.logicalJobId, task.generation, task.prompt.attempt, 'prompt');
    task.prompt.status = 'prompting';
    task.prompt.error = null;
    task.phase = 'prompting';
    runtime.updatedAt = timestamp(runtime, options);
    return deepFreeze({
      runtime: runtime,
      request: {
        batchId: runtime.batchId,
        taskId: task.taskId,
        confirmationFingerprint: runtime.confirmationFingerprint,
        inputFingerprint: task.inputFingerprint,
        logicalJobId: task.prompt.logicalJobId,
        requestJobId: task.prompt.requestJobId,
        generation: task.generation,
        attempt: task.prompt.attempt,
        stage: 'prompt'
      }
    });
  }

  function responseMatches(runtime, task, slot, response) {
    return response && response.batchId === runtime.batchId && response.taskId === task.taskId &&
      response.confirmationFingerprint === runtime.confirmationFingerprint &&
      response.inputFingerprint === task.inputFingerprint && response.logicalJobId === slot.logicalJobId &&
      response.requestJobId === slot.requestJobId && Number(response.generation) === Number(task.generation) &&
      Number(response.attempt) === Number(slot.attempt);
  }

  function normalizeError(input, fallbackCode, stage) {
    input = isPlainObject(input) ? input : {};
    var code = text(input.code || fallbackCode || 'GENERATION_FAILED', 80).replace(/[^A-Za-z0-9_.:-]/g, '_');
    if (!SAFE_ID.test(code)) code = fallbackCode || 'GENERATION_FAILED';
    return {
      code: code,
      stage: text(input.stage || stage || 'generation', 80).replace(/[^A-Za-z0-9_.:-]/g, '_') || 'generation',
      message: text(input.message || '生成失败。', 1000),
      retryable: input.retryable !== false
    };
  }

  function acceptPromptResponse(runtimeInput, response, options) {
    var runtime = runtimeClone(runtimeInput);
    var found;
    try { found = findTask(runtime, response && response.taskId); }
    catch (_) { return deepFreeze({ runtime: runtimeInput, accepted: false, reason: 'unknown_task' }); }
    var task = found.task;
    if (task.phase !== 'prompting' || task.prompt.status !== 'prompting' || !responseMatches(runtime, task, task.prompt, response)) {
      return deepFreeze({ runtime: runtimeInput, accepted: false, reason: 'stale_or_mismatched' });
    }
    if (response.ok === false) {
      task.prompt.status = 'failed';
      task.prompt.screenPrompts = [];
      task.prompt.negativePrompt = '';
      task.prompt.error = normalizeError(response.error, 'PROMPT_FAILED', 'prompt');
      task.errors.push(task.prompt.error);
      task.phase = 'failed';
    } else {
      if (Array.isArray(response.screenPrompts)) denseArray(response.screenPrompts, '$response.screenPrompts');
      var prompts = Array.isArray(response.screenPrompts) ? response.screenPrompts.map(function (prompt) { return text(prompt, 50000); }) : [];
      var negativePromptTypeSafe = response.negativePrompt == null || typeof response.negativePrompt === 'string';
      var negativePrompt = negativePromptTypeSafe ? text(response.negativePrompt, 50000) : '';
      var negativePromptUnsafe = !negativePromptTypeSafe || promptIntrinsicLeakReason(negativePrompt);
      if (prompts.length !== runtime.screenCount || prompts.some(function (prompt) { return !prompt; }) || negativePromptUnsafe) {
        task.prompt.status = 'failed';
        task.prompt.screenPrompts = [];
        task.prompt.negativePrompt = '';
        task.prompt.error = normalizeError(negativePromptUnsafe
          ? { code: 'PROMPT_UNSAFE_NEGATIVE', message: '负面提示词包含不安全来源引用或非法类型。', retryable: true }
          : { code: 'PROMPT_SCREEN_COUNT_MISMATCH', message: '提词结果必须与批次屏数一致。', retryable: true }, 'PROMPT_FAILED', 'prompt');
        task.errors.push(task.prompt.error);
        task.phase = 'failed';
      } else {
        task.prompt.status = 'completed';
        task.prompt.screenPrompts = prompts;
        task.prompt.negativePrompt = negativePrompt;
        task.prompt.error = null;
        task.phase = 'pending';
      }
    }
    runtime.updatedAt = timestamp(runtime, options);
    return deepFreeze({ runtime: runtime, accepted: true, reason: task.prompt.status });
  }

  function beginScreenAttempt(runtimeInput, taskId, screenIndex, options) {
    var runtime = runtimeClone(runtimeInput);
    var found = findTask(runtime, taskId);
    var task = found.task;
    screenIndex = Number(screenIndex);
    if (!Number.isSafeInteger(screenIndex) || screenIndex < 0 || screenIndex >= task.screens.length) fail('INVALID_SCREEN_INDEX', 'screenIndex 超出范围。', '$screenIndex');
    var screen = task.screens[screenIndex];
    if (task.prompt.status !== 'completed' && !(options && options.allowWithoutPrompt === true)) fail('PROMPT_REQUIRED', '必须先完成当前目标提词。', '$runtime.tasks[' + found.index + '].prompt');
    if (['blocked', 'completed', 'cancelled', 'stale'].indexOf(task.phase) >= 0 || ['completed', 'generating', 'cancelled', 'stale'].indexOf(screen.status) >= 0) {
      fail('INVALID_SCREEN_TRANSITION', '当前分屏状态不能开始生成。', '$runtime.tasks[' + found.index + '].screens[' + screenIndex + '].status');
    }
    screen.attempt += 1;
    screen.generation = task.generation;
    screen.requestJobId = requestJobId(screen.logicalJobId, task.generation, screen.attempt, 'image');
    screen.status = 'generating';
    screen.error = null;
    task.phase = 'generating';
    runtime.updatedAt = timestamp(runtime, options);
    return deepFreeze({
      runtime: runtime,
      request: {
        batchId: runtime.batchId,
        taskId: task.taskId,
        confirmationFingerprint: runtime.confirmationFingerprint,
        inputFingerprint: task.inputFingerprint,
        logicalJobId: screen.logicalJobId,
        requestJobId: screen.requestJobId,
        generation: task.generation,
        attempt: screen.attempt,
        screenIndex: screen.screenIndex,
        screenNumber: screen.screenNumber,
        stage: 'image'
      }
    });
  }

  function safeOpaqueRef(value, path) {
    value = assertSafeId(value, path, true);
    if (/^(?:https?|data|blob|file):/i.test(value)) fail('UNSAFE_RESULT_REF', '合同 resultRefs 只允许安全不透明 ID。', path);
    return value;
  }

  function createSafeResultRef(input) {
    input = isPlainObject(input) ? input : {};
    var batchId = assertSafeId(input.batchId, '$result.batchId', true);
    var taskId = assertSafeId(input.taskId, '$result.taskId', true);
    var inputFingerprint = assertSafeId(input.inputFingerprint, '$result.inputFingerprint', true);
    var generation = Number(input.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) fail('INVALID_GENERATION', '结果 generation 必须是正整数。', '$result.generation');
    var screenIndex = Number(input.screenIndex);
    if (!Number.isSafeInteger(screenIndex) || screenIndex < 0 || screenIndex > 15) fail('INVALID_SCREEN_INDEX', '结果屏序无效。', '$result.screenIndex');
    var kind = ['page', 'image', 'archive', 'manifest', 'unknown'].indexOf(input.kind) >= 0 ? input.kind : 'image';
    var binding = { batchId: batchId, taskId: taskId, screenIndex: screenIndex, generation: generation, inputFingerprint: inputFingerprint };
    var ref = safeOpaqueRef(input.ref || hash(Object.assign({ kind: kind }, binding), 'rdartifact_'), '$result.ref');
    var expectedResultId = hash(Object.assign({ kind: kind, ref: ref }, binding), 'rdresult_');
    if (input.resultId && safeOpaqueRef(input.resultId, '$result.resultId') !== expectedResultId) {
      fail('RESULT_ID_MISMATCH', 'resultId 未绑定当前 task/screen/generation/input。', '$result.resultId');
    }
    var resultId = expectedResultId;
    return deepFreeze({ resultId: resultId, kind: kind, ref: ref });
  }

  function verifyIssuedResultRef(input, binding, path) {
    path = path || '$resultRef';
    if (!isPlainObject(input)) fail('RESULT_REF_REQUIRED', '成功响应必须携带后台签发的完整 resultRef。', path);
    var keys = Object.keys(input).sort(compareCodeUnits);
    if (keys.length !== 3 || keys[0] !== 'kind' || keys[1] !== 'ref' || keys[2] !== 'resultId') {
      fail('RESULT_REF_INVALID', 'resultRef 只能且必须包含 resultId、kind、ref。', path);
    }
    ['resultId', 'kind', 'ref'].forEach(function (key) {
      var descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(input, key); } catch (_) { descriptor = null; }
      if (!descriptor || !hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || !descriptor.value) {
        fail('RESULT_REF_INVALID', 'resultRef.' + key + ' 必须是后台签发的非空字符串。', path + '.' + key);
      }
    });
    if (input.kind !== 'image') fail('RESULT_REF_INVALID', '分屏生图 resultRef.kind 必须为 image。', path + '.kind');
    var checked = createSafeResultRef(Object.assign({}, input, binding));
    if (checked.resultId !== input.resultId || checked.kind !== input.kind || checked.ref !== input.ref) {
      fail('RESULT_REF_INVALID', 'resultRef 与当前 task/screen/generation/input 绑定不一致。', path);
    }
    return checked;
  }

  function assertUniqueResultRef(runtime, candidate, taskId, screenIndex) {
    runtime.tasks.forEach(function (task) {
      task.screens.forEach(function (screen) {
        if (task.taskId === taskId && Number(screen.screenIndex) === Number(screenIndex)) return;
        if (!screen.resultRef) return;
        if (screen.resultRef.resultId === candidate.resultId) {
          fail('DUPLICATE_RESULT_ID', 'resultId 已被批次内其他目标或分屏占用。', '$runtime.tasks');
        }
        if (screen.resultRef.ref === candidate.ref) {
          fail('DUPLICATE_RESULT_REF', '结果不透明 ref 已被批次内其他目标或分屏占用。', '$runtime.tasks');
        }
      });
    });
  }

  function recomputeTaskPhase(task) {
    var statuses = task.screens.map(function (screen) { return screen.status; });
    if (statuses.every(function (status) { return status === 'completed'; })) return 'completed';
    if (statuses.indexOf('generating') >= 0) return 'generating';
    var completed = statuses.filter(function (status) { return status === 'completed'; }).length;
    var failed = statuses.filter(function (status) { return status === 'failed'; }).length;
    var pending = statuses.filter(function (status) { return status === 'pending'; }).length;
    if (failed && completed) return 'partial';
    if (pending) return 'generating';
    if (failed) return 'failed';
    return 'pending';
  }

  function getTaskProjection(context, taskId) {
    if (!context || !context.runtime || !Array.isArray(context.runtime.tasks) || !Array.isArray(context.projections)) {
      fail('INVALID_BATCH_CONTEXT', '批量上下文无效。', '$context');
    }
    denseArray(context.runtime.tasks, '$context.runtime.tasks');
    denseArray(context.projections, '$context.projections');
    var task = context.runtime.tasks.find(function (item) { return item.taskId === taskId; });
    if (!task) fail('UNKNOWN_TASK', 'taskId 不存在。', '$context.runtime.tasks');
    var projection = context.projections.find(function (item) { return item.draftTargetId === task.draftTargetId; });
    if (!projection) fail('PROJECTION_NOT_FOUND', '目标安全投影不存在。', '$context.projections');
    return projection;
  }

  function getTaskReplicaPlan(context, taskId) {
    if (!context || !Array.isArray(context.replicaPlans)) fail('REPLICA_PLAN_NOT_FOUND', '批量上下文缺少可追溯复刻计划。', '$context.replicaPlans');
    var projection = getTaskProjection(context, taskId);
    var runtimeTask = context.runtime.tasks.find(function (task) { return task.taskId === taskId; });
    var plan = context.replicaPlans.find(function (item) { return item.replicaPlanId === projection.replicaPlanId; });
    if (!plan || !runtimeTask) fail('REPLICA_PLAN_NOT_FOUND', '当前任务的复刻计划不存在。', '$context.replicaPlans');
    var output = clone(plan);
    output.screens.forEach(function (screen, index) {
      if (runtimeTask.screens[index]) screen.generationVersion = runtimeTask.screens[index].generation;
    });
    return deepFreeze(output);
  }

  function acceptScreenResponse(runtimeInput, response, options) {
    var runtime = runtimeClone(runtimeInput);
    var found;
    try { found = findTask(runtime, response && response.taskId); }
    catch (_) { return deepFreeze({ runtime: runtimeInput, accepted: false, reason: 'unknown_task' }); }
    var task = found.task;
    var screenIndex = Number(response && response.screenIndex);
    if (!Number.isSafeInteger(screenIndex) || !task.screens[screenIndex]) return deepFreeze({ runtime: runtimeInput, accepted: false, reason: 'unknown_screen' });
    var screen = task.screens[screenIndex];
    if (screen.status !== 'generating' || !responseMatches(runtime, task, screen, response)) {
      return deepFreeze({ runtime: runtimeInput, accepted: false, reason: 'stale_or_mismatched' });
    }
    if (response.ok === false) {
      screen.status = 'failed';
      screen.error = normalizeError(response.error, 'IMAGE_FAILED', 'image');
      task.errors.push(screen.error);
    } else {
      var resultRef = verifyIssuedResultRef(response.resultRef, {
        batchId: runtime.batchId,
        taskId: task.taskId,
        screenIndex: screenIndex,
        generation: screen.generation,
        inputFingerprint: task.inputFingerprint
      }, '$response.resultRef');
      assertUniqueResultRef(runtime, resultRef, task.taskId, screenIndex);
      screen.resultRef = resultRef;
      screen.artifactRef = text(response.artifactRef, 100000);
      screen.error = null;
      screen.status = 'completed';
    }
    task.phase = recomputeTaskPhase(task);
    runtime.updatedAt = timestamp(runtime, options);
    return deepFreeze({ runtime: runtime, accepted: true, reason: screen.status });
  }

  function activeRequestIds(task) {
    var ids = [];
    if (task.prompt.status === 'prompting' && task.prompt.requestJobId) ids.push(task.prompt.requestJobId);
    task.screens.forEach(function (screen) {
      if (screen.status === 'generating' && screen.requestJobId) ids.push(screen.requestJobId);
    });
    return ids;
  }

  function taskHasInFlight(task) {
    return task.prompt.status === 'prompting' || task.screens.some(function (screen) { return screen.status === 'generating'; });
  }

  function taskIsCancellable(task) {
    return ['pending', 'prompting', 'generating', 'interrupted'].indexOf(task.phase) >= 0;
  }

  function cancelTask(runtimeInput, taskId, options) {
    var runtime = runtimeClone(runtimeInput);
    var found = findTask(runtime, taskId);
    var task = found.task;
    if (!taskIsCancellable(task)) {
      return deepFreeze({ runtime: runtimeInput, cancelledRequestJobIds: [] });
    }
    var cancelledRequestJobIds = activeRequestIds(task);
    task.generation += 1;
    task.phase = 'cancelled';
    if (task.prompt.status === 'prompting' || task.prompt.status === 'pending') task.prompt.status = 'cancelled';
    task.screens.forEach(function (screen) {
      if (screen.status !== 'completed') screen.status = 'cancelled';
    });
    runtime.updatedAt = timestamp(runtime, options);
    return deepFreeze({ runtime: runtime, cancelledRequestJobIds: cancelledRequestJobIds });
  }

  function cancelAll(runtimeInput, options) {
    var runtime = runtimeClone(runtimeInput);
    var ids = [];
    runtime.tasks.slice().forEach(function (task) {
      if (!taskIsCancellable(task)) return;
      var cancelled = cancelTask(runtime, task.taskId, options);
      runtime = cancelled.runtime;
      ids = ids.concat(cancelled.cancelledRequestJobIds);
    });
    return deepFreeze({ runtime: runtime, cancelledRequestJobIds: Array.from(new Set(ids)) });
  }

  function restartTask(runtimeInput, taskId, options) {
    var runtime = runtimeClone(runtimeInput);
    var found = findTask(runtime, taskId);
    var task = found.task;
    if (taskHasInFlight(task)) {
      fail('TASK_IN_FLIGHT', '当前目标仍有请求在途，请先取消后再重启。', '$runtime.tasks[' + found.index + '].phase');
    }
    if (task.phase === 'blocked') fail('BLOCKED_TASK', '硬门禁任务不能在运行层重启。', '$runtime.tasks[' + found.index + '].phase');
    task.generation += 1;
    task.phase = 'pending';
    task.errors = [];
    task.prompt.attempt = 0;
    task.prompt.generation = task.generation;
    task.prompt.requestJobId = '';
    task.prompt.status = 'pending';
    task.prompt.screenPrompts = [];
    task.prompt.negativePrompt = '';
    task.prompt.error = null;
    task.screens.forEach(function (screen) {
      screen.attempt = 0;
      screen.generation = task.generation;
      screen.requestJobId = '';
      screen.status = 'pending';
      screen.resultRef = null;
      screen.artifactRef = '';
      screen.error = null;
    });
    runtime.updatedAt = timestamp(runtime, options);
    return deepFreeze(runtime);
  }

  function retryFailedScreens(runtimeInput, taskId, options) {
    var runtime = runtimeClone(runtimeInput);
    var found = findTask(runtime, taskId);
    var task = found.task;
    if (taskHasInFlight(task)) {
      fail('TASK_IN_FLIGHT', '当前目标仍有请求在途，不能并发重试。', '$runtime.tasks[' + found.index + '].phase');
    }
    var failed = task.screens.filter(function (screen) { return screen.status === 'failed'; });
    if (!failed.length && task.prompt.status !== 'failed') fail('NOTHING_TO_RETRY', '当前任务没有失败的 prompt 或分屏。', '$runtime.tasks[' + found.index + ']');
    task.generation += 1;
    task.errors = [];
    if (task.prompt.status === 'failed') {
      task.prompt.status = 'pending';
      task.prompt.requestJobId = '';
      task.prompt.error = null;
      task.prompt.screenPrompts = [];
      task.prompt.negativePrompt = '';
      task.screens.forEach(function (screen) {
        if (screen.status !== 'completed') {
          screen.status = 'pending';
          screen.requestJobId = '';
          screen.error = null;
        }
      });
    } else {
      failed.forEach(function (screen) {
        screen.status = 'pending';
        screen.generation = task.generation;
        screen.requestJobId = '';
        screen.error = null;
      });
    }
    task.phase = task.prompt.status === 'completed' && task.screens.some(function (screen) { return screen.status === 'completed'; })
      ? 'generating' : 'pending';
    runtime.updatedAt = timestamp(runtime, options);
    return deepFreeze(runtime);
  }

  function retryUnavailableScreens(runtimeInput, taskId, screenIndexes, options) {
    var runtime = runtimeClone(runtimeInput);
    var found = findTask(runtime, taskId);
    var task = found.task;
    if (taskHasInFlight(task)) fail('TASK_IN_FLIGHT', '当前目标仍有请求在途，不能重试缺失档案。', '$runtime.tasks[' + found.index + '].phase');
    denseArray(screenIndexes, '$screenIndexes');
    if (!screenIndexes.length) fail('NOTHING_TO_RETRY', '没有需要重试的缺失档案分屏。', '$screenIndexes');
    var selected = Object.create(null);
    screenIndexes.forEach(function (screenIndex, index) {
      if (typeof screenIndex !== 'number' || !Number.isSafeInteger(screenIndex) || screenIndex < 0 || screenIndex >= task.screens.length || selected[screenIndex]) {
        fail('INVALID_SCREEN_INDEX', '缺失档案分屏索引无效或重复。', '$screenIndexes[' + index + ']');
      }
      var screen = task.screens[screenIndex];
      if (screen.status !== 'completed' || !screen.resultRef) fail('RESULT_NOT_UNAVAILABLE', '只能重试原为 completed 且带 resultRef 的缺失档案分屏。', '$screenIndexes[' + index + ']');
      selected[screenIndex] = true;
    });
    task.generation += 1;
    task.errors = [];
    screenIndexes.forEach(function (screenIndex) {
      var screen = task.screens[screenIndex];
      screen.status = 'pending';
      screen.generation = task.generation;
      screen.requestJobId = '';
      screen.resultRef = null;
      screen.artifactRef = '';
      screen.error = null;
    });
    task.phase = 'generating';
    runtime.updatedAt = timestamp(runtime, options);
    return deepFreeze(runtime);
  }

  function positiveRuntimeInteger(value, path, allowZero) {
    value = Number(value);
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) fail('INVALID_RUNTIME', '运行时整数无效。', path);
    return value;
  }

  function runtimeContainsSensitiveKey(value, seen) {
    if (!value || typeof value !== 'object') return false;
    seen = seen || (typeof WeakSet === 'function' ? new WeakSet() : null);
    if (seen) {
      if (seen.has(value)) return true;
      seen.add(value);
    }
    if (Array.isArray(value)) return value.some(function (item) { return runtimeContainsSensitiveKey(item, seen); });
    return Object.keys(value).some(function (key) {
      return sensitiveSettingKey(key) || runtimeContainsSensitiveKey(value[key], seen);
    });
  }

  function runtimeForbiddenFieldPath(value, path, seen) {
    if (!value || typeof value !== 'object') return '';
    seen = seen || (typeof WeakSet === 'function' ? new WeakSet() : null);
    if (seen) {
      if (seen.has(value)) return path;
      seen.add(value);
    }
    if (Array.isArray(value)) {
      for (var index = 0; index < value.length; index++) {
        var arrayPath = runtimeForbiddenFieldPath(value[index], path + '[' + index + ']', seen);
        if (arrayPath) return arrayPath;
      }
      return '';
    }
    var keys = Object.keys(value);
    for (var keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      var key = keys[keyIndex];
      var normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (FORBIDDEN_GENERATION_KEYS[normalized] || normalized === 'referenceimage' || normalized === 'referenceimages' || normalized === 'visualtemplateimages') {
        return path + '.' + key;
      }
      var nested = runtimeForbiddenFieldPath(value[key], path + '.' + key, seen);
      if (nested) return nested;
    }
    return '';
  }

  function assertRuntimeAssetMetadata(value, path, expectedRole) {
    if (!Array.isArray(value)) fail('INVALID_RUNTIME', '运行时素材元数据必须是数组。', path);
    var seen = Object.create(null);
    value.forEach(function (asset, index) {
      var itemPath = path + '[' + index + ']';
      if (!isPlainObject(asset)) fail('INVALID_RUNTIME', '运行时素材元数据必须是普通对象。', itemPath);
      Object.keys(asset).forEach(function (key) {
        if (['assetId', 'role', 'rightsStatus', 'evidenceId'].indexOf(key) < 0) {
          fail('RUNTIME_ASSET_REF_FORBIDDEN', '持久化 runtime 不得包含素材 ref/url/data。', itemPath + '.' + key);
        }
      });
      var assetId = assertSafeId(asset.assetId, itemPath + '.assetId', true);
      if (seen[assetId]) fail('INVALID_RUNTIME', '运行时素材 ID 重复。', itemPath + '.assetId');
      seen[assetId] = true;
      assertSafeId(asset.evidenceId, itemPath + '.evidenceId', true);
      if (!AUTHORIZED_RIGHTS[asset.rightsStatus]) fail('RUNTIME_ASSET_REF_FORBIDDEN', '运行时只允许 authorized/self_owned 素材元数据。', itemPath + '.rightsStatus');
      if (!text(asset.role, 80)) fail('INVALID_RUNTIME', '运行时素材角色不能为空。', itemPath + '.role');
      if (expectedRole && asset.role !== expectedRole) fail('TARGET_ASSET_ROLE_MISMATCH', '运行时素材角色与 subject/model 槽位不一致。', itemPath + '.role');
    });
  }

  function promptIntrinsicLeakReason(value) {
    value = text(value, 50000);
    if (!value) return '';
    if (/(?:https?|data|blob|file):\/\//i.test(value) || /data:[^\s;,]+[;,]/i.test(value) || /reference_only/i.test(value)) return 'URL/data/reference_only';
    return '';
  }

  function promptLeakReason(value, bundle) {
    value = text(value, 50000);
    if (!value) return '';
    var intrinsicReason = promptIntrinsicLeakReason(value);
    if (intrinsicReason) return intrinsicReason;
    var sourceTokens = [];
    (bundle.sourceSnapshot.orderedBlocks || []).forEach(function (block) {
      [block && block.text, block && block.sourceSummary].forEach(function (item) {
        item = text(item, 12000);
        if (item.length >= 4) sourceTokens.push(item);
      });
    });
    (bundle.sourceSnapshot.assets || []).forEach(function (asset) {
      [asset && asset.assetId, asset && asset.url].forEach(function (item) {
        item = text(item, 4096);
        if (item) sourceTokens.push(item);
      });
    });
    for (var index = 0; index < sourceTokens.length; index++) {
      if (value.indexOf(sourceTokens[index]) >= 0) return 'source_content';
    }
    return '';
  }

  function validateSavedRuntimeShape(savedInput, bundle) {
    var visualStructureOnly = bundle.claimMode === VISUAL_STRUCTURE_ONLY;
    var expectedSchema = visualStructureOnly ? RUNTIME_SCHEMA_V2 : RUNTIME_SCHEMA;
    var expectedVersion = visualStructureOnly ? 2 : 1;
    if (!isPlainObject(savedInput) || savedInput.schema !== expectedSchema || Number(savedInput.schemaVersion) !== expectedVersion ||
        (visualStructureOnly && savedInput.claimMode !== VISUAL_STRUCTURE_ONLY) || !Array.isArray(savedInput.tasks)) {
      fail('INVALID_RUNTIME', '批量运行时 sidecar shape 无效。', '$runtime');
    }
    assertDenseJsonContainers(savedInput, '$runtime');
    var saved;
    try { saved = clone(savedInput); }
    catch (_) { fail('INVALID_RUNTIME', '批量运行时必须是无循环的普通 JSON。', '$runtime'); }
    var forbiddenPath = runtimeForbiddenFieldPath(saved, '$runtime');
    if (forbiddenPath) fail('RUNTIME_SOURCE_FIELD_FORBIDDEN', '持久化 runtime 含来源或参考图字段。', forbiddenPath);
    assertSafeId(saved.batchId, '$runtime.batchId', true);
    assertSafeId(saved.bundleId, '$runtime.bundleId', true);
    assertSafeId(saved.confirmationFingerprint, '$runtime.confirmationFingerprint', true);
    assertSafeId(saved.blueprintId, '$runtime.blueprintId', true);
    positiveRuntimeInteger(saved.blueprintRevision, '$runtime.blueprintRevision', false);
    var savedScreenCount = positiveRuntimeInteger(saved.screenCount, '$runtime.screenCount', false);
    if (savedScreenCount < 5 || savedScreenCount > 16) fail('INVALID_RUNTIME', '持久化 screenCount 必须在 5–16。', '$runtime.screenCount');
    assertSafeId(saved.settingsFingerprint, '$runtime.settingsFingerprint', true);
    if (!isPlainObject(saved.generationSettings) || runtimeContainsSensitiveKey(saved.generationSettings)) {
      fail('RUNTIME_SECRET_FORBIDDEN', '持久化生成设置包含敏感凭据字段。', '$runtime.generationSettings');
    }
    var safeSettings = safeGenerationSettings(saved.generationSettings);
    if (hash(safeSettings, 'rdsettings_') !== saved.settingsFingerprint || CONTRACT.stableSerialize(safeSettings) !== CONTRACT.stableSerialize(saved.generationSettings)) {
      fail('RUNTIME_SETTINGS_MISMATCH', '持久化生成设置未安全规范化或指纹不匹配。', '$runtime.generationSettings');
    }
    var taskIds = Object.create(null);
    var draftIds = Object.create(null);
    var targetInputIds = Object.create(null);
    var resultIds = Object.create(null);
    var resultRefs = Object.create(null);
    saved.tasks.forEach(function (task, taskIndex) {
      var taskPath = '$runtime.tasks[' + taskIndex + ']';
      if (!isPlainObject(task)) fail('INVALID_RUNTIME', '运行时任务必须是普通对象。', taskPath);
      ['taskId', 'taskKey', 'draftTargetId', 'inputFingerprint'].forEach(function (key) { assertSafeId(task[key], taskPath + '.' + key, true); });
      if (visualStructureOnly) assertSafeId(task.targetInputId, taskPath + '.targetInputId', true);
      if (taskIds[task.taskId] || draftIds[task.draftTargetId]) fail('RUNTIME_TASK_MAPPING_MISMATCH', '运行时任务身份或草稿身份重复。', taskPath);
      if (visualStructureOnly && targetInputIds[task.targetInputId]) fail('RUNTIME_TASK_MAPPING_MISMATCH', 'V2 targetInputId 重复。', taskPath + '.targetInputId');
      taskIds[task.taskId] = true;
      draftIds[task.draftTargetId] = true;
      if (visualStructureOnly) targetInputIds[task.targetInputId] = true;
      task.generation = positiveRuntimeInteger(task.generation, taskPath + '.generation', false);
      if (TASK_PHASES.indexOf(task.phase) < 0) fail('INVALID_RUNTIME_STATUS', '任务 phase 无效。', taskPath + '.phase');
      if (!isPlainObject(task.target)) fail('INVALID_RUNTIME', '运行时目标 sidecar 无效。', taskPath + '.target');
      var allowedTargetKeys = visualStructureOnly
        ? ['confirmationFingerprint', 'claimMode', 'targetInputId', 'productName', 'internalId', 'userInput', 'skuIds', 'subjectAssets', 'modelAssets']
        : ['confirmationFingerprint', 'productName', 'internalId', 'productFactCardId', 'skuIds', 'audience', 'language', 'sellingAngle', 'facts', 'subjectAssets', 'modelAssets'];
      Object.keys(task.target).forEach(function (key) {
        if (allowedTargetKeys.indexOf(key) < 0) {
          fail('RUNTIME_TARGET_MAPPING_MISMATCH', '运行时目标 sidecar 含未知或不可持久化字段。', taskPath + '.target.' + key);
        }
      });
      if (visualStructureOnly) {
        if (task.target.claimMode !== VISUAL_STRUCTURE_ONLY || task.target.targetInputId !== task.targetInputId) {
          fail('RUNTIME_TARGET_MAPPING_MISMATCH', 'V2 runtime targetInputId/claimMode 与任务不一致。', taskPath + '.target');
        }
        if (!isPlainObject(task.target.userInput) || runtimeContainsSensitiveKey(task.target.userInput)) {
          fail('RUNTIME_SECRET_FORBIDDEN', 'V2 userInput 必须是无敏感字段的普通 JSON。', taskPath + '.target.userInput');
        }
      }
      if (task.target.confirmationFingerprint !== saved.confirmationFingerprint) {
        fail('CONFIRMATION_FINGERPRINT_MISMATCH', '运行时目标的确认指纹与批次不一致。', taskPath + '.target.confirmationFingerprint');
      }
      assertRuntimeAssetMetadata(task.target.subjectAssets, taskPath + '.target.subjectAssets', visualStructureOnly ? 'subject' : '');
      assertRuntimeAssetMetadata(task.target.modelAssets, taskPath + '.target.modelAssets', visualStructureOnly ? 'model' : '');
      if (!Array.isArray(task.errors)) fail('INVALID_RUNTIME', '运行时任务 errors 必须是数组。', taskPath + '.errors');
      task.errors = task.errors.map(function (error, errorIndex) {
        var normalized = normalizeError(error, 'TASK_FAILED', 'generation');
        if (promptLeakReason(normalized.message, bundle)) fail('RUNTIME_ERROR_LEAK', '持久化错误信息含来源字段、URL 或 data URI。', taskPath + '.errors[' + errorIndex + '].message');
        return normalized;
      });
      if (!isPlainObject(task.prompt)) fail('INVALID_RUNTIME', '运行时 prompt shape 无效。', taskPath + '.prompt');
      assertSafeId(task.prompt.logicalJobId, taskPath + '.prompt.logicalJobId', true);
      task.prompt.attempt = positiveRuntimeInteger(task.prompt.attempt, taskPath + '.prompt.attempt', true);
      task.prompt.generation = positiveRuntimeInteger(task.prompt.generation, taskPath + '.prompt.generation', false);
      if (['pending', 'prompting', 'completed', 'failed', 'cancelled'].indexOf(task.prompt.status) < 0) fail('INVALID_RUNTIME_STATUS', 'prompt status 无效。', taskPath + '.prompt.status');
      task.prompt.requestJobId = assertSafeId(task.prompt.requestJobId, taskPath + '.prompt.requestJobId', false);
      if (task.prompt.status === 'prompting' && (!task.prompt.requestJobId || task.prompt.attempt < 1)) fail('INVALID_RUNTIME_STATUS', '在途 prompt 缺少 requestJobId/attempt。', taskPath + '.prompt');
      if (!Array.isArray(task.prompt.screenPrompts)) fail('INVALID_RUNTIME', 'screenPrompts 必须是数组。', taskPath + '.prompt.screenPrompts');
      task.prompt.screenPrompts = task.prompt.screenPrompts.map(function (prompt, index) {
        prompt = text(prompt, 50000);
        if (!prompt || promptLeakReason(prompt, bundle)) fail('RUNTIME_PROMPT_LEAK', '持久化 prompt 含来源字段、URL 或 data URI。', taskPath + '.prompt.screenPrompts[' + index + ']');
        return prompt;
      });
      if (!hasOwn(task.prompt, 'negativePrompt') || typeof task.prompt.negativePrompt !== 'string') {
        fail('INVALID_RUNTIME', '持久化 negativePrompt 必须是字符串。', taskPath + '.prompt.negativePrompt');
      }
      var normalizedNegativePrompt = text(task.prompt.negativePrompt, 50000);
      if (normalizedNegativePrompt !== task.prompt.negativePrompt) {
        fail('INVALID_RUNTIME', '持久化 negativePrompt 未安全规范化。', taskPath + '.prompt.negativePrompt');
      }
      if (promptLeakReason(normalizedNegativePrompt, bundle)) {
        fail('RUNTIME_PROMPT_LEAK', '持久化 negativePrompt 含来源字段、URL 或 data URI。', taskPath + '.prompt.negativePrompt');
      }
      task.prompt.negativePrompt = normalizedNegativePrompt;
      if (task.prompt.status === 'completed' && task.prompt.screenPrompts.length !== savedScreenCount) {
        fail('INVALID_RUNTIME_STATUS', 'completed prompt 必须完整覆盖全部分屏。', taskPath + '.prompt.screenPrompts');
      }
      if (task.prompt.status !== 'completed' && task.prompt.negativePrompt) {
        fail('INVALID_RUNTIME_STATUS', '未完成的 prompt 不得保留 negativePrompt。', taskPath + '.prompt.negativePrompt');
      }
      task.prompt.error = task.prompt.error ? normalizeError(task.prompt.error, 'PROMPT_FAILED', 'prompt') : null;
      if (task.prompt.error && promptLeakReason(task.prompt.error.message, bundle)) fail('RUNTIME_ERROR_LEAK', '持久化 prompt 错误含来源字段、URL 或 data URI。', taskPath + '.prompt.error.message');
      if (task.prompt.status === 'failed' && !task.prompt.error) fail('INVALID_RUNTIME_STATUS', 'failed prompt 必须包含错误。', taskPath + '.prompt.error');
      if (!Array.isArray(task.screens) || task.screens.length !== savedScreenCount) fail('INVALID_RUNTIME', '运行时 screens 数量与 screenCount 不一致。', taskPath + '.screens');
      var counts = { pending: 0, generating: 0, completed: 0, failed: 0, cancelled: 0, stale: 0 };
      task.screens.forEach(function (screen, screenIndex) {
        var screenPath = taskPath + '.screens[' + screenIndex + ']';
        if (!isPlainObject(screen) || Number(screen.screenIndex) !== screenIndex || Number(screen.screenNumber) !== screenIndex + 1) {
          fail('RUNTIME_SCREEN_MAPPING_MISMATCH', '分屏身份或顺序无效。', screenPath);
        }
        assertSafeId(screen.logicalJobId, screenPath + '.logicalJobId', true);
        screen.attempt = positiveRuntimeInteger(screen.attempt, screenPath + '.attempt', true);
        screen.generation = positiveRuntimeInteger(screen.generation, screenPath + '.generation', false);
        screen.requestJobId = assertSafeId(screen.requestJobId, screenPath + '.requestJobId', false);
        if (SCREEN_STATUSES.indexOf(screen.status) < 0) fail('INVALID_RUNTIME_STATUS', '分屏 status 无效。', screenPath + '.status');
        counts[screen.status] += 1;
        if (screen.status === 'generating' && (!screen.requestJobId || screen.attempt < 1)) fail('INVALID_RUNTIME_STATUS', '在途分屏缺少 requestJobId/attempt。', screenPath);
        if (screen.status === 'failed' && !screen.error) fail('INVALID_RUNTIME_STATUS', 'failed 分屏必须包含错误。', screenPath + '.error');
        screen.error = screen.error ? normalizeError(screen.error, 'IMAGE_FAILED', 'image') : null;
        if (screen.error && promptLeakReason(screen.error.message, bundle)) fail('RUNTIME_ERROR_LEAK', '持久化分屏错误含来源字段、URL 或 data URI。', screenPath + '.error.message');
        if (screen.status === 'completed') {
          if (!screen.resultRef) fail('INVALID_RUNTIME_STATUS', 'completed 分屏必须包含安全 resultRef。', screenPath + '.resultRef');
          screen.resultRef = verifyIssuedResultRef(screen.resultRef, {
            batchId: saved.batchId,
            taskId: task.taskId,
            screenIndex: screenIndex,
            generation: screen.generation,
            inputFingerprint: task.inputFingerprint
          }, screenPath + '.resultRef');
          if (resultIds[screen.resultRef.resultId] || resultRefs[screen.resultRef.ref]) {
            fail('DUPLICATE_RESULT_REF', '持久化结果在批次内跨任务或跨屏重复。', screenPath + '.resultRef');
          }
          resultIds[screen.resultRef.resultId] = true;
          resultRefs[screen.resultRef.ref] = true;
        } else if (screen.resultRef) {
          fail('INVALID_RUNTIME_STATUS', '非 completed 分屏不得携带 resultRef。', screenPath + '.resultRef');
        }
        screen.artifactRef = '';
      });
      if (task.phase === 'completed' && counts.completed !== savedScreenCount) fail('INVALID_RUNTIME_STATUS', 'completed 任务必须全部分屏完成。', taskPath + '.phase');
      if (task.phase === 'partial' && (!(counts.completed > 0 && counts.failed > 0) || counts.generating > 0)) fail('INVALID_RUNTIME_STATUS', 'partial 只允许无在途的成功与失败混合。', taskPath + '.phase');
      if (task.phase === 'failed' && ((task.prompt.status === 'failed' && counts.pending !== savedScreenCount) ||
          (task.prompt.status !== 'failed' && counts.failed !== savedScreenCount))) fail('INVALID_RUNTIME_STATUS', 'failed 任务必须为提词失败或全部分屏失败。', taskPath + '.phase');
      if (task.phase === 'prompting' && task.prompt.status !== 'prompting') fail('INVALID_RUNTIME_STATUS', 'prompting phase 与 prompt 状态不一致。', taskPath + '.phase');
      if (task.phase === 'generating' && (task.prompt.status !== 'completed' || (!counts.generating && !counts.pending))) fail('INVALID_RUNTIME_STATUS', 'generating phase 必须已有完整 prompt 和待处理/在途分屏。', taskPath + '.phase');
      if (task.phase === 'pending' && (counts.pending !== savedScreenCount || (task.prompt.status !== 'pending' && task.prompt.status !== 'completed'))) fail('INVALID_RUNTIME_STATUS', 'pending phase 与 prompt/分屏状态不一致。', taskPath + '.phase');
      if (task.phase === 'interrupted' && (counts.generating || task.prompt.status === 'prompting')) fail('INVALID_RUNTIME_STATUS', 'interrupted 任务不得保留在途状态。', taskPath + '.phase');
      if (task.phase === 'blocked' && counts.cancelled !== savedScreenCount) fail('INVALID_RUNTIME_STATUS', 'blocked 任务必须禁用全部分屏。', taskPath + '.phase');
      if (task.phase === 'stale' && counts.stale !== savedScreenCount) fail('INVALID_RUNTIME_STATUS', 'stale 任务必须标记全部分屏失效。', taskPath + '.phase');
      if (task.phase === 'cancelled' && (counts.pending || counts.generating)) fail('INVALID_RUNTIME_STATUS', 'cancelled 任务不得保留 pending/generating 分屏。', taskPath + '.phase');
    });
    return saved;
  }

  function restoreRuntime(savedInput, bundleInput, targetInputs, options) {
    options = isPlainObject(options) ? options : {};
    var bundle = validateExecutionBundle(bundleInput);
    var fresh = createBatchContext(bundle, targetInputs, options);
    if (savedInput == null) return fresh;
    var savedRuntime = validateSavedRuntimeShape(savedInput, bundle);
    var runtime = clone(fresh.runtime);
    var savedByDraft = Object.create(null);
    savedRuntime.tasks.forEach(function (task) { savedByDraft[task.draftTargetId] = task; });
    runtime.tasks.forEach(function (task, taskIndex) {
      var saved = savedByDraft[task.draftTargetId];
      if (!saved) return;
      var sameBatch = savedRuntime.batchId === runtime.batchId && savedRuntime.bundleId === runtime.bundleId &&
        savedRuntime.confirmationFingerprint === runtime.confirmationFingerprint &&
        Number(savedRuntime.screenCount) === Number(runtime.screenCount);
      if (sameBatch && saved.taskId !== task.taskId) {
        fail('RUNTIME_TASK_MAPPING_MISMATCH', '相同批次中的 taskId 映射被篡改。', '$runtime.tasks[' + taskIndex + '].taskId');
      }
      if (!sameBatch || saved.taskId !== task.taskId || saved.inputFingerprint !== task.inputFingerprint) {
        task.phase = 'stale';
        task.errors = [{ code: 'INPUT_STALE', stage: 'restore', message: '蓝图 revision、事实、素材、屏数或生成设置已变化，旧结果不可复用。', retryable: false }];
        task.screens.forEach(function (screen) { screen.status = 'stale'; });
        return;
      }
      if (saved.prompt.logicalJobId !== task.prompt.logicalJobId || saved.screens.some(function (screen, index) {
        return screen.logicalJobId !== task.screens[index].logicalJobId;
      })) {
        fail('RUNTIME_JOB_MAPPING_MISMATCH', '相同输入的 prompt/screen logicalJobId 映射被篡改。', '$runtime.tasks[' + taskIndex + ']');
      }
      if (CONTRACT.stableSerialize(saved.target) !== CONTRACT.stableSerialize(task.target)) {
        fail('RUNTIME_TARGET_MAPPING_MISMATCH', '相同输入的目标事实或素材元数据映射被篡改。', '$runtime.tasks[' + taskIndex + '].target');
      }
      task.generation = saved.generation;
      task.errors = clone(saved.errors);
      task.prompt = clone(saved.prompt);
      saved.screens.forEach(function (oldScreen, index) {
        task.screens[index] = clone(oldScreen);
        task.screens[index].artifactRef = '';
      });
      if (saved.phase === 'prompting' || saved.phase === 'generating') {
        task.generation += 1;
        task.phase = 'interrupted';
        if (task.prompt.status === 'prompting') {
          task.prompt.status = 'pending';
          task.prompt.generation = task.generation;
          task.prompt.requestJobId = '';
        }
        task.screens.forEach(function (screen) {
          if (screen.status === 'generating') {
            screen.status = 'pending';
            screen.generation = task.generation;
            screen.requestJobId = '';
          }
        });
      } else {
        task.phase = saved.phase;
      }
    });
    runtime.updatedAt = text(options.updatedAt || savedRuntime.updatedAt || runtime.updatedAt, 80);
    return deepFreeze({
      batch: fresh.batch,
      runtime: runtime,
      projections: fresh.projections,
      replicaPlans: fresh.replicaPlans,
      bundleId: fresh.bundleId,
      confirmationFingerprint: bundle.confirmationFingerprint
    });
  }

  function toContractTaskUpdate(runtimeInput, taskId) {
    var runtime = runtimeClone(runtimeInput);
    var seenResultIds = Object.create(null);
    var seenResultRefs = Object.create(null);
    runtime.tasks.forEach(function (runtimeTask, taskIndex) {
      runtimeTask.screens.forEach(function (screen, screenIndex) {
        if (screen.status === 'completed') {
          if (!screen.resultRef) fail('INVALID_RUNTIME_STATUS', 'completed 分屏缺少 resultRef。', '$runtime.tasks[' + taskIndex + '].screens[' + screenIndex + '].resultRef');
          var checked = verifyIssuedResultRef(screen.resultRef, {
            batchId: runtime.batchId,
            taskId: runtimeTask.taskId,
            screenIndex: screenIndex,
            generation: screen.generation,
            inputFingerprint: runtimeTask.inputFingerprint
          }, '$runtime.tasks[' + taskIndex + '].screens[' + screenIndex + '].resultRef');
          if (seenResultIds[checked.resultId] || seenResultRefs[checked.ref]) fail('DUPLICATE_RESULT_REF', '批次 resultId/ref 跨任务或跨屏重复。', '$runtime.tasks[' + taskIndex + '].screens[' + screenIndex + '].resultRef');
          seenResultIds[checked.resultId] = true;
          seenResultRefs[checked.ref] = true;
        } else if (screen.resultRef) {
          fail('INVALID_RUNTIME_STATUS', '非 completed 分屏不得携带 resultRef。', '$runtime.tasks[' + taskIndex + '].screens[' + screenIndex + '].resultRef');
        }
      });
    });
    var task = findTask(runtime, taskId).task;
    var status = 'pending';
    if (task.phase === 'prompting' || task.phase === 'generating') status = 'running';
    else if (task.phase === 'completed') status = 'completed';
    else if (task.phase === 'cancelled') status = 'cancelled';
    else if (task.phase === 'blocked') status = 'blocked';
    else if (task.phase === 'failed' || task.phase === 'partial' || task.phase === 'interrupted' || task.phase === 'stale') status = 'failed';
    var errors = clone(task.errors || []);
    if ((status === 'failed' || status === 'blocked') && !errors.length) {
      errors.push(normalizeError({
        code: task.phase === 'partial' ? 'PARTIAL_FAILURE' : task.phase === 'stale' ? 'INPUT_STALE' : 'TASK_FAILED',
        stage: task.phase === 'stale' ? 'restore' : 'generation',
        message: task.phase === 'partial' ? '部分分屏生成失败。' : task.phase === 'stale' ? '旧输入已失效。' : '任务未完成。',
        retryable: task.phase !== 'stale'
      }));
    }
    var resultRefs = task.screens.filter(function (screen) { return screen.status === 'completed' && screen.resultRef; })
      .sort(function (a, b) { return a.screenIndex - b.screenIndex; })
      .map(function (screen) { return clone(screen.resultRef); });
    return deepFreeze({ taskId: task.taskId, status: status, errors: errors, resultRefs: resultRefs });
  }

  function syncContractBatch(batchInput, runtimeInput, bundleInput, options) {
    options = isPlainObject(options) ? options : {};
    var bundle = validateExecutionBundle(bundleInput);
    var runtime = runtimeClone(runtimeInput);
    var updates = runtime.tasks.map(function (task) { return toContractTaskUpdate(runtime, task.taskId); });
    try {
      var contractOptions = {
        sourceSnapshot: bundle.sourceSnapshot,
        previousBlueprint: bundle.immediatePreviousBlueprint,
        verifiedTargetAssets: bundle.verifiedTargetAssets,
        updatedAt: options.updatedAt || batchInput.updatedAt
      };
      if (bundle.claimMode !== VISUAL_STRUCTURE_ONLY) contractOptions.verifiedProductFactCards = bundle.verifiedProductFactCards;
      return bundle.claimMode === VISUAL_STRUCTURE_ONLY
        ? CONTRACT.updateVisualStructureBatchProject(batchInput, { taskUpdates: updates }, bundle.currentBlueprint, contractOptions)
        : CONTRACT.updateBatchProject(batchInput, { taskUpdates: updates }, bundle.currentBlueprint, contractOptions);
    } catch (error) {
      fail(error.code || 'BATCH_CONTRACT_REJECTED', error.message || '合同批次同步失败。', error.path || '$batch');
    }
  }

  return deepFreeze({
    EXECUTION_SCHEMA: EXECUTION_SCHEMA,
    EXECUTION_SCHEMA_V2: EXECUTION_SCHEMA_V2,
    RUNTIME_SCHEMA: RUNTIME_SCHEMA,
    RUNTIME_SCHEMA_V2: RUNTIME_SCHEMA_V2,
    PROJECTION_SCHEMA: PROJECTION_SCHEMA,
    PROJECTION_SCHEMA_V2: PROJECTION_SCHEMA_V2,
    REPLICA_PLAN_SCHEMA: REPLICA_PLAN_SCHEMA,
    REPLICA_PLAN_SCHEMA_V2: REPLICA_PLAN_SCHEMA_V2,
    VISUAL_STRUCTURE_ONLY: VISUAL_STRUCTURE_ONLY,
    REPLICA_SET_SCHEMA: REPLICA_SET_SCHEMA,
    REUSE_MODES: REUSE_MODES,
    REPLICA_LIFECYCLE_STATES: REPLICA_LIFECYCLE_STATES,
    REPLICA_FEATURES: REPLICA_FEATURES,
    TASK_PHASES: TASK_PHASES,
    BatchError: BatchError,
    safeGenerationSettings: safeGenerationSettings,
    normalizeDraftTarget: normalizeDraftTarget,
    duplicateDraftTarget: duplicateDraftTarget,
    toContractTargets: toContractTargets,
    validateExecutionBundle: validateExecutionBundle,
    createConfirmationFingerprint: createConfirmationFingerprint,
    createInputFingerprint: createInputFingerprint,
    createReplicaPlan: createReplicaPlan,
    createReplicaSet: createReplicaSet,
    deriveReplicaLifecycle: deriveReplicaLifecycle,
    createGenerationProjection: createGenerationProjection,
    getTaskProjection: getTaskProjection,
    getTaskReplicaPlan: getTaskReplicaPlan,
    assertGenerationPayloadSafe: assertGenerationPayloadSafe,
    createBatchContext: createBatchContext,
    beginPrompting: beginPrompting,
    acceptPromptResponse: acceptPromptResponse,
    beginScreenAttempt: beginScreenAttempt,
    acceptScreenResponse: acceptScreenResponse,
    createSafeResultRef: createSafeResultRef,
    cancelTask: cancelTask,
    cancelAll: cancelAll,
    restartTask: restartTask,
    retryFailedScreens: retryFailedScreens,
    retryUnavailableScreens: retryUnavailableScreens,
    restoreRuntime: restoreRuntime,
    toContractTaskUpdate: toContractTaskUpdate,
    syncContractBatch: syncContractBatch
  });
});

;
/* Frozen source: public/creative/labs/image-prompt-lab/image-archive-store.js */
/* image-archive-store.js — 生图结果本机留档、7天回收站与缺失清理 */
(function (root, factory) {
  var api = factory(root || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SZ_IMAGE_ARCHIVE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var DB_NAME = 'sz_image_archive_v1';
  var DB_VERSION = 2;
  var BATCH_STORE = 'batches';
  var ASSET_STORE = 'assets';
  var TOMBSTONE_STORE = 'referenceProvisionalTombstones';
  var RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  var PROVISIONAL_RETENTION_MS = 24 * 60 * 60 * 1000;
  var MAX_PROVISIONAL_SCAN_LIMIT = 48;
  var MAX_IMAGE_BYTES = 40 * 1024 * 1024;
  var STORAGE_TIMEOUT_MS = 15000;
  var SKU_OUTPUT_MIN_EDGE = 256;
  var SKU_OUTPUT_MAX_EDGE = 4096;
  var SKU_OUTPUT_MAX_PIXELS = 16777216;
  var SKU_OUTPUT_IDENTITY_FIELDS = [
    'outputSize', 'outputWidth', 'outputHeight',
    'providerSize', 'providerRatio', 'providerResolution'
  ];
  var SKU_PROVIDER_RATIO_ORDER = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
  var SKU_PROVIDER_BASE_SIZES = {
    '1:1': [1024, 1024],
    '2:3': [896, 1344],
    '3:2': [1344, 896],
    '3:4': [768, 1024],
    '4:3': [1024, 768],
    '4:5': [1024, 1280],
    '5:4': [1280, 1024],
    '9:16': [1024, 1792],
    '16:9': [1792, 1024],
    '21:9': [2048, 878]
  };

  function text(value, max) {
    var out = String(value == null ? '' : value).trim();
    return max ? out.slice(0, max) : out;
  }

  function normalizeAccountKey(value) {
    return text(value, 140) || 'local';
  }

  function safeInteger(value, min, max, fallback) {
    var number = Number(value);
    return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
  }

  function ownDataValue(raw, key) {
    var descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(raw, key); }
    catch (_) { return { ok: false }; }
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return { ok: false };
    return { ok: true, value: descriptor.value };
  }

  function skuPixelSize(value) {
    if (typeof value !== 'string') return null;
    var match = /^(\d{1,5})\*(\d{1,5})$/.exec(value);
    if (!match) return null;
    var width = Number(match[1]);
    var height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || value !== width + '*' + height) return null;
    return { width: width, height: height, size: value };
  }

  function skuGreatestCommonDivisor(a, b) {
    a = Math.abs(a);
    b = Math.abs(b);
    while (b) {
      var next = a % b;
      a = b;
      b = next;
    }
    return a || 1;
  }

  function skuExactRatio(width, height) {
    var divisor = skuGreatestCommonDivisor(width, height);
    return (width / divisor) + ':' + (height / divisor);
  }

  function skuRoundToEight(value) {
    return Math.max(8, Math.round(value / 8) * 8);
  }

  function skuProviderTuple(ratio, resolution) {
    var base = SKU_PROVIDER_BASE_SIZES[ratio];
    if (!base || ['1K', '2K', '4K'].indexOf(resolution) < 0) return null;
    var width = base[0];
    var height = base[1];
    if (resolution !== '1K') {
      var targetLongest = resolution === '2K' ? 2048 : 4096;
      var scale = targetLongest / Math.max(width, height);
      width = skuRoundToEight(width * scale);
      height = skuRoundToEight(height * scale);
    }
    return { size: width + '*' + height, width: width, height: height, ratio: ratio, resolution: resolution };
  }

  function skuNearestProviderTuple(width, height) {
    var target = width / height;
    var selected = SKU_PROVIDER_RATIO_ORDER[0];
    var distance = Infinity;
    SKU_PROVIDER_RATIO_ORDER.forEach(function (ratio) {
      var parts = ratio.split(':');
      var candidate = Number(parts[0]) / Number(parts[1]);
      var current = Math.abs(Math.log(target / candidate));
      if (current < distance - 1e-12) {
        distance = current;
        selected = ratio;
      }
    });
    var longest = Math.max(width, height);
    return skuProviderTuple(selected, longest <= 1024 ? '1K' : (longest <= 2048 ? '2K' : '4K'));
  }

  function inspectSkuOutputIdentity(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.surfaceMode !== 'sku') {
      return { state: 'none', value: null };
    }
    var present = SKU_OUTPUT_IDENTITY_FIELDS.filter(function (key) {
      try { return Object.prototype.hasOwnProperty.call(raw, key); }
      catch (_) { return false; }
    });
    if (!present.length) return { state: 'none', value: null };
    if (present.length !== SKU_OUTPUT_IDENTITY_FIELDS.length) {
      return { state: 'invalid', error: 'SKU 档案输出尺寸身份字段不完整。' };
    }
    var values = {};
    for (var index = 0; index < SKU_OUTPUT_IDENTITY_FIELDS.length; index++) {
      var key = SKU_OUTPUT_IDENTITY_FIELDS[index];
      var field = ownDataValue(raw, key);
      if (!field.ok) return { state: 'invalid', error: 'SKU 档案输出尺寸身份必须是普通数据字段。' };
      values[key] = field.value;
    }
    var ratioField = ownDataValue(raw, 'ratio');
    var resolutionField = ownDataValue(raw, 'resolution');
    if (!ratioField.ok || !resolutionField.ok || typeof ratioField.value !== 'string' || typeof resolutionField.value !== 'string') {
      return { state: 'invalid', error: 'SKU 档案缺少最终比例或分辨率身份。' };
    }
    if (typeof values.outputSize !== 'string' || typeof values.outputWidth !== 'number' ||
        typeof values.outputHeight !== 'number' || typeof values.providerSize !== 'string' ||
        typeof values.providerRatio !== 'string' || typeof values.providerResolution !== 'string') {
      return { state: 'invalid', error: 'SKU 档案输出尺寸身份字段类型无效。' };
    }
    var output = skuPixelSize(values.outputSize);
    var provider = skuPixelSize(values.providerSize);
    if (!output || !provider || !Number.isSafeInteger(values.outputWidth) || !Number.isSafeInteger(values.outputHeight) ||
        output.width !== values.outputWidth || output.height !== values.outputHeight) {
      return { state: 'invalid', error: 'SKU 档案输出宽高与尺寸标识不一致。' };
    }
    if (output.width < SKU_OUTPUT_MIN_EDGE || output.height < SKU_OUTPUT_MIN_EDGE ||
        output.width > SKU_OUTPUT_MAX_EDGE || output.height > SKU_OUTPUT_MAX_EDGE ||
        output.width * output.height > SKU_OUTPUT_MAX_PIXELS ||
        provider.width < SKU_OUTPUT_MIN_EDGE || provider.height < SKU_OUTPUT_MIN_EDGE ||
        provider.width > SKU_OUTPUT_MAX_EDGE || provider.height > SKU_OUTPUT_MAX_EDGE ||
        provider.width * provider.height > SKU_OUTPUT_MAX_PIXELS) {
      return { state: 'invalid', error: 'SKU 档案输出尺寸超过安全范围。' };
    }
    var ratio = ratioField.value;
    var resolution = resolutionField.value;
    var expectedProvider;
    if (resolution === 'custom') {
      if (ratio !== skuExactRatio(output.width, output.height)) {
        return { state: 'invalid', error: 'SKU 档案自定义输出比例与精确宽高不一致。' };
      }
      expectedProvider = skuNearestProviderTuple(output.width, output.height);
    } else {
      expectedProvider = skuProviderTuple(ratio, resolution);
      // 21:9 的安全像素经过 8px 对齐，不要求 width / height 数学上恰好等于 21 / 9；
      // 只以同一预设算法产生的 canonical 尺寸为准。
      if (!expectedProvider || expectedProvider.size !== output.size) {
        return { state: 'invalid', error: 'SKU 档案预设输出尺寸与比例分辨率不一致。' };
      }
    }
    if (!expectedProvider || values.providerSize !== expectedProvider.size ||
        values.providerRatio !== expectedProvider.ratio || values.providerResolution !== expectedProvider.resolution) {
      return { state: 'invalid', error: 'SKU 档案模型底图身份与最终输出尺寸不一致。' };
    }
    return { state: 'valid', value: values };
  }

  function sanitizeSkuOutputIdentity(raw) {
    var inspected = inspectSkuOutputIdentity(raw);
    if (inspected.state !== 'valid') return null;
    return Object.assign({}, inspected.value);
  }

  function invalidSkuOutputIdentity(message) {
    return Object.assign(new Error(message || 'SKU 档案输出尺寸身份无效。'), {
      code: 'ARCHIVE_SKU_OUTPUT_IDENTITY_INVALID'
    });
  }

  function exactDataValues(raw, allowedKeys) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var keys;
    try { keys = Object.keys(raw).sort(); }
    catch (_) { return null; }
    if (keys.join(',') !== allowedKeys.slice().sort().join(',')) return null;
    var values = {};
    for (var index = 0; index < allowedKeys.length; index++) {
      var key = allowedKeys[index];
      var descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(raw, key); }
      catch (_) { return null; }
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      values[key] = descriptor.value;
    }
    return values;
  }

  function textList(value, limit, max) {
    var out = [];
    (Array.isArray(value) ? value : []).forEach(function (item) {
      item = text(item, max || 40);
      if (item && out.indexOf(item) < 0 && out.length < (limit || 8)) out.push(item);
    });
    return out;
  }

  function hashText(value) {
    var h = 2166136261;
    value = String(value || '');
    for (var i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
    return ('00000000' + (h >>> 0).toString(16)).slice(-8);
  }

  function randomWriteToken() {
    var bytes = new Uint8Array(16);
    try {
      if (root.crypto && typeof root.crypto.getRandomValues === 'function') {
        root.crypto.getRandomValues(bytes);
        return Array.prototype.map.call(bytes, function (value) { return ('0' + value.toString(16)).slice(-2); }).join('');
      }
    } catch (_) {}
    return hashText([Date.now(), Math.random(), Math.random()].join('|')) + hashText([Math.random(), Date.now()].join('|'));
  }

  function canonicalArchiveLinkId(value) {
    var match = /^\s*L?0*(\d+)\s*$/i.exec(String(value || ''));
    if (!match) return '';
    var sequence = Number(match[1]);
    if (!Number.isSafeInteger(sequence) || sequence < 1) return '';
    return 'L' + String(sequence).padStart(3, '0');
  }

  function archiveLinkIds(values) {
    var seen = Object.create(null);
    return (Array.isArray(values) ? values : [values]).map(canonicalArchiveLinkId).filter(function (id) {
      if (!id || seen[id]) return false;
      seen[id] = true;
      return true;
    }).sort(function (a, b) { return Number(a.slice(1)) - Number(b.slice(1)); });
  }

  function archiveLinkRangeLabel(values) {
    var ids = archiveLinkIds(values);
    if (!ids.length) return '';
    var ranges = [];
    var start = ids[0];
    var previous = ids[0];
    function pushRange() { ranges.push(start === previous ? start : (start + '–' + previous)); }
    for (var i = 1; i < ids.length; i++) {
      if (Number(ids[i].slice(1)) === Number(previous.slice(1)) + 1) {
        previous = ids[i];
        continue;
      }
      pushRange();
      start = previous = ids[i];
    }
    pushRange();
    return ranges.join('、');
  }

  function numberedLinkSurface(asset) {
    return !!(asset && (asset.surfaceMode === 'main' || asset.surfaceMode === 'detail') && canonicalArchiveLinkId(asset.linkId));
  }

  function allowedMime(value) {
    value = text(value, 80).toLowerCase().split(';')[0];
    if (value === 'image/jpg') value = 'image/jpeg';
    return /^(image\/png|image\/jpeg|image\/webp|image\/gif)$/.test(value) ? value : '';
  }

  function dataUrlToBlob(dataUrl) {
    var match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(dataUrl || ''));
    if (!match) return Promise.reject(new Error('不是可留档的图片数据'));
    var mime = allowedMime(match[1]);
    if (!mime) return Promise.reject(new Error('不支持的图片格式'));
    try {
      var binary = root.atob ? root.atob(match[2].replace(/\s+/g, '')) : Buffer.from(match[2], 'base64').toString('binary');
      if (binary.length > MAX_IMAGE_BYTES) return Promise.reject(new Error('单张留档图片不能超过40MB'));
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return Promise.resolve(new Blob([bytes], { type: mime }));
    } catch (error) {
      return Promise.reject(new Error('图片数据解码失败'));
    }
  }

  function validBlob(blob) {
    return !!(blob && typeof blob.size === 'number' && blob.size > 0 && blob.size <= MAX_IMAGE_BYTES && allowedMime(blob.type));
  }

  function receiptContentUrl(value) {
    try {
      var pageOrigin = root.location && root.location.origin;
      if (typeof pageOrigin !== 'string' || !/^https?:\/\//i.test(pageOrigin)) return '';
      var url = new URL(value);
      if (url.origin !== pageOrigin || url.username || url.password || url.hash) return '';
      var match = /^\/api\/creative\/image-receipts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/content\/(0|[1-9]\d*)$/.exec(url.pathname);
      if (!match || !Number.isSafeInteger(Number(match[2]))) return '';
      var queryNames = [];
      url.searchParams.forEach(function (_, name) { queryNames.push(name); });
      if (queryNames.length !== 1 || queryNames[0] !== 'identity') return '';
      var identity = JSON.parse(url.searchParams.get('identity'));
      if (!identity || typeof identity !== 'object' || Array.isArray(identity) || identity.version !== 1 || identity.receiptId !== match[1]) return '';
      return url.href;
    } catch (_) { return ''; }
  }

  function receiptReadError(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
  }

  function receiptContentToBlob(value, fetcher) {
    var pacer = root.SZCreativeRequestPacer;
    if (!pacer || pacer.version !== 1) return receiptContentToBlobOnce(value,fetcher);
    var identity;
    try { identity = JSON.parse(new URL(value,root.location.origin).searchParams.get('identity')); } catch (_) { return Promise.reject(receiptReadError('IMAGE_RECEIPT_READ_FAILED','图片回执身份暂不能核对')); }
    return pacer.read(identity,function () {
      return receiptContentToBlobOnce(value,fetcher).then(function (blob) { return {status:200,value:blob}; },function (error) {
        if (error && error.httpStatus === 429) return {status:429,retryAfter:error.retryAfter,error:error};throw error;
      });
    }).then(function (result) { if (result && result.status === 200) return result.value;throw result && result.error || receiptReadError('IMAGE_RECEIPT_READ_FAILED','图片回执暂不能读取，可稍后补存'); });
  }

  function receiptContentToBlobOnce(value, fetcher) {
    if (typeof root.AbortController !== 'function' || typeof root.setTimeout !== 'function' || typeof root.clearTimeout !== 'function' || !root.crypto || !root.crypto.subtle) {
      return Promise.reject(receiptReadError('IMAGE_RECEIPT_READ_UNAVAILABLE', '当前环境无法安全读取图片回执'));
    }
    return new Promise(function (resolve, reject) {
      var controller = new root.AbortController(), finished = false, reader, headersTimer, idleTimer, totalTimer;
      var origin = root.location.origin, frame = root.frameElement;
      function current() { return root.location.origin === origin && (!frame || root.frameElement === frame && frame.isConnected); }
      function clearTimers() { root.clearTimeout(headersTimer);root.clearTimeout(idleTimer);root.clearTimeout(totalTimer); }
      function fail(error) {
        if (finished) return;
        finished = true;clearTimers();try { controller.abort(); } catch (_) {}
        if (reader && typeof reader.cancel === 'function') { try { Promise.resolve(reader.cancel()).catch(function () {}); } catch (_) {} }
        reject(error && (['IMAGE_RECEIPT_READ_TIMEOUT','IMAGE_RECEIPT_CONTENT_MISMATCH','IMAGE_RECEIPT_READ_UNAVAILABLE'].indexOf(error.code) >= 0 || error.httpStatus === 429) ? error : receiptReadError('IMAGE_RECEIPT_READ_FAILED', '图片回执读取失败，可稍后补存原图'));
      }
      function timeout() { fail(receiptReadError('IMAGE_RECEIPT_READ_TIMEOUT', '图片回执读取超时，可稍后补存原图')); }
      function check() { if (finished || controller.signal.aborted || !current()) throw receiptReadError('IMAGE_RECEIPT_READ_FAILED', '原件所属页面已变化，请从原任务补存'); }
      function idle() { root.clearTimeout(idleTimer);idleTimer=root.setTimeout(timeout,30000); }
      headersTimer=root.setTimeout(timeout,30000);totalTimer=root.setTimeout(timeout,8*60*1000);
      Promise.resolve().then(function () {
        check();return fetcher(value,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal});
      }).then(async function (response) {
        check();root.clearTimeout(headersTimer);
        if (response && response.status === 429) {
          var limited=receiptReadError('IMAGE_RECEIPT_RATE_LIMITED','图片回执读取排队中，可稍后补存');limited.httpStatus=429;limited.retryAfter=response.headers&&response.headers.get&&response.headers.get('Retry-After');
          if (response.body && typeof response.body.cancel === 'function') { try { Promise.resolve(response.body.cancel()).catch(function () {}); } catch (_) {} }
          throw limited;
        }
        if (!response || !response.ok || !response.body || typeof response.body.getReader !== 'function') throw receiptReadError('IMAGE_RECEIPT_READ_UNAVAILABLE','无法完整核对原件正文，请稍后补存');
        var length=response.headers&&response.headers.get&&response.headers.get('Content-Length'),expected=response.headers&&response.headers.get&&response.headers.get('X-Sanjie-Image-Content-Sha256');
        var mime=allowedMime(response.headers&&response.headers.get&&response.headers.get('Content-Type'));
        if (!/^[1-9]\d*$/.test(length||'') || !Number.isSafeInteger(Number(length)) || Number(length)>MAX_IMAGE_BYTES || !/^[a-f0-9]{64}$/.test(expected||'') || !mime) throw receiptReadError('IMAGE_RECEIPT_CONTENT_MISMATCH','原件校验信息不完整，请保留原请求核对');
        reader=response.body.getReader();var chunks=[],size=0,empty=0;idle();
        for (;;) {
          check();var part=await reader.read();check();
          if (part.done) break;
          if (!part.value || typeof part.value.byteLength !== 'number') throw receiptReadError('IMAGE_RECEIPT_CONTENT_MISMATCH','原件正文暂不能核对');
          var chunk=new Uint8Array(part.value);
          if (!chunk.byteLength) { if (++empty>32) throw receiptReadError('IMAGE_RECEIPT_CONTENT_MISMATCH','原件正文没有有效进展');continue; }
          empty=0;size+=chunk.byteLength;
          if (size>MAX_IMAGE_BYTES || size>Number(length)) throw receiptReadError('IMAGE_RECEIPT_CONTENT_MISMATCH','原件正文大小不匹配');
          chunks.push(chunk.slice());idle();
        }
        root.clearTimeout(idleTimer);
        if (size!==Number(length)) throw receiptReadError('IMAGE_RECEIPT_CONTENT_MISMATCH','原件正文尚未完整接收');
        var blob=new root.Blob(chunks,{type:mime});check();
        var digest=await root.crypto.subtle.digest('SHA-256',await blob.arrayBuffer());check();
        var actual=Array.prototype.map.call(new Uint8Array(digest),function (b) { return b.toString(16).padStart(2,'0'); }).join('');
        if (actual!==expected || !validBlob(blob)) throw receiptReadError('IMAGE_RECEIPT_CONTENT_MISMATCH','原件内容校验不匹配，请保留原请求核对');
        return blob;
      }).then(function (blob) { if (finished) return;check();finished=true;clearTimers();resolve(blob); }).catch(fail);
    });
  }

  function sourceToBlob(source, fetcher) {
    if (validBlob(source)) return Promise.resolve(source);
    var value = String(source || '');
    if (/^data:image\//i.test(value)) return dataUrlToBlob(value);
    if (!/^(https?:|blob:)/i.test(value)) return Promise.reject(new Error('没有可留档的本机图片来源'));
    fetcher = fetcher || root.fetch;
    if (typeof fetcher !== 'function') return Promise.reject(new Error('当前环境无法读取图片文件'));
    var receiptUrl = receiptContentUrl(value);
    if (receiptUrl) return receiptContentToBlob(receiptUrl, fetcher);
    return fetcher(value, { credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (response) {
      if (!response || !response.ok) throw new Error('图片文件读取失败');
      var declared = Number(response.headers && response.headers.get && response.headers.get('content-length')) || 0;
      if (declared > MAX_IMAGE_BYTES) throw new Error('单张留档图片不能超过40MB');
      return response.blob();
    }).then(function (blob) {
      if (!validBlob(blob)) throw new Error('返回内容不是有效图片或超过40MB');
      return blob;
    });
  }

  function webAccountKey(id) {
    if (root.SZ_WEB_ACCOUNT && typeof root.SZ_WEB_ACCOUNT.storageKey === 'function') {
      return root.SZ_WEB_ACCOUNT.storageKey(id);
    }
    return 'user:' + String(id).replace(/[^\w@.+:-]/g, '_').slice(0, 120);
  }

  function openDb(expectedAccountKey) {
    return new Promise(function (resolve, reject) {
      var request;
      var settled = false;
      var timer = setTimeout(function () { fail(new Error('本机图片档案打开超时，请稍后重试。')); }, STORAGE_TIMEOUT_MS);
      function fail(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
      if (root.SZ_WEB_ACCOUNT && normalizeAccountKey(expectedAccountKey) === 'local') {
        fail(Object.assign(new Error('图片档案账号尚未就绪，请等待工作台加载完成后重试。'), { code: 'ARCHIVE_ACCOUNT_NOT_READY' }));
        return;
      }
      Promise.resolve().then(function () {
        return root.SZ_WEB_ACCOUNT ? root.SZ_WEB_ACCOUNT.require() : null;
      }).then(function (id) {
        if (settled) return;
        if (root.SZ_WEB_ACCOUNT && normalizeAccountKey(expectedAccountKey) !== webAccountKey(id)) {
          throw new Error('登录账号已变化，请刷新工作台后继续读取原账号的图片档案。');
        }
        if (!root.indexedDB) throw new Error('当前环境不支持本机图片档案');
        request = root.indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = function () {
          if (settled) { try { request.transaction.abort(); } catch (_) {} return; }
          var db = request.result;
          var batches = db.objectStoreNames.contains(BATCH_STORE)
            ? request.transaction.objectStore(BATCH_STORE)
            : db.createObjectStore(BATCH_STORE, { keyPath: 'archiveBatchId' });
          if (!batches.indexNames.contains('accountKey')) batches.createIndex('accountKey', 'accountKey', { unique: false });
          if (!batches.indexNames.contains('updatedAt')) batches.createIndex('updatedAt', 'updatedAt', { unique: false });
          var assets = db.objectStoreNames.contains(ASSET_STORE)
            ? request.transaction.objectStore(ASSET_STORE)
            : db.createObjectStore(ASSET_STORE, { keyPath: 'archiveAssetId' });
          if (!assets.indexNames.contains('accountKey')) assets.createIndex('accountKey', 'accountKey', { unique: false });
          if (!assets.indexNames.contains('archiveBatchId')) assets.createIndex('archiveBatchId', 'archiveBatchId', { unique: false });
          if (!assets.indexNames.contains('purgeAt')) assets.createIndex('purgeAt', 'purgeAt', { unique: false });
          if (!assets.indexNames.contains('referenceProvisionalScanKey')) {
            assets.createIndex('referenceProvisionalScanKey', ['archiveState', 'surfaceMode', 'detailMode', 'provisionalExpiresAt', 'accountKey', 'archiveAssetId'], { unique: false });
          }
          if (!assets.indexNames.contains('accountReferenceProvisionalScanKey')) {
            assets.createIndex('accountReferenceProvisionalScanKey', ['accountKey', 'archiveState', 'surfaceMode', 'detailMode', 'provisionalExpiresAt', 'archiveAssetId'], { unique: false });
          }
          var tombstones = db.objectStoreNames.contains(TOMBSTONE_STORE)
            ? request.transaction.objectStore(TOMBSTONE_STORE)
            : db.createObjectStore(TOMBSTONE_STORE, { keyPath: 'archiveAssetId' });
          if (!tombstones.indexNames.contains('accountKey')) tombstones.createIndex('accountKey', 'accountKey', { unique: false });
          if (!tombstones.indexNames.contains('savedAt')) tombstones.createIndex('savedAt', 'savedAt', { unique: false });
        };
        request.onsuccess = function () {
          var db = request.result;
          if (settled) { db.close(); return; }
          settled = true;
          clearTimeout(timer);
          db.onversionchange = function () { db.close(); };
          resolve(db);
        };
        request.onblocked = function () { fail(new Error('本机图片档案被旧工作台占用，请关闭旧页面后重试。')); };
        request.onerror = function () { fail(request.error || new Error('无法打开本机图片档案')); };
      }).catch(fail);
    });
  }

  function transaction(storeNames, mode, task, accountKey) {
    return openDb(accountKey).then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx;
        var stores = {};
        var result;
        var settled = false;
        var timer = setTimeout(function () { fail(new Error('本机图片档案读写超时，请稍后重试。')); }, STORAGE_TIMEOUT_MS);
        function fail(error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (tx) { try { tx.abort(); } catch (_) {} }
          db.close();
          reject(error || new Error('本机图片档案事务失败'));
        }
        try {
          tx = db.transaction(storeNames, mode);
          tx.oncomplete = function () {
            if (settled) return;
            try {
              var value = typeof result === 'function' ? result() : result;
              settled = true;
              clearTimeout(timer);
              db.close();
              resolve(value);
            } catch (error) { fail(error); }
          };
          tx.onerror = function () { fail(tx.error || new Error('本机图片档案事务失败')); };
          tx.onabort = function () { fail(tx.error || new Error('本机图片档案事务已取消')); };
          storeNames.forEach(function (name) { stores[name] = tx.objectStore(name); });
          result = task(stores, fail);
        }
        catch (error) { fail(error); }
      });
    });
  }

  function sanitizeArchiveInput(raw) {
    raw = raw || {};
    var accountKey = normalizeAccountKey(raw.accountKey);
    var surfaceMode = ['main', 'detail', 'sku', 'viral'].indexOf(raw.surfaceMode) >= 0 ? raw.surfaceMode : 'main';
    var skuOutputIdentity = inspectSkuOutputIdentity(raw);
    if (skuOutputIdentity.state === 'invalid') throw invalidSkuOutputIdentity(skuOutputIdentity.error);
    var sourceBatchId = text(raw.sourceBatchId || raw.batchId || raw.jobId || raw.resultId, 220) || ('local_' + Date.now());
    var archiveBatchId = text(raw.archiveBatchId, 260) || ('archive_batch_' + hashText(accountKey + '|' + surfaceMode + '|' + sourceBatchId));
    var resultId = text(raw.resultId || raw.jobId, 260) || ('result_' + Date.now() + '_' + Math.random().toString(16).slice(2));
    var archiveAssetId = text(raw.archiveAssetId, 260) || ('archive_asset_' + hashText(accountKey + '|' + archiveBatchId + '|' + resultId));
    var safe = {
      accountKey: accountKey,
      surfaceMode: surfaceMode,
      creativeRoute: text(raw.creativeRoute, 80),
      detailMode: text(raw.detailMode, 80),
      sourceBatchId: sourceBatchId,
      technicalSourceBatchId: text(raw.technicalSourceBatchId, 260),
      blueprintId: text(raw.blueprintId, 260),
      archiveBatchId: archiveBatchId,
      archiveProjectId: text(raw.archiveProjectId, 260),
      archiveAssetId: archiveAssetId,
      resultId: resultId,
      batchTitle: text(raw.batchTitle, 160) || '本机生图档案',
      businessBatchTitle: text(raw.businessBatchTitle, 180),
      businessType: text(raw.businessType, 60),
      productName: text(raw.productName, 180),
      styleName: text(raw.styleName, 100),
      strengthName: text(raw.strengthName, 80),
      copyModeName: text(raw.copyModeName, 80),
      businessRoleKey: text(raw.businessRoleKey, 180),
      businessRoleName: text(raw.businessRoleName, 180),
      businessSummary: text(raw.businessSummary, 800),
      businessTags: textList(raw.businessTags, 8, 40),
      generationKind: text(raw.generationKind, 40),
      linkId: text(raw.linkId, 40),
      skuId: text(raw.skuId, 120),
      skuCode: text(raw.skuCode, 80),
      skuTitle: text(raw.skuTitle, 300),
      variant: text(raw.variant, 100),
      variantName: text(raw.variantName, 180),
      imageIndex: safeInteger(raw.imageIndex, 1, Number.MAX_SAFE_INTEGER, 1),
      ratio: text(raw.ratio, 20),
      resolution: text(raw.resolution, 20),
      provider: text(raw.provider, 80),
      imageModel: text(raw.imageModel, 120),
      prompt: text(raw.prompt, 30000),
      negativePrompt: text(raw.negativePrompt, 8000),
      promptBatchId: text(raw.promptBatchId, 260),
      parentResultId: text(raw.parentResultId, 260),
      parentBatchId: text(raw.parentBatchId, 260),
      guideOriginBatchId: text(raw.guideOriginBatchId, 260),
      taskId: text(raw.taskId, 180),
      jobId: text(raw.jobId, 260),
      logicalJobId: text(raw.logicalJobId, 260),
      generation: safeInteger(raw.generation, 0, Number.MAX_SAFE_INTEGER, 0),
      attempt: safeInteger(raw.attempt, 0, Number.MAX_SAFE_INTEGER, 0),
      inputFingerprint: text(raw.inputFingerprint, 260),
      screenIndex: safeInteger(raw.screenIndex, 0, Number.MAX_SAFE_INTEGER,
        safeInteger(raw.imageIndex, 1, Number.MAX_SAFE_INTEGER, 1) - 1),
      createdAt: Math.max(1, Number(raw.createdAt) || Date.now())
    };
    if (surfaceMode === 'sku' && skuOutputIdentity.state === 'valid') {
      Object.assign(safe, skuOutputIdentity.value);
    }
    return safe;
  }

  function skuOutputIdentityMatches(left, right) {
    var leftIdentity = inspectSkuOutputIdentity(left);
    var rightIdentity = inspectSkuOutputIdentity(right);
    if (leftIdentity.state === 'none' && rightIdentity.state === 'none') return true;
    if (leftIdentity.state !== 'valid' || rightIdentity.state !== 'valid') return false;
    return left.ratio === right.ratio && left.resolution === right.resolution && SKU_OUTPUT_IDENTITY_FIELDS.every(function (key) {
      return leftIdentity.value[key] === rightIdentity.value[key];
    });
  }

  function provisionalIdentityMatches(left, right) {
    left = left || {};
    right = right || {};
    return normalizeAccountKey(left.accountKey) === normalizeAccountKey(right.accountKey) &&
      text(left.archiveBatchId, 260) === text(right.archiveBatchId, 260) &&
      text(left.archiveAssetId, 260) === text(right.archiveAssetId, 260) &&
      text(left.technicalSourceBatchId, 260) === text(right.technicalSourceBatchId, 260) &&
      text(left.blueprintId, 260) === text(right.blueprintId, 260) &&
      text(left.resultId, 260) === text(right.resultId, 260) &&
      text(left.taskId, 180) === text(right.taskId, 180) &&
      ((left.archiveState !== 'provisional' && !text(left.jobId, 260)) || text(left.jobId, 260) === text(right.jobId, 260)) &&
      text(left.logicalJobId, 260) === text(right.logicalJobId, 260) &&
      safeInteger(left.generation, 0, Number.MAX_SAFE_INTEGER, 0) === safeInteger(right.generation, 0, Number.MAX_SAFE_INTEGER, 0) &&
      safeInteger(left.attempt, 0, Number.MAX_SAFE_INTEGER, 0) === safeInteger(right.attempt, 0, Number.MAX_SAFE_INTEGER, 0) &&
      text(left.inputFingerprint, 260) === text(right.inputFingerprint, 260) &&
      safeInteger(left.screenIndex, 0, Number.MAX_SAFE_INTEGER, 0) === safeInteger(right.screenIndex, 0, Number.MAX_SAFE_INTEGER, 0) &&
      safeInteger(left.imageIndex, 1, Number.MAX_SAFE_INTEGER, 1) === safeInteger(right.imageIndex, 1, Number.MAX_SAFE_INTEGER, 1) &&
      text(left.detailMode, 80) === text(right.detailMode, 80) &&
      text(left.surfaceMode, 40) === text(right.surfaceMode, 40) &&
      skuOutputIdentityMatches(left, right);
  }

  function archiveCollision(message) {
    return Object.assign(new Error(message || '本机档案 assetId 已被其他账号或结果身份占用。'), {
      code: 'ARCHIVE_ASSET_COLLISION'
    });
  }

  function provisionalReceipt(record, meta) {
    record = record || {};
    meta = meta || {};
    var provisional = record.archiveState === 'provisional';
    var output = {
      schema: 'IMAGE_ARCHIVE_PROVISIONAL_RECEIPT_V2',
      schemaVersion: 2,
      accountKey: text(record.accountKey, 140),
      technicalSourceBatchId: text(record.technicalSourceBatchId, 260),
      blueprintId: text(record.blueprintId, 260),
      archiveBatchId: text(record.archiveBatchId, 260),
      archiveAssetId: text(record.archiveAssetId, 260),
      resultId: text(record.resultId, 260),
      taskId: text(record.taskId, 180),
      jobId: text(record.jobId, 260),
      logicalJobId: text(record.logicalJobId, 260),
      generation: safeInteger(record.generation, 0, Number.MAX_SAFE_INTEGER, 0),
      attempt: safeInteger(record.attempt, 0, Number.MAX_SAFE_INTEGER, 0),
      inputFingerprint: text(record.inputFingerprint, 260),
      screenIndex: safeInteger(record.screenIndex, 0, Number.MAX_SAFE_INTEGER, 0),
      imageIndex: safeInteger(record.imageIndex, 1, Number.MAX_SAFE_INTEGER, 1),
      detailMode: text(record.detailMode, 80),
      surfaceMode: text(record.surfaceMode, 40),
      created: meta.created === true,
      provisional: provisional,
      committed: !provisional,
      writeToken: meta.created === true || meta.includeWriteToken === true ? text(record.archiveWriteToken, 260) : '',
      writeRevision: safeInteger(record.archiveWriteRevision, 0, Number.MAX_SAFE_INTEGER, 0),
      provisionalAt: safeInteger(record.provisionalAt, 0, Number.MAX_SAFE_INTEGER, 0),
      provisionalExpiresAt: safeInteger(record.provisionalExpiresAt, 0, Number.MAX_SAFE_INTEGER, 0),
      size: safeInteger(record.size, 0, MAX_IMAGE_BYTES, 0),
      mimeType: text(record.mimeType, 80)
    };
    var skuOutputIdentity = sanitizeSkuOutputIdentity(record);
    if (skuOutputIdentity) {
      output.ratio = text(record.ratio, 20);
      output.resolution = text(record.resolution, 20);
      Object.assign(output, skuOutputIdentity);
    }
    output.identityComplete = referenceProvisionalIdentityComplete(output);
    return output;
  }

  function checkedProvisionalReceipt(raw) {
    raw = raw || {};
    var receipt = {
      accountKey: text(raw.accountKey, 140),
      technicalSourceBatchId: text(raw.technicalSourceBatchId, 260),
      blueprintId: text(raw.blueprintId, 260),
      archiveBatchId: text(raw.archiveBatchId, 260),
      archiveAssetId: text(raw.archiveAssetId, 260),
      resultId: text(raw.resultId, 260),
      taskId: text(raw.taskId, 180),
      jobId: text(raw.jobId, 260),
      logicalJobId: text(raw.logicalJobId, 260),
      generation: safeInteger(raw.generation, 0, Number.MAX_SAFE_INTEGER, 0),
      attempt: safeInteger(raw.attempt, 0, Number.MAX_SAFE_INTEGER, 0),
      inputFingerprint: text(raw.inputFingerprint, 260),
      screenIndex: safeInteger(raw.screenIndex, 0, Number.MAX_SAFE_INTEGER, 0),
      imageIndex: safeInteger(raw.imageIndex, 1, Number.MAX_SAFE_INTEGER, 1),
      detailMode: text(raw.detailMode, 80),
      surfaceMode: text(raw.surfaceMode, 40),
      ratio: text(raw.ratio, 20),
      resolution: text(raw.resolution, 20),
      created: raw.created === true,
      writeToken: text(raw.writeToken, 260),
      writeRevision: safeInteger(raw.writeRevision, 0, Number.MAX_SAFE_INTEGER, 0),
      provisionalAt: safeInteger(raw.provisionalAt, 0, Number.MAX_SAFE_INTEGER, 0),
      provisionalExpiresAt: safeInteger(raw.provisionalExpiresAt, 0, Number.MAX_SAFE_INTEGER, 0)
    };
    var skuOutputIdentity = inspectSkuOutputIdentity(raw);
    if (skuOutputIdentity.state === 'invalid') return null;
    if (skuOutputIdentity.state === 'valid') Object.assign(receipt, skuOutputIdentity.value);
    if (!receipt.accountKey || !receipt.archiveBatchId || !receipt.archiveAssetId || !receipt.resultId) return null;
    return receipt;
  }

  function referenceProvisionalIdentityComplete(value) {
    value = value || {};
    return !!(text(value.accountKey, 140) && text(value.technicalSourceBatchId, 260) &&
      text(value.blueprintId, 260) && text(value.archiveBatchId, 260) && text(value.archiveAssetId, 260) &&
      text(value.resultId, 260) && text(value.taskId, 180) && text(value.jobId, 260) &&
      text(value.logicalJobId, 260) && safeInteger(value.generation, 1, Number.MAX_SAFE_INTEGER, 0) >= 1 &&
      safeInteger(value.attempt, 1, Number.MAX_SAFE_INTEGER, 0) >= 1 && text(value.inputFingerprint, 260) &&
      safeInteger(value.screenIndex, 0, 15, -1) >= 0 &&
      safeInteger(value.imageIndex, 1, 16, -1) === Number(value.screenIndex) + 1 &&
      text(value.detailMode, 80) === 'reference' && text(value.surfaceMode, 40) === 'detail');
  }

  function referenceProvisionalIdentityMatches(left, right) {
    left = left || {};
    right = right || {};
    return text(left.accountKey, 140) === text(right.accountKey, 140) &&
      text(left.technicalSourceBatchId, 260) === text(right.technicalSourceBatchId, 260) &&
      text(left.blueprintId, 260) === text(right.blueprintId, 260) &&
      text(left.archiveBatchId, 260) === text(right.archiveBatchId, 260) &&
      text(left.archiveAssetId, 260) === text(right.archiveAssetId, 260) &&
      text(left.resultId, 260) === text(right.resultId, 260) &&
      text(left.taskId, 180) === text(right.taskId, 180) &&
      text(left.jobId, 260) === text(right.jobId, 260) &&
      text(left.logicalJobId, 260) === text(right.logicalJobId, 260) &&
      safeInteger(left.generation, 0, Number.MAX_SAFE_INTEGER, -1) === safeInteger(right.generation, 0, Number.MAX_SAFE_INTEGER, -2) &&
      safeInteger(left.attempt, 0, Number.MAX_SAFE_INTEGER, -1) === safeInteger(right.attempt, 0, Number.MAX_SAFE_INTEGER, -2) &&
      text(left.inputFingerprint, 260) === text(right.inputFingerprint, 260) &&
      safeInteger(left.screenIndex, 0, Number.MAX_SAFE_INTEGER, -1) === safeInteger(right.screenIndex, 0, Number.MAX_SAFE_INTEGER, -2) &&
      safeInteger(left.imageIndex, 1, Number.MAX_SAFE_INTEGER, -1) === safeInteger(right.imageIndex, 1, Number.MAX_SAFE_INTEGER, -2) &&
      text(left.detailMode, 80) === text(right.detailMode, 80) &&
      text(left.surfaceMode, 40) === text(right.surfaceMode, 40);
  }

  function archiveTombstoned(message) {
    return Object.assign(new Error(message || '该结果引用已被权威终态撤销，拒绝迟到写入。'), {
      code: 'ARCHIVE_RESULT_TOMBSTONED'
    });
  }

  function rejectForTombstone(tombstone, identity) {
    if (!tombstone) return null;
    return referenceProvisionalIdentityMatches(tombstone, identity)
      ? archiveTombstoned()
      : archiveCollision('本机档案 assetId 已被其他账号或结果身份墓碑占用，拒绝覆盖。');
  }

  var TOMBSTONE_REASONS = Object.freeze({
    superseded_request: true,
    terminal_failed: true,
    terminal_cancelled: true,
    terminal_stale: true,
    registration_cleared: true
  });
  var PRESERVE_REASONS = Object.freeze({
    authority_uncertain: true,
    runtime_missing: true,
    runtime_corrupt: true,
    account_mismatch: true,
    registration_active: true,
    not_terminal: true
  });

  function checkedReferenceAuthority(raw) {
    raw = exactDataValues(raw, [
      'schema', 'decision', 'accountKey', 'technicalSourceBatchId', 'blueprintId', 'archiveBatchId',
      'archiveAssetId', 'resultId', 'taskId', 'jobId', 'logicalJobId', 'generation', 'attempt',
      'inputFingerprint', 'screenIndex', 'imageIndex', 'detailMode', 'surfaceMode', 'resultKind',
      'resultRef', 'terminalReason', 'registrationMissing', 'authorityRevision', 'savedAt'
    ]);
    if (!raw) return null;
    var decision = text(raw.decision, 20);
    var authority = {
      schema: text(raw.schema, 80),
      decision: decision,
      accountKey: text(raw.accountKey, 140),
      technicalSourceBatchId: text(raw.technicalSourceBatchId, 260),
      blueprintId: text(raw.blueprintId, 260),
      archiveBatchId: text(raw.archiveBatchId, 260),
      archiveAssetId: text(raw.archiveAssetId, 260),
      resultId: text(raw.resultId, 260),
      taskId: text(raw.taskId, 180),
      jobId: text(raw.jobId, 260),
      logicalJobId: text(raw.logicalJobId, 260),
      generation: safeInteger(raw.generation, 1, Number.MAX_SAFE_INTEGER, 0),
      attempt: safeInteger(raw.attempt, 1, Number.MAX_SAFE_INTEGER, 0),
      inputFingerprint: text(raw.inputFingerprint, 260),
      screenIndex: safeInteger(raw.screenIndex, 0, 15, -1),
      imageIndex: safeInteger(raw.imageIndex, 1, 16, -1),
      detailMode: text(raw.detailMode, 80),
      surfaceMode: text(raw.surfaceMode, 40),
      resultKind: text(raw.resultKind, 20),
      resultRef: raw.resultRef == null ? null : raw.resultRef,
      terminalReason: text(raw.terminalReason, 80),
      registrationMissing: raw.registrationMissing === true,
      authorityRevision: safeInteger(raw.authorityRevision, 1, Number.MAX_SAFE_INTEGER, 0),
      savedAt: safeInteger(raw.savedAt, 1, Number.MAX_SAFE_INTEGER, 0)
    };
    if (authority.schema !== 'REFERENCE_DETAIL_ARCHIVE_AUTHORITY_V1' ||
        ['commit', 'tombstone', 'preserve'].indexOf(decision) < 0 ||
        !referenceProvisionalIdentityComplete(authority) || authority.authorityRevision < 1 || authority.savedAt < 1 ||
        authority.resultKind !== 'image') return null;
    if (decision === 'commit') {
      var ref = exactDataValues(authority.resultRef, ['kind', 'ref', 'resultId']);
      if (!ref ||
          ref.kind !== 'image' || text(ref.resultId, 260) !== authority.resultId || text(ref.ref, 260) !== authority.archiveAssetId ||
          authority.terminalReason) return null;
      authority.resultRef = ref;
    } else if (authority.resultRef != null) {
      return null;
    }
    if (decision === 'tombstone' && (!TOMBSTONE_REASONS[authority.terminalReason] ||
        (authority.terminalReason === 'registration_cleared' && !authority.registrationMissing))) return null;
    if (decision === 'preserve' && !PRESERVE_REASONS[authority.terminalReason]) return null;
    return authority;
  }

  function tombstoneRecord(authority) {
    return {
      schema: 'IMAGE_ARCHIVE_REFERENCE_TOMBSTONE_V1',
      schemaVersion: 1,
      accountKey: authority.accountKey,
      technicalSourceBatchId: authority.technicalSourceBatchId,
      blueprintId: authority.blueprintId,
      archiveBatchId: authority.archiveBatchId,
      archiveAssetId: authority.archiveAssetId,
      resultId: authority.resultId,
      taskId: authority.taskId,
      jobId: authority.jobId,
      logicalJobId: authority.logicalJobId,
      generation: authority.generation,
      attempt: authority.attempt,
      inputFingerprint: authority.inputFingerprint,
      screenIndex: authority.screenIndex,
      imageIndex: authority.imageIndex,
      detailMode: authority.detailMode,
      surfaceMode: authority.surfaceMode,
      resultKind: authority.resultKind,
      terminalReason: authority.terminalReason,
      registrationMissing: authority.registrationMissing,
      authorityRevision: authority.authorityRevision,
      savedAt: authority.savedAt
    };
  }

  function checkedScanCursor(raw, accountKey) {
    if (raw == null) return null;
    raw = exactDataValues(raw, ['schema', 'scope', 'accountKey', 'itemAccountKey', 'provisionalExpiresAt', 'archiveAssetId']);
    if (!raw || raw.schema !== 'IMAGE_ARCHIVE_PROVISIONAL_SCAN_CURSOR_V1') return false;
    var scope = accountKey ? 'account' : 'all';
    var cursor = {
      schema: 'IMAGE_ARCHIVE_PROVISIONAL_SCAN_CURSOR_V1',
      scope: text(raw.scope, 20),
      accountKey: text(raw.accountKey, 140),
      itemAccountKey: text(raw.itemAccountKey, 140),
      provisionalExpiresAt: safeInteger(raw.provisionalExpiresAt, 1, Number.MAX_SAFE_INTEGER, 0),
      archiveAssetId: text(raw.archiveAssetId, 260)
    };
    if (cursor.scope !== scope || !cursor.provisionalExpiresAt || !cursor.archiveAssetId) return false;
    if (scope === 'account' && (cursor.accountKey !== accountKey || cursor.itemAccountKey)) return false;
    if (scope === 'all' && (cursor.accountKey || !cursor.itemAccountKey)) return false;
    return cursor;
  }

  // 只挑出需要权威对账的候选项；过期时间绝不是删除依据。游标每次最多读取
  // limit + 1 条，返回值不含 Blob。accountKey 可省略，供后台发现注册已丢失的账号。
  function scanExpiredReferenceProvisionals(options) {
    options = options || {};
    // Cross-account discovery is only available to the extension background.
    // A hosted workbench always scans the current signed-in account.
    if (root.SZ_WEB_ACCOUNT && !options.accountKey) {
      return root.SZ_WEB_ACCOUNT.require().then(function (id) {
        return scanExpiredReferenceProvisionals(Object.assign({}, options, { accountKey: webAccountKey(id) }));
      });
    }
    var accountKey = options.accountKey == null || options.accountKey === '' ? '' : normalizeAccountKey(options.accountKey);
    var now = safeInteger(options.now, 1, Number.MAX_SAFE_INTEGER, Date.now());
    var requestedLimit = Number(options.limit);
    var limit = Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 24;
    limit = Math.max(1, Math.min(MAX_PROVISIONAL_SCAN_LIMIT, limit));
    var cursor = checkedScanCursor(options.cursor, accountKey);
    if (cursor === false) return Promise.resolve({
      ok: false,
      schema: 'IMAGE_ARCHIVE_PROVISIONAL_SCAN_V1',
      items: [],
      nextCursor: null,
      hasMore: false,
      reason: 'invalid_cursor'
    });
    if (cursor && cursor.provisionalExpiresAt > now) return Promise.resolve({
      ok: false,
      schema: 'IMAGE_ARCHIVE_PROVISIONAL_SCAN_V1',
      items: [],
      nextCursor: null,
      hasMore: false,
      reason: 'invalid_cursor'
    });
    var KeyRange = root.IDBKeyRange;
    if (!KeyRange || typeof KeyRange.bound !== 'function') {
      return Promise.reject(new Error('当前环境不支持有界档案游标。'));
    }
    var indexName = accountKey ? 'accountReferenceProvisionalScanKey' : 'referenceProvisionalScanKey';
    var lower = accountKey
      ? [accountKey, 'provisional', 'detail', 'reference', cursor ? cursor.provisionalExpiresAt : 0, cursor ? cursor.archiveAssetId : '']
      : ['provisional', 'detail', 'reference', cursor ? cursor.provisionalExpiresAt : 0, cursor ? cursor.itemAccountKey : '', cursor ? cursor.archiveAssetId : ''];
    var upper = accountKey
      ? [accountKey, 'provisional', 'detail', 'reference', now, '\uffff']
      : ['provisional', 'detail', 'reference', now, '\uffff', '\uffff'];
    var range = KeyRange.bound(lower, upper, !!cursor, false);
    var items = [];
    var sawExtra = false;
    return transaction([ASSET_STORE], 'readonly', function (stores, fail) {
      var request = stores[ASSET_STORE].index(indexName).openCursor(range, 'next');
      request.onerror = function () { fail(request.error || new Error('扫描待对账临时档案失败')); };
      request.onsuccess = function () {
        var recordCursor = request.result;
        if (!recordCursor) return;
        if (items.length >= limit) {
          sawExtra = true;
          return;
        }
        items.push(provisionalReceipt(recordCursor.value, { includeWriteToken: true }));
        recordCursor.continue();
      };
      return function () {
        var last = items.length ? items[items.length - 1] : null;
        var nextCursor = sawExtra && last ? {
          schema: 'IMAGE_ARCHIVE_PROVISIONAL_SCAN_CURSOR_V1',
          scope: accountKey ? 'account' : 'all',
          accountKey: accountKey || '',
          itemAccountKey: accountKey ? '' : last.accountKey,
          provisionalExpiresAt: last.provisionalExpiresAt,
          archiveAssetId: last.archiveAssetId
        } : null;
        return {
          ok: true,
          schema: 'IMAGE_ARCHIVE_PROVISIONAL_SCAN_V1',
          accountKey: accountKey || '',
          items: items,
          nextCursor: nextCursor,
          hasMore: !!nextCursor,
          limit: limit,
          scannedThrough: now
        };
      };
    }, accountKey);
  }

  function reconcileReferenceProvisionalAuthority(rawReceipt, rawAuthority) {
    var receipt = checkedProvisionalReceipt(rawReceipt);
    var authority = checkedReferenceAuthority(rawAuthority);
    if (!receipt || !authority || !referenceProvisionalIdentityComplete(receipt) ||
        !referenceProvisionalIdentityMatches(receipt, authority)) {
      return Promise.resolve({ ok: false, action: 'preserved', reason: !receipt || !authority ? 'invalid_authority' : 'identity_mismatch' });
    }
    if (authority.authorityRevision < Math.max(1, receipt.writeRevision) || authority.savedAt < receipt.provisionalAt) {
      return Promise.resolve({ ok: false, action: 'preserved', reason: 'stale_authority' });
    }
    if (authority.decision === 'preserve') {
      return Promise.resolve({ ok: true, action: 'preserved', reason: authority.terminalReason, archiveAssetId: receipt.archiveAssetId });
    }
    var outcome = { ok: false, action: 'preserved', reason: 'missing', archiveAssetId: receipt.archiveAssetId };
    return transaction([ASSET_STORE, BATCH_STORE, TOMBSTONE_STORE], 'readwrite', function (stores, fail) {
      var assetRequest = stores[ASSET_STORE].get(receipt.archiveAssetId);
      var tombstoneRequest = stores[TOMBSTONE_STORE].get(receipt.archiveAssetId);
      var assetReady = false;
      var tombstoneReady = false;
      var asset;
      var existingTombstone;
      var decided = false;
      var failed = false;

      function stop(error) {
        if (failed) return;
        failed = true;
        fail(error);
      }

      function finish() {
        if (failed || decided || !assetReady || !tombstoneReady) return;
        decided = true;
        if (existingTombstone) {
          if (!referenceProvisionalIdentityMatches(existingTombstone, authority)) {
            outcome = { ok: false, action: 'preserved', reason: 'identity_mismatch', archiveAssetId: receipt.archiveAssetId };
            return;
          }
          outcome = authority.decision === 'tombstone'
            ? { ok: true, action: 'tombstoned', tombstoned: true, removed: 0, alreadyTombstoned: true, archiveAssetId: receipt.archiveAssetId }
            : { ok: false, action: 'blocked', reason: 'tombstoned', archiveAssetId: receipt.archiveAssetId };
          return;
        }
        if (asset && !referenceProvisionalIdentityMatches(asset, authority)) {
          outcome = { ok: false, action: 'preserved', reason: 'identity_mismatch', archiveAssetId: receipt.archiveAssetId };
          return;
        }
        if (authority.decision === 'commit') {
          if (!asset) return;
          if (asset.archiveState !== 'provisional') {
            outcome = { ok: true, action: 'committed', committed: true, alreadyCommitted: true, archiveAssetId: receipt.archiveAssetId, resultId: receipt.resultId };
            return;
          }
          asset.archiveState = 'committed';
          asset.archiveWriteToken = '';
          asset.committedAt = authority.savedAt;
          asset.updatedAt = Math.max(Number(asset.updatedAt) || 0, authority.savedAt);
          asset.archiveAuthorityRevision = authority.authorityRevision;
          stores[ASSET_STORE].put(asset);
          outcome = { ok: true, action: 'committed', committed: true, archiveAssetId: receipt.archiveAssetId, resultId: receipt.resultId };
          return;
        }
        if (asset && asset.archiveState !== 'provisional') {
          outcome = { ok: false, action: 'preserved', reason: 'already_committed', archiveAssetId: receipt.archiveAssetId };
          return;
        }
        // 首次撤销必须与真实的 exact provisional 在同一事务内线性化。
        // 不对缺失 asset 预种全局 archiveAssetId 墓碑，否则伪造收据可以
        // 抢先占用其他批次未来才会写入的 assetId。
        if (!asset) {
          outcome = { ok: false, action: 'preserved', reason: 'missing', archiveAssetId: receipt.archiveAssetId };
          return;
        }
        stores[TOMBSTONE_STORE].put(tombstoneRecord(authority));
        var deleteRequest = stores[ASSET_STORE].delete(receipt.archiveAssetId);
        deleteRequest.onerror = function () { stop(deleteRequest.error || new Error('删除已撤销临时档案失败')); };
        deleteRequest.onsuccess = function () {
          outcome = { ok: true, action: 'tombstoned', tombstoned: true, removed: 1, archiveAssetId: receipt.archiveAssetId };
          var countRequest = stores[ASSET_STORE].index('archiveBatchId').count(receipt.archiveBatchId);
          countRequest.onerror = function () { stop(countRequest.error || new Error('复核撤销档案批次失败')); };
          countRequest.onsuccess = function () {
            if (Number(countRequest.result) !== 0) return;
            var batchRequest = stores[BATCH_STORE].get(receipt.archiveBatchId);
            batchRequest.onerror = function () { stop(batchRequest.error || new Error('读取待清理撤销批次失败')); };
            batchRequest.onsuccess = function () {
              var batch = batchRequest.result;
              if (batch && normalizeAccountKey(batch.accountKey) === receipt.accountKey) stores[BATCH_STORE].delete(receipt.archiveBatchId);
            };
          };
        };
      }

      assetRequest.onerror = function () { stop(assetRequest.error || new Error('读取待对账临时档案失败')); };
      tombstoneRequest.onerror = function () { stop(tombstoneRequest.error || new Error('读取档案墓碑失败')); };
      assetRequest.onsuccess = function () { asset = assetRequest.result; assetReady = true; finish(); };
      tombstoneRequest.onsuccess = function () { existingTombstone = tombstoneRequest.result; tombstoneReady = true; finish(); };
      return function () { return outcome; };
    }, receipt.accountKey);
  }

  function saveProvisionalResult(raw, options) {
    options = options || {};
    var safe = sanitizeArchiveInput(raw);
    var writeToken = randomWriteToken();
    return transaction([ASSET_STORE, TOMBSTONE_STORE], 'readonly', function (stores, fail) {
      var checked = {};
      var assetRequest = stores[ASSET_STORE].get(safe.archiveAssetId);
      var tombstoneRequest = stores[TOMBSTONE_STORE].get(safe.archiveAssetId);
      assetRequest.onerror = function () { fail(assetRequest.error || new Error('预检临时档案图片失败')); };
      tombstoneRequest.onerror = function () { fail(tombstoneRequest.error || new Error('预检临时档案墓碑失败')); };
      assetRequest.onsuccess = function () { checked.asset = assetRequest.result; };
      tombstoneRequest.onsuccess = function () { checked.tombstone = tombstoneRequest.result; };
      return function () { return checked; };
    }, safe.accountKey).then(function (checked) {
      var blocked = rejectForTombstone(checked.tombstone, safe);
      if (blocked) throw blocked;
      if (!checked.asset) return null;
      if (!provisionalIdentityMatches(checked.asset, safe)) throw archiveCollision('本机档案 assetId 已被其他账号或结果身份占用，拒绝覆盖。');
      return provisionalReceipt(checked.asset, { created: false });
    }).then(function (preflight) {
      if (preflight) return preflight;
      return sourceToBlob(raw && (raw.blob || raw.url), options.fetch).then(function (blob) {
      return transaction([BATCH_STORE, ASSET_STORE, TOMBSTONE_STORE], 'readwrite', function (stores, fail) {
        var assetRequest = stores[ASSET_STORE].get(safe.archiveAssetId);
        var batchRequest = stores[BATCH_STORE].get(safe.archiveBatchId);
        var tombstoneRequest = stores[TOMBSTONE_STORE].get(safe.archiveAssetId);
        var assetReady = false;
        var batchReady = false;
        var tombstoneReady = false;
        var existingAsset;
        var existingBatch;
        var existingTombstone;
        var outcome;
        var stopped = false;

        function stop(error) {
          if (stopped) return;
          stopped = true;
          fail(error);
        }

        function finish() {
          if (stopped || !assetReady || !batchReady || !tombstoneReady) return;
          var blocked = rejectForTombstone(existingTombstone, safe);
          if (blocked) {
            stop(blocked);
            return;
          }
          if (existingAsset) {
            if (!provisionalIdentityMatches(existingAsset, safe)) {
              stop(archiveCollision('本机档案 assetId 已被其他账号或结果身份占用，拒绝覆盖。'));
              return;
            }
            outcome = provisionalReceipt(existingAsset, { created: false });
            return;
          }
          if (existingBatch && normalizeAccountKey(existingBatch.accountKey) !== safe.accountKey) {
            stop(archiveCollision('本机档案 batchId 已被其他账号占用，拒绝覆盖。'));
            return;
          }
          var now = Date.now();
          var batch = existingBatch || {};
          stores[BATCH_STORE].put({
            archiveBatchId: safe.archiveBatchId,
            accountKey: safe.accountKey,
            surfaceMode: safe.surfaceMode,
            creativeRoute: safe.creativeRoute,
            detailMode: safe.detailMode,
            sourceBatchId: safe.sourceBatchId,
            technicalSourceBatchId: batch.technicalSourceBatchId || safe.technicalSourceBatchId,
            archiveProjectId: safe.archiveProjectId || batch.archiveProjectId || '',
            batchTitle: safe.businessBatchTitle || batch.businessBatchTitle || batch.batchTitle || safe.batchTitle,
            businessBatchTitle: safe.businessBatchTitle || batch.businessBatchTitle || '',
            businessType: safe.businessType || batch.businessType || '',
            productName: safe.productName || batch.productName || '',
            styleName: safe.styleName || batch.styleName || '',
            strengthName: safe.strengthName || batch.strengthName || '',
            copyModeName: safe.copyModeName || batch.copyModeName || '',
            linkId: batch.linkId || safe.linkId,
            skuId: batch.skuId || safe.skuId,
            provider: batch.provider || safe.provider,
            imageModel: batch.imageModel || safe.imageModel,
            ratio: batch.ratio || safe.ratio,
            resolution: batch.resolution || safe.resolution,
            createdAt: Number(batch.createdAt) || safe.createdAt,
            updatedAt: now
          });
          var record = Object.assign({}, safe, {
            blob: blob,
            mimeType: allowedMime(blob.type),
            size: Number(blob.size) || 0,
            deletedAt: 0,
            purgeAt: 0,
            archiveState: 'provisional',
            archiveWriteToken: writeToken,
            archiveWriteRevision: 1,
            provisionalAt: now,
            provisionalExpiresAt: now + PROVISIONAL_RETENTION_MS,
            updatedAt: now
          });
          stores[ASSET_STORE].put(record);
          outcome = provisionalReceipt(record, { created: true });
        }

        assetRequest.onerror = function () { stop(assetRequest.error || new Error('读取临时档案图片失败')); };
        batchRequest.onerror = function () { stop(batchRequest.error || new Error('读取临时档案批次失败')); };
        tombstoneRequest.onerror = function () { stop(tombstoneRequest.error || new Error('读取临时档案墓碑失败')); };
        assetRequest.onsuccess = function () { existingAsset = assetRequest.result; assetReady = true; finish(); };
        batchRequest.onsuccess = function () { existingBatch = batchRequest.result; batchReady = true; finish(); };
        tombstoneRequest.onsuccess = function () { existingTombstone = tombstoneRequest.result; tombstoneReady = true; finish(); };
        return function () { return outcome; };
      }, safe.accountKey);
      });
    });
  }

  function commitProvisional(rawReceipt, acceptedIdentity) {
    var receipt = checkedProvisionalReceipt(rawReceipt);
    if (!receipt) return Promise.resolve({ ok: false, committed: false, reason: 'invalid_receipt' });
    var outcome = { ok: false, committed: false, reason: 'missing' };
    return transaction([ASSET_STORE, TOMBSTONE_STORE], 'readwrite', function (stores, fail) {
      var assetRequest = stores[ASSET_STORE].get(receipt.archiveAssetId);
      var tombstoneRequest = stores[TOMBSTONE_STORE].get(receipt.archiveAssetId);
      var assetReady = false;
      var tombstoneReady = false;
      var record;
      var tombstone;
      function finish() {
        if (!assetReady || !tombstoneReady) return;
        if (tombstone) {
          outcome = referenceProvisionalIdentityMatches(tombstone, receipt)
            ? { ok: false, committed: false, reason: 'tombstoned', archiveAssetId: receipt.archiveAssetId }
            : { ok: false, committed: false, reason: 'identity_mismatch', archiveAssetId: receipt.archiveAssetId };
          return;
        }
        if (!record) return;
        if (!provisionalIdentityMatches(record, receipt)) {
          outcome = { ok: false, committed: false, reason: 'identity_mismatch' };
          return;
        }
        if (record.archiveState !== 'provisional') {
          outcome = { ok: true, committed: true, alreadyCommitted: true, archiveAssetId: receipt.archiveAssetId };
          return;
        }
        if (!acceptedIdentity && (!receipt.created || !receipt.writeToken || text(record.archiveWriteToken, 260) !== receipt.writeToken)) {
          outcome = { ok: false, committed: false, reason: 'not_owner' };
          return;
        }
        record.archiveState = 'committed';
        record.archiveWriteToken = '';
        record.committedAt = Date.now();
        record.updatedAt = record.committedAt;
        stores[ASSET_STORE].put(record);
        outcome = { ok: true, committed: true, archiveAssetId: receipt.archiveAssetId, resultId: receipt.resultId };
      }
      assetRequest.onerror = function () { fail(assetRequest.error || new Error('读取待提交临时档案失败')); };
      tombstoneRequest.onerror = function () { fail(tombstoneRequest.error || new Error('读取待提交档案墓碑失败')); };
      assetRequest.onsuccess = function () { record = assetRequest.result; assetReady = true; finish(); };
      tombstoneRequest.onsuccess = function () { tombstone = tombstoneRequest.result; tombstoneReady = true; finish(); };
      return function () { return outcome; };
    }, receipt.accountKey);
  }

  function commitProvisionalResult(rawReceipt) {
    return commitProvisional(rawReceipt, false);
  }

  // 仅供已经由权威 runtime 精确接纳的 resultRef 使用。它不授予删除权，
  // 只把同账号、同任务/请求/分屏身份的既有 provisional 提升为 committed。
  function commitAcceptedProvisionalResult(rawReceipt) {
    return commitProvisional(rawReceipt, true);
  }

  function rollbackProvisionalResult(rawReceipt) {
    var receipt = checkedProvisionalReceipt(rawReceipt);
    if (!receipt || !receipt.created || !receipt.writeToken) {
      return Promise.resolve({ ok: true, removed: 0, reason: receipt ? 'not_owner' : 'invalid_receipt' });
    }
    var outcome = { ok: true, removed: 0, reason: 'missing' };
    return transaction([ASSET_STORE, BATCH_STORE, TOMBSTONE_STORE], 'readwrite', function (stores, fail) {
      var assetRequest = stores[ASSET_STORE].get(receipt.archiveAssetId);
      var tombstoneRequest = stores[TOMBSTONE_STORE].get(receipt.archiveAssetId);
      var assetReady = false;
      var tombstoneReady = false;
      var record;
      var tombstone;
      function finish() {
        if (!assetReady || !tombstoneReady) return;
        if (tombstone) {
          outcome = referenceProvisionalIdentityMatches(tombstone, receipt)
            ? { ok: true, removed: 0, reason: 'tombstoned', archiveAssetId: receipt.archiveAssetId }
            : { ok: true, removed: 0, reason: 'not_owner' };
          return;
        }
        if (!record) return;
        if (!provisionalIdentityMatches(record, receipt) || record.archiveState !== 'provisional' ||
            text(record.archiveWriteToken, 260) !== receipt.writeToken) {
          outcome = { ok: true, removed: 0, reason: 'not_owner' };
          return;
        }
        stores[ASSET_STORE].delete(receipt.archiveAssetId);
        outcome = { ok: true, removed: 1, archiveAssetId: receipt.archiveAssetId };
        var countRequest = stores[ASSET_STORE].index('archiveBatchId').count(receipt.archiveBatchId);
        countRequest.onerror = function () { fail(countRequest.error || new Error('复核临时档案批次失败')); };
        countRequest.onsuccess = function () {
          if (Number(countRequest.result) !== 0) return;
          var batchRequest = stores[BATCH_STORE].get(receipt.archiveBatchId);
          batchRequest.onerror = function () { fail(batchRequest.error || new Error('读取待清理临时档案批次失败')); };
          batchRequest.onsuccess = function () {
            var batch = batchRequest.result;
            if (batch && normalizeAccountKey(batch.accountKey) === receipt.accountKey) stores[BATCH_STORE].delete(receipt.archiveBatchId);
          };
        };
      }
      assetRequest.onerror = function () { fail(assetRequest.error || new Error('读取待回滚临时档案失败')); };
      tombstoneRequest.onerror = function () { fail(tombstoneRequest.error || new Error('读取待回滚档案墓碑失败')); };
      assetRequest.onsuccess = function () { record = assetRequest.result; assetReady = true; finish(); };
      tombstoneRequest.onsuccess = function () { tombstone = tombstoneRequest.result; tombstoneReady = true; finish(); };
      return function () { return outcome; };
    }, receipt.accountKey);
  }

  function saveResult(raw, options) {
    options = options || {};
    var safe = sanitizeArchiveInput(raw);
    return transaction([ASSET_STORE, TOMBSTONE_STORE], 'readonly', function (stores, fail) {
      var checked = {};
      var assetRequest = stores[ASSET_STORE].get(safe.archiveAssetId);
      var tombstoneRequest = stores[TOMBSTONE_STORE].get(safe.archiveAssetId);
      assetRequest.onerror = function () { fail(assetRequest.error || new Error('预检档案图片失败')); };
      tombstoneRequest.onerror = function () { fail(tombstoneRequest.error || new Error('预检档案墓碑失败')); };
      assetRequest.onsuccess = function () { checked.asset = assetRequest.result; };
      tombstoneRequest.onsuccess = function () { checked.tombstone = tombstoneRequest.result; };
      return function () { return checked; };
    }, safe.accountKey).then(function (checked) {
      var blocked = rejectForTombstone(checked.tombstone, safe);
      if (blocked) throw blocked;
      if (checked.asset) {
        if (!provisionalIdentityMatches(checked.asset, safe)) {
          throw archiveCollision('本机档案 assetId 已被其他账号或结果身份占用，拒绝覆盖。');
        }
        return { existingPreflight: true };
      }
      if (options.prefetchedExisting === true) throw Object.assign(new Error('原件留档状态已变化，请重新核对。'),{code:'ARCHIVE_ASSET_MISSING'});
      return sourceToBlob(raw && (raw.blob || raw.url), options.fetch);
    }).then(function (blobOrExisting) {
      var expectedExisting = !!(blobOrExisting && blobOrExisting.existingPreflight);
      var blob = expectedExisting ? null : blobOrExisting;
      var outcome;
      return transaction([BATCH_STORE, ASSET_STORE, TOMBSTONE_STORE], 'readwrite', function (stores, fail) {
        var batchRequest = stores[BATCH_STORE].get(safe.archiveBatchId);
        var assetRequest = stores[ASSET_STORE].get(safe.archiveAssetId);
        var tombstoneRequest = stores[TOMBSTONE_STORE].get(safe.archiveAssetId);
        var batchReady = false;
        var assetReady = false;
        var tombstoneReady = false;
        var existingBatch;
        var existingAsset;
        var existingTombstone;
        var stopped = false;

        function stop(error) {
          if (stopped) return;
          stopped = true;
          fail(error);
        }

        function finish() {
          if (stopped || !batchReady || !assetReady || !tombstoneReady) return;
          if (typeof options.beforeCommit === 'function') {
            try { if (options.beforeCommit() !== true) { stop(Object.assign(new Error('原件所属任务或账号已变化。'),{code:'ARCHIVE_CONTEXT_CHANGED'}));return; } } catch (error) { stop(error);return; }
          }
          var blocked = rejectForTombstone(existingTombstone, safe);
          if (blocked) { stop(blocked); return; }
          if (existingAsset) {
            if (!provisionalIdentityMatches(existingAsset, safe)) {
              stop(archiveCollision('本机档案 assetId 已被其他账号或结果身份占用，拒绝覆盖。'));
              return;
            }
            outcome = Object.assign({}, safe, {
              size: Math.max(0, Number(existingAsset.size) || 0),
              mimeType: text(existingAsset.mimeType, 80),
              archiveState: existingAsset.archiveState || 'committed',
              alreadyExists: true
            });
            return;
          }
          if (expectedExisting) {
            var missing = Object.assign(new Error('幂等档案在二次复核时已不存在。'), { code: 'ARCHIVE_ASSET_MISSING' });
            stop(missing);
            return;
          }
          if (existingBatch && normalizeAccountKey(existingBatch.accountKey) !== safe.accountKey) {
            stop(archiveCollision('本机档案 batchId 已被其他账号占用，拒绝覆盖。'));
            return;
          }
          var existing = existingBatch || {};
          var now = Date.now();
          stores[BATCH_STORE].put({
            archiveBatchId: safe.archiveBatchId,
            accountKey: safe.accountKey,
            surfaceMode: safe.surfaceMode,
            creativeRoute: safe.creativeRoute,
            detailMode: safe.detailMode,
            sourceBatchId: safe.sourceBatchId,
            technicalSourceBatchId: existing.technicalSourceBatchId || safe.technicalSourceBatchId,
            archiveProjectId: safe.archiveProjectId || existing.archiveProjectId || '',
            batchTitle: safe.businessBatchTitle || existing.businessBatchTitle || existing.batchTitle || safe.batchTitle,
            businessBatchTitle: safe.businessBatchTitle || existing.businessBatchTitle || '',
            businessType: safe.businessType || existing.businessType || '',
            productName: safe.productName || existing.productName || '',
            styleName: safe.styleName || existing.styleName || '',
            strengthName: safe.strengthName || existing.strengthName || '',
            copyModeName: safe.copyModeName || existing.copyModeName || '',
            linkId: existing.linkId || safe.linkId,
            skuId: existing.skuId || safe.skuId,
            provider: existing.provider || safe.provider,
            imageModel: existing.imageModel || safe.imageModel,
            ratio: existing.ratio || safe.ratio,
            resolution: existing.resolution || safe.resolution,
            createdAt: Number(existing.createdAt) || safe.createdAt,
            updatedAt: now
          });
          stores[ASSET_STORE].put(Object.assign({}, safe, {
            blob: blob,
            mimeType: allowedMime(blob.type),
            size: Number(blob.size) || 0,
            archiveState: 'committed',
            deletedAt: 0,
            purgeAt: 0,
            updatedAt: now
          }));
          outcome = Object.assign({}, safe, { size: blob.size, mimeType: blob.type, archiveState: 'committed' });
        }

        batchRequest.onerror = function () { fail(batchRequest.error || new Error('读取档案批次失败')); };
        assetRequest.onerror = function () { fail(assetRequest.error || new Error('读取档案图片失败')); };
        tombstoneRequest.onerror = function () { fail(tombstoneRequest.error || new Error('读取档案墓碑失败')); };
        batchRequest.onsuccess = function () { existingBatch = batchRequest.result; batchReady = true; finish(); };
        assetRequest.onsuccess = function () { existingAsset = assetRequest.result; assetReady = true; finish(); };
        tombstoneRequest.onsuccess = function () { existingTombstone = tombstoneRequest.result; tombstoneReady = true; finish(); };
        return function () { return outcome; };
      }, safe.accountKey);
    });
  }

  function recordsForAccount(accountKey) {
    var output = { batches: [], assets: [] };
    return transaction([BATCH_STORE, ASSET_STORE], 'readonly', function (stores, fail) {
      var batchRequest = stores[BATCH_STORE].index('accountKey').getAll(accountKey);
      var assetRequest = stores[ASSET_STORE].index('accountKey').getAll(accountKey);
      batchRequest.onsuccess = function () { output.batches = batchRequest.result || []; };
      assetRequest.onsuccess = function () { output.assets = assetRequest.result || []; };
      batchRequest.onerror = function () { fail(batchRequest.error || new Error('读取档案批次失败')); };
      assetRequest.onerror = function () { fail(assetRequest.error || new Error('读取档案图片失败')); };
      return function () { return output; };
    }, accountKey);
  }

  function permanentlyRemove(accountKey, assetIds) {
    accountKey = normalizeAccountKey(accountKey);
    var selected = {};
    (assetIds || []).forEach(function (id) { if (id) selected[String(id)] = true; });
    if (!Object.keys(selected).length) return Promise.resolve({ removed: 0 });
    var removed = 0;
    return transaction([ASSET_STORE], 'readwrite', function (stores, fail) {
      Object.keys(selected).forEach(function (id) {
        var request = stores[ASSET_STORE].get(id);
        request.onerror = function () { fail(request.error || new Error('读取待删除档案失败')); };
        request.onsuccess = function () {
          var record = request.result;
          if (!record || normalizeAccountKey(record.accountKey) !== accountKey) return;
          stores[ASSET_STORE].delete(id);
          removed++;
        };
      });
      return function () { return { removed: removed }; };
    }, accountKey).then(function (result) {
      return removeEmptyBatches(accountKey).then(function () { return result; });
    });
  }

  function removeEmptyBatches(accountKey) {
    accountKey = normalizeAccountKey(accountKey);
    var removed = 0;
    // Count and delete in one transaction so another tab cannot add an asset
    // between the emptiness check and the deletion of its batch metadata.
    return transaction([BATCH_STORE, ASSET_STORE], 'readwrite', function (stores, fail) {
      var request = stores[BATCH_STORE].index('accountKey').getAll(accountKey);
      request.onerror = function () { fail(request.error || new Error('读取待清理档案批次失败')); };
      request.onsuccess = function () {
        (request.result || []).forEach(function (batch) {
          var count = stores[ASSET_STORE].index('archiveBatchId').count(batch.archiveBatchId);
          count.onerror = function () { fail(count.error || new Error('复核待清理档案批次失败')); };
          count.onsuccess = function () {
            if (Number(count.result) !== 0) return;
            stores[BATCH_STORE].delete(batch.archiveBatchId);
            removed++;
          };
        });
      };
      return function () { return { removed: removed }; };
    }, accountKey);
  }

  function mutateTrash(accountKey, assetIds, deleted) {
    accountKey = normalizeAccountKey(accountKey);
    var selected = {};
    (assetIds || []).forEach(function (id) { if (id) selected[String(id)] = true; });
    var changed = 0;
    var now = Date.now();
    return transaction([ASSET_STORE], 'readwrite', function (stores, fail) {
      Object.keys(selected).forEach(function (id) {
        var request = stores[ASSET_STORE].get(id);
        request.onerror = function () { fail(request.error || new Error('读取回收站档案失败')); };
        request.onsuccess = function () {
          var record = request.result;
          if (!record || normalizeAccountKey(record.accountKey) !== accountKey) return;
          record.deletedAt = deleted ? now : 0;
          record.purgeAt = deleted ? (now + RETENTION_MS) : 0;
          record.updatedAt = now;
          stores[ASSET_STORE].put(record);
          changed++;
        };
      });
      return function () { return { changed: changed, deleted: !!deleted, purgeAt: deleted ? now + RETENTION_MS : 0 }; };
    }, accountKey);
  }

  function moveToTrash(accountKey, assetIds) { return mutateTrash(accountKey, assetIds, true); }
  function restore(accountKey, assetIds) { return mutateTrash(accountKey, assetIds, false); }

  function purgeExpired(accountKey, now) {
    accountKey = normalizeAccountKey(accountKey);
    now = Number(now) || Date.now();
    return recordsForAccount(accountKey).then(function (records) {
      var expired = records.assets.filter(function (asset) {
        return Number(asset.deletedAt) > 0 && Number(asset.purgeAt) > 0 && Number(asset.purgeAt) <= now;
      }).map(function (asset) { return asset.archiveAssetId; });
      return permanentlyRemove(accountKey, expired).then(function () { return { removed: expired.length }; });
    });
  }

  function purgeAllExpired(now) {
    if (root.SZ_WEB_ACCOUNT) return root.SZ_WEB_ACCOUNT.require().then(function (id) {
      return purgeExpired(webAccountKey(id), now);
    });
    now = Number(now) || Date.now();
    var accountKeys = {};
    var removed = 0;
    return transaction([ASSET_STORE], 'readwrite', function (stores, fail) {
      var request = stores[ASSET_STORE].getAll();
      request.onerror = function () { fail(request.error || new Error('读取超期档案失败')); };
      request.onsuccess = function () {
        (request.result || []).forEach(function (asset) {
          if (!(Number(asset.deletedAt) > 0 && Number(asset.purgeAt) > 0 && Number(asset.purgeAt) <= now)) return;
          stores[ASSET_STORE].delete(asset.archiveAssetId);
          accountKeys[normalizeAccountKey(asset.accountKey)] = true;
          removed++;
        });
      };
      return function () { return { removed: removed, accountKeys: Object.keys(accountKeys) }; };
    }).then(function (result) {
      return Promise.all(result.accountKeys.map(removeEmptyBatches)).then(function () { return { removed: result.removed }; });
    });
  }

  function styleMetaFromLegacyPrompt(asset) {
    if (!asset || asset.creativeRoute !== 'style-refresh') return {};
    var prompt = String(asset.prompt || '');
    var styleMatch = /所选风格[:：]\s*([^\/\n。]+)/.exec(prompt);
    var strengthMatch = /创意强度[:：]\s*([^，,\n。]+)/.exec(prompt);
    var planMatch = /Use this image-specific refresh plan exactly:\s*\n([\s\S]*?)\nSTYLE REFRESH CONTRACT/.exec(prompt);
    var lines = planMatch ? planMatch[1].split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean) : [];
    var task = lines[3] || '';
    var colon = task.search(/[:：]/);
    var productName = colon > 0 && colon <= 40 ? text(task.slice(0, colon), 180) : '';
    var direction = text(lines[0], 180);
    var styleName = text(styleMatch && styleMatch[1], 100) || (lines[1] && text(lines[1].split(/[:：]/)[0], 100));
    var strengthName = text(strengthMatch && strengthMatch[1], 80) || text(lines[2], 80);
    var copyModeName = /用户选择不要文案/.test(prompt) ? '不要文案' : (/用户选择修改已有文案/.test(prompt) ? '修改已有文案' : (/用户选择生成新文案/.test(prompt) ? '生成新文案' : ''));
    return {
      productName: productName,
      styleName: styleName,
      strengthName: strengthName,
      copyModeName: copyModeName,
      businessSummary: [direction, task].filter(Boolean).join(' · ')
    };
  }

  function projectArchiveRecords(records, options) {
    records = records || {};
    options = options || {};
    var missing = [];
    var batchById = {};
    var resultById = {};
    var validAssets = [];
    (records.batches || []).forEach(function (batch) {
      if (batch && batch.archiveBatchId) batchById[batch.archiveBatchId] = batch;
    });
    (records.assets || []).forEach(function (asset) {
      if (asset && asset.archiveState === 'provisional' && !options.includeProvisional) return;
      if (!validBlob(asset && asset.blob)) {
        if (asset && asset.archiveAssetId) missing.push(asset.archiveAssetId);
        return;
      }
      validAssets.push(asset);
      if (asset.resultId) resultById[asset.resultId] = asset;
    });

    function rootAsset(asset) {
      var current = asset;
      var seen = {};
      while (current && current.parentResultId && resultById[current.parentResultId] && !seen[current.parentResultId]) {
        seen[current.parentResultId] = true;
        current = resultById[current.parentResultId];
      }
      return current || asset;
    }

    var roleVersions = {};
    validAssets.slice().sort(function (a, b) {
      return Number(a.createdAt) - Number(b.createdAt) || String(a.archiveAssetId || '').localeCompare(String(b.archiveAssetId || ''));
    }).forEach(function (asset) {
      var root = rootAsset(asset);
      var legacy = styleMetaFromLegacyPrompt(root);
      var legacyProjectId = legacy.productName && legacy.styleName
        ? ('legacy_style_project_' + hashText([legacy.productName, legacy.styleName, legacy.strengthName, legacy.copyModeName].join('|')))
        : '';
      var numberedProjectSeed = numberedLinkSurface(root)
        ? (root.technicalSourceBatchId || root.promptBatchId || root.sourceBatchId || root.archiveProjectId || root.archiveBatchId)
        : '';
      // 旧版可能把同一次 L001-L030 批量生产显示成“主图 · L001”。读取时使用
      // 原始生成批次重新投影，不改写 Blob，也不把不同生成批次混在一起。
      var explicitNumberedProjectId = /^numbered_link_project_/.test(String(asset.archiveProjectId || ''))
        ? asset.archiveProjectId
        : (/^numbered_link_project_/.test(String(root.archiveProjectId || '')) ? root.archiveProjectId : '');
      var numberedProjectId = explicitNumberedProjectId || (numberedProjectSeed
        ? ('numbered_link_project_' + hashText([root.accountKey || '', root.surfaceMode || '', numberedProjectSeed].join('|')))
        : '');
      var projectId = numberedProjectId || asset.archiveProjectId || root.archiveProjectId || legacyProjectId || root.archiveBatchId || asset.archiveBatchId;
      var roleName = text(asset.businessRoleName || asset.variantName || asset.skuCode || '生成图', 180).replace(/\s*引导重生.*$/, '') || '生成图';
      var roleKey = asset.businessRoleKey || ((Number(asset.imageIndex) || 1) + '|' + roleName);
      var linkId = canonicalArchiveLinkId(root.linkId || asset.linkId);
      if (numberedProjectId && linkId) roleKey = linkId + '|' + (Number(asset.imageIndex) || 1) + '|' + roleName;
      var versionKey = projectId + '|' + roleKey;
      roleVersions[versionKey] = (roleVersions[versionKey] || 0) + 1;
      asset._archiveProjection = {
        projectId: projectId,
        rootBatchId: root.archiveBatchId || asset.archiveBatchId,
        roleName: roleName,
        roleKey: roleKey,
        versionIndex: roleVersions[versionKey]
      };
    });

    var groups = {};
    validAssets.forEach(function (sourceAsset) {
      var trashed = Number(sourceAsset.deletedAt) > 0;
      if (!!options.trash !== trashed) return;
      var projection = sourceAsset._archiveProjection || {};
      var groupKey = '$' + (projection.projectId || sourceAsset.archiveBatchId);
      if (!groups[groupKey]) {
        var sourceBatch = batchById[projection.rootBatchId] || batchById[sourceAsset.archiveBatchId] || {};
        groups[groupKey] = Object.assign({}, sourceBatch, {
          archiveBatchId: sourceBatch.archiveBatchId || projection.rootBatchId || sourceAsset.archiveBatchId,
          archiveProjectId: projection.projectId || sourceAsset.archiveProjectId || '',
          assets: []
        });
      }
      var asset = Object.assign({}, sourceAsset, {
        archiveProjectId: projection.projectId || sourceAsset.archiveProjectId || '',
        businessRoleKey: projection.roleKey || sourceAsset.businessRoleKey || '',
        businessRoleName: sourceAsset.businessRoleName || projection.roleName || sourceAsset.variantName || '',
        versionIndex: projection.versionIndex || 1,
        generationKind: sourceAsset.generationKind || (sourceAsset.parentResultId ? 'guide' : 'original')
      });
      var displayLinkId = canonicalArchiveLinkId(asset.linkId);
      asset.businessDisplayName = (displayLinkId ? (displayLinkId + (asset.businessRoleName && asset.businessRoleName !== displayLinkId ? ' · ' + asset.businessRoleName : '')) : asset.businessRoleName) + ' · V' + asset.versionIndex;
      groups[groupKey].assets.push(asset);
    });
    validAssets.forEach(function (asset) { try { delete asset._archiveProjection; } catch (_) {} });

    var batches = Object.keys(groups).map(function (key) {
      var batch = groups[key];
      batch.assets.sort(function (a, b) {
        var aLink = canonicalArchiveLinkId(a.linkId);
        var bLink = canonicalArchiveLinkId(b.linkId);
        return Number(aLink && aLink.slice(1)) - Number(bLink && bLink.slice(1)) ||
          Number(a.imageIndex) - Number(b.imageIndex) || Number(a.versionIndex) - Number(b.versionIndex) || Number(a.createdAt) - Number(b.createdAt);
      });
      var businessAsset = batch.assets.find(function (asset) { return asset.businessBatchTitle || asset.productName || asset.styleName; }) || batch.assets[0] || {};
      var inferred = styleMetaFromLegacyPrompt(businessAsset);
      batch.businessType = batch.businessType || businessAsset.businessType || '';
      batch.productName = batch.productName || businessAsset.productName || inferred.productName || '';
      batch.styleName = batch.styleName || businessAsset.styleName || inferred.styleName || '';
      batch.strengthName = batch.strengthName || businessAsset.strengthName || inferred.strengthName || '';
      batch.copyModeName = batch.copyModeName || businessAsset.copyModeName || inferred.copyModeName || '';
      batch.businessBatchTitle = batch.businessBatchTitle || businessAsset.businessBatchTitle || '';
      var numberedIds = archiveLinkIds(batch.assets.filter(numberedLinkSurface).map(function (asset) { return asset.linkId; }));
      if (numberedIds.length && (batch.surfaceMode === 'main' || batch.surfaceMode === 'detail')) {
        batch.linkIds = numberedIds;
        batch.linkRange = archiveLinkRangeLabel(numberedIds);
        batch.businessBatchTitle = (batch.surfaceMode === 'detail' ? '详情页' : '主图') + ' · ' + batch.linkRange;
      }
      if (!batch.businessBatchTitle && batch.creativeRoute === 'style-refresh') {
        batch.businessBatchTitle = ['风格焕新', batch.productName, batch.styleName].filter(Boolean).join(' · ') || '风格焕新 · 共创方案';
      }
      batch.batchTitle = batch.businessBatchTitle || batch.batchTitle || '本机生图档案';
      batch.assets.forEach(function (asset) {
        var assetInferred = styleMetaFromLegacyPrompt(asset);
        if (!asset.businessSummary && assetInferred.businessSummary && asset.creativeRoute === 'style-refresh') asset.businessSummary = assetInferred.businessSummary;
      });
      var roles = {};
      batch.assets.forEach(function (asset) { roles[asset.businessRoleKey || ((asset.imageIndex || 1) + '|' + asset.businessRoleName)] = true; });
      batch.screenCount = Object.keys(roles).length;
      batch.assetCount = batch.assets.length;
      batch.versionCount = batch.assets.length;
      batch.totalBytes = batch.assets.reduce(function (sum, asset) { return sum + (Number(asset.size) || 0); }, 0);
      batch.updatedAt = Math.max(Number(batch.updatedAt) || 0, batch.assets.reduce(function (latest, asset) { return Math.max(latest, Number(asset.updatedAt) || Number(asset.createdAt) || 0); }, 0));
      return batch;
    });
    batches.sort(function (a, b) { return Number(b.updatedAt) - Number(a.updatedAt); });
    return { batches: batches, missing: missing };
  }

  // Existing archives predate the studio receipt DTO. Bind their stored asset,
  // result, job and provider task fields; the caller validates the studio plan
  // and receipt before this read. Never migrate, purge, fetch or save here.
  function readCommittedResult(accountKey, expected) {
    if (typeof accountKey !== 'string' || normalizeAccountKey(accountKey) !== accountKey || accountKey === 'local' ||
        !expected || typeof expected !== 'object' || Array.isArray(expected) ||
        Object.keys(expected).length !== 4 || ['archiveAssetId','resultId','jobId','providerTaskId'].some(function (key) { return typeof expected[key] !== 'string'; }) ||
        !expected.archiveAssetId || !expected.resultId || !expected.jobId ||
        expected.archiveAssetId.length > 260 || expected.resultId.length > 260 || expected.jobId.length > 260 || expected.providerTaskId.length > 180) {
      return Promise.resolve({ ok: false, reason: 'identity_invalid' });
    }
    var binding = { archiveAssetId: expected.archiveAssetId, resultId: expected.resultId, jobId: expected.jobId, providerTaskId: expected.providerTaskId };
    if (!root.indexedDB || typeof root.indexedDB.databases !== 'function') return Promise.resolve({ ok: false, reason: 'unavailable' });
    return new Promise(function (resolve) {
      var db, tx, finished = false, opened = false;
      var timer = setTimeout(function () { finish({ ok: false, reason: 'read_timeout' }); }, 10000);
      function finish(value) {
        if (finished) return;
        finished = true; clearTimeout(timer);
        try { if (tx) tx.abort(); } catch (_) {}
        try { if (db) db.close(); } catch (_) {}
        resolve(value);
      }
      Promise.resolve().then(function () { return root.indexedDB.databases(); }).then(function (databases) {
        if (finished) return;
        if (!databases.some(function (entry) { return entry.name === DB_NAME; })) { finish({ ok: false, reason: 'missing' }); return; }
        var request = root.indexedDB.open(DB_NAME);
        request.onupgradeneeded = function () { try { request.transaction.abort(); } catch (_) {} };
        request.onerror = function () { finish({ ok: false, reason: 'read_failed' }); };
        request.onsuccess = function () {
          if (finished) { try { request.result.close(); } catch (_) {} return; }
          db = request.result; opened = true;
          var result = { ok: false, reason: 'missing' };
          try {
            if (!db.objectStoreNames.contains(ASSET_STORE)) { finish({ ok: false, reason: 'missing' }); return; }
            tx = db.transaction(ASSET_STORE, 'readonly');
            var assetRequest = tx.objectStore(ASSET_STORE).get(binding.archiveAssetId);
            assetRequest.onsuccess = function () {
              if (finished) return;
              var asset = assetRequest.result;
              if (asset && asset.accountKey === accountKey && asset.archiveAssetId === binding.archiveAssetId &&
                  asset.resultId === binding.resultId && asset.jobId === binding.jobId && (asset.taskId || '') === binding.providerTaskId &&
                  asset.archiveState === 'committed' && !asset.deletedAt && !asset.purgeAt && typeof root.Blob === 'function' && asset.blob instanceof root.Blob && validBlob(asset.blob) &&
                  asset.blob.size === asset.size && asset.blob.size <= MAX_IMAGE_BYTES && allowedMime(asset.blob.type)) {
                result = { ok: true, accountKey: accountKey, archiveAssetId: asset.archiveAssetId, resultId: asset.resultId, jobId: asset.jobId, providerTaskId: binding.providerTaskId, blob: asset.blob };
              }
            };
            tx.oncomplete = function () { tx = null; finish(result); };
            tx.onerror = tx.onabort = function () { tx = null; finish({ ok: false, reason: 'read_failed' }); };
          } catch (_) { finish({ ok: false, reason: 'read_failed' }); }
        };
      }).catch(function () { finish({ ok: false, reason: opened ? 'read_failed' : 'unavailable' }); });
    });
  }

  function list(accountKey, options) {
    accountKey = normalizeAccountKey(accountKey);
    options = options || {};
    var ready = options.skipPurge ? Promise.resolve({ removed: 0 }) : purgeExpired(accountKey, options.now);
    return ready.then(function () {
      return recordsForAccount(accountKey);
    }).then(function (records) {
      var projected = projectArchiveRecords(records, options);
      var cleanup = projected.missing.length ? permanentlyRemove(accountKey, projected.missing) : Promise.resolve({ removed: 0 });
      return cleanup.then(function () { return projected.batches; });
    });
  }

  // Read the account's records once for both views. Keep list()'s full-list
  // contract intact for existing callers and retain the same expiry/missing
  // blob cleanup rules, including the provisional-record exclusion.
  function listSnapshot(accountKey, options) {
    accountKey = normalizeAccountKey(accountKey);
    options = options || {};
    var now = Number(options.now) || Date.now();
    return recordsForAccount(accountKey).then(function (records) {
      var removedIds = Object.create(null);
      var expiredCount = 0;
      var remaining = (records.assets || []).filter(function (asset) {
        if (!options.skipPurge && Number(asset.deletedAt) > 0 && Number(asset.purgeAt) > 0 && Number(asset.purgeAt) <= now) {
          removedIds[asset.archiveAssetId] = true;
          expiredCount++;
          return false;
        }
        return true;
      });
      var active, trash;
      if (options.maintenanceOnly) {
        remaining.forEach(function (asset) {
          if (asset && asset.archiveState === 'provisional' && !options.includeProvisional) return;
          if (!validBlob(asset && asset.blob) && asset && asset.archiveAssetId) removedIds[asset.archiveAssetId] = true;
        });
      } else {
        var snapshot = { batches: records.batches, assets: remaining };
        active = projectArchiveRecords(snapshot, Object.assign({}, options, { trash: false }));
        trash = projectArchiveRecords(snapshot, Object.assign({}, options, { trash: true }));
        active.missing.concat(trash.missing).forEach(function (id) { removedIds[id] = true; });
      }
      var ids = Object.keys(removedIds);
      return permanentlyRemove(accountKey, ids).then(function () {
        return {
          activeBatches: active ? active.batches : [],
          trashBatches: trash ? trash.batches : [],
          maintenance: !!options.maintenanceOnly,
          removed: ids.length,
          expired: expiredCount
        };
      });
    });
  }

  function summary(accountKey) {
    return listSnapshot(accountKey).then(function (snapshot) {
      var active = snapshot.activeBatches, trash = snapshot.trashBatches;
      return {
        activeBatches: active.length,
        activeAssets: active.reduce(function (sum, batch) { return sum + batch.assets.length; }, 0),
        trashAssets: trash.reduce(function (sum, batch) { return sum + batch.assets.length; }, 0),
        bytes: active.concat(trash).reduce(function (sum, batch) { return sum + batch.totalBytes; }, 0)
      };
    });
  }

  return Object.freeze({
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    RETENTION_MS: RETENTION_MS,
    PROVISIONAL_RETENTION_MS: PROVISIONAL_RETENTION_MS,
    MAX_PROVISIONAL_SCAN_LIMIT: MAX_PROVISIONAL_SCAN_LIMIT,
    normalizeAccountKey: normalizeAccountKey,
    sanitizeArchiveInput: sanitizeArchiveInput,
    sanitizeSkuOutputIdentity: sanitizeSkuOutputIdentity,
    projectArchiveRecords: projectArchiveRecords,
    dataUrlToBlob: dataUrlToBlob,
    sourceToBlob: sourceToBlob,
    readCommittedResult: readCommittedResult,
    saveResult: saveResult,
    saveProvisionalResult: saveProvisionalResult,
    commitProvisionalResult: commitProvisionalResult,
    commitAcceptedProvisionalResult: commitAcceptedProvisionalResult,
    rollbackProvisionalResult: rollbackProvisionalResult,
    scanExpiredReferenceProvisionals: scanExpiredReferenceProvisionals,
    reconcileReferenceProvisionalAuthority: reconcileReferenceProvisionalAuthority,
    list: list,
    listSnapshot: listSnapshot,
    summary: summary,
    moveToTrash: moveToTrash,
    restore: restore,
    permanentlyRemove: permanentlyRemove,
    purgeExpired: purgeExpired,
    purgeAllExpired: purgeAllExpired
  });
});

;
/* Frozen source: public/creative/labs/image-prompt-lab/guide-model-profile.js */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SZ_GUIDE_MODEL_PROFILE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 'GUIDE_MODEL_PROFILE_V1';

  function modelFamily(model) {
    var value = String(model || '').trim().toLowerCase();
    if (!value) return 'unspecified';
    // Match the published name or its dated snapshot, never a decimal prefix.
    // Gateway aliases are recognized only for strategy selection; the request
    // retains the exact configured model ID.
    if (/^gpt-image-2\.5-sunburst(?:-\d{4}-\d{2}-\d{2})?$/.test(value) ||
        /^image-?2\.5-sunburst$/.test(value)) return 'gpt-image-2.5-sunburst';
    if (/^gpt-image-2(?:-\d{4}-\d{2}-\d{2})?$/.test(value) || /^image-?2$/.test(value)) return 'gpt-image-2';
    if (/^gpt-image-1\.5(?:-\d{4}-\d{2}-\d{2})?$/.test(value)) return 'gpt-image-1.5';
    if (/^gpt-image-1-mini(?:-\d{4}-\d{2}-\d{2})?$/.test(value)) return 'gpt-image-1-mini';
    if (/^gpt-image-1(?:-\d{4}-\d{2}-\d{2})?$/.test(value)) return 'gpt-image-1';
    if (/^dall-e-2$/.test(value)) return 'dall-e-2';
    if (/^dall-e-3$/.test(value)) return 'text-to-image-only';
    if (/cogview|(?:^|[-_])(?:t2i|text-to-image)(?:$|[-_])/.test(value)) return 'text-to-image-only';
    if (/^(?:gemini-[a-z0-9.]+-(?:flash(?:-lite)?|pro)-image|nano-banana)/.test(value)) return 'gemini-image';
    if (/seedream/.test(value)) return 'seedream';
    if (/^wan[\d.]*-image(?:-edit)?(?:$|-)/.test(value)) return 'wan-image';
    if (/^qwen-image-edit(?:$|-)/.test(value)) return 'qwen-image-edit';
    if (/^(?:qwen-image|glm-image)(?:$|-)/.test(value)) return 'text-to-image-only';
    if (/^(?:gpt-(?:[3456](?:[.\w-]*)?|oss(?:[-\w]*)?)|o[134](?:$|[-.])|chatgpt-|claude-|deepseek-|qwen|glm-|gemini-)/.test(value)) return 'text-only';
    return 'unknown';
  }

  function resolve(cfg) {
    cfg = cfg || {};
    var model = String(cfg.imageModel || '').trim();
    var adapter = String(cfg.imageAdapter || '').trim();
    var family = modelFamily(model);
    var endpointKind = 'adapter-defined';
    if (adapter === 'openai-images') {
      var endpoint = String(cfg.imageEndpoint || '').trim();
      endpointKind = endpoint && !/^https?:\/\//i.test(endpoint) ? 'incompatible' :
        !endpoint || /\/images\/(?:generations|edits)\/?(?:\?.*)?$/i.test(endpoint) ? 'images-api' :
        /\/(?:chat\/completions|responses|videos)(?:\/|\?|$)/i.test(endpoint) ? 'incompatible' : 'custom-images';
    }
    var unsupported = family === 'text-only' || family === 'text-to-image-only';
    unsupported = unsupported || endpointKind === 'incompatible';
    var capability = 'unsupported';
    if (!unsupported) {
      if (adapter === 'openai-images') capability = /^(?:gpt-image-|dall-e-2$)/.test(family) || family === 'unknown' || family === 'unspecified'
        ? 'mask-guided' : 'annotation-reference';
      else if (adapter === 'generic-json') capability = 'client-composited-mask';
      else if (['dashscope-wan', 'doubao-image', 'volcengine-image', 'gemini-image', 'nano-banana'].indexOf(adapter) >= 0) capability = 'annotation-reference';
    }
    var style = family === 'gpt-image-2.5-sunburst' ? 'edit-first' : 'structured-edit';
    var strategy = style === 'edit-first' ? 'sunburst-precise-edit-v1' :
      family === 'gpt-image-2' ? 'image2-structured-edit-v1' : 'compatible-structured-edit-v1';
    var strategyLabel = style === 'edit-first' ? 'Sunburst 精准编辑：修改 / 保留 / 证据' :
      family === 'gpt-image-2' ? 'Image-2 结构化修复' : '兼容模型结构化修复';
    var labels = {
      'mask-guided': '原生遮罩编辑，保留局部修复边界',
      'client-composited-mask': '网关图片编辑，结果按遮罩合成保留原图',
      'annotation-reference': '标注参考编辑，遮罩外像素不保证不变',
      unsupported: '当前模型或适配器不支持引导重生'
    };
    var label = labels[capability];
    if (capability !== 'unsupported') {
      if (family === 'unknown' || family === 'unspecified') label = capability === 'mask-guided'
        ? '按图片编辑接口兼容发送遮罩，模型编辑能力未验证'
        : '兼容路径，模型编辑能力未验证；' + label;
      else if (style === 'edit-first') label = 'Sunburst 编辑优先；' + label;
    }
    return {
      version: VERSION,
      model: model,
      adapter: adapter,
      family: family,
      endpointKind: endpointKind,
      capability: capability,
      promptStyle: style,
      strategy: strategy,
      strategyLabel: strategyLabel,
      label: label,
      inputFidelity: adapter === 'openai-images' && (family === 'gpt-image-1' || family === 'gpt-image-1.5')
    };
  }

  function sameBinding(profile, cfg) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile) || profile.version !== VERSION) return false;
    var expected = resolve(cfg);
    return (!profile.endpointKind || profile.endpointKind === expected.endpointKind) && ['model', 'adapter', 'family', 'capability'].every(function (key) {
      return typeof profile[key] === 'string' && profile[key] === expected[key];
    });
  }

  // A separate edit prompt, deliberately independent of the old generation
  // layers and their internal screen/path/sequence instructions.
  function sunburstPrompt(contract) {
    contract = contract || {};
    var lines = [
      'CURRENT IMAGE EDIT — CHANGE / PRESERVE / EVIDENCE:',
      'Edit input image 1, the current selected result. Return one edited image with the same canvas, framing and aspect ratio.'
    ];
    var change = String(contract.guide || contract.issueLabel || '').trim();
    if (contract.operation === 'delete-visible-text') {
      change = 'Delete only the exact visible text “' + contract.textTarget + '” inside the editable region, including its own outline and shadow. ' +
        (contract.removeTextContainer ? 'Remove its selected backing plate only within that region.' : 'Keep its backing plate and label container; reconstruct only the revealed background naturally.');
    } else if (contract.operation === 'replace-visible-text') {
      change = 'Replace only the exact visible text “' + contract.textTarget + '” with “' + contract.replacementText + '” inside the editable region. Render the new text character-exact, legible, with the original typography and placement; do not retain the old selected text.';
    } else if (contract.exactCopy) {
      change += '\nUse the exact requested visible copy “' + contract.exactCopy + '”; do not paraphrase or translate it.';
    }
    lines.push('CHANGE: ' + change);
    if (contract.mode === 'subject') {
      lines.push(contract.subjectIntent === 'concept'
        ? 'This is the explicitly requested concept redesign, not a verified real-product photograph.'
        : contract.subjectIntent === 'polish'
          ? 'Improve only the selected product presentation; keep its actual structure, SKU color, material, quantity and function.'
          : 'Correct the selected product defect to match the uploaded current-SKU evidence. Preserve every verified feature; invent no invisible parts or new view.');
    }
    var preserve = (Array.isArray(contract.preserve) ? contract.preserve : []).filter(Boolean).join('；');
    lines.push('PRESERVE: Except for the explicit change, keep all other content unchanged' + (preserve ? ', including ' + preserve : '') + '.');
    if (contract.operation === 'delete-visible-text' || contract.operation === 'replace-visible-text') {
      lines.push('Keep every unselected visible character exactly, with its original font, size, color, spacing and position. The current image is the only visual source for this text edit.');
    } else {
      lines.push('EVIDENCE: Product photos after image 1 prove product identity, structure, color, material, logos and packaging only. Explicit person references prove the requested person identity only. Never use these evidence photos as a new canvas or import their backgrounds or unrelated text.');
    }
    var annotation = contract.annotation || {};
    if (annotation.hasEditMask && contract.adapterCapability !== 'annotation-reference') {
      lines.push('REGION: Transparent pixels in the attached PNG mask are editable; opaque pixels are protected. Limit the change to the editable region.');
    } else if (annotation.hasAnnotationImage) {
      lines.push('REGION: The marked reference locates the edit: red means must change and yellow means may harmonize. Keep unmarked content unchanged.');
    }
    if (contract.postCompositeOutsideMask) lines.push('Pixels outside the editable mask are restored from the original image after editing; make the repair meet the original boundary naturally.');
    var forbid = (Array.isArray(contract.forbid) ? contract.forbid : []).filter(Boolean).join('；');
    if (forbid) lines.push('Do not add or retain: ' + forbid + '.');
    lines.push('Apply this edit only to the selected image. Do not redesign the advertisement, enhance the whole image, or render region marks or editing instructions.');
    return lines.join('\n');
  }

  return { VERSION: VERSION, resolve: resolve, sameBinding: sameBinding, sunburstPrompt: sunburstPrompt };
});
