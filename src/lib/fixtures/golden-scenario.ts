import type {
  AnalysisCycle,
  AudienceSourceRow,
  DamoProductRow,
  ImportBatch,
  PrefillItem,
  ProductSourceRow,
  PromotionProductRow,
  Shop,
  Tenant,
  User,
  VersionSnapshot
} from "@/lib/types/domain";
import { validateImportRows } from "@/lib/imports/contracts";

export const goldenTenant: Tenant = {
  id: "tenant-hoka",
  name: "霍卡工具管理组织",
  slug: "hoka-tools"
};

export const goldenUser: User = {
  id: "user-admin",
  tenantId: goldenTenant.id,
  name: "运营负责人",
  email: "ops@example.com",
  role: "owner"
};

export const goldenShop: Shop = {
  id: "shop-taobao-main",
  tenantId: goldenTenant.id,
  name: "霍卡旗舰经营店",
  platform: "淘宝"
};

export const goldenCycle: AnalysisCycle = {
  id: "cycle-2026-05",
  tenantId: goldenTenant.id,
  shopId: goldenShop.id,
  name: "2026-04-09 至 2026-05-08",
  startDate: "2026-04-09",
  endDate: "2026-05-08",
  status: "calculated"
};

const namedProducts = [
  {
    id: "982373108594",
    name: "霍卡外径抗震MGEHR切槽刀杆切刀槽刀片切断刀数控车床刀杆",
    lifecycle: "爆品期" as const,
    grade: "S" as const,
    monthlyGsvOpportunity: 64800,
    paymentAmount: 54306.24,
    refundAmount: 7195.22,
    paymentBuyers: 473,
    conversion: 0.1042,
    marketingSpend: 8736.33,
    paidVisitorRatio: 0,
    averageClickCost: 3.93,
    searchConversion: 0.1208,
    freeSearchClickRate: 0.0594,
    stay: 28.45,
    bounce: 0.7495,
    attachRate: 0.1489,
    attachWidth: 18,
    repurchase: 0.3221
  },
  {
    id: "969883674609",
    name: "霍卡SCLCR/L内孔刀杆小孔抗震高速钢车刀数控车床镗孔刀杆",
    lifecycle: "成长期" as const,
    grade: "B" as const,
    monthlyGsvOpportunity: 299900.9,
    paymentAmount: 36497.12,
    refundAmount: 0,
    paymentBuyers: 300,
    conversion: 0.06,
    marketingSpend: 11598.848,
    paidVisitorRatio: 0.2,
    averageClickCost: 2,
    searchConversion: 0.083,
    freeSearchClickRate: 0.052,
    stay: 22.3,
    bounce: 0.48,
    attachRate: 0.119,
    attachWidth: 12,
    repurchase: 0.21
  },
  {
    id: "982703946658",
    name: "数控端面刀杆MGAH320R17-50/80反圆弧槽刀杆",
    lifecycle: "冷启期" as const,
    grade: "C" as const,
    monthlyGsvOpportunity: 64525,
    paymentAmount: 6217.76,
    refundAmount: 0,
    paymentBuyers: 72,
    conversion: 0.045,
    marketingSpend: 604.382,
    paidVisitorRatio: 0.15,
    averageClickCost: 1.6,
    searchConversion: 0.052,
    freeSearchClickRate: 0.041,
    stay: 16.8,
    bounce: 0.62,
    attachRate: 0.08,
    attachWidth: 7,
    repurchase: 0.12
  }
];

export const productSourceRows: ProductSourceRow[] = [
  ...namedProducts.map((product) => ({
    date: "2026-05-08",
    productId: product.id,
    productName: product.name,
    visitors: Math.max(1, Math.round(product.paymentBuyers / product.conversion)),
    views: Math.max(1, Math.round((product.paymentBuyers / product.conversion) * 1.8)),
    averageStaySeconds: product.stay,
    bounceRate: product.bounce,
    orderBuyers: product.paymentBuyers,
    paymentBuyers: product.paymentBuyers,
    paymentAmount: product.paymentAmount,
    productPaymentConversionRate: product.conversion,
    refundAmount: product.refundAmount,
    visitorValue: product.paymentAmount / Math.max(1, product.paymentBuyers / product.conversion),
    searchGuidedPaymentConversionRate: product.searchConversion,
    searchGuidedVisitors: 1000 + product.paymentBuyers
  })),
  ...Array.from({ length: 57 }, (_, index) => {
    const suffix = String(index + 4).padStart(2, "0");
    return {
      date: "2026-05-08",
      productId: `demo-product-${suffix}`,
      productName: `样例待评估商品 ${suffix}`,
      visitors: 0,
      views: 0,
      averageStaySeconds: 8 + (index % 12),
      bounceRate: 0.7,
      orderBuyers: 0,
      paymentBuyers: 0,
      paymentAmount: 0,
      productPaymentConversionRate: 0,
      refundAmount: 0,
      visitorValue: 0,
      searchGuidedPaymentConversionRate: 0.02 + (index % 5) * 0.002,
      searchGuidedVisitors: 0
    } satisfies ProductSourceRow;
  })
];

export const damoProductRows: DamoProductRow[] = [
  ...namedProducts.map((product) => ({
    productId: product.id,
    productName: product.name,
    growthStage: product.lifecycle,
    paymentAmount: product.paymentAmount,
    ipv: 10000,
    marketingIpv: 3000,
    marketingSpend: product.marketingSpend,
    marketingRoi: 4,
    paymentConversionRate: product.conversion,
    repurchaseRate: product.repurchase,
    freeSearchClickRate: product.freeSearchClickRate,
    unitPrice: product.paymentAmount / product.paymentBuyers,
    attachPurchaseCount: 100,
    attachPurchaseRate: product.attachRate,
    attachCategoryWidth: product.attachWidth
  })),
  ...Array.from({ length: 594 }, (_, index) => {
    const product = productSourceRows[(index + 3) % productSourceRows.length];
    return {
      productId: index < 57 ? product.productId : `damo-extra-${index}`,
      productName: index < 57 ? product.productName : `达摩盘额外货品 ${index}`,
      growthStage: index % 2 === 0 ? "平销期" : "冷启期",
      paymentAmount: 0,
      ipv: 0,
      marketingIpv: 0,
      marketingSpend: 0,
      marketingRoi: 0,
      paymentConversionRate: 0,
      repurchaseRate: 0,
      freeSearchClickRate: 0,
      unitPrice: 0,
      attachPurchaseCount: 0,
      attachPurchaseRate: 0,
      attachCategoryWidth: 0
    } satisfies DamoProductRow;
  })
];

export const promotionProductRows: PromotionProductRow[] = [
  ...namedProducts.map((product) => ({
    date: "2026-05-08",
    subjectId: product.id,
    subjectName: product.name,
    impressions: 1000,
    clicks: 100,
    cost: product.averageClickCost * 100,
    ctr: 0.1,
    averageClickCost: product.averageClickCost,
    roi: 3
  })),
  ...Array.from({ length: 346 }, (_, index) => ({
    date: "2026-05-08",
    subjectId: `promo-extra-${index}`,
    subjectName: `推广额外主体 ${index}`,
    impressions: 0,
    clicks: 0,
    cost: 0,
    ctr: 0,
    averageClickCost: 0,
    roi: 0
  }))
];

export const audienceSourceRows: AudienceSourceRow[] = [
  {
    dateRange: "20260409至20260508",
    sceneId: "372",
    sceneName: "人群推广",
    planId: "80619949314",
    planName: "U钻拉新_20260508_113806",
    audienceName: "智能竞争店铺",
    subjectId: "744023508357",
    subjectName: "霍卡u钻暴力钻喷水钻刀杆WC刀片",
    clicks: 51,
    roi: 0,
    guidedVisitorCount: 79,
    guidedPotentialCustomerRatio: 0.89583,
    newCustomerCount: 0,
    newCustomerRatio: 0.92
  },
  {
    dateRange: "20260409至20260508",
    sceneId: "411",
    sceneName: "货品全站推广",
    planId: "78743473981",
    planName: "全店模式_20260114180425",
    audienceName: "智能推荐人群",
    subjectId: "982373108594",
    subjectName: namedProducts[0].name,
    clicks: 170,
    roi: 18.32,
    guidedVisitorCount: 95,
    guidedPotentialCustomerRatio: 0.37121,
    newCustomerCount: 80,
    newCustomerRatio: 0.75
  },
  {
    dateRange: "20260409至20260508",
    sceneId: "411",
    sceneName: "货品全站推广",
    planId: "80475482036",
    planName: "货品全站推广分组计划1",
    audienceName: "智能推荐人群",
    subjectId: "969883674609",
    subjectName: namedProducts[1].name,
    clicks: 44,
    roi: 2.22,
    guidedVisitorCount: 12,
    guidedPotentialCustomerRatio: 0.15789,
    newCustomerCount: 0,
    newCustomerRatio: 0
  },
  ...Array.from({ length: 357 }, (_, index) => ({
    dateRange: "20260409至20260508",
    sceneId: `extra-${index}`,
    sceneName: "人群推广",
    planId: `plan-extra-${index}`,
    planName: `未入选计划 ${index}`,
    audienceName: "观察人群",
    subjectId: `audience-extra-${index}`,
    subjectName: `人群额外主体 ${index}`,
    clicks: 0,
    roi: 0,
    guidedVisitorCount: 0,
    guidedPotentialCustomerRatio: 0.55,
    newCustomerCount: 0,
    newCustomerRatio: 0.45
  }))
];

export const prefillItems: PrefillItem[] = productSourceRows.map((product, index) => {
  const named = namedProducts.find((candidate) => candidate.id === product.productId);
  return {
    id: `prefill-${index + 1}`,
    cycleId: goldenCycle.id,
    productId: product.productId,
    productCode: `${product.productId}${product.productName}`,
    productName: product.productName,
    grade: named?.grade ?? "C",
    monthlyGsvOpportunity: named?.monthlyGsvOpportunity ?? 0,
    grossMarginRate: 0.4,
    paidVisitorRatio: named?.paidVisitorRatio ?? 0,
    imageUrl: "",
    competitorConversionExpectation: undefined,
    benchmarkProductId: "",
    audienceStrategy: index === 0 ? "优先承接拉新人群，费用向高缺口单品集中。" : ""
  };
});

const now = "2026-06-06T04:55:00.000Z";

export const importBatches: ImportBatch[] = [
  {
    id: "import-product-source",
    cycleId: goldenCycle.id,
    datasetId: "dataset-golden-20260508",
    reportType: "product_source",
    fileName: "导入商品源数据.xlsx",
    fileSizeBytes: Math.round(4.8 * 1024 * 1024),
    status: "validated",
    rowCount: 60,
    createdAt: now,
    validation: validateImportRows("product_source", productSourceHeaders(), rowsFromProducts())
  },
  {
    id: "import-damo-source",
    cycleId: goldenCycle.id,
    datasetId: "dataset-golden-20260508",
    reportType: "damo_product_source",
    fileName: "导入达摩盘源数据.xlsx",
    fileSizeBytes: Math.round(8.2 * 1024 * 1024),
    status: "validated",
    rowCount: 597,
    createdAt: now,
    validation: validateImportRows("damo_product_source", damoHeaders(), rowsFromDamo())
  },
  {
    id: "import-promotion-source",
    cycleId: goldenCycle.id,
    datasetId: "dataset-golden-20260508",
    reportType: "promotion_product_source",
    fileName: "导入推广宝贝报表源数据.xlsx",
    fileSizeBytes: Math.round(6.5 * 1024 * 1024),
    status: "validated",
    rowCount: 349,
    createdAt: now,
    validation: validateImportRows("promotion_product_source", promotionHeaders(), rowsFromPromotion())
  },
  {
    id: "import-audience-source",
    cycleId: goldenCycle.id,
    datasetId: "dataset-golden-20260508",
    reportType: "audience_source",
    fileName: "导入人群报表源数据.xlsx",
    fileSizeBytes: Math.round(7.1 * 1024 * 1024),
    status: "validated",
    rowCount: 360,
    createdAt: now,
    validation: validateImportRows("audience_source", audienceHeaders(), rowsFromAudience())
  }
];

export const versionSnapshots: VersionSnapshot[] = [
  {
    id: "version-imports-001",
    cycleId: goldenCycle.id,
    shopId: goldenShop.id,
    kind: "import",
    title: "四份源报表完成校验",
    createdAt: "2026-06-06T05:00:00.000Z",
    createdBy: goldenUser.name,
    summary: "商品源、达摩盘、无界推广宝贝、无界人群均通过表头和 ID 校验。"
  },
  {
    id: "version-prefill-001",
    cycleId: goldenCycle.id,
    shopId: goldenShop.id,
    kind: "prefill",
    title: "预填写参数确认",
    createdAt: "2026-06-06T05:04:00.000Z",
    createdBy: goldenUser.name,
    summary: "60 个商品带出，已填写 SAB 分层、GSV 机会、毛利率和付费访客比。"
  },
  {
    id: "version-calc-001",
    cycleId: goldenCycle.id,
    shopId: goldenShop.id,
    kind: "calculation",
    title: "三阶评估算法运行",
    createdAt: "2026-06-06T05:08:00.000Z",
    createdBy: goldenUser.name,
    summary: "生成管理综合、单品突破、拉新/追投/收割三类看板。"
  }
];

export function getGoldenScenario() {
  return {
    tenant: goldenTenant,
    user: goldenUser,
    shop: goldenShop,
    cycle: goldenCycle,
    productSourceRows,
    damoProductRows,
    promotionProductRows,
    audienceSourceRows,
    prefillItems,
    importBatches,
    versionSnapshots
  };
}

function productSourceHeaders() {
  return [
  "统计日期",
  "商品ID",
  "商品名称",
  "商品访客数",
  "商品浏览量",
  "平均停留时长",
  "商品详情页跳出率",
  "支付买家数",
  "支付金额",
  "商品支付转化率",
  "成功退款金额",
  "搜索引导支付转化率"
  ];
}

function damoHeaders() {
  return [
  "宝贝ID",
  "宝贝名称",
  "货品成长阶段",
  "支付金额",
  "IPV",
  "营销推广消耗",
  "营销推广ROI",
  "支付转化率",
  "复购率",
  "免费搜索点击率",
  "连带购买率",
  "连带购买叶子类目宽度"
  ];
}

function promotionHeaders() {
  return [
  "日期",
  "主体ID",
  "主体类型",
  "主体名称",
  "展现量",
  "点击量",
  "花费",
  "平均点击花费",
  "投入产出比"
  ];
}

function audienceHeaders() {
  return [
  "日期",
  "场景ID",
  "场景名字",
  "计划ID",
  "计划名字",
  "人群名字",
  "主体ID",
  "主体名称",
  "点击量",
  "投入产出比",
  "引导访问潜客占比",
  "成交新客占比"
  ];
}

function rowsFromProducts() {
  return productSourceRows.map((row) => [
    row.date,
    row.productId,
    row.productName,
    row.visitors,
    row.views,
    row.averageStaySeconds,
    row.bounceRate,
    row.paymentBuyers,
    row.paymentAmount,
    row.productPaymentConversionRate,
    row.refundAmount,
    row.searchGuidedPaymentConversionRate
  ]);
}

function rowsFromDamo() {
  return damoProductRows.map((row) => [
    row.productId,
    row.productName,
    row.growthStage,
    row.paymentAmount,
    row.ipv,
    row.marketingSpend,
    row.marketingRoi,
    row.paymentConversionRate,
    row.repurchaseRate,
    row.freeSearchClickRate,
    row.attachPurchaseRate,
    row.attachCategoryWidth
  ]);
}

function rowsFromPromotion() {
  return promotionProductRows.map((row) => [
    row.date,
    row.subjectId,
    "商品",
    row.subjectName,
    row.impressions,
    row.clicks,
    row.cost,
    row.averageClickCost,
    row.roi
  ]);
}

function rowsFromAudience() {
  return audienceSourceRows.map((row) => [
    row.dateRange,
    row.sceneId,
    row.sceneName,
    row.planId,
    row.planName,
    row.audienceName,
    row.subjectId,
    row.subjectName,
    row.clicks,
    row.roi,
    row.guidedPotentialCustomerRatio,
    row.newCustomerRatio
  ]);
}
