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
  if (id === "@/components/management/CreditPoolConnectionPanel") return { CreditPoolConnectionPanel: () => React.createElement("div", null, "少壮专属分组来源连接状态") };
  if (id === "@/components/management/CreditGiftPanel") return {
    CreditGiftPanel: ({ initialUserId, adminId }: { initialUserId?: string; adminId: string }) => React.createElement("div", null, `赠送积分面板 ${initialUserId || "未选账号"} ${adminId}`)
  };
  return requireDependency(id);
}, componentModule.exports);
const { ManagementConsole } = componentModule.exports;

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
  } as ManagedRegistrationUser;
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
    currentUser: { id: "admin", tenantId: "tenant-admin", name: "管理员", email: "admin@local", role: "admin", authRole: "admin" },
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

describe("gift management entry permission and account selection", () => {
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
    expect(tabs.map(textContent)).toEqual(["邀请码", "用户列表", "传播分析", "AI API", "积分计费", "赠送积分"]);
    await click(button(render("invites", { canManageGatewayBilling: true }), "赠送积分"));
    expect(renderToStaticMarkup(render(null, { canManageGatewayBilling: true }))).toContain("赠送积分面板");
  });

});
