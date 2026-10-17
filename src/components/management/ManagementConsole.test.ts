import * as React from "react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DMP_AUTOMATION_NAME } from "@/lib/dmp-product";
import type { InviteCode } from "@/lib/types/domain";

const state = {
  cursor: 0,
  values: new Map<number, unknown>(),
  pending: { current: false }
};

// Next keeps JSX for its own compiler. Compile this component in memory so the
// production Vitest config and application compiler remain unchanged.
const requireDependency = createRequire(import.meta.url);
const componentModule = { exports: {} as { ManagementConsole: typeof import("./ManagementConsole")["ManagementConsole"] } };
const source = readFileSync(new URL("./ManagementConsole.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText;
new Function("require", "exports", compiled)((id: string) => {
  if (id === "react") return {
    ...React,
    useState: (initial: unknown) => {
      const index = state.cursor++;
      if (!state.values.has(index)) state.values.set(index, initial);
      return [state.values.get(index), (next: unknown) => {
        state.values.set(index, typeof next === "function" ? next(state.values.get(index)) : next);
      }];
    },
    useMemo: (compute: () => unknown) => compute(),
    useRef: () => state.pending
  };
  if (id === "@/lib/dmp-product") return { DMP_AUTOMATION_NAME };
  if (id === "@/components/AiApiConfigPanel") return {
    AiApiConfigPanel: () => React.createElement("div", null, "AI API 配置面板")
  };
  if (id === "@/components/management/DmpShareAnalyticsPanel") return {
    DmpShareAnalyticsPanel: () => React.createElement("div", null, "传播分析面板")
  };
  if (id === "@/components/model-gateway/GatewayBillingPanel") return {
    GatewayBillingPanel: () => React.createElement("div", null, "积分账本面板")
  };
  if (id === "@/components/management/CreditGiftPanel") return {
    CreditGiftPanel: ({ initialUserId, adminId }: { initialUserId?: string; adminId: string }) => React.createElement("div", null, `赠送积分面板 ${initialUserId || "未选账号"} ${adminId}`)
  };
  return requireDependency(id);
}, componentModule.exports);
const { ManagementConsole } = componentModule.exports;

const billingContractModule = { exports: {} as Record<string, unknown> };
const billingContractSource = readFileSync(new URL("../../lib/model-gateway/billing-contract.ts", import.meta.url), "utf8");
new Function("exports", ts.transpileModule(billingContractSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText)(billingContractModule.exports);
const billingPanelModule = { exports: {} as Pick<typeof import("../model-gateway/GatewayBillingPanel"), "parseGatewayBillingMultiplier" | "escapeGatewayBillingCsvCell" | "gatewayBillingStatusText" | "gatewayBillingTokenCount"> };
const billingPanelSource = readFileSync(new URL("../model-gateway/GatewayBillingPanel.tsx", import.meta.url), "utf8");
new Function("require", "exports", ts.transpileModule(billingPanelSource, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText)((id: string) => {
  if (id === "@/lib/model-gateway/billing-contract") return billingContractModule.exports;
  if (id.endsWith(".module.css")) return {};
  return requireDependency(id);
}, billingPanelModule.exports);

type ConsoleProps = Parameters<typeof ManagementConsole>[0];
type ManagedRegistrationUser = ConsoleProps["initialUsers"][number];
type Element = React.ReactElement<Record<string, unknown>>;

const noAccess = { allowed: false, status: "not_granted" as const, grantedAt: null, expiresAt: null, remainingDays: 0 };

function user(overrides: Partial<ManagedRegistrationUser> = {}): ManagedRegistrationUser {
  return {
    id: "user-self", tenantId: "tenant-independent-123", name: "客户甲", username: "13800000001",
    email: "13800000001@local", role: "owner", authRole: "tenant", shopName: "独立店铺",
    status: "active", createdAt: "2026-10-01T08:00:00.000Z", lastActiveAt: "2026-10-01T08:00:00.000Z",
    registrationSource: "self", registrationSourceRecordedAt: "2026-10-01T08:00:00.000Z", inviteCodeId: null,
    creativeStudioAccess: { ...noAccess },
    creativeAccess: { allowed: false, reason: "payment_required", expiresAt: null },
    dmpAutomationAccess: { ...noAccess }, ...overrides
  };
}

function invite(overrides: Partial<InviteCode> = {}): InviteCode {
  return {
    id: "invite-1", tenantId: "tenant-admin", code: "WELCOME", registrationUrl: "/login?invite=WELCOME",
    maxUses: 3, usedCount: 1, note: "", createdAt: "2026-10-01T08:00:00.000Z", createdBy: "admin", ...overrides
  };
}

function render(tab: "users" | "invites" | "sharing" | "ai" | "billing" | "gifts" | null = "users", overrides: Partial<ConsoleProps> = {}) {
  if (tab !== null) state.values.set(0, tab);
  state.cursor = 0;
  return ManagementConsole({
    currentUser: { id: "admin", tenantId: "tenant-admin", name: "管理员", email: "admin@local", role: "admin" },
    initialUsers: [user()], initialInvites: [invite()], ...overrides
  });
}

function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as React.ReactNode)];
}

function textContent(node: React.ReactNode): string {
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (React.isValidElement<Record<string, unknown>>(node)) return textContent(node.props.children as React.ReactNode);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}

function button(tree: React.ReactNode, label: string) {
  const found = elements(tree).find((element) => element.type === "button" && textContent(element) === label);
  if (!found) throw new Error(`缺少按钮：${label}`);
  return found;
}

async function click(element: Element) {
  await (element.props.onClick as () => Promise<void>)();
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  state.cursor = 0;
  state.values.clear();
  state.pending.current = false;
  vi.stubGlobal("React", React);
  vi.stubGlobal("window", {
    confirm: vi.fn(() => true), location: { origin: "https://shaozhuangai.com", replace: vi.fn() }
  });
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  vi.stubGlobal("fetch", vi.fn());
});

describe("registration management presentation", () => {
  it("starts with invitations, keeps remaining tabs and exposes payment verification", () => {
    const tree = render(null);
    const tabs = elements(tree).filter((element) =>
      element.type === "button" && String(element.props.className).split(" ").includes("management-tab")
    );
    expect(tabs.map(textContent)).toEqual(["邀请码", "用户列表", "传播分析", "AI API"]);
    expect(button(tree, "邀请码").props.className).toBe("management-tab active");
    expect(textContent(tree)).toContain("生成邀请码");
    expect(tabs.map(textContent)).not.toContain("经营复盘");
    expect(tabs.map(textContent)).not.toContain("历史数据");
    const markup = renderToStaticMarkup(tree);
    expect(markup).toContain('href="/management/payments"');
  });

  it("opens each remaining management panel from its tab", async () => {
    for (const [label, content] of [
      ["用户列表", "暂无账号"],
      ["传播分析", "传播分析面板"],
      ["AI API", "AI API 配置面板"],
      ["邀请码", "生成邀请码"]
    ]) {
      const tree = render(null, { initialUsers: [] });
      await click(button(tree, label));
      expect(renderToStaticMarkup(render(null, { initialUsers: [] }))).toContain(content);
    }
  });

  it("shows the billing tab only with explicit platform administrator permission", async () => {
    const granted = render(null, { canManageGatewayBilling: true });
    expect(button(granted, "积分账本")).toBeDefined();
    expect(button(granted, "邀请码").props.className).toBe("management-tab active");
    await click(button(granted, "积分账本"));
    expect(renderToStaticMarkup(render(null, { canManageGatewayBilling: true }))).toContain("积分账本面板");
    expect(renderToStaticMarkup(render("billing", { canManageGatewayBilling: false }))).not.toContain("积分账本");
    expect(renderToStaticMarkup(render("billing", { currentUser: { id: "owner", tenantId: "tenant", name: "店主", email: "owner@local", role: "owner" } }))).not.toContain("积分账本");
  });

  it("exposes gifting only to platform admins and opens an active account with the administrator storage scope", async () => {
    const denied = render("gifts", { canManageGatewayBilling: false });
    expect(renderToStaticMarkup(denied)).not.toContain("赠送积分");
    const granted = render("users", { canManageGatewayBilling: true, initialUsers: [user(), user({ id: "disabled", status: "disabled" }), user({ id: "pending", status: "pending" })] });
    const rows = elements(granted).filter((element) => element.type === "tr" && element.key);
    expect(textContent(rows[0])).toContain("赠送积分");
    expect(textContent(rows[1])).not.toContain("赠送积分");
    expect(textContent(rows[2])).not.toContain("赠送积分");
    await click(button(rows[0], "赠送积分"));
    expect(renderToStaticMarkup(render(null, { canManageGatewayBilling: true }))).toContain("赠送积分面板 user-self admin");
    const tabs = elements(render("invites", { canManageGatewayBilling: true })).filter((element) => element.type === "button" && String(element.props.className).split(" ").includes("management-tab"));
    expect(tabs.map(textContent)).toEqual(["邀请码", "用户列表", "传播分析", "AI API", "积分账本", "赠送积分"]);
    await click(button(render("invites", { canManageGatewayBilling: true }), "赠送积分"));
    expect(renderToStaticMarkup(render(null, { canManageGatewayBilling: true }))).toContain("赠送积分面板");
  });

  it("shows recorded sources and separates paid access, invitation grants and DMP", () => {
    const markup = renderToStaticMarkup(render("users", { initialInvites: [], initialUsers: [
      user({ creativeAccess: { allowed: true, reason: "paid", expiresAt: "2026-10-31T08:00:00.000Z" } }),
      user({ id: "invited", registrationSource: "invite", inviteCodeId: "revoked-invite-id", creativeStudioAccess: {
        ...noAccess, allowed: true, status: "active"
      }, creativeAccess: { allowed: true, reason: "invited", expiresAt: null } }),
      user({ id: "old", registrationSource: undefined, registrationSourceRecordedAt: null, inviteCodeId: "untrusted-id" })
    ] }));
    for (const label of ["工作区 ID", "tenant-independent-123", "自主注册", "邀请码注册", "旧账号待核对", "作图 / 视频访问", "充值可访问", "受邀可访问", "受邀工作台", "未授受邀权限", "达摩盘工具", "邀请码 ID：revoked-invite-id"])
      expect(markup).toContain(label);
    expect(markup).not.toContain("邀请码 ID：untrusted-id");
    expect(markup).toContain("2026-10-01 16:00:00");
  });

  it("manages tenant workspace owners while protecting platform administrators", () => {
    const tree = render("users", { initialUsers: [user(), user({ id: "admin-2", authRole: "admin" })] });
    const rows = elements(tree).filter((element) => element.type === "tr" && element.key);
    expect(textContent(rows[0])).toContain("客户 · 工作区所有者");
    expect(textContent(rows[0])).toContain("重置密码");
    expect(textContent(rows[0])).toContain("停用");
    expect(textContent(rows[1])).toContain("平台管理员");
    expect(textContent(rows[1])).not.toContain("重置密码");
    expect(textContent(rows[1])).not.toContain("确认受邀开通");
    expect(elements(tree).filter((element) => element.type === "button").map(textContent)).not.toContain("删除");
  });

  it("shows usable and exhausted codes, remaining uses and revocation", () => {
    const tree = render("invites", { initialInvites: [invite(), invite({ id: "used", code: "USED", usedCount: 3 })] });
    const rows = elements(tree).filter((element) => element.type === "tr" && element.key);
    expect(textContent(rows[0])).toContain("可用");
    expect(textContent(rows[0])).toContain("剩余 2 次");
    expect(textContent(rows[1])).toContain("用尽");
    expect(textContent(rows[1])).toContain("剩余 0 次");
    expect(button(rows[1], "复制注册链接").props.disabled).toBe(true);
    expect(textContent(rows[0])).toContain("撤销");
    expect(textContent(tree)).toContain("撤销邀请码不影响已注册账号及历史数据");
  });

  it("explains empty account and invite lists", () => {
    expect(renderToStaticMarkup(render("users", { initialUsers: [] }))).toContain("暂无账号");
    state.values.clear();
    expect(renderToStaticMarkup(render("invites", { initialInvites: [] }))).toContain("暂无邀请码");
  });
});

describe("billing management input and export boundaries", () => {
  it("parses exact multiplier basis points and rejects invalid precision or range", () => {
    const { parseGatewayBillingMultiplier: parse } = billingPanelModule.exports;
    expect(parse("0.8")).toBe(8000);
    expect(parse(" 1.0 ")).toBe(10000);
    expect(parse("0.3333")).toBe(3333);
    expect(parse("0.01")).toBe(100);
    expect(parse("100")).toBe(1000000);
    for (const invalid of ["", "0", "0.001", "100.0001", "1.00001", "1e2", "-1", "NaN", "Infinity"])
      expect(parse(invalid)).toBeNull();
  });

  it("escapes quoted CSV text and neutralizes spreadsheet formulas", () => {
    const { escapeGatewayBillingCsvCell: cell } = billingPanelModule.exports;
    expect(cell('姓名,"备注"')).toBe('"姓名,""备注"""');
    expect(cell("=HYPERLINK(\"https://example.com\")")).toBe('"\'=HYPERLINK(""https://example.com"")"');
    expect(cell("   @SUM(A1:A2)")).toBe('"\'   @SUM(A1:A2)"');
    expect(cell("\t=1+1")).toBe('"\'\t=1+1"');
    expect(cell(-0.7)).toBe('"-0.7"');
    expect(cell(null)).toBe('""');
  });

  it("presents gateway success and insufficient settlement status in Chinese", () => {
    const { gatewayBillingStatusText: status } = billingPanelModule.exports;
    expect(status("ok")).toBe("成功");
    expect(status("error")).toBe("失败");
    expect(status("settlement_rejected")).toBe("余额不足");
    expect(status("preflight_rejected")).toBe("提交前拒绝");
    expect(status("settlement_failed")).toBe("扣费结算失败");
    expect(status("")).toBe("—");
  });

  it("leaves omitted token fields unknown in the detail view and CSV", () => {
    const { gatewayBillingTokenCount: count } = billingPanelModule.exports;
    const partial = { promptTokens: 230, completionTokens: 0, totalTokens: 230,
      metadata: { tokenSource: "partial", reportedTokenFields: "prompt" } };
    expect(count(partial, "prompt")).toBe(230);
    expect(count(partial, "completion")).toBeNull();
    expect(count(partial, "total")).toBeNull();
    expect(count({ ...partial, metadata: { tokenSource: "unreported" } }, "prompt")).toBeNull();
    expect(count({ ...partial, metadata: {} }, "completion")).toBeNull();
    expect(count({ ...partial, metadata: { tokenSource: "estimated" } }, "total")).toBe(230);
  });
});

describe("management action recovery", () => {
  it("restores controls after a network failure and allows a successful retry", async () => {
    const tree = render("invites");
    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    await click(button(tree, "生成邀请码"));
    expect(state.values.get(5)).toBe(false);
    expect(state.values.get(6)).toContain("网络连接失败");
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { invite: invite({ id: "new" }) } }, 201));
    await click(button(tree, "生成邀请码"));
    expect((state.values.get(1) as InviteCode[])[0].id).toBe("new");
    expect(state.values.get(5)).toBe(false);
  });

  it("rejects invalid use counts before making a request", async () => {
    state.values.set(4, 0);
    await click(button(render("invites"), "生成邀请码"));
    expect(fetch).not.toHaveBeenCalled();
    expect(state.values.get(6)).toContain("1 到 99 的整数");
  });

  it("does not submit a second mutation while the first is pending", async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const action = button(render("invites"), "生成邀请码");
    const first = click(action);
    await click(action);
    expect(fetch).toHaveBeenCalledTimes(1);
    finish(jsonResponse({ data: { invite: invite({ id: "new" }) } }, 201));
    await first;
    expect(state.values.get(5)).toBe(false);
  });

  it("reports clipboard failure honestly after a password has been reset", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { password: "TemporaryPass123" } }));
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("clipboard denied"));
    await click(button(render(), "重置密码"));
    expect(state.values.get(6)).toContain("TemporaryPass123");
    expect(state.values.get(6)).toContain("复制失败，请手动复制");
    expect(state.values.get(6)).not.toContain("已复制到剪贴板");
    expect(state.values.get(5)).toBe(false);
  });

  it("reports actual clipboard success and offers a manual registration link if copying fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { password: "TemporaryPass123" } }));
    await click(button(render(), "重置密码"));
    expect(state.values.get(6)).toContain("已复制到剪贴板");
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("clipboard denied"));
    await click(button(render("invites"), "复制注册链接"));
    expect(state.values.get(6)).toContain("请手动复制注册链接：https://shaozhuangai.com/login?invite=WELCOME");
  });

  it("revokes a code without deleting or changing existing accounts", async () => {
    const tree = render("invites");
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { deleted: true } }));
    await click(button(tree, "撤销"));
    expect(fetch).toHaveBeenCalledWith("/api/invite-codes/invite-1", expect.objectContaining({ method: "DELETE" }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("已注册账号、工作区及历史数据保留"));
    expect(state.values.get(1)).toEqual([]);
    expect((state.values.get(2) as ManagedRegistrationUser[])[0].id).toBe("user-self");
  });

  it("requires confirmation for a legacy client grant and refreshes actual access without rewriting source", async () => {
    const legacy = user({ registrationSource: "legacy", registrationSourceRecordedAt: null });
    const granted = { ...legacy, creativeStudioAccess: { ...noAccess, allowed: true, status: "active" as const },
      creativeAccess: { allowed: true, reason: "invited" as const, expiresAt: null } };
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ data: { creativeAccess: { allowed: true, reason: "invited", expiresAt: null } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { users: [granted] } }));
    await click(button(render("users", { initialUsers: [legacy] }), "确认受邀开通"));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("请确认"));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("保留原注册来源"));
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/managed-users/user-self/creative-access", expect.objectContaining({ body: '{"enabled":true}' }));
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/managed-users", { cache: "no-store" });
    const updated = (state.values.get(2) as ManagedRegistrationUser[])[0];
    expect(updated.registrationSource).toBe("legacy");
    expect(updated.dmpAutomationAccess).toEqual(legacy.dmpAutomationAccess);
    expect(updated.creativeAccess?.reason).toBe("invited");
  });

  it("distinguishes a completed grant from a failed list refresh", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ data: { creativeAccess: { allowed: true } } }))
      .mockRejectedValueOnce(new Error("refresh offline"));
    await click(button(render(), "确认受邀开通"));
    expect(state.values.get(6)).toContain("开通已完成，列表刷新失败");
    expect(state.values.get(5)).toBe(false);
  });

  it("keeps paid access after an invitation grant is revoked", async () => {
    const paid = user({
      creativeStudioAccess: { ...noAccess, allowed: true, status: "active" },
      creativeAccess: { allowed: true, reason: "paid", expiresAt: "2026-10-31T08:00:00.000Z" }
    });
    const revoked = { ...paid, creativeStudioAccess: { ...noAccess, status: "revoked" as const } };
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ data: { creativeAccess: { allowed: false, reason: "payment_required" } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { users: [revoked] } }));
    await click(button(render("users", { initialUsers: [paid] }), "撤销受邀权限"));
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/managed-users/user-self/creative-access", expect.objectContaining({ body: '{"enabled":false}' }));
    const markup = renderToStaticMarkup(render());
    expect(markup).toContain("受邀已撤销");
    expect(markup).toContain("充值可访问");
    expect((state.values.get(2) as ManagedRegistrationUser[])[0].registrationSource).toBe("self");
  });

  it("recovers from a DMP network error without changing creative access or registration metadata", async () => {
    const initial = user();
    const dmpGranted = {
      allowed: true, status: "active" as const, remainingDays: 30,
      grantedAt: "2026-10-01T08:00:00.000Z", expiresAt: "2026-10-31T08:00:00.000Z"
    };
    const action = button(render("users", { initialUsers: [initial] }), "开通30天");
    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    await click(action);
    expect(state.values.get(5)).toBe(false);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ data: { dmpAutomationAccess: dmpGranted } }));
    await click(action);
    expect(fetch).toHaveBeenLastCalledWith("/api/managed-users/user-self/dmp-access", expect.objectContaining({ method: "PATCH", body: '{"enabled":true}' }));
    const updated = (state.values.get(2) as ManagedRegistrationUser[])[0];
    expect(updated.dmpAutomationAccess).toEqual(dmpGranted);
    expect(updated.creativeAccess).toEqual(initial.creativeAccess);
    expect(updated.creativeStudioAccess).toEqual(initial.creativeStudioAccess);
    expect(updated.registrationSource).toBe("self");
  });

  it("refreshes access after disabling an account while preserving history and grants", async () => {
    const disabled = user({ status: "disabled", creativeAccess: { allowed: false, reason: "invalid_account", expiresAt: null } });
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ data: { status: "disabled" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { users: [disabled] } }));
    await click(button(render(), "停用"));
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/managed-users/user-self", expect.objectContaining({ body: '{"status":"disabled"}' }));
    expect(state.values.get(6)).toContain("工作区、配置、历史数据和已有授权保留");
    expect((state.values.get(2) as ManagedRegistrationUser[])[0].status).toBe("disabled");
    expect(renderToStaticMarkup(render())).toContain("账号停用");
  });

  it("does not redirect after a failed logout", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    await click(button(render(), "退出"));
    expect(window.location.replace).not.toHaveBeenCalled();
    expect(state.values.get(5)).toBe(false);
  });
});
