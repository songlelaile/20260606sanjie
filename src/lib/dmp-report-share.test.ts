import { describe, expect, it } from "vitest";
import { normalizeDmpClickEvents } from "@/lib/dmp-report-share-events";

describe("DMP anonymous click bucketing", () => {
  it("aggregates identical anonymous clicks without storing business text", () => {
    const events = normalizeDmpClickEvents([
      { sectionKey: "table:渠道指标", elementKey: "cell:3", x: 0.501, y: 0.249 },
      { sectionKey: "table:渠道指标", elementKey: "cell:3", x: 0.509, y: 0.249 },
      { sectionKey: "\u0000table:渠道指标", elementKey: " cell:3 ", x: 0.5, y: 0.24 }
    ]);

    expect(events).toEqual([
      { sectionKey: "table:渠道指标", elementKey: "cell:3", xBucket: 10, yBucket: 4, count: 3 }
    ]);
  });

  it("drops invalid coordinates and clamps valid boundary coordinates", () => {
    expect(normalizeDmpClickEvents([
      { sectionKey: "hero", elementKey: "print", x: "bad", y: 0.5 },
      { sectionKey: "hero", elementKey: "print", x: -2, y: 9 }
    ])).toEqual([
      { sectionKey: "hero", elementKey: "print", xBucket: 0, yBucket: 19, count: 1 }
    ]);
  });
});
