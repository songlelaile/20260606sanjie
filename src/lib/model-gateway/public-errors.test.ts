import { describe, expect, it } from "vitest";
import { GatewayBillingError } from "./billing-contract";
import { publicCreditServiceFailure } from "./public-errors";

describe("public credit service errors", () => {
  it.each(["CREDIT_POOL_NOT_READY", "CREDIT_POOL_INVALID", "POOL_SOURCE_UNVERIFIED", "POOL_JOURNAL_MISMATCH",
    "SOURCE_TIMEOUT", "SOURCE_AUTH_REQUIRED", "SHARED_SOURCE_CONFIG_CHANGED", "FX_RATE_STALE", "INVALID_FX_SNAPSHOT",
    "HOLD_PRICE_UNPROVEN", "BACKING_SHORTFALL", "WALLET_LEDGER_MISMATCH"])("hides internal %s and arbitrary private messages", code => {
    const publicError = publicCreditServiceFailure(new GatewayBillingError(code, "PRIVATE KEY https://supplier.invalid USD 100 FX 7.1", 409));
    expect(publicError).toEqual({ message: "生成服务暂时繁忙，请稍后重试。", status: 503, code: "CREDIT_SERVICE_UNAVAILABLE" });
    expect(publicError).not.toHaveProperty("providerSubmitted");
    expect(publicError).not.toHaveProperty("definitiveFailure");
  });
  it.each(["INSUFFICIENT_BALANCE", "ACCOUNT_UNAVAILABLE", "INVALID_IMAGE_COUNT", "BILLING_EVENT_CONFLICT"])("preserves independent user/action error %s", code => {
    expect(publicCreditServiceFailure(new GatewayBillingError(code, "user action", 402))).toBeNull();
  });
  it("never classifies an arbitrary object by its claimed code", () => {
    expect(publicCreditServiceFailure({ code: "POOL_SOURCE_UNVERIFIED", message: "private" })).toBeNull();
    expect(publicCreditServiceFailure(new Error("private"))).toBeNull();
  });
});
