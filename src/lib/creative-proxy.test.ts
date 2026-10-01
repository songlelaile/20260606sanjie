import { describe, expect, it } from "vitest";
import { assertResolvedAddresses, evaluateCreativeProxy } from "./creative-proxy";

describe("creative proxy policy", () => {
  it("allows the Shaozhuang relay and the image lab providers", () => {
    expect(evaluateCreativeProxy("https://sub.shaozhuangai.com/v1/images/generations", "POST").ok).toBe(true);
    expect(evaluateCreativeProxy("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks", "POST").ok).toBe(true);
    expect(evaluateCreativeProxy("https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis", "POST").ok).toBe(true);
  });

  it("allows reading generated media from known public CDNs", () => {
    expect(evaluateCreativeProxy("https://ark-content-generation-cn-beijing.tos-cn-beijing.volces.com/out.png", "GET").ok).toBe(true);
  });

  it("rejects private, insecure, and unknown write targets", () => {
    expect(evaluateCreativeProxy("http://sub.shaozhuangai.com/v1/images/generations", "POST").ok).toBe(false);
    expect(evaluateCreativeProxy("https://127.0.0.1/latest/meta-data", "GET").ok).toBe(false);
    expect(evaluateCreativeProxy("https://169.254.169.254/latest/meta-data", "GET").ok).toBe(false);
    expect(evaluateCreativeProxy("https://example.com/hook", "POST").ok).toBe(false);
    expect(evaluateCreativeProxy("https://user:pass@api.openai.com/v1/images/generations", "POST").ok).toBe(false);
  });

  it("stops when DNS resolves to a private address", () => {
    expect(assertResolvedAddresses(["1.2.3.4"]).ok).toBe(true);
    expect(assertResolvedAddresses(["10.0.0.8"]).ok).toBe(false);
  });
});
