import { describe, expect, it } from "vitest";
import { GatewayPaymentError, gatewayPaymentErrorResponse, getGatewayManualPaymentConfig, parseManualPaymentConfirmation } from "./payment";

describe("manual payment validation", () => {
  it("requires a receipt and exact positive integer cents", () => {
    expect(parseManualPaymentConfirmation({ receipt: " flow-1234 ", receivedAmountCents: 9900, note: " checked " }, "admin-1"))
      .toEqual({ receipt: "flow-1234", receivedAmountCents: 9900, note: "checked", confirmedBy: "admin-1" });
    for (const amount of [0, -1, 99.5, "9900", Number.MAX_SAFE_INTEGER + 1, null, undefined]) {
      expect(() => parseManualPaymentConfirmation({ receipt: "flow-1234", receivedAmountCents: amount }, "admin-1"))
        .toThrow("实收金额必须是正整数人民币分");
    }
  });

  it("rejects malformed receipt, body and note", () => {
    for (const receipt of ["", "abc", "a".repeat(161), "flow\n1234", null]) {
      expect(() => parseManualPaymentConfirmation({ receipt, receivedAmountCents: 9900 }, "admin-1")).toThrow(GatewayPaymentError);
    }
    for (const body of [null, [], "receipt", { receipt: "flow-1234", receivedAmountCents: 9900, note: 123 },
      { receipt: "flow-1234", receivedAmountCents: 9900, note: "a".repeat(501) }]) {
      expect(() => parseManualPaymentConfirmation(body, "admin-1")).toThrow(GatewayPaymentError);
    }
  });

  it("never creates an automatic checkout from unimplemented provider or AUTO_PAY", () => {
    expect(getGatewayManualPaymentConfig({ MODEL_GATEWAY_AUTO_PAY: "1" }))
      .toEqual({ paymentProvider: "manual", paymentUrl: "" });
    expect(() => getGatewayManualPaymentConfig({ MODEL_GATEWAY_PAYMENT_PROVIDER: "stripe" })).toThrow("尚未接通");
  });

  it("accepts only configured HTTPS payment URLs without embedded credentials", () => {
    expect(getGatewayManualPaymentConfig({ MODEL_GATEWAY_MANUAL_PAY_URL: "https://pay.example.com/instructions" }).paymentUrl)
      .toBe("https://pay.example.com/instructions");
    for (const paymentUrl of ["javascript:alert(1)", "http://pay.example.com", "https://user:pass@pay.example.com", "invalid"]) {
      expect(() => getGatewayManualPaymentConfig({ MODEL_GATEWAY_MANUAL_PAY_URL: paymentUrl })).toThrow("配置无效");
    }
  });

  it("keeps infrastructure exceptions and secrets out of responses", () => {
    expect(gatewayPaymentErrorResponse(new Error("database password=private"), "服务暂时不可用"))
      .toEqual({ status: 503, body: { error: "服务暂时不可用", code: "PAYMENT_SERVICE_UNAVAILABLE" } });
    expect(gatewayPaymentErrorResponse(new GatewayPaymentError("ORDER_NOT_FOUND", "订单不存在", 404), "失败"))
      .toEqual({ status: 404, body: { error: "订单不存在", code: "ORDER_NOT_FOUND" } });
  });
});
