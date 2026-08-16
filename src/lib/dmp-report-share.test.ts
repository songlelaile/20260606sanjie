import { describe, expect, it } from "vitest";
import {
  normalizeDmpClickEvents,
  normalizeDmpPublicShareEvent
} from "@/lib/dmp-report-share-events";

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

  it("drops unknown report keys and limits each click batch to fifty events", () => {
    const events = Array.from({ length: 60 }, (_, index) => ({
      sectionKey: index === 0 ? "private:business-value" : "hero",
      elementKey: index === 1 ? "raw-cell-value" : "button",
      x: 0.5,
      y: index / 100
    }));
    const normalized = normalizeDmpClickEvents(events);
    expect(normalized.reduce((sum, event) => sum + event.count, 0)).toBe(48);
    expect(normalized.every((event) => event.sectionKey === "hero" && event.elementKey === "button")).toBe(true);
  });
});

describe("DMP public share event normalization", () => {
  const identity = {
    eventId: "event-1234567890abcdef",
    visitorId: "visitor-1234567890abcdef",
    sessionId: "session-1234567890abcdef"
  };

  it("accepts anonymous views while retaining only a source hostname and bounded UTM fields", () => {
    expect(normalizeDmpPublicShareEvent({
      type: "view",
      ...identity,
      sourceDomain: "https://News.Example.COM/private/path?customer=secret",
      utmSource: " 微信\u0000朋友圈 ",
      utmMedium: "social<script>",
      utmCampaign: "新品 / 八月"
    })).toEqual({
      type: "view",
      ...identity,
      referrerHost: "news.example.com",
      source: "微信朋友圈",
      medium: "socialscript",
      campaign: "新品 / 八月"
    });
  });

  it("rejects missing anonymous identifiers and unsupported event types", () => {
    expect(normalizeDmpPublicShareEvent({ type: "view", ...identity, sessionId: "short" })).toBeNull();
    expect(normalizeDmpPublicShareEvent({ type: "download", ...identity })).toBeNull();
  });

  it("clamps engagement to the public analytics contract", () => {
    expect(normalizeDmpPublicShareEvent({
      type: "engagement",
      ...identity,
      activeSeconds: 99_999,
      maxScrollDepth: 120
    })).toMatchObject({
      type: "engagement",
      activeSeconds: 21_600,
      maxScrollDepth: 100
    });
  });
});
