import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { trustedClientIp } from "./security-client-ip";

const request = (headers: Record<string, string> = {}) => new Request("https://shaozhuangai.com/api/auth/login", { headers });

describe("trusted ingress client IP", () => {
  beforeEach(() => { vi.stubEnv("SANJIE_TRUST_PROXY_IP", "false"); });
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, "false", "TRUE", "1"])("ignores supplied IP headers unless trust is explicitly enabled: %s", flag => {
    if (flag === undefined) vi.stubEnv("SANJIE_TRUST_PROXY_IP", "");
    else vi.stubEnv("SANJIE_TRUST_PROXY_IP", flag);
    expect(trustedClientIp(request({ "x-real-ip": "203.0.113.2", "x-forwarded-for": "198.51.100.1" }))).toBeNull();
  });

  it("uses ingress X-Real-IP when enabled and never falls back to XFF", () => {
    vi.stubEnv("SANJIE_TRUST_PROXY_IP", "true");
    expect(trustedClientIp(request({ "x-real-ip": "203.0.113.2", "x-forwarded-for": "198.51.100.1" }))).toBe("203.0.113.2");
    expect(trustedClientIp(request({ "x-forwarded-for": "198.51.100.1" }))).toBeNull();
  });

  it.each(["", "unknown", "203.0.113.2, 198.51.100.1", "203.0.113.2:443", "[2001:db8::1]", "127.0.0.999", "fe80::1%eth0"])
  ("rejects malformed headers or chains: %s", header => {
    vi.stubEnv("SANJIE_TRUST_PROXY_IP", "true");
    expect(trustedClientIp(request({ "x-real-ip": header }))).toBeNull();
  });

  it("canonicalizes IPv6 case and expanded representations", () => {
    vi.stubEnv("SANJIE_TRUST_PROXY_IP", "true");
    expect(trustedClientIp(request({ "x-real-ip": "2001:0DB8:0000:0000:0000:0000:0000:0001" }))).toBe("2001:db8::1");
    expect(trustedClientIp(request({ "x-real-ip": "2001:db8::1" }))).toBe("2001:db8::1");
  });
});
