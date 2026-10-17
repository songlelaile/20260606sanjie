(function initDmpReportEngine(root, factory) {
  const completeness = root.DmpCompletenessEngine || (typeof module === "object" && module.exports ? require("./completeness-engine.js") : null);
  const api = factory(completeness);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DmpReportEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createDmpReportEngine(completenessEngine) {
  "use strict";

  // 成功品有两个来源：`/success/load` 是页面已选成功品（权威），`/success/item/list` 是搜索候选列表。
  // 两个都要监听，但排序时 load 优先，避免把搜索候选误判成目标对手。
  const EXPECTED_ENDPOINTS = [
    { path: "/api/goods/item/info", paths: ["/api/goods/item/info"], module: "商品概况" },
    { path: "/api/goods/grow/define/success/load", paths: ["/api/goods/grow/define/success/load", "/api/goods/grow/define/success/item/list"], module: "成功品" },
    { path: "/dataplatform/dataset/report/query.json", paths: ["/dataplatform/dataset/report/query.json"], module: "核心指标" },
    { path: "/api/goods/grow/comparison/scene/keyword", paths: ["/api/goods/grow/comparison/scene/keyword"], module: "关键词样本" },
    { path: "/api/goods/grow/comparison/scene", paths: ["/api/goods/grow/comparison/scene"], module: "投放场景" },
    { path: "/api/goods/grow/define/line/data", paths: ["/api/goods/grow/define/line/data"], module: "成长阶段与趋势" }
  ];

  function endpointPaths(endpoint) {
    return endpoint.paths || [endpoint.path];
  }

  function matchEndpoint(record) {
    const path = recordPath(record);
    for (const endpoint of EXPECTED_ENDPOINTS) {
      const index = endpointPaths(endpoint).findIndex(candidate => path.includes(candidate));
      if (index >= 0) return { endpoint, priority: index };
    }
    return null;
  }

  const REQUIRED_TABLES = [
    "报告总览", "对标总表", "商品与成功品", "周期汇总", "日GMV与费比", "渠道花费",
    "一级场景", "二级场景", "成长阶段数据", "基础指标对比", "关键词样本"
  ];

  const FORBIDDEN_COLUMN = /^(判断|结构解读|业务解读|复盘结论|趋势判断|建议动作|备注|证据等级|校验状态|反推口径|请求|接口路径|数据来源)$/;
  const DIRECTION_ONLY = /^(?:(?:比|较)(?:本品|对手|竞品)[高低]|[高低]于(?:本品|对手|竞品))$/;
  const EMPTY = "";
  const CHANNELS = [
    ["内容运营", "内容运营日消耗"],
    ["人群推广", "人群推广日消耗"],
    ["货品全站推", "货品全站推日消耗"],
    ["线索推广", "线索推广日消耗"],
    ["关键词推广", "关键词推广日消耗"]
  ];
  const SUBJECT_MINIMUM_PROMOTION_CONTRACT = completenessEngine?.SUBJECT_MINIMUM_PROMOTION_CONTRACT || Object.freeze([
    Object.freeze({ key: "spend", label: "推广消耗" }),
    Object.freeze({ key: "feeRatio", label: "费比" }),
    Object.freeze({ key: "roi", label: "ROI" }),
    Object.freeze({ key: "ppc", label: "PPC" })
  ]);
  const SUBJECT_MINIMUM_PROMOTION_METRICS = SUBJECT_MINIMUM_PROMOTION_CONTRACT;
  const CORE_METRIC_CONTRACT = completenessEngine?.CORE_METRIC_CONTRACT || Object.freeze([
    Object.freeze({ key: "totalGmv", label: "总GMV", sourceKeys: Object.freeze(["totalGmv"]) }),
    Object.freeze({ key: "paidGmv", label: "付费成交额", sourceKeys: Object.freeze(["paidGmv"]) }),
    Object.freeze({ key: "spend", label: "推广消耗", sourceKeys: Object.freeze(["spend"]) }),
    Object.freeze({ key: "feeRatio", label: "费比", sourceKeys: Object.freeze(["feeRatio"]) }),
    Object.freeze({ key: "roi", label: "ROI", sourceKeys: Object.freeze(["roi"]) }),
    Object.freeze({ key: "ppc", label: "PPC", sourceKeys: Object.freeze(["ppc"]) }),
    Object.freeze({ key: "paidGmvContribution", label: "付费金额占比", sourceKeys: Object.freeze(["paidGmvContribution", "paidAmountShare"]) }),
    Object.freeze({ key: "globalROAS", label: "全域ROAS", sourceKeys: Object.freeze(["globalROAS", "roas"]) })
  ]);

  function recordPath(record) {
    if (record && record.pathname) return String(record.pathname);
    try { return new URL(record?.url || "").pathname; } catch { return ""; }
  }

  function parseBody(record) {
    const source = typeof record?.body === "string" ? record.body.trim() : "";
    if (!source) return null;
    try { return JSON.parse(source); } catch {}
    const match = source.match(/^[\w$.[\]]+\s*\(([\s\S]*)\)\s*;?\s*$/);
    if (!match) return null;
    try { return JSON.parse(match[1]); } catch { return null; }
  }

  function walk(value, visitor, path = [], depth = 0) {
    if (depth > 15 || value == null) return;
    visitor(value, path);
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, visitor, path.concat(index), depth + 1));
    } else if (typeof value === "object") {
      Object.entries(value).forEach(([key, child]) => walk(child, visitor, path.concat(key), depth + 1));
    }
  }

  function collectObjects(value, predicate) {
    const result = [];
    walk(value, node => {
      if (node && typeof node === "object" && !Array.isArray(node) && predicate(node)) result.push(node);
    });
    return result;
  }

  function pick(object, keys) {
    if (!object || typeof object !== "object") return undefined;
    for (const key of keys) {
      if (object[key] !== undefined && object[key] !== null && object[key] !== "") return object[key];
    }
    return undefined;
  }

  function pickNested(object, parentKeys, childKeys) {
    for (const parent of parentKeys) {
      const child = object?.[parent];
      const value = pick(child, childKeys);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  function toNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    if (typeof value !== "string") return NaN;
    const text = value.trim().replace(/[,，￥¥]/g, "");
    if (!text || /[~～至]/.test(text)) return NaN;
    const percent = text.endsWith("%");
    const parsed = Number(text.replace(/%$/, ""));
    return Number.isFinite(parsed) ? (percent ? parsed / 100 : parsed) : NaN;
  }

  function percentRatio(value) {
    const number = toNumber(value);
    return Number.isFinite(number) ? (Math.abs(number) > 1 ? number / 100 : number) : NaN;
  }

  function round(value, digits = 2) {
    if (!Number.isFinite(value)) return EMPTY;
    const base = 10 ** digits;
    return Math.round((value + Number.EPSILON) * base) / base;
  }

  function valueOrBlank(value, percent = false) {
    const number = percent ? percentRatio(value) : toNumber(value);
    if (Number.isFinite(number)) return number;
    return value === undefined || value === null ? EMPTY : displayValue(value);
  }

  function displayValue(value) {
    if (value === null || value === undefined || value === "") return "";
    if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join("、");
    if (typeof value === "object") return "";
    return String(value);
  }

  function isPercentMetric(metric) {
    const semantic = String(metric || "");
    if (/排名变化/.test(semantic)) return false;
    if (/变化|变动|相对|环比|同比|差异|提升|下降/.test(semantic)) return true;
    if (/投入产出比|投产比|ROI|ROAS/i.test(semantic)) return false;
    return /比|率|变化|相对|CTR|贡献|百分位/i.test(semantic);
  }

  function fixedTwo(value) {
    const number = Number(value);
    const absolute = Math.abs(number);
    const rounded = Math.round((absolute + Number.EPSILON * Math.max(1, absolute)) * 100) / 100;
    return (number < 0 ? -rounded : rounded).toFixed(2);
  }

  function formatMetricValue(metric, value) {
    if (value === null || value === undefined || value === "") return "";
    if (typeof value === "number" && Number.isFinite(value) && isPercentMetric(metric)) return `${fixedTwo(value * 100)}%`;
    if (typeof value === "number" && Number.isFinite(value)) return new Intl.NumberFormat("zh-CN", {
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: 2
    }).format(value);
    const text = String(value);
    if (isPercentMetric(metric) && !text.includes("%") && /^[<>]?\s*[+-]?\d+(?:\.\d+)?(?:\s*[~～]\s*[<>]?\s*[+-]?\d+(?:\.\d+)?)?$/.test(text)) {
      return text.replace(/[+-]?\d+(?:\.\d+)?/g, token => `${fixedTwo(Number(token) * 100)}%`);
    }
    if (/^[<>]?\s*[\d.,]+(?:\.\d+)?[万千%]?(?:\s*[~～]\s*[<>]?\s*[\d.,]+(?:\.\d+)?[万千%]?)?$/.test(text)) {
      return text.replace(/-?\d+\.\d+/g, token => fixedTwo(token));
    }
    return text;
  }

  function table(name, columns, rows, extra = {}) {
    return { name, columns, rows: rows.map(row => columns.map((_, index) => row[index] ?? EMPTY)), ...extra };
  }

  function findItemObject(data, itemId) {
    let exact = null;
    let fallback = null;
    walk(data, node => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      const id = pick(node, ["id", "itemId"]);
      if (id != null && String(id) === String(itemId)) exact = node;
      if (!fallback && ["gmv30d", "amt30DayAvg", "gmv30dRank", "lifeCycleDesc"].some(key => key in node)) fallback = node;
    });
    return exact || fallback;
  }

  function metricName(object, index = 0) {
    return displayValue(pick(object, ["name", "label", "title", "fieldName", "indexName", "displayName", "metricName", "code"])) || `核心指标${index + 1}`;
  }

  function metricPair(indexObjects, patterns) {
    for (let index = 0; index < indexObjects.length; index += 1) {
      const object = indexObjects[index];
      const name = metricName(object, index).replace(/\s+/g, "").toLowerCase();
      if (!patterns.some(pattern => pattern.test(name))) continue;
      return {
        name: metricName(object, index),
        subject: valueOrBlank(pick(object, ["periodValue", "value", "selfValue", "subjectValue", "itemValue", "currentValue", "latestValue"]), isPercentMetric(name)),
        competitor: valueOrBlank(pick(object, ["c_value", "compareValue", "competitorValue", "succItemValue", "range", "cValue"]), isPercentMetric(name)),
        object
      };
    }
    return { name: "", subject: EMPTY, competitor: EMPTY, object: null };
  }

  function derivedMetrics(indexObjects, itemObject) {
    const pairs = {
      marketingClicks: metricPair(indexObjects, [/营销推广点击|广告点击|promotionclick/]),
      naturalClicks: metricPair(indexObjects, [/自然点击|organicclick/]),
      orders: metricPair(indexObjects, [/成交笔数|支付笔数|alipaycnt/]),
      conversion: metricPair(indexObjects, [/支付转化率|成交转化率|alipayconversion|conversionrate/]),
      aov: metricPair(indexObjects, [/笔单价|客单价|unitprice|avgorder/]),
      cartRate: metricPair(indexObjects, [/加购率|cartrate/]),
      visitors: metricPair(indexObjects, [/访客数|访问人数|visitor|uv/]),
      totalGmv: metricPair(indexObjects, [/总gmv|成交金额|alipayamt|gmv30d/]),
      attributedGmv: metricPair(indexObjects, [/广告归因gmv|直接成交金额|directalipayamt|归因成交金额/]),
      roi: metricPair(indexObjects, [/^roi$|roi1d|直接roi/]),
      clicks: metricPair(indexObjects, [/^点击量$|^点击数$|^click$|clickcnt/]),
      cpc: metricPair(indexObjects, [/点击成本|cost_per|^cpc$/]),
      keywordShare: metricPair(indexObjects, [/关键词.*消耗占比|关键词.*花费占比/]),
      channelHhi: metricPair(indexObjects, [/渠道.*hhi|渠道集中度/])
    };
    const calculate = side => {
      const out = {};
      Object.keys(pairs).forEach(key => { out[key] = pairs[key][side]; });
      if (!Number.isFinite(toNumber(out.totalGmv))) {
        const itemGmv = side === "subject" ? toNumber(pick(itemObject, ["gmv30d"])) : NaN;
        out.totalGmv = Number.isFinite(itemGmv) ? itemGmv : (Number.isFinite(toNumber(out.orders)) && Number.isFinite(toNumber(out.aov)) ? round(toNumber(out.orders) * toNumber(out.aov)) : EMPTY);
      }
      if (!Number.isFinite(toNumber(out.visitors)) && Number.isFinite(toNumber(out.orders)) && Number.isFinite(percentRatio(out.conversion)) && percentRatio(out.conversion) !== 0) out.visitors = round(toNumber(out.orders) / percentRatio(out.conversion));
      const spendByRoi = Number.isFinite(toNumber(out.attributedGmv)) && Number.isFinite(toNumber(out.roi)) && toNumber(out.roi) !== 0 ? toNumber(out.attributedGmv) / toNumber(out.roi) : NaN;
      const spendByClick = Number.isFinite(toNumber(out.clicks)) && Number.isFinite(toNumber(out.cpc)) ? toNumber(out.clicks) * toNumber(out.cpc) : NaN;
      out.spend = round(Number.isFinite(spendByRoi) ? spendByRoi : spendByClick);
      out.feeRatio = Number.isFinite(toNumber(out.spend)) && Number.isFinite(toNumber(out.totalGmv)) && toNumber(out.totalGmv) !== 0 ? round(toNumber(out.spend) / toNumber(out.totalGmv), 6) : EMPTY;
      out.roas = Number.isFinite(toNumber(out.totalGmv)) && Number.isFinite(toNumber(out.spend)) && toNumber(out.spend) !== 0 ? round(toNumber(out.totalGmv) / toNumber(out.spend), 4) : EMPTY;
      return out;
    };
    return { subject: calculate("subject"), competitor: calculate("competitor"), pairs };
  }

  function relative(subject, competitor, difference = false) {
    const subjectRange = completenessEngine?.parseVagueRange?.(subject);
    const competitorRange = completenessEngine?.parseVagueRange?.(competitor);
    // 脱敏区间不能取中点伪装成精确值计算相对差。显式在这一层
    // 截断，避免未来 toNumber 增加区间解析时意外产出伪精确环比。
    if (subjectRange?.exact === false || competitorRange?.exact === false) return EMPTY;
    const left = toNumber(subject);
    const right = toNumber(competitor);
    if (!Number.isFinite(left) || !Number.isFinite(right) || (!difference && right === 0)) return EMPTY;
    return round(difference ? left - right : left / right - 1, 6);
  }

  function itemTable(itemObject, successObjects, itemId, successItemId = "") {
    const rows = [[
      "主体", String(pick(itemObject, ["id", "itemId"]) || itemId || ""), displayValue(pick(itemObject, ["name", "itemTitle", "title"])),
      displayValue(pick(itemObject, ["categoryName", "cateName", "category", "desc"])), valueOrBlank(pick(itemObject, ["reservePrice", "price", "priceBand"])),
      valueOrBlank(pick(itemObject, ["onlineDays"])), displayValue(pick(itemObject, ["lifeCycleDesc", "stage", "phase"])), valueOrBlank(pick(itemObject, ["gmv30d", "gmv"])),
      displayValue(pick(itemObject, ["picUrl", "imageUrl", "itemUrl", "detailUrl"]))
    ]];
    const seen = new Set([rows[0][1]]);
    const orderedSuccessObjects = successObjects.slice().sort((left, right) => {
      const leftMatch = String(pick(left, ["itemId", "id"]) || "") === String(successItemId || "");
      const rightMatch = String(pick(right, ["itemId", "id"]) || "") === String(successItemId || "");
      return Number(rightMatch) - Number(leftMatch);
    });
    orderedSuccessObjects.forEach(object => {
      const id = displayValue(pick(object, ["itemId", "id"]));
      if (!id || seen.has(id)) return;
      seen.add(id);
      rows.push([
        id === String(successItemId || "") || (!successItemId && rows.length === 1) ? "目标对手" : "备选成功品", id, displayValue(pick(object, ["itemTitle", "title", "name"])),
        displayValue(pick(object, ["categoryName", "cateName", "successDesc", "desc", "description"])), valueOrBlank(pick(object, ["reservePrice", "price", "priceBand"])),
        valueOrBlank(pick(object, ["onlineDays"])), displayValue(pick(object, ["lifeCycleDesc", "stage", "phase"])), valueOrBlank(pick(object, ["gmv30d", "gmv"])),
        displayValue(pick(object, ["picUrl", "imageUrl", "itemUrl", "detailUrl"]))
      ]);
    });
    return table("商品与成功品", ["角色", "商品ID", "商品标题", "类目/成功品描述", "标价/价格带", "上架天数", "生命周期", "30日GMV", "图片/详情"], rows, {
      widths: [14, 19, 58, 70, 19, 13, 20, 18, 54]
    });
  }

  function normalizeDate(value) {
    const text = displayValue(value).trim();
    const match = text.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
    return match ? `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}` : text;
  }

  function channelValue(object, label) {
    for (const [key, value] of Object.entries(object || {})) {
      if (!key.includes(label)) continue;
      const number = toNumber(value);
      if (Number.isFinite(number)) return number;
    }
    const aliases = {
      "内容运营": ["contentCost", "contentSpend"], "人群推广": ["crowdCost", "audienceCost", "peopleCost"],
      "货品全站推": ["goodsCost", "wholeSiteCost", "fullSiteCost"], "线索推广": ["leadCost", "clueCost"],
      "关键词推广": ["keywordCost", "searchCost"]
    };
    return toNumber(pick(object, aliases[label] || []));
  }

  function parseRange(value) {
    const dates = displayValue(value).match(/20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/g) || [];
    return [normalizeDate(dates[0]), normalizeDate(dates[1] || dates[0])];
  }

  function normalizeStages(stageObjects) {
    const rows = [];
    const seen = new Set();
    stageObjects.forEach((object, index) => {
      const [rangeStart, rangeEnd] = parseRange(pick(object, ["rangeTime", "dateRange", "range", "period"]));
      const start = normalizeDate(pick(object, ["startDate", "start", "beginDate"])) || rangeStart;
      const end = normalizeDate(pick(object, ["endDate", "end", "finishDate"])) || rangeEnd;
      const name = displayValue(pick(object, ["stageName", "stage", "phase", "name"])) || `阶段${index + 1}`;
      const key = `${start}|${end}|${name}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({
        stage: displayValue(pick(object, ["stageCode", "stageNo", "stageIndex"])) || String(rows.length + 1), start, end, name,
        description: displayValue(pick(object, ["metricText", "stageDesc", "description", "desc", "target", "adTitle", "adDetails", "operation"]))
      });
    });
    return rows.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  }

  function normalizeDaily(dailyObjects, periodGmv, stages) {
    const seen = new Set();
    const rows = [];
    dailyObjects.forEach(object => {
      const date = normalizeDate(pick(object, ["date", "dt", "day", "statDate", "bizDate"]));
      if (!/^20\d{2}-\d{2}-\d{2}$/.test(date) || seen.has(date)) return;
      seen.add(date);
      const channels = CHANNELS.map(([label]) => channelValue(object, label));
      if (!channels.some(Number.isFinite)) {
        const fallback = toNumber(pick(object, ["channelValue", "cost", "spend", "chargeAmount", "consume", "consumption"]));
        if (Number.isFinite(fallback)) channels[4] = fallback;
      }
      rows.push({
        date,
        gmv: toNumber(pick(object, ["dailyGmv", "actualGmv", "gmvAmount", "dailyAlipayAmt"])),
        index: toNumber(pick(object, ["gmvIndex", "gmv_index", "indexValue", "gmv"])), channels
      });
    });
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const indexSum = rows.reduce((sum, row) => sum + (Number.isFinite(row.index) ? row.index : 0), 0);
    let allocated = 0;
    const indexed = rows.filter(row => Number.isFinite(row.index));
    const last = indexed[indexed.length - 1];
    rows.forEach(row => {
      if (!Number.isFinite(row.gmv) && Number.isFinite(periodGmv) && indexSum > 0 && Number.isFinite(row.index)) {
        row.gmv = row === last ? round(periodGmv - allocated) : round(periodGmv * row.index / indexSum);
        allocated += Number.isFinite(row.gmv) ? row.gmv : 0;
      }
      row.channels = row.channels.map(value => round(value));
      row.spend = round(row.channels.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0));
      row.feeRatio = Number.isFinite(row.gmv) && row.gmv !== 0 ? round(toNumber(row.spend) / row.gmv, 6) : EMPTY;
      row.stage = stages.find(stage => (!stage.start || row.date >= stage.start) && (!stage.end || row.date <= stage.end))?.name || EMPTY;
    });
    return rows;
  }

  function dailyTable(dailyRows) {
    return table("日GMV与费比", ["日期", "日GMV", ...CHANNELS.map(channel => channel[1]), "日总消耗", "日费比", "阶段"], dailyRows.map(row => [
      row.date, round(row.gmv), ...row.channels, row.spend, row.feeRatio, row.stage
    ]), { widths: [13, 16, 24, 24, 26, 24, 26, 15, 13, 15] });
  }

  function scenePairValue(object, keys, competitor = false, percent = false) {
    const directKeys = competitor ? keys.flatMap(key => [`c_${key}`, `compare${key[0].toUpperCase()}${key.slice(1)}`, `competitor${key[0].toUpperCase()}${key.slice(1)}`]) : keys;
    const direct = pick(object, directKeys);
    if (direct !== undefined) return valueOrBlank(direct, percent);
    const nested = pickNested(object, keys, competitor ? ["c_value", "compareValue", "competitorValue", "succItemValue"] : ["itemValue", "value", "selfValue"]);
    return valueOrBlank(nested, percent);
  }

  function sceneRows(sceneObjects, subjectSpend, competitorSpend) {
    const level1 = [];
    const level2 = [];
    const seen = new Set();
    sceneObjects.forEach((object, index) => {
      const primary = displayValue(pick(object, ["channelName", "promotion_scene", "promotionScene", "sceneName", "name"])) || `场景${index + 1}`;
      const secondary = displayValue(pick(object, ["campaign_name", "campaignName", "effectName", "promotionCoreName", "subSceneName"]));
      const sceneId = displayValue(pick(object, ["sceneId", "id", "campaignId"]));
      const build = (role, competitor) => {
        const ratioRaw = scenePairValue(object, ["chargeRatio", "costRate", "spendRate"], competitor, true);
        const exact = competitor ? scenePairValue(object, ["charge", "spend", "cost", "consume", "chargeAmount", "costValue"], true) : (() => {
          const nested = pickNested(object, ["charge"], ["itemValue", "value", "selfValue"]);
          return nested !== undefined ? valueOrBlank(nested) : scenePairValue(object, ["spend", "cost", "consume", "chargeAmount", "costValue", "itemValue"], false);
        })();
        const total = competitor ? competitorSpend : subjectSpend;
        const allocated = Number.isFinite(toNumber(exact)) ? toNumber(exact) : (Number.isFinite(percentRatio(ratioRaw)) && Number.isFinite(total) ? round(total * percentRatio(ratioRaw)) : EMPTY);
        return [role, secondary ? 2 : 1, primary, secondary, sceneId, exact, ratioRaw, allocated,
          scenePairValue(object, ["pv_di", "pv", "impression"], competitor), scenePairValue(object, ["click", "clickCnt"], competitor),
          scenePairValue(object, ["ctr_di", "ctr", "clickRate"], competitor, true), scenePairValue(object, ["cost_per", "cpc", "clickCost"], competitor),
          scenePairValue(object, ["directAlipayAmt", "alipayAmt", "gmv1d"], competitor), scenePairValue(object, ["roi", "roi1d"], competitor)];
      };
      const subjectRow = build("主体", false);
      const competitorRow = build("对手", true);
      const hasCompetitor = competitorRow.slice(5).some(value => value !== EMPTY);
      const key = `${primary}|${secondary}|${sceneId}`;
      if (seen.has(key)) return;
      seen.add(key);
      const target = secondary ? level2 : level1;
      target.push(subjectRow);
      if (hasCompetitor) target.push(competitorRow);
    });
    const columns = ["对象", "层级", "一级场景", "二级场景", "场景编号", "消耗", "消耗占比", "分配后消耗", "展现", "点击", "CTR", "CPC", "直接成交金额", "直接ROI"];
    return [
      table("一级场景", columns, level1, { widths: [10, 8, 16, 12, 12, 17, 19, 16, 15, 12, 12, 12, 17, 13] }),
      table("二级场景", columns, level2, { widths: [10, 8, 16, 48, 11, 17, 19, 16, 15, 12, 12, 12, 17, 13] })
    ];
  }

  function channelTable(sceneLevel1, dailyRows, periodDays) {
    const subjectByChannel = new Map();
    sceneLevel1.rows.filter(row => row[0] === "主体").forEach(row => {
      subjectByChannel.set(row[2], (subjectByChannel.get(row[2]) || 0) + (Number.isFinite(toNumber(row[7])) ? toNumber(row[7]) : 0));
    });
    const alignedRows = dailyRows.slice(-Math.max(1, periodDays));
    const competitorPeriod = CHANNELS.map((_, channelIndex) => round(alignedRows.reduce((sum, row) => sum + (Number.isFinite(toNumber(row.channels[channelIndex])) ? toNumber(row.channels[channelIndex]) : 0), 0)));
    const competitorTrend = CHANNELS.map((_, channelIndex) => round(dailyRows.reduce((sum, row) => sum + (Number.isFinite(toNumber(row.channels[channelIndex])) ? toNumber(row.channels[channelIndex]) : 0), 0)));
    const subject = CHANNELS.map(([label]) => round(subjectByChannel.get(label) || 0));
    const subjectTotal = subject.reduce((sum, value) => sum + (toNumber(value) || 0), 0);
    const competitorPeriodTotal = competitorPeriod.reduce((sum, value) => sum + (toNumber(value) || 0), 0);
    const competitorTrendTotal = competitorTrend.reduce((sum, value) => sum + (toNumber(value) || 0), 0);
    const rows = CHANNELS.map(([label, apiField], index) => [label, apiField, competitorPeriod[index], competitorPeriodTotal ? competitorPeriod[index] / competitorPeriodTotal : EMPTY,
      competitorTrend[index], competitorTrendTotal ? competitorTrend[index] / competitorTrendTotal : EMPTY, subject[index], subjectTotal ? subject[index] / subjectTotal : EMPTY]);
    rows.push(["合计", "", round(competitorPeriodTotal), competitorPeriodTotal ? 1 : EMPTY, round(competitorTrendTotal), competitorTrendTotal ? 1 : EMPTY, round(subjectTotal), subjectTotal ? 1 : EMPTY]);
    return table("渠道花费", ["渠道", "页面指标", `对手${periodDays}日消耗`, `对手${periodDays}日占比`, "对手30日趋势消耗", "对手30日趋势占比", `主体${periodDays}日消耗`, `主体${periodDays}日占比`], rows, {
      widths: [16, 28, 17, 17, 18, 18, 17, 17], chartTitle: `${periodDays}日渠道消耗对比`
    });
  }

  function periodSummary(item, metrics, dailyRows, period, subjectSpendFromScene) {
    const days = Number(period.days) || 30;
    const start = period.startDate || dailyRows[0]?.date || EMPTY;
    const end = period.endDate || dailyRows[dailyRows.length - 1]?.date || EMPTY;
    const peak = dailyRows.reduce((best, row) => !best || toNumber(row.gmv) > toNumber(best.gmv) ? row : best, null);
    const gmvs = dailyRows.map(row => toNumber(row.gmv)).filter(Number.isFinite);
    const mean = gmvs.length ? gmvs.reduce((sum, value) => sum + value, 0) / gmvs.length : NaN;
    const variance = gmvs.length ? gmvs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / gmvs.length : NaN;
    const volatility = Number.isFinite(mean) && mean !== 0 ? Math.sqrt(variance) / mean : EMPTY;
    const dailyGmv = round(gmvs.reduce((sum, value) => sum + value, 0));
    const dailySpend = round(dailyRows.reduce((sum, row) => sum + (toNumber(row.spend) || 0), 0));
    const make = (id, objectLabel, source, spend, totalGmv, rangeStart, rangeEnd, rangeDays, peakDate, vol) => {
      const gmv = Number.isFinite(toNumber(totalGmv)) ? toNumber(totalGmv) : EMPTY;
      const actualSpend = Number.isFinite(toNumber(spend)) ? toNumber(spend) : EMPTY;
      const attributed = source.attributedGmv;
      return [String(id || ""), objectLabel, rangeStart, rangeEnd, rangeDays, source.orders, source.aov, gmv, attributed, actualSpend,
        Number.isFinite(toNumber(actualSpend)) && Number.isFinite(toNumber(gmv)) && toNumber(gmv) !== 0 ? round(toNumber(actualSpend) / toNumber(gmv), 6) : EMPTY,
        Number.isFinite(toNumber(actualSpend)) && toNumber(actualSpend) !== 0 && Number.isFinite(toNumber(gmv)) ? round(toNumber(gmv) / toNumber(actualSpend), 4) : EMPTY,
        modelCell(completenessEngine.contributionRatio(attributed, gmv)),
        EMPTY, Number.isFinite(toNumber(gmv)) ? round(toNumber(gmv) / rangeDays) : EMPTY, Number.isFinite(toNumber(actualSpend)) ? round(toNumber(actualSpend) / rangeDays) : EMPTY,
        peakDate || EMPTY, Number.isFinite(toNumber(vol)) ? round(toNumber(vol), 6) : EMPTY];
    };
    const competitorId = item.competitorId || "";
    const subjectSpend = Number.isFinite(toNumber(subjectSpendFromScene)) && toNumber(subjectSpendFromScene) > 0 ? subjectSpendFromScene : metrics.subject.spend;
    const rows = [
      make(item.id, `主体商品・${days}日`, metrics.subject, subjectSpend, metrics.subject.totalGmv, start, end, days, EMPTY, EMPTY),
      make(competitorId, `目标对手・${days}日`, metrics.competitor, dailySpend || metrics.competitor.spend, metrics.competitor.totalGmv || dailyGmv, start, end, days, peak?.date, volatility),
      make(competitorId, "目标对手・30日趋势", metrics.competitor, dailySpend || metrics.competitor.spend, dailyGmv || metrics.competitor.totalGmv, dailyRows[0]?.date || start, dailyRows[dailyRows.length - 1]?.date || end, dailyRows.length || 30, peak?.date, volatility)
    ];
    return table("周期汇总", ["商品ID", "对象", "周期开始", "周期结束", "天数", "成交笔数", "笔单价", "总GMV", "广告归因GMV", "广告消耗", "费比", "全域ROAS", "付费金额占比", "广告订单贡献率", "日均GMV", "日均消耗", "GMV峰值日", "GMV波动率"], rows, {
      widths: [18, 18, 13, 13, 9, 13, 15, 16, 16, 16, 13, 13, 18, 18, 16, 16, 15, 14]
    });
  }

  function benchmarkTable(metrics) {
    const rows = [
      ["成交", "总GMV", metrics.subject.totalGmv, metrics.competitor.totalGmv, relative(metrics.subject.totalGmv, metrics.competitor.totalGmv)],
      ["成交", "成交笔数", metrics.subject.orders, metrics.competitor.orders, relative(metrics.subject.orders, metrics.competitor.orders)],
      ["成交", "笔单价", metrics.subject.aov, metrics.competitor.aov, relative(metrics.subject.aov, metrics.competitor.aov)],
      ["转化", "支付转化率", metrics.subject.conversion, metrics.competitor.conversion, relative(metrics.subject.conversion, metrics.competitor.conversion, true)],
      ["流量", "访客数", metrics.subject.visitors, metrics.competitor.visitors, relative(metrics.subject.visitors, metrics.competitor.visitors)],
      ["投放", "推广消耗", metrics.subject.spend, metrics.competitor.spend, relative(metrics.subject.spend, metrics.competitor.spend)],
      ["投放", "付费金额占比", completenessEngine.contributionRatio(metrics.subject.attributedGmv, metrics.subject.totalGmv), completenessEngine.contributionRatio(metrics.competitor.attributedGmv, metrics.competitor.totalGmv), relative(completenessEngine.contributionRatio(metrics.subject.attributedGmv, metrics.subject.totalGmv), completenessEngine.contributionRatio(metrics.competitor.attributedGmv, metrics.competitor.totalGmv), true)],
      ["投放", "费比", metrics.subject.feeRatio, metrics.competitor.feeRatio, relative(metrics.subject.feeRatio, metrics.competitor.feeRatio, true)],
      ["投放", "全域ROAS", metrics.subject.roas, metrics.competitor.roas, relative(metrics.subject.roas, metrics.competitor.roas)],
      ["结构", "关键词消耗占比", metrics.subject.keywordShare, metrics.competitor.keywordShare, relative(metrics.subject.keywordShare, metrics.competitor.keywordShare, true)],
      ["结构", "渠道集中度HHI", metrics.subject.channelHhi, metrics.competitor.channelHhi, relative(metrics.subject.channelHhi, metrics.competitor.channelHhi)],
      ["直接效果", "直接成交金额", metrics.subject.attributedGmv, metrics.competitor.attributedGmv, relative(metrics.subject.attributedGmv, metrics.competitor.attributedGmv)]
    ];
    return table("对标总表", ["页面模块", "对标指标", "主体周期值", "对手周期值", "主体相对对手"], rows, { widths: [15, 28, 20, 22, 18] });
  }

  function stageTable(stages, dailyRows) {
    const rows = stages.map(stage => {
      const selected = dailyRows.filter(row => (!stage.start || row.date >= stage.start) && (!stage.end || row.date <= stage.end));
      const days = selected.length || (stage.start && stage.end ? Math.round((Date.parse(`${stage.end}T00:00:00Z`) - Date.parse(`${stage.start}T00:00:00Z`)) / 86400000) + 1 : EMPTY);
      const gmvs = selected.map(row => toNumber(row.gmv)).filter(Number.isFinite);
      const spend = selected.reduce((sum, row) => sum + (toNumber(row.spend) || 0), 0);
      const channelTotals = CHANNELS.map((channel, index) => selected.reduce((sum, row) => sum + (toNumber(row.channels[index]) || 0), 0));
      const max = Math.max(...channelTotals);
      const maxIndex = Number.isFinite(max) && max > 0 ? channelTotals.indexOf(max) : -1;
      return [stage.stage, stage.start, stage.end, stage.name, stage.description, days, round(gmvs[0]), round(gmvs[gmvs.length - 1]),
        gmvs.length && gmvs[0] !== 0 ? round(gmvs[gmvs.length - 1] / gmvs[0] - 1, 6) : EMPTY,
        gmvs.length ? round(gmvs.reduce((sum, value) => sum + value, 0) / gmvs.length) : EMPTY, round(spend), Number.isFinite(toNumber(days)) && days ? round(spend / days) : EMPTY,
        maxIndex >= 0 ? CHANNELS[maxIndex][0] : EMPTY, maxIndex >= 0 && spend ? round(max / spend, 6) : EMPTY];
    });
    return table("成长阶段数据", ["阶段", "开始", "结束", "阶段名称", "阶段描述", "天数", "起始GMV", "结束GMV", "GMV变化", "平均日GMV", "阶段总消耗", "日均消耗", "第一渠道", "第一渠道占比"], rows, {
      widths: [9, 13, 13, 16, 42, 9, 16, 16, 13, 16, 16, 16, 15, 17], chartTitle: "阶段平均日GMV"
    });
  }

  function baseMetricTable(metrics) {
    const base = [
      ["营销推广点击量", metrics.subject.marketingClicks, metrics.competitor.marketingClicks],
      ["自然点击量", metrics.subject.naturalClicks, metrics.competitor.naturalClicks],
      ["成交笔数", metrics.subject.orders, metrics.competitor.orders], ["支付转化率", metrics.subject.conversion, metrics.competitor.conversion],
      ["笔单价", metrics.subject.aov, metrics.competitor.aov], ["加购率", metrics.subject.cartRate, metrics.competitor.cartRate],
      ["访客数", metrics.subject.visitors, metrics.competitor.visitors], ["总GMV", metrics.subject.totalGmv, metrics.competitor.totalGmv],
      ["广告/推广消耗", metrics.subject.spend, metrics.competitor.spend], ["费比", metrics.subject.feeRatio, metrics.competitor.feeRatio],
      ["全域ROAS", metrics.subject.roas, metrics.competitor.roas]
    ];
    return table("基础指标对比", ["指标", "主体值", "对手值", "主体相对对手"], base.map(row => [...row, relative(row[1], row[2], isPercentMetric(row[0]))]), { widths: [28, 20, 20, 20] });
  }

  function keywordTable(indexData) {
    const objects = indexData.flatMap(data => collectObjects(data, node => pick(node, ["keyword", "keywordName", "word", "query"]) !== undefined));
    const rows = [];
    const seen = new Set();
    objects.forEach(object => {
      const keyword = displayValue(pick(object, ["keyword", "keywordName", "word", "query"]));
      const roleText = displayValue(pick(object, ["object", "role", "itemRole", "compareType"]));
      const role = /对手|竞品|competitor|compare/i.test(roleText) ? "对手" : "主体";
      const row = [role, keyword, displayValue(pick(object, ["wordType", "keywordType", "type", "tag"])), valueOrBlank(pick(object, ["pv", "impression", "pv_di"])),
        valueOrBlank(pick(object, ["click", "clickCnt"])), valueOrBlank(pick(object, ["ctr", "ctr_di", "clickRate"]), true), valueOrBlank(pick(object, ["alipayConversion", "conversionRate", "payConversion"]), true)];
      const key = row.join("|");
      if (!keyword || seen.has(key)) return;
      seen.add(key);
      rows.push(row);
    });
    return table("关键词样本", ["对象", "关键词", "词类型", "展现", "点击", "CTR", "支付转化率"], rows, { widths: [10, 24, 16, 15, 15, 14, 17] });
  }

  function overviewTable(item, periodLabel, period, periodSummaryTable) {
    const subject = periodSummaryTable.rows[0] || [];

    const competitor = periodSummaryTable.rows[1] || [];
    return table("报告总览", ["项目", "主体", "对手", "范围"], [
      ["商品ID", item.id, item.competitorId, ""], ["商品标题", item.title, item.competitorTitle, ""],
      [`${period.days || 30}日对齐周期`, period.startDate && period.endDate ? `${period.startDate} 至 ${period.endDate}` : "", period.startDate && period.endDate ? `${period.startDate} 至 ${period.endDate}` : "", `${period.days || 30}天`],
      ["30日趋势日期", "—", `${periodSummaryTable.rows[2]?.[2] || ""} 至 ${periodSummaryTable.rows[2]?.[3] || ""}`.trim(), "30天"]
    ], {
      subtitle: `主体 ${item.id || ""}｜对手 ${item.competitorId || ""}｜${period.startDate && period.endDate ? `${period.startDate} 至 ${period.endDate}` : periodLabel}`,
      widths: [18, 46, 46, 18, 16, 16, 16, 16, 16, 16, 16, 16],
      kpis: [
        { label: `主体${period.days || 30}日GMV`, value: subject[7] }, { label: `对手${period.days || 30}日GMV`, value: competitor[7] },
        { label: "主体费比", value: subject[10] }, { label: "对手费比", value: competitor[10] }
      ]
    });
  }

  function scopedRecords(records, startedAt) {
    return (records || []).filter(record => {
      if (!record || (record.kind && record.kind !== "Network")) return false;
      if (startedAt && record.capturedAt && record.capturedAt < startedAt) return false;
      return Boolean(matchEndpoint(record));
    });
  }

  function groupByModule(scoped) {
    const byModule = new Map(EXPECTED_ENDPOINTS.map(endpoint => [endpoint.module, []]));
    scoped.forEach(record => {
      const matched = matchEndpoint(record);
      const data = parseBody(record);
      if (matched && data) byModule.get(matched.endpoint.module).push({ data, priority: matched.priority });
    });
    // 同一模块内按接口优先级排序：已选成功品(load) 排在搜索候选(item/list) 之前。
    byModule.forEach((entries, module) => {
      byModule.set(module, entries.sort((left, right) => left.priority - right.priority).map(entry => entry.data));
    });
    return byModule;
  }

  // ——— 送去 API 深度解析的载荷 ———
  // 目的：让模型基于接口原始业务响应做逐字段深度解析，而不是只看已成型的表格。
  // 请求头和 Cookie 不在 record.body 中；业务响应字段不设置黑名单，避免新接口被静默漏掉。

  function sanitizeForAnalysis(value, depth = 0) {
    if (depth > 14) return null;
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") return value.length > 400 ? `${value.slice(0, 400)}…` : value;
    if (Array.isArray(value)) {
      // 每个数组最多送 400 项：日序列 30 天、场景列表、关键词列表都远小于这个上限，
      // 真正超限的是埋点式的长数组，截断也不影响业务解析。
      return value.slice(0, 400).map(child => sanitizeForAnalysis(child, depth + 1));
    }
    if (typeof value !== "object") return null;
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const clean = sanitizeForAnalysis(child, depth + 1);
      if (clean !== null && clean !== undefined) out[key] = clean;
    }
    return out;
  }

  // 把本次任务采集到的接口数据，按模块整理成待深度解析的载荷。
  // 同一模块可能有多次响应（切页签、切渠道各一次），全部保留并编号，
  // 让模型能看出哪些是同一指标的重复口径。
  function buildAnalysisPayload(records, itemId, meta = {}) {
    const scoped = scopedRecords(records, meta.startedAt || "");
    const byModule = groupByModule(scoped);
    const modules = EXPECTED_ENDPOINTS.map(endpoint => {
      const responses = (byModule.get(endpoint.module) || []).map((data, index) => ({
        index: index + 1,
        payload: sanitizeForAnalysis(data)
      })).filter(entry => entry.payload && Object.keys(entry.payload).length);
      return { module: endpoint.module, response_count: responses.length, responses };
    }).filter(entry => entry.response_count > 0);

    return {
      schema_version: "3.0",
      subject_item_id: String(itemId || ""),
      competitor_item_id: String(meta.successItemId || ""),
      period: {
        start_date: meta.period?.startDate || "",
        end_date: meta.period?.endDate || "",
        days: Number(meta.period?.days) || 30,
        // 让模型知道这份数据的日期口径可靠到什么程度，别把 preset 口径当逐日精确。
        precision: meta.periodPrecision || (meta.periodConfirmed ? "exact" : "failed"),
        page_shown: meta.periodShown || ""
      },
      modules
    };
  }

  function modelCell(value) {
    return value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value)) ? EMPTY : value;
  }

  function numericModelValue(value) {
    const state = completenessEngine.metricValueState(value);
    if (state.state === completenessEngine.VALUE_STATES.EXACT) return state.value;
    return state.state === completenessEngine.VALUE_STATES.INTERVAL ? value : null;
  }

  function metricCell(value) {
    return modelCell(numericModelValue(value));
  }

  function disclosedModelValue(value) {
    if (value === null || value === undefined) return false;
    return !(typeof value === "string" && /^(?:|[-–—]|--|暂无|无数据|null|undefined)$/i.test(value.trim()));
  }

  function reportSpendCoverage(model, side) {
    const metrics = model.metrics?.[side] || {};
    if (metrics.spendCoverage) return metrics.spendCoverage;
    return side === "subject"
      ? model.subjectDaily?.spendCoverage || null
      : model.daily?.spendCoverage || model.daily?.coverageSummary || null;
  }

  function reportRawMetricValue(model, side, key) {
    const metrics = model.metrics?.[side] || {};
    const aliases = {
      paidGmvContribution: ["paidGmvContribution", "paidAmountShare"],
      paidAmountShare: ["paidAmountShare", "paidGmvContribution"],
      globalROAS: ["globalROAS", "roas"],
      roas: ["roas", "globalROAS"]
    }[key] || [key];
    if (aliases.some(alias => metrics.valueConflicts?.[alias])
      || (["roas", "globalROAS"].includes(key) && metrics.valueConflicts?.roas)
      || (["paidGmvContribution", "paidAmountShare"].includes(key) && metrics.valueConflicts?.paidGmvContribution)) return null;
    for (const alias of aliases) {
      const numeric = numericModelValue(metrics[alias]);
      if (numeric !== null) return numeric;
    }
    const coverage = reportSpendCoverage(model, side);
    const coverageKey = {
      spend: "spend",
      feeRatio: "feeRatio",
      roi: "roi",
      ppc: "ppc",
      roas: "roas",
      keywordShare: "keywordShare"
    }[key];
    const legacySingleDayPartial = coverage?.singleDayPartial === undefined
      && coverage?.partial !== false
      && Array.isArray(coverage?.missingDates)
      && coverage.missingDates.length === 1;
    const coverageValueAllowed = coverage?.complete === true || coverage?.singleDayPartial === true || legacySingleDayPartial;
    return coverageKey && coverageValueAllowed ? numericModelValue(coverage?.[coverageKey]) : null;
  }

  const REPORT_EFFICIENCY_FORMULAS = Object.freeze({
    roi: Object.freeze({ numeratorKey: "paidGmv", denominatorKey: "spend", digits: 2, metric: "ROI", compact: false }),
    ppc: Object.freeze({ numeratorKey: "spend", denominatorKey: "marketingClicks", digits: 2, metric: "PPC", compact: false }),
    feeRatio: Object.freeze({ numeratorKey: "spend", denominatorKey: "totalGmv", digits: 6, metric: "费比", compact: true })
  });

  // 报告层再做一次同期间公式锁定，确保总览、对标、周期和基础表不会因
  // 旧模型值或后置填充而分叉。只有分子、分母都为具体值/合法区间时才接管。
  function reportEfficiencyMetric(model, side, key) {
    const definition = REPORT_EFFICIENCY_FORMULAS[key];
    if (!definition) return { applicable: false, value: null };
    const metrics = model.metrics?.[side] || {};
    if (!metrics.canonicalEfficiencyMetrics?.[key]) return { applicable: false, value: null };
    const numerator = reportRawMetricValue(model, side, definition.numeratorKey);
    const denominator = reportRawMetricValue(model, side, definition.denominatorKey);
    const numeratorState = completenessEngine.metricValueState(numerator);
    const denominatorState = completenessEngine.metricValueState(denominator);
    const numericStates = [completenessEngine.VALUE_STATES.EXACT, completenessEngine.VALUE_STATES.INTERVAL];
    if (!numericStates.includes(numeratorState.state) || !numericStates.includes(denominatorState.state)) {
      return { applicable: false, value: null };
    }
    const contexts = metrics.valueContexts || {};
    const calculated = completenessEngine.safeIntervalDivide(numerator, denominator, {
      digits: definition.digits,
      metric: definition.metric,
      compact: definition.compact,
      outward: true,
      numeratorContext: contexts[definition.numeratorKey] || metrics.expectedContext,
      denominatorContext: contexts[definition.denominatorKey] || metrics.expectedContext
    });
    return {
      applicable: true,
      value: numericStates.includes(calculated.state) ? calculated.value : null
    };
  }

  function reportMetricValue(model, side, key) {
    // 完整周期目标对手的付费成交额与 ROI 已通过同 run、商品对、当前周期和
    // 紧邻等长上一周期门禁；报告四个汇总出口统一优先使用该直出值。
    // 分日表不调用本函数中的 periodDirectMetrics，因此两种时间粒度不会串值。
    const periodDirect = side === "competitor" && ["paidGmv", "roi"].includes(key)
      ? numericModelValue(model.metrics?.competitor?.periodDirectMetrics?.[key])
      : null;
    if (periodDirect !== null) return periodDirect;
    const formula = reportEfficiencyMetric(model, side, key);
    return formula.applicable ? formula.value : reportRawMetricValue(model, side, key);
  }

  function reportSideSpendScope(model, side) {
    const metrics = model.metrics?.[side] || {};
    const coverage = reportSpendCoverage(model, side) || {};
    const role = side === "subject" ? "主体" : "对手";
    const declaredScope = metrics.spendScope;
    const scope = declaredScope || coverage.scope || "missing";
    // 完整周期卡片/场景精确值优先于旁路日趋势的 partial 状态。只有模型明确
    // 把当前展示值标成 coverage-period（或老模型没有 scope）时才使用覆盖范围。
    const partial = declaredScope
      ? declaredScope === "coverage-period"
      : scope === "coverage-period" || coverage.partial === true;
    const expectedDays = Number(coverage.expectedDays) || Number(model.period?.days) || 0;
    const coverageDays = Number(coverage.coverageDays) || 0;
    const range = coverage.startDate && coverage.endDate ? `（${coverage.startDate} 至 ${coverage.endDate}）` : "";
    const hasSpend = disclosedModelValue(reportMetricValue(model, side, "spend"));
    const label = partial
      ? `${role}已返回${coverageDays}/${expectedDays}日${range}`
      : scope === "missing" || !hasSpend
        ? ""
        : `${role}${Number(model.period?.days) || expectedDays}日严格同周期`;
    return { side, role, scope, coverage, partial, hasSpend, label };
  }

  function reportSpendScope(model) {
    const sides = [reportSideSpendScope(model, "subject"), reportSideSpendScope(model, "competitor")];
    const partial = sides.some(side => side.partial && side.hasSpend);
    const strict = `${Number(model.period?.days) || 30}日严格同周期`;
    const metric = partial
      ? sides.filter(side => side.hasSpend && side.label).map(side => side.label).join("；")
      : strict;
    return { sides, partial, metric: metric || strict };
  }

  function alignedMetricRows(model, fixedNames) {
    const identity = name => typeof completenessEngine?.metricIdentity === "function"
      ? completenessEngine.metricIdentity(name)
      : String(name || "").trim().toLowerCase().replace(/\s+/g, "");
    const seen = new Set(fixedNames.map(identity));
    const rows = [];
    for (const metric of model.metrics?.aligned || []) {
      const key = metric.key || identity(metric.name);
      const subject = numericModelValue(metric.subject);
      const competitor = numericModelValue(metric.competitor);
      if (seen.has(key) || (subject === null && competitor === null)) continue;
      seen.add(key);
      rows.push({ ...metric, subject, competitor });
    }
    return rows;
  }

  function coreRowsWithAlignedFallback(model, rows, nameIndex, subjectIndex, competitorIndex) {
    const identity = name => typeof completenessEngine?.metricIdentity === "function"
      ? completenessEngine.metricIdentity(name)
      : String(name || "").trim().toLowerCase().replace(/\s+/g, "");
    const aligned = new Map((model.metrics?.aligned || []).map(metric => [metric.key || identity(metric.name), metric]));
    return rows.map(source => {
      const row = [...source];
      const fallback = aligned.get(identity(row[nameIndex]));
      const subject = numericModelValue(row[subjectIndex]);
      const competitor = numericModelValue(row[competitorIndex]);
      row[subjectIndex] = subject ?? numericModelValue(fallback?.subject);
      row[competitorIndex] = competitor ?? numericModelValue(fallback?.competitor);
      return row;
    });
  }

  function periodMetricsForItem(model, itemId) {
    const targetId = String(itemId || "");
    const subjectId = String(model.item?.itemId || "");
    const competitorId = String(model.targetSuccess?.itemId || "");
    const metrics = targetId && targetId === subjectId
      ? model.metrics?.subject
      : targetId && targetId === competitorId
        ? model.metrics?.competitor
        : null;
    const totalGmv = Number.isFinite(metrics?.totalGmv) ? metrics.totalGmv : null;
    return {
      totalGmv,
      averageDailyGmv: totalGmv != null && Number(model.period?.days) > 0 ? round(totalGmv / Number(model.period.days)) : null
    };
  }

  function buildItemTableFromModel(model) {
    const subject = model.item || {};
    const subjectPeriod = periodMetricsForItem(model, subject.itemId);
    const columns = ["角色", "商品ID", "商品标题", "类目/成功品描述", "标价/价格带", "上架天数", "生命周期", "30日GMV", "30日日均成交", "30日GMV排名", "排名变化", "排名百分位", "年GMV档位", "成交排名", "客群特征", "标签", "图片/详情"];
    const rows = [[
      "主体", subject.itemId || "", subject.title || "", subject.category || "", modelCell(subject.reservePrice), modelCell(subject.onlineDays), subject.lifecycle || "",
      modelCell(subjectPeriod.totalGmv ?? subject.gmv30d), modelCell(subjectPeriod.averageDailyGmv ?? subject.avgDailyAmount30d), modelCell(subject.gmv30dRank), modelCell(subject.gmv30dRankChange), modelCell(subject.rankPercent),
      "", "", "", "", subject.pictureUrl || subject.detailUrl || ""
    ]];
    const candidates = model.successItems.slice().sort((left, right) => Number(right.itemId === model.targetSuccess?.itemId) - Number(left.itemId === model.targetSuccess?.itemId) || Number(right.source === "selected") - Number(left.source === "selected"));
    const seen = new Set([subject.itemId]);
    for (const candidate of candidates) {
      if (!candidate.itemId || seen.has(candidate.itemId)) continue;
      seen.add(candidate.itemId);
      const candidatePeriod = periodMetricsForItem(model, candidate.itemId);
      rows.push([
        candidate.itemId === model.targetSuccess?.itemId ? "目标对手" : "备选成功品", candidate.itemId, candidate.title, candidate.description,
        candidate.priceBand || "", modelCell(candidate.onlineDays), candidate.lifecycle || "", modelCell(candidatePeriod.totalGmv), modelCell(candidatePeriod.averageDailyGmv), "", "", "", candidate.annualGmvBand || "",
        candidate.dealRank || "", candidate.audience || "", (candidate.labels || []).join("、"), candidate.pictureUrl || candidate.detailUrl || ""
      ]);
    }
    return table("商品与成功品", columns, rows, { widths: [14, 19, 58, 70, 20, 13, 18, 18, 18, 16, 14, 14, 18, 18, 24, 20, 54] });
  }

  function competitorDailyGmvSource(model) {
    // 对手日 GMV 有两套同周期来源：核心卡累计差分与成长趋势指数拟合。
    // 两者都是完整序列时，逐格比较会把正常的口径差异误判为冲突并清空整列。
    // 因此先在整条序列级别锁定一个来源，禁止按天混拼：能严格闭合周期总
    // GMV 的差分优先；否则使用已闭合的趋势拟合；拟合不可用时才保留现有
    // 差分单日值。两套都没有时继续留空，绝不均摊或补 0。
    return model.competitorDaily?.gmvClosed === true
      ? "paired"
      : model.daily?.gmvFit?.status === "ready"
        ? "line"
        : (model.competitorDaily?.rows || []).some(row => completenessEngine.isNumericMetricValue(row?.gmv))
          ? "paired"
          : "none";
  }

  function competitorDailyGmvValue(source, pairedRow, lineRow) {
    if (source === "paired") return pairedRow?.gmv;
    if (source === "line") return lineRow?.dailyGmv;
    return null;
  }

  function competitorDailyGmvRows(model) {
    const source = competitorDailyGmvSource(model);
    const lineRows = model.daily?.rows || [];
    if (source !== "paired") return source === "line" ? lineRows : [];
    const lineByDate = new Map(lineRows.map(row => [row.date, row]));
    return (model.competitorDaily?.rows || []).map(row => ({
      ...(lineByDate.get(row.date) || {}),
      date: row.date,
      dailyGmv: row.gmv
    }));
  }

  function buildDailyTableFromModel(model) {
    const labels = completenessEngine.CHANNELS.map(([, label]) => label);
    const subjectDailyRows = (model.subjectDaily?.rows || []).map(row => [row.date, modelCell(row.gmv)]);
    const subjectByDate = new Map((model.subjectDaily?.rows || []).map(row => [row.date, row]));
    const competitorByDate = new Map((model.competitorDaily?.rows || []).map(row => [row.date, row]));
    const lineByDate = new Map((model.daily?.rows || []).map(row => [row.date, row]));
    const competitorGmvSource = competitorDailyGmvSource(model);
    // 05 表按完整目标周期保留每天一行。平台尚未返回的那天仍显示日期并
    // 保持业务格为空，不能因为三类日源都缺失就让整行从报告中消失。
    const dates = [...new Set([
      ...(model.daily?.expectedDates || []),
      ...(model.subjectDaily?.expectedDates || []),
      ...(model.competitorDaily?.expectedDates || []),
      ...completenessEngine.enumerateDates(model.period?.startDate, model.period?.endDate),
      ...subjectByDate.keys(), ...competitorByDate.keys(), ...lineByDate.keys()
    ])].sort();
    const numericSelection = (...values) => {
      const candidates = values.map(value => ({ value, state: completenessEngine.metricValueState(value) }))
        .filter(candidate => [completenessEngine.VALUE_STATES.EXACT, completenessEngine.VALUE_STATES.INTERVAL].includes(candidate.state.state));
      if (!candidates.length) return { value: null, conflict: false };
      const conflict = candidates.some((left, index) => candidates.slice(index + 1)
        .some(right => !completenessEngine.metricRangesCompatible(left.value, right.value)));
      if (conflict) return { value: null, conflict: true };
      let selected = null;
      let selectedRank = 0;
      for (const candidate of candidates) {
        const rank = candidate.state.state === completenessEngine.VALUE_STATES.EXACT
          ? 2
          : 1;
        if (rank <= selectedRank) continue;
        selectedRank = rank;
        selected = candidate.state.state === completenessEngine.VALUE_STATES.EXACT
          ? candidate.state.value
          : candidate.value && typeof candidate.value === "object" && Object.prototype.hasOwnProperty.call(candidate.value, "value")
            ? candidate.value.value
            : candidate.value;
      }
      return { value: selectedRank ? selected : null, conflict: false };
    };
    const numericPreferred = (...values) => numericSelection(...values).value;
    const formulaOrFallback = (numerator, denominator, options, fallback = null, blocked = false) => {
      if (blocked) return null;
      const numericStates = [completenessEngine.VALUE_STATES.EXACT, completenessEngine.VALUE_STATES.INTERVAL];
      const operandsReady = numericStates.includes(completenessEngine.metricValueState(numerator).state)
        && numericStates.includes(completenessEngine.metricValueState(denominator).state);
      if (!operandsReady) return numericPreferred(fallback);
      const result = completenessEngine.safeIntervalDivide(numerator, denominator, {
        ...options,
        outward: true
      });
      return numericStates.includes(result.state)
        ? result.value
        : null;
    };
    const sideValues = (side, pairedRow, lineRow) => {
      const isSubject = side === "subject";
      const lineSideAllowed = !isSubject || lineRow?.hasPairedChannels === true;
      const channelConflict = pairedRow?.channelSpendConflict === true;
      const lineChannels = lineSideAllowed && !channelConflict
        ? (isSubject ? lineRow?.subjectChannelSpend : lineRow?.channelSpend) || {}
        : {};
      const channelSelections = Object.fromEntries(labels.map(label => [
        label,
        numericSelection(
          channelConflict ? null : pairedRow?.channelSpend?.[label],
          lineChannels[label]
        )
      ]));
      const channels = Object.fromEntries(labels.map(label => [label, channelSelections[label].value]));
      const channelValues = labels.map(label => channels[label]);
      const channelTotal = !labels.some(label => channelSelections[label].conflict)
        && channelValues.length && channelValues.every(value => completenessEngine.isNumericMetricValue(value))
        ? completenessEngine.sumMetricRanges(channelValues)
        : null;
      const lineSpend = lineSideAllowed && !channelConflict
        ? (isSubject ? lineRow?.subjectTotalSpend : lineRow?.totalSpend)
        : null;
      const spendSelection = numericSelection(pairedRow?.totalSpend, lineSpend, channelTotal);
      const gmvSelection = numericSelection(isSubject
        ? pairedRow?.gmv
        : competitorDailyGmvValue(competitorGmvSource, pairedRow, lineRow));
      const spend = spendSelection.value;
      const gmv = gmvSelection.value;
      const metrics = pairedRow?.metrics || {};
      const sourceRoi = numericPreferred(metrics.roi);
      const directPaidGmv = numericPreferred(metrics.paidGmv);
      const calculatedPaidGmv = directPaidGmv == null
        ? numericPreferred(completenessEngine.paidGmvFromSpendAndRoi(spend, sourceRoi))
        : null;
      const paidGmv = numericPreferred(directPaidGmv, calculatedPaidGmv);

      // 方向值在模型后置解析为单边数值区间后，必须在此处按最终同日分子/
      // 分母重新闭合；公式成功时覆盖接口旧效率值，失败时才保留同日数值源。
      const roi = formulaOrFallback(
        paidGmv,
        spend,
        { digits: 2, metric: "ROI", compact: false },
        sourceRoi,
        spendSelection.conflict
      );
      const ppc = formulaOrFallback(
        spend,
        numericPreferred(metrics.marketingClicks),
        { digits: 2, metric: "PPC", compact: false },
        metrics.ppc,
        spendSelection.conflict
      );
      const feeRatio = formulaOrFallback(
        spend,
        gmv,
        { digits: 6, metric: "费比", compact: true },
        numericPreferred(pairedRow?.feeRatio, metrics.feeRatio, isSubject ? null : lineRow?.feeRatio),
        spendSelection.conflict || gmvSelection.conflict
      );
      return { channels, spend, gmv, paidGmv, roi, ppc, feeRatio };
    };
    const columns = [
      "日期", "主体日GMV", "对手日GMV",
      "主体日付费成交额", "对手日付费成交额",
      ...labels.flatMap(label => [`主体${label}日消耗`, `对手${label}日消耗`]),
      "主体日总消耗", "对手日总消耗",
      "主体日ROI", "对手日ROI", "主体日PPC", "对手日PPC",
      "主体日费比", "对手日费比", "阶段"
    ];
    const rows = dates.map(date => {
      const subject = subjectByDate.get(date);
      const competitor = competitorByDate.get(date);
      const line = lineByDate.get(date);
      const stage = line?.stage || model.stages?.find(current => (!current.start || date >= current.start) && (!current.end || date <= current.end))?.name || "";
      const subjectValues = sideValues("subject", subject, line);
      const competitorValues = sideValues("competitor", competitor, line);
      return [
        date, metricCell(subjectValues.gmv), metricCell(competitorValues.gmv),
        metricCell(subjectValues.paidGmv), metricCell(competitorValues.paidGmv),
        ...labels.flatMap(label => [
          metricCell(subjectValues.channels[label]),
          metricCell(competitorValues.channels[label])
        ]),
        metricCell(subjectValues.spend), metricCell(competitorValues.spend),
        metricCell(subjectValues.roi), metricCell(competitorValues.roi),
        metricCell(subjectValues.ppc), metricCell(competitorValues.ppc),
        metricCell(subjectValues.feeRatio), metricCell(competitorValues.feeRatio), stage
      ];
    });
    return table("日GMV与费比", columns, rows, {
      widths: [13, 16, 16, 20, 20, ...labels.flatMap(() => [24, 24]), 16, 16, 14, 14, 14, 14, 14, 14, 15],
      subjectDailyRows
    });
  }

  function buildSceneTablesFromModel(model) {
    const columns = ["对象", "层级", "一级场景", "二级场景", "场景编号", "消耗", "消耗占比", "分配后消耗", "展现", "点击", "CTR", "CPC", "直接成交金额", "直接ROI"];
    const convert = row => [row.role, row.level, row.primary, row.secondary, row.sceneId, metricCell(row.charge), metricCell(row.ratio), metricCell(row.allocated), metricCell(row.impression), metricCell(row.click), metricCell(row.ctr), metricCell(row.cpc), metricCell(row.directDealAmount), metricCell(row.directRoi)];
    return [
      table("一级场景", columns, model.sceneRows.level1.map(convert), { widths: [10, 8, 16, 12, 12, 17, 19, 16, 15, 12, 12, 12, 17, 13] }),
      table("二级场景", columns, model.sceneRows.level2.map(convert), { widths: [10, 8, 16, 48, 11, 17, 19, 16, 15, 12, 12, 12, 17, 13] })
    ];
  }

  function buildChannelTableFromModel(model) {
    const subjectRows = model.sceneRows.level1.filter(row => row.role === "主体");
    const subjectByChannel = new Map(subjectRows.map(row => [row.primary, Number.isFinite(toNumber(row.charge)) ? toNumber(row.charge) : toNumber(row.allocated)]));
    const subjectTotal = toNumber(reportMetricValue(model, "subject", "spend"));
    const competitorTotal = toNumber(model.daily.totalSpend);
    const rows = completenessEngine.CHANNELS.map(([apiName, label]) => {
      const subjectSpend = subjectByChannel.get(label);
      const competitorSpend = model.daily.channelSpend[label];
      return [label, apiName, modelCell(competitorSpend), Number.isFinite(competitorSpend) && Number.isFinite(competitorTotal) && competitorTotal !== 0 ? round(competitorSpend / competitorTotal, 6) : EMPTY,
        modelCell(subjectSpend), Number.isFinite(subjectSpend) && Number.isFinite(subjectTotal) && subjectTotal !== 0 ? round(subjectSpend / subjectTotal, 6) : EMPTY];
    });
    rows.push(["合计", "", metricCell(model.daily.totalSpend), Number.isFinite(competitorTotal) ? 1 : EMPTY, metricCell(reportMetricValue(model, "subject", "spend")), Number.isFinite(subjectTotal) ? 1 : EMPTY]);
    const subjectAllocation = model.sceneRows?.allocationScope || {};
    const subjectDays = subjectAllocation.subject === "coverage-period"
      ? Number(subjectAllocation.subjectDays) || model.period.days || 30
      : model.period.days || model.daily.rows.length || 30;
    const competitorDays = Number.isFinite(model.daily.totalSpend) ? (model.daily.spendCoverageDays || subjectDays) : subjectDays;
    return table("渠道花费", ["渠道", "页面指标", `对手${competitorDays}日消耗`, `对手${competitorDays}日占比`, `主体${subjectDays}日消耗`, `主体${subjectDays}日占比`], rows, {
      widths: [16, 28, 18, 18, 18, 18], chartTitle: `主体${subjectDays}日/对手${competitorDays}日渠道消耗对比`
    });
  }

  function populationVolatility(values) {
    if (!values.length) return null;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    if (!Number.isFinite(mean) || mean === 0) return null;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance) / mean;
  }

  function buildPeriodTableFromModel(model, item) {
    const competitorRows = competitorDailyGmvRows(model);
    const competitorDailyGmv = competitorRows.map(row => row.dailyGmv).filter(Number.isFinite);
    const competitorPeakRow = competitorRows.filter(row => Number.isFinite(row.dailyGmv)).sort((left, right) => right.dailyGmv - left.dailyGmv)[0];
    const subjectRows = (model.subjectDaily?.rows || []).filter(row => Number.isFinite(row.gmv));
    const subjectDailyGmv = subjectRows.map(row => row.gmv);
    const subjectPeakRow = subjectRows.slice().sort((left, right) => right.gmv - left.gmv)[0];
    const columns = ["商品ID", "对象", "周期开始", "周期结束", "天数", "成交笔数", "笔单价", "总GMV", "付费成交额", "付费成交笔数", "广告消耗", "费比", "全域ROAS", "付费金额占比", "广告订单贡献率", "日均GMV", "日均消耗", "GMV峰值日", "GMV波动率"];
    const make = (id, label, source, side, peakDate = "", volatility = null) => {
      const spendScope = reportSideSpendScope(model, side);
      const spendDays = spendScope.partial
        ? Number(spendScope.coverage.coverageDays) || 0
        : Number(model.period.days) || 0;
      const scopedLabel = spendScope.partial
        ? `${label}（花费已返回${spendScope.coverage.coverageDays}/${spendScope.coverage.expectedDays}日）`
        : label;
      const spend = reportMetricValue(model, side, "spend");
      const value = key => reportMetricValue(model, side, key);
      const average = (metricValue, days, metric) => completenessEngine.safeIntervalDivide(metricValue, days, {
        digits: 2, metric, outward: true
      }).value;
      const totalGmv = value("totalGmv");
      return [
        id, scopedLabel, model.period.startDate, model.period.endDate, model.period.days,
        metricCell(value("orders")), metricCell(value("aov")), metricCell(totalGmv), metricCell(value("paidGmv")), metricCell(value("paidOrders")), metricCell(spend),
        metricCell(value("feeRatio")), metricCell(value("roas")),
        metricCell(value("paidGmvContribution")), metricCell(value("paidOrderContribution")),
        metricCell(average(totalGmv, model.period.days, "日均GMV")),
        metricCell(spendDays > 0 ? average(spend, spendDays, "日均消耗") : null),
        peakDate, modelCell(volatility == null ? null : round(volatility, 6))
      ];
    };
    const rows = [
      make(item.id, `主体商品・${model.period.days}日`, model.metrics.subject, "subject", subjectPeakRow?.date || "", populationVolatility(subjectDailyGmv)),
      make(item.competitorId, `目标对手・${model.period.days}日`, model.metrics.competitor, "competitor", competitorPeakRow?.date || "", populationVolatility(competitorDailyGmv))
    ];
    return table("周期汇总", columns, rows, { widths: [18, 18, 13, 13, 9, 13, 15, 16, 16, 16, 16, 13, 13, 18, 18, 16, 16, 15, 14] });
  }

  function buildBenchmarkFromModel(model) {
    const metric = (side, key) => reportMetricValue(model, side, key);
    const metrics = model.metrics;
    const core = [
      ["成交", "总GMV", metric("subject", "totalGmv"), metric("competitor", "totalGmv")],
      ["成交", "成交笔数", metric("subject", "orders"), metric("competitor", "orders")],
      ["成交", "笔单价", metric("subject", "aov"), metric("competitor", "aov")],
      ["转化", "支付转化率", metric("subject", "conversion"), metric("competitor", "conversion")],
      ["流量", "访客数", metric("subject", "visitors"), metric("competitor", "visitors")],
      ["投放", "推广消耗", metric("subject", "spend"), metric("competitor", "spend")],
      ["投放", "付费成交额", metric("subject", "paidGmv"), metric("competitor", "paidGmv")],
      ["投放", "付费成交笔数", metric("subject", "paidOrders"), metric("competitor", "paidOrders")],
      ["投放", "付费金额占比", metric("subject", "paidGmvContribution"), metric("competitor", "paidGmvContribution")],
      ["投放", "ROI", metric("subject", "roi"), metric("competitor", "roi")],
      ["投放", "PPC", metric("subject", "ppc"), metric("competitor", "ppc")],
      ["投放", "费比", metric("subject", "feeRatio"), metric("competitor", "feeRatio")],
      ["投放", "全域ROAS", metric("subject", "roas"), metric("competitor", "roas")],
      ["结构", "关键词消耗占比", metric("subject", "keywordShare"), metric("competitor", "keywordShare")],
      ["结构", "渠道集中度HHI", metric("subject", "channelHhi"), metric("competitor", "channelHhi")]
    ];
    const resolvedCore = coreRowsWithAlignedFallback(model, core, 1, 2, 3);
    const appended = alignedMetricRows(model, resolvedCore.map(row => row[1]))
      .map(metric => ["核心指标", metric.name, metric.subject, metric.competitor]);
    const rows = [...resolvedCore, ...appended]
      .map(row => [row[0], row[1], modelCell(row[2]), modelCell(row[3]), relative(row[2], row[3], isPercentMetric(row[1]))]);
    return table("对标总表", ["页面模块", "对标指标", "主体周期值", "对手周期值", "主体相对对手"], rows, { widths: [15, 28, 20, 22, 18] });
  }

  function buildStageTableFromModel(model) {
    const rows = [];
    const competitorSeriesRows = competitorDailyGmvRows(model);
    const stats = (selected, role) => {
      const gmvKey = role === "主体" ? "gmv" : "dailyGmv";
      const gmvRows = selected.filter(row => Number.isFinite(row?.[gmvKey]));
      const gmvs = gmvRows.map(row => row[gmvKey]);
      const spendValues = selected.map(row => row?.totalSpend);
      const spend = selected.length && spendValues.every(Number.isFinite)
        ? round(spendValues.reduce((sum, value) => sum + value, 0))
        : null;
      const channelTotals = completenessEngine.CHANNELS.map(([, label]) => {
        const values = selected.map(row => row?.channelSpend?.[label]);
        return selected.length && values.every(Number.isFinite)
          ? round(values.reduce((sum, value) => sum + value, 0))
          : null;
      });
      const maximum = channelTotals.filter(Number.isFinite).sort((left, right) => right - left)[0];
      const maximumIndex = Number.isFinite(maximum) && maximum > 0 ? channelTotals.indexOf(maximum) : -1;
      return {
        startGmv: gmvs.length ? gmvs[0] : null,
        endGmv: gmvs.length ? gmvs.at(-1) : null,
        change: gmvs.length && gmvs[0] !== 0 ? round(gmvs.at(-1) / gmvs[0] - 1, 6) : null,
        averageGmv: gmvs.length ? round(gmvs.reduce((sum, value) => sum + value, 0) / gmvs.length) : null,
        spend,
        averageSpend: Number.isFinite(spend) && selected.length ? round(spend / selected.length) : null,
        firstChannel: maximumIndex >= 0 ? completenessEngine.CHANNELS[maximumIndex][1] : null,
        firstChannelShare: maximumIndex >= 0 && spend ? round(maximum / spend, 6) : null,
        disclosed: gmvRows.length > 0 || spendValues.some(disclosedModelValue)
      };
    };
    for (const stage of model.stages) {
      const start = stage.start && stage.start < model.period.startDate ? model.period.startDate : stage.start;
      const end = stage.end && stage.end > model.period.endDate ? model.period.endDate : stage.end;
      const inStage = row => (!start || row.date >= start) && (!end || row.date <= end);
      const subjectSelected = (model.subjectDaily?.rows || []).filter(inStage);
      const competitorSelected = competitorSeriesRows.filter(inStage);
      const subject = stats(subjectSelected, "主体");
      const competitor = stats(competitorSelected, "对手");
      const hasPromotionDetails = [stage.description, stage.adStrategy, stage.executionDetails, stage.operations]
        .some(value => String(value || "").trim());
      if (!subject.disclosed && !competitor.disclosed && !hasPromotionDetails) continue;
      const dates = new Set([...subjectSelected, ...competitorSelected].map(row => row.date).filter(Boolean));
      const days = dates.size || (start && end ? Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1 : null);
      rows.push([
        stage.stage, start, end, stage.name, stage.description, stage.adStrategy || "", stage.executionDetails || "", stage.operations || "", modelCell(days),
        modelCell(subject.startGmv), modelCell(competitor.startGmv), modelCell(subject.endGmv), modelCell(competitor.endGmv),
        modelCell(subject.change), modelCell(competitor.change), modelCell(subject.averageGmv), modelCell(competitor.averageGmv),
        modelCell(subject.spend), modelCell(competitor.spend), modelCell(subject.averageSpend), modelCell(competitor.averageSpend),
        modelCell(subject.firstChannel), modelCell(competitor.firstChannel), modelCell(subject.firstChannelShare), modelCell(competitor.firstChannelShare)
      ]);
    }
    return table("成长阶段数据", [
      "阶段", "开始", "结束", "阶段名称", "阶段描述", "广告打法", "执行细节", "运营动作", "天数",
      "主体起始GMV", "对手起始GMV", "主体结束GMV", "对手结束GMV", "主体GMV变化", "对手GMV变化",
      "主体平均日GMV", "对手平均日GMV", "主体阶段总消耗", "对手阶段总消耗", "主体日均消耗", "对手日均消耗",
      "主体第一渠道", "对手第一渠道", "主体第一渠道占比", "对手第一渠道占比"
    ], rows, {
      widths: [9, 13, 13, 16, 34, 42, 68, 68, 9, 16, 16, 16, 16, 13, 13, 16, 16, 16, 16, 16, 16, 15, 15, 17, 17], chartTitle: "阶段平均日GMV对比"
    });
  }

  function buildBaseMetricTableFromModel(model) {
    const metric = (side, key) => reportMetricValue(model, side, key);
    const metrics = model.metrics;
    const core = [
      ["营销推广点击量", metric("subject", "marketingClicks"), metric("competitor", "marketingClicks")],
      ["自然点击量", metric("subject", "naturalClicks"), metric("competitor", "naturalClicks")],
      ["成交笔数", metric("subject", "orders"), metric("competitor", "orders")],
      ["支付转化率", metric("subject", "conversion"), metric("competitor", "conversion")],
      ["笔单价", metric("subject", "aov"), metric("competitor", "aov")],
      ["加购率", metric("subject", "cartRate"), metric("competitor", "cartRate")],
      ["访客数", metric("subject", "visitors"), metric("competitor", "visitors")],
      ["总GMV", metric("subject", "totalGmv"), metric("competitor", "totalGmv")],
      ["广告/推广消耗", metric("subject", "spend"), metric("competitor", "spend")],
      ["付费成交额", metric("subject", "paidGmv"), metric("competitor", "paidGmv")],
      ["付费成交笔数", metric("subject", "paidOrders"), metric("competitor", "paidOrders")],
      ["付费金额占比", metric("subject", "paidGmvContribution"), metric("competitor", "paidGmvContribution")],
      ["ROI", metric("subject", "roi"), metric("competitor", "roi")],
      ["PPC", metric("subject", "ppc"), metric("competitor", "ppc")],
      ["费比", metric("subject", "feeRatio"), metric("competitor", "feeRatio")],
      ["全域ROAS", metric("subject", "roas"), metric("competitor", "roas")]
    ];
    const resolvedCore = coreRowsWithAlignedFallback(model, core, 0, 1, 2);
    const appended = alignedMetricRows(model, resolvedCore.map(row => row[0]))
      .map(metric => [metric.name, metric.subject, metric.competitor]);
    const rows = [...resolvedCore, ...appended]
      .map(row => [row[0], modelCell(row[1]), modelCell(row[2]), relative(row[1], row[2], isPercentMetric(row[0]))]);
    return table("基础指标对比", ["指标", "主体值", "对手值", "主体相对对手"], rows, { widths: [28, 20, 20, 20] });
  }

  function buildKeywordTableFromModel(model) {
    const paired = new Map();
    for (const row of model.keywords || []) {
      const keyword = String(row.keyword || "").trim();
      const type = String(row.type || "").trim();
      if (!keyword) continue;
      const key = `${keyword}\u0001${type}`;
      const current = paired.get(key) || { keyword, type, subject: {}, competitor: {} };
      const side = row.role === "主体" ? current.subject : current.competitor;
      for (const field of ["impression", "click", "ctr", "conversion"]) {
        if (!disclosedModelValue(side[field]) && disclosedModelValue(row[field])) side[field] = row[field];
      }
      paired.set(key, current);
    }
    const rows = [...paired.values()].map(row => [
      row.keyword, row.type,
      modelCell(row.subject.impression), modelCell(row.competitor.impression),
      modelCell(row.subject.click), modelCell(row.competitor.click),
      modelCell(row.subject.ctr), modelCell(row.competitor.ctr),
      modelCell(row.subject.conversion), modelCell(row.competitor.conversion)
    ]);
    return table("关键词样本", ["关键词", "词类型", "主体展现", "对手展现", "主体点击", "对手点击", "主体CTR", "对手CTR", "主体支付转化率", "对手支付转化率"], rows, {
      widths: [24, 16, 15, 15, 15, 15, 14, 14, 17, 17]
    });
  }

  function chinaClock(value) {
    const parsed = Date.parse(value || "");
    const shifted = new Date((Number.isFinite(parsed) ? parsed : Date.now()) + 8 * 60 * 60 * 1000);
    return { date: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours() };
  }

  function previousDate(date) {
    const parsed = Date.parse(`${date}T00:00:00Z`);
    return Number.isFinite(parsed) ? new Date(parsed - 24 * 60 * 60 * 1000).toISOString().slice(0, 10) : "";
  }

  function morningSpendTiming(model, generatedAt) {
    const clock = chinaClock(generatedAt);
    const affectedDate = model.period?.endDate || "";
    const row = model.daily?.rows?.find(candidate => candidate.date === affectedDate);
    const channelValues = completenessEngine.CHANNELS.map(([, label]) => row?.channelSpend?.[label]);
    const completeZeroSpend = channelValues.length > 0 && channelValues.every(value => Number.isFinite(value) && value === 0);
    if (clock.hour >= 10 || affectedDate !== previousDate(clock.date) || !completeZeroSpend) return null;
    return {
      affectedDate,
      note: `北京时间0:00–10:00，${affectedDate}消耗可能尚未产出；本报告已按当前可见数据生成，建议10:00–24:00重新获取数据。`
    };
  }

  function buildOverviewFromModel(model, item, periodLabel, periodSheet, spendTiming = null) {
    const subject = model.metrics?.subject || {};
    const competitor = model.metrics?.competitor || {};
    const strictScope = `${model.period.days}日严格同周期`;
    const spendScope = reportSpendScope(model);
    const subjectSpendScope = spendScope.sides.find(side => side.side === "subject");
    const competitorSpendScope = spendScope.sides.find(side => side.side === "competitor");
    const metric = (side, key) => modelCell(reportMetricValue(model, side, key));
    const spendMetricKeys = new Set(["spend", "feeRatio", "roi", "ppc", "globalROAS"]);
    const overviewMetrics = CORE_METRIC_CONTRACT.map(definition => ({
      key: definition.key,
      label: definition.label,
      subject: metric("subject", definition.key),
      competitor: metric("competitor", definition.key),
      scope: spendMetricKeys.has(definition.key) ? spendScope.metric : strictScope
    }));
    const rows = [
      ["商品ID", item.id, item.competitorId, ""],
      ["商品标题", item.title, item.competitorTitle, ""],
      [`${model.period.days}日对齐周期`, `${model.period.startDate} 至 ${model.period.endDate}`, `${model.period.startDate} 至 ${model.period.endDate}`, `${model.period.days}天`],
      ...overviewMetrics.map(current => [current.label, current.subject, current.competitor, current.scope])
    ];
    if (spendTiming) rows.push(["取数时段提示", `0:00–10:00 ${spendTiming.affectedDate}消耗可能未产出`, "已按当前可见数据生成", "建议10:00–24:00重新获取"]);
    // 平台还没产出的天数必须写进报告本身，读报告的人不看面板也能知道少了哪天。
    const gap = model.completeness?.platformGap;
    if (gap?.tolerated) rows.push([
      "数据说明", `平台少${gap.days}天数据：${gap.dates.join("、")}`,
      `趋势已覆盖${gap.coverageDays}/${gap.expectedDays}天，消耗已覆盖${model.daily.spendCoverageDays}/${model.daily.spendExpectedDays}天`,
      "缺失当天数值留空，未按0计入"
    ]);
    if (model.daily.spendPartial) rows.push([
      "花费覆盖", "", `已返回${model.daily.spendCoverageDays}/${model.daily.spendExpectedDays}天`,
      `缺少${model.daily.spendMissingDates.length}天：${model.daily.spendMissingDates.join("、")}`
    ]);
    return table("报告总览", ["项目", "主体", "对手", "范围"], rows, {
      subtitle: `主体 ${item.id}｜对手 ${item.competitorId}｜${model.period.startDate} 至 ${model.period.endDate}${spendScope.partial ? `｜花费口径：${spendScope.metric}` : ""}`,
      widths: [18, 46, 46, 18, 16, 16, 16, 16, 16, 16, 16, 16],
      overviewMetrics,
      kpis: [
        { role: "subject", label: `主体${model.period.days}日GMV`, value: metric("subject", "totalGmv"), source: "'周期汇总'!H5" },
        { role: "competitor", label: `对手${model.period.days}日GMV`, value: metric("competitor", "totalGmv"), source: "'周期汇总'!H6" },
        {
          role: "subject",
          label: subjectSpendScope?.partial ? `主体费比（已返回${subjectSpendScope.coverage.coverageDays}/${subjectSpendScope.coverage.expectedDays}日）` : "主体费比",
          value: metric("subject", "feeRatio"),
          source: subjectSpendScope?.partial ? "" : "'周期汇总'!K5"
        },
        {
          role: "competitor",
          label: competitorSpendScope?.partial ? `对手费比（已返回${competitorSpendScope.coverage.coverageDays}/${competitorSpendScope.coverage.expectedDays}日）` : "对手费比",
          value: metric("competitor", "feeRatio"),
          source: competitorSpendScope?.partial ? "" : "'周期汇总'!K6"
        },
        { role: "subject", label: "主体ROI", value: metric("subject", "roi"), source: "" },
        { role: "competitor", label: "对手ROI", value: metric("competitor", "roi"), source: "" },
        { role: "subject", label: "主体PPC", value: metric("subject", "ppc"), source: "" },
        { role: "competitor", label: "对手PPC", value: metric("competitor", "ppc"), source: "" }
      ]
    });
  }

  function buildReport(records, itemId, meta = {}) {
    if (!completenessEngine?.deriveGrowth) throw new Error("v2.0 完整性解析引擎未加载");
    const startedAt = meta.startedAt || "";
    const model = completenessEngine.deriveGrowth(records, { ...meta, subjectItemId: itemId });
    const period = model.period;
    const range = period.startDate && period.endDate ? `${period.startDate} 至 ${period.endDate}` : "";
    const precision = meta.periodPrecision || (meta.periodConfirmed ? "exact" : "failed");
    const periodLabel = precision === "exact"
      ? `近${period.days}天${range ? `（${range}）` : ""}`
      : precision === "preset"
        ? `近${period.days}天${meta.periodShown ? `（页面口径 ${meta.periodShown}）` : "（页面预设口径）"}`
        : `近${period.days}天${range ? `（${range}，页面日期控件待确认）` : "（页面日期控件待确认）"}`;
    const item = {
      id: model.item?.itemId || String(itemId || ""), title: model.item?.title || "",
      pictureUrl: model.item?.pictureUrl || "", detailUrl: model.item?.detailUrl || "",
      competitorId: model.targetSuccess?.itemId || String(meta.successItemId || ""), competitorTitle: model.targetSuccess?.title || "",
      competitorPictureUrl: model.targetSuccess?.pictureUrl || "", competitorDetailUrl: model.targetSuccess?.detailUrl || ""
    };
    const itemSheet = buildItemTableFromModel(model);
    const periodSheet = buildPeriodTableFromModel(model, item);
    const sceneSheets = buildSceneTablesFromModel(model);
    const spendTiming = morningSpendTiming(model, meta.finishedAt);
    const tables = [
      buildOverviewFromModel(model, item, periodLabel, periodSheet, spendTiming), buildBenchmarkFromModel(model), itemSheet, periodSheet,
      buildDailyTableFromModel(model), buildChannelTableFromModel(model), sceneSheets[0], sceneSheets[1],
      buildStageTableFromModel(model), buildBaseMetricTableFromModel(model), buildKeywordTableFromModel(model)
    ];
    const dateRange = range || periodLabel;
    const spendScope = reportSpendScope(model);
    const spendScopeSuffix = spendScope.partial ? `｜花费口径：${spendScope.metric}` : "";
    const periodSpendScopeSuffix = spendScope.partial ? `${spendScopeSuffix}；缺失日未按0` : "";
    const sceneAllocation = model.sceneRows?.allocationScope || {};
    const sceneSideScope = (side, role) => {
      const scope = sceneAllocation[side];
      const start = sceneAllocation[`${side}Start`];
      const end = sceneAllocation[`${side}End`];
      const days = Number(sceneAllocation[`${side}Days`]) || 0;
      if (scope === "coverage-period") {
        const rangeLabel = start && end ? `（${start} 至 ${end}）` : "";
        return `${role}分配基数已返回${days}/${model.period.days}日${rangeLabel}`;
      }
      if (scope === "missing") return `${role}分配基数缺失`;
      return `${role}${model.period.days}日严格同周期`;
    };
    const sceneScopeParts = [
      sceneSideScope("subject", "主体"),
      sceneSideScope("competitor", "对手")
    ];
    const sceneHasPartial = sceneAllocation.subject === "coverage-period" || sceneAllocation.competitor === "coverage-period";
    const sceneScope = `${dateRange}｜${sceneScopeParts.join("；")}${sceneHasPartial ? "；缺失日未按0" : ""}`;
    const subtitles = {
      "对标总表": `${dateRange}｜主体 ${item.id} vs 对手 ${item.competitorId}${spendScopeSuffix}`,
      "商品与成功品": "本次分析目标与成功品候选",
      "周期汇总": `${period.days}日成交周期对齐${periodSpendScopeSuffix}`,
      "日GMV与费比": `主体 ${item.id} vs 对手 ${item.competitorId}｜${model.period.startDate} ~ ${model.period.endDate}（${model.period.days}天）`,
      "渠道花费": `${dateRange}｜五渠道消耗与占比${spendScopeSuffix}`,
      "一级场景": `${sceneScope}｜一级投放场景数据`,
      "二级场景": `${sceneScope}｜二级投放场景数据`,
      "成长阶段数据": `${dateRange}｜主体与目标对手同阶段金额数据`,
      "基础指标对比": `${dateRange}｜主体与目标成功品数值对比${spendScopeSuffix}`,
      "关键词样本": `${dateRange}｜按关键词与词类型对齐主体和对手`
    };
    tables.forEach(current => { if (!current.subtitle) current.subtitle = subtitles[current.name] || dateRange; });

    const metricContract = model.metricContract || (typeof completenessEngine.evaluateCoreMetricContract === "function"
      ? completenessEngine.evaluateCoreMetricContract(model.metrics, {
        sceneRows: model.sceneRows,
        contexts: {
          subject: { expected: model.metrics.subject.expectedContext, values: model.metrics.subject.valueContexts },
          competitor: { expected: model.metrics.competitor.expectedContext, values: model.metrics.competitor.valueContexts }
        }
      })
      : null);
    const deterministicMissing = metricContract
      ? metricContract.missing.map(entry => entry.label)
      : CORE_METRIC_CONTRACT.flatMap(definition => ["subject", "competitor"].map(side => ({ definition, side })))
        .filter(({ definition, side }) => !definition.sourceKeys.some(key => disclosedModelValue(model.metrics?.[side]?.[key])))
        .map(({ definition, side }) => `${side === "subject" ? "主体" : "对手"}${definition.label}`);
    const requiredValueCount = metricContract?.requiredValues || CORE_METRIC_CONTRACT.length * 2;
    const resolvedValueCount = metricContract?.resolvedValues ?? Math.max(0, requiredValueCount - deterministicMissing.length);
    const moduleRules = [
      ["商品概况", path => path === "/api/goods/item/info"],
      ["成功品", path => path === "/api/goods/grow/define/success/load" || path === "/api/goods/grow/define/success/item/list"],
      ["核心指标", path => path === "/dataplatform/dataset/report/query"],
      ["成长阶段与趋势", path => path === "/api/goods/grow/define/line/data"],
      ["投放场景", path => path === "/api/goods/grow/comparison/scene"],
      ["关键词样本", path => path === "/api/goods/grow/comparison/scene/keyword"]
    ];
    const endpointStatus = moduleRules.map(([module, matches]) => {
      const entries = model.completeness.endpointCoverage.filter(entry => matches(entry.path));
      return { module, captured: entries.reduce((sum, entry) => sum + entry.records, 0), usable: entries.reduce((sum, entry) => sum + entry.parsed + entry.empty, 0) };
    });
    const observed = endpointStatus.filter(status => status.usable > 0).length;
    const missing = [...endpointStatus.filter(status => !status.usable).map(status => status.module), ...model.completeness.blockingIssues, ...deterministicMissing.map(label => `${label}未填`)];
    const complete = model.completeness.status === "ready" && metricContract?.complete !== false && deterministicMissing.length === 0;
    return {
      version: 3, title: "达摩盘商品成长竞品对标报告｜少壮AI自动化", item, period, periodLabel, startedAt,
      finishedAt: meta.finishedAt || new Date().toISOString(), visitedPaths: meta.visitedPaths || [], recordCount: model.completeness.businessRecords, tables,
      quality: {
        status: model.completeness.status, expected: moduleRules.length, observed, missing: [...new Set(missing)],
        truncated: model.completeness.endpointCoverage.filter(entry => entry.reasons.some(reason => /truncated/.test(reason))).reduce((sum, entry) => sum + entry.failed, 0),
        complete, exportAllowed: complete, partialAfterRecapture: false,
        requiredValues: requiredValueCount, resolvedValues: resolvedValueCount,
        endpointStatus, endpointCoverage: model.completeness.endpointCoverage,
        parsedRecords: model.completeness.parsedRecords, failedRecords: model.completeness.failedRecords,
        blockingIssues: model.completeness.blockingIssues, warnings: model.completeness.warnings, notes: model.completeness.notes || [], deterministicMissing,
        metricContract,
        missingReasons: metricContract?.missingReasons || {},
        spendTiming, platformGap: model.completeness.platformGap,
        spendCoverage: {
          returnedDays: model.daily.spendCoverageDays,
          expectedDays: model.daily.spendExpectedDays,
          missingDates: model.daily.spendMissingDates,
          partial: model.daily.spendPartial
        }
      }
    };
  }

  function csvEscape(value) {
    let text = displayValue(value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function buildCsv(report) {
    const lines = [];
    report.tables.forEach((current, index) => {
      if (index) lines.push([]);
      lines.push([current.name], current.columns);
      current.rows.forEach(row => lines.push(row.map((value, cellIndex) => {
        const semantic = current.name === "对标总表"
          ? `${current.columns[cellIndex]} ${row[1]}`
          : current.name === "基础指标对比" || current.name === "报告总览"
            ? `${current.columns[cellIndex]} ${row[0]}`
            : current.columns[cellIndex];
        return formatMetricValue(semantic, value);
      })));
    });
    return "\ufeff" + lines.map(line => line.map(csvEscape).join(",")).join("\r\n");
  }

  function canonicalCell(value, semantic = "") {
    if (value === null || value === undefined) return "";
    if (typeof value === "number" && Number.isFinite(value)) {
      if (isPercentMetric(semantic)) return `${fixedTwo(value * 100)}%`;
      return Number.isInteger(value) ? String(value) : fixedTwo(value);
    }
    return formatMetricValue(semantic, displayValue(value));
  }

  function canonicalHttpsUrl(value) {
    const text = String(value || "").trim();
    if (!text || text.length > 2048) return "";
    try {
      const parsed = new URL(text.startsWith("//") ? `https:${text}` : text);
      if (parsed.protocol !== "https:") return "";
      parsed.hash = "";
      for (const key of [...parsed.searchParams.keys()]) {
        if (/(?:token|csrf|cookie|authorization|password|secret|(?:^|[_-])sign(?:ature|data)?$|session|webOpSessionId|uniqueItemCampaign)/i.test(key)) {
          parsed.searchParams.delete(key);
        }
      }
      return parsed.toString();
    } catch {
      return "";
    }
  }

  function canonicalRenderData(report) {
    const products = {};
    const subjectPicture = canonicalHttpsUrl(report.item?.pictureUrl);
    const subjectDetail = canonicalHttpsUrl(report.item?.detailUrl);
    const competitorPicture = canonicalHttpsUrl(report.item?.competitorPictureUrl);
    const competitorDetail = canonicalHttpsUrl(report.item?.competitorDetailUrl);
    if (subjectPicture || subjectDetail) products.subject = {
      ...(subjectPicture ? { picture_url: subjectPicture } : {}),
      ...(subjectDetail ? { detail_url: subjectDetail } : {})
    };
    if (competitorPicture || competitorDetail) products.competitor = {
      ...(competitorPicture ? { picture_url: competitorPicture } : {}),
      ...(competitorDetail ? { detail_url: competitorDetail } : {})
    };

    const daily = (report.tables || []).find(current => current.name === "日GMV与费比");
    const subjectDailyGmv = Array.isArray(daily?.subjectDailyRows)
      ? daily.subjectDailyRows.map(row => ({
        date: String(row?.[0] || ""),
        gmv: canonicalCell(row?.[1], "日GMV")
      })).filter(row => /^20\d{2}-\d{2}-\d{2}$/.test(row.date) && row.gmv !== "" && Number.isFinite(Number(row.gmv)) && Number(row.gmv) >= 0)
      : [];

    const tables = (report.tables || []).map(current => {
      const widths = Array.isArray(current.widths)
        ? current.widths.map(Number).filter(value => Number.isFinite(value) && value >= 4 && value <= 120).map(value => Math.round(value * 100) / 100)
        : [];
      const subtitle = String(current.subtitle || "").slice(0, 300);
      return {
        name: String(current.name || ""),
        ...(subtitle ? { subtitle } : {}),
        ...(widths.length === current.columns?.length ? { widths } : {})
      };
    }).filter(current => current.name && (current.subtitle || current.widths));

    const generatedAt = String(report.finishedAt || "");
    const renderData = {
      version: "1",
      ...(Number.isFinite(Date.parse(generatedAt)) ? { generated_at: new Date(generatedAt).toISOString() } : {}),
      ...(Object.keys(products).length ? { products } : {}),
      ...(subjectDailyGmv.length ? { subject_daily_gmv: subjectDailyGmv } : {}),
      ...(tables.length ? { tables } : {})
    };
    return Object.keys(renderData).length > 1 ? renderData : null;
  }

  function toCanonicalReport(report) {
    const renderData = canonicalRenderData(report);
    return {
      schema_version: "3.0", title: String(report.title || ""), item_id: String(report.item?.id || ""), period: String(report.periodLabel || ""),
      ...(renderData ? { render_data: renderData } : {}),
      tables: (report.tables || []).map(current => ({
        name: String(current.name || ""),
        columns: (current.columns || []).map(String),
        rows: (current.rows || []).map(row => ({
          cells: row.map((value, cellIndex) => {
            const semantic = current.name === "对标总表"
              ? `${current.columns[cellIndex]} ${row[1]}`
              : current.name === "基础指标对比" || current.name === "报告总览"
                ? `${current.columns[cellIndex]} ${row[0]}`
                : current.columns[cellIndex];
            return canonicalCell(value, semantic);
          })
        }))
      }))
    };
  }

  function validateCanonicalReport(report) {
    if (!report || report.schema_version !== "3.0" || !report.item_id || !Array.isArray(report.tables)) return { ok: false, error: "报告结构不完整" };
    const names = report.tables.map(current => current.name);
    if (JSON.stringify(names) !== JSON.stringify(REQUIRED_TABLES)) return { ok: false, error: `业务表顺序或名称不符合参考模板：${names.join("、")}` };
    for (const current of report.tables) {
      if (!Array.isArray(current.columns) || !Array.isArray(current.rows)) return { ok: false, error: `${current.name} 结构不完整` };
      const forbidden = current.columns.filter(column => FORBIDDEN_COLUMN.test(column));
      if (forbidden.length) return { ok: false, error: `${current.name} 含禁止列：${forbidden.join("、")}` };
      if (current.rows.some(row => !Array.isArray(row.cells) || row.cells.length !== current.columns.length)) return { ok: false, error: `${current.name} 行列不一致` };
      if (current.rows.some(row => row.cells.some(cell => DIRECTION_ONLY.test(String(cell ?? "").trim())))) {
        return { ok: false, error: `${current.name} 的数值单元格仍含相对方向文字` };
      }
    }
    if (report.render_data != null) {
      const render = report.render_data;
      if (!render || render.version !== "1" || typeof render !== "object") return { ok: false, error: "报告展示数据结构无效" };
      if (render.subject_daily_gmv != null && (!Array.isArray(render.subject_daily_gmv) || render.subject_daily_gmv.some(row => !row || !/^20\d{2}-\d{2}-\d{2}$/.test(String(row.date || "")) || !Number.isFinite(Number(row.gmv)) || Number(row.gmv) < 0))) {
        return { ok: false, error: "主体逐日 GMV 展示数据无效" };
      }
    }
    return { ok: true };
  }

  function safeFilename(value) {
    return String(value || "report").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 120);
  }

  // ——— 把 API 深度解析的结果填进表格 ———
  // 规则：API 只允许补空格子，不允许改写插件本地已经算出来的值。
  // 本地值是确定性公式算出来的，可复现；API 的强项是从层级复杂、字段命名混乱的
  // 原始响应里把本地 pick() 没匹配上的数值找出来。冲突时以本地为准并记录下来，
  // 这样"API 填了什么"永远是可审计的，不会悄悄改变已核对过的数字。
  const FILLABLE_TABLES = new Set(REQUIRED_TABLES);

  function refreshOverviewKpis(report) {
    const overview = (report?.tables || []).find(current => current.name === "报告总览");
    if (!overview) return;
    const byMetric = new Map((overview.rows || []).map(row => [String(row?.[0] || ""), row]));
    overview.overviewMetrics = CORE_METRIC_CONTRACT.map(definition => {
      const row = byMetric.get(definition.label) || [definition.label, EMPTY, EMPTY, ""];
      return { key: definition.key, label: definition.label, subject: row[1] ?? EMPTY, competitor: row[2] ?? EMPTY, scope: row[3] ?? "" };
    });
    const gmv = byMetric.get("总GMV");
    const fee = byMetric.get("费比");
    const roi = byMetric.get("ROI");
    const ppc = byMetric.get("PPC");
    if (!gmv || !fee) return;
    const days = Number(report?.period?.days) || 30;
    const coverageMatch = String(fee[3] || "").match(/已返回(\d+\/\d+)日/);
    overview.kpis = [
      { role: "subject", label: `主体${days}日GMV`, value: gmv[1], source: "'周期汇总'!H5" },
      { role: "competitor", label: `对手${days}日GMV`, value: gmv[2], source: "'周期汇总'!H6" },
      { role: "subject", label: "主体费比", value: fee[1], source: "'周期汇总'!K5" },
      {
        role: "competitor",
        label: coverageMatch ? `对手费比（已返回${coverageMatch[1]}日）` : "对手费比",
        value: fee[2],
        source: coverageMatch ? "" : "'周期汇总'!K6"
      },
      ...(roi ? [
        { role: "subject", label: "主体ROI", value: roi[1], source: "" },
        { role: "competitor", label: "对手ROI", value: roi[2], source: "" }
      ] : []),
      ...(ppc ? [
        { role: "subject", label: "主体PPC", value: ppc[1], source: "" },
        { role: "competitor", label: "对手PPC", value: ppc[2], source: "" }
      ] : [])
    ];
  }

  function applyAnalysis(report, analysis) {
    const applied = [];
    const rejected = [];
    if (!analysis || !Array.isArray(analysis.cells)) return { report, applied, rejected };

    const tablesByName = new Map((report.tables || []).map(current => [current.name, current]));
    for (const cell of analysis.cells) {
      const tableName = String(cell?.table || "");
      const target = tablesByName.get(tableName);
      const reject = reason => rejected.push({ table: tableName, row: cell?.row, column: cell?.column, reason });

      if (!target || !FILLABLE_TABLES.has(tableName)) { reject("表名不在固定的 11 个业务表里"); continue; }
      const columnIndex = target.columns.indexOf(String(cell?.column || ""));
      if (columnIndex < 0) { reject("列名不属于该表"); continue; }
      if (FORBIDDEN_COLUMN.test(target.columns[columnIndex])) { reject("目标列是禁止列"); continue; }
      const rowIndex = Number(cell?.row);
      if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= target.rows.length) { reject("行号超出该表范围"); continue; }

      const current = target.rows[rowIndex][columnIndex];
      if (current !== EMPTY && current !== null && current !== undefined) { reject("该格已有本地计算值，不允许 API 改写"); continue; }

      // 只接受数字或短文本。对象、数组、超长文本一律拒绝——那不是单元格该有的东西。
      const raw = cell?.value;
      if (raw === null || raw === undefined || raw === "") { reject("返回值为空"); continue; }
      if (typeof raw === "object") { reject("返回值不是标量"); continue; }
      const text = String(raw);
      if (text.length > 200) { reject("返回值超过 200 字符"); continue; }
      if (DIRECTION_ONLY.test(text.trim())) { reject("相对方向文字不能写入生产报告数值单元格"); continue; }
      // 必须说明这个值出自哪个模块的哪个字段。没有出处的值不填——
      // 这是防"模型自己编一个看起来合理的数"的唯一有效手段。
      const sourceField = String(cell?.source_field || "").trim();
      const sourceModule = String(cell?.source_module || "").trim();
      if (!sourceField || !sourceModule) { reject("缺少 source_module / source_field 出处说明"); continue; }
      if (!EXPECTED_ENDPOINTS.some(endpoint => endpoint.module === sourceModule)) { reject(`source_module「${sourceModule}」不是已采集的模块`); continue; }

      const numeric = toNumber(text);
      target.rows[rowIndex][columnIndex] = Number.isFinite(numeric) && !/^0\d/.test(text) ? numeric : text;
      applied.push({ table: tableName, row: rowIndex, column: target.columns[columnIndex], value: target.rows[rowIndex][columnIndex], source_module: sourceModule, source_field: sourceField });
    }
    if (applied.length) refreshOverviewKpis(report);
    return { report, applied, rejected };
  }

  return {
    EXPECTED_ENDPOINTS, REQUIRED_TABLES, FORBIDDEN_COLUMN, CHANNELS,
    SUBJECT_MINIMUM_PROMOTION_CONTRACT, SUBJECT_MINIMUM_PROMOTION_METRICS, CORE_METRIC_CONTRACT,
    parseBody, buildReport, buildAnalysisPayload, applyAnalysis, buildCsv, formatMetricValue, toCanonicalReport, validateCanonicalReport, safeFilename
  };
});
