import * as React from "react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { isCreditPoolManagementOverview } from "@/lib/model-gateway/credit-pool-management-contract";
import * as contract from "@/lib/model-gateway/credit-pool-management-contract";
import * as observationContract from "@/lib/model-gateway/credit-pool-observation-contract";
import type { CreditPoolManagementOverview } from "@/lib/model-gateway/credit-pool-management-contract";
const state = { cursor: 0, values: new Map<number, unknown>(), effect: null as null | (() => unknown), mounted: false };
const dependency = createRequire(import.meta.url);
const connectionComponent = { exports: {} as typeof import("./CreditPoolConnectionPanel") };
new Function("require", "exports", ts.transpileModule(readFileSync(new URL("./CreditPoolConnectionPanel.tsx", import.meta.url), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText)((id: string) => {
  if (id === "react") return { ...React, useState: (initial: unknown) => { const key = state.cursor++; if (!state.values.has(key)) state.values.set(key, initial); return [state.values.get(key), (next: unknown) => state.values.set(key, next)]; },
    useRef: (initial: unknown) => { const key = state.cursor++; if (!state.values.has(key)) state.values.set(key, { current: initial }); return state.values.get(key); },
    useCallback: (fn: unknown) => fn, useEffect: (fn: () => unknown) => { if (!state.mounted) { state.effect = fn; state.mounted = true; } } };
  if (id === "@/lib/model-gateway/credit-pool-management-contract") return contract;
  // The panel validates relay observations with the real, pure observation contract.
  if (id === "@/lib/model-gateway/credit-pool-observation-contract") return observationContract;
  return dependency(id);
}, connectionComponent.exports);
const { CreditPoolConnectionPanel } = connectionComponent.exports;
const missing = (): CreditPoolManagementOverview => ({ pool: { state: "uninitialized", ready: false, balanceCents: null, revision: null, capacityCents: null, allocatedCents: null, consumedCents: null, deficitCents: null },
  source: { state: "unconfigured", snapshotId: null, snapshotHash: null, identityHash: null, groupId: null, nativeUnit: null, rawRemaining: null, observedAt: null, expiresAt: null, readAvailable: false, blockers: [{ code: "SOURCE_READ_NOT_CONNECTED", message: "未接通上游少壮专属分组额度读取" }] },
  liabilities: { walletTotalCents: "2008", heldSubsetCents: "800", awaitingAllocationCents: "1000", awaitingOrders: 1 }, observedAt: new Date().toISOString() });
const fetcher = vi.fn();
const storage = new Map<string, string>();
const storageSet = vi.fn((key: string, value: string) => storage.set(key, value));
const event = vi.fn();
let currentTree: React.ReactElement;
function render(initialOverview?: CreditPoolManagementOverview) { state.cursor = 0; return renderToStaticMarkup(CreditPoolConnectionPanel({ initialOverview })); }
function interactive(initialOverview?: CreditPoolManagementOverview) { state.cursor = 0; currentTree = CreditPoolConnectionPanel({ initialOverview, adminId: "admin-fixture" }); return renderToStaticMarkup(currentTree); }
// Search from the current tree only; an undefined child must stop the search
// rather than re-entering the default root.
function findButton(label: string): { onClick: () => unknown; disabled: boolean } | undefined { return findButtonIn(label, currentTree); }
function findButtonIn(label: string, node: React.ReactNode): { onClick: () => unknown; disabled: boolean } | undefined {
  if (Array.isArray(node)) return node.map(child => findButtonIn(label, child)).find(Boolean);
  if (!React.isValidElement(node)) return;
  const props = node.props as { children?: React.ReactNode; onClick: () => unknown; disabled: boolean };
  if (node.type === "button" && props.children === label) return props;
  return findButtonIn(label, props.children);
}
async function click(label: string) { const button = findButton(label); expect(button, label).toBeTruthy(); expect(button!.disabled, label).toBeFalsy(); button!.onClick(); await new Promise<void>(resolve => setImmediate(resolve)); return interactive(); }
const key = "123e4567-e89b-42d3-a456-426614174000", hash = "a".repeat(64);
const SOURCE_KEY = "sanjie-pool-verification-v1:admin-fixture";
// Sequential request keys: a retry that regenerates its key is visible as a second key.
const uuids = [key, "223e4567-e89b-42d3-a456-426614174001", "323e4567-e89b-42d3-a456-426614174002"];
let uuidIndex = 0;
const uuid = vi.fn(() => uuids[Math.min(uuidIndex++, uuids.length - 1)]);
const observation = (ledger = connected()) => { const at = new Date().toISOString(); return { observedAt: at, readOnly: true,
  wallet: { status: "ok", balanceUsd: "2.5", remainingUsd: "2.5", observedAt: at, unit: "USD", scope: "sub2api_internal_user_wallet", code: null },
  ledger: { status: "ok", overview: ledger, code: null }, supply: { status: "not_configured", observedAt: null, groups: [], code: "SUPPLY_NOT_CONFIGURED", referenceOnly: true } }; };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const posts = () => fetcher.mock.calls.filter(call => call[1].method === "POST");
function interactiveAs(adminId: string, initialOverview?: CreditPoolManagementOverview) { state.cursor = 0; currentTree = CreditPoolConnectionPanel({ initialOverview, adminId }); return renderToStaticMarkup(currentTree); }
function remount() { state.cursor = 0; state.values.clear(); state.effect = null; state.mounted = false; }
const proposal = () => ({ id: "proposal-1", operation: "adoption", version: 1, snapshotId: "source-1", snapshotHash: hash, identityHash: hash, conversionPolicyHash: hash, walletStateHash: hash,
  capacityCents: "4000", walletTotalCents: "2008", consumedCents: "0", heldSubsetCents: "800", allocatableCents: "1992", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), state: "reviewable", requiresServerRevalidation: true, blockers: [], receipt: null });
const connected = () => { const value = missing(); value.source = { ...value.source, readAvailable: true, scope: "shared_user_lifetime_wallet", externalCommitmentsState: "unobservable", state: "recorded", nativeUnit: "USD", rawRemaining: "1.12345678", candidateSnapshot: { snapshotId: "source-1", snapshotHash: hash } }; return value; };
async function mount(body: unknown, ok = true) { fetcher.mockResolvedValue({ ok, json: async () => body }); render(); state.effect?.(); await new Promise<void>(resolve => setImmediate(resolve)); return render(); }
beforeEach(() => { state.cursor = 0; state.values.clear(); state.effect = null; state.mounted = false; storage.clear(); vi.clearAllMocks(); fetcher.mockReset(); vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("window", { sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: storageSet, removeItem: (key: string) => storage.delete(key) }, dispatchEvent: event }); uuidIndex = 0; vi.stubGlobal("crypto", { randomUUID: uuid }); });
afterEach(() => vi.unstubAllGlobals());
describe("source connection diagnostic UI without financial controls", () => {
  it("describes an expired adopted shared source as a submission-time recheck, without claiming available credits or making POSTs", () => {
    const value = connected(); value.pool = { ...value.pool, state: "pending", ready: false, accountingVersion: 1,
      revision: 2, capacityCents: "2008", allocatedCents: "2008", consumedCents: "0", deficitCents: "0" };
    value.source = { ...value.source, state: "stale", candidateSnapshot: undefined };
    expect(isCreditPoolManagementOverview(value)).toBe(true);
    const html = render(value); expect(html).toContain("来源记录已过期，赠送时将重新核对");
    expect(html).toContain("可赠送积分：待核对"); expect(html).not.toContain("总积分池已有核验余额");
    expect(fetcher).not.toHaveBeenCalled();
    value.pool.deficitCents = "1";
    expect(render(value)).toContain("当前不能赠送积分");
  });
  it("shows the expected group and concise missing connection reasons; no fake zero or approval", () => { const html = render(missing()); expect(html).toContain("预期来源：少壮专属分组"); expect(html).toContain("未接通上游额度读取"); expect(html).toContain("原生额度与本站积分尚未核对"); expect(html).toContain("可赠送积分：待核对"); expect(html).toContain("钱包积分：200.8"); expect(html).toContain("其中冻结：80"); expect(html).toContain("冻结已包含在钱包余额中"); expect(html).not.toContain("初始化总池"); expect(html).not.toContain("60618"); expect(html).not.toContain("20010");
    // The relay balance layer is labelled in USD but, unread, shows no amount.
    const relay = html.match(/<div class="panel" aria-label="中转站内部用户余额">([\s\S]*?)<\/div>/)?.[1] ?? "";
    const relayText = relay.replace(/<[^>]+>/g, "");
    expect(relayText).toContain("账面余额：尚未读取"); expect(relayText).toContain("读取时间：尚无读取时间"); expect(relayText).not.toMatch(/\d/);
    expect(html).not.toMatch(/\d[\d.,]*\s*USD|USD\s*\$?\s*\d/); expect(html).not.toContain("1.12345678"); });
  it("loads only the management GET without provider/financial request fields", async () => { const html = await mount({ data: missing() }); expect(html).toContain("少壮专属分组"); expect(html).toContain("当前不能赠送积分"); expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][0]).toBe("/api/management/credit-pool"); expect(fetcher.mock.calls[0][1]).not.toHaveProperty("method"); expect(fetcher.mock.calls[0][1]).not.toHaveProperty("body"); });
  it("read failure is an error and never presented as a missing-source response", async () => { const html = await mount({ error: "raw supplier secret" }, false); expect(html).toContain("连接状态读取失败"); expect(html).not.toContain("当前不能赠送积分"); expect(html).not.toContain("raw supplier secret"); });
  it("malformed/inconsistent response is rejected instead of displaying ready", async () => { const bad = missing(); bad.pool.state = "ready"; const html = await mount({ data: bad }); expect(html).toContain("连接状态读取失败"); expect(html).not.toContain("已有核验余额"); });
  it("does not put proof hashes in product UI", () => { const view = missing(); view.source.snapshotHash = "a".repeat(64); view.source.identityHash = "b".repeat(64); const html = render(view); expect(html).not.toContain("a".repeat(64)); expect(html).not.toContain("b".repeat(64)); });
  it.each(["blocked_source", "missing_capacity", "missing_deficit", "bad_conservation", "held_exceeds_wallet", "allocated_mismatch"])("ready display rejects %s rather than trusting its ready flag", problem => {
    const view = missing(); view.pool = { state: "ready", ready: true, balanceCents: 1992, revision: 1, capacityCents: "4000", allocatedCents: "2008", consumedCents: "0", deficitCents: "0" };
    view.source = { ...view.source, state: "ready", snapshotId: "source-1", snapshotHash: "a".repeat(64), identityHash: "b".repeat(64), nativeUnit: "USD" };
    expect(isCreditPoolManagementOverview(view)).toBe(true);
    if (problem === "blocked_source") view.source.state = "blocked";
    if (problem === "missing_capacity") view.pool.capacityCents = null;
    if (problem === "missing_deficit") view.pool.deficitCents = null;
    if (problem === "bad_conservation") view.pool.capacityCents = "4001";
    if (problem === "held_exceeds_wallet") view.liabilities.heldSubsetCents = "2009";
    if (problem === "allocated_mismatch") view.liabilities.walletTotalCents = "2009";
    expect(isCreditPoolManagementOverview(view)).toBe(false);
  });
  it("unknown/source state object cannot masquerade as ready through string conversion", () => { const view = missing(); expect(isCreditPoolManagementOverview({ ...view, pool: { ...view.pool, state: { toString: () => "ready" } } })).toBe(false); });
  it("connected shared source displays exact posted USD and conservative unposted-consumption coverage", () => { const html = interactive(connected()); expect(html).toContain("1.12345678 USD"); expect(html).toContain("其他共用密钥"); expect(html).toContain("不加回可分配额度"); expect(html).toContain("外部尚未入账请求无法观测"); expect(html).not.toContain("预算"); });
  it("catalog consumption displays local points and an unknown upstream cost, with no zero USD or inferred add-back", () => {
    const view = connected(); view.source.costCoverage = "local_catalog_or_actual_usd"; view.pool.consumedCents = "125";
    const html = interactive(view); expect(html).toContain("本站已计价消费：12.5 积分");
    expect(html).toContain("本次已核验的计价依据和真实用量"); expect(html).toContain("未核验的上游费用待核实");
    expect(html).toContain("不加回可分配额度"); expect(html).not.toMatch(/费用[：:]\s*0|0\.00000000 USD/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("old source response without a cost policy remains compatible and never claims catalog permission", () => {
    const view = connected(); expect(isCreditPoolManagementOverview(view)).toBe(true);
    expect(interactive(view)).not.toContain("本次已核验的计价依据和真实用量");
  });
  it.each(["catalog", "guessed_usd", { toString: () => "local_catalog_or_actual_usd" }])("unsupported display policy %j cannot be accepted", costCoverage => {
    const view = connected(); view.source.costCoverage = costCoverage as never; expect(isCreditPoolManagementOverview(view)).toBe(false);
  });
  it("explicit unknown pricing on a ready shared source cannot enable the display", () => {
    const view = connected(); view.pool = { state: "ready", ready: true, balanceCents: 1992, revision: 1, capacityCents: "4000", allocatedCents: "2008", consumedCents: "0", deficitCents: "0" };
    view.source = { ...view.source, state: "ready", snapshotId: "source-1", snapshotHash: hash, identityHash: hash, costCoverage: null };
    expect(isCreditPoolManagementOverview(view)).toBe(false);
  });
  it("source reads send only the saved request key, then prepare contains only original immutable refs", async () => {
    interactive(connected()); fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ data: connected() }) }); await click("核验分配额度");
    expect(fetcher.mock.calls[0]).toMatchObject(["/api/management/credit-pool/source", { method: "POST" }]);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ requestKey: key });
    // The verification key is saved before the POST and released only by its confirmed receipt.
    expect(storageSet).toHaveBeenCalledOnce(); expect(storageSet).toHaveBeenCalledWith(SOURCE_KEY, JSON.stringify({ requestKey: key }));
    expect(storageSet.mock.invocationCallOrder[0]).toBeLessThan(fetcher.mock.invocationCallOrder[0]);
    expect(storage.has(SOURCE_KEY)).toBe(false); expect(event).toHaveBeenCalledOnce(); expect(uuid).toHaveBeenCalledOnce();
    fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ data: proposal() }) }); const html = await click("审阅采用方案");
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ operation: "adoption", snapshotId: "source-1", snapshotHash: hash }); expect(html).toContain("现有钱包（含冻结）只采用一次"); expect(html).toContain("确认采用此方案");
  });
  it.each([
    ["FX_RATE_STALE", "后台汇率快照已过期"], ["FX_RATE_UNAVAILABLE", "后台汇率快照尚未就绪"],
    ["SHARED_SOURCE_NOT_CONFIGURED", "共用钱包额度读取尚未配置"], ["CREDIT_POOL_INVALID", "总积分池账本或来源状态异常"],
    ["SOURCE_TIMEOUT", "上游余额读取超时"], ["SOURCE_TRANSPORT_FAILED", "上游余额连接暂时中断"],
    ["SOURCE_UNAVAILABLE", "上游余额服务暂时不可用"], ["SOURCE_RATE_LIMITED", "上游余额读取暂时受到限流"],
    ["RATE_LIMITED", "来源核对请求暂时受到限流"], ["SOURCE_AUTH_REQUIRED", "上游来源连接鉴权已失效"],
    ["AUTH_REQUIRED", "管理员登录已失效"], ["SOURCE_ACCESS_DENIED", "上游来源连接没有读取权限"],
    ["SOURCE_BALANCE_INCONSISTENT", "资金覆盖尚未完成核验"], ["POOL_QUOTE_UNBACKED", "当前报价未满足资金覆盖保护条件"]
  ])("source POST %s keeps its safe admin reason and uncertain operation state without replay", async (code, reason) => {
    interactive(connected()); fetcher.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ code, error: "private-api-key-raw-provider-message" }) });
    const html = await click("核验分配额度");
    expect(html).toContain(reason); expect(html).toContain(`data-error-code="${code}"`); expect(html).toContain('data-operation-state="uncertain"');
    expect(html).toContain("来源快照或总池状态可能已更新"); expect(html).toContain("可查看当前状态，并重试原核验请求");
    expect(html).toContain(`原核验请求已保留：${key}`);
    expect(html).not.toContain("private-api-key");
    // The verification result never claims a definite outcome. The only "未更新" on the page is
    // the relay balance layer's freshness label, since no display observation has run.
    const verification = html.slice(html.indexOf("<h3>分配额度核验</h3>")); expect(verification.length).toBeLessThan(html.length);
    expect(verification).not.toMatch(/本次(?:没有|未|不能)采用|未更新|请重试/);
    expect(html.match(/未更新/g)).toEqual(["未更新"]); expect(html).toContain("<h3>中转站内部用户 USD 余额</h3><p>历史读值（本次未更新）：");
    expect(html).not.toMatch(/本次(?:没有|未|不能)采用|请重试/);
    expect(findButton("核验分配额度")!.disabled).toBe(true); expect(findButton("审阅采用方案")!.disabled).toBe(true);
    expect(findButton("重试原核验")!.disabled).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce(); expect(event).not.toHaveBeenCalled();
    // Only the verification key was saved (before the POST) and it is retained.
    expect(storageSet).toHaveBeenCalledOnce(); expect(storage.get(SOURCE_KEY)).toBe(JSON.stringify({ requestKey: key }));
  });
  it.each(["post_commit_503", "network_loss", "invalid_json", "invalid_overview"])("source POST %s cannot claim rollback or enable a new adoption from the old view", async branch => {
    interactive(connected());
    if (branch === "network_loss") fetcher.mockRejectedValueOnce(new Error("private-network-error"));
    else if (branch === "invalid_json") fetcher.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error("private-json-error"); } });
    else fetcher.mockResolvedValueOnce({ ok: branch === "invalid_overview", status: branch === "invalid_overview" ? 200 : 503, json: async () => branch === "invalid_overview" ? { data: {} } : { code: "CREDIT_POOL_SERVICE_UNAVAILABLE", error: "private-api-key" } });
    const html = await click("核验分配额度"); expect(html).toContain("读取结果尚未确认"); expect(html).not.toContain("private-");
    expect(findButton("核验分配额度")!.disabled).toBe(true); expect(findButton("审阅采用方案")!.disabled).toBe(true);
    expect(fetcher.mock.calls.filter(call => call[1].method === "POST")).toHaveLength(1);
    expect(storageSet).toHaveBeenCalledOnce(); expect(storage.get(SOURCE_KEY)).toBe(JSON.stringify({ requestKey: key }));
    // A status GET cannot acknowledge the unknown write: the key and locks remain.
    fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ data: connected() }) });
    const refreshed = await click("刷新连接状态"); expect(refreshed).toContain("读取结果尚未确认"); expect(refreshed).toContain(`原核验请求已保留：${key}`);
    expect(findButton("核验分配额度")!.disabled).toBe(true); expect(findButton("审阅采用方案")!.disabled).toBe(true);
    expect(fetcher.mock.calls[1][1].method).toBeUndefined(); expect(fetcher.mock.calls.filter(call => call[1].method === "POST")).toHaveLength(1);
    expect(storage.get(SOURCE_KEY)).toBe(JSON.stringify({ requestKey: key })); expect(event).not.toHaveBeenCalled();
    // Only the original request's confirmed receipt releases it, with the same key.
    fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ data: connected() }) });
    const released = await click("重试原核验"); expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ requestKey: key });
    expect(released).not.toContain("读取结果尚未确认"); expect(storage.has(SOURCE_KEY)).toBe(false); expect(event).toHaveBeenCalledOnce();
    expect(findButton("核验分配额度")!.disabled).toBe(false); expect(findButton("审阅采用方案")!.disabled).toBe(false);
    expect(fetcher.mock.calls.filter(call => call[1].method === "POST")).toHaveLength(2);
    // Initial POST, status GET and the same-key retry generated exactly one key.
    expect(uuid).toHaveBeenCalledOnce(); expect(posts().map(call => JSON.parse(call[1].body))).toEqual([{ requestKey: key }, { requestKey: key }]);
  });
  it("a GET started before a source POST cannot resolve its unknown write result", async () => {
    interactive(connected()); let finishOldGet: ((value: unknown) => void) | undefined; const read = findButton("核验分配额度")!, refreshStatus = findButton("刷新连接状态")!;
    fetcher.mockReturnValueOnce(new Promise(resolve => { finishOldGet = resolve; })); refreshStatus.onClick();
    fetcher.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ code: "CREDIT_POOL_SERVICE_UNAVAILABLE" }) }); read.onClick(); await new Promise<void>(resolve => setImmediate(resolve));
    finishOldGet?.({ ok: true, json: async () => ({ data: connected() }) }); await new Promise<void>(resolve => setImmediate(resolve));
    const html = interactive(); expect(html).toContain("读取结果尚未确认"); expect(findButton("核验分配额度")!.disabled).toBe(true);
    expect(findButton("审阅采用方案")!.disabled).toBe(true); expect(fetcher.mock.calls.filter(call => call[1].method === "POST")).toHaveLength(1);
  });
  it("double clicking source read sends only one mutation and never an adoption", async () => {
    interactive(connected()); fetcher.mockRejectedValueOnce(new Error("network lost")); const read = findButton("核验分配额度")!;
    read.onClick(); read.onClick(); await new Promise<void>(resolve => setImmediate(resolve)); interactive();
    expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][0]).toBe("/api/management/credit-pool/source");
    expect(findButton("审阅采用方案")!.disabled).toBe(true);
  });
  it("uncertain apply saves before POST, blocks new plans, and retries the same key without a new budget", async () => {
    interactive(connected()); fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ data: proposal() }) }); await click("审阅采用方案"); fetcher.mockRejectedValueOnce(new Error("network failed private"));
    const confirm = findButton("确认采用此方案")!; confirm.onClick(); confirm.onClick(); await new Promise<void>(resolve => setImmediate(resolve)); let html = interactive();
    expect(fetcher.mock.calls.filter(call => call[0].endsWith("/initialize"))).toHaveLength(1); expect(storageSet.mock.invocationCallOrder[0]).toBeLessThan(fetcher.mock.invocationCallOrder[1]); expect(html).toContain("结果尚未确认"); expect(html).not.toContain("network failed private"); expect(findButton("审阅采用方案")!.disabled).toBe(true);
    const original = fetcher.mock.calls[1][1].body; fetcher.mockRejectedValueOnce(new Error("still unavailable")); html = await click("重试原请求"); expect(fetcher.mock.calls[2][1].body).toBe(original); expect(JSON.parse(original)).toEqual({ proposalId: "proposal-1", version: 1, snapshotHash: hash, requestKey: key }); expect(html).toContain("原请求标识已保留");
  });
  it("recovering committed original operation sends no financial POST and refreshes gift status", async () => {
    storage.set("sanjie-pool-operation-v1:admin-fixture", JSON.stringify({ operation: "adoption", input: { proposalId: "proposal-1", version: 1, snapshotHash: hash, requestKey: key } }));
    fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ data: connected() }) }); interactive(); state.effect?.(); await new Promise<void>(resolve => setImmediate(resolve)); interactive();
    fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { state: "committed", requestKey: key, receipt: { operation: "adoption", proposalId: "proposal-1", requestKey: key, eventId: `adoption:${key}`, createdAt: new Date().toISOString(), capacityCents: "4000", allocatedAfterCents: "2008", consumedAfterCents: "0", allocatableAfterCents: "1992", deficitAfterCents: "0" } } }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ data: connected() }) }); const html = await click("核对原操作");
    expect(fetcher.mock.calls[1][0]).toBe(`/api/management/credit-pool/operations/${key}?operation=adoption`); expect(fetcher.mock.calls.every(call => call[1].method !== "POST")).toBe(true); expect(event).toHaveBeenCalledOnce(); expect(storage.size).toBe(0); expect(html).not.toContain("上一笔采用需要核对");
  });
  it("unreadable saved operation cannot be cleared by a successful status GET", async () => { storage.set("sanjie-pool-operation-v1:admin-fixture", "invalid"); fetcher.mockResolvedValue({ ok: true, json: async () => ({ data: connected() }) }); interactive(); state.effect?.(); await new Promise<void>(resolve => setImmediate(resolve)); const html = interactive(); expect(html).toContain("原操作记录无法读取"); expect(findButton("核验分配额度")!.disabled).toBe(true); expect(findButton("审阅采用方案")!.disabled).toBe(true); });
  it("definite first 409 rejection releases an uncommitted plan but keeps user balances", async () => { interactive(connected()); fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ data: proposal() }) }); await click("审阅采用方案"); fetcher.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ code: "POOL_PROPOSAL_STALE" }) }); const html = await click("确认采用此方案"); expect(storage.size).toBe(0); expect(html).toContain("本次方案未采用"); expect(findButton("核验分配额度")!.disabled).toBe(false); });
  it("malformed committed recovery cannot erase original operation", async () => { storage.set("sanjie-pool-operation-v1:admin-fixture", JSON.stringify({ operation: "adoption", input: { proposalId: "proposal-1", version: 1, snapshotHash: hash, requestKey: key } })); fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ data: connected() }) }); interactive(); state.effect?.(); await new Promise<void>(resolve => setImmediate(resolve)); interactive(); fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { state: "committed", requestKey: key, receipt: {} } }) }); const html = await click("核对原操作"); expect(storage.size).toBe(1); expect(event).not.toHaveBeenCalled(); expect(html).toContain("原请求标识已保留"); });
  it("a verification key that cannot be saved sends no source POST", async () => {
    interactive(connected()); storageSet.mockImplementationOnce(() => { throw new Error("quota exceeded"); });
    const html = await click("核验分配额度");
    expect(fetcher).not.toHaveBeenCalled(); expect(storage.has(SOURCE_KEY)).toBe(false); expect(event).not.toHaveBeenCalled();
    expect(html).toContain("无法保存原核验请求，本次未提交"); expect(html).not.toContain("quota exceeded");
    expect(findButton("核验分配额度")!.disabled).toBe(true); expect(findButton("审阅采用方案")!.disabled).toBe(true);
    expect(findButton("查看余额与对账状态")!.disabled).toBe(false);
  });
  it("display observation during a pending source verification cannot release its key, unlock adoption or emit pool updates", async () => {
    interactive(connected()); let finishPost: ((value: unknown) => void) | undefined;
    fetcher.mockReturnValueOnce(new Promise(resolve => { finishPost = resolve; })); findButton("核验分配额度")!.onClick(); await settle();
    fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ data: observation() }) });
    let html = await click("查看余额与对账状态");
    expect(fetcher.mock.calls[1]).toMatchObject(["/api/management/credit-pool/observe", { method: "GET" }]); expect(html).toContain("2.5");
    expect(storage.get(SOURCE_KEY)).toBe(JSON.stringify({ requestKey: key })); expect(event).not.toHaveBeenCalled();
    expect(findButton("核验分配额度")!.disabled).toBe(true); expect(findButton("审阅采用方案")!.disabled).toBe(true);
    finishPost?.({ ok: false, status: 503, json: async () => ({ code: "CREDIT_POOL_SERVICE_UNAVAILABLE" }) }); await settle();
    html = interactive(); expect(html).toContain("读取结果尚未确认");
    fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ data: observation() }) });
    html = await click("查看余额与对账状态");
    expect(html).toContain("读取结果尚未确认"); expect(html).toContain(`原核验请求已保留：${key}`);
    expect(storage.get(SOURCE_KEY)).toBe(JSON.stringify({ requestKey: key })); expect(event).not.toHaveBeenCalled();
    expect(findButton("核验分配额度")!.disabled).toBe(true); expect(findButton("审阅采用方案")!.disabled).toBe(true);
    expect(posts().map(call => call[0])).toEqual(["/api/management/credit-pool/source"]);
    expect(fetcher.mock.calls.filter(call => call[1].method === "GET").map(call => call[0])).toEqual(["/api/management/credit-pool/observe", "/api/management/credit-pool/observe"]);
    expect(uuid).toHaveBeenCalledOnce();
  });
  it("a saved verification key never crosses two administrator identities", async () => {
    const fixtureSaved = uuids[2], otherKey = "sanjie-pool-verification-v1:admin-other";
    storage.set(SOURCE_KEY, JSON.stringify({ requestKey: fixtureSaved }));
    fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ data: connected() }) });
    interactiveAs("admin-other"); state.effect?.(); await settle(); let html = interactiveAs("admin-other");
    expect(html).not.toContain(fixtureSaved); expect(html).not.toContain("原核验请求已保留");
    expect(findButton("核验分配额度")!.disabled).toBe(false);
    fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ data: connected() }) });
    findButton("核验分配额度")!.onClick(); await settle(); html = interactiveAs("admin-other");
    expect(JSON.parse(posts()[0][1].body)).toEqual({ requestKey: key });
    expect(storageSet).toHaveBeenCalledWith(otherKey, JSON.stringify({ requestKey: key })); expect(storage.has(otherKey)).toBe(false);
    expect(storage.get(SOURCE_KEY)).toBe(JSON.stringify({ requestKey: fixtureSaved }));
    remount(); fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ data: connected() }) });
    interactive(); state.effect?.(); await settle(); html = interactive();
    expect(html).toContain(`原核验请求已保留：${fixtureSaved}`); expect(findButton("核验分配额度")!.disabled).toBe(true);
    expect(findButton("审阅采用方案")!.disabled).toBe(true); expect(posts()).toHaveLength(1);
  });
  it("double clicking the original-key retry while it is pending sends exactly one more POST", async () => {
    interactive(connected()); fetcher.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ code: "CREDIT_POOL_SERVICE_UNAVAILABLE" }) });
    await click("核验分配额度"); let finishRetry: ((value: unknown) => void) | undefined;
    fetcher.mockReturnValueOnce(new Promise(resolve => { finishRetry = resolve; }));
    const retry = findButton("重试原核验")!; retry.onClick(); retry.onClick(); await settle();
    expect(posts()).toHaveLength(2); interactive(); expect(findButton("重试原核验")!.disabled).toBe(true);
    finishRetry?.({ ok: true, json: async () => ({ data: connected() }) }); await settle(); const html = interactive();
    expect(posts()).toHaveLength(2); expect(posts().map(call => JSON.parse(call[1].body))).toEqual([{ requestKey: key }, { requestKey: key }]);
    expect(uuid).toHaveBeenCalledOnce(); expect(storage.has(SOURCE_KEY)).toBe(false); expect(event).toHaveBeenCalledOnce();
    expect(html).not.toContain("读取结果尚未确认"); expect(findButton("审阅采用方案")!.disabled).toBe(false);
  });
});
