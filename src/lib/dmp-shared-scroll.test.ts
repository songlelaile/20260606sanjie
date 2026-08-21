import { describe, expect, it } from "vitest";
import { calculateDmpScrollDepth } from "@/lib/dmp-scroll-depth";

describe("DMP shared report scroll depth", () => {
  it("uses the scroll container viewport and offset", () => {
    expect(calculateDmpScrollDepth({ scrollTop: 0, clientHeight: 800, scrollHeight: 3_200 })).toBe(25);
    expect(calculateDmpScrollDepth({ scrollTop: 1_200, clientHeight: 800, scrollHeight: 3_200 })).toBe(63);
    expect(calculateDmpScrollDepth({ scrollTop: 2_400, clientHeight: 800, scrollHeight: 3_200 })).toBe(100);
  });

  it("clamps overscroll and handles empty or invalid metrics", () => {
    expect(calculateDmpScrollDepth({ scrollTop: 9_999, clientHeight: 800, scrollHeight: 3_200 })).toBe(100);
    expect(calculateDmpScrollDepth({ scrollTop: -300, clientHeight: 800, scrollHeight: 3_200 })).toBe(25);
    expect(calculateDmpScrollDepth({ scrollTop: 0, clientHeight: 800, scrollHeight: 0 })).toBe(0);
    expect(calculateDmpScrollDepth({ scrollTop: Number.NaN, clientHeight: Number.NaN, scrollHeight: Number.NaN })).toBe(0);
  });
});
