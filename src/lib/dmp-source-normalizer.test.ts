import { describe, expect, it } from "vitest";
import { matrixFromRawBody } from "@/lib/dmp-source-normalizer";

describe("dmp source normalizer", () => {
  it("maps the full SYCM day response and unwraps metric values", () => {
    const matrix = matrixFromRawBody({
      data: {
        list: [{
          statDate: "2026-08-18",
          itemId: "768239824008",
          itemTitle: "小巢蜜",
          itmUv: { value: 3820, cycle: 0.2 },
          itmPv: { value: 6150 },
          itmStayTime: { value: 23.5 },
          itmBounceRate: { value: 0.31 },
          payByrCnt: { value: 25 },
          payAmt: { value: 1691.61 },
          payRate: { value: 0.0654 },
          sucRefundAmt: { value: 278.4 },
          seGuidePayRate: { value: 0.052 },
          seGuideUv: { value: 620 }
        }]
      }
    }, "product_source");

    expect(matrix?.headers).toEqual([
      "统计日期", "商品ID", "商品名称", "商品访客数", "商品浏览量", "平均停留时长",
      "商品详情页跳出率", "支付买家数", "支付金额", "商品支付转化率", "成功退款金额",
      "搜索引导支付转化率", "搜索引导访客数"
    ]);
    expect(matrix?.rows[0]).toEqual([
      "2026-08-18", "768239824008", "小巢蜜", 3820, 6150, 23.5, 0.31, 25, 1691.61, 0.0654, 278.4, 0.052, 620
    ]);
  });

  it("fills a missing response date from the requested day", () => {
    const matrix = matrixFromRawBody({ data: { list: [{ itemId: "768239824008", payAmt: { value: 99 } }] } }, "product_source", "2026-07-24");
    expect(matrix?.headers).toEqual(["商品ID", "支付金额"]);
    expect(matrix?.rows[0]).toEqual(["768239824008", 99]);
  });
});
