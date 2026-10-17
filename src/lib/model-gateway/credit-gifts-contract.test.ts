import { describe, expect, it } from "vitest";
import { parseGatewayCreditGiftInput } from "./credit-gifts-contract";

const base = { userId: "cuid-user-1", points: "10.3", reason: "活动赠送", requestKey: "de73fb25-91da-40dc-bf61-d9b5c8bb5ec5" };

describe("credit gift strict input", () => {
  it.each([["0.1", 1], ["1", 10], ["10.0", 100], ["10.3", 103], ["214748364.7", 2147483647]])("parses %s exactly to %i cents", (points, amountCents) => {
    expect(parseGatewayCreditGiftInput({ ...base, points })).toMatchObject({ amountCents });
  });

  it("normalizes whitespace, decimal zero and UUID casing", () => {
    expect(parseGatewayCreditGiftInput({ ...base, userId: " cuid-user-1 ", points: " 10.0 ", reason: " 活动赠送 ", requestKey: base.requestKey.toUpperCase() })).toEqual({ ...base, points: "10", amountCents: 100 });
  });

  it.each([0, 1, "0", "0.0", "-1", "+1", ".1", "1.", "01", "1.01", "1e2", "1E2", "Infinity", "NaN", "1,000", "１２", "214748364.8", "9999999999999999999999999999"])("rejects invalid points %s", (points) => {
    expect(() => parseGatewayCreditGiftInput({ ...base, points })).toThrowError(expect.objectContaining({ code: "INVALID_GIFT_POINTS" }));
  });

  it.each([null, [], "text", {}])("rejects malformed body %s", (value) => {
    expect(() => parseGatewayCreditGiftInput(value)).toThrow();
  });

  it.each(["adminId", "tenantId", "poolId", "poolBalanceCents", "amountCents", "amount", "balancePoints"])("rejects external authority field %s", (key) => {
    expect(() => parseGatewayCreditGiftInput({ ...base, [key]: 1 })).toThrowError(expect.objectContaining({ code: "INVALID_GIFT_INPUT" }));
  });

  it.each(["", "单", "a\nb", "a\u0000b", "a".repeat(501)])("requires a bounded clean reason", (reason) => {
    expect(() => parseGatewayCreditGiftInput({ ...base, reason })).toThrowError(expect.objectContaining({ code: "INVALID_GIFT_REASON" }));
  });

  it.each(["", "receipt-1", "00000000-0000-0000-0000-000000000000", "de73fb25-91da-40dc-bf61-d9b5c8bb5ec5-extra"])("requires UUID request key %s", (requestKey) => {
    expect(() => parseGatewayCreditGiftInput({ ...base, requestKey })).toThrowError(expect.objectContaining({ code: "INVALID_GIFT_REQUEST_KEY" }));
  });
});
