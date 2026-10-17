import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  parseSession: vi.fn(),
  canAccess: vi.fn(),
  activeAccount: vi.fn(),
  rate: vi.fn()
}));

vi.mock("@/lib/security-rate-limit", () => ({ consumeSecurityRateLimit: mocks.rate }));
vi.mock("@/lib/security-web-account", () => ({
  isActiveSecurityAccount: mocks.activeAccount,
  securityAccountIdentity: (session: { username?: string; tenantId?: string }) => JSON.stringify([session.tenantId, session.username])
}));

beforeEach(() => {
  mocks.activeAccount.mockReset().mockResolvedValue(true);
  mocks.rate.mockReset().mockResolvedValue({ allowed: true, remaining: 100, retryAfterSeconds: 0 });
});

vi.mock("@/lib/auth", () => ({
  ROLE_HOME: { tenant: "/dashboards/operating-network", admin: "/dashboards/operating-network" },
  SESSION_COOKIE: "sanjie_session",
  parseSession: mocks.parseSession,
  canAccess: mocks.canAccess
}));

import { middleware } from "./middleware";

const TOKEN = "a".repeat(64);

describe("authentication redirects behind the production proxy", () => {
  beforeEach(() => {
    mocks.parseSession.mockReset();
    mocks.canAccess.mockReset();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_APP_ORIGIN", "");
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each(["/v1/models", "/api/v1/models", "/api/v1/videos/job/content"])("lets %s reach its Bearer-key handler without a web session", async (pathname) => {
    const response = await middleware(new NextRequest(`https://localhost:3040${pathname}`));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(mocks.parseSession).not.toHaveBeenCalled();
  });

  it("pairs internal rewrites with raw-origin URL preservation in deployment config", async () => {
    const configPath = new URL("../next.config.mjs", import.meta.url).href;
    const { default: deploymentConfig } = await import(/* @vite-ignore */ configPath);
    expect(deploymentConfig.skipMiddlewareUrlNormalize).toBe(true);
  });

  it("rewrites a direct creative HTML visit to live database authorization", async () => {
    mocks.parseSession.mockResolvedValue({role:"tenant"});
    mocks.canAccess.mockReturnValue(true);
    const response = await middleware(new NextRequest("https://localhost:3040/creative/labs/image-prompt-lab/promptlab.html?mode=sku"));
    expect(response.headers.get("x-middleware-rewrite")).toBe("https://localhost:3040/api/creative/assets/labs/image-prompt-lab/promptlab.html?mode=sku");
  });

  it.each([
    ["http", "/creative/labs/image-prompt-lab/promptlab.html?mode=main&source=web&studio=1", "/api/creative/assets/labs/image-prompt-lab/promptlab.html"],
    ["https", "/creative/labs/image-prompt-lab/promptlab.html?mode=main&source=web&studio=1", "/api/creative/assets/labs/image-prompt-lab/promptlab.html"],
    ["https", "/downloads/member-only.zip?version=1", "/api/protected-downloads/member-only.zip"]
  ])("keeps %s internal rewrites on the exact server origin", async (scheme, asset, destination) => {
    vi.stubEnv("__NEXT_NO_MIDDLEWARE_URL_NORMALIZE", "true");
    mocks.parseSession.mockResolvedValue({ role: "tenant" });
    mocks.canAccess.mockReturnValue(true);
    const raw = `${scheme}://127.0.0.1:31954${asset}`;
    const request = new NextRequest(raw, { headers: {
      host: "attacker.example",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": scheme
    } });
    expect(request.nextUrl.hostname).toBe("localhost");
    expect(request.url).toBe(raw);
    const response = await middleware(request);
    const rewritten = new URL(response.headers.get("x-middleware-rewrite")!);
    expect(rewritten.origin).toBe(new URL(raw).origin);
    expect(rewritten.pathname).toBe(destination);
    expect(rewritten.search).toBe(new URL(raw).search);
    expect(mocks.activeAccount).toHaveBeenCalledOnce();
    expect(mocks.rate).toHaveBeenCalledOnce();
  });

  it.each(["/", "/tools", "/dashboards/operating-network"])(
    "redirects anonymous %s to the official login despite the internal request URL",
    async (pathname) => {
      mocks.parseSession.mockResolvedValue(null);
      const response = await middleware(new NextRequest(`https://localhost:3040${pathname}`, {
        headers: {
          host: "shaozhuangai.com",
          "x-forwarded-host": "shaozhuangai.com",
          "x-forwarded-proto": "https"
        }
      }));
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(pathname === "/dashboards/operating-network" ? "https://shaozhuangai.com/login?returnTo=%2Fdashboards%2Foperating-network" : "https://shaozhuangai.com/login");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  );

  it("ignores untrusted Host headers and preserves the existing query", async () => {
    mocks.parseSession.mockResolvedValue(null);
    const response = await middleware(new NextRequest("https://localhost:3040/tools?view=report", {
      headers: { host: "attacker.example", "x-forwarded-host": "attacker.example" }
    }));
    expect(response.headers.get("location")).toBe("https://shaozhuangai.com/login?view=report");
  });

  it("preserves the shared report return path and replaces a supplied returnTo", async () => {
    mocks.parseSession.mockResolvedValue(null);
    const pathname = "/shared/dmp-reports/not-a-token";
    const search = "?view=report&returnTo=https%3A%2F%2Fattacker.example";
    const response = await middleware(new NextRequest(`https://localhost:3040${pathname}${search}`));
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://shaozhuangai.com");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("view")).toBe("report");
    expect(location.searchParams.get("returnTo")).toBe(`${pathname}${search}`);
  });

  it("uses the public origin for a signed-in user's role redirect", async () => {
    mocks.parseSession.mockResolvedValue({ role: "tenant" });
    mocks.canAccess.mockReturnValue(false);
    const response = await middleware(new NextRequest("https://localhost:3040/management?tab=users"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://shaozhuangai.com/dashboards/operating-network?tab=users"
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.canAccess).toHaveBeenCalledWith("tenant", "/management");
  });

  it("honors a validated deployment origin", async () => {
    vi.stubEnv("PUBLIC_APP_ORIGIN", "https://reports.example.com/");
    mocks.parseSession.mockResolvedValue(null);
    const response = await middleware(new NextRequest("https://localhost:3040/"));
    expect(response.headers.get("location")).toBe("https://reports.example.com/login");
  });

  it("keeps a local development login on the local server", async () => {
    vi.stubEnv("NODE_ENV", "development");
    mocks.parseSession.mockResolvedValue(null);
    const response = await middleware(new NextRequest("http://localhost:3122/tools?x=1"));
    expect(response.headers.get("location")).toBe("http://localhost:3122/login?x=1");
  });

  it("keeps unauthenticated API requests as 401 without a redirect", async () => {
    mocks.parseSession.mockResolvedValue(null);
    const response = await middleware(new NextRequest("https://localhost:3040/api/private"));
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
  });

  it("continues to allow an authorized page without a redirect", async () => {
    mocks.parseSession.mockResolvedValue({ role: "tenant" });
    mocks.canAccess.mockReturnValue(true);
    const response = await middleware(new NextRequest("https://localhost:3040/tools"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it.each(["/login", "/privacy", "/api/auth/me"])("keeps %s public", async (pathname) => {
    const response = await middleware(new NextRequest(`https://localhost:3040${pathname}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(mocks.parseSession).not.toHaveBeenCalled();
  });
});

describe("DMP shared report middleware", () => {
  beforeEach(() => {
    mocks.parseSession.mockReset();
    mocks.canAccess.mockReset();
  });

  it.each(["GET", "HEAD"])("allows anonymous %s access to an exact high-entropy report path", async (method) => {
    mocks.parseSession.mockResolvedValue(null);
    const response = await middleware(new NextRequest(`https://shaozhuangai.com/shared/dmp-reports/${TOKEN}`, { method }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(mocks.parseSession).not.toHaveBeenCalled();
  });

  it("allows only read semantics on the public report page", async () => {
    mocks.parseSession.mockResolvedValue(null);
    const response = await middleware(new NextRequest(`https://shaozhuangai.com/shared/dmp-reports/${TOKEN}`, { method: "POST" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(mocks.parseSession).not.toHaveBeenCalled();
  });

  it.each(["POST", "OPTIONS"])("allows anonymous %s requests to the exact interaction endpoint", async (method) => {
    mocks.parseSession.mockResolvedValue(null);
    const response = await middleware(new NextRequest(`https://shaozhuangai.com/api/shared/dmp-reports/${TOKEN}`, { method }));
    expect(response.status).toBe(200);
    expect(mocks.parseSession).not.toHaveBeenCalled();
  });

  it("does not expose the complete report JSON through an anonymous API GET", async () => {
    mocks.parseSession.mockResolvedValue(null);
    const response = await middleware(new NextRequest(`https://shaozhuangai.com/api/shared/dmp-reports/${TOKEN}`));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, OPTIONS");
    expect(mocks.parseSession).not.toHaveBeenCalled();
  });

  it.each([
    `/shared/dmp-reports/${"a".repeat(63)}`,
    `/shared/dmp-reports/${TOKEN}/extra`,
    `/shared/dmp-reports/not-a-token`
  ])("keeps malformed report path %s behind page authentication", async (pathname) => {
    mocks.parseSession.mockResolvedValue(null);
    const response = await middleware(new NextRequest(`https://shaozhuangai.com${pathname}`));
    expect(response.status).toBe(307);
    expect(mocks.parseSession).toHaveBeenCalledOnce();
  });

  it.each([
    `/api/shared/dmp-reports/${"a".repeat(63)}`,
    `/api/shared/dmp-reports/${TOKEN}/extra`,
    `/api/shared/dmp-reports/not-a-token`
  ])("keeps malformed interaction path %s behind API authentication", async (pathname) => {
    mocks.parseSession.mockResolvedValue(null);
    const response = await middleware(new NextRequest(`https://shaozhuangai.com${pathname}`, { method: "POST" }));
    expect(response.status).toBe(401);
    expect(mocks.parseSession).toHaveBeenCalledOnce();
  });

  it.each(["POST", "OPTIONS"])("lets the DMP export endpoint validate an extension session header for %s", async (method) => {
    mocks.parseSession.mockResolvedValue(null);
    const response = await middleware(new NextRequest(
      "https://shaozhuangai.com/api/dmp-report-exports",
      { method, headers: { "x-sanjie-session": "signed-admin-session" } }
    ));
    expect(response.status).toBe(200);
    expect(mocks.parseSession).toHaveBeenCalledWith("signed-admin-session");
  });

  it.each(["POST", "OPTIONS"])("lets the isolated market archive endpoint validate the extension session for %s", async (method) => {
    mocks.parseSession.mockResolvedValue(null);
    const response = await middleware(new NextRequest(
      "https://shaozhuangai.com/api/dmp-market-reports",
      { method, headers: { "x-sanjie-session": "signed-extension-session" } }
    ));
    expect(response.status).toBe(200);
    expect(mocks.parseSession).toHaveBeenCalledWith("signed-extension-session");
  });
});
