import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { isDefinitiveSupplyAuthenticationRejection, redactSupplySecrets, runSupplyWithFailover } from "./supply-failover";

const credentials = { primary: { id: "credential-a", apiKey: "primary-fixture" }, backup: { id: "credential-b", apiKey: "backup-fixture" } };
const rejected = (extra: Record<string, unknown> = {}) => Response.json({ error: { code: "invalid_api_key" }, ...extra }, { status: 401 });

describe("supply failover", () => {
  it("dispatches the backup once for an explicit authentication rejection and leaves final bytes readable", async () => {
    const send = vi.fn().mockResolvedValueOnce(rejected()).mockResolvedValueOnce(Response.json({ data: [{ b64_json: "image" }] }));
    const result = await runSupplyWithFailover(credentials, send);
    expect(result).toMatchObject({ credentialId: "credential-b", attempts: 2 });
    expect(send.mock.calls.map(([credential]) => credential.id)).toEqual(["credential-a", "credential-b"]);
    expect(await result.response.json()).toEqual({ data: [{ b64_json: "image" }] });
  });
  it("selects a configured backup before any submission when the primary is locally absent", async () => {
    const send = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    expect(await runSupplyWithFailover({ ...credentials, primary: { ...credentials.primary, apiKey: "" } }, send)).toMatchObject({ credentialId: "credential-b", attempts: 1 });
    expect(send).toHaveBeenCalledExactlyOnceWith(credentials.backup);
  });
  it.each(["INVALID_API_KEY", "API_KEY_DISABLED"])("recognizes the verified Sub2API middleware 401 shape %s", async (code) => {
    const send = vi.fn().mockResolvedValueOnce(Response.json({ code, message: "Authentication rejected" }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ data: [{ b64_json: "image" }] }));
    expect(await runSupplyWithFailover(credentials, send)).toMatchObject({ attempts: 2, credentialId: "credential-b" });
  });
  it.each(["USER_INACTIVE", "USER_NOT_FOUND", "API_KEY_EXPIRED"])("does not infer a per-Key failover from Sub2API account or unsupported code %s", async (code) => {
    const send = vi.fn().mockResolvedValue(Response.json({ code, message: "Rejected" }, { status: code === "API_KEY_EXPIRED" ? 403 : 401 }));
    expect(await runSupplyWithFailover(credentials, send)).toMatchObject({ attempts: 1 });
    expect(send).toHaveBeenCalledOnce();
  });
  it.each([429, 500, 502, 503, 504, 403, 200])("never resubmits for ambiguous HTTP %i", async (status) => {
    const send = vi.fn().mockResolvedValue(Response.json({ error: { code: "invalid_api_key" } }, { status }));
    expect(await runSupplyWithFailover(credentials, send)).toMatchObject({ attempts: 1 });
    expect(send).toHaveBeenCalledOnce();
  });
  it.each([{ id: "accepted" }, { task_id: "accepted" }, { request_id: "accepted" }, { data: [] }, { usage: null }, { nested: { output: "accepted" } }, { status: "queued" }, { providerSubmitted: true }])(
    "never resubmits an authentication-shaped response containing acceptance evidence: %j", async (extra) => {
      const send = vi.fn().mockResolvedValue(rejected(extra));
      await runSupplyWithFailover(credentials, send);
      expect(send).toHaveBeenCalledOnce();
    }
  );
  it("does not infer rejection from a message, invalid JSON or an oversized error body", async () => {
    expect(await isDefinitiveSupplyAuthenticationRejection(Response.json({ error: { message: "invalid api key" } }, { status: 401 }))).toBe(false);
    expect(await isDefinitiveSupplyAuthenticationRejection(new Response("invalid", { status: 401, headers: { "content-type": "application/json" } }))).toBe(false);
    expect(await isDefinitiveSupplyAuthenticationRejection(rejected({ message: "x".repeat(20_000) }))).toBe(false);
  });
  it("does not retry a timeout and does not recurse after a backup authentication failure", async () => {
    const timeout = vi.fn().mockRejectedValue(new DOMException("timeout", "TimeoutError"));
    await expect(runSupplyWithFailover(credentials, timeout)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeout).toHaveBeenCalledOnce();
    const send = vi.fn().mockImplementation(async () => rejected());
    expect(await runSupplyWithFailover(credentials, send)).toMatchObject({ attempts: 2, credentialId: "credential-b" });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("redacts both keys recursively without changing the response structure", () => {
    expect(redactSupplySecrets({ debug: ["primary-fixture and backup-fixture"], usage: { cost: 1 } }, [credentials.primary.apiKey, credentials.backup.apiKey])).toEqual({ debug: ["[redacted] and [redacted]"], usage: { cost: 1 } });
  });
});
