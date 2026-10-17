import { describe, expect, it, vi } from "vitest";
import {
  applyGatewayBillingCost, centsToPoints, GatewayBillingError,
  GATEWAY_DEFAULT_MULTIPLIER_BPS
} from "./billing-contract";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: {} }));
import { safeGatewayBillingMetadata, safeGatewayBillingError } from "./billing";

describe("billing contract integer precision", () => {
  it("keeps wallet cents and fractional points without rounding balances", () => {
    expect(centsToPoints(1003)).toBe(100.3);
    expect(centsToPoints(1)).toBe(0.1);
    expect(centsToPoints(-5)).toBe(-0.5);
  });
  it.each([0, 1, 50, 80, 600, 2_147_483_647])("default multiplier preserves %i cents", (base) => {
    expect(applyGatewayBillingCost(base, { multiplierBps: GATEWAY_DEFAULT_MULTIPLIER_BPS })).toBe(base);
  });
  it.each([[50, 5000, 25], [1, 100, 1], [50, 10001, 51], [60, 12345, 75], [21_474_836, 1_000_000, 2_147_483_600]])("charges %i cents at %i bps as %i integer cents", (base, multiplierBps, expected) => {
    expect(applyGatewayBillingCost(base, { multiplierBps })).toBe(expected);
  });
  it.each([99, 1_000_001, 0, -1, 10000.1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid bps %s", (multiplierBps) => {
    expect(() => applyGatewayBillingCost(50, { multiplierBps })).toThrow(GatewayBillingError);
  });
  it.each([-1, 0.5, 2_147_483_648, Number.NaN])("rejects invalid base cost %s", (base) => {
    expect(() => applyGatewayBillingCost(base, { multiplierBps: 10000 })).toThrow(GatewayBillingError);
  });
  it("rejects final database integer overflow", () => {
    expect(() => applyGatewayBillingCost(2_147_483_647, { multiplierBps: 1_000_000 })).toThrowError(expect.objectContaining({ code: "COST_OVERFLOW" }));
  });
});

describe("billing audit redaction", () => {
  it("keeps only billing parameters and never request/response/key contents", () => {
    expect(safeGatewayBillingMetadata({
      upstreamModel: "image2", size: "1024x1024", quality: "high", requestedImageCount: 3,
      inputImageCount: 2, tokenSource: "reported", responseFormat: "b64_json",
      baseUrl: "https://relay.example/v1?api_key=private", apiKey: "private", prompt: "private prompt",
      body: { image: "private-image-data" }, response: "private-response", arbitrary: "private"
    })).toEqual({ upstreamModel: "image2", size: "1024x1024", quality: "high", requestedImageCount: 3,
      inputImageCount: 2, tokenSource: "reported", responseFormat: "b64_json", baseUrl: "https://relay.example/v1" });
  });
  it("rejects credential-bearing values and invalid metric types", () => {
    expect(safeGatewayBillingMetadata({ baseUrl: "https://user:password@relay.example/v1", size: "sk-sensitive-value",
      quality: "Bearer private", requestedImageCount: -1, inputImageCount: 0.5, tokenSource: "private", seconds: Number.NaN })).toEqual({});
    expect(safeGatewayBillingError("provider_timeout")).toBe("provider_timeout");
    expect(safeGatewayBillingError("request leaked sk-sensitive-provider-key")).toBe("upstream_error");
    expect(safeGatewayBillingError("private provider body")).toBe("upstream_error");
  });
  it("preserves partial usage field provenance without allowing arbitrary audit text", () => {
    expect(safeGatewayBillingMetadata({ tokenSource: "partial", reportedTokenFields: "prompt,total" }))
      .toEqual({ tokenSource: "partial", reportedTokenFields: "prompt,total" });
    expect(safeGatewayBillingMetadata({ tokenSource: "unreported", reportedTokenFields: "private text" }))
      .toEqual({ tokenSource: "unreported" });
  });
});
