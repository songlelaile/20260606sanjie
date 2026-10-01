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
