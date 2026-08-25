(function initDmpCompletenessEngine(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DmpCompletenessEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createDmpCompletenessEngine() {
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

  // INDEX_CARD 的同一业务指标会因页面版本或接口模板不同而出现不同名称。
  // 统一身份只用于同义去重，不改变接口披露的数值；列表顺序同时定义核心指标优先级。
  const METRIC_ALIAS_GROUPS = [
    { key: "marketingClicks", name: "营销推广点击量", aliases: ["营销推广点击量", "营销推广点击数", "营销推广点击", "广告点击量", "广告点击数", "推广点击量", "推广点击数", "付费点击量", "promotionclick", "promotionclicks", "adclick"] },
    { key: "naturalClicks", name: "自然点击量", aliases: ["自然点击量", "自然流量点击量", "organicclick"] },
    { key: "orders", name: "成交笔数", aliases: ["成交笔数", "支付成交笔数", "支付笔数", "alipaycnt", "alipaycnt1d"] },
    { key: "conversion", name: "支付转化率", aliases: ["支付转化率", "成交转化率", "支付成交转化率", "alipayconversion", "conversionrate"] },
    { key: "aov", name: "笔单价", aliases: ["笔单价", "客单价", "平均订单金额", "unitprice", "avgorder"] },
    { key: "cartRate", name: "加购率", aliases: ["加购率", "收藏加购率", "cartrate"] },
    { key: "visitors", name: "访客数", aliases: ["访客数", "访问人数", "访客", "uv"] },
    { key: "totalGmv", name: "总GMV", aliases: ["总gmv", "成交金额", "支付成交金额", "alipayamt", "gmv30d"] },
    { key: "paidGmv", name: "付费成交额", aliases: ["付费成交额", "付费成交金额", "营销推广成交额", "营销推广成交金额", "推广成交额", "推广成交金额", "广告归因gmv", "广告成交额", "广告成交金额", "直接成交额", "直接成交金额", "直接支付金额", "directalipayamt", "directalipayamount", "gmv1d", "alipayamt1d"] },
    { key: "paidOrders", name: "付费成交笔数", aliases: ["付费成交笔数", "营销推广成交笔数", "广告成交笔数", "广告归因成交笔数"] },
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
    if (!Number.isFinite(spend) || spend < 0) return null;
    const exactClicks = numberOrNull(clicks);
    if (exactClicks != null) return exactClicks > 0 ? round(spend / exactClicks) : null;
    const range = parseVagueRange(clicks);
    if (!range) return null;
    const minimumClicks = Number.isFinite(range.min) ? range.min : null;
    const maximumClicks = Number.isFinite(range.max) ? range.max : null;
    if (minimumClicks != null && minimumClicks > 0 && maximumClicks != null && maximumClicks > 0) {
      const lower = round(spend / maximumClicks);
      const upper = round(spend / minimumClicks);
      return lower === upper ? lower : `${lower.toFixed(2)}~${upper.toFixed(2)}`;
    }
    if (maximumClicks != null && maximumClicks > 0) return `>${round(spend / maximumClicks).toFixed(2)}`;
    if (minimumClicks != null && minimumClicks > 0) return `<${round(spend / minimumClicks).toFixed(2)}`;
    return null;
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
    if (!Number.isFinite(spend) || spend <= 0) return null;
    const exactGmv = numberOrNull(paidGmv);
    if (exactGmv != null) return exactGmv >= 0 ? round(exactGmv / spend) : null;
    const range = parseVagueRange(paidGmv);
    if (!range) return null;
    const minimumGmv = Number.isFinite(range.min) ? range.min : null;
    const maximumGmv = Number.isFinite(range.max) ? range.max : null;
    if (range.upperOpen && maximumGmv != null) return `<${round(maximumGmv / spend).toFixed(2)}`;
    if (range.lowerOpen && minimumGmv != null) return `>${round(minimumGmv / spend).toFixed(2)}`;
    if (minimumGmv != null && maximumGmv != null) {
      const lower = round(minimumGmv / spend);
      const upper = round(maximumGmv / spend);
      return lower === upper ? lower : `${lower.toFixed(2)}~${upper.toFixed(2)}`;
    }
    if (maximumGmv != null) return `<${round(maximumGmv / spend).toFixed(2)}`;
    if (minimumGmv != null) return `>${round(minimumGmv / spend).toFixed(2)}`;
    return null;
  }

  function contributionRatio(value, total) {
    if (!Number.isFinite(total) || total <= 0) return null;
    const exact = numberOrNull(value);
    if (exact != null) return exact >= 0 ? round(exact / total, 6) : null;
    const range = parseVagueRange(value);
    if (!range) return null;
    const minimum = Number.isFinite(range.min) ? round(range.min / total, 6) : null;
    const maximum = Number.isFinite(range.max) ? round(range.max / total, 6) : null;
    if (range.upperOpen && maximum != null) return `<${maximum}`;
    if (range.lowerOpen && minimum != null) return `>${minimum}`;
    if (minimum != null && maximum != null) return minimum === maximum ? minimum : `${minimum}~${maximum}`;
    if (maximum != null) return `<${maximum}`;
    if (minimum != null) return `>${minimum}`;
    return null;
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
      pairs = card.list.map(row => ({ field: row.field || { name: row.name, description: row.description, id: row.id }, value: row.value && typeof row.value === "object" ? row.value : row }));
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
        subject: isDisclosedMetric(previous.subject) ? previous.subject : parsed.subject,
        competitor: isDisclosedMetric(previous.competitor) ? previous.competitor : parsed.competitor,
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
        subject: isDisclosedMetric(previous.subject) ? previous.subject : row.subject,
        competitor: isDisclosedMetric(previous.competitor) ? previous.competitor : row.competitor,
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
        if (!isDisclosedMetric(merged[side]) && isDisclosedMetric(value?.[side])) merged[side] = value[side];
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
      const firstValue = side => {
        const candidate = candidates.find(entry => isDisclosedMetric(entry?.[side]));
        return candidate ? alignedMetricValue(candidate[side]) : null;
      };
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
    const paidGmv = metricByAliases(card, ["付费成交额", "付费成交金额", "营销推广成交额", "营销推广成交金额", "广告归因GMV", "广告成交额", "广告成交金额"]);
    const paidOrders = metricByAliases(card, ["付费成交笔数", "营销推广成交笔数", "广告成交笔数", "广告归因成交笔数", "alipayCnt1d"]);
    const subject = {
      marketingClicks: read("营销推广点击量", "subject"), naturalClicks: read("自然点击量", "subject"),
      orders: read("成交笔数", "subject"), conversion: read("支付转化率", "subject"), aov: read("笔单价", "subject"),
      cartRate: read("加购率", "subject"), ipv: read("IPV", "subject"),
      totalGmv: read("总GMV", "subject"),
      paidGmv: calculableMetricValue(paidGmv.subject), paidOrders: calculableMetricValue(paidOrders.subject),
      spend: read("推广消耗", "subject"), feeRatio: read("费比", "subject"),
      roi: read("ROI", "subject"), ppc: read("PPC", "subject"), roas: read("全域ROAS", "subject")
    };
    const competitor = {
      marketingClicks: read("营销推广点击量", "competitor"), naturalClicks: read("自然点击量", "competitor"),
      orders: read("成交笔数", "competitor"), conversion: read("支付转化率", "competitor"), aov: read("笔单价", "competitor"),
      cartRate: read("加购率", "competitor"), ipv: read("IPV", "competitor"),
      totalGmv: read("总GMV", "competitor"),
      paidGmv: calculableMetricValue(paidGmv.competitor), paidOrders: calculableMetricValue(paidOrders.competitor),
      spend: read("推广消耗", "competitor"), feeRatio: read("费比", "competitor"),
      roi: read("ROI", "competitor"), ppc: read("PPC", "competitor"), roas: read("全域ROAS", "competitor")
    };
    for (const side of [subject, competitor]) {
      const orders = numberOrNull(side.orders);
      const aov = numberOrNull(side.aov);
      const conversion = numberOrNull(side.conversion);
      if (!isDisclosedMetric(side.totalGmv)) side.totalGmv = orders != null && aov != null ? round(orders * aov) : null;
      else side.totalGmv = calculableMetricValue(side.totalGmv);
      const visitor = orders != null && conversion != null && conversion !== 0 ? round(orders / conversion) : null;
      const ipvExact = numberOrNull(side.ipv);
      const ipvRange = parseVagueRange(side.ipv);
      const closed = visitor != null && ((ipvExact != null && ipvExact !== 0 && Math.abs(visitor - ipvExact) / Math.abs(ipvExact) <= 0.01) || rangeContains(ipvRange, visitor));
      side.visitors = closed ? visitor : null;
      side.visitorClosed = closed;
      const exactSpend = numberOrNull(side.spend);
      if (!isDisclosedMetric(side.feeRatio) && exactSpend != null && Number.isFinite(side.totalGmv) && side.totalGmv !== 0) {
        side.feeRatio = round(exactSpend / side.totalGmv, 6);
      }
    }
    return {
      subject,
      competitor,
      aligned: buildAlignedMetrics(card, { subject: subject.visitorClosed, competitor: competitor.visitorClosed })
    };
  }

  function buildSubjectDaily(cards, subjectItemId, successItemId, period, periodMetrics) {
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
    const missingDates = expectedDates.filter(date => !byDate.has(date));
    const cardMetricSignature = card => [...new Set((card?.metricRows || []).map(row => metricIdentity(row.name)))].sort().join("|");
    const duplicateDates = expectedDates.filter(date => {
      const signatures = (byDate.get(date) || []).map(cardMetricSignature);
      return signatures.length > new Set(signatures).size;
    });
    const unresolvedDates = [];
    const rows = [];
    for (const date of expectedDates) {
      const candidates = (byDate.get(date) || []).sort((left, right) => String(right.capturedAt || "").localeCompare(String(left.capturedAt || "")));
      if (!candidates.length) continue;
      const dailyMetrics = buildMetrics(mergeMetricCards(candidates)).subject;
      const orders = numberOrNull(dailyMetrics.orders);
      const aov = numberOrNull(dailyMetrics.aov);
      let gmv = null;
      if (orders === 0) gmv = 0;
      else if (orders != null && orders > 0 && aov != null && aov >= 0) gmv = round(orders * aov);
      if (orders == null || gmv == null) unresolvedDates.push(date);
      rows.push({
        date, orders, aov, gmv,
        totalSpend: isDisclosedMetric(dailyMetrics.spend) ? dailyMetrics.spend : null,
        feeRatio: isDisclosedMetric(dailyMetrics.feeRatio) ? dailyMetrics.feeRatio : null,
        metrics: { ...dailyMetrics }
      });
    }
    const resolvedRows = rows.filter(row => Number.isFinite(row.orders) && Number.isFinite(row.gmv));
    const orderTotal = round(resolvedRows.reduce((sum, row) => sum + row.orders, 0));
    const gmvTotal = round(resolvedRows.reduce((sum, row) => sum + row.gmv, 0));
    const expectedOrders = numberOrNull(periodMetrics?.subject?.orders);
    const expectedGmv = numberOrNull(periodMetrics?.subject?.totalGmv);
    const ordersClosed = Number.isFinite(expectedOrders) && resolvedRows.length === expectedDates.length
      && Math.abs(orderTotal - expectedOrders) <= 0.000001;
    const gmvDifference = Number.isFinite(expectedGmv) && Number.isFinite(gmvTotal) ? round(Math.abs(gmvTotal - expectedGmv)) : null;
    const gmvClosed = Number.isFinite(gmvDifference) && resolvedRows.length === expectedDates.length && gmvDifference <= 0.01;
    const complete = expectedDates.length > 0 && !missingDates.length && !duplicateDates.length && !unresolvedDates.length
      && rows.length === expectedDates.length && ordersClosed && gmvClosed;
    return {
      rows,
      expectedDates,
      missingDates,
      duplicateDates,
      unresolvedDates,
      orderTotal,
      expectedOrders,
      ordersClosed,
      gmvTotal,
      expectedGmv,
      gmvDifference,
      gmvClosed,
      complete
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

  function enrichSubjectDailyWithLine(subjectDaily, daily) {
    const byDate = new Map((daily?.rows || []).map(row => [row.date, row]));
    for (const row of subjectDaily?.rows || []) {
      const lineRow = byDate.get(row.date);
      const pairedChannels = lineRow?.subjectChannelSpend || {};
      row.channelFieldCoverage = Number(lineRow?.subjectChannelFieldCoverage || 0);
      if (row.channelFieldCoverage > 0) row.channelSpend = { ...pairedChannels };
      if (!isDisclosedMetric(row.totalSpend) && Number.isFinite(lineRow?.subjectTotalSpend)) {
        row.totalSpend = lineRow.subjectTotalSpend;
      }
      if (!isDisclosedMetric(row.feeRatio) && Number.isFinite(row.totalSpend) && Number.isFinite(row.gmv) && row.gmv !== 0) {
        row.feeRatio = round(row.totalSpend / row.gmv, 6);
      }
      const dailyMetrics = row.metrics || {};
      if (!isDisclosedMetric(dailyMetrics.spend) && Number.isFinite(row.totalSpend)) dailyMetrics.spend = row.totalSpend;
      if (!isDisclosedMetric(dailyMetrics.feeRatio) && isDisclosedMetric(row.feeRatio)) dailyMetrics.feeRatio = row.feeRatio;
      if (!isDisclosedMetric(dailyMetrics.ppc)) dailyMetrics.ppc = costPerClick(numberOrNull(row.totalSpend), dailyMetrics.marketingClicks);
      if (!isDisclosedMetric(dailyMetrics.roi)) dailyMetrics.roi = returnOnSpend(dailyMetrics.paidGmv, numberOrNull(row.totalSpend));
      row.metrics = dailyMetrics;
    }
    const expectedDates = Array.isArray(subjectDaily?.expectedDates) && subjectDaily.expectedDates.length
      ? subjectDaily.expectedDates
      : (daily?.expectedDates || []);
    const coverageModel = summarizeSpendCoverage(subjectDaily?.rows || [], expectedDates, Boolean(subjectDaily?.rows?.length));
    subjectDaily.totalSpend = coverageModel.spend;
    subjectDaily.channelSpend = coverageModel.channelSpend;
    subjectDaily.spendCoverageDays = coverageModel.coverageDays;
    subjectDaily.spendExpectedDays = coverageModel.expectedDays;
    subjectDaily.spendMissingDates = coverageModel.missingDates;
    subjectDaily.spendComplete = coverageModel.complete;
    subjectDaily.spendPartial = coverageModel.partial;
    subjectDaily.spendSingleDayPartial = coverageModel.singleDayPartial;
    subjectDaily.spendUsable = coverageModel.usable;
    subjectDaily.spendCoverage = publicSpendCoverage(coverageModel);
    return subjectDaily;
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

  function isDisclosedMetric(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === "string" && /^(?:|[-–—]|--|暂无|无数据|null|undefined)$/i.test(value.trim())) return false;
    return true;
  }

  function allocationTolerance(base) {
    return Math.max(0.05, Math.abs(base) * 0.000001);
  }

  function buildSceneRows(responses, totalSpends = {}) {
    const level1Response = responses.find(response => response.level === 1) || null;
    const parentNames = new Map((level1Response?.rows || []).map(row => [String(row.sceneId || ""), row.sceneName]));
    const subjectLevel1Charges = (level1Response?.rows || []).map(row => numberOrNull(sceneMetric(row, "charge", "subject")));
    const sceneSubjectSpend = subjectLevel1Charges.length && subjectLevel1Charges.every(Number.isFinite)
      ? round(subjectLevel1Charges.reduce((sum, value) => sum + value, 0))
      : null;
    const passed = typeof totalSpends === "number" ? { competitor: totalSpends } : (totalSpends || {});
    const totals = {
      subject: numberOrNull(passed.subject) ?? sceneSubjectSpend,
      competitor: numberOrNull(passed.competitor)
    };
    const parentSpend = new Map();
    const result = { level1: [], level2: [], validationIssues: [], allocationTotals: { ...totals } };

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
      const directDealAmount = sceneMetric(row, "directDealAmount", side);
      const apiCpc = sceneMetric(row, "cpc", side);
      const apiDirectRoi = sceneMetric(row, "directRoi", side);
      const calculatedCpc = Number.isFinite(allocated) ? costPerClick(allocated, click) : null;
      const calculatedDirectRoi = Number.isFinite(allocated) ? returnOnSpend(directDealAmount, allocated) : null;
      const values = {
        role, level: response.level, primary, secondary, sceneId: row.sceneId,
        parentSceneId: response.parentSceneId || "",
        charge, ratio: ratioValue, allocated,
        impression, click,
        ctr: sceneMetric(row, "ctr", side),
        cpc: preferExactMetric(apiCpc, calculatedCpc),
        directDealAmount,
        directRoi: preferExactMetric(apiDirectRoi, calculatedDirectRoi)
      };
      if (response.level === 1 && Number.isFinite(allocated)) {
        parentSpend.set(`${side}|${String(row.sceneId || "")}`, allocated);
      }
      if (ratioValue !== "" && ratioValue != null && ratio == null) {
        result.validationIssues.push(`${role}${primary}${secondary ? `/${secondary}` : ""}的消耗占比无效`);
      }
      if (isDisclosedMetric(click) && !parseVagueRange(click)) {
        result.validationIssues.push(`${role}${primary}${secondary ? `/${secondary}` : ""}的点击量区间无效`);
      }
      if (isDisclosedMetric(directDealAmount) && !parseVagueRange(directDealAmount)) {
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
          if (pair.some(hasSceneData)) target.push(...pair);
        }
      }
    };
    appendPairs(responses.filter(value => value.level === 1), result.level1);
    appendPairs(responses.filter(value => value.level === 2), result.level2);
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

  function enrichMetrics(metrics, sceneRows, daily, subjectDaily) {
    const subjectLevel1 = sceneRows.level1.filter(row => row.role === "主体");
    const competitorLevel1 = sceneRows.level1.filter(row => row.role === "对手");
    const spendCoverageBySide = {
      subject: subjectDaily?.spendCoverage || null,
      competitor: daily?.spendCoverage || null
    };
    const level1BySide = { subject: subjectLevel1, competitor: competitorLevel1 };

    // INDEX_CARD 严格周期值优先，其次是一级场景精确花费。两者都没有时，
    // 完整日序列可作为严格周期；若仅缺 1 天，使用真实返回日的直接求和，
    // 但显式标记 coverage-period，不把缺失日当成 0。缺 2 天仍仅用于场景覆盖分配。
    for (const side of ["subject", "competitor"]) {
      const coverage = spendCoverageBySide[side];
      let spendScope = isDisclosedMetric(metrics[side].spend) ? "strict-period" : "missing";
      if (!isDisclosedMetric(metrics[side].spend)) {
        const sceneSpend = sumFinite(level1BySide[side].map(row => numberOrNull(row.charge)));
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
    }
    metrics.subject.paidGmv = metrics.subject.paidGmv ?? sumMetricRanges(subjectLevel1.map(row => row.directDealAmount));
    metrics.competitor.paidGmv = metrics.competitor.paidGmv ?? sumMetricRanges(competitorLevel1.map(row => row.directDealAmount));
    metrics.subject.attributedGmv = metrics.subject.paidGmv;
    metrics.competitor.attributedGmv = metrics.competitor.paidGmv;
    for (const side of ["subject", "competitor"]) {
      const values = level1BySide[side];
      const coverage = spendCoverageBySide[side];
      if (!isDisclosedMetric(metrics[side].marketingClicks)) {
        metrics[side].marketingClicks = sumMetricRanges(values.map(row => row.click));
      }
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
      } else if (isDisclosedMetric(existingKeywordShare)) {
        metrics[side].keywordSpend = null;
        metrics[side].keywordShare = existingKeywordShare;
        metrics[side].keywordShareSource = "index-card";
      } else {
        metrics[side].keywordSpend = null;
        metrics[side].keywordShare = apiKeywordShare;
        metrics[side].keywordShareSource = Number.isFinite(apiKeywordShare) ? "api-ratio" : "missing";
      }
      const ratios = values.map(row => numberOrNull(row.ratio));
      const sum = ratios.reduce((total, value) => total + value, 0);
      metrics[side].channelHhi = ratios.length && ratios.every(Number.isFinite) && Math.abs(sum - 1) <= 0.01 ? round(ratios.reduce((total, value) => total + value ** 2, 0), 6) : null;
      if (!isDisclosedMetric(metrics[side].feeRatio)) {
        metrics[side].feeRatio = Number.isFinite(metrics[side].spend) && Number.isFinite(metrics[side].totalGmv) && metrics[side].totalGmv !== 0 ? round(metrics[side].spend / metrics[side].totalGmv, 6) : null;
      }
      if (!isDisclosedMetric(metrics[side].roas)) {
        metrics[side].roas = Number.isFinite(metrics[side].spend) && metrics[side].spend !== 0 && Number.isFinite(metrics[side].totalGmv) ? round(metrics[side].totalGmv / metrics[side].spend, 4) : null;
      }
      if (!isDisclosedMetric(metrics[side].ppc)) metrics[side].ppc = costPerClick(metrics[side].spend, metrics[side].marketingClicks);
      if (!isDisclosedMetric(metrics[side].roi)) metrics[side].roi = returnOnSpend(metrics[side].paidGmv, metrics[side].spend);
      metrics[side].paidGmvContribution = contributionRatio(metrics[side].paidGmv, metrics[side].totalGmv);
      metrics[side].paidOrderContribution = contributionRatio(metrics[side].paidOrders, numberOrNull(metrics[side].orders));
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
      const missing = required.filter(([key]) => !isDisclosedMetric(row[key])).map(([, label]) => label);
      if (!missing.length) continue;
      const location = `${row.role}${row.level === 1 ? "一级" : "二级"}场景 ${row.primary}${row.secondary ? `/${row.secondary}` : ""}`;
      issues.push(`${location}缺少可披露或可严格计算的${missing.join("、")}`);
    }
    return [...new Set(issues)];
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

    function audit(path, parser, status, reason = "") {
      const entry = auditMap.get(path) || { path, records: 0, parsed: 0, empty: 0, failed: 0, parsers: new Set(), reasons: new Set() };
      entry.records += 1;
      entry.parsers.add(parser);
      entry[status] += 1;
      if (reason) entry.reasons.add(reason);
      auditMap.set(path, entry);
    }

    for (const record of scoped) {
      const result = classifyGrowthRecord(record);
      audit(result.path, result.parser, result.status, result.reason);
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
      path: entry.path, records: entry.records, parsed: entry.parsed, empty: entry.empty, failed: entry.failed,
      parsers: [...entry.parsers], reasons: [...entry.reasons]
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
    const targetSuccess = successItems
      .filter(value => !successItemId || value.itemId === successItemId)
      .sort((left, right) => Number(right.source === "selected") - Number(left.source === "selected") || String(right.capturedAt || "").localeCompare(String(left.capturedAt || "")))[0] || null;
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
    const subjectDaily = buildSubjectDaily(cards, subjectItemId, successItemId, period, metrics);
    if (subjectDaily.duplicateDates.length) {
      notes.push(`主体逐日核心指标日期重复，已按最新响应去重：${subjectDaily.duplicateDates.join("、")}`);
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
    enrichSubjectDailyWithLine(subjectDaily, daily);
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
    const dedupScenes = [];
    const seenScene = new Set();
    for (const scene of targetScenes.sort((left, right) => String(right.capturedAt || "").localeCompare(String(left.capturedAt || "")))) {
      const key = `${scene.level}|${scene.parentSceneId || ""}`;
      if (!seenScene.has(key)) { seenScene.add(key); dedupScenes.push(scene); }
    }
    if (!dedupScenes.some(scene => scene.level === 1)) blockingIssues.push("没有找到与目标周期匹配的一级投放场景响应");
    const level1 = dedupScenes.find(scene => scene.level === 1);
    const expectedParents = [...new Set((level1?.rows || []).map(row => String(row.sceneId || "")).filter(Boolean))];
    const capturedParents = new Set(dedupScenes.filter(scene => scene.level === 2).map(scene => String(scene.parentSceneId || "")));
    const missingParents = expectedParents.filter(parent => !capturedParents.has(parent));
    if (missingParents.length) blockingIssues.push(`缺少 ${missingParents.length} 个一级场景的二级明细响应：${missingParents.join("、")}`);
    const exactSubjectSpend = numberOrNull(metrics.subject.spend);
    const exactCompetitorSpend = numberOrNull(metrics.competitor.spend);
    const sceneSubjectSpend = sumFinite((level1?.rows || []).map(row => numberOrNull(sceneMetric(row, "charge", "subject"))));
    const sceneCompetitorSpend = sumFinite((level1?.rows || []).map(row => numberOrNull(sceneMetric(row, "charge", "competitor"))));
    const subjectCoverageSpend = subjectDaily.spendUsable ? numberOrNull(subjectDaily.totalSpend) : null;
    const competitorCoverageSpend = daily.spendUsable ? numberOrNull(daily.totalSpend) : null;
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
          : daily.spendComplete
            ? "strict-period-daily"
            : daily.spendPartial
              ? "coverage-period"
              : "missing",
      subjectStart: subjectDaily.spendPartial ? subjectDaily.spendCoverage.startDate : period.startDate,
      subjectEnd: subjectDaily.spendPartial ? subjectDaily.spendCoverage.endDate : period.endDate,
      subjectDays: subjectDaily.spendPartial ? subjectDaily.spendCoverageDays : period.days,
      competitorStart: daily.spendPartial ? daily.spendCoverage.startDate : period.startDate,
      competitorEnd: daily.spendPartial ? daily.spendCoverage.endDate : period.endDate,
      competitorDays: daily.spendPartial ? daily.spendCoverageDays : period.days
    };
    if (sceneRows.validationIssues.length) blockingIssues.push(...sceneRows.validationIssues);
    enrichMetrics(metrics, sceneRows, daily, subjectDaily);
    const promotionIssues = promotionDetailIssues(sceneRows);
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

    const completenessStatus = blockingIssues.length ? "blocked" : warnings.length ? "ready-with-warnings" : "ready";
    return {
      pageType: "growth", period, item, targetSuccess, successItems, targetCard, cards, datasetTables, line, daily, subjectDaily,
      stages: line?.stages || [], sceneResponses: dedupScenes, sceneRows, keywords: targetKeywords?.rows || [], metrics,
      definitions: parsedDefinitions,
      completeness: {
        status: completenessStatus,
        businessRecords: endpointCoverage.reduce((sum, entry) => sum + entry.records, 0),
        parsedRecords: endpointCoverage.reduce((sum, entry) => sum + entry.parsed + entry.empty, 0),
        failedRecords: endpointCoverage.reduce((sum, entry) => sum + entry.failed, 0),
        platformGap: {
          days: daily.platformGapDays,
          dates: daily.platformGapDates,
          tolerated: daily.platformGapTolerated,
          toleranceDays: PLATFORM_DAY_GAP_TOLERANCE,
          coverageDays: daily.coverageDays,
          expectedDays: daily.expectedDates.length
        },
        endpointCoverage, blockingIssues: [...new Set(blockingIssues)], warnings: [...new Set(warnings)], notes: [...new Set(notes)]
      }
    };
  }

  return {
    CHANNELS, SCENE_CODES, STANDARD_PATHS, PLATFORM_DAY_GAP_TOLERANCE, METRIC_ALIAS_GROUPS, metricIdentity, canonicalPath, recordPath, parseBody, parseVagueRange,
    numberOrNull, calculableMetricValue, normalizeDate, enumerateDates, lineGmvIndex, fitDailyGmv, costPerClick, sumMetricRanges, returnOnSpend, contributionRatio,
    datasetRequestType, transportOnlyReason, isTransportOnlyRecord, classifyGrowthRecord, deriveGrowth
  };
});
