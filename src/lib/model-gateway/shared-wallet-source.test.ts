import { mkdtemp, writeFile, rm, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), relay: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: mocks.user } } }));
vi.mock("./relay-config", () => ({ getRelayRuntime: mocks.relay }));
import { readGatewaySharedWalletSource, getGatewaySharedSourceConfigVersion, getSharedWalletPlatformSupply, parseSharedWalletPrivateConfig, SHARED_WALLET_USAGE_URL } from "./shared-wallet-source";
import { parseExactSharedUpstreamCost, parseSharedWalletUsage } from "./shared-wallet-usage.mjs";
const key = "fixture-existing-inference-key", hash = "a".repeat(64);
let directory = "", keyFile = "", configFile = "";
const fetcher = vi.fn();
function config() { return { schema: "SANJIE_SHARED_WALLET_CONFIG_V1", origin: "https://sub.shaozhuangai.com", privateKeyRef: keyFile,
  credentialFingerprint: createHash("sha256").update(key).digest("hex"), ownerSubject: "fixture-owner", routeGroupBinding: { groupId: null, groupName: "fixture-group", bindingEvidenceHash: hash },
  approvalEvidenceHash: hash, approvedExposure: "posted_balance_with_unobservable_external_requests", epoch: null, maxSourceAgeMs: 30_000,
  maxFxAgeMs: 259_200_000, timeoutMs: 5000, reserveBps: 0, frozenValuationProduct: null, externalCommitments: { state: "unobservable", amountUsd: null, evidenceHash: hash } }; }
const body = '{"isValid":true,"mode":"unrestricted","unit":"USD","balance":1.12345678,"remaining":1.12345678,"usage":{"actual_cost":999}}';
function response(raw = body, status = 200, url = SHARED_WALLET_USAGE_URL, headers: Record<string, string> = { "content-type": "application/json" }) {
  const value = new Response(raw, { status, headers }); Object.defineProperty(value, "url", { value: url }); return value;
}
beforeEach(async () => { vi.clearAllMocks(); directory = await mkdtemp(path.join(tmpdir(), "shared-wallet-unit-")); keyFile = path.join(directory, "existing.key"); configFile = path.join(directory, "source.json");
  await writeFile(keyFile, key, { mode: 0o600 }); await writeFile(configFile, JSON.stringify(config()), { mode: 0o600 }); vi.stubEnv("GATEWAY_SHARED_WALLET_CONFIG_FILE", configFile);
  vi.stubGlobal("fetch", fetcher); fetcher.mockResolvedValue(response()); mocks.user.mockResolvedValue({ status: "active" }); mocks.relay.mockResolvedValue({ baseUrl: "https://sub.shaozhuangai.com/v1", usdCnyRate: 1 }); });
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
describe("shared posted owner wallet real transport boundary with mock HTTP only", () => {
  it("reads fixed same-origin GET and preserves all USD digits without claiming API IDs or expiry", async () => { const value = await readGatewaySharedWalletSource(); expect(value.source.balanceUsd).toBe("1.12345678"); expect(value.epoch).toBeNull(); expect(value.binding.routeGroupBinding.groupId).toBeNull(); expect(value.externalCommitments).toMatchObject({ state: "unobservable", amountUsd: null }); expect(JSON.stringify(value)).not.toContain(key); expect(value).not.toHaveProperty("platformPoints");
    expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][0]).toBe(SHARED_WALLET_USAGE_URL); expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "error", cache: "no-store", headers: { Authorization: `Bearer ${key}` } }); });
  it("runtime uses same existing key privately and never queries usage or creates provider credentials", async () => { const value = await getSharedWalletPlatformSupply("user-1"); expect(value.apiKey).toBe(key); expect(value).not.toHaveProperty("credentialId"); expect(value.configVersion).toBe(await getGatewaySharedSourceConfigVersion()); expect(fetcher).not.toHaveBeenCalled(); });
  it("disabled user cannot obtain private platform runtime", async () => { mocks.user.mockResolvedValue({ status: "disabled" }); await expect(getSharedWalletPlatformSupply("user-1")).rejects.toMatchObject({ code: "ACCOUNT_UNAVAILABLE" }); expect(fetcher).not.toHaveBeenCalled(); });
  it("missing source fails closed before any transport", async () => { vi.stubEnv("GATEWAY_SHARED_WALLET_CONFIG_FILE", ""); await expect(readGatewaySharedWalletSource()).rejects.toMatchObject({ code: "SHARED_SOURCE_NOT_CONFIGURED" }); expect(fetcher).not.toHaveBeenCalled(); });
  it.each(["origin", "budget", "verified", "apiKey"])("configuration cannot change trust through %s", field => { expect(() => parseSharedWalletPrivateConfig({ ...config(), [field]: field === "origin" ? "https://attacker.example" : 123 })).toThrow(); });
  it("unobservable commitment never becomes proved zero", () => { expect(() => parseSharedWalletPrivateConfig({ ...config(), externalCommitments: { state: "unobservable", amountUsd: "0", evidenceHash: hash } })).toThrow(); });
  it("external arguments cannot select source or inject balances", async () => { await expect(readGatewaySharedWalletSource({ budget: 1000 } as never)).rejects.toMatchObject({ code: "POOL_INPUT_INVALID" }); expect(fetcher).not.toHaveBeenCalled(); });
  it("changed key is rejected before sending its bytes", async () => { await writeFile(keyFile, "different-private-fixture-key"); await expect(readGatewaySharedWalletSource()).rejects.toMatchObject({ code: "SHARED_SOURCE_KEY_CHANGED" }); expect(fetcher).not.toHaveBeenCalled(); });
  it.each(["key", "config"])("public-readable %s files cannot supply credentials", async which => { await chmod(which === "key" ? keyFile : configFile, 0o644); await expect(readGatewaySharedWalletSource()).rejects.toMatchObject({ code: "SHARED_SOURCE_PRIVATE_FILE_INVALID" }); expect(fetcher).not.toHaveBeenCalled(); });
  it("symlink key ref is refused", async () => { const actual = path.join(directory, "actual.key"); await writeFile(actual, key, { mode: 0o600 }); await rm(keyFile); await symlink(actual, keyFile); await expect(readGatewaySharedWalletSource()).rejects.toMatchObject({ code: "SHARED_SOURCE_KEY_UNAVAILABLE" }); });
  it.each([301, 401, 403, 429, 500])("non-200 %s never becomes proof", async status => { fetcher.mockResolvedValue(response("private-secret", status)); await expect(readGatewaySharedWalletSource()).rejects.toMatchObject({ status: 503 }); });
  it("final URL change is rejected", async () => { fetcher.mockResolvedValue(response(body, 200, "https://other.example/v1/usage" as typeof SHARED_WALLET_USAGE_URL)); await expect(readGatewaySharedWalletSource()).rejects.toMatchObject({ code: "SOURCE_REDIRECT_REJECTED" }); });
  it("oversize decoded body is cancelled and rejected", async () => { fetcher.mockResolvedValue(response("x".repeat(65_537))); await expect(readGatewaySharedWalletSource()).rejects.toMatchObject({ code: "SOURCE_RESPONSE_TOO_LARGE" }); });
  it("transport exception does not expose request/header/secret details", async () => { fetcher.mockRejectedValue(new Error(`Authorization Bearer ${key}`)); await expect(readGatewaySharedWalletSource()).rejects.toMatchObject({ code: "SOURCE_TRANSPORT_FAILED", message: "共用钱包来源暂时无法核验，请管理员核对连接" }); });
  it.each(["transport", "server"])("retries one transient %s GET without resending a generation request", async kind => {
    if (kind === "transport") fetcher.mockRejectedValueOnce(new Error("private transport detail"));
    else fetcher.mockResolvedValueOnce(response("private body", 503));
    fetcher.mockResolvedValueOnce(response());
    expect((await readGatewaySharedWalletSource()).source.balanceUsd).toBe("1.12345678");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(call => call[0] === SHARED_WALLET_USAGE_URL && call[1].method === "GET")).toBe(true);
  });
  it.each([401, 403, 429, 400])("does not retry authentication, policy, or rate-limit rejection %s", async status => {
    fetcher.mockResolvedValue(response("private body", status));
    await expect(readGatewaySharedWalletSource()).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("never retries malformed successful wallet evidence", async () => {
    fetcher.mockResolvedValue(response('{"private":"response"}'));
    await expect(readGatewaySharedWalletSource()).rejects.toMatchObject({ code: "SOURCE_WALLET_SCOPE_CHANGED" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("a timed-out read can retry once within the original total deadline", async () => {
    await writeFile(configFile, JSON.stringify({ ...config(), timeoutMs: 40 }), { mode: 0o600 });
    fetcher.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("private timeout")), { once: true })));
    fetcher.mockResolvedValueOnce(response());
    expect((await readGatewaySharedWalletSource()).source.balanceUsd).toBe("1.12345678");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("timestamps evidence at GET start so a delayed older response remains older", async () => {
    fetcher.mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 15)); return response(); });
    const value = await readGatewaySharedWalletSource();
    expect(Date.parse(value.source.capturedAt)).toBeLessThan(Date.now() - 10);
  });
});
describe("exact money and request-cost lexemes", () => {
  it.each(['{"isValid":true,"mode":"unrestricted","unit":"USD","balance":0,"remaining":0}', '{"isValid":true,"mode":"unrestricted","unit":"USD","balance":9007199254740993.12345678,"remaining":9007199254740993.12345678}'])("USD survives exactly: %s", raw => { expect(parseSharedWalletUsage(raw).balanceUsd).toBe(raw.includes("9007") ? "9007199254740993.12345678" : "0"); });
  it.each([body.replace('"remaining":1.12345678', '"remaining":1'), body.replace("1.12345678", "1.123456789"), body.replace('"mode":"unrestricted"', '"mode":"quota_limited"'), body.replace('"isValid":true', '"isValid":false'), body.replace('"balance":1.12345678', '"balance":1,"balance":1.12345678')])("changed or ambiguous wallet cannot be adopted", raw => expect(() => parseSharedWalletUsage(raw)).toThrow());
  it("exact actual_cost number token is returned without converting to floating point", () => { expect(parseExactSharedUpstreamCost('{"usage":{"actual_cost":0.12345678}}')).toEqual({ usdCostLexical: "0.12345678", upstreamCostField: "usage.actual_cost" }); });
  it.each(['{"usage":{"cost":1}}', '{"usage":{"actual_cost":0.123456789}}', '{"actual_cost":1,"usage":{"actual_cost":2}}', '{"actual_cost":1,"actual_cost":2}', '{"actual_cost":"1"}'])("unknown/rounded cost does not settle: %s", raw => expect(parseExactSharedUpstreamCost(raw)).toBeNull());
});
