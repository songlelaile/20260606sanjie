import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  countDmpPayloadValues,
  validateDmpAnalysisPayload
} from "@/lib/dmp-runtime";

describe("DMP cloud runtime payload admission", () => {
  it("admits authorized business batches without field blacklists", () => {
    const payload = {
      schema_version: "future-version",
      subject_item_id: "593063365092",
      modules: [{
        module: "新增业务模块",
        responses: [{
          payload: {
            authorization: "业务字段原值",
            token: "业务指标名称",
            sourcePage: "https://dmp.taobao.com/new-business-path",
            nested: { futureMetric: 123.45 }
          }
        }]
      }]
    };

    expect(validateDmpAnalysisPayload(payload)).toBe("");
    expect(countDmpPayloadValues(payload)).toBeGreaterThanOrEqual(4);
  });

  it("only rejects requests that contain no processable batch", () => {
    expect(validateDmpAnalysisPayload(null)).toMatch(/结构/);
    expect(validateDmpAnalysisPayload({ modules: [] })).toMatch(/没有任何可解析/);
  });
});
