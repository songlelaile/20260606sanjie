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

  it("allows public IPv6 DNS but rejects local, mapped and empty results", () => {
    expect(assertResolvedAddresses(["2606:4700:4700::1111"]).ok).toBe(true);
    for (const addresses of [[], ["::ffff:127.0.0.1"], ["fe80::1"], ["fd00::1"], ["2001:db8::1"], ["not-an-ip"], ["224.0.0.1"]]) {
      expect(assertResolvedAddresses(addresses).ok).toBe(false);
    }
  });

  it("reads product reference images without permitting CDN writes or alternate ports", () => {
    expect(evaluateCreativeProxy("https://img.alicdn.com/image.jpg", "GET").ok).toBe(true);
    expect(evaluateCreativeProxy("https://img.alicdn.com/image.jpg", "POST").ok).toBe(false);
    expect(evaluateCreativeProxy("https://sub.shaozhuangai.com:8443/v1/images/generations", "POST").ok).toBe(false);
    expect(evaluateCreativeProxy("https://img.alicdn.com.evil.test/image.jpg", "GET").ok).toBe(false);
  });
});
