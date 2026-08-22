import type { ReportType } from "@/lib/types/domain";

export function matrixFromRawBody(rawBody: unknown, reportType: ReportType, fallbackDate?: string) {
  const arrays: Array<Array<Record<string, unknown>>> = [];
  const seen = new WeakSet<object>();

  function scan(value: unknown, depth = 0) {
    if (depth > 10 || !value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      const objects = value.filter(
        (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)
      );
      if (objects.length) arrays.push(objects);
      for (const item of value.slice(0, 500)) scan(item, depth + 1);
      return;
    }
    for (const current of Object.values(value as Record<string, unknown>)) scan(current, depth + 1);
  }

  scan(rawBody);
  for (const rows of arrays.sort((left, right) => right.length - left.length)) {
    const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const canonical = canonicalSourceHeaders(keys, reportType);
    if (!canonical.some((header) => /商品ID|主体ID/.test(header))) continue;
    return {
      headers: canonical,
      rows: rows.map((row) => keys.map((key, index) => {
        const header = canonical[index];
        const value = row[key];
        if ((header === "统计日期" || header === "日期") && (value === undefined || value === null || value === "")) {
          return fallbackDate || "";
        }
        return scalarSourceValue(value);
      }))
    };
  }
  return null;
}

export function canonicalSourceHeaders(keys: string[], reportType: ReportType) {
  return keys.map((key) => {
    const compact = key.replace(/[\s_\-]/g, "").toLowerCase();
    if (/^(date|statdate|bizdate|thedate|统计日期|日期)$/.test(compact)) return reportType === "product_source" ? "统计日期" : "日期";
    if (/^(itemid|productid|goodsid|auctionid|商品id|宝贝id)$/.test(compact)) return reportType === "product_source" ? "商品ID" : "主体ID";
    if (/^(itemtitle|itemname|productname|goodstitle|goodsname|商品名称|宝贝名称)$/.test(compact)) return reportType === "product_source" ? "商品名称" : "主体名称";
    if (/^(subjectid|主体id)$/.test(compact)) return "主体ID";
    if (/^(subjectname|主体名称)$/.test(compact)) return "主体名称";
    if (/^(uv|visitor|visitors|itemuv|itmuv|访客数|商品访客数)$/.test(compact)) return "商品访客数";
    if (/^(pv|views|itempv|itmpv|浏览量|商品浏览量)$/.test(compact)) return "商品浏览量";
    if (/^(itmstaytime|avgstaytime|averagestaytime|平均停留时长)$/.test(compact)) return "平均停留时长";
    if (/^(itmbouncerate|bouncerate|商品详情页跳出率|跳出率)$/.test(compact)) return "商品详情页跳出率";
    if (/^(paybuyer|paybuyers|paybuyercnt|paybyrcnt|支付买家数)$/.test(compact)) return "支付买家数";
    if (/^(payamount|paymentamount|payamt|gmv|支付金额)$/.test(compact)) return "支付金额";
    if (/^(payrate|paymentconversionrate|商品支付转化率|支付转化率)$/.test(compact)) return "商品支付转化率";
    if (/^(sucrefundamt|refundamount|成功退款金额)$/.test(compact)) return "成功退款金额";
    if (/^(seguideuv|searchguideduv|搜索引导访客数)$/.test(compact)) return "搜索引导访客数";
    if (/^(seguidepayrate|searchguidedpaymentconversionrate|搜索引导支付转化率)$/.test(compact)) return "搜索引导支付转化率";
    if (/^(impression|impressions|曝光量|展现量)$/.test(compact)) return "展现量";
    if (/^(click|clicks|点击量)$/.test(compact)) return "点击量";
    if (/^(cost|spend|charge|fcharge|花费)$/.test(compact)) return "花费";
    if (/^(roi|roas|pdroi|投入产出比)$/.test(compact)) return "投入产出比";
    return key;
  });
}

export function scalarSourceValue(value: unknown): unknown {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "value")) {
    return scalarSourceValue((value as Record<string, unknown>).value);
  }
  return typeof value === "object" ? JSON.stringify(value) : value;
}
