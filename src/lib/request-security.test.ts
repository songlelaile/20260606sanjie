import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPrivateSourcePath, rejectsCrossSiteMutation } from "./request-security";

beforeEach(() => { vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("PUBLIC_APP_ORIGIN", ""); });
afterEach(() => vi.unstubAllEnvs());
const request = (path: string, headers: Record<string, string> = {}, method = "POST") =>
  new Request(`https://localhost:3040${path}`, { method, headers });

describe("browser mutation boundary", () => {
  it.each(["https://shaozhuangai.com", "https://www.shaozhuangai.com"])("accepts the existing site %s", origin => {
    expect(rejectsCrossSiteMutation(request("/api/shops", { origin, host: "evil.example" }))).toBe(false);
  });
  it.each(["https://evil.example", "null", "http://shaozhuangai.com", "https://shaozhuangai.com.evil.example", "https://sub.shaozhuangai.com", "https://shaozhuangai.com/path"])("rejects %s despite spoofed forwarding headers", origin => {
    expect(rejectsCrossSiteMutation(request("/api/auth/login", { origin, host: "evil.example", "x-forwarded-host": "evil.example" }))).toBe(true);
  });
  it("rejects missing Origin on cross-site and same-site browser mutations", () => {
    for (const site of ["cross-site", "same-site", "none"]) expect(rejectsCrossSiteMutation(request("/api/shops", { "sec-fetch-site": site }))).toBe(true);
    expect(rejectsCrossSiteMutation(request("/api/shops", { "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(rejectsCrossSiteMutation(request("/api/shops"))).toBe(false);
  });
  it("preserves extension token and Bearer-key routes while cookie-only DMP writes remain protected", () => {
    const origin = "https://dmp.taobao.com";
    expect(rejectsCrossSiteMutation(request("/api/dmp-reports", { origin, "x-sanjie-session": "signed-token" }))).toBe(false);
    expect(rejectsCrossSiteMutation(request("/api/dmp-reports", { origin }))).toBe(true);
    expect(rejectsCrossSiteMutation(request("/api/managed-users", { origin, "x-sanjie-session": "forged" }))).toBe(true);
    expect(rejectsCrossSiteMutation(request("/api/v1/images/generations", { origin }))).toBe(false);
    expect(rejectsCrossSiteMutation(request("/api/shops", { origin }, "OPTIONS"))).toBe(false);
  });
  it("honors an exact configured staging origin", () => {
    vi.stubEnv("PUBLIC_APP_ORIGIN", "https://uat.example.com");
    expect(rejectsCrossSiteMutation(request("/api/shops", { origin: "https://uat.example.com" }))).toBe(false);
    expect(rejectsCrossSiteMutation(request("/api/shops", { origin: "https://shaozhuangai.com" }))).toBe(true);
  });
});

describe("source artifact protection", () => {
  it.each(["/.env", "/.env.production", "/%2egit/config", "/_next/static/chunks/app.js.map", "/downloads/backup.tgz", "/package.json", "/private-assets/foo.zip", "/creative/src/secret.ts", "/prisma/dev.db", "/api/foo%5cbar", "/%invalid"])("blocks %s", value => expect(isPrivateSourcePath(value)).toBe(true));
  it.each(["/_next/static/chunks/app.js", "/creative/src/business-knowledge.js", "/creative/labs/image-prompt-lab/promptlab.html", "/downloads/sycm-keyword-collector-v1.9.23.zip", "/api/shops", "/api/dmp-source-data", "/privacy"])("keeps runtime path %s", value => expect(isPrivateSourcePath(value)).toBe(false));
});
