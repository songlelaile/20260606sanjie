import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ parseSession: vi.fn(), canAccess: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  ROLE_HOME: { tenant: "/dashboards/operating-network", admin: "/management" },
  SESSION_COOKIE: "sanjie_session", parseSession: mocks.parseSession, canAccess: mocks.canAccess
}));
// Preserve original production navigation assertions while isolating the new
// database security boundary; its revocation/quota cases have dedicated tests.
vi.mock("@/lib/security-rate-limit", () => ({ consumeSecurityRateLimit: async () => ({ allowed: true, remaining: 1, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/security-web-account", () => ({ isActiveSecurityAccount: async () => true, securityAccountIdentity: () => "fixture-account" }));
import { middleware } from "./middleware";

const ORIGIN = "https://shaozhuangai.com";
const IMAGE = "/dashboards/operating-network";
const ROUTES = [IMAGE, ...["detail", "sku", "viral", "viral-case", "viral-style", "viral-scene", "clothing", "buyer", "refinement"].map((id) => `${IMAGE}?surface=${id}`), `${IMAGE}/video`];

describe("creative login returns through middleware", () => {
  beforeEach(() => { mocks.parseSession.mockReset(); mocks.canAccess.mockReset(); mocks.parseSession.mockResolvedValue(null); });

  it.each(ROUTES)("preserves anonymous module %s as a validated login return", async (route) => {
    const response = await middleware(new NextRequest(ORIGIN + route));
    const location = new URL(response.headers.get("location")!);
    expect(response.status).toBe(307);
    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe("/login");
    expect([...location.searchParams.keys()]).toEqual(["returnTo"]);
    expect(location.searchParams.get("returnTo")).toBe(route);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each([
    `${IMAGE}?surface=sku&returnTo=https://evil.example`,
    `${IMAGE}?surface=main&apiKey=secret`, `${IMAGE}?contextToken=secret`,
    `${IMAGE}?surface=main&surface=buyer`, `${IMAGE}/video?source=plugin`
  ])("drops invalid and potentially sensitive creative query %s", async (route) => {
    const response = await middleware(new NextRequest(ORIGIN + route));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login`);
  });

  it("keeps batch tasks and existing non-creative behavior", async () => {
    const batch = await middleware(new NextRequest(`${ORIGIN}${IMAGE}?batch=1&surface=main`));
    expect(new URL(batch.headers.get("location")!).searchParams.get("returnTo")).toBe(`${IMAGE}?surface=main&batch=1`);
    const tools = await middleware(new NextRequest(`${ORIGIN}/tools?view=report`));
    expect(tools.headers.get("location")).toBe(`${ORIGIN}/login?view=report`);
    const api = await middleware(new NextRequest(`${ORIGIN}/api/private`));
    expect(api.status).toBe(401);
    expect(api.headers.get("location")).toBeNull();
  });

  it("keeps existing DMP authentication return behavior", async () => {
    const route = "/shared/dmp-reports/not-a-token?view=report&returnTo=https%3A%2F%2Fevil.example";
    const response = await middleware(new NextRequest(ORIGIN + route));
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("view")).toBe("report");
    expect(location.searchParams.get("returnTo")).toBe(route);
  });

  it("continues applying the signed-in page access restriction", async () => {
    mocks.parseSession.mockResolvedValue({ role: "admin" });
    mocks.canAccess.mockReturnValue(false);
    const response = await middleware(new NextRequest(`${ORIGIN}${IMAGE}?surface=buyer`));
    expect(new URL(response.headers.get("location")!).pathname).toBe("/management");
    expect(mocks.canAccess).toHaveBeenCalledWith("admin", IMAGE);
  });
});
