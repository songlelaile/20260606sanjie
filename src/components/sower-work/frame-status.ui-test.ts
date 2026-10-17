import { describe, expect, it } from "vitest";
import { isSowerFrameReady } from "./frame-status";

describe("real renderer readiness", () => {
  const frame = {} as Window;
  const other = {} as Window;
  const expected = { origin: "https://shaozhuangai.com", source: frame, token: "fixture-frame-token" };
  const event = { origin: expected.origin, source: frame, data: { type: "SOWER_WORK_RENDERER_READY", v: 1, token: expected.token } };

  it("accepts the actual mounted frame only after its renderer acknowledges", () => {
    expect(isSowerFrameReady(event, expected)).toBe(true);
  });

  it("rejects stale loads, other windows and cross-origin messages", () => {
    expect(isSowerFrameReady({ ...event, source: other }, expected)).toBe(false);
    expect(isSowerFrameReady({ ...event, origin: "https://elsewhere.example" }, expected)).toBe(false);
    expect(isSowerFrameReady(event, { ...expected, token: "next-load-token" })).toBe(false);
  });

  it("does not report backend health, malformed messages or an absent iframe as loaded", () => {
    expect(isSowerFrameReady({ ...event, data: { ready: true } }, expected)).toBe(false);
    expect(isSowerFrameReady({ ...event, data: null }, expected)).toBe(false);
    expect(isSowerFrameReady(event, { ...expected, source: null })).toBe(false);
  });
});
