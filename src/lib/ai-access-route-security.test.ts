import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), user: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/server-session", () => ({ getCurrentSession: mocks.session, getCurrentUser: mocks.user }));
import { AIAccessError } from "./ai-access";
import { aiAccessErrorResponse, aiAccessJson, requireAIAccessAdmin } from "./ai-access-route-security";

const actor = { username: "admin-a", tenantId: "tenant-a", role: "admin", name: "Admin" };
function privateHeaders(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
}

describe("AI grant routes trust only the current active administrator cookie", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.mockResolvedValue(actor);
    mocks.user.mockResolvedValue({ authRole: "admin", status: "active", username: "admin-a", tenantId: "tenant-a", passwordHash: "never-return" });
  });

  it("returns the signed actor rather than a full user record", async () => {
    expect(await requireAIAccessAdmin()).toBe(actor);
    expect(mocks.session).toHaveBeenCalledOnce(); expect(mocks.user).toHaveBeenCalledOnce();
    expect(await requireAIAccessAdmin()).not.toHaveProperty("passwordHash");
  });

  it("rejects missing cookie identity before requesting a database user", async () => {
    mocks.session.mockResolvedValue(null);
    await expect(requireAIAccessAdmin()).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect(mocks.user).not.toHaveBeenCalled();
  });

  it.each([
    [null, "admin"], [{ authRole: "admin", status: "disabled" }, "admin"],
    [{ authRole: "tenant", status: "active" }, "admin"],
    [{ authRole: "admin", status: "active" }, "tenant"]
  ])("rejects removed, disabled, downgraded or tenant cookie actors: %j %s", async (user, role) => {
    mocks.session.mockResolvedValue({ ...actor, role }); mocks.user.mockResolvedValue(user);
    await expect(requireAIAccessAdmin()).rejects.toMatchObject({ status: 403, code: "ADMIN_REQUIRED" });
  });

  it("rechecks user state on every call and closes access after revocation", async () => {
    expect(await requireAIAccessAdmin()).toBe(actor);
    mocks.user.mockResolvedValueOnce(null);
    await expect(requireAIAccessAdmin()).rejects.toMatchObject({ status: 403 });
    expect(mocks.user).toHaveBeenCalledTimes(2);
  });

  it("preserves reviewed service statuses with private response headers", async () => {
    const response = aiAccessErrorResponse(new AIAccessError("GRANT_NOT_FOUND", "授权不存在", 404));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "授权不存在", code: "GRANT_NOT_FOUND" });
    privateHeaders(response);
  });

  it.each([new Error("postgres://private-user:private-password@db"), "private-token", { token: "private-token" }])("never serializes unexpected errors: %j", async error => {
    const response = aiAccessErrorResponse(error);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/postgres|private-user|private-password|private-token/);
    privateHeaders(response);
  });

  it("constructs JSON responses with explicit private cache and origin policies", async () => {
    const response = aiAccessJson({ data: { created: true } }, 201);
    expect(response.status).toBe(201); expect(await response.json()).toEqual({ data: { created: true } });
    privateHeaders(response);
  });

  it("database lookup failures cannot produce an authorized actor", async () => {
    mocks.user.mockRejectedValue(new Error("private-database-error"));
    const response = await requireAIAccessAdmin().then(() => { throw new Error("must not authorize"); }, aiAccessErrorResponse);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-database-error");
  });
});
