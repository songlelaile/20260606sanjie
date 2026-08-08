import { describe, expect, it } from "vitest";
import { metricChange } from "@/lib/metric-change";

describe("metricChange", () => {
  it("uses explicit new and disappeared states", () => {
    expect(metricChange(0, 10)).toEqual({ status: "new", delta: 10, rate: null });
    expect(metricChange(10, 0)).toEqual({ status: "disappeared", delta: -10, rate: null });
  });

  it("does not compare missing values", () => {
    expect(metricChange(null, 10)).toEqual({ status: "unavailable", delta: null, rate: null });
  });
});
