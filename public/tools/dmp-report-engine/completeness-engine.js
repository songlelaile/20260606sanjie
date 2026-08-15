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
    const filters = parseJsonLike(request?.[key]);
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
    const competitorKeys = ["succItemValue", "c_value", "cValue", "compareValue", "competitorValue"];
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
    const parts = text.split(/[~～]/);
    if (parts.length === 2) {
      const leftMultiplier = magnitudeScalar(`1${String(parts[0]).trim().match(/(亿|万|千|[wWkK])(?=%?(?:元)?$)/)?.[1] || ""}`) || 1;
      const rightMultiplier = magnitudeScalar(`1${String(parts[1]).trim().match(/(亿|万|千|[wWkK])(?=%?(?:元)?$)/)?.[1] || ""}`) || 1;
      const sharedMultiplier = leftMultiplier > 1 ? leftMultiplier : rightMultiplier;
      const min = magnitudeScalar(parts[0], sharedMultiplier);
      const max = magnitudeScalar(parts[1], sharedMultiplier);
      return min == null || max == null ? null : { min, max, exact: false };
    }
    const exact = magnitudeScalar(text);
    return exact == null ? null : { min: exact, max: exact, exact: true };
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

  function valueFromPair(value, side) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return side === "subject"
        ? (value.itemValue ?? value.value ?? value.selfValue ?? null)
        : (value.succItemValue ?? value.c_value ?? value.competitorValue ?? null);
    }
    return side === "subject" ? value : null;
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
      pairs = card.fields.slice(0, card.values.length).map((field, index) => ({ field, value: card.values[index] || {} }));
    } else if (Array.isArray(card.list)) {
      pairs = card.list.map(row => ({ field: row.field || { name: row.name, description: row.description, id: row.id }, value: row.value && typeof row.value === "object" ? row.value : row }));
    } else return null;
    const metrics = {};
    for (const pair of pairs) {
      const name = String(pair.field?.name || pair.value?.name || "").trim();
      if (!name) continue;
      metrics[name] = {
        fieldId: pair.field?.id ?? null,
        description: pair.field?.description ?? null,
        subject: pair.value?.value ?? pair.value?.periodValue ?? pair.value?.subjectValue ?? null,
        competitor: pair.value?.c_value ?? pair.value?.compareValue ?? pair.value?.competitorValue ?? null,
        difference: pair.value?.diff_value ?? pair.value?.difference ?? null,
        trend: pair.value?.trend ?? null
      };
    }
    const scope = datasetScope(record);
    const range = parseDateRange(container?.rangeDesc || card?.rangeDesc);
    return {
      capturedAt: record?.capturedAt || null,
      start: range.start || scope.subjectStart,
      end: range.end || scope.subjectEnd,
      rangeDescription: container?.rangeDesc || null,
      ...scope,
      metrics
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
      detailUrl: data.detailUrl ?? "", pictureUrl: data.pictUrl ?? data.picUrl ?? data.imageUrl ?? "", raw: data
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
        pictureUrl: row.itemPictUrl ?? row.pictureUrl ?? "", description,
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

  function extractLine(record, body) {
    const data = body?.data;
    if (!data || !Array.isArray(data.lineInfo)) return null;
    const daily = data.lineInfo.map(row => {
      const channelSpend = Object.fromEntries(CHANNELS.map(([apiName, label]) => [label, numberOrNull(row[apiName])]));
      const values = Object.values(channelSpend);
      return {
        date: normalizeDate(row.date), gmvIndex: lineGmvIndex(row), channelSpend,
        channelFieldCoverage: values.filter(Number.isFinite).length,
        totalSpend: values.every(Number.isFinite) ? round(values.reduce((sum, value) => sum + value, 0)) : null
      };
    }).filter(row => row.date).sort((left, right) => left.date.localeCompare(right.date));
    const stages = (data.stages || []).map((stage, index) => {
      const range = parseDateRange(stage.rangeTime || stage.dateRange);
      const actions = extractStageActions(stage.actionText ?? stage.actions);
      return {
        stage: String(stage.stage ?? stage.stageCode ?? index + 1), start: range.start, end: range.end,
        name: stage.title ?? stage.stageName ?? stage.phase ?? `阶段${index + 1}`,
        description: stage.metricText ?? stage.description ?? "",
        adStrategy: stage.adTitle ?? actions.adStrategy,
        executionDetails: stage.adDetails ?? actions.executionDetails,
        operations: stage.operation ?? actions.operations
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
        sceneId: row.sceneId == null ? "" : String(row.sceneId), sceneName: row.sceneName ?? row.channelName ?? row.promotion_scene ?? row.name ?? "",
        charge: row.charge ?? row.spend ?? row.cost ?? null, chargeRatio: row.chargeRatio ?? row.costRate ?? row.spendRate ?? null,
        impression: row.impression ?? row.pv_di ?? row.pv ?? null, click: row.click ?? row.clickCnt ?? null,
        ctr: row.ctr ?? row.ctr_di ?? row.clickRate ?? null, cpc: row.cpc ?? row.cost_per ?? row.clickCost ?? null,
        directDealAmount: row.directDealAmount ?? row.directAlipayAmt ?? row.alipayAmt ?? null,
        directRoi: row.directRoi ?? row.roi ?? row.roi1d ?? null
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

  function metric(card, name) {
    return card?.metrics?.[name] || { subject: null, competitor: null };
  }

  function metricByAliases(card, aliases) {
    const normalized = aliases.map(value => String(value).replace(/\s+/g, "").toLowerCase());
    for (const [name, value] of Object.entries(card?.metrics || {})) {
      const key = String(name).replace(/\s+/g, "").toLowerCase();
      if (normalized.includes(key)) return value;
    }
    return { subject: null, competitor: null };
  }

  function rangeContains(range, value) {
    return Boolean(range && Number.isFinite(value) && (range.min == null || value >= range.min) && (range.max == null || value <= range.max));
  }

  function buildMetrics(card) {
    const read = (name, side) => calculableMetricValue(metric(card, name)[side]);
    const paidGmv = metricByAliases(card, ["付费成交额", "付费成交金额", "营销推广成交额", "营销推广成交金额", "广告归因GMV", "广告成交额", "广告成交金额"]);
    const paidOrders = metricByAliases(card, ["付费成交笔数", "营销推广成交笔数", "广告成交笔数", "广告归因成交笔数", "alipayCnt1d"]);
    const subject = {
      marketingClicks: read("营销推广点击量", "subject"), naturalClicks: read("自然点击量", "subject"),
      orders: read("成交笔数", "subject"), conversion: read("支付转化率", "subject"), aov: read("笔单价", "subject"),
      cartRate: read("加购率", "subject"), ipv: read("IPV", "subject"),
      paidGmv: calculableMetricValue(paidGmv.subject), paidOrders: calculableMetricValue(paidOrders.subject)
    };
    const competitor = {
      marketingClicks: read("营销推广点击量", "competitor"), naturalClicks: read("自然点击量", "competitor"),
      orders: read("成交笔数", "competitor"), conversion: read("支付转化率", "competitor"), aov: read("笔单价", "competitor"),
      cartRate: read("加购率", "competitor"), ipv: read("IPV", "competitor"),
      paidGmv: calculableMetricValue(paidGmv.competitor), paidOrders: calculableMetricValue(paidOrders.competitor)
    };
    for (const side of [subject, competitor]) {
      const orders = numberOrNull(side.orders);
      const aov = numberOrNull(side.aov);
      const conversion = numberOrNull(side.conversion);
      side.totalGmv = orders != null && aov != null ? round(orders * aov) : null;
      const visitor = orders != null && conversion != null && conversion !== 0 ? round(orders / conversion) : null;
      const ipvExact = numberOrNull(side.ipv);
      const ipvRange = parseVagueRange(side.ipv);
      const closed = visitor != null && ((ipvExact != null && ipvExact !== 0 && Math.abs(visitor - ipvExact) / Math.abs(ipvExact) <= 0.01) || rangeContains(ipvRange, visitor));
      side.visitors = closed ? visitor : null;
      side.visitorClosed = closed;
    }
    return { subject, competitor };
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

  function buildDaily(line, period, periodGmv) {
    const expected = enumerateDates(period.startDate, period.endDate);
    const selected = expected.map(date => line?.daily.find(row => row.date === date)).filter(Boolean);
    const missingDates = expected.filter(date => !selected.some(row => row.date === date));
    const missingChannelDates = selected.filter(row => row.channelFieldCoverage < CHANNELS.length).map(row => row.date);
    const missingIndexDates = selected.filter(row => !Number.isFinite(row.gmvIndex)).map(row => row.date);
    const invalidIndexDates = selected.filter(row => Number.isFinite(row.gmvIndex) && row.gmvIndex < 0).map(row => row.date);
    const gmvFit = missingDates.length
      ? { ...fitDailyGmv([], periodGmv), reason: "missing-date", dailyGmv: selected.map(() => null) }
      : fitDailyGmv(selected, periodGmv);
    const complete = Boolean(line && !missingDates.length && !missingChannelDates.length && !missingIndexDates.length && !invalidIndexDates.length && gmvFit.status === "ready");
    const rows = selected.map((row, index) => {
      const dailyGmv = gmvFit.dailyGmv[index];
      return {
        ...row, dailyGmv,
        feeRatio: Number.isFinite(row.totalSpend) && Number.isFinite(dailyGmv) && dailyGmv !== 0 ? round(row.totalSpend / dailyGmv, 6) : null,
        stage: line?.stages.find(stage => (!stage.start || row.date >= stage.start) && (!stage.end || row.date <= stage.end))?.name || ""
      };
    });
    const spendRows = rows.filter(row => Number.isFinite(row.totalSpend));
    const spendDates = new Set(spendRows.map(row => row.date));
    const spendMissingDates = expected.filter(date => !spendDates.has(date));
    const spendCoverageDays = spendRows.length;
    const spendComplete = Boolean(line && spendMissingDates.length === 0);
    const spendPartial = Boolean(line && spendMissingDates.length === 1 && spendCoverageDays > 0);
    const spendUsable = spendComplete || spendPartial;
    const totalSpend = spendUsable ? round(spendRows.reduce((sum, row) => sum + row.totalSpend, 0)) : null;
    const channelSpend = Object.fromEntries(CHANNELS.map(([, label]) => {
      const values = spendRows.map(row => row.channelSpend[label]);
      return [label, spendUsable && values.length === spendCoverageDays && values.every(Number.isFinite)
        ? round(values.reduce((sum, value) => sum + value, 0))
        : null];
    }));
    return {
      rows, expectedDates: expected, missingDates, missingChannelDates, missingIndexDates, invalidIndexDates, complete, indexSum: gmvFit.indexSum, gmvFit,
      totalSpend, channelSpend, spendCoverageDays, spendExpectedDays: expected.length, spendMissingDates, spendComplete, spendPartial
    };
  }

  function sceneMetric(row, key, side) {
    const raw = valueFromPair(row?.[key], side);
    const numeric = numberOrNull(raw);
    return numeric == null ? (raw ?? "") : numeric;
  }

  function buildSceneRows(responses, totalCompetitorSpend) {
    const level1Response = responses.find(response => response.level === 1) || null;
    const parentRatios = new Map((level1Response?.rows || []).map(row => [String(row.sceneId || ""), numberOrNull(valueFromPair(row.chargeRatio, "competitor"))]));
    const parentNames = new Map((level1Response?.rows || []).map(row => [String(row.sceneId || ""), row.sceneName]));
    const result = { level1: [], level2: [] };
    for (const response of responses) {
      for (const row of response.rows) {
        const primary = response.level === 1 ? row.sceneName : (parentNames.get(String(response.parentSceneId)) || SCENE_CODES[String(response.parentSceneId)] || `场景${response.parentSceneId}`);
        const secondary = response.level === 2 ? String(row.sceneName || "").replace(new RegExp(`^${primary}-?`), "") : "";
        for (const side of ["subject", "competitor"]) {
          const role = side === "subject" ? "主体" : "对手";
          const charge = sceneMetric(row, "charge", side);
          const ratioValue = sceneMetric(row, "chargeRatio", side);
          const ratio = numberOrNull(ratioValue);
          let allocated = numberOrNull(charge);
          if (side === "competitor" && allocated == null && Number.isFinite(totalCompetitorSpend) && ratio != null) {
            const base = response.level === 1 ? totalCompetitorSpend : totalCompetitorSpend * (parentRatios.get(String(response.parentSceneId)) ?? NaN);
            if (Number.isFinite(base)) allocated = round(base * ratio);
          }
          const impression = sceneMetric(row, "impression", side);
          const click = sceneMetric(row, "click", side);
          const directDealAmount = sceneMetric(row, "directDealAmount", side);
          const calculatedCpc = Number.isFinite(allocated) ? costPerClick(allocated, click) : null;
          const calculatedDirectRoi = Number.isFinite(allocated) ? returnOnSpend(directDealAmount, allocated) : null;
          const values = {
            role, level: response.level, primary, secondary, sceneId: row.sceneId,
            charge, ratio: ratioValue, allocated,
            impression, click,
            ctr: sceneMetric(row, "ctr", side), cpc: calculatedCpc ?? sceneMetric(row, "cpc", side),
            directDealAmount, directRoi: calculatedDirectRoi ?? sceneMetric(row, "directRoi", side)
          };
          const hasData = [values.charge, values.ratio, values.impression, values.click, values.ctr, values.cpc, values.directDealAmount, values.directRoi]
            .some(value => value !== "" && value !== null && value !== undefined);
          if (hasData) result[response.level === 1 ? "level1" : "level2"].push(values);
        }
      }
    }
    return result;
  }

  function sumFinite(values) {
    return values.length && values.every(Number.isFinite) ? round(values.reduce((sum, value) => sum + value, 0)) : null;
  }

  function enrichMetrics(metrics, sceneRows, daily) {
    const subjectLevel1 = sceneRows.level1.filter(row => row.role === "主体");
    const competitorLevel1 = sceneRows.level1.filter(row => row.role === "对手");
    metrics.subject.spend = sumFinite(subjectLevel1.map(row => numberOrNull(row.charge)));
    metrics.competitor.spend = daily.totalSpend;
    metrics.subject.paidGmv = metrics.subject.paidGmv ?? sumMetricRanges(subjectLevel1.map(row => row.directDealAmount));
    metrics.competitor.paidGmv = metrics.competitor.paidGmv ?? sumMetricRanges(competitorLevel1.map(row => row.directDealAmount));
    metrics.subject.attributedGmv = metrics.subject.paidGmv;
    metrics.competitor.attributedGmv = metrics.competitor.paidGmv;
    for (const side of ["subject", "competitor"]) {
      const values = side === "subject" ? subjectLevel1 : competitorLevel1;
      const keyword = values.find(row => row.primary === "关键词推广");
      metrics[side].keywordShare = numberOrNull(keyword?.ratio);
      const ratios = values.map(row => numberOrNull(row.ratio));
      const sum = ratios.reduce((total, value) => total + value, 0);
      metrics[side].channelHhi = ratios.length && ratios.every(Number.isFinite) && Math.abs(sum - 1) <= 0.01 ? round(ratios.reduce((total, value) => total + value ** 2, 0), 6) : null;
      metrics[side].feeRatio = Number.isFinite(metrics[side].spend) && Number.isFinite(metrics[side].totalGmv) && metrics[side].totalGmv !== 0 ? round(metrics[side].spend / metrics[side].totalGmv, 6) : null;
      metrics[side].roas = Number.isFinite(metrics[side].spend) && metrics[side].spend !== 0 && Number.isFinite(metrics[side].totalGmv) ? round(metrics[side].totalGmv / metrics[side].spend, 4) : null;
      metrics[side].ppc = costPerClick(metrics[side].spend, metrics[side].marketingClicks);
      metrics[side].roi = returnOnSpend(metrics[side].paidGmv, metrics[side].spend);
      metrics[side].paidGmvContribution = contributionRatio(metrics[side].paidGmv, metrics[side].totalGmv);
      metrics[side].paidOrderContribution = contributionRatio(metrics[side].paidOrders, numberOrNull(metrics[side].orders));
    }
    return metrics;
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

    const targetCard = cards.filter(card => samePeriod(card, period)
      && card.subjectItemIds.includes(subjectItemId) && card.competitorItemIds.includes(successItemId))
      .sort((left, right) => String(right.capturedAt || "").localeCompare(String(left.capturedAt || "")))[0] || null;
    if (!targetCard) blockingIssues.push(`没有找到与 ${period.startDate || "?"}~${period.endDate || "?"} 完全一致的核心指标卡`);
    const metrics = buildMetrics(targetCard);
    if (![metrics.subject.orders, metrics.subject.aov, metrics.competitor.orders, metrics.competitor.aov].every(value => numberOrNull(value) != null)) {
      blockingIssues.push("主体或目标成功品缺少同周期精确成交笔数/笔单价，无法落实总GMV");
    }

    const line = chooseLine(lines, subjectItemId, successItemId, period);
    if (!line) blockingIssues.push("没有找到与主体、成功品及目标周期匹配的成长趋势序列");
    const daily = buildDaily(line, period, numberOrNull(metrics.competitor.totalGmv));
    if (daily.missingDates.length) blockingIssues.push(`目标周期缺少 ${daily.missingDates.length} 日趋势：${daily.missingDates.join("、")}`);
    if (daily.missingChannelDates.length) blockingIssues.push(`有 ${daily.missingChannelDates.length} 日五渠道消耗字段不完整`);
    if (daily.missingIndexDates.length) blockingIssues.push(`有 ${daily.missingIndexDates.length} 日 GMV 序列值缺失`);
    if (daily.invalidIndexDates.length) blockingIssues.push(`有 ${daily.invalidIndexDates.length} 日 GMV 序列值小于 0`);
    if (!Number.isFinite(metrics.competitor.totalGmv)) blockingIssues.push("目标成功品缺少精确周期GMV，不能把GMV序列换算为日金额");
    if (!daily.missingDates.length && !daily.missingIndexDates.length && !daily.invalidIndexDates.length
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
    const sceneRows = buildSceneRows(dedupScenes, daily.spendComplete ? daily.totalSpend : null);
    enrichMetrics(metrics, sceneRows, daily);
    if (sceneRows.level1.some(row => row.role === "对手" && numberOrNull(row.ratio) != null) && !daily.spendComplete) {
      blockingIssues.push("竞品场景只有消耗比例，但缺少同周期完整总消耗，不能分配场景金额");
    }

    const targetKeywords = keywords.filter(value => value.itemId === subjectItemId
      && value.successItemIds.includes(successItemId) && samePeriod(value, period))
      .sort((left, right) => String(right.capturedAt || "").localeCompare(String(left.capturedAt || "")))[0] || null;
    if (!targetKeywords) blockingIssues.push("未捕获与主体、成功品及目标周期精确匹配的关键词响应");
    if (Array.isArray(options.sceneMissed) && options.sceneMissed.length) blockingIssues.push(`场景明细渠道未遍历完整：${options.sceneMissed.join("、")}`);

    const completenessStatus = blockingIssues.length ? "blocked" : warnings.length ? "ready-with-warnings" : "ready";
    return {
      pageType: "growth", period, item, targetSuccess, successItems, targetCard, cards, datasetTables, line, daily,
      stages: line?.stages || [], sceneResponses: dedupScenes, sceneRows, keywords: targetKeywords?.rows || [], metrics,
      definitions: parsedDefinitions,
      completeness: {
        status: completenessStatus,
        businessRecords: endpointCoverage.reduce((sum, entry) => sum + entry.records, 0),
        parsedRecords: endpointCoverage.reduce((sum, entry) => sum + entry.parsed + entry.empty, 0),
        failedRecords: endpointCoverage.reduce((sum, entry) => sum + entry.failed, 0),
        endpointCoverage, blockingIssues: [...new Set(blockingIssues)], warnings: [...new Set(warnings)]
      }
    };
  }

  return {
    CHANNELS, SCENE_CODES, STANDARD_PATHS, canonicalPath, recordPath, parseBody, parseVagueRange,
    numberOrNull, calculableMetricValue, normalizeDate, enumerateDates, lineGmvIndex, fitDailyGmv, costPerClick, sumMetricRanges, returnOnSpend, contributionRatio,
    datasetRequestType, transportOnlyReason, isTransportOnlyRecord, classifyGrowthRecord, deriveGrowth
  };
});
