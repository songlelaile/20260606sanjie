(function initDmpCompletenessEngine(root, factory) {
  const supplement = root.DmpCompetitionItemSupplement || (typeof module === "object" && module.exports ? require("./competition-item-supplement.js") : null);
  const api = factory(supplement);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DmpCompletenessEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createDmpCompletenessEngine(competitionItemSupplement) {
  "use strict";

  // 浏览器内版本的 v2.0 completeness parser。这里不生成任何可见结论，只建立
  // 对象/周期严格对齐的中间数据和 endpoint 守恒审计，供 report-engine 填 11 张业务表。
  const CHANNELS = [
    ["内容运营消耗占比", "内容运营"],
    ["人群推广消耗占比", "人群推广"],
    ["货品全站推消耗占比", "货品全站推"],
    ["线索推广消耗占比", "线索推广"],
    ["关键词推广消耗占比", "关键词推广"]
  ];

  const SCENE_CODES = {
    "371": "关键词推广",
    "372": "人群推广",
    "376": "货品运营",
    "377": "店铺运营",
    "379": "内容营销",
    "395": "线索推广",
    "435": "货品全站推",
    "436": "货品全站推"
  };

  const STANDARD_PATHS = [
    "/dataplatform/dataset/report/query",
    "/api/goods/grow/define/line/data",
    "/api/goods/grow/comparison/scene"
  ];

  // 达摩盘经常还没产出最后一到两天的数据（尤其当天上午取数时）。这种平台缺口
  // 不是抓取失败，补抓再多轮也不会变，过去却按阻断处理，导致报告永远不放行。
  // 允许最多这么多天的平台侧缺口：报告照常生成，缺口天数在"数据说明"里明示，
  // 缺失当天的数值一律留空，绝不补 0。超出容忍度仍然阻断。
  const PLATFORM_DAY_GAP_TOLERANCE = 2;

  // 报告与归档上传共用同一份主体投放最低合同。数组和每个条目都冻结，
  // 避免不同输出链路各自维护一套字段后再次发生“报告有、上传丢”的漂移。
  const SUBJECT_MINIMUM_PROMOTION_CONTRACT = Object.freeze([
    Object.freeze({ key: "spend", label: "推广消耗" }),
    Object.freeze({ key: "feeRatio", label: "费比" }),
    Object.freeze({ key: "roi", label: "ROI" }),
    Object.freeze({ key: "ppc", label: "PPC" })
  ]);
  const SUBJECT_MINIMUM_PROMOTION_METRICS = SUBJECT_MINIMUM_PROMOTION_CONTRACT;

  // 商品成长报告的双方固定合同。sourceKeys 保留历史字段名，避免旧报告和旧官网
  // 仍使用 roas / paidAmountShare 时被误判为缺失；对外统一暴露 canonical key。
  const CORE_METRIC_CONTRACT = Object.freeze([
    Object.freeze({ key: "totalGmv", label: "总GMV", sourceKeys: Object.freeze(["totalGmv"]) }),
    Object.freeze({ key: "paidGmv", label: "付费成交额", sourceKeys: Object.freeze(["paidGmv"]) }),
    Object.freeze({ key: "spend", label: "推广消耗", sourceKeys: Object.freeze(["spend"]) }),
    Object.freeze({ key: "feeRatio", label: "费比", sourceKeys: Object.freeze(["feeRatio"]) }),
    Object.freeze({ key: "roi", label: "ROI", sourceKeys: Object.freeze(["roi"]) }),
    Object.freeze({ key: "ppc", label: "PPC", sourceKeys: Object.freeze(["ppc"]) }),
    Object.freeze({ key: "paidGmvContribution", label: "付费金额占比", sourceKeys: Object.freeze(["paidGmvContribution", "paidAmountShare"]) }),
    Object.freeze({ key: "globalROAS", label: "全域ROAS", sourceKeys: Object.freeze(["globalROAS", "roas"]) })
  ]);

  const VALUE_STATES = Object.freeze({
    EXACT: "exact",
    INTERVAL: "interval",
    NA: "n/a",
    MISSING: "missing",
    INVALID: "invalid",
    CONFLICT: "conflict"
  });

  // INDEX_CARD 的同一业务指标会因页面版本或接口模板不同而出现不同名称。
  // 统一身份只用于同义去重，不改变接口披露的数值；列表顺序同时定义核心指标优先级。
  const METRIC_ALIAS_GROUPS = [
    { key: "marketingClicks", name: "营销推广点击量", aliases: ["营销推广点击量", "营销推广点击数", "营销推广点击", "广告点击量", "广告点击数", "推广点击量", "推广点击数", "付费点击量", "promotionclick", "promotionclicks", "adclick"] },
    { key: "naturalClicks", name: "自然点击量", aliases: ["自然点击量", "自然流量点击量", "organicclick"] },
    { key: "orders", name: "成交笔数", aliases: ["成交笔数", "支付成交笔数", "支付笔数", "alipaycnt"] },
    { key: "conversion", name: "支付转化率", aliases: ["支付转化率", "成交转化率", "支付成交转化率", "alipayconversion", "conversionrate"] },
    { key: "aov", name: "笔单价", aliases: ["笔单价", "客单价", "平均订单金额", "unitprice", "avgorder"] },
    { key: "cartRate", name: "加购率", aliases: ["加购率", "收藏加购率", "cartrate"] },
    { key: "visitors", name: "访客数", aliases: ["访客数", "访问人数", "访客", "uv"] },
    { key: "totalGmv", name: "总GMV", aliases: ["总gmv", "成交金额", "支付成交金额", "alipayamt", "gmv30d"] },
    { key: "paidGmv", name: "付费成交额", aliases: ["付费成交额", "付费成交金额", "付费GMV", "营销推广成交额", "营销推广成交金额", "营销推广GMV", "推广成交额", "推广成交金额", "推广GMV", "广告归因gmv", "广告成交额", "广告成交金额", "直接成交额", "直接成交金额", "直接支付金额", "directalipayamt", "directalipayamount", "gmv1d", "alipayamt1d"] },
    { key: "paidAmountShare", name: "付费金额占比", aliases: ["付费金额占比", "付费成交额占比", "付费gmv贡献率", "广告gmv贡献率", "广告归因gmv贡献率"] },
    { key: "paidOrders", name: "付费成交笔数", aliases: ["付费成交笔数", "营销推广成交笔数", "广告成交笔数", "广告归因成交笔数", "alipaycnt1d"] },
    { key: "spend", name: "推广消耗", aliases: ["推广消耗", "推广花费", "广告消耗", "广告花费", "广告/推广消耗", "营销推广消耗", "营销推广花费", "总消耗", "总花费", "charge", "adspend", "promotioncost"] },
    { key: "roi", name: "ROI", aliases: ["roi", "直接roi", "roi1d", "directroi", "推广roi", "营销推广roi", "投入产出比", "直接投入产出比", "直接投产比", "投产比"] },
    { key: "ppc", name: "PPC", aliases: ["ppc", "cpc", "clickcost", "costclick", "costperclick", "cost_per", "点击成本", "平均点击成本", "点击单价", "平均点击单价", "营销推广点击单价", "广告点击单价"] },
    { key: "feeRatio", name: "费比", aliases: ["费比", "推广费比", "广告费比"] },
    { key: "roas", name: "全域ROAS", aliases: ["全域roas", "roas"] },
    { key: "keywordShare", name: "关键词消耗占比", aliases: ["关键词消耗占比", "关键词花费占比", "关键词推广消耗占比"] },
    { key: "channelHhi", name: "渠道集中度HHI", aliases: ["渠道集中度hhi", "渠道hhi", "渠道集中度"] }
  ];

  function normalizeMetricName(value) {
    return String(value || "").trim().toLowerCase().replace(/[\s_\-/（）()【】\[\]：:]+/g, "");
  }

  const METRIC_ALIAS_INDEX = new Map(METRIC_ALIAS_GROUPS.flatMap(group => group.aliases
    .map(alias => [normalizeMetricName(alias), group])));

  function metricIdentity(value) {
    const normalized = normalizeMetricName(value);
    return METRIC_ALIAS_INDEX.get(normalized)?.key || `raw:${normalized}`;
  }

  function canonicalPath(value) {
    return String(value || "")
      .split("?")[0]
      .replace(/^\/api_2\//, "/api/")
      .replace(/\.json$/, "")
      .replace(/\/+$/, "");
  }

  function recordPath(record) {
    if (record?.pathname) return canonicalPath(record.pathname);
    try { return canonicalPath(new URL(record?.url || "").pathname); } catch { return canonicalPath(record?.url || ""); }
  }

  function stripFence(text) {
    return String(text || "").replace(/^\s*```(?:json|javascript|js)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  }

  function parseJsonLike(value, depth = 0) {
    if (value == null || depth > 3) return value == null ? null : value;
    if (typeof value === "object") return value;
    if (typeof value !== "string") return null;
    const text = stripFence(value);
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      return typeof parsed === "string" ? parseJsonLike(parsed, depth + 1) : parsed;
    } catch {}
    const jsonp = text.match(/^[\w$.[\]]+\s*\(([\s\S]*)\)\s*;?$/);
    if (!jsonp) return null;
    try { return JSON.parse(jsonp[1]); } catch { return null; }
  }

  function parseBody(record) {
    const candidates = [record?.body, record?.responseBody, record?.response?.body, record?.response?.content?.text];
    let value = candidates.find(candidate => candidate != null);
    if (value == null) return null;
    const encoding = record?.bodyEncoding || record?.response?.content?.encoding;
    if (typeof value === "string" && String(encoding).toLowerCase() === "base64" && typeof atob === "function") {
      try { value = decodeURIComponent(Array.from(atob(value), character => `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`).join("")); }
      catch { return null; }
    }
    return parseJsonLike(value);
  }

  function isGrowthBusinessPath(path) {
    return path === "/api/goods/item/info"
      || path === "/dataplatform/dataset/report/query"
      || path.startsWith("/api/goods/grow/");
  }

  function urlFor(record) {
    try { return new URL(record?.url || "", "https://dmp.taobao.com"); } catch { return null; }
  }

  function getParam(record, aliases) {
    const names = Array.isArray(aliases) ? aliases : [aliases];
    const url = urlFor(record);
    for (const name of names) {
      const value = url?.searchParams?.get(name);
      if (value != null && value !== "") return value;
    }
    const body = parseJsonLike(record?.requestBody || record?.request?.postData?.text || record?.postData);
    for (const name of names) {
      const value = body?.[name] ?? body?.data?.[name] ?? body?.params?.[name];
      if (value != null && value !== "") return String(value);
    }
    return null;
  }

  function datasetRequestType(record) {
    const body = parseJsonLike(record?.requestBody || record?.request?.postData?.text || record?.postData);
    return String(body?.type ?? body?.data?.type ?? body?.params?.type ?? "").trim().toUpperCase();
  }

  // OPTIONS/HEAD 是浏览器和网关的传输层请求，redirect 记录则是 CDP 额外
  // 发出的跳转中间态；它们都不是业务接口响应，也没有可供业务解析的 body。
  // 若把它们计入 endpoint 守恒，跨域 POST 每补抓一次就会永久增加一条
  // missing-response，最终出现业务数据 6/6、关键值 14/14 仍不能下载。
  function transportOnlyReason(record) {
    const method = String(record?.method || record?.request?.method || "").toUpperCase();
    if (method === "OPTIONS") return "cors-preflight";
    if (method === "HEAD") return "head-probe";
    if (record?.redirect === true || record?.format === "redirect") return "redirect-intermediate";
    return "";
  }

  function isTransportOnlyRecord(record) {
    return Boolean(transportOnlyReason(record));
  }

  function datasetFilters(record, key) {
    const request = parseJsonLike(record?.requestBody || record?.request?.postData?.text || record?.postData);
    const filters = parseJsonLike(request?.[key] ?? request?.data?.[key] ?? request?.params?.[key]);
    return Array.isArray(filters) ? filters : [];
  }

  function datasetScope(record) {
    const valuesFor = (filters, predicate) => {
      const filter = filters.find(predicate);
      return Array.isArray(filter?.values) ? filter.values.map(String).filter(Boolean) : [];
    };
    const subject = datasetFilters(record, "filterCondition");
    const competitor = datasetFilters(record, "filterCompareCondition");
    const isItem = filter => /item_id|宝贝ID/i.test(`${filter?.expression || ""}|${filter?.description || ""}|${filter?.name || ""}`);
    const isDate = filter => /thedate|日期|时间/i.test(`${filter?.expression || ""}|${filter?.description || ""}|${filter?.name || ""}`);
    const subjectDates = valuesFor(subject, isDate).map(normalizeDate).filter(Boolean);
    const competitorDates = valuesFor(competitor, isDate).map(normalizeDate).filter(Boolean);
    return {
      subjectItemIds: valuesFor(subject, isItem), competitorItemIds: valuesFor(competitor, isItem),
      subjectStart: subjectDates[0] || null, subjectEnd: subjectDates[1] || subjectDates[0] || null,
      competitorStart: competitorDates[0] || null, competitorEnd: competitorDates[1] || competitorDates[0] || null
    };
  }

  // A failed response may describe the transport/body/API failure in `parser`,
  // while a later valid response describes the business parser (for example
  // `api` versus `index-card`).  Replacement therefore has to infer the
  // expected parser from the immutable request shape, not from the failure
  // phase.  Only period-bound endpoints participate in replacement below;
  // periodless item/success-definition failures remain blocking.
  function expectedGrowthParser(record) {
    const path = recordPath(record);
    if (path === "/api/goods/item/info") return "item-info";
    if (path === "/api/goods/grow/define/success/load") return "selected-success-items";
    if (path === "/api/goods/grow/define/success/item/list") return "success-item-search";
    if (path === "/api/goods/grow/define/success") return "success-write-ack";
    if (path === "/api/goods/grow/line") return "growth-definitions";
    if (path === "/api/goods/grow/define/line/data") return "growth-line";
    if (path === "/api/goods/grow/comparison/scene/keyword") return "growth-keywords";
    if (path === "/api/goods/grow/comparison/scene") return "growth-scenes";
    if (path === "/dataplatform/dataset/report/query") {
      const requestType = datasetRequestType(record);
      if (requestType === "INDEX_CARD") return "index-card";
      if (requestType === "TABLE") return "dataset-table";
    }
    return "";
  }

  function exactReplacementIds(values) {
    const source = Array.isArray(values) ? values : String(values ?? "").split(",");
    const normalized = source.map(value => String(value ?? "").trim()).filter(Boolean);
    if (!normalized.length || normalized.some(value => !/^\d{6,20}$/.test(value))) return null;
    return [...new Set(normalized)].sort();
  }

  function exactReplacementPeriod(startValue, endValue) {
    const startDate = normalizeDate(startValue);
    const endDate = normalizeDate(endValue);
    const dates = enumerateDates(startDate, endDate);
    if (!startDate || !endDate || !dates.length || dates[0] !== startDate || dates.at(-1) !== endDate) return null;
    return { startDate, endDate };
  }

  function growthRecordReplacementScope(record) {
    const method = String(record?.method || record?.request?.method || "").trim().toUpperCase();
    const path = recordPath(record);
    const parser = expectedGrowthParser(record);
    if (!/^(?:GET|POST)$/.test(method) || !path || !parser) return null;

    let subjectItemIds = null;
    let competitorItemIds = null;
    let subjectPeriod = null;
    let competitorPeriod = null;
    let variant = null;

    if (path === "/dataplatform/dataset/report/query") {
      const scope = datasetScope(record);
      const requestType = datasetRequestType(record);
      const templateId = String(record?.templateId || "").trim();
      const templateFingerprint = String(record?.templateFingerprint || "").trim();
      subjectItemIds = exactReplacementIds(scope.subjectItemIds);
      competitorItemIds = exactReplacementIds(scope.competitorItemIds);
      subjectPeriod = exactReplacementPeriod(scope.subjectStart, scope.subjectEnd);
      competitorPeriod = exactReplacementPeriod(scope.competitorStart, scope.competitorEnd);
      if (!requestType || (!templateId && !templateFingerprint)) return null;
      // Keep both immutable identifiers when available. Treating templateId as
      // an alias for a different body fingerprint could otherwise let a newer
      // response clear an unrelated template failure.
      variant = { requestType, templateId, templateFingerprint };
    } else if (path === "/api/goods/grow/define/line/data"
      || path === "/api/goods/grow/comparison/scene"
      || path === "/api/goods/grow/comparison/scene/keyword") {
      subjectItemIds = exactReplacementIds(getParam(record, ["itemId", "entityId"]));
      competitorItemIds = exactReplacementIds(getParam(record, ["successItemId", "succItemId", "successItemIds", "succItemIds"]));
      subjectPeriod = exactReplacementPeriod(
        getParam(record, ["startDate", "start", "beginDate"]),
        getParam(record, ["endDate", "end", "finishDate"])
      );
      // These comparison endpoints apply the same exact requested period to
      // both objects; keeping two explicit period segments prevents a future
      // paired-period request from collapsing into this key accidentally.
      competitorPeriod = subjectPeriod ? { ...subjectPeriod } : null;
      variant = path === "/api/goods/grow/comparison/scene"
        ? { parentSceneId: String(getParam(record, ["sceneLevel1Id", "parentSceneId"]) || "") }
        : {};
    } else {
      return null;
    }

    if (!subjectItemIds || !competitorItemIds || !subjectPeriod || !competitorPeriod || !variant) return null;
    return {
      method,
      path,
      parser,
      subjectItemIds,
      competitorItemIds,
      subjectPeriod,
      competitorPeriod,
      variant
    };
  }

  function growthRecordReplacementKey(record) {
    const scope = growthRecordReplacementScope(record);
    return scope ? JSON.stringify(scope) : "";
  }

  function magnitudeScalar(value, inheritedMultiplier = 1) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return null;
    let text = value.trim().replace(/[,，￥¥\s]/g, "");
    if (!text || text === "-") return null;
    const percent = text.endsWith("%");
    if (percent) text = text.slice(0, -1);
    text = text.replace(/[元个次笔人件]$/, "");
    const unit = text.match(/(亿|万|千|[wWkK])$/)?.[1] || "";
    const multiplier = unit === "亿" ? 100000000 : /^(万|[wW])$/.test(unit) ? 10000 : /^(千|[kK])$/.test(unit) ? 1000 : inheritedMultiplier;
    const parsed = Number(unit ? text.slice(0, -unit.length) : text);
    return Number.isFinite(parsed) ? parsed * multiplier / (percent ? 100 : 1) : null;
  }

  function numberOrNull(value) {
    if (typeof value === "string" && /[~～至]|以上|以下|以内/.test(value)) return null;
    return magnitudeScalar(value);
  }

  function metricNumber(value, preferredKeys = [], depth = 0) {
    const direct = numberOrNull(value);
    if (direct != null) return direct;
    if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return null;
    const orderedKeys = [...preferredKeys, "indicatorValue", "value", "periodValue", "indexValue", "itemValue", "selfValue"];
    for (const key of orderedKeys) {
      if (!(key in value)) continue;
      const nested = metricNumber(value[key], preferredKeys, depth + 1);
      if (nested != null) return nested;
    }
    return null;
  }

  function lineGmvIndex(row) {
    const aliases = ["gmvIndex", "gmv_index", "indexValue", "gmvValue", "gmvTrend", "gmv", "GMV指数", "日GMV指数"];
    const competitorKeys = ["succItemValue", "successItemValue", "compareItemValue", "c_value", "cValue", "compareValue", "competitorValue"];
    for (const alias of aliases) {
      if (!(alias in (row || {}))) continue;
      const value = metricNumber(row[alias], competitorKeys);
      if (value != null) return value;
    }
    return null;
  }

  function costPerClick(spend, clicks) {
    return safeIntervalDivide(spend, clicks, { digits: 2, metric: "PPC", outward: true }).value;
  }

  function sumMetricRanges(values) {
    if (!Array.isArray(values) || !values.length) return null;
    let minimum = 0;
    let maximum = 0;
    let hasRange = false;
    for (const value of values) {
      const exact = numberOrNull(value);
      if (exact != null) {
        minimum += exact;
        maximum += exact;
        continue;
      }
      const range = parseVagueRange(value);
      if (!range) return null;
      hasRange = hasRange || !range.exact;
      minimum = minimum == null || range.min == null ? null : minimum + range.min;
      maximum = maximum == null || range.max == null ? null : maximum + range.max;
    }
    if (!hasRange && Number.isFinite(minimum) && Number.isFinite(maximum) && minimum === maximum) return round(minimum);
    if (Number.isFinite(minimum) && Number.isFinite(maximum)) return `${round(minimum).toFixed(2)}~${round(maximum).toFixed(2)}`;
    if (Number.isFinite(maximum)) return `<${round(maximum).toFixed(2)}`;
    if (Number.isFinite(minimum)) return `>${round(minimum).toFixed(2)}`;
    return null;
  }

  function returnOnSpend(paidGmv, spend) {
    return safeIntervalDivide(paidGmv, spend, { digits: 2, metric: "ROI", outward: true }).value;
  }

  function paidGmvFromSpendAndRoi(spend, roi) {
    return safeIntervalMultiply(spend, roi, { digits: 2, metric: "付费成交额", outward: true }).value;
  }

  function contributionRatio(value, total) {
    return safeIntervalDivide(value, total, { digits: 6, metric: "付费金额占比", compact: true }).value;
  }

  function round(value, digits = 2) {
    if (!Number.isFinite(value)) return null;
    const base = 10 ** digits;
    return Math.round((value + Number.EPSILON) * base) / base;
  }

  function normalizeDate(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length !== 8 || !/^20\d{6}$/.test(digits)) return null;
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }

  function parseDateRange(value) {
    const dates = String(value || "").match(/20\d{2}[-/.]?\d{2}[-/.]?\d{2}/g) || [];
    return { start: normalizeDate(dates[0]), end: normalizeDate(dates[1] || dates[0]) };
  }

  function enumerateDates(start, end) {
    const lower = Date.parse(`${normalizeDate(start)}T00:00:00Z`);
    const upper = Date.parse(`${normalizeDate(end)}T00:00:00Z`);
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) return [];
    const output = [];
    for (let cursor = lower; cursor <= upper; cursor += 86400000) output.push(new Date(cursor).toISOString().slice(0, 10));
    return output;
  }

  function daysInclusive(start, end) {
    const dates = enumerateDates(start, end);
    return dates.length || null;
  }

  function parseVagueRange(value) {
    if (typeof value === "number" && Number.isFinite(value)) return { min: value, max: value, exact: true };
    if (typeof value !== "string") return null;
    const text = value.replace(/[,，￥¥]/g, "").trim();
    if (!text || text === "-") return null;
    if (/^[<>]\s*[\d.]+(?:亿|万|千|[wWkK])?%?(?:元)?$/.test(text)) {
      const valueNumber = magnitudeScalar(text.slice(1));
      return text.startsWith("<") ? { min: 0, max: valueNumber, exact: false, upperOpen: true } : { min: valueNumber, max: null, exact: false, lowerOpen: true };
    }
    const wordBound = text.match(/^(.+?)(及以上|以上|及以下|以下|以内)$/);
    if (wordBound) {
      const valueNumber = magnitudeScalar(wordBound[1]);
      if (valueNumber == null) return null;
      return /以下|以内/.test(wordBound[2])
        ? { min: 0, max: valueNumber, exact: false, upperOpen: true }
        : { min: valueNumber, max: null, exact: false, lowerOpen: true };
    }
    const parts = text.split(/[~～至]/);
    if (parts.length === 2) {
      const leftMultiplier = magnitudeScalar(`1${String(parts[0]).trim().match(/(亿|万|千|[wWkK])(?=%?(?:元)?$)/)?.[1] || ""}`) || 1;
      const rightMultiplier = magnitudeScalar(`1${String(parts[1]).trim().match(/(亿|万|千|[wWkK])(?=%?(?:元)?$)/)?.[1] || ""}`) || 1;
      const sharedMultiplier = leftMultiplier > 1 ? leftMultiplier : rightMultiplier;
      const min = magnitudeScalar(parts[0], sharedMultiplier);
      const max = magnitudeScalar(parts[1], sharedMultiplier);
      return min == null || max == null || min < 0 || max < 0 || min > max ? null : { min, max, exact: false };
    }
    const exact = magnitudeScalar(text);
    return exact == null || exact < 0 ? null : { min: exact, max: exact, exact: true };
  }

  function metricValueState(value, options = {}) {
    const explicitState = value && typeof value === "object" && !Array.isArray(value)
      ? String(value.state || value.valueState || "").toLowerCase()
      : "";
    if (Object.values(VALUE_STATES).includes(explicitState)) {
      return {
        state: explicitState,
        value: Object.prototype.hasOwnProperty.call(value, "value") ? value.value : null,
        reason: String(value.reason || options.reason || explicitState),
        range: value.range || null
      };
    }
    if (value === null || value === undefined || (typeof value === "string" && /^(?:\s*|[-–—]|--|暂无|无数据|null|undefined)$/i.test(value))) {
      return { state: VALUE_STATES.MISSING, value: null, reason: String(options.reason || "源字段缺失"), range: null };
    }
    if (typeof value === "string" && /^(?:n\/?a|不适用|无法计算|分母为0)$/i.test(value.trim())) {
      return { state: VALUE_STATES.NA, value: null, reason: String(options.reason || value.trim()), range: null };
    }
    if (typeof value === "number" && (!Number.isFinite(value) || (!options.allowNegative && value < 0))) {
      return { state: VALUE_STATES.INVALID, value: null, reason: String(options.reason || "数值非法"), range: null };
    }
    const range = parseVagueRange(value);
    if (!range || (!options.allowNegative && ((Number.isFinite(range.min) && range.min < 0) || (Number.isFinite(range.max) && range.max < 0)))) {
      return { state: VALUE_STATES.INVALID, value: null, reason: String(options.reason || "无法识别为精确值或合法区间"), range: null };
    }
    return {
      state: range.exact ? VALUE_STATES.EXACT : VALUE_STATES.INTERVAL,
      value: range.exact ? range.min : value,
      reason: "",
      range
    };
  }

  function isNumericMetricValue(value) {
    return [VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(metricValueState(value).state);
  }

  function metricRangesCompatible(leftValue, rightValue, tolerance = 0.01) {
    const left = metricValueState(leftValue);
    const right = metricValueState(rightValue);
    if (![VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(left.state)
      || ![VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(right.state)) return false;
    const leftRange = left.range;
    const rightRange = right.range;
    const scale = Math.max(
      1,
      Math.abs(leftRange.min || 0), Math.abs(leftRange.max || 0),
      Math.abs(rightRange.min || 0), Math.abs(rightRange.max || 0)
    );
    const slack = scale * tolerance;
    const leftMin = Number.isFinite(leftRange.min) ? leftRange.min : -Infinity;
    const leftMax = Number.isFinite(leftRange.max) ? leftRange.max : Infinity;
    const rightMin = Number.isFinite(rightRange.min) ? rightRange.min : -Infinity;
    const rightMax = Number.isFinite(rightRange.max) ? rightRange.max : Infinity;
    return leftMin <= rightMax + slack && rightMin <= leftMax + slack;
  }

  function parseDirectionalComparison(value) {
    if (typeof value !== "string") return null;
    const text = value.replace(/\s+/g, "").trim();
    let match = text.match(/^(?:比|较)(本品|对手|竞品)(高|低)$/);
    if (!match) {
      const reversed = text.match(/^(高|低)于(本品|对手|竞品)$/);
      if (reversed) match = [reversed[0], reversed[2], reversed[1]];
    }
    if (!match) return null;
    return {
      relation: match[2] === "高" ? "higher" : "lower",
      referenceSide: match[1] === "本品" ? "subject" : "competitor"
    };
  }

  // 明确比较方向只能收敛为数学上可证明的单边区间，不能猜一个有限区间。
  // 例如参考值为 5~6，目标“比参考高”最多只能确定为 >5。
  function resolveDirectionalBound(directionValue, referenceValue, targetSide, options = {}) {
    const direction = parseDirectionalComparison(directionValue);
    const reference = metricValueState(referenceValue);
    if (!direction || direction.referenceSide === targetSide
      || ![VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(reference.state)) return null;
    const digits = Number.isInteger(options.digits) ? options.digits : 6;
    if (direction.relation === "higher" && Number.isFinite(reference.range?.min)) {
      return `>${formattedBound(reference.range.min, digits, true)}`;
    }
    if (direction.relation === "lower" && Number.isFinite(reference.range?.max)) {
      return `<${formattedBound(reference.range.max, digits, true)}`;
    }
    return null;
  }

  function metricContextMismatch(left, right) {
    if (!left || !right) return "";
    const comparisons = [
      ["entityId", "对象不匹配"],
      ["startDate", "周期开始日期不匹配"],
      ["endDate", "周期结束日期不匹配"],
      ["coverageDays", "覆盖天数不匹配"],
      ["periodKey", "周期口径不匹配"]
    ];
    for (const [key, reason] of comparisons) {
      if (left[key] !== undefined && left[key] !== null && left[key] !== ""
        && right[key] !== undefined && right[key] !== null && right[key] !== ""
        && String(left[key]) !== String(right[key])) return reason;
    }
    return "";
  }

  function formattedBound(value, digits, compact) {
    const rounded = round(value, digits);
    if (!Number.isFinite(rounded)) return "";
    return compact ? String(rounded) : rounded.toFixed(digits);
  }

  // 所有比值统一经过这一层。它不取区间中点，并允许调用方携带对象/周期/
  // 覆盖上下文；上下文不一致时返回 conflict，而不是产出一个看似精确的值。
  function safeIntervalDivide(numeratorValue, denominatorValue, options = {}) {
    const digits = Number.isInteger(options.digits) ? options.digits : 6;
    const compact = options.compact === true;
    const numerator = metricValueState(numeratorValue, { reason: options.numeratorReason || "分子缺失" });
    const denominator = metricValueState(denominatorValue, { reason: options.denominatorReason || "分母缺失" });
    const base = {
      state: VALUE_STATES.MISSING,
      value: null,
      reason: "",
      metric: String(options.metric || "比值"),
      numeratorState: numerator.state,
      denominatorState: denominator.state
    };
    const contextReason = metricContextMismatch(options.numeratorContext, options.denominatorContext);
    if (contextReason) return { ...base, state: VALUE_STATES.CONFLICT, reason: contextReason };
    if ([VALUE_STATES.CONFLICT, VALUE_STATES.INVALID].includes(numerator.state)) return { ...base, state: numerator.state, reason: `分子${numerator.reason}` };
    if ([VALUE_STATES.CONFLICT, VALUE_STATES.INVALID].includes(denominator.state)) return { ...base, state: denominator.state, reason: `分母${denominator.reason}` };
    if (numerator.state === VALUE_STATES.NA || denominator.state === VALUE_STATES.NA) {
      return { ...base, state: VALUE_STATES.NA, reason: numerator.state === VALUE_STATES.NA ? numerator.reason : denominator.reason };
    }
    if (numerator.state === VALUE_STATES.MISSING) return { ...base, reason: numerator.reason };
    if (denominator.state === VALUE_STATES.MISSING) return { ...base, reason: denominator.reason };

    const numeratorRange = numerator.range;
    const denominatorRange = denominator.range;
    const denominatorExactZero = denominatorRange.exact && denominatorRange.min === 0;
    if (denominatorExactZero) return { ...base, state: VALUE_STATES.NA, reason: "分母为0" };
    const denominatorGuaranteedPositive = (denominatorRange.exact && denominatorRange.min > 0)
      || (denominatorRange.lowerOpen && Number.isFinite(denominatorRange.min) && denominatorRange.min >= 0)
      || (Number.isFinite(denominatorRange.min) && denominatorRange.min > 0);
    if (numeratorRange.exact && numeratorRange.min === 0) {
      return denominatorGuaranteedPositive
        ? { ...base, state: VALUE_STATES.EXACT, value: 0, reason: "" }
        : { ...base, reason: "分母区间可能包含0，无法确认0比值" };
    }

    const nMin = Number.isFinite(numeratorRange.min) ? numeratorRange.min : null;
    const nMax = Number.isFinite(numeratorRange.max) ? numeratorRange.max : null;
    const dMin = denominatorGuaranteedPositive && Number.isFinite(denominatorRange.min) ? denominatorRange.min : null;
    const dMax = Number.isFinite(denominatorRange.max) && denominatorRange.max > 0 ? denominatorRange.max : null;
    if (numeratorRange.exact && denominatorRange.exact && dMin > 0) {
      return { ...base, state: VALUE_STATES.EXACT, value: round(nMin / dMin, digits), reason: "" };
    }

    // A displayed interval must contain the mathematical interval after
    // formatting. PPC requests outward rounding so the lower bound never
    // rounds up and the upper bound never rounds down.
    const scale = 10 ** digits;
    const lowerRaw = nMin != null && dMax != null ? nMin / dMax : null;
    const upperRaw = nMax != null && dMin != null && dMin > 0 ? nMax / dMin : null;
    const lower = lowerRaw == null
      ? null
      : options.outward === true
        ? Math.floor((lowerRaw + Number.EPSILON) * scale) / scale
        : round(lowerRaw, digits);
    const upper = upperRaw == null
      ? null
      : options.outward === true
        ? Math.ceil((upperRaw - Number.EPSILON) * scale) / scale
        : round(upperRaw, digits);
    if (lower != null && upper != null) {
      if (lower === upper && numeratorRange.exact && denominatorRange.exact) {
        return { ...base, state: VALUE_STATES.EXACT, value: lower, reason: "" };
      }
      if (lower === 0 && (numeratorRange.upperOpen || denominatorRange.lowerOpen)) {
        return { ...base, state: VALUE_STATES.INTERVAL, value: `<${formattedBound(upper, digits, compact)}`, reason: "" };
      }
      return {
        ...base,
        state: VALUE_STATES.INTERVAL,
        value: `${formattedBound(lower, digits, compact)}~${formattedBound(upper, digits, compact)}`,
        reason: ""
      };
    }
    if (upper != null) return { ...base, state: VALUE_STATES.INTERVAL, value: `<${formattedBound(upper, digits, compact)}`, reason: "" };
    if (lower != null && lower > 0) return { ...base, state: VALUE_STATES.INTERVAL, value: `>${formattedBound(lower, digits, compact)}`, reason: "" };
    return { ...base, reason: "区间包含0且无法得到可靠边界" };
  }

  // 非负业务指标的乘积统一经过这一层。与安全除法一样，它不取区间
  // 中点；同一对象、同一天或同一周期的上下文不一致时直接返回冲突。
  function safeIntervalMultiply(leftValue, rightValue, options = {}) {
    const digits = Number.isInteger(options.digits) ? options.digits : 6;
    const compact = options.compact === true;
    const left = metricValueState(leftValue);
    const right = metricValueState(rightValue);
    const base = {
      state: VALUE_STATES.MISSING,
      value: null,
      reason: "",
      metric: String(options.metric || "乘积"),
      leftState: left.state,
      rightState: right.state
    };
    const contextReason = metricContextMismatch(options.leftContext, options.rightContext);
    if (contextReason) return { ...base, state: VALUE_STATES.CONFLICT, reason: contextReason };
    if ([VALUE_STATES.CONFLICT, VALUE_STATES.INVALID].includes(left.state)) return { ...base, state: left.state, reason: `左乘数${left.reason}` };
    if ([VALUE_STATES.CONFLICT, VALUE_STATES.INVALID].includes(right.state)) return { ...base, state: right.state, reason: `右乘数${right.reason}` };
    if (left.state === VALUE_STATES.NA || right.state === VALUE_STATES.NA) {
      return { ...base, state: VALUE_STATES.NA, reason: left.state === VALUE_STATES.NA ? left.reason : right.reason };
    }
    if (left.state === VALUE_STATES.MISSING) return { ...base, reason: String(options.leftReason || "左乘数缺失") };
    if (right.state === VALUE_STATES.MISSING) return { ...base, reason: String(options.rightReason || "右乘数缺失") };

    const leftRange = left.range;
    const rightRange = right.range;
    if ((leftRange.exact && leftRange.min === 0) || (rightRange.exact && rightRange.min === 0)) {
      return { ...base, state: VALUE_STATES.EXACT, value: 0, reason: "" };
    }
    const leftMin = Number.isFinite(leftRange.min) ? leftRange.min : null;
    const leftMax = Number.isFinite(leftRange.max) ? leftRange.max : null;
    const rightMin = Number.isFinite(rightRange.min) ? rightRange.min : null;
    const rightMax = Number.isFinite(rightRange.max) ? rightRange.max : null;
    if (leftRange.exact && rightRange.exact) {
      return { ...base, state: VALUE_STATES.EXACT, value: round(leftMin * rightMin, digits), reason: "" };
    }

    const scale = 10 ** digits;
    const lowerRaw = leftMin != null && rightMin != null ? leftMin * rightMin : null;
    const upperRaw = leftMax != null && rightMax != null ? leftMax * rightMax : null;
    const lower = lowerRaw == null
      ? null
      : options.outward === true
        ? Math.floor((lowerRaw + Number.EPSILON) * scale) / scale
        : round(lowerRaw, digits);
    const upper = upperRaw == null
      ? null
      : options.outward === true
        ? Math.ceil((upperRaw - Number.EPSILON) * scale) / scale
        : round(upperRaw, digits);
    if (lower != null && upper != null) {
      if (lower === 0 && (leftRange.upperOpen || rightRange.upperOpen)) {
        return { ...base, state: VALUE_STATES.INTERVAL, value: `<${formattedBound(upper, digits, compact)}`, reason: "" };
      }
      return {
        ...base,
        state: VALUE_STATES.INTERVAL,
        value: `${formattedBound(lower, digits, compact)}~${formattedBound(upper, digits, compact)}`,
        reason: ""
      };
    }
    if (upper != null) return { ...base, state: VALUE_STATES.INTERVAL, value: `<${formattedBound(upper, digits, compact)}`, reason: "" };
    if (lower != null && (lower > 0 || ((leftRange.lowerOpen || rightRange.lowerOpen) && lower === 0))) {
      return { ...base, state: VALUE_STATES.INTERVAL, value: `>${formattedBound(lower, digits, compact)}`, reason: "" };
    }
    return { ...base, reason: "区间无可靠乘积边界" };
  }

  function calculableMetricValue(value) {
    const range = parseVagueRange(value);
    if (!range) return value ?? null;
    if (range.exact && Number.isFinite(range.min)) return range.min;
    if (Number.isFinite(range.min) && Number.isFinite(range.max)) return `${round(range.min).toFixed(2)}~${round(range.max).toFixed(2)}`;
    if (Number.isFinite(range.max)) return `<${round(range.max).toFixed(2)}`;
    if (Number.isFinite(range.min)) return `>${round(range.min).toFixed(2)}`;
    return value ?? null;
  }

  function disclosedScalar(value, preferredKeys = [], depth = 0) {
    if (value === null || value === undefined || depth > 5) return null;
    if (typeof value !== "object" || Array.isArray(value)) return value;
    const keys = [...preferredKeys, "indicatorValue", "periodValue", "displayValue", "indexValue", "value", "text", "avg"];
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const nested = disclosedScalar(value[key], preferredKeys, depth + 1);
      if (nested !== null && nested !== undefined && nested !== "") return nested;
    }
    return null;
  }

  function valueFromPair(value, side) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const preferredKeys = side === "subject"
        ? ["itemValue", "subjectValue", "selfItemValue", "selfValue", "currentValue", "base", "value"]
        : ["succItemValue", "successItemValue", "compareItemValue", "c_value", "cValue", "compareValue", "competitorValue", "basePeriod"];
      for (const key of preferredKeys) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        return disclosedScalar(value[key]);
      }
      return side === "subject" ? disclosedScalar(value) : null;
    }
    return side === "subject" ? value : null;
  }

  function pickRowValue(row, aliases) {
    for (const alias of aliases) {
      if (Object.prototype.hasOwnProperty.call(row || {}, alias)) return row[alias];
    }
    return null;
  }

  function arrayFromBody(body, aliases = ["list", "rows", "items"]) {
    const candidates = [body?.data, body?.result, body?.payload, body];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate;
      for (const key of aliases) if (Array.isArray(candidate?.[key])) return candidate[key];
    }
    return null;
  }

  function extractCard(record, body) {
    const container = body?.data?.INDEX_CARD ? body.data : body?.INDEX_CARD ? body : null;
    const card = container?.INDEX_CARD;
    if (!card) return null;
    let pairs = [];
    if (Array.isArray(card.fields) && Array.isArray(card.values)) {
      pairs = card.fields.slice(0, card.values.length).map((field, index) => ({ field, value: card.values[index] ?? {} }));
    } else if (Array.isArray(card.list)) {
      pairs = card.list.map(row => ({
        field: row.field || { name: row.name, description: row.description, id: row.id },
        // 真实 INDEX_CARD 会把主体 value 写成 { indicatorValue }，同时把
        // 对手 c_value 作为该行的兄弟字段。旧逻辑一旦看到对象 value 就只保留
        // row.value，会把 c_value 区间整个丢掉。合并两层后既兼容兄弟
        // c_value，也兼容 value 内部自带 itemValue/succItemValue 的结构。
        value: row?.value && typeof row.value === "object" && !Array.isArray(row.value)
          ? { ...row, ...row.value }
          : row
      }));
    } else return null;
    const metrics = {};
    const metricRows = [];
    for (const pair of pairs) {
      const name = String(pair.field?.name || pair.value?.name || "").trim();
      if (!name) continue;
      const valueObject = pair.value && typeof pair.value === "object" && !Array.isArray(pair.value) ? pair.value : null;
      const parsed = {
        name,
        fieldId: pair.field?.id ?? null,
        description: pair.field?.description ?? null,
        subject: valueFromPair(pair.value, "subject"),
        competitor: valueFromPair(pair.value, "competitor"),
        difference: valueObject ? disclosedScalar(valueObject.diff_value ?? valueObject.difference ?? null) : null,
        trend: valueObject ? disclosedScalar(valueObject.trend ?? null) : null
      };
      metricRows.push(parsed);
      const previous = metrics[name];
      metrics[name] = previous ? {
        ...previous,
        subject: preferredMetricValue(previous.subject, parsed.subject),
        competitor: preferredMetricValue(previous.competitor, parsed.competitor),
        difference: isDisclosedMetric(previous.difference) ? previous.difference : parsed.difference,
        trend: isDisclosedMetric(previous.trend) ? previous.trend : parsed.trend
      } : parsed;
    }
    const scope = datasetScope(record);
    const range = parseDateRange(container?.rangeDesc || card?.rangeDesc);
    return {
      capturedAt: record?.capturedAt || null,
      start: range.start || scope.subjectStart,
      end: range.end || scope.subjectEnd,
      rangeDescription: container?.rangeDesc || null,
      ...scope,
      metrics,
      metricRows
    };
  }

  function extractDatasetTable(record, body) {
    const table = body?.data?.TABLE || body?.TABLE;
    if (!table || !Array.isArray(table.rows) || !Array.isArray(table.values)) return null;
    return { capturedAt: record?.capturedAt || null, columns: table.columns || [], rows: table.rows, values: table.values };
  }

  function extractItemInfo(record, body) {
    const data = body?.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const id = data.id ?? data.itemId ?? getParam(record, "itemId");
    if (id == null) return null;
    return {
      itemId: String(id), title: data.name ?? data.itemName ?? data.title ?? "", reservePrice: data.reservePrice ?? data.price ?? null,
      gmv30d: data.gmv30d ?? data.gmv30Day ?? data.amt30day ?? null,
      avgDailyAmount30d: data.amt30DayAvg ?? data.avgDailyAmount30d ?? null,
      gmv30dRank: data.gmv30dRank ?? data.amtRank ?? null,
      gmv30dRankChange: data.gmv30dRankIncr ?? data.amtRankDiffWithBefore ?? null,
      rankPercent: data.rankPercent ?? null,
      onlineDays: data.onlineDays ?? null,
      lifecycle: data.lifeCycleDesc ?? data.lifecycle ?? "", category: data.cateName ?? data.cateLevel2Name ?? "",
      detailUrl: data.detailUrl ?? data.itemUrl ?? "",
      pictureUrl: data.pictUrl ?? data.picUrl ?? data.imageUrl ?? data.itemPictUrl ?? data.pictureUrl ?? data.mainPicUrl ?? "",
      raw: data
    };
  }

  function successDescriptionFields(description) {
    const text = String(description || "").trim();
    const take = regex => text.match(regex)?.[1]?.trim() || "";
    const rank = take(/成交排名\s*([^，,]+)/i);
    return {
      annualGmvBand: take(/年\s*GMV[「“\"]([^」”\"]+)[」”\"]/i),
      onlineDays: numberOrNull(take(/上架\s*(\d+)\s*天/i)),
      priceBand: take(/((?:P\d+\s*)?[（(][^）)]+[）)]\s*价格带)/i) || take(/(P\d+[^，,]*价格带)/i),
      lifecycle: take(/处于\s*([^，,]+)/i),
      dealRank: rank,
      audience: rank ? text.split(/成交排名\s*[^，,]+[，,]?/i)[1]?.trim() || "" : ""
    };
  }

  function extractSuccessItems(record, body, source) {
    const rows = arrayFromBody(body);
    if (!rows) return null;
    return rows.map(row => {
      const description = row.desc ?? row.description ?? "";
      const parsed = successDescriptionFields(description);
      return {
        itemId: String(row.itemId ?? row.id ?? ""), title: row.itemTitle ?? row.title ?? row.name ?? "",
        pictureUrl: row.itemPictUrl ?? row.pictureUrl ?? row.pictUrl ?? row.picUrl ?? row.imageUrl ?? row.mainPicUrl ?? "",
        detailUrl: row.detailUrl ?? row.itemUrl ?? "", description,
        labels: Array.isArray(row.labels) ? row.labels.map(label => typeof label === "string" ? label : label?.labelName).filter(Boolean) : [],
        annualGmvBand: row.annualGmvBand ?? parsed.annualGmvBand,
        onlineDays: row.onlineDays ?? parsed.onlineDays,
        priceBand: row.priceBand ?? parsed.priceBand,
        lifecycle: row.lifeCycleDesc ?? row.lifecycle ?? parsed.lifecycle,
        dealRank: row.dealRank ?? parsed.dealRank,
        audience: row.audience ?? parsed.audience,
        source, capturedAt: record?.capturedAt || null
      };
    }).filter(row => row.itemId);
  }

  function plainText(value) {
    return String(value || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
  }

  function extractStageActions(value) {
    const blocks = parseJsonLike(value);
    if (!Array.isArray(blocks)) return { adStrategy: "", executionDetails: "", operations: "" };
    const ads = [];
    const details = [];
    const operations = [];
    for (const block of blocks) {
      const title = plainText(block?.ad_action_title || block?.title);
      const lines = (Array.isArray(block?.ad_action_text) ? block.ad_action_text : [])
        .map(entry => plainText(entry?.content ?? entry)).filter(Boolean);
      if (/运营/.test(title)) operations.push(...(lines.length ? lines : [title]));
      else {
        if (title) ads.push(title);
        details.push(...lines);
      }
    }
    return { adStrategy: [...new Set(ads)].join("\n"), executionDetails: [...new Set(details)].join("\n"), operations: [...new Set(operations)].join("\n") };
  }

  function businessText(value, depth = 0) {
    if (value == null || depth > 6) return "";
    if (typeof value === "string" || typeof value === "number") return plainText(value);
    if (Array.isArray(value)) return [...new Set(value.map(child => businessText(child, depth + 1)).filter(Boolean))].join("\n");
    if (typeof value !== "object") return "";
    const preferred = ["content", "text", "title", "name", "description", "detail", "value", "label"];
    const selected = preferred.filter(key => Object.prototype.hasOwnProperty.call(value, key))
      .map(key => businessText(value[key], depth + 1)).filter(Boolean);
    if (selected.length) return [...new Set(selected)].join("\n");
    return [...new Set(Object.entries(value)
      .filter(([key]) => !/(?:id|code|time|date|url)/i.test(key))
      .map(([, child]) => businessText(child, depth + 1)).filter(Boolean))].join("\n");
  }

  function extractLine(record, body) {
    const data = body?.data;
    if (!data || !Array.isArray(data.lineInfo)) return null;
    const daily = data.lineInfo.map(row => {
      const subjectChannelSpend = {};
      const competitorChannelSpend = {};
      let hasPairedChannels = false;
      for (const [apiName, label] of CHANNELS) {
        const raw = row[apiName];
        const paired = Boolean(raw && typeof raw === "object" && !Array.isArray(raw)
          && ["itemValue", "subjectValue", "selfItemValue", "selfValue", "succItemValue", "successItemValue", "compareItemValue", "c_value", "cValue", "compareValue", "competitorValue"].some(key => Object.prototype.hasOwnProperty.call(raw, key)));
        hasPairedChannels ||= paired;
        subjectChannelSpend[label] = paired ? numberOrNull(valueFromPair(raw, "subject")) : null;
        competitorChannelSpend[label] = paired
          ? numberOrNull(valueFromPair(raw, "competitor"))
          : numberOrNull(disclosedScalar(raw));
      }
      const subjectValues = Object.values(subjectChannelSpend);
      const competitorValues = Object.values(competitorChannelSpend);
      return {
        date: normalizeDate(row.date), gmvIndex: lineGmvIndex(row),
        channelSpend: competitorChannelSpend,
        competitorChannelSpend,
        subjectChannelSpend,
        hasPairedChannels,
        channelFieldCoverage: competitorValues.filter(Number.isFinite).length,
        subjectChannelFieldCoverage: subjectValues.filter(Number.isFinite).length,
        totalSpend: competitorValues.every(Number.isFinite) ? round(competitorValues.reduce((sum, value) => sum + value, 0)) : null,
        subjectTotalSpend: subjectValues.every(Number.isFinite) ? round(subjectValues.reduce((sum, value) => sum + value, 0)) : null
      };
    }).filter(row => row.date).sort((left, right) => left.date.localeCompare(right.date));
    const stages = (data.stages || []).map((stage, index) => {
      const range = parseDateRange(stage.rangeTime || stage.dateRange);
      const actions = extractStageActions(stage.actionText ?? stage.actions);
      return {
        stage: String(stage.stage ?? stage.stageCode ?? index + 1), start: range.start, end: range.end,
        name: businessText(stage.title ?? stage.stageName ?? stage.phase) || `阶段${index + 1}`,
        description: businessText(stage.metricText ?? stage.description),
        adStrategy: businessText(stage.adTitle) || actions.adStrategy,
        executionDetails: businessText(stage.adDetails) || actions.executionDetails,
        operations: businessText(stage.operation) || actions.operations
      };
    });
    return {
      capturedAt: record?.capturedAt || null,
      itemId: String(getParam(record, ["itemId", "entityId"]) || ""),
      successItemId: String(getParam(record, ["successItemId", "succItemId", "successItemIds", "succItemIds"]) || "").split(",")[0],
      requestStart: normalizeDate(getParam(record, ["startDate", "start", "beginDate"])),
      requestEnd: normalizeDate(getParam(record, ["endDate", "end", "finishDate"])),
      actualStart: daily[0]?.date || null, actualEnd: daily.at(-1)?.date || null, daily, stages
    };
  }

  function extractScene(record, body) {
    const rows = arrayFromBody(body);
    if (!rows) return null;
    const parentSceneId = String(getParam(record, ["sceneLevel1Id", "parentSceneId"]) || "");
    return {
      capturedAt: record?.capturedAt || null,
      itemId: String(getParam(record, ["itemId", "entityId"]) || ""),
      successItemIds: String(getParam(record, ["succItemIds", "successItemIds", "successItemId", "succItemId"]) || "").split(",").filter(Boolean),
      start: normalizeDate(getParam(record, ["startDate", "start", "beginDate"])),
      end: normalizeDate(getParam(record, ["endDate", "end", "finishDate"])),
      level: parentSceneId ? 2 : 1, parentSceneId: parentSceneId || null,
      rows: rows.map(row => ({
        sceneId: row.sceneId == null ? String(row.sceneid ?? row.sceneCode ?? "") : String(row.sceneId),
        sceneName: row.sceneName ?? row.channelName ?? row.promotion_scene ?? row.promotionScene ?? row.name ?? "",
        charge: pickRowValue(row, ["charge", "spend", "cost", "promotionSpend", "promotionCost", "adSpend", "totalCharge", "consume", "consumption"]),
        chargeRatio: pickRowValue(row, ["chargeRatio", "costRate", "spendRate", "chargeRate", "costRatio", "promotionCostRate"]),
        impression: pickRowValue(row, ["impression", "impressions", "impressionCnt", "impressionCount", "pv_di", "pv", "show", "showCnt"]),
        click: pickRowValue(row, ["click", "clicks", "clickCnt", "clickCount", "promotionClick"]),
        ctr: pickRowValue(row, ["ctr", "ctr_di", "clickRate", "clickThroughRate"]),
        cpc: pickRowValue(row, ["cpc", "ppc", "cost_per", "clickCost", "costClick", "costPerClick", "点击单价", "平均点击单价"]),
        directDealAmount: pickRowValue(row, ["directDealAmount", "directAlipayAmt", "directAlipayAmount", "alipayAmt", "alipayAmt1d", "gmv1d", "directGmv", "attributedGmv"]),
        directRoi: pickRowValue(row, ["directRoi", "directROI", "roi", "roi1d", "promotionRoi", "inputOutputRatio", "投入产出比", "直接投产比"])
      }))
    };
  }

  function indicatorValue(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value.indicatorValue ?? value.value ?? null) : value;
  }

  function extractKeywords(record, body) {
    const data = body?.data;
    if (!data || (!Array.isArray(data.item) && !Array.isArray(data.succItem))) return null;
    const normalize = (rows, role) => (rows || []).map(row => ({
      role, keyword: row.keywordName ?? row.keyword ?? row.name ?? "", type: row.keywordType ?? row.type ?? "",
      impression: indicatorValue(row.impression), click: indicatorValue(row.click), ctr: indicatorValue(row.ctr),
      conversion: indicatorValue(row.conversionRate ?? row.alipayConversion)
    })).filter(row => row.keyword);
    return {
      capturedAt: record?.capturedAt || null,
      itemId: String(getParam(record, ["itemId", "entityId"]) || ""),
      successItemIds: String(getParam(record, ["succItemIds", "successItemIds", "successItemId"]) || "").split(",").filter(Boolean),
      start: normalizeDate(getParam(record, ["startDate", "start", "beginDate"])), end: normalizeDate(getParam(record, ["endDate", "end", "finishDate"])),
      rows: [...normalize(data.item, "主体"), ...normalize(data.succItem, "对手")]
    };
  }

  function samePeriod(value, period) {
    return Boolean(value && period && value.start === period.startDate && value.end === period.endDate);
  }

  function sameComparedPeriod(card, period) {
    return Boolean(samePeriod(card, period)
      && card.competitorStart === period.startDate
      && card.competitorEnd === period.endDate);
  }

  function mergeMetricCards(sourceCards) {
    const cards = (sourceCards || []).slice()
      .sort((left, right) => String(right.capturedAt || "").localeCompare(String(left.capturedAt || "")));
    if (!cards.length) return null;
    const metricRows = cards.flatMap(card => card.metricRows || []);
    const metrics = {};
    for (const row of metricRows) {
      const name = String(row?.name || "").trim();
      if (!name) continue;
      const previous = metrics[name];
      metrics[name] = previous ? {
        ...previous,
        subject: preferredMetricValue(previous.subject, row.subject),
        competitor: preferredMetricValue(previous.competitor, row.competitor),
        difference: isDisclosedMetric(previous.difference) ? previous.difference : row.difference,
        trend: isDisclosedMetric(previous.trend) ? previous.trend : row.trend
      } : { ...row };
    }
    return {
      ...cards[0],
      capturedAt: cards[0].capturedAt || null,
      sourceCardCount: cards.length,
      sourceCapturedAt: cards.map(card => card.capturedAt).filter(Boolean),
      metrics,
      metricRows
    };
  }

  function metric(card, name) {
    return card?.metrics?.[name] || { subject: null, competitor: null };
  }

  function metricByAliases(card, aliases) {
    const identities = new Set(aliases.map(metricIdentity));
    const merged = { subject: null, competitor: null, difference: null, trend: null };
    for (const [name, value] of Object.entries(card?.metrics || {})) {
      if (!identities.has(metricIdentity(name))) continue;
      for (const side of ["subject", "competitor", "difference", "trend"]) {
        if (side === "subject" || side === "competitor") {
          merged[side] = preferredMetricValue(merged[side], value?.[side]);
        } else if (!isDisclosedMetric(merged[side]) && isDisclosedMetric(value?.[side])) {
          merged[side] = value[side];
        }
      }
    }
    return merged;
  }

  function rangeContains(range, value) {
    return Boolean(range && Number.isFinite(value) && (range.min == null || value >= range.min) && (range.max == null || value <= range.max));
  }

  function alignedMetricValue(value) {
    return isDisclosedMetric(value) ? calculableMetricValue(value) : null;
  }

  function buildAlignedMetrics(card, visitorClosure = {}) {
    const source = Array.isArray(card?.metricRows) && card.metricRows.length
      ? card.metricRows
      : Object.entries(card?.metrics || {}).map(([name, value]) => ({ name, ...value }));
    const originalEntries = source.map((entry, index) => ({ ...entry, index, identity: metricIdentity(entry.name) }));
    // IPV 只有在与“成交笔数 ÷ 支付转化率”闭合时，才可规范成访客数。
    // 未闭合的一侧保留原始 IPV 身份，避免把页面披露的另一口径误标成访客数。
    const ipvEntries = originalEntries.filter(entry => normalizeMetricName(entry.name) === "ipv");
    const entries = originalEntries.map(entry => normalizeMetricName(entry.name) === "ipv" ? {
      ...entry,
      subject: visitorClosure.subject ? null : entry.subject,
      competitor: visitorClosure.competitor ? null : entry.competitor
    } : entry);
    const output = [];
    const emitted = new Set();

    function append(identity, name, candidates, core) {
      if (!candidates.length || emitted.has(identity)) return;
      const preferred = candidates.find(entry => normalizeMetricName(entry.name) === normalizeMetricName(name)) || candidates[0];
      const firstValue = side => alignedMetricValue(candidates.reduce(
        (selected, entry) => preferredMetricValue(selected, entry?.[side]),
        null
      ));
      const subject = firstValue("subject");
      const competitor = firstValue("competitor");
      if (!isDisclosedMetric(subject) && !isDisclosedMetric(competitor)) return;
      emitted.add(identity);
      output.push({
        key: identity,
        name,
        subject,
        competitor,
        fieldId: preferred.fieldId ?? null,
        description: preferred.description ?? null,
        sourceNames: [...new Set(candidates.map(entry => entry.name))],
        core
      });
    }

    for (const group of METRIC_ALIAS_GROUPS) {
      const candidates = entries.filter(entry => entry.identity === group.key);
      if (group.key === "visitors" && ipvEntries.length) {
        candidates.push(...ipvEntries.map(entry => ({
          ...entry,
          identity: "visitors",
          name: "访客数",
          subject: visitorClosure.subject ? entry.subject : null,
          competitor: visitorClosure.competitor ? entry.competitor : null
        })));
      }
      append(group.key, group.name, candidates, true);
    }
    for (const entry of entries.sort((left, right) => left.index - right.index)) {
      if (emitted.has(entry.identity)) continue;
      append(entry.identity, entry.name, entries.filter(candidate => candidate.identity === entry.identity), false);
    }
    return output;
  }

  function buildMetrics(card) {
    const read = (name, side) => calculableMetricValue(metricByAliases(card, [name])[side]);
    const paidGmv = metricByAliases(card, ["付费成交额", "付费成交金额", "付费GMV", "营销推广成交额", "营销推广成交金额", "营销推广GMV", "推广GMV", "广告归因GMV", "广告成交额", "广告成交金额"]);
    const paidOrders = metricByAliases(card, ["付费成交笔数", "营销推广成交笔数", "广告成交笔数", "广告归因成交笔数", "alipayCnt1d"]);
    const subject = {
      marketingClicks: read("营销推广点击量", "subject"), naturalClicks: read("自然点击量", "subject"),
      orders: read("成交笔数", "subject"), conversion: read("支付转化率", "subject"), aov: read("笔单价", "subject"),
      cartRate: read("加购率", "subject"), visitors: read("访客数", "subject"), ipv: read("IPV", "subject"),
      totalGmv: read("总GMV", "subject"),
      paidGmv: calculableMetricValue(paidGmv.subject), paidOrders: calculableMetricValue(paidOrders.subject),
      spend: read("推广消耗", "subject"), feeRatio: read("费比", "subject"),
      roi: read("ROI", "subject"), ppc: read("PPC", "subject"), roas: read("全域ROAS", "subject")
    };
    const competitor = {
      marketingClicks: read("营销推广点击量", "competitor"), naturalClicks: read("自然点击量", "competitor"),
      orders: read("成交笔数", "competitor"), conversion: read("支付转化率", "competitor"), aov: read("笔单价", "competitor"),
      cartRate: read("加购率", "competitor"), visitors: read("访客数", "competitor"), ipv: read("IPV", "competitor"),
      totalGmv: read("总GMV", "competitor"),
      paidGmv: calculableMetricValue(paidGmv.competitor), paidOrders: calculableMetricValue(paidOrders.competitor),
      spend: read("推广消耗", "competitor"), feeRatio: read("费比", "competitor"),
      roi: read("ROI", "competitor"), ppc: read("PPC", "competitor"), roas: read("全域ROAS", "competitor")
    };
    for (const side of [subject, competitor]) {
      captureDirectionalComparisons(side);
      const namedVisitorDisclosed = isDisclosedMetric(side.visitors);
      if (!isNumericMetricValue(side.totalGmv)) {
        const calculated = safeIntervalMultiply(side.orders, side.aov, {
          digits: 2, metric: "总GMV", outward: true
        });
        if ([VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(calculated.state)) side.totalGmv = calculated.value;
      } else side.totalGmv = calculableMetricValue(side.totalGmv);

      const calculatedVisitor = safeIntervalDivide(side.orders, side.conversion, {
        digits: 2, metric: "访客数", outward: true
      });
      const calculatedVisitorNumeric = [VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(calculatedVisitor.state);
      const visitorClosed = calculatedVisitorNumeric && (
        namedVisitorDisclosed
          ? (!isNumericMetricValue(side.visitors) || metricRangesCompatible(side.visitors, calculatedVisitor.value))
          : metricRangesCompatible(side.ipv, calculatedVisitor.value)
      );
      if (!isNumericMetricValue(side.visitors) && visitorClosed) side.visitors = calculatedVisitor.value;
      side.visitorClosed = visitorClosed;

      applyCanonicalEfficiencyMetrics(side);
      closePeriodMetricSet(side);
    }
    return {
      subject,
      competitor,
      aligned: buildAlignedMetrics(card, { subject: subject.visitorClosed, competitor: competitor.visitorClosed })
    };
  }

  function previousOneDayPeriod(date) {
    const parsed = Date.parse(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(parsed)) return null;
    const previous = new Date(parsed - 86400000).toISOString().slice(0, 10);
    return { startDate: previous, endDate: previous, days: 1 };
  }

  function summarizeExactDailySide(rows, expectedDates, periodSide) {
    const missingDates = expectedDates.filter(date => !rows.some(row => row.date === date));
    const unresolvedDates = rows.filter(row => !Number.isFinite(row.orders) || !Number.isFinite(row.gmv)).map(row => row.date);
    const resolvedRows = rows.filter(row => Number.isFinite(row.orders) && Number.isFinite(row.gmv));
    const orderTotal = round(resolvedRows.reduce((sum, row) => sum + row.orders, 0));
    const gmvTotal = round(resolvedRows.reduce((sum, row) => sum + row.gmv, 0));
    const expectedOrders = numberOrNull(periodSide?.orders);
    const expectedGmv = numberOrNull(periodSide?.totalGmv);
    const ordersClosed = Number.isFinite(expectedOrders) && resolvedRows.length === expectedDates.length
      && Math.abs(orderTotal - expectedOrders) <= 0.000001;
    const gmvDifference = Number.isFinite(expectedGmv) && Number.isFinite(gmvTotal) ? round(Math.abs(gmvTotal - expectedGmv)) : null;
    const gmvClosed = Number.isFinite(gmvDifference) && resolvedRows.length === expectedDates.length && gmvDifference <= 0.01;
    return {
      rows,
      expectedDates,
      missingDates,
      unresolvedDates,
      orderTotal,
      expectedOrders,
      ordersClosed,
      gmvTotal,
      expectedGmv,
      gmvDifference,
      gmvClosed,
      complete: expectedDates.length > 0 && !missingDates.length && !unresolvedDates.length
        && rows.length === expectedDates.length && ordersClosed && gmvClosed
    };
  }

  function buildPairedDaily(cards, subjectItemId, successItemId, period, periodMetrics, dailySupplements = [], runId = "") {
    const expectedDates = enumerateDates(period?.startDate, period?.endDate);
    const byDate = new Map();
    for (const card of cards || []) {
      if (!card || card.start !== card.end || !expectedDates.includes(card.start)) continue;
      if (card.competitorStart !== card.start || card.competitorEnd !== card.end) continue;
      if (!card.subjectItemIds.includes(subjectItemId) || !card.competitorItemIds.includes(successItemId)) continue;
      const list = byDate.get(card.start) || [];
      list.push(card);
      byDate.set(card.start, list);
    }
    const cardMetricSignature = card => [...new Set((card?.metricRows || []).map(row => metricIdentity(row.name)))].sort().join("|");
    const duplicateDates = expectedDates.filter(date => {
      const signatures = (byDate.get(date) || []).map(cardMetricSignature);
      return signatures.length > new Set(signatures).size;
    });
    const supplementByDate = new Map();
    for (const supplementValue of dailySupplements || []) {
      const date = normalizeDate(supplementValue?.period?.startDate);
      if (!date || supplementValue?.period?.endDate !== date || !expectedDates.includes(date)) continue;
      if (String(supplementValue?.subject?.itemId || "") !== subjectItemId
        || String(supplementValue?.competitor?.itemId || "") !== successItemId) continue;
      if (runId && String(supplementValue?.runId || "") !== String(runId)) continue;
      const previous = supplementByDate.get(date);
      if (!previous || String(supplementValue?.capturedAt || "").localeCompare(String(previous?.capturedAt || "")) > 0) {
        supplementByDate.set(date, supplementValue);
      }
    }
    const subjectRows = [];
    const competitorRows = [];
    const supplementAudits = [];
    for (const date of expectedDates) {
      const candidates = (byDate.get(date) || []).sort((left, right) => String(right.capturedAt || "").localeCompare(String(left.capturedAt || "")));
      const pairedMetrics = buildMetrics(candidates.length ? mergeMetricCards(candidates) : null);
      const supplementValue = supplementByDate.get(date);
      if (supplementValue && competitionItemSupplement?.applyToMetrics) {
        const audit = competitionItemSupplement.applyToMetrics(pairedMetrics, supplementValue, {
          subjectItemId,
          competitorItemId: successItemId,
          runId,
          period: { startDate: date, endDate: date, days: 1 },
          previousPeriod: previousOneDayPeriod(date)
        });
        supplementAudits.push({ date, ...audit });
      }
      for (const [side, target] of [["subject", subjectRows], ["competitor", competitorRows]]) {
        const dailyMetrics = pairedMetrics[side] || {};
        const orders = numberOrNull(dailyMetrics.orders);
        const aov = numberOrNull(dailyMetrics.aov);
        const gmv = numberOrNull(dailyMetrics.totalGmv);
        if (!candidates.length && !supplementValue) continue;
        target.push({
          date, orders, aov, gmv,
          totalSpend: isDisclosedMetric(dailyMetrics.spend) ? dailyMetrics.spend : null,
          feeRatio: isDisclosedMetric(dailyMetrics.feeRatio) ? dailyMetrics.feeRatio : null,
          metrics: { ...dailyMetrics }
        });
      }
    }
    return {
      duplicateDates,
      supplementAudits,
      subject: { ...summarizeExactDailySide(subjectRows, expectedDates, periodMetrics?.subject), duplicateDates },
      competitor: { ...summarizeExactDailySide(competitorRows, expectedDates, periodMetrics?.competitor), duplicateDates }
    };
  }

  function chooseLine(lines, subjectId, successItemId, period) {
    const dates = new Set(enumerateDates(period.startDate, period.endDate));
    return lines.map(line => {
      const successMatch = String(line.successItemId) === String(successItemId);
      const subjectMatch = String(line.itemId) === String(subjectId);
      const overlap = line.daily.filter(row => dates.has(row.date)).length;
      return { line, score: Number(successMatch) * 1000 + Number(subjectMatch) * 300 + overlap };
    }).filter(entry => String(entry.line.itemId) === String(subjectId) && String(entry.line.successItemId) === String(successItemId)
      && entry.line.daily.some(row => dates.has(row.date)))
      .sort((left, right) => right.score - left.score || String(right.line.capturedAt || "").localeCompare(String(left.line.capturedAt || "")))[0]?.line || null;
  }

  function fitDailyGmv(rows, periodGmv) {
    const sourceRows = Array.isArray(rows) ? rows : [];
    const exactPeriodGmv = numberOrNull(periodGmv);
    const indexes = sourceRows.map(row => numberOrNull(row?.gmvIndex));
    const indexSum = indexes.every(Number.isFinite) ? indexes.reduce((sum, value) => sum + value, 0) : null;
    const base = {
      status: "blocked", reason: "", exactPeriodGmv: Number.isFinite(exactPeriodGmv) ? round(exactPeriodGmv) : null,
      estimatedPeakDailyGmv: null, indexSum, indexMin: null, indexMax: null, roundingAdjustment: 0,
      fittedTotal: null, dailyGmv: sourceRows.map(() => null)
    };
    if (!sourceRows.length) return { ...base, reason: "empty-series" };
    if (indexes.some(value => !Number.isFinite(value))) return { ...base, reason: "missing-index" };
    if (indexes.some(value => value < 0)) return { ...base, reason: "negative-index", indexMin: Math.min(...indexes), indexMax: Math.max(...indexes) };
    const indexMin = Math.min(...indexes);
    const indexMax = Math.max(...indexes);
    if (!Number.isFinite(exactPeriodGmv) || exactPeriodGmv < 0) return { ...base, reason: "invalid-period-gmv", indexMin, indexMax };
    if (!Number.isFinite(indexSum) || indexSum <= 0) return { ...base, reason: "non-positive-index-sum", indexMin, indexMax };

    const estimatedPeakDailyGmv = exactPeriodGmv / indexSum;
    const dailyGmv = indexes.map(value => round(estimatedPeakDailyGmv * value));
    const roundedTotal = round(dailyGmv.reduce((sum, value) => sum + value, 0));
    const roundingAdjustment = round(exactPeriodGmv - roundedTotal);
    if (roundingAdjustment) dailyGmv[dailyGmv.length - 1] = round(dailyGmv.at(-1) + roundingAdjustment);
    const fittedTotal = round(dailyGmv.reduce((sum, value) => sum + value, 0));
    if (Math.abs(fittedTotal - round(exactPeriodGmv)) > 0.01) {
      return { ...base, reason: "rounding-closure-failed", estimatedPeakDailyGmv: round(estimatedPeakDailyGmv), indexMin, indexMax, roundingAdjustment, fittedTotal };
    }
    return {
      status: "ready", reason: "", exactPeriodGmv: round(exactPeriodGmv), estimatedPeakDailyGmv: round(estimatedPeakDailyGmv),
      indexSum, indexMin, indexMax, roundingAdjustment, fittedTotal, dailyGmv
    };
  }

  function summarizeSpendCoverage(rows, expectedDates, hasSource = true) {
    const expected = Array.isArray(expectedDates) ? expectedDates : [];
    const byDate = new Map((rows || [])
      .filter(row => expected.includes(row?.date) && Number.isFinite(row?.totalSpend))
      .map(row => [row.date, row]));
    const spendRows = expected.map(date => byDate.get(date)).filter(Boolean);
    const dates = spendRows.map(row => row.date);
    const missingDates = expected.filter(date => !byDate.has(date));
    const coverageDays = spendRows.length;
    const expectedDays = expected.length;
    const complete = Boolean(hasSource && expectedDays > 0 && missingDates.length === 0);
    const partial = Boolean(hasSource && missingDates.length > 0
      && missingDates.length <= PLATFORM_DAY_GAP_TOLERANCE && coverageDays > 0);
    const singleDayPartial = Boolean(partial && missingDates.length === 1 && coverageDays === expectedDays - 1);
    const usable = complete || partial;
    const spend = usable ? round(spendRows.reduce((sum, row) => sum + row.totalSpend, 0)) : null;
    const channelSpend = Object.fromEntries(CHANNELS.map(([, label]) => {
      const values = spendRows.map(row => row?.channelSpend?.[label]);
      return [label, usable && values.length === coverageDays && values.every(Number.isFinite)
        ? round(values.reduce((sum, value) => sum + value, 0))
        : null];
    }));
    return {
      spendRows,
      status: complete ? "complete" : partial ? "partial" : "missing",
      scope: complete ? "strict-period-daily" : partial ? "coverage-period" : "missing",
      expectedDays,
      coverageDays,
      dates,
      startDate: dates[0] || "",
      endDate: dates.at(-1) || "",
      missingDates,
      spend,
      channelSpend,
      complete,
      partial,
      singleDayPartial,
      usable
    };
  }

  function publicSpendCoverage(summary) {
    if (!summary || typeof summary !== "object") return null;
    const { spendRows: _spendRows, usable: _usable, ...coverage } = summary;
    return coverage;
  }

  function buildDaily(line, period, periodGmv) {
    const expected = enumerateDates(period.startDate, period.endDate);
    const dailyByDate = new Map();
    const dateCounts = new Map();
    for (const row of line?.daily || []) {
      if (!expected.includes(row.date)) continue;
      dateCounts.set(row.date, (dateCounts.get(row.date) || 0) + 1);
      dailyByDate.set(row.date, row);
    }
    const duplicateDates = [...dateCounts.entries()].filter(([, count]) => count > 1).map(([date]) => date).sort();
    const selected = expected.map(date => dailyByDate.get(date)).filter(Boolean);
    const missingDates = expected.filter(date => !selected.some(row => row.date === date));
    const missingChannelDates = selected.filter(row => row.channelFieldCoverage < CHANNELS.length).map(row => row.date);
    const missingIndexDates = selected.filter(row => !Number.isFinite(row.gmvIndex)).map(row => row.date);
    const invalidIndexDates = selected.filter(row => Number.isFinite(row.gmvIndex) && row.gmvIndex < 0).map(row => row.date);

    // 平台尚未产出某天数据有三种表现：整天不在趋势里、当天没有 GMV 序列值、
    // 当天五渠道消耗字段不全。三者都属于"平台少数据"，合并成同一组缺口日期。
    // 负数序列值是数据错误而不是缺口，仍然按阻断处理。
    const platformGapDates = [...new Set([...missingDates, ...missingIndexDates, ...missingChannelDates])].sort();
    const platformGapDays = platformGapDates.length;
    const platformGapTolerated = Boolean(line && !invalidIndexDates.length
      && platformGapDays > 0 && platformGapDays <= PLATFORM_DAY_GAP_TOLERANCE);

    // 日GMV只在有序列值的日期上拟合。平台缺某天时它返回的周期总GMV同样不含这天，
    // 所以按已返回日期闭合才是一致的口径；缺失当天保持空值，绝不摊成 0 或均摊。
    const indexedRows = selected.filter(row => Number.isFinite(row.gmvIndex) && row.gmvIndex >= 0);
    const indexGapDays = missingDates.length + missingIndexDates.length;
    const gmvFit = !invalidIndexDates.length && indexGapDays <= PLATFORM_DAY_GAP_TOLERANCE
      ? fitDailyGmv(indexedRows, periodGmv)
      : {
        ...fitDailyGmv([], periodGmv),
        reason: missingDates.length ? "missing-date" : invalidIndexDates.length ? "negative-index" : "missing-index",
        dailyGmv: indexedRows.map(() => null)
      };
    const fittedGmvByDate = new Map(indexedRows.map((row, index) => [row.date, gmvFit.dailyGmv[index]]));
    const complete = Boolean(line && !platformGapDays && !invalidIndexDates.length && gmvFit.status === "ready");
    const rows = selected.map(row => {
      const dailyGmv = fittedGmvByDate.has(row.date) ? fittedGmvByDate.get(row.date) : null;
      return {
        ...row, dailyGmv,
        feeRatio: Number.isFinite(row.totalSpend) && Number.isFinite(dailyGmv) && dailyGmv !== 0 ? round(row.totalSpend / dailyGmv, 6) : null,
        stage: line?.stages.find(stage => (!stage.start || row.date >= stage.start) && (!stage.end || row.date <= stage.end))?.name || ""
      };
    });
    // 缺失日仍留空，不补 0。只对真实返回且五渠道齐全的日求和，
    // 并把覆盖日期完整留在中间模型中，供下游区分严格周期与局部覆盖。
    const spendCoverageModel = summarizeSpendCoverage(rows, expected, Boolean(line));
    const spendRows = spendCoverageModel.spendRows;
    const spendMissingDates = spendCoverageModel.missingDates;
    const spendCoverageDays = spendCoverageModel.coverageDays;
    const spendComplete = spendCoverageModel.complete;
    const spendPartial = spendCoverageModel.partial;
    const spendSingleDayPartial = spendCoverageModel.singleDayPartial;
    const spendUsable = spendCoverageModel.usable;
    const totalSpend = spendCoverageModel.spend;
    const channelSpend = spendCoverageModel.channelSpend;
    const spendCoverage = publicSpendCoverage(spendCoverageModel);
    // 覆盖汇总只使用“同一天同时有日 GMV 与五渠道总消耗”的交集。它用于把
    // 平台已经返回的业务值如实展示出来，但绝不回填成完整请求周期的指标。
    // 费比必须按汇总消耗 / 汇总 GMV 计算，不能平均逐日费比。
    const coverageRows = rows.filter(row => Number.isFinite(row.dailyGmv) && Number.isFinite(row.totalSpend));
    const coverageDates = coverageRows.map(row => row.date);
    const coverageDays = coverageRows.length;
    const coverageGmv = coverageDays ? round(coverageRows.reduce((sum, row) => sum + row.dailyGmv, 0)) : null;
    const coverageSpend = coverageDays ? round(coverageRows.reduce((sum, row) => sum + row.totalSpend, 0)) : null;
    const coverageSummary = {
      expectedDays: expected.length,
      coverageDays,
      dates: coverageDates,
      startDate: coverageDates[0] || "",
      endDate: coverageDates.at(-1) || "",
      missingDates: expected.filter(date => !coverageDates.includes(date)),
      gmv: coverageGmv,
      spend: coverageSpend,
      feeRatio: Number.isFinite(coverageSpend) && Number.isFinite(coverageGmv) && coverageGmv !== 0
        ? round(coverageSpend / coverageGmv, 6)
        : null,
      roas: Number.isFinite(coverageSpend) && coverageSpend !== 0 && Number.isFinite(coverageGmv)
        ? round(coverageGmv / coverageSpend, 4)
        : null,
      averageDailyGmv: coverageDays && Number.isFinite(coverageGmv) ? round(coverageGmv / coverageDays) : null,
      averageDailySpend: coverageDays && Number.isFinite(coverageSpend) ? round(coverageSpend / coverageDays) : null,
      complete: Boolean(line && coverageDays === expected.length)
    };
    return {
      rows, expectedDates: expected, missingDates, duplicateDates, missingChannelDates, missingIndexDates, invalidIndexDates, complete, indexSum: gmvFit.indexSum, gmvFit,
      platformGapDates, platformGapDays, platformGapTolerated, coverageDays: rows.length,
      totalSpend, channelSpend, spendCoverageDays, spendExpectedDays: expected.length, spendMissingDates, spendComplete, spendPartial, spendSingleDayPartial, spendUsable,
      spendCoverage,
      coverageSummary
    };
  }

  function enrichPairedDailyWithLine(dailySide, daily, side) {
    const byDate = new Map((daily?.rows || []).map(row => [row.date, row]));
    for (const row of dailySide?.rows || []) {
      const lineRow = byDate.get(row.date);
      const pairedChannels = side === "subject" ? lineRow?.subjectChannelSpend || {} : lineRow?.channelSpend || {};
      row.channelFieldCoverage = Number(side === "subject"
        ? lineRow?.subjectChannelFieldCoverage || 0
        : lineRow?.channelFieldCoverage || 0);
      const lineSpend = side === "subject" ? lineRow?.subjectTotalSpend : lineRow?.totalSpend;
      const exactRowSpend = numberOrNull(row.totalSpend);
      const lineSpendMatches = exactRowSpend == null || !Number.isFinite(lineSpend)
        || Math.abs(exactRowSpend - lineSpend) / Math.max(1, Math.abs(exactRowSpend), Math.abs(lineSpend)) <= 0.01;
      if (row.channelFieldCoverage > 0 && lineSpendMatches) row.channelSpend = { ...pairedChannels };
      else if (row.channelFieldCoverage > 0 && !lineSpendMatches) {
        row.channelFieldCoverage = 0;
        row.channelSpendConflict = true;
      }
      if (!isNumericMetricValue(row.totalSpend) && Number.isFinite(lineSpend)) {
        row.totalSpend = lineSpend;
      }
      const derivedFeeRatio = safeIntervalDivide(row.totalSpend, row.gmv, {
        digits: 6, metric: "费比", compact: true, outward: true
      });
      if ([VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(derivedFeeRatio.state)) {
        row.feeRatio = derivedFeeRatio.value;
      }
      const dailyMetrics = row.metrics || {};
      if (!isNumericMetricValue(dailyMetrics.spend) && isNumericMetricValue(row.totalSpend)) dailyMetrics.spend = row.totalSpend;
      if (isNumericMetricValue(row.feeRatio)) dailyMetrics.feeRatio = row.feeRatio;
      // API 直出的同日付费成交额精确值/区间优先。只有它缺失或仅有
      // 非数值方向时，才允许用同日消耗 × 同日 ROI 数值区间闭合。
      const paidGmvState = metricValueState(dailyMetrics.paidGmv);
      if (![VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(paidGmvState.state)) {
        const derivedPaidGmv = paidGmvFromSpendAndRoi(row.totalSpend, dailyMetrics.roi);
        const derivedPaidGmvState = metricValueState(derivedPaidGmv);
        if ([VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(derivedPaidGmvState.state)) {
          dailyMetrics.paidGmv = derivedPaidGmv;
        }
      }
      // 同日付费成交额和消耗已落实时，ROI 必须由两者相除，覆盖接口旧值或方向文案。
      const derivedRoi = returnOnSpend(dailyMetrics.paidGmv, row.totalSpend);
      const derivedRoiState = metricValueState(derivedRoi);
      if ([VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(derivedRoiState.state)) {
        dailyMetrics.roi = derivedRoi;
      }
      // `clickCost` may disclose only a relative direction (for example
      // “比本品高”), while the same exact-day supplement discloses a bounded
      // click interval. A direction is truthful but not a numeric PPC value.
      // 同日消耗和营销点击量已落实时，PPC 同样强制按反向端点相除。
      const derivedPpc = costPerClick(row.totalSpend, dailyMetrics.marketingClicks);
      const derivedPpcState = metricValueState(derivedPpc);
      if ([VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(derivedPpcState.state)) {
        dailyMetrics.ppc = derivedPpc;
      }
      row.metrics = dailyMetrics;
    }
    const expectedDates = Array.isArray(dailySide?.expectedDates) && dailySide.expectedDates.length
      ? dailySide.expectedDates
      : (daily?.expectedDates || []);
    const coverageModel = summarizeSpendCoverage(dailySide?.rows || [], expectedDates, Boolean(dailySide?.rows?.length));
    dailySide.totalSpend = coverageModel.spend;
    dailySide.channelSpend = coverageModel.channelSpend;
    dailySide.spendCoverageDays = coverageModel.coverageDays;
    dailySide.spendExpectedDays = coverageModel.expectedDays;
    dailySide.spendMissingDates = coverageModel.missingDates;
    dailySide.spendComplete = coverageModel.complete;
    dailySide.spendPartial = coverageModel.partial;
    dailySide.spendSingleDayPartial = coverageModel.singleDayPartial;
    dailySide.spendUsable = coverageModel.usable;
    dailySide.spendCoverage = publicSpendCoverage(coverageModel);
    return dailySide;
  }

  function resolvePairedDailyDirections(subjectDaily, competitorDaily) {
    const subjectByDate = new Map((subjectDaily?.rows || []).map(row => [row.date, row]));
    const competitorByDate = new Map((competitorDaily?.rows || []).map(row => [row.date, row]));
    const descriptors = [
      { key: "paidGmv", get: row => row?.metrics?.paidGmv, set: (row, value) => { (row.metrics || (row.metrics = {})).paidGmv = value; } },
      { key: "spend", get: row => row?.totalSpend ?? row?.metrics?.spend, set: (row, value) => { row.totalSpend = value; (row.metrics || (row.metrics = {})).spend = value; } },
      { key: "roi", get: row => row?.metrics?.roi, set: (row, value) => { (row.metrics || (row.metrics = {})).roi = value; } },
      { key: "ppc", get: row => row?.metrics?.ppc, set: (row, value) => { (row.metrics || (row.metrics = {})).ppc = value; } },
      { key: "feeRatio", get: row => row?.feeRatio ?? row?.metrics?.feeRatio, set: (row, value) => { row.feeRatio = value; (row.metrics || (row.metrics = {})).feeRatio = value; } },
      { key: "marketingClicks", get: row => row?.metrics?.marketingClicks, set: (row, value) => { (row.metrics || (row.metrics = {})).marketingClicks = value; } }
    ];
    for (const date of new Set([...subjectByDate.keys(), ...competitorByDate.keys()])) {
      const rows = { subject: subjectByDate.get(date), competitor: competitorByDate.get(date) };
      if (!rows.subject || !rows.competitor) continue;
      for (const descriptor of descriptors) {
        if (["roi", "ppc", "feeRatio"].includes(descriptor.key)) continue;
        for (const side of ["subject", "competitor"]) {
          const referenceSide = side === "subject" ? "competitor" : "subject";
          const value = descriptor.get(rows[side]);
          if (isNumericMetricValue(value)) continue;
          const bound = resolveDirectionalBound(value, descriptor.get(rows[referenceSide]), side);
          if (bound) descriptor.set(rows[side], bound);
        }
      }
    }
    return { subject: subjectDaily, competitor: competitorDaily };
  }

  function dailyMetricNotApplicable(metrics, key) {
    const spend = numberOrNull(metrics?.spend);
    const paidGmv = numberOrNull(metrics?.paidGmv);
    const clicks = numberOrNull(metrics?.marketingClicks);
    if (key === "roi") return spend === 0 && (paidGmv === 0 || paidGmv == null);
    if (key === "ppc") return spend === 0 && clicks === 0;
    return false;
  }

  function missingPairedDailyMetricDates(dailySide, key) {
    const byDate = new Map((dailySide?.rows || []).map(row => [row.date, row]));
    return (dailySide?.expectedDates || []).filter(date => {
      const metrics = byDate.get(date)?.metrics;
      const state = metricValueState(metrics?.[key]);
      const numericResolved = [VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(state.state);
      const resolved = ["paidGmv", "roi", "ppc"].includes(key)
        ? numericResolved
        : isDisclosedMetric(metrics?.[key]);
      return !resolved && !dailyMetricNotApplicable(metrics, key);
    });
  }

  function sceneScalar(value, depth = 0) {
    if (value == null || depth > 4) return value ?? null;
    if (typeof value !== "object" || Array.isArray(value)) return value;
    for (const key of ["indicatorValue", "periodValue", "displayValue", "indexValue", "value", "text"]) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const nested = sceneScalar(value[key], depth + 1);
      if (nested !== null && nested !== undefined && nested !== "") return nested;
    }
    return null;
  }

  function sceneMetric(row, key, side) {
    const raw = sceneScalar(valueFromPair(row?.[key], side));
    const numeric = numberOrNull(raw);
    return numeric == null ? (raw ?? "") : numeric;
  }

  function ratioOrNull(value) {
    const ratio = numberOrNull(value);
    return Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : null;
  }

  function preferExactMetric(apiValue, calculatedValue) {
    const exact = numberOrNull(apiValue);
    if (exact != null) return exact;
    return calculatedValue ?? apiValue;
  }

  function metricValuePrecision(value) {
    if (!isDisclosedMetric(value)) return 0;
    if (numberOrNull(value) != null) return 3;
    const range = parseVagueRange(value);
    if (range) return range.exact ? 3 : 2;
    return 1;
  }

  // 同一指标在多个模板或同义行里同时披露时，精确值必须胜过
  // 脱敏区间；同等精度保留已选值，以继续遵循“最新卡片优先”。
  function preferredMetricValue(currentValue, candidateValue) {
    return metricValuePrecision(candidateValue) > metricValuePrecision(currentValue)
      ? candidateValue
      : currentValue;
  }

  function isDisclosedMetric(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === "string" && /^(?:|[-–—]|--|暂无|无数据|null|undefined)$/i.test(value.trim())) return false;
    return true;
  }

  function coreMetricValue(metrics, definition) {
    for (const key of definition.sourceKeys || [definition.key]) {
      if (isDisclosedMetric(metrics?.[key])) return metrics[key];
    }
    return null;
  }

  function validZeroDenominatorNa(key, metrics) {
    const spend = numberOrNull(metrics?.spend);
    const totalGmv = numberOrNull(metrics?.totalGmv);
    const paidGmv = numberOrNull(metrics?.paidGmv);
    const clicks = numberOrNull(metrics?.marketingClicks);
    if (key === "roi" || key === "globalROAS") return spend === 0 && (key !== "roi" || paidGmv === 0 || paidGmv == null);
    if (key === "ppc") return clicks === 0 && spend === 0;
    if (key === "feeRatio") return totalGmv === 0 && spend === 0;
    if (key === "paidGmvContribution") return totalGmv === 0 && paidGmv === 0;
    return false;
  }

  function coreMetricMissingReason(key, metrics) {
    const missing = label => !isDisclosedMetric(metrics?.[label]);
    if (key === "totalGmv") return "未返回总GMV，且成交笔数/笔单价不足以按同周期计算";
    if (key === "paidGmv") return "未返回付费成交额，且同周期推广场景直接成交金额不足以汇总";
    if (key === "spend") return "未返回同对象、同周期推广消耗";
    if (key === "feeRatio") return `${missing("spend") ? "推广消耗" : "总GMV"}缺失或分母无效，无法计算费比`;
    if (key === "roi") return `${missing("paidGmv") ? "付费成交额" : "推广消耗"}缺失或分母无效，无法计算ROI`;
    if (key === "ppc") return `${missing("marketingClicks") ? "付费点击量" : "推广消耗"}缺失或点击量分母无效，无法计算PPC`;
    if (key === "paidGmvContribution") return `${missing("paidGmv") ? "付费成交额" : "总GMV"}缺失或分母无效，无法计算付费金额占比`;
    if (key === "globalROAS") return `${missing("totalGmv") ? "总GMV" : "推广消耗"}缺失或分母无效，无法计算全域ROAS`;
    return "源字段缺失";
  }

  const CONTRACT_DEPENDENCIES = Object.freeze({
    feeRatio: Object.freeze(["spend", "totalGmv"]),
    roi: Object.freeze(["paidGmv", "spend"]),
    ppc: Object.freeze(["spend", "marketingClicks"]),
    paidGmvContribution: Object.freeze(["paidGmv", "totalGmv"]),
    globalROAS: Object.freeze(["totalGmv", "spend"])
  });

  function promotionDetailsContract(metrics, sceneRows, side) {
    const spendState = metricValueState(metrics?.spend);
    const spendRange = spendState.range;
    if (spendState.state === VALUE_STATES.EXACT && spendRange?.min === 0) {
      return { state: VALUE_STATES.NA, value: null, resolved: true, required: false, reason: "推广消耗为0，不要求推广详情", missingFields: [] };
    }
    const mayHaveSpend = spendRange && ((Number.isFinite(spendRange.max) && spendRange.max > 0) || (Number.isFinite(spendRange.min) && spendRange.min > 0));
    if (!mayHaveSpend) {
      return { state: VALUE_STATES.MISSING, value: null, resolved: false, required: false, reason: "推广消耗未落实，无法判断推广详情条件", missingFields: [] };
    }
    const role = side === "subject" ? "主体" : "对手";
    const rows = (sceneRows?.level1 || []).filter(row => row.role === role);
    if (!rows.length) {
      return { state: VALUE_STATES.MISSING, value: null, resolved: false, required: true, reason: `${role}推广消耗大于0，但一级推广详情为空`, missingFields: ["一级推广详情"] };
    }
    const requiredFields = [
      ["allocated", "场景消耗"], ["impression", "展现"], ["click", "点击"],
      ["cpc", "PPC"], ["directDealAmount", "付费成交额"], ["directRoi", "ROI"]
    ];
    const relevantRows = rows.filter(row => {
      const allocation = parseVagueRange(row.allocated ?? row.charge);
      return allocation && ((Number.isFinite(allocation.max) && allocation.max > 0) || (Number.isFinite(allocation.min) && allocation.min > 0));
    });
    if (!relevantRows.length) {
      return { state: VALUE_STATES.MISSING, value: null, resolved: false, required: true, reason: `${role}推广消耗大于0，但场景花费无法对齐`, missingFields: ["场景消耗"] };
    }
    const missingFields = [];
    for (const row of relevantRows) {
      const missing = requiredFields.filter(([key]) => !isDisclosedMetric(row[key])).map(([, label]) => label);
      if (missing.length) missingFields.push(`${row.primary || `场景${row.sceneId || "未知"}`}：${missing.join("、")}`);
    }
    if (missingFields.length) {
      return { state: VALUE_STATES.MISSING, value: null, resolved: false, required: true, reason: `${role}推广详情字段不完整`, missingFields };
    }
    return { state: VALUE_STATES.EXACT, value: relevantRows.length, resolved: true, required: true, reason: "", missingFields: [] };
  }

  function evaluateCoreMetricContract(metricsBySide = {}, options = {}) {
    const sideLabels = { subject: "主体", competitor: "对手" };
    const sides = {};
    const missing = [];
    let resolvedValues = 0;
    for (const side of ["subject", "competitor"]) {
      const metrics = metricsBySide?.[side] || {};
      const expectedContext = options.contexts?.[side]?.expected || null;
      const valueContexts = options.contexts?.[side]?.values || metrics.valueContexts || {};
      const entries = [];
      for (const definition of CORE_METRIC_CONTRACT) {
        const raw = coreMetricValue(metrics, definition);
        let semantic = metricValueState(raw, { reason: coreMetricMissingReason(definition.key, metrics) });
        const explicitConflict = (definition.sourceKeys || [definition.key])
          .map(key => metrics.valueConflicts?.[key])
          .find(Boolean);
        if (explicitConflict) semantic = { state: VALUE_STATES.CONFLICT, value: null, range: null, reason: String(explicitConflict) };
        if (semantic.state === VALUE_STATES.MISSING && validZeroDenominatorNa(definition.key, metrics)) {
          semantic = { state: VALUE_STATES.NA, value: null, range: null, reason: "分母明确为0，该指标不适用" };
        }
        const ownContext = valueContexts[definition.key]
          || valueContexts[(definition.sourceKeys || []).find(key => valueContexts[key])];
        const expectedMismatch = metricContextMismatch(ownContext, expectedContext);
        if (expectedMismatch && [VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(semantic.state)) {
          semantic = { state: VALUE_STATES.CONFLICT, value: null, range: null, reason: expectedMismatch };
        }
        for (const dependency of CONTRACT_DEPENDENCIES[definition.key] || []) {
          const dependencyMismatch = metricContextMismatch(ownContext || expectedContext, valueContexts[dependency] || expectedContext);
          if (dependencyMismatch && [VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(semantic.state)) {
            semantic = { state: VALUE_STATES.CONFLICT, value: null, range: null, reason: `${dependency}与${definition.key}${dependencyMismatch}` };
            break;
          }
        }
        const resolved = [VALUE_STATES.EXACT, VALUE_STATES.INTERVAL, VALUE_STATES.NA].includes(semantic.state);
        if (resolved) resolvedValues += 1;
        else missing.push({ side, key: definition.key, label: `${sideLabels[side]}${definition.label}`, state: semantic.state, reason: semantic.reason });
        entries.push({ key: definition.key, label: definition.label, raw, ...semantic, resolved });
      }
      const promotionDetails = promotionDetailsContract(metrics, options.sceneRows, side);
      if (promotionDetails.required && !promotionDetails.resolved) {
        missing.push({ side, key: "promotionDetails", label: `${sideLabels[side]}推广详情`, state: promotionDetails.state, reason: `${promotionDetails.reason}${promotionDetails.missingFields.length ? `：${promotionDetails.missingFields.join("；")}` : ""}` });
      }
      sides[side] = { role: sideLabels[side], entries, promotionDetails };
    }
    const requiredValues = CORE_METRIC_CONTRACT.length * 2;
    return {
      status: missing.length ? "partial" : "complete",
      complete: missing.length === 0,
      requiredValues,
      resolvedValues,
      missing,
      missingReasons: Object.fromEntries(missing.map(entry => [entry.label, { state: entry.state, reason: entry.reason }])),
      sides
    };
  }

  function missingSubjectMinimumPromotionMetrics(metrics = {}) {
    const spend = numberOrNull(metrics.spend);
    const paidClicks = numberOrNull(metrics.marketingClicks);
    return SUBJECT_MINIMUM_PROMOTION_CONTRACT.filter(metric => {
      if (isDisclosedMetric(metrics[metric.key])) return false;
      // 零花费时 ROI 没有合法分母；零花费且付费点击也明确为 0 时 PPC 同理。
      // 只有“明确为 0”才适用豁免，null/空串绝不能伪装成 0。
      if (metric.key === "roi" && spend === 0) return false;
      if (metric.key === "ppc" && spend === 0 && paidClicks === 0) return false;
      return true;
    });
  }

  function allocationTolerance(base) {
    return Math.max(0.05, Math.abs(base) * 0.000001);
  }

  const SCENE_CLOSURE_FIELDS = Object.freeze([
    "charge", "ratio", "impression", "click", "ctr", "cpc", "directDealAmount", "directRoi"
  ]);

  // 达摩盘会把未投放的同级场景返回为空，而不是显式 0。只有实际披露的场景
  // 同时给出精确花费、精确占比，占比闭合到 100%，且花费份额与占比一致时，
  // 才能把这些稀疏行合成周期总花费。空兄弟行被保留为空；任何有业务活动但
  // 缺花费/占比的行都会进入闭合校验并使聚合失败，绝不把缺失当作 0。
  function closedSceneAllocation(rows, valueFor = (row, key) => row?.[key], expectedTotal = null) {
    const disclosedRows = (rows || []).filter(row => SCENE_CLOSURE_FIELDS
      .some(key => isDisclosedMetric(valueFor(row, key))));
    if (!disclosedRows.length) return { complete: false, spend: null, rows: [] };
    const charges = disclosedRows.map(row => numberOrNull(valueFor(row, "charge")));
    const ratios = disclosedRows.map(row => ratioOrNull(valueFor(row, "ratio")));
    if (!charges.every(value => Number.isFinite(value) && value >= 0) || !ratios.every(Number.isFinite)) {
      return { complete: false, spend: null, rows: disclosedRows };
    }
    const expected = numberOrNull(expectedTotal);
    if (charges.every(value => value === 0) && ratios.every(value => value === 0)) {
      return expected == null || expected === 0
        ? { complete: true, spend: 0, rows: disclosedRows }
        : { complete: false, spend: null, rows: disclosedRows };
    }
    const ratioSum = ratios.reduce((sum, value) => sum + value, 0);
    if (Math.abs(ratioSum - 1) > 0.000001) {
      return { complete: false, spend: null, rows: disclosedRows };
    }
    const summedSpend = round(charges.reduce((sum, value) => sum + value, 0));
    const total = expected ?? summedSpend;
    if (!(total > 0) || Math.abs(summedSpend - total) > allocationTolerance(total)) {
      return { complete: false, spend: null, rows: disclosedRows };
    }
    const sharesAlign = charges.every((charge, index) => Math.abs(charge / total - ratios[index]) <= 0.00005);
    return sharesAlign
      ? { complete: true, spend: round(total), rows: disclosedRows }
      : { complete: false, spend: null, rows: disclosedRows };
  }

  function rawSceneAllocation(rows, side) {
    return closedSceneAllocation(rows, (row, key) => sceneMetric(row, key === "ratio" ? "chargeRatio" : key, side));
  }

  function buildSceneRows(responses, totalSpends = {}) {
    const level1Response = responses.find(response => response.level === 1) || null;
    const parentNames = new Map((level1Response?.rows || []).map(row => [String(row.sceneId || ""), row.sceneName]));
    const subjectSceneAllocation = rawSceneAllocation(level1Response?.rows || [], "subject");
    const competitorSceneAllocation = rawSceneAllocation(level1Response?.rows || [], "competitor");
    const sceneSubjectSpend = subjectSceneAllocation.spend;
    const passed = typeof totalSpends === "number" ? { competitor: totalSpends } : (totalSpends || {});
    const totals = {
      subject: numberOrNull(passed.subject) ?? sceneSubjectSpend,
      competitor: numberOrNull(passed.competitor)
    };
    const parentSpend = new Map();
    const result = {
      level1: [], level2: [], validationIssues: [], allocationTotals: { ...totals },
      exactSceneSpend: { subject: subjectSceneAllocation.spend, competitor: competitorSceneAllocation.spend },
      closedSceneRows: { subject: [], competitor: [] }
    };

    function buildRow(response, row, side) {
      const role = side === "subject" ? "主体" : "对手";
      const primary = response.level === 1 ? row.sceneName : (parentNames.get(String(response.parentSceneId)) || SCENE_CODES[String(response.parentSceneId)] || `场景${response.parentSceneId}`);
      const secondary = response.level === 2 ? String(row.sceneName || "").replace(new RegExp(`^${primary}-?`), "") : "";
      const charge = sceneMetric(row, "charge", side);
      const ratioValue = sceneMetric(row, "chargeRatio", side);
      const ratio = ratioOrNull(ratioValue);
      let allocated = numberOrNull(charge);
      if (allocated == null && ratio != null) {
        const base = response.level === 1
          ? totals[side]
          : parentSpend.get(`${side}|${String(response.parentSceneId || "")}`);
        if (Number.isFinite(base)) allocated = round(base * ratio);
      }
      const impression = sceneMetric(row, "impression", side);
      const click = sceneMetric(row, "click", side);
      const apiDirectDealAmount = sceneMetric(row, "directDealAmount", side);
      const apiCtr = sceneMetric(row, "ctr", side);
      const apiCpc = sceneMetric(row, "cpc", side);
      const apiDirectRoi = sceneMetric(row, "directRoi", side);
      const calculatedCpc = Number.isFinite(allocated) ? costPerClick(allocated, click) : null;
      const calculatedCtr = safeIntervalDivide(click, impression, {
        digits: 6, metric: "CTR", compact: true, outward: true
      }).value;
      const calculatedDirectDealAmount = Number.isFinite(allocated)
        ? safeIntervalMultiply(allocated, apiDirectRoi, {
            digits: 2, metric: "直接成交金额", outward: true
          }).value
        : null;
      const directDealAmount = preferExactMetric(apiDirectDealAmount, calculatedDirectDealAmount);
      const calculatedDirectRoi = Number.isFinite(allocated) && isNumericMetricValue(apiDirectDealAmount)
        ? returnOnSpend(apiDirectDealAmount, allocated)
        : null;
      const values = {
        role, level: response.level, primary, secondary, sceneId: row.sceneId,
        parentSceneId: response.parentSceneId || "",
        charge, ratio: ratioValue, allocated,
        impression, click,
        ctr: preferExactMetric(apiCtr, calculatedCtr),
        cpc: isNumericMetricValue(calculatedCpc) ? calculatedCpc : preferExactMetric(apiCpc, calculatedCpc),
        directDealAmount,
        directRoi: isNumericMetricValue(calculatedDirectRoi) ? calculatedDirectRoi : preferExactMetric(apiDirectRoi, calculatedDirectRoi)
      };
      if (response.level === 1 && Number.isFinite(allocated)) {
        parentSpend.set(`${side}|${String(row.sceneId || "")}`, allocated);
      }
      if (ratioValue !== "" && ratioValue != null && ratio == null) {
        result.validationIssues.push(`${role}${primary}${secondary ? `/${secondary}` : ""}的消耗占比无效`);
      }
      if (isDisclosedMetric(click) && !parseVagueRange(click) && !parseDirectionalComparison(click)) {
        result.validationIssues.push(`${role}${primary}${secondary ? `/${secondary}` : ""}的点击量区间无效`);
      }
      if (isDisclosedMetric(directDealAmount) && !parseVagueRange(directDealAmount) && !parseDirectionalComparison(directDealAmount)) {
        result.validationIssues.push(`${role}${primary}${secondary ? `/${secondary}` : ""}的直接成交金额区间无效`);
      }
      if (ratio != null && Number.isFinite(response.level === 1 ? totals[side] : parentSpend.get(`${side}|${String(response.parentSceneId || "")}`)) && !Number.isFinite(allocated)) {
        result.validationIssues.push(`${role}${primary}${secondary ? `/${secondary}` : ""}的场景花费未能分配`);
      }
      if (Number.isFinite(allocated) && parseVagueRange(click) && costPerClick(allocated, click) != null && values.cpc == null) {
        result.validationIssues.push(`${role}${primary}${secondary ? `/${secondary}` : ""}的 CPC 未能计算`);
      }
      if (Number.isFinite(allocated) && allocated > 0 && parseVagueRange(directDealAmount) && returnOnSpend(directDealAmount, allocated) != null && values.directRoi == null) {
        result.validationIssues.push(`${role}${primary}${secondary ? `/${secondary}` : ""}的直接 ROI 未能计算`);
      }
      return values;
    }

    const hasSceneData = values => [values.charge, values.ratio, values.impression, values.click, values.ctr, values.cpc, values.directDealAmount, values.directRoi]
      .some(isDisclosedMetric);
    const appendPairs = (responsesForLevel, target) => {
      for (const response of responsesForLevel) {
        for (const row of response.rows) {
          const pair = [buildRow(response, row, "subject"), buildRow(response, row, "competitor")];
          for (const key of ["charge", "ratio", "allocated", "impression", "click", "ctr", "cpc", "directDealAmount", "directRoi"]) {
            for (const [index, side] of [[0, "subject"], [1, "competitor"]]) {
              if (isNumericMetricValue(pair[index][key])) continue;
              const bound = resolveDirectionalBound(pair[index][key], pair[1 - index][key], side);
              if (bound) pair[index][key] = bound;
            }
          }
          if (pair.some(hasSceneData)) target.push(...pair);
        }
      }
    };
    appendPairs(responses.filter(value => value.level === 1), result.level1);
    appendPairs(responses.filter(value => value.level === 2), result.level2);
    for (const side of ["subject", "competitor"]) {
      const role = side === "subject" ? "主体" : "对手";
      const rows = result.level1.filter(row => row.role === role);
      const closure = closedSceneAllocation(
        rows,
        (row, key) => key === "charge" ? row.allocated : row[key],
        totals[side]
      );
      result.closedSceneRows[side] = closure.complete ? closure.rows : [];
    }
    const closureGroups = new Map();
    for (const row of [...result.level1, ...result.level2]) {
      const key = row.level === 1 ? `${row.role}|1` : `${row.role}|2|${row.parentSceneId}`;
      const group = closureGroups.get(key) || [];
      group.push(row);
      closureGroups.set(key, group);
    }
    for (const rows of closureGroups.values()) {
      if (!rows.length) continue;
      const sample = rows[0];
      const side = sample.role === "主体" ? "subject" : "competitor";
      const base = sample.level === 1 ? totals[side] : parentSpend.get(`${side}|${String(sample.parentSceneId || "")}`);
      const ratios = rows.map(row => ratioOrNull(row.ratio));
      if (ratios.every(Number.isFinite)) {
        const ratioSum = ratios.reduce((sum, value) => sum + value, 0);
        if (Math.abs(ratioSum - 1) > 0.01) {
          result.validationIssues.push(`${sample.role}${sample.level === 1 ? "一级场景" : `${sample.primary}二级场景`}消耗占比合计为 ${(ratioSum * 100).toFixed(2)}%，未闭合到 100%`);
        }
      }
      const allocations = rows.map(row => numberOrNull(row.allocated));
      if (Number.isFinite(base) && allocations.every(Number.isFinite)) {
        const allocatedSum = round(allocations.reduce((sum, value) => sum + value, 0));
        if (Math.abs(allocatedSum - base) > allocationTolerance(base)) {
          result.validationIssues.push(`${sample.role}${sample.level === 1 ? "一级场景" : `${sample.primary}二级场景`}分配花费 ${allocatedSum}与基数 ${round(base)} 不闭合`);
        }
      }
    }
    result.validationIssues = [...new Set(result.validationIssues)];
    return result;
  }

  function sumFinite(values) {
    return values.length && values.every(Number.isFinite) ? round(values.reduce((sum, value) => sum + value, 0)) : null;
  }

  function calculationResultContext(valueContexts, sourceKeys, expectedContext) {
    return sourceKeys.map(key => valueContexts?.[key]).find(Boolean) || expectedContext || null;
  }

  function applyCalculatedMetric(current, key, result, valueContexts, sourceKeys, expectedContext) {
    if (isNumericMetricValue(current[key])) return false;
    if ([VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(result?.state)) {
      current[key] = result.value;
      valueContexts[key] = calculationResultContext(valueContexts, sourceKeys, expectedContext);
      if (current.valueConflicts) delete current.valueConflicts[key];
      return true;
    }
    if (result?.state === VALUE_STATES.CONFLICT) {
      current.valueConflicts = current.valueConflicts || {};
      current.valueConflicts[key] = result.reason;
    }
    return false;
  }

  function intervalDivideResult(current, numeratorKey, denominatorKey, options = {}) {
    const valueContexts = current.valueContexts || {};
    return safeIntervalDivide(current[numeratorKey], current[denominatorKey], {
      ...options,
      numeratorContext: valueContexts[numeratorKey],
      denominatorContext: valueContexts[denominatorKey]
    });
  }

  function intervalMultiplyResult(current, leftKey, rightKey, options = {}) {
    const valueContexts = current.valueContexts || {};
    return safeIntervalMultiply(current[leftKey], current[rightKey], {
      ...options,
      leftContext: valueContexts[leftKey],
      rightContext: valueContexts[rightKey]
    });
  }

  const CANONICAL_EFFICIENCY_FORMULAS = Object.freeze([
    Object.freeze({ key: "roi", numeratorKey: "paidGmv", denominatorKey: "spend", digits: 2, metric: "ROI", compact: false }),
    Object.freeze({ key: "ppc", numeratorKey: "spend", denominatorKey: "marketingClicks", digits: 2, metric: "PPC", compact: false }),
    Object.freeze({ key: "feeRatio", numeratorKey: "spend", denominatorKey: "totalGmv", digits: 6, metric: "费比", compact: true })
  ]);

  // ROI、PPC、费比不是“缺失时才补”的展示字段。只要同一对象、同一期间、
  // 同一覆盖口径的分子和分母已经落实为具体值或合法区间，就必须以恒等式结果
  // 作为最终业务值，覆盖接口中的旧数值、脱敏区间或“比本品高/低”文案。
  function applyCanonicalEfficiencyMetrics(current, expectedContext = null) {
    if (!current) return current;
    const valueContexts = current.valueContexts || (current.valueContexts = {});
    const resolved = current.canonicalEfficiencyMetrics || (current.canonicalEfficiencyMetrics = {});
    current.valueConflicts = current.valueConflicts || {};
    for (const definition of CANONICAL_EFFICIENCY_FORMULAS) {
      const periodDirect = current.periodDirectMetrics?.[definition.key];
      if (isNumericMetricValue(periodDirect)) {
        current[definition.key] = periodDirect;
        valueContexts[definition.key] = valueContexts[definition.key] || expectedContext;
        delete resolved[definition.key];
        delete current.valueConflicts[definition.key];
        continue;
      }
      const numeratorState = metricValueState(current[definition.numeratorKey]);
      const denominatorState = metricValueState(current[definition.denominatorKey]);
      const numericStates = [VALUE_STATES.EXACT, VALUE_STATES.INTERVAL];
      if (!numericStates.includes(numeratorState.state) || !numericStates.includes(denominatorState.state)) continue;
      const result = safeIntervalDivide(current[definition.numeratorKey], current[definition.denominatorKey], {
        digits: definition.digits,
        metric: definition.metric,
        compact: definition.compact,
        outward: true,
        numeratorContext: valueContexts[definition.numeratorKey],
        denominatorContext: valueContexts[definition.denominatorKey]
      });
      if (numericStates.includes(result.state)) {
        current[definition.key] = result.value;
        valueContexts[definition.key] = calculationResultContext(
          valueContexts,
          [definition.numeratorKey, definition.denominatorKey],
          expectedContext
        );
        resolved[definition.key] = {
          formula: `${definition.numeratorKey}/${definition.denominatorKey}`,
          numeratorKey: definition.numeratorKey,
          denominatorKey: definition.denominatorKey
        };
        delete current.valueConflicts[definition.key];
        continue;
      }
      current[definition.key] = null;
      delete resolved[definition.key];
      current.valueConflicts[definition.key] = result.reason || `${definition.metric}分母无效`;
    }
    return current;
  }

  function chooseCompatibleCalculation(current, key, candidates, expectedContext) {
    if (isNumericMetricValue(current[key])) return false;
    const numeric = candidates.filter(candidate => [VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(candidate.result?.state));
    if (!numeric.length) {
      const conflict = candidates.find(candidate => candidate.result?.state === VALUE_STATES.CONFLICT);
      if (conflict) {
        current.valueConflicts = current.valueConflicts || {};
        current.valueConflicts[key] = conflict.result.reason;
      }
      return false;
    }
    const compatible = numeric.every((left, index) => numeric.slice(index + 1)
      .every(right => metricRangesCompatible(left.result.value, right.result.value)));
    if (!compatible) {
      current.valueConflicts = current.valueConflicts || {};
      current.valueConflicts[key] = `${key}的同周期恒等式结果不在1%内闭合`;
      return false;
    }
    const selected = numeric[0];
    return applyCalculatedMetric(
      current, key, selected.result, current.valueContexts,
      selected.sourceKeys, expectedContext
    );
  }

  // 对周期模型执行有限次恒等式闭包。只把 exact/interval 当作数值种子；
  // 方向文字既不会阻断计算，也不会参与乘除。所有区间都按端点外扩，绝不取中点。
  function closePeriodMetricSet(current, expectedContext = null) {
    if (!current) return current;
    const valueContexts = current.valueContexts || (current.valueContexts = {});
    current.valueConflicts = current.valueConflicts || {};
    for (let pass = 0; pass < 6; pass += 1) {
      let changed = false;
      const multiply = (key, leftKey, rightKey, digits, metric, compact = false) => {
        const result = intervalMultiplyResult(current, leftKey, rightKey, { digits, metric, compact, outward: true });
        changed = applyCalculatedMetric(current, key, result, valueContexts, [leftKey, rightKey], expectedContext) || changed;
      };
      const divide = (key, numeratorKey, denominatorKey, digits, metric, compact = false) => {
        const result = intervalDivideResult(current, numeratorKey, denominatorKey, { digits, metric, compact, outward: true });
        changed = applyCalculatedMetric(current, key, result, valueContexts, [numeratorKey, denominatorKey], expectedContext) || changed;
      };

      multiply("totalGmv", "orders", "aov", 2, "总GMV");
      divide("orders", "totalGmv", "aov", 2, "成交笔数");
      divide("aov", "totalGmv", "orders", 2, "笔单价");
      if (isDisclosedMetric(current.visitors) || current.visitorClosed) {
        divide("visitors", "orders", "conversion", 2, "访客数");
      }
      multiply("orders", "visitors", "conversion", 2, "成交笔数");
      divide("conversion", "orders", "visitors", 6, "支付转化率", true);

      changed = chooseCompatibleCalculation(current, "spend", [
        { result: intervalDivideResult(current, "paidGmv", "roi", { digits: 2, metric: "推广消耗", outward: true }), sourceKeys: ["paidGmv", "roi"] },
        { result: intervalMultiplyResult(current, "marketingClicks", "ppc", { digits: 2, metric: "推广消耗", outward: true }), sourceKeys: ["marketingClicks", "ppc"] },
        { result: intervalMultiplyResult(current, "totalGmv", "feeRatio", { digits: 2, metric: "推广消耗", outward: true }), sourceKeys: ["totalGmv", "feeRatio"] },
        { result: intervalDivideResult(current, "totalGmv", "roas", { digits: 2, metric: "推广消耗", outward: true }), sourceKeys: ["totalGmv", "roas"] }
      ], expectedContext) || changed;

      changed = chooseCompatibleCalculation(current, "paidGmv", [
        { result: intervalMultiplyResult(current, "spend", "roi", { digits: 2, metric: "付费成交额", outward: true }), sourceKeys: ["spend", "roi"] },
        { result: intervalMultiplyResult(current, "totalGmv", "paidGmvContribution", { digits: 2, metric: "付费成交额", outward: true }), sourceKeys: ["totalGmv", "paidGmvContribution"] }
      ], expectedContext) || changed;

      divide("marketingClicks", "spend", "ppc", 2, "营销推广点击量");
      divide("roi", "paidGmv", "spend", 2, "ROI");
      divide("ppc", "spend", "marketingClicks", 2, "PPC");
      divide("feeRatio", "spend", "totalGmv", 6, "费比", true);
      divide("roas", "totalGmv", "spend", 4, "全域ROAS", true);
      divide("paidGmvContribution", "paidGmv", "totalGmv", 6, "付费金额占比", true);
      divide("paidOrderContribution", "paidOrders", "orders", 6, "广告订单贡献率", true);
      multiply("paidOrders", "orders", "paidOrderContribution", 2, "付费成交笔数");

      if (!changed) break;
    }
    current.attributedGmv = isNumericMetricValue(current.paidGmv) ? current.paidGmv : current.attributedGmv;
    current.paidAmountShare = current.paidGmvContribution;
    current.globalROAS = current.roas;
    if (valueContexts.paidGmv) valueContexts.attributedGmv = valueContexts.paidGmv;
    if (valueContexts.paidGmvContribution) valueContexts.paidAmountShare = valueContexts.paidGmvContribution;
    if (valueContexts.roas) valueContexts.globalROAS = valueContexts.roas;
    return current;
  }

  function comparisonContextMismatch(left, right) {
    if (!left || !right) return "";
    const withoutEntity = value => ({
      startDate: value.startDate,
      endDate: value.endDate,
      coverageDays: value.coverageDays,
      periodKey: value.periodKey
    });
    return metricContextMismatch(withoutEntity(left), withoutEntity(right));
  }

  function resolveMetricPairDirections(metrics) {
    if (!metrics?.subject || !metrics?.competitor) return metrics;
    const keys = new Set([
      ...METRIC_ALIAS_GROUPS.map(group => group.key),
      "totalGmv", "paidGmv", "paidOrders", "spend", "feeRatio", "roi", "ppc", "roas",
      "paidGmvContribution", "paidOrderContribution", "globalROAS", "paidAmountShare"
    ]);
    for (const key of keys) {
      if (["roi", "ppc", "feeRatio"].includes(key)) continue;
      for (const side of ["subject", "competitor"]) {
        if (isNumericMetricValue(metrics[side][key])) continue;
        const referenceSide = side === "subject" ? "competitor" : "subject";
        const direction = parseDirectionalComparison(metrics[side][key]);
        if (!direction || direction.referenceSide !== referenceSide || !isNumericMetricValue(metrics[referenceSide][key])) continue;
        const targetContext = metrics[side].valueContexts?.[key] || metrics[side].expectedContext;
        const referenceContext = metrics[referenceSide].valueContexts?.[key] || metrics[referenceSide].expectedContext;
        if (comparisonContextMismatch(targetContext, referenceContext)) continue;
        const bound = resolveDirectionalBound(metrics[side][key], metrics[referenceSide][key], side);
        if (!bound) continue;
        metrics[side][key] = bound;
        metrics[side].valueContexts[key] = targetContext || metrics[side].expectedContext || null;
      }
    }
    for (const aligned of metrics.aligned || []) {
      const modelKey = aligned.key === "paidAmountShare" ? "paidGmvContribution" : aligned.key;
      for (const side of ["subject", "competitor"]) {
        if (isNumericMetricValue(metrics[side]?.[modelKey])) aligned[side] = metrics[side][modelKey];
      }
      if (["roi", "ppc", "feeRatio"].includes(modelKey)) continue;
      for (const side of ["subject", "competitor"]) {
        if (isNumericMetricValue(aligned[side])) continue;
        const referenceSide = side === "subject" ? "competitor" : "subject";
        const bound = resolveDirectionalBound(aligned[side], aligned[referenceSide], side);
        if (bound) aligned[side] = bound;
      }
    }
    return metrics;
  }

  function captureDirectionalComparisons(current) {
    if (!current) return current;
    const captured = current.directionalComparisons || (current.directionalComparisons = {});
    for (const [key, value] of Object.entries(current)) {
      const direction = parseDirectionalComparison(value);
      if (direction) captured[key] = { ...direction, raw: value };
    }
    return current;
  }

  function directionCanMatch(targetValue, referenceValue, relation) {
    const target = metricValueState(targetValue);
    const reference = metricValueState(referenceValue);
    if (![VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(target.state)
      || ![VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(reference.state)) return true;
    if (relation === "higher") {
      return !Number.isFinite(target.range?.max) || !Number.isFinite(reference.range?.min)
        || target.range.max > reference.range.min;
    }
    return !Number.isFinite(target.range?.min) || !Number.isFinite(reference.range?.max)
      || target.range.min < reference.range.max;
  }

  function validateDirectionalComparisons(metrics) {
    for (const side of ["subject", "competitor"]) {
      const current = metrics?.[side];
      if (!current) continue;
      for (const [key, direction] of Object.entries(current.directionalComparisons || {})) {
        if (isNumericMetricValue(current.periodDirectMetrics?.[key])) continue;
        // 三项效率指标一旦由同期间分子/分母公式闭合，方向文案仅保留为内部
        // 原始披露，不得撤销公式结果或重新进入生产报告。
        if (current.canonicalEfficiencyMetrics?.[key]) continue;
        const referenceSide = side === "subject" ? "competitor" : "subject";
        if (direction.referenceSide !== referenceSide || !isNumericMetricValue(current[key])
          || !isNumericMetricValue(metrics[referenceSide]?.[key])) continue;
        if (directionCanMatch(current[key], metrics[referenceSide][key], direction.relation)) continue;
        current.valueConflicts = current.valueConflicts || {};
        current.valueConflicts[key] = `${key}的数值结果与原始比较方向矛盾`;
        current[key] = direction.raw;
        if (key === "roas") current.globalROAS = direction.raw;
        if (key === "paidGmvContribution") current.paidAmountShare = direction.raw;
        for (const aligned of metrics.aligned || []) {
          const modelKey = aligned.key === "paidAmountShare" ? "paidGmvContribution" : aligned.key;
          if (modelKey === key) aligned[side] = direction.raw;
        }
      }
    }
    return metrics;
  }

  function finalizeMetricDirections(metrics) {
    for (let pass = 0; pass < 3; pass += 1) {
      for (const side of ["subject", "competitor"]) {
        closePeriodMetricSet(metrics?.[side], metrics?.[side]?.expectedContext || null);
      }
      resolveMetricPairDirections(metrics);
    }
    return validateDirectionalComparisons(metrics);
  }

  function enrichMetrics(metrics, sceneRows, daily, subjectDaily, context = {}) {
    for (const side of ["subject", "competitor"]) captureDirectionalComparisons(metrics?.[side]);
    const subjectLevel1 = sceneRows.level1.filter(row => row.role === "主体");
    const competitorLevel1 = sceneRows.level1.filter(row => row.role === "对手");
    const spendCoverageBySide = {
      subject: subjectDaily?.spendCoverage || null,
      competitor: daily?.spendCoverage || null
    };
    const level1BySide = { subject: subjectLevel1, competitor: competitorLevel1 };
    const expectedContextBySide = Object.fromEntries(["subject", "competitor"].map(side => {
      const entityId = side === "subject" ? context.subjectItemId : context.successItemId;
      const periodKey = `${context.period?.startDate || ""}|${context.period?.endDate || ""}|${context.period?.days || ""}`;
      return [side, {
        entityId: String(entityId || ""),
        startDate: context.period?.startDate || "",
        endDate: context.period?.endDate || "",
        coverageDays: Number(context.period?.days) || null,
        periodKey
      }];
    }));
    const initiallyDisclosed = Object.fromEntries(["subject", "competitor"].map(side => [side,
      new Set(Object.keys(metrics[side] || {}).filter(key => isNumericMetricValue(metrics[side][key])
        || parseDirectionalComparison(metrics[side][key])))
    ]));

    // INDEX_CARD 严格周期值优先，其次是一级场景精确花费。两者都没有时，
    // 完整日序列可作为严格周期；若仅缺 1 天，使用真实返回日的直接求和，
    // 但显式标记 coverage-period，不把缺失日当成 0。缺 2 天仍仅用于场景覆盖分配。
    for (const side of ["subject", "competitor"]) {
      const coverage = spendCoverageBySide[side];
      let spendScope = isNumericMetricValue(metrics[side].spend) ? "strict-period" : "missing";
      if (!isNumericMetricValue(metrics[side].spend)) {
        const sceneSpend = numberOrNull(sceneRows.exactSceneSpend?.[side]);
        if (Number.isFinite(sceneSpend)) {
          metrics[side].spend = sceneSpend;
          spendScope = "scene-exact";
        } else if ((coverage?.complete || coverage?.singleDayPartial) && Number.isFinite(coverage?.spend)) {
          metrics[side].spend = coverage.spend;
          spendScope = coverage.complete ? "strict-period-daily" : "coverage-period";
        }
      }
      metrics[side].spendScope = spendScope;
      metrics[side].spendCoverage = coverage;
      const expectedContext = expectedContextBySide[side];
      const coverageContext = coverage?.startDate && coverage?.endDate ? {
        entityId: expectedContext.entityId,
        startDate: coverage.startDate,
        endDate: coverage.endDate,
        coverageDays: coverage.coverageDays,
        periodKey: `${coverage.startDate}|${coverage.endDate}|${coverage.coverageDays}`
      } : expectedContext;
      metrics[side].valueContexts = metrics[side].valueContexts || {};
      for (const key of initiallyDisclosed[side]) metrics[side].valueContexts[key] = expectedContext;
      if (isNumericMetricValue(metrics[side].spend)) {
        metrics[side].valueContexts.spend = spendScope === "coverage-period" ? coverageContext : expectedContext;
      }
      metrics[side].expectedContext = expectedContext;
    }
    for (const side of ["subject", "competitor"]) {
      const metricRows = side === "subject"
        ? (sceneRows.closedSceneRows?.subject || [])
        : competitorLevel1;
      if (!isNumericMetricValue(metrics[side].paidGmv) && metricRows.length) {
        metrics[side].paidGmv = sumMetricRanges(metricRows.map(row => row.directDealAmount));
      }
    }
    metrics.subject.attributedGmv = metrics.subject.paidGmv;
    metrics.competitor.attributedGmv = metrics.competitor.paidGmv;
    for (const side of ["subject", "competitor"]) {
      const values = level1BySide[side];
      const coverage = spendCoverageBySide[side];
      const expectedContext = expectedContextBySide[side];
      const valueContexts = metrics[side].valueContexts;
      if (!isNumericMetricValue(metrics[side].marketingClicks)) {
        const metricRows = side === "subject"
          ? (sceneRows.closedSceneRows?.subject || [])
          : competitorLevel1;
        metrics[side].marketingClicks = metricRows.length
          ? sumMetricRanges(metricRows.map(row => row.click))
          : null;
        if (isNumericMetricValue(metrics[side].marketingClicks)) valueContexts.marketingClicks = expectedContext;
      }
      if (isNumericMetricValue(metrics[side].paidGmv) && !valueContexts.paidGmv) valueContexts.paidGmv = expectedContext;
      if (isNumericMetricValue(metrics[side].totalGmv) && !valueContexts.totalGmv) valueContexts.totalGmv = expectedContext;
      applyCanonicalEfficiencyMetrics(metrics[side], expectedContext);
      closePeriodMetricSet(metrics[side], expectedContext);
      const keywordRows = values.filter(row => row.primary === "关键词推广");
      const spend = numberOrNull(metrics[side].spend);
      const dailyKeywordSpend = numberOrNull(coverage?.channelSpend?.["关键词推广"]);
      const dailySpend = numberOrNull(coverage?.spend);
      const dailyMatchesDenominator = Number.isFinite(spend) && Number.isFinite(dailySpend)
        && Math.abs(spend - dailySpend) <= allocationTolerance(spend);
      const sceneKeywordSpend = sumFinite(keywordRows.map(row => numberOrNull(row.allocated)));
      const existingKeywordShare = metrics[side].keywordShare;
      const apiKeywordRatios = keywordRows.map(row => ratioOrNull(row.ratio));
      const apiKeywordShare = apiKeywordRatios.length && apiKeywordRatios.every(Number.isFinite)
        ? round(apiKeywordRatios.reduce((sum, value) => sum + value, 0), 6)
        : null;
      if (Number.isFinite(spend) && spend > 0 && Number.isFinite(dailyKeywordSpend) && dailyMatchesDenominator) {
        metrics[side].keywordSpend = dailyKeywordSpend;
        metrics[side].keywordShare = round(dailyKeywordSpend / spend, 6);
        metrics[side].keywordShareSource = "daily-channel-spend";
      } else if (Number.isFinite(spend) && spend > 0 && Number.isFinite(sceneKeywordSpend)) {
        metrics[side].keywordSpend = sceneKeywordSpend;
        metrics[side].keywordShare = round(sceneKeywordSpend / spend, 6);
        metrics[side].keywordShareSource = "level1-scene-spend";
      } else if (isNumericMetricValue(existingKeywordShare)) {
        metrics[side].keywordSpend = null;
        metrics[side].keywordShare = existingKeywordShare;
        metrics[side].keywordShareSource = "index-card";
      } else {
        metrics[side].keywordSpend = null;
        metrics[side].keywordShare = apiKeywordShare;
        metrics[side].keywordShareSource = Number.isFinite(apiKeywordShare) ? "api-ratio" : "missing";
      }
      const hhiRows = sceneRows.closedSceneRows?.[side] || [];
      const ratios = hhiRows.map(row => numberOrNull(row.ratio));
      const sum = ratios.reduce((total, value) => total + value, 0);
      metrics[side].channelHhi = ratios.length && ratios.every(Number.isFinite) && Math.abs(sum - 1) <= 0.01 ? round(ratios.reduce((total, value) => total + value ** 2, 0), 6) : null;
      metrics[side].valueConflicts = metrics[side].valueConflicts || {};
      const deriveRatio = (key, numerator, denominator, numeratorKey, denominatorKey, digits, metric, compact = false) => {
        if (isNumericMetricValue(metrics[side][key])) return;
        const result = safeIntervalDivide(numerator, denominator, {
          digits, metric, compact, outward: true,
          numeratorContext: valueContexts[numeratorKey],
          denominatorContext: valueContexts[denominatorKey]
        });
        if ([VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(result.state)) {
          metrics[side][key] = result.value;
          valueContexts[key] = valueContexts[numeratorKey] || valueContexts[denominatorKey] || expectedContext;
        } else if (result.state === VALUE_STATES.CONFLICT) {
          metrics[side].valueConflicts[key] = result.reason;
        }
      };
      deriveRatio("feeRatio", metrics[side].spend, metrics[side].totalGmv, "spend", "totalGmv", 6, "费比", true);
      deriveRatio("roas", metrics[side].totalGmv, metrics[side].spend, "totalGmv", "spend", 4, "全域ROAS", true);
      deriveRatio("ppc", metrics[side].spend, metrics[side].marketingClicks, "spend", "marketingClicks", 2, "PPC");
      deriveRatio("roi", metrics[side].paidGmv, metrics[side].spend, "paidGmv", "spend", 2, "ROI");
      const contribution = safeIntervalDivide(metrics[side].paidGmv, metrics[side].totalGmv, {
        digits: 6, metric: "付费金额占比", compact: true, outward: true,
        numeratorContext: valueContexts.paidGmv,
        denominatorContext: valueContexts.totalGmv
      });
      if (!isNumericMetricValue(metrics[side].paidGmvContribution)
        && [VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(contribution.state)) {
        metrics[side].paidGmvContribution = contribution.value;
        valueContexts.paidGmvContribution = valueContexts.paidGmv || expectedContext;
      } else if (contribution.state === VALUE_STATES.CONFLICT) {
        metrics[side].valueConflicts.paidGmvContribution = contribution.reason;
      }
      metrics[side].paidAmountShare = metrics[side].paidGmvContribution;
      if (valueContexts.paidGmvContribution) valueContexts.paidAmountShare = valueContexts.paidGmvContribution;
      metrics[side].globalROAS = metrics[side].roas;
      if (valueContexts.roas) valueContexts.globalROAS = valueContexts.roas;
      closePeriodMetricSet(metrics[side], expectedContext);
    }
    finalizeMetricDirections(metrics);
    return metrics;
  }

  function enrichItemSupplementMetrics(metrics, gate) {
    const accepted = new Set(Array.isArray(gate?.acceptedFields) ? gate.acceptedFields : []);
    const aggregateDirect = new Set(Array.isArray(gate?.aggregateDirectFields) ? gate.aggregateDirectFields : []);
    for (const side of ["subject", "competitor"]) {
      const current = metrics?.[side];
      if (!current) continue;
      const expectedContext = current.expectedContext || null;
      const valueContexts = current.valueContexts || (current.valueContexts = {});
      for (const field of accepted) {
        const prefix = `${side}.`;
        if (field.startsWith(prefix)) valueContexts[field.slice(prefix.length)] = expectedContext;
      }
      if (accepted.has(`${side}.spend`)) {
        current.spendScope = "competition-item-exact";
        current.spendCoverage = null;
      }
      current.valueConflicts = current.valueConflicts || {};
      const directKeys = ["paidGmv", "roi"].filter(key => aggregateDirect.has(`${side}.${key}`)
        && isNumericMetricValue(current[key]));
      if (directKeys.length) {
        current.periodDirectMetrics = current.periodDirectMetrics || {};
        for (const key of directKeys) {
          current.periodDirectMetrics[key] = current[key];
          valueContexts[key] = expectedContext;
          delete current.valueConflicts[key];
        }
      }
      if (directKeys.includes("paidGmv")) {
        current.attributedGmv = current.paidGmv;
        valueContexts.attributedGmv = expectedContext;
        current.paidGmvContribution = null;
        current.paidAmountShare = null;
        delete valueContexts.paidGmvContribution;
        delete valueContexts.paidAmountShare;
        delete current.valueConflicts.paidGmvContribution;
      }
      if (directKeys.includes("roi")) delete current.canonicalEfficiencyMetrics?.roi;
      captureDirectionalComparisons(current);
      applyCanonicalEfficiencyMetrics(current, expectedContext);
      closePeriodMetricSet(current, expectedContext);
      const deriveRatio = (key, numerator, denominator, numeratorKey, denominatorKey, digits, metric, compact = false) => {
        if (isNumericMetricValue(current[key])) return;
        const result = safeIntervalDivide(numerator, denominator, {
          digits, metric, compact, outward: true,
          numeratorContext: valueContexts[numeratorKey],
          denominatorContext: valueContexts[denominatorKey]
        });
        if ([VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(result.state)) {
          current[key] = result.value;
          valueContexts[key] = valueContexts[numeratorKey] || valueContexts[denominatorKey] || expectedContext;
        } else if (result.state === VALUE_STATES.CONFLICT) {
          current.valueConflicts[key] = result.reason;
        }
      };
      deriveRatio("feeRatio", current.spend, current.totalGmv, "spend", "totalGmv", 6, "费比", true);
      deriveRatio("roas", current.totalGmv, current.spend, "totalGmv", "spend", 4, "全域ROAS", true);
      deriveRatio("ppc", current.spend, current.marketingClicks, "spend", "marketingClicks", 2, "PPC");
      deriveRatio("roi", current.paidGmv, current.spend, "paidGmv", "spend", 2, "ROI");
      if (!isNumericMetricValue(current.paidGmvContribution)) {
        const contribution = safeIntervalDivide(current.paidGmv, current.totalGmv, {
          digits: 6,
          metric: "付费金额占比",
          compact: true,
          outward: true,
          numeratorContext: valueContexts.paidGmv,
          denominatorContext: valueContexts.totalGmv
        });
        if ([VALUE_STATES.EXACT, VALUE_STATES.INTERVAL].includes(contribution.state)) {
          current.paidGmvContribution = contribution.value;
          valueContexts.paidGmvContribution = valueContexts.paidGmv || expectedContext;
        } else if (contribution.state === VALUE_STATES.CONFLICT) {
          current.valueConflicts.paidGmvContribution = contribution.reason;
        }
      }
      current.paidAmountShare = current.paidGmvContribution;
      if (valueContexts.paidGmvContribution) valueContexts.paidAmountShare = valueContexts.paidGmvContribution;
      current.globalROAS = current.roas;
      if (valueContexts.roas) valueContexts.globalROAS = valueContexts.roas;
      closePeriodMetricSet(current, expectedContext);
    }
    finalizeMetricDirections(metrics);
    const directCompetitor = metrics?.competitor?.periodDirectMetrics || {};
    for (const aligned of metrics?.aligned || []) {
      const modelKey = aligned.key === "paidAmountShare" ? "paidGmvContribution" : aligned.key;
      if (["paidGmv", "roi"].includes(modelKey) && isNumericMetricValue(directCompetitor[modelKey])) {
        aligned.competitor = directCompetitor[modelKey];
      }
      if (modelKey === "paidGmvContribution" && isNumericMetricValue(metrics?.competitor?.paidGmvContribution)) {
        aligned.competitor = metrics.competitor.paidGmvContribution;
      }
    }
    return metrics;
  }

  function promotionDetailIssues(sceneRows) {
    const issues = [];
    const required = [
      ["impression", "展现"],
      ["click", "点击"],
      ["cpc", "CPC"],
      ["directDealAmount", "直接成交金额"],
      ["directRoi", "直接ROI"]
    ];
    for (const row of [...(sceneRows?.level1 || []), ...(sceneRows?.level2 || [])]) {
      const allocated = numberOrNull(row.allocated);
      if (!Number.isFinite(allocated) || allocated <= 0) continue;
      const missing = required.filter(([key]) => !isNumericMetricValue(row[key])).map(([, label]) => label);
      if (!missing.length) continue;
      const location = `${row.role}${row.level === 1 ? "一级" : "二级"}场景 ${row.primary}${row.secondary ? `/${row.secondary}` : ""}`;
      issues.push(`${location}缺少可披露或可严格计算的${missing.join("、")}`);
    }
    return [...new Set(issues)];
  }

  function subjectPromotionSceneIssues(sceneRows, subjectMetrics = {}) {
    const spend = numberOrNull(subjectMetrics.spend);
    if (!(spend > 0)) return [];
    const rows = (sceneRows?.level1 || []).filter(row => row.role === "主体");
    const hasData = row => [
      row.charge, row.ratio, row.allocated, row.impression, row.click,
      row.ctr, row.cpc, row.directDealAmount, row.directRoi
    ].some(isDisclosedMetric);
    if (!rows.length || !rows.some(hasData)) {
      return ["主体推广消耗大于0，但主体一级推广场景数据为空"];
    }
    const missingAllocation = rows.filter(hasData).filter(row => !Number.isFinite(numberOrNull(row.allocated)));
    if (!missingAllocation.length) return [];
    const names = missingAllocation.map(row => row.primary || `场景${row.sceneId || "未知"}`);
    return [`主体推广消耗大于0，但主体一级推广场景有 ${missingAllocation.length} 项花费/占比未能分配：${names.join("、")}`];
  }

  // 补抓清理必须与完整性审计使用同一套失败定义。过去 overlay 只识别截断、
  // 无响应体和 HTTP 错误，导致 HTTP 200 下的 API 报错或结构变化记录无法被
  // 替换：新响应已经可用，旧失败仍永久计入 failedRecords，最终出现 6/6、
  // 14/14 但下载门禁始终阻断。这里集中完成单条业务响应的解析与审计分类。
  function classifyGrowthRecord(record) {
    const path = recordPath(record);
    const transportReason = transportOnlyReason(record);
    if (transportReason) {
      return { path, parser: "transport", status: "ignored", reason: transportReason, parsed: null };
    }
    const httpStatus = Number(record?.status ?? record?.response?.status);
    if (Number.isFinite(httpStatus) && (httpStatus < 200 || httpStatus >= 300)) {
      return { path, parser: "http", status: "failed", reason: `http-status:${httpStatus}`, parsed: null };
    }
    if (record?.truncated || record?.bodyTruncated || record?.bodyAvailable === false || !record?.body) {
      return {
        path,
        parser: "body",
        status: "failed",
        reason: record?.truncated || record?.bodyTruncated ? "truncated-response" : "missing-response",
        parsed: null
      };
    }

    const body = parseBody(record);
    if (!body) return { path, parser: "body", status: "failed", reason: "unparseable-response", parsed: null };
    const apiInfo = body?.info || body?.result?.info;
    if (apiInfo?.ok === false) {
      return { path, parser: "api", status: "failed", reason: `api-error:${apiInfo.message || apiInfo.code || "unknown"}`, parsed: null };
    }

    let parser = "unsupported-growth-endpoint";
    let parsed = null;
    if (path === "/api/goods/item/info") {
      parser = "item-info";
      parsed = extractItemInfo(record, body);
    } else if (path === "/api/goods/grow/define/success/load" || path === "/api/goods/grow/define/success/item/list") {
      parser = path.endsWith("/load") ? "selected-success-items" : "success-item-search";
      parsed = extractSuccessItems(record, body, path.endsWith("/load") ? "selected" : "search");
    } else if (path === "/api/goods/grow/define/success") {
      parser = "success-write-ack";
      parsed = apiInfo?.ok === true || body?.data != null ? { ack: true } : null;
    } else if (path === "/api/goods/grow/line") {
      parser = "growth-definitions";
      parsed = arrayFromBody(body);
    } else if (path === "/api/goods/grow/define/line/data") {
      parser = "growth-line";
      parsed = extractLine(record, body);
    } else if (path === "/api/goods/grow/comparison/scene/keyword") {
      parser = "growth-keywords";
      parsed = extractKeywords(record, body);
    } else if (path === "/api/goods/grow/comparison/scene") {
      parser = "growth-scenes";
      parsed = extractScene(record, body);
    } else if (path === "/dataplatform/dataset/report/query") {
      const requestType = datasetRequestType(record);
      if (requestType === "INDEX_CARD") {
        parser = "index-card";
        parsed = extractCard(record, body);
      } else if (requestType === "TABLE") {
        parser = "dataset-table";
        parsed = extractDatasetTable(record, body);
      } else {
        parsed = extractCard(record, body) || extractDatasetTable(record, body);
        parser = parsed?.metrics ? "index-card" : parsed ? "dataset-table" : `dataset-${requestType.toLowerCase() || "unknown"}`;
      }
    }

    const empty = Array.isArray(parsed)
      ? parsed.length === 0
      : parsed?.rows && Array.isArray(parsed.rows) ? parsed.rows.length === 0 : false;
    return parsed
      ? { path, parser, status: empty ? "empty" : "parsed", reason: "", parsed }
      : { path, parser, status: "failed", reason: "response-shape-not-recognized", parsed: null };
  }

  function deriveGrowth(records, options = {}) {
    const startedAt = options.startedAt || "";
    const subjectItemId = String(options.subjectItemId || options.itemId || "");
    const successItemId = String(options.successItemId || "");
    const periodStart = normalizeDate(options.period?.startDate);
    const periodEnd = normalizeDate(options.period?.endDate);
    const naturalDays = daysInclusive(periodStart, periodEnd);
    const period = { startDate: periodStart, endDate: periodEnd, days: naturalDays || Number(options.period?.days) || 30 };
    const scoped = (records || []).filter(record => {
      if (!record || (record.kind && record.kind !== "Network")) return false;
      if (startedAt && record.capturedAt && record.capturedAt < startedAt) return false;
      return isGrowthBusinessPath(recordPath(record)) && !isTransportOnlyRecord(record);
    });

    const auditMap = new Map();
    const itemInfos = [];
    const successItems = [];
    const cards = [];
    const datasetTables = [];
    const lines = [];
    const scenes = [];
    const keywords = [];
    const parsedDefinitions = [];

    function audit(path, parser, expectedParser, status, reason = "") {
      const entry = auditMap.get(path) || {
        path,
        // `records` remains the effective audit population so the established
        // parsedRecords + failedRecords = businessRecords invariant stays true.
        // Raw observations and superseded failures are retained alongside it.
        records: 0,
        rawRecords: 0,
        parsed: 0,
        empty: 0,
        failed: 0,
        supersededFailed: 0,
        parsers: new Set(),
        expectedParsers: new Set(),
        reasons: new Set(),
        supersededReasons: new Set()
      };
      entry.rawRecords += 1;
      entry.parsers.add(parser);
      if (expectedParser) entry.expectedParsers.add(expectedParser);
      if (status === "superseded-failed") {
        entry.supersededFailed += 1;
        if (reason) entry.supersededReasons.add(reason);
      } else {
        entry.records += 1;
        entry[status] += 1;
        if (reason) entry.reasons.add(reason);
      }
      auditMap.set(path, entry);
    }

    const observations = scoped.map((record, index) => {
      const result = classifyGrowthRecord(record);
      const expectedParser = expectedGrowthParser(record);
      const replacementKey = growthRecordReplacementKey(record);
      return { record, index, result, expectedParser, replacementKey };
    });
    const latestParsedIndexByKey = new Map();
    for (const observation of observations) {
      if (observation.result.status !== "parsed"
        || !observation.replacementKey
        || observation.result.parser !== observation.expectedParser) continue;
      latestParsedIndexByKey.set(observation.replacementKey, observation.index);
    }

    for (const observation of observations) {
      const { result, expectedParser, replacementKey, index } = observation;
      const superseded = result.status === "failed"
        && Boolean(replacementKey)
        && Number(latestParsedIndexByKey.get(replacementKey)) > index;
      audit(
        result.path,
        result.parser,
        expectedParser,
        superseded ? "superseded-failed" : result.status,
        result.reason
      );
      if (result.status === "failed") continue;
      if (result.parser === "item-info") itemInfos.push(result.parsed);
      else if (result.parser === "selected-success-items" || result.parser === "success-item-search") successItems.push(...result.parsed);
      else if (result.parser === "growth-definitions") parsedDefinitions.push(...result.parsed);
      else if (result.parser === "growth-line") lines.push(result.parsed);
      else if (result.parser === "growth-keywords") keywords.push(result.parsed);
      else if (result.parser === "growth-scenes") scenes.push(result.parsed);
      else if (result.parser === "index-card") cards.push(result.parsed);
      else if (result.parser === "dataset-table") datasetTables.push(result.parsed);
    }

    const endpointCoverage = [...auditMap.values()].map(entry => ({
      path: entry.path,
      records: entry.records,
      rawRecords: entry.rawRecords,
      parsed: entry.parsed,
      empty: entry.empty,
      failed: entry.failed,
      rawFailed: entry.failed + entry.supersededFailed,
      supersededFailed: entry.supersededFailed,
      parsers: [...entry.parsers],
      expectedParsers: [...entry.expectedParsers],
      reasons: [...entry.reasons],
      supersededReasons: [...entry.supersededReasons]
    })).sort((left, right) => left.path.localeCompare(right.path));
    const blockingIssues = [];
    const warnings = [];
    // 平台侧少数据的说明单独一档：它既不是阻断项，也不能混进 warnings，
    // 因为 warnings（如缺少标准接口）本身仍要拦住下载。notes 只用于对外说明。
    const notes = [];
    if (!period.startDate || !period.endDate) blockingIssues.push("目标业务周期起止日期未落实");
    if (naturalDays && Number(options.period?.days) && naturalDays !== Number(options.period.days)) blockingIssues.push(`目标周期自然日为 ${naturalDays} 天，与声明的 ${options.period.days} 天不一致`);
    for (const entry of endpointCoverage) if (entry.failed) blockingIssues.push(`${entry.path}: ${entry.failed} 条业务响应未解析（${entry.reasons.join("、")}）`);
    const capturedPaths = new Set(endpointCoverage.map(entry => entry.path));
    const missingStandard = STANDARD_PATHS.filter(path => !capturedPaths.has(path));
    if (missingStandard.length) warnings.push(`缺少标准接口：${missingStandard.join("、")}`);

    const item = itemInfos.find(value => value.itemId === subjectItemId) || null;
    if (!item) blockingIssues.push(`主体商品 ${subjectItemId || "未指定"} 未能与商品概况精确匹配`);
    const listedTargetSuccess = successItems
      .filter(value => !successItemId || value.itemId === successItemId)
      .sort((left, right) => Number(right.source === "selected") - Number(left.source === "selected") || String(right.capturedAt || "").localeCompare(String(left.capturedAt || "")))[0] || null;
    // 同一商品可以同时作为主体与对照对象。这里只复用同一对象的
    // 标题/图片等身份元数据，不复制任何主体指标到竞品指标。
    const targetSuccess = listedTargetSuccess || (item && subjectItemId === successItemId
      ? { ...item, itemId: successItemId, source: "same-identity-subject" }
      : null);
    const effectiveSuccessItems = targetSuccess && !successItems.some(value => value.itemId === targetSuccess.itemId)
      ? [...successItems, targetSuccess]
      : successItems;
    if (!targetSuccess || (successItemId && targetSuccess.itemId !== successItemId)) blockingIssues.push(`目标成功品 ${successItemId || "未指定"} 未能与成功品接口精确匹配`);

    const subjectScopedCards = cards.filter(card => samePeriod(card, period)
      && card.subjectItemIds.includes(subjectItemId) && card.competitorItemIds.includes(successItemId));
    const mismatchedComparedCards = subjectScopedCards.filter(card => !sameComparedPeriod(card, period));
    const targetCards = subjectScopedCards.filter(card => sameComparedPeriod(card, period));
    const targetCard = mergeMetricCards(targetCards);
    if (!targetCard) {
      blockingIssues.push(`没有找到与主体、对手及 ${period.startDate || "?"}~${period.endDate || "?"} 双方周期完全一致的核心指标卡`);
      if (mismatchedComparedCards.length) blockingIssues.push(`发现 ${mismatchedComparedCards.length} 张对手周期错位的核心指标卡，已拒绝串入目标周期`);
    } else if (mismatchedComparedCards.length) {
      notes.push(`已忽略 ${mismatchedComparedCards.length} 张对手周期与目标周期不一致的核心指标卡`);
    }
    const metrics = buildMetrics(targetCard);
    if (![metrics.subject.orders, metrics.subject.aov, metrics.competitor.orders, metrics.competitor.aov].every(value => numberOrNull(value) != null)) {
      blockingIssues.push("主体或目标成功品缺少同周期精确成交笔数/笔单价，无法落实总GMV");
    }
    const pairedDaily = buildPairedDaily(
      cards,
      subjectItemId,
      successItemId,
      period,
      metrics,
      options.competitionItemDailySupplements,
      options.id || options.runId
    );
    const subjectDaily = pairedDaily.subject;
    const competitorDaily = pairedDaily.competitor;
    if (pairedDaily.duplicateDates.length) {
      notes.push(`主体与对手逐日核心指标日期重复，已按最新响应去重：${pairedDaily.duplicateDates.join("、")}`);
    }
    if (options.requireSubjectDaily === true) {
      if (subjectDaily.missingDates.length) blockingIssues.push(`主体逐日核心指标缺少 ${subjectDaily.missingDates.length} 天：${subjectDaily.missingDates.join("、")}`);
      if (subjectDaily.duplicateDates.length) blockingIssues.push(`主体逐日核心指标日期重复：${subjectDaily.duplicateDates.join("、")}`);
      if (subjectDaily.unresolvedDates.length) blockingIssues.push(`主体逐日成交金额无法精确计算：${subjectDaily.unresolvedDates.join("、")}`);
      if (!subjectDaily.ordersClosed) blockingIssues.push("主体逐日成交笔数合计与周期成交笔数不闭合");
      if (!subjectDaily.gmvClosed) blockingIssues.push("主体逐日GMV合计与周期GMV不闭合");
    }

    const line = chooseLine(lines, subjectItemId, successItemId, period);
    if (!line) blockingIssues.push("没有找到与主体、成功品及目标周期匹配的成长趋势序列");
    const daily = buildDaily(line, period, numberOrNull(metrics.competitor.totalGmv));
    enrichPairedDailyWithLine(subjectDaily, daily, "subject");
    enrichPairedDailyWithLine(competitorDaily, daily, "competitor");
    resolvePairedDailyDirections(subjectDaily, competitorDaily);
    if (options.requirePairedDaily === true) {
      for (const [side, label] of [[subjectDaily, "主体"], [competitorDaily, "对手"]]) {
        if (side.missingDates.length) blockingIssues.push(`${label}逐日核心指标缺少 ${side.missingDates.length} 天：${side.missingDates.join("、")}`);
        if (side.unresolvedDates.length) blockingIssues.push(`${label}逐日成交金额无法精确计算：${side.unresolvedDates.join("、")}`);
        if (!side.ordersClosed) blockingIssues.push(`${label}逐日成交笔数合计与周期成交笔数不闭合`);
        if (!side.gmvClosed) blockingIssues.push(`${label}逐日GMV合计与周期GMV不闭合`);
        for (const [key, metricLabel] of [["paidGmv", "付费成交额"], ["spend", "日总消耗"], ["roi", "ROI"], ["ppc", "PPC"]]) {
          const missingDates = missingPairedDailyMetricDates(side, key);
          if (missingDates.length) blockingIssues.push(`${label}逐日${metricLabel}缺少 ${missingDates.length} 天：${missingDates.join("、")}`);
        }
      }
    }
    if (daily.duplicateDates.length) {
      notes.push(`目标趋势日期重复，已按日期保留最后一条：${daily.duplicateDates.join("、")}`);
    }
    // 平台少 1 天数据在容忍范围内只做提示，不再阻断报告：补抓无法让平台提前产出，
    // 继续阻断只会让报告永远下载不了。缺口天数与日期由 platformGap 明示到报告里。
    if (daily.platformGapTolerated) {
      notes.push(`平台少${daily.platformGapDays}天数据：${daily.platformGapDates.join("、")}（该日数值留空，其余 ${daily.coverageDays} 天照常计算）`);
    } else {
      if (daily.missingDates.length) blockingIssues.push(`目标周期缺少 ${daily.missingDates.length} 日趋势：${daily.missingDates.join("、")}`);
      if (daily.missingChannelDates.length) blockingIssues.push(`有 ${daily.missingChannelDates.length} 日五渠道消耗字段不完整`);
      if (daily.missingIndexDates.length) blockingIssues.push(`有 ${daily.missingIndexDates.length} 日 GMV 序列值缺失`);
    }
    if (daily.invalidIndexDates.length) blockingIssues.push(`有 ${daily.invalidIndexDates.length} 日 GMV 序列值小于 0`);
    if (!Number.isFinite(metrics.competitor.totalGmv)) blockingIssues.push("目标成功品缺少精确周期GMV，不能把GMV序列换算为日金额");
    if (!daily.invalidIndexDates.length && (!daily.platformGapDays || daily.platformGapTolerated)
      && Number.isFinite(metrics.competitor.totalGmv) && daily.gmvFit.status !== "ready") {
      blockingIssues.push(`日GMV金额拟合未闭合（${daily.gmvFit.reason}）`);
    }

    const targetScenes = scenes.filter(scene => scene.itemId === subjectItemId
      && scene.successItemIds.includes(successItemId) && samePeriod(scene, period));
    const sceneByScope = new Map();
    for (const scene of targetScenes.sort((left, right) => String(right.capturedAt || "").localeCompare(String(left.capturedAt || "")))) {
      const key = `${scene.level}|${scene.parentSceneId || ""}`;
      const current = sceneByScope.get(key);
      // A direct retry can legitimately return an empty array while an earlier
      // response in the same immutable object/period scope already contains
      // the disclosed scene rows. Do not let the later empty retry erase those
      // rows; among candidates with the same emptiness state the sort order
      // still keeps the newest response. An all-empty scope remains empty and
      // never borrows rows from another parent, object or period.
      if (!current || (!(current.rows || []).length && (scene.rows || []).length)) {
        sceneByScope.set(key, scene);
      }
    }
    const dedupScenes = [...sceneByScope.values()];
    if (!dedupScenes.some(scene => scene.level === 1)) blockingIssues.push("没有找到与目标周期匹配的一级投放场景响应");
    const level1 = dedupScenes.find(scene => scene.level === 1);
    const expectedParents = [...new Set((level1?.rows || []).map(row => String(row.sceneId || "")).filter(Boolean))];
    const capturedParents = new Set(dedupScenes.filter(scene => scene.level === 2).map(scene => String(scene.parentSceneId || "")));
    const missingParents = expectedParents.filter(parent => !capturedParents.has(parent));
    if (missingParents.length) blockingIssues.push(`缺少 ${missingParents.length} 个一级场景的二级明细响应：${missingParents.join("、")}`);
    const exactSubjectSpend = numberOrNull(metrics.subject.spend);
    const exactCompetitorSpend = numberOrNull(metrics.competitor.spend);
    const sceneSubjectSpend = rawSceneAllocation(level1?.rows || [], "subject").spend;
    const sceneCompetitorSpend = rawSceneAllocation(level1?.rows || [], "competitor").spend;
    // 场景响应是请求完整周期口径；日消耗只覆盖 29/30 或 28/30 日时可以作为
    // partial 汇总展示，却不能乘完整周期场景占比。只有日覆盖完整时才可充当
    // 场景分配基数，避免跨覆盖天数混算。
    const subjectCoverageSpend = subjectDaily.spendComplete ? numberOrNull(subjectDaily.totalSpend) : null;
    const competitorCoverageSpend = competitorDaily.spendComplete
      ? numberOrNull(competitorDaily.totalSpend)
      : daily.spendComplete ? numberOrNull(daily.totalSpend) : null;
    const sceneRows = buildSceneRows(dedupScenes, {
      subject: exactSubjectSpend ?? sceneSubjectSpend ?? subjectCoverageSpend,
      competitor: exactCompetitorSpend ?? sceneCompetitorSpend ?? competitorCoverageSpend
    });
    sceneRows.allocationScope = {
      subject: Number.isFinite(exactSubjectSpend)
        ? "strict-period"
        : Number.isFinite(sceneSubjectSpend)
          ? "scene-exact"
          : subjectDaily.spendComplete
            ? "strict-period-daily"
            : subjectDaily.spendPartial
              ? "coverage-period"
              : "missing",
      competitor: Number.isFinite(exactCompetitorSpend)
        ? "strict-period"
        : Number.isFinite(sceneCompetitorSpend)
          ? "scene-exact"
          : competitorDaily.spendComplete || daily.spendComplete
            ? "strict-period-daily"
            : competitorDaily.spendPartial || daily.spendPartial
              ? "coverage-period"
              : "missing",
      subjectStart: subjectDaily.spendPartial ? subjectDaily.spendCoverage.startDate : period.startDate,
      subjectEnd: subjectDaily.spendPartial ? subjectDaily.spendCoverage.endDate : period.endDate,
      subjectDays: subjectDaily.spendPartial ? subjectDaily.spendCoverageDays : period.days,
      competitorStart: competitorDaily.spendPartial
        ? competitorDaily.spendCoverage.startDate
        : daily.spendPartial ? daily.spendCoverage.startDate : period.startDate,
      competitorEnd: competitorDaily.spendPartial
        ? competitorDaily.spendCoverage.endDate
        : daily.spendPartial ? daily.spendCoverage.endDate : period.endDate,
      competitorDays: competitorDaily.spendPartial
        ? competitorDaily.spendCoverageDays
        : daily.spendPartial ? daily.spendCoverageDays : period.days
    };
    if (sceneRows.validationIssues.length) blockingIssues.push(...sceneRows.validationIssues);
    enrichMetrics(metrics, sceneRows, daily, subjectDaily, { period, subjectItemId, successItemId });
    const itemSupplementGate = options.competitionItemSupplement && competitionItemSupplement?.applyToMetrics
      ? competitionItemSupplement.applyToMetrics(metrics, options.competitionItemSupplement, {
          subjectItemId,
          competitorItemId: successItemId,
          period,
          previousPeriod: options.previousPeriod,
          runId: options.id || options.runId,
          preferAggregateDirect: daysInclusive(period.startDate, period.endDate) === 30
        })
      : null;
    if (itemSupplementGate?.acceptedFields?.length) enrichItemSupplementMetrics(metrics, itemSupplementGate);
    const promotionIssues = [
      ...subjectPromotionSceneIssues(sceneRows, metrics.subject),
      ...promotionDetailIssues(sceneRows)
    ];
    sceneRows.missingDetails = promotionIssues;
    if (promotionIssues.length) blockingIssues.push(...promotionIssues);
    if (sceneRows.level1.some(row => row.role === "对手" && ratioOrNull(row.ratio) != null) && !daily.spendUsable) {
      blockingIssues.push("竞品场景只有消耗比例，但缺少可用总消耗，不能分配场景金额");
    }

    const targetKeywords = keywords.filter(value => value.itemId === subjectItemId
      && value.successItemIds.includes(successItemId) && samePeriod(value, period))
      .sort((left, right) => String(right.capturedAt || "").localeCompare(String(left.capturedAt || "")))[0] || null;
    if (!targetKeywords) blockingIssues.push("未捕获与主体、成功品及目标周期精确匹配的关键词响应");
    if (Array.isArray(options.sceneMissed) && options.sceneMissed.length) blockingIssues.push(`场景明细渠道未遍历完整：${options.sceneMissed.join("、")}`);

    const metricContract = evaluateCoreMetricContract(metrics, {
      sceneRows,
      contexts: {
        subject: { expected: metrics.subject.expectedContext, values: metrics.subject.valueContexts },
        competitor: { expected: metrics.competitor.expectedContext, values: metrics.competitor.valueContexts }
      }
    });
    if (!metricContract.complete) {
      for (const gap of metricContract.missing) {
        blockingIssues.push(`${gap.label}${gap.state === VALUE_STATES.CONFLICT ? "口径冲突" : "缺失"}：${gap.reason}`);
      }
    }

    const completenessStatus = blockingIssues.length ? "blocked" : warnings.length ? "ready-with-warnings" : "ready";
    return {
      pageType: "growth", period, item, targetSuccess, successItems: effectiveSuccessItems, targetCard, cards, datasetTables, line, daily, subjectDaily, competitorDaily, pairedDaily,
      stages: line?.stages || [], sceneResponses: dedupScenes, sceneRows, keywords: targetKeywords?.rows || [], metrics, metricContract,
      itemSupplementGate,
      definitions: parsedDefinitions,
      completeness: {
        status: completenessStatus,
        rawBusinessRecords: endpointCoverage.reduce((sum, entry) => sum + entry.rawRecords, 0),
        businessRecords: endpointCoverage.reduce((sum, entry) => sum + entry.records, 0),
        parsedRecords: endpointCoverage.reduce((sum, entry) => sum + entry.parsed + entry.empty, 0),
        failedRecords: endpointCoverage.reduce((sum, entry) => sum + entry.failed, 0),
        supersededFailedRecords: endpointCoverage.reduce((sum, entry) => sum + entry.supersededFailed, 0),
        platformGap: {
          days: daily.platformGapDays,
          dates: daily.platformGapDates,
          tolerated: daily.platformGapTolerated,
          toleranceDays: PLATFORM_DAY_GAP_TOLERANCE,
          coverageDays: daily.coverageDays,
          expectedDays: daily.expectedDates.length
        },
        endpointCoverage, blockingIssues: [...new Set(blockingIssues)], warnings: [...new Set(warnings)], notes: [...new Set(notes)],
        metricContract, itemSupplementGate
      }
    };
  }

  return {
    CHANNELS, SCENE_CODES, STANDARD_PATHS, PLATFORM_DAY_GAP_TOLERANCE, METRIC_ALIAS_GROUPS,
    SUBJECT_MINIMUM_PROMOTION_CONTRACT, SUBJECT_MINIMUM_PROMOTION_METRICS, missingSubjectMinimumPromotionMetrics,
    CORE_METRIC_CONTRACT, VALUE_STATES, metricValueState, isNumericMetricValue, metricContextMismatch, metricRangesCompatible,
    parseDirectionalComparison, resolveDirectionalBound, safeIntervalDivide, safeIntervalMultiply, applyCanonicalEfficiencyMetrics, evaluateCoreMetricContract,
    metricIdentity, canonicalPath, recordPath, parseBody, parseVagueRange,
    numberOrNull, calculableMetricValue, normalizeDate, enumerateDates, lineGmvIndex, fitDailyGmv, costPerClick, sumMetricRanges, returnOnSpend, paidGmvFromSpendAndRoi, contributionRatio,
    datasetRequestType, expectedGrowthParser, growthRecordReplacementScope, growthRecordReplacementKey,
    transportOnlyReason, isTransportOnlyRecord, classifyGrowthRecord, deriveGrowth
  };
});
