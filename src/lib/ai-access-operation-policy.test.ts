import { describe, expect, it } from "vitest";
import { evaluateAiAccessOperation, resolveAiAccessOperation } from "./ai-access-operation-policy";

describe("explicit AI authorization operation catalog", () => {
  it.each([
    ["/api/auth/me", "account.read"],
    ["/api/auth/creative-access", "creative.access.read"],
    ["/api/shops", "shops.list"],
    ["/api/v1/models", "models.list"],
    ["/api/dmp-reports", "dmp.reports.list"],
    ["/api/dmp-reports?id=report-123", "dmp.report.read"]
  ])("allows catalog read %s with either grant", (path, action) => {
    for (const scope of ["read", "action"] as const) {
      expect(evaluateAiAccessOperation({ method: "GET", path }, scope)).toMatchObject({ allowed: true, operation: { action, requiredScope: "read" } });
    }
  });

  it("normalizes bounded report pagination without accepting arbitrary query options", () => {
    expect(resolveAiAccessOperation({ method: "GET", path: "/api/dmp-reports" })).toMatchObject({ allowed: true, operation: { path: "/api/dmp-reports?page=1&pageSize=24", query: { page: 1, pageSize: 24 } } });
    expect(resolveAiAccessOperation({ method: "GET", path: "/api/dmp-reports?pageSize=50&page=1000000" })).toMatchObject({ allowed: true, operation: { path: "/api/dmp-reports?page=1000000&pageSize=50", query: { page: 1000000, pageSize: 50 } } });
  });

  it("allows only the independent AI shop context action and refuses read grants", () => {
    const input = { method: "PATCH", path: "/api/shops/active", body: { shopId: "shop-123" } };
    expect(evaluateAiAccessOperation(input, "action")).toEqual({ allowed: true, operation: { action: "shops.activate", method: "PATCH", path: "/api/shops/active", requiredScope: "action", body: { shopId: "shop-123" } } });
    expect(evaluateAiAccessOperation(input, "read")).toMatchObject({ allowed: false, status: 403, code: "AI_SCOPE_REQUIRED" });
  });

  it.each([
    ["POST", "/api/shops/active"], ["POST", "/api/dmp-report-shares"],
    ["POST", "/api/v1/images/generations"], ["POST", "/api/v1/chat/completions"],
    ["POST", "/api/creative/proxy"], ["PATCH", "/api/growth-profit-config"],
    ["POST", "/api/model-gateway/orders"], ["POST", "/api/model-gateway/keys"],
    ["POST", "/api/managed-users/user/reset-password"], ["DELETE", "/api/managed-users/user"],
    ["GET", "/api/ai-api-config"], ["GET", "/api/model-gateway/overview"],
    ["GET", "/api/dmp-report-exports"], ["GET", "/api/tools/dmp/download"],
    ["GET", "/api/sower-work/access"], ["GET", "/api/shops/active"],
    ["GET", "/api/ai-access/execute"], ["GET", "/api/auth/logout"]
  ])("refuses unlisted action even with action grant: %s %s", (method, path) => {
    expect(evaluateAiAccessOperation({ method, path }, "action")).toMatchObject({ allowed: false, status: 403 });
  });

  it.each([
    "https://site.test/api/auth/me", "//evil.test/api/auth/me", "/api/auth/me#private",
    "/api\\auth\\me", "/api/auth/me\n", "/api/auth/me\u0000", "/api/auth/me ",
    "/api/auth/../auth/me", "/api/auth/%2e%2e/me", "/api%2fauth/me", "/api%252fauth/me",
    "/api//auth/me", "/api/auth/me?", "/api/auth/me?x=1", "/api/auth/me?url=https://evil.test",
    "/api/dmp-reports?id=one&id=two", "/api/dmp-reports?id=one&page=1", "/api/dmp-reports?scope=archive-shop",
    "/api/dmp-reports?format=html", "/api/dmp-reports?shopId=other", "/api/dmp-reports?id=report%2f123",
    "/api/dmp-reports?id=", "/api/dmp-reports?page=0", "/api/dmp-reports?page=01",
    "/api/dmp-reports?page=-1", "/api/dmp-reports?page=1000001", "/api/dmp-reports?pageSize=51",
    "/api/dmp-reports?pageSize=1e2", "/api/dmp-reports?page=1&&pageSize=24",
    "/api/dmp-reports?page=1?scope=archive-shop", "/api/shops/"
  ])("rejects URL and query smuggling: %s", path => {
    expect(evaluateAiAccessOperation({ method: "GET", path }, "action").allowed).toBe(false);
  });

  it.each([
    { method: "GET", path: "/api/auth/me", headers: { authorization: "Bearer broad-token" } },
    { method: "GET", path: "/api/auth/me", cookie: "admin-session" },
    { method: "GET", path: "/api/auth/me", body: null },
    { method: "get", path: "/api/auth/me" },
    { method: "PATCH", path: "/api/shops/active", body: { shopId: "shop-123", cookie: "admin-session" } },
    { method: "PATCH", path: "/api/shops/active", body: { shopId: "shop-123", tenantId: "other" } },
    { method: "PATCH", path: "/api/shops/active", body: { shopId: " shop-123" } },
    { method: "PATCH", path: "/api/shops/active", body: { shopId: "../shop" } },
    { method: "PATCH", path: "/api/shops/active?shopId=other", body: { shopId: "shop-123" } },
    { method: "PATCH", path: "/api/shops/active", body: {} },
    { method: "PATCH", path: "/api/shops/active" },
    null, [], "GET /api/auth/me"
  ])("rejects injected headers, identity and malformed operation envelopes", input => {
    expect(evaluateAiAccessOperation(input, "action")).toMatchObject({ allowed: false, status: 400 });
  });

  it("does not infer authorization from unknown grants", () => {
    expect(evaluateAiAccessOperation({ method: "GET", path: "/api/auth/me" }, "admin" as never)).toMatchObject({ allowed: false, status: 403, code: "AI_SCOPE_REQUIRED" });
  });
});
